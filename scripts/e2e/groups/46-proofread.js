// E2E 第 46 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：新建「校对测试书」
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group46Proofread(t) {
  const {
    exec,
    check,
    waitFor,
    storage,
    userData,
    booksRoot,
    waitForFile,
    waitForSummary,
    fileExists,
    exporter,
    readZip,
    assertWellFormedXml,
    saveDialog,
    withSavePath,
    restoreSaveDialog,
    openExportDialogFromMenu,
    chooseExportRange
  } = t;

  // 46. 校对面板（v0.7-2，提案 5.1）：只报告、不改动；当前章 / 整本都能跑，点一条跳到正文
  await exec("window.__cwTest.newBook('校对测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const pfBookPath = await exec('window.__cwTest.bookPathValue()');
  await exec("window.__cwTest.renameChapterAt(0, '海边')");
  await exec("window.__cwTest.newChapter('长夜')");
  await exec("window.__cwTest.newChapter('尾声')");
  // 第 1 章：半角逗号 1 处、3 次「突然」、连续标点「？！？」、3 个连续空行
  const pfCh1 = '他走在海边,风很大。\n突然下雨了，突然又停了，突然又下起来。\n他喊：「？！？」\n\n\n';
  // 第 2 章：一段 520 字的超长段落（字符互不相同，避免顺手触发重复用词）
  const pfLongText = Array.from({ length: 520 }, (_v, i) =>
    String.fromCharCode(0x4e00 + ((i * 61 + 7) % 1500))
  ).join('');
  // 第 3 章：干净正文（只有 1 个空行，不算多余空行）
  const pfClean = '雨停了。\n\n他收起伞。';
  const pfTexts = [pfCh1, pfLongText, pfClean];
  for (let i = 0; i < pfTexts.length; i += 1) {
    await exec(`window.__cwTest.switchTo(${i}, 'discard')`);
    await exec(`window.__cwTest.setText(${JSON.stringify(pfTexts[i])})`);
    await exec('window.__cwTest.save()');
  }
  await exec("window.__cwTest.switchTo(0, 'discard')");
  const pfMetaBefore = await storage.readBookMeta(pfBookPath);
  const pfDiskBefore = [];
  const pfStatBefore = [];
  for (const chapter of pfMetaBefore.chapters) {
    const filePath = path.join(pfBookPath, chapter.file);
    pfDiskBefore.push((await storage.loadChapterText(pfBookPath, chapter.file)).text);
    const stat = await fs.stat(filePath);
    pfStatBefore.push({ size: stat.size, mtimeMs: stat.mtimeMs });
  }
  check(
    '校对：准备了一本 3 章的书（第 1 章有 4 类可疑、第 2 章超长段落、第 3 章干净）',
    JSON.stringify(pfDiskBefore) === JSON.stringify(pfTexts) &&
      pfLongText.length === 520 &&
      (await exec('window.__cwTest.chapterTitles()')).join(',') === '第1章：海边,第2章：长夜,第3章：尾声',
    {
      texts: pfDiskBefore.map((text) => text.length),
      diskEqual: JSON.stringify(pfDiskBefore) === JSON.stringify(pfTexts),
      titles: await exec('window.__cwTest.chapterTitles()')
    }
  );

  // 46a. 入口 + 打开面板自动检查当前章（只读，不写盘）
  check(
    '校对：写作页顶栏有「校对」按钮',
    (await exec("document.getElementById('btn-proofread').textContent")) === '校对'
  );
  await exec('window.__cwTest.openProofreadPanel()');
  await waitFor("window.__cwTest.proofreadSummary().includes('本章共 4 处可疑')");
  const pfCurrent = await exec('window.__cwTest.proofreadPayload()');
  check(
    '校对：打开面板自动检查当前章，4 类问题各 1 条',
    pfCurrent &&
      pfCurrent.scope === 'current' &&
      pfCurrent.total === 4 &&
      pfCurrent.byRule['halfwidth-punct'] === 1 &&
      pfCurrent.byRule['repeat-word'] === 1 &&
      pfCurrent.byRule['punct-run'] === 1 &&
      pfCurrent.byRule['blank-lines'] === 1 &&
      pfCurrent.byRule['long-paragraph'] === 0 &&
      (await exec('window.__cwTest.proofreadRowCount()')) === 4,
    pfCurrent
  );
  check(
    '校对：结果按规则分类、带行号 / 位置 / 上下文片段',
    (await exec('window.__cwTest.proofreadRuleTexts()')).join(',') ===
      '半角标点,重复用词,连续标点,多余空行' &&
      (await exec('window.__cwTest.proofreadRowTexts()')).every((text) =>
        /第 \d+ 行 · 第 \d+ 字/.test(text)
      ) &&
      (await exec('window.__cwTest.proofreadRowTexts()')).some((text) =>
        text.includes('半角标点「,」建议改成「，」')
      ),
    await exec('window.__cwTest.proofreadRowTexts()')
  );
  check(
    '校对：检查过程只读——当前章仍是已保存状态',
    (await exec('window.__cwTest.dirty()')) === false &&
      (await exec('window.__cwTest.text()')) === pfCh1 &&
      (await exec('window.__cwTest.proofreadSummary()')).includes('半角标点 1')
  );

  // 46b. 点结果跳到正文：选中那一处标点，面板关闭，正文不变
  const pfCommaIssue = pfCurrent.issues.find((issue) => issue.rule === 'halfwidth-punct');
  const pfCommaRow = pfCurrent.issues.indexOf(pfCommaIssue);
  await exec(`window.__cwTest.clickProofreadRow(${pfCommaRow})`);
  await waitFor('window.__cwTest.proofreadPanelOpen() === false');
  const pfCommaSelection = await exec('window.__cwTest.selection()');
  const pfCommaText = await exec('window.__cwTest.selectionText()');
  check(
    '校对：点「半角标点」结果会选中正文里的那一处并关闭面板',
    pfCommaIssue.index === pfCh1.indexOf(',') &&
      pfCommaSelection.start === pfCh1.indexOf(',') &&
      pfCommaSelection.end === pfCh1.indexOf(',') + 1 &&
      pfCommaText === ',' &&
      (await exec('window.__cwTest.dirty()')) === false &&
      (await storage.loadChapterText(pfBookPath, pfMetaBefore.chapters[0].file)).text === pfCh1,
    { issue: pfCommaIssue, selection: pfCommaSelection, text: pfCommaText }
  );

  // 46c. 整本校对：列出涉及哪几章，点长段落结果会切章并定位
  await exec('window.__cwTest.openProofreadPanel()');
  await waitFor("window.__cwTest.proofreadSummary().includes('本章共 4 处可疑')");
  await exec("window.__cwTest.setProofreadScope('book')");
  const pfBookRun = await exec('window.__cwTest.proofreadRun()');
  const pfBook = await exec('window.__cwTest.proofreadPayload()');
  const pfLongIssue = pfBook && pfBook.issues.find((issue) => issue.rule === 'long-paragraph');
  check(
    '校对：整本模式通读全书（3 章），共 5 处：第 1 章 4 处 + 第 2 章超长段落',
    pfBookRun &&
      pfBookRun.ok === true &&
      pfBookRun.scope === 'book' &&
      pfBook &&
      pfBook.scope === 'book' &&
      pfBook.chapterCount === 3 &&
      pfBook.chapterHitCount === 2 &&
      pfBook.total === 5 &&
      pfBook.byRule['long-paragraph'] === 1 &&
      Boolean(pfLongIssue) &&
      pfLongIssue.chapterIndex === 1 &&
      pfLongIssue.message.includes('520 字') &&
      (await exec('window.__cwTest.proofreadSummary()')).includes('全书 3 章共 5 处可疑，涉及 2 章'),
    { run: pfBookRun, payload: pfBook }
  );
  check(
    '校对：整本结果带章名（长夜），干净的第 3 章没有结果',
    (await exec('window.__cwTest.proofreadRowTexts()')).some((text) => text.includes('第2章：长夜')) &&
      !(await exec('window.__cwTest.proofreadRowTexts()')).some((text) => text.includes('尾声')) &&
      pfBook.issues.every((issue) => issue.chapterIndex !== 2)
  );
  const pfLongRow = pfBook.issues.indexOf(pfLongIssue);
  await exec(`window.__cwTest.clickProofreadRow(${pfLongRow})`);
  await waitFor(
    `window.__cwTest.currentTitle().includes('长夜') && window.__cwTest.selectionText() === ${JSON.stringify(
      pfLongText.slice(0, 24)
    )}`
  );
  const pfLongSelectionText = await exec('window.__cwTest.selectionText()');
  check(
    '校对：点整本里的「超长段落」会切到那一章并选中段首',
    (await exec('window.__cwTest.currentTitle()')).includes('第2章：长夜') &&
      pfLongSelectionText === pfLongText.slice(0, 24) &&
      (await exec('window.__cwTest.proofreadPanelOpen()')) === false &&
      (await exec('window.__cwTest.dirty()')) === false,
    pfLongSelectionText
  );

  // 46d. 当前章未保存的内容参与检查，但绝不写盘
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await exec("window.__cwTest.setProofreadScope('current')");
  const pfUnsavedText = `${pfCh1}还没有保存的半角逗号,`;
  await exec(`window.__cwTest.setText(${JSON.stringify(pfUnsavedText)})`);
  await exec('window.__cwTest.openProofreadPanel()');
  await waitFor("window.__cwTest.proofreadSummary().includes('本章共 5 处可疑')");
  const pfUnsaved = await exec('window.__cwTest.proofreadPayload()');
  check(
    '校对：当前章未保存的内容也参与检查（多出一处半角逗号），磁盘没被改',
    pfUnsaved &&
      pfUnsaved.total === 5 &&
      pfUnsaved.byRule['halfwidth-punct'] === 2 &&
      (await exec('window.__cwTest.dirty()')) === true &&
      (await storage.loadChapterText(pfBookPath, pfMetaBefore.chapters[0].file)).text === pfCh1,
    { payload: pfUnsaved }
  );
  // 丢弃未保存内容，回到磁盘上的正文
  await exec("window.__cwTest.switchTo(1, 'discard')");
  await exec("window.__cwTest.switchTo(0, 'discard')");
  check(
    '校对：放弃未保存内容后正文回到磁盘版本（校对没有偷偷保存）',
    (await exec('window.__cwTest.text()')) === pfCh1 && (await exec('window.__cwTest.dirty()')) === false
  );

  // 46e. 连续标点不误报「……」；Esc 关闭面板
  await exec(`window.__cwTest.setText(${JSON.stringify('他……没说完。\n\n他喊：「？！？」')})`);
  await exec('window.__cwTest.openProofreadPanel()');
  await waitFor("window.__cwTest.proofreadSummary().includes('本章共 1 处可疑')");
  const pfPunct = await exec('window.__cwTest.proofreadPayload()');
  check(
    '校对：省略号不误报，连续标点只报「？！？」这一处',
    pfPunct &&
      pfPunct.total === 1 &&
      pfPunct.byRule['punct-run'] === 1 &&
      pfPunct.issues[0].message === '连续 3 个标点「？！？」',
    pfPunct
  );
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  check('校对：Esc 关闭面板', (await exec('window.__cwTest.proofreadPanelOpen()')) === false);
  // 把正文恢复成磁盘上的第 1 章（未保存的测试改动直接丢弃）
  await exec("window.__cwTest.switchTo(1, 'discard')");
  await exec("window.__cwTest.switchTo(0, 'discard')");

  // 46f. 干净章：0 条结果 + 明确提示
  await exec("window.__cwTest.switchTo(2, 'discard')");
  await exec('window.__cwTest.openProofreadPanel()');
  await waitFor("window.__cwTest.proofreadSummary().includes('本章没有发现可疑的地方')");
  check(
    '校对：干净章显示 0 条结果与「没有发现可疑」提示',
    (await exec('window.__cwTest.proofreadPayload()')).total === 0 &&
      (await exec('window.__cwTest.proofreadRowCount()')) === 0 &&
      (await exec("document.querySelector('#proofread-results .proofread-empty').textContent")) ===
        '这一章没有发现可疑的地方'
  );
  await exec('window.__cwTest.closeProofreadPanel()');

  // 46g. 全程只读：章节 txt 大小 / mtime、书目 chapters、_trash 都没变化
  let pfFilesUntouched = true;
  for (let i = 0; i < pfMetaBefore.chapters.length; i += 1) {
    const stat = await fs.stat(path.join(pfBookPath, pfMetaBefore.chapters[i].file));
    if (stat.size !== pfStatBefore[i].size || stat.mtimeMs !== pfStatBefore[i].mtimeMs) {
      pfFilesUntouched = false;
    }
  }
  const pfMetaAfter = await storage.readBookMeta(pfBookPath);
  check(
    '校对：章节 txt 与书目 chapters 都没被改写，也没有生成 _trash（纯读）',
    pfFilesUntouched &&
      JSON.stringify(pfMetaAfter.chapters) === JSON.stringify(pfMetaBefore.chapters) &&
      !(await fileExists(path.join(pfBookPath, '_trash'))),
    { untouched: pfFilesUntouched }
  );

  // 46h. 旧数据兼容：v0.4.1 形状（没有 schemaVersion、章节没有 status/note）照常校对
  await exec("window.__cwTest.newBook('校对旧书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const pfLegacyBookPath = await exec('window.__cwTest.bookPathValue()');
  const pfLegacyMetaPath = path.join(pfLegacyBookPath, '书目.json');
  await exec("window.__cwTest.renameChapterAt(0, '起风')");
  await exec(`window.__cwTest.setText(${JSON.stringify('旧书正文,有一个半角逗号。')})`);
  await exec('window.__cwTest.save()');
  const pfLegacyRaw = JSON.parse(await fs.readFile(pfLegacyMetaPath, 'utf8'));
  delete pfLegacyRaw.schemaVersion;
  for (const chapter of pfLegacyRaw.chapters) {
    delete chapter.status;
    delete chapter.note;
  }
  await fs.writeFile(pfLegacyMetaPath, JSON.stringify(pfLegacyRaw, null, 2), 'utf8');
  await exec('window.__cwTest.backToShelf()');
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(pfLegacyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec('window.__cwTest.openProofreadPanel()');
  await waitFor("window.__cwTest.proofreadSummary().includes('本章共 1 处可疑')");
  const pfLegacyAfter = JSON.parse(await fs.readFile(pfLegacyMetaPath, 'utf8'));
  check(
    '校对：没有 schemaVersion 的旧书照常打开并校对，书目不被补字段',
    (await exec('window.__cwTest.currentTitle()')).includes('起风') &&
      (await exec('window.__cwTest.proofreadPayload()')).total === 1 &&
      pfLegacyAfter.schemaVersion === undefined &&
      pfLegacyAfter.chapters.every((chapter) => chapter.status === undefined && chapter.note === undefined),
    { version: pfLegacyAfter.schemaVersion }
  );
  await exec('window.__cwTest.closeProofreadPanel()');

  // 46i. 校对词表（v0.8-6，提案 N6）：作者自己的错别字 / 禁用词，可选「错词 → 建议」。
  // 只报告、不改动、不写盘；词表独立一份，和敏感词表互不覆盖；没有词表时照常跑内置五条规则。
  const pfWordsDir = path.join(userData, '校对词表');
  await fs.mkdir(pfWordsDir, { recursive: true });
  const pfWordsPath = path.join(pfWordsDir, '我的校对词表.txt');
  await fs.writeFile(
    pfWordsPath,
    '做为 => 作为\r\n在再 -> 再看\r\n禁词\r\n# 分组注释\r\n做为 => 当作\r\n\r\n',
    'utf8'
  );
  const pfWordsBytesBefore = await fs.readFile(pfWordsPath);
  const pfWordsStatBefore = await fs.stat(pfWordsPath);

  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const pfSetWordsPath = await exec(
    `window.__cwTest.setProofreadWordsPath(${JSON.stringify(pfWordsPath)})`
  );
  const pfWordsCfg = JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8'));
  check(
    '校对词表：路径落进 config.json（和敏感词表是两个独立字段）',
    pfSetWordsPath === pfWordsPath &&
      pfWordsCfg.proofreadWordsPath === pfWordsPath &&
      pfWordsCfg.sensitiveWordsPath === '' &&
      Object.keys(pfWordsCfg).filter((key) => /proofread/i.test(key)).join(',') === 'proofreadWordsPath',
    { set: pfSetWordsPath, disk: pfWordsCfg.proofreadWordsPath }
  );

  await exec('window.__cwTest.openSettings()');
  await waitFor('window.__cwTest.settingsOpen() === true');
  await waitFor("window.__cwTest.proofreadSettingsStatus().includes('3 个词')");
  const pfWordsSettingsStatus = await exec('window.__cwTest.proofreadSettingsStatus()');
  check(
    '校对词表：设置里显示路径 / 词数 / 带建议数与忽略的行',
    (await exec('window.__cwTest.proofreadSettingsVisible()')) === true &&
      (await exec('window.__cwTest.proofreadSettingsPath()')) === pfWordsPath &&
      pfWordsSettingsStatus.includes('3 个词') &&
      pfWordsSettingsStatus.includes('2 个带建议') &&
      pfWordsSettingsStatus.includes('1 个重复') &&
      pfWordsSettingsStatus.includes('1 行注释'),
    pfWordsSettingsStatus
  );
  await exec('window.__cwTest.closeSettings()');
  await waitFor('window.__cwTest.settingsOpen() === false');

  // 46i-1. 造一本两章的书：第 1 章 4 处词表命中（做为 ×2、禁词 ×2），第 2 章 1 处
  await exec("window.__cwTest.newBook('校对词表测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const pfwBookPath = await exec('window.__cwTest.bookPathValue()');
  await exec("window.__cwTest.renameChapterAt(0, '开端')");
  const pfwCh1 = '他做为旁观者站在门口。\n他决定做为见证人。\n这里有两个禁词和禁词。';
  await exec(`window.__cwTest.setText(${JSON.stringify(pfwCh1)})`);
  await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false');
  await exec("window.__cwTest.newChapter('续章')");
  await waitFor("window.__cwTest.currentTitle().includes('续章')");
  const pfwCh2 = '做为另一个例子。';
  await exec(`window.__cwTest.setText(${JSON.stringify(pfwCh2)})`);
  await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false');
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await waitFor("window.__cwTest.currentTitle().includes('开端')");

  const pfwMetaBefore = await storage.readBookMeta(pfwBookPath);
  const pfwChaptersBefore = JSON.stringify(pfwMetaBefore.chapters);
  const pfwStatBefore = [];
  for (const chapter of pfwMetaBefore.chapters) {
    const stat = await fs.stat(path.join(pfwBookPath, chapter.file));
    pfwStatBefore.push({ file: chapter.file, size: stat.size, mtimeMs: stat.mtimeMs });
  }

  // 46i-2. 当前章：4 处命中都是「自定义词表」，带建议 / 行号列号 / 上下文；点一条只改选区
  await exec('window.__cwTest.openProofreadPanel()');
  await waitFor("window.__cwTest.proofreadSummary().includes('本章共 4 处可疑')");
  const pfwCurrent = await exec('window.__cwTest.proofreadPayload()');
  check(
    '校对词表：当前章 4 处命中按「自定义词表」统计，带建议、词条数与规则标签',
    pfwCurrent &&
      pfwCurrent.scope === 'current' &&
      pfwCurrent.total === 4 &&
      pfwCurrent.byRule['custom-word'] === 4 &&
      pfwCurrent.customWordCount === 3 &&
      pfwCurrent.wordList &&
      pfwCurrent.wordList.ok === true &&
      pfwCurrent.wordList.count === 3 &&
      pfwCurrent.issues[0].index === 1 &&
      pfwCurrent.issues[0].suggestion === '作为' &&
      pfwCurrent.issues[0].line === 1 &&
      pfwCurrent.issues[0].column === 2 &&
      (await exec('window.__cwTest.proofreadRuleTexts()')).join(',') ===
        '自定义词表,自定义词表,自定义词表,自定义词表' &&
      (await exec('window.__cwTest.proofreadRowTexts()')).some((text) =>
        text.includes('词表里的「做为」建议改成「作为」')
      ),
    pfwCurrent
  );
  check(
    '校对词表：面板顶部显示词表状态（文件名 / 3 个词 / 2 个带建议）',
    (await exec('window.__cwTest.proofreadWordListText()')).includes('我的校对词表.txt') &&
      (await exec('window.__cwTest.proofreadWordListText()')).includes('3 个词') &&
      (await exec('window.__cwTest.proofreadWordListText()')).includes('2 个带建议'),
    await exec('window.__cwTest.proofreadWordListText()')
  );
  await exec('window.__cwTest.clickProofreadRow(0)');
  await waitFor('window.__cwTest.proofreadPanelOpen() === false');
  const pfwSelection = await exec('window.__cwTest.selection()');
  check(
    '校对词表：点结果会选中对应的错词并关闭面板（正文 / 磁盘不变）',
    pfwSelection.start === 1 &&
      pfwSelection.end === 3 &&
      (await exec('window.__cwTest.selectionText()')) === '做为' &&
      (await exec('window.__cwTest.text()')) === pfwCh1 &&
      (await exec('window.__cwTest.dirty()')) === false &&
      (await storage.loadChapterText(pfwBookPath, pfwMetaBefore.chapters[0].file)).text === pfwCh1,
    pfwSelection
  );

  // 46i-3. 整本：跨章 5 处（列 2 章）；点第 2 章的结果会切章并选中
  await exec('window.__cwTest.openProofreadPanel()');
  await waitFor("window.__cwTest.proofreadSummary().includes('本章共 4 处可疑')");
  await exec("window.__cwTest.setProofreadScope('book')");
  const pfwBookRun = await exec('window.__cwTest.proofreadRun()');
  const pfwBook = await exec('window.__cwTest.proofreadPayload()');
  check(
    '校对词表：整本模式跨章统计 5 处、涉及 2 章，结果带章名',
    pfwBookRun &&
      pfwBookRun.ok === true &&
      pfwBook.scope === 'book' &&
      pfwBook.total === 5 &&
      pfwBook.chapterCount === 2 &&
      pfwBook.chapterHitCount === 2 &&
      pfwBook.byRule['custom-word'] === 5 &&
      (await exec('window.__cwTest.proofreadSummary()')).includes('全书 2 章共 5 处可疑，涉及 2 章') &&
      (await exec('window.__cwTest.proofreadRowTexts()')).some((text) => text.includes('第2章：续章')),
    pfwBook
  );
  const pfwSecondChapterRow = pfwBook.issues.findIndex((issue) => issue.chapterIndex === 1);
  await exec(`window.__cwTest.clickProofreadRow(${pfwSecondChapterRow})`);
  await waitFor("window.__cwTest.currentTitle().includes('续章')");
  // 切章标题先变，选词是在 loadChapterAt 里那两步异步收尾（记上次打开章节 / 恢复查找书签）
  // 之后才落下的：以前这里读完标题立刻读选区，偶发读到「光标还在末尾」的中间态。
  // 等选区真的出现再断言（等不到照样红，断言本身一个字没改）。
  await waitFor("window.__cwTest.selectionText() === '做为'", 5000);
  const pfwSecondSelection = {
    selection: await exec('window.__cwTest.selection()'),
    selectionText: await exec('window.__cwTest.selectionText()'),
    dirty: await exec('window.__cwTest.dirty()'),
    text: (await exec('window.__cwTest.text()')).slice(0, 40)
  };
  check(
    '校对词表：点第 2 章的命中会切章并选中那个词',
    pfwSecondSelection.selectionText === '做为' &&
      (await exec('window.__cwTest.text()')) === pfwCh2 &&
      pfwSecondSelection.dirty === false &&
      (await storage.loadChapterText(pfwBookPath, pfwMetaBefore.chapters[1].file)).text === pfwCh2,
    pfwSecondSelection
  );

  // 46i-4. 当前章未保存的内容也参与（只参与检查，不写盘）
  await exec("window.__cwTest.setProofreadScope('current')");
  await exec(`window.__cwTest.setText(${JSON.stringify('未保存的做为。')})`);
  await waitFor('window.__cwTest.dirty() === true');
  await exec('window.__cwTest.openProofreadPanel()');
  await waitFor("window.__cwTest.proofreadSummary().includes('本章共 1 处可疑')");
  const pfwUnsaved = await exec('window.__cwTest.proofreadPayload()');
  check(
    '校对词表：未保存内容参与匹配，但磁盘仍是原正文、书目 / 章节缓存不变',
    pfwUnsaved.total === 1 &&
      pfwUnsaved.byRule['custom-word'] === 1 &&
      (await storage.loadChapterText(pfwBookPath, pfwMetaBefore.chapters[1].file)).text === pfwCh2 &&
      JSON.stringify((await storage.readBookMeta(pfwBookPath)).chapters) === pfwChaptersBefore
  );
  await exec('window.__cwTest.closeProofreadPanel()');
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await waitFor("window.__cwTest.currentTitle().includes('开端')");

  // 46i-5. 词表出问题要说清楚，而且不能挡住内置五条规则
  const pfWordsMoved = `${pfWordsPath}.moved`;
  await fs.rename(pfWordsPath, pfWordsMoved);
  await exec('window.__cwTest.openProofreadPanel()');
  await waitFor("window.__cwTest.proofreadWordListText().includes('词表文件不存在')");
  await waitFor("window.__cwTest.proofreadSummary().includes('本章没有发现可疑的地方')");
  const pfwMissing = await exec('window.__cwTest.proofreadPayload()');
  check(
    '校对词表：词表文件不存在时给出明确提示，照常跑内置规则',
    (await exec('window.__cwTest.proofreadWordListText()')).includes('不存在') &&
      pfwMissing.total === 0 &&
      pfwMissing.wordList.ok === false &&
      (await exec('window.__cwTest.proofreadRowCount()')) === 0
  );
  await exec('window.__cwTest.closeProofreadPanel()');
  await fs.rename(pfWordsMoved, pfWordsPath);

  const pfWordsBadPath = path.join(pfWordsDir, '伪装校对词表.txt');
  await fs.writeFile(pfWordsBadPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]));
  await exec(`window.__cwTest.setProofreadWordsPath(${JSON.stringify(pfWordsBadPath)})`);
  await exec('window.__cwTest.openProofreadPanel()');
  await waitFor("window.__cwTest.proofreadWordListText().includes('不像是纯文本')");
  await waitFor("window.__cwTest.proofreadSummary().includes('本章没有发现可疑的地方')");
  check(
    '校对词表：编码 / 内容异常时提示明确，面板不崩、结果为空',
    (await exec('window.__cwTest.proofreadWordListText()')).includes('UTF-8') &&
      (await exec('window.__cwTest.proofreadPayload()')).total === 0
  );
  await exec('window.__cwTest.closeProofreadPanel()');

  const pfWordsEmptyPath = path.join(pfWordsDir, '空校对词表.txt');
  await fs.writeFile(pfWordsEmptyPath, '\r\n # 只有注释\r\n   \r\n', 'utf8');
  await exec(`window.__cwTest.setProofreadWordsPath(${JSON.stringify(pfWordsEmptyPath)})`);
  await exec('window.__cwTest.openProofreadPanel()');
  await waitFor("window.__cwTest.proofreadWordListText().includes('没有有效的词')");
  await waitFor("window.__cwTest.proofreadSummary().includes('本章没有发现可疑的地方')");
  check(
    '校对词表：空词表（只有空行 / 注释）明确提示，不产生命中',
    (await exec('window.__cwTest.proofreadRowCount()')) === 0 &&
      (await exec('window.__cwTest.proofreadPayload()')).total === 0
  );
  await exec('window.__cwTest.closeProofreadPanel()');
  await exec(`window.__cwTest.setProofreadWordsPath(${JSON.stringify(pfWordsPath)})`);

  // 46i-6. 全程只读：章节 txt 大小 / mtime、书目 chapters、_trash、词表字节都没变
  let pfwFilesUntouched = true;
  for (const item of pfwStatBefore) {
    const stat = await fs.stat(path.join(pfwBookPath, item.file));
    if (stat.size !== item.size || stat.mtimeMs !== item.mtimeMs) pfwFilesUntouched = false;
  }
  const pfwMetaAfter = await storage.readBookMeta(pfwBookPath);
  const pfWordsBytesAfter = await fs.readFile(pfWordsPath);
  const pfWordsStatAfter = await fs.stat(pfWordsPath);
  check(
    '校对词表：只读——章节 txt / 书目 / 词表一个字节没改，也没有生成 _trash',
    pfwFilesUntouched &&
      JSON.stringify(pfwMetaAfter.chapters) === pfwChaptersBefore &&
      pfWordsBytesAfter.equals(pfWordsBytesBefore) &&
      pfWordsStatAfter.mtimeMs === pfWordsStatBefore.mtimeMs &&
      !(await fileExists(path.join(pfwBookPath, '_trash'))),
    { untouched: pfwFilesUntouched }
  );

  // 46i-7. 词表是全局设置：写作页的按书设置里不显示
  await exec('window.__cwTest.openSettings()');
  await waitFor('window.__cwTest.settingsOpen() === true');
  check(
    '校对词表：写作页的按书设置里不显示（全局设置）',
    (await exec('window.__cwTest.proofreadSettingsVisible()')) === false
  );
  await exec('window.__cwTest.closeSettings()');
  await waitFor('window.__cwTest.settingsOpen() === false');

  // 46i-8. 旧数据兼容：v0.4.1 形状的旧书照常校对，书目不被补字段
  const pfWordsLegacyBefore = await fs.readFile(pfLegacyMetaPath, 'utf8');
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(pfLegacyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec('window.__cwTest.openProofreadPanel()');
  await waitFor("window.__cwTest.proofreadSummary().includes('本章共 1 处可疑')");
  const pfwLegacy = await exec('window.__cwTest.proofreadPayload()');
  const pfWordsLegacyAfter = await fs.readFile(pfLegacyMetaPath, 'utf8');
  check(
    '校对词表：v0.4.1 旧书照常校对（词表只加自己的命中），书目不被补字段',
    pfwLegacy.total === 1 &&
      pfwLegacy.byRule['custom-word'] === 0 &&
      pfwLegacy.customWordCount === 3 &&
      pfWordsLegacyAfter === pfWordsLegacyBefore &&
      pfWordsLegacyAfter.includes('"schemaVersion"') === false,
    { version: JSON.parse(pfWordsLegacyAfter).schemaVersion }
  );
  await exec('window.__cwTest.closeProofreadPanel()');

  // 46i-9. 收尾：清掉校对词表路径，配置只剩这一个可选字段的变化
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec('window.__cwTest.setProofreadWordsPath("")');
  const pfWordsCfgCleared = JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8'));
  check(
    '校对词表：清除后配置落盘为空串，敏感词表字段不受影响',
    pfWordsCfgCleared.proofreadWordsPath === '' &&
      pfWordsCfgCleared.sensitiveWordsPath === '' &&
      Object.keys(pfWordsCfgCleared).filter((key) => /proofread/i.test(key)).join(',') ===
        'proofreadWordsPath'
  );

  // 46j. 导出简繁转换（v0.8-7，提案 N7）：只改导出的副本（TXT / EPUB），
  // 书库里的章节 txt / 书目一个字节都不动；默认「不转换」，档位是全局设置。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");

  // 46j-1. 设置里选「简体 → 繁体」并保存（全局设置；旧配置没有这个键 = 不转换）
  await exec('window.__cwTest.openSettings()');
  await waitFor('window.__cwTest.settingsOpen() === true');
  check(
    '简繁导出：设置里有「导出」档位，默认不转换',
    (await exec('window.__cwTest.exportConversionSettingsVisible()')) === true &&
      (await exec('window.__cwTest.exportConversionValue()')) === ''
  );
  await exec(
    "(() => { const el = document.getElementById('settings-export-conversion'); el.value = 's2t'; el.dispatchEvent(new Event('change', { bubbles: true })); })()"
  );
  await exec('window.__cwTest.saveSettings()');
  await waitFor('window.__cwTest.settingsOpen() === false');
  const s2tCfgAfterSet = JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8'));
  check(
    '简繁导出：档位落进 config.json（只多一个 exportConversion 字段）',
    s2tCfgAfterSet.exportConversion === 's2t' &&
      Object.keys(s2tCfgAfterSet).filter((key) => /conversion/i.test(key)).join(',') ===
        'exportConversion',
    s2tCfgAfterSet.exportConversion
  );

  // 46j-2. 造一本两章的简体书：第 1 章含发 / 干 / 后 / 里 / 面 等歧义字，第 2 章章名也带字
  await exec("window.__cwTest.newBook('简繁导出测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const s2tBookPath = await exec('window.__cwTest.bookPathValue()');
  await exec("window.__cwTest.renameChapterAt(0, '开端')");
  const s2tCh1 = '后来他发现，门后说话的人头发干净。\n\n什么也没有。';
  await exec(`window.__cwTest.setText(${JSON.stringify(s2tCh1)})`);
  await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false');
  await exec("window.__cwTest.newChapter('说话')");
  await waitFor("window.__cwTest.currentTitle().includes('说话')");
  const s2tCh2 = '计划着怎么收获。';
  await exec(`window.__cwTest.setText(${JSON.stringify(s2tCh2)})`);
  await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false');
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await waitFor("window.__cwTest.currentTitle().includes('开端')");

  const s2tMetaBefore = await storage.readBookMeta(s2tBookPath);
  const s2tMetaBytesBefore = await fs.readFile(path.join(s2tBookPath, '书目.json'));
  const s2tChaptersBefore = JSON.stringify(s2tMetaBefore.chapters);
  const s2tStatBefore = [];
  for (const chapter of s2tMetaBefore.chapters) {
    const stat = await fs.stat(path.join(s2tBookPath, chapter.file));
    s2tStatBefore.push({ file: chapter.file, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  const s2tTitles = await exec('window.__cwTest.chapterTitles()');
  check(
    '简繁导出：准备了一本两章的书（简体正文 / 章名）',
    s2tMetaBefore.chapters.length === 2 &&
      JSON.stringify(s2tTitles).includes('开端') &&
      JSON.stringify(s2tTitles).includes('说话'),
    s2tTitles
  );

  // 46j-3. 导出 TXT：对话框说明会转成繁体，生成的副本是繁体，书库不动
  const s2tDir = path.join(path.dirname(booksRoot), 'conversion-exports');
  await fs.mkdir(s2tDir, { recursive: true });
  const s2tTxtPath = path.join(s2tDir, 'book-s2t.txt');
  withSavePath(s2tTxtPath);
  try {
    await openExportDialogFromMenu();
    await waitForSummary('将导出 2 章');
    const s2tDialogNote = await exec('window.__cwTest.exportConversionNote()');
    check(
      '简繁导出：导出对话框说明这次是「简体 → 繁体」',
      s2tDialogNote.includes('简体 → 繁体') &&
        (await exec('window.__cwTest.exportSummary()')).includes('将导出 2 章'),
      s2tDialogNote
    );
    await exec("document.getElementById('btn-export-confirm').click()");
    await waitForFile(s2tTxtPath);
  } finally {
    restoreSaveDialog();
  }
  const s2tTxt = await fs.readFile(s2tTxtPath, 'utf8');
  check(
    '简繁导出：TXT 副本的标题行和正文都转成繁体，BOM / CRLF 保留',
    s2tTxt.startsWith('\uFEFF') &&
      s2tTxt.includes('\r\n') &&
      s2tTxt.includes('第1章：開端') &&
      s2tTxt.includes('第2章：說話') &&
      s2tTxt.includes('後來他發現，門後說話的人頭髮乾淨。') &&
      s2tTxt.includes('什麼也沒有。') &&
      s2tTxt.includes('計劃著怎麼收穫。') &&
      !/后来|门后|说话|头发|干净|计划|收获|什么/.test(s2tTxt),
    s2tTxt
  );

  let s2tFilesUntouched = true;
  for (const item of s2tStatBefore) {
    const stat = await fs.stat(path.join(s2tBookPath, item.file));
    if (stat.size !== item.size || stat.mtimeMs !== item.mtimeMs) s2tFilesUntouched = false;
  }
  const s2tMetaBytesAfter = await fs.readFile(path.join(s2tBookPath, '书目.json'));
  const s2tCfgAfterExport = JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8'));
  check(
    '简繁导出：导出只读——章节 txt / 书目一个字节没改，配置只多了导出目录记忆',
    s2tFilesUntouched &&
      s2tMetaBytesAfter.equals(s2tMetaBytesBefore) &&
      JSON.stringify((await storage.readBookMeta(s2tBookPath)).chapters) === s2tChaptersBefore &&
      s2tCfgAfterExport.exportConversion === 's2t' &&
      !(await fileExists(path.join(s2tBookPath, '_trash'))),
    { untouched: s2tFilesUntouched, exportConversion: s2tCfgAfterExport.exportConversion }
  );

  // 46j-4. 导出 EPUB：书名 / 目录 / 正文也一起转，xml 仍合法
  const s2tEpubPath = path.join(s2tDir, 'book-s2t.epub');
  withSavePath(s2tEpubPath);
  try {
    await openExportDialogFromMenu('epub');
    await waitForSummary('简繁导出测试书.epub');
    await exec("document.getElementById('btn-export-confirm').click()");
    await waitForFile(s2tEpubPath);
  } finally {
    restoreSaveDialog();
  }
  const s2tEpubZip = readZip(await fs.readFile(s2tEpubPath));
  const s2tEpubText = (name) => {
    const entry = s2tEpubZip.entries.find((item) => item.name === name);
    return entry ? entry.data.toString('utf8') : '';
  };
  const s2tEpubCh1 = s2tEpubText('OEBPS/text/chapter-0001.xhtml');
  const s2tEpubNav = s2tEpubText('OEBPS/nav.xhtml');
  const s2tEpubOpf = s2tEpubText('OEBPS/content.opf');
  check(
    '简繁导出：EPUB 副本的书名 / 目录 / 正文也转成繁体',
    s2tEpubCh1.includes('後來他發現，門後說話的人頭髮乾淨。') &&
      s2tEpubCh1.includes('什麼也沒有。') &&
      s2tEpubNav.includes('第1章：開端') &&
      s2tEpubNav.includes('第2章：說話') &&
      s2tEpubOpf.includes('<dc:title>簡繁導出測試書</dc:title>'),
    { nav: s2tEpubNav.slice(0, 240) }
  );
  check(
    '简繁导出：EPUB 导出后书库仍然一个字节没改',
    JSON.stringify((await storage.readBookMeta(s2tBookPath)).chapters) === s2tChaptersBefore &&
      (await storage.loadChapterText(s2tBookPath, s2tMetaBefore.chapters[0].file)).text === s2tCh1 &&
      !(await fileExists(path.join(s2tBookPath, '_trash')))
  );

  // 46j-5. 档位是全局设置：写作页的按书设置里不显示
  await exec('window.__cwTest.openSettings()');
  await waitFor('window.__cwTest.settingsOpen() === true');
  check(
    '简繁导出：写作页的按书设置里不显示（全局设置）',
    (await exec('window.__cwTest.exportConversionSettingsVisible()')) === false
  );
  await exec('window.__cwTest.closeSettings()');
  await waitFor('window.__cwTest.settingsOpen() === false');

  // 46j-6. 当前章未保存的内容也参与转换（只参与这次导出，不写盘）
  const s2tUnsavedText = '未保存的后来。';
  await exec(`window.__cwTest.setText(${JSON.stringify(s2tUnsavedText)})`);
  await waitFor('window.__cwTest.dirty() === true');
  const s2tUnsavedPath = path.join(s2tDir, 'book-s2t-unsaved.txt');
  withSavePath(s2tUnsavedPath);
  try {
    await openExportDialogFromMenu();
    await waitForSummary('将导出 2 章');
    await exec("document.getElementById('btn-export-confirm').click()");
    await waitForFile(s2tUnsavedPath);
  } finally {
    restoreSaveDialog();
  }
  const s2tUnsavedTxt = await fs.readFile(s2tUnsavedPath, 'utf8');
  check(
    '简繁导出：当前章未保存内容也一起转，磁盘仍是旧正文',
    s2tUnsavedTxt.includes('未保存的後來。') &&
      (await storage.loadChapterText(s2tBookPath, s2tMetaBefore.chapters[0].file)).text === s2tCh1 &&
      (await exec('window.__cwTest.dirty()')) === true
  );

  // 46j-7. 繁体 → 简体：换一本繁体正文验证反向转换（改盘前先确认真的写进去了）
  await exec("window.__cwTest.switchTo(1, 'discard')");
  await waitFor("window.__cwTest.currentTitle().includes('说话')");
  const s2tTradText = '後來他發現門後說話的人頭髮乾淨。';
  await exec(`window.__cwTest.setText(${JSON.stringify(s2tTradText)})`);
  await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false');
  const s2tT2sMode = await exec("window.__cwTest.setExportConversion('t2s')");
  const s2tT2sPath = path.join(s2tDir, 'book-t2s.txt');
  withSavePath(s2tT2sPath);
  try {
    await openExportDialogFromMenu();
    await waitForSummary('将导出 2 章');
    const s2tT2sNote = await exec('window.__cwTest.exportConversionNote()');
    check(
      '简繁导出：切到「繁体 → 简体」后对话框跟着变',
      s2tT2sMode === 't2s' && s2tT2sNote.includes('繁体 → 简体'),
      s2tT2sNote
    );
    await exec("document.getElementById('btn-export-confirm').click()");
    await waitForFile(s2tT2sPath);
  } finally {
    restoreSaveDialog();
  }
  const s2tT2sTxt = await fs.readFile(s2tT2sPath, 'utf8');
  check(
    '简繁导出：繁体副本转成简体，原稿仍是繁体',
    s2tT2sTxt.includes('后来他发现门后说话的人头发干净。') &&
      !s2tT2sTxt.includes('後來') &&
      (await storage.loadChapterText(s2tBookPath, s2tMetaBefore.chapters[1].file)).text === s2tTradText
  );

  // 46j-8. 切回「不转换」：导出结果和导出的拼接规则逐字节一致（默认行为完全没变）
  const s2tNoMode = await exec("window.__cwTest.setExportConversion('')");
  const s2tNoConvPath = path.join(s2tDir, 'book-none.txt');
  withSavePath(s2tNoConvPath);
  try {
    await openExportDialogFromMenu();
    await waitForSummary('将导出 2 章');
    const s2tNoConvNote = await exec('window.__cwTest.exportConversionNote()');
    check(
      '简繁导出：档位回到「不转换」时对话框也说明不转换',
      s2tNoMode === '' && s2tNoConvNote.includes('不转换'),
      s2tNoConvNote
    );
    await exec("document.getElementById('btn-export-confirm').click()");
    await waitForFile(s2tNoConvPath);
  } finally {
    restoreSaveDialog();
  }
  const s2tMetaNow = await storage.readBookMeta(s2tBookPath);
  const s2tTextsNow = [];
  for (const chapter of s2tMetaNow.chapters) {
    s2tTextsNow.push((await storage.loadChapterText(s2tBookPath, chapter.file)).text);
  }
  const s2tExpectedNoConv = `\uFEFF${exporter.composeBook(s2tMetaNow, s2tTextsNow)}`;
  const s2tNoConvTxt = await fs.readFile(s2tNoConvPath, 'utf8');
  check(
    '简繁导出：不转换时导出内容与导出拼接规则逐字节一致（默认行为不变）',
    s2tNoConvTxt === s2tExpectedNoConv &&
      s2tNoConvTxt.includes('後來他發現門後說話的人頭髮乾淨。'),
    { bytes: s2tNoConvTxt.length, expected: s2tExpectedNoConv.length }
  );

  // 46j-9. 收尾：档位回到默认空串、书里没有 _trash / 临时文件
  const s2tCfgFinal = JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8'));
  const s2tDirEntries = (await fs.readdir(s2tBookPath)).sort();
  check(
    '简繁导出：收尾档位为「不转换」，书文件夹没有 _trash / 临时文件',
    s2tCfgFinal.exportConversion === '' &&
      s2tDirEntries.every((name) => !name.startsWith('_trash') && !name.startsWith('.tmp-')) &&
      s2tDirEntries.filter((name) => name.endsWith('.txt')).length === 2,
    s2tDirEntries
  );

  // 46k. EPUB 按卷 / 按范围导出（v0.8-8，提案 N8）：只读、只打选中的章；
  // 章号仍按全书顺序，卷名页只生成选中章所在的卷，identifier 按范围区分。
  await exec("window.__cwTest.newBook('EPUB范围导出测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const epubRangeBookPath = await exec('window.__cwTest.bookPathValue()');
  await exec("window.__cwTest.renameChapterAt(0, '楔子')");
  await exec("window.__cwTest.newVolume('上卷')");
  await exec("window.__cwTest.newChapterInVolume(0, '上卷一')");
  await exec("window.__cwTest.newChapterInVolume(0, '上卷二')");
  await exec("window.__cwTest.newVolume('下卷')");
  await exec("window.__cwTest.newChapterInVolume(1, '下卷三')");
  await exec("window.__cwTest.newChapterInVolume(1, '下卷四')");
  await exec("window.__cwTest.newVolume('空卷')");
  const epubRangeVolumeIds = await exec('window.__cwTest.volumeIds()');
  const epubRangeTexts = ['楔子正文。', '上卷第一章正文。', '上卷第二章正文。', '下卷第一章正文。', '下卷第二章正文。'];
  for (let i = 0; i < epubRangeTexts.length; i += 1) {
    await exec(`window.__cwTest.switchTo(${i}, 'discard')`);
    await exec(`window.__cwTest.setText(${JSON.stringify(epubRangeTexts[i])})`);
    await exec('window.__cwTest.save()');
  }
  const epubRangeMeta = await storage.readBookMeta(epubRangeBookPath);
  const epubRangeChaptersBefore = JSON.stringify(epubRangeMeta.chapters);
  const epubRangeStatBefore = [];
  for (const chapter of epubRangeMeta.chapters) {
    const stat = await fs.stat(path.join(epubRangeBookPath, chapter.file));
    epubRangeStatBefore.push({ file: chapter.file, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  const epubRangeCfgBefore = JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8'));
  const epubRangeDir = path.join(path.dirname(booksRoot), 'epub-range-exports');
  await fs.mkdir(epubRangeDir, { recursive: true });
  const readEpub = async (filePath) => {
    const zip = readZip(await fs.readFile(filePath));
    const entries = new Map(zip.entries.map((entry) => [entry.name, entry]));
    return {
      zip,
      names: zip.names,
      text: (name) => {
        const entry = entries.get(name);
        return entry ? entry.data.toString('utf8') : '';
      }
    };
  };
  const epubSpineOf = (opf) =>
    [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((match) => match[1]);
  const textFilesOf = (names) => names.filter((name) => name.startsWith('OEBPS/text/')).sort();

  check(
    'EPUB 范围导出：准备了一本 5 章 / 3 卷（其中一卷是空卷）的书',
    epubRangeMeta.chapters.length === 5 &&
      epubRangeVolumeIds.length === 3 &&
      (await exec('window.__cwTest.volumeNames()')).join(',') === '上卷,下卷,空卷' &&
      JSON.stringify(await exec('window.__cwTest.chapterTitles()')) ===
        JSON.stringify(['第1章：楔子', '第2章：上卷一', '第3章：上卷二', '第4章：下卷三', '第5章：下卷四']),
    await exec('window.__cwTest.chapterTitles()')
  );

  // 46k-1. 入口：EPUB 菜单打开的是同一个范围对话框，标题 / 格式 / 默认文件名都是 EPUB
  await openExportDialogFromMenu('epub');
  const epubRangeAllSummary = await waitForSummary('EPUB范围导出测试书.epub');
  check(
    'EPUB 范围导出：导出对话框是 EPUB 模式，默认全书 5 章',
    (await exec('window.__cwTest.exportTitle()')) === '导出 EPUB' &&
      (await exec('window.__cwTest.exportFormat()')) === 'epub' &&
      epubRangeAllSummary.includes('将导出 5 章') &&
      epubRangeAllSummary.includes('EPUB范围导出测试书.epub'),
    epubRangeAllSummary
  );
  const epubRangeVolumeOptions = await exec(
    "Array.from(document.getElementById('export-volume').options).map((option) => option.textContent)"
  );
  check(
    'EPUB 范围导出：按卷下拉框列出未分卷和三个卷（含空卷 0 章）',
    JSON.stringify(epubRangeVolumeOptions) ===
      JSON.stringify(['未分卷（1 章）', '上卷（2 章）', '下卷（2 章）', '空卷（0 章）']),
    epubRangeVolumeOptions
  );

  // 46k-2. 全书 EPUB：5 章 + 2 个卷名页，identifier 用作后面按卷 / 按范围的对照
  const epubRangeFullPath = path.join(epubRangeDir, 'full.epub');
  withSavePath(epubRangeFullPath);
  try {
    await exec("document.getElementById('btn-export-confirm').click()");
    await waitForFile(epubRangeFullPath);
  } finally {
    restoreSaveDialog();
  }
  const epubRangeFull = await readEpub(epubRangeFullPath);
  const epubRangeFullOpf = epubRangeFull.text('OEBPS/content.opf');
  const epubRangeFullIdentifier = (
    epubRangeFullOpf.match(/<dc:identifier id="pub-id">([^<]+)<\/dc:identifier>/) || []
  )[1];
  check(
    'EPUB 范围导出：全书 EPUB 仍是 5 章 / 2 个卷名页，封面与以前一致',
    textFilesOf(epubRangeFull.names).join(',') ===
      [
        'OEBPS/text/chapter-0001.xhtml',
        'OEBPS/text/chapter-0002.xhtml',
        'OEBPS/text/chapter-0003.xhtml',
        'OEBPS/text/chapter-0004.xhtml',
        'OEBPS/text/chapter-0005.xhtml',
        'OEBPS/text/volume-0001.xhtml',
        'OEBPS/text/volume-0002.xhtml'
      ].join(',') &&
      epubRangeFull.text('OEBPS/cover.xhtml').includes('共 5 章 · 2 卷') &&
      Boolean(epubRangeFullIdentifier),
    textFilesOf(epubRangeFull.names)
  );

  // 46k-3. 按卷导出「上卷」：只打第 2–3 章，文件名带卷名
  await openExportDialogFromMenu('epub');
  await exec("document.querySelector('input[name=\"export-scope\"][value=\"volume\"]').click()");
  await exec(
    `(() => { const select = document.getElementById('export-volume'); select.value = ${JSON.stringify(epubRangeVolumeIds[0])}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`
  );
  const epubRangeVolumeSummary = await waitForSummary('EPUB范围导出测试书-上卷.epub');
  check(
    'EPUB 范围导出：按卷摘要显示 2 章、文件名带卷名',
    epubRangeVolumeSummary.includes('将导出 2 章') &&
      epubRangeVolumeSummary.includes('EPUB范围导出测试书-上卷.epub'),
    epubRangeVolumeSummary
  );
  const epubRangeVolumePath = path.join(epubRangeDir, 'volume.epub');
  withSavePath(epubRangeVolumePath);
  try {
    await exec("document.getElementById('btn-export-confirm').click()");
    await waitForFile(epubRangeVolumePath);
  } finally {
    restoreSaveDialog();
  }
  check(
    'EPUB 范围导出：保存对话框默认文件名 = 书名-卷名.epub，类型带 epub',
    Boolean(saveDialog.last) &&
      path.basename(saveDialog.last.defaultPath) === 'EPUB范围导出测试书-上卷.epub' &&
      saveDialog.last.filters.some(
        (filter) => Array.isArray(filter.extensions) && filter.extensions.includes('epub')
      ),
    saveDialog.last && saveDialog.last.defaultPath
  );
  const epubRangeVolume = await readEpub(epubRangeVolumePath);
  const epubRangeVolumeOpf = epubRangeVolume.text('OEBPS/content.opf');
  const epubRangeVolumeIdentifier = (
    epubRangeVolumeOpf.match(/<dc:identifier id="pub-id">([^<]+)<\/dc:identifier>/) || []
  )[1];
  check(
    'EPUB 范围导出：按卷只打这一卷的章 + 一个卷名页，spine / 目录同步',
    textFilesOf(epubRangeVolume.names).join(',') ===
      [
        'OEBPS/text/chapter-0002.xhtml',
        'OEBPS/text/chapter-0003.xhtml',
        'OEBPS/text/volume-0001.xhtml'
      ].join(',') &&
      JSON.stringify(epubSpineOf(epubRangeVolumeOpf)) ===
        JSON.stringify(['cover', 'vol1', 'ch2', 'ch3']) &&
      epubRangeVolume.text('OEBPS/nav.xhtml').includes('上卷') &&
      !epubRangeVolume.text('OEBPS/nav.xhtml').includes('楔子') &&
      !epubRangeVolume.text('OEBPS/nav.xhtml').includes('下卷'),
    textFilesOf(epubRangeVolume.names)
  );
  check(
    'EPUB 范围导出：按卷副本章号仍按全书（第3章：上卷二），封面写「上卷 · 共 2 章 · 1 卷」',
    epubRangeVolume.text('OEBPS/text/chapter-0003.xhtml').includes('第3章：上卷二') &&
      epubRangeVolume.text('OEBPS/cover.xhtml').includes('上卷 · 共 2 章 · 1 卷')
  );
  check(
    'EPUB 范围导出：按卷副本 identifier 与整本不同（阅读器不会当成同一本书）',
    Boolean(epubRangeVolumeIdentifier) &&
      Boolean(epubRangeFullIdentifier) &&
      epubRangeVolumeIdentifier !== epubRangeFullIdentifier,
    { volume: epubRangeVolumeIdentifier, full: epubRangeFullIdentifier }
  );

  // 46k-4. 章节范围 3–4（跨卷）：两卷卷名页都在，范围外一章都不进包
  await openExportDialogFromMenu('epub');
  await chooseExportRange(3, 4);
  const epubRangeRangeSummary = await waitForSummary('EPUB范围导出测试书-第3-4章.epub');
  check(
    'EPUB 范围导出：章节范围摘要 2 章、文件名带第3-4章',
    epubRangeRangeSummary.includes('将导出 2 章') &&
      epubRangeRangeSummary.includes('EPUB范围导出测试书-第3-4章.epub'),
    epubRangeRangeSummary
  );
  const epubRangeRangePath = path.join(epubRangeDir, 'range.epub');
  withSavePath(epubRangeRangePath);
  try {
    await exec("document.getElementById('btn-export-confirm').click()");
    await waitForFile(epubRangeRangePath);
  } finally {
    restoreSaveDialog();
  }
  const epubRangeRange = await readEpub(epubRangeRangePath);
  const epubRangeRangeOpf = epubRangeRange.text('OEBPS/content.opf');
  check(
    'EPUB 范围导出：第 3–4 章跨卷只打这两章 + 两个卷名页，spine 顺序正确',
    textFilesOf(epubRangeRange.names).join(',') ===
      [
        'OEBPS/text/chapter-0003.xhtml',
        'OEBPS/text/chapter-0004.xhtml',
        'OEBPS/text/volume-0001.xhtml',
        'OEBPS/text/volume-0002.xhtml'
      ].join(',') &&
      JSON.stringify(epubSpineOf(epubRangeRangeOpf)) ===
        JSON.stringify(['cover', 'vol1', 'ch3', 'vol2', 'ch4']),
    textFilesOf(epubRangeRange.names)
  );
  check(
    'EPUB 范围导出：跨卷范围封面写「第3-4章 · 共 2 章 · 2 卷」，正文只含选中章',
    epubRangeRange.text('OEBPS/cover.xhtml').includes('第3-4章 · 共 2 章 · 2 卷') &&
      epubRangeRange.text('OEBPS/text/chapter-0003.xhtml').includes('上卷第二章正文。') &&
      epubRangeRange.text('OEBPS/text/chapter-0004.xhtml').includes('下卷第一章正文。') &&
      !epubRangeRange.text('OEBPS/text/chapter-0004.xhtml').includes('下卷第二章正文。')
  );
  check(
    'EPUB 范围导出：按章节范围的 identifier 与整本 / 按卷都不同',
    (() => {
      const id = (
        epubRangeRangeOpf.match(/<dc:identifier id="pub-id">([^<]+)<\/dc:identifier>/) || []
      )[1];
      return Boolean(id) && id !== epubRangeFullIdentifier && id !== epubRangeVolumeIdentifier;
    })()
  );

  // 46k-5. 空卷：明确提示没有章节、导出按钮不可点（不写空文件）
  await openExportDialogFromMenu('epub');
  await exec("document.querySelector('input[name=\"export-scope\"][value=\"volume\"]').click()");
  await exec(
    `(() => { const select = document.getElementById('export-volume'); select.value = ${JSON.stringify(epubRangeVolumeIds[2])}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`
  );
  const epubRangeEmptySummary = await waitForSummary('所选范围里没有章节');
  check(
    'EPUB 范围导出：空卷提示「所选范围里没有章节」、导出按钮不可点',
    epubRangeEmptySummary.includes('所选范围里没有章节') &&
      (await exec('window.__cwTest.exportConfirmDisabled()')) === true,
    epubRangeEmptySummary
  );
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  check('EPUB 范围导出：Esc 关闭范围对话框', (await exec('window.__cwTest.exportDialogOpen()')) === false);

  // 46k-6. 未分卷：只打第 1 章，不生成卷名页，文件名带「未分卷」
  await openExportDialogFromMenu('epub');
  await exec("document.querySelector('input[name=\"export-scope\"][value=\"volume\"]').click()");
  await exec(
    "(() => { const select = document.getElementById('export-volume'); select.value = '__none__'; select.dispatchEvent(new Event('change', { bubbles: true })); })()"
  );
  const epubRangeUnvolumedSummary = await waitForSummary('EPUB范围导出测试书-未分卷.epub');
  check(
    'EPUB 范围导出：未分卷摘要 1 章、文件名带未分卷',
    epubRangeUnvolumedSummary.includes('将导出 1 章') &&
      epubRangeUnvolumedSummary.includes('EPUB范围导出测试书-未分卷.epub'),
    epubRangeUnvolumedSummary
  );
  const epubRangeUnvolumedPath = path.join(epubRangeDir, 'unvolumed.epub');
  withSavePath(epubRangeUnvolumedPath);
  try {
    await exec("document.getElementById('btn-export-confirm').click()");
    await waitForFile(epubRangeUnvolumedPath);
  } finally {
    restoreSaveDialog();
  }
  const epubRangeUnvolumed = await readEpub(epubRangeUnvolumedPath);
  check(
    'EPUB 范围导出：未分卷只打第 1 章、没有卷名页，封面写「未分卷 · 共 1 章」',
    textFilesOf(epubRangeUnvolumed.names).join(',') === 'OEBPS/text/chapter-0001.xhtml' &&
      epubRangeUnvolumed.text('OEBPS/cover.xhtml').includes('未分卷 · 共 1 章') &&
      !epubRangeUnvolumed.text('OEBPS/nav.xhtml').includes('上卷')
  );

  // 46k-7. 当前章未保存内容：只在选中范围里参与，磁盘不变
  await exec("window.__cwTest.switchTo(1, 'discard')");
  const epubRangeUnsavedText = '未保存的上卷新内容。';
  await exec(`window.__cwTest.setText(${JSON.stringify(epubRangeUnsavedText)})`);
  await waitFor('window.__cwTest.dirty() === true');
  await openExportDialogFromMenu('epub');
  await chooseExportRange(2, 2);
  // 先等范围专属文件名，否则会匹配到对话框刚打开时的「全书」摘要（它同样含未保存提示）
  const epubRangeUnsavedSummary = await waitForSummary('EPUB范围导出测试书-第2章.epub');
  check(
    'EPUB 范围导出：摘要提示含当前章未保存内容',
    epubRangeUnsavedSummary.includes('含当前章未保存内容') &&
      epubRangeUnsavedSummary.includes('EPUB范围导出测试书-第2章.epub'),
    epubRangeUnsavedSummary
  );
  const epubRangeUnsavedPath = path.join(epubRangeDir, 'unsaved.epub');
  withSavePath(epubRangeUnsavedPath);
  try {
    await exec("document.getElementById('btn-export-confirm').click()");
    await waitForFile(epubRangeUnsavedPath);
  } finally {
    restoreSaveDialog();
  }
  const epubRangeUnsaved = await readEpub(epubRangeUnsavedPath);
  check(
    'EPUB 范围导出：未保存正文进了 EPUB、旧正文没进去、磁盘仍是旧正文',
    epubRangeUnsaved.text('OEBPS/text/chapter-0002.xhtml').includes(epubRangeUnsavedText) &&
      !epubRangeUnsaved.text('OEBPS/text/chapter-0002.xhtml').includes('上卷第一章正文。') &&
      (await storage.loadChapterText(epubRangeBookPath, epubRangeMeta.chapters[1].file)).text ===
        '上卷第一章正文。' &&
      (await exec('window.__cwTest.dirty()')) === true
  );
  await exec("window.__cwTest.switchTo(0, 'discard')");

  // 46k-8. 全程只读：章节 txt 大小 + mtime、书目 chapters、书内文件、config 字段都没被导出改写
  let epubRangeFilesUntouched = true;
  for (const item of epubRangeStatBefore) {
    const stat = await fs.stat(path.join(epubRangeBookPath, item.file));
    if (stat.size !== item.size || stat.mtimeMs !== item.mtimeMs) epubRangeFilesUntouched = false;
  }
  const epubRangeMetaAfter = await storage.readBookMeta(epubRangeBookPath);
  const epubRangeCfgAfter = JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8'));
  let epubRangeCfgSame =
    Object.keys(epubRangeCfgBefore).sort().join(',') === Object.keys(epubRangeCfgAfter).sort().join(',');
  for (const key of Object.keys(epubRangeCfgBefore)) {
    // lastExportDir = 导出目录记忆（导出动作本来就会写）；lastBook = 切章 / 打开书记的位置，与导出无关
    if (key === 'lastExportDir' || key === 'lastBook') continue;
    if (JSON.stringify(epubRangeCfgBefore[key]) !== JSON.stringify(epubRangeCfgAfter[key])) {
      epubRangeCfgSame = false;
    }
  }
  const epubRangeDirEntries = (await fs.readdir(epubRangeBookPath)).sort();
  const epubRangeChaptersSame =
    JSON.stringify(epubRangeMetaAfter.chapters) === epubRangeChaptersBefore;
  check(
    'EPUB 范围导出：全程只读——章节 txt / 书目 chapters / 书内文件 / config 都没被导出改写',
    epubRangeFilesUntouched &&
      epubRangeChaptersSame &&
      epubRangeCfgSame &&
      epubRangeDirEntries.every((name) => !name.startsWith('_trash') && !name.startsWith('.tmp-')) &&
      epubRangeDirEntries.filter((name) => name.endsWith('.txt')).length === 5,
    {
      untouched: epubRangeFilesUntouched,
      chaptersSame: epubRangeChaptersSame,
      cfgSame: epubRangeCfgSame,
      dir: epubRangeDirEntries
    }
  );

  // 46k-9. 范围副本的 XML 全部合法，manifest 里的文件都在包里
  let epubRangeXmlOk = true;
  let epubRangeXmlChecked = 0;
  let epubRangeXmlError = '';
  for (const entry of epubRangeRange.zip.entries) {
    if (!/\.(xhtml|opf|ncx|xml)$/.test(entry.name)) continue;
    try {
      assertWellFormedXml(entry.data.toString('utf8'), entry.name);
      epubRangeXmlChecked += 1;
    } catch (err) {
      epubRangeXmlOk = false;
      epubRangeXmlError = err.message;
    }
  }
  const epubRangeRangeHrefs = [...epubRangeRangeOpf.matchAll(/<item [^>]*href="([^"]+)"/g)].map(
    (match) => match[1]
  );
  check(
    'EPUB 范围导出：范围副本的 XML 都合法、manifest 里每个文件都在包里',
    epubRangeXmlOk &&
      epubRangeXmlChecked >= 6 &&
      epubRangeRangeHrefs.every((href) => epubRangeRange.names.includes(`OEBPS/${href}`)),
    { checked: epubRangeXmlChecked, error: epubRangeXmlError }
  );

  // 46k-10. TXT 入口共用同一个对话框：切回 TXT 模式，摘要恢复 .txt
  await openExportDialogFromMenu('txt');
  const epubRangeTxtSummary = await waitForSummary('EPUB范围导出测试书.txt');
  check(
    'EPUB 范围导出：TXT 入口打开同一个对话框，标题 / 格式 / 文件名回到 TXT',
    (await exec('window.__cwTest.exportTitle()')) === '导出 TXT' &&
      (await exec('window.__cwTest.exportFormat()')) === 'txt' &&
      epubRangeTxtSummary.includes('EPUB范围导出测试书.txt'),
    epubRangeTxtSummary
  );
  await exec("document.getElementById('btn-export-cancel').click()");
  check(
    'EPUB 范围导出：取消按钮关闭对话框、不写文件',
    (await exec('window.__cwTest.exportDialogOpen()')) === false
  );

  // 46l. 导出 DOCX（v0.8-9，提案 N9）：整本 / 按卷 / 按章节范围导出成 Word 文档；
  // 和 TXT / EPUB 共用范围对话框与范围规则，章号仍按全书，只读不改书库。
  const docxDir = path.join(path.dirname(booksRoot), 'docx-exports');
  await fs.mkdir(docxDir, { recursive: true });
  const docxParts = [
    '[Content_Types].xml',
    '_rels/.rels',
    'word/document.xml',
    'word/styles.xml',
    'word/_rels/document.xml.rels',
    'docProps/core.xml',
    'docProps/app.xml'
  ];
  const docxAllOf = async (filePath) => {
    // DOCX 也是一个 zip：沿用 46k 的 readEpub 解包助手（只看条目和文本）
    const pkg = await readEpub(filePath);
    return { ...pkg, document: pkg.text('word/document.xml'), styles: pkg.text('word/styles.xml') };
  };

  // 46l-1. 入口：导出菜单新增「导出 DOCX…」，打开同一个范围对话框，标题 / 格式 / 默认文件名都是 DOCX
  const docxMenuExists = await exec(
    "Boolean(document.querySelector('#export-menu button[data-action=\"docx\"]'))"
  );
  await openExportDialogFromMenu('docx');
  const docxAllSummary = await waitForSummary('EPUB范围导出测试书.docx');
  check(
    'DOCX 导出：菜单有「导出 DOCX…」，打开同一个范围对话框（标题 / 格式 / .docx 文件名）',
    docxMenuExists === true &&
      (await exec('window.__cwTest.exportTitle()')) === '导出 DOCX' &&
      (await exec('window.__cwTest.exportFormat()')) === 'docx' &&
      docxAllSummary.includes('将导出 5 章') &&
      docxAllSummary.includes('EPUB范围导出测试书.docx'),
    docxAllSummary
  );

  // 46l-2. 全书 DOCX：最小 OOXML 包部件齐全，5 章 + 2 个卷标题，默认文件名 / 类型正确
  const docxFullPath = path.join(docxDir, 'full.docx');
  withSavePath(docxFullPath);
  try {
    await exec("document.getElementById('btn-export-confirm').click()");
    await waitForFile(docxFullPath);
  } finally {
    restoreSaveDialog();
  }
  const docxFull = await docxAllOf(docxFullPath);
  check(
    'DOCX 导出：保存对话框默认文件名 = 书名.docx，类型带 docx',
    Boolean(saveDialog.last) &&
      path.basename(saveDialog.last.defaultPath) === 'EPUB范围导出测试书.docx' &&
      saveDialog.last.filters.some(
        (filter) => Array.isArray(filter.extensions) && filter.extensions.includes('docx')
      ),
    saveDialog.last && saveDialog.last.defaultPath
  );
  check(
    'DOCX 导出：全书包里有最小 OOXML 七个部件，顺序稳定',
    JSON.stringify(docxFull.names) === JSON.stringify(docxParts),
    docxFull.names
  );
  check(
    'DOCX 导出：全书文档含 5 章标题 + 2 个卷标题 + 正文，章号按全书',
    ['第1章：楔子', '第2章：上卷一', '第3章：上卷二', '第4章：下卷三', '第5章：下卷四'].every((title) =>
      docxFull.document.includes(`>${title}</w:t>`)
    ) &&
      ['上卷', '下卷'].every((name) => docxFull.document.includes(`>${name}</w:t>`)) &&
      docxFull.document.includes('>楔子正文。</w:t>') &&
      docxFull.document.includes('>下卷第二章正文。</w:t>') &&
      docxFull.document.includes('>共 5 章 · 2 卷</w:t>') &&
      (docxFull.document.match(/<w:pStyle w:val="Heading2"\/>/g) || []).length === 5,
    docxFull.document.slice(0, 200)
  );
  check(
    'DOCX 导出：样式表带段首缩进 2 字 / 1.5 倍行距 / 宋体，标题页之后分页',
    docxFull.styles.includes('<w:ind w:firstLineChars="200" w:firstLine="480"/>') &&
      docxFull.styles.includes('w:line="360" w:lineRule="auto"') &&
      docxFull.styles.includes('w:eastAsia="宋体"') &&
      docxFull.document.includes('<w:br w:type="page"/>')
  );

  // 46l-3. 按卷导出「上卷」：只写第 2–3 章和一个卷标题
  await openExportDialogFromMenu('docx');
  await exec("document.querySelector('input[name=\"export-scope\"][value=\"volume\"]').click()");
  await exec(
    `(() => { const select = document.getElementById('export-volume'); select.value = ${JSON.stringify(epubRangeVolumeIds[0])}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`
  );
  const docxVolumeSummary = await waitForSummary('EPUB范围导出测试书-上卷.docx');
  check(
    'DOCX 导出：按卷摘要 2 章、文件名带卷名',
    docxVolumeSummary.includes('将导出 2 章') &&
      docxVolumeSummary.includes('EPUB范围导出测试书-上卷.docx'),
    docxVolumeSummary
  );
  const docxVolumePath = path.join(docxDir, 'volume.docx');
  withSavePath(docxVolumePath);
  try {
    await exec("document.getElementById('btn-export-confirm').click()");
    await waitForFile(docxVolumePath);
  } finally {
    restoreSaveDialog();
  }
  const docxVolume = await docxAllOf(docxVolumePath);
  check(
    'DOCX 导出：按卷只写该卷的章和一个卷标题，范围外的章 / 卷一个字都没有',
    docxVolume.document.includes('>第2章：上卷一</w:t>') &&
      docxVolume.document.includes('>第3章：上卷二</w:t>') &&
      docxVolume.document.includes('>上卷</w:t>') &&
      docxVolume.document.includes('>上卷 · 共 2 章 · 1 卷</w:t>') &&
      !docxVolume.document.includes('楔子') &&
      !docxVolume.document.includes('下卷'),
    docxVolume.document.slice(0, 160)
  );

  // 46l-4. 章节范围 3–4（跨卷）：两个卷标题都在，范围外一章不进文档
  await openExportDialogFromMenu('docx');
  await chooseExportRange(3, 4);
  const docxRangeSummary = await waitForSummary('EPUB范围导出测试书-第3-4章.docx');
  check(
    'DOCX 导出：章节范围摘要 2 章、文件名带第3-4章',
    docxRangeSummary.includes('将导出 2 章') &&
      docxRangeSummary.includes('EPUB范围导出测试书-第3-4章.docx'),
    docxRangeSummary
  );
  const docxRangePath = path.join(docxDir, 'range.docx');
  withSavePath(docxRangePath);
  try {
    await exec("document.getElementById('btn-export-confirm').click()");
    await waitForFile(docxRangePath);
  } finally {
    restoreSaveDialog();
  }
  const docxRange = await docxAllOf(docxRangePath);
  check(
    'DOCX 导出：第 3–4 章跨卷只写这两章 + 两个卷标题，卷 / 章顺序正确',
    docxRange.document.includes('>上卷</w:t>') &&
      docxRange.document.includes('>第3章：上卷二</w:t>') &&
      docxRange.document.includes('>下卷</w:t>') &&
      docxRange.document.includes('>第4章：下卷三</w:t>') &&
      docxRange.document.includes('>第3-4章 · 共 2 章 · 2 卷</w:t>') &&
      !docxRange.document.includes('楔子') &&
      !docxRange.document.includes('第5章') &&
      docxRange.document.indexOf('>上卷</w:t>') < docxRange.document.indexOf('>第3章：上卷二</w:t>') &&
      docxRange.document.indexOf('>第3章：上卷二</w:t>') < docxRange.document.indexOf('>下卷</w:t>'),
    docxRange.document.slice(0, 160)
  );

  // 46l-5. 空卷：明确提示没有章节、导出按钮不可点（不写空文件）
  await openExportDialogFromMenu('docx');
  await exec("document.querySelector('input[name=\"export-scope\"][value=\"volume\"]').click()");
  await exec(
    `(() => { const select = document.getElementById('export-volume'); select.value = ${JSON.stringify(epubRangeVolumeIds[2])}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`
  );
  const docxEmptySummary = await waitForSummary('所选范围里没有章节');
  check(
    'DOCX 导出：空卷提示「所选范围里没有章节」、导出按钮不可点',
    docxEmptySummary.includes('所选范围里没有章节') &&
      (await exec('window.__cwTest.exportConfirmDisabled()')) === true,
    docxEmptySummary
  );
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  check('DOCX 导出：Esc 关闭范围对话框', (await exec('window.__cwTest.exportDialogOpen()')) === false);

  // 46l-6. 当前章未保存内容：只参与这次导出，磁盘仍是旧正文
  await exec("window.__cwTest.switchTo(1, 'discard')");
  const docxUnsavedText = '未保存的上卷 DOCX 新内容。';
  await exec(`window.__cwTest.setText(${JSON.stringify(docxUnsavedText)})`);
  await waitFor('window.__cwTest.dirty() === true');
  await openExportDialogFromMenu('docx');
  await chooseExportRange(2, 2);
  const docxUnsavedSummary = await waitForSummary('EPUB范围导出测试书-第2章.docx');
  check(
    'DOCX 导出：摘要提示含当前章未保存内容',
    docxUnsavedSummary.includes('含当前章未保存内容') &&
      docxUnsavedSummary.includes('EPUB范围导出测试书-第2章.docx'),
    docxUnsavedSummary
  );
  const docxUnsavedPath = path.join(docxDir, 'unsaved.docx');
  withSavePath(docxUnsavedPath);
  try {
    await exec("document.getElementById('btn-export-confirm').click()");
    await waitForFile(docxUnsavedPath);
  } finally {
    restoreSaveDialog();
  }
  const docxUnsaved = await docxAllOf(docxUnsavedPath);
  check(
    'DOCX 导出：未保存正文进了文档、旧正文没进去、磁盘仍是旧正文',
    docxUnsaved.document.includes(docxUnsavedText) &&
      !docxUnsaved.document.includes('上卷第一章正文。') &&
      (await storage.loadChapterText(epubRangeBookPath, epubRangeMeta.chapters[1].file)).text ===
        '上卷第一章正文。' &&
      (await exec('window.__cwTest.dirty()')) === true
  );
  await exec("window.__cwTest.switchTo(0, 'discard')");

  // 46l-7. 全程只读：章节 txt 大小 + mtime、书目 chapters、书内文件、config 字段都没被导出改写
  let docxFilesUntouched = true;
  for (const item of epubRangeStatBefore) {
    const stat = await fs.stat(path.join(epubRangeBookPath, item.file));
    if (stat.size !== item.size || stat.mtimeMs !== item.mtimeMs) docxFilesUntouched = false;
  }
  const docxMetaAfter = await storage.readBookMeta(epubRangeBookPath);
  const docxCfgAfter = JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8'));
  let docxCfgSame =
    Object.keys(epubRangeCfgBefore).sort().join(',') === Object.keys(docxCfgAfter).sort().join(',');
  for (const key of Object.keys(epubRangeCfgBefore)) {
    if (key === 'lastExportDir' || key === 'lastBook') continue;
    if (JSON.stringify(epubRangeCfgBefore[key]) !== JSON.stringify(docxCfgAfter[key])) docxCfgSame = false;
  }
  const docxDirEntries = (await fs.readdir(epubRangeBookPath)).sort();
  check(
    'DOCX 导出：全程只读——章节 txt / 书目 chapters / 书内文件 / config 都没被导出改写',
    docxFilesUntouched &&
      JSON.stringify(docxMetaAfter.chapters) === epubRangeChaptersBefore &&
      docxCfgSame &&
      docxDirEntries.every((name) => !name.startsWith('_trash') && !name.startsWith('.tmp-')) &&
      docxDirEntries.filter((name) => name.endsWith('.txt')).length === 5,
    {
      untouched: docxFilesUntouched,
      chaptersSame: JSON.stringify(docxMetaAfter.chapters) === epubRangeChaptersBefore,
      cfgSame: docxCfgSame,
      dir: docxDirEntries
    }
  );

  // 46l-8. DOCX 包里 XML / 关系都合法，内容类型和关系目标都存在
  let docxXmlOk = true;
  let docxXmlChecked = 0;
  let docxXmlError = '';
  for (const entry of docxRange.zip.entries) {
    if (!/\.(xml|rels)$/.test(entry.name)) continue;
    try {
      assertWellFormedXml(entry.data.toString('utf8'), entry.name);
      docxXmlChecked += 1;
    } catch (err) {
      docxXmlOk = false;
      docxXmlError = err.message;
    }
  }
  const docxTypes = docxRange.text('[Content_Types].xml');
  const docxPackageRels = docxRange.text('_rels/.rels');
  const docxDocumentRels = docxRange.text('word/_rels/document.xml.rels');
  check(
    'DOCX 导出：XML / 关系都合法，关系目标和内容类型都指向包里真实存在的部件',
    docxXmlOk &&
      docxXmlChecked === 7 &&
      docxTypes.includes(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
      ) &&
      docxPackageRels.includes('Target="word/document.xml"') &&
      docxPackageRels.includes('Target="docProps/core.xml"') &&
      docxDocumentRels.includes('Target="styles.xml"') &&
      docxRange.names.includes('word/document.xml') &&
      docxRange.names.includes('word/styles.xml') &&
      docxRange.names.includes('docProps/core.xml'),
    { checked: docxXmlChecked, error: docxXmlError }
  );

  // 46l-9. 取消不写文件
  const docxCancelPath = path.join(docxDir, 'cancel.docx');
  await openExportDialogFromMenu('docx');
  withSavePath(docxCancelPath);
  try {
    await exec("document.getElementById('btn-export-cancel').click()");
  } finally {
    restoreSaveDialog();
  }
  check(
    'DOCX 导出：取消按钮关闭对话框、不写文件',
    (await exec('window.__cwTest.exportDialogOpen()')) === false &&
      !(await fileExists(docxCancelPath))
  );
};
