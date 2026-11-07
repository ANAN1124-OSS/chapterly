// 段落切分规则下沉共享模块（v0.9 B-3 / 外部审计 F3）：**唯一实现**是 core/paragraphs.js 的
// paragraphRanges / lineRanges / trimmedRange。
//
// 这一轮把这条规则从两份实现收成一份：
//   - core/tts.js 的 paragraphRanges + 内部 trimmedRange（朗读切分的第一刀）；
//   - renderer/editor-logic.js 的 paragraphRanges + lineRanges（段落导航 / 当前段落高亮 / 不可见字符）。
// 规则是「一个非空行 = 一段，首尾空白（含全角空格）不算」，**段落切分结果零变化**是硬要求，所以测试分三层：
//   1. 规则基线：各种边界输入（CRLF / BOM / 全角空格 / NBSP / 制表 / 行段分隔符 / 空行 / 末尾换行 /
//      代理对）的 start / end / paragraph / line 与 lineRanges 的 blank 全部**写死**，实现改了就算两端
//      互相一致也过不了这一层；
//   2. 跨实现一致：同一批输入下 core/tts.js、renderer/editor-logic.js、core/paragraphs.js 三个入口
//      结果逐字一致，且两端拿到的是**同一个函数引用**（不是各自留的一份副本）；
//   3. 静态闸门：三个函数只许 core/paragraphs.js 一处实现、两个消费方必须从它拿、index.html 加载顺序
//      对、模块保持纯逻辑（不 require 任何东西、不碰 process / window / document）。
//
// 唯一一条**改前就存在的差异**（不是本轮引入的，记录在案）：非字符串入参。旧 core/tts.js 直接
// text.split，传 null / 数字会抛 TypeError；旧 renderer/editor-logic.js 用 toText 先转字符串。
// 本轮统一到宽松侧（toText），因为产品调用方（tts.buildChunks、编辑区 value）永远传字符串；
// 所有字符串输入的结果与改前逐字一致（改前 / 改后 32 组输入的 JSON 快照 SHA256 完全相同）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const paragraphs = require('../core/paragraphs');
const tts = require('../core/tts');
const logic = require('../renderer/editor-logic');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const FW = '　'; // 全角空格
const INDEX_SOURCE = read('renderer/index.html');
const PARAGRAPHS_SOURCE = read('core/paragraphs.js');
// 纯逻辑闸门只看代码：注释里提到 window / electron 是在解释边界，不算越界
const PARAGRAPHS_CODE = PARAGRAPHS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// 浏览器那条路（index.html 的 <script>）：没有 module / require 的沙箱里加载脚本，
// 模块会把对外接口挂到沙箱的 globalThis 上（window.CWParagraphs）。
function loadInBrowserSandbox(files) {
  const win = {};
  const context = vm.createContext(win);
  for (const rel of files) vm.runInContext(read(rel), context, { filename: rel });
  return { win, context };
}

test('段落规则：一个非空行一段，首尾空白（含全角空格）不算，行号 / 段号都 1 基', () => {
  const text = `${FW}${FW}第一段。${FW}${FW}\n\n第二段！\n   \n\t第三段？`;
  assert.deepEqual(paragraphs.paragraphRanges(text), [
    { start: 2, end: 6, paragraph: 1, line: 1 },
    { start: 10, end: 14, paragraph: 2, line: 3 },
    { start: 20, end: 24, paragraph: 3, line: 5 }
  ]);
  // 每段切出来的正文是原文里那一段（段首全角缩进 / 段尾空白都不在内）
  assert.deepEqual(
    paragraphs.paragraphRanges(text).map((range) => text.slice(range.start, range.end)),
    ['第一段。', '第二段！', '第三段？']
  );
  // 空行不占段号（第 2 段落在物理第 3 行、第 3 段落在第 5 行）
  assert.deepEqual(
    paragraphs.paragraphRanges(text).map((range) => range.line),
    [1, 3, 5]
  );
  // 空文本 / 纯空白行没有段落
  assert.deepEqual(paragraphs.paragraphRanges(''), []);
  assert.deepEqual(paragraphs.paragraphRanges(`${FW}\n  \n\t`), []);
  assert.deepEqual(paragraphs.paragraphRanges(null), []);
});

test('段落规则：CRLF / BOM / NBSP / 行段分隔符 / 末尾换行的下标与裁切', () => {
  // BOM 当空白裁掉；CRLF 的 \r 裁掉但下一行 start 仍按两个字符算；末尾换行之后多一条空行不算段
  assert.deepEqual(paragraphs.paragraphRanges('\uFEFF第一行\r\n\r\n第三行\r\n'), [
    { start: 1, end: 4, paragraph: 1, line: 1 },
    { start: 8, end: 11, paragraph: 2, line: 3 }
  ]);
  // CRLF 与 LF 的段落结构一致，只是下标差一个 \r（每行多 1）
  assert.deepEqual(paragraphs.paragraphRanges('ab\r\ncd'), [
    { start: 0, end: 2, paragraph: 1, line: 1 },
    { start: 4, end: 6, paragraph: 2, line: 2 }
  ]);
  assert.deepEqual(paragraphs.paragraphRanges('ab\ncd'), [
    { start: 0, end: 2, paragraph: 1, line: 1 },
    { start: 3, end: 5, paragraph: 2, line: 2 }
  ]);
  // NBSP / 全角空格 / 行段分隔符 U+2028 都在 \s 里：只在行首行尾裁掉，行内不动
  assert.deepEqual(paragraphs.paragraphRanges('a\u00a0b\n\u00a0\u3000\nc\u2028'), [
    { start: 0, end: 3, paragraph: 1, line: 1 },
    { start: 7, end: 8, paragraph: 2, line: 3 }
  ]);
  // 代理对按 UTF-16 代码单元计下标（不切开、不改成码点数）
  assert.deepEqual(paragraphs.paragraphRanges('😀😀\n😀'), [
    { start: 0, end: 4, paragraph: 1, line: 1 },
    { start: 5, end: 7, paragraph: 2, line: 2 }
  ]);
  // 只有换行：一行都成不了段
  assert.deepEqual(paragraphs.paragraphRanges('\n\n'), []);
});

test('lineRanges：每行（含空行）的区间，blank 认全角空格 / CR / 制表', () => {
  assert.deepEqual(paragraphs.lineRanges('ab\n\ncd\n'), [
    { start: 0, end: 2, line: 1, blank: false },
    { start: 3, end: 3, line: 2, blank: true },
    { start: 4, end: 6, line: 3, blank: false },
    { start: 7, end: 7, line: 4, blank: true }
  ]);
  // CRLF：行区间含 \r（这一层不裁空白，裁切由 trimmedRange / paragraphRanges 做）
  assert.deepEqual(paragraphs.lineRanges('ab\r\ncd'), [
    { start: 0, end: 3, line: 1, blank: false },
    { start: 4, end: 6, line: 2, blank: false }
  ]);
  assert.deepEqual(paragraphs.lineRanges(''), [{ start: 0, end: 0, line: 1, blank: true }]);
  assert.deepEqual(
    paragraphs.lineRanges(`${FW}${FW}\n \t\nx`).map((line) => line.blank),
    [true, true, false]
  );
});

test('trimmedRange：去两端空白（含全角空格 / NBSP），全空白返回 null', () => {
  assert.deepEqual(paragraphs.trimmedRange('  a  ', 0, 5), { start: 2, end: 3 });
  assert.deepEqual(paragraphs.trimmedRange(`${FW}${FW}b${FW}`, 0, 4), { start: 2, end: 3 });
  assert.deepEqual(paragraphs.trimmedRange('a\u00a0', 0, 2), { start: 0, end: 1 });
  assert.deepEqual(paragraphs.trimmedRange('a\tb', 0, 3), { start: 0, end: 3 }, '行内空白不动');
  // 全空白 / 空区间 → null（paragraphRanges 靠这个跳过空行）
  assert.equal(paragraphs.trimmedRange(`${FW}${FW}`, 0, 2), null);
  assert.equal(paragraphs.trimmedRange(' \t', 0, 2), null);
  assert.equal(paragraphs.trimmedRange('ab', 1, 1), null);
  // 只裁 [start, end) 这一段，区间外的空白不碰
  assert.deepEqual(paragraphs.trimmedRange('  a  ', 2, 3), { start: 2, end: 3 });
});

test('非字符串入参：统一到宽松侧（null / 数字 / 布尔），字符串输入一律不变', () => {
  // 这是改前就存在的实现差异：旧 tts.paragraphRanges 会抛 TypeError，旧 editor-logic 会转字符串。
  // 本轮统一到 toText（宽松侧），因为产品调用方永远传字符串；边界数字写死，避免以后又漂。
  assert.deepEqual(paragraphs.paragraphRanges(null), []);
  assert.deepEqual(paragraphs.paragraphRanges(undefined), []);
  assert.deepEqual(paragraphs.paragraphRanges(123), [{ start: 0, end: 3, paragraph: 1, line: 1 }]);
  assert.deepEqual(paragraphs.paragraphRanges(false), [{ start: 0, end: 5, paragraph: 1, line: 1 }]);
  assert.deepEqual(paragraphs.lineRanges(null), [{ start: 0, end: 0, line: 1, blank: true }]);
  assert.deepEqual(paragraphs.lineRanges(123), [{ start: 0, end: 3, line: 1, blank: false }]);
});

// 跨实现闸门用的输入：覆盖两端真正的边界形态（core 侧 txt 可能带 CRLF / BOM，
// 渲染层 textarea 是 LF；全角缩进、行尾空白、空行、末尾换行、代理对、超长段都在内）。
const CORPUS = [
  '',
  ' ',
  '\n',
  '\n\n',
  '\r\n',
  '\uFEFF',
  'a',
  'a\n',
  'a\nb',
  'a\r\nb',
  'a\r\n',
  'a\r\rb',
  '  a  \n\n  b\n',
  `${FW}${FW}第一段。${FW}${FW}\n\n第二段！\n   \n\t第三段？`,
  `${FW}\n${FW}${FW}\n`,
  '没有缩进的正文\r\n第二行\r\n\r\n\r\n第三行',
  '第一段。\n\n第二段，长一点。\n  \n第三段！\n',
  'a\tb\n\t\n c ',
  '　a　　\n　　\nb　',
  '😀😀\n😀',
  'x\u00a0y\n\u00a0\nz',
  'x\u2028y\n\u2029\nz',
  '\u3000\u3000\u3000\n\u3000\n',
  '第一行\r\n\r\n第三行\r\n\r\n\r\n',
  'ab\n\ncd\n',
  '甲。\n乙！\n丙？',
  '字'.repeat(1200),
  `${FW}${FW}${'字'.repeat(501)}${FW}${FW}`
];

test('跨实现一致性闸门：同一批输入下 core/tts.js / editor-logic.js / core/paragraphs.js 结果逐字一致', () => {
  for (const text of CORPUS) {
    const expected = JSON.stringify(paragraphs.paragraphRanges(text));
    assert.equal(JSON.stringify(tts.paragraphRanges(text)), expected, `tts 与共享实现不一致：${JSON.stringify(text.slice(0, 20))}`);
    assert.equal(JSON.stringify(logic.paragraphRanges(text)), expected, `editor-logic 与共享实现不一致：${JSON.stringify(text.slice(0, 20))}`);
    assert.equal(JSON.stringify(logic.lineRanges(text)), JSON.stringify(paragraphs.lineRanges(text)), 'lineRanges 必须是同一份');
    // 朗读切分（buildChunks）里的段落数来自这一份：core/tts.js 先做「去 BOM + CRLF 归一成 LF」再切，
    // 所以按归一后的文本对照（单独 CR 是 \n 之外的另一种换行，只有归一这一步会改变段落数）。
    const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    assert.equal(
      tts.buildChunks(text).paragraphs,
      paragraphs.paragraphRanges(normalized).length,
      `朗读的段落数必须来自共享实现：${JSON.stringify(text.slice(0, 20))}`
    );
  }
});

test('跨实现一致性闸门：两端拿到的是同一个函数引用，不是各自留的副本', () => {
  assert.equal(logic.paragraphRanges, paragraphs.paragraphRanges);
  assert.equal(logic.lineRanges, paragraphs.lineRanges);
  assert.equal(tts.paragraphRanges, paragraphs.paragraphRanges);
  // 对外形状固定：三个函数，多一个少一个都要在评审里看到
  assert.deepEqual(Object.keys(paragraphs).sort(), ['lineRanges', 'paragraphRanges', 'trimmedRange']);
});

test('静态闸门：三个函数只剩 core/paragraphs.js 一处实现', () => {
  const files = [];
  for (const dir of ['core', 'renderer']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (name.endsWith('.js')) files.push(`${dir}/${name}`);
    }
  }
  files.push('main.js', 'preload.js');
  // 定义形状：function name(  /  name = function  /  name = (…)=>  /  name = (…) {  都算一份实现
  const patterns = [
    { re: /\bfunction\s+(paragraphRanges|lineRanges|trimmedRange)\s*\(/, what: '函数声明' },
    { re: /\b(paragraphRanges|lineRanges|trimmedRange)\s*=\s*(function|\()/, what: '赋值式实现' }
  ];
  const offenders = [];
  for (const rel of files) {
    if (rel === 'core/paragraphs.js') continue;
    const source = read(rel);
    for (const { re, what } of patterns) {
      const hit = re.exec(source);
      if (hit) offenders.push(`${rel} 里的 ${hit[1]}（${what}）`);
    }
  }
  assert.deepEqual(offenders, [], '段落 / 行 / 去空白只许 core/paragraphs.js 一处实现，消费方一律引用它');
  // 闸门本身不许是空转：三个名字必须真的在 core/paragraphs.js 里定义
  for (const name of ['trimmedRange', 'lineRanges', 'paragraphRanges']) {
    assert.match(PARAGRAPHS_SOURCE, new RegExp(`function\\s+${name}\\s*\\(`), `core/paragraphs.js 必须定义 ${name}`);
  }
});

test('静态闸门：两个消费方都接上 core/paragraphs.js，index.html 顺序正确', () => {
  const ttsSource = read('core/tts.js');
  assert.match(ttsSource, /const paragraphsLib = require\('\.\/paragraphs'\);/, 'core/tts.js 要 require ./paragraphs');
  assert.match(ttsSource, /const \{ trimmedRange, paragraphRanges \} = paragraphsLib;/, 'core/tts.js 要从共享实现取这两个函数');

  const logicSource = read('renderer/editor-logic.js');
  assert.match(
    logicSource,
    /require\('\.\.\/core\/paragraphs'\)/,
    'editor-logic.js 的 Node 分支要从 ../core/paragraphs 取依赖'
  );
  assert.match(
    logicSource,
    /root\.CWEditorLogic = factory\(root\.CWCommon, root\.CWChapters, root\.CWParagraphs\);/,
    'editor-logic.js 的浏览器分支要传 window.CWParagraphs'
  );
  assert.match(
    logicSource,
    /throw new Error\('CWEditorLogic：core\/paragraphs\.js 没有先加载'\);/,
    '缺 core/paragraphs.js 必须明确报错，不许静默降级'
  );
  assert.match(
    logicSource,
    /const \{ trimmedRange, lineRanges, paragraphRanges \} = paragraphsLib;/,
    'editor-logic.js 要从共享实现取三个函数'
  );

  const paragraphsAt = INDEX_SOURCE.indexOf('src="../core/paragraphs.js"');
  assert.ok(paragraphsAt > 0, 'index.html 必须加载 core/paragraphs.js');
  assert.equal(INDEX_SOURCE.split('src="../core/paragraphs.js"').length - 1, 1, 'core/paragraphs.js 只该加载一次，别重复引');
  const logicAt = INDEX_SOURCE.indexOf('src="editor-logic.js"');
  assert.ok(logicAt > 0, 'index.html 里找不到 editor-logic.js');
  assert.ok(paragraphsAt < logicAt, 'core/paragraphs.js 必须排在 editor-logic.js 之前（否则启动即报错）');
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWParagraphs，结果与 Node 侧一致', () => {
  const { win } = loadInBrowserSandbox(['core/paragraphs.js']);
  assert.equal(typeof win.CWParagraphs, 'object');
  assert.deepEqual(Object.keys(win.CWParagraphs).sort(), ['lineRanges', 'paragraphRanges', 'trimmedRange']);
  const text = `${FW}${FW}第一段。\n\n第二段！\n`;
  assert.deepEqual(
    JSON.parse(JSON.stringify(win.CWParagraphs.paragraphRanges(text))),
    paragraphs.paragraphRanges(text),
    '浏览器分支与 Node 分支必须同一份实现'
  );
  assert.equal(win.CWCommon, undefined, '单独加载 paragraphs 不该顺手造出别的全局');
});

test('core/paragraphs.js 是纯逻辑：不 require 任何模块，也不碰 process / window / document', () => {
  assert.equal(/require\s*\(/.test(PARAGRAPHS_CODE), false, '不许 require（fs / path / electron / 别的 core 模块都不行）');
  assert.equal(/\bprocess\s*\./.test(PARAGRAPHS_CODE), false, '不许碰 process');
  assert.equal(/\bwindow\s*\./.test(PARAGRAPHS_CODE), false, '不许碰 window');
  assert.equal(/\bdocument\s*\./.test(PARAGRAPHS_CODE), false, '不许碰 document');
  assert.equal(/electron/.test(PARAGRAPHS_CODE), false, '不许出现 electron');
  assert.equal(/fs\s*\./.test(PARAGRAPHS_CODE), false, '不读盘 / 不写盘');
});
