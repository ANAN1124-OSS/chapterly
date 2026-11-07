/* 阅读模式（v0.8-4，提案 N4）——纯逻辑，不碰 DOM、不读盘、不依赖 Electron。
 *
 * 阅读模式本身（整本只读通读、连续滚动、退出回到写作页）是渲染层的事；这里只放
 * 容易算错的纯函数：
 *   - 字号 / 行距档位（四档 / 三档）与坏值夹紧；
 *   - 字号 / 行距的按书记忆（Phase D / D13：一张 Map，只记本次运行，不写配置）；
 *   - 阅读位置的按书记忆（v0.13 / U-D10：也是一张 Map，只记本次运行 —— 章号 + 章内比例 +
 *     「记位置时编辑区停在哪一章」，重开应用回到默认）；
 *   - Ctrl+= / Ctrl+- 的档位步进（键名 → +1 / -1，布局差异在映射里吃掉）；
 *   - 阅读进度（第 X / N 章、百分比）与窗口标题后缀（Phase D / D8）；
 *   - 阅读目录的分卷分段（Phase D / D14：按连续卷段切组，单卷 / 无卷时只有一段）；
 *   - 滚动到某个位置时，当前视野里是哪一章（按每章区块的顶端位置算）；
 *   - 是否滚动到接近底部（用来决定要不要自动接下一章）；
 *   - 上一章 / 下一章的目标下标（到章首 / 章尾返回 null，不越界）。
 *
 * 原则：本模块**只读**。阅读模式不写正文、不写 `书目.json`、不写配置、不生成 `_trash`。
 * 浏览器里挂 `window.CWReadingLogic`，Node 里可以 require 单测。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWReadingLogic = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 字号四档：小 / 中 / 大（默认）/ 特大。默认 22px 在 1294×766 的窗口里不挤。
  const READING_FONT_LEVELS = [17, 19, 22, 25];
  const READING_FONT_LABELS = ['小', '中', '大', '特大'];
  const READING_FONT_DEFAULT = 2;
  // 行距三档：紧凑 / 标准（默认）/ 宽松
  const READING_LINE_LEVELS = [1.7, 2.0, 2.3];
  const READING_LINE_LABELS = ['紧凑', '标准', '宽松'];
  const READING_LINE_DEFAULT = 1;
  // 滚动到离底部这么近时，自动接下一章（连续滚动阅读）
  const AUTO_APPEND_THRESHOLD = 320;
  // 一次阅读会话最多同时留在 DOM 里的章节数：太多了会拖慢滚动，超出的从最早处移除。
  const MAX_LOADED_BLOCKS = 40;

  function toFinite(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  // 档位：坏值回默认，越界夹到 [0, maxIndex]
  function clampLevel(value, maxIndex, fallback) {
    const max = Math.max(0, Math.floor(Number(maxIndex) || 0));
    const n = toFinite(value);
    if (n == null) return Math.min(Math.max(Math.floor(Number(fallback) || 0), 0), max);
    return Math.min(Math.max(Math.floor(n), 0), max);
  }

  function fontLevel(value) {
    return clampLevel(value, READING_FONT_LEVELS.length - 1, READING_FONT_DEFAULT);
  }

  function lineLevel(value) {
    return clampLevel(value, READING_LINE_LEVELS.length - 1, READING_LINE_DEFAULT);
  }

  function fontSize(level) {
    return READING_FONT_LEVELS[fontLevel(level)];
  }

  function lineHeight(level) {
    return READING_LINE_LEVELS[lineLevel(level)];
  }

  // 字号 / 行距的按书记忆（Phase D / D13）：store 是一张 Map<书路径, { fontLevel, lineLevel }>，
  // 只活在这一次运行的内存里 —— 不写 config.json、不进书目，重开应用回到默认档。
  // 以前档位是整个会话一份（换本书还沿用上一本的字号）；按书记忆之后每本书取回自己的那一份。
  // 路径只做 trim 归一（同一支笔的 state.bookPath 一直是同一个字符串），空路径 / 坏输入一律回默认、
  // 也不在表里占位。三个函数都不抛错，也不改传进来的 store。
  function bookPrefKey(bookPath) {
    return typeof bookPath === 'string' ? bookPath.trim() : '';
  }

  function prefsForBook(store, bookPath) {
    const key = bookPrefKey(bookPath);
    const stored = key && store instanceof Map ? store.get(key) : null;
    const entry = stored && typeof stored === 'object' ? stored : null;
    return {
      fontLevel: fontLevel(entry ? entry.fontLevel : READING_FONT_DEFAULT),
      lineLevel: lineLevel(entry ? entry.lineLevel : READING_LINE_DEFAULT)
    };
  }

  function withBookPrefs(store, bookPath, prefs) {
    const next = store instanceof Map ? new Map(store) : new Map();
    const key = bookPrefKey(bookPath);
    if (!key) return next;
    const source = prefs && typeof prefs === 'object' ? prefs : {};
    next.set(key, {
      fontLevel: fontLevel(source.fontLevel),
      lineLevel: lineLevel(source.lineLevel)
    });
    return next;
  }

  // 阅读位置的按书记忆（v0.13 / U-D10）：store 是一张 Map<书路径, { index, ratio, editorIndex }>，
  // 和字号 / 行距一样只活在这一次运行的内存里 —— 不写 config.json、不进书目，重开应用回到默认
  // （从当前写作章开始）。字段口径：
  //   index       停在哪一章（0 基）
  //   ratio       停在这一章的纵向比例（0 = 章顶，1 = 章底），用来回到章内的大致位置
  //   editorIndex 记这份位置时编辑区停在哪一章：只有编辑区没换过章才恢复阅读位置；
  //               作者在编辑器里明确点了别的章，就以那一章为起点 —— 不抢他的选择。
  // 三个函数都不抛错，也不改传进来的 store / 位置对象；空路径 / 坏值一律收敛到「没有位置」。
  function positionRatio(value) {
    const n = toFinite(value);
    if (n == null) return 0;
    return Math.min(Math.max(n, 0), 1);
  }

  function readingPositionForBook(store, bookPath, total) {
    const none = { index: -1, ratio: 0, editorIndex: -1 };
    const key = bookPrefKey(bookPath);
    const safeTotal = Math.max(0, Math.floor(Number(total) || 0));
    if (!key || !safeTotal || !(store instanceof Map)) return none;
    const stored = store.get(key);
    if (!stored || typeof stored !== 'object') return none;
    const rawIndex = toFinite(stored.index);
    if (rawIndex == null) return none;
    const index = Math.min(Math.max(Math.floor(rawIndex), 0), safeTotal - 1);
    const rawEditor = toFinite(stored.editorIndex);
    const editorIndex = rawEditor == null ? -1 : Math.min(Math.max(Math.floor(rawEditor), 0), safeTotal - 1);
    return { index, ratio: positionRatio(stored.ratio), editorIndex };
  }

  function withReadingPosition(store, bookPath, position, total) {
    const next = store instanceof Map ? new Map(store) : new Map();
    const key = bookPrefKey(bookPath);
    const safeTotal = Math.max(0, Math.floor(Number(total) || 0));
    if (!key || !safeTotal) return next;
    const source = position && typeof position === 'object' ? position : null;
    const rawIndex = source ? toFinite(source.index) : null;
    if (rawIndex == null) return next;
    const index = Math.min(Math.max(Math.floor(rawIndex), 0), safeTotal - 1);
    const rawEditor = source ? toFinite(source.editorIndex) : null;
    const editorIndex = rawEditor == null ? index : Math.min(Math.max(Math.floor(rawEditor), 0), safeTotal - 1);
    next.set(key, { index, ratio: positionRatio(source && source.ratio), editorIndex });
    return next;
  }

  // 重进阅读时从哪一章开始：编辑区还停在记位置的那一章（没在编辑器里换章）→ 回到上次读到的章；
  // 否则按编辑区当前章（作者明确选了新起点，或第一次进这本书）。坏参数一律收敛到合法章。
  function readingStartIndex(position, editorIndex, total) {
    const safeTotal = Math.max(0, Math.floor(Number(total) || 0));
    if (!safeTotal) return 0;
    const rawEditor = toFinite(editorIndex);
    const current = Math.min(Math.max(Math.floor(rawEditor == null ? 0 : rawEditor), 0), safeTotal - 1);
    const saved = position && typeof position === 'object' ? position : null;
    const savedIndex = saved ? toFinite(saved.index) : null;
    const savedEditor = saved ? toFinite(saved.editorIndex) : null;
    if (savedIndex == null || savedEditor == null) return current;
    if (Math.floor(savedEditor) !== current) return current;
    return Math.min(Math.max(Math.floor(savedIndex), 0), safeTotal - 1);
  }

  // Ctrl+= / Ctrl+- 调阅读字号（Phase D / D6）：返回 +1（放大）/ -1（缩小）/ 0（不是字号键）。
  // 只认字符本身、不认物理键位 —— 键名随布局 / 输入法变化，加号既可能是 '='（US 主键盘）也可能是
  // '+'（Shift+= 或小键盘），减号同理是 '-' 或 '_'。**有没有按住 Ctrl 由调用方判断**（这里只管键名）。
  function fontStepForKey(key) {
    const name = key == null ? '' : String(key);
    if (name === '=' || name === '+') return 1;
    if (name === '-' || name === '_') return -1;
    return 0;
  }

  // 阅读进度：index 是当前章的 0 基下标，total 是全书章数。
  // 百分比按「看到第几章」算（第 1 / 3 章 = 33.3%），保留一位小数。
  function readingProgress(index, total) {
    const safeTotal = Math.max(0, Math.floor(Number(total) || 0));
    if (!safeTotal) {
      return { index: -1, current: 0, total: 0, percent: 0, text: '全书还没有章节' };
    }
    const raw = toFinite(index);
    const safeIndex = Math.min(Math.max(Math.floor(raw == null ? 0 : raw), 0), safeTotal - 1);
    const percent = Math.round(((safeIndex + 1) / safeTotal) * 1000) / 10;
    return {
      index: safeIndex,
      current: safeIndex + 1,
      total: safeTotal,
      percent,
      text: `第 ${safeIndex + 1} / ${safeTotal} 章 · ${percent}%`
    };
  }

  // 目录的分卷分段（Phase D / D14）：把 chapters 按「连续的同一个 volumeId」切成若干段，
  // 阅读视图的目录下拉在有多段时用 <optgroup> 显示卷名（单卷 / 无卷时只有一段，调用方平铺渲染，
  // 外观与以前一字不差）。分段只看数组顺序 —— 书目归一（core/chapters.js normalizeChapterOrder）
  // 保证「未分卷 → 第1卷 → 第2卷 …」是连续排列的，所以这里不需要再排序。
  // 指向不存在卷的 volumeId 与空值一样算「未分卷」；卷名空白的给「未命名卷」。坏输入一律跳过。
  function tocGroups(chapters, volumes) {
    const list = Array.isArray(chapters) ? chapters : [];
    const names = new Map();
    if (Array.isArray(volumes)) {
      for (const volume of volumes) {
        if (!volume || typeof volume !== 'object') continue;
        const id = typeof volume.id === 'string' ? volume.id.trim() : '';
        if (!id) continue;
        const name = typeof volume.name === 'string' ? volume.name.trim() : '';
        names.set(id, name || '未命名卷');
      }
    }
    const groups = [];
    let current = null;
    for (let index = 0; index < list.length; index += 1) {
      const entry = list[index];
      const rawId = entry && typeof entry === 'object' ? entry.volumeId : null;
      const volumeId = typeof rawId === 'string' && names.has(rawId) ? rawId : '';
      if (!current || current.volumeId !== volumeId) {
        current = { volumeId, label: volumeId ? names.get(volumeId) : '未分卷', indexes: [] };
        groups.push(current);
      }
      current.indexes.push(index);
    }
    return groups;
  }

  // 阅读模式的窗口标题后缀（Phase D / D8）：`（阅读 · 第 2/3 章）`。
  // 章号口径与 readingProgress 一致（当前正在看第几章，1 基、越界夹紧）；全书没有章节时退回
  // `（阅读）` —— 窗口标题无论如何都要能看出「这是只读阅读视图」，不能只剩书名。
  // 不写配置、不碰文档 / IPC：只是个字符串。
  function readingTitleSuffix(index, total) {
    const safeTotal = Math.max(0, Math.floor(Number(total) || 0));
    if (!safeTotal) return '（阅读）';
    const raw = toFinite(index);
    const safeIndex = Math.min(Math.max(Math.floor(raw == null ? 0 : raw), 0), safeTotal - 1);
    return `（阅读 · 第 ${safeIndex + 1}/${safeTotal} 章）`;
  }

  // 当前看的是哪一章：blocks = [{ index, top }]，top 是这一章区块顶端相对滚动内容顶部的位置。
  // 取「顶端已经越过可见区域上沿（再加 offset 像素）」的所有区块里最靠下的那个。
  // 还没滚到第一章时返回第一个区块；空数组返回 -1。
  function blockAtScroll(blocks, scrollTop, offset) {
    if (!Array.isArray(blocks) || !blocks.length) return -1;
    const scroll = Math.max(0, toFinite(scrollTop) || 0);
    const extra = Math.max(0, toFinite(offset) == null ? 24 : toFinite(offset));
    const line = scroll + extra;
    let picked = null;
    let pickedTop = -Infinity;
    let first = null;
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const index = toFinite(block.index);
      const top = toFinite(block.top);
      if (index == null || top == null) continue;
      if (first == null) first = Math.floor(index);
      if (top <= line && top >= pickedTop) {
        pickedTop = top;
        picked = Math.floor(index);
      }
    }
    if (picked != null) return picked;
    return first == null ? -1 : first;
  }

  // 滚动位置 → 阅读位置（v0.13 / U-D10，退出阅读时记下来）：blocks = [{ index, top, height }]
  // 与 blockAtScroll 同一套内容坐标。取「顶端已经越过视口上沿」的最靠下区块（offset 0），
  // 比例 = 视口上沿落在这一块里的位置（0 = 章顶，1 = 章底）。
  // 空数组 / 一个合法块都没有返回 null；高度算不出来（<= 0）时比例给 0（回到章顶）。
  function positionAtScroll(blocks, scrollTop) {
    if (!Array.isArray(blocks) || !blocks.length) return null;
    const scroll = Math.max(0, toFinite(scrollTop) || 0);
    let picked = null;
    let first = null;
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const index = toFinite(block.index);
      const top = toFinite(block.top);
      if (index == null || top == null) continue;
      if (first == null) first = { index: Math.floor(index), top };
      if (top <= scroll && (!picked || top >= picked.top)) {
        picked = { index: Math.floor(index), top, height: toFinite(block.height) };
      }
    }
    if (!picked) return first ? { index: first.index, ratio: 0 } : null;
    const height = picked.height == null ? 0 : picked.height;
    return {
      index: picked.index,
      ratio: height > 0 ? positionRatio((scroll - picked.top) / height) : 0
    };
  }

  // 是否接近底部：可滚动距离 - 当前滚动位置 <= threshold。
  // scrollHeight <= clientHeight（内容不足一屏）也算「到底」。
  function nearBottom(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const scrollTop = Math.max(0, toFinite(opts.scrollTop) || 0);
    const scrollHeight = Math.max(0, toFinite(opts.scrollHeight) || 0);
    const clientHeight = Math.max(0, toFinite(opts.clientHeight) || 0);
    const thresholdRaw = toFinite(opts.threshold);
    const threshold = Math.max(0, thresholdRaw == null ? AUTO_APPEND_THRESHOLD : thresholdRaw);
    const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
    return maxScrollTop - scrollTop <= threshold;
  }

  // 上一章 / 下一章：direction < 0 = 上一章，其它 = 下一章。
  // 已经在章首 / 章尾时返回 null（按钮置灰、不会越界）。
  function stepIndex(current, total, direction) {
    const safeTotal = Math.max(0, Math.floor(Number(total) || 0));
    if (!safeTotal) return null;
    const raw = toFinite(current);
    const base = Math.min(Math.max(Math.floor(raw == null ? 0 : raw), 0), safeTotal - 1);
    const delta = Number(direction) < 0 ? -1 : 1;
    const target = base + delta;
    return target >= 0 && target < safeTotal ? target : null;
  }

  // 全书字数（书架 / 页脚展示用）：只认书目缓存里的非负整数，坏值跳过。
  function bookChars(chapters) {
    if (!Array.isArray(chapters)) return 0;
    let total = 0;
    for (const chapter of chapters) {
      const n = toFinite(chapter && chapter.chars);
      if (n == null || n <= 0) continue;
      total += Math.round(n);
    }
    return total;
  }

  return {
    READING_FONT_LEVELS,
    READING_FONT_LABELS,
    READING_FONT_DEFAULT,
    READING_LINE_LEVELS,
    READING_LINE_LABELS,
    READING_LINE_DEFAULT,
    AUTO_APPEND_THRESHOLD,
    MAX_LOADED_BLOCKS,
    clampLevel,
    fontLevel,
    lineLevel,
    fontSize,
    lineHeight,
    prefsForBook,
    withBookPrefs,
    positionRatio,
    positionAtScroll,
    readingPositionForBook,
    withReadingPosition,
    readingStartIndex,
    fontStepForKey,
    readingProgress,
    readingTitleSuffix,
    tocGroups,
    blockAtScroll,
    nearBottom,
    stepIndex,
    bookChars
  };
});
