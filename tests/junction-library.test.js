// 目录联接书库（v0.13 U-C3，2026-11-06 拍板：书库使用目录联接 → 不实现「realpath / 拒符号链接」）。
//
// 口径：支持书库根目录是指向别处（别的盘 / 别的目录）的目录联接（Windows junction）——
// 照常列书、打开、读章、保存；应用**不做 realpath**，也不校验链接指向，安全边界依赖本机文件
// 系统权限（只有本机用户能造出这种链接）。这里钉三件事：
//   1. 书库根是联接时：listBooks / readBookMeta / loadChapterText / saveChapterText 全部走真实目录，
//      不建影子书库、不改名、不搬文件；
//   2. 联接路径按**字面路径**判身份（normalizePath 不折叠成目标路径）——同一物理书库的两个名字
//      是两个键，assertBookPath / 打开登记表都只认配置里那一个路径（不 realpath 的代价，属已知限制）；
//   3. 书文件夹本身若是联接：已知路径下照样能读章 / 保存；但书架列举只认直接子目录，它不会自动
//      出现在书架（现有行为，写进 README 已知限制；要改成跟随联接是产品决定，不在本卡范围）。
// 红线：全部在系统临时目录里造，绝不碰真实书库。
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const storage = require('../core/storage');
const ipcPaths = require('../core/ipc-paths');
const pathUtils = require('../core/path-utils');
const openBooks = require('../core/open-books');

// Windows 用 junction（不需要管理员权限）；其它平台退化成普通目录符号链接，只为本地可跑。
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

async function mkTmp(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

// 先删联接本身、再删临时根目录：绝不 recursive 地穿过联接去动目标。
async function cleanup(base, links = []) {
  for (const link of links) {
    await fsp.unlink(link).catch(() => {});
  }
  await fsp.rm(base, { recursive: true, force: true });
}

test('书库根是目录联接：列书、打开、读章、保存都落在真实目录', async () => {
  const base = await mkTmp('cw-junction-root-');
  const link = path.join(base, '书架联接');
  try {
    // 「真实书库」放在另一个目录层（模拟另一个盘），配置里用的是联接路径。
    const realRoot = path.join(base, '另一处', '真实书库');
    const created = await storage.createBook(realRoot, '联接书');
    const folder = path.basename(created.path);
    const file = created.meta.chapters[0].file;
    await fsp.symlink(realRoot, link, LINK_TYPE);

    const shelf = await storage.listBooks(link);
    assert.equal(shelf.length, 1, '联接书库里的书要被列出来');
    assert.equal(shelf[0].folder, folder);
    assert.equal(shelf[0].path, path.join(link, folder), '书架返回的仍是联接路径（不折叠成真实路径）');
    assert.equal(shelf[0].chapterCount, 1);

    const meta = await storage.readBookMeta(shelf[0].path);
    assert.equal(meta.title, '联接书', '经联接打开时书目照常解析');
    const loaded = await storage.loadChapterText(shelf[0].path, file);
    assert.equal(loaded.text, '');

    await storage.saveChapterText(shelf[0].path, file, '联接书库里的正文\n');
    // 真实目录里看得到：没有影子书库、没有改名，写盘跟随联接落到目标。
    assert.equal(await fsp.readFile(path.join(realRoot, folder, file), 'utf8'), '联接书库里的正文\r\n');
    const reread = await storage.loadChapterText(path.join(realRoot, folder), file);
    assert.equal(reread.text, '联接书库里的正文\n', '真实路径读得回刚才经联接写入的内容');
    assert.equal((await storage.readBookMeta(path.join(realRoot, folder))).title, '联接书');
  } finally {
    await cleanup(base, [link]);
  }
});

test('联接路径按字面判身份：不 realpath（同一书库两个名字是两个键，assertBookPath 只认联接路径）', async () => {
  const base = await mkTmp('cw-junction-identity-');
  const link = path.join(base, '书库联接');
  try {
    const realRoot = path.join(base, '真实书库');
    const created = await storage.createBook(realRoot, '身份书');
    const folder = path.basename(created.path);
    const linkBook = path.join(link, folder);
    await fsp.symlink(realRoot, link, LINK_TYPE);

    // 归一化只做 resolve + 小写：联接路径与目标路径是两个不同的键（不 realpath）。
    assert.notEqual(pathUtils.normalizePath(link), pathUtils.normalizePath(realRoot));
    assert.equal(pathUtils.normalizePath(linkBook), linkBook.toLowerCase());

    // 书架路径校验是文本判定：配置里是联接路径时，只认挂在联接路径下的书。
    assert.equal(ipcPaths.assertBookPath(linkBook, link), linkBook);
    assert.throws(
      () => ipcPaths.assertBookPath(created.path, link),
      (err) => err instanceof ipcPaths.IpcPathError && err.code === 'BAD_PATH',
      '同一个物理书的真实路径，在联接书架下会被文本判定拒绝（不做 realpath 的代价）'
    );
    assert.equal(ipcPaths.assertBookPath(created.path, realRoot), created.path, '真实路径 + 真实书架照常合法');

    // 打开登记表同样按字面路径认书：同一物理书用两个名字会被当成两本（不 realpath 的代价）。
    const registry = openBooks.createRegistry();
    assert.equal(registry.setBook(1, linkBook).ok, true);
    assert.equal(registry.findWindow(linkBook), '1');
    assert.equal(registry.findWindow(created.path), null);
    assert.equal(registry.setBook(2, created.path).ok, true);
  } finally {
    await cleanup(base, [link]);
  }
});

test('书文件夹本身是联接：已知路径下照常读章 / 保存（书架列举只认直接子目录，不会自动出现）', async () => {
  const base = await mkTmp('cw-junction-book-');
  const bookLink = path.join(base, '书库', '联接的书');
  try {
    const realBookParent = path.join(base, '另一处');
    const created = await storage.createBook(realBookParent, '搬出去的书');
    const file = created.meta.chapters[0].file;
    await fsp.mkdir(path.join(base, '书库'), { recursive: true });
    await fsp.symlink(created.path, bookLink, LINK_TYPE);

    // 已知路径（例如将来从别的入口打开）时，读章 / 保存都照常跟随联接。
    const meta = await storage.readBookMeta(bookLink);
    assert.equal(meta.title, '搬出去的书');
    await storage.saveChapterText(bookLink, file, '书文件夹联接里的正文\n');
    assert.equal((await storage.loadChapterText(created.path, file)).text, '书文件夹联接里的正文\n');

    // 现有行为：书架列举只认 isDirectory 的直接子目录，联接本身不算，因此不会自动出现在书架。
    // （要改成跟随联接是产品 / 安全口径变更，不在 U-C3 卡范围；README 已知限制有记。）
    assert.deepEqual(await storage.listBooks(path.join(base, '书库')), []);
  } finally {
    await cleanup(base, [bookLink]);
  }
});
