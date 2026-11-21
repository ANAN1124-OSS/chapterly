'use strict';
// WP11（审计 B3/B4）捕获性能锚点。
//
// 这一组用例只钉两件事：**成本**（线性化 / 有界前缀 / list() 不重算）与**输出逐字节不变**。
// 参考实现（referenceRecordPreview / referencePreviewOf）是审计前算法的语义基线，只用来
// 验「换实现不换口径」，不是实现基线——修完以后产品代码里不许再出现参考实现的全文 split /
// Array.from 写法（R3 / R4 / R6 / R9 的静态闸钉住）。
//
//   R1 normalizeCaptureText 病态前导换行线性化（12 万空行 + 10 万字 < 500 ms）
//   R2 归一化等价表（BOM / CRLF / 孤立 CR / 行尾空白 / 全角空格 / 首尾空行 / 空白类码位 / NUL）
//   R3 静态线化闸：不再 lines.shift()
//   R4 recordPreview 有界前缀（290 万单行 < 50 ms，不再 split 全文 / Array.from 全码点）
//   R5 recordPreview 与参考实现逐字节等价（多组样本 × 多组选项）
//   R6 previewOf 有界 + 与参考实现逐字节等价（空白极值 / 跳空行 / 40 字边界）
//   R7 MAX_RAW_CHARS + checkCaptureLimits 边界（原文 3,000,000 / 字数 300,000）
//   R8 main.js commit-record 接线：先原文长度闸，再标题拆分 / 写盘
//   R9 list() 不重算预览（monkeypatch 计数 = 0）+ 空行重型队列 list() < 60 ms
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const capture = require('../core/capture');
const queueLib = require('../core/capture-queue');

const ROOT = path.join(__dirname, '..');
const ELLIPSIS = '…';
const CAPTURE_SOURCE = fs.readFileSync(path.join(ROOT, 'core', 'capture.js'), 'utf8');
const QUEUE_SOURCE = fs.readFileSync(path.join(ROOT, 'core', 'capture-queue.js'), 'utf8');

function elapsedMs(fn) {
  const startedAt = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

// （从 core/capture.js 抄来的坏值兜底：参考实现要用同一套选项口径）
function positiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.round(n));
}

// 参考实现：审计前 core/capture.js recordPreview 的原文（split 全文 + Array.from 全码点）。
function referenceRecordPreview(text, options = {}) {
  const maxChars = positiveInt(options.maxChars, capture.PREVIEW_MAX_CHARS);
  const maxLines = positiveInt(options.maxLines, capture.PREVIEW_MAX_LINES);
  let value = '';
  try {
    value = String(text == null ? '' : text);
  } catch {
    value = '';
  }
  if (!value.trim()) return '';
  value = value.replace(/\r\n?/g, '\n');
  const lines = value.split('\n');
  let truncated = lines.length > maxLines;
  const kept = truncated ? lines.slice(0, maxLines) : lines;
  let preview = kept.join('\n');
  const chars = Array.from(preview);
  if (chars.length > maxChars) {
    preview = chars.slice(0, maxChars).join('');
    truncated = true;
  }
  return truncated ? `${preview}${ELLIPSIS}` : preview;
}

// 参考实现：审计前 core/capture-queue.js previewOf 的原文（split 全文 + 首个非空行整行折叠）。
// 参考实现：与改前逐字节等价的整行写法 + CTXT-B-05 的「不切开代理对」口径。
function referencePreviewOf(text, limit = queueLib.PREVIEW_LIMIT) {
  const source = typeof text === 'string' ? text : '';
  const max = positiveInt(limit, queueLib.PREVIEW_LIMIT);
  const safeSlice = (line) => {
    let end = max;
    const code = line.charCodeAt(end - 1);
    if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1;
    return line.slice(0, end);
  };
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    return line.length > max ? `${safeSlice(line)}${ELLIPSIS}` : line;
  }
  return '';
}

// 取源码里一个顶层函数体（从 `function name(` 到下一个两空格缩进的收尾大括号），
// 让静态闸只罩这一个函数，不会被同文件其它函数的写法误判。
function sliceFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `源码里找不到 function ${name}(`);
  const end = source.indexOf('\n  }', start);
  assert.ok(end > start, `无法确定 function ${name} 的结尾`);
  return source.slice(start, end);
}

// ---------------------------------------------------------------- R1

test('R1：12 万前导换行 + 10 万字正文，归一化线性完成（< 500 ms）', () => {
  const body = '正'.repeat(100000);
  const text = `${'\n'.repeat(120000)}${body}`;
  let normalized = '';
  const ms = elapsedMs(() => {
    normalized = capture.normalizeCaptureText(text);
  });
  assert.equal(normalized, body, '首尾空行去干净、正文一字不动');
  // 审计前实测 6.35 s（每次 shift 搬整条数组 → O(n²)）；线性实现应在 10 ms 量级。
  assert.ok(ms < 500, `12 万前导换行必须线性完成，实测 ${ms.toFixed(1)} ms（审计前 6.35 s）`);
});

// ---------------------------------------------------------------- R2

test('R2：归一化等价表（BOM / CRLF / 孤立 CR / 行尾空白 / 全角空格 / 首尾空行 / NUL）', () => {
  const cases = [
    ['', ''],
    ['\uFEFF\r\n\r\n第1章 开端  \r\n\r\n正文  \r\n\r\n', '第1章 开端\n\n正文'],
    ['a\n\n', 'a'],
    ['\n', ''],
    ['   \n\n  a', '  a'],
    ['第一行\t \n\n第二行\u3000\u3000', '第一行\n\n第二行'],
    ['a\u00a0  \n\n\u00a0b', 'a\u00a0\n\n\u00a0b'],
    ['a\u2028b  \n\n', 'a\u2028b'],
    ['甲\u0000乙\n\n丙', '甲乙\n\n丙'],
    ['  \n\t ', ''],
    ['\r\r正文\r', '正文'],
    ['第1章 开端　正文从这里开始\n\n后续段落  ', '第1章 开端　正文从这里开始\n\n后续段落']
  ];
  for (const [input, expected] of cases) {
    assert.equal(capture.normalizeCaptureText(input), expected, `输入 ${JSON.stringify(input)}`);
  }
  assert.equal(capture.normalizeCaptureText(null), '');
  assert.equal(capture.normalizeCaptureText(undefined), '');
  assert.equal(capture.normalizeCaptureText(123), '123');
});

// ---------------------------------------------------------------- R3

test('R3：静态线化闸——首部空行改 findIndex + slice，不再 lines.shift()', () => {
  // 注释里说明旧写法不算回流：先剔掉行注释再判代码。
  const codeOnly = CAPTURE_SOURCE.replace(/\/\/[^\n]*/g, '');
  assert.equal(/lines\.shift\s*\(/.test(codeOnly), false, 'lines.shift() 每次 O(n)，不许回流');
  const body = sliceFunction(codeOnly, 'normalizeCaptureText');
  assert.ok(body.includes('findIndex'), '首部空行判定走 findIndex');
  assert.ok(body.includes('lines.slice('), '一次 slice 取代逐行搬移');
});

// ---------------------------------------------------------------- R4

test('R4：recordPreview 有界前缀——290 万单行 < 50 ms，且结果仍是 300 字 + …', () => {
  const text = '字'.repeat(2900000);
  const expected = `${'字'.repeat(300)}${ELLIPSIS}`;
  let preview = '';
  const ms = elapsedMs(() => {
    preview = capture.recordPreview(text);
  });
  assert.equal(preview, expected);
  // 审计前实测 99–145 ms（split 全文 + Array.from 约 290 万个临时字符串）。
  assert.ok(ms < 50, `290 万单行必须只加工前 300 个码点，实测 ${ms.toFixed(1)} ms`);

  const body = sliceFunction(CAPTURE_SOURCE, 'recordPreview');
  assert.equal(/Array\.from\s*\(/.test(body), false, '不许再物化全文码点（Array.from）');
  assert.equal(/\.split\s*\(/.test(body), false, '不许再对全文 split');
});

// ---------------------------------------------------------------- R5

test('R5：recordPreview 与参考实现逐字节等价（样本 × 选项）', () => {
  const corpus = [
    '',
    '  \n\t ',
    '第一行\r\n第二行',
    '第一行\n第二行',
    '字'.repeat(300),
    '字'.repeat(301),
    ['一', '二', '三', '四', '五', '六'].join('\n'),
    ['一', '二', '三', '四', '五', '六', '七'].join('\n'),
    `${['一', '二', '三', '四', '五', '六'].join('\n')}\n`,
    '😀'.repeat(305),
    `😀${'字'.repeat(299)}`,
    `😀${'字'.repeat(299)}字`,
    '  第一行  \n\n第二行  ',
    '\n\n\n正文在空行后面',
    'a\u2028b\nc',
    'a\rb\r\nc',
    `第1章 开端\n\n${'正文'.repeat(200)}`,
    Array.from({ length: 8 }, () => '段'.repeat(80)).join('\n'),
    '字'.repeat(1000)
  ];
  const options = [{}, { maxChars: 10 }, { maxLines: 2 }, { maxChars: 5, maxLines: 1 }, { maxChars: 0, maxLines: 0 }];
  for (const text of corpus) {
    for (const option of options) {
      assert.equal(
        capture.recordPreview(text, option),
        referenceRecordPreview(text, option),
        `text=${JSON.stringify(text.slice(0, 12))}… options=${JSON.stringify(option)}`
      );
    }
  }
});

// ---------------------------------------------------------------- R6

test('R6：previewOf 有界 + 与参考实现逐字节等价（空白极值 / 跳空行 / 40 字边界）', () => {
  const corpus = [
    '',
    '\n\n  \t \n',
    '\n\n  第1章 夜雨  \n第二行不显示',
    '标题\n\n  正文',
    '字'.repeat(40),
    '字'.repeat(41),
    '字'.repeat(45),
    'a  b\tc\n d',
    '短',
    '两个',
    'a\rb',
    '  \r\n  x',
    '\u00a0\u3000\u2028\u2029\ufeff\n\u000b\u000c\n  正文',
    '\u00a0\n\u3000\n\u2028\n  正文',
    `😀😀${'字'.repeat(60)}`,
    `x${' '.repeat(100)}y`,
    '\t\t  \t\n\n   真正的首行  后面还在\n第二行'
  ];
  const limits = [undefined, 1, 3, 40, 64];
  for (const text of corpus) {
    for (const limit of limits) {
      assert.equal(
        queueLib.previewOf(text, limit),
        referencePreviewOf(text, limit),
        `text=${JSON.stringify(text.slice(0, 12))}… limit=${limit}`
      );
    }
  }
  // 极值：290 万单行 / 20 万空行前缀都只取有界前缀
  const hugeLine = '字'.repeat(2900000);
  assert.equal(queueLib.previewOf(hugeLine), referencePreviewOf(hugeLine));
  const hugeBlanks = `${'\n'.repeat(200000)}正文`;
  assert.equal(queueLib.previewOf(hugeBlanks), '正文');

  const body = sliceFunction(QUEUE_SOURCE, 'previewOf');
  assert.equal(/\.split\s*\(/.test(body), false, '不许再对全文 split(/\r?\n/)');
});

// ---------------------------------------------------------------- R7

test('R7：MAX_RAW_CHARS 与 checkCaptureLimits 边界（原文 300 万 / 字数 30 万）', () => {
  assert.equal(capture.MAX_RAW_CHARS, 3000000, '单条原文上限与队列总量同一口径（300 万）');
  assert.ok(capture.MAX_RAW_CHARS > capture.MAX_BODY_CHARS);
  assert.equal(typeof capture.checkCaptureLimits, 'function');

  // 审计 B3 的场景：290 万前导换行 + 10 万字正文 = 原文恰好 300 万、字数 10 万 → 放行。
  const rawExactly = `${'\n'.repeat(2900000)}${'正'.repeat(100000)}`;
  assert.equal(rawExactly.length, 3000000);
  assert.deepEqual(capture.checkCaptureLimits(rawExactly), {
    tooLarge: false,
    reason: '',
    rawLength: 3000000,
    chars: 100000
  });
  // 多一个字符 → 原文闸先挡（reason='raw'），不再算字数。
  const rawOver = `${rawExactly}正`;
  assert.deepEqual(capture.checkCaptureLimits(rawOver), {
    tooLarge: true,
    reason: 'raw',
    rawLength: 3000001,
    chars: null
  });
  // 原始长度没超线、字数超线 → reason='chars'（既有口径不变）。
  assert.deepEqual(capture.checkCaptureLimits('字'.repeat(300000)), {
    tooLarge: false,
    reason: '',
    rawLength: 300000,
    chars: 300000
  });
  assert.deepEqual(capture.checkCaptureLimits('字'.repeat(300001)), {
    tooLarge: true,
    reason: 'chars',
    rawLength: 300001,
    chars: 300001
  });
  // 非字符串 / 空值按空处理（main.js 的 BAD_TEXT 闸在它之前）。
  for (const value of [null, undefined, 123, {}, '']) {
    assert.deepEqual(capture.checkCaptureLimits(value), { tooLarge: false, reason: '', rawLength: 0, chars: 0 });
  }
});

// ---------------------------------------------------------------- R8

test('R8：main.js commit-record 接线——原文闸在标题拆分 / 写盘之前', () => {
  const mainSource = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const start = mainSource.indexOf("handleBook('capture:commit-record'");
  assert.ok(start > 0, '找不到 capture:commit-record 处理器');
  const end = mainSource.indexOf("}, { mutation: 'write' });", start);
  assert.ok(end > start, '找不到 capture:commit-record 的收尾');
  const block = mainSource.slice(start, end);

  const gate = block.indexOf('captureLib.checkCaptureLimits(text)');
  const split = block.indexOf('captureLib.splitRecordTitle(text)');
  const write = block.indexOf('storage.createChapterWithText(');
  assert.ok(gate > 0, 'commit-record 必须走统一限额判定');
  assert.ok(split > gate, '原文闸必须在标题拆分之前');
  assert.ok(write > gate, '原文闸必须在任何写盘之前');
  assert.ok(block.includes('captureLib.MAX_RAW_CHARS'), '原文闸文案要用同一常量');
  assert.ok(/reason === 'raw'/.test(block), '原文超长走独立分支');
  assert.ok(block.includes('原文太长') && block.includes('内容太长'), '两条文案都在（原文 / 字数）');
  assert.equal(block.includes('captureLib.countChars(text)'), false, '字数只由统一判定算一次，不许再全串扫一遍');
  assert.equal(
    /if \(captureChars > captureLib\.MAX_BODY_CHARS\)/.test(block),
    false,
    '旧的内联字数闸由统一判定取代，不许留两份'
  );
});

// ---------------------------------------------------------------- R9

test('R9：list() 不重算预览；空行重型队列 list() < 60 ms', () => {
  const queue = queueLib.createCaptureQueue();
  const blankHeavy = `${'\n'.repeat(290000)}正`;
  for (let i = 0; i < 10; i += 1) {
    assert.equal(queue.add(`${blankHeavy}${i}`).added, true, `第 ${i + 1} 条应入队`);
  }
  const first = queue.list();
  assert.equal(first.length, 10);
  // 预览口径仍是既有的 recordPreview / previewOf（缓存 ≠ 换口径）
  assert.equal(first[0].previewText, referenceRecordPreview(`${blankHeavy}0`));
  assert.equal(first[0].preview, referencePreviewOf(`${blankHeavy}0`));

  const realRecordPreview = capture.recordPreview;
  let calls = 0;
  capture.recordPreview = (...args) => {
    calls += 1;
    return realRecordPreview(...args);
  };
  let second = null;
  let ms = 0;
  try {
    ms = elapsedMs(() => {
      second = queue.list();
    });
  } finally {
    capture.recordPreview = realRecordPreview;
  }
  assert.equal(calls, 0, 'list() 不许对条目全文重算 recordPreview（预览入队时算一次）');
  assert.deepEqual(second, first, '缓存与现算结果逐字段一致');
  // 改前实测 170–220 ms（10 条 × 29 万空行逐条重算）；缓存后应 < 1 ms。
  assert.ok(ms < 60, `空行重型队列 list() 实测 ${ms.toFixed(1)} ms`);

  const metaBody = sliceFunction(QUEUE_SOURCE, 'metaOf');
  assert.equal(metaBody.includes('previewOf('), false, 'metaOf 不许重算首行预览');
  assert.equal(metaBody.includes('recordPreview('), false, 'metaOf 不许重算截断正文预览');
  assert.equal(
    QUEUE_SOURCE.split('recordPreview(entry.text)').length - 1,
    1,
    'recordPreview(entry.text) 只出现在入队处一次（既有静态闸门口径不变）'
  );
});