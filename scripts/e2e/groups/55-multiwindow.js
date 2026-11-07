// E2E 第 55 组：从 scripts/e2e-scenario.js 原样搬出来（v0.9 B-6，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 本组只做「多窗口」（提案 7.2）：书卡右键「在新窗口打开」/ 禁止同书双开 / 跨窗口删改拦截 /
// 各自编辑保存 / 关一个窗口不退出、最后窗口关闭才退出 / 各自未保存拦截 / 继续上次写作 /
// 书架刷新 / 旧书兼容 / 书库无多余文件。
// 接线：多窗口要用的 closeWindow / setRealClose / resetCloseReady / getCloseReady / windowAllClosed /
// windowBounds / mostRecentWindowId / openBookRegistry 与 fragLegacyBookPath 都由场景的 groupContext()
// 交进来（组文件只 require node 内建，不碰产品代码）；fs / path 用 node 内建。
// 断言、执行顺序、每处 sleep 的时长与位置一条都没改；适配只发生在函数头与解构。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group55MultiWindow(t) {
  const {
    exec,
    check,
    waitFor,
    sleep,
    execIn,
    storage,
    booksRoot,
    userData,
    fileExists,
    chapters: chaptersLib,
    fragLegacyBookPath,
    fragLegacyMetaPath,
    windowsInfo,
    openBookRegistry,
    registryCounts,
    mostRecentWindowId,
    windowBounds,
    closeWindow,
    setRealClose,
    resetCloseReady,
    getCloseReady,
    windowAllClosed
  } = t;

  // 55. 多窗口（提案 7.2，作者 2026-11-01 03:45 拍板）：
  //     书卡右键「在新窗口打开」/ 禁止同书双开 / 跨窗口删改拦截 / 各自编辑保存 /
  //     关一个窗口不退出、最后窗口关闭才退出 / 各自未保存拦截 / 继续上次写作 /
  //     书架刷新 / 旧书兼容 / 书库无多余文件。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const normPath = (p) => path.resolve(String(p || '')).toLowerCase();
  const liveWindows = () => windowsInfo().filter((window) => !window.destroyed);
  const waitWindows = async (count, timeout = 20000) => {
    const startedAt = Date.now();
    for (;;) {
      const list = liveWindows();
      if (list.length === count) return list;
      if (Date.now() - startedAt > timeout) {
        throw new Error(`等待窗口数 ${count} 超时：当前 ${JSON.stringify(liveWindows())}`);
      }
      await sleep(100);
    }
  };
  const waitIn = async (windowId, expr, timeout = 20000) => {
    const startedAt = Date.now();
    for (;;) {
      let value;
      try {
        value = await execIn(windowId, expr);
      } catch {
        /* 窗口刚开 / 刚切页，稍后再试 */
      }
      if (value) return value;
      if (Date.now() - startedAt > timeout) throw new Error(`窗口 ${windowId} 等待超时：${expr}`);
      await sleep(120);
    }
  };
  const makeWindowBook = async (title, chapterName, text) => {
    const created = await storage.createBook(booksRoot, title);
    const chapter = created.meta.chapters[0];
    await storage.saveChapterText(created.path, chapter.file, text);
    chapter.name = chapterName;
    chapter.chars = chaptersLib.countChars(text);
    await storage.writeBookMeta(created.path, created.meta);
    const meta = await storage.readBookMeta(created.path);
    return { path: created.path, meta, file: meta.chapters[0].file, chapterId: meta.chapters[0].id };
  };
  const readBookChapter = async (book) =>
    (await storage.loadChapterText(book.path, book.file)).text;

  const initialWindows = liveWindows();
  check(
    '多窗口：开始时只有一个窗口（前面 646 项仍是单窗口语义）',
    initialWindows.length === 1,
    initialWindows
  );
  const primaryId = initialWindows[0].id;
  const mwBookA = await makeWindowBook('多窗口甲', '甲章', '甲书正文');
  const mwBookB = await makeWindowBook('多窗口乙', '乙章', '乙书正文');
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");

  // 55a. 书卡右键入口「在新窗口打开」：真的点界面菜单，新窗口打开指定书
  check(
    '多窗口：书卡右键菜单有「在新窗口打开」',
    (await exec('window.__cwTest.bookMenuTexts()')).some((text) => text.includes('在新窗口打开'))
  );
  check(
    '多窗口：右键菜单确实是界面上的书卡菜单',
    (await exec(`window.__cwTest.openBookMenuForPath(${JSON.stringify(mwBookA.path)})`)) === true &&
      (await exec('window.__cwTest.bookMenuOpen()')) === true
  );
  await exec('window.__cwTest.clickBookMenuAction("open-new-window")');
  const afterOpen = await waitWindows(2);
  const winAInfo = afterOpen.find((window) => window.bookPath === normPath(mwBookA.path));
  check('多窗口：新窗口打开了刚点的那本书', Boolean(winAInfo), afterOpen);
  check(
    '多窗口：新窗口进入写作页并显示那本书',
    (await waitIn(winAInfo.id, "window.__cwTest.view() === 'editor'")) === true &&
      normPath(await waitIn(winAInfo.id, 'window.__cwTest.bookPathValue()')) === normPath(mwBookA.path)
  );
  check('多窗口：原窗口仍停在书架（没有跟着切走）', (await exec('window.__cwTest.view()')) === 'shelf');
  check(
    '多窗口：打开登记里有 2 个窗口 / 1 本开着的书',
    registryCounts().windows === 2 &&
      registryCounts().openBooks === 1 &&
      openBookRegistry().length === 1
  );

  // 55b. 禁止同一本书开两个窗口：再点一次只是聚焦已有窗口，窗口数不增
  const duplicate = await exec(`window.api.openBookInNewWindow(${JSON.stringify(mwBookA.path)})`);
  check(
    '多窗口：同一本书再开 → 聚焦已有窗口，不新建',
    Boolean(duplicate && duplicate.ok === true && duplicate.data.focused === true) &&
      duplicate.data.windowId === winAInfo.id,
    duplicate
  );
  await sleep(300);
  check(
    '多窗口：重复打开后窗口数不增、登记仍是那一本',
    liveWindows().length === 2 && registryCounts().openBooks === 1 && openBookRegistry().length === 1
  );
  await exec(`window.__cwTest.openBookMenuForPath(${JSON.stringify(mwBookA.path)})`);
  await exec('window.__cwTest.clickBookMenuAction("open-new-window")');
  await sleep(400);
  check(
    '多窗口：从右键入口重复打开也不新增窗口',
    liveWindows().length === 2 && registryCounts().windows === 2
  );

  // 55c. 两个窗口各开一本书，各自编辑 / 保存互不干扰
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(mwBookB.path)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  check('多窗口：两个窗口各开一本书（登记两本）', registryCounts().openBooks === 2);
  check(
    '多窗口：开第二本书不影响另一个窗口正开的书',
    normPath(await waitIn(winAInfo.id, 'window.__cwTest.bookPathValue()')) === normPath(mwBookA.path)
  );
  await execIn(winAInfo.id, "window.__cwTest.setText('甲窗口写入的内容')");
  check(
    '多窗口：A 窗口未保存不影响 B 窗口的脏状态',
    (await execIn(winAInfo.id, 'window.__cwTest.dirty()')) === true &&
      (await exec('window.__cwTest.dirty()')) === false
  );
  const saveA = await execIn(winAInfo.id, 'window.__cwTest.save()');
  check('多窗口：A 窗口保存成功', Boolean(saveA && saveA.ok === true), saveA);
  const recentAfterA = await exec('window.api.getRecentBook()');
  check(
    '多窗口：继续上次写作按最近写作的窗口（刚保存的 A）',
    Boolean(recentAfterA && recentAfterA.ok === true) &&
      normPath(recentAfterA.data.path) === normPath(mwBookA.path) &&
      recentAfterA.data.chapterId === mwBookA.chapterId,
    recentAfterA
  );
  await exec("window.__cwTest.setText('乙窗口写入的内容')");
  const saveB = await exec('window.__cwTest.save()');
  check('多窗口：B 窗口保存成功', Boolean(saveB && saveB.ok === true), saveB);
  check(
    '多窗口：两个窗口保存后磁盘内容各是各的',
    (await readBookChapter(mwBookA)) === '甲窗口写入的内容' &&
      (await readBookChapter(mwBookB)) === '乙窗口写入的内容'
  );
  const recentAfterB = await exec('window.api.getRecentBook()');
  check(
    '多窗口：继续上次写作跟着最近一次保存的窗口走（B）',
    Boolean(recentAfterB && recentAfterB.ok === true) &&
      normPath(recentAfterB.data.path) === normPath(mwBookB.path),
    recentAfterB
  );

  // 55d. 跨窗口删改拦截：B 窗口删除 / 改名 / 整理 / 导入 A 窗口正开着的书 → 拒绝
  const metaAPath = path.join(mwBookA.path, '书目.json');
  const metaABefore = await fs.readFile(metaAPath, 'utf8');
  const deleteBookDenied = await exec(`window.api.deleteBook(${JSON.stringify(mwBookA.path)})`);
  check(
    '多窗口：A 删 B 正开着的书被拒绝并提示先关 / 先切窗口',
    Boolean(deleteBookDenied && deleteBookDenied.ok === false) &&
      deleteBookDenied.code === 'CROSS_WINDOW_BUSY' &&
      /另一个窗口/.test(deleteBookDenied.message),
    deleteBookDenied
  );
  const deleteChapterDenied = await exec(
    `window.api.deleteChapter(${JSON.stringify(mwBookA.path)}, ${JSON.stringify(mwBookA.chapterId)})`
  );
  check(
    '多窗口：A 删 B 正开着的章节被拒绝',
    Boolean(deleteChapterDenied && deleteChapterDenied.ok === false) &&
      deleteChapterDenied.code === 'CROSS_WINDOW_BUSY',
    deleteChapterDenied
  );
  const renameDenied = await exec(
    `window.api.renameBook(${JSON.stringify(mwBookA.path)}, '偷改书名')`
  );
  check(
    '多窗口：A 改 B 正开着的书名被拒绝',
    Boolean(renameDenied && renameDenied.ok === false) && renameDenied.code === 'CROSS_WINDOW_BUSY',
    renameDenied
  );
  const formatDenied = await exec(`window.api.formatBook(${JSON.stringify(mwBookA.path)}, {})`);
  check(
    '多窗口：A 整理 B 正开着的书被拒绝',
    Boolean(formatDenied && formatDenied.ok === false) && formatDenied.code === 'CROSS_WINDOW_BUSY',
    formatDenied
  );
  const mwImportSrc = path.join(userData, 'mw-import-src', '多窗口甲');
  await fs.mkdir(mwImportSrc, { recursive: true });
  await fs.writeFile(path.join(mwImportSrc, '001-外来.txt'), '外来正文', 'utf8');
  const importDenied = await exec(
    `window.api.importBooks([${JSON.stringify(mwImportSrc)}], { mode: 'chapters' })`
  );
  check(
    '多窗口：导入会覆盖 B 正开着的书时被拒绝',
    Boolean(importDenied && importDenied.ok === false) && importDenied.code === 'CROSS_WINDOW_BUSY',
    importDenied
  );
  check(
    '多窗口：被拒绝的删改没有动书 / 章 / 书目 / 回收目录',
    (await fileExists(mwBookA.path)) &&
      (await fileExists(path.join(mwBookA.path, mwBookA.file))) &&
      (await fs.readFile(metaAPath, 'utf8')) === metaABefore &&
      (await fileExists(path.join(mwBookA.path, '_trash'))) === false
  );
  await execIn(winAInfo.id, "window.__cwTest.setText('甲窗口被拦截后仍能写')");
  const saveAfterDenied = await execIn(winAInfo.id, 'window.__cwTest.save()');
  check(
    '多窗口：被拦截的删改没有影响另一个窗口继续保存',
    Boolean(saveAfterDenied && saveAfterDenied.ok === true) &&
      (await readBookChapter(mwBookA)) === '甲窗口被拦截后仍能写'
  );

  // 55e. 影子文件：书 / 章被外部（另一个窗口）删掉后保存必须失败，绝不 mkdir 重建
  const mwBookC = await makeWindowBook('多窗口影子', '影子章', '影子正文');
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(mwBookC.path)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  const shadowChapterPath = path.join(mwBookC.path, mwBookC.file);
  const shadowBytes = await fs.readFile(shadowChapterPath);
  await fs.unlink(shadowChapterPath);
  const shadowFilesBefore = (await fs.readdir(mwBookC.path)).sort().join('|');
  await exec("window.__cwTest.setText('章节被外部删掉后还想保存')");
  const shadowSave = await exec('window.__cwTest.save()');
  check(
    '多窗口：章节文件被删后保存被阻止（CHAPTER_MISSING）',
    Boolean(shadowSave && shadowSave.ok === false) && shadowSave.code === 'CHAPTER_MISSING',
    shadowSave
  );
  check(
    '多窗口：没有重新长出影子 txt / 临时文件',
    (await fileExists(shadowChapterPath)) === false &&
      (await fs.readdir(mwBookC.path)).sort().join('|') === shadowFilesBefore
  );
  await fs.writeFile(shadowChapterPath, shadowBytes);
  await fs.rm(mwBookC.path, { recursive: true, force: true });
  await exec("window.__cwTest.setText('整本书被外部删掉后还想保存')");
  const missingBookSave = await exec('window.__cwTest.save()');
  check(
    '多窗口：书文件夹被删后保存被阻止（BOOK_MISSING）',
    Boolean(missingBookSave && missingBookSave.ok === false) && missingBookSave.code === 'BOOK_MISSING',
    missingBookSave
  );
  check('多窗口：没有 mkdir 重建书文件夹 / 影子文件', (await fileExists(mwBookC.path)) === false);
  await exec('void window.__cwTest.backToShelf()');
  await waitIn(primaryId, 'window.__cwTest.modalOpen() === true');
  await exec("window.__cwTest.answerModal('discard')");
  await waitFor("window.__cwTest.view() === 'shelf'");

  // 55f. 两个窗口各自未保存拦截：关一个窗口只问这个窗口，取消不影响另一个窗口
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(mwBookB.path)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await execIn(winAInfo.id, "window.__cwTest.setText('关窗前的未保存内容')");
  await exec("window.__cwTest.setText('B 窗口的未保存内容')");
  setRealClose(true);
  resetCloseReady(null);
  closeWindow(winAInfo.id);
  await waitIn(winAInfo.id, 'window.__cwTest.modalOpen() === true');
  check(
    '多窗口：关窗询问只出现在被关的窗口',
    (await exec('window.__cwTest.modalOpen()')) === false
  );
  check(
    '多窗口：另一个窗口保持自己的未保存状态（没被牵连）',
    liveWindows().length === 2 && (await exec('window.__cwTest.dirty()')) === true
  );
  await execIn(winAInfo.id, "window.__cwTest.answerModal('cancel')");
  await sleep(500);
  check(
    '多窗口：取消关窗后该窗口还在、内容还在',
    liveWindows().length === 2 &&
      (await execIn(winAInfo.id, 'window.__cwTest.dirty()')) === true &&
      (await waitIn(winAInfo.id, "window.__cwTest.view() === 'editor'")) === true
  );
  closeWindow(winAInfo.id);
  await waitIn(winAInfo.id, 'window.__cwTest.modalOpen() === true');
  await execIn(winAInfo.id, "window.__cwTest.answerModal('discard')");
  await waitWindows(1);
  check(
    '多窗口：关掉一个窗口应用不退出（还剩最后一个窗口）',
    windowAllClosed() === false && liveWindows().length === 1
  );
  check(
    '多窗口：关掉窗口后释放打开登记',
    registryCounts().openBooks === 1 &&
      openBookRegistry().every((item) => item.windowId !== String(winAInfo.id)) &&
      openBookRegistry().some((item) => item.bookPath === normPath(mwBookB.path)),
    openBookRegistry()
  );
  check(
    '多窗口：被丢弃的未保存内容没有偷偷写盘',
    (await readBookChapter(mwBookA)) === '甲窗口被拦截后仍能写'
  );
  check('多窗口：关窗回执来自被关的窗口', getCloseReady(winAInfo.id) === true);

  // 55g. 关掉一个窗口后书可以重新打开；「继续上次写作」/ 最近窗口跟着更新
  const saveBAfterClose = await exec('window.__cwTest.save()');
  check('多窗口：剩下的窗口照常保存', Boolean(saveBAfterClose && saveBAfterClose.ok === true));
  const reopenA = await exec(`window.api.openBookInNewWindow(${JSON.stringify(mwBookA.path)})`);
  check(
    '多窗口：窗口关掉后同一本书可以重新打开',
    Boolean(reopenA && reopenA.ok === true && reopenA.data.focused === false),
    reopenA
  );
  const winA2Info = (await waitWindows(2)).find((window) => window.bookPath === normPath(mwBookA.path));
  check('多窗口：重新打开的窗口登记正确', Boolean(winA2Info));
  check(
    '多窗口：重新打开的窗口进入写作页',
    (await waitIn(winA2Info.id, "window.__cwTest.view() === 'editor'")) === true &&
      normPath(await waitIn(winA2Info.id, 'window.__cwTest.bookPathValue()')) === normPath(mwBookA.path)
  );
  check(
    '多窗口：最近使用的窗口就是刚开的新窗口',
    mostRecentWindowId() === String(winA2Info.id),
    { recent: mostRecentWindowId(), winA2: winA2Info.id }
  );
  const recentReopen = await exec('window.api.getRecentBook()');
  check(
    '多窗口：继续上次写作指向最近打开的 A 书',
    Boolean(recentReopen && recentReopen.ok === true) &&
      normPath(recentReopen.data.path) === normPath(mwBookA.path),
    recentReopen
  );
  closeWindow(winA2Info.id);
  await waitWindows(1);
  check('多窗口：关掉非最后窗口应用还在', windowAllClosed() === false);

  // 55h. 书架刷新：两个窗口都在书架时，一个窗口新建书，另一个窗口的书架自动刷新
  const openA3 = await exec(`window.api.openBookInNewWindow(${JSON.stringify(mwBookA.path)})`);
  check('多窗口：再次在新窗口打开 A', Boolean(openA3 && openA3.ok === true));
  const winA3Info = (await waitWindows(2)).find((window) => window.bookPath === normPath(mwBookA.path));
  check('多窗口：第三个窗口登记正确', Boolean(winA3Info));
  await waitIn(winA3Info.id, "window.__cwTest.view() === 'editor'");
  await execIn(winA3Info.id, 'window.__cwTest.backToShelf()');
  await waitIn(winA3Info.id, "window.__cwTest.view() === 'shelf'");
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  check(
    '多窗口：两个窗口都停在书架',
    liveWindows().length === 2 && (await execIn(winA3Info.id, "window.__cwTest.view() === 'shelf'")) === true
  );
  await exec("window.__cwTest.newBook('多窗口新书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const shelfRefreshed = await waitIn(
    winA3Info.id,
    "window.__cwTest.shelfTitles().includes('多窗口新书')"
  );
  check('多窗口：一个窗口新建书，另一个窗口的书架自动刷新', shelfRefreshed === true);
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  closeWindow(winA3Info.id);
  await waitWindows(1);
  check('多窗口：关掉非最后窗口应用还在（书架刷新窗口）', windowAllClosed() === false);

  // 55i. 旧数据兼容：v0.4.1 形状的旧书（没有 schemaVersion）能开在新窗口，书目不被补字段
  const legacyMetaBefore = await fs.readFile(fragLegacyMetaPath, 'utf8');
  const openLegacy = await exec(`window.api.openBookInNewWindow(${JSON.stringify(fragLegacyBookPath)})`);
  check(
    '多窗口：v0.4.1 旧书能开在新窗口',
    Boolean(openLegacy && openLegacy.ok === true && openLegacy.data.focused === false),
    openLegacy
  );
  const winLegacyInfo = (await waitWindows(2)).find(
    (window) => window.bookPath === normPath(fragLegacyBookPath)
  );
  check('多窗口：旧书窗口登记正确', Boolean(winLegacyInfo));
  check(
    '多窗口：旧书在新窗口正常显示章节',
    (await waitIn(winLegacyInfo.id, "window.__cwTest.view() === 'editor'")) === true &&
      (await waitIn(winLegacyInfo.id, 'window.__cwTest.chapterTitles().length > 0')) === true
  );
  const legacyMetaAfter = await fs.readFile(fragLegacyMetaPath, 'utf8');
  check(
    '多窗口：打开旧书不补 schemaVersion / 不改书目（逐字节一致）',
    legacyMetaAfter === legacyMetaBefore && legacyMetaBefore.includes('"schemaVersion"') === false
  );
  closeWindow(winLegacyInfo.id);
  await waitWindows(1);

  // 55j. 配置 / 书库不多出东西：窗口登记只存在内存里，窗口位置仍用现有 windowBounds
  const mwConfigPath = path.join(userData, 'config.json');
  const mwConfig = JSON.parse(await fs.readFile(mwConfigPath, 'utf8'));
  const mwConfigKeys = ['openWindows', 'openBooks', 'windowSessions', 'multiWindow', 'windows'].filter(
    (key) => key in mwConfig
  );
  check('多窗口：配置没有新增窗口登记字段（登记只在内存里）', mwConfigKeys.length === 0, mwConfigKeys);
  check(
    '多窗口：窗口位置大小仍用现有 windowBounds 一个字段',
    Boolean(mwConfig.windowBounds && Number.isFinite(mwConfig.windowBounds.width))
  );
  const dirA = (await fs.readdir(mwBookA.path)).sort().join('|');
  const dirB = (await fs.readdir(mwBookB.path)).sort().join('|');
  check(
    '多窗口：书文件夹没有多出影子 / 临时文件',
    !dirA.includes('.tmp-') && !dirB.includes('.tmp-') && !dirA.includes('_trash') && !dirB.includes('_trash'),
    { dirA, dirB }
  );
  const rootEntries = await fs.readdir(booksRoot);
  check(
    '多窗口：书库根目录没有多出临时导入 / 影子书',
    rootEntries.every(
      (name) =>
        !name.startsWith('.import-') &&
        !name.startsWith('mw-import') &&
        name !== '多窗口影子' &&
        !name.startsWith('多窗口影子')
    ),
    rootEntries
  );

  // 55k. 只关最后一个窗口才退出应用：关之前记下最近窗口的位置 / 大小
  check('多窗口：关闭前只剩最后一个窗口', liveWindows().length === 1);
  const primaryBounds = windowBounds(primaryId);
  resetCloseReady(null);
  closeWindow(primaryId);
  let windowsAllClosed = false;
  for (let i = 0; i < 100; i += 1) {
    if (windowAllClosed()) {
      windowsAllClosed = true;
      break;
    }
    await sleep(100);
  }
  check(
    '多窗口：最后一个窗口关闭后应用才退出（window-all-closed）',
    windowsAllClosed === true && liveWindows().length === 0
  );
  check(
    '多窗口：退出时打开登记已清空',
    registryCounts().windows === 0 && registryCounts().openBooks === 0,
    registryCounts()
  );
  check('多窗口：最后一个窗口的关窗回执允许关闭', getCloseReady(primaryId) === true);
  const mwConfigAfterQuit = JSON.parse(await fs.readFile(mwConfigPath, 'utf8'));
  check(
    '多窗口：上次窗口位置 / 大小按最近使用的窗口记下',
    Boolean(
      primaryBounds &&
        mwConfigAfterQuit.windowBounds &&
        mwConfigAfterQuit.windowBounds.x === primaryBounds.x &&
        mwConfigAfterQuit.windowBounds.y === primaryBounds.y &&
        mwConfigAfterQuit.windowBounds.width === primaryBounds.width &&
        mwConfigAfterQuit.windowBounds.height === primaryBounds.height
    ),
    { primaryBounds, saved: mwConfigAfterQuit.windowBounds }
  );
};
