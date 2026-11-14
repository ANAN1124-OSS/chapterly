// 章节标题词表唯一事实源（core/heading.js）的单测：A1 / V113 / v1.8.0 WP-30。
//
// 这一轮把「导入（core/txt.js）/ 捕获（core/capture.js）/ 显示（core/chapters.js）」三套
// 标题词表收成 core/heading.js 一份，差异只剩三个场景的严格度（profile）。行为零变化是硬要求，
// 所以测试分两层：
//   ① 跨场景期望表：同一行文本在三个场景各得到什么结果，逐行钉死（含 V113 点名的
//      繁体「話」/ 全角数字 / 「开篇」三类已知差异）；
//   ② 回归闸门：三个消费方只从 core/heading.js 取词表（不许再抄一份）、UMD 两条加载路径、
//      index.html 的加载顺序、缺 heading 时加载期直接报错。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const heading = require('../core/heading');
const txt = require('../core/txt');
const capture = require('../core/capture');
const chapters = require('../core/chapters');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const INDEX_SOURCE = read('renderer/index.html');
const CORE_FILES = fs
  .readdirSync(path.join(ROOT, 'core'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => `core/${name}`);
const RENDERER_FILES = fs
  .readdirSync(path.join(ROOT, 'renderer'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => `renderer/${name}`);

// ---------------------------------------------------------------- ① 跨场景期望表

// [一行文本, 导入（txt.parseHeading）, 捕获（capture.looksLikeHeading）, 显示（RAW_TITLE_RE）]
// 期望值全部按收编前的实际行为写出（20f4d7b → WP-30 前逐项取样），不是按「理想规则」写：
//   · 第1話 / 第１話 / 第１章：导入不认（不认繁体「話」/ 全角数字），捕获认（宽松锚点），显示属「未带号」
//   · 开篇：只有显示场景认（core/chapters.js 的 SPECIAL 词表多这一项）
//   · 第三节课…：capture 的锚点只是「像不像标题」的兜底，仍是 true；导入 / 显示不算
const EXPECTATIONS = [
  ['第1章 雪夜', true, true, true],
  ['第 12 章 雪夜', true, true, true],
  ['第1章：开端', true, true, true],
  ['第1节：节奏', true, true, true],
  ['第3话 某个日常', true, true, true],
  ['第1話 某个日常', false, true, false],
  ['第１話 雪夜', false, true, false],
  ['第１章　雪夜', false, true, false],
  ['第1節 節奏', false, false, false],
  ['第三节课结束时，大部分学生已经瘫在座位上。', false, true, true],
  ['楔子', true, true, true],
  ['前言（无色）', true, true, true],
  ['番外篇：后日谈', true, true, true],
  ['后记和设定说明', true, true, true],
  ['附录，兔女郎的酒吧密会', true, true, true],
  ['尾声的序章，便是菈妮丝代表蔷薇骑士团献上信物徽章。', false, true, true],
  ['开篇', false, false, true],
  ['Chapter 5 The End', true, true, true],
  ['chapter 7 小写', true, true, true],
  ['第一章男朋友（无色）', true, true, true],
  ['正文段落', false, false, false],
  ['他把第一章读了三遍。', false, false, false],
  ['　　“第1章？”她问。', false, false, false]
];

test('跨场景期望表：同一行在导入 / 捕获 / 显示三处的识别结果逐行钉死（V113）', () => {
  const rows = EXPECTATIONS.map(([line, importOk, captureOk, displayOk]) => {
    const actual = [
      line,
      Boolean(txt.parseHeading(line)),
      capture.looksLikeHeading(line.trim()),
      heading.anchorRe('display').test(line)
    ];
    assert.deepEqual(actual, [line, importOk, captureOk, displayOk], `场景结果与期望表不一致：${line}`);
    // 显示场景的合集正则就是 core/chapters.js 用的那一份
    assert.equal(chapters.RAW_TITLE_RE.test(line), displayOk, `RAW_TITLE_RE 与 anchorRe('display') 必须同源：${line}`);
    return line;
  });
  assert.equal(rows.length, EXPECTATIONS.length);
});

test('跨场景差异是有意的：話 / 全角数字 / 开篇 三类的实际行为', () => {
  // 繁体「話」+ 全角数字：导入不认、捕获认（V113 点名的 pixiv 用例）
  assert.equal(txt.parseHeading('第１話 雪夜'), null);
  assert.equal(txt.isChapterHeading('第１話 雪夜'), false);
  assert.equal(capture.looksLikeHeading('第１話 雪夜'), true);
  assert.deepEqual(capture.splitInlineHeading('第１話 雪夜　正文从这里开始。'), {
    title: '第１話 雪夜',
    body: '正文从这里开始。'
  });
  // 显示场景：未带号的原文标题会被补「第N章：」；带号的 Chapter N 原样
  assert.equal(chapters.formatTitle({}, 5, '第１話 雪夜'), '第6章：第１話 雪夜');
  assert.equal(chapters.formatTitle({}, 5, 'Chapter 6 The End'), 'Chapter 6 The End');
  // 「开篇」只在显示场景算特殊标题（导入 / 捕获都没有这个词）
  assert.equal(txt.parseHeading('开篇'), null);
  assert.equal(capture.looksLikeHeading('开篇'), false);
  assert.equal(chapters.formatTitle({}, 0, '开篇'), '第1章：开篇');
  // 同一套词表在三个 profile 里的差异只来自这几段
  assert.ok(heading.numeralClass('capture').includes('０'));
  assert.equal(heading.numeralClass('import').includes('０'), false);
  assert.equal(heading.numeralClass('display').includes('０'), false);
  assert.ok(heading.markerClass('capture').includes('話'));
  assert.equal(heading.markerClass('import').includes('話'), false);
  assert.equal(heading.markerClass('display').includes('話'), false);
  assert.ok(heading.keywordSource('display').includes('开篇'));
  assert.equal(heading.keywordSource('import').includes('开篇'), false);
  assert.equal(heading.keywordSource('capture').includes('开篇'), false);
});

test('PROFILES / profile：只认三个场景，坏场景直接抛 TypeError，表是冻结的', () => {
  assert.deepEqual(Object.keys(heading.PROFILES), ['import', 'capture', 'display']);
  assert.equal(Object.isFrozen(heading.PROFILES), true);
  assert.equal(Object.isFrozen(heading.PROFILES.capture), true);
  for (const scene of ['import', 'capture', 'display']) {
    assert.equal(heading.profile(scene), heading.PROFILES[scene]);
  }
  for (const bad of ['Import', '', null, undefined, 'anchor']) {
    assert.throws(() => heading.profile(bad), /CWHeading：没有 .* 这个场景/);
  }
  assert.equal(heading.numeralRun('import'), '{1,12}');
  assert.equal(heading.numeralRun('capture'), '{1,12}');
  assert.equal(heading.numeralRun('display'), '+');
  assert.equal(heading.ENGLISH_SOURCE, 'Chapter\\s+\\d+');
});

test('正则工厂：关键词 / 数字 / 合集三个出口各自带对场景差异，且都能直接 test', () => {
  // 关键词分支：import / capture 带 Chapter N，display 不带（它的 Chapter N 在数字分支）
  assert.equal(new RegExp(`^(?:${heading.keywordSource('import')})$`, 'i').test('Chapter 5'), true);
  assert.equal(new RegExp(`^(?:${heading.keywordSource('capture')})$`, 'i').test('Chapter 5'), true);
  assert.equal(new RegExp(`^(?:${heading.keywordSource('display')})$`, 'i').test('Chapter 5'), false);
  // 数字分支：display 带 Chapter N，import / capture 不带
  assert.equal(heading.numberedSource('display').includes(heading.ENGLISH_SOURCE), true);
  assert.equal(heading.numberedSource('import').includes(heading.ENGLISH_SOURCE), false);
  assert.equal(heading.numberedSource('capture').includes(heading.ENGLISH_SOURCE), false);
  // 三张表的口径：numberedRe 只认带号，keywordRe 只认关键词，anchorRe 是两者合集
  assert.equal(heading.numberedRe('import').test('第1章 雪夜'), true);
  assert.equal(heading.keywordRe('import').test('第1章 雪夜'), false);
  assert.equal(heading.keywordRe('import').test('楔子'), true);
  assert.equal(heading.numberedRe('import').test('楔子'), false);
  assert.equal(heading.anchorRe('import').test('楔子'), true);
  assert.equal(heading.numberedRe('display').test('第1話 雪夜'), false);
  assert.equal(heading.anchorRe('capture').test('第1話 雪夜'), true);
  // 不带 /g，重复 test 不会受 lastIndex 影响
  const re = heading.anchorRe('capture');
  assert.equal(re.test('第1章 一'), true);
  assert.equal(re.test('第1章 一'), true);
});

// ---------------------------------------------------------------- ② 回归闸门

test('静态闸门：三个消费方只从 core/heading.js 取词表，词表全仓只有一份', () => {
  const consumers = ['core/txt.js', 'core/capture.js', 'core/chapters.js'];
  for (const rel of consumers) {
    assert.ok(read(rel).includes("require('./heading')"), `${rel} 的 Node 分支必须 require('./heading')`);
    assert.equal(/章节回卷集篇部话幕/.test(read(rel)), false, `${rel} 不许再抄一份单位词表`);
    assert.equal(/楔子\|序章/.test(read(rel)), false, `${rel} 不许再抄一份关键词词表`);
  }
  // 浏览器两条路：chapters / capture 从 window.CWHeading 取
  for (const rel of ['core/chapters.js', 'core/capture.js']) {
    assert.ok(read(rel).includes('root.CWHeading'), `${rel} 的浏览器分支必须取 window.CWHeading`);
  }
  // 词表本体只许 core/heading.js 一个文件（含单位串与关键词串）
  const productFiles = [...CORE_FILES, ...RENDERER_FILES, 'main.js', 'preload.js'];
  const markerOwners = productFiles.filter((rel) => read(rel).includes('章节回卷集篇部话幕'));
  const keywordOwners = productFiles.filter((rel) => read(rel).includes('楔子|序章'));
  assert.deepEqual(markerOwners, ['core/heading.js']);
  assert.deepEqual(keywordOwners, ['core/heading.js']);
});

test('静态闸门：core/heading.js 保持纯逻辑（无 require / fs / process / electron）', () => {
  const source = read('core/heading.js');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/require\s*\(/.test(code), false, '不许 require 任何模块');
  assert.equal(/\bprocess\s*\./.test(code), false, '不许碰 process');
  assert.equal(/\bfs\s*\./.test(code), false, '不许碰 fs');
  assert.equal(/electron/.test(code), false, '不许出现 electron');
  assert.equal(/\bdocument\s*\./.test(code), false, '不许碰 document');
});

test('UMD：Node 与浏览器两条路同一套 API / 同一份行为', () => {
  const source = read('core/heading.js');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'core/heading.js' });
  const browser = sandbox.CWHeading;
  assert.equal(typeof browser, 'object');
  assert.deepEqual(Object.keys(browser).sort(), Object.keys(heading).sort());
  assert.equal(browser.anchorRe('capture').test('第１話 雪夜'), true);
  assert.equal(browser.anchorRe('import').test('第１話 雪夜'), false);
  assert.equal(browser.profile('display').numeralRun, '+');
  // Node 分支（真 require）与浏览器分支互不污染
  assert.equal(typeof heading.anchorRe, 'function');
});

test('静态闸门：index.html 里 core/heading.js 只加载一次，排在 chapters.js / capture.js 之前', () => {
  assert.equal(INDEX_SOURCE.split('src="../core/heading.js"').length - 1, 1, 'core/heading.js 只该加载一次');
  const at = (needle) => {
    const index = INDEX_SOURCE.indexOf(needle);
    assert.notEqual(index, -1, `index.html 里找不到 ${needle}`);
    return index;
  };
  assert.ok(at('../core/common.js') < at('../core/heading.js'), 'heading.js 必须排在 common.js 之后');
  assert.ok(at('../core/heading.js') < at('../core/chapters.js'), 'heading.js 必须排在 chapters.js 之前');
  assert.ok(at('../core/heading.js') < at('../core/capture.js'), 'heading.js 必须排在 capture.js 之前');
});

test('缺 core/heading.js 时 capture.js / chapters.js 都在加载期明确报错（不退回本地词表）', () => {
  const captureSource = read('core/capture.js');
  const chaptersSource = read('core/chapters.js');
  const commonSource = read('core/common.js');
  // capture.js：先有 common（否则先报 common），缺 window.CWHeading 时报 heading
  const bareCapture = {};
  vm.createContext(bareCapture);
  vm.runInContext(commonSource, bareCapture, { filename: 'core/common.js' });
  assert.throws(
    () => vm.runInContext(captureSource, bareCapture, { filename: 'core/capture.js' }),
    /CWCapture：core\/heading\.js 没有先加载/
  );
  // chapters.js：先 load common，再确认缺 heading 报错
  const bareChapters = {};
  vm.createContext(bareChapters);
  vm.runInContext(commonSource, bareChapters, { filename: 'core/common.js' });
  assert.throws(
    () => vm.runInContext(chaptersSource, bareChapters, { filename: 'core/chapters.js' }),
    /CWChapters：core\/heading\.js 没有先加载/
  );
  // 反过来：三个全局都在时浏览器分支能正常挂载（core/txt.js 不在浏览器加载链里，capture 走 null）
  const wired = {};
  vm.createContext(wired);
  vm.runInContext(commonSource, wired, { filename: 'core/common.js' });
  vm.runInContext(read('core/heading.js'), wired, { filename: 'core/heading.js' });
  vm.runInContext(chaptersSource, wired, { filename: 'core/chapters.js' });
  vm.runInContext(captureSource, wired, { filename: 'core/capture.js' });
  assert.equal(typeof wired.CWChapters.formatTitle, 'function');
  assert.equal(wired.CWCapture.looksLikeHeading('第１話 雪夜'), true);
  assert.equal(typeof wired.CWCapture.countChars, 'function');
  assert.equal(wired.CWChapters.formatTitle({}, 0, '开篇'), '第1章：开篇');
});