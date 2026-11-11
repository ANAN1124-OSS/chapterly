'use strict';
// 1.6.0 G1：零依赖 lint 门禁（`scripts/lint-gate.js` + `scripts/lint-gate-logic.js`）的锚点。
//
// 这张卡要拦住三类会「静默出错」的写法，而仓库里没有 eslint / 也不加 devDependency：
//   ① floating promise —— 语句级调用 async 函数却没人 await / return / .catch（未处理的 rejection 会变成
//      unhandledRejection：保存失败没人报错、UI 停在旧状态）；
//   ② 未使用变量 —— 函数里声明了再也没人读（重构残留，读代码时误导人）；
//   ③ 未定义引用 —— 名字没声明也不在白名单（真跑起来就是 ReferenceError，静态就该拦下）。
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

test('未使用变量：函数内声明零引用报 WARN（不挡门禁）；被引用 / 下划线前缀 / 只在模板 ${} 里被引用都不报', () => {
  const source = [
    'function f() {',
    '  const unused = 1;',
    '  const used = 2;',
    '  const _ignored = 3;',
    '  const inTemplate = 4;',
    '  return used + `值 ${inTemplate}`;',
    '}',
    ''
  ].join('\n');
  const found = only(lint(source), logic.RULES.UNUSED_VARIABLE);
  assert.equal(found.length, 1, `只该报 unused 那一条：${JSON.stringify(found)}`);
  assert.equal(found[0].severity, 'WARN', '未用变量是存量风格问题，先记 WARN');
  assert.equal(found[0].line, lineOf(source, '  const unused = 1;'));
  assert.match(found[0].message, /unused/);
});

test('未使用变量：只在字符串里出现不算引用；同一行多个声明按逗号拆开', () => {
  const source = [
    'function f() {',
    '  const onlyInString = 1;',
    '  const unusedA = 2, usedB = 3;',
    '  return usedB + "onlyInString unusedA";',
    '}',
    ''
  ].join('\n');
  const found = only(lint(source), logic.RULES.UNUSED_VARIABLE).map((f) => f.message);
  assert.equal(found.length, 2, `onlyInString 与 unusedA 都该报：${JSON.stringify(found)}`);
  assert.ok(found.some((m) => /onlyInString/.test(m)));
  assert.ok(found.some((m) => /unusedA/.test(m)));
  assert.ok(!found.some((m) => /usedB/.test(m)));
});

test('未定义引用：没声明也没进白名单的名字报 ERROR；声明 / 参数 / 已知全局 / 属性名 / 方法定义都不报', () => {
  const source = [
    'function f(arg) {',
    '  const local = 1;',
    '  missingThing(local);',
    '  const o = { prop: arg };',
    '  console.log(o.prop, local, process.pid, Math.max(1, 2));',
    '  return o.prop;',
    '}',
    'const ui = {',
    '  create() { return 1; },',
    '  refresh() { return this.create(); }',
    '};',
    'class Panel {',
    '  render() { return ui.refresh() + this.constructor.length; }',
    '}',
    ''
  ].join('\n');
  const found = only(lint(source), logic.RULES.UNDEFINED_REF);
  assert.equal(found.length, 1, `只该报 missingThing：${JSON.stringify(found)}`);
  assert.equal(found[0].severity, 'ERROR');
  assert.equal(found[0].line, lineOf(source, '  missingThing(local);'));
  assert.match(found[0].message, /missingThing/);
});

test('未定义引用：字符串 / 注释 / 正则字面量里的文本不算引用', () => {
  const source = [
    '// missingThing();',
    'const text = "missingThing()";',
    'const re = /missingThing\\(/;',
    'const re2 = /[A-Z]+/g;',
    ''
  ].join('\n');
  const found = only(lint(source), logic.RULES.UNDEFINED_REF);
  assert.deepEqual(found, [], `只读文本里出现不算：${JSON.stringify(found)}`);
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

test('未使用变量：展开（...rows）里的名字算读过，别把 set 一类的数据源误报成死变量', () => {
  const source = [
    'function f() {',
    '  const rows = [1, 2];',
    '  return [...rows].join(",");',
    '}',
    ''
  ].join('\n');
  assert.deepEqual(only(lint(source), logic.RULES.UNUSED_VARIABLE), []);
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
});