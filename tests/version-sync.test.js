'use strict';
// WP-37（审计 D10）：版本单一事实来源 —— 同步脚本的纯逻辑 + 仓库现状锚点。
//
// 版本号以前散在 package.json / renderer/index.html（两处）/ README 标题与下载名 / 验收清单标题，
// 发版靠手工同步。现在 package.json 是唯一权威：界面由运行时注入，文档由 scripts/version-sync.js
// 同步；本文件既验证同步逻辑，也把「仓库当前没有漂移」钉成门禁（漂移即红，按提示跑 --write）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const versionSync = require(path.join(ROOT, 'scripts', 'version-sync.js'));

const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const PKG = JSON.parse(readText('package.json'));
const README = readText('README.md');
const CHECKLIST = readText('验收清单.md');
const INDEX_HTML = readText('renderer/index.html');
const RENDERER = readText('renderer/renderer.js');
const PRELOAD = readText('preload.js');
const MAIN = readText('main.js');

const CRLF = '\r\n';

// 与真实 README 同形的样例：标题 + 版本沿革 + 下载行（两处安装包名 + Release 链接 + 发布日期）
// + 自检命令里的两个计数。全部锚点都在，替换后历史版本（v1.0.0）必须原样保留。
function readmeSample() {
  return [
    '# 章回 / Chapterly v1.7.2',
    '',
    '> **版本沿革**：本仓库从 **v1.0.0** 起。',
    '',
    '**下载**：从 [GitHub Releases](https://github.com/ANAN1124-OSS/chapterly/releases) 下载 `chapterly-1.7.2-win-x64-setup.exe`（已于 2026-11-14 发布，见 [v1.7.2](https://github.com/ANAN1124-OSS/chapterly/releases/tag/v1.7.2)），或者直接用本机打包产物 `dist\\chapterly-1.7.2-win-x64-setup.exe`。',
    '',
    'pnpm test          # 单元测试（node:test，2235 项，覆盖 书架与写作页）',
    'pnpm run e2e       # 端到端自检：真实启动 Electron 走 1828 项主流程（含菜单键盘可达）'
  ].join(CRLF);
}

// 与真实验收清单同形的样例：标题 + 计数 + 一条历史版本沿革（不是锚点）+ 安装验收行里的旧包名。
function checklistSample() {
  return [
    '# 章回 / Chapterly v1.7.2 · 手工验收清单',
    '',
    '> 自动化部分可先跑：`pnpm test`（2235 项）、`pnpm run e2e`（1828 项）、`node scripts/contrast.js`（504 条扩展态 + 12 条禁用态豁免）。',
    '',
    '- **v1.7.1 + v1.7.2（2026-11-14，合并发布为 v1.7.2）** 是 1.7.1 六项用户路径修复 + 1.7.2 债务批。',
    '',
    '| 36 | 双击 `dist\\chapterly-1.2.0-win-x64-setup.exe` 安装（可选目录），再从桌面快捷方式启动 | ☐ |'
  ].join(CRLF);
}

test('版本同步：README 标题 / 两处安装包名 / Release 链接一起换版本，历史版本与换行原样保留', () => {
  const sample = readmeSample();
  const out = versionSync.syncReadme(sample, { version: '1.8.0' });
  assert.ok(out.startsWith(`# 章回 / Chapterly v1.8.0${CRLF}`), '标题要换成新版本并保留 CRLF');
  assert.equal(
    (out.match(/chapterly-1\.8\.0-win-x64-setup\.exe/g) || []).length,
    2,
    '下载行与本机产物两处包名都要换'
  );
  assert.ok(out.includes('[v1.8.0](https://github.com/ANAN1124-OSS/chapterly/releases/tag/v1.8.0)'));
  assert.ok(!out.includes('1.7.2'), '样例里的版本锚点不应残留');
  assert.ok(out.includes('**v1.0.0**'), '版本沿革里的历史版本不是锚点，不许被改');
  assert.equal(out.split(CRLF).length, sample.split(CRLF).length, '行数与换行风格不变');
});

test('版本同步：README 两个计数一起换，正文其它数字不动', () => {
  const sample = readmeSample();
  const out = versionSync.syncReadme(sample, { unitCount: 2500, e2eCount: 1881 });
  assert.ok(out.includes('node:test，2500 项，覆盖 书架与写作页'));
  assert.ok(out.includes('真实启动 Electron 走 1881 项主流程（含菜单键盘可达）'));
  assert.ok(!out.includes('2235') && !out.includes('1828'), '旧计数不应残留');
  assert.ok(out.includes('v1.7.2'), '只同步计数时版本锚点一个字都不许动');
});

test('版本同步：README 发布日期只在显式给了 --date 时换', () => {
  const out = versionSync.syncReadme(readmeSample(), { date: '2026-11-20' });
  assert.ok(out.includes('已于 2026-11-20 发布'));
  assert.ok(!out.includes('2026-11-14'), '旧发布日期不应残留');
  assert.ok(out.includes('v1.7.2'), '只同步日期时版本锚点不动');
});

test('版本同步：验收清单标题 / 安装包名 / 两个计数一起换，历史沿革与对比度数字不动', () => {
  const sample = checklistSample();
  const out = versionSync.syncChecklist(sample, {
    version: '1.8.0',
    unitCount: 2500,
    e2eCount: 1881
  });
  assert.ok(out.startsWith(`# 章回 / Chapterly v1.8.0 · 手工验收清单${CRLF}`));
  assert.ok(out.includes('`dist\\chapterly-1.8.0-win-x64-setup.exe`'), '安装验收行的包名要换');
  assert.ok(out.includes('`pnpm test`（2500 项）、`pnpm run e2e`（1881 项）'));
  assert.ok(out.includes('504 条扩展态 + 12 条禁用态豁免'), '对比度计数不是版本锚点，不许被改');
  assert.ok(
    out.includes('- **v1.7.1 + v1.7.2（2026-11-14，合并发布为 v1.7.2）**'),
    '历史沿革整句原样保留'
  );
  assert.equal(out.split(CRLF).length, sample.split(CRLF).length, '行数与换行风格不变');
});

test('版本同步：结构漂移 / 坏参数一律抛错，不静默漏改', () => {
  assert.throws(() => versionSync.syncReadme(readmeSample(), { version: '1.8' }), /x\.y\.z/);
  const missingAnchor = readmeSample().replace('chapterly-1.7.2-win-x64-setup.exe', 'chapterly-win-x64-setup.exe');
  assert.throws(
    () => versionSync.syncReadme(missingAnchor, { version: '1.8.0' }),
    /「安装包名」锚点应有 2 处/
  );
  assert.throws(() => versionSync.syncReadme(readmeSample(), { unitCount: 10 }), /必须一起给/);
  assert.throws(
    () => versionSync.syncReadme(readmeSample(), { unitCount: 0, e2eCount: 1 }),
    /正整数/
  );
  assert.throws(() => versionSync.syncReadme('没有锚点的文本', {}), /没有要同步的内容/);
  assert.throws(() => versionSync.syncReadme(readmeSample(), { date: '2026-13-40' }), /YYYY-MM-DD/);
});

test('版本锚点检查：index.html 两个版本元素必须是空占位（运行时注入），写了版本串即报问题', () => {
  assert.deepEqual(versionSync.checkIndexHtml(INDEX_HTML), []);
  const bad = '<span id="app-version" class="version">v1.7.2</span>\r\n<strong id="settings-update-version">v1.7.2</strong>';
  const problems = versionSync.checkIndexHtml(bad);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /#app-version 还写着静态版本/);
  assert.match(problems[1], /#settings-update-version 还写着静态版本/);
  assert.match(versionSync.checkIndexHtml('<span id="app-version"></span>')[0], /找不到 #settings-update-version/);
});

test('版本单一事实来源：仓库现状无漂移（锚点 = package.json、两处计数一致、界面 0 处静态版本串）', () => {
  const problems = versionSync.checkDocs({
    readme: README,
    checklist: CHECKLIST,
    indexHtml: INDEX_HTML,
    version: PKG.version
  });
  assert.deepEqual(
    problems,
    [],
    `版本锚点漂移了：跑 node scripts/version-sync.js --write（计数用 --unit / --e2e 一起给）\n${problems.join('\n')}`
  );
});

test('版本单一事实来源：界面只走运行时注入，package.json 是唯一权威（静态闸门）', () => {
  // index.html：注释之外不许再出现 x.y.z 版本串（两个元素都是空占位，由启动时注入）。
  const htmlNoComments = INDEX_HTML.replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(htmlNoComments, /\d+\.\d+\.\d+/, 'index.html 不许再出现写死的版本号');
  // 运行时注入链：渲染层 → preload → 主进程 app.getVersion()。
  assert.match(RENDERER, /await call\(api\.appVersion\)/);
  assert.match(RENDERER, /state\.appVersion = \(appInfo && appInfo\.version\) \|\| ''/);
  assert.match(RENDERER, /versionEl\.textContent = `v\$\{appInfo\.version\}`/);
  assert.match(PRELOAD, /appVersion: \(\) => invoke\('app:version'\)/);
  assert.match(MAIN, /handle\('app:version', async \(\) => \(\{ version: app\.getVersion\(\) \}\)\)/);
  // 发版脚本：package.json 有入口、README 记录用法；安装包名由 ${version} 派生，不手写。
  assert.equal(PKG.scripts['version:sync'], 'node scripts/version-sync.js');
  assert.ok(README.includes('node scripts/version-sync.js'), 'README 要记录版本同步命令');
  assert.equal(PKG.build.win.artifactName, 'chapterly-${version}-win-x64-setup.${ext}');
});

test('版本同步 CLI：--check 在干净仓库上退出 0', () => {
  const res = spawnSync(process.execPath, [path.join('scripts', 'version-sync.js'), '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000
  });
  assert.equal(res.status, 0, `--check 应退出 0：stdout=${res.stdout}\nstderr=${res.stderr}`);
  assert.match(res.stdout, /版本单一事实来源校验通过/);
});