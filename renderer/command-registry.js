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
 *   prepare(items)              // 构建时把「标题 + 关键词 + id」归一好挂在 searchText 上（1.5.0 P0-6）
 *   createRegistry({ recentLimit }) → {
 *     search(items, query)      // items = [{ id, title, group, kbd?, keywords?[] , run }]，返回排好序的子集
 *     recordUse(id)             // 执行过的命令记一笔（最近使用）
 *     recentIds()               // 最近的 id（新→旧，最多 recentLimit 条）
 *     reset()                   // 自检用：清空最近使用
 *   }
 *
 * 性能口径（1.5.0 P0-6 / 审计 O-1）：千章书 + 书架混排时条目上千条，每敲一个字都全量打分太贵。
 * prepare() 在构建时把归一文本记下来，search() 先用一次 includes / 子序列粗筛，命中的再打分；
 * 粗筛必须是打分的**超集**（字段里成立 ⇒ 拼起来的 text 里也成立），否则会丢「bkm → Bookmark」。
 * 没调用 prepare 的旧调用方照常可用（粗筛时现算归一文本，行为不变，只是慢一点）。
 * 空查询不粗筛，仍走「最近 + 组顺序」。prepare() 返回新数组、不改入参对象。
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
  // 子序列只对 ASCII 查询开放（中文没有字母序，「中文子序列」只会带来噪声命中）。
  const ASCII_QUERY_RE = /^[a-z0-9 _-]+$/;
  // 拼 searchText 用的分隔符：不可能出现在归一后的查询里（查询会 trim，但不 trim 中间换行；
  // 就算粘进来一个换行，粗筛多放行几条、打分阶段也会把它们丢掉，不会多出结果）。
  const SEARCH_TEXT_SEPARATOR = '\n';

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

  // 一条条目的「可搜文本」：标题 + 关键词 + id，各自归一后用 \n 拼起来（1.5.0 P0-6）。
  // 只给粗筛用，不参与打分；打分仍逐字段算，所以命中档位不受影响。
  function normalizedSearchText(item) {
    if (!item || typeof item !== 'object') return '';
    const keywords = Array.isArray(item.keywords) ? item.keywords : [];
    return [item.title, ...keywords, item.id]
      .map((field) => normalize(field))
      .filter((field) => field !== '')
      .join(SEARCH_TEXT_SEPARATOR);
  }

  // 构建时预处理：算好 searchText，返回**新数组**（不改入参对象，面板拿到的是稳定快照）。
  function prepare(items) {
    if (!Array.isArray(items)) return [];
    const out = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      out.push(Object.assign({}, item, { searchText: normalizedSearchText(item) }));
    }
    return out;
  }

  // 粗筛：query 已经归一过。命中条件与打分口径对齐（子串 / ASCII 子序列）。
  // 不变量：scoreItem(item, query) > 0 ⇒ coarseMatch(item, query) === true。
  function coarseMatch(item, query) {
    const text = typeof item.searchText === 'string' ? item.searchText : normalizedSearchText(item);
    if (text.includes(query)) return true;
    return ASCII_QUERY_RE.test(query) && isSubsequence(query, text);
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
      else if (ASCII_QUERY_RE.test(query) && isSubsequence(query, field)) best = Math.max(best, 40);
    }
    if (!best && query.length >= 2 && ASCII_QUERY_RE.test(query) && isSubsequence(query, id)) best = 40;
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
      // 粗筛（1.5.0 P0-6 / O-1）：千章书每敲一个字都全量打分太贵，先用构建时算好的
      // searchText 过一遍（子串 / ASCII 子序列），只给命中的条目打分排序。
      // 粗筛是打分的超集，所以排序结果与逐条打分完全一致（单测钉住）。
      const scored = [];
      for (const item of list) {
        if (!coarseMatch(item, query)) continue;
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

  return {
    createRegistry,
    prepare,
    normalize,
    normalizedSearchText,
    coarseMatch,
    scoreItem,
    isSubsequence,
    RECENT_LIMIT,
    GROUP_ORDER
  };
});