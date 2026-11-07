// E2E 第 5 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：续「测试书」
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。

module.exports = async function group5SwitchDiscard(t) {
  const { exec, check, diskText } = t;

  // 5. 未保存时切章 → 选择「不保存」→ 磁盘不变
  await exec('window.__cwTest.switchTo(2)');
  await exec("window.__cwTest.setText('夜雨的草稿，不保存')");
  await exec("window.__cwTest.switchTo(0, 'discard')");
  check('丢弃修改后磁盘内容未变', (await diskText('002-夜雨.txt')) === '');
  check('丢弃后回到未修改状态', (await exec('window.__cwTest.dirty()')) === false);
  check('切换到了目标章节', (await exec('window.__cwTest.currentTitle()')) === '第1章：起风');
};
