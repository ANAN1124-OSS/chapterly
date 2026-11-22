// 设置面板测试（T9 / 第 10 轮按性质拆分）：契约 / 打开回填 / 台账 / 更新。
// 本文件覆盖：host 9 成员契约与分组依赖 → create() 只建表交 15 个入口 → openSettings（全局 / 按书 /
// 视图定作用域 / U-D4 全局入口 / 旧配置缺键）→ 表单回填顺序（M16）→ 词表三态与台账读取（含并发与失败）→
// checkUpdate（忙碌 / 新版本 / 下载页 / 失败）→ previewSettings → openStatsCalendar → multi=true 状态行。
//
// 来源：原 tests/settings-ui.test.js（1,630 行 / 51 例）按性质拆成夹具 + 四个文件，**只搬家不改断言**——
// 用例标题与断言逐字保留，共用夹具收进 tests/settings-ui-fixtures.js（T9 纪律，见 tests/README.md）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { build, makeDocument, moduleCode, flush, settingsUi } = require('./settings-ui-fixtures');
const preambles = require('./ui-test-preambles');

// 夹具 build() 会把 document 挂到全局；本文件收尾统一还原（TEST-D-02）。
preambles.restoreGlobalsAfter(test, ['document']);

// ---------- host 契约 ----------
test('host 契约：9 个成员 + 分组内每个真实依赖；缺任何一个都抛 TypeError', () => {
  assert.deepEqual([...settingsUi.REQUIRED_HOST].sort(), ['$', 'api', 'call', 'chaptersLib', 'display', 'peers', 'state', 'texts', 'toast']);
  assert.equal(settingsUi.REQUIRED_HOST.length, 9);
  const ctx = build();
  assert.doesNotThrow(() => settingsUi.create(ctx.host));
  assert.throws(() => settingsUi.create(null), /createSettingsUi 需要 host 对象/);
  for (const key of settingsUi.REQUIRED_HOST) {
    const broken = { ...ctx.host };
    delete broken[key];
    assert.throws(() => settingsUi.create(broken), new RegExp('host 缺少 ' + key.replace('$', '\\$')), '缺 ' + key);
  }
  for (const key of ['applyEditorStyle', 'syncCaretParagraphFromConfig', 'effectiveConfig', 'applySidebarWidth', 'loadCustomFont', 'readDisplayForm', 'displaySettingsIds', 'caretColorLib', 's2tLib', 'templateLib', 'editorLogic', 'applyChapterNumbering']) {
    const broken = { ...ctx.host, display: { ...ctx.host.display } };
    delete broken.display[key];
    assert.throws(() => settingsUi.create(broken), new RegExp('host\\.display 缺少 ' + key));
  }
  for (const key of ['refreshStats', 'renderStatsChart']) {
    const broken = { ...ctx.host, peers: { ...ctx.host.peers, stats: { ...ctx.host.peers.stats } } };
    delete broken.peers.stats[key];
    assert.throws(() => settingsUi.create(broken), new RegExp('host\\.peers\\.stats 缺少 ' + key));
  }
  for (const key of ['renderDurationSettings', 'renderWriteTimer', 'applyWriteTimerConfig', 'writeDurationEnabled', 'flushWriteTimer']) {
    const broken = { ...ctx.host, peers: { ...ctx.host.peers, writeTimer: { ...ctx.host.peers.writeTimer } } };
    delete broken.peers.writeTimer[key];
    assert.throws(() => settingsUi.create(broken), new RegExp('host\\.peers\\.writeTimer 缺少 ' + key));
  }
  for (const key of ['refreshSensitiveWordList', 'refreshProofreadWordList', 'sensitiveWordListText', 'proofreadWordListText', 'pickSensitiveWords', 'pickProofreadWords']) {
    const broken = { ...ctx.host, peers: { ...ctx.host.peers, words: { ...ctx.host.peers.words } } };
    delete broken.peers.words[key];
    assert.throws(() => settingsUi.create(broken), new RegExp('host\\.peers\\.words 缺少 ' + key));
  }
  assert.throws(() => settingsUi.create({ ...ctx.host, peers: { ...ctx.host.peers, refreshShelf: null } }), /host\.peers 缺少 refreshShelf/);
  for (const key of ['commonLib', 'formatBytes']) {
    const broken = { ...ctx.host, texts: { ...ctx.host.texts } };
    delete broken.texts[key];
    assert.throws(() => settingsUi.create(broken), new RegExp('host\\.texts 缺少 ' + key));
  }
});

test('create() 只建表：不碰 DOM / 不注册事件 / 不建定时器，交出 15 个入口', () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  assert.equal(dom.lookups, 0);
  assert.deepEqual(Object.keys(ctx.ui).sort(), [
    'checkUpdate', 'closeSettings', 'handleExternalConfigChange', 'openSettings', 'openStatsCalendar',
    'openUpdateDownload', 'previewSettings', 'renderChapterTemplatePreview', 'renderProofreadSettings',
    'renderSensitiveSettings', 'renderSettingsCaretColors', 'resetBookDisplay', 'saveSettings', 'setSelectValue',
    'setupSettingsUi'
  ]);
  assert.equal(moduleCode.includes('setInterval'), false);
});

test('openSettings（全局）：回填全部输入框、按全局作用域显隐、刷统计、读台账（词表三态 / 日志 / 更新）', async () => {
  const ctx = build({
    view: 'shelf', bookId: null,
    config: {
      booksRoot: '/书库', editorFont: 'custom', editorCustomFontPath: '', editorCustomFontName: '',
      editorFontSize: 20, editorLineHeight: 2, editorLetterSpacing: 0.05, editorPaddingX: 40, editorPageWidth: 800,
      editorPaper: 'night', caretParagraph: true, caretParagraphColor: '#c0392b',
      editorTextAutospace: true,
      longParagraphThreshold: 620,
      snapshotEnabled: true, snapshotKeepDays: 14, dailyGoal: 1200, writeDurationEnabled: true,
      clipboardWatchEnabled: true,
      chapterTemplate: '第{n}章：{title}', exportConversion: 's2t',
      sensitiveWordsPath: '/词表/敏感', proofreadWordsPath: '/词表/校对'
    },
    logResult: { files: [{ bytes: 2048 }, { bytes: 1024 }] }
  });
  await ctx.ui.openSettings();
  assert.equal(ctx.state.settingsScope, 'global');
  assert.equal(ctx.calls.refreshStats, 1);
  assert.equal(ctx.dom.map.get('settings-backdrop').classList.contains('hidden'), false);
  assert.equal(ctx.dom.map.get('settings-root').value, '/书库');
  assert.equal(ctx.dom.map.get('settings-font').value, 'serif', 'custom 但没草稿路径 → serif');
  assert.equal(ctx.dom.map.get('settings-size').value, '20');
  assert.equal(ctx.dom.map.get('settings-paper').value, 'night');
  assert.equal(ctx.dom.map.get('settings-caret-paragraph').checked, true);
  // 中西文自动间距（1.3.0 T-08）：回填生效值，默认开
  assert.equal(ctx.dom.map.get('settings-text-autospace').checked, true);
  assert.equal(ctx.state.settingsCaretColorDraft, '#c0392b');
  // 超长段落阈值（1.1.0）：回填全局默认，范围提示与作用域一起更新
  assert.equal(ctx.dom.map.get('settings-long-para-threshold').value, '620');
  assert.match(ctx.dom.map.get('settings-long-para-hint').textContent, /^全局默认/);
  assert.equal(ctx.dom.map.get('settings-snapshot-enabled').checked, true);
  assert.equal(ctx.dom.map.get('settings-daily-goal').value, '1200');
  assert.equal(ctx.dom.map.get('settings-chapter-template').value, '第{n}章：{title}');
  assert.equal(ctx.dom.map.get('settings-export-conversion').value, 's2t');
  assert.equal(ctx.calls.renderDurationSettings, 1);
  assert.equal(ctx.calls.renderStatsChart, 1);
  // 全局作用域里数据台账：敏感词 / 校对词表（异步读一次）、日志、更新版本
  assert.equal(ctx.calls.sensitiveWordsInfo, 1);
  assert.equal(ctx.calls.proofreadWordsInfo, 1);
  assert.equal(ctx.dom.map.get('settings-sensitive-status').textContent, '敏感词表 3 个');
  assert.equal(ctx.dom.map.get('settings-proofread-status').textContent, '校对词表 4 个');
  assert.equal(ctx.calls.logInfo, 1);
  assert.equal(ctx.dom.map.get('settings-logs-status').textContent, '已有 2 个日志文件，共 3.0 KB（不含正文）');
  assert.equal(ctx.dom.map.get('settings-update-version').textContent, 'v0.10.0');
  assert.equal(ctx.dom.map.get('settings-update-status').textContent, '尚未检查（只在点按钮时联网，不会自动检查）');
  // 全局作用域：全局分区可见、重置本书显示按钮隐藏
  assert.equal(ctx.dom.map.get('settings-root-field').classList.contains('hidden'), false);
  assert.equal(ctx.dom.map.get('btn-reset-book-display').classList.contains('hidden'), true);
  assert.match(ctx.dom.map.get('settings-scope-hint').textContent, /^这里是全局默认设置/);
});

test('openSettings（按书）：隐藏全局分区、显示重置按钮、换成按书提示，且不读台账', async () => {
  const ctx = build({
    view: 'editor', bookId: 'id-1',
    config: { booksRoot: '/书库', editorFont: 'serif', longParagraphThreshold: 640, editorTextAutospace: false },
    sensitiveWordsDraft: '/词表/敏感.txt',
    proofreadWordsDraft: '/词表/校对.txt'
  });
  await ctx.ui.openSettings();
  assert.equal(ctx.state.settingsScope, 'book');
  for (const id of ['settings-root-field', 'settings-snapshot-field', 'settings-snapshot-days-field', 'settings-stats-group',
    'settings-duration-field', 'settings-clipboard-field',
    'settings-sensitive-group', 'settings-proofread-group', 'settings-template-group', 'settings-export-group',
    'settings-logs-group', 'settings-update-group']) {
    assert.equal(ctx.dom.map.get(id).classList.contains('hidden'), true, id + ' 应隐藏');
  }
  assert.equal(ctx.calls.sensitiveWordsInfo, 0, '按书作用域不读词表');
  assert.equal(ctx.calls.proofreadWordsInfo, 0);
  assert.equal(ctx.calls.logInfo, 0, '按书作用域不读日志');
  assert.match(ctx.dom.map.get('settings-caret-hint').textContent, /^只影响这本书/);
  assert.equal(ctx.dom.map.get('settings-long-para-threshold').value, '640');
  assert.match(ctx.dom.map.get('settings-long-para-hint').textContent, /^只影响这本书/);
  // 中西文自动间距（1.3.0 T-08）：这本书单独关过 → 回填不勾；别的书不勾时回落全局默认开
  assert.equal(ctx.dom.map.get('settings-text-autospace').checked, false);
  assert.match(ctx.dom.map.get('settings-scope-hint').textContent, /^只影响「书甲」的显示设置/);
});

test('renderSensitiveSettings / renderProofreadSettings：未设置 / 读取中 / 有状态（ok / 不 ok）三态', () => {
  const ctx = build();
  ctx.state.sensitiveWordsDraft = '';
  ctx.state.sensitiveWordsInfo = null;
  ctx.ui.renderSensitiveSettings();
  assert.match(ctx.dom.map.get('settings-sensitive-status').textContent, /^未设置：预检前需要先选一个自己的词表 txt/);
  ctx.state.sensitiveWordsDraft = '/词表/敏感.txt';
  ctx.ui.renderSensitiveSettings();
  assert.equal(ctx.dom.map.get('settings-sensitive-status').textContent, '正在读取词表…');
  ctx.state.sensitiveWordsInfo = { ok: true, count: 3 };
  ctx.ui.renderSensitiveSettings();
  assert.equal(ctx.dom.map.get('settings-sensitive-status').textContent, '敏感词表 3 个');
  ctx.state.sensitiveWordsInfo = { ok: false };
  ctx.ui.renderSensitiveSettings();
  assert.equal(ctx.dom.map.get('settings-sensitive-status').className, 'muted small warn');

  ctx.state.proofreadWordsDraft = '';
  ctx.ui.renderProofreadSettings();
  assert.match(ctx.dom.map.get('settings-proofread-status').textContent, /^未设置：校对时只跑内置的九条规则/);
  ctx.state.proofreadWordsDraft = '/词表/校对.txt';
  ctx.ui.renderProofreadSettings();
  assert.equal(ctx.dom.map.get('settings-proofread-status').textContent, '正在读取词表…');
  ctx.state.proofreadWordsInfo = { ok: true, count: 4 };
  ctx.ui.renderProofreadSettings();
  assert.equal(ctx.dom.map.get('settings-proofread-status').textContent, '校对词表 4 个');
});

test('数据台账异步失败：词表读失败写进状态、日志读失败写 error（都只显示不抛）', async () => {
  const ctx = build({
    view: 'shelf', bookId: null,
    config: { booksRoot: '/书库', sensitiveWordsPath: '/词表/敏感', proofreadWordsPath: '/词表/校对' },
    wordInfoError: 'EACCES', logError: '目录没权限'
  });
  await ctx.ui.openSettings();
  assert.deepEqual(ctx.state.sensitiveWordsInfo, { ok: false, message: '读取词表失败：EACCES' });
  assert.deepEqual(ctx.state.proofreadWordsInfo, { ok: false, message: '读取校对词表失败：EACCES' });
  assert.equal(ctx.dom.map.get('settings-proofread-status').className, 'muted small warn');
  assert.equal(ctx.dom.map.get('settings-logs-status').textContent, '读取日志目录失败：目录没权限');
});

test('checkUpdate：忙碌短路、发现新版本 toast、失败结构化；下载页打开 / 只回报地址 / 无地址 / 抛错', async () => {
  const busy = build();
  busy.state.update = { busy: true, result: { status: 'old' } };
  assert.deepEqual(await busy.ui.checkUpdate(), { status: 'old' });
  assert.equal(busy.calls.checkUpdate, 0);

  const ok = build({ updateResult: { status: 'update', latestVersion: '0.11.0', currentVersion: '0.10.0' } });
  const result = await ok.ui.checkUpdate();
  assert.equal(result.status, 'update');
  assert.deepEqual(ok.calls.toast, [['发现新版本 v0.11.0（当前 v0.10.0）', undefined]]);
  assert.equal(ok.state.update.busy, false);
  // checkUpdate 之后设置弹层状态区也跟着刷（发现新版本 → 下载页按钮出现）
  assert.match(ok.dom.map.get('settings-update-status').textContent, /^发现新版本 v0.11.0/);
  assert.equal(ok.dom.map.get('btn-open-update').classList.contains('hidden'), false);

  const fail = build({ updateError: '网络断了' });
  const errResult = await fail.ui.checkUpdate();
  assert.equal(errResult.status, 'error');
  assert.match(errResult.message, /检查更新失败：网络断了/);
  assert.equal(fail.state.update.busy, false);
  assert.equal(fail.dom.map.get('settings-update-status').className, 'muted small warn');

  const opened = build({ downloadResult: { opened: true } });
  await opened.ui.openUpdateDownload();
  assert.deepEqual(opened.calls.toast, [['已用浏览器打开 GitHub 下载页（应用不会自动下载或安装）', undefined]]);

  const urlOnly = build({ downloadResult: { url: 'https://example.com' } });
  await urlOnly.ui.openUpdateDownload();
  assert.deepEqual(urlOnly.calls.toast, [['下载页：https://example.com', undefined]]);

  const none = build({ downloadResult: { message: '没有下载页' } });
  await none.ui.openUpdateDownload();
  assert.deepEqual(none.calls.toast, [['没有下载页', 'warn']]);

  const boom = build();
  boom.host.api.openUpdateDownload = async () => { throw new Error('主进程炸了'); };
  assert.equal(await boom.ui.openUpdateDownload(), null);
  assert.deepEqual(boom.calls.toast, [['打开下载页失败：主进程炸了', 'error']]);
});

// ---------- 作用域显隐 / 预览 ----------
test('previewSettings：没有备份直接返回；有备份就按表单预览显示项，写作页里顺便预览当前段落高亮', () => {
  const ctx = build({ view: 'editor', bookPath: '/书库/书甲', index: 0 });
  ctx.state.settingsBackup = { booksRoot: '/书库' };
  ctx.ui.previewSettings();
  assert.deepEqual(ctx.calls.applyEditorStyle, [{ booksRoot: '/书库', editorFont: 'serif', editorFontSize: 18, editorLineHeight: 1.95, editorLetterSpacing: 0.02, editorPaddingX: 56, editorPageWidth: 0, editorPaper: 'paper', caretParagraph: false, caretParagraphColor: '' }]);
  assert.equal(ctx.calls.renderMarksMenu, 1);
  assert.equal(ctx.calls.renderEditorMarks, 1);
  assert.equal(ctx.state.marks.caretLine, 0);

  const noBackup = build();
  noBackup.ui.previewSettings();
  assert.deepEqual(noBackup.calls.applyEditorStyle, []);
});

// ---------- 打开 / 关闭 / 保存 ----------
test('openSettings：按视图定作用域、备份配置、刷统计、回填、显隐，全局作用域再读词表 / 日志 / 更新', async () => {
  const ctx = build({ view: 'shelf', bookId: null, config: { booksRoot: '/书库' } });
  await ctx.ui.openSettings();
  assert.equal(ctx.state.settingsScope, 'global');
  assert.deepEqual(ctx.state.settingsBackup, { booksRoot: '/书库' });
  assert.equal(ctx.calls.refreshStats, 1);
  assert.equal(ctx.dom.map.get('settings-backdrop').classList.contains('hidden'), false);
  assert.equal(ctx.calls.sensitiveWordsInfo, 0, '没设置词表路径不读');
  assert.equal(ctx.calls.proofreadWordsInfo, 0);
  assert.equal(ctx.calls.logInfo, 1, '全局作用域读一次日志目录');
  // 版本区至少渲染一次
  assert.equal(ctx.dom.map.get('settings-update-version').textContent, 'v0.10.0');

  const book = build({ view: 'editor', bookId: 'id-1', config: {} });
  await book.ui.openSettings();
  assert.equal(book.state.settingsScope, 'book', '写作页且有书 → 按书作用域');
});

test('openSettings（U-D4 全局入口）：写作页里打开全局设置按全局默认回填，不把本书覆盖值当全局', async () => {
  const ctx = build({
    view: 'editor', bookId: 'id-1',
    // 生效值 = 全局 + 本书覆盖：字号 22 / 夜间 / 高亮开（都来自 bookDisplay）
    config: { booksRoot: '/书库', editorFontSize: 22, editorPaper: 'night', dailyGoal: 3000, caretParagraph: true, caretParagraphColor: '#3f7fbf' },
    bookDisplay: { editorFontSize: 22, editorPaper: 'night', dailyGoal: 3000, caretParagraph: true, caretParagraphColor: '#3f7fbf' }
  });
  // 全局默认是另一份：字号 18 / 纸色 paper / 高亮关 / 目标 1200
  ctx.state.globalConfig = { booksRoot: '/书库', editorFontSize: 18, editorPaper: 'paper', dailyGoal: 1200, caretParagraph: false, caretParagraphColor: '' };
  await ctx.ui.openSettings({ scope: 'global' });
  assert.equal(ctx.state.settingsScope, 'global');
  assert.equal(ctx.dom.map.get('settings-size').value, '18', '回填全局默认，不是本书覆盖的 22');
  assert.equal(ctx.dom.map.get('settings-paper').value, 'paper');
  assert.equal(ctx.dom.map.get('settings-caret-paragraph').checked, false);
  assert.equal(ctx.state.settingsCaretColorDraft, '');
  assert.equal(ctx.dom.map.get('settings-daily-goal').value, '1200');
  // 写作页里的全局设置提示改成「全局默认 / 本书仍以本书为准」，不再说「只影响当前这本书」
  assert.match(ctx.dom.map.get('settings-scope-hint').textContent, /^这里是全局默认设置/);
  assert.match(ctx.dom.map.get('settings-scope-hint').textContent, /正文显示设置/);
  // 全局作用域照旧读台账（词表 / 日志 / 更新）
  assert.equal(ctx.calls.logInfo, 1);
  assert.equal(ctx.dom.map.get('settings-update-version').textContent, 'v0.10.0');
});

test('openStatsCalendar（U-D4）：打开全局设置并定位到码字日历；按书作用域 / 没有 scrollIntoView 时都不抛', async () => {
  const ctx = build({ view: 'editor', bookId: 'id-1', config: { booksRoot: '/书库' } });
  const calendarField = ctx.dom.map.get('settings-calendar-field');
  const scrolls = [];
  calendarField.scrollIntoView = (opts) => scrolls.push(opts);
  assert.equal(await ctx.ui.openStatsCalendar(), 'global');
  assert.equal(ctx.state.settingsScope, 'global');
  assert.equal(ctx.dom.map.get('settings-backdrop').classList.contains('hidden'), false);
  assert.equal(calendarField.classList.contains('hidden'), false, '全局作用域日历可见');
  assert.deepEqual(scrolls, [{ block: 'center' }], '只滚日历分区、居中');

  // 按书作用域里日历是隐藏分区：传了 section 也不该滚（防以后误用）
  const book = build({ view: 'editor', bookId: 'id-1' });
  const bookField = book.dom.map.get('settings-calendar-field');
  const bookScrolls = [];
  bookField.scrollIntoView = (opts) => bookScrolls.push(opts);
  await book.ui.openSettings({ scope: 'book', section: 'calendar' });
  assert.equal(book.state.settingsScope, 'book');
  assert.equal(bookField.classList.contains('hidden'), true);
  assert.deepEqual(bookScrolls, [], '隐藏分区不滚');

  // 老环境 / 假 DOM 没有 scrollIntoView：打开照常成功，不抛
  const plain = build({ view: 'shelf', bookId: null, config: { booksRoot: '/书库' } });
  await plain.ui.openStatsCalendar();
  assert.equal(plain.state.settingsScope, 'global');
  assert.equal(plain.dom.map.get('settings-backdrop').classList.contains('hidden'), false);
});

test('openStatsCalendar（U-D4）取消不写盘：打开日历再取消，setConfig / bookDisplay 一个写调用都没有', async () => {
  const ctx = build({ view: 'editor', bookId: 'id-1', config: { booksRoot: '/书库', editorFontSize: 20 }, bookDisplay: { editorFontSize: 20 } });
  ctx.state.globalConfig = { booksRoot: '/书库', editorFontSize: 18 };
  const before = { ...ctx.state.config };
  await ctx.ui.openStatsCalendar();
  ctx.ui.closeSettings();
  assert.deepEqual(ctx.calls.setConfig, []);
  assert.deepEqual(ctx.calls.setBookDisplay, []);
  assert.deepEqual(ctx.calls.resetBookDisplay, []);
  assert.deepEqual(ctx.state.config, before, '取消后生效配置回到打开前');
  assert.equal(ctx.dom.map.get('settings-backdrop').classList.contains('hidden'), true);
  assert.equal(ctx.state.settingsBackup, null);
});

test('openSettings（U-D4 旧配置）：全局配置缺统计 / 时长 / 模板键也能打开，按默认回填且取消不写盘', async () => {
  const ctx = build({ view: 'editor', bookId: 'id-1', config: { booksRoot: '/书库' } });
  // 旧 config：没有任何统计 / 时长 / 剪贴板 / 模板 / 导出键（本单元没有新增字段，缺键照旧按默认）
  ctx.state.globalConfig = { booksRoot: '/书库' };
  await ctx.ui.openSettings({ scope: 'global' });
  assert.equal(ctx.dom.map.get('settings-daily-goal').value, '0');
  assert.equal(ctx.dom.map.get('settings-write-duration').checked, false);
  assert.equal(ctx.dom.map.get('settings-clipboard-watch').checked, false);
  assert.equal(ctx.dom.map.get('settings-chapter-template').value, '');
  assert.equal(ctx.dom.map.get('settings-export-conversion').value, '');
  assert.equal(ctx.dom.map.get('settings-snapshot-enabled').checked, false);
  assert.equal(ctx.dom.map.get('settings-snapshot-days').value, '7');
  ctx.ui.closeSettings();
  assert.deepEqual(ctx.calls.setConfig, [], '只打开 / 取消不写盘');
});

// ---------- 五-M16（SS-05）：openSettings 回填时序 / 防重入 ----------
// V204 为了不让作者白等，把弹层挪到 await refreshStats() 之前显示；但回填还在 stats 往返之后，
// 期间表单不禁用、保存可点：作者此时改项会被回填静默覆盖；点保存则把残留值 / index.html 默认值
// 写进 config（booksRoot 是空串 → 配置层回落默认目录，自定义根下的书从书架消失，且该字段在
// 「数据」分区、默认停在「显示」分区根本看不见）。连点「设置」还会并行跑两条打开链、互相覆盖回填。
test('M16（SS-05）：弹层一出现表单就是对的（回填在 refreshStats 之前），期间编辑不被覆盖、保存不再读残留值', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ctx = build({
    view: 'shelf', bookId: null,
    config: { booksRoot: '/书库/自定义根', dailyGoal: 1000 },
    statsGate: gate
  });
  const opening = ctx.ui.openSettings();
  // 不等打开链：此刻 refreshStats 在途，弹层已经可见 —— 表单必须已经按配置回填
  assert.equal(ctx.dom.map.get('settings-backdrop').classList.contains('hidden'), false, '弹层已可见');
  assert.equal(ctx.calls.refreshStats, 1, 'stats 读取已发起（在途）');
  assert.equal(ctx.dom.map.get('settings-root').value, '/书库/自定义根', '回填已完成：书架根不是空串');
  assert.equal(ctx.dom.map.get('settings-daily-goal').value, '1000');

  // 作者在 stats 往返期间改项：回填已经发生，不会被 stats 回执覆盖
  ctx.dom.map.get('settings-daily-goal').value = '1500';
  release();
  await opening;
  assert.equal(ctx.dom.map.get('settings-daily-goal').value, '1500', '作者期间改的值不被回填覆盖');

  // 保存读到的是真实值（不再是残留 / 默认值）
  await ctx.ui.saveSettings();
  assert.equal(ctx.calls.setConfig.length, 1);
  assert.equal(ctx.calls.setConfig[0].dailyGoal, 1500);
  assert.equal(ctx.calls.setConfig[0].booksRoot, '/书库/自定义根', 'booksRoot 不许被空串回落成默认目录');
});

test('M16（SS-05）：连点「设置」只跑一条打开链；打开链在途时被关掉，不再往已关的弹层里写', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ctx = build({ view: 'shelf', bookId: null, config: { booksRoot: '/书库' }, statsGate: gate });
  const first = ctx.ui.openSettings();
  const second = ctx.ui.openSettings(); // 同一拍再点一次：在途，直接忽略
  await flush();
  assert.equal(ctx.calls.refreshStats, 1, '打开链在途时第二次点击不再发起 stats 读取');
  release();
  await Promise.all([first, second]);
  assert.equal(ctx.calls.refreshStats, 1);
  assert.deepEqual(ctx.calls.setConfig, []);

  // 打开链停在 stats 往返、作者点了取消：剩下的台账读取 / 更新区块不再执行
  let release2;
  const gate2 = new Promise((resolve) => { release2 = resolve; });
  const closed = build({ view: 'shelf', bookId: null, config: { booksRoot: '/书库' }, statsGate: gate2 });
  const opening = closed.ui.openSettings();
  closed.ui.closeSettings();
  release2();
  await opening;
  assert.equal(closed.calls.logInfo, 0, '弹层已关掉：不再读日志台账');
  assert.equal(closed.calls.sensitiveWordsInfo, 0);
  assert.equal(closed.calls.proofreadWordsInfo, 0);
  assert.equal(closed.dom.map.get('settings-backdrop').classList.contains('hidden'), true);
});

// V34：设置面板打开时三份台账（词表 / 校对词表 / 日志目录）互不依赖——要并发发起，不许一个等一个。
test('打开设置：三份台账读取并发发起（不串行等）', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  // 词表 / 校对词表只有在「已保存路径」存在时才会去读 IPC（没路径只在本地渲染「未设置」）
  const ctx = build({
    infoGate: gate,
    config: { booksRoot: '/书库', editorFont: 'serif', sensitiveWordsPath: '/书库/敏感词.txt', proofreadWordsPath: '/书库/校对.txt' }
  });
  const opening = ctx.ui.openSettings({ scope: 'global' });
  for (let i = 0; i < 3; i += 1) await flush();
  assert.equal(ctx.calls.sensitiveWordsInfo, 1, '打开设置应先发起敏感词表读取');
  assert.equal(ctx.calls.proofreadWordsInfo, 1, '校对词表读取要同时发起（不能等敏感词表回来）');
  assert.equal(ctx.calls.logInfo, 1, '日志目录读取要同时发起（不能等前两份回来）');
  release();
  await opening;
  // 渲染结果与返回值不变：三份状态都落到 state，日志仍按条数渲染
  assert.equal(ctx.state.sensitiveWordsInfo.ok, true);
  assert.equal(ctx.state.proofreadWordsInfo.ok, true);
  assert.equal(ctx.state.logInfo.files.length, 2);
});

// ---------- P6/V52：设置页与校对面板同源（proofreadWordlists 是唯一事实） ----------
// 1.7.0 F3 之后配置里可能只有 proofreadWordlists（旧单份路径空着），设置页却只看旧字段：
// 结果「设置显示未设置、面板显示 N 份」。多份时状态行报份数 / 合计词数，单份插槽整排收起。
test('multi=true → 状态行报 N 份 / 合计 M 词、选择按钮隐藏（V52）', async () => {
  const ctx = build({
    view: 'shelf', bookId: null,
    config: { booksRoot: '/书库', proofreadWordlists: ['/词表/甲.txt', '/词表/乙.txt'] },
    proofreadInfo: {
      ok: true, multi: true, total: 27, count: 27,
      lists: [{ ok: true, count: 12 }, { ok: true, count: 15 }]
    }
  });
  await ctx.ui.openSettings();
  assert.equal(ctx.calls.proofreadWordsInfo, 1, '配了多份词表时，旧单份路径为空也要读 words-info');
  assert.equal(
    ctx.dom.map.get('settings-proofread-status').textContent,
    '已在校对面板配置 2 份词表（合计 27 词）'
  );
  assert.equal(ctx.dom.map.get('settings-proofread-path').classList.contains('hidden'), true, '只读路径框收起（不删 DOM）');
  assert.equal(ctx.dom.map.get('btn-pick-proofread').classList.contains('hidden'), true, '「选择…」收起（不删 DOM）');
  assert.equal(ctx.dom.map.get('btn-clear-proofread').classList.contains('hidden'), true, '「清除」收起（不删 DOM）');
});
