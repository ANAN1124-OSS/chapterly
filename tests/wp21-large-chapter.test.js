// WP21（N3）：大章载入软提示。
//
// 缺陷：载入显示字数 >50 万的章节时没有任何软告知（大章编辑 / 查找 / 标记会慢），作者只能自己
// 从状态栏数字猜。审计 N3 建议补一条**非阻塞** toast——不拒载、不写 state / dirty / baseText / 遮罩。
//
// 另外两处相邻口径必须区分、不许重复造：
//   · renderer/editor-marks-ui.js「超过 30 万字」= 标记层整层收起的一次性 warn，不是载入告知；
//   · core/capture.js MAX_RAW_CHARS = 3,000,000 / checkCaptureLimits → capture-ui 的「去导入小说…」
//     出口（N3 的 raw 半，台账 #2 已覆盖）——载入软提示不得再抄一份捕获限额常量。
//
// 为什么这样测：renderer.js 是浏览器 IIFE，Node 里不能整体 require；loadChapterAt 是函数声明、
// 被切章 / 书架 / 测试钩子多处调用，搬不出去。这里按大括号配对从源码精确切出 loadChapterAt 真身，
// 注入假 host 执行——阈值常量本身也从 renderer.js 源码读，测试不另抄一份数字。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const chaptersLib = require('../core/chapters');
const captureLib = require('../core/capture');

const ROOT = path.join(__dirname, '..');
const RENDERER_SRC = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const CAPTURE_UI_SRC = fs.readFileSync(path.join(ROOT, 'renderer', 'capture-ui.js'), 'utf8');
const CAPTURE_SRC = fs.readFileSync(path.join(ROOT, 'core', 'capture.js'), 'utf8');

// 从源码切一个顶层「  [async] function 名字( ... ) { ... }」的真身：先按括号配对跳过形参
// （loadChapterAt 的形参简单，但同一把尺子继续用），再从函数体起始的大括号按配对切到收尾。
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
    if (ch === '\\') { i += 1; continue; }
    if (ch === '`') mode = 'code';
  }
  throw new Error(`function ${name} 的大括号没有配对`);
}

const loadChapterAtSrc = extractFunction(RENDERER_SRC, 'loadChapterAt');
// 阈值只许有一份：渲染层模块级常量。测试从源码读，不硬编码第二份数字。
const softCharsMatch = /const LARGE_CHAPTER_SOFT_CHARS = (\d+);/.exec(RENDERER_SRC);
const sourceSoftChars = softCharsMatch ? Number(softCharsMatch[1]) : undefined;

const LARGE_CHAPTER_MESSAGE = '本章超过 50 万字，编辑/查找可能较慢，可考虑拆分章节';

// 普通字符串拼接（不用模板字面量包源码）：loadChapterAt 源码里带 `${...}`。
const RUNTIME_BODY = [
  'const {',
  '  state, editorEl, api, call, testLoadChapter, toast, chaptersLib,',
  '  applyEditorEditable, setChapterMask, clearFindSession, stopTtsForChapterChange,',
  '  syncActiveChapterItem, renderEditorHeader, updateStatus, renderSelectionStats,',
  '  scheduleMarksRender, scheduleTypewriterAlign, restoreFindBookmarkForCurrentChapter,',
  '  counts, largeChapterSoftChars',
  '} = deps;',
  'let loadChapterSeq = 0;',
  'let bulkWriteUndo = null;',
  'let fallbackWriteUndo = null;',
  'const LARGE_CHAPTER_SOFT_CHARS = largeChapterSoftChars;',
  'function notifyLoadingIdle() { counts.loadingIdle += 1; }',
  loadChapterAtSrc,
  'return { loadChapterAt, seq: () => loadChapterSeq, bulk: () => bulkWriteUndo, fallback: () => fallbackWriteUndo };'
].join('\n');

const createRuntime = new Function('deps', RUNTIME_BODY);

async function callHost(fn, ...args) {
  const res = await fn(...args);
  if (!res || res.ok === false) {
    const err = new Error((res && res.message) || '未知错误');
    err.code = res && res.code;
    throw err;
  }
  return res.data;
}

function deferredResult() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

function makeRuntime(options = {}) {
  const counts = {
    toast: [],
    mask: [],
    loadingIdle: 0,
    modal: 0,
    editable: 0,
    header: 0,
    status: 0,
    selectionStats: 0,
    marks: 0,
    typewriter: 0,
    restore: 0,
    syncActive: 0,
    tts: 0,
    clearFind: 0,
    loadCalls: [],
    lastOpen: 0
  };
  const state = {
    bookPath: 'C:/tmp/books/测试书',
    index: -1,
    chapters: options.chapters || [],
    loadedChapterId: options.loadedChapterId === undefined ? '' : options.loadedChapterId,
    loadedMtimeMs: 99,
    dirty: true,
    saveError: '旧错误',
    meta: { title: '测试书' },
    find: { total: 0, fromBookmark: false },
    focus: { on: true, typewriter: true, savedScrollTop: 5, savedCaret: 5, savedCaretOffset: 5 }
  };
  const editorEl = {
    value: '旧章正文',
    scrollTop: 3,
    readOnly: false,
    placeholder: 'placeholder',
    setAttribute() {},
    removeAttribute() {}
  };
  const gates = {};
  const api = {
    loadChapter: (bookPath, file) => {
      counts.loadCalls.push(file);
      if (gates[file]) return gates[file].promise;
      const entry = (options.loadResults && options.loadResults[file]) || {
        ok: true,
        data: { text: `正文-${file}`, mtimeMs: 123, size: 10 }
      };
      return Promise.resolve(entry);
    },
    setLastOpenChapter: async () => {
      counts.lastOpen += 1;
      return { ok: true, data: {} };
    }
  };
  const deps = {
    state,
    editorEl,
    api,
    call: callHost,
    testLoadChapter: null,
    toast: (message, kind) => { counts.toast.push([message, kind]); },
    chaptersLib,
    applyEditorEditable: () => { counts.editable += 1; },
    setChapterMask: (masked, placeholder) => { counts.mask.push([masked, placeholder]); },
    clearFindSession: () => { counts.clearFind += 1; },
    stopTtsForChapterChange: () => { counts.tts += 1; },
    syncActiveChapterItem: () => { counts.syncActive += 1; },
    renderEditorHeader: () => { counts.header += 1; },
    updateStatus: () => { counts.status += 1; },
    renderSelectionStats: () => { counts.selectionStats += 1; },
    scheduleMarksRender: () => { counts.marks += 1; },
    scheduleTypewriterAlign: () => { counts.typewriter += 1; },
    restoreFindBookmarkForCurrentChapter: async () => { counts.restore += 1; },
    counts,
    largeChapterSoftChars: sourceSoftChars
  };
  const runtime = createRuntime(deps);
  return {
    ...runtime,
    state,
    editorEl,
    calls: counts,
    gate: (file, payload) => {
      const d = deferredResult();
      gates[file] = d;
      return (value) => d.release(value === undefined ? payload : value);
    }
  };
}

const TEXT_600K = '字'.repeat(600000);

test('R1（N3·红→绿）：载入 chars=600000 的章 → 恰好一条 info 软提示、不阻塞、不写 dirty/正文/遮罩', async () => {
  const text = TEXT_600K;
  const rt = makeRuntime({
    chapters: [{ id: 'c1', name: '第一章', file: '001.txt', chars: 600000 }],
    loadResults: { '001.txt': { ok: true, data: { text, mtimeMs: 111, size: 900000 } } }
  });
  const result = await rt.loadChapterAt(0);
  assert.equal(result.ok, true, '大章照常载入（软提示不是限载）');
  assert.equal(rt.calls.toast.length, 1, `大章载入只许一条软提示（实测 ${rt.calls.toast.length}）`);
  assert.equal(rt.calls.toast[0][0], LARGE_CHAPTER_MESSAGE, '提示文案要写明 50 万 / 可考虑拆分');
  assert.equal(rt.calls.toast[0][1], 'info', '软提示不能是 error/warn 口径');
  assert.equal(rt.calls.modal, 0, '不许弹模态框打断作者（非阻塞）');
  assert.equal(rt.state.dirty, false, '载入成功仍是干净状态（提示不得把 dirty 弄脏）');
  assert.equal(rt.state.baseText, text);
  assert.equal(rt.editorEl.value, text, '正文必须原样进编辑区');
  assert.equal(rt.state.saveError, null);
  assert.equal(rt.state.loading, false, '载章锁必须落回');
  assert.equal(rt.calls.loadingIdle, 1);
  assert.deepEqual(rt.calls.mask[rt.calls.mask.length - 1], [false, undefined], '成功载入要解除遮罩');
  assert.equal(rt.calls.loadCalls.length, 1);
  // 同一章再载一次：每次成功载入各一条，同一次载入内不重复。
  const second = await rt.loadChapterAt(0);
  assert.equal(second.ok, true);
  assert.equal(rt.calls.toast.length, 2, '每次成功载入各一条（同一次载入内至多一条）');
});

test('R1b（N3·回落口径）：书目缓存 chars 缺失（null）时按 data.text 去空白字数判定，大章仍提示', async () => {
  const text = `\n\t${TEXT_600K}\n`;
  const rt = makeRuntime({
    chapters: [{ id: 'c1', name: '第一章', file: '001.txt', chars: null }],
    loadResults: { '001.txt': { ok: true, data: { text, mtimeMs: 111, size: 900000 } } }
  });
  await rt.loadChapterAt(0);
  assert.equal(rt.calls.toast.length, 1, 'chars 缓存缺失（null）不许按 0 字处理而漏提示');
  assert.equal(rt.calls.toast[0][0], LARGE_CHAPTER_MESSAGE);
  // 空白重型文本：显示字数（去空白）才是口径，不能按原文长度糊弄。
  const sparse = makeRuntime({
    chapters: [{ id: 'c1', name: '第一章', file: '001.txt', chars: null }],
    loadResults: { '001.txt': { ok: true, data: { text: ' \n'.repeat(400000), mtimeMs: 111, size: 800000 } } }
  });
  await sparse.loadChapterAt(0);
  assert.equal(sparse.calls.toast.length, 0, '全空白 80 万字符 = 显示 0 字，不是大章');
});

test('R2（保护）：499999 / 恰好 500000 / 普通章 → 一条提示都没有，载入状态与修复前逐字段一致', async () => {
  const cases = [
    { file: 'a.txt', chars: 499999, text: 'a'.repeat(499999) },
    { file: 'b.txt', chars: 500000, text: 'b'.repeat(500000) },
    { file: 'c.txt', chars: 1000, text: 'c'.repeat(1000) }
  ];
  const rt = makeRuntime({
    chapters: cases.map((item, index) => ({ id: `c${index}`, name: `第${index + 1}章`, file: item.file, chars: item.chars })),
    loadResults: Object.fromEntries(cases.map((item) => [item.file, { ok: true, data: { text: item.text, mtimeMs: 200 + item.chars, size: item.text.length } }]))
  });
  for (let i = 0; i < cases.length; i += 1) {
    const result = await rt.loadChapterAt(i);
    assert.equal(result.ok, true);
    assert.equal(result.data.text, cases[i].text);
    assert.equal(rt.state.index, i);
    assert.equal(rt.state.loadedChapterId, `c${i}`);
    assert.equal(rt.state.loadedMtimeMs, 200 + cases[i].chars);
    assert.equal(rt.state.baseText, cases[i].text);
    assert.equal(rt.state.dirty, false);
    assert.equal(rt.state.saveError, null);
    assert.equal(rt.editorEl.value, cases[i].text);
    assert.equal(rt.editorEl.scrollTop, 0);
    assert.equal(rt.state.loading, false);
    assert.equal(rt.bulk(), null, '换章后大段插入快照必须作废');
    assert.equal(rt.calls.loadingIdle, i + 1);
  }
  assert.equal(rt.calls.toast.length, 0, '≤50 万字一个字提示都不许多发（严格大于阈值）');
  assert.equal(rt.calls.modal, 0);
  assert.equal(rt.calls.mask.length, cases.length, '成功载入每次都解除遮罩');
});

test('R3（保护·失败注入）：stale 载入 / 读盘失败 / 无书早退 → 都不提示软提示，遮罩语义不变', async () => {
  // 3a 载章在途切章：先发大章 A（在途），再发小章 B 成功；A 回来已过期 → 无提示。
  const rt = makeRuntime({
    chapters: [
      { id: 'c1', name: '第一章', file: 'a.txt', chars: 600000 },
      { id: 'c2', name: '第二章', file: 'b.txt', chars: 1000 }
    ],
    loadResults: { 'b.txt': { ok: true, data: { text: '小章正文', mtimeMs: 321, size: 6 } } }
  });
  const releaseA = rt.gate('a.txt');
  const first = rt.loadChapterAt(0);
  const second = await rt.loadChapterAt(1);
  assert.equal(second.ok, true);
  releaseA({ ok: true, data: { text: TEXT_600K, mtimeMs: 111, size: 900000 } });
  const stale = await first;
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'STALE', '过期回执必须丢弃');
  assert.equal(rt.calls.toast.length, 0, 'stale 载入不许提示大章软提示（也不许提示别的）');
  assert.equal(rt.editorEl.value, '小章正文', '过期回执不许覆盖眼前这一章');
  assert.equal(rt.state.index, 1);
  assert.equal(rt.state.loading, false);

  // 3b 读盘失败（ENOSPC）：只有 error toast，没有大章软提示；没有有效章节 → 保持遮罩。
  const failed = makeRuntime({
    chapters: [{ id: 'c1', name: '第一章', file: 'e.txt', chars: 600000 }],
    loadResults: { 'e.txt': { ok: false, code: 'ENOSPC', message: '磁盘已满，读不出来' } }
  });
  const bad = await failed.loadChapterAt(0);
  assert.deepEqual(bad, { ok: false, code: 'ENOSPC', message: '磁盘已满，读不出来' });
  assert.equal(failed.calls.toast.length, 1, '失败只许一条错误提示');
  assert.equal(failed.calls.toast[0][0], '读取章节失败：磁盘已满，读不出来');
  assert.equal(failed.calls.toast[0][1], 'error');
  assert.deepEqual(failed.calls.mask[failed.calls.mask.length - 1], [true, '当前章节没有载入（文件缺失或读取失败），换一章或重新打开本书'], '没有有效章节时保持遮罩并写明原因');
  assert.equal(failed.state.loading, false);
  assert.equal(failed.calls.loadingIdle, 1);

  // 3c 抛错载入 + 已有有效章节：不遮罩、不提示大章。
  const thrown = makeRuntime({
    chapters: [{ id: 'c1', name: '第一章', file: 'x.txt', chars: 600000 }],
    loadedChapterId: 'c0',
    loadResults: {}
  });
  // 让 api 直接抛错（不是 {ok:false}）
  const releaseThrow = thrown.gate('x.txt');
  const throwing = thrown.loadChapterAt(0);
  releaseThrow(Promise.reject(new Error('EACCES: 权限不足')));
  const errResult = await throwing;
  assert.equal(errResult.ok, false);
  assert.equal(errResult.code, 'LOAD_FAILED');
  assert.equal(thrown.calls.toast.length, 1);
  assert.equal(thrown.calls.toast[0][1], 'error', '抛错只走既有错误提示');
  assert.notEqual(thrown.calls.toast[0][0], LARGE_CHAPTER_MESSAGE, '失败路径不许冒充大章软提示');
  assert.equal(thrown.calls.mask.length, 0, '已有有效章节时失败不遮罩（V101 语义不变）');

  // 3d 无书早退：不提示。
  const empty = makeRuntime({ chapters: [] });
  assert.deepEqual(await empty.loadChapterAt(0), { ok: false, code: 'NO_BOOK' });
  assert.equal(empty.calls.toast.length, 0);
});

test('R4（保护·已覆盖证据）：捕获 raw 超限提示沿用 capture 唯一口径，不新增第二份限额常量', () => {
  // raw 半（N3 的另一半）在 capture 唯一实现里已覆盖：>3,000,000 原文 → reason='raw' → 去导入小说出口。
  const over = 'x'.repeat(captureLib.MAX_RAW_CHARS + 1);
  const limits = captureLib.checkCaptureLimits(over);
  assert.equal(limits.tooLarge, true);
  assert.equal(limits.reason, 'raw');
  assert.equal(limits.rawLength, captureLib.MAX_RAW_CHARS + 1);
  assert.match(CAPTURE_SRC, /const MAX_RAW_CHARS = 3000000;/, '捕获原文上限唯一实现在 core/capture.js');
  assert.match(CAPTURE_UI_SRC, /captureLib\.checkCaptureLimits\(text\)/, '捕获面板走同一份限额判定');
  assert.match(CAPTURE_UI_SRC, /limits\.reason === 'raw'/, 'reason=raw 走原文口径文案');
  assert.match(CAPTURE_UI_SRC, /去导入小说/, 'raw 超限必须保留「去导入小说…」出口');
  assert.doesNotMatch(RENDERER_SRC, /3000000/, '渲染层不许抄第二份捕获原文上限（台账 #2 教训）');
  // 载入软提示是另一个口径（按显示字数 50 万，非硬限）；它是否已存在由下面的静态闸门钉住，
  // 这一条在修复前就该是绿的——证明 N3 的 raw 半早已覆盖，本轮不需要也不许改 capture。
});

test('静态闸门：软提示只一条、严格大于阈值、位置在成功提交之后且在 return 之前、不写 state', () => {
  assert.match(RENDERER_SRC, /\n  const LARGE_CHAPTER_SOFT_CHARS = 500000;/, 'renderer.js 需要模块级 LARGE_CHAPTER_SOFT_CHARS = 500000');
  assert.equal((RENDERER_SRC.match(/const LARGE_CHAPTER_SOFT_CHARS/g) || []).length, 1, '阈值只许定义一份');
  assert.match(RENDERER_SRC, /载入大章软告知阈值[\s\S]{0,600}30 万[\s\S]{0,400}raw/, '常量注释要写明区别于标记层 30 万 / 捕获 raw 3M');
  assert.equal((loadChapterAtSrc.match(/本章超过 50 万字/g) || []).length, 1, '一次载入路径只许一条大章提示');
  assert.match(loadChapterAtSrc, /if \(loadedChars > LARGE_CHAPTER_SOFT_CHARS\)/, '阈值必须严格大于（500000 本身不提示）');
  assert.match(loadChapterAtSrc, /toast\('本章超过 50 万字，编辑\/查找可能较慢，可考虑拆分章节', 'info'\)/, '非阻塞 info 软提示');
  const commitAt = loadChapterAtSrc.indexOf('editorEl.value = data.text;');
  const hintAt = loadChapterAtSrc.indexOf('LARGE_CHAPTER_SOFT_CHARS');
  const returnAt = loadChapterAtSrc.indexOf('return { ok: true, data };');
  assert.ok(commitAt >= 0, '成功路径必须仍提交编辑区');
  assert.ok(hintAt > commitAt, '软提示必须在成功提交之后才判定（失败 / stale 提前返回不提示）');
  assert.ok(returnAt > hintAt, '软提示必须在成功 return 之前');
  // 软提示块不写 state / dirty / baseText / 遮罩（只读判定 + 一条 toast）。
  const block = loadChapterAtSrc.slice(loadChapterAtSrc.lastIndexOf('// N3', hintAt), returnAt);
  assert.ok(block.length > 0, '找不到软提示代码块');
  assert.doesNotMatch(block, /state\.[A-Za-z0-9_]+\s*=(?!=)/, '软提示块不许写 state');
  assert.doesNotMatch(block, /setChapterMask\(/, '软提示块不许动遮罩');
  assert.doesNotMatch(block, /applyEditorEditable\(/, '软提示块不许动只读态');
});