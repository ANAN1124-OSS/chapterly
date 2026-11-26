// 一键跑端到端自检：独立临时 userData/书库，真实启动 Electron 走一遍主流程。
// 用法：pnpm run e2e
//
// 看门狗 / 回收（1.6.0 H3 / 审计 D1）：
//   · 超时预算 = 180 s + 组数 × 每组预算（组数从 scripts/e2e/groups/index.js 现读，不写死）；
//   · 超时先 dump 已收集的 stdout/stderr，再 `taskkill /PID <pid> /T /F` 杀掉整棵进程树
//     （只 kill 直接子进程会把 Electron 孙进程留在后台，下一轮抢焦点 / 拿旧窗口）；
//   · 成功才删临时目录；失败 / 超时 / 拿不到结果都保留现场并打印路径，供人排查。
// 判定口径都在 scripts/e2e-runner-logic.js 里（纯函数、tests/e2e-runner.test.js 覆盖）。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const logic = require('./e2e-runner-logic');
// CI-F4/F5：杀进程树与 electron-run 共用 scripts/kill-tree.js（taskkill 失败后的 child.kill 兜底可达）。
const { killProcessTree: killTreeShared } = require('./kill-tree');

const root = path.join(__dirname, '..');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const base = path.join(os.tmpdir(), `cw-e2e-${stamp}-${process.pid}`);
const userData = path.join(base, 'userdata');
const books = path.join(base, 'books');
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(books, { recursive: true });
// 码字日历 / 连续天数需要跨天数据：只往临时 userData 的 stats.json 写种子（不碰书库与真实配置）。
// A2-GATE-06：种子的「今天 / 昨天 / 种子月」都按这一只时钟算；时间戳记下来经环境变量传给应用进程，
// 组内断言用同一个时刻重建种子 —— 跨本地午夜 / 跨月时不再两边各取一次「现在」而假红。
const statsSeedNow = new Date();
const { buildSeed } = require('./e2e-stats-seed');
fs.writeFileSync(path.join(userData, 'stats.json'), JSON.stringify(buildSeed(statsSeedNow).stats), 'utf8');

const env = { ...process.env };
env.CW_E2E_STATS_SEED_TS = String(statsSeedNow.getTime());
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

// 视觉断言跳过（发版 2.1.0 的 CI 适配）：hosted runner 无交互式桌面会话，动效 / 主题 / 几何断言必然偏。
// 本地与发版前默认全量（不带这个开关）；CI 设 E2E_SKIP_VISUAL=1，功能与供应链断言照常阻塞。
const skipVisual = process.env.E2E_SKIP_VISUAL === '1' || process.argv.includes('--skip-visual');

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
    `--books-root=${books}`,
    ...(skipVisual ? ['--e2e-skip-visual'] : [])
  ],
  { cwd: root, env }
);

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

let settled = false;

function killProcessTree() {
  // 决策（是否 tree kill / 参数）仍由 e2e-runner-logic 的纯函数给，执行交给共享 helper：
  // Windows 上 taskkill 非 0 时会再补 child.kill（旧实现那条兜底不可达），POSIX 杀进程组。
  killTreeShared(child, { plan: logic.killPlan({ platform: process.platform, pid: child.pid }) });
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

// TOOL-C-04：spawn 失败（可执行文件不可用 / EMFILE 等）只有 'error' 事件，不触发 'close' ——
// 以前只挂 close，进程会挂到看门狗超时才报一句「超时」，掩盖真正的启动失败。
child.on('error', (err) => {
  clearTimeout(timer);
  console.error('[e2e] 启动失败：' + (err && err.message ? err.message : String(err)));
  killProcessTree();
  finish({ ok: false, code: 1, missingResult: true });
});

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
    // 1.6.0 G2：失败条目带现场（detail），PASS 行保持一字不多（逐行基线口径不变）。
    const suffix = item.ok || item.detail === undefined ? '' : ` :: ${JSON.stringify(item.detail)}`;
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${suffix}`);
  }
  console.log('');
  if (result.clipboardSynthetic) {
    console.warn(
      '⚠ 系统剪贴板不可用（工作站可能锁屏/无交互桌面）：本轮用进程内剪贴板校验复制文本逻辑，' +
        '真实剪贴板集成未被验证；解锁后重跑即可走真实剪贴板。'
    );
  }
  // REPO-03：把实测 E2E 项数与文档锚点对一次（以前只剩「README 与验收清单互相对得上」，
  // 没有任何东西证明这个数字是实测值）。只告警、不改文件：同步仍由维护者跑 version-sync --write。
  // 计数口径（T-25 ③）：README / 验收清单里的项数是**机器实测锚点**，只由维护者在完整跑完后用
  // `node scripts/version-sync.js --write --unit <单测实测> --e2e <本处实测>` 同步；这里刻意不自动改
  // 文档、也不在 E2E 里判红——E2E 的职责是跑功能，文档计数失真由每批门禁的 `version-sync --check
  // --unit … --e2e …`（显式传期望值）阻塞。告警保留是为了让「改了断言数量但忘了同步」当场可见。
  const measured = Number(result.checks) || details.length;
  if (measured > 0) {
    try {
      const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
      const anchor = /真实启动 Electron 走 (\d+) 项主流程/.exec(readme);
      if (anchor && Number(anchor[1]) !== measured) {
        console.warn(
          `[e2e] 文档计数与实测不一致：README 写 ${anchor[1]} 项，本轮实测 ${measured} 项。` +
            `同步：node scripts/version-sync.js --write --unit <单测实测> --e2e ${measured}`
        );
      }
    } catch {
      /* 文档读不到不影响自检结果 */
    }
  }
  if (result.ok) {
    const skipped = Number(result.skippedVisual) || 0;
    const note = skipped > 0 ? `（其中 ${skipped} 项视觉断言按 E2E_SKIP_VISUAL 跳过）` : '';
    console.log(`端到端自检通过：${result.checks} 项全部通过${note}。`);
    finish({ ok: true, code: 0 });
    return;
  }
  console.error(`端到端自检失败：${result.error || '未知错误'}`);
  finish({ ok: false, code: 1 });
});