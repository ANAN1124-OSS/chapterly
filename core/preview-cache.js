// C2（审计 #2 / P2）：消「预览 → 执行」双读 —— 整本操作的正文快照。
//
// C1 之后整本操作已经按批读正文，但「预览 → 作者确认 → 执行」这条链还是把同一批章读两遍：
//   整本整理     previewFormatBook 读一遍 → formatBook    再读一遍
//   整本替换     searchBook         读一遍 → replaceInBook 再读一遍
// 预览读到的正文本来就在内存里（这一批），执行时若**文件没变**（mtime + size 与预览时完全一致）
// 直接复用那份正文即可：执行阶段命中时只多一次 stat，读盘从 2N 次降到 N 次。
//
// 三条边界（缓存只是加速，绝不是事实来源）：
//   1. 只在主进程内存里：不写盘、不进书库 / 书目.json / 配置文件；
//   2. 校验口径是 mtime + size（与 core/search-index.js 的增量校验同一套）：任何一个不一致就当
//      没有缓存，照旧读盘 —— 绝不用过期正文去改作者的书。反过来，同一毫秒 + 同尺寸的外部改写
//      在理论上无法分辨（FAT 一类 2 秒时间精度的盘上更明显），所以快照同时有下面的 TTL 兜底；
//   3. 有 TTL（默认 10 分钟）、快照数上限与正文容量上限（默认 3M 字符 ≈ 6 MB）：放不下的章不缓存，
//      执行阶段照旧读盘。同一本书再预览一次会替换旧快照。
const path = require('node:path');

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_SNAPSHOTS = 4;
const DEFAULT_MAX_TEXT_CHARS = 3 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 4096;

// 同一本书的键：大小写不敏感（Windows 路径） + 绝对路径，与 withBookLock 同一口径。
// storage 的读取上下文也用它做键，保证「预览写进哪本、执行从哪本取」不会串书。
function bookKey(bookPath) {
  return path.resolve(String(bookPath == null ? '' : bookPath)).toLowerCase();
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

// 一份快照：预览阶段逐章 remember 正文 + 当时的 mtime / size；执行阶段 lookup 命中就用。
// 快照本身不认识业务（整理 / 替换都只是「读正文」），所以不需要按操作类型分家。
function createSnapshot(key, createdAt, limits) {
  const entries = new Map();
  const snapshot = {
    bookPath: key,
    createdAt,
    textChars: 0,
    // 记一章；正文超预算 / 条目超上限就不记（返回 false，执行阶段照旧读盘）
    remember(file, chapter) {
      if (typeof file !== 'string' || !file) return false;
      if (!chapter || typeof chapter.text !== 'string') return false;
      if (!Number.isFinite(chapter.mtimeMs) || !Number.isFinite(chapter.size)) return false;
      if (entries.has(file)) return false; // 预览只读一遍，同一章出现两次（书目重复登记）不重复占用
      if (entries.size >= limits.maxEntries) return false;
      if (snapshot.textChars + chapter.text.length > limits.maxTextChars) return false;
      entries.set(file, {
        mtimeMs: chapter.mtimeMs,
        size: chapter.size,
        text: chapter.text
      });
      snapshot.textChars += chapter.text.length;
      return true;
    },
    // 只按章名取条目（不做 IO）；调用方拿到后自己按 stat 判「文件还是不是那一份」
    lookup(file) {
      return entries.get(file) || null;
    },
    entryCount() {
      return entries.size;
    },
    // 释放正文引用（执行完 / 预览失败 / 被新版快照替换）
    clear() {
      entries.clear();
      snapshot.textChars = 0;
    }
  };
  return snapshot;
}

// 正文快照仓库。所有方法都是同步的（只有 Map 操作），IO 留给 storage 自己决定。
function createPreviewCache(options = {}) {
  const ttlMs = positiveNumber(options.ttlMs, DEFAULT_TTL_MS);
  const maxSnapshots = positiveNumber(options.maxSnapshots, DEFAULT_MAX_SNAPSHOTS);
  const maxTextChars = positiveNumber(options.maxTextChars, DEFAULT_MAX_TEXT_CHARS);
  const maxEntries = positiveNumber(options.maxEntries, DEFAULT_MAX_ENTRIES);
  const now = typeof options.now === 'function' ? options.now : Date.now;

  // key = 书的绝对小写路径；Map 插入序 = 最旧的快照在前（超过上限就淘汰它）
  const snapshots = new Map();

  function release(snapshot) {
    if (!snapshot) return;
    snapshot.clear();
  }

  function evict(key) {
    const snapshot = snapshots.get(key);
    if (!snapshot) return false;
    snapshots.delete(key);
    release(snapshot);
    return true;
  }

  return {
    // 预览开始：换一份新快照（旧的一律作废，避免两次预览的正文混在一起）
    begin(bookPath) {
      const key = bookKey(bookPath);
      evict(key);
      const snapshot = createSnapshot(key, now(), { maxTextChars, maxEntries });
      snapshots.set(key, snapshot);
      while (snapshots.size > maxSnapshots) {
        const oldest = snapshots.keys().next().value;
        if (oldest === undefined) break;
        evict(oldest);
      }
      return snapshot;
    },
    // 执行开始：取出这本书的快照并从仓库移除（过期的直接丢）。宿主用完要 drop。
    take(bookPath) {
      const key = bookKey(bookPath);
      const snapshot = snapshots.get(key);
      if (!snapshot) return null;
      snapshots.delete(key);
      if (now() - snapshot.createdAt > ttlMs) {
        release(snapshot);
        return null;
      }
      return snapshot;
    },
    // 主动释放（执行结束 / 预览失败）。重复调用、传 null 都安全。
    drop(snapshot) {
      if (!snapshot) return;
      if (snapshots.get(snapshot.bookPath) === snapshot) snapshots.delete(snapshot.bookPath);
      release(snapshot);
    },
    // 观察用（单测 / 排查内存）：当前仓库里有几份快照、一共缓存了多少字符
    sizes() {
      let textChars = 0;
      for (const snapshot of snapshots.values()) textChars += snapshot.textChars;
      return { snapshots: snapshots.size, textChars };
    }
  };
}

module.exports = {
  bookKey,
  createPreviewCache
};
