// E2E 第 33 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：回书架（「拖拽排序书」在架上），书架搜索
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。

module.exports = async function group33ShelfSearch(t) {
  const { exec, check, waitFor, sleep, win, setWindowSize } = t;

  // 33. 书架搜索：书名 + 章节名（不读正文）
  await exec('window.__cwTest.save()');
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const allShelfTitles = await exec('window.__cwTest.shelfTitles()');

  await exec("window.__cwTest.setShelfQuery('拖拽排序书')");
  await sleep(120);
  const titleFiltered = await exec('window.__cwTest.shelfFilteredTitles()');
  check('书架搜索：按书名过滤', JSON.stringify(titleFiltered) === JSON.stringify(['拖拽排序书']), titleFiltered);
  check(
    '书架搜索：书名匹配时不显示章节命中行',
    (await exec('window.__cwTest.shelfCardMatches()')).length === 0
  );

  await exec("window.__cwTest.setShelfQuery('第三')");
  await sleep(120);
  const chapterFiltered = await exec('window.__cwTest.shelfFilteredTitles()');
  const chapterMatchLines = await exec('window.__cwTest.shelfCardMatches()');
  check('书架搜索：按章节名过滤到对应的书', chapterFiltered.includes('拖拽排序书'), chapterFiltered);
  check(
    '书架搜索：卡片上显示命中的章节名',
    chapterMatchLines.some((line) => line.includes('第三')),
    chapterMatchLines
  );
  check(
    '书架搜索：过滤后条数少于全部',
    chapterFiltered.length < allShelfTitles.length,
    { filtered: chapterFiltered.length, all: allShelfTitles.length }
  );

  await exec("window.__cwTest.setShelfQuery('绝对不存在的书名xyz')");
  await sleep(120);
  check('书架搜索：没有匹配时列表为空', (await exec('window.__cwTest.shelfFilteredTitles()')).length === 0);
  check(
    '书架搜索：没有匹配时给出提示',
    (await exec('window.__cwTest.shelfSearchSummary()')).includes('没有匹配'),
    await exec('window.__cwTest.shelfSearchSummary()')
  );
  check(
    '书架搜索：没有匹配时不显示「新建一本书」',
    (await exec("document.querySelectorAll('.book-card.new-book').length")) === 0
  );

  await exec("window.__cwTest.setShelfQuery('')");
  await sleep(120);
  check(
    '书架搜索：清空后恢复全部书',
    (await exec('window.__cwTest.shelfFilteredTitles()')).length === allShelfTitles.length
  );
  check(
    '书架搜索：清空后「新建一本书」回来',
    (await exec("document.querySelectorAll('.book-card.new-book').length")) === 1
  );

  // 视觉拍板 #2（2026-11-04）：超宽屏（≥1600）书架内容列封顶 1520px 居中。
  // 本机逻辑屏宽约 1706 DIP，1660 宽既能触发 media query，又不会顶出屏幕；测完还原窗口。
  const shelfOrigBounds = win.getBounds();
  // 窗口 resize 是异步的（偶发拿到上一次的 innerWidth，见 harness.setWindowSize 注释）：
  // 等渲染层内宽真的进到超宽档再量；下面断言本身一个字没改。
  await setWindowSize(1660, 960, { minInner: 1600 });
  await sleep(200);
  const shelfWide = await exec(`(() => {
    const grid = document.getElementById('book-grid');
    const body = document.querySelector('.shelf-body');
    const head = document.querySelector('.shelf-head');
    const footer = document.querySelector('.shelf-footer');
    const gr = grid.getBoundingClientRect();
    const hr = head.getBoundingClientRect();
    const fr = footer.getBoundingClientRect();
    const headCs = getComputedStyle(head);
    const footCs = getComputedStyle(footer);
    const card = grid.querySelector('.book-card:not(.new-book)');
    const cr = card ? card.getBoundingClientRect() : null;
    return {
      vw: window.innerWidth,
      gridW: Math.round(gr.width * 100) / 100,
      cols: getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length,
      bodyW: Math.round(body.getBoundingClientRect().width * 100) / 100,
      headContentLeft: Math.round((hr.left + parseFloat(headCs.paddingLeft)) * 100) / 100,
      footerContentLeft: Math.round((fr.left + parseFloat(footCs.paddingLeft)) * 100) / 100,
      cardLeft: cr ? Math.round(cr.left * 100) / 100 : null
    };
  })()`);
  await setWindowSize(shelfOrigBounds.width, shelfOrigBounds.height, { maxInner: 1599 });
  await sleep(200);
  check(
    '书架（拍板 #2）：超宽窗（≥1600）书卡网格封顶 1520px，列数仍 5，固定头 / 页脚 / 首张卡片左边缘对齐',
    shelfWide.vw >= 1600 &&
      shelfWide.cols === 5 &&
      shelfWide.gridW <= 1520.5 &&
      shelfWide.gridW >= 1500 &&
      shelfWide.cardLeft !== null &&
      Math.abs(shelfWide.cardLeft - shelfWide.headContentLeft) <= 1 &&
      Math.abs(shelfWide.footerContentLeft - shelfWide.headContentLeft) <= 1,
    shelfWide
  );

  await exec(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))"
  );
  await sleep(80);
  check(
    '书架页 Ctrl+F 聚焦搜索框',
    (await exec('document.activeElement && document.activeElement.id')) === 'shelf-search',
    await exec('document.activeElement && document.activeElement.id')
  );

  await exec("window.__cwTest.setShelfQuery('拖拽排序书')");
  await exec(
    "document.getElementById('shelf-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"
  );
  await sleep(100);
  check('书架搜索：Esc 清空搜索', (await exec('window.__cwTest.shelfQuery()')) === '');
  await exec("window.__cwTest.setShelfQuery('拖拽排序书')");
  await exec(
    "document.getElementById('shelf-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))"
  );
  await waitFor("window.__cwTest.view() === 'editor'");
  check(
    '书架搜索：回车打开第一本匹配的书',
    (await exec('window.__cwTest.state.meta.title')) === '拖拽排序书'
  );

  // 33b（1.1.0）：书卡「章节命中」里的每个章名可单独点，直接打开这本书并定位到那一章；
  // 书卡其它区域仍按原行为打开（回到上次章节）；搜索清空后恢复普通书卡。
  // 当前书「拖拽排序书」的章节顺序是 [第三, 未命名, 第二]（第 27 组拖拽排序后还原），
  // 所以搜「第二」命中的是第 3 章（index=2），与上次打开的章节（第 1 章）不是同一章。
  const lastIndex = await exec('window.__cwTest.currentIndex()');
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec("window.__cwTest.setShelfQuery('第二')");
  await sleep(120);
  const chapterHitCard = await exec(`(() => {
    const card = Array.from(document.querySelectorAll('#book-grid .book-card[data-path]')).find((el) => {
      const title = el.querySelector('.book-card-title');
      return Boolean(title && title.textContent.includes('拖拽排序书'));
    });
    if (!card) return null;
    const line = card.querySelector('.book-card-match');
    return {
      path: card.dataset.path,
      lineText: line ? line.textContent : '',
      buttons: Array.from(card.querySelectorAll('.book-card-match-chapter')).map((button) => ({
        tag: button.tagName,
        type: button.type,
        index: button.getAttribute('data-chapter-index'),
        text: button.textContent
      }))
    };
  })()`);
  check(
    '书架搜索：章节命中行里的每个章名都是可按的按钮（带 0 起章节序号）',
    Boolean(chapterHitCard) &&
      chapterHitCard.lineText.startsWith('章节命中：') &&
      chapterHitCard.buttons.length >= 1 &&
      chapterHitCard.buttons.every(
        (button) =>
          button.tag === 'BUTTON' &&
          button.type === 'button' &&
          /^\d+$/.test(button.index) &&
          button.text.includes('第二')
      ),
    chapterHitCard
  );

  // 点书卡空白处：命中行存在时仍按原行为打开这本书（回到上次章节，不是命中章）
  await exec(`(() => {
    const card = Array.from(document.querySelectorAll('#book-grid .book-card[data-path]')).find((el) => {
      const title = el.querySelector('.book-card-title');
      return Boolean(title && title.textContent.includes('拖拽排序书'));
    });
    if (card) card.click();
    return Boolean(card);
  })()`);
  await waitFor("window.__cwTest.view() === 'editor'");
  const blankOpenTitle = await exec('window.__cwTest.state.meta.title');
  const blankOpenIndex = await exec('window.__cwTest.currentIndex()');
  check(
    '书架搜索：命中行存在时，点书卡空白处仍按原行为打开（回到上次章节）',
    blankOpenTitle === '拖拽排序书' && blankOpenIndex === lastIndex,
    { title: blankOpenTitle, index: blankOpenIndex, lastIndex }
  );

  // 搜索清空后恢复普通书卡：命中行 / 可点章名都不见，「新建一本书」回来
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec("window.__cwTest.setShelfQuery('')");
  await sleep(120);
  check(
    '书架搜索：清空后恢复普通书卡（没有命中行 / 可点章名）',
    (await exec("document.querySelectorAll('.book-card-match').length")) === 0 &&
      (await exec("document.querySelectorAll('.book-card-match-chapter').length")) === 0 &&
      (await exec("document.querySelectorAll('.book-card.new-book').length")) === 1
  );

  // 点命中章：直接打开这本书并定位到命中章（不是上次章节）
  await exec("window.__cwTest.setShelfQuery('第二')");
  await sleep(120);
  const hitIndex = await exec(`(() => {
    const card = Array.from(document.querySelectorAll('#book-grid .book-card[data-path]')).find((el) => {
      const title = el.querySelector('.book-card-title');
      return Boolean(title && title.textContent.includes('拖拽排序书'));
    });
    const button = card
      ? Array.from(card.querySelectorAll('.book-card-match-chapter')).find((el) => el.textContent.includes('第二'))
      : null;
    if (!button) return null;
    const index = Number(button.getAttribute('data-chapter-index'));
    button.click();
    return index;
  })()`);
  await waitFor("window.__cwTest.view() === 'editor'");
  const hitOpenTitle = await exec('window.__cwTest.state.meta.title');
  const hitOpenIndex = await exec('window.__cwTest.currentIndex()');
  check(
    '书架搜索：点「章节命中」的章名直达那一章（不是上次章节）',
    Number.isInteger(hitIndex) &&
      hitIndex !== lastIndex &&
      hitOpenTitle === '拖拽排序书' &&
      hitOpenIndex === hitIndex,
    { hitIndex, lastIndex, title: hitOpenTitle, index: hitOpenIndex }
  );
};
