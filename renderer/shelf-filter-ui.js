/* 书架搜索（v0.9 B-5 第九刀：从 renderer.js 的「书架搜索」分区整段搬出来）。
 *
 * 搬走的段（原 renderer.js 776–961，186 行，含分区注释）——书架搜索的内存过滤与结果区渲染：
 *   shelfQueryText（trim 后的查询词）·
 *   bookGroupOf / shelfGroupList / shelfGroupMatches（v0.8-3 分组筛选，只影响书架视图，不写配置）·
 *   shelfTagMatches（1.6.0 F5：标签筛选，与分组 / 搜索词 AND 组合）·
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
 * expandContentChapter（P22-4）同样是惰性转发、且是**可选**成员：它由正文搜索模块晚一步交出，
 * 没有它时正文结果区仍按旧形状平铺、不出现「展开本章全部」。
 * create() 不注册任何事件、不建定时器；只在 renderShelfContent 里给结果行 / 展开按钮绑它自己的 click。
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
    return bookInfoLib.bookMatchesFilters(book, { group: state.shelfGroup });
  }

  // 标签筛选（1.6.0 F5）：与分组同一个口径（AND），标签按全名精确匹配；空 = 不限。
  // 标签清单 / 计数由书籍信息模块从 书目.json 现算，这里只读 state.shelfTag 做过滤。
  function shelfTagMatches(book) {
    return bookInfoLib.bookMatchesFilters(book, { tag: state.shelfTag });
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
      if (!shelfTagMatches(book)) continue;
      const info = matchBookForSearch(book, queryLower);
      if (info.visible) rows.push({ book, info });
    }
    return rows;
  }

  function shelfContentActive() {
    return state.view === 'shelf' && shelfQueryText().length >= CONTENT_SEARCH_MIN_CHARS;
  }

  // ---------- 正文命中：按「书 + 章」聚合（P22-4） ----------
  // 一次搜索里同一章的结果在 results 里天然连续（索引逐书逐章扫），所以按连续段分组即可；
  // 组键只用于「展开过哪几章」的状态，不写盘、不进 state 以外的地方。
  function contentGroupKey(row) {
    if (!row || typeof row !== 'object') return '';
    const bookPath = typeof row.bookPath === 'string' ? row.bookPath : '';
    const chapterFile = typeof row.chapterFile === 'string' ? row.chapterFile : '';
    if (!bookPath || !chapterFile) return '';
    return bookPath + '\u0000' + chapterFile;
  }

  function contentHitCount(row, fallback) {
    const value = row ? Number(row.chapterMatchCount) : NaN;
    if (Number.isFinite(value) && value >= 0) return Math.floor(value);
    return Math.max(0, Math.floor(Number(fallback) || 0));
  }

  // 摘要里的「正文命中 N 处」用真命中数（P22-4 起主进程会回报 totalMatches）；
  // 旧结果 / 旧测试没有这个字段时回落到已列出的条数，文案与旧版逐字一致。
  function contentMatchTotal(meta) {
    if (meta && typeof meta.totalMatches === 'number' && Number.isFinite(meta.totalMatches) && meta.totalMatches >= 0) {
      return Math.floor(meta.totalMatches);
    }
    return meta && Array.isArray(meta.results) ? meta.results.length : 0;
  }

  function appendContentRow(list, row, index) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'shelf-content-row';
    item.dataset.index = String(index);
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
    return item;
  }

  // 一章一组：组头「书名 · 第N章：章名 · 本章 N 处（N+ = 计数到上限）」+ 本组命中行。
  // 默认只列这次搜索已经带回来的前几条；章内还有没列出的命中时给「展开本章全部」，
  // 点开后就地替换成该章全部命中（行由正文搜索模块异步取回），按钮变「收起」。
  function renderContentGroup(list, rows, startIndex, expanded) {
    const first = rows[0];
    const key = contentGroupKey(first);
    const entry = expanded && key ? expanded[key] : null;
    const total = contentHitCount(first, rows.length);
    const capped = Boolean(first.chapterCountCapped);
    const groupHead = document.createElement('div');
    groupHead.className = 'shelf-content-group';
    groupHead.dataset.group = key;
    groupHead.textContent =
      `${first.bookTitle || ''} · ` +
      chapterTitle(Number(first.chapterIndex) || 0, first.chapterName || '') +
      ` · 本章 ${total}${capped ? '+' : ''} 处`;
    list.appendChild(groupHead);

    const expandedRows = entry && Array.isArray(entry.rows) && entry.rows.length ? entry.rows : null;
    const shownRows = expandedRows || rows;
    for (let i = 0; i < shownRows.length; i += 1) {
      appendContentRow(list, shownRows[i], expandedRows ? i : startIndex + i);
    }

    if (entry && entry.loading) {
      const busy = document.createElement('div');
      busy.className = 'shelf-content-expand-note muted small';
      busy.textContent = '正在展开本章全部命中…';
      list.appendChild(busy);
    } else if (entry && entry.error) {
      const failed = document.createElement('div');
      failed.className = 'shelf-content-expand-error muted small';
      failed.textContent = `展开失败：${entry.error}`;
      list.appendChild(failed);
    } else if (expandedRows && entry.truncated) {
      const note = document.createElement('div');
      note.className = 'shelf-content-expand-note muted small';
      note.textContent = `本章命中太多，只列出前 ${expandedRows.length} 处`;
      list.appendChild(note);
    } else if (entry && !entry.loading && !expandedRows) {
      const note = document.createElement('div');
      note.className = 'shelf-content-expand-note muted small';
      note.textContent = '这一章的命中已经找不到了（正文可能刚被改过）';
      list.appendChild(note);
    }

    const canExpand = typeof host.expandContentChapter === 'function';
    if (canExpand && (capped || total > rows.length || Boolean(entry))) {
      const isExpanded = Boolean(expandedRows);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn ghost tiny shelf-content-expand';
      button.dataset.group = key;
      if (entry && entry.loading) {
        button.textContent = '展开中…';
        button.disabled = true;
      } else {
        button.textContent = isExpanded ? '收起' : '展开本章全部';
      }
      button.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (button.disabled) return;
        void host.expandContentChapter(first, { collapse: isExpanded });
      });
      list.appendChild(button);
    }
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
        `正文命中 ${contentMatchTotal(meta)} 处（显示 ${shown} 条）` +
          (meta.truncated ? ' · 只查了最近的一部分书' : '') +
          ` · 已查 ${meta.scannedBooks}/${meta.candidateBooks} 本` +
          // 功能-5（2026-11-11）：书架不读每本书的编号设置，这里的章号一律按全书顺序；
          // 书设为按卷编号时写作页显示的是卷内号 —— 只写清已知差异，不改显示语义。
          ' · 章号按全书顺序显示（书设为「每卷重新编号」时，写作页显示的是卷内号，两处不同）'
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
    // 全部行都带「书 + 章」信息才按章聚合；旧形状（没有 chapterFile）照旧平铺，行为不变。
    const grouped = visible.length > 0 && visible.every((row) => Boolean(contentGroupKey(row)));
    if (grouped) {
      const expanded = content.expanded && typeof content.expanded === 'object' ? content.expanded : null;
      let i = 0;
      while (i < visible.length) {
        const key = contentGroupKey(visible[i]);
        let end = i + 1;
        while (end < visible.length && contentGroupKey(visible[end]) === key) end += 1;
        renderContentGroup(list, visible.slice(i, end), i, expanded);
        i = end;
      }
    } else {
      for (let i = 0; i < visible.length; i += 1) appendContentRow(list, visible[i], i);
    }

    if (visible.length && results.length > content.shown) {
      more.classList.remove('hidden');
      more.textContent = `显示更多（还有 ${results.length - content.shown} 条）`;
    } else {
      more.classList.add('hidden');
    }
    if (!visible.length && !content.loading && !content.error && (!meta || !meta.results || !meta.results.length)) {
      // 1.3.0 T4（I-06）：正文命中区的空态也按三件套写——说明状态 / 学习线索 / 直接路径。
      // 这一区只在有查询词时出现，属于「筛选空」（filtered），不是真空。
      const empty = document.createElement('div');
      empty.className = 'shelf-content-empty muted small';
      empty.dataset.emptyKind = 'filtered';
      empty.textContent =
        meta && meta.truncated
          ? '最近的一部分书里没有找到。正文索引只查了最近的一部分书；换个更具体一点的词再试，或按 Esc 清空搜索。'
          : '书名、章节名和正文里都没找到。换个更短或更具体的词再试；按 Esc 清空搜索。';
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
        ? ` · 正文命中 ${contentMatchTotal(content.meta)} 处`
        : '';
    const groupNote = state.shelfGroup ? '（已按分组筛选）' : '';
    const tagNote = state.shelfTag ? '（已按标签筛选）' : '';
    summary.textContent =
      matchedCount > 0
        ? `搜索「${query}」：${matchedCount} / ${state.books.length} 本书名 / 作者 / 分组 / 标签 / 章节名命中${groupNote}${tagNote}${contentNote}（回车打开第一本，Esc 清除）`
        : `搜索「${query}」：没有匹配的书名 / 作者 / 分组 / 标签 / 章节名${groupNote}${tagNote}${contentNote || '，正文也没有找到'}（Esc 清除）`;
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
