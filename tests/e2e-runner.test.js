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
// CI-F4/F5（2026-11-24 复核补审）：杀进程树收成 scripts/kill-tree.js 一份。
// 旧实现两份外壳都「taskkill 起得来就直接 return」—— 退出码非 0（进程已退 / 权限不足 / pid 失效）
// 时 child.kill 兜底永远走不到。这里逐条钉住兜底真的可达。
test('CI-F4/F5：kill-tree 的 taskkill 失败兜底可达，POSIX 走进程组，两处外壳共用', () => {
  const { EventEmitter } = require('node:events');
  const killTree = require('../scripts/kill-tree');
  const makeChild = () => {
    const calls = [];
    return { pid: 4242, calls, kill(signal) { calls.push(signal); return true; } };
  };

  // ① taskkill 根本起不来 → child.kill 兜底
  const spawnThrows = makeChild();
  const r1 = killTree.killProcessTree(spawnThrows, {
    platform: 'win32',
    spawnImpl: () => { throw new Error('taskkill 不在 PATH'); }
  });
  assert.equal(r1.method, 'child.kill');
  assert.equal(r1.fallback, 'taskkill-spawn-threw');
  assert.deepEqual(spawnThrows.calls, ['SIGKILL']);

  // ② taskkill 起得来但退出码非 0 → 旧实现不可达的 child.kill 必须执行
  const emitter = new EventEmitter();
  const exitNonZero = makeChild();
  const r2 = killTree.killProcessTree(exitNonZero, { platform: 'win32', spawnImpl: () => emitter });
  assert.equal(r2.method, 'taskkill', '同步返回时先派 taskkill');
  emitter.emit('exit', 1);
  assert.equal(r2.fallback, 'taskkill-exit-1', 'taskkill 非 0 要记下兜底原因');
  assert.deepEqual(exitNonZero.calls, ['SIGKILL']);

  // ③ taskkill 成功（0）→ 不补刀
  const okEmitter = new EventEmitter();
  const okChild = makeChild();
  killTree.killProcessTree(okChild, { platform: 'win32', spawnImpl: () => okEmitter });
  okEmitter.emit('exit', 0);
  assert.deepEqual(okChild.calls, [], 'taskkill 成功时不该再补 kill');

  // ④ POSIX：先杀 detached 进程组；组杀失败退回 child.kill
  const groupCalls = [];
  const posix = makeChild();
  const r4 = killTree.killProcessTree(posix, { platform: 'linux', groupKill: (pid) => groupCalls.push(pid) });
  assert.equal(r4.method, 'process-group');
  assert.deepEqual(groupCalls, [4242]);
  const posixFail = makeChild();
  const r5 = killTree.killProcessTree(posixFail, { platform: 'linux', groupKill: () => { throw new Error('ESRCH'); } });
  assert.equal(r5.method, 'child.kill');
  assert.deepEqual(posixFail.calls, ['SIGKILL']);

  // ⑤ 两处外壳共用同一份实现，且不再自己拼 taskkill
  for (const rel of ['scripts/run-e2e.js', 'scripts/electron-run.js']) {
    const src = read(rel);
    assert.match(src, /require\('\.\/kill-tree'\)/, rel + ' 必须用共享 kill-tree');
    assert.match(src, /killProcessTree\(/, rel + ' 仍要真的杀进程树');
    assert.equal(/spawn(Sync)?\(\s*'taskkill'/.test(src), false, rel + ' 不许再自己起 taskkill');
    assert.equal(/spawnSync\(plan\.command/.test(src), false, rel + ' 不许再自己 spawnSync kill 计划');
  }
  assert.equal((read('scripts/kill-tree.js').match(/taskkill/g) || []).length >= 1, true);
});

// A2-GATE-06（测试闸门）：码字日历 / 连续天数的统计种子在应用启动前按「写盘那一刻」的本地日期写盘，
// 而第 44 组断言时以前又用 new Date() 重建一份种子 —— 跑一轮跨过本地午夜（概率 ≈ 运行时长 / 86400）
// 后「昨天 / 种子月」整体位移，streak 与日历断言必然假红，与产品行为无关。
// 现在时间戳只取一次：run-e2e 写盘时取，经环境变量交给应用进程，组内断言用同一个时刻重建种子；
// 「今天 / 本月」这类产品侧断言改用产品此刻的本地日期（跨天后可以和种子写盘那天不是同一天）。
test('A2-GATE-06：统计种子时间戳只有一个来源，跨午夜不再两边各取「现在」', () => {
  const runner = read('scripts/run-e2e.js');
  assert.match(runner, /const statsSeedNow = new Date\(\);/, 'run-e2e 写盘前先取一次种子时间');
  assert.match(runner, /buildSeed\(statsSeedNow\)/, '写盘必须用这个时间戳');
  assert.match(
    runner,
    /env\.CW_E2E_STATS_SEED_TS = String\(statsSeedNow\.getTime\(\)\)/,
    '同一时间戳要交给应用进程（组内断言用）'
  );

  const scenario = read('scripts/e2e-scenario.js');
  assert.match(scenario, /process\.env\.CW_E2E_STATS_SEED_TS/, 'harness 要读回种子时间戳');
  assert.match(scenario, /\bstatsSeedNow,/, 'groupContext 要把种子时间戳交给组');

  const group = read('scripts/e2e/groups/44-stats-goal.js');
  assert.match(group, /statsSeedLib\.buildSeed\(statsSeedNow/, '组内用种子时间戳重建种子');
  assert.equal(/buildSeed\(\)/.test(group), false, '组内不许再出现无参数（= 现在）的 buildSeed');
  assert.match(group, /const todayKeyNow = statsLib\.localDayKey\(new Date\(\)\)/, '「今天」用产品此刻的本地日期');
  assert.match(group, /calendarNow\.today === todayKeyNow/, '产品今天 = 当前本地日期');
  assert.equal(/calendarNow\.today === calendarSeed\.todayKey/.test(group), false, '种子写盘那天不许冒充产品今天');

  // 行为面：同一个时间戳重建的种子必须逐字段相同（写盘那份与断言那份是同一份）。
  const seedLib = require('../scripts/e2e-stats-seed');
  const at = new Date(2026, 0, 1, 23, 59, 30);
  assert.deepEqual(seedLib.buildSeed(at), seedLib.buildSeed(at), '同一时刻重建 = 同一份种子');
  const nextDay = seedLib.buildSeed(new Date(2026, 0, 2, 0, 0, 30));
  assert.notEqual(nextDay.todayKey, seedLib.buildSeed(at).todayKey, '跨午夜后「现在」已是另一天（旧实现的假红来源）');
});
