/* 书架搜索（v0.9 B-5 第九刀：从 renderer.js 的「书架搜索」分区整段搬出来）。
 *
 * 搬走的段（原 renderer.js 776–961，186 行，含分区注释）——书架搜索的内存过滤与结果区渲染：
 *   shelfQueryText（trim 后的查询词）·
 *   bookGroupOf / shelfGroupList / shelfGroupMatches（v0.8-3 分组筛选，只影响书架视图，不写配置）·
 *   matchBookForSearch（书名 / 文件夹 / 作者 / 分组 / 标签 / 章节名，内存字面量匹配，章名最多 3 条）·
 *   shelfSearchResults（先按分组再按查询词，过滤出可见书卡）·
 *   shelfContentActive（书架视图且查询词达到最少字数才显示正文结果）·
 *   renderShelfContent（正文结果区：摘要文案 / 结果行 / 高亮片段 / 显示更多 / 空态）·
 *   updateShelfSearchUi（搜索摘要文案 + 清除按钮显隐）。
 * 全是内存过滤与 DOM 渲染：本模块**绝不读正文、不写盘、不改 config / 数据格式 / IPC 白名单**。
 * **只搬不改行为**：正文搜索最少 2 字、章名命中最多 3 条、结果每次多显示 8 条（state.shelfContent.shown
 * 由正文搜索模块维护）、所有文案与 class 名一字未改。
 *
 * 契约：createShelfFilterUi(host) 由渲染层调用一次，host 提供：
 *   host = { state, $, bookInfoLib, chapterTitle, openContentResult, CONTENT_SEARCH_MIN_CHARS }
 * 缺任何一个直接抛 TypeError（宁可在启动时炸，也不要到书架刷新 / 敲搜索框时 ReferenceError）。
 * openContentResult 由渲染层用惰性转发传入：正文搜索模块（shelf-search-ui.js）需要本模块交出的
 * renderShelfContent，本模块又要在结果行点击时用它的 openContentResult；装配顺序照旧，调用都发生在装配之后。
 * create() 不注册任何事件、不建定时器；只在 renderShelfContent 里给结果行绑它自己的 click。
 *
 * 不搬的（刻意留在 renderer.js）：正文搜索的防抖 / 主进程查询（shelf-search-ui.js）、输入框 / 清除 /
 * 显示更多的事件绑定（事件绑定段）、测试钩子宿主契约段——都按原名取本模块交出的入口。
 * shelfGroupMatches / matchBookForSearch 是内部件（区外 0 引用），不导出（导出会让 sweep ⑤ 新增一条）。
 *
 * 浏览器里挂成全局 CWShelfFilterUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWShelfFilterUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HOST = ['$', 'state', 'bookInfoLib', 'chapterTitle', 'openContentResult', 'CONTENT_SEARCH_MIN_CHARS'];

  function createShelfFilterUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createShelfFilterUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) {
        throw new TypeError('createShelfFilterUi 的 host 缺少 ' + key);
      }
    }
    const { $, state, bookInfoLib, chapterTitle, openContentResult, CONTENT_SEARCH_MIN_CHARS } = host;
  // ---------- 书架搜索（书名 / 作者 / 分组 / 标签 + 章节名 + 正文） ----------
  // 书名 / 作者 / 分组 / 标签 / 章节名是内存过滤（输入即出）；正文走主进程的搜索索引，防抖后异步查。
  function shelfQueryText() {
    return String(state.shelfQuery || '').trim();
  }

  function bookGroupOf(book) {
    return bookInfoLib.sanitizeGroup(book && book.group);
  }

  // 书架分组筛选（v0.8-3）：只影响书架视图，不改书文件夹、不写配置。
  function shelfGroupList() {
    const groups = new Set();
    for (const book of state.books) {
      const group = bookGroupOf(book);
      if (group) groups.add(group);
    }
    return Array.from(groups).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  }

  function shelfGroupMatches(book) {
    if (!state.shelfGroup) return true;
    const group = bookGroupOf(book);
    if (state.shelfGroup === '__none__') return !group;
    return group === state.shelfGroup;
  }

  function matchBookForSearch(book, queryLower) {
    if (!queryLower) return { visible: true, titleMatch: false, infoMatch: false, chapterHits: [] };
    const title = String(book.title || '').toLowerCase();
    const folder = String(book.folder || '').toLowerCase();
    const titleMatch = title.includes(queryLower) || folder.includes(queryLower);
    // 作者 / 分组 / 标签（v0.8-3）：和书名一样是内存里的字面量匹配
    const infoMatch = bookInfoLib.bookInfoMatches(book, queryLower);
    if (titleMatch) {
      return { visible: true, titleMatch: true, infoMatch, chapterHits: [] };
    }
    const names = Array.isArray(book.chapterNames) ? book.chapterNames : [];
    const chapterHits = [];
    for (let i = 0; i < names.length && chapterHits.length < 3; i += 1) {
      const name = String(names[i] || '');
      if (name && name.toLowerCase().includes(queryLower)) chapterHits.push({ index: i, name });
    }
    return { visible: infoMatch || chapterHits.length > 0, titleMatch: false, infoMatch, chapterHits };
  }

  function shelfSearchResults() {
    const queryLower = shelfQueryText().toLowerCase();
    const rows = [];
    for (const book of state.books) {
      if (!shelfGroupMatches(book)) continue;
      const info = matchBookForSearch(book, queryLower);
      if (info.visible) rows.push({ book, info });
    }
    return rows;
  }

  function shelfContentActive() {
    return state.view === 'shelf' && shelfQueryText().length >= CONTENT_SEARCH_MIN_CHARS;
  }

  function renderShelfContent() {
    const wrap = $('shelf-content');
    if (!wrap) return;
    const content = state.shelfContent;
    if (!shelfContentActive()) {
      wrap.classList.add('hidden');
      wrap.setAttribute('aria-busy', 'false');
      return;
    }
    wrap.classList.remove('hidden');
    wrap.setAttribute('aria-busy', content.loading ? 'true' : 'false');
    const status = $('shelf-content-summary');
    const list = $('shelf-content-list');
    const more = $('btn-shelf-content-more');
    if (!status || !list || !more) return;

    const meta = content.meta;
    const parts = [];
    if (content.loading) {
      parts.push('正在正文里查找…');
    } else if (content.error) {
      parts.push(`正文搜索暂时不可用：${content.error}`);
    } else if (meta && meta.tooShort) {
      parts.push(`正文搜索至少 ${CONTENT_SEARCH_MIN_CHARS} 个字`);
    } else if (meta && meta.results && meta.results.length) {
      const shown = Math.min(content.shown, meta.results.length);
      parts.push(
        `正文命中 ${meta.results.length} 处（显示 ${shown} 条）` +
          (meta.truncated ? ' · 只查了最近的一部分书' : '') +
          ` · 已查 ${meta.scannedBooks}/${meta.candidateBooks} 本`
      );
    } else if (meta) {
      parts.push(
        `正文没有找到「${content.query}」` + (meta.truncated ? '（只查了最近的一部分书）' : '')
      );
    }
    const idx = content.indexStatus;
    if (idx && (idx.building || idx.ready === false)) {
      const progress = idx.progress && idx.progress.total
        ? `（${idx.progress.book || ''} ${idx.progress.books || 0}/${idx.progress.total} 本）`
        : '';
      parts.push(`正在为书架建正文索引${progress}，建好后自动更新结果`);
    }
    status.textContent = parts.join(' · ');

    list.innerHTML = '';
    const results = Array.isArray(content.results) ? content.results : [];
    const visible = results.slice(0, content.shown);
    for (let i = 0; i < visible.length; i += 1) {
      const row = visible[i];
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'shelf-content-row';
      item.dataset.index = String(i);
      const head = document.createElement('span');
      head.className = 'shelf-content-title';
      const bookName = document.createElement('span');
      bookName.className = 'shelf-content-book';
      bookName.textContent = row.bookTitle || '';
      const chapterName = document.createElement('span');
      chapterName.className = 'shelf-content-chapter';
      chapterName.textContent = chapterTitle(Number(row.chapterIndex) || 0, row.chapterName || '');
      head.appendChild(bookName);
      head.appendChild(chapterName);
      const snippet = document.createElement('span');
      snippet.className = 'shelf-content-snippet';
      const snip = row.snippet || {};
      if (snip.cutBefore) snippet.appendChild(document.createTextNode('…'));
      snippet.appendChild(document.createTextNode(snip.before || ''));
      const mark = document.createElement('mark');
      mark.textContent = snip.match || '';
      snippet.appendChild(mark);
      snippet.appendChild(document.createTextNode(snip.after || ''));
      if (snip.cutAfter) snippet.appendChild(document.createTextNode('…'));
      item.appendChild(head);
      item.appendChild(snippet);
      item.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void openContentResult(row);
      });
      list.appendChild(item);
    }

    if (visible.length && results.length > content.shown) {
      more.classList.remove('hidden');
      more.textContent = `显示更多（还有 ${results.length - content.shown} 条）`;
    } else {
      more.classList.add('hidden');
    }
    if (!visible.length && !content.loading && !content.error && (!meta || !meta.results || !meta.results.length)) {
      const empty = document.createElement('div');
      empty.className = 'shelf-content-empty muted small';
      empty.textContent =
        meta && meta.truncated
          ? '最近的一部分书里没有找到；试试更具体一点的词。'
          : '书名、章节名和正文里都没找到。';
      list.appendChild(empty);
    }
  }

  function updateShelfSearchUi(matchedCount) {
    const summary = $('shelf-search-summary');
    const clear = $('btn-shelf-search-clear');
    const query = shelfQueryText();
    if (clear) clear.classList.toggle('hidden', !query);
    if (!summary) return;
    if (!query) {
      summary.classList.add('hidden');
      summary.textContent = '';
      return;
    }
    summary.classList.remove('hidden');
    const content = state.shelfContent;
    const contentNote = content.loading
      ? ' · 正在搜正文…'
      : content.meta && content.meta.results && content.meta.results.length
        ? ` · 正文命中 ${content.meta.results.length} 处`
        : '';
    const groupNote = state.shelfGroup ? '（已按分组筛选）' : '';
    summary.textContent =
      matchedCount > 0
        ? `搜索「${query}」：${matchedCount} / ${state.books.length} 本书名 / 作者 / 分组 / 标签 / 章节名命中${groupNote}${contentNote}（回车打开第一本，Esc 清除）`
        : `搜索「${query}」：没有匹配的书名 / 作者 / 分组 / 标签 / 章节名${groupNote}${contentNote || '，正文也没有找到'}（Esc 清除）`;
  }

    return {
      shelfQueryText,
      bookGroupOf,
      shelfGroupList,
      shelfSearchResults,
      shelfContentActive,
      renderShelfContent,
      updateShelfSearchUi
    };
  }

  return { create: createShelfFilterUi, REQUIRED_HOST };
});
