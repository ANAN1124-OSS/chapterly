// 启动 Electron。
// 某些宿主环境（例如 DeepSeek Harness 的 shell）会带 ELECTRON_RUN_AS_NODE=1，
// 若不清除，Electron 会退化成纯 Node 运行、require('electron') 拿不到 API。
//
// 审计 X15（v1.8.0 WP-38）：启动链的失败要能看懂、也要如实反映到退出码 ——
//   · 没装依赖（require('electron') 抛 MODULE_NOT_FOUND）：提示先跑 pnpm install，别甩裸栈；
//   · Electron 被信号杀死（close 的 code === null）：以前按 0 退出、调用方以为成功，现在按失败；
//   · 判定逻辑本身在 scripts/start-logic.js（纯函数，tests/wp38-hygiene.test.js 覆盖）。
const { spawn } = require('node:child_process');
const path = require('node:path');
const startLogic = require('./start-logic');

let electronPath;
try {
  electronPath = require('electron');
} catch (err) {
  const hint = startLogic.missingElectronHint(err);
  console.error('[start] 启动 Electron 失败：' + (hint || (err && err.message ? err.message : String(err))));
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const appDir = path.join(__dirname, '..');
const args = [appDir, ...process.argv.slice(2)];

const child = spawn(electronPath, args, { stdio: 'inherit', env });
child.on('close', (code, signal) => {
  if (code === null) {
    console.error(`[start] Electron 没有正常退出${signal ? `（被信号 ${signal} 终止）` : ''}，按失败处理。`);
  }
  process.exit(startLogic.exitCodeFor(code));
});
child.on('error', (err) => {
  console.error('[start] 启动 Electron 失败:', err);
  process.exit(1);
});
