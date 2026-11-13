// E2E 第 81 组：输入法组字中的 Enter（1.7.1 P1 / 外部审计 V73）。
//
// 现象：四条「Enter = 确认」链路原先都不判 event.isComposing。中文输入法组字时按 Enter
// 是「上屏候选词」，被当成提交后：书籍信息弹层存半截表单就关、通用询问框误确认、
// 跳章误跳、书架搜索误开书。
//
// 本组只做一件事：用 dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter',
// isComposing: true, bubbles: true })) 打这四条链路，钉住「组字中不提交」；再补一次
// isComposing: false 的普通 Enter，钉住「组字结束后旧行为不变」。
//
// 自足：本组自己新建一本书（两章）、自己收尾删掉（走真实删除 → 书架 _trash / 回收站），
// 不依赖前面组留下的书，也不污染后面的多窗口组（第 55 组）。
// 组文件只 require node 内建（tests/e2e-harness.test.js 有静态闸门）；这里一个 require 都不需要。
//
// 红 / 绿的可观察性：组字中那次按键如果真的被当成提交，四条链路各自会立刻产生可见后果
// （弹层关 / 询问框确认 / 章号跳走 / 视图进编辑页）。断言不靠固定 sleep 猜时间，而是在渲染层里
// 轮询「这件事有没有发生」：发生即返回 true（红阶段早退），到点没发生返回 false（绿阶段等满窗口）。

module.exports = async function group81ImeEnter(t) {
  const { exec, check, waitFor, waitForRender, sleep, deleteBookWithRetry } = t;

  const BOOK = 'IME组字书';
  const CHAPTER2 = '组字第二章';
  const RENAMED = '组字改名';
  const AUTHOR_COMPOSING = '组字作者';
  const AUTHOR_CONFIRM = '组字作者·正常';

  // 在渲染层里等「组字 Enter 真的把某件事做了」：命中即 true，到点没命中即 false。
  // timeoutMs 默认 1200ms —— 书籍信息保存 / 跳章 / 打开书都是本地 IPC，正常 < 100ms；
  // 绿阶段每条链路只多等这一个窗口，整组额外 4–5 秒。
  const pollFor = (condition, timeoutMs = 1200) => `(async () => {
    const deadline = Date.now() + ${timeoutMs};
    while (Date.now() < deadline) {
      try { if (${condition}) return true; } catch (err) { /* 页面正在切换：下一轮再看 */ }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return false;
  })()`;

  const keyOn = (id, composing) =>
    `document.getElementById(${JSON.stringify(id)}).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ${
      composing ? 'isComposing: true, ' : ''
    }bubbles: true }))`;
  // 询问框是「输入框 + Enter」这条链路：真实按键会冒泡到 document 的全局监听，这里照同样的路径派发。
  const keyOnDocument = (composing) =>
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ${
      composing ? 'isComposing: true, ' : ''
    }bubbles: true }))`;

  // ---------- 前导：回书架 + 自足造一本两章的书 ----------
  if ((await exec('window.__cwTest.view()')) !== 'shelf') {
    await exec('window.__cwTest.save()'); // 不丢上一组可能留在编辑区里的改动
    await exec('window.__cwTest.backToShelf()');
    await waitFor("window.__cwTest.view() === 'shelf'");
  }
  await exec(`window.__cwTest.newBook(${JSON.stringify(BOOK)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  const bookPath = await exec('window.__cwTest.bookPathValue()');
  await exec(`window.__cwTest.newChapter(${JSON.stringify(CHAPTER2)})`);
  await waitFor(`window.__cwTest.chapterNames().includes(${JSON.stringify(CHAPTER2)})`);
  await exec('window.__cwTest.save()');
  await exec('window.__cwTest.switchTo(0)');
  await waitFor('window.__cwTest.currentIndex() === 0');

  // ---------- ③ 跳章输入框（renderer.js 的 #jump-input Enter）：组字中的 Enter 不许跳章 ----------
  await exec('window.__cwTest.openJumpDialog()');
  await waitFor('window.__cwTest.jumpDialogOpen() === true');
  await exec(`window.__cwTest.setJumpQuery(${JSON.stringify(CHAPTER2)})`);
  await waitFor('window.__cwTest.jumpMatches().length > 0');
  const jumpIndexBefore = await exec('window.__cwTest.currentIndex()');
  const jumpTarget = (await exec('window.__cwTest.jumpMatches()'))[0].index;
  await exec(keyOn('jump-input', true));
  const jumpActedWhileComposing = await exec(
    pollFor(`window.__cwTest.jumpDialogOpen() === false || window.__cwTest.currentIndex() !== ${jumpIndexBefore}`)
  );
  check(
    '输入法组字中按 Enter 不跳章',
    jumpActedWhileComposing === false &&
      (await exec('window.__cwTest.jumpDialogOpen()')) === true &&
      (await exec('window.__cwTest.currentIndex()')) === jumpIndexBefore,
    { acted: jumpActedWhileComposing, indexBefore: jumpIndexBefore, target: jumpTarget }
  );
  // 组字结束（普通 Enter）：旧行为不变 —— 真的跳过去
  await exec(keyOn('jump-input', false));
  const jumpDidJump = await exec(
    pollFor(`window.__cwTest.jumpDialogOpen() === false && window.__cwTest.currentIndex() === ${jumpTarget}`)
  );

  // ---------- ② 通用询问框（promptText 的 modalInput，Enter = 确定）：组字中的 Enter 不许确认 ----------
  // renameChapterAt 的询问框与被误确认的「新建书名 / 关窗询问」是同一个 openModal({ input })，
  // 这里用它是因为它只改本组自己的书（误确认也只是把章名改成原值），书架上不会留下东西。
  // 不能 await 这次调用：promptText 要等弹层关掉才 resolve，await 会卡死在这次 exec 里。
  await exec('(() => { void window.__cwTest.renameChapterAt(1); return true; })()');
  await waitFor('window.__cwTest.modalOpen() === true');
  await exec(keyOnDocument(true));
  const modalConfirmedWhileComposing = await exec(pollFor('window.__cwTest.modalOpen() === false'));
  check(
    '输入法组字中按 Enter 不确认通用询问框',
    modalConfirmedWhileComposing === false && (await exec('window.__cwTest.modalOpen()')) === true,
    { confirmed: modalConfirmedWhileComposing, title: await exec('window.__cwTest.dialog()') }
  );
  // 组字结束（普通 Enter）：旧行为不变 —— 真的确认并改名（写进书目的是这一版章名）
  await exec(`document.getElementById('modal-input').value = ${JSON.stringify(RENAMED)}`);
  await exec(keyOnDocument(false));
  const modalConfirmed = await exec(
    pollFor(
      `window.__cwTest.modalOpen() === false && window.__cwTest.chapterNames()[1] === ${JSON.stringify(RENAMED)}`
    )
  );
  // 红阶段：询问框在组字那一下就被确认了，改名回执可能还在飞。给一拍再回书架，
  // 避免回执落在「书架视图 + 已关闭的书」上（绿阶段这拍只是空等）。
  await sleep(300);

  // ---------- ④ 书架搜索框（renderer.js 的 #shelf-search Enter）：组字中的 Enter 不许打开书 ----------
  await exec('window.__cwTest.save()');
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec(`window.__cwTest.setShelfQuery(${JSON.stringify(BOOK)})`);
  await waitForRender();
  await exec(keyOn('shelf-search', true));
  const searchOpenedWhileComposing = await exec(pollFor("window.__cwTest.view() === 'editor'"));
  check(
    '输入法组字中按 Enter 不打开书',
    searchOpenedWhileComposing === false && (await exec('window.__cwTest.view()')) === 'shelf',
    { opened: searchOpenedWhileComposing }
  );
  // 组字结束（普通 Enter）：旧行为不变 —— 打开第一本匹配的书
  await exec(`window.__cwTest.setShelfQuery(${JSON.stringify(BOOK)})`);
  await waitForRender();
  await exec(keyOn('shelf-search', false));
  const searchOpened = await exec(
    pollFor(
      `window.__cwTest.view() === 'editor' && Boolean(window.__cwTest.state.meta) && window.__cwTest.state.meta.title === ${JSON.stringify(BOOK)}`
    )
  );

  // ---------- ① 书籍信息弹层（bookinfo-ui.js 的 #bookinfo-backdrop Enter）：组字中的 Enter 不许保存 ----------
  await exec('window.__cwTest.save()');
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec("window.__cwTest.setShelfQuery('')");
  await waitForRender();
  await exec(`window.__cwTest.openBookInfoForPath(${JSON.stringify(bookPath)})`);
  await waitFor('window.__cwTest.bookInfoDialogOpen() === true');
  await exec(`window.__cwTest.setBookInfoField('author', ${JSON.stringify(AUTHOR_COMPOSING)})`);
  await exec(keyOn('bookinfo-backdrop', true));
  const infoSavedWhileComposing = await exec(pollFor('window.__cwTest.bookInfoDialogOpen() === false'));
  check(
    '输入法组字中按 Enter 不保存书籍信息',
    infoSavedWhileComposing === false && (await exec('window.__cwTest.bookInfoDialogOpen()')) === true,
    { saved: infoSavedWhileComposing, values: await exec('window.__cwTest.bookInfoValues()') }
  );
  // 组字结束（普通 Enter）：旧行为不变 —— 真的保存并关窗（写进书目的是这一版作者）
  await exec(`window.__cwTest.setBookInfoField('author', ${JSON.stringify(AUTHOR_CONFIRM)})`);
  await exec(keyOn('bookinfo-backdrop', false));
  const infoSaved = await exec(
    pollFor(
      `window.__cwTest.bookInfoDialogOpen() === false && Boolean(window.__cwTest.shelfBookInfo(${JSON.stringify(BOOK)})) && window.__cwTest.shelfBookInfo(${JSON.stringify(BOOK)}).author === ${JSON.stringify(AUTHOR_CONFIRM)}`
    )
  );

  // ---------- ⑤ 组字结束后旧行为四合一（同一组里再发普通 Enter，四条链路都还灵） ----------
  check(
    '组字结束后按 Enter 四条链路旧行为不变',
    jumpDidJump === true && modalConfirmed === true && searchOpened === true && infoSaved === true,
    { 跳章: jumpDidJump, 询问框: modalConfirmed, 书架搜索: searchOpened, 书籍信息: infoSaved }
  );

  // ---------- 收尾：删掉本组造的书（走真实删除 → 书架 _trash / 回收站），不污染后面的组 ----------
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const removed = await deleteBookWithRetry(bookPath);
  if (!removed || removed.ok !== true) {
    console.warn('[e2e] 第 81 组的演练书没删掉（现场留给排查）：', bookPath);
  }
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
};