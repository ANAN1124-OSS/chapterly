// WP20（R-N2）：覆盖保存 force 重入单收尾。
//
// 缺陷：save-rescue-ui.js 的「仍然覆盖保存」会先解除 state.saving，再重进 saveCurrent({force:true})——
// 内层 saveCurrent 自带 try/finally（notifySavingIdle + updateStatus），返回外层 catch 后外层 finally
// 又收尾一次 = 同一笔用户保存双收尾（状态栏双跳、等待者被提前唤醒）。审计 R-N2。
//
// 为什么这样测：renderer.js 是浏览器 IIFE，Node 里不能整体 require；saveCurrent 是函数声明、被 8 个
// 入口与 test-hooks 闭包共享，搬不出去（见 tests/test-hooks.test.js 行预算说明）。这里从源码里按
// 大括号配对精确切出 saveCurrent / waitForSavingIdle / notifySavingIdle 三段真身，注入假 host 后执行，
// 覆盖保存分支用的仍是**真的** renderer/save-rescue-ui.js（假 openModal 只负责点按钮）——双收尾真的
// 发生在 renderer 的 finally 嵌套里，不是把语义抄进测试。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const saveRescueUiModule = require('../renderer/save-rescue-ui');
const saveLogic = require('../renderer/save-logic');

const RENDERER_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
// WP17 A3 第二刀：saveCurrent / 等待者 / saveDepth 整段迁到 save-chain-ui.js；函数真身改从模块切。
const SAVE_CHAIN_SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'save-chain-ui.js'), 'utf8');

// 从源码切一个顶层「  [async] function 名字( ... ) { ... }」的真身：先按括号配对跳过形参
// （saveCurrent 的形参里有解构大括号），再从函数体起始的大括号按配对切到收尾——不能用
// 「下一个同缩进 function」当边界，那会把中间大段 const 装配也带进来。
function extractFunction(source, name) {
  const marker = new RegExp(`(?:^|\\n)  (async )?function ${name}\\(`);
  const match = marker.exec(source);
  assert.ok(match, `renderer.js 里找不到 function ${name}(`);
  const start = match.index + (match[0].startsWith('\n') ? 1 : 0);
  const parenStart = source.indexOf('(', start);
  assert.ok(parenStart > start, `function ${name} 没有形参表`);
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
  assert.ok(bodyStart > cursor, `function ${name} 没有函数体`);
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
    if (mode === 'single') {
      if (ch === '\\') { i += 1; continue; }
      if (ch === "'") mode = 'code';
      continue;
    }
    if (mode === 'double') {
      if (ch === '\\') { i += 1; continue; }
      if (ch === '"') mode = 'code';
      continue;
    }
    // template：模板里的 ${...} 与正文里的花括号合成一对，忽略整段不影响配对
    if (ch === '\\') { i += 1; continue; }
    if (ch === '`') mode = 'code';
  }
  throw new Error(`function ${name} 的大括号没有配对`);
}

const saveCurrentSrc = extractFunction(SAVE_CHAIN_SRC, 'saveCurrent');
const waitForSavingIdleSrc = extractFunction(SAVE_CHAIN_SRC, 'waitForSavingIdle');
const notifySavingIdleSrc = extractFunction(SAVE_CHAIN_SRC, 'notifySavingIdle')
  .replace('function notifySavingIdle(', 'function notifySavingIdleRaw(');

// 注意：这里必须用普通字符串拼接，不能用模板字面量——saveCurrent 源码里带 `${...}`。
const RUNTIME_BODY = [
  'const {',
  '  state, editorEl, api, call, getTestSaveChapter, getCrashRecoveryUi, saveLogic, formatChars, toast,',
  '  saveStatusUi, syncChapterCharsAfterSave, renderChapterList,',
  '  renderStatsUi, flushWriteTimer, restoreFindBookmarkForCurrentChapter,',
  '  verifyBookInBackground, loadChapterAt, openModal, chapterTitle,',
  '  saveRescueUiModule, counts',
  '} = deps;',
  'let savingWaiters = [];',
  'let saveDepth = 0;',
  waitForSavingIdleSrc,
  notifySavingIdleSrc,
  'function notifySavingIdle() { counts.notify += 1; notifySavingIdleRaw(); }',
  'function updateStatus() { counts.status += 1; if (state.saving === false) counts.idleStatus += 1; }',
  saveCurrentSrc,
  'const saveRescueUi = saveRescueUiModule.create({ state, api, call, openModal, toast, editorEl, saveCurrent, loadChapterAt, chapterTitle });',
  'return { saveCurrent, waitForSavingIdle, saveRescueUi, depth: () => saveDepth };'
].join('\n');

const createRuntime = new Function('deps', RUNTIME_BODY);

// 与 renderer.js 的 call() 同口径（ApiError 的 code / 白名单 extra 都照抄）。
class ApiError extends Error {
  constructor(message, code, extra) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    if (extra && typeof extra === 'object') Object.assign(this, extra);
  }
}

async function callHost(fn, ...args) {
  const res = await fn(...args);
  if (!res || res.ok === false) {
    throw new ApiError((res && res.message) || '未知错误', res && res.code, saveLogic.saveFailureExtra(res));
  }
  return res.data;
}

function makeRuntime(options = {}) {
  const counts = {
    notify: 0,
    status: 0,
    idleStatus: 0,
    toast: [],
    saveArgs: [],
    modal: [],
    savedDetail: [],
    verify: 0,
    restore: 0,
    flush: 0,
    renderList: 0,
    renderStats: 0
  };
  const state = {
    bookPath: 'C:/tmp/books/测试书',
    index: 0,
    chapters: [{ id: 'c1', name: '第一章', chars: 0 }],
    loadedChapterId: 'c1',
    loadedMtimeMs: 111,
    dirty: true,
    saving: false,
    baseText: '',
    saveError: null,
    find: { total: 1, fromBookmark: false },
    writeTimer: { running: false, unsentMs: 0 }
  };
  const editorEl = { value: options.text === undefined ? '第一章正文快照' : options.text };
  let saveAttempt = 0;
  let resolveFirst = null;
  const firstGate = options.firstDeferred
    ? new Promise((resolve) => { resolveFirst = resolve; })
    : null;
  const api = {
    saveChapter: (...args) => {
      counts.saveArgs.push(args);
      saveAttempt += 1;
      if (saveAttempt === 1) {
        if (options.firstDeferred) return firstGate;
        if (options.firstError) return Promise.resolve({ ok: false, ...options.firstError });
      }
      if (options.retryError) return Promise.resolve({ ok: false, ...options.retryError });
      return Promise.resolve({ ok: true, data: { chars: 3, mtimeMs: 222 } });
    }
  };
  const deps = {
    state,
    editorEl,
    api,
    call: callHost,
    getTestSaveChapter: () => null,
    getCrashRecoveryUi: () => null,
    saveLogic,
    formatChars: (chars) => `${chars} 字`,
    toast: (message, kind) => { counts.toast.push([message, kind]); },
    saveStatusUi: { setSavedDetail: (text) => { counts.savedDetail.push(text); } },
    crashRecoveryUi: null,
    syncChapterCharsAfterSave: () => true,
    renderChapterList: () => { counts.renderList += 1; },
    renderStatsUi: () => { counts.renderStats += 1; },
    flushWriteTimer: async () => { counts.flush += 1; },
    restoreFindBookmarkForCurrentChapter: async () => { counts.restore += 1; },
    verifyBookInBackground: () => { counts.verify += 1; },
    loadChapterAt: async () => ({ ok: true }),
    openModal: async (payload) => {
      counts.modal.push(payload);
      return { action: options.modalAction || 'cancel' };
    },
    chapterTitle: (index, name) => `第${index + 1}章：${name}`,
    saveRescueUiModule,
    counts
  };
  const runtime = createRuntime(deps);
  return {
    ...runtime,
    state,
    editorEl,
    calls: counts,
    resolveFirst: (payload) => { if (resolveFirst) resolveFirst(payload); }
  };
}

test('R1（R-N2）：EXTERNAL_CHANGE → 「仍然覆盖保存」force 重入成功 → notifySavingIdle 恰好一次、状态栏收尾一次', async () => {
  const rt = makeRuntime({
    firstError: { code: 'EXTERNAL_CHANGE', message: '这一章在应用外被改过，已阻止这次保存。' },
    modalAction: 'overwrite'
  });
  const result = await rt.saveCurrent();
  assert.equal(result.ok, true, '覆盖保存成功：回执原样上抛');
  assert.equal(rt.calls.notify, 1, `一次用户保存只许唤醒等待者一次（实测 ${rt.calls.notify}）`);
  assert.equal(rt.calls.idleStatus, 1, `saving=false 后的状态栏收尾只许一次（实测 ${rt.calls.idleStatus}）`);
  assert.equal(rt.state.saving, false, 'saving 必须落回 false');
  assert.equal(rt.depth(), 0, '保存深度必须归零（异常路径也不许漏减）');
  assert.equal(rt.state.dirty, false, '编辑区没再改字：快照与活值一致 → 干净');
  assert.equal(rt.state.baseText, '第一章正文快照');
  assert.equal(rt.state.loadedMtimeMs, 222, '成功回执的 mtime 要落到编辑器基线');
  assert.deepEqual(rt.calls.modal.length, 1);
  assert.deepEqual(
    rt.calls.saveArgs.map((args) => args[3]),
    [111, 0],
    '外层用载入 mtime，覆盖重入必须用 force 哨兵 0（force 覆盖语义不改）'
  );
});

test('R2（保护）：普通保存成功 → notifySavingIdle 一次、状态栏收尾一次、已保存文案不变', async () => {
  const rt = makeRuntime({});
  const result = await rt.saveCurrent();
  assert.equal(result.ok, true);
  assert.equal(result.data.mtimeMs, 222);
  assert.equal(rt.calls.notify, 1);
  assert.equal(rt.calls.idleStatus, 1, '正常保存只有最外层一次收尾');
  assert.equal(rt.depth(), 0);
  assert.equal(rt.state.dirty, false);
  assert.deepEqual(rt.calls.savedDetail, ['已保存：1 章 · 本章 3 字']);
  assert.equal(rt.calls.saveArgs[0][3], 111);
});

test('R3（R-N2·失败注入）：覆盖重入内层再失败（ENOSPC）→ 仍单次收尾、saving 清 false、错误原样上抛', async () => {
  const rt = makeRuntime({
    firstError: { code: 'EXTERNAL_CHANGE', message: '这一章在应用外被改过，已阻止这次保存。' },
    modalAction: 'overwrite',
    retryError: { code: 'ENOSPC', message: '磁盘已满，写不进去' }
  });
  const result = await rt.saveCurrent();
  assert.deepEqual(result, { ok: false, code: 'ENOSPC', message: '磁盘已满，写不进去' }, '内层再失败必须如实上抛，不许吞成成功');
  assert.equal(rt.calls.notify, 1, `失败路径也只许唤醒一次（实测 ${rt.calls.notify}）`);
  assert.equal(rt.calls.idleStatus, 1, `失败路径的状态栏收尾也只许一次（实测 ${rt.calls.idleStatus}）`);
  assert.equal(rt.state.saving, false);
  assert.equal(rt.depth(), 0);
  assert.equal(rt.state.dirty, true, '没写盘成功：正文仍是未保存');
  assert.ok(
    rt.calls.toast.some(([message]) => message.includes('保存失败：磁盘已满')),
    '边界错误要有一条明确提示'
  );
});

test('R4（保护）：BUSY 并发仍拒；覆盖保存后 waitForSavingIdle 等待者恰好释放一次（关窗链不挂起）', async () => {
  const rt = makeRuntime({
    firstDeferred: true,
    modalAction: 'overwrite'
  });
  const first = rt.saveCurrent();
  assert.equal(rt.state.saving, true, '第一次保存已进入在途');
  const busy = await rt.saveCurrent();
  assert.equal(busy.code, 'BUSY', '保存中并发调用仍要拒（force 重入只在救稿出口里解除 saving 后才允许）');
  let woken = 0;
  const waiter = rt.waitForSavingIdle().then(() => { woken += 1; });
  rt.resolveFirst({ ok: false, code: 'EXTERNAL_CHANGE', message: '这一章在应用外被改过' });
  const result = await first;
  await waiter;
  assert.equal(result.ok, true);
  assert.equal(woken, 1, '等待者必须被释放（关窗链不许挂起），且只释放一次');
  assert.equal(rt.state.saving, false);
});

test('静态闸门：saveDepth 声明在模块级，saveCurrent 内只加减一次且只在深度归零时收尾', () => {
  assert.match(SAVE_CHAIN_SRC, /let saveDepth = 0;/, 'save-chain-ui.js 需要模块级 saveDepth（深度守卫）');
  assert.equal(/let saveDepth = 0;/.test(RENDERER_SRC), false, '编排器不许再留第二份深度状态');
  assert.equal((saveCurrentSrc.match(/saveDepth \+= 1;/g) || []).length, 1, '进入保存只许加一次深度');
  assert.equal((saveCurrentSrc.match(/saveDepth -= 1;/g) || []).length, 1, 'finally 只许减一次深度');
  assert.match(
    saveCurrentSrc,
    /finally \{\s*\n\s*saveDepth -= 1;[\s\S]*?state\.saving = false;[\s\S]*?if \(saveDepth === 0\) \{\s*\n\s*notifySavingIdle\(\);\s*\n\s*updateStatus\(\);/,
    '收尾（notifySavingIdle + updateStatus）必须挂在深度归零的判定里'
  );
  // 救稿模块的覆盖重入语义一个字都不许改：先解除 saving，再 force 重进同一条保存链。
  const rescueSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'save-rescue-ui.js'), 'utf8');
  assert.match(rescueSrc, /if \(action === 'overwrite'\) \{\s*\n\s*state\.saving = false;\s*\n\s*return saveCurrent\(\{ silent, force: true \}\);/, '覆盖重入仍先解除 saving 再 force 重进');
});