// E2E 第 39 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：新建「范围导出测试书」（+ 2 卷 4 章）
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group39RangeExport(t) {
  const {
    exec,
    check,
    waitFor,
    sleep,
    storage,
    booksRoot,
    waitForFile,
    waitForSummary,
    fileExists,
    chaptersLib,
    exporter,
    dialog,
    saveDialog,
    withSavePath,
    restoreSaveDialog,
    openExportDialogFromMenu,
    chooseExportRange
  } = t;

  // 39. 范围 / 分卷导出（v0.5-3）：全书 / 某卷 / 第 X–Y 章，文件名和内容都按范围来
  await exec("window.__cwTest.newBook('范围导出测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const exportBookPath = await exec('window.__cwTest.bookPathValue()');
  await exec("window.__cwTest.newVolume('上卷')");
  const exportVolumeIds = await exec('window.__cwTest.volumeIds()');
  await exec("window.__cwTest.newChapterInVolume(0, '上卷一')");
  await exec("window.__cwTest.newVolume('下卷')");
  await exec("window.__cwTest.newChapterInVolume(1, '下卷二')");
  await exec("window.__cwTest.newChapterInVolume(1, '下卷三')");
  const exportTexts = ['楔子正文。', '上卷第一章正文。', '下卷第二章正文。', '下卷第三章正文。'];
  for (let i = 0; i < exportTexts.length; i += 1) {
    await exec(`window.__cwTest.switchTo(${i}, 'discard')`);
    await exec(`window.__cwTest.setText(${JSON.stringify(exportTexts[i])})`);
    await exec('window.__cwTest.save()');
  }
  check(
    '范围导出：准备了一本 4 章 / 2 卷的书',
    (await exec('window.__cwTest.chapterNames()')).length === 4 &&
      (await exec('window.__cwTest.volumeNames()')).length === 2,
    {
      chapters: await exec('window.__cwTest.chapterNames()'),
      volumes: await exec('window.__cwTest.volumeNames()')
    }
  );
  const exportMeta = await storage.readBookMeta(exportBookPath);
  const exportDiskTexts = [];
  const exportFiles = [];
  const exportStatBefore = [];
  for (const chapter of exportMeta.chapters) {
    const filePath = path.join(exportBookPath, chapter.file);
    exportFiles.push(filePath);
    exportDiskTexts.push((await storage.loadChapterText(exportBookPath, chapter.file)).text);
    const stat = await fs.stat(filePath);
    exportStatBefore.push({ size: stat.size, mtimeMs: stat.mtimeMs });
  }
  check('范围导出：四章正文都已落盘', JSON.stringify(exportDiskTexts) === JSON.stringify(exportTexts), exportDiskTexts);

  const exportDir = path.join(path.dirname(booksRoot), 'exports');
  await fs.mkdir(exportDir, { recursive: true });
  // dialog / saveDialog / withSavePath / restoreSaveDialog / openExportDialogFromMenu / chooseExportRange
  // 已上移到场景前导（组 39 / 45 / 46 / 59 共用同一份），这里直接用前导那份，不再就地定义。

  // 39a. 打开对话框：默认全书 4 章 29 字、默认文件名 = 书名.txt
  await openExportDialogFromMenu();
  const summaryAll = await waitForSummary('将导出 4 章');
  check(
    '范围导出：默认全书 4 章 29 字，默认文件名 = 书名.txt',
    summaryAll.includes('将导出 4 章 · 29 字') && summaryAll.includes('范围导出测试书.txt'),
    summaryAll
  );

  // 39b. 范围不合法：起始章大于结束章 / 超出章数 → 明确提示 + 禁用导出
  await chooseExportRange(3, 1);
  const badRangeSummary = await waitForSummary('起始章不能大于结束章');
  check(
    '范围导出：起始章大于结束章时提示、导出按钮不可点',
    badRangeSummary.includes('起始章不能大于结束章') &&
      (await exec('window.__cwTest.exportConfirmDisabled()')) === true,
    badRangeSummary
  );
  await chooseExportRange(0, 9);
  const outOfRangeSummary = await waitForSummary('章节范围要在第 1–4 章之间');
  check(
    '范围导出：范围超出第 1–4 章时提示',
    outOfRangeSummary.includes('章节范围要在第 1–4 章之间') &&
      (await exec('window.__cwTest.exportConfirmDisabled()')) === true,
    outOfRangeSummary
  );
  await chooseExportRange(2, 2);
  const singleSummary = await waitForSummary('范围导出测试书-第2章.txt');
  check(
    '范围导出：单章范围显示 1 章、文件名带第2章',
    singleSummary.includes('将导出 1 章') && singleSummary.includes('范围导出测试书-第2章.txt'),
    singleSummary
  );

  // 39c. 按卷导出：摘要只算这一卷；保存对话框默认文件名带卷名，文件里只有这一卷
  await exec("document.querySelector('input[name=\"export-scope\"][value=\"volume\"]').click()");
  await exec(
    `(() => { const select = document.getElementById('export-volume'); select.value = ${JSON.stringify(exportVolumeIds[0])}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`
  );
  const volumeSummary = await waitForSummary('范围导出测试书-上卷.txt');
  check(
    '范围导出：按卷摘要显示 1 章、文件名带卷名',
    volumeSummary.includes('将导出 1 章') && volumeSummary.includes('范围导出测试书-上卷.txt'),
    volumeSummary
  );
  const volumeExportPath = path.join(exportDir, 'volume-export.txt');
  withSavePath(volumeExportPath);
  try {
    await exec("document.getElementById('btn-export-confirm').click()");
    await waitForFile(volumeExportPath);
  } finally {
    restoreSaveDialog();
  }
  check('范围导出：确认后对话框收起', (await exec('window.__cwTest.exportDialogOpen()')) === false);
  check(
    '范围导出：保存对话框默认文件名 = 书名-卷名.txt',
    Boolean(saveDialog.last) &&
      path.basename(saveDialog.last.defaultPath) === '范围导出测试书-上卷.txt',
    saveDialog.last && saveDialog.last.defaultPath
  );
  const expectedVolumeText = exporter.composeBook(exportMeta, exportDiskTexts, {
    mode: 'volume',
    volumeId: exportVolumeIds[0]
  });
  const volumeFileText = await fs.readFile(volumeExportPath, 'utf8');
  check(
    '范围导出：按卷导出只有这一卷、章号仍是全书第 2 章',
    volumeFileText === `\uFEFF${expectedVolumeText}` &&
      volumeFileText.includes('第2章：上卷一') &&
      volumeFileText.includes('上卷第一章正文。') &&
      !volumeFileText.includes('下卷') &&
      !volumeFileText.includes('楔子正文'),
    volumeFileText
  );

  // 39d. 第 3–4 章（跨卷）：文件名带范围，内容只有这两章，章号不重排
  await openExportDialogFromMenu();
  await chooseExportRange(3, 4);
  const rangeSummary = await waitForSummary('范围导出测试书-第3-4章.txt');
  check(
    '范围导出：章节范围摘要 2 章 16 字、文件名带第3-4章',
    rangeSummary.includes('将导出 2 章 · 16 字') &&
      rangeSummary.includes('范围导出测试书-第3-4章.txt'),
    rangeSummary
  );
  const rangeExportPath = path.join(exportDir, 'range-export.txt');
  withSavePath(rangeExportPath);
  try {
    await exec("document.getElementById('btn-export-confirm').click()");
    await waitForFile(rangeExportPath);
  } finally {
    restoreSaveDialog();
  }
  check(
    '范围导出：保存对话框默认文件名 = 书名-第3-4章.txt',
    Boolean(saveDialog.last) &&
      path.basename(saveDialog.last.defaultPath) === '范围导出测试书-第3-4章.txt',
    saveDialog.last && saveDialog.last.defaultPath
  );
  const expectedRangeText = exporter.composeBook(exportMeta, exportDiskTexts, {
    mode: 'range',
    from: 3,
    to: 4
  });
  const rangeFileText = await fs.readFile(rangeExportPath, 'utf8');
  check(
    '范围导出：第 3–4 章内容正确（跨卷带卷名、章号仍是第 3/4 章）',
    rangeFileText === `\uFEFF${expectedRangeText}` &&
      rangeFileText.includes('第3章：下卷二') &&
      rangeFileText.includes('第4章：下卷三') &&
      rangeFileText.includes('下卷') &&
      !rangeFileText.includes('上卷一') &&
      !rangeFileText.includes('楔子'),
    rangeFileText
  );

  // 39e. 全书导出：和以前完全一样（不传范围和传全书范围同结果）
  await openExportDialogFromMenu();
  await waitForSummary('范围导出测试书.txt');
  const allExportPath = path.join(exportDir, 'all-export.txt');
  withSavePath(allExportPath);
  try {
    await exec("document.getElementById('btn-export-confirm').click()");
    await waitForFile(allExportPath);
  } finally {
    restoreSaveDialog();
  }
  check(
    '范围导出：全书导出文件名 = 书名.txt',
    Boolean(saveDialog.last) &&
      path.basename(saveDialog.last.defaultPath) === '范围导出测试书.txt',
    saveDialog.last && saveDialog.last.defaultPath
  );
  const allFileText = await fs.readFile(allExportPath, 'utf8');
  check(
    '范围导出：全书导出和以前完全一样（四章都在）',
    allFileText === `\uFEFF${exporter.composeBook(exportMeta, exportDiskTexts)}` &&
      allFileText.includes('楔子正文。') &&
      allFileText.includes('上卷第一章正文。') &&
      allFileText.includes('下卷第二章正文。') &&
      allFileText.includes('下卷第三章正文。'),
    allFileText.slice(0, 120)
  );

  // 39f. 当前章未保存内容参与范围导出（只参与拼接，不写盘）
  await exec("window.__cwTest.switchTo(2, 'discard')");
  await exec("window.__cwTest.setText('还没保存的下卷内容。')");
  await openExportDialogFromMenu();
  await chooseExportRange(3, 3);
  // 等范围摘要（文件名是范围专属的；「含未保存内容」在全书摘要里也会有，不能单独当等待条件）
  const unsavedSummary = await waitForSummary('范围导出测试书-第3章.txt');
  check(
    '范围导出：摘要提示含当前章未保存内容、文件名带第3章',
    unsavedSummary.includes('含当前章未保存内容') &&
      unsavedSummary.includes('范围导出测试书-第3章.txt'),
    unsavedSummary
  );
  const unsavedExportPath = path.join(exportDir, 'unsaved-export.txt');
  withSavePath(unsavedExportPath);
  try {
    await exec("document.getElementById('btn-export-confirm').click()");
    await waitForFile(unsavedExportPath);
  } finally {
    restoreSaveDialog();
  }
  const unsavedFileText = await fs.readFile(unsavedExportPath, 'utf8');
  check(
    '范围导出：未保存正文进了导出文件、旧正文没进去',
    unsavedFileText.includes('还没保存的下卷内容。') &&
      !unsavedFileText.includes('下卷第二章正文。') &&
      unsavedFileText.includes('第3章：下卷二'),
    unsavedFileText
  );
  check(
    '范围导出：导出未保存内容后仍保持未保存、磁盘没被偷偷改写',
    (await exec('window.__cwTest.dirty()')) === true &&
      (await exec('window.__cwTest.chapterTextAt(2)')) === '下卷第二章正文。'
  );
  await exec("window.__cwTest.switchTo(0, 'discard')");

  // 39g. 保存对话框点取消：不写文件、不报错
  const cancelExportPath = path.join(exportDir, 'cancel-export.txt');
  await openExportDialogFromMenu();
  await waitForSummary('范围导出测试书.txt');
  let cancelDialogOpened = false;
  dialog.showSaveDialog = async () => {
    cancelDialogOpened = true;
    return { canceled: true };
  };
  try {
    await exec("document.getElementById('btn-export-confirm').click()");
    await sleep(500);
  } finally {
    restoreSaveDialog();
  }
  check(
    '范围导出：取消保存对话框不写文件、仍停在编辑页',
    cancelDialogOpened &&
      !(await fileExists(cancelExportPath)) &&
      (await exec('window.__cwTest.view()')) === 'editor'
  );

  // 39h. Esc 关闭导出对话框
  await openExportDialogFromMenu();
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  check('范围导出：Esc 关闭导出对话框', (await exec('window.__cwTest.exportDialogOpen()')) === false);

  // 39i. 全程只读：章节 txt 的大小 / mtime 没变，书目里的 chapters 也没被导出改写
  let exportFilesUntouched = true;
  for (let i = 0; i < exportFiles.length; i += 1) {
    const stat = await fs.stat(exportFiles[i]);
    if (stat.size !== exportStatBefore[i].size || stat.mtimeMs !== exportStatBefore[i].mtimeMs) {
      exportFilesUntouched = false;
    }
  }
  const exportMetaAfter = await storage.readBookMeta(exportBookPath);
  check(
    '范围导出：章节 txt 与书目的章节记录都没被导出改写（纯读）',
    exportFilesUntouched &&
      JSON.stringify(exportMetaAfter.chapters) === JSON.stringify(exportMeta.chapters)
  );

  // 39j. 导出预览字数优先用书目 chars 缓存（v0.8.6 R2 / 审计 F3）：
  // 故意把第 2 章缓存改成 777、删掉第 3 章缓存 —— 预览应 = 其余章缓存 + 777 + 第 3 章读盘现算；
  // 同时证明算预览只读：改完书目后打开对话框，全程不再写书目。
  const exportMetaPath = path.join(exportBookPath, '书目.json');
  const exportMetaBytes = await fs.readFile(exportMetaPath, 'utf8');
  const beforeCache = exportMeta.chapters.map((chapter) => chapter.chars);
  check(
    '范围导出：四章都有字数缓存（预览可以直接用缓存）',
    beforeCache.every((chars) => Number.isFinite(chars) && chars >= 0),
    beforeCache
  );
  const cacheMeta = JSON.parse(exportMetaBytes);
  cacheMeta.chapters[1].chars = 777;
  delete cacheMeta.chapters[2].chars;
  await fs.writeFile(exportMetaPath, JSON.stringify(cacheMeta, null, 2), 'utf8');
  const cachedBytes = await fs.readFile(exportMetaPath, 'utf8');
  const fallbackChars = chaptersLib.countChars(exportDiskTexts[2]);
  const expectedCachedChars = beforeCache[0] + 777 + fallbackChars + beforeCache[3];
  try {
    await openExportDialogFromMenu();
    const cachedSummary = await waitForSummary(`${expectedCachedChars} 字`);
    check(
      '范围导出：预览字数用书目缓存求和，缓存缺失的章才读盘现算',
      cachedSummary.includes(`将导出 4 章 · ${expectedCachedChars} 字`),
      cachedSummary
    );
    check(
      '范围导出：算预览不写书目（字数缓存只是读）',
      (await fs.readFile(exportMetaPath, 'utf8')) === cachedBytes
    );

    // 当前章有未保存内容时，覆盖章必须按编辑区现算，不能读缓存
    await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await exec("window.__cwTest.switchTo(2, 'discard')");
    const unsavedPreviewText = '未保存的预览字数测试。';
    await exec(`window.__cwTest.setText(${JSON.stringify(unsavedPreviewText)})`);
    await openExportDialogFromMenu();
    const overrideChars = chaptersLib.countChars(unsavedPreviewText);
    const overrideTotal = beforeCache[0] + 777 + overrideChars + beforeCache[3];
    const overrideSummary = await waitForSummary(`${overrideTotal} 字`);
    check(
      '范围导出：当前章未保存时预览按编辑区现算（覆盖章不读缓存）',
      overrideSummary.includes(`将导出 4 章 · ${overrideTotal} 字`) &&
        overrideSummary.includes('含当前章未保存内容'),
      overrideSummary
    );
    await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  } finally {
    await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await fs.writeFile(exportMetaPath, exportMetaBytes, 'utf8');
  }
  await exec("window.__cwTest.switchTo(0, 'discard')");
  const exportMetaRestored = await storage.readBookMeta(exportBookPath);
  check(
    '范围导出：收尾还原字数缓存（后续断言仍从原始书目出发）',
    JSON.stringify(exportMetaRestored.chapters) === JSON.stringify(exportMeta.chapters)
  );
};
