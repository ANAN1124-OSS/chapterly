// E2E 第 27 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：新建「拖拽排序书」（覆盖当前书）
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。

module.exports = async function group27DragSort(t) {
  const { exec, check, waitFor, sleep, storage, state } = t;

  // 27. 章节拖拽排序：只改书目顺序，章节文件永不重命名，内容跟着章节走
  await exec("window.__cwTest.newBook('拖拽排序书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec("window.__cwTest.newChapter('第二')");
  await exec("window.__cwTest.newChapter('第三')");
  const sortBookPath = await exec('window.__cwTest.state.bookPath');
  state.sortBookPath = sortBookPath; // 第 28 / 30 组（查找替换 / 备份还原）都在这一本书上
  const filesBeforeMove = await exec('window.__cwTest.chapterFiles()');
  await exec('window.__cwTest.switchTo(2, "discard")');
  await exec("window.__cwTest.setText('这是第三章的正文，看它能不能跟着章节走。')");
  await exec('window.__cwTest.save()');
  const titlesBeforeMove = await exec('window.__cwTest.chapterTitles()');
  const namesBeforeMove = await exec('window.__cwTest.chapterNames()');

  await exec('window.__cwTest.moveChapterByDrag(2, 0)');
  await sleep(300);
  const namesAfterMove = await exec('window.__cwTest.chapterNames()');
  check(
    '拖拽排序：第 3 章移到最前',
    JSON.stringify(namesAfterMove) ===
      JSON.stringify([namesBeforeMove[2], namesBeforeMove[0], namesBeforeMove[1]]),
    { namesBeforeMove, namesAfterMove }
  );
  const titlesAfterMove = await exec('window.__cwTest.chapterTitles()');
  check(
    '拖拽排序：章号按新顺序自动重排',
    titlesAfterMove[0] === '第1章：第三' && titlesAfterMove[2] === '第3章：第二',
    { titlesBeforeMove, titlesAfterMove }
  );
  const filesAfterMove = await exec('window.__cwTest.chapterFiles()');
  check(
    '拖拽排序：章节文件一个都没改名',
    JSON.stringify(filesAfterMove.slice().sort()) === JSON.stringify(filesBeforeMove.slice().sort()),
    { filesBeforeMove, filesAfterMove }
  );
  const sortedMeta = await storage.readBookMeta(sortBookPath);
  check('拖拽排序：书目.json 顺序已落盘', sortedMeta.chapters[0].name === '第三', sortedMeta.chapters.map((c) => c.name));
  await exec('window.__cwTest.switchTo(0, "discard")');
  await waitFor("window.__cwTest.currentIndex() === 0");
  check(
    '拖拽排序：内容跟着章节一起搬家',
    (await exec('window.__cwTest.text()')) === '这是第三章的正文，看它能不能跟着章节走。'
  );

  // 27b. Phase D / D1：章节列表 Alt+↓ / Alt+↑ 在本卷内挪一格（合成 keydown 即可，委托在 #chapter-list 上）。
  // 这本书没有分卷（整本一个「未分卷」组），所以上下移动在整个列表内都有效。
  const stepBefore = await exec('window.__cwTest.chapterNames()');
  const stepCurrentId = await exec('window.__cwTest.currentChapterId()');
  const stepKey = (index, key) => exec(`(() => {
    const item = document.querySelector('#chapter-list .chapter-item[data-index="${index}"]');
    if (!item) return { ok: false };
    item.focus();
    const event = new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, altKey: true, bubbles: true, cancelable: true });
    item.dispatchEvent(event);
    return { ok: true, prevented: event.defaultPrevented };
  })()`);
  const down = await stepKey(0, 'ArrowDown');
  await waitFor(
    `window.__cwTest.chapterNames()[0] === ${JSON.stringify(stepBefore[1])} &&
     document.activeElement && document.activeElement.dataset && document.activeElement.dataset.index === '1'`,
    8000
  );
  check(
    '章节列表：Alt+↓ 在本卷内下移一格（只换书目顺序、当前章跟着走、焦点留在这一章）',
    down && down.ok === true && down.prevented === true &&
      JSON.stringify(await exec('window.__cwTest.chapterNames()')) ===
        JSON.stringify([stepBefore[1], stepBefore[0], stepBefore[2]]) &&
      (await exec('window.__cwTest.currentChapterId()')) === stepCurrentId
  );
  // 再按 Alt+↑ 挪回原位（后面的组还按这个顺序用这本书）
  const up = await stepKey(1, 'ArrowUp');
  await waitFor(
    `window.__cwTest.chapterNames()[0] === ${JSON.stringify(stepBefore[0])} &&
     document.activeElement && document.activeElement.dataset && document.activeElement.dataset.index === '0'`,
    8000
  );
  check(
    '章节列表：Alt+↑ 再挪回来（顺序还原、焦点跟着这一章回第 1 条）',
    up && up.ok === true && up.prevented === true &&
      JSON.stringify(await exec('window.__cwTest.chapterNames()')) === JSON.stringify(stepBefore) &&
      (await exec('window.__cwTest.currentIndex()')) === 0
  );
};
