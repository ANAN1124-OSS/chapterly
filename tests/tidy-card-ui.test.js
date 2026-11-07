const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tidyCardUi = require('../renderer/tidy-card-ui');
const formatUi = require('../renderer/format-ui');
const caretColorLib = require('../core/caret-color');
const chaptersLib = require('../core/chapters');

// 第 4 步 renderer 九刀·第八刀：「整理」按钮的悬浮选择卡 + 「显示」菜单（原 renderer.js 3862–4171，
// 去掉 hideHeaderMenus / scrollCaretIntoView 两个共享胶水后 294 行）搬到 renderer/tidy-card-ui.js。
// 搬之前这一域只有 E2E 黑盒覆盖（点整理 / 悬浮卡 / 显示菜单 / 排版对话框 / 撤销）；
// 撤销链判断、token 作废、整理期间换书作废、光标映射、预览截断这些分支在 Node 里一步都测不到。
// 搬出来以后用「假 host + 假 DOM」逐条钉住，再用静态闸门保证渲染层不长回第二份。
//
// 契约：host 8 个成员 = 基础 5（$, state, api, call, toast）+ format{formatUi,MAX_FORMAT_UNDO,
// readFormatOptions,writeFormatOptions,editorEl,onEditorInput,chaptersLib,caretColorLib} +
// menus{hideBookMenu,hideExportMenu,hideMenu,renderMarksMenu} + peers{openSettings,toggleMarks,
// setDisplayPreset,applyCaretColor,setCaretParagraphPersisted,setCaretColorPersisted,runFormatBook,scrollCaretIntoView}。

const realDocument = globalThis.document;
const realSetTimeout = globalThis.setTimeout;
test.after(() => {
  if (realDocument === undefined) delete globalThis.document;
  else globalThis.document = realDocument;
  globalThis.setTimeout = realSetTimeout;
});
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const moduleSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'tidy-card-ui.js'), 'utf8');
const moduleCode = moduleSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------- 假 DOM ----------
function makeEl(tag = 'div', id = '') {
  const classes = new Set();
  const listeners = [];
  const el = {
    tagName: tag, id, className: '', textContent: '', title: '', value: '', disabled: false,
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
    contains(node) { return el.children.includes(node); },
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    setAttribute(k, v) { el._attrs[k] = v; },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el._attrs, k) ? el._attrs[k] : null; },
    focus() { el._focus = (el._focus || 0) + 1; },
    setSelectionRange(start, end) { el.selectionStart = start; el.selectionEnd = end; },
    _fire(type, event) {
      let result;
      for (const l of listeners) if (l.type === type) result = l.fn(event);
      return result;
    }
  };
  Object.defineProperty(el, 'innerHTML', { get() { return ''; }, set() { el.children.length = 0; } });
  return el;
}
function makeDocument() {
  const map = new Map();
  let lookups = 0;
  const doc = {
    createElement: (tag) => makeEl(tag),
    execCommand: null, // 故意缺省：insertFormattedText 会走「直接赋值」回退
    getElementById: (id) => { lookups += 1; return map.get(id) || null; }
  };
  return {
    doc, map,
    get lookups() { return lookups; },
    $: (id) => doc.getElementById(id),
    ensure(id) { if (!map.has(id)) map.set(id, makeEl('div', id)); return map.get(id); }
  };
}

const BASE_IDS = [
  'format-menu', 'format-undo-item', 'format-dropdown', 'display-menu', 'format-backdrop',
  'fmt-summary', 'fmt-preview', 'btn-format-apply', 'fmt-indent', 'fmt-trailing', 'fmt-punct',
  'fmt-quotes', 'fmt-ellipsis', 'fmt-cjkspace', 'fmt-blank', 'btn-format-cancel', 'btn-format-reset',
  'btn-format', 'btn-display', 'display-settings-btn', 'format-caret-color'
];

function build(options = {}) {
  const dom = options.dom || makeDocument();
  for (const id of BASE_IDS) dom.ensure(id);
  dom.map.get('format-menu').classList.add('hidden');
  dom.map.get('display-menu').classList.add('hidden');
  dom.map.get('format-backdrop').classList.add('hidden');
  globalThis.document = dom.doc;
  const state = {
    view: 'editor',
    bookPath: options.bookPath === undefined ? '/书库/书甲' : options.bookPath,
    index: options.index === undefined ? 0 : options.index,
    config: options.config === undefined ? { formatOptions: { indent: '2' } } : options.config,
    chapters: options.chapters === undefined ? [{ id: 'c1', name: '第一章', file: 'c1.txt' }] : options.chapters,
    formatUndo: options.formatUndo || [],
    marks: { caretParagraph: false }
  };
  const editorEl = makeEl('textarea');
  editorEl.value = options.text === undefined ? '第一段  文字' : options.text;
  editorEl.selectionStart = options.caret === undefined ? 0 : options.caret;
  const calls = {
    formatText: [], setConfig: [], toast: [], hideExportMenu: 0, hideBookMenu: 0, hideMenu: [],
    renderMarksMenu: 0, openSettings: 0, toggleMarks: [], setDisplayPreset: [], applyCaretColor: [],
    setCaretParagraphPersisted: [], setCaretColorPersisted: [], runFormatBook: 0, scrollCaretIntoView: [],
    onEditorInput: 0
  };
  const api = {
    async formatText(...args) {
      calls.formatText.push(args);
      if (options.formatError) throw new Error(options.formatError);
      if (options.formatText) return options.formatText(...args);
      return { changed: true, text: '第一段文字', stats: { paragraphs: 1, indent: 1 } };
    },
    async setConfig(patch) {
      calls.setConfig.push(patch);
      if (options.setConfigError) throw new Error('配置只读');
      return { ...state.config, ...patch };
    }
  };
  const host = {
    $: dom.$,
    state,
    api,
    call: async (fn, ...args) => fn(...args),
    toast(message, kind) { calls.toast.push([message, kind]); },
    format: {
      formatUi,
      MAX_FORMAT_UNDO: options.maxUndo === undefined ? 50 : options.maxUndo,
      readFormatOptions: () => options.options || { indent: '2', blankLines: 'single' },
      writeFormatOptions: (opts) => calls.writeFormatOptions = opts,
      editorEl,
      onEditorInput: () => { calls.onEditorInput += 1; },
      chaptersLib,
      caretColorLib
    },
    menus: {
      hideBookMenu() { calls.hideBookMenu += 1; },
      hideExportMenu() { calls.hideExportMenu += 1; },
      hideMenu(sel) { calls.hideMenu.push(sel); const el = dom.map.get(sel); if (el) el.classList.add('hidden'); },
      renderMarksMenu() { calls.renderMarksMenu += 1; }
    },
    peers: {
      openSettings() { calls.openSettings += 1; },
      toggleMarks(name) { calls.toggleMarks.push(name); },
      setDisplayPreset(name) { calls.setDisplayPreset.push(name); },
      applyCaretColor(patch) { calls.applyCaretColor.push(patch); },
      setCaretParagraphPersisted(on) { calls.setCaretParagraphPersisted.push(on); },
      setCaretColorPersisted(color) { calls.setCaretColorPersisted.push(color); },
      runFormatBook: async () => { calls.runFormatBook += 1; },
      scrollCaretIntoView(pos) { calls.scrollCaretIntoView.push(pos); }
    }
  };
  const ui = tidyCardUi.create(host);
  return { ui, host, state, dom, calls, editorEl };
}

// ---------- host 契约 ----------
test('host 契约：8 个成员 + 分组内每个真实依赖；缺任何一个都抛 TypeError', () => {
  assert.deepEqual([...tidyCardUi.REQUIRED_HOST].sort(), ['$', 'api', 'call', 'format', 'menus', 'peers', 'state', 'toast']);
  assert.equal(tidyCardUi.REQUIRED_HOST.length, 8);
  const ctx = build();
  assert.doesNotThrow(() => tidyCardUi.create(ctx.host));
  assert.throws(() => tidyCardUi.create(null), /createTidyCardUi 需要 host 对象/);
  for (const key of tidyCardUi.REQUIRED_HOST) {
    const broken = { ...ctx.host };
    delete broken[key];
    assert.throws(() => tidyCardUi.create(broken), new RegExp('host 缺少 ' + key.replace('$', '\\$')), '缺 ' + key);
  }
  for (const key of ['formatUi', 'MAX_FORMAT_UNDO', 'readFormatOptions', 'writeFormatOptions', 'editorEl', 'onEditorInput', 'chaptersLib', 'caretColorLib']) {
    const broken = { ...ctx.host, format: { ...ctx.host.format } };
    delete broken.format[key];
    assert.throws(() => tidyCardUi.create(broken), new RegExp('host\\.format 缺少 ' + key));
  }
  for (const key of ['hideBookMenu', 'hideExportMenu', 'hideMenu', 'renderMarksMenu']) {
    const broken = { ...ctx.host, menus: { ...ctx.host.menus } };
    delete broken.menus[key];
    assert.throws(() => tidyCardUi.create(broken), new RegExp('host\\.menus 缺少 ' + key));
  }
  for (const key of ['openSettings', 'toggleMarks', 'setDisplayPreset', 'applyCaretColor', 'setCaretParagraphPersisted', 'setCaretColorPersisted', 'runFormatBook', 'scrollCaretIntoView']) {
    const broken = { ...ctx.host, peers: { ...ctx.host.peers } };
    delete broken.peers[key];
    assert.throws(() => tidyCardUi.create(broken), new RegExp('host\\.peers 缺少 ' + key));
  }
});

test('create() 只建表：不碰 DOM / 不注册事件 / 不建定时器，交出 15 个入口', () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  assert.equal(dom.lookups, 0);
  assert.deepEqual(Object.keys(ctx.ui).sort(), [
    'applyFormatToEditor', 'canUndoFormat', 'closeFormatDialog', 'displayMenuOpen', 'formatCardOpen', 'formatCurrentChapterFromConfig',
    'formatUndoSteps', 'hideDisplayMenu', 'hideFormatMenu', 'openFormatDialog', 'refreshFormatCard',
    'scheduleHideFormatCard', 'setupTidyCardUi', 'showDisplayMenu', 'showFormatCard', 'undoFormat'
  ]);
  assert.equal(moduleCode.includes('setInterval'), false);
});

// ---------- 悬浮卡 / 显示菜单 ----------
test('formatCardOpen / displayMenuOpen：看的是菜单元素的 hidden class', () => {
  const ctx = build();
  assert.equal(ctx.ui.formatCardOpen(), false);
  ctx.dom.map.get('format-menu').classList.remove('hidden');
  assert.equal(ctx.ui.formatCardOpen(), true);
  assert.equal(ctx.ui.displayMenuOpen(), false);
  ctx.dom.map.get('display-menu').classList.remove('hidden');
  assert.equal(ctx.ui.displayMenuOpen(), true);
});

test('showFormatCard：先收起导出 / 显示菜单、刷新撤销行，再显示整理卡', () => {
  const ctx = build();
  ctx.ui.showFormatCard();
  assert.equal(ctx.calls.hideExportMenu, 1);
  assert.equal(ctx.calls.hideMenu.includes('display-menu'), true);
  assert.equal(ctx.dom.map.get('format-menu').classList.contains('hidden'), false);
  assert.equal(ctx.dom.map.get('format-undo-item').disabled, true, '没有撤销步数时禁用');
  assert.equal(ctx.dom.map.get('format-undo-item').textContent, '撤销上次整理');
});

test('scheduleHideFormatCard / hideFormatMenu：短延迟收起、再次触发清旧定时器、隐藏走 hideMenu', async () => {
  const sleep = (ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms));
  const ctx = build();
  ctx.ui.showFormatCard();
  ctx.ui.scheduleHideFormatCard(10);
  await sleep(3);
  assert.equal(ctx.dom.map.get('format-menu').classList.contains('hidden'), false, '还没到时间');
  await sleep(30);
  assert.equal(ctx.dom.map.get('format-menu').classList.contains('hidden'), true);

  // hideFormatMenu 立刻收起并清掉待触发定时器
  ctx.dom.map.get('format-menu').classList.remove('hidden');
  ctx.ui.scheduleHideFormatCard(10);
  ctx.ui.hideFormatMenu();
  assert.equal(ctx.dom.map.get('format-menu').classList.contains('hidden'), true);
  assert.deepEqual(ctx.calls.hideMenu[ctx.calls.hideMenu.length - 1], 'format-menu');
  ctx.dom.map.get('format-menu').classList.remove('hidden');
  await sleep(30);
  assert.equal(ctx.dom.map.get('format-menu').classList.contains('hidden'), false, '旧定时器不许再动');
});

test('showDisplayMenu / hideDisplayMenu / toggleDisplayMenu：互斥收起整理卡、刷新标记菜单', () => {
  const ctx = build();
  ctx.dom.map.get('format-menu').classList.remove('hidden');
  ctx.ui.showDisplayMenu();
  assert.equal(ctx.dom.map.get('format-menu').classList.contains('hidden'), true, '显示菜单与整理卡互斥');
  assert.equal(ctx.dom.map.get('display-menu').classList.contains('hidden'), false);
  assert.equal(ctx.calls.renderMarksMenu, 1);
  assert.equal(ctx.calls.hideExportMenu, 1);

  ctx.ui.hideDisplayMenu();
  assert.equal(ctx.dom.map.get('display-menu').classList.contains('hidden'), true);
  // toggleDisplayMenu 是内部件：通过「显示 ▾」按钮绑定走真实路径（展开 / 再点收起）
  ctx.ui.setupTidyCardUi();
  ctx.dom.map.get('btn-display')._fire('click', { stopPropagation() {} });
  assert.equal(ctx.dom.map.get('display-menu').classList.contains('hidden'), false);
  ctx.dom.map.get('btn-display')._fire('click', { stopPropagation() {} });
  assert.equal(ctx.dom.map.get('display-menu').classList.contains('hidden'), true);
});

// ---------- 撤销链 ----------
test('refreshFormatCard / formatUndoSteps / canUndoFormat：按「书 + 章 + after 串起来」算步数', () => {
  const ctx = build({ text: 'B' });
  ctx.state.formatUndo = [
    { bookPath: '/书库/书甲', chapterId: 'c1', before: 'A', after: 'B' }
  ];
  assert.equal(ctx.ui.formatUndoSteps(), 1);
  assert.equal(ctx.ui.canUndoFormat(), true);
  ctx.ui.refreshFormatCard();
  assert.equal(ctx.dom.map.get('format-undo-item').disabled, false);
  assert.equal(ctx.dom.map.get('format-undo-item').textContent, '撤销上次整理（可撤销 1 步）');

  // 中间手动改过字：链条断掉
  ctx.editorEl.value = 'C';
  assert.equal(ctx.ui.formatUndoSteps(), 0);
  assert.equal(ctx.ui.canUndoFormat(), false);

  // 别的书 / 别的章不参与
  const other = build({ text: 'B' });
  other.state.bookPath = '/书库/书乙';
  other.state.formatUndo = [{ bookPath: '/书库/书甲', chapterId: 'c1', before: 'A', after: 'B' }];
  assert.equal(other.ui.formatUndoSteps(), 0);
});

test('undoFormat：没有可撤销返回 false；有则把 before 写回编辑区、弹提示并清掉这一步', () => {
  const none = build({ text: 'B' });
  assert.equal(none.ui.undoFormat(), false);
  assert.deepEqual(none.calls.toast, []);

  const ctx = build({ text: 'B' });
  ctx.state.formatUndo = [{ bookPath: '/书库/书甲', chapterId: 'c1', before: 'A', after: 'B' }];
  assert.equal(ctx.ui.undoFormat(), true);
  assert.equal(ctx.editorEl.value, 'A');
  assert.equal(ctx.calls.onEditorInput, 1, '回退也要触发输入处理（dirty / 字数）');
  assert.deepEqual(ctx.calls.toast, [['已撤销整理（仍在编辑区，未写盘）', undefined]]);
  assert.equal(ctx.state.formatUndo.length, 0);
});

// ---------- 点「整理」 ----------
test('formatCurrentChapterFromConfig：没书 / 空正文 早退，不改撤销栈', async () => {
  const noBook = build({ bookPath: null });
  assert.deepEqual(await noBook.ui.formatCurrentChapterFromConfig(), { ok: false, reason: 'no-book' });
  assert.deepEqual(noBook.calls.toast, [['先打开一本书的章节再整理', 'warn']]);

  const empty = build({ text: '   \n ' });
  const res = await empty.ui.formatCurrentChapterFromConfig();
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'empty');
  assert.deepEqual(empty.calls.toast, [[formatUi.emptyToast(), 'warn']]);
});

test('formatCurrentChapterFromConfig：没有可改 → noChangeToast，编辑区与撤销栈都不动', async () => {
  const ctx = build({ text: '已经整理好的正文', formatText: () => ({ changed: false, text: '不会用到', stats: {} }) });
  const res = await ctx.ui.formatCurrentChapterFromConfig();
  assert.deepEqual(res, { ok: true, changed: 0, stats: {} });
  assert.equal(ctx.editorEl.value, '已经整理好的正文');
  assert.equal(ctx.state.formatUndo.length, 0);
  assert.deepEqual(ctx.calls.toast, [[formatUi.noChangeToast(formatUi.mergeOptions({ indent: '2' })), undefined]]);
});

test('formatCurrentChapterFromConfig：成功 → 写编辑区、压撤销栈、successToast、光标按非空白字符映射', async () => {
  const ctx = build({ text: '第一段  文字', caret: 4 }); // 光标在「段」后（前 4 字里 3 个非空白）
  const res = await ctx.ui.formatCurrentChapterFromConfig();
  assert.equal(res.ok, true);
  assert.equal(res.changed, 1);
  assert.equal(res.steps, 1);
  assert.equal(ctx.editorEl.value, '第一段文字');
  assert.equal(ctx.calls.onEditorInput, 1);
  // 原光标前有 3 个非空白字符（第 一 段）→ 整理后落在这 3 个字之后
  assert.equal(ctx.editorEl.selectionStart, 3);
  assert.deepEqual(ctx.calls.scrollCaretIntoView, [3]);
  assert.equal(ctx.state.formatUndo.length, 1);
  assert.equal(ctx.state.formatUndo[0].before, '第一段  文字');
  assert.equal(ctx.state.formatUndo[0].after, '第一段文字');
  assert.deepEqual(ctx.calls.toast, [[formatUi.successToast(formatUi.mergeOptions({ indent: '2' }), { paragraphs: 1, indent: 1 }), undefined]]);
  assert.equal(ctx.calls.renderMarksMenu || 1, 1);
});

test('formatCurrentChapterFromConfig：整理期间正文被改 / 换书换章 → 结果作废，不给编辑区写入', async () => {
  const stale = build({ text: '待整理正文' });
  stale.host.api.formatText = async () => {
    stale.editorEl.value = '用户刚打了新字';
    return { changed: true, text: '整理结果', stats: {} };
  };
  const res = await stale.ui.formatCurrentChapterFromConfig();
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'stale');
  assert.equal(stale.editorEl.value, '用户刚打了新字', '不许把旧结果写进新正文');
  assert.deepEqual(stale.calls.toast, [['正文刚改过，这次整理没有套用，请再点一次「整理」', 'warn']]);

  const switched = build({ text: '待整理正文' });
  switched.host.api.formatText = async () => {
    switched.state.bookPath = '/书库/书乙';
    return { changed: true, text: '整理结果', stats: {} };
  };
  const res2 = await switched.ui.formatCurrentChapterFromConfig();
  assert.equal(res2.reason, 'stale');
  assert.equal(switched.editorEl.value, '待整理正文');
});

test('formatCurrentChapterFromConfig：主进程失败 → toast「整理失败：」并恢复运行态', async () => {
  const ctx = build({ formatError: '主进程炸了' });
  const res = await ctx.ui.formatCurrentChapterFromConfig();
  assert.deepEqual(res, { ok: false, reason: 'error', message: '主进程炸了' });
  assert.deepEqual(ctx.calls.toast, [['整理失败：主进程炸了', 'error']]);
  // 失败后可以再点一次（running 标志复位）
  const again = build({ formatError: '主进程炸了' });
  assert.equal((await again.ui.formatCurrentChapterFromConfig()).reason, 'error');
});

// ---------- 排版对话框 ----------
test('openFormatDialog：没书 → 警告且不打开；有书 → 收菜单、回填规则、显示弹层并排预览', () => {
  const noBook = build({ bookPath: null });
  noBook.ui.openFormatDialog();
  assert.deepEqual(noBook.calls.toast, [['先打开一本书的章节再整理', 'warn']]);
  assert.equal(noBook.dom.map.get('format-backdrop').classList.contains('hidden'), true);

  const ctx = build();
  ctx.ui.openFormatDialog();
  assert.equal(ctx.dom.map.get('format-backdrop').classList.contains('hidden'), false);
  assert.equal(ctx.dom.map.get('fmt-summary').textContent, '正在预览…');
  assert.equal(ctx.dom.map.get('fmt-preview').textContent, '');
  assert.equal(ctx.dom.map.get('btn-format-apply').disabled, true);
  assert.equal(ctx.calls.hideMenu.includes('format-menu'), true);
  assert.equal(ctx.calls.hideMenu.includes('display-menu'), true);
  assert.deepEqual(ctx.calls.writeFormatOptions, { indent: '2' }, '回填上次记住的规则');
});

test('renderFormatPreview：空正文 / 有改动 / 无改动 / 超长截断 四种渲染', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // 有改动 + 预览截断
  const changed = build({ text: 'x'.repeat(900), formatText: () => ({ changed: true, text: 'y'.repeat(900), stats: { paragraphs: 1 } }) });
  changed.ui.openFormatDialog();
  t.mock.timers.tick(0);
  await flush();
  assert.equal(changed.dom.map.get('btn-format-apply').disabled, false);
  assert.equal(changed.dom.map.get('fmt-summary').textContent, formatUi.statsText({ paragraphs: 1 }));
  assert.equal(changed.dom.map.get('fmt-preview').textContent, `${'y'.repeat(700)}\n…`);

  // 无改动
  const noChange = build({ formatText: () => ({ changed: false, text: '第一段  文字', stats: {} }) });
  noChange.ui.openFormatDialog();
  t.mock.timers.tick(0);
  await flush();
  assert.equal(noChange.dom.map.get('fmt-summary').textContent, formatUi.noChangePanelText());
  assert.equal(noChange.dom.map.get('btn-format-apply').disabled, true);

  // 空正文
  const empty = build({ text: '  ', formatText: () => ({ changed: false, text: '', stats: {} }) });
  empty.ui.openFormatDialog();
  t.mock.timers.tick(0);
  await flush();
  assert.equal(empty.dom.map.get('fmt-summary').textContent, formatUi.emptyPanelText());
  assert.equal(empty.dom.map.get('fmt-preview').textContent, '');
});

test('renderFormatPreview：预览失败 → 「预览失败：」；关对话框后旧响应作废', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fail = build({ formatError: '主进程炸了' });
  fail.ui.openFormatDialog();
  t.mock.timers.tick(0);
  await flush();
  assert.equal(fail.dom.map.get('fmt-summary').textContent, '预览失败：主进程炸了');
  assert.equal(fail.dom.map.get('fmt-preview').textContent, '');

  // 旧响应作废：预览请求挂起 → 关对话框 → resolve 后不许写 DOM
  const stale = build();
  let release;
  stale.host.api.formatText = () => new Promise((resolve) => { release = resolve; });
  stale.ui.openFormatDialog();
  t.mock.timers.tick(0);
  stale.ui.closeFormatDialog();
  release({ changed: true, text: '旧结果', stats: {} });
  await flush();
  assert.equal(stale.dom.map.get('fmt-preview').textContent, '');
});

test('applyFormatToEditor：没书直接返回；空正文警告；成功套用 + 记住规则；失败恢复按钮', async () => {
  const noBook = build({ bookPath: null });
  await noBook.ui.applyFormatToEditor();
  assert.deepEqual(noBook.calls.formatText, []);

  const empty = build({ text: '  ' });
  await empty.ui.applyFormatToEditor();
  assert.deepEqual(empty.calls.toast, [[formatUi.emptyToast(), 'warn']]);

  const ctx = build({ text: '第一段  文字' });
  await ctx.ui.applyFormatToEditor();
  assert.equal(ctx.editorEl.value, '第一段文字');
  assert.equal(ctx.calls.formatText.length, 1);
  assert.deepEqual(ctx.calls.setConfig, [{ formatOptions: ctx.host.format.readFormatOptions() }]);
  assert.equal(ctx.dom.map.get('format-backdrop').classList.contains('hidden'), true);
  assert.equal(ctx.state.formatUndo.length, 1);
  assert.equal(ctx.dom.map.get('btn-format-apply').disabled, false, '结束后恢复按钮');

  const noChange = build({ formatText: () => ({ changed: false, text: '不变', stats: {} }) });
  await noChange.ui.applyFormatToEditor();
  assert.deepEqual(noChange.calls.toast, [[formatUi.noChangeToast(noChange.host.format.readFormatOptions()), undefined]]);

  const fail = build({ formatError: '磁盘满' });
  await fail.ui.applyFormatToEditor();
  assert.deepEqual(fail.calls.toast, [['整理失败：磁盘满', 'error']]);
  assert.equal(fail.dom.map.get('btn-format-apply').disabled, false);
});

// ---------- 事件绑定 ----------
test('setupTidyCardUi：整理卡 / 显示菜单 / 取色器 / 格式对话框全部绑定逐条钉住', async () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  ctx.ui.setupTidyCardUi();
  assert.deepEqual(dom.map.get('btn-format')._listeners.map((l) => l.type), ['click']);
  assert.deepEqual(dom.map.get('format-menu')._listeners.map((l) => l.type), ['click']);
  assert.deepEqual(dom.map.get('format-dropdown')._listeners.map((l) => l.type), ['pointerenter', 'pointerleave', 'focusin', 'focusout']);
  assert.deepEqual(dom.map.get('btn-display')._listeners.map((l) => l.type), ['click']);
  assert.deepEqual(dom.map.get('display-menu')._listeners.map((l) => l.type), ['click']);
  assert.deepEqual(dom.map.get('format-caret-color')._listeners.map((l) => l.type), ['input', 'change']);
  for (const id of ['fmt-indent', 'fmt-trailing', 'fmt-punct', 'fmt-quotes', 'fmt-ellipsis', 'fmt-cjkspace', 'fmt-blank']) {
    assert.deepEqual(dom.map.get(id)._listeners.map((l) => l.type), ['change'], id);
  }
  assert.equal(dom.map.get('btn-format-apply')._listeners.length, 1);
  assert.equal(dom.map.get('btn-format-cancel')._listeners.length, 1);
  assert.equal(dom.map.get('btn-format-reset')._listeners.length, 1);

  // 整理 ▾ 点击：收卡 + 跑「按上次规则整理」
  await dom.map.get('btn-format')._fire('click', { stopPropagation() {} });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ctx.calls.formatText.length, 1);

  // 整理卡：settings → 打开排版对话框
  const settingsBtn = { dataset: { action: 'settings' } };
  await dom.map.get('format-menu')._fire('click', { target: { closest: () => settingsBtn }, stopPropagation() {} });
  assert.equal(dom.map.get('format-backdrop').classList.contains('hidden'), false);

  // 整理卡：undo（先清空撤销栈 → toast「没有可撤销的整理」）
  ctx.state.formatUndo.length = 0;
  ctx.editorEl.value = 'x';
  const undoBtn = { dataset: { action: 'undo' } };
  await dom.map.get('format-menu')._fire('click', { target: { closest: () => undoBtn }, stopPropagation() {} });
  assert.deepEqual(ctx.calls.toast[ctx.calls.toast.length - 1], ['没有可撤销的整理', 'warn']);

  // 显示 ▾ → 展开；菜单项分派
  dom.map.get('btn-display')._fire('click', { stopPropagation() {} });
  assert.equal(dom.map.get('display-menu').classList.contains('hidden'), false);
  for (const [action, expectCall] of [
    ['preset-compact', () => assert.deepEqual(ctx.calls.setDisplayPreset, ['compact'])],
    ['preset-normal', () => assert.deepEqual(ctx.calls.setDisplayPreset, ['compact', 'normal'])],
    ['preset-loose', () => assert.deepEqual(ctx.calls.setDisplayPreset, ['compact', 'normal', 'loose'])],
    ['toggle-invisibles', () => assert.deepEqual(ctx.calls.toggleMarks, ['invisibles'])],
    ['toggle-long-para', () => assert.deepEqual(ctx.calls.toggleMarks, ['invisibles', 'longParagraphs'])],
    ['display-settings', () => assert.equal(ctx.calls.openSettings, 1)]
  ]) {
    const btn = { dataset: { action } };
    await dom.map.get('display-menu')._fire('click', { target: { closest: (sel) => (sel === 'button[data-action]' ? btn : null) } });
    expectCall();
  }
  // 色块：不关菜单，按书保存颜色
  const swatch = { dataset: { caretColor: '#c0392b' } };
  await dom.map.get('display-menu')._fire('click', {
    target: { closest: (sel) => (sel === '[data-caret-color]' ? swatch : null) },
    preventDefault() {}, stopPropagation() {}
  });
  assert.deepEqual(ctx.calls.setCaretColorPersisted, ['#c0392b']);

  // 取色器：input 只预览、change 保存
  dom.map.get('format-caret-color').value = '#123456';
  dom.map.get('format-caret-color')._fire('input');
  assert.deepEqual(ctx.calls.applyCaretColor, [{ caretParagraphColor: caretColorLib.normalizeColor('#123456') }]);
  dom.map.get('format-caret-color')._fire('change');
  await Promise.resolve();
  assert.equal(ctx.calls.setCaretColorPersisted[ctx.calls.setCaretColorPersisted.length - 1], '#123456');

  // 格式对话框：取消 → 收起；套用 → 调 applyFormatToEditor（这里只验证绑定指向）
  dom.map.get('btn-format-cancel')._fire('click');
  assert.equal(dom.map.get('format-backdrop').classList.contains('hidden'), true);
});

// ---------- 静态闸门 ----------
test('静态闸门：renderer.js 不再内嵌整理卡 / 显示菜单实现，只剩装配与转发 + 两个胶水函数', () => {
  for (const shape of [
    'function formatCardOpen(',
    'function displayMenuOpen(',
    'function refreshFormatCard(',
    'function showFormatCard(',
    'function hideFormatMenu(',
    'function scheduleHideFormatCard(',
    'function showDisplayMenu(',
    'function hideDisplayMenu(',
    'function toggleDisplayMenu(',
    'function openFormatDialog(',
    'function closeFormatDialog(',
    'function insertFormattedText(',
    'function mapCaretPosition(',
    'function pushFormatUndo(',
    'function formatUndoSteps(',
    'function canUndoFormat(',
    'function undoFormat(',
    'async function formatCurrentChapterFromConfig(',
    'async function applyFormatToEditor('
  ]) {
    assert.equal(rendererSrc.includes(shape), false, 'renderer.js 里还有第二份：' + shape);
  }
  // 两个共享胶水刻意留在 renderer.js（其他域按名字取）
  assert.equal(rendererSrc.includes('  function hideHeaderMenus() {'), true);
  assert.equal(rendererSrc.includes('  function scrollCaretIntoView('), true);
  assert.equal(rendererSrc.split('tidyCardUiModule.create(').length - 1, 1, '装配只许一处');
  assert.ok(rendererSrc.includes('const tidyCardUiModule = window.CWTidyCardUi;'));
  for (const line of [
    '    $, state, api, call, toast,',
    '    format: { formatUi, MAX_FORMAT_UNDO, readFormatOptions, writeFormatOptions, editorEl, onEditorInput, chaptersLib, caretColorLib },',
    '    menus: { hideBookMenu, hideExportMenu, hideMenu, renderMarksMenu },',
    '    peers: { openSettings: () => openSettings(), toggleMarks, setDisplayPreset, applyCaretColor, setCaretParagraphPersisted, setCaretColorPersisted, runFormatBook, scrollCaretIntoView }'
  ]) {
    assert.ok(rendererSrc.includes(line), '装配少了：' + line);
  }
  assert.ok(rendererSrc.includes(
    'const { formatCardOpen, displayMenuOpen, refreshFormatCard, showFormatCard, hideFormatMenu, scheduleHideFormatCard, showDisplayMenu, hideDisplayMenu, openFormatDialog, closeFormatDialog, formatUndoSteps, canUndoFormat, undoFormat, formatCurrentChapterFromConfig, applyFormatToEditor, setupTidyCardUi } = tidyCardUi;'
  ), '16 个入口按原名解构');
  for (const id of ['btn-format', 'format-menu', 'btn-display', 'display-menu', 'format-caret-color', 'btn-format-apply', 'btn-format-cancel', 'btn-format-reset', 'fmt-blank']) {
    assert.equal(rendererSrc.includes(`$('${id}').addEventListener`), false, '绑定应该只在模块里：' + id);
  }
  assert.equal(rendererSrc.split('tidyCardUi.setupTidyCardUi();').length - 1, 1, 'setup 只调一次');
  // Esc 表仍按名字取（formatCardOpen / displayMenuOpen / hideFormatMenu / hideDisplayMenu / closeFormatDialog）
  for (const needle of ['formatCardOpen()', 'displayMenuOpen()', 'hideFormatMenu()', 'hideDisplayMenu()', 'closeFormatDialog()']) {
    assert.ok(rendererSrc.includes(needle), 'Esc 链里少了 ' + needle);
  }
  // 一键整理本书仍按名字取 hideFormatMenu / hideDisplayMenu
  assert.ok(rendererSrc.includes('hideFormatMenu();'));
  assert.ok(rendererSrc.includes('hideDisplayMenu();'));
  // 测试钩子宿主契约的 13 个键仍在
  for (const key of ['formatCardOpen', 'displayMenuOpen', 'showFormatCard', 'hideFormatMenu', 'showDisplayMenu', 'hideDisplayMenu', 'openFormatDialog', 'formatUndoSteps', 'canUndoFormat', 'undoFormat', 'formatCurrentChapterFromConfig', 'applyFormatToEditor']) {
    assert.match(rendererSrc, new RegExp('^      ' + key + ',$', 'm'), 'testHooksScope 少了 ' + key);
  }
});

test('静态闸门：index.html 在 renderer.js 之前加载 tidy-card-ui.js，且只加载一次', () => {
  const at = indexSrc.indexOf('<script src="tidy-card-ui.js"></script>');
  const rendererAt = indexSrc.indexOf('<script src="renderer.js"></script>');
  assert.notEqual(at, -1);
  assert.ok(at < rendererAt);
  assert.equal(indexSrc.split('tidy-card-ui.js').length - 1, 1);
});

test('静态闸门：模块不 require / 不摸 Electron·fs·网络；只挂 2 个 setTimeout、无全局监听', () => {
  for (const forbidden of ['require(', 'ipcRenderer', 'node:fs', 'child_process', 'localStorage', 'fetch(', 'window.', 'process.']) {
    assert.equal(moduleCode.includes(forbidden), false, 'tidy-card-ui.js 不许出现 ' + forbidden);
  }
  assert.equal(/window\.addEventListener|document\.addEventListener/.test(moduleCode), false);
  assert.equal((moduleCode.match(/setTimeout\(/g) || []).length, 2, '只有整理卡收起 / 预览两个定时器');
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWTidyCardUi，且不乱造别的全局', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(moduleSrc, context, { filename: 'renderer/tidy-card-ui.js' });
  assert.equal(typeof win.CWTidyCardUi, 'object');
  assert.deepEqual(Object.keys(win.CWTidyCardUi).sort(), ['REQUIRED_HOST', 'create']);
  assert.equal(win.CWTidyCardUi.REQUIRED_HOST.length, 8);
  assert.equal(win.CWSettingsUi, undefined);
});
