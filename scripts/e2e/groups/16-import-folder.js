// E2E 第 16 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：先 backToShelf，再导入「外部导入源」并打开
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group16ImportFolder(t) {
  const { exec, check, waitFor, storage, booksRoot, state } = t;

  // 16. 导入小说：外部文件夹（纯 txt）→ 书架里的一本书
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const importSrc = path.join(path.dirname(booksRoot), '外部导入源');
  await fs.mkdir(importSrc, { recursive: true });
  await fs.writeFile(path.join(importSrc, '001-风起.txt'), '外部的第一章内容', 'utf8');
  await fs.writeFile(path.join(importSrc, '002-雨落.txt'), '外部的第二章内容', 'utf8');
  await exec(`window.__cwTest.importPaths([${JSON.stringify(importSrc)}])`);
  const shelfAfterImport = await storage.listBooks(booksRoot);
  const importedBook = shelfAfterImport.find((b) => b.folder === '外部导入源');
  check(
    '导入纯 txt 小说成功（按文件名重建书目）',
    importedBook && importedBook.status === 'ok' && importedBook.chapterCount === 2,
    importedBook
  );
  const importedPath = path.join(booksRoot, '外部导入源');
  state.importedPath = importedPath; // 第 17 组按它核对「原书文件夹已从书架目录移走」
  check('导入后原文件夹仍保留（只复制不移动）', await fs.access(importSrc).then(() => true, () => false));
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(importedPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  check(
    '导入的小说章节顺序正确',
    JSON.stringify(await exec('window.__cwTest.chapterTitles()')) ===
      JSON.stringify(['第1章：风起', '第2章：雨落'])
  );
  check('导入的小说正文完整', (await exec('window.__cwTest.chapterTextAt(0)')) === '外部的第一章内容');
};
