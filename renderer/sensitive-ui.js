/* 敏感词预检（第 4 步 renderer 九刀·第五刀：从 renderer.js 的「敏感词预检」分区整段搬出来）。
 *
 * 搬走的段（原 renderer.js 4005–4327，323 行）—— 只报告不改动的敏感词预检面板（v0.8 提案 5.2）：
 *   词表状态文案与刷新（sensitiveWordListText / renderSensitiveWordList / refreshSensitiveWordList）、
 *   面板开 / 关 / 范围、忙碌态、摘要（含 byWord 前 6 个 + 截断提示）、结果列表（词 / 章 / 位置 / 片段，
 *   一次最多 300 条）、点一条跳到对应位置的兜底定位、跑预检（当前章用编辑区内容、整本只读磁盘）、
 *   选词表（persist=false 进设置草稿 / persist=true 立刻写配置并重跑）。
 * **只搬不改行为**：文案 / class / DOM 结构 / 返回结构 / payload.ok===false 的降级路径 / 忙碌态 /
 *   失败兜底全部一字未改（这次没有一行文案或样式改动）。
 *
 * 契约：createSensitiveUi(host) 由渲染层调用一次。host 8 个成员（含 3 个语义分组，分组内每个真实依赖都列在这里）：
 *   host = {
 *     $, state, api, call, toast,          // 基础 5：DOM 查询 / 共享状态 / IPC 白名单 / IPC 包装 / 提示
 *     peers: {                              // 相邻面板 / 设置域的协作入口
 *       closeFindPanel,                     //   打开预检前若查找面板开着先关掉
 *       closeProofreadPanel,                //   打开预检前若校对面板开着先关掉
 *       currentChapterRef,                  //   整本预检时带上「当前章编辑区最新内容」的 override（校对域导出）
 *       matchRangeAt,                       //   正文改过后按 index + 命中文字重新定位（校对域导出，同一份实现）
 *       renderSensitiveSettings             //   选完词表后刷新「设置 → 敏感词词表」那一行
 *     },
 *     nav: {                                // 章节与编辑器
 *       chapterTitle,                       //   「第N章 标题」唯一口径
 *       editorEl,                           //   当前章正文（未保存也算，只参与这次检查）
 *       switchChapter                       //   点整本结果时切章
 *     },
 *     view: {                               // 顶栏菜单 / 生效配置 / 光标滚动
 *       effectiveConfig,                    //   选词表后重算生效配置（全局 + 当前书覆盖）
 *       hideHeaderMenus,                    //   打开面板前收起顶栏菜单
 *       scrollCaretIntoView                 //   跳过去后把光标滚进视野
 *     }
 *   }
 * 缺任何一个（含分组内成员）直接抛 TypeError。分组在 create 时一次解构，行为等价。
 * create() 不注册事件、不建定时器、不碰 DOM；事件绑定在 setupSensitiveUi()，由 bindEvents() 在原
 * 「敏感词 3 个按钮 + 范围 change」的位置调用一次。
 *
 * 刻意不搬（留在 renderer.js）：设置域的 renderSensitiveSettings 本体、校对域的两个定位函数本体、
 * Esc 动作表（'close-sensitive'）、导出菜单里的 'sensitive' 转发、测试钩子宿主契约（按名字取本模块入口）。
 *
 * 浏览器里挂成全局 CWSensitiveUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWSensitiveUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HOST = ['$', 'state', 'api', 'call', 'toast', 'peers', 'nav', 'view'];

  function createSensitiveUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createSensitiveUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) throw new TypeError('createSensitiveUi 的 host 缺少 ' + key);
    }
    const { $, state, api, call, toast, peers, nav, view } = host;
    if (typeof peers !== 'object') throw new TypeError('createSensitiveUi 的 host.peers 必须是对象');
    for (const key of ['closeFindPanel', 'closeProofreadPanel', 'currentChapterRef', 'matchRangeAt', 'renderSensitiveSettings']) {
      if (peers[key] === undefined || peers[key] === null) throw new TypeError('createSensitiveUi 的 host.peers 缺少 ' + key);
    }
    if (typeof nav !== 'object') throw new TypeError('createSensitiveUi 的 host.nav 必须是对象');
    for (const key of ['chapterTitle', 'editorEl', 'switchChapter']) {
      if (nav[key] === undefined || nav[key] === null) throw new TypeError('createSensitiveUi 的 host.nav 缺少 ' + key);
    }
    if (typeof view !== 'object') throw new TypeError('createSensitiveUi 的 host.view 必须是对象');
    for (const key of ['effectiveConfig', 'hideHeaderMenus', 'scrollCaretIntoView']) {
      if (view[key] === undefined || view[key] === null) throw new TypeError('createSensitiveUi 的 host.view 缺少 ' + key);
    }
    const { closeFindPanel, closeProofreadPanel, currentChapterRef, matchRangeAt, renderSensitiveSettings } = peers;
    const { chapterTitle, editorEl, switchChapter } = nav;
    const { effectiveConfig, hideHeaderMenus, scrollCaretIntoView } = view;

  // ---------- 敏感词预检（只报告，不改动；提案 5.2） ----------
  // 词表完全由作者管理：应用不内置任何词表，只按作者在设置里选的 txt（每行一个词）报告命中。
  // 当前章用编辑区内容（未保存也算，只参与检查）；整本由主进程逐章只读磁盘，全程不写盘。
  const SENSITIVE_ROW_LIMIT = 300;

  // 词表状态文案（面板 / 设置共用）：未设置、文件没了、编码坏了都直说
  function sensitiveWordListText(info) {
    if (!info) return '正在读取词表…';
    if (!info.ok) {
      if (info.code === 'WORD_LIST_NOT_CONFIGURED') {
        return '还没有指定词表（应用不内置词表，请选一个自己的 txt）';
      }
      return info.message || '词表读取失败';
    }
    let text = `词表：${info.name}（${info.count} 个词）`;
    const skipped = [];
    if (info.stats && info.stats.duplicates) skipped.push(`${info.stats.duplicates} 个重复`);
    if (info.stats && info.stats.tooLong) skipped.push(`${info.stats.tooLong} 行超长`);
    if (info.stats && info.stats.truncated) skipped.push('超过 5000 个只取前 5000 个');
    if (skipped.length) text += `（已跳过 ${skipped.join('、')}）`;
    return text;
  }

  function renderSensitiveWordList() {
    const el = $('sensitive-wordlist-text');
    if (!el) return;
    const info = state.sensitiveWordList;
    el.textContent = sensitiveWordListText(info);
    el.classList.toggle('warn', Boolean(info && info.ok === false));
  }

  // 只读：取当前配置里的词表状态（不把词表内容带到渲染层）
  async function refreshSensitiveWordList() {
    try {
      state.sensitiveWordList = await call(api.sensitiveWordsInfo);
    } catch (err) {
      state.sensitiveWordList = { ok: false, code: 'ERROR', message: `读取词表失败：${err.message}` };
    }
    renderSensitiveWordList();
    return state.sensitiveWordList;
  }

  async function openSensitivePanel() {
    if (!state.bookPath) {
      toast('先打开一本书再预检', 'warn');
      return false;
    }
    hideHeaderMenus();
    if (!$('find-backdrop').classList.contains('hidden')) closeFindPanel();
    if (!$('proofread-backdrop').classList.contains('hidden')) closeProofreadPanel();
    $('sensitive-scope').value = state.sensitiveScope === 'book' ? 'book' : 'current';
    $('sensitive-backdrop').classList.remove('hidden');
    await refreshSensitiveWordList();
    // 词表可用就先检查一遍当前章，不用再点一次；词表有问题只显示提示
    if (state.sensitiveWordList && state.sensitiveWordList.ok) {
      await runSensitiveCheck();
    } else {
      state.sensitive = null;
      renderSensitiveSummary();
      renderSensitiveResults();
    }
    return true;
  }

  function closeSensitivePanel() {
    $('sensitive-backdrop').classList.add('hidden');
  }

  function sensitiveScope() {
    return $('sensitive-scope').value === 'book' ? 'book' : 'current';
  }

  function setSensitiveBusy(busy) {
    state.sensitiveBusy = Boolean(busy);
    $('sensitive-busy').classList.toggle('hidden', !busy);
    $('btn-sensitive-run').disabled = Boolean(busy);
  }

  function sensitiveChapterTitle(match) {
    let index = Number(match.chapterIndex);
    const byIndex =
      Number.isInteger(index) && index >= 0 && state.chapters[index] && state.chapters[index].id === match.chapterId;
    if (!byIndex) index = state.chapters.findIndex((chapter) => chapter.id === match.chapterId);
    if (index < 0) return String(match.chapterName || '').trim() || '（已删除的章节）';
    return chapterTitle(index, match.chapterName);
  }

  function sensitivePositionText(match) {
    const line = Number(match.line);
    const column = Number(match.column);
    if (!Number.isFinite(line) || !Number.isFinite(column)) return '';
    return `第 ${line} 行 · 第 ${column} 字`;
  }

  function sensitiveWordSummary(payload) {
    if (!payload.byWord || !payload.byWord.length) return '';
    return (
      '：' +
      payload.byWord
        .slice(0, 6)
        .map((item) => `${item.word} ${item.count}`)
        .join(' · ')
    );
  }

  function renderSensitiveSummary() {
    const summary = $('sensitive-summary');
    if (!summary) return;
    const payload = state.sensitive;
    const info = state.sensitiveWordList;
    if (!payload) {
      if (info && info.ok) {
        summary.textContent = '点「开始预检」检查当前章；切成整本后点一次会通读全书。';
      } else if (info) {
        summary.textContent = info.message || '词表不可用';
      } else {
        summary.textContent = '';
      }
      return;
    }
    if (payload.ok === false) {
      summary.textContent = payload.message || '词表不可用';
      return;
    }
    const truncatedNote = payload.truncated ? '（明细只列出一部分）' : '';
    const words = sensitiveWordSummary(payload);
    if (payload.scope === 'book') {
      const skipped = Number(payload.skippedChapters) || 0;
      summary.textContent = payload.total
        ? `全书 ${payload.chapterCount} 章命中 ${payload.total} 处，涉及 ${payload.chapterHitCount} 章、${payload.wordHitCount} 个词${words}${truncatedNote}`
        : `全书 ${payload.chapterCount} 章没有命中词表里的词${
            skipped ? `（跳过 ${skipped} 个缺文件的章节）` : ''
          }`;
      return;
    }
    summary.textContent = payload.total
      ? `本章命中 ${payload.total} 处，涉及 ${payload.wordHitCount} 个词${words}${truncatedNote}`
      : '本章没有命中词表里的词（只按你的词表做字面匹配，不判断文字好坏）';
  }

  function renderSensitiveResults() {
    const box = $('sensitive-results');
    if (!box) return;
    box.innerHTML = '';
    const payload = state.sensitive;
    if (!payload || payload.ok === false) return;
    if (!payload.matches.length) {
      const empty = document.createElement('div');
      empty.className = 'proofread-empty';
      empty.textContent = payload.scope === 'book' ? '整本书没有命中词表里的词' : '这一章没有命中词表里的词';
      box.appendChild(empty);
      return;
    }
    const rows = payload.matches.slice(0, SENSITIVE_ROW_LIMIT);
    for (const match of rows) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'proofread-result sensitive-result';
      row.dataset.word = match.word;
      row.dataset.chapterId = match.chapterId == null ? '' : match.chapterId;
      row.dataset.index = String(match.index);

      const head = document.createElement('div');
      head.className = 'proofread-head';
      const word = document.createElement('span');
      word.className = 'proofread-rule sensitive-word';
      word.textContent = `「${match.word}」`;
      head.appendChild(word);
      if (payload.scope === 'book') {
        const chapter = document.createElement('span');
        chapter.className = 'proofread-chapter';
        chapter.textContent = sensitiveChapterTitle(match);
        head.appendChild(chapter);
      }
      const pos = document.createElement('span');
      pos.className = 'proofread-pos';
      pos.textContent = sensitivePositionText(match);
      head.appendChild(pos);

      const snippet = document.createElement('div');
      snippet.className = 'proofread-snippet';
      if (match.snippet) {
        if (match.snippet.ellipsisStart) snippet.appendChild(document.createTextNode('…'));
        snippet.appendChild(document.createTextNode(match.snippet.before || ''));
        const mark = document.createElement('mark');
        mark.textContent = match.snippet.match || '';
        snippet.appendChild(mark);
        snippet.appendChild(document.createTextNode(match.snippet.after || ''));
        if (match.snippet.ellipsisEnd) snippet.appendChild(document.createTextNode('…'));
      }
      row.append(head, snippet);
      row.addEventListener('click', () => jumpToSensitiveMatch(match));
      box.appendChild(row);
    }
    if (payload.matches.length > rows.length) {
      const more = document.createElement('div');
      more.className = 'proofread-more';
      more.textContent = `还有 ${payload.matches.length - rows.length} 条没有显示（一次最多列 ${SENSITIVE_ROW_LIMIT} 条；可以先只预检当前章）`;
      box.appendChild(more);
    }
  }

  async function jumpToSensitiveMatch(match) {
    if (!state.bookPath) return { ok: false };
    let index = Number(match.chapterIndex);
    const byIndex =
      Number.isInteger(index) && index >= 0 && state.chapters[index] && state.chapters[index].id === match.chapterId;
    if (!byIndex) index = state.chapters.findIndex((chapter) => chapter.id === match.chapterId);
    if (index < 0 && match.chapterId == null) index = state.index;
    if (index < 0) {
      toast('这一章已经不存在了', 'warn');
      return { ok: false };
    }
    closeSensitivePanel();
    if (index !== state.index) {
      const switched = await switchChapter(index);
      if (!switched || switched.ok === false) {
        return { ok: false, canceled: Boolean(switched && switched.canceled) };
      }
    }
    const range = matchRangeAt(editorEl.value, match);
    editorEl.focus();
    editorEl.setSelectionRange(range.start, range.end);
    scrollCaretIntoView(range.start);
    return { ok: true, start: range.start, end: range.end };
  }

  async function runSensitiveCheck() {
    if (!state.bookPath || !state.chapters.length) {
      $('sensitive-summary').textContent = '这本书里还没有章节';
      return { ok: false, message: '没有章节' };
    }
    if (state.sensitiveBusy) return { ok: false, message: '正在预检中' };
    const scope = sensitiveScope();
    state.sensitiveScope = scope;
    setSensitiveBusy(true);
    $('sensitive-summary').textContent =
      scope === 'book' ? '正在通读全书（只读，不改正文）…' : '正在检查当前章…';
    $('sensitive-results').innerHTML = '';
    try {
      let payload;
      if (scope === 'book') {
        const override = currentChapterRef();
        payload = await call(api.sensitiveCheckBook, state.bookPath, {}, override);
        payload.scope = 'book';
      } else {
        const chapter = state.chapters[state.index];
        const res = await call(api.sensitiveCheckText, editorEl.value, {});
        payload = res.ok === false
          ? {
              ...res,
              scope: 'current',
              total: 0,
              matches: [],
              byWord: [],
              wordHitCount: 0,
              chapterId: chapter ? chapter.id : null,
              chapterIndex: state.index,
              chapterName: chapter ? chapter.name : ''
            }
          : {
              ...res,
              // 当前章的结果也带上章信息，点结果时才能定位（和整本结果结构保持一致）
              matches: res.issues.map((issue) => ({
                ...issue,
                chapterId: chapter ? chapter.id : null,
                chapterIndex: state.index,
                chapterName: chapter ? chapter.name : ''
              })),
              scope: 'current',
              chapterId: chapter ? chapter.id : null,
              chapterIndex: state.index,
              chapterName: chapter ? chapter.name : ''
            };
      }
      state.sensitive = payload;
      if (payload.wordList) state.sensitiveWordList = payload.wordList;
      renderSensitiveWordList();
      renderSensitiveSummary();
      renderSensitiveResults();
      return { ok: payload.ok !== false, total: payload.total, scope: payload.scope };
    } catch (err) {
      state.sensitive = null;
      $('sensitive-summary').textContent = `预检失败：${err.message}`;
      $('sensitive-results').innerHTML = '';
      return { ok: false, message: err.message };
    } finally {
      setSensitiveBusy(false);
    }
  }

  // 选词表：persist=false 只放进设置草稿（点「保存设置」才落配置）；
  // persist=true 用于预检面板里直接选，选完立刻写配置并重跑一次预检。
  async function pickSensitiveWords({ persist = false } = {}) {
    try {
      const picked = await call(api.pickSensitiveWords);
      if (!picked || picked.canceled) return { canceled: true };
      if (!picked.ok) {
        toast(`这个词表不能用：${picked.message}`, 'error');
        return picked;
      }
      if (persist) {
        const cfg = await call(api.setConfig, { sensitiveWordsPath: picked.path });
        state.globalConfig = cfg;
        state.config = effectiveConfig();
        state.sensitiveWordsDraft = cfg.sensitiveWordsPath || '';
      } else {
        state.sensitiveWordsDraft = picked.path;
      }
      state.sensitiveWordsInfo = picked;
      state.sensitiveWordList = picked;
      renderSensitiveWordList();
      renderSensitiveSettings();
      toast(`已选择词表：${picked.name}（${picked.count} 个词）`);
      if (persist && !$('sensitive-backdrop').classList.contains('hidden')) {
        await runSensitiveCheck();
      }
      return picked;
    } catch (err) {
      toast(`选择词表失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  // 事件绑定（与搬前 bindEvents() 里的敏感词块 + 范围 change 逐行一致；由渲染层在原位置调用一次）
  function setupSensitiveUi() {
    $('btn-sensitive-run').addEventListener('click', runSensitiveCheck);
    $('btn-sensitive-close').addEventListener('click', closeSensitivePanel);
    $('btn-sensitive-pick').addEventListener('click', () => pickSensitiveWords({ persist: true }));
    $('sensitive-scope').addEventListener('change', () => {
      state.sensitiveScope = sensitiveScope();
      // 换了范围就先收起旧结果，免得摘要写着「整本」、列表还是上一章的内容
      state.sensitive = null;
      $('sensitive-results').innerHTML = '';
      $('sensitive-summary').textContent =
        state.sensitiveScope === 'book'
          ? '已切到整本书：点「开始预检」按词表通读全书（只读，缺文件的章节会跳过）。'
          : '已切到当前这一章：点「开始预检」检查编辑区里的最新内容。';
    });
  }


    return {
      sensitiveWordListText,
      refreshSensitiveWordList,
      openSensitivePanel,
      closeSensitivePanel,
      sensitiveScope,
      runSensitiveCheck,
      pickSensitiveWords,
      setupSensitiveUi
    };
  }

  return { create: createSensitiveUi, REQUIRED_HOST };
});
