// E2E 第 36 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：新建「整本排版测试书」（+ 分卷）
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group36FormatBook(t) {
  const { exec, check, waitFor, sleep, clipboard, storage, app } = t;

  // 36. 一键整理本书：复用当前规则 + 确认框 + 整本备份 + 进度
  await exec("window.__cwTest.newBook('整本排版测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const fmtBookPath = await exec('window.__cwTest.state.bookPath');
  await exec("window.__cwTest.newChapter('第二章')");
  await exec("window.__cwTest.newChapter('第三章')");
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await exec(`window.__cwTest.setText(' 他说,"第一段."')`);
  await exec('window.__cwTest.save()');
  await exec("window.__cwTest.switchTo(1, 'discard')");
  await exec("window.__cwTest.setText('第二段   ')");
  await exec('window.__cwTest.save()');
  await exec("window.__cwTest.switchTo(2, 'discard')");
  await exec("window.__cwTest.setText('　　已经整理好。')");
  await exec('window.__cwTest.save()');
  const fmtOptions = { indent: '2', blankLines: 'single', trimTrailing: true, normalizePunct: true };
  await exec(`window.__cwTest.setFormatOptions(${JSON.stringify(fmtOptions)})`);

  await exec('window.__cwTest.openFormatMenu()');
  check(
    '整本排版：悬浮选择卡里有「一键整理本书…」',
    (await exec('Boolean(document.querySelector(\'#format-menu button[data-action="apply-book"]\'))')) === true
  );
  await exec('window.__cwTest.closeFormatMenu()');

  const fmtPreview = await exec(
    `window.api.formatPreviewBook(${JSON.stringify(fmtBookPath)}, ${JSON.stringify(fmtOptions)}).then((r) => (r.ok ? r.data : null))`
  );
  check(
    '整本排版：预检查统计会改动的章数',
    Boolean(fmtPreview) && fmtPreview.chapterCount === 3 && fmtPreview.chaptersChanged === 2,
    fmtPreview && { chapterCount: fmtPreview.chapterCount, changed: fmtPreview.chaptersChanged }
  );
  check(
    '整本排版：预检查不写盘',
    (await exec('window.__cwTest.chapterTextAt(0)')) === ' 他说,"第一段."'
  );

  const bookFormatPromise = exec('window.__cwTest.runFormatBook()');
  await waitFor('window.__cwTest.modalOpen()');
  check('整本排版：会先弹确认框', (await exec('window.__cwTest.dialog()')) === '一键整理本书');
  const fmtConfirmMessage = await exec('window.__cwTest.modalMessage()');
  check(
    '整本排版：确认框列出规则与要改的章数',
    fmtConfirmMessage.includes('段首缩进 2 字符') && fmtConfirmMessage.includes('2 章有改动'),
    fmtConfirmMessage.slice(0, 120)
  );
  check(
    '整本排版：确认框说明会先备份',
    fmtConfirmMessage.includes('整理备份'),
    fmtConfirmMessage.slice(0, 120)
  );
  await exec("window.__cwTest.answerModal('ok')");
  const bookFormatResult = await bookFormatPromise;
  check('整本排版：执行成功', bookFormatResult && bookFormatResult.ok === true, bookFormatResult);
  await sleep(400);
  const fmtMeta = await storage.readBookMeta(fmtBookPath);
  check(
    '整本排版：全书已写盘为整理后格式',
    (await storage.loadChapterText(fmtBookPath, fmtMeta.chapters[0].file)).text === '　　他说，"第一段。"' &&
      (await storage.loadChapterText(fmtBookPath, fmtMeta.chapters[1].file)).text === '　　第二段',
    {
      ch0: (await storage.loadChapterText(fmtBookPath, fmtMeta.chapters[0].file)).text,
      ch1: (await storage.loadChapterText(fmtBookPath, fmtMeta.chapters[1].file)).text
    }
  );
  check(
    '整本排版：已经整理好的章不动',
    (await storage.loadChapterText(fmtBookPath, fmtMeta.chapters[2].file)).text === '　　已经整理好。'
  );
  check(
    '整本排版：字数缓存已更新',
    fmtMeta.chapters[0].chars === 9 && fmtMeta.chapters[1].chars === 3,
    fmtMeta.chapters.map((chapter) => chapter.chars)
  );
  const fmtTrash = await fs.readdir(path.join(fmtBookPath, '_trash')).catch(() => []);
  const fmtBackupName = fmtTrash.find((name) => name.startsWith('整理备份-'));
  check('整本排版：原文备份到书内 _trash/整理备份-*', Boolean(fmtBackupName), fmtTrash);
  const fmtBackupText = await fs.readFile(
    path.join(fmtBookPath, '_trash', fmtBackupName, fmtMeta.chapters[0].file),
    'utf8'
  );
  check('整本排版：备份里是整理前的原文', fmtBackupText === ' 他说,"第一段."', fmtBackupText);
  check(
    '整本排版：进度提示在完成后收起',
    (await exec('window.__cwTest.formatBookProgressText()')) === ''
  );
  check(
    '整本排版：当前章已重新载入',
    (await exec('window.__cwTest.text()')) === '　　已经整理好。'
  );

  const fmtAgain = await exec('window.__cwTest.runFormatBook()');
  check(
    '整本排版：没有改动时不弹确认、直接提示',
    fmtAgain && fmtAgain.ok === true && fmtAgain.changed === 0 && (await exec('window.__cwTest.modalOpen()')) === false,
    fmtAgain
  );

  // 有未保存修改时先问「保存后整理 / 不保存 / 取消」
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await exec("window.__cwTest.setText('临时未保存的内容')");
  const fmtDirtyPromise = exec('window.__cwTest.runFormatBook()');
  await waitFor('window.__cwTest.modalOpen()');
  check(
    '整本排版：当前章未保存会先问',
    (await exec('window.__cwTest.dialog()')) === '整理本书前先处理未保存的修改'
  );
  await exec("window.__cwTest.answerModal('save')");
  await waitFor("window.__cwTest.dialog() === '一键整理本书'");
  await exec("window.__cwTest.answerModal('cancel')");
  const fmtDirtyResult = await fmtDirtyPromise;
  check('整本排版：取消后不写盘', fmtDirtyResult && fmtDirtyResult.canceled === true, fmtDirtyResult);
  check(
    '整本排版：取消后磁盘上只多了刚保存的未整理内容',
    (await exec('window.__cwTest.chapterTextAt(0)')) === '临时未保存的内容'
  );

  // 导出目录记忆：导出过的文件夹下次要记住（写进 config.json；坏值自动清洗）
  // app 由场景前导从 ctx 解构（组文件不许 require electron），见文件头 ctx 解构。
  const configFile = path.join(app.getPath('userData'), 'config.json');
  const wantedDir = 'D:\\导出测试目录';
  const setDirRes = await exec(`window.api.setConfig({ lastExportDir: ${JSON.stringify(wantedDir)} })`);
  check(
    '导出目录记忆：能写进配置并读回',
    Boolean(setDirRes && setDirRes.ok === true && setDirRes.data.lastExportDir === wantedDir),
    setDirRes && setDirRes.data
  );
  await exec('window.api.setConfig({ lastExportDir: 12345 })');
  const badDirCfg = await exec('window.api.getConfig()');
  check(
    '导出目录记忆：非法值清洗成空（下次退回文档目录）',
    Boolean(badDirCfg && badDirCfg.ok === true && badDirCfg.data.lastExportDir === ''),
    badDirCfg && badDirCfg.data
  );
  await exec(`window.api.setConfig({ lastExportDir: ${JSON.stringify(wantedDir)} })`);
  let savedConfig = null;
  try {
    savedConfig = JSON.parse(await fs.readFile(configFile, 'utf8'));
  } catch {
    /* 读不到就当失败 */
  }
  check(
    '导出目录记忆：真的落进 config.json',
    Boolean(savedConfig && savedConfig.lastExportDir === wantedDir),
    savedConfig && savedConfig.lastExportDir
  );

  // 分卷：新建卷 / 卷内建章 / 侧栏分组 / 移卷 / 改名 / 导出带卷名 / 删卷
  const bookPathForVol = await exec('window.__cwTest.bookPathValue()');
  await exec("window.__cwTest.switchTo(0, 'discard')");
  const newVol = await exec("window.__cwTest.newVolume('第1卷：单篇')");
  check('分卷：新建卷成功', Boolean(newVol && newVol.ok === true), newVol);
  check(
    '分卷：卷出现在侧栏',
    JSON.stringify(await exec('window.__cwTest.volumeNames()')) === JSON.stringify(['第1卷：单篇'])
  );
  const volIds = await exec('window.__cwTest.volumeIds()');
  await exec("window.__cwTest.newChapterInVolume(0, '卷内章')");
  const namesAfterVol = await exec('window.__cwTest.chapterNames()');
  const volumesAfterVol = await exec('window.__cwTest.chapterVolumeIds()');
  const lastVolIndex = namesAfterVol.length - 1;
  check(
    '分卷：卷内新建的章被放进卷里',
    namesAfterVol[lastVolIndex] === '卷内章' && volumesAfterVol[lastVolIndex] === volIds[0],
    { namesAfterVol, volumesAfterVol }
  );
  check(
    '分卷：侧栏出现卷分组',
    (await exec('window.__cwTest.volumeHeaders()')).includes('第1卷：单篇')
  );

  const orphanIndex = volumesAfterVol.findIndex((v) => v === null);
  if (orphanIndex >= 0) {
    await exec(`window.__cwTest.moveChapterToVolumeAt(${orphanIndex}, 0)`);
    const movedVolumes = await exec('window.__cwTest.chapterVolumeIds()');
    check(
      '分卷：把章移到卷里',
      movedVolumes.filter((v) => v === volIds[0]).length >= 2,
      movedVolumes
    );
  }

  await exec("window.__cwTest.renameVolumeAt(0, '第1卷：改名')");
  check(
    '分卷：卷改名',
    JSON.stringify(await exec('window.__cwTest.volumeNames()')) === JSON.stringify(['第1卷：改名'])
  );

  const volClip = await exec(`window.api.copyBook(${JSON.stringify(bookPathForVol)})`);
  check('分卷：复制整本成功', Boolean(volClip && volClip.ok === true), volClip);
  const clipWithVolume = await clipboard.readText();
  check(
    '分卷：导出内容带卷名一行',
    typeof clipWithVolume === 'string' && clipWithVolume.includes('第1卷：改名'),
    typeof clipWithVolume === 'string' ? clipWithVolume.slice(0, 80) : String(clipWithVolume)
  );

  const chaptersBeforeDeleteVolume = (await exec('window.__cwTest.chapterTitles()')).length;
  await exec('window.__cwTest.deleteVolumeAt(0, true)');
  check('分卷：删卷后卷没了', (await exec('window.__cwTest.volumeNames()')).length === 0);
  check(
    '分卷：删卷不删章',
    (await exec('window.__cwTest.chapterTitles()')).length === chaptersBeforeDeleteVolume
  );
  check(
    '分卷：删卷后章节都回未分卷',
    (await exec('window.__cwTest.chapterVolumeIds()')).every((v) => v === null)
  );

  // 分卷：卷上下移动 + 跨卷拖拽
  await exec("window.__cwTest.newVolume('甲卷')");
  await exec("window.__cwTest.newVolume('乙卷')");
  await exec("window.__cwTest.newChapterInVolume(0, '甲一')");
  await exec("window.__cwTest.newChapterInVolume(1, '乙一')");
  check(
    '分卷：两个卷都在',
    JSON.stringify(await exec('window.__cwTest.volumeNames()')) === JSON.stringify(['甲卷', '乙卷'])
  );
  await exec('window.__cwTest.moveVolumeAt(1, 0)');
  check(
    '分卷：卷可以上下移动',
    JSON.stringify(await exec('window.__cwTest.volumeNames()')) === JSON.stringify(['乙卷', '甲卷'])
  );
  const volIdsOrdered = await exec('window.__cwTest.volumeIds()');
  const chapterVolsBeforeDrag = await exec('window.__cwTest.chapterVolumeIds()');
  const chapterInJia = chapterVolsBeforeDrag.findIndex((v) => v === volIdsOrdered[1]);
  check('分卷：找得到甲卷里的章', chapterInJia >= 0, chapterVolsBeforeDrag);
  await exec(`window.__cwTest.dragChapterTo(${chapterInJia}, 0, null)`);
  const chapterVolsAfterDrag = await exec('window.__cwTest.chapterVolumeIds()');
  check(
    '分卷：跨卷拖拽把章放进目标卷',
    chapterVolsAfterDrag.filter((v) => v === volIdsOrdered[0]).length >= 2,
    chapterVolsAfterDrag
  );
};
