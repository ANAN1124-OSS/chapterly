'use strict';
// V90（1.7.2 D5）：package.json 包元信息闸门。
//
// 四件事一起锁，防止「补 engines 时顺手把版本号 / 依赖也动了」：
//   ① engines.node = ">=22" —— `node --test "tests/**/*.test.js"` 的 glob 需要 Node 21+，
//      写进元信息让不满足的环境在安装期就能看见（CI 锁 24，本地不低于 22）；
//   ② version 必须是合法 x.y.z，且与所有版本锚点（界面运行时注入 / README / 验收清单）一致 ——
//      版本号只在作者点头的发版轮改：改完 package.json 跑 `node scripts/version-sync.js --write`
//      同步文档，锚点不一致就红。v1.8.0 WP-37 / 审计 D10 起这里不再写死发布号。
//   ③ 运行时依赖仍空、devDependencies 仍只有 3 项 —— 章回是零依赖桌面工具，
//      任何「顺手加个包」都会把安装体积与供应链面一起放大。
//   ④ 许可信息（X1 / v1.8.0 WP-07，D-1 已定 Apache-2.0）：license 字段、根 LICENSE 全文与
//      署名、README 许可说明、build.files 带上 LICENSE —— 公开仓库要能明确授权，安装包内
//      也要附上许可全文；将来发版轮只许改版本号，不许把 LICENSE 改回占位文本。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const readPkg = () => JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const versionSync = require(path.join(ROOT, 'scripts', 'version-sync.js'));

test('package.json 的 engines.node = ">=22"（V90）', () => {
  const pkg = readPkg();
  assert.ok(pkg.engines && typeof pkg.engines === 'object', 'package.json 必须声明 engines');
  assert.equal(pkg.engines.node, '>=22', `engines.node 必须是 >=22（实际：${JSON.stringify(pkg.engines.node)}）`);
});

test('version 是合法 x.y.z，且与界面 / 文档版本锚点一致（发版轮跑 version:sync 同步）', () => {
  const pkg = readPkg();
  assert.match(
    pkg.version,
    /^\d+\.\d+\.\d+$/,
    `version 必须是 x.y.z 形式（实际：${JSON.stringify(pkg.version)}）`
  );
  const problems = versionSync.checkDocs({
    readme: readText('README.md'),
    checklist: readText('验收清单.md'),
    indexHtml: readText('renderer/index.html'),
    version: pkg.version
  });
  assert.deepEqual(
    problems,
    [],
    `版本锚点漂移了：跑 node scripts/version-sync.js --write\n${problems.join('\n')}`
  );
});

test('依赖面不变：运行时依赖空、devDependencies 仍 3 项', () => {
  const pkg = readPkg();
  assert.deepEqual(Object.keys(pkg.dependencies || {}), [], '运行时依赖必须为空（零依赖桌面工具）');
  assert.deepEqual(
    Object.keys(pkg.devDependencies || {}).sort(),
    ['electron', 'electron-builder', 'eslint'],
    'devDependencies 只能有 electron / electron-builder / eslint 三项'
  );
});

test('license 字段是 Apache-2.0（X1 / WP-07，D-1 已定）', () => {
  const pkg = readPkg();
  assert.equal(pkg.license, 'Apache-2.0', `package.json 必须声明 license: "Apache-2.0"（实际：${JSON.stringify(pkg.license)}）`);
});

test('根 LICENSE 是 Apache-2.0 全文并带 D-1 署名（X1 / WP-07）', () => {
  const licensePath = path.join(ROOT, 'LICENSE');
  assert.ok(fs.existsSync(licensePath), '公开仓库根目录必须有 LICENSE');
  const text = fs.readFileSync(licensePath, 'utf8');
  assert.ok(text.length > 10000, `LICENSE 必须是 Apache-2.0 全文而不是摘要（实际 ${text.length} 字符）`);
  for (const marker of [
    'Apache License',
    'Version 2.0, January 2004',
    'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION',
    '2. Grant of Copyright License.',
    '3. Grant of Patent License.',
    'END OF TERMS AND CONDITIONS',
  ]) {
    assert.ok(text.includes(marker), `LICENSE 缺关键条款：${marker}`);
  }
  assert.ok(
    text.includes('Copyright 2026 章回 / Chapterly (ANAN1124-OSS)'),
    'LICENSE 附录必须带 D-1 定的署名 Copyright 2026 章回 / Chapterly (ANAN1124-OSS)'
  );
  assert.equal(text.includes('[yyyy]'), false, 'LICENSE 附录的占位符必须替换成实际署名');
});

test('build.files 带上 LICENSE，安装包内也有许可全文（X1 / WP-07）', () => {
  const files = readPkg().build.files;
  assert.ok(files.includes('LICENSE'), 'build.files 必须包含 LICENSE，否则安装包里没有许可全文');
  assert.ok(files.includes('package.json'), 'build.files 仍要带 package.json');
});

test('build.files 排除 renderer/test-hooks.js（审计 #30 / O2）', () => {
  const files = readPkg().build.files;
  const rendererAt = files.indexOf('renderer/**/*');
  const excludeAt = files.indexOf('!renderer/test-hooks.js');
  assert.ok(rendererAt >= 0, 'renderer/**/* 仍整体打进包');
  assert.ok(excludeAt > rendererAt, '排除项必须排在 renderer/**/* 之后（electron-builder 的 negate 规则按顺序生效）');

  // 钩子文件仍在仓库里：开发版 ?test=1 / E2E / 截图都要用它，排除只对安装包生效。
  const hooks = readText('renderer/test-hooks.js');
  assert.ok(hooks.length > 50000, `renderer/test-hooks.js 必须还在仓库里（实际 ${hooks.length} 字符）`);
  // 页面不许静态引用它：正常窗口不请求、打包版也拿不到。
  assert.ok(
    !/<script[^>]+test-hooks\.js/.test(readText('renderer/index.html')),
    'index.html 不许静态加载 test-hooks.js'
  );
  // README 要如实记录这条出包口径（v0.9 的「保持现状」已作废）。
  const readme = readText('README.md');
  assert.ok(readme.includes('!renderer/test-hooks.js'), 'README 打包段要写明排除项');
  assert.ok(!readme.includes('出包决策已定稿：保持现状'), 'README 不许再写旧的「保持现状」结论');
});

test('README 有许可说明（X1 / WP-07）', () => {
  const readme = readText('README.md');
  assert.ok(readme.includes('## 许可'), 'README 必须有「## 许可」段');
  for (const marker of [
    'Apache License 2.0',
    '[LICENSE](LICENSE)',
    'Copyright 2026 章回 / Chapterly (ANAN1124-OSS)',
  ]) {
    assert.ok(readme.includes(marker), `README 许可段缺：${marker}`);
  }
});