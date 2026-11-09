// E2E 第 43 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：按 historyBookPath 重开组 42 的「历史面板测试书」（当 v0.4.1 旧书）
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group43DailySnapshot(t) {
  const { exec, check, waitFor, storage, userData, fileExists } = t;
  const { historyBookPath, historyMetaPath } = t.state;

  // 43. 可选每日快照（v0.6-2，默认关）：Ctrl+S 时当天首次留上一版，按天数清理
  const snapshotDefaults = await exec('window.api.getConfig()');
  check(
    '每日快照：默认关闭、保留 7 天（没有配置字段也按默认）',
    snapshotDefaults &&
      snapshotDefaults.ok &&
      snapshotDefaults.data.snapshotEnabled === false &&
      snapshotDefaults.data.snapshotKeepDays === 7,
    snapshotDefaults && snapshotDefaults.data
  );

  await exec('window.__cwTest.openSettings()');
  const snapshotSettingsBefore = await exec('window.__cwTest.snapshotSettings()');
  check(
    '每日快照：设置里有开关，默认不勾、7 天',
    snapshotSettingsBefore && snapshotSettingsBefore.enabled === false && snapshotSettingsBefore.keepDays === 7,
    snapshotSettingsBefore
  );
  await exec("window.__cwTest.setCheck('settings-snapshot-enabled', true)");
  await exec("window.__cwTest.setSelect('settings-snapshot-days', '3')");
  await exec('window.__cwTest.saveSettings()');
  await waitFor(
    'window.api.getConfig().then((r) => r.ok && r.data.snapshotEnabled === true && r.data.snapshotKeepDays === 3)'
  );
  const snapshotCfgDisk = JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8'));
  check(
    '每日快照：开关和保留天数真的落进 config.json',
    snapshotCfgDisk.snapshotEnabled === true && snapshotCfgDisk.snapshotKeepDays === 3,
    { enabled: snapshotCfgDisk.snapshotEnabled, days: snapshotCfgDisk.snapshotKeepDays }
  );

  // 43a. 打开一本 v0.4.1 形状的旧书（42j 刚去掉 schemaVersion），保存时留快照
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(historyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec('window.__cwTest.switchTo(0)');
  const snapshotLegacyRaw = JSON.parse(await fs.readFile(historyMetaPath, 'utf8'));
  check(
    '每日快照：v0.4.1 形状旧书目（没有 schemaVersion）照常打开',
    snapshotLegacyRaw.schemaVersion === undefined && snapshotLegacyRaw.chapters.length === 2,
    { version: snapshotLegacyRaw.schemaVersion, chapters: snapshotLegacyRaw.chapters.length }
  );

  const snapshotMeta = await storage.readBookMeta(historyBookPath);
  const snapshotFile0 = snapshotMeta.chapters[0].file;
  const snapshotFile1 = snapshotMeta.chapters[1].file;
  const snapshotTrash = path.join(historyBookPath, '_trash');
  const snapshotSource0 = await fs.readFile(path.join(historyBookPath, snapshotFile0));
  const snapshotSource0Text = snapshotSource0.toString('utf8').replace(/^\uFEFF/, '');
  const today = new Date();
  const snapshotDay = `快照-${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(
    today.getDate()
  ).padStart(2, '0')}`;
  const snapshotTodayDir = path.join(snapshotTrash, snapshotDay);

  await exec("window.__cwTest.setText('快照测试：第一版')");
  const snapshotSave1 = await exec('window.__cwTest.save()');
  check(
    '每日快照：开启后第一次保存会留下当天快照',
    snapshotSave1 &&
      snapshotSave1.ok &&
      snapshotSave1.data.snapshot &&
      snapshotSave1.data.snapshot.taken === true &&
      snapshotSave1.data.snapshot.dir === snapshotDay,
    snapshotSave1 && snapshotSave1.data && snapshotSave1.data.snapshot
  );
  const snapshotPath0 = path.join(snapshotTodayDir, snapshotFile0);
  check(
    '每日快照：快照复制的是保存前的上一版（字节原样）',
    (await fs.readFile(snapshotPath0)).equals(snapshotSource0)
  );
  check(
    '每日快照：快照里不是刚保存的新正文',
    !(await fs.readFile(snapshotPath0, 'utf8')).includes('快照测试：第一版')
  );

  const snapshotStat0 = await fs.stat(snapshotPath0);
  await exec("window.__cwTest.setText('快照测试：第二版')");
  const snapshotSave2 = await exec('window.__cwTest.save()');
  check(
    '每日快照：同一章当天第二次保存不再复制',
    snapshotSave2 &&
      snapshotSave2.ok &&
      snapshotSave2.data.snapshot.taken === false &&
      snapshotSave2.data.snapshot.reason === 'ALREADY_TODAY',
    snapshotSave2 && snapshotSave2.data && snapshotSave2.data.snapshot
  );
  const snapshotStat0After = await fs.stat(snapshotPath0);
  check(
    '每日快照：当天快照仍是第一份，不被后来的保存覆盖',
    (await fs.readFile(snapshotPath0)).equals(snapshotSource0) &&
      snapshotStat0After.mtimeMs === snapshotStat0.mtimeMs &&
      (await fs.readdir(snapshotTodayDir)).length === 1
  );
  check(
    '每日快照：正文照常保存（快照不改变保存结果）',
    (await storage.loadChapterText(historyBookPath, snapshotFile0)).text === '快照测试：第二版'
  );
  const snapshotLegacyAfter = JSON.parse(await fs.readFile(historyMetaPath, 'utf8'));
  check(
    '每日快照：旧书保存后补 schemaVersion，章节顺序/文件名不变',
    snapshotLegacyAfter.schemaVersion === 1 &&
      JSON.stringify(snapshotLegacyAfter.chapters.map((chapter) => chapter.file)) ===
        JSON.stringify([snapshotFile0, snapshotFile1]),
    snapshotLegacyAfter.chapters.map((chapter) => chapter.file)
  );

  // 43b. 和「本书历史」联动：能看到、能预览、能还原
  await exec('window.__cwTest.openHistoryForCurrentBook()');
  const snapshotGroupIndex = await exec("window.__cwTest.historyGroupIndexBySource('snapshot')");
  const snapshotGroups = await exec('window.__cwTest.historyGroups()');
  const snapshotGroup = snapshotGroupIndex >= 0 ? snapshotGroups[snapshotGroupIndex] : null;
  const snapshotFileIndex = snapshotGroup
    ? snapshotGroup.files.findIndex((file) => file.name === snapshotFile0)
    : -1;
  check(
    '每日快照：本书历史里出现「每日快照」组，文件可还原',
    snapshotGroup &&
      snapshotGroup.sourceLabel === '每日快照' &&
      snapshotGroup.fileCount === 1 &&
      snapshotFileIndex >= 0 &&
      snapshotGroup.files[snapshotFileIndex].restorable === true,
    snapshotGroup
  );
  const snapshotPreview = await exec(
    `window.__cwTest.previewHistoryAt(${snapshotGroupIndex}, ${snapshotFileIndex})`
  );
  check(
    '每日快照：历史面板能预览快照原文（只读）',
    snapshotPreview && snapshotPreview.text === snapshotSource0Text,
    snapshotPreview && snapshotPreview.text
  );
  const snapshotRestorePromise = exec(
    `window.__cwTest.restoreHistoryFileAt(${snapshotGroupIndex}, ${snapshotFileIndex})`
  );
  // 1.4.0 P0-2：历史还原不再弹确认框（直接还原，10 秒内可撤销）
  const snapshotRestore = await snapshotRestorePromise;
  check(
    '每日快照：能从本书历史还原当天快照',
    snapshotRestore &&
      snapshotRestore.ok &&
      snapshotRestore.data &&
      snapshotRestore.data.restored === 1 &&
      snapshotRestore.data.sourceLabel === '每日快照',
    snapshotRestore
  );
  check(
    '每日快照：还原后正文回到快照内容，并留下还原前备份',
    (await storage.loadChapterText(historyBookPath, snapshotFile0)).text ===
      snapshotSource0Text.replace(/\r\n/g, '\n')
  );
  await exec('window.__cwTest.closeHistory()');

  // 43c. 保留天数：只清理应用生成的「快照-YYYYMMDD」，旧目录删、其它都不动
  const snapshotOldDir = path.join(snapshotTrash, '快照-20200101');
  const snapshotFutureDir = path.join(snapshotTrash, '快照-29991231');
  const snapshotUnknownDir = path.join(snapshotTrash, '我的备份-20200101');
  for (const dir of [snapshotOldDir, snapshotFutureDir, snapshotUnknownDir]) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'keep.txt'), '别动我\n', 'utf8');
  }
  await fs.writeFile(path.join(snapshotTrash, '快照-20200101.txt'), '散文件也别动\n', 'utf8');

  await exec('window.__cwTest.switchTo(1)');
  const snapshotSource1 = await fs.readFile(path.join(historyBookPath, snapshotFile1));
  await exec("window.__cwTest.setText('第二章快照测试')");
  const snapshotSave3 = await exec('window.__cwTest.save()');
  check(
    '每日快照：换一章当天也能各留一份',
    snapshotSave3 && snapshotSave3.ok && snapshotSave3.data.snapshot.taken === true,
    snapshotSave3 && snapshotSave3.data && snapshotSave3.data.snapshot
  );
  check(
    '每日快照：第二章快照内容也是保存前的上一版',
    (await fs.readFile(path.join(snapshotTodayDir, snapshotFile1))).equals(snapshotSource1)
  );
  check(
    '每日快照：超出保留天数的旧快照目录被清理',
    (await fs.readFile(path.join(snapshotTodayDir, snapshotFile1))).equals(snapshotSource1) &&
      !(await fileExists(snapshotOldDir)) &&
      snapshotSave3.data.snapshot.cleanup.removed.includes('快照-20200101'),
    snapshotSave3.data.snapshot.cleanup
  );
  check(
    '每日快照：未来日期、未知目录、散文件都原样保留',
    (await fileExists(path.join(snapshotFutureDir, 'keep.txt'))) &&
      (await fileExists(path.join(snapshotUnknownDir, 'keep.txt'))) &&
      (await fileExists(path.join(snapshotTrash, '快照-20200101.txt')))
  );
  check(
    '每日快照：当天快照目录里有这一章的两个文件',
    (await fs.readdir(snapshotTodayDir)).sort().join('|') === [snapshotFile0, snapshotFile1].sort().join('|')
  );

  // 43d. 关掉开关：后续保存不再留快照；写作页设置里不显示全局快照项
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec('window.__cwTest.openSettings()');
  await exec("window.__cwTest.setCheck('settings-snapshot-enabled', false)");
  await exec('window.__cwTest.saveSettings()');
  await waitFor('window.api.getConfig().then((r) => r.ok && r.data.snapshotEnabled === false)');
  const snapshotCfgOff = JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8'));
  check('每日快照：关掉后 config.json 里是 false', snapshotCfgOff.snapshotEnabled === false);

  await exec(`window.__cwTest.openBookPath(${JSON.stringify(historyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec("window.__cwTest.newChapter('关掉快照后')");
  await exec('window.__cwTest.openSettings()');
  check(
    '每日快照：写作页设置里不显示全局快照开关',
    (await exec(
      "document.getElementById('settings-snapshot-field').classList.contains('hidden') === true"
    )) === true
  );
  await exec('window.__cwTest.closeSettings()');
  await exec("window.__cwTest.setText('关掉快照后的正文')");
  const snapshotSave4 = await exec('window.__cwTest.save()');
  check(
    '每日快照：关掉开关后保存不再留快照',
    snapshotSave4 &&
      snapshotSave4.ok &&
      snapshotSave4.data.snapshot.reason === 'DISABLED' &&
      snapshotSave4.data.snapshot.taken === false,
    snapshotSave4 && snapshotSave4.data && snapshotSave4.data.snapshot
  );
  check(
    '每日快照：关掉后当天快照目录没有多出新章文件',
    (await fs.readdir(snapshotTodayDir)).length === 2
  );

  // 43e. P22-5：本书历史里快照组按天折叠 + 「清空这天的快照」（只移入 Windows 回收站）
  // 口径：折叠只影响 snapshot 组的显示；清空只把那一个「快照-YYYYMMDD」目录移入回收站，
  // 章节文件 / 书目 / 其它备份一个字节都不动。绝不为了测试改成硬删 —— 回收站不可用时这里会失败并留下现场。
  const readTrashDigest = async () => {
    const names = (await fs.readdir(snapshotTrash)).sort();
    const out = [];
    for (const name of names) {
      const target = path.join(snapshotTrash, name);
      const stat = await fs.stat(target);
      if (stat.isDirectory()) {
        const files = (await fs.readdir(target)).sort();
        const inner = [];
        for (const file of files) {
          inner.push([file, (await fs.readFile(path.join(target, file))).toString('base64')]);
        }
        out.push([name, 'dir', inner]);
      } else {
        out.push([name, 'file', (await fs.readFile(target)).toString('base64')]);
      }
    }
    return out;
  };
  const readChaptersDigest = async () => {
    const names = (await fs.readdir(historyBookPath)).filter((name) => /\.txt$/i.test(name)).sort();
    const out = [];
    for (const name of names) {
      out.push([name, (await fs.readFile(path.join(historyBookPath, name))).toString('base64')]);
    }
    return out;
  };
  const metaOutline = (meta) => ({
    title: meta.title,
    chapters: (meta.chapters || []).map((chapter) => [chapter.id, chapter.file, chapter.name])
  });

  const chaptersBeforeClear = await readChaptersDigest();
  const metaBeforeClear = metaOutline(JSON.parse(await fs.readFile(historyMetaPath, 'utf8')));
  const trashBeforeClear = await readTrashDigest();

  // 非法目录名一律拒绝：不存在日期 / 带横线 / 路径穿越 / 反斜杠 / 绝对路径 / 其它备份名。
  // 每次都是 BAD_SNAPSHOT_DIR，而且 _trash 一个文件都没动（清空绝没有「校验失败也删一点」的降级）。
  const badSnapshotNames = [
    '快照-20260231',
    '快照-2026-11-07',
    '..',
    '..\\快照-20261107',
    'C:\\Windows\\快照-20261107',
    '替换备份-2026-10-31-210000',
    '其它备份-x'
  ];
  const badClearResults = [];
  for (const bad of badSnapshotNames) {
    badClearResults.push(
      JSON.parse(
        await exec(
          `window.api.clearSnapshotDay(${JSON.stringify(historyBookPath)}, ${JSON.stringify(bad)}).then((r) => JSON.stringify(r))`
        )
      )
    );
  }
  check(
    '每日快照（清空某天）：非法目录名 / 路径一律拒绝（BAD_SNAPSHOT_DIR），一个文件都不删',
    badClearResults.every((result) => result && result.ok === false && result.code === 'BAD_SNAPSHOT_DIR') &&
      JSON.stringify(await readTrashDigest()) === JSON.stringify(trashBeforeClear),
    badClearResults.map((result) => [result && result.ok, result && result.code])
  );

  await exec('window.__cwTest.openHistoryForCurrentBook()');
  await waitFor('window.__cwTest.historyOpen() === true');
  const snapTodayIndex = await exec(
    `window.__cwTest.historyGroupIndexBySnapshotName(${JSON.stringify(snapshotDay)})`
  );
  const groupsForFold = await exec('window.__cwTest.historyGroups()');
  const foldGroup = snapTodayIndex >= 0 ? groupsForFold[snapTodayIndex] : null;
  check(
    '每日快照（按天折叠）：历史面板里快照组带快照目录名，其它来源组没有这个字段',
    foldGroup &&
      foldGroup.snapshotName === snapshotDay &&
      groupsForFold.filter((group) => group.snapshotName).length === 2 &&
      groupsForFold.every((group) => group.source === 'snapshot' || group.snapshotName === ''),
    groupsForFold.map((group) => [group.source, group.snapshotName])
  );

  const foldToggleTag = await exec(`window.__cwTest.historyGroupToggleTag(${snapTodayIndex})`);
  const foldExpanded = await exec(`window.__cwTest.historyGroupExpanded(${snapTodayIndex})`);
  const foldRows = await exec(`window.__cwTest.historyGroupFileRowCount(${snapTodayIndex})`);
  const foldTexts = await exec('window.__cwTest.historyGroupTexts()');
  check(
    '每日快照（按天折叠）：组头是可点的 button、默认 aria-expanded=false、文件行不渲染（数量 / 大小照旧显示）',
    foldToggleTag === 'BUTTON' &&
      foldExpanded === 'false' &&
      foldRows === 0 &&
      foldGroup &&
      foldTexts[snapTodayIndex].includes('每日快照') &&
      foldTexts[snapTodayIndex].includes(`${foldGroup.fileCount} 个文件`),
    { foldToggleTag, foldExpanded, foldRows, head: foldTexts[snapTodayIndex] }
  );

  const restoreIndexForFold = await exec("window.__cwTest.historyGroupIndexBySource('restore')");
  const restoreFoldExpanded =
    restoreIndexForFold >= 0 ? await exec(`window.__cwTest.historyGroupExpanded(${restoreIndexForFold})`) : 'x';
  const restoreFoldRows =
    restoreIndexForFold >= 0 ? await exec(`window.__cwTest.historyGroupFileRowCount(${restoreIndexForFold})`) : -1;
  const restoreFoldButtons =
    restoreIndexForFold >= 0
      ? await exec(
          `document.querySelectorAll('#history-list .history-group')[${restoreIndexForFold}].querySelectorAll('.history-restore-group').length`
        )
      : -1;
  check(
    '每日快照（按天折叠）：其它来源组行为不变（没有折叠开关、默认展开、照旧有还原整组）',
    restoreIndexForFold >= 0 &&
      restoreFoldExpanded === null &&
      restoreFoldRows > 0 &&
      restoreFoldButtons === 1,
    { restoreIndexForFold, restoreFoldExpanded, restoreFoldRows, restoreFoldButtons }
  );

  const clearButtonCount = await exec('window.__cwTest.historyClearSnapshotButtonCount()');
  check(
    '每日快照（清空某天）：「清空这天的快照」只出现在快照组（两个严格快照目录 → 两个按钮）',
    clearButtonCount === 2 &&
      (await exec("document.querySelectorAll('#history-list .history-clear-snapshot').length")) >= 1,
    clearButtonCount
  );

  check(
    '每日快照（按天折叠）：点组头能展开',
    (await exec(`window.__cwTest.clickHistoryGroupToggle(${snapTodayIndex})`)) === true
  );
  const foldExpandedAfter = await exec(`window.__cwTest.historyGroupExpanded(${snapTodayIndex})`);
  const foldRowsAfter = await exec(`window.__cwTest.historyGroupFileRowCount(${snapTodayIndex})`);
  const restoreButtonWhenExpanded = await exec(
    `document.querySelectorAll('#history-list .history-group')[${snapTodayIndex}].querySelectorAll('.history-restore-group').length`
  );
  check(
    '每日快照（按天折叠）：展开后 aria-expanded=true、文件行回来、还原整组也在',
    foldExpandedAfter === 'true' &&
      foldGroup &&
      foldRowsAfter === foldGroup.fileCount &&
      restoreButtonWhenExpanded === 1,
    { foldExpandedAfter, foldRowsAfter, restoreButtonWhenExpanded }
  );

  const foldKeyboard = JSON.parse(
    await exec(`(() => {
      const card = document.querySelectorAll('#history-list .history-group')[${snapTodayIndex}];
      const btn = card && card.querySelector('.history-group-toggle');
      if (!btn) return JSON.stringify(null);
      btn.focus();
      return JSON.stringify({
        tag: btn.tagName,
        tabIndex: btn.tabIndex,
        focused: document.activeElement === btn,
        expanded: btn.getAttribute('aria-expanded')
      });
    })()`)
  );
  check(
    '每日快照（按天折叠）：组头按钮在 Tab 顺序里、能拿到焦点（键盘可达）',
    foldKeyboard && foldKeyboard.tag === 'BUTTON' && foldKeyboard.tabIndex === 0 && foldKeyboard.focused === true,
    foldKeyboard
  );

  // 清空当天快照：二次确认 → 只把这个目录移入回收站 → 清单 / 汇总刷新
  await exec('window.__cwTest.clearToasts()');
  check(
    '每日快照（清空某天）：快照组有「清空这天的快照」按钮',
    (await exec(`window.__cwTest.clickHistoryClearSnapshot(${snapTodayIndex})`)) === true
  );
  // 1.4.0 P0-2：清空某天快照不再弹确认框（整组移入回收站，应用内无撤销资源 —— 记录在案的例外），
  // 但 toast 必须写清「移入回收站、可恢复」。
  await waitFor('window.__cwTest.modalOpen() === false', 4000).catch(() => false);
  check(
    '每日快照（清空某天）：不再弹确认框（直接移入回收站）',
    (await exec('window.__cwTest.modalOpen()')) === false
  );
  await waitFor(
    `window.__cwTest.historyGroupIndexBySnapshotName(${JSON.stringify(snapshotDay)}) === -1`
  );
  const clearResultGone = await fileExists(snapshotTodayDir);
  check(
    '每日快照（清空某天）：当天的快照目录从 _trash 消失（移入回收站），不是硬删',
    clearResultGone === false
  );
  check(
    '每日快照（清空某天）：其它备份原样保留（未来日期快照 / 未知目录 / 散文件 / 还原前备份）',
    JSON.stringify(await readTrashDigest()) ===
      JSON.stringify(trashBeforeClear.filter(([name]) => name !== snapshotDay)),
    (await fs.readdir(snapshotTrash)).sort()
  );
  check(
    '每日快照（清空某天）：章节正文与书目结构一个字节都没动',
    JSON.stringify(await readChaptersDigest()) === JSON.stringify(chaptersBeforeClear) &&
      JSON.stringify(metaOutline(JSON.parse(await fs.readFile(historyMetaPath, 'utf8')))) ===
        JSON.stringify(metaBeforeClear)
  );

  const groupsAfterClear = await exec('window.__cwTest.historyGroups()');
  const summaryAfterClear = await exec('window.__cwTest.historySummary()');
  check(
    '每日快照（清空某天）：面板清单刷新、该组消失，汇总组数跟着变',
    groupsAfterClear.every((group) => group.snapshotName !== snapshotDay) &&
      groupsAfterClear.length === groupsForFold.length - 1 &&
      (await exec("document.querySelectorAll('#history-list .history-group').length")) ===
        groupsAfterClear.length &&
      summaryAfterClear.includes(`共 ${groupsAfterClear.length} 组备份`),
    { groups: groupsAfterClear.length, summary: summaryAfterClear }
  );
  const clearToasts = await exec('window.__cwTest.toasts()');
  check(
    '每日快照（清空某天）：成功 toast 写明已移入回收站',
    clearToasts.some((item) => item.message.includes('移入回收站') && item.message.includes(snapshotDay)),
    clearToasts
  );
  await exec('window.__cwTest.closeHistory()');
};

