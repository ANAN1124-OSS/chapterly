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
      return { ok: true, data: { removed: 1 } };
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
      editorEl.value = text;
      state.dirty = options.baseText == null ? true : text !== options.baseText;
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

test('U3 恢复提示：读全文 → 载章 → 正文只进编辑区 → 删草稿（同书不重开 / 换书先开书）', async () => {
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
  assert.deepEqual(same.calls.discard, [{ draftId: 'd1' }], '恢复成功后删草稿');

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
  assert.deepEqual(cross.calls.discard, [{ draftId: 'd1' }]);
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
  assert.match(renderer, /crashRecoveryUiModule\.create\(\{/, 'bindEvents 里要 create');
  assert.match(renderer, /crashRecoveryUi\.start\(\)/, '启动时要 start（周期上报 + 恢复检查）');
  assert.match(renderer, /crashRecoveryUi\.noteSaved\(/, '保存成功后要删对应草稿');
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
  assert.match(settingsUi, /crashDraftEnabled: \$\('settings-crash-draft-enabled'\)\.checked === true/, '设置保存带上开关');
  assert.match(settingsUi, /cfg\.crashDraftEnabled === true/, '设置回填只认真正的 true');
  const settingsIa = read('renderer/settings-ia.js');
  assert.match(settingsIa, /'settings-crash-draft-enabled': 'data'/, '开关归「数据安全」分区');
});