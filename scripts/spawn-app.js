'use strict';
// bench.js / contrast.js 共用的 Electron 自动化外壳（TOOL-B04）。
//
// 起因（审计）：两个审计工具是同一套骨架起稿的——启动 Electron、收 stdout/stderr、解析
// 结果 marker、写报告、时间戳 / 机器信息 / 临时根闸门逐字节各一份（约 120 行）。TOOL-BX-01
// 的超时缺陷当时就必须两处各修一遍，漏一处即行为分叉；TOOL-BX-02/03/04 同理。这里把
// 「与工具语义无关」的部分收成一份代码：以后新增第三种自动化（如 a11y 走查）直接复用。
//
// 边界：只被 scripts/ 下的开发脚本 require，不进安装包；不 require electron（走 electron-run
// 按 node_modules/electron/path.txt 找二进制），不删文件，不联网。
const os = require('node:os');
const path = require('node:path');
const electronRun = require('./electron-run');

const ROOT = path.join(__dirname, '..');

// 报告文件名里用的时间戳：20261122013045（本地时区的 ISO 去掉分隔符，取到秒）。
function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

// child 是否在 parent 里（按路径段判断，`D:\\tmp\\a` 不算在 `D:\\tmp\\ab` 里）。
function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// 只许在系统临时目录里造书库：传进来的临时根必须落在 os.tmpdir() 下，
// 并且绝不能是作者的真实书架（这条闸门是防止「路径写错一次就动真书」）。
function assertTempRoot(base) {
  const target = path.resolve(String(base || ''));
  if (!isInside(path.resolve(os.tmpdir()), target)) {
    throw new Error(`只允许在系统临时目录下造书库：${target}`);
  }
  return target;
}

// 报告里的机器信息（两工具同一份；totalMemMb 只在 bench 报告里用过，统一保留）。
function machineInfo() {
  const cpus = os.cpus() || [];
  return {
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpus: cpus.length,
    cpuModel: cpus.length ? String(cpus[0].model || '').trim() : '',
    totalMemMb: Math.round(os.totalmem() / (1024 * 1024)),
    node: process.version
  };
}

// 子进程输出只留尾部 N 行（启动失败时别把整份 Electron 日志倒进终端）。
function tail(text, maxLines = 12) {
  const lines = String(text || '').trim().split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
}

// 从带噪声的 stdout 里挑出 `<marker> {json}`；没有 marker / JSON 坏了都返回 null。
function pickMarkerResult(stdout, marker) {
  const pattern = new RegExp(`${String(marker).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (.+)`);
  const hit = pattern.exec(String(stdout || ''));
  if (!hit) return null;
  try {
    return JSON.parse(hit[1]);
  } catch {
    return null;
  }
}

// 报告落点：--out 优先（相对仓库根），否则 shots/<tool>-<时间>.json（gitignore）。
function reportPath(tool, out, when) {
  if (out) return path.resolve(ROOT, out);
  return path.join(ROOT, 'shots', `${tool}-${stamp(when)}.json`);
}

// 启动一次真实 Electron 自动化：electron.exe <ROOT> <automationFlag> <args...>。
// 超时 / 整树终止 / UTF-8 流式解码 / 退出码全部由 electron-run 负责（TOOL-BX-01/03/04）。
function spawnApp({ automationFlag, args = [], timeout }) {
  return electronRun.runElectron([automationFlag, ...args], { timeout, cwd: ROOT });
}

module.exports = {
  ROOT,
  stamp,
  isInside,
  assertTempRoot,
  machineInfo,
  tail,
  pickMarkerResult,
  reportPath,
  spawnApp
};
