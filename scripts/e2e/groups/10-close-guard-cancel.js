// E2E 第 10 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：续「测试书」未保存态；关窗回执
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
//
// WP-09（C6）：关窗回执之后、真正 forceClose 之前还有一次「保存窗口位置」的 await。本组末段把
// 那次写盘拖慢（t.setCloseBoundsDelay，仅 --e2e 生效），复现「回执已发、forceClose 还没置」的
// 竞态窗口：作者在回执之后又敲了字，关窗必须被主进程复查拦下，窗口与刚敲的内容都还在。

module.exports = async function group10CloseGuardCancel(t) {
  const {
    exec,
    check,
    waitFor,
    sleep,
    win,
    resetCloseReady,
    waitCloseReady,
    getCloseReady,
    windowsInfo,
    setRealClose,
    setCloseBoundsDelay
  } = t;

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

  // ---------- WP-09（C6）：回执之后的复查 ----------
  // 判定已在「app:close-ready」那一刻算过；主进程写完窗口位置之后必须用同一判据再算一次。
  // 这里走「不保存退出」：回执时 session.dirty 已被渲染层清成 false → 第一判定放行；随后在
  // 被拖慢的写盘 await 里继续输入（app:dirty 重新上报），复查必须把这次关窗拦下。
  setCloseBoundsDelay(900);
  setRealClose(true);
  try {
    resetCloseReady();
    win.webContents.send('app:close-requested');
    await waitFor('window.__cwTest.modalOpen()');
    await exec("window.__cwTest.answerModal('discard')");
    // 主进程记下「放行」就说明第一判定跑完了、正卡在写窗口位置的 await 里（延迟 900 ms）。
    const waitMainCloseReady = async (want, timeout = 5000) => {
      const startedAt = Date.now();
      for (;;) {
        if (getCloseReady() === want) return true;
        if (Date.now() - startedAt > timeout) {
          throw new Error(`等待主进程关窗判定 ${want} 超时`);
        }
        await sleep(50);
      }
    };
    await waitMainCloseReady(true);
    await exec("window.__cwTest.setText('回执之后又敲的字')");
    await sleep(1300);
    check(
      '关窗放行后复查（C6）：回执后延迟窗口里的新输入让本次关窗作废',
      (await getCloseReady()) === false
    );
    const survivors = windowsInfo().filter((window) => !window.destroyed);
    check(
      '关窗放行后复查（C6）：窗口还在、刚敲的字没丢（仍是未保存态）',
      survivors.length === 1 &&
        (await exec('window.__cwTest.text()')) === '回执之后又敲的字' &&
        (await exec('window.__cwTest.dirty()')) === true
    );
    check(
      '关窗放行后复查（C6）：没留下悬着的关窗请求（下次点关闭还能重新询问）',
      survivors.length === 1 && survivors[0].closePending === false
    );
  } finally {
    setCloseBoundsDelay(0);
    setRealClose(false);
    // 还原组 11 依赖的未保存态（正文仍是「关窗测试：这段不该丢」）
    await exec("window.__cwTest.setText('关窗测试：这段不该丢')");
  }
};
