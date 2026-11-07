/* 查找书签（第 4 步 renderer 九刀·补刀 9b：从 renderer.js 的「查找书签」分区整段搬出来）。
 *
 * 搬走的段（原 renderer.js 1265–1544，280 行）——「书签」面板（v0.8-11b，提案 N11b）：
 *   bookmarkPlaceText / currentFindBookmark / bookmarkIsCurrent / setFindBookmarks / renderFindBookmarks /
 *   refreshFindBookmarks（多窗口 / 手改配置后重新取列表）/ saveFindBookmark（「存成书签 / 更新书签」，写 config.json）/
 *   deleteFindBookmark / jumpToFindBookmark（同书切章；跨书先确认书还在书架里）/ restoreFindBookmarkForCurrentChapter
 *   （打开这一章 / 保存后按最新正文重扫并高亮；正文改到没命中时书签仍保留）。
 * **只搬不改行为**：文案 / class / dataset / 令牌作废 / 空态 / 书签只在 config.json 里、不存正文、不记命中位置 /
 * 不碰书目与章节文件——全部一字未改。事件绑定（「存成书签」按钮）随域搬进 setupFindBookmarkUi()。
 *
 * 契约：createFindBookmarkUi(host) 由渲染层调用一次。host 7 个成员（2 个语义分组 + 基础 5，分组内每个真实依赖都列在这里）：
 *   host = {
 *     $, state, api, call, toast,          // 基础 5：DOM 查询 / 共享状态（state.findBookmarks、state.find）/ IPC 白名单 / IPC 包装 / 提示
 *     find: {                               // 查找核心域（补刀 9a 模块）与书签纯逻辑
 *       bookmarksLib,                       //   core/bookmarks.js：书签清洗 / 查找 / 计数 / 显示位置
 *       editorEl,                           //   当前章正文（重扫只读它，不改正文）
 *       readFindOptions, findSessionMatchesOptions, findPanelOpen, closeFindPanel, renderFindStatusChip,
 *       startFindSession, clearFindSession  //   查找会话 / 小标签 / 面板状态的入口（同一份实现）
 *     },
 *     nav: {                                // 章节与打开书
 *       switchChapter:                 惰性, //   跳到同一本书的另一章
 *       openBookByPath                      //   跳到别的书的书签（打开书后由 loadChapterAt 统一重扫）
 *     }
 *   }
 * 缺任何一个（含分组内成员）直接抛 TypeError。分组在 create 时一次解构，行为等价。
 * create() 不注册事件、不建定时器、不碰 DOM；事件绑定在 setupFindBookmarkUi()，由 bindEvents() 在原位置调用一次。
 *
 * 刻意不搬（留在 renderer.js）：查找核心（9a 模块）、编辑区事件里对 restoreFindBookmarkForCurrentChapter 的运行时调用、
 * Esc 动作表、测试钩子宿主契约（按名字取本模块入口）。
 *
 * 浏览器里挂成全局 CWFindBookmarkUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWFindBookmarkUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HOST = ['$', 'state', 'api', 'call', 'toast', 'find', 'nav'];

  function createFindBookmarkUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createFindBookmarkUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) throw new TypeError('createFindBookmarkUi 的 host 缺少 ' + key);
    }
    const { $, state, api, call, toast, find, nav } = host;
    if (typeof find !== 'object') throw new TypeError('createFindBookmarkUi 的 host.find 必须是对象');
    for (const key of ['bookmarksLib', 'editorEl', 'readFindOptions', 'findSessionMatchesOptions', 'findPanelOpen', 'closeFindPanel', 'renderFindStatusChip', 'startFindSession', 'clearFindSession']) {
      if (find[key] === undefined || find[key] === null) throw new TypeError('createFindBookmarkUi 的 host.find 缺少 ' + key);
    }
    if (typeof nav !== 'object') throw new TypeError('createFindBookmarkUi 的 host.nav 必须是对象');
    for (const key of ['switchChapter', 'openBookByPath']) {
      if (nav[key] === undefined || nav[key] === null) throw new TypeError('createFindBookmarkUi 的 host.nav 缺少 ' + key);
    }
    const { bookmarksLib, editorEl, readFindOptions, findSessionMatchesOptions, findPanelOpen, closeFindPanel, renderFindStatusChip, startFindSession, clearFindSession } = find;
    const { switchChapter, openBookByPath } = nav;

  // ---------- 查找书签（v0.8-11b，提案 N11b）----------
  // 书签按「书 + 章」记查询词与大小写选项，只存 config.json（userData）：不存正文、
  // 不记命中位置、不碰书库 / 书目 / 章节文件。打开这一章时按磁盘上的当前正文重新扫描并
  // 高亮；正文改动保存后也重扫一次，按新正文重新定位（书签条件本身不变）。
  function bookmarkPlaceText(bookmark) {
    return bookmarksLib ? bookmarksLib.bookmarkPlace(bookmark) : '';
  }

  function currentFindBookmark() {
    if (!bookmarksLib || !state.bookId || state.index < 0) return null;
    const chapter = state.chapters[state.index];
    if (!chapter) return null;
    return bookmarksLib.findBookmark(state.findBookmarks, state.bookId, chapter.id);
  }

  function bookmarkIsCurrent(bookmark) {
    const chapter = state.chapters[state.index];
    return Boolean(
      bookmark && chapter && state.bookId && bookmark.bookId === state.bookId && bookmark.chapterId === chapter.id
    );
  }

  // 主进程回来的列表统一清洗一遍再进 state；渲染层不直接读写配置 / 文件。
  function setFindBookmarks(list) {
    state.findBookmarks = bookmarksLib
      ? bookmarksLib.sanitizeBookmarks(list)
      : Array.isArray(list)
        ? list
        : [];
    renderFindBookmarks();
    return state.findBookmarks;
  }

  function renderFindBookmarks() {
    const listEl = $('find-bookmark-list');
    if (!listEl) return;
    const countEl = $('find-bookmarks-count');
    const saveBtn = $('btn-find-bookmark');
    const current = currentFindBookmark();
    if (countEl) {
      const books = bookmarksLib ? bookmarksLib.countBooks(state.findBookmarks) : 0;
      countEl.textContent = state.findBookmarks.length
        ? `本机 ${state.findBookmarks.length} 个书签 · ${books} 本书`
        : '本机还没有书签';
    }
    if (saveBtn) {
      saveBtn.textContent = current ? '更新本章书签' : '存成书签';
      saveBtn.title = current
        ? `更新这一章的书签（现在是「${current.query}」；只写 config.json，不碰正文）`
        : '把当前章的查找词与大小写选项存成书签（只写 config.json，不碰正文）';
    }
    listEl.textContent = '';
    if (!state.findBookmarks.length) {
      const empty = document.createElement('div');
      empty.className = 'find-bookmark-empty';
      empty.textContent = '还没有书签。在当前章查一次，点右边「存成书签」就能保留；打开这一章会自动高亮。';
      listEl.appendChild(empty);
      return;
    }
    for (const bookmark of state.findBookmarks) {
      const row = document.createElement('div');
      row.className = 'find-bookmark';
      row.dataset.bookId = bookmark.bookId;
      row.dataset.chapterId = bookmark.chapterId;
      if (bookmarkIsCurrent(bookmark)) row.classList.add('current');

      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'find-bookmark-main';
      main.title = '跳到这本书的这一章，并按最新正文重新高亮书签里的查找词';
      const place = document.createElement('span');
      place.className = 'find-bookmark-place';
      place.textContent = bookmarkPlaceText(bookmark) + (bookmarkIsCurrent(bookmark) ? '（本章）' : '');
      const query = document.createElement('span');
      query.className = 'find-bookmark-query';
      query.textContent = `「${bookmark.query}」${bookmark.caseSensitive ? ' · 区分大小写' : ''}`;
      main.append(place, query);
      main.addEventListener('click', () => {
        void jumpToFindBookmark(bookmark);
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn ghost tiny find-bookmark-delete';
      del.textContent = '删除';
      del.title = '只删 config.json 里的这条书签，正文 / 书目 / 章节文件一个字节都不动';
      del.addEventListener('click', (event) => {
        event.stopPropagation();
        void deleteFindBookmark(bookmark);
      });
      row.append(main, del);
      listEl.appendChild(row);
    }
  }

  // 打开面板时从主进程重新取一次列表（多窗口 / 手改配置后也不会显示旧列表）。
  async function refreshFindBookmarks() {
    if (typeof api.listFindBookmarks !== 'function') return state.findBookmarks;
    const token = state.findBookmarkToken + 1;
    state.findBookmarkToken = token;
    try {
      const list = await call(api.listFindBookmarks);
      if (token !== state.findBookmarkToken) return state.findBookmarks;
      if (Array.isArray(list)) state.findBookmarks = bookmarksLib ? bookmarksLib.sanitizeBookmarks(list) : list;
    } catch {
      /* 取不到就先用内存里的；不影响查找 / 高亮 */
    }
    renderFindBookmarks();
    return state.findBookmarks;
  }

  // 「存成书签 / 更新书签」：当前章的查询词 + 大小写选项写进 config.json。
  async function saveFindBookmark() {
    const options = readFindOptions();
    if (!options.query.trim()) {
      $('find-summary').textContent = '先在查找框里输入内容，再存成书签';
      return { ok: false, code: 'EMPTY_QUERY' };
    }
    if (!state.bookPath || !state.bookId || state.index < 0) {
      toast('先打开一本书、选好章节再存书签', 'warn');
      return { ok: false, code: 'NO_BOOK' };
    }
    const chapter = state.chapters[state.index];
    if (!chapter) return { ok: false, code: 'NO_CHAPTER' };
    const entry = {
      bookId: state.bookId,
      bookPath: state.bookPath,
      bookTitle: state.meta ? state.meta.title : '',
      chapterId: chapter.id,
      chapterName: chapter.name || '',
      chapterIndex: state.index + 1,
      query: options.query,
      caseSensitive: Boolean(options.caseSensitive)
    };
    try {
      const data = await call(api.saveFindBookmark, entry);
      const saved = data && data.bookmark ? data.bookmark : null;
      setFindBookmarks(data && Array.isArray(data.list) ? data.list : [entry]);
      $('find-summary').textContent =
        `已存成书签：${bookmarkPlaceText(saved || entry)}「${entry.query}」` +
        `${entry.caseSensitive ? '（区分大小写）' : ''}` +
        '。打开这一章会自动高亮；只写 config.json，正文 / 书目不动。';
      toast('已存成书签（只写 config.json，正文 / 书目不动）');
      // 已经查过同一组条件就直接标成书签会话；否则按当前正文扫一遍，让作者马上看到命中位置
      if (findSessionMatchesOptions({ query: entry.query, caseSensitive: entry.caseSensitive })) {
        state.find.fromBookmark = true;
        renderFindStatusChip();
      } else {
        await restoreFindBookmarkForCurrentChapter({ force: true });
      }
      renderFindBookmarks();
      renderFindStatusChip();
      return { ok: true, bookmark: saved, total: state.find.total };
    } catch (err) {
      $('find-summary').textContent = `存书签失败：${err.message}`;
      toast(`存书签失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  async function deleteFindBookmark(bookmark) {
    if (!bookmark) return { ok: false };
    try {
      const data = await call(api.removeFindBookmark, bookmark.bookId, bookmark.chapterId);
      setFindBookmarks(data && Array.isArray(data.list) ? data.list : []);
      if (state.find.fromBookmark && bookmarkIsCurrent(bookmark)) {
        clearFindSession();
        $('find-summary').textContent = `已删除本章书签「${bookmark.query}」，高亮已收起（正文 / 书目不动）`;
      } else {
        $('find-summary').textContent =
          `已删除书签「${bookmark.query}」（只删 config.json 里的记录，正文 / 书目不动）`;
      }
      toast('已删除书签（只删配置里的记录，正文 / 书目不动）');
      return { ok: true, list: state.findBookmarks };
    } catch (err) {
      toast(`删除书签失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  // 跳到书签所在的「书 + 章」：同一本书直接切章；别的书先确认还在书架里再打开。
  // 切章 / 开书后由 loadChapterAt 统一按最新正文重扫并高亮，所以这里不自己查。
  async function jumpToFindBookmark(bookmark) {
    if (!bookmark) return { ok: false };
    if (!state.bookPath) {
      toast('先打开一本书再跳书签', 'warn');
      return { ok: false, code: 'NO_BOOK' };
    }
    closeFindPanel();
    const sameBook =
      state.bookPath === bookmark.bookPath || (state.bookId && state.bookId === bookmark.bookId);
    if (sameBook) {
      const index = state.chapters.findIndex((chapter) => chapter.id === bookmark.chapterId);
      if (index < 0) {
        toast('这一章已经不存在了（书签还留着，可在查找面板里删除）', 'warn');
        return { ok: false, code: 'NO_CHAPTER' };
      }
      if (index !== state.index) {
        const switched = await switchChapter(index);
        if (!switched || switched.ok === false) return { ok: false, canceled: true };
      }
      const restored = await restoreFindBookmarkForCurrentChapter({ force: true, toastHint: true });
      return { ok: Boolean(restored && restored.ok), index, count: restored ? restored.count : 0 };
    }
    const known = (state.books || []).find((book) => book.path === bookmark.bookPath);
    if (!known) {
      toast('这本书已经不在书架里了（书签还留着，可在查找面板里删除）', 'warn');
      return { ok: false, code: 'BOOK_GONE' };
    }
    const opened = await openBookByPath(bookmark.bookPath, { chapterId: bookmark.chapterId });
    if (!opened) return { ok: false };
    const index = state.chapters.findIndex((chapter) => chapter.id === bookmark.chapterId);
    if (index < 0) {
      toast('这一章已经不存在了（书签还留着，可在查找面板里删除）', 'warn');
      return { ok: false, code: 'NO_CHAPTER' };
    }
    return { ok: true, index };
  }

  // 打开这一章 / 保存后：有书签就按编辑区里的最新正文重扫一遍并高亮。
  // 只读正文、只移动高亮层与选区，不改正文、不写盘；正文改到没有命中时书签仍保留。
  async function restoreFindBookmarkForCurrentChapter({ force = false, toastHint = false } = {}) {
    if (!bookmarksLib || state.view !== 'editor' || !state.bookPath || !state.bookId || state.index < 0) {
      return null;
    }
    const chapter = state.chapters[state.index];
    if (!chapter) return null;
    const bookmark = bookmarksLib.findBookmark(state.findBookmarks, state.bookId, chapter.id);
    if (!bookmark) {
      state.find.fromBookmark = false;
      return null;
    }
    if (
      !force &&
      state.find.total &&
      findSessionMatchesOptions({ query: bookmark.query, caseSensitive: bookmark.caseSensitive })
    ) {
      return { ok: true, already: true, count: state.find.total, bookmark };
    }
    const snapshot = editorEl.value;
    let res;
    try {
      res = await call(api.findAll, snapshot, bookmark.query, {
        caseSensitive: bookmark.caseSensitive
      });
    } catch (err) {
      return { ok: false, message: err.message, bookmark };
    }
    // 扫的过程中换了书 / 换了章 / 正文又改了：这次结果作废，别把旧位置画到新正文上
    if (!state.bookPath || !state.bookId || state.bookId !== bookmark.bookId) return null;
    const stillChapter = state.chapters[state.index];
    if (!stillChapter || stillChapter.id !== bookmark.chapterId || editorEl.value !== snapshot) return null;
    $('find-query').value = bookmark.query;
    $('find-case').checked = Boolean(bookmark.caseSensitive);
    renderFindBookmarks();
    if (!res || !res.count) {
      if (state.find.fromBookmark) clearFindSession();
      else state.find.fromBookmark = false;
      if (findPanelOpen()) {
        $('find-summary').textContent =
          `书签「${bookmark.query}」在最新正文里没有命中了（书签还在，改回来或删除即可）`;
      }
      if (toastHint) toast(`书签「${bookmark.query}」在最新正文里没有命中了（书签保留）`, 'warn');
      return { ok: false, code: 'NO_MATCH', bookmark, count: 0 };
    }
    state.find.fromBookmark = true;
    startFindSession(bookmark.query, bookmark.caseSensitive, res.matches, 0);
    if (findPanelOpen()) {
      $('find-summary').textContent =
        `书签「${bookmark.query}」：本章 ${res.count} 处，按最新正文重新定位` +
        `${res.truncated ? '（命中太多，只高亮当前附近一屏）' : ''}`;
    }
    if (toastHint) toast(`已按书签「${bookmark.query}」高亮本章 ${res.count} 处`);
    return {
      ok: true,
      bookmark,
      count: res.count,
      truncated: Boolean(res.truncated)
    };
  }

  // 事件绑定（与搬前 bindEvents() 里的查找书签块逐行一致；由渲染层在原位置调用一次）
  function setupFindBookmarkUi() {
    $('btn-find-bookmark').addEventListener('click', () => void saveFindBookmark());
  }


    return {
      renderFindBookmarks,
      refreshFindBookmarks,
      saveFindBookmark,
      deleteFindBookmark,
      jumpToFindBookmark,
      restoreFindBookmarkForCurrentChapter,
      setupFindBookmarkUi
    };
  }

  return { create: createFindBookmarkUi, REQUIRED_HOST };
});
