// 「Ctrl+G 快速跳章」的纯逻辑：把输入当成章号或章名关键词，算出要跳的章节。
// 不碰磁盘、不依赖 Electron，渲染层通过主进程的 jump:match 调用同一份规则（可单测）。
//
// 支持两种输入：
//   1. 章号：「12」「第12章」「12章」「第 12 回」，以及全角数字「１２」→ 第 12 章（1 起算）；
//   2. 章名关键词：命中的章节名（不区分大小写），按「完全相同 → 开头相同 → 包含」排序，再按章序。
//
// 章号在「全书连续」模式下按全书位置；书设为「每卷重新编号」（options.numbering === 'volume'）时按卷内号。
// 按卷模式下章节缺有效 number 直接抛错（code = JUMP_NUMBER_MISSING），不回落成全书下标——
// 回落会让「第 3 章」悄悄跳到别的卷，宁可报错让调用方修数据。

const DEFAULT_LIMIT = 8;
const MAX_QUERY_LENGTH = 100;
const MAX_RESULTS = 50;
const MAX_CHAPTER_NUMBER = 999999;

const FULL_WIDTH_DIGIT_RE = /[０-９]/g;

function normalizeQuery(raw) {
  return String(raw == null ? '' : raw).trim().slice(0, MAX_QUERY_LENGTH);
}

function toHalfWidthDigits(text) {
  return String(text == null ? '' : text).replace(FULL_WIDTH_DIGIT_RE, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
}

// 纯章号查询才返回数字；「12.5」「第12章：夜雨」「abc」都不算。
function parseChapterNumber(raw) {
  const query = normalizeQuery(raw);
  if (!query) return null;
  const match = toHalfWidthDigits(query).match(/^第?\s*([0-9]{1,6})\s*[章节回]?$/);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_CHAPTER_NUMBER) return null;
  return number;
}

function sanitizeLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_RESULTS, Math.floor(n));
}

function chapterNameOf(chapter) {
  return chapter && typeof chapter === 'object' ? String(chapter.name == null ? '' : chapter.name).trim() : '';
}

function chapterIdOf(chapter) {
  return chapter && typeof chapter === 'object' && chapter.id != null ? String(chapter.id) : '';
}

// 按卷编号跳章要求每章都带调用方算好的卷内号（渲染层用 chaptersLib.chapterNumber）。
// 缺 number 时**不再**回落成「全书下标 + 1」——那会静默跳到别的卷的章；改由调用处明确报错。
function hasValidChapterNumber(chapter) {
  const value = Number(chapter && typeof chapter === 'object' ? chapter.number : NaN);
  return Number.isFinite(value) && value >= 1;
}

function makeMatch(chapter, index, matchType) {
  const volumeName =
    chapter && typeof chapter === 'object' && chapter.volumeName != null
      ? String(chapter.volumeName).trim()
      : '';
  const match = {
    index,
    chapterId: chapterIdOf(chapter),
    name: chapterNameOf(chapter),
    matchType
  };
  // 按卷编号时才带卷名（连续模式的返回形状与以前完全一致，老测试 / 老调用方零适配）
  if (volumeName) match.volumeName = volumeName;
  return match;
}

// 主线：返回 { query, number, chapterCount, outOfRange, total, matches }。
//   - number != null：按章号找，只返回 1 条（越界时 matches 为空、outOfRange=true）；
//   - 否则按章名关键词找（空名章节不参与）；
//   - matches[].index 是 chapters 数组里的原始下标（删除/空白项不会让下标错位）。
function findMatches(chapters, rawQuery, options) {
  const query = normalizeQuery(rawQuery);
  const limit = sanitizeLimit(options && options.limit);
  const list = Array.isArray(chapters) ? chapters : [];
  const result = {
    query,
    number: null,
    chapterCount: list.length,
    outOfRange: false,
    total: 0,
    matches: []
  };
  if (!query) return result;

  const number = parseChapterNumber(query);
  if (number != null) {
    result.number = number;
    const numbering = options && options.numbering === 'volume' ? 'volume' : 'continuous';
    result.numbering = numbering;
    if (numbering === 'volume') {
      // 按卷编号：同一章号可能在每一卷都出现一次 —— 全部列出来，让作者按卷名选。
      // 1.5.0 功能-5（审计建议 14 小项）：章号必须由调用方算好；缺 number 说明契约被破坏，
      // 以前会回落成全书下标 + 1（可能悄悄跳到别的卷），现在明确报错。
      for (let index = 0; index < list.length; index += 1) {
        const chapter = list[index];
        if (!chapter || typeof chapter !== 'object') continue;
        if (!hasValidChapterNumber(chapter)) {
          const err = new Error(`按卷编号跳章缺少章号（第 ${index + 1} 项没有有效的 number）`);
          err.code = 'JUMP_NUMBER_MISSING';
          throw err;
        }
      }
      const hits = [];
      list.forEach((chapter, index) => {
        if (!chapter || typeof chapter !== 'object') return;
        if (Math.floor(Number(chapter.number)) === number) hits.push({ chapter, index });
      });
      result.total = hits.length;
      result.matches = hits.slice(0, limit).map((item) => makeMatch(item.chapter, item.index, 'number'));
      if (!hits.length) result.outOfRange = true;
      return result;
    }
    const index = number - 1;
    const chapter = list[index];
    if (index >= list.length || !chapter || typeof chapter !== 'object') {
      result.outOfRange = true;
      return result;
    }
    result.total = 1;
    result.matches = [makeMatch(chapter, index, 'number')];
    return result;
  }

  const needle = query.toLowerCase();
  const scored = [];
  for (let index = 0; index < list.length; index += 1) {
    const chapter = list[index];
    if (!chapter || typeof chapter !== 'object') continue;
    const name = chapterNameOf(chapter);
    if (!name) continue;
    const lower = name.toLowerCase();
    let score = -1;
    if (lower === needle) score = 0;
    else if (lower.startsWith(needle)) score = 1;
    else if (lower.includes(needle)) score = 2;
    if (score >= 0) scored.push({ chapter, index, score });
  }
  scored.sort((a, b) => (a.score - b.score) || (a.index - b.index));
  result.total = scored.length;
  result.matches = scored.slice(0, limit).map((item) => makeMatch(item.chapter, item.index, 'name'));
  return result;
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_QUERY_LENGTH,
  parseChapterNumber,
  findMatches
};
