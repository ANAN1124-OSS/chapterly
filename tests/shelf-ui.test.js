const test = require('node:test');
const assert = require('node:assert/strict');
const shelfUi = require('../renderer/shelf-ui');
const { loadSourceGate, restoreGlobalsAfter } = require('./ui-test-preambles');

// v0.9 B-5 第六刀：三个小分区（「继续上次写作」42 行 +「同步冲突副本提示」27 行 +
// 「切换 / 新建 / 重命名 / 删除」27 行，合计 96 行）从 renderer.js 搬到 renderer/shelf-ui.js。
// 搬之前这三块只有 E2E 黑盒覆盖（点继续写作卡、开冲突清单、切章时被未保存拦一次），
// 「书被删了藏卡片 / corrupt 书藏卡片 / 章节下标越界怎么夹 / 取消和保存失败怎么返回」
// 这些分支在 Node 里一步都测不到。搬出来以后用「假 host + 假 DOM」逐条钉住文案与返回值，
// 再用静态闸门保证渲染层不许长回第二份实现。

// 模块运行时会摸 document：真身由共享前导存下，test.after 放回。
restoreGlobalsAfter(test, ['document']);

const { rendererSrc, indexSrc, moduleSrc, moduleCode } = loadSourceGate('shelf-ui.js');

function makeEl(id) {
  const classes = new Set();
  const el = {
    id,
    tagName: '',
    className: '',
    textContent: '',
    title: '',
    dataset: {},
    children: [],
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      toggle(name, on) {
        const next = on === undefined ? !classes.has(name) : Boolean(on);
        if (next) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name)
    },
    appendChild(child) { this.children.push(child); return child; },
    _classes: classes
  };
  // 代码里靠 `list.innerHTML = ''` 清清单；假 DOM 也要真的清，否则第二次渲染会数错行
  let innerHTML = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return innerHTML; },
    set(value) {
      innerHTML = value;
      if (value === '') el.children = [];
    },
    enumerable: true
  });
  return el;
}

// 模块运行时摸 document（createElement），Node 里给一个最小替身。
function installDocument() {
  const created = [];
  globalThis.document = {
    createElement(tag) {
      const el = makeEl(tag);
      el.tagName = String(tag).toUpperCase();
      created.push(el);
      return el;
    }
  };
  return created;
}

function makeHost(options = {}) {
  const els = new Map();
  const opened = [];
  const asked = [];
  const saved = [];
  const loaded = [];
  const state = {
    view: options.view || 'shelf',
    index: options.index === undefined ? 0 : options.index,
    chapters: options.chapters || [
      { id: 'c1', name: '第一章' },
      { id: 'c2', name: '第二章' },
      { id: 'c3', name: '第三章' }
    ],
    dirty: Boolean(options.dirty),
    books: options.books || [],
    recentBook: options.recentBook || null,
    conflictBook: null
  };
  const host = {
    $: (id) => {
      if (options.missing && options.missing.includes(id)) return null;
      if (!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
    state,
    chapterTitle: (index, name) => `第${index + 1}章：${name}`,
    formatRelativeTime: (ts) => `相对时间:${ts}`,
    async openBookByPath(bookPath) {
      opened.push(bookPath);
      if (options.afterOpen) options.afterOpen(state, bookPath);
      return { ok: true };
    },
    async askUnsaved(payload) {
      asked.push(payload);
      if (options.onAskUnsaved) return options.onAskUnsaved(payload);
      return 'cancel';
    },
    async saveCurrent() {
      saved.push(true);
      if (options.onSaveCurrent) return options.onSaveCurrent();
      return { ok: true };
    },
    async loadChapterAt(index) {
      loaded.push(index);
      state.index = index;
      return { ok: true };
    }
  };
  return { host, state, els, opened, asked, saved, loaded };
}

const BOOK = { title: '测试书', path: 'C:/tmp/books/测试书', chapterCount: 3, status: 'ok' };

test('host 契约：8 个成员缺任何一个都抛 TypeError，空 host / null 也抛', () => {
  const { host } = makeHost();
  assert.deepEqual(
    [...shelfUi.REQUIRED_HOST].sort(),
    ['$', 'state', 'chapterTitle', 'formatRelativeTime', 'openBookByPath', 'askUnsaved', 'saveCurrent', 'loadChapterAt'].sort()
  );
  assert.throws(() => shelfUi.create(null), /createShelfUi 需要 host 对象/);
  assert.throws(() => shelfUi.create('x'), /createShelfUi 需要 host 对象/);
  for (const key of shelfUi.REQUIRED_HOST) {
    const broken = { ...host };
    delete broken[key];
    assert.throws(() => shelfUi.create(broken), new RegExp('createShelfUi 的 host 缺少 ' + key.replace('$', '\\$')));
  }
  // null 也算缺（不是「用假值兜底」）
  assert.throws(() => shelfUi.create({ ...host, state: null }), /createShelfUi 的 host 缺少 state/);
});

test('create() 只建表：没有 document 也能创建，6 个入口都在且都是函数', () => {
  const { host } = makeHost();
  delete globalThis.document;
  const ui = shelfUi.create(host);
  assert.deepEqual(Object.keys(ui).sort(), [
    'closeConflictDialog', 'currentChapterLabel', 'openConflictDialog',
    'openContinueBook', 'renderContinueWriting', 'switchChapter'
  ].sort());
  for (const name of Object.keys(ui)) assert.equal(typeof ui[name], 'function', name);
  // continueTarget 是模块内部细节，不导出（渲染层用不到）
  assert.equal(ui.continueTarget, undefined);
});

test('renderContinueWriting：没有最近书 / 卡片元素不在 → 只藏卡片，不报错', () => {
  installDocument();
  const a = makeHost({ recentBook: null });
  const uiA = shelfUi.create(a.host);
  uiA.renderContinueWriting();
  assert.equal(a.host.$('shelf-continue').classList.contains('hidden'), true);

  // 书架上没有这个元素（旧 DOM / 别的视图）时安静返回，不抛
  const b = makeHost({ recentBook: { path: BOOK.path, chapterIndex: 0 }, missing: ['shelf-continue'] });
  assert.doesNotThrow(() => shelfUi.create(b.host).renderContinueWriting());
});

test('renderContinueWriting：书被删 / 被改名 / 坏书 → 藏卡片（不做任何猜测）', () => {
  installDocument();
  // 书库里找不到
  const gone = makeHost({ recentBook: { path: 'C:/tmp/books/已删除', chapterIndex: 0 }, books: [BOOK] });
  shelfUi.create(gone.host).renderContinueWriting();
  assert.equal(gone.host.$('shelf-continue').classList.contains('hidden'), true);

  // 坏书：即便 path 对得上也藏
  const corrupt = makeHost({
    recentBook: { path: BOOK.path, chapterIndex: 0 },
    books: [{ ...BOOK, status: 'corrupt' }]
  });
  shelfUi.create(corrupt.host).renderContinueWriting();
  assert.equal(corrupt.host.$('shelf-continue').classList.contains('hidden'), true);
});

test('renderContinueWriting：path 比对大小写不敏感，标题 / title 属性 / 元信息逐字一致', () => {
  installDocument();
  const { host, state } = makeHost({
    recentBook: { path: 'c:/TMP/books/测试书', chapterIndex: 1, chapterName: '旧章名', at: 'T1' },
    books: [{ ...BOOK, chapterCount: 3, path: 'C:/tmp/BOOKS/测试书' }]
  });
  const ui = shelfUi.create(host);
  const wrap = host.$('shelf-continue');
  wrap.classList.add('hidden');
  ui.renderContinueWriting();
  assert.equal(wrap.classList.contains('hidden'), false);
  const titleEl = host.$('continue-title');
  assert.equal(titleEl.textContent, '继续写《测试书》 · 第2章：旧章名');
  assert.equal(titleEl.title, '继续写《测试书》 · 第2章：旧章名');
  assert.equal(host.$('continue-meta').textContent, '最后写作 相对时间:T1 · 共 3 章');
  // 只读：不碰 state 的其余字段，也不写盘
  assert.equal(state.recentBook.chapterIndex, 1);
  assert.deepEqual(state.books, [{ ...BOOK, chapterCount: 3, path: 'C:/tmp/BOOKS/测试书' }]);
});

test('renderContinueWriting：章节下标夹取（越界取末章 / 负数取 0）+ 0 章时不留「共 0 章」', () => {
  installDocument();
  // chapterIndex 越界 → 夹到 total-1
  const over = makeHost({
    recentBook: { path: BOOK.path, chapterIndex: 99, chapterName: '第三章' },
    books: [BOOK]
  });
  shelfUi.create(over.host).renderContinueWriting();
  assert.equal(over.host.$('continue-title').textContent, '继续写《测试书》 · 第3章：第三章');

  // 负数 → 0
  const under = makeHost({
    recentBook: { path: BOOK.path, chapterIndex: -5, chapterName: '第一章' },
    books: [BOOK]
  });
  shelfUi.create(under.host).renderContinueWriting();
  assert.equal(under.host.$('continue-title').textContent, '继续写《测试书》 · 第1章：第一章');

  // 0 章（空书）：不拼章节标签，也不写「共 0 章」；只剩「最后写作」
  const empty = makeHost({
    recentBook: { path: BOOK.path, chapterIndex: 0, at: 'T2' },
    books: [{ ...BOOK, chapterCount: 0 }]
  });
  shelfUi.create(empty.host).renderContinueWriting();
  assert.equal(empty.host.$('continue-title').textContent, '继续写《测试书》');
  assert.equal(empty.host.$('continue-meta').textContent, '最后写作 相对时间:T2');
});

test('openContinueBook：没有可继续的书 → { ok:false, message } 且不打开任何书', async () => {
  const { host, opened } = makeHost({ recentBook: null, books: [BOOK] });
  const result = await shelfUi.create(host).openContinueBook();
  assert.deepEqual(result, { ok: false, message: '没有可继续的书' });
  assert.deepEqual(opened, []);
});

test('openContinueBook：打开那本书，返回值按打开后的 view / index 组成', async () => {
  // 打开成功 → 进编辑器
  const ok = makeHost({
    recentBook: { path: BOOK.path, chapterIndex: 2 },
    books: [BOOK],
    afterOpen: (state, bookPath) => {
      state.view = 'editor';
      state.index = 2;
    }
  });
  assert.deepEqual(await shelfUi.create(ok.host).openContinueBook(), { ok: true, index: 2 });
  assert.deepEqual(ok.opened, [BOOK.path]);

  // 打开失败 → ok:false（视图还停在书架），但 index 照原样报
  const bad = makeHost({ recentBook: { path: BOOK.path, chapterIndex: 1 }, books: [BOOK] });
  assert.deepEqual(await shelfUi.create(bad.host).openContinueBook(), { ok: false, index: 0 });
});

test('openConflictDialog：没有书 / 没有冲突副本 → 完全不动界面与 state', () => {
  installDocument();
  const { host, state } = makeHost();
  const ui = shelfUi.create(host);
  const backdrop = host.$('conflict-backdrop');
  backdrop.classList.add('hidden');
  ui.openConflictDialog(null);
  ui.openConflictDialog({ title: '没有冲突的书', path: BOOK.path });
  ui.openConflictDialog({ title: '空数组', conflicts: [] });
  assert.equal(state.conflictBook, null);
  assert.equal(backdrop.classList.contains('hidden'), true);
  assert.equal(host.$('conflict-summary').textContent, '');
  assert.deepEqual(host.$('conflict-files').children, []);
});

test('openConflictDialog：记 state.conflictBook、三段文案逐字一致、清单逐行建 div，backdrop 打开', () => {
  const created = installDocument();
  const book = { title: '测试书', folder: '测试书文件夹', path: BOOK.path, conflicts: ['副本1.txt', '副本2.txt'] };
  const { host, state } = makeHost();
  const ui = shelfUi.create(host);
  const backdrop = host.$('conflict-backdrop');
  const list = host.$('conflict-files');
  backdrop.classList.add('hidden');
  list.appendChild(makeEl('旧行'));

  ui.openConflictDialog(book);
  assert.equal(state.conflictBook, book);
  assert.equal(host.$('conflict-book').textContent, `《测试书》 · ${BOOK.path}`);
  assert.equal(host.$('conflict-book').title, BOOK.path);
  assert.equal(host.$('conflict-summary').textContent, '共 2 个冲突副本（只提示，不会自动合并或删除）');
  assert.equal(backdrop.classList.contains('hidden'), false);
  // 旧的清单先清掉，再逐行建
  assert.equal(list.children.length, 2);
  assert.equal(list.children[0].className, 'conflict-file');
  assert.equal(list.children[0].textContent, '副本1.txt');
  assert.equal(list.children[0].title, '副本1.txt');
  assert.equal(list.children[1].textContent, '副本2.txt');
  assert.equal(created.length, 2);
});

test('openConflictDialog：书名缺失时用文件夹名兜底，path 缺失时写空串不写 undefined', () => {
  installDocument();
  const { host } = makeHost();
  const ui = shelfUi.create(host);
  ui.openConflictDialog({ folder: '只有文件夹', conflicts: ['a.txt'] });
  assert.equal(host.$('conflict-book').textContent, '《只有文件夹》 · ');
  assert.equal(host.$('conflict-book').title, '');
});

test('closeConflictDialog：清 state.conflictBook 并给 backdrop 加 hidden（可重复调用）', () => {
  installDocument();
  const { host, state } = makeHost();
  const ui = shelfUi.create(host);
  const backdrop = host.$('conflict-backdrop');
  ui.openConflictDialog({ title: '书', path: BOOK.path, conflicts: ['a.txt'] });
  assert.equal(backdrop.classList.contains('hidden'), false);
  ui.closeConflictDialog();
  assert.equal(state.conflictBook, null);
  assert.equal(backdrop.classList.contains('hidden'), true);
  ui.closeConflictDialog();
  assert.equal(state.conflictBook, null);
  assert.equal(backdrop.classList.contains('hidden'), true);
});

test('currentChapterLabel：越界 / 缺章时给「当前章节」，否则走 chapterTitle 口径', () => {
  const empty = makeHost({ index: -1 });
  assert.equal(shelfUi.create(empty.host).currentChapterLabel(), '当前章节');

  const outOfRange = makeHost({ index: 9 });
  assert.equal(shelfUi.create(outOfRange.host).currentChapterLabel(), '当前章节');

  const ok = makeHost({ index: 1 });
  assert.equal(shelfUi.create(ok.host).currentChapterLabel(), '第2章：第二章');
});

test('switchChapter：同章 / 越界都在动手之前就返回，不保存也不加载', async () => {
  const same = makeHost({ index: 1 });
  assert.deepEqual(await shelfUi.create(same.host).switchChapter(1), { ok: true, same: true });
  assert.deepEqual(same.loaded, []);

  const low = makeHost({ index: 1 });
  assert.deepEqual(await shelfUi.create(low.host).switchChapter(-1), { ok: false, message: '章节不存在' });
  const high = makeHost({ index: 1 });
  assert.deepEqual(await shelfUi.create(high.host).switchChapter(3), { ok: false, message: '章节不存在' });
  assert.deepEqual(low.loaded, []);
  assert.deepEqual(high.loaded, []);
});

test('switchChapter：不脏 → 直接 loadChapterAt，返回 { ok:true }', async () => {
  const { host, loaded, saved } = makeHost({ index: 0 });
  assert.deepEqual(await shelfUi.create(host).switchChapter(2), { ok: true });
  assert.deepEqual(loaded, [2]);
  assert.deepEqual(saved, []);
});

test('switchChapter：脏 + dirtyAction=cancel → 取消标记，不保存不加载', async () => {
  const { host, loaded, saved, asked } = makeHost({ index: 0, dirty: true });
  assert.deepEqual(await shelfUi.create(host).switchChapter(2, { dirtyAction: 'cancel' }), { ok: false, canceled: true });
  assert.deepEqual(asked, []);
  assert.deepEqual(saved, []);
  assert.deepEqual(loaded, []);
});

test('switchChapter：脏且没给 dirtyAction → 弹询问框，文案带当前章节标签', async () => {
  const { host, asked, loaded } = makeHost({ index: 1, dirty: true, onAskUnsaved: () => 'discard' });
  assert.deepEqual(await shelfUi.create(host).switchChapter(2), { ok: true });
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0], {
    title: '切换章节前保存',
    message: '「第2章：第二章」有未保存的修改，切换会丢失这些内容。'
  });
  assert.deepEqual(loaded, [2]);
});

test('switchChapter：脏 + save → 保存失败原样透传（不加载），保存成功才切章', async () => {
  const failed = makeHost({
    index: 0,
    dirty: true,
    onAskUnsaved: () => 'save',
    onSaveCurrent: () => ({ ok: false, message: '写盘失败' })
  });
  assert.deepEqual(await shelfUi.create(failed.host).switchChapter(2), { ok: false, message: '写盘失败' });
  assert.deepEqual(failed.saved, [true]);
  assert.deepEqual(failed.loaded, []);

  const ok = makeHost({ index: 0, dirty: true, onAskUnsaved: () => 'save' });
  assert.deepEqual(await shelfUi.create(ok.host).switchChapter(2), { ok: true });
  assert.deepEqual(ok.saved, [true]);
  assert.deepEqual(ok.loaded, [2]);
});

test('静态闸门：三段实现已经不在 renderer.js 里，渲染层只剩接线', () => {
  // 函数名不许再以「实现」的形式出现在渲染层（只允许 const 接线）
  for (const impl of [
    '  function continueTarget() {',
    '  function renderContinueWriting() {',
    '  async function openContinueBook() {',
    '  function openConflictDialog(book) {',
    '  function closeConflictDialog() {',
    '  function currentChapterLabel() {',
    '  async function switchChapter(index, options = {}) {'
  ]) {
    assert.equal(rendererSrc.includes(impl), false, impl);
  }
  // 装配只有一处，host 成员逐个点名
  assert.equal((rendererSrc.match(/shelfUiModule\.create\(/g) || []).length, 1);
  for (const key of ['$', 'state', 'chapterTitle', 'formatRelativeTime', 'openBookByPath', 'askUnsaved', 'saveCurrent', 'loadChapterAt']) {
    assert.match(rendererSrc, new RegExp('shelfUiModule\\.create\\(\\{[\\s\\S]{0,400}' + key.replace(/\$/g, '\\$') + '(?=[,\\s}])'));
  }
  // 入口仍以原名在渲染层可见（事件绑定 / Esc 动作表 / 测试钩子按名字取）
  for (const name of ['renderContinueWriting', 'openContinueBook', 'openConflictDialog', 'closeConflictDialog', 'currentChapterLabel', 'switchChapter']) {
    assert.match(rendererSrc, new RegExp('const \\{[^}]*\\b' + name + '\\b[^}]*\\} = shelfUi'));
  }
});

test('静态闸门：index.html 在 renderer.js 之前加载 shelf-ui.js，且只加载一次', () => {
  const at = indexSrc.indexOf('<script src="shelf-ui.js"></script>');
  const rendererAt = indexSrc.indexOf('<script src="renderer.js"></script>');
  assert.notEqual(at, -1);
  assert.notEqual(rendererAt, -1);
  assert.ok(at < rendererAt, 'shelf-ui.js 必须排在 renderer.js 之前');
  assert.equal(indexSrc.split('shelf-ui.js').length - 1, 1);
  // 模块自己挂全局 CWShelfUi，渲染层按这个全局名字取
  assert.match(moduleSrc, /root\.CWShelfUi = factory\(\);/);
  assert.match(rendererSrc, /const shelfUiModule = window\.CWShelfUi;/);
});

test('静态闸门：模块只读 state / 只碰 DOM，不摸文件系统与 IPC', () => {
  for (const forbidden of ['require(', 'ipcRenderer', 'node:fs', 'child_process', 'localStorage', 'fetch(']) {
    assert.equal(moduleCode.includes(forbidden), false, forbidden);
  }
  // 只对 state 做读 + 一处写（冲突对话框记 conflictBook，与搬之前同一行）
  assert.match(moduleCode, /state\.conflictBook = book;/);
  assert.match(moduleCode, /state\.conflictBook = null;/);
  // 不注册任何事件、不进 Esc 动作表（那是渲染层的事）
  assert.equal(moduleCode.includes('addEventListener'), false);
  assert.equal(moduleCode.includes('removeEventListener'), false);
});
