/* 书架视图（WP17 A3 第三刀：从渲染层编排器整段搬出来）。
 *
 * 搬走的一段：
 *   · applyBookDisplay —— 打开一本书后套用这本书的显示设置（字体 / 排版 / 侧栏宽度）；
 *   · refreshShelf —— 回书架时重取「上次写作位置 / 今日统计 / 书目」→ renderShelf() → 后台索引校验；
 *   · bookGridColumns —— 书卡网格列数（拍板 #16b 的键盘方向键几何来源）；
 *   · bindShelfEvents —— 书架搜索 250ms 防抖 + 下一帧渲染 / Esc 清空 / 回车打开 / 清空按钮 / 正文「显示更多」。
 * **只搬不改行为**：函数体与事件段逐字保留（含 B6 防抖与「Esc / 清空立即重画」的注释红线）；
 * 两个防抖定时器句柄是本域私有活状态，随模块走，编排器不再留第二份。
 *
 * 契约：createShelfViewUi(host) 由渲染层在 bindEvents 之前装配一次；缺成员在装配时 TypeError
 * （宁可在启动时炸，也不要到点回书架才 ReferenceError）。host 成员见 REQUIRED_HOST，全部是
 * 编排器里已绑定的 const / 提升函数。
 * 编排器仍保留同名包装（函数声明会提升），调用点 / 测试钩子一个字都不改。
 *
 * 浏览器里挂成全局 CWShelfViewUi（index.html 排在编排器之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../core/assert-host').assertHost);
  } else if (root) {
    root.CWShelfViewUi = factory(root.CWAssertHost && root.CWAssertHost.assertHost);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (assertHost) {
  'use strict';

  const REQUIRED_HOST = [
    'state', 'api', 'call', 'toast', '$',
    'refreshStats', 'markCommandsDirty', 'renderShelf', 'ensureSearchIndex',
    'shelfQueryText', 'scheduleContentSearch', 'resetShelfContent', 'shelfSearchResults',
    'openBookByPath', 'openContentResult', 'renderShelfContent', 'imeGuard',
    'effectiveConfig', 'loadCustomFont', 'applyEditorStyle', 'syncCaretParagraphFromConfig',
    'applySidebarWidth', 'CONTENT_SEARCH_MIN_CHARS', 'CONTENT_PAGE_SIZE'
  ];

  function createShelfViewUi(host) {
    assertHost('createShelfViewUi', host, REQUIRED_HOST);
    const {
      state, api, call, toast, $,
      refreshStats, markCommandsDirty, renderShelf, ensureSearchIndex,
      shelfQueryText, scheduleContentSearch, resetShelfContent, shelfSearchResults,
      openBookByPath, openContentResult, renderShelfContent, imeGuard,
      effectiveConfig, loadCustomFont, applyEditorStyle, syncCaretParagraphFromConfig,
      applySidebarWidth, CONTENT_SEARCH_MIN_CHARS, CONTENT_PAGE_SIZE
    } = host;

  // 旧M5（一轮·中/低）：开书 / 刷新书架的世代令牌。异步回执到达时先核令牌，旧的一律丢弃 ——
  // 快速连开两本书时 A 的字体 / 纸色 / 侧栏不许盖到 B；换根 / 多窗口广播并发时不许显示旧列表。
  let displaySeq = 0;
  let shelfSeq = 0;

  // 打开一本书后套用这本书的显示设置（没有单独设置过就沿用全局）
  async function applyBookDisplay(bookId) {
    const seq = ++displaySeq;
    let display = {};
    try {
      display = (await call(api.getBookDisplay, bookId)) || {};
    } catch {
      display = {};
    }
    if (seq !== displaySeq) return; // 更新的一次开书在飞：这份回执属于上一本书，整份丢弃
    state.bookDisplay = display;
    state.config = effectiveConfig();
    if (state.config.editorFont === 'custom' && state.config.editorCustomFontPath) {
      await loadCustomFont(state.config.editorCustomFontPath, { silent: true });
      if (seq !== displaySeq) return;
    }
    applyEditorStyle();
    // 当前段落高亮的开关 / 颜色按这本书的覆盖（没有覆盖就用全局默认）
    syncCaretParagraphFromConfig();
    applySidebarWidth(state.config.editorSidebarWidth != null ? state.config.editorSidebarWidth : 250);
  }

  // 回书架时重取「上次写作位置 / 今日统计 / 书目」并重画（原「---------- 书架 ----------」段）。
  async function refreshShelf() {
    const seq = ++shelfSeq;
    // 上次写作位置每次回书架都重新取：在编辑页切章 / 保存后主进程已经更新了配置
    let recent = null;
    try {
      recent = await call(api.getRecentBook);
    } catch {
      recent = null;
    }
    if (seq !== shelfSeq) return; // 旧M5：更新的一次刷新已经发起，这份回执整份丢弃（含下面的统计 / 书目）
    state.recentBook = recent;
    // 今日字数 / 近 30 天统计（主进程算本地日期，界面不自己算）
    await refreshStats();
    if (seq !== shelfSeq) return;
    let books = [];
    try {
      books = await call(api.listBooks);
    } catch (err) {
      books = [];
      if (seq === shelfSeq) toast(`读取书架失败：${err.message}`, 'error');
    }
    if (seq !== shelfSeq) return;
    state.books = books;
    markCommandsDirty(); // 书架变了：命令面板里的「书」条目要重建（1.5.0 P0-6）
    renderShelf();
    // 正文索引：回书架时顺手让主进程校验 / 增量更新（后台，不 await、不挡书架显示）。
    // 第一次打开大书架会建索引，进度通过 search:progress 回到这里显示。
    void ensureSearchIndex();
    if (shelfQueryText().length >= CONTENT_SEARCH_MIN_CHARS) scheduleContentSearch();
  }

  // 书架网格当前几列（拍板 #16b）：getComputedStyle 的 gridTemplateColumns 算出来是
  // 「每列一条轨道 + 空格」，数一下就得到列数（含 1fr / minmax 这类写法）。
  // 拿不到（还没渲染 / display 不是 grid）就退化成 1 列 → 方向键回到单向移动（等价旧行为）。
  function bookGridColumns() {
    const grid = $('book-grid');
    if (!grid || typeof window.getComputedStyle !== 'function') return 1;
    const cols = String(window.getComputedStyle(grid).gridTemplateColumns || '').trim();
    if (!cols || cols === 'none') return 1;
    const count = cols.split(/\s+/).filter(Boolean).length;
    return Number.isFinite(count) && count > 0 ? count : 1;
  }

  // 书架搜索 / 清空 / 「显示更多」的事件段（B6 250ms 防抖 + 下一帧；Esc / 清空立即重画）。
  // 函数体逐字搬自 bindEvents，调用点只剩编排器里的一行 shelfViewUi.bindShelfEvents()。
  function bindShelfEvents() {
    // B6（审计 P6）：书架搜索原来每敲一个键就整块重建 grid（千本书时每键白建一堆 DOM）。
    // 改成 250ms 防抖 + 下一帧渲染：查询词仍立刻写回 state（正文搜索 / 回车 / 清空都用最新值），
    // 只是「过滤重排」等停手后再做一次。
    let shelfFilterTimer = 0;
    let shelfFilterFrame = 0;
    function scheduleShelfRender() {
      if (shelfFilterTimer) clearTimeout(shelfFilterTimer);
      shelfFilterTimer = setTimeout(() => {
        shelfFilterTimer = 0;
        if (shelfFilterFrame) return;
        shelfFilterFrame = requestAnimationFrame(() => {
          shelfFilterFrame = 0;
          renderShelf();
        });
      }, 250);
    }

    // 书架搜索：书名 / 章节名输入即过滤（B6：过滤重排走 250ms 防抖 + rAF）；正文防抖后异步查；
    // Esc 清除（立即）；回车打开第一本匹配的书
    $('shelf-search').addEventListener('input', () => {
      state.shelfQuery = $('shelf-search').value;
      scheduleShelfRender();
      scheduleContentSearch();
    });
    $('shelf-search').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        // RSHE-C-02：组字中按 Esc 是取消候选词，不该清空搜索词（与下面 Enter 同一份守卫）。
        if (imeGuard.isImeComposing(event)) return;
        event.preventDefault();
        state.shelfQuery = '';
        $('shelf-search').value = '';
        resetShelfContent();
        renderShelf();
        return;
      }
      if (event.key === 'Enter') {
        // 1.7.1 P1（审计 V73）/ WP-04（V112）：输入法组字中的 Enter 只上屏候选词，不当「打开第一本匹配的书」
        if (imeGuard.isImeComposing(event)) return;
        event.preventDefault();
        const rows = shelfSearchResults();
        if (rows.length) {
          openBookByPath(rows[0].book.path);
          return;
        }
        // 书名 / 章名没有命中时，回车的含义就是「打开第一条正文命中」
        const content = state.shelfContent;
        const first = content.meta && content.meta.results ? content.meta.results[0] : null;
        if (first) void openContentResult(first);
      }
    });
    $('btn-shelf-search-clear').addEventListener('click', () => {
      state.shelfQuery = '';
      $('shelf-search').value = '';
      resetShelfContent();
      renderShelf();
      $('shelf-search').focus();
    });
    $('btn-shelf-content-more').addEventListener('click', () => {
      state.shelfContent.shown += CONTENT_PAGE_SIZE;
      renderShelfContent();
    });
  }

    return { applyBookDisplay, refreshShelf, bookGridColumns, bindShelfEvents };
  }

  return { create: createShelfViewUi, REQUIRED_HOST };
});
