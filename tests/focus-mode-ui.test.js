const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const focusModeUi = require('../renderer/focus-mode-ui');
const focusLogic = require('../renderer/focus-logic');
// T8（三审·低）：UMD 分支闸门只留 tests/assert-host.test.js 一处；这里只用共用的「剥掉 Node 分支」helper。
const { stripAssertHostBranch } = require('./ui-test-preambles');

// 第 4 步 renderer 九刀·补刀 12：专注模式（原 renderer.js 1285–1454，170 行）搬到 renderer/focus-mode-ui.js。
// 搬之前只有 E2E 黑盒覆盖（F11 / 顶栏进出、退出后视口还原、打字机模式）；打字机测量层 / 死区判定 /
// 光标行还原 / 进入前的滚动与光标快照 / 菜单收起在 Node 里都测不到。搬出来以后逐条钉住。
//
// 契约：host 5 个成员 = $, state + focus{focusLogic,editorEl} + marks{scheduleMarksRender,syncMarksScroll} +
// menus{hideContextMenu,hideHeaderMenus,hideVolumeMenu}。

const realDocument = globalThis.document;
const realGetComputedStyle = globalThis.getComputedStyle;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
test.after(() => {
  if (realDocument === undefined) delete globalThis.document;
  else globalThis.document = realDocument;
  if (realGetComputedStyle === undefined) delete globalThis.getComputedStyle;
  else globalThis.getComputedStyle = realGetComputedStyle;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
});

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const moduleSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'focus-mode-ui.js'), 'utf8');
const moduleCode = moduleSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------- 假 DOM ----------
function makeEl(tag = 'div', id = '') {
  const classes = new Set();
  const listeners = [];
  const el = {
    tagName: tag, id, className: '', textContent: '', title: '', dataset: {}, children: [], parentNode: null,
    style: {}, scrollTop: 0, scrollLeft: 0, scrollHeight: 2000, clientHeight: 600, clientWidth: 800,
    selectionStart: 0, selectionEnd: 0, offsetTop: 0, _classes: classes, _listeners: listeners, _attrs: {},
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
    appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    setAttribute(k, v) { el._attrs[k] = v; },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el._attrs, k) ? el._attrs[k] : null; },
    focus() { el._focus = (el._focus || 0) + 1; },
    setSelectionRange(start, end) { el.selectionStart = start; el.selectionEnd = end; el._sel = [start, end]; },
    _fire(type, event) {
      let result;
      for (const l of listeners) if (l.type === type) result = l.fn(event);
      return result;
    }
  };
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
  const body = makeEl('body');
  const editorMain = makeEl('div');
  editorMain.className = 'editor-main';
  const doc = {
    body,
    createElement: (tag) => {
      const el = makeEl(tag);
      if (tag === 'span') el.offsetTop = 123; // 模拟光标标记的行位置
      return el;
    },
    querySelector(selector) { return selector === '.editor-main' ? editorMain : null; },
    getElementById: (id) => { lookups += 1; return map.get(id) || null; }
  };
  return {
    doc, map, body, editorMain,
    get lookups() { return lookups; },
    $: (id) => doc.getElementById(id),
    ensure(id) { if (!map.has(id)) map.set(id, makeEl('div', id)); return map.get(id); }
  };
}

const BASE_IDS = ['editor-view', 'focus-bar', 'focus-chapter', 'chapter-title', 'btn-focus-typewriter', 'btn-focus', 'btn-focus-exit'];

function build(options = {}) {
  const dom = options.dom || makeDocument();
  for (const id of BASE_IDS) dom.ensure(id);
  dom.map.get('focus-chapter');
  globalThis.document = dom.doc;
  globalThis.getComputedStyle = options.computedStyle || (() => ({
    paddingLeft: '10px', paddingRight: '10px', paddingTop: '20px',
    fontFamily: 'serif', fontSize: '18px', fontWeight: '400', fontStyle: 'normal', lineHeight: '1.9', letterSpacing: '0.5px'
  }));
  const state = {
    view: options.view === undefined ? 'editor' : options.view,
    bookPath: options.bookPath === undefined ? '/书库/书甲' : options.bookPath,
    focus: {
      on: Boolean(options.focusOn),
      typewriter: Boolean(options.typewriter),
      timer: null,
      savedScrollTop: 0,
      savedCaret: 0,
      savedCaretOffset: null
    }
  };
  const editorEl = makeEl('textarea');
  editorEl.value = options.text === undefined ? '第一行\n第二行\n第三行' : options.text;
  editorEl.scrollTop = options.scrollTop === undefined ? 100 : options.scrollTop;
  editorEl.selectionStart = options.caret === undefined ? 2 : options.caret;
  editorEl.selectionEnd = editorEl.selectionStart;
  editorEl.clientWidth = options.clientWidth === undefined ? 800 : options.clientWidth;
  editorEl.clientHeight = options.clientHeight === undefined ? 600 : options.clientHeight;
  const calls = { scheduleMarksRender: [], syncMarksScroll: 0, hideContextMenu: 0, hideHeaderMenus: 0, hideVolumeMenu: 0 };
  const host = {
    $: dom.$,
    state,
    focus: { focusLogic, editorEl },
    marks: {
      scheduleMarksRender(delay) { calls.scheduleMarksRender.push(delay); },
      syncMarksScroll() { calls.syncMarksScroll += 1; }
    },
    menus: {
      hideContextMenu() { calls.hideContextMenu += 1; },
      hideHeaderMenus() { calls.hideHeaderMenus += 1; },
      hideVolumeMenu() { calls.hideVolumeMenu += 1; }
    }
  };
  const ui = focusModeUi.create(host);
  return { ui, host, state, dom, calls, editorEl };
}

// ---------- host 契约 ----------
test('host 契约：5 个成员 + 分组内每个真实依赖；缺任何一个都抛 TypeError', () => {
  assert.deepEqual([...focusModeUi.REQUIRED_HOST].sort(), ['$', 'focus', 'marks', 'menus', 'state']);
  assert.equal(focusModeUi.REQUIRED_HOST.length, 5);
  const ctx = build();
  assert.doesNotThrow(() => focusModeUi.create(ctx.host));
  assert.throws(() => focusModeUi.create(null), /createFocusModeUi 需要 host 对象/);
  for (const key of focusModeUi.REQUIRED_HOST) {
    const broken = { ...ctx.host };
    delete broken[key];
    assert.throws(() => focusModeUi.create(broken), new RegExp('host 缺少 ' + key.replace('$', '\\$')), '缺 ' + key);
  }
  for (const key of ['focusLogic', 'editorEl']) {
    const broken = { ...ctx.host, focus: { ...ctx.host.focus } };
    delete broken.focus[key];
    assert.throws(() => focusModeUi.create(broken), new RegExp('host\\.focus 缺少 ' + key));
  }
  for (const key of ['scheduleMarksRender', 'syncMarksScroll']) {
    const broken = { ...ctx.host, marks: { ...ctx.host.marks } };
    delete broken.marks[key];
    assert.throws(() => focusModeUi.create(broken), new RegExp('host\\.marks 缺少 ' + key));
  }
  for (const key of ['hideContextMenu', 'hideHeaderMenus', 'hideVolumeMenu']) {
    const broken = { ...ctx.host, menus: { ...ctx.host.menus } };
    delete broken.menus[key];
    assert.throws(() => focusModeUi.create(broken), new RegExp('host\\.menus 缺少 ' + key));
  }
});

test('create() 只建表：不碰 DOM / 不注册事件 / 不建定时器，交出 12 个入口', () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  assert.equal(dom.lookups, 0);
  assert.deepEqual(Object.keys(ctx.ui).sort(), [
    'alignTypewriter', 'ensureFocusMirror', 'focusActive', 'measureCaretTop',
    'resetCaretMeasureCache', 'restoreFocusScroll',
    'scheduleTypewriterAlign', 'setFocusMode', 'setFocusTypewriter', 'setupFocusModeUi',
    'toggleFocusMode', 'updateFocusBar'
  ]);
});

// ---------- 基础状态 / 退出条 ----------
test('focusActive：要同时「开着 + 写作页 + 有书」', () => {
  assert.equal(build({ focusOn: true }).ui.focusActive(), true);
  assert.equal(build({ focusOn: false }).ui.focusActive(), false);
  assert.equal(build({ focusOn: true, view: 'shelf' }).ui.focusActive(), false);
  assert.equal(build({ focusOn: true, bookPath: null }).ui.focusActive(), false);
});

test('updateFocusBar：退出条显隐 / 章名回填 / 打字机开关文案与 dataset / title', () => {
  const ctx = build({ focusOn: true });
  ctx.dom.map.get('chapter-title').textContent = '第一章 开端';
  ctx.ui.updateFocusBar();
  assert.equal(ctx.dom.map.get('focus-bar').classList.contains('hidden'), false);
  assert.equal(ctx.dom.map.get('focus-chapter').textContent, '第一章 开端');
  assert.equal(ctx.dom.map.get('btn-focus-typewriter').textContent, '打字机');
  assert.equal(ctx.dom.map.get('btn-focus-typewriter').dataset.on, '0');
  assert.match(ctx.dom.map.get('btn-focus-typewriter').title, /^打字机模式：/);

  ctx.state.focus.typewriter = true;
  ctx.ui.updateFocusBar();
  assert.equal(ctx.dom.map.get('btn-focus-typewriter').textContent, '✓ 打字机');
  assert.equal(ctx.dom.map.get('btn-focus-typewriter').dataset.on, '1');
  assert.match(ctx.dom.map.get('btn-focus-typewriter').title, /^打字机模式已开：/);

  ctx.state.focus.on = false;
  ctx.ui.updateFocusBar();
  assert.equal(ctx.dom.map.get('focus-bar').classList.contains('hidden'), true);
  assert.equal(ctx.dom.map.get('focus-chapter').textContent, '');
});

// ---------- 打字机测量层 ----------
test('ensureFocusMirror：第一次建在 .editor-main 里并标 aria-hidden；第二次复用同一个节点', () => {
  const ctx = build();
  const mirror = ctx.ui.ensureFocusMirror();
  assert.equal(mirror.id, 'focus-mirror');
  assert.equal(mirror.className, 'focus-mirror');
  assert.equal(mirror.getAttribute('aria-hidden'), 'true');
  assert.equal(ctx.dom.editorMain.children.includes(mirror), true, '优先挂在 .editor-main');
  ctx.dom.map.set('focus-mirror', mirror); // 真实 DOM 里 getElementById 能找到刚建的节点
  assert.equal(ctx.ui.ensureFocusMirror(), mirror);
  assert.equal(ctx.dom.editorMain.children.length, 1);
});

test('measureCaretTop：超长正文 / 量不到宽度 → null；正常时返回含 padding 的光标行顶端', () => {
  const tooLong = build({ text: 'x'.repeat(focusLogic.MAX_TYPEWRITER_CHARS + 1) });
  assert.equal(tooLong.ui.measureCaretTop(0), null);

  const noWidth = build({ clientWidth: 15 });
  assert.equal(noWidth.ui.measureCaretTop(0), null, '去掉左右 padding 后宽度为 0');

  const ctx = build();
  ctx.editorEl.selectionStart = 4;
  const top = ctx.ui.measureCaretTop(4);
  assert.equal(top, 143); // paddingTop 20 + marker.offsetTop 123 - mirror.offsetTop 0
  const mirror = ctx.dom.editorMain.children[0];
  assert.equal(mirror.style.width, '780px');
  assert.equal(mirror.style.fontSize, '18px');
  assert.equal(mirror.textContent, '', '量完要清空测量层');
});

test('measureCaretTop（C24）：长段落软换行按视觉行数测行顶，不是按换行符个数', () => {
  // 400 个「a」、0 个换行：宽 780px、每行约 40 字 → 视觉第 10 行。
  // 旧口径（\n 数 × 行高）会算成第 0 行；镜像测量必须量到第 10 行。
  const ctx = build({ text: 'a'.repeat(400) });
  const mirror = makeEl('div', 'focus-mirror');
  let mirrorText = '';
  Object.defineProperty(mirror, 'textContent', {
    get() { return mirrorText; },
    set(value) { mirrorText = String(value); mirror.children.length = 0; }
  });
  Object.defineProperty(mirror, 'offsetTop', { get: () => 0 });
  ctx.dom.map.set('focus-mirror', mirror);
  ctx.dom.doc.createElement = (tag) => {
    const el = makeEl(tag);
    if (tag === 'span') {
      // 光标标记的纵坐标 = 光标前正文的视觉行数 × 行高（每行 40 字、行高 32px）
      Object.defineProperty(el, 'offsetTop', {
        get() {
          const text = el.parentNode === mirror ? mirrorText : '';
          return Math.ceil(text.length / 40) * 32;
        }
      });
    }
    return el;
  };
  assert.equal(ctx.ui.measureCaretTop(400), 20 + 10 * 32, '400 字 / 每行 40 字 = 视觉第 10 行（换行数还是 0）');
  assert.equal(ctx.ui.measureCaretTop(80), 20 + 2 * 32, '第 2 个视觉行');
});

test('alignTypewriter：未专注 / 没开打字机 → false；死区内不动；需要时滚到计划位置并同步标记层', () => {
  assert.equal(build({ focusOn: false, typewriter: true }).ui.alignTypewriter(), false);
  assert.equal(build({ focusOn: true, typewriter: false }).ui.alignTypewriter(), false);

  // 光标行 143、视口 600 → 目标 scrollTop = 0；当前正好 0 → 在死区内不调整
  const dead = build({ focusOn: true, typewriter: true, scrollTop: 0 });
  assert.equal(dead.ui.alignTypewriter(), false);
  assert.equal(dead.editorEl.scrollTop, 0);
  assert.equal(dead.calls.syncMarksScroll, 0);

  // 当前滚到 400 → 需要滚回 0
  const ctx = build({ focusOn: true, typewriter: true, scrollTop: 400 });
  assert.equal(ctx.ui.alignTypewriter(), true);
  assert.equal(ctx.editorEl.scrollTop, 0);
  assert.equal(ctx.calls.syncMarksScroll, 1);

  // 正文长度上限：量不到光标行 → false
  const tooLong = build({ focusOn: true, typewriter: true, text: 'x'.repeat(focusLogic.MAX_TYPEWRITER_CHARS + 1) });
  assert.equal(tooLong.ui.alignTypewriter(), false);
});

test('scheduleTypewriterAlign：再次调度清掉旧定时器，延时到点才对齐', async () => {
  const ctx = build({ focusOn: true, typewriter: true, scrollTop: 0 });
  ctx.ui.scheduleTypewriterAlign(5);
  const firstTimer = ctx.state.focus.timer;
  ctx.ui.scheduleTypewriterAlign(60);
  assert.notEqual(ctx.state.focus.timer, firstTimer, '旧定时器被清掉换成新的');
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(ctx.state.focus.timer, null);
});

// ---------- 进入 / 退出 ----------
test('setFocusMode(进入)：快照滚动与光标位置、收起三个菜单、加 class、刷退出条与标记层', () => {
  const ctx = build({ focusOn: false, scrollTop: 120, caret: 7 });
  const on = ctx.ui.setFocusMode(true);
  assert.equal(on, true);
  assert.equal(ctx.state.focus.on, true);
  assert.equal(ctx.state.focus.savedScrollTop, 120);
  assert.equal(ctx.state.focus.savedCaret, 7);
  assert.equal(ctx.state.focus.savedCaretOffset, 143 - 120, '记住光标行相对视口的位置');
  assert.equal(ctx.calls.hideContextMenu, 1);
  assert.equal(ctx.calls.hideHeaderMenus, 1);
  assert.equal(ctx.calls.hideVolumeMenu, 1);
  assert.equal(ctx.dom.map.get('editor-view').classList.contains('focus-mode'), true);
  assert.equal(ctx.dom.body.classList.contains('focus-mode'), true);
  assert.deepEqual(ctx.calls.scheduleMarksRender, [0]);
  assert.deepEqual(ctx.editorEl._sel, [7, 7]);
});

test('setFocusMode：书架 / 没书不许进；已开时只刷退出条；关闭时清定时器 / 去掉 class / 还原视口', () => {
  assert.equal(build({ view: 'shelf' }).ui.setFocusMode(true), false);
  assert.equal(build({ bookPath: null }).ui.setFocusMode(true), false);

  const already = build({ focusOn: true });
  assert.equal(already.ui.setFocusMode(true), true);
  assert.equal(already.calls.hideContextMenu, 0);

  const ctx = build({ focusOn: true, scrollTop: 30, caret: 5 });
  ctx.state.focus.savedScrollTop = 30;
  ctx.state.focus.savedCaret = 5;
  ctx.state.focus.timer = setTimeout(() => {}, 1000);
  const off = ctx.ui.setFocusMode(false);
  assert.equal(off, false);
  assert.equal(ctx.state.focus.on, false);
  assert.equal(ctx.state.focus.timer, null);
  assert.equal(ctx.dom.map.get('editor-view').classList.contains('focus-mode'), false);
  assert.equal(ctx.dom.body.classList.contains('focus-mode'), false);
  assert.deepEqual(ctx.calls.scheduleMarksRender, [0]);
  // 还原：没有 savedCaretOffset 时用 savedScrollTop
  assert.equal(ctx.editorEl.scrollTop, 30);
  assert.equal(ctx.calls.syncMarksScroll, 1);

  const noRestore = build({ focusOn: true });
  noRestore.editorEl.scrollTop = 999;
  noRestore.ui.setFocusMode(false, { restore: false });
  assert.equal(noRestore.editorEl.scrollTop, 999, 'restore=false 不动视口');
});

test('restoreFocusScroll：非写作页 / 没书返回 false；有光标行偏移时按「顶端 - 偏移」还回屏幕高度', () => {
  const shelf = build({ view: 'shelf', focusOn: true });
  assert.equal(shelf.ui.restoreFocusScroll(), false);
  const noBook = build({ focusOn: true, bookPath: null });
  assert.equal(noBook.ui.restoreFocusScroll(), false);

  const ctx = build({ focusOn: true, scrollTop: 0, caret: 4 });
  ctx.state.focus.savedScrollTop = 50;
  ctx.state.focus.savedCaret = 4;
  ctx.state.focus.savedCaretOffset = 100; // 光标行 143 - 100 = 43
  assert.equal(ctx.ui.restoreFocusScroll(), true);
  assert.equal(ctx.editorEl.scrollTop, 43);
  assert.equal(ctx.calls.syncMarksScroll, 1);
});

test('toggleFocusMode / setFocusTypewriter：来回切换与开关打字机', () => {
  const ctx = build({ focusOn: false });
  assert.equal(ctx.ui.toggleFocusMode(), true);
  assert.equal(ctx.state.focus.on, true);
  assert.equal(ctx.ui.toggleFocusMode(), false);

  const tw = build({ focusOn: true });
  assert.equal(tw.ui.setFocusTypewriter(true), true);
  assert.equal(tw.state.focus.typewriter, true);
  assert.equal(tw.dom.map.get('btn-focus-typewriter').dataset.on, '1');
  assert.equal(tw.ui.setFocusTypewriter(0), false);
});

// ---------- 事件绑定 ----------
test('setupFocusModeUi：顶栏「专注」切换、退出条「退出专注」、打字机开关三个绑定', () => {
  const ctx = build();
  ctx.ui.setupFocusModeUi();
  for (const id of ['btn-focus', 'btn-focus-exit', 'btn-focus-typewriter']) {
    assert.equal(ctx.dom.map.get(id)._listeners.length, 1, id);
  }
  ctx.dom.map.get('btn-focus')._fire('click');
  assert.equal(ctx.state.focus.on, true);
  ctx.dom.map.get('btn-focus-typewriter')._fire('click');
  assert.equal(ctx.state.focus.typewriter, true);
  ctx.dom.map.get('btn-focus-exit')._fire('click');
  assert.equal(ctx.state.focus.on, false);
});

// ---------- 静态闸门 ----------
test('静态闸门：renderer.js 不再内嵌专注模式实现，只剩装配与转发', () => {
  for (const shape of [
    'function focusActive(',
    'function updateFocusBar(',
    'function ensureFocusMirror(',
    'function measureCaretTop(',
    'function alignTypewriter(',
    'function scheduleTypewriterAlign(',
    'function restoreFocusScroll(',
    'function setFocusMode(',
    'function toggleFocusMode(',
    'function setFocusTypewriter('
  ]) {
    assert.equal(rendererSrc.includes(shape), false, 'renderer.js 里还有第二份：' + shape);
  }
  assert.equal(rendererSrc.split('focusModeUiModule.create(').length - 1, 1, '装配只许一处');
  assert.ok(rendererSrc.includes('const focusModeUiModule = window.CWFocusModeUi;'));
  for (const line of [
    '    $, state,',
    '    focus: { focusLogic, editorEl },',
    '    marks: { scheduleMarksRender, syncMarksScroll },',
    '    menus: { hideContextMenu, hideHeaderMenus, hideVolumeMenu }'
  ]) {
    assert.ok(rendererSrc.includes(line), '装配少了：' + line);
  }
  assert.ok(rendererSrc.includes(
    'const { focusActive, updateFocusBar, measureCaretTop, alignTypewriter, scheduleTypewriterAlign, resetCaretMeasureCache, setFocusMode, toggleFocusMode, setFocusTypewriter, setupFocusModeUi } = focusModeUi;'
  ), '10 个入口按原名解构（ensureFocusMirror / restoreFocusScroll 只在模块内部用）');
  for (const id of ['btn-focus', 'btn-focus-exit', 'btn-focus-typewriter']) {
    assert.equal(rendererSrc.includes(`$('${id}').addEventListener`), false, '绑定应该只在模块里：' + id);
  }
  assert.equal(rendererSrc.split('setupFocusModeUi();').length - 1, 1, 'setup 只调一次');
  // F11 / Esc / 视图切换 / 编辑区事件仍按名字取
  assert.match(rendererSrc, /event\.key === 'F11'/);
  assert.match(rendererSrc, /'exit-focus': \(\) => setFocusMode\(false\),/);
  assert.match(rendererSrc, /setFocusMode\(false, \{ restore: false \}\)/);
  assert.match(rendererSrc, /if \(focusActive\(\) && state\.focus\.typewriter\) scheduleTypewriterAlign\(30\);/);
  // 编辑器小件装配里的 focus 两成员改惰性转发（专注模块在编辑器小件之后装配）
  assert.ok(rendererSrc.includes(
    '    focus: { focusActive: () => focusActive(), scheduleTypewriterAlign: (delay) => scheduleTypewriterAlign(delay) },'
  ), 'editorMarks 装配应改为惰性转发');
  for (const key of ['focusActive', 'measureCaretTop', 'setFocusMode', 'setFocusTypewriter']) {
    assert.match(rendererSrc, new RegExp('^      ' + key + ',$', 'm'), 'testHooksScope 少了 ' + key);
  }
});

test('静态闸门：scrollCaretIntoView 复用专注模式镜像实测行顶（C24，不许退回按换行数估算）', () => {
  const at = rendererSrc.indexOf('function scrollCaretIntoView(');
  assert.notEqual(at, -1, 'renderer.js 里应有 scrollCaretIntoView');
  const end = rendererSrc.indexOf('\n  }', at);
  assert.ok(end > at, '找得到函数结尾');
  const body = rendererSrc.slice(at, end);
  assert.ok(body.includes('focusModeUi.measureCaretTop(pos)'), '光标行必须用镜像实测（与打字机同一套测量）');
  assert.ok(body.includes('measured == null'), '「\\n 数 × 行高」只能是量不出来时的兜底');
  assert.ok(
    body.indexOf('measureCaretTop') < body.indexOf('match(/\\n/g)'),
    '先实测、兜底在后（不能先按换行数算再覆盖）'
  );
  assert.ok(body.includes('focusLogic.planCaretReveal('), '滚动计划走 focus-logic 的共享纯逻辑');
});

test('静态闸门：index.html 在 renderer.js 之前加载 focus-mode-ui.js，且只加载一次', () => {
  const at = indexSrc.indexOf('<script src="focus-mode-ui.js"></script>');
  const rendererAt = indexSrc.indexOf('<script src="renderer.js"></script>');
  assert.notEqual(at, -1);
  assert.ok(at < rendererAt);
  assert.equal(indexSrc.split('focus-mode-ui.js').length - 1, 1);
});

test('静态闸门：模块不 require / 不摸 Electron·fs / 不注册全局监听；只用 1 个对齐定时器', () => {
  // A8（WP-32）：唯一允许的 require 是 UMD 的 Node 分支取 core/assert-host.js（浏览器走 window.CWAssertHost）；
  // 运行时代码仍不许 require 任何东西。
  // T8（三审·低）：UMD 分支闸门只留 tests/assert-host.test.js 一处（那里逐个模块核对 require / 全局名 / 工厂签名）。
  const runtimeCode = stripAssertHostBranch(moduleCode);
  for (const forbidden of ['require(', 'ipcRenderer', 'node:fs', 'child_process', 'localStorage', 'fetch(', 'window.', 'process.']) {
    assert.equal(runtimeCode.includes(forbidden), false, 'focus-mode-ui.js 不许出现 ' + forbidden);
  }
  assert.equal(/window\.addEventListener|document\.addEventListener/.test(moduleCode), false);
  assert.equal((moduleCode.match(/setTimeout\(/g) || []).length, 1);
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWFocusModeUi，且不乱造别的全局', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(moduleSrc, context, { filename: 'renderer/focus-mode-ui.js' });
  assert.equal(typeof win.CWFocusModeUi, 'object');
  assert.deepEqual(Object.keys(win.CWFocusModeUi).sort(), ['REQUIRED_HOST', 'create']);
  assert.equal(win.CWFocusModeUi.REQUIRED_HOST.length, 5);
  assert.equal(win.CWWriteTimerUi, undefined);
});

// ---------- B15（v1.8.0 WP-29）：打字机光标测量按段落增量 ----------
// 假 mirror：offsetTop 按「每个硬段落从行首重新排版」计算（每行 40 字、行高 32px），
// 用来验证「全文测量」与「段内相对测量」结果等价。
function makeWrappedMeasurement(text) {
  const visualOffset = (value) => {
    let lines = 0;
    for (const line of String(value).split('\n')) lines += Math.max(1, Math.ceil(line.length / 40));
    return (lines - 1) * 32;
  };
  const ctx = build({ text });
  const mirror = makeEl('div', 'focus-mirror');
  let mirrorText = '';
  const writes = [];
  Object.defineProperty(mirror, 'textContent', {
    get() { return mirrorText; },
    set(value) { mirrorText = String(value); writes.push(mirrorText); mirror.children.length = 0; }
  });
  Object.defineProperty(mirror, 'offsetTop', { get: () => 0 });
  ctx.dom.map.set('focus-mirror', mirror);
  ctx.dom.doc.createElement = (tag) => {
    const el = makeEl(tag);
    if (tag === 'span') {
      Object.defineProperty(el, 'offsetTop', {
        get() {
          return el.parentNode === mirror ? visualOffset(mirrorText) : 0;
        }
      });
    }
    return el;
  };
  return { ctx, writes, visualOffset };
}

test('B15：同一段落内移动只量段内相对位置（不再把整章前缀塞进 mirror），结果与全文测量一致', () => {
  const text = '甲'.repeat(70) + '\n' + '乙'.repeat(400);
  const paragraphStart = 71;
  const buildWrapped = () => makeWrappedMeasurement(text);

  const first = buildWrapped();
  const visualOffset = first.visualOffset;
  const p1 = paragraphStart + 200;
  const p2 = paragraphStart + 320;
  const topAtP1 = first.ctx.ui.measureCaretTop(p1);
  assert.equal(first.writes.length, 4, '第一次（全文测量 + 段内基准）各写一次内容、量完各清空一次');
  assert.equal(first.writes[0].length, p1, '第一次是全章前缀');
  assert.equal(first.writes[2].length, p1 - paragraphStart, '同时量一次段内基准供后续增量用');
  const writesBefore = first.writes.length;
  const topAtP2 = first.ctx.ui.measureCaretTop(p2);
  assert.equal(first.writes.length, writesBefore + 2, '同段落内移动只写一次内容（+ 一次量完清空）');
  assert.equal(first.writes[first.writes.length - 2].length, p2 - paragraphStart, '只量本段从段首到光标（长度远小于全章前缀）');

  // 与「直接全文测量」的结果逐像素一致
  const reference = buildWrapped();
  assert.equal(topAtP2, reference.ctx.ui.measureCaretTop(p2));
  assert.equal(topAtP2, 20 + visualOffset(text.slice(0, p2)));
  // 同一位置重复问 → 直接命中缓存，不再写 mirror
  const againBefore = first.writes.length;
  assert.equal(first.ctx.ui.measureCaretTop(p2), topAtP2);
  assert.equal(first.writes.length, againBefore, '同一位置不再重排');
  assert.equal(topAtP1, 20 + visualOffset(text.slice(0, p1)));

  // 正文在段后追加（段首前缀没变）：仍走增量，但结果必须与全文测量一致。
  // 注意 build() 会把全局 document 换成新 ctx 的假 DOM，这里先切回 first 的 document 再量。
  globalThis.document = first.ctx.dom.doc;
  first.ctx.editorEl.value = text + '\n' + '丙'.repeat(80);
  const changed = first.ctx.ui.measureCaretTop(p2);
  assert.equal(
    changed,
    20 + visualOffset(first.ctx.editorEl.value.slice(0, p2)),
    '段后追加不改变光标行，增量结果与全文测量一致'
  );
});

// RPAN-B02（第五轮审计）：旧缓存键要求「全文严格相等」，连续输入时每敲一个字就失效 ——
// 增量优化声称的主场景（打字）永不命中，每次还全文重排 + 多量一次段内基准。现在键改成
// 「段首前缀 + 版式」：同一段内输入/移动都走增量；前缀一变就退回全文测量。
test('RPAN-B02：连续输入（同一段内每敲一个字）也走增量快路径，不再每次全文重排', () => {
  const base = '甲'.repeat(70) + '\n' + '乙'.repeat(400);
  const paragraphStart = 71;
  const unit = makeWrappedMeasurement(base);
  const ctx = unit.ctx;
  const pos = paragraphStart + 200;
  unit.ctx.ui.measureCaretTop(pos);
  const before = unit.writes.length;
  // 打字：在光标处插入一个字（同段、段首前缀不变），光标随之后移
  const typed = base.slice(0, pos) + '丙' + base.slice(pos);
  ctx.editorEl.value = typed;
  globalThis.document = ctx.dom.doc;
  const top = ctx.ui.measureCaretTop(pos + 1);
  assert.equal(unit.writes.length, before + 2, '连续输入只写一次内容（+ 一次量完清空），不许全文重排');
  assert.equal(
    unit.writes[unit.writes.length - 2].length,
    pos + 1 - paragraphStart,
    '只量本段从段首到光标（远小于全章前缀）'
  );
  // 与独立全文测量逐像素一致
  const reference = makeWrappedMeasurement(typed);
  assert.equal(top, reference.ctx.ui.measureCaretTop(pos + 1));
  // 段首之前的正文变了（前缀失效）→ 必须重新全文测量
  globalThis.document = ctx.dom.doc;
  ctx.editorEl.value = '丁'.repeat(70) + '\n' + typed.slice(paragraphStart);
  const beforeFull = unit.writes.length;
  ctx.ui.measureCaretTop(pos + 1);
  assert.equal(unit.writes.length, beforeFull + 4, '前缀变了：全文测量 + 段内基准各写一次');
  assert.equal(unit.writes[beforeFull].length, pos + 1, '第一次写的是整段前缀（全文测量）');
});

test('B15：显示设置（字体 / 字号 / 行距）应用后作废段内基准，下一次重新全文测量', () => {
  assert.match(moduleSrc, /function resetCaretMeasureCache\(\) \{/);
  const styleStart = rendererSrc.indexOf('function applyEditorStyle(override) {');
  assert.ok(styleStart > 0);
  const styleBody = rendererSrc.slice(styleStart, rendererSrc.indexOf('\n  }', styleStart));
  assert.ok(styleBody.indexOf('resetCaretMeasureCache()') < styleBody.indexOf('scheduleMarksRender(30)'), '先作废基准再排标记层重绘');
  // 模块导出 + 渲染层解构都接上（不是只定义不调用的死函数）
  assert.match(rendererSrc, /const \{ focusActive,[^}]*resetCaretMeasureCache[^}]*\} = focusModeUi;/);
});
