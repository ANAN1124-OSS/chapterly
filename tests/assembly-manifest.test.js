// 审计修复 #55（M4）：渲染层装配清单（renderer/assembly-manifest.js）**行为**闸门。
//
// WP16（R-N4）把原来的 4 条纯接线断言（script 顺序 / 条目不重复 / 模块挂全局名 / renderer 引用）
// 迁到 scripts/wiring-check.js + tests/wiring-manifest.test.js（同一事实只留一条闸门；那边还有
// 变异负控与等价重构不假红）。本文件只保留清单对象的**行为**：collect / assertInstalled / 启动守卫。
//
// 以前「加一个模块」靠三处手工同步：index.html 的 <script> 顺序 / renderer.js 的
// `const x = window.CWxxx` / 测试里的载入链。这里用装配清单把三处对起来：
//   1. 清单与 index.html 的 <script> 文件顺序逐项一致（漏插 / 顺序挪错 / 多一个文件都红）；
//   2. 清单里的每个模块真的挂出了声明的 window.CWxxx（全局名写错会红）；
//   3. renderer.js 里每个 `const 本地名 = window.CWxxx` 与每个 window.CWxxx 引用都在清单内；
//   4. collect / assertInstalled 的行为：缺模块一次报全（code + missing 列表），齐全时返回
//      带本地名的模块表。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const manifest = require('../renderer/assembly-manifest');

const ROOT = path.join(__dirname, '..');
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('collect：齐全时返回「本地名 → 模块对象」；assertInstalled 返回模块数', () => {
  const fake = {};
  for (const [file, global, key] of manifest.MODULES) fake[global] = { from: file, key };
  assert.equal(manifest.assertInstalled(fake), manifest.MODULES.length);
  const modules = manifest.collect(fake);
  assert.equal(modules.commonLib.from, '../core/common.js');
  assert.equal(modules.chaptersLib.key, 'chaptersLib');
  // 没有本地名的可选 UI 模块不进返回值（renderer.js 按 window.CWxxx 直接取用）
  assert.equal('dialogFocus' in modules, false);
  assert.equal(Object.keys(modules).length, manifest.MODULES.filter((entry) => entry[2]).length);
});

// 审计残留修复 #R12（#55/M4）：清单模块自己没加载时，renderer.js 不许抛原生 TypeError
// （Cannot read properties of undefined），要走与 collect() 同一套聚合报错（TypeError + code + missing）。
test('renderer.js 启动守卫：清单自身漏加载也报同一种聚合错（不是原生 TypeError）', () => {
  const source = read('renderer/renderer.js');
  // 找真正的调用点（注释里也出现过同一句，所以按「行首两个空格 + 没有 //」定位）
  const callAt = source.indexOf('\n  window.CWRendererAssembly.assertInstalled(window);');
  assert.ok(callAt > 0, 'renderer.js 必须调用装配清单的 assertInstalled(window)');
  const at = callAt + 1;
  const guard = source.slice(Math.max(0, at - 900), at);
  assert.match(guard, /if \(!window\.CWRendererAssembly \|\| typeof window\.CWRendererAssembly\.assertInstalled !== 'function'\) \{/,
    '调用前必须先判清单对象与 assertInstalled 是不是函数');
  assert.match(guard, /new TypeError\(/, '缺清单时抛的必须是 TypeError（与 host 缺成员同一口径）');
  assert.match(guard, /missingAssembly\.code = 'RENDERER_MODULE_MISSING'/, '复用装配清单的错误码');
  assert.deepEqual(guard.match(/missingAssembly\.missing = \['(\w+)'\]/)[1], 'CWRendererAssembly', 'missing 要点名清单模块本身');
  assert.match(guard, /index\.html 的 <script> 顺序/, '提示要指向 index.html 的 <script> 顺序');
  assert.match(guard, /throw missingAssembly;/, '判不过必须抛出去，不许静默继续');
  // 守卫之后的调用点仍是清单本身（不许改走别的入口）
  assert.match(source.slice(at), /^ {2}window\.CWRendererAssembly\.assertInstalled\(window\);/);
});

test('assertInstalled：缺模块一次报全（TypeError + code + missing），不静默放行', () => {
  const fake = {};
  for (const [file, global, key] of manifest.MODULES) fake[global] = { from: file, key };
  delete fake.CWCommon;
  delete fake.CWChapters;
  assert.throws(
    () => manifest.assertInstalled(fake),
    (err) => {
      assert.equal(err instanceof TypeError, true, '必须是 TypeError（与 host 缺成员的既有口径一致）');
      assert.equal(err.code, 'RENDERER_MODULE_MISSING');
      assert.deepEqual(err.missing, ['CWCommon', 'CWChapters'], '一次列出所有缺的模块');
      assert.match(err.message, /CWCommon/);
      assert.match(err.message, /CWChapters/);
      assert.match(err.message, /index\.html/);
      return true;
    }
  );
  // 空 / 非对象窗口同样按「全部缺失」处理，而不是抛别的 TypeError
  assert.throws(() => manifest.assertInstalled(null), /CWCommon/);
});