'use strict';
// 构建供应链校验（v1.8.0 审计 ▲V308 / #36）：Electron 二进制校验的纯逻辑部分。
//
// 背景：本仓的 Electron 二进制从国内镜像下载（.npmrc 的 electron_mirror 与 package.json 的
// build.electronDownload.mirror 都指向 npmmirror），项目又没有代码签名 —— 构建机被投毒或镜像被
// 替换时，产物没有任何可验证来源。这里补上「可选、离线」的一步：作者从官方 release 手工拿到
// SHASUMS256.txt，脚本只对下载缓存里的 zip 算 SHA-256 并比对。
//
// 为什么不做成自动联网：CI / 内网 / GitHub 限流都会让构建多一个网络失败面；而且「从被投毒的镜像
// 那里下载清单」本身就是循环论证 —— 清单必须从官方渠道另取。代码签名才是长期锚，属成本决策。
//
// 本模块只做字符串 / 磁盘，不联网；CLI 在 scripts/verify-electron-checksum.js，两边共用这份口径。
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
// 官方 SHASUMS256.txt 每行 `<64 位十六进制><空白><*?><文件名>`；`*` 是 sha256sum 的二进制标记。
const SHASUM_LINE_RE = /^([0-9a-fA-F]{64})\s+\*?(.+)$/;
const MAX_SEARCH_DEPTH = 8;

function normalizeVersion(value) {
  return String(value == null ? '' : value).trim().replace(/^v/i, '');
}

// 官方发布资产名：electron-v<版本>-<平台>-<架构>.zip（发布包以 win32 / darwin / linux + x64 / arm64 命名）。
function artifactNameFor(version, { platform = 'win32', arch = 'x64' } = {}) {
  const normalized = normalizeVersion(version);
  if (!VERSION_RE.test(normalized)) throw new Error(`Electron 版本号不合法：${String(version)}`);
  const platformText = String(platform == null ? '' : platform).trim();
  const archText = String(arch == null ? '' : arch).trim();
  if (!platformText || !archText) throw new Error('platform / arch 不能为空');
  return `electron-v${normalized}-${platformText}-${archText}.zip`;
}

// 解析官方 SHASUMS256.txt：注释与空行忽略；认不出的行进 invalid（如实回报，不静默跳过）；
// 同名出现两份不同哈希进 conflicts（清单本身不可信，调用方必须拒绝）。
function parseShasums(text) {
  const entries = new Map();
  const invalid = [];
  const conflicts = [];
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = SHASUM_LINE_RE.exec(line);
    if (!match) {
      invalid.push(line);
      continue;
    }
    const name = path.basename(match[2].trim());
    const hash = match[1].toLowerCase();
    if (!name) {
      invalid.push(line);
      continue;
    }
    if (entries.has(name)) {
      if (entries.get(name) !== hash && !conflicts.includes(name)) conflicts.push(name);
      continue;
    }
    entries.set(name, hash);
  }
  return { entries, invalid, conflicts };
}

// 逐块算 SHA-256（zip 可达上百 MB，不整份读进内存）。
function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => {
      hash.update(chunk);
    });
    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });
  });
}

// @electron/get 的默认下载缓存（可用环境变量覆盖）：按文件名找，不读 zip 内容。
function defaultCacheRoots(env = process.env) {
  const roots = [];
  const add = (value) => {
    const text = String(value == null ? '' : value).trim();
    if (text && !roots.includes(text)) roots.push(text);
  };
  add(env.ELECTRON_CACHE);
  add(env.electron_config_cache);
  add(env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'electron', 'Cache') : '');
  add(env.HOME ? path.join(env.HOME, '.cache', 'electron') : '');
  add(env.USERPROFILE ? path.join(env.USERPROFILE, '.cache', 'electron') : '');
  return roots;
}

async function findInDir(dir, name, depth) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null; // 目录不存在 / 读不了：当作没找到（缓存目录在首次下载前本来就可能不存在）
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === name) return path.join(dir, entry.name);
  }
  if (depth <= 1) return null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findInDir(path.join(dir, entry.name), name, depth - 1);
    if (found) return found;
  }
  return null;
}

async function findArtifact(name, roots, { maxDepth = 4 } = {}) {
  const fileName = path.basename(String(name == null ? '' : name));
  if (!fileName) return null;
  const depth = Math.max(1, Math.min(MAX_SEARCH_DEPTH, Math.round(Number(maxDepth)) || 4));
  for (const root of Array.isArray(roots) ? roots : []) {
    const text = String(root == null ? '' : root).trim();
    if (!text) continue;
    const found = await findInDir(text, fileName, depth);
    if (found) return found;
  }
  return null;
}

// 核对一份 zip：条目必须存在且唯一；哈希由 hashFile 注入（单测不需要真读大文件）。
async function verifyArtifact({ zipPath, shasumsText, hashFile = sha256OfFile } = {}) {
  const zip = String(zipPath == null ? '' : zipPath).trim();
  if (!zip) return { ok: false, code: 'NO_ARTIFACT', message: '没有给出要校验的 Electron 压缩包' };
  const name = path.basename(zip);
  const parsed = parseShasums(shasumsText);
  if (parsed.conflicts.includes(name)) {
    return {
      ok: false,
      code: 'SHASUMS_CONFLICT',
      message: `SHASUMS256.txt 里 ${name} 出现互相矛盾的哈希，清单不可信`
    };
  }
  const expected = parsed.entries.get(name);
  if (!expected) {
    return {
      ok: false,
      code: 'NO_ENTRY',
      message: `SHASUMS256.txt 里没有 ${name}（清单与本地版本 / 平台 / 架构对不上）`
    };
  }
  let actual;
  try {
    actual = String(await hashFile(zip)).toLowerCase();
  } catch (err) {
    const reason = (err && (err.code || err.message)) || '未知错误';
    return { ok: false, code: 'READ_FAILED', message: `读不了 ${name}：${reason}` };
  }
  if (actual !== expected) {
    return {
      ok: false,
      code: 'CHECKSUM_MISMATCH',
      expected,
      actual,
      message: `${name} 的 SHA-256 与官方清单不一致（期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`
    };
  }
  return {
    ok: true,
    code: 'OK',
    expected,
    actual,
    message: `${name} 与官方 SHASUMS256.txt 的 SHA-256 一致`
  };
}

// TOOL-A02（审计）：上面的校验只证明「缓存里的 zip 是官方发布」，但打包实际消费的是
// node_modules/electron/dist/ 里已经解压出来的二进制。如果解压被中断 / 被杀软替换 / 被别的
// 工具改写，zip 校验照样通过，打包却用了另一份 electron.exe。这里从 zip 的**中央目录**读出
// electron.exe 条目的 CRC32 与未压缩大小（不解压整包），再对 dist 里的文件流式算 CRC32 比对。
// 不解压的代价是没法逐字节内容比对，但 CRC32 + 大小足以发现「不是从这份 zip 解出来的」。
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_MAX_COMMENT = 0xffff;
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

// 流式 CRC32（与 zip 中央目录里的 CRC-32 同口径）。Node 22.2+ 有 zlib.crc32 就直接用，
// 更老的 22.x 退回查表实现（项目 engines 是 >=22，不能假定一定有内置实现）。
function crc32Update(value, chunk) {
  const zlib = require('node:zlib');
  if (typeof zlib.crc32 === 'function') return zlib.crc32(chunk, value) >>> 0;
  let crc = (value ^ -1) >>> 0;
  for (let i = 0; i < chunk.length; i += 1) crc = CRC_TABLE[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function crc32OfBuffer(buffer) {
  return crc32Update(0, buffer);
}

// 从 zip 中央目录读出全部条目：name → { crc32, size }（目录条目以 '/' 结尾，保留在结果里，
// 由调用方决定是否忽略）。readZipEntryMeta 与 CI-F1 的 dist 全目录核对共用这一份解析。
async function readCentralEntries(zipPath) {
  const handle = await fsp.open(zipPath, 'r');
  try {
    const stat = await handle.stat();
    const tailSize = Math.min(stat.size, EOCD_SIGNATURE + ZIP_MAX_COMMENT + 4);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, stat.size - tailSize);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === EOCD_SIGNATURE) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) {
      throw Object.assign(new Error('不是有效的 zip（找不到中央目录结束记录）'), { code: 'ZIP_INVALID' });
    }
    const entries = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (!entries || cdSize <= 0 || cdOffset + cdSize > stat.size) {
      throw Object.assign(new Error('zip 中央目录缺失或越界'), { code: 'ZIP_INVALID' });
    }
    const cd = Buffer.alloc(cdSize);
    await handle.read(cd, 0, cdSize, cdOffset);
    const out = new Map();
    let at = 0;
    for (let index = 0; index < entries && at + 46 <= cd.length; index += 1) {
      if (cd.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
        throw Object.assign(new Error('zip 中央目录条目损坏'), { code: 'ZIP_INVALID' });
      }
      const crc = cd.readUInt32LE(at + 16);
      const uncompressed = cd.readUInt32LE(at + 24);
      const nameLen = cd.readUInt16LE(at + 28);
      const extraLen = cd.readUInt16LE(at + 30);
      const commentLen = cd.readUInt16LE(at + 32);
      const name = cd.slice(at + 46, at + 46 + nameLen).toString('utf8');
      if (!out.has(name)) out.set(name, { crc32: crc >>> 0, size: uncompressed });
      at += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    await handle.close();
  }
}

// 从 zip 中央目录读一个条目的 { crc32, size }。找不到返回 null；不是 zip / 条目损坏抛带 code 的错误。
async function readZipEntryMeta(zipPath, entryName) {
  const wanted = String(entryName).replace(/\\/g, '/');
  const entries = await readCentralEntries(zipPath);
  const found = entries.get(wanted);
  return found ? { crc32: found.crc32, size: found.size } : null;
}

async function crc32OfFile(filePath) {
  return new Promise((resolve, reject) => {
    let crc = 0;
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => {
      crc = crc32Update(crc, chunk);
    });
    stream.on('end', () => {
      resolve(crc >>> 0);
    });
  });
}

// 核对「打包实际消费的 dist 二进制」与缓存 zip 里的同名条目是否同一份内容。
// 注入点（单测用）：statFile / crc32File / readEntryMeta。
async function verifyDistAgainstZip({
  zipPath,
  distFile,
  entryName = 'electron.exe',
  statFile = (file) => fsp.stat(file),
  crc32File = crc32OfFile,
  readEntryMeta = readZipEntryMeta
} = {}) {
  const zip = String(zipPath == null ? '' : zipPath).trim();
  const dist = String(distFile == null ? '' : distFile).trim();
  if (!zip) return { ok: false, code: 'NO_ARTIFACT', message: '没有给出缓存 zip 路径' };
  if (!dist) return { ok: false, code: 'DIST_MISSING', message: '没有给出 dist 二进制路径' };
  let size = null;
  try {
    const stat = await statFile(dist);
    size = Number(stat && stat.size);
  } catch (err) {
    const reason = (err && (err.code || err.message)) || '未知错误';
    return { ok: false, code: 'DIST_MISSING', message: `找不到打包要用的 ${path.basename(dist)}（${reason}）：先重新安装依赖` };
  }
  let entry;
  try {
    entry = await readEntryMeta(zip, entryName);
  } catch (err) {
    const reason = (err && (err.code || err.message)) || '未知错误';
    return { ok: false, code: 'ZIP_INVALID', message: `读不了缓存 zip 的中央目录（${reason}）` };
  }
  if (!entry) {
    return { ok: false, code: 'ZIP_ENTRY_MISSING', message: `缓存 zip 里没有 ${entryName}` };
  }
  if (entry.size !== size) {
    return {
      ok: false,
      code: 'DIST_SIZE_MISMATCH',
      message:
        `${path.basename(dist)} 大小 ${size} 与 zip 条目 ${entryName} 的 ${entry.size} 不一致：` +
        'dist 不是从这份已校验的 zip 解出来的'
    };
  }
  let actual;
  try {
    actual = await crc32File(dist);
  } catch (err) {
    const reason = (err && (err.code || err.message)) || '未知错误';
    return { ok: false, code: 'DIST_READ_FAILED', message: `读不了 ${path.basename(dist)}：${reason}` };
  }
  if ((actual >>> 0) !== (entry.crc32 >>> 0)) {
    return {
      ok: false,
      code: 'DIST_CRC_MISMATCH',
      message:
        `${path.basename(dist)} 的 CRC32 与 zip 条目 ${entryName} 不一致` +
        `（期望 ${(entry.crc32 >>> 0).toString(16)}，实际 ${(actual >>> 0).toString(16)}）：dist 可能被替换 / 解压不完整`
    };
  }
  return {
    ok: true,
    code: 'OK',
    size,
    crc32: actual >>> 0,
    message: `${path.basename(dist)} 与缓存 zip 的 ${entryName} 内容一致（CRC32 + 大小）`
  };
}

// CI-F1（2026-11-24 复核补审）：上面的单文件核对只保证 electron.exe 没被换 —— dist 里的
// resources / locales / icudtl.dat 等其余文件（打包同样会带走）不在核对范围。发版路径再补一层
// 「dist 全目录 == zip 全部文件条目」：条目数不齐即红；每个文件比 size + CRC32。仍然不解压、
// 不联网，数据只来自已通过 SHA-256 校验的那份 zip。
//
// 列出 dist 下全部普通文件（相对路径统一用 '/'，排序后返回）。目录递归；符号链接等非普通文件
// 跳过（zip 里不会有，防跟随链接读到库外）。
async function listDistFiles(distDir, { readdir = (dir) => fsp.readdir(dir, { withFileTypes: true }) } = {}) {
  const out = [];
  const walk = async (dir, prefix) => {
    const entries = await readdir(dir);
    for (const entry of entries) {
      const name = entry.name;
      const rel = prefix ? `${prefix}/${name}` : name;
      if (entry.isDirectory()) await walk(path.join(dir, name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  await walk(String(distDir), '');
  out.sort();
  return out;
}

async function verifyDistTreeAgainstZip({
  zipPath,
  distDir,
  listFiles = listDistFiles,
  statFile = (file) => fsp.stat(file),
  crc32File = crc32OfFile,
  readEntries = readCentralEntries
} = {}) {
  const zip = String(zipPath == null ? '' : zipPath).trim();
  const dist = String(distDir == null ? '' : distDir).trim();
  if (!zip) return { ok: false, code: 'NO_ARTIFACT', message: '没有给出缓存 zip 路径' };
  if (!dist) return { ok: false, code: 'DIST_MISSING', message: '没有给出 dist 目录' };
  let entries;
  try {
    entries = await readEntries(zip);
  } catch (err) {
    const reason = (err && (err.code || err.message)) || '未知错误';
    return { ok: false, code: 'ZIP_INVALID', message: `读不了缓存 zip 的中央目录（${reason}）` };
  }
  const zipFiles = new Map();
  for (const [name, meta] of entries) {
    if (!name.endsWith('/')) zipFiles.set(name, meta); // 目录条目不算文件
  }
  let files;
  try {
    files = await listFiles(dist);
  } catch (err) {
    const reason = (err && (err.code || err.message)) || '未知错误';
    return { ok: false, code: 'DIST_MISSING', message: `读不了打包要用的 dist 目录（${reason}）：先重新安装依赖` };
  }
  if (!files.length) {
    return { ok: false, code: 'DIST_MISSING', message: 'dist 目录里一个文件都没有：解压失败，先重新安装依赖' };
  }
  const distFiles = new Set(files);
  const onlyDist = files.filter((name) => !zipFiles.has(name));
  const onlyZip = Array.from(zipFiles.keys()).filter((name) => !distFiles.has(name));
  if (onlyDist.length || onlyZip.length) {
    const sample = (list, label) =>
      `${label}：${list.slice(0, 5).join('、')}${list.length > 5 ? ` 等 ${list.length} 个` : ''}`;
    const parts = [];
    if (onlyDist.length) parts.push(sample(onlyDist, 'dist 多出'));
    if (onlyZip.length) parts.push(sample(onlyZip, 'dist 缺少'));
    return {
      ok: false,
      code: 'DIST_TREE_MISMATCH',
      message:
        `dist 的 ${files.length} 个文件与缓存 zip 的 ${zipFiles.size} 个文件条目对不上（${parts.join('；')}）：` +
        'dist 不是从这份已校验的 zip 完整解出来的',
      onlyDist,
      onlyZip
    };
  }
  for (const name of files) {
    const full = path.join(dist, name);
    const entry = zipFiles.get(name);
    let size = null;
    try {
      const stat = await statFile(full);
      size = Number(stat && stat.size);
    } catch (err) {
      const reason = (err && (err.code || err.message)) || '未知错误';
      return { ok: false, code: 'DIST_READ_FAILED', message: `读不了 dist 里的 ${name}（${reason}）` };
    }
    if (size !== entry.size) {
      return {
        ok: false,
        code: 'DIST_SIZE_MISMATCH',
        message: `dist 里的 ${name} 大小 ${size} 与 zip 条目的 ${entry.size} 不一致：dist 不是从这份已校验的 zip 解出来的`
      };
    }
    let actual;
    try {
      actual = await crc32File(full);
    } catch (err) {
      const reason = (err && (err.code || err.message)) || '未知错误';
      return { ok: false, code: 'DIST_READ_FAILED', message: `读不了 dist 里的 ${name}（${reason}）` };
    }
    if ((actual >>> 0) !== (entry.crc32 >>> 0)) {
      return {
        ok: false,
        code: 'DIST_CRC_MISMATCH',
        message:
          `dist 里的 ${name} 的 CRC32 与 zip 条目不一致` +
          `（期望 ${(entry.crc32 >>> 0).toString(16)}，实际 ${(actual >>> 0).toString(16)}）：文件被替换 / 解压不完整`
      };
    }
  }
  return {
    ok: true,
    code: 'OK',
    files: files.length,
    message: `dist 的 ${files.length} 个文件与缓存 zip 逐条一致（条目数相等，size + CRC32）`
  };
}

// 把「镜像从哪来」如实列出来：镜像只是加速，不是来源证明（README 构建供应链一节同口径）。
function mirrorSources({ npmrcText = '', packageJson = null } = {}) {
  const sources = [];
  const match = /^[ \t]*electron_mirror[ \t]*=[ \t]*(\S+)/m.exec(String(npmrcText == null ? '' : npmrcText));
  if (match) sources.push({ where: '.npmrc electron_mirror', url: match[1] });
  const buildMirror =
    packageJson && packageJson.build && packageJson.build.electronDownload
      ? packageJson.build.electronDownload.mirror
      : '';
  if (typeof buildMirror === 'string' && buildMirror.trim()) {
    sources.push({ where: 'package.json build.electronDownload.mirror', url: buildMirror.trim() });
  }
  return sources;
}

module.exports = {
  VERSION_RE,
  SHASUM_LINE_RE,
  normalizeVersion,
  artifactNameFor,
  parseShasums,
  sha256OfFile,
  defaultCacheRoots,
  findArtifact,
  verifyArtifact,
  crc32OfBuffer,
  readZipEntryMeta,
  readCentralEntries,
  crc32OfFile,
  verifyDistAgainstZip,
  listDistFiles,
  verifyDistTreeAgainstZip,
  mirrorSources
};