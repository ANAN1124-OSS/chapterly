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
  mirrorSources
};