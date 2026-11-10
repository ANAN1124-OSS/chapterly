/* 卷章目录筛选（2026-11-10 目录重设计）的自检。
 *
 * 判定规则只有 renderer/chapter-filter-logic.js 一份：空查询全命中；否则按
 * 「完整标题 / 原始章名 / 章号」做大小写不敏感的子串匹配；多关键词空格分隔、
 * 全部命中才算（和书架搜索的多词 AND 同一口径）。
 * 这里只测纯逻辑，DOM / 重建 / 浮标在 E2E（第 76 组）里真跑。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const filter = require('../renderer/chapter-filter-logic.js');

const chapters = [
  { name: '雨夜来客' },
  { name: '一封没有署名的信' },
  { name: 'The Long Night' },
  { name: '' }
];

const titleOf = (index) => {
  const name = chapters[index].name;
  return name ? `第${index + 1}章：${name}` : `第${index + 1}章`;
};

const match = (index, query) => filter.matchChapter(chapters[index], index, titleOf(index), query);

test('normalizeQuery：去首尾空白、连续空白压成一个空格', () => {
  assert.equal(filter.normalizeQuery('  雨夜  '), '雨夜');
  assert.equal(filter.normalizeQuery('雨 夜'), '雨 夜');
  assert.equal(filter.normalizeQuery(' \t \n '), '');
  assert.equal(filter.normalizeQuery(null), '');
  assert.equal(filter.normalizeQuery(undefined), '');
});

test('空查询永远命中（打开一本书就是完整目录）', () => {
  for (let i = 0; i < chapters.length; i += 1) {
    assert.equal(match(i, ''), true);
    assert.equal(match(i, '   '), true);
  }
});

test('按原始章名匹配（子串）', () => {
  assert.equal(match(0, '雨夜'), true);
  assert.equal(match(0, '来客'), true);
  assert.equal(match(1, '署名'), true);
  assert.equal(match(0, '署名'), false);
});

test('按完整标题匹配：第N章 / 第N章：开头也能筛', () => {
  assert.equal(match(1, '第2章'), true);
  assert.equal(match(1, '第2章：一封'), true);
  assert.equal(match(0, '第1章'), true);
  assert.equal(match(2, '第3章'), true);
});

test('按纯章号匹配（输入 3 = 第3章）', () => {
  assert.equal(match(2, '3'), true);
  assert.equal(match(2, '第3章'), true);
});

test('多关键词按空格拆开、全部命中才算（AND）', () => {
  assert.equal(match(1, '一封 信'), true);
  assert.equal(match(1, '一封 雨夜'), false);
  assert.equal(match(2, 'long night'), true);
});

test('大小写不敏感（中英混排书名 / 章名）', () => {
  assert.equal(match(2, 'the long'), true);
  assert.equal(match(2, 'THE NIGHT'), true);
});

test('没有名字的章按章号也能被筛到', () => {
  assert.equal(match(3, '4'), true);
  assert.equal(match(3, '第4章'), true);
});

test('不搜正文：只认标题 / 章名 / 章号', () => {
  assert.equal(filter.matchChapter({ name: '起风', text: '海面上的灯塔' }, 0, '第1章：起风', '灯塔'), false);
});