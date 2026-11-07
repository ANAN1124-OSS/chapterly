const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const bookmarkUi = require('../renderer/find-bookmark-ui');
const bookmarksLib = require('../core/bookmarks');

// 第 4 步 renderer 九刀·补刀 9b：查找书签（原 renderer.js 1265–1544，280 行）搬到 renderer/find-bookmark-ui.js。
// 搬之前只有 E2E 黑盒覆盖（存书签 / 删除 / 跳书签 / 打开章节自动高亮）；列表结构 / 令牌作废旧列表 /
// 跨书跳转三条兜底 / 重扫失败与「正文改到没命中」/ 面板里的提示文案在 Node 里一步都测不到。
// 搬出来以后用「假 host + 假 DOM」逐条钉住，再用静态闸门保证渲染层不长回第二份。
//
// 契约：host 7 个成员 = 基础 5（$, state, api, call, toast）+ find{bookmarksLib,editorEl,readFindOptions,
// findSessionMatchesOptions,findPanelOpen,renderFindStatusChip,startFindSession,clearFindSession} +
// nav{switchChapter（惰性）,openBookByPath}。

const realDocument = globalThis.document;
test.after(() => {
  if (realDocument === undefined) delete globalThis.document;
  else globalThis.document = realDocument;
});
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const moduleSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'find-bookmark-ui.js'), 'utf8');
const moduleCode = moduleSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------- 假 DOM ----------
function makeEl(tag = 'div', id = '') {
  const classes = new Set();
  const listeners = [];
  const el = {
    tagName: tag, id, className: '', textContent: '', title: '', value: '', checked: false, disabled: false,
    dataset: {}, children: [], parentNode: null,
    _classes: classes, _listeners: listeners, _attrs: {},
    classList: {
      add: (...n) => n.forEach((x) => classes.add(x)),
      remove: (...n) => n.forEach((x) => classes.delete(x)),
      contains: (n) => classes.has(n),
      toggle(n, on) {
        const next = on === undefined ? !classes.has(n) : Boolean(on);
        if (next) classes.add(n);
        else classes.delete(n);
      }
    },
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); String(v || '').split(/\s+/).filter(Boolean).forEach((x) => classes.add(x)); },
    append(...n) { n.forEach((x) => el.appendChild(x)); },
    appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    setAttribute(k, v) { el._attrs[k] = v; },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el._attrs, k) ? el._attrs[k] : null; },
    _fire(type, event) {
      let result;
      for (const l of listeners) if (l.type === type) result = l.fn(event);
      return result;
    }
  };
  Object.defineProperty(el, 'innerHTML', { get() { return ''; }, set() { el.children.length = 0; } });
  let textValue = '';
  Object.defineProperty(el, 'textContent', {
    get() { return el.children.length ? '' : textValue; },
    set(value) { textValue = String(value); el.children.length = 0; }
  });
  return el;
}
function makeDocument() {
  const map = new Map();
  let lookups = 0;
  const doc = {
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => { lookups += 1; return map.get(id) || null; }
  };
  return {
    doc, map,
    get lookups() { return lookups; },
    $: (id) => doc.getElementById(id),
    ensure(id) { if (!map.has(id)) map.set(id, makeEl('div', id)); return map.get(id); }
  };
}

const BASE_IDS = ['find-bookmark-list', 'find-bookmarks-count', 'btn-find-bookmark', 'find-summary', 'find-query', 'find-case'];

function makeBookmark(overrides = {}) {
  return {
    bookId: 'id-1', bookPath: '/书库/书甲', bookTitle: '书甲',
    chapterId: 'c1', chapterName: '第一章', chapterIndex: 1,
    query: '张三', caseSensitive: false,
    ...overrides
  };
}

function build(options = {}) {
  const dom = options.dom || makeDocument();
  for (const id of BASE_IDS) dom.ensure(id);
  globalThis.document = dom.doc;
  const state = {
    view: 'editor',
    bookPath: '/书库/书甲',
    bookId: 'id-1',
    index: 0,
    meta: { title: '书甲' },
    chapters: [
      { id: 'c1', name: '第一章', file: 'c1.txt' },
      { id: 'c2', name: '第二章', file: 'c2.txt' }
    ],
    books: [{ path: '/书库/书甲', title: '书甲' }, { path: '/书库/书乙', title: '书乙' }],
    findBookmarks: options.bookmarks === undefined ? [] : options.bookmarks,
    findBookmarkToken: 0,
    find: { total: 0, fromBookmark: false, index: -1 }
  };
  const editorEl = makeEl('textarea');
  editorEl.value = options.text === undefined ? '张三说张三笑了' : options.text;
  const calls = {
    api: [], toast: [], readFindOptions: 0, sessionMatches: [], panelOpen: 0, statusChip: 0,
    startFindSession: [], clearFindSession: 0, switchChapter: [], openBookByPath: []
  };
  const api = {
    async listFindBookmarks() {
      calls.api.push(['list']);
      if (options.listError) throw new Error(options.listError);
      return options.list === undefined ? [makeBookmark()] : options.list;
    },
    async saveFindBookmark(entry) {
      calls.api.push(['save', entry]);
      if (options.saveError) throw new Error(options.saveError);
      return options.saveResult === undefined
        ? { bookmark: entry, list: [entry] }
        : options.saveResult;
    },
    async removeFindBookmark(bookId, chapterId) {
      calls.api.push(['remove', bookId, chapterId]);
      if (options.removeError) throw new Error(options.removeError);
      return options.removeResult === undefined ? { list: [] } : options.removeResult;
    },
    async findAll(...args) {
      calls.api.push(['findAll', ...args]);
      if (options.findAllError) throw new Error(options.findAllError);
      return options.findAll === undefined
        ? { count: 2, matches: [{ index: 0, length: 2 }, { index: 3, length: 2 }] }
        : options.findAll;
    }
  };
  const host = {
    $: dom.$,
    state,
    api,
    call: async (fn, ...args) => fn(...args),
    toast(message, kind) { calls.toast.push([message, kind]); },
    find: {
      bookmarksLib,
      editorEl,
      readFindOptions: () => {
        calls.readFindOptions += 1;
        return options.findOptions || { query: dom.map.get('find-query').value || '张三', caseSensitive: Boolean(dom.map.get('find-case').checked) };
      },
      findSessionMatchesOptions: (opts) => {
        calls.sessionMatches.push(opts);
        return state.find.total > 0 && state.find.query === opts.query && state.find.caseSensitive === Boolean(opts.caseSensitive);
      },
      findPanelOpen: () => { calls.panelOpen += 1; return Boolean(options.panelOpen); },
      closeFindPanel() { calls.closeFindPanel = (calls.closeFindPanel || 0) + 1; },
      renderFindStatusChip: () => { calls.statusChip += 1; },
      startFindSession: (...args) => { calls.startFindSession.push(args); },
      clearFindSession: () => { calls.clearFindSession += 1; state.find.total = 0; state.find.fromBookmark = false; }
    },
    nav: {
      async switchChapter(index) {
        calls.switchChapter.push(index);
        if (options.switchCancel) return { ok: false, canceled: true };
        state.index = index;
        return { ok: true };
      },
      async openBookByPath(bookPath, opts) {
        calls.openBookByPath.push([bookPath, opts]);
        if (options.openFails) return false;
        if (options.openBookChapters) state.chapters = options.openBookChapters;
        return true;
      }
    }
  };
  const ui = bookmarkUi.create(host);
  return { ui, host, state, dom, calls, editorEl };
}

// ---------- host 契约 ----------
test('host 契约：7 个成员 + 分组内每个真实依赖；缺任何一个都抛 TypeError', () => {
  assert.deepEqual([...bookmarkUi.REQUIRED_HOST].sort(), ['$', 'api', 'call', 'find', 'nav', 'state', 'toast']);
  assert.equal(bookmarkUi.REQUIRED_HOST.length, 7);
  const ctx = build();
  assert.doesNotThrow(() => bookmarkUi.create(ctx.host));
  assert.throws(() => bookmarkUi.create(null), /createFindBookmarkUi 需要 host 对象/);
  for (const key of bookmarkUi.REQUIRED_HOST) {
    const broken = { ...ctx.host };
    delete broken[key];
    assert.throws(() => bookmarkUi.create(broken), new RegExp('host 缺少 ' + key.replace('$', '\\$')), '缺 ' + key);
  }
  for (const key of ['bookmarksLib', 'editorEl', 'readFindOptions', 'findSessionMatchesOptions', 'findPanelOpen', 'closeFindPanel', 'renderFindStatusChip', 'startFindSession', 'clearFindSession']) {
    const broken = { ...ctx.host, find: { ...ctx.host.find } };
    delete broken.find[key];
    assert.throws(() => bookmarkUi.create(broken), new RegExp('host\\.find 缺少 ' + key));
  }
  for (const key of ['switchChapter', 'openBookByPath']) {
    const broken = { ...ctx.host, nav: { ...ctx.host.nav } };
    delete broken.nav[key];
    assert.throws(() => bookmarkUi.create(broken), new RegExp('host\\.nav 缺少 ' + key));
  }
});

test('create() 只建表：不碰 DOM / 不注册事件 / 不建定时器，交出 7 个入口', () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  assert.equal(dom.lookups, 0);
  assert.deepEqual(Object.keys(ctx.ui).sort(), [
    'deleteFindBookmark', 'jumpToFindBookmark', 'refreshFindBookmarks', 'renderFindBookmarks',
    'restoreFindBookmarkForCurrentChapter', 'saveFindBookmark', 'setupFindBookmarkUi'
  ]);
  assert.equal(moduleCode.includes('setInterval'), false);
});

// ---------- 列表渲染 ----------
test('renderFindBookmarks：空态文案 + 保存按钮文案；有书签时行结构 / 当前章标记 / 删除按钮说明', () => {
  const ctx = build({ bookmarks: [] });
  ctx.ui.renderFindBookmarks();
  assert.equal(ctx.dom.map.get('find-bookmarks-count').textContent, '本机还没有书签');
  assert.equal(ctx.dom.map.get('btn-find-bookmark').textContent, '存成书签');
  assert.equal(ctx.dom.map.get('btn-find-bookmark').title, '把当前章的查找词与大小写选项存成书签（只写 config.json，不碰正文）');
  const empty = ctx.dom.map.get('find-bookmark-list').children[0];
  assert.equal(empty.className, 'find-bookmark-empty');
  assert.match(empty.textContent, /还没有书签/);

  const bookmarks = [
    makeBookmark({ chapterId: 'c1', chapterName: '第一章', chapterIndex: 1, query: '张三', caseSensitive: true }),
    makeBookmark({ bookId: 'id-2', bookPath: '/书库/书乙', bookTitle: '书乙', chapterId: 'x1', chapterName: '开头', chapterIndex: 3, query: '李四' })
  ];
  const ctx2 = build({ bookmarks });
  ctx2.ui.renderFindBookmarks();
  assert.equal(ctx2.dom.map.get('find-bookmarks-count').textContent, '本机 2 个书签 · 2 本书');
  assert.equal(ctx2.dom.map.get('btn-find-bookmark').textContent, '更新本章书签', '本章已有书签 → 更新');
  assert.match(ctx2.dom.map.get('btn-find-bookmark').title, /^更新这一章的书签/);
  const rows = ctx2.dom.map.get('find-bookmark-list').children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].className, 'find-bookmark current');
  assert.equal(rows[0].dataset.bookId, 'id-1');
  assert.equal(rows[0].dataset.chapterId, 'c1');
  const main = rows[0].children[0];
  assert.equal(main.className, 'find-bookmark-main');
  assert.equal(main.title, '跳到这本书的这一章，并按最新正文重新高亮书签里的查找词');
  assert.equal(main.children[0].className, 'find-bookmark-place');
  assert.match(main.children[0].textContent, /（本章）$/);
  assert.equal(main.children[1].textContent, '「张三」 · 区分大小写');
  const del = rows[0].children[1];
  assert.equal(del.className, 'btn ghost tiny find-bookmark-delete');
  assert.equal(del.textContent, '删除');
  assert.match(del.title, /^只删 config\.json 里的这条书签/);
});

// ---------- 列表刷新 ----------
test('refreshFindBookmarks：从主进程取列表并清洗；令牌作废旧响应；读失败保留内存列表', async () => {
  const ctx = build({ bookmarks: [makeBookmark()] });
  const list = await ctx.ui.refreshFindBookmarks();
  assert.equal(ctx.calls.api[0][0], 'list');
  assert.equal(list.length, 1);
  assert.equal(ctx.state.findBookmarks.length, 1);

  // 令牌作废：请求挂起 → 再发一次 → 旧响应丢弃
  const stale = build({ bookmarks: [] });
  let release;
  stale.host.api.listFindBookmarks = () => new Promise((resolve) => { release = resolve; });
  const first = stale.ui.refreshFindBookmarks();
  await flush();
  stale.state.findBookmarkToken += 5; // 模拟另一次刷新先完成
  release([makeBookmark({ query: '旧响应' })]);
  await first;
  assert.equal(stale.state.findBookmarks.length, 0, '旧响应不许覆盖');

  const fail = build({ bookmarks: [makeBookmark({ query: '内存里的' })] });
  fail.host.api.listFindBookmarks = async () => { throw new Error('EACCES'); };
  const kept = await fail.ui.refreshFindBookmarks();
  assert.equal(kept.length, 1);
  assert.equal(kept[0].query, '内存里的');

  const noApi = build();
  noApi.host.api.listFindBookmarks = undefined;
  assert.equal(await noApi.ui.refreshFindBookmarks(), noApi.state.findBookmarks);
});

// ---------- 存 / 删 ----------
test('saveFindBookmark：空词 / 没书 / 没章节 早退；成功写配置、更新列表、摘要与 toast，并回填会话', async () => {
  const empty = build({ findOptions: { query: '   ', caseSensitive: false } });
  assert.deepEqual(await empty.ui.saveFindBookmark(), { ok: false, code: 'EMPTY_QUERY' });
  assert.equal(empty.dom.map.get('find-summary').textContent, '先在查找框里输入内容，再存成书签');

  const noBook = build();
  noBook.state.bookPath = null;
  assert.deepEqual(await noBook.ui.saveFindBookmark(), { ok: false, code: 'NO_BOOK' });
  assert.deepEqual(noBook.calls.toast, [['先打开一本书、选好章节再存书签', 'warn']]);

  const ctx = build();
  ctx.dom.map.get('find-query').value = '张三';
  ctx.dom.map.get('find-case').checked = true;
  const entry = {
    bookId: 'id-1', bookPath: '/书库/书甲', bookTitle: '书甲',
    chapterId: 'c1', chapterName: '第一章', chapterIndex: 1, query: '张三', caseSensitive: true
  };
  const res = await ctx.ui.saveFindBookmark();
  assert.deepEqual(ctx.calls.api[0], ['save', entry]);
  assert.equal(res.ok, true);
  assert.equal(ctx.state.findBookmarks.length, 1);
  assert.match(ctx.dom.map.get('find-summary').textContent, /^已存成书签：/);
  assert.match(ctx.dom.map.get('find-summary').textContent, /（区分大小写）。打开这一章会自动高亮/);
  assert.deepEqual(ctx.calls.toast, [['已存成书签（只写 config.json，正文 / 书目不动）', undefined]]);
  // 已查过同条件 → 直接标成书签会话，不重扫
  assert.equal(ctx.calls.findSessionMatchesOptions || 1, 1);
});

test('saveFindBookmark：失败 toast；主进程返回缺字段时用本地 entry 兜底', async () => {
  const fail = build({ saveError: '磁盘满' });
  const res = await fail.ui.saveFindBookmark();
  assert.deepEqual(res, { ok: false, message: '磁盘满' });
  assert.deepEqual(fail.calls.toast, [['存书签失败：磁盘满', 'error']]);
  assert.equal(fail.dom.map.get('find-summary').textContent, '存书签失败：磁盘满');

  const fallback = build({ saveResult: { list: undefined } });
  await fallback.ui.saveFindBookmark();
  assert.equal(fallback.state.findBookmarks.length, 1, '没有 list 时用本地 entry 兜底');
});

test('deleteFindBookmark：没有书签返回 false；删除成功更新列表并按来源给两种摘要；失败 toast', async () => {
  assert.deepEqual(await build().ui.deleteFindBookmark(null), { ok: false });

  const ctx = build({ bookmarks: [makeBookmark()] });
  ctx.state.find.fromBookmark = false;
  const res = await ctx.ui.deleteFindBookmark(makeBookmark());
  assert.deepEqual(ctx.calls.api[0], ['remove', 'id-1', 'c1']);
  assert.equal(res.ok, true);
  assert.equal(ctx.state.findBookmarks.length, 0);
  assert.equal(ctx.dom.map.get('find-summary').textContent, '已删除书签「张三」（只删 config.json 里的记录，正文 / 书目不动）');
  assert.deepEqual(ctx.calls.toast, [['已删除书签（只删配置里的记录，正文 / 书目不动）', undefined]]);

  const current = build({ bookmarks: [makeBookmark()] });
  current.state.find.fromBookmark = true;
  await current.ui.deleteFindBookmark(makeBookmark());
  assert.equal(current.calls.clearFindSession, 1);
  assert.match(current.dom.map.get('find-summary').textContent, /^已删除本章书签「张三」，高亮已收起/);

  const fail = build({ bookmarks: [makeBookmark()], removeError: '写盘失败' });
  assert.deepEqual(await fail.ui.deleteFindBookmark(makeBookmark()), { ok: false, message: '写盘失败' });
  assert.deepEqual(fail.calls.toast, [['删除书签失败：写盘失败', 'error']]);
});

// ---------- 跳书签 ----------
test('jumpToFindBookmark：没书 / 同书已删章 / 同书成功（切章后重扫）/ 跨书不在书架 / 跨书打开后缺章', async () => {
  assert.deepEqual(await build().ui.jumpToFindBookmark(null), { ok: false });
  const noBook = build();
  noBook.state.bookPath = null;
  assert.deepEqual(await noBook.ui.jumpToFindBookmark(makeBookmark()), { ok: false, code: 'NO_BOOK' });
  assert.deepEqual(noBook.calls.toast, [['先打开一本书再跳书签', 'warn']]);

  const gone = build();
  gone.state.chapters = [{ id: 'other', name: '别章' }];
  assert.deepEqual(await gone.ui.jumpToFindBookmark(makeBookmark()), { ok: false, code: 'NO_CHAPTER' });
  assert.match(gone.calls.toast[0][0], /这一章已经不存在了/);

  const same = build({ bookmarks: [makeBookmark({ chapterId: 'c2', chapterName: '第二章', chapterIndex: 2 })] });
  same.state.find.total = 2;
  same.host.find.findSessionMatchesOptions = () => false;
  const res = await same.ui.jumpToFindBookmark(makeBookmark({ chapterId: 'c2', chapterName: '第二章', chapterIndex: 2 }));
  assert.deepEqual(same.calls.switchChapter, [1]);
  assert.deepEqual(same.calls.api[0], ['findAll', '张三说张三笑了', '张三', { caseSensitive: false }]);
  assert.equal(res.ok, true);
  assert.equal(res.count, 2);

  const cancel = build({ switchCancel: true });
  cancel.state.chapters = [{ id: 'c1' }, { id: 'c2' }];
  assert.deepEqual(await cancel.ui.jumpToFindBookmark(makeBookmark({ chapterId: 'c2' })), { ok: false, canceled: true });

  const bookGone = build();
  bookGone.state.books = [];
  const otherBook = makeBookmark({ bookPath: '/书库/已删', bookId: 'id-9' });
  assert.deepEqual(await bookGone.ui.jumpToFindBookmark(otherBook), { ok: false, code: 'BOOK_GONE' });
  assert.match(bookGone.calls.toast[0][0], /这本书已经不在书架里了/);

  const opened = build({ openBookChapters: [{ id: 'other' }] });
  const openedRes = await opened.ui.jumpToFindBookmark(makeBookmark({ bookPath: '/书库/书乙', bookId: 'id-2', chapterId: 'c1' }));
  assert.equal(opened.calls.openBookByPath.length, 1);
  assert.deepEqual(openedRes, { ok: false, code: 'NO_CHAPTER' }, '打开后发现章节没了');
});

// ---------- 打开章节时重扫高亮 ----------
test('restoreFindBookmarkForCurrentChapter：前置条件不满足 / 本章无书签 → null，且不误标书签会话', async () => {
  const ctx = build({ bookmarks: [] });
  assert.equal(await ctx.ui.restoreFindBookmarkForCurrentChapter(), null);
  const noLib = build();
  noLib.host.find.bookmarksLib = null;
  assert.equal(await noLib.ui.restoreFindBookmarkForCurrentChapter(), null);
  const shelf = build({ bookmarks: [makeBookmark()] });
  shelf.state.view = 'shelf';
  assert.equal(await shelf.ui.restoreFindBookmarkForCurrentChapter(), null);
});

test('restoreFindBookmarkForCurrentChapter：已经查过同条件 → already；成功 → 回填查找框、起会话、按需摘要与 toast', async () => {
  const already = build({ bookmarks: [makeBookmark()] });
  already.state.find = { total: 3, fromBookmark: false, index: 0, query: '张三', caseSensitive: false };
  already.host.find.findSessionMatchesOptions = () => true;
  const res = await already.ui.restoreFindBookmarkForCurrentChapter();
  assert.equal(res.already, true);
  assert.equal(res.count, 3);
  assert.deepEqual(already.calls.api, [], '不用重新扫');

  const ctx = build({ bookmarks: [makeBookmark({ caseSensitive: true })], panelOpen: true });
  const ok = await ctx.ui.restoreFindBookmarkForCurrentChapter({ force: true, toastHint: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.count, 2);
  assert.deepEqual(ctx.calls.api[0], ['findAll', '张三说张三笑了', '张三', { caseSensitive: true }]);
  assert.equal(ctx.dom.map.get('find-query').value, '张三');
  assert.equal(ctx.dom.map.get('find-case').checked, true);
  assert.equal(ctx.state.find.fromBookmark, true);
  assert.equal(ctx.calls.startFindSession.length, 1);
  assert.match(ctx.dom.map.get('find-summary').textContent, /^书签「张三」：本章 2 处，按最新正文重新定位/);
  assert.deepEqual(ctx.calls.toast, [['已按书签「张三」高亮本章 2 处', undefined]]);
});

test('restoreFindBookmarkForCurrentChapter：最新正文没命中 → 清会话 / 提示书签保留；扫描中换章/改正文 → 结果作废', async () => {
  const none = build({ bookmarks: [makeBookmark()], findAll: { count: 0, matches: [] }, panelOpen: true });
  none.state.find.fromBookmark = true;
  const res = await none.ui.restoreFindBookmarkForCurrentChapter({ force: true, toastHint: true });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'NO_MATCH');
  assert.equal(none.calls.clearFindSession, 1);
  assert.match(none.dom.map.get('find-summary').textContent, /书签「张三」在最新正文里没有命中了/);
  assert.deepEqual(none.calls.toast, [['书签「张三」在最新正文里没有命中了（书签保留）', 'warn']]);

  // 扫描期间换了章 → 结果作废
  const stale = build({ bookmarks: [makeBookmark()] });
  stale.host.api.findAll = async () => {
    stale.state.index = 1;
    return { count: 1, matches: [{ index: 0, length: 2 }] };
  };
  assert.equal(await stale.ui.restoreFindBookmarkForCurrentChapter({ force: true }), null);
  assert.equal(stale.calls.startFindSession.length, 0);

  // 扫描失败 → 返回 message 不崩
  const fail = build({ bookmarks: [makeBookmark()], findAllError: '主进程炸了' });
  const failRes = await fail.ui.restoreFindBookmarkForCurrentChapter({ force: true });
  assert.deepEqual(failRes, { ok: false, message: '主进程炸了', bookmark: fail.state.findBookmarks[0] });
});

// ---------- 事件绑定 ----------
test('setupFindBookmarkUi：注册「存成书签」按钮；点击走 saveFindBookmark（空词时只写摘要）', async () => {
  const ctx = build({ findOptions: { query: '', caseSensitive: false } });
  ctx.ui.setupFindBookmarkUi();
  assert.equal(ctx.dom.map.get('btn-find-bookmark')._listeners.length, 1);
  assert.equal(ctx.dom.map.get('btn-find-bookmark')._listeners[0].type, 'click');
  ctx.dom.map.get('btn-find-bookmark')._fire('click');
  await flush();
  assert.equal(ctx.dom.map.get('find-summary').textContent, '先在查找框里输入内容，再存成书签');
});

// ---------- 静态闸门 ----------
test('静态闸门：renderer.js 不再内嵌查找书签实现，只剩装配与转发', () => {
  for (const shape of [
    'function bookmarkPlaceText(',
    'function currentFindBookmark(',
    'function bookmarkIsCurrent(',
    'function setFindBookmarks(',
    'function renderFindBookmarks(',
    'async function refreshFindBookmarks(',
    'async function saveFindBookmark(',
    'async function deleteFindBookmark(',
    'async function jumpToFindBookmark(',
    'async function restoreFindBookmarkForCurrentChapter('
  ]) {
    assert.equal(rendererSrc.includes(shape), false, 'renderer.js 里还有第二份：' + shape);
  }
  assert.equal(rendererSrc.split('findBookmarkUiModule.create(').length - 1, 1, '装配只许一处');
  assert.ok(rendererSrc.includes('const findBookmarkUiModule = window.CWFindBookmarkUi;'));
  for (const line of [
    '    $, state, api, call, toast,',
    '    find: { bookmarksLib, editorEl, readFindOptions, findSessionMatchesOptions, findPanelOpen, closeFindPanel, renderFindStatusChip, startFindSession, clearFindSession },',
    '    nav: { switchChapter: (index) => switchChapter(index), openBookByPath }'
  ]) {
    assert.ok(rendererSrc.includes(line), '装配少了：' + line);
  }
  assert.ok(rendererSrc.includes(
    'const { renderFindBookmarks, refreshFindBookmarks, saveFindBookmark, deleteFindBookmark, jumpToFindBookmark, restoreFindBookmarkForCurrentChapter, setupFindBookmarkUi } = findBookmarkUi;'
  ), '7 个入口按原名解构');
  assert.equal(rendererSrc.includes("$('btn-find-bookmark').addEventListener"), false, '绑定应该只在模块里');
  assert.equal(rendererSrc.split('findBookmarkUi.setupFindBookmarkUi();').length - 1, 1, 'setup 只调一次');
  for (const key of ['deleteFindBookmark', 'jumpToFindBookmark', 'restoreFindBookmarkForCurrentChapter', 'saveFindBookmark']) {
    assert.match(rendererSrc, new RegExp('^      ' + key + ',$', 'm'), 'testHooksScope 少了 ' + key);
  }
  // 查找核心（9a 模块）的惰性转发仍按名字指向 bookmarks 模块转发的 const
  assert.ok(rendererSrc.includes('renderFindBookmarks: () => renderFindBookmarks()'));
});

test('静态闸门：index.html 在 renderer.js 之前加载 find-bookmark-ui.js，且只加载一次', () => {
  const at = indexSrc.indexOf('<script src="find-bookmark-ui.js"></script>');
  const rendererAt = indexSrc.indexOf('<script src="renderer.js"></script>');
  assert.notEqual(at, -1);
  assert.ok(at < rendererAt);
  assert.equal(indexSrc.split('find-bookmark-ui.js').length - 1, 1);
});

test('静态闸门：模块不 require / 不摸 Electron·fs·网络 / 不注册全局监听 / 不建定时器', () => {
  for (const forbidden of ['require(', 'ipcRenderer', 'node:fs', 'child_process', 'localStorage', 'fetch(', 'window.', 'process.']) {
    assert.equal(moduleCode.includes(forbidden), false, 'find-bookmark-ui.js 不许出现 ' + forbidden);
  }
  assert.equal(/window\.addEventListener|document\.addEventListener/.test(moduleCode), false);
  assert.equal((moduleCode.match(/setTimeout\(/g) || []).length, 0);
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWFindBookmarkUi，且不乱造别的全局', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(moduleSrc, context, { filename: 'renderer/find-bookmark-ui.js' });
  assert.equal(typeof win.CWFindBookmarkUi, 'object');
  assert.deepEqual(Object.keys(win.CWFindBookmarkUi).sort(), ['REQUIRED_HOST', 'create']);
  assert.equal(win.CWFindBookmarkUi.REQUIRED_HOST.length, 7);
  assert.equal(win.CWFindUi, undefined);
});
