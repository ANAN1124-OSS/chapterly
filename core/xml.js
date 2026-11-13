// XML / XHTML 导出共用的纯函数：剔除 XML 1.0 非法控制字符、转义五个特殊字符、
// 正文切段、导出用的修改时间戳。
//
// DOCX（WordprocessingML）和 EPUB（XHTML / OPF / NCX）各自拼自己的标签，但「哪些字符不能进
// XML」「& < > " ' 怎么转义」「正文怎么切段」必须只有一份实现 —— 以前两个导出文件各抄一份，
// 哪天只修好其中一种，另一种导出的整本书就会在 Word / 阅读器里打不开（控制字符）或丢标点（漏转义）。
//
// 纯函数：不 require 任何模块，不碰 fs / process / electron（单测有静态闸门）。
// 导出：stripInvalidXmlChars / escapeXml / paragraphsFromText / isoTimestamp。

// XML 1.0 不允许的控制字符与非字符（保留 \t \n \r）：正文里混进去会让整份文档解析失败。
// XML 1.0 的 Char 上限是 U+FFFD，U+FFFE / U+FFFF 是非字符，保留会让严格解析器整份拒绝。
const XML_INVALID_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;

function stripInvalidXmlChars(text) {
  return String(text == null ? '' : text).replace(XML_INVALID_CHARS, '');
}

function escapeXml(text) {
  return stripInvalidXmlChars(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// 正文 → 段落数组：CRLF / CR 一律归一成 \n，空行丢掉（段间留白交给 Word 样式 / EPUB CSS），
// 每段去掉首尾空白和 XML 非法控制字符。只动空白，不改字词标点。
function paragraphsFromText(text) {
  const normalized = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const out = [];
  for (const line of normalized.split('\n')) {
    const clean = stripInvalidXmlChars(line).trim();
    if (clean) out.push(clean);
  }
  return out;
}

// 导出文档里的修改时间：Date 原样用；null / undefined 取现在；字符串等交给 Date 解析；
// 解析不出来（NaN）也退回现在 —— 宁可写「刚刚导出」，也不让整次导出因为一个坏时间戳失败。
// iso 去掉毫秒（docx 的 W3CDTF / EPUB 的 dcterms:modified 都不需要 .123Z）。
function isoTimestamp(value) {
  const date = value instanceof Date ? value : value == null ? new Date() : new Date(value);
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  return { date: safe, iso: safe.toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

module.exports = {
  stripInvalidXmlChars,
  escapeXml,
  paragraphsFromText,
  isoTimestamp
};
