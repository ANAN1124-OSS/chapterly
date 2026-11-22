// core/limits.js（三审 M2 / P1 / E1 / I5 / I8）：体量上限唯一事实源的门禁。
//
// 这个文件钉三件事：
//   ① 五条线的数值与互相关系（保存 ≤ 载入 = 救稿；128MB 字节闸门与 common 同源；20000 章与 IPC 同名）；
//   ② 唯一的校验函数（textProblem / charsProblem / chapterCountProblem / 限长 helper）的边界与文案；
//   ③ 机器清单：ipc-limits / storage / importer / crash-draft 里不许再自己定义这些字面量
//      （三审 I8 的成因就是「注释说同口径，物理上是第二份 5000000」）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const limits = require('../core/limits');
const common = require('../core/common');
const ipcLimits = require('../core/ipc-limits');
const storage = require('../core/storage');
const crashDraft = require('../core/crash-draft');
const importer = require('../core/importer');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

test('M2：五条线的数值与关系（保存 ≤ 载入 = 救稿；字节 / 章数 / 名称同源）', () => {
  assert.equal(limits.MAX_CHAPTER_SAVE_CHARS, 5000000);
  assert.equal(limits.MAX_CHAPTER_READ_CHARS, 30000000);
  assert.equal(limits.MAX_CHAPTER_RESCUE_CHARS, limits.MAX_CHAPTER_READ_CHARS);
  assert.ok(limits.MAX_CHAPTER_READ_CHARS > limits.MAX_CHAPTER_SAVE_CHARS, '载入必须比保存宽（能打开才能救稿）');
  assert.equal(limits.MAX_CHAPTER_READ_BYTES, common.MAX_TEXT_BYTES, '128MB 字面量仍只有 common 的一份');
  assert.equal(limits.MAX_CHAPTER_READ_BYTES, 128 * 1024 * 1024);
  assert.equal(limits.MAX_META_CHAPTERS, 20000);
  assert.equal(limits.MAX_CHAPTER_NAME_CHARS, 2000);
  assert.equal(limits.MAX_BOOK_TITLE_CHARS, 80);
});

test('M2：其它模块只保留对外名字，数值全部来自 core/limits.js', () => {
  assert.equal(ipcLimits.MAX_TEXT_CHARS, limits.MAX_CHAPTER_SAVE_CHARS);
  assert.equal(ipcLimits.MAX_CHAPTER_ITEMS, limits.MAX_META_CHAPTERS);
  assert.equal(ipcLimits.MAX_CHAPTER_NAME_CHARS, limits.MAX_CHAPTER_NAME_CHARS);
  assert.equal(ipcLimits.MAX_CHAPTER_RESCUE_CHARS, limits.MAX_CHAPTER_RESCUE_CHARS);
  assert.equal(storage.MAX_CHAPTER_READ_BYTES, limits.MAX_CHAPTER_READ_BYTES);
  assert.equal(storage.MAX_META_CHAPTERS, limits.MAX_META_CHAPTERS);
  assert.equal(crashDraft.MAX_TEXT_CHARS, limits.MAX_CHAPTER_SAVE_CHARS, 'I8：草稿不再自带第二份 5000000');
  assert.equal(importer.MAX_IMPORT_BYTES, limits.MAX_CHAPTER_READ_BYTES);
});

test('M2 机器清单：四个入口文件里不许再出现这些上限的定义级字面量', () => {
  const sources = {
    'core/ipc-limits.js': read('core/ipc-limits.js'),
    'core/storage.js': read('core/storage.js'),
    'core/importer.js': read('core/importer.js'),
    'core/crash-draft.js': read('core/crash-draft.js')
  };
  const forbidden = [
    [/const\s+MAX_TEXT_CHARS\s*=\s*5000000/, 'MAX_TEXT_CHARS = 5000000（改用 limits.MAX_CHAPTER_SAVE_CHARS）'],
    [/const\s+MAX_TEXT_CHARS\s*=\s*5_000_000/, 'MAX_TEXT_CHARS = 5_000_000（同上）'],
    [/const\s+MAX_META_CHAPTERS\s*=\s*20000/, 'MAX_META_CHAPTERS = 20000（改用 limits.MAX_META_CHAPTERS）'],
    [/const\s+MAX_CHAPTER_ITEMS\s*=\s*20000/, 'MAX_CHAPTER_ITEMS = 20000（改用 limits.MAX_META_CHAPTERS）'],
    [/const\s+MAX_CHAPTER_READ_BYTES\s*=\s*MAX_TEXT_BYTES/, 'MAX_CHAPTER_READ_BYTES = MAX_TEXT_BYTES（改用 limits）'],
    [/const\s+MAX_CHAPTER_NAME_CHARS\s*=\s*2000/, 'MAX_CHAPTER_NAME_CHARS = 2000（改用 limits）']
  ];
  for (const [rel, source] of Object.entries(sources)) {
    for (const [pattern, why] of forbidden) {
      assert.equal(pattern.test(source), false, `${rel} 里不许再有 ${why}`);
    }
    assert.match(source, /require\('\.\/limits'\)/, `${rel} 必须从 core/limits.js 取上限`);
  }
  // limits.js 自己也不许再写 128MB 字面量（要从 common 转发；注释里提到数字不算）
  assert.equal(/const\s+MAX_CHAPTER_READ_BYTES\s*=\s*128\s*\*\s*1024\s*\*\s*1024/.test(read('core/limits.js')), false);
});

test('textProblem：类型 / 长度边界与唯一文案（chapter:save 同源）', () => {
  assert.equal(limits.textProblem('正文'), null);
  assert.equal(limits.textProblem('字'.repeat(limits.MAX_CHAPTER_SAVE_CHARS)), null, '正好上限放行');
  assert.deepEqual(limits.textProblem(123), { code: 'BAD_TEXT', message: '正文必须是文本' });
  const over = limits.textProblem('字'.repeat(limits.MAX_CHAPTER_SAVE_CHARS + 1));
  assert.equal(over.code, 'TEXT_TOO_LARGE');
  assert.equal(over.message, '正文太长（5,000,001 字，最多 5,000,000 字）');
  assert.equal(ipcLimits.textProblem('字'.repeat(limits.MAX_CHAPTER_SAVE_CHARS + 1)).message, over.message);
  assert.equal(limits.tooLong('查找内容', 10001, 10000), '查找内容太长（10,001 字，最多 10,000 字）');
});

test('charsProblem：载入闸门按长度判定（不物化字符串），正好上限放行', () => {
  assert.equal(limits.charsProblem(0), null);
  assert.equal(limits.charsProblem(limits.MAX_CHAPTER_READ_CHARS), null);
  const over = limits.charsProblem(limits.MAX_CHAPTER_READ_CHARS + 1, { label: '章节文件「001.txt」', tail: '没有载入编辑区' });
  assert.equal(over.code, 'CHAPTER_TOO_LARGE');
  assert.equal(
    over.message,
    '章节文件「001.txt」有 30,000,001 字，超过单章上限 30,000,000 字，没有载入编辑区'
  );
  assert.equal(limits.charsProblem(11, { max: 10 }).message, '章节有 11 字，超过单章上限 10 字');
});

test('chapterCountProblem：书目章数闸门（超过才拒，20,000 放行）', () => {
  assert.equal(limits.chapterCountProblem(limits.MAX_META_CHAPTERS), null);
  assert.equal(limits.chapterCountProblem(0), null);
  const over = limits.chapterCountProblem(limits.MAX_META_CHAPTERS + 1);
  assert.equal(over.code, 'META_TOO_MANY_CHAPTERS');
  assert.equal(over.message, '书目.json 的章节记录有 20,001 条，超过单本上限 20,000 条，没有写盘');
  const importCase = limits.chapterCountProblem(limits.MAX_META_CHAPTERS + 1, {
    label: '《大部头》切出的章节',
    tail: '没有导入'
  });
  assert.equal(importCase.message, '《大部头》切出的章节有 20,001 条，超过单本上限 20,000 条，没有导入');
});

test('名称限长（I5 / N2 同源）：trim + 按码元截断，不切开代理对', () => {
  assert.equal(limits.limitChapterName('  第1章 开端  '), '第1章 开端');
  assert.equal(limits.limitChapterName(null), '');
  assert.equal(limits.limitChapterName('名'.repeat(limits.MAX_CHAPTER_NAME_CHARS)).length, limits.MAX_CHAPTER_NAME_CHARS);
  assert.equal(limits.limitChapterName('名'.repeat(limits.MAX_CHAPTER_NAME_CHARS + 1)).length, limits.MAX_CHAPTER_NAME_CHARS);
  assert.equal(limits.limitBookTitle('  星海旅人  '), '星海旅人');
  assert.equal(limits.limitBookTitle('书'.repeat(limits.MAX_BOOK_TITLE_CHARS + 10)).length, limits.MAX_BOOK_TITLE_CHARS);

  // 截断点正好落在代理对中间：回退一个码元，结果里不能出现孤立代理
  const emoji = `${'字'.repeat(limits.MAX_BOOK_TITLE_CHARS - 1)}𠮷尾`;
  const clipped = limits.limitBookTitle(emoji);
  assert.ok(clipped.length <= limits.MAX_BOOK_TITLE_CHARS);
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(clipped), false, '不能留下孤立高位代理');
  assert.equal(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(clipped), false, '不能留下孤立低位代理');
});
