/* 崩溃恢复 UI（v1.8.2 WP5 / 审计 N1，中 #6；作者拍板项 1=B）
 *
 * 两件事，都只在渲染层：
 *   1. **可选崩溃草稿的周期上报**（默认关）：写作页有未保存修改时，每 30 秒把编辑区正文交给主进程
 *      写进 userData\crash-drafts（主进程负责只写 userData / 原子写 / 长度上限）。这一次上报**不是保存**：
 *      不动 dirty、不写书库、不写书目、不改章节 txt；默认配置下本模块一次都不会调 IPC。
 *   2. **启动 / 重载后的恢复提示**：主进程发现上次异常退出（或本次渲染崩溃重载）留下草稿时，
 *      逐条问「恢复 / 丢弃 / 先留着」。恢复 = 需要时先开书 → 载章 → 正文只进编辑区（仍 dirty，
 *      Ctrl+S 才写盘）→ 删掉这条草稿。当前编辑区已有未保存修改时不覆盖，留到下次。
 *
 * 契约：createCrashRecoveryUi(host)，host 成员见 REQUIRED_HOST；缺一个在装配时直接 TypeError。
 *   - 只写 state.dirty 吗？不。恢复走 host.applyRecoveredText()（renderer 里等价于作者输入，
 *     由真实输入链路更新 dirty / 状态栏 / 章节条目标记）；本模块自己不直接改正文以外的状态。
 *   - 不碰 fs / 不 require：写盘与读草稿都在主进程，渲染层只有四个白名单 IPC。
 *
 * 浏览器里挂成全局 CWCrashRecoveryUi（index.html 排在 renderer.js 之前），Node 里可直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../core/common'), require('../core/assert-host').assertHost);
  } else if (root) {
    root.CWCrashRecoveryUi = factory(root.CWCommon, root.CWAssertHost && root.CWAssertHost.assertHost);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (common, assertHost) {
  'use strict';

  // core/common.js 必须先加载（index.html 里排在最前面）；缺了直接报错，不许在本地再抄一份补零。
  if (!common || typeof common.pad2 !== 'function') {
    throw new Error('CWCrashRecoveryUi：core/common.js 没有先加载');
  }
  const { pad2 } = common;

  const REQUIRED_HOST = [
    'state',
    'api',
    'editorEl',
    'toast',
    'openModal',
    'chapterTitle',
    'openBookByPath',
    'loadChapterAt',
    'applyRecoveredText'
  ];

  // 周期上报间隔：只在「有未保存修改」时跑，且内容没变不重复写。
  const SNAPSHOT_INTERVAL_MS = 30000;

  function formatAt(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '未知时间';
    return `${date.getMonth() + 1}月${date.getDate()}日 ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }

  function createCrashRecoveryUi(host) {
    assertHost('createCrashRecoveryUi', host, REQUIRED_HOST);
    const { state, api, editorEl, toast, openModal, chapterTitle, openBookByPath, loadChapterAt, applyRecoveredText } = host;

    let timer = null;
    let started = false;
    let writing = false;
    let recoveryChecking = false;
    let lastSnapshotText = '';
    let lastSnapshotKey = '';
    let lastSnapshotAt = 0;
    let lastDraftId = '';

    function enabled() {
      return Boolean(state.config && state.config.crashDraftEnabled === true);
    }

    function currentChapter() {
      if (state.view !== 'editor') return null;
      if (!state.bookPath || state.index < 0) return null;
      const chapters = Array.isArray(state.chapters) ? state.chapters : [];
      const chapter = chapters[state.index];
      if (!chapter || !chapter.id) return null;
      return chapter;
    }

    // 周期上报（也供 E2E 钩子直接调）：成功回 draftId；被开关 / 状态挡住时回 code，页面不提示。
    async function snapshotNow() {
      if (!enabled()) return { ok: false, code: 'DISABLED' };
      if (writing) return { ok: false, code: 'BUSY' };
      const chapter = currentChapter();
      if (!chapter) return { ok: false, code: 'NO_TARGET' };
      if (state.loading || state.saving || state.importing) return { ok: false, code: 'BUSY' };
      if (!state.dirty) return { ok: false, code: 'CLEAN' };
      const text = editorEl.value;
      if (!text) return { ok: false, code: 'EMPTY' };
      const now = Date.now();
      // RPAN-B01（第五轮审计）：「内容没变就不重复写」只看内容（+ 书/章身份）。
      // 旧条件是 `text === lastSnapshotText && now - lastSnapshotAt < 30000`，而定时器本来就
      // 每 30000ms 触发、只会晚到 —— 时间条件在周期路径下恒假，静止写作时每 30 秒仍整篇重写
      // 一次草稿，还把 at 时间戳刷成「最后一次重写时刻」，恢复提示显示的新鲜度失真。
      // 身份键必须带上书 / 章：换了一章而正文恰好相同，不能沿用上一章的草稿结论。
      const snapshotKey = `${state.bookPath}\u0000${chapter.id}`;
      if (text === lastSnapshotText && snapshotKey === lastSnapshotKey) {
        return { ok: true, skipped: true, draftId: lastDraftId };
      }
      writing = true;
      try {
        const result = await api.saveCrashDraft({
          bookPath: state.bookPath,
          bookTitle: (state.meta && state.meta.title) || '',
          chapterId: chapter.id,
          chapterTitle: chapter.name || '',
          chapterName: chapter.name || '',
          chapterIndex: state.index,
          text,
          at: new Date(now).toISOString()
        });
        if (!result || result.ok === false) {
          return { ok: false, code: (result && result.code) || 'DRAFT_WRITE_FAILED' };
        }
        const data = result.data || {};
        if (data.saved !== true) return { ok: false, code: data.code || 'DRAFT_NOT_SAVED' };
        lastSnapshotText = text;
        lastSnapshotKey = snapshotKey;
        lastSnapshotAt = now;
        lastDraftId = data.draftId || '';
        return { ok: true, draftId: data.draftId, chars: data.chars };
      } catch (err) {
        // 草稿写失败永远不影响写作：不弹错误（几分钟后下一次会再试），只回错误码给测试 / 日志侧。
        return { ok: false, code: (err && err.code) || 'DRAFT_WRITE_FAILED' };
      } finally {
        writing = false;
      }
    }

    // L1（一轮·低）：删草稿失败不许吞。返回是否真的删掉了，调用方据此给作者如实提示
    // （删不掉 → 下次启动还会再问一次，别让作者以为「已经丢掉了」）。
    //
    // I7（三审）：主进程 IPC 的成功回包是 { ok:true, data }，软错误包络（{ ok:false, code, message }）
    // 在 data 里；旧实现直接读顶层 result.removed —— 恒为 undefined，于是「删不掉」永远被判成失败、
    // 恢复成功也永远提示「草稿没标记掉」。这里优先读 data，回退扁平形状（自检钩子 / 老宿主仍可用）。
    function softData(result) {
      if (!result || typeof result !== 'object') return null;
      return result.data && typeof result.data === 'object' ? result.data : result;
    }

    async function discardOne(draftId) {
      try {
        const result = await api.discardCrashDraft({ draftId });
        if (!result || result.ok === false) return false;
        const data = softData(result);
        return Number(data && data.removed) > 0;
      } catch {
        return false;
      }
    }

    // 旧M4（一轮·中）/ S2（三审）：恢复草稿后**不删**草稿文件——恢复出来的正文只在编辑区里
    // （仍是未保存状态）。以前这里立刻 discardOne：恢复后编辑区再崩一次 / 作者没保存就退出，
    // 这段字就只剩编辑区那一份、彻底没了。现在先把草稿标记成「本窗口已恢复」（主进程只对它
    // 自己那扇窗口放行，别的窗口不再重复提示），正文保留到：
    //   · 成功 Ctrl+S（保存链的干净回执走 noteSaved → 按书 + 章删掉）；
    //   · 或下一次周期草稿落盘（同一个草稿位被新正文覆盖）。
    async function markConsumed(draftId) {
      try {
        const result = await api.discardCrashDraft({ draftId, consumed: true });
        if (!result || result.ok === false) return false;
        // I7（三审）：软错误包络在 data 里（{ ok:false, code, message }）；成功标记是 data.consumed。
        const data = softData(result);
        return Boolean(data && data.ok !== false && data.consumed === true);
      } catch {
        return false;
      }
    }

    // 把一条草稿的正文恢复进编辑区：先读全文，再（必要时）开书、定位章节、载章，最后只写编辑区。
    async function restoreOne(meta) {
      let read;
      try {
        read = await api.readCrashDraft(meta.draftId);
      } catch {
        read = null;
      }
      if (!read || read.ok === false || !read.data || !read.data.draft) {
        toast('草稿读不出来（可能已被恢复或删除），这份草稿先留着', 'error');
        return false;
      }
      const text = read.data.draft.text;
      if (typeof text !== 'string' || !text.length) {
        toast('草稿内容是空的，未能恢复', 'warn');
        return false;
      }
      if (state.dirty) {
        toast('当前编辑区还有未保存修改，先处理它再恢复崩溃草稿', 'warn');
        return false;
      }
      // RPAN-B04：开书是「验证草稿的章还在这本书里」的前置副作用 —— 失败出口必须把它退回去，
      // 否则作者被留在与本轮写作无关的书里（多条草稿连续失败还会连环换书）。
      const fromBookPath = state.bookPath;
      async function rollbackBook() {
        if (!fromBookPath || state.bookPath === fromBookPath) return;
        let back;
        try {
          back = await openBookByPath(fromBookPath);
        } catch (err) {
          back = { ok: false, message: (err && err.message) || String(err) };
        }
        if (!back || back.ok === false || state.bookPath !== fromBookPath) {
          toast(`没能切回原来的书（${fromBookPath}），当前停在草稿所属的书`, 'warn');
        }
      }
      let restored = false;
      try {
        if (state.bookPath !== meta.bookPath) {
          let opened;
          try {
            opened = await openBookByPath(meta.bookPath);
          } catch (err) {
            opened = { ok: false, message: (err && err.message) || String(err) };
          }
          if (!opened || opened.ok === false) {
            toast('草稿所属的书打不开（可能被移走或删除），这份草稿先留着', 'error');
            return false;
          }
          if (state.bookPath !== meta.bookPath) {
            toast('打开的不是草稿所属的那本书，未恢复', 'error');
            return false;
          }
        }
        const chapters = Array.isArray(state.chapters) ? state.chapters : [];
        const index = chapters.findIndex((chapter) => chapter && chapter.id === meta.chapterId);
        if (index < 0) {
          toast('草稿所属的章节已不在这本书里，未恢复', 'warn');
          return false;
        }
        let loaded;
        try {
          loaded = await loadChapterAt(index);
        } catch (err) {
          loaded = { ok: false, message: (err && err.message) || String(err) };
        }
        if (!loaded || loaded.ok === false) {
          toast('载入章节失败，未恢复草稿；可稍后重试', 'error');
          return false;
        }
        if (state.loadedChapterId !== meta.chapterId) {
          toast('载入的不是草稿所属的章节，未恢复', 'error');
          return false;
        }
        let applied;
        try {
          applied = applyRecoveredText(text);
        } catch (err) {
          toast(`恢复草稿失败：${(err && err.message) || String(err)}`, 'error');
          return false;
        }
        // REDT-A-04：applyRecoveredText 现在与 insertIntoBody 过同一道写入闸，闸不过时回 { ok:false }；
        // 草稿保留，不 discard。
        if (applied && applied.ok === false) {
          toast(applied.message || '当前状态不能恢复草稿，请稍后再试；这份草稿先留着', 'warn');
          return false;
        }
        // 旧M4（一轮·中）：恢复成功**不删草稿**，只标记本窗口已恢复（保留这段字的唯一磁盘兜底）。
        const consumed = await markConsumed(meta.draftId);
        toast(
          '已恢复上次崩溃前的正文（仍是未保存状态，Ctrl+S 才会写盘）' +
            (consumed ? '' : '；草稿没标记掉，下次启动可能再提示一次')
        );
        restored = true;
        return true;
      } finally {
        if (!restored) await rollbackBook();
      }
    }

    // 问一条草稿：返回 'continue'（继续问下一条）/ 'stop'（先留着，等下次）。
    async function offerOne(meta) {
      if (state.dirty) {
        toast('检测到上次崩溃的未保存草稿；当前编辑区还有未保存修改，先处理眼前的修改', 'warn');
        return 'stop';
      }
      const label = chapterTitle(meta.chapterIndex, meta.chapterTitle || meta.chapterName || '') || '当前章节';
      const answer = await openModal({
        title: '发现上次崩溃时未保存的稿子',
        message:
          `《${meta.bookTitle || '未命名'}》${label}\n保存于 ${formatAt(meta.at)}，${meta.chars} 字。\n\n` +
          '这不是自动保存：只有你点「恢复这份草稿」时，这段文字才会进编辑区（仍为未保存状态，Ctrl+S 才写盘）。',
        buttons: [
          { label: '先留着，下次再恢复', value: 'later' },
          { label: '丢弃这份草稿', value: 'discard', kind: 'danger' },
          { label: '恢复这份草稿', value: 'restore', kind: 'primary' }
        ],
        cancelValue: 'later'
      });
      const action = (answer && answer.action) || 'later';
      if (action === 'discard') {
        // L1（一轮·低）：删失败必须如实说 —— 否则作者以为已经丢掉，下次启动又弹同一份草稿，
        // 可能重复恢复并把更新过的编辑区覆盖回去。
        const removed = await discardOne(meta.draftId);
        if (!removed) toast('这份草稿没能删掉（可能正被占用），下次启动会再提示一次', 'warn');
        return 'continue';
      }
      if (action === 'restore') {
        await restoreOne(meta);
        return 'continue';
      }
      return 'stop';
    }

    // 启动 / 重载后跑一次：主进程说没有草稿就什么也不做；有就逐条提示。
    async function checkRecovery() {
      if (recoveryChecking) return;
      recoveryChecking = true;
      try {
        let result;
        try {
          result = await api.crashRecovery();
        } catch {
          return;
        }
        if (!result || result.ok === false || !result.data) return;
        const info = result.data;
        if (info.enabled !== true) return;
        const drafts = Array.isArray(info.drafts) ? info.drafts : [];
        if (!drafts.length) return;
        for (const meta of drafts) {
          const outcome = await offerOne(meta);
          if (outcome === 'stop') return;
        }
      } finally {
        recoveryChecking = false;
      }
    }

    // 保存成功后删掉这一章的草稿（含旧内容），并让「内容没变不重复写」的记忆失效。
    async function noteSaved(bookPath, chapterId) {
      lastSnapshotText = '';
      lastSnapshotAt = 0;
      lastDraftId = '';
      try {
        await api.discardCrashDraft({ bookPath, chapterId });
      } catch {
        /* 删不掉不影响保存结果；下次启动最多多提示一次 */
      }
    }

    function start() {
      if (started) return;
      started = true;
      timer = setInterval(() => {
        void snapshotNow();
      }, SNAPSHOT_INTERVAL_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
      void checkRecovery();
    }

    function stop() {
      if (timer) clearInterval(timer);
      timer = null;
      started = false;
    }

    function snapshotState() {
      return {
        enabled: enabled(),
        started,
        recoveryPending: recoveryChecking,
        lastSnapshotAt,
        lastSnapshotChars: lastSnapshotText.length,
        lastDraftId
      };
    }

    return {
      start,
      stop,
      checkRecovery,
      snapshotNow,
      snapshotState,
      noteSaved,
      restoreOne,
      offerOne
    };
  }

  return {
    create: createCrashRecoveryUi,
    REQUIRED_HOST,
    SNAPSHOT_INTERVAL_MS
  };
});