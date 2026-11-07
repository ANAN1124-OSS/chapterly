/* 书架正文搜索（v0.9 B-5 第八刀：从 renderer.js 的「书架正文搜索」分区整段搬出来）。
 *
 * 搬走的段（原 renderer.js 960–1044，85 行，含分区注释）——正文搜索的异步链路：
 *   resetShelfContent（清结果 / 清防抖定时器 / token+1，可选保不保留查询）·
 *   scheduleContentSearch（320ms 防抖，重新查询时令牌自增）·
 *   runContentSearch（主进程 search:content，旧响应按令牌丢弃）·
 *   expandContentChapter（P22-4：只带书 + 章两个定位字段，请主进程只读这一章、返回该章全部命中；
 *   旧响应 / 换查询 / 离开书架 / 已收起都整包丢弃）·
 *   ensureSearchIndex（让主进程校验 / 增量更新索引，失败静默返回 null）·
 *   openContentResult（带 chapterId / matchIndex / matchLength 打开命中章节）。
 * 索引在主进程，界面只收结果：本模块**绝不读正文、不写盘、不改 config / 数据格式 / IPC 白名单**。
 * **只搬不改行为**：防抖 320ms、单次上限 40 条、每次多显示 8 条、令牌旧响应丢弃、
 * 只有 state.view === 'shelf' 时才渲染 —— 全部照旧；展开一章不动这四条（focus 走同一个 IPC）。
 *
 * 契约：createShelfSearchUi(host) 由渲染层调用一次，host 提供：
 *   host = {
 *     state, renderShelfContent, renderShelf, shelfQueryText, shelfContentActive,
 *     call, api, openBookByPath,
 *     CONTENT_PAGE_SIZE, CONTENT_SEARCH_DEBOUNCE, CONTENT_RESULT_LIMIT
 *   }
 * 缺任何一个直接抛 TypeError（宁可在启动时炸，也不要到敲搜索框 / 切视图时 ReferenceError）。
 * host 成员全是一次性解构的稳定引用；它们在渲染层都是函数声明（会提升）或先于装配点的 const。
 *
 * 不搬的（刻意留在 renderer.js）：书架搜索的内存过滤 / 结果渲染（renderShelfContent 还在「书架搜索」
 * 分区）、输入框与「显示更多」的事件绑定（仍在事件绑定段）、测试钩子宿主契约段——三处都按原名取
 * 本模块交出的 4 个入口。create() 不注册任何事件、不碰 DOM、不建定时器。
 * runContentSearch 是内部件（区外 0 引用），不导出（导出会让 sweep ⑤ 新增一条无消费者导出）。
 *
 * 浏览器里挂成全局 CWShelfSearchUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWShelfSearchUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HOST = ['state', 'renderShelfContent', 'renderShelf', 'shelfQueryText', 'shelfContentActive', 'call', 'api', 'openBookByPath', 'CONTENT_PAGE_SIZE', 'CONTENT_SEARCH_DEBOUNCE', 'CONTENT_RESULT_LIMIT'];

  function createShelfSearchUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createShelfSearchUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) {
        throw new TypeError('createShelfSearchUi 的 host 缺少 ' + key);
      }
    }
    const { state, renderShelfContent, renderShelf, shelfQueryText, shelfContentActive, call, api, openBookByPath, CONTENT_PAGE_SIZE, CONTENT_SEARCH_DEBOUNCE, CONTENT_RESULT_LIMIT } = host;
  // ---------- 书架正文搜索（提案 7.3：索引在主进程，绝不读正文到界面） ----------
  function resetShelfContent(keepQuery = false) {
    const content = state.shelfContent;
    content.token += 1;
    if (content.timer) {
      clearTimeout(content.timer);
      content.timer = null;
    }
    content.loading = false;
    content.results = [];
    content.meta = null;
    content.error = null;
    content.shown = CONTENT_PAGE_SIZE;
    content.expanded = {};
    if (!keepQuery) content.query = '';
    renderShelfContent();
  }

  function scheduleContentSearch() {
    const content = state.shelfContent;
    if (content.timer) {
      clearTimeout(content.timer);
      content.timer = null;
    }
    content.token += 1;
    const token = content.token;
    const query = shelfQueryText();
    if (!shelfContentActive()) {
      resetShelfContent(true);
      return;
    }
    content.query = query;
    content.loading = true;
    content.results = [];
    content.meta = null;
    content.error = null;
    content.shown = CONTENT_PAGE_SIZE;
    content.expanded = {};
    renderShelfContent();
    content.timer = setTimeout(() => {
      content.timer = null;
      void runContentSearch(query, token);
    }, CONTENT_SEARCH_DEBOUNCE);
  }

  async function runContentSearch(query, token) {
    const content = state.shelfContent;
    try {
      const data = await call(api.searchContent, query, { limit: CONTENT_RESULT_LIMIT });
      if (token !== content.token || state.view !== 'shelf') return;
      content.loading = false;
      content.results = Array.isArray(data.results) ? data.results : [];
      content.meta = data;
      content.error = null;
      content.expanded = {};
      content.indexStatus = data.index || content.indexStatus;
      renderShelf();
    } catch (err) {
      if (token !== content.token) return;
      content.loading = false;
      content.error = err.message;
      content.meta = null;
      content.expanded = {};
      renderShelf();
    }
  }

  // 展开一章的全部命中（P22-4）：只发「书 + 章」两个定位字段，正文仍只在主进程读；
  // 返回的每条结果都带 snippet / matchIndex，渲染层照旧点一条打开并定位。
  // 不做任何写盘 / IPC 扩展：复用 search:content，靠 options.focus 让主进程只读这一章。
  function contentGroupKey(row) {
    if (!row || typeof row !== 'object') return '';
    const bookPath = typeof row.bookPath === 'string' ? row.bookPath : '';
    const chapterFile = typeof row.chapterFile === 'string' ? row.chapterFile : '';
    if (!bookPath || !chapterFile) return '';
    return bookPath + '\u0000' + chapterFile;
  }

  async function expandContentChapter(row, options = {}) {
    const content = state.shelfContent;
    const key = contentGroupKey(row);
    if (!content || !key) return false;
    if (!content.expanded || typeof content.expanded !== 'object') content.expanded = {};
    if (options && options.collapse) {
      delete content.expanded[key];
      renderShelfContent();
      return true;
    }
    const existing = content.expanded[key];
    if (existing && Array.isArray(existing.rows) && existing.rows.length && !existing.loading) {
      renderShelfContent();
      return true;
    }
    const token = content.token;
    const query = content.query;
    const entry = { loading: true, rows: [], error: null, truncated: false };
    content.expanded[key] = entry;
    renderShelfContent();
    try {
      const data = await call(api.searchContent, query, {
        limit: CONTENT_RESULT_LIMIT,
        focus: { bookPath: row.bookPath, chapterFile: row.chapterFile }
      });
      // 旧响应 / 换了查询 / 已经离开书架 / 这一组已被收起：整包丢弃，不写 state、不渲染。
      if (token !== content.token || content.query !== query || state.view !== 'shelf') return false;
      if (!content.expanded || content.expanded[key] !== entry) return false;
      entry.loading = false;
      if (!data || data.focus !== true) {
        entry.error = (data && data.focusError) || '主进程没有返回本章结果';
      } else if (data.focusError) {
        entry.error = String(data.focusError);
      } else {
        entry.rows = Array.isArray(data.results) ? data.results : [];
        entry.truncated = Boolean(data.truncated);
      }
      renderShelfContent();
      return !entry.error;
    } catch (err) {
      if (token !== content.token || content.query !== query || state.view !== 'shelf') return false;
      if (!content.expanded || content.expanded[key] !== entry) return false;
      entry.loading = false;
      entry.error = err && err.message ? err.message : '展开失败';
      renderShelfContent();
      return false;
    }
  }

  async function ensureSearchIndex(options = {}) {
    try {
      const status = await call(api.ensureSearchIndex, {
        force: Boolean(options.force),
        deep: options.deep !== false
      });
      state.shelfContent.indexStatus = status;
      if (state.view === 'shelf') renderShelfContent();
      return status;
    } catch {
      return null; // 索引不可用不影响书架和搜索（正文结果会显示为空 / 提示）
    }
  }

  async function openContentResult(row) {
    if (!row || !row.bookPath) return;
    await openBookByPath(row.bookPath, {
      chapterId: row.chapterId,
      matchIndex: row.matchIndex,
      matchLength: row.matchLength
    });
  }

    return {
      resetShelfContent,
      scheduleContentSearch,
      ensureSearchIndex,
      openContentResult,
      expandContentChapter
    };
  }

  return { create: createShelfSearchUi, REQUIRED_HOST };
});
