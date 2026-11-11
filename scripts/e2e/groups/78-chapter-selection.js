// E2E 第 78 组：章节多选 + 批量动作（1.5.0 功能-1）。
//
// 钉住的事：
//   ① Ctrl+单击切换选中、不切章；Shift+单击从 anchor 连选；普通单击清空多选并照旧切章；
//   ② 点列表空白 / Esc（无弹层）清空；Ctrl+Space 切换焦点章的多选；
//   ③ 当前章 .active 与多选 .selected / aria-selected 互不覆盖；
//   ④ 批量条：已选 N 章 + 六个 24px 动作按钮；空选择时整条隐藏；
//   ⑤ 批量删除：一次删 N 章（各进本书 _trash），**一条撤销**按原位置恢复全部（正文 / 顺序一字不差）；
//   ⑥ 批量移到卷：一次移 N 章，一条撤销全部移回原位置；改状态：逐章写书目、不做撤销；
//   ⑦ 导出只支持连续范围：非连续给了明确提示且不弹对话框；连续时对话框预选「第 X–Y 章」；
//   ⑧ 复制选中章：按目录顺序（不是点击顺序）拼「标题 + 空行 + 正文」一次写剪贴板；当前章未保存用编辑区文本；
//   ⑨ 右键落在已选章上：菜单只留能作用到全部已选章的动作（单章动作收起），执行时作用于全部；
//   ⑩ 全程只读校验：多选 / 复制不写章节文件、不改书目（批量删除只进 _trash，撤销放回）。
//
// 自足：自己造一本 5 章的书、收尾走书架 _trash 删掉；不写配置、不碰真实书架。
const fs = require('node:fs/promises');
const path = require('node:path');

const CLICK = (index, extra = '') => `(() => {
  const el = document.querySelectorAll('#chapter-list .chapter-item')[${index}];
  if (!el) return false;
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: false, shiftKey: false, ${extra} }));
  return true;
})()`;

const selection = async (exec) => JSON.parse(await exec('JSON.stringify(window.__cwTest.chapterSelection())'));

module.exports = async function group78ChapterSelection(t) {
  const { exec, check, waitFor, sleep, storage, booksRoot, deleteBookWithRetry, clipboard, waitForClipboard, exporter } = t;

  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");

  // ---------- 造演练书：5 章，每章一段可辨认的正文 ----------
  const created = await storage.createBook(booksRoot, '章节多选演练');
  const bookPath = created.path;
  // 书名 / 章名都用固定值（storage.createChapter 的第 2 参数是插入下标）
  for (let i = 1; i < 5; i += 1) {
    await storage.createChapter(bookPath, i, ['乙', '丙', '丁', '戊'][i - 1]);
  }
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookPath)})`);
  await waitFor('window.__cwTest.view() === "editor"');
  await waitFor('window.__cwTest.chapterTitles().length === 5');
  const texts = ['正文一：风从海面吹来。', '正文二：雨下了一夜。', '正文三：灯还亮着。', '正文四：船靠了岸。', '正文五：天快亮了。'];
  for (let i = 0; i < 5; i += 1) {
    await exec(`window.__cwTest.switchTo(${i}, 'discard')`);
    await exec(`window.__cwTest.setText(${JSON.stringify(texts[i])})`);
    await exec('window.__cwTest.save()');
  }
  await waitFor('window.__cwTest.dirty() === false');
  await exec("window.__cwTest.switchTo(0, 'discard')");
  const meta0 = await storage.readBookMeta(bookPath);
  const titles0 = await exec('window.__cwTest.chapterTitles()');
  const files0 = meta0.chapters.map((chapter) => chapter.file);
  const statBefore = [];
  for (const file of files0) {
    const stat = await fs.stat(path.join(bookPath, file));
    statBefore.push({ size: stat.size, mtimeMs: stat.mtimeMs });
  }

  // ---------- ① Ctrl+单击：切换选中、不切章、批量条出现 ----------
  await exec(CLICK(1, 'ctrlKey: true'));
  await exec(CLICK(3, 'ctrlKey: true'));
  let sel = await selection(exec);
  check(
    '章节多选：Ctrl+单击两章 → 已选 2 章、批量条出现、当前章没被切走',
    sel.count === 2 && sel.barVisible === true && sel.countText === '已选 2 章' &&
      sel.markedIndexes.join(',') === '1,3' && (await exec('window.__cwTest.currentIndex()')) === 0,
    sel
  );
  const activeAt0 = await exec(
    "document.querySelectorAll('#chapter-list .chapter-item')[0].classList.contains('active')"
  );
  const selectedAt1 = await exec(
    "document.querySelectorAll('#chapter-list .chapter-item')[1].classList.contains('selected')"
  );
  const aria0 = await exec(
    "document.querySelectorAll('#chapter-list .chapter-item')[0].getAttribute('aria-selected')"
  );
  const aria1 = await exec(
    "document.querySelectorAll('#chapter-list .chapter-item')[1].getAttribute('aria-selected')"
  );
  check(
    '章节多选：当前章 .active 与多选 .selected / aria-selected 互不覆盖',
    activeAt0 === true && selectedAt1 === true && aria0 === 'false' && aria1 === 'true',
    { activeAt0, selectedAt1, aria0, aria1 }
  );
  const barHeights = await exec(`JSON.stringify({
    bar: document.getElementById('chapter-batch-bar').getBoundingClientRect().height,
    buttons: Array.from(document.querySelectorAll('#chapter-batch-bar button')).map((b) => ({
      h: b.getBoundingClientRect().height,
      w: b.getBoundingClientRect().width,
      label: b.getAttribute('aria-label')
    }))
  })`);
  const barInfo = JSON.parse(barHeights);
  check(
    '章节多选：批量条 32px、六个按钮都 ≥24×24 且有 aria-label',
    barInfo.bar >= 31 && barInfo.buttons.length === 6 &&
      barInfo.buttons.every((b) => b.h >= 24 && b.w >= 24 && b.label),
    barInfo
  );

  // ---------- ② Shift+单击：从 anchor（最后点过的第 3 章下标 3）连到第 1 章 ----------
  await exec(CLICK(0, 'shiftKey: true'));
  sel = await selection(exec);
  check(
    '章节多选：Shift+单击从 anchor 连选范围（0–3 共 4 章）、仍不切章',
    sel.count === 4 && sel.markedIndexes.join(',') === '0,1,2,3' &&
      (await exec('window.__cwTest.currentIndex()')) === 0,
    sel
  );
  // Ctrl+再点已选中的第 3 章：取消该章
  await exec(CLICK(2, 'ctrlKey: true'));
  sel = await selection(exec);
  check('章节多选：Ctrl+再点取消这一章', sel.count === 3 && sel.markedIndexes.join(',') === '0,1,3', sel);

  // ---------- ③ Esc（无弹层）清空 ----------
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor('window.__cwTest.chapterSelection().count === 0');
  sel = await selection(exec);
  check('章节多选：Esc（没有弹层 / 菜单）清空多选、批量条收起', sel.count === 0 && sel.barVisible === false, sel);

  // ---------- ④ 点列表空白清空 + Ctrl+Space 切换 ----------
  await exec(CLICK(1, 'ctrlKey: true'));
  await exec(CLICK(2, 'ctrlKey: true'));
  await exec("document.getElementById('chapter-list').dispatchEvent(new MouseEvent('click', { bubbles: true }))");
  sel = await selection(exec);
  check('章节多选：点列表空白清空多选', sel.count === 0, sel);
  await exec("document.querySelectorAll('#chapter-list .chapter-item')[2].focus()");
  await exec(
    "document.querySelectorAll('#chapter-list .chapter-item')[2].dispatchEvent(new KeyboardEvent('keydown', { key: ' ', ctrlKey: true, bubbles: true }))"
  );
  sel = await selection(exec);
  check('章节多选：Ctrl+Space 切换焦点章的多选（不切章）', sel.count === 1 && sel.markedIndexes.join(',') === '2', sel);
  await exec('window.__cwTest.clearChapterSelection()');

  // ---------- ④b 键盘路径（1.6.0 F1）：Shift+↑/↓ 扩选、Ctrl+A 全选、aria-live ----------
  // 键位只在章节列表里接管；焦点移动仍交给 list-keyboard 的 roving tabindex。
  const KEY_ON = (index, keyName, extra = '') => `(() => {
  const el = document.querySelectorAll('#chapter-list .chapter-item')[${index}];
  if (!el) return false;
  el.focus();
  el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(keyName)}, bubbles: true, cancelable: true, ${extra} }));
  return true;
})()`;
  const focusedIndex = () =>
    exec("document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.index : null");
  const currentAtKeyboard = await exec('window.__cwTest.currentIndex()');
  await exec('window.__cwTest.clearChapterSelection()');
  await exec(KEY_ON(0, 'ArrowDown', 'shiftKey: true'));
  sel = await selection(exec);
  const anchorAfterFirstShift = sel.anchorId;
  check(
    '章节多选：Shift+↓ 从焦点章扩选到下一章（焦点跟过去、不切章）',
    sel.count === 2 && sel.markedIndexes.join(',') === '0,1' &&
      (await focusedIndex()) === '1' &&
      (await exec('window.__cwTest.currentIndex()')) === currentAtKeyboard,
    { sel, focused: await focusedIndex() }
  );
  await exec(KEY_ON(1, 'ArrowDown', 'shiftKey: true'));
  sel = await selection(exec);
  check(
    '章节多选：再按 Shift+↓ 从同一个 anchor 继续扩到 3 章（不切章）',
    sel.count === 3 && sel.markedIndexes.join(',') === '0,1,2' &&
      sel.anchorId === anchorAfterFirstShift && (await focusedIndex()) === '2',
    { sel, anchorAfterFirstShift }
  );
  await exec(KEY_ON(2, 'ArrowUp', 'shiftKey: true'));
  sel = await selection(exec);
  check(
    '章节多选：Shift+↑ 往回缩不清掉已选中的章（并集），焦点回上一章',
    sel.count === 3 && sel.markedIndexes.join(',') === '0,1,2' &&
      sel.anchorId === anchorAfterFirstShift && (await focusedIndex()) === '1',
    { sel, focused: await focusedIndex() }
  );
  // Ctrl+A：焦点在列表里 → 全选（焦点章不动、不切章）
  await exec('window.__cwTest.clearChapterSelection()');
  await exec(KEY_ON(2, 'a', 'ctrlKey: true'));
  sel = await selection(exec);
  check(
    '章节多选：列表内 Ctrl+A 全选 5 章、批量条文案跟着变、不切章',
    sel.count === 5 && sel.markedIndexes.join(',') === '0,1,2,3,4' &&
      sel.countText === '已选 5 章' && sel.barVisible === true &&
      (await exec('window.__cwTest.currentIndex()')) === currentAtKeyboard,
    sel
  );
  // 焦点在编辑区时 Ctrl+A 不接管（正文原生全选），多选原样保留
  await exec('window.__cwTest.clearChapterSelection()');
  await exec(CLICK(2, 'ctrlKey: true'));
  await exec("document.getElementById('editor').focus()");
  await exec(
    "document.getElementById('editor').dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }))"
  );
  sel = await selection(exec);
  check(
    '章节多选：焦点在编辑区时 Ctrl+A 不抢（多选原样保留）',
    sel.count === 1 && sel.markedIndexes.join(',') === '2',
    sel
  );
  // 批量条键盘可达 + aria-live（Tab 能进按钮 / 已选 N 章会被播报）
  const barA11y = JSON.parse(await exec(`JSON.stringify({
    live: document.getElementById('chapter-batch-count').getAttribute('aria-live'),
    role: document.getElementById('chapter-batch-count').getAttribute('role'),
    atomic: document.getElementById('chapter-batch-count').getAttribute('aria-atomic'),
    barVisible: !document.getElementById('chapter-batch-bar').classList.contains('hidden'),
    tabs: Array.from(document.querySelectorAll('#chapter-batch-bar button')).map((b) => b.tabIndex)
  })`));
  check(
    '章节多选：批量条按钮都在 Tab 序里、已选 N 章走 aria-live 播报',
    barA11y.live === 'polite' && barA11y.role === 'status' && barA11y.atomic === 'true' &&
      barA11y.barVisible === true && barA11y.tabs.length === 6 && barA11y.tabs.every((n) => n >= 0),
    barA11y
  );
  await exec('window.__cwTest.clearChapterSelection()');

  // ---------- ⑤ 普通单击：清空多选 + 照旧切章 ----------
  await exec(CLICK(1, 'ctrlKey: true'));
  await exec(CLICK(3, 'ctrlKey: true'));
  await exec(CLICK(4));
  await waitFor('window.__cwTest.currentIndex() === 4');
  sel = await selection(exec);
  check('章节多选：普通单击清空多选并照旧切章', sel.count === 0 && (await exec('window.__cwTest.currentIndex()')) === 4, sel);
  await exec("window.__cwTest.switchTo(0, 'discard')");

  // ---------- ⑥ 批量删除：一次删 2 章 → 一条撤销恢复全部 ----------
  await exec(CLICK(1, 'ctrlKey: true'));
  await exec(CLICK(3, 'ctrlKey: true'));
  const trashBefore = await fs.readdir(path.join(bookPath, '_trash')).catch(() => []);
  await exec("document.getElementById('btn-batch-delete').click()");
  await waitFor('window.__cwTest.chapterTitles().length === 3', 8000);
  const titlesAfterDelete = await exec('window.__cwTest.chapterTitles()');
  const undoLabel = await exec("document.getElementById('undo-label').textContent");
  const trashAfter = (await fs.readdir(path.join(bookPath, '_trash'))).filter((n) => n.endsWith('.txt'));
  check(
    '章节多选：批量删除一次删掉 2 章（_trash 多 2 个 txt、目录剩 3 章、撤销条一条「已删除 2 章」）',
    trashAfter.length === trashBefore.filter((n) => n.endsWith('.txt')).length + 2 &&
      titlesAfterDelete.length === 3 && undoLabel === '已删除 2 章' &&
      (await exec('window.__cwTest.chapterSelection().count')) === 0,
    { titlesAfterDelete, undoLabel, trashAfter }
  );
  await exec("document.getElementById('btn-undo').click()");
  await waitFor('window.__cwTest.chapterTitles().length === 5', 8000);
  const restoredTitles = await exec('window.__cwTest.chapterTitles()');
  const restoredTexts = [];
  const metaAfterUndo = await storage.readBookMeta(bookPath);
  for (const chapter of metaAfterUndo.chapters) {
    restoredTexts.push((await storage.loadChapterText(bookPath, chapter.file)).text);
  }
  check(
    '章节多选：一次撤销按原位置恢复全部章（标题顺序 / 正文一字不差）',
    JSON.stringify(restoredTitles) === JSON.stringify(titles0) &&
      JSON.stringify(restoredTexts) === JSON.stringify(texts),
    { restoredTitles, restoredTexts }
  );

  // ---------- ⑦ 批量移到卷：一次移 2 章 → 一条撤销全部移回 ----------
  const volume = await exec("window.__cwTest.newVolume('卷A')");
  const volumeId = (await exec('window.__cwTest.volumeIds()'))[0];
  check('章节多选：演练用卷建好了', Boolean(volumeId) && volume && volume.ok === true, volume);
  await exec(CLICK(0, 'ctrlKey: true'));
  await exec(CLICK(2, 'ctrlKey: true'));
  await exec("document.getElementById('btn-batch-move').click()");
  await waitFor(
    `Array.from(document.querySelectorAll('#context-menu button[data-action^="move-volume:"]')).some((b) => b.dataset.action === ${JSON.stringify('move-volume:' + volumeId)})`
  );
  await exec(
    `document.querySelector('#context-menu button[data-action=${JSON.stringify('move-volume:' + volumeId)}]').click()`
  );
  await waitFor(
    `window.__cwTest.chapterVolumeIds().filter((id) => id === ${JSON.stringify(volumeId)}).length === 2`,
    8000
  );
  // 移到卷后章节数组会按卷重排、章号随位置重算，所以用**章名**（这本演练书里唯一）核对，不按下标 / 标题
  const namesAfterMove = await exec('window.__cwTest.chapterNames()');
  const volumeIdsAfterMove = await exec('window.__cwTest.chapterVolumeIds()');
  const volumeByName = {};
  namesAfterMove.forEach((name, i) => {
    volumeByName[name] = volumeIdsAfterMove[i];
  });
  const moveUndoLabel = await exec("document.getElementById('undo-label').textContent");
  check(
    '章节多选：批量移到卷一次移 2 章、一条撤销「已把 2 章移到「卷A」」',
    volumeByName[''] === volumeId &&
      volumeByName['丙'] === volumeId &&
      volumeIdsAfterMove.filter((id) => id === volumeId).length === 2 &&
      moveUndoLabel === '已把 2 章移到「卷A」',
    { volumeByName, volumeIdsAfterMove, moveUndoLabel }
  );
  await exec("document.getElementById('btn-undo').click()");
  await waitFor('window.__cwTest.chapterVolumeIds().every((id) => id === null)', 8000);
  check(
    '章节多选：批量移卷的撤销把 2 章都移回「未分卷」、目录顺序恢复',
    JSON.stringify(await exec('window.__cwTest.chapterTitles()')) === JSON.stringify(titles0),
    await exec('window.__cwTest.chapterVolumeIds()')
  );

  // ---------- ⑧ 批量改状态：逐章写书目、不做撤销 ----------
  await exec(CLICK(0, 'ctrlKey: true'));
  await exec(CLICK(1, 'ctrlKey: true'));
  await exec(CLICK(2, 'ctrlKey: true'));
  await exec("document.getElementById('btn-batch-status').click()");
  await exec("document.querySelector('#context-menu button[data-action=\"status-done\"]').click()");
  await waitFor('window.__cwTest.chapterStatuses().slice(0, 3).every((s) => s === "done")', 8000);
  const statusesAfter = await exec('window.__cwTest.chapterStatuses()');
  const undoHiddenAfterStatus = await exec("document.getElementById('undo-bar').classList.contains('hidden')");
  check(
    '章节多选：批量改状态作用于全部已选章（3 章完稿）、不改正文、不登记撤销',
    statusesAfter.slice(0, 3).every((s) => s === 'done') && statusesAfter[3] === 'draft' && undoHiddenAfterStatus === true,
    { statusesAfter, undoHiddenAfterStatus }
  );

  // ---------- ⑨ 右键落在已选章：只留批量动作，执行作用于全部 ----------
  await exec(CLICK(1, 'ctrlKey: true'));
  await exec(CLICK(2, 'ctrlKey: true'));
  await exec(
    "document.querySelectorAll('#chapter-list .chapter-item')[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 80 }))"
  );
  await sleep(80);
  const menuInfo = JSON.parse(
    await exec(`JSON.stringify({
      deleteText: document.querySelector('#context-menu button[data-action="delete"]').textContent,
      renameHidden: document.querySelector('#context-menu button[data-action="rename"]').classList.contains('hidden'),
      insertHidden: document.querySelector('#context-menu button[data-action="insert-before"]').classList.contains('hidden'),
      statusText: document.querySelector('#context-menu button[data-action="status-draft"]').textContent
    })`)
  );
  check(
    '章节多选：右键已选章 → 菜单只留批量动作（单章动作收起、文案带选中章数）',
    menuInfo.deleteText.includes('删除选中的 2 章') && menuInfo.renameHidden === true &&
      menuInfo.insertHidden === true && menuInfo.statusText.includes('（2 章）'),
    menuInfo
  );
  await exec("document.querySelector('#context-menu button[data-action=\"status-draft\"]').click()");
  await waitFor('window.__cwTest.chapterStatuses().slice(1, 3).every((s) => s === "draft")', 8000);
  check(
    '章节多选：右键菜单的状态动作作用于全部已选章',
    (await exec('window.__cwTest.chapterStatuses()')).slice(1, 3).every((s) => s === 'draft')
  );

  // ---------- ⑩ 导出：非连续提示、不弹对话框；连续时预选范围 ----------
  await exec('window.__cwTest.clearChapterSelection()');
  await exec(CLICK(0, 'ctrlKey: true'));
  await exec(CLICK(2, 'ctrlKey: true'));
  await exec("window.__cwTest.clearToasts()");
  await exec("document.getElementById('btn-batch-export').click()");
  await sleep(80);
  const exportToasts = await exec('window.__cwTest.toasts()');
  const exportOpenAfterBad = await exec('window.__cwTest.exportDialogOpen()');
  check(
    '章节多选：非连续选择导出只给提示（不弹对话框、不静默扩大范围）',
    exportToasts.some((item) => item.message.includes('导出只支持连续范围')) && exportOpenAfterBad === false,
    { exportToasts, exportOpenAfterBad }
  );
  await exec('window.__cwTest.clearChapterSelection()');
  await exec(CLICK(1, 'ctrlKey: true'));
  await exec(CLICK(2, 'shiftKey: true'));
  sel = await selection(exec);
  await exec("document.getElementById('btn-batch-export').click()");
  await waitFor('window.__cwTest.exportDialogOpen() === true', 6000);
  const range = await exec('window.__cwTest.readExportRange()');
  check(
    '章节多选：连续选择导出对话框预选「第 X–Y 章」范围',
    sel.count === 2 && range && range.mode === 'range' && range.from === 2 && range.to === 3,
    { sel, range }
  );
  await exec("document.getElementById('btn-export-cancel').click()");
  await waitFor('window.__cwTest.exportDialogOpen() === false');

  // ---------- ⑪ 复制选中章：目录顺序、一次写剪贴板、当前章未保存用编辑区文本 ----------
  await exec('window.__cwTest.clearChapterSelection()');
  await exec(CLICK(3, 'ctrlKey: true'));
  await exec(CLICK(0, 'ctrlKey: true'));
  const metaForCopy = await storage.readBookMeta(bookPath);
  const copyTexts = [];
  for (const chapter of metaForCopy.chapters) {
    copyTexts.push((await storage.loadChapterText(bookPath, chapter.file)).text);
  }
  const expectedCopy = exporter.composeSelected(metaForCopy, copyTexts, [0, 3]);
  await clipboard.writeText('E2E-SENTINEL-MULTI');
  await exec("document.getElementById('btn-batch-copy').click()");
  const clip = await waitForClipboard((text) => text !== 'E2E-SENTINEL-MULTI');
  check(
    '章节多选：复制选中章按目录顺序拼「标题 + 空行 + 正文」（不是点击顺序）',
    clip === expectedCopy,
    { clip: clip.slice(0, 160), expected: expectedCopy.slice(0, 160) }
  );
  // 当前章（第 5 章）有未保存内容时参与复制，但磁盘不动
  await exec('window.__cwTest.clearChapterSelection()');
  await exec('window.__cwTest.switchTo(4, "discard")');
  const unsaved = '这段还没保存，但复制选中章必须带上它。';
  await exec(`window.__cwTest.setText(${JSON.stringify(unsaved)})`);
  await exec(CLICK(4, 'ctrlKey: true'));
  await clipboard.writeText('E2E-SENTINEL-MULTI-2');
  await exec("document.getElementById('btn-batch-copy').click()");
  const clipUnsaved = await waitForClipboard((text) => text !== 'E2E-SENTINEL-MULTI-2');
  check(
    '章节多选：复制选中章包含当前章未保存内容（磁盘仍是旧正文）',
    clipUnsaved.includes(unsaved) && (await storage.loadChapterText(bookPath, meta0.chapters[4].file)).text === texts[4],
    clipUnsaved.slice(0, 160)
  );
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await exec('window.__cwTest.clearChapterSelection()');

  // ---------- ⑫ 只读校验：多选 / 复制 / 移卷 / 改状态没写章节文件 ----------
  // 删过的两章（下标 1 / 3）由撤销从 _trash 放回，mtime 会变，这里改用正文比对；
  // 其余章的 txt 大小 / mtime 必须一个字节没动。
  let untouched = true;
  for (const index of [0, 2, 4]) {
    const stat = await fs.stat(path.join(bookPath, files0[index]));
    if (stat.size !== statBefore[index].size || stat.mtimeMs !== statBefore[index].mtimeMs) untouched = false;
  }
  const metaAfter = await storage.readBookMeta(bookPath);
  const restoredBodyOk =
    (await storage.loadChapterText(bookPath, metaAfter.chapters[1].file)).text === texts[1] &&
    (await storage.loadChapterText(bookPath, metaAfter.chapters[3].file)).text === texts[3];
  check(
    '章节多选：没删过的章节 txt 大小 / mtime 未变、删过的两章撤销后正文一字不差',
    untouched && restoredBodyOk && metaAfter.chapters.map((c) => c.file).join(',') === files0.join(','),
    { untouched, restoredBodyOk, files: metaAfter.chapters.map((c) => c.file) }
  );

  // ---------- ⑬ 键盘全选 → Delete → 一次撤销（1.6.0 F1 验收：键盘能走完批量删除链） ----------
  await exec('window.__cwTest.clearChapterSelection()');
  await exec(KEY_ON(0, 'a', 'ctrlKey: true'));
  const selBeforeKeyDelete = await selection(exec);
  const trashBeforeKeyDelete = (await fs.readdir(path.join(bookPath, '_trash'))).filter((n) => n.endsWith('.txt')).length;
  await exec("document.querySelectorAll('#chapter-list .chapter-item')[0].focus()");
  await exec(
    "document.querySelectorAll('#chapter-list .chapter-item')[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))"
  );
  // 整本删空会自动补一个空章（与单章删除同一口径），所以目录剩 1 章。
  // 撤销条是在删除循环**之后**才登记的：必须等它真的亮起来再读文案 / 点撤销，
  // 否则会偶发读到空串（2026-11-11 实跑命中过一次）。
  await waitFor(
    "window.__cwTest.chapterTitles().length === 1 && document.getElementById('undo-label').textContent === '已删除 5 章'",
    10000
  );
  const trashAfterKeyDelete = (await fs.readdir(path.join(bookPath, '_trash'))).filter((n) => n.endsWith('.txt')).length;
  const undoLabelKeyDelete = await exec("document.getElementById('undo-label').textContent");
  check(
    '章节多选：键盘全选 + Delete 一次删掉 5 章（一条撤销、只进 _trash）',
    selBeforeKeyDelete.count === 5 && trashAfterKeyDelete === trashBeforeKeyDelete + 5 &&
      undoLabelKeyDelete === '已删除 5 章' &&
      (await exec('window.__cwTest.chapterSelection().count')) === 0,
    { selBeforeKeyDelete, trashBeforeKeyDelete, trashAfterKeyDelete, undoLabelKeyDelete }
  );
  await exec("document.getElementById('btn-undo').click()");
  await waitFor('window.__cwTest.chapterTitles().length === 5', 10000);
  const metaAfterKeyDeleteUndo = await storage.readBookMeta(bookPath);
  check(
    '章节多选：键盘路径的批量删除一次撤销按原位置恢复全部章',
    JSON.stringify(metaAfterKeyDeleteUndo.chapters.map((c) => c.file)) === JSON.stringify(files0),
    { files: metaAfterKeyDeleteUndo.chapters.map((c) => c.file), files0 }
  );

  // ---------- 收尾：回书架、删掉演练书 ----------
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'", 8000);
  const deleted = await deleteBookWithRetry(bookPath);
  check('章节多选：演练书已清理（_trash）', Boolean(deleted && deleted.ok === true), deleted);
};