// E2E 第 70 组：弹层无障碍名称 + 书卡 / 章节条目的键盘可达（v0.9 A-5b）。
//
// 钉住两件事：
//   1. **13 个弹层都有无障碍名称**：`role="dialog"` 挂 `aria-labelledby`、指向真标题——
//      以前 13 个弹层的标题只有 3 个有 id、没有一个挂 aria-labelledby，读屏进弹层只报
//      「对话框」，分不清是设置还是排版。
//   2. **只用键盘也能开会话、切章**：书卡与章节条目以前都是普通 <div>（tabIndex -1），
//      能 Tab 到书卡右上角的「⋯」却打不开书、能 Tab 到顶栏却切不了章。现在书卡 / 章节条目
//      都可 Tab 到、Enter / 空格激活；章节列表用 roving tabindex（只有当前章是 Tab 停留点），
//      方向键在列表里移焦点、Tab 直接跳出列表。
//
// 为什么必须 E2E：Tab 焦点遍历与「Enter 触发按钮」都是浏览器默认行为，渲染层 dispatch 的
// KeyboardEvent 走不到；这里用 win.webContents.sendInputEvent 发**真实按键**再读 activeElement。
// 另外钉一条「鼠标行为没变」：点章节条目照旧切章（本轮只补键盘通道）。
//
// 自足：自己造一本 2 章的演练书，收尾走书架 _trash 删掉；不写配置、不碰真实书架。
//
// U-D9（v0.13）在本组末尾补两条真实按键断言：章节列表焦点按 Delete 直接删除这一章
// （1.4.0 P0-2 起不再弹确认框；章节数 -1、文件进 _trash、撤销条出现、焦点留在列表）；编辑区焦点按
// Delete 仍只是删字（删除键只在 #chapter-list 的焦点域内生效）。
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const BACKDROPS = [
  'find-backdrop',
  'proofread-backdrop',
  'sensitive-backdrop',
  'export-backdrop',
  'jump-backdrop',
  'conflict-backdrop',
  'bookinfo-backdrop',
  'history-backdrop',
  'fragment-backdrop',
  'fragments-backdrop',
  'modal-backdrop',
  'format-backdrop',
  'settings-backdrop'
];

// 每个弹层的标题应该是哪一句（export / history / modal 的标题是动态的，只比前缀 / 非空）
const EXPECTED_NAMES = {
  'find-backdrop': '查找替换',
  'proofread-backdrop': '校对',
  'sensitive-backdrop': '敏感词预检',
  'export-backdrop': '导出',
  'jump-backdrop': '跳到哪一章',
  'conflict-backdrop': '检测到同步冲突副本',
  'bookinfo-backdrop': '书籍信息',
  'history-backdrop': '本书历史',
  'fragment-backdrop': '记一条碎片',
  'fragments-backdrop': '插入碎片',
  'format-backdrop': '智能排版',
  'settings-backdrop': '设置'
};

const JS_NAMES = `(() => {
  const ids = ${JSON.stringify(BACKDROPS)};
  return JSON.stringify(ids.map((id) => {
    const bd = document.getElementById(id);
    const dialog = bd ? bd.querySelector('[role="dialog"]') : null;
    const labelledby = dialog ? dialog.getAttribute('aria-labelledby') : null;
    const el = labelledby ? document.getElementById(labelledby) : null;
    return {
      id,
      hasDialog: Boolean(dialog),
      ariaModal: dialog ? dialog.getAttribute('aria-modal') : null,
      labelledby,
      exists: Boolean(el),
      isTitle: Boolean(el && el.classList.contains('modal-title')),
      name: el ? (el.textContent || '').trim() : ''
    };
  }));
})()`;

const JS_CARD = `(() => {
  const card = document.querySelector('#book-grid .book-card:not(.new-book)');
  if (!card) return JSON.stringify({ found: false });
  return JSON.stringify({
    found: true,
    tag: card.tagName.toLowerCase(),
    role: card.getAttribute('role'),
    label: card.getAttribute('aria-label'),
    tabIndex: card.tabIndex,
    path: card.dataset.path || '',
    title: (card.querySelector('.book-card-title') || {}).textContent || ''
  });
})()`;

const JS_CHAPTER_TABS = `(() => {
  const items = Array.from(document.querySelectorAll('#chapter-list .chapter-item'));
  const active = document.querySelector('#chapter-list .chapter-item.active');
  return JSON.stringify({
    total: items.length,
    zeros: items.filter((el) => el.tabIndex === 0).map((el) => el.dataset.index),
    role: items.length ? items[0].getAttribute('role') : null,
    label: items.length ? items[0].getAttribute('aria-label') : null,
    activeIndex: active ? active.dataset.index : null
  });
})()`;

const JS_FOCUS_CHAPTER = (index) => `(() => {
  const item = document.querySelector('#chapter-list .chapter-item[data-index="${index}"]');
  if (!item) return JSON.stringify({ ok: false });
  item.focus();
  return JSON.stringify({
    ok: true,
    focused: document.activeElement === item,
    activeIndex: document.activeElement ? document.activeElement.dataset.index : null
  });
})()`;

const JS_FOCUSED = `(() => {
  const active = document.activeElement;
  if (!active) return JSON.stringify({ tag: null });
  return JSON.stringify({
    tag: active.tagName.toLowerCase(),
    id: active.id || '',
    cls: typeof active.className === 'string' ? active.className : '',
    chapterIndex: active.dataset ? active.dataset.index || null : null,
    cardPath: active.dataset ? active.dataset.path || null : null,
    cardTitle: active.classList && active.classList.contains('book-card')
      ? (active.querySelector('.book-card-title') || {}).textContent || ''
      : null
  });
})()`;

module.exports = async function group70A11yKeyboard(t) {
  const { exec, check, waitFor, storage, booksRoot, deleteBookWithRetry, win, sleep } = t;

  // 真实按键：Tab / Enter / 空格 / 方向键都要靠浏览器默认行为，只有 sendInputEvent 能触发
  const sendKey = async (keyCode, modifiers = [], wait = 90) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(wait);
  };
  const sendTab = (shift = false) => sendKey('Tab', shift ? ['shift'] : []);
  const focused = async () => JSON.parse(await exec(JS_FOCUSED));

  const ensureWindowFocus = async () => {
    try {
      if (!win.isDestroyed()) {
        win.show();
        win.focus();
        win.webContents.focus();
      }
    } catch { /* 窗口可能正在销毁 */ }
    for (let i = 0; i < 12; i += 1) {
      try {
        if (await exec('document.hasFocus() === true')) return true;
      } catch { /* 页面可能还没就绪 */ }
      try { win.focus(); } catch { /* 忽略 */ }
      await sleep(120);
    }
    return false;
  };

  // ---------- 演练书 ----------
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const shelfBefore = (await storage.listBooks(booksRoot)).length;
  const created = await storage.createBook(booksRoot, '键盘演练');
  const bookPath = created.path;
  await storage.createChapter(bookPath, 1, '第二章');
  await exec('window.__cwTest.refreshShelf()');
  await sleep(300);
  const hasFocus = await ensureWindowFocus();
  check('键盘可达：自动化窗口拿到了系统焦点（真实按键才有默认焦点遍历）', hasFocus === true);

  // ---------- A. 13 个弹层的无障碍名称 ----------
  const names = JSON.parse(await exec(JS_NAMES));
  check('无障碍名称：13 个弹层都在页面上', names.length === 13, names.length);
  let named = 0;
  for (const item of names) {
    const want = EXPECTED_NAMES[item.id];
    const ok =
      item.hasDialog === true &&
      item.ariaModal === 'true' &&
      Boolean(item.labelledby) &&
      item.exists === true &&
      item.isTitle === true &&
      item.name.length > 0 &&
      (!want || item.name.startsWith(want));
    if (ok && item.id !== 'modal-backdrop') named += 1;
    check(
      `无障碍名称：${item.id} 的弹层挂了 aria-labelledby 且指向真标题（${item.name || '空'}）`,
      ok,
      item
    );
  }
  check('无障碍名称：12 个固定标题的弹层都有名字（通用询问框的标题是动态的，进写作页后单独测）', named === 12, named);

  // ---------- A2. 短暂提示的播报区（Phase D / D7）----------
  // toast 是「说完就没」的反馈（已保存 / 读取失败 / 章节文件被挪走……），看不见屏幕的人只能靠
  // live region 收到。查的是运行时 DOM 上的实际属性 + 计算样式（不是源码字符串）：被 CSS 藏掉的
  // live region 一样不会播报。
  // 注意：这里返回的是对象，不是 JSON 字符串 —— executeJavaScript 会把返回值反序列化回来，
  // 所以不能像上面 JS_NAMES / JS_CARD 那样再 JSON.parse 一次（那两份是自己在页面里 stringify 的）。
  const toastRegion = await exec(`(() => {
    const area = document.getElementById('toast-area');
    if (!area) return { found: false };
    const styles = getComputedStyle(area);
    return {
      found: true,
      role: area.getAttribute('role'),
      live: area.getAttribute('aria-live'),
      atomic: area.getAttribute('aria-atomic'),
      hiddenAttr: area.getAttribute('aria-hidden'),
      display: styles.display,
      visibility: styles.visibility
    };
  })()`);
  check(
    '无障碍：toast 播报区是 live region（role=status / aria-live=polite / aria-atomic=false，且没被藏起来）',
    toastRegion.found === true &&
      toastRegion.role === 'status' &&
      toastRegion.live === 'polite' &&
      toastRegion.atomic === 'false' &&
      toastRegion.hiddenAttr === null &&
      toastRegion.display !== 'none' &&
      toastRegion.visibility !== 'hidden',
    toastRegion
  );

  // ---------- B. 书架书卡：Tab 可达 + Enter / 空格打开 ----------
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await sleep(200);
  const card = JSON.parse(await exec(JS_CARD));
  check('键盘可达：书卡是可聚焦的按钮（role=button / tabindex=0 / 有书名）', card.found === true && card.tabIndex === 0 && card.role === 'button' && /^打开《.+》$/.test(card.label || ''), card);

  // 真实 Tab：从书架搜索框出发，几次 Tab 之内应该走到书卡（以前只能走到「⋯」按钮）
  await exec("document.getElementById('shelf-search').focus()");
  let tabToCard = null;
  let hit = null;
  for (let step = 1; step <= 16; step += 1) {
    await sendTab(false);
    const now = await focused();
    if (now.cardPath && now.cls && now.cls.split(/\s+/).includes('book-card')) {
      tabToCard = step;
      hit = now;
      break;
    }
  }
  check('键盘可达：Tab 能走到书卡上（不只是「⋯」按钮）', tabToCard !== null, { tabToCard, hit });
  check('键盘可达：Tab 停在书卡上时整个卡片是焦点（不是里面的按钮）', Boolean(hit && hit.cardTitle), hit);

  // 真实 Enter 打开这本书
  const wantedPath = hit && hit.cardPath;
  await sendKey('Enter', [], 200);
  await waitFor("window.__cwTest.view() === 'editor'", 8000);
  check('键盘可达：书卡上按 Enter 就打开这本书（不用鼠标）', (await exec('window.__cwTest.view()')) === 'editor');
  check(
    '键盘可达：Enter 打开的就是焦点所在的那本书',
    (await exec('window.__cwTest.bookPathValue()')) === wantedPath,
    { got: await exec('window.__cwTest.bookPathValue()'), want: wantedPath }
  );

  // 空格也能打开（回书架，直接聚焦演练书的书卡再按空格）
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await sleep(200);
  const focusedCard = await exec(`(() => {
    const cards = Array.from(document.querySelectorAll('#book-grid .book-card'));
    const el = cards.find((c) => c.dataset.path === ${JSON.stringify(bookPath)});
    if (el) el.focus();
    return Boolean(el);
  })()`);
  check('键盘可达：书架上能找到演练书的书卡并聚焦', focusedCard === true);
  await sendKey(' ', [], 200);
  await waitFor("window.__cwTest.view() === 'editor'", 8000);
  check('键盘可达：书卡上按空格也打开这本书', (await exec('window.__cwTest.view()')) === 'editor');

  // 「⋯」按钮自己响应 Enter（卡片不抢）：书卡把 keydown 委托在容器上，如果它对「焦点在卡片里
  // 那个按钮上」的 Enter 也 preventDefault，按钮的原生激活（Enter 触发 click）就被吃掉了。
  // Electron 的 sendInputEvent 只发原始键盘消息、触发不了按钮的原生激活（要 char 事件），
  // 所以这里直接看**默认行为有没有被拦**，再点一下确认菜单照旧能开。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await sleep(200);
  await exec("(() => { const more = document.querySelector('#book-grid .book-card .book-card-more'); if (more) more.focus(); return Boolean(more); })()");
  const nestedPrevented = await exec(`(() => {
    const more = document.querySelector('#book-grid .book-card .book-card-more');
    if (!more) return JSON.stringify({ ok: false });
    let seen = null;
    const spy = (event) => { seen = event.defaultPrevented; };
    document.addEventListener('keydown', spy, { once: true });
    more.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    document.removeEventListener('keydown', spy);
    return JSON.stringify({ ok: true, defaultPrevented: seen, focused: document.activeElement === more });
  })()`);
  const nested = JSON.parse(nestedPrevented);
  check(
    '键盘可达：焦点在书卡里的「⋯」上时，卡片的键盘处理不拦它的 Enter（原生激活不被吃掉）',
    nested.ok === true && nested.focused === true && nested.defaultPrevented === false,
    nested
  );
  await exec("document.querySelector('#book-grid .book-card .book-card-more').click()");
  await sleep(120);
  const menuOpen = await exec("!document.getElementById('book-menu').classList.contains('hidden')");
  const stillShelf = (await exec('window.__cwTest.view()')) === 'shelf';
  check('键盘可达：「⋯」照旧打开书卡菜单、不打开书（鼠标路径没变）', menuOpen === true && stillShelf === true, { menuOpen, stillShelf });
  await exec("document.getElementById('book-menu').classList.add('hidden')");

  // ---------- B2. 书架书卡方向键按网格移动（拍板 #16b）----------
  // 合成 keydown 就够：list-keyboard 只挂在 #book-grid 的 keydown 委托上，冒泡事件一样进得去，
  // 而且不受窗口焦点影响。列数由 renderer 的 bookGridColumns() 现算（getComputedStyle），
  // 所以这里也现算一遍期望值：多列时 ←/→ 只在本行、↑/↓ 跨一行、Home/End 到本行首尾；
  // 单列（窄窗）时退回原来的单向移动。
  const gridNav = await exec(`(() => {
    const grid = document.getElementById('book-grid');
    const cards = Array.from(grid.querySelectorAll('.book-card[data-path]'));
    if (cards.length < 2) return { ok: false, reason: 'not-enough-cards', count: cards.length };
    const cols = String(getComputedStyle(grid).gridTemplateColumns || '').trim().split(/\\s+/).filter(Boolean).length || 1;
    const last = cards.length - 1;
    const send = (el, key) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const at = () => cards.indexOf(document.activeElement);
    cards[0].focus();
    const rightHandled = send(cards[0], 'ArrowRight');
    const afterRight = at();
    send(document.activeElement, 'End');
    const afterEnd = at();
    send(document.activeElement, 'Home');
    const afterHome = at();
    cards[0].focus();
    const downHandled = send(cards[0], 'ArrowDown');
    const afterDown = at();
    cards[0].focus();
    return {
      ok: true,
      count: cards.length,
      cols,
      rightHandled,
      downHandled,
      afterRight,
      afterEnd,
      afterHome,
      afterDown,
      expect: {
        right: 1,
        end: cols > 1 ? Math.min(last, cols - 1) : last,
        home: 0,
        down: cols > 1 ? (cols <= last ? cols : 0) : Math.min(last, 1)
      }
    };
  })()`);
  check(
    '键盘可达：书架书卡方向键按网格走（←/→ 同行、↑/↓ 跨行、Home/End 到本行首尾；拍板 #16b）',
    gridNav.ok === true &&
      gridNav.rightHandled === true &&
      gridNav.downHandled === true &&
      gridNav.afterRight === gridNav.expect.right &&
      gridNav.afterEnd === gridNav.expect.end &&
      gridNav.afterHome === gridNav.expect.home &&
      gridNav.afterDown === gridNav.expect.down,
    gridNav
  );

  // ---------- C. 章节列表：roving tabindex + 方向键 / Enter / 空格 ----------
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await ensureWindowFocus();
  const tabs = JSON.parse(await exec(JS_CHAPTER_TABS));
  check('键盘可达：章节条目是按钮且带无障碍名称', tabs.role === 'button' && /^打开第\d+章/.test(tabs.label || ''), tabs);
  check(
    '键盘可达：整张列表只有一个 Tab 停留点，就是当前章（roving tabindex）',
    tabs.zeros.length === 1 && tabs.zeros[0] === tabs.activeIndex,
    tabs
  );

  const titleBefore = await exec('window.__cwTest.currentTitle()');
  await exec(JS_FOCUS_CHAPTER(0));
  await sendKey('Down');
  const afterArrow = await focused();
  check(
    '键盘可达：方向键把焦点移到下一章（不切章）',
    afterArrow.chapterIndex === '1' && (await exec('window.__cwTest.currentTitle()')) === titleBefore,
    afterArrow
  );
  const rovingAfterArrow = JSON.parse(await exec(JS_CHAPTER_TABS));
  check(
    '键盘可达：焦点移到哪一条，roving 停留点就跟到哪一条',
    rovingAfterArrow.zeros.length === 1 && rovingAfterArrow.zeros[0] === '1',
    rovingAfterArrow
  );

  await sendKey('Enter', [], 250);
  await waitFor(`window.__cwTest.currentTitle() !== ${JSON.stringify(titleBefore)}`, 8000);
  const titleAfterEnter = await exec('window.__cwTest.currentTitle()');
  check('键盘可达：章节条目上按 Enter 切章（不用鼠标）', titleAfterEnter !== titleBefore, { titleBefore, titleAfterEnter });

  // 空格也切回来（聚焦第一章再按空格）
  await exec(JS_FOCUS_CHAPTER(0));
  await sendKey(' ', [], 250);
  await waitFor(`window.__cwTest.currentTitle() === ${JSON.stringify(titleBefore)}`, 8000);
  check('键盘可达：章节条目上按空格也切章', (await exec('window.__cwTest.currentTitle()')) === titleBefore);

  // 鼠标行为没变：真实点击第二章照旧切章
  await exec("document.querySelector('#chapter-list .chapter-item[data-index=\"1\"]').click()");
  await waitFor(`window.__cwTest.currentTitle() === ${JSON.stringify(titleAfterEnter)}`, 8000);
  check('键盘可达：鼠标点章节条目照旧切章（只补键盘通道，没改鼠标）', (await exec('window.__cwTest.currentTitle()')) === titleAfterEnter);

  // ---------- C2. 重开书到非第一章：只留一个 Tab 停留点（拍板 #16a）----------
  // 复现条件与归档 §6.16 一致，两步缺一不可：
  //   ① 先在一本 **3 章**的临时书里停到第 3 章 —— 于是 state.index = 2（比演练书的章数还大）；
  //   ② 回书架再打开 **2 章**、上次停在**第 2 章**的演练书 —— openBookByPath 里的
  //      renderChapterList() 此时 state.index=2 越界，一条都没标 active，ensureTabStop 把第 1 条
  //      补成 tabindex 0；随后 loadChapterAt(1) 走 syncActiveChapterItem 快路径，修复前只把第 2 条
  //      设成 0，第 1 条那个 0 就留下来了（整张列表两个 Tab 停留点）。
  await exec("window.__cwTest.newBook('Tab 停留点测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const staleStopBookPath = await exec('window.__cwTest.bookPathValue()');
  await exec("window.__cwTest.newChapter('第二章')");
  await waitFor("window.__cwTest.currentTitle().includes('第二章')", 8000);
  await exec("window.__cwTest.newChapter('第三章')");
  await waitFor("window.__cwTest.currentTitle().includes('第三章')", 8000);
  await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false', 8000);
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await sleep(150);
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await waitFor(`window.__cwTest.currentTitle() === ${JSON.stringify(titleAfterEnter)}`, 8000);
  const reopened = JSON.parse(await exec(JS_CHAPTER_TABS));
  check(
    '键盘可达：重开书到非第一章时章节列表只剩一个 Tab 停留点，且就是当前章（拍板 #16a）',
    reopened.zeros.length === 1 && reopened.zeros[0] === reopened.activeIndex && reopened.activeIndex === '1',
    reopened
  );
  // 临时书是 shelfBefore 之后造的：收掉它，最后那条「书架数量回到演练前」才仍然成立
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await sleep(150);
  await deleteBookWithRetry(staleStopBookPath);
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await waitFor(`window.__cwTest.currentTitle() === ${JSON.stringify(titleAfterEnter)}`, 8000);

  // ---------- D. 通用询问框的名字（标题是打开的瞬间填进去的，得真开一次）----------
  await exec("window.__cwTest.setText('键盘可达：这一段不保存')");
  const pending = exec('window.__cwTest.backToShelf()');
  await waitFor('window.__cwTest.modalOpen()');
  await sleep(160);
  const modalName = JSON.parse(await exec(JS_NAMES)).find((item) => item.id === 'modal-backdrop');
  check(
    '无障碍名称：通用询问框打开后有非空名字（读屏能读出在问什么）',
    Boolean(modalName && modalName.labelledby === 'modal-title' && modalName.name.length > 0),
    modalName
  );
  await exec("window.__cwTest.answerModal('cancel')");
  await waitFor('window.__cwTest.modalOpen() === false');
  await pending.catch(() => {});
  await sleep(160);
  // 取消之后正文还是「未保存」：存掉再往下走（否则回书架又会弹询问、后面的 exec 会一直等）
  await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false', 8000);

  // ---------- E. 只用键盘存盘（Ctrl+S）----------
  await exec("window.__cwTest.setText('键盘存盘：这两个字要落盘')");
  await waitFor('window.__cwTest.dirty() === true', 4000);
  await sendKey('S', ['control'], 300);
  // 真实按键没生效也要先收尾（别把未保存状态留给后面的组），再让断言红
  const savedByKeys = await waitFor('window.__cwTest.dirty() === false', 5000).catch(() => false);
  check('键盘可达：Ctrl+S 真实按键把正文落盘（键盘走完「打开 → 切章 → 保存」）', savedByKeys === true);
  if (!savedByKeys) await exec('window.__cwTest.save()');

  // ---------- 收尾（先验落盘，再做 U-D9 的删章——删完只剩 1 章，别让 meta.chapters[1] 失效）----------
  const meta = await storage.readBookMeta(bookPath);
  const savedText = await storage.loadChapterText(bookPath, meta.chapters[1].file);
  check('键盘可达：真的落盘了（磁盘正文就是键盘存进去的那一段）', savedText.text.includes('键盘存盘'), savedText.text.slice(0, 40));

  // ---------- F. U-D12：写作页 Ctrl+PageUp / PageDown 切章（必须排在 E2 删章之前）----------
  // 上面刚用 Ctrl+S 存过盘，当前停在**末章**（第 2 章）：两个方向各切一次、两个边界各顶一次，
  // 最后用未保存内容证明走的是现成的「切换章节前保存」询问框，不是静默保存。
  await ensureWindowFocus();
  await exec('window.__cwTest.setCaret(0)'); // 焦点回编辑区（真实 PageUp / PageDown 才有默认焦点语义）
  const titlesD12 = await exec('window.__cwTest.chapterTitles()');
  await sendKey('PageUp', ['control'], 250);
  await waitFor('window.__cwTest.currentTitle() === ' + JSON.stringify(titlesD12[0]), 8000).catch(() => false);
  check(
    '键盘可达：写作页 Ctrl+PageUp 切到上一章（末章 → 第 1 章，章数不变）',
    (await exec('window.__cwTest.currentTitle()')) === titlesD12[0] &&
      (await exec('window.__cwTest.chapterTitles()')).length === titlesD12.length,
    { titlesD12, title: await exec('window.__cwTest.currentTitle()') }
  );

  await sendKey('PageUp', ['control'], 250);
  await sleep(200);
  check(
    '键盘可达：首章按 Ctrl+PageUp 不动（不绕回末章、正文不变）',
    (await exec('window.__cwTest.currentTitle()')) === titlesD12[0]
  );

  await sendKey('PageDown', ['control'], 250);
  await waitFor('window.__cwTest.currentTitle() === ' + JSON.stringify(titlesD12[1]), 8000).catch(() => false);
  check(
    '键盘可达：写作页 Ctrl+PageDown 切到下一章（第 1 章 → 末章）',
    (await exec('window.__cwTest.currentTitle()')) === titlesD12[1],
    { want: titlesD12[1], got: await exec('window.__cwTest.currentTitle()') }
  );

  await sendKey('PageDown', ['control'], 250);
  await sleep(200);
  check(
    '键盘可达：末章按 Ctrl+PageDown 不动（不绕回第 1 章、章数不变）',
    (await exec('window.__cwTest.currentTitle()')) === titlesD12[1] &&
      (await exec('window.__cwTest.chapterTitles()')).length === titlesD12.length
  );

  // 未保存内容：切章键必须落到与点章节栏同一条 askUnsaved 询问框（不许静默保存、不许直接丢）
  await exec("window.__cwTest.setText('U-D12：这一段不保存，询问框应该拦住')");
  await waitFor('window.__cwTest.dirty() === true', 4000);
  await sendKey('PageUp', ['control'], 250);
  const askedD12 = await waitFor('window.__cwTest.modalOpen() === true', 4000).catch(() => false);
  const dialogD12 = await exec('window.__cwTest.dialog()');
  await exec("window.__cwTest.answerModal('cancel')");
  await waitFor('window.__cwTest.modalOpen() === false', 4000);
  await sleep(200);
  const afterCancelD12 = {
    title: await exec('window.__cwTest.currentTitle()'),
    text: await exec('window.__cwTest.text()'),
    dirty: await exec('window.__cwTest.dirty()')
  };
  check(
    '键盘可达：Ctrl+PageUp 遇到未保存内容走现有询问框（取消 → 留在本章、正文没丢）',
    askedD12 === true &&
      dialogD12 === '切换章节前保存' &&
      afterCancelD12.title === titlesD12[1] &&
      afterCancelD12.text.includes('U-D12：这一段不保存') &&
      afterCancelD12.dirty === true,
    { askedD12, dialogD12, afterCancelD12 }
  );
  // 取消后仍是未保存：存掉，别把脏状态留给后面的 Delete / 收尾
  await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false', 8000);

  // ---------- E2. U-D9：Delete 只在章节列表焦点域里删章；编辑区删字照旧 ----------
  // 编辑区：真实 Delete 必须还是删字（删除键只挂在 #chapter-list 的 keydown 委托上，
  // 编辑区根本不在这个容器里）。删一个字后立刻把正文还原，别把未保存状态留给收尾。
  await ensureWindowFocus();
  const textBeforeDelete = await exec('window.__cwTest.text()');
  await exec('window.__cwTest.setCaret(0)');
  await sendKey('Delete', [], 200);
  const afterEditorDelete = await exec('window.__cwTest.text()');
  check(
    '键盘可达：编辑区焦点按 Delete 仍是删字（章节数量一个没变）',
    textBeforeDelete.length > 0 &&
      afterEditorDelete === textBeforeDelete.slice(1) &&
      (await exec('window.__cwTest.chapterTitles()')).length === 2,
    { before: textBeforeDelete, after: afterEditorDelete }
  );
  await exec(`window.__cwTest.setText(${JSON.stringify(textBeforeDelete)})`);
  await waitFor('window.__cwTest.dirty() === false', 4000).catch(() => false);

  // 章节列表：焦点停在第一条按 Delete → 直接删除（1.4.0 P0-2 起不再弹「删除章节」确认框）
  // → 章节数 -1、文件进 _trash、撤销条出现、焦点留在列表里（不是掉回 body；这条靠 focusChapterAfterDelete）。
  await exec(JS_FOCUS_CHAPTER(0));
  const titlesBeforeDelete = await exec('window.__cwTest.chapterTitles()');
  await sendKey('Delete', [], 250);
  await waitFor('window.__cwTest.chapterTitles().length === 1', 8000);
  await sleep(200);
  const titlesAfterDelete = await exec('window.__cwTest.chapterTitles()');
  const trashNames = await fs.readdir(path.join(bookPath, '_trash')).catch(() => []);
  const focusInList = await exec(
    "(() => { const a = document.activeElement; return Boolean(a && a.closest && a.closest('#chapter-list .chapter-item')); })()"
  );
  const modalAfterDelete = await exec('window.__cwTest.modalOpen()');
  const undoBarShown = await exec("!document.getElementById('undo-bar').classList.contains('hidden')");
  check(
    '键盘可达：章节列表焦点按 Delete 直接删除这一章（不再弹确认框；章节数 -1、文件进 _trash、撤销条出现、焦点留在列表）',
    modalAfterDelete === false &&
      undoBarShown === true &&
      titlesAfterDelete.length === titlesBeforeDelete.length - 1 &&
      trashNames.some((name) => name.endsWith('.txt')) &&
      focusInList === true,
    { modalAfterDelete, undoBarShown, titlesBeforeDelete, titlesAfterDelete, trashNames, focusInList }
  );

  // ---------- G. U-D1：Alt+↓ 在卷尾跨到相邻的一卷（真实按键 → 先确认 → 只改书目） ----------
  // E2 删完只剩 1 章：造两个卷，把这一章放进「甲卷」，焦点停在它上面按 Alt+↓。
  // 乙卷是空的 —— 空卷也算一步（不跳过），跨进去后卷归属变、章节文件 hash/mtime 一个字节不动；
  // 再按 Alt+↑ 原样退回甲卷（可回退），回到首卷第一条再按一次必须不再弹框（首卷首章不动）。
  await exec("window.__cwTest.newVolume('U-D1 甲卷')");
  await exec("window.__cwTest.newVolume('U-D1 乙卷')");
  const d1VolIds = await exec('window.__cwTest.volumeIds()');
  await exec('window.__cwTest.moveChapterToVolumeAt(0, 0)');
  await ensureWindowFocus();
  await exec(JS_FOCUS_CHAPTER(0));
  const d1MetaBefore = await storage.readBookMeta(bookPath);
  const d1File = d1MetaBefore.chapters[0].file;
  const d1Name = d1MetaBefore.chapters[0].name;
  const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
  const d1HashBefore = sha256(await fs.readFile(path.join(bookPath, d1File)));
  const d1MtimeBefore = (await fs.stat(path.join(bookPath, d1File))).mtimeMs;
  // 注意：sendInputEvent 的方向键要用 Chromium 的加速键名 Down / Up（写成 ArrowDown 发出去是
  // Unidentified，渲染层收到 event.key 不对，Alt+↓ 根本不会触发 —— 本文件 D 段就踩过这个坑）。
  await sendKey('Down', ['alt'], 350);
  const d1Asked = await waitFor('window.__cwTest.modalOpen() === true', 4000).catch(() => false);
  const d1Dialog = await exec('window.__cwTest.dialog()');
  const d1Message = await exec('window.__cwTest.modalMessage()');
  const d1Buttons = await exec('window.__cwTest.modalButtons()');
  await exec("window.__cwTest.answerModal('move')");
  await waitFor(`window.__cwTest.chapterVolumeIds()[0] === ${JSON.stringify(d1VolIds[1])}`, 8000).catch(() => false);
  await sleep(150);
  const d1MetaAfter = await storage.readBookMeta(bookPath);
  // 反着按 Alt+↑：乙卷 → 甲卷卷尾（可回退）
  await exec(JS_FOCUS_CHAPTER(0));
  await sendKey('Up', ['alt'], 350);
  const d1AskedBack = await waitFor('window.__cwTest.modalOpen() === true', 4000).catch(() => false);
  await exec("window.__cwTest.answerModal('move')");
  await waitFor(`window.__cwTest.chapterVolumeIds()[0] === ${JSON.stringify(d1VolIds[0])}`, 8000).catch(() => false);
  await sleep(150);
  const d1MetaBack = await storage.readBookMeta(bookPath);
  // 已经在首卷第一条：再按 Alt+↑ 必须什么都不发生（不弹框、不写盘）
  await exec(JS_FOCUS_CHAPTER(0));
  await sendKey('Up', ['alt'], 250);
  await sleep(200);
  const d1LastAsk = await exec('window.__cwTest.modalOpen()');
  const d1HashAfter = sha256(await fs.readFile(path.join(bookPath, d1File)));
  const d1MtimeAfter = (await fs.stat(path.join(bookPath, d1File))).mtimeMs;
  check(
    '跨卷：Alt+↓ 在卷尾先确认再跨到下一卷（只改书目卷归属，正文 hash/mtime 不动；Alt+↑ 可退回，首卷再往上不动）',
    d1Asked === true &&
      d1Dialog === '跨卷移动' &&
      d1Message.includes('U-D1 乙卷') &&
      Array.isArray(d1Buttons) &&
      d1Buttons.includes('move') &&
      d1AskedBack === true &&
      d1MetaAfter.chapters.length === 1 &&
      d1MetaAfter.chapters[0].file === d1File &&
      d1MetaAfter.chapters[0].name === d1Name &&
      d1MetaAfter.chapters[0].volumeId === d1VolIds[1] &&
      d1MetaBack.chapters[0].file === d1File &&
      d1MetaBack.chapters[0].volumeId === d1VolIds[0] &&
      d1HashAfter === d1HashBefore &&
      d1MtimeAfter === d1MtimeBefore &&
      d1LastAsk === false,
    {
      d1Asked,
      d1Dialog,
      d1Message,
      d1Buttons,
      d1AskedBack,
      d1LastAsk,
      d1HashBefore,
      d1HashAfter,
      d1MtimeBefore,
      d1MtimeAfter,
      d1After: d1MetaAfter.chapters.map((c) => ({ file: c.file, volumeId: c.volumeId }))
    }
  );

  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await sleep(150);
  const deleted = await deleteBookWithRetry(bookPath);
  check('键盘可达：演练书已收尾（删除走书架 _trash）', Boolean(deleted && deleted.ok === true), deleted);
  const shelfAfter = (await storage.listBooks(booksRoot)).length;
  check('键盘可达：书架数量回到演练前', shelfAfter === shelfBefore, { before: shelfBefore, after: shelfAfter });
  check(
    '键盘可达：演练期间没有留下打开的弹层 / 菜单',
    (await exec("document.querySelectorAll('.backdrop:not(.hidden)').length")) === 0
  );
};
