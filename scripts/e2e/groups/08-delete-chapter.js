// E2E 第 8 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：续「测试书」
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group8DeleteChapter(t) {
  const { exec, check, waitFor, storage, bookDir } = t;

  // 8. 删除章节 → 文件进 _trash，json 移除
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await exec("window.__cwTest.deleteChapterAt(3, { skipConfirm: true })");
  await waitFor("window.__cwTest.chapterTitles().length === 3");
  const meta4 = await storage.readBookMeta(bookDir);
  check(
    '删除后章节顺序正确',
    JSON.stringify(meta4.chapters.map((c) => c.name)) === JSON.stringify(['起风', '灯塔改名', '夜雨'])
  );
  const trash = await fs.readdir(path.join(bookDir, '_trash'));
  check('删除的文件进了 _trash 而不是被删掉', trash.some((f) => f.endsWith('003-未命名.txt')), trash);
};
