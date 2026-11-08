// B4（审计 #21 / N1、N2、N4）：章节文件字段的防退化校验。
// 口径（勘误 E1、E2）：不要按审计原文断言「nul.txt 假成功丢稿」——本机实测 Node/libuv
// 在 Windows 用扩展长度路径语义，`nul.txt` / `CON` 目录都能落成普通文件。这里钉的是
// 「退化字段一律 BAD_PATH、绝不按坏字段写盘 / 建嵌套目录」+「保留名主干加安全后缀」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const storage = require('../core/storage');
const chapters = require('../core/chapters');
const repair = require('../core/repair');

const tmpCleanup = require('./tmp-cleanup');

async function mkTmp(prefix = 'cw-chfile-') {
  return tmpCleanup.track(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

function isBadPath(err) {
  return err instanceof storage.StorageError && err.code === 'BAD_PATH';
}

test('assertChapterFile：正常章节名通过，保留名子串不误杀', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '正常书');
  for (const file of ['001-起风.txt', '001-CON 的故事.txt', '012-第12章 夜雨.txt']) {
    assert.equal(storage.assertChapterFile(bookPath, file), path.join(bookPath, file));
  }
});

test('assertChapterFile：CON / con.txt / NUL / . / 子目录一律 BAD_PATH', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '防退化');
  for (const file of ['CON', 'con.txt', 'NUL', 'nul.txt', '.', 'sub/dir/x.txt', 'sub\\dir\\x.txt']) {
    assert.throws(() => storage.assertChapterFile(bookPath, file), isBadPath, `应拒绝：${file}`);
  }
});

test('assertChapterFile：空值 / 绝对路径 / 越界仍是 BAD_PATH', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '越界');
  for (const file of ['', '   ', '..\\..\\outside.txt', 'C:\\Windows\\win.ini']) {
    assert.throws(() => storage.assertChapterFile(bookPath, file), isBadPath, `应拒绝：${file}`);
  }
});

test('章节读写入口：坏 file 字段不落盘、不建嵌套目录', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '坏字段');
  await assert.rejects(() => storage.saveChapterText(bookPath, 'con.txt', '正文'), isBadPath);
  await assert.rejects(() => storage.saveChapterText(bookPath, 'sub/dir/x.txt', '正文'), isBadPath);
  await assert.rejects(() => storage.loadChapterText(bookPath, 'sub/dir/x.txt'), isBadPath);
  await assert.rejects(() => storage.statChapter(bookPath, 'NUL'), isBadPath);
  // 书文件夹里只有建书时的那一章 + 书目，没有按坏字段写出的文件 / 目录
  assert.deepEqual((await fs.readdir(bookPath)).sort(), ['001-未命名.txt', '书目.json']);
  await assert.rejects(() => fs.stat(path.join(bookPath, 'sub')), { code: 'ENOENT' });
});

test('assertInside：前缀比较大小写不敏感，真越界仍拒绝', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, 'Books', '书甲');
  await fs.mkdir(bookPath, { recursive: true });
  const upper = bookPath.toUpperCase();
  assert.equal(storage.assertInside(upper, '001-起风.txt'), path.join(upper, '001-起风.txt'));
  assert.throws(() => storage.assertInside(bookPath, '..\\别的书\\x.txt'), isBadPath);
});

test('safeName / buildFileName：保留名主干加安全后缀，正常名不动', () => {
  assert.equal(chapters.reservedStem('con.txt'), 'CON');
  assert.equal(chapters.reservedStem('001-CON 的故事.txt'), '');
  assert.equal(chapters.safeName('CON'), 'CON_');
  assert.equal(chapters.safeName('con.txt'), 'con_.txt');
  assert.equal(chapters.safeName('NUL'), 'NUL_');
  assert.equal(chapters.safeName('CON 的故事'), 'CON 的故事');
  assert.equal(chapters.safeName('起风'), '起风');
  assert.equal(chapters.buildFileName(1, 'CON'), '001-CON_.txt');
});

test('书目里出现退化 file 字段：书架标 corrupt，可从目录重建恢复', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '退化书');
  const metaPath = path.join(bookPath, storage.BOOK_FILE);
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  meta.chapters[0].file = 'sub/dir/x.txt';
  delete meta.chapters[0].chars;
  await fs.writeFile(metaPath, JSON.stringify(meta), 'utf8');

  const before = (await storage.listBooks(root)).find((book) => book.path === bookPath);
  assert.ok(before);
  assert.equal(before.status, 'corrupt');

  const rebuilt = await repair.rebuildFromFiles(bookPath);
  assert.equal(rebuilt.count, 1);
  assert.equal(rebuilt.meta.chapters[0].file, '001-未命名.txt');
  const after = (await storage.listBooks(root)).find((book) => book.path === bookPath);
  assert.equal(after.status, 'ok');
});
