/* 章节 / 书目体量上限的唯一事实来源（三审 M2 / P1 / E1 / I5 / I8）。
 *
 * 为什么要有这一层：同一个「一章 / 一本书能有多大」以前在四个地方各写一份 ——
 * `core/common.js` 的 MAX_TEXT_BYTES（128 MB）、`core/ipc-limits.js` 的 MAX_TEXT_CHARS（500 万字）、
 * `core/storage.js` 的 MAX_CHAPTER_READ_BYTES 与 MAX_META_CHAPTERS（20000）、
 * `core/crash-draft.js` 又抄了一份 5000000。新增导入 / 读取 / 保存入口时很容易只挑其中一个，
 * 结果就是 P1「能导入、能打开、却永远存不进去」与 E1「应用自己导入出一本打不开的书」。
 * 现在所有入口只从这里取数，新增字面量即视为回归（`tests/limits.test.js` 有机器清单）。
 *
 * 五条线（互相关系是硬约束，单测钉住）：
 *   · MAX_CHAPTER_SAVE_CHARS   = 5,000,000  一章正文能**写进书库**的上限（chapter:save / 同口径 IPC）。
 *   · MAX_CHAPTER_READ_CHARS   = 30,000,000 一章正文能**进编辑区**的上限（loadChapterText）。
 *     比保存上限宽 6 倍：保证「能打开就能救稿」，同时挡住把 128 MB 纯 ASCII 章整份塞进 textarea
 *     （P1 的反向伤害：文件字节闸门拦不住字符数，1.28 亿字符会拖死渲染层）。
 *   · MAX_CHAPTER_RESCUE_CHARS = MAX_CHAPTER_READ_CHARS 救稿出口（chapter:rescue / chapter:copy-platform）。
 *     救稿不写书库、只写用户选的 txt 或剪贴板，所以不受保存上限约束 —— 这是「可打开但不可保存」
 *     的唯一应用内出口（P1 / 三审建议 #3 的「不能只拒」）。
 *   · MAX_CHAPTER_READ_BYTES   = 128 MB 单个章节文件「整份读进内存」的字节上限；字面量仍只有
 *     `core/common.js` 的那一份（MAX_TEXT_BYTES），这里只做同源引用（既有单测钉着两者相等）。
 *   · MAX_META_CHAPTERS        = 20,000 书目.json 里 chapters 的条数上限：读侧超限按「书目损坏」处理，
 *     写侧直接拒绝写盘（E1）。Ctrl+G 跳章列表的 20000 条是同一个数字，同一来源。
 *
 * 名称限长（I5 / N2 同源）：
 *   · MAX_CHAPTER_NAME_CHARS = 2000 章名字段（书目里的显示名；文件名另走 chapters.safeName 的 40 字）；
 *   · MAX_BOOK_TITLE_CHARS   = 80   书名字段（书目 / 顶栏 / 窗口标题；N2 在 B3 接其余入口）。
 *
 * 纯逻辑：不 require electron、不读盘、不联网；渲染层不需要它（core 模块，无 UMD）。
 */
const { formatCount, truncateSafe, MAX_TEXT_BYTES } = require('./common');

// 保存上限：与 core/ipc-limits.js 原来的 MAX_TEXT_CHARS 同数；导出 / 排版 / 查找 / 校对这些
// 「一次算完」的 IPC 入口也共用这一个数字（它们是 O(n) 计算，不是写盘）。
const MAX_CHAPTER_SAVE_CHARS = 5000000;
// 载入上限：见头注释。30,000,000 字符 ≈ 90 MB UTF-8 中文（3 字节/字），在 128 MB 文件闸门之内。
const MAX_CHAPTER_READ_CHARS = 30000000;
// 救稿出口与载入同口径：能打开就能另存 / 复制。
const MAX_CHAPTER_RESCUE_CHARS = MAX_CHAPTER_READ_CHARS;
// 单文件字节闸门的唯一字面量在 core/common.js（A3 / WP-31），这里只转发 MAX_TEXT_BYTES，不另写字节数。
const MAX_CHAPTER_READ_BYTES = MAX_TEXT_BYTES;
// 书目章节条数：与 core/ipc-limits.js 的 MAX_CHAPTER_ITEMS 同数（Ctrl+G 列表也按它截断）。
const MAX_META_CHAPTERS = 20000;
// 章名 / 书名限长（I5 / N2）：只夹「存进书目的显示名」，不影响文件名（chapters.safeName 40 字）。
const MAX_CHAPTER_NAME_CHARS = 2000;
const MAX_BOOK_TITLE_CHARS = 80;

// 超长文案的唯一模板：`正文太长（5,000,001 字，最多 5,000,000 字）`。
// core/ipc-limits.js 的 queryProblem / replacementProblem 也走这一份（不再各写一套拼法）。
function tooLong(label, length, max) {
  return `${label}太长（${formatCount(length)} 字，最多 ${formatCount(max)} 字）`;
}

// 正文类型 / 长度校验（返回 null = 合法；否则 { code, message } 给调用方转成错误回包）。
// 类型不对 → BAD_TEXT；超长 → TEXT_TOO_LARGE（与 chapter:save 的错误码同族）。
function textProblem(text, { max = MAX_CHAPTER_SAVE_CHARS, label = '正文' } = {}) {
  if (typeof text !== 'string') return { code: 'BAD_TEXT', message: `${label}必须是文本` };
  if (text.length > max) return { code: 'TEXT_TOO_LARGE', message: tooLong(label, text.length, max) };
  return null;
}

// 已知长度的字数闸门（不物化字符串）：chapter:load 的载入上限用这一份。
// 码固定为 CHAPTER_TOO_LARGE（与字节闸门同族；界面 / 测试按 code 分支）。
function charsProblem(length, { max = MAX_CHAPTER_READ_CHARS, code = 'CHAPTER_TOO_LARGE', label = '章节', tail = '' } = {}) {
  const count = Number(length);
  const cap = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : MAX_CHAPTER_READ_CHARS;
  if (!Number.isFinite(count) || count <= cap) return null;
  return {
    code,
    message: `${label}有 ${formatCount(count)} 字，超过单章上限 ${formatCount(cap)} 字${tail ? `，${tail}` : ''}`
  };
}

// 书目章节条数闸门（E1）：读侧超限按「书目损坏」，写侧在写盘前拒绝。
// 调用方给 label / tail 决定主语与收尾（导入 / 写书目的文案不同，错误码与数字同一份）。
function chapterCountProblem(count, { label = '书目.json 的章节记录', tail = '没有写盘' } = {}) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= MAX_META_CHAPTERS) return null;
  return {
    code: 'META_TOO_MANY_CHAPTERS',
    message: `${label}有 ${formatCount(n)} 条，超过单本上限 ${formatCount(MAX_META_CHAPTERS)} 条，${tail}`
  };
}

// 名称限长（I5 / N2 同源）：先 trim，再按码元截断（truncateSafe 不切开代理对），最后去掉截断
// 可能留下来的行尾空白。非字符串按空串处理（与 existing `String(x).trim()` 口径一致）。
function clipName(value, max) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  if (text.length <= max) return text;
  return truncateSafe(text, max).trim();
}

function limitChapterName(value) {
  return clipName(value, MAX_CHAPTER_NAME_CHARS);
}

function limitBookTitle(value) {
  return clipName(value, MAX_BOOK_TITLE_CHARS);
}

module.exports = {
  MAX_CHAPTER_SAVE_CHARS,
  MAX_CHAPTER_READ_CHARS,
  MAX_CHAPTER_RESCUE_CHARS,
  MAX_CHAPTER_READ_BYTES,
  MAX_META_CHAPTERS,
  MAX_CHAPTER_NAME_CHARS,
  MAX_BOOK_TITLE_CHARS,
  tooLong,
  textProblem,
  charsProblem,
  chapterCountProblem,
  limitChapterName,
  limitBookTitle
};
