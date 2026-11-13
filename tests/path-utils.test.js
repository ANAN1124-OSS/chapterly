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

// V43 / V83：「是不是同一个路径」的口径收成一份 —— resolve + 小写 + Windows 正斜杠归反斜杠。
// 大小写 / 正反斜杠 / 末尾斜杠 / 相对写法都必须落到同一个 key，否则同一份词表或同一本书会被算成两份。
test('路径等价：大小写 / 正反斜杠 / 末尾斜杠 / 相对写法同一 key（V43/V83）', () => {
  const base = path.resolve('D:\\Books\\甲书');
  const key = pathUtils.pathKey(base);
  assert.equal(key, base.toLowerCase(), 'Windows 下小写（这台机器的 path.resolve 已经给反斜杠）');
  assert.equal(pathUtils.pathKey(base.toUpperCase()), key, '大小写不同 = 同一个路径');
  assert.equal(pathUtils.pathKey(base.replace(/\\/g, '/')), key, '正反斜杠混用 = 同一个路径');
  assert.equal(pathUtils.pathKey(base + path.sep), key, '末尾多一个分隔符 = 同一个路径');
  assert.equal(pathUtils.pathKey(base + path.sep + '.'), key, '末尾 . = 同一个路径');
  assert.equal(pathUtils.pathKey(`  ${base}  `), key, '首尾空白先 trim');
  assert.equal(pathUtils.pathKey(path.relative(process.cwd(), base)), key, '相对写法按当前目录解析成同一个 key');
  // 与 normalizePath 同一套解析结果（pathKey 只多一步 Windows 斜杠归一）；非 Windows 上两者逐字相同
  assert.equal(pathUtils.pathKey(base), pathUtils.normalizePath(base));
  // 空值 / 非字符串的边界与 normalizePath 一致
  assert.equal(pathUtils.pathKey(null), '');
  assert.equal(pathUtils.pathKey(undefined), '');
  assert.equal(pathUtils.pathKey('   '), '');
  assert.equal(pathUtils.pathKey(123), path.resolve('123').toLowerCase());
});

test('对外形状固定 + open-books 的旧名字就是同一份实现', () => {
  assert.deepEqual(Object.keys(pathUtils), ['normalizePath', 'pathKey']);
  assert.equal(openBooks.normalizeBookPath, pathUtils.normalizePath, 'normalizeBookPath 只是同一函数的旧名字');
});

test('静态闸门：open-books / search-index / config / config-gate / main 从 core/path-utils.js 取，仓库里不许再长出第二份实现', () => {
  for (const rel of ['core/open-books.js', 'core/search-index.js', 'core/config.js', 'core/config-gate.js']) {
    assert.ok(/require\('\.\/path-utils'\)/.test(read(rel)), `${rel} 必须从 core/path-utils.js 取路径归一`);
  }
  assert.match(read('main.js'), /pathUtils\.pathKey\(/, 'main.js 的 bookKeyOf / 词表去重必须走 core/path-utils.js 的 pathKey');
  assert.equal(/function bookKeyOf\s*\(/.test(read('main.js')), false, 'main.js 不该再手写 bookKeyOf');
  assert.equal(/function wordlistKey\s*\(/.test(read('main.js')), false, 'main.js 不该再手写 wordlistKey');
  for (const rel of CORE_FILES) {
    const source = read(rel);
    assert.equal(/function normalizePath\s*\(/.test(source), false, `${rel} 里不该再有第二份 normalizePath 实现`);
    assert.equal(/function normalizeRoot\s*\(/.test(source), false, `${rel} 里不该再有 normalizeRoot（用 core/path-utils.js）`);
    assert.equal(/function pathKey\s*\(/.test(source), false, `${rel} 里不该再有第二份 pathKey 实现`);
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
