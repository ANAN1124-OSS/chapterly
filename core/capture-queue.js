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
// 两个 chars 上限口径不同（2026-11-15 放宽）：单条按 **chars（去空白字数）** 挡 —— 和界面上
// 「N 字」、单章上限、导入口径是同一个数；总量仍按 **rawLength（含空白的原文长度）** 挡 ——
// 它挡的是内存，不是显示字数。以前单条也按 rawLength 挡，一段 30 万字的稿子光是换行就超线、
// 会被静默丢掉（作者 2026-11-15 报的就是这个）。
// 顺序：entries 从旧到新，list() 也按复制顺序返回（逐条捕获时从上往下点）。
'use strict';

// 单列表视图每条记录整块展示，需要截断正文（≤300 字 / 6 行）：截断规则与渲染层 pending 行
// 共用 core/capture.js 的 recordPreview，免得列表与面板两边显示不一样。只取纯函数，不引入 IO。
const captureLib = require('./capture');

// V108（v1.8.0 WP-24）：chars 就是「正文字数」（去空白），直接复用 core/chapters.js 的唯一实现
// （core/capture.js 已经引用同一份）。存进条目的 rawLength 才是含空白的原文长度 ——
// 上限 / 淘汰按它算（上限是内存口径，不是字数口径）。
const countChars = captureLib.countChars;

const DEFAULT_MAX_ENTRIES = 50;
// 单条上限不再另写一份：直接跟 core/capture.js 的捕获正文上限走（2026-11-08 提到 30 万字），
// 两边各写一份只会漂移（commit-record 按 capture.MAX_BODY_CHARS 挡，队列按这里挡）。
const DEFAULT_MAX_ENTRY_CHARS = captureLib.MAX_BODY_CHARS;
// 队列总量上限 = 10 条 × 30 万字满额 = 300 万。2026-11-17（审计 B3）：单条原文长度上限
// （capture.MAX_RAW_CHARS）与它同值，commit-record 的原文闸也用那一份 —— 两处各写一个
// 3000000 只会漂移，这里直接引用；maxTotalChars 仍可按实例覆盖（单测口径不变）。
const DEFAULT_MAX_TOTAL_CHARS = captureLib.MAX_RAW_CHARS;
// 队列列表只显示首行预览（不是全文）：够认出是哪一段，又不把正文多发一份到渲染层。
const PREVIEW_LIMIT = 40;

function positiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.round(n));
}

// JS 的 \s（String#trim / /\s/ 正则）判定的空白码位：逐码位判定，比整行 replace 少一次分配，
// 也不会漏掉全角空格 / 不换行空格 / 行分隔符这些「看着不是空格、trim 却算空白」的码位。
function isWhitespaceCode(code) {
  return (
    (code >= 0x0009 && code <= 0x000d) || // \t \n \v \f \r（\n 在调用处单独当行尾处理）
    code === 0x0020 || // 空格
    code === 0x00a0 || // 不换行空格
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 || // 行分隔符
    code === 0x2029 || // 段分隔符
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 || // 全角空格
    code === 0xfeff // BOM（\s 也认）
  );
}

// CTXT-B-05（审计低批）：预览按码元截断，截断点落在代理对中间时会把 emoji 切成孤立高代理
// （界面显示成 �）。与 core/common.js 的 truncateSafe / core/capture.js 的 boundedPreviewPrefix
// 同一口径：截到高位代理就回退一个码元。预览只用于列表识别，数据本身不截断。
function slicePreview(line, max) {
  let end = Math.max(0, max);
  if (end > 0) {
    const code = line.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return line.slice(0, end);
}

// 首行预览：跳空行、把连续空白折成一个空格、超长截断加省略号；空文本返回空串。
// 2026-11-17（审计 B4）：原来对全文 split(/\r?\n/) 再对首个非空行整行 replace(/\s+/g,' ')；
// 队列 50 条 × 300 万字时 list() 每次都重扫全文。改成单趟按行推进、只看首个非空行，折叠结果
// 一超过 limit 字就立刻返回（后面的内容影响不到前 limit 个字；行尾空白本来就要 trim 掉）。
function previewOf(text, limit = PREVIEW_LIMIT) {
  const source = typeof text === 'string' ? text : '';
  const max = positiveInt(limit, PREVIEW_LIMIT);
  let line = ''; // 当前行的折叠结果：不含行首 / 行尾空白，行内连续空白只留一个空格
  let pendingSpace = false;
  let i = 0;
  while (i < source.length) {
    const code = source.charCodeAt(i);
    if (code === 10) {
      // 行尾：这一行有内容就返回（跳空行的口径不变）；没有就接着看下一行
      if (line) return line.length > max ? `${slicePreview(line, max)}…` : line;
      pendingSpace = false;
      i += 1;
      continue;
    }
    if (code === 13 && source.charCodeAt(i + 1) === 10) {
      i += 1; // CRLF：\r 属于行尾，交给下一拍的 \n 收行
      continue;
    }
    if (isWhitespaceCode(code)) {
      if (line) pendingSpace = true; // 行首空白直接丢；行内空白先挂起，等下一个实字再补一个空格
      i += 1;
      continue;
    }
    let width = 1;
    let ch = source[i];
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < source.length) {
      const low = source.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        width = 2; // 代理对整对收（原实现按码元 slice，这里只保证不拆开）
        ch = source.slice(i, i + 2);
      }
    }
    if (pendingSpace) {
      line += ' ';
      pendingSpace = false;
    }
    line += ch;
    if (line.length > max) return `${slicePreview(line, max)}…`; // 折叠后已超 limit → 截断口径确定，立即返回
    i += width;
  }
  if (!line) return '';
  return line.length > max ? `${slicePreview(line, max)}…` : line;
}

function createCaptureQueue(options = {}) {
  const maxEntries = positiveInt(options.maxEntries, DEFAULT_MAX_ENTRIES);
  const maxEntryChars = positiveInt(options.maxEntryChars, DEFAULT_MAX_ENTRY_CHARS);
  const maxTotalChars = positiveInt(options.maxTotalChars, DEFAULT_MAX_TOTAL_CHARS);
  const now = typeof options.now === 'function' ? options.now : Date.now;

  let entries = []; // 旧 → 新：[{ id, text, chars, rawLength, at, ownerWindowId }]
  let nextId = 1;
  let totalChars = 0; // 各条 rawLength 之和（内存口径；上限按它淘汰）

  // S1（一轮·中）：每条记录记「哪扇窗口的捕获面板拥有它」。
  // 记录本身由后台剪贴板监听 / 全局快捷键写进来（那时还没有窗口上下文），所以入队时可以是 null；
  // 打开捕获面板的窗口（capture:queue-list）通过 claim() 认领这批无主记录，此后只有它能看到 / 取走。
  // 归属只在本进程内存里：窗口关掉即清（隐私口径「只在本窗口可见、关窗即弃」）。
  function ownerIdOf(entry) {
    if (!entry || entry.ownerWindowId == null) return null;
    const n = Number(entry.ownerWindowId);
    return Number.isFinite(n) ? n : null;
  }

  // 归一化窗口 id：非法值一律 null（= 还没有归属）。
  function normalizeOwner(value) {
    if (value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  // 某一扇窗口能不能操作这一条：无主（等待认领）或归属它自己。
  function canAccess(id, ownerWindowId) {
    const at = entries.findIndex((entry) => entry.id === Number(id));
    if (at < 0) return false;
    const owner = ownerIdOf(entries[at]);
    const self = normalizeOwner(ownerWindowId);
    if (owner == null) return true;
    return self != null && owner === self;
  }

  // 无主记录归给打开面板的窗口；已经有主的记录不动（不许抢别的窗口的记录）。
  function claim(ownerWindowId) {
    const self = normalizeOwner(ownerWindowId);
    if (self == null) return 0;
    let claimed = 0;
    for (const entry of entries) {
      if (entry.ownerWindowId == null) {
        entry.ownerWindowId = self;
        claimed += 1;
      }
    }
    return claimed;
  }

  // 本窗口可见的条目：自己的 + 还没有主的（旧版本 / 监听器刚写进来还没认领）。
  function listFor(ownerWindowId) {
    const self = normalizeOwner(ownerWindowId);
    return entries.filter((entry) => entry.ownerWindowId == null || ownerIdOf(entry) === self).map(metaOf);
  }

  function sizeFor(ownerWindowId) {
    const self = normalizeOwner(ownerWindowId);
    return entries.filter((entry) => entry.ownerWindowId == null || ownerIdOf(entry) === self).length;
  }

  // 入队时算一次预览就挂在条目上（2026-11-17 审计 B4）：正文在队列里不可变，list() 不该对每条
  // 原文重算。面板开着时每记一条新复制就 refreshQueue（renderer/renderer.js:5772/5785），
  // 50 条 × 300 万字的队列每次重扫是周期性热点；改成「入队算一次、list() 只读缓存」后，
  // list() 成本 = O(条数 × 预览长度)。两个预览函数的口径一点没变（仍共用 core/capture.js）。
  function previewFieldsOf(entry) {
    return { preview: previewOf(entry.text), previewText: captureLib.recordPreview(entry.text) };
  }

  function metaOf(entry) {
    return {
      id: entry.id,
      chars: entry.chars,
      rawLength: entry.rawLength,
      at: entry.at,
      preview: entry.preview,
      // 整条记录的截断正文（列表项正文区用）；仍是截断文本，不是全文。
      previewText: entry.previewText
    };
  }

  // 超上限时从最旧一条开始丢，直到数量与总量都回到线内。
  function evictOverflow() {
    while (entries.length > maxEntries || totalChars > maxTotalChars) {
      const removed = entries.shift();
      if (!removed) break;
      totalChars -= removed.rawLength;
    }
  }

  // 记一条新复制。返回 { added, reason, entry }：
  //   added=false / reason='empty'     空文本或全空白（不入队）；
  //   added=false / reason='too-large' 单条超过 maxEntryChars（不入队，调用方可引导直接捕获）；
  //   added=false / reason='duplicate' 与最新一条完全相同（重复触发不入队）；
  //   added=true  / entry 是该条的元数据（id / chars / rawLength / at / preview / previewText）。
  // chars 是去空白正文字数（V108：与插入后状态栏同一口径），maxEntryChars 按它挡（2026-11-15 放宽）；
  // maxTotalChars / 淘汰仍按 rawLength（内存口径）。
  function add(text, addOptions = {}) {
    const source = typeof text === 'string' ? text : '';
    const rawLength = source.length;
    if (!source.trim()) return { added: false, reason: 'empty' };
    const chars = countChars(source);
    if (chars > maxEntryChars) return { added: false, reason: 'too-large', chars, rawLength };
    // 单条原文比整个队列的预算还大：放进会被 evictOverflow 立刻淘汰（等于白记一条），
    // 这里直接按 too-large 拒 —— 不然 add 会返回 added:true，而列表里什么都没有（静默）。
    if (rawLength > maxTotalChars) return { added: false, reason: 'too-large', chars, rawLength };
    const newest = entries[entries.length - 1];
    if (newest && newest.text === source) {
      return { added: false, reason: 'duplicate', entry: metaOf(newest) };
    }
    const entry = {
      id: nextId,
      text: source,
      chars,
      rawLength,
      at: now(),
      // S1：全局快捷键触发时知道是哪扇窗口要弹面板；后台监听拍记进来的先留空，等面板打开时 claim。
      ownerWindowId: normalizeOwner(addOptions && addOptions.ownerWindowId)
    };
    // 预览只在入队时算这一次（list() 读缓存）：条目被删除 / 淘汰时预览跟着走，不另留引用。
    Object.assign(entry, previewFieldsOf(entry));
    nextId += 1;
    entries.push(entry);
    totalChars += rawLength;
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
    return at < 0
      ? null
      : {
          id: entries[at].id,
          text: entries[at].text,
          chars: entries[at].chars,
          rawLength: entries[at].rawLength,
          at: entries[at].at
        };
  }

  // 队列里是否有这段原文（Ctrl+Alt+V 触发时判断「刚复制的这段是否已经入队」用）。
  function hasText(text) {
    const source = typeof text === 'string' ? text : '';
    return entries.some((entry) => entry.text === source);
  }

  function remove(id) {
    const at = entries.findIndex((entry) => entry.id === id);
    if (at < 0) return false;
    totalChars -= entries[at].rawLength;
    entries.splice(at, 1);
    return true;
  }

  function clear() {
    const count = entries.length;
    entries = [];
    totalChars = 0;
    return count;
  }

  // S1：带归属的删除 / 清空 / 关窗回收（主进程的 capture:queue-* 走这一组）。
  // 非 owner 一律拒绝（返回 false / 0），不删别人的记录。
  function removeFor(id, ownerWindowId) {
    if (!canAccess(id, ownerWindowId)) return false;
    return remove(id);
  }

  function clearFor(ownerWindowId) {
    const self = normalizeOwner(ownerWindowId);
    const keep = [];
    let removed = 0;
    for (const entry of entries) {
      const owner = ownerIdOf(entry);
      if (owner == null || (self != null && owner === self)) {
        totalChars -= entry.rawLength;
        removed += 1;
      } else {
        keep.push(entry);
      }
    }
    entries = keep;
    return removed;
  }

  // 窗口关闭：这一扇窗口的记录全部丢弃（隐私口径），别的窗口的不动。
  function releaseOwner(ownerWindowId) {
    const self = normalizeOwner(ownerWindowId);
    if (self == null) return 0;
    const keep = [];
    let removed = 0;
    for (const entry of entries) {
      if (ownerIdOf(entry) === self) {
        totalChars -= entry.rawLength;
        removed += 1;
      } else {
        keep.push(entry);
      }
    }
    entries = keep;
    return removed;
  }

  return {
    add,
    list,
    get,
    hasText,
    remove,
    clear,
    size: () => entries.length,
    // S1（一轮·中）：按窗口归属的视图与操作
    claim,
    listFor,
    sizeFor,
    canAccess,
    removeFor,
    clearFor,
    releaseOwner,
    // 队列总原始长度（各条 rawLength 之和，含空白）：maxTotalChars 的淘汰口径，不是显示字数。
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
