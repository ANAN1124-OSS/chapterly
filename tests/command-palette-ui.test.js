/* 1.4.0 P0-3：命令面板的 DOM / 键盘（renderer/command-palette-ui.js）。
 *
 * 这里用一份极简假 DOM（只实现面板用到的那几个方法）钉住：
 *   · 打开 → 焦点进输入框、列表画出来（组标题只在组变化时画一次、行尾带键帽）；
 *   · ↑↓ / Home / End 移 active 项并同步 aria-activedescendant + aria-selected；
 *   · Enter 执行（先 recordUse 再收起，顺序不能反：收起会清 rows）；
 *   · Esc 收起并回调 onClose（把打开它的元素交回去）；
 *   · 输入过滤与空结果文案；
 *   · 契约缺成员直接抛 TypeError。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const paletteModule = require('../renderer/command-palette-ui');
const registryModule = require('../renderer/command-registry');

// ---------- 极简假 DOM ----------
function makeEl(tag, doc) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    parentNode: null,
    className: '',
    id: '',
    type: '',
    value: '',
    dataset: {},
    attrs: {},
    _listeners: [],
    classList: {
      _set: new Set(),
      add(name) { this._set.add(name); },
      remove(name) { this._set.delete(name); },
      contains(name) { return this._set.has(name); },
      toggle(name, force) {
        const on = force === undefined ? !this._set.has(name) : Boolean(force);
        if (on) this._set.add(name); else this._set.delete(name);
        return on;
      }
    },
    setAttribute(name, value) { el.attrs[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(el.attrs, name) ? el.attrs[name] : null; },
    removeAttribute(name) { delete el.attrs[name]; },
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    remove() {
      if (!el.parentNode) return;
      const at = el.parentNode.children.indexOf(el);
      if (at >= 0) el.parentNode.children.splice(at, 1);
      el.parentNode = null;
    },
    addEventListener(type, fn) { el._listeners.push({ type, fn }); },
    removeEventListener() { /* 面板不摘监听 */ },
    focus() { if (doc) doc.activeElement = el; },
    scrollIntoView() { /* 假 DOM 不滚动 */ },
    querySelector(selector) { return queryAll(el, selector)[0] || null; },
    querySelectorAll(selector) { return queryAll(el, selector); },
    closest(selector) { return closest(el, selector); }
  };
  // textContent：赋值即替换（赋空串要清掉子节点——面板每次重画就先 list.textContent = ''）
  let text = '';
  Object.defineProperty(el, 'textContent', {
    get() { return text; },
    set(value) {
      text = String(value);
      if (text === '') el.children.length = 0;
    },
    enumerable: true,
    configurable: true
  });
  return el;
}

function walk(node, out = []) {
  for (const child of node.children) {
    out.push(child);
    walk(child, out);
  }
  return out;
}

function matches(el, selector) {
  if (selector === '.command-row') return el.className.split(/\s+/).includes('command-row');
  if (selector.startsWith('#')) return el.id === selector.slice(1);
  return false;
}

function queryAll(root, selector) {
  return walk(root).filter((el) => matches(el, selector));
}

function closest(el, selector) {
  let node = el;
  while (node) {
    if (matches(node, selector)) return node;
    node = node.parentNode;
  }
  return null;
}

function makeDocument() {
  const doc = {
    activeElement: null,
    map: new Map(),
    createElement(tag) {
      const el = makeEl(tag, doc);
      return el;
    },
    _fire(el, type, event) {
      for (const listener of el._listeners.slice()) {
        if (listener.type === type) listener.fn(event || { key: '', target: el });
      }
    }
  };
  return doc;
}

const ITEMS = [
  { id: 'cmd:save', title: '保存本章', group: 'command', kbd: 'Ctrl+S', keywords: ['save'], run: () => {} },
  { id: 'cmd:find', title: '查找替换', group: 'command', kbd: 'Ctrl+F', keywords: ['find'], run: () => {} },
  { id: 'chapter:1', title: '第1章：起风', group: 'chapter', hint: '当前章', keywords: ['起风'], run: () => {} },
  { id: 'book:1', title: '打开《星海旅人》', group: 'book', hint: '3 章', keywords: ['星海旅人'], run: () => {} }
];

function build(overrides = {}) {
  const doc = makeDocument();
  const ids = ['command-backdrop', 'command-input', 'command-list', 'command-empty'];
  for (const id of ids) {
    const el = makeEl(id === 'command-input' ? 'input' : 'div', doc);
    el.id = id;
    if (id !== 'command-input') el.classList.add('hidden');
    doc.map.set(id, el);
  }
  const $ = (id) => doc.map.get(id) || null;
  const ran = [];
  const closed = [];
  const registry = registryModule.createRegistry({});
  const host = {
    $,
    doc,
    registry,
    items: () => ITEMS.map((item) => ({ ...item, run: () => ran.push(item.id) })),
    onRun: (item) => { item.run(); },
    onClose: (opener) => closed.push(opener),
    ...overrides
  };
  const ui = paletteModule.create(host);
  return { ui, doc, host, ran, closed, registry, $ };
}

test('契约：host 五个成员缺一个就抛 TypeError', () => {
  assert.deepEqual([...paletteModule.REQUIRED_HOST].sort(), ['$', 'items', 'onClose', 'onRun', 'registry']);
  for (const key of paletteModule.REQUIRED_HOST) {
    const { ui, host } = build();
    void ui;
    const broken = { ...host };
    delete broken[key];
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.throws(() => paletteModule.create(broken), new RegExp('host 缺少 ' + escaped));
  }
});

test('打开：焦点进输入框、列表按组画出、行尾带键帽、空结果元素藏起来', () => {
  const { ui, doc, $ } = build();
  const opener = makeEl('button', doc);
  ui.open(opener);
  assert.equal(ui.isOpen(), true);
  assert.equal(doc.activeElement, $('command-input'), '焦点进输入框');
  const rows = $('command-list').querySelectorAll('.command-row');
  assert.equal(rows.length, ITEMS.length);
  assert.deepEqual(rows.map((row) => row.dataset.commandId), ITEMS.map((item) => item.id));
  const groups = walk($('command-list')).filter((el) => el.className === 'command-group');
  assert.equal(groups.length, 3, '组标题只在组变化时画一次（命令 / 章节 / 书）');
  const kbds = rows.map((row) => (row.children.find((child) => child.className.includes('command-kbd')) || {}).textContent);
  assert.deepEqual(kbds, ['Ctrl+S', 'Ctrl+F', undefined, undefined], '有键位的行才出键帽');
  assert.equal($('command-empty').classList.contains('hidden'), true);
});

test('↑↓ / Home / End：active 项跟着走，aria-activedescendant 与 aria-selected 同步', () => {
  const { ui, $ } = build();
  ui.open(null);
  const input = $('command-input');
  const key = (value, extra = {}) => ({ key: value, preventDefault() {}, ...extra });
  assert.equal(input.getAttribute('aria-activedescendant'), 'command-option-0');
  ui.setActive(2);
  assert.equal(ui.activeItem().id, ITEMS[2].id);
  assert.equal(input.getAttribute('aria-activedescendant'), 'command-option-2');
  const rows = () => $('command-list').querySelectorAll('.command-row');
  assert.equal(rows()[2].getAttribute('aria-selected'), 'true');
  assert.equal(rows()[0].getAttribute('aria-selected'), 'false');
  // 上下到头不越界
  ui.setActive(-5);
  assert.equal(ui.activeItem().id, ITEMS[0].id);
  ui.setActive(99);
  assert.equal(ui.activeItem().id, ITEMS[ITEMS.length - 1].id);
  // setup 幂等：只挂一次监听
  assert.equal(ui.setup(), true);
  assert.equal(ui.setup(), false);
  void key;
});

test('输入过滤：跨组命中、空结果给文案、清空后回到全量', () => {
  const { ui, $ } = build();
  ui.open(null);
  ui.setup();
  const input = $('command-input');
  input.value = '星海';
  input._listeners.filter((l) => l.type === 'input').forEach((l) => l.fn({ target: input }));
  const rows = $('command-list').querySelectorAll('.command-row');
  assert.deepEqual(rows.map((row) => row.dataset.commandId), ['book:1'], '书名命中（跨组）');
  input.value = '不存在的东西';
  input._listeners.filter((l) => l.type === 'input').forEach((l) => l.fn({ target: input }));
  assert.equal($('command-list').querySelectorAll('.command-row').length, 0);
  assert.equal($('command-empty').classList.contains('hidden'), false);
  assert.match($('command-empty').textContent, /没有匹配/);
  input.value = '';
  input._listeners.filter((l) => l.type === 'input').forEach((l) => l.fn({ target: input }));
  assert.equal($('command-list').querySelectorAll('.command-row').length, ITEMS.length);
});

test('Enter 执行：先记最近使用、再收起、再跑（顺序反了会拿不到条目）', () => {
  const { ui, $, ran, registry, closed } = build();
  ui.open(null);
  ui.setup();
  ui.setActive(1);
  const input = $('command-input');
  let prevented = 0;
  const event = { key: 'Enter', preventDefault() { prevented += 1; } };
  input._listeners.filter((l) => l.type === 'keydown').forEach((l) => l.fn(event));
  assert.equal(prevented, 1, 'Enter 要 preventDefault');
  assert.deepEqual(ran, ['cmd:find']);
  assert.deepEqual(registry.recentIds(), ['cmd:find'], '执行过就记进最近使用');
  assert.equal(ui.isOpen(), false, '执行完收起');
  assert.equal(closed.length, 1);
});

test('Esc 收起并把打开它的元素交回 onClose；Ctrl+K 再按一次也收起且不外泄', () => {
  const { ui, $, closed } = build();
  const opener = makeEl('button', $('command-backdrop'));
  ui.open(opener);
  ui.setup();
  const input = $('command-input');
  const esc = { key: 'Escape', preventDefault() {} };
  input._listeners.filter((l) => l.type === 'keydown').forEach((l) => l.fn(esc));
  assert.equal(ui.isOpen(), false);
  assert.equal(closed[0], opener, 'onClose 拿到打开它的元素');

  const again = build();
  again.ui.open(null);
  again.ui.setup();
  const second = again.$('command-input');
  let stopped = 0;
  const ctrlK = { key: 'k', ctrlKey: true, preventDefault() {}, stopPropagation() { stopped += 1; } };
  second._listeners.filter((l) => l.type === 'keydown').forEach((l) => l.fn(ctrlK));
  assert.equal(again.ui.isOpen(), false, 'Ctrl+K 收起');
  assert.equal(stopped, 1, '必须 stopPropagation，否则冒泡到 document 又立刻打开');
});

test('点一行就执行（点遮罩空白处收起）', () => {
  const { ui, $, ran } = build();
  ui.open(null);
  ui.setup();
  const rows = $('command-list').querySelectorAll('.command-row');
  const target = rows[2];
  $('command-list')._listeners.filter((l) => l.type === 'click').forEach((l) => l.fn({ target }));
  assert.deepEqual(ran, ['chapter:1']);
  assert.equal(ui.isOpen(), false);

  const second = build();
  second.ui.open(null);
  second.ui.setup();
  second.$('command-backdrop')._listeners.filter((l) => l.type === 'click').forEach((l) => l.fn({ target: second.$('command-backdrop') }));
  assert.equal(second.ui.isOpen(), false, '点遮罩空白处收起');
});

test('静态：面板不写盘、不发 IPC、不新增全局监听；只读 registry 的结果', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'command-palette-ui.js'), 'utf8');
  for (const forbidden of ["require('node:fs')", "require('electron')", 'ipcRenderer', 'fetch(', 'localStorage']) {
    assert.equal(source.includes(forbidden), false, `命令面板不许碰 ${forbidden}`);
  }
  assert.equal(source.includes('window.addEventListener'), false, '面板不新增全局监听（Ctrl+K 在渲染层）');
});
// ---------- 1.5.0 P0-6 / 审计 O-1：条目快照 ----------
// 面板打开时取一次条目；输入过滤只在这份数组上跑（不再每敲一个字重建上千条对象）；
// 渲染层发现数据变了就调 invalidateItems()，下一次重画再取；关闭 / 再打开重新取。

test('条目快照：打开取一次，输入不重建；invalidateItems 后重画才再取；每次打开重新取', () => {
  let calls = 0;
  const { ui, $ } = build({
    items: () => {
      calls += 1;
      return ITEMS.map((item) => ({ ...item, run: () => {} }));
    }
  });
  const input = $('command-input');
  const type = (value) => {
    input.value = value;
    input._listeners.filter((l) => l.type === 'input').forEach((l) => l.fn({ target: input }));
  };
  ui.open(null);
  ui.setup();
  assert.equal(calls, 1, '打开时取一次');
  type('保');
  type('保存');
  type('');
  assert.equal(calls, 1, '连续输入不再重建条目');
  assert.equal($('command-list').querySelectorAll('.command-row').length, ITEMS.length, '过滤结果照旧');
  assert.equal(ui.invalidateItems(), true);
  type('星海');
  assert.equal(calls, 2, '数据变了：下一次重画再取一次');
  assert.deepEqual(
    $('command-list').querySelectorAll('.command-row').map((row) => row.dataset.commandId),
    ['book:1'],
    '取到新快照后过滤仍正确'
  );
  ui.close();
  ui.open(null);
  assert.equal(calls, 3, '每次打开都取一份新快照');
});
