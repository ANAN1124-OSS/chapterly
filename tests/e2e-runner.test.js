// 1.6.0 H3（D1，基建）：E2E 的看门狗与临时目录回收。
//
// 现状：`scripts/run-e2e.js` 超时只 `child.kill()`（在 Windows 上只杀 `node scripts/start.js`，
// Electron 孙进程继续跑）；成功 / 失败 / 超时三条分支都不删 `cw-e2e-*` 临时目录 —— 每跑一轮
// 就往 `%TEMP%` 里堆一个书库 + userData。
//
// 这里钉三块**纯决策**（供 run-e2e.js 直接调用，不再把判定散在回调里）：
//   ① 超时预算 = 180 s + 组数 × 每组预算（组数从 `scripts/e2e/groups/index.js` 读，80 组必须 > 180 s）；
//   ② 回收决策：成功删、失败 / 超时留在现场给人排查；
//   ③ 超时 dump 决策：先把已经收集到的 stdout/stderr 打出来，再结束进程树。
// 另加一条源码闸门：run-e2e.js 必须用这套决策 + 进程树 kill（taskkill /T /F）。
// 真实运行验证（跑完 `D:\Temp\cw-e2e-*` 不新增）在 H3 的门禁里真跑一轮。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const logic = require('../scripts/e2e-runner-logic.js');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

test('超时预算：180 s 打底 + 每组预算，80 组必须明显大于 180 s', () => {
  const base = logic.timeoutBudgetMs(0);
  assert.equal(base, logic.BASE_TIMEOUT_MS, '没有组也要给足 180 s（启动 + 收尾）');
  assert.equal(logic.BASE_TIMEOUT_MS, 180000);
  assert.ok(logic.timeoutBudgetMs(80) > 180000, '80 组不能还停在 180 s');
  assert.ok(logic.timeoutBudgetMs(80) >= 180000 + 80 * logic.PER_GROUP_MS, '每组都要加预算');
  assert.equal(
    logic.timeoutBudgetMs(81) - logic.timeoutBudgetMs(80),
    logic.PER_GROUP_MS,
    '多一组就多一份预算'
  );
  // 坏输入不炸：负数 / 非数字 / undefined 都按 0 组算
  for (const bad of [-5, NaN, undefined, null, 'x', {}]) {
    assert.equal(logic.timeoutBudgetMs(bad), logic.BASE_TIMEOUT_MS, `坏组数 ${String(bad)} 按 0 组`);
  }
});

test('回收决策：成功才删临时目录，失败 / 超时 / 拿不到结果一律留在现场', () => {
  assert.deepEqual(logic.cleanupDecision({ ok: true }), { remove: true, reason: 'success' });
  for (const input of [{ ok: false }, { ok: false, timedOut: true }, { ok: false, missingResult: true }, {}]) {
    const decided = logic.cleanupDecision(input);
    assert.equal(decided.remove, false, `失败现场要保留（${JSON.stringify(input)}）`);
    assert.notEqual(decided.reason, 'success');
  }
  assert.equal(logic.cleanupDecision({ ok: false, timedOut: true }).reason, 'timeout');
  assert.equal(logic.cleanupDecision({ ok: false, missingResult: true }).reason, 'no-result');
  // ok 只认严格的 true：'yes' / 1 这类不能当成成功去删证据
  assert.equal(logic.cleanupDecision({ ok: 'yes' }).remove, false);
  assert.equal(logic.cleanupDecision({ ok: 1 }).remove, false);
});

test('超时 dump：已收集的 stdout / stderr 先打出来，空输出也要有明确提示', () => {
  const both = logic.timeoutDumpDecision({ stdout: 'PASS 一', stderr: 'boom' });
  assert.equal(both.dump, true);
  assert.match(both.text, /PASS 一/);
  assert.match(both.text, /boom/);
  const onlyOut = logic.timeoutDumpDecision({ stdout: 'PASS 二' });
  assert.equal(onlyOut.dump, true);
  assert.match(onlyOut.text, /PASS 二/);
  const empty = logic.timeoutDumpDecision({});
  assert.equal(empty.dump, false);
  assert.match(empty.text, /没有收集到任何输出/, '空输出也要说清楚，不能静默退出');
  // 纯函数：不改入参
  const input = { stdout: 'a', stderr: 'b' };
  const snapshot = JSON.stringify(input);
  logic.timeoutDumpDecision(input);
  assert.equal(JSON.stringify(input), snapshot);
});

test('进程树 kill：Windows 用 taskkill /PID /T /F，其它平台退回单进程 kill', () => {
  const win = logic.killPlan({ platform: 'win32', pid: 4242 });
  assert.equal(win.useTreeKill, true);
  assert.equal(win.command, 'taskkill');
  assert.deepEqual(win.args, ['/PID', '4242', '/T', '/F'], '必须带 /T 才能连 Electron 孙进程一起杀');
  assert.equal(logic.killPlan({ platform: 'linux', pid: 4242 }).useTreeKill, false);
  assert.equal(logic.killPlan({ platform: 'win32', pid: 0 }).useTreeKill, false, '拿不到 pid 就不要乱杀');
  assert.equal(logic.killPlan({ platform: 'win32', pid: 'x' }).useTreeKill, false);
});

test('源码闸门：run-e2e.js 用这套决策 + 进程树 kill + 成功才回收', () => {
  const source = read('scripts/run-e2e.js');
  for (const name of ['timeoutBudgetMs', 'cleanupDecision', 'timeoutDumpDecision', 'killPlan']) {
    assert.match(source, new RegExp(`logic\\.${name}\\(`), `run-e2e.js 没有用 logic.${name}`);
  }
  assert.match(source, /killProcessTree\(/, '超时不能只 child.kill()，要杀整棵进程树');
  assert.match(source, /rmSync\(/, '成功后要删掉临时目录');
  assert.match(source, /groups\/index|e2e\/groups/, '组数要从 scripts/e2e/groups/index.js 读');
  // 组数来源必须真的是索引文件，不能写死 80
  assert.equal(/timeoutBudgetMs\(\s*80\s*\)/.test(source), false, '不要写死组数');
});