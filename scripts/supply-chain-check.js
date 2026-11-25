'use strict';
// 供应链闸门（WP15 / 审计 E1=O-N2，中 #18）：发版门禁与 e2e-weekly 共用的一步。
//
//   node scripts/supply-chain-check.js [--zip <zip>] [--cache <目录>] [--version <x.y.z>] [--shasums <清单>]
//
// 默认用仓库内置的官方 SHASUMS256.txt（build/electron/SHASUMS256.txt，来源与文件哈希见同目录
// SHASUMS256.provenance.json），核对 Electron 下载缓存里的 electron-v<版本>-win32-x64.zip；
// 不显式给 --zip 时（发版门禁路径）再核对打包实际消费的 node_modules/electron/dist 二进制与
// 该 zip 的 electron.exe 条目一致（CRC32 + 大小，TOOL-A02）。
// 只核对、不联网、不下载、不打包、不发版：
//   0 = 通过；1 = 校验未通过（被篡改 / 读不了 / 缓存里找不到 zip / dist 与 zip 不一致）；
//   2 = 用法或仓库状态问题（清单缺失 / 清单与本地 Electron 版本对不上 / 版本号坏）。
//
// 判定与哈希只复用 scripts/verify-electron-checksum.js + electron-checksum-logic.js，不复制第二份。
// README「构建供应链」一节与 .github/workflows/e2e-weekly.yml 用同一条命令（口径唯一）。
const fsp = require('node:fs/promises');
const path = require('node:path');
const logic = require('./electron-checksum-logic');
const verify = require('./verify-electron-checksum');

const ROOT = path.join(__dirname, '..');
const DEFAULT_SHASUMS = path.join(ROOT, 'build', 'electron', 'SHASUMS256.txt');
const USAGE = [
  '用法：node scripts/supply-chain-check.js [选项]',
  '',
  '  （无参数）        用仓库内置的官方清单核对下载缓存里的 Electron 二进制',
  '  --shasums <文件>  换一份官方 SHASUMS256.txt（默认 build/electron/SHASUMS256.txt）',
  '  --zip <文件>      直接指定要校验的压缩包（默认在下载缓存里按文件名找）',
  '  --cache <目录>    Electron 下载缓存目录（可重复）',
  '  --version <版本>  要校验的 Electron 版本（默认读 node_modules/electron）',
  '  --help            显示本说明',
  '',
  '只核对、不联网、不下载、不打包、不发版；退出码 0 = 通过，1 = 未通过，2 = 用法 / 仓库状态问题。',
  '发版门禁：打包前必须跑本命令，非 0 不得继续。'
].join('\n');

async function run(argv, io = {}) {
  const out = typeof io.stdout === 'function' ? io.stdout : console.log;
  const fail = typeof io.stderr === 'function' ? io.stderr : console.error;
  const root = typeof io.root === 'string' && io.root ? io.root : ROOT;
  const readText = typeof io.readFile === 'function' ? io.readFile : (file) => fsp.readFile(file, 'utf8');

  const opts = verify.parseArgs(argv);
  if (opts.help) {
    out(USAGE);
    return 0;
  }
  if (opts.error) {
    fail(`[供应链闸门] ${opts.error}`);
    fail(USAGE);
    return 2;
  }

  const shasumsPath = opts.shasums || DEFAULT_SHASUMS;
  let shasumsText;
  try {
    shasumsText = await readText(shasumsPath);
  } catch (err) {
    const reason = (err && (err.code || err.message)) || '未知错误';
    fail(`[供应链闸门] 读不了内置清单 ${shasumsPath}：${reason}`);
    fail('[供应链闸门] 官方清单应随仓库提供（build/electron/）；缺失或被改动时不得打包 / 发版。');
    return 2;
  }

  const version = logic.normalizeVersion(opts.version || (await verify.readLocalVersion(root, readText)));
  if (!version) {
    fail('[供应链闸门] 找不到本地 Electron 版本：先安装依赖，或用 --version 指定。');
    return 2;
  }
  let artifact;
  try {
    artifact = logic.artifactNameFor(version);
  } catch (err) {
    fail(`[供应链闸门] ${err.message}`);
    return 2;
  }

  const parsed = logic.parseShasums(shasumsText);
  // TOOL-A06（审计）：parseShasums 把认不出的行收进 invalid 并声明「如实回报」，但以前没有调用方消费。
  // 清单里出现无法解析的行 = 清单可能被动过 / 上游格式变了；不静默跳过，直接挡住打包与发版。
  if (parsed.invalid.length) {
    fail(
      `[供应链闸门] 内置清单有 ${parsed.invalid.length} 行无法解析（清单可能被动过）：` +
        parsed.invalid.slice(0, 3).join(' ｜ ')
    );
    return 2;
  }
  if (parsed.conflicts.length) {
    fail(`[供应链闸门] 清单自相矛盾（同名文件出现不同哈希）：${parsed.conflicts.join('、')}；清单不可信。`);
    return 2;
  }
  if (!parsed.entries.has(artifact)) {
    fail(
      `[供应链闸门] 内置清单里没有 ${artifact}：Electron 升级后必须重新从官方 release 取 SHASUMS256.txt ` +
        '入库（见 build/electron/SHASUMS256.provenance.json），再同步版本与本清单。'
    );
    return 2;
  }

  // 交给同一份校验 CLI（它的参数 / 退出码 / 文案就是对外契约），这里不再复制哈希与匹配逻辑。
  const args = ['--shasums', shasumsPath, '--version', version];
  if (opts.zip) args.push('--zip', opts.zip);
  for (const cache of opts.caches) args.push('--cache', cache);
  const code = await verify.run(args, io);
  if (code !== 0) {
    fail('[供应链闸门] 未通过：不得继续打包 / 发版（先按上面的提示定位清单或缓存 zip）。');
    return code;
  }

  // TOOL-A02（审计）：上面只证明「缓存 zip 是官方发布」，打包真正消费的是 node_modules/electron/dist
  // 里已解压的二进制。--zip 显式指定（排查单个文件）时只校验该文件；发版门禁（不带 --zip）必须
  // 再核对 dist 与这份 zip 是同一份内容，否则「zip 是好的、dist 被换了」会静默通过。
  if (!opts.zip) {
    const env = io.env && typeof io.env === 'object' ? io.env : process.env;
    const roots = opts.caches.length ? opts.caches : logic.defaultCacheRoots(env);
    const findArtifact = typeof io.findArtifact === 'function' ? io.findArtifact : logic.findArtifact;
    const verifyDist = typeof io.verifyDistAgainstZip === 'function' ? io.verifyDistAgainstZip : logic.verifyDistAgainstZip;
    const zipPath = await findArtifact(artifact, roots);
    const binaryName = process.platform === 'win32' ? 'electron.exe' : 'electron';
    const verdict = await verifyDist({
      zipPath,
      distFile: path.join(root, 'node_modules', 'electron', 'dist', binaryName)
    });
    if (!verdict || verdict.ok !== true) {
      fail(`[供应链闸门] 打包实际消费的 dist 与缓存 zip 不一致：${(verdict && verdict.message) || '未知原因'}`);
      fail('[供应链闸门] 先清缓存重新 pnpm install（让 dist 从已校验的 zip 重新解压），再跑本命令。');
      return 1;
    }
    out(`[供应链闸门] ${verdict.message}`);

    // CI-F1（2026-11-24 复核补审）：单文件核对只覆盖 electron.exe；打包会把 dist 整个目录带走，
    // resources / locales / *.pak / *.dll 被换掉时上面照样通过。发版路径再把「dist 全目录」与
    // 已校验 zip 的全部文件条目逐条比对：条目数不齐即红；每个文件比 size + CRC32 + SHA-256
    //（GATE-10：CRC32 不抗伪造，只当快速预筛，内容同一性由逐文件 SHA-256 兜底）。
    const verifyDistTree =
      typeof io.verifyDistTreeAgainstZip === 'function' ? io.verifyDistTreeAgainstZip : logic.verifyDistTreeAgainstZip;
    const treeVerdict = await verifyDistTree({
      zipPath,
      distDir: path.join(root, 'node_modules', 'electron', 'dist')
    });
    if (!treeVerdict || treeVerdict.ok !== true) {
      fail(`[供应链闸门] dist 全目录清单与缓存 zip 不一致：${(treeVerdict && treeVerdict.message) || '未知原因'}`);
      fail('[供应链闸门] 先清缓存重新 pnpm install（让 dist 从已校验的 zip 完整解压），再跑本命令。');
      return 1;
    }
    out(`[供应链闸门] ${treeVerdict.message}`);
  }
  out('[供应链闸门] 通过：Electron 二进制与内置官方清单一致；本命令不发版、不打包。');
  return 0;
}

if (require.main === module) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`[供应链闸门] 未预期错误：${error && error.message ? error.message : error}`);
      process.exitCode = 1;
    }
  );
}

module.exports = { run, USAGE, DEFAULT_SHASUMS };