const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const historyUi = require('../renderer/history-ui');
const backupGuardLib = require('../renderer/backup-guard');

// 第 4 步 renderer 九刀·第一刀：本书历史面板（原 renderer.js 4355–4668 / 当前 HEAD 4369–4668，300 行）
// 搬到 renderer/history-ui.js。搬之前这块只有 E2E 的黑盒覆盖（打开历史 → 预览 → 还原 / 删除备份放回）；
// 失败兜底 / token 作废 / 未保存三选一 / 整组还原跳过提示 / 还原后重载这些分支在 Node 里一步都测不到。
// 搬出来以后用「假 host + 假 DOM」逐条钉住，再用静态闸门保证渲染层不长回第二份、index.html 顺序不许反。
//
// 契约要点：host 9 个成员 = 基础 5（$, state, api, call, toast）+ guard（1.5.0 P0-5 备份指纹核对）
// + 3 个语义分组（collab / menus / fmt，分组内每个真实依赖都单列，见模块头注释）。

const realDocument = globalThis.document;
test.after(() => {
  if (realDocument === undefined) delete globalThis.document;
  else globalThis.document = realDocument;
});

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const moduleSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'history-ui.js'), 'utf8');
// 纯边界闸门只看代码：注释里提 document / state 是在解释契约，不算越界
const moduleCode = moduleSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------- 假 DOM：只实现本模块真正用到的几样 ----------
function makeEl(tag = 'div', id = '') {
  const classes = new Set();
  const listeners = [];
  const el = {
    tagName: tag,
    id,
    className: '',
    textContent: '',
    title: '',
    type: '',
    dataset: {},
    attributes: {},
    children: [],
    parentNode: null,
    _classes: classes,
    _listeners: listeners,
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
    setAttribute(name, value) { el.attributes[name] = String(value); },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(el.attributes, name) ? el.attributes[name] : null;
    },
    append(...nodes) { nodes.forEach((n) => el.appendChild(n)); },
    appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    _fire(type, event) {
      let result;
      for (const l of listeners) if (l.type === type) result = l.fn(event);
      return result;
    }
  };
  // renderHistory / 空态会 `list.innerHTML = ''` 清清单：假 DOM 也要真的清
  Object.defineProperty(el, 'innerHTML', {
    get() { return ''; },
    set() { el.children.length = 0; }
  });
  return el;
}

function makeDom(ids) {
  const map = new Map();
  let lookups = 0;
  for (const id of ids) {
    const el = makeEl('div', id);
    // 初始态与 index.html 一致：面板 / 预览默认 hidden
    if (id === 'history-backdrop' || id === 'history-preview') el.classList.add('hidden');
    map.set(id, el);
  }
  const doc = {
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => { lookups += 1; return map.get(id) || null; }
  };
  return {
    doc,
    map,
    get lookups() { return lookups; },
    $: (id) => doc.getElementById(id)
  };
}

const BASE_IDS = [
  'history-backdrop', 'history-title', 'history-summary', 'history-list',
  'history-preview', 'history-preview-title', 'history-preview-text',
  'btn-history-close', 'btn-history-refresh', 'btn-history-preview-close', 'btn-history-open-folder'
];

function formatBytes(n) {
  const value = Math.max(0, Number(n) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function build(options = {}) {
  const dom = options.dom || makeDom(BASE_IDS);
  globalThis.document = dom.doc;
  const state = {
    bookPath: options.bookPath === undefined ? '/书库/书甲' : options.bookPath,
    meta: options.meta === undefined ? { title: '书甲' } : options.meta,
    dirty: Boolean(options.dirty),
    history: options.history === undefined ? null : options.history
  };
  const calls = {
    listHistory: [], previewHistoryFile: [], restoreHistoryDir: [], restoreHistoryFile: [],
    clearSnapshotDay: [], registerUndo: [],
    openBookFolder: [], refreshShelf: 0, reloadOpenBookFromDisk: 0, reloadAfterPartialFailure: [],
    confirmRestoreWithUnsaved: [], openModal: [], toast: []
  };
  const api = {
    listHistory(...args) {
      calls.listHistory.push(args);
      if (options.listHistoryError) throw new Error(options.listHistoryError);
      if (options.listHistory) return options.listHistory(...args);
      return { title: '书甲', groups: [], fileCount: 0, totalBytes: 0 };
    },
    previewHistoryFile(...args) {
      calls.previewHistoryFile.push(args);
      if (options.previewError) throw new Error(options.previewError);
      return options.preview || { sourceLabel: '整理备份', fileName: '第一章.txt', text: '正文', truncated: false };
    },
    restoreHistoryDir(...args) {
      calls.restoreHistoryDir.push(args);
      if (options.restoreError) throw new Error(options.restoreError);
      return options.restoreResult || { restored: 2, skipped: 1, file: '' };
    },
    restoreHistoryFile(...args) {
      calls.restoreHistoryFile.push(args);
      if (options.restoreError) throw new Error(options.restoreError);
      return options.restoreResult || { restored: 2, skipped: 0, file: '' };
    },
    clearSnapshotDay(...args) {
      calls.clearSnapshotDay.push(args);
      if (options.clearError) throw new Error(options.clearError);
      return options.clearResult || { ok: true, dir: args[1] };
    },
    openBookFolder(...args) {
      calls.openBookFolder.push(args);
      if (options.openFolderError) throw new Error(options.openFolderError);
      return { opened: true, dir: '/书库/书甲/_trash' };
    }
  };
  const call = async (fn, ...args) => fn(...args);
  const host = {
    $: dom.$,
    state,
    api,
    call,
    toast(message, kind) { calls.toast.push([message, kind]); },
    // 1.5.0 P0-5（审计 V-2）：真实实现 + 本测试的 api.listHistory 假数据（可逐次改返回值模拟「备份被改」）
    guard: backupGuardLib.create({ call, api }),
    collab: {
      // 「还原前」未保存拦截与整本替换备份还原共用一份实现（renderer.js 的 confirmRestoreWithUnsaved）：
      // 本模块只判「看的是不是当前这本」，三选一 / 保存失败即停都在那一份里，这里用 Spy 钉住调用与返回值透传。
      async confirmRestoreWithUnsaved(message) {
        calls.confirmRestoreWithUnsaved.push(message);
        return options.guardResult === undefined ? { ok: true } : options.guardResult;
      },
      async openModal(opts) { calls.openModal.push(opts); return options.modalAction === undefined ? { action: 'cancel' } : options.modalAction; },
      async refreshShelf() { calls.refreshShelf += 1; },
      async reloadOpenBookFromDisk() { calls.reloadOpenBookFromDisk += 1; },
      async reloadAfterPartialFailure(path) { calls.reloadAfterPartialFailure.push(path); },
      // 1.4.0 P0-2：历史还原把「用还原前备份再还原一次」登记成 10 秒撤销
      registerUndo(label, run) { calls.registerUndo.push({ label, run }); }
    },
    menus: {
      hideBookMenu() { calls.hideBookMenu = (calls.hideBookMenu || 0) + 1; },
      hideExportMenu() { calls.hideExportMenu = (calls.hideExportMenu || 0) + 1; }
    },
    fmt: { formatBytes }
  };
  const ui = historyUi.create(host);
  return { ui, host, state, dom, calls };
}

function groupFixture(overrides = {}) {
  return {
    id: 'g1',
    kind: 'dir',
    source: 'format',
    sourceLabel: '整理备份',
    timeText: '2026-11-01 10:00',
    note: '一键整理前备份',
    fileCount: 2,
    totalBytes: 2048,
    restorableCount: 1,
    files: [
      { name: '第一章.txt', inBook: true, restorable: true, previewable: true, reason: '' },
      { name: '第二章.txt', inBook: false, restorable: false, previewable: true, reason: '章节已删除' }
    ],
    ...overrides
  };
}

// ---------- host 契约 ----------
test('host 契约：9 个成员 + 3 个分组内的真实依赖，缺任何一个都抛 TypeError', () => {
  assert.deepEqual([...historyUi.REQUIRED_HOST].sort(), ['$', 'api', 'call', 'collab', 'fmt', 'guard', 'menus', 'state', 'toast']);
  assert.equal(historyUi.REQUIRED_HOST.length, 9);
  const ctx = build();
  assert.doesNotThrow(() => historyUi.create(ctx.host));
  assert.throws(() => historyUi.create(null), /createHistoryUi 需要 host 对象/);
  assert.throws(() => historyUi.create('host'), /createHistoryUi 需要 host 对象/);

  for (const key of historyUi.REQUIRED_HOST) {
    const broken = { ...ctx.host };
    delete broken[key];
    assert.throws(() => historyUi.create(broken), new RegExp('host 缺少 ' + key.replace('$', '\\$')), '缺 ' + key + ' 必须抛');
    const nulled = { ...ctx.host, [key]: null };
    assert.throws(() => historyUi.create(nulled), /host 缺少/, key + ' = null 也必须抛');
  }
  // 分组内每个真实依赖单独点名（头注释里的契约不能只写分组名）
  for (const key of ['confirmRestoreWithUnsaved', 'openModal', 'registerUndo', 'refreshShelf', 'reloadAfterPartialFailure', 'reloadOpenBookFromDisk']) {
    const broken = { ...ctx.host, collab: { ...ctx.host.collab } };
    delete broken.collab[key];
    assert.throws(() => historyUi.create(broken), new RegExp('host\\.collab 缺少 ' + key), 'collab 缺 ' + key + ' 必须抛');
  }
  for (const key of ['hideBookMenu', 'hideExportMenu']) {
    const broken = { ...ctx.host, menus: { ...ctx.host.menus } };
    delete broken.menus[key];
    assert.throws(() => historyUi.create(broken), new RegExp('host\\.menus 缺少 ' + key), 'menus 缺 ' + key + ' 必须抛');
  }
  // 1.5.0 P0-5（审计 V-2）：备份指纹核对（guard）的每个真实依赖单独点名
  assert.throws(() => historyUi.create({ ...ctx.host, guard: 'x' }), /host\.guard 必须是对象/);
  for (const key of ['fingerprint', 'assertUnchanged']) {
    const broken = { ...ctx.host, guard: { ...ctx.host.guard } };
    delete broken.guard[key];
    assert.throws(() => historyUi.create(broken), new RegExp('host\\.guard 缺少 ' + key), 'guard 缺 ' + key + ' 必须抛');
  }
  const noFmt = { ...ctx.host, fmt: {} };
  assert.throws(() => historyUi.create(noFmt), /host\.fmt 缺少 formatBytes/);
  const badGroup = { ...ctx.host, collab: 'x' };
  assert.throws(() => historyUi.create(badGroup), /host\.collab 必须是对象/);
});

// ---------- create() 只建表 ----------
test('create() 只建表：不碰 DOM / 不注册事件 / 不建定时器，交出 9 个入口', () => {
  const dom = makeDom(BASE_IDS);
  const ctx = build({ dom });
  assert.equal(dom.lookups, 0, 'create() 一次 $ 都不该调');
  assert.deepEqual(Object.keys(ctx.ui).sort(), [
    'closeHistoryDialog', 'closeHistoryPreview', 'confirmHistoryRestore', 'openHistoryForCurrentBook',
    'openHistoryForPath', 'previewHistoryBackup', 'refreshHistory', 'sameBookPath', 'setupHistoryUi'
  ]);
  for (const name of Object.keys(ctx.ui)) assert.equal(typeof ctx.ui[name], 'function', name);
  assert.equal(moduleCode.includes('setTimeout'), false, '模块不建定时器');
  assert.equal(moduleCode.includes('setInterval'), false, '模块不建定时器');
});

// ---------- 纯函数 ----------
test('sameBookPath：大小写不敏感、null / undefined / 数字都按字符串比', () => {
  const { ui } = build();
  assert.equal(ui.sameBookPath('D:\\书\\甲', 'd:\\书\\甲'), true);
  assert.equal(ui.sameBookPath('/a/b', '/a/b/'), false, '不做路径归一，只做字符串比较（与搬前一致）');
  assert.equal(ui.sameBookPath(null, ''), true);
  assert.equal(ui.sameBookPath(undefined, undefined), true);
  assert.equal(ui.sameBookPath(123, '123'), true);
  assert.equal(ui.sameBookPath('a', 'b'), false);
});

test('historyFileTag：删除 / 书目 / 当前章节 / 未识别 / 已不在书里 五种文案与 class 全钉住', async () => {
  const dom = makeDom(BASE_IDS);
  const groups = [
    groupFixture({
      kind: 'file', restorableCount: 0, fileCount: 1, totalBytes: 10, source: 'delete',
      files: [{ name: '删.txt', inBook: false, restorable: false, previewable: false, reason: '' }]
    }),
    groupFixture({
      kind: 'file', restorableCount: 0, fileCount: 1, totalBytes: 10, source: 'bookmeta',
      files: [{ name: '书目.json.bak', inBook: true, restorable: false, previewable: false, reason: '' }]
    }),
    groupFixture({
      kind: 'file', restorableCount: 1, fileCount: 1, totalBytes: 10, source: 'format',
      files: [{ name: '当前章.txt', inBook: true, restorable: true, previewable: true, reason: '' }]
    }),
    groupFixture({
      kind: 'file', restorableCount: 0, fileCount: 1, totalBytes: 10, source: 'other',
      files: [{ name: '怪文件.txt', inBook: true, restorable: false, previewable: false, reason: '' }]
    }),
    groupFixture({
      kind: 'file', restorableCount: 0, fileCount: 1, totalBytes: 10, source: 'format',
      files: [{ name: '不在书里.txt', inBook: false, restorable: false, previewable: false, reason: '' }]
    })
  ];
  const ctx = build({ dom, listHistory: () => ({ title: '书甲', groups, fileCount: 5, totalBytes: 50 }) });
  ctx.state.history = { path: '/书库/书甲', title: '书甲', groups: [], fileCount: 0, totalBytes: 0, loading: true, error: '', preview: null, token: 0 };
  await ctx.ui.refreshHistory();
  const cards = dom.map.get('history-list').children;
  assert.equal(cards.length, 5);
  const tags = cards.map((card) => {
    const row = card.children.find((c) => c.className === 'history-file');
    const tag = row.children.find((c) => c.className.startsWith('history-file-tag'));
    return [tag.textContent, tag.className];
  });
  assert.deepEqual(tags, [
    ['已从书中删除', 'history-file-tag deleted'],
    ['只供查看', 'history-file-tag'],
    ['当前章节', 'history-file-tag current'],
    ['未识别备份', 'history-file-tag'],
    ['已不在书里', 'history-file-tag']
  ]);
});

// ---------- 打开 / 刷新 ----------
test('openHistoryForPath：先收顶栏菜单、建 state.history、拉清单并渲染', async () => {
  const dom = makeDom(BASE_IDS);
  const group = groupFixture();
  const ctx = build({ dom, listHistory: () => ({ title: '书甲', groups: [group], fileCount: 3, totalBytes: 3072 }) });
  const ok = await ctx.ui.openHistoryForPath('/书库/书甲', '书甲');
  assert.equal(ok, true);
  assert.equal(ctx.calls.hideExportMenu, 1, '打开前先收导出菜单');
  assert.equal(ctx.calls.hideBookMenu, 1, '打开前先收书架菜单');
  assert.deepEqual(ctx.calls.listHistory, [['/书库/书甲']]);
  assert.equal(dom.map.get('history-backdrop').classList.contains('hidden'), false);
  assert.equal(dom.map.get('history-title').textContent, '本书历史 · 《书甲》');
  assert.equal(dom.map.get('history-summary').textContent, '共 1 组备份 · 3 个文件 · 3.0 KB（新 → 旧）');
  assert.equal(dom.map.get('history-list').children.length, 1);
  // state.history 字段齐全（P22-5 增加 collapsed：每日快照组的折叠状态，只活在面板里）
  assert.deepEqual(Object.keys(ctx.state.history).sort(), [
    'collapsed', 'error', 'fileCount', 'groups', 'loading', 'path', 'preview', 'title', 'token', 'totalBytes'
  ]);
});

test('openHistoryForPath：没有书路径直接返回 false，什么都不动', async () => {
  const dom = makeDom(BASE_IDS);
  const ctx = build({ dom });
  const ok = await ctx.ui.openHistoryForPath('', '');
  assert.equal(ok, false);
  assert.deepEqual(ctx.calls.listHistory, []);
  assert.equal(dom.map.get('history-backdrop').classList.contains('hidden'), true);
});

test('openHistoryForPath：先渲染 loading 文案，再按返回结果渲染', async () => {
  const dom = makeDom(BASE_IDS);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const ctx = build({ dom, listHistory: () => pending });
  const p = ctx.ui.openHistoryForPath('/书库/书甲', '书甲');
  await Promise.resolve();
  assert.equal(dom.map.get('history-summary').textContent, '正在读取备份…');
  release({ title: '书甲', groups: [groupFixture()], fileCount: 2, totalBytes: 2048 });
  await p;
  assert.match(dom.map.get('history-summary').textContent, /^共 1 组备份/);
});

test('openHistoryForPath：读取失败 → 「读取失败」+ 带原因的警告空态', async () => {
  const dom = makeDom(BASE_IDS);
  const ctx = build({ dom, listHistoryError: 'EACCES：没有权限' });
  const ok = await ctx.ui.openHistoryForPath('/书库/书甲', '书甲');
  assert.equal(ok, true, '打开面板本身成功（错误显示在面板里）');
  assert.equal(ctx.state.history.error, 'EACCES：没有权限');
  assert.equal(dom.map.get('history-summary').textContent, '读取失败');
  const empty = dom.map.get('history-list').children[0];
  assert.equal(empty.className, 'history-empty warn');
  assert.equal(empty.textContent, '读取备份失败：EACCES：没有权限');
});

test('openHistoryForPath：没有备份 → 「没有历史备份」+ 白话说明', async () => {
  const dom = makeDom(BASE_IDS);
  const ctx = build({ dom, listHistory: () => ({ title: '书甲', groups: [], fileCount: 0, totalBytes: 0 }) });
  await ctx.ui.openHistoryForPath('/书库/书甲', '书甲');
  assert.equal(dom.map.get('history-summary').textContent, '没有历史备份');
  const empty = dom.map.get('history-list').children[0];
  assert.equal(empty.className, 'history-empty');
  assert.match(empty.textContent, /还没有历史备份/);
});

test('openHistoryForCurrentBook：没有打开的书 → 警告 toast 并返回 false；有书 → 用当前书路径委托', async () => {
  const noBook = build({ bookPath: null });
  assert.equal(await noBook.ui.openHistoryForCurrentBook(), false);
  assert.deepEqual(noBook.calls.toast, [['先打开一本书再查看历史', 'warn']]);
  assert.deepEqual(noBook.calls.listHistory, []);

  const dom = makeDom(BASE_IDS);
  const ctx = build({ dom });
  assert.equal(await ctx.ui.openHistoryForCurrentBook(), true);
  assert.deepEqual(ctx.calls.listHistory, [['/书库/书甲']]);
});

test('refreshHistory：旧响应按 token 作废（面板被换掉后不再覆盖新状态）', async () => {
  const dom = makeDom(BASE_IDS);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const ctx = build({ dom, listHistory: () => pending });
  ctx.state.history = { path: '/旧', title: '旧', groups: [], fileCount: 0, totalBytes: 0, loading: true, error: '', preview: null, token: 0 };
  const p = ctx.ui.refreshHistory();
  await Promise.resolve();
  const next = { path: '/新', title: '新', groups: [], fileCount: 0, totalBytes: 0, loading: true, error: '', preview: null, token: 0 };
  ctx.state.history = next; // 用户已经关掉又开了另一本书
  release({ title: '旧标题', groups: [groupFixture()], fileCount: 1, totalBytes: 1 });
  assert.equal(await p, null);
  assert.equal(next.groups.length, 0, '旧响应不许写进新面板');
  assert.equal(next.title, '新');
});

test('refreshHistory：没有面板时返回 null，不调 api', async () => {
  const ctx = build();
  assert.equal(await ctx.ui.refreshHistory(), null);
  assert.deepEqual(ctx.calls.listHistory, []);
});

test('refreshHistory：拉不到 / 缺字段时兜底为空数组与 0，不崩', async () => {
  const dom = makeDom(BASE_IDS);
  const ctx = build({ dom, listHistory: () => null });
  ctx.state.history = { path: '/书库/书甲', title: '书甲', groups: [], fileCount: 0, totalBytes: 0, loading: true, error: '', preview: null, token: 0 };
  await ctx.ui.refreshHistory();
  assert.deepEqual(ctx.state.history.groups, []);
  assert.equal(ctx.state.history.fileCount, 0);
  assert.equal(ctx.state.history.totalBytes, 0);
  assert.equal(ctx.state.history.title, '书甲', '返回没有 title 时保留旧标题');
});

// ---------- 预览 ----------
test('previewHistoryBackup：成功 → 设置 preview、渲染标题与正文（截断有提示）', async () => {
  const dom = makeDom(BASE_IDS);
  const ctx = build({ dom, preview: { sourceLabel: '整理备份', fileName: '第一章.txt', text: '旧正文', truncated: true } });
  ctx.state.history = { path: '/书库/书甲', title: '书甲', groups: [groupFixture()], fileCount: 2, totalBytes: 2048, loading: false, error: '', preview: null, token: 0 };
  const data = await ctx.ui.previewHistoryBackup('g1', '第一章.txt');
  assert.deepEqual(ctx.calls.previewHistoryFile, [['/书库/书甲', 'g1', '第一章.txt']]);
  assert.equal(ctx.state.history.preview, data);
  assert.equal(dom.map.get('history-preview').classList.contains('hidden'), false);
  assert.equal(dom.map.get('history-preview-title').textContent, '整理备份 · 第一章.txt（文件较大，只预览开头）');
  assert.equal(dom.map.get('history-preview-text').textContent, '旧正文');
});

test('previewHistoryBackup：空正文显示「（空文件）」；失败 toast「预览失败：」并不改 preview', async () => {
  const dom = makeDom(BASE_IDS);
  const empty = build({ dom, preview: { sourceLabel: '整理备份', fileName: '空.txt', text: '', truncated: false } });
  empty.state.history = { path: '/a', title: '书甲', groups: [], fileCount: 0, totalBytes: 0, loading: false, error: '', preview: null, token: 0 };
  await empty.ui.previewHistoryBackup('g1', '空.txt');
  assert.equal(dom.map.get('history-preview-text').textContent, '（空文件）');

  const fail = build({ dom, previewError: '文件已被删除' });
  fail.state.history = { path: '/a', title: '书甲', groups: [], fileCount: 0, totalBytes: 0, loading: false, error: '', preview: null, token: 0 };
  assert.equal(await fail.ui.previewHistoryBackup('g1', '没了.txt'), null);
  assert.equal(fail.state.history.preview, null);
  assert.deepEqual(fail.calls.toast, [['预览失败：文件已被删除', 'error']]);
});

test('previewHistoryBackup：没有面板时返回 null；关闭预览后 pane 收起', async () => {
  const ctx = build();
  assert.equal(await ctx.ui.previewHistoryBackup('g1', 'a.txt'), null);
  assert.deepEqual(ctx.calls.previewHistoryFile, []);

  const dom = makeDom(BASE_IDS);
  const opened = build({ dom });
  opened.state.history = { path: '/a', title: '书甲', groups: [], fileCount: 0, totalBytes: 0, loading: false, error: '', preview: { text: 'x' }, token: 0 };
  opened.ui.closeHistoryPreview();
  assert.equal(opened.state.history.preview, null);
  assert.equal(dom.map.get('history-preview').classList.contains('hidden'), true);
});

test('closeHistoryDialog：清 state.history 并收起面板与预览', () => {
  const dom = makeDom(BASE_IDS);
  const ctx = build({ dom });
  ctx.state.history = { path: '/a' };
  ctx.ui.closeHistoryDialog();
  assert.equal(ctx.state.history, null);
  assert.equal(dom.map.get('history-backdrop').classList.contains('hidden'), true);
  assert.equal(dom.map.get('history-preview').classList.contains('hidden'), true);
});

// ---------- 还原 ----------
test('confirmHistoryRestore：没有面板 / 没有分组直接返回 { ok:false }', async () => {
  const ctx = build();
  assert.deepEqual(await ctx.ui.confirmHistoryRestore(groupFixture(), null, true), { ok: false });
  ctx.state.history = { path: '/a' };
  assert.deepEqual(await ctx.ui.confirmHistoryRestore(null, null, true), { ok: false });
  assert.deepEqual(ctx.calls.openModal, []);
});

test('confirmHistoryRestore：当前书有未保存修改 + 拦截取消 → canceled，不弹二次确认、不写盘', async () => {
  const ctx = build({ dirty: true, guardResult: { ok: false, canceled: true } });
  ctx.state.history = { path: '/书库/书甲', title: '书甲', groups: [], fileCount: 0, totalBytes: 0, loading: false, error: '', preview: null, token: 0 };
  const res = await ctx.ui.confirmHistoryRestore(groupFixture(), null, true);
  assert.deepEqual(res, { ok: false, canceled: true });
  // 「取消 / 放弃并还原 / 保存后再还原」三选一在共享的 confirmRestoreWithUnsaved 里，本模块只透传文案
  assert.deepEqual(ctx.calls.confirmRestoreWithUnsaved, [
    '还原会从磁盘重新载入这本书的正文；当前章未保存的修改会丢失。'
  ]);
  assert.deepEqual(ctx.calls.openModal, []);
  assert.deepEqual(ctx.calls.restoreHistoryDir, []);
});

test('confirmHistoryRestore：未保存 + 共享拦截报保存失败 → 原样返回保存结果，不继续还原', async () => {
  const savedFail = { ok: false, message: '磁盘满' };
  const ctx = build({ dirty: true, guardResult: { ok: false, saved: savedFail } });
  ctx.state.history = { path: '/书库/书甲', title: '书甲', groups: [], fileCount: 0, totalBytes: 0, loading: false, error: '', preview: null, token: 0 };
  const res = await ctx.ui.confirmHistoryRestore(groupFixture(), null, true);
  assert.deepEqual(res, savedFail);
  assert.equal(ctx.calls.confirmRestoreWithUnsaved.length, 1);
  assert.deepEqual(ctx.calls.openModal, []);
});

test('confirmHistoryRestore：看的是别的书的备份 → 不拿当前书的脏标记去拦，也不调共享拦截', async () => {
  const ctx = build({ dirty: true, bookPath: '/书库/书乙', guardResult: { ok: false, canceled: true } });
  ctx.state.history = { path: '/书库/书甲', title: '书甲', groups: [], fileCount: 0, totalBytes: 0, loading: false, error: '', preview: null, token: 0 };
  const res = await ctx.ui.confirmHistoryRestore(groupFixture(), null, true);
  // 1.4.0 P0-2：不再弹二次确认，直接把别的书的备份还原掉（不看当前书的脏标记）
  assert.equal(res.ok, true);
  assert.deepEqual(ctx.calls.confirmRestoreWithUnsaved, []);
  assert.deepEqual(ctx.calls.openModal, []);
  assert.equal(ctx.calls.restoreHistoryDir.length, 1, '直接执行，不再等确认');
});

test('confirmHistoryRestore：当前书不脏 → 不调共享拦截，也不再弹二次确认（直接还原）', async () => {
  const ctx = build({ dirty: false });
  ctx.state.history = { path: '/书库/书甲', title: '书甲', groups: [], fileCount: 0, totalBytes: 0, loading: false, error: '', preview: null, token: 0 };
  await ctx.ui.confirmHistoryRestore(groupFixture(), null, true);
  assert.deepEqual(ctx.calls.confirmRestoreWithUnsaved, []);
  assert.deepEqual(ctx.calls.openModal, [], '1.4.0 P0-2：历史还原不再二次确认');
  assert.equal(ctx.calls.restoreHistoryDir.length, 1);
});

test('confirmHistoryRestore：整组还原直接执行（不弹确认）+ 登记 10 秒撤销', async () => {
  const ctx = build({
    restoreResult: { restored: 1, skipped: 2, total: 3, restoreBackupDir: '/书库/书甲/_trash/还原前备份-20261109-120000' }
  });
  ctx.state.history = { path: '/书库/书甲', title: '书甲', groups: [], fileCount: 0, totalBytes: 0, loading: false, error: '', preview: null, token: 0 };
  const group = groupFixture({ files: [{ name: 'a.txt', restorable: true }, { name: 'b.txt', restorable: false }, { name: 'c.txt', restorable: false }], restorableCount: 1 });
  const res = await ctx.ui.confirmHistoryRestore(group, null, true);
  assert.equal(res.ok, true);
  assert.deepEqual(ctx.calls.openModal, [], '历史还原不再二次确认（模态只留两处）');
  assert.deepEqual(ctx.calls.restoreHistoryDir, [['/书库/书甲', 'g1']]);
  // 撤销：用这次还原自动建的「还原前备份-*」再还原一次（只传目录名）
  assert.equal(ctx.calls.registerUndo.length, 1);
  assert.match(ctx.calls.registerUndo[0].label, /已还原 1 章（整理备份）/);
  await ctx.calls.registerUndo[0].run();
  assert.deepEqual(ctx.calls.restoreHistoryDir, [
    ['/书库/书甲', 'g1'],
    ['/书库/书甲', 'dir:还原前备份-20261109-120000']
  ], '撤销 = 用这次还原自动建的「还原前备份-*」再还原一次（只传目录名）');
});

// ---------- 1.5.0 P0-5（审计 V-2）：撤销前的备份核对 ----------
const UNDO_DIR = '还原前备份-20261109-120000';

function backupGroupFixture(overrides = {}) {
  return {
    id: `dir:${UNDO_DIR}`,
    kind: 'dir',
    source: 'restore',
    sourceLabel: '还原前备份',
    stamp: '20261109-120000',
    time: 1000,
    timeText: '2026-11-09 12:00',
    dirName: UNDO_DIR,
    fileName: '',
    note: '还原前自动留下的反向备份',
    fileCount: 1,
    totalBytes: 10,
    restorableCount: 1,
    files: [
      {
        name: 'a.txt',
        trashName: 'a.txt',
        size: 10,
        mtimeMs: 1000,
        inBook: true,
        restorable: true,
        previewable: true,
        reason: '',
        source: 'restore'
      }
    ],
    ...overrides
  };
}

function historyState() {
  return {
    path: '/书库/书甲',
    title: '书甲',
    groups: [],
    fileCount: 0,
    totalBytes: 0,
    loading: false,
    error: '',
    preview: null,
    token: 0
  };
}

test('confirmHistoryRestore：撤销前核对备份指纹——目录没变才允许用「还原前备份」再还原一次', async () => {
  let groups = [backupGroupFixture()];
  const ctx = build({
    restoreResult: { restored: 1, skipped: 0, total: 1, restoreBackupDir: `/书库/书甲/_trash/${UNDO_DIR}` },
    listHistory: () => ({ title: '书甲', groups })
  });
  ctx.state.history = historyState();
  assert.equal((await ctx.ui.confirmHistoryRestore(groupFixture(), null, true)).ok, true);
  assert.equal(ctx.calls.registerUndo.length, 1);

  // 指纹一致：撤销照旧（第二次 restoreHistoryDir 才是撤销）
  await ctx.calls.registerUndo[0].run();
  assert.deepEqual(ctx.calls.restoreHistoryDir, [
    ['/书库/书甲', 'g1'],
    ['/书库/书甲', `dir:${UNDO_DIR}`]
  ]);
  assert.ok(ctx.calls.listHistory.length >= 3, '登记时记一次、撤销前再核一次');
});

test('confirmHistoryRestore：撤销前核对备份指纹——备份被增删 / 改写就报「备份已变化，撤销取消」，不覆盖正文', async () => {
  let groups = [backupGroupFixture()];
  const ctx = build({
    restoreResult: { restored: 1, skipped: 0, total: 1, restoreBackupDir: `/书库/书甲/_trash/${UNDO_DIR}` },
    listHistory: () => ({ title: '书甲', groups })
  });
  ctx.state.history = historyState();
  assert.equal((await ctx.ui.confirmHistoryRestore(groupFixture(), null, true)).ok, true);

  // 文件数变了（10 秒里有人往备份目录里补了一个文件）
  groups = [
    backupGroupFixture({
      fileCount: 2,
      files: [
        { name: 'a.txt', trashName: 'a.txt', size: 10, mtimeMs: 1000, inBook: true, restorable: true, reason: '' },
        { name: 'b.txt', trashName: 'b.txt', size: 10, mtimeMs: 1000, inBook: true, restorable: true, reason: '' }
      ]
    })
  ];
  await assert.rejects(() => ctx.calls.registerUndo[0].run(), /备份已变化，撤销取消/);
  assert.deepEqual(ctx.calls.restoreHistoryDir, [['/书库/书甲', 'g1']], '备份变了就不许再调还原');
  assert.equal(ctx.calls.reloadOpenBookFromDisk, 1, '只有第一次还原重载过，撤销没有动编辑区');

  // 文件数一样但内容被改写（mtime 变了）同样拒绝
  const ctx2 = build({
    restoreResult: { restored: 1, skipped: 0, total: 1, restoreBackupDir: `/书库/书甲/_trash/${UNDO_DIR}` },
    listHistory: () => ({ title: '书甲', groups })
  });
  ctx2.state.history = historyState();
  groups = [backupGroupFixture()];
  assert.equal((await ctx2.ui.confirmHistoryRestore(groupFixture(), null, true)).ok, true);
  groups = [
    backupGroupFixture({
      files: [{ name: 'a.txt', trashName: 'a.txt', size: 10, mtimeMs: 9999, inBook: true, restorable: true, reason: '' }]
    })
  ];
  await assert.rejects(() => ctx2.calls.registerUndo[0].run(), /备份已变化，撤销取消/);
  assert.deepEqual(ctx2.calls.restoreHistoryDir, [['/书库/书甲', 'g1']]);
});

test('confirmHistoryRestore：撤销前清单读不到 → 证明不了没变，也取消（不猜）', async () => {
  let listCount = 0;
  const ctx = build({
    restoreResult: { restored: 1, skipped: 0, total: 1, restoreBackupDir: `/书库/书甲/_trash/${UNDO_DIR}` },
    listHistory: () => {
      listCount += 1;
      if (listCount >= 3) throw new Error('磁盘忙'); // 第 3 次 = 撤销前核对
      return { title: '书甲', groups: [backupGroupFixture()] };
    }
  });
  ctx.state.history = historyState();
  assert.equal((await ctx.ui.confirmHistoryRestore(groupFixture(), null, true)).ok, true);
  await assert.rejects(() => ctx.calls.registerUndo[0].run(), /备份清单读取失败，撤销取消/);
  assert.deepEqual(ctx.calls.restoreHistoryDir, [['/书库/书甲', 'g1']]);
});

test('confirmHistoryRestore：登记时清单读不到（指纹 null）→ 撤销不核对，照旧放行', async () => {
  const ctx = build({
    restoreResult: { restored: 1, skipped: 0, total: 1, restoreBackupDir: `/书库/书甲/_trash/${UNDO_DIR}` },
    listHistoryError: '读不到清单'
  });
  ctx.state.history = historyState();
  assert.equal((await ctx.ui.confirmHistoryRestore(groupFixture(), null, true)).ok, true);
  assert.equal(ctx.calls.registerUndo.length, 1);
  // 撤销时 api.listHistory 仍然抛错，但没有指纹就不拦（否则一次读取失败会把正常撤销变砖）
  await ctx.calls.registerUndo[0].run();
  assert.deepEqual(ctx.calls.restoreHistoryDir, [
    ['/书库/书甲', 'g1'],
    ['/书库/书甲', `dir:${UNDO_DIR}`]
  ]);
});

test('confirmHistoryRestore：单文件还原成功 → 调 api.restoreHistoryFile、当前书开着就重载、刷新书架与清单', async () => {
  const ctx = build({ modalAction: { action: 'ok' }, restoreResult: { restored: 2, skipped: 0, file: '第一章.txt' } });
  ctx.state.history = { path: '/书库/书甲', title: '书甲', groups: [], fileCount: 0, totalBytes: 0, loading: false, error: '', preview: null, token: 0 };
  const file = { name: '第一章.txt' };
  const res = await ctx.ui.confirmHistoryRestore(groupFixture(), file, false);
  assert.deepEqual(ctx.calls.restoreHistoryFile, [['/书库/书甲', 'g1', '第一章.txt']]);
  assert.equal(ctx.calls.reloadOpenBookFromDisk, 1, '当前书开着 → 从磁盘重载');
  assert.equal(ctx.calls.refreshShelf, 1);
  assert.deepEqual(ctx.calls.listHistory.length, 1, '还原后重新拉一次清单');
  assert.equal(res.ok, true);
  assert.deepEqual(ctx.calls.toast, [['已还原 2 章，还原前的内容已备份到 _trash', undefined]]);
});

test('confirmHistoryRestore：还原失败 → toast 带原因 + 按磁盘真相重载（不只提示）', async () => {
  const ctx = build({ modalAction: { action: 'ok' }, restoreError: '磁盘满' });
  ctx.state.history = { path: '/书库/书甲', title: '书甲', groups: [], fileCount: 0, totalBytes: 0, loading: false, error: '', preview: null, token: 0 };
  const res = await ctx.ui.confirmHistoryRestore(groupFixture(), { name: 'a.txt' }, false);
  assert.deepEqual(res, { ok: false, message: '磁盘满' });
  assert.deepEqual(ctx.calls.toast, [['还原失败：磁盘满', 'error']]);
  assert.deepEqual(ctx.calls.reloadAfterPartialFailure, ['/书库/书甲']);
});

test('confirmHistoryRestore：删除来源整组放回 → 不重载正文，toast 说「章节列表未变」', async () => {
  const ctx = build({ modalAction: { action: 'ok' }, restoreResult: { restored: 1, skipped: 0, file: '删掉的.txt' } });
  ctx.state.history = { path: '/书库/书甲', title: '书甲', groups: [], fileCount: 0, totalBytes: 0, loading: false, error: '', preview: null, token: 0 };
  const group = groupFixture({ source: 'delete', sourceLabel: '删章备份' });
  const res = await ctx.ui.confirmHistoryRestore(group, null, true);
  assert.equal(ctx.calls.reloadOpenBookFromDisk, 0, '删章放回不改章节列表，不重载正文');
  assert.deepEqual(ctx.calls.toast, [['已把「删掉的.txt」放回书文件夹（章节列表未变，需要时可从目录重建找回）', undefined]]);
  assert.equal(res.ok, true);
});

// ---------- 每日快照组：折叠 + 清空某天（P22-5） ----------
// core/history.js 只给「快照-YYYYMMDD 且日期真实存在」的组带 snapshotName；渲染层据此决定
// 「默认折叠 + 清空这天的快照」，其它来源的组行为一个字节不变（默认展开、只有还原整组）。
function snapshotGroupFixture(overrides = {}) {
  return groupFixture({
    id: 'dir:快照-20261107',
    source: 'snapshot',
    sourceLabel: '每日快照',
    note: '每日快照留下的章节副本。可以预览、还原单章或整组。',
    timeText: '2026-11-07 22:10',
    dirName: '快照-20261107',
    snapshotName: '快照-20261107',
    snapshotDay: '2026-11-07',
    fileCount: 2,
    totalBytes: 2048,
    restorableCount: 2,
    ...overrides
  });
}

function historyPanelState(overrides = {}) {
  return {
    path: '/书库/书甲',
    title: '书甲',
    groups: [],
    fileCount: 0,
    totalBytes: 0,
    loading: false,
    error: '',
    preview: null,
    collapsed: {},
    token: 0,
    ...overrides
  };
}

function findButtonByClass(card, className) {
  const stack = [card];
  while (stack.length) {
    const el = stack.shift();
    if (!el) continue;
    if (String(el.className || '').split(/\s+/).includes(className)) return el;
    if (el.children) stack.push(...el.children);
  }
  return null;
}

test('每日快照组：默认折叠（aria-expanded=false、文件行不渲染、还原整组收起），清空按钮只在快照组', async () => {
  const dom = makeDom(BASE_IDS);
  const snapshot = snapshotGroupFixture();
  const format = groupFixture();
  const ctx = build({
    dom,
    listHistory: () => ({ title: '书甲', groups: [snapshot, format], fileCount: 4, totalBytes: 4096 })
  });
  ctx.state.history = historyPanelState();
  await ctx.ui.refreshHistory();
  const cards = dom.map.get('history-list').children;
  assert.equal(cards.length, 2);

  // 快照组：组头 = 一枚带 aria-expanded 的原生 button（键盘可达），折叠时只剩组头 + 说明
  const snapshotCard = cards[0];
  assert.equal(snapshotCard.dataset.source, 'snapshot');
  const snapshotHead = snapshotCard.children[0];
  assert.equal(snapshotHead.className, 'history-group-head');
  const toggle = snapshotHead.children[0];
  assert.equal(toggle.className, 'history-group-toggle');
  assert.equal(toggle.tagName, 'button');
  assert.equal(toggle.type, 'button');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('tabindex'), null, '原生 button 不该被 tabindex=-1 踢出 Tab 顺序');
  // 折叠时组头照样显示「每日快照 · 具体日期 · N 个文件 · 大小」
  assert.equal(toggle.children[0].className, 'history-group-chevron');
  assert.equal(toggle.children[0].textContent, '▸');
  assert.equal(toggle.children[1].textContent, '每日快照');
  assert.equal(toggle.children[2].textContent, '2026-11-07 22:10');
  assert.equal(toggle.children[3].textContent, '2 个文件 · 2.0 KB');
  // 折叠：文件行不渲染（head + note 两个子节点），「还原整组」也收起
  assert.equal(snapshotCard.children.length, 2);
  assert.equal(snapshotCard.children[1].className, 'history-note');
  const actions = snapshotHead.children[1];
  assert.equal(actions.className, 'history-group-actions');
  assert.equal(actions.children.length, 1, '折叠时只剩清空按钮');
  assert.equal(actions.children[0].className, 'btn ghost tiny history-clear-snapshot');
  assert.equal(actions.children[0].textContent, '清空这天的快照');
  assert.equal(findButtonByClass(snapshotCard, 'history-restore-group'), null, '折叠时不出现还原整组');

  // 其它来源的组维持原样：没有 toggle、默认展开、照旧有还原整组
  const formatCard = cards[1];
  const formatHead = formatCard.children[0];
  assert.equal(findButtonByClass(formatCard, 'history-group-toggle'), null);
  assert.equal(formatHead.children[0].className, 'history-source');
  assert.equal(formatHead.children[3].className, 'btn ghost tiny history-restore-group');
  assert.equal(formatHead.children[3].textContent, '还原整组（1）');
  assert.equal(formatCard.children.length, 4, 'head + note + 2 个文件行');

  // 清空按钮只在快照组出现
  const clearButtons = [snapshotCard, formatCard].filter((card) =>
    findButtonByClass(card, 'history-clear-snapshot')
  );
  assert.deepEqual(clearButtons, [snapshotCard]);
});

test('每日快照组：点组头展开 / 再点收起，折叠状态只记在 state.history.collapsed', async () => {
  const dom = makeDom(BASE_IDS);
  const snapshot = snapshotGroupFixture();
  const ctx = build({ dom, listHistory: () => ({ title: '书甲', groups: [snapshot], fileCount: 2, totalBytes: 2048 }) });
  ctx.state.history = historyPanelState();
  await ctx.ui.refreshHistory();
  assert.equal(ctx.state.history.groups.length, 1);

  // 展开：aria-expanded=true、文件行渲染出来、「还原整组」回到组头
  dom.map.get('history-list').children[0].children[0].children[0]._fire('click');
  assert.equal(ctx.state.history.collapsed['dir:快照-20261107'], false);
  let card = dom.map.get('history-list').children[0];
  let head = card.children[0];
  assert.equal(head.children[0].getAttribute('aria-expanded'), 'true');
  assert.equal(head.children[0].children[0].textContent, '▾');
  assert.equal(card.children.length, 4, 'head + note + 2 个文件行');
  assert.equal(card.children[2].className, 'history-file');
  assert.equal(card.children[2].dataset.fileName, '第一章.txt');
  const actions = head.children[1];
  assert.equal(actions.className, 'history-group-actions');
  assert.equal(actions.children.length, 2);
  assert.equal(actions.children[0].className, 'btn ghost tiny history-restore-group');
  assert.equal(actions.children[0].textContent, '还原整组（2）');
  assert.equal(actions.children[1].className, 'btn ghost tiny history-clear-snapshot');

  // 收起：回到折叠态
  head.children[0]._fire('click');
  assert.equal(ctx.state.history.collapsed['dir:快照-20261107'], true);
  card = dom.map.get('history-list').children[0];
  head = card.children[0];
  assert.equal(head.children[0].getAttribute('aria-expanded'), 'false');
  assert.equal(card.children.length, 2);
  assert.equal(findButtonByClass(card, 'history-restore-group'), null);

  // 折叠状态不写盘、不进 config：面板一关就没了（重新打开 = 默认折叠）
  ctx.ui.closeHistoryDialog();
  ctx.state.history = historyPanelState();
  await ctx.ui.refreshHistory();
  assert.equal(dom.map.get('history-list').children[0].children[0].children[0].getAttribute('aria-expanded'), 'false');
});

test('清空这天的快照：不再弹确认框（直接移入回收站）→ api.clearSnapshotDay(书路径, 快照目录名) → 刷新清单 / 书架 + toast', async () => {
  const dom = makeDom(BASE_IDS);
  const ctx = build({
    dom,
    listHistory: () => ({ title: '书甲', groups: [snapshotGroupFixture()], fileCount: 2, totalBytes: 2048 })
  });
  ctx.state.history = historyPanelState();
  await ctx.ui.refreshHistory();
  const clearButton = findButtonByClass(dom.map.get('history-list').children[0], 'history-clear-snapshot');
  assert.ok(clearButton, '快照组要有清空按钮');
  await clearButton._fire('click');

  // 1.4.0 P0-2：清空某天快照不再二次确认（整组移入 Windows 回收站，外部可还原；应用内无撤销资源）
  assert.deepEqual(ctx.calls.openModal, [], '清空快照不许再弹确认框');
  assert.deepEqual(ctx.calls.clearSnapshotDay, [['/书库/书甲', '快照-20261107']]);
  assert.equal(ctx.calls.listHistory.length, 2, '清空后重新拉一次清单');
  assert.equal(ctx.calls.refreshShelf, 1);
  assert.deepEqual(ctx.calls.toast, [['已把「快照-20261107」移入回收站，可从回收站恢复', undefined]]);
  assert.deepEqual(ctx.calls.registerUndo, [], '移入回收站的动作没有应用内撤销（记录在案的例外）');
});

test('清空这天的快照：失败 → toast「清空失败：…」，清单保持原样（不重新拉清单 / 不刷书架）', async () => {
  const dom = makeDom(BASE_IDS);
  const ctx = build({
    dom,
    modalAction: { action: 'ok' },
    clearError: '回收站不可用',
    listHistory: () => ({ title: '书甲', groups: [snapshotGroupFixture()], fileCount: 2, totalBytes: 2048 })
  });
  ctx.state.history = historyPanelState();
  await ctx.ui.refreshHistory();
  const groupsBefore = ctx.state.history.groups;
  const clearButton = findButtonByClass(dom.map.get('history-list').children[0], 'history-clear-snapshot');
  await clearButton._fire('click');

  assert.deepEqual(ctx.calls.clearSnapshotDay, [['/书库/书甲', '快照-20261107']]);
  assert.deepEqual(ctx.calls.toast, [['清空失败：回收站不可用', 'error']]);
  assert.equal(ctx.state.history.groups, groupsBefore, '失败时清单一个字节都不动');
  assert.equal(ctx.calls.listHistory.length, 1);
  assert.equal(ctx.calls.refreshShelf, 0);
  assert.equal(dom.map.get('history-list').children.length, 1);
});

test('快照来源但名字不是严格格式的组：不折叠、不给清空按钮（绝不碰不是本应用生成的目录）', async () => {
  const dom = makeDom(BASE_IDS);
  const legacy = groupFixture({
    id: 'dir:快照-2026-10-31-230000',
    source: 'snapshot',
    sourceLabel: '每日快照',
    dirName: '快照-2026-10-31-230000',
    timeText: '2026-10-31 23:00'
  });
  const ctx = build({ dom, listHistory: () => ({ title: '书甲', groups: [legacy], fileCount: 2, totalBytes: 2048 }) });
  ctx.state.history = historyPanelState();
  await ctx.ui.refreshHistory();
  const card = dom.map.get('history-list').children[0];
  const head = card.children[0];
  assert.equal(findButtonByClass(card, 'history-group-toggle'), null, '没有 snapshotName 就不折叠');
  assert.equal(head.children[0].className, 'history-source');
  assert.equal(card.children.length, 4, '默认展开：head + note + 2 个文件行');
  assert.equal(findButtonByClass(card, 'history-clear-snapshot'), null, '不给清空入口');
  assert.equal(head.children[3].className, 'btn ghost tiny history-restore-group');
});

// ---------- 事件绑定 ----------
test('setupHistoryUi：按原样注册 4 个按钮；关闭 / 刷新 / 关预览 / 打开文件夹都走真实函数', async () => {
  const dom = makeDom(BASE_IDS);
  const ctx = build({ dom, listHistory: () => ({ title: '书甲', groups: [], fileCount: 0, totalBytes: 0 }) });
  ctx.ui.setupHistoryUi();
  assert.deepEqual(dom.map.get('btn-history-close')._listeners.map((x) => x.type), ['click']);
  assert.deepEqual(dom.map.get('btn-history-refresh')._listeners.map((x) => x.type), ['click']);
  assert.deepEqual(dom.map.get('btn-history-preview-close')._listeners.map((x) => x.type), ['click']);
  assert.deepEqual(dom.map.get('btn-history-open-folder')._listeners.map((x) => x.type), ['click']);

  ctx.state.history = { path: '/书库/书甲', collapsed: true };
  dom.map.get('btn-history-close')._fire('click');
  assert.equal(ctx.state.history, null, '关闭按钮清 state.history');

  ctx.state.history = { path: '/书库/书甲', preview: { text: 'x' } };
  dom.map.get('btn-history-preview-close')._fire('click');
  assert.equal(ctx.state.history.preview, null);

  ctx.state.history = { path: '/书库/书甲', preview: null };
  dom.map.get('btn-history-refresh')._fire('click');
  await Promise.resolve();
  assert.deepEqual(ctx.calls.listHistory, [['/书库/书甲']]);

  await dom.map.get('btn-history-open-folder')._fire('click');
  assert.deepEqual(ctx.calls.openBookFolder, [['/书库/书甲']]);
  assert.deepEqual(ctx.calls.toast, [['已在资源管理器打开书文件夹（备份在 _trash 里）', undefined]]);

  // 面板没开时点「打开文件夹」直接 return，一个 IPC 都不打
  ctx.state.history = null;
  ctx.calls.openBookFolder.length = 0;
  await dom.map.get('btn-history-open-folder')._fire('click');
  assert.deepEqual(ctx.calls.openBookFolder, []);
});

// ---------- 静态闸门 ----------
test('静态闸门：renderer.js 不再内嵌历史面板实现，只剩装配与转发', () => {
  for (const shape of [
    'async function openHistoryForPath(',
    'function openHistoryForCurrentBook(',
    'async function refreshHistory(',
    'function closeHistoryDialog(',
    'function closeHistoryPreview(',
    'function renderHistoryPreview(',
    'function historyFileTag(',
    'function buildHistoryGroup(',
    'function renderHistory(',
    'async function previewHistoryBackup(',
    'async function confirmHistoryRestore(',
    'function sameBookPath('
  ]) {
    assert.equal(rendererSrc.includes(shape), false, 'renderer.js 里还有第二份：' + shape);
  }
  assert.equal(rendererSrc.split('historyUiModule.create(').length - 1, 1, '装配只许一处');
  assert.ok(rendererSrc.includes('const historyUiModule = window.CWHistoryUi;'), '渲染层按 CWHistoryUi 取模块');
  // host 8 个成员逐行钉住（分组内成员也在装配处点名）
  for (const line of [
    '    $, state, api, call, toast,',
    '    collab: { confirmRestoreWithUnsaved, openModal, refreshShelf, reloadAfterPartialFailure, reloadOpenBookFromDisk,',,
    '    menus: { hideBookMenu, hideExportMenu },',
    '    fmt: { formatBytes }'
  ]) {
    assert.ok(rendererSrc.includes(line), '装配少了：' + line);
  }
  // 8 个入口按原名转发
  assert.ok(rendererSrc.includes(
    'const { sameBookPath, openHistoryForPath, openHistoryForCurrentBook, refreshHistory, closeHistoryDialog, closeHistoryPreview, previewHistoryBackup, confirmHistoryRestore } = historyUi;'
  ), '入口必须按原名解构');
  // 绑定块搬走：renderer.js 里不再注册历史 4 个按钮，只留一次 setup 调用
  for (const id of ['btn-history-close', 'btn-history-refresh', 'btn-history-preview-close', 'btn-history-open-folder']) {
    assert.equal(rendererSrc.includes(`$('${id}').addEventListener`), false, rendererSrc); // 绑定实现只能在模块里
  }
  assert.equal(rendererSrc.split('historyUi.setupHistoryUi();').length - 1, 1, 'setup 只调一次');
  // 查找面板已在补刀 9a 搬到 renderer/find-ui.js（本刀仍未动它）：渲染层只保留同名转发
  const findUiSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'find-ui.js'), 'utf8');
  assert.ok(findUiSrc.includes('function renderFindResults('), '查找面板在 find-ui.js');
  assert.ok(findUiSrc.includes('async function runFind('), 'runFind 在 find-ui.js');
  assert.ok(findUiSrc.includes('async function runReplaceAll('), 'runReplaceAll 在 find-ui.js');
  assert.ok(rendererSrc.includes('runFind'), '渲染层仍按名字转发 runFind');
  assert.ok(rendererSrc.includes('runReplaceAll'), '渲染层仍按名字转发 runReplaceAll');
  // 测试钩子宿主契约里的 7 个键还在（runFind / runReplaceAll 属查找面板，不在本刀）
  for (const key of ['openHistoryForPath', 'openHistoryForCurrentBook', 'refreshHistory', 'closeHistoryDialog', 'closeHistoryPreview', 'previewHistoryBackup', 'confirmHistoryRestore']) {
    assert.match(rendererSrc, new RegExp('^      ' + key + ',$', 'm'), 'testHooksScope 少了 ' + key);
  }
  // Esc 动作表仍按名字取两个关闭入口
  assert.match(rendererSrc, /'close-history': \(\) => closeHistoryDialog\(\),/);
  assert.match(rendererSrc, /'close-history-preview': \(\) => closeHistoryPreview\(\),/);
});

test('静态闸门：index.html 在 renderer.js 之前加载 history-ui.js，且只加载一次', () => {
  const at = indexSrc.indexOf('<script src="history-ui.js"></script>');
  const rendererAt = indexSrc.indexOf('<script src="renderer.js"></script>');
  assert.notEqual(at, -1, 'index.html 没加载 history-ui.js');
  assert.notEqual(rendererAt, -1);
  assert.ok(at < rendererAt, 'history-ui.js 必须排在 renderer.js 之前');
  assert.equal(indexSrc.split('history-ui.js').length - 1, 1, '只加载一次');
  // 1.5.0 P0-5（审计 V-2）：history-ui 通过 host.guard 用 CWBackupGuard，脚本必须先于它加载、且只加载一次
  const guardAt = indexSrc.indexOf('<script src="backup-guard.js"></script>');
  assert.notEqual(guardAt, -1, 'index.html 没加载 backup-guard.js');
  assert.ok(guardAt < at, 'backup-guard.js 必须排在 history-ui.js 之前');
  assert.ok(guardAt < rendererAt, 'backup-guard.js 必须排在 renderer.js 之前');
  assert.equal(indexSrc.split('backup-guard.js').length - 1, 1, 'backup-guard.js 只加载一次');
});

test('静态闸门：模块不 require / 不摸 Electron·fs·网络，也不注册 window/document 级监听', () => {
  for (const forbidden of ['require(', 'ipcRenderer', 'node:fs', 'child_process', 'localStorage', 'fetch(', 'window.', 'process.']) {
    assert.equal(moduleCode.includes(forbidden), false, 'history-ui.js 不许出现 ' + forbidden);
  }
  // 事件绑定随域搬：按钮 click 只在 setupHistoryUi 与 buildHistoryGroup（渲染时逐行建）里注册
  assert.equal(moduleCode.includes('addEventListener'), true, '绑定必须搬进模块');
  assert.equal(/window\.addEventListener|document\.addEventListener/.test(moduleCode), false, '模块不注册全局监听');
  const setupStart = moduleCode.indexOf('function setupHistoryUi()');
  assert.ok(setupStart > 0, '模块里找不到 setupHistoryUi');
  const setupBody = moduleCode.slice(setupStart);
  assert.equal(setupBody.includes('setTimeout'), false, 'setup 不建定时器');
  assert.equal(moduleCode.includes('new Promise'), false, '模块不兜底异步（保持搬前用法）');
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWHistoryUi，且不乱造别的全局', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(moduleSrc, context, { filename: 'renderer/history-ui.js' });
  assert.equal(typeof win.CWHistoryUi, 'object');
  assert.deepEqual(Object.keys(win.CWHistoryUi).sort(), ['REQUIRED_HOST', 'create']);
  assert.equal(win.CWHistoryUi.REQUIRED_HOST.length, 9);
  assert.equal(typeof win.CWHistoryUi.create, 'function');
  assert.equal(win.CWShelfNavUi, undefined, '单独加载 history-ui 不该顺手造出别的全局');
  assert.equal(win.CWChapters, undefined);
});
