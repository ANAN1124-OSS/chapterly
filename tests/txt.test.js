const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decodeBuffer,
  splitChapters,
  splitChaptersRaw,
  parseHeading,
  isChapterHeading,
  splitLongUntitled,
  LONG_UNTITLED_THRESHOLD,
  LONG_UNTITLED_CHUNK
} = require('../core/txt');

test('解码：UTF-8 无 BOM / 有 BOM', () => {
  assert.equal(decodeBuffer(Buffer.from('第一章 雪夜', 'utf8')), '第一章 雪夜');
  assert.equal(decodeBuffer(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('带BOM', 'utf8')])), '带BOM');
});

test('解码：UTF-16LE / UTF-16BE', () => {
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文', 'utf16le')]);
  assert.equal(decodeBuffer(le), '中文');
  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('中文', 'utf16le').swap16()]);
  assert.equal(decodeBuffer(be), '中文');
});

test('解码：GBK 中文', () => {
  // “第一章 中文”的 GBK 字节
  const gbk = Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x20, 0xd6, 0xd0, 0xce, 0xc4]);
  assert.equal(decodeBuffer(gbk), '第一章 中文');
});

test('标题识别：各种常见写法', () => {
  assert.equal(parseHeading('第1章：开端').name, '开端');
  assert.equal(parseHeading('第1章--超级标题').name, '超级标题');
  assert.equal(parseHeading('第 12 章 雪夜').name, '雪夜');
  assert.equal(parseHeading('　　第一章 雪夜').name, '雪夜');
  assert.equal(parseHeading('第1章').name, '');
  assert.equal(parseHeading('第3章”TSF变身游戏').name, 'TSF变身游戏');
  assert.equal(parseHeading('楔子').name, '楔子');
  assert.equal(parseHeading('序章 缘起').name, '序章 缘起');
  assert.equal(parseHeading('Chapter 5 The End').name, 'Chapter 5 The End');
});

test('标题识别：正文段落不会被误判', () => {
  assert.equal(isChapterHeading('他把第一章读了三遍。'), false);
  assert.equal(isChapterHeading('　　“第1章？”她问。'), false);
  assert.equal(isChapterHeading('第1章的剧情很精彩'), true, '行首「第1章」这类仍按标题处理');
  assert.equal(isChapterHeading('接着写道：第2章开始'), false);
  assert.equal(isChapterHeading(''), false);
});

test('切章：标准多章结构', () => {
  const text = ['第1章 开端', '', '正文一', '', '第2章 转折', '', '正文二'].join('\n');
  const parts = splitChapters(text);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].title, '开端');
  assert.equal(parts[0].text, '正文一');
  assert.equal(parts[1].title, '转折');
  assert.equal(parts[1].text, '正文二');
});

test('切章：没有标题行 → 一章「全文」', () => {
  const parts = splitChapters('这是一整篇没有章节标题的短篇小说。\n\n第二段。');
  assert.equal(parts.length, 1);
  assert.equal(parts[0].title, '全文');
  assert.ok(parts[0].text.includes('第二段'));
});

test('切章：第一个标题之前的内容作为「开篇」保留', () => {
  const text = ['书名：测试', '作者：某人', '', '第1章 开端', '', '正文一'].join('\n');
  const parts = splitChapters(text);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].title, '开篇');
  assert.ok(parts[0].text.includes('作者：某人'));
  assert.equal(parts[1].title, '开端');
});

test('切章：CRLF 与空章都能处理', () => {
  const text = '第1章\r\n\r\n内容一\r\n\r\n第2章\r\n\r\n第3章\r\n\r\n内容三';
  const parts = splitChapters(text);
  assert.equal(parts.length, 3);
  assert.equal(parts[1].title, '');
  assert.equal(parts[1].text, '');
  assert.equal(parts[2].text, '内容三');
});

test('原样切章：章名照抄原文标题、正文不做 trim', () => {
  const text = '第1章 开端\n\n正文一，带 空格。\n\n第2章 转折\n\n正文二\n';
  const parts = splitChaptersRaw(text);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].title, '第1章 开端');
  assert.equal(parts[0].body, '\n正文一，带 空格。\n');
  assert.equal(parts[1].title, '第2章 转折');
  assert.equal(parts[1].body, '\n正文二\n');
});

test('原样切章：开头有书名/引子时并入第一章正文，不多出「开篇」章', () => {
  const text = '书名：测试\n作者：某人\n\n　　楔子\n\n引子内容\n\n第1章 开端\n\n正文一';
  const parts = splitChaptersRaw(text);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].title, '楔子');
  assert.ok(parts[0].body.includes('书名：测试'));
  assert.ok(parts[0].body.includes('引子内容'));
  assert.equal(parts[1].title, '第1章 开端');
});

test('标题识别扩展：第X幕 / 第X话 / 番外（1）/ 前言（无色）/ 尾声】 / 长标题', () => {
  assert.equal(parseHeading('第一幕 穿越为白发金眸小龙娘！').name, '穿越为白发金眸小龙娘！');
  assert.equal(parseHeading('第3话 某个日常').name, '某个日常');
  assert.ok(parseHeading('番外（1）'));
  assert.ok(parseHeading('番外篇：后日谈'));
  assert.ok(parseHeading('前言（无色）'));
  assert.ok(parseHeading('尾声】（纯剧情，无H内容）'));
  assert.ok(parseHeading('后记和设定说明'));
  assert.ok(parseHeading('附录：设定集'));
  // 各种奇怪但真实的标题写法
  assert.ok(parseHeading('附录，兔女郎的酒吧密会'));
  assert.ok(parseHeading('尾声？：'));
  assert.ok(parseHeading('后记。'));
  assert.ok(parseHeading('番外·终:马屌比赛的结局'));
  assert.ok(parseHeading('第四章;转生成铃兰小姐后，为了还债只能被迫在浴馆中打工'));
  assert.ok(parseHeading('番外，目前可以解锁的素世的调教表格：'));
  // 有分隔符的长标题（很多网文标题上百字）也应识别
  const longTitle = `第2章  ${'照顾男友一起按摩的清纯少女'.repeat(4)}`;
  assert.ok(parseHeading(longTitle));
  assert.ok(parseHeading(longTitle).name.length > 30);
});

test('正文长句不会被当成标题', () => {
  assert.equal(isChapterHeading('第三节课结束时，大部分学生已经如同从水里捞出来一般，瘫在各自狼藉的座位上。'), false);
  assert.equal(isChapterHeading('第三节课上，老师讲的内容我一个字也没听进去。'), false);
  assert.equal(isChapterHeading('尾声的序章，便是菈妮丝代表蔷薇骑士团，为岚等三人献上了蔷薇骑士团的信物徽章。'), false);
  assert.equal(isChapterHeading('第二节课后，紫萱又靠了过来，身上那股浓郁的雌性荷尔蒙媚香立刻把我包围了。'), false);
  // 没有分隔符但很短：仍可能是标题
  assert.ok(parseHeading('第一章男朋友（无色）'));
});

test('原样切章：没有标题行时整本一章、正文原样', () => {
  const text = '这是一整篇没有章节标题的短篇小说。\n\n第二段。\n';
  const parts = splitChaptersRaw(text);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].title, '');
  assert.equal(parts[0].body, text);
});

// b10（剪贴板联动方案 §5 b10）：导入无标题长文的兜底切片。
test('b10：无标题长文按段落空行切片——每片 ≤5 万字、拼回原文逐字相同、章名「第 N 部分」', () => {
  const paragraph = `${'这'.repeat(9998)}\n\n`; // 每段正好 10000 字符（含段落空行）
  const text = paragraph.repeat(13); // 13 万字
  const parts = splitLongUntitled(text);
  assert.deepEqual(parts.map((part) => part.title), ['第 1 部分', '第 2 部分', '第 3 部分']);
  assert.equal(parts.map((part) => part.body).join(''), text, '拼回去必须与原文逐字相同');
  assert.deepEqual(parts.map((part) => part.body.length), [50000, 50000, 30000]);
  for (const part of parts.slice(0, -1)) assert.ok(part.body.length <= LONG_UNTITLED_CHUNK);
  assert.ok(parts[0].body.endsWith('\n\n'), '在段落空行之后断开（下一段从正文开头开始）');
  assert.equal(parts[1].body.startsWith('\n'), false);
});

test('b10：没有段落空行时按目标长度硬切（仍不丢字、不切碎代理对）', () => {
  const text = '字'.repeat(120001); // 完全没有空行
  const parts = splitLongUntitled(text);
  assert.deepEqual(parts.map((part) => part.body.length), [50000, 50000, 20001]);
  assert.equal(parts.map((part) => part.body).join(''), text);

  // 让硬切点正好落在一个 emoji 的代理对中间：切点必须回退一个码元
  const emoji = '\u{1F600}';
  const tricky = `${'a'.repeat(49999)}${emoji}${'b'.repeat(70000)}`;
  const trickyParts = splitLongUntitled(tricky);
  assert.equal(trickyParts.map((part) => part.body).join(''), tricky);
  assert.equal(/[\uD800-\uDBFF]$/.test(trickyParts[0].body), false, '不能以孤立的高代理结尾');
  assert.equal(/^[\uDC00-\uDFFF]/.test(trickyParts[1].body), false, '不能以孤立的低代理开头');
});

test('b10：阈值以下原样返回（普通无标题短文不切片）、参数可注入', () => {
  const short = '短'.repeat(LONG_UNTITLED_THRESHOLD);
  assert.deepEqual(splitLongUntitled(short), [{ title: '', body: short }]);
  const injected = splitLongUntitled('字'.repeat(2500), { threshold: 2000, chunkChars: 1000 });
  assert.deepEqual(injected.map((part) => part.body.length), [1000, 1000, 500]);
  assert.equal(injected.map((part) => part.body).join(''), '字'.repeat(2500));
  // 空文本 / 坏值不炸：空文本 → 一片空正文（调用方另有空正文校验）
  assert.deepEqual(splitLongUntitled(''), [{ title: '', body: '' }]);
  assert.deepEqual(splitLongUntitled(null), [{ title: '', body: '' }]);
});

// 1.6.0 A5 / P-06（审计「平方拷贝」）：splitLongUntitled 旧实现每切一片就把剩余全文 rest.slice(cut)
// 复制一遍，整篇的字符拷贝量是 O(n²/chunk)；1 万字单行切成 10 片要复制约 5.4 万字符。
// 这里用一次性的 String.prototype.slice 计数把「这次调用一共复制了多少字符」量出来
// （注入断言，不测墙钟），同时钉住改前后逐字等价：切分的产物、片数、拼回原文都不许变。
function countSliceCopiedChars(fn) {
  const originalSlice = String.prototype.slice;
  let copied = 0;
  let active = true;
  String.prototype.slice = function (start, end) {
    const value = originalSlice.call(this, start, end);
    if (active) copied += value.length;
    return value;
  };
  try {
    const result = fn();
    active = false;
    return { result, copied };
  } finally {
    active = false;
    String.prototype.slice = originalSlice;
  }
}

test('b10 性能（P-06）：1 万字单行逐字等价，且不再平方复制剩余全文', () => {
  const text = '字'.repeat(10000);
  // 低于默认阈值：原样返回（等价性基线）
  assert.deepEqual(splitLongUntitled(text), [{ title: '', body: text }]);

  const injected = { threshold: 2000, chunkChars: 1000 };
  const { result: parts, copied } = countSliceCopiedChars(() => splitLongUntitled(text, injected));
  assert.deepEqual(
    parts.map((part) => part.title),
    Array.from({ length: 10 }, (_, i) => `第 ${i + 1} 部分`)
  );
  assert.deepEqual(parts.map((part) => part.body.length), Array(10).fill(1000));
  assert.equal(parts.map((part) => part.body).join(''), text, '拼回去必须与原文逐字相同');
  assert.ok(
    copied <= text.length * 4,
    `切片复制的字符数应与文本长度同一量级（不做平方拷贝）：copy=${copied} n=${text.length}`
  );
});
