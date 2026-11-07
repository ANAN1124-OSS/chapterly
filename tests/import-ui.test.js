const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const importUi = require('../renderer/import-ui');
const { loadSourceGate, restoreGlobalsAfter } = require('./ui-test-preambles');

// v0.9 B-5 第四刀：「导入 / 删除小说（书架级操作）」一段
// （原 renderer.js 4461–4572 行，112 行）搬到 renderer/import-ui.js。
// 搬之前这段只有 E2E 里「导入纯 txt 书 / 收藏夹 / 整本一章 / 按原文章节 / 删除进 _trash」
// 的黑盒覆盖：导入方式询问框、进度文案、导入结果汇总（跳过 / 失败原因）、删除确认框、
// 回收站 / _trash 两条提示、busy 重入、IPC 失败、取消，在 Node 里一步都测不到。
// 搬出来以后用「假 host + 假 DOM」逐条钉住文案与状态，再用静态闸门保证渲染层不长回第二份。

// 模块运行时会摸 document：真身由共享前导存下，test.after 放回。
restoreGlobalsAfter(test, ['document']);

const { rendererSrc, rendererCode, indexSrc, moduleSrc, moduleCode } = loadSourceGate('import-ui.js');

const HOST_KEYS = ['$', 'api', 'call', 'openModal', 'refreshShelf', 'state', 'toast'];

function makeEl(id) {
  const classes = new Set();
  const el = {
    id,
    tagName: '',
    className: '',
    textContent: '',
    disabled: false,
    parentNode: null,
    children: [],
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains: (name) => classes.has(name)
    },
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    remove() {
      if (el.parentNode) {
        const at = el.parentNode.children.indexOf(el);
        if (at >= 0) el.parentNode.children.splice(at, 1);
        el.parentNode = null;
      }
    }
  };
  return el;
}

// 模块运行时摸 document（createElement 建进度 toast），Node 里给一个最小替身。
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

function makeHost(options = {}) {
  const els = new Map();
  const calls = [];
  const toasts = [];
  const modals = [];
  const renders = { shelf: 0 };
  const state = { importing: false };
  const missing = options.missing || [];
  const host = {
    $: (id) => {
      if (missing.includes(id)) return null;
      if (!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
    api: { importBooks: 'books:import', deleteBook: 'books:delete' },
    async call(channel, ...args) {
      calls.push({ channel, args });
      if (options.onCall) {
        const handler = options.onCall(channel, ...args);
        if (handler instanceof Error) throw handler;
        if (handler !== undefined) return handler;
      }
      return {};
    },
    async openModal(opts) {
      modals.push(opts);
      return options.modalResult === undefined ? { action: 'cancel' } : options.modalResult;
    },
    async refreshShelf() {
      renders.shelf += 1;
    },
    state,
    toast(message, kind = 'info') {
      toasts.push({ message, kind });
    }
  };
  return { host, state, els, calls, toasts, modals, renders };
}

function okData(overrides = {}) {
  return { imported: [], skipped: [], failed: [], canceled: false, ...overrides };
}

test('host 契约：7 个成员缺任何一个都抛 TypeError，空 host / null 也抛', () => {
  const { host } = makeHost();
  assert.deepEqual([...importUi.REQUIRED_HOST], HOST_KEYS);
  assert.throws(() => importUi.create(null), /createImportUi 需要 host 对象/);
  assert.throws(() => importUi.create('x'), /createImportUi 需要 host 对象/);
  for (const key of HOST_KEYS) {
    const broken = { ...host };
    delete broken[key];
    // $ 在正则里要转义（这里没有 $ 之外的元字符，但保持同一套写法）
    assert.throws(
      () => importUi.create(broken),
      new RegExp('createImportUi 的 host 缺少 ' + key.replace(/\$/g, '\\$'))
    );
  }
  // null 也算缺（不是「用假值兜底」）
  assert.throws(() => importUi.create({ ...host, toast: null }), /createImportUi 的 host 缺少 toast/);
});

test('create() 只建表：document 置空也建得出来，交出 6 个成员', () => {
  const { host } = makeHost();
  delete globalThis.document;
  const ui = importUi.create(host);
  assert.deepEqual(Object.keys(ui).sort(), [
    'deleteBookFlow', 'hasImportProgress', 'importBooksFlow', 'onImportClick',
    'setImportProgressText', 'summarizeImport'
  ]);
  for (const name of Object.keys(ui)) assert.equal(typeof ui[name], 'function', name + ' 应是函数');
  // 建表本身不许碰 DOM / 不许发 IPC
  assert.equal(host.$('btn-import').children.length, 0);
});

test('summarizeImport：只导入（前三本列名，多出来的写「等」）', () => {
  assert.equal(importUi.create(makeHost().host).summarizeImport([], [], []), '没有可导入的内容');
  assert.equal(
    importUi.create(makeHost().host).summarizeImport([{ title: '甲' }], [], []),
    '已导入 1 本：甲'
  );
  assert.equal(
    importUi.create(makeHost().host).summarizeImport([{ title: '甲' }, { title: '乙' }, { title: '丙' }], [], []),
    '已导入 3 本：甲、乙、丙'
  );
  assert.equal(
    importUi.create(makeHost().host).summarizeImport(
      [{ title: '甲' }, { title: '乙' }, { title: '丙' }, { title: '丁' }], [], []
    ),
    '已导入 4 本：甲、乙、丙 等'
  );
});

test('summarizeImport：跳过原因去重且最多 2 条，失败同样最多 2 条，三段用「。」连接', () => {
  const ui = importUi.create(makeHost().host);
  assert.equal(
    ui.summarizeImport([], [{ reason: '已存在' }, { reason: '已存在' }, { reason: '空文件' }], []),
    '跳过 3 个（已存在；空文件）'
  );
  assert.equal(
    ui.summarizeImport([], [{ reason: '一' }, { reason: '二' }, { reason: '三' }], []),
    '跳过 3 个（一；二）'
  );
  assert.equal(
    ui.summarizeImport([], [], [{ message: '坏 JSON' }]),
    '1 个失败（坏 JSON）'
  );
  assert.equal(
    ui.summarizeImport(
      [{ title: '甲' }],
      [{ reason: '已存在' }, { reason: '已存在' }],
      [{ message: '坏 JSON' }]
    ),
    '已导入 1 本：甲。跳过 2 个（已存在）。1 个失败（坏 JSON）'
  );
});

test('importBooksFlow：state.importing 时立刻返回 { busy: true }，不打 IPC、不建 toast、不碰按钮', async () => {
  const { host, state, calls, toasts, els } = makeHost();
  const created = installDocument();
  const ui = importUi.create(host);
  state.importing = true;
  const res = await ui.importBooksFlow(['D:\\tmp\\a'], 'raw');
  assert.deepEqual(res, { busy: true });
  assert.deepEqual(calls, []);
  assert.deepEqual(toasts, []);
  assert.equal(created.length, 0, '不许建进度 toast');
  assert.equal(els.has('btn-import'), false, '连按钮都不该碰');
  assert.equal(state.importing, true, '别人正在导入，不能替它复位');
});

test('importBooksFlow：正常流程（进度 toast / 按钮禁用 / importing 翻转 / IPC 参数 / 汇总 toast / 刷新书架）', async () => {
  const created = installDocument();
  let during = null;
  const { host, state, calls, toasts, renders, els } = makeHost({
    onCall: (channel) => {
      during = {
        channel,
        importing: state.importing,
        disabled: els.get('btn-import').disabled,
        progressText: created[0] && created[0].textContent,
        className: created[0] && created[0].className,
        attached: Boolean(created[0] && created[0].parentNode)
      };
      return okData({
        imported: [{ title: '甲' }, { title: '乙' }],
        skipped: [{ reason: '已存在' }],
        failed: []
      });
    }
  });
  const ui = importUi.create(host);
  const res = await ui.importBooksFlow(['D:\\tmp\\书'], 'chapters');

  assert.deepEqual(during, {
    channel: 'books:import',
    importing: true,
    disabled: true,
    progressText: '正在分析要导入的内容…',
    className: 'toast',
    attached: true
  });
  assert.deepEqual(calls, [{ channel: 'books:import', args: [['D:\\tmp\\书'], { mode: 'chapters' }] }]);
  assert.deepEqual(toasts, [{ message: '已导入 2 本：甲、乙。跳过 1 个（已存在）', kind: 'warn' }]);
  assert.equal(renders.shelf, 1, '导入成功要刷新书架');
  assert.equal(state.importing, false);
  assert.equal(els.get('btn-import').disabled, false);
  assert.equal(created[0].parentNode, null, '进度 toast 收在 finally 里');
  assert.equal(els.get('toast-area').children.length, 0);
  assert.equal(res.imported.length, 2, '返回值原样透传');
});

test('importBooksFlow：toast 类型按「失败 > 跳过 > 正常」取，全空时文案是「没有可导入的内容」', async () => {
  async function run(data) {
    installDocument();
    const ctl = makeHost({ onCall: () => data });
    const ui = importUi.create(ctl.host);
    await ui.importBooksFlow(undefined, 'chapters');
    return ctl;
  }
  let ctl = await run(okData({ failed: [{ message: '坏 JSON' }], skipped: [{ reason: '已存在' }] }));
  assert.equal(ctl.toasts[0].kind, 'error');
  assert.equal(ctl.toasts[0].message, '跳过 1 个（已存在）。1 个失败（坏 JSON）');

  ctl = await run(okData({ skipped: [{ reason: '已存在' }] }));
  assert.equal(ctl.toasts[0].kind, 'warn', '只有跳过时是 warn');

  ctl = await run(okData());
  assert.deepEqual(ctl.toasts, [{ message: '没有可导入的内容', kind: 'info' }]);
  assert.equal(ctl.renders.shelf, 1, '空结果也照常刷新书架');
});

test('importBooksFlow：取消（canceled）不 toast、不刷新书架，进度 toast 照常收掉', async () => {
  const created = installDocument();
  const { host, state, toasts, renders, els } = makeHost({ onCall: () => okData({ canceled: true }) });
  const ui = importUi.create(host);
  const res = await ui.importBooksFlow(undefined, 'chapters');
  assert.deepEqual(res, { canceled: true });
  assert.deepEqual(toasts, []);
  assert.equal(renders.shelf, 0);
  assert.equal(created[0].parentNode, null);
  assert.equal(state.importing, false);
  assert.equal(els.get('btn-import').disabled, false);
});

test('importBooksFlow：IPC 抛错时收掉进度 toast / 按钮复位 / state 复位 / 错误 toast / 返回值带 error', async () => {
  const created = installDocument();
  const { host, state, toasts, renders, els } = makeHost({
    onCall: () => new Error('磁盘满了')
  });
  const ui = importUi.create(host);
  const res = await ui.importBooksFlow([], 'chapters');
  assert.deepEqual(res, { error: '磁盘满了' });
  assert.deepEqual(toasts, [{ message: '导入失败：磁盘满了', kind: 'error' }]);
  assert.equal(renders.shelf, 0, '失败不刷新书架');
  assert.equal(created[0].parentNode, null);
  assert.equal(state.importing, false);
  assert.equal(els.get('btn-import').disabled, false);
});

test('importBooksFlow：没有 #btn-import 也不炸（书架页之外的极端情况）', async () => {
  installDocument();
  const { host, toasts } = makeHost({ missing: ['btn-import'], onCall: () => okData() });
  const ui = importUi.create(host);
  await assert.doesNotReject(ui.importBooksFlow(undefined, 'chapters'));
  assert.equal(toasts.length, 1);
});

test('进度元素：hasImportProgress 反映真假，setImportProgressText 无元素时静默、有元素时写文案', async () => {
  const created = installDocument();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { host } = makeHost({ onCall: () => gate.then(() => okData()) });
  const ui = importUi.create(host);

  assert.equal(ui.hasImportProgress(), false, '没导入时没有进度元素');
  assert.doesNotThrow(() => ui.setImportProgressText('不该出现'));

  const pending = ui.importBooksFlow(undefined, 'chapters');
  assert.equal(ui.hasImportProgress(), true);
  ui.setImportProgressText('正在收尾（共 12 项）…');
  assert.equal(created[0].textContent, '正在收尾（共 12 项）…');
  assert.equal(host.$('toast-area').children[0], created[0], '进度 toast 挂在 toast-area 里');

  release();
  await pending;
  assert.equal(ui.hasImportProgress(), false, '导完就没有进度元素了');
});

test('onImportClick：询问框三选一，标题 / 说明 / 按钮 / cancelValue 逐字写死', async () => {
  installDocument();
  const { host, modals } = makeHost({ modalResult: { action: 'cancel' } });
  const ui = importUi.create(host);
  await ui.onImportClick();
  assert.equal(modals.length, 1);
  assert.equal(modals[0].title, '导入小说');
  assert.equal(
    modals[0].message,
    '请选择导入方式：\n\n' +
      '• 按原文章节导入（推荐）：按原文的「第X章 / 楔子」等标题拆成多章，章名照抄原文、正文一字不改\n' +
      '• 整本一章导入：不拆章，整本小说放在一章「全文」里（原样复制）'
  );
  assert.deepEqual(modals[0].buttons, [
    { label: '按原文章节导入', value: 'chapters', kind: 'primary' },
    { label: '整本一章', value: 'raw' },
    { label: '取消', value: 'cancel' }
  ]);
  assert.equal(modals[0].cancelValue, 'cancel');
});

test('onImportClick：chapters / raw 分别按对应模式导入，取消与未知值都不导入', async () => {
  async function run(action) {
    installDocument();
    const ctl = makeHost({ modalResult: { action }, onCall: () => okData() });
    const ui = importUi.create(ctl.host);
    await ui.onImportClick();
    return ctl;
  }

  let ctl = await run('chapters');
  assert.deepEqual(ctl.calls, [{ channel: 'books:import', args: [undefined, { mode: 'chapters' }] }]);

  ctl = await run('raw');
  assert.deepEqual(ctl.calls, [{ channel: 'books:import', args: [undefined, { mode: 'raw' }] }]);

  for (const action of ['cancel', undefined, '其他']) {
    ctl = await run(action);
    assert.deepEqual(ctl.calls, [], `动作「${action}」不该导入`);
    assert.deepEqual(ctl.toasts, []);
  }
});

test('onImportClick：正在导入时不再弹询问框（防连点）', async () => {
  installDocument();
  const { host, state, modals } = makeHost();
  const ui = importUi.create(host);
  state.importing = true;
  await ui.onImportClick();
  assert.deepEqual(modals, []);
});

test('deleteBookFlow：没有书 / 书没有路径时什么都不做（不弹框、不打 IPC、不 toast）', async () => {
  installDocument();
  const { host, modals, calls, toasts } = makeHost();
  const ui = importUi.create(host);
  await ui.deleteBookFlow(null);
  await ui.deleteBookFlow({ title: '甲' });
  await ui.deleteBookFlow({ title: '甲', path: '' });
  assert.deepEqual(modals, []);
  assert.deepEqual(calls, []);
  assert.deepEqual(toasts, []);
});

test('deleteBookFlow：确认框文案逐字写死（含章数），点取消不删', async () => {
  installDocument();
  const { host, modals, calls, toasts } = makeHost({ modalResult: { action: 'cancel' } });
  const ui = importUi.create(host);
  await ui.deleteBookFlow({ title: '甲', path: 'D:\\tmp\\甲', chapterCount: 12 });
  assert.equal(modals.length, 1);
  assert.equal(modals[0].title, '删除这本书');
  assert.equal(
    modals[0].message,
    '确定删除「甲」吗？\n\n整本书（12 章）会被移到 Windows 回收站，可以从回收站还原。'
  );
  assert.deepEqual(modals[0].buttons, [
    { label: '删除这本书', value: 'delete', kind: 'danger' },
    { label: '取消', value: 'cancel', kind: 'primary' }
  ]);
  assert.equal(modals[0].cancelValue, 'cancel');
  assert.deepEqual(calls, [], '点取消不许发删除 IPC');
  assert.deepEqual(toasts, []);
});

test('deleteBookFlow：skipConfirm 直接删；回收站 / _trash 两条成功提示逐字；删完刷新书架', async () => {
  async function run(book, data) {
    installDocument();
    const ctl = makeHost({ onCall: () => data });
    const ui = importUi.create(ctl.host);
    await ui.deleteBookFlow(book, { skipConfirm: true });
    return ctl;
  }
  const book = { title: '甲', path: 'D:\\tmp\\甲', chapterCount: 3 };

  let ctl = await run(book, { method: 'recycle' });
  assert.deepEqual(ctl.modals, [], 'skipConfirm 不弹确认框');
  assert.deepEqual(ctl.calls, [{ channel: 'books:delete', args: ['D:\\tmp\\甲'] }]);
  assert.deepEqual(ctl.toasts, [{ message: '已删除「甲」，可在 Windows 回收站里还原', kind: 'info' }]);
  assert.equal(ctl.renders.shelf, 1);

  ctl = await run(book, { method: 'trash', note: '回收站不可用' });
  assert.deepEqual(ctl.toasts, [
    { message: '已删除「甲」，已移到书架 _trash（回收站不可用）', kind: 'info' }
  ]);
  assert.equal(ctl.renders.shelf, 1);

  ctl = await run(book, { method: 'trash' });
  assert.deepEqual(ctl.toasts, [{ message: '已删除「甲」，已移到书架 _trash', kind: 'info' }]);
});

test('deleteBookFlow：IPC 失败时只报错、不刷新书架', async () => {
  installDocument();
  const { host, toasts, renders } = makeHost({ onCall: () => new Error('文件被占用') });
  const ui = importUi.create(host);
  await ui.deleteBookFlow({ title: '甲', path: 'D:\\tmp\\甲' }, { skipConfirm: true });
  assert.deepEqual(toasts, [{ message: '删除失败：文件被占用', kind: 'error' }]);
  assert.equal(renders.shelf, 0);
});

test('静态闸门：renderer.js 不再内嵌这 6 个名字，只剩接线；进度监听的三句文案还在', () => {
  for (const name of ['setImportProgressText', 'summarizeImport', 'importBooksFlow', 'onImportClick', 'deleteBookFlow']) {
    assert.equal(
      new RegExp('^  (?:async )?function ' + name + '\\b', 'm').test(rendererCode),
      false,
      'renderer.js 里又有 ' + name + ' 的第二份实现（该在 import-ui.js）'
    );
  }
  assert.equal(/\bimportProgressEl\b/.test(rendererCode), false, '进度元素归模块所有，渲染层不许再留变量');
  // 接线：模块只 create 一次，7 个 host 成员都传进去
  assert.match(rendererCode, /const importUi = importUiModule\.create\(\{\n {4}\$, api, call, openModal, refreshShelf, state, toast\n {2}\}\);/);
  // 5 个入口 + hasImportProgress 是模块级 const（事件绑定 / 测试钩子照旧按名字取）
  for (const name of ['setImportProgressText', 'hasImportProgress', 'importBooksFlow', 'onImportClick', 'deleteBookFlow']) {
    assert.match(rendererCode, new RegExp('^  const ' + name + ' = importUi\\.' + name + ';$', 'm'), '接线少了 ' + name);
  }
  assert.match(rendererCode, /^  const importUiModule = window\.CWImportUi;$/m);
  // 事件绑定的导入进度监听：问 hasImportProgress()，三句文案原样还在（没跟着搬迁走样）
  assert.match(rendererCode, /^ {6}if \(!hasImportProgress\(\)\) return;$/m);
  for (const text of [
    '正在分析要导入的内容…',
    '正在收尾（共 ${progress.total} 项）…',
    '正在导入 ${Math.min(progress.done + 1, progress.total)}/${progress.total}：${progress.current || \'\'}'
  ]) {
    assert.ok(rendererSrc.includes(text), '进度监听少了文案：' + text);
  }
  // 测试钩子的 host 契约照旧（renderer/test-hooks.js 按名字解构，scope 是 shorthand 6 空格）
  for (const name of ['deleteBookFlow', 'importBooksFlow']) {
    assert.match(rendererCode, new RegExp('^ {6}' + name + ',$', 'm'), 'testHooksScope 少了 ' + name);
  }
});

test('静态闸门：index.html 在 renderer.js 之前加载 import-ui.js，模块自己不许碰后端', () => {
  const moduleIdx = indexSrc.indexOf('src="import-ui.js"');
  const rendererIdx = indexSrc.indexOf('src="renderer.js"');
  assert.ok(moduleIdx > 0, 'index.html 没有加载 import-ui.js');
  assert.ok(moduleIdx < rendererIdx, 'import-ui.js 必须排在 renderer.js 之前');
  assert.ok(indexSrc.indexOf('src="stats-ui.js"') < moduleIdx, '排在 stats-ui.js 之后（便于阅读）');
  assert.equal(/\brequire\s*\(/.test(moduleCode), false, 'import-ui.js 不许 require');
  assert.equal(/ipcRenderer|node:fs|\bwindow\s*\.\s*cwApi/.test(moduleCode), false, '不许自己摸 Electron / 文件系统');
  assert.equal(/^ {2}\$\(/m.test(moduleCode), false, '模块顶层不许直接查 DOM');
  assert.equal(/\bprocess\./.test(moduleCode), false, 'import-ui.js 不许碰 process');
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWImportUi，且不乱造别的全局', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(moduleSrc, context, { filename: 'renderer/import-ui.js' });
  assert.equal(typeof win.CWImportUi, 'object');
  assert.deepEqual(Object.keys(win.CWImportUi).sort(), ['REQUIRED_HOST', 'create']);
  assert.deepEqual(Array.from(win.CWImportUi.REQUIRED_HOST), Array.from(importUi.REQUIRED_HOST));
  assert.equal(typeof win.CWImportUi.create, 'function');
  assert.equal(win.CWExportUi, undefined, '单独加载 import-ui 不该顺手造出别的全局');
  assert.equal(win.CWStatsUi, undefined);
});
