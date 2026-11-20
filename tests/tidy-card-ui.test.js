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
// 契约：host 9 个成员 = 基础 5（$, state, api, call, toast）+ recordFallbackWrite（审计修复 #39 / V402：
// 兜底整串赋值后由渲染层统一记快照 + 提示）+ format{formatUi,MAX_FORMAT_UNDO,
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
    // 1.8.0 WP-12（V201）：生效值 = 全局 + 本书覆盖；默认没有按书覆盖（与真实 state 一致）
    globalConfig: options.globalConfig === undefined ? null : options.globalConfig,
    bookDisplay: options.bookDisplay || {},
    chapters: options.chapters === undefined ? [{ id: 'c1', name: '第一章', file: 'c1.txt' }] : options.chapters,
    formatUndo: options.formatUndo || [],
    marks: { caretParagraph: false }
  };
  // 与 renderer.js 的 effectiveConfig() 同一口径（全局 + 当前书覆盖）
  const effectiveConfig = () => ({ ...(state.globalConfig || state.config || {}), ...(state.bookDisplay || {}) });
  if (options.globalConfig !== undefined) state.config = effectiveConfig();
  const editorEl = makeEl('textarea');
  editorEl.value = options.text === undefined ? '第一段  文字' : options.text;
  editorEl.selectionStart = options.caret === undefined ? 0 : options.caret;
  const calls = {
    formatText: [], setConfig: [], toast: [], hideExportMenu: 0, hideBookMenu: 0, hideMenu: [],
    renderMarksMenu: 0, openSettings: 0, toggleMarks: [], setDisplayPreset: [], applyCaretColor: [],
    setCaretParagraphPersisted: [], setCaretColorPersisted: [], runFormatBook: 0, scrollCaretIntoView: [],
    onEditorInput: 0, fallbackWrites: []
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
      return { ...(state.globalConfig || state.config), ...patch };
    }
  };
  const host = {
    $: dom.$,
    state,
    api,
    call: async (fn, ...args) => fn(...args),
    toast(message, kind) { calls.toast.push([message, kind]); },
    // 审计修复 #39（V402）：兜底整串赋值后由渲染层统一记快照 + 提示（生产是 renderer.js 的实现）
    recordFallbackWrite(info) { calls.fallbackWrites.push(info); },
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
      scrollCaretIntoView(pos) { calls.scrollCaretIntoView.push(pos); },
      // 1.8.0 WP-12（V201）：生效配置访问器由渲染层注入（与 renderer.js 同一份语义）
      effectiveConfig
    }
  };
  const ui = tidyCardUi.create(host);
  return { ui, host, state, dom, calls, editorEl };
}

// ---------- host 契约 ----------
test('host 契约：9 个成员 + 分组内每个真实依赖；缺任何一个都抛 TypeError', () => {
  assert.deepEqual([...tidyCardUi.REQUIRED_HOST].sort(), ['$', 'api', 'call', 'format', 'menus', 'peers', 'recordFallbackWrite', 'state', 'toast']);
  assert.equal(tidyCardUi.REQUIRED_HOST.length, 9);
  const ctx = build();
  assert.doesNotThrow(() => tidyCardUi.create(ctx.host));
  assert.throws(() => tidyCardUi.create(null), /createTidyCardUi 需要 host 对象/);
  // 审计修复 #39（V402）：成员在但不是函数也算缺（兜底写入无声清栈）
  assert.throws(
    () => tidyCardUi.create({ ...ctx.host, recordFallbackWrite: 'not-a-function' }),
    /host\.recordFallbackWrite 必须是函数/
  );
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
  for (const key of ['openSettings', 'toggleMarks', 'setDisplayPreset', 'applyCaretColor', 'setCaretParagraphPersisted', 'setCaretColorPersisted', 'runFormatBook', 'scrollCaretIntoView', 'effectiveConfig']) {
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
  // 审计修复 #39（V402）：「撤销整理」自己的回退即使走兜底赋值也不记新的可撤销写入（recordFallback:false），
  // 否则作者会把「撤销」再撤销一次，语义绕回去。
  assert.deepEqual(ctx.calls.fallbackWrites, [], '撤销整理的回退不该记兜底快照');
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
  // 审计修复 #39（V402）：测试假 DOM 没有 execCommand → 走兜底整串赋值；这条路径必须记账（渲染层据此
  // 记一次性快照 + 提示「退出了撤销历史」），并没有把清理正文的副作用静默吞掉。
  assert.deepEqual(ctx.calls.fallbackWrites, [
    { before: '第一段  文字', after: '第一段文字', start: 3, label: '整理本章' }
  ]);
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

test('updateFormatPreview（#43 / E17）：预览在飞期间正文被改 → 旧结果不许贴到新正文上，按新正文重排一次', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release;
  const requests = [];
  const ctx = build({ text: '旧正文  甲' });
  ctx.host.api.formatText = (text) => {
    requests.push(text);
    if (text === '旧正文  甲') return new Promise((resolve) => { release = resolve; });
    return Promise.resolve({ changed: true, text: '新正文乙', stats: { paragraphs: 1 } });
  };
  ctx.ui.openFormatDialog();
  t.mock.timers.tick(0);
  // 预览在飞期间正文被改（原生 Ctrl+Z / 兜底写入都可能绕过对话框的 change 事件）
  ctx.editorEl.value = '新正文  乙';
  release({ changed: true, text: '旧正文甲', stats: { paragraphs: 1 } });
  await flush();
  // 旧正文的结果没有写进面板，按钮也没有按旧结果放开；已按新正文重新发起预览
  assert.equal(ctx.dom.map.get('fmt-summary').textContent, '正在预览…');
  assert.equal(ctx.dom.map.get('fmt-preview').textContent, '');
  assert.equal(ctx.dom.map.get('btn-format-apply').disabled, true);
  t.mock.timers.tick(0);
  await flush();
  assert.deepEqual(requests, ['旧正文  甲', '新正文  乙'], '旧结果的正文快照作废 → 按新正文重排一次');
  assert.equal(ctx.dom.map.get('fmt-summary').textContent, formatUi.statsText({ paragraphs: 1 }));
  assert.equal(ctx.dom.map.get('btn-format-apply').disabled, false);
  assert.equal(ctx.dom.map.get('fmt-preview').textContent, '新正文乙');
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

// ---------- 五-H7（TC-01）：apply 的第二个 await（setConfig）落地必须复核身份 / 代数 ----------
// 缺陷：身份复核只在第一个 await（formatText）后；setConfig 写盘在途时按 Esc 关框（锁键解除）
// 后作者打字 / 切章 / 重开再套用，旧结果落地后仍整串写进编辑区——静默丢字，极端时把旧章整理稿
// 写进新章并可按 Ctrl+S 存盘。修法：apply 代数令牌（closeFormatDialog 推进）+ 第二个 await 后重跑复核。
test('五-H7：apply 在第二个 await（setConfig）期间按 Esc 取消 → 旧整理稿作废，不写进编辑区', async () => {
  let releaseSet;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const ctx = build({ text: '第一段  文字' });
  ctx.host.api.setConfig = () => {
    started();
    return new Promise((resolve) => { releaseSet = resolve; });
  };
  const applying = ctx.ui.applyFormatToEditor();
  await startedPromise; // formatText 已回来且复核通过，setConfig 写盘在途
  ctx.ui.closeFormatDialog(); // 作者按 Esc 放弃（按钮已禁用、窗已关）
  releaseSet({});
  const result = await applying;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale', 'Esc 后这次 apply 必须作废');
  assert.equal(ctx.editorEl.value, '第一段  文字', '编辑区一个字都不许被旧整理稿覆盖');
  assert.equal(ctx.calls.onEditorInput, 0, '没有发生整串写入');
  assert.deepEqual(ctx.state.formatUndo, [], '不许登记一条指向旧结果的撤销');
  assert.match(ctx.calls.toast[ctx.calls.toast.length - 1][0], /正文刚改过/);
});

test('五-H7：apply 的 setConfig 期间切章 + 输入 → 旧章整理稿绝不写进新章编辑区', async () => {
  let releaseSet;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const ctx = build({
    text: '旧章正文  甲',
    chapters: [
      { id: 'c1', name: '第一章', file: 'c1.txt' },
      { id: 'c2', name: '第二章', file: 'c2.txt' }
    ],
    index: 0
  });
  ctx.host.api.formatText = () => Promise.resolve({ changed: true, text: '旧章正文甲', stats: {} });
  ctx.host.api.setConfig = () => {
    started();
    return new Promise((resolve) => { releaseSet = resolve; });
  };
  const applying = ctx.ui.applyFormatToEditor();
  await startedPromise;
  // 窗口期内作者切到第 2 章并敲了新内容（Esc 关框 / 切章在第二个 await 期间都合法）
  ctx.state.index = 1;
  ctx.editorEl.value = '新章自己的正文';
  releaseSet({});
  const result = await applying;
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale');
  assert.equal(ctx.editorEl.value, '新章自己的正文', '绝不把旧章整理稿盖进新章');
  assert.equal(ctx.calls.onEditorInput, 0);
  assert.deepEqual(ctx.state.formatUndo, [], '撤销快照不许按新章 id 登记');
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
    '    peers: { openSettings: () => openSettings(), toggleMarks, setDisplayPreset, applyCaretColor, setCaretParagraphPersisted, setCaretColorPersisted, runFormatBook, scrollCaretIntoView, effectiveConfig }'
  ]) {
    assert.ok(rendererSrc.includes(line), '装配少了：' + line);
  }
  // 1.8.0 WP-12（V201）：setConfig 回包是纯全局配置，不许再直接赋给 state.config；
  // 标准写法两行（先写 globalConfig，再用 host 注入的 effectiveConfig 重算生效值），全仓唯一一份。
  assert.equal(moduleSrc.includes('state.config = await call('), false, 'V201：不许把纯全局配置直接赋给 state.config');
  assert.ok(moduleSrc.includes('        const cfg = await call(api.setConfig, { formatOptions: options });'), '先拿回包');
  assert.ok(moduleSrc.includes('        state.globalConfig = cfg;'), '回包写进全局配置');
  assert.ok(moduleSrc.includes('        state.config = effectiveConfig();'), '生效值经 host 注入的 effectiveConfig 重算');
  assert.ok(rendererSrc.includes(
    'const { formatCardOpen, displayMenuOpen, showFormatCard, hideFormatMenu, showDisplayMenu, hideDisplayMenu, openFormatDialog, closeFormatDialog, formatUndoSteps, canUndoFormat, undoFormat, formatCurrentChapterFromConfig, applyFormatToEditor, setupTidyCardUi } = tidyCardUi;'
  ), '14 个入口按原名解构（refreshFormatCard / scheduleHideFormatCard 只在模块内部用）');
  for (const id of ['btn-format', 'format-menu', 'btn-display', 'display-menu', 'format-caret-color', 'btn-format-apply', 'btn-format-cancel', 'btn-format-reset', 'fmt-blank']) {
    assert.equal(rendererSrc.includes(`$('${id}').addEventListener`), false, '绑定应该只在模块里：' + id);
  }
  assert.equal(rendererSrc.split('setupTidyCardUi();').length - 1, 1, 'setup 只调一次');
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
  // A8（WP-32）：唯一允许的 require 是 UMD 的 Node 分支取 core/assert-host.js（浏览器走 window.CWAssertHost）；
  // 运行时代码仍不许 require 任何东西。
  const assertHostBranch = "module.exports = factory(require('../core/assert-host').assertHost);";
  assert.ok(moduleCode.includes(assertHostBranch), 'UMD 的 Node 分支必须从 ./assert-host 取共享 host 校验');
  const runtimeCode = moduleCode.split(assertHostBranch).join('');
  for (const forbidden of ['require(', 'ipcRenderer', 'node:fs', 'child_process', 'localStorage', 'fetch(', 'window.', 'process.']) {
    assert.equal(runtimeCode.includes(forbidden), false, 'tidy-card-ui.js 不许出现 ' + forbidden);
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
  assert.equal(win.CWTidyCardUi.REQUIRED_HOST.length, 9);
  assert.equal(win.CWSettingsUi, undefined);
});

// ---------- 「应用」也要 stale 三行校验（V33） ----------
// 「整理」在 await 之后会重看 书 / 章 / 正文 三样（renderer/tidy-card-ui.js 的 stale 分支）；
// 「应用」原来直接写编辑区，await 期间换书换章或被改过就会把 A 章结果写进 B 章。这里三条各走一遍。
test('applyFormatToEditor：应用期间正文被改 / 换书 / 章被删 → 与「整理」同一句三行校验，不写编辑区', async () => {
  const staleToast = ['正文刚改过，这次整理没有套用，请再点一次「整理」', 'warn'];

  // ① 正文被用户改过
  const edited = build({ text: '待整理正文' });
  edited.host.api.formatText = async () => {
    edited.editorEl.value = '用户刚打了新字';
    return { changed: true, text: '整理后', stats: { paragraphs: 1, indent: 1 } };
  };
  const r1 = await edited.ui.applyFormatToEditor();
  assert.equal(r1 && r1.reason, 'stale');
  assert.equal(edited.editorEl.value, '用户刚打了新字', '不许把旧结果写进新正文');
  assert.deepEqual(edited.calls.toast, [staleToast]);
  assert.equal(edited.state.formatUndo.length, 0, '作废时不进撤销栈');
  assert.equal(edited.calls.setConfig.length, 0, '作废时不记这次规则');

  // ② 期间换了书
  const switched = build({ text: '待整理正文' });
  switched.host.api.formatText = async () => {
    switched.state.bookPath = '/书库/书乙';
    return { changed: true, text: '整理后', stats: {} };
  };
  const r2 = await switched.ui.applyFormatToEditor();
  assert.equal(r2 && r2.reason, 'stale');
  assert.equal(switched.editorEl.value, '待整理正文');
  assert.deepEqual(switched.calls.toast, [staleToast]);

  // ③ 期间章被删
  const removed = build({ text: '待整理正文' });
  removed.host.api.formatText = async () => {
    removed.state.chapters = [];
    return { changed: true, text: '整理后', stats: {} };
  };
  const r3 = await removed.ui.applyFormatToEditor();
  assert.equal(r3 && r3.reason, 'stale');
  assert.equal(removed.editorEl.value, '待整理正文');
  assert.deepEqual(removed.calls.toast, [staleToast]);
});

// ---------- V201：应用排版不污染 state.config（1.8.0 WP-12） ----------
// 修复前：`state.config = await call(api.setConfig, { formatOptions })` 把纯全局配置直接当生效值。
// 有按书显示覆盖的书，在污染窗口里打开「按书设置」（回填读 state.config）再保存，
// 就会把全局值写成本书覆盖 —— 本书显示偏好被静默覆盖写盘。
// 下面按审计建议的链路走一遍语义：书有覆盖 → 排版应用 → 按书设置回填 → 保存载荷。
test('applyFormatToEditor：应用排版只更新全局，state.config 仍是全局 + 本书覆盖（V201）', async () => {
  const globalConfig = { formatOptions: { indent: '2' }, editorFont: 'serif', editorLineHeight: 1.6 };
  const bookDisplay = { editorFont: 'custom', editorCustomFontPath: '/书库/字体/思源.ttf' };
  const ctx = build({ text: '第一段  文字', globalConfig, bookDisplay });
  const options = ctx.host.format.readFormatOptions();

  await ctx.ui.applyFormatToEditor();
  assert.equal(ctx.editorEl.value, '第一段文字');
  assert.deepEqual(ctx.calls.setConfig, [{ formatOptions: options }], '规则只写全局配置');

  // 全局：规则已更新；本书覆盖键在生效值里仍是本书自己的值
  assert.deepEqual(ctx.state.globalConfig.formatOptions, options);
  assert.deepEqual(ctx.state.config, {
    formatOptions: options,
    editorFont: 'custom',
    editorCustomFontPath: '/书库/字体/思源.ttf',
    editorLineHeight: 1.6
  });
  assert.notEqual(ctx.state.config.editorFont, 'serif', '全局 serif 不许顶掉本书的 custom 覆盖');

  // 打开按书设置（settings-ui 回填读 state.config）→ 保存：覆盖值原样进 payload
  const backfill = {
    editorFont: ctx.state.config.editorFont,
    editorCustomFontPath: ctx.state.config.editorCustomFontPath
  };
  assert.deepEqual(backfill, { editorFont: 'custom', editorCustomFontPath: '/书库/字体/思源.ttf' });
  assert.equal(JSON.stringify(backfill).includes('serif'), false, '保存按书设置时不许把全局字体写成本书覆盖');
});

test('applyFormatToEditor：记规则失败也不污染 state.config（全局写失败时生效值原样）', async () => {
  const globalConfig = { formatOptions: { indent: '2' }, editorFont: 'serif' };
  const bookDisplay = { editorFont: 'custom' };
  const ctx = build({ text: '第一段  文字', globalConfig, bookDisplay, setConfigError: true });
  const before = { ...ctx.state.config };
  await ctx.ui.applyFormatToEditor();
  assert.equal(ctx.editorEl.value, '第一段文字', '记不住规则不影响整理');
  assert.deepEqual(ctx.state.config, before, '写全局失败时生效值不许动');
  assert.equal(ctx.state.globalConfig, globalConfig, '全局配置也不许假写');
});
// TC-02（五-L22）：整理写回走 execCommand('insertText') 时，原生撤销栈里已经有「整理」这一条；
// 卡片「撤销上次整理」再 insertText 回写 before，会压一条方向相反的原生记录 —— 之后 Ctrl+Z
// 又把整理套回来（编辑区从 before 跳回 after），而且没有提示。现在记录「这次是原生写回」，
// 撤销时弹掉原生那一条，不再把回退本身做成一次新编辑。
test('TC-02（五-L22）：原生写回的整理在「撤销上次整理」时走 execCommand(undo)，不再双栈互录', async () => {
  const dom = makeDocument();
  const ctx = build({ dom, text: '第一段  文字', caret: 4 });
  const cmds = [];
  let undoTop = null;
  dom.doc.execCommand = (cmd, _flag, value) => {
    cmds.push(cmd);
    if (cmd === 'insertText') {
      undoTop = ctx.editorEl.value; // 伪原生栈：记下被替换前的正文
      ctx.editorEl.value = value;
      return true;
    }
    if (cmd === 'undo') {
      if (undoTop == null) return false;
      ctx.editorEl.value = undoTop;
      undoTop = null;
      return true;
    }
    return false;
  };
  const formatted = await ctx.ui.formatCurrentChapterFromConfig();
  assert.equal(formatted.ok, true);
  assert.deepEqual(cmds, ['insertText'], '前提：整理走原生写回（原生栈里已有这一条）');
  assert.equal(ctx.state.formatUndo.length, 1);
  assert.equal(ctx.state.formatUndo[0].native, true, '快照要记住这次是原生写回');

  // 卡片「撤销上次整理」：弹掉原生那一条，不再 insertText 一次
  assert.equal(ctx.ui.undoFormat(), true);
  assert.deepEqual(cmds, ['insertText', 'undo'], '撤销整理走原生 undo（旧实现会再 push 一条 insertText）');
  assert.equal(ctx.editorEl.value, '第一段  文字', '编辑区回到整理前');
  assert.equal(ctx.state.formatUndo.length, 0);
  assert.ok(ctx.calls.onEditorInput >= 1, '撤销后仍标记未保存（不静默）');
  assert.deepEqual(ctx.calls.toast[ctx.calls.toast.length - 1], ['已撤销整理（仍在编辑区，未写盘）', undefined]);

  // 兜底回退路径（没有 execCommand）照旧：整串写回、提示不变
  const plain = build({ text: '第一段  文字' });
  assert.equal((await plain.ui.formatCurrentChapterFromConfig()).ok, true);
  assert.equal(plain.state.formatUndo[0].native, false, '兜底写回没有原生记录可弹');
  assert.equal(plain.ui.undoFormat(), true);
  assert.equal(plain.editorEl.value, '第一段  文字');
});
