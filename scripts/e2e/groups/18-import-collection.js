// E2E 第 18 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：书架视图，导入「小说收藏夹」（两本）
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group18ImportCollection(t) {
  const { exec, check, sleep, storage, booksRoot } = t;

  // 18. 导入小说收藏夹：每个 txt 是一本书，自动分章
  const collectionSrc = path.join(path.dirname(booksRoot), '小说收藏夹');
  await fs.mkdir(collectionSrc, { recursive: true });
  await fs.writeFile(
    path.join(collectionSrc, '小说甲 - 作者.txt'),
    '第1章 开端\n\n甲的正文\n\n第2章 转折\n\n甲的二段',
    'utf8'
  );
  await fs.writeFile(
    path.join(collectionSrc, '小说乙 - 作者.txt'),
    '楔子\n\n乙的引子\n\n第一章 雪夜\n\n乙的正文',
    'utf8'
  );
  await exec(`window.__cwTest.importPaths([${JSON.stringify(collectionSrc)}], 'split')`);
  await sleep(500);
  const shelfCollection = await storage.listBooks(booksRoot);
  const bookA = shelfCollection.find((b) => b.title === '小说甲 - 作者');
  const bookB = shelfCollection.find((b) => b.title === '小说乙 - 作者');
  check('收藏夹里的每个 txt 都导入成一本书', Boolean(bookA && bookB), shelfCollection.map((b) => b.title));
  check(
    '导入时自动按标题行分章',
    Boolean(bookA && bookA.chapterCount === 2 && bookB && bookB.chapterCount === 2),
    { a: bookA && bookA.chapterCount, b: bookB && bookB.chapterCount }
  );
  const importedMetaA = await storage.readBookMeta(bookA.path);
  check(
    '分章后的章节名正确',
    JSON.stringify(importedMetaA.chapters.map((c) => c.name)) === JSON.stringify(['开端', '转折'])
  );
  const importedMetaB = await storage.readBookMeta(bookB.path);
  check(
    '楔子 / 第一章 也能识别',
    JSON.stringify(importedMetaB.chapters.map((c) => c.name)) === JSON.stringify(['楔子', '雪夜'])
  );
};
