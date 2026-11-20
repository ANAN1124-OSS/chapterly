// 纯文本小说解析：编码识别 + 章节切分。
// 给「导入小说」用：一个 txt 就是一本书时，按「第X章 / 第X幕 / 楔子 / 番外 / Chapter N」等标题行切章。
// 注意：标题识别只决定「在哪里切」，章节名一律保留原文标题行，不改写作者的字。
// stripBom / normalizeText 从 core/common.js 来（B6）：导入、捕获、查找、校对、朗读共用同一份
// 「去开头 BOM + CRLF/CR 归一成 \n」的实现。审计修复 #53（R5）：本文件不再手写这两步，
// splitChaptersRaw / splitLongUntitled 与 splitChapters 都直接走 normalizeText（第三种写法收掉）。
//
// A1 / V113（v1.8.0 WP-30）：标题词表统一在 core/heading.js 的 import 场景（最严格——
// 不认繁体「話」、不认全角数字；「Chapter N」算关键词标题）。审计残留 #50（E15）起 import 也认
// 「开篇」（旧版自动分章把首个标题前内容合成「开篇」，导出再按原文导入要能原样往返）；
// capture 锚点词表仍不含它，但 capture.looksLikeHeading 先走本文件的 parseHeading，最终同样认。
// 本文件只保留自己的切分逻辑与分隔符 / 长度严格度，别再往这里抄词表。
const { normalizeText } = require('./common');
const heading = require('./heading');
const CHAPTER_NUM_RE = new RegExp(
  `^\\s*第\\s*([${heading.numeralClass('import')}]${heading.numeralRun('import')})\\s*` +
    `([${heading.markerClass('import')}])([\\s\\S]*)$`
);
const CHAPTER_KEY_RE = new RegExp(`^\\s*(${heading.keywordSource('import')})([\\s\\S]*)$`, 'i');

// 标题行允许的长度上限（极长的一行更可能是正文，直接排除）
const MAX_HEADING_LENGTH = 300;
// 「第X章」后面没有分隔符、直接接文字时，只接受较短的行（避免把「第三节课结束时……」这种正文当成标题）
const MAX_NO_SEPARATOR_TITLE = 80;
// 「楔子 / 番外 / 前言」这类没有编号的关键词标题，无分隔符时行长度上限（如「后记和设定说明」）
const MAX_KEYWORD_HEADING = 40;

// 「第X章」后面的分隔符（不带逗号句号，避免把「第一章，他……」这种正文当标题）
// 审计修复 #1（E1）：字符类里原来还留着 `，,;；`，和这行注释自相矛盾 —— 正文行「第三章，夜色渐深」
// 因此 hasSeparator=true、绕过下面的长度守卫被直接当成标题，默认「按原文章节」导入会静默错划结构。
// 逗号 / 分号都不是标题分隔符：这里按注释意图删掉；逗号另有语境守卫（见 parseHeading），
// 分号只由「无分隔符短标题」的长度守卫兜底（「第四章;转生成铃兰小姐后…」这类真实短标题仍认）。
const NUM_SEPARATORS = /^[：:、.．\-—–”"'‘’】）》」』（(【《「『\s]/;
// 紧跟「第X章」的逗号是正文句读（「第三章，夜色渐深」），不是标题分隔符
const PROSE_AFTER_NUM_MARKER = /^[，,]/;
// 关键词标题（楔子/番外/后记…）后面的分隔符可以更宽，因为关键词本身已经很明确
const KEY_SEPARATORS = /^[：:、.．\-—–”"'‘’】）》」』（(【《「『，,;；。!！?？·…\s]/;
// 关键词标题后面没有分隔符时，只有这些开头才像标题；
// 「尾声的序章，便是…」「引子内容」这类是正文，不能当标题。
const KEYWORD_NO_SEPARATOR_OK =
  /^(?:[0-9０-９零〇一二三四五六七八九十百千万两]+[.、．]?|[和与及、·\-—–][\s\S]*)/;

const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf]);
const BOM_UTF16LE = Buffer.from([0xff, 0xfe]);
const BOM_UTF16BE = Buffer.from([0xfe, 0xff]);
// 审计修复 #50（E15）：UTF-32LE BOM（FF FE 00 00）的前两字节与 UTF-16LE 相同，旧实现先命中
// UTF-16LE 分支 → 解出带 NUL 的乱码，且 hasUtf16Bom 放行二进制闸门。必须先判 4 字节 BOM。
const BOM_UTF32LE = Buffer.from([0xff, 0xfe, 0x00, 0x00]);
// TC-5（五-L7）：UTF-32BE BOM（00 00 FE FF）在旧实现的四个 BOM 分支里一个都不命中 ——
// 严格 UTF-8 失败后按「含 0 字节」判成二进制，导入直接报 NOT_TEXT。E15 补了 UTF-32LE，
// 这里补上对称的大端缺口（00 00 开头与任何 UTF-16 BOM 都不冲突，但仍按 4 字节先判）。
const BOM_UTF32BE = Buffer.from([0x00, 0x00, 0xfe, 0xff]);
const UTF32_CHUNK = 8192;

// UTF-32 没有内置 TextDecoder（Node 只支持 UTF-8 / UTF-16 / GB18030），这里手写严格解码，
// 大端 / 小端共用一份：每 4 字节按端序读码点，拒绝代理区与超出 U+10FFFF 的坏值；
// 长度不是 4 的倍数也返回 null。按块拼接，避免逐字符 `out +=` 在长篇上退化成 O(n²)。
function decodeUtf32Strict(buffer, offset, littleEndian) {
  const bytes = buffer.length - offset;
  if (bytes < 0 || bytes % 4 !== 0) return null;
  let out = '';
  let chunk = '';
  for (let at = offset; at < buffer.length; at += 4) {
    const cp = littleEndian ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    chunk += String.fromCodePoint(cp);
    if (chunk.length >= UTF32_CHUNK) {
      out += chunk;
      chunk = '';
    }
  }
  return out + chunk;
}

function decodeUtf32Le(buffer, offset) {
  return decodeUtf32Strict(buffer, offset, true);
}

function decodeUtf32Be(buffer, offset) {
  return decodeUtf32Strict(buffer, offset, false);
}

// 严格解码：只认「能完整识别」的编码，识别不了返回 null（不产出 U+FFFD）。
// 词表读取用它区分「解码器替换出来的坏字符」与「原文里本来就有的 U+FFFD」。
//   UTF-8 BOM → UTF-32LE / UTF-32BE BOM（先于 UTF-16）→ UTF-16 BOM → 严格 UTF-8 → 严格 GB18030
// 审计修复 #54（P10）：判定结果同时带 encoding（utf-8 / utf-16le / utf-16be / utf-32le / utf-32be /
// gb18030 / empty）。导入 raw 模式要在「同一份解码结果」上判断源文件是不是 UTF-8（旧实现 decodeBuffer 解一遍、
// isUtf8 再整本 fatal 解一遍 —— 128 MB 文件双倍解码），有了 encoding 就不必再解第二次。
function decodeBufferStrictInfo(buffer) {
  if (!buffer || !buffer.length) return { text: '', encoding: 'empty' };
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(BOM_UTF8)) {
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(3)), encoding: 'utf-8' };
    } catch {
      return null;
    }
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(BOM_UTF32LE)) {
    const text = decodeUtf32Le(buffer, 4);
    return text === null ? null : { text, encoding: 'utf-32le' };
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(BOM_UTF32BE)) {
    const text = decodeUtf32Be(buffer, 4);
    return text === null ? null : { text, encoding: 'utf-32be' };
  }
  if (buffer.length >= 2 && buffer.subarray(0, 2).equals(BOM_UTF16LE)) {
    try {
      return { text: new TextDecoder('utf-16le', { fatal: true }).decode(buffer.subarray(2)), encoding: 'utf-16le' };
    } catch {
      return null;
    }
  }
  if (buffer.length >= 2 && buffer.subarray(0, 2).equals(BOM_UTF16BE)) {
    try {
      return { text: new TextDecoder('utf-16be', { fatal: true }).decode(buffer.subarray(2)), encoding: 'utf-16be' };
    } catch {
      return null;
    }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf-8' };
  } catch { /* 不是合法 UTF-8，继续试中文编码 */ }
  try {
    return { text: new TextDecoder('gb18030', { fatal: true }).decode(buffer), encoding: 'gb18030' };
  } catch { /* 识别不了 */ }
  return null;
}

function decodeBufferStrict(buffer) {
  const info = decodeBufferStrictInfo(buffer);
  return info ? info.text : null;
}

// 非 fatal 的 UTF-32 解码（大端 / 小端共用）：坏码点（代理区 / 超 U+10FFFF）与不足 4 字节的尾巴
// 都换成 U+FFFD，不返回 null。只给下面的 BOM 锁定宽容兜底用（严格版 decodeUtf32Le / Be 仍回 null，
// 词表读取靠它）。
function decodeUtf32Loose(buffer, offset, littleEndian) {
  let out = '';
  let chunk = '';
  let at = offset;
  for (; at + 4 <= buffer.length; at += 4) {
    const cp = littleEndian ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at);
    chunk += cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '\uFFFD' : String.fromCodePoint(cp);
    if (chunk.length >= UTF32_CHUNK) {
      out += chunk;
      chunk = '';
    }
  }
  if ((buffer.length - offset) % 4 !== 0) chunk += '\uFFFD'; // 缺字节
  return out + chunk;
}

function decodeUtf32LeLoose(buffer, offset) {
  return decodeUtf32Loose(buffer, offset, true);
}

function decodeUtf32BeLoose(buffer, offset) {
  return decodeUtf32Loose(buffer, offset, false);
}

// 审计残留修复 #50（E15，中危回归）：BOM 锁定编码（宽容版）。
// 严格解码在「BOM 已识别但载荷坏了」时回 null（如 UTF-8 BOM 里混一个坏字节），旧兜底会把这
// 整包（连 BOM 字节一起）按非 fatal GB18030 重解 —— 整本书变乱码 + 开头一串乱码前缀。
// BOM 一旦认出来编码就已经定了：这里按 BOM 对应编码非 fatal 解（剥掉 BOM），坏字节只变 U+FFFD。
// 返回 null = 没有 BOM（交给 GB18030 兜底）；严格判定仍只认 decodeBufferStrictInfo。
function decodeBufferWithBomLocked(buffer) {
  if (!buffer || !buffer.length) return null;
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(BOM_UTF8)) {
    return { text: new TextDecoder('utf-8').decode(buffer.subarray(3)), encoding: 'utf-8' };
  }
  // UTF-32LE BOM 的前两字节与 UTF-16LE 相同：必须先判 4 字节（与严格判定同一顺序）
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(BOM_UTF32LE)) {
    return { text: decodeUtf32LeLoose(buffer, 4), encoding: 'utf-32le' };
  }
  // TC-5（五-L7）：UTF-32BE 与 LE 对称 —— 00 00 FE FF 一旦命中，载荷坏了也只按 UTF-32BE 宽容解
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(BOM_UTF32BE)) {
    return { text: decodeUtf32BeLoose(buffer, 4), encoding: 'utf-32be' };
  }
  if (buffer.length >= 2 && buffer.subarray(0, 2).equals(BOM_UTF16LE)) {
    return { text: new TextDecoder('utf-16le').decode(buffer.subarray(2)), encoding: 'utf-16le' };
  }
  if (buffer.length >= 2 && buffer.subarray(0, 2).equals(BOM_UTF16BE)) {
    return { text: new TextDecoder('utf-16be').decode(buffer.subarray(2)), encoding: 'utf-16be' };
  }
  return null;
}

// ---------- WP7（X-N1）：无 BOM 路径的宽容解码与 UTF-16 启发式 ----------
// 审计 #21 的缺陷：没有 BOM 且严格 UTF-8 失败时旧实现直接落 GB18030（严格或非 fatal 兜底），
// 网络抓取来的 UTF-8 小说只要混 1 个坏字节，整本就被解成「绗笁绔」式乱码；同一内容带 BOM 时
// 走 BOM 锁定宽容解却只有 1 个 U+FFFD —— 差一个 BOM，结果从「个别替换符」劣化成「整本乱码」。
// 这里补三步（严格入口 decodeBufferStrictInfo 一个字节不改，词表读取仍如实判坏编码）：
//   · 无 BOM UTF-16LE/BE 启发式（先于严格解码：带 NUL 的 UTF-16 也能被严格 UTF-8「成功」解出）；
//   · 严格 UTF-8 失败后先评估「坏字节极少」→ 宽容 UTF-8（坏字节 → U+FFFD），与 BOM 路径对称；
//   · 只有明显非 UTF-8 才落严格 GB18030 / 非 fatal GB18030 兜底，并如实报告替换符数量。
const TOLERANT_UTF8_MIN_REPLACEMENTS = 2;
const TOLERANT_UTF8_BYTES_PER_REPLACEMENT = 1000;
const TOLERANT_UTF8_MIN_VALID_CHARS = 8;
const TOLERANT_UTF8_CHUNK = 1024 * 1024;
// 五-H6（TC-1）反向校验阈值（作者授权本轮定口径；实测数据见 tests/txt-encoding-tolerance.test.js）：
//   · 近似有效 UTF-8（坏字符 ≤ 30%）：UTF-8 只是局部损坏、大部分正文还能读出来，优先按 UTF-8 宽容解
//     （30% 已很宽松；真 GBK 被当 UTF-8 读时坏字符占 66–80%，不可能落进这个区间，且下面还有常用字闸门）；
//   · 常用字闸门：解码结果里 ≥ 85% 的汉字是 GB2312 一级常用字才算「像正常中文」——
//     实测真 GBK 小说 ≈ 0.99，UTF-8 中文字节流被当 GB18030 解出的乱码只有 0–17%；
//   · 可疑提示区间：坏字符占比在 (0, 40%] 且 GB18030 解出来不像正常中文 → encodingSuspect；
//     真 GBK（≈ 0.78）与明显非 UTF-8 的内容都不再误报。
const NEAR_VALID_UTF8_MAX_BAD_RATIO = 0.3;
const COMMON_HAN_MIN_RATIO = 0.85;
const ENCODING_SUSPECT_MAX_BAD_RATIO = 0.4;
const COMMON_HAN_SAMPLE_CHARS = 200000;
// 无 BOM UTF-16：采样前 64 KB、要求 ≥ 98% 的 16 位码元落在「正文常用码位」。
// 阈值取 0.98 而不是 0.9 —— 纯 ASCII 文本按 LE 读出的码元（如 'eH' = 0x6548）会落进 CJK 区，
// 但只占约五成；GBK 双字节按 LE 读出几乎全在 0xA1xx 以上（Hangul / Yi，不计入）。纯中文
// UTF-16 的码元则几乎 100% 是 CJK / 换行 / ASCII，能稳稳过线。
const UTF16_SAMPLE_CODE_UNITS = 32 * 1024;
const UTF16_TEXT_RATIO = 0.98;
const UTF16_MIN_CODE_UNITS = 4;

// 统计一段文本里的 U+FFFD 数量。只给「非严格路径」用：严格路径解出来的 U+FFFD 是原文已有的字，
// 不算替换（所以严格路径的返回对象不带 replacements 字段）。
function countReplacements(text) {
  let count = 0;
  for (const ch of String(text || '')) {
    if (ch === '\uFFFD') count += 1;
  }
  return count;
}

// 分块非 fatal 解码，只统计「替换符数量 + 可读字符数量」，不保留整段文本 ——
// 128 MB 上限文件也不会为了预估坏字节多占一份整本字符串内存（判断完再整本解一遍拿正文）。
function countUtf8Replacements(buffer) {
  const decoder = new TextDecoder('utf-8');
  let replacements = 0;
  let valid = 0;
  const count = (piece) => {
    for (const ch of piece) {
      if (ch === '\uFFFD') replacements += 1;
      else valid += 1;
    }
  };
  for (let at = 0; at < buffer.length; at += TOLERANT_UTF8_CHUNK) {
    const end = Math.min(at + TOLERANT_UTF8_CHUNK, buffer.length);
    count(decoder.decode(buffer.subarray(at, end), { stream: true }));
  }
  count(decoder.decode());
  return { replacements, valid };
}

// 「像正文的 16 位码元」：ASCII 可打印 / 换行、CJK 统一表意（含扩展 A）、CJK 标点、全角字符。
// 不含 Hangul / Yi / 拉丁扩展等 —— 那些正是 GBK / 随机字节被按 16 位读出来的落点。
function isLikelyTextCodeUnit(cp) {
  return (
    cp === 0x09 ||
    cp === 0x0a ||
    cp === 0x0d ||
    (cp >= 0x20 && cp <= 0x7e) ||
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xff00 && cp <= 0xffef)
  );
}

function utf16TextScore(buffer, littleEndian) {
  const evenBytes = buffer.length - (buffer.length % 2);
  const units = Math.min(evenBytes / 2, UTF16_SAMPLE_CODE_UNITS);
  if (units < UTF16_MIN_CODE_UNITS) return 0;
  let good = 0;
  for (let index = 0; index < units; index += 1) {
    const at = index * 2;
    const cp = littleEndian ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at);
    if (isLikelyTextCodeUnit(cp)) good += 1;
  }
  return good / units;
}

// 无 BOM UTF-16 判定（纯逻辑）：返回 'utf-16le' / 'utf-16be' / null。带 BOM 的返回 null
// （走 BOM 分支，口径不变）。只用在「严格 UTF-8 失败」或「缓冲里有 NUL」的入口（见下）。
function detectBomlessUtf16(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < UTF16_MIN_CODE_UNITS * 2) return null;
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(BOM_UTF32LE)) return null;
  // TC-5（五-L7）：UTF-32BE 的正文按 16 位 BE 读也只有一半落在 CJK 区（高分字节是 0x0000），
  // 本来过不了 0.98 的阈值；这里显式按 BOM 排除，避免将来阈值调整时把它抢成 UTF-16BE。
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(BOM_UTF32BE)) return null;
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(BOM_UTF8)) return null;
  if (buffer.length >= 2 && (buffer.subarray(0, 2).equals(BOM_UTF16LE) || buffer.subarray(0, 2).equals(BOM_UTF16BE))) {
    return null;
  }
  const le = utf16TextScore(buffer, true);
  const be = utf16TextScore(buffer, false);
  if (le >= UTF16_TEXT_RATIO && le >= be) return 'utf-16le';
  if (be >= UTF16_TEXT_RATIO) return 'utf-16be';
  return null;
}

function hasAnyBom(buffer) {
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(BOM_UTF8)) return true;
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(BOM_UTF32LE)) return true;
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(BOM_UTF32BE)) return true;
  if (buffer.length >= 2 && (buffer.subarray(0, 2).equals(BOM_UTF16LE) || buffer.subarray(0, 2).equals(BOM_UTF16BE))) {
    return true;
  }
  return false;
}

// 宽容 UTF-8 是否可行：坏字节「极少」（预算 = max(2, 每 1000 字节 1 个)）且至少有 8 个可读字符
// —— 1–2 个字节的碎片（如单个 0xFF）不算「以 UTF-8 为主」，仍走 GB18030 兜底的老口径。
// 五-H6：统计结果可由调用方传入（判定链只统计一次，不做第二遍整本解码）。
function canDecodeAsTolerantUtf8(buffer, stats) {
  const { replacements, valid } = stats || countUtf8Replacements(buffer);
  if (valid < TOLERANT_UTF8_MIN_VALID_CHARS) return false;
  const budget = Math.max(
    TOLERANT_UTF8_MIN_REPLACEMENTS,
    Math.floor(buffer.length / TOLERANT_UTF8_BYTES_PER_REPLACEMENT)
  );
  return replacements <= budget;
}

// 五-H6（TC-1）：反向校验 —— 「这段解码结果像不像正常中文」。
// GB2312 一级常用字（B0A1–D7F9，3755 字）在首次调用时用同一个 GB18030 解码器建一次集合。
// 真 GBK 小说解出来基本全落在这个集合里；UTF-8 中文字节流被当 GB18030 解出的乱码则是
// 「澶╁湴鐜勯粍」这类生僻字 / 符号，常用字占比极低 —— 两者差一个数量级，阈值 0.85 很宽。
let commonHanSetCache = null;
function commonHanSet() {
  if (commonHanSetCache) return commonHanSetCache;
  const set = new Set();
  const decoder = new TextDecoder('gb18030');
  for (let hi = 0xb0; hi <= 0xd7; hi += 1) {
    for (let lo = 0xa1; lo <= 0xfe; lo += 1) {
      let ch = '';
      try {
        ch = decoder.decode(Buffer.from([hi, lo]));
      } catch {
        ch = '';
      }
      if (ch && ch !== '\uFFFD') set.add(ch);
    }
  }
  commonHanSetCache = set;
  return set;
}

function isHanCharacter(ch) {
  const cp = ch.codePointAt(0);
  return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf);
}

// 采样前 20 万字（乱码 / 正常文本的分布是均匀的，不必为 128 MB 文件整本走一遍）。
function commonHanRatio(text) {
  const source = String(text || '');
  const sample = source.length > COMMON_HAN_SAMPLE_CHARS ? source.slice(0, COMMON_HAN_SAMPLE_CHARS) : source;
  let han = 0;
  let common = 0;
  const set = commonHanSet();
  for (const ch of sample) {
    if (!isHanCharacter(ch)) continue;
    han += 1;
    if (set.has(ch)) common += 1;
  }
  return han ? common / han : 0;
}

// 把任意编码的文本文件解码成字符串。审计 #21（X-N1）后的判定链：
//   带 BOM：严格判定 → BOM 锁定宽容（口径不变，补 replacements）→ 兜底；
//   无 BOM：无 BOM UTF-16 启发式 → 严格 UTF-8 → 宽容 UTF-8（坏字节极少）→
//           近似有效 UTF-8（坏字节 ≤ 30% 且反向校验判为 UTF-8，五-H6）→ 严格 GB18030 → 非 fatal GB18030 兜底。
// 返回 { text, encoding }，非严格路径额外带 replacements（解出来的 U+FFFD 计数；严格路径不出现该字段）；
// 五-H6 起，严格 GB18030 命中但「坏字符占比 / 常用字占比」判定不可靠时额外带 encodingSuspect（提示核对）。
// 审计修复 #50（E15）：删掉不可达的 latin1 兜底（GB18030 非 fatal 几乎不抛）。
// 审计修复 #54（P10）：带编码信息的同一份解码入口（见 decodeBufferStrictInfo 的注释）。
// 审计残留修复 #50（E15）：BOM 锁定 —— 带 BOM 的文件绝不落到 GB18030 兜底（见 decodeBufferWithBomLocked）。
function decodeBufferWithEncoding(buffer) {
  if (!buffer || !buffer.length) return { text: '', encoding: 'empty' };
  if (hasAnyBom(buffer)) {
    const info = decodeBufferStrictInfo(buffer);
    if (info) return info;
    const bomLocked = decodeBufferWithBomLocked(buffer);
    if (bomLocked) return { ...bomLocked, replacements: countReplacements(bomLocked.text) };
  } else {
    // 顺序很关键：
    //   · 有 NUL 的缓冲先过 UTF-16 启发式 —— 带 NUL 的无 BOM UTF-16（正文里有换行 / ASCII）会被
    //     严格 UTF-8「成功」解成一串 NUL，不能先信严格 UTF-8；
    //   · 没有 NUL 的缓冲先信严格 UTF-8 —— 合法 UTF-8 永远优先，绝不被启发式抢走（纯 ASCII 按
    //     16 位读也有约五成码元落进 CJK 区，先严格解码就完全没有这个误判面）；
    //     严格 UTF-8 失败后才试无 BOM UTF-16（纯中文 UTF-16 双字节均非 0，会被严格 GB18030 静默误解）。
    const hasNul = buffer.includes(0);
    let utf16 = hasNul ? detectBomlessUtf16(buffer) : null;
    if (!utf16) {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        return { text, encoding: 'utf-8' };
      } catch { /* 不是合法 UTF-8，继续试无 BOM UTF-16 / 宽容 UTF-8 */ }
      utf16 = detectBomlessUtf16(buffer);
    }
    if (utf16) {
      const text = new TextDecoder(utf16).decode(buffer);
      return { text, encoding: utf16, replacements: countReplacements(text) };
    }
    const utf8Stats = countUtf8Replacements(buffer);
    if (canDecodeAsTolerantUtf8(buffer, utf8Stats)) {
      const text = new TextDecoder('utf-8').decode(buffer);
      return { text, encoding: 'utf-8', replacements: countReplacements(text) };
    }
    // 五-H6（TC-1）反向校验：UTF-8 严格失败后不能直接信「严格 GB18030 成功」——
    // UTF-8 中文字节流几乎总是合法 GB18030（E4–E9 首字节 ∈ 81–FE），整本可能被解成「绗笁绔」式乱码。
    // 先量坏字符占比；坏字符 ≤ 30% 时再用「常用字占比」把两份候选解互相比对：
    // UTF-8 解出来像正常中文、GB18030 解出来像乱码 → 判为局部损坏的 UTF-8。
    const badRatio = utf8Stats.replacements / Math.max(1, utf8Stats.replacements + utf8Stats.valid);
    const utf8Recoverable =
      utf8Stats.replacements > 0 &&
      utf8Stats.valid >= TOLERANT_UTF8_MIN_VALID_CHARS &&
      badRatio <= NEAR_VALID_UTF8_MAX_BAD_RATIO;
    let gbText = null;
    try {
      gbText = new TextDecoder('gb18030', { fatal: true }).decode(buffer);
    } catch { gbText = null; }
    if (utf8Recoverable) {
      const utf8Text = new TextDecoder('utf-8').decode(buffer);
      if (
        gbText == null ||
        (commonHanRatio(utf8Text) >= COMMON_HAN_MIN_RATIO && commonHanRatio(gbText) < COMMON_HAN_MIN_RATIO)
      ) {
        return { text: utf8Text, encoding: 'utf-8', replacements: countReplacements(utf8Text) };
      }
    }
    if (gbText != null) {
      // 剩下的严格 GB18030 成功要么是真 GBK（坏字符 ≈ 78%、常用字 ≈ 0.99），要么落在「说不清」的
      // 中间区：只有中间区（坏字符 ≤ 40% 且解出来不像正常中文）才带 encodingSuspect 提示核对。
      if (
        utf8Stats.replacements > 0 &&
        badRatio <= ENCODING_SUSPECT_MAX_BAD_RATIO &&
        commonHanRatio(gbText) < COMMON_HAN_MIN_RATIO
      ) {
        return { text: gbText, encoding: 'gb18030', encodingSuspect: true };
      }
      return { text: gbText, encoding: 'gb18030' };
    }
  }
  const text = new TextDecoder('gb18030').decode(buffer);
  return { text, encoding: 'gb18030', replacements: countReplacements(text) };
}

function decodeBuffer(buffer) {
  return decodeBufferWithEncoding(buffer).text;
}


function trimLeadingPunctuation(text) {
  return String(text || '')
    .replace(/^[：:、.．\-—–”"'‘’】）》」』（(【《「『，,;；。!！?？·…\s]+/, '')
    .trim();
}

// 判断一行是不是章节标题；返回 { kind, name } 或 null
function parseHeading(line) {
  const raw = String(line == null ? '' : line);
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_HEADING_LENGTH) return null;

  const numMatch = CHAPTER_NUM_RE.exec(trimmed);
  if (numMatch) {
    const restRaw = numMatch[3] || '';
    const marker = numMatch[2];
    // 审计修复 #1（E1）：「第三章，夜色渐深」这类正文句式一律按正文处理。
    // 光把逗号从 NUM_SEPARATORS 删掉还不够 —— 短行会落到下面的「无分隔符短标题」分支；
    // 这里在两种分支之前先挡掉，长句和短句都不会再被误切。
    if (PROSE_AFTER_NUM_MARKER.test(restRaw)) return null;
    const hasSeparator = restRaw === '' || NUM_SEPARATORS.test(restRaw);
    if (!hasSeparator) {
      // 「第三节课…」「第二节课后…」是正文常用说法，不是章节标题
      if (marker === '节' && restRaw.startsWith('课')) return null;
      // 审计修复 #50（E15）：部 / 集 / 篇 后面没有分隔符又直接接字时，几乎都是正文
      //（「第一部电影…」「第三集播出后…」「第一篇论文…」）；真标题请用空格 / 冒号分隔，
      // 或把标题写成「第一部」后直接换行（restRaw 为空仍走上面的 hasSeparator 分支）。
      // 审计残留 #50（E15）：取「宁可少切、不误切正文」的取舍 —— 代价是「第一部风起」这类
      // 无分隔符短标题会被并进上一章正文；放宽守卫无法区分它与「第一部电影……」，不细化。
      if (marker === '部' || marker === '集' || marker === '篇') return null;
      // 没有分隔符又很长：基本是正文句子
      if (trimmed.length > MAX_NO_SEPARATOR_TITLE) return null;
    }
    return { kind: 'num', raw: trimmed, name: trimLeadingPunctuation(restRaw) };
  }

  const keyMatch = CHAPTER_KEY_RE.exec(trimmed);
  if (keyMatch) {
    const keyword = String(keyMatch[1] || '').trim();
    const restRaw = keyMatch[2] || '';
    const hasSeparator = restRaw === '' || KEY_SEPARATORS.test(restRaw);
    if (!hasSeparator) {
      // 没有分隔符时只接受「后记和设定说明」这类短标题，拒绝「尾声的序章，便是…」这类正文
      if (!KEYWORD_NO_SEPARATOR_OK.test(restRaw)) return null;
      if (trimmed.length > MAX_KEYWORD_HEADING) return null;
    }
    const rest = trimLeadingPunctuation(restRaw);
    return { kind: 'key', raw: trimmed, name: rest ? `${keyword} ${rest}` : keyword };
  }
  return null;
}

function isChapterHeading(line) {
  return Boolean(parseHeading(line));
}

// 把整本书文本切成 [{ title, text }]（旧版自动分章用）
function splitChapters(text) {
  const normalized = normalizeText(text);
  const lines = normalized.split('\n');
  const marks = [];
  lines.forEach((line, index) => {
    const parsed = parseHeading(line);
    if (parsed) marks.push({ index, name: parsed.name });
  });

  if (!marks.length) {
    const body = normalized.trim();
    return body ? [{ title: '全文', text: body }] : [];
  }

  const parts = [];
  if (marks[0].index > 0) {
    const preface = lines.slice(0, marks[0].index).join('\n').trim();
    if (preface) parts.push({ title: '开篇', text: preface });
  }
  for (let i = 0; i < marks.length; i += 1) {
    const start = marks[i].index + 1;
    const end = i + 1 < marks.length ? marks[i + 1].index : lines.length;
    parts.push({ title: marks[i].name, text: lines.slice(start, end).join('\n').trim() });
  }
  return parts;
}

// 把整本书文本按原文标题行切成 [{ title, body }]：
// title = 原文标题行（去掉首尾空白），body = 该标题之后到下一标题之前的原文（不做 trim，保留空行）。
// 用于「按原文章节导入」：章名和正文都保持原样。
// 第一个标题之前的书名/作者/简介等，会并入第一章正文，避免多出一个原文没有的「开篇」章。
// 并入口径 = 原文去掉标题行（标题行连同它自己的换行一起去掉，其余字符一个不动；含纯空白前言，
// 见 TC-8 / 五-L8）。
function splitChaptersRaw(text) {
  const normalized = normalizeText(text);
  const lines = normalized.split('\n');
  const marks = [];
  lines.forEach((line, index) => {
    const parsed = parseHeading(line);
    if (parsed) marks.push({ index, title: line.trim() });
  });

  if (!marks.length) return [{ title: '', body: normalized }];

  const parts = [];
  const preface = marks[0].index > 0 ? lines.slice(0, marks[0].index).join('\n') : '';
  for (let i = 0; i < marks.length; i += 1) {
    const start = marks[i].index + 1;
    const end = i + 1 < marks.length ? marks[i + 1].index : lines.length;
    let body = lines.slice(start, end).join('\n');
    // TC-8（五-L8）：判据是「标题前有没有行」，不是「前言 trim 后是否为空」——
    // 纯空白前言（文件开头留白 / 单个空行，甚至前言 join 出来就是空串）同样是原文的一部分，
    // 旧实现按 preface.trim() 判假整段丢弃，与 chapters 模式「正文一字不改」的承诺不符。
    if (i === 0 && marks[0].index > 0) body = `${preface}\n${body}`;
    parts.push({ title: marks[i].title, body });
  }
  return parts;
}

// ---------- b10（剪贴板联动方案 §5 b10）：导入「无标题长文」的兜底切片 ----------
// 只在导入链路生效：正文里没有识别到任何章节标题、且整篇超过阈值（默认 6 万字）时，
// 按目标长度（默认 5 万字）在最近的「段落空行」处断开；找不到合适的空行就在目标长度处硬切
// （不切开代理对）。章名「第 1 部分 / 第 2 部分 …」。
// 正文一个字符都不改：不 trim、不改写，按顺序拼回去与原文逐字相同。
const LONG_UNTITLED_THRESHOLD = 60000;
const LONG_UNTITLED_CHUNK = 50000;
// 断点不能离目标长度太远（至少 60%），否则长段落文本会被切成很多小段
const LONG_UNTITLED_MIN_RATIO = 0.6;

function splitLongUntitled(text, options = {}) {
  const normalized = normalizeText(text);
  const rawChunk = Number(options.chunkChars);
  const chunkChars = Number.isFinite(rawChunk) && rawChunk > 0 ? Math.max(1000, Math.round(rawChunk)) : LONG_UNTITLED_CHUNK;
  const rawThreshold = Number(options.threshold);
  const threshold = Number.isFinite(rawThreshold) && rawThreshold > 0
    ? Math.max(1, Math.round(rawThreshold))
    : LONG_UNTITLED_THRESHOLD;
  if (normalized.length <= threshold) return [{ title: '', body: normalized }];

  const parts = [];
  // P-06（1.6.0 A5）：按绝对下标推进，不再每切一片就复制剩余全文（旧实现 rest = rest.slice(cut)
  // 让整篇的字符拷贝量变成 O(n²/chunk)）。切片只用于产出每一片的正文，总拷贝量 ≈ 原文长度。
  // 五-M26（TC-9）：断点搜索同样不能逐片回扫 —— 旧实现每片都从 pos+chunkChars 往回
  // lastIndexOf('\n\n')，全文没有空行时等于每片都扫回字符串开头，总扫描量 O(n²/chunk)
  // （128 MB 合法输入能把主进程同步卡死数秒）。现在改成一次前向 indexOf「顺序取下一个空行」
  // 并记住它：每个字符最多被扫一遍，窗口里最后一个空行由游标直接给出。重叠的 '\n\n'
  // 也逐个收（用 +1 前进），落点与旧 lastIndexOf 完全一致。
  const total = normalized.length;
  let pos = 0;
  let index = 1;
  let nextBlank = normalized.indexOf('\n\n');
  while (pos < total) {
    const remaining = total - pos;
    if (remaining <= chunkChars) {
      parts.push({ title: `第 ${index} 部分`, body: normalized.slice(pos) });
      break;
    }
    // 最近的段落空行（「空行」= 两个连续换行）；找不到 / 太靠前就按目标长度硬切。
    // 断在空行之后（前一段带上这个空行），下一段从正文开头开始，读起来干净。
    const limit = pos + chunkChars;
    let lastBlank = -1;
    while (nextBlank !== -1 && nextBlank <= limit) {
      lastBlank = nextBlank;
      nextBlank = normalized.indexOf('\n\n', nextBlank + 1);
    }
    // 命中的空行落在本片窗口 [pos, limit] 之外（只有窗口里没有空行时才会拿到上一片的位置）
    // 就当没找到。
    let cut = lastBlank >= pos ? lastBlank - pos : -1;
    if (cut >= 0 && cut + 2 <= remaining && cut + 2 >= chunkChars * LONG_UNTITLED_MIN_RATIO) {
      cut += 2;
    } else {
      cut = chunkChars;
    }
    // 不把 UTF-16 代理对切开（emoji / 生僻字扩展区）
    if (cut > 0 && cut < remaining) {
      const code = normalized.charCodeAt(pos + cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    }
    if (cut <= 0) cut = Math.min(remaining, chunkChars); // 极端兜底，保证一定前进
    parts.push({ title: `第 ${index} 部分`, body: normalized.slice(pos, pos + cut) });
    pos += cut;
    index += 1;
  }
  return parts;
}

module.exports = {
  decodeBuffer,
  decodeBufferWithEncoding,
  // 审计残留修复 #R10（#49/E24）：词表读取只解码一次 —— 它要的是「严格解出来的文本」，
  // 导出带 encoding 的那一份结果，调用方就不必再整包重解一遍。
  decodeBufferStrictInfo,
  decodeBufferStrict,
  // WP7（X-N1）：无 BOM UTF-16 启发式（导入的二进制闸门先问它，再决定要不要放过含 0 字节的缓冲）
  detectBomlessUtf16,
  parseHeading,
  isChapterHeading,
  splitChapters,
  splitChaptersRaw,
  LONG_UNTITLED_THRESHOLD,
  LONG_UNTITLED_CHUNK,
  splitLongUntitled
};
