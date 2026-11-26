// 章节文件内容指纹（首尾采样）的唯一实现。
//
// 为什么单独一个模块：这份指纹有两个消费者，口径必须永远一致——
//   · core/search-index.js：每章 contentHash，深度校验时发现「同 size + 同 mtime 的改写」；
//   · core/storage.js：保存守卫（审计 E-N2）比对「编辑器载入那一版」与「现在磁盘那一版」。
// 实现搬到这里之前只有索引一份（storage 直接 require search-index 会成环：search-index 已 require storage）。
//
// 口径：`${字节数}:${首 4 KB FNV-1a 32 位}:${尾 4 KB FNV-1a 32 位}`（十六进制、小写、补足 8 位）。
// 只读 4 KB × 2，够发现「同大小、同时间戳」的改写又不拖慢校验；FNV-1a 不是加密哈希，
// 只回答「这一段字节还是不是原来那一段」，不是安全判定。
//
// 已知盲区（设计取舍，审计残留 #R20 / E4）：只改文件中段、又保留 size + mtime 的改写算出的指纹
// 与旧值一致，不会被发现（要等大小 / mtime 变化或重建索引）。全量哈希会把每次校验的读盘量放大
// 到整本，不取。读不到（被占用 / 权限）时返回空串：调用方按「这次没有指纹」处理，不据此误拦。
const fs = require('node:fs/promises');

// 首 / 尾采样大小（字节）。
const FINGERPRINT_SAMPLE_BYTES = 4096;

// FNV-1a 32 位（与 core/clipboard-watch.js 同一套思路）。
function sampleHashOf(buffer, seed) {
  let hash = seed >>> 0;
  for (let i = 0; i < buffer.length; i += 1) {
    hash ^= buffer[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// 从文件指定位置读一小段（本地文件偶发短读时循环补齐；读不满就按实际字节算哈希）。
async function readSampleAt(handle, length, position) {
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const result = await handle.read(buffer, done, length - done, position + done);
    if (!result || !result.bytesRead) break;
    done += result.bytesRead;
  }
  return done === length ? buffer : buffer.subarray(0, done);
}

// KNOWN-FINGERPRINT（2026-11-26 复核）：正文刚被整份读进内存时（chapter:load 的 track=true），
// 直接拿同一份字节算首尾指纹，省掉对同一文件的第二次 open + 两次 read。口径与
// chapterContentHashOf 逐字相同（字节数 + 首 4 KB + 尾 4 KB）。
function fingerprintFromBuffer(buffer, size) {
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const total = Number.isFinite(Number(size)) ? Math.max(0, Math.floor(Number(size))) : raw.length;
  const head = raw.subarray(0, Math.min(FINGERPRINT_SAMPLE_BYTES, total));
  const tailLength = Math.min(FINGERPRINT_SAMPLE_BYTES, Math.max(0, total - head.length));
  const tail = tailLength > 0 ? raw.subarray(Math.max(0, total - tailLength), total) : Buffer.alloc(0);
  const headHash = sampleHashOf(head, 0x811c9dc5).toString(16).padStart(8, '0');
  const tailHash = sampleHashOf(tail, 0x7f4a7c15).toString(16).padStart(8, '0');
  return `${total}:${headHash}:${tailHash}`;
}

// 一章文件的内容指纹 = 字节数 + 首 4 KB 哈希 + 尾 4 KB 哈希。
// 读不到（被占用 / 权限）时返回空串：调用方按「没有这一版指纹」处理，不据此误拦。
async function chapterContentHashOf(filePath, size) {
  let handle = null;
  try {
    handle = await fs.open(filePath, 'r');
    const total = Math.max(0, Math.floor(Number(size) || 0));
    const head = await readSampleAt(handle, Math.min(FINGERPRINT_SAMPLE_BYTES, total), 0);
    const tailLength = Math.min(FINGERPRINT_SAMPLE_BYTES, total - head.length);
    const tail = tailLength > 0 ? await readSampleAt(handle, tailLength, total - tailLength) : Buffer.alloc(0);
    const headHash = sampleHashOf(head, 0x811c9dc5).toString(16).padStart(8, '0');
    const tailHash = sampleHashOf(tail, 0x7f4a7c15).toString(16).padStart(8, '0');
    return `${total}:${headHash}:${tailHash}`;
  } catch {
    return '';
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* 关不掉也不影响指纹 */
      }
    }
  }
}

module.exports = {
  chapterContentHashOf,
  fingerprintFromBuffer
};