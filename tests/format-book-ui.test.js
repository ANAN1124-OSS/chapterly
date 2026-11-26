// M1（第一轮·低，第 11 轮第三刀）：一键整理本书的**行为**锚点。
//
// 背景：runFormatBook 的整段编排（未保存拦截 → 预检查 → 整本整理 → 三路收尾分流 → 10 秒撤销）
// 以前长在 renderer.js 里（4,472 行），只有开 Electron 真整理一本千章书才走得到：预检查拖进锁内、
// 整理期间换书 / 再输入怎么收尾、撤销前核对不核对备份，全靠 E2E。第 11 轮把这几段搬进
// renderer/format-book-ui.js（renderer.js 只留同名转发与一次装配），这里用假 state + 桩 IPC 逐条钉住，
// 再用机器清单钉「实现只有一份、装配三处到位、换书入口没被绕过」。
const test = require('node:test');
const assert = require('node:assert/strict');
const formatBookUi = require('../renderer/format-book-ui');
const manifest = require('../renderer/assembly-manifest');
const { loadSourceGate, stripAssertHostBranch } = require('./ui-test-preambles');

// 假 host：可改的 state + 记下每次调用的桩。所有依赖按「调用时取值」给（与渲染层同口径）。
function makeHost(options = {}) {
  const calls = {
    toast: [],
    hideFormatMenu: 0,
    hideDisplayMenu: 0,
    saveForTransition: [],
    currentChapterLabel: 0,
    loadChapterAt: [],
    mergeOptions: [],
    describeRules: 0,
    beginLongOpLock: 0,
    endLongOpLock: 0,
    progress: [],
    hideProgress: 0,
    runBookOp: [],
    openBook: [],
    refreshShelf: 0,
    renderChapterList: 0,
    renderEditorHeader: 0,
    updateStatus: 0,
    fingerprint: [],
    activate: [],
    assertUnchanged: [],
    call: [],
    reloadOpenBookFromDisk: [],
    reloadAfterPartialFailure: [],
    decide: []
  };
  const decideQueue = options.decideQueue ? [...options.decideQueue] : [];
  const state = {
    bookPath: options.bookPath === undefined ? '/书库/书甲' : options.bookPath,
    meta: options.meta === undefined ? { title: '书甲' } : options.meta,
    config: options.config === undefined ? { formatOptions: { indent: true } } : options.config,
    baseText: options.baseText === undefined ? '磁盘上的正文' : options.baseText,
    dirty: Boolean(options.dirty),
    formatBookRunning: false,
    chapters: options.chapters || [
      { id: 'ch_1', name: '第一章' },
      { id: 'ch_2', name: '第二章' }
    ],
    index: options.index === undefined ? 1 : options.index,
    // A2-TIDY-01：载入时那一版磁盘 mtime（保存链拿它做外部修改比对）；keep-edits 收尾必须同步它。
    loadedMtimeMs: options.loadedMtimeMs === undefined ? 1000 : options.loadedMtimeMs
  };
  const editorEl = { value: options.editorValue === undefined ? '磁盘上的正文' : options.editorValue };
  const api = {
    formatPreviewBook: 'format:preview-book',
    restoreHistoryDir: 'history:restore-dir',
    statChapter: 'chapter:stat'
  };
  const ipc = options.ipc || {};
  const host = {
    state,
    editorEl,
    api,
    call: async (channel, ...rest) => {
      calls.call.push([channel, ...rest]);
      if (typeof ipc[channel] === 'function') return ipc[channel](...rest);
      return undefined;
    },
    toast: (message, kind) => {
      calls.toast.push([message, kind]);
    },
    hideFormatMenu: () => {
      calls.hideFormatMenu += 1;
    },
    hideDisplayMenu: () => {
      calls.hideDisplayMenu += 1;
    },
    saveForTransition: async (input) => {
      calls.saveForTransition.push(input);
      return options.saveResult || { ok: true };
    },
    currentChapterLabel: () => {
      calls.currentChapterLabel += 1;
      return '第二章';
    },
    loadChapterAt: async (index) => {
      calls.loadChapterAt.push(index);
    },
    formatUi: {
      mergeOptions: (raw) => {
        calls.mergeOptions.push(raw);
        return { indent: 2, marker: 'merged' };
      },
      describeRules: () => {
        calls.describeRules += 1;
        return '规则 A';
      }
    },
    longOpLocked: () => Boolean(options.locked),
    beginLongOpLock: () => {
      calls.beginLongOpLock += 1;
    },
    endLongOpLock: () => {
      calls.endLongOpLock += 1;
    },
    showFormatBookProgress: (text) => {
      calls.progress.push(text);
    },
    hideFormatBookProgress: () => {
      calls.hideProgress += 1;
    },
    chapterTitle: (index, name) => name || `第 ${index + 1} 章`,
    runBookOp: async (bookPath, opts) => {
      calls.runBookOp.push([bookPath, opts]);
      if (options.bookOpError) throw new Error(options.bookOpError);
      return options.bookOpResult || { chaptersChanged: 2, backupDir: '/书库/书甲/_trash/整理备份-9' };
    },
    openBook: async (bookPath) => {
      calls.openBook.push(bookPath);
      return options.opened || { meta: { title: '书甲', chapters: [{ id: 'ch_1' }, { id: 'ch_2' }] } };
    },
    refreshShelf: async () => {
      calls.refreshShelf += 1;
    },
    renderChapterList: () => {
      calls.renderChapterList += 1;
    },
    renderEditorHeader: () => {
      calls.renderEditorHeader += 1;
    },
    updateStatus: () => {
      calls.updateStatus += 1;
    },
    saveLogic: {
      isDirtyAgainstSnapshot: (base, value) => {
        calls.decide.push({ base, value });
        return base !== value;
      }
    },
    longOpLogic: {
      decideAfterLongOp: (input) => {
        calls.decide.push(input);
        return decideQueue.length ? decideQueue.shift() : 'reload';
      },
      sameBookPath: (a, b) => String(a) === String(b)
    },
    backupGuard: {
      fingerprint: async (bookPath, name) => {
        calls.fingerprint.push([bookPath, name]);
        return 'fp-1';
      },
      assertUnchanged: async (bookPath, fp) => {
        calls.assertUnchanged.push([bookPath, fp]);
      }
    },
    undoUi: {
      activate: (label, fn, meta) => {
        calls.activate.push({ label, fn, meta });
      }
    },
    reloadOpenBookFromDisk: async (bookPath) => {
      calls.reloadOpenBookFromDisk.push(bookPath);
    },
    reloadAfterPartialFailure: async (bookPath) => {
      calls.reloadAfterPartialFailure.push(bookPath);
    }
  };
  return { host, state, editorEl, calls, api };
}

const PREVIEW_TWO_CHAPTERS = {
  chaptersChanged: 2,
  changed: [
    { index: 0, name: '第一章' },
    { index: 1, name: '第二章' }
  ]
};

test('host 契约：29 个必填成员缺一个就抛 TypeError，模块头声明的成员数与之相等', () => {
  assert.deepEqual([...formatBookUi.REQUIRED_HOST].sort(), [
    'api', 'backupGuard', 'beginLongOpLock', 'call', 'chapterTitle', 'currentChapterLabel',
    'editorEl', 'endLongOpLock', 'formatUi', 'hideDisplayMenu', 'hideFormatBookProgress',
    'hideFormatMenu', 'loadChapterAt', 'longOpLocked', 'longOpLogic', 'openBook',
    'refreshShelf', 'reloadAfterPartialFailure', 'reloadOpenBookFromDisk', 'renderChapterList',
    'renderEditorHeader', 'runBookOp', 'saveForTransition', 'saveLogic', 'showFormatBookProgress',
    'state', 'toast', 'undoUi', 'updateStatus'
  ]);
  const { host } = makeHost();
  assert.throws(() => formatBookUi.create(null), /createFormatBookUi 需要 host 对象/);
  assert.throws(() => formatBookUi.create('host'), /createFormatBookUi 需要 host 对象/);
  for (const key of formatBookUi.REQUIRED_HOST) {
    const broken = { ...host };
    delete broken[key];
    assert.throws(() => formatBookUi.create(broken), /缺少/, key);
    assert.throws(() => formatBookUi.create({ ...host, [key]: null }), /缺少/, key + '（null 也算缺）');
  }
  const ui = formatBookUi.create(host);
  assert.equal(typeof ui.runFormatBook, 'function');
  assert.deepEqual(Object.keys(ui), ['runFormatBook'], '对外只暴露入口（不要在模块里长出第二份装配面）');
});

test('没开书 / 已在整理：只提示，不做预检查也不上长操作锁', async () => {
  const empty = makeHost({ bookPath: '' });
  assert.deepEqual(await formatBookUi.create(empty.host).runFormatBook(), { ok: false });
  assert.deepEqual(empty.calls.toast, [['先打开一本书再整理', 'warn']]);
  assert.equal(empty.calls.call.length, 0);
  assert.equal(empty.calls.beginLongOpLock, 0, '没开书不许锁编辑区');

  const noMeta = makeHost({ meta: null });
  assert.deepEqual(await formatBookUi.create(noMeta.host).runFormatBook(), { ok: false });
  assert.deepEqual(noMeta.calls.toast, [['先打开一本书再整理', 'warn']]);

  const running = makeHost();
  running.state.formatBookRunning = true;
  assert.deepEqual(await formatBookUi.create(running.host).runFormatBook(), { ok: false, busy: true });
  assert.deepEqual(running.calls.toast, [['正在整理这本书，请稍候', 'warn']]);
  assert.equal(running.calls.call.length, 0, '已在整理时不许再发一条预检查 IPC');

  const locked = makeHost({ locked: true });
  assert.deepEqual(await formatBookUi.create(locked.host).runFormatBook(), { ok: false, busy: true });
  assert.equal(locked.calls.call.length, 0, '长操作锁在场时同样一步都不走');
});

test('未保存拦截：取消 / 保存失败都不动盘；选「不保存」才按磁盘旧内容继续', async () => {
  const canceled = makeHost({ dirty: true, saveResult: { ok: false, canceled: true } });
  assert.deepEqual(await formatBookUi.create(canceled.host).runFormatBook(), { ok: false, canceled: true });
  assert.equal(canceled.calls.toast.length, 0, '作者主动取消不该再弹提示');
  assert.equal(canceled.calls.call.length, 0, '取消后不许预检查（会读整本书）');
  assert.equal(canceled.calls.beginLongOpLock, 0);

  const saveFailed = makeHost({ dirty: true, saveResult: { ok: false, saved: { ok: false, message: '磁盘只读' } } });
  assert.deepEqual(await formatBookUi.create(saveFailed.host).runFormatBook(), { ok: false, message: '磁盘只读' });
  assert.equal(saveFailed.calls.call.length, 0, '保存失败照样不许往下整理');

  const discarded = makeHost({
    dirty: true,
    saveResult: { ok: true, discarded: true },
    ipc: { 'format:preview-book': () => PREVIEW_TWO_CHAPTERS }
  });
  await formatBookUi.create(discarded.host).runFormatBook();
  assert.deepEqual(discarded.calls.loadChapterAt, [1, 1], '选「不保存」先按磁盘旧内容重载一次，整理完再按 chapter.id 重载回来');
  assert.deepEqual(discarded.calls.call[0].slice(0, 2), ['format:preview-book', '/书库/书甲']);
  assert.equal(discarded.calls.saveForTransition[0].saveLabel, '保存后整理');
  assert.match(discarded.calls.saveForTransition[0].message, /「第二章」还有未保存的修改/, '拦截文案要点名当前章');
  assert.equal(discarded.calls.currentChapterLabel, 1, '当前章标签只取一次');
});

test('预检查：没有可改的地方就停（带上超限章数），失败只提示不改盘——两条路径都解开锁', async () => {
  const clean = makeHost({ ipc: { 'format:preview-book': () => ({ chaptersChanged: 0, skippedTooLarge: 3 }) } });
  const result = await formatBookUi.create(clean.host).runFormatBook();
  assert.equal(result.ok, true);
  assert.equal(result.changed, 0);
  assert.equal(clean.calls.toast.length, 1);
  assert.match(clean.calls.toast[0][0], /已经是整理后的格式/);
  assert.match(clean.calls.toast[0][0], /有 3 章超过 128 MB/);
  assert.equal(clean.calls.runBookOp.length, 0, '没有可改的地方不许调整本整理');
  assert.equal(clean.state.formatBookRunning, false);
  assert.equal(clean.calls.endLongOpLock, 1);
  assert.equal(clean.calls.hideProgress, 1);

  const failed = makeHost({
    ipc: {
      'format:preview-book': () => {
        throw new Error('磁盘忙');
      }
    }
  });
  assert.deepEqual(await formatBookUi.create(failed.host).runFormatBook(), { ok: false, message: '磁盘忙' });
  assert.deepEqual(failed.calls.toast, [['预检查失败：磁盘忙', 'error']]);
  assert.equal(failed.calls.reloadAfterPartialFailure.length, 0, '预检查失败时磁盘一个字都没动，不该重载');
  assert.equal(failed.state.formatBookRunning, false, '异常路径也要把「进行中」清掉');
  assert.equal(failed.calls.beginLongOpLock, 1);
  assert.equal(failed.calls.endLongOpLock, 1);
});

test('正常收尾：只整理发起时那本书 → 重读书目 → 按 chapter.id 重载当前章 → 登记 10 秒撤销', async () => {
  const { host, state, calls } = makeHost({
    ipc: { 'format:preview-book': () => PREVIEW_TWO_CHAPTERS },
    opened: {
      meta: {
        title: '书甲',
        chapters: [{ id: 'ch_new' }, { id: 'ch_2' }, { id: 'ch_1' }]
      }
    }
  });
  const result = await formatBookUi.create(host).runFormatBook();
  assert.equal(result.ok, true);
  assert.equal(result.changed, 2);
  // 预检查与整理都在锁内；两次进度文案分别是「检查」与「整理」
  assert.equal(calls.beginLongOpLock, 1);
  assert.equal(calls.endLongOpLock, 1);
  assert.match(calls.progress[0], /正在检查整本书/);
  assert.match(calls.progress[1], /正在整理整本书…（共 2 章要改/);
  // 规则来自 formatUi.mergeOptions(state.config.formatOptions)，整理用合并后的规则
  assert.deepEqual(calls.mergeOptions, [{ indent: true }]);
  assert.deepEqual(calls.runBookOp.map(([bookPath]) => bookPath), ['/书库/书甲']);
  assert.deepEqual(calls.runBookOp[0][1], { indent: 2, marker: 'merged' });
  assert.deepEqual(calls.openBook, ['/书库/书甲'], '整理完要重读同一本书的书目');
  assert.equal(state.meta.title, '书甲');
  assert.deepEqual(state.chapters.map((chapter) => chapter.id), ['ch_new', 'ch_2', 'ch_1']);
  // 期间切过章：按 chapter.id 现场解析（不是用发起时的下标）
  assert.deepEqual(calls.loadChapterAt, [1]);
  assert.equal(calls.renderChapterList, 1);
  assert.equal(calls.renderEditorHeader, 1);
  assert.equal(calls.updateStatus, 0, '正常重载走 loadChapterAt，状态栏由载章链路更新');
  // 完成文案带上「改了几章 / 备份在哪」，作者不点确认也知道
  const doneText = calls.toast.map(([message]) => message).join('\n');
  assert.match(doneText, /已整理全书：2 章/);
  assert.match(doneText, /规则 A/);
  assert.match(doneText, /原文已备份到 _trash/);
  // 撤销登记：指纹 + 组 id，回调真的能用备份整组还原
  assert.deepEqual(calls.fingerprint, [['/书库/书甲', '整理备份-9']]);
  assert.equal(calls.activate.length, 1);
  assert.equal(calls.activate[0].label, '已整理全书 2 章');
  assert.deepEqual(calls.activate[0].meta, { groupId: 'dir:整理备份-9', bookPath: '/书库/书甲' });
  assert.equal(state.formatBookRunning, false);
  assert.equal(calls.hideProgress, 1);
});

test('收尾分流：整理期间换了书 → 只刷书架 + 提示，界面一个字都不动', async () => {
  const { host, state, calls } = makeHost({
    ipc: { 'format:preview-book': () => PREVIEW_TWO_CHAPTERS },
    decideQueue: ['book-changed']
  });
  host.runBookOp = async (bookPath, opts) => {
    calls.runBookOp.push([bookPath, opts]);
    state.bookPath = '/书库/书乙'; // 整理在途换书（回执只属于发起时那本书）
    return { chaptersChanged: 2, backupDir: '/书库/书甲/_trash/整理备份-9' };
  };
  const result = await formatBookUi.create(host).runFormatBook();
  assert.equal(result.ok, true);
  assert.equal(result.changed, 2);
  assert.deepEqual(calls.openBook, [], '换了书就不许再用活值重读书目（会把另一本书重载进来）');
  assert.deepEqual(calls.loadChapterAt, []);
  assert.equal(calls.refreshShelf, 1);
  assert.equal(calls.activate.length, 0, '换了书不能登记撤销（回调一进门就会判「已经换了书」）');
  assert.match(calls.toast.at(-1)[0], /你已切换到另一本书/);
});

test('收尾分流：整理期间编辑区又有字 → 磁盘已整理但保留编辑区，绝不拿结果盖掉作者的字', async () => {
  const { host, state, editorEl, calls } = makeHost({
    ipc: { 'format:preview-book': () => PREVIEW_TWO_CHAPTERS },
    decideQueue: ['keep-edits', 'keep-edits']
  });
  host.runBookOp = async (bookPath, opts) => {
    calls.runBookOp.push([bookPath, opts]);
    editorEl.value = '整理在途敲进去的字';
    return { chaptersChanged: 2, backupDir: '/书库/书甲/_trash/整理备份-9' };
  };
  const result = await formatBookUi.create(host).runFormatBook();
  assert.equal(result.ok, true);
  assert.deepEqual(calls.loadChapterAt, [], '编辑区有字时不许重载（会盖掉未保存的输入）');
  assert.equal(state.dirty, true, '保留编辑区就要维持未保存态');
  assert.equal(calls.renderChapterList, 1);
  assert.equal(calls.renderEditorHeader, 1);
  assert.equal(calls.updateStatus, 1);
  const messages = calls.toast.map(([, kind]) => kind);
  assert.ok(messages.includes('warn'), '要明确告诉作者「修改还在编辑区、未保存」');
  assert.match(calls.toast.at(-1)[0], /还留在编辑区/);
  assert.equal(calls.activate.length, 1, '保留编辑区也要照常登记撤销（备份确实写盘了）');
});

// A2-TIDY-01（keep-edits 面）：整本整理把磁盘上的这一章换掉了，编辑区保留的是「整理前正文 + 整理期间输入」。
// 载入时的 loadedMtimeMs 已过期；不同步的话作者整理完照常 Ctrl+S 会被误判成外部修改（EXTERNAL_CHANGE）。
test('A2-TIDY-01：keep-edits 收尾按本次写盘 mtime 同步 loadedMtimeMs，下一次保存不误报外部修改', async () => {
  const opened = {
    meta: {
      title: '书甲',
      chapters: [
        { id: 'ch_1', name: '第一章', file: 'c1.txt' },
        { id: 'ch_2', name: '第二章', file: 'c2.txt' }
      ]
    }
  };
  const { host, state, editorEl, calls } = makeHost({
    ipc: {
      'format:preview-book': () => PREVIEW_TWO_CHAPTERS,
      'chapter:stat': () => ({ mtimeMs: 2222, size: 10 })
    },
    decideQueue: ['keep-edits', 'keep-edits'],
    opened
  });
  host.runBookOp = async (bookPath, opts) => {
    calls.runBookOp.push([bookPath, opts]);
    editorEl.value = '整理在途敲进去的字';
    return { chaptersChanged: 2, backupDir: '/书库/书甲/_trash/整理备份-9' };
  };
  const result = await formatBookUi.create(host).runFormatBook();
  assert.equal(result.ok, true);
  assert.deepEqual(calls.loadChapterAt, [], '编辑区有字时不重载');
  assert.deepEqual(calls.call.at(-1), ['chapter:stat', '/书库/书甲', 'c2.txt'], 'stat 的必须是当前章（索引 1）');
  assert.equal(state.loadedMtimeMs, 2222, '同步到本次写盘 mtime');
  assert.equal(state.dirty, true, '正文仍以编辑区为准：保持未保存态');
});

test('撤销回调：换书 / 有未保存修改都拒绝；正常路径核对指纹后才还原并重载', async () => {
  const { host, state, calls, api } = makeHost({
    ipc: {
      'format:preview-book': () => PREVIEW_TWO_CHAPTERS,
      'history:restore-dir': () => ({ restored: 2 })
    }
  });
  await formatBookUi.create(host).runFormatBook();
  const undo = calls.activate[0].fn;
  assert.equal(typeof undo, 'function');

  state.bookPath = '/书库/书乙';
  await assert.rejects(undo, /已经换了书，不能撤销/);
  assert.deepEqual(calls.assertUnchanged, [], '换了书不许再碰备份');

  state.bookPath = '/书库/书甲';
  state.dirty = true;
  await assert.rejects(undo, /编辑区有未保存的修改/);
  assert.deepEqual(calls.assertUnchanged, [], '有未保存修改时不许还原（reload 的脏闸拦不住已经发生的写盘）');

  state.dirty = false;
  const shelfBefore = calls.refreshShelf;
  await undo();
  assert.deepEqual(calls.assertUnchanged, [['/书库/书甲', 'fp-1']], '还原前必须核对备份指纹');
  assert.deepEqual(calls.call.at(-1), ['history:restore-dir', '/书库/书甲', 'dir:整理备份-9']);
  assert.deepEqual(calls.reloadOpenBookFromDisk, ['/书库/书甲']);
  assert.equal(calls.refreshShelf, shelfBefore + 1);
  assert.equal(api.formatPreviewBook, 'format:preview-book');
});

test('撤销回调：备份里没有可还原的章节要报错（不假装成功）', async () => {
  const { host, calls } = makeHost({
    ipc: {
      'format:preview-book': () => PREVIEW_TWO_CHAPTERS,
      'history:restore-dir': () => ({ restored: 0 })
    }
  });
  await formatBookUi.create(host).runFormatBook();
  await assert.rejects(calls.activate[0].fn, /整理备份里没有可还原的章节/);
  assert.deepEqual(calls.reloadOpenBookFromDisk, [], '没还原成功就不许重载');
});

test('整理失败：提示 + 重载半成品现场，锁与「进行中」标志照样解开', async () => {
  const { host, state, calls } = makeHost({
    ipc: { 'format:preview-book': () => PREVIEW_TWO_CHAPTERS },
    bookOpError: '磁盘只读'
  });
  assert.deepEqual(await formatBookUi.create(host).runFormatBook(), { ok: false, message: '磁盘只读' });
  assert.deepEqual(calls.toast, [['整理本书失败：磁盘只读', 'error']]);
  assert.deepEqual(calls.reloadAfterPartialFailure, ['/书库/书甲'], '可能已经整理了几章，别让编辑区停在旧正文上');
  assert.equal(state.formatBookRunning, false);
  assert.equal(calls.endLongOpLock, 1);
  assert.equal(calls.hideProgress, 1);
  assert.equal(calls.activate.length, 0);
});

// 静态闸门（机器清单）：实现只有一份、装配三处到位、渲染层只剩装配与同名转发、换书入口没被绕过。
test('静态闸门：实现只在 renderer/format-book-ui.js，renderer.js 只留装配与同名转发（机器清单）', () => {
  const { rendererSrc, rendererCode, indexSrc, moduleSrc, moduleCode } = loadSourceGate('format-book-ui.js');
  // ① 编排器里不许再长出第二份实现
  assert.equal(rendererCode.includes('formatPreviewBook'), false, 'renderer.js 不许再发预检查 IPC（实现已搬走）');
  assert.equal(rendererCode.includes('整理本书前先处理未保存的修改'), false, '整本整理的未保存拦截已搬进模块');
  assert.equal(/async function runFormatBook\(\) \{\r?\n\s*if \(!formatBookUi\) return/.test(rendererSrc), true,
    'renderer.js 只留同名转发（保持函数声明，晚装配也能被整理卡调用）');
  assert.match(rendererSrc, /return formatBookUi\.runFormatBook\(\);/);
  assert.match(moduleSrc, /async function runFormatBook\(\)/, '实现要在模块里');
  assert.match(moduleSrc, /formatPreviewBook/, '预检查在模块里');
  assert.match(moduleSrc, /restoreHistoryDir/, '撤销还原在模块里');
  // ② 装配一次（模块常量 + create 都在编排器里）
  assert.match(rendererSrc, /const formatBookUiModule = window\.CWFormatBookUi;/);
  assert.match(rendererSrc, /formatBookUi = formatBookUiModule\.create\(\{/);
  assert.match(rendererSrc, /openBook: \(bookPath\) => call\(api\.openBook, bookPath\)/, '重读书目仍走编排器的开书 IPC');
  // ③ 换书入口没被绕过：模块自己不摸开书 IPC
  assert.equal(/api\.openBook\b/.test(moduleCode), false, '本模块不许自带换书入口（要开书走渲染层）');
  // ④ 装配清单 + index.html 都到位，且排在 renderer.js / assert-host 之后
  const entry = manifest.MODULES.find((item) => item[0] === 'format-book-ui.js');
  assert.ok(entry, '装配清单必须登记 format-book-ui.js');
  assert.equal(entry[1], 'CWFormatBookUi');
  assert.equal(entry[2], 'formatBookUiModule');
  assert.match(indexSrc, /<script src="format-book-ui\.js"><\/script>/, 'index.html 必须加载 format-book-ui.js');
  assert.ok(
    indexSrc.indexOf('<script src="format-book-ui.js"></script>') < indexSrc.indexOf('<script src="renderer.js"></script>'),
    'format-book-ui.js 必须排在 renderer.js 之前（renderer.js 装载期就 create）'
  );
  assert.ok(
    indexSrc.indexOf('<script src="../core/assert-host.js"></script>') < indexSrc.indexOf('<script src="format-book-ui.js"></script>'),
    'assert-host 必须排在消费者之前'
  );
  // ⑤ 模块本身仍是 UMD 双分支 + 依赖 assert-host，运行时代码不 require 任何东西
  assert.match(moduleSrc, /root\.CWFormatBookUi = factory\(root\.CWAssertHost && root\.CWAssertHost\.assertHost\);/);
  assert.match(moduleSrc, /assertHost\('createFormatBookUi', host, REQUIRED_HOST\);/, '只许调用一次共享 assertHost');
  assert.equal(/require\(/.test(stripAssertHostBranch(moduleCode)), false, '运行时代码（剥掉 Node 分支后）不许 require');
  // ⑥ 模块头声明的成员数与 REQUIRED_HOST 对齐（contract-comments 闸门同口径，这里就近钉住）
  const claimed = /host 正好 (\d+) 个成员/.exec(moduleSrc);
  assert.ok(claimed, '模块头要写明 host 成员数（装配说明书）');
  assert.equal(claimed[1], String(formatBookUi.REQUIRED_HOST.length));
});
