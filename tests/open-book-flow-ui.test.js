// M1（第一轮·低，第 12 轮第六刀）：换书入口 + 「提交新书」的**行为**锚点。
//
// 背景：openBookByPath + commitOpenBook（未保存拦截 → 世代号 → 开书 IPC → 提交新书 → 目标章解析 →
// 载章）以前长在 renderer.js 里，只有开 Electron 连点两本书才撞得到「过期响应盖掉后点的那本」
// 「目标章被删还把旧命中下标套上去」。第 12 轮把整段搬进 renderer/open-book-flow-ui.js
// （renderer.js 只留一次装配 + 同名转发，openSeq / openingBook 仍归编排器），这里用假 state + 桩 IPC
// 把每条分流逐条钉住，再用机器清单钉「实现只有一份、装配三处到位、活绑定没被传值冻住」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const openBookFlowUi = require('../renderer/open-book-flow-ui');
const guard = require('../renderer/open-book-guard');
const manifest = require('../renderer/assembly-manifest');
const { loadSourceGate, stripAssertHostBranch } = require('./ui-test-preambles');

const BOOK_A = '/书库/书甲';
const BOOK_B = '/书库/书乙';
const BOOK_META = {
  id: 'b1',
  title: '书甲',
  chapters: [{ id: 'c1', name: '第一章' }, { id: 'c2', name: '第二章' }],
  lastOpenChapterId: 'c2'
};

function makeHost(options = {}) {
  const calls = {
    openBookOp: [],
    editable: 0,
    openingBook: [],
    waitSavingIdle: 0,
    askUnsaved: [],
    saveCurrent: 0,
    toast: [],
    repair: [],
    selectRange: [],
    tts: 0,
    undoClear: 0,
    clearSnapshots: 0,
    resetTimer: 0,
    clearFind: 0,
    mask: [],
    view: [],
    renderList: 0,
    bookDisplay: [],
    loadChapter: []
  };
  let seq = 0;
  const state = {
    bookPath: options.bookPath === undefined ? BOOK_A : options.bookPath,
    dirty: Boolean(options.dirty),
    saving: Boolean(options.saving),
    books: options.books === undefined ? [] : options.books,
    meta: null,
    bookId: null,
    chapters: [],
    collapsedVolumes: new Set(['v1']),
    chapterFilter: '旧筛选',
    selectedIds: new Set(['c1']),
    selectAnchorId: 'c1',
    batchMenu: true,
    index: 3,
    loadedChapterId: 'c1',
    saveError: { message: '旧错误' },
    baseText: '旧正文',
    find: { total: options.findTotal === undefined ? 0 : options.findTotal }
  };
  const titleEl = { textContent: '', title: '' };
  const host = {
    state,
    editorEl: { value: '上一本的正文' },
    $: (id) => {
      if (id !== 'book-title') throw new Error('意外的选择器：' + id);
      return titleEl;
    },
    openBookGuard: guard,
    askUnsaved: async (payload) => {
      calls.askUnsaved.push(payload);
      if (options.duringAsk) options.duringAsk();
      return options.choice === undefined ? 'discard' : options.choice;
    },
    saveCurrent: async () => {
      calls.saveCurrent += 1;
      return options.saveResult === undefined ? { ok: true } : options.saveResult;
    },
    currentChapterLabel: () => '第二章',
    applyEditorEditable: () => {
      calls.editable += 1;
    },
    waitForSavingIdle: async () => {
      calls.waitSavingIdle += 1;
    },
    openBookOp: async (bookPath) => {
      calls.openBookOp.push(bookPath);
      if (options.duringOpen) options.duringOpen();
      if (options.openError) throw options.openError;
      return options.openData === undefined
        ? { meta: BOOK_META, missing: options.missing || [] }
        : options.openData;
    },
    toast: (text, kind) => calls.toast.push({ text, kind }),
    openRepair: async (book) => calls.repair.push(book),
    selectEditorRange: (index, length) => calls.selectRange.push([index, length]),
    nextOpenSeq: () => {
      seq += 1;
      return seq;
    },
    currentOpenSeq: () => seq,
    setOpeningBook: (value) => calls.openingBook.push(value),
    stopTtsForChapterChange: () => {
      calls.tts += 1;
    },
    undoUi: {
      clear: () => {
        calls.undoClear += 1;
      }
    },
    clearEditorUndoSnapshots: () => {
      calls.clearSnapshots += 1;
    },
    resetWriteTimer: async (opts) => {
      calls.resetTimer += 1;
      calls.resetTimerOpts = opts;
      if (options.duringResetTimer) options.duringResetTimer();
    },
    clearFindSession: () => {
      calls.clearFind += 1;
    },
    setChapterMask: (masked, placeholder) => calls.mask.push([masked, placeholder]),
    showView: (view) => calls.view.push(view),
    renderChapterList: () => {
      calls.renderList += 1;
    },
    applyBookDisplay: async (bookId) => {
      calls.bookDisplay.push(bookId);
      if (options.duringDisplay) options.duringDisplay();
    },
    loadChapterAt: async (index) => calls.loadChapter.push(index)
  };
  return { host, state, titleEl, calls, bumpSeq: () => (seq += 1), seqOf: () => seq };
}

test('host 契约：26 个必填成员缺一个就抛 TypeError，模块头声明的成员数与之相等', () => {
  assert.deepEqual([...openBookFlowUi.REQUIRED_HOST].sort(), [
    '$', 'applyBookDisplay', 'applyEditorEditable', 'askUnsaved', 'clearEditorUndoSnapshots', 'clearFindSession',
    'currentChapterLabel', 'currentOpenSeq', 'editorEl', 'loadChapterAt', 'nextOpenSeq', 'openBookGuard',
    'openBookOp', 'openRepair', 'renderChapterList', 'resetWriteTimer', 'saveCurrent', 'selectEditorRange',
    'setChapterMask', 'setOpeningBook', 'showView', 'state', 'stopTtsForChapterChange', 'toast', 'undoUi',
    'waitForSavingIdle'
  ]);
  const { host } = makeHost();
  assert.throws(() => openBookFlowUi.create(null), /createOpenBookFlowUi 需要 host 对象/);
  assert.throws(() => openBookFlowUi.create('host'), /createOpenBookFlowUi 需要 host 对象/);
  for (const key of openBookFlowUi.REQUIRED_HOST) {
    const broken = { ...host };
    delete broken[key];
    assert.throws(() => openBookFlowUi.create(broken), /缺少/, key);
    assert.throws(() => openBookFlowUi.create({ ...host, [key]: null }), /缺少/, key + '（null 也算缺）');
  }
  const ui = openBookFlowUi.create(host);
  assert.deepEqual(Object.keys(ui), ['openBookByPath'], '对外只暴露换书入口（commitOpenBook 只服务内部）');
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'open-book-flow-ui.js'), 'utf8');
  const claimed = /host 正好 (\d+) 个成员/.exec(src);
  assert.ok(claimed);
  assert.equal(claimed[1], String(openBookFlowUi.REQUIRED_HOST.length));
});

test('干净换书：不打扰作者，直接开 → 提交新书 → 载上次阅读章', async () => {
  const { host, state, titleEl, calls } = makeHost();
  const result = await openBookFlowUi.create(host).openBookByPath(BOOK_B);
  assert.equal(calls.askUnsaved.length, 0, '编辑区干净时不弹三选一');
  assert.deepEqual(calls.openBookOp, [BOOK_B]);
  assert.deepEqual(calls.openingBook, [true, false], '开书期间锁编辑区，提交完成解锁');
  assert.equal(calls.editable, 2);
  assert.equal(state.bookPath, BOOK_B);
  assert.equal(state.bookId, 'b1');
  assert.equal(state.meta, BOOK_META);
  assert.equal(state.chapters.length, 2);
  assert.equal(state.collapsedVolumes.size, 0, '换书重置卷折叠');
  assert.equal(state.chapterFilter, '', '换书清空目录筛选');
  assert.equal(state.selectedIds.size, 0, '多选不跨书');
  assert.equal(state.selectAnchorId, null);
  assert.equal(state.batchMenu, false);
  assert.equal(state.index, -1);
  assert.equal(state.loadedChapterId, null);
  assert.equal(state.dirty, false);
  assert.equal(state.saveError, null);
  assert.equal(state.baseText, '');
  assert.equal(host.editorEl.value, '', '编辑区必须先清空（否则上一本正文会被写进新书同下标章）');
  assert.equal(titleEl.textContent, '书甲');
  assert.equal(titleEl.title, '书甲');
  assert.deepEqual(calls.view, ['editor']);
  assert.equal(calls.renderList, 1);
  assert.deepEqual(calls.bookDisplay, ['b1']);
  assert.deepEqual(calls.mask, [[true, '正在载入章节…']]);
  assert.equal(calls.tts, 1, '换书先停朗读（五-M21 / MP-03）');
  assert.equal(calls.undoClear, 1, '撤销条不跨书');
  assert.equal(calls.clearSnapshots, 1, 'bulk / 兜底一次性快照不跨书');
  assert.deepEqual(calls.resetTimerOpts, { flush: true }, '换书前把没上报的写作时长记下');
  assert.deepEqual(calls.loadChapter, [1], '没有命中信息 → 回到上次阅读章（c2）');
  assert.deepEqual(result, { ok: true, meta: BOOK_META, missing: [] });
  assert.equal(result.ok, true);
});

test('编辑区脏：取消 / 保存失败都停在原地；丢弃 / 保存成功才继续', async () => {
  const canceled = makeHost({ dirty: true, choice: 'cancel' });
  assert.deepEqual(await openBookFlowUi.create(canceled.host).openBookByPath(BOOK_B), {
    ok: false,
    canceled: true
  });
  assert.equal(canceled.calls.openBookOp.length, 0, '取消后不许发开书 IPC');
  assert.deepEqual(canceled.calls.openingBook, [], '取消后不许锁编辑区');
  assert.equal(canceled.calls.askUnsaved.length, 1);

  const saveFailed = makeHost({ dirty: true, choice: 'save', saveResult: { ok: false, message: '磁盘满了' } });
  assert.deepEqual(await openBookFlowUi.create(saveFailed.host).openBookByPath(BOOK_B), {
    ok: false,
    canceled: true
  });
  assert.equal(saveFailed.calls.saveCurrent, 1);
  assert.equal(saveFailed.calls.openBookOp.length, 0, '保存失败不许继续换书');

  const saved = makeHost({ dirty: true, choice: 'save', saveResult: { ok: true } });
  const savedResult = await openBookFlowUi.create(saved.host).openBookByPath(BOOK_B);
  assert.equal(savedResult.ok, true);
  assert.equal(saved.calls.openBookOp.length, 1);

  const discarded = makeHost({ dirty: true, choice: 'discard' });
  assert.equal((await openBookFlowUi.create(discarded.host).openBookByPath(BOOK_B)).ok, true);
});

test('保存在途 + 脏：先等保存落定再问（C10：否则作者刚选的「不保存」会被在途写入违背）', async () => {
  const { host, state, calls } = makeHost({ dirty: true, saving: true, choice: 'discard' });
  await openBookFlowUi.create(host).openBookByPath(BOOK_B);
  assert.equal(calls.waitSavingIdle, 1);
  assert.equal(calls.askUnsaved.length, 1);
  assert.equal(state.bookPath, BOOK_B);
});

test('目标章命中：按 target.matchIndex 放选区；目标章被删：只提示、不套旧下标（五-M3 / SS-07）', async () => {
  const hit = makeHost();
  const hitResult = await openBookFlowUi.create(hit.host).openBookByPath(BOOK_B, {
    chapterId: 'c1',
    matchIndex: 12,
    matchLength: 3
  });
  assert.equal(hitResult.ok, true);
  assert.deepEqual(hit.calls.loadChapter, [0], '命中 c1 → 起点章是第 1 章');
  assert.deepEqual(hit.calls.selectRange, [[12, 3]]);
  assert.equal(hit.calls.toast.length, 0);

  const gone = makeHost();
  const goneResult = await openBookFlowUi.create(gone.host).openBookByPath(BOOK_B, {
    chapterId: 'gone',
    matchIndex: 999,
    matchLength: 2
  });
  assert.equal(goneResult.ok, true);
  assert.deepEqual(gone.calls.loadChapter, [1], '目标章被删 → 回落上次阅读章');
  assert.deepEqual(gone.calls.selectRange, [], '绝不把属于旧章的命中下标套到回落章正文上');
  assert.match(gone.calls.toast[0].text, /查找命中的章节已经不在了/);
  assert.equal(gone.calls.toast[0].kind, 'warn');
});

test('世代过期：IPC 回来前又开了一次书 → 一个字都不提交，且不许解后一次开书的锁', async () => {
  const ctx = makeHost({
    duringOpen: () => {
      // 模拟作者在第一次开书 IPC 往返期间又点了另一本：世代号前进，后一次开书才是当前现场。
      ctx.bumpSeq();
    }
  });
  const result = await openBookFlowUi.create(ctx.host).openBookByPath(BOOK_B);
  assert.deepEqual(result, { ok: false, code: 'STALE' });
  assert.equal(ctx.state.bookPath, BOOK_A, '过期响应不许改书目');
  assert.equal(ctx.host.editorEl.value, '上一本的正文', '过期响应不许清空编辑区');
  assert.deepEqual(ctx.calls.openingBook, [true], '过期的一次不许把 openingBook 解掉（锁归后一次开书）');
  assert.equal(ctx.calls.renderList, 0);
  assert.deepEqual(ctx.calls.loadChapter, []);
});

test('世代过期（提交阶段）：resetWriteTimer 的 await 期间又开了新书 → 提交中止，状态一个字不动', async () => {
  const ctx = makeHost({
    duringResetTimer: () => {
      // 提交新书的第一步就有 await（停上一本的写作计时）：这期间更晚的一次开书已经把世代号推走。
      ctx.bumpSeq();
    }
  });
  const result = await openBookFlowUi.create(ctx.host).openBookByPath(BOOK_B);
  assert.deepEqual(result, { ok: false, code: 'STALE' });
  assert.equal(ctx.state.bookPath, BOOK_A, '提交中止：书目不许换成这次的书');
  assert.equal(ctx.state.meta, null);
  assert.equal(ctx.state.index, 3, '提交中止：下标 / 已载章身份都不许动');
  assert.equal(ctx.host.editorEl.value, '上一本的正文', '提交中止：编辑区不许清空');
  assert.equal(ctx.calls.renderList, 0);
  assert.deepEqual(ctx.calls.loadChapter, []);
  assert.deepEqual(ctx.calls.openingBook, [true], '锁仍归更晚的那一次开书');
});

test('开书失败：错误码分流 —— 别的窗口打开 / 书目损坏走修复 / 其它如实提示，且都会解锁', async () => {
  const otherWindow = makeHost({ openError: Object.assign(new Error('已在另一个窗口打开'), { code: 'BOOK_OPEN_IN_OTHER_WINDOW' }) });
  const otherResult = await openBookFlowUi.create(otherWindow.host).openBookByPath(BOOK_B);
  assert.deepEqual(otherResult, { ok: false, code: 'BOOK_OPEN_IN_OTHER_WINDOW' });
  assert.equal(otherWindow.calls.toast[0].kind, 'warn');
  assert.deepEqual(otherWindow.calls.openingBook, [true, false], '失败也要解锁');

  const corrupt = makeHost({ books: [{ path: BOOK_B, title: '坏书' }], openError: Object.assign(new Error('书目坏了'), { code: 'PARSE_ERROR' }) });
  const corruptResult = await openBookFlowUi.create(corrupt.host).openBookByPath(BOOK_B);
  assert.deepEqual(corruptResult, { ok: false, code: 'PARSE_ERROR' });
  assert.deepEqual(corrupt.calls.repair, [{ path: BOOK_B, title: '坏书' }], '已知书 → 带原书目信息走修复');

  const unknownCorrupt = makeHost({ openError: Object.assign(new Error('不是书'), { code: 'NO_BOOK' }) });
  await openBookFlowUi.create(unknownCorrupt.host).openBookByPath(BOOK_B);
  assert.deepEqual(unknownCorrupt.calls.repair, [
    { path: BOOK_B, title: '这本书', status: 'corrupt', reason: '不是书' }
  ]);

  const failed = makeHost({ openError: new Error('读盘失败') });
  assert.deepEqual(await openBookFlowUi.create(failed.host).openBookByPath(BOOK_B), {
    ok: false,
    code: 'OPEN_FAILED',
    message: '读盘失败'
  });
  assert.equal(failed.calls.toast[0].text, '打开失败：读盘失败');
});

test('章节文件缺失：开书成功但提示缺几个；不阻断', async () => {
  const { host, calls } = makeHost({ missing: ['c3.md', 'c4.md'] });
  const result = await openBookFlowUi.create(host).openBookByPath(BOOK_B);
  assert.equal(result.ok, true);
  assert.match(calls.toast[0].text, /2 个章节文件缺失/);
  assert.equal(calls.toast[0].kind, 'warn');
});

test('提交期间又有更晚的开书提交了自己的书：这里不载章、也不解它的锁（V101 的竞态面）', async () => {
  const ctx = makeHost({
    duringDisplay: () => {
      // applyBookDisplay 是提交过程中的 await 点：更晚的一次开书已经提交了自己的书。
      ctx.state.bookPath = '/书库/书丙';
      ctx.bumpSeq();
    }
  });
  const result = await openBookFlowUi.create(ctx.host).openBookByPath(BOOK_B);
  assert.deepEqual(result, { ok: false, code: 'STALE' }, '提交虽已发生，但这次响应已过期：调用方按过期处理');
  assert.deepEqual(ctx.calls.loadChapter, [], '过期响应不许再载章');
  assert.deepEqual(ctx.calls.openingBook, [true], '锁仍归更晚的那一次开书');
});

test('活绑定：开书 IPC 一律走注入的 openBookOp（E2E 延迟注入靠它，不能绕过走 call）', async () => {
  const { host, calls } = makeHost();
  await openBookFlowUi.create(host).openBookByPath(BOOK_B);
  assert.deepEqual(calls.openBookOp, [BOOK_B]);
  assert.equal(calls.openingBook.length, 2);
});

// 静态闸门（机器清单）：实现只有一份、装配三处到位、渲染层只剩装配与同名转发。
test('静态闸门：实现只在 renderer/open-book-flow-ui.js，renderer.js 只留装配与同名转发（机器清单）', () => {
  const { rendererSrc, rendererCode, indexSrc, moduleSrc, moduleCode } = loadSourceGate('open-book-flow-ui.js');
  // ① 编排器里不许再长出第二份实现
  assert.equal(rendererCode.includes('async function commitOpenBook('), false, 'commitOpenBook 已搬走');
  assert.equal(rendererCode.includes('openBookGuard.decideOpenBook'), false, '换书守卫调用已搬走');
  assert.equal(rendererCode.includes("toast('查找命中的章节已经不在了"), false, '目标章提示已搬走');
  assert.match(
    rendererSrc,
    /async function openBookByPath\(bookPath, target = null\) \{\r?\n\s*if \(!openBookFlowUi\) return \{ ok: false, code: 'STALE' \};/,
    '只留同名转发'
  );
  assert.match(moduleSrc, /async function openBookByPath\(bookPath, target = null\)/, '实现要在模块里');
  assert.match(moduleSrc, /async function commitOpenBook\(bookPath, data, target, isStale\)/, '实现要在模块里');
  // ② 装配一次；世代令牌 / openingBook / testOpenBook 仍归编排器，按活绑定注入
  assert.match(rendererSrc, /const openBookFlowUiModule = window\.CWOpenBookFlowUi;/);
  assert.match(rendererSrc, /openBookFlowUi = openBookFlowUiModule\.create\(\{/);
  assert.match(rendererSrc, /nextOpenSeq: \(\) => \+\+openSeq,/, '世代令牌要现取现增（不能传值）');
  assert.match(rendererSrc, /currentOpenSeq: \(\) => openSeq,/, '过期判定要读当前令牌');
  assert.match(rendererSrc, /setOpeningBook: \(value\) => \{ openingBook = value; \},/, '开书标记写回编排器');
  assert.match(
    rendererSrc,
    /openBookOp: \(bookPath\) => \(testOpenBook \? testOpenBook\(api\.openBook, bookPath\) : call\(api\.openBook, bookPath\)\),/,
    'E2E 延迟注入要走 testOpenBook || call'
  );
  assert.equal(/let openSeq = 0;/.test(rendererCode), true, '世代令牌本身仍留在编排器');
  assert.equal(/let openingBook = false;/.test(rendererCode), true, '开书标记本身仍留在编排器（保存链 / 插入闸读它）');
  assert.equal(/let testOpenBook = null;/.test(rendererCode), true, '测试钩子的活绑定仍在编排器');
  // ③ 模块不发任何 IPC、不带换书之外的职责（openBookOp 由渲染层注入）
  assert.deepEqual(moduleCode.match(/api\.\w+/g) || [], [], '模块自己不许摸 api（开书 IPC 走注入的 openBookOp）');
  // ④ 装配清单 + index.html 都到位，且排在 renderer.js / assert-host 之后
  const entry = manifest.MODULES.find((item) => item[0] === 'open-book-flow-ui.js');
  assert.ok(entry, '装配清单必须登记 open-book-flow-ui.js');
  assert.equal(entry[1], 'CWOpenBookFlowUi');
  assert.equal(entry[2], 'openBookFlowUiModule');
  assert.match(indexSrc, /<script src="open-book-flow-ui\.js"><\/script>/, 'index.html 必须加载 open-book-flow-ui.js');
  assert.ok(
    indexSrc.indexOf('<script src="open-book-flow-ui.js"></script>') < indexSrc.indexOf('<script src="renderer.js"></script>'),
    'open-book-flow-ui.js 必须排在 renderer.js 之前'
  );
  assert.ok(
    indexSrc.indexOf('<script src="../core/assert-host.js"></script>') <
      indexSrc.indexOf('<script src="open-book-flow-ui.js"></script>'),
    'assert-host 必须排在消费者之前'
  );
  // ⑤ 模块本身仍是 UMD 双分支 + 依赖 assert-host，运行时代码不 require 任何东西
  assert.match(moduleSrc, /root\.CWOpenBookFlowUi = factory\(root\.CWAssertHost && root\.CWAssertHost\.assertHost\);/);
  assert.match(moduleSrc, /assertHost\('createOpenBookFlowUi', host, REQUIRED_HOST\);/, '只许调用一次共享 assertHost');
  assert.equal(/require\(/.test(stripAssertHostBranch(moduleCode)), false, '运行时代码（剥掉 Node 分支后）不许 require');
});
