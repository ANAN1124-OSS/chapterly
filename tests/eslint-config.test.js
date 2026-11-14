'use strict';
// 1.7.0 G1a；1.8.0 WP-35：eslint 门禁的静态锚点（本地 + CI 同一份配置）；1.8.0 WP-36（D5/D13）收口。
//
// 只锁五件事，防止「装着装着把门禁换了」：
//   ① `devDependencies` 里只有 eslint 一个新增包，且是**精确版本**（不带 ^ / ~ / 范围）——
//      范围版本会让不同机器、不同 CI 跑出不同的规则集，门禁结论不可复现；
//   ② `eslint.config.js` 存在，且启用的规则只有约定规则集（`no-undef` / `no-unused-vars`）——
//      不许偷偷塞 `no-floating-promises` 这类需要 TS 解析器的规则：那条由 `scripts/lint-gate.js`
//      的既有 promise 检查负责，两套口径并存会互相打架；
//   ③ `scripts.lint` 仍是 `node scripts/lint-gate.js` —— eslint 不能顶替零依赖门禁
//      （lint-gate 的 floating promise 检查 eslint 这套替代不了，删了就少一道闸）；
//   ④ globals 按目录**内联**在 config 里，不引 `globals` 包，也不引任何 eslint 插件 / 共享配置包；
//   ⑤ 两条规则在所有配置段都是 error（WP-36 清完 no-unused-vars 残留后与 no-undef 同档），
//      且 `ignores` 只留真正该忽略的目录——`trial/**` / `tests-fixture/**` 这类不存在的历史目录
//      不许回来（真实夹具在 tests/fixtures，必须被扫描）。
//
// CI（`.github/workflows/verify.yml`）从 1.8.0 WP-35 起**跑** `npx eslint .`（D-4 口径）：
// 它同时跑 `node --check` / `npm test` / `a11y --static`；E2E 与打包冒烟仍只在本地。
// lint-gate 也一直被 CI 强制：`tests/lint-gate.test.js` 在 `npm test` 里 spawn 全仓 lint-gate。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const CONFIG_PATH = path.join(ROOT, 'eslint.config.js');

// 约定规则集：只有这两条（加选项不算新增规则）。
const ALLOWED_RULES = ['no-undef', 'no-unused-vars'];

// 约定扫描范围：core / renderer / ipc / scripts / tests 五个目录 + 两个根文件（ipc 见 WP-34 / D1）。
const CONTRACT_FILES = [
  'core/**/*.js',
  'renderer/**/*.js',
  'ipc/**/*.js',
  'main.js',
  'preload.js',
  'scripts/**/*.js',
  'tests/**/*.js',
];

const readPkg = () => JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));

// eslint.config.js 是 CommonJS（仓库没有 type: module），直接 require 就能拿到 flat config 数组。
const readConfig = () => {
  delete require.cache[require.resolve(CONFIG_PATH)];
  return require(CONFIG_PATH);
};

test('devDependencies.eslint 存在，且是精确版本（不带 ^ / ~ / 范围）', () => {
  const dev = readPkg().devDependencies || {};
  assert.ok(Object.prototype.hasOwnProperty.call(dev, 'eslint'), 'devDependencies 里必须有 eslint');
  assert.match(
    dev.eslint,
    /^\d+\.\d+\.\d+$/,
    `eslint 必须是精确版本（形如 10.14.0），实际写的是「${dev.eslint}」`,
  );
});

test('只新增 eslint 一个 devDependency，没有引入 globals / 插件 / 共享配置包', () => {
  const dev = readPkg().devDependencies || {};
  const keys = Object.keys(dev).sort();
  assert.deepEqual(keys, ['electron', 'electron-builder', 'eslint'], 'devDependencies 只能有这三个');
  // 明确点名：globals 包会让「按目录内联」的约定失效，且多一个可漂移的依赖。
  assert.ok(!Object.prototype.hasOwnProperty.call(dev, 'globals'), 'globals 包不允许，全局名按目录内联');
});

test('eslint.config.js 存在，且启用的规则只有约定规则集', () => {
  const config = readConfig();
  assert.ok(Array.isArray(config), 'eslint.config.js 必须导出 flat config 数组');
  assert.ok(config.length > 0, 'flat config 数组不能为空');

  const ruleNames = new Set();
  for (const entry of config) {
    for (const name of Object.keys(entry.rules || {})) ruleNames.add(name);
  }
  for (const name of ruleNames) {
    assert.ok(
      ALLOWED_RULES.includes(name),
      `规则集只允许 ${ALLOWED_RULES.join(' / ')}，多出了「${name}」`,
    );
  }
  for (const name of ALLOWED_RULES) {
    assert.ok(ruleNames.has(name), `约定规则「${name}」必须在 config 里启用`);
  }
});

test('no-undef 在所有配置段都是 error（CI 的 eslint 步骤才真能拦住未声明名字）', () => {
  const config = readConfig();
  const entries = config.filter((entry) => entry.rules && entry.rules['no-undef'] !== undefined);
  assert.ok(entries.length >= 3, 'no-undef 应覆盖 node / 页面驱动 / renderer 三类配置段');
  for (const entry of entries) {
    const severity = Array.isArray(entry.rules['no-undef']) ? entry.rules['no-undef'][0] : entry.rules['no-undef'];
    assert.equal(severity, 'error', 'no-undef 必须是 error（WARN 会让 CI 静默放行）');
  }
});

// WP-36（D5）：no-unused-vars 从 WARN 升 ERROR。清理掉 68 处声明后，这条规则必须和 no-undef 同档，
// 否则新增的未读声明又会静默过关（WARN 不影响 eslint 退出码）。
test('no-unused-vars 在所有配置段都是 error（WP-36 清完残留后与 no-undef 同档）', () => {
  const config = readConfig();
  const entries = config.filter((entry) => entry.rules && entry.rules['no-unused-vars'] !== undefined);
  assert.ok(entries.length >= 3, 'no-unused-vars 应覆盖 node / 页面驱动 / renderer 三类配置段');
  for (const entry of entries) {
    const severity = Array.isArray(entry.rules['no-unused-vars'])
      ? entry.rules['no-unused-vars'][0]
      : entry.rules['no-unused-vars'];
    assert.equal(severity, 'error', 'no-unused-vars 必须是 error（仍是 WARN 等于没有门禁）');
  }
});

// WP-36（D13）：ignores 里只剩真正会出现在仓库里的目录；不存在的历史目录要清掉，
// 但 tests/fixtures 这类真实夹具必须落在扫描范围里（以前 tests-fixture/** 挡的是历史目录）。
test('eslint ignores 不再残留不存在的目录（D13），真实夹具目录必须被扫描', () => {
  const config = readConfig();
  const ignores = config.flatMap((entry) => [].concat(entry.ignores || []));
  assert.ok(ignores.includes('node_modules/**'), 'node_modules 必须忽略');
  for (const stale of ['trial/**', 'tests-fixture/**']) {
    assert.ok(!ignores.includes(stale), `ignores 里残留不存在的目录「${stale}」`);
  }
  for (const generated of ['dist/**', 'out/**', 'release/**', 'coverage/**', 'shots/**']) {
    assert.ok(ignores.includes(generated), `构建 / 本地证据目录「${generated}」仍应忽略`);
  }
  assert.ok(!ignores.some((pattern) => pattern.startsWith('tests/')), 'tests/ 必须整体扫描（fixtures 在 tests/fixtures）');
});

test('scripts.lint 仍是 node scripts/lint-gate.js（eslint 不能顶替零依赖门禁）', () => {
  const scripts = readPkg().scripts || {};
  assert.equal(scripts.lint, 'node scripts/lint-gate.js', 'scripts.lint 被改了，零依赖 lint 门禁会静默失效');
});

test('eslint.config.js 覆盖约定扫描范围，且 globals 按 node / renderer 两侧内联', () => {
  const config = readConfig();
  const files = [];
  const globalKeys = [];
  for (const entry of config) {
    for (const pattern of [].concat(entry.files || [])) files.push(pattern);
    const globals = (entry.languageOptions && entry.languageOptions.globals) || {};
    globalKeys.push(Object.keys(globals));
  }
  for (const pattern of CONTRACT_FILES) {
    assert.ok(files.includes(pattern), `扫描范围缺了「${pattern}」`);
  }
  const nodeSide = globalKeys.find((keys) => keys.includes('require') && keys.includes('module'));
  assert.ok(nodeSide, 'node 侧 globals 内联 require / module');
  assert.ok(nodeSide.includes('process') && nodeSide.includes('__dirname'), 'node 侧 globals 还缺 process / __dirname');
  const rendererSide = globalKeys.find((keys) => keys.includes('window') && keys.includes('document'));
  assert.ok(rendererSide, 'renderer 侧 globals 内联 window / document');
});
