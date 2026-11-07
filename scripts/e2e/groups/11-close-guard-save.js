// E2E 第 11 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：续「测试书」未保存态
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。

module.exports = async function group11CloseGuardSave(t) {
  const { exec, check, waitFor, win, resetCloseReady, diskText, waitCloseReady } = t;

  // 11. 关窗拦截：未保存 → 保存并退出 → 磁盘更新
  resetCloseReady();
  win.webContents.send('app:close-requested');
  await waitFor('window.__cwTest.modalOpen()');
  await exec("window.__cwTest.answerModal('save')");
  await waitFor('window.__cwTest.modalOpen() === false', 12000);
  check('选择保存并退出后允许关闭', (await waitCloseReady()) === true);
  check('关窗前保存成功（磁盘内容更新）', (await diskText('001-未命名.txt')) === '关窗测试：这段不该丢');
};
