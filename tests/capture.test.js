'use strict';
// 剪贴板捕获纯逻辑（core/capture.js）的单测：
//   · 保留的旧接口：归一化 / 标题识别 / 同行拆分 / 正字数口径 / 常量；
//   · 新接口 splitRecordTitle：三条优先规则 + 边界（99/100 字、标题 40 字、正文 50 字、空行、inline）；
//   · 新接口 recordPreview：300 字 / 6 行截断，列表与主进程共用。
const test = require('node:test');
const assert = require('node:assert/strict');
const capture = require('../core/capture');

const BODY = '正文内容要继续写下去，不能只有标题没有东西可写。'.repeat(4); // 96 字（≥50，够规则①用）

// ---------- 保留的旧接口 ----------

test('归一化：去 BOM / CRLF / 行尾空白 / 首尾空行', () => {
  const text = '\uFEFF\r\n\r\n第1章 开端  \r\n\r\n正文  \r\n\r\n';
  assert.equal(capture.normalizeCaptureText(text), '第1章 开端\n\n正文');
  assert.equal(capture.normalizeCaptureText(null), '');
  assert.equal(capture.normalizeCaptureText(undefined), '');
});

test('标题识别与同行拆分保留：looksLikeHeading / splitInlineHeading', () => {
  assert.equal(capture.looksLikeHeading('第1章 开端'), true);
  assert.equal(capture.looksLikeHeading('第１章　雪夜'), true, '全角数字也认');
  assert.equal(capture.looksLikeHeading('第1話 某个日常'), true, '日文「話」也认');
  assert.equal(capture.looksLikeHeading('这是一段普通正文，不是章节标题。'), false);
  // 锚点兜底比较宽松（浏览器里没有 core/txt.js 的 parseHeading 可用）：只要以「第X节 / 第X章…」
  // 开头就算「像标题」。splitRecordTitle 规则①再用「标题 ≤40 字 + 其余正文 ≥50 字」收窄。
  assert.equal(capture.looksLikeHeading('第三节课结束时，大部分学生已经瘫在座位上。'), true);
  assert.deepEqual(capture.splitInlineHeading('第1章 开端　直到她真的死去，我也没能认清自己。'), {
    title: '第1章 开端',
    body: '直到她真的死去，我也没能认清自己。'
  });
  assert.equal(capture.splitInlineHeading('撞见了幽灵 直到她真的死去。'), null, '没有锚点不猜');
  assert.equal(capture.splitInlineHeading(`第1章 ${'长'.repeat(50)}　正文`), null, '标题超 40 字不拆');
});

test('正字数口径走 core/chapters.js 同一份：空白（含全角空格 / 换行）不算字', () => {
  assert.equal(capture.countChars(' a　b\t\n'), 2);
  assert.equal(capture.countChars(null), 0);
  assert.equal(capture.countChars('正文。'), 3);
});

test('常量与错误类型保留', () => {
  assert.equal(capture.MAX_NAME_LENGTH, 40);
  assert.equal(capture.MAX_TITLE_LENGTH, 40, '旧名字保留（渲染层过去的引用）');
  assert.equal(capture.MAX_BODY_CHARS, 100000);
  const err = new capture.CaptureError('TOO_LARGE', 'x');
  assert.equal(err.name, 'CaptureError');
  assert.equal(err.code, 'TOO_LARGE');
  assert.ok(err instanceof Error);
});

test('旧逐行表单专用导出已删除（主进程只走 capture:commit-record）', () => {
  for (const name of [
    'analyzeCapturedText',
    'prepareCaptureCommit',
    'composeBody',
    'detectNoise',
    'warning',
    'MIN_BODY_CHARS',
    'LARGE_BODY_CHARS',
    'MAX_SCAN_LINES',
    'KINDS'
  ]) {
    assert.equal(capture[name], undefined, `${name} 应已随逐行表单删除`);
  }
});

// ---------- splitRecordTitle 规则①：标题行 ----------

test('规则①：标题行当章名；标题行不进正文；紧随标题的空行去掉；正文内部空行原样保留', () => {
  const text = ['第1章 开端', '', BODY, '', '第二段。', '', '第三段。'].join('\n');
  const parts = capture.splitRecordTitle(text);
  assert.equal(parts.title, '第1章 开端');
  assert.equal(parts.titleOnly, false);
  assert.equal(parts.reason, 'heading');
  assert.equal(parts.body, `${BODY}\n\n第二段。\n\n第三段。`, '标题后的空行不进正文，正文内部空行保留');
  assert.ok(!parts.body.includes('第1章'), '标题行不进正文');
  assert.equal(parts.body.startsWith('\n'), false, '正文不以空行开头');
});

test('规则①：标题行与正文紧挨着（没有空行）也照常拆', () => {
  const parts = capture.splitRecordTitle(['第1章 开端', BODY].join('\n'));
  assert.equal(parts.title, '第1章 开端');
  assert.equal(parts.body, BODY);
});

test('规则①：CRLF 记录先归一化再判断', () => {
  const parts = capture.splitRecordTitle(`第1章 开端\r\n\r\n${BODY}\r\n`);
  assert.equal(parts.title, '第1章 开端');
  assert.equal(parts.body, BODY);
});

test('规则①边界：正文恰好 50 字才认标题；49 字不认、落到规则②整条当章名', () => {
  const exactly50 = capture.splitRecordTitle(['第1章 开端', '字'.repeat(50)].join('\n'));
  assert.equal(exactly50.title, '第1章 开端');
  assert.equal(exactly50.body, '字'.repeat(50));
  assert.equal(exactly50.reason, 'heading');

  const only49 = capture.splitRecordTitle(['第1章 开端', '字'.repeat(49)].join('\n'));
  assert.equal(only49.titleOnly, true);
  assert.equal(only49.body, '');
  assert.equal(only49.title, `第1章 开端 ${'字'.repeat(49)}`, '规则①不成立 → 整条当章名（换行折成一个空格）');
});

test('规则①标题长度边界：40 字算标题；41 字不认标题（长内容整条当正文）', () => {
  const title40 = `第1章 ${'长'.repeat(36)}`;
  assert.equal(title40.length, 40);
  const ok = capture.splitRecordTitle([title40, '', BODY].join('\n'));
  assert.equal(ok.title, title40);
  assert.equal(ok.body, BODY);

  const title41 = `第1章 ${'长'.repeat(37)}`;
  assert.equal(title41.length, 41);
  const rejected = capture.splitRecordTitle([title41, '', BODY].join('\n'));
  assert.equal(rejected.title, '', '标题超过 40 字不认');
  assert.equal(rejected.titleOnly, false);
  assert.equal(rejected.reason, 'body');
  assert.equal(rejected.body, [title41, '', BODY].join('\n'), '整条原样当正文（那行长标题也留着）');
});

test('规则①只看首个非空行：第二行才像标题也不认（正文行不能被拎出来当章名）', () => {
  const text = ['开头这段是正文，不是标题。', '', '第1章 开端', '', BODY].join('\n');
  const parts = capture.splitRecordTitle(text);
  assert.equal(parts.title, '');
  assert.equal(parts.reason, 'body');
  assert.ok(parts.body.includes('第1章 开端'), '后面那行标题原样留在正文里');
});

test('规则① inline 标题：标题部分去掉，同行剩余正文是第一段，后面空行原样保留', () => {
  const inlineBody = '直到她真的死去，我也没能认清自己到底爱她多，还是恨她多。';
  const text = [`第1章 开端　${inlineBody}`, '', BODY].join('\n');
  const parts = capture.splitRecordTitle(text);
  assert.equal(parts.title, '第1章 开端');
  assert.equal(parts.reason, 'inline-heading');
  assert.equal(parts.body, `${inlineBody}\n\n${BODY}`, '第一段与第二段之间的空行保留一个');
  assert.ok(!parts.body.includes('第1章'), '标题部分不进正文');
});

test('规则① inline 且剩余正文太短：不认标题，落到规则②', () => {
  const parts = capture.splitRecordTitle('第1章 开端　只有一句话。');
  assert.equal(parts.titleOnly, true);
  assert.equal(parts.title, '第1章 开端 只有一句话。');
  assert.equal(parts.body, '');
});

// ---------- splitRecordTitle 规则②：整条不足 100 字当章名 ----------

test('规则②/③边界：整条 99 字当章名，100 字起整条当正文', () => {
  const text99 = '字'.repeat(99);
  const p99 = capture.splitRecordTitle(text99);
  assert.deepEqual(
    { title: p99.title, body: p99.body, titleOnly: p99.titleOnly, reason: p99.reason },
    { title: text99, body: '', titleOnly: true, reason: 'title-only' }
  );

  const text100 = '字'.repeat(100);
  const p100 = capture.splitRecordTitle(text100);
  assert.deepEqual(
    { title: p100.title, body: p100.body, titleOnly: p100.titleOnly, reason: p100.reason },
    { title: '', body: text100, titleOnly: false, reason: 'body' }
  );
});

test('规则②按正字数（不算空白）判边界：99 个字 + 空行仍当章名，标题折成一个空格', () => {
  const text = `${'字'.repeat(50)}\n\n\n${'词'.repeat(49)}`;
  const parts = capture.splitRecordTitle(text);
  assert.equal(parts.titleOnly, true);
  assert.equal(parts.title, `${'字'.repeat(50)} ${'词'.repeat(49)}`, '空白折成一个空格 + trim');
  assert.equal(parts.body, '');
});

test('规则②：41–99 字的短内容整条当章名（允许超过 40 字，作者拍板的例外）', () => {
  const text = '短'.repeat(60);
  const parts = capture.splitRecordTitle(text);
  assert.equal(parts.titleOnly, true);
  assert.equal(parts.title, text);
  assert.equal(parts.title.length, 60, '章名可以超过 40 字');
  assert.equal(parts.body, '');
  assert.equal(parts.reason, 'title-only');
});

// ---------- splitRecordTitle 规则③：长内容整条当正文 ----------

test('规则③：100 字以上、认不出标题 → 全文当正文、章名留空', () => {
  const first = '这是一整篇没有章节标题的短篇小说，第一行是正文不能当章名。';
  const parts = capture.splitRecordTitle([first, '', BODY].join('\n'));
  assert.equal(parts.title, '');
  assert.equal(parts.titleOnly, false);
  assert.equal(parts.reason, 'body');
  assert.equal(parts.body, capture.normalizeCaptureText([first, '', BODY].join('\n')));
});

test('规则③：不再做干扰行识别——标题前的标签行会让标题规则不成立（整条当正文）', () => {
  const text = ['#原创 百合 yuri', '', '第1章 开端', '', BODY].join('\n');
  const parts = capture.splitRecordTitle(text);
  assert.equal(parts.title, '', '首个非空行是标签行，不认标题');
  assert.equal(parts.reason, 'body');
  assert.ok(parts.body.includes('#原创'));
  assert.ok(parts.body.includes('第1章 开端'));
});

// ---------- splitRecordTitle 边界 / 选项 ----------

test('空文本 / 全空白：title / body 都空、reason=empty', () => {
  for (const value of ['', null, undefined, '  \r\n\r\n', '　\n']) {
    assert.deepEqual(capture.splitRecordTitle(value), {
      title: '',
      body: '',
      titleOnly: false,
      reason: 'empty'
    });
  }
});

test('选项：可覆盖标题长度 / 正文下限 / 整条当章名阈值（测试与调参用；坏值回默认）', () => {
  const relaxed = capture.splitRecordTitle(['第1章 开端', '字'.repeat(20)].join('\n'), { minBodyChars: 10 });
  assert.equal(relaxed.title, '第1章 开端');
  assert.equal(relaxed.body, '字'.repeat(20));

  const stricter = capture.splitRecordTitle(['第1章 开端', '字'.repeat(20)].join('\n'), { minBodyChars: 30 });
  assert.equal(stricter.titleOnly, true, '正文不足下限 → 规则②');

  const longer = capture.splitRecordTitle('字'.repeat(30), { titleOnlyMaxChars: 20 });
  assert.equal(longer.titleOnly, false, '超过自定义阈值就走规则③');
  assert.equal(longer.body, '字'.repeat(30));

  const badOption = capture.splitRecordTitle('字'.repeat(30), { titleOnlyMaxChars: 0 });
  assert.equal(badOption.titleOnly, true, '坏阈值回默认 100');
});

// ---------- recordPreview：列表用的截断正文 ----------

test('recordPreview：空文本返回空串、CRLF→LF、300 字 / 6 行以内原样', () => {
  assert.equal(capture.recordPreview(''), '');
  assert.equal(capture.recordPreview(null), '');
  assert.equal(capture.recordPreview(undefined), '');
  assert.equal(capture.recordPreview('  \n\t '), '', '全空白也算空文本');
  assert.equal(capture.recordPreview('第一行\r\n第二行'), '第一行\n第二行');
  const exactChars = '字'.repeat(300);
  assert.equal(capture.recordPreview(exactChars), exactChars, '正好 300 字不截断、不加省略号');
  const sixLines = ['一', '二', '三', '四', '五', '六'].join('\n');
  assert.equal(capture.recordPreview(sixLines), sixLines, '正好 6 行不截断');
});

test('recordPreview：超过 300 字截字加「…」；超过 6 行截行加「…」', () => {
  assert.equal(capture.recordPreview('字'.repeat(301)), `${'字'.repeat(300)}…`);
  const sevenLines = ['一', '二', '三', '四', '五', '六', '七'].join('\n');
  assert.equal(capture.recordPreview(sevenLines), `${['一', '二', '三', '四', '五', '六'].join('\n')}…`);
});

test('recordPreview：先截行再截字，末尾只加一个省略号', () => {
  const wide = Array.from({ length: 8 }, () => '段'.repeat(80)).join('\n'); // 8 行 × 80 字
  const preview = capture.recordPreview(wide);
  assert.ok(preview.endsWith('…'));
  assert.equal(Array.from(preview).length, 301, '6 行仍有 485 字 → 再截到 300 字 + 省略号');
  assert.equal(preview.split('\n').length, 4, '300 字落在第 4 行中间');
});

test('recordPreview：按码点截字，emoji 不会被切成半个', () => {
  assert.equal(capture.recordPreview('😀'.repeat(305)), `${'😀'.repeat(300)}…`);
});

test('recordPreview 选项：可覆盖字数 / 行数上限（坏值回默认）', () => {
  assert.equal(capture.recordPreview('字'.repeat(20), { maxChars: 10 }), `${'字'.repeat(10)}…`);
  assert.equal(capture.recordPreview(['一', '二', '三'].join('\n'), { maxLines: 2 }), '一\n二…');
  assert.equal(capture.recordPreview('字'.repeat(301), { maxChars: 0 }), `${'字'.repeat(300)}…`, '坏值回默认 300');
});

test('recordPreview 不改原文：只做 CRLF→LF 与截断，不去首尾空白 / 不去空行', () => {
  const text = '  第一行  \n\n第二行  ';
  assert.equal(capture.recordPreview(text), text);
});
