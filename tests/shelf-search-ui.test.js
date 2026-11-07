const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const shelfSearchUi = require('../renderer/shelf-search-ui');
const { loadSourceGate, withoutGlobals } = require('./ui-test-preambles');

// v0.9 B-5 第八刀：「书架正文搜索」分区（85 行）从 renderer.js 搬到 renderer/shelf-search-ui.js。
// 搬出来以后用「假 host + 假 state」逐条钉住正文搜索的异步链路：320ms 防抖、令牌旧响应丢弃、
// 只有书架视图才渲染、索引状态刷新、失败静默、打开命中透传 chapterId / matchIndex / matchLength，
// 再用静态闸门保证渲染层不许长回第二份实现。

const { rendererSrc, indexSrc, moduleSrc, moduleCode } = loadSourceGate('shelf-search-ui.js');

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeHost(options = {}) {
  const state = {
    view: options.view === undefined ? 'shelf' : options.view,
    shelfQuery: options.shelfQuery === undefined ? '张三' : options.shelfQuery,
    shelfContent: {
      token: options.token === undefined ? 0 : options.token,
      timer: options.timer === undefined ? null : options.timer,
      loading: Boolean(options.loading),
      results: options.results || [],
      meta: options.meta || null,
      error: options.error || null,
      shown: options.shown === undefined ? 999 : options.shown,
      query: options.contentQuery === undefined ? '' : options.contentQuery,
      indexStatus: options.indexStatus === undefined ? null : options.indexStatus
    }
  };
  const calls = { renderShelfContent: 0, renderShelf: 0, search: [], index: [], open: [] };
  let queryText = options.queryText === undefined ? '张三' : options.queryText;
  let active = options.active === undefined ? null : options.active;
  const host = {
    state,
    CONTENT_PAGE_SIZE: 8,
    CONTENT_SEARCH_DEBOUNCE: 320,
    CONTENT_RESULT_LIMIT: 40,
    renderShelfContent() {
      calls.renderShelfContent += 1;
    },
    renderShelf() {
      calls.renderShelf += 1;
    },
    shelfQueryText() {
      return String(queryText).trim();
    },
    shelfContentActive() {
      return active === null ? state.view === 'shelf' && String(queryText).trim().length >= 2 : active;
    },
    call(fn, ...args) {
      calls.search.push({ fn, args });
      if (options.onCall) return options.onCall(fn, args);
      return Promise.resolve({
        results: options.payloadResults || [{ bookPath: 'C:/tmp/books/书甲', chapterId: 'c1', matchIndex: 2, matchLength: 2 }],
        index: options.payloadIndex === undefined ? { ready: true } : options.payloadIndex
      });
    },
    api: { searchContent: 'search:content', ensureSearchIndex: 'index:ensure' },
    openBookByPath(bookPath, target) {
      calls.open.push({ bookPath, target });
      return Promise.resolve('opened');
    }
  };
  return {
    host,
    state,
    calls,
    setQueryText(value) {
      queryText = value;
    },
    setActive(value) {
      active = value;
    }
  };
}

test('host 契约：11 个成员缺任何一个都抛 TypeError，空 host / null 也抛', () => {
  const { host } = makeHost();
  assert.deepEqual([...shelfSearchUi.REQUIRED_HOST].sort(), [
    'CONTENT_PAGE_SIZE',
    'CONTENT_RESULT_LIMIT',
    'CONTENT_SEARCH_DEBOUNCE',
    'api',
    'call',
    'openBookByPath',
    'renderShelf',
    'renderShelfContent',
    'shelfContentActive',
    'shelfQueryText',
    'state'
  ]);
  assert.throws(() => shelfSearchUi.create(null), /createShelfSearchUi 需要 host 对象/);
  assert.throws(() => shelfSearchUi.create('x'), /createShelfSearchUi 需要 host 对象/);
  for (const key of shelfSearchUi.REQUIRED_HOST) {
    const broken = { ...host };
    delete broken[key];
    assert.throws(() => shelfSearchUi.create(broken), /缺少/, key);
    const nulled = { ...host, [key]: null };
    assert.throws(() => shelfSearchUi.create(nulled), /缺少/, key + '（null 也算缺）');
  }
  assert.doesNotThrow(() => shelfSearchUi.create(host));
});

test('create() 只建表：不碰 DOM / 不挂监听 / 不建定时器，交出 5 个入口（P22-4 加展开）', () => {
  // 临时藏起 document / window：不放假的替身，直接验证「没有也不炸」。
  withoutGlobals(['document', 'window'], () => {
    const { host, state, calls } = makeHost();
    const ui = shelfSearchUi.create(host);
    assert.deepEqual(Object.keys(ui).sort(), [
      'ensureSearchIndex',
      'expandContentChapter',
      'openContentResult',
      'resetShelfContent',
      'scheduleContentSearch'
    ]);
    for (const name of Object.keys(ui)) assert.equal(typeof ui[name], 'function', name);
    // runContentSearch 是内部件，不导出（区外 0 引用；导出会让 sweep ⑤ 新增一条）
    assert.equal(ui.runContentSearch, undefined);
    assert.equal(state.shelfContent.timer, null);
    assert.equal(calls.renderShelfContent, 0);
    assert.deepEqual(calls.search, []);
  });
});

test('resetShelfContent(true)：令牌 +1、清掉防抖定时器、清结果与错误，但保留查询词', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { host, state, calls } = makeHost({ token: 3, results: [{ id: 'old' }], meta: { old: true }, error: '旧错误', shown: 32, contentQuery: '旧词' });
  state.shelfContent.timer = setTimeout(() => {
    throw new Error('旧定时器不该再跑');
  }, 320);
  const ui = shelfSearchUi.create(host);
  ui.resetShelfContent(true);
  const content = state.shelfContent;
  assert.equal(content.token, 4);
  assert.equal(content.timer, null);
  assert.equal(content.loading, false);
  assert.deepEqual(content.results, []);
  assert.equal(content.meta, null);
  assert.equal(content.error, null);
  assert.equal(content.shown, 8);
  assert.equal(content.query, '旧词');
  assert.equal(calls.renderShelfContent, 1);
  // 清掉的定时器不会再跑
  assert.equal(t.mock.timers.tick(320) === undefined, true);
});

test('resetShelfContent()：默认连查询词一起清掉', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { host, state } = makeHost({ token: 7, contentQuery: '旧词' });
  shelfSearchUi.create(host).resetShelfContent();
  assert.equal(state.shelfContent.token, 8);
  assert.equal(state.shelfContent.query, '');
  assert.equal(state.shelfContent.shown, 8);
});

test('scheduleContentSearch：正文搜索不活跃 → 只重置（保留查询词），一个定时器都不建', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { host, state, calls, setActive } = makeHost({ token: 2, contentQuery: '旧词' });
  setActive(false);
  shelfSearchUi.create(host).scheduleContentSearch();
  assert.equal(state.shelfContent.token, 4);
  assert.equal(state.shelfContent.timer, null);
  assert.equal(state.shelfContent.loading, false);
  assert.deepEqual(state.shelfContent.results, []);
  assert.equal(state.shelfContent.query, '旧词');
  assert.equal(calls.renderShelfContent, 1);
  t.mock.timers.tick(320);
  return flush().then(() => {
    assert.deepEqual(calls.search, []);
  });
});

test('scheduleContentSearch：活跃 → 320ms 后按 limit 40 查一次，结果 / meta / 索引状态落到 state', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { host, state, calls, setQueryText } = makeHost({ token: 5, shown: 32 });
  setQueryText('  张三  ');
  const ui = shelfSearchUi.create(host);
  ui.scheduleContentSearch();
  const content = state.shelfContent;
  assert.equal(content.token, 6);
  assert.equal(content.query, '张三');
  assert.equal(content.loading, true);
  assert.deepEqual(content.results, []);
  assert.equal(content.meta, null);
  assert.equal(content.error, null);
  assert.equal(content.shown, 8);
  assert.notEqual(content.timer, null);
  assert.equal(calls.renderShelfContent, 1);
  assert.deepEqual(calls.search, []);

  t.mock.timers.tick(320);
  await flush();
  assert.equal(calls.search.length, 1);
  assert.equal(calls.search[0].fn, 'search:content');
  assert.deepEqual(calls.search[0].args, ['张三', { limit: 40 }]);
  assert.equal(state.shelfContent.loading, false);
  assert.deepEqual(state.shelfContent.results, [
    { bookPath: 'C:/tmp/books/书甲', chapterId: 'c1', matchIndex: 2, matchLength: 2 }
  ]);
  assert.deepEqual(state.shelfContent.meta, {
    results: [{ bookPath: 'C:/tmp/books/书甲', chapterId: 'c1', matchIndex: 2, matchLength: 2 }],
    index: { ready: true }
  });
  assert.deepEqual(state.shelfContent.indexStatus, { ready: true });
  assert.equal(state.shelfContent.error, null);
  assert.equal(calls.renderShelf, 1);
});

test('scheduleContentSearch：连敲两次只查最后一次（防抖 + 令牌自增）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { host, state, calls, setQueryText } = makeHost({ token: 0 });
  const ui = shelfSearchUi.create(host);
  setQueryText('张三');
  ui.scheduleContentSearch();
  const firstTimer = state.shelfContent.timer;
  setQueryText('张三丰');
  ui.scheduleContentSearch();
  assert.notEqual(state.shelfContent.timer, firstTimer, '第二次调度换成了新定时器');
  assert.equal(state.shelfContent.token, 2);
  t.mock.timers.tick(160); // 旧定时器原定 320ms 已被清
  assert.deepEqual(calls.search, []);
  t.mock.timers.tick(160);
  await flush();
  assert.equal(calls.search.length, 1);
  assert.equal(calls.search[0].args[0], '张三丰');
});

test('runContentSearch：令牌对不上（已经重新查过）→ 旧响应整包丢弃，不写 state 不渲染', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred();
  const { host, state, calls } = makeHost({ onCall: () => pending.promise });
  const ui = shelfSearchUi.create(host);
  ui.scheduleContentSearch(); // token 1
  t.mock.timers.tick(320);
  ui.resetShelfContent(true); // token 2：旧响应回来时已过期
  pending.resolve({ results: [{ stale: true }], index: { ready: false } });
  await flush();
  assert.deepEqual(state.shelfContent.results, []);
  assert.equal(state.shelfContent.meta, null);
  assert.equal(state.shelfContent.indexStatus, null);
  assert.equal(calls.renderShelf, 0);
});

test('runContentSearch：响应回来时已不在书架视图 → 丢弃，不渲染', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred();
  const { host, state, calls } = makeHost({ onCall: () => pending.promise });
  const ui = shelfSearchUi.create(host);
  ui.scheduleContentSearch();
  t.mock.timers.tick(320);
  state.view = 'editor';
  pending.resolve({ results: [{ id: 'x' }], index: { ready: true } });
  await flush();
  assert.deepEqual(state.shelfContent.results, []);
  assert.equal(calls.renderShelf, 0);
});

test('runContentSearch：主进程报错 → loading 关掉、error 记消息、meta 清空、仍渲染一次', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { host, state, calls } = makeHost({
    onCall: () => Promise.reject(new Error('索引损坏'))
  });
  const ui = shelfSearchUi.create(host);
  ui.scheduleContentSearch();
  t.mock.timers.tick(320);
  await flush();
  assert.equal(state.shelfContent.loading, false);
  assert.equal(state.shelfContent.error, '索引损坏');
  assert.equal(state.shelfContent.meta, null);
  assert.deepEqual(state.shelfContent.results, []);
  assert.equal(calls.renderShelf, 1);
});

test('runContentSearch：results 不是数组 → 当空结果（不把非数组塞进 state）', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { host, state } = makeHost({
    onCall: () => Promise.resolve({ results: null, index: { ready: true } })
  });
  const ui = shelfSearchUi.create(host);
  ui.scheduleContentSearch();
  t.mock.timers.tick(320);
  await flush();
  assert.deepEqual(state.shelfContent.results, []);
  assert.deepEqual(state.shelfContent.indexStatus, { ready: true });
});

test('ensureSearchIndex：默认 force:false / deep:true，状态落到 state 且只在书架视图渲染', async () => {
  const shelfCase = makeHost();
  shelfCase.host.call = (fn, ...args) => {
    shelfCase.calls.index.push({ fn, args });
    return Promise.resolve({ ready: true, files: 3 });
  };
  const ui = shelfSearchUi.create(shelfCase.host);
  const status = await ui.ensureSearchIndex();
  assert.deepEqual(status, { ready: true, files: 3 });
  assert.deepEqual(shelfCase.calls.index[0], {
    fn: 'index:ensure',
    args: [{ force: false, deep: true }]
  });
  assert.deepEqual(shelfCase.state.shelfContent.indexStatus, { ready: true, files: 3 });
  assert.equal(shelfCase.calls.renderShelfContent, 1);

  const editorCase = makeHost({ view: 'editor' });
  editorCase.host.call = () => Promise.resolve({ ready: true });
  await shelfSearchUi.create(editorCase.host).ensureSearchIndex({ force: true, deep: false });
  assert.deepEqual(editorCase.calls.index, []);
  assert.equal(editorCase.calls.renderShelfContent, 0);
});

test('ensureSearchIndex：选项透传（force / deep 只认真布尔口径），失败静默返回 null', async () => {
  const { host, calls } = makeHost();
  host.call = (fn, ...args) => {
    calls.index.push({ fn, args });
    return Promise.resolve({ ready: true });
  };
  const ui = shelfSearchUi.create(host);
  await ui.ensureSearchIndex({ force: 1, deep: false });
  assert.deepEqual(calls.index[0].args, [{ force: true, deep: false }]);

  const failing = makeHost();
  failing.host.call = () => Promise.reject(new Error('索引不可用'));
  await assert.doesNotReject(async () => {
    assert.equal(await shelfSearchUi.create(failing.host).ensureSearchIndex(), null);
  });
  assert.equal(failing.state.shelfContent.indexStatus, null);
});

test('openContentResult：空行 / 没有书路径 → 什么都不做；正常行带三个命中字段打开', async () => {
  const { host, calls } = makeHost();
  const ui = shelfSearchUi.create(host);
  await ui.openContentResult(null);
  await ui.openContentResult({});
  await ui.openContentResult({ chapterId: 'c1' });
  assert.deepEqual(calls.open, []);

  await ui.openContentResult({
    bookPath: 'C:/tmp/books/书甲',
    chapterId: 'c3',
    matchIndex: 11,
    matchLength: 4
  });
  assert.deepEqual(calls.open, [
    {
      bookPath: 'C:/tmp/books/书甲',
      target: { chapterId: 'c3', matchIndex: 11, matchLength: 4 }
    }
  ]);
});

// ---------- P22-4：展开一章全部命中（expandContentChapter） ----------
const FOCUS_BOOK = 'C:/tmp/books/书甲';
const FOCUS_FILE = '001-第一章.txt';
const FOCUS_KEY = FOCUS_BOOK + '\u0000' + FOCUS_FILE;

function focusedRow(overrides = {}) {
  return {
    bookPath: FOCUS_BOOK,
    bookTitle: '书甲',
    chapterFile: FOCUS_FILE,
    chapterId: 'c1',
    chapterIndex: 0,
    chapterName: '第一章',
    chapterMatchCount: 10,
    matchIndex: 0,
    matchLength: 2,
    snippet: { before: '', match: '灯芯', after: '' },
    ...overrides
  };
}

test('expandContentChapter：只带书 + 章查本章全部（limit 40 + focus），loading → 结果落到 expanded', async () => {
  const rows = Array.from({ length: 10 }, (_, i) => focusedRow({ matchIndex: i * 4 }));
  const { host, state, calls } = makeHost({
    contentQuery: '灯芯',
    onCall: () => Promise.resolve({ focus: true, results: rows, truncated: false, limit: 200 })
  });
  const ui = shelfSearchUi.create(host);
  const pending = ui.expandContentChapter({ bookPath: FOCUS_BOOK, chapterFile: FOCUS_FILE });
  const entry = state.shelfContent.expanded[FOCUS_KEY];
  assert.ok(entry, 'expanded 第一次用时自动建表');
  assert.equal(entry.loading, true);
  assert.deepEqual(entry.rows, []);
  assert.equal(calls.renderShelfContent, 1);
  const done = await pending;
  assert.equal(done, true);
  assert.equal(calls.search.length, 1);
  assert.equal(calls.search[0].fn, 'search:content');
  assert.deepEqual(calls.search[0].args, [
    '灯芯',
    { limit: 40, focus: { bookPath: FOCUS_BOOK, chapterFile: FOCUS_FILE } }
  ]);
  assert.equal(entry.loading, false);
  assert.deepEqual(entry.rows, rows);
  assert.equal(entry.truncated, false);
  assert.equal(entry.error, null);
  assert.equal(calls.renderShelfContent, 2);
  assert.equal(calls.renderShelf, 0, '展开只重画正文结果区，不重建整张书架');
});

test('expandContentChapter：空行 / 没有 chapterFile 直接返回 false，一次查询都不发', async () => {
  const { host, state, calls } = makeHost({});
  const ui = shelfSearchUi.create(host);
  assert.equal(await ui.expandContentChapter(null), false);
  assert.equal(await ui.expandContentChapter({ bookPath: FOCUS_BOOK }), false);
  assert.equal(await ui.expandContentChapter({ chapterFile: FOCUS_FILE }), false);
  assert.deepEqual(calls.search, []);
  assert.equal(state.shelfContent.expanded, undefined, '无效行不改动展开态');
});

test('expandContentChapter：收起只删这一章的展开态并重画，不发查询', async () => {
  const { host, state, calls } = makeHost({ contentQuery: '灯芯' });
  state.shelfContent.expanded = { [FOCUS_KEY]: { loading: false, rows: [focusedRow()], error: null, truncated: false } };
  const ui = shelfSearchUi.create(host);
  assert.equal(await ui.expandContentChapter({ bookPath: FOCUS_BOOK, chapterFile: FOCUS_FILE }, { collapse: true }), true);
  assert.equal(FOCUS_KEY in state.shelfContent.expanded, false);
  assert.deepEqual(calls.search, []);
  assert.equal(calls.renderShelfContent, 1);
});

test('expandContentChapter：令牌变化 / 换查询 / 离开书架 / 已收起 → 旧响应整包丢弃', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scenarios = [
    {
      name: 'token 变了',
      mutate: (state) => { state.shelfContent.token += 1; },
      check: (state) => state.shelfContent.expanded[FOCUS_KEY].loading === true
    },
    {
      name: '查询词变了',
      mutate: (state) => { state.shelfContent.query = '别的词'; },
      check: (state) => state.shelfContent.expanded[FOCUS_KEY].loading === true
    },
    {
      name: '离开书架',
      mutate: (state) => { state.view = 'editor'; },
      check: (state) => state.shelfContent.expanded[FOCUS_KEY].loading === true
    },
    {
      name: '这一组已被收起',
      mutate: (state) => { delete state.shelfContent.expanded[FOCUS_KEY]; },
      check: (state) => state.shelfContent.expanded[FOCUS_KEY] === undefined
    }
  ];
  for (const scenario of scenarios) {
    const pending = deferred();
    const { host, state, calls } = makeHost({ contentQuery: '灯芯', onCall: () => pending.promise });
    const ui = shelfSearchUi.create(host);
    const run = ui.expandContentChapter({ bookPath: FOCUS_BOOK, chapterFile: FOCUS_FILE });
    scenario.mutate(state);
    pending.resolve({ focus: true, results: [focusedRow()], truncated: false });
    const result = await run;
    assert.equal(result, false, scenario.name);
    assert.equal(calls.renderShelfContent, 1, scenario.name + '：旧响应不重画');
    scenario.check(state);
  }
});

test('expandContentChapter：主进程回 focusError / 非 focus 结果 / 查询失败 → 行内错误、不再 loading', async () => {
  const focusFailed = makeHost({
    contentQuery: '灯芯',
    onCall: () => Promise.resolve({ focus: true, focusError: '聚焦的章节读取失败', results: [] })
  });
  const failUi = shelfSearchUi.create(focusFailed.host);
  assert.equal(await failUi.expandContentChapter({ bookPath: FOCUS_BOOK, chapterFile: FOCUS_FILE }), false);
  assert.equal(focusFailed.state.shelfContent.expanded[FOCUS_KEY].error, '聚焦的章节读取失败');
  assert.equal(focusFailed.state.shelfContent.expanded[FOCUS_KEY].loading, false);
  assert.equal(focusFailed.calls.renderShelfContent, 2);

  const notFocus = makeHost({
    contentQuery: '灯芯',
    onCall: () => Promise.resolve({ results: [focusedRow()] })
  });
  const notFocusUi = shelfSearchUi.create(notFocus.host);
  assert.equal(await notFocusUi.expandContentChapter({ bookPath: FOCUS_BOOK, chapterFile: FOCUS_FILE }), false);
  assert.equal(notFocus.state.shelfContent.expanded[FOCUS_KEY].error, '主进程没有返回本章结果');

  const rejected = makeHost({
    contentQuery: '灯芯',
    onCall: () => Promise.reject(new Error('索引坏了'))
  });
  const rejectUi = shelfSearchUi.create(rejected.host);
  assert.equal(await rejectUi.expandContentChapter({ bookPath: FOCUS_BOOK, chapterFile: FOCUS_FILE }), false);
  assert.equal(rejected.state.shelfContent.expanded[FOCUS_KEY].error, '索引坏了');

  const nullResults = makeHost({
    contentQuery: '灯芯',
    onCall: () => Promise.resolve({ focus: true, results: null, truncated: true })
  });
  const nullUi = shelfSearchUi.create(nullResults.host);
  assert.equal(await nullUi.expandContentChapter({ bookPath: FOCUS_BOOK, chapterFile: FOCUS_FILE }), true);
  assert.deepEqual(nullResults.state.shelfContent.expanded[FOCUS_KEY].rows, []);
  assert.equal(nullResults.state.shelfContent.expanded[FOCUS_KEY].truncated, true);
});

test('expandContentChapter：已经展开过再点一次直接用缓存重画，不重复查主进程', async () => {
  const { host, state, calls } = makeHost({ contentQuery: '灯芯' });
  state.shelfContent.expanded = { [FOCUS_KEY]: { loading: false, rows: [focusedRow()], error: null, truncated: false } };
  const ui = shelfSearchUi.create(host);
  assert.equal(await ui.expandContentChapter({ bookPath: FOCUS_BOOK, chapterFile: FOCUS_FILE }), true);
  assert.deepEqual(calls.search, []);
  assert.equal(calls.renderShelfContent, 1);
});

test('resetShelfContent / scheduleContentSearch / runContentSearch：换查询或重新搜索都清掉展开态', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const resetCase = makeHost({ token: 1, contentQuery: '灯芯' });
  resetCase.state.shelfContent.expanded = { [FOCUS_KEY]: { loading: false, rows: [focusedRow()] } };
  const resetUi = shelfSearchUi.create(resetCase.host);
  resetUi.resetShelfContent(true);
  assert.deepEqual(resetCase.state.shelfContent.expanded, {});

  const scheduleCase = makeHost({ token: 1, contentQuery: '旧词' });
  scheduleCase.state.shelfContent.expanded = { [FOCUS_KEY]: { loading: false, rows: [focusedRow()] } };
  const scheduleUi = shelfSearchUi.create(scheduleCase.host);
  scheduleUi.scheduleContentSearch();
  assert.deepEqual(scheduleCase.state.shelfContent.expanded, {}, '新的一次搜索开始时清空');

  const runCase = makeHost({ onCall: () => Promise.resolve({ results: [], index: { ready: true } }) });
  runCase.state.shelfContent.expanded = { [FOCUS_KEY]: { loading: false, rows: [focusedRow()] } };
  const runUi = shelfSearchUi.create(runCase.host);
  runUi.scheduleContentSearch();
  t.mock.timers.tick(320);
  await flush();
  assert.deepEqual(runCase.state.shelfContent.expanded, {}, '新结果回来时清空');
});

test('静态闸门：5 个实现已经不在 renderer.js 里，渲染层只剩接线', () => {
  for (const impl of [
    '  function resetShelfContent(keepQuery = false) {',
    '  function scheduleContentSearch() {',
    '  async function runContentSearch(query, token) {',
    '  async function expandContentChapter(row, options = {}) {',
    '  async function ensureSearchIndex(options = {}) {',
    '  async function openContentResult(row) {'
  ]) {
    assert.equal(rendererSrc.includes(impl), false, impl);
  }
  // 装配只有一处，host 成员逐个点名
  assert.equal((rendererSrc.match(/shelfSearchUiModule\.create\(/g) || []).length, 1);
  for (const key of shelfSearchUi.REQUIRED_HOST) {
    assert.match(rendererSrc, new RegExp('shelfSearchUiModule\\.create\\(\\{[\\s\\S]{0,400}' + key + '(?=[,\\s}])'));
  }
  // 入口仍以原名在渲染层可见（书架 / 事件绑定 / 测试钩子按名字取）
  assert.match(
    rendererSrc,
    /const \{ resetShelfContent, scheduleContentSearch, ensureSearchIndex, openContentResult \} = shelfSearchUi;/
  );
  assert.equal((rendererSrc.match(/= shelfSearchUi;/g) || []).length, 1);
  // P22-4：展开入口单独取第 5 个，再惰性转发给 shelf-filter-ui（不把实现搬回 renderer.js）。
  assert.match(rendererSrc, /const expandContentChapter = shelfSearchUi\.expandContentChapter;/);
  assert.match(rendererSrc, /expandContentChapter: \(row, options\) => expandContentChapter\(row, options\)/);
  // 测试钩子宿主契约里的两个键还在
  assert.match(rendererSrc, /\r?\n      scheduleContentSearch,\r?\n/);
  assert.match(rendererSrc, /\r?\n      ensureSearchIndex,\r?\n/);
});

test('静态闸门：index.html 在 renderer.js 之前加载 shelf-search-ui.js，且只加载一次', () => {
  const at = indexSrc.indexOf('<script src="shelf-search-ui.js"></script>');
  const rendererAt = indexSrc.indexOf('<script src="renderer.js"></script>');
  assert.notEqual(at, -1);
  assert.notEqual(rendererAt, -1);
  assert.ok(at < rendererAt, 'shelf-search-ui.js 必须排在 renderer.js 之前');
  assert.equal(indexSrc.split('shelf-search-ui.js').length - 1, 1);
  // 顺序：statusbar-ui.js → shelf-search-ui.js → renderer.js
  assert.ok(indexSrc.indexOf('<script src="statusbar-ui.js"></script>') < at);
  // 模块自己挂全局 CWShelfSearchUi，渲染层按这个全局名字取
  assert.match(moduleSrc, /root\.CWShelfSearchUi = factory\(\);/);
  assert.match(rendererSrc, /const shelfSearchUiModule = window\.CWShelfSearchUi;/);
});

test('静态闸门：模块不摸文件系统 / IPC / DOM / 存储，只读写 state.shelfContent', () => {
  for (const forbidden of ['require(', 'ipcRenderer', 'node:fs', 'child_process', 'localStorage', 'fetch(', 'document.', 'addEventListener', 'window.']) {
    assert.equal(moduleCode.includes(forbidden), false, forbidden);
  }
  // 只动 state.shelfContent 这一个子对象（正文搜索的既有效果），不许改 state 顶层字段
  assert.equal(/(?<![=!<>])state\.[A-Za-z_$][\w$]*\s*=(?!=)/.test(moduleCode), false, '模块不许写 state 顶层字段');
  assert.equal(moduleCode.includes('content.indexStatus ='), true);
  // 防抖 / 单次上限 / 每次多显示都来自 host，模块里不该再写死一份
  assert.equal(moduleCode.includes('320'), false, '320 从 host 来，模块里不许再写一份');
  assert.equal(moduleCode.includes('= 40'), false, '40 从 host 来，模块里不许再写一份');
  assert.equal(moduleCode.includes('= 8'), false, '8 从 host 来，模块里不许再写一份');
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWShelfSearchUi，且不乱造别的全局', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(moduleSrc, context, { filename: 'renderer/shelf-search-ui.js' });
  assert.equal(typeof win.CWShelfSearchUi, 'object');
  assert.deepEqual(Object.keys(win.CWShelfSearchUi).sort(), ['REQUIRED_HOST', 'create']);
  assert.deepEqual(Array.from(win.CWShelfSearchUi.REQUIRED_HOST), Array.from(shelfSearchUi.REQUIRED_HOST));
  assert.equal(typeof win.CWShelfSearchUi.create, 'function');
  assert.equal(win.CWStatusbarUi, undefined, '单独加载 shelf-search-ui 不该顺手造出别的全局');
  assert.equal(win.CWChapters, undefined);
});
