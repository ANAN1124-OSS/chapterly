// 审计修复 #36（▲V308）：构建供应链校验。项目从国内镜像下载 Electron、产物又没有代码签名，
// 这里补上「可选、离线」的官方 SHASUMS256.txt 核对步骤；单测覆盖纯逻辑 / CLI / 文档锚点。
//
// 不联网、不真下载：所有哈希都用注入的 hashFile，缓存目录用临时目录搭出 @electron/get 的布局。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const logic = require('../scripts/electron-checksum-logic');
const cli = require('../scripts/verify-electron-checksum');

const tmpCleanup = require('./tmp-cleanup');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fss.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// TB-02：临时目录统一经 tests/tmp-cleanup.js 的 mkTmp（mkdtemp + 登记回收）。
const mkTmp = (prefix = 'cw-electron-checksum-') => tmpCleanup.mkTmp(prefix);

test('parseShasums：认官方清单格式（两空格 / * 标记 / CRLF），坏行与同名冲突如实登记', () => {
  const text = [
    '# 注释行',
    '',
    `${'A'.repeat(64)}  electron-v45.1.0-win32-x64.zip`,
    `${'b'.repeat(64)} *electron-v45.1.0-darwin-arm64.zip`,
    'not-a-checksum electron-v45.1.0-linux-x64.zip',
    `${'c'.repeat(64)}  electron-v45.1.0-win32-x64.zip`
  ].join('\r\n');
  const parsed = logic.parseShasums(text);
  assert.equal(parsed.entries.get('electron-v45.1.0-win32-x64.zip'), 'a'.repeat(64), '十六进制统一小写');
  assert.equal(parsed.entries.get('electron-v45.1.0-darwin-arm64.zip'), 'b'.repeat(64), '* 标记要能认');
  assert.deepEqual(parsed.invalid, ['not-a-checksum electron-v45.1.0-linux-x64.zip'], '认不出的行不静默跳过');
  assert.deepEqual(parsed.conflicts, ['electron-v45.1.0-win32-x64.zip'], '同名两份不同哈希 = 清单不可信');
  // 同名同哈希重复（不同清单拼接）不算冲突
  const same = `${'d'.repeat(64)}  x.zip\n${'d'.repeat(64)}  x.zip`;
  assert.deepEqual(logic.parseShasums(same).conflicts, []);
  // 路径里的目录只取文件名（清单里一般没有目录，但别让 `dir/x.zip` 绕过匹配）
  assert.equal(logic.parseShasums(`${'e'.repeat(64)}  sub/x.zip`).entries.get('x.zip'), 'e'.repeat(64));
});

test('artifactNameFor：官方资产名按版本 / 平台 / 架构生成，坏版本直接拒绝', () => {
  assert.equal(logic.artifactNameFor('45.1.0'), 'electron-v45.1.0-win32-x64.zip');
  assert.equal(logic.artifactNameFor('v45.1.0'), 'electron-v45.1.0-win32-x64.zip', '前导 v 归一');
  assert.equal(
    logic.artifactNameFor('45.1.0', { platform: 'darwin', arch: 'arm64' }),
    'electron-v45.1.0-darwin-arm64.zip'
  );
  assert.throws(() => logic.artifactNameFor('45.1'), /版本号不合法/);
  assert.throws(() => logic.artifactNameFor(''), /版本号不合法/);
  assert.throws(() => logic.artifactNameFor('45.1.0', { platform: '', arch: 'x64' }), /不能为空/);
});

test('sha256OfFile：真实读盘逐块哈希（与一次性哈希一致）', async () => {
  const dir = await mkTmp();
  const file = path.join(dir, 'blob.bin');
  const bytes = crypto.randomBytes(3 * 1024 * 1024 + 7);
  await fs.writeFile(file, bytes);
  assert.equal(await logic.sha256OfFile(file), crypto.createHash('sha256').update(bytes).digest('hex'));
});

test('verifyArtifact：一致 / 不一致 / 无条目 / 冲突 / 读失败 / 没给压缩包 六种结论', async () => {
  const name = 'electron-v45.1.0-win32-x64.zip';
  const good = sha256('download');
  const shasumsText = `${good}  ${name}`;
  const matched = await logic.verifyArtifact({
    zipPath: path.join('D:\\cache', name),
    shasumsText,
    hashFile: async () => good
  });
  assert.equal(matched.ok, true);
  assert.equal(matched.code, 'OK');

  const mismatched = await logic.verifyArtifact({
    zipPath: path.join('D:\\cache', name),
    shasumsText,
    hashFile: async () => 'f'.repeat(64)
  });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.code, 'CHECKSUM_MISMATCH');
  assert.equal(mismatched.expected, good);
  assert.match(mismatched.message, /与官方清单不一致/);

  const otherVersion = await logic.verifyArtifact({
    zipPath: path.join('D:\\cache', 'electron-v45.2.0-win32-x64.zip'),
    shasumsText,
    hashFile: async () => good
  });
  assert.equal(otherVersion.code, 'NO_ENTRY');

  const conflicted = await logic.verifyArtifact({
    zipPath: path.join('D:\\cache', name),
    shasumsText: `${good}  ${name}\n${'f'.repeat(64)}  ${name}`,
    hashFile: async () => good
  });
  assert.equal(conflicted.code, 'SHASUMS_CONFLICT');

  const unreadable = await logic.verifyArtifact({
    zipPath: path.join('D:\\cache', name),
    shasumsText,
    hashFile: async () => {
      throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
    }
  });
  assert.equal(unreadable.code, 'READ_FAILED');
  assert.match(unreadable.message, /ENOENT/);

  assert.equal((await logic.verifyArtifact({ zipPath: '', shasumsText })).code, 'NO_ARTIFACT');
});

test('findArtifact：按 @electron/get 的「哈希目录 / 文件名」布局下探查找，深度与坏目录都安全', async () => {
  const dir = await mkTmp();
  const name = 'electron-v45.1.0-win32-x64.zip';
  const nested = path.join(dir, 'b3a2c1', 'cache', 'deep');
  await fs.mkdir(nested, { recursive: true });
  const zip = path.join(nested, name);
  await fs.writeFile(zip, 'fake zip');
  assert.equal(await logic.findArtifact(name, [dir]), zip, '默认深度 4 能找到哈希目录里的资产');
  assert.equal(await logic.findArtifact(name, [dir], { maxDepth: 2 }), null, '深度可收窄');
  assert.equal(await logic.findArtifact(name, [path.join(dir, '不存在')]), null, '目录读不了 = 没找到，不抛错');
  assert.equal(await logic.findArtifact('', [dir]), null, '空名字不扫盘');
  // 只认完全同名的文件，别的版本不误报
  await fs.writeFile(path.join(dir, 'electron-v45.2.0-win32-x64.zip'), 'other');
  assert.equal(await logic.findArtifact(name, [dir]), zip);
});

test('mirrorSources：只从 .npmrc / package.json 读镜像来源，缺了就留空', () => {
  const sources = logic.mirrorSources({
    npmrcText: 'electron_mirror=https://npmmirror.com/mirrors/electron/\nother=1\n',
    packageJson: { build: { electronDownload: { mirror: 'https://npmmirror.com/mirrors/electron/' } } }
  });
  assert.deepEqual(sources.map((item) => item.where), [
    '.npmrc electron_mirror',
    'package.json build.electronDownload.mirror'
  ]);
  assert.deepEqual(logic.mirrorSources({ npmrcText: '', packageJson: null }), []);
  assert.deepEqual(logic.mirrorSources({ npmrcText: '// 注释里提到 electron_mirror 不算\n' }), []);
});

test('CLI：找到缓存 zip 且清单一致 → 0；哈希不一致 → 1；用法 / 输入问题 → 2', async () => {
  const dir = await mkTmp();
  const name = 'electron-v45.1.0-win32-x64.zip';
  const zip = path.join(dir, name);
  await fs.writeFile(zip, 'fake download');
  const good = sha256('fake download');
  const shasumsFile = path.join(dir, 'SHASUMS256.txt');
  await fs.writeFile(shasumsFile, `${good}  ${name}\n`);
  const badFile = path.join(dir, 'SHASUMS-bad.txt');
  await fs.writeFile(badFile, `${'f'.repeat(64)}  ${name}\n`);

  const lines = [];
  const errors = [];
  const baseIo = { root: ROOT, env: {}, stdout: (line) => lines.push(line), stderr: (line) => errors.push(line) };

  const okCode = await cli.run(
    ['--shasums', shasumsFile, '--cache', dir, '--version', '45.1.0'],
    baseIo
  );
  assert.equal(okCode, 0, errors.join('\n'));
  assert.ok(lines.some((line) => line.includes('OK：') && line.includes(name)), lines.join('\n'));
  assert.ok(lines.some((line) => line.includes('不联网')));

  errors.length = 0;
  const mismatchCode = await cli.run(
    ['--shasums', badFile, '--cache', dir, '--version', '45.1.0'],
    baseIo
  );
  assert.equal(mismatchCode, 1);
  assert.ok(errors.some((line) => line.includes('未通过')), errors.join('\n'));

  const usageCode = await cli.run([], baseIo);
  assert.equal(usageCode, 2, '缺 --shasums 是用法问题');
  const unknownCode = await cli.run(['--nope'], baseIo);
  assert.equal(unknownCode, 2);
  const missingVersion = await cli.run(['--shasums', shasumsFile], {
    ...baseIo,
    readFile: async (file) => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT', path: file });
    }
  });
  assert.equal(missingVersion, 2, '找不到本地版本要给出可照做的提示');

  // 清单在、缓存里没有 zip → 1（校验没完成不能当作通过）
  const emptyCache = await mkTmp('cw-electron-empty-cache-');
  const noZipCode = await cli.run(
    ['--shasums', shasumsFile, '--cache', emptyCache, '--version', '45.1.0'],
    baseIo
  );
  assert.equal(noZipCode, 1);
});

test('静态锚点：维护者文档的构建供应链一节 + 脚本不进 dist + 脚本不联网', () => {
  // M-N3（WP18）：供应链说明从 README 拆到 docs/维护与自检.md，事实与命令不变。
  const docs = read('docs/维护与自检.md');
  assert.ok(docs.includes('### 构建供应链（Electron 二进制）'), '维护者文档要有构建供应链小节（▲V308）');
  assert.ok(docs.includes('SHASUMS256.txt'), '要写明官方校验和清单');
  assert.ok(docs.includes('node scripts/verify-electron-checksum.js --shasums'), '要给可直接照抄的命令');
  assert.ok(docs.includes('npmmirror'), '要写明默认镜像来源');
  assert.ok(docs.includes('镜像') && docs.includes('不是来源证明'), '要说明镜像只是加速、不是来源证明');
  assert.ok(docs.includes('代码签名'), '要说明长期锚是代码签名（本条不做签名）');
  assert.ok(read('README.md').includes('docs/维护与自检.md'), 'README 要指向维护者文档');

  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.build.electronDownload.mirror, 'https://npmmirror.com/mirrors/electron/', '默认镜像不变');
  assert.equal(pkg.scripts.dist, 'electron-builder --win nsis', '校验脚本不自动接进 dist（可选出错面）');
  assert.equal(pkg.scripts['dist:dir'], 'electron-builder --win dir', 'dist:dir 同理');
  assert.equal(pkg.scripts['verify:electron'], undefined, '不新增 npm 脚本（README 里直接给命令）');

  const cliSource = read('scripts/verify-electron-checksum.js');
  const logicSource = read('scripts/electron-checksum-logic.js');
  for (const source of [cliSource, logicSource]) {
    assert.equal(/\brequire\(['"]node:https?['"]\)/.test(source), false, '校验脚本不许联网');
    assert.equal(/\bfetch\s*\(/.test(source), false, '校验脚本不许 fetch');
  }
});
// TOOL-A06：内置清单里出现无法解析的行 = 清单可能被动过，必须报红（退出码 2），不再静默跳过。
test('TOOL-A06：SHASUMS 清单里无法解析的行让供应链闸门失败', async () => {
  const supply = require('../scripts/supply-chain-check');
  const out = [];
  const err = [];
  const code = await supply.run(['--version', '45.1.0'], {
    root: path.join(__dirname, '..'),
    readFile: async (file) => {
      if (String(file).includes('SHASUMS')) {
        return 'e3b0c44298fc1c149afbf4c8996fb924  electron-v45.1.0-win32-x64.zip\n这一行根本不是清单格式\n';
      }
      return fs.readFile(file, 'utf8');
    },
    stdout: (line) => out.push(String(line)),
    stderr: (line) => err.push(String(line))
  });
  assert.equal(code, 2, '清单被污染时不得继续打包 / 发版');
  assert.match(err.join('\n'), /有 2 行无法解析/);
});
