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

// X8（v1.8.0 WP-40，审计 X8）：崩溃 / 断电会让「临时文件 -> fsync -> rename」停在第一步，
// 目录里留下 `.名.tmp-pid-时间-随机` 的隐藏孤儿。启动时（userData）与打开书时（书目录）各回收一次。
// 只认本模块自己造的临时文件名，且必须同时满足「不是本进程的 pid」与「mtime 早于阈值」：
// 正在写盘的临时文件一定新鲜（阈值内），本进程自己的临时文件哪怕卡住也不动——绝不删掉在途写入。
// 清理是尽力而为：目录不存在 / 不可读 / 单个文件被占用都只跳过，绝不让打开书或启动失败。
const TMP_FILE_RE = /^\.(.+)\.tmp-(\d+)-(\d+)-([a-z0-9]+)$/;
const ORPHAN_TMP_MIN_AGE_MS = 60 * 60 * 1000;

function parseTmpName(name) {
  const text = String(name == null ? '' : name);
  const match = TMP_FILE_RE.exec(text);
  if (!match) return null;
  return { base: match[1], pid: Number(match[2]), stamp: Number(match[3]), tag: match[4] };
}

async function cleanupOrphanTmpFiles(dir, { olderThanMs = ORPHAN_TMP_MIN_AGE_MS, now = Date.now() } = {}) {
  const target = String(dir == null ? '' : dir).trim();
  if (!target) return { removed: 0, kept: 0 };
  let entries = [];
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch {
    return { removed: 0, kept: 0 }; // 目录不存在 / 不可读：清理尽力而为
  }
  const requested = Number(olderThanMs);
  const minAgeMs = Number.isFinite(requested) && requested >= 0 ? requested : ORPHAN_TMP_MIN_AGE_MS;
  const at = Number(now);
  const nowMs = Number.isFinite(at) ? at : Date.now();
  let removed = 0;
  let kept = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue; // 同名目录 / 联接不碰
    const parsed = parseTmpName(entry.name);
    if (!parsed) continue; // 不是本应用命名的临时文件，一个都不删
    if (parsed.pid === process.pid) {
      kept += 1; // 本进程的临时文件可能正在写（哪怕看起来很久），不动
      continue;
    }
    const full = path.join(target, entry.name);
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
  return { removed, kept };
}

// ensureDir=false：只写「已经存在的目录」（保存章节用），目录被删时直接报错，
// 绝不 mkdir 重建出一个只有一章 txt 的影子书文件夹。
async function atomicWriteFile(filePath, data, encoding = 'utf8', { ensureDir = true } = {}) {
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
async function atomicWriteFileStream(filePath, produce, { ensureDir = true } = {}) {
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

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(stripBom(raw));
}

async function writeJsonAtomic(filePath, obj, options = {}) {
  await atomicWriteFile(filePath, `${JSON.stringify(obj, null, 2)}\n`, 'utf8', options);
}

module.exports = {
  atomicWriteFile,
  atomicWriteFileStream,
  atomicCopyFile,
  renameWithRetry,
  readJson,
  writeJsonAtomic,
  // X8（WP-40）：孤儿临时文件回收（启动 / 打开书时），以及给单测用的命名解析
  ORPHAN_TMP_MIN_AGE_MS,
  parseTmpName,
  cleanupOrphanTmpFiles,
  stripBom,
  sleep
};

