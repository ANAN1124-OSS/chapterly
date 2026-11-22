/* 查找书签（v0.8-11b，提案 N11b）——纯逻辑，不碰 DOM、不读盘、不依赖 Electron。
 *
 * 为什么单独一个文件：书签要按「书 + 章」存进 config.json（userData），配置读取时要在主进程
 * 清洗（旧 config 没有这个字段、手改坏了都不能让应用起不来），渲染层还要按同样的规则做
 * 「找一条 / 存一条 / 删一条」。这些只是数组与字符串处理，不该写在 renderer.js 里（没法单测），
 * 也不该在主进程里另写一份。所以放成「浏览器挂到 window，Node 里可以 require」的模块：
 *   - 渲染层：index.html 先加载 core/bookmarks.js（window.CWBookmarks），再加载 renderer.js；
 *   - 主进程：core/config.js require 它做配置清洗与原子增删；
 *   - 单测：tests/bookmarks.test.js 直接 require。
 *
 * 书签里只存「查询条件」：bookId / chapterId / 查询词 / 大小写选项，加几个只用于显示的字段
 * （书名、章名、章号、书路径）与时间戳。**绝不存正文、不存命中位置**：命中位置在打开这一章时
 * 由当前正文现算（正文改过也能重新定位），书签本身不写书库、不改书目 / 章节文件。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./common'));
  } else if (root) {
    root.CWBookmarks = factory(root.CWCommon);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (commonLib) {
  'use strict';

  // C4（一轮·低）：字段限长改走 core/common.js 的 truncateSafe（按 UTF-16 截断但不切开代理对）。
  // 以前 bookmarks 自己 slice(0, max)：配置被手改成 emoji / 扩展 B 汉字结尾时，截断会留下孤立代理，
  // 书签列表显示成乱码。浏览器里 core/common.js 必须排在 core/bookmarks.js 之前（index.html 已是这个顺序）。
  if (!commonLib || typeof commonLib.truncateSafe !== 'function') {
    throw new TypeError('core/bookmarks.js 需要 core/common.js 的 truncateSafe（加载顺序：common 在前）');
  }
  const { truncateSafe } = commonLib;

  // 一台机器最多记多少条书签：够作者给每本书标几个重点，又不至于让配置无限膨胀。
  const MAX_BOOKMARKS = 200;
  // 查找词上限（和查找框的使用习惯一致；配置被手改成长串时截断，不让它拖慢扫描）
  const MAX_QUERY_LENGTH = 200;
  const MAX_NAME_LENGTH = 200;
  const MAX_PATH_LENGTH = 1000;
  const MAX_ID_LENGTH = 200;
  const MAX_CHAPTER_INDEX = 1000000;

  // CSTO-B-04（审计低批）：与 core/bookinfo.js 的 WP14 C10 同一份清洗标准 ——
  // 配置里用户可编辑的文本不许带 C0 控制字符（\s 不匹配 U+0000，旧实现会让 NUL 原样进 query / 书名）
  // 与 bidi 格式控制（U+202E 等会把书签列表的显示排版倒过来）。
  // 书签的键拼接另见 keyOf：它只 trim，id 由应用生成、字符集不含这些字符。
  const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
  const BIDI_CONTROL_RE = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

  // 只保留字符串、剔控制字符 / bidi、去掉首尾空白并限长；非字符串一律当空（坏配置不抛错）
  function cleanText(value, max) {
    if (typeof value !== 'string') return '';
    const trimmed = value.replace(CONTROL_CHARS_RE, '').replace(BIDI_CONTROL_RE, '').trim();
    return truncateSafe(trimmed, max);
  }

  // 「书 + 章」才是书签的唯一键：同一章重复保存 = 更新那一条，不是新增。
  // 用 \u0000 拼键只是内部去重用；书籍 / 章节 id 本身不会含这个字符。
  function keyOf(bookId, chapterId) {
    const book = typeof bookId === 'string' ? bookId.trim() : '';
    const chapter = typeof chapterId === 'string' ? chapterId.trim() : '';
    if (!book || !chapter) return '';
    return `${book}\u0000${chapter}`;
  }

  function normalizeTimestamp(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.round(n);
  }

  // 把一条原始书签清洗成固定形状；缺书 / 缺章 / 查询词只有空白的直接丢弃（null）。
  // options.now 只给单测 / 调用方注入固定时间用，正常运行取当前时间。
  function normalizeBookmark(raw, options = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const bookId = cleanText(raw.bookId, MAX_ID_LENGTH);
    const chapterId = cleanText(raw.chapterId, MAX_ID_LENGTH);
    if (!bookId || !chapterId) return null;
    if (typeof raw.query !== 'string') return null;
    const queryRaw = raw.query;
    if (!queryRaw.trim()) return null;
    const now = Number.isFinite(Number(options.now)) ? Math.round(Number(options.now)) : Date.now();
    const created = normalizeTimestamp(raw.createdAt, 0);
    const createdFallback = created || now;
    const chapterIndex = Number(raw.chapterIndex);
    return {
      bookId,
      chapterId,
      bookPath: cleanText(raw.bookPath, MAX_PATH_LENGTH),
      bookTitle: cleanText(raw.bookTitle, MAX_NAME_LENGTH),
      chapterName: cleanText(raw.chapterName, MAX_NAME_LENGTH),
      chapterIndex:
        Number.isFinite(chapterIndex) && chapterIndex > 0
          ? Math.min(Math.round(chapterIndex), MAX_CHAPTER_INDEX)
          : 0,
      // 查询词按作者输入的原文保存（不去空白，和查找口径一致），只限长
      query: truncateSafe(queryRaw, MAX_QUERY_LENGTH),
      caseSensitive: raw.caseSensitive === true,
      createdAt: createdFallback,
      updatedAt: normalizeTimestamp(raw.updatedAt, createdFallback)
    };
  }

  // 配置读取时的总清洗：非数组 → []；坏条目丢掉；同一「书 + 章」只留第一条（列表是
  // 最近保存的在前，所以留下的是较新的那条）；最多 MAX_BOOKMARKS 条。
  function sanitizeBookmarks(raw, options = {}) {
    const input = Array.isArray(raw) ? raw : [];
    const out = [];
    const seen = new Set();
    for (const item of input) {
      const bookmark = normalizeBookmark(item, options);
      if (!bookmark) continue;
      const key = keyOf(bookmark.bookId, bookmark.chapterId);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(bookmark);
      if (out.length >= MAX_BOOKMARKS) break;
    }
    return out;
  }

  function findBookmark(list, bookId, chapterId) {
    const key = keyOf(bookId, chapterId);
    if (!key || !Array.isArray(list)) return null;
    for (const item of list) {
      if (item && keyOf(item.bookId, item.chapterId) === key) return item;
    }
    return null;
  }

  // 存 / 更新：同一「书 + 章」只保留一条，放到列表最前面（最近保存的在前）；
  // 更新时保留第一次收藏的时间 createdAt。返回清洗后的新数组，不改调用方数组。
  function upsertBookmark(list, raw, options = {}) {
    const bookmark = normalizeBookmark(raw, options);
    const base = Array.isArray(list) ? list : [];
    if (!bookmark) return sanitizeBookmarks(base, options);
    const existing = findBookmark(base, bookmark.bookId, bookmark.chapterId);
    if (existing) {
      const createdAt = Number(existing.createdAt);
      if (Number.isFinite(createdAt) && createdAt > 0) bookmark.createdAt = Math.round(createdAt);
    }
    const out = [bookmark];
    for (const item of base) {
      if (!item || keyOf(item.bookId, item.chapterId) === keyOf(bookmark.bookId, bookmark.chapterId)) continue;
      out.push(item);
    }
    return sanitizeBookmarks(out, options);
  }

  // 删除一条：没有这条就原样返回（新数组）；只动配置里的记录，不碰书库。
  function removeBookmark(list, bookId, chapterId) {
    const key = keyOf(bookId, chapterId);
    const base = Array.isArray(list) ? list : [];
    if (!key) return base.slice();
    return base.filter((item) => !item || keyOf(item.bookId, item.chapterId) !== key);
  }

  // 面板里显示的位置文案：只用书签里记的显示字段，不再读书 / 读章节。
  function bookmarkPlace(bookmark) {
    if (!bookmark || typeof bookmark !== 'object') return '';
    const title = cleanText(bookmark.bookTitle, MAX_NAME_LENGTH) || '（未命名书）';
    const name = cleanText(bookmark.chapterName, MAX_NAME_LENGTH);
    const rawIndex = Number(bookmark.chapterIndex);
    const index = Number.isFinite(rawIndex) && rawIndex > 0 ? Math.round(rawIndex) : 0;
    const chapter = index > 0 ? `第${index}章${name ? `：${name}` : ''}` : name || '未命名章节';
    return `《${title}》· ${chapter}`;
  }

  // 面板头上「N 个书签 · M 本书」用
  function countBooks(list) {
    const books = new Set();
    for (const item of Array.isArray(list) ? list : []) {
      if (!item) continue;
      const bookId = typeof item.bookId === 'string' ? item.bookId.trim() : '';
      if (bookId) books.add(bookId);
    }
    return books.size;
  }

  return {
    MAX_BOOKMARKS,
    MAX_QUERY_LENGTH,
    MAX_NAME_LENGTH,
    MAX_PATH_LENGTH,
    cleanText,
    keyOf,
    normalizeBookmark,
    sanitizeBookmarks,
    findBookmark,
    upsertBookmark,
    removeBookmark,
    bookmarkPlace,
    countBooks
  };
});
