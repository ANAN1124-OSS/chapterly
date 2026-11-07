// 正字数口径统一（v0.9 B-2 / 外部审计 F1）：**唯一实现**是 core/chapters.js 的 countChars
// （`String(text == null ? '' : text).replace(/\s/g, '').length`，即「去掉所有空白后的 UTF-16 长度」）。
//
// 这一轮把 5 处复制实现改成引用同一份（core/fragments.js、core/search-index.js、
// renderer/editor-logic.js、renderer/renderer.js 两处内联），**口径一个字都没改**。
// 所以测试分三层，任何一层挂了都说明「数字可能变了」：
//   1. 口径基线：空串 / 纯空白 / CRLF vs LF / 单独 CR / 全角空格 U+3000 / NBSP / 中英混排 /
//      emoji 代理对 / 10 万字长文 / 非字符串入参 —— 期望数字全部**写死**，实现改了就算各实现
//      互相一致也过不了这一层；
//   2. 跨实现一致：每个消费方走**自己的真实入口**（editor-logic 的 countChars 与 selectionStats、
//      fragments 的 cleanFragmentText、search-index 的 buildBookEntry、renderer.js 的四个调用点），
//      结果必须逐字等于基线数字；
//   3. 静态闸门：core/ 与 renderer/ 里「剔除空白」的 replace 只许剩 core/chapters.js 一处，
//      消费方必须显式引用共享实现、不许再长出本地 countChars 副本（防回潮）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const chapters = require('../core/chapters');
const fragments = require('../core/fragments');
const search = require('../core/search-index');
const editorLogic = require('../renderer/editor-logic');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// 口径基线：每一条都是「输入 → 去掉空白后的字符数」。这些数字是按定义手算的，不许跟着实现改。
//   - CRLF 的两个字符都算空白（\r 也在 \s 里）→ CRLF 与 LF 结果必须一样；
//   - 单独 CR（老 Mac 换行）同样是空白；
//   - 全角空格 U+3000、NBSP U+00A0、BOM U+FEFF、行分隔符 U+2028 / 段分隔符 U+2029、\v \f 都在 \s 里；
//   - emoji 是代理对，按 UTF-16 代码单元计 2（选中字数、光标下标都是这套单位，不能改成码点数）。
const LONG_TEXT = '字'.repeat(100000);
const CRLF_BLOCKS = ('字'.repeat(99) + '\r\n').repeat(1000);
const CASES = [
  { input: '', expected: 0, note: '空串' },
  { input: ' \t\r\n\u3000\u00a0', expected: 0, note: '纯空白（含全角空格 U+3000 与 NBSP）' },
  { input: '雨下了一夜。', expected: 6, note: '中文原样' },
  { input: '雨 下\r\n了\t一夜。', expected: 6, note: 'CRLF + 空格 + 制表符' },
  { input: '雨 下\n了\t一夜。', expected: 6, note: 'LF 版（与 CRLF 版同数）' },
  { input: '雨下\r一夜。', expected: 5, note: '单独 CR（老 Mac 换行）' },
  { input: '雨\u3000下了一夜。', expected: 6, note: '全角空格 U+3000' },
  { input: '雨\u00a0下', expected: 2, note: 'NBSP U+00A0' },
  { input: 'Hello 世界\n2026', expected: 11, note: '中英混排' },
  { input: '\u{1F600}雨', expected: 3, note: 'emoji 代理对按 2 个代码单元计' },
  { input: '\uFEFF雨', expected: 1, note: 'BOM 也是 \\s，不算字' },
  { input: '\u2028\u2029雨', expected: 1, note: '行 / 段分隔符也是 \\s' },
  { input: '\u000b\u000c雨', expected: 1, note: '竖制表 \\v / 换页 \\f 也是 \\s' },
  { input: LONG_TEXT, expected: 100000, note: '10 万字长文' },
  { input: CRLF_BLOCKS, expected: 99000, note: '10 万字级别 + 每行 CRLF' }
];

// 非字符串入参：旧实现走 String(text == null ? '' : text)，这些结果必须逐字保持
const COERCION_CASES = [
  { input: null, expected: 0, note: 'null → 空串' },
  { input: undefined, expected: 0, note: 'undefined → 空串' },
  { input: 123, expected: 3, note: '数字转字符串' },
  { input: false, expected: 5, note: '布尔转字符串（"false"）' },
  { input: {}, expected: 14, note: '"[object Object]" 去掉中间那个空格' }
];

test('口径基线：去掉所有空白后的 UTF-16 长度（CRLF / 全角空格 / NBSP / 代理对 / 10 万字）', () => {
  for (const item of CASES) {
    assert.equal(chapters.countChars(item.input), item.expected, `${item.note}：${JSON.stringify(item.input.slice(0, 12))}`);
  }
  // CRLF 与 LF 必须同数（这条单独再钉一次：两端对换行形态的既有差异都算「口径变了」）
  assert.equal(
    chapters.countChars('雨 下\r\n了\t一夜。'),
    chapters.countChars('雨 下\n了\t一夜。'),
    'CRLF 与 LF 的口径必须一致'
  );
});

test('非字符串入参：和统一前的实现逐字一致（null / undefined / 数字 / 布尔 / 对象）', () => {
  for (const item of COERCION_CASES) {
    assert.equal(chapters.countChars(item.input), item.expected, item.note);
  }
});

test('跨实现一致：editor-logic 的 countChars 就是 core 那一份函数（同一引用）', () => {
  assert.equal(editorLogic.countChars, chapters.countChars, 'editor-logic 必须直接引用 core/chapters 的 countChars');
  for (const item of [...CASES, ...COERCION_CASES]) {
    assert.equal(editorLogic.countChars(item.input), item.expected, `editor-logic：${item.note}`);
  }
});

test('跨实现一致：editor-logic 的选中字数（selectionStats，真实调用点）跟 core 同数', () => {
  for (const item of CASES) {
    const stats = editorLogic.selectionStats(item.input, 0, item.input.length);
    assert.equal(stats.chars, item.expected, `selectionStats 全选：${item.note}`);
  }
  // 局部选区：**去掉空白**后的数才是「选中字数」，这是 editor-logic 一直在用的口径
  assert.equal(editorLogic.selectionStats('雨 下\n了', 0, 4).chars, 2, '选中「雨 下\\n」= 2 字');
  assert.equal(editorLogic.selectionStats('雨 下\n了', 0, 5).chars, 3, '选中「雨 下\\n了」= 3 字');
  assert.equal(editorLogic.selectionStats('雨 下\n了', 0, 5).paragraphs, 2, '选区触及两段');
});

test('跨实现一致：fragments 的 chars 跟 core 同数（清洗只动空白 / BOM，不改非空白字符数）', () => {
  for (const item of CASES) {
    const result = fragments.cleanFragmentText(item.input, { maxChars: 200000 });
    if (!item.input.replace(/\s/g, '')) {
      assert.equal(result.ok, false, `纯空白碎片应当被拒（${item.note}）`);
      assert.equal(result.code, 'EMPTY');
      continue;
    }
    assert.equal(result.ok, true, `碎片应当可保存：${item.note}`);
    assert.equal(result.chars, item.expected, `碎片 chars：${item.note}`);
    // 清洗后的正文与原文的非空白字符数必须一样（去掉的是 BOM / CR / 首尾空白，全是空白）
    assert.equal(chapters.countChars(result.text), item.expected, `清洗后复核：${item.note}`);
  }
});

test('跨实现一致：search-index 建索引时写进 chapters[].chars 的值跟 core 同数', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'cw-charcount-'));
  try {
    const booksRoot = path.join(base, 'books');
    const bookPath = path.join(booksRoot, '口径书');
    await fsp.mkdir(bookPath, { recursive: true });
    // 全部输入都写进 txt（含 10 万字长文与 CRLF 长文；非字符串入参走不到这条路径，前面几层已覆盖）
    const textCases = CASES;
    const meta = {
      version: 1,
      id: 'b_charcount',
      title: '口径书',
      titleTemplate: '第{num}章',
      fileSeq: textCases.length,
      chapters: [],
      createdAt: '2026-10-31T12:00:00.000Z'
    };
    for (let i = 0; i < textCases.length; i += 1) {
      const file = `${String(i + 1).padStart(3, '0')}-ch${i + 1}.txt`;
      await fsp.writeFile(path.join(bookPath, file), textCases[i].input, 'utf8');
      // 故意不写 chars：索引要自己按共享实现算出来
      meta.chapters.push({ id: `ch_${i + 1}`, file, name: `第${i + 1}章`, createdAt: '2026-10-31T12:00:00.000Z' });
    }
    await fsp.writeFile(path.join(bookPath, '书目.json'), JSON.stringify(meta, null, 2), 'utf8');

    const built = await search.buildBookEntry(bookPath, '口径书', null, {});
    const computed = built.entry.chapters.map((chapter) => chapter.chars);
    assert.deepEqual(
      computed,
      textCases.map((item) => item.expected),
      '索引里每章的 chars 必须等于 core 口径（CRLF / 全角空格 / NBSP / 代理对都在内）'
    );
  } finally {
    await fsp.rm(base, { recursive: true, force: true });
  }
});

test('静态闸门：core/ 与 renderer/ 只剩 core/chapters.js 一处「剔除空白」口径', () => {
  const dirs = ['core', 'renderer'];
  const files = [];
  for (const dir of dirs) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (name.endsWith('.js')) files.push(`${dir}/${name}`);
    }
  }
  // 精确口径：验收命令里的 `replace(/\s/g, '')` 只许出现一次，且在 core/chapters.js
  const exact = /replace\(\/\\s\/g, ''\)/;
  const exactHits = files.filter((rel) => exact.test(read(rel)));
  assert.deepEqual(exactHits, ['core/chapters.js'], '剔除空白的正字数只许有 core/chapters.js 一处实现');

  // 放宽口径：任何「用 \s 匹配、替换成空串」的 replace 也只许一处（挡住 replace(/\s+/g, '') 之类回潮）
  const stripAny = /\.replace\(\/((?:[^/\\\n]|\\.)+)\/g,\s*''\)/g;
  const broadHits = [];
  for (const rel of files) {
    const source = read(rel);
    for (const match of source.matchAll(stripAny)) {
      if (match[1].includes('\\s')) broadHits.push(rel);
    }
  }
  assert.deepEqual(
    [...new Set(broadHits)],
    ['core/chapters.js'],
    '除 core/chapters.js 外不许再有「把 \\s 换成空串」的实现（口径要改只能改这一处）'
  );
});

test('静态闸门：五个消费方都引用共享实现，没有本地 countChars 副本', () => {
  const consumers = {
    'core/fragments.js': /const chaptersLib = require\('\.\/chapters'\);/,
    'core/search-index.js': /const chaptersLib = require\('\.\/chapters'\);/,
    'renderer/editor-logic.js': /const \{ countChars \} = chaptersLib;/,
    'renderer/fragments-ui.js': /chaptersLib\.countChars\(/,
    'renderer/editor-logic.js → window': /root\.CWEditorLogic = factory\(root\.CWCommon, root\.CWChapters, root\.CWParagraphs\);/
  };
  for (const [rel, pattern] of Object.entries(consumers)) {
    assert.ok(pattern.test(read(rel.split(' → ')[0])), `${rel} 必须引用共享实现`);
  }
  // 五个调用点（本章字数 / 碎片计数 / 碎片空判定 / 整理后光标映射 / 剪贴板「正文」插入的返回字数）：
  // v0.9 B-5 第七刀把「本章字数」搬家到 renderer/statusbar-ui.js；第 4 步九刀·第八刀把「整理后光标映射」
  // 随整理流程搬到 renderer/tidy-card-ui.js；2026-11-07 剪贴板单列表的 host.insertIntoBody 契约要求
  // 返回 chaptersLib.countChars(text)，renderer.js 因此多 1 处。总数变 5，只是分布变了
  //（只改计数口径的读取范围，断言语义不变）。
  const rendererSource = read('renderer/renderer.js');
  const statusbarSource = read('renderer/statusbar-ui.js');
  const tidyCardSource = read('renderer/tidy-card-ui.js');
  const fragmentsSource = read('renderer/fragments-ui.js');
  assert.equal(
    (rendererSource.match(/chaptersLib\.countChars\(/g) || []).length +
      (statusbarSource.match(/chaptersLib\.countChars\(/g) || []).length +
      (tidyCardSource.match(/chaptersLib\.countChars\(/g) || []).length +
      (fragmentsSource.match(/chaptersLib\.countChars\(/g) || []).length,
    5,
    '5 处字数调用都要走 core 的 countChars（现分布：statusbar-ui.js 1 处 + tidy-card-ui.js 1 处 + fragments-ui.js 2 处 + renderer.js 1 处（剪贴板正文插入））'
  );
  // 全库只许 core/chapters.js 定义 function countChars
  for (const rel of [
    'core/fragments.js',
    'core/search-index.js',
    'renderer/editor-logic.js',
    'renderer/renderer.js',
    'renderer/statusbar-ui.js',
    'renderer/tidy-card-ui.js',
    'renderer/fragments-ui.js'
  ]) {
    assert.equal(/function countChars\s*\(/.test(read(rel)), false, `${rel} 不许再留本地 countChars 实现`);
  }
  assert.ok(/function countChars\s*\(/.test(read('core/chapters.js')), 'core/chapters.js 才是唯一实现');
});
