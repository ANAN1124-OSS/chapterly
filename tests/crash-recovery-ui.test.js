// WP5（N1 / 中 #6）：崩溃恢复 UI（renderer/crash-recovery-ui.js）的假 host 行为锚点 + 接线闸门。
//
// 覆盖四件事：
//   1. 默认关绝不写盘（不调 saveCrashDraft）；打开后只在「写作页 + dirty + 空闲」时写；
//   2. 启动 / 重载后的恢复提示：恢复 → 读全文 → 必要时开书 + 载章 → 正文只进编辑区 → 删草稿；
//      丢弃 / 先留着不误删、不覆盖编辑区；
//   3. 失败路径（读草稿 / 开书 / 载章 / 写盘）只 toast + 保留草稿，不抛；
//   4. 接线：renderer.js / index.html / assembly-manifest / preload / main / E2E 组 83。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const crashRecoveryUi = require('../renderer/crash-recovery-ui');

const ROOT = path.join(__dirname, '..');
const BOOK = 'C:\\书库\\测试书';
const OTHER_BOOK = 'C:\\书库\\另一本 书';

function draftMeta(overrides = {}) {
  return {
    draftId: 'd1',
    bookPath: BOOK,
    bookTitle: '测试书',
    chapterId: 'ch_001',
    chapterName: '第一章',
    chapterTitle: '第一章',
    chapterIndex: 0,
    at: '2026-11-17T20:00:00.000Z',
    chars: 9,
    ...overrides
  };
}

function makeHost(options = {}) {
  const calls = { save: [], recovery: 0, read: [], discard: [], open: [], load: [], toasts: [], modals: [] };
  const answers = (options.answers || []).slice();
  const state = {
    view: options.view || 'editor',
    bookPath: options.bookPath || BOOK,
    bookId: 'b1',
    index: options.index == null ? 0 : options.index,
    chapters: options.chapters || [{ id: 'ch_001', name: '第一章', file: '0001-第一章.txt' }],
    loadedChapterId: options.loadedChapterId || 'ch_001',
    config: { crashDraftEnabled: options.enabled === true },
    dirty: options.dirty !== false,
    loading: Boolean(options.loading),
    saving: Boolean(options.saving),
    importing: false,
    meta: { title: '测试书' }
  };
  const editorEl = { value: options.text == null ? '未保存的正文' : options.text };
  const api = {
    async saveCrashDraft(payload) {
      calls.save.push(payload);
      return options.saveResult || { ok: true, data: { saved: true, draftId: 'd1', chars: payload.text.length } };
    },
    async crashRecovery() {
      calls.recovery += 1;
      return (
        options.recoveryResult || {
          ok: true,
          data: {
            enabled: state.config.crashDraftEnabled,
            previousExitAbnormal: false,
            drafts: options.drafts || []
          }
        }
      );
    },
    async readCrashDraft(draftId) {
      calls.read.push(draftId);
      return (
        options.readResult || {
          ok: true,
          data: { draft: { ...draftMeta(), text: options.recoveredText == null ? '上次崩溃前的正文' : options.recoveredText } }
        }
      );
    },
    async discardCrashDraft(target) {
      calls.discard.push(target);
      // 与主进程 IPC 的真实回执同形：删文件回 { ok:true, removed:N }；
      // S2 / 旧M4：consumed = 只标记「已交给某窗口的编辑区」，文件保留（removed 恒 0）。
      // I7（三审）：consumedResult 可注入「真实 IPC 包络」形状（{ ok:true, data:{…} }）。
      if (target && target.consumed === true) {
        if (options.consumedResult) return options.consumedResult;
        return { ok: true, consumed: true, removed: 0 };
      }
      if (options.discardResult) return options.discardResult;
      return { ok: true, removed: 1 };
    }
  };
  const host = {
    state,
    api,
    editorEl,
    toast: (message, kind) => calls.toasts.push({ message, kind }),
    async openModal(opts) {
      calls.modals.push(opts);
      const answer = answers.length ? answers.shift() : 'cancel';
      const action = typeof answer === 'string' ? answer : (answer && answer.action) || 'cancel';
      return { action };
    },
    chapterTitle: (index, name) => `第${index + 1}章：${name || ''}`,
    async openBookByPath(bookPath) {
      calls.open.push(bookPath);
      if (options.openResult && options.openResult.ok === false) return options.openResult;
      state.bookPath = bookPath;
      if (options.afterOpenChapters) {
        state.chapters = options.afterOpenChapters;
        state.index = 0;
        state.loadedChapterId = options.afterOpenChapters[0] && options.afterOpenChapters[0].id;
      }
      return options.openResult || { ok: true };
    },
    async loadChapterAt(index) {
      calls.load.push(index);
      if (options.loadResult && options.loadResult.ok === false) return options.loadResult;
      const chapter = state.chapters[index];
      state.index = index;
      state.loadedChapterId = chapter ? chapter.id : null;
      return options.loadResult || { ok: true };
    },
    applyRecoveredText(text) {
      calls.applied = text;
      // REDT-A-04：写入闸拒绝时回 { ok:false }（真实 renderer 的 applyRecoveredText 现在这样返回）
      if (options.appliedResult) return options.appliedResult;
      editorEl.value = text;
      state.dirty = options.baseText == null ? true : text !== options.baseText;
      return { ok: true };
    }
  };
  return { host, state, editorEl, calls, api };
}

test('U1 默认关不写盘：snapshotNow 不调 saveCrashDraft，返回 DISABLED', async () => {
  const { host, calls } = makeHost({ enabled: false });
  const ui = crashRecoveryUi.create(host);
  assert.deepEqual(await ui.snapshotNow(), { ok: false, code: 'DISABLED' });
  assert.equal(calls.save.length, 0);
  const info = ui.snapshotState();
  assert.equal(info.enabled, false);
  assert.equal(info.lastSnapshotAt, 0);
});

test('U2 打开后只在「写作页 + dirty + 空闲 + 有正文」时写；内容没变不重复写', async () => {
  const { host, state, calls } = makeHost({ enabled: true, text: '未保存的正文' });
  const ui = crashRecoveryUi.create(host);

  const first = await ui.snapshotNow();
  assert.equal(first.ok, true);
  assert.equal(calls.save.length, 1);
  const payload = calls.save[0];
  assert.equal(payload.bookPath, BOOK);
  assert.equal(payload.bookTitle, '测试书');
  assert.equal(payload.chapterId, 'ch_001');
  assert.equal(payload.chapterTitle, '第一章');
  assert.equal(payload.chapterIndex, 0);
  assert.equal(payload.text, '未保存的正文');
  assert.equal(Number.isNaN(Date.parse(payload.at)), false, 'at 是合法时间戳');

  const repeat = await ui.snapshotNow();
  assert.equal(repeat.ok, true);
  assert.equal(repeat.skipped, true, '同一份内容不重复写盘');
  assert.equal(calls.save.length, 1);

  const codes = [];
  state.dirty = false;
  codes.push((await ui.snapshotNow()).code);
  state.dirty = true;
  state.loading = true;
  codes.push((await ui.snapshotNow()).code);
  state.loading = false;
  state.saving = true;
  codes.push((await ui.snapshotNow()).code);
  state.saving = false;
  state.importing = true;
  codes.push((await ui.snapshotNow()).code);
  state.importing = false;
  state.view = 'shelf';
  codes.push((await ui.snapshotNow()).code);
  state.view = 'editor';
  state.index = -1;
  codes.push((await ui.snapshotNow()).code);
  state.index = 0;
  host.editorEl.value = '';
  codes.push((await ui.snapshotNow()).code);

  assert.deepEqual(codes, ['CLEAN', 'BUSY', 'BUSY', 'BUSY', 'NO_TARGET', 'NO_TARGET', 'EMPTY']);
  assert.equal(calls.save.length, 1, '这些分支都不写盘');
});

// RPAN-B01（第五轮审计）：旧跳过条件把「内容没变」和「距上次写入不足 30 秒」用 AND 组合，
// 而定时器每 30000ms 才触发（只会晚到）——时间条件在周期路径上恒假，静止写作照样每 30 秒
// 整篇重写一次草稿，并把 at 时间戳刷成最后一次重写时刻。
test('RPAN-B01：内容没变时，超过 30 秒周期也不再重写草稿（时间条件不许卡住跳过）', async () => {
  const { host, calls } = makeHost({ enabled: true, text: '未保存的正文' });
  const ui = crashRecoveryUi.create(host);
  const realNow = Date.now;
  try {
    assert.equal((await ui.snapshotNow()).ok, true);
    assert.equal(calls.save.length, 1);
    const t0 = realNow();
    Date.now = () => t0 + 31000; // 30 秒周期触发时 now - lastSnapshotAt ≥ 30000（旧条件恒假）
    const repeat = await ui.snapshotNow();
    assert.equal(repeat.skipped, true, '内容没变就必须跳过，与距离上次多久无关');
    assert.equal(calls.save.length, 1, '静止写作期不许每 30 秒重写一遍（写放大 + 刷新 at 时间戳）');
    // 内容一变就必须写：跳过只看内容，不是把整章永久冻结
    host.editorEl.value = '未保存的正文（补一句）';
    const changed = await ui.snapshotNow();
    assert.equal(changed.ok, true);
    assert.equal(calls.save.length, 2);
  } finally {
    Date.now = realNow;
  }
});

test('RPAN-B01：换了一章但正文恰好相同 → 必须写新草稿（身份键含书 + 章）', async () => {
  const chapters = [
    { id: 'ch_001', name: '第一章', file: '0001-第一章.txt' },
    { id: 'ch_002', name: '第二章', file: '0002-第二章.txt' }
  ];
  const { host, state, calls } = makeHost({ enabled: true, text: '同样的正文', chapters });
  const ui = crashRecoveryUi.create(host);
  await ui.snapshotNow();
  state.index = 1;
  state.loadedChapterId = 'ch_002';
  const second = await ui.snapshotNow();
  assert.equal(second.ok, true);
  assert.equal(second.skipped, undefined, '换章后不许沿用上一章「内容没变」的结论');
  assert.equal(calls.save.length, 2);
  assert.equal(calls.save[1].chapterId, 'ch_002');
});

test('U3 恢复提示：读全文 → 载章 → 正文只进编辑区 → 只标记已恢复（旧M4：不删草稿）', async () => {
  // 同书同章：不重开书，直接载章
  const same = makeHost({ enabled: true, dirty: false, drafts: [draftMeta()], answers: ['restore'] });
  const uiSame = crashRecoveryUi.create(same.host);
  await uiSame.checkRecovery();
  assert.equal(same.calls.modals.length, 1, '弹一次恢复提示');
  const modal = same.calls.modals[0];
  assert.match(modal.title, /崩溃/);
  assert.match(modal.message, /测试书/);
  assert.match(modal.message, /第1章：第一章/);
  assert.match(modal.message, /9 字/);
  assert.match(modal.message, /不是自动保存/);
  assert.deepEqual(
    modal.buttons.map((button) => button.value),
    ['later', 'discard', 'restore']
  );
  assert.equal(modal.cancelValue, 'later');
  assert.deepEqual(same.calls.read, ['d1']);
  assert.deepEqual(same.calls.open, [], '同一本书不重开');
  assert.deepEqual(same.calls.load, [0]);
  assert.equal(same.calls.applied, '上次崩溃前的正文');
  assert.equal(same.state.dirty, true, '恢复后仍是未保存状态（Ctrl+S 才写盘）');
  // 旧M4（一轮·中）：恢复成功**不许**删草稿文件 —— 恢复出来的正文只在编辑区（仍未保存），
  // 草稿是它唯一的磁盘兜底。只标记「本窗口已恢复」（其它窗口不再重复提示）。
  assert.deepEqual(
    same.calls.discard,
    [{ draftId: 'd1', consumed: true }],
    '恢复成功只标记已恢复，不删草稿（删了再崩一次就没兜底了）'
  );

  // 换书：先 openBookByPath 再载章
  const cross = makeHost({
    enabled: true,
    dirty: false,
    bookPath: OTHER_BOOK,
    enabled2: true,
    chapters: [{ id: 'ch_other', name: '另一章', file: '0001-另一章.txt' }],
    loadedChapterId: 'ch_other',
    afterOpenChapters: [{ id: 'ch_001', name: '第一章', file: '0001-第一章.txt' }],
    drafts: [draftMeta()],
    answers: ['restore']
  });
  const uiCross = crashRecoveryUi.create(cross.host);
  await uiCross.checkRecovery();
  assert.deepEqual(cross.calls.open, [BOOK], '草稿属于另一本书时先打开那本书');
  assert.deepEqual(cross.calls.load, [0]);
  assert.equal(cross.calls.applied, '上次崩溃前的正文');
  assert.deepEqual(cross.calls.discard, [{ draftId: 'd1', consumed: true }]);
});

test('U4 丢弃 / 先留着：只删草稿或什么都不删，绝不碰编辑区', async () => {
  const discard = makeHost({ enabled: true, dirty: false, drafts: [draftMeta()], answers: ['discard'], text: '磁盘上的正文' });
  const uiDiscard = crashRecoveryUi.create(discard.host);
  await uiDiscard.checkRecovery();
  assert.deepEqual(discard.calls.discard, [{ draftId: 'd1' }]);
  assert.deepEqual(discard.calls.load, []);
  assert.equal(discard.editorEl.value, '磁盘上的正文', '丢弃草稿不改编辑区');

  const later = makeHost({
    enabled: true,
    dirty: false,
    drafts: [draftMeta(), draftMeta({ draftId: 'd2', chapterId: 'ch_002', chapterName: '第二章' })],
    answers: ['later']
  });
  const uiLater = crashRecoveryUi.create(later.host);
  await uiLater.checkRecovery();
  assert.deepEqual(later.calls.discard, [], '先留着 = 不删');
  assert.equal(later.calls.modals.length, 1, '作者选择先留着后不再连着弹下一条');
  assert.deepEqual(later.calls.read, []);
});

test('REDT-A-04：写入闸拒绝（开书在途 / 载章中）时保留草稿并提示稍后再试', async () => {
  const { host, calls } = makeHost({
    enabled: true,
    dirty: false,
    drafts: [draftMeta()],
    answers: ['restore'],
    appliedResult: { ok: false, code: 'LOCKED', message: '正在切换书籍或章节，请稍候再试' }
  });
  const ui = crashRecoveryUi.create(host);
  await ui.checkRecovery();
  assert.equal(calls.applied, '上次崩溃前的正文', '仍然尝试写入（闸在渲染层判定）');
  assert.deepEqual(calls.discard, [], '闸拒绝时草稿必须保留');
  assert.equal(
    calls.toasts.some((item) => item.kind === 'warn' && /正在切换书籍或章节/.test(item.message)),
    true,
    '要如实转述闸的拒绝原因'
  );
});

test('RPAN-B04：恢复失败时把「已被换成的书」切回原书（不把作者留在草稿所属的书里）', async () => {
  const { host, state, calls } = makeHost({
    enabled: true,
    dirty: false,
    bookPath: OTHER_BOOK,
    chapters: [{ id: 'ch_other', name: '另一章', file: '0001-另一章.txt' }],
    loadedChapterId: 'ch_other',
    afterOpenChapters: [], // 打开草稿所属书后书目里没有目标章 → 恢复中止
    drafts: [draftMeta()],
    answers: ['restore']
  });
  const ui = crashRecoveryUi.create(host);
  await ui.checkRecovery();
  assert.deepEqual(calls.open, [BOOK, OTHER_BOOK], '先开草稿的书，失败后回切原来的书');
  assert.equal(state.bookPath, OTHER_BOOK, '失败后作者仍停在自己原来的书上');
  assert.deepEqual(calls.discard, [], '失败不删草稿');
  assert.deepEqual(calls.load, [], '失败时不许载入别的章');
});

test('U5 失败路径：读草稿 / 开书 / 载章 / 写盘失败都只提示并保留草稿，不抛', async () => {
  const readFail = makeHost({
    enabled: true,
    dirty: false,
    drafts: [draftMeta()],
    answers: ['restore'],
    readResult: { ok: false, code: 'DRAFT_MISSING', message: '草稿不在了' }
  });
  const uiRead = crashRecoveryUi.create(readFail.host);
  await uiRead.checkRecovery();
  assert.equal(readFail.calls.toasts.length >= 1, true);
  assert.deepEqual(readFail.calls.discard, [], '读不到草稿时不删（留给作者再试）');
  assert.deepEqual(readFail.calls.load, []);

  const openFail = makeHost({
    enabled: true,
    dirty: false,
    bookPath: OTHER_BOOK,
    drafts: [draftMeta()],
    answers: ['restore'],
    openResult: { ok: false, code: 'BAD_PATH', message: '书打不开' }
  });
  const uiOpen = crashRecoveryUi.create(openFail.host);
  await uiOpen.checkRecovery();
  assert.deepEqual(openFail.calls.open, [BOOK]);
  assert.deepEqual(openFail.calls.load, []);
  assert.deepEqual(openFail.calls.discard, [], '开书失败保留草稿');
  assert.equal(openFail.calls.toasts.some((item) => item.kind === 'error' || item.kind === 'warn'), true);

  const loadFail = makeHost({
    enabled: true,
    dirty: false,
    drafts: [draftMeta()],
    answers: ['restore'],
    loadResult: { ok: false, code: 'CHAPTER_MISSING', message: '章不在了' }
  });
  const uiLoad = crashRecoveryUi.create(loadFail.host);
  await uiLoad.checkRecovery();
  assert.deepEqual(loadFail.calls.load, [0]);
  assert.deepEqual(loadFail.calls.discard, [], '载章失败保留草稿');

  const saveFail = makeHost({ enabled: true, saveResult: { ok: false, code: 'ENOSPC', message: '磁盘满了' } });
  const uiSave = crashRecoveryUi.create(saveFail.host);
  const result = await uiSave.snapshotNow();
  assert.deepEqual(result.ok, false);
  assert.equal(result.code, 'ENOSPC');
});

test('U6 编辑区已有未保存修改：不弹恢复提示、不覆盖现有内容（草稿保留）', async () => {
  const { host, calls } = makeHost({ enabled: true, dirty: true, drafts: [draftMeta()], answers: ['restore'] });
  const ui = crashRecoveryUi.create(host);
  await ui.checkRecovery();
  assert.equal(calls.modals.length, 0, '当前编辑区有未保存修改时不覆盖');
  assert.deepEqual(calls.discard, []);
  assert.equal(calls.toasts.some((item) => item.kind === 'warn'), true);
});

test('U7 noteSaved 删对应草稿；host 缺成员按 assertHost 口径报错', async () => {
  const { host, calls } = makeHost({ enabled: true });
  const ui = crashRecoveryUi.create(host);
  await ui.noteSaved(BOOK, 'ch_001');
  assert.deepEqual(calls.discard, [{ bookPath: BOOK, chapterId: 'ch_001' }]);

  assert.throws(() => crashRecoveryUi.create(null), /createCrashRecoveryUi 需要 host 对象/);
  const missing = makeHost({ enabled: true }).host;
  delete missing.chapterTitle;
  assert.throws(
    () => crashRecoveryUi.create(missing),
    /createCrashRecoveryUi 的 host 缺少 chapterTitle/
  );
});

// ---------- 接线闸门（政策类）：新增模块 / 频道 / 主进程接线 / E2E 组 ----------
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('接线：renderer.js / index.html / 装配清单 / preload / main / E2E 组 83 全接上', () => {
  const renderer = read('renderer/renderer.js');
  assert.match(renderer, /const crashRecoveryUiModule = window\.CWCrashRecoveryUi;/, 'renderer.js 要有模块常量');
  assert.match(renderer, /crashRecoveryUiModule\.create\(\{/, '装配区里要 create');
  // M1 第十三刀（第 16 轮）：实例创建从 bindEvents 提前到装配区（notify-events-ui 的订阅段依赖它），
  // start() 仍在 bindEvents 原位。
  const createAt = renderer.indexOf('crashRecoveryUi = crashRecoveryUiModule.create({');
  assert.ok(createAt > 0 && createAt < renderer.indexOf('  function bindEvents() {'), 'create 要早于 bindEvents（装配区内）');
  assert.match(renderer, /crashRecoveryUi\.start\(\)/, '启动时要 start（周期上报 + 恢复检查）');
  // WP17 A3 第二刀：saveCurrent 整段迁到 save-chain-ui.js；noteSaved 的接点在模块里（按 getter 现取）。
  assert.match(read('renderer/save-chain-ui.js'), /getCrashRecoveryUi\(\)\.noteSaved\(/, '保存成功后要删对应草稿');
  assert.equal(/crashRecoveryUi\.noteSaved\(/.test(renderer), false, '保存链已迁出 renderer.js，不许再留第二份');
  // 两个测试钩子实际定义在 renderer/test-hooks.js（renderer.js 只把 crashRecoveryUi 放进 testHooksScope），
  // 所以静态断言的目标是钩子源码本身；正则与严格度不变。
  const hooks = read('renderer/test-hooks.js');
  assert.match(hooks, /crashDraftTick:/, 'testHooksScope 要有 crashDraftTick');
  assert.match(hooks, /setCrashDraftEnabled:/, 'testHooksScope 要有 setCrashDraftEnabled');

  const html = read('renderer/index.html');
  assert.match(html, /<script src="crash-recovery-ui\.js"><\/script>/, 'index.html 要加载新模块');
  assert.match(html, /id="settings-crash-draft-enabled"/, '设置里要有崩溃草稿开关');
  const manifest = require('../renderer/assembly-manifest');
  const entry = manifest.MODULES.find((row) => row[0] === 'crash-recovery-ui.js');
  assert.ok(entry, '装配清单要登记 crash-recovery-ui.js');
  assert.equal(entry[1], 'CWCrashRecoveryUi');
  assert.equal(entry[2], 'crashRecoveryUiModule');

  const preload = read('preload.js');
  for (const channel of ['crash:draft', 'crash:recovery', 'crash:read-draft', 'crash:discard-draft']) {
    assert.ok(preload.includes(`invoke('${channel}'`), `preload 要暴露 ${channel}`);
  }

  const main = read('main.js');
  for (const channel of ['crash:draft', 'crash:recovery', 'crash:read-draft', 'crash:discard-draft']) {
    assert.ok(main.includes(`handle('${channel}'`), `main.js 要注册 ${channel}`);
  }
  assert.match(main, /render-process-gone/, '崩溃处置入口还在');
  assert.match(main, /crashRecovery\.decideRenderCrash\(/, 'render-process-gone 要走纯决策');
  assert.match(main, /crashRecovery\.unresponsivePlan\(/, 'unresponsive 要给出口');
  assert.match(main, /reloadFailureDialog\(/, 'reload 失败要有对话框出口');
  assert.match(main, /endSession\(\)/, '退出要结束崩溃草稿会话');

  const groupFile = path.join(ROOT, 'scripts', 'e2e', 'groups', '83-crash-recovery.js');
  assert.ok(fs.existsSync(groupFile), 'E2E 第 83 组文件要存在');
  const index = read('scripts/e2e/groups/index.js');
  assert.match(index, /83-crash-recovery/, 'E2E 组索引要登记第 83 组');
  const scenario = read('scripts/e2e-scenario.js');
  assert.match(scenario, /idsFrom\(60\)/, '第 83 组随 idsFrom(60) 在组尾跑');

  const settingsUi = read('renderer/settings-ui.js');
  // RSHE-A-07：保存 payload 的 DOM 读取统一「先判空再取值」（与相邻的 clipboardWatchEnabled 同口径）。
  assert.match(
    settingsUi,
    /crashDraftEnabled: \$\('settings-crash-draft-enabled'\) \? \$\('settings-crash-draft-enabled'\)\.checked === true : false/,
    '设置保存带上开关'
  );
  assert.match(settingsUi, /cfg\.crashDraftEnabled === true/, '设置回填只认真正的 true');
  const settingsIa = read('renderer/settings-ia.js');
  assert.match(settingsIa, /'settings-crash-draft-enabled': 'data'/, '开关归「数据安全」分区');
});

// 旧M4（一轮·中）/ L1（一轮·低）：草稿的删除时机与失败提示。
// 恢复出来的正文只在编辑区（仍是未保存状态）——恢复当下删草稿，下一次崩溃就彻底没兜底了。
// 现在的口径：恢复只标记「本窗口已恢复」（主进程别的窗口不再重复提示），文件保留到
// 「成功 Ctrl+S」（noteSaved 按书 + 章删）或「下一次周期草稿落盘覆盖同一草稿位」。
test('旧M4：恢复后草稿仍在（只标记已恢复）；成功保存才按书 + 章删掉', async () => {
  const ctx = makeHost({ enabled: true, dirty: false, drafts: [draftMeta()], answers: ['restore'] });
  const ui = crashRecoveryUi.create(ctx.host);
  await ui.checkRecovery();
  assert.deepEqual(ctx.calls.discard, [{ draftId: 'd1', consumed: true }], '恢复只标记，不删文件');
  assert.ok(
    ctx.calls.discard.every((target) => target.consumed === true),
    '恢复路径一条删文件的请求都不许发'
  );

  // 恢复后编辑区是未保存状态：下一拍周期草稿用新正文覆盖同一草稿位（服务崩溃兜底）。
  ctx.state.dirty = true;
  ctx.editorEl.value = '上次崩溃前的正文 + 恢复后又写的一句';
  const snapped = await ui.snapshotNow();
  assert.equal(snapped.ok, true);
  assert.equal(ctx.calls.save.length, 1);
  assert.equal(ctx.calls.save[0].text, '上次崩溃前的正文 + 恢复后又写的一句', '草稿位被最新正文覆盖');

  // 成功保存回执（保存链的干净分支）：按快照身份删掉这一章的草稿。
  await ui.noteSaved(BOOK, 'ch_001');
  assert.deepEqual(ctx.calls.discard.at(-1), { bookPath: BOOK, chapterId: 'ch_001' });
});

test('L1：丢弃草稿失败要如实提示（不许假装已经丢掉了）', async () => {
  const ctx = makeHost({
    enabled: true,
    dirty: false,
    drafts: [draftMeta()],
    answers: ['discard'],
    discardResult: { ok: false, code: 'EPERM', message: '草稿被占用' }
  });
  const ui = crashRecoveryUi.create(ctx.host);
  await ui.checkRecovery();
  assert.deepEqual(ctx.calls.discard, [{ draftId: 'd1' }], '仍然要尝试删');
  const warn = ctx.calls.toasts.find((toast) => toast.kind === 'warn');
  assert.ok(warn, '删不掉必须有一条 warn');
  assert.match(warn.message, /没能删掉/);
  assert.match(warn.message, /下次启动会再提示/);

  // 主进程回 { ok:true, removed:0 }（文件已经不在了）也算没删掉？—— 不算失败：removed=0 只说明
  // 本来就没了，别再打扰作者。这里用默认假宿主（removed:1）覆盖成功分支。
  const okCtx = makeHost({ enabled: true, dirty: false, drafts: [draftMeta()], answers: ['discard'] });
  await crashRecoveryUi.create(okCtx.host).checkRecovery();
  assert.equal(okCtx.calls.toasts.filter((toast) => toast.kind === 'warn').length, 0, '删成功不打扰');
});

// I7（三审·低）：主进程的成功回包是 { ok:true, data }，软错误包络（{ ok:false, code, message }）在
// data 里。旧实现读顶层 result.removed / result.consumed —— 恒 undefined：删成功也提示「没能删掉」、
// 恢复成功也提示「草稿没标记掉」。这条用例用真实 IPC 形状钉住两个消费点。
test('I7（三审）：按真实 IPC 形状（{ ok:true, data }）消费包络 —— 删成功 / 标记成功都不误报', async () => {
  // 丢弃成功：data.removed = 1 → 不许弹「没能删掉」
  const discardCtx = makeHost({
    enabled: true,
    dirty: false,
    drafts: [draftMeta()],
    answers: ['discard'],
    discardResult: { ok: true, data: { ok: true, removed: 1 } }
  });
  await crashRecoveryUi.create(discardCtx.host).checkRecovery();
  assert.equal(discardCtx.calls.toasts.filter((toast) => toast.kind === 'warn').length, 0, '删成功不打扰作者');

  // 丢弃失败：data 里是软错误包络 → 必须如实提示
  const softFailCtx = makeHost({
    enabled: true,
    dirty: false,
    drafts: [draftMeta()],
    answers: ['discard'],
    discardResult: {
      ok: true,
      data: { ok: false, code: 'DRAFT_UNAVAILABLE', message: '草稿目录暂时不可用', removed: 0 }
    }
  });
  await crashRecoveryUi.create(softFailCtx.host).checkRecovery();
  const warn = softFailCtx.calls.toasts.find((toast) => toast.kind === 'warn');
  assert.ok(warn, 'data.ok === false 是软错误，必须如实提示');
  assert.match(warn.message, /没能删掉/);

  // 恢复标记成功：data.consumed = true → 恢复提示里不许出现「草稿没标记掉」
  const restoreCtx = makeHost({
    enabled: true,
    dirty: false,
    drafts: [draftMeta()],
    answers: ['restore'],
    consumedResult: { ok: true, data: { ok: true, consumed: true, removed: 0 } }
  });
  await crashRecoveryUi.create(restoreCtx.host).checkRecovery();
  const restoredToast = restoreCtx.calls.toasts.find((toast) => toast.message.includes('已恢复上次崩溃前的正文'));
  assert.ok(restoredToast, '恢复成功要有提示');
  assert.equal(restoredToast.message.includes('草稿没标记掉'), false, '标记成功却提示没标记掉 = 误报');
});

// S2（一轮·中/低）/ T6（三审·中）：崩溃草稿的跨窗口归属。main.js 不能 require（依赖 electron），
// 这里用机器清单钉住强制点；归属规则本身由 core/crash-draft.js 的 S2 / T6 用例覆盖。
test('S2 / T6 接线闸门：归属由主进程注入、crash:* 只对本窗口放行、discard 统一看开关', () => {
  const mainSrc = read('main.js');

  // ① 归属只由主进程注入（渲染层 payload 里的 owner 字段不采信），令牌每进程一枚。
  assert.match(mainSrc, /const crashOwnerToken = `p\$\{process\.pid\}-/, '本进程一次性归属令牌');
  assert.match(
    mainSrc,
    /handle\('crash:draft'[\s\S]{0,900}?store\.writeDraft\(payload, \{\s*\n\s*ownerToken: crashOwnerToken,\s*\n\s*ownerWindowId: session \? session\.id : null/,
    '写草稿时由主进程注入 ownerToken / ownerWindowId'
  );

  // ② 列表 / 读 / 删都带查看者，非本窗口的草稿一律拒绝。
  assert.match(
    mainSrc,
    /crash:recovery[\s\S]{0,900}?store\.listDrafts\(\{ ownerToken: crashOwnerToken, ownerWindowId: windowId \}\)/,
    'crash:recovery 只列本窗口可见的草稿'
  );
  assert.match(mainSrc, /crashConsumedByOtherWindow\(draft\.draftId, windowId\)/, '别的窗口恢复过的草稿不再重复提示');
  assert.match(
    mainSrc,
    /handle\('crash:read-draft'[\s\S]{0,1200}?crashDraftVisibleTo\(result\.draft, windowId\)/,
    'crash:read-draft 校验归属（不把别的窗口的未保存正文交给注入的渲染层）'
  );
  // I7（三审，断言跟错）：软错误收编 softFailure 后，错误码以 `softFailure('CODE', …)` 形式出现
  // （不再是 `code: 'CODE'` 对象字面量）—— 判据仍是「跨窗口读 / 删有明确错误码」。
  assert.match(mainSrc, /softFailure\('DRAFT_FOREIGN_WINDOW'/, '跨窗口读 / 删要回明确错误码');
  assert.match(
    mainSrc,
    /handle\('crash:discard-draft'[\s\S]{0,600}?crashDraftEnabled !== true/,
    'discard 与其它 crash 频道统一检查开关（关着不许按 id 删草稿）'
  );
  assert.match(
    mainSrc,
    /handle\('crash:discard-draft'[\s\S]{0,1600}?if \(target\.consumed === true\) \{\s*\n\s*crashConsumed\.set\(target\.draftId, windowId\);/,
    'consumed = 只标记「已交给某窗口的编辑区」，不删文件（旧M4）'
  );

  // ③ 关窗：这扇窗口的「已恢复」标记一起清（草稿文件保留，别的窗口还能看到）。
  assert.match(
    mainSrc,
    /browserWin\.on\('closed'[\s\S]{0,2200}?crashConsumed\.delete\(draftId\)/,
    '关窗清掉该窗口的 consumed 标记'
  );
});

