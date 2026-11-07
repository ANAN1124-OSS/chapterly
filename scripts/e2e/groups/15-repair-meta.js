// E2E 第 15 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：独立造「坏书」（书架扫描，不动当前书）
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group15RepairMeta(t) {
  const { exec, check, storage, booksRoot } = t;

  // 15. 损坏书目恢复：从目录 txt 重建
  const brokenDir = path.join(booksRoot, '坏书');
  await fs.mkdir(brokenDir, { recursive: true });
  await fs.writeFile(path.join(brokenDir, '002-乙.txt'), '乙内容', 'utf8');
  await fs.writeFile(path.join(brokenDir, '001-甲.txt'), '甲内容', 'utf8');
  await fs.writeFile(path.join(brokenDir, '书目.json'), '{ 坏掉的 json', 'utf8');
  const shelfBefore = await storage.listBooks(booksRoot);
  check('损坏的书在书架上被标记', shelfBefore.find((b) => b.folder === '坏书')?.status === 'corrupt');
  const repairRes = await exec(`window.api.repairBook(${JSON.stringify(brokenDir)}, 'rebuild')`);
  check('从目录重建成功', repairRes && repairRes.ok === true, repairRes);
  const repairedMeta = await storage.readBookMeta(brokenDir);
  check(
    '重建后章节顺序正确（按序号排序）',
    JSON.stringify(repairedMeta.chapters.map((c) => c.file)) === JSON.stringify(['001-甲.txt', '002-乙.txt'])
  );
  const brokenFiles = await fs.readdir(brokenDir);
  check('损坏的 json 被改名保留', brokenFiles.some((f) => f.startsWith('书目.json.corrupt-')));
  const shelfAfter = await storage.listBooks(booksRoot);
  check('修复后书架恢复 normal', shelfAfter.find((b) => b.folder === '坏书')?.status === 'ok');
};
