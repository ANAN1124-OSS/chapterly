// 原子写工具：临时文件 -> fsync -> rename，失败重试。
// 所有落盘都必须经过这里，保证「要么是旧完整版，要么是新完整版」，不会出现半截文件。
const fs = require('node:fs/promises');
const path = require('node:path');
const { sleep, stripBom } = require('./common');

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

// rename 默认 fs.rename，只为单测留一个「可注入的实现」：重试判定 / 次数 / 间隔都在这一处，
// 注入时不另走一套逻辑（D5/V78：repair 换书目也走这里，迁移盘上 EPERM 同样会重试）。
async function renameWithRetry(from, to, { tries = 3, delay = 80, rename = fs.rename } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      lastErr = err;
      const retryable = RETRY_CODES.has(err.code);
      if (!retryable || attempt === tries - 1) throw err;
      await sleep(delay);
    }
  }
  throw lastErr;
}

// X8（v1.8.0 WP-40，审计 X8；CSTO-A06）：崩溃 / 断电会让「临时文件 -> fsync -> rename」停在第一步，
// 目录里留下 `.名.tmp-pid-时间-随机` 的隐藏孤儿。启动时（userData）、打开书时（书目录）各回收一次。
// 只认本模块自己造的临时文件名，且必须同时满足「不是本进程的 pid」与「mtime 早于阈值」：
// 正在写盘的临时文件一定新鲜（阈值内），本进程自己的临时文件哪怕卡住也不动——绝不删掉在途写入。
// 清理是尽力而为：目录不存在 / 不可读 / 单个文件被占用都只跳过，绝不让打开书或启动失败。
// depth：CSTO-A06 起可选往下扫几层子目录 —— atomicCopyFile 的临时文件建在**目标目录**里，
// 而书内备份的临时文件落在 _trash/<备份组>/ 下；只扫单层会让这些崩溃残留永不回收。
// 判定条件（本进程 pid / 1 小时阈值 / 命名模式）在每一层都一样，不因深入子目录放宽。
const TMP_FILE_RE = /^\.(.+)\.tmp-(\d+)-(\d+)-([a-z0-9]+)$/;
const ORPHAN_TMP_MIN_AGE_MS = 60 * 60 * 1000;

function parseTmpName(name) {
  const text = String(name == null ? '' : name);
  const match = TMP_FILE_RE.exec(text);
  if (!match) return null;
  return { base: match[1], pid: Number(match[2]), stamp: Number(match[3]), tag: match[4] };
}

async function cleanupOrphanTmpFiles(dir, { olderThanMs = ORPHAN_TMP_MIN_AGE_MS, now = Date.now(), depth = 0 } = {}) {
  const target = String(dir == null ? '' : dir).trim();
  if (!target) return { removed: 0, kept: 0 };
  const requested = Number(olderThanMs);
  const minAgeMs = Number.isFinite(requested) && requested >= 0 ? requested : ORPHAN_TMP_MIN_AGE_MS;
  const at = Number(now);
  const nowMs = Number.isFinite(at) ? at : Date.now();
  const levels = Number(depth);
  const maxDepth = Number.isFinite(levels) && levels > 0 ? Math.floor(levels) : 0;
  let removed = 0;
  let kept = 0;

  const scanDir = async (dirPath, remaining) => {
    let entries = [];
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return; // 目录不存在 / 不可读：清理尽力而为
    }
    for (const entry of entries) {
      if (!entry.isFile()) {
        // 子目录（书内 _trash 的备份目录）里也有 atomicCopyFile 的临时文件：按 depth 继续往下。
        if (entry.isDirectory() && remaining > 0) await scanDir(path.join(dirPath, entry.name), remaining - 1);
        continue; // 同名目录 / 联接本身不碰
      }
      const parsed = parseTmpName(entry.name);
      if (!parsed) continue; // 不是本应用命名的临时文件，一个都不删
      if (parsed.pid === process.pid) {
        kept += 1; // 本进程的临时文件可能正在写（哪怕看起来很久），不动
        continue;
      }
      const full = path.join(dirPath, entry.name);
      try {
        const info = await fs.stat(full);
        if (nowMs - info.mtimeMs < minAgeMs) {
          kept += 1; // 新鲜：可能是另一个还在运行的进程正在写
          continue;
        }
        await fs.unlink(full);
        removed += 1;
      } catch {
        /* 被别人先删 / 被占用：少清一个，不影响其它文件 */
      }
    }
  };

  await scanDir(target, maxDepth);
  return { removed, kept };
}

// ATOMIC-01：rename 只保证「路径这一条目」原子替换 —— 新目录项本身可能还在页缓存里，只 fsync 了
// 文件内容、不 fsync 父目录时，忽然断电可能回到旧文件（取决于文件系统）。所以 rename 成功后尽力
// 补一次目录 fsync。Windows 上目录 fsync 普遍不被支持（EPERM / EISDIR / EINVAL），这不是错误：
// 失败只留一条诊断日志，绝不把已经成功的写盘改判失败；同一进程里第一次失败后记下「本平台不支持」，
// 不再每次都重试 / 刷日志。
let diagnosticLogError = null;
let dirSyncUnsupported = false;

// 启动时由 main 注入现成的 logError（与 core/storage 的 setDiagnostics 同一口径）；没注入 / 写失败都静默。
function setDiagnostics(io = {}) {
  diagnosticLogError = io && typeof io.logError === 'function' ? io.logError : null;
}

function reportDirSyncFailure(filePath, err) {
  if (!diagnosticLogError) return;
  try {
    diagnosticLogError('atomic-dir-sync', err, {
      level: 'info',
      code: 'DIR_SYNC_FAILED',
      file: path.basename(String(filePath == null ? '' : filePath))
    });
  } catch {
    /* 日志失败不影响写盘 */
  }
}

// 只给单测注入：{ fsImpl } 换成记录调用的假 fs（与 renameWithRetry 的 rename 注入同一套做法）。
// 返回 true = 目录 fsync 成功；false = 本平台不支持 / 目录被移走（已经尽力，不影响写盘结果）。
async function syncParentDir(filePath, { fsImpl = fs } = {}) {
  // 注入的 fsImpl 是单测替换（与真实平台能力无关），不受「本平台不支持」的记忆影响。
  if (dirSyncUnsupported && fsImpl === fs) return false;
  let handle = null;
  try {
    handle = await fsImpl.open(path.dirname(filePath), 'r');
    await handle.sync();
    return true;
  } catch (err) {
    // EPERM / EISDIR / EINVAL / EBADF / ENOTSUP：Windows 等平台不支持对目录 fsync，之后不再尝试。
    // 其它错误（目录被移走 / 权限变化）也只是一次尽力而为的持久化，不阻断写入。
    if (err && ['EPERM', 'EISDIR', 'EINVAL', 'EBADF', 'ENOTSUP', 'EACCES'].includes(err.code)) {
      dirSyncUnsupported = true;
    }
    reportDirSyncFailure(filePath, err);
    return false;
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* 忽略 */ }
    }
  }
}

// ensureDir=false：只写「已经存在的目录」（保存章节用），目录被删时直接报错，
// 绝不 mkdir 重建出一个只有一章 txt 的影子书文件夹。
async function atomicWriteFile(filePath, data, encoding = 'utf8', { ensureDir = true, syncDir = syncParentDir } = {}) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(
    dir,
    `.${base}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  let handle = null;
  try {
    if (ensureDir) await fs.mkdir(dir, { recursive: true });
    // C6（审计 S8）：'wx' = 只在临时文件不存在时创建（撞名 / 残留旧临时文件直接失败，
    // 绝不覆盖别人的文件；名字里已经有 pid + 时间 + 随机，正常不会撞）。
    handle = await fs.open(tmp, 'wx');
    await handle.writeFile(data, encoding);
    await handle.sync();
    await handle.close();
    handle = null;
    await renameWithRetry(tmp, filePath);
    // ATOMIC-01：目录 fsync 在 rename 之后做；失败只记日志（syncParentDir 内部吞掉），不阻断。
    try {
      await syncDir(filePath);
    } catch (err) {
      reportDirSyncFailure(filePath, err);
    }
  } catch (err) {
    if (handle) {
      try { await handle.close(); } catch { /* 忽略 */ }
    }
    try { await fs.unlink(tmp); } catch { /* 忽略 */ }
    throw err;
  }
}

// B5（v1.8.0 WP-28）：流式原子写。produce(write) 里按块顺序写，整段成功后才 fsync + rename；
// 任一块失败：关句柄、删临时文件、目标文件一个字节不动（与 atomicWriteFile 同一条红线）。
// TXT 导出这种「边读边拼、不物化整本字符串」的路径用它；小文件仍走 atomicWriteFile。
async function atomicWriteFileStream(filePath, produce, { ensureDir = true, syncDir = syncParentDir } = {}) {
  if (typeof produce !== 'function') throw new TypeError('atomicWriteFileStream 需要写入回调');
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmp = path.join(
    dir,
    `.${base}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  let handle = null;
  try {
    if (ensureDir) await fs.mkdir(dir, { recursive: true });
    // C6（审计 S8）：和 atomicWriteFile 一样用 'wx'，撞名 / 残留临时文件直接失败。
    handle = await fs.open(tmp, 'wx');
    const write = async (chunk) => {
      if (chunk == null) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (!buffer.length) return;
      // position = null：接在当前文件位置后面顺序写（导出只追加，不回头改）
      await handle.write(buffer, 0, buffer.length, null);
    };
    await produce(write);
    await handle.sync();
    await handle.close();
    handle = null;
    await renameWithRetry(tmp, filePath);
    // ATOMIC-01：与 atomicWriteFile 同一条纪律（atomicCopyFile 也走这里），失败不阻断。
    try {
      await syncDir(filePath);
    } catch (err) {
      reportDirSyncFailure(filePath, err);
    }
  } catch (err) {
    if (handle) {
      try { await handle.close(); } catch { /* 忽略 */ }
    }
    try { await fs.unlink(tmp); } catch { /* 忽略 */ }
    throw err;
  }
}

// B19（v1.8.0 WP-29）：原子流式复制。把一个已经存在的文件原样复制到目标，语义与
// atomicWriteFile(target, await fs.readFile(source)) 逐字节一致，但不在内存里整份物化：
// 打开源文件 → 逐块读 → 逐块写给临时文件 → fsync → rename。任一步失败：关句柄、删临时文件、
// 目标文件一个字节不动。返回实际写出的字节数（源不存在 / 读失败由调用方接住）。
async function atomicCopyFile(source, filePath, { ensureDir = true, chunkSize } = {}) {
  const rawChunk = Math.floor(Number(chunkSize));
  const size = Number.isFinite(rawChunk) && rawChunk > 0 ? rawChunk : 1 << 20;
  let written = 0;
  await atomicWriteFileStream(
    filePath,
    async (write) => {
      const handle = await fs.open(source, 'r');
      try {
        const buffer = Buffer.allocUnsafe(size);
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          await write(buffer.subarray(0, bytesRead));
          written += bytesRead;
        }
      } finally {
        try { await handle.close(); } catch { /* 忽略 */ }
      }
    },
    { ensureDir }
  );
  return written;
}

async function writeJsonAtomic(filePath, obj, options = {}) {
  await atomicWriteFile(filePath, `${JSON.stringify(obj, null, 2)}\n`, 'utf8', options);
}

module.exports = {
  atomicWriteFile,
  atomicWriteFileStream,
  atomicCopyFile,
  renameWithRetry,
  writeJsonAtomic,
  // ATOMIC-01：rename 之后的父目录 fsync（失败只记日志），以及启动时注入日志钩子 / 单测用的注入点
  syncParentDir,
  setDiagnostics,
  // X8（WP-40）：孤儿临时文件回收（启动 / 打开书时），以及给单测用的命名解析
  ORPHAN_TMP_MIN_AGE_MS,
  parseTmpName,
  cleanupOrphanTmpFiles,
  stripBom,
  sleep
};

