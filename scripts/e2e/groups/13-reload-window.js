// E2E 第 13 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：续「测试书」：win.reload() 后按 bookDir 重开
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。

module.exports = async function group13ReloadWindow(t) {
  const { exec, check, waitFor, win, bookDir } = t;

  // 13. 重载窗口（模拟重启）后重新打开书：内容、顺序、上次章节都还在
  win.webContents.reload();
  await waitFor('Boolean(window.__cwTest && window.__cwTest.ready)', 15000);
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookDir)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  check(
    '重启后章节顺序不变',
    JSON.stringify(await exec('window.__cwTest.chapterTitles()')) ===
      JSON.stringify(['第1章：起风', '第2章：灯塔改名', '第3章：夜雨'])
  );
  check(
    '重启后能读回已保存内容',
    (await exec('window.__cwTest.chapterTextAt(0)')) === '关窗测试：这段不该丢'
  );
};
