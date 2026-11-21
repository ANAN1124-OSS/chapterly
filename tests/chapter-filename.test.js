// TESTC-04：core/chapter-filename.js 的直接单测（以前只经 importer / repair 间接覆盖，
// 文件头声明的「形态口径 = 审计修复 #13 / E9」没有任何锚点）。
//
// 这个模块是「章节文件名形态」的唯一事实源：导入判定（importer.looksLikeChapterFile）与
// 书目损坏重建（repair）共用它。形态边界（几位纯数字算序号 / 哪些分隔符算 / 中文数字怎么解）
// 出错不会崩，只会让导入多收或少收、重建章序错位 —— 正是最该用单测钉住的那类回归。
const test = require('node:test');
const assert = require('node:assert/strict');

const { isChapterFileName, parseChapterFileName } = require('../core/chapter-filename');

test('isChapterFileName：纯数字名的分界（带前导零任意位 / 1–3 位算；4 位数字是年份或书名）', () => {
  for (const name of ['1.txt', '12.txt', '123.txt', '001.txt', '0001.txt', '0012.TXT']) {
    assert.equal(isChapterFileName(name), true, `${name} 应算章节文件`);
  }
  for (const name of ['1984.txt', '2026.txt', '1234.txt', '1a.txt', 'a1.txt']) {
    assert.equal(isChapterFileName(name), false, `${name} 不算章节文件`);
  }
  // 空 / 空串一律 false（坏书目里的脏值不许被当成章节）；数字会被 String() 归一（42 → '42' 合法）
  for (const value of ['', null, undefined, '   .txt']) {
    assert.equal(isChapterFileName(value), false, JSON.stringify(value));
  }
});

test('isChapterFileName：序号 + 分隔符四种写法都认；标题式与自由章名不误收', () => {
  for (const name of ['001-起风.txt', '12_夜雨.txt', '3、灯塔.txt', '1 楔子.txt']) {
    assert.equal(isChapterFileName(name), true, `${name} 应算章节文件`);
  }
  for (const name of ['第一章 起风.txt', '第12章.txt', 'Chapter 3.txt', '番外 番外一.txt']) {
    assert.equal(isChapterFileName(name), true, `${name} 应算章节文件`);
  }
  for (const name of ['我的笔记.txt', '设定集.txt', '001起风.txt']) {
    assert.equal(isChapterFileName(name), false, `${name} 不算章节文件`);
  }
});

test('parseChapterFileName：纯数字名给出序号、章名留空；4 位数字名当普通章名', () => {
  assert.deepEqual(parseChapterFileName('001.txt'), { seq: 1, name: '' });
  assert.deepEqual(parseChapterFileName('12.TXT'), { seq: 12, name: '' });
  assert.deepEqual(parseChapterFileName('1984.txt'), { seq: null, name: '1984' });
  // 前导零的 0 号不算合法序号：整串当章名保留（不许把「000」当成第 1 章）
  assert.deepEqual(parseChapterFileName('000.txt'), { seq: null, name: '000' });
  assert.deepEqual(parseChapterFileName(''), { seq: null, name: '' });
});

test('parseChapterFileName：第X章 / Chapter N / 序号+分隔符三种形态的序号与章名', () => {
  assert.deepEqual(parseChapterFileName('第12章 起风.txt'), { seq: 12, name: '第12章 起风' });
  assert.deepEqual(parseChapterFileName('第十二章.txt'), { seq: 12, name: '第十二章' });
  assert.deepEqual(parseChapterFileName('Chapter 3.txt'), { seq: 3, name: 'Chapter 3' });
  // 序号 + 分隔符：章名只取分隔符后的正文（与 001-名称 的老口径一致）
  assert.deepEqual(parseChapterFileName('001-起风.txt'), { seq: 1, name: '起风' });
  assert.deepEqual(parseChapterFileName('12_夜雨.txt'), { seq: 12, name: '夜雨' });
  // 未命名占位符归一成空章名（导入 / 重建都按「只有章号」显示）
  assert.deepEqual(parseChapterFileName('007-未命名.txt'), { seq: 7, name: '' });
  // 认不出的形态：seq = null、原名整串保留（调用方按稳定排序处理）
  assert.deepEqual(parseChapterFileName('我的笔记.txt'), { seq: null, name: '我的笔记' });
});
