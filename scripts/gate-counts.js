'use strict';
// A2-GATE-02（2026-11-26 审计）：文档计数锚（单测 / E2E）的机器真值来源。
//
// 问题：README / 验收清单里的「单测 N 项 / E2E N 项」被定义成机器实测锚点，但默认
// `version-sync --check` 只核对两处文档互相对得上 —— 三个真实调用点都没传 --unit / --e2e，
// 于是头条数字可以长期失真而门禁全绿。
//
// 做法：每个会产出「实测条数」的门禁命令跑完把数字落到**临时目录**里的一个 JSON：
//   · npm test     → node scripts/run-tests.js 落 unit；
//   · npm run e2e  → scripts/run-e2e.js 落 e2e。
// `version-sync --check` 默认读这两个文件并与文档比对（文件不存在时跳过：CI 没有本地
// 跑数记录，不能因此误红）。文件按仓库根路径分键，同一台机器上的多个检出互不污染。
// 临时目录不可写时所有函数静默返回 null —— 只影响自动核对，绝不影响门禁本身。
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// 同一台机器可能有多个检出：按仓库根的归一化路径分键，计数不会互相盖掉。
const KEY = crypto
  .createHash('sha1')
  .update(path.resolve(ROOT).toLowerCase())
  .digest('hex')
  .slice(0, 12);

function fileFor(kind) {
  const safe = String(kind || '').replace(/[^a-z0-9_-]/gi, '');
  return path.join(os.tmpdir(), `chapterly-gate-counts-${KEY}-${safe}.json`);
}

// 记录一次实测值。返回写入的数字；形状不合法 / 写盘失败返回 null（不抛错）。
function record(kind, value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number) || number < 0) return null;
  try {
    fs.writeFileSync(
      fileFor(kind),
      `${JSON.stringify({ kind: String(kind), value: number, at: new Date().toISOString() })}\n`
    );
    return number;
  } catch {
    return null;
  }
}

// 读回最近一次实测值；没有记录 / 坏 JSON 返回 null（调用方据此跳过核对）。
function read(kind) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(kind), 'utf8'));
    const number = Math.round(Number(raw && raw.value));
    return Number.isFinite(number) && number >= 0 ? number : null;
  } catch {
    return null;
  }
}

function readAll() {
  return { unit: read('unit'), e2e: read('e2e') };
}

module.exports = { ROOT, fileFor, record, read, readAll };
