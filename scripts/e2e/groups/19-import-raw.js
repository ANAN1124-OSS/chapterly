// E2E 第 19 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：导入「原样导入源」并打开（raw 模式）
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group19ImportRaw(t) {
  const { exec, check, waitFor, storage, booksRoot } = t;

  // 19. 默认「原文件导入」：整篇一章、内容与源文件完全一致（不拆章、不改字）
  const rawSrc = path.join(path.dirname(booksRoot), '原样导入源');
  await fs.mkdir(rawSrc, { recursive: true });
  const rawContent = '第1章 开端\n\n原文第一段\n\n第2章 转折\n\n原文第二段';
  await fs.writeFile(path.join(rawSrc, '原样小说 - 作者.txt'), rawContent, 'utf8');
  await exec(`window.__cwTest.importPaths([${JSON.stringify(rawSrc)}], 'raw')`);
  const shelfRaw = await storage.listBooks(booksRoot);
  const rawBook = shelfRaw.find((b) => b.title === '原样小说 - 作者');
  check(
    '默认导入：每个 txt 一本书、不拆章',
    Boolean(rawBook && rawBook.chapterCount === 1),
    rawBook && rawBook.chapterCount
  );
  await exec(
    `window.__cwTest.openBookPath(${JSON.stringify(path.join(booksRoot, '原样小说 - 作者'))})`
  );
  await waitFor("window.__cwTest.view() === 'editor'");
  check('默认导入后只有一章「全文」', (await exec('window.__cwTest.currentTitle()')) === '第1章：全文');
  check('默认导入正文与源文件完全一致', (await exec('window.__cwTest.text()')) === rawContent);
};
