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
const chaptersLib = require('../core/chapters.js');

const chapters = [
  { name: '雨夜来客' },
  { name: '一封没有署名的信' },
  { name: 'The Long Night' },
  { name: '' }
];

// 默认（连续）模式：标题与章号都按 core/chapters.js 的真实口径生成，
// 不再在测试里硬编码 index+1（按卷编号的用例复用同一套生成方式）。
const continuousMeta = { chapters };
const titleOf = (index, meta) => chaptersLib.formatTitle(meta || continuousMeta, index, chapters[index].name);

const match = (index, query) =>
  filter.matchChapter(chapters[index], index, titleOf(index), query, chaptersLib.chapterNumber(continuousMeta, index));

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
// ---------- 按卷编号（1.5.0 P0-1 / 审计 E1）：筛选必须用「界面上显示的卷内号」 ----------
// 两卷各 3 章 → 显示章号 [1,2,3,1,2,3]；其中卷二第 2 章是原文自带号的标题
// （formatTitle 原样显示「第9章：夜航船」），光靠标题里的数字永远筛不到它的卷内号 2，
// 这正是旧实现（haystack 只用 index+1）漏章的地方。
const volumeChapters = [
  { id: 'a', name: '起风', volumeId: 'v1' },
  { id: 'b', name: '夜雨', volumeId: 'v1' },
  { id: 'c', name: '渡口', volumeId: 'v1' },
  { id: 'd', name: '潮生', volumeId: 'v2' },
  { id: 'e', name: '第9章：夜航船', volumeId: 'v2' },
  { id: 'f', name: '上岸', volumeId: 'v2' }
];
const volumeMeta = {
  chapterNumbering: 'volume',
  volumes: [{ id: 'v1', name: '卷一 · 归途' }, { id: 'v2', name: '卷二 · 渡海' }],
  chapters: volumeChapters
};
const vTitle = (index) => chaptersLib.formatTitle(volumeMeta, index, volumeChapters[index].name);
const vNumber = (index) => chaptersLib.chapterNumber(volumeMeta, index);
const vMatch = (index, query) => filter.matchChapter(volumeChapters[index], index, vTitle(index), query, vNumber(index));
const hits = (query) => volumeChapters.map((_, index) => index).filter((index) => vMatch(index, query));

test('按卷编号：显示章号是卷内号，筛选「3 / 第3章」命中两卷各自的第 3 章', () => {
  assert.deepEqual(volumeChapters.map((_, index) => vNumber(index)), [1, 2, 3, 1, 2, 3]);
  assert.equal(vTitle(2), '第3章：渡口');
  assert.equal(vTitle(5), '第3章：上岸');
  assert.deepEqual(hits('3'), [2, 5]);
  assert.deepEqual(hits('第3章'), [2, 5]);
});

test('按卷编号：「第2章」命中两卷各自的第 2 章（含原文自带标题的那一章）', () => {
  // 卷二第 2 章显示名是原样保留的「第9章：夜航船」——卷内号 2 只能靠调用方传入的 number 命中
  assert.equal(vTitle(4), '第9章：夜航船');
  assert.deepEqual(hits('第2章'), [1, 4]);
  assert.deepEqual(hits('2'), [1, 4]);
  // 原文自带章号照旧能筛到（标题 / 章名都参与匹配）
  assert.deepEqual(hits('第9章'), [4]);
});

test('按卷编号：全书位置不再参与纯章号匹配（输入 5 不再误命中全书第 5 章）', () => {
  assert.deepEqual(hits('5'), []);
  assert.deepEqual(hits('第5章'), []);
  // 省略 number 时仍退回旧口径（index+1），保证旧调用 / 旧单测不改也成立
  assert.equal(filter.matchChapter(volumeChapters[4], 4, vTitle(4), '5'), true);
  assert.equal(filter.matchChapter(volumeChapters[4], 4, vTitle(4), '5', vNumber(4)), false);
});

test('按卷编号：单卷 + 自定义无 {num} 模板时，卷内号同样可筛', () => {
  const meta = { chapterNumbering: 'volume', titleTemplate: '{name}', volumes: [{ id: 'v1', name: '卷一' }], chapters: [] };
  const list = [{ id: 'x', name: '起风', volumeId: 'v1' }, { id: 'y', name: '夜雨', volumeId: 'v1' }];
  meta.chapters = list;
  // 模板不含 {num}：标题只剩章名，界面上章号单独显示在序号格（dataset.num）
  assert.equal(chaptersLib.formatTitle(meta, 1, '夜雨'), '夜雨');
  const matchAt = (index, query) => filter.matchChapter(list[index], index, chaptersLib.formatTitle(meta, index, list[index].name), query, chaptersLib.chapterNumber(meta, index));
  assert.equal(matchAt(1, '2'), true);
  assert.equal(matchAt(1, '第2章'), true);
  assert.equal(matchAt(1, '3'), false);
});

test('连续模式：章号仍按全书位置，结果与改前逐条一致', () => {
  assert.deepEqual(chapters.map((_, index) => chaptersLib.chapterNumber(continuousMeta, index)), [1, 2, 3, 4]);
  assert.equal(match(0, '1'), true);
  assert.equal(match(3, '4'), true);
  assert.equal(match(3, '第4章'), true);
  assert.equal(match(0, '4'), false);
});
