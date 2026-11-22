// 设置面板测试（T9 / 第 10 轮按性质拆分）：静态闸门 / UMD / 结构闸门 / 同源清单。
// 本文件覆盖：index.html 的正文宽度只剩 4 档 → M14/SS-11 的 config:set 广播与渲染层重定基入口 →
// 弹层右上只有一个 × 且绑定只在模块里 → renderer.js 不再内嵌设置实现 → U-D4 状态栏按钮 →
// index.html 加载顺序 → 模块不 require / 不摸 Electron·fs·网络 → UMD 浏览器分支 → V30 头注释成员对账 →
// RSHE-A-02 按书作用域隐藏清单与 settings-ia 同源。
//
// 来源：原 tests/settings-ui.test.js（1,630 行 / 51 例）按性质拆成夹具 + 四个文件，**只搬家不改断言**——
// 用例标题与断言逐字保留，共用夹具收进 tests/settings-ui-fixtures.js（T9 纪律，见 tests/README.md）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT, rendererSrc, indexSrc, moduleSrc, moduleCode, settingsUi } = require('./settings-ui-fixtures');
const preambles = require('./ui-test-preambles');

test('静态闸门（T-06）：index.html 的正文宽度只剩 4 档，模块的档位表与它一致，表单读的是 select 的值', () => {
  // index.html 的 #settings-page-width 块：选项正好 通栏 / 720 / 800 / 840，900 / 1000 一个都不剩
  const at = indexSrc.indexOf('id="settings-page-width"');
  assert.notEqual(at, -1);
  const block = indexSrc.slice(at, indexSrc.indexOf('</select>', at));
  const values = [...block.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(values, ['0', '720', '800', '840'], '正文宽度档位 = 通栏 / 720 / 800 / 840');
  assert.equal(block.includes('900'), false, '900 已从界面下线');
  assert.equal(block.includes('1000'), false, '1000 已从界面下线');
  // 模块里的档位表与 index.html 同源（两处漂移就红）
  assert.match(moduleSrc, /const PAGE_WIDTH_CHOICES = \[0, 720, 800, 840\];/);
  // 保存 / 预览读的就是 select 里选中的值：历史值不会被静默改写
  assert.match(rendererSrc, /editorPageWidth: Number\(\$\('settings-page-width'\)\.value\),/);
  // config 的 clamp 保留 600–1600（历史 900 / 1000 照常加载）
  const configSrc = fs.readFileSync(path.join(ROOT, 'core', 'config.js'), 'utf8');
  assert.equal(configSrc.split('clampRoundedInt(width, 600, 1600, DEFAULTS.editorPageWidth)').length - 1, 1);
  assert.equal(configSrc.split('clampRoundedInt(pageWidth, 600, 1600, DEFAULTS.editorPageWidth)').length - 1, 1);
});

test('静态闸门（M14/SS-11）：config:set 非换根也广播；渲染层刷新 globalConfig 并接上重定基入口', () => {
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = mainSrc.indexOf("handle('config:set'");
  assert.ok(start > 0, 'main.js 里找不到 config:set');
  const body = mainSrc.slice(start, mainSrc.indexOf('\n  handle(', start + 1));
  // 换根分支原样保留（payload 只带 reason / booksRoot），E4 起与普通广播一样用 except 跳过发起窗口
  assert.match(
    body,
    /broadcast\(\s*'config:changed',\s*\{ reason: 'booksRoot', booksRoot: nextConfig\.booksRoot \},\s*\{ except: session \? session\.id : null \}\s*\)/,
    '换根广播要跳过发起窗口（E4）'
  );
  // 写盘成功之后：非换根变更也广播，带顶层键摘要，并跳过发起窗口（自己已拿到回包，不自回声）
  // 五-L2（CI-4）：bookDisplay 的合并挪进写队列后，摘要改由局部变量 changed 收（补上 bookDisplay 键），
  // 广播行仍是同一形状（reason: config + changed + except 发起窗口）。
  assert.match(body, /const changed = Object\.keys\(gated\.patch \|\| \{\}\);/, 'changed 摘要仍取放行后的 patch 顶层键');
  assert.match(
    body,
    /broadcast\(\s*'config:changed',\s*\{ reason: 'config', changed \},\s*\{ except: session \? session\.id : null \}\s*\)/,
    '非换根的全局设置变更要广播（reason: config + changed 摘要 + 跳过发起窗口）'
  );
  const applyAt = body.indexOf('const nextConfig = applyConfig(next);');
  const configReasonAt = body.indexOf("reason: 'config'");
  assert.ok(applyAt > -1 && configReasonAt > applyAt, '广播必须在配置写盘成功之后');
  assert.ok(
    body.indexOf("broadcast('config:changed', { reason: 'booksRoot'") < configReasonAt,
    '换根分支在前、非换根分支在后（现有闸门按这个顺序取清锁 / 广播的位置）'
  );

  // 渲染层：只订阅一次；换根仍交给 configChangeUi；reason 'config' → 刷新全局配置 → 设置表单重定基
  assert.equal((rendererSrc.match(/api\.onConfigChanged\(/g) || []).length, 1, '只订阅一次');
  assert.match(rendererSrc, /refreshConfig: refreshGlobalConfigFromMain/, '换根路径复用同一份配置刷新');
  assert.match(rendererSrc, /payload\.reason !== 'config'/, '按 reason 分流');
  assert.match(rendererSrc, /\.then\(\(\) => handleExternalConfigChange\(\)\)/, '非换根变更要把开着的表单重定基');
  // 换根子情形同样要重定基（否则表单里的旧 booksRoot 会被保存写回旧根 → 换根乒乓）
  assert.equal(
    (rendererSrc.match(/handleExternalConfigChange\(\)/g) || []).length,
    2,
    '非换根 + 换根两条 reason 都要给开着的表单重定基'
  );
  assert.match(
    rendererSrc,
    /if \(payload && payload\.reason === 'booksRoot'\) void handleExternalConfigChange\(\)/,
    '换根分支也要重定基'
  );
  assert.match(rendererSrc, /state\.globalConfig = await call\(api\.getConfig\);/, '刷新的是 globalConfig 快照');
  assert.match(rendererSrc, /\bhandleExternalConfigChange\b[^}]*\} = settingsUi;/, '重定基入口必须从设置模块解构出来');

  // 设置模块：三个前置条件（面板开着 / 保存不在途 / 全局作用域）+ 取配置回来后再复核一遍 + 重定基动作
  assert.match(moduleCode, /if \(!settingsOpen \|\| savingSettings \|\| state\.settingsScope !== 'global'\) return false;/);
  assert.equal(
    (moduleCode.match(/!settingsOpen \|\| savingSettings \|\| state\.settingsScope !== 'global'/g) || []).length,
    2,
    '取配置前后都要复核（取配置期间弹层可能被关 / 重开成按书作用域 / 本窗口开始保存）'
  );
  assert.match(moduleCode, /cfg = await call\(api\.getConfig\)/);
  assert.match(moduleCode, /state\.globalConfig = cfg;/);
  assert.match(moduleCode, /fillSettingsFields\(settingsBackfillConfig\('global'\)\)/);
  assert.match(moduleCode, /state\.settingsBackup = state\.config \? \{ \.\.\.state\.config \} : null;/);
  assert.match(moduleCode, /settingsOpen = true;/, 'openSettings 显示弹层后置位');
  assert.match(moduleCode, /settingsOpen = false;/, 'closeSettings 复位');
});

test('静态闸门：设置弹层右上只有一个 ×，标签与 aria 到位，绑定只在 settings-ui 里', () => {
  const backdropAt = indexSrc.indexOf('id="settings-backdrop"');
  const closeAt = indexSrc.indexOf('id="btn-settings-close"');
  assert.notEqual(closeAt, -1, 'index.html 要有 btn-settings-close');
  assert.ok(backdropAt !== -1 && backdropAt < closeAt, '× 必须在设置弹层里');
  // 紧随标题之后（同一行块内），class 用通用的 .modal-close
  const block = indexSrc.slice(backdropAt, backdropAt + 400);
  assert.match(block, /<h2 class="modal-title" id="settings-title">设置<\/h2>\s*<button id="btn-settings-close" class="modal-close" type="button"/);
  assert.match(block, /title="关闭设置（Esc）" aria-label="关闭设置">×<\/button>/);
  assert.equal(indexSrc.split('id="btn-settings-close"').length - 1, 1, '只加一个');
  assert.equal(rendererSrc.includes("$('btn-settings-close').addEventListener"), false, '绑定只在模块里');
  // 五-L18（SS-13）：× / 取消统一走带「写操作在途」守卫的 cancelSettings（两按钮仍同义）
  assert.equal(moduleSrc.includes("const cancelSettings = () => {"), true);
  assert.equal(moduleSrc.includes("$('btn-settings-close').addEventListener('click', cancelSettings);"), true);
});

// ---------- 静态闸门 ----------
test('静态闸门：renderer.js 不再内嵌设置实现，只剩装配与转发', () => {
  for (const shape of [
    'function setSelectValue(',
    'function renderSettingsCaretColors(',
    'function fillSettingsFields(',
    'function renderChapterTemplatePreview(',
    'function renderSensitiveSettings(',
    'function renderProofreadSettings(',
    'function renderLogSettings(',
    'function formatUpdateDate(',
    'async function checkUpdate(',
    'async function openUpdateDownload(',
    'async function openSettings(',
    'async function saveSettings(',
    'async function resetBookDisplay(',
    'function updateSettingsScopeUi(',
    'function previewSettings('
  ]) {
    assert.equal(rendererSrc.includes(shape), false, 'renderer.js 里还有第二份：' + shape);
  }
  assert.equal(rendererSrc.split('settingsUiModule.create(').length - 1, 1, '装配只许一处');
  assert.ok(rendererSrc.includes('const settingsUiModule = window.CWSettingsUi;'));
  for (const line of [
    '    $, state, api, call, toast, chaptersLib,',
    '    display: { applyEditorStyle, syncCaretParagraphFromConfig, effectiveConfig, applySidebarWidth, loadCustomFont, readDisplayForm, displaySettingsIds, caretColorLib, s2tLib, templateLib, editorLogic, applyChapterNumbering: applyChapterNumberingMeta },',
    '      stats: { refreshStats, renderStatsChart },',
    '      writeTimer: { renderDurationSettings, renderWriteTimer, applyWriteTimerConfig, writeDurationEnabled, flushWriteTimer },',
    '      editor: { renderEditorMarks, renderMarksMenu },',
    '      words: { refreshSensitiveWordList, refreshProofreadWordList, sensitiveWordListText, proofreadWordListText, pickSensitiveWords, pickProofreadWords },',
    '    texts: { commonLib, formatBytes }'
  ]) {
    assert.ok(rendererSrc.includes(line), '装配少了：' + line);
  }
  // 五-M14（SS-11）：解构表从 14 个入口变 15 个——新增 handleExternalConfigChange（跨窗口设置
  // 变更后给开着的设置表单重定基）。入口仍按原名解构，一个都不许在 renderer 里另写一份实现。
  assert.ok(rendererSrc.includes(
    'const { setSelectValue, renderSettingsCaretColors, renderChapterTemplatePreview, renderSensitiveSettings, renderProofreadSettings, checkUpdate, openUpdateDownload, previewSettings, openSettings, openStatsCalendar, closeSettings, handleExternalConfigChange, resetBookDisplay, saveSettings, setupSettingsUi } = settingsUi;'
  ), '15 个入口按原名解构');
  // 6 个绑定块里的设置 id 不再出现在 renderer 的事件绑定里（写作计时 / 日历绑定仍留）
  for (const id of ['btn-settings', 'btn-settings-cancel', 'btn-settings-save', 'btn-reset-book-display', 'btn-pick-folder',
    'btn-pick-font', 'btn-reset-font', 'settings-font', 'settings-caret-paragraph', 'settings-caret-color']) {
    assert.equal(rendererSrc.includes(`$('${id}').addEventListener`), false, '绑定应该只在模块里：' + id);
  }
  assert.equal(rendererSrc.split('setupSettingsUi();').length - 1, 1, 'setup 只调一次');
  assert.match(rendererSrc, /'close-settings': \(\) => closeSettings\(\),/);
  // 校对 / 敏感词装配里的 render*Settings 现在是惰性转发（TDZ）
  assert.ok(rendererSrc.includes('renderProofreadSettings: () => renderProofreadSettings()'));
  assert.ok(rendererSrc.includes('renderSensitiveSettings: () => renderSensitiveSettings()'));
  // 整理卡 / 显示菜单已随第八刀搬到 tidy-card-ui.js，这里不再断言 renderer 里直接调 openSettings；
  // 只确认 scope 键 openSettings 仍在（上面已逐个断言）
  for (const key of ['setSelectValue', 'renderSettingsCaretColors', 'renderChapterTemplatePreview', 'renderSensitiveSettings', 'renderProofreadSettings', 'checkUpdate', 'openUpdateDownload', 'previewSettings', 'openSettings', 'closeSettings', 'resetBookDisplay', 'saveSettings']) {
    assert.match(rendererSrc, new RegExp('^      ' + key + ',$', 'm'), 'testHooksScope 少了 ' + key);
  }
});

test('静态闸门（U-D4）：状态栏今日字数是按钮、点击只在渲染层接线，打开 / 回填 / 定位口径只在模块里', () => {
  // index.html：一个 button（不是 span），带 type / aria / 说明
  assert.equal(indexSrc.split('id="status-stats"').length - 1, 1);
  assert.match(indexSrc, /<button id="status-stats" class="status-stats hidden" type="button" aria-haspopup="dialog"/);
  assert.equal(indexSrc.includes('<span id="status-stats"'), false, 'span 已换成 button');
  // renderer.js 只接线：点击 → 模块入口；不自己拼作用域 / 不自己开弹层
  assert.ok(rendererSrc.includes("$('status-stats').addEventListener('click', () => {"));
  assert.ok(rendererSrc.includes('void openStatsCalendar();'));
  assert.equal(rendererSrc.includes("openSettings({ scope: 'global'"), false, '作用域口径只在模块里');
  // 模块：一个入口函数，固定「全局 + 日历分区」，复用 openSettings / closeSettings
  assert.equal((moduleSrc.match(/async function openStatsCalendar\(/g) || []).length, 1);
  assert.ok(moduleSrc.includes("await openSettings({ scope: 'global', section: 'calendar' });"));
  assert.ok(moduleSrc.includes("const SETTINGS_SECTIONS = { calendar: 'settings-calendar-field' };"));
  // 状态栏统计仍由 stats-ui 渲染（设置模块不碰 #status-stats 的文案）
  assert.equal(moduleSrc.includes("$('status-stats')"), false);
});

test('静态闸门：index.html 在 renderer.js 之前加载 settings-ui.js，且只加载一次', () => {
  const at = indexSrc.indexOf('<script src="settings-ui.js"></script>');
  const rendererAt = indexSrc.indexOf('<script src="renderer.js"></script>');
  assert.notEqual(at, -1);
  assert.ok(at < rendererAt);
  assert.equal(indexSrc.split('settings-ui.js').length - 1, 1);
});

test('静态闸门：模块不 require / 不摸 Electron·fs·网络；无全局监听 / 无定时器', () => {
  // A8（WP-32）：唯一允许的 require 是 UMD 的 Node 分支取 core/assert-host.js（浏览器走 window.CWAssertHost）；
  // 运行时代码仍不许 require 任何东西。
  // T8（三审·低）：UMD 分支闸门只留 tests/assert-host.test.js 一处（那里逐个模块核对 require / 全局名 / 工厂签名）。
  const runtimeCode = preambles.stripAssertHostBranch(moduleCode);
  for (const forbidden of ['require(', 'ipcRenderer', 'node:fs', 'child_process', 'localStorage', 'fetch(', 'window.', 'process.']) {
    assert.equal(runtimeCode.includes(forbidden), false, 'settings-ui.js 不许出现 ' + forbidden);
  }
  assert.equal(/window\.addEventListener|document\.addEventListener/.test(moduleCode), false);
  assert.equal((moduleCode.match(/setTimeout\(/g) || []).length, 0);
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWSettingsUi，且不乱造别的全局', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(moduleSrc, context, { filename: 'renderer/settings-ui.js' });
  assert.equal(typeof win.CWSettingsUi, 'object');
  assert.deepEqual(Object.keys(win.CWSettingsUi).sort(), ['REQUIRED_HOST', 'create']);
  assert.equal(win.CWSettingsUi.REQUIRED_HOST.length, 9);
  assert.equal(win.CWBookinfoUi, undefined);
});

// ---------- 结构闸门：头注释契约成员 ↔ 代码实际校验（V30） ----------
// 头注释是设置模块唯一的人读契约；它列的 host 成员必须和 createSettingsUi 真正校验的成员逐个对上，
// 否则渲染层照注释接线、少传一个成员，只会在运行时抛 TypeError。
test('结构闸门：头注释列出的 host 成员与代码实际校验一致（V30）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'settings-ui.js'), 'utf8');
  const head = src.slice(0, src.indexOf('*/'));
  assert.ok(head.length > 0, '找不到模块头注释');

  // 头注释第一段写了「host N 个成员」，N 必须等于 REQUIRED_HOST 的实际长度
  const declaredCount = Number((head.match(/host (\d+) 个成员/) || [])[1]);
  assert.equal(declaredCount, settingsUi.REQUIRED_HOST.length, '头注释的成员数要等于 REQUIRED_HOST 的实际长度');

  // display 分组：注释里逐个列出的成员 ↔ 代码里 host.display 的校验表
  const displayStart = head.indexOf('display: {');
  const displayEnd = head.indexOf('},', displayStart);
  assert.notEqual(displayStart, -1, '头注释里找不到 display 分组');
  assert.notEqual(displayEnd, -1, '头注释 display 分组没有收尾');
  const commentKeys = [...head.slice(displayStart, displayEnd).matchAll(/^\s*\*\s+([A-Za-z_$][\w$]*)\s*,?\s*(?:\/\/.*)?$/gm)].map((m) => m[1]);
  assert.ok(commentKeys.length > 0, '头注释 display 分组没解析出成员');

  const codeMatch = src.match(/const DISPLAY_HOST_KEYS = \[([\s\S]*?)\];/);
  assert.ok(codeMatch, '代码里找不到 host.display 的校验表（DISPLAY_HOST_KEYS）');
  const codeKeys = [...codeMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.equal(codeKeys.length, codeKeys.filter((k) => k).length);
  assert.deepEqual([...commentKeys].sort(), [...codeKeys].sort(), '头注释 display 成员要和实际校验逐个对上（缺一即红）');
});

// RSHE-A-02（第五轮审计）：按书作用域要隐藏的全局设置项以前是八段手写循环，新增全局组
// 漏抄一段就把按书设置变成可改全局。现在收敛到 settings-ia.GLOBAL_ONLY_FIELDS + 一条单循环。
test('RSHE-A-02：按书作用域隐藏清单与 settings-ia 同源，settings-ui 只剩一条单循环', () => {
  const settingsIa = require('../renderer/settings-ia');
  assert.ok(Array.isArray(settingsIa.GLOBAL_ONLY_FIELDS), 'settings-ia 要导出 GLOBAL_ONLY_FIELDS');
  for (const id of settingsIa.GLOBAL_ONLY_FIELDS) {
    assert.equal(typeof settingsIa.FIELD_SECTION[id], 'string', id + ' 必须已在 FIELD_SECTION 登记（同源维护）');
  }
  const moduleSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'settings-ui.js'), 'utf8').replace(/\r\n/g, '\n');
  const fallback = /GLOBAL_ONLY_FIELDS_FALLBACK = \[([\s\S]*?)\];/.exec(moduleSrc);
  assert.ok(fallback, 'settings-ui 要有 ia 不可用时的回落清单');
  const fallbackIds = [...fallback[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(fallbackIds, [...settingsIa.GLOBAL_ONLY_FIELDS], '回落清单必须与 settings-ia 逐字一致');
  const scopeStart = moduleSrc.indexOf('function updateSettingsScopeUi(');
  assert.ok(scopeStart > 0);
  const scopeBody = moduleSrc.slice(scopeStart, moduleSrc.indexOf('\n  }', scopeStart));
  assert.equal((scopeBody.match(/for \(const id of /g) || []).length, 1, '按作用域隐藏只留一条单循环');
  assert.match(scopeBody, /for \(const id of globalOnlyFields\)/);
});
