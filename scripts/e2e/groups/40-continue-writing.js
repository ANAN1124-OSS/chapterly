// E2E 第 40 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：新建「继续写作测试书」
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group40ContinueWriting(t) {
  const { exec, check, waitFor, storage, userData } = t;

  // 40. 继续上次写作 + Ctrl+G 跳章（v0.5-4）
  await exec("window.__cwTest.newBook('继续写作测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const resumeBookPath = await exec('window.__cwTest.bookPathValue()');
  await exec("window.__cwTest.renameChapterAt(0, '起风')");
  await exec("window.__cwTest.newChapter('夜雨')");
  await exec("window.__cwTest.newChapter('远行')");
  await exec("window.__cwTest.newChapter('归途')");
  const resumeTexts = ['起风正文。', '夜雨正文。', '远行正文。', '归途正文。'];
  for (let i = 0; i < resumeTexts.length; i += 1) {
    await exec(`window.__cwTest.switchTo(${i}, 'discard')`);
    await exec(`window.__cwTest.setText(${JSON.stringify(resumeTexts[i])})`);
    await exec('window.__cwTest.save()');
  }
  check(
    '继续写作：准备了 4 章且正文都已落盘',
    JSON.stringify(await exec('window.__cwTest.chapterTitles()')) ===
      JSON.stringify(['第1章：起风', '第2章：夜雨', '第3章：远行', '第4章：归途'])
  );

  // 跳章 / 继续写作全程只读正文：先记下 4 个 txt 的大小和 mtime
  const resumeMeta = await storage.readBookMeta(resumeBookPath);
  const resumeFiles = resumeMeta.chapters.map((chapter) => path.join(resumeBookPath, chapter.file));
  const resumeStatBefore = [];
  for (const filePath of resumeFiles) {
    const stat = await fs.stat(filePath);
    resumeStatBefore.push({ size: stat.size, mtimeMs: stat.mtimeMs });
  }

  // 40a. 切到第 4 章后回书架：顶部出现「继续写《书名》· 第4章」
  await exec("window.__cwTest.switchTo(3, 'discard')");
  const resumeChapterId = await exec('window.__cwTest.currentChapterId()');
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await waitFor('window.__cwTest.continueVisible() === true');
  const continueText = await exec('window.__cwTest.continueText()');
  check(
    '继续写作：书架顶部显示上次这本书和第 4 章',
    continueText.includes('继续写《继续写作测试书》') && continueText.includes('第4章：归途'),
    continueText
  );
  const continueMetaText = await exec('window.__cwTest.continueMeta()');
  check(
    '继续写作：入口显示最后写作时间和总章数',
    continueMetaText.includes('最后写作') && continueMetaText.includes('共 4 章'),
    continueMetaText
  );

  const recentOnShelf = await exec('window.api.getRecentBook()');
  check(
    '继续写作：lastBook 记录了路径 / 章节 id / 下标 / 章名 / 时间戳',
    recentOnShelf.ok === true &&
      recentOnShelf.data.path === resumeBookPath &&
      recentOnShelf.data.title === '继续写作测试书' &&
      recentOnShelf.data.chapterId === resumeChapterId &&
      recentOnShelf.data.chapterIndex === 3 &&
      recentOnShelf.data.chapterName === '归途' &&
      recentOnShelf.data.at > 0,
    recentOnShelf
  );
  const diskConfig = JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8'));
  check(
    '继续写作：lastBook 真的写进了 config.json，没碰书库',
    diskConfig.lastBook &&
      diskConfig.lastBook.path === resumeBookPath &&
      diskConfig.lastBook.chapterId === resumeChapterId &&
      diskConfig.lastBook.chapterIndex === 3,
    diskConfig.lastBook
  );

  // 40b. 点一下入口：打开书并回到上次那一章
  await exec('window.__cwTest.clickContinue()');
  await waitFor("window.__cwTest.view() === 'editor'");
  check(
    '继续写作：点一下就回到上次编辑的第 4 章',
    (await exec('window.__cwTest.currentIndex()')) === 3 &&
      (await exec('window.__cwTest.currentTitle()')) === '第4章：归途'
  );

  // 40c. Ctrl+G：输入章号 → 回车跳过去
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true }))");
  await waitFor('window.__cwTest.jumpDialogOpen() === true');
  check(
    'Ctrl+G：打开跳章对话框，默认提示共 4 章',
    (await exec('window.__cwTest.jumpSummary()')).includes('共 4 章'),
    await exec('window.__cwTest.jumpSummary()')
  );
  await exec("window.__cwTest.setJumpQuery('2')");
  const jumpNumberSummary = await exec('window.__cwTest.jumpSummary()');
  check(
    'Ctrl+G：输入章号 2 精确显示第2章：夜雨、跳转按钮可用',
    jumpNumberSummary.includes('第2章：夜雨') &&
      (await exec('window.__cwTest.jumpConfirmDisabled()')) === false,
    jumpNumberSummary
  );
  await exec(
    "document.getElementById('jump-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))"
  );
  await waitFor("window.__cwTest.currentTitle() === '第2章：夜雨'");
  check(
    'Ctrl+G：回车跳到第 2 章并收起对话框',
    (await exec('window.__cwTest.jumpDialogOpen()')) === false &&
      (await exec('window.__cwTest.currentIndex()')) === 1
  );

  // 40d. Ctrl+G：章名关键词 → 列出结果并点选
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true }))");
  await waitFor('window.__cwTest.jumpDialogOpen() === true');
  await exec("window.__cwTest.setJumpQuery('远')");
  const jumpNameSummary = await exec('window.__cwTest.jumpSummary()');
  const jumpResultTexts = await exec('window.__cwTest.jumpResultTexts()');
  check(
    'Ctrl+G：章名关键词找到 1 章并列出（带状态）',
    jumpNameSummary.includes('找到 1 章匹配') &&
      jumpResultTexts.length === 1 &&
      jumpResultTexts[0].includes('第3章：远行') &&
      jumpResultTexts[0].includes('草稿'),
    jumpResultTexts
  );
  await exec('window.__cwTest.clickJumpResult(0)');
  await waitFor("window.__cwTest.currentTitle() === '第3章：远行'");
  check('Ctrl+G：点结果跳到第 3 章', (await exec('window.__cwTest.currentIndex()')) === 2);

  // 40e. 章号越界：明确提示 + 禁用跳转；Esc 关闭
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true }))");
  await waitFor('window.__cwTest.jumpDialogOpen() === true');
  await exec("window.__cwTest.setJumpQuery('99')");
  const jumpOutSummary = await exec('window.__cwTest.jumpSummary()');
  check(
    'Ctrl+G：章号超出范围时提示 1–4 且跳转按钮不可点',
    jumpOutSummary.includes('没有第 99 章') &&
      jumpOutSummary.includes('1–4') &&
      (await exec('window.__cwTest.jumpConfirmDisabled()')) === true,
    jumpOutSummary
  );
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  check('Ctrl+G：Esc 关闭跳章对话框', (await exec('window.__cwTest.jumpDialogOpen()')) === false);

  // 40f. 跳章碰到未保存内容：照常弹「保存 / 不保存 / 取消」，选不保存后磁盘不变
  await exec("window.__cwTest.setText('这是没保存的远行改动')");
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true }))");
  await waitFor('window.__cwTest.jumpDialogOpen() === true');
  await exec("window.__cwTest.setJumpQuery('1')");
  await exec(
    "document.getElementById('jump-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))"
  );
  await waitFor('window.__cwTest.modalOpen() === true');
  check(
    'Ctrl+G：有未保存修改时先弹「切换章节前保存」',
    (await exec('window.__cwTest.dialog()')) === '切换章节前保存',
    await exec('window.__cwTest.dialog()')
  );
  await exec("window.__cwTest.answerModal('discard')");
  await waitFor("window.__cwTest.currentTitle() === '第1章：起风'");
  check(
    'Ctrl+G：选「不保存」后跳章成功，未保存内容没有偷偷写盘',
    (await exec('window.__cwTest.chapterTextAt(2)')) === '远行正文。' &&
      (await exec('window.__cwTest.jumpDialogOpen()')) === false
  );

  // 40g. lastOpenChapterId 失效（例如手改书目/旧数据）时打开书要兜底到第 1 章
  const fallbackMeta = await storage.readBookMeta(resumeBookPath);
  await storage.writeBookMeta(resumeBookPath, { ...fallbackMeta, lastOpenChapterId: 'ch_999' });
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(resumeBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  check(
    '继续写作：书目里的上次章节失效时回退到第 1 章（不报错）',
    (await exec('window.__cwTest.currentIndex()')) === 0,
    await exec('window.__cwTest.currentTitle()')
  );
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await waitFor('window.__cwTest.continueVisible() === true');
  check(
    '继续写作：兜底到第 1 章后，书架入口也跟着更新',
    (await exec('window.__cwTest.continueText()')).includes('第1章：起风'),
    await exec('window.__cwTest.continueText()')
  );
  // 书架页按 Ctrl+G 不应该弹跳章框（只在写作页生效）
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true }))");
  check('Ctrl+G：书架页不会弹出跳章对话框', (await exec('window.__cwTest.jumpDialogOpen()')) === false);

  // 40h. 全程只读正文：4 个 txt 的大小 / mtime 没变
  let resumeFilesUntouched = true;
  for (let i = 0; i < resumeFiles.length; i += 1) {
    const stat = await fs.stat(resumeFiles[i]);
    if (stat.size !== resumeStatBefore[i].size || stat.mtimeMs !== resumeStatBefore[i].mtimeMs) {
      resumeFilesUntouched = false;
    }
  }
  check('继续写作 / 跳章：章节 txt 大小和 mtime 一个都没变（纯读）', resumeFilesUntouched);

  // 40i. 书被删掉后入口自动隐藏，不会指向不存在的位置
  await exec("window.__cwTest.deleteBookByFolder('继续写作测试书', { skipConfirm: true })");
  await waitFor('window.__cwTest.continueVisible() === false');
  check(
    '继续写作：上次那本书被删掉后入口自动隐藏',
    (await exec('window.__cwTest.continueVisible()')) === false
  );
};
