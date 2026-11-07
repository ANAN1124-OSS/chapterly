// E2E 第 22 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：续「章节小说 - 作者」（排版章节，正文改动不写盘）
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group22FormatChapter(t) {
  const { exec, check, waitFor, sleep, booksRoot, state } = t;

  // 22. 排版：一键整理本章 —— 改正文但不自动写盘，可撤销，落盘为 CRLF
  const currentBookDir = path.join(booksRoot, '章节小说 - 作者');
  const currentChapterFile = (await exec('window.__cwTest.chapterFiles()'))[0];
  state.currentBookDir = currentBookDir; // 第 23 / 25 组按同一本书续跑
  state.currentChapterFile = currentChapterFile;
  const messyText = '他说,"你好."   \n\n\n第二段  ';
  await exec(`window.__cwTest.setText(${JSON.stringify(messyText)})`);
  await sleep(150);
  check('整理前编辑区是脏样本', (await exec('window.__cwTest.text()')) === messyText);

  // v0.8.5 R1：「整理 ▾」点按钮 = 直接整理本章（不再开菜单）；选择卡靠鼠标悬浮 / Tab 聚焦出现，
  // 这里走同一个入口（openFormatMenu = 出卡）再点「排版设置…」打开原来的对话框。
  await exec('window.__cwTest.openFormatMenu()');
  check('写作页「整理 ▾」的悬浮选择卡能打开', (await exec('window.__cwTest.formatCardOpen()')) === true);

  await exec("document.querySelector('#format-menu button[data-action=\"settings\"]').click()");
  await waitFor('window.__cwTest.formatDialogOpen() === true');
  check('「排版设置…」对话框打开（原名「一键整理本章」）', (await exec('window.__cwTest.formatDialogOpen()')) === true);

  await waitFor("window.__cwTest.formatSummary().includes('共 2 段')");
  const formatSummary = await exec('window.__cwTest.formatSummary()');
  check('预览给出改动统计', formatSummary.includes('标点转全角 2 处'), formatSummary);
  check(
    '预览显示整理后的正文（缩进 + 标点已转）',
    (await exec('window.__cwTest.formatPreview()')).startsWith('　　他说，"你好。"'),
    await exec('window.__cwTest.formatPreview()')
  );

  await exec("document.getElementById('btn-format-apply').click()");
  await waitFor('window.__cwTest.formatDialogOpen() === false');
  await sleep(200);
  const formattedText = await exec('window.__cwTest.text()');
  state.formattedText = formattedText; // 第 23 组核对「显示预设不碰正文」用同一份正文
  check(
    '套用后编辑区是整理后的正文',
    formattedText === '　　他说，"你好。"\n\n　　第二段',
    formattedText
  );
  check('套用后仍是未保存状态（没有偷偷写盘）', (await exec('window.__cwTest.dirty()')) === true);
  check(
    '套用后磁盘上还是整理前的内容',
    (await exec('window.__cwTest.chapterTextAt(0)')) === '\n原文第一段\n',
    await exec('window.__cwTest.chapterTextAt(0)')
  );

  // 撤销：Ctrl+Z / 菜单「撤销上次整理」
  check('整理后可以撤销', (await exec('window.__cwTest.canUndoFormat()')) === true);
  await exec('window.__cwTest.undoFormat()');
  check('撤销整理恢复整理前的正文', (await exec('window.__cwTest.text()')) === messyText);
  check('撤销后快照栈清空', (await exec('window.__cwTest.formatUndoDepth()')) === 0);

  // 再整理一次并保存：磁盘落盘为 CRLF，正文整理结果一致
  await exec(`window.__cwTest.writeFormatOptions(${JSON.stringify({
    indent: true,
    blankLines: 'single',
    trimTrailing: true,
    normalizePunct: true,
    removeCjkSpaces: false
  })})`);
  await exec('window.__cwTest.applyFormat()');
  check('再次套用后正文正确', (await exec('window.__cwTest.text()')) === formattedText);

  // 真实键盘路径：Ctrl+Z 撤销整理（document 上的 keydown 拦截）
  await exec(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))"
  );
  await sleep(200);
  check('Ctrl+Z 也能撤销整理', (await exec('window.__cwTest.text()')) === messyText);
  check('Ctrl+Z 撤销后快照栈清空', (await exec('window.__cwTest.formatUndoDepth()')) === 0);

  await exec('window.__cwTest.applyFormat()');
  check('撤销后再整理回来', (await exec('window.__cwTest.text()')) === formattedText);

  const formatSaveResult = await exec('window.__cwTest.save()');
  check('整理后保存成功', Boolean(formatSaveResult && formatSaveResult.ok === true), formatSaveResult);
  const rawOnDisk = await fs.readFile(path.join(currentBookDir, currentChapterFile), 'utf8');
  check(
    '落盘正文是 CRLF + 全角缩进（记事本友好）',
    rawOnDisk === '　　他说，"你好。"\r\n\r\n　　第二段',
    rawOnDisk
  );
  check(
    '保存后回读与整理结果一致',
    (await exec('window.__cwTest.chapterTextAt(0)')) === formattedText
  );

  // 幂等：已经是整理后的正文，再整理一次不应重复加缩进
  await exec('window.__cwTest.applyFormat()');
  check('重复整理不会重复叠加缩进', (await exec('window.__cwTest.text()')) === formattedText);
  check('无改动的整理不往撤销栈里塞东西', (await exec('window.__cwTest.formatUndoDepth()')) === 1);
};
