const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const editorMarksUi = require('../renderer/editor-marks-ui');
const editorLogic = require('../renderer/editor-logic');
const commonLib = require('../core/common');
const caretColorLib = require('../core/caret-color');

// 第 4 步 renderer 九刀·第三刀：编辑器小件（原 renderer.js 1519–1951，433 行）搬到 renderer/editor-marks-ui.js。
// 搬之前这一域只有 E2E 第 65 组黑盒覆盖（建标记层 / 超长段落黄线 / 当前段落高亮 / 菜单开关）；
// marksPlan 切分 / 超长整层收起 / 干净行整层重建 / IME 拼字不重画 / 色板 aria / 6 处监听这些分支
// 在 Node 里一步都测不到。搬出来以后用「假 host + 假 DOM」逐条钉住，再用静态闸门保证渲染层不长回第二份。
//
// 契约：host 9 个成员 = 基础 3（$, state, toast）+ persistMarks（两个开关按书写盘回调）+
// editor{editorEl,editorLogic,LONG_PARAGRAPH_THRESHOLD,caretColorLib,caretColorValue} +
// find{renderFindHighlights,syncFindOverlayScroll} + focus{focusActive,scheduleTypewriterAlign} +
// stats{renderSelectionStats} + scroll{scrollCaretIntoView}。

const realDocument = globalThis.document;
const realGetComputedStyle = globalThis.getComputedStyle;
const realResizeObserver = globalThis.ResizeObserver;
const ALL_CTX = [];
function stopMarks(ctx) {
  if (ctx && ctx.state && ctx.state.marks.timer) {
    clearTimeout(ctx.state.marks.timer);
    ctx.state.marks.timer = null;
  }
}
test.after(() => {
  for (const ctx of ALL_CTX) stopMarks(ctx);
  if (realDocument === undefined) delete globalThis.document;
  else globalThis.document = realDocument;
  if (realGetComputedStyle === undefined) delete globalThis.getComputedStyle;
  else globalThis.getComputedStyle = realGetComputedStyle;
  if (realResizeObserver === undefined) delete globalThis.ResizeObserver;
  else globalThis.ResizeObserver = realResizeObserver;
});

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const moduleSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'editor-marks-ui.js'), 'utf8');
const moduleCode = moduleSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------- 假 DOM ----------
function makeStyle() {
  return {
    _props: {},
    left: '', top: '', width: '', height: '',
    fontFamily: '', fontSize: '', fontWeight: '', fontStyle: '', lineHeight: '', letterSpacing: '',
    setProperty(name, value) { this._props[name] = value; },
    removeProperty(name) { delete this._props[name]; }
  };
}

function collectText(node) {
  if (!node) return '';
  if (node._textNode) return String(node.textContent);
  if (!node.children || node.children.length === 0) return String(node.textContent || '');
  return node.children.map((c) => collectText(c)).join('');
}

// 影子层里 <i>␣</i> / <i>·</i> 是标记字形，不属于正文：还原正文时只取标记 span 的第一个文本子节点
function collectSourceText(node) {
  if (!node) return '';
  if (node._textNode) return String(node.textContent);
  if (hasClass(node, 'mark-fw') || hasClass(node, 'mark-trail')) return collectText(node.children[0]);
  if (!node.children || node.children.length === 0) return '';
  return node.children.map((c) => collectSourceText(c)).join('');
}

function hasClass(node, name) {
  return String(node.className || '').split(/\s+/).includes(name);
}

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
    dataset: {},
    children: [],
    parentNode: null,
    parentElement: null,
    style: makeStyle(),
    scrollTop: 0,
    scrollLeft: 0,
    clientWidth: 600,
    clientHeight: 400,
    offsetLeft: 0,
    offsetTop: 0,
    selectionStart: 0,
    _focusCount: 0,
    _classes: classes,
    _listeners: listeners,
    _attrs: {},
    _rects: [],
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
      child.parentElement = el;
      el.children.push(child);
      return child;
    },
    focus() { el._focusCount += 1; },
    setSelectionRange(start) { el.selectionStart = start; },
    setAttribute(name, value) { el._attrs[name] = value; },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(el._attrs, name) ? el._attrs[name] : null; },
    getBoundingClientRect() { return { top: el._top || 0, left: el._left || 0, width: el.clientWidth, height: el.clientHeight }; },
    getClientRects() { return el._rects; },
    addEventListener(type, fn, options) { listeners.push({ type, fn, options }); },
    _fire(type, event) {
      let result;
      for (const l of listeners) if (l.type === type) result = l.fn(event);
      return result;
    },
    querySelectorAll(selector) {
      const out = [];
      const visit = (node) => {
        for (const child of node.children || []) {
          if (matchSelector(child, selector)) out.push(child);
          visit(child);
        }
      };
      visit(el);
      return out;
    },
    querySelector(selector) { return el.querySelectorAll(selector)[0] || null; }
  };
  function matchSelector(node, selector) {
    let m = /^\.([\w-]+)$/.exec(selector);
    if (m) return hasClass(node, m[1]);
    m = /^\.([\w-]+)\[data-line="(\d+)"\]$/.exec(selector);
    if (m) return hasClass(node, m[1]) && node.dataset.line === m[2];
    m = /^\[data-([\w-]+)\]$/.exec(selector);
    if (m) {
      const camel = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return Object.prototype.hasOwnProperty.call(node.dataset, camel);
    }
    return false;
  }
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
    activeElement: null,
    createElement: (tag) => makeEl(tag),
    createTextNode(text) { const n = makeEl('#text'); n._textNode = true; n.textContent = text; return n; },
    createDocumentFragment() { const frag = makeEl('fragment'); frag._isFragment = true; return frag; },
    getElementById: (id) => { lookups += 1; return map.get(id) || null; },
    addEventListener() {}
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
  'editor-marks', 'editor-marks-gutter', 'status-long-para',
  'format-invisibles', 'format-long-para', 'format-caret-para', 'format-caret-colors', 'format-caret-color'
];

function build(options = {}) {
  const dom = options.dom || makeDocument();
  for (const id of BASE_IDS) dom.ensure(id);
  // 标记层与黄线两层默认 hidden（与 index.html 一致）
  dom.map.get('editor-marks').classList.add('hidden');
  dom.map.get('editor-marks-gutter').classList.add('hidden');
  globalThis.document = dom.doc;
  globalThis.getComputedStyle = (el) => ({
    paddingTop: '10px', paddingBottom: '10px', paddingLeft: '56px', paddingRight: '56px',
    fontFamily: '"SimSun"', fontSize: '18px', fontWeight: '400', fontStyle: 'normal',
    lineHeight: '1.95', letterSpacing: '0.02em'
  });
  const state = {
    view: options.view === undefined ? 'editor' : options.view,
    bookPath: options.bookPath === undefined ? '/书库/书甲' : options.bookPath,
    index: options.index === undefined ? 0 : options.index,
    config: { caretParagraphColor: options.caretColor || '' },
    focus: { on: Boolean(options.focusOn), typewriter: Boolean(options.typewriter) },
    find: { total: options.findTotal || 0 },
    marks: {
      invisibles: Boolean(options.invisibles),
      longParagraphs: Boolean(options.longParagraphs),
      caretParagraph: Boolean(options.caretParagraph),
      tooLargeWarned: false,
      marksTooLarge: false,
      caretTooLarge: false,
      longItems: [],
      longCount: 0,
      longTruncated: false,
      markCounts: { fullwidth: 0, trailing: 0 },
      markTruncated: false,
      caretLine: 0,
      composing: false,
      timer: null,
      barBaseScrollTop: 0,
      resizeObserver: null
    }
  };
  const calls = {
    toast: [], persistMarks: [], renderFindHighlights: 0, syncFindOverlayScroll: 0, renderSelectionStats: 0,
    scheduleTypewriterAlign: [], scrollCaretIntoView: [], resized: 0
  };
  const editorEl = makeEl('textarea');
  editorEl.value = options.text === undefined ? 'abc' : options.text;
  editorEl.selectionStart = options.selectionStart || 0;
  const host = {
    $: dom.$,
    state,
    toast(message, kind) { calls.toast.push([message, kind]); },
    // 按书写盘回调（1.1.0）：记录补丁；'throw' / 'reject' 用来测失败提示
    persistMarks(patch) {
      calls.persistMarks.push(patch);
      if (options.persistMarks === 'throw') throw new Error('磁盘满了');
      if (options.persistMarks === 'reject') return Promise.reject(new Error('磁盘满了'));
      return Promise.resolve(patch);
    },
    editor: {
      editorEl,
      editorLogic,
      LONG_PARAGRAPH_THRESHOLD: options.threshold === undefined ? editorLogic.LONG_PARAGRAPH_DEFAULT : options.threshold,
      caretColorLib,
      caretColorValue: (cfg) => caretColorLib.normalizeColor(((cfg || state.config || {}).caretParagraphColor))
    },
    find: {
      renderFindHighlights() { calls.renderFindHighlights += 1; },
      syncFindOverlayScroll() { calls.syncFindOverlayScroll += 1; }
    },
    focus: {
      focusActive: () => Boolean(state.focus.on),
      scheduleTypewriterAlign(delay) { calls.scheduleTypewriterAlign.push(delay); }
    },
    stats: {
      renderSelectionStats() { calls.renderSelectionStats += 1; },
      formatCount: commonLib.formatCount
    },
    scroll: { scrollCaretIntoView(pos) { calls.scrollCaretIntoView.push(pos); } }
  };
  const ui = editorMarksUi.create(host);
  const ctx = { ui, host, state, dom, calls, editorEl };
  ALL_CTX.push(ctx);
  return ctx;
}

// ---------- host 契约 ----------
test('host 契约：9 个成员 + 分组内每个真实依赖；缺任何一个都抛 TypeError', () => {
  assert.deepEqual([...editorMarksUi.REQUIRED_HOST].sort(), [
    '$', 'editor', 'find', 'focus', 'persistMarks', 'scroll', 'state', 'stats', 'toast'
  ]);
  assert.equal(editorMarksUi.REQUIRED_HOST.length, 9);
  const ctx = build();
  assert.doesNotThrow(() => editorMarksUi.create(ctx.host));
  assert.throws(() => editorMarksUi.create(null), /createEditorMarksUi 需要 host 对象/);
  assert.throws(() => editorMarksUi.create('x'), /createEditorMarksUi 需要 host 对象/);
  for (const key of editorMarksUi.REQUIRED_HOST) {
    const broken = { ...ctx.host };
    delete broken[key];
    assert.throws(() => editorMarksUi.create(broken), new RegExp('host 缺少 ' + key.replace('$', '\\$')), '缺 ' + key);
  }
  // 写盘回调必须是函数：别等到点开关才发现（不是 undefined 也要拦）
  assert.throws(() => editorMarksUi.create({ ...ctx.host, persistMarks: 'x' }), /host\.persistMarks 必须是函数/);
  for (const key of ['editorEl', 'editorLogic', 'LONG_PARAGRAPH_THRESHOLD', 'caretColorLib', 'caretColorValue']) {
    const broken = { ...ctx.host, editor: { ...ctx.host.editor } };
    delete broken.editor[key];
    assert.throws(() => editorMarksUi.create(broken), new RegExp('host\\.editor 缺少 ' + key));
  }
  for (const key of ['renderFindHighlights', 'syncFindOverlayScroll']) {
    const broken = { ...ctx.host, find: { ...ctx.host.find } };
    delete broken.find[key];
    assert.throws(() => editorMarksUi.create(broken), new RegExp('host\\.find 缺少 ' + key));
  }
  for (const key of ['focusActive', 'scheduleTypewriterAlign']) {
    const broken = { ...ctx.host, focus: { ...ctx.host.focus } };
    delete broken.focus[key];
    assert.throws(() => editorMarksUi.create(broken), new RegExp('host\\.focus 缺少 ' + key));
  }
  assert.throws(() => editorMarksUi.create({ ...ctx.host, stats: {} }), /host\.stats 缺少 renderSelectionStats/);
  assert.throws(() => editorMarksUi.create({ ...ctx.host, scroll: {} }), /host\.scroll 缺少 scrollCaretIntoView/);
  assert.throws(() => editorMarksUi.create({ ...ctx.host, editor: 'x' }), /host\.editor 必须是对象/);
  assert.throws(() => editorMarksUi.create({ ...ctx.host, find: 'x' }), /host\.find 必须是对象/);
});

test('create() 只建表：不碰 DOM / 不注册事件 / 不建定时器，交出 13 个入口', () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  assert.equal(dom.lookups, 0, 'create() 一次 $ 都不该调');
  assert.deepEqual(Object.keys(ctx.ui).sort(), [
    'hideEditorMarks', 'jumpParagraph', 'jumpToNextLongParagraph', 'renderCaretColorRow', 'renderEditorMarks',
    'renderMarksMenu', 'scheduleMarksRender', 'setMarksToggle', 'setupEditorMarks', 'syncEditorOverlay',
    'syncMarksScroll', 'toggleMarks', 'updateCaretParagraph'
  ]);
  assert.equal(moduleCode.includes('setInterval'), false, '模块不建循环定时器');
});

// ---------- 标记层渲染 ----------
test('renderEditorMarks：视图 / 书 / 开关任一不满足就清层隐藏；三开关全关不建节点', () => {
  for (const options of [{ view: 'shelf' }, { bookPath: null }, { index: -1 }]) {
    const ctx = build(options);
    ctx.state.marks.invisibles = true;
    ctx.ui.renderEditorMarks();
    assert.equal(ctx.dom.map.get('editor-marks').classList.contains('hidden'), true, JSON.stringify(options));
  }
  const ctx = build();
  ctx.state.marks.invisibles = false;
  ctx.state.marks.longParagraphs = false;
  ctx.state.marks.caretParagraph = false;
  ctx.ui.renderEditorMarks();
  assert.equal(ctx.dom.map.get('editor-marks').classList.contains('hidden'), true);
});

test('renderEditorMarks：按 marksPlan 建节点，拼回正文逐字等于原文（不变量）', () => {
  const text = '第一段。\n\n第二段有　全角空格和行尾空白  \n第三段。';
  const ctx = build({ text, invisibles: true, caretParagraph: true, selectionStart: 3 });
  ctx.ui.renderEditorMarks();
  const overlay = ctx.dom.map.get('editor-marks');
  assert.equal(overlay.classList.contains('hidden'), false);
  assert.equal(collectSourceText(overlay), text, '影子层去掉标记字形后必须和正文一字不差');
  assert.ok(overlay.querySelectorAll('.marks-line').length > 0, '有标记 / 光标的行要有 span');
  const fw = overlay.querySelectorAll('.mark-fw');
  assert.ok(fw.length > 0, '全角空格要画 ␣ 标记');
  assert.match(collectText(fw[0]), /␣$/);
  const trail = overlay.querySelectorAll('.mark-trail');
  assert.ok(trail.length > 0, '行尾空白要画浅红底');
  assert.match(collectText(trail[0]), /·$/);
  assert.ok(overlay.querySelectorAll('.caret-para').length === 1, '光标所在段要加 caret-para');
});

test('renderEditorMarks：超长正文整层收起 + 只提示一次；回到阈值内重新武装', () => {
  const longText = 'x'.repeat(editorLogic.MAX_MARK_CHARS + 1);
  const ctx = build({ text: longText, invisibles: true });
  ctx.ui.renderEditorMarks();
  const overlay = ctx.dom.map.get('editor-marks');
  assert.equal(overlay.classList.contains('hidden'), true);
  assert.equal(ctx.state.marks.marksTooLarge, true);
  assert.equal(ctx.state.marks.caretTooLarge, true);
  assert.equal(ctx.calls.toast.length, 1);
  assert.match(ctx.calls.toast[0][0], /正文超过 30 万字/);
  assert.equal(ctx.calls.toast[0][1], 'warn');
  // 再来一次不重复弹
  ctx.ui.renderEditorMarks();
  assert.equal(ctx.calls.toast.length, 1, '超长提示只弹一次');

  // 回到正常长度：tooLargeWarned 复位，下次再超长还能提示
  ctx.editorEl.value = '短正文';
  ctx.ui.renderEditorMarks();
  assert.equal(ctx.state.marks.tooLargeWarned, false);
});

test('renderEditorMarks：超长段落左侧黄线按实测行框建 bar，并记录 baseScrollTop', () => {
  const dom = makeDocument();
  const longPara = 'a'.repeat(600);
  const ctx = build({ dom, text: `${longPara}\n短段`, longParagraphs: true });
  ctx.editorEl.scrollTop = 20;
  const gutter = dom.map.get('editor-marks-gutter');
  gutter.parentElement = makeEl('div');
  gutter.parentElement._top = 0;
  ctx.editorEl._top = 0;
  // 让标记层查询 .long-para 时拿到带两段行框的假节点（真实 DOM 里由布局给出）
  const overlay = dom.map.get('editor-marks');
  const originalQuery = overlay.querySelectorAll.bind(overlay);
  overlay.querySelectorAll = (selector) => (
    selector === '.long-para'
      ? [{ getClientRects: () => [{ top: 40, height: 20, width: 500 }, { top: 60, height: 20, width: 500 }] }]
      : originalQuery(selector)
  );
  ctx.ui.renderEditorMarks();
  overlay.querySelectorAll = originalQuery;
  assert.ok(gutter.children.length >= 2, '每个非零行框一条黄线');
  assert.equal(gutter.classList.contains('hidden'), false);
  assert.equal(ctx.state.marks.barBaseScrollTop, 20);
  assert.equal(gutter.children[0].className, 'long-para-bar');
  assert.ok(Number.isFinite(Number(gutter.children[0].dataset.baseTop)));
  assert.ok(Number.isFinite(Number(gutter.children[0].style.height.replace('px', ''))));
});

test('hideEditorMarks：清两层 DOM 与 state.marks 统计，并收起状态栏超长提示', () => {
  const ctx = build({ invisibles: true, text: '　x' });
  ctx.ui.renderEditorMarks();
  const overlay = ctx.dom.map.get('editor-marks');
  assert.equal(overlay.classList.contains('hidden'), false);
  ctx.state.marks.longItems = [{ line: 1 }];
  ctx.state.marks.longCount = 1;
  ctx.ui.hideEditorMarks();
  assert.equal(overlay.classList.contains('hidden'), true);
  assert.equal(overlay.textContent, '');
  assert.deepEqual(ctx.state.marks.longItems, []);
  assert.equal(ctx.state.marks.longCount, 0);
  assert.deepEqual(ctx.state.marks.markCounts, { fullwidth: 0, trailing: 0 });
  assert.equal(ctx.state.marks.caretLine, 0);
  assert.equal(ctx.dom.map.get('editor-marks-gutter').classList.contains('hidden'), true);
  assert.equal(ctx.dom.map.get('status-long-para').classList.contains('hidden'), true);
});

test('scheduleMarksRender：防抖只留最后一个；到点整层重画并在有查找命中时同步高亮层', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = build({ invisibles: true, findTotal: 3 });
  ctx.ui.scheduleMarksRender();
  const first = ctx.state.marks.timer;
  ctx.ui.scheduleMarksRender(0);
  assert.notEqual(ctx.state.marks.timer, first, '新一次排期清掉旧的');
  t.mock.timers.tick(0);
  assert.equal(ctx.state.marks.timer, null);
  assert.equal(ctx.dom.map.get('editor-marks').classList.contains('hidden'), false, '到点重画标记层');
  assert.equal(ctx.calls.renderFindHighlights, 1, '有查找命中时同步查找高亮层');
});

test('scheduleMarksRender：没有查找命中时不动查找高亮层', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = build({ invisibles: true, findTotal: 0 });
  ctx.ui.scheduleMarksRender(0);
  t.mock.timers.tick(0);
  assert.equal(ctx.calls.renderFindHighlights, 0);
});

// ---------- 光标段落更新 ----------
test('updateCaretParagraph：层隐藏 / 开关关 / 视图不对 / 拼字中 / 换了行 五种早退都保持原状', () => {
  const ctx = build({ caretParagraph: true, selectionStart: 0, text: 'aaa\nbbb' });
  ctx.ui.renderEditorMarks();
  const overlay = ctx.dom.map.get('editor-marks');
  // 开关关
  ctx.state.marks.caretParagraph = false;
  ctx.ui.updateCaretParagraph();
  assert.equal(overlay.querySelectorAll('.caret-para').length, 1);
  ctx.state.marks.caretParagraph = true;
  // 视图不对
  ctx.state.view = 'shelf';
  ctx.ui.updateCaretParagraph();
  assert.equal(overlay.querySelectorAll('.caret-para').length, 1);
  ctx.state.view = 'editor';
  // 拼字中
  ctx.state.marks.composing = true;
  ctx.ui.updateCaretParagraph();
  assert.equal(overlay.querySelectorAll('.caret-para').length, 1);
  ctx.state.marks.composing = false;
  // 同一行不动
  ctx.ui.updateCaretParagraph();
  assert.equal(overlay.querySelectorAll('.caret-para').length, 1);
});

test('updateCaretParagraph：换到有 span 的行改 class；换到干净行整层重建补 span', () => {
  const ctx = build({ caretParagraph: true, selectionStart: 0, text: 'aaa\nbbb\nccc' });
  ctx.state.marks.invisibles = true;
  ctx.ui.renderEditorMarks();
  const overlay = ctx.dom.map.get('editor-marks');
  // 移到第 2 行（有 span）：旧 class 摘掉、新行加上
  ctx.editorEl.selectionStart = 5;
  ctx.ui.updateCaretParagraph();
  const caret = overlay.querySelector('.caret-para');
  assert.ok(caret, '第 2 行应高亮');
  assert.equal(caret.dataset.line, '2', 'caret.line 是 1 基行号（与 marksPlan 的 dataset 口径一致）');
  assert.equal(overlay.querySelectorAll('.caret-para').length, 1, '旧高亮必须摘掉');
});

// ---------- 段落导航 ----------
test('jumpToNextLongParagraph：开关关 / 没有超长段返回 false；有则移动光标 + 滚动 + 刷新选中字数', () => {
  const ctx = build({ longParagraphs: false });
  assert.equal(ctx.ui.jumpToNextLongParagraph(), false);
  ctx.state.marks.longParagraphs = true;
  ctx.state.marks.longItems = [];
  assert.equal(ctx.ui.jumpToNextLongParagraph(), false);

  ctx.state.marks.longItems = [{ line: 1, chars: 600, start: 10, end: 610 }];
  ctx.editorEl.value = 'x'.repeat(1000);
  assert.equal(ctx.ui.jumpToNextLongParagraph(), true);
  assert.equal(ctx.editorEl._focusCount, 1);
  assert.equal(ctx.editorEl.selectionStart, 10);
  assert.deepEqual(ctx.calls.scrollCaretIntoView, [10]);
  assert.equal(ctx.calls.renderSelectionStats, 1);
  assert.equal(ctx.calls.syncFindOverlayScroll, 0);
});

test('jumpParagraph：视图 / 书 / 下标不对返回 false；能跳则移动光标并刷新', () => {
  assert.equal(build({ view: 'shelf' }).ui.jumpParagraph(1), false);
  assert.equal(build({ bookPath: null }).ui.jumpParagraph(1), false);
  assert.equal(build({ index: -1 }).ui.jumpParagraph(1), false);

  const ctx = build({ text: '第一段\n\n第二段' });
  ctx.editorEl.selectionStart = 0;
  assert.equal(ctx.ui.jumpParagraph(1), true);
  assert.ok(ctx.editorEl.selectionStart > 0);
  assert.equal(ctx.editorEl._focusCount, 1);
  assert.equal(ctx.calls.renderSelectionStats, 1);
  assert.equal(ctx.calls.scrollCaretIntoView.length, 1);
});

// ---------- 菜单 / 开关 / 色板 ----------
test('renderMarksMenu：三个开关的文案 / data-on / title 逐字钉住，并刷新色板', () => {
  const ctx = build({ invisibles: true, longParagraphs: false, caretParagraph: true });
  ctx.ui.renderMarksMenu();
  const invisibles = ctx.dom.map.get('format-invisibles');
  const long = ctx.dom.map.get('format-long-para');
  const caret = ctx.dom.map.get('format-caret-para');
  assert.equal(invisibles.textContent, '✓ 显示不可见字符（␣ / 行尾空白）');
  assert.equal(invisibles.dataset.on, '1');
  assert.match(invisibles.title, /全角空格标成 ␣/);
  assert.equal(long.textContent, `超长段落提示（>${editorLogic.LONG_PARAGRAPH_DEFAULT} 字左侧黄线）`);
  assert.equal(long.dataset.on, '0');
  assert.match(long.title, /左侧画一条淡黄竖线/);
  assert.equal(caret.textContent, '✓ 当前段落高亮（光标所在段）');
  assert.equal(caret.dataset.on, '1');
});

test('renderCaretColorRow：色板 data-active / aria-pressed / --swatch；取色器空值退回第一个预设色', () => {
  const dom = makeDocument();
  const ctx = build({ dom, caretColor: '#c0392b' });
  const row = dom.map.get('format-caret-colors');
  const preset = caretColorLib.PRESET_VALUES[0];
  const swatch1 = makeEl('button');
  swatch1.dataset.caretColor = '#c0392b';
  const swatch2 = makeEl('button');
  swatch2.dataset.caretColor = preset;
  row.append(swatch1, swatch2);
  ctx.ui.renderCaretColorRow();
  assert.equal(swatch1.dataset.active, '1');
  assert.equal(swatch1.getAttribute('aria-pressed'), 'true');
  assert.equal(swatch2.dataset.active, '0');
  assert.equal(swatch2.getAttribute('aria-pressed'), 'false');
  assert.equal(swatch1.style._props['--swatch'], '#c0392b');
  assert.equal(dom.map.get('format-caret-color').value, '#c0392b');

  // 跟随主题（空串）：色板全不 active，取色器给第一个预设色
  const follow = build({ dom: makeDocument(), caretColor: '' });
  const row2 = follow.dom.map.get('format-caret-colors');
  const sw = makeEl('button');
  sw.dataset.caretColor = preset;
  row2.appendChild(sw);
  follow.ui.renderCaretColorRow();
  assert.equal(sw.dataset.active, '0');
  assert.equal(follow.dom.map.get('format-caret-color').value, preset);
});

test('setMarksToggle / toggleMarks：非法名返回 false；合法名写 state、刷新菜单与标记层、返回新值', () => {
  const ctx = build({ invisibles: false });
  assert.equal(ctx.ui.setMarksToggle('nope', true), false);
  assert.equal(ctx.ui.setMarksToggle('invisibles', true), true);
  assert.equal(ctx.state.marks.invisibles, true);
  assert.equal(ctx.dom.map.get('format-invisibles').dataset.on, '1');
  assert.equal(ctx.ui.toggleMarks('invisibles'), false);
  assert.equal(ctx.state.marks.invisibles, false);
  assert.equal(ctx.dom.map.get('format-invisibles').dataset.on, '0');
});

test('toggleMarks：两个编辑器小件开关按书记忆（写 bookDisplay 补丁），caretParagraph 不在这里写盘', () => {
  const ctx = build();
  // setMarksToggle 只改内存：测试钩子 / 恢复快照用它，一个字节都不写
  ctx.ui.setMarksToggle('invisibles', true);
  ctx.ui.setMarksToggle('longParagraphs', true);
  ctx.ui.setMarksToggle('invisibles', false);
  ctx.ui.setMarksToggle('longParagraphs', false);
  assert.deepEqual(ctx.calls.persistMarks, [], 'setMarksToggle 不写盘');

  // 从菜单点开关（toggleMarks）才写：开记 true，关记 false（不是删键）
  assert.equal(ctx.ui.toggleMarks('invisibles'), true);
  assert.deepEqual(ctx.calls.persistMarks, [{ marksInvisibles: true }]);
  assert.equal(ctx.ui.toggleMarks('longParagraphs'), true);
  assert.deepEqual(ctx.calls.persistMarks, [{ marksInvisibles: true }, { marksLongParagraphs: true }]);
  assert.equal(ctx.ui.toggleMarks('invisibles'), false);
  assert.deepEqual(ctx.calls.persistMarks[2], { marksInvisibles: false }, '关掉后记 false');

  // 当前段落高亮有自己的写盘入口（renderer.js 的 setCaretParagraphPersisted），这里不重复写
  assert.equal(ctx.ui.toggleMarks('caretParagraph'), true);
  assert.equal(ctx.calls.persistMarks.length, 3, 'caretParagraph 不在这里写盘');
  // 非法名字：state 不动，也不写盘
  assert.equal(ctx.ui.toggleMarks('nope'), false);
  assert.equal(ctx.calls.persistMarks.length, 3);
  assert.deepEqual(ctx.calls.toast, [], '写盘成功不弹提示');
});

test('toggleMarks：写盘失败（同步抛 / Promise 拒绝）只 toast，不回滚内存态', async () => {
  const thrown = build({ invisibles: false, persistMarks: 'throw' });
  assert.equal(thrown.ui.toggleMarks('invisibles'), true);
  assert.equal(thrown.state.marks.invisibles, true, '内存态仍按新状态显示');
  assert.deepEqual(thrown.calls.persistMarks, [{ marksInvisibles: true }]);
  assert.equal(thrown.calls.toast.length, 1);
  assert.deepEqual(thrown.calls.toast[0], [
    '保存「显示不可见字符」开关失败：磁盘满了（本次仍按新状态显示，下次打开这本书回到上次保存的值）',
    'error'
  ]);

  const rejected = build({ longParagraphs: false, persistMarks: 'reject' });
  assert.equal(rejected.ui.toggleMarks('longParagraphs'), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rejected.calls.toast.length, 1);
  assert.match(
    rejected.calls.toast[0][0],
    /^保存「超长段落提示」开关失败：磁盘满了（本次仍按新状态显示，下次打开这本书回到上次保存的值）$/
  );
  assert.equal(rejected.calls.toast[0][1], 'error');
  assert.equal(rejected.state.marks.longParagraphs, true);
});

// ---------- 对齐 / 滚动 / 监听 ----------
test('syncEditorOverlay：hidden 层返回 null；可见时按编辑区实测值同步位置 / 宽高 / 字体 / 滚动', () => {
  const ctx = build();
  const overlay = ctx.dom.map.get('editor-marks');
  assert.equal(ctx.ui.syncEditorOverlay(overlay), null, 'hidden 层不同步');
  overlay.classList.remove('hidden');
  ctx.editorEl.clientWidth = 700;
  ctx.editorEl.clientHeight = 500;
  ctx.editorEl.offsetLeft = 30;
  ctx.editorEl.offsetTop = 40;
  ctx.editorEl.scrollTop = 12;
  ctx.editorEl.scrollLeft = 3;
  const result = ctx.ui.syncEditorOverlay(overlay);
  assert.deepEqual(result, { width: 700 - 112, height: 500 - 20, padding: { top: 10, bottom: 10, left: 56, right: 56 } });
  assert.equal(overlay.style.left, `${30 + 56}px`);
  assert.equal(overlay.style.top, `${40 + 10}px`);
  assert.equal(overlay.style.width, '588px');
  assert.equal(overlay.style.height, '480px');
  assert.equal(overlay.style.fontSize, '18px');
  assert.equal(overlay.style.lineHeight, '1.95');
  assert.equal(overlay.scrollTop, 12);
  assert.equal(overlay.scrollLeft, 3);
});

test('syncMarksScroll：hidden 层不动作；可见时同步滚动位置并重排黄线 top', () => {
  const ctx = build();
  const overlay = ctx.dom.map.get('editor-marks');
  const gutter = ctx.dom.map.get('editor-marks-gutter');
  ctx.ui.syncMarksScroll(); // hidden：直接 return
  overlay.classList.remove('hidden');
  gutter.classList.remove('hidden');
  const bar = makeEl('div');
  bar.dataset.baseTop = '100';
  gutter.appendChild(bar);
  ctx.state.marks.barBaseScrollTop = 20;
  ctx.editorEl.scrollTop = 50;
  ctx.editorEl.scrollLeft = 5;
  ctx.ui.syncMarksScroll();
  assert.equal(overlay.scrollTop, 50);
  assert.equal(overlay.scrollLeft, 5);
  assert.equal(bar.style.top, `${100 - 30}px`);
});

test('setupEditorMarks：6 处编辑区监听 + document selectionchange + ResizeObserver + 状态栏按钮，行为逐条钉住', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const observed = [];
  globalThis.ResizeObserver = class FakeResizeObserver {
    constructor(cb) { this.cb = cb; observed.push(this); this.disconnected = false; }
    observe(el) { this.el = el; }
    disconnect() { this.disconnected = true; }
  };
  const ctx = build({ invisibles: true, focusOn: true, typewriter: true });
  ctx.ui.setupEditorMarks();
  const types = ctx.editorEl._listeners.map((l) => l.type);
  assert.deepEqual(types, ['scroll', 'compositionstart', 'compositionend', 'keyup', 'mouseup', 'select']);
  assert.deepEqual(ctx.editorEl._listeners[0].options, { passive: true });
  assert.equal(observed.length, 1, '建了一个 ResizeObserver');
  assert.equal(observed[0].el, ctx.editorEl);
  assert.equal(ctx.state.marks.resizeObserver, observed[0]);
  assert.equal(ctx.dom.map.get('status-long-para')._listeners.length, 1);

  // scroll → 同步两层滚动
  ctx.dom.map.get('editor-marks').classList.remove('hidden');
  ctx.editorEl.scrollTop = 9;
  ctx.editorEl._fire('scroll');
  assert.equal(ctx.dom.map.get('editor-marks').scrollTop, 9);
  assert.ok(ctx.calls.syncFindOverlayScroll >= 1);

  // composition：拼字中不重画，结束排一次整层重画
  ctx.editorEl._fire('compositionstart');
  assert.equal(ctx.state.marks.composing, true);
  ctx.editorEl._fire('compositionend');
  assert.equal(ctx.state.marks.composing, false);
  assert.notEqual(ctx.state.marks.timer, null);
  stopMarks(ctx);

  // keyup：刷新选中字数 + 光标段落 + 两层滚动；专注打字机模式下把光标行拉回 1/3
  ctx.calls.renderSelectionStats = 0;
  ctx.editorEl._fire('keyup');
  assert.equal(ctx.calls.renderSelectionStats, 1);
  assert.deepEqual(ctx.calls.scheduleTypewriterAlign, [20]);
  assert.ok(ctx.calls.syncFindOverlayScroll >= 2);

  // 非专注模式下不排打字机对齐
  ctx.state.focus.on = false;
  ctx.editorEl._fire('mouseup');
  assert.deepEqual(ctx.calls.scheduleTypewriterAlign, [20]);

  // ResizeObserver 回调 → 排一次 40ms 重画
  observed[0].cb();
  stopMarks(ctx);
});

test('setupEditorMarks：运行环境没有 ResizeObserver 时静默跳过（不崩）', () => {
  delete globalThis.ResizeObserver;
  const ctx = build();
  ctx.ui.setupEditorMarks();
  assert.equal(ctx.state.marks.resizeObserver, null);
});

// ---------- 静态闸门 ----------
test('静态闸门：renderer.js 不再内嵌编辑器小件实现，只剩装配与转发', () => {
  for (const shape of [
    'function marksEnabled(',
    'function scheduleMarksRender(',
    'function hideEditorMarks(',
    'function syncEditorOverlay(',
    'function renderEditorMarks(',
    'function updateCaretParagraph(',
    'function renderCaretColorRow(',
    'function renderMarksMenu(',
    'function setMarksToggle(',
    'function toggleMarks(',
    'function setupEditorMarks('
  ]) {
    assert.equal(rendererSrc.includes(shape), false, 'renderer.js 里还有第二份：' + shape);
  }
  assert.equal(rendererSrc.split('editorMarksUiModule.create(').length - 1, 1, '装配只许一处');
  assert.ok(rendererSrc.includes('const editorMarksUiModule = window.CWEditorMarksUi;'));
  // 1.1.0：两个开关按书记忆——host 写盘回调 + 打开书 / 恢复默认时套用生效值
  assert.ok(
    rendererSrc.includes('    persistMarks: (patch) => persistMarksToggle(patch),'),
    '装配少了按书写盘回调 persistMarks'
  );
  assert.ok(rendererSrc.includes('function persistMarksToggle('), '写盘回调实现不见了');
  assert.ok(rendererSrc.includes('function syncMarksTogglesFromConfig('), '按书生效值同步不见了');
  assert.ok(rendererSrc.includes('syncMarksTogglesFromConfig();'), '打开书 / 恢复默认时没套用生效值');
  for (const line of [
    '    $, state, toast,',
    '    editor: { editorEl, editorLogic, LONG_PARAGRAPH_THRESHOLD, caretColorLib, caretColorValue },',
    '    find: { renderFindHighlights: () => renderFindHighlights(), syncFindOverlayScroll: () => syncFindOverlayScroll() },',
    '    focus: { focusActive: () => focusActive(), scheduleTypewriterAlign: (delay) => scheduleTypewriterAlign(delay) },',
    '    stats: { renderSelectionStats, formatCount },',
    '    scroll: { scrollCaretIntoView }'
  ]) {
    assert.ok(rendererSrc.includes(line), '装配少了：' + line);
  }
  assert.ok(rendererSrc.includes(
    'const { scheduleMarksRender, hideEditorMarks, syncEditorOverlay, renderEditorMarks, renderMarksMenu, syncMarksScroll, updateCaretParagraph, jumpToNextLongParagraph, jumpParagraph, renderCaretColorRow, setMarksToggle, toggleMarks, setupEditorMarks } = editorMarksUi;'
  ), '13 个入口按原名解构');
  // 域内绑定本来就随 setupEditorMarks 搬：renderer 只留一次调用
  assert.equal(rendererSrc.split('setupEditorMarks();').length - 1, 1, 'setupEditorMarks 只调一次');
  // 测试钩子宿主契约的 7 个键仍在
  for (const key of ['syncMarksScroll', 'updateCaretParagraph', 'jumpToNextLongParagraph', 'jumpParagraph', 'renderCaretColorRow', 'setMarksToggle', 'toggleMarks']) {
    assert.match(rendererSrc, new RegExp('^      ' + key + ',$', 'm'), 'testHooksScope 少了 ' + key);
  }
  // 别的域按名字取的入口仍在 renderer 里按名转发（视图切换 / 专注 / 阅读 / 设置 / 查找 / 整理）
  assert.ok(rendererSrc.includes('hideEditorMarks();'), '视图切换里仍按名字调 hideEditorMarks');
  assert.ok(rendererSrc.includes('renderEditorMarks();'), '当前段落高亮 / 设置里仍按名字调 renderEditorMarks');
  assert.ok(rendererSrc.includes('renderMarksMenu();'), '当前段落高亮 / 整理卡里仍按名字调 renderMarksMenu');
});

test('静态闸门：index.html 在 renderer.js 之前加载 editor-marks-ui.js，且只加载一次', () => {
  const at = indexSrc.indexOf('<script src="editor-marks-ui.js"></script>');
  const rendererAt = indexSrc.indexOf('<script src="renderer.js"></script>');
  assert.notEqual(at, -1);
  assert.ok(at < rendererAt);
  assert.equal(indexSrc.split('editor-marks-ui.js').length - 1, 1);
});

test('静态闸门：模块不 require / 不摸 Electron·fs·网络；事件与定时器位置可控', () => {
  for (const forbidden of ['require(', 'ipcRenderer', 'node:fs', 'child_process', 'localStorage', 'fetch(', 'window.', 'process.']) {
    assert.equal(moduleCode.includes(forbidden), false, 'editor-marks-ui.js 不许出现 ' + forbidden);
  }
  // 唯一的全局监听是 document selectionchange（只服务光标段落高亮），且只在 setupEditorMarks 里注册
  const setupStart = moduleCode.indexOf('function setupEditorMarks()');
  assert.ok(setupStart > 0);
  const before = moduleCode.slice(0, setupStart);
  assert.equal(before.includes('addEventListener'), false, 'setup 之外不许注册事件（marksPlan 只建节点）');
  assert.equal((moduleCode.match(/document\.addEventListener/g) || []).length, 1, '只许一个 document 级监听（selectionchange）');
  assert.equal((moduleCode.match(/setTimeout\(/g) || []).length, 1, '只有一个 setTimeout（标记层防抖）');
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWEditorMarksUi，且不乱造别的全局', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(moduleSrc, context, { filename: 'renderer/editor-marks-ui.js' });
  assert.equal(typeof win.CWEditorMarksUi, 'object');
  assert.deepEqual(Object.keys(win.CWEditorMarksUi).sort(), ['REQUIRED_HOST', 'create']);
  assert.equal(win.CWEditorMarksUi.REQUIRED_HOST.length, 9);
  assert.equal(typeof win.CWEditorMarksUi.create, 'function');
  assert.equal(win.CWReadingUi, undefined);
  assert.equal(win.CWChapters, undefined);
});
