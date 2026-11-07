// E2E 第 10 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：续「测试书」未保存态；关窗回执
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。

module.exports = async function group10CloseGuardCancel(t) {
  const { exec, check, waitFor, win, resetCloseReady, waitCloseReady } = t;

  // 10. 关窗拦截：未保存 → 取消 → 不退出
  await exec("window.__cwTest.setText('关窗测试：这段不该丢')");
  resetCloseReady();
  win.webContents.send('app:close-requested');
  await waitFor('window.__cwTest.modalOpen()');
  check('关窗时未保存会先弹窗询问', (await exec('window.__cwTest.dialog()')) === '退出前保存');
  // 交互拍板 #8（2026-11-04）：通用询问框统一「取消最左 → 破坏性中间 → 主操作最右」
  // （.modal-buttons 右对齐，数组首项排最左）；破坏性仍是实心 danger，取消是最普通的 ghost。
  const exitDialogButtons = await exec(`(() => {
    return Array.from(document.querySelectorAll('#modal-buttons .btn')).map((btn) => ({
      text: btn.textContent.trim(),
      value: btn.dataset.value,
      primary: btn.classList.contains('primary'),
      danger: btn.classList.contains('danger')
    }));
  })()`);
  check(
    '询问框（拍板 #8）：关窗三选一按「取消 / 不保存退出 / 保存并退出」排列（取消最左、破坏性中间、主操作最右）',
    exitDialogButtons.length === 3 &&
      exitDialogButtons[0].text === '取消' &&
      exitDialogButtons[0].value === 'cancel' &&
      exitDialogButtons[0].primary === false &&
      exitDialogButtons[0].danger === false &&
      exitDialogButtons[1].text === '不保存退出' &&
      exitDialogButtons[1].value === 'discard' &&
      exitDialogButtons[1].danger === true &&
      exitDialogButtons[2].text === '保存并退出' &&
      exitDialogButtons[2].value === 'save' &&
      exitDialogButtons[2].primary === true,
    exitDialogButtons
  );
  await exec("window.__cwTest.answerModal('cancel')");
  await waitFor('window.__cwTest.modalOpen() === false');
  check('选择取消后不会关闭', (await waitCloseReady()) === false);
  check('选择取消后内容仍在内存中', (await exec('window.__cwTest.text()')) === '关窗测试：这段不该丢');
};
