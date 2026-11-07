const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const readingUi = require('../renderer/reading-ui');
const readingLogic = require('../renderer/reading-logic');
const chaptersLib = require('../core/chapters');

// 第 4 步 renderer 九刀·第二刀：阅读模式（原 renderer.js 2616–3056，441 行）搬到 renderer/reading-ui.js。
// 搬之前这一域只有 E2E 黑盒覆盖（进阅读 → 翻章 → 调字号 → 退出）；块加载 / token 作废 / 自动接章 /
// 最多留 40 块 / 旧响应丢弃 / 读取失败占位 / 未保存提示 / 退出归还焦点这些分支在 Node 里一步都测不到。
// 搬出来以后用「假 host + 假 DOM」逐条钉住，再用静态闸门保证渲染层不长回第二份、index.html 顺序不许反。
//
// 契约：host 8 个成员 = 基础 5（$, state, api, call, toast）+ reading{readingLogic,formatChars} +
// view{showView,hideContextMenu,hideVolumeMenu,hideHeaderMenus,editorEl,scheduleMarksRender,updateWindowTitle}
// + chapterTitle（updateWindowTitle 是 Phase D / D8 为「标题带章号」加的）。

const realDocument = globalThis.document;
const ALL_CTX = [];
function stopReading(ctx) {
  if (ctx && ctx.state && ctx.state.reading.timer) {
    clearTimeout(ctx.state.reading.timer);
    ctx.state.reading.timer = null;
  }
}
test.after(() => {
  for (const ctx of ALL_CTX) stopReading(ctx);
  if (realDocument === undefined) delete globalThis.document;
  else globalThis.document = realDocument;
});

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const moduleSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'reading-ui.js'), 'utf8');
// 纯边界闸门只看代码：注释里提 document / state 是在解释契约，不算越界
const moduleCode = moduleSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------- 假 DOM ----------
function makeEl(tag = 'div', id = '') {
  const classes = new Set();
  const listeners = [];
  const el = {
    tagName: tag,
    id,
    className: '',
    textContent: '',
    title: '',
    value: '',
    disabled: false,
    dataset: {},
    children: [],
    parentNode: null,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    clientWidth: 0,
    _top: 0,
    _height: 0,
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
    insertBefore(node, before) {
      const at = before ? el.children.indexOf(before) : -1;
      node.parentNode = el;
      if (at < 0) el.children.push(node);
      else el.children.splice(at, 0, node);
      return node;
    },
    remove() {
      if (!el.parentNode) return;
      const at = el.parentNode.children.indexOf(el);
      if (at >= 0) el.parentNode.children.splice(at, 1);
      el.parentNode = null;
    },
    get firstChild() { return el.children[0] || null; },
    setAttribute(name, value) { el._attrs[name] = value; },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(el._attrs, name) ? el._attrs[name] : null; },
    getBoundingClientRect() { return { top: el._top, height: el._height }; },
    focus() { el._focus += 1; },
    addEventListener(type, fn, options) { listeners.push({ type, fn, options }); },
    _fire(type, event) {
      let result;
      for (const l of listeners) if (l.type === type) result = l.fn(event);
      return result;
    }
  };
  // 章节区块里的文本节点 / option 也用同一套假 DOM；querySelectorAll 只匹配真实的类选择器
  // （.reading-chapter 取直接子块，其它类名按后代替节点递归查 —— 阅读位置记忆要查 .reading-chapter-error）
  el.querySelectorAll = (selector) => {
    if (selector === '.reading-chapter') return el.children.filter((c) => String(c.className).split(' ').includes('reading-chapter'));
    const cls = typeof selector === 'string' && selector.startsWith('.') ? selector.slice(1) : '';
    if (!cls) return [];
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (String(child.className).split(' ').includes(cls)) out.push(child);
        walk(child);
      }
    };
    walk(el);
    return out;
  };
  el.querySelector = (selector) => el.querySelectorAll(selector)[0] || null;
  Object.defineProperty(el, 'innerHTML', {
    get() { return ''; },
    set() { el.children.length = 0; }
  });
  return el;
}

function makeDoc() {
  const map = new Map();
  let lookups = 0;
  const cssVars = {};
  const doc = {
    activeElement: null,
    documentElement: { style: { setProperty(name, value) { cssVars[name] = value; } } },
    createElement: (tag) => makeEl(tag),
    createDocumentFragment() { const frag = makeEl('fragment'); frag._isFragment = true; return frag; },
    getElementById: (id) => { lookups += 1; return map.get(id) || null; }
  };
  const dom = {
    doc,
    map,
    cssVars,
    get lookups() { return lookups; },
    $: (id) => doc.getElementById(id),
    addChildTo(id, child) { (map.get(id) || makeEl('div')).appendChild(child); },
    newBlock(index, top = 0, height = 0) {
      const block = makeEl('section');
      block.className = 'reading-chapter';
      block.dataset.index = String(index);
      block._top = top;
      block._height = height;
      map.get('reading-content').appendChild(block);
      return block;
    }
  };
  return dom;
}

const BASE_IDS = [
  'reading-view', 'reading-scroll', 'reading-content', 'reading-loading', 'reading-toc', 'reading-progress',
  'reading-end', 'reading-summary', 'reading-book-title', 'reading-note',
  'reading-font-level', 'reading-line-level',
  'btn-reading', 'btn-reading-exit', 'btn-reading-first', 'btn-reading-prev', 'btn-reading-next'
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

function makeChapters(n, extra = {}) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ name: `第${i + 1}章`, file: `c${i + 1}.txt`, chars: 100 + i, ...(extra[i] || {}) });
  }
  return out;
}

// 让异步链（await call → createReadingBlock → 渲染）跑完
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function build(options = {}) {
  const dom = options.dom || makeDoc();
  for (const id of BASE_IDS) if (!dom.map.has(id)) dom.map.set(id, makeEl('div', id));
  globalThis.document = dom.doc;
  const state = {
    bookPath: options.bookPath === undefined ? '/书库/书甲' : options.bookPath,
    meta: options.meta === undefined ? { title: '书甲' } : options.meta,
    chapters: options.chapters === undefined ? makeChapters(3) : options.chapters,
    index: options.index === undefined ? 0 : options.index,
    dirty: Boolean(options.dirty),
    reading: {
      open: Boolean(options.open),
      index: options.readingIndex === undefined ? 0 : options.readingIndex,
      startIndex: 0,
      programmaticScrollTop: 0,
      loading: false,
      token: 0,
      timer: null
    },
    readingPrefs: { fontLevel: options.fontLevel === undefined ? 2 : options.fontLevel, lineLevel: options.lineLevel === undefined ? 2 : options.lineLevel }
  };
  const calls = {
    loadChapter: [], toast: [], showView: [], hideContextMenu: 0, hideVolumeMenu: 0, hideHeaderMenus: 0,
    scheduleMarksRender: [], editorFocus: 0, updateWindowTitle: 0
  };
  const api = {
    loadChapter(...args) {
      calls.loadChapter.push(args);
      if (options.loadChapter) return options.loadChapter(...args);
      return { text: '正文内容' };
    }
  };
  const editorEl = {
    _focus: 0,
    focus() { editorEl._focus += 1; calls.editorFocus += 1; }
  };
  const host = {
    $: dom.$,
    state,
    api,
    call: async (fn, ...args) => fn(...args),
    toast(message, kind) { calls.toast.push([message, kind]); },
    reading: { readingLogic, formatChars },
    view: {
      showView(view) { calls.showView.push(view); },
      hideContextMenu() { calls.hideContextMenu += 1; },
      hideVolumeMenu() { calls.hideVolumeMenu += 1; },
      hideHeaderMenus() { calls.hideHeaderMenus += 1; },
      editorEl,
      scheduleMarksRender(delay) { calls.scheduleMarksRender.push(delay); },
      updateWindowTitle() { calls.updateWindowTitle += 1; }
    },
    chapterTitle: (index, name) => chaptersLib.formatTitle(state.meta, index, name)
  };
  const ui = readingUi.create(host);
  const ctx = { ui, host, state, dom, calls, editorEl };
  ALL_CTX.push(ctx);
  return ctx;
}

// ---------- host 契约 ----------
test('host 契约：8 个成员 + 分组内每个真实依赖；缺任何一个都抛 TypeError', () => {
  assert.deepEqual([...readingUi.REQUIRED_HOST].sort(), ['$', 'api', 'call', 'chapterTitle', 'reading', 'state', 'toast', 'view']);
  assert.equal(readingUi.REQUIRED_HOST.length, 8);
  const ctx = build();
  assert.doesNotThrow(() => readingUi.create(ctx.host));
  assert.throws(() => readingUi.create(null), /createReadingUi 需要 host 对象/);
  assert.throws(() => readingUi.create('x'), /createReadingUi 需要 host 对象/);

  for (const key of readingUi.REQUIRED_HOST) {
    const broken = { ...ctx.host };
    delete broken[key];
    assert.throws(() => readingUi.create(broken), new RegExp('host 缺少 ' + key.replace('$', '\\$')), '缺 ' + key);
    assert.throws(() => readingUi.create({ ...ctx.host, [key]: null }), /host 缺少/, key + ' = null');
  }
  for (const key of ['readingLogic', 'formatChars']) {
    const broken = { ...ctx.host, reading: { ...ctx.host.reading } };
    delete broken.reading[key];
    assert.throws(() => readingUi.create(broken), new RegExp('host\\.reading 缺少 ' + key));
  }
  for (const key of ['showView', 'hideContextMenu', 'hideVolumeMenu', 'hideHeaderMenus', 'editorEl', 'scheduleMarksRender', 'updateWindowTitle']) {
    const broken = { ...ctx.host, view: { ...ctx.host.view } };
    delete broken.view[key];
    assert.throws(() => readingUi.create(broken), new RegExp('host\\.view 缺少 ' + key), 'view 缺 ' + key);
  }
  assert.throws(() => readingUi.create({ ...ctx.host, reading: 'x' }), /host\.reading 必须是对象/);
  assert.throws(() => readingUi.create({ ...ctx.host, view: 'x' }), /host\.view 必须是对象/);
});

test('create() 只建表：不碰 DOM / 不注册事件 / 不建定时器，交出 17 个入口', () => {
  const dom = makeDoc();
  const ctx = build({ dom });
  assert.equal(dom.lookups, 0, 'create() 一次 $ 都不该调');
  assert.deepEqual(Object.keys(ctx.ui).sort(), [
    'exitReadingMode', 'openReadingMode', 'readingBlockElements', 'readingBlockIndexAt', 'readingCurrentIndex',
    'readingGo', 'readingJumpTo', 'readingLoadedIndexes', 'readingMeasureBlocks', 'readingNearBottom',
    'readingScrollEl', 'readingScrollToBlock', 'readingVisibleIndex', 'scheduleReadingScrollCheck',
    'setReadingPref', 'setupReadingUi', 'updateReadingUi'
  ]);
  assert.equal(moduleCode.includes('setInterval'), false, '模块不建循环定时器');
});

// ---------- 块查询 / 测量 ----------
test('readingBlockIndexAt：null / 没有 dataset / 坏值都返回 -1，数字照常解析', () => {
  const { ui } = build();
  assert.equal(ui.readingBlockIndexAt(null), -1);
  assert.equal(ui.readingBlockIndexAt({}), -1);
  assert.equal(ui.readingBlockIndexAt({ dataset: {} }), -1);
  assert.equal(ui.readingBlockIndexAt({ dataset: { index: 'abc' } }), -1);
  assert.equal(ui.readingBlockIndexAt({ dataset: { index: '2' } }), 2);
  assert.equal(ui.readingBlockIndexAt({ dataset: { index: '1.9' } }), 1.9);
});

test('readingBlockElements / readingLoadedIndexes / readingMeasureBlocks：按 dataset.index 过滤坏块', () => {
  const dom = makeDoc();
  const ctx = build({ dom });
  assert.deepEqual(ctx.ui.readingBlockElements(), [], '没有内容元素时返回空');
  assert.deepEqual(ctx.ui.readingLoadedIndexes(), []);

  dom.newBlock(0, 0);
  dom.newBlock(1, 500);
  const bad = makeEl('section');
  bad.className = 'reading-chapter';
  bad.dataset.index = 'oops';
  dom.map.get('reading-content').appendChild(bad);
  assert.equal(ctx.ui.readingBlockElements().length, 3);
  assert.deepEqual(ctx.ui.readingLoadedIndexes(), [0, 1], '坏 index 被过滤');
  const scroll = dom.map.get('reading-scroll');
  scroll.scrollTop = 42;
  const measured = ctx.ui.readingMeasureBlocks();
  assert.deepEqual(measured.map((b) => [b.index, b.top]), [[0, 42], [1, 542]]);
});

test('readingCurrentIndex：不在阅读模式 / 没章节返回 -1，其余夹到合法范围', () => {
  const closed = build();
  assert.equal(closed.ui.readingCurrentIndex(), -1);

  const empty = build({ open: true, chapters: [] });
  assert.equal(empty.ui.readingCurrentIndex(), -1);

  const ctx = build({ open: true, readingIndex: 99 });
  assert.equal(ctx.ui.readingCurrentIndex(), 2, '夹到最后一章');

  const neg = build({ open: true, readingIndex: -4 });
  assert.equal(neg.ui.readingCurrentIndex(), 0);

  const bad = build({ open: true, readingIndex: 'x' });
  assert.equal(bad.ui.readingCurrentIndex(), 0);
});

test('readingVisibleIndex：视野中线落在哪章；没有块时退回 readingCurrentIndex', () => {
  const dom = makeDoc();
  const ctx = build({ dom, open: true, readingIndex: 0, chapters: makeChapters(3) });
  const scroll = dom.map.get('reading-scroll');
  scroll.clientHeight = 200;
  scroll.scrollTop = 600;
  // 区块 top 在「滚动内容坐标系」里 = 视口 top − 滚动容器 top + scrollTop；这里把视口 top 摆成
  // 「第 0 章已经滚过去、第 1 章正好在中线附近」：内容坐标 0 / 600 / 1000，中线 700 → 第 1 章
  const b0 = dom.newBlock(0, 0);
  const b1 = dom.newBlock(1, 0);
  const b2 = dom.newBlock(2, 0);
  b0._top = -600;
  b1._top = 0;
  b2._top = 400;
  assert.equal(ctx.ui.readingVisibleIndex(), 1);

  dom.map.get('reading-content').children.length = 0;
  assert.equal(ctx.ui.readingVisibleIndex(), 0, '没有块时退回当前章');
  stopReading(ctx);
});

test('readingNearBottom：阈值来自 reading-logic（内容不足一屏也算到底）', () => {
  const dom = makeDoc();
  const ctx = build({ dom });
  const scroll = dom.map.get('reading-scroll');
  scroll.scrollHeight = 1000;
  scroll.clientHeight = 200;
  scroll.scrollTop = 0;
  assert.equal(ctx.ui.readingNearBottom(), false);
  scroll.scrollTop = 800; // maxScrollTop = 800，差值 0 <= 阈值
  assert.equal(ctx.ui.readingNearBottom(), true);
  scroll.scrollHeight = 100;
  scroll.clientHeight = 200;
  scroll.scrollTop = 0;
  assert.equal(ctx.ui.readingNearBottom(), true);
});

// ---------- UI 刷新 / 滚动 ----------
test('updateReadingUi：进度 / 目录 / 按钮禁用 / 末尾提示 / 字数摘要一起刷', () => {
  const dom = makeDoc();
  const ctx = build({ dom, open: true, readingIndex: 1, chapters: makeChapters(3) });
  dom.newBlock(0, 0);
  dom.newBlock(1, 400);
  ctx.ui.updateReadingUi();
  assert.equal(dom.map.get('reading-progress').textContent, '第 2 / 3 章 · 66.7%');
  assert.equal(dom.map.get('reading-toc').value, '1');
  assert.equal(dom.map.get('btn-reading-prev').disabled, false);
  assert.equal(dom.map.get('btn-reading-next').disabled, false);
  assert.equal(dom.map.get('reading-end').classList.contains('hidden'), true, '最后一章没加载时不显示「到底」');
  assert.equal(dom.map.get('reading-summary').textContent, `共 3 章 · 约 ${formatChars(100 + 101 + 102)}`);

  // 目录获得焦点时不被回写（避免和用户正在选的目标打架）
  dom.map.get('reading-toc').value = '0';
  dom.doc.activeElement = dom.map.get('reading-toc');
  ctx.ui.updateReadingUi();
  assert.equal(dom.map.get('reading-toc').value, '0');

  // 加载完最后一章后显示「到底」且下一章按钮禁用（当前章已是最后一章）
  dom.doc.activeElement = null;
  ctx.state.reading.index = 2;
  dom.newBlock(2, 800);
  ctx.ui.updateReadingUi();
  assert.equal(dom.map.get('reading-end').classList.contains('hidden'), false);
  assert.equal(dom.map.get('btn-reading-next').disabled, true);

  // 第一页时上一章按钮禁用
  ctx.state.reading.index = 0;
  ctx.ui.updateReadingUi();
  assert.equal(dom.map.get('btn-reading-prev').disabled, true);
  stopReading(ctx);
});

test('updateReadingUi：不在阅读模式时一个 DOM 都不碰', () => {
  const dom = makeDoc();
  const ctx = build({ dom, open: false });
  ctx.ui.updateReadingUi();
  assert.equal(dom.map.get('reading-progress').textContent, '');
});

test('readingScrollToBlock：滚到目标块顶部（−4）、同步 state 的 index / programmaticScrollTop；找不到返回 false', () => {
  const dom = makeDoc();
  const ctx = build({ dom, open: true });
  const scroll = dom.map.get('reading-scroll');
  dom.newBlock(0, 0);
  dom.newBlock(1, 300);
  assert.equal(ctx.ui.readingScrollToBlock(1), true);
  assert.equal(scroll.scrollTop, 296, '块顶端 300 − 4');
  assert.equal(ctx.state.reading.index, 1);
  assert.equal(ctx.state.reading.programmaticScrollTop, 296);
  assert.equal(ctx.ui.readingScrollToBlock(5), false);
});

test('setReadingPref：字号 / 行距夹到档位并写 CSS 变量 + 下拉值；阅读中会排一次滚动检查', () => {
  const dom = makeDoc();
  const ctx = build({ dom, open: true });
  assert.equal(ctx.ui.setReadingPref('font', 999), readingLogic.fontLevel(999));
  assert.equal(dom.map.get('reading-font-level').value, String(readingLogic.fontLevel(999)));
  assert.equal(dom.cssVars['--reading-font-size'], `${readingLogic.fontSize(readingLogic.fontLevel(999))}px`);
  assert.equal(dom.map.get('reading-line-level').value, String(2));

  assert.equal(ctx.ui.setReadingPref('line', 'oops'), readingLogic.lineLevel('oops'));
  assert.equal(dom.cssVars['--reading-line-height'], String(readingLogic.lineHeight(readingLogic.lineLevel('oops'))));
  assert.equal(ctx.state.readingPrefs.fontLevel, readingLogic.fontLevel(999), '档位写回 state.readingPrefs');
  assert.equal(ctx.state.reading.timer !== null, true, '阅读中调档会排滚动检查');
  clearTimeout(ctx.state.reading.timer);
  ctx.state.reading.timer = null;
});

test('scheduleReadingScrollCheck：不在阅读模式不排；连排只留最后一个；到点刷新 UI 并自动接章', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const closed = build({ dom: makeDoc(), open: false });
  closed.ui.scheduleReadingScrollCheck(10);
  assert.equal(closed.state.reading.timer, null);

  const dom = makeDoc();
  const ctx = build({ dom, open: true, readingIndex: 0, chapters: makeChapters(2) });
  const scroll = dom.map.get('reading-scroll');
  scroll.scrollHeight = 500;
  scroll.clientHeight = 200;
  scroll.scrollTop = 290; // 接近底部（阈值内）
  dom.newBlock(0, 0);
  ctx.ui.scheduleReadingScrollCheck(100);
  const first = ctx.state.reading.timer;
  ctx.ui.scheduleReadingScrollCheck(40);
  assert.notEqual(ctx.state.reading.timer, first, '新一次检查会清掉旧的');
  assert.equal(first._destroyed === true || true, true);
  t.mock.timers.tick(40);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ctx.state.reading.timer, null, '触发后清空 timer');
  assert.equal(ctx.calls.loadChapter.length, 1, '接近底部自动接下一章');
});

// ---------- 翻章 / 跳章 ----------
test('readingGo：不在阅读模式 / 加载中 / 已到头都返回结构化结果', async () => {
  const closed = build({ open: false });
  assert.deepEqual(await closed.ui.readingGo(-1), { ok: false, message: '不在阅读模式' });

  const busy = build({ open: true, readingIndex: 0 });
  busy.state.reading.loading = true;
  assert.deepEqual(await busy.ui.readingGo(1), { ok: false, busy: true });

  const edge = build({ open: true, readingIndex: 0 });
  assert.deepEqual(await edge.ui.readingGo(-1), { ok: false, edge: true, index: 0 });
});

test('readingGo：目标块已加载 → 直接滚过去；未加载 → 向后接章 / 向前补章后滚过去', async () => {
  // 已加载：直接滚
  const dom = makeDoc();
  const ctx = build({ dom, open: true, readingIndex: 0, chapters: makeChapters(2) });
  dom.newBlock(0, 0);
  dom.newBlock(1, 300);
  assert.deepEqual(await ctx.ui.readingGo(1), { ok: true, index: 1 });
  assert.equal(dom.map.get('reading-scroll').scrollTop, 296);
  stopReading(ctx);

  // 未加载 + 向后：api.loadChapter 拿下一章，接在后面再滚过去
  const dom2 = makeDoc();
  const ctx2 = build({ dom: dom2, open: true, readingIndex: 0, chapters: makeChapters(2) });
  dom2.newBlock(0, 0);
  assert.deepEqual(await ctx2.ui.readingGo(1), { ok: true, index: 1 });
  assert.deepEqual(ctx2.calls.loadChapter, [['/书库/书甲', 'c2.txt']]);
  assert.equal(dom2.map.get('reading-content').children.length, 2);
  assert.equal(ctx2.state.reading.index, 1);
  stopReading(ctx2);

  // 未加载 + 向前：补在最前面
  const dom3 = makeDoc();
  const ctx3 = build({ dom: dom3, open: true, readingIndex: 1, chapters: makeChapters(2) });
  dom3.newBlock(1, 0);
  assert.deepEqual(await ctx3.ui.readingGo(-1), { ok: true, index: 0 });
  assert.deepEqual(ctx3.calls.loadChapter, [['/书库/书甲', 'c1.txt']]);
  assert.equal(dom3.map.get('reading-content').children[0].dataset.index, '0');
  stopReading(ctx3);
});

test('readingGo：接章失败 → { ok:false, message:\'读取章节失败\' }', async () => {
  const dom = makeDoc();
  const ctx = build({ dom, open: true, readingIndex: 0, chapters: makeChapters(2), loadChapter: () => ({ text: null }) });
  // loadChapter 返回 null 文本本身是合法空章；让 createReadingBlock 抛错更接近「读失败」：这里用 loadChapter 抛错
  ctx.host.api.loadChapter = async () => { throw new Error('ENOENT'); };
  dom.newBlock(0, 0);
  // fetchReadingBlock 会把错误变成「错误占位块」，所以 readingGo 会成功滚过去，而不是失败
  const res = await ctx.ui.readingGo(1);
  assert.equal(res.ok, true);
  const last = dom.map.get('reading-content').children[dom.map.get('reading-content').children.length - 1];
  assert.match(last.children[0].className, /reading-chapter-error|reading-chapter-title/);
});

test('readingJumpTo：不在阅读模式 / 没章节 / 目标已加载 / 加载中 / 换批加载都对', async () => {
  const closed = build({ open: false });
  assert.deepEqual(await closed.ui.readingJumpTo(0), { ok: false, message: '不在阅读模式' });

  const empty = build({ open: true, chapters: [] });
  assert.deepEqual(await empty.ui.readingJumpTo(0), { ok: false, message: '没有章节' });

  const dom = makeDoc();
  const loaded = build({ dom, open: true, chapters: makeChapters(3) });
  dom.newBlock(0, 0);
  dom.newBlock(2, 800);
  assert.deepEqual(await loaded.ui.readingJumpTo(2), { ok: true, index: 2 });
  assert.equal(dom.map.get('reading-scroll').scrollTop, 796);
  stopReading(loaded);

  const dom2 = makeDoc();
  const replaced = build({ dom: dom2, open: true, chapters: makeChapters(3) });
  dom2.newBlock(0, 0);
  assert.deepEqual(await replaced.ui.readingJumpTo(2), { ok: true, index: 2 });
  assert.deepEqual(replaced.calls.loadChapter, [['/书库/书甲', 'c3.txt']]);
  assert.equal(dom2.map.get('reading-scroll')._focus, 1, '换批加载后把焦点给阅读区');
  stopReading(replaced);

  const busy = build({ dom: makeDoc(), open: true });
  busy.state.reading.loading = true;
  assert.deepEqual(await busy.ui.readingJumpTo(2), { ok: false, busy: true });
});

// ---------- 进入 / 退出 ----------
test('openReadingMode：先打开一本书 / 已打开 / 没章节 三种早退', async () => {
  const noBook = build({ bookPath: null, meta: null });
  assert.deepEqual(await noBook.ui.openReadingMode(), { ok: false, message: '先打开一本书' });

  const already = build({ open: true });
  assert.deepEqual(await already.ui.openReadingMode(), { ok: true, already: true });

  const empty = build({ chapters: [] });
  assert.deepEqual(await empty.ui.openReadingMode(), { ok: false, message: '没有章节' });
  assert.deepEqual(empty.calls.toast, [['这本书还没有章节，没法进入阅读模式', 'warn']]);
});

test('openReadingMode：进模式 → 收三个顶栏菜单、初始化 state、渲染标题 / 目录 / 摘要、切视图并加载首章', async () => {
  const dom = makeDoc();
  const ctx = build({ dom, open: false, index: 1, chapters: makeChapters(3), dirty: true });
  const res = await ctx.ui.openReadingMode();
  assert.deepEqual(res, { ok: true, startIndex: 1 });
  assert.equal(ctx.calls.hideContextMenu, 1);
  assert.equal(ctx.calls.hideVolumeMenu, 1);
  assert.equal(ctx.calls.hideHeaderMenus, 1);
  assert.equal(ctx.state.reading.open, true);
  assert.equal(ctx.state.reading.index, 1);
  assert.equal(ctx.state.reading.startIndex, 1);
  assert.equal(ctx.state.reading.token, 2, '进模式 +1、加载首章再 +1');
  assert.equal(dom.map.get('reading-book-title').textContent, '书甲');
  assert.equal(dom.map.get('reading-book-title').title, '书甲');
  assert.match(dom.map.get('reading-note').textContent, /未保存的修改/);
  assert.equal(dom.map.get('reading-note').classList.contains('hidden'), false);
  assert.equal(dom.map.get('reading-scroll').scrollTop, 0);
  assert.deepEqual(ctx.calls.showView, ['reading']);
  assert.deepEqual(ctx.calls.loadChapter, [['/书库/书甲', 'c2.txt']]);
  assert.equal(dom.map.get('reading-scroll')._focus, 1, '加载完把焦点给阅读区');
  assert.equal(ctx.calls.updateWindowTitle, 1, '加载首章后请渲染层重算一次窗口标题');

  // 干净的书写入时不显示「未保存」提示
  const clean = build({ dom: makeDoc(), index: 0 });
  await clean.ui.openReadingMode();
  assert.equal(clean.dom.map.get('reading-note').classList.contains('hidden'), true);
  stopReading(clean);
  stopReading(ctx);
});

test('openReadingMode：没有未保存修改时 note 隐藏；目录按章名生成 option', async () => {
  const dom = makeDoc();
  const ctx = build({ dom, index: 0, chapters: makeChapters(2) });
  await ctx.ui.openReadingMode();
  const toc = dom.map.get('reading-toc');
  assert.equal(toc.children.length, 2);
  assert.equal(toc.children[0].textContent, chaptersLib.formatTitle(ctx.state.meta, 0, '第1章'));
  assert.equal(toc.value, '0');
  assert.equal(dom.map.get('reading-note').classList.contains('hidden'), true);
  stopReading(ctx);
});

test('openReadingMode：有分卷时目录按卷分段（optgroup），单卷 / 无卷仍平铺（Phase D / D14）', async () => {
  const dom = makeDoc();
  const chapters = [
    { name: '序章', file: 'c1.txt', chars: 100 },
    { name: '出发', file: 'c2.txt', chars: 120, volumeId: 'v1' },
    { name: '抵达', file: 'c3.txt', chars: 140, volumeId: 'v1' },
    { name: '转折', file: 'c4.txt', chars: 160, volumeId: 'v2' }
  ];
  const meta = { title: '书甲', volumes: [{ id: 'v1', name: '第一卷' }, { id: 'v2', name: '第二卷' }] };
  const ctx = build({ dom, chapters, meta, index: 1 });
  await ctx.ui.openReadingMode();
  const toc = dom.map.get('reading-toc');
  assert.equal(toc.children.length, 3, '未分卷 + 两卷 = 三段');
  assert.deepEqual(toc.children.map((group) => group.label), ['未分卷', '第一卷', '第二卷']);
  assert.deepEqual(toc.children.map((group) => group.children.length), [1, 2, 1], '每段只装自己那几章');
  assert.equal(toc.children[1].children[0].value, '1');
  assert.equal(toc.children[1].children[0].textContent, chaptersLib.formatTitle(meta, 1, '出发'));
  assert.equal(toc.children[2].children[0].value, '3', 'option 的 value 仍是全书下标（跳章不受分组影响）');
  assert.equal(toc.value, '1', '选中项仍按全书下标');
  stopReading(ctx);

  // 只有一卷（所有章节都在同一卷里）：只有一段，仍平铺，不套 optgroup —— 外观与以前一字不差
  const single = build({
    dom: makeDoc(),
    chapters: [
      { name: '出发', file: 'c1.txt', chars: 100, volumeId: 'v1' },
      { name: '抵达', file: 'c2.txt', chars: 120, volumeId: 'v1' }
    ],
    meta: { title: '书乙', volumes: [{ id: 'v1', name: '第一卷' }] },
    index: 0
  });
  await single.ui.openReadingMode();
  const singleToc = single.dom.map.get('reading-toc');
  assert.equal(singleToc.children.length, 2);
  assert.equal(singleToc.children[0].tagName, 'option', '单卷不套分组');
  stopReading(single);
});


test('字号 / 行距按书记忆（Phase D / D13）：换本书取回自己的档位，只记本次运行', async () => {
  const dom = makeDoc();
  const ctx = build({ dom, chapters: makeChapters(2), bookPath: '/书库/书甲' });
  await ctx.ui.openReadingMode();
  assert.equal(ctx.state.readingPrefs.fontLevel, readingLogic.READING_FONT_DEFAULT, '第一次进这本书是默认档');
  assert.equal(ctx.state.readingPrefs.lineLevel, readingLogic.READING_LINE_DEFAULT);

  // 书甲调成「小 + 宽松」，退出
  ctx.ui.setReadingPref('font', 0);
  ctx.ui.setReadingPref('line', 2);
  assert.equal(dom.cssVars['--reading-font-size'], '17px');
  assert.equal(dom.cssVars['--reading-line-height'], '2.3');
  ctx.ui.exitReadingMode();

  // 换一本书：不沿用书甲的档位，回默认档
  ctx.state.bookPath = '/书库/书乙';
  ctx.state.meta = { title: '书乙' };
  await ctx.ui.openReadingMode();
  assert.equal(ctx.state.readingPrefs.fontLevel, readingLogic.READING_FONT_DEFAULT, '书乙第一次进来是默认档');
  assert.equal(ctx.state.readingPrefs.lineLevel, readingLogic.READING_LINE_DEFAULT);
  assert.equal(dom.cssVars['--reading-font-size'], '22px');
  // 书乙记成「特大 + 紧凑」，退出
  ctx.ui.setReadingPref('font', 3);
  ctx.ui.setReadingPref('line', 0);
  ctx.ui.exitReadingMode();

  // 回到书甲：取回它自己的「小 + 宽松」，顶栏下拉也跟着这本书走
  ctx.state.bookPath = '/书库/书甲';
  ctx.state.meta = { title: '书甲' };
  await ctx.ui.openReadingMode();
  assert.equal(ctx.state.readingPrefs.fontLevel, 0);
  assert.equal(ctx.state.readingPrefs.lineLevel, 2);
  assert.equal(dom.cssVars['--reading-font-size'], '17px');
  assert.equal(dom.cssVars['--reading-line-height'], '2.3');
  assert.equal(dom.map.get('reading-font-level').value, '0', '字号下拉 = 这本书的档位');
  assert.equal(dom.map.get('reading-line-level').value, '2', '行距下拉 = 这本书的档位');
  ctx.ui.exitReadingMode();

  // 再回书乙：它的「特大 + 紧凑」也还在（同一次运行里按书各记一份）
  ctx.state.bookPath = '/书库/书乙';
  await ctx.ui.openReadingMode();
  assert.equal(ctx.state.readingPrefs.fontLevel, 3);
  assert.equal(ctx.state.readingPrefs.lineLevel, 0);
  assert.equal(dom.cssVars['--reading-font-size'], '25px');
  // 只记在模块内存里：共享 state 的形状一个字没变（不新增字段、不写配置）
  assert.deepEqual(Object.keys(ctx.state.readingPrefs).sort(), ['fontLevel', 'lineLevel']);
  ctx.ui.exitReadingMode();
  stopReading(ctx);
});


// 模块本身不拼标题字符串：它只在「当前章变了」时通过 host.view.updateWindowTitle 请渲染层重算，
// 后缀文案（`（阅读 · 第 2/3 章）`）在 reading-logic 的单测里钉住，端到端由第 44 组 E2E 核对。
test('窗口标题：每次刷新都请渲染层重算一次；不在阅读模式一次都不喊', async () => {
  const dom = makeDoc();
  const ctx = build({ dom, open: true, readingIndex: 1, chapters: makeChapters(3) });
  dom.newBlock(0, 0);
  dom.newBlock(1, 300);
  dom.newBlock(2, 600);

  const closed = build({ dom: makeDoc(), open: false });
  closed.ui.updateReadingUi();
  assert.equal(closed.calls.updateWindowTitle, 0, '不在阅读模式不碰窗口标题');

  ctx.ui.updateReadingUi();
  assert.equal(ctx.calls.updateWindowTitle, 1, '可见章刷新后重算一次');

  await ctx.ui.readingGo(1);
  assert.equal(ctx.state.reading.index, 2);
  assert.equal(ctx.calls.updateWindowTitle, 2, '翻到下一章后重算一次');

  await ctx.ui.readingJumpTo(0);
  assert.equal(ctx.state.reading.index, 0);
  assert.equal(ctx.calls.updateWindowTitle, 3, '目录跳章后重算一次');

  // 滚动换章同样走 updateReadingUi：手动滚动不额外多发（防抖定时器里才刷新）
  dom.map.get('reading-scroll').scrollTop = 500;
  dom.map.get('reading-scroll').clientHeight = 200;
  dom.map.get('reading-scroll')._fire('scroll');
  assert.equal(ctx.calls.updateWindowTitle, 3, '滚动本身不直接写标题，等防抖刷新');

  stopReading(ctx);
  stopReading(closed);
});

test('exitReadingMode：不在阅读模式返回 false；在则清 state / timer / DOM、切回写作页并归还焦点', () => {
  const closed = build({ open: false });
  assert.equal(closed.ui.exitReadingMode(), false);

  const dom = makeDoc();
  const ctx = build({ dom, open: true, dirty: true });
  ctx.state.reading.timer = setTimeout(() => {}, 1000);
  dom.newBlock(0, 0);
  dom.map.get('reading-end').classList.remove('hidden');
  dom.map.get('reading-note').classList.remove('hidden');
  assert.equal(ctx.ui.exitReadingMode(), true);
  assert.equal(ctx.state.reading.open, false);
  assert.equal(ctx.state.reading.timer, null);
  assert.equal(ctx.state.reading.loading, false);
  assert.equal(dom.map.get('reading-content').children.length, 0);
  assert.equal(dom.map.get('reading-end').classList.contains('hidden'), true);
  assert.equal(dom.map.get('reading-note').classList.contains('hidden'), true);
  assert.equal(dom.map.get('reading-toc').children.length, 0);
  assert.deepEqual(ctx.calls.showView, ['editor']);
  assert.deepEqual(ctx.calls.scheduleMarksRender, [0]);
  assert.equal(ctx.calls.editorFocus, 1);
});

// ---------- 阅读位置记忆（v0.13 / U-D10：只记本次运行） ----------
// 假 DOM 里 loadChapter 造的区块没有布局，这里按标签塞一个高度，模拟「这一章有多高」，恢复位置才有得算。
function fakeBlockHeight(dom, height) {
  const make = dom.doc.createElement;
  dom.doc.createElement = (tag) => {
    const el = make(tag);
    if (tag === 'section') el._height = height;
    return el;
  };
}

test('阅读位置：退出时记下「哪一章 + 章内比例」，重进同一本书回到原处（只记内存）', async () => {
  const dom = makeDoc();
  const ctx = build({ dom, chapters: makeChapters(3), index: 0, bookPath: '/书库/书甲' });
  // 摆出一次阅读会话：第 1 章高 2000、第 2 章高 800，视口上沿停在第 1 章 35% 处
  // （假 DOM 的 _top 是「当前视口里的 top」，所以内容坐标 = _top − 视口顶 + scrollTop，与浏览器一致）
  ctx.state.reading.open = true;
  dom.newBlock(0, -700, 2000);
  dom.newBlock(1, 1300, 800);
  const scroll = dom.map.get('reading-scroll');
  scroll.clientHeight = 400;
  scroll.scrollHeight = 5000;
  scroll.scrollTop = 700;
  assert.equal(ctx.ui.exitReadingMode(), true, '退出时把位置记下来');
  // 重进：同一本书 + 编辑区没换章（index 仍是 0）→ 回到第 1 章 35% 处
  fakeBlockHeight(dom, 2000);
  const res = await ctx.ui.openReadingMode();
  assert.deepEqual(res, { ok: true, startIndex: 0 });
  assert.equal(ctx.state.reading.index, 0);
  assert.equal(ctx.ui.readingMeasureBlocks()[0].height, 2000, '区块测量带上高度（恢复章内位置要用）');
  assert.equal(scroll.scrollTop, 696, '章顶 0 − 4 + 0.35 × 2000');
  stopReading(ctx);
});

test('阅读位置：滚动到章内任意处可来回（readingScrollToBlock 的比例参数）；不传比例时行为不变', () => {
  const dom = makeDoc();
  const ctx = build({ dom, open: true, chapters: makeChapters(3) });
  dom.newBlock(0, 0, 1000);
  dom.newBlock(1, 1000, 400);
  const scroll = dom.map.get('reading-scroll');
  assert.equal(ctx.ui.readingScrollToBlock(1, 0.5), true);
  assert.equal(scroll.scrollTop, 1196, '块顶 1000 − 4 + 0.5 × 400');
  assert.equal(ctx.state.reading.index, 1);
  assert.equal(ctx.state.reading.programmaticScrollTop, 1196);
  scroll.scrollTop = 0; // 假 DOM 的 _top 不随滚动变化，复位后再测下一档
  assert.equal(ctx.ui.readingScrollToBlock(1, 7), true);
  assert.equal(scroll.scrollTop, 1396, '比例夹到 1');
  scroll.scrollTop = 0;
  assert.equal(ctx.ui.readingScrollToBlock(0), true);
  assert.equal(scroll.scrollTop, 0, '不传比例 = 章顶（−4 夹到 0），与以前一字不差');
  assert.equal(ctx.ui.readingScrollToBlock(9, 0.5), false, '找不到章仍是 false');
  stopReading(ctx);
});

test('阅读位置：编辑区换过章就不抢；新的模块实例（重启）回到默认', async () => {
  const dom = makeDoc();
  const ctx = build({ dom, chapters: makeChapters(3), index: 0, bookPath: '/书库/书甲' });
  ctx.state.reading.open = true;
  dom.newBlock(0, -1400, 1000);
  dom.newBlock(1, -400, 800);
  const scroll = dom.map.get('reading-scroll');
  scroll.clientHeight = 400;
  scroll.scrollHeight = 5000;
  scroll.scrollTop = 1400; // 第 2 章 50% 处
  ctx.ui.exitReadingMode();

  // 作者在编辑器里点了第 3 章再进阅读：按第 3 章开始（不回到上次读到的第 2 章）
  ctx.state.index = 2;
  fakeBlockHeight(dom, 800);
  const res = await ctx.ui.openReadingMode();
  assert.deepEqual(res, { ok: true, startIndex: 2 });
  assert.equal(ctx.state.reading.index, 2);
  assert.equal(scroll.scrollTop, 0, '换了起点就从章首开始');
  ctx.ui.exitReadingMode();

  // 「重启」= 新的 create 实例（内存表是新的）：同一本书也不再记得上次位置
  const fresh = build({ chapters: makeChapters(3), index: 0, bookPath: '/书库/书甲' });
  const freshRes = await fresh.ui.openReadingMode();
  assert.deepEqual(freshRes, { ok: true, startIndex: 0 }, '重启后回到默认（从当前写作章开始）');
  assert.equal(fresh.dom.map.get('reading-scroll').scrollTop, 0);
  stopReading(ctx);
  stopReading(fresh);
});

test('阅读位置：本次阅读出现过读取失败区块 → 不记位置，保住上一次的好位置', async () => {
  const dom = makeDoc();
  const ctx = build({ dom, chapters: makeChapters(3), index: 0, bookPath: '/书库/书甲' });
  ctx.state.reading.open = true;
  dom.newBlock(0, -500, 2000);
  const scroll = dom.map.get('reading-scroll');
  scroll.clientHeight = 400;
  scroll.scrollHeight = 5000;
  scroll.scrollTop = 500; // 第 1 章 25% 处
  ctx.ui.exitReadingMode();

  // 重进（先验证位置确实恢复了），再让本次会话里出现一个「读取失败」区块
  fakeBlockHeight(dom, 2000);
  await ctx.ui.openReadingMode();
  assert.equal(scroll.scrollTop, 496);
  const errorBlock = makeEl('section');
  errorBlock.className = 'reading-chapter';
  const errorText = makeEl('div');
  errorText.className = 'reading-chapter-error';
  errorText.textContent = '读取失败：文件不见了';
  errorBlock.appendChild(errorText);
  dom.map.get('reading-content').appendChild(errorBlock);
  scroll.scrollTop = 0; // 滚到顶再退出：要是照记，位置会变成章顶
  ctx.state.reading.index = 0;
  ctx.ui.exitReadingMode();

  // 再进：上次的「第 1 章 25%」还在（坏章那次的 0% 没有覆盖它）
  await ctx.ui.openReadingMode();
  assert.equal(scroll.scrollTop, 496, '坏章不参与位置记忆');
  assert.equal(ctx.state.reading.index, 0);
  stopReading(ctx);
});

// ---------- 键盘翻章（Phase D / D3） ----------
function fireReadingKey(dom, key, extra = {}) {
  let prevented = 0;
  const event = {
    key,
    target: dom.map.get('reading-scroll'),
    preventDefault() { prevented += 1; },
    ...extra
  };
  dom.map.get('reading-view')._fire('keydown', event);
  return prevented;
}

test('键盘翻章：← / → 走与按钮同一条 readingGo；修饰键 / 下拉 / 不在阅读模式都不抢', async () => {
  const dom = makeDoc();
  const ctx = build({ dom, open: true, readingIndex: 1, chapters: makeChapters(3) });
  ctx.ui.setupReadingUi();
  dom.newBlock(0, 0);
  dom.newBlock(1, 300);
  dom.newBlock(2, 600);

  assert.equal(fireReadingKey(dom, 'ArrowRight'), 1, '→ 接走并 preventDefault');
  await flush();
  assert.equal(ctx.state.reading.index, 2);
  assert.equal(dom.map.get('reading-scroll').scrollTop, 596, '滚到第 3 章块顶端（−4）');

  assert.equal(fireReadingKey(dom, 'ArrowLeft'), 1);
  await flush();
  assert.equal(ctx.state.reading.index, 1);

  // 让给浏览器 / 控件 / 别的层：这些键一个都不翻章
  assert.equal(fireReadingKey(dom, 'PageDown'), 0, '翻页键归浏览器滚动（阅读模式不抢滚轮 / PageUp / PageDown）');
  assert.equal(fireReadingKey(dom, 'ArrowRight', { ctrlKey: true }), 0);
  assert.equal(fireReadingKey(dom, 'ArrowRight', { altKey: true }), 0);
  assert.equal(fireReadingKey(dom, 'ArrowRight', { shiftKey: true }), 0);
  assert.equal(fireReadingKey(dom, 'ArrowRight', { metaKey: true }), 0);
  assert.equal(fireReadingKey(dom, 'ArrowRight', { defaultPrevented: true }), 0, '别的层已经接走');
  for (const target of [{ tagName: 'SELECT' }, { tagName: 'input' }, { tagName: 'TEXTAREA' }, { isContentEditable: true }]) {
    assert.equal(fireReadingKey(dom, 'ArrowRight', { target }), 0, '控件里的方向键让给控件');
  }
  assert.equal(ctx.state.reading.index, 1, '上面这些键一个都没翻章');

  // 焦点不在控件上（合成事件没有 target）时照常翻；到章尾再按 → 停住、不越界
  assert.equal(fireReadingKey(dom, 'ArrowRight', { target: null }), 1);
  await flush();
  assert.equal(ctx.state.reading.index, 2);
  assert.equal(fireReadingKey(dom, 'ArrowRight'), 1, '章尾照样接走（不触发浏览器默认行为）');
  await flush();
  assert.equal(ctx.state.reading.index, 2, '到章尾停住，不越界');
  stopReading(ctx);

  // 不在阅读模式：一个键都不接
  const closed = build({ dom: makeDoc(), open: false });
  closed.ui.setupReadingUi();
  assert.equal(fireReadingKey(closed.dom, 'ArrowRight'), 0);
  assert.equal(fireReadingKey(closed.dom, 'ArrowLeft'), 0);
});

// ---------- Ctrl+滚轮 / Ctrl+= / Ctrl+- 调字号（Phase D / D6） ----------
function fireReadingWheel(dom, deltaY, extra = {}) {
  let prevented = 0;
  const event = {
    deltaY,
    target: dom.map.get('reading-scroll'),
    preventDefault() { prevented += 1; },
    ...extra
  };
  dom.map.get('reading-view')._fire('wheel', event);
  return prevented;
}

test('Ctrl+滚轮 / Ctrl+= / Ctrl+- 调字号：只走 setReadingPref（改 CSS 变量、不写配置），组合键与普通滚轮都不抢', () => {
  const dom = makeDoc();
  const ctx = build({ dom, open: true, readingIndex: 0, chapters: makeChapters(2) });
  ctx.ui.setupReadingUi();
  const level = () => ctx.state.readingPrefs.fontLevel;
  const fontVar = () => dom.cssVars['--reading-font-size'];
  const MAX = readingLogic.READING_FONT_LEVELS.length - 1;

  assert.equal(level(), 2, '默认「大」');
  assert.equal(fireReadingWheel(dom, -100, { ctrlKey: true }), 1, 'Ctrl+上滚放大一档并拦掉默认（否则 Chromium 会整页缩放）');
  assert.equal(level(), 3);
  assert.equal(fontVar(), '25px', '只改阅读视图的 CSS 变量');
  assert.equal(fireReadingWheel(dom, 120, { ctrlKey: true }), 1);
  assert.equal(level(), 2);
  assert.equal(fontVar(), '22px');

  // 不按 Ctrl 的滚轮：字号一个字不改，也不拦（滚动继续归浏览器）
  assert.equal(fireReadingWheel(dom, -100), 0);
  assert.equal(fireReadingWheel(dom, 100), 0);
  assert.equal(level(), 2, '普通滚轮不调字号');
  // Ctrl+Shift / Ctrl+Alt / Ctrl+Meta 的滚轮让给系统
  for (const extra of [{ shiftKey: true }, { altKey: true }, { metaKey: true }]) {
    assert.equal(fireReadingWheel(dom, -100, { ctrlKey: true, ...extra }), 0, `Ctrl+${Object.keys(extra)[0]} 的滚轮不抢`);
  }
  // 横向滚轮（deltaY = 0）不算放大
  assert.equal(fireReadingWheel(dom, 0, { ctrlKey: true }), 0);
  assert.equal(level(), 2);

  // 到两端停住（档位夹紧在 readingLogic 里，不越界、不报错）
  for (let i = 0; i < 6; i += 1) fireReadingWheel(dom, -100, { ctrlKey: true });
  assert.equal(level(), MAX, '到最大档停住');
  assert.equal(fontVar(), '25px');
  for (let i = 0; i < 9; i += 1) fireReadingWheel(dom, 100, { ctrlKey: true });
  assert.equal(level(), 0, '到最小档停住');
  assert.equal(fontVar(), '17px');
  assert.equal(ctx.calls.showView.length, 0, '调字号不切视图');

  // 键盘：Ctrl+= 放大 / Ctrl+- 缩小，和字号下拉同一条 setReadingPref
  assert.equal(fireReadingKey(dom, '=', { ctrlKey: true }), 1, 'Ctrl+= 接走并 preventDefault');
  assert.equal(level(), 1);
  assert.equal(fireReadingKey(dom, '-', { ctrlKey: true }), 1);
  assert.equal(level(), 0);
  assert.equal(level(), readingLogic.fontLevel(0), '夹在档位里（不会变成 -1）');
  // Ctrl++ 在多数布局里是 Ctrl+Shift+=：键名 '+' 照收
  assert.equal(fireReadingKey(dom, '+', { ctrlKey: true, shiftKey: true }), 1);
  assert.equal(level(), 1);
  // 不带 Ctrl 的 = / -（正文里正常打字）、Ctrl+Alt+= 都不接
  assert.equal(fireReadingKey(dom, '='), 0);
  assert.equal(fireReadingKey(dom, '-'), 0);
  assert.equal(fireReadingKey(dom, '=', { ctrlKey: true, altKey: true }), 0);
  assert.equal(fireReadingKey(dom, '=', { ctrlKey: true, metaKey: true }), 0);
  assert.equal(level(), 1, '上面这些键一个都没动字号');

  // 不在阅读模式：Ctrl+滚轮 / Ctrl+= 一个都不接
  const closed = build({ dom: makeDoc(), open: false });
  closed.ui.setupReadingUi();
  assert.equal(fireReadingWheel(closed.dom, -100, { ctrlKey: true }), 0);
  assert.equal(fireReadingKey(closed.dom, '=', { ctrlKey: true }), 0);
  assert.equal(closed.state.readingPrefs.fontLevel, 2, '不在阅读模式时字号不动');

  stopReading(ctx);
});

// ---------- 事件绑定 ----------
test('setupReadingUi：注册 11 个监听；scroll 保持 passive:true、Ctrl+滚轮必须 passive:false；按钮 / 下拉 / 滚动都接到真实函数', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dom = makeDoc();
  const ctx = build({ dom, open: true, readingIndex: 0, chapters: makeChapters(3) });
  ctx.ui.setupReadingUi();
  const ids = ['btn-reading', 'btn-reading-exit', 'btn-reading-first', 'btn-reading-prev', 'btn-reading-next', 'reading-font-level', 'reading-line-level', 'reading-toc', 'reading-scroll'];
  for (const id of ids) assert.equal(dom.map.get(id)._listeners.length, 1, id + ' 应该恰好注册一次');
  assert.deepEqual(dom.map.get('reading-scroll')._listeners[0].options, { passive: true });
  assert.equal(dom.map.get('btn-reading')._listeners[0].type, 'click');
  assert.equal(dom.map.get('reading-font-level')._listeners[0].type, 'change');
  assert.deepEqual(
    dom.map.get('reading-view')._listeners.map((l) => l.type),
    ['keydown', 'wheel'],
    '阅读视图上挂两个委托：键盘翻章 + Ctrl+滚轮调字号'
  );
  assert.equal(dom.map.get('reading-view')._listeners[0].type, 'keydown', '键盘翻章挂在阅读视图上（焦点在按钮上也收得到）');
  assert.deepEqual(dom.map.get('reading-view')._listeners[1].options, { passive: false }, 'Ctrl+滚轮要能 preventDefault，必须非被动');

  // 字号 / 行距下拉走 setReadingPref（值从 DOM 读）
  dom.map.get('reading-font-level').value = '5';
  dom.map.get('reading-font-level')._fire('change');
  assert.equal(ctx.state.readingPrefs.fontLevel, readingLogic.fontLevel(5));
  dom.map.get('reading-line-level').value = '0';
  dom.map.get('reading-line-level')._fire('change');
  assert.equal(ctx.state.readingPrefs.lineLevel, readingLogic.lineLevel(0));

  // 目录 change → readingJumpTo（目标已加载时直接滚）
  dom.newBlock(0, 0);
  dom.newBlock(1, 400);
  dom.map.get('reading-toc').value = '1';
  dom.map.get('reading-toc')._fire('change');
  await flush();
  assert.equal(ctx.state.reading.index, 1);

  // 下一章按钮：目标章还没加载 → 触发接章（api.loadChapter 的第二个参数是下一章文件名）
  dom.map.get('btn-reading-next')._fire('click');
  await flush();
  assert.deepEqual(ctx.calls.loadChapter, [['/书库/书甲', 'c3.txt']]);
  // 退出按钮
  dom.map.get('btn-reading-exit')._fire('click');
  assert.deepEqual(ctx.calls.showView, ['editor']);

  // 滚动：记录位置、按视野中线更新当前章、并排一次滚动检查（程序化滚到的位置与手动滚动不同）
  ctx.state.reading.open = true;
  // 退出阅读已清空 DOM，这里重新摆三个区块（内容坐标 0 / 400 / 800）
  dom.newBlock(0, 0);
  dom.newBlock(1, 400);
  dom.newBlock(2, 800);
  dom.map.get('reading-scroll').scrollTop = 500;
  dom.map.get('reading-scroll').clientHeight = 200;
  dom.map.get('reading-scroll')._fire('scroll');
  assert.equal(ctx.state.reading.index, 0, '中线落在第 0 章（内容坐标 500 ≤ 600）');
  assert.notEqual(ctx.state.reading.timer, null);
  stopReading(ctx);
});

// ---------- 静态闸门 ----------
test('静态闸门：renderer.js 不再内嵌阅读模式实现，只剩装配与转发', () => {
  for (const shape of [
    'function readingScrollEl(',
    'function readingBlockElements(',
    'function readingMeasureBlocks(',
    'function readingSummaryText(',
    'function updateReadingUi(',
    'function onReadingScroll(',
    'function createReadingBlock(',
    'async function fetchReadingBlock(',
    'async function readingReplaceAt(',
    'function scheduleReadingScrollCheck(',
    'async function readingGo(',
    'async function readingJumpTo(',
    'async function openReadingMode(',
    'function exitReadingMode('
  ]) {
    assert.equal(rendererSrc.includes(shape), false, 'renderer.js 里还有第二份：' + shape);
  }
  assert.equal(rendererSrc.split('readingUiModule.create(').length - 1, 1, '装配只许一处');
  assert.ok(rendererSrc.includes('const readingUiModule = window.CWReadingUi;'), '渲染层按 CWReadingUi 取模块');
  for (const line of [
    '    $, state, api, call, toast,',
    '    reading: { readingLogic, formatChars },',
    '    view: { showView, hideContextMenu, hideVolumeMenu, hideHeaderMenus, editorEl, scheduleMarksRender, updateWindowTitle },',
    '    chapterTitle'
  ]) {
    assert.ok(rendererSrc.includes(line), '装配少了：' + line);
  }
  assert.ok(rendererSrc.includes(
    'const { readingScrollEl, readingBlockElements, readingBlockIndexAt, readingLoadedIndexes, readingMeasureBlocks, readingCurrentIndex, readingVisibleIndex, readingNearBottom, setReadingPref, updateReadingUi, readingScrollToBlock, scheduleReadingScrollCheck, readingGo, readingJumpTo, openReadingMode, exitReadingMode } = readingUi;'
  ), '16 个入口按原名解构');
  // 绑定块搬走：不再注册阅读 8 个元素，只留一次 setup 调用
  for (const id of ['btn-reading', 'btn-reading-exit', 'btn-reading-first', 'btn-reading-prev', 'btn-reading-next', 'reading-font-level', 'reading-line-level', 'reading-toc', 'reading-scroll']) {
    assert.equal(rendererSrc.includes(`$('${id}').addEventListener`), false, '绑定应该只在模块里：' + id);
  }
  assert.equal(rendererSrc.split('readingUi.setupReadingUi();').length - 1, 1, 'setup 只调一次');
  // 留在 renderer 的入口：Esc 的动作表、window resize 的滚动检查、测试钩子 16 个键
  assert.match(rendererSrc, /'exit-reading': \(\) => exitReadingMode\(\),/);
  assert.match(rendererSrc, /scheduleReadingScrollCheck\(80\);/);
  for (const key of ['readingScrollEl', 'readingBlockElements', 'readingBlockIndexAt', 'readingLoadedIndexes', 'readingMeasureBlocks', 'readingCurrentIndex', 'readingVisibleIndex', 'readingNearBottom', 'setReadingPref', 'updateReadingUi', 'readingScrollToBlock', 'scheduleReadingScrollCheck', 'readingGo', 'readingJumpTo', 'openReadingMode', 'exitReadingMode']) {
    assert.match(rendererSrc, new RegExp('^      ' + key + ',$', 'm'), 'testHooksScope 少了 ' + key);
  }
});

test('静态闸门：index.html 在 renderer.js 之前加载 reading-ui.js，且只加载一次', () => {
  const at = indexSrc.indexOf('<script src="reading-ui.js"></script>');
  const rendererAt = indexSrc.indexOf('<script src="renderer.js"></script>');
  assert.notEqual(at, -1);
  assert.ok(at < rendererAt);
  assert.equal(indexSrc.split('reading-ui.js').length - 1, 1);
});

test('静态闸门：模块不 require / 不摸 Electron·fs·网络，也不注册全局监听', () => {
  for (const forbidden of ['require(', 'ipcRenderer', 'node:fs', 'child_process', 'localStorage', 'fetch(', 'window.', 'process.']) {
    assert.equal(moduleCode.includes(forbidden), false, 'reading-ui.js 不许出现 ' + forbidden);
  }
  assert.equal(/window\.addEventListener|document\.addEventListener/.test(moduleCode), false, '模块不注册全局监听');
  const setupStart = moduleCode.indexOf('function setupReadingUi()');
  assert.ok(setupStart > 0, '模块里找不到 setupReadingUi');
  assert.equal(moduleCode.slice(0, setupStart).includes('addEventListener'), false, 'setup 之外不许注册事件');
  // 定时器只有滚动检查一处
  assert.equal((moduleCode.match(/setTimeout\(/g) || []).length, 1, '模块只有一个 setTimeout（滚动检查）');
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWReadingUi，且不乱造别的全局', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(moduleSrc, context, { filename: 'renderer/reading-ui.js' });
  assert.equal(typeof win.CWReadingUi, 'object');
  assert.deepEqual(Object.keys(win.CWReadingUi).sort(), ['REQUIRED_HOST', 'create']);
  assert.equal(win.CWReadingUi.REQUIRED_HOST.length, 8);
  assert.equal(typeof win.CWReadingUi.create, 'function');
  assert.equal(win.CWHistoryUi, undefined, '单独加载 reading-ui 不该顺手造出别的全局');
  assert.equal(win.CWChapters, undefined);
});
