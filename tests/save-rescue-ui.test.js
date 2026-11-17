// 审计修复 #5（V301）/ #6（V302）的渲染层救稿出口单测。
//
// 为什么单独一个模块：save-rescue-ui.js 只在「保存被拦下」时才跑，但要同时碰对话框、状态栏、
// 剪贴板 / 另存 IPC 与保存重试；塞回 renderer.js 既撑大 6256 行的装配文件，也没法在 Node 里
// 逐条钉住「点哪个按钮会发生什么」。这里用假 host + 假对话框把每个按钮的后果钉住，再用静态
// 闸门保证 renderer.js / preload.js / main.js 的接线不会在以后被顺手改回去。
const test = require('node:test');
const assert = require('node:assert/strict');
const saveRescueUi = require('../renderer/save-rescue-ui');
const { loadSourceGate } = require('./ui-test-preambles');

const { rendererCode, indexSrc, moduleSrc, moduleCode } = loadSourceGate('save-rescue-ui.js');

// 假 host：state / editorEl 是真对象（模块会读，冲突路径还会写 state.saving / state.dirty），
// 其余能力全部记进 calls，断言「点了哪个按钮 → 谁被调用、参数是什么、提示是什么」。
function makeHost(options = {}) {
  const calls = { modal: [], toast: [], rescue: [], save: [], load: [] };
  const chapters = options.chapters || [{ id: 'c1', name: '第一章', file: '0001.txt' }];
  const index = options.index === undefined ? 0 : options.index;
  const state = {
    bookPath: options.bookPath === undefined ? 'C:/tmp/books/测试书' : options.bookPath,
    index,
    chapters,
    // 冲突章身份的另一半：真实 renderer 载章成功就一定写 loadedChapterId；
    // 缺省按 index 对齐，让「没传 conflictChapterId」的旧调用仍能重载眼前这一章（向后兼容）。
    loadedChapterId: options.loadedChapterId === undefined
      ? ((chapters[index] && chapters[index].id) || null)
      : options.loadedChapterId,
    saving: options.saving === undefined ? true : Boolean(options.saving),
    dirty: options.dirty === undefined ? true : Boolean(options.dirty)
  };
  const editorEl = { value: options.text === undefined ? '还没落盘的正文' : options.text };
  const host = {
    state,
    editorEl,
    api: {
      rescueChapterText: (text, mode, suggestedName) => {
        calls.rescue.push([text, mode, suggestedName]);
        if (options.rescueThrows) return Promise.reject(new Error('IPC 失败'));
        if (mode === 'copy') return Promise.resolve({ copied: true, chars: 42 });
        if (options.rescueCanceled) return Promise.resolve({ canceled: true });
        return Promise.resolve({ canceled: false, filePath: 'C:/tmp/救稿.txt', chars: 42 });
      }
    },
    call: async (fn, ...args) => fn(...args),
    openModal: async (payload) => {
      calls.modal.push(payload);
      if (typeof options.onModal === 'function') options.onModal(state);
      const action = typeof options.modalAction === 'function'
        ? options.modalAction(payload)
        : (options.modalAction || 'stay');
      return { action };
    },
    toast: (message, kind) => calls.toast.push([message, kind]),
    saveCurrent: async (opts) => {
      calls.save.push(opts);
      if (options.saveThrows) throw new Error('save boom');
      return options.saveResult || { ok: true, data: { mtimeMs: 333 } };
    },
    loadChapterAt: async (at) => {
      calls.load.push(at);
      if (options.loadThrows) throw new Error('load boom');
      // R1 的假 host 契约与真实 loadChapterAt 一致：失败只回 {ok:false}，不清脏、不动正文
      if (options.loadFails) return { ok: false, code: 'LOAD_FAILED', message: '磁盘那一章读不出来' };
      state.dirty = false;
      return { ok: true };
    },
    chapterTitle: (index, name) => `第${index + 1}章：${name}`
  };
  return { host, state, calls };
}

function create(host) {
  return saveRescueUi.create(host);
}

// ---------- 契约 ----------
test('契约：REQUIRED_HOST 逐成员校验（缺一个 / null 都当场 TypeError）', () => {
  assert.deepEqual(
    [...saveRescueUi.REQUIRED_HOST],
    ['state', 'api', 'call', 'openModal', 'toast', 'editorEl', 'saveCurrent', 'loadChapterAt', 'chapterTitle']
  );
  assert.throws(() => saveRescueUi.create(null), /createSaveRescueUi 需要 host 对象/);
  assert.throws(() => saveRescueUi.create('x'), /createSaveRescueUi 需要 host 对象/);
  for (const key of saveRescueUi.REQUIRED_HOST) {
    const { host } = makeHost();
    delete host[key];
    assert.throws(() => saveRescueUi.create(host), /缺少/, key);
    const { host: nulled } = makeHost();
    nulled[key] = null;
    assert.throws(() => saveRescueUi.create(nulled), /缺少/, key + '（null 也算缺）');
  }
  const { host } = makeHost();
  assert.doesNotThrow(() => saveRescueUi.create(host));
});

test('纯判定：只有 EXTERNAL_CHANGE / BOOK_MISSING / CHAPTER_MISSING 进救稿链路，其余失败照旧', () => {
  assert.equal(saveRescueUi.EXTERNAL_CHANGE, 'EXTERNAL_CHANGE');
  assert.deepEqual([...saveRescueUi.RESCUE_CODES], ['BOOK_MISSING', 'CHAPTER_MISSING']);
  assert.equal(saveRescueUi.rescuePlanFor('EXTERNAL_CHANGE'), 'conflict');
  assert.equal(saveRescueUi.rescuePlanFor('BOOK_MISSING'), 'rescue');
  assert.equal(saveRescueUi.rescuePlanFor('CHAPTER_MISSING'), 'rescue');
  for (const code of ['CROSS_WINDOW_BUSY', 'META_SAVE_FAILED', 'NO_CHAPTER', 'CHAPTER_MISMATCH', 'PARSE_ERROR', '', null]) {
    assert.equal(saveRescueUi.rescuePlanFor(code), '', String(code));
  }
  assert.equal(create(makeHost().host).rescuePlanFor('BOOK_MISSING'), 'rescue', '实例上也照样可用');
});

// ---------- V302：书 / 章文件没了 → 另存 / 复制 / 留下 ----------
test('V302：弹窗逐字（标题 / 三个出口 / 默认留在这里），且正文与「脏」一个字节都不动', async () => {
  const { host, state, calls } = makeHost({ modalAction: 'stay' });
  const result = await create(host).handleSaveFailure({
    code: 'CHAPTER_MISSING',
    message: '这一章的正文文件已经不在了，已阻止这次保存。'
  });
  assert.equal(calls.modal.length, 1);
  const modal = calls.modal[0];
  assert.equal(modal.title, '保存被阻止：这些字还没落盘');
  assert.match(modal.message, /这一章的正文文件已经不在了/);
  assert.match(modal.message, /正文还在编辑区里（未保存）/);
  assert.deepEqual(modal.buttons, [
    { label: '留在这里', value: 'stay' },
    { label: '复制正文', value: 'copy' },
    { label: '另存这一章为 txt…', value: 'save', kind: 'primary' }
  ]);
  assert.equal(modal.cancelValue, 'stay');
  assert.equal(calls.rescue.length, 0, '选「留在这里」不碰任何 IPC');
  assert.deepEqual(calls.toast, []);
  assert.equal(host.editorEl.value, '还没落盘的正文');
  assert.equal(state.dirty, true);
  assert.deepEqual(result, { ok: false, code: 'CHAPTER_MISSING', message: '这一章的正文文件已经不在了，已阻止这次保存。' });
});

test('V302：选「另存这一章为 txt…」→ 正文 + 建议文件名交给 chapter:rescue(save)，成功给一次性提示', async () => {
  const { host, calls } = makeHost({ modalAction: 'save', text: '作者写了 2000 字' });
  await create(host).handleSaveFailure({ code: 'BOOK_MISSING', message: '书文件夹已经不在了' });
  assert.deepEqual(calls.rescue, [['作者写了 2000 字', 'save', '第1章：第一章']]);
  assert.deepEqual(calls.toast, [['已另存：C:/tmp/救稿.txt', undefined]]);
  assert.deepEqual(calls.save, [], '救稿不是保存：不许顺手再写一次书库');
});

test('V302：另存对话框被取消 → 静默返回（没有落盘就别说已另存）', async () => {
  const { host, calls } = makeHost({ modalAction: 'save', rescueCanceled: true });
  await create(host).handleSaveFailure({ code: 'CHAPTER_MISSING', message: '文件没了' });
  assert.equal(calls.rescue.length, 1);
  assert.deepEqual(calls.toast, []);
});

test('V302：选「复制正文」→ chapter:rescue(copy)，提示字数（不写盘）', async () => {
  const { host, calls } = makeHost({ modalAction: 'copy' });
  await create(host).handleSaveFailure({ code: 'CHAPTER_MISSING', message: '文件没了' });
  assert.deepEqual(calls.rescue, [['还没落盘的正文', 'copy', '第1章：第一章']]);
  assert.deepEqual(calls.toast, [['已复制正文（42 字）', undefined]]);
});

test('V302：救稿 IPC 自己失败 → 明确的错误提示（silent 保存不弹对话框、只写状态栏）', async () => {
  const loud = makeHost({ modalAction: 'save', rescueThrows: true });
  await create(loud.host).handleSaveFailure({ code: 'CHAPTER_MISSING', message: '文件没了' });
  assert.deepEqual(loud.calls.toast, [['救稿出口失败：IPC 失败', 'error']]);

  // 审计修复 #5 / #6：静默保存（关窗 / 强制退出的最后一趟）不许弹模态框 —— 调用方在等 Promise，
  // 窗口可能马上就被销毁，没人点得了对话框；失败照旧回给调用方（状态栏由 renderer 写）。
  const quiet = makeHost({ modalAction: 'save', rescueThrows: true });
  assert.equal(
    await create(quiet.host).handleSaveFailure({ code: 'CHAPTER_MISSING', message: '文件没了' }, { silent: true }),
    null
  );
  assert.deepEqual(quiet.calls.modal, [], 'silent 保存不弹救稿对话框');
  assert.deepEqual(quiet.calls.toast, [], 'silent 保存不打扰');
});

test('V302：当前章已不在书目里（载章失败态）也能给出建议文件名，不抛错', async () => {
  const { host, calls } = makeHost({ index: -1, modalAction: 'save' });
  await create(host).handleSaveFailure({ code: 'CHAPTER_MISSING', message: '文件没了' });
  assert.deepEqual(calls.rescue, [['还没落盘的正文', 'save', '未保存的这一章']]);
});

// ---------- V301：外部改动 → 覆盖 / 另存 / 放弃并重载 ----------
function externalErr() {
  return { code: 'EXTERNAL_CHANGE', message: '这一章在载入之后被应用外的程序改过，已阻止这次保存。' };
}

test('V301：弹窗逐字（取消 / 放弃并重载 / 覆盖保存 / 先另存一份），取消 = 什么都不做', async () => {
  const { host, state, calls } = makeHost({ modalAction: 'cancel' });
  const result = await create(host).handleSaveFailure(externalErr());
  assert.equal(calls.modal.length, 1);
  const modal = calls.modal[0];
  assert.equal(modal.title, '这一章在应用外被改过');
  assert.match(modal.message, /应用外的程序改过/);
  assert.match(modal.message, /直接保存会盖掉磁盘上那一版正文/);
  assert.deepEqual(modal.buttons, [
    { label: '取消', value: 'cancel' },
    { label: '放弃我的修改并重载', value: 'reload' },
    { label: '仍然覆盖保存', value: 'overwrite', kind: 'danger' },
    { label: '先另存一份', value: 'save-copy', kind: 'primary' }
  ]);
  assert.equal(modal.cancelValue, 'cancel');
  assert.deepEqual(calls.save, [], '取消：不重试保存');
  assert.deepEqual(calls.load, [], '取消：不重载');
  assert.equal(state.dirty, true, '取消：编辑区仍是未保存');
  assert.deepEqual(result, { ok: false, code: 'EXTERNAL_CHANGE', message: externalErr().message });
});

test('V301：选「仍然覆盖保存」→ 解除 saving 并以 force 重进 saveCurrent，回执原样上抛', async () => {
  const { host, state, calls } = makeHost({ modalAction: 'overwrite', saveResult: { ok: true, data: { mtimeMs: 999 } } });
  const result = await create(host).handleSaveFailure(externalErr(), { silent: false });
  assert.deepEqual(calls.save, [{ silent: false, force: true }]);
  assert.equal(state.saving, false, '重试前必须解除「正在保存」，否则被 BUSY 挡回');
  assert.deepEqual(result, { ok: true, data: { mtimeMs: 999 } });
});

test('V301：覆盖保存又失败 → 把重试的真实回执上抛（不盖成笼统的失败）', async () => {
  const failed = { ok: false, code: 'EPERM', message: '写盘失败：权限不足' };
  const { host } = makeHost({ modalAction: 'overwrite', saveResult: failed });
  assert.deepEqual(await create(host).handleSaveFailure(externalErr()), failed);
});

test('V301：选「放弃我的修改并重载」→ 重载成功后才清脏，且按冲突章 id（索引不变）', async () => {
  const { host, state, calls } = makeHost({ modalAction: 'reload', index: 1, chapters: [
    { id: 'c1', name: '第一章', file: '0001.txt' },
    { id: 'c2', name: '第二章', file: '0002.txt' }
  ] });
  const result = await create(host).handleSaveFailure(externalErr());
  assert.deepEqual(calls.load, [1]);
  assert.equal(state.dirty, false);
  assert.deepEqual(result, { ok: false, code: 'EXTERNAL_CHANGE', message: externalErr().message });
});

// ---------- E-N3（审计中 #3）红-绿锚点：重载必须先成功、后清脏；目标按冲突章 id ----------
// 真实场景：主进程比对 expectedMtimeMs 不符 → saveCurrent catch 带着 (conflictBookPath, conflictChapterId)
// 进救稿出口。冲突对话框开着的这段时间，state.index 可能已经被切章 / 换书推着走；磁盘那一章也可能
// 刚被删 / 被占用。修复前是「先 state.dirty=false，再按 live index 重载」——重载失败或载错章时，
// 编辑区里还是本地未保存正文，脏标记却已清，关窗不再提示（丢稿窗口）。
const RELOAD_CHAPTERS = [
  { id: 'c1', name: '第一章', file: '0001.txt' },
  { id: 'c2', name: '第二章', file: '0002.txt' }
];

test('R1（E-N3）：重载失败（{ok:false}）→ 不清脏、仍按冲突章 id 尝试、warn 提示', async () => {
  const { host, state, calls } = makeHost({
    modalAction: 'reload',
    index: 0,
    chapters: RELOAD_CHAPTERS,
    loadFails: true
  });
  const result = await create(host).handleSaveFailure(externalErr(), {
    conflictBookPath: 'C:/tmp/books/测试书',
    conflictChapterId: 'c2'
  });
  assert.deepEqual(calls.load, [1], '按冲突章 id 定位（c2 在下标 1），不是 live index 0');
  assert.equal(state.dirty, true, '重载失败：脏标记必须保留，关窗仍要提示');
  assert.ok(
    calls.toast.some(([message, kind]) => kind === 'warn' && /重载失败/.test(message)),
    '重载失败要有一条 warn，让作者知道正文还没保存'
  );
  assert.deepEqual(result, { ok: false, code: 'EXTERNAL_CHANGE', message: externalErr().message });
});

test('R2（E-N3）：重载抛错 → 不吞错、脏标记同样保留', async () => {
  const { host, state } = makeHost({ modalAction: 'reload', index: 1, chapters: RELOAD_CHAPTERS, loadThrows: true });
  await assert.rejects(
    () => create(host).handleSaveFailure(externalErr(), { conflictChapterId: 'c2' }),
    /load boom/,
    '重载抛错必须让调用方看到，不许当成「已重载」吞掉'
  );
  assert.equal(state.dirty, true);
});

test('R3（E-N3）：对话框开着时 state.index 漂移 → 仍按冲突章 id 载入', async () => {
  const { host, state, calls } = makeHost({
    modalAction: 'reload',
    index: 1,
    chapters: RELOAD_CHAPTERS,
    onModal: (live) => { live.index = 0; }
  });
  await create(host).handleSaveFailure(externalErr(), { conflictChapterId: 'c2' });
  assert.deepEqual(calls.load, [1], '冲突章 c2 始终在下标 1；修复前会跟着 live index 载 0');
  assert.equal(state.dirty, false, '重载成功才清脏');
});

test('R4（E-N3）：冲突章已不在书目 → 不重载、保留 dirty、warn', async () => {
  const { host, state, calls } = makeHost({ modalAction: 'reload', index: 0, chapters: RELOAD_CHAPTERS });
  const result = await create(host).handleSaveFailure(externalErr(), { conflictChapterId: 'c9' });
  assert.deepEqual(calls.load, [], '冲突章已消失：不许退化成「载 live index 那一章」');
  assert.equal(state.dirty, true);
  assert.ok(
    calls.toast.some(([message, kind]) => kind === 'warn' && /冲突章已不在书目/.test(message)),
    '要告诉作者为什么没重载'
  );
  assert.deepEqual(result, { ok: false, code: 'EXTERNAL_CHANGE', message: externalErr().message });
});

test('R5（E-N3）：已切换到另一本书 → 不拿同 id 的别书章节顶替、保留 dirty、warn', async () => {
  const { host, state, calls } = makeHost({
    modalAction: 'reload',
    index: 0,
    chapters: RELOAD_CHAPTERS,
    bookPath: 'C:/tmp/books/另一本书'
  });
  await create(host).handleSaveFailure(externalErr(), {
    conflictBookPath: 'C:/tmp/books/测试书',
    conflictChapterId: 'c1'
  });
  assert.deepEqual(calls.load, [], '书已换：冲突章身份对新书不成立（章 id 可能撞名）');
  assert.equal(state.dirty, true);
  assert.ok(
    calls.toast.some(([message, kind]) => kind === 'warn' && /换了书/.test(message)),
    '要告诉作者为什么没重载'
  );
});

test('V301：选「先另存一份」→ 走 chapter:rescue 落 txt，编辑区仍是未保存（不覆盖书库）', async () => {
  const { host, state, calls } = makeHost({ modalAction: 'save-copy' });
  const result = await create(host).handleSaveFailure(externalErr());
  assert.deepEqual(calls.rescue, [['还没落盘的正文', 'save', '第1章：第一章']]);
  assert.deepEqual(calls.save, [], '另存一份 ≠ 覆盖保存');
  assert.equal(state.dirty, true);
  assert.deepEqual(result, { ok: false, code: 'EXTERNAL_CHANGE', message: externalErr().message });
});

test('非本模块管的错误码 → 返回 null（renderer 照旧走状态栏 + toast）', async () => {
  const { host, calls } = makeHost();
  for (const code of ['CROSS_WINDOW_BUSY', 'META_SAVE_FAILED', 'NO_CHAPTER']) {
    assert.equal(await create(host).handleSaveFailure({ code, message: 'x' }), null, code);
  }
  assert.deepEqual(calls.modal, []);
  assert.deepEqual(calls.save, []);
});

// ---------- 静态闸门：接线 / 加载顺序 / 模块纯度 ----------
test('接线：index.html 在 renderer.js 之前加载 save-rescue-ui.js 且只加载一次', () => {
  const order = [...indexSrc.matchAll(/<script src="([^"]+)"><\/script>/g)].map((hit) => hit[1]);
  const at = order.indexOf('save-rescue-ui.js');
  assert.ok(at > -1, 'index.html 必须加载 save-rescue-ui.js');
  assert.ok(at < order.indexOf('renderer.js'), '必须排在 renderer.js 之前');
  assert.equal(order.filter((name) => name === 'save-rescue-ui.js').length, 1, '只许加载一次');
  assert.equal(
    order.indexOf('save-status-ui.js') < at,
    true,
    '排在 save-status-ui.js 之后（同一块的「保存反馈」拆成两份，顺序与文档一致）'
  );
});

test('接线：renderer.js 与模块按全局名装配，只 create 一次，缺失成员走 assert-host', () => {
  assert.match(moduleSrc, /root\.CWSaveRescueUi = factory\(root\.CWAssertHost && root\.CWAssertHost\.assertHost\);/);
  assert.match(rendererCode, /const saveRescueUiModule = window\.CWSaveRescueUi;/);
  assert.equal((rendererCode.match(/saveRescueUiModule\.create\(/g) || []).length, 1, '只 create 一次');
  assert.match(rendererCode, /const saveRescueUi = saveRescueUiModule\.create\(\{/);
  for (const key of ['state', 'api', 'call', 'openModal', 'toast', 'editorEl', 'saveCurrent', 'loadChapterAt', 'chapterTitle']) {
    assert.match(
      rendererCode,
      new RegExp('saveRescueUiModule\\.create\\(\\{[\\s\\S]{0,400}\\b' + key + '(?=[,\\s}])'),
      `create 的 host 缺 ${key}`
    );
  }
  assert.ok(moduleCode.includes("assertHost('createSaveRescueUi', host, REQUIRED_HOST);"), 'host 校验走共享实现');
  // UMD 的 Node 分支只取 assert-host，运行时代码不 await 文件系统 / IPC
  const runtimeCode = moduleCode.split("module.exports = factory(require('./assert-host').assertHost);").join('');
  for (const forbidden of ['require(', 'ipcRenderer', 'node:fs', 'child_process', 'fetch(', 'document.']) {
    assert.equal(runtimeCode.includes(forbidden), false, forbidden);
  }
  // 只写 state.saving / state.dirty 两个字段（都由作者在对话框里的明确选择驱动）
  const writes = [...moduleCode.matchAll(/state\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)].map((hit) => hit[1]);
  assert.deepEqual([...new Set(writes)].sort(), ['dirty', 'saving']);
});

test('接线（V301）：saveCurrent 带 expectedMtimeMs；只有「覆盖保存」传 force', () => {
  const start = rendererCode.indexOf('async function saveCurrent(');
  assert.ok(start > 0, 'renderer.js 里找不到 saveCurrent');
  const body = rendererCode.slice(start, rendererCode.indexOf('\n  // ---------- 切换', start));
  assert.match(body, /async function saveCurrent\(\{ silent = false, force = false \} = \{\}\)/);
  assert.match(body, /const expectedMtimeMs = force \? 0 : state\.loadedMtimeMs;/);
  assert.match(body, /api\.saveChapter, bookPath, chapterId, text, expectedMtimeMs\)/);
  // 失败分支：先写状态栏，再交给救稿出口；救稿码不再额外弹一条通用的「保存失败」toast
  assert.match(body, /state\.saveError = err\.message;\s*\n\s*updateStatus\(\);/);
  const rescueAt = body.indexOf('saveRescueUi.rescuePlanFor(err.code)');
  assert.ok(rescueAt > 0, 'saveCurrent 失败分支没接救稿出口');
  // E-N3：救稿出口必须带着发起保存时拍下的冲突章身份（书 + 章 id），不能退回 live state.index
  const handleAt = body.indexOf('return await saveRescueUi.handleSaveFailure(err, {');
  assert.ok(handleAt > rescueAt, '救稿出口调用必须在 rescuePlanFor 之后');
  const handleCall = body.slice(handleAt, body.indexOf('});', handleAt) + 3);
  assert.match(handleCall, /silent/);
  assert.match(handleCall, /conflictBookPath:\s*bookPath/);
  assert.match(handleCall, /conflictChapterId:\s*chapterId/);
  assert.ok(
    body.indexOf("toast(`保存失败：${err.message}`, 'error')") > rescueAt,
    '通用失败 toast 必须排在救稿判定之后（救稿码不重复弹）'
  );
  // META_SAVE_FAILED 的部分成功分支在救稿判定之前（正文已落盘，不是救稿场景）
  assert.ok(body.indexOf("err.code === 'META_SAVE_FAILED'") < rescueAt);
});

test('接线（V301）：preload 透传第 4 参数，main.js 交给 prepareChapterSave 比对', () => {
  const preload = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(preload, /saveChapter: \(bookPath, chapterId, text, expectedMtimeMs\) =>/);
  assert.match(preload, /invoke\('chapter:save', bookPath, chapterId, text, expectedMtimeMs\)/);
  const mainPath = require('node:path').join(__dirname, '..', 'main.js');
  const main = require('node:fs').readFileSync(mainPath, 'utf8').replace(/\r\n/g, '\n');
  assert.match(main, /handleBook\('chapter:save', async \(bookPath, chapterId, text, expectedMtimeMs\) => \{/);
  const start = main.indexOf("handleBook('chapter:save'");
  const body = main.slice(start, main.indexOf('\n  });', start));
  assert.match(body, /expectedMtimeMs\s*\n?\s*\}\);/);
  assert.match(body, /await storage\.prepareChapterSave\(bookPath, chapterId, \{\s*\n\s*windowId: session \? session\.id : null,\s*\n\s*expectedMtimeMs\s*\n\s*\}\);/);
});