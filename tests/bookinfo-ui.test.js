const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const bookinfoUi = require('../renderer/bookinfo-ui');
const bookInfoLib = require('../core/bookinfo');
const chaptersLib = require('../core/chapters');

// 第 4 步 renderer 九刀·第六刀：书籍信息（原 renderer.js 827–1141，315 行）搬到 renderer/bookinfo-ui.js。
// 这一域混着三件事：书籍信息弹层、书架渲染（书卡 / 分组筛选 / 空态）、新建书。
// 搬之前只有 E2E 黑盒覆盖（改书信息 / 点书卡 / 分组筛选 / 新建书）；书卡各字段、空态文案、
// 冲突徽标 / 修复按钮 / ⋯ 菜单坐标 / 保存成功 / 失败提示在 Node 里一步都测不到。
// 搬出来以后用「假 host + 假 DOM」逐条钉住，再用静态闸门保证渲染层不长回第二份。
//
// 契约：host 8 个成员 = 基础 5（$, state, api, call, toast）+ render{bookInfoLib,bookGroupOf,
// chapterTitle,formatChars,formatRelativeTime} + shelf{shelfGroupList,shelfQueryText,shelfSearchResults,
// updateShelfSearchUi,renderContinueWriting,renderShelfContent} + actions{openBookByPath,openBookAtChapter,
// openRepair,openConflictDialog,showBookMenu,updateWindowTitle,promptText,refreshShelf}。

const realDocument = globalThis.document;
test.after(() => {
  if (realDocument === undefined) delete globalThis.document;
  else globalThis.document = realDocument;
});

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const stylesSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'styles.css'), 'utf8');
const moduleSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'bookinfo-ui.js'), 'utf8');
const moduleCode = moduleSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------- 假 DOM ----------
function makeEl(tag = 'div', id = '') {
  const classes = new Set();
  const listeners = [];
  const el = {
    tagName: tag,
    id,
    className: '',
    _text: '',
    title: '',
    value: '',
    type: '',
    tabIndex: -1,
    dataset: {},
    children: [],
    parentNode: null,
    _classes: classes,
    _listeners: listeners,
    _attrs: {},
    _focus: 0,
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      contains: (n) => classes.has(n),
      toggle(n, on) {
        const next = on === undefined ? !classes.has(n) : Boolean(on);
        if (next) classes.add(n);
        else classes.delete(n);
      }
    },
    get className() { return [...classes].join(' '); },
    set className(value) {
      classes.clear();
      String(value || '').split(/\s+/).filter(Boolean).forEach((n) => classes.add(n));
    },
    append(...nodes) { nodes.forEach((n) => el.appendChild(n)); },
    appendChild(child) {
      if (child && child._isFragment) {
        child.children.slice().forEach((c) => el.appendChild(c));
        child.children.length = 0;
        return child;
      }
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    focus() { el._focus += 1; },
    setAttribute(name, value) { el._attrs[name] = value; },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(el._attrs, name) ? el._attrs[name] : null; },
    getBoundingClientRect() { return { right: 400, bottom: 300, top: 0, left: 0 }; },
    _fire(type, event) {
      let result;
      for (const l of listeners) if (l.type === type) result = l.fn(event);
      return result;
    }
  };
  Object.defineProperty(el, 'textContent', {
    // 真实 DOM 的口径：有子节点时读整棵子树的文本（命中行 = 文本前缀 + 每个章名按钮 + 分隔符）；
    // 没有子节点时读自己写入的字符串。setter 与浏览器一样会清空子节点。
    get() {
      if (el.children.length) {
        return el.children.map((child) => (child && child.textContent != null ? child.textContent : '')).join('');
      }
      return el._text;
    },
    set(value) {
      el._text = String(value == null ? '' : value);
      el.children.length = 0;
    }
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return ''; },
    set() { el.children.length = 0; }
  });
  return el;
}

function makeDocument() {
  const map = new Map();
  let lookups = 0;
  const doc = {
    createElement: (tag) => makeEl(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text == null ? '' : text), parentNode: null }),
    getElementById: (id) => { lookups += 1; return map.get(id) || null; }
  };
  return {
    doc,
    map,
    get lookups() { return lookups; },
    $: (id) => doc.getElementById(id),
    ensure(id) { if (!map.has(id)) map.set(id, makeEl('div', id)); return map.get(id); }
  };
}

const BASE_IDS = [
  'bookinfo-backdrop', 'bookinfo-book', 'bookinfo-author', 'bookinfo-group', 'bookinfo-tags',
  'bookinfo-brief', 'bookinfo-error', 'bookinfo-group-list',
  'books-root-label', 'book-grid', 'shelf-group-bar', 'shelf-group-filter',
  'btn-bookinfo-cancel', 'btn-bookinfo-save'
];

// 与 renderer.js 的 formatChars 逐字一致（拍板 #1：千分位；万 / 亿缩写的整数部分同样分组）
const { formatCount } = require('../core/common');
function formatScaledCount(scaled) {
  const [int, dec] = scaled.toFixed(2).split('.');
  return `${formatCount(int)}.${dec}`;
}
function formatChars(n) {
  const value = Math.max(0, Math.floor(Number(n) || 0));
  if (value < 10000) return `${formatCount(value)} 字`;
  if (value < 100000000) return `${formatScaledCount(value / 10000)} 万字`;
  return `${formatScaledCount(value / 100000000)} 亿字`;
}

function formatRelativeTime(ts) {
  return ts ? '今天 10:00' : '—';
}

function makeBook(overrides = {}) {
  return {
    path: '/书库/书甲',
    folder: '书甲',
    title: '书甲',
    status: 'ok',
    chapterCount: 3,
    totalChars: 1234,
    doneChapters: 1,
    lastModified: 1700000000000,
    conflicts: [],
    ...overrides
  };
}

function build(options = {}) {
  const dom = options.dom || makeDocument();
  for (const id of BASE_IDS) dom.ensure(id);
  dom.map.get('bookinfo-backdrop').classList.add('hidden');
  globalThis.document = dom.doc;
  const state = {
    books: options.books === undefined ? [makeBook()] : options.books,
    config: options.config === undefined ? { booksRoot: '/书库' } : options.config,
    shelfGroup: options.shelfGroup === undefined ? '' : options.shelfGroup,
    shelfContent: options.shelfContent === undefined ? { meta: null, loading: false } : options.shelfContent,
    bookInfoBook: null,
    meta: null
  };
  const calls = {
    updateBookInfo: [], createBook: [], pickFolder: [],
    toast: [], openBookByPath: [], openBookAtChapter: [], openRepair: [], openConflictDialog: [], showBookMenu: [],
    updateWindowTitle: 0, promptText: [], refreshShelf: 0,
    updateShelfSearchUi: [], renderContinueWriting: 0, renderShelfContent: 0
  };
  const api = {
    async updateBookInfo(...args) {
      calls.updateBookInfo.push(args);
      if (options.saveError) throw new Error(options.saveError);
      return { changed: options.changed === undefined ? true : options.changed };
    },
    async createBook(title) {
      calls.createBook.push(title);
      if (options.createError) throw new Error(options.createError);
      return { path: '/书库/新书', meta: { title } };
    }
  };
  const host = {
    $: dom.$,
    state,
    api,
    call: async (fn, ...args) => fn(...args),
    toast(message, kind) { calls.toast.push([message, kind]); },
    render: {
      bookInfoLib,
      bookGroupOf: (book) => bookInfoLib.readBookInfo(book).group,
      chapterTitle: (index, name) => chaptersLib.formatTitle(state.meta || null, index, name),
      formatChars,
      formatRelativeTime
    },
    shelf: {
      shelfGroupList: () => (options.groups === undefined ? ['第一个分组', '第二个分组'] : options.groups),
      shelfQueryText: () => (options.query === undefined ? '' : options.query),
      shelfSearchResults: () => (options.rows === undefined ? state.books.map((book) => ({ book, info: {} })) : options.rows),
      updateShelfSearchUi: (count) => calls.updateShelfSearchUi.push(count),
      renderContinueWriting: () => { calls.renderContinueWriting += 1; },
      renderShelfContent: () => { calls.renderShelfContent += 1; }
    },
    actions: {
      openBookByPath(path) { calls.openBookByPath.push(path); },
      openBookAtChapter(path, chapterIndex) { calls.openBookAtChapter.push([path, chapterIndex]); },
      openRepair(book) { calls.openRepair.push(book); },
      openConflictDialog(book) { calls.openConflictDialog.push(book); },
      showBookMenu(book, x, y) { calls.showBookMenu.push([book, x, y]); },
      updateWindowTitle() { calls.updateWindowTitle += 1; },
      async promptText(opts) { calls.promptText.push(opts); return options.promptValue === undefined ? null : options.promptValue; },
      async refreshShelf() { calls.refreshShelf += 1; }
    }
  };
  const ui = bookinfoUi.create(host);
  return { ui, host, state, dom, calls };
}

// ---------- host 契约 ----------
test('host 契约：8 个成员 + 分组内每个真实依赖；缺任何一个都抛 TypeError', () => {
  assert.deepEqual([...bookinfoUi.REQUIRED_HOST].sort(), ['$', 'actions', 'api', 'call', 'render', 'shelf', 'state', 'toast']);
  assert.equal(bookinfoUi.REQUIRED_HOST.length, 8);
  const ctx = build();
  assert.doesNotThrow(() => bookinfoUi.create(ctx.host));
  assert.throws(() => bookinfoUi.create(null), /createBookinfoUi 需要 host 对象/);
  for (const key of bookinfoUi.REQUIRED_HOST) {
    const broken = { ...ctx.host };
    delete broken[key];
    assert.throws(() => bookinfoUi.create(broken), new RegExp('host 缺少 ' + key.replace('$', '\\$')), '缺 ' + key);
  }
  for (const key of ['bookInfoLib', 'bookGroupOf', 'chapterTitle', 'formatChars', 'formatRelativeTime']) {
    const broken = { ...ctx.host, render: { ...ctx.host.render } };
    delete broken.render[key];
    assert.throws(() => bookinfoUi.create(broken), new RegExp('host\\.render 缺少 ' + key));
  }
  for (const key of ['shelfGroupList', 'shelfQueryText', 'shelfSearchResults', 'updateShelfSearchUi', 'renderContinueWriting', 'renderShelfContent']) {
    const broken = { ...ctx.host, shelf: { ...ctx.host.shelf } };
    delete broken.shelf[key];
    assert.throws(() => bookinfoUi.create(broken), new RegExp('host\\.shelf 缺少 ' + key));
  }
  for (const key of ['openBookByPath', 'openBookAtChapter', 'openRepair', 'openConflictDialog', 'showBookMenu', 'updateWindowTitle', 'promptText', 'refreshShelf']) {
    const broken = { ...ctx.host, actions: { ...ctx.host.actions } };
    delete broken.actions[key];
    assert.throws(() => bookinfoUi.create(broken), new RegExp('host\\.actions 缺少 ' + key));
  }
});

test('create() 只建表：不碰 DOM / 不注册事件 / 不建定时器，交出 7 个入口', () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  assert.equal(dom.lookups, 0, 'create() 一次 $ 都不该调');
  assert.deepEqual(Object.keys(ctx.ui).sort(), [
    'closeBookInfoDialog', 'createBookWithTitle', 'openBookInfoDialog', 'readBookInfoForm',
    'renderShelf', 'saveBookInfoDialog', 'setupBookinfoUi'
  ]);
  assert.equal(moduleCode.includes('setInterval'), false);
});

// ---------- 书籍信息弹层 ----------
test('openBookInfoDialog：没书 / 损坏书 直接拒绝；正常书填表、回填分组建议、显示弹层并聚焦作者', () => {
  const ctx = build();
  assert.equal(ctx.ui.openBookInfoDialog(null), false);
  assert.equal(ctx.ui.openBookInfoDialog({}), false);

  const corrupt = makeBook({ status: 'corrupt' });
  assert.equal(ctx.ui.openBookInfoDialog(corrupt), false);
  assert.deepEqual(ctx.calls.toast, [['这本书的书目损坏，先点「修复」再改书籍信息', 'warn']]);

  const book = makeBook({ meta: { author: '作者甲', group: '分组甲', tags: ['标签1', '标签2'], brief: '简介内容' } });
  const info = bookInfoLib.readBookInfo(book);
  assert.equal(ctx.ui.openBookInfoDialog(book), true);
  assert.equal(ctx.state.bookInfoBook, book);
  assert.equal(ctx.dom.map.get('bookinfo-book').textContent, '《书甲》');
  assert.equal(ctx.dom.map.get('bookinfo-book').title, '/书库/书甲');
  assert.equal(ctx.dom.map.get('bookinfo-author').value, info.author);
  assert.equal(ctx.dom.map.get('bookinfo-group').value, info.group);
  assert.equal(ctx.dom.map.get('bookinfo-tags').value, info.tags.join('、'));
  assert.equal(ctx.dom.map.get('bookinfo-brief').value, info.brief);
  assert.equal(ctx.dom.map.get('bookinfo-error').textContent, '');
  assert.equal(ctx.dom.map.get('bookinfo-group-list').children.length, 2, '分组建议来自 shelfGroupList');
  assert.deepEqual(ctx.dom.map.get('bookinfo-group-list').children.map((o) => o.value), ['第一个分组', '第二个分组']);
  assert.equal(ctx.dom.map.get('bookinfo-backdrop').classList.contains('hidden'), false);
  assert.equal(ctx.dom.map.get('bookinfo-author')._focus, 1);
});

test('closeBookInfoDialog / readBookInfoForm：关弹层清状态与错误；读表单四个字段', () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  ctx.state.bookInfoBook = makeBook();
  dom.map.get('bookinfo-error').textContent = '旧错误';
  dom.map.get('bookinfo-backdrop').classList.remove('hidden');
  ctx.ui.closeBookInfoDialog();
  assert.equal(ctx.state.bookInfoBook, null);
  assert.equal(dom.map.get('bookinfo-backdrop').classList.contains('hidden'), true);
  assert.equal(dom.map.get('bookinfo-error').textContent, '');

  dom.map.get('bookinfo-author').value = 'A';
  dom.map.get('bookinfo-group').value = 'G';
  dom.map.get('bookinfo-tags').value = 'T1、T2';
  dom.map.get('bookinfo-brief').value = 'B';
  assert.deepEqual(ctx.ui.readBookInfoForm(), { author: 'A', group: 'G', tags: 'T1、T2', brief: 'B' });
});

test('saveBookInfoDialog：没书返回 {ok:false}；成功清洗标签、只写书目、关弹层、提示并刷新书架', async () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  assert.deepEqual(await ctx.ui.saveBookInfoDialog(), { ok: false });

  const book = makeBook();
  ctx.state.bookInfoBook = book;
  dom.map.get('bookinfo-author').value = '新作者';
  dom.map.get('bookinfo-group').value = '新分组';
  dom.map.get('bookinfo-tags').value = '标签A、标签A、 标签B ';
  dom.map.get('bookinfo-brief').value = '新简介';
  const res = await ctx.ui.saveBookInfoDialog();
  assert.deepEqual(res, { ok: true, changed: true });
  assert.equal(ctx.calls.updateBookInfo.length, 1);
  const [path, patch] = ctx.calls.updateBookInfo[0];
  assert.equal(path, '/书库/书甲');
  assert.deepEqual(patch, { author: '新作者', group: '新分组', tags: bookInfoLib.sanitizeTags('标签A、标签A、 标签B '), brief: '新简介' });
  assert.equal(ctx.state.bookInfoBook, null, '保存后关弹层');
  assert.deepEqual(ctx.calls.toast, [['书籍信息已保存（只改书目，不改正文和文件名）', undefined]]);
  assert.equal(ctx.calls.refreshShelf, 1);
});

test('saveBookInfoDialog：没有变化时提示「没有变化」；失败时错误写进弹层并返回失败', async () => {
  const changed = build({ changed: false });
  changed.state.bookInfoBook = makeBook();
  const noChange = await changed.ui.saveBookInfoDialog();
  assert.deepEqual(noChange, { ok: true, changed: false });
  assert.deepEqual(changed.calls.toast, [['书籍信息没有变化', undefined]]);

  const dom = makeDocument();
  const fail = build({ dom, saveError: '书目只读' });
  fail.state.bookInfoBook = makeBook();
  const res = await fail.ui.saveBookInfoDialog();
  assert.deepEqual(res, { ok: false, message: '书目只读' });
  assert.equal(dom.map.get('bookinfo-error').textContent, '保存失败：书目只读');
  assert.equal(fail.state.bookInfoBook !== null, true, '失败不关弹层');
});

// ---------- 书架渲染 ----------
test('renderShelf：先刷根标签 / 继续写作卡 / 分组条 / 搜索提示 / 窗口标题 / 正文命中区', () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  ctx.ui.renderShelf();
  assert.equal(dom.map.get('books-root-label').textContent, '书架：/书库');
  assert.equal(dom.map.get('books-root-label').title, '/书库');
  assert.equal(ctx.calls.renderContinueWriting, 1);
  assert.deepEqual(ctx.calls.updateShelfSearchUi, [1]);
  assert.equal(ctx.calls.updateWindowTitle, 1);
  assert.equal(ctx.calls.renderShelfContent, 1);
});

test('renderShelf：空书库 / 分组里没书 / 搜索没命中（三种文案，含正文命中与加载中）', () => {
  const empty = build({ books: [], rows: [] });
  empty.ui.renderShelf();
  assert.equal(empty.dom.map.get('book-grid').children[0].className, 'shelf-empty');
  assert.equal(empty.dom.map.get('book-grid').children[0].dataset.emptyKind, 'vacuum');
  assert.equal(
    empty.dom.map.get('book-grid').children[0].textContent,
    '这里还没有书。一本书 = 一个文件夹，正文就是里面的普通 txt 文件，用记事本也能打开。' +
      '点右上「导入小说」把现有稿子导进来，或点右侧（或下面）的「新建一本书」从零开始；' +
      '也可以直接把书文件夹放进书架目录。'
  );

  const noneGroup = build({ rows: [], shelfGroup: '__none__' });
  noneGroup.ui.renderShelf();
  assert.equal(noneGroup.dom.map.get('book-grid').children[0].dataset.emptyKind, 'filtered');
  assert.equal(
    noneGroup.dom.map.get('book-grid').children[0].textContent,
    '「未分组」里还没有书。把某本书的分组留空（书卡「⋯」→「书籍信息」），它就会出现在这里；也可以切回「全部分组」。'
  );

  const group = build({ rows: [], shelfGroup: '书友', groups: ['书友'] });
  group.ui.renderShelf();
  assert.equal(group.dom.map.get('book-grid').children[0].dataset.emptyKind, 'filtered');
  assert.equal(
    group.dom.map.get('book-grid').children[0].textContent,
    '这个分组里还没有书。给书填上这个分组（书卡「⋯」→「书籍信息」），它就会出现在这里；也可以切回「全部分组」。'
  );

  const loading = build({ rows: [], query: '张三', shelfContent: { meta: null, loading: true } });
  loading.ui.renderShelf();
  assert.equal(loading.dom.map.get('book-grid').children[0].dataset.emptyKind, 'loading');
  assert.equal(
    loading.dom.map.get('book-grid').children[0].textContent,
    '书名 / 作者 / 章节名没有匹配。正在正文里继续找，找到后会出现在上方「正文命中」，不用重新搜。'
  );

  const contentHit = build({ rows: [], query: '张三', shelfContent: { meta: { results: [1, 2] }, loading: false } });
  contentHit.ui.renderShelf();
  assert.equal(contentHit.dom.map.get('book-grid').children[0].dataset.emptyKind, 'filtered');
  assert.equal(contentHit.dom.map.get('book-grid').children[0].textContent, '书名 / 作者 / 章节名没有匹配；正文找到 2 处，见上方「正文命中」。');

  const none = build({ rows: [], query: '张三', shelfContent: { meta: null, loading: false } });
  none.ui.renderShelf();
  assert.equal(none.dom.map.get('book-grid').children[0].dataset.emptyKind, 'filtered');
  assert.equal(
    none.dom.map.get('book-grid').children[0].textContent,
    '没有找到匹配「张三」的书。搜索会看书名 / 作者 / 分组 / 标签 / 章节名，也会在正文里找；换一个更短或更具体的词再试，按 Esc 清空搜索。'
  );
});

test('renderShelf 缓存（B6）：书卡内容没变就复用同一批节点，书名 / 最后修改变了才重建', () => {
  const book = makeBook();
  const info = { chapterHits: [] };
  const ctx = build({ books: [book], rows: [{ book, info }] });
  ctx.ui.renderShelf();
  const grid = ctx.dom.map.get('book-grid');
  const firstCard = grid.children.find((el) => el.className === 'book-card');
  const firstAdd = grid.children.find((el) => el.className.includes('new-book'));
  assert.ok(firstCard, '第一次渲染要有书卡');
  assert.ok(firstAdd, '没有搜索词时要显示「新建一本书」');

  // 同一份数据再渲染：DOM 不清空、书卡 / 新建卡都还是同一批节点（焦点 / 滚动位置不会丢）
  ctx.ui.renderShelf();
  assert.equal(grid.children.find((el) => el.className === 'book-card'), firstCard, '内容没变时书卡要复用');
  assert.equal(grid.children.find((el) => el.className.includes('new-book')), firstAdd, '新建卡也要复用');
  assert.equal(ctx.calls.renderShelfContent, 2, '正文命中区每次仍要刷新（缓存只管书卡）');

  // 书名变了 → 重建（签名变化）
  book.title = '改名了';
  ctx.ui.renderShelf();
  const renamedCard = grid.children.find((el) => el.className === 'book-card');
  assert.notEqual(renamedCard, firstCard, '书名变了要重建');
  assert.equal(renamedCard.children[0].children[0].textContent, '改名了');

  // 最后修改时间变了 → 重建（E2E 第 03 组：保存刷新书目 updatedAt 后书架时间不能冻结）
  book.title = '书甲';
  ctx.ui.renderShelf();
  const beforeTime = grid.children.find((el) => el.className === 'book-card');
  book.lastModified = 1700000123000;
  ctx.ui.renderShelf();
  assert.notEqual(grid.children.find((el) => el.className === 'book-card'), beforeTime, '最后修改变了要重建');

  // 章节命中行变了 → 重建（搜索命中的章名要跟着查询变）
  const hitCard = grid.children.find((el) => el.className === 'book-card');
  info.chapterHits = [{ index: 1, name: '第二章' }];
  ctx.ui.renderShelf();
  assert.notEqual(grid.children.find((el) => el.className === 'book-card'), hitCard, '章节命中变了要重建');
});

test('renderShelfGroupBar：没有分组 → 收起并清空；有分组 → 全部分组 + 未分组 + 各分组，非法选中值回落到全部', () => {
  const noGroups = build({ groups: [], shelfGroup: '旧分组' });
  noGroups.ui.renderShelf();
  assert.equal(noGroups.state.shelfGroup, '');
  assert.equal(noGroups.dom.map.get('shelf-group-bar').classList.contains('hidden'), true);
  assert.equal(noGroups.dom.map.get('shelf-group-filter').children.length, 0);

  const ctx = build({ groups: ['书友'], shelfGroup: '已不存在' });
  const filter = ctx.dom.map.get('shelf-group-filter');
  ctx.ui.renderShelf();
  assert.deepEqual(filter.children.map((o) => [o.value, o.textContent]), [
    ['', '全部分组'], ['__none__', '未分组'], ['书友', '书友']
  ]);
  assert.equal(ctx.state.shelfGroup, '', '非法分组回落到「全部分组」');
  assert.equal(filter.value, '');
  assert.equal(ctx.dom.map.get('shelf-group-bar').classList.contains('hidden'), false);
});

test('renderShelf 书卡：书名 / 分组签 / 作者标签 / 简介（换行压平）/ 章数字数 / 完稿 / 最后修改全钉住', () => {
  const book = makeBook({
    author: '作者甲', group: '书友', tags: ['玄幻', '长篇'],
    brief: '第一行\n\n第二行  空格'
  });
  const ctx = build({ books: [book], rows: [{ book, info: {} }] });
  ctx.ui.renderShelf();
  const grid = ctx.dom.map.get('book-grid');
  const card = grid.children[0];
  assert.equal(card.className, 'book-card');
  assert.equal(card.dataset.path, '/书库/书甲');
  assert.equal(card.dataset.folder, '书甲');
  assert.equal(card.tabIndex, 0);
  assert.equal(card.getAttribute('role'), 'button');
  assert.equal(card.getAttribute('aria-label'), '打开《书甲》');
  assert.equal(card.children[0].className, 'book-card-head');
  assert.equal(card.children[0].children[0].textContent, '书甲');
  const groupTag = card.children[0].children[1];
  assert.equal(groupTag.className, 'book-card-tags');
  assert.equal(groupTag.textContent, '书友');
  const author = card.children.find((c) => c.className === 'book-card-author');
  assert.equal(author.textContent, '作者：作者甲 · #玄幻 · #长篇');
  const brief = card.children.find((c) => c.className === 'book-card-brief');
  assert.equal(brief.textContent, '第一行 第二行  空格', '只把换行压成空格，不额外合并空格');
  assert.equal(brief.title, '第一行\n\n第二行  空格');
  const meta = card.children.find((c) => c.className === 'book-card-meta');
  assert.deepEqual(meta.children.map((c) => c.textContent), ['3 章 · 1,234 字', '完稿 1/3 章'], '拍板 #1：书卡字数也走千分位');
  const time = card.children.find((c) => c.className === 'book-card-time');
  assert.equal(time.textContent, '最后修改 今天 10:00');
});

test('renderShelf 书卡：冲突徽标 / 章节命中行 / 损坏书的修复按钮与提示 / ⋯ 菜单坐标', () => {
  const conflictBook = makeBook({ conflicts: ['a.conflict.txt', 'b.conflict.txt'] });
  const withHits = build({ books: [conflictBook], rows: [{ book: conflictBook, info: { chapterHits: [{ index: 1, name: '第二章' }] } }] });
  withHits.ui.renderShelf();
  const card = withHits.dom.map.get('book-grid').children[0];
  assert.equal(card.className, 'book-card has-conflict');
  const badge = card.children.find((c) => c.className === 'book-conflict-badge');
  assert.match(badge.textContent, /检测到同步冲突副本（2 个）/);
  assert.match(badge.title, /a\.conflict\.txt/);
  badge._fire('click', { stopPropagation() {} });
  assert.deepEqual(withHits.calls.openConflictDialog, [conflictBook]);
  const hitLine = card.children.find((c) => c.className === 'book-card-match');
  assert.equal(hitLine.textContent, '章节命中：第二章');
  const more = card.children.find((c) => c.className === 'book-card-more');
  assert.equal(more.textContent, '⋯');
  assert.equal(more.title, '更多操作（打开文件夹 / 删除）');
  more._fire('click', { stopPropagation() {} });
  assert.deepEqual(withHits.calls.showBookMenu[0][1], 400 - 186);
  assert.deepEqual(withHits.calls.showBookMenu[0][2], 300 + 4);

  const corruptBook = makeBook({ status: 'corrupt', reason: 'JSON 坏了' });
  const corrupt = build({ books: [corruptBook], rows: [{ book: corruptBook, info: {} }] });
  corrupt.ui.renderShelf();
  const corruptCard = corrupt.dom.map.get('book-grid').children[0];
  assert.equal(corruptCard.className, 'book-card corrupt');
  assert.equal(corruptCard.children[0].children[0].textContent, '⚠ 书甲');
  const corruptMeta = corruptCard.children.find((c) => c.className === 'book-card-meta');
  assert.equal(corruptMeta.textContent, '书目损坏：JSON 坏了');
  const time = corruptCard.children.find((c) => c.className === 'book-card-time');
  assert.equal(time.textContent, '点开可以修复');
  const repair = corruptCard.children.find((c) => c.className === 'btn primary');
  assert.equal(repair.textContent, '修复');
  repair._fire('click', { stopPropagation() {} });
  assert.deepEqual(corrupt.calls.openRepair, [corruptBook]);
});

test('renderShelf 章节命中：每个章名一个原生 button（data-chapter-index），整行文案与容器不变；无命中不渲染空行', () => {
  const book = makeBook();
  const ctx = build({
    books: [book],
    rows: [{ book, info: { chapterHits: [{ index: 2, name: '第二' }, { index: 0, name: '第三' }] } }]
  });
  ctx.ui.renderShelf();
  const card = ctx.dom.map.get('book-grid').children[0];
  const hitLine = card.children.find((c) => c.className === 'book-card-match');
  assert.ok(hitLine, '命中行容器 .book-card-match 必须还在');
  assert.equal(hitLine.textContent, '章节命中：第3章：第二、第1章：第三', '整行 textContent 与旧版逐字一致（E2E 第 33 组按它断言）');
  const buttons = hitLine.children.filter((c) => c.tagName === 'button');
  assert.equal(buttons.length, 2, '每个命中章一个可点元素');
  assert.deepEqual(buttons.map((b) => b.dataset.chapterIndex), ['2', '0'], 'data-chapter-index 是 0 起的章节序号');
  for (const button of buttons) {
    assert.equal(button.type, 'button');
    assert.equal(button.className, 'book-card-match-chapter');
    assert.equal(button.getAttribute('role'), null, '原生 button 不需要再补 role');
    assert.equal(button.getAttribute('aria-label'), button.title);
    assert.match(button.title, /^打开《书甲》并定位到第\d章：/);
  }

  // 没有 chapterHits（空数组 / 缺字段）：整行都不出现，不留空容器
  for (const info of [{ chapterHits: [] }, {}]) {
    const none = build({ books: [book], rows: [{ book, info }] });
    none.ui.renderShelf();
    const noneCard = none.dom.map.get('book-grid').children[0];
    assert.equal(noneCard.children.some((c) => c.className === 'book-card-match'), false);
  }

  // 样式：可点章名看起来仍是行内文字，悬停有底色反馈，焦点环走全局 button:focus-visible
  assert.match(stylesSrc, /\.book-card-match-chapter\s*\{[^}]*cursor:\s*pointer/);
  assert.match(stylesSrc, /\.book-card-match-chapter:hover\s*\{[^}]*background:\s*var\(--hover-tint\)/);
  assert.ok(stylesSrc.includes('button:focus-visible'), '原生 button 的键盘焦点环仍走全局规则');
});

test('renderShelf 章节命中：点击章名走 host.openBookAtChapter 且不触发整卡打开；重建后事件不重复绑定', () => {
  const book = makeBook();
  const info = { chapterHits: [{ index: 2, name: '第二' }] };
  const ctx = build({ books: [book], rows: [{ book, info }] });
  ctx.ui.renderShelf();
  const grid = ctx.dom.map.get('book-grid');
  let card = grid.children[0];
  let hitLine = card.children.find((c) => c.className === 'book-card-match');
  let button = hitLine.children.find((c) => c.tagName === 'button');
  assert.equal(button._listeners.filter((l) => l.type === 'click').length, 1, '每次渲染只绑一条 click');

  // 模拟真实冒泡：按钮处理必须 preventDefault + stopPropagation，卡片不能再收到一次「打开上次章节」
  const event = {
    prevented: 0,
    stopped: 0,
    preventDefault() { this.prevented += 1; },
    stopPropagation() { this.stopped += 1; }
  };
  button._fire('click', event);
  assert.equal(event.prevented, 1);
  assert.equal(event.stopped, 1);
  assert.deepEqual(ctx.calls.openBookAtChapter, [['/书库/书甲', 2]]);
  assert.deepEqual(ctx.calls.openBookByPath, [], '点章名不能顺带触发整卡打开');
  // 如果 stopPropagation 没生效，事件会继续冒泡到卡片；这里断言那样也不会打开书
  if (!event.stopped) card._fire('click', { target: { closest: () => null } });
  assert.deepEqual(ctx.calls.openBookByPath, []);

  // 内容没变 → 复用同一节点，监听仍只有一条
  ctx.ui.renderShelf();
  card = grid.children[0];
  hitLine = card.children.find((c) => c.className === 'book-card-match');
  button = hitLine.children.find((c) => c.tagName === 'button');
  assert.equal(button._listeners.filter((l) => l.type === 'click').length, 1);

  // 命中章变了 → 重建出新按钮，新节点也只绑一条
  info.chapterHits = [{ index: 1, name: '第一' }];
  ctx.ui.renderShelf();
  const rebuilt = grid.children[0].children
    .find((c) => c.className === 'book-card-match')
    .children.find((c) => c.tagName === 'button');
  assert.equal(rebuilt._listeners.filter((l) => l.type === 'click').length, 1);
  rebuilt._fire('click', { preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(ctx.calls.openBookAtChapter, [['/书库/书甲', 2], ['/书库/书甲', 1]]);
});

test('renderShelf 章节命中：卡片其它区域（标题 / 命中行空白）仍按原行为打开上次章节', () => {
  const book = makeBook();
  const ctx = build({ books: [book], rows: [{ book, info: { chapterHits: [{ index: 1, name: '第二章' }] } }] });
  ctx.ui.renderShelf();
  const card = ctx.dom.map.get('book-grid').children[0];
  card._fire('click', { target: { closest: () => null } });
  assert.deepEqual(ctx.calls.openBookByPath, ['/书库/书甲']);
  assert.deepEqual(ctx.calls.openBookAtChapter, [], '整卡打开不带章节目标');
});

test('renderShelf 书卡：点卡片打开书、右键弹菜单；搜索时不显示「新建一本书」', () => {
  const book = makeBook();
  const ctx = build({ books: [book], rows: [{ book, info: {} }] });
  ctx.ui.renderShelf();
  const card = ctx.dom.map.get('book-grid').children[0];
  card._fire('click', { target: { closest: () => null } });
  assert.deepEqual(ctx.calls.openBookByPath, ['/书库/书甲']);
  card._fire('contextmenu', { preventDefault() {} });
  assert.deepEqual(ctx.calls.showBookMenu[0][0], book);

  // ⋯ 点击不算整卡打开
  const ctx2 = build({ books: [book], rows: [{ book, info: {} }] });
  ctx2.ui.renderShelf();
  ctx2.dom.map.get('book-grid').children[0]._fire('click', { target: { closest: (sel) => (sel === '.book-card-more' ? {} : null) } });
  assert.deepEqual(ctx2.calls.openBookByPath, []);

  // 有搜索词：不显示新书卡
  const searched = build({ books: [book], query: '书', rows: [{ book, info: {} }] });
  searched.ui.renderShelf();
  assert.equal(searched.dom.map.get('book-grid').children.some((c) => c.className.includes('new-book')), false);
});

// ---------- 新建书 ----------
test('renderShelf：没有搜索词时显示「＋ 新建一本书」卡；点击 → promptText 书名 → createBookWithTitle', async () => {
  const ctx = build({ promptValue: '我的新书' });
  ctx.ui.renderShelf();
  const newCard = ctx.dom.map.get('book-grid').children.find((c) => c.className.includes('new-book'));
  assert.ok(newCard);
  assert.equal(newCard.children[0].textContent, '＋');
  assert.equal(newCard.children[1].textContent, '新建一本书');
  await newCard._fire('click');
  assert.deepEqual(ctx.calls.promptText, [{
    title: '新建一本书',
    message: '给这本书起个名字；直接点确定就叫「我的新书」。',
    placeholder: '书名'
  }]);
  assert.deepEqual(ctx.calls.createBook, ['我的新书']);
  assert.deepEqual(ctx.calls.toast, [['已创建：我的新书', undefined]]);
  assert.equal(ctx.calls.refreshShelf, 1);
  assert.deepEqual(ctx.calls.openBookByPath, ['/书库/新书']);

  // 取消：什么都不建
  const cancel = build({ promptValue: null });
  cancel.ui.renderShelf();
  await cancel.dom.map.get('book-grid').children.find((c) => c.className.includes('new-book'))._fire('click');
  assert.deepEqual(cancel.calls.createBook, []);
});

test('createBookWithTitle：主进程失败 → toast「新建失败：」', async () => {
  const ctx = build({ createError: '磁盘满' });
  await ctx.ui.createBookWithTitle('新书');
  assert.deepEqual(ctx.calls.toast, [['新建失败：磁盘满', 'error']]);
  assert.equal(ctx.calls.refreshShelf, 0);
});

// ---------- 事件绑定 ----------
test('setupBookinfoUi：弹层 Enter 提交 / 取消 / 保存 / 分组筛选四条绑定逐行钉住', () => {
  const dom = makeDocument();
  const ctx = build({ dom, groups: ['书友'] });
  ctx.ui.setupBookinfoUi();
  const backdrop = dom.map.get('bookinfo-backdrop');
  assert.deepEqual(backdrop._listeners.map((l) => l.type), ['keydown']);

  // Enter → 保存（先摆一个可保存的书）
  ctx.state.bookInfoBook = makeBook();
  let saved = 0;
  const origSave = ctx.host.api.updateBookInfo;
  ctx.host.api.updateBookInfo = async (...args) => { saved += 1; return origSave(...args); };
  backdrop._fire('keydown', { key: 'Enter', target: { id: 'bookinfo-author' }, preventDefault() {} });
  return Promise.resolve().then(() => {
    assert.equal(saved, 1, 'Enter 提交保存');
    // brief 里按 Enter 不提交（留给换行）
    const before = saved;
    backdrop._fire('keydown', { key: 'Enter', target: { id: 'bookinfo-brief' }, preventDefault() {} });
    assert.equal(saved, before, '简介里的 Enter 不触发保存');
    // 非 Enter 键不处理
    backdrop._fire('keydown', { key: 'a', target: { id: 'bookinfo-author' }, preventDefault() {} });
    assert.equal(saved, before);

    // 取消 / 保存按钮
    dom.map.get('btn-bookinfo-cancel')._fire('click');
    assert.equal(dom.map.get('bookinfo-backdrop').classList.contains('hidden'), true);
    // Enter 保存成功后弹层已关、state 已清；再摆一本书测保存按钮
    ctx.state.bookInfoBook = makeBook();
    dom.map.get('btn-bookinfo-save')._fire('click');
    return Promise.resolve().then(() => {
      assert.equal(saved, before + 1, '保存按钮也触发保存');

      // 分组筛选 change → 写 state 并重渲染书架
      ctx.state.books = [makeBook()];
      dom.map.get('shelf-group-filter').value = '书友';
      dom.map.get('shelf-group-filter')._fire('change', { target: { value: '书友' } });
      assert.equal(ctx.state.shelfGroup, '书友');
      assert.equal(ctx.calls.renderContinueWriting >= 1, true, '重渲染书架');
    });
  });
});

// ---------- 静态闸门 ----------
test('静态闸门：renderer.js 不再内嵌书籍信息 / 书架渲染实现，只剩装配与转发', () => {
  for (const shape of [
    'function openBookInfoDialog(',
    'function closeBookInfoDialog(',
    'function readBookInfoForm(',
    'async function saveBookInfoDialog(',
    'function renderShelfGroupBar(',
    'function renderShelf(',
    'async function onNewBookClick(',
    'async function createBookWithTitle('
  ]) {
    assert.equal(rendererSrc.includes(shape), false, 'renderer.js 里还有第二份：' + shape);
  }
  assert.equal(rendererSrc.split('bookinfoUiModule.create(').length - 1, 1, '装配只许一处');
  assert.ok(rendererSrc.includes('const bookinfoUiModule = window.CWBookinfoUi;'));
  for (const line of [
    '    $, state, api, call, toast,',
    '    render: { bookInfoLib, bookGroupOf, chapterTitle, formatChars, formatRelativeTime },',
    '    shelf: { shelfGroupList, shelfQueryText, shelfSearchResults, updateShelfSearchUi, renderContinueWriting, renderShelfContent },',
    '    actions: {',
    '      openBookByPath,',
    '      openBookAtChapter: (bookPath, chapterIndex) => openBookByPath(bookPath, { chapterIndex }),',
    '      openRepair, openConflictDialog, showBookMenu, updateWindowTitle, promptText, refreshShelf'
  ]) {
    assert.ok(rendererSrc.includes(line), '装配少了：' + line);
  }
  // 「章节命中」直达：openBookByPath 认 target.chapterIndex（0 起、只在本书范围内生效）
  assert.ok(rendererSrc.includes('target.chapterIndex !== undefined'), 'openBookByPath 要认 chapterIndex');
  assert.ok(rendererSrc.includes('chapterIndex < state.chapters.length'), 'chapterIndex 要按本书章节数校验');
  assert.ok(rendererSrc.includes(
    'const { openBookInfoDialog, closeBookInfoDialog, readBookInfoForm, saveBookInfoDialog, renderShelf, createBookWithTitle, setupBookinfoUi } = bookinfoUi;'
  ), '7 个入口按原名解构');
  for (const id of ['bookinfo-backdrop', 'btn-bookinfo-cancel', 'btn-bookinfo-save', 'shelf-group-filter']) {
    assert.equal(rendererSrc.includes(`$('${id.replace('bookinfo-backdrop', 'bookinfo-backdrop')}').addEventListener`) && id !== 'bookinfo-backdrop' ? rendererSrc.includes(`$('${id}').addEventListener`) : rendererSrc.includes(`$('${id}').addEventListener`), false, '绑定应该只在模块里：' + id);
  }
  assert.equal(rendererSrc.split('bookinfoUi.setupBookinfoUi();').length - 1, 1, 'setup 只调一次');
  assert.match(rendererSrc, /'close-bookinfo': \(\) => closeBookInfoDialog\(\),/);
  assert.ok(rendererSrc.includes('renderShelf();'), '书架 / 正文搜索 / 事件绑定仍按名字调 renderShelf');
  for (const key of ['openBookInfoDialog', 'closeBookInfoDialog', 'readBookInfoForm', 'saveBookInfoDialog', 'renderShelf', 'createBookWithTitle']) {
    assert.match(rendererSrc, new RegExp('^      ' + key + ',$', 'm'), 'testHooksScope 少了 ' + key);
  }
  // list-keyboard 的安装位置仍在 renderer（书卡容器接线）
  assert.ok(rendererSrc.includes("container: $('book-grid')"), '书卡键盘接线仍在 renderer');
  assert.ok(rendererSrc.includes("itemSelector: '.book-card[data-path]'"));
});

test('静态闸门：index.html 在 renderer.js 之前加载 bookinfo-ui.js，且只加载一次', () => {
  const at = indexSrc.indexOf('<script src="bookinfo-ui.js"></script>');
  const rendererAt = indexSrc.indexOf('<script src="renderer.js"></script>');
  assert.notEqual(at, -1);
  assert.ok(at < rendererAt);
  assert.equal(indexSrc.split('bookinfo-ui.js').length - 1, 1);
});

test('静态闸门：模块不 require / 不摸 Electron·fs·网络', () => {
  for (const forbidden of ['require(', 'ipcRenderer', 'node:fs', 'child_process', 'localStorage', 'fetch(', 'window.', 'process.']) {
    assert.equal(moduleCode.includes(forbidden), false, 'bookinfo-ui.js 不许出现 ' + forbidden);
  }
  assert.equal(/window\.addEventListener|document\.addEventListener/.test(moduleCode), false, '模块不注册全局监听');
  assert.equal((moduleCode.match(/setTimeout\(/g) || []).length, 0, '模块不建定时器');
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWBookinfoUi，且不乱造别的全局', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(moduleSrc, context, { filename: 'renderer/bookinfo-ui.js' });
  assert.equal(typeof win.CWBookinfoUi, 'object');
  assert.deepEqual(Object.keys(win.CWBookinfoUi).sort(), ['REQUIRED_HOST', 'create']);
  assert.equal(win.CWBookinfoUi.REQUIRED_HOST.length, 8);
  assert.equal(win.CWSensitiveUi, undefined);
});
