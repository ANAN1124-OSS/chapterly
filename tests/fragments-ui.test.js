const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const fragmentsUi = require('../renderer/fragments-ui');
const chaptersLib = require('../core/chapters');
const commonLib = require('../core/common');

// 第 4 步 renderer 九刀·补刀 10：灵感箱 / 碎片速记（原 renderer.js 2747–2978，232 行）搬到 renderer/fragments-ui.js。
// 搬之前只有 E2E 黑盒覆盖（书架记碎片 / 写作页插入）；保存防重 / 空内容 / 插入位置按打开面板前的选区 /
// execCommand 失败兜底 / 2 万字预览上限 / 列表空态与元信息在 Node 里几乎测不到。搬出来以后逐条钉住。
//
// 契约：host 8 个成员 = 基础 5（$, state, api, call, toast）+ common{chaptersLib,formatRelativeTime} +
// editor{editorEl,onEditorInput,scrollCaretIntoView} + hideHeaderMenus。

const realDocument = globalThis.document;
test.after(() => {
  if (realDocument === undefined) delete globalThis.document;
  else globalThis.document = realDocument;
});
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const moduleSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'fragments-ui.js'), 'utf8');
const moduleCode = moduleSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------- 假 DOM ----------
function makeEl(tag = 'div', id = '') {
  const classes = new Set();
  const listeners = [];
  const el = {
    tagName: tag, id, className: '', textContent: '', title: '', value: '', disabled: false,
    dataset: {}, children: [], parentNode: null, selectionStart: 0, selectionEnd: 0,
    _classes: classes, _listeners: listeners, _attrs: {}, _focus: 0,
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
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    focus() { el._focus += 1; },
    setSelectionRange(start, end) { el.selectionStart = start; el.selectionEnd = end; },
    _fire(type, event) {
      let result;
      for (const l of listeners) if (l.type === type) result = l.fn(event);
      return result;
    }
  };
  Object.defineProperty(el, 'innerHTML', { get() { return ''; }, set() { el.children.length = 0; } });
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
  const doc = {
    createElement: (tag) => makeEl(tag),
    execCommand: null,
    querySelectorAll(selector) {
      if (selector !== '#fragments-list .fragment-item') return [];
      const list = map.get('fragments-list');
      if (!list) return [];
      return list.children.filter((c) => String(c.className).split(/\s+/).includes('fragment-item'));
    },
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
  'fragment-counter', 'fragment-text', 'fragment-save-state', 'fragment-backdrop', 'btn-fragment-save',
  'fragments-backdrop', 'fragments-list', 'fragments-summary', 'fragment-preview', 'fragment-preview-name',
  'btn-fragment-insert', 'fragment-hint', 'btn-add-fragment', 'btn-fragment-cancel', 'btn-insert-fragment',
  'btn-fragments-close', 'btn-fragments-refresh'
];

// 拍板 #9：列表里多了 .fragment-day 分组标题，取「条目」时必须按 class 过滤（与 test-hooks
// 的 fragmentRowCount / clickFragmentRow 口径一致：只认 .fragment-item）。
function hasClass(el, name) {
  return String(el.className).split(/\s+/).includes(name);
}
function rowEls(listEl) {
  return listEl.children.filter((c) => hasClass(c, 'fragment-item'));
}
function dayEls(listEl) {
  return listEl.children.filter((c) => hasClass(c, 'fragment-day'));
}
// 本地日期字符串（与实现里「跨天以本机本地日期算」同一口径）
function localDay(offsetDays = 0) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function makeFragment(overrides = {}) {
  return {
    name: '碎片-20261103-1.txt',
    date: '2026-11-03',
    seq: 1,
    mtimeMs: 0,
    size: 128,
    preview: '今天想到一句话',
    ...overrides
  };
}

// 1.5.0 功能-3：DataSet 的最小替身（只用到 setData / getData / types / dropEffect）
function makeDataTransfer() {
  const data = new Map();
  return {
    types: [],
    dropEffect: 'none',
    effectAllowed: 'none',
    writes: [],
    setData(type, value) {
      const key = String(type);
      const text = String(value);
      data.set(key, text);
      this.writes.push([key, text]);
      if (!this.types.includes(key)) this.types.push(key);
    },
    getData(type) {
      return data.has(String(type)) ? data.get(String(type)) : '';
    }
  };
}

function build(options = {}) {
  const dom = options.dom || makeDocument();
  for (const id of BASE_IDS) dom.ensure(id);
  dom.map.get('fragment-backdrop').classList.add('hidden');
  dom.map.get('fragments-backdrop').classList.add('hidden');
  if (options.text !== undefined) dom.map.get('fragment-text').value = options.text;
  globalThis.document = dom.doc;
  const state = {
    bookPath: '/书库/书甲',
    dirty: false,
    fragmentBusy: false,
    fragments: [],
    fragmentSelected: null,
    insertFragmentRange: null
  };
  const editorEl = makeEl('textarea');
  editorEl.value = options.editorText === undefined ? '正文开头' : options.editorText;
  editorEl.selectionStart = options.selection === undefined ? 2 : options.selection;
  editorEl.selectionEnd = options.selectionEnd === undefined ? 2 : options.selectionEnd;
  const calls = {
    api: [], toast: [], hideHeaderMenus: 0, onEditorInput: 0, scrollCaretIntoView: []
  };
  const api = {
    async createFragment(text) {
      calls.api.push(['create', text]);
      if (options.createError) throw new Error(options.createError);
      return options.createResult || { name: '碎片-20261103-1.txt', path: '/书库/书甲/_碎片/碎片-20261103-1.txt', chars: 5, bytes: 20 };
    },
    async listFragments() {
      calls.api.push(['list']);
      if (options.listError) throw new Error(options.listError);
      return options.listResult || { total: 1, truncated: false, fragments: [makeFragment()] };
    },
    async readFragment(name) {
      calls.api.push(['read', name]);
      if (options.readError) throw new Error(options.readError);
      return options.readResult || { name, text: '这是碎片正文', chars: 6, size: 30 };
    }
  };
  const host = {
    $: dom.$,
    state,
    api,
    call: async (fn, ...args) => fn(...args),
    toast(message, kind) { calls.toast.push([message, kind]); },
    common: {
      chaptersLib,
      formatRelativeTime: (ms) => (Number(ms) ? '刚才' : '很久以前'),
      formatCount: commonLib.formatCount
    },
    editor: {
      editorEl,
      onEditorInput() { calls.onEditorInput += 1; },
      scrollCaretIntoView(pos) { calls.scrollCaretIntoView.push(pos); }
    },
    hideHeaderMenus() { calls.hideHeaderMenus += 1; }
  };
  const ui = fragmentsUi.create(host);
  return { ui, host, state, dom, calls, editorEl };
}

// ---------- host 契约 ----------
test('host 契约：8 个成员 + 分组内每个真实依赖；缺任何一个都抛 TypeError', () => {
  assert.deepEqual([...fragmentsUi.REQUIRED_HOST].sort(), ['$', 'api', 'call', 'common', 'editor', 'hideHeaderMenus', 'state', 'toast']);
  assert.equal(fragmentsUi.REQUIRED_HOST.length, 8);
  const ctx = build();
  assert.doesNotThrow(() => fragmentsUi.create(ctx.host));
  assert.throws(() => fragmentsUi.create(null), /createFragmentsUi 需要 host 对象/);
  for (const key of fragmentsUi.REQUIRED_HOST) {
    const broken = { ...ctx.host };
    delete broken[key];
    assert.throws(() => fragmentsUi.create(broken), new RegExp('host 缺少 ' + key.replace('$', '\\$')), '缺 ' + key);
  }
  for (const key of ['chaptersLib', 'formatRelativeTime']) {
    const broken = { ...ctx.host, common: { ...ctx.host.common } };
    delete broken.common[key];
    assert.throws(() => fragmentsUi.create(broken), new RegExp('host\\.common 缺少 ' + key));
  }
  for (const key of ['editorEl', 'onEditorInput', 'scrollCaretIntoView']) {
    const broken = { ...ctx.host, editor: { ...ctx.host.editor } };
    delete broken.editor[key];
    assert.throws(() => fragmentsUi.create(broken), new RegExp('host\\.editor 缺少 ' + key));
  }
});

test('create() 只建表：不碰 DOM / 不注册事件，交出 10 个入口', () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  assert.equal(dom.lookups, 0);
  assert.deepEqual(Object.keys(ctx.ui).sort(), [
    'closeFragmentDialog', 'closeInsertFragmentDialog', 'insertSelectedFragment', 'openFragmentDialog',
    'openInsertFragmentDialog', 'refreshFragments', 'saveFragment', 'selectFragmentByName',
    'setupFragmentsUi', 'updateFragmentCounter'
  ]);
  assert.equal(moduleCode.includes('setInterval'), false);
});

// ---------- 记账 / 状态 ----------
test('updateFragmentCounter：字数按 core/characters 口径算，空内容为 0 字', () => {
  const ctx = build({ text: '一二 三' });
  ctx.ui.updateFragmentCounter();
  assert.equal(ctx.dom.map.get('fragment-counter').textContent, '3 字');
  const empty = build({ text: '   ' });
  empty.ui.updateFragmentCounter();
  assert.equal(empty.dom.map.get('fragment-counter').textContent, '0 字');
});

// ---------- 保存碎片弹层 ----------
test('openFragmentDialog / closeFragmentDialog：清空输入、收起顶栏菜单、显示弹层，30ms 后聚焦', async () => {
  const ctx = build({ text: '旧内容' });
  ctx.dom.map.get('fragment-save-state').textContent = '旧错误';
  assert.equal(ctx.ui.openFragmentDialog(), true);
  assert.equal(ctx.calls.hideHeaderMenus, 1);
  assert.equal(ctx.dom.map.get('fragment-text').value, '');
  assert.equal(ctx.dom.map.get('fragment-save-state').textContent, '');
  assert.equal(ctx.dom.map.get('fragment-counter').textContent, '0 字');
  assert.equal(ctx.dom.map.get('fragment-backdrop').classList.contains('hidden'), false);
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(ctx.dom.map.get('fragment-text')._focus, 1);
  ctx.ui.closeFragmentDialog();
  assert.equal(ctx.dom.map.get('fragment-backdrop').classList.contains('hidden'), true);
});

test('saveFragment：忙时早退 / 空内容报错并聚焦 / 成功关闭并 toast / 失败恢复按钮与错误文案', async () => {
  const busy = build();
  busy.state.fragmentBusy = true;
  assert.deepEqual(await busy.ui.saveFragment(), { ok: false, message: '正在保存…' });
  assert.deepEqual(busy.calls.api, []);

  const empty = build({ text: '  \n ' });
  const emptyRes = await empty.ui.saveFragment();
  assert.equal(emptyRes.ok, false);
  assert.equal(empty.dom.map.get('fragment-save-state').textContent, '碎片内容是空的，写点什么再保存吧');
  assert.equal(empty.dom.map.get('fragment-text')._focus, 1);

  const ok = build({ text: '新碎片' });
  ok.dom.map.get('fragments-backdrop').classList.remove('hidden');
  const res = await ok.ui.saveFragment();
  assert.deepEqual(ok.calls.api[0], ['create', '新碎片']);
  assert.equal(res.ok, true);
  assert.equal(res.chars, 5);
  assert.equal(ok.dom.map.get('fragment-backdrop').classList.contains('hidden'), true);
  assert.equal(ok.dom.map.get('btn-fragment-save').disabled, false);
  assert.equal(ok.state.fragmentBusy, false);
  assert.match(ok.calls.toast[0][0], /^碎片已保存：_碎片\\/);
  // 插入面板开着时顺带刷一次列表
  assert.equal(ok.calls.api.some((c) => c[0] === 'list'), true);

  const fail = build({ text: '新碎片', createError: '磁盘满' });
  const failRes = await fail.ui.saveFragment();
  assert.equal(failRes.ok, false);
  assert.equal(fail.dom.map.get('fragment-save-state').textContent, '保存失败：磁盘满');
  assert.deepEqual(fail.calls.toast, [['保存碎片失败：磁盘满', 'error']]);
  assert.equal(fail.dom.map.get('btn-fragment-save').disabled, false);
});

// ---------- 插入碎片面板 ----------
test('openInsertFragmentDialog：没书警告；有选区 / 无选区两种提示；记下打开前光标位置', () => {
  const noBook = build();
  noBook.state.bookPath = null;
  assert.equal(noBook.ui.openInsertFragmentDialog(), false);
  assert.deepEqual(noBook.calls.toast, [['先打开一本书再插入碎片', 'warn']]);

  const caret = build({ selection: 3, selectionEnd: 3 });
  assert.equal(caret.ui.openInsertFragmentDialog(), true);
  assert.deepEqual(caret.state.insertFragmentRange, { start: 3, end: 3 });
  assert.match(caret.dom.map.get('fragment-hint').textContent, /^将插在打开面板前的光标处（第 4 字）/);
  assert.equal(caret.dom.map.get('btn-fragment-insert').disabled, true);
  assert.equal(caret.dom.map.get('fragment-preview-name').textContent, '选一条碎片看内容');
  assert.equal(caret.dom.map.get('fragments-backdrop').classList.contains('hidden'), false);

  const range = build({ selection: 2, selectionEnd: 6 });
  range.ui.openInsertFragmentDialog();
  assert.deepEqual(range.state.insertFragmentRange, { start: 2, end: 6 });
  assert.match(range.dom.map.get('fragment-hint').textContent, /^将替换打开面板前选中的第 3–6 字/);
});

test('列表渲染（经 refreshFragments）：空态 / 行结构（名称 / 元信息 / 预览）/ 点行选中', async () => {
  const empty = build({ listResult: { total: 0, truncated: false, fragments: [] } });
  await empty.ui.refreshFragments();
  assert.equal(empty.dom.map.get('fragments-summary').textContent, '共 0 条碎片');
  assert.equal(empty.dom.map.get('fragments-list').children[0].className, 'fragment-empty');

  const ctx = build({
    listResult: {
      total: 3,
      truncated: true,
      fragments: [
        makeFragment({ name: 'a.txt', date: '2026-11-03', seq: 2, size: 2048, preview: '预览一' }),
        makeFragment({ name: 'b.txt', date: '', size: 10, preview: '' })
      ]
    }
  });
  ctx.host.api.readFragment = async (name) => ({ name, text: '内容', chars: 2, size: 4 });
  await ctx.ui.refreshFragments();
  assert.equal(ctx.dom.map.get('fragments-summary').textContent, '共 3 条碎片（最新在前），只列出前 2 条');
  // 拍板 #9 之后列表里多了 .fragment-day 分组标题，行本身仍只认 .fragment-item
  const items = rowEls(ctx.dom.map.get('fragments-list'));
  assert.equal(items.length, 2);
  assert.equal(items[0].classList.contains('fragment-item'), true);
  assert.equal(items[0].dataset.name, 'a.txt');
  assert.equal(items[0].children[0].className, 'fragment-item-name');
  assert.equal(items[0].children[0].textContent, 'a.txt');
  assert.equal(items[0].children[1].className, 'fragment-item-meta');
  assert.equal(items[0].children[1].textContent, '2026-11-03 · 第 2 条 · 很久以前 · 2.0 KB');
  assert.equal(items[0].children[2].className, 'fragment-item-preview');
  assert.equal(items[0].children[2].textContent, '预览一');
  assert.equal(items[1].children[1].textContent, '手工放入的 txt · 很久以前 · 10 B');
  assert.equal(items[1].children[2].textContent, '（空文件）');

  items[0]._fire('click');
  await flush();
  assert.equal(ctx.state.fragmentSelected.name, 'a.txt');
});

// ---------- 拍板 #9：列表按日期分组 ----------
test('日期分组（经渲染）：今天 / 昨天 / M月D日 / 更早；同一天只插一条标题', async () => {
  const today = localDay(0);
  const yesterday = localDay(-1);
  const ctx = build({
    listResult: {
      total: 5,
      truncated: false,
      fragments: [
        makeFragment({ name: `${today}-1.txt`, date: today, seq: 1 }),
        makeFragment({ name: `${today}-2.txt`, date: today, seq: 2 }),
        makeFragment({ name: `${yesterday}-1.txt`, date: yesterday, seq: 1 }),
        makeFragment({ name: '2020-02-29-1.txt', date: '2020-02-29', seq: 1 }),
        makeFragment({ name: '手工片段.txt', date: '', seq: 0 })
      ]
    }
  });
  const res = await ctx.ui.refreshFragments();
  assert.equal(res.ok, true);
  const list = ctx.dom.map.get('fragments-list');
  assert.deepEqual(dayEls(list).map((el) => el.textContent), ['今天', '昨天', '2月29日', '更早']);
  assert.equal(rowEls(list).length, 5);
  // 标题落在各自分组第一条之前，同一天的 2 条中间不重复插
  assert.equal(hasClass(list.children[0], 'fragment-day'), true);
  assert.equal(list.children[0].textContent, '今天');
  assert.equal(list.children[1].dataset.name, `${today}-1.txt`);
  assert.equal(list.children[2].dataset.name, `${today}-2.txt`);
  assert.equal(list.children[3].textContent, '昨天');
  assert.equal(list.children[4].dataset.name, `${yesterday}-1.txt`);
});

test('日期分组：条目数与顺序一字不变；标题是 div、不带 .fragment-item，也不挂点击', async () => {
  const today = localDay(0);
  const names = [`${today}-1.txt`, `${today}-2.txt`, '2021-03-04-1.txt', '随便放的.txt'];
  const ctx = build({
    listResult: {
      total: 4,
      truncated: false,
      fragments: names.map((name, i) => makeFragment({ name, seq: i + 1 }))
    }
  });
  await ctx.ui.refreshFragments();
  const list = ctx.dom.map.get('fragments-list');
  assert.deepEqual(rowEls(list).map((el) => el.dataset.name), names, '顺序与条数都不变');
  assert.deepEqual(dayEls(list).map((el) => el.textContent), ['今天', '3月4日', '更早']);
  for (const day of dayEls(list)) {
    assert.equal(day.tagName, 'div', '分组标题不是 button');
    assert.equal(day.classList.contains('fragment-item'), false);
    assert.equal(day.dataset.name, undefined);
    assert.equal(day._listeners.length, 0, '标题不挂点击');
  }
  // test-hooks 的 fragmentRowCount / clickFragmentRow 用同一个选择器，仍只数到 4 行
  assert.equal(globalThis.document.querySelectorAll('#fragments-list .fragment-item').length, 4);
});

test('日期分组：无日期 / 日期不在文件名开头 都归「更早」且连续只插一条；空态不插标题', async () => {
  const ctx = build({
    listResult: {
      total: 3,
      truncated: false,
      fragments: [
        makeFragment({ name: 'notes-2026-11-03.txt', date: '', seq: 0 }),
        makeFragment({ name: '随手记.txt', date: '', seq: 0 }),
        makeFragment({ name: '20261103-1.txt', date: '', seq: 0 })
      ]
    }
  });
  await ctx.ui.refreshFragments();
  const list = ctx.dom.map.get('fragments-list');
  assert.deepEqual(dayEls(list).map((el) => el.textContent), ['更早']);
  assert.equal(rowEls(list).length, 3);

  const empty = build({ listResult: { total: 0, truncated: false, fragments: [] } });
  await empty.ui.refreshFragments();
  const emptyList = empty.dom.map.get('fragments-list');
  assert.equal(dayEls(emptyList).length, 0, '空态只有一句话，不插分组标题');
  assert.equal(emptyList.children[0].className, 'fragment-empty');
  assert.equal(empty.dom.map.get('fragments-summary').textContent, '共 0 条碎片');
});

test('日期分组后点行仍选中正确那一条；高亮只落在 .fragment-item 上', async () => {
  const today = localDay(0);
  const ctx = build({
    listResult: {
      total: 3,
      truncated: false,
      fragments: [
        makeFragment({ name: `${today}-1.txt`, date: today, seq: 1 }),
        makeFragment({ name: '2019-12-31-1.txt', date: '2019-12-31', seq: 1 }),
        makeFragment({ name: '2019-12-31-2.txt', date: '2019-12-31', seq: 2 })
      ]
    }
  });
  const res = await ctx.ui.refreshFragments();
  assert.equal(res.ok, true);
  assert.equal(ctx.state.fragmentSelected.name, `${today}-1.txt`, '默认仍选中第一条');
  const list = ctx.dom.map.get('fragments-list');
  assert.deepEqual(dayEls(list).map((el) => el.textContent), ['今天', '12月31日']);
  const rows = rowEls(list);
  rows[2]._fire('click');
  await flush();
  assert.equal(ctx.state.fragmentSelected.name, '2019-12-31-2.txt', '第二组里的行照样点得中');
  assert.equal(rows[2].classList.contains('selected'), true);
  for (const day of dayEls(list)) assert.equal(day.classList.contains('selected'), false);
  for (const item of rowEls(list)) {
    if (item !== rows[2]) assert.equal(item.classList.contains('selected'), false);
  }
});

test('refreshFragments：读取中 / 失败清空 / 成功渲染并默认选中第一条', async () => {
  const ok = build({ listResult: { total: 2, truncated: false, fragments: [makeFragment({ name: 'x.txt' }), makeFragment({ name: 'y.txt' })] } });

  const res = await ok.ui.refreshFragments();
  assert.equal(res.ok, true);
  assert.equal(ok.state.fragments.length, 2);
  assert.equal(ok.state.fragmentSelected.name, 'x.txt', '默认选中第一条只读预览');
  assert.equal(ok.dom.map.get('btn-fragment-insert').disabled, false);

  const fail = build({ listError: 'EACCES' });
  fail.state.fragments = [makeFragment()];
  const failRes = await fail.ui.refreshFragments();
  assert.equal(failRes.ok, false);
  assert.equal(fail.dom.map.get('fragments-summary').textContent, '读取碎片失败：EACCES');
  assert.equal(fail.state.fragments.length, 0);
  assert.equal(fail.dom.map.get('btn-fragment-insert').disabled, true);
});

test('selectFragmentByName：不在列表 / 成功（2 万字预览上限 + 高亮选中 + 按钮可用）/ 读取失败', async () => {
  const missing = build();
  missing.state.fragments = [];
  assert.deepEqual(await missing.ui.selectFragmentByName('nope.txt'), { ok: false, message: '这条碎片已经不在列表里了' });

  const ctx = build({ readResult: { name: 'big.txt', text: 'x'.repeat(25000), chars: 25000, size: 25000 } });
  ctx.state.fragments = [makeFragment({ name: 'big.txt' })];
  const list = ctx.dom.map.get('fragments-list');
  const item = makeEl('button');
  item.className = 'fragment-item';
  item.dataset.name = 'big.txt';
  list.appendChild(item);
  const res = await ctx.ui.selectFragmentByName('big.txt');
  assert.equal(res.ok, true);
  assert.equal(ctx.dom.map.get('btn-fragment-insert').disabled, false);
  assert.match(ctx.dom.map.get('fragment-preview').textContent, /^x{20000}\n…（预览只显示前 20000 字，插入的是完整内容）$/);
  assert.equal(item.classList.contains('selected'), true);

  const fail = build({ readError: '文件没了' });
  fail.state.fragments = [makeFragment({ name: 'gone.txt' })];
  const failRes = await fail.ui.selectFragmentByName('gone.txt');
  assert.equal(failRes.ok, false);
  assert.equal(fail.dom.map.get('fragment-preview-name').textContent, '读取碎片失败');
  assert.equal(fail.dom.map.get('fragment-preview').textContent, '文件没了');
  assert.deepEqual(fail.calls.toast, [['读取碎片失败：文件没了', 'error']]);
});

test('insertSelectedFragment：没选碎片 / 没书早退；成功替换选区、触发输入处理并滚到光标；越界范围夹取', () => {
  const noSel = build();
  assert.deepEqual(noSel.ui.insertSelectedFragment(), { ok: false, message: '先选一条碎片' });

  const noBook = build();
  noBook.state.fragmentSelected = { name: 'a.txt', text: 'AAA', chars: 3 };
  noBook.state.bookPath = null;
  assert.deepEqual(noBook.ui.insertSelectedFragment(), { ok: false, message: '先打开一本书' });

  const ctx = build({ editorText: 'ABCDEF' });
  ctx.state.fragmentSelected = { name: 'a.txt', text: 'ZZ', chars: 2 };
  ctx.state.insertFragmentRange = { start: 2, end: 4 };
  const res = ctx.ui.insertSelectedFragment();
  assert.equal(res.ok, true);
  assert.equal(ctx.editorEl.value, 'ABZZEF');
  assert.equal(ctx.calls.onEditorInput, 1);
  assert.deepEqual(ctx.calls.scrollCaretIntoView, [4]);
  assert.equal(ctx.dom.map.get('fragments-backdrop').classList.contains('hidden'), true);
  assert.deepEqual(ctx.calls.toast, [['已插入碎片 a.txt（2 字）· 仍是未保存，Ctrl+S 写盘', undefined]]);

  const clamp = build({ editorText: 'XY' });
  clamp.state.fragmentSelected = { name: 'b.txt', text: 'Q', chars: 1 };
  clamp.state.insertFragmentRange = { start: 99, end: 120 };
  clamp.ui.insertSelectedFragment();
  assert.equal(clamp.editorEl.value, 'XYQ', '越界起点夹到正文末尾');
});

// ---------- 1.5.0 功能-3：碎片拖进正文 ----------
test('拖拽插入：行可拖（dataTransfer 只带名字）、面板让路、落在落点处插入且不写盘不删碎片', async () => {
  const ctx = build({ editorText: 'ABCDEF', selection: 3, selectionEnd: 3 });
  ctx.dom.doc.caretPositionFromPoint = () => ({ offsetNode: ctx.editorEl, offset: 2 });
  ctx.ui.setupFragmentsUi();
  assert.equal(ctx.ui.openInsertFragmentDialog(), true);
  await ctx.ui.refreshFragments();
  assert.equal(ctx.state.insertFragmentRange.start, 3, '打开面板时记下的光标是 3');

  const list = ctx.dom.map.get('fragments-list');
  const row = rowEls(list)[0];
  assert.equal(row.draggable, true, '碎片行可拖');
  assert.match(row.title, /拖进正文/, '行提示说明可拖');
  ctx.calls.api.length = 0;

  const dt = makeDataTransfer();
  row._fire('dragstart', { dataTransfer: dt });
  assert.equal(ctx.state.fragmentDragName, row.dataset.name);
  assert.deepEqual(dt.writes, [
    ['application/x-cw-fragment', row.dataset.name],
    ['text/plain', row.dataset.name]
  ]);
  assert.equal(dt.getData('text/plain'), row.dataset.name, 'dataTransfer 里只有碎片名，没有全文');
  assert.equal(ctx.dom.map.get('fragments-backdrop').classList.contains('drag-ghost'), true, '面板让路（透明 + 不拦指针）');

  // dragover 必须 preventDefault（否则浏览器不派发 drop），拖拽光标改成 copy
  const over = {
    dataTransfer: dt, clientX: 10, clientY: 20, prevented: 0,
    preventDefault() { over.prevented += 1; }, stopPropagation() {}
  };
  ctx.editorEl._fire('dragover', over);
  assert.equal(over.prevented, 1);
  assert.equal(dt.dropEffect, 'copy');

  // drop：落点 2（不是打开面板前记下的 3）
  const drop = {
    dataTransfer: dt, clientX: 10, clientY: 20, prevented: 0,
    preventDefault() { drop.prevented += 1; }, stopPropagation() {}
  };
  const result = await ctx.editorEl._fire('drop', drop);
  assert.equal(drop.prevented, 1);
  assert.equal(result.ok, true);
  assert.equal(result.start, 2);
  assert.equal(result.end, 2);
  assert.equal(ctx.editorEl.value, 'AB这是碎片正文CDEF');
  assert.equal(ctx.calls.onEditorInput, 1, '插入后走一次输入处理（标未保存 / 数字数）');
  assert.deepEqual(ctx.calls.scrollCaretIntoView, [2 + '这是碎片正文'.length]);
  assert.equal(ctx.dom.map.get('fragments-backdrop').classList.contains('hidden'), true, '插入成功后与点「插入」一致：面板关闭');
  assert.equal(ctx.dom.map.get('fragments-backdrop').classList.contains('drag-ghost'), false);
  assert.deepEqual(ctx.calls.api, [['read', row.dataset.name]], '只按名字读一次；不写盘');
  assert.equal(ctx.state.fragments.length, 1, '原碎片还在列表里');
  assert.equal(rowEls(list).length, 1, '列表行没被删掉');
  assert.match(ctx.calls.toast.at(-1)[0], /^已插入碎片 /);
});

test('拖拽落点：取不到落点时退回当前光标；外部文本拖拽不拦不插；碎片已不在列表则警告且不读', async () => {
  const ctx = build({ editorText: 'ABCDEF', selection: 4, selectionEnd: 4 });
  ctx.dom.doc.caretPositionFromPoint = () => null;
  // Chromium 的 caretRangeFromPoint 对 textarea 会回到 BODY：这里显式模拟「不是编辑区」
  ctx.dom.doc.caretRangeFromPoint = () => ({ startContainer: { nodeName: 'BODY' }, startOffset: 0 });
  ctx.ui.setupFragmentsUi();
  ctx.ui.openInsertFragmentDialog();
  await ctx.ui.refreshFragments();
  ctx.calls.api.length = 0;
  const row = rowEls(ctx.dom.map.get('fragments-list'))[0];
  const dt = makeDataTransfer();
  row._fire('dragstart', { dataTransfer: dt });
  const drop = {
    dataTransfer: dt, clientX: 1, clientY: 2, prevented: 0,
    preventDefault() { drop.prevented += 1; }, stopPropagation() {}
  };
  await ctx.editorEl._fire('drop', drop);
  assert.equal(ctx.editorEl.value, 'ABCD这是碎片正文EF', '取不到落点才退回当前光标 4');
  assert.deepEqual(ctx.calls.api, [['read', row.dataset.name]]);

  // 外部文本拖进编辑区：没有碎片拖拽状态 → 不 preventDefault、不读碎片、正文不动
  const foreign = build({ editorText: 'ABC', selection: 1, selectionEnd: 1 });
  foreign.dom.doc.caretPositionFromPoint = () => ({ offsetNode: foreign.editorEl, offset: 1 });
  foreign.ui.setupFragmentsUi();
  const foreignDt = makeDataTransfer();
  foreignDt.setData('text/plain', '外部文本');
  const ev = {
    dataTransfer: foreignDt, clientX: 5, clientY: 6, prevented: 0,
    preventDefault() { ev.prevented += 1; }, stopPropagation() {}
  };
  assert.equal(await foreign.editorEl._fire('drop', ev), null);
  assert.equal(ev.prevented, 0);
  assert.deepEqual(foreign.calls.api, []);
  assert.equal(foreign.editorEl.value, 'ABC');

  // 拖到一半碎片被删（列表里没了）：只警告，不读文件、不动正文
  const gone = build({ editorText: 'ABCDEF', selection: 2, selectionEnd: 2 });
  gone.dom.doc.caretPositionFromPoint = () => ({ offsetNode: gone.editorEl, offset: 2 });
  gone.ui.setupFragmentsUi();
  gone.ui.openInsertFragmentDialog();
  await gone.ui.refreshFragments();
  gone.calls.api.length = 0;
  const goneRow = rowEls(gone.dom.map.get('fragments-list'))[0];
  const goneDt = makeDataTransfer();
  goneRow._fire('dragstart', { dataTransfer: goneDt });
  gone.state.fragments = [];
  const goneDrop = {
    dataTransfer: goneDt, clientX: 3, clientY: 4, prevented: 0,
    preventDefault() { goneDrop.prevented += 1; }, stopPropagation() {}
  };
  const goneRes = await gone.editorEl._fire('drop', goneDrop);
  assert.equal(goneRes.ok, false);
  assert.match(goneRes.message, /不在列表里/);
  assert.deepEqual(gone.calls.api, [], '不读文件、不写盘');
  assert.equal(gone.editorEl.value, 'ABCDEF');
  assert.deepEqual(gone.calls.toast.at(-1), ['这条碎片已经不在列表里了', 'warn']);
});

test('拖拽结束没落在正文：面板恢复可点（ghost 摘掉、面板仍开着），正文不动', async () => {
  const ctx = build({ editorText: 'ABCDEF', selection: 2, selectionEnd: 2 });
  ctx.ui.setupFragmentsUi();
  ctx.ui.openInsertFragmentDialog();
  await ctx.ui.refreshFragments();
  const row = rowEls(ctx.dom.map.get('fragments-list'))[0];
  const backdrop = ctx.dom.map.get('fragments-backdrop');
  ctx.calls.api.length = 0;
  row._fire('dragstart', { dataTransfer: makeDataTransfer() });
  assert.equal(backdrop.classList.contains('drag-ghost'), true);
  row._fire('dragend', {});
  assert.equal(backdrop.classList.contains('drag-ghost'), false, '没落点时面板回到原样');
  assert.equal(backdrop.classList.contains('hidden'), false, '面板还开着，可以继续点「插入到光标处」');
  assert.equal(ctx.state.fragmentDragName, null);
  assert.equal(ctx.editorEl.value, 'ABCDEF');
  assert.deepEqual(ctx.calls.api, [], '取消拖拽不读盘、不写盘');
});

// ---------- 事件绑定 ----------
test('setupFragmentsUi：8 个绑定全部注册；Ctrl+Enter 保存、按钮收起 / 刷新走真实函数', async () => {
  const ctx = build();
  ctx.ui.setupFragmentsUi();
  const ids = ['btn-add-fragment', 'btn-fragment-cancel', 'btn-fragment-save', 'fragment-text', 'btn-insert-fragment',
    'btn-fragments-close', 'btn-fragment-insert', 'btn-fragments-refresh'];
  for (const id of ids) assert.equal(ctx.dom.map.get(id)._listeners.length >= 1, true, id);
  assert.deepEqual(ctx.dom.map.get('fragment-text')._listeners.map((l) => l.type), ['input', 'keydown']);
  // 1.5.0 功能-3：拖拽插入的两个绑定挂在编辑区（不是 document / window）
  assert.deepEqual(ctx.editorEl._listeners.map((l) => l.type), ['dragover', 'drop']);

  // ＋碎片 → 打开弹层
  ctx.dom.map.get('btn-add-fragment')._fire('click');
  assert.equal(ctx.dom.map.get('fragment-backdrop').classList.contains('hidden'), false);
  // Ctrl+Enter 保存（正文空 → 只写错误态，不发 IPC）
  ctx.dom.map.get('fragment-text')._fire('keydown', { ctrlKey: true, metaKey: false, key: 'Enter', preventDefault() {} });
  await flush();
  assert.equal(ctx.calls.api.filter((c) => c[0] === 'create').length, 0);

  // 取消 → 收起
  ctx.dom.map.get('btn-fragment-cancel')._fire('click');
  assert.equal(ctx.dom.map.get('fragment-backdrop').classList.contains('hidden'), true);

  // 插入面板刷新 → 调 listFragments
  ctx.dom.map.get('btn-fragments-refresh')._fire('click');
  await flush();
  assert.equal(ctx.calls.api.some((c) => c[0] === 'list'), true);
});

// ---------- 静态闸门 ----------
test('静态闸门：renderer.js 不再内嵌灵感箱实现，只剩装配与转发', () => {
  for (const shape of [
    'function updateFragmentCounter(',
    'function openFragmentDialog(',
    'function closeFragmentDialog(',
    'async function saveFragment(',
    'function openInsertFragmentDialog(',
    'function closeInsertFragmentDialog(',
    'function highlightSelectedFragment(',
    'function renderFragments(',
    'async function refreshFragments(',
    'async function selectFragmentByName(',
    'function insertSelectedFragment('
  ]) {
    assert.equal(rendererSrc.includes(shape), false, 'renderer.js 里还有第二份：' + shape);
  }
  assert.equal(rendererSrc.split('fragmentsUiModule.create(').length - 1, 1, '装配只许一处');
  assert.ok(rendererSrc.includes('const fragmentsUiModule = window.CWFragmentsUi;'));
  for (const line of [
    '    $, state, api, call, toast,',
    '    common: { chaptersLib, formatRelativeTime, formatCount },',
    '    editor: { editorEl, onEditorInput, scrollCaretIntoView },',
    '    hideHeaderMenus'
  ]) {
    assert.ok(rendererSrc.includes(line), '装配少了：' + line);
  }
  assert.ok(rendererSrc.includes(
    'const { updateFragmentCounter, openFragmentDialog, closeFragmentDialog, saveFragment, openInsertFragmentDialog, closeInsertFragmentDialog, insertSelectedFragment, selectFragmentByName, refreshFragments, setupFragmentsUi } = fragmentsUi;'
  ), '10 个入口按原名解构');
  for (const id of ['btn-add-fragment', 'btn-fragment-cancel', 'btn-fragment-save', 'fragment-text', 'btn-insert-fragment', 'btn-fragments-close', 'btn-fragment-insert', 'btn-fragments-refresh']) {
    assert.equal(rendererSrc.includes(`$('${id}').addEventListener`), false, '绑定应该只在模块里：' + id);
  }
  assert.equal(rendererSrc.split('fragmentsUi.setupFragmentsUi();').length - 1, 1, 'setup 只调一次');
  // Esc 动作表仍按名字取
  assert.match(rendererSrc, /'close-fragment': \(\) => closeFragmentDialog\(\),/);
  assert.match(rendererSrc, /'close-insert-fragment': \(\) => closeInsertFragmentDialog\(\),/);
  for (const key of ['closeFragmentDialog', 'closeInsertFragmentDialog', 'insertSelectedFragment', 'openFragmentDialog', 'openInsertFragmentDialog', 'refreshFragments', 'saveFragment', 'updateFragmentCounter']) {
    assert.match(rendererSrc, new RegExp('^      ' + key + ',$', 'm'), 'testHooksScope 少了 ' + key);
  }
});

test('静态闸门：index.html 在 renderer.js 之前加载 fragments-ui.js，且只加载一次', () => {
  const at = indexSrc.indexOf('<script src="fragments-ui.js"></script>');
  const rendererAt = indexSrc.indexOf('<script src="renderer.js"></script>');
  assert.notEqual(at, -1);
  assert.ok(at < rendererAt);
  assert.equal(indexSrc.split('fragments-ui.js').length - 1, 1);
});

test('静态闸门：模块不 require / 不摸 Electron·fs / 不注册全局监听；只用 1 个聚焦定时器', () => {
  for (const forbidden of ['require(', 'ipcRenderer', 'node:fs', 'child_process', 'localStorage', 'fetch(', 'window.', 'process.']) {
    assert.equal(moduleCode.includes(forbidden), false, 'fragments-ui.js 不许出现 ' + forbidden);
  }
  assert.equal(/window\.addEventListener|document\.addEventListener/.test(moduleCode), false);
  assert.equal((moduleCode.match(/setTimeout\(/g) || []).length, 1, '只有打开弹层后的 30ms 聚焦');
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWFragmentsUi，且不乱造别的全局', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(moduleSrc, context, { filename: 'renderer/fragments-ui.js' });
  assert.equal(typeof win.CWFragmentsUi, 'object');
  assert.deepEqual(Object.keys(win.CWFragmentsUi).sort(), ['REQUIRED_HOST', 'create']);
  assert.equal(win.CWFragmentsUi.REQUIRED_HOST.length, 8);
  assert.equal(win.CWFindBookmarkUi, undefined);
});
