// E2E 第 17 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：书架视图，删「外部导入源」
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group17DeleteBook(t) {
  const { exec, check, waitFor, sleep, storage, booksRoot } = t;
  const { importedPath } = t.state;

  // 17. 删除小说：整本书进 _trash（e2e 走兜底路径，不往你的回收站丢测试数据）
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec("window.__cwTest.deleteBookByFolder('外部导入源', { skipConfirm: true })");
  await sleep(500);
  const shelfAfterDelete = await storage.listBooks(booksRoot);
  check('删除后书架上不再有这本书', !shelfAfterDelete.some((b) => b.folder === '外部导入源'));
  const rootTrashDir = path.join(booksRoot, '_trash');
  const rootTrash = await fs.readdir(rootTrashDir);
  check(
    '删除的书进入书架 _trash（可人工找回，没有真删）',
    rootTrash.some((f) => f.endsWith('外部导入源')),
    rootTrash
  );
  check('删除后原书文件夹已从书架目录移走', await fs.access(importedPath).then(() => false, () => true));
};
