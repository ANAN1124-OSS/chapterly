const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const historyUi = require('../renderer/history-ui');

// 第 4 步 renderer 九刀·第一刀：本书历史面板（原 renderer.js 4355–4668 / 当前 HEAD 4369–4668，300 行）
// 搬到 renderer/history-ui.js。搬之前这块只有 E2E 的黑盒覆盖（打开历史 → 预览 → 还原 / 删除备份放回）；
// 失败兜底 / token 作废 / 未保存三选一 / 整组还原跳过提示 / 还原后重载这些分支在 Node 里一步都测不到。
// 搬出来以后用「假 host + 假 DOM」逐条钉住，再用静态闸门保证渲染层不长回第二份、index.html 顺序不许反。
//
// 契约要点：host 8 个成员 = 基础 5（$, state, api, call, toast）+ 3 个语义分组
// （collab / menus / fmt，分组内每个真实依赖都单列，见模块头注释）。

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
    openBookFolder(...args) {
      calls.openBookFolder.push(args);
      if (options.openFolderError) throw new Error(options.openFolderError);
      return { opened: true, dir: '/书库/书甲/_trash' };
    }
  };
  const host = {
    $: dom.$,
    state,
    api,
    call: async (fn, ...args) => fn(...args),
    toast(message, kind) { calls.toast.push([message, kind]); },
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
      async reloadAfterPartialFailure(path) { calls.reloadAfterPartialFailure.push(path); }
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
test('host 契约：8 个成员 + 3 个分组内的真实依赖，缺任何一个都抛 TypeError', () => {
  assert.deepEqual([...historyUi.REQUIRED_HOST].sort(), ['$', 'api', 'call', 'collab', 'fmt', 'menus', 'state', 'toast']);
  assert.equal(historyUi.REQUIRED_HOST.length, 8);
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
  for (const key of ['confirmRestoreWithUnsaved', 'openModal', 'refreshShelf', 'reloadAfterPartialFailure', 'reloadOpenBookFromDisk']) {
    const broken = { ...ctx.host, collab: { ...ctx.host.collab } };
    delete broken.collab[key];
    assert.throws(() => historyUi.create(broken), new RegExp('host\\.collab 缺少 ' + key), 'collab 缺 ' + key + ' 必须抛');
  }
  for (const key of ['hideBookMenu', 'hideExportMenu']) {
    const broken = { ...ctx.host, menus: { ...ctx.host.menus } };
    delete broken.menus[key];
    assert.throws(() => historyUi.create(broken), new RegExp('host\\.menus 缺少 ' + key), 'menus 缺 ' + key + ' 必须抛');
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
  // state.history 字段齐全
  assert.deepEqual(Object.keys(ctx.state.history).sort(), [
    'error', 'fileCount', 'groups', 'loading', 'path', 'preview', 'title', 'token', 'totalBytes'
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
  // 直接走到二次确认；默认 modalAction = cancel
  assert.deepEqual(res, { ok: false, canceled: true });
  assert.deepEqual(ctx.calls.confirmRestoreWithUnsaved, []);
  assert.equal(ctx.calls.openModal.length, 1);
});

test('confirmHistoryRestore：当前书不脏 → 不调共享拦截，直接二次确认', async () => {
  const ctx = build({ dirty: false, modalAction: { action: 'cancel' } });
  ctx.state.history = { path: '/书库/书甲', title: '书甲', groups: [], fileCount: 0, totalBytes: 0, loading: false, error: '', preview: null, token: 0 };
  await ctx.ui.confirmHistoryRestore(groupFixture(), null, true);
  assert.deepEqual(ctx.calls.confirmRestoreWithUnsaved, []);
  assert.equal(ctx.calls.openModal.length, 1);
});

test('confirmHistoryRestore：整组还原的二次确认文案带「跳过不是当前章节」的提示', async () => {
  const ctx = build({ modalAction: { action: 'cancel' } });
  ctx.state.history = { path: '/书库/书甲', title: '书甲', groups: [], fileCount: 0, totalBytes: 0, loading: false, error: '', preview: null, token: 0 };
  const group = groupFixture({ files: [{ name: 'a.txt', restorable: true }, { name: 'b.txt', restorable: false }, { name: 'c.txt', restorable: false }], restorableCount: 1 });
  const res = await ctx.ui.confirmHistoryRestore(group, null, true);
  assert.deepEqual(res, { ok: false, canceled: true });
  assert.equal(ctx.calls.openModal.length, 1);
  const modal = ctx.calls.openModal[0];
  assert.equal(modal.title, '还原整组备份');
  assert.match(modal.message, /会用「整理备份」这组备份里的 1 个当前章节覆盖书里的同名章节。/);
  assert.match(modal.message, /另有 2 个文件不是当前章节，会跳过（不会复活已删章节）。/);
  assert.match(modal.message, /还原前会先把现在的内容备份到 _trash\/还原前备份-时间戳\//);
  assert.deepEqual(modal.buttons, [
    { label: '取消', value: 'cancel' },
    { label: '还原', value: 'ok', kind: 'danger' }
  ]);
  assert.deepEqual(ctx.calls.restoreHistoryDir, []);
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
    '    collab: { confirmRestoreWithUnsaved, openModal, refreshShelf, reloadAfterPartialFailure, reloadOpenBookFromDisk },',
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
  assert.equal(win.CWHistoryUi.REQUIRED_HOST.length, 8);
  assert.equal(typeof win.CWHistoryUi.create, 'function');
  assert.equal(win.CWShelfNavUi, undefined, '单独加载 history-ui 不该顺手造出别的全局');
  assert.equal(win.CWChapters, undefined);
});
