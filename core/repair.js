// 损坏恢复：从 .bak 恢复；或按目录里的 txt 文件重建书目。
const fs = require('node:fs/promises');
const path = require('node:path');
const { stripBom, writeJsonAtomic } = require('./atomic');
const { pad2 } = require('./common');
const chaptersLib = require('./chapters');
const schemaLib = require('./schema');
const conflictLib = require('./conflict');
const storage = require('./storage');

// 换书目的临时文件名（锁内串行、失败即删，固定名便于失败排查；不是章节、也不会被当成书目）
const REPAIR_TEMP_NAME = '.repair-meta.json';

function stampForBackup(date = new Date()) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

async function archiveCorruptMeta(bookPath) {
  const metaPath = path.join(bookPath, storage.BOOK_FILE);
  try {
    await fs.access(metaPath);
  } catch {
    return null;
  }
  const archived = path.join(bookPath, `${storage.CORRUPT_PREFIX}${stampForBackup()}`);
  await fs.rename(metaPath, archived);
  return archived;
}

// 换书目的安全顺序（1.6.0 A3 / 审计 E-07）：① 新书目先写成临时文件（失败 → 旧文件一个字节没动，
// 书还看得见、还能再修一次）；② 归档旧文件；③ 临时文件改名成 书目.json。②③ 任一步失败都回退：
// 删临时文件，② 之后失败还把归档的旧文件改回原名——结果始终回到「坏书目还在原地」。
// 注意：写盘顺序反了（旧代码先归档再写）时，写盘一旦失败（ENOSPC / 磁盘只读 / 权限），
// 坏书目已经被改名挪走，书架上看不见这本书，只能靠用户自己在文件夹里翻。
// io 只在单测里注入（模拟 ENOSPC / EPERM 的写盘失败），产品调用不传。
async function swapMetaFile(bookPath, nextMeta, io = {}) {
  const metaPath = path.join(bookPath, storage.BOOK_FILE);
  const tempPath = path.join(bookPath, REPAIR_TEMP_NAME);
  const writeJson = typeof io.writeJson === 'function' ? io.writeJson : writeJsonAtomic;
  const rename = typeof io.rename === 'function' ? io.rename : fs.rename;
  await writeJson(tempPath, nextMeta);
  let archived = null;
  try {
    archived = await archiveCorruptMeta(bookPath);
    await rename(tempPath, metaPath);
  } catch (err) {
    try { await fs.rm(tempPath, { force: true }); } catch { /* 清不掉也不影响旧文件 */ }
    if (archived) await fs.rename(archived, metaPath).catch(() => {});
    throw err;
  }
  return { meta: nextMeta, archived };
}

// 从目录里的 txt 重建：文件名形如 001-起风.txt，按序号排序。
// 同步盘的冲突副本（*conflicted* / *-冲突副本*）不是真正的章节，不参与重建、原样留在文件夹里。
async function rebuildFromFiles(bookPath, io = {}) {
  const allFiles = await storage.listTxtFiles(bookPath);
  const files = allFiles.filter((file) => !conflictLib.isConflictCopyName(file));
  const conflictCopies = conflictLib.findConflictCopies(allFiles);
  if (!files.length) {
    throw new storage.StorageError(
      'NO_FILES',
      allFiles.length
        ? '这个文件夹里只有同步冲突副本，没有可用的章节 txt，无法重建'
        : '这个文件夹里没有找到章节 txt，无法重建'
    );
  }
  const parsed = files.map((file, index) => {
    const match = /^(\d+)-(.+)\.txt$/i.exec(file);
    const seq = match ? Number(match[1]) : index + 1;
    let name = match ? match[2] : file.replace(/\.txt$/i, '');
    if (name === '未命名') name = '';
    return { file, seq, name };
  });
  parsed.sort((a, b) => a.seq - b.seq || a.file.localeCompare(b.file, 'zh-Hans-CN'));

  const now = new Date().toISOString();
  const meta = {
    version: 1,
    schemaVersion: schemaLib.CURRENT_SCHEMA_VERSION,
    id: `b_${Date.now().toString(36)}`,
    title: path.basename(bookPath),
    titleTemplate: chaptersLib.TITLE_TEMPLATE,
    fileSeq: parsed.reduce((max, p) => Math.max(max, p.seq), 0),
    chapters: parsed.map((p, i) => ({
      id: `ch_${chaptersLib.pad3(i + 1)}`,
      file: p.file,
      name: p.name,
      createdAt: now
    })),
    lastOpenChapterId: `ch_${chaptersLib.pad3(1)}`,
    createdAt: now
  };
  // 先写新书目（临时文件）→ 成功后才归档旧文件（1.6.0 A3 / 审计 E-07）
  const saved = await swapMetaFile(bookPath, storage.prepareBookMeta(meta), io);
  return {
    meta: saved.meta,
    archived: saved.archived,
    count: saved.meta.chapters.length,
    // 只用来说明「跳过了几个同步冲突副本」；这些文件原样保留，不删也不合并
    skippedConflicts: conflictCopies.length,
    conflictCopies
  };
}

// 从 书目.json.bak 恢复（.bak 是上一次成功写入前的版本）
async function restoreFromBak(bookPath, io = {}) {
  const bakPath = path.join(bookPath, storage.BOOK_BAK);
  let raw;
  try {
    raw = await fs.readFile(bakPath, 'utf8');
  } catch {
    throw new storage.StorageError('NO_BAK', '没有找到 书目.json.bak，无法从备份恢复');
  }
  let meta;
  try {
    meta = JSON.parse(stripBom(raw));
  } catch {
    throw new storage.StorageError('BAK_INVALID', '备份的 书目.json.bak 也无法解析，只能从目录重建');
  }
  // 校验结构，不合法就直接抛错
  if (!meta || !Array.isArray(meta.chapters)) {
    throw new storage.StorageError('BAK_INVALID', '备份的 书目.json.bak 结构不完整，只能从目录重建');
  }
  // 与重建同一顺序：先写新书目（临时文件）→ 成功后才归档旧文件；.bak 一个字节都不动
  const saved = await swapMetaFile(
    bookPath,
    storage.prepareBookMeta({
      ...schemaLib.migrateMeta(meta),
      title: typeof meta.title === 'string' && meta.title ? meta.title : path.basename(bookPath)
    }),
    io
  );
  return { meta: saved.meta, archived: saved.archived };
}

module.exports = {
  // 第二个参数只在单测里用（注入写盘失败，模拟 ENOSPC / EPERM），产品调用只传 bookPath
  rebuildFromFiles: (bookPath, io) => storage.withBookLock(bookPath, () => rebuildFromFiles(bookPath, io)),
  restoreFromBak: (bookPath, io) => storage.withBookLock(bookPath, () => restoreFromBak(bookPath, io))
};
