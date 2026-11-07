// E2E 第 42 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：新建「历史面板测试书」（42j 去掉 schemaVersion，留给 43/44）
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group42BookHistory(t) {
  const { exec, check, waitFor, sleep, win, storage, waitForFile, fileExists, state, setWindowSize } = t;

  // 42. 本书历史面板（v0.6-1）：统一列出 / 预览 / 还原 _trash 备份
  await exec("window.__cwTest.newBook('历史面板测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const historyBookPath = await exec('window.__cwTest.bookPathValue()');
  const historyMetaPath = path.join(historyBookPath, '书目.json');
  state.historyBookPath = historyBookPath; // 第 43 / 44 组（每日快照 / 字数统计）继续用组 42 这本书
  state.historyMetaPath = historyMetaPath;
  await exec("window.__cwTest.renameChapterAt(0, '起风')");
  await exec("window.__cwTest.setText('现在第一章。')");
  await exec('window.__cwTest.save()');
  await exec("window.__cwTest.newChapter('夜雨')");
  await exec("window.__cwTest.setText('现在第二章。')");
  await exec('window.__cwTest.save()');
  // B3 起「上次打开章节」在主进程里 1.5 秒防抖合并写盘：新建 / 切章后可能还有一次后台书目更新。
  // 先等它落完，下面的「打开 / 预览历史不许改任何文件」只读比对才不会被这次切章的后台写盘干扰
  // （断言本身一个字不改：历史面板打开 / 预览仍然必须只读）。
  await sleep(1800);
  let historyMeta = await storage.readBookMeta(historyBookPath);
  const historyFile1 = historyMeta.chapters[0].file;
  const historyFile2 = historyMeta.chapters[1].file;
  const historyTrash = path.join(historyBookPath, '_trash');
  const replaceBackupName = '替换备份-2026-10-31-210000';
  const formatBackupName = '整理备份-2026-10-31-200000';
  const deletedTrashName = '2026-10-31-215000-003-已删章节.txt';
  await fs.mkdir(path.join(historyTrash, replaceBackupName), { recursive: true });
  await fs.writeFile(path.join(historyTrash, replaceBackupName, historyFile1), '替换前的第一章。\r\n', 'utf8');
  await fs.writeFile(path.join(historyTrash, replaceBackupName, historyFile2), '替换前的第二章。\r\n', 'utf8');
  await fs.writeFile(path.join(historyTrash, replaceBackupName, '003-已删.txt'), '已经不在书里的旧章。\r\n', 'utf8');
  await fs.mkdir(path.join(historyTrash, formatBackupName));
  await fs.writeFile(path.join(historyTrash, formatBackupName, historyFile1), '整理前的第一章。\r\n', 'utf8');
  await fs.writeFile(path.join(historyTrash, deletedTrashName), '被删章节的正文。\r\n', 'utf8');

  const historyTxtBefore = [];
  for (const file of [historyFile1, historyFile2]) {
    const stat = await fs.stat(path.join(historyBookPath, file));
    historyTxtBefore.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  const historyMetaBefore = await fs.readFile(historyMetaPath, 'utf8');
  const historyBackupBefore = await fs.stat(path.join(historyTrash, replaceBackupName, historyFile1));

  const waitForHistoryDisk = async (file, expected, timeout = 10000) => {
    const startedAt = Date.now();
    for (;;) {
      const loaded = await storage.loadChapterText(historyBookPath, file).catch(() => null);
      if (loaded && loaded.text === expected) return loaded;
      if (Date.now() - startedAt > timeout) {
        throw new Error(`等待磁盘正文超时：${file} :: ${loaded && loaded.text}`);
      }
      await sleep(120);
    }
  };

  // 42a. 写作页入口 + 汇总 + 只读扫描
  const historyOpened = await exec('window.__cwTest.openHistoryForCurrentBook()');
  check(
    '本书历史：写作页能打开历史面板',
    historyOpened === true && (await exec('window.__cwTest.historyOpen()')) === true
  );
  const historySummaryText = await exec('window.__cwTest.historySummary()');
  check(
    '本书历史：面板汇总 4 组备份（替换/整理/删章/书目）',
    historySummaryText.includes('4 组') && historySummaryText.includes('6 个文件'),
    historySummaryText
  );
  const historyGroupsNow = await exec('window.__cwTest.historyGroups()');
  const historyLabels = historyGroupsNow.map((group) => group.sourceLabel);
  check(
    '本书历史：来源分类正确（整本替换 / 整本整理 / 删除章节 / 书目备份）',
    ['整本替换', '整本整理', '删除章节', '书目备份'].every((label) => historyLabels.includes(label)),
    historyLabels
  );
  const replaceIndex = await exec("window.__cwTest.historyGroupIndexBySource('replace')");
  const replaceGroup = historyGroupsNow[replaceIndex];
  check(
    '本书历史：替换组 3 个文件，只有 2 个当前章节可还原',
    replaceGroup &&
      replaceGroup.fileCount === 3 &&
      replaceGroup.restorableCount === 2 &&
      replaceGroup.files.filter((file) => file.restorable).length === 2 &&
      replaceGroup.files.some((file) => file.name === '003-已删.txt' && !file.restorable),
    replaceGroup
  );
  const historyGroupTexts = await exec('window.__cwTest.historyGroupTexts()');
  check(
    '本书历史：面板显示来源、时间、文件数',
    historyGroupTexts.length === 4 &&
      historyGroupTexts.some(
        (text) =>
          text.includes('整本替换') &&
          text.includes('2026-10-31 21:00') &&
          text.includes('3 个文件')
      ),
    historyGroupTexts
  );

  // 42b. 预览：只读，能看到备份原文；标题带来源与文件名
  check(
    '本书历史：替换组第一个文件有预览按钮',
    (await exec(`window.__cwTest.clickHistoryFileButton(${replaceIndex}, 0, '预览')`)) === true
  );
  await waitFor('window.__cwTest.historyPreviewVisible() === true');
  const historyPreviewText = await exec('window.__cwTest.historyPreviewText()');
  check(
    '本书历史：预览显示备份里的原文',
    historyPreviewText.includes('替换前的第一章。'),
    historyPreviewText
  );
  const historyPreviewTitle = await exec('window.__cwTest.historyPreviewTitle()');
  check(
    '本书历史：预览标题带来源与文件名',
    historyPreviewTitle.includes('整本替换') && historyPreviewTitle.includes(historyFile1),
    historyPreviewTitle
  );

  // 视觉拍板 #13（2026-11-04）：历史面板宽窗改成「左列表 58% / 右预览 40%」左右分栏，
  // 窄窗（<980，含应用最小宽 960）回落原来的上下布局。DOM 顺序没变，只多一层 .history-main。
  const historySplitRect = async () =>
    exec(`(() => {
    const main = document.querySelector('.history-main');
    const list = document.querySelector('.history-scroll').getBoundingClientRect();
    const preview = document.getElementById('history-preview').getBoundingClientRect();
    const round = (n) => Math.round(n * 100) / 100;
    return {
      vw: window.innerWidth,
      dir: getComputedStyle(main).flexDirection,
      list: { l: round(list.left), r: round(list.right), t: round(list.top), b: round(list.bottom), w: round(list.width) },
      preview: { l: round(preview.left), r: round(preview.right), t: round(preview.top), b: round(preview.bottom), w: round(preview.width) }
    };
  })()`);
  const historyOrigBounds = win.getBounds();
  // 窗口 resize 是异步的（偶发拿到上一次的 innerWidth，见 harness.setWindowSize 注释）：
  // 宽窗等内宽真的 ≥ 980、窄窗等真的 < 980 再量；下面两条断言本身一个字没改。
  await setWindowSize(1294, 766, { minInner: 980 });
  await sleep(200);
  await waitFor('window.__cwTest.historyPreviewVisible() === true');
  const historyWideSplit = await historySplitRect();
  await setWindowSize(960, 700, { maxInner: 979 });
  await sleep(200);
  await waitFor('window.__cwTest.historyPreviewVisible() === true');
  const historyNarrowSplit = await historySplitRect();
  await setWindowSize(historyOrigBounds.width, historyOrigBounds.height, { minInner: 980 });
  await sleep(300);
  check(
    '本书历史（拍板 #13）：宽窗（1294）列表与预览左右分栏（预览在列表右侧、默认展开后同高）',
    historyWideSplit.vw >= 980 &&
      historyWideSplit.dir === 'row' &&
      historyWideSplit.preview.l >= historyWideSplit.list.r + 8 &&
      Math.abs(historyWideSplit.preview.t - historyWideSplit.list.t) <= 1 &&
      Math.abs(historyWideSplit.preview.w / historyWideSplit.list.w - 40 / 58) < 0.06,
    historyWideSplit
  );
  check(
    '本书历史（拍板 #13）：窄窗（960）自动回落上下布局（预览在列表下方、左边缘对齐）',
    historyNarrowSplit.vw < 980 &&
      historyNarrowSplit.dir === 'column' &&
      historyNarrowSplit.preview.t >= historyNarrowSplit.list.b - 1 &&
      Math.abs(historyNarrowSplit.preview.l - historyNarrowSplit.list.l) <= 1,
    historyNarrowSplit
  );

  // 42c. 打开 / 预览全程只读：章节 txt、书目、备份文件都没被改
  let historyReadOnly = true;
  for (const before of historyTxtBefore) {
    const stat = await fs.stat(path.join(historyBookPath, before.file));
    if (stat.size !== before.size || stat.mtimeMs !== before.mtimeMs) historyReadOnly = false;
  }
  const historyBackupAfter = await fs.stat(path.join(historyTrash, replaceBackupName, historyFile1));
  check(
    '本书历史：打开/预览不改章节 txt、不改书目、不改备份',
    historyReadOnly &&
      (await fs.readFile(historyMetaPath, 'utf8')) === historyMetaBefore &&
      historyBackupAfter.size === historyBackupBefore.size &&
      historyBackupAfter.mtimeMs === historyBackupBefore.mtimeMs
  );

  // 42d. 还原单章：二次确认 → 覆盖磁盘 → 当前编辑区跟着重载 → 先备份当前内容
  check(
    '本书历史：点「还原」会弹确认框',
    (await exec(`window.__cwTest.clickHistoryFileButton(${replaceIndex}, 0, '还原')`)) === true
  );
  await waitFor('window.__cwTest.modalOpen()');
  check('本书历史：单章还原确认框标题', (await exec('window.__cwTest.dialog()')) === '还原这一章');
  await exec("window.__cwTest.answerModal('ok')");
  await waitForHistoryDisk(historyFile1, '替换前的第一章。\n');
  check(
    '本书历史：还原单章后磁盘正文变成备份内容',
    (await storage.loadChapterText(historyBookPath, historyFile1)).text === '替换前的第一章。\n'
  );
  check(
    '本书历史：还原单章不打断当前正在看的章',
    (await exec('window.__cwTest.text()')) === '现在第二章。',
    await exec('window.__cwTest.text()')
  );
  await exec("window.__cwTest.switchTo(0, 'discard')");
  check(
    '本书历史：切到被还原的章，编辑区是备份内容',
    (await exec('window.__cwTest.text()')) === '替换前的第一章。\n',
    await exec('window.__cwTest.text()')
  );
  check(
    '本书历史：没点到的那一章不受影响',
    (await storage.loadChapterText(historyBookPath, historyFile2)).text === '现在第二章。'
  );
  historyMeta = await storage.readBookMeta(historyBookPath);
  check(
    '本书历史：字数缓存按还原后的正文更新',
    historyMeta.chapters[0].chars === 8,
    historyMeta.chapters.map((chapter) => chapter.chars)
  );
  const historyTrashAfterSingle = await fs.readdir(historyTrash);
  const historyRestoreDirs = historyTrashAfterSingle
    .filter((name) => name.startsWith('还原前备份-'))
    .sort();
  check(
    '本书历史：还原前把当前内容备份到 还原前备份-*',
    historyRestoreDirs.length >= 1,
    historyTrashAfterSingle
  );
  const historyRestoreDir = historyRestoreDirs[historyRestoreDirs.length - 1];
  check(
    '本书历史：还原前备份里是还原前的正文',
    (await fs.readFile(path.join(historyTrash, historyRestoreDir, historyFile1), 'utf8')) ===
      '现在第一章。'
  );

  // 42e. 还原整组：只还原当前章节，跳过已删章节，逐章先备份当前内容
  // 单章还原后多了一个「还原前备份」组，列表会重排，重新按来源找一次下标
  const replaceIndexForGroup = await exec("window.__cwTest.historyGroupIndexBySource('replace')");
  const groupRestoreClicked = await exec(
    `window.__cwTest.clickHistoryGroupRestore(${replaceIndexForGroup})`
  );
  check('本书历史：替换组显示「还原整组」按钮', groupRestoreClicked === true);
  await waitFor('window.__cwTest.modalOpen()');
  check(
    '本书历史：整组还原确认框标题',
    (await exec('window.__cwTest.dialog()')) === '还原整组备份'
  );
  await exec("window.__cwTest.answerModal('ok')");
  await waitForHistoryDisk(historyFile2, '替换前的第二章。\n');
  check(
    '本书历史：整组还原把另一章也还原了',
    (await storage.loadChapterText(historyBookPath, historyFile2)).text === '替换前的第二章。\n'
  );
  check(
    '本书历史：整组还原不复活已删章节（003-已删.txt 没有回到书里）',
    (await fileExists(path.join(historyBookPath, '003-已删.txt'))) === false
  );
  const historyTrashAfterGroup = (await fs.readdir(historyTrash))
    .filter((name) => name.startsWith('还原前备份-'))
    .sort();
  const latestGroupRestoreDir = historyTrashAfterGroup[historyTrashAfterGroup.length - 1];
  const groupRestoreFiles = (await fs.readdir(path.join(historyTrash, latestGroupRestoreDir))).sort();
  check(
    '本书历史：整组还原前把两章当前内容都备份了',
    JSON.stringify(groupRestoreFiles) === JSON.stringify([historyFile1, historyFile2].sort()),
    groupRestoreFiles
  );
  check(
    '本书历史：整组还原前的备份是还原前正文',
    (await fs.readFile(path.join(historyTrash, latestGroupRestoreDir, historyFile2), 'utf8')) ===
      '现在第二章。'
  );

  // 42f. 找回删除的章节：只把 txt 放回书文件夹，不自动加回章节列表、不覆盖同名文件
  const deleteIndex = await exec("window.__cwTest.historyGroupIndexBySource('delete')");
  const deleteGroup = (await exec('window.__cwTest.historyGroups()'))[deleteIndex];
  check(
    '本书历史：删章备份标记为可从 _trash 放回',
    deleteGroup &&
      deleteGroup.files[0].name === '003-已删章节.txt' &&
      deleteGroup.files[0].restorable === true,
    deleteGroup
  );
  check(
    '本书历史：点「放回书文件夹」',
    (await exec(`window.__cwTest.clickHistoryFileButton(${deleteIndex}, 0, '放回书文件夹')`)) === true
  );
  await waitFor('window.__cwTest.modalOpen()');
  check(
    '本书历史：删章还原确认框说明不改章节列表',
    (await exec('window.__cwTest.dialog()')) === '把删除的章节放回书文件夹'
  );
  await exec("window.__cwTest.answerModal('ok')");
  await waitForFile(path.join(historyBookPath, '003-已删章节.txt'));
  check(
    '本书历史：删章 txt 已放回书文件夹（内容原样）',
    (await fs.readFile(path.join(historyBookPath, '003-已删章节.txt'), 'utf8')) ===
      '被删章节的正文。\r\n'
  );
  const historyMetaAfterDelete = await storage.readBookMeta(historyBookPath);
  check(
    '本书历史：放回删章不改章节列表和章号',
    historyMetaAfterDelete.chapters.length === 2 &&
      JSON.stringify(historyMetaAfterDelete.chapters.map((chapter) => chapter.file)) ===
        JSON.stringify([historyFile1, historyFile2]),
    historyMetaAfterDelete.chapters.map((chapter) => chapter.file)
  );

  // 同一份删章备份再放一次：书里已有同名文件，拒绝覆盖
  const deleteIndexAgain = await exec("window.__cwTest.historyGroupIndexBySource('delete')");
  const repeatDeletePromise = exec(`window.__cwTest.restoreHistoryFileAt(${deleteIndexAgain}, 0)`);
  await waitFor('window.__cwTest.modalOpen()');
  await exec("window.__cwTest.answerModal('ok')");
  const repeatDelete = await repeatDeletePromise;
  check(
    '本书历史：书里已有同名文件时不覆盖（会报错）',
    repeatDelete && repeatDelete.ok === false && /没有覆盖/.test(repeatDelete.message || ''),
    repeatDelete
  );
  check(
    '本书历史：不覆盖后书里的同名文件保持原样',
    (await fs.readFile(path.join(historyBookPath, '003-已删章节.txt'), 'utf8')) ===
      '被删章节的正文。\r\n'
  );

  // 42g. 书目备份：可预览，但不提供还原（避免旧书目覆盖当前章节列表）
  const bookmetaIndex = await exec("window.__cwTest.historyGroupIndexBySource('bookmeta')");
  const bookmetaPreview = await exec(`window.__cwTest.previewHistoryAt(${bookmetaIndex}, 0)`);
  check(
    '本书历史：书目备份可预览（只读）',
    bookmetaPreview && bookmetaPreview.text.includes('"chapters"'),
    bookmetaPreview && bookmetaPreview.text.slice(0, 80)
  );
  const bookmetaGroup = (await exec('window.__cwTest.historyGroups()'))[bookmetaIndex];
  check(
    '本书历史：书目备份不提供还原',
    bookmetaGroup.files[0].restorable === false &&
      (await exec(`window.__cwTest.clickHistoryFileButton(${bookmetaIndex}, 0, '还原')`)) === false
  );

  // 42h. Esc 先收预览、再关面板
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  check(
    '本书历史：Esc 先收起预览、面板还在',
    (await exec('window.__cwTest.historyPreviewVisible()')) === false &&
      (await exec('window.__cwTest.historyOpen()')) === true
  );
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  check('本书历史：再按 Esc 关闭面板', (await exec('window.__cwTest.historyOpen()')) === false);

  // 42i. 入口：导出菜单 + 书卡右键菜单都能打开
  check(
    '本书历史：导出菜单有「本书历史…」',
    (await exec('window.__cwTest.exportMenuTexts()')).includes('本书历史…')
  );
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const bookMenuTexts = await exec('window.__cwTest.bookMenuTexts()');
  check('本书历史：书卡右键菜单有「本书历史…」', bookMenuTexts.includes('本书历史…'), bookMenuTexts);
  const shelfHistoryOpened = await exec(
    `window.__cwTest.openHistoryForPath(${JSON.stringify(historyBookPath)}, '历史面板测试书')`
  );
  check(
    '本书历史：书架也能打开同一本书的历史',
    shelfHistoryOpened === true && (await exec('window.__cwTest.historyOpen()')) === true
  );
  check(
    '本书历史：书架打开时也列出备份（含后加的还原前备份）',
    (await exec('window.__cwTest.historyGroupCount()')) >= 4
  );
  await exec('window.__cwTest.closeHistory()');

  // 42j. 旧数据兼容：v0.4.1 形状（没有 schemaVersion）的书目也能看历史
  const historyOldRaw = JSON.parse(await fs.readFile(historyMetaPath, 'utf8'));
  delete historyOldRaw.schemaVersion;
  await fs.writeFile(historyMetaPath, JSON.stringify(historyOldRaw, null, 2), 'utf8');
  const historyOldRead = await storage.readBookMeta(historyBookPath);
  check(
    '本书历史：没有 schemaVersion 的旧书目照常读',
    historyOldRead.chapters.length === 2 && historyOldRead.schemaVersion === 1,
    historyOldRead.schemaVersion
  );
  const oldHistoryOpened = await exec(
    `window.__cwTest.openHistoryForPath(${JSON.stringify(historyBookPath)}, '历史面板测试书')`
  );
  check(
    '本书历史：旧书目打开历史面板照常列出备份',
    oldHistoryOpened === true && (await exec('window.__cwTest.historyGroupCount()')) >= 4
  );
  await exec('window.__cwTest.closeHistory()');
};
