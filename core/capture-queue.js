// 本次运行的剪贴板捕获队列（纯逻辑）：每次复制各记一条，逐条捕获、各自成章。
//
// 这里只回答「队列怎么记、怎么取、怎么删、最多留多少」：不读剪贴板、不碰 DOM、不读盘、
// 不写日志、不碰 Electron。正文由主进程内存持有，list() 只交元数据 + 首行预览 + 截断正文预览；
// 应用退出 / 关闭后台监听即清空（隐私口径见 README「剪贴板捕获的边界」）。
//
// 上限（默认值，可在 create 时覆盖）：
//   · maxEntries     最多 50 条，超了淘汰最旧的；
//   · maxEntryChars  单条最多 30 万字（=捕获正文上限 core/capture.js MAX_BODY_CHARS，直接引用，
//                    超了不入队（仍可直接捕获 / 用「正文」插进当前章）；
//   · maxTotalChars  总量最多 300 万字（=10 条满额），超了淘汰最旧的。
// 顺序：entries 从旧到新，list() 也按复制顺序返回（逐条捕获时从上往下点）。
'use strict';

// 单列表视图每条记录整块展示，需要截断正文（≤300 字 / 6 行）：截断规则与渲染层 pending 行
// 共用 core/capture.js 的 recordPreview，免得列表与面板两边显示不一样。只取纯函数，不引入 IO。
const captureLib = require('./capture');

const DEFAULT_MAX_ENTRIES = 50;
// 单条上限不再另写一份：直接跟 core/capture.js 的捕获正文上限走（2026-11-08 提到 30 万字），
// 两边各写一份只会漂移（commit-record 按 capture.MAX_BODY_CHARS 挡，队列按这里挡）。
const DEFAULT_MAX_ENTRY_CHARS = captureLib.MAX_BODY_CHARS;
const DEFAULT_MAX_TOTAL_CHARS = 3000000;
// 队列列表只显示首行预览（不是全文）：够认出是哪一段，又不把正文多发一份到渲染层。
const PREVIEW_LIMIT = 40;

function positiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.round(n));
}

// 首行预览：跳空行、把连续空白折成一个空格、超长截断加省略号；空文本返回空串。
function previewOf(text, limit = PREVIEW_LIMIT) {
  const source = typeof text === 'string' ? text : '';
  const max = positiveInt(limit, PREVIEW_LIMIT);
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    return line.length > max ? `${line.slice(0, max)}…` : line;
  }
  return '';
}

function createCaptureQueue(options = {}) {
  const maxEntries = positiveInt(options.maxEntries, DEFAULT_MAX_ENTRIES);
  const maxEntryChars = positiveInt(options.maxEntryChars, DEFAULT_MAX_ENTRY_CHARS);
  const maxTotalChars = positiveInt(options.maxTotalChars, DEFAULT_MAX_TOTAL_CHARS);
  const now = typeof options.now === 'function' ? options.now : Date.now;

  let entries = []; // 旧 → 新：[{ id, text, chars, at }]
  let nextId = 1;
  let totalChars = 0;

  function metaOf(entry) {
    return {
      id: entry.id,
      chars: entry.chars,
      at: entry.at,
      preview: previewOf(entry.text),
      // 整条记录的截断正文（列表项正文区用）；仍是截断文本，不是全文。
      previewText: captureLib.recordPreview(entry.text)
    };
  }

  // 超上限时从最旧一条开始丢，直到数量与总量都回到线内。
  function evictOverflow() {
    while (entries.length > maxEntries || totalChars > maxTotalChars) {
      const removed = entries.shift();
      if (!removed) break;
      totalChars -= removed.chars;
    }
  }

  // 记一条新复制。返回 { added, reason, entry }：
  //   added=false / reason='empty'     空文本或全空白（不入队）；
  //   added=false / reason='too-large' 单条超过 maxEntryChars（不入队，调用方可引导直接捕获）；
  //   added=false / reason='duplicate' 与最新一条完全相同（重复触发不入队）；
  //   added=true  / entry 是该条的元数据（id / chars / at / preview / previewText）。
  function add(text) {
    const source = typeof text === 'string' ? text : '';
    const chars = source.length;
    if (!chars || !source.trim()) return { added: false, reason: 'empty' };
    if (chars > maxEntryChars) return { added: false, reason: 'too-large', chars };
    const newest = entries[entries.length - 1];
    if (newest && newest.text === source) {
      return { added: false, reason: 'duplicate', entry: metaOf(newest) };
    }
    const entry = { id: nextId, text: source, chars, at: now() };
    nextId += 1;
    entries.push(entry);
    totalChars += chars;
    evictOverflow();
    return { added: true, entry: metaOf(entry) };
  }

  // 元数据列表（按复制顺序，旧 → 新）。不含正文全文；previewText 只是给列表看的截断预览。
  function list() {
    return entries.map(metaOf);
  }

  // 取一条的正文（只在用户显式点开某一条时调用）；不存在返回 null。
  function get(id) {
    const at = entries.findIndex((entry) => entry.id === id);
    return at < 0 ? null : { id: entries[at].id, text: entries[at].text, chars: entries[at].chars, at: entries[at].at };
  }

  // 队列里是否有这段原文（Ctrl+Alt+V 触发时判断「刚复制的这段是否已经入队」用）。
  function hasText(text) {
    const source = typeof text === 'string' ? text : '';
    return entries.some((entry) => entry.text === source);
  }

  function remove(id) {
    const at = entries.findIndex((entry) => entry.id === id);
    if (at < 0) return false;
    totalChars -= entries[at].chars;
    entries.splice(at, 1);
    return true;
  }

  function clear() {
    const count = entries.length;
    entries = [];
    totalChars = 0;
    return count;
  }

  return {
    add,
    list,
    get,
    hasText,
    remove,
    clear,
    size: () => entries.length,
    totalChars: () => totalChars,
    maxEntries,
    maxEntryChars,
    maxTotalChars
  };
}

module.exports = {
  createCaptureQueue,
  previewOf,
  DEFAULT_MAX_ENTRY_CHARS,
  PREVIEW_LIMIT
};
