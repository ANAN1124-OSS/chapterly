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
  // 1.6.0 F5：标签筛选 + 「管理分组…」+ 分组管理弹层
  'shelf-tag-filter', 'shelf-tag-label', 'btn-shelf-group-manage',
  'group-manage-backdrop', 'group-manage-list', 'group-manage-error', 'btn-group-manage-close',
  'shelf-footer-default', 'shelf-first-run-tip',
  // 1.6.0b：书卡右键「移到分组…」在菜单里内联展开的分组列表
  'book-menu-groups',
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
    globalConfig: options.globalConfig === undefined ? { booksRoot: '/书库' } : options.globalConfig,
    shelfGroup: options.shelfGroup === undefined ? '' : options.shelfGroup,
    shelfTag: options.shelfTag === undefined ? '' : options.shelfTag,
    shelfContent: options.shelfContent === undefined ? { meta: null, loading: false } : options.shelfContent,
    bookInfoBook: null,
    meta: null
  };
  const calls = {
    updateBookInfo: [], createBook: [], pickFolder: [], setConfig: [],
    toast: [], openBookByPath: [], openBookAtChapter: [], openRepair: [], openConflictDialog: [], showBookMenu: [],
    updateWindowTitle: 0, promptText: [], refreshShelf: 0,
    updateShelfSearchUi: [], renderContinueWriting: 0, renderShelfContent: 0
  };
  const api = {
    async updateBookInfo(...args) {
      calls.updateBookInfo.push(args);
      if (options.saveError) throw new Error(options.saveError);
      // 1.6.0 F5：注入「某一本写失败」，验证改名 / 合并的失败清单与部分成功语义
      if (typeof options.updateBookInfoFail === 'function' && options.updateBookInfoFail(args[0])) {
        throw new Error('写入失败（测试注入）');
      }
      return { changed: options.changed === undefined ? true : options.changed };
    },
    async createBook(title) {
      calls.createBook.push(title);
      if (options.createError) throw new Error(options.createError);
      return { path: '/书库/新书', meta: { title } };
    },
    async setConfig(patch) {
      calls.setConfig.push(patch);
      if (options.setConfigError) throw new Error(options.setConfigError);
      return { ...(state.globalConfig || {}), ...patch };
    }
  };
  const host = {
    $: dom.$,
    state,
    api,
    call: options.call === undefined ? async (fn, ...args) => fn(...args) : options.call,
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
      async promptText(opts) {
        calls.promptText.push(opts);
        // 1.6.0 F5：改名 / 合并 / 移到分组会连着问，用队列按顺序给答复
        if (Array.isArray(options.promptAnswers) && options.promptAnswers.length) {
          return options.promptAnswers.shift();
        }
        return options.promptValue === undefined ? null : options.promptValue;
      },
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

test('create() 只建表：不碰 DOM / 不注册事件 / 不建定时器，交出 17 个入口', () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  assert.equal(dom.lookups, 0, 'create() 一次 $ 都不该调');
  assert.deepEqual(Object.keys(ctx.ui).sort(), [
    'closeBookGroupChooser', 'closeBookInfoDialog', 'closeGroupManageDialog', 'createBookWithTitle',
    'maybeShowFirstRunTip', 'mergeShelfGroup', 'moveBookToGroup', 'newGroupForBook',
    'onNewBookClick', 'openBookGroupChooser', 'openBookInfoDialog', 'openGroupManageDialog',
    'readBookInfoForm', 'renameShelfGroup', 'renderShelf', 'saveBookInfoDialog', 'setupBookinfoUi'
  ]);
  for (const name of Object.keys(ctx.ui)) assert.equal(typeof ctx.ui[name], 'function', name);
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

  const noneGroup = build({
    rows: [],
    shelfGroup: '__none__',
    books: [makeBook({ path: '/库/甲', title: '甲', group: '书友' }), makeBook({ path: '/库/乙', title: '乙' })]
  });
  noneGroup.ui.renderShelf();
  assert.equal(noneGroup.dom.map.get('book-grid').children[0].dataset.emptyKind, 'filtered');
  assert.equal(
    noneGroup.dom.map.get('book-grid').children[0].textContent,
    '「未分组」里还没有书。把某本书的分组留空（书卡「⋯」→「书籍信息」），它就会出现在这里；也可以切回「全部分组」。'
  );

  const group = build({ rows: [], shelfGroup: '书友', books: [makeBook({ group: '书友' })] });
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

test('renderShelfGroupBar：没有分组 / 标签 → 收起并清空；有分组 → 全部分组（N）+ 未分组（N）+ 各分组（N），非法选中值回落到全部', () => {
  const noGroups = build({ books: [makeBook()], shelfGroup: '旧分组' });
  noGroups.ui.renderShelf();
  assert.equal(noGroups.state.shelfGroup, '');
  assert.equal(noGroups.dom.map.get('shelf-group-bar').classList.contains('hidden'), true);
  assert.equal(noGroups.dom.map.get('shelf-group-filter').children.length, 0);
  assert.equal(noGroups.dom.map.get('shelf-tag-filter').children.length, 0);

  const ctx = build({
    books: [
      makeBook({ path: '/库/甲', title: '甲', group: '书友' }),
      makeBook({ path: '/库/乙', title: '乙', group: '书友' }),
      makeBook({ path: '/库/丙', title: '丙' })
    ],
    shelfGroup: '已不存在'
  });
  const filter = ctx.dom.map.get('shelf-group-filter');
  ctx.ui.renderShelf();
  assert.deepEqual(filter.children.map((o) => [o.value, o.textContent]), [
    ['', '全部分组（3）'], ['__none__', '未分组（1）'], ['书友', '书友（2）']
  ]);
  assert.equal(ctx.state.shelfGroup, '', '非法分组回落到「全部分组」');
  assert.equal(filter.value, '');
  assert.equal(ctx.dom.map.get('shelf-group-bar').classList.contains('hidden'), false);
  // 没有标签 → 标签下拉与标签名一起收起；有分组 → 「管理分组…」出现
  assert.equal(ctx.dom.map.get('shelf-tag-filter').classList.contains('hidden'), true);
  assert.equal(ctx.dom.map.get('shelf-tag-label').classList.contains('hidden'), true);
  assert.equal(ctx.dom.map.get('btn-shelf-group-manage').classList.contains('hidden'), false);
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
  return Promise.resolve().then(async () => {
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
    // Enter 保存成功后弹层已关、state 已清；先等这一次保存真正收尾（V75 守卫：同一时刻只放一发在飞），
    // 再摆一本书测保存按钮——否则第二次会被守卫正确地挡掉。
    await new Promise((resolve) => setImmediate(resolve));
    ctx.state.bookInfoBook = makeBook();
    dom.map.get('btn-bookinfo-save')._fire('click');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(saved, before + 1, '保存按钮也触发保存');

    // 分组筛选 change → 写 state 并重渲染书架
    ctx.state.books = [makeBook({ group: '书友' })];
    dom.map.get('shelf-group-filter').value = '书友';
    dom.map.get('shelf-group-filter')._fire('change', { target: { value: '书友' } });
    assert.equal(ctx.state.shelfGroup, '书友');
    assert.equal(ctx.calls.renderContinueWriting >= 1, true, '重渲染书架');
  });
});

// ---------- 输入法组字（1.7.1 P1 / 外部审计 V73） ----------
test('输入法组字中按 Enter 不触发 updateBookInfo（V73）', async () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  ctx.ui.setupBookinfoUi();
  const backdrop = dom.map.get('bookinfo-backdrop');
  // 走真实的打开路径：弹层可见 + state.bookInfoBook 有书（Enter 才有东西可存）
  assert.equal(ctx.ui.openBookInfoDialog(makeBook()), true);
  assert.equal(backdrop.classList.contains('hidden'), false, '前置：弹层是开着的');
  let saved = 0;
  const origSave = ctx.host.api.updateBookInfo;
  ctx.host.api.updateBookInfo = async (...args) => {
    saved += 1;
    return origSave(...args);
  };

  // 组字中（isComposing = true）：Enter 是「上屏候选词」，不是提交
  let prevented = 0;
  backdrop._fire('keydown', {
    key: 'Enter',
    isComposing: true,
    target: { id: 'bookinfo-author' },
    preventDefault() { prevented += 1; }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved, 0, '组字中的 Enter 不该发 updateBookInfo');
  assert.equal(prevented, 0, '组字中的 Enter 也不该拦默认行为');
  assert.equal(dom.map.get('bookinfo-backdrop').classList.contains('hidden'), false, '弹层不关，表单还能接着填');

  // 组字结束后的普通 Enter 仍是提交（旧行为不变）
  backdrop._fire('keydown', {
    key: 'Enter',
    target: { id: 'bookinfo-author' },
    preventDefault() {}
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved, 1, '普通 Enter 照旧提交');
  assert.equal(dom.map.get('bookinfo-backdrop').classList.contains('hidden'), true, '保存成功后才关窗');
});

// ---------- 保存竞态（1.7.1 P5 / 外部审计 V75） ----------
test('连按两次只调用一次 updateBookInfo（V75）', async () => {
  const dom = makeDocument();
  const pending = [];
  let ipcCount = 0;
  // 注入可控 promise 的 call：第一次故意悬着（IPC 在飞），之后的调用立刻回答（红阶段才会走到这里）
  const call = () => {
    ipcCount += 1;
    if (ipcCount === 1) return new Promise((resolve) => pending.push(resolve));
    return Promise.resolve({ changed: true });
  };
  const ctx = build({ dom, call });
  ctx.state.bookInfoBook = makeBook();
  const first = ctx.ui.saveBookInfoDialog();
  const second = await ctx.ui.saveBookInfoDialog();
  assert.equal(ipcCount, 1, '第一次还没回来时，连按的第二次不该再发 IPC');
  assert.deepEqual(second, { ok: false }, '进行中的第二次直接返回失败，不排队');
  assert.equal(ctx.state.bookInfoBook !== null, true, '第二次按下不关弹层');

  pending[0]({ changed: true });
  assert.deepEqual(await first, { ok: true, changed: true });
  assert.equal(ctx.state.bookInfoBook, null, '第一次成功后照常关弹层');
  assert.deepEqual(ctx.calls.toast, [['书籍信息已保存（只改书目，不改正文和文件名）', undefined]]);
  assert.equal(ctx.calls.refreshShelf, 1);
});

test('A 在飞期间弹层切到 B → A resolve 不关 B、不覆盖 B 的表单（V75）', async () => {
  const dom = makeDocument();
  const pending = [];
  let ipcCount = 0;
  const call = () => {
    ipcCount += 1;
    return new Promise((resolve) => pending.push(resolve));
  };
  const ctx = build({ dom, call });
  const bookA = makeBook({ path: '/书库/书甲', folder: '书甲', title: '书甲', author: '甲作者', brief: '甲简介' });
  const bookB = makeBook({ path: '/书库/书乙', folder: '书乙', title: '书乙', author: '乙作者', brief: '乙简介' });
  assert.equal(ctx.ui.openBookInfoDialog(bookA), true);
  dom.map.get('bookinfo-author').value = '甲作者（改过）';
  const inFlight = ctx.ui.saveBookInfoDialog(); // A 的 updateBookInfo 还在飞
  assert.equal(ctx.ui.openBookInfoDialog(bookB), true); // 作者没等回来就切到 B
  assert.equal(ctx.state.bookInfoBook, bookB);
  assert.equal(dom.map.get('bookinfo-author').value, '乙作者');
  assert.equal(dom.map.get('bookinfo-brief').value, '乙简介');

  pending[0]({ changed: true }); // A 返回
  const res = await inFlight;
  assert.deepEqual(res, { ok: false, stale: true }, 'A 的收尾认出自己已经过期');
  assert.equal(ctx.state.bookInfoBook, bookB, 'A 的收尾不能把 state 指向的书清掉');
  assert.equal(dom.map.get('bookinfo-backdrop').classList.contains('hidden'), false, 'B 的弹层必须还开着');
  assert.equal(dom.map.get('bookinfo-author').value, '乙作者', 'B 的输入框值不能被 A 的表单覆盖');
  assert.equal(dom.map.get('bookinfo-brief').value, '乙简介');
  assert.deepEqual(ctx.calls.toast, [], 'A 的过期收尾不提示「已保存」');
  assert.equal(ctx.calls.refreshShelf, 0, 'A 的过期收尾不刷新书架');
  assert.equal(ipcCount, 1);
});

// ---------- 首次运行提示（1.3.0 T5 / 规范 I-10） ----------
test('首次运行提示：书架真空且没提示过才显示 4s，显示后写回 config.firstRunTipShown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = build({ books: [], globalConfig: { booksRoot: '/书库' } });
  const tip = ctx.dom.map.get('shelf-first-run-tip');
  const base = ctx.dom.map.get('shelf-footer-default');
  assert.equal(await ctx.ui.maybeShowFirstRunTip(), true, '真空 + 没提示过 = 显示');
  assert.equal(tip.textContent.includes('新建一本书') && tip.textContent.includes('导入小说'), true, '文案指向现有入口');
  assert.equal(tip.textContent.includes('Ctrl+K'), false, '提示不得提命令面板（已推 1.4.0）');
  assert.equal(base.classList.contains('hidden'), true, '显示提示时默认说明让位');
  assert.deepEqual(ctx.calls.setConfig, [{ firstRunTipShown: true }], '显示即记为已提示（只写这一个键）');
  assert.equal(ctx.state.globalConfig.firstRunTipShown, true, '回写后内存配置也更新');

  t.mock.timers.tick(3999);
  assert.equal(tip.textContent.length > 0, true, '不到 4s 不收');
  t.mock.timers.tick(1);
  assert.equal(tip.textContent, '', '4s 后自动消失');
  assert.equal(base.classList.contains('hidden'), false, '默认说明回来');
  assert.equal(await ctx.ui.maybeShowFirstRunTip(), false, '同一窗口只判断一次（刷新书架不重来）');
  assert.deepEqual(ctx.calls.setConfig, [{ firstRunTipShown: true }], '不再重复写配置');
});

test('首次运行提示：有书 / 已经提示过都不打扰；写盘失败也照样显示且不抛错', async () => {
  // 有书的老用户升级上来：一条都不显示、不写配置
  const withBooks = build({ books: [makeBook()], globalConfig: { booksRoot: '/书库' } });
  assert.equal(await withBooks.ui.maybeShowFirstRunTip(), false);
  assert.equal(withBooks.dom.map.get('shelf-first-run-tip').textContent, '');
  assert.deepEqual(withBooks.calls.setConfig, [], '有书时一个配置写都不发');

  // 配置里已经记过：不显示、不写配置
  const shown = build({ books: [], globalConfig: { booksRoot: '/书库', firstRunTipShown: true } });
  assert.equal(await shown.ui.maybeShowFirstRunTip(), false);
  assert.deepEqual(shown.calls.setConfig, []);

  // 写盘失败（磁盘满 / 只读）：这一轮仍然显示，下一次启动还能再提示一次；不抛错
  const failing = build({ books: [], globalConfig: { booksRoot: '/书库' }, setConfigError: '磁盘满' });
  assert.equal(await failing.ui.maybeShowFirstRunTip(), true);
  assert.equal(failing.dom.map.get('shelf-first-run-tip').textContent.includes('新建一本书'), true);
  assert.deepEqual(failing.calls.setConfig, [{ firstRunTipShown: true }]);
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
  assert.match(
    rendererSrc,
    /const \{\r?\n    openBookInfoDialog, closeBookInfoDialog, readBookInfoForm, saveBookInfoDialog,\r?\n    openGroupManageDialog, closeGroupManageDialog, renameShelfGroup, mergeShelfGroup, moveBookToGroup,\r?\n    openBookGroupChooser, closeBookGroupChooser, newGroupForBook,\r?\n    renderShelf, createBookWithTitle, onNewBookClick, setupBookinfoUi, maybeShowFirstRunTip\r?\n  \} = bookinfoUi;/,
    '17 个入口按原名解构（含 F5 的分组管理 / 移到分组与 1.6.0b 的菜单内联列表）'
  );
  assert.ok(rendererSrc.includes('await maybeShowFirstRunTip();'), '首屏书架刷新后调一次首次运行提示');
  for (const id of [
    'bookinfo-backdrop', 'btn-bookinfo-cancel', 'btn-bookinfo-save', 'shelf-group-filter',
    // 1.6.0 F5：标签下拉 / 管理分组按钮 / 管理弹层关闭按钮都只在模块里绑
    'shelf-tag-filter', 'btn-shelf-group-manage', 'btn-group-manage-close'
  ]) {
    assert.equal(rendererSrc.includes(`$('${id.replace('bookinfo-backdrop', 'bookinfo-backdrop')}').addEventListener`) && id !== 'bookinfo-backdrop' ? rendererSrc.includes(`$('${id}').addEventListener`) : rendererSrc.includes(`$('${id}').addEventListener`), false, '绑定应该只在模块里：' + id);
  }
  assert.equal(rendererSrc.split('bookinfoUi.setupBookinfoUi();').length - 1, 1, 'setup 只调一次');
  assert.match(rendererSrc, /'close-bookinfo': \(\) => closeBookInfoDialog\(\),/);
  assert.match(rendererSrc, /'close-group-manage': \(\) => closeGroupManageDialog\(\),/);
  assert.ok(rendererSrc.includes("'group-manage'"), 'ESC_BACKDROPS 要登记分组管理弹层');
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
  // 1.3.0 T5：唯一的定时器 = 首次运行提示的 4s 自动收起（只在 maybeShowFirstRunTip 里建）
  assert.equal((moduleCode.match(/setInterval\(/g) || []).length, 0, '模块不建 setInterval');
  assert.equal((moduleCode.match(/setTimeout\(/g) || []).length, 1, '模块只许首次运行提示这一个定时器');
  assert.ok(moduleCode.includes('firstRunTipTimer = setTimeout('), '定时器只能是首次运行提示的 4s 收起');
});

test('静态闸门：首次运行提示的结构 / 文案 / 4s / 配置键钉住（I-10）', () => {
  // 书架底部状态行 = 书架页的「状态栏」：默认说明 + 一次性提示两个 span；提示是 live region，读屏能收到。
  const footer = /<footer class="shelf-footer[\s\S]*?<\/footer>/.exec(indexSrc);
  assert.ok(footer, 'index.html 必须有书架底部状态行');
  assert.match(footer[0], /id="shelf-footer-default"/);
  assert.match(footer[0], /id="shelf-first-run-tip"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.ok(moduleCode.includes('const FIRST_RUN_TIP_MS = 4000;'), '4s 一次性提示');
  assert.ok(moduleCode.includes('firstRunTipShown'), '已提示标记走 config');
  assert.ok(moduleCode.includes('state.books.length'), '书架有书时不打扰');
  assert.match(moduleCode, /firstRunTipChecked\) return false/, '一个窗口只判断一次');
  for (const forbidden of ['欢迎向导', '多步向导', 'Ctrl+K', '命令面板', 'createElement(\'img\')', 'new Image']) {
    assert.equal(moduleCode.includes(forbidden), false, '提示实现里不许出现 ' + forbidden);
  }
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

// ---------- 标签筛选 + 分组管理（1.6.0 F5） ----------
test('标签筛选条：有标签才出现、选项带计数、选中值不存在时回落、只有标签时筛选条也在', () => {
  const books = [
    makeBook({ path: '/库/甲', title: '甲', group: '书友', tags: ['升级', '爽文'] }),
    makeBook({ path: '/库/乙', title: '乙', group: '书友', tags: ['升级'] }),
    makeBook({ path: '/库/丙', title: '丙' })
  ];
  const ctx = build({ books });
  ctx.ui.renderShelf();
  const tagSelect = ctx.dom.map.get('shelf-tag-filter');
  assert.equal(ctx.dom.map.get('shelf-tag-label').classList.contains('hidden'), false);
  assert.deepEqual(tagSelect.children.map((o) => [o.value, o.textContent]), [
    ['', '全部标签（2）'], ['升级', '#升级（2）'], ['爽文', '#爽文（1）']
  ]);
  assert.equal(tagSelect.value, '');

  // 只有标签、没有分组：筛选条也要出现（标签下拉单独可用），但不显示「管理分组…」
  const tagsOnly = build({
    books: [makeBook({ path: '/库/丁', title: '丁', tags: ['悬疑'] })],
    shelfTag: '悬疑'
  });
  tagsOnly.ui.renderShelf();
  assert.equal(tagsOnly.dom.map.get('shelf-group-bar').classList.contains('hidden'), false);
  assert.equal(tagsOnly.dom.map.get('shelf-tag-filter').value, '悬疑');
  assert.equal(tagsOnly.dom.map.get('btn-shelf-group-manage').classList.contains('hidden'), true);
  assert.deepEqual(tagsOnly.dom.map.get('shelf-group-filter').children.map((o) => o.value), ['', '__none__']);

  // 选中的标签已经不存在 → 回到「全部标签」
  const gone = build({ books: [makeBook({ tags: ['升级'] })], shelfTag: '旧标签' });
  gone.ui.renderShelf();
  assert.equal(gone.state.shelfTag, '');
  assert.equal(gone.dom.map.get('shelf-tag-filter').value, '');
});

test('书架空态（F5）：标签筛选把书筛空时说明是标签筛的；分组 + 标签同时选中时两句都说', () => {
  const ctx = build({ rows: [], books: [makeBook({ group: '书友', tags: ['升级', '悬疑'] })], shelfTag: '悬疑' });
  ctx.ui.renderShelf();
  const empty = ctx.dom.map.get('book-grid').children[0];
  assert.equal(empty.dataset.emptyKind, 'filtered');
  assert.equal(
    empty.textContent,
    '没有带「#悬疑」标签的书。给书加这个标签（书卡「⋯」→「书籍信息」），它就会出现在这里；也可以切回「全部标签」。'
  );

  const both = build({
    rows: [],
    books: [makeBook({ group: '书友', tags: ['悬疑'] })],
    shelfGroup: '书友',
    shelfTag: '悬疑'
  });
  both.ui.renderShelf();
  const bothEmpty = both.dom.map.get('book-grid').children[0];
  assert.equal(
    bothEmpty.textContent,
    '这个分组里还没有书。给书填上这个分组（书卡「⋯」→「书籍信息」），它就会出现在这里；也可以切回「全部分组」。 ' +
      '没有带「#悬疑」标签的书。给书加这个标签（书卡「⋯」→「书籍信息」），它就会出现在这里；也可以切回「全部标签」。'
  );
});

test('分组管理弹层：列出分组与本数、打开后焦点落在「关闭」、没有分组时给空态', () => {
  const ctx = build({
    books: [
      makeBook({ path: '/库/甲', group: '书友' }),
      makeBook({ path: '/库/乙', group: '书友' }),
      makeBook({ path: '/库/丙', group: '短篇' }),
      makeBook({ path: '/库/丁' })
    ]
  });
  assert.equal(ctx.ui.openGroupManageDialog(), true);
  assert.equal(ctx.dom.map.get('group-manage-backdrop').classList.contains('hidden'), false);
  assert.equal(ctx.dom.map.get('btn-group-manage-close')._focus, 1, '打开后焦点落在「关闭」');
  assert.deepEqual(
    ctx.dom.map.get('group-manage-list').children.map((row) => [
      row.dataset.group,
      row.children.map((el) => el.textContent)
    ]),
    [
      ['短篇', ['短篇', '1 本', '改名…', '合并到…']],
      ['书友', ['书友', '2 本', '改名…', '合并到…']]
    ]
  );
  ctx.ui.closeGroupManageDialog();
  assert.equal(ctx.dom.map.get('group-manage-backdrop').classList.contains('hidden'), true);

  const none = build({ books: [makeBook()] });
  assert.equal(none.ui.openGroupManageDialog(), true);
  assert.equal(none.dom.map.get('group-manage-list').children[0].className, 'group-manage-empty muted small');
  assert.match(none.dom.map.get('group-manage-list').children[0].textContent, /还没有分组/);
});

test('分组改名：询问框初值 = 旧名；每本一次 updateBookInfo({group})；刷新书架并报本数', async () => {
  const books = [
    makeBook({ path: '/库/甲', title: '甲', group: '玄幻' }),
    makeBook({ path: '/库/乙', title: '乙', group: '玄幻 ' }),
    makeBook({ path: '/库/丙', title: '丙', group: '短篇' })
  ];
  const ctx = build({ books, promptAnswers: ['仙侠'] });
  const result = await ctx.ui.renameShelfGroup('玄幻');
  assert.equal(ctx.calls.promptText.length, 1);
  assert.equal(ctx.calls.promptText[0].title, '重命名分组');
  assert.equal(ctx.calls.promptText[0].value, '玄幻', '初值就是旧分组名');
  assert.deepEqual(ctx.calls.updateBookInfo, [
    ['/库/甲', { group: '仙侠' }],
    ['/库/乙', { group: '仙侠' }]
  ]);
  assert.equal(result.changed, 2);
  assert.deepEqual(result.failed, []);
  assert.equal(ctx.calls.refreshShelf, 1);
  assert.deepEqual(ctx.calls.toast, [['已改名 2 本到「仙侠」（只改书目，正文与文件名没动）', undefined]]);
});

test('分组改名：留空 = 移到未分组；归一后同名 = 不写盘；取消 = 什么都不做', async () => {
  const books = [makeBook({ path: '/库/甲', title: '甲', group: '玄幻' })];
  const cleared = build({ books, promptAnswers: ['   '] });
  const clearedResult = await cleared.ui.renameShelfGroup('玄幻');
  assert.deepEqual(cleared.calls.updateBookInfo, [['/库/甲', { group: '' }]]);
  assert.equal(clearedResult.changed, 1);
  assert.deepEqual(cleared.calls.toast, [['已改名 1 本到未分组（只改书目，正文与文件名没动）', undefined]]);

  const same = build({ books, promptAnswers: [' 玄幻 '] });
  const sameResult = await same.ui.renameShelfGroup('玄幻');
  assert.deepEqual(same.calls.updateBookInfo, []);
  assert.equal(sameResult.changed, 0);
  assert.deepEqual(same.calls.toast, [['分组名没有变化', undefined]]);
  assert.equal(same.calls.refreshShelf, 0);

  const canceled = build({ books, promptAnswers: [null] });
  assert.deepEqual(await canceled.ui.renameShelfGroup('玄幻'), { ok: false, canceled: true });
  assert.deepEqual(canceled.calls.updateBookInfo, []);
});

test('分组合并：目标大小写归一到已有写法；部分失败保留原分组并报出失败本数', async () => {
  const books = [
    makeBook({ path: '/库/甲', title: '甲', group: '玄幻' }),
    makeBook({ path: '/库/乙', title: '乙', group: '玄幻' }),
    makeBook({ path: '/库/丙', title: '丙', group: 'Group A' })
  ];
  const ctx = build({ books, promptAnswers: ['group a'] });
  const result = await ctx.ui.mergeShelfGroup('玄幻');
  assert.equal(ctx.calls.promptText[0].title, '合并分组');
  assert.match(ctx.calls.promptText[0].message, /Group A/, '提示里列出其它分组名');
  assert.deepEqual(
    ctx.calls.updateBookInfo.map((call) => call[1]),
    [{ group: 'Group A' }, { group: 'Group A' }]
  );
  assert.equal(result.changed, 2);
  assert.deepEqual(ctx.calls.toast, [['已合并 2 本到「Group A」（只改书目，正文与文件名没动）', undefined]]);

  const failing = build({
    books: [
      makeBook({ path: '/库/甲', title: '甲', group: '玄幻' }),
      makeBook({ path: '/库/乙', title: '乙', group: '玄幻' })
    ],
    promptAnswers: ['仙侠'],
    updateBookInfoFail: (bookPath) => bookPath === '/库/乙'
  });
  const failedResult = await failing.ui.mergeShelfGroup('玄幻');
  assert.equal(failedResult.changed, 1);
  assert.equal(failedResult.failed.length, 1);
  assert.equal(failing.calls.refreshShelf, 1, '失败也要刷新书架（成功那本要立刻显示）');
  assert.equal(failing.calls.toast[0][1], 'warn');
  assert.match(
    failing.calls.toast[0][0],
    /已合并 1 本到「仙侠」；1 本失败（写入失败（测试注入）），失败的保持原分组/
  );
});

test('移到分组（单本）：菜单里列出已有分组（带本数、当前打勾）+ 未分组 + 新建；只写这一本', async () => {
  const books = [
    makeBook({ path: '/库/甲', title: '甲', group: '玄幻' }),
    makeBook({ path: '/库/乙', title: '乙', group: '玄幻' }),
    makeBook({ path: '/库/丙', title: '丙', group: '仙侠' }),
    makeBook({ path: '/库/丁', title: '丁' })
  ];
  const ctx = build({ books });
  assert.equal(ctx.ui.openBookGroupChooser(books[0]), true);
  assert.deepEqual(ctx.calls.promptText, [], '打开列表不许再弹询问框');
  const holder = ctx.dom.map.get('book-menu-groups');
  assert.equal(holder.classList.contains('hidden'), false);
  const title = holder.children.find((el) => el.className === 'context-menu-label');
  assert.equal(title.textContent, '把《甲》移到');
  const buttons = holder.children.filter((el) => el.tagName === 'button');
  const byGroup = (name) => buttons.find((el) => (el.dataset.group || '') === name) || null;
  assert.equal(byGroup('玄幻').textContent, '✓ 玄幻 · 2 本');
  assert.equal(byGroup('玄幻').getAttribute('aria-current'), 'true');
  assert.equal(byGroup('仙侠').textContent, '仙侠 · 1 本');
  assert.equal(byGroup('仙侠').getAttribute('aria-current'), null, '别的分组不打勾');
  assert.equal(byGroup('').textContent, '未分组 · 1 本');
  assert.equal(buttons.find((el) => el.dataset.action === 'move-group-new').textContent, '新建分组…');

  const result = await ctx.ui.moveBookToGroup(books[0], '仙侠');
  assert.deepEqual(ctx.calls.updateBookInfo, [['/库/甲', { group: '仙侠' }]], '只动这一本，不顺手改同组的另一本');
  assert.equal(result.changed, 1);
  assert.match(ctx.calls.toast[0][0], /已移入 1 本到「仙侠」/);

  // 损坏书：列表打开与执行都拒绝
  const corrupt = build({ books: [makeBook({ status: 'corrupt' })] });
  assert.equal(corrupt.ui.openBookGroupChooser(corrupt.state.books[0]), false);
  assert.deepEqual(await corrupt.ui.moveBookToGroup(corrupt.state.books[0], '仙侠'), { ok: false });
  assert.deepEqual(corrupt.calls.promptText, []);
  assert.equal(corrupt.calls.toast[0][1], 'warn');

  // 没变化：同名（含首尾空格）不写盘；没选目标（undefined）也不写
  const same = build({ books });
  assert.equal((await same.ui.moveBookToGroup(books[0], ' 玄幻 ')).changed, 0);
  assert.deepEqual(same.calls.updateBookInfo, []);
  assert.deepEqual(await same.ui.moveBookToGroup(books[0]), { ok: false });
  assert.deepEqual(same.calls.updateBookInfo, []);

  // 收起列表：清空并隐藏
  assert.equal(ctx.ui.closeBookGroupChooser(), true);
  assert.equal(holder.children.length, 0);
  assert.equal(holder.classList.contains('hidden'), true);
});

test('移到分组：未分组的书在列表里「未分组」打勾；「新建分组…」问名字后只写这一本', async () => {
  const books = [
    makeBook({ path: '/库/甲', title: '甲', group: '玄幻' }),
    makeBook({ path: '/库/丙', title: '丙', group: '仙侠' }),
    makeBook({ path: '/库/丁', title: '丁' })
  ];
  const ctx = build({ books });
  const loose = books[2];
  assert.equal(ctx.ui.openBookGroupChooser(loose), true);
  const buttons = ctx.dom.map.get('book-menu-groups').children.filter((el) => el.tagName === 'button');
  const ungrouped = buttons.find((el) => (el.dataset.group || '') === '');
  assert.equal(ungrouped.textContent, '✓ 未分组 · 1 本');
  assert.equal(ungrouped.getAttribute('aria-current'), 'true');

  const creating = build({ books, promptAnswers: ['新组'] });
  const result = await creating.ui.newGroupForBook(books[0]);
  assert.equal(creating.calls.promptText[0].title, '新建分组');
  assert.deepEqual(creating.calls.updateBookInfo, [['/库/甲', { group: '新组' }]]);
  assert.equal(result.changed, 1);

  const canceled = build({ books, promptAnswers: [null] });
  const cancelResult = await canceled.ui.newGroupForBook(books[0]);
  assert.equal(cancelResult.canceled, true);
  assert.deepEqual(canceled.calls.updateBookInfo, []);
});

test('setupBookinfoUi（F5）：标签下拉改 state.shelfTag 并重渲染；「管理分组…」打开弹层、关闭按钮收起', () => {
  const ctx = build({ books: [makeBook({ group: '书友', tags: ['升级'] })] });
  ctx.ui.setupBookinfoUi();
  const tag = ctx.dom.map.get('shelf-tag-filter');
  tag.value = '升级';
  tag._fire('change', { target: tag });
  assert.equal(ctx.state.shelfTag, '升级');
  const manage = ctx.dom.map.get('btn-shelf-group-manage');
  manage._fire('click', {});
  assert.equal(ctx.dom.map.get('group-manage-backdrop').classList.contains('hidden'), false);
  ctx.dom.map.get('btn-group-manage-close')._fire('click', {});
  assert.equal(ctx.dom.map.get('group-manage-backdrop').classList.contains('hidden'), true);
});
