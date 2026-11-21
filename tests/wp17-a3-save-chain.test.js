// WP17 A3 第二刀（保存链）：行为 / 契约锚点。
//
// 缺陷（结构，非功能）：保存 / 载章 / 关窗三套状态机长在渲染层编排器里（约 380 行），
// 没有可独立 require 的出口；Node 里只能「读源码 + 切函数」再执行，装配文件继续膨胀。
// 本刀把它们整段搬到 renderer/save-chain-ui.js（只搬不改行为），编排器只留同名包装。
//
// 为什么这样测：新模块是 UMD，Node 可以直接 require + create()，所以这里不只读源码：
//   ① 静态半边：模块契约 / 编排器只剩同名包装 / 活绑定 let 仍留编排器 / 测试钩子 setter 未被搬走；
//   ② 行为半边：假 host 真跑「保存成功（含保存期间继续打字）」「ENOSPC / EPERM 写盘失败」
//      「EXTERNAL_CHANGE 救稿出口」「载章在途过期回执」「关窗三选」——覆盖搬迁最容易改坏的语义：
//      正文快照 / 失败保持 dirty / 过期回执不覆盖眼前章 / 只收尾一次 / 测试钩子活绑定。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const saveLogic = require('../renderer/save-logic');
const saveStatusUi = require('../renderer/save-status-ui');
const chaptersLib = require('../core/chapters');
const longOpLogic = require('../renderer/long-op-logic');

const RENDERER_SRC = read('renderer/renderer.js');
const MODULE_REL = 'renderer/save-chain-ui.js';
const MODULE_ABS = path.join(ROOT, MODULE_REL);
const MODULE_SRC = fs.existsSync(MODULE_ABS) ? fs.readFileSync(MODULE_ABS, 'utf8') : '';
const moduleApi = fs.existsSync(MODULE_ABS) ? require('../renderer/save-chain-ui') : null;

// 从源码切一个「  [async] function 名字( ... ) { ... }」的真身（形参 / 函数体都按括号配对）。
function extractFunction(source, name) {
  const marker = new RegExp(`(?:^|\\n)  (async )?function ${name}\\(`);
  const match = marker.exec(source);
  assert.ok(match, `找不到 function ${name}(`);
  const start = match.index + (match[0].startsWith('\n') ? 1 : 0);
  const parenStart = source.indexOf('(', start);
  let parenDepth = 0;
  let cursor = parenStart;
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === '(') parenDepth += 1;
    if (source[cursor] === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) break;
    }
  }
  const bodyStart = source.indexOf('{', cursor);
  let depth = 0;
  let mode = 'code';
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i];
    if (mode === 'code') {
      if (ch === '/' && source[i + 1] === '/') { mode = 'line'; i += 1; continue; }
      if (ch === '/' && source[i + 1] === '*') { mode = 'block'; i += 1; continue; }
      if (ch === "'") { mode = 'single'; continue; }
      if (ch === '"') { mode = 'double'; continue; }
      if (ch === '`') { mode = 'template'; continue; }
      if (ch === '{') { depth += 1; continue; }
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(start, i + 1);
      }
      continue;
    }
    if (mode === 'line') { if (ch === '\n') mode = 'code'; continue; }
    if (mode === 'block') { if (ch === '*' && source[i + 1] === '/') { mode = 'code'; i += 1; } continue; }
    if (mode === 'single') { if (ch === '\\') { i += 1; continue; } if (ch === "'") mode = 'code'; continue; }
    if (mode === 'double') { if (ch === '\\') { i += 1; continue; } if (ch === '"') mode = 'code'; continue; }
    if (ch === '\\') { i += 1; continue; }
    if (ch === '`') mode = 'code';
  }
  throw new Error(`function ${name} 的大括号没有配对`);
}

// ---------- ① 静态契约 ----------

test('A3-A / C1：新模块交出 create + REQUIRED_HOST，UMD 双分支与共享 assertHost 与既有模块同口径', () => {
  assert.ok(MODULE_SRC, `${MODULE_REL} 不存在：保存链还没搬出编排器`);
  assert.match(MODULE_SRC, /root\.CWSaveChainUi = factory\(root\.CWAssertHost && root\.CWAssertHost\.assertHost, root\.CWLongOpLogic\)/, '浏览器分支必须挂 CWSaveChainUi（long-op-logic 在同一批加载）');
  assert.match(MODULE_SRC, /require\('\.\.\/core\/assert-host'\)/, 'Node 分支必须 require ../core/assert-host');
  assert.match(MODULE_SRC, /function createSaveChainUi\(host\)/, '模块必须交出 createSaveChainUi(host)');
  assert.match(MODULE_SRC, /assertHost\('createSaveChainUi', host, REQUIRED_HOST\);/, '必须走共享 host 校验');
  assert.ok(Array.isArray(moduleApi.REQUIRED_HOST) && moduleApi.REQUIRED_HOST.length >= 30, 'REQUIRED_HOST 必须列全本域依赖');
  for (const key of [
    'state', 'api', 'call', 'editorEl', 'toast', 'chaptersLib', 'saveLogic',
    'saveStatusUi', 'saveRescueUi', 'longOpLocked', 'DEFAULT_EDITOR_PLACEHOLDER',
    'getOpeningBook', 'setBulkWriteUndo', 'setFallbackWriteUndo',
    'getTestLoadChapter', 'getTestSaveChapter', 'getTestVerifyBook', 'getCrashRecoveryUi',
    'escLib', 'escProbe', 'escRun', 'askUnsaved', 'openModal'
  ]) {
    assert.ok(moduleApi.REQUIRED_HOST.includes(key), `REQUIRED_HOST 缺 ${key}`);
  }
  // 缺成员在装配时炸：不是到点保存才 ReferenceError。
  const rt = makeHost();
  const host = rt.host;
  delete host.toast;
  assert.throws(() => moduleApi.create(host), /createSaveChainUi 的 host 缺少 toast/);
});

test('A3-A / C2：编排器只剩同名包装（3 行内转发），保存链实现一个都搜不到', () => {
  assert.match(RENDERER_SRC, /const saveChainUiModule = window\.CWSaveChainUi;/, '编排器要按清单本地名取模块');
  assert.match(RENDERER_SRC, /const saveChainUi = saveChainUiModule\.create\(\{/, '编排器要装配一次 create(host)');
  const wrappers = {
    saveCurrent: /async function saveCurrent\(options\) \{ return saveChainUi\.saveCurrent\(options\); \}/,
    loadChapterAt: /async function loadChapterAt\(index\) \{ return saveChainUi\.loadChapterAt\(index\); \}/,
    handleCloseRequest: /async function handleCloseRequest\(\) \{ return saveChainUi\.handleCloseRequest\(\); \}/,
    updateStatus: /function updateStatus\(options\) \{ return saveChainUi\.updateStatus\(options\); \}/,
    applyEditorEditable: /function applyEditorEditable\(\) \{ return saveChainUi\.applyEditorEditable\(\); \}/,
    setChapterMask: /function setChapterMask\(masked, placeholder\) \{ return saveChainUi\.setChapterMask\(masked, placeholder\); \}/,
    waitForLoadingIdle: /function waitForLoadingIdle\(\) \{ return saveChainUi\.waitForLoadingIdle\(\); \}/,
    waitForSavingIdle: /function waitForSavingIdle\(\) \{ return saveChainUi\.waitForSavingIdle\(\); \}/
  };
  for (const [name, pattern] of Object.entries(wrappers)) {
    assert.match(RENDERER_SRC, pattern, `编排器里 ${name} 必须是同名包装（调用点零改动）`);
  }
  // 实现标记不许回流：这些字符串只该出现在新模块里。
  for (const marker of [
    "err.code === 'META_SAVE_FAILED'",
    'savingWaiters = [];',
    'loadingWaiters = [];',
    'const LARGE_CHAPTER_SOFT_CHARS = 500000;',
    'let saveDepth = 0;',
    'let loadChapterSeq = 0;',
    'let loadingWaiters = [];',
    'let savingWaiters = [];',
    'let editorChapterMasked = false;'
  ]) {
    assert.equal(RENDERER_SRC.includes(marker), false, `编排器里还有保存链实现：${marker}`);
  }
  // 只有模块内部调用的入口（notify* / discard / verify）不留无人使用的包装：编排器里一个都不许有。
  for (const name of ['notifyLoadingIdle', 'notifySavingIdle', 'discardUnsavedForClose', 'verifyBookInBackground']) {
    assert.equal(RENDERER_SRC.includes(`function ${name}(`), false, `${name} 只被模块内部调用，编排器不许留包装`);
  }
  // 包装必须真的只有一行转发（按大括号配对切出来数行数，防有人把实现又塞回包装里）。
  for (const name of ['saveCurrent', 'loadChapterAt', 'handleCloseRequest', 'updateStatus']) {
    const body = extractFunction(RENDERER_SRC, name);
    assert.ok(body.split(/\r?\n/).length <= 3, `${name} 包装超过 3 行：实现要留在模块里`);
  }
  // 测试钩子的 6 个活绑定 let 必须留编排器（搬走 = E2E 延迟注入静默失效）。
  assert.match(RENDERER_SRC, /\n  let testSaveChapter = null;/, 'testSaveChapter 必须留编排器');
  assert.match(RENDERER_SRC, /\n  let testLoadChapter = null;/, 'testLoadChapter 必须留编排器');
  assert.match(RENDERER_SRC, /\n  let testVerifyBook = null;/, 'testVerifyBook 必须留编排器');
  assert.match(RENDERER_SRC, /\n      set testSaveChapter\(value\) \{\s*\r?\n        testSaveChapter = value;/, 'setter 仍直写编排器闭包');
  assert.match(RENDERER_SRC, /\n      set testLoadChapter\(value\) \{\s*\r?\n        testLoadChapter = value;/, 'setter 仍直写编排器闭包');
});

test('A3-A / C3：机械保真——搬走的实现保留原有红线注释与关键分支（不是重写）', () => {
  for (const line of [
    'WP-03（V101）：保存只认「编辑区里真正载入的那一章」',
    'C1（审计高优先级）：await 前先拍正文快照',
    '审计修复 #5（V301）',
    'WP20（R-N2）：同一笔用户保存',
    'WP-03（C9）：载章一律带 (bookPath, chapterId) 世代令牌',
    'N3（审计低）：大章载入软告知',
    'C5（审计 E5/S5）：关窗「不保存退出」'
  ]) {
    assert.ok(MODULE_SRC.includes(line), `模块丢了红线注释：${line}`);
  }
  assert.equal((MODULE_SRC.match(/const LARGE_CHAPTER_SOFT_CHARS = 500000;/g) || []).length, 1, '阈值只许一份');
  assert.match(MODULE_SRC, /\n    let saveDepth = 0;/, '保存深度守卫随模块走（模块级声明）');
  assert.match(MODULE_SRC, /\n    let loadChapterSeq = 0;/, '载章令牌随模块走');
  assert.match(MODULE_SRC, /getTestSaveChapter\(\)/, '测试钩子必须按活绑定读取');
  assert.match(MODULE_SRC, /getTestLoadChapter\(\)/, '载章延迟注入必须按活绑定读取');
  assert.match(MODULE_SRC, /getCrashRecoveryUi\(\)/, '崩溃恢复模块 setter 之后才 create，必须 getter');
  assert.match(MODULE_SRC, /setBulkWriteUndo\(null\)/, '大段插入快照仍由编排器持有（setter 适配）');
});

// ---------- 假 host ----------

function makeHost(overrides = {}) {
  const counts = {
    toast: [],
    saveStatus: [],
    status: 0,
    syncChars: 0,
    renderList: 0,
    stats: 0,
    flush: 0,
    restore: 0,
    syncActive: 0,
    header: 0,
    modal: [],
    rescue: [],
    closeReady: [],
    editable: 0,
    mask: [],
    loadingIdle: 0,
    savingIdle: 0,
    verify: 0,
    saveCalls: [],
    loadCalls: [],
    askUnsaved: 0
  };
  const state = {
    bookPath: 'C:/tmp/books/测试书',
    index: 0,
    chapters: [{ id: 'c1', name: '第一章', file: '001.txt', chars: 0 }],
    loadedChapterId: 'c1',
    loadedMtimeMs: 111,
    dirty: true,
    saving: false,
    loading: false,
    baseText: '',
    saveError: null,
    meta: { title: '测试书' },
    find: { total: 0, fromBookmark: false },
    focus: { on: false, typewriter: false, savedScrollTop: 0, savedCaret: 0, savedCaretOffset: 0 },
    writeTimer: { running: false, unsentMs: 0 },
    modal: false
  };
  const editorEl = {
    value: '第一章正文快照',
    scrollTop: 5,
    readOnly: false,
    placeholder: 'placeholder',
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; }
  };
  const api = {
    saveChapter: (bookPath, chapterId, text, expectedMtimeMs) => {
      counts.saveCalls.push([bookPath, chapterId, text, expectedMtimeMs]);
      return Promise.resolve({ ok: true, data: { chars: chaptersLib.countChars(text), mtimeMs: 222, snapshot: { taken: true } } });
    },
    loadChapter: (bookPath, file) => {
      counts.loadCalls.push(file);
      return Promise.resolve({ ok: true, data: { text: `正文-${file}`, mtimeMs: 123 } });
    },
    verifyBook: async () => {
      counts.verify += 1;
      return { ok: true, data: { chapters: [], missing: [] } };
    },
    setLastOpenChapter: async () => ({ ok: true, data: {} }),
    closeReady: (value) => counts.closeReady.push(value),
    reportDirty: () => {}
  };
  class ApiError extends Error {
    constructor(message, code, extra) {
      super(message);
      this.name = 'ApiError';
      this.code = code;
      if (extra && typeof extra === 'object') Object.assign(this, extra);
    }
  }
  async function call(fn, ...args) {
    const res = await fn(...args);
    if (!res || res.ok === false) {
      throw new ApiError((res && res.message) || '未知错误', res && res.code, saveLogic.saveFailureExtra(res));
    }
    return res.data;
  }
  let testLoadChapter = overrides.testLoadChapter || null;
  let testSaveChapter = overrides.testSaveChapter || null;
  let testVerifyBook = overrides.testVerifyBook || null;
  let bulkWriteUndo = '旧快照';
  let fallbackWriteUndo = '旧兜底快照';
  let openingBook = overrides.openingBook === true;
  let crashRecoveryUi = overrides.crashRecoveryUi || null;
  const host = {
    state,
    api,
    call,
    editorEl,
    toast: (message, kind) => counts.toast.push([message, kind]),
    chaptersLib,
    saveLogic,
    openModal: async (payload) => {
      counts.modal.push(payload);
      return { action: overrides.modalAction || 'cancel' };
    },
    saveStatusUi: {
      render: () => { counts.status += 1; },
      setSavedDetail: (text) => counts.saveStatus.push(text)
    },
    saveRescueUi: {
      rescuePlanFor: (code) => (code === 'EXTERNAL_CHANGE' ? 'conflict' : (code === 'BOOK_MISSING' ? 'rescue' : '')),
      handleSaveFailure: async (err, options) => {
        counts.rescue.push([err.code, options]);
        return { ok: false, code: err.code, message: err.message, viaRescue: true };
      }
    },
    formatChars: (n) => `${n} 字`,
    $: (id) => {
      counts.$ = counts.$ || {};
      counts.$.last = id;
      return { disabled: false, id };
    },
    renderCharCount: () => {},
    renderSelectionStats: () => {},
    updateWindowTitle: () => {},
    clearFindSession: () => {},
    stopTtsForChapterChange: () => {},
    syncActiveChapterItem: () => { counts.syncActive += 1; },
    renderEditorHeader: () => { counts.header += 1; },
    renderChapterList: () => { counts.renderList += 1; },
    syncChapterCharsAfterSave: () => { counts.syncChars += 1; return true; },
    renderStatsUi: () => { counts.stats += 1; },
    flushWriteTimer: async () => { counts.flush += 1; },
    restoreFindBookmarkForCurrentChapter: async () => {
      counts.restore += 1;
      if (overrides.restoreBookmarkThrows) throw new Error('书签恢复失败（模拟）');
    },
    scheduleMarksRender: () => {},
    scheduleTypewriterAlign: () => {},
    longOpLocked: () => false,
    askUnsaved: async () => {
      counts.askUnsaved += 1;
      return overrides.unsavedAction || 'cancel';
    },
    escLib: { cleanupActions: () => [] },
    escProbe: () => ({}),
    escRun: () => {},
    DEFAULT_EDITOR_PLACEHOLDER: 'placeholder',
    getOpeningBook: () => openingBook,
    setBulkWriteUndo: (value) => { bulkWriteUndo = value; },
    setFallbackWriteUndo: (value) => { fallbackWriteUndo = value; },
    getTestLoadChapter: () => testLoadChapter,
    getTestSaveChapter: () => testSaveChapter,
    getTestVerifyBook: () => testVerifyBook,
    getCrashRecoveryUi: () => crashRecoveryUi,
    setTestLoadChapter: (value) => { testLoadChapter = value; },
    setTestSaveChapter: (value) => { testSaveChapter = value; }
  };
  const ui = moduleApi.create(host);
  return {
    ui,
    host,
    state,
    editorEl,
    counts,
    setOpeningBook: (value) => { openingBook = value; },
    bulk: () => bulkWriteUndo,
    fallback: () => fallbackWriteUndo
  };
}

function deferred() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// ---------- ② 行为 ----------

test('A3-A / B1：保存成功——正文快照 + 保存期间打的字仍算脏；字数快路径 / 后台校验 / 状态栏各一次', async () => {
  const rt = makeHost();
  const gate = deferred();
  rt.host.api.saveChapter = (...args) => {
    rt.counts.saveCalls.push(args);
    return gate.promise;
  };
  rt.state.dirty = true;
  rt.editorEl.value = '第一版正文';
  const pending = rt.ui.saveCurrent();
  await flush();
  assert.equal(rt.state.saving, true, '在途时状态栏是「正在保存」');
  // IPC 往返期间作者又敲了字：这次保存只认发起时的快照。
  rt.editorEl.value = '第一版正文 + 往返期间敲的字';
  gate.release({ ok: true, data: { chars: 7, mtimeMs: 333, snapshot: { taken: true } } });
  const result = await pending;
  assert.deepEqual(result.ok, true);
  assert.equal(rt.counts.saveCalls.length, 1);
  assert.equal(rt.counts.saveCalls[0][2], '第一版正文', '保存的必须是发起时的正文快照');
  assert.equal(rt.counts.saveCalls[0][3], 111, '非 force：expectedMtimeMs 用载入时的 mtime');
  assert.equal(rt.state.baseText, '第一版正文', '基线只认快照');
  assert.equal(rt.state.dirty, true, '快照之后又敲了字 → 仍脏（不许静默并进基线）');
  assert.equal(rt.state.loadedMtimeMs, 333);
  assert.equal(rt.state.saveError, null);
  assert.equal(rt.state.saving, false);
  assert.equal(rt.counts.syncChars, 1, '保存后要走单条字数快路径');
  assert.equal(rt.counts.renderList, 0, '快路径命中时不整表重建');
  assert.equal(rt.counts.saveStatus.length, 1, '成功摘要进状态栏 title（不弹 toast）');
  assert.equal(rt.counts.toast.length, 0, '保存成功不许再弹 toast');
  await flush();
  assert.equal(rt.counts.verify, 1, '保存热路径不 await 校验，但校验要在后台真跑一次');
  assert.equal(rt.counts.restore, 1, '保存后按新正文重扫书签');
});

test('A3-A / B2（极值 × IO 失败注入）：ENOSPC / EPERM 写盘失败——dirty 保持、正文快照不动、只失败一次收尾', async () => {
  for (const code of ['ENOSPC', 'EPERM']) {
    const rt = makeHost();
    rt.host.api.saveChapter = async () => ({ ok: false, code, message: `${code}: 写盘失败（模拟）` });
    rt.state.dirty = true;
    rt.editorEl.value = '两百万字也太长'.repeat(100000); // ≈700KB 正文，极值快照
    const waiter = rt.ui.waitForSavingIdle();
    const result = await rt.ui.saveCurrent();
    await waiter;
    assert.equal(result.ok, false);
    assert.equal(result.code, code, `失败码原样上抛（${code}）`);
    assert.equal(rt.state.saving, false, '失败也要落回 saving=false');
    assert.equal(rt.state.dirty, true, '没写盘 → dirty 必须保持');
    assert.equal(rt.state.baseText, '', '失败不许把正文并进基线');
    assert.equal(rt.state.saveError, `${code}: 写盘失败（模拟）`, '失败原因进状态栏');
    assert.equal(rt.counts.toast.length, 1);
    assert.equal(rt.counts.toast[0][1], 'error');
    assert.match(rt.counts.toast[0][0], new RegExp(`^保存失败：${code}`));
    assert.equal(rt.counts.status >= 2, true, '进入保存 / 失败各刷一次状态栏');
    assert.equal(rt.bulk(), '旧快照', '保存失败不许动大段插入快照');
    assert.equal(rt.state.loadedChapterId, 'c1', '失败不许换章');
  }
  // silent（强制退出路径）失败不打扰作者：只收状态栏，不弹 toast。
  const rt = makeHost();
  rt.host.api.saveChapter = async () => ({ ok: false, code: 'EPERM', message: 'EPERM: 拒绝访问（模拟）' });
  await rt.ui.saveCurrent({ silent: true });
  assert.equal(rt.counts.toast.length, 0, 'silent 失败不许弹 toast');
});

// 五-L13（ES-4）：保存失败后点「重试」——旧实现只在成功分支清 saveError，发起时不清；
// 而 saveStateModel 的优先级是「失败 > 正在保存 > 未保存 > 已保存」，于是重试写盘全程状态栏
// 仍显示「保存失败：…」、圆点仍是 error、重试按钮 disabled，四态的「正在保存…」永远不出现。
test('五-L13（ES-4）：重试保存在途时上一次的 saveError 已作废，状态栏回到「正在保存…」', async () => {
  const rt = makeHost();
  // ① 先失败一次：saveError 落地、dirty 保持（失败不丢稿）
  rt.host.api.saveChapter = async () => ({ ok: false, code: 'EPERM', message: 'EPERM: 拒绝访问（模拟）' });
  rt.state.dirty = true;
  rt.editorEl.value = '未保存的正文';
  const failed = await rt.ui.saveCurrent();
  assert.equal(failed.ok, false);
  assert.equal(rt.state.saveError, 'EPERM: 拒绝访问（模拟）');
  assert.equal(rt.state.dirty, true);

  // ② 点重试：在途期间状态栏必须是「正在保存…」（saveError 作废，不是等成功才清）
  const gate = deferred();
  rt.host.api.saveChapter = () => gate.promise;
  const pending = rt.ui.saveCurrent();
  await flush();
  assert.equal(rt.state.saving, true);
  assert.equal(rt.state.saveError, null, '发起保存即作废上一次失败，不许全程显示「保存失败」');
  assert.deepEqual(
    saveStatusUi.saveStateModel({ saving: rt.state.saving, saveError: rt.state.saveError, dirty: rt.state.dirty }),
    { dot: 'saving', text: '正在保存…', error: false },
    '重试写盘期间四态必须是「正在保存…」（圆点 saving、重试按钮 disabled）'
  );
  gate.release({ ok: true, data: { chars: 6, mtimeMs: 444, snapshot: { taken: true } } });
  const done = await pending;
  assert.equal(done.ok, true);
  assert.equal(rt.state.saveError, null);
  assert.equal(rt.state.dirty, false, '正文快照与编辑区一致 → 干净');
});

// 五-L13 的回归面：发起时清 saveError 不许把「别的书的旧错误」也清掉（回执按发起时身份落地，
// 换书后眼前书的状态栏一个字都不回写 —— 与 B3 ② 同一口径）。
test('五-L13（ES-4）：换书后旧书的重试在途，不许把眼前书的 saveError 清掉', async () => {
  const rt = makeHost();
  const gate = deferred();
  rt.host.api.saveChapter = () => gate.promise;
  rt.state.dirty = true;
  const pending = rt.ui.saveCurrent();
  await flush();
  // 在途期间换了书，眼前书有自己的错误（上一本的重试还在途）
  rt.state.bookPath = 'C:/tmp/books/另一本书';
  rt.state.loadedChapterId = 'c9';
  rt.state.saveError = '另一本书自己的旧错误';
  gate.release({ ok: true, data: { chars: 6, mtimeMs: 444, snapshot: { taken: true } } });
  const done = await pending;
  assert.equal(done.ok, true);
  assert.equal(rt.state.saveError, '另一本书自己的旧错误', '在途换书后不许回写眼前书的 saveError');
});

test('A3-A / B3：EXTERNAL_CHANGE → 救稿出口拿到发起时的书 / 章身份（在途换书不串到眼前书）', async () => {
  // ① 回执到达时还是同一章：冲突身份 = 发起时快照，dirty 不丢、只提示不覆盖。
  const rt = makeHost();
  let release;
  rt.host.api.saveChapter = () => new Promise((resolve) => { release = resolve; });
  const pending = rt.ui.saveCurrent({ silent: true });
  release({ ok: false, code: 'EXTERNAL_CHANGE', message: '这一章在应用外被改过，已阻止这次保存。' });
  const result = await pending;
  assert.equal(result.viaRescue, true, '冲突走救稿出口');
  assert.equal(rt.counts.rescue.length, 1);
  assert.equal(rt.counts.rescue[0][0], 'EXTERNAL_CHANGE');
  assert.equal(rt.counts.rescue[0][1].conflictBookPath, 'C:/tmp/books/测试书', '冲突书路径用发起时快照');
  assert.equal(rt.counts.rescue[0][1].conflictChapterId, 'c1', '冲突章 id 用发起时快照');
  assert.equal(rt.counts.rescue[0][1].silent, true);
  assert.equal(rt.state.saveError, '这一章在应用外被改过，已阻止这次保存。');
  assert.equal(rt.state.dirty, true, '冲突不丢本地修改');

  // ② 回执迟到 + 已经换书：失败只按「发起时身份」判定——不许把别的书的冲突弹给眼前这本书，
  // 也不许把错误写进眼前书的状态栏（C10 的同一口径）。
  const moved = makeHost();
  let releaseMoved;
  moved.host.api.saveChapter = () => new Promise((resolve) => { releaseMoved = resolve; });
  const pendingMoved = moved.ui.saveCurrent();
  moved.state.bookPath = 'C:/tmp/books/另一本书';
  moved.state.loadedChapterId = 'c9';
  moved.state.saveError = '另一本书自己的旧错误';
  releaseMoved({ ok: false, code: 'EXTERNAL_CHANGE', message: '这一章在应用外被改过，已阻止这次保存。' });
  const late = await pendingMoved;
  assert.equal(late.ok, false);
  assert.equal(late.code, 'EXTERNAL_CHANGE');
  assert.equal(moved.counts.rescue.length, 0, '换书后不许把别的书的冲突弹给眼前这本书');
  assert.equal(moved.state.saveError, '另一本书自己的旧错误', '眼前书的状态栏一个字都不许回写');
});

test('A3-A / B4：META_SAVE_FAILED 部分成功——正文已落盘：warn 而非 error、mtime 同步、字数快路径', async () => {
  const rt = makeHost();
  rt.host.api.saveChapter = async () => ({
    ok: false,
    code: 'META_SAVE_FAILED',
    message: '正文已保存，但书目更新失败',
    bodySaved: true,
    chars: 12,
    mtimeMs: 555
  });
  const result = await rt.ui.saveCurrent();
  assert.equal(result.ok, false);
  assert.equal(result.bodySaved, true, '正文已存要标出来');
  assert.equal(rt.state.loadedMtimeMs, 555, '落盘后的 mtime 要同步到编辑器基线（否则下次误报外部改动）');
  assert.equal(rt.state.dirty, true, '书目失败 → 仍算未保存（再按一次会重试）');
  assert.equal(rt.counts.syncChars, 1, '字数缓存先用主进程回的值更新');
  assert.equal(rt.counts.toast.length, 1);
  assert.equal(rt.counts.toast[0][1], 'warn', '部分成功用 warn，不是「保存失败」error');
  assert.equal(/^保存失败/.test(rt.counts.toast[0][0]), false);
});

test('A3-A / B5：载章状态机——大章软提示 / 在途过期回执不覆盖眼前章 / 失败保持遮罩', async () => {
  // ① 大章：chars 缓存 60 万 → 一条 info；阈值严格大于（500000 本身不提示）。
  const big = makeHost();
  big.state.chapters = [{ id: 'c1', name: '第一章', file: '001.txt', chars: 600000 }];
  big.editorEl.value = '旧章正文';
  const ok = await big.ui.loadChapterAt(0);
  assert.equal(ok.ok, true);
  assert.equal(big.editorEl.value, '正文-001.txt', '成功才提交正文');
  assert.equal(big.state.loadedChapterId, 'c1');
  assert.equal(big.state.baseText, '正文-001.txt');
  assert.equal(big.state.dirty, false);
  assert.equal(big.editorEl.placeholder, 'placeholder', '有效章节载入要解除遮罩（恢复原文案）');
  assert.equal(big.editorEl.readOnly, false, '载章结束要解除只读');
  assert.equal(big.counts.toast.length, 1, '大章只许一条软提示');
  assert.equal(big.counts.toast[0][1], 'info');
  assert.match(big.counts.toast[0][0], /本章超过 50 万字/);

  // ② 在途过期回执：第二次载章先完成，第一次迟到 —— 必须丢弃，不许覆盖眼前章。
  const stale = makeHost();
  stale.state.chapters = [{ id: 'c1', name: '第一章', file: '001.txt', chars: 0 }, { id: 'c2', name: '第二章', file: '002.txt', chars: 0 }];
  const g1 = deferred();
  const g2 = deferred();
  const order = [];
  stale.host.api.loadChapter = (bookPath, file) => {
    order.push(file);
    if (file === '001.txt') return g1.promise;
    return g2.promise;
  };
  const first = stale.ui.loadChapterAt(0);
  const second = stale.ui.loadChapterAt(1);
  g2.release({ ok: true, data: { text: '第二章正文', mtimeMs: 2 } });
  const secondResult = await second;
  assert.equal(secondResult.ok, true);
  g1.release({ ok: true, data: { text: '第一章正文（迟到）', mtimeMs: 1 } });
  const firstResult = await first;
  assert.equal(firstResult.code, 'STALE', '过期回执必须返回 STALE');
  assert.equal(stale.editorEl.value, '第二章正文', '过期回执不许覆盖眼前章');
  assert.equal(stale.state.index, 1, 'index 也不许被过期回执推回去');
  assert.equal(stale.state.loadedChapterId, 'c2');

  // ③ 载章失败且没有任何有效章：保持遮罩 + 一条 error，编辑区仍是旧内容（readOnly 由遮罩管）。
  const fail = makeHost();
  fail.state.chapters = [{ id: 'c1', name: '第一章', file: '001.txt', chars: 0 }];
  fail.state.loadedChapterId = '';
  fail.host.api.loadChapter = async () => ({ ok: false, code: 'ENOENT', message: 'ENOENT: 文件不存在（模拟）' });
  const failed = await fail.ui.loadChapterAt(0);
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'ENOENT');
  assert.match(fail.editorEl.placeholder, /当前章节没有载入/, '没有有效章节 → 保持遮罩');
  assert.equal(fail.editorEl.readOnly, true, '遮罩态编辑区只读');
  assert.equal(fail.editorEl.attributes['aria-busy'], 'true');
  assert.equal(fail.counts.toast.length, 1);
  assert.equal(fail.counts.toast[0][1], 'error');

  // ④ 活绑定：模块 create 之后替换 testLoadChapter，载章 IPC 必须走新注入（E2E 延迟注入不静默失效）。
  const live = makeHost();
  live.state.chapters = [{ id: 'c1', name: '第一章', file: '001.txt', chars: 0 }];
  let injected = 0;
  live.host.setTestLoadChapter(async (loadChapter, bookPath, file) => {
    injected += 1;
    return loadChapter(bookPath, file);
  });
  await live.ui.loadChapterAt(0);
  assert.equal(injected, 1, '测试钩子 setter 之后，载章必须走注入的延迟包装');
});

test('REDT-B-02：载章成功后的书签恢复抛错，不许把载章回执翻成「读取章节失败」', async () => {
  const rt = makeHost({ restoreBookmarkThrows: true });
  rt.state.chapters = [{ id: 'c1', name: '第一章', file: '001.txt', chars: 0 }];
  rt.editorEl.value = '';
  const res = await rt.ui.loadChapterAt(0);
  assert.equal(res.ok, true, '书签只是显示增强，失败不许翻转成功载章');
  assert.equal(rt.editorEl.value, '正文-001.txt');
  assert.equal(rt.state.loadedChapterId, 'c1');
  assert.equal(rt.state.baseText, '正文-001.txt');
  assert.equal(rt.state.dirty, false, '编辑区=磁盘版=baseText，脏标记不许被假错误置脏');
  assert.equal(rt.counts.restore, 1, '书签恢复确实跑过（失败发生在它内部）');
  assert.equal(rt.counts.toast.length, 0, '不许弹「读取章节失败」');
});

test('A3-A / B6：关窗三选——模态框打开先放行 false；保存失败后选「放弃修改退出」要清脏再放行', async () => {
  // ① 已有模态框：先拒绝关窗（不许把询问压在弹层下面）。
  const modal = makeHost();
  modal.state.modal = true;
  await modal.ui.handleCloseRequest();
  assert.deepEqual(modal.counts.closeReady, [false]);

  // ② 干净：直接放行 true。
  const clean = makeHost();
  clean.state.dirty = false;
  await clean.ui.handleCloseRequest();
  assert.deepEqual(clean.counts.closeReady, [true]);
  assert.equal(clean.counts.flush, 1, '关窗前先把秒表整秒记下');

  // ③ 脏 + 选「不保存退出」：先清脏（主进程会按上报的脏状态拦关窗），再放行。
  const discard = makeHost({ unsavedAction: 'discard' });
  await discard.ui.handleCloseRequest();
  assert.equal(discard.state.dirty, false, '放弃退出要先清脏');
  assert.deepEqual(discard.counts.closeReady, [true]);
  assert.equal(discard.counts.modal.length, 0, 'discard 分支不再弹二次框');

  // ④ 脏 + 保存失败 → 二次框选「放弃修改退出」：仍要清脏 + 放行。
  const failed = makeHost({ unsavedAction: 'save', modalAction: 'discard' });
  failed.host.api.saveChapter = async () => ({ ok: false, code: 'ENOSPC', message: 'ENOSPC: 没空间了（模拟）' });
  await failed.ui.handleCloseRequest();
  assert.equal(failed.counts.modal.length, 1, '保存失败要问一次「仍要退出吗」');
  assert.match(failed.counts.modal[0].message, /保存失败：ENOSPC/);
  assert.equal(failed.state.dirty, false, '放弃修改退出要清脏');
  assert.deepEqual(failed.counts.closeReady, [true]);

  // ⑤ 保存失败 + 选「返回保存」：保持脏、拒绝关窗。
  const back = makeHost({ unsavedAction: 'save', modalAction: 'cancel' });
  back.host.api.saveChapter = async () => ({ ok: false, code: 'EPERM', message: 'EPERM: 拒绝访问（模拟）' });
  await back.ui.handleCloseRequest();
  assert.equal(back.state.dirty, true);
  assert.deepEqual(back.counts.closeReady, [false]);
});

test('A3-A / B7：只读态 / 遮罩——开书在途与载章在途都锁编辑区，遮罩解除恢复原文案', () => {
  const rt = makeHost({ openingBook: true });
  rt.ui.applyEditorEditable();
  assert.equal(rt.editorEl.readOnly, true, '开书在途 → 只读');
  assert.equal(rt.editorEl.attributes['aria-busy'], 'true');
  rt.setOpeningBook(false);
  rt.ui.applyEditorEditable();
  assert.equal(rt.editorEl.readOnly, false, '开书结束 → 解锁');
  assert.equal('aria-busy' in rt.editorEl.attributes, false);

  rt.ui.setChapterMask(true, undefined);
  assert.equal(rt.editorEl.placeholder, '当前章节没有打开（换一章或重新打开本书）', '遮罩默认文案不变');
  rt.ui.setChapterMask(true, '自定义原因');
  assert.equal(rt.editorEl.placeholder, '自定义原因');
  rt.ui.setChapterMask(false);
  assert.equal(rt.editorEl.placeholder, 'placeholder', '解除遮罩恢复 index.html 原文案');
});

test('A3-A / B8：保存成功摘要文案仍走 saveLogic.savedToastText（不另造第二套格式）', async () => {
  const rt = makeHost();
  rt.state.chapters = [{ id: 'c1', name: '第一章', chars: 0 }, { id: 'c2', name: '第二章', chars: 0 }];
  rt.host.api.saveChapter = async () => ({ ok: true, data: { chars: 18, mtimeMs: 222, snapshot: { taken: true } } });
  await rt.ui.saveCurrent();
  assert.equal(rt.counts.saveStatus.length, 1);
  assert.equal(rt.counts.saveStatus[0], '已保存：2 章 · 本章 18 字 · 今日快照已留');
});

// ---------- 五-H2 / 五-H3 / 五-M9（第五轮审计 BP-02 / BP-03 / L-F1 / ES-2） ----------
// 缺陷：共享的「还原前未保存拦截」保存分支只看 saved.ok（保存 IPC 期间敲的字让 dirty 重新为 true 也放行），
// discard 分支什么都不做（不清 dirty）→ 下游 reloadOpenBookFromDisk 的脏闸拒载：磁盘已还原、编辑区仍是
// 作者刚明确选择丢弃的旧脏文、toast 却报「已还原 N 章」；关窗链则不等在途保存，必然撞 BUSY 并弹
// 「保存失败：正在保存中… / 仍要退出吗？」。修法：统一 saveForTransition 原语 + 关窗先等 saving idle。

test('五-H2/H3：saveForTransition —— 保存回执后复核 dirty；仍脏再问，明确丢弃才清脏放行', async () => {
  // ① 保存期间敲字：保存成功 ≠ 干净 → 必须第二次询问；作者取消 → 过渡不继续，编辑区的字一个字不丢。
  const answers = ['save', 'cancel'];
  const rt = makeHost({ get unsavedAction() { return answers.shift() || 'cancel'; } });
  rt.state.dirty = true;
  rt.editorEl.value = '作者原稿';
  rt.host.api.saveChapter = async (...args) => {
    rt.counts.saveCalls.push(args);
    rt.editorEl.value = '作者原稿 + 保存期间敲的字';
    return { ok: true, data: { chars: 20, mtimeMs: 333, snapshot: { taken: true } } };
  };
  const result = await rt.ui.saveForTransition({
    title: '还原前先处理未保存的修改',
    message: '还原会覆盖磁盘正文。',
    saveLabel: '保存修改后再还原',
    discardLabel: '放弃修改并还原'
  });
  assert.deepEqual(result, { ok: false, canceled: true }, '仍脏时作者取消 → 过渡不继续');
  assert.equal(rt.counts.saveCalls.length, 1, '先保存一次');
  assert.equal(rt.counts.askUnsaved, 2, '保存回执后复核到仍脏必须再问一次（不许只看 saved.ok）');
  assert.equal(rt.state.dirty, true, '保存期间的字仍标记为脏');
  assert.equal(rt.editorEl.value, '作者原稿 + 保存期间敲的字', '编辑区的字一个字不丢');

  // ② 明确「丢弃」：清 dirty + 同步基线 / 状态栏 —— 下游 reloadOpenBookFromDisk 的脏闸靠这个放行。
  const discard = makeHost({ unsavedAction: 'discard' });
  discard.state.dirty = true;
  discard.editorEl.value = '作者选择丢弃的旧脏文';
  const discarded = await discard.ui.saveForTransition({ title: '还原前先处理未保存的修改', message: '还原会覆盖磁盘正文。' });
  assert.deepEqual(discarded, { ok: true, discarded: true });
  assert.equal(discard.state.dirty, false, '丢弃必须清脏（否则还原结果被脏闸拒载）');
  assert.equal(discard.state.baseText, '作者选择丢弃的旧脏文', '基线同步到编辑区，后续输入按它重算 dirty');
  assert.ok(discard.counts.status >= 1, '状态栏 / 窗口标题要跟着刷新');
  assert.equal(discard.counts.saveCalls.length, 0, '丢弃不该写盘');
  assert.equal(
    longOpLogic.canReloadFromDisk({ expectedBookPath: 'x', currentBookPath: 'x', dirty: discard.state.dirty }),
    true,
    '清脏后 reloadOpenBookFromDisk 的闸门放行'
  );

  // ③ 已经干净：不弹框、不保存。
  const clean = makeHost();
  clean.state.dirty = false;
  assert.deepEqual(await clean.ui.saveForTransition({ title: 't' }), { ok: true });
  assert.equal(clean.counts.askUnsaved, 0);
  assert.equal(clean.counts.saveCalls.length, 0);

  // ④ silentFirst（捕获面板「章节」的口径）：首趟静默保存；只有保存期间又输入才交给作者决定。
  const silent = makeHost({ unsavedAction: 'cancel' });
  silent.state.dirty = true;
  silent.editorEl.value = '静默保存的正文';
  const silentGuard = await silent.ui.saveForTransition({ silentFirst: true, title: 't', message: 'm' });
  assert.deepEqual(silentGuard, { ok: true });
  assert.equal(silent.counts.saveCalls.length, 1);
  assert.equal(silent.counts.askUnsaved, 0, '没人在保存期间输入 → 不需要再问');
});

test('五-M9（ES-2）：关窗撞上保存在途 → 先等它落定再判定，不把 BUSY 当「保存失败」弹误导框', async () => {
  const rt = makeHost({ unsavedAction: 'save' }); // 没等的话会走 save → BUSY → 弹「保存失败」
  rt.state.dirty = true;
  rt.editorEl.value = '正在保存的正文';
  const gate = deferred();
  rt.host.api.saveChapter = (...args) => {
    rt.counts.saveCalls.push(args);
    return gate.promise;
  };
  const pendingSave = rt.ui.saveCurrent();
  await flush();
  assert.equal(rt.state.saving, true, '保存 IPC 在途');
  const close = rt.ui.handleCloseRequest();
  await flush();
  gate.release({ ok: true, data: { chars: 9, mtimeMs: 444, snapshot: { taken: true } } });
  await pendingSave;
  await close;
  assert.deepEqual(rt.counts.closeReady, [true], '等保存落定后按干净放行');
  assert.equal(rt.counts.modal.length, 0, '不许把 BUSY 弹成「保存失败」');
  assert.equal(rt.counts.askUnsaved, 0, '保存已落定且干净 → 不用再问三选一');
  assert.equal(rt.counts.saveCalls.length, 1, '在途那笔保存只写一次');
});