// core/path-utils.js：路径归一的唯一实现（审计 P1 · C4）。
//
// 收编前 core/open-books.js（normalizeBookPath）与 core/search-index.js（normalizeRoot）各有一份
// 逐字相同的「trim → path.resolve → toLowerCase」。两边判「同一本书」的口径必须永远一致，
// 否则书架搜索会把同一本书当成两本（重复建索引）。这里钉两层：
//   1. 行为：空值 / 相对路径 / 大小写 / 末尾分隔符；
//   2. 回归闸门：两个模块必须从 path-utils 拿，仓库里不许再长出第二份实现；模块保持纯（只依赖 node:path）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pathUtils = require('../core/path-utils');
const openBooks = require('../core/open-books');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SOURCE = read('core/path-utils.js');
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const CORE_FILES = fs
  .readdirSync(path.join(ROOT, 'core'))
  .filter((name) => name.endsWith('.js') && name !== 'path-utils.js')
  .map((name) => `core/${name}`);

test('normalizePath：空值 → 空串，路径解析成绝对路径并小写', () => {
  assert.equal(pathUtils.normalizePath(null), '');
  assert.equal(pathUtils.normalizePath(undefined), '');
  assert.equal(pathUtils.normalizePath(''), '');
  assert.equal(pathUtils.normalizePath('   '), '');
  const expected = path.resolve('D:\\Books\\甲书').toLowerCase();
  assert.equal(pathUtils.normalizePath('D:\\Books\\甲书\\'), expected, '末尾分隔符不影响同一目录');
  assert.equal(pathUtils.normalizePath('d:\\books\\甲书'), expected, 'Windows 路径不分大小写');
  assert.equal(pathUtils.normalizePath('  D:\\Books\\甲书  '), expected, '首尾空白先 trim');
});

test('normalizePath：相对路径按当前目录解析（同一目录的不同写法得到同一个键）', () => {
  const a = pathUtils.normalizePath('./core/../core');
  const b = pathUtils.normalizePath('core');
  assert.equal(a, b);
  assert.equal(a, path.resolve('core').toLowerCase());
  // 非字符串输入按字符串处理（与旧实现一致：String(value)）
  assert.equal(pathUtils.normalizePath(123), path.resolve('123').toLowerCase());
});

test('对外形状固定 + open-books 的旧名字就是同一份实现', () => {
  assert.deepEqual(Object.keys(pathUtils), ['normalizePath']);
  assert.equal(openBooks.normalizeBookPath, pathUtils.normalizePath, 'normalizeBookPath 只是同一函数的旧名字');
});

test('静态闸门：open-books / search-index 从 core/path-utils.js 取，仓库里不许再长出第二份实现', () => {
  for (const rel of ['core/open-books.js', 'core/search-index.js']) {
    assert.ok(/require\('\.\/path-utils'\)/.test(read(rel)), `${rel} 必须从 core/path-utils.js 取路径归一`);
  }
  for (const rel of CORE_FILES) {
    const source = read(rel);
    assert.equal(/function normalizePath\s*\(/.test(source), false, `${rel} 里不该再有第二份 normalizePath 实现`);
    assert.equal(/function normalizeRoot\s*\(/.test(source), false, `${rel} 里不该再有 normalizeRoot（用 core/path-utils.js）`);
    assert.equal(
      /path\.resolve\(raw\)\.toLowerCase\(\)/.test(source),
      false,
      `${rel} 里不该再内联 path.resolve(raw).toLowerCase()（用 core/path-utils.js）`
    );
  }
});

test('core/path-utils.js 只依赖 node:path：不碰 fs / process / electron', () => {
  assert.equal(/\bprocess\s*\./.test(CODE), false, '不许碰 process');
  assert.equal(/\bfs\s*\./.test(CODE), false, '不许碰 fs');
  assert.equal(/electron/.test(CODE), false, '不许出现 electron');
  assert.equal(/require\('node:path'\)/.test(CODE), true, '只该 require node:path');
  assert.equal((CODE.match(/require\s*\(/g) || []).length, 1, '只该有一个 require');
});
