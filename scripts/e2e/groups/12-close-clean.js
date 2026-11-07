// E2E 第 12 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：续「测试书」干净态
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。

module.exports = async function group12CloseClean(t) {
  const { exec, check, win, resetCloseReady, waitCloseReady } = t;

  // 12. 干净状态关窗：不弹窗直接允许
  resetCloseReady();
  win.webContents.send('app:close-requested');
  check('无未保存修改时关窗直接允许', (await waitCloseReady()) === true);
  check('干净关窗不弹窗', (await exec('window.__cwTest.modalOpen()')) === false);
};
