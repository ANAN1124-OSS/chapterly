'use strict';
// 章节文件名形态的唯一事实源（WP8 / X-N3）。
//
// 同一份形态原来只有「导入判定」在用（core/importer.js 的 looksLikeChapterFile）：
// 纯数字名 / 序号 + 分隔符 / core/heading.js 的 import 标题词表。但「书目坏了从目录重建」
// 只解析 `NNN-名称.txt` 一种，其余按 localeCompare 顺序拿 index+1 当序号 —— 导入侧明文接受的
// 目录（1.txt…12.txt / 第一章…第十章 / 12_卷名.txt）重建后章序错、纯数字文件的章名变裸数字。
// 这里把形态与序号解析收成一份，导入判定与重建共用；新增形态只改这里与 core/heading.js。
//
// 形态口径与审计修复 #13（E9）逐字一致：
//   · 纯数字名：带前导零的任意位数（001 / 0001），或 1–3 位（1 / 12 / 123）；
//     4 位纯数字（1984.txt）是年份 / 书名，不算章节序号。
//   · 序号 + 分隔符：001-xxx / 12_xxx / 3、xxx / 1 xxx（分隔符集合与 heading import 的阿拉伯写法对齐）。
//   · 标题式：第X章 / 第X话 / 第X幕 / Chapter N / 楔子 / 番外…（core/heading.js 的 import 词表）。
const heading = require('./heading');

const CHAPTER_TITLE_RE = heading.anchorRe('import');
const CHAPTER_SEQ_RE = /^\s*\d+\s*[-_.、\s]/;
const CHAPTER_PURE_NUMBER_RE = /^\s*(?:0\d+|\d{1,3})\s*$/;

// 导入侧判定：这个 txt 文件名看起来像「一本书的章节文件」吗？
// 与 core/importer.js 的 looksLikeChapterFile 同一口径（那边只是本函数的薄包装）。
function isChapterFileName(fileName) {
  const base = String(fileName || '').replace(/\.txt$/i, '');
  return CHAPTER_PURE_NUMBER_RE.test(base) || CHAPTER_SEQ_RE.test(base) || CHAPTER_TITLE_RE.test(base);
}

// 中文数字 → 数值（重建章序用）。只认 heading import 词表里的汉字数字与十 / 百 / 千：
// 一=1、十=10、十一=11、二十三=23、一百零二=102、两千=2000。「万」及更长的复合
// （第一万章）不在 import 词表的 1–12 位序号写法内，解析不了返回 null（按无号章稳定排序）。
const CN_DIGITS = Object.freeze({
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9
});
const CN_UNITS = Object.freeze({ 十: 10, 百: 100, 千: 1000 });

function parseChineseNumber(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  let total = 0;
  let current = 0;
  let seen = false;
  for (const ch of text) {
    if (Object.prototype.hasOwnProperty.call(CN_DIGITS, ch)) {
      current = current * 10 + CN_DIGITS[ch];
      seen = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(CN_UNITS, ch)) {
      // 单位前面必须有一位数字；「十 X」开头的「十」按 1×10 处理（十一 / 十）。
      const digit = current || (total === 0 && ch === '十' ? 1 : 0);
      if (!digit) return null;
      total += digit * CN_UNITS[ch];
      current = 0;
      seen = true;
      continue;
    }
    return null;
  }
  if (!seen) return null;
  return total + current;
}

// 「第X章」的数字段捕获：字符类与 heading 的 import 词表同源，单位同样是 import 的 markers。
const NUMBERED_CAPTURE_RE = new RegExp(
  `^\\s*第\\s*([${heading.numeralClass('import')}]{${heading.profile('import').numeralRun.slice(1, -1)}})\\s*[${heading.markerClass('import')}]`
);
// 「Chapter N」（heading.ENGLISH_SOURCE 同形，另加捕获组）。
const ENGLISH_CAPTURE_RE = /^\s*Chapter\s+([0-9]+)/i;
// 序号 + 分隔符，名 = 分隔符后的正文（001-起风 / 12_卷名 / 3、序 / 1 起风）。
const SEQ_NAME_RE = /^\s*(\d+)\s*(?:[-_.、]|\s+)\s*(.*?)\s*$/;

function positiveSeq(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

// 从一个 txt 文件名解析「序号 + 章名」（重建章序用）：
//   { seq: 正整数, name: 章名 } —— 能判出章号；
//   { seq: null, name: 去掉 .txt 的原主干 } —— 判不出章号（楔子 / 番外 / 1984 这类），
//   由调用方稳定排在带号章之后。
// 序号不在这里夹上限（repair 侧统一夹 MAX_REBUILD_SEQ），章名不做安全化（用原始名）。
function parseChapterFileName(fileName) {
  const base = String(fileName || '').replace(/\.txt$/i, '');
  if (!base) return { seq: null, name: '' };
  // ① 纯数字名：001 / 1 / 12 / 123（1984 不在此列，见文件头注释）
  if (CHAPTER_PURE_NUMBER_RE.test(base)) {
    const seq = positiveSeq(base.trim());
    return { seq, name: seq ? '' : base };
  }
  // ② 第X章 / 第X话 / 第X幕（阿拉伯或中文数字）
  const numbered = NUMBERED_CAPTURE_RE.exec(base);
  if (numbered) {
    const raw = numbered[1];
    const seq = /^[0-9]+$/.test(raw) ? positiveSeq(raw) : positiveSeq(parseChineseNumber(raw));
    if (seq) return { seq, name: base };
  }
  // ③ Chapter N
  const english = ENGLISH_CAPTURE_RE.exec(base);
  if (english) {
    const seq = positiveSeq(english[1]);
    if (seq) return { seq, name: base };
  }
  // ④ 序号 + 分隔符：名取分隔符后的正文（与 001-名称 的老口径一致）
  const seqName = SEQ_NAME_RE.exec(base);
  if (seqName) {
    const seq = positiveSeq(seqName[1]);
    if (seq) {
      const name = seqName[2] === '未命名' ? '' : seqName[2];
      return { seq, name };
    }
  }
  return { seq: null, name: base };
}

module.exports = {
  // 生产消费方：core/importer.js（导入判定）、core/repair.js（重建章序）。
  // 三条形态正则与 parseChineseNumber 只在本模块内用，不导出（sweep-unused 闸门）。
  isChapterFileName,
  parseChapterFileName
};