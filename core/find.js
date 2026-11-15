// 全书查找 / 替换的纯文本逻辑（不依赖 Electron，可单测）。
// 只做「字面量」查找，不搞正则：作者写小说，正则一不小心就会误伤全稿。
// 替换前由 storage 负责把原章节备份到书内 _trash，替换写盘仍是显式的「全部替换」动作。

// X7 / V205（v1.8.0 WP-25）：「小写化变长就退回原文」的长度防御收进 core/common.js 的
// caseFoldForMatch（全仓唯一的口径），这里只负责「两边同源」这条查找语义。
const { caseFoldForMatch } = require('./common');

// 单章命中数上限：极端情况（搜一个「的」）兜底，别把内存 / IPC 打爆。
// C4（v1.8.0 WP-05）：这是**显示与单次替换共用的处理上限**，不是精确命中数——
// 到了上限还能多找出第 MAX_MATCHES + 1 处时，findMatchesAll 会明确回 truncated: true；
// replaceAllLiteral 同样把 truncated 原样带走，调用方（整本查找 / 单章替换 / 整本替换）
// 必须如实提示「只统计 / 只替换了前 N 处」，绝不能把截断值当成「全部处理完成」。
const MAX_MATCHES = 5000;

function scanMatches(text, query, options = {}, limit = MAX_MATCHES) {
  const source = String(text == null ? '' : text);
  const needleRaw = String(query == null ? '' : query);
  const cap = Math.max(1, Math.floor(Number(limit) || MAX_MATCHES));
  if (!needleRaw) return { matches: [], truncated: false, limit: cap };
  const caseSensitive = Boolean(options.caseSensitive);
  let haystack = source;
  let needle = needleRaw;
  if (!caseSensitive) {
    // 查找 / 替换必须**两边同源**：任一边含「小写化会变长」的字符（如 'İ' U+0130）时两边都退回
    // 原文扫描，不许出现「干草堆折叠、针不折叠」的混合匹配（X7 的退化语义，common 里带 folded 标记）。
    const foldedHay = caseFoldForMatch(source);
    const foldedNeedle = caseFoldForMatch(needleRaw);
    if (foldedHay.folded && foldedNeedle.folded) {
      haystack = foldedHay.text;
      needle = foldedNeedle.text;
    }
  }
  const matches = [];
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    if (matches.length >= cap) return { matches, truncated: true, limit: cap };
    matches.push({ index, length: needleRaw.length });
    from = index + Math.max(1, needle.length);
  }
  return { matches, truncated: false, limit: cap };
}

function findMatches(text, query, options = {}) {
  return scanMatches(text, query, options).matches;
}

// 需要知道「是不是被上限截断了」的时候用这个（例如渲染层的上一处 / 下一处）。
function findMatchesAll(text, query, options = {}) {
  return scanMatches(text, query, options);
}

function countMatches(text, query, options) {
  return findMatches(text, query, options).length;
}

// 纯字面量替换；返回替换后的文本、**实际替换次数**与是否被单章上限截断（C4 / WP-05）。
// 超过 MAX_MATCHES 时只替换前 MAX_MATCHES 处（和查找列表看到的是同一批），但 truncated 必须
// 如实回报：界面据此提示「只替换了前 N 处」，不把截断当成「全部替换完成」。位置由 findMatchesAll
// 提供，保证大小写策略与查找完全一致。
function replaceAllLiteral(text, query, replacement, options = {}) {
  const source = String(text == null ? '' : text);
  const found = findMatchesAll(source, query, options);
  const { matches, truncated, limit } = found;
  if (!matches.length) return { text: source, count: 0, truncated: false, limit };
  const insert = String(replacement == null ? '' : replacement);
  let out = '';
  let cursor = 0;
  for (const match of matches) {
    out += source.slice(cursor, match.index) + insert;
    cursor = match.index + match.length;
  }
  out += source.slice(cursor);
  return { text: out, count: matches.length, truncated, limit };
}

// 结果列表里显示的一小段上下文（去掉换行，避免列表被撑开）
function makeSnippet(text, index, length, radius = 18) {
  const source = String(text == null ? '' : text);
  const start = Math.max(0, index - radius);
  const end = Math.min(source.length, index + length + radius);
  const clean = (part) => part.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ');
  return {
    before: clean(source.slice(start, index)),
    match: clean(source.slice(index, index + length)),
    after: clean(source.slice(index + length, end)),
    ellipsisStart: start > 0,
    ellipsisEnd: end < source.length
  };
}

// 「只替换这一处」用：从 fromIndex 往后找第一处命中。
// fromIndex 落在某一处命中内部时返回那一处（作者可能在编辑区里点了一下那个词）；
// 否则返回 fromIndex 及之后的下一处；找不到返回 null。
// B3（v1.8.0 WP-27）：不再 findMatches() 物化全量命中（病态查询会建 ≤5000 个对象）。
// 这里只用一个 indexOf 循环增量推进：边数边记「第一处该返回的命中」，命中总数仍在同一个
// 循环里数完（界面要显示「第 N / 总 M 处」，且 M 必须与 findMatchesAll 一样受 MAX_MATCHES 上限约束）。
// 返回形状与旧实现逐字段一致：index = 该命中在命中列表里的 0 基序号，total = 命中列表长度。
function findNextMatch(text, query, fromIndex = 0, options = {}) {
  const source = String(text == null ? '' : text);
  const needleRaw = String(query == null ? '' : query);
  if (!needleRaw) return null;
  const caseSensitive = Boolean(options.caseSensitive);
  let haystack = source;
  let needle = needleRaw;
  if (!caseSensitive) {
    // 与 scanMatches 同一口径：两边都折叠才折叠，任一边退化就两边都用原文（X7 退化语义）。
    const foldedHay = caseFoldForMatch(source);
    const foldedNeedle = caseFoldForMatch(needleRaw);
    if (foldedHay.folded && foldedNeedle.folded) {
      haystack = foldedHay.text;
      needle = foldedNeedle.text;
    }
  }
  const rawFrom = Number(fromIndex);
  const from = Math.max(0, Math.min(Number.isFinite(rawFrom) ? Math.floor(rawFrom) : 0, source.length));
  const step = Math.max(1, needle.length);
  let total = 0;
  let pickedIndex = -1;
  let pickedAt = -1;
  let from2 = 0;
  while (total < MAX_MATCHES) {
    const at = haystack.indexOf(needle, from2);
    if (at < 0) break;
    total += 1;
    if (pickedAt < 0 && (at >= from || (at <= from && from < at + needleRaw.length))) {
      pickedIndex = total - 1;
      pickedAt = at;
    }
    from2 = at + step;
  }
  // 审计修复 #10（E6）：到了单章上限要再确认一次「后面还有没有」，与 findMatchesAll /
  // replaceAllLiteral 的 C4 契约同一口径如实回 truncated（旧实现静默停在 5000 处，
  // 界面把截断值当精确总数）。判定仍在同一个 indexOf 增量循环里，不物化命中列表。
  const truncated = total >= MAX_MATCHES && haystack.indexOf(needle, from2) >= 0;
  if (pickedAt < 0) {
    // 命中全在 5000 处之后（或 fromIndex 落在被截断的部分）：回一个只有 truncated 的空结果，
    // 让调用方能说「超过单章上限」而不是误报「没有下一处」。
    return truncated ? { index: -1, total: MAX_MATCHES, truncated: true, match: null } : null;
  }
  return { index: pickedIndex, total, truncated, match: { index: pickedAt, length: needleRaw.length } };
}

module.exports = {
  MAX_MATCHES,
  findMatches,
  findMatchesAll,
  countMatches,
  replaceAllLiteral,
  makeSnippet,
  findNextMatch
};
