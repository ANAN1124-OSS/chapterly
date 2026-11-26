'use strict';
// A2-GATE-04（2026-11-26 审计）：临时目录只在正常退出回收，被 kill / 超时 / Ctrl+C 打断时
// 只留下现场；本机 D:\Temp 曾堆到 674 个 cw-* / 879 MB。这里钉住 sweepStale 的删除边界：
//   · 只认 cw- 前缀、只删目录、只看直接子目录（不递归找）；
//   · 只删 mtime 超过 24 小时的（24 小时内的可能是别的进程正在用）；
//   · 符号链接 / 目录联接一律不碰（不跟随链接进到别处）；
//   · npm test / npm run e2e 启动各跑一次。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tmpCleanup = require('./tmp-cleanup');

const ROOT = path.join(__dirname, '..');

test('A2-GATE-04：超龄 cw-* 目录有 sweep 入口（只删 >24h 的直接子目录，不跟链接）', () => {
  const root = tmpCleanup.mkTmpSync('cw-sweep-root-');
  const old = new Date(Date.now() - 2 * 24 * 3600 * 1000);

  const oldDir = path.join(root, 'cw-old');
  fs.mkdirSync(path.join(oldDir, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'nested', 'a.txt'), 'x');
  fs.utimesSync(path.join(oldDir, 'nested', 'a.txt'), old, old);
  fs.utimesSync(oldDir, old, old);

  const freshDir = path.join(root, 'cw-fresh');
  fs.mkdirSync(freshDir);

  const otherOld = path.join(root, 'other-old');
  fs.mkdirSync(otherOld);
  fs.utimesSync(otherOld, old, old);

  const oldFile = path.join(root, 'cw-old-file');
  fs.writeFileSync(oldFile, 'x');
  fs.utimesSync(oldFile, old, old);

  // 目录联接不需要管理员权限；跨盘不可用时跳过这一条断言（sweep 本身仍按 lstat 判）
  let linkMade = false;
  const target = path.join(root, 'target');
  fs.mkdirSync(target);
  fs.utimesSync(target, old, old);
  try {
    fs.symlinkSync(target, path.join(root, 'cw-old-link'), 'junction');
    linkMade = true;
  } catch {
    /* 没有建链接的权限：跳过链接断言 */
  }

  const removed = tmpCleanup.sweepStale(root);
  assert.deepEqual(removed, ['cw-old'], '只删超龄的 cw-* 目录');
  assert.equal(fs.existsSync(oldDir), false, '超龄 cw-* 目录（含嵌套内容）必须删掉');
  assert.equal(fs.existsSync(freshDir), true, '24 小时内的目录不碰');
  assert.equal(fs.existsSync(otherOld), true, '非 cw- 前缀的目录不碰');
  assert.equal(fs.existsSync(oldFile), true, '普通文件不碰（只清目录）');
  if (linkMade) {
    assert.equal(fs.existsSync(path.join(root, 'cw-old-link')), true, '符号链接 / 目录联接不碰');
    assert.equal(fs.existsSync(target), true, '链接目标原样保留');
  }

  // 静态接线：两个入口启动时各跑一次（失败静默，不影响门禁本身）。
  const runTests = fs.readFileSync(path.join(ROOT, 'scripts', 'run-tests.js'), 'utf8');
  const runE2e = fs.readFileSync(path.join(ROOT, 'scripts', 'run-e2e.js'), 'utf8');
  assert.match(runTests, /sweepStale\(\)/, 'npm test 启动要清超龄残留');
  assert.match(runE2e, /sweepStale\(\)/, 'npm run e2e 启动要清超龄残留');
});
