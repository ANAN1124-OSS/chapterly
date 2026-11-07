// E2E 第 24 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：续组 23 的当前书（光标 / 弹层压栈）
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。

module.exports = async function group24ReviewFixes(t) {
  const { exec, check, waitFor, win, resetCloseReady, waitCloseReady } = t;

  // 24. 审阅修复复核：① 整理/撤销不把光标打回章首；② 关窗询问能压住排版弹层
  const caretText = '第一段文字，测试光标位置。\n\n第二段文字，继续测试。\n\n第三段文字。';
  await exec(`window.__cwTest.setText(${JSON.stringify(caretText)})`);
  await exec(`window.__cwTest.setCaret(${caretText.indexOf('第二段') + 3})`);
  await exec('window.__cwTest.applyFormat()');
  const caretAfterFormat = await exec('window.__cwTest.caret()');
  const caretSegment = (await exec('window.__cwTest.text()')).slice(0, caretAfterFormat);
  check(
    '整理后光标留在原段落，不被打回章首',
    caretSegment.endsWith('第二段'),
    { caretAfterFormat, segment: caretSegment.slice(-12) }
  );
  await exec('window.__cwTest.undoFormat()');
  const caretAfterUndo = await exec('window.__cwTest.caret()');
  const undoSegment = (await exec('window.__cwTest.text()')).slice(0, caretAfterUndo);
  check(
    '撤销整理后光标也留在原位置',
    undoSegment.endsWith('第二段'),
    { caretAfterUndo, segment: undoSegment.slice(-12) }
  );

  const zIndexes = await exec(`(() => ({
    modal: Number(getComputedStyle(document.getElementById('modal-backdrop')).zIndex),
    format: Number(getComputedStyle(document.getElementById('format-backdrop')).zIndex),
    settings: Number(getComputedStyle(document.getElementById('settings-backdrop')).zIndex)
  }))()`);
  check(
    '关窗询问的层级高于排版/设置弹层',
    zIndexes.modal > zIndexes.format && zIndexes.modal > zIndexes.settings,
    zIndexes
  );

  await exec('window.__cwTest.openFormatDialog()');
  check('排版弹层已打开（关窗复核前置条件）', (await exec('window.__cwTest.formatDialogOpen()')) === true);
  check('当前仍有未保存修改', (await exec('window.__cwTest.dirty()')) === true);
  resetCloseReady();
  win.webContents.send('app:close-requested');
  await waitFor('window.__cwTest.modalOpen()');
  check('关窗询问会先收起排版弹层', (await exec('window.__cwTest.formatDialogOpen()')) === false);
  check('关窗询问正常弹出（没有被弹层压住）', (await exec('window.__cwTest.dialog()')) === '退出前保存');
  await exec("window.__cwTest.answerModal('cancel')");
  await waitFor('window.__cwTest.modalOpen() === false');
  check('取消关窗后窗口不关闭', (await waitCloseReady()) === false);
};
