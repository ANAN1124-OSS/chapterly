'use strict';
// V90（1.7.2 D5）：package.json 包元信息闸门。
//
// 三件事一起锁，防止「补 engines 时顺手把版本号 / 依赖也动了」：
//   ① engines.node = ">=22" —— `node --test "tests/**/*.test.js"` 的 glob 需要 Node 21+，
//      写进元信息让不满足的环境在安装期就能看见（CI 锁 24，本地不低于 22）；
//   ② version 是当前发布号 1.7.2 —— 版本号只在作者点头的发版轮改动；1.7.0 → 1.7.2 是
//      2026-11-14 的发布动作（1.7.1 六项修复并入本号，不单独出包）。
//   ③ 运行时依赖仍空、devDependencies 仍只有 3 项 —— 章回是零依赖桌面工具，
//      任何「顺手加个包」都会把安装体积与供应链面一起放大。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PKG_PATH = path.join(__dirname, '..', 'package.json');
const readPkg = () => JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));

test('package.json 的 engines.node = ">=22"（V90）', () => {
  const pkg = readPkg();
  assert.ok(pkg.engines && typeof pkg.engines === 'object', 'package.json 必须声明 engines');
  assert.equal(pkg.engines.node, '>=22', `engines.node 必须是 >=22（实际：${JSON.stringify(pkg.engines.node)}）`);
});

test('version 是当前发布号 1.7.2（发版轮才许改）', () => {
  assert.equal(readPkg().version, '1.7.2', '版本号只在发版轮改（本次：1.7.0 → 1.7.2）');
});

test('依赖面不变：运行时依赖空、devDependencies 仍 3 项', () => {
  const pkg = readPkg();
  assert.deepEqual(Object.keys(pkg.dependencies || {}), [], '运行时依赖必须为空（零依赖桌面工具）');
  assert.deepEqual(
    Object.keys(pkg.devDependencies || {}).sort(),
    ['electron', 'electron-builder', 'eslint'],
    'devDependencies 只能有 electron / electron-builder / eslint 三项'
  );
});