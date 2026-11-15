// 纯文本小说解析：编码识别 + 章节切分。
// 给「导入小说」用：一个 txt 就是一本书时，按「第X章 / 第X幕 / 楔子 / 番外 / Chapter N」等标题行切章。
// 注意：标题识别只决定「在哪里切」，章节名一律保留原文标题行，不改写作者的字。
// stripBom / normalizeText 从 core/common.js 来（B6）：导入、捕获、查找、校对、朗读共用同一份
// 「去开头 BOM + CRLF/CR 归一成 \n」的实现。审计修复 #53（R5）：本文件不再手写这两步，
// splitChaptersRaw / splitLongUntitled 与 splitChapters 都直接走 normalizeText（第三种写法收掉）。
//
// A1 / V113（v1.8.0 WP-30）：标题词表统一在 core/heading.js 的 import 场景（最严格——
// 不认繁体「話」、不认全角数字、不认「开篇」关键词；「Chapter N」算关键词标题）。
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
const UTF32_CHUNK = 8192;

// UTF-32LE 没有内置 TextDecoder（Node 只支持 UTF-8 / UTF-16 / GB18030），这里手写一份：
// 每 4 字节按小端读码点，拒绝代理区与超出 U+10FFFF 的坏值；长度不是 4 的倍数也返回 null。
// 按块拼接，避免逐字符 `out +=` 在长篇上退化成 O(n²)。
function decodeUtf32Le(buffer, offset) {
  const bytes = buffer.length - offset;
  if (bytes < 0 || bytes % 4 !== 0) return null;
  let out = '';
  let chunk = '';
  for (let at = offset; at < buffer.length; at += 4) {
    const cp = buffer.readUInt32LE(at);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    chunk += String.fromCodePoint(cp);
    if (chunk.length >= UTF32_CHUNK) {
      out += chunk;
      chunk = '';
    }
  }
  return out + chunk;
}

// 严格解码：只认「能完整识别」的编码，识别不了返回 null（不产出 U+FFFD）。
// 词表读取用它区分「解码器替换出来的坏字符」与「原文里本来就有的 U+FFFD」。
//   UTF-8 BOM → UTF-32LE BOM（先于 UTF-16LE）→ UTF-16 BOM → 严格 UTF-8 → 严格 GB18030
// 审计修复 #54（P10）：判定结果同时带 encoding（utf-8 / utf-16le / utf-16be / utf-32le / gb18030 /
// empty）。导入 raw 模式要在「同一份解码结果」上判断源文件是不是 UTF-8（旧实现 decodeBuffer 解一遍、
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

// 非 fatal 的 UTF-32LE 解码：坏码点（代理区 / 超 U+10FFFF）与不足 4 字节的尾巴都换成 U+FFFD，
// 不返回 null。只给下面的 BOM 锁定宽容兜底用（严格版 decodeUtf32Le 仍回 null，词表读取靠它）。
function decodeUtf32LeLoose(buffer, offset) {
  let out = '';
  let chunk = '';
  let at = offset;
  for (; at + 4 <= buffer.length; at += 4) {
    const cp = buffer.readUInt32LE(at);
    chunk += cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '\uFFFD' : String.fromCodePoint(cp);
    if (chunk.length >= UTF32_CHUNK) {
      out += chunk;
      chunk = '';
    }
  }
  if ((buffer.length - offset) % 4 !== 0) chunk += '\uFFFD'; // 缺字节
  return out + chunk;
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
  if (buffer.length >= 2 && buffer.subarray(0, 2).equals(BOM_UTF16LE)) {
    return { text: new TextDecoder('utf-16le').decode(buffer.subarray(2)), encoding: 'utf-16le' };
  }
  if (buffer.length >= 2 && buffer.subarray(0, 2).equals(BOM_UTF16BE)) {
    return { text: new TextDecoder('utf-16be').decode(buffer.subarray(2)), encoding: 'utf-16be' };
  }
  return null;
}

// 把任意编码的文本文件解码成字符串：UTF-8（含 BOM）→ UTF-32LE BOM → UTF-16 BOM →
// 严格 UTF-8 → 严格 GB18030 → BOM 锁定宽容解（只有带 BOM 的文件）→ 非 fatal GB18030 总兜底。
// 审计修复 #50（E15）：旧实现的最后一行是 latin1 兜底，但前面的 GB18030 用了非 fatal 解码器
// （几乎不抛），那一行永远走不到 —— 是死代码。这里删掉死分支：能完整识别就按严格结果返回，
// 识别不了就用 GB18030 非 fatal 把坏字节替成 U+FFFD（导入老文件不中断），词表读取侧再据
// decodeBufferStrict 做严格判断（见 core/wordlist.js）。
// 审计修复 #54（P10）：带编码信息的同一份解码入口（见 decodeBufferStrictInfo 的注释）。
// 审计残留修复 #50（E15）：BOM 锁定 —— 带 BOM 的文件绝不落到 GB18030 兜底（见 decodeBufferWithBomLocked）。
function decodeBufferWithEncoding(buffer) {
  const info = decodeBufferStrictInfo(buffer);
  if (info) return info;
  const bomLocked = decodeBufferWithBomLocked(buffer);
  if (bomLocked) return bomLocked;
  return { text: new TextDecoder('gb18030').decode(buffer), encoding: 'gb18030' };
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
    if (i === 0 && preface.trim()) body = `${preface}\n${body}`;
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
  const total = normalized.length;
  let pos = 0;
  let index = 1;
  while (pos < total) {
    const remaining = total - pos;
    if (remaining <= chunkChars) {
      parts.push({ title: `第 ${index} 部分`, body: normalized.slice(pos) });
      break;
    }
    // 最近的段落空行（「空行」= 两个连续换行）；找不到 / 太靠前就按目标长度硬切。
    // 断在空行之后（前一段带上这个空行），下一段从正文开头开始，读起来干净。
    // lastIndexOf 的 fromIndex 是绝对下标；命中的空行落在本片窗口 [pos, pos+chunkChars] 之外
    // （只有窗口里没有空行时才会往回找到上一片）就当没找到。
    let cut = normalized.lastIndexOf('\n\n', pos + chunkChars);
    cut = cut < pos ? -1 : cut - pos;
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
  parseHeading,
  isChapterHeading,
  splitChapters,
  splitChaptersRaw,
  LONG_UNTITLED_THRESHOLD,
  LONG_UNTITLED_CHUNK,
  splitLongUntitled
};
