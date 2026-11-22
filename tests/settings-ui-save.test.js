// 设置面板测试（T9 / 第 10 轮按性质拆分）：保存 / 取消 / 重置 / 失败 / 重定基 / 在途。
// 本文件覆盖：saveSettings（按书 / 全局 / U-D4 全局入口）的 payload 与收尾 → 防重入与 savingSettings 复位 →
// 收尾刷新失败不误报（RSHE-A-03）→ 别窗配置变更重定基（M14 / RSHE-A-01）→ M15 章号已写 / 未写的失败口径 →
// closeSettings 与右上 × 的还原预览 → resetBookDisplay → 超长段落阈值两种作用域 → multi=true 不回写词表路径 →
// SS-13 写操作在途时取消 / 重置 / 重复保存被挡住。
//
// 来源：原 tests/settings-ui.test.js（1,630 行 / 51 例）按性质拆成夹具 + 四个文件，**只搬家不改断言**——
// 用例标题与断言逐字保留，共用夹具收进 tests/settings-ui-fixtures.js（T9 纪律，见 tests/README.md）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { build, flush, settingsUi } = require('./settings-ui-fixtures');
const preambles = require('./ui-test-preambles');
// T8（三审·低）：跨层共用的夹紧口径用例表（配置层 / 编辑器标记层 / 设置面板回填同一份契约）
const { LONG_PARAGRAPH_THRESHOLD_CASES } = require('./clamp-contracts');

// 夹具 build() 会把 document 挂到全局；本文件收尾统一还原（TEST-D-02）。
preambles.restoreGlobalsAfter(test, ['document']);

test('saveSettings（U-D4 全局入口）：写作页里保存的是全局默认值，只走 setConfig', async () => {
  const ctx = build({
    view: 'editor', bookId: 'id-1',
    config: { booksRoot: '/书库', editorFontSize: 22, dailyGoal: 3000 },
    bookDisplay: { editorFontSize: 22, dailyGoal: 3000 },
    displayForm: {
      editorFont: 'serif', editorFontSize: 18, editorLineHeight: 1.95, editorLetterSpacing: 0.02,
      editorPaddingX: 56, editorPageWidth: 0, editorPaper: 'paper', caretParagraph: false, caretParagraphColor: ''
    }
  });
  ctx.state.globalConfig = { booksRoot: '/书库', editorFontSize: 18, dailyGoal: 1200 };
  await ctx.ui.openSettings({ scope: 'global' });
  await ctx.ui.saveSettings();
  assert.equal(ctx.calls.setConfig.length, 1);
  assert.equal(ctx.calls.setBookDisplay.length, 0, '全局入口不写按书覆盖');
  assert.equal(ctx.calls.setConfig[0].editorFontSize, 18, '写全局默认值，不是本书的 22');
  assert.equal(ctx.calls.setConfig[0].dailyGoal, 1200);
  assert.deepEqual(ctx.calls.toast, [['设置已保存（全局默认）', undefined]]);
});

test('RSHE-A-03：全局保存已落盘后收尾刷新失败，不许误报「保存设置失败」', async () => {
  const ctx = build();
  // 收尾链（refreshShelf 的同步渲染）抛错：配置确实已经写进磁盘、弹层也已经关了
  ctx.host.peers.refreshShelf = async () => {
    throw new Error('重绘炸了');
  };
  const ui = settingsUi.create(ctx.host);
  await ui.openSettings({ scope: 'global' });
  await ui.saveSettings();
  const texts = ctx.calls.toast.map(([message]) => String(message));
  assert.equal(ctx.calls.setConfig.length, 1);
  assert.equal(
    texts.some((message) => message.startsWith('保存设置失败')),
    false,
    'setConfig 回执已落地，任何收尾异常都不许说「保存设置失败」'
  );
  assert.equal(texts.filter((message) => message === '设置已保存（全局默认）').length, 1);
  assert.equal(
    texts.filter((message) => message.includes('设置已保存，但刷新书架 / 词表状态失败：重绘炸了')).length,
    1,
    '收尾失败要如实说「已保存，但刷新失败」'
  );
});

test('saveSettings：防重入——连点保存只跑一条保存链、只弹一条 toast（V203 / WP-13）', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ctx = build({ setConfigGate: gate });
  await ctx.ui.openSettings({ scope: 'global' });
  const first = ctx.ui.saveSettings();
  const second = ctx.ui.saveSettings(); // 同一拍再点一次：savingSettings 已置位，直接忽略
  await flush();
  assert.equal(ctx.calls.setConfig.length, 1, '在途时只许一次 setConfig');
  release();
  await Promise.all([first, second]);
  assert.equal(ctx.calls.setConfig.length, 1);
  assert.equal(ctx.calls.toast.filter(([m]) => String(m).startsWith('设置已保存')).length, 1, '不许双 toast');
  assert.equal(ctx.calls.refreshShelf, 1, 'refreshShelf 只走一条');
  assert.equal(ctx.calls.refreshSensitiveWordList, 1);
  assert.equal(ctx.calls.refreshProofreadWordList, 1);
});

test('saveSettings：失败 / 成功后 savingSettings 都复位，还能再次保存（V203）', async () => {
  const fail = build({ saveError: '磁盘只读' });
  await fail.ui.openSettings({ scope: 'global' });
  await fail.ui.saveSettings();
  await fail.ui.saveSettings();
  assert.equal(fail.calls.setConfig.length, 2, '失败后必须复位，否则保存按钮永久无效');

  const ok = build();
  await ok.ui.openSettings({ scope: 'global' });
  await ok.ui.saveSettings();
  await ok.ui.saveSettings(); // 成功后弹层已关，仍能再存一次（说明 busy 已复位）
  assert.equal(ok.calls.setConfig.length, 2, '成功后必须复位');
});

// ---------- 五-M14（SS-11）：跨窗口全局设置同步 / 设置表单重定基 ----------
// 多窗口 A、B 同开。A 改了全局设置（dailyGoal / 字号 / 快照 / 换书架根…）并保存 → 主进程写盘。
// 旧实现只在「换根」时广播 config:changed，且渲染层收到换根只刷新 state.globalConfig，
// **不回填开着的设置表单、不更新取消用的 settingsBackup** → B 之后点一次保存，config:set 里
// 那份「整份全局表单」就把 A 刚改的项按旧值静默盖回去（换根子情形 = 书架根被换回旧根，
// 再广播一次，A 窗口反而收到孤岛提示）。这里用假 host 钉住修复后的两半：
//   ① 弹层开着（全局作用域）收到别窗变更 → 按 main 的最新配置重填表单 + 重定基 settingsBackup；
//   ② 重填后保存写回的是最新值，不再按旧值盖掉别窗改动。
test('M14（SS-11）：弹层开着收到别窗配置变更 → 表单按最新配置重定基，保存不再把别窗改动按旧值写回', async () => {
  // 本窗口打开设置时读到的全局配置（旧快照）
  const stale = { booksRoot: '/书库', editorFont: 'serif', editorFontSize: 18, dailyGoal: 1000 };
  // 另一个窗口刚写盘的最新配置（主进程 config:get 的回包）
  const fresh = { ...stale, dailyGoal: 2000 };
  const ctx = build({ view: 'shelf', bookId: null, config: stale, getConfigResult: fresh });
  await ctx.ui.openSettings();
  assert.equal(ctx.dom.map.get('settings-daily-goal').value, '1000', '打开时按当时的全局配置回填');
  assert.deepEqual(ctx.state.settingsBackup, stale, '取消备份也是打开时那份旧配置');

  // 渲染层收到 config:changed（reason:'config'）→ 先刷新 globalConfig，再让本模块重定基
  assert.equal(await ctx.ui.handleExternalConfigChange(), true);
  assert.equal(ctx.calls.getConfig, 1, '重定基按 main 的最新配置来（不信任本窗口的旧 state.globalConfig）');
  assert.equal(ctx.dom.map.get('settings-daily-goal').value, '2000', '表单按最新配置重填（否则保存会把旧值整份写回）');
  assert.deepEqual(ctx.state.globalConfig, fresh, '本窗口的全局配置快照已刷新');
  assert.deepEqual(ctx.state.settingsBackup, ctx.state.config, '取消备份同步重定基（取消也不再还原成过期配置）');
  assert.ok(
    ctx.calls.toast.some(([message, kind]) => kind === 'warn' && /另一个窗口/.test(message)),
    '要明示表单为什么被重填（否则作者在面板里刚填的值会凭空消失）'
  );

  // 作者随后点保存：整份表单里的 dailyGoal 必须是刷新后的 2000，不能是打开时读到的 1000
  await ctx.ui.saveSettings();
  assert.equal(ctx.calls.setConfig.length, 1);
  assert.equal(ctx.calls.setConfig[0].dailyGoal, 2000, '不许把别窗刚改的 dailyGoal 按旧值盖回去');
  assert.equal(ctx.calls.setConfig[0].booksRoot, '/书库', '书架根仍是最新配置里的值（没有换根就不该动根）');
});

test('M14（SS-11）：面板没开 / 保存自身在途 / 按书作用域 → 不重填表单、不打扰作者', async () => {
  // ① 面板没开：连配置都不取（没有会写回旧值的表单）
  const closed = build({
    view: 'shelf', bookId: null,
    config: { booksRoot: '/书库', dailyGoal: 1000 },
    getConfigResult: { booksRoot: '/书库', dailyGoal: 2000 }
  });
  assert.equal(await closed.ui.handleExternalConfigChange(), false);
  assert.equal(closed.calls.getConfig, 0, '面板没开不取配置');
  assert.deepEqual(closed.calls.toast, []);
  assert.equal(closed.dom.map.get('settings-daily-goal').value, '');

  // ② 保存自身在途：这是本窗口那次 setConfig 的回声，重填只会把作者刚提交/刚填的值抹掉
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const saving = build({
    view: 'shelf', bookId: null,
    config: { booksRoot: '/书库', dailyGoal: 1000 },
    getConfigResult: { booksRoot: '/书库', dailyGoal: 2000 },
    setConfigGate: gate
  });
  await saving.ui.openSettings();
  const inflight = saving.ui.saveSettings();
  await flush();
  assert.equal(saving.calls.setConfig.length, 1, '保存已进入 setConfig 在途');
  assert.equal(await saving.ui.handleExternalConfigChange(), false, '自己的保存回包在途：不当外部变更处理');
  assert.equal(saving.calls.getConfig, 0);
  release();
  await inflight;

  // ③ 按书作用域：保存走 book:set-display（只写这本书的覆盖），碰不到全局配置，无需重定基
  const book = build({
    view: 'editor', bookId: 'id-1', scope: 'book',
    config: { booksRoot: '/书库', editorFontSize: 18 },
    getConfigResult: { booksRoot: '/书库', editorFontSize: 20 }
  });
  await book.ui.openSettings();
  assert.equal(book.state.settingsScope, 'book');
  assert.equal(await book.ui.handleExternalConfigChange(), false);
  assert.equal(book.calls.getConfig, 0);
  assert.equal(book.dom.map.get('settings-size').value, '18', '按书面板不因全局默认变化而重填');
  assert.deepEqual(book.calls.toast, []);

  // ④ 取配置失败 / 回包形状不对：不炸、不动表单、不假装重定基成功
  const broken = build({ view: 'shelf', bookId: null, config: { booksRoot: '/书库', dailyGoal: 1000 }, getConfigError: 'config:get 失败' });
  await broken.ui.openSettings();
  assert.equal(await broken.ui.handleExternalConfigChange(), false);
  assert.equal(broken.dom.map.get('settings-daily-goal').value, '1000');
});

// RSHE-A-01（第五轮审计）：别的窗口背靠背保存会连发 config:changed，旧实现只查状态 ——
// 两个广播可同时通过守卫，各自 getConfig / 重填表单 / 弹提示 / 读两份词表。现在在途合并。
test('RSHE-A-01：连发 config:changed 时不并发重定基，合并成一次补跑且只提示一次', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fresh = { booksRoot: '/书库', dailyGoal: 2000 };
  const ctx = build({
    view: 'shelf', bookId: null,
    config: { booksRoot: '/书库', dailyGoal: 1000 },
    getConfigResult: fresh,
    getConfigGate: gate
  });
  await ctx.ui.openSettings();
  const first = ctx.ui.handleExternalConfigChange();
  await flush();
  assert.equal(ctx.calls.getConfig, 1, '第一发进入在途');
  assert.equal(await ctx.ui.handleExternalConfigChange(), false, '在途期间的广播只登记，不并发第二发');
  assert.equal(ctx.calls.getConfig, 1);
  release();
  assert.equal(await first, true);
  await flush();
  assert.equal(ctx.calls.getConfig, 2, '在途期间到达的广播在回包后补一次（用最新配置）');
  assert.equal(
    ctx.calls.toast.filter(([message, kind]) => kind === 'warn' && /另一个窗口/.test(message)).length,
    1,
    '合并后不许重复弹「另一个窗口改过设置」'
  );
  assert.equal(ctx.dom.map.get('settings-daily-goal').value, '2000', '表单最终按最新配置重填');
});

test('closeSettings：默认回到打开前的配置并重绘显示层；restore=false 只关弹层；两种情况都清备份', () => {
  const ctx = build();
  const backup = { booksRoot: '/旧书库' };
  ctx.state.settingsBackup = backup;
  ctx.dom.map.get('settings-backdrop').classList.remove('hidden');
  ctx.ui.closeSettings();
  assert.equal(ctx.dom.map.get('settings-backdrop').classList.contains('hidden'), true);
  assert.equal(ctx.state.config, backup);
  assert.deepEqual(ctx.calls.applyEditorStyle, [undefined]);
  assert.equal(ctx.calls.syncCaretParagraphFromConfig, 1);
  assert.equal(ctx.calls.renderWriteTimer, 1);
  assert.equal(ctx.calls.renderDurationSettings, 1);
  assert.equal(ctx.state.settingsBackup, null);

  const noRestore = build();
  noRestore.state.settingsBackup = { booksRoot: '/旧书库' };
  noRestore.ui.closeSettings({ restore: false });
  assert.deepEqual(noRestore.calls.applyEditorStyle, []);
  assert.equal(noRestore.state.settingsBackup, null);
});

test('右上 × 关闭（拍板 #3）：与「取消」完全同义；即使监听把 MouseEvent 当参数传进来也照样还原预览', () => {
  const ctx = build();
  ctx.ui.setupSettingsUi();
  // × 只注册一次点击，且和「取消」是同一套行为（不是另一个函数）
  assert.deepEqual(ctx.dom.map.get('btn-settings-close')._listeners.map((l) => l.type), ['click']);
  assert.deepEqual(ctx.dom.map.get('btn-settings-cancel')._listeners.map((l) => l.type), ['click']);

  const backup = { booksRoot: '/旧书库' };
  ctx.state.settingsBackup = backup;
  ctx.state.config = { booksRoot: '/新书库', editorFont: 'custom' };
  ctx.dom.map.get('settings-backdrop').classList.remove('hidden');
  // 真实浏览器里监听收到的是 MouseEvent：解构 {restore=true} 不能让 restore 变成 undefined 之外的东西
  ctx.dom.map.get('btn-settings-close')._fire('click', { type: 'click', target: null });
  assert.equal(ctx.dom.map.get('settings-backdrop').classList.contains('hidden'), true, '点 × 收起弹层');
  assert.equal(ctx.state.config, backup, '× 也要还原打开前的预览配置');
  assert.deepEqual(ctx.calls.applyEditorStyle, [undefined]);
  assert.equal(ctx.calls.syncCaretParagraphFromConfig, 1);
  assert.equal(ctx.calls.renderWriteTimer, 1);
  assert.equal(ctx.calls.renderDurationSettings, 1);
  assert.equal(ctx.state.settingsBackup, null, '备份用完即清');

  // 已经关掉再点一次不炸（幂等）
  ctx.dom.map.get('btn-settings-close')._fire('click', { type: 'click' });
  assert.equal(ctx.dom.map.get('settings-backdrop').classList.contains('hidden'), true);
  assert.equal(ctx.state.settingsBackup, null);
});

test('resetBookDisplay：不是按书作用域直接 false；成功写回全局默认并重填表单；失败 toast', async () => {
  const notBook = build({ scope: 'global' });
  assert.equal(await notBook.ui.resetBookDisplay(), false);

  const ctx = build({ scope: 'book', bookId: 'id-1', config: { editorFont: 'custom', editorCustomFontPath: '/字体/a.ttf' } });
  assert.equal(await ctx.ui.resetBookDisplay(), true);
  assert.deepEqual(ctx.calls.resetBookDisplay, ['id-1']);
  assert.deepEqual(ctx.state.bookDisplay, {});
  assert.equal(ctx.calls.loadCustomFont.length, 1, '自定义字体要重新加载');
  assert.deepEqual(ctx.calls.applySidebarWidth, [250]);
  assert.deepEqual(ctx.state.settingsBackup, ctx.state.config);
  assert.deepEqual(ctx.calls.toast, [['已恢复为全局默认（这本书不再有单独设置）', undefined]]);

  const fail = build({ scope: 'book', bookId: 'id-1', resetError: '读不到' });
  assert.equal(await fail.ui.resetBookDisplay(), false);
  assert.deepEqual(fail.calls.toast, [['恢复默认失败：读不到', 'error']]);
});

test('saveSettings（按书）：写 bookDisplay、重绘显示层、关弹层并提示「只影响本书」', async () => {
  const ctx = build({ scope: 'book', bookId: 'id-1' });
  ctx.state.settingsScope = 'book';
  await ctx.ui.saveSettings();
  assert.equal(ctx.calls.setBookDisplay.length, 1);
  assert.equal(ctx.calls.setBookDisplay[0][0], 'id-1');
  assert.equal(ctx.calls.syncCaretParagraphFromConfig, 1);
  assert.deepEqual(ctx.calls.applySidebarWidth, [250]);
  assert.equal(ctx.calls.toast.length, 1);
  assert.deepEqual(ctx.calls.toast[0], ['已保存：这本书的显示设置（只影响本书）', undefined]);
  assert.equal(ctx.dom.map.get('settings-backdrop').classList.contains('hidden'), true);
  assert.deepEqual(ctx.calls.setConfig, []);
});

// ---------- 五-M15（SS-04）：按书设置保存非原子 ----------
// 按书保存跨两个文件：章号写「书目.json」、显示设置写 config.json 的 bookDisplay。旧实现把两步
// 包在同一个 catch 里：章号先写成功后显示设置写失败，只报「保存设置失败」→ 作者以为什么都没写，
// 点「取消」只还原显示预览，书目里的章号却已经变了（与「点取消一个字节不写」的入口口径矛盾）。
test('M15（SS-04）：章号已写、显示设置失败 → 如实说「章号已保存」，取消时再提示不能撤回', async () => {
  const options = {
    scope: 'book', bookId: 'id-1',
    config: { booksRoot: '/书库', editorFontSize: 18 },
    saveError: '磁盘只读'
  };
  const ctx = build(options);
  await ctx.ui.openSettings();
  assert.equal(ctx.state.settingsScope, 'book');
  ctx.dom.map.get('settings-chapter-numbering').value = 'volume';

  await ctx.ui.saveSettings();
  // 先写章号、后写显示：章号那一半已经落盘
  assert.deepEqual(ctx.calls.setChapterNumbering, [['/书库/书甲', 'volume']], '章号确实先写成功');
  assert.equal(ctx.calls.setBookDisplay.length, 1, '显示设置也发起了（随后失败）');
  assert.deepEqual(ctx.calls.applyChapterNumbering, [{ title: '书甲', chapterNumbering: 'volume' }], '章号显示层已按回执更新（与磁盘一致）');
  assert.equal(ctx.calls.toast.length, 1);
  const [message, kind] = ctx.calls.toast[0];
  assert.equal(kind, 'error');
  assert.match(message, /章号已保存/, '必须明说章号已经写进去了');
  assert.match(message, /显示设置没保存/, '同时明说显示设置没写');
  assert.notEqual(message, '保存设置失败：磁盘只读', '不许再用一句「保存设置失败」掩盖部分写入');
  assert.equal(ctx.dom.map.get('settings-backdrop').classList.contains('hidden'), false, '失败不关弹层（还能重试）');

  // 重试成功：章号已与磁盘一致（不再重复写），显示设置补上后正常收尾
  options.saveError = null;
  await ctx.ui.saveSettings();
  assert.equal(ctx.calls.setChapterNumbering.length, 1, '章号已经一致，不重复写');
  assert.deepEqual(ctx.calls.toast[ctx.calls.toast.length - 1], ['已保存：这本书的显示设置（只影响本书）', undefined]);
  assert.equal(ctx.dom.map.get('settings-backdrop').classList.contains('hidden'), true);

  // 取消：部分写入过一次之后再点「取消」，不许静默——要提示章号不会撤回
  const cancel = build({ scope: 'book', bookId: 'id-1', config: { booksRoot: '/书库' }, saveError: '磁盘只读' });
  await cancel.ui.openSettings();
  cancel.dom.map.get('settings-chapter-numbering').value = 'volume';
  await cancel.ui.saveSettings();
  cancel.calls.toast.length = 0; // 只看取消时的提示
  const backup = { ...cancel.state.config };
  cancel.ui.closeSettings();
  assert.deepEqual(cancel.state.config, backup, '取消仍还原显示设置的预览');
  assert.equal(cancel.calls.toast.length, 1);
  assert.equal(cancel.calls.toast[0][1], 'warn');
  assert.match(cancel.calls.toast[0][0], /章号已经保存/);
  assert.match(cancel.calls.toast[0][0], /取消/, '要点明取消撤回不了章号');
});

test('M15（SS-04）：什么都没写进去时保持原提示；显示设置已保存后的失败也要说清', async () => {
  // ① 章号没有改动 + 显示设置失败：什么都没落盘，原提示保持不变
  const plain = build({ scope: 'book', bookId: 'id-1', saveError: '写盘失败' });
  await plain.ui.openSettings();
  await plain.ui.saveSettings();
  assert.deepEqual(plain.calls.setChapterNumbering, [], '章号没变不写');
  assert.deepEqual(plain.calls.toast, [['保存设置失败：写盘失败', 'error']]);
  plain.ui.closeSettings();
  assert.equal(plain.calls.toast.length, 1, '没有部分写入，取消不加提示');

  // ② 显示设置写成功后重绘抛错：显示设置已经在磁盘上，不能再说「保存设置失败」了事
  const late = build({ scope: 'book', bookId: 'id-1', applyEditorStyleThrows: true });
  await late.ui.openSettings();
  await late.ui.saveSettings();
  assert.equal(late.calls.setBookDisplay.length, 1);
  assert.match(late.calls.toast[0][0], /显示设置已经保存/);
  assert.match(late.calls.toast[0][0], /重绘失败/);

  // ③ 章号写入本身失败：两步都没落盘，原提示
  const numberFail = build({ scope: 'book', bookId: 'id-1', numberingError: '书已被删除' });
  await numberFail.ui.openSettings();
  numberFail.dom.map.get('settings-chapter-numbering').value = 'volume';
  await numberFail.ui.saveSettings();
  assert.deepEqual(numberFail.calls.setChapterNumbering, [['/书库/书甲', 'volume']]);
  assert.deepEqual(numberFail.calls.setBookDisplay, [], '章号失败后不再写显示设置');
  assert.deepEqual(numberFail.calls.toast, [['保存设置失败：书已被删除', 'error']]);
});

test('saveSettings（全局）：关闭写作时长前 flush、setConfig payload 逐字段、刷新书架与两个词表', async () => {
  const ctx = build({ writeDurationEnabled: true });
  ctx.state.settingsScope = 'global';
  ctx.dom.map.get('settings-root').value = '  /新书库  ';
  ctx.dom.map.get('settings-snapshot-enabled').checked = true;
  ctx.dom.map.get('settings-snapshot-days').value = '14';
  ctx.dom.map.get('settings-daily-goal').value = 'abc';
  ctx.dom.map.get('settings-write-duration').checked = false;
  ctx.dom.map.get('settings-clipboard-watch').checked = true;
  ctx.dom.map.get('settings-chapter-template').value = '第{chapterNumber}章';
  ctx.dom.map.get('settings-export-conversion').value = 's2t';
  ctx.state.sensitiveWordsDraft = ' /词表/敏感.txt ';
  ctx.state.proofreadWordsDraft = '/词表/校对.txt';
  await ctx.ui.saveSettings();
  assert.equal(ctx.calls.flushWriteTimer, 1, '关掉写作时长前先 flush');
  assert.equal(ctx.calls.setConfig.length, 1);
  const patch = ctx.calls.setConfig[0];
  assert.equal(patch.booksRoot, '/新书库');
  assert.equal(patch.snapshotEnabled, true);
  assert.equal(patch.snapshotKeepDays, 14);
  assert.equal(patch.dailyGoal, 0, '坏值按 0');
  assert.equal(patch.writeDurationEnabled, false);
  assert.equal(patch.clipboardWatchEnabled, true, 'b8：剪贴板后台监听开关随设置保存');
  assert.equal(patch.chapterTemplate, '第{chapterNumber}章');
  assert.equal(patch.exportConversion, 's2t');
  assert.equal(patch.sensitiveWordsPath, '/词表/敏感.txt');
  assert.equal(patch.proofreadWordsPath, '/词表/校对.txt');
  assert.equal(ctx.calls.applyWriteTimerConfig, 1);
  assert.deepEqual(ctx.calls.toast, [['设置已保存（全局默认）', undefined]]);
  assert.equal(ctx.calls.refreshShelf, 1);
  assert.equal(ctx.calls.refreshSensitiveWordList, 1);
  assert.equal(ctx.calls.refreshProofreadWordList, 1);

  const fail = build({ saveError: '写盘失败' });
  fail.state.settingsScope = 'global';
  await fail.ui.saveSettings();
  assert.deepEqual(fail.calls.toast, [['保存设置失败：写盘失败', 'error']]);
});

test('超长段落阈值（1.1.0）：回填按同一夹紧口径，保存 payload 两种作用域都带阈值，取消不写盘', async () => {
  // 回填：按 editor-logic 同一口径。T8（三审·低）：用例表与配置层 / 编辑器标记层共用
  // tests/clamp-contracts.js 的一份（越界夹到端点、坏值回落 500）。
  for (const { raw, expected, note } of LONG_PARAGRAPH_THRESHOLD_CASES) {
    const ctx = build({
      view: 'shelf',
      bookId: null,
      config: { booksRoot: '/书库', longParagraphThreshold: raw }
    });
    await ctx.ui.openSettings();
    assert.equal(ctx.dom.map.get('settings-long-para-threshold').value, String(expected), `${note}（${String(raw)}）`);
  }

  // 表单里的阈值原样进按书保存路径（真正读输入框的 readDisplayForm 在 renderer.js，E2E 覆盖）
  const displayForm = {
    editorFont: 'serif', editorFontSize: 18, editorLineHeight: 1.95, editorLetterSpacing: 0.02,
    editorPaddingX: 56, editorPageWidth: 0, editorPaper: 'paper',
    caretParagraph: false, caretParagraphColor: '', editorTextAutospace: false, longParagraphThreshold: 650
  };
  const book = build({ scope: 'book', bookId: 'id-1', displayForm });
  book.state.settingsScope = 'book';
  await book.ui.saveSettings();
  assert.equal(book.calls.setBookDisplay.length, 1);
  assert.equal(book.calls.setBookDisplay[0][1].longParagraphThreshold, 650);
  assert.equal(book.calls.setBookDisplay[0][1].editorTextAutospace, false, '按书保存带上中西文间距开关');
  assert.deepEqual(book.calls.setConfig, [], '按书保存不碰全局默认');

  // 取消：打开设置、改输入框、直接关 → 一个写调用都没有（草稿只活在表单里）
  const cancel = build({ view: 'shelf', bookId: null, displayForm });
  await cancel.ui.openSettings();
  cancel.dom.map.get('settings-long-para-threshold').value = '700';
  cancel.ui.closeSettings();
  assert.deepEqual(cancel.calls.setConfig, []);
  assert.deepEqual(cancel.calls.setBookDisplay, []);
  assert.equal(cancel.dom.map.get('settings-backdrop').classList.contains('hidden'), true);

  // 全局保存：同一份表单进 setConfig（书架设置里改的是全局默认）
  const globalCtx = build({ view: 'shelf', bookId: null, displayForm });
  globalCtx.state.settingsScope = 'global';
  await globalCtx.ui.saveSettings();
  assert.equal(globalCtx.calls.setConfig.length, 1);
  assert.equal(globalCtx.calls.setConfig[0].longParagraphThreshold, 650);
  assert.equal(globalCtx.calls.setConfig[0].editorTextAutospace, false, '全局保存同样带中西文间距开关');
});

test('multi=true 保存设置不回写 proofreadWordsPath（V52）', async () => {
  const ctx = build({
    view: 'shelf', bookId: null,
    config: { booksRoot: '/书库', proofreadWordsPath: '/旧/单份.txt', proofreadWordlists: ['/词表/甲.txt', '/词表/乙.txt'] },
    proofreadInfo: {
      ok: true, multi: true, total: 27, count: 27,
      lists: [{ ok: true, count: 12 }, { ok: true, count: 15 }]
    }
  });
  await ctx.ui.openSettings();
  // 草稿里有值（旧路径框被藏起来之前填的）也不能写回：多份时 proofreadWordsPath 是历史插槽
  ctx.state.proofreadWordsDraft = '/词表/不该写回的旧单份.txt';
  await ctx.ui.saveSettings();
  assert.equal(ctx.calls.setConfig.length, 1);
  const patch = ctx.calls.setConfig[0];
  assert.equal(
    Object.prototype.hasOwnProperty.call(patch, 'proofreadWordsPath'),
    false,
    '多份时保存设置不能把旧单份字段清掉 / 覆盖掉'
  );
  assert.equal(patch.booksRoot, '/书库');
  assert.equal(patch.sensitiveWordsPath, '');
  assert.deepEqual(ctx.calls.toast, [['设置已保存（全局默认）', undefined]]);
});

// SS-13（五-L18）：保存 / 恢复默认 / 取消之间没有互斥 —— 保存 IPC 在途时点「取消」，closeSettings
// 先把 state.config 还原成 settingsBackup，保存回执随后落地又按新值套用并 toast「已保存」：作者的
// 取消被无视。按书作用域里「恢复全局默认」与保存交叠时，后到的 reset 回执把刚保存的显示设置从界面
// 清空（磁盘上仍在）。现在任一写操作在途时禁用保存 / 重置 / 取消，且回执收尾前复核弹层与作用域。
test('SS-13（五-L18）：设置写操作在途时取消/重置/重复保存被挡住；reset 回执收尾复核弹层', async () => {
  // ① 保存在途：三个动作按钮都 disabled，点取消不关弹层、再点保存不再发 IPC
  const ctx = build({ scope: 'book', bookId: 'id-1' });
  await ctx.ui.openSettings({ scope: 'book' });
  const gate = { release: null };
  ctx.host.api.setBookDisplay = () => new Promise((resolve) => { gate.release = resolve; });
  const saveBtn = ctx.dom.map.get('btn-settings-save');
  const cancelBtn = ctx.dom.map.get('btn-settings-cancel');
  const closeBtn = ctx.dom.map.get('btn-settings-close');
  const resetBtn = ctx.dom.map.get('btn-reset-book-display');
  const pendingSave = ctx.ui.saveSettings();
  await flush();
  assert.equal(saveBtn.disabled, true, '保存在途时保存按钮禁用');
  assert.equal(resetBtn.disabled, true, '保存在途时「恢复全局默认」禁用');
  assert.equal(cancelBtn.disabled, true, '保存在途时取消禁用');
  assert.equal(closeBtn.disabled, true, '保存在途时右上关闭禁用');
  cancelBtn._fire('click');
  closeBtn._fire('click');
  assert.equal(
    ctx.dom.map.get('settings-backdrop').classList.contains('hidden'),
    false,
    '保存在途时取消 / 关闭都不许关掉弹层（否则保存回执会违背取消）'
  );
  assert.deepEqual(ctx.calls.resetBookDisplay, [], '保存在途时重置不发起');
  gate.release({ editorFontSize: 20 });
  assert.equal(await pendingSave, undefined);
  assert.equal(ctx.dom.map.get('settings-backdrop').classList.contains('hidden'), true, '保存成功后照常关弹层');
  assert.equal(saveBtn.disabled, false, '收尾后按钮恢复可点');
  assert.equal(cancelBtn.disabled, false);

  // ② reset 在途时弹层被别的路径关掉：回执落地不许再改眼前状态
  const ctx2 = build({ scope: 'book', bookId: 'id-1' });
  await ctx2.ui.openSettings({ scope: 'book' });
  ctx2.state.bookDisplay = { editorFontSize: 20 };
  let releaseReset;
  ctx2.host.api.resetBookDisplay = () => new Promise((resolve) => { releaseReset = resolve; });
  const pendingReset = ctx2.ui.resetBookDisplay();
  await flush();
  assert.equal(ctx2.dom.map.get('btn-settings-save').disabled, true, '重置在途时保存同样禁用');
  ctx2.ui.closeSettings();
  releaseReset(true);
  assert.equal(await pendingReset, false, '弹层已关：reset 回执按作废处理');
  assert.deepEqual(ctx2.state.bookDisplay, { editorFontSize: 20 }, '作废的回执不许清掉显示覆盖');
  assert.equal(
    ctx2.calls.toast.some((item) => String(item[0]).includes('已恢复为全局默认')),
    false,
    '作废的回执也不许 toast 成功'
  );
  assert.equal(ctx2.dom.map.get('btn-settings-save').disabled, false, '收尾后按钮恢复可点');
});
