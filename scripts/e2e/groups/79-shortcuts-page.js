// E2E 第 79 组：`?` 快捷键一览页（1.5.0 功能-4）。
//
// 钉住的事：
//   ① 写作页按 `?` 打开：弹层可见、焦点进弹层、列表由命令表里**带键位的命令**生成（与命令面板同一份数据）；
//   ② 打开的那一下不往正文里插字符（keydown 被 preventDefault）；
//   ③ Esc 关闭、焦点回到打开前的元素（编辑区）；
//   ④ 焦点在编辑区时 `?` 仍是普通字符（正文里真的多一个 `?`，面板不打开）；
//   ⑤ 命令面板开着时 `?` 不抢（命令面板仍是唯一弹层，Esc 照常收它）；
//   ⑥ 书架页也能打开（列表不按当前视图过滤，不会是一张空表）；
//   ⑦ 只读：打开 / 关闭 / 列表渲染都不写章节 txt、不改 mtime、不改书目。
//
// 自足：自己造一本 1 章的书、收尾走书架 _trash 删掉；不写配置、不碰真实书架。
//
// 关于 `?` 的按键：真实键盘事件用 win.webContents.sendInputEvent 发 keyDown / char / keyUp
// （2026-11-11 探针实测：keyCode:'?' 会产生 key='?' / code='Slash' 的 keydown；只有单独发
// char 才会真的落字；keydown 被 preventDefault 时 char 不落 —— 正好用来钉「打开时不插字」）。
const fs = require('node:fs/promises');
const path = require('node:path');

const JS_SHORTCUTS = `(() => {
  const bd = document.getElementById('shortcuts-backdrop');
  const list = document.getElementById('shortcuts-list');
  const rows = list ? Array.from(list.querySelectorAll('.shortcut-row')) : [];
  return JSON.stringify({
    hidden: bd ? bd.classList.contains('hidden') : true,
    title: document.getElementById('shortcuts-title') ? document.getElementById('shortcuts-title').textContent : '',
    rows: rows.map((row) => ({
      title: row.querySelector('.shortcut-title') ? row.querySelector('.shortcut-title').textContent : '',
      kbd: row.querySelector('.shortcut-kbd') ? row.querySelector('.shortcut-kbd').textContent : '',
      scope: row.querySelector('.shortcut-scope') ? row.querySelector('.shortcut-scope').textContent : ''
    })),
    groups: list ? Array.from(list.querySelectorAll('.shortcut-group')).map((el) => el.textContent) : [],
    activeId: document.activeElement ? document.activeElement.id : '',
    editor: document.getElementById('editor') ? document.getElementById('editor').value : ''
  });
})()`;

module.exports = async function group79ShortcutsPage(t) {
  const { exec, check, waitFor, sleep, storage, booksRoot, deleteBookWithRetry, win } = t;

  // 真实按键：`?` 要带字符事件，Ctrl+K / Esc 走 keyDown+keyUp 即可（与第 75 组同一套写法）。
  const sendKey = async (keyCode, modifiers = [], wait = 120) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(wait);
  };
  const sendQuestion = async (wait = 260) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '?' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: '?' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: '?' });
    await sleep(wait);
  };
  const readPanel = async () => JSON.parse(await exec(JS_SHORTCUTS));

  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");

  // ---------- 造演练书：1 章，带一段可辨认的正文 ----------
  const created = await storage.createBook(booksRoot, '快捷键一览演练');
  const bookPath = created.path;
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookPath)})`);
  await waitFor('window.__cwTest.view() === "editor"');
  const body = '快捷键演练正文。';
  await exec(`window.__cwTest.setText(${JSON.stringify(body)})`);
  await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false');
  const meta0 = await storage.readBookMeta(bookPath);
  const chapterFile = meta0.chapters[0].file;
  const chapterPath = path.join(bookPath, chapterFile);
  const stat0 = await fs.stat(chapterPath);
  const metaChapters0 = JSON.stringify(meta0.chapters);

  // ---------- ① 打开：列表与命令面板的键位条目一一对应 ----------
  // 先把焦点从编辑区移开：编辑区（textarea）里 `?` 必须打字符（见 ④），一览页只在
  // 焦点不在输入类目标上时才接这个键 —— 作者口径，避免写作时被抢。
  // 先把命令面板里带 kbd 的条目记下来（同一份 commandDefs 的另一个出口），关掉面板再打开一览页。
  await exec("document.getElementById('editor').focus()");
  await exec('window.__cwTest.openCommandPalette()');
  await waitFor('window.__cwTest.commandPaletteOpen() === true', 4000);
  const paletteKbd = JSON.parse(
    await exec('JSON.stringify(window.__cwTest.commandPaletteItems().filter((item) => item.kbd).map((item) => ({ title: item.title, kbd: item.kbd })))')
  );
  await exec('window.__cwTest.closeCommandPalette()');
  await waitFor('window.__cwTest.commandPaletteOpen() === false', 4000);
  await exec("document.getElementById('editor').blur()");
  await waitFor("document.activeElement === document.body", 4000);

  const editorBefore = await exec("document.getElementById('editor').value");
  await sendQuestion();
  await waitFor("document.getElementById('shortcuts-backdrop').classList.contains('hidden') === false", 4000);
  const opened = await readPanel();
  const commandRows = opened.rows.filter((row) => !row.scope);
  const systemRows = opened.rows.filter((row) => row.scope);
  check(
    '快捷键一览：焦点不在编辑区时按 ? 打开，弹层可见、焦点进弹层（右上 ×）',
    opened.hidden === false && opened.title === '快捷键一览' && opened.activeId === 'btn-shortcuts-close',
    { hidden: opened.hidden, title: opened.title, activeId: opened.activeId }
  );
  check(
    '快捷键一览：列表由命令表里带键位的命令生成（与命令面板同一组条目、有分组标签）',
    paletteKbd.length > 0 &&
      commandRows.length === paletteKbd.length &&
      // 顺序不比：命令面板空查询按「组权重 → 标题」排，一览页按命令表声明顺序排（同一组数据两种排列）
      commandRows.map((row) => `${row.title}\u0000${row.kbd}`).sort().join('|') ===
        paletteKbd.map((row) => `${row.title}\u0000${row.kbd}`).sort().join('|') &&
      opened.groups.includes('命令') &&
      opened.groups.includes('系统键') &&
      paletteKbd.length === 8 &&
      commandRows.every((row) => row.title && row.kbd),
    { commandRows, paletteKbd, groups: opened.groups, systemRows: systemRows.length }
  );
  // 1.6.0 F4a：系统键（不在命令表里的快捷键）也要能在 `?` 页查到 —— 以前只列命令表的 8 条，
  // Ctrl+K / Ctrl+Z 这些「入口键」反而看不到。
  check(
    '快捷键一览：系统键组含 Ctrl+K / Ctrl+Z（不在命令表里的入口键也能查到）',
    systemRows.some((row) => row.kbd === 'Ctrl+K') &&
      systemRows.some((row) => row.kbd === 'Ctrl+Z') &&
      systemRows.length >= 8,
    { systemRows }
  );
  check(
    '快捷键一览：系统键每行都写清「生效范围」（命令组不画空气）',
    systemRows.every((row) => row.title && row.kbd && row.scope) &&
      commandRows.every((row) => row.scope === ''),
    { systemRows: systemRows.map((row) => `${row.kbd} → ${row.scope}`) }
  );

  // ---------- ② 打开的那一下不往正文里插字符 ----------
  check(
    '快捷键一览：按 ? 打开时不往正文里插字符（keydown 已 preventDefault）',
    opened.editor === editorBefore && !opened.editor.endsWith('?'),
    { before: editorBefore, after: opened.editor }
  );

  // ---------- ③ Esc 关闭、焦点回编辑区 ----------
  await sendKey('Escape', [], 260);
  await waitFor("document.getElementById('shortcuts-backdrop').classList.contains('hidden') === true", 4000);
  const closed = await readPanel();
  check(
    '快捷键一览：Esc 关闭，焦点回到打开前的元素（编辑区）',
    closed.hidden === true && closed.activeId === 'editor',
    { hidden: closed.hidden, activeId: closed.activeId }
  );

  // ---------- ④ 编辑区里 ? 是普通字符 ----------
  // 光标放到末尾再打，落点确定（不依赖 setText 之后 Chromium 把 caret 放哪儿）。
  await exec(`(() => {
    const el = document.getElementById('editor');
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  })()`);
  const beforeTyping = await exec("document.getElementById('editor').value");
  await sendQuestion();
  const afterTyping = await exec("document.getElementById('editor').value");
  const stillHidden = await exec("document.getElementById('shortcuts-backdrop').classList.contains('hidden')");
  check(
    '快捷键一览：焦点在编辑区时 ? 仍是普通字符（正文多一个 ?，面板不打开）',
    stillHidden === true && afterTyping === `${beforeTyping}?`,
    { before: beforeTyping, after: afterTyping, hidden: stillHidden }
  );
  // 把编辑区改回已保存的正文（onEditorInput 会按「与 baseText 相同」把 dirty 清掉，不写盘）：
  // 否则后面的「返回书架」会弹未保存询问，E2E 一直在等它。
  await exec(`window.__cwTest.setText(${JSON.stringify(body)})`);
  await waitFor('window.__cwTest.dirty() === false', 4000);

  // ---------- ⑤ 命令面板开着时 ? 不抢 ----------
  await sendKey('k', ['control'], 260);
  await waitFor('window.__cwTest.commandPaletteOpen() === true', 4000);
  await sendQuestion();
  const paletteStillOpen = await exec('window.__cwTest.commandPaletteOpen()');
  const shortcutsHidden = await exec("document.getElementById('shortcuts-backdrop').classList.contains('hidden')");
  check(
    '快捷键一览：命令面板开着时 ? 不抢（命令面板仍是唯一弹层）',
    paletteStillOpen === true && shortcutsHidden === true,
    { paletteStillOpen, shortcutsHidden }
  );
  await sendKey('Escape', [], 260);
  await waitFor('window.__cwTest.commandPaletteOpen() === false', 4000);

  // ---------- ⑥ 书架页也能打开（列表不按视图过滤） ----------
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'", 8000);
  // 焦点放到书架页的「设置」按钮上：程序化返回书架时 Chromium 仍把焦点留在已隐藏的编辑区 textarea
  // （activeElement 报 BODY，但按键 target 还是 textarea），那不是真实用户会停留的位置；
  // 真实用户点过书架上的任何控件后焦点就在可见元素上，`?` 才会被接。
  await exec("document.getElementById('btn-settings').focus()");
  await waitFor("document.activeElement && document.activeElement.id === 'btn-settings'", 4000);
  await sendQuestion();
  await waitFor("document.getElementById('shortcuts-backdrop').classList.contains('hidden') === false", 4000);
  const onShelf = await readPanel();
  check(
    '快捷键一览：书架页按 ? 也能打开，列表仍是同一份命令键位（不是空表）',
    onShelf.hidden === false && onShelf.rows.length === opened.rows.length && commandRows.length > 0,
    { hidden: onShelf.hidden, rows: onShelf.rows.length, expected: opened.rows.length, activeId: onShelf.activeId }
  );
  await sendKey('Escape', [], 260);
  await waitFor("document.getElementById('shortcuts-backdrop').classList.contains('hidden') === true", 4000);
  const shelfFocusBack = await exec("document.activeElement ? document.activeElement.id : ''");
  check(
    '快捷键一览：从书架按钮打开、关闭后焦点回到那个按钮（归还焦点不限于编辑区）',
    shelfFocusBack === 'btn-settings',
    { activeId: shelfFocusBack }
  );

  // ---------- ⑦ 只读：章节 txt / 书目一个字节没动 ----------
  const stat1 = await fs.stat(chapterPath);
  const text1 = await storage.loadChapterText(bookPath, chapterFile);
  const meta1 = await storage.readBookMeta(bookPath);
  check(
    '快捷键一览：打开 / 关闭 / 列表渲染全程只读（章节 txt 内容 + mtime、书目章节未变）',
    text1.text === body &&
      stat1.size === stat0.size &&
      stat1.mtimeMs === stat0.mtimeMs &&
      JSON.stringify(meta1.chapters) === metaChapters0,
    {
      text: text1.text.slice(0, 40),
      size: [stat0.size, stat1.size],
      mtime: [stat0.mtimeMs, stat1.mtimeMs],
      chaptersSame: JSON.stringify(meta1.chapters) === metaChapters0
    }
  );

  // ---------- 收尾：回书架、删掉演练书 ----------
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'", 8000);
  const deleted = await deleteBookWithRetry(bookPath);
  check('快捷键一览：演练书已清理（_trash）', Boolean(deleted && deleted.ok === true), deleted);
};