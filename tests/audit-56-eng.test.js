// 审计修复 #56（O4 / O5 / O7 / S4 / S5 / S7）：工程小项的行为与静态闸门。
//
// 这里覆盖：S7 导入符号链接闸门（行为 + 扫描口径 + 接线）、O5 启动脚本查 Node 版本、
// O7 LICENSE / SPDX 口径文档化。O4（Node 矩阵 + pnpm 下限）在 tests/ci-workflow.test.js，
// S4（撤销凭证绑 chapter.id）在 tests/ipc-restore-token.test.js，S5（publicInfo 剥 path）
// 在 tests/wordlist.test.js。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const storage = require('../core/storage');
const importer = require('../core/importer');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// Windows 用 junction（不需要管理员权限）；其它平台退化成普通目录符号链接，只为本地可跑。
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

async function cleanup(base, links = []) {
  for (const link of links) await fsp.unlink(link).catch(() => {});
  await fsp.rm(base, { recursive: true, force: true }).catch(() => {});
}

test('S7：含符号链接 / 目录联接的现成书来源整源跳过（不复制、不留半本书），干净来源照常导入', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'cw-import-link-'));
  const links = [];
  try {
    const sourceRoot = path.join(base, '外部来源');
    const linked = await storage.createBook(sourceRoot, '链接书');
    const plain = await storage.createBook(sourceRoot, '干净书');
    const target = path.join(base, '链接目标');
    await fsp.mkdir(target, { recursive: true });
    await fsp.writeFile(path.join(target, '正文.txt'), '链接指向的正文\n', 'utf8');
    const linkPath = path.join(linked.path, '链接目录');
    await fsp.symlink(target, linkPath, LINK_TYPE);
    links.push(linkPath);

    const booksRoot = path.join(base, '书架');
    const res = await importer.importFolders(booksRoot, [linked.path, plain.path], {});
    assert.equal(res.imported.length, 1, '干净来源照常导入');
    assert.equal(res.imported[0].title, '干净书');
    assert.equal(res.failed.length, 0, `符号链接来源不该记为失败：${JSON.stringify(res.failed)}`);
    assert.equal(res.skipped.length, 1);
    const skip = res.skipped[0];
    assert.equal(skip.code, 'SOURCE_LINK');
    assert.match(skip.reason, /符号链接/);
    assert.match(skip.reason, /已跳过/);
    assert.equal(skip.tooLarge, false, '不是体量超限（不并进 skippedTooLarge）');
    assert.equal(await storage.exists(path.join(booksRoot, '链接书')), false, '不许留下没复制完的半本书');
    assert.equal(await storage.exists(linked.path), true, '来源本身一个字节都不动');
  } finally {
    await cleanup(base, links);
  }
});

test('S7：listSourceLinks 只收链接 / 用相对路径 / _trash 与点开头目录不进', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'cw-import-link-scan-'));
  const links = [];
  try {
    const target = path.join(base, 'target');
    await fsp.mkdir(target, { recursive: true });
    const source = path.join(base, 'source');
    await fsp.mkdir(path.join(source, '子目录'), { recursive: true });
    await fsp.mkdir(path.join(source, '_trash'), { recursive: true });
    await fsp.mkdir(path.join(source, '.隐藏'), { recursive: true });
    await fsp.writeFile(path.join(source, '正常.txt'), '正文\n', 'utf8');
    const visible = path.join(source, '子目录', '链接');
    const trashLink = path.join(source, '_trash', '链接');
    const dotLink = path.join(source, '.隐藏', '链接');
    for (const link of [visible, trashLink, dotLink]) {
      await fsp.symlink(target, link, LINK_TYPE);
      links.push(link);
    }
    const found = await importer.listSourceLinks(source);
    assert.deepEqual(found, [path.join('子目录', '链接')], '只收业务目录里的链接，相对路径、排除 _trash / 点开头目录');
  } finally {
    await cleanup(base, links);
  }
});

test('S7 静态闸门：复制前先扫链接；SOURCE_LINK 按「跳过」记录（不是复制失败）', () => {
  const source = read('core/importer.js');
  const gateAt = source.indexOf('await listSourceLinks(sourceDir)');
  const copyAt = source.indexOf('await copyAsBook(sourceDir, target, oversized)');
  assert.ok(gateAt > 0, 'importBookFolder 必须先扫符号链接');
  assert.ok(copyAt > gateAt, '链接闸门要排在 fs.cp 整目录复制之前');
  assert.match(source, /code === 'FILE_TOO_LARGE' \|\| err\.code === 'SOURCE_LINK'/, 'importFolders 要把 SOURCE_LINK 记进 skipped');
  assert.match(source, /tooLarge: err\.code === 'FILE_TOO_LARGE'/, 'SOURCE_LINK 不能算「体量超限」');
});

test('O5：启动章回.cmd 真读 Node 主版本号；<22 给出可执行提示且不启动', () => {
  const cmd = read('启动章回.cmd');
  assert.ok(cmd.includes('process.versions.node'), 'cmd 要在启动前真读 Node 主版本号（只查 where node 不够）');
  assert.match(cmd, />=\s*22/, '下限与 engines / README 的 ≥22 对齐');
  assert.ok(
    cmd.indexOf('process.versions.node') > cmd.indexOf('where node'),
    '版本检查要排在「有没有 node」之后'
  );
  assert.ok(
    cmd.indexOf('process.versions.node') < cmd.indexOf('node scripts\\start.js'),
    '版本检查必须排在真正启动之前'
  );
  assert.match(cmd, /Node\.js 版本过低/, '低版本要给中文提示（不是后面甩语法错误）');
  assert.match(cmd, /node -v/, '提示里要能显示当前版本，作者才知道差多少');
});

// 审计残留修复 R26（#56/O5）：node -e 自身失败（Node 损坏）与「版本过低」是两回事 —— 旧写法两种
// 原因都说「版本过低」，而且版本号靠单起一行 node -v 拼进括号里、排版会折行。现在先取版本串：
// 读不到 = 执行失败；读到但主版本 <22 = 版本过低；版本号与提示写在同一行。
test('R26：cmd 分开「node 执行失败」与「版本过低」，版本号与提示同行', () => {
  const cmd = read('启动章回.cmd');
  assert.match(cmd, /Node\.js 执行失败/, 'node 跑不起来要给「执行失败」提示，不能一律说版本过低');
  assert.ok(
    cmd.indexOf('Node.js 执行失败') < cmd.indexOf('Node.js 版本过低'),
    '先判「读不到版本」再判「版本过低」'
  );
  assert.match(
    cmd,
    /for \/f "delims=" %%v in \('node -v 2\^>nul'\) do set "NODE_VER=%%v"/,
    '版本串用 node -v 取一次，两个分支复用'
  );
  assert.match(
    cmd,
    /echo Node\.js 版本过低[^\r\n]*%NODE_VER%）/,
    '当前版本要跟提示写在同一行（旧写法用单独 echo 拼接，会把「）」折到下一行）'
  );
  assert.doesNotMatch(cmd, /^\s*node -v\s*$/m, '不许再单起一行执行 node -v 拼版本号（排版会折行）');
});

test('O7：README 许可段记录「SPDX 可选、LICENSE 为准」（按审计「可选」口径文档化）', () => {
  const readme = read('README.md');
  assert.match(readme, /源码文件头（审计 #56 \/ O7）/, 'README 要写明 SPDX 文件头口径');
  assert.match(readme, /SPDX-License-Identifier: Apache-2\.0/, 'README 要给出可选头的写法');
  assert.match(readme, /以仓库根 `LICENSE` 与 `package\.json` 的 `license` 字段为准/, '许可仍以 LICENSE / package.json 为唯一事实');
  assert.match(readme, /可选|不强制/, '口径是「可选」，不能写成必须逐文件加头');
});