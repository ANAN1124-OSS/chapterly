/* 命令面板的检索 / 排序纯逻辑（1.4.0 P0-3：Ctrl+K 命令面板，规范 I-03）。
 *
 * 为什么单独一个模块：面板里要「命令 / 章节 / 书混排」，匹配规则得可单测——
 *   · 中文按子串匹配（不引依赖、不猜拼音）；
 *   · 英文 / 数字按「子序列」也能命中（`bkm` 能命中「Bookmark 书签」这类带英文的命令）；
 *   · 排序口径固定：精确前缀 > 子串 > 子序列，同档按「组权重 → 标题」
 *     （命令组 0 / 章节组 1 / 书组 2：命令优先，因为面板的主要用途是执行动作）；
 *   · 空查询给「常用 + 最近」：最近用过的排最前（只在内存里记，不写配置）。
 *
 * 契约：本模块不碰 DOM、不碰 IPC、不读配置，只吃「条目数组 + 查询串」吐「排序后的条目」。
 *   createRegistry({ recentLimit }) → {
 *     search(items, query)      // items = [{ id, title, group, kbd?, keywords?[] , run }]，返回排好序的子集
 *     recordUse(id)             // 执行过的命令记一笔（最近使用）
 *     recentIds()               // 最近的 id（新→旧，最多 recentLimit 条）
 *     reset()                   // 自检用：清空最近使用
 *   }
 *
 * 浏览器里挂成全局 CWCommandRegistry（index.html 排在 renderer.js 之前），Node 里可直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWCommandRegistry = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RECENT_LIMIT = 8;
  // 组权重：数字越小越靠前。空查询时「最近」之外按这个顺序排。
  const GROUP_ORDER = { command: 0, chapter: 1, book: 2 };

  // 归一：去首尾空白 + 小写 + 全角字母数字与全角空格转半角（中文标点不动）。
  function normalize(text) {
    return String(text == null ? '' : text)
      .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/\u3000/g, ' ')
      .trim()
      .toLowerCase();
  }

  // 子序列匹配：查询的每个字符依次出现在 text 里（用于英文缩写，如 bkm → bookmark）。
  function isSubsequence(needle, haystack) {
    if (!needle) return true;
    let at = 0;
    for (let i = 0; i < haystack.length && at < needle.length; i += 1) {
      if (haystack[i] === needle[at]) at += 1;
    }
    return at === needle.length;
  }

  // 一条条目在某个查询下的得分：0 = 不命中；数字越大越靠前。
  //   100 前缀命中（标题或关键词以查询开头）
  //    70 子串命中
  //    40 子序列命中（只看标题 / 关键词 / id 里的 ASCII 段）
  function scoreItem(item, query) {
    if (!query) return 1;
    const title = normalize(item.title);
    const keywords = Array.isArray(item.keywords) ? item.keywords.map(normalize) : [];
    const id = normalize(item.id);
    const fields = [title, ...keywords];
    let best = 0;
    for (const field of fields) {
      if (!field) continue;
      if (field.startsWith(query)) best = Math.max(best, 100);
      else if (field.includes(query)) best = Math.max(best, 70);
      else if (/^[a-z0-9 _-]+$/.test(query) && isSubsequence(query, field)) best = Math.max(best, 40);
    }
    if (!best && query.length >= 2 && /^[a-z0-9 _-]+$/.test(query) && isSubsequence(query, id)) best = 40;
    return best;
  }

  function createRegistry(options) {
    const opts = options || {};
    const recentLimit = Number.isFinite(opts.recentLimit) && opts.recentLimit > 0
      ? Math.floor(opts.recentLimit)
      : RECENT_LIMIT;
    let recent = [];

    function recordUse(id) {
      const key = String(id == null ? '' : id);
      if (!key) return false;
      recent = [key, ...recent.filter((item) => item !== key)].slice(0, recentLimit);
      return true;
    }

    function recentIds() {
      return recent.slice();
    }

    function reset() {
      recent = [];
    }

    function groupRank(item) {
      const rank = GROUP_ORDER[item && item.group];
      return rank === undefined ? 9 : rank;
    }

    // 空查询：最近用过的（按使用顺序）在前，其余按「组权重 → 标题」。
    function emptyQueryOrder(items) {
      const byId = new Map(items.map((item) => [item.id, item]));
      const used = [];
      for (const id of recent) {
        if (byId.has(id)) used.push(byId.get(id));
      }
      const usedSet = new Set(used.map((item) => item.id));
      const rest = items
        .filter((item) => !usedSet.has(item.id))
        .sort((a, b) => {
          const diff = groupRank(a) - groupRank(b);
          if (diff !== 0) return diff;
          return String(a.title).localeCompare(String(b.title), 'zh-Hans-CN');
        });
      return used.concat(rest);
    }

    function search(items, rawQuery) {
      const list = Array.isArray(items) ? items.filter((item) => item && item.id && item.title) : [];
      const query = normalize(rawQuery);
      if (!query) return emptyQueryOrder(list);
      const scored = [];
      for (const item of list) {
        const score = scoreItem(item, query);
        if (!score) continue;
        scored.push({ item, score });
      }
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const diff = groupRank(a.item) - groupRank(b.item);
        if (diff !== 0) return diff;
        return String(a.item.title).localeCompare(String(b.item.title), 'zh-Hans-CN');
      });
      return scored.map((entry) => entry.item);
    }

    return { search, recordUse, recentIds, reset };
  }

  return { createRegistry, normalize, scoreItem, isSubsequence, RECENT_LIMIT, GROUP_ORDER };
});