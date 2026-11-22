/* Ctrl+G 跳章（v0.9 B-5 第二刀：从 renderer.js 的「Ctrl+G 跳章」分区整段搬出来）。
 *
 * 为什么搬这一块：它是 B-5 第一刀量测里「出入最清楚」的下一块——147 行（原 renderer.js
 * 4225–4371 行）、只碰 10 个渲染层成员（api / $ / call / state / chapterTitle / chaptersLib /
 * CHAPTER_STATUS_LABELS / chapterStatus / switchChapter / imeGuard），不碰 IPC 白名单、不碰存储、
 * 不碰 Esc 优先级表的层顺序；外部仍按名字取 4 个入口（Esc 动作表 closeJumpDialog、测试钩子
 * refreshJumpMatches / openJumpDialog / confirmJumpFromDialog）；5 处事件绑定第十一刀起由
 * 模块自己的 bindDialogEvents() 挂。**匹配规则不在这里**——它在主进程的 core/jump.js
 * （纯逻辑、单测覆盖）；切章仍走渲染层的 switchChapter，未保存拦截照常生效。
 *
 * 契约：createJumpUi(host) 由渲染层调用一次，host 提供：
 *   host = {
 *     api, $, call, state, chapterTitle, chaptersLib, CHAPTER_STATUS_LABELS, chapterStatus,
 *     switchChapter, imeGuard
 *   }
 * 缺任何一个直接抛 TypeError（宁可在启动时炸，也不要到点按 Ctrl+G 时才 ReferenceError）。
 * 防抖定时器与「旧响应作废」令牌仍是 state 上的字段（jumpTimer / jumpToken），与改前是同一份
 * state 对象，语义一字未改。
 *
 * 搬过来的东西（行为一字未改，文案 / class / 按钮文字 / 提示语 / 列表上限都照旧）：
 *   - 跳章对话框：打开 / 关闭 / 键盘回车确认；
 *   - 结果列表：章号命中 / 章名关键词命中 / 超出本书章数三种汇总文案 + 每行「章名 + 状态」；
 *   - 「跳过去」：先收对话框再走 switchChapter（未保存修改由 switchChapter 弹窗拦截）。
 *
 * 红线不变：只读 state、只改对话框 DOM 与 state 的 jump* 字段，**不写盘、不改正文、不改 dirty**。
 * 浏览器里挂成全局 CWJumpUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../core/assert-host').assertHost);
  } else if (root) {
    root.CWJumpUi = factory(root.CWAssertHost && root.CWAssertHost.assertHost);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (assertHost) {
  'use strict';

  const REQUIRED_HOST = ['api', '$', 'call', 'state', 'chapterTitle', 'chaptersLib', 'CHAPTER_STATUS_LABELS', 'chapterStatus', 'switchChapter', 'imeGuard'];

  function createJumpUi(host) {
    // A8（WP-32）：REQUIRED_HOST 逐成员校验走共享实现（文案不变）。
    assertHost('createJumpUi', host, REQUIRED_HOST);
    const { api, $, call, state, chapterTitle, chaptersLib, CHAPTER_STATUS_LABELS, chapterStatus, switchChapter, imeGuard } = host;
  // V206（v1.8.0 WP-29）：跳章 payload 按「书目 / 章节数组的引用」缓存。输入框每 80ms 防抖后都会
  // refreshJumpMatches，千章书以前每次都重建 1000 个对象、逐章算章号再整体过 IPC；章号 / 卷名的
  // 输入只由 state.meta + state.chapters 决定，而每次书目变更都走 applyMetaAndRelocate（换新引用），
  // 所以引用相等即可安全复用（章对象的 chars 会被原地更新，但 payload 不含 chars）。
  let payloadCache = null;
  // ---------- Ctrl+G 跳章 ----------
  // 匹配规则在主进程的 core/jump.js（单测覆盖）：输入纯章号按章号找，否则按章名关键词找。
  // 这里只负责对话框、结果列表和「跳过去」；切章仍走 switchChapter，未保存拦截照常生效。
  const JUMP_RESULT_LIMIT = 8;

  function jumpChapterPayload() {
    const rawMeta = state.meta;
    const chapters = state.chapters || [];
    if (payloadCache && payloadCache.rawMeta === rawMeta && payloadCache.chapters === chapters) {
      return payloadCache.payload;
    }
    const meta = rawMeta || {};
    const volumes = Array.isArray(meta.volumes) ? meta.volumes : [];
    // 1.5.0 P0-1（审计 E1 / A2）：章→卷统一用 core/chapters.js 的 chapterVolumeKey，
    // 指向已删除卷的章与真正未分卷的章落在同一组（不再各自 find / some 一份）。
    const volumeNameOf = (chapter) => {
      const key = chaptersLib.chapterVolumeKey(meta, chapter);
      if (!key) return volumes.length ? '未分卷' : '';
      const volume = volumes.find((item) => item && item.id === key);
      return volume ? String(volume.name || '').trim() || '未命名卷' : '未分卷';
    };
    const payload = chapters.map((chapter, index) => ({
      id: chapter.id,
      name: chapter.name == null ? '' : String(chapter.name),
      // 跳章的纯数字匹配要按「显示用的章号」算：按卷编号时同一章号每卷都可能出现
      number: chaptersLib.chapterNumber(meta, index),
      volumeName: volumeNameOf(chapter)
    }));
    payloadCache = { rawMeta, chapters, payload };
    return payload;
  }

  function renderJumpMatches(result) {
    const matches = (result && Array.isArray(result.matches)) ? result.matches : [];
    const summary = $('jump-summary');
    const list = $('jump-results');
    const query = String(state.jumpQuery || '').trim();
    const total = state.chapters.length;
    list.innerHTML = '';
    let text;
    let warn = false;
    const byVolume = Boolean(result && result.numbering === 'volume');
    if (!query) {
      text = byVolume
        ? `共 ${total} 章（按卷编号）。输入章号 / 章名的一部分；同号章会列出所在卷。`
        : `共 ${total} 章。输入章号（如 12、第12章）或章名的一部分；回车跳转。`;
    } else if (!matches.length) {
      warn = true;
      text = state.jumpOutOfRange
        ? byVolume
          ? `本书按卷编号，没有找到「第 ${Number(result && result.number) || '?'} 章」（每卷从第 1 章起算）。`
          : `本书共 ${total} 章，没有第 ${Number(result && result.number) || '?'} 章（可输入 1–${total}）。`
        : `没有匹配「${query}」的章节。`;
    } else if (result && result.number != null) {
      if (byVolume && matches.length > 1) {
        text = `本书按卷编号：「第 ${result.number} 章」找到 ${matches.length} 处（按卷 / 未分卷分组），回车跳第一条。`;
      } else {
        text = `按章号跳转：${byVolume && matches[0].volumeName ? `${matches[0].volumeName} · ` : ''}${chapterTitle(
          Math.max(0, resolveMatchIndex(matches[0])),
          matches[0].name
        )}`;
      }
    } else {
      const hitCount = Number(result && result.total) || matches.length;
      text = `找到 ${hitCount} 章匹配${hitCount > matches.length ? `（列出前 ${matches.length} 章）` : ''}；回车跳第一条，也可以点下面任意一条。`;
    }
    summary.textContent = text;
    summary.classList.toggle('warn', warn);

    let renderedRows = 0;
    for (const match of matches) {
      // 五-M2（RF-03）：结果行按 match.chapterId 定位到**当前**章节数组；批量删章 / 移卷之后
      // 旧下标可能已指向另一章，标题 / 状态 / 点击目标必须与真实章节一致。
      const at = resolveMatchIndex(match);
      const chapter = at >= 0 ? state.chapters[at] : null;
      if (!chapter) continue;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'jump-result';
      row.dataset.index = String(at);
      const label = document.createElement('span');
      label.className = 'jump-chapter';
      const titleText = chapterTitle(at, match.name);
      label.textContent = byVolume && match.volumeName ? `${match.volumeName} · ${titleText}` : titleText;
      const status = document.createElement('span');
      status.className = 'jump-status';
      status.textContent = CHAPTER_STATUS_LABELS[chapterStatus(chapter)] || '';
      row.appendChild(label);
      row.appendChild(status);
      // 点击时按 id **再**解析一次（对话框可能已开了一会儿）：章已删除就明确拒绝，绝不按旧下标跳错章。
      row.addEventListener('click', () => jumpToIndex(at, match.chapterId));
      list.appendChild(row);
      renderedRows += 1;
    }
    $('btn-jump-confirm').disabled = renderedRows === 0;
  }

  // 五-M2（RF-03）：回执 / 点击时一律按 match.chapterId 重新定位到当前章节数组——批量删章 / 移卷
  // 的回执会整体换掉 state.chapters 但不推进 jumpToken，旧下标会指到另一章（跳错章、标题状态混搭）。
  // 只有回执没有 chapterId（旧形状 / 坏数据）时才回落到 match.index；负值 / 越界由调用方再挡。
  function resolveMatchIndex(match) {
    if (!match) return -1;
    if (match.chapterId != null) {
      const at = state.chapters.findIndex((chapter) => chapter && String(chapter.id) === String(match.chapterId));
      if (at >= 0) return at;
      return -1; // 书里已经没有这一章：明确当「不存在」，绝不按旧下标跳到别的章
    }
    return Number(match.index);
  }

  async function refreshJumpMatches() {
    if (!state.bookPath || !state.chapters.length) return;
    const input = $('jump-input');
    const query = input ? input.value : '';
    state.jumpQuery = query;
    const token = (state.jumpToken += 1);
    // 五-M2（RF-03）：发起时记下章节数组引用。回执落地前批量操作可能整体换掉 state.chapters
    // （applyMetaAndRelocate 不推进 jumpToken）——旧下标的结果不能再渲染 / 点击。
    const chaptersRef = state.chapters;
    if (!String(query).trim()) {
      state.jumpMatches = [];
      state.jumpOutOfRange = false;
      renderJumpMatches({ matches: [], total: 0 });
      return;
    }
    try {
      const result = await call(api.jumpMatch, jumpChapterPayload(), query, {
        limit: JUMP_RESULT_LIMIT,
        numbering: state.meta && state.meta.chapterNumbering === 'volume' ? 'volume' : 'continuous'
      });
      if (token !== state.jumpToken) return; // 输入已经又变了，旧结果丢掉
      if (chaptersRef !== state.chapters) {
        // 章节数组已经换过（批量删章 / 移卷 / 换书）：清单里的旧下标没有意义，按 stale 丢弃并请作者重查。
        state.jumpMatches = [];
        state.jumpOutOfRange = false;
        $('jump-summary').textContent = '章节列表刚变过，这次查找结果没有显示；请重新输入';
        $('jump-summary').classList.add('warn');
        $('jump-results').innerHTML = '';
        $('btn-jump-confirm').disabled = true;
        return;
      }
      state.jumpMatches = (result && Array.isArray(result.matches)) ? result.matches : [];
      state.jumpOutOfRange = Boolean(result && result.outOfRange);
      renderJumpMatches(result || {});
    } catch (err) {
      if (token !== state.jumpToken) return;
      state.jumpMatches = [];
      state.jumpOutOfRange = false;
      $('jump-summary').textContent = `查找章节失败：${err.message}`;
      $('jump-summary').classList.add('warn');
      $('jump-results').innerHTML = '';
      $('btn-jump-confirm').disabled = true;
    }
  }

  function scheduleJumpMatches(delay = 80) {
    clearTimeout(state.jumpTimer);
    state.jumpTimer = setTimeout(() => {
      state.jumpTimer = null;
      refreshJumpMatches();
    }, delay);
  }

  function openJumpDialog() {
    if (!state.bookPath || !state.chapters.length) return false;
    state.jumpToken += 1;
    clearTimeout(state.jumpTimer);
    state.jumpTimer = null;
    state.jumpMatches = [];
    state.jumpQuery = '';
    state.jumpOutOfRange = false;
    $('jump-input').value = '';
    $('jump-results').innerHTML = '';
    $('jump-summary').classList.remove('warn');
    renderJumpMatches({ matches: [], total: 0 });
    $('jump-backdrop').classList.remove('hidden');
    setTimeout(() => {
      const input = $('jump-input');
      if (!input || $('jump-backdrop').classList.contains('hidden')) return;
      input.focus();
      input.select();
    }, 20);
    return true;
  }

  function closeJumpDialog() {
    clearTimeout(state.jumpTimer);
    state.jumpTimer = null;
    state.jumpToken += 1;
    state.jumpMatches = [];
    state.jumpQuery = '';
    state.jumpOutOfRange = false;
    $('jump-backdrop').classList.add('hidden');
    $('jump-input').value = '';
    $('jump-results').innerHTML = '';
    $('jump-summary').textContent = '';
  }

  async function jumpToIndex(index, chapterId = null) {
    if (!state.bookPath) return { ok: false, message: '章节不存在' };
    // 五-M2（RF-03）：带章 id 时按 id 现查下标——对话框开着期间批量删章 / 移卷会换掉章节数组，
    // 旧下标不可信。章已被删就明确拒绝（不关框，作者可以重新输入），绝不跳到另一章。
    let target = Number(index);
    if (chapterId != null) {
      const at = state.chapters.findIndex((chapter) => chapter && String(chapter.id) === String(chapterId));
      if (at < 0) return { ok: false, message: '这一章已经不存在了' };
      target = at;
    }
    if (!Number.isInteger(target) || target < 0 || target >= state.chapters.length) {
      return { ok: false, message: '章节不存在' };
    }
    // 先把对话框收起来，再走正常的切章流程（有未保存修改时由 switchChapter 弹窗拦截）
    closeJumpDialog();
    const res = await switchChapter(target);
    return res;
  }

  async function confirmJumpFromDialog() {
    if (!state.jumpMatches.length) {
      $('jump-summary').classList.add('warn');
      return { ok: false, message: '没有匹配的章节' };
    }
    const first = state.jumpMatches[0];
    return jumpToIndex(resolveMatchIndex(first), first.chapterId);
  }
  // 跳章对话框的事件接线（M1 第一轮·低 第十一刀：从 renderer.js 的 bindEvents 整段搬进来）。
  // 注册点仍由渲染层决定（bindEvents 里与原位置同一处）；挂的仍是本模块既有入口，
  // 回车确认的输入法守卫走 host 注入的 imeGuard，文案 / 判据 / 顺序与搬前逐字一致。
  // 幂等：宿主重入时不会挂出第二份（回车一次跳两章的经典坑）。
  let dialogEventsBound = false;
  function bindDialogEvents() {
    if (dialogEventsBound) return;
    dialogEventsBound = true;
    // 跳章（Ctrl+G）
    $('jump-input').addEventListener('input', () => scheduleJumpMatches());
    $('jump-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        // 1.7.1 P1（审计 V73）/ WP-04（V112）：输入法组字中的 Enter 只上屏候选词，不当「跳过去」
        if (imeGuard.isImeComposing(event)) return;
        event.preventDefault();
        // 同步键盘回调里没法 await；确认流程自己吞掉失败（jumpToIndex 回执），这里标 fire-and-forget。
        void confirmJumpFromDialog();
      }
    });
    $('btn-jump-cancel').addEventListener('click', closeJumpDialog);
    $('btn-jump-confirm').addEventListener('click', () => confirmJumpFromDialog());
  }

    return {
      refreshJumpMatches,
      scheduleJumpMatches,
      openJumpDialog,
      closeJumpDialog,
      confirmJumpFromDialog,
      bindDialogEvents,
      // 下面 3 个是模块内部的纯逻辑 / 单步动作，导出只为让单测能逐条钉住分支，渲染层按名字取不到也无妨
      jumpChapterPayload,
      renderJumpMatches,
      jumpToIndex
    };
  }

  return { create: createJumpUi, REQUIRED_HOST };
});
