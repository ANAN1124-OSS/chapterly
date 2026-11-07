const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const focusModeUi = require('../renderer/focus-mode-ui');
const focusLogic = require('../renderer/focus-logic');

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
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

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

test('create() 只建表：不碰 DOM / 不注册事件 / 不建定时器，交出 11 个入口', () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  assert.equal(dom.lookups, 0);
  assert.deepEqual(Object.keys(ctx.ui).sort(), [
    'alignTypewriter', 'ensureFocusMirror', 'focusActive', 'measureCaretTop', 'restoreFocusScroll',
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
    'const { focusActive, updateFocusBar, ensureFocusMirror, measureCaretTop, alignTypewriter, scheduleTypewriterAlign, restoreFocusScroll, setFocusMode, toggleFocusMode, setFocusTypewriter, setupFocusModeUi } = focusModeUi;'
  ), '11 个入口按原名解构');
  for (const id of ['btn-focus', 'btn-focus-exit', 'btn-focus-typewriter']) {
    assert.equal(rendererSrc.includes(`$('${id}').addEventListener`), false, '绑定应该只在模块里：' + id);
  }
  assert.equal(rendererSrc.split('focusModeUi.setupFocusModeUi();').length - 1, 1, 'setup 只调一次');
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

test('静态闸门：index.html 在 renderer.js 之前加载 focus-mode-ui.js，且只加载一次', () => {
  const at = indexSrc.indexOf('<script src="focus-mode-ui.js"></script>');
  const rendererAt = indexSrc.indexOf('<script src="renderer.js"></script>');
  assert.notEqual(at, -1);
  assert.ok(at < rendererAt);
  assert.equal(indexSrc.split('focus-mode-ui.js').length - 1, 1);
});

test('静态闸门：模块不 require / 不摸 Electron·fs / 不注册全局监听；只用 1 个对齐定时器', () => {
  for (const forbidden of ['require(', 'ipcRenderer', 'node:fs', 'child_process', 'localStorage', 'fetch(', 'window.', 'process.']) {
    assert.equal(moduleCode.includes(forbidden), false, 'focus-mode-ui.js 不许出现 ' + forbidden);
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
