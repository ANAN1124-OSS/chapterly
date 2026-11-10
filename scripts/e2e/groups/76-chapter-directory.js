// E2E 第 76 组：卷章目录重设计（2026-11-10）。
//
// 覆盖这一轮新增的三件事，全部只碰显示层：
//   1. 目录筛选：按章名 / 第N章筛选、命中 0 章的空态、Esc 清空、回车跳到第一条；
//   2. 卷头：吸顶（position: sticky）、章数 / 字数、全部折叠 / 全部展开；
//   3. 当前章定位：滚出目录 / 卷被折叠时「回到第 N 章」浮标仍能回去，点一下展开并滚回。
// 另外钉一条边界：没分卷的书不出现「全部折叠」，平铺目录不被收没。
//
// 自足：本组自己造两本演练书、自己删掉；不依赖前后的组。

module.exports = async function group76ChapterDirectory(t) {
  const { exec, check, waitFor, storage, booksRoot, deleteBookWithRetry } = t;

  // 76a. 造演练书：两卷 + 未分卷，共 9 章（顺序：未分卷 / 卷一×3 / 卷二×3 / 未分卷×2）
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");

  const created = await storage.createBook(booksRoot, '目录重设计演练');
  const bookPath = created.path;
  let meta = await storage.readBookMeta(bookPath);
  const firstId = meta.chapters[0].id;
  await storage.renameChapter(bookPath, firstId, '楔子 演练');
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '开场的一段正文，用来让字数不为零。\n');
  await storage.createVolume(bookPath, '卷一 演练');
  await storage.createVolume(bookPath, '卷二 演练');
  meta = await storage.readBookMeta(bookPath);
  const volumeA = meta.volumes[0];
  const volumeB = meta.volumes[1];

  const plan = [
    { name: '雨夜 演练', volume: volumeA.id },
    { name: '来客 演练', volume: volumeA.id },
    { name: '旧信 演练', volume: volumeA.id },
    { name: '渡口 演练', volume: volumeB.id },
    { name: '夜航 演练', volume: volumeB.id },
    { name: '上岸 演练', volume: volumeB.id },
    { name: '尾声 演练', volume: null },
    { name: '番外 演练', volume: null }
  ];
  for (const item of plan) {
    await storage.createChapterWithText(bookPath, {
      insertIndex: meta.chapters.length,
      name: item.name,
      text: '演练正文：这一章用来检查目录筛选与折叠。\n第二段。\n',
      volumeId: item.volume
    });
    meta = await storage.readBookMeta(bookPath);
  }
  check('卷章目录：演练书造好 9 章 / 2 卷 + 未分卷', meta.chapters.length === 9 && meta.volumes.length === 2, {
    chapters: meta.chapters.length,
    volumes: meta.volumes.length
  });
  // 分卷后的顺序是「未分卷 3 + 卷一 3 + 卷二 3」（core 按卷归一顺序），断言按名字查下标，不写死
  const nameAt = (name) => String(meta.chapters.findIndex((chapter) => chapter.name === name));
  const nightIndex = nameAt('夜航 演练');
  const chapter7Index = nameAt('渡口 演练');
  check(
    '卷章目录：演练书的章序符合「未分卷 → 卷一 → 卷二」',
    nightIndex === '7' && chapter7Index === '6',
    { order: meta.chapters.map((chapter) => chapter.name) }
  );

  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await waitFor("document.querySelectorAll('#chapter-list .chapter-item').length === 9");

  // 76a-2. 不带号特殊标题（尾声 / 番外）也补章号：序号格非空，完整标签 = 第N章：名字
  const endIndex = Number(nameAt('尾声 演练'));
  const extraIndex = Number(nameAt('番外 演练'));
  const specialLabels = await exec('window.__cwTest.chapterListLabels()');
  const specialNumbers = await exec(
    "Array.from(document.querySelectorAll('#chapter-list .chapter-num')).map((el) => el.dataset.num)"
  );
  check(
    '卷章目录：尾声 / 番外这类特殊标题也带章号（序号格不再为空）',
    specialLabels[endIndex] === `第${endIndex + 1}章：尾声 演练` &&
      specialLabels[extraIndex] === `第${extraIndex + 1}章：番外 演练` &&
      specialNumbers[endIndex] === String(endIndex + 1) &&
      specialNumbers[extraIndex] === String(extraIndex + 1),
    { endIndex, extraIndex, specialLabels, specialNumbers }
  );

  // 76b. 书头概览 / 卷头吸顶 / 全部折叠按钮
  const header = await exec(`(() => {
    const meta = document.getElementById('book-meta');
    const toggle = document.getElementById('btn-toggle-volumes');
    const volumes = Array.from(document.querySelectorAll('#chapter-list .volume-item'));
    const cs = volumes[0] ? getComputedStyle(volumes[0]) : null;
    return {
      metaText: meta ? meta.textContent : '',
      toggleText: toggle ? toggle.textContent : '',
      toggleVisible: Boolean(toggle && !toggle.classList.contains('hidden')),
      volumeCount: volumes.length,
      volumeNames: volumes.map((el) => el.querySelector('.volume-name').textContent),
      volumeCounts: volumes.map((el) => el.querySelector('.volume-count').textContent),
      position: cs ? cs.position : '',
      background: cs ? cs.backgroundColor : ''
    };
  })()`);
  check(
    '卷章目录：书头显示章数与总字数，有卷时出现「全部折叠」',
    /9 章/.test(header.metaText) && header.toggleVisible && header.toggleText === '全部折叠',
    header
  );
  check(
    '卷章目录：卷头吸顶、三组齐全（未分卷 / 卷一 / 卷二），每组带章数',
    header.volumeCount === 3 &&
      header.position === 'sticky' &&
      header.background !== 'rgba(0, 0, 0, 0)' &&
      header.volumeNames[0] === '未分卷' &&
      header.volumeNames[1] === '卷一 演练' &&
      header.volumeNames[2] === '卷二 演练' &&
      header.volumeCounts[0] === '3 章' &&
      header.volumeCounts[1] === '3 章' &&
      header.volumeCounts[2] === '3 章',
    header
  );

  // 76c. 按章名筛选：只留命中的章与它所在的卷，书头同一行显示命中数
  const setFilter = (value) =>
    exec(
      `(() => { const input = document.getElementById('chapter-filter'); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`
    );
  const directorySnapshot = () =>
    exec(`(() => {
      const list = document.getElementById('chapter-list');
      const rows = Array.from(list.querySelectorAll('.chapter-item'));
      const empty = list.querySelector('.chapter-list-empty');
      const toggle = document.getElementById('btn-toggle-volumes');
      const pill = document.getElementById('btn-return-current');
      return {
        rows: rows.length,
        indexes: rows.map((el) => el.dataset.index),
        names: rows.map((el) => el.querySelector('.chapter-name').textContent),
        hit: (list.querySelector('.chapter-hit') || {}).textContent || '',
        volumes: list.querySelectorAll('.volume-item').length,
        volumeNames: Array.from(list.querySelectorAll('.volume-name')).map((el) => el.textContent),
        volumeCounts: Array.from(list.querySelectorAll('.volume-count')).map((el) => el.textContent),
        marker: (() => {
          const row = list.querySelector('.volume-item.has-current');
          return row ? { volumeId: row.dataset.volumeId, name: row.querySelector('.volume-name').textContent } : null;
        })(),
        listBottom: Math.round(list.getBoundingClientRect().bottom),
        pillTop: pill ? Math.round(pill.getBoundingClientRect().top) : null,
        metaText: document.getElementById('book-meta').textContent,
        clearVisible: !document.getElementById('btn-clear-filter').classList.contains('hidden'),
        toggleVisible: Boolean(toggle && !toggle.classList.contains('hidden')),
        emptyKind: empty ? empty.dataset.emptyKind || '' : '',
        pillVisible: Boolean(pill && !pill.classList.contains('hidden')),
        pillText: pill ? pill.textContent : ''
      };
    })()`);

  await setFilter('夜航');
  await waitFor("document.querySelectorAll('#chapter-list .chapter-item').length === 1");
  const byName = await directorySnapshot();
  check(
    '卷章目录：按章名筛选只留命中章与所在卷，书头显示「找到 1 章」',
    byName.rows === 1 &&
      byName.indexes[0] === nightIndex &&
      byName.volumes === 1 &&
      byName.volumeNames[0] === '卷二 演练' &&
      byName.volumeCounts[0] === '命中 1 / 共 3 章' &&
      byName.hit === '夜航' &&
      byName.pillVisible === true &&
      byName.pillText === '回到第1章（清空筛选）' &&
      /找到 1 章/.test(byName.metaText) &&
      byName.clearVisible &&
      byName.toggleVisible === false,
    byName
  );

  // 76c-2. 筛选态浮标一次点击 = 清空筛选并回到当前章（不留在一个看不见当前章的列表里）
  await exec("document.getElementById('btn-return-current').click()");
  await waitFor("document.querySelectorAll('#chapter-list .chapter-item').length === 9");
  check(
    '卷章目录：筛选把当前章藏起来时，点浮标一次清空筛选并回到当前章',
    (await exec("document.getElementById('chapter-filter').value")) === '' &&
      (await exec("document.querySelector('#chapter-list .chapter-item.active').dataset.index")) === '0',
    await directorySnapshot()
  );

  // 76d. 按「第N章」筛选（章号 + 标题也能命中）
  await setFilter('第6章');
  await waitFor("document.querySelectorAll('#chapter-list .chapter-item').length === 1");
  const byNumber = await directorySnapshot();
  check(
    '卷章目录：输入「第6章」按章号命中同一章',
    byNumber.rows === 1 && byNumber.indexes[0] === '5' && byNumber.names[0] === meta.chapters[5].name,
    byNumber
  );

  // 76e. 命中 0 章：空态（不是真空态）+ 概览 0 章
  await setFilter('不存在的关键词');
  await waitFor("document.querySelectorAll('#chapter-list .chapter-item').length === 0");
  const empty = await directorySnapshot();
  check(
    '卷章目录：筛选 0 章给「筛选空」文案，概览显示找到 0 章',
    empty.rows === 0 && empty.emptyKind === 'filtered' && /找到 0 章/.test(empty.metaText) && empty.clearVisible,
    empty
  );

  // 76f. Esc 清空筛选：目录恢复、输入框与清除键收起
  await exec(
    `(() => { const input = document.getElementById('chapter-filter'); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`
  );
  await waitFor("document.querySelectorAll('#chapter-list .chapter-item').length === 9");
  const cleared = await directorySnapshot();
  const inputValue = await exec("document.getElementById('chapter-filter').value");
  check(
    '卷章目录：Esc 清空筛选，目录恢复 9 章、输入框清空',
    cleared.rows === 9 && inputValue === '' && cleared.clearVisible === false && cleared.toggleVisible,
    { cleared, inputValue }
  );

  // 76g. 回车跳到第一条命中：筛选「第7章」→ 回车 → 当前章切成第 7 章（上岸）
  await setFilter('第7章');
  await waitFor("document.querySelectorAll('#chapter-list .chapter-item').length === 1");
  await exec(
    `(() => { const input = document.getElementById('chapter-filter'); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`
  );
  await waitFor("document.querySelector('#chapter-list .chapter-item.active') && document.querySelector('#chapter-list .chapter-item.active').dataset.index === '6'");
  check(
    '卷章目录：筛选后回车跳到第一条命中章（当前章高亮跟着走）',
    (await exec("document.getElementById('chapter-title').textContent")).includes('渡口')
  );

  // 清空筛选，准备折叠
  await exec("document.getElementById('btn-clear-filter').click()");
  await waitFor("document.querySelectorAll('#chapter-list .chapter-item').length === 9");

  // 76h. 全部折叠：章行收起、卷头保留、「全部展开」出现、当前章浮标仍给回去的路
  await exec("document.getElementById('btn-toggle-volumes').click()");
  await waitFor("document.querySelectorAll('#chapter-list .chapter-item').length === 0");
  const collapsed = await directorySnapshot();
  check(
    '卷章目录：全部折叠收起章行，卷头与「全部展开」保留',
    collapsed.rows === 0 &&
      collapsed.volumes === 3 &&
      collapsed.toggleVisible &&
      (await exec("document.getElementById('btn-toggle-volumes').textContent")) === '全部展开',
    collapsed
  );
  check(
    '卷章目录：当前章被折叠时「回到第7章」浮标仍在',
    collapsed.pillVisible && collapsed.pillText === '回到第7章',
    collapsed
  );
  check(
    '卷章目录：浮标单独占一条、不压章行；当前卷头留 2px 朱红标记',
    collapsed.pillTop !== null &&
      collapsed.pillTop >= collapsed.listBottom - 0.5 &&
      collapsed.marker &&
      collapsed.marker.name === '卷二 演练' &&
      collapsed.marker.volumeId === String(meta.chapters[chapter7Index].volumeId),
    collapsed
  );

  // 76i. 点浮标：展开当前卷并定位当前章（其它卷保持折叠）
  await exec("document.getElementById('btn-return-current').click()");
  await waitFor("Boolean(document.querySelector('#chapter-list .chapter-item.active'))");
  // 浮标点击后是平滑滚动（prefers-reduced-motion 关闭时）：等它真的滚到位再断言，别用固定延时
  await waitFor("document.getElementById('btn-return-current').classList.contains('hidden')");
  const back = await directorySnapshot();
  check(
    '卷章目录：点浮标展开当前卷并回到当前章（只展开这一卷）',
    back.rows === 3 &&
      back.volumes === 3 &&
      (await exec("document.querySelector('#chapter-list .chapter-item.active').dataset.index")) === '6' &&
      back.pillVisible === false,
    back
  );

  // 76j. 全部展开：再点一次恢复 9 章
  await exec("document.getElementById('btn-toggle-volumes').click()");
  await waitFor("document.querySelectorAll('#chapter-list .chapter-item').length === 0");
  await exec("document.getElementById('btn-toggle-volumes').click()");
  await waitFor("document.querySelectorAll('#chapter-list .chapter-item').length === 9");
  check(
    '卷章目录：全部展开恢复 9 章，浮标收起',
    (await directorySnapshot()).pillVisible === false
  );

  // 76k. 章行「⋯」更多：打开的是同一张右键菜单（不是第二套菜单）
  await exec(
    "document.querySelector('#chapter-list .chapter-item[data-index=\"0\"] .chapter-more').click()"
  );
  const moreMenu = await exec(`(() => {
    const menu = document.getElementById('context-menu');
    return {
      visible: !menu.classList.contains('hidden'),
      actions: Array.from(menu.querySelectorAll('button[data-action]')).map((btn) => btn.dataset.action)
    };
  })()`);
  check(
    '卷章目录：章行「⋯」打开同一张右键菜单（状态项 / 移到卷 / 删除都在）',
    moreMenu.visible &&
      moreMenu.actions.includes('move-volume') &&
      moreMenu.actions.includes('delete') &&
      moreMenu.actions.includes('edit-note'),
    moreMenu
  );
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor("document.getElementById('context-menu').classList.contains('hidden')");

  // 76l. 没分卷的书：不出现卷头 / 全部折叠，平铺目录不被收没
  const flat = await storage.createBook(booksRoot, '平铺目录演练');
  const flatPath = flat.path;
  let flatMeta = await storage.readBookMeta(flatPath);
  await storage.renameChapter(flatPath, flatMeta.chapters[0].id, '开场');
  await storage.createChapterWithText(flatPath, {
    insertIndex: 1,
    name: '旧事',
    text: '平铺目录的第二章。\n'
  });
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(flatPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await waitFor("document.querySelectorAll('#chapter-list .chapter-item').length === 2");
  const flatInfo = await exec(`(() => ({
    volumes: document.querySelectorAll('#chapter-list .volume-item').length,
    toggleHidden: document.getElementById('btn-toggle-volumes').classList.contains('hidden'),
    metaText: document.getElementById('book-meta').textContent
  }))()`);
  check(
    '卷章目录：没分卷的书不出现卷头与「全部折叠」（平铺目录不被收没）',
    flatInfo.volumes === 0 && flatInfo.toggleHidden === true && /2 章/.test(flatInfo.metaText),
    flatInfo
  );

  // 收尾：回书架删掉两本演练书
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await deleteBookWithRetry(bookPath);
  await deleteBookWithRetry(flatPath);
  check('卷章目录：演练书清理完成', !(await t.fileExists(bookPath)) && !(await t.fileExists(flatPath)));
};