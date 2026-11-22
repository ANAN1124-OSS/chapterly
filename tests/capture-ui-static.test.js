// 剪贴板面板测试（T9 / 第 9 轮按性质拆分）：剪贴板面板的静态闸门。
//
// 来源：原 tests/capture-ui.test.js（1,921 行）拆成夹具 + 三个文件，**只搬家不改断言**——
// 用例标题与断言逐字保留，共用夹具收进 tests/capture-ui-fixtures.js。
// 本文件覆盖：index.html 只留列表视图 DOM、styles.css 的 .capture-record* 样式、renderer.js 只接线、
// 面板实现只在 renderer/capture-ui.js、test-hooks 列表版钩子、模块只走白名单 IPC。
const test = require('node:test');
const assert = require('node:assert/strict');
const { moduleSrc, rendererSrc, moduleCode, indexSrc, stylesSrc, rendererCode, hooksSrc } = require('./capture-ui-fixtures');

// ---------- 静态闸门 ----------

test('静态闸门：index.html 只留列表视图 DOM，必要 id 都在、旧表单 id 全删、脚本顺序不变', () => {
  for (const id of [
    'capture-backdrop',
    'capture-title',
    'capture-queue-view',
    'capture-queue-summary',
    'capture-position',
    'capture-queue-list',
    'capture-queue-empty',
    'btn-capture-import',
    'btn-capture-queue-clear',
    'btn-capture-queue-cancel'
  ]) {
    assert.ok(indexSrc.includes(`id="${id}"`), `index.html 缺 #${id}`);
  }
  for (const id of [
    'capture-form-view',
    'capture-summary',
    'capture-warnings',
    'capture-title-count',
    'capture-lines',
    'capture-list-note',
    'capture-list-head',
    'btn-capture-expand',
    'btn-capture-back',
    'btn-capture-all-body',
    'btn-capture-commit',
    'btn-capture-cancel'
  ]) {
    assert.equal(indexSrc.includes(`id="${id}"`), false, `旧表单 #${id} 必须删掉`);
  }
  assert.match(indexSrc, /<h2 class="modal-title" id="capture-title">剪贴板<\/h2>/);
  assert.match(indexSrc, /<div id="capture-queue-list" class="capture-record-list" role="list">/);
  assert.match(indexSrc, /<option value="end">全书末尾（默认）<\/option>/);
  assert.match(indexSrc, /<option value="after-current">当前章之后<\/option>/);
  assert.match(indexSrc, /<button id="btn-capture-import" class="btn ghost hidden"/);
  assert.equal(/id="capture-queue-view"[^>]*hidden/.test(indexSrc), false, '列表视图是唯一视图，不该默认隐藏');

  const at = (needle) => {
    const index = indexSrc.indexOf(needle);
    assert.notEqual(index, -1, `index.html 里找不到 ${needle}`);
    return index;
  };
  assert.ok(at('../core/chapters.js') < at('../core/capture.js'), 'capture.js 要用 chapters.js 的字数 / 常量');
  assert.ok(at('../core/capture.js') < at('capture-ui.js'), 'capture-ui 要先拿到 window.CWCapture');
  assert.ok(at('capture-ui.js') < at('renderer.js'), 'capture-ui.js 必须在 renderer.js 之前加载');
});

test('静态闸门：styles.css 换成 .capture-record* 列表样式，旧表单 / 旧队列行样式删净', () => {
  for (const cls of [
    'capture-record-list',
    'capture-record-head',
    'capture-record-text',
    'capture-record-actions',
    'capture-record-no',
    'capture-record-meta',
    'capture-record-badge'
  ]) {
    assert.match(stylesSrc, new RegExp(`\\.${cls}\\s*\\{`), `styles.css 缺 .${cls}`);
  }
  assert.match(stylesSrc, /\.capture-record\s*\{/, 'styles.css 缺 .capture-record');
  assert.match(stylesSrc, /\.capture-record-list\s*\{[^}]*max-height:\s*46vh/, '列表最大高度按契约 46vh');
  for (const old of [
    'capture-line',
    'capture-tag',
    'capture-form-view',
    'capture-list-head',
    'capture-lines',
    'capture-list-foot',
    'capture-hint',
    'capture-warnings',
    'capture-warning',
    'capture-queue-item',
    'capture-queue-no',
    'capture-queue-meta',
    'capture-queue-preview',
    'capture-queue-pending'
  ]) {
    assert.equal(new RegExp(`\\.${old}\\b`).test(stylesSrc), false, `styles.css 里旧样式 .${old} 应已删除`);
  }
  assert.equal(/#capture-title-count/.test(stylesSrc), false);

  const start = stylesSrc.indexOf('/* ---------- 剪贴板（P0）：单列表视图');
  const end = stylesSrc.indexOf('/* ---------- 章节拖拽排序');
  assert.ok(start >= 0 && end > start, 'styles.css 里找不到新的剪贴板样式段');
  const block = stylesSrc.slice(start, end);
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(block), false, '颜色只能走现有 CSS 变量，不新造令牌');
  assert.equal(/rgba?\(|hsla?\(/.test(block), false, '颜色只能走现有 CSS 变量，不新造令牌');
});

test('静态闸门：renderer.js 只接线（9 成员 host / 列表委托 / 插入位置 / 导入 / Esc / 刷新）', () => {
  const createBlock = /const captureUi = captureUiModule\.create\(\{([\s\S]{0,400}?)\}\);/.exec(rendererSrc);
  assert.ok(createBlock, 'renderer.js 里找不到 captureUiModule.create({...})');
  assert.match(createBlock[1], /\$\s*,/, 'captureUi.create 缺 $');
  for (const key of [
    'state',
    'api',
    'call',
    'toast',
    'saveCurrent',
    'loadChapterAt',
    'renderStatsUi',
    'insertIntoBody'
  ]) {
    assert.match(createBlock[1], new RegExp(`\\b${key}\\b`), `captureUi.create 缺 ${key}`);
  }
  // insertIntoBody 有真实实现（不只是把名字交给模块）
  assert.match(
    rendererSrc,
    /function insertIntoBody\(|const insertIntoBody\s*=|insertIntoBody:\s*(?:async\s*)?\(/,
    'renderer.js 缺 insertIntoBody 实现'
  );

  // 列表点击委托：两个动作 + 两种 ref
  const listBind = rendererSrc.indexOf("$('capture-queue-list').addEventListener('click'");
  assert.notEqual(listBind, -1, '缺 #capture-queue-list 点击委托');
  const delegate = rendererSrc.slice(listBind, listBind + 800);
  for (const needle of [
    'data-action',
    'captureUi.applyBody(',
    'captureUi.createChapter(',
    'dataset.pending',
    'dataset.id'
  ]) {
    assert.ok(delegate.includes(needle), `列表委托里缺 ${needle}`);
  }
  // 底栏 / 插入位置 / 导入
  assert.match(rendererSrc, /\$\('btn-capture-queue-clear'\)\.addEventListener\('click'/);
  assert.match(rendererSrc, /\$\('btn-capture-queue-cancel'\)\.addEventListener\('click'/);
  assert.match(
    rendererSrc,
    /\$\('capture-position'\)\.addEventListener\('change', \(\) => \{[\s\S]{0,160}?captureUi\.setPosition\(/
  );
  assert.match(
    rendererSrc,
    /\$\('btn-capture-import'\)\.addEventListener\('click', \(\) => \{[\s\S]{0,260}?captureUi\.close\(\);[\s\S]{0,140}?backToShelf\(\)[\s\S]{0,80}?onImportClick\(\)/,
    '去导入小说要：关面板 → 回书架 → 打开导入对话框'
  );
  // Esc：确认取消路径走 captureUi.cancel()（处理中不许关），不再直接 close
  const escCapture = /'close-capture': \(\) => \{([\s\S]{0,180}?)\},/.exec(rendererSrc);
  assert.ok(escCapture, 'renderer.js 里找不到 close-capture 动作');
  assert.match(escCapture[1], /captureUi\.cancel\(\)/, 'Esc 要走 cancel');
  assert.equal(/captureUi\.close\(\)/.test(escCapture[1]), false, 'Esc 不许再直接 close');
  // 剪贴板变化：面板开着就刷新（单列表视图不再区分 view）
  assert.match(
    rendererSrc,
    /if \(captureUi\.isOpen\(\)\) \{[\s\S]{0,200}?captureUi\.refreshQueue\(\)/,
    '面板开着时新复制要原地刷新列表'
  );
  assert.equal(rendererSrc.includes('captureUi.view() ==='), false, '单列表视图不该再判断 view');
  // 旧表单绑定全删
  for (const old of [
    'btn-capture-commit',
    'btn-capture-all-body',
    'btn-capture-back',
    'btn-capture-expand',
    'btn-capture-cancel',
    'captureUi.selectEntry(',
    'captureUi.selectPending(',
    'captureUi.commit(',
    'captureUi.allAsBody(',
    'captureUi.expand(',
    'captureUi.backToQueue('
  ]) {
    assert.equal(rendererSrc.includes(old), false, `renderer.js 里旧接线还在：${old}`);
  }
});

test('静态闸门：面板实现只在 renderer/capture-ui.js，renderer.js 不许长回第二份', () => {
  assert.ok(moduleSrc.includes('function createCaptureUi(host)'), '模块必须交出 createCaptureUi(host)');
  // TESTC-01：只钉挂载的实参序列（依赖按序传入），不钉换行方式 / 整行字面量。
  assert.match(
    moduleSrc,
    /root\.CWCaptureUi = factory\(\s*root\.CWChapters,\s*root\.CWCapture,\s*root\.CWCommon,\s*root\.CWBackdropRegistry,\s*root\.CWAssertHost && root\.CWAssertHost\.assertHost\s*\)/,
    '浏览器挂载口径（1.8.0 WP-17：第 4 个依赖是弹层注册表；A8/WP-32：第 5 个是共享 host 校验）'
  );
  assert.ok(moduleSrc.includes('REQUIRED_HOST'), '必须有 host 契约清单');
  for (const forbidden of [
    'capture-record',
    'capture-line',
    'capture-tag',
    'capture-form-view',
    'captureWarnings',
    'renderCapturePanel',
    'visibleLines',
    'composeBody',
    'analyzeCapture',
    'prepareCaptureCommit',
    'state.capture'
  ]) {
    assert.equal(rendererCode.includes(forbidden), false, `renderer.js 里不该再有 ${forbidden}（面板实现要留在模块里）`);
  }
});

test('静态闸门：test-hooks 钩子改成列表版（applyBody / createChapter / records），旧表单钩子全删', () => {
  for (const name of [
    'openCapture',
    'closeCapture',
    'captureOpen',
    'captureQueue',
    'captureQueueClear',
    'captureView',
    'captureApplyBody',
    'captureCreateChapter',
    'captureRecords'
  ]) {
    assert.ok(hooksSrc.includes(name), `renderer/test-hooks.js 缺 ${name}`);
  }
  assert.match(hooksSrc, /captureApplyBody[\s\S]{0,100}?captureUi\.applyBody\(/, 'captureApplyBody 要转调 applyBody');
  assert.match(
    hooksSrc,
    /captureCreateChapter[\s\S]{0,100}?captureUi\.createChapter\(/,
    'captureCreateChapter 要转调 createChapter'
  );
  assert.match(hooksSrc, /captureRecords[\s\S]{0,100}?captureUi\.records\(/, 'captureRecords 要转调 records');
  assert.match(hooksSrc, /captureView: \(\) => captureUi\.view\(\)/, 'captureView 恒 list');
  for (const old of [
    'captureLines',
    'captureTitle',
    'captureSummary',
    'captureWarningTexts',
    'setCaptureKind',
    'setAllCaptureBody',
    'commitCapture',
    'captureCommitDisabled',
    'captureSelectEntry'
  ]) {
    assert.equal(hooksSrc.includes(old), false, `旧表单钩子 ${old} 应删除`);
  }
});

test('静态闸门：模块不碰 Electron / 文件系统 / localStorage，只走白名单 IPC', () => {
  // TESTC-05：假 DOM 的 innerHTML 只支持清空（非空赋值会抛错）；模块侧同样只许 `innerHTML = ''`。
  const innerHtmlAssignments = moduleCode.match(/\.innerHTML\s*=\s*[^;\n]+/g) || [];
  for (const assignment of innerHtmlAssignments) {
    assert.match(assignment, /=\s*''\s*$/, `innerHTML 只许清空（假 DOM 不支持建节点）：${assignment.trim()}`);
  }
  for (const forbidden of [
    "require('electron')",
    'ipcRenderer',
    'node:fs',
    'document.getElementById',
    'clipboard.read',
    'localStorage',
    'setInterval',
    'analyzeCapture',
    'commitCapture',
    'prepareCaptureCommit',
    'composeBody',
    'selectEntry',
    'selectPending',
    'backToQueue'
  ]) {
    assert.equal(moduleCode.includes(forbidden), false, `capture-ui.js 不该出现 ${forbidden}（只算 + 只改 DOM）`);
  }
  for (const apiName of [
    'captureQueueList',
    'captureQueueGet',
    'captureQueueRemove',
    'captureQueueClear',
    'captureClipboard',
    'captureCommitRecord'
  ]) {
    assert.ok(moduleSrc.includes(apiName), `模块缺白名单 IPC ${apiName}`);
  }
});
