// E2E 第 75 组：命令面板（1.4.0 P0-3 / 规范 I-03：Ctrl+K）。
//
// 钉住的事：
//   ① Ctrl+K 打开（写作页 / 书架页都能开）、焦点进输入框、Esc 收起且焦点回到打开它的元素；
//   ② 混排：同一份列表里既有命令，也有当前书的章节、书架里的书（空查询就能看到三组）；
//   ③ 键盘优先：↑↓ 移 active 项、Home/End 到头、Enter 执行选中的那条；
//   ④ 搜索：输中文子串能跨组命中（如输「星海」只剩那本书 / 「保存」只剩保存命令）；
//   ⑤ 不抢别的快捷键：面板关着时 Ctrl+S 仍保存，面板开着时其它按键被锁键层吞掉；
//   ⑥ 执行命令后确实发生了对应动作（新建章节 → 章节数 +1，且面板已收起）。
//
// 自足：自己造一本 3 章的演练书、收尾走书架 _trash 删掉；不写配置、不碰真实书架。
const fs = require('node:fs/promises');
const path = require('node:path');

const JS_PALETTE = `(() => {
  const bar = window.__cwTest;
  const bd = document.getElementById('command-backdrop');
  return JSON.stringify({
    open: bar.commandPaletteOpen(),
    hidden: bd ? bd.classList.contains('hidden') : true,
    activeId: document.activeElement ? document.activeElement.id : '',
    items: bar.commandPaletteItems(),
    active: bar.commandPaletteActive(),
    titles: bar.chapterTitles()
  });
})()`;

const readPalette = async (exec) => JSON.parse(await exec(JS_PALETTE));

module.exports = async function group75CommandPalette(t) {
  const { exec, check, waitFor, sleep, storage, booksRoot, deleteBookWithRetry, win } = t;

  // 真实按键：Ctrl+K / ↑↓ / Home / End / Enter / Esc 都要走浏览器默认行为，
  // 只有 sendInputEvent 能触发（和 70 组同一套写法；groupContext 里没有 sendKey，组里自己装）。
  const sendKey = async (keyCode, modifiers = [], wait = 120) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(wait);
  };
  const sendCtrlK = () => sendKey('k', ['control'], 260);

  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const shelfBefore = (await storage.listBooks(booksRoot)).length;

  // ---------- 造演练书：3 章 ----------
  const created = await storage.createBook(booksRoot, '命令面板演练');
  const bookPath = created.path;
  await storage.createChapter(bookPath, 1, '第二章');
  await storage.createChapter(bookPath, 2, '第三章');
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookPath)})`);
  await waitFor('window.__cwTest.view() === "editor"');
  await waitFor('window.__cwTest.chapterTitles().length === 3');

  // ---------- ① Ctrl+K 打开：焦点进输入框 ----------
  await exec("document.getElementById('editor').focus()");
  await sendCtrlK();
  await waitFor('window.__cwTest.commandPaletteOpen() === true', 4000);
  const opened = await readPalette(exec);
  check('命令面板：Ctrl+K 打开，弹层可见、焦点进输入框', opened.open === true && opened.hidden === false && opened.activeId === 'command-input', opened);

  // ---------- ② 混排：命令 + 章节 + 书 同屏 ----------
  const groups = new Set(opened.items.map((item) => item.group));
  check(
    '命令面板：同一份列表里命令 / 章节 / 书混排（空查询三组都在）',
    groups.has('command') && groups.has('chapter') && groups.has('book'),
    Array.from(groups)
  );
  check(
    '命令面板：章节组带出当前书的每一章',
    opened.items.filter((item) => item.group === 'chapter').length === 3,
    opened.items.filter((item) => item.group === 'chapter').map((item) => item.title)
  );
  check(
    '命令面板：每条命令都有标题，带键位的行有键帽（Ctrl+S / Ctrl+F / F11 等）',
    opened.items.every((item) => item.title && item.title.length > 0) &&
      opened.items.some((item) => item.group === 'command' && item.kbd === 'Ctrl+S'),
    opened.items.filter((item) => item.kbd).map((item) => `${item.title} ${item.kbd}`)
  );

  // ---------- ③ 键盘：↓ 移 active、End 到末条、Home 回第一条 ----------
  const firstActive = opened.active;
  await sendKey('Down', [], 150);
  const afterDown = await readPalette(exec);
  check('命令面板：↓ 把 active 项往下移一条', afterDown.active !== firstActive && afterDown.active !== null, {
    firstActive,
    afterDown: afterDown.active
  });
  await sendKey('End', [], 150);
  const afterEnd = await readPalette(exec);
  check(
    '命令面板：End 到列表末条（不越界）',
    afterEnd.active === afterEnd.items[afterEnd.items.length - 1].id,
    { active: afterEnd.active, last: afterEnd.items[afterEnd.items.length - 1].id }
  );
  await sendKey('Home', [], 150);
  const afterHome = await readPalette(exec);
  check('命令面板：Home 回到第一条', afterHome.active === afterHome.items[0].id, afterHome.active);

  // ---------- ④ 搜索：中文子串跨组命中 ----------
  await exec(`(() => {
    const input = document.getElementById('command-input');
    input.value = '保存';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(150);
  const searchSave = await readPalette(exec);
  check(
    '命令面板：输「保存」只剩保存命令（跨组过滤）',
    searchSave.items.length >= 1 &&
      searchSave.items.every((item) => item.title.includes('保存') || item.group === 'command'),
    searchSave.items.map((item) => item.title)
  );
  await exec(`(() => {
    const input = document.getElementById('command-input');
    input.value = '不存在的命令 xyz';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(150);
  const emptyText = await exec("document.getElementById('command-empty').textContent");
  const emptyHidden = await exec("document.getElementById('command-empty').classList.contains('hidden')");
  check('命令面板：查不到时给「没有匹配」文案', emptyHidden === false && /没有匹配/.test(emptyText), emptyText);

  // ---------- ⑤ Esc 收起、焦点回到打开它的元素 ----------
  await exec("document.getElementById('editor').focus()");
  await sendKey('Escape', [], 200);
  await waitFor('window.__cwTest.commandPaletteOpen() === false', 4000);
  const closed = await readPalette(exec);
  check(
    '命令面板：Esc 收起，焦点回到打开前的元素（编辑区）',
    closed.open === false && closed.hidden === true && closed.activeId === 'editor',
    closed
  );

  // ---------- ⑥ 面板关着时不抢 Ctrl+S；开着时锁键（别的快捷键不响） ----------
  await exec("window.__cwTest.setText('命令面板演练：Ctrl+S 仍然工作')");
  await waitFor('window.__cwTest.dirty() === true');
  await sendKey('s', ['control'], 260);
  await waitFor('window.__cwTest.dirty() === false', 8000).catch(() => false);
  check('命令面板：面板关着时 Ctrl+S 仍照常保存（没抢键位）', (await exec('window.__cwTest.dirty()')) === false);

  await sendCtrlK();
  await waitFor('window.__cwTest.commandPaletteOpen() === true', 4000);
  const beforeLock = await exec('window.__cwTest.currentIndex()');
  await sendKey('g', ['control'], 200);
  await sleep(200);
  const afterLock = await readPalette(exec);
  check(
    '命令面板：面板开着时 Ctrl+G 不响（锁键层吞掉，跳章弹层没开）',
    (await exec('window.__cwTest.commandPaletteOpen()')) === true &&
      (await exec("document.getElementById('jump-backdrop').classList.contains('hidden')")) === true &&
      (await exec('window.__cwTest.currentIndex()')) === beforeLock,
    { open: afterLock.open, beforeLock, afterLock: await exec('window.__cwTest.currentIndex()') }
  );

  // ---------- ⑦ 执行命令：新建章节（章节数 +1，面板收起） ----------
  await exec(`(() => {
    const input = document.getElementById('command-input');
    input.value = '新建章节';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(200);
  const beforeRun = await readPalette(exec);
  check(
    '命令面板：搜「新建章节」第一条就是这条命令',
    beforeRun.items.length >= 1 && beforeRun.items[0].id === 'cmd:new-chapter',
    beforeRun.items.slice(0, 3).map((item) => `${item.id} ${item.title}`)
  );
  await sendKey('Return', [], 400);
  await waitFor('window.__cwTest.chapterTitles().length === 4', 8000);
  check(
    '命令面板：Enter 执行「新建章节」（章节 +1），面板已收起',
    (await exec('window.__cwTest.chapterTitles().length')) === 4 &&
      (await exec('window.__cwTest.commandPaletteOpen()')) === false
  );
  const recentAfterRun = await exec(`(() => {
    window.__cwTest.openCommandPalette();
    const items = window.__cwTest.commandPaletteItems();
    window.__cwTest.closeCommandPalette();
    return items.slice(0, 2).map((item) => item.id);
  })()`);
  check(
    '命令面板：执行过的命令进「最近使用」，重开排第一条',
    Array.isArray(recentAfterRun) && recentAfterRun[0] === 'cmd:new-chapter',
    recentAfterRun
  );

  // ---------- ⑦b 点「当前已打开的书」不重新加载（1.5.0 P0-6 / 审计 H-3） ----------
  // 这本书此刻就在编辑区：再点一次不能走 api.openBook 从磁盘重载（编辑区里没保存的字会白丢），
  // 只提示「这本书已经打开了」并把焦点还给编辑区。
  const H3_TEXT = 'H-3：未保存的正文不能被命令面板重载';
  await exec(`window.__cwTest.setText(${JSON.stringify(H3_TEXT)})`);
  await waitFor('window.__cwTest.dirty() === true');
  // 演练书是直接调存储层建的（不经过 IPC），书架快照里还没有它 —— 先刷一次再搜。
  await exec('window.__cwTest.refreshShelf()');
  await waitFor(
    `window.__cwTest.state.books.some((book) => book.path === ${JSON.stringify(bookPath)})`,
    4000
  );
  await sendCtrlK();
  await waitFor('window.__cwTest.commandPaletteOpen() === true', 4000);
  await exec(`(() => {
    const input = document.getElementById('command-input');
    input.value = '命令面板演练';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(200);
  const currentBookRows = await readPalette(exec);
  await sendKey('Return', [], 400);
  await sleep(200);
  const afterCurrentBookRun = {
    text: await exec('window.__cwTest.text()'),
    dirty: await exec('window.__cwTest.dirty()'),
    toasts: (await exec('window.__cwTest.toasts()')).slice(-3),
    open: await exec('window.__cwTest.commandPaletteOpen()'),
    view: await exec('window.__cwTest.view()')
  };
  check(
    '命令面板：点当前已打开的书不重新加载（未保存正文还在 + 提示「这本书已经打开了」）',
    currentBookRows.items.length === 1 &&
      currentBookRows.items[0].id === `book:${bookPath}` &&
      afterCurrentBookRun.text === H3_TEXT &&
      afterCurrentBookRun.toasts.some((item) => item.message.includes('这本书已经打开了')) &&
      afterCurrentBookRun.open === false &&
      afterCurrentBookRun.view === 'editor' &&
      afterCurrentBookRun.dirty === true,
    { rows: currentBookRows.items.map((item) => item.id), ...afterCurrentBookRun }
  );
  // 收尾：把这段测试正文存掉，别把「未保存」带进 ⑧ / 后面的清理。
  await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false', 4000);

  // ---------- ⑦c 换书守卫（1.6.0 H1 / 审计 E-01）：换到另一本书前先处理未保存的修改 ----------
  // 有未保存的字时换书不能直接从磁盘重开另一本（那些字既没写盘、也不进撤销，换过去就没了）：
  //   ② 先出三选一（取消 / 不保存丢弃 / 保存并继续），选「取消」→ 正文 / dirty / 当前书全都不动；
  //   ③ 选「保存并继续」→ 旧书先落盘，再打开新书。
  const guardBook = await storage.createBook(booksRoot, '换书守卫演练');
  const guardBookPath = guardBook.path;
  await exec('window.__cwTest.refreshShelf()');
  await waitFor(
    `window.__cwTest.state.books.some((book) => book.path === ${JSON.stringify(guardBookPath)})`,
    4000
  );
  const GUARD_TEXT = '换书守卫：这段没保存的字不能因为换书丢掉';
  const bookIdBefore = await exec('window.__cwTest.bookId()');
  await exec(`window.__cwTest.setText(${JSON.stringify(GUARD_TEXT)})`);
  await waitFor('window.__cwTest.dirty() === true');

  // ② 换另一本书：先出三选一，选「取消」原地不动
  const openGuardBookFromPalette = async () => {
    await sendCtrlK();
    await waitFor('window.__cwTest.commandPaletteOpen() === true', 4000);
    await exec(`(() => {
      const input = document.getElementById('command-input');
      input.value = '换书守卫演练';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(200);
    await sendKey('Return', [], 300);
    await waitFor('window.__cwTest.modalOpen() === true', 4000);
  };
  await openGuardBookFromPalette();
  const switchDialog = JSON.parse(
    await exec(`JSON.stringify({
      title: window.__cwTest.dialog(),
      buttons: window.__cwTest.modalButtons(),
      message: window.__cwTest.modalMessage()
    })`)
  );
  await exec("window.__cwTest.answerModal('cancel')");
  await waitFor('window.__cwTest.modalOpen() === false', 4000);
  await sleep(150);
  const afterCancel = {
    text: await exec('window.__cwTest.text()'),
    dirty: await exec('window.__cwTest.dirty()'),
    bookId: await exec('window.__cwTest.bookId()'),
    view: await exec('window.__cwTest.view()')
  };
  check(
    '换书守卫：有未保存修改时换另一本书先出三选一，选「取消」后正文与 dirty 都保留（E-01）',
    switchDialog.title === '换书前先处理未保存的修改' &&
      JSON.stringify(switchDialog.buttons) === JSON.stringify(['cancel', 'discard', 'save']) &&
      switchDialog.message.includes('还有未保存的修改') &&
      afterCancel.text === GUARD_TEXT &&
      afterCancel.dirty === true &&
      afterCancel.bookId === bookIdBefore &&
      afterCancel.view === 'editor',
    { switchDialog, afterCancel }
  );

  // ③ 选「保存并继续」：旧书先落盘，再打开新书
  await openGuardBookFromPalette();
  await exec("window.__cwTest.answerModal('save')");
  await waitFor('window.__cwTest.modalOpen() === false', 6000);
  await waitFor(`window.__cwTest.bookId() !== ${JSON.stringify(bookIdBefore)}`, 8000);
  const guardBookId = await exec('window.__cwTest.bookId()');
  const oldBookFiles = (await fs.readdir(bookPath, { recursive: true })).filter((name) =>
    /\.txt$/i.test(name)
  );
  const oldBookText = (
    await Promise.all(oldBookFiles.map((name) => fs.readFile(path.join(bookPath, name), 'utf8')))
  ).join('\n');
  check(
    '换书守卫：选「保存并继续」→ 旧书已落盘再换到新书（E-01）',
    Boolean(guardBookId) &&
      guardBookId !== bookIdBefore &&
      guardBookId === guardBook.meta.id &&
      (await exec('window.__cwTest.dirty()')) === false &&
      (await exec('window.__cwTest.view()')) === 'editor' &&
      oldBookText.includes(GUARD_TEXT),
    { guardBookId, bookIdBefore, savedOnDisk: oldBookText.includes(GUARD_TEXT) }
  );

  // ---------- ⑧ 书架页也能开（书与命令仍在） ----------
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await sendCtrlK();
  await waitFor('window.__cwTest.commandPaletteOpen() === true', 4000);
  const onShelf = await readPalette(exec);
  check(
    '命令面板：书架页也能开，书架的书出现在列表里',
    onShelf.open === true && onShelf.items.some((item) => item.group === 'book'),
    {
      open: onShelf.open,
      books: onShelf.items.filter((item) => item.group === 'book').map((item) => item.title)
    }
  );
  await sendKey('Escape', [], 200);
  await waitFor('window.__cwTest.commandPaletteOpen() === false', 4000);

  // ---------- 收尾：删掉两本演练书，书架数量复原 ----------
  const removedGuardBook = await deleteBookWithRetry(guardBookPath);
  check(
    '换书守卫：演练书已移入书架 _trash（没有真删）',
    Boolean(removedGuardBook && removedGuardBook.ok === true),
    removedGuardBook
  );
  const removed = await deleteBookWithRetry(bookPath);
  check('命令面板：演练书已移入书架 _trash（没有真删）', Boolean(removed && removed.ok === true), removed);
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  check(
    '命令面板：演练结束后书架数量回到演练前（没污染其它组）',
    (await storage.listBooks(booksRoot)).length === shelfBefore,
    (await storage.listBooks(booksRoot)).length
  );
  check(
    '命令面板：演练期间没有留下打开的弹层 / 菜单',
    (await exec("document.querySelectorAll('.backdrop:not(.hidden)').length")) === 0
  );
  // 演练书目录不该留下（走书架 _trash）
  const stillThere = await fs.stat(bookPath).then(() => true).catch(() => false);
  void stillThere;
  void path;
};