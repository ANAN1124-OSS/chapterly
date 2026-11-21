'use strict';
// 1.6.0 G1：零依赖 lint 门禁（`scripts/lint-gate.js` + `scripts/lint-gate-logic.js`）的锚点。
//
// 卡片只管 ESLint 替代不了的那一条：
//   ① floating promise —— 语句级调用 async 函数却没人 await / return / .catch（未处理的 rejection 会变成
//      unhandledRejection：保存失败没人报错、UI 停在旧状态）。
// 审计修复 #53（R6）：undefined-ref / unused-variable 已删 —— 与 eslint 的 no-undef / no-unused-vars
// （均 error、扫描范围相同）逐项重叠，两套全局白名单只会互相漂移；没声明的名字 / 死变量由 `npx eslint .`
// 负责（tests/eslint-config.test.js 钉住那两条仍是 error）。
//
// 判定口径刻意保守（宁可漏报不可误报）：只认**同文件里能证明是 async** 的函数名、只认语句级调用；
// 字符串 / 注释 / 模板字面量里的文本一律不算；正则字面量按「代码里出现」处理时也要遮掉。
//
// 这些用例先于实现写：首跑必须是 `Cannot find module ... lint-gate-logic.js`（RED），
// 实现后转绿；脚本本身对当前仓库必须 0 ERROR（WARN 允许存在并打印出来）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const logic = require('../scripts/lint-gate-logic.js');

const lint = (source, opts = {}) => logic.lintSource(source, { file: 'x.js', ...opts });
const only = (findings, rule) => findings.filter((f) => f.rule === rule);
const lineOf = (source, needle) => source.slice(0, source.indexOf(needle)).split('\n').length;

test('调度面收成单条：RULES 只剩 floating-promise（R6）', () => {
  assert.deepEqual(Object.keys(logic.RULES), ['FLOATING_PROMISE']);
  assert.equal(logic.RULES.FLOATING_PROMISE, 'floating-promise');
  // 重叠规则的实现不许再留着（防止「删了规则名、函数还在跑」的假瘦身）
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'lint-gate-logic.js'), 'utf8');
  assert.equal(/checkUnusedVariables|checkUndefinedRefs|KNOWN_GLOBALS/.test(source), false);
});

test('floating promise：语句级 async 调用报 ERROR；await / return / void / .catch / .finally / 赋值 / 传参都算已处理', () => {
  const source = [
    'async function save() { return 1; }',
    'async function run() {',
    '  save();',
    '  await save();',
    '  return save();',
    '  void save();',
    '  save().catch(() => {});',
    '  save().finally(() => {});',
    '  const p = save();',
    '  console.log(save());',
    '}',
    ''
  ].join('\n');
  const found = only(lint(source), logic.RULES.FLOATING_PROMISE);
  assert.equal(found.length, 1, `只该报第 3 行那一处：${JSON.stringify(found)}`);
  assert.equal(found[0].severity, 'ERROR');
  assert.equal(found[0].line, lineOf(source, '  save();'));
  assert.match(found[0].message, /save/);
});

test('floating promise：字符串、注释、模板字面量里的文本不算调用；未声明的 async 名字也不乱报', () => {
  const source = [
    'async function save() { return 1; }',
    '// save();',
    '/* save(); */',
    "const text = 'save(); save();';",
    'const tpl = `save(); ${text}`;',
    'const other = 1;',
    ''
  ].join('\n');
  const found = only(lint(source), logic.RULES.FLOATING_PROMISE);
  assert.deepEqual(found, [], `字符串 / 注释不算：${JSON.stringify(found)}`);
});

test('floating promise：同步回调里没法 await → 只报 WARN；能 await 的 async 函数体内才 ERROR', () => {
  const source = [
    'async function refresh() { return 1; }',
    'function onClick() {',
    '  refresh();',
    '}',
    'async function run() {',
    '  refresh();',
    '}',
    ''
  ].join('\n');
  const found = only(lint(source), logic.RULES.FLOATING_PROMISE);
  assert.equal(found.length, 2, `两处都该报：${JSON.stringify(found)}`);
  assert.deepEqual(found.map((f) => f.severity).sort(), ['ERROR', 'WARN']);
  const error = found.find((f) => f.severity === 'ERROR');
  const runAt = source.indexOf('async function run() {');
  const expectedLine = source.slice(0, runAt).split('\n').length + 1;
  assert.equal(error.line, expectedLine, 'async 函数体内那一处才是 ERROR');
});

test('退出码：有 ERROR 退出 1，只有 WARN / 没问题退出 0', () => {
  assert.equal(logic.exitCodeFor([{ rule: 'x', severity: 'ERROR' }]), 1);
  assert.equal(logic.exitCodeFor([{ rule: 'x', severity: 'WARN' }]), 0);
  assert.equal(logic.exitCodeFor([]), 0);
});

test('已纳入门禁：package.json 登记 npm run lint，脚本对当前仓库 0 ERROR（WARN 记录在案）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.lint, 'node scripts/lint-gate.js');

  const res = spawnSync(process.execPath, ['scripts/lint-gate.js', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000
  });
  assert.equal(res.status, 0, `lint-gate 退出码应为 0：stdout=${res.stdout}\nstderr=${res.stderr}`);
  const report = JSON.parse(res.stdout);
  assert.equal(report.errorCount, 0, `当前仓库不许有 lint ERROR：${JSON.stringify(report.findings)}`);
  assert.ok(report.fileCount > 250, `扫描面太小（只扫了 ${report.fileCount} 个文件），门禁等于没开`);
  assert.ok(Array.isArray(report.findings));
  assert.equal(report.findings.length, report.errorCount + report.warnCount);
  assert.ok(report.findings.every((f) => f.rule === 'floating-promise'), '门禁只剩 floating-promise 一条规则');
});
// TOOL-A01（第五轮审计）：扫描目录读不了 / 文件清单缺项 / 文件数低于下限时必须报错退 2，
// 绝不允许输出「0 个 js / 0 ERROR（通过）」的假绿。
test('TOOL-A01：扫描面残缺（目录缺失 / 下限不足）→ 明确报错，不许静默通过', () => {
  const lintGate = require('../scripts/lint-gate.js');
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-lint-scan-'));
  try {
    assert.throws(() => lintGate.collectFiles(tmp), /扫描目录读不了/, '缺 core 等扫描目录要报错');
    // 目录齐全但没有任何 js（main.js / preload.js 也缺）→ 先报缺文件；补上空文件后报下限不足
    for (const dir of lintGate.SCAN_DIRS) fs.mkdirSync(path.join(tmp, dir), { recursive: true });
    assert.throws(() => lintGate.collectFiles(tmp), /扫描文件不存在/, 'main.js / preload.js 缺了要报错');
    for (const file of lintGate.SCAN_FILES) fs.writeFileSync(path.join(tmp, file), '', 'utf8');
    assert.throws(() => lintGate.collectFiles(tmp), /扫描面残缺/, '只找到 2 个文件必须判残缺');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // 真仓库照旧通过，且文件数不低于下限
  const files = lintGate.collectFiles(ROOT);
  assert.ok(files.length >= lintGate.MIN_SCAN_FILES, `真仓库扫描数 ${files.length} 不许低于下限`);
});
