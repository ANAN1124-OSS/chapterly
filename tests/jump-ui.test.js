const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const jumpUi = require('../renderer/jump-ui');
const { loadSourceGate, restoreGlobalsAfter } = require('./ui-test-preambles');

// v0.9 B-5 第二刀：「Ctrl+G 跳章」整段（原 renderer.js 4225–4371 行，147 行）搬到 renderer/jump-ui.js。
// 搬之前这一域只有 E2E 里十来条「按 Ctrl+G → 输章号 → 看汇总 / 结果行 / 点一条」的黑盒覆盖；
// 打开 / 关闭 / 防抖 / 旧响应作废 / 失败提示这些分支在 Node 里一步都测不到。搬出来以后用
// 「假 host + 假 DOM」逐条钉住文案与状态，再用静态闸门保证渲染层不许长回第二份实现。

// 模块运行时会摸 document：真身由共享前导存下，test.after 放回。
restoreGlobalsAfter(test, ['document']);

const { rendererSrc, indexSrc, moduleSrc, moduleCode } = loadSourceGate('jump-ui.js');

function makeEl(id) {
  const classes = new Set();
  const listeners = [];
  const el = {
    id,
    tagName: '',
    type: '',
    className: '',
    textContent: '',
    value: '',
    disabled: false,
    dataset: {},
    children: [],
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      toggle(name, on) {
        const next = on === undefined ? !classes.has(name) : Boolean(on);
        if (next) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name)
    },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    focus() { this.focused = true; },
    select() { this.selected = true; },
    _classes: classes,
    _listeners: listeners
  };
  // 代码里靠 `list.innerHTML = ''` 清列表；假 DOM 也要真的清，否则第二次渲染会数错行
  let innerHTML = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return innerHTML; },
    set(value) {
      innerHTML = value;
      if (value === '') el.children = [];
    },
    enumerable: true
  });
  return el;
}

// 模块运行时摸 document（createElement），Node 里给一个最小替身。
function installDocument() {
  const created = [];
  globalThis.document = {
    createElement(tag) {
      const el = makeEl(tag);
      el.tagName = String(tag).toUpperCase();
      created.push(el);
      return el;
    }
  };
  return created;
}

const STATUS_LABELS = { draft: '草稿', revising: '待修', done: '完稿' };

function makeHost(options = {}) {
  const els = new Map();
  const calls = [];
  const state = {
    bookPath: options.bookPath === undefined ? 'C:/tmp/books/测试书' : options.bookPath,
    chapters: options.chapters || [
      { id: 'c1', name: '第一章', status: 'draft' },
      { id: 'c2', name: '第二章', status: 'done' }
    ],
    jumpQuery: '',
    jumpMatches: [],
    jumpOutOfRange: false,
    jumpToken: 0,
    jumpTimer: null
  };
  const switches = [];
  const host = {
    api: { jumpMatch: 'book:jump-match' },
    $: (id) => {
      if (!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
    state,
    chapterTitle: (index, name) => `第${index + 1}章：${name}`,
    chaptersLib: {
      chapterNumber: (meta, index) => (meta && meta.chapterNumbering === 'volume' ? index + 1 : index + 1)
    },
    CHAPTER_STATUS_LABELS: STATUS_LABELS,
    chapterStatus: (chapter) => (chapter && chapter.status) || 'draft',
    async switchChapter(index) {
      switches.push(index);
      return { ok: true, index };
    },
    async call(channel, ...rest) {
      calls.push({ channel, rest });
      const handler = options.onCall ? options.onCall(channel, rest) : undefined;
      if (handler instanceof Error) throw handler;
      if (handler !== undefined) return handler;
      return { matches: [], total: 0 };
    }
  };
  return { host, state, els, calls, switches };
}

test('host 契约：8 个成员缺任何一个都抛 TypeError，空 host / null 也抛', () => {
  const { host } = makeHost();
  assert.deepEqual([...jumpUi.REQUIRED_HOST].sort(), [
    '$', 'CHAPTER_STATUS_LABELS', 'api', 'call', 'chapterStatus', 'chapterTitle', 'chaptersLib', 'state', 'switchChapter'
  ].sort());
  assert.throws(() => jumpUi.create(null), /createJumpUi 需要 host 对象/);
  assert.throws(() => jumpUi.create('x'), /createJumpUi 需要 host 对象/);
  for (const key of jumpUi.REQUIRED_HOST) {
    const broken = { ...host };
    delete broken[key];
    assert.throws(() => jumpUi.create(broken), new RegExp('createJumpUi 的 host 缺少 ' + key.replace('$', '\\$').replace('CHAPTER', 'CHAPTER')));
  }
  // null 也算缺（不是「用假值兜底」）
  const nulled = { ...host, call: null };
  assert.throws(() => jumpUi.create(nulled), /createJumpUi 的 host 缺少 call/);
});

test('create() 只建表：没有 document 也能创建，9 个成员都在', () => {
  const { host } = makeHost();
  delete globalThis.document;
  const ui = jumpUi.create(host);
  assert.deepEqual(Object.keys(ui).sort(), [
    'closeJumpDialog', 'confirmJumpFromDialog', 'jumpChapterPayload', 'jumpToIndex',
    'openJumpDialog', 'refreshJumpMatches', 'renderJumpMatches', 'scheduleJumpMatches'
  ].sort());
  for (const name of Object.keys(ui)) assert.equal(typeof ui[name], 'function', name);
});

test('jumpChapterPayload：章名清洗（null → 空串、数字转字符串），空书目给空数组', () => {
  const empty = makeHost({ chapters: [] });
  assert.deepEqual(jumpUi.create(empty.host).jumpChapterPayload(), []);

  const dirty = makeHost({ chapters: [{ id: 'a', name: null }, { id: 'b', name: 12 }, { id: 'c' }] });
  assert.deepEqual(jumpUi.create(dirty.host).jumpChapterPayload(), [
    { id: 'a', name: '', number: 1, volumeName: '' },
    { id: 'b', name: '12', number: 2, volumeName: '' },
    { id: 'c', name: '', number: 3, volumeName: '' }
  ]);
  // chapters 不是数组（旧状态）也不炸
  const broken = makeHost();
  broken.state.chapters = null;
  assert.deepEqual(jumpUi.create(broken.host).jumpChapterPayload(), []);
});

test('renderJumpMatches：五种汇总文案逐字写死 + warn / 确认按钮状态', () => {
  installDocument();
  const { host, els, state } = makeHost();
  const ui = jumpUi.create(host);
  const summary = els.get('jump-summary') || host.$('jump-summary');
  const list = host.$('jump-results');
  const confirm = host.$('btn-jump-confirm');

  // ① 还没输入：说清楚能输什么
  state.jumpQuery = '';
  ui.renderJumpMatches({ matches: [], total: 0 });
  assert.equal(summary.textContent, '共 2 章。输入章号（如 12、第12章）或章名的一部分；回车跳转。');
  assert.equal(summary.classList.contains('warn'), false);
  assert.equal(confirm.disabled, true);

  // ② 输了章号但超出本书章数
  state.jumpQuery = '9';
  state.jumpOutOfRange = true;
  ui.renderJumpMatches({ matches: [], number: 9 });
  assert.equal(summary.textContent, '本书共 2 章，没有第 9 章（可输入 1–2）。');
  assert.equal(summary.classList.contains('warn'), true);
  assert.equal(confirm.disabled, true);

  // ③ 章号解析不出来（number 缺失）时用 ? 占位，不写 undefined
  ui.renderJumpMatches({ matches: [], number: null });
  assert.equal(summary.textContent, '本书共 2 章，没有第 ? 章（可输入 1–2）。');

  // ④ 按章名关键词没有命中
  state.jumpOutOfRange = false;
  state.jumpQuery = '远方';
  ui.renderJumpMatches({ matches: [], total: 0 });
  assert.equal(summary.textContent, '没有匹配「远方」的章节。');
  assert.equal(summary.classList.contains('warn'), true);

  // ⑤ 按章号命中：直接说跳到哪一章
  state.jumpQuery = '2';
  state.jumpOutOfRange = false;
  ui.renderJumpMatches({ matches: [{ index: 1, name: '第二章' }], number: 2 });
  assert.equal(summary.textContent, '按章号跳转：第2章：第二章');
  assert.equal(summary.classList.contains('warn'), false);
  assert.equal(confirm.disabled, false);

  // ⑥ 关键词命中多条：总数 + 只列前几条
  ui.renderJumpMatches({ matches: [{ index: 0, name: '第一章' }, { index: 1, name: '第二章' }], total: 3 });
  assert.equal(summary.textContent, '找到 3 章匹配（列出前 2 章）；回车跳第一条，也可以点下面任意一条。');
  // 全部列出时不写「列出前 N 章」
  ui.renderJumpMatches({ matches: [{ index: 0, name: '第一章' }, { index: 1, name: '第二章' }], total: 2 });
  assert.equal(summary.textContent, '找到 2 章匹配；回车跳第一条，也可以点下面任意一条。');
});

test('renderJumpMatches：结果行是 button.jump-result，两段文字 + 状态标签，点一条就跳过去', async () => {
  const created = installDocument();
  const { host, els, switches } = makeHost();
  const ui = jumpUi.create(host);
  host.$('jump-results');

  ui.renderJumpMatches({ matches: [{ index: 1, name: '第二章' }], total: 1 });
  assert.equal(created.length, 3, '一条结果 = button + 两个 span');
  const row = created[0];
  assert.equal(row.tagName, 'BUTTON');
  assert.equal(row.type, 'button');
  assert.equal(row.className, 'jump-result');
  assert.equal(row.dataset.index, '1');
  assert.equal(row.children.length, 2);
  assert.equal(row.children[0].className, 'jump-chapter');
  assert.equal(row.children[0].textContent, '第2章：第二章');
  assert.equal(row.children[1].className, 'jump-status');
  assert.equal(row.children[1].textContent, '完稿');
  // 未知状态不写 undefined，留空
  assert.equal(row.children[1].textContent.length > 0, true);
  assert.equal(host.$('jump-results').children.length, 1);

  // 点这一行 → jumpToIndex(index) → 先关对话框再走 switchChapter
  assert.equal(row._listeners.length, 1);
  assert.equal(row._listeners[0].type, 'click');
  row._listeners[0].fn();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(switches, [1]);
  assert.equal(host.$('jump-backdrop')._classes.has('hidden'), true);

  // 未知章节下标（state.chapters 里没有）→ 跳过这一行，不建 DOM
  const created2 = installDocument();
  const second = makeHost({ chapters: [{ id: 'c1', name: '第一章' }] });
  jumpUi.create(second.host).renderJumpMatches({ matches: [{ index: 5, name: '第五章' }], total: 1 });
  assert.equal(created2.length, 0);
});

test('refreshJumpMatches：没书 / 没章一个 IPC 都不打；空查询清空并渲染「共 N 章」', async () => {
  const noBook = makeHost({ bookPath: null });
  const ui = jumpUi.create(noBook.host);
  await ui.refreshJumpMatches();
  assert.deepEqual(noBook.calls, []);

  const noChapters = makeHost({ chapters: [] });
  await jumpUi.create(noChapters.host).refreshJumpMatches();
  assert.deepEqual(noChapters.calls, []);

  installDocument();
  const { host, calls, state } = makeHost();
  const ui2 = jumpUi.create(host);
  host.$('jump-input').value = '   ';
  await ui2.refreshJumpMatches();
  assert.deepEqual(calls, []);
  assert.deepEqual(state.jumpMatches, []);
  assert.equal(state.jumpOutOfRange, false);
  assert.equal(host.$('jump-summary').textContent, '共 2 章。输入章号（如 12、第12章）或章名的一部分；回车跳转。');
  assert.equal(state.jumpQuery, '   ', '输入框原样记下（不清洗），和改前一致');
});

test('refreshJumpMatches：命中写 state 并渲染；旧令牌的迟到结果被丢掉；失败提示逐字写死', async () => {
  installDocument();
  const pending = [];
  const { host, calls, state } = makeHost({
    onCall: () => new Promise((resolve) => { pending.push(resolve); })
  });
  const ui = jumpUi.create(host);
  host.$('jump-input').value = '第一章';

  const first = ui.refreshJumpMatches();
  // 第二次输入（令牌 +1），第一次的结果随后才到
  host.$('jump-input').value = '第二章';
  const second = ui.refreshJumpMatches();
  assert.equal(state.jumpToken, 2);
  assert.deepEqual(calls[0], {
    channel: 'book:jump-match',
    rest: [
      ['第一章', '第二章'].map((name, i) => ({ id: `c${i + 1}`, name, number: i + 1, volumeName: '' })),
      '第一章',
      { limit: 8, numbering: 'continuous' }
    ]
  });
  pending[0]({ matches: [{ index: 0, name: '第一章' }], total: 1 });
  await first;
  assert.deepEqual(state.jumpMatches, [], '第一次的迟到结果必须被丢掉');
  pending[1]({ matches: [{ index: 1, name: '第二章' }], total: 1, number: 2 });
  await second;
  assert.deepEqual(state.jumpMatches, [{ index: 1, name: '第二章' }]);
  assert.equal(host.$('jump-summary').textContent, '按章号跳转：第2章：第二章');

  // 失败：清列表 + 禁用确认 + warn 提示（文案带 err.message）
  const failing = makeHost({ onCall: () => new Error('IPC 断了') });
  const ui2 = jumpUi.create(failing.host);
  failing.host.$('jump-input').value = '第一章';
  await ui2.refreshJumpMatches();
  assert.deepEqual(failing.state.jumpMatches, []);
  assert.equal(failing.state.jumpOutOfRange, false);
  assert.equal(failing.host.$('jump-summary').textContent, '查找章节失败：IPC 断了');
  assert.equal(failing.host.$('jump-summary').classList.contains('warn'), true);
  assert.equal(failing.host.$('jump-results').innerHTML, '');
  assert.equal(failing.host.$('btn-jump-confirm').disabled, true);

  // 失败时也看令牌：迟到的错误不许盖掉新结果
  const slow = [];
  const racing = makeHost({ onCall: () => new Promise((resolve, reject) => { slow.push({ resolve, reject }); }) });
  const ui3 = jumpUi.create(racing.host);
  racing.host.$('jump-input').value = '甲';
  const a = ui3.refreshJumpMatches();
  racing.host.$('jump-input').value = '乙';
  ui3.refreshJumpMatches();
  slow[0].reject(new Error('旧请求失败'));
  await a;
  assert.equal(racing.host.$('jump-summary').textContent, '', '旧请求的错误不许写进界面');
});

test('scheduleJumpMatches：80ms 防抖只跑最后一次；closeJumpDialog 取消待跑的定时器', async () => {
  installDocument();
  const { host, calls } = makeHost({ onCall: () => ({ matches: [], total: 0 }) });
  const ui = jumpUi.create(host);
  host.$('jump-input').value = '第';
  ui.scheduleJumpMatches(5);
  ui.scheduleJumpMatches(5);
  ui.scheduleJumpMatches(5);
  assert.equal(calls.length, 0, '防抖窗口内不该打 IPC');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls.length, 1, '三次输入只查最后一次');
  assert.equal(host.state.jumpTimer, null, '跑完把定时器清成 null');

  ui.scheduleJumpMatches(5);
  ui.closeJumpDialog();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls.length, 1, '关掉对话框以后待跑的防抖要被取消');
});

test('openJumpDialog：没书直接 false 不动 DOM；有书重置状态、清输入、显示遮罩、20ms 后聚焦选中', async () => {
  const noBook = makeHost({ bookPath: null });
  const ui = jumpUi.create(noBook.host);
  assert.equal(ui.openJumpDialog(), false);
  assert.equal(noBook.els.size, 0, '没书时一个元素都不该摸');

  installDocument();
  const { host, state } = makeHost();
  const ui2 = jumpUi.create(host);
  state.jumpQuery = '旧词';
  state.jumpMatches = [{ index: 1 }];
  state.jumpOutOfRange = true;
  state.jumpToken = 7;
  host.$('jump-backdrop').classList.add('hidden');
  host.$('jump-input').value = '旧词';
  host.$('jump-summary').classList.add('warn');
  host.$('jump-results').innerHTML = '<button></button>';

  assert.equal(ui2.openJumpDialog(), true);
  assert.equal(state.jumpQuery, '');
  assert.deepEqual(state.jumpMatches, []);
  assert.equal(state.jumpOutOfRange, false);
  assert.equal(state.jumpToken, 8, '每次打开都把旧结果作废');
  assert.equal(host.$('jump-input').value, '');
  assert.equal(host.$('jump-results').innerHTML, '');
  assert.equal(host.$('jump-backdrop').classList.contains('hidden'), false);
  assert.equal(host.$('jump-summary').classList.contains('warn'), false);
  assert.equal(host.$('jump-summary').textContent, '共 2 章。输入章号（如 12、第12章）或章名的一部分；回车跳转。');

  const input = host.$('jump-input');
  assert.equal(input.focused, undefined, '聚焦是 20ms 后的事，不是同步');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(input.focused, true);
  assert.equal(input.selected, true);
});

test('openJumpDialog：20ms 内又被关掉就不再抢焦点', async () => {
  installDocument();
  const { host } = makeHost();
  const ui = jumpUi.create(host);
  assert.equal(ui.openJumpDialog(), true);
  ui.closeJumpDialog();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(host.$('jump-input').focused, undefined);
  assert.equal(host.$('jump-backdrop').classList.contains('hidden'), true);
});

test('closeJumpDialog：隐藏遮罩、清输入与结果、jumpToken +1、dirty 不动', () => {
  installDocument();
  const { host, state } = makeHost();
  const ui = jumpUi.create(host);
  state.jumpQuery = '第二章';
  state.jumpMatches = [{ index: 1 }];
  state.jumpOutOfRange = true;
  state.jumpToken = 3;
  host.$('jump-input').value = '第二章';
  host.$('jump-results').innerHTML = '<button></button>';
  host.$('jump-summary').textContent = '按章号跳转：第2章：第二章';

  ui.closeJumpDialog();
  assert.equal(state.jumpQuery, '');
  assert.deepEqual(state.jumpMatches, []);
  assert.equal(state.jumpOutOfRange, false);
  assert.equal(state.jumpToken, 4);
  assert.equal(host.$('jump-backdrop').classList.contains('hidden'), true);
  assert.equal(host.$('jump-input').value, '');
  assert.equal(host.$('jump-results').innerHTML, '');
  assert.equal(host.$('jump-summary').textContent, '');
});

test('jumpToIndex：越界 / 没书不切章；合法先关对话框再 switchChapter，返回值原样透传', async () => {
  installDocument();
  const { host, switches } = makeHost();
  const ui = jumpUi.create(host);
  assert.deepEqual(await ui.jumpToIndex(-1), { ok: false, message: '章节不存在' });
  assert.deepEqual(await ui.jumpToIndex(2), { ok: false, message: '章节不存在' });
  assert.deepEqual(switches, []);
  assert.equal(host.$('jump-backdrop').classList.contains('hidden'), false, '非法下标在改前就是直接 return，不碰遮罩');

  // 合法：先关对话框（清输入 / 遮罩），再走 switchChapter
  host.$('jump-backdrop').classList.remove('hidden');
  host.$('jump-input').value = '第二章';
  assert.deepEqual(await ui.jumpToIndex(1), { ok: true, index: 1 });
  assert.deepEqual(switches, [1]);
  assert.equal(host.$('jump-backdrop').classList.contains('hidden'), true);
  assert.equal(host.$('jump-input').value, '');
});

test('confirmJumpFromDialog：没有匹配只 warn 不切章；有匹配跳第一条', async () => {
  installDocument();
  const { host, switches, state } = makeHost();
  const ui = jumpUi.create(host);
  assert.deepEqual(await ui.confirmJumpFromDialog(), { ok: false, message: '没有匹配的章节' });
  assert.equal(host.$('jump-summary').classList.contains('warn'), true);
  assert.deepEqual(switches, []);

  state.jumpMatches = [{ index: 1, name: '第二章' }, { index: 0, name: '第一章' }];
  assert.deepEqual(await ui.confirmJumpFromDialog(), { ok: true, index: 1 });
  assert.deepEqual(switches, [1], '只跳第一条');
});

test('静态闸门：renderer.js 不再内嵌跳章实现，只剩接线', () => {
  for (const name of ['jumpChapterPayload', 'renderJumpMatches', 'refreshJumpMatches', 'scheduleJumpMatches', 'openJumpDialog', 'closeJumpDialog', 'jumpToIndex', 'confirmJumpFromDialog']) {
    assert.equal(
      new RegExp('^  (?:async )?function ' + name + '\\b', 'm').test(rendererSrc),
      false,
      'renderer.js 里又有 ' + name + ' 的第二份实现（该在 jump-ui.js）'
    );
  }
  assert.equal(rendererSrc.includes('JUMP_RESULT_LIMIT'), false, '列表上限该在 jump-ui.js');
  // 接线：模块只 create 一次，8 个成员都传进去
  assert.match(rendererSrc, /const jumpUi = jumpUiModule\.create\(\{/);
  for (const key of ['api', '$', 'call', 'state', 'chapterTitle', 'CHAPTER_STATUS_LABELS', 'chapterStatus', 'switchChapter']) {
    assert.match(rendererSrc, new RegExp('^    ' + key.replace(/\$/g, '\\$') + ',?$', 'm'), 'host 少了 ' + key);
  }
  // 5 个入口是模块级 const（事件绑定 / Esc 动作表 / 测试钩子照旧按名字取）
  for (const name of ['refreshJumpMatches', 'scheduleJumpMatches', 'openJumpDialog', 'closeJumpDialog', 'confirmJumpFromDialog']) {
    assert.match(rendererSrc, new RegExp('^  const ' + name + ' = jumpUi\\.' + name + ';$', 'm'), name + ' 的接线丢了');
  }
  // 头部从全局拿模块
  assert.match(rendererSrc, /^  const jumpUiModule = window\.CWJumpUi;$/m);
});

test('静态闸门：index.html 在 renderer.js 之前加载 jump-ui.js，模块自己不许碰后端', () => {
  const moduleIdx = indexSrc.indexOf('src="jump-ui.js"');
  const rendererIdx = indexSrc.indexOf('src="renderer.js"');
  assert.ok(moduleIdx > 0, 'index.html 没有加载 jump-ui.js');
  assert.ok(moduleIdx < rendererIdx, 'jump-ui.js 必须排在 renderer.js 之前');
  assert.ok(indexSrc.indexOf('src="export-ui.js"') < moduleIdx, '排在 export-ui.js 之后（便于阅读）');
  assert.equal(/\brequire\s*\(/.test(moduleCode), false, 'jump-ui.js 不许 require');
  assert.equal(/ipcRenderer|node:fs|\bwindow\s*\.\s*cwApi/.test(moduleCode), false, '不许自己摸 Electron / 文件系统');
  assert.equal(/^ {2}\$\(/m.test(moduleCode), false, '模块顶层不许直接查 DOM');
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWJumpUi，且不乱造别的全局', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(moduleSrc, context, { filename: 'renderer/jump-ui.js' });
  assert.equal(typeof win.CWJumpUi, 'object');
  assert.deepEqual(Object.keys(win.CWJumpUi).sort(), ['REQUIRED_HOST', 'create']);
  assert.deepEqual(Array.from(win.CWJumpUi.REQUIRED_HOST), Array.from(jumpUi.REQUIRED_HOST));
  assert.equal(typeof win.CWJumpUi.create, 'function');
  assert.equal(win.CWExportUi, undefined, '单独加载 jump-ui 不该顺手造出别的全局');
  assert.equal(win.CWChapters, undefined);
});
