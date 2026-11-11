// E2E 第 74 组：撤销优先——删除章节直接执行 + 10 秒撤销（1.4.0 P0-2a）。
//
// 钉住的事：
//   ① 删除不再弹「删除章节」确认框（#modal-backdrop 一直 hidden），章节立刻从列表消失；
//   ② 撤销条出现、文案说明删了哪一章；点「撤销」→ 章节文件与书目原位置一起回来；
//   ③ 编辑器里按 Ctrl+Z 仍是文本撤销（不抢全局撤销）；焦点不在编辑区时 Ctrl+Z 才执行撤销；
//   ④ 删「当前脏章」仍先走未保存拦截（两处保留确认之一），放弃修改后删除，撤销找得回磁盘那一版；
//   ⑤ 删空自动补的空章：撤销后书里只剩原章、没有多余空章；
//   ⑥ 回书架收起撤销条（10 秒窗口不跨书 / 不跨视图）。
//
// 自足：自己造一本 3 章的演练书、自己收尾删掉（走书架 _trash），不污染其它组。
const fs = require('node:fs/promises');
const path = require('node:path');

const JS_UNDO = `(() => {
  const bar = document.getElementById('undo-bar');
  return JSON.stringify({
    visible: !bar.classList.contains('hidden'),
    label: document.getElementById('undo-label').textContent,
    modal: !document.getElementById('modal-backdrop').classList.contains('hidden'),
    titles: window.__cwTest.chapterTitles(),
    dirty: window.__cwTest.dirty()
  });
})()`;

const readUndo = async (exec) => JSON.parse(await exec(JS_UNDO));

// Ctrl+Z：真实 keydown 派发到 document，走的是 renderer.js 的全局 keydown 同一段判定
const pressCtrlZ = (exec) =>
  exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))");

module.exports = async function group74Undo(t) {
  const { exec, check, waitFor, sleep, waitForRender, storage, booksRoot, deleteBookWithRetry } = t;

  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const shelfBefore = (await storage.listBooks(booksRoot)).length;

  // ---------- 造演练书：3 章，正文各不相同 ----------
  const created = await storage.createBook(booksRoot, '撤销删除演练');
  const bookPath = created.path;
  await storage.createChapter(bookPath, 1, '第二章');
  await storage.createChapter(bookPath, 2, '第三章');
  const meta0 = await storage.readBookMeta(bookPath);
  const [file0, file1, file2] = meta0.chapters.map((chapter) => chapter.file);
  await storage.saveChapterText(bookPath, file0, '第一章的正文');
  await storage.saveChapterText(bookPath, file1, '第二章的正文');
  await storage.saveChapterText(bookPath, file2, '第三章的正文');
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookPath)})`);
  await waitFor('window.__cwTest.view() === "editor"');
  await waitFor('window.__cwTest.chapterTitles().length === 3');

  // ---------- ① 删非当前章：不再弹确认框，章节立刻消失 ----------
  await exec('window.__cwTest.deleteChapterAt(1)');
  await waitFor('window.__cwTest.chapterTitles().length === 2', 8000);
  const afterDelete = await readUndo(exec);
  check(
    '撤销删除：删章不再弹「删除章节」确认框（弹层仍是关着的）',
    afterDelete.modal === false,
    afterDelete
  );
  check(
    '撤销删除：删完立刻出现撤销条并写明删了哪一章',
    afterDelete.visible === true && afterDelete.label.includes('已删除') && afterDelete.label.includes('第二章'),
    afterDelete.label
  );
  const metaDeleted = await storage.readBookMeta(bookPath);
  check(
    '撤销删除：书目里少了一章，文件真的进了 _trash',
    metaDeleted.chapters.length === 2 &&
      !metaDeleted.chapters.some((chapter) => chapter.file === file1) &&
      (await fs.readdir(path.join(bookPath, '_trash'))).some((name) => name.endsWith(file1)),
    metaDeleted.chapters.map((chapter) => chapter.file)
  );

  // ---------- ② 编辑器内 Ctrl+Z 不抢（有撤销条时也一样） ----------
  await exec("document.getElementById('editor').focus()");
  await pressCtrlZ(exec);
  await sleep(250);
  const editorCtrlZ = await readUndo(exec);
  check(
    '撤销删除：焦点在编辑区时 Ctrl+Z 仍是文本撤销（章节数不变、撤销条还留着）',
    editorCtrlZ.titles.length === 2 && editorCtrlZ.visible === true,
    { titles: editorCtrlZ.titles, visible: editorCtrlZ.visible }
  );

  // ---------- ③ 焦点离开编辑区：Ctrl+Z 执行撤销，章节回原位 ----------
  await exec('document.activeElement && document.activeElement.blur()');
  await pressCtrlZ(exec);
  await waitFor('window.__cwTest.chapterTitles().length === 3', 8000);
  const afterUndo = await readUndo(exec);
  const metaRestored = await storage.readBookMeta(bookPath);
  check(
    '撤销删除：Ctrl+Z 后章节按原位置回来（顺序 / 正文一致），撤销条收起',
    afterUndo.titles.length === 3 &&
      afterUndo.visible === false &&
      JSON.stringify(metaRestored.chapters.map((chapter) => chapter.file)) ===
        JSON.stringify([file0, file1, file2]) &&
      (await storage.loadChapterText(bookPath, file1)).text === '第二章的正文',
    { titles: afterUndo.titles, files: metaRestored.chapters.map((chapter) => chapter.file) }
  );

  // ---------- ④ 删当前脏章：先走未保存拦截；放弃修改后删除，撤销找得回磁盘那一版 ----------
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await exec("window.__cwTest.setText('编辑区里还没保存的改动')");
  check('撤销删除：当前章改字后是未保存状态', (await exec('window.__cwTest.dirty()')) === true);
  await exec('window.__cwTest.clearToasts()');
  const deleting = exec('window.__cwTest.deleteChapterAt(0)');
  await waitFor('window.__cwTest.modalOpen() === true', 4000);
  check(
    '撤销删除：删「当前脏章」仍先问未保存的修改（保留的两处确认之一）',
    (await exec('window.__cwTest.dialog()')) === '删除前先处理未保存的修改',
    await exec('window.__cwTest.dialog()')
  );
  await exec("window.__cwTest.answerModal('discard')");
  await deleting;
  await waitFor('window.__cwTest.chapterTitles().length === 2', 8000);
  const dirtyDeleted = await readUndo(exec);
  check(
    '撤销删除：放弃修改后直接删除（没有第二个「删除章节」确认框），撤销条可见',
    dirtyDeleted.modal === false && dirtyDeleted.visible === true,
    dirtyDeleted
  );

  // ---------- ⑤ 点撤销条：正文回到磁盘上那一版，不回到没保存的那一版 ----------
  await exec("document.getElementById('btn-undo').click()");
  await waitFor('window.__cwTest.chapterTitles().length === 3', 8000);
  await waitFor(`window.__cwTest.text() === '第一章的正文'`, 8000).catch(() => false);
  check(
    '撤销删除：点撤销条后正文是磁盘上那一版（未保存的改动本来就没进 _trash）',
    (await exec('window.__cwTest.text()')) === '第一章的正文',
    await exec('window.__cwTest.text()')
  );
  await waitFor('window.__cwTest.dirty() === false', 4000).catch(() => false);

  // ---------- ⑤b 连删两章：两次撤销各自回原处（1.5.0 P0-4 / H-1：撤销改小栈，不再单槽） ----------
  // 此刻书里是 3 章（上一段撤销把第一章放回来了）、撤销栈是空的。
  await exec('window.__cwTest.deleteChapterAt(2)');
  await waitFor('window.__cwTest.chapterTitles().length === 2', 8000);
  await exec('window.__cwTest.deleteChapterAt(1)');
  await waitFor('window.__cwTest.chapterTitles().length === 1', 8000);
  const twoDeleted = await readUndo(exec);
  check(
    '撤销删除：连删两章后条子显示最新那一条，更早的一条还在栈里',
    twoDeleted.visible === true && twoDeleted.label.includes('第二章'),
    twoDeleted.label
  );
  await exec("document.getElementById('btn-undo').click()");
  // 撤销是异步的：等它真落地（章节数回到 2）。**不能**等「条子收起」——栈里还有一条，条子会换成它。
  await waitFor('window.__cwTest.chapterTitles().length === 2', 8000);
  const midUndo = await readUndo(exec);
  const metaAfterFirstUndo = await storage.readBookMeta(bookPath);
  check(
    '撤销删除：第一次撤销把第二章放回原位，条子换成更早那条（第三章）',
    JSON.stringify(metaAfterFirstUndo.chapters.map((chapter) => chapter.file)) === JSON.stringify([file0, file1]) &&
      midUndo.visible === true &&
      midUndo.label.includes('第三章'),
    { files: metaAfterFirstUndo.chapters.map((chapter) => chapter.file), label: midUndo.label, visible: midUndo.visible }
  );
  await exec('document.activeElement && document.activeElement.blur()');
  await pressCtrlZ(exec);
  await waitFor('window.__cwTest.chapterTitles().length === 3', 8000);
  const afterSecondUndo = await readUndo(exec);
  const metaAfterSecondUndo = await storage.readBookMeta(bookPath);
  check(
    '撤销删除：第二次撤销把第三章也放回原位，三章顺序与正文都还原、条子收起',
    JSON.stringify(metaAfterSecondUndo.chapters.map((chapter) => chapter.file)) ===
      JSON.stringify([file0, file1, file2]) &&
      afterSecondUndo.visible === false &&
      (await storage.loadChapterText(bookPath, file2)).text === '第三章的正文',
    { files: metaAfterSecondUndo.chapters.map((chapter) => chapter.file), visible: afterSecondUndo.visible }
  );

  // ---------- ⑥ 删到只剩一章，再删空：自动补的空章撤销后不留下 ----------
  await exec('window.__cwTest.deleteChapterAt(2)');
  await waitFor('window.__cwTest.chapterTitles().length === 2', 8000);
  await exec('window.__cwTest.deleteChapterAt(1)');
  await waitFor('window.__cwTest.chapterTitles().length === 1', 8000);
  await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false', 4000).catch(() => false);
  await exec('window.__cwTest.deleteChapterAt(0)');
  await waitFor('window.__cwTest.chapterTitles().length === 1', 8000);
  const autoMeta = await storage.readBookMeta(bookPath);
  check(
    '撤销删除：删唯一一章会自动补一个空章（撤销前书里仍有一章）',
    autoMeta.chapters.length === 1 && autoMeta.chapters[0].file !== file0,
    autoMeta.chapters.map((chapter) => chapter.file)
  );
  const autoBar = await readUndo(exec);
  check('撤销删除：删唯一一章后撤销条可见', autoBar.visible === true, autoBar);
  await exec("document.getElementById('btn-undo').click()");
  // 撤销是异步的（点一下只发起 IPC），必须等它真落地再读书目。
  // 这里**不能**像以前那样等 dirty === false 当信号：删完本来就不脏，那个条件立刻成立，等于没等，
  // 读到的是撤销前的书目（2026-11-09 首跑就是这样误判成产品缺陷的）。
  // 1.5.0 P0-4 起撤销是小栈：撤销这一条后条子会换成更早那条（第二章 / 第三章），**不能再等 hidden**；
  // 改成轮询书目，直到书里真的只剩「第一章」。
  for (let i = 0; i < 80; i += 1) {
    const metaNow = await storage.readBookMeta(bookPath);
    if (metaNow.chapters.length === 1 && metaNow.chapters[0].file === file0) break;
    await sleep(100);
  }
  const afterAutoUndo = await storage.readBookMeta(bookPath);
  const txtFiles = (await fs.readdir(bookPath)).filter((name) => name.endsWith('.txt'));
  check(
    '撤销删除：删空自动补的章被一并撤掉（书里只剩原章、没有多余空章）',
    afterAutoUndo.chapters.length === 1 &&
      afterAutoUndo.chapters[0].file === file0 &&
      JSON.stringify(txtFiles) === JSON.stringify([file0]) &&
      (await storage.loadChapterText(bookPath, file0)).text === '第一章的正文',
    { chapters: afterAutoUndo.chapters.map((chapter) => chapter.file), txtFiles }
  );

  // ---------- ⑥b 手动关闭：× 与 Esc（1.5.0 P0-4 / H-5；Esc 只在没有弹层开着时生效） ----------
  // 上一段的撤销把小栈换成了更早的第二章 / 第三章，这里再删一次当前这章，栈里就是三条。
  await exec("document.getElementById('editor').focus()");
  await exec('window.__cwTest.deleteChapterAt(0)');
  await waitFor('window.__cwTest.chapterTitles().length === 1', 8000);
  const closeBar = await readUndo(exec);
  check(
    '撤销删除：手动关闭前撤销条可见',
    closeBar.visible === true && closeBar.modal === false,
    closeBar
  );
  await exec("document.getElementById('btn-undo-close').focus()");
  await exec("document.getElementById('btn-undo-close').click()");
  await sleep(200);
  const afterClose = JSON.parse(
    await exec(
      "JSON.stringify({ visible: !document.getElementById('undo-bar').classList.contains('hidden'), focus: document.activeElement ? document.activeElement.id : '', label: document.getElementById('undo-label').textContent })"
    )
  );
  check(
    '撤销删除：× 关闭后条子消失、焦点回编辑区',
    afterClose.visible === false && afterClose.focus === 'editor' && afterClose.label === '',
    afterClose
  );

  // Esc：没有弹层时也能关（esc-registry 的 undo-bar 层排在兜底之前、所有弹层之后）
  await exec("document.getElementById('editor').focus()");
  await exec('window.__cwTest.deleteChapterAt(0)');
  await waitFor('window.__cwTest.chapterTitles().length === 1', 8000);
  await waitForRender();
  const escBar = await readUndo(exec);
  check('撤销删除：Esc 关条子之前条子是可见的', escBar.visible === true, escBar.visible);
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await sleep(200);
  const afterEsc = JSON.parse(
    await exec(
      "JSON.stringify({ visible: !document.getElementById('undo-bar').classList.contains('hidden'), focus: document.activeElement ? document.activeElement.id : '' })"
    )
  );
  check(
    '撤销删除：没有弹层时 Esc 也能关掉撤销条（焦点回编辑区）',
    afterEsc.visible === false && afterEsc.focus === 'editor',
    afterEsc
  );

  // ---------- ⑦ 回书架收起撤销条：10 秒窗口不跨书 ----------
  await exec('window.__cwTest.deleteChapterAt(0)');
  await waitFor('window.__cwTest.chapterTitles().length === 1', 8000);
  const beforeShelf = await readUndo(exec);
  check('撤销删除：回书架前撤销条是可见的', beforeShelf.visible === true, beforeShelf.visible);
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await waitForRender();
  const atShelf = JSON.parse(
    await exec("JSON.stringify({ visible: !document.getElementById('undo-bar').classList.contains('hidden') })")
  );
  check('撤销删除：回书架后撤销条收起（撤销不会跨书执行）', atShelf.visible === false, atShelf);

  // ---------- 收尾：删掉演练书（书架 _trash），书架数量复原 ----------
  const removed = await deleteBookWithRetry(bookPath);
  check(
    '撤销删除：演练书已移入书架 _trash（没有真删）',
    Boolean(removed && removed.ok === true) && removed.data.method === 'move',
    removed
  );
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  check(
    '撤销删除：演练结束后书架数量回到演练前（没污染其它组）',
    (await storage.listBooks(booksRoot)).length === shelfBefore,
    (await storage.listBooks(booksRoot)).length
  );
};
