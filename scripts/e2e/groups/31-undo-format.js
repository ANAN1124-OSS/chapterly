// E2E 第 31 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：续「拖拽排序书」（撤销整理）
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。

module.exports = async function group31UndoFormat(t) {
  const { exec, check } = t;

  // 31. 撤销整理：快照上限 10 → 50，菜单显示还能撤销几步
  await exec('window.__cwTest.switchTo(0, "discard")');
  await exec("window.__cwTest.setText('段落一。\\n\\n段落二。')");
  await exec('window.__cwTest.save()');
  const undoDepthBefore = await exec('window.__cwTest.formatUndoDepth()');
  for (let i = 0; i < 11; i += 1) {
    const options = { indent: i % 2 === 0 ? '2' : '0', blankLines: 'keep', trimTrailing: true, normalizePunct: true };
    await exec(`window.__cwTest.writeFormatOptions(${JSON.stringify(options)})`);
    await exec('window.__cwTest.applyFormat()');
  }
  const undoDepthNow = await exec('window.__cwTest.formatUndoDepth()');
  check(
    '撤销整理：连续整理 11 次都留得下（不再被 10 步截断）',
    undoDepthNow === undoDepthBefore + 11 && undoDepthNow > 10,
    { undoDepthBefore, undoDepthNow }
  );
  check('撤销整理：11 步都能连续撤回', (await exec('window.__cwTest.formatUndoSteps()')) === 11);
  await exec('window.__cwTest.openFormatMenu()');
  const undoItemLabel = await exec('window.__cwTest.formatUndoItemText()');
  check('撤销整理：选择卡里显示还能撤销几步', undoItemLabel.includes('可撤销 11 步'), undoItemLabel);
  check(
    '撤销整理：悬浮选择卡里有「撤销上次整理」',
    (await exec('Boolean(document.querySelector(\'#format-menu button[data-action="undo"]\'))')) === true
  );
  await exec('window.__cwTest.closeFormatMenu()');
  await exec('window.__cwTest.undoFormat()');
  await exec('window.__cwTest.undoFormat()');
  check('撤销整理：连续撤销两步后还剩 9 步', (await exec('window.__cwTest.formatUndoSteps()')) === 9);
};
