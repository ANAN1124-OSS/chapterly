// 「本书历史」：统一扫描书内 _trash 的各种备份 + 书文件夹根部的 书目.json.bak。
// 只读扫描 / 预览；真正的还原在 core/storage.js（要拿书界面的章节列表、原子写盘、字数缓存），
// 这里只提供路径校验、归类和读取，方便单测，也不让渲染层直接碰文件系统。
const fs = require('node:fs/promises');
const path = require('node:path');
const { stripBom } = require('./atomic');
const { pad2, mapLimit } = require('./common');
const pathUtils = require('./path-utils');
const { parseSnapshotDirName } = require('./snapshot');

const TRASH_DIR = '_trash';
const BOOK_BAK = '书目.json.bak';
// 预览上限：足够看一整章，也不至于把一本巨大的书一次性塞进渲染层
const PREVIEW_MAX_BYTES = 512 * 1024;
// A4 / P-11（审计：_trash 双层串行 stat）：一次 listHistory 的 stat / readdir 并发上限。
// 备份多的时候（几百个文件）串行要按文件数累加；8 路既快又不会把盘 / 杀软打满。
const HISTORY_STAT_CONCURRENCY = 8;

const SOURCE_META = {
  replace: {
    label: '整本替换',
    prefix: '替换备份-',
    note: '整本替换前自动备份的原文。可以预览、还原单章或整组；只还原现在仍在书里的章节，已删除的章节不会偷偷复活。'
  },
  format: {
    label: '整本整理',
    prefix: '整理备份-',
    note: '整本整理前自动备份的原文。可以预览、还原单章或整组；只还原现在仍在书里的章节。'
  },
  restore: {
    label: '还原前备份',
    prefix: '还原前备份-',
    note: '每次还原前自动留下的反向备份，方便把还原这一步也退回去。可以预览、还原单章或整组。'
  },
  snapshot: {
    label: '每日快照',
    prefix: '快照-',
    note: '每日快照留下的章节副本。可以预览、还原单章或整组。'
  },
  delete: {
    label: '删除章节',
    note: '删除章节时移到 _trash 的原文。还原会把 txt 放回书文件夹，但不会自动加回章节列表（需要的话可用「从目录重建」找回）；书里已有同名文件时不会覆盖。'
  },
  bookmeta: {
    label: '书目备份',
    note: '上一版 书目.json。只供查看，避免用旧书目覆盖现在的章节列表；损坏时请走书卡的「修复」。'
  },
  other: {
    label: '其他备份',
    note: '没有识别出用途的备份文件，只供查看；写作器不会自动处理、移动或删除它们。'
  }
};

const KNOWN_DIR_SOURCES = ['replace', 'format', 'restore', 'snapshot'];
// A4（WP-32 / 审计 A4）：哪些来源的备份「能还原」只在这里说一次。SOURCE_META 里曾有
// restorable 字段，但全仓没有任何读取点，真正生效的是这个 Set；两份事实并存时改一份就会说谎，
// 所以删掉死字段、只留 Set。散文件（删除章节的原文）在 listHistory 的 file 分支单独按
// source === 'delete' 给 restorable（它不经过目录分类，也不在本 Set 的判定范围里）。
const RESTORABLE_SOURCES = new Set(['replace', 'format', 'restore', 'snapshot']);
const TEXT_EXTS = new Set(['.txt', '.json', '.bak', '.md']);

// B6（v1.8.0 WP-28 / D-5）：可以手动清理的三类「整本操作」备份 —— 只清理这三类目录，
// 每日快照有自己的「清空这天的快照」入口、删章散文件是章节原文、书目备份只供查看，
// 一律不从「清理备份」入口删。**永远不自动删**：这里只提供摘要与删除目标的白名单，删除由界面显式调用。
const CLEANABLE_SOURCES = Object.freeze(['replace', 'format', 'restore']);
const CLEANABLE_SOURCE_SET = new Set(CLEANABLE_SOURCES);
// 软提醒阈值（D-5 已定，先到为准）：单书 ≥20 组 或 合计 ≥500MB 时，历史面板只提示「可清理」。
const CLEANUP_REMINDER_GROUPS = 20;
const CLEANUP_REMINDER_BYTES = 500 * 1024 * 1024;

// 三类备份的占用摘要（纯函数，历史面板 / 单测共用；不含快照 / 删章散文件 / 书目备份）。
// 阈值只用于提示，绝不触发任何删除；结果里同时给出两组判据，方便界面写清「先到为准」。
function backupCleanupSummary(groups) {
  const list = (Array.isArray(groups) ? groups : []).filter(
    (group) => group && group.kind === 'dir' && CLEANABLE_SOURCE_SET.has(group.source)
  );
  let totalBytes = 0;
  for (const group of list) {
    const bytes = Number(group.totalBytes);
    if (Number.isFinite(bytes) && bytes > 0) totalBytes += bytes;
  }
  const overGroups = list.length >= CLEANUP_REMINDER_GROUPS;
  const overBytes = totalBytes >= CLEANUP_REMINDER_BYTES;
  return {
    groupCount: list.length,
    totalBytes,
    overGroups,
    overBytes,
    overLimit: overGroups || overBytes
  };
}

class HistoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HistoryError';
    this.code = code;
  }
}

// 目录名里的时间戳是 moveToTrash/uniqueTrashDir 生成的本地时间：YYYY-MM-DD-HHMMSS[-序号]。
// 认不出或日期非法返回 0，调用方会退回文件的 mtime。
function parseStampTime(stamp) {
  const match = /^(\d{4})-(\d{2})-(\d{2})-(\d{6})(?:-\d+)?$/.exec(String(stamp == null ? '' : stamp).trim());
  if (!match) return 0;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4].slice(0, 2));
  const minute = Number(match[4].slice(2, 4));
  const second = Number(match[4].slice(4, 6));
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) {
    return 0;
  }
  return date.getTime();
}

function formatHistoryTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const date = new Date(n);
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

function sourceLabel(source) {
  return (SOURCE_META[source] || SOURCE_META.other).label;
}

function sourceNote(source) {
  return (SOURCE_META[source] || SOURCE_META.other).note;
}

function isValidBaseName(name) {
  return Boolean(name) && path.basename(name) === name && name !== '.' && name !== '..';
}

// 解析删除章节时留下的散文件：{时间戳}-{原文件名}.txt
// 同一次删除撞名会生成 {时间戳}-{序号}-{原文件名}.txt（序号从 2 开始、不补零），
// 而原文件名本身是 3 位序号开头（001-xxx.txt），所以要避免把「001」误当撞名序号。
//
// HIS-01：前导数字既可能是撞名序号，也可能是章号本身 —— `123-003-夜雨.txt` 是「第 123 章、
// 章名 003-夜雨」的真实文件名，旧实现把 123 当撞名序号剥成 `003-夜雨.txt`，历史还原写错名。
// 撞名序号只出现在「同一秒内同名文件被删多次」（moveToTrash 从 2 开始试）：1–2 位（2–99 次）
// 才当序号剥；3 位（≥100 次）现实中不会发生，按章号算。两个候选都返回，调用方还能按书目再选：
//   originalName：默认采用的名字；altName：另一个候选（空串 = 没有别的候选）。
function parseDeletedName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return null;
  const match = /^(\d{4}-\d{2}-\d{2}-\d{6})-(.+)$/.exec(name);
  if (!match) return null;
  const rest = match[2];
  if (!/\.txt$/i.test(rest)) return null;
  // C34（v1.8.0 WP-26）：4 位及以上的数字串是章号序号本身（pad3 之后 1000+ 的章号）。旧正则
  // `[1-9]\d*` 会把 `1000-2024-回顾.txt` 的章号当序号剥掉，历史列表里显示成 `2024-回顾.txt`。
  const ordinal = /^([1-9]\d{0,2})-(.+)$/.exec(rest);
  // 剥掉序号后仍要以 3+ 位数字开头：否则「2-起风.txt」更像是章名本身带数字的普通名字
  const stripped = ordinal && /^\d{3,}-.*\.txt$/i.test(ordinal[2]) ? ordinal[2] : '';
  const useStripped = Boolean(stripped) && ordinal[1].length <= 2;
  return {
    stamp: match[1],
    originalName: useStripped ? stripped : rest,
    altName: useStripped ? rest : stripped
  };
}

function classifyDirName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!isValidBaseName(name) || name.startsWith('.')) return null;
  for (const source of KNOWN_DIR_SOURCES) {
    const prefix = SOURCE_META[source].prefix;
    if (!name.startsWith(prefix)) continue;
    const stamp = name.slice(prefix.length);
    return { name, kind: 'dir', source, stamp, time: parseStampTime(stamp) };
  }
  return { name, kind: 'dir', source: 'other', stamp: '', time: 0 };
}

// HIS-01：删章散文件的两个候选（剥 / 不剥撞名序号）里，书目现有的章节名能对上的那个更可信 ——
// 例如 `12-003-夜雨.txt` 这种非常规文件名若还在书里，说明它就是原文件名，而不是 `003-夜雨.txt`。
function chapterFileSet(options) {
  const files = options && options.chapterFiles;
  if (files instanceof Set) return files;
  if (Array.isArray(files)) return new Set(files);
  return null;
}

function pickDeletedOriginalName(parsed, chapterFiles) {
  const main = parsed.originalName;
  const alt = parsed.altName || '';
  if (!alt || !chapterFiles) return main;
  const mainInBook = chapterFiles.has(main);
  const altInBook = chapterFiles.has(alt);
  if (altInBook && !mainInBook) return alt;
  return main;
}

function classifyLooseName(raw, options) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!isValidBaseName(name) || name.startsWith('.')) return null;
  if (name === BOOK_BAK) {
    return { name, kind: 'file', source: 'bookmeta', stamp: '', time: 0, originalName: BOOK_BAK };
  }
  const deleted = parseDeletedName(name);
  if (deleted) {
    return {
      name,
      kind: 'file',
      source: 'delete',
      stamp: deleted.stamp,
      time: parseStampTime(deleted.stamp),
      originalName: pickDeletedOriginalName(deleted, chapterFileSet(options))
    };
  }
  return { name, kind: 'file', source: 'other', stamp: '', time: 0, originalName: name };
}

function isPreviewableName(name) {
  const text = String(name == null ? '' : name);
  if (text === BOOK_BAK) return true;
  return TEXT_EXTS.has(path.extname(text).toLowerCase());
}

function makeFileEntry({ name, trashName, size, mtimeMs, inBook, restorable, reason, source }) {
  return {
    name,
    trashName,
    size: Math.max(0, Number(size) || 0),
    mtimeMs: Math.round(Number(mtimeMs) || 0),
    inBook: Boolean(inBook),
    restorable: Boolean(restorable),
    previewable: isPreviewableName(trashName || name) && (Number(size) || 0) <= PREVIEW_MAX_BYTES,
    reason: reason || '',
    source
  };
}

function compareGroups(a, b) {
  if (b.time !== a.time) return b.time - a.time;
  return String(b.id).localeCompare(String(a.id), 'zh-Hans-CN');
}

// 扫描一本书的备份。chapterFiles 是当前书目的章节文件名（用于判断「还在不在书里」）。
// 只读，不改任何文件；_trash 不存在时返回空列表（旧书/新书都可能没有）。
async function listHistory(bookPath, options = {}) {
  const root = String(bookPath == null ? '' : bookPath);
  if (!root) throw new HistoryError('BAD_BOOK', '缺少书的路径');
  const chapterFiles = new Set(
    (Array.isArray(options.chapterFiles) ? options.chapterFiles : []).filter(
      (name) => typeof name === 'string' && name
    )
  );
  const groups = [];
  // 审计修复 #54（P8）：单组还原（storage.findHistoryGroup）不需要扫全量历史 —— 旧实现为一个组
  // 把几百个备份目录的 readdir + 全部文件 stat 都跑一遍。only 先过 resolveGroup 的同一套严格校验
  // （路径穿越 / 非法组名照旧拒绝），下面只收命中的那一个组；不传时行为与以前逐字一致。
  const only = options.only ? resolveGroup(root, String(options.only)) : null;

  // PERF-HIST-01（2026-11-24 复核补审）：列表默认只回组摘要（组名 / 文件数 / 可还原数 / 大小）——
  // 每个组的 files 明细由渲染层展开该组时带 `only` 再拉一次（复用下面已有的单组扫描）。
  // summary=false（默认，保持旧调用方 / 还原 / 清理计划的形状不变）仍返回完整 files。
  const summary = options.summary === true;

  // 1) 书文件夹根部的 书目.json.bak（不是 _trash 里，但也是可回看的「历史」）
  const bakPath = path.join(root, BOOK_BAK);
  const wantsBak = !only || (only.kind === 'file' && only.source === 'bookmeta');
  if (wantsBak) {
    try {
      const stat = await fs.stat(bakPath);
      if (stat.isFile()) {
        groups.push({
          id: 'bak',
          kind: 'file',
          source: 'bookmeta',
          sourceLabel: sourceLabel('bookmeta'),
          note: sourceNote('bookmeta'),
          stamp: '',
          time: Math.round(stat.mtimeMs),
          timeText: formatHistoryTime(stat.mtimeMs),
          fileName: BOOK_BAK,
          dirName: '',
          fileCount: 1,
          totalBytes: stat.size,
          restorableCount: 0,
          cleanable: false,
          files: [
            makeFileEntry({
              name: BOOK_BAK,
              trashName: BOOK_BAK,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              inBook: false,
              restorable: false,
              reason: '书目备份只供查看，不能自动覆盖现在的书目',
              source: 'bookmeta'
            })
          ]
        });
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  // 2) 书内 _trash：备份目录 + 散文件
  const trashPath = path.join(root, TRASH_DIR);
  let entries = [];
  try {
    entries = await fs.readdir(trashPath, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  // A4 / P-11（审计：_trash 双层串行 stat —— 每个备份目录、每个文件各 await 一次）：
  // 拆成两段并发读盘：① 备份目录 readdir 8 路；② 目录内文件 + _trash 散文件合成一张
  // 平坦的任务表，统一 8 路 stat。stat 峰值 = concurrency（默认 8），不再随文件数线性变慢。
  const statFile = typeof options.stat === 'function' ? options.stat : (target) => fs.stat(target);
  const requestedConcurrency = Number(options.concurrency);
  const concurrency =
    Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
      ? Math.floor(requestedConcurrency)
      : HISTORY_STAT_CONCURRENCY;

  const dirEntries = [];
  const looseEntries = [];
  for (const entry of entries) {
    if (!entry || entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      const info = classifyDirName(entry.name);
      if (!info) continue;
      // 审计修复 #54（P8）：only 时只收命中的那一个组，其余目录连 readdir / stat 都不做。
      if (only && (only.kind !== 'dir' || only.dirName !== entry.name)) continue;
      dirEntries.push({ name: entry.name, info });
      continue;
    }
    if (!entry.isFile()) continue;
    const info = classifyLooseName(entry.name, { chapterFiles });
    if (!info) continue;
    if (only && (only.kind !== 'file' || only.fileName !== entry.name)) continue;
    looseEntries.push({ name: entry.name, info });
  }

  // ① 备份目录 readdir（并发 8 路）：目录刚好被移走 / 占用就跳过（旧行为）
  const dirListings = await mapLimit(dirEntries, concurrency, async (dir) => {
    try {
      const children = await fs.readdir(path.join(trashPath, dir.name), { withFileTypes: true });
      return {
        ...dir,
        children: children.filter((child) => child && child.isFile() && !child.name.startsWith('.'))
      };
    } catch {
      return null;
    }
  });

  // ② 平坦任务表：目录内文件按目录归桶，_trash 散文件单独收；一次 8 路 stat 覆盖全部
  const buckets = new Map();
  const jobs = [];
  for (const listing of dirListings) {
    if (!listing) continue;
    const bucket = [];
    buckets.set(listing, bucket);
    const dirPath = path.join(trashPath, listing.name);
    for (const child of listing.children) jobs.push({ name: child.name, dirPath, bucket });
  }
  for (const loose of looseEntries) jobs.push({ name: loose.name, dirPath: trashPath, loose });
  const stats = await mapLimit(jobs, concurrency, async (job) => {
    try {
      return await statFile(path.join(job.dirPath, job.name));
    } catch {
      return null; // 文件刚好被清掉 / 占用：跳过，不影响其它条目
    }
  });
  const looseStats = new Map();
  for (let index = 0; index < jobs.length; index += 1) {
    const job = jobs[index];
    const stat = stats[index];
    if (!stat) continue;
    if (job.bucket) job.bucket.push({ name: job.name, stat });
    else looseStats.set(job.loose, stat);
  }

  // ③ 目录组：文件顺序 / mtimeMax / 快照字段与旧实现一致
  for (const listing of dirListings) {
    if (!listing) continue;
    const info = listing.info;
    const files = [];
    let mtimeMax = 0;
    for (const { name, stat } of buckets.get(listing) || []) {
      mtimeMax = Math.max(mtimeMax, stat.mtimeMs);
      const inBook = chapterFiles.has(name);
      const isChapterFile = /\.txt$/i.test(name);
      const canRestore = isChapterFile && inBook && RESTORABLE_SOURCES.has(info.source);
      files.push(
        makeFileEntry({
          name,
          trashName: name,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          inBook,
          restorable: canRestore,
          reason: !isChapterFile
            ? '不是 .txt 章节文件，只供查看'
            : !RESTORABLE_SOURCES.has(info.source)
              ? '未识别的备份，只供查看'
              : !inBook
                ? '这一章已经不在书里了，不会自动复活'
                : '',
          source: info.source
        })
      );
    }
    if (!files.length) continue;
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    const stampTime = info.time || 0;
    const time = stampTime || Math.round(mtimeMax);
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    // 每日快照组（P22-5）：只有「快照-YYYYMMDD 且日期真实存在」的目录才带 snapshotName / snapshotDay，
    // 渲染层据此决定「默认折叠 + 清空这天的快照」，不用自己切 id 字符串。
    // 名字对不上严格格式的目录（手写的 快照-2026-10-31-230000 之类）仍然显示为「每日快照」，
    // 但不折叠、也不给清空按钮 —— 宁可少一个入口，也不碰不是本应用生成的目录。
    const snapshot = info.source === 'snapshot' ? parseSnapshotDirName(listing.name) : null;
    const group = {
      id: `dir:${listing.name}`,
      kind: 'dir',
      source: info.source,
      sourceLabel: sourceLabel(info.source),
      note: sourceNote(info.source),
      stamp: info.stamp,
      time,
      timeText: formatHistoryTime(time),
      dirName: listing.name,
      fileName: '',
      fileCount: files.length,
      totalBytes,
      restorableCount: files.filter((file) => file.restorable).length,
      // B6：三类整本操作备份（替换 / 整理 / 还原前）才给「删除这组备份」，其它来源 false
      cleanable: CLEANABLE_SOURCE_SET.has(info.source),
      files
    };
    // 字段只在严格合法的每日快照组上出现（其它来源的组保持原形状）
    if (snapshot) {
      group.snapshotName = snapshot.name;
      group.snapshotDay =
        `${snapshot.dayKey.slice(0, 4)}-${snapshot.dayKey.slice(4, 6)}-${snapshot.dayKey.slice(6, 8)}`;
    }
    groups.push(group);
  }

  // ④ _trash 散文件（删章散文件 / 未识别用途的文件）
  for (const loose of looseEntries) {
    const stat = looseStats.get(loose);
    if (!stat) continue;
    const info = loose.info;
    const time = info.time || Math.round(stat.mtimeMs);
    let file;
    if (info.source === 'delete') {
      file = makeFileEntry({
        name: info.originalName,
        trashName: loose.name,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        inBook: chapterFiles.has(info.originalName),
        restorable: true,
        reason: '',
        source: 'delete'
      });
    } else {
      file = makeFileEntry({
        name: loose.name,
        trashName: loose.name,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        inBook: false,
        restorable: false,
        reason: '没有识别出用途的备份文件，只供查看',
        source: info.source
      });
    }
    groups.push({
      id: `file:${loose.name}`,
      kind: 'file',
      source: info.source,
      sourceLabel: sourceLabel(info.source),
      note: sourceNote(info.source),
      stamp: info.stamp,
      time,
      timeText: formatHistoryTime(time),
      dirName: '',
      fileName: loose.name,
      originalName: info.originalName || '',
      fileCount: 1,
      totalBytes: stat.size,
      restorableCount: file.restorable ? 1 : 0,
      cleanable: false,
      files: [file]
    });
  }

  groups.sort(compareGroups);
  // PERF-HIST-01：摘要模式不把每组的 files 数组发到渲染层（50 组 × 1000 文件的 JSON / DOM 都在
  // 这一层被砍掉）；组的文件数 / 大小 / 可还原数等聚合字段照旧准确。展开某组时带 only 再来一次。
  for (const group of groups) {
    if (summary) {
      delete group.files;
      group.filesLoaded = false;
    } else {
      group.filesLoaded = true;
    }
  }
  return {
    trashPath,
    groupCount: groups.length,
    fileCount: groups.reduce((sum, group) => sum + group.fileCount, 0),
    totalBytes: groups.reduce((sum, group) => sum + group.totalBytes, 0),
    groups
  };
}

// 严格解析渲染层传回来的备份组 id；id 只能落在本书 _trash / 书目.json.bak 范围内。
function resolveGroup(bookPath, groupId) {
  const root = String(bookPath == null ? '' : bookPath);
  if (!root) throw new HistoryError('BAD_BOOK', '缺少书的路径');
  const id = String(groupId == null ? '' : groupId).trim();
  const trashPath = path.join(root, TRASH_DIR);
  if (id === 'bak') {
    return {
      id,
      kind: 'file',
      source: 'bookmeta',
      fileName: BOOK_BAK,
      originalName: BOOK_BAK,
      filePath: path.join(root, BOOK_BAK)
    };
  }
  if (id.startsWith('dir:')) {
    const name = id.slice('dir:'.length);
    if (!isValidBaseName(name) || name.startsWith('.')) {
      throw new HistoryError('BAD_GROUP', '备份目录名不合法');
    }
    const info = classifyDirName(name);
    if (!info) throw new HistoryError('BAD_GROUP', '备份目录名不合法');
    return {
      id,
      kind: 'dir',
      source: info.source,
      dirName: name,
      dirPath: path.join(trashPath, name),
      stamp: info.stamp,
      time: info.time
    };
  }
  if (id.startsWith('file:')) {
    const name = id.slice('file:'.length);
    if (!isValidBaseName(name) || name.startsWith('.')) {
      throw new HistoryError('BAD_GROUP', '备份文件名不合法');
    }
    const info = classifyLooseName(name);
    if (!info) throw new HistoryError('BAD_GROUP', '备份文件名不合法');
    return {
      id,
      kind: 'file',
      source: info.source,
      fileName: name,
      originalName: info.originalName || name,
      filePath: path.join(trashPath, name),
      stamp: info.stamp,
      time: info.time
    };
  }
  throw new HistoryError('BAD_GROUP', '备份组 id 不合法');
}

// 把「组 + 文件名」解析成一个确定落在允许范围内的实际路径。
// 注意：这里只做字符串级校验（basename / 点开头）；**真正的防跟随在 inspectBackupFile()**——
// 预览 / 还原在读盘前必须再跑一次异步复核（N-20）。
function resolveHistoryPath(bookPath, groupId, fileName) {
  const group = resolveGroup(bookPath, groupId);
  if (group.kind === 'file') return group.filePath;
  const name = String(fileName == null ? '' : fileName).trim();
  if (!isValidBaseName(name) || name.startsWith('.')) {
    throw new HistoryError('BAD_FILE', '备份文件名不合法');
  }
  return path.join(group.dirPath, name);
}

// N-20：预览 / 还原的最终路径必须真的是「书内 _trash 下的普通文件」。
// 路径字符串校验挡不住符号链接 / 目录联接：stat / open 会跟随链接读到库外文件（预览泄露），
// 还原还会把库外内容抄进书（对照 ipc/book-data.js 的 book:clear-snapshot-day 已用 lstat 拒绝链接）。
// 这里在真正读之前补两道异步复核：
//   ① lstat 最终路径：是链接 → 拒绝（合法备份永远不是链接）；
//   ② realpath 之后必须仍在「书文件夹的真实路径」下面 —— 防「父目录本身是链接 / 联接指向库外」。
// 返回 lstat（含 size / mtimeMs）；目标不存在返回 null，调用方按各自的「文件已不存在」口径报错。
async function inspectBackupFile(bookPath, target) {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (stat.isSymbolicLink()) {
    throw new HistoryError(
      'HISTORY_NOT_FILE',
      '这个备份是一个链接（符号链接 / 目录联接），出于安全考虑不读取；请把真实文件放进书里的 _trash'
    );
  }
  if (!stat.isFile()) throw new HistoryError('HISTORY_NOT_FILE', '这个备份不是一个文件');
  let realTarget = '';
  let realBook = '';
  try {
    realTarget = await fs.realpath(target);
    realBook = await fs.realpath(bookPath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const bookKey = pathUtils.pathKey(realBook);
  const targetKey = pathUtils.pathKey(realTarget);
  if (targetKey !== bookKey && !targetKey.startsWith(bookKey + path.sep)) {
    throw new HistoryError('HISTORY_NOT_FILE', '备份文件解析到的真实路径不在书文件夹里，出于安全考虑不读取');
  }
  return stat;
}

// CSTO-B-03（审计低批）：预览按字节截断，截断点可能落在 UTF-8 多字节序列中间。
// 中文正文以 3 字节汉字为主，边界落在字符中间的概率约 2/3，直接 toString('utf8') 会在预览结尾
// 吐一个 U+FFFD 伪像，让作者以为备份本身坏了。这里把截断点向前回退到合法的字符边界：
// 从末尾数连续的后继字节（10xxxxxx），再看它前面的前导字节要求几个字节；不够就整段尾巴去掉。
// 非法前导（11111xxx 等）原样交回 —— 那是备份内容本身的问题，不该由预览伪装成正常。
function trimIncompleteUtf8(buffer) {
  const end = buffer.length;
  let lead = end - 1;
  let continuation = 0;
  while (lead >= 0 && continuation < 3 && (buffer[lead] & 0xc0) === 0x80) {
    lead -= 1;
    continuation += 1;
  }
  if (lead < 0) return buffer; // 整段都是后继字节：不是本函数能判的，原样交回
  const first = buffer[lead];
  let need = 0;
  if ((first & 0x80) === 0x00) need = 1;
  else if ((first & 0xe0) === 0xc0) need = 2;
  else if ((first & 0xf0) === 0xe0) need = 3;
  else if ((first & 0xf8) === 0xf0) need = 4;
  else return buffer;
  const have = end - lead;
  return have < need ? buffer.subarray(0, lead) : buffer;
}

// 预览一个备份文件（只读）。大文件只读开头，返回值里用 truncated 标出来。
async function readHistoryFile(bookPath, groupId, fileName) {
  const group = resolveGroup(bookPath, groupId);
  const filePath = resolveHistoryPath(bookPath, groupId, fileName);
  // N-20：先 lstat（拒链接）+ realpath（必须仍在书内），不直接 stat / open 跟随链接。
  const stat = await inspectBackupFile(bookPath, filePath);
  if (!stat) throw new HistoryError('HISTORY_FILE_MISSING', '这个备份文件已经不存在了');
  const readBytes = Math.min(stat.size, PREVIEW_MAX_BYTES);
  let text = '';
  if (readBytes > 0) {
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(readBytes);
      const { bytesRead } = await handle.read(buffer, 0, readBytes, 0);
      text = stripBom(trimIncompleteUtf8(buffer.subarray(0, bytesRead)).toString('utf8'));
    } finally {
      await handle.close();
    }
  }
  const displayName =
    group.kind === 'file' && group.source === 'delete'
      ? group.originalName
      : path.basename(filePath);
  return {
    groupId: group.id,
    source: group.source,
    sourceLabel: sourceLabel(group.source),
    fileName: displayName,
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
    truncated: stat.size > readBytes,
    text
  };
}

module.exports = {
  TRASH_DIR,
  BOOK_BAK,
  PREVIEW_MAX_BYTES,
  CLEANABLE_SOURCES,
  CLEANUP_REMINDER_GROUPS,
  CLEANUP_REMINDER_BYTES,
  backupCleanupSummary,
  parseStampTime,
  formatHistoryTime,
  parseDeletedName,
  classifyDirName,
  classifyLooseName,
  sourceLabel,
  listHistory,
  resolveGroup,
  resolveHistoryPath,
  inspectBackupFile,
  readHistoryFile
};
