/* 查找 / 替换核心（第 4 步 renderer 九刀·补刀 9a：从 renderer.js 的「查找会话」「查找替换」两个分区
 * 以及「本书历史」分区里残留的查找面板整段搬出来，合计约 474 行）。
 *
 * 搬走的段：
 *   ① 查找会话（v0.8-11，提案 N11）：findOverlayEl / findPanelOpen / findSessionActive / findSessionMatchesOptions /
 *     hideFindHighlights / clearFindSession / findNavCountText / updateFindNavUi / renderFindStatusChip /
 *     syncFindOverlayScroll / markFindCurrentHit / renderFindHighlights / selectFindMatch / startFindSession / stepFind；
 *   ② 查找替换面板：openFindPanel / closeFindPanel / readFindOptions；
 *   ③ 查找面板的渲染与执行：renderFindResults / jumpToFindResult / runFind / replaceEditorText / runReplaceAll。
 * **只搬不改行为**：高亮窗口 / 当前命中 class / 令牌与旧结果 / F3 前后跳 / 整本查找清单 / 当前章替换（execCommand
 * 撤销链）/ 整本替换三次确认与备份提示 / 失败兜底全部一字未改。
 * 事件绑定随域搬进 setupFindUi()（打开面板 / 上一处下一处 / 状态栏小标签 / 词与选项变化 / 替换两个按钮 / 关闭 /
 * 输入框回车三处）。查找书签的按钮绑定不在本域（等补刀 9b）。
 *
 * 契约：createFindUi(host) 由渲染层调用一次。host 8 个成员（含 3 个语义分组，分组内每个真实依赖都列在这里）：
 *   host = {
 *     $, state, api, call, toast,          // 基础 5：DOM 查询 / 共享状态（state.find）/ IPC 白名单 / IPC 包装 / 提示
 *     find: {                               // 查找纯逻辑与编辑区
 *       findLogic,                          //   renderer/find-logic.js：计数 / 步进 / 高亮窗口 / 行号
 *       editorEl,                           //   编辑区（查找只读它；当前章替换只改它，未保存）
 *       syncEditorOverlay,                  //   查找高亮层与标记层同一套对齐（编辑器小件域）
 *       scrollCaretIntoView,                 //   选到命中后把光标滚进视野（共享胶水）
 *       onEditorInput                       //   当前章替换写回编辑区后触发一次输入处理（dirty / 字数）
 *     },
 *     nav: {                                // 章节与视图
 *       chapterTitle, switchChapter,        //   整本结果清单的章名 / 点结果切章
 *       loadChapterAt, currentChapterLabel, //   整本替换前的未保存处理
 *       hideHeaderMenus                     //   打开查找面板前收起顶栏菜单
 *     },
 *     collab: {                             // 跨域动作 / 尚未搬走的相邻面板
 *       askUnsaved, saveCurrent, openModal, //   整本替换前的三选一（1.4.0 P0-2 起整本替换不再弹二次确认）
      registerUndo,                       //   登记 10 秒撤销（整本替换用替换备份还原；1.4.0 P0-2）
 *       refreshShelf, renderChapterList, reloadAfterPartialFailure, // 整本替换后的统计 / 章节栏 / 失败兜底
 *       closeProofreadPanel, runReplaceOne, //   打开查找前关校对框 / 「替换当前处」实现（整本替换域）
 *       renderFindBookmarks, refreshFindBookmarks, refreshReplaceBackups // 打开面板时顺带刷书签与替换备份入口（懒调用）
 *     }
 *   }
 * 缺任何一个（含分组内成员）直接抛 TypeError。分组在 create 时一次解构，行为等价（其中四个懒转发见注释）。
 * create() 不注册事件、不建定时器、不碰 DOM；事件绑定在 setupFindUi()，由 bindEvents() 在原位置调用一次。
 *
 * 刻意不搬（留在 renderer.js）：查找书签（补刀 9b）、整本替换的备份还原（后续补刀）、
 * 状态栏 / 编辑区事件里对 findSessionActive 等的运行时调用、Esc 动作表、测试钩子宿主契约。
 *
 * 浏览器里挂成全局 CWFindUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWFindUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HOST = ['$', 'state', 'api', 'call', 'toast', 'find', 'nav', 'collab'];

  function createFindUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createFindUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) throw new TypeError('createFindUi 的 host 缺少 ' + key);
    }
    const { $, state, api, call, toast, find, nav, collab } = host;
    if (typeof find !== 'object') throw new TypeError('createFindUi 的 host.find 必须是对象');
    for (const key of ['findLogic', 'editorEl', 'syncEditorOverlay', 'scrollCaretIntoView', 'onEditorInput']) {
      if (find[key] === undefined || find[key] === null) throw new TypeError('createFindUi 的 host.find 缺少 ' + key);
    }
    if (typeof nav !== 'object') throw new TypeError('createFindUi 的 host.nav 必须是对象');
    for (const key of ['chapterTitle', 'switchChapter', 'loadChapterAt', 'currentChapterLabel', 'hideHeaderMenus']) {
      if (nav[key] === undefined || nav[key] === null) throw new TypeError('createFindUi 的 host.nav 缺少 ' + key);
    }
    if (typeof collab !== 'object') throw new TypeError('createFindUi 的 host.collab 必须是对象');
    for (const key of ['askUnsaved', 'saveCurrent', 'openModal', 'registerUndo', 'refreshShelf', 'renderChapterList', 'reloadAfterPartialFailure', 'closeProofreadPanel', 'runReplaceOne', 'renderFindBookmarks', 'refreshFindBookmarks', 'refreshReplaceBackups']) {
      if (collab[key] === undefined || collab[key] === null) throw new TypeError('createFindUi 的 host.collab 缺少 ' + key);
    }
    const { findLogic, editorEl, syncEditorOverlay, scrollCaretIntoView, onEditorInput } = find;
    const { chapterTitle, switchChapter, loadChapterAt, currentChapterLabel, hideHeaderMenus } = nav;
    const { askUnsaved, saveCurrent, openModal, registerUndo, refreshShelf, renderChapterList, reloadAfterPartialFailure, closeProofreadPanel, runReplaceOne, renderFindBookmarks, refreshFindBookmarks, refreshReplaceBackups } = collab;

  // ---------- 查找会话（v0.8-11，提案 N11）----------
  // 当前章的「上一处 / 下一处」+「结果持续高亮」：
  //   - 全部命中画在 #editor-find-marks 影子层上（和标记层同一套对齐逻辑），当前那处颜色更重；
  //   - 上一处 / 下一处只移动光标 / 选区 + 换 class，不重画正文，也不碰编辑区内容；
  //   - 会话只记在内存里：改正文、切章、换书、离开写作页就结束；不写配置、不写书库。
  //   - 命中太多时只画当前附近一屏（find-logic.highlightWindow），导航仍对全部命中有效。
  function findOverlayEl() {
    return $('editor-find-marks');
  }

  function findPanelOpen() {
    const backdrop = $('find-backdrop');
    return Boolean(backdrop && !backdrop.classList.contains('hidden'));
  }

  function findSessionActive() {
    return Boolean(state.find.total > 0 && state.find.matches.length && state.view === 'editor');
  }

  // 会话是否就是查找框里现在这组条件（词 + 大小写）：是的话回车 / 下一处直接走，不重新查。
  function findSessionMatchesOptions(options) {
    return (
      state.find.total > 0 &&
      state.find.query === String(options.query == null ? '' : options.query) &&
      state.find.caseSensitive === Boolean(options.caseSensitive)
    );
  }

  function hideFindHighlights() {
    const overlay = findOverlayEl();
    if (!overlay) return;
    overlay.classList.add('hidden');
    overlay.textContent = '';
    state.find.windowKey = '';
    state.find.highlighted = 0;
  }

  function clearFindSession({ toastHint = false } = {}) {
    hideFindHighlights();
    state.find.query = '';
    state.find.caseSensitive = false;
    state.find.matches = [];
    state.find.index = -1;
    state.find.total = 0;
    state.find.windowStart = 0;
    state.find.windowEnd = 0;
    state.find.truncated = false;
    state.find.fromBookmark = false;
    updateFindNavUi();
    if (toastHint) toast('已结束查找高亮（正文没改，也没写盘）');
  }

  function findNavCountText() {
    return findLogic.formatCounter(state.find.index, state.find.total);
  }

  function updateFindNavUi() {
    const count = $('find-nav-count');
    if (count) count.textContent = findNavCountText();
    renderFindStatusChip();
  }

  // 状态栏小标签：有查找会话时显示「查找 3/12」，点一下下一处；Esc 清除。
  function renderFindStatusChip() {
    const chip = $('status-find');
    if (!chip) return;
    const active = Boolean(state.find.total > 0);
    chip.classList.toggle('hidden', !active);
    if (!active) {
      chip.textContent = '查找';
      chip.title = '';
      return;
    }
    const label = state.find.fromBookmark ? '书签' : '查找';
    chip.textContent = `${label} ${findLogic.formatCounter(state.find.index, state.find.total)}`;
    chip.title = state.find.fromBookmark
      ? `书签「${state.find.query}」：第 ${state.find.index + 1}/${state.find.total} 处` +
        `${state.find.truncated ? `（命中太多，正文里只高亮当前附近 ${state.find.highlighted} 处）` : ''}\n` +
        '打开这一章时按最新正文自动高亮；F3 / Shift+F3 = 下一处 / 上一处；Esc = 收起高亮。只显示，不改正文、不写盘。'
      : `查找「${state.find.query}」：第 ${state.find.index + 1}/${state.find.total} 处` +
        `${state.find.truncated ? `（命中太多，正文里只高亮当前附近 ${state.find.highlighted} 处）` : ''}\n` +
        '单击 = 下一处；F3 / Shift+F3 = 下一处 / 上一处；Esc = 清除高亮。只显示，不改正文、不写盘。';
  }

  function syncFindOverlayScroll() {
    const overlay = findOverlayEl();
    if (!overlay || overlay.classList.contains('hidden')) return;
    overlay.scrollTop = editorEl.scrollTop;
    overlay.scrollLeft = editorEl.scrollLeft;
  }

  // 把当前命中标成「正在看的那一处」：只切 class，不重画整层（和当前段落高亮同一个做法）。
  function markFindCurrentHit() {
    const overlay = findOverlayEl();
    if (!overlay) return;
    const previous = overlay.querySelector('.find-hit-current');
    if (previous) previous.classList.remove('find-hit-current');
    if (state.find.index < 0) return;
    const next = overlay.querySelector(`.find-hit[data-ordinal="${state.find.index}"]`);
    if (next) next.classList.add('find-hit-current');
  }

  // 画当前章全部命中（超过一屏时只画当前附近的窗口）。
  // 正文 / 窗口没变就只更新「当前这处」的 class，移动光标不会重画整层。
  function renderFindHighlights({ force = false } = {}) {
    const overlay = findOverlayEl();
    if (!overlay) return;
    if (!findSessionActive() || !state.bookPath || state.index < 0) {
      hideFindHighlights();
      renderFindStatusChip();
      return;
    }
    const win = findLogic.highlightWindow(state.find.matches, state.find.index, {
      max: findLogic.MAX_HIGHLIGHT_ITEMS
    });
    state.find.windowStart = win.windowStart;
    state.find.windowEnd = win.windowEnd;
    state.find.truncated = win.truncated;
    state.find.highlighted = win.items.length;
    const key = [
      editorEl.value.length,
      state.find.query,
      state.find.caseSensitive ? 1 : 0,
      win.windowStart,
      win.windowEnd
    ].join('|');
    if (!force && key === state.find.windowKey) {
      syncEditorOverlay(overlay);
      markFindCurrentHit();
      renderFindStatusChip();
      return;
    }
    state.find.windowKey = key;
    overlay.classList.remove('hidden');
    syncEditorOverlay(overlay);
    overlay.textContent = '';
    const runs = findLogic.highlightRuns(editorEl.value, win.items);
    const fragment = document.createDocumentFragment();
    for (const run of runs) {
      if (!run.hit) {
        fragment.appendChild(document.createTextNode(run.text));
        continue;
      }
      const span = document.createElement('span');
      span.className = 'find-hit';
      span.dataset.ordinal = String(run.ordinal);
      span.textContent = run.text;
      fragment.appendChild(span);
    }
    overlay.appendChild(fragment);
    syncFindOverlayScroll();
    markFindCurrentHit();
    renderFindStatusChip();
  }

  // 把光标 / 选区放到第 index 处命中上（只移动选区与滚动，不改正文）。
  function selectFindMatch(index) {
    if (!state.find.total) return null;
    const safe = Math.min(Math.max(Math.floor(Number(index) || 0), 0), state.find.total - 1);
    state.find.index = safe;
    const match = state.find.matches[safe];
    const start = Math.min(match.index, editorEl.value.length);
    editorEl.focus();
    editorEl.setSelectionRange(start, Math.min(start + match.length, editorEl.value.length));
    scrollCaretIntoView(start);
    renderFindHighlights();
    updateFindNavUi();
    return { index: safe, match };
  }

  // 用一组命中开始新的查找会话（查询结果来自 text:find-all，已含全部命中）。
  function startFindSession(query, caseSensitive, matches, index = 0) {
    const list = Array.isArray(matches)
      ? matches
          .filter((item) => item && Number.isFinite(Number(item.index)) && Number(item.length) > 0)
          .map((item) => ({ index: Math.max(0, Math.floor(Number(item.index))), length: Math.floor(Number(item.length)) }))
      : [];
    state.find.query = String(query == null ? '' : query);
    state.find.caseSensitive = Boolean(caseSensitive);
    state.find.matches = list;
    state.find.total = list.length;
    state.find.index = list.length ? Math.min(Math.max(Math.floor(Number(index) || 0), 0), list.length - 1) : -1;
    state.find.windowKey = '';
    renderFindHighlights({ force: true });
    updateFindNavUi();
    return state.find;
  }

  // 上一处 / 下一处：没有会话（或查找框里换了条件）就先查一遍并选中第一处；否则移动到相邻命中。
  async function stepFind(direction) {
    const options = readFindOptions();
    if (!options.query.trim()) {
      $('find-summary').textContent = '先在查找框里输入内容';
      return { ok: false };
    }
    if (!findSessionMatchesOptions(options)) {
      await runFind();
      return { ok: false, searched: true };
    }
    const step = findLogic.stepMatch(state.find.matches, state.find.index, direction);
    if (!step) return { ok: false };
    selectFindMatch(step.index);
    const match = state.find.matches[step.index];
    const wrapHint = step.wrapped
      ? direction < 0
        ? '（已到开头，回到最后一处）'
        : '（已到末尾，回到第 1 处）'
      : '';
    $('find-summary').textContent =
      `第 ${step.index + 1}/${step.total} 处 · 第 ${findLogic.lineOfIndex(editorEl.value, match.index)} 行${wrapHint}` +
      `${state.find.truncated ? ' · 命中太多，正文里只高亮当前附近这一屏' : ''}`;
    return { ok: true, index: step.index, total: step.total, wrapped: step.wrapped };
  }

  // ---------- 查找替换（全书 / 当前章） ----------
  function openFindPanel() {
    if (!state.bookPath) {
      toast('先打开一本书再查找', 'warn');
      return;
    }
    hideHeaderMenus();
    if (!$('proofread-backdrop').classList.contains('hidden')) closeProofreadPanel();
    // 编辑器里选中了一段短文本时，直接带进查找框
    const selection = String(window.getSelection ? window.getSelection().toString() : '');
    if (selection && selection.length <= 60 && !selection.includes('\n')) {
      $('find-query').value = selection;
    }
    $('find-backdrop').classList.remove('hidden');
    $('find-query').focus();
    $('find-query').select();
    // 打开面板时如果带来的词 / 大小写和上次会话对不上（例如带入了新的选中文字），先把旧高亮收起来
    if (state.find.total && !findSessionMatchesOptions(readFindOptions())) clearFindSession();
    // 查找书签（v0.8-11b）：先用内存里的列表画出来，再从主进程取一次最新的（多窗口 / 手改配置）
    renderFindBookmarks();
    void refreshFindBookmarks();
    // 顺带看一眼这本书有没有「整本替换」的备份（有就显示「还原到替换前」入口）
    refreshReplaceBackups();
    updateFindNavUi();
  }

  function closeFindPanel() {
    $('find-backdrop').classList.add('hidden');
    // 关掉面板不结束查找会话：高亮留在正文上，F3 / Shift+F3 还能继续前后跳，Esc 才清除
    syncFindOverlayScroll();
    updateFindNavUi();
  }

  function readFindOptions() {
    return {
      query: $('find-query').value,
      replacement: $('find-replace').value,
      scope: $('find-scope').value,
      caseSensitive: $('find-case').checked
    };
  }

  function renderFindResults(payload) {
    const box = $('find-results');
    box.innerHTML = '';
    if (!payload.results.length) {
      // 1.3.0 T4（I-06）：查找无结果 = 筛选空（filtered）。说明状态 + 学习线索（字面匹配 / 全角半角）
      // + 直接路径（换词 / 选中正文再按 Ctrl+F），不新增按钮，路径都指向现有入口。
      const empty = document.createElement('div');
      empty.className = 'find-empty';
      empty.dataset.emptyKind = 'filtered';
      empty.textContent =
        `没有找到「${payload.query}」。查找是字面匹配（不做正则），区分全角 / 半角；` +
        '换个更短或更具体的词再试，或先在正文里选中一个词再按 Ctrl+F，查找框会直接带上它。';
      box.appendChild(empty);
      return;
    }
    for (const result of payload.results) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'find-result';
      row.dataset.chapterId = result.chapterId;

      const head = document.createElement('div');
      const index = state.chapters.findIndex((chapter) => chapter.id === result.chapterId);
      const chapterName = document.createElement('span');
      chapterName.className = 'find-chapter';
      chapterName.textContent = index >= 0 ? chapterTitle(index, result.name) : String(result.name || '');
      const count = document.createElement('span');
      count.className = 'find-count';
      count.textContent = `${result.count} 处`;
      head.append(chapterName, count);

      const snippet = document.createElement('div');
      snippet.className = 'find-snippet';
      const first = result.matches[0];
      if (first) {
        snippet.appendChild(document.createTextNode(first.before || ''));
        const mark = document.createElement('mark');
        mark.textContent = first.match;
        snippet.appendChild(mark);
        snippet.appendChild(document.createTextNode(first.after || ''));
      }
      row.append(head, snippet);
      row.addEventListener('click', () => jumpToFindResult(result));
      box.appendChild(row);
    }
  }

  async function jumpToFindResult(result) {
    const index = state.chapters.findIndex((chapter) => chapter.id === result.chapterId);
    if (index < 0) {
      toast('这一章已经不存在了', 'warn');
      return;
    }
    closeFindPanel();
    if (index !== state.index) {
      const switched = await switchChapter(index);
      if (!switched || switched.ok === false) return;
    }
    // 跳过来以后把这一章的命中全部高亮（v0.8-11，提案 N11）：清单是全书搜出来的，
    // 这里按「编辑区里的最新正文」重新数一遍，未保存的修改也算。
    const query = $('find-query').value;
    const caseSensitive = $('find-case').checked;
    if (query.trim()) {
      try {
        const res = await call(api.findAll, editorEl.value, query, { caseSensitive });
        if (res.count) {
          state.find.fromBookmark = false;
          startFindSession(query, caseSensitive, res.matches, 0);
          selectFindMatch(0);
          toast(
            `「${query}」在本章 ${res.count} 处，已高亮；F3 下一处 / Shift+F3 上一处，Esc 清除`
          );
          return;
        }
      } catch {
        /* 高亮失败不影响已经跳过来的位置 */
      }
    }
    const match = result.matches && result.matches[0];
    if (!match) return;
    editorEl.focus();
    const start = Math.min(match.index, editorEl.value.length);
    editorEl.setSelectionRange(start, Math.min(start + match.length, editorEl.value.length));
    scrollCaretIntoView(start);
  }

  async function runFind() {
    const options = readFindOptions();
    if (!options.query.trim()) {
      $('find-summary').textContent = '先在查找框里输入内容';
      $('find-results').innerHTML = '';
      clearFindSession();
      return;
    }
    $('find-summary').textContent = '查找中…';
    try {
      if (options.scope === 'book') {
        // 整本查找走结果清单（点一条跳过去）；当前章的高亮先收起来，免得和清单说的不是一回事
        clearFindSession();
        const payload = await call(api.searchBook, state.bookPath, {
          query: options.query,
          caseSensitive: options.caseSensitive
        });
        // R4b（V9）：整本查找会跳过超过 128 MB 的章（文件没动），有跳过才在摘要里如实提示
        const skippedNote = payload.skippedTooLarge
          ? `；有 ${payload.skippedTooLarge} 章超过 128 MB，本次已跳过（文件没动）`
          : '';
        $('find-summary').textContent = payload.totalMatches
          ? `整本命中 ${payload.totalMatches} 处，分布在 ${payload.chapterCount} 章（点结果跳过去；跳过去后本章会高亮，F3 / Shift+F3 前后跳）${skippedNote}`
          : `整本没有找到「${options.query}」${skippedNote}`;
        renderFindResults(payload);
        return;
      }
      const res = await call(api.findAll, editorEl.value, options.query, {
        caseSensitive: options.caseSensitive
      });
      $('find-results').innerHTML = '';
      if (!res.count) {
        clearFindSession();
        $('find-summary').textContent = `本章没有找到「${options.query}」`;
        return;
      }
      state.find.fromBookmark = false;
      startFindSession(options.query, options.caseSensitive, res.matches, 0);
      selectFindMatch(0);
      $('find-summary').textContent =
        `本章命中 ${res.count} 处（第 1/${res.count} 处）` +
        (state.find.truncated
          ? `；命中太多，正文里只高亮当前附近 ${state.find.highlighted} 处`
          : '');
    } catch (err) {
      $('find-summary').textContent = `查找失败：${err.message}`;
    }
  }

  // 当前章替换：走原生输入，保住 Ctrl+Z 撤销链；只改编辑区（未保存）
  function replaceEditorText(text) {
    editorEl.focus();
    editorEl.setSelectionRange(0, editorEl.value.length);
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch {
      inserted = false;
    }
    if (!inserted || editorEl.value !== text) editorEl.value = text;
    editorEl.setSelectionRange(0, 0);
    onEditorInput();
  }

  async function runReplaceAll() {
    const options = readFindOptions();
    if (!options.query.trim()) {
      $('find-summary').textContent = '先在查找框里输入内容';
      return;
    }
    if (options.scope === 'current') {
      try {
        const res = await call(api.replaceInText, editorEl.value, options.query, options.replacement, {
          caseSensitive: options.caseSensitive
        });
        if (!res.count) {
          $('find-summary').textContent = `本章没有找到「${options.query}」，未做替换`;
          return;
        }
        replaceEditorText(res.text);
        $('find-summary').textContent = `本章已替换 ${res.count} 处（还没保存：Ctrl+S 写盘，Ctrl+Z 可撤销）`;
        toast(`本章替换 ${res.count} 处（未保存）`);
      } catch (err) {
        toast(`替换失败：${err.message}`, 'error');
      }
      return;
    }

    // 整本替换：先处理未保存修改，再确认，替换前由主进程备份原章节
    if (state.dirty) {
      const action = await askUnsaved({
        title: '整本替换前先处理未保存的修改',
        message: `「${currentChapterLabel()}」还有未保存的修改；整本替换会直接写盘，建议先保存。`
      });
      if (action === 'cancel') return;
      if (action === 'save') {
        const saved = await saveCurrent();
        if (!saved.ok) return;
      } else if (action === 'discard') {
        await loadChapterAt(state.index); // 用磁盘上的旧内容继续
      }
    }

    try {
      const preview = await call(api.searchBook, state.bookPath, {
        query: options.query,
        caseSensitive: options.caseSensitive
      });
      if (!preview.totalMatches) {
        $('find-summary').textContent = `整本没有找到「${options.query}」，未做替换`;
        return;
      }
      // 1.4.0 P0-2（撤销优先于确认）：整本替换不再弹二次确认 —— 直接替换（写前由主进程把原章节
      // 备份到 _trash/替换备份-*），10 秒内可撤销（撤销 = 用这份替换备份还原）。
      // 未保存拦截仍在前一步：整本替换会直接写盘。
      const bookPath = state.bookPath;
      closeFindPanel();
      const result = await call(api.replaceBook, state.bookPath, {
        query: options.query,
        replacement: options.replacement,
        caseSensitive: options.caseSensitive
      });
      await loadChapterAt(state.index);
      renderChapterList();
      refreshShelf(); // 字数变了，书架统计后台刷新即可
      const backupName = result.backupDir ? String(result.backupDir).split(/[\\/]/).pop() : '';
      if (result.chaptersChanged && backupName && typeof registerUndo === 'function') {
        registerUndo(`已整本替换 ${result.chaptersChanged} 章 / ${result.occurrences} 处`, async () => {
          if (state.bookPath !== bookPath) throw new Error('已经换了书，不能撤销');
          const back = await call(api.restoreReplaceBackup, bookPath, backupName);
          if (!back || !Number(back.restored)) throw new Error('替换备份里没有可还原的章节');
          await loadChapterAt(state.index);
          renderChapterList();
          refreshShelf();
        });
      }
      toast(
        `整本替换完成：${result.chaptersChanged} 章 / ${result.occurrences} 处${
          result.backupDir ? ' · 原文已备份到 _trash（10 秒内可撤销）' : ''
        }${
          result.skippedTooLarge ? `；有 ${result.skippedTooLarge} 章超过 128 MB，本次已跳过（文件没动）` : ''
        }`
      );
    } catch (err) {
      toast(`整本替换失败：${err.message}`, 'error');
      await reloadAfterPartialFailure(); // 可能已经替换了好几章，别让编辑区停在旧正文上
    }
  }

  // 事件绑定（与搬前 bindEvents() 里的查找块逐行一致；由渲染层在原位置调用一次）
  function setupFindUi() {
    $('btn-find').addEventListener('click', openFindPanel);
    $('btn-find-run').addEventListener('click', runFind);
    $('btn-find-prev').addEventListener('click', () => void stepFind(-1));
    $('btn-find-next').addEventListener('click', () => void stepFind(1));
    $('status-find').addEventListener('click', () => {
      if (findSessionActive()) void stepFind(1);
    });
    // 查找框里改了词 / 大小写 / 范围：旧的高亮已经对不上了，立刻收起来，按回车才重新查
    const invalidateFindSession = () => {
      if (state.find.total && !findSessionMatchesOptions(readFindOptions())) clearFindSession();
      updateFindNavUi();
    };
    $('find-query').addEventListener('input', invalidateFindSession);
    $('find-case').addEventListener('change', invalidateFindSession);
    $('find-scope').addEventListener('change', () => {
      clearFindSession();
      $('find-results').innerHTML = '';
    });
    $('btn-find-replace-one').addEventListener('click', runReplaceOne);
    $('btn-find-replace').addEventListener('click', runReplaceAll);
    $('btn-find-close').addEventListener('click', closeFindPanel);
    // 查找框回车：还没查过（或换了词）就查一遍并选中第一处；已经查过就走「下一处」。
    // Shift+回车 = 上一处。stopPropagation 避免 document 上的 Enter 处理再跑一遍（那样会连跳两处）。
    const onFindQueryEnter = (event) => {
      const options = readFindOptions();
      if (!options.query.trim()) {
        $('find-summary').textContent = '先在查找框里输入内容';
        return;
      }
      if (options.scope === 'current' && findSessionMatchesOptions(options)) {
        void stepFind(event.shiftKey ? -1 : 1);
      } else {
        void runFind();
      }
    };
    $('find-query').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      onFindQueryEnter(event);
    });
    $('find-replace').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        runReplaceAll();
      }
    });
  }


    return {
      findOverlayEl,
      findPanelOpen,
      findSessionActive,
      findSessionMatchesOptions,
      hideFindHighlights,
      clearFindSession,
      findNavCountText,
      updateFindNavUi,
      renderFindStatusChip,
      syncFindOverlayScroll,
      markFindCurrentHit,
      renderFindHighlights,
      selectFindMatch,
      startFindSession,
      stepFind,
      openFindPanel,
      closeFindPanel,
      readFindOptions,
      renderFindResults,
      jumpToFindResult,
      runFind,
      replaceEditorText,
      runReplaceAll,
      setupFindUi
    };
  }

  return { create: createFindUi, REQUIRED_HOST };
});
