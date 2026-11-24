'use strict';
// CI-F4/F5（2026-11-24 复核补审）：杀进程树的唯一实现。
//
// 两份外壳各写过一份「Windows taskkill /T /F，POSIX 杀进程组」：
//   · scripts/electron-run.js（bench / contrast）—— spawn 成功后直接 return，taskkill 非 0
//     （进程已退 / 权限不足 / pid 失效）时 child.kill() 兜底永远走不到；
//   · scripts/run-e2e.js —— 同样只看「taskkill 有没有 spawn 出来」，spawn 失败才 child.kill()。
// 现在收成一份，并且把「taskkill 明确失败 → 再补一刀 child.kill」做成可达路径。
//
// 约定：子进程在 POSIX 上由调用方以 detached 启动（它是进程组组长），这里杀 -pid。
// afterKill 只做尽力而为，任何一步失败都不抛错打断外壳收尾。
const { spawn } = require('node:child_process');

// 超时收尾后再等这么久还没 close，就按超时失败结算（electron-run 的 force-settle；run-e2e 直接退出）。
const FORCE_SETTLE_MS = 15000;

// 与 scripts/e2e-runner-logic.js 的 killPlan 同口径（这里自带一份默认值，调用方也可传入自己的 plan）。
function buildKillPlan(platform, rawPid) {
  const pid = Number(rawPid);
  const validPid = Number.isFinite(pid) && pid > 0 ? Math.floor(pid) : 0;
  if (!validPid) return { useTreeKill: false, pid: 0, command: '', args: [] };
  if (platform !== 'win32') return { useTreeKill: false, pid: validPid, command: '', args: [] };
  return { useTreeKill: true, pid: validPid, command: 'taskkill', args: ['/pid', String(validPid), '/t', '/f'] };
}

// 返回 { method, fallback, plan }，只用于测试 / 诊断，调用方不必等 taskkill 结束。
// 注入点（单测用）：spawnImpl / kill / groupKill / onFallback。
function killProcessTree(child, options = {}) {
  const {
    platform = process.platform,
    plan = buildKillPlan(platform, child && child.pid),
    spawnImpl = spawn,
    kill = (target, signal) => target.kill(signal),
    groupKill = (pid) => process.kill(-pid, 'SIGKILL'),
    onFallback = () => {}
  } = options || {};
  const result = { method: 'none', fallback: '', plan };
  if (!plan || !plan.pid) return result;
  const fallback = (reason) => {
    result.fallback = reason;
    try {
      onFallback(reason);
    } catch {
      /* 诊断钩子失败不影响收尾 */
    }
    try {
      kill(child, 'SIGKILL');
      result.method = 'child.kill';
    } catch {
      result.method = 'child.kill-failed';
    }
    return result;
  };
  if (!plan.useTreeKill) {
    // POSIX：子进程是 detached 的进程组组长，-pid 才能把 Electron 的 renderer / GPU 一起带走。
    try {
      groupKill(plan.pid);
      result.method = 'process-group';
      return result;
    } catch {
      return fallback('group-kill-failed');
    }
  }
  let killer = null;
  try {
    killer = spawnImpl(plan.command, plan.args, { stdio: 'ignore', windowsHide: true });
  } catch {
    killer = null;
  }
  if (!killer) return fallback('taskkill-spawn-threw');
  killer.on('error', () => fallback('taskkill-spawn-error'));
  killer.on('exit', (code) => {
    // CI-F4/F5 的关键：旧实现 spawn 成功就 return，taskkill 退出码非 0 时 child.kill 不可达。
    // 现在明确失败才补一刀（进程已经退掉时 child.kill 也是安全的）。
    if (code !== 0) fallback(`taskkill-exit-${String(code)}`);
  });
  result.method = 'taskkill';
  return result;
}

module.exports = { FORCE_SETTLE_MS, buildKillPlan, killProcessTree };
