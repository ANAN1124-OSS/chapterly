// E2E 看门狗 / 临时目录回收的**纯决策**（1.6.0 H3 / 审计 D1）——不碰进程、不碰磁盘，只回答
// 「预算是多少 / 这次该不该删临时目录 / 超时要 dump 什么 / 怎么杀进程树」，由 scripts/run-e2e.js
// 直接调用，便于在 Node 里逐条断言（死循环 / 误删现场这类问题不该靠真跑 E2E 撞）。
//
// 现状（1.5.0）：超时只 `child.kill()` —— Windows 上只杀掉 `node scripts/start.js`，
// 真正的 Electron 孙进程继续跑，下一次 E2E 会被单实例窗口抢焦点；成功 / 失败 / 超时三条分支
// 都不删 `cw-e2e-*`，每轮往 %TEMP% 堆一个书库 + userData（实测已堆 9+ 个）。
//
// 判定口径（拿不准时一律保守：宁可留下现场，也不删掉失败证据）：
//   · 预算 = 180 s 打底（启动 / 收尾）+ 每组预算；组数从 scripts/e2e/groups/index.js 现读，
//     不写死 80（1.5.0 实测整轮约 150–200 s，PER_GROUP_MS=2500 给慢机留余量）。
//   · 成功（result.ok === true）才删临时目录；失败 / 超时 / 拿不到结果都保留并打印路径。
//   · 超时先把已经收集到的 stdout/stderr 打出来，再杀整棵进程树（Windows: taskkill /T /F）。

const BASE_TIMEOUT_MS = 180000;
// 每组预算：含该组的真实交互与组间等待（1.5.0 整轮 ~80 组实测 150–200 s，即 2–2.5 s/组）。
const PER_GROUP_MS = 2500;

// 组数 → 总预算。坏值 / 负数 / 非数字一律按 0 组（只给打底的 180 s），绝不因为一个坏入参就不设防。
function timeoutBudgetMs(groupCount) {
  const rounded = Math.floor(Number(groupCount));
  const groups = Number.isFinite(rounded) && rounded > 0 ? rounded : 0;
  return BASE_TIMEOUT_MS + groups * PER_GROUP_MS;
}

// 回收决策：{ remove, reason }。ok 只认严格的 true —— 'yes' / 1 不能当成成功去删证据。
function cleanupDecision(input) {
  const ok = Boolean(input && typeof input === 'object' && input.ok === true);
  if (ok) return { remove: true, reason: 'success' };
  if (input && typeof input === 'object' && input.timedOut === true) return { remove: false, reason: 'timeout' };
  if (input && typeof input === 'object' && input.missingResult === true) return { remove: false, reason: 'no-result' };
  return { remove: false, reason: 'failed' };
}

// 超时 dump：把已经收集到的输出原样打出来（截断交给控制台），空输出也要有明确提示。
function timeoutDumpDecision(input) {
  const stdout = input && typeof input.stdout === 'string' ? input.stdout.trim() : '';
  const stderr = input && typeof input.stderr === 'string' ? input.stderr.trim() : '';
  if (!stdout && !stderr) {
    return { dump: false, text: '[e2e] 超时前没有收集到任何输出（应用可能根本没启动起来）。' };
  }
  const parts = [];
  if (stdout) parts.push(`--- 超时前的 stdout（${stdout.length} 字）---\n${stdout}`);
  if (stderr) parts.push(`--- 超时前的 stderr（${stderr.length} 字）---\n${stderr}`);
  return { dump: true, text: parts.join('\n') };
}

// 进程树 kill 计划：Windows 走 `taskkill /PID <pid> /T /F`（/T 才会连 Electron 孙进程一起杀）；
// 其它平台退回单进程 kill（POSIX 的进程组清理不在本窗口范围）。拿不到合法 pid 就不乱杀。
function killPlan(input) {
  const platform = input && typeof input.platform === 'string' ? input.platform : process.platform;
  const pid = Number(input && input.pid);
  const validPid = Number.isFinite(pid) && pid > 0 ? Math.floor(pid) : 0;
  if (!validPid) return { useTreeKill: false, command: '', args: [] };
  if (platform !== 'win32') return { useTreeKill: false, command: '', args: [] };
  return { useTreeKill: true, command: 'taskkill', args: ['/PID', String(validPid), '/T', '/F'] };
}

module.exports = {
  BASE_TIMEOUT_MS,
  PER_GROUP_MS,
  timeoutBudgetMs,
  cleanupDecision,
  timeoutDumpDecision,
  killPlan
};