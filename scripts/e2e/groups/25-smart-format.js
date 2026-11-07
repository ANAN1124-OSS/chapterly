// E2E 第 25 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：续当前书（智能排版）
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group25SmartFormat(t) {
  const { exec, check, state } = t;
  const { currentBookDir, currentChapterFile } = t.state;

  // 25. 智能排版（对齐口袋写作）：缩进 0 字符 / 空一行（含缩进）
  const smartOpts = {
    indent: '0',
    blankLines: 'single',
    trimTrailing: true,
    normalizePunct: true,
    removeCjkSpaces: false
  };
  await exec(`window.__cwTest.setText(${JSON.stringify('　　第一段。\n\n　　第二段。')})`);
  await exec(`window.__cwTest.writeFormatOptions(${JSON.stringify(smartOpts)})`);
  await exec('window.__cwTest.applyFormat()');
  check(
    '智能排版：缩进可设为 0 字符（去掉缩进）',
    (await exec('window.__cwTest.text()')) === '第一段。\n\n第二段。',
    await exec('window.__cwTest.text()')
  );

  const indentBlankOpts = { ...smartOpts, indent: '2', blankLines: 'singleIndent' };
  await exec(`window.__cwTest.setText(${JSON.stringify('第一段。\n\n第二段。')})`);
  await exec(`window.__cwTest.writeFormatOptions(${JSON.stringify(indentBlankOpts)})`);
  await exec('window.__cwTest.applyFormat()');
  const indentBlankText = await exec('window.__cwTest.text()');
  state.indentBlankText = indentBlankText; // 第 26 组核对「改主题 / 边距不动正文一个字」用同一份正文
  check(
    '智能排版：空行可带缩进（空行里是全角空格）',
    indentBlankText === '　　第一段。\n　　\n　　第二段。',
    indentBlankText
  );
  const indentSave = await exec('window.__cwTest.save()');
  check('智能排版：含缩进的空行保存成功', Boolean(indentSave && indentSave.ok === true), indentSave);
  const indentBlankRaw = await fs.readFile(path.join(currentBookDir, currentChapterFile), 'utf8');
  check(
    '智能排版：落盘为 CRLF 且空行保留全角缩进',
    indentBlankRaw === '　　第一段。\r\n　　\r\n　　第二段。',
    indentBlankRaw
  );
  const undoDepthBeforeRepeat = await exec('window.__cwTest.formatUndoDepth()');
  await exec('window.__cwTest.applyFormat()');
  check('智能排版：重复整理幂等（不会再改一次）', (await exec('window.__cwTest.text()')) === indentBlankText);
  check(
    '智能排版：无改动时不往撤销栈里塞东西',
    (await exec('window.__cwTest.formatUndoDepth()')) === undoDepthBeforeRepeat
  );
};
