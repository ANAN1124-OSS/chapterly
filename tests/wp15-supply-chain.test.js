// WP15 / 审计 E1=O-N2（中 #18）：构建供应链校验和入 CI 与发版门禁。
//
// 政策类（事实源写在断言旁）：官方 SHASUMS256.txt 入库、e2e-weekly 接线、README 发版门禁、
// package.json 的 predist / predist:dir 自动门禁（R7）—— 这些事实要打包 / CI 环境才观察得到，
// 本地 node --test 看不到。
// 行为类：scripts/supply-chain-check.js 的退出码 / 文案 / IO 失败注入（真临时文件，不联网、不下载）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const logic = require('../scripts/electron-checksum-logic');
const { buildZip } = require('../core/zip');
const tmpCleanup = require('./tmp-cleanup');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fss.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const readBytes = (rel) => fss.readFileSync(path.join(ROOT, rel));
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// 供应链接线脚本在红阶段尚不存在：集中在这里加载，让红输出能区分「脚本缺失」与「断言不成立」。
function supplyModule() {
  try {
    return require('../scripts/supply-chain-check');
  } catch (err) {
    assert.fail(`缺少 scripts/supply-chain-check.js：${err && err.message ? err.message : err}`);
  }
}

// TB-02：临时目录统一经 tests/tmp-cleanup.js 的 mkTmp（mkdtemp + 登记回收）。
const mkTmp = (prefix = 'cw-supply-chain-') => tmpCleanup.mkTmp(prefix);

function electronVersions() {
  const installed = JSON.parse(read('node_modules/electron/package.json')).version;
  const declared = JSON.parse(read('package.json')).devDependencies.electron;
  return { installed: logic.normalizeVersion(installed), declared: logic.normalizeVersion(declared) };
}

function collectIo() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    io: {
      root: ROOT,
      env: {},
      stdout: (line) => stdout.push(String(line)),
      stderr: (line) => stderr.push(String(line))
    }
  };
}

test('R1 官方 v45.1.0 清单入库：无坏行 / 无冲突 / 与本地版本对齐 / provenance 哈希可复核（政策类）', () => {
  const manifestRel = 'build/electron/SHASUMS256.txt';
  assert.ok(
    fss.existsSync(path.join(ROOT, manifestRel)),
    '官方 SHASUMS256.txt 必须随仓库入库（审计 E1：校验脚本不能再依赖手工 --shasums）'
  );
  const bytes = readBytes(manifestRel);
  const text = bytes.toString('utf8');
  assert.notEqual(bytes[0], 0xef, '清单必须逐字节保留官方原文件，不能是带 BOM 的另存版本');
  const parsed = logic.parseShasums(text);
  assert.deepEqual(parsed.invalid, [], '官方清单不应有认不出的行');
  assert.deepEqual(parsed.conflicts, [], '官方清单不应同名冲突');
  assert.ok(parsed.entries.size >= 60, `官方清单条目太少：${parsed.entries.size}`);
  for (const [name, hash] of parsed.entries) {
    assert.equal(name, path.basename(name), `清单里不该出现带目录的资产名：${name}`);
    assert.match(hash, /^[0-9a-f]{64}$/, `清单哈希不是 64 位十六进制：${name}`);
  }

  const { installed, declared } = electronVersions();
  assert.equal(declared, installed, 'package.json 声明的 Electron 版本要与 node_modules 实际安装一致');
  const artifact = logic.artifactNameFor(installed);
  assert.equal(
    parsed.entries.get(artifact),
    '55eaba17abff7b5bba6c3bbc85068967379024fe742fe9c7fdba9118922ccbe2',
    '入库清单必须是官方 v45.1.0 的 win32-x64 二进制哈希（升级 Electron 时同步换清单 / provenance / 本锚点）'
  );

  const provenanceRel = 'build/electron/SHASUMS256.provenance.json';
  assert.ok(fss.existsSync(path.join(ROOT, provenanceRel)), 'provenance 记录必须入库（来源 / 取回时间 / 文件哈希）');
  const provenance = JSON.parse(read(provenanceRel));
  assert.equal(provenance.version, installed, 'provenance 版本要与本地 Electron 一致');
  assert.equal(provenance.artifact, artifact, 'provenance 资产名要与本地版本一致');
  assert.equal(
    provenance.sourceUrl,
    `https://github.com/electron/electron/releases/download/v${installed}/SHASUMS256.txt`,
    'provenance 来源必须是官方 release'
  );
  assert.equal(provenance.sha256, sha256(bytes), 'provenance 记录的清单 SHA-256 与实际文件不一致（清单被改过？）');
  assert.equal(provenance.bytes, bytes.length, 'provenance 字节数要对得上');
  assert.equal(provenance.entries, parsed.entries.size, 'provenance 条目数要对得上');
  assert.match(String(provenance.fetchedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.match(String(provenance.note), /重新.*入库|升级/, 'provenance 要写清 Electron 升级后的重取流程');
});

test('R2 篡改缓存 zip → 非 0 拦截；正例 → 0（行为类）', async () => {
  const supply = supplyModule();
  const { installed } = electronVersions();
  const artifact = logic.artifactNameFor(installed);
  const dir = await mkTmp('cw-supply-tamper-');
  const zip = path.join(dir, artifact);
  await fs.writeFile(zip, '这不是官方 Electron 二进制，只是一个用来测校验的假文件');
  const { io, stdout, stderr } = collectIo();

  const bad = await supply.run(['--zip', zip], io);
  assert.equal(bad, 1, stderr.join('\n'));
  assert.ok(
    stderr.some((line) => line.includes('不一致') || line.includes('未通过')),
    `篡改的 zip 要报不一致：${stderr.join('\n')}`
  );
  assert.equal(
    stdout.some((line) => line.includes('通过')),
    false,
    '篡改的 zip 绝不能被打印成「通过」'
  );

  // 正例：临时清单记录伪 zip 的真实哈希（证明通过路径本身可用，不依赖 100+ MB 真实缓存）
  const goodHash = sha256(await fs.readFile(zip));
  const manifest = path.join(dir, 'SHASUMS256.txt');
  await fs.writeFile(manifest, `${goodHash}  ${artifact}\n`);
  stdout.length = 0;
  stderr.length = 0;
  const ok = await supply.run(['--shasums', manifest, '--zip', zip, '--version', installed], io);
  assert.equal(ok, 0, stderr.join('\n'));
  assert.ok(stdout.some((line) => line.includes('通过')), stdout.join('\n'));
  assert.ok(
    supply.DEFAULT_SHASUMS.endsWith(path.join('build', 'electron', 'SHASUMS256.txt')),
    '默认清单必须是仓库内置的官方文件'
  );
});

test('R3 清单缺失 / 版本漂移 / 空缓存 / 坏版本号 → 非 0 且文案可照做（行为类）', async () => {
  const supply = supplyModule();
  const { installed } = electronVersions();
  const dir = await mkTmp('cw-supply-missing-');
  const { io, stdout, stderr } = collectIo();

  const missing = await supply.run(['--shasums', path.join(dir, '没有这个清单.txt'), '--version', installed], io);
  assert.equal(missing, 2, stderr.join('\n'));
  assert.ok(stderr.some((line) => line.includes('读不了内置清单') && line.includes('ENOENT')), stderr.join('\n'));

  stdout.length = 0;
  stderr.length = 0;
  const drifted = await supply.run(['--version', '45.2.0'], io);
  assert.equal(drifted, 2, '清单没有的版本 = 升级后忘了重新入库，必须拦');
  assert.ok(
    stderr.some((line) => line.includes('内置清单里没有 electron-v45.2.0-win32-x64.zip')),
    stderr.join('\n')
  );
  assert.ok(stderr.some((line) => line.includes('重新') && line.includes('入库')), stderr.join('\n'));
  assert.equal(stdout.some((line) => line.includes('通过')), false);

  stdout.length = 0;
  stderr.length = 0;
  const emptyCache = await mkTmp('cw-supply-empty-cache-');
  const noZip = await supply.run(['--cache', emptyCache, '--version', installed], io);
  assert.equal(noZip, 1, '缓存里没有 zip 属于「校验没完成」，不能当通过');
  assert.ok(stderr.some((line) => line.includes('没找到')), stderr.join('\n'));

  stderr.length = 0;
  const badVersion = await supply.run(['--version', 'not-a-version'], io);
  assert.equal(badVersion, 2);
  assert.ok(stderr.some((line) => line.includes('版本号不合法')), stderr.join('\n'));
});

test('R4 极值 × IO 失败注入：目录冒充 zip / ENOSPC / 含空格中文路径 / 清单冲突（行为类）', async () => {
  const supply = supplyModule();
  const { installed } = electronVersions();
  const artifact = logic.artifactNameFor(installed);
  const dir = await mkTmp('cw-supply-io-');
  const { io, stdout, stderr } = collectIo();

  // 1) 目录冒充 zip：读目录必须非 0（Windows 上 createReadStream 读目录会 EISDIR；不许静默当通过）
  const fakeDir = path.join(dir, artifact);
  await fs.mkdir(fakeDir);
  const dirCode = await supply.run(['--zip', fakeDir, '--version', installed], io);
  assert.equal(dirCode, 1, stderr.join('\n'));
  assert.ok(stderr.some((line) => line.includes('EISDIR') || line.includes('读不了')), stderr.join('\n'));
  assert.equal(stdout.some((line) => line.includes('通过')), false);

  // 2) 清单读取失败注入 ENOSPC（磁盘满）：必须 2，不许进哈希比对
  stdout.length = 0;
  stderr.length = 0;
  const enospc = await supply.run([], {
    ...io,
    readFile: async () => {
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    }
  });
  assert.equal(enospc, 2);
  assert.ok(stderr.some((line) => line.includes('ENOSPC')), stderr.join('\n'));

  // 3) 含空格 + 中文目录：路径不许被误判，正例要能通过
  const spaced = path.join(dir, '含 空格 的目录');
  await fs.mkdir(spaced);
  const spacedZip = path.join(spaced, artifact);
  await fs.writeFile(spacedZip, 'fake zip bytes for spaced path');
  const spacedManifest = path.join(spaced, 'SHASUMS256.txt');
  await fs.writeFile(spacedManifest, `${sha256(await fs.readFile(spacedZip))}  ${artifact}\n`);
  stdout.length = 0;
  stderr.length = 0;
  const spacedCode = await supply.run(
    ['--shasums', spacedManifest, '--zip', spacedZip, '--version', installed],
    io
  );
  assert.equal(spacedCode, 0, stderr.join('\n'));
  assert.ok(stdout.some((line) => line.includes('通过')), stdout.join('\n'));

  // 4) 清单同名两行不同哈希：清单不可信，必须 2（不进入哈希比对）
  const conflictManifest = path.join(dir, 'SHASUMS-conflict.txt');
  await fs.writeFile(conflictManifest, `${'a'.repeat(64)}  ${artifact}\n${'b'.repeat(64)}  ${artifact}\n`);
  stdout.length = 0;
  stderr.length = 0;
  const conflict = await supply.run(['--shasums', conflictManifest, '--version', installed], io);
  assert.equal(conflict, 2);
  assert.ok(stderr.some((line) => line.includes('自相矛盾')), stderr.join('\n'));
});

test('R5 CI 接线：e2e-weekly 在安装后、E2E 前跑供应链检查，且仍下载真实二进制（政策类）', () => {
  const yml = read('.github/workflows/e2e-weekly.yml');
  const installAt = yml.indexOf('pnpm install --frozen-lockfile');
  const checkAt = yml.indexOf('node scripts/supply-chain-check.js');
  const e2eAt = yml.indexOf('pnpm run e2e');
  assert.ok(installAt > 0, 'e2e-weekly 仍要先安装依赖');
  assert.ok(checkAt > 0, 'e2e-weekly 必须调用供应链检查（审计 E1：不能只文档化）');
  assert.ok(e2eAt > 0, 'e2e-weekly 仍要跑全量 E2E');
  assert.ok(installAt < checkAt, '供应链检查必须在下载 Electron 二进制之后');
  assert.ok(checkAt < e2eAt, '供应链检查必须在跑 E2E 之前（坏二进制不该先跑半小时）');
  assert.ok(yml.includes('供应链校验'), '步骤名要能一眼看出是供应链校验');
  assert.equal(
    yml.includes('ELECTRON_SKIP_BINARY_DOWNLOAD'),
    false,
    'e2e-weekly 要真实 Electron 窗口，不能跳过二进制下载'
  );
  assert.equal(
    yml.includes('ELECTRON_SKIP_BINARY_DOWNLOAD'),
    false,
    'e2e-weekly 要真实 Electron 窗口，不能跳过二进制下载'
  );
  // GATE-05：verify.yml 与供应链检查是条件契约（不是「verify 永远不挂」）——
  // 带 Electron 二进制下载的 verify 必须跑校验；仍 ELECTRON_SKIP_BINARY_DOWNLOAD: 1 则不得挂。
  const verify = read('.github/workflows/verify.yml');
  assert.equal(verify.includes('ELECTRON_SKIP_BINARY_DOWNLOAD: 1'), true, '现状：verify.yml 仍跳过二进制下载');
  assert.equal(supplyChainPolicyOf(verify).ok, true, 'verify.yml 必须满足条件契约（跳过下载 → 不挂检查）');
});

// GATE-05：verify.yml 的供应链接线是**条件契约**：真实下载 Electron 二进制时，没跑
// supply-chain-check 就等于装了一份不校验的二进制；跳过下载时挂一个没有 zip 可校验的步骤只会
// 制造假红。判定收成一个纯函数，合成文本与现实文件都走同一份口径。
function supplyChainPolicyOf(text) {
  const skipsBinary = /ELECTRON_SKIP_BINARY_DOWNLOAD:\s*['"]?1['"]?/.test(text);
  const hasCheck = text.includes('supply-chain-check');
  return { skipsBinary, hasCheck, ok: skipsBinary ? !hasCheck : hasCheck };
}

test('GATE-05：verify.yml 供应链接线是条件契约（两种合成文本 + 现实文件）', () => {
  const skipOnly = 'env:\n  ELECTRON_SKIP_BINARY_DOWNLOAD: 1\nrun: npm test\n';
  assert.deepEqual(
    supplyChainPolicyOf(skipOnly),
    { skipsBinary: true, hasCheck: false, ok: true },
    '合成文本①：跳过下载且不挂检查 → 通过'
  );
  assert.equal(
    supplyChainPolicyOf(`${skipOnly}run: node scripts/supply-chain-check.js\n`).ok,
    false,
    '合成文本②：跳过下载却挂检查（没有 zip 可校验）→ 不通过'
  );
  const downloads = 'env:\n  FOO: 2\nrun: npm test\n';
  assert.deepEqual(
    supplyChainPolicyOf(`${downloads}run: node scripts/supply-chain-check.js\n`),
    { skipsBinary: false, hasCheck: true, ok: true },
    '合成文本③：下载二进制且有检查 → 通过'
  );
  assert.equal(
    supplyChainPolicyOf(downloads).ok,
    false,
    '合成文本④：下载二进制却漏了检查 → 不通过'
  );
  // 现实文件：与 R5 同一份判定
  const real = supplyChainPolicyOf(read('.github/workflows/verify.yml'));
  assert.equal(real.skipsBinary, true);
  assert.equal(real.ok, true);
});

test('R6 发版门禁接线 + 闸门不打包：维护者文档 / package.json / 源码（政策类）', () => {
  // M-N3（WP18）：打包 / 供应链细节从 README 拆到 docs/维护与自检.md（读者文档只留指针）。
  const docs = read('docs/维护与自检.md');
  const sectionStart = docs.indexOf('### 构建供应链（Electron 二进制）');
  assert.ok(sectionStart > 0, '维护者文档要有「构建供应链」小节');
  const after = docs.slice(sectionStart + 1);
  const nextH2 = after.indexOf('\n## ');
  const section = nextH2 >= 0 ? after.slice(0, nextH2) : after;
  assert.ok(section.includes('build/electron/SHASUMS256.txt'), '要写明官方清单的入库路径');
  assert.ok(section.includes('node scripts/supply-chain-check.js'), '要给出发版门禁可直接照抄的命令');
  assert.ok(section.includes('发版门禁'), '要说明这一步是发版门禁必做');
  assert.equal(section.includes('可选、离线'), false, '不能再把校验写成「可选」');
  assert.ok(section.includes('不联网'), '仍要说明不联网、不下载');
  assert.ok(section.includes('代码签名'), '仍要说明长期锚是代码签名（不在本 WP 扩范围）');

  const packStart = docs.indexOf('## 打包（开发者/维护用）');
  const strategyStart = docs.indexOf('\n## 开发与自检策略');
  assert.ok(packStart > 0 && strategyStart > packStart, '维护者文档的打包节结构不变');
  const packSection = docs.slice(packStart, strategyStart);
  assert.ok(packSection.includes('发版门禁'), '打包节要写发版门禁');
  assert.ok(packSection.includes('node scripts/supply-chain-check.js'), '打包前要给同一条命令');

  const readme = read('README.md');
  assert.ok(readme.includes('docs/维护与自检.md'), 'README 要指向维护者文档（M-N3）');
  assert.equal(readme.includes('### 构建供应链（Electron 二进制）'), false, 'README 不再承载供应链详情');

  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.dist, 'electron-builder --win nsis', 'dist 本体保持原样（门禁只是前置步骤）');
  assert.equal(pkg.scripts['dist:dir'], 'electron-builder --win dir', 'dist:dir 本体同理');

  const source = read('scripts/supply-chain-check.js');
  assert.equal(/\brequire\(['"]node:child_process['"]\)/.test(source), false, '闸门不许起子进程');
  assert.equal(/\bspawn\s*\(/.test(source), false, '闸门不许 spawn');
  assert.equal(source.includes('electron-builder'), false, '闸门绝不打包');
  assert.equal(/\brequire\(['"]node:https?['"]\)/.test(source), false, '闸门不许联网');
});

// R7（M-N3 复核缺口）：发版门禁不能只活在文档里——npm 生命周期 pre 脚本把校验接成打包前置门禁。
// 失败注入（静态）：predist / predist:dir 缺失、改名或指向 echo 等别的命令 → 下面两条精确相等断言直接红。
test('R8 TOOL-A02：发版门禁（不带 --zip）核对 dist 与缓存 zip 的 electron.exe 条目；dist 被换即非 0', async () => {
  const supply = supplyModule();
  const { installed } = electronVersions();
  const artifact = logic.artifactNameFor(installed);
  const binaryName = process.platform === 'win32' ? 'electron.exe' : 'electron';
  const payload = 'fake-electron-binary-for-dist-check';
  const zipBytes = await buildZip([
    { name: binaryName, data: payload },
    { name: 'version', data: installed }
  ]);
  const dir = await mkTmp('cw-supply-dist-');
  const cache = path.join(dir, 'cache');
  await fs.mkdir(cache, { recursive: true });
  await fs.writeFile(path.join(cache, artifact), zipBytes);
  const root = path.join(dir, 'root');
  const distDir = path.join(root, 'node_modules', 'electron', 'dist');
  await fs.mkdir(distDir, { recursive: true });
  const distFile = path.join(distDir, binaryName);
  await fs.writeFile(distFile, payload);
  // CI-F1 之后发版路径还核对 dist 全目录清单：假 zip 里有 version，dist 也要有，否则条目数对不上。
  await fs.writeFile(path.join(distDir, 'version'), installed);
  const manifest = path.join(dir, 'SHASUMS256.txt');
  await fs.writeFile(manifest, `${sha256(zipBytes)}  ${artifact}\n`);

  // 纯逻辑：读中央目录拿条目 CRC / 大小，与 dist 文件比对。
  const entry = await logic.readZipEntryMeta(path.join(cache, artifact), binaryName);
  assert.equal(entry.size, Buffer.byteLength(payload));
  assert.equal(entry.crc32, logic.crc32OfBuffer(Buffer.from(payload)));
  const unit = await logic.verifyDistAgainstZip({ zipPath: path.join(cache, artifact), distFile });
  assert.equal(unit.ok, true, unit.message);

  const { io, stdout, stderr } = collectIo();
  io.root = root;
  io.env = { ELECTRON_CACHE: cache };
  const ok = await supply.run(['--shasums', manifest, '--version', installed], io);
  assert.equal(ok, 0, stderr.join('\n'));
  assert.ok(stdout.some((line) => line.includes('内容一致')), stdout.join('\n'));
  assert.ok(stdout.some((line) => line.includes('全目录') || line.includes('逐条一致')), stdout.join('\n'));

  // CI-F1 集成负控：只改 dist 里的非 electron.exe 文件（version）—— 单文件判据看不出来，
  // dist 全目录判据必须拦住，且点名「全目录」不一致。
  await fs.writeFile(path.join(distDir, 'version'), 'not-the-installed-version');
  stdout.length = 0;
  stderr.length = 0;
  const treeBad = await supply.run(['--shasums', manifest, '--version', installed], io);
  assert.equal(treeBad, 1, stderr.join('\n'));
  assert.ok(
    stderr.some((line) => line.includes('全目录') && line.includes('不一致')),
    stderr.join('\n')
  );
  await fs.writeFile(path.join(distDir, 'version'), installed);

  // dist 被换（zip 仍是官方那份）：门禁必须拦住，且点名 dist 与 zip 不一致。
  await fs.writeFile(distFile, 'tampered-binary');
  stdout.length = 0;
  stderr.length = 0;
  const bad = await supply.run(['--shasums', manifest, '--version', installed], io);
  assert.equal(bad, 1, stderr.join('\n'));
  assert.ok(
    stderr.some((line) => line.includes('dist') && line.includes('不一致')),
    stderr.join('\n')
  );

  // dist 缺失：状态问题也要拦住（先重新安装依赖）。
  await fs.rm(distFile, { force: true });
  stderr.length = 0;
  const missing = await supply.run(['--shasums', manifest, '--version', installed], io);
  assert.equal(missing, 1, stderr.join('\n'));
  assert.ok(stderr.some((line) => line.includes('dist') && line.includes('不一致')), stderr.join('\n'));

  // 显式 --zip（排查单个文件）只校验该文件本身，不要求 dist 存在。
  const { io: io2, stderr: stderr2 } = collectIo();
  io2.root = root;
  io2.env = { ELECTRON_CACHE: cache };
  const explicit = await supply.run(
    ['--shasums', manifest, '--version', installed, '--zip', path.join(cache, artifact)],
    io2
  );
  assert.equal(explicit, 0, stderr2.join('\n'));
});

// CI-F1（2026-11-24 复核补审）：发版路径不只核 electron.exe —— dist 里每个文件都要与缓存 zip
// 的同名条目对上（条目数相等 + size + CRC32）。多 / 少 / 被改三条负控，全部走真临时 zip 与目录。
test('CI-F1：dist 全目录清单与 zip 逐条比对（全对通过，多 / 少 / 被改都红）', async () => {
  const payloads = [
    { name: 'electron.exe', data: 'fake-binary-for-tree' },
    { name: 'locales/en-US.pak', data: 'fake-pak' },
    { name: 'resources/default_app.asar', data: 'fake-asar' },
    { name: 'version', data: '45.1.0' }
  ];
  const zipBytes = await buildZip(payloads);
  const dir = await mkTmp('cw-supply-tree-');
  const zipPath = path.join(dir, 'electron-v45.1.0-win32-x64.zip');
  await fs.writeFile(zipPath, zipBytes);
  const distDir = path.join(dir, 'dist');
  for (const entry of payloads) {
    const full = path.join(distDir, entry.name);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, entry.data);
  }

  const ok = await logic.verifyDistTreeAgainstZip({ zipPath, distDir });
  assert.equal(ok.ok, true, ok.message);
  assert.equal(ok.files, 4, '四个文件全部核对');
  assert.match(ok.message, /4 个文件/);

  // 多：dist 里多一个 zip 没有的文件
  await fs.writeFile(path.join(distDir, 'extra.dll'), 'extra');
  const extra = await logic.verifyDistTreeAgainstZip({ zipPath, distDir });
  assert.equal(extra.ok, false);
  assert.equal(extra.code, 'DIST_TREE_MISMATCH');
  assert.match(extra.message, /dist 多出/);
  assert.match(extra.message, /extra\.dll/);
  await fs.rm(path.join(distDir, 'extra.dll'));

  // 少：dist 缺一个 zip 有的文件
  await fs.rm(path.join(distDir, 'version'));
  const missing = await logic.verifyDistTreeAgainstZip({ zipPath, distDir });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'DIST_TREE_MISMATCH');
  assert.match(missing.message, /dist 缺少/);
  assert.match(missing.message, /version/);
  await fs.writeFile(path.join(distDir, 'version'), '45.1.0');

  // 被改：大小不变、内容变了（CRC32 必须抓到）
  await fs.writeFile(path.join(distDir, 'locales', 'en-US.pak'), 'fake-PAK');
  const tampered = await logic.verifyDistTreeAgainstZip({ zipPath, distDir });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.code, 'DIST_CRC_MISMATCH');
  assert.match(tampered.message, /en-US\.pak/);
  await fs.writeFile(path.join(distDir, 'locales', 'en-US.pak'), 'fake-pak');

  // 修好 → 绿；不是 zip → ZIP_INVALID（不静默跳过）
  const fixed = await logic.verifyDistTreeAgainstZip({ zipPath, distDir });
  assert.equal(fixed.ok, true, fixed.message);
  const badZip = path.join(dir, 'not-a-zip.zip');
  await fs.writeFile(badZip, 'not a zip');
  const invalid = await logic.verifyDistTreeAgainstZip({ zipPath: badZip, distDir });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'ZIP_INVALID');
});

// R7（M-N3 复核缺口）：发版门禁不能只活在文档里——npm 生命周期 pre 脚本把校验接成打包前置门禁。
// 失败注入（静态）：predist / predist:dir 缺失、改名或指向 echo 等别的命令 → 下面两条精确相等断言直接红。
test('R7 发版门禁接成 npm 前置脚本：predist / predist:dir 指向 supply-chain-check（政策类）', () => {
  const pkg = JSON.parse(read('package.json'));
  const gate = 'node scripts/supply-chain-check.js';
  // npm / pnpm 都会在 `npm run dist` / `npm run dist:dir` 前自动执行对应的 pre 脚本；
  // 门禁非 0（清单缺失 / zip 被篡改 / 缓存里没有）时打包根本不会开始。
  assert.equal(pkg.scripts.predist, gate, 'npm run dist 前必须自动跑供应链校验');
  assert.equal(pkg.scripts['predist:dir'], gate, 'npm run dist:dir 前同样要跑（快速验证也要先核对二进制）');
  assert.match(pkg.scripts.predist, /^node scripts\/supply-chain-check\.js$/, 'pre 脚本只能指向闸门本体（不许 echo 糊弄）');
  assert.match(
    pkg.scripts['predist:dir'],
    /^node scripts\/supply-chain-check\.js$/,
    'dist:dir 的 pre 脚本同样只能指向闸门本体'
  );

  // 文档与 npm 生命周期同口径：不能再写「不在 dist 里自动执行」；显式命令仍保留供排查。
  const docs = read('docs/维护与自检.md');
  const sectionStart = docs.indexOf('### 构建供应链（Electron 二进制）');
  assert.ok(sectionStart > 0, '维护者文档要有「构建供应链」小节');
  const sectionEnd = docs.indexOf('\n## ', sectionStart + 1);
  const section = sectionEnd > sectionStart ? docs.slice(sectionStart, sectionEnd) : docs.slice(sectionStart);
  assert.ok(section.includes('predist'), '维护文档要写明 predist / predist:dir 自动门禁');
  assert.equal(
    section.includes('不在 `pnpm run dist` 里自动执行'),
    false,
    '不能再写「不在 pnpm run dist 里自动执行」（与 package.json 的 pre 门禁矛盾）'
  );
  assert.ok(section.includes(gate), '显式命令仍保留（排查时可单独跑）');
});
