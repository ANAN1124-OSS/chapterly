// E2E 第 4 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：续「测试书」
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group4InsertChapter(t) {
  const { exec, check, waitFor, storage, bookDir } = t;

  // 4. 中间插入 → 章号自动顺延，旧文件一个都不改名
  await exec("window.__cwTest.insertAfter(0, '灯塔')");
  await waitFor("window.__cwTest.chapterTitles().length === 4");
  check(
    '插入后章号自动顺延',
    JSON.stringify(await exec('window.__cwTest.chapterTitles()')) ===
      JSON.stringify(['第1章：起风', '第2章：灯塔', '第3章：夜雨', '第4章'])
  );
  const meta2 = await storage.readBookMeta(bookDir);
  check(
    '插入后旧文件未改名、新文件用递增序号',
    JSON.stringify(meta2.chapters.map((c) => c.file)) ===
      JSON.stringify(['001-未命名.txt', '004-灯塔.txt', '002-夜雨.txt', '003-未命名.txt'])
  );
  for (const f of ['001-未命名.txt', '002-夜雨.txt', '003-未命名.txt']) {
    await fs.access(path.join(bookDir, f));
  }
  check('插入后自动切到新章节', (await exec('window.__cwTest.currentTitle()')) === '第2章：灯塔');
};
