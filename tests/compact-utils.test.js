// v1.8.0 WP-31（A2 / A3 / A9 / A10）：跨模块小工具收编的回归锚点。
//
// 这一轮把四类「同一概念多份实现」收进 core/common.js，纪律是**行为零变化**：
//   · A2 全角→半角换算：jump / proofread（只换数字）与 command-registry / settings-ia（全角 ASCII + 全角空格）
//     原来各写一份 0xfee0 减法；汉字范围串 format / proofread 各写一份 → common.HAN_RANGES。
//   · A3 体量文案：storage.formatByteSize ↔ importer.formatImportSize 逐字同构；128 MB 单文件整读上限
//     两份 → common.formatByteSize / common.MAX_TEXT_BYTES。
//   · A9 路径等价：手写 path.resolve().toLowerCase() / path.dirname().toLowerCase() 比较 → core/path-utils.js
//     的 pathKey（全仓唯一「同一路径」口径）。
//   · A10 convertCurlyQuotes：逐字 out += ch 造串 → parts.push + join（与 convertPunct 的 P-07 同口径）。
//
// 测试分两层（与 tests/common.test.js 一致）：
//   1. 行为：把收编前的旧实现原样抄成参照实现，用固定语料做差分对账；调用点再各钉一条实际输出。
//   2. 回归闸门：全仓只剩 core/common.js 一份实现；原来的四处调用点必须引用共享函数。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const common = require('../core/common');
const format = require('../core/format');
const proofread = require('../core/proofread');
const jump = require('../core/jump');
const pathUtils = require('../core/path-utils');
const registryModule = require('../renderer/command-registry');
const settingsIa = require('../renderer/settings-ia');
const importer = require('../core/importer');
const storage = require('../core/storage');
const ipcPaths = require('../core/ipc-paths');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CORE_FILES = fs
  .readdirSync(path.join(ROOT, 'core'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => `core/${name}`);
const RENDERER_FILES = fs
  .readdirSync(path.join(ROOT, 'renderer'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => `renderer/${name}`);
const SCRIPT_FILES = fs
  .readdirSync(path.join(ROOT, 'scripts'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => `scripts/${name}`);
// v1.8.0 WP-34（V114）：主进程 IPC 域模块（导出 / 校对 / 书 CRUD）搬进 ipc/，同属产品代码，一起扫。
const IPC_FILES = fs
  .readdirSync(path.join(ROOT, 'ipc'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => `ipc/${name}`);

// 去掉注释（块注释 + 整行 // 注释）：静态闸门只看代码，注释里解释「以前怎么写」不算回潮。
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

// ---------- A2 全角 → 半角 ----------

// 参照实现 1（收编前 core/jump.js / core/proofread.js）：只换全角数字。
function referenceHalfWidthDigits(text) {
  return String(text == null ? '' : text).replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
}

// 参照实现 2（收编前 renderer/command-registry.js）：全角 ASCII 两段 replace。
function referenceHalfWidthAscii(text) {
  return String(text == null ? '' : text)
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

// 参照实现 3（收编前 renderer/settings-ia.js）：逐码点循环。
function referenceSettingsIaHalfWidth(text) {
  const raw = String(text == null ? '' : text);
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0);
    if (code === 0x3000) out += ' ';
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - 0xfee0);
    else out += ch;
  }
  return out;
}

const HALF_WIDTH_CORPUS = [
  '',
  'abc 123',
  'ＡＢＣ１２３',
  '！＂＃＄％＆＇（）＊＋，－．／：；＜＝＞？＠［＼］＾＿｀｛｜｝～',
  '　行首全角空格　与两个　　',
  '中文，。、；：！？「」『』',
  '𠮷😀ＡＢ１２',
  'Ａ',
  '～',
  '\uFF00',
  '\uFF01',
  '\uFF5E',
  '\uFF5F',
  '\uFF20',
  '\u3000',
  '\u3001',
  '混合 ＡＢＣ 𠮷 １２３ ！＠＃ $%^',
  'İstanbul Ａbc',
  'ｈｔｔｐ：／／ｅｘａｍｐｌｅ．ｃｏｍ／？ａ＝１',
  '第１２章：夜雨'
];

test('A2：toHalfWidth 与收编前四处的换算逐字等价（全角 ASCII / 全角空格 / 仅数字两档）', () => {
  const extra = [null, undefined, 42, '　', '０９', 'ＡＢＣ１２３！？', '中文，。'];
  for (const sample of [...HALF_WIDTH_CORPUS, ...extra]) {
    const expected = referenceHalfWidthAscii(sample);
    assert.equal(common.toHalfWidth(sample), expected, `toHalfWidth 与旧 ASCII 换算不一致：${String(sample)}`);
    assert.equal(common.toHalfWidth(sample), referenceSettingsIaHalfWidth(sample), `与旧 settings-ia 口径不一致：${String(sample)}`);
    assert.equal(
      common.toHalfWidth(sample, { digitsOnly: true }),
      referenceHalfWidthDigits(sample),
      `digitsOnly 与旧数字换算不一致：${String(sample)}`
    );
  }
  // 边界：全角 ASCII 区间端点换算、区间外不动；全角空格 → 半角空格；全角逗号属于区间内（→ ','）
  assert.equal(common.toHalfWidth('\uFF01\uFF5E\uFF5F\uFF00\u3000\u3001'), '!~\uFF5F\uFF00 \u3001');
  assert.equal(common.toHalfWidth('中文，。「」𠮷😀'), '中文,。「」𠮷😀', '全角逗号在 U+FF01–U+FF5E 内；。、「」不在区间内，原样保留');
});

test('A2：四个调用点的实际输出与收编前逐字一致', () => {
  assert.equal(registryModule.normalize('ＡＢＣ　１２'), 'abc 12');
  assert.equal(registryModule.normalize('ＢＯＯＫ　书签'), 'book 书签');
  assert.equal(registryModule.normalize(null), '');
  assert.equal(settingsIa.normalizeQuery('ＡＢＣ　１２'), 'abc 12');
  assert.equal(settingsIa.normalizeQuery('每日　目标'), '每日 目标');
  assert.equal(settingsIa.normalizeQuery('　多余   空白　'), '多余 空白');
  // 跳章输入：全角数字照旧能当章号，全角字母 / 小数点照旧不算
  assert.equal(jump.parseChapterNumber('１２'), 12);
  assert.equal(jump.parseChapterNumber('第１２章'), 12);
  assert.equal(jump.parseChapterNumber('１２.５'), null);
  assert.equal(jump.parseChapterNumber('Ａ１２'), null);
  // 校对「全角数字」：仍只换数字，字母不换
  const issues = proofread.proofreadText('ＡＢＣ１２３').issues.filter((issue) => issue.rule === 'fullwidth-digit');
  assert.deepEqual(issues.map((issue) => [issue.match, issue.suggestion]), [['１２３', '123']]);
});

test('A2 闸门：全角换算与汉字范围全仓只剩 core/common.js 一份', () => {
  const files = [...CORE_FILES, ...RENDERER_FILES, ...IPC_FILES, 'main.js', ...SCRIPT_FILES];
  for (const rel of files) {
    if (rel === 'core/common.js') continue;
    const source = read(rel);
    assert.equal(/- 0xfee0/.test(source), false, `${rel} 里不该再有 0xfee0 换算（用 core/common.js 的 toHalfWidth）`);
    assert.equal(/function toHalfWidth\s*\(/.test(source), false, `${rel} 里不该再有第二份 toHalfWidth`);
    assert.equal(
      source.includes('\\u{20000}-\\u{2a6df}'),
      false,
      `${rel} 里不该再内联汉字范围串（用 core/common.js 的 HAN_RANGES）`
    );
  }
  // 四个原调用点必须引用共享函数
  for (const rel of ['core/jump.js', 'core/proofread.js', 'renderer/command-registry.js', 'renderer/settings-ia.js']) {
    assert.ok(read(rel).includes('toHalfWidth'), `${rel} 应该引用 core/common.js 的 toHalfWidth`);
  }
  // format / proofread 只取范围串，不再自己定义一份
  for (const rel of ['core/format.js', 'core/proofread.js']) {
    const source = read(rel);
    assert.ok(source.includes('HAN_RANGES'), `${rel} 应该引用 core/common.js 的 HAN_RANGES`);
    assert.equal(/const HAN_RANGES\s*=/.test(source), false, `${rel} 里不该再定义一份 HAN_RANGES`);
  }
  // 范围串行为不变：扩展 B 汉字仍算汉字（format 的标点 / 空格判定，proofread 的重复用词）
  assert.equal(format.convertPunct('𠮷,').text, '𠮷，');
  assert.equal(format.removeCjkSpaces('𠮷 𠮷').text, '𠮷𠮷');
  const jiRepeat = proofread.proofreadText('𠮷𠮷，𠮷𠮷，𠮷𠮷。');
  assert.equal(jiRepeat.issues.some((issue) => issue.rule === 'repeat-word' && issue.match === '𠮷𠮷'), true);
  assert.equal(new RegExp(`[${common.HAN_RANGES}]`, 'u').test('𠮷'), true);
});

// ---------- A3 体量文案 / 单文件上限 ----------

const REF_SIZE_UNITS = ['B', 'KB', 'MB', 'GB'];
// 参照实现：收编前 core/storage.js 的 formatByteSize（与 core/importer.js 的 formatImportSize 逐字同构）
function referenceFormatByteSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '0 B';
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < REF_SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  const shown = value < 10 ? value.toFixed(1) : String(Math.round(value));
  return `${shown} ${REF_SIZE_UNITS[unit]}`;
}

test('A3：formatByteSize 与收编前的 storage / importer 两份实现逐项一致', () => {
  const samples = [
    0, 1, 512, 1023, 1024, 1025, 1536, 10 * 1024, 999.6, 128 * 1024 * 1024,
    3 * 1024 * 1024 * 1024, -1, -1024, NaN, Infinity, '2048', null, undefined, 'abc'
  ];
  for (const sample of samples) {
    assert.equal(common.formatByteSize(sample), referenceFormatByteSize(sample), `体量文案不一致：${String(sample)}`);
  }
  // 对外名字与常量同源：importer 的 formatImportSize 就是 common.formatByteSize 那一份
  assert.equal(importer.formatImportSize, common.formatByteSize);
  assert.equal(importer.formatImportSize(128 * 1024 * 1024), '128 MB');
  assert.equal(importer.MAX_IMPORT_BYTES, common.MAX_TEXT_BYTES);
  assert.equal(storage.MAX_CHAPTER_READ_BYTES, common.MAX_TEXT_BYTES);
  assert.equal(common.MAX_TEXT_BYTES, 128 * 1024 * 1024);
  // 错误文案仍带体量、仍不带路径
  const problem = storage.readSizeProblem(common.MAX_TEXT_BYTES + 1, { code: 'X', label: '备份' });
  assert.equal(problem.code, 'X');
  assert.ok(problem.message.includes('超过单文件读取上限 128 MB'));
});

test('A3 闸门：体量文案与 128 MB 上限全仓只剩 core/common.js 一份', () => {
  const files = [...CORE_FILES, ...RENDERER_FILES, ...IPC_FILES, 'main.js', ...SCRIPT_FILES];
  for (const rel of files) {
    if (rel === 'core/common.js') continue;
    const source = read(rel);
    assert.equal(/function formatByteSize\s*\(/.test(source), false, `${rel} 里不该再有第二份 formatByteSize`);
    assert.equal(/function formatImportSize\s*\(/.test(source), false, `${rel} 里不该再有第二份 formatImportSize`);
    assert.equal(source.includes('128 * 1024 * 1024'), false, `${rel} 里不该再内联 128 MB 上限（用 common.MAX_TEXT_BYTES）`);
  }
});

// ---------- A9 路径等价判定 ----------

test('A9 闸门：「同一路径 / 同一目录」判定统一走 core/path-utils.js 的 pathKey', () => {
  const files = [...CORE_FILES, ...RENDERER_FILES, ...IPC_FILES, 'main.js'];
  for (const rel of files) {
    if (rel === 'core/path-utils.js') continue;
    const code = stripComments(read(rel));
    assert.equal(
      /path\.dirname\([^)]*\)\.toLowerCase\(\)/.test(code),
      false,
      `${rel} 不许再手写 dirname 小写比较（用 pathUtils.pathKey）`
    );
    assert.equal(
      /path\.resolve\([^)]*\)\.toLowerCase\(\)/.test(code),
      false,
      `${rel} 不许再手写 path.resolve().toLowerCase()（用 pathUtils.pathKey）`
    );
  }
  // 四处「同一路径 / 同一目录」判定都换成 pathKey
  assert.ok(read('core/storage.js').includes('pathUtils.pathKey(bookPath)'), 'bookLockKey 应走 pathKey');
  assert.ok(read('core/storage.js').includes('pathUtils.pathKey(path.dirname(source))'), '撤销删除 _trash 判定应走 pathKey');
  assert.ok(read('core/ipc-paths.js').includes('pathUtils.pathKey(path.dirname(target))'), 'assertBookPath 应走 pathKey');
  assert.ok(read('ipc/book.js').includes('pathUtils.pathKey(path.dirname(target))'), 'book:delete 应走 pathKey');
  // 行为不变：大小写 / 末尾分隔符 / 相对写法都算同一个目录，越界照旧拒绝
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-compact-utils-')), '书架');
  const book = path.join(root, '某本书');
  assert.equal(ipcPaths.assertBookPath(book, root), book);
  assert.equal(ipcPaths.assertBookPath(book + path.sep, root), book);
  assert.equal(ipcPaths.assertBookPath(book.toUpperCase(), root), book.toUpperCase());
  assert.throws(() => ipcPaths.assertBookPath(path.join(root, '..', '逃出去'), root), /只能操作书架目录下的书/);
  assert.equal(pathUtils.pathKey(book), pathUtils.pathKey(book + path.sep));
  assert.equal(pathUtils.pathKey(book), pathUtils.pathKey(book.toUpperCase()));
});

// ---------- A10 弯引号转换 ----------

// 参照实现：收编前 core/format.js 的 convertCurlyQuotes（逐字 out += ch 造串 + lastChar(out)）。
const REF_HAN_RE = new RegExp(`[${common.HAN_RANGES}]`, 'u');
const REF_CJK_NEIGHBOR_RE = new RegExp(`[${common.HAN_RANGES}，。；：！？、…—（）《》“”‘’\\u3000]`, 'u');
const REF_ASCII_ALNUM_RE = /[A-Za-z0-9]/;

function refCharAt(text, index) {
  if (index < 0 || index >= text.length) return '';
  const code = text.codePointAt(index);
  return code > 0xffff ? text.slice(index, index + 2) : text[index];
}

function refLastChar(text) {
  if (!text) return '';
  const low = text.charCodeAt(text.length - 1);
  if (low >= 0xdc00 && low <= 0xdfff && text.length > 1) return text.slice(-2);
  return text.slice(-1);
}

function referenceConvertCurlyQuotes(text) {
  const source = String(text == null ? '' : text);
  let count = 0;
  let out = '';
  let doubleOpen = false;
  let singleOpen = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch !== '"' && ch !== "'") {
      out += ch;
      continue;
    }
    const prev = refLastChar(out);
    const next = refCharAt(source, i + 1);
    const prevCjk = REF_CJK_NEIGHBOR_RE.test(prev);
    const nextCjk = REF_CJK_NEIGHBOR_RE.test(next);
    const prevAlnum = REF_ASCII_ALNUM_RE.test(prev);
    const nextAlnum = REF_ASCII_ALNUM_RE.test(next);
    if (!((prevCjk || nextCjk) && !prevAlnum && !nextAlnum)) {
      out += ch;
      continue;
    }
    const isDouble = ch === '"';
    const opened = isDouble ? doubleOpen : singleOpen;
    const prevHan = REF_HAN_RE.test(prev);
    const nextHan = REF_HAN_RE.test(next);
    let isOpen;
    if (nextHan && (!prev || (prevCjk && !prevHan))) {
      isOpen = true;
    } else if (prevCjk && !nextHan) {
      isOpen = false;
    } else {
      isOpen = !opened;
    }
    out += isOpen ? (isDouble ? '“' : '‘') : (isDouble ? '”' : '’');
    count += 1;
    if (isDouble) doubleOpen = isOpen;
    else singleOpen = isOpen;
  }
  return { text: out, count };
}

// 固定种子的伪随机语料（失败可复现）：引号 / 汉字 / 英文数字 / 代理对 / 孤立低代理都覆盖。
const CURLY_ALPHABET = [
  '"', "'", '中', '文', '字', '，', '。', '！', ' ',
  'A', 'z', '0', '9', '-', '“', '”', '‘', '’', '𠮷', '😀', '\uDC00'
];

function mixedCurlyCorpus(seed, length) {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const chunks = [];
  let produced = 0;
  while (produced < length) {
    const item = CURLY_ALPHABET[Math.floor(next() * CURLY_ALPHABET.length)];
    chunks.push(item);
    produced += item.length;
  }
  return chunks.join('');
}

test('A10：convertCurlyQuotes 改 parts.push + join 后与旧算法逐字等价（语料差分）', () => {
  const samples = [
    '',
    '他说"你好"。',
    "'单引号'测试",
    "don't stop",
    '"English"',
    '中文"English"中文',
    '𠮷"你好"',
    `𠮷"𠮷"`,
    '"引号"开头',
    '结尾"',
    '前"',
    '中\uDC00"你好"', // 孤立低代理：旧 lastChar(out) 取最近两个码元的退化口径也要一致
    '他说"\uDC00"好', // 转换后的引号（'“'）后面紧跟孤立低代理：prev 必须取「产出串」而不是源串
    '😀"好"',
    '「组合。"test"」',
    '他说, "你好"',
    '“已弯引号”不重复转',
    '两"个"引"号"交替',
    mixedCurlyCorpus(20261114, 20000),
    mixedCurlyCorpus(987654321, 50000)
  ];
  for (const sample of samples) {
    const actual = format.convertCurlyQuotes(sample);
    const expected = referenceConvertCurlyQuotes(sample);
    assert.deepEqual(actual, expected, `弯引号转换结果要逐字相同（文本长度 ${sample.length}）`);
  }
  // 结构闸门：数组 push + join，不再逐字 out += 造中间串；不再保留只为旧实现服务的 lastChar 死代码
  const source = read('core/format.js');
  const start = source.indexOf('function convertCurlyQuotes(');
  assert.ok(start > 0, 'core/format.js 里找不到 convertCurlyQuotes');
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, 'convertCurlyQuotes 的函数体没有按预期结束');
  const body = source.slice(start, end);
  assert.equal(/out\s*\+=\s*ch/.test(body), false, 'convertCurlyQuotes 不许再逐字 out += 造串（长段落是 O(n²) 中间串）');
  assert.equal(/out\s*=\s*out\s*\+/.test(body), false, 'convertCurlyQuotes 不许用 out = out + … 拼串');
  assert.ok(body.includes('parts.push('), 'convertCurlyQuotes 应该用 parts.push 收集字符');
  assert.ok(body.includes('.join('), 'convertCurlyQuotes 应该最后把数组 join 成一个字符串');
  assert.equal(/function lastChar\s*\(/.test(source), false, 'lastChar 已无调用方，删掉别留死代码');
});