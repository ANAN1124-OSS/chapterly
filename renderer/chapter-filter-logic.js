/* 卷章目录的筛选规则（2026-11-10 目录重设计）——纯逻辑，不碰 DOM、不读盘。
 *
 * 用法：渲染层把 state.chapterFilter 传进来，决定这一章是否留在目录里。
 * 匹配面 = 完整标题（第9章：夜航船）/ 原始章名 / 章号（9、第9章）三段拼起来，
 * 多关键词按空格拆开、全部命中才算（和书架搜索的多词 AND 一致）。
 * 空查询永远命中；纯用章名 + 章号，不搜正文（正文命中走书架搜索 / Ctrl+F）。
 *
 * 同时被 Node（单测）和浏览器（window.CWChapterFilterLogic）使用，写成 UMD。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWChapterFilterLogic = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 去掉首尾空白、把连续空白压成一个空格；保留全角空格以外的普通空格（多词分隔）
  function normalizeQuery(value) {
    return String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
  }

  // 一章的「可搜文本」：标题 + 章名 + 章号；大小写不敏感（中英混排时英文同样能筛）
  function haystack(chapter, index, title) {
    const number = String((Number(index) || 0) + 1);
    const name = chapter && chapter.name != null ? String(chapter.name) : '';
    const fullTitle = title == null ? '' : String(title);
    return [fullTitle, name, number, `第${number}章`].join('\n').toLowerCase();
  }

  function matchChapter(chapter, index, title, query) {
    const q = normalizeQuery(query).toLowerCase();
    if (!q) return true;
    const hay = haystack(chapter, index, title);
    return q.split(' ').every((term) => hay.includes(term));
  }

  return { normalizeQuery, matchChapter };
});