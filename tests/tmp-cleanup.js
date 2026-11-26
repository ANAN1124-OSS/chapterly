'use strict';
// 测试临时目录回收（只删本进程在系统临时目录里 mkdtemp 出来的目录）。
//
// 为什么需要：node --test 每个测试文件一个进程，测试里 mkdtemp 出来的书库 / 夹具
// 默认没人删——D:\Temp 曾被单测残留堆到 125 GB（其中 importer 的「超大书.txt」
// 每个测试进程一份 128 MB 实占假文件）。删自己的临时目录是测试的既有惯例
// （logs / stats / storage 等文件本来就是这么做的），这里只是把它收成一处。
//
// 边界（与项目「删除动作不进产品代码 / 自检脚本」的口径一致）：
//   * 只处理 os.tmpdir() 下的路径，不碰真实书库；
//   * 只在进程退出时同步删，尽力而为，删不掉不掩测试结果；
//   * 测试只能 track 自己刚建的目录。
// A2-GATE-04（2026-11-26 审计）：正常退出才走 'exit' —— 被 kill / 超时 / Ctrl+C 打断的进程不保证
// 执行，D:\Temp 曾堆到 674 个 cw-* / 879 MB。这里补一个只读名字 + 只删超龄的 sweep（入口在
// scripts/run-tests.js 与 scripts/run-e2e.js 启动时各跑一次），不动 24 小时内的目录（可能是别的
// 进程正在用的）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dirs = [];
let installed = false;
// 只有本应用 / 自检会用的前缀；不认其它临时目录。
const SWEEP_PREFIX = 'cw-';
const STALE_TMP_MS = 24 * 60 * 60 * 1000;

function install() {
  if (installed) return;
  installed = true;
  process.on('exit', () => {
    const tmpRoot = path.resolve(os.tmpdir()) + path.sep;
    for (const dir of dirs.splice(0)) {
      try {
        const resolved = path.resolve(dir);
        if (!resolved.startsWith(tmpRoot)) continue;
        fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        /* 退出阶段尽力而为，删不掉不影响测试结果 */
      }
    }
  });
}

// 超龄临时目录 sweep：只删「root 的直接子目录 + cw- 前缀 + 目录 mtime 超过 maxAgeMs」。
// 不递归找、不跟随符号链接（lstat）；删不掉静默跳过。root 只给单测注入（产品入口传空 = os.tmpdir()）。
function sweepStale(root, options = {}) {
  const base = path.resolve(root || os.tmpdir());
  const rawAge = Number(options.maxAgeMs);
  const maxAgeMs = Number.isFinite(rawAge) && rawAge >= 0 ? rawAge : STALE_TMP_MS;
  const rawNow = Number(options.now);
  const nowMs = Number.isFinite(rawNow) && rawNow > 0 ? rawNow : Date.now();
  let names = [];
  try {
    names = fs.readdirSync(base);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    if (!String(name).startsWith(SWEEP_PREFIX)) continue;
    const full = path.join(base, name);
    let stat = null;
    try {
      stat = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue; // 目录联接 / 符号链接一律不碰（lstat 口径）
    if (!stat.isDirectory()) continue; // 普通文件都不碰
    if (nowMs - Number(stat.mtimeMs) < maxAgeMs) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed.push(name);
    } catch {
      /* 尽力而为：正在被占用 / 没权限就留给下一轮 */
    }
  }
  return removed;
}

function track(dir) {
  install();
  dirs.push(dir);
  return dir;
}

// TB-02：临时目录的唯一入口。测试文件以前各自复制一份「mkdtemp + track」，49 份实现 / 签名不一；
// 现在统一 `mkTmp(prefix)` / `mkTmpSync(prefix)`（默认前缀仍可由调用方给），并保证登记回收。
async function mkTmp(prefix = 'cw-test-') {
  return track(await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix)));
}

function mkTmpSync(prefix = 'cw-test-') {
  return track(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

module.exports = { track, mkTmp, mkTmpSync, sweepStale, SWEEP_PREFIX, STALE_TMP_MS };
