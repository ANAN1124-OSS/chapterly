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

  // 1.4.0 P0-2（撤销优先于确认）：一键整理本书不再弹确认框 —— 直接整理（写前照旧备份），
  // 10 秒内可撤销；准备信息进 toast。
  const bookFormatPromise = exec('window.__cwTest.runFormatBook()');
  const bookFormatResult = await bookFormatPromise;
  check('整本排版：不再弹确认框（直接执行）', (await exec('window.__cwTest.modalOpen()')) === false);
  const fmtToast = await exec('window.__cwTest.toasts()');
  check(
    '整本排版：提示里列出规则与要改的章数',
    fmtToast.some((item) => item.message.includes('段首缩进 2 字符') && item.message.includes('2 章')),
    fmtToast.map((item) => item.message)
  );
  check(
    '整本排版：提示里说明原文已备份到 _trash',
    fmtToast.some((item) => item.message.includes('原文已备份到 _trash')),
    fmtToast.map((item) => item.message)
  );
  check(
    '整本排版：出现 10 秒撤销条（用整理备份整组还原）',
    (await exec("!document.getElementById('undo-bar').classList.contains('hidden')")) === true
  );
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

  // 3c. 长操作编辑区保护（v1.8.0 WP-02 / 审计 C2）：整本整理这类长异步操作期间编辑区锁定，
  // 完成时按「书没换 / 期间有没有新输入」复核——漏网输入（输入法补字 / 程序化写入）正文优先，
  // 绝不被完成后的 loadChapterAt 静默覆盖、dirty 也不许被清成 false。
  // ?test=1 用 setTestBookOpDelay 把整理 IPC 拖 700ms，制造「整理还在进行」的窗口。
  await exec("window.__cwTest.switchTo(0, 'discard')");
  const c2TypedDuringFormat = ' 长操作保护，原文.';
  await exec(`window.__cwTest.setText(${JSON.stringify(c2TypedDuringFormat)})`);
  await exec('window.__cwTest.save()');
  await exec('window.__cwTest.clearToasts()');
  await exec('window.__cwTest.setTestBookOpDelay(700)');
  await exec("window.__cwE2EFmt = window.__cwTest.runFormatBook(); 'started'");
  const c2LockedDuringFormat = await exec('window.__cwTest.editorLocked()');
  const c2SlippedText = `${c2TypedDuringFormat}\n整理期间敲入的这句。`;
  await exec(`window.__cwTest.setText(${JSON.stringify(c2SlippedText)})`);
  const c2DirtyDuringFormat = await exec('window.__cwTest.dirty()');
  const c2FmtResult = await exec('window.__cwE2EFmt');
  await exec('delete window.__cwE2EFmt');
  await sleep(300);
  const c2MetaAfter = await storage.readBookMeta(fmtBookPath);
  const c2DiskText = (await storage.loadChapterText(fmtBookPath, c2MetaAfter.chapters[0].file)).text;
  check('长操作保护（C2）：整本整理进行中编辑区锁定成只读', c2LockedDuringFormat === true);
  check(
    '长操作保护（C2）：整理期间漏网的输入不丢——完成后正文仍是编辑区内容且仍是未保存态',
    c2DirtyDuringFormat === true &&
      (await exec('window.__cwTest.text()')) === c2SlippedText &&
      (await exec('window.__cwTest.dirty()')) === true &&
      Boolean(c2FmtResult && c2FmtResult.ok === true),
    { dirtyDuring: c2DirtyDuringFormat, result: c2FmtResult }
  );
  check(
    '长操作保护（C2）：整理结果仍然写盘（磁盘是整理后格式，编辑区保留未保存的旧正文）',
    c2DiskText === '　　长操作保护，原文。' && c2DiskText !== c2SlippedText,
    c2DiskText
  );
  check(
    '长操作保护（C2）：完成时给出「整理期间有未保存修改」的提示',
    (await exec('window.__cwTest.toasts()')).some(
      (item) => item.message.includes('整理期间') && item.message.includes('未保存')
    ),
    await exec('window.__cwTest.toasts()')
  );
  check('长操作保护（C2）：整理完成后编辑区解锁', (await exec('window.__cwTest.editorLocked()')) === false);
  // 收尾：丢弃整理期间保留的正文，回到磁盘的整理结果
  await exec("window.__cwTest.switchTo(1, 'discard')");
  await exec("window.__cwTest.switchTo(0, 'discard')");

  // ② 整理期间切书：完成回执只属于原来那本，绝不用活值重载到切过去的那一本。
  await exec('window.__cwTest.setText(" 切书保护，原文.")');
  await exec('window.__cwTest.save()');
  await exec("window.__cwTest.newBook('长操作切书测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const c2OtherBookPath = await exec('window.__cwTest.bookPathValue()');
  const c2OtherText = '另一本书的正文：整理期间切过来。';
  await exec(`window.__cwTest.setText(${JSON.stringify(c2OtherText)})`);
  await exec('window.__cwTest.save()');
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(fmtBookPath)})`);
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await exec('window.__cwTest.clearToasts()');
  await exec('window.__cwTest.setTestBookOpDelay(700)');
  await exec("window.__cwE2EFmt2 = window.__cwTest.runFormatBook(); 'started'");
  await waitFor('window.__cwTest.editorLocked() === true');
  // 延迟窗口里切到另一本书；openBookPath 会等切完，整理回执随后才到。
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(c2OtherBookPath)})`);
  await waitFor(`window.__cwTest.bookPathValue() === ${JSON.stringify(c2OtherBookPath)}`);
  const c2FmtResult2 = await exec('window.__cwE2EFmt2');
  await exec('delete window.__cwE2EFmt2');
  await sleep(300);
  const c2OtherMeta = await storage.readBookMeta(c2OtherBookPath);
  const c2OtherDiskText = (await storage.loadChapterText(c2OtherBookPath, c2OtherMeta.chapters[0].file)).text;
  const c2OldMeta = await storage.readBookMeta(fmtBookPath);
  const c2OldDiskText = (await storage.loadChapterText(fmtBookPath, c2OldMeta.chapters[0].file)).text;
  check(
    '长操作保护（C2）：整理期间切书，完成后界面仍是切换后的那本书',
    (await exec('window.__cwTest.bookPathValue()')) === c2OtherBookPath && Boolean(c2FmtResult2 && c2FmtResult2.ok === true),
    c2FmtResult2
  );
  check(
    '长操作保护（C2）：整理期间切书，另一本书的正文原样留在编辑区、没有被重载覆盖',
    (await exec('window.__cwTest.text()')) === c2OtherText && (await exec('window.__cwTest.dirty()')) === false
  );
  check(
    '长操作保护（C2）：整理回执仍写回原书（切走不影响旧书磁盘结果）',
    c2OldDiskText === '　　切书保护，原文。',
    c2OldDiskText
  );
  check('长操作保护（C2）：另一本书的磁盘正文没被整理', c2OtherDiskText === c2OtherText, c2OtherDiskText);
  check(
    '长操作保护（C2）：切书后的完成提示说明切回后可见整理结果',
    (await exec('window.__cwTest.toasts()')).some((item) => item.message.includes('已切换到另一本书')),
    await exec('window.__cwTest.toasts()')
  );
  // 收尾：回到整理书、关掉延迟，后面的分卷断言还在这一本上跑。
  await exec('window.__cwTest.setTestBookOpDelay(0)');
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(fmtBookPath)})`);
  await exec("window.__cwTest.switchTo(0, 'discard')");

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
  const fmtDirtyResult = await fmtDirtyPromise;
  check(
    '整本排版：保存后直接整理（不再有第二个确认框）',
    fmtDirtyResult && fmtDirtyResult.ok === true && (await exec('window.__cwTest.modalOpen()')) === false,
    fmtDirtyResult
  );

  // 导出目录记忆：导出过的文件夹下次要记住（写进 config.json；坏值自动清洗）
  // 五-L3（CI-6）：lastExportDir 已登记进 config-gate 的路径来源白名单 —— config:set 不能凭空把
  // 主进程的「启动孤儿 tmp 回收」/ 导出默认目录引到任意目录；这个字段只由导出流程自己
  // （main.js 的 rememberExportDir → configStore.set）写。这里改为验证「伪造来源被拒绝、原值不变」。
  // 注意：前面的导出 / 另存测试可能已经由导出流程合法写过一次 lastExportDir ——断言的是
  // 「伪造值没有改变现状」，不是「一定为空」。
  // app 由场景前导从 ctx 解构（组文件不许 require electron），见文件头 ctx 解构。
  const configFile = path.join(app.getPath('userData'), 'config.json');
  const configBefore = await exec('window.api.getConfig()');
  const exportDirBefore = configBefore && configBefore.ok === true ? configBefore.data.lastExportDir : '';
  const wantedDir = 'D:\\导出测试目录';
  const setDirRes = await exec(`window.api.setConfig({ lastExportDir: ${JSON.stringify(wantedDir)} })`);
  check(
    '导出目录记忆：config:set 不能凭空指定导出目录（来源校验拒绝，原值不变）',
    Boolean(setDirRes && setDirRes.ok === true && setDirRes.data.lastExportDir === exportDirBefore),
    { before: exportDirBefore, after: setDirRes && setDirRes.data }
  );
  await exec('window.api.setConfig({ lastExportDir: 12345 })');
  const badDirCfg = await exec('window.api.getConfig()');
  check(
    '导出目录记忆：非法值同样被拒（不做类型转换，原值不变）',
    Boolean(badDirCfg && badDirCfg.ok === true && badDirCfg.data.lastExportDir === exportDirBefore),
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
    '导出目录记忆：伪造目录没有落进 config.json（下次启动不会去那个目录清理）',
    Boolean(savedConfig && savedConfig.lastExportDir === exportDirBefore),
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
