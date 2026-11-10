/* IPC 参数边界（v0.9 C-5，安全审计 C2）—— 纯逻辑：不 require electron、不读盘、不联网、不依赖配置。
 *
 * 为什么要有这一层：主进程的文本类 / 查找替换 / 导出类 IPC 直接把渲染层传来的正文、查找词、
 * 替换词、当前章覆盖内容（override）、章节列表拿去跑 O(n) 甚至 O(n × 词表) 的纯计算。
 * 参数类型不对（对象当正文）、超大输入（几百 MB 字符串）、超长替换（放大成几十 GB 结果）
 * 都会把主进程拖到假死，界面看起来就像「保存不动了」。这里统一在入口处校验：
 *   · 类型不对 → 用固定错误码（BAD_TEXT / BAD_QUERY / BAD_REPLACEMENT / BAD_CHAPTERS）拒绝；
 *   · 超过上限 → TEXT_TOO_LARGE / QUERY_TOO_LARGE / REPLACEMENT_TOO_LARGE / REPLACE_TOO_LARGE；
 *   · 历史行为里「坏参数被静默忽略」的（override / range），这里同样降级（返回 null / 清洗后的值），
 *     不把本来能用的导出 / 校对变成报错。
 *
 * 上限怎么定的（正常写作绝不碰到，手误 / 恶意调用一定碰到）：
 *   · 正文 500 万字：java 一章 3 千～3 万字；整本一章导入的极端书也就百万字级；
 *   · 查找词 1 万字、替换词 1 万字：作者最多搜一句话 / 换一段话；
 *   · 替换结果 2000 万字：替换最多 5000 处（core/find.js 的 MAX_MATCHES），
 *     单次替换结果上限只防「长替换 × 多处命中」放大成天文数字；
 *   · 章节列表 20000 条：沿用 main.js 原来的截断值（Ctrl+G 只需章号 / 章名，超出部分不看）。
 *
 * 错误信息一律中文、不含任何本机路径；错误码原样回给渲染层（界面按 code 分支，见 v0.9 C-4）。
 */

const MAX_TEXT_CHARS = 5000000;
const MAX_QUERY_CHARS = 10000;
const MAX_REPLACEMENT_CHARS = 10000;
const MAX_REPLACE_OUTPUT_CHARS = 20000000;
const MAX_CHAPTER_ITEMS = 20000;
const MAX_CHAPTER_NAME_CHARS = 2000;
const MAX_ID_CHARS = 200;
// 撤销删除（chapter:restore-deleted）：_trash / 书文件夹里的章节 txt 文件名按 Windows 的 260 字符封顶
// （正常章节名在 core/chapters.js 已夹到 40 字，加时间戳前缀也远到不了这里）。
const MAX_FILE_NAME_CHARS = 260;
// createdAt 这类时间戳字段只留短字符串（ISO 8601 二十几字节就够了）；超过的没有理由写进 书目.json。
const MAX_TIME_CHARS = 64;

const RANGE_MODES = ['all', 'volume', 'range'];

class IpcLimitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IpcLimitError';
    this.code = code;
  }
}

// 5000000 → '5,000,000'。2026-11-04 拍板 #1 之后这份实现收进 core/common.js（全应用字数显示
// 与这里的超限文案用同一份，不再各写一套）；这里只保留同名引用，错误文案不受影响。
const { formatCount } = require('./common');

function tooLong(label, length, max) {
  return `${label}太长（${formatCount(length)} 字，最多 ${formatCount(max)} 字）`;
}

// 返回 null = 合法；否则 { code, message }（调用方转成错误回包；纯函数便于单测）
function textProblem(text, { max = MAX_TEXT_CHARS, label = '正文' } = {}) {
  if (typeof text !== 'string') return { code: 'BAD_TEXT', message: `${label}必须是文本` };
  if (text.length > max) return { code: 'TEXT_TOO_LARGE', message: tooLong(label, text.length, max) };
  return null;
}

function queryProblem(query, { max = MAX_QUERY_CHARS, label = '查找内容' } = {}) {
  if (query == null) return null; // 和旧行为一致：没传 = 空查询（找不到，不报错）
  if (typeof query !== 'string') return { code: 'BAD_QUERY', message: `${label}必须是文本` };
  if (query.length > max) return { code: 'QUERY_TOO_LARGE', message: tooLong(label, query.length, max) };
  return null;
}

function replacementProblem(replacement, { max = MAX_REPLACEMENT_CHARS } = {}) {
  if (replacement == null) return null; // 旧行为：没传 = 空替换（等于删除）
  if (typeof replacement !== 'string') {
    return { code: 'BAD_REPLACEMENT', message: '替换内容必须是文本' };
  }
  if (replacement.length > max) {
    return { code: 'REPLACEMENT_TOO_LARGE', message: tooLong('替换内容', replacement.length, max) };
  }
  return null;
}

// 替换结果会变成多大：原文长度 + 命中数 ×（替换词长度 − 查找词长度）。
// 只估长度、不生成字符串；超过上限就拒绝，免得「一处替换一万字 × 五千处」把内存打爆。
function replaceOutputProblem(
  textLength,
  matchCount,
  queryLength,
  replacementLength,
  { max = MAX_REPLACE_OUTPUT_CHARS } = {}
) {
  const source = Math.max(0, Math.floor(Number(textLength) || 0));
  const count = Math.max(0, Math.floor(Number(matchCount) || 0));
  const query = Math.max(1, Math.floor(Number(queryLength) || 1));
  const insert = Math.max(0, Math.floor(Number(replacementLength) || 0));
  const estimate = Math.max(0, source + count * (insert - query));
  if (estimate > max) {
    return {
      code: 'REPLACE_TOO_LARGE',
      message: `替换结果太大（约 ${formatCount(estimate)} 字，最多 ${formatCount(max)} 字）；请缩短替换内容或减少替换处数`
    };
  }
  return null;
}

function raise(problem) {
  if (problem) throw new IpcLimitError(problem.code, problem.message);
}

function assertText(text, options) {
  raise(textProblem(text, options));
  return text;
}

// 查找词：null / undefined 归一成 ''（旧行为），其它非字符串拒绝；返回原字符串（保留空白，口径不变）
function assertQuery(query, options) {
  raise(queryProblem(query, options));
  return query == null ? '' : query;
}

function assertReplacement(replacement, options) {
  raise(replacementProblem(replacement, options));
  return replacement == null ? '' : replacement;
}

function assertReplaceOutput(textLength, matchCount, queryLength, replacementLength, options) {
  raise(replaceOutputProblem(textLength, matchCount, queryLength, replacementLength, options));
}

// 当前章未保存内容（override / 复制本章的 ref）：
//   旧行为是「形状不对就当没有」，这里保持降级（返回 null），只对超长正文报错（防止绕过正文上限）；
//   id 太长 / 不是字符串的字段直接丢掉（真章节 id 只有十几字节，长 id 必然匹配不到）。
function sanitizeOverride(override, { maxText = MAX_TEXT_CHARS, label = '当前章正文' } = {}) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return null;
  const clean = {};
  const text = override.text;
  if (text != null) {
    raise(textProblem(text, { max: maxText, label }));
    clean.text = text;
  }
  for (const key of ['chapterId', 'chapterFile']) {
    const value = override[key];
    if (typeof value === 'string' && value.length <= MAX_ID_CHARS) clean[key] = value;
  }
  return Object.keys(clean).length ? clean : null;
}

// 导出范围：沿用 core/exporter.resolveExportRange 的「越界自动收紧、坏值当没传」口径，
// 这里只把对象形状归一化（非对象 = 全书；未知 mode = 全书；from/to 按数字解析，非法给 null）。
// 不抛错：历史上坏 range 就是「按全书导出」，没必要把能用的一次导出变成报错。
function sanitizeRange(range) {
  if (!range || typeof range !== 'object' || Array.isArray(range)) return null;
  const mode = typeof range.mode === 'string' && RANGE_MODES.includes(range.mode) ? range.mode : 'all';
  const toNumber = (value) => {
    if (value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? Math.floor(n) : null;
  };
  let volumeId = null;
  if (typeof range.volumeId === 'string' && range.volumeId.length <= MAX_ID_CHARS) {
    volumeId = range.volumeId;
  } else if (range.volumeId == null) {
    volumeId = null;
  }
  return { mode, from: toNumber(range.from), to: toNumber(range.to), volumeId };
}

// Ctrl+G 章节列表：非数组照旧报 BAD_CHAPTERS（文案不变）；超过 20000 条只看前 20000 条；
// 每条只留 id / name（jump.js 只用这两个字段），章名限长，坏条目变成 null（jump.js 会跳过）。
function sanitizeChapterList(chapters, { max = MAX_CHAPTER_ITEMS } = {}) {
  if (!Array.isArray(chapters)) {
    throw new IpcLimitError('BAD_CHAPTERS', '章节列表格式不对');
  }
  const list = chapters.slice(0, max);
  return list.map((chapter) => {
    if (!chapter || typeof chapter !== 'object' || Array.isArray(chapter)) return null;
    let id;
    let name;
    let number;
    let volumeName;
    try {
      id = chapter.id;
      name = chapter.name;
      // 按卷编号跳章（2026-11-10）：显示章号与卷名随 payload 过来，供 core/jump 多卷匹配。
      number = chapter.number;
      volumeName = chapter.volumeName;
    } catch {
      return null; // 带 getter 的坏对象：当成无效条目，不让整次跳章失败
    }
    const clean = {};
    if (typeof id === 'string') clean.id = id.length > MAX_ID_CHARS ? id.slice(0, MAX_ID_CHARS) : id;
    if (typeof name === 'string') {
      clean.name = name.length > MAX_CHAPTER_NAME_CHARS ? name.slice(0, MAX_CHAPTER_NAME_CHARS) : name;
    }
    const n = Number(number);
    if (Number.isFinite(n) && n >= 1) {
      clean.number = Math.min(Math.floor(n), MAX_CHAPTER_ITEMS);
    }
    if (typeof volumeName === 'string' && volumeName.trim()) {
      clean.volumeName =
        volumeName.length > MAX_CHAPTER_NAME_CHARS ? volumeName.slice(0, MAX_CHAPTER_NAME_CHARS) : volumeName;
    }
    return Object.keys(clean).length ? clean : null;
  });
}

// 撤销删除（chapter:restore-deleted）的 payload —— 1.5.0 P0-3（审计 E3 / O-8）。
//
// 这条通道的副作用是「把本书 _trash 里的一个 txt 挪回书文件夹 + 往 书目.json 插一条章节」，
// 是少数「渲染层给什么、主进程就照着写成什么」的入口之一：chapter.name / createdAt / volumeId 都会
// 原样落进书目。所以在进 storage 之前先把形状收成白名单：只留
//   trashName / index / chapter{id,file,name,createdAt,volumeId,status,note} / autoChapterFile，
// 其它字段（多余的路径、伪造的 file / fileSeq / 未知键）一概不往 storage 递。
// storage 自己仍有四道校验（见 restoreDeletedChapterFromTrash 的注释）；这里只负责「形状 + 上限 + basename」，
// 不替代那一层「这个 trashName 是不是本次删除产生的那一份」的判断。
//
// 必填字段不合法一律抛 BAD_RESTORE（main.js 的 fail() 统一转成中文提示，且一行都不会写盘）；
// 可选字段类型 / 长度不对就丢掉，让 storage 走它的默认口径（createdAt 缺失 = nowIso，卷 id 不存在 = 未分卷），
// 不把一次正常撤销变成报错。空章名保持空串（= 未命名），不在这里补名字。
function restoreFileName(value) {
  if (typeof value !== 'string') return '';
  const name = value.trim();
  if (!name || name.length > MAX_FILE_NAME_CHARS) return '';
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return '';
  if (/[\u0000-\u001f\u007f]/.test(name)) return '';
  return /\.txt$/i.test(name) ? name : '';
}

function badRestorePayload(detail) {
  return new IpcLimitError('BAD_RESTORE', `撤销删除的参数不合法：${detail}`);
}

function sanitizeRestorePayload(payload) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const rawChapter = input.chapter;
  if (!rawChapter || typeof rawChapter !== 'object' || Array.isArray(rawChapter)) {
    throw badRestorePayload('缺少章节信息');
  }
  const id = typeof rawChapter.id === 'string' ? rawChapter.id.trim() : '';
  if (!id) throw badRestorePayload('缺少章节 id');
  if (id.length > MAX_ID_CHARS) throw badRestorePayload('章节 id 太长');
  const file = restoreFileName(rawChapter.file);
  if (!file) throw badRestorePayload('章节文件名必须是书文件夹里的单个 txt');
  const trashName = restoreFileName(input.trashName);
  if (!trashName) throw badRestorePayload('备份文件名必须是本书 _trash 里的单个 txt');

  const chapter = { id, file };
  // 章名：先按 MAX_CHAPTER_NAME_CHARS 夹一刀（真正的 40 字上限 / 非法字符 / 保留名清洗在
  // chaptersLib.safeName，语义归 storage，这里不抢）。
  const name = typeof rawChapter.name === 'string' ? rawChapter.name : '';
  chapter.name = name.length > MAX_CHAPTER_NAME_CHARS ? name.slice(0, MAX_CHAPTER_NAME_CHARS) : name;
  const createdAt = typeof rawChapter.createdAt === 'string' ? rawChapter.createdAt.trim() : '';
  if (createdAt && createdAt.length <= MAX_TIME_CHARS) chapter.createdAt = createdAt;
  const volumeId = typeof rawChapter.volumeId === 'string' ? rawChapter.volumeId.trim() : '';
  if (volumeId && volumeId.length <= MAX_ID_CHARS) chapter.volumeId = volumeId;
  const status = typeof rawChapter.status === 'string' ? rawChapter.status.trim() : '';
  if (status && status.length <= MAX_ID_CHARS) chapter.status = status;
  // 备注：业务上限（200 字 + 压成一行）在 core/chapters.js 的 sanitizeChapterNote；这里只保证字符串有界。
  const note = typeof rawChapter.note === 'string' ? rawChapter.note : '';
  if (note) chapter.note = note.length > MAX_CHAPTER_NAME_CHARS ? note.slice(0, MAX_CHAPTER_NAME_CHARS) : note;

  const clean = { trashName, chapter, autoChapterFile: null };
  if (input.index != null) {
    const index = input.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > MAX_CHAPTER_ITEMS) {
      throw badRestorePayload('撤销位置必须是非负整数');
    }
    clean.index = index;
  }
  if (input.autoChapterFile != null && input.autoChapterFile !== '') {
    const autoFile = restoreFileName(input.autoChapterFile);
    if (!autoFile) throw badRestorePayload('自动补章的文件名必须是单个 txt');
    clean.autoChapterFile = autoFile;
  }
  return clean;
}

// 全书查找 / 替换的 options：非对象按 {}（旧行为：没有选项就用默认），字段类型收紧
function sanitizeSearchOptions(options) {
  const source = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  return {
    query: assertQuery(source.query),
    caseSensitive: Boolean(source.caseSensitive)
  };
}

function sanitizeReplaceOptions(options) {
  const source = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  return {
    query: assertQuery(source.query),
    replacement: assertReplacement(source.replacement),
    caseSensitive: Boolean(source.caseSensitive)
  };
}

module.exports = {
  MAX_TEXT_CHARS,
  MAX_QUERY_CHARS,
  MAX_REPLACEMENT_CHARS,
  MAX_REPLACE_OUTPUT_CHARS,
  MAX_CHAPTER_ITEMS,
  MAX_CHAPTER_NAME_CHARS,
  MAX_ID_CHARS,
  MAX_FILE_NAME_CHARS,
  IpcLimitError,
  textProblem,
  queryProblem,
  replacementProblem,
  replaceOutputProblem,
  assertText,
  assertQuery,
  assertReplacement,
  assertReplaceOutput,
  sanitizeOverride,
  sanitizeRange,
  sanitizeChapterList,
  sanitizeRestorePayload,
  sanitizeSearchOptions,
  sanitizeReplaceOptions
};
