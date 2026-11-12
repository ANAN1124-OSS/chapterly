// B2（审计 P2）：`writeBookMeta` 的 .bak 只在结构性变更时轮换。
//
// 旧行为：每次保存都先写 .bak 再写主文件（两次 fsync）。普通保存（正文 / 字数缓存 / 上次打开章节）
// 也轮换备份，等于每次 Ctrl+S 都多一次磁盘同步。
// 新行为：调用方显式传 { structural: true }（新建 / 删除 / 改名 / 分卷 / 导入 / 改书名…）才轮换；
// 普通保存跳过。备份语义保守：不传 = 不备份，传了 = 和以前一样「写前留上一版」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const storage = require('../core/storage');
const tmpCleanup = require('./tmp-cleanup');

// 临时目录一律登记到 tmp-cleanup：进程退出时统一回收（D:\Temp 曾被单测残留堆到 125 GB）。
async function mkTmp() {
  return tmpCleanup.track(await fs.mkdtemp(path.join(os.tmpdir(), 'cw-meta-bak-')));
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

test('书目备份：只有结构性变更才轮换 .bak，普通保存不碰上一版', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '备份演练');
  try {
  const bakPath = path.join(bookPath, '书目.json.bak');
  assert.equal(await exists(bakPath), false, '新书第一次写盘没有上一版，不该造出空备份');

  // 普通写盘（默认参数 = 普通保存）：没有 .bak 就保持没有
  await storage.writeBookMeta(bookPath, await storage.readBookMeta(bookPath));
  assert.equal(await exists(bakPath), false, '普通保存不该创建 .bak');

  // 结构性变更：新建一章 → .bak = 变更前的主文件（1 章）
  await storage.createChapterWithText(bookPath, { insertIndex: 1, name: '插入章', text: '正文一' });
  assert.equal(await exists(bakPath), true, '结构性变更要留上一版');
  const bakAfterCreate = JSON.parse(await fs.readFile(bakPath, 'utf8'));
  assert.equal(bakAfterCreate.chapters.length, 1, '.bak 应是不含新章的上一版');
  assert.equal((await storage.readBookMeta(bookPath)).chapters.length, 2);

  // 普通保存：只改 lastOpenChapterId（切章）→ 主文件更新，.bak 保持
  const bakBeforeNormal = await fs.readFile(bakPath, 'utf8');
  const meta = await storage.readBookMeta(bookPath);
  await storage.setLastOpenChapter(bookPath, meta.chapters[1].id);
  assert.equal(await fs.readFile(bakPath, 'utf8'), bakBeforeNormal, '切章（普通保存）不该轮换 .bak');
  assert.equal((await storage.readBookMeta(bookPath)).lastOpenChapterId, meta.chapters[1].id);

  // 普通写盘再来一次（例如章节保存后的字数缓存）也不动 .bak
  const current = await storage.readBookMeta(bookPath);
  await storage.writeBookMeta(bookPath, current);
  assert.equal(await fs.readFile(bakPath, 'utf8'), bakBeforeNormal, '默认写盘（普通保存）不该轮换 .bak');

  // 结构性变更：重命名一章 → .bak 正好是「重命名前」的主文件
  const beforeRename = await storage.readBookMeta(bookPath);
  await storage.renameChapter(bookPath, beforeRename.chapters[0].id, '改名了');
  const bakAfterRename = JSON.parse(await fs.readFile(bakPath, 'utf8'));
  assert.equal(bakAfterRename.lastOpenChapterId, beforeRename.lastOpenChapterId, '.bak 应包含上一次普通保存的结果');
  assert.equal(bakAfterRename.chapters[0].name, '', '.bak 里还是旧章名');
  assert.equal((await storage.readBookMeta(bookPath)).chapters[0].name, '改名了');

  // 分卷也是结构性变更
  const bakBeforeVolume = await fs.readFile(bakPath, 'utf8');
  await storage.createVolume(bookPath, '第一卷');
  assert.notEqual(await fs.readFile(bakPath, 'utf8'), bakBeforeVolume, '新建卷要轮换 .bak');
  assert.deepEqual(JSON.parse(await fs.readFile(bakPath, 'utf8')).volumes, [], '备份里还没这一卷');

  // 删除章节也是结构性变更（.bak 里是删除前那一版）
  const beforeDelete = await storage.readBookMeta(bookPath);
  await storage.deleteChapter(bookPath, beforeDelete.chapters[1].id);
  const afterDelete = await storage.readBookMeta(bookPath);
  assert.equal(afterDelete.chapters.length, beforeDelete.chapters.length - 1, '删章后主文件少一章');
  assert.equal(
    JSON.parse(await fs.readFile(bakPath, 'utf8')).chapters.length,
    beforeDelete.chapters.length,
    '删章要轮换 .bak（备份里还是删除前那一版）'
  );

  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('书目备份：结构性写盘时 .bak 写失败 → 抛错且主文件一个字不动（备份语义保守）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '备份失败演练');
  try {
  const metaPath = path.join(bookPath, '书目.json');
  const bakPath = path.join(bookPath, '书目.json.bak');
  const beforeMain = await fs.readFile(metaPath, 'utf8');

  // 用目录占住 .bak 路径，让 atomicWriteFile 备份失败（Windows 下是 EPERM / EISDIR）
  await fs.mkdir(bakPath);
  let failure = null;
  try {
    await storage.writeBookMeta(bookPath, await storage.readBookMeta(bookPath), { structural: true });
  } catch (err) {
    failure = err;
  }
  assert.ok(failure, '备份写失败必须抛错（不能悄悄跳过）');
  assert.equal(await fs.readFile(metaPath, 'utf8'), beforeMain, '备份失败时主文件不能被改掉');

  await fs.rm(bakPath, { recursive: true, force: true });
  // 恢复后照常能写（失败不留下坏状态）
  const after = await storage.readBookMeta(bookPath);
  await storage.writeBookMeta(bookPath, after, { structural: true });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
