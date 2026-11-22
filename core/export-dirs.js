/* 导出目录清单（F1 / 三审 4.1 · 孤儿临时文件回收的覆盖面缺口）。
 *
 * 问题：导出中断（崩溃 / 断电 / 强退）会在导出目标目录留下 `.名.tmp-pid-时间-随机` 隐藏孤儿
 * （core/atomic.js 的原子写临时文件）。启动回收以前只扫 userData + **一个** lastExportDir：
 * 用户先导出到 A、后来换到 B 之后，A 里的孤儿永远不会被任何后续启动回收 —— 多年、按作品分目录导出的
 * 用户，每个发生过导出中断的目录都留一个半成品（EPUB / DOCX 可达数 MB～数十 MB）。
 *
 * 这里只做两件纯逻辑（不碰 electron，可在 node:test 里直接测）：
 *   · mergeRecentDirs：把一个目录记进「最近导出过的目录」有界列表（最新在前、去重、上限 10）；
 *   · dirsToClean：启动时该扫哪些目录 = 最近导出目录列表 ∪ 当前 lastExportDir（去重、有界）。
 * 文件读写由 main.js 用 core/atomic 的 writeJsonAtomic / fs 完成（坏文件 / 读不到一律当空列表）。
 *
 * 口径：
 *   · 判「同一个目录」走 core/path-utils.js 的 pathKey（resolve + 小写 + Windows 正反斜杠归一，
 *     与 booksRoot / 词表 / lastExportDir 的来源校核同一口径），保留作者看到的原字符串；
 *   · 只收绝对路径、长度 1000 以内（与 config 里路径字段同一条闸门），坏条目逐条丢掉、不抛错；
 *   · 列表有界（MAX_RECENT_DIRS = 10）：这里只记"该扫哪儿"，不是导出历史，不做无限增长。
 */
const path = require('node:path');
const fsp = require('node:fs/promises');
const pathUtils = require('./path-utils');
const atomic = require('./atomic');

const MAX_RECENT_DIRS = 10;
// 与 core/config.js 的路径字段同一个上限（超长字符串一律当坏条目）
const MAX_DIR_CHARS = 1000;

// 单条目录清洗：非字符串 / 空白 / 超长 / 相对路径 → 空串（调用方丢掉）。
function cleanDir(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > MAX_DIR_CHARS) return '';
  if (!path.isAbsolute(text)) return '';
  return text;
}

// 把一个目录记进列表：最新在前、按 pathKey 去重、截到上限。坏输入原样返回清洗后的旧列表。
function mergeRecentDirs(list, dir) {
  const next = cleanDir(dir);
  const current = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const cleaned = cleanDir(item);
    if (!cleaned) continue;
    const key = pathUtils.pathKey(cleaned);
    if (seen.has(key)) continue;
    seen.add(key);
    current.push(cleaned);
  }
  if (!next) return current.slice(0, MAX_RECENT_DIRS);
  const nextKey = pathUtils.pathKey(next);
  const out = [next];
  for (const item of current) {
    if (pathUtils.pathKey(item) === nextKey) continue;
    out.push(item);
  }
  return out.slice(0, MAX_RECENT_DIRS);
}

// 启动时要扫的目录：最近导出目录 ∪ 当前 lastExportDir（去重、有界）。
// lastExportDir 排最前：它一定存在过（当前在用的那个），优先回收。
function dirsToClean({ recent, lastExportDir } = {}) {
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const cleaned = cleanDir(value);
    if (!cleaned) return;
    const key = pathUtils.pathKey(cleaned);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(cleaned);
  };
  push(lastExportDir);
  for (const item of Array.isArray(recent) ? recent : []) push(item);
  return out.slice(0, MAX_RECENT_DIRS + 1);
}

// 读清单（坏文件 / 不存在 / 形状不对一律 []，绝不影响启动）。
async function readRecentDirs(filePath) {
  const target = String(filePath == null ? '' : filePath).trim();
  if (!target) return [];
  let raw;
  try {
    raw = await fsp.readFile(target, 'utf8');
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.dirs) ? parsed.dirs : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const cleaned = cleanDir(item);
    if (!cleaned) continue;
    const key = pathUtils.pathKey(cleaned);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= MAX_RECENT_DIRS) break;
  }
  return out;
}

// 写清单（原子写；失败只返回 false，由调用方忽略 —— 记个位置而已，绝不影响导出结果）。
async function writeRecentDirs(filePath, list) {
  const target = String(filePath == null ? '' : filePath).trim();
  if (!target) return false;
  const cleaned = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const value = cleanDir(item);
    if (!value) continue;
    const key = pathUtils.pathKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(value);
    if (cleaned.length >= MAX_RECENT_DIRS) break;
  }
  try {
    await atomic.writeJsonAtomic(target, { version: 1, dirs: cleaned });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  MAX_RECENT_DIRS,
  cleanDir,
  mergeRecentDirs,
  dirsToClean,
  readRecentDirs,
  writeRecentDirs
};
