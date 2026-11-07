// E2E 第 1 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 本组新建「测试书」并自动打开；后面的第 2–15 组都在这一本书上继续。

module.exports = async function group1NewBook(t) {
  const { exec, check, waitFor } = t;

  // 1. 新建书 → 自动打开、自动带一个空章
  await exec("window.__cwTest.newBook('测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  check('新建书后进入编辑视图', (await exec('window.__cwTest.view()')) === 'editor');
  check(
    '初始一个空章且标题为「第1章」',
    JSON.stringify(await exec('window.__cwTest.chapterTitles()')) === JSON.stringify(['第1章'])
  );
};
