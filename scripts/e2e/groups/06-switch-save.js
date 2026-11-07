// E2E 第 6 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：续「测试书」
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。

module.exports = async function group6SwitchSave(t) {
  const { exec, check, diskText } = t;

  // 6. 未保存时切章 → 选择「保存并切换」→ 磁盘更新
  await exec('window.__cwTest.switchTo(1)');
  await exec("window.__cwTest.setText('灯塔正文')");
  await exec("window.__cwTest.switchTo(0, 'save')");
  check('保存并切换后磁盘内容已更新', (await diskText('004-灯塔.txt')) === '灯塔正文');
};
