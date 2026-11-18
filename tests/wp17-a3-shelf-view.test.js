// WP17 A3 第三刀（书架视图）：行为 / 契约锚点。
//
// 缺陷（结构，非功能）：书架视图的刷新编排还长在渲染层编排器里——
//   · refreshShelf（回书架 → 重取上次写作位置 / 今日统计 / 书目 → 重画 → 后台索引校验）；
//   · applyBookDisplay（打开书后套用这本书的显示设置）；
//   · bookGridColumns（书卡网格列数，拍板 #16b 的键盘方向键几何来源）；
//   · bindEvents 里的书架搜索段（B6 的 250ms 防抖 + 下一帧渲染 / Esc 清空 / 回车打开 / 清空 / 显示更多）。
// 本刀把它们整段搬到 renderer/shelf-view-ui.js（只搬不改行为），编排器只留同名包装与装配。
//
// 为什么这样测：新模块是 UMD，Node 里可以 require + create()，所以这里不只读源码：
//   ① 静态半边：模块契约 / 编排器只剩同名包装 / 装配位置（TDZ 顺序）/ 实现标记不许回流；
//   ② 行为半边：假 host 真跑 refreshShelf（IO 失败 / 5000 本极值）、applyBookDisplay（坏显示设置 /
//      自定义字体 / 侧栏宽度边界）、bookGridColumns（拿不到 grid / none / 多列）、
//      bindShelfEvents（防抖合并 / rAF / Esc 立即重画 / 回车含空格路径 / 清空 / 显示更多）。
// 修复前应当全红（模块不存在 / 包装与装配未建立），红输出留在审计目录。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const RENDERER_SRC = read('renderer/renderer.js');
const MODULE_REL = 'renderer/shelf-view-ui.js';
const MODULE_ABS = path.join(ROOT, MODULE_REL);
const MODULE_SRC = fs.existsSync(MODULE_ABS) ? fs.readFileSync(MODULE_ABS, 'utf8') : '';
const moduleApi = fs.existsSync(MODULE_ABS) ? require('../renderer/shelf-view-ui') : null;

// 从源码切一个「  [async] function 名字( ... ) { ... }」的真身（形参 / 函数体都按括号配对）。
function extractFunction(source, name) {
  const marker = new RegExp(`(?:^|\\n)  (async )?function ${name}\\(`);
  const match = marker.exec(source);
  assert.ok(match, `找不到 function ${name}(`);
  const start = match.index + (match[0].startsWith('\n') ? 1 : 0);
  const parenStart = source.indexOf('(', start);
  let parenDepth = 0;
  let cursor = parenStart;
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === '(') parenDepth += 1;
    if (source[cursor] === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) break;
    }
  }
  const bodyStart = source.indexOf('{', cursor);
  let depth = 0;
  let mode = 'code';
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i];
    if (mode === 'code') {
      if (ch === '/' && source[i + 1] === '/') { mode = 'line'; i += 1; continue; }
      if (ch === '/' && source[i + 1] === '*') { mode = 'block'; i += 1; continue; }
      if (ch === "'") { mode = 'single'; continue; }
      if (ch === '"') { mode = 'double'; continue; }
      if (ch === '`') { mode = 'template'; continue; }
      if (ch === '{') { depth += 1; continue; }
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(start, i + 1);
      }
      continue;
    }
    if (mode === 'line') { if (ch === '\n') mode = 'code'; continue; }
    if (mode === 'block') { if (ch === '*' && source[i + 1] === '/') { mode = 'code'; i += 1; } continue; }
    if (mode === 'single') { if (ch === '\\') { i += 1; continue; } if (ch === "'") mode = 'code'; continue; }
    if (mode === 'double') { if (ch === '\\') { i += 1; continue; } if (ch === '"') mode = 'code'; continue; }
    if (ch === '\\') { i += 1; continue; }
    if (ch === '`') mode = 'code';
  }
  throw new Error(`function ${name} 的大括号没有配对`);
}

// ---------- ① 静态契约 ----------

const HOST_KEYS = [
  'state', 'api', 'call', 'toast', '$',
  'refreshStats', 'markCommandsDirty', 'renderShelf', 'ensureSearchIndex',
  'shelfQueryText', 'scheduleContentSearch', 'resetShelfContent', 'shelfSearchResults',
  'openBookByPath', 'openContentResult', 'renderShelfContent', 'imeGuard',
  'effectiveConfig', 'loadCustomFont', 'applyEditorStyle', 'syncCaretParagraphFromConfig',
  'applySidebarWidth', 'CONTENT_SEARCH_MIN_CHARS', 'CONTENT_PAGE_SIZE'
];

test('A3-B / C1：新模块交出 create + REQUIRED_HOST，UMD 双分支与共享 assertHost 与既有模块同口径', () => {
  assert.ok(MODULE_SRC, `${MODULE_REL} 不存在：书架视图还没搬出编排器`);
  assert.match(
    MODULE_SRC,
    /root\.CWShelfViewUi = factory\(root\.CWAssertHost && root\.CWAssertHost\.assertHost\)/,
    '浏览器分支必须挂 CWShelfViewUi'
  );
  assert.match(MODULE_SRC, /require\('\.\.\/core\/assert-host'\)/, 'Node 分支必须 require ../core/assert-host');
  assert.match(MODULE_SRC, /function createShelfViewUi\(host\)/, '模块必须交出 createShelfViewUi(host)');
  assert.match(MODULE_SRC, /assertHost\('createShelfViewUi', host, REQUIRED_HOST\);/, '必须走共享 host 校验');
  assert.ok(Array.isArray(moduleApi.REQUIRED_HOST), 'REQUIRED_HOST 必须是数组');
  assert.equal(moduleApi.REQUIRED_HOST.length, HOST_KEYS.length, 'REQUIRED_HOST 成员数按契约');
  for (const key of HOST_KEYS) {
    assert.ok(moduleApi.REQUIRED_HOST.includes(key), `REQUIRED_HOST 缺 ${key}`);
  }
  // 缺成员在装配时炸：不是到点回书架才 ReferenceError。
  const host = makeHost().host;
  delete host.toast;
  assert.throws(() => moduleApi.create(host), /createShelfViewUi 的 host 缺少 toast/);
});

test('A3-B / C2：编排器只剩同名包装与一次装配，书架视图实现一个都搜不到', () => {
  assert.match(RENDERER_SRC, /const shelfViewUiModule = window\.CWShelfViewUi;/, '编排器要按清单本地名取模块');
  assert.match(RENDERER_SRC, /const shelfViewUi = shelfViewUiModule\.create\(\{/, '编排器要装配一次 create(host)');

  // TDZ 顺序：create 必须晚于它所依赖的 const（shelfSearchUi / bookinfoUi 的 renderShelf）与早于 bindEvents。
  const createAt = RENDERER_SRC.indexOf('const shelfViewUi = shelfViewUiModule.create({');
  assert.ok(createAt > RENDERER_SRC.indexOf('const shelfSearchUi = shelfSearchUiModule.create({'), 'create 要晚于 shelfSearchUi');
  assert.ok(createAt > RENDERER_SRC.indexOf('const bookinfoUi = bookinfoUiModule.create({'), 'create 要晚于 bookinfoUi');
  assert.ok(createAt < RENDERER_SRC.indexOf('  function bindEvents() {'), 'create 要早于 bindEvents（装配区内）');

  // host 字面量必须把 REQUIRED_HOST 的每个成员都接上（漏一个 = 运行时 undefined）。
  const hostBlock = RENDERER_SRC.slice(createAt, RENDERER_SRC.indexOf('});', createAt));
  for (const key of HOST_KEYS) {
    assert.ok(hostBlock.includes(key), `装配 host 字面量缺 ${key}`);
  }

  // 同名包装：调用点 / 测试钩子一个字都不改。
  assert.match(RENDERER_SRC, /async function refreshShelf\(\) \{ return shelfViewUi\.refreshShelf\(\); \}/, 'refreshShelf 同名包装');
  assert.match(RENDERER_SRC, /async function applyBookDisplay\(bookId\) \{ return shelfViewUi\.applyBookDisplay\(bookId\); \}/, 'applyBookDisplay 同名包装');
  assert.match(RENDERER_SRC, /function bookGridColumns\(\) \{ return shelfViewUi\.bookGridColumns\(\); \}/, 'bookGridColumns 同名包装');
  assert.equal(
    (RENDERER_SRC.match(/shelfViewUi\.bindShelfEvents\(\);/g) || []).length,
    1,
    'bindEvents 里只许转发一次书架事件段'
  );

  // 实现标记不许回流：这些字符串只该出现在新模块里。
  for (const marker of [
    'call(api.getRecentBook)',
    'call(api.getBookDisplay, bookId)',
    'getComputedStyle(grid).gridTemplateColumns',
    'function scheduleShelfRender()',
    'let shelfFilterTimer = 0;',
    "$('shelf-search').addEventListener('input'",
    "$('btn-shelf-search-clear').addEventListener('click'",
    "$('btn-shelf-content-more').addEventListener('click'"
  ]) {
    assert.equal(RENDERER_SRC.includes(marker), false, `编排器里还有书架视图实现：${marker}`);
  }

  // 包装必须真的只有一行转发（防有人把实现又塞回包装里）。
  for (const name of ['refreshShelf', 'applyBookDisplay', 'bookGridColumns']) {
    const body = extractFunction(RENDERER_SRC, name);
    assert.ok(body.split(/\r?\n/).length <= 2, `${name} 包装超过 2 行：实现要留在模块里`);
  }
});

test('A3-B / C3：机械保真——搬走的实现保留原有行为注释与 B6 防抖红线（不是重写）', () => {
  for (const line of [
    '打开一本书后套用这本书的显示设置（没有单独设置过就沿用全局）',
    '上次写作位置每次回书架都重新取：在编辑页切章 / 保存后主进程已经更新了配置',
    '今日字数 / 近 30 天统计（主进程算本地日期，界面不自己算）',
    'B6（审计 P6）：书架搜索原来每敲一个键就整块重建 grid',
    '书架网格当前几列（拍板 #16b）'
  ]) {
    assert.ok(MODULE_SRC.includes(line), `模块丢了行为注释：${line}`);
  }
  // 搬走的三件事与事件段：函数体 / 缩进逐字保留（2 空格函数声明、4 空格事件段）。
  assert.match(MODULE_SRC, /\n  async function applyBookDisplay\(bookId\) \{/, 'applyBookDisplay 逐字搬入 create()');
  assert.match(MODULE_SRC, /\n  async function refreshShelf\(\) \{/, 'refreshShelf 逐字搬入 create()');
  assert.match(MODULE_SRC, /\n  function bookGridColumns\(\) \{/, 'bookGridColumns 逐字搬入 create()');
  assert.match(MODULE_SRC, /\n    function scheduleShelfRender\(\) \{/, '事件段的嵌套调度函数保持 4 空格缩进');
  // B6 的语义原样：防抖 250ms + 合并 + 下一帧。
  assert.match(MODULE_SRC, /clearTimeout\(shelfFilterTimer\)/, '连续输入要合并（清掉上一个定时器）');
  assert.match(MODULE_SRC, /\},\s*250\);/, '防抖间隔应为 250ms');
  assert.match(MODULE_SRC, /requestAnimationFrame\(\(\) => \{/, '渲染放到下一帧');
  // 定时器句柄是本域私有活状态（随模块走），编排器不许留第二份。
  assert.match(MODULE_SRC, /\n    let shelfFilterTimer = 0;/, '防抖定时器随模块走（模块级声明）');
  assert.match(MODULE_SRC, /\n    let shelfFilterFrame = 0;/, 'rAF 句柄随模块走');
});

// ---------- 假 host ----------

function makeHost(overrides = {}) {
  const counts = {
    toast: [], stats: 0, commandsDirty: 0, renderShelf: 0, ensureIndex: 0,
    contentSearch: 0, resetContent: 0, renderContent: 0, opened: [], contentOpened: [],
    loadFont: [], applyStyle: 0, syncCaret: 0, sidebar: [], editable: 0
  };
  const state = {
    books: [{ path: 'C:/书架/旧书', title: '旧书' }],
    recentBook: { bookPath: 'C:/书架/旧书', bookId: 'b0' },
    bookId: 'b1',
    bookDisplay: {},
    globalConfig: { editorFont: 'system' },
    config: { editorFont: 'system' },
    shelfQuery: '',
    shelfContent: { shown: 0, meta: { results: [] } },
    view: 'shelf'
  };
  const els = {};
  function makeEl(id) {
    return {
      id, value: '', focusCount: 0, handlers: {},
      addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
      emit(type, event) {
        const list = this.handlers[type] || [];
        const payload = event || {};
        if (!payload.preventDefault) payload.preventDefault = () => { payload.defaultPrevented = true; };
        for (const fn of list) fn(payload);
        return payload;
      },
      focus() { this.focusCount += 1; }
    };
  }
  for (const id of ['book-grid', 'shelf-search', 'btn-shelf-search-clear', 'btn-shelf-content-more']) els[id] = makeEl(id);
  const api = {
    getRecentBook: async () => ({ ok: true, data: { bookPath: 'C:/书架/最近书', bookId: 'b9' } }),
    listBooks: async () => ({ ok: true, data: [{ path: 'C:/书架/新书', title: '新书' }] }),
    getBookDisplay: async () => ({ ok: true, data: { editorSidebarWidth: 333 } })
  };
  async function call(fn, ...args) {
    const res = await fn(...args);
    if (!res || res.ok === false) {
      const err = new Error((res && res.message) || '未知错误');
      err.code = res && res.code;
      throw err;
    }
    return res.data;
  }
  let imeComposing = false;
  let searchRows = overrides.searchRows || [];
  const host = {
    state,
    api,
    call,
    toast: (message, kind) => counts.toast.push([message, kind]),
    $: (id) => els[id] || null,
    refreshStats: async () => { counts.stats += 1; },
    markCommandsDirty: () => { counts.commandsDirty += 1; },
    renderShelf: () => { counts.renderShelf += 1; },
    ensureSearchIndex: () => { counts.ensureIndex += 1; },
    shelfQueryText: () => state.shelfQuery,
    scheduleContentSearch: () => { counts.contentSearch += 1; },
    resetShelfContent: () => { counts.resetContent += 1; },
    shelfSearchResults: () => searchRows,
    openBookByPath: async (bookPath) => { counts.opened.push(bookPath); },
    openContentResult: async (row) => { counts.contentOpened.push(row); },
    renderShelfContent: () => { counts.renderContent += 1; },
    imeGuard: { isImeComposing: () => imeComposing },
    effectiveConfig: () => ({ ...(state.globalConfig || {}), ...(state.bookDisplay || {}) }),
    loadCustomFont: async (fontPath, options) => { counts.loadFont.push([fontPath, options]); },
    applyEditorStyle: () => { counts.applyStyle += 1; },
    syncCaretParagraphFromConfig: () => { counts.syncCaret += 1; },
    applySidebarWidth: (width) => { counts.sidebar.push(width); },
    CONTENT_SEARCH_MIN_CHARS: 2,
    CONTENT_PAGE_SIZE: 8
  };
  const ui = moduleApi ? moduleApi.create(host) : null;
  return {
    ui, host, state, counts, els,
    setIme: (value) => { imeComposing = value; },
    setSearchRows: (value) => { searchRows = value; }
  };
}

// ---------- 假时钟（模块用全局 setTimeout / clearTimeout / requestAnimationFrame） ----------

function installFakeClock() {
  const real = {
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
    requestAnimationFrame: global.requestAnimationFrame
  };
  const timeouts = new Map();
  let nextId = 1;
  let cleared = 0;
  let rafs = [];
  global.setTimeout = (cb, ms) => {
    const id = nextId;
    nextId += 1;
    timeouts.set(id, { cb, ms });
    return id;
  };
  global.clearTimeout = (id) => {
    if (timeouts.delete(id)) cleared += 1;
  };
  global.requestAnimationFrame = (cb) => {
    rafs.push(cb);
    return rafs.length;
  };
  return {
    tick() {
      const due = [...timeouts.values()];
      timeouts.clear();
      for (const item of due) item.cb();
      const frame = rafs;
      rafs = [];
      for (const cb of frame) cb();
      return { timeouts: due.length, frames: frame.length };
    },
    pending() { return timeouts.size; },
    pendingFrames() { return rafs.length; },
    cleared() { return cleared; },
    restore() {
      global.setTimeout = real.setTimeout;
      global.clearTimeout = real.clearTimeout;
      global.requestAnimationFrame = real.requestAnimationFrame;
    }
  };
}

// ---------- ② 行为 ----------

test('A3-B / B1：refreshShelf——最近书 / 统计 / 书目重取，失败不抛、书目失败给 error toast，索引后台校验不挡', async () => {
  const rt = makeHost();
  const result = await rt.ui.refreshShelf();
  assert.equal(result, undefined);
  assert.deepEqual(rt.state.recentBook, { bookPath: 'C:/书架/最近书', bookId: 'b9' });
  assert.equal(rt.counts.stats, 1, '今日 / 近 30 天统计每次回书架都刷新');
  assert.deepEqual(rt.state.books, [{ path: 'C:/书架/新书', title: '新书' }]);
  assert.equal(rt.counts.commandsDirty, 1, '书架变了要重建命令面板「书」条目');
  assert.equal(rt.counts.renderShelf, 1);
  assert.equal(rt.counts.ensureIndex, 1, '正文索引校验后台触发（不 await）');
  assert.equal(rt.counts.contentSearch, 0, '空查询不触发正文搜索');
  assert.deepEqual(rt.counts.toast, [], '正常回书架不许弹提示');

  // 查询词达到下限才触发正文搜索（CONTENT_SEARCH_MIN_CHARS = 2，边界逐字保留）。
  rt.state.shelfQuery = '书';
  await rt.ui.refreshShelf();
  assert.equal(rt.counts.contentSearch, 0, '1 个字符不够正文搜索下限');
  rt.state.shelfQuery = '书目';
  await rt.ui.refreshShelf();
  assert.equal(rt.counts.contentSearch, 1, '正好 2 个字符触发正文搜索');
});

test('A3-B / B2（极值 × IO 失败注入）：书架 IO 全失败仍把书架画出来，最近书回空、错误有提示', async () => {
  const rt = makeHost();
  rt.host.api.getRecentBook = async () => ({ ok: false, code: 'EIO', message: '读取最近书失败（模拟磁盘错误）' });
  rt.host.api.listBooks = async () => ({ ok: false, code: 'ENOSPC', message: '读取书目失败（模拟磁盘满）' });
  await rt.ui.refreshShelf();
  assert.equal(rt.state.recentBook, null, '取不到最近书 → 继续上次写作卡收起，不抛');
  assert.deepEqual(rt.state.books, [], '书目读失败 → 空书架（保留上一份会显示不存在的书）');
  assert.equal(rt.counts.toast.length, 1);
  assert.deepEqual(rt.counts.toast[0], ['读取书架失败：读取书目失败（模拟磁盘满）', 'error']);
  assert.equal(rt.counts.renderShelf, 1, '失败后仍要重画（把空书架 / 错误后的状态画出来）');
  assert.equal(rt.counts.ensureIndex, 1, '索引校验仍触发（后台失败自己留痕）');

  // 极值：超大书架（5000 本）只整体赋值一次，不逐本做额外工作；含空格路径原样保留。
  const huge = Array.from({ length: 5000 }, (_, i) => ({ path: `C:/书架/书 ${i}/根`, title: `书 ${i}` }));
  rt.host.api.listBooks = async () => ({ ok: true, data: huge });
  await rt.ui.refreshShelf();
  assert.equal(rt.state.books.length, 5000);
  assert.equal(rt.state.books[4999].path, 'C:/书架/书 4999/根', '含空格路径不许被裁剪 / 改写');
  assert.equal(rt.counts.renderShelf, 2);
});

test('A3-B / B3：applyBookDisplay——按书覆盖合并进 config，坏回执退化成全局，字体 / 排版 / 宽度各走一次', async () => {
  const rt = makeHost();
  rt.state.globalConfig = { editorFont: 'system', editorSidebarWidth: 250 };
  rt.host.api.getBookDisplay = async () => ({
    ok: true,
    data: { editorFont: 'custom', editorCustomFontPath: 'C:/字体/思源 宋体.ttf', editorSidebarWidth: 333 }
  });
  await rt.ui.applyBookDisplay('b1');
  assert.deepEqual(rt.state.bookDisplay, {
    editorFont: 'custom', editorCustomFontPath: 'C:/字体/思源 宋体.ttf', editorSidebarWidth: 333
  });
  assert.deepEqual(rt.state.config, {
    editorFont: 'custom', editorSidebarWidth: 333, editorCustomFontPath: 'C:/字体/思源 宋体.ttf'
  });
  assert.deepEqual(rt.counts.loadFont, [['C:/字体/思源 宋体.ttf', { silent: true }]], '自定义字体失败静默，不挡开书');
  assert.equal(rt.counts.applyStyle, 1);
  assert.equal(rt.counts.syncCaret, 1, '当前段落高亮开关按书覆盖');
  assert.deepEqual(rt.counts.sidebar, [333], '侧栏宽度按书覆盖');

  // 坏回执（外部改写 / 文件没了）：退化成空覆盖，仍套全局默认。
  rt.state.bookDisplay = { editorFont: 'custom' };
  rt.host.api.getBookDisplay = async () => ({ ok: false, code: 'ENOENT', message: 'display 没了' });
  await rt.ui.applyBookDisplay('b1');
  assert.deepEqual(rt.state.bookDisplay, {}, '坏回执退化成空覆盖');
  assert.deepEqual(rt.state.config, { editorFont: 'system', editorSidebarWidth: 250 }, '没有按书覆盖就沿用全局');
  assert.deepEqual(rt.counts.sidebar[rt.counts.sidebar.length - 1], 250, '没设置过宽度 → 回落 250');

  // 极值：全局自定义字体 + 0 / 超大宽度都原样交给 applySidebarWidth（钳制仍是它自己的职责，不许在本层新增）。
  rt.state.globalConfig = { editorFont: 'custom', editorCustomFontPath: 'C:/全局 字体.ttf', editorSidebarWidth: 0 };
  rt.host.api.getBookDisplay = async () => ({ ok: true, data: {} });
  await rt.ui.applyBookDisplay('b1');
  assert.deepEqual(rt.counts.loadFont[rt.counts.loadFont.length - 1], ['C:/全局 字体.ttf', { silent: true }]);
  assert.deepEqual(rt.counts.sidebar[rt.counts.sidebar.length - 1], 0, '0 宽度是显式设置，不许被当成「没设置」');
  rt.state.globalConfig = { editorSidebarWidth: 999999 };
  await rt.ui.applyBookDisplay('b1');
  assert.deepEqual(rt.counts.sidebar[rt.counts.sidebar.length - 1], 999999, '本层不钳制（钳制在 applySidebarWidth）');
});

test('A3-B / B4：bookGridColumns——拿不到 grid / 计算样式 / none 都退化成 1 列，正常多列数得准', () => {
  const rt = makeHost();
  const realWindow = global.window;
  try {
    // 没有 grid 元素：退化成 1 列（方向键回到单向移动；这条分支不许摸 window，Node 里没有）。
    const noGrid = moduleApi.create({ ...rt.host, $: () => null });
    assert.equal(noGrid.bookGridColumns(), 1);
    // 有 grid、但宿主没有 getComputedStyle：同样退化成 1 列而不是抛错。
    global.window = {};
    assert.equal(rt.ui.bookGridColumns(), 1);

    global.window.getComputedStyle = () => ({ gridTemplateColumns: '250px 250px 250px' });
    assert.equal(rt.ui.bookGridColumns(), 3);
    global.window.getComputedStyle = () => ({ gridTemplateColumns: 'none' });
    assert.equal(rt.ui.bookGridColumns(), 1);
    global.window.getComputedStyle = () => ({ gridTemplateColumns: '   ' });
    assert.equal(rt.ui.bookGridColumns(), 1);
    // 100 列极值：照数
    global.window.getComputedStyle = () => ({ gridTemplateColumns: Array.from({ length: 100 }, () => '10px').join(' ') });
    assert.equal(rt.ui.bookGridColumns(), 100);
  } finally {
    if (realWindow === undefined) delete global.window;
    else global.window = realWindow;
  }
});

test('A3-B / B5：bindShelfEvents——输入走 250ms 防抖 + 下一帧（不每键重建），Esc / 清空立即重画', () => {
  const clock = installFakeClock();
  const rt = makeHost();
  try {
    rt.ui.bindShelfEvents();
    const search = rt.els['shelf-search'];
    assert.equal((search.handlers.input || []).length, 1, '书架搜索框要注册 input');
    assert.equal((search.handlers.keydown || []).length, 1, '书架搜索框要注册 keydown');

    // 输入：查询词立刻写回（正文搜索 / 回车都用最新值），但过滤重排不每键同步重建。
    search.value = '书';
    search.emit('input');
    assert.equal(rt.state.shelfQuery, '书');
    assert.equal(rt.counts.contentSearch, 1, '正文搜索的独立防抖调度不变');
    assert.equal(rt.counts.renderShelf, 0, '输入事件里不许同步 renderShelf');
    assert.equal(clock.pending(), 1, '排了一次防抖定时器');
    search.value = '书目';
    search.emit('input');
    assert.equal(clock.pending(), 1, '连续输入要合并（清掉上一个定时器）');
    assert.equal(clock.cleared(), 1);
    clock.tick();
    assert.equal(rt.counts.renderShelf, 1, '250ms 到点 + 下一帧才重画一次');

    // Esc：立即清空 + 立即重画 + 清正文结果（不等防抖）。
    search.value = '书目';
    rt.state.shelfQuery = '书目';
    search.emit('keydown', { key: 'Escape' });
    assert.equal(search.value, '');
    assert.equal(rt.state.shelfQuery, '');
    assert.equal(rt.counts.resetContent, 1);
    assert.equal(rt.counts.renderShelf, 2, 'Esc 立即重画');

    // 清空按钮：同上 + 焦点回到搜索框。
    rt.counts.renderShelf = 0;
    rt.counts.resetContent = 0;
    rt.els['btn-shelf-search-clear'].emit('click');
    assert.equal(search.value, '');
    assert.equal(rt.counts.resetContent, 1);
    assert.equal(rt.counts.renderShelf, 1, '清空按钮立即重画');
    assert.equal(search.focusCount, 1, '清空后焦点回搜索框');
  } finally {
    clock.restore();
  }
});

test('A3-B / B6：bindShelfEvents——回车打开第一本匹配书（含空格路径原样），没命中回落到第一条正文命中，组字中不抢', async () => {
  const clock = installFakeClock();
  const rt = makeHost({ searchRows: [{ book: { path: 'C:/书架/书 名 带 空格/根' } }, { book: { path: 'C:/书架/第二本' } }] });
  try {
    rt.ui.bindShelfEvents();
    const search = rt.els['shelf-search'];

    // 输入法组字中的 Enter 只上屏候选词：不 preventDefault、不打开书。
    rt.setIme(true);
    const composing = search.emit('keydown', { key: 'Enter' });
    assert.equal(composing.defaultPrevented, undefined, '组字中不许 preventDefault');
    assert.deepEqual(rt.counts.opened, []);
    rt.setIme(false);

    const enter = search.emit('keydown', { key: 'Enter' });
    assert.equal(enter.defaultPrevented, true, '回车要 preventDefault（避免表单默认行为）');
    assert.deepEqual(rt.counts.opened, ['C:/书架/书 名 带 空格/根'], '打开第一本匹配书，含空格路径原样传出');
    await new Promise((resolve) => setImmediate(resolve));

    // 书名 / 章名没命中：回车含义 = 打开第一条正文命中。
    rt.setSearchRows([]);
    const first = { bookPath: 'C:/书架/书 A', chapterId: 'c1' };
    rt.state.shelfContent = { shown: 0, meta: { results: [first, { bookPath: 'C:/书架/书 B' }] } };
    search.emit('keydown', { key: 'Enter' });
    assert.deepEqual(rt.counts.contentOpened, [first], '回落到第一条正文命中');
    await new Promise((resolve) => setImmediate(resolve));

    // 都没有：什么也不做（不许抛）。
    rt.state.shelfContent = { shown: 0, meta: { results: [] } };
    search.emit('keydown', { key: 'Enter' });
    assert.deepEqual(rt.counts.opened.length, 1);

    // 「显示更多」：每次 +CONTENT_PAGE_SIZE（8）并重画正文结果区。
    rt.state.shelfContent = { shown: 8, meta: { results: [] } };
    rt.counts.renderContent = 0;
    rt.els['btn-shelf-content-more'].emit('click');
    assert.equal(rt.state.shelfContent.shown, 16);
    assert.equal(rt.counts.renderContent, 1);
  } finally {
    clock.restore();
  }
});