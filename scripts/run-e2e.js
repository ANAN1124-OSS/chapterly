// 一键跑端到端自检：独立临时 userData/书库，真实启动 Electron 走一遍主流程。
// 用法：pnpm run e2e
//
// 看门狗 / 回收（1.6.0 H3 / 审计 D1）：
//   · 超时预算 = 180 s + 组数 × 每组预算（组数从 scripts/e2e/groups/index.js 现读，不写死）；
//   · 超时先 dump 已收集的 stdout/stderr，再 `taskkill /PID <pid> /T /F` 杀掉整棵进程树
//     （只 kill 直接子进程会把 Electron 孙进程留在后台，下一轮抢焦点 / 拿旧窗口）；
//   · 成功才删临时目录；失败 / 超时 / 拿不到结果都保留现场并打印路径，供人排查。
// 判定口径都在 scripts/e2e-runner-logic.js 里（纯函数、tests/e2e-runner.test.js 覆盖）。
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const logic = require('./e2e-runner-logic');

const root = path.join(__dirname, '..');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const base = path.join(os.tmpdir(), `cw-e2e-${stamp}-${process.pid}`);
const userData = path.join(base, 'userdata');
const books = path.join(base, 'books');
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(books, { recursive: true });
// 码字日历 / 连续天数需要跨天数据：只往临时 userData 的 stats.json 写种子（不碰书库与真实配置）。
const { buildSeed } = require('./e2e-stats-seed');
fs.writeFileSync(path.join(userData, 'stats.json'), JSON.stringify(buildSeed().stats), 'utf8');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

// 组数从索引里现读：加组 / 删组后预算自动跟着走，不写死 80。
const { groups } = require('./e2e/groups/index.js');
const groupCount = groups.length;
const budgetMs = logic.timeoutBudgetMs(groupCount);

const child = spawn(
  process.execPath,
  [
    path.join(root, 'scripts', 'start.js'),
    '--e2e',
    `--user-data=${userData}`,
    `--books-root=${books}`
  ],
  { cwd: root, env }
);

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

let settled = false;

function killProcessTree() {
  const plan = logic.killPlan({ platform: process.platform, pid: child.pid });
  if (plan.useTreeKill) {
    try {
      spawnSync(plan.command, plan.args, { stdio: 'ignore' });
    } catch {
      /* taskkill 不在 PATH 之类：下面的 child.kill 兜底 */
    }
    return;
  }
  try {
    child.kill();
  } catch {
    /* 已经退出 */
  }
}

// 统一收尾：成功删临时目录；失败 / 超时 / 拿不到结果留在现场并打印路径（不要删掉失败证据）。
function finish({ ok, code = 0, timedOut = false, missingResult = false }) {
  if (settled) return;
  settled = true;
  const decision = logic.cleanupDecision({ ok, timedOut, missingResult });
  if (decision.remove) {
    try {
      fs.rmSync(base, { recursive: true, force: true });
      console.log('临时目录已回收（成功跑完）。');
    } catch (err) {
      console.error(`[e2e] 临时目录回收失败：${err.message}（路径 ${base}）`);
    }
  } else {
    console.error(`[e2e] 临时目录保留（${decision.reason}，供排查）：${base}`);
  }
  process.exit(ok ? 0 : code || 1);
}

const timer = setTimeout(() => {
  const dump = logic.timeoutDumpDecision({ stdout, stderr });
  console.error(
    `[e2e] 超时（预算 ${Math.round(budgetMs / 1000)} 秒 = ${logic.BASE_TIMEOUT_MS / 1000} 秒 + ` +
      `${groupCount} 组 × ${logic.PER_GROUP_MS / 1000} 秒），结束整棵进程树`
  );
  // 超时也要把已经跑出来的 PASS/FAIL 与报错打全，否则只看到一行「超时」。
  console.error(dump.text);
  killProcessTree();
  finish({ ok: false, code: 1, timedOut: true });
}, budgetMs);
timer.unref();

child.on('close', (code) => {
  clearTimeout(timer);
  const match = stdout.match(/E2E_RESULT (.+)/);
  if (!match) {
    console.error('[e2e] 没有拿到结果，应用可能启动失败。');
    console.error(stdout.trim());
    console.error(stderr.trim());
    finish({ ok: false, code: code || 1, missingResult: true });
    return;
  }
  let result;
  try {
    result = JSON.parse(match[1]);
  } catch {
    console.error('[e2e] 结果 JSON 解析失败：', match[1]);
    finish({ ok: false, code: 1 });
    return;
  }
  const details = result.details || [];
  for (const item of details) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}`);
  }
  console.log('');
  if (result.clipboardSynthetic) {
    console.warn(
      '⚠ 系统剪贴板不可用（工作站可能锁屏/无交互桌面）：本轮用进程内剪贴板校验复制文本逻辑，' +
        '真实剪贴板集成未被验证；解锁后重跑即可走真实剪贴板。'
    );
  }
  if (result.ok) {
    console.log(`端到端自检通过：${result.checks} 项全部通过。`);
    finish({ ok: true, code: 0 });
    return;
  }
  console.error(`端到端自检失败：${result.error || '未知错误'}`);
  finish({ ok: false, code: 1 });
});