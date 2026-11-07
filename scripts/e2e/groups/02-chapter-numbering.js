// E2E 第 2 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 本组在第 1 组新建的「测试书」上改名 + 追加两章，验证章号自动生成。

module.exports = async function group2ChapterNumbering(t) {
  const { exec, check } = t;

  // 2. 改名 + 追加两章 → 章号按顺序自动生成
  await exec("window.__cwTest.renameChapterAt(0, '起风')");
  await exec("window.__cwTest.newChapter('夜雨')");
  await exec("window.__cwTest.newChapter('')");
  check(
    '三章标题按顺序自动编号（含空名回退）',
    JSON.stringify(await exec('window.__cwTest.chapterTitles()')) ===
      JSON.stringify(['第1章：起风', '第2章：夜雨', '第3章'])
  );
  check(
    '重命名不改文件名',
    JSON.stringify(await exec('window.__cwTest.chapterFiles()')) ===
      JSON.stringify(['001-未命名.txt', '002-夜雨.txt', '003-未命名.txt'])
  );
};
