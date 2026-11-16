// E2E 第 82 组（v1.8.0 WP-03 / 审计 V101、V102、C9、C10）：开书 / 载章状态机。
//
// 四条验收锚点（工作清单 WP-03）：
//   V101：打开缺章书（目标章文件缺失）→ 编辑区清空 + 遮罩 + index=-1 / loadedChapterId=null；
//         输入后 Ctrl+S 被拒，新书目标章字节一个都不变（绝不把上一本正文写进新书）。
//   V102：快速连开两本，先点的书响应更慢 → 最终打开最后点击的那一本，迟到响应不覆盖。
//   C9：载章在途编辑区只读；连点两章后落到最后点的章，旧回执不覆盖新目标。
//   C10：保存在途时选「不保存」切章 → 在途保存按快照章完成（落盘是快照不是后来敲的字），
//        回执不把旧章 mtime / 字数写到新章上。
//
// 自足：本组自己新建两本临时书（A 两章 / B 三章），跑完全部删掉，不依赖前面组留下的书，
// 也不给后面的多窗口组（第 55 组）留垃圾。组文件只 require node 内建（静态闸门要求）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group82OpenBookState(t) {
  const { exec, check, waitFor, sleep, storage, booksRoot, chapters: chaptersLib } = t;

  const A_TITLE = '开书状态机A书';
  const B_TITLE = '开书状态机B书';
  const A_TEXT_1 = 'A书第一章正文';
  const A_TEXT_2 = 'A书第二章正文';
  const B_TEXT_1 = 'B书第一章正文';
  const B_TEXT_2 = 'B书第二章正文';
  const B_TEXT_3 = 'B书第三章正文';
  // 缺章文件先挪到书库外面的临时目录：测完原样放回，不生成 _trash、不动书目。
  const holdDir = path.join(path.dirname(booksRoot), 'e2e-open-book-hold');
  const heldFile = path.join(holdDir, 'B-戊章.txt');
  let cleaned = false;

  const cleanup = async () => {
    cleaned = true;
    await fs.rm(holdDir, { recursive: true, force: true }).catch(() => {});
    try {
      await exec('window.__cwTest.backToShelf()');
      await exec(`window.__cwTest.deleteBookByFolder(${JSON.stringify(A_TITLE)}, { skipConfirm: true })`);
      await exec(`window.__cwTest.deleteBookByFolder(${JSON.stringify(B_TITLE)}, { skipConfirm: true })`);
      await exec('window.__cwTest.refreshShelf()');
    } catch (err) {
      console.warn('[e2e] 第 82 组收尾删临时书失败（留给排查）：', err.message);
    }
  };

  try {
    // ---------- 前导：回书架 + 造两本临时书 ----------
    if ((await exec('window.__cwTest.view()')) !== 'shelf') {
      await exec('window.__cwTest.save()'); // 不丢上一组可能留在编辑区里的改动
      await exec('window.__cwTest.backToShelf()');
      await waitFor("window.__cwTest.view() === 'shelf'");
    }
    await exec(`window.__cwTest.newBook(${JSON.stringify(A_TITLE)})`);
    await waitFor("window.__cwTest.view() === 'editor'");
    const bookA = await exec('window.__cwTest.bookPathValue()');
    await exec("window.__cwTest.renameChapterAt(0, '甲章')");
    await exec(`window.__cwTest.setText(${JSON.stringify(A_TEXT_1)})`);
    await exec('window.__cwTest.save()');
    await exec("window.__cwTest.newChapter('乙章')");
    await waitFor("window.__cwTest.chapterNames().includes('乙章')");
    await exec(`window.__cwTest.setText(${JSON.stringify(A_TEXT_2)})`);
    await exec('window.__cwTest.save()');
    await exec("window.__cwTest.switchTo(0, 'discard')");
    await waitFor('window.__cwTest.currentIndex() === 0');
    const metaA = await storage.readBookMeta(bookA);

    await exec('window.__cwTest.backToShelf()');
    await waitFor("window.__cwTest.view() === 'shelf'");
    await exec(`window.__cwTest.newBook(${JSON.stringify(B_TITLE)})`);
    await waitFor("window.__cwTest.view() === 'editor'");
    const bookB = await exec('window.__cwTest.bookPathValue()');
    await exec("window.__cwTest.renameChapterAt(0, '丙章')");
    await exec(`window.__cwTest.setText(${JSON.stringify(B_TEXT_1)})`);
    await exec('window.__cwTest.save()');
    await exec("window.__cwTest.newChapter('丁章')");
    await waitFor("window.__cwTest.chapterNames().includes('丁章')");
    await exec(`window.__cwTest.setText(${JSON.stringify(B_TEXT_2)})`);
    await exec('window.__cwTest.save()');
    await exec("window.__cwTest.newChapter('戊章')");
    await waitFor("window.__cwTest.chapterNames().includes('戊章')");
    await exec(`window.__cwTest.setText(${JSON.stringify(B_TEXT_3)})`);
    await exec('window.__cwTest.save()');
    const metaB = await storage.readBookMeta(bookB);
    check(
      '开书状态机前导：两本临时书就绪（A 两章 / B 三章，内容都已落盘）',
      metaA.chapters.length === 2 &&
        metaB.chapters.length === 3 &&
        (await storage.loadChapterText(bookA, metaA.chapters[0].file)).text === A_TEXT_1 &&
        (await storage.loadChapterText(bookA, metaA.chapters[1].file)).text === A_TEXT_2 &&
        (await storage.loadChapterText(bookB, metaB.chapters[2].file)).text === B_TEXT_3
    );
    await exec('window.__cwTest.backToShelf()');
    await waitFor("window.__cwTest.view() === 'shelf'");

    // ---------- V101：打开「目标章缺文件」的书 ----------
    // B 上次停在戊章（index 2）；把它的文件挪走后再打开，载章必须失败。
    const bThirdPath = path.join(bookB, metaB.chapters[2].file);
    const bFirstPath = path.join(bookB, metaB.chapters[0].file);
    const bFirstBytesBefore = await fs.readFile(bFirstPath);
    await fs.rm(holdDir, { recursive: true, force: true });
    await fs.mkdir(holdDir, { recursive: true });
    await fs.rename(bThirdPath, heldFile);

    // 先打开 A（上一本），编辑区里是 A 的正文；再打开缺章的 B。
    await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookA)})`);
    await waitFor('window.__cwTest.currentIndex() === 0');
    check(
      '开书状态机（V101 前导）：先打开 A 书第 1 章，编辑区是 A 的正文',
      (await exec('window.__cwTest.text()')) === A_TEXT_1 && (await exec('window.__cwTest.bookPathValue()')) === bookA
    );

    // ---------- V401（审计修复 #7 的 E2E 锚点）：大段插入快照不能跨书活到「载章失败」的遮罩态 ----------
    // 在 A 里 bulk 插入 >2 万字（整串赋值通道会建一次性快照 bulkWriteUndo），**不输入任何字**，
    // 直接换到「目标章缺文件」的 B。以前 commitOpenBook 只清 undoUi、不清快照：遮罩态只是 readOnly
    // （仍可点击聚焦、keydown 照常触发），一下 Ctrl+Z 就把 A 的整章正文写进 B 的空编辑区 + 假脏态。
    const bulkText = '大'.repeat(20001);
    await exec(`window.__cwTest.openCapture(${JSON.stringify(bulkText)})`);
    await waitFor('window.__cwTest.captureOpen() === true');
    const bulkApplied = JSON.parse(
      await exec('window.__cwTest.captureApplyBody({ pending: true }).then((r) => JSON.stringify(r || null))')
    );
    await exec('window.__cwTest.closeCapture()');
    check(
      '开书状态机（V401 前导）：A 书里大段插入 >2 万字（一次性撤销快照建立、正文标脏）',
      Boolean(bulkApplied && bulkApplied.ok === true && bulkApplied.consumed === true && bulkApplied.chars === bulkText.length) &&
        (await exec('window.__cwTest.dirty()')) === true,
      bulkApplied
    );
    // 换书：dirty 时照常先问未保存（V401 触发链就是「不输入、直接换书」→ 选不保存）。
    // 这里刻意不 await：询问框要等 E2E 拿到回执再点。
    await exec(`void window.__cwTest.openBookPath(${JSON.stringify(bookB)}); 'started'`);
    await waitFor('window.__cwTest.modalOpen()');
    check(
      '开书状态机（V401 前导）：换书前照常拦截未保存修改（选「不保存」继续）',
      (await exec('window.__cwTest.dialog()')) === '换书前先处理未保存的修改'
    );
    await exec("window.__cwTest.answerModal('discard')");
    await waitFor(`window.__cwTest.bookPathValue() === ${JSON.stringify(bookB)} ? 'ok' : null`, 8000);
    const v101 = await exec(`(() => {
      const el = document.getElementById('editor');
      return {
        view: window.__cwTest.view(),
        bookPath: window.__cwTest.bookPathValue(),
        index: window.__cwTest.state.index,
        loadedChapterId: window.__cwTest.state.loadedChapterId,
        text: el.value,
        readOnly: el.readOnly === true,
        busy: el.getAttribute('aria-busy') === 'true',
        placeholder: el.placeholder,
        dirty: window.__cwTest.dirty()
      };
    })()`);
    check(
      '开书状态机（V101）：目标章缺文件 → index=-1 / loadedChapterId=null / 编辑区清空并只读遮罩',
      v101.view === 'editor' &&
        v101.bookPath === bookB &&
        v101.index === -1 &&
        v101.loadedChapterId === null &&
        v101.text === '' &&
        v101.readOnly === true &&
        v101.busy === true &&
        v101.dirty === false,
      v101
    );

    // V401：载章失败的遮罩态里点一下编辑区、按 Ctrl+Z —— 快照必须已经随换书作废，正文仍为空、
    // 也不许出现「假脏态」（以前这里会把 A 书整章正文写进 B 的空编辑区并置 dirty）。
    const bulkUndoProbe = await exec(`(() => {
      const el = document.getElementById('editor');
      el.focus();
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
      return { text: el.value, dirty: window.__cwTest.dirty(), readOnly: el.readOnly };
    })()`);
    check(
      '开书状态机（V401）：换书 + 载章失败后 Ctrl+Z 不会把上一本正文写进新书（编辑区仍空、不假脏）',
      bulkUndoProbe.text === '' && bulkUndoProbe.dirty === false && bulkUndoProbe.readOnly === true,
      bulkUndoProbe
    );

    // 模拟作者在新书界面里输入后按 Ctrl+S：没有已载章节 → 必须拒绝，新书目标章字节不变。
    await exec("window.__cwTest.setText('上一本正文不该写进新书')");
    const blockedSave = await exec('window.__cwTest.save()');
    const bFirstBytesAfter = await fs.readFile(bFirstPath);
    const bFirstTextNow = (await storage.loadChapterText(bookB, metaB.chapters[0].file)).text;
    check(
      '开书状态机（V101）：输入后 Ctrl+S 被拒（NO_CHAPTER），新书目标章字节一个都没变',
      Boolean(blockedSave && blockedSave.ok === false && blockedSave.code === 'NO_CHAPTER') &&
        bFirstBytesBefore.equals(bFirstBytesAfter) &&
        bFirstTextNow === B_TEXT_1,
      { blockedSave, sameBytes: bFirstBytesBefore.equals(bFirstBytesAfter), bFirstTextNow }
    );
    await exec("window.__cwTest.setText('')");
    check('开书状态机（V101）：清空编辑区后回到干净态（丢弃测试输入）', (await exec('window.__cwTest.dirty()')) === false);

    // 缺章恢复后重开：回到上次章节、遮罩解除（只读 / aria-busy 都清掉）。
    await fs.rename(heldFile, bThirdPath);
    await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookB)})`);
    await waitFor("window.__cwTest.currentIndex() === 2 ? 'ok' : null");
    const recovered = await exec(`(() => ({
      index: window.__cwTest.state.index,
      loadedChapterId: window.__cwTest.state.loadedChapterId,
      text: window.__cwTest.text(),
      readOnly: document.getElementById('editor').readOnly,
      busy: document.getElementById('editor').getAttribute('aria-busy')
    }))()`);
    check(
      '开书状态机（V101/C9）：缺章恢复后重开 → 载入上次章节，遮罩解除（只读=false、无 aria-busy）',
      recovered.index === 2 &&
        recovered.loadedChapterId === metaB.chapters[2].id &&
        recovered.text === B_TEXT_3 &&
        recovered.readOnly === false &&
        recovered.busy === null,
      recovered
    );

    // ---------- C9：载章在途只读 + 连点两章落在最后点的章 ----------
    await exec("window.__cwTest.switchTo(0, 'discard')");
    await waitFor('window.__cwTest.currentIndex() === 0');
    await exec('window.__cwTest.setTestLoadChapterDelay(500)');
    await exec("void window.__cwTest.switchTo(1); 'started'");
    const lockedDuringLoad = await waitFor(
      "document.getElementById('editor').readOnly === true && document.getElementById('editor').getAttribute('aria-busy') === 'true' ? 'locked' : null",
      3000
    );
    await exec('window.__cwTest.setTestLoadChapterDelay(60)');
    await exec("void window.__cwTest.switchTo(2); 'started'");
    const c9Landed = await waitFor("window.__cwTest.currentIndex() === 2 ? 'ok' : null", 8000);
    await exec('window.__cwTest.setTestLoadChapterDelay(0)');
    const c9 = await exec(`(() => ({
      index: window.__cwTest.state.index,
      loadedChapterId: window.__cwTest.state.loadedChapterId,
      text: window.__cwTest.text(),
      dirty: window.__cwTest.dirty(),
      readOnly: document.getElementById('editor').readOnly
    }))()`);
    check(
      '开书状态机（C9）：载章在途编辑区只读；连点两章落到最后点的第 3 章，旧回执不覆盖',
      lockedDuringLoad === 'locked' &&
        c9Landed === 'ok' &&
        c9.index === 2 &&
        c9.loadedChapterId === metaB.chapters[2].id &&
        c9.text === B_TEXT_3 &&
        c9.dirty === false &&
        c9.readOnly === false,
      { lockedDuringLoad, c9 }
    );

    // ---------- V102：快速连开两本，先点的响应更慢 ----------
    await exec('window.__cwTest.backToShelf()');
    await waitFor("window.__cwTest.view() === 'shelf'");
    await exec('window.__cwTest.setTestOpenBookDelay(700)');
    await exec(`void window.__cwTest.openBookPath(${JSON.stringify(bookA)}); 'started'`);
    await exec('window.__cwTest.setTestOpenBookDelay(60)');
    await exec(`void window.__cwTest.openBookPath(${JSON.stringify(bookB)}); 'started'`);
    await sleep(1200); // 等 A 的迟到响应也回来（700ms 延迟 + 载章余量）
    const v102 = await exec(`(() => ({
      view: window.__cwTest.view(),
      bookPath: window.__cwTest.bookPathValue(),
      index: window.__cwTest.state.index,
      loadedChapterId: window.__cwTest.state.loadedChapterId,
      text: window.__cwTest.text()
    }))()`);
    check(
      '开书状态机（V102）：后点的 B 先返回、先点的 A 迟到 → 最终打开最后点击的 B，A 的响应不覆盖',
      v102.view === 'editor' &&
        v102.bookPath === bookB &&
        v102.index === 2 &&
        v102.loadedChapterId === metaB.chapters[2].id &&
        v102.text === B_TEXT_3,
      v102
    );
    // 收起延迟、正常重开 B：确认乱序过后开书链路照常可用（也把主进程的打开登记落回 B）。
    await exec('window.__cwTest.setTestOpenBookDelay(0)');
    await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookB)})`);
    await waitFor("window.__cwTest.currentIndex() === 2 ? 'ok' : null");
    check(
      '开书状态机（V102）：延迟撤掉后重开 B 正常（乱序没有留下不可用的状态）',
      (await exec('window.__cwTest.text()')) === B_TEXT_3 && (await exec('window.__cwTest.view()')) === 'editor'
    );

    // ---------- C10：保存在途时选「不保存」切章 ----------
    await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookA)})`);
    await waitFor('window.__cwTest.currentIndex() === 0');
    const aSecondFile = path.join(bookA, metaA.chapters[1].file);
    const aSecondMtime = (await fs.stat(aSecondFile)).mtimeMs;
    const snapshotText = 'C10 快照正文：保存发起那一刻';
    const typedDuringSave = 'C10 快照正文：保存发起那一刻\n\n保存期间又敲的这句没有写盘';
    await exec('window.__cwTest.setTestSaveDelay(600)');
    await exec(`window.__cwTest.setText(${JSON.stringify(snapshotText)})`);
    await exec("window.__cwE2ESave = window.__cwTest.save(); 'started'");
    // 保存还在延迟里：继续输入（C1 语义下仍脏），然后选「不保存」切到第 2 章。
    await exec(`window.__cwTest.setText(${JSON.stringify(typedDuringSave)})`);
    await exec("void window.__cwTest.switchTo(1, 'discard'); 'started'");
    const c10Landed = await waitFor("window.__cwTest.currentIndex() === 1 ? 'ok' : null", 8000);
    const c10Save = await exec('window.__cwE2ESave');
    await exec('delete window.__cwE2ESave');
    await exec('window.__cwTest.setTestSaveDelay(0)');
    const aFirstText = (await storage.loadChapterText(bookA, metaA.chapters[0].file)).text;
    const metaAAfter = await storage.readBookMeta(bookA);
    const c10 = await exec(`(() => ({
      index: window.__cwTest.state.index,
      loadedChapterId: window.__cwTest.state.loadedChapterId,
      text: window.__cwTest.text(),
      dirty: window.__cwTest.dirty(),
      mtime: window.__cwTest.state.loadedMtimeMs
    }))()`);
    check(
      '开书状态机（C10）：保存在途时不保存切章 → 在途保存按快照章完成（落盘=快照，不是后来敲的字）',
      c10Landed === 'ok' && Boolean(c10Save && c10Save.ok === true) && aFirstText === snapshotText,
      { c10Landed, c10Save, aFirstText }
    );
    check(
      '开书状态机（C10）：切过去的是目标章，旧章回执不把 mtime / 字数写到新章上',
      c10.index === 1 &&
        c10.loadedChapterId === metaA.chapters[1].id &&
        c10.text === A_TEXT_2 &&
        c10.dirty === false &&
        Math.abs(c10.mtime - aSecondMtime) < 1 &&
        metaAAfter.chapters[0].chars === chaptersLib.countChars(snapshotText) &&
        metaAAfter.chapters[1].chars === chaptersLib.countChars(A_TEXT_2),
      { c10, aSecondMtime, metaAAfter: metaAAfter.chapters.map((chapter) => chapter.chars) }
    );

    // ---------- 收尾：删掉两本临时书，不给后面的组留垃圾 ----------
    await exec('window.__cwTest.backToShelf()');
    await waitFor("window.__cwTest.view() === 'shelf'");
    await cleanup();
    await sleep(500);
    const remaining = await exec('window.__cwTest.shelfTitles()');
    check(
      '开书状态机：两本临时书已从书架移除（不给后面的组留垃圾）',
      Array.isArray(remaining) && !remaining.includes(A_TITLE) && !remaining.includes(B_TITLE),
      remaining
    );
  } finally {
    // 无论断言怎么失败，都不能把「测试延迟」留给后面的组（否则第 55 组会莫名变慢 / 乱序）。
    await exec('window.__cwTest.setTestOpenBookDelay(0)').catch(() => {});
    await exec('window.__cwTest.setTestLoadChapterDelay(0)').catch(() => {});
    await exec('window.__cwTest.setTestSaveDelay(0)').catch(() => {});
    if (!cleaned) await cleanup();
  }
};