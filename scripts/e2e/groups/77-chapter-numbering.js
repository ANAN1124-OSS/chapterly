// E2E 第 77 组：章号编号方式（2026-11-10）——全书连续 / 每卷从第 1 章重新编号。
//
// 钉住四件事：
//   1. 默认仍是全书连续（旧书零迁移）；
//   2. 设置 → 按书 → 章号选「每卷重新编号」后，目录 / 顶栏 / 状态栏 / 跳章同步用卷内章号；
//   3. 设置写进 书目.json，重开书仍然生效；切回「全书连续」字段被删掉；
//   4. 跳章纯数字在按卷模式下把同号的每个卷都列出来（带卷名）。
//
// 自足：自己造一本两卷 6 章的书、自己收尾删掉。

module.exports = async function group77ChapterNumbering(t) {
  const { exec, check, waitFor, storage, booksRoot, deleteBookWithRetry } = t;

  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");

  const created = await storage.createBook(booksRoot, '编号演练');
  const bookPath = created.path;
  let meta = await storage.readBookMeta(bookPath);
  await storage.renameChapter(bookPath, meta.chapters[0].id, '起风');
  const v1 = await storage.createVolume(bookPath, '卷一 · 归途');
  const v2 = await storage.createVolume(bookPath, '卷二 · 渡海');
  await storage.moveChapterToVolume(bookPath, meta.chapters[0].id, v1.volume.id);
  for (const [name, volumeId] of [
    ['夜雨', v1.volume.id],
    ['远行', v1.volume.id],
    ['渡口', v2.volume.id],
    ['归途', v2.volume.id],
    ['上岸', v2.volume.id]
  ]) {
    meta = await storage.readBookMeta(bookPath);
    await storage.createChapterWithText(bookPath, {
      insertIndex: meta.chapters.length,
      name,
      text: '演练正文。\n',
      volumeId
    });
  }
  meta = await storage.readBookMeta(bookPath);
  check(
    '章号编号：演练书 6 章两卷，章序为 卷一 3 章 + 卷二 3 章',
    meta.chapters.length === 6 &&
      meta.chapters.map((chapter) => chapter.name).join(',') === '起风,夜雨,远行,渡口,归途,上岸',
    meta.chapters.map((chapter) => chapter.name)
  );

  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await waitFor("document.querySelectorAll('#chapter-list .chapter-item').length === 6");

  const directoryNumbers = () =>
    exec("Array.from(document.querySelectorAll('#chapter-list .chapter-num')).map((el) => el.dataset.num)");
  const statusLabel = () => exec("document.getElementById('status-chapter-label').textContent");
  const chapterTitleText = () => exec("document.getElementById('chapter-title').textContent");

  // 77a. 默认全书连续
  check(
    '章号编号：默认全书连续（目录 1–6，状态栏 / 顶栏第1章）',
    JSON.stringify(await directoryNumbers()) === JSON.stringify(['1', '2', '3', '4', '5', '6']) &&
      (await statusLabel()) === '第1章' &&
      (await chapterTitleText()) === '第1章：起风' &&
      (await storage.readBookMeta(bookPath)).chapterNumbering === undefined,
    { numbers: await directoryNumbers(), status: await statusLabel() }
  );

  // 77b. 设置 → 按书 → 章号：切到每卷重新编号
  await exec('window.__cwTest.openSettings()');
  await waitFor("!document.getElementById('settings-backdrop').classList.contains('hidden')");
  check(
    '章号编号：按书设置里有「章号」，默认回填全书连续',
    (await exec("!document.getElementById('settings-numbering-field').classList.contains('hidden')")) === true &&
      (await exec("document.getElementById('settings-chapter-numbering').value")) === 'continuous'
  );
  await exec("document.getElementById('settings-chapter-numbering').value = 'volume';");
  await exec('window.__cwTest.saveSettings()');
  await waitFor("window.__cwTest.state.meta.chapterNumbering === 'volume'");
  await waitFor("document.getElementById('settings-backdrop').classList.contains('hidden')");

  check(
    '章号编号：切到按卷编号后目录 1,2,3 / 1,2,3',
    JSON.stringify(await directoryNumbers()) === JSON.stringify(['1', '2', '3', '1', '2', '3']),
    await directoryNumbers()
  );
  check(
    '章号编号：按卷模式写进 书目.json（chapterNumbering = volume）',
    (await storage.readBookMeta(bookPath)).chapterNumbering === 'volume'
  );

  // 77c. 切到卷二第 1 章：状态栏 / 顶栏按卷内章号显示
  await exec("window.__cwTest.switchTo(3, 'discard')");
  await waitFor("document.querySelector('#chapter-list .chapter-item.active').dataset.index === '3'");
  check(
    '章号编号：卷二第 1 章在状态栏 / 顶栏显示「第1章」，不是第4章',
    (await statusLabel()) === '第1章' && (await chapterTitleText()) === '第1章：渡口',
    { status: await statusLabel(), title: await chapterTitleText() }
  );

  // 77d. 跳章纯数字：同号章按卷全部列出，带卷名
  await exec('window.__cwTest.openJumpDialog()');
  await waitFor('window.__cwTest.jumpDialogOpen() === true');
  await exec("window.__cwTest.setJumpQuery('1')");
  await waitFor('window.__cwTest.jumpResultTexts().length === 2');
  const jumpTexts = await exec('window.__cwTest.jumpResultTexts()');
  check(
    '章号编号：按卷模式下 Ctrl+G 输入 1 列出两卷的第 1 章（带卷名）',
    jumpTexts.length === 2 &&
      jumpTexts.some((text) => text.includes('卷一 · 归途') && text.includes('第1章：起风')) &&
      jumpTexts.some((text) => text.includes('卷二 · 渡海') && text.includes('第1章：渡口')),
    jumpTexts
  );
  check(
    '章号编号：跳章汇总说明「按卷编号」并在多个卷命中时提示',
    (await exec('window.__cwTest.jumpSummary()')).includes('按卷编号'),
    await exec('window.__cwTest.jumpSummary()')
  );
  await exec('window.__cwTest.closeJumpDialog()');

  // 77e. 重开书仍然生效（设置存在书目里，不是内存）
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await waitFor("document.querySelectorAll('#chapter-list .chapter-item').length === 6");
  check(
    '章号编号：重新打开这本书，按卷编号仍生效',
    (await exec("window.__cwTest.state.meta.chapterNumbering")) === 'volume' &&
      JSON.stringify(await directoryNumbers()) === JSON.stringify(['1', '2', '3', '1', '2', '3'])
  );

  // 77f. 切回全书连续：字段从书目删除，章号恢复 1–6
  await exec('window.__cwTest.openSettings()');
  await waitFor("!document.getElementById('settings-backdrop').classList.contains('hidden')");
  await exec("document.getElementById('settings-chapter-numbering').value = 'continuous';");
  await exec('window.__cwTest.saveSettings()');
  await waitFor('window.__cwTest.state.meta.chapterNumbering === undefined');
  check(
    '章号编号：切回全书连续后目录 1–6，书目不再留 chapterNumbering',
    JSON.stringify(await directoryNumbers()) === JSON.stringify(['1', '2', '3', '4', '5', '6']) &&
      (await storage.readBookMeta(bookPath)).chapterNumbering === undefined
  );

  // 收尾
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await deleteBookWithRetry(bookPath);
  check('章号编号：演练书清理完成', !(await t.fileExists(bookPath)));
};