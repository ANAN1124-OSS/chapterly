'use strict';
// 可选的构建供应链校验 CLI（v1.8.0 审计 ▲V308 / #36）。
//
//   node scripts/verify-electron-checksum.js --shasums <SHASUMS256.txt>
//
// 只做离线核对：从官方 release 手动下载与所装版本一致的 SHASUMS256.txt，再对下载缓存里的
// electron-v<版本>-<平台>-<架构>.zip 算 SHA-256 比对。**不联网、不自动下载**，也不进
// `pnpm run dist`（离线 / CI 构建不该多一个网络失败面）。判定逻辑在
// scripts/electron-checksum-logic.js（纯逻辑，单测直接驱动）。
const fsp = require('node:fs/promises');
const path = require('node:path');
const logic = require('./electron-checksum-logic');

const ROOT = path.join(__dirname, '..');
const USAGE = [
  '用法：node scripts/verify-electron-checksum.js --shasums <SHASUMS256.txt> [--zip <zip>] [--version <x.y.z>] [--cache <目录>]',
  '',
  '  --shasums <文件>  官方 SHASUMS256.txt（离线：从官方 release 手动下载）',
  '  --zip <文件>      已下载的 electron-v<版本>-<平台>-<架构>.zip；缺省在下载缓存目录里按文件名找',
  '  --version <版本>  要校验的版本；缺省读 node_modules/electron/package.json（再退回 package.json）',
  '  --cache <目录>    Electron 下载缓存目录（可重复；缺省用 ELECTRON_CACHE / %LOCALAPPDATA%\\electron\\Cache 等）',
  '  --help            显示本说明',
  '',
  '官方清单地址：https://github.com/electron/electron/releases/download/v<版本>/SHASUMS256.txt',
  '说明：只核对下载缓存里的官方 zip，不联网、不自动下载；不一致时退出码为 1，不要继续打包。'
].join('\n');

function parseArgs(argv) {
  const opts = { shasums: '', zip: '', version: '', caches: [], help: false, error: '' };
  const args = Array.isArray(argv) ? argv.slice() : [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const key = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : null;
    const take = () => {
      if (inline != null) return inline;
      index += 1;
      return index < args.length ? String(args[index]) : '';
    };
    if (key === '--shasums') opts.shasums = take();
    else if (key === '--zip') opts.zip = take();
    else if (key === '--version') opts.version = take();
    else if (key === '--cache') {
      const dir = take();
      if (dir) opts.caches.push(dir);
    } else {
      opts.error = `不认识的参数：${arg}`;
      break;
    }
  }
  return opts;
}

// 本地 Electron 版本：优先已安装的 electron 包（真正的二进制版本），再看 package.json 的精确版本。
async function readLocalVersion(root, readText) {
  const candidates = [
    { file: path.join(root, 'node_modules', 'electron', 'package.json'), pick: (data) => data && data.version },
    {
      file: path.join(root, 'package.json'),
      pick: (data) => data && data.devDependencies && data.devDependencies.electron
    }
  ];
  for (const candidate of candidates) {
    try {
      const data = JSON.parse(await readText(candidate.file));
      const version = logic.normalizeVersion(candidate.pick(data));
      if (version) return version;
    } catch {
      /* 文件不存在 / 不是 JSON：继续试下一个来源 */
    }
  }
  return '';
}

async function readMirrorSources(root, readText) {
  let npmrcText = '';
  let packageJson = null;
  try {
    npmrcText = await readText(path.join(root, '.npmrc'));
  } catch {
    npmrcText = '';
  }
  try {
    packageJson = JSON.parse(await readText(path.join(root, 'package.json')));
  } catch {
    packageJson = null;
  }
  return logic.mirrorSources({ npmrcText, packageJson });
}

// 返回值 = 退出码：0 一致；1 校验未通过 / 找不到压缩包；2 用法或输入问题。
async function run(argv, io = {}) {
  const out = typeof io.stdout === 'function' ? io.stdout : console.log;
  const fail = typeof io.stderr === 'function' ? io.stderr : console.error;
  const root = typeof io.root === 'string' && io.root ? io.root : ROOT;
  const env = io.env && typeof io.env === 'object' ? io.env : process.env;
  const readText = typeof io.readFile === 'function' ? io.readFile : (file) => fsp.readFile(file, 'utf8');
  const findArtifact = typeof io.findArtifact === 'function' ? io.findArtifact : logic.findArtifact;
  const verifyArtifact = typeof io.verifyArtifact === 'function' ? io.verifyArtifact : logic.verifyArtifact;

  const opts = parseArgs(argv);
  if (opts.help) {
    out(USAGE);
    return 0;
  }
  if (opts.error) {
    fail(`[构建校验] ${opts.error}`);
    fail(USAGE);
    return 2;
  }
  if (!opts.shasums) {
    fail('[构建校验] 缺 --shasums <SHASUMS256.txt>：脚本不联网，请先从官方 release 下载清单。');
    fail(USAGE);
    return 2;
  }

  const version = logic.normalizeVersion(opts.version || (await readLocalVersion(root, readText)));
  if (!version) {
    fail('[构建校验] 找不到本地 Electron 版本：先 pnpm install，或用 --version 指定。');
    return 2;
  }
  let artifactName;
  try {
    artifactName = logic.artifactNameFor(version);
  } catch (err) {
    fail(`[构建校验] ${err.message}`);
    return 2;
  }

  let shasumsText;
  try {
    shasumsText = await readText(opts.shasums);
  } catch (err) {
    fail(
      `[构建校验] 读不了清单 ${opts.shasums}：${(err && (err.code || err.message)) || '未知错误'}`
    );
    return 2;
  }

  const sources = await readMirrorSources(root, readText);
  out(`[构建校验] Electron v${version}（${artifactName}）`);
  for (const source of sources) out(`[构建校验] 下载镜像：${source.where} → ${source.url}（镜像只加速，不是来源证明）`);
  out('[构建校验] 只核对你手工提供的官方 SHASUMS256.txt：不联网、不下载。');

  let zipPath = opts.zip;
  if (!zipPath) {
    const roots = opts.caches.length ? opts.caches : logic.defaultCacheRoots(env);
    out(`[构建校验] 在下载缓存里找 ${artifactName}：${roots.length ? roots.join('；') : '（没有可用的缓存目录）'}`);
    zipPath = await findArtifact(artifactName, roots);
  }
  if (!zipPath) {
    fail(`[构建校验] 没找到 ${artifactName}：用 --zip 指定压缩包，或先跑一次 pnpm install 让镜像真正下载。`);
    return 1;
  }

  const result = await verifyArtifact({ zipPath, shasumsText });
  if (result.ok) {
    out(`[构建校验] OK：${result.message}`);
    return 0;
  }
  fail(`[构建校验] 未通过：${result.message}`);
  if (result.code === 'CHECKSUM_MISMATCH') {
    fail('[构建校验] 这说明下载缓存里的 zip 与官方发布不一致：不要用它打包，先清缓存重新下载。');
  }
  return 1;
}

if (require.main === module) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`[构建校验] 未预期错误：${error && error.message ? error.message : error}`);
      process.exitCode = 1;
    }
  );
}

module.exports = { parseArgs, run, USAGE };