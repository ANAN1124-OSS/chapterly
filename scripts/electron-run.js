'use strict';
// 自动化外壳（scripts/bench.js / scripts/contrast.js）启动 Electron 与超时收尾的共享实现。
//
// TOOL-BX-01（含 round2 TOOL-B01，两轮独立证实）：
//   以前外壳 spawn 的是 `node scripts/start.js` 包装层，start.js 再以 stdio:'inherit' 启动
//   真正的 Electron。超时只 child.kill() 包装层（Windows 上等价 TerminateProcess），Electron
//   主进程 + renderer/GPU 子进程全部存活为孤儿，并继续持有 stdout 管道写端；Node 的 close
//   事件以 stdio 全部关闭为前提，于是外壳要么无限挂起、要么等孤儿把整套基准跑完才 close，
//   把一次超时吞成「成功」。这里做四件事：
//     1. 直接 spawn 真正的 Electron 可执行文件（少一层转发，kill 目标就是被测进程本身）；
//     2. 超时杀整棵进程树（Windows: taskkill /T /F；POSIX: 进程组 SIGKILL），让管道写端全关；
//     3. stdio 一律按 UTF-8 流式解码（TOOL-BX-03：按 chunk 独立 toString 会切开多字节中文）；
//     4. timedOut / code 原样带出，调用方必须先判超时与退出码（TOOL-BX-04），再接受 marker。
//
// 为什么不用 require('electron')：scripts/ 只存在于开发版（安装包不含），但本模块要能按
// electron 包自己发布的 path.txt 找到二进制，并给出「先 pnpm install」的可读提示
// （scripts/start-logic.js 同一份文案口径）。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const startLogic = require('./start-logic');

const ROOT = path.join(__dirname, '..');
// 超时后即使 close 迟迟不来（任务管理器拒绝 / 权限异常），也不让外壳永久挂起：
// 再等这么久就按超时失败结算，把控制权交回调用方。
const FORCE_SETTLE_MS = 15000;

// root 可注入（默认仓库根）：单测用临时夹具钉「依赖未装 / 二进制未下载」两种提示契约——
// CI 以 ELECTRON_SKIP_BINARY_DOWNLOAD=1 安装，node_modules/electron 里可能既没有 path.txt
// 也没有 dist，「开发机已装好」不能被测试当成唯一形态（首版测试因此在 CI 假红）。
function electronBinary(root = ROOT) {
  const pkgDir = path.join(root, 'node_modules', 'electron');
  const pathFile = path.join(pkgDir, 'path.txt');
  let rel = '';
  try {
    rel = fs.readFileSync(pathFile, 'utf8').trim();
  } catch {
    rel = '';
  }
  if (!rel) {
    const hint = startLogic.missingElectronHint({ code: 'MODULE_NOT_FOUND' });
    throw new Error(hint || '找不到 node_modules/electron/path.txt：依赖没有装好。');
  }
  const binary = path.join(pkgDir, 'dist', rel);
  if (!fs.existsSync(binary)) {
    throw new Error(`Electron 可执行文件不存在：${binary}（重新执行 pnpm install 可修复）。`);
  }
  return binary;
}

// 杀掉整棵进程树（含 Electron 的 renderer / GPU 子进程）。
// Windows 用 taskkill /T /F；POSIX 用进程组（runProcess 在 POSIX 上以 detached 启动，
// 子进程即组长）。任何一步失败都退回 child.kill()，绝不因此抛错打断外壳收尾。
function killProcessTree(child) {
  if (!child || typeof child.pid !== 'number') return;
  if (process.platform === 'win32') {
    let killer = null;
    try {
      killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true
      });
      killer.on('error', () => {});
    } catch {
      killer = null;
    }
    if (killer) return;
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      /* 退回单进程 kill */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* 忽略：进程可能已经退出 */
  }
}

// 跑一个子进程并收集输出；超时杀整棵进程树。
// 返回 { code, signal, stdout, stderr, timedOut, spawnError, settledBy }。
//   · settledBy = 'close' | 'timeout-force'，便于调用方在日志里说明「为什么没有 close」。
function runProcess(binary, args, options = {}) {
  const {
    timeout = 300000,
    cwd = ROOT,
    env = process.env,
    settleGraceMs = FORCE_SETTLE_MS
  } = options || {};
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let spawnError = null;
    let forceTimer = null;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      resolve(result);
    };
    const childEnv = { ...env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    delete childEnv.ELECTRON_NO_ATTACH_CONSOLE;
    let child = null;
    try {
      child = spawn(binary, args, {
        cwd,
        env: childEnv,
        // POSIX：独立进程组，超时才能一次杀掉 Electron 的整棵树。
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (err) {
      finish({ code: 1, signal: null, stdout: '', stderr: String((err && err.message) || err), timedOut, spawnError: err || true, settledBy: 'spawn-error' });
      return;
    }
    // TOOL-BX-03：setEncoding 让 Node 的 StringDecoder 跨 chunk 续接多字节字符，
    // 中文 marker / 场景名被管道边界切开也不会变成 U+FFFD。
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      forceTimer = setTimeout(() => {
        finish({
          code: null,
          signal: null,
          stdout,
          stderr,
          timedOut,
          spawnError,
          settledBy: 'timeout-force'
        });
      }, Math.max(1000, Number(settleGraceMs) || FORCE_SETTLE_MS));
      if (forceTimer.unref) forceTimer.unref();
    }, Math.max(1, Number(timeout) || 1));
    if (timer.unref) timer.unref();
    child.on('close', (code, signal) => {
      finish({
        code: typeof code === 'number' ? code : null,
        signal: signal || null,
        stdout,
        stderr,
        timedOut,
        spawnError,
        settledBy: 'close'
      });
    });
    child.on('error', (err) => {
      // 启动失败（ENOENT 等）：close 通常随后到来；这里只记下原因，结算交给 close / 兜底。
      stderr += `\n${(err && err.message) || err}`;
      spawnError = spawnError || err || true;
    });
  });
}

// 跑真正的 Electron：`electron.exe <appDir> <args...>`（与 scripts/start.js 的参数口径一致）。
function runElectron(args, options = {}) {
  let binary;
  try {
    binary = electronBinary();
  } catch (err) {
    return Promise.resolve({
      code: 1,
      signal: null,
      stdout: '',
      stderr: String((err && err.message) || err),
      timedOut: false,
      spawnError: err || true,
      settledBy: 'spawn-error'
    });
  }
  return runProcess(binary, [ROOT, ...args], options);
}

module.exports = { ROOT, electronBinary, killProcessTree, runProcess, runElectron };
