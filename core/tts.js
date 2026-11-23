// 朗读（提案 5.3）——纯逻辑，不读盘、不依赖 Electron，可单测。
//
// 渲染层只负责把 chunks 交给系统语音（Electron 的 speechSynthesis，Windows 走本地 SAPI）；
// 「正文怎么切成一段一段」在这里算，单测覆盖。朗读**只读正文**：不改编辑区、不写盘。
//
// 切分原则：
//   ① 一个自然段（非空行）先占一个 chunk —— 这样「上一段 / 下一段」和跟随高亮都对得上段落；
//   ② 单段太长（超过 maxChunkChars）时按句末标点（。！？；…）切开再拼，仍超长才硬切；
//   ③ 首尾空白（含全角空格）不进朗读文本，也不会被切到句子中间；
//   ④ 不切开代理对（emoji 等），不会把两个字符合成一个乱码。
//
// 定位约定：start / end 都是「去掉 BOM、CRLF 归一成 \n」之后的字符位置，
// 与编辑区 textarea 的 value 完全一致，因此可以直接 setSelectionRange(start, end)。
//
// v0.9 B-3（审计 F3）：段落 / 行 / 去首尾空白这一层规则下沉到 core/paragraphs.js，
// 和渲染层 editor-logic.js 共用同一份实现（以前两边各抄一份）；本模块不再自己定义。
const chaptersLib = require('./chapters');
const { clampInt } = require('./common');
const paragraphsLib = require('./paragraphs');
const { trimmedRange, paragraphRanges } = paragraphsLib;

const DEFAULT_OPTIONS = Object.freeze({
  maxChunkChars: 160, // 单个 chunk 最多多少字（太长系统语音会吞字 / 卡顿，进度也看不见）
  maxChunks: 5000 // 单章最多返回多少段（防止病态长文撑爆渲染层）
});

const OPTION_LIMITS = Object.freeze({
  maxChunkChars: [40, 1200],
  maxChunks: [50, 20000]
});

// 正文超过这么多字符只处理前面的部分（病态输入兜底，正常一章远小于这个数）
const MAX_SOURCE_CHARS = 1000000;

// 句末标点：遇到它们就认为一句话结束（连续的 …… 只算一个单位，见 consumeEnders）
const SENTENCE_ENDERS = new Set(['。', '！', '？', '!', '?', '；', ';', '…']);
// 句末标点后面紧跟的收尾符号要留在同一句里（引号、括号等），别被切到下一句开头
const CLOSERS = new Set(['”', '’', '」', '』', '）', ')', '】', ']', '》', '〉', '－', '—']);
// 硬切长句时优先在这些位置断开（次级标点 + 空白），比直接砍在字中间自然
const SOFT_BREAKS = new Set(['，', '、', '：', ',', ':', '—']);

function sanitizeOptions(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const caret = Number(source.caret);
  return {
    maxChunkChars: clampInt(source.maxChunkChars, DEFAULT_OPTIONS.maxChunkChars, OPTION_LIMITS.maxChunkChars),
    maxChunks: clampInt(source.maxChunks, DEFAULT_OPTIONS.maxChunks, OPTION_LIMITS.maxChunks),
    // caret 只影响返回的 startIndex（从光标处开始朗读），不影响切分
    caret: Number.isFinite(caret) ? Math.max(0, Math.floor(caret)) : 0
  };
}

// normalizeText 从 core/common.js 来（B6）：和 storage.loadChapterText / 编辑区同一份口径
// （去掉开头 BOM、CRLF 归一成 LF）。

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

// 把一段切成「句子」范围：句末标点 + 紧跟的收尾符号算一句，返回范围已 trim
function sentencePieces(text, start, end) {
  const pieces = [];
  let from = start;
  let i = start;
  while (i < end) {
    if (!SENTENCE_ENDERS.has(text[i])) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < end && (SENTENCE_ENDERS.has(text[j]) || CLOSERS.has(text[j]))) j += 1;
    const piece = trimmedRange(text, from, j);
    if (piece) pieces.push(piece);
    from = j;
    i = j;
  }
  const tail = trimmedRange(text, from, end);
  if (tail) pieces.push(tail);
  return pieces;
}

// 超长句子硬切：优先落在空白 / 次级标点，且绝不切开代理对
function hardSplit(text, start, end, maxChars, push) {
  let cursor = start;
  while (end - cursor > maxChars) {
    let cut = Math.min(end, cursor + maxChars);
    if (cut < end && isHighSurrogate(text.charCodeAt(cut - 1)) && isLowSurrogate(text.charCodeAt(cut))) {
      cut -= 1;
    }
    // 只在窗口后 40% 里找更自然的断点，避免切出很多几字的小段
    const floor = cursor + Math.max(1, Math.floor(maxChars * 0.6));
    let preferred = -1;
    for (let i = cut; i > floor; i -= 1) {
      const ch = text[i - 1];
      if (/\s/.test(ch) || SOFT_BREAKS.has(ch)) {
        preferred = i;
        break;
      }
    }
    if (preferred > cursor) cut = preferred;
    push(trimmedRange(text, cursor, cut));
    cursor = cut;
    // 下一段从非空白处开始，别让朗读文本以空格开头
    while (cursor < end && /\s/.test(text[cursor])) cursor += 1;
  }
  if (cursor < end) push(trimmedRange(text, cursor, end));
}

// 把一段（可能很长）拆成若干 chunk：先按句子装，装不下再硬切
function paragraphChunks(text, para, maxChunkChars, push) {
  const pieces = sentencePieces(text, para.start, para.end);
  let chunkStart = -1;
  let chunkEnd = -1;
  const flush = () => {
    if (chunkStart < 0) return;
    const range = trimmedRange(text, chunkStart, chunkEnd);
    if (range) push(range);
    chunkStart = -1;
    chunkEnd = -1;
  };
  for (const piece of pieces) {
    if (piece.end - piece.start > maxChunkChars) {
      flush();
      hardSplit(text, piece.start, piece.end, maxChunkChars, push);
      continue;
    }
    if (chunkStart < 0) {
      chunkStart = piece.start;
      chunkEnd = piece.end;
    } else if (piece.end - chunkStart <= maxChunkChars) {
      chunkEnd = piece.end;
    } else {
      flush();
      chunkStart = piece.start;
      chunkEnd = piece.end;
    }
  }
  flush();
}

// 光标位置落在哪一段：落在两段之间算「下一段」；越界夹到首尾；空数组返回 -1
function chunkIndexAt(chunks, position) {
  if (!Array.isArray(chunks) || !chunks.length) return -1;
  const n = Number(position);
  if (!Number.isFinite(n)) return 0;
  const pos = Math.max(0, Math.floor(n));
  let lo = 0;
  let hi = chunks.length - 1;
  let answer = chunks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pos < chunks[mid].end) {
      answer = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return answer;
}

// 主入口：返回 { chunks, startIndex, paragraphs, rawLength, totalChars, truncated, options }
// T-01（三审）：这个字段原来叫 `chars`，值是「归一后的全文长度（含空白）」—— 与 core/proofread.js /
// core/sensitive.js 回包里的 `chars`（countChars 去空白字数，X4 / WP-24 口径）同名不同义，谁按名字
// 复用就会拿到两套「字数」。现在按语义改名 `rawLength`：含空白的长度只适合当坐标 / 内存口径，
// 界面上显示字数一律用 `totalChars`（= countChars，与状态栏 / 校对 / 预检同一份）。
// B13（v1.8.0 WP-29）：先按 MAX_SOURCE_CHARS 截断原始正文，再只对截断后的前缀归一 —— 旧实现先把
// 全文做一遍正文归一（去 BOM / CRLF→LF）再 slice，还要对归一后的全文数字数，病态长文在「只处理
// 前 100 万字」时仍会做两次全尺寸分配。下面两个助手与 core/common.js 的归一逐字符等价
// （只去开头 BOM、CRLF / 独立 CR 归一成 LF），只是把工作限制在前缀范围内。
function normalizedLength(source) {
  const s = String(source == null ? '' : source);
  const bom = s.charCodeAt(0) === 0xfeff ? 1 : 0;
  let crlf = 0;
  let at = s.indexOf('\r', bom);
  while (at >= 0) {
    if (s.charCodeAt(at + 1) === 0x0a) crlf += 1;
    at = s.indexOf('\r', at + 1);
  }
  return s.length - bom - crlf;
}

// 归一后的前 limit 个字符（limit 是归一后坐标，不是原始下标）
// CTXT-B-06（审计低批）：两处都要按「字」处理，不能让代理对从中间切开 ——
//   · 无 CR 快路径切片前若截到高位代理，回退一个码元（与 core/common.truncateSafe 同一口径）；
//   · 有 CR 的超限分支按码点推进（代理对整对算 1 个产出），否则同一段文本在 CR / 非 CR
//     两条路径下「第 N 个字」的位置不一致，极限长度文本末尾还会留下孤立代理。
function normalizePrefix(source, limit) {
  const s = String(source == null ? '' : source);
  const start = s.charCodeAt(0) === 0xfeff ? 1 : 0;
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  if (start >= s.length || max === 0) return '';
  // 常见路径：没有 CR（不用做替换）→ 直接 slice；有 CR 但整段都没超限 → 一次原生 replace。
  const firstCr = s.indexOf('\r', start);
  if (firstCr < 0) {
    if (s.length - start <= max) return s.slice(start);
    let end = start + max;
    const last = s.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1; // 截断点在高位代理上：整个码点都不要
    return s.slice(start, end);
  }
  if (s.length - start <= max) return s.slice(start).replace(/\r\n?/g, '\n');
  // 超限 + 有 CR：先数到「产出 max 个归一字」需要多少原始字符，再只对这段前缀做替换。
  let produced = 0;
  let cursor = start;
  let hasCr = false;
  while (cursor < s.length && produced < max) {
    const code = s.charCodeAt(cursor);
    if (code === 0x0d) {
      hasCr = true;
      cursor += s.charCodeAt(cursor + 1) === 0x0a ? 2 : 1;
    } else if (code >= 0xd800 && code <= 0xdbff && cursor + 1 < s.length) {
      const low = s.charCodeAt(cursor + 1);
      cursor += low >= 0xdc00 && low <= 0xdfff ? 2 : 1; // 代理对整对算一个字
    } else {
      cursor += 1;
    }
    produced += 1;
  }
  const raw = s.slice(start, cursor);
  return hasCr ? raw.replace(/\r\n?/g, '\n') : raw;
}

function buildChunks(text, rawOptions) {
  const options = sanitizeOptions(rawOptions);
  const source = String(text == null ? '' : text);
  const fullLength = normalizedLength(source);
  const limit = Math.min(fullLength, MAX_SOURCE_CHARS);
  const body = normalizePrefix(source, limit);
  const truncatedBySize = limit < fullLength;

  const chunks = [];
  let truncated = truncatedBySize;
  const paragraphs = paragraphRanges(body);
  for (const para of paragraphs) {
    if (chunks.length >= options.maxChunks) {
      truncated = true;
      break;
    }
    paragraphChunks(body, para, options.maxChunkChars, (range) => {
      if (!range) return;
      chunks.push({
        start: range.start,
        end: range.end,
        text: body.slice(range.start, range.end),
        paragraph: para.paragraph,
        line: para.line
      });
    });
  }
  if (chunks.length > options.maxChunks) {
    chunks.length = options.maxChunks;
    truncated = true;
  }

  return {
    chunks,
    startIndex: chunkIndexAt(chunks, options.caret),
    paragraphs: paragraphs.length,
    rawLength: fullLength,
    totalChars: chaptersLib.countChars(source),
    truncated,
    options
  };
}

module.exports = {
  MAX_SOURCE_CHARS,
  sanitizeOptions,
  paragraphRanges,
  sentencePieces,
  chunkIndexAt,
  buildChunks
};
