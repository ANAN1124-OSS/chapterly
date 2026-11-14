// 敏感词预检（只报告、不改动）——纯逻辑 + 词表读取，不依赖 Electron，可单测。
//
// 设计前提（提案 5.2）：词表完全由作者管理，应用**不内置任何词表**、保持中立。
// 作者在设置里指定一个自己的 txt（每行一个词），预检只按这个词表做字面匹配：
//   · 只报告命中的词、章名、行号列号与上下文，绝不改正文、绝不写盘
//   · 词表只读，不复制、不改写；文件缺失 / 编码异常 / 空词表都有明确提示
//   · 空行忽略；同一个词重复出现只算一次；单行超过 100 字视为坏行跳过
//   · 同一处有多个词重叠（例如词表里既有「色情」又有「色情小说」）只报最长的那个
//   · 字面匹配、区分大小写（不做正则、不做大小写折叠，避免作者以为「没命中」）
//
// 定位约定：index / length 都是「把 CRLF 归一成 \n、去掉 BOM」之后的字符位置，
// 与编辑区 textarea 的 value 一致，因此可以直接 setSelectionRange。
//
// A1（v1.8.0 WP-30）：词表读取 / 解码 / 公开信息这一段与校对词表共用 core/wordlist.js，
// 本文件只留「每行一个词」的行解析与本模块的错误码文案。
const findLib = require('./find');
const wordlist = require('./wordlist');
const wordscan = require('./wordscan');
const chaptersLib = require('./chapters');
const { clampInt, normalizeText, lineStartsOf, positionOf } = require('./common');

// 词表文件上限：再大就不像「每行一个词」的词表了，读进来只会拖慢整本检查
// （唯一实现在 core/wordlist.js，校对词表同一份）
const MAX_FILE_BYTES = wordlist.MAX_FILE_BYTES;
// 最多取前 5000 个词；超出部分不读，但会明确告诉作者（truncated）
const MAX_WORDS = 5000;
// 单行超过 100 字基本是误粘进来的正文，跳过并统计，不参与匹配
const MAX_WORD_LENGTH = 100;
// 单次扫描最多收集多少条原始命中（防止词表里混进「的」这类超高频字把内存打爆）
const RAW_MATCH_LIMIT = 100000;
// 结果列表里显示的上下文半径（和校对 / 查找一致）
const SNIPPET_RADIUS = 18;
// 摘要里最多列多少个词的命中数（明细里每一条仍会列出具体词）
const BY_WORD_LIMIT = 20;
// 整本预检最多返回多少条明细（总数照实统计）
const BOOK_ISSUE_LIMIT = 1500;

const DEFAULT_OPTIONS = Object.freeze({
  maxIssues: 500 // 单章最多返回多少条（总数仍会照实统计）
});

const OPTION_LIMITS = Object.freeze({
  maxIssues: [20, 5000]
});

function sanitizeOptions(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    maxIssues: clampInt(source.maxIssues, DEFAULT_OPTIONS.maxIssues, OPTION_LIMITS.maxIssues)
  };
}

// normalizeText 从 core/common.js 来（B6）：和 storage.loadChapterText / 编辑区同一份口径
// （去掉开头 BOM、CRLF 归一成 LF）。

// 渲染层 / 旧调用方传进来的词数组也兜底：去空白、去空、去重、限制长度与数量
function sanitizeWords(raw) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    const word = typeof item === 'string' ? item.trim() : '';
    if (!word || word.length > MAX_WORD_LENGTH || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= MAX_WORDS) break;
  }
  return out;
}

// 词表文本 → { words, stats }。只做「每行一个词」这一件事：
// 空行忽略、重复只留一次、超长行跳过；超过 MAX_WORDS 后不再读（truncated）。
function parseWordList(text) {
  const source = normalizeText(text);
  const lines = source.split('\n');
  const words = [];
  const seen = new Set();
  const stats = { lines: lines.length, emptyLines: 0, duplicates: 0, tooLong: 0, truncated: false };
  for (const line of lines) {
    const word = line.trim();
    if (!word) {
      stats.emptyLines += 1;
      continue;
    }
    if (word.length > MAX_WORD_LENGTH) {
      stats.tooLong += 1;
      continue;
    }
    if (seen.has(word)) {
      stats.duplicates += 1;
      continue;
    }
    if (words.length >= MAX_WORDS) {
      stats.truncated = true;
      break;
    }
    seen.add(word);
    words.push(word);
  }
  return { words, stats };
}

// 词表读取 / 解码 / 公开信息的流程在 core/wordlist.js（A1 / WP-30）：本模块只声明
// 「词」这个字段、自己的错误码与提示文案，行解析仍是上面的 parseWordList。
// 编码复用 txt.decodeBuffer（UTF-8 / UTF-16 BOM / GB18030），并额外识别两种「不是纯文本」：
// 带 NUL 的二进制、解码出替换字符 U+FFFD 的坏编码 —— 这些判定也只在共享核心里写一遍。
const READER = wordlist.createReader({
  field: 'words',
  parse: parseWordList,
  codes: {
    empty: 'WORD_LIST_EMPTY',
    tooBig: 'WORD_LIST_TOO_BIG',
    badEncoding: 'WORD_LIST_BAD_ENCODING',
    notConfigured: 'WORD_LIST_NOT_CONFIGURED',
    missing: 'WORD_LIST_MISSING',
    unreadable: 'WORD_LIST_UNREADABLE',
    notFile: 'WORD_LIST_NOT_FILE'
  },
  messages: {
    emptyFile: '词表是空文件（每行一个词）',
    emptyList: '词表里没有有效的词（每行一个词，空行会被忽略）',
    tooBig: '词表文件太大（上限 4MB），请换一个小一点的 txt',
    binary: '词表不像是纯文本（检测到二进制内容），请用 UTF-8 / UTF-16 / GBK 编码的 txt',
    badEncoding: '词表编码无法识别（不是 UTF-8 / UTF-16 / GBK 文本），请另存为 UTF-8 的 txt',
    notConfigured: '还没有指定敏感词表（应用不内置词表，请先选一个自己的 txt）',
    publicEmpty: '还没有指定敏感词表',
    notFile: '选中的不是一个文件，请选词表 txt'
  }
});

// 词表字节 → { ok, words, stats } 或 { ok:false, code, message }
function decodeWordListBuffer(buffer) {
  return READER.decodeBuffer(buffer);
}

// 读词表文件（只读）。任何失败都返回结构化结果，由界面给出明确提示，不抛异常。
async function readWordListFile(filePath) {
  return READER.readFile(filePath);
}

// 只给渲染层的词表信息：绝不把词表内容（words）带过去，界面只需要数量与状态
function publicWordListInfo(list) {
  return READER.publicInfo(list);
}

// 行号列号与行首位置表从 core/common.js 来（B6）：和校对面板同一份算法（二分查找行首）。

// 扫描一段正文。返回 { total, issues, byWord, wordHitCount, wordCount, truncated, chars }。
// total 是「去重叠之后」的全部命中数；issues 只保留前 maxIssues 条明细（带行号列号与上下文）。
// B1（审计 P0-2）：改成 core/wordscan.js 的 Aho-Corasick 单次遍历（原来每个词 indexOf 扫一遍正文，
// 5000 词 × 500 万字要 19–20 秒）。重叠取最长 / RAW_MATCH_LIMIT / 区分大小写 / 位置排序语义不变。
function scanText(text, rawWords, rawOptions) {
  const options = sanitizeOptions(rawOptions);
  const words = sanitizeWords(rawWords);
  const source = normalizeText(text);
  const scan = wordscan.scanTerms(source, words, { rawMatchLimit: RAW_MATCH_LIMIT });
  // A4 / P-03：一边遍历命中一边聚合，不再先物化一份「全部命中」的中间数组；
  // 明细只给前 maxIssues 条算行号 / 拼上下文，超出的只计数——
  // 「的」这类高频词命中上万条时，不会再为被截掉的条目白拼片段。
  const byWordMap = new Map();
  const issues = [];
  let total = 0;
  let lineStarts = null;
  for (const hit of scan.hits) {
    const word = words[hit.patternIndex];
    total += 1;
    byWordMap.set(word, (byWordMap.get(word) || 0) + 1);
    if (issues.length >= options.maxIssues) continue;
    if (!lineStarts) lineStarts = lineStartsOf(source);
    const pos = positionOf(lineStarts, hit.index);
    issues.push({
      word,
      index: hit.index,
      length: word.length,
      line: pos.line,
      column: pos.column,
      snippet: findLib.makeSnippet(source, hit.index, word.length, SNIPPET_RADIUS)
    });
  }

  // 完整返回每个命中词的次数（最多 = 词表词数），由调用方决定摘要里显示前几个
  const byWord = Array.from(byWordMap, ([word, count]) => ({ word, count })).sort(
    (a, b) => b.count - a.count || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0)
  );

  return {
    total,
    issues,
    byWord,
    wordHitCount: byWordMap.size,
    wordCount: words.length,
    truncated: scan.truncated || total > issues.length,
    // X4（v1.8.0 WP-24）：chars = 正文字数（去空白），与校对 / 捕获队列 / 状态栏同一口径
    // （core/chapters.js 的 countChars）；需要「含空白的原文长度」看 rawLength。
    chars: chaptersLib.countChars(source),
    rawLength: source.length
  };
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_WORDS,
  RAW_MATCH_LIMIT,
  BY_WORD_LIMIT,
  BOOK_ISSUE_LIMIT,
  DEFAULT_OPTIONS,
  sanitizeOptions,
  sanitizeWords,
  parseWordList,
  decodeWordListBuffer,
  readWordListFile,
  publicWordListInfo,
  scanText
};
