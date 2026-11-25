'use strict';
// T-26（三次审查 · 高）：`checkVisual` 静态清单的解析口径单测。
//
// 为什么单独一份：这份清单是 CI 跳过面的唯一约束（E2E_SKIP_VISUAL=1 时 checkVisual 恒真），
// 解析器一旦漏认 / 多认，门禁就会出现「覆盖不到但照样绿」。这里钉住四件事：
//   ① 只认真实调用：行注释 / 块注释里的 checkVisual 不算；
//   ② 断言名支持单引号 / 双引号 / 模板字符串，模板里的 ${...} 原样保留；
//   ③ 跨行调用 / 转义按源码口径还原；
//   ④ 行内混写（不是单独起一行）必须报「无法静态识别」，不许静默漏掉；
//   ⑤ 清单双向比对：未登记 / 清单过期 / 重复 都要点名。
const test = require('node:test');
const assert = require('node:assert/strict');
const va = require('../scripts/e2e/visual-assertions.js');

test('T-26 extractVisualAssertions：只认真实调用，注释里的不算', () => {
  const source = [
    "// checkVisual('行注释里的', true)",
    "/*",
    "checkVisual('块注释里的', true)",
    "*/",
    "  checkVisual('一行', true);",
    "  checkVisual(  `模板 ${label} 尾巴`, false);",
    '  checkVisual("双引号", true);',
    "  check(\"函数名相近但不是 checkVisual\", true);",
    '  const s = "普通字符串";',
    "  checkVisual(",
    "    '跨行',",
    "    true",
    "  );"
  ].join('\n');
  assert.deepEqual(va.extractVisualAssertions(source), ['一行', '模板 ${label} 尾巴', '双引号', '跨行']);
});

test('T-26 extractVisualAssertions：转义还原 + 空白归一（多行断言名折叠成一个空格）', () => {
  assert.deepEqual(va.extractVisualAssertions("checkVisual('他说\\'好\\'，然后走了', true);"), ["他说'好'，然后走了"]);
  const multiline = "checkVisual(\n    '第一段\\n第二段   第三段',\n    true\n  );";
  assert.deepEqual(va.extractVisualAssertions(multiline), ['第一段 第二段 第三段']);
  assert.equal(va.normalizeName('  a\t\n  b  '), 'a b');
});

test('T-26 extractVisualAssertions：行内混写 / 非字面量第一个参数 → null（比对时报红，不静默漏）', () => {
  assert.deepEqual(va.extractVisualAssertions("if (ok) checkVisual('行内混写', true);"), [null]);
  assert.deepEqual(va.extractVisualAssertions("  checkVisual(someName, true);"), [null]);
});

test('T-26 compareVisualAssertions：未登记 / 清单过期 / 重复 / 数量不一致都要点名', () => {
  const manifest = [
    ['a.js', '甲'],
    ['a.js', '乙'],
    ['b.js', '丙']
  ];
  const sources = [
    { file: 'a.js', text: "checkVisual('甲', true);\ncheckVisual('乙', true);\ncheckVisual('丁', true);" },
    { file: 'b.js', text: "checkVisual('丙', true);" }
  ];
  const problems = va.compareVisualAssertions(sources, manifest);
  assert.equal(problems.length, 1, '只有「丁」未登记：' + JSON.stringify(problems));
  assert.match(problems[0], /a\.js/);
  assert.match(problems[0], /丁/);
  assert.match(problems[0], /清单没登记/);

  // 清单过期：代码里删掉「乙」→ 点名清单条目
  const stale = va.compareVisualAssertions(
    [
      { file: 'a.js', text: "checkVisual('甲', true);" },
      { file: 'b.js', text: "checkVisual('丙', true);" }
    ],
    manifest
  );
  assert.equal(stale.length, 1);
  assert.match(stale[0], /乙/);
  assert.match(stale[0], /代码里没有/);

  // 同一文件同一断言名重复：清单只能记一次，代码里出现两次要红
  const dup = va.compareVisualAssertions(
    [{ file: 'a.js', text: "checkVisual('甲', true);\ncheckVisual('甲', true);" }],
    [['a.js', '甲']]
  );
  assert.ok(dup.some((item) => item.includes('重复')), '重复断言名必须点名：' + JSON.stringify(dup));

  // 坏入参不许静默通过（按 problem 报，不抛错：CLI 契约要把所有问题一次列全）
  assert.ok(
    va.compareVisualAssertions([{ file: 'a.js' }]).some((item) => /sources 每项必须是/.test(item)),
    'sources 缺 text 必须报出来'
  );
});

// GATE-02（2026-11-24 复核补审）：把 checkVisual 赋给变量 / 解构重命名之后，静态清单就追不到调用点 ——
// 必须报「无法静态识别」（null），不许静默漏。标准解构（不重命名）与直接调用不受影响。
test('GATE-02：checkVisual 别名 / 解构重命名 → null；标准解构 + 直接调用照旧', () => {
  assert.deepEqual(va.extractVisualAssertions('const visualCheck = checkVisual;'), [null], '赋值别名');
  assert.deepEqual(
    va.extractVisualAssertions("const { checkVisual: visualCheck } = t;\n  visualCheck('重命名后调用', true);"),
    [null],
    '解构重命名'
  );
  // 现有真实写法：解构但不改名，只有直接调用进清单
  assert.deepEqual(
    va.extractVisualAssertions(
      "const { exec, check, checkVisual, waitFor } = t;\n  checkVisual('正常调用', true);\n  check('功能断言', true);"
    ),
    ['正常调用']
  );
  // 注释里的别名说明不算（必须能区分「解释」与「代码」）
  assert.deepEqual(va.extractVisualAssertions("// const v = checkVisual\n  checkVisual('甲的', true);"), ['甲的']);
  // compare 层面：别名夹具必须被点名成「无法静态识别」
  const problems = va.compareVisualAssertions(
    [{ file: 'x.js', text: 'const visualCheck = checkVisual;' }],
    []
  );
  assert.ok(problems.some((item) => /无法静态识别/.test(item)), JSON.stringify(problems));
});

// GATE-09（低）：属性取值 / 计算属性 / 带引号解构键这些「先取出 checkVisual 再调用」的形态，
// 旧实现一个都追不到 —— 调用点既不进 codeMap 也不报 null，功能断言可以借道偷渡进视觉跳过面
// 且门禁全绿。这里钉住：除「直接调用」与「不改名的解构简写」外，其余引用一律按无法静态识别报。
test('GATE-09：取出 checkVisual 的其它引用形态一律按「无法静态识别」报 null', () => {
  for (const source of [
    "const vc = t.checkVisual;\n  vc('属性取值后调用', true);",
    "const vc = t['checkVisual'];\n  vc('计算属性后调用', true);",
    "const { 'checkVisual': vc } = t;\n  vc('带引号解构键后调用', true);",
    'const vc = checkVisual.bind(t);',
    'run(t.checkVisual);'
  ]) {
    assert.ok(
      va.extractVisualAssertions(source).includes(null),
      `必须报不可静态识别：${source}\n实际 ${JSON.stringify(va.extractVisualAssertions(source))}`
    );
  }
  // 标准解构 / 直接调用 / 注释仍不误报
  assert.deepEqual(
    va.extractVisualAssertions("const { exec, checkVisual, waitFor } = t;\n  checkVisual('正常调用', true);"),
    ['正常调用']
  );
  assert.deepEqual(va.extractVisualAssertions("// t.checkVisual 的说明\n  checkVisual('甲的', true);"), ['甲的']);
  // compare 层面：偷渡写法必须被 wiring 契约点名，不能「清单外多出来的调用」也照样绿
  const problems = va.compareVisualAssertions(
    [{ file: 'x.js', text: "const vc = t.checkVisual;\n  vc('探针', true);" }],
    []
  );
  assert.ok(problems.some((item) => /无法静态识别/.test(item)), JSON.stringify(problems));
});
