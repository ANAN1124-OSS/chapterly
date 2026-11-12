// E2E 第 80 组：书架分组 / 标签筛选与管理（1.6.0 F5）。
//
// 钉住的事：
//   ① 书架顶部同时出现「分组」「标签」两个筛选下拉，选项带本数 / 篇数计数，「管理分组…」出现；
//   ② 分组筛选、标签筛选两者是 AND，再与搜索词 AND（搜索命中但标签不符 = 不显示）；
//   ③ 分组管理弹层：列出分组与本数；「改名」询问框初值 = 旧名，弹层先收起（不叠两个弹层）；
//      改名后书目只剩 group 变化（正文 / 章节文件 / 文件名 / .bak 之外一律不动）；
//   ④ 合并：把 F5乙组并进已有分组，两本书落在同一分组，选项计数变 2、旧分组消失；
//   ⑤ 书卡右键「移到分组…」：单本改分组，点开在菜单里展开已有分组（带本数 / 当前打勾）、
//      「未分组」与「新建分组…」；点选即改，不弹询问框（书架没有多选，批量改分组见 §9 待办）；
//   ⑥ 只改 书目.json：章节 txt 字节 / mtime / 文件清单不变，config.json 里书签与「最近书」不变，
//      筛选状态只记内存（config 不新增 shelfGroup / shelfTag 字段）。
//
// 自足：自己造 3 本书（分组 / 标签各一套），收尾逐本走 _trash 删掉；不写配置、不碰真实书架。
const fs = require('node:fs/promises');
const path = require('node:path');

const GROUP_A = 'F5甲组';
const GROUP_B = 'F5乙组';
const GROUP_C = 'F5丙组';
const TAG_X = 'F5标签甲';
const TAG_Y = 'F5标签乙';

module.exports = async function group80ShelfGroups(t) {
  const { exec, check, waitFor, storage, booksRoot, userData, deleteBookWithRetry } = t;

  const label = (name, count) => `${name}（${count}）`;
  const readConfig = async () => JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8'));

  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");

  // ---------- 造演练书：甲 / 乙有分组与标签，丙什么都没有 ----------
  const created = [];
  const mkBook = async (title, info) => {
    const created0 = await storage.createBook(booksRoot, title);
    if (info) {
      const result = await exec(
        `window.api.updateBookInfo(${JSON.stringify(created0.path)}, ${JSON.stringify(info)})`
      );
      if (!result || result.ok !== true) throw new Error(`造演练书失败：${title}`);
    }
    created.push(created0.path);
    return created0.path;
  };

  const pathA = await mkBook('F5甲书', { group: GROUP_A, tags: [TAG_X, TAG_Y], author: 'F5作者' });
  const pathB = await mkBook('F5乙书', { group: GROUP_B, tags: [TAG_X] });
  const pathC = await mkBook('F5无组书', { tags: [] });

  await exec('window.__cwTest.refreshShelf()');
  await waitFor("window.__cwTest.shelfTitles().includes('F5甲书')", 8000);

  const metaA = await storage.readBookMeta(pathA);
  const txtAPath = path.join(pathA, metaA.chapters[0].file);
  const shapeOf = (meta) => {
    const copy = { ...meta };
    delete copy.group;
    delete copy.updatedAt;
    return JSON.stringify(copy);
  };

  // ---------- ① 筛选条：两个下拉 + 计数 + 管理入口 ----------
  const groupOptions = await exec('window.__cwTest.shelfGroupOptions()');
  const tagOptions = await exec('window.__cwTest.shelfTagOptions()');
  const findOption = (list, value) => list.find((item) => item.value === value) || null;
  check(
    '书架分组：筛选条出现，分组 / 标签下拉都带计数，且有「管理分组…」入口',
    (await exec('window.__cwTest.shelfGroupBarVisible()')) === true &&
      findOption(groupOptions, GROUP_A)?.label === label(GROUP_A, 1) &&
      findOption(groupOptions, GROUP_B)?.label === label(GROUP_B, 1) &&
      (await exec('window.__cwTest.shelfGroupManageVisible()')) === true &&
      (await exec('window.__cwTest.shelfTagBarVisible()')) === true,
    groupOptions
  );
  check(
    '书架标签：选项带 # 前缀与本数，同一本书里的重复标签只算一次',
    findOption(tagOptions, TAG_X)?.label === `#${TAG_X}（2）` &&
      findOption(tagOptions, TAG_Y)?.label === `#${TAG_Y}（1）`,
    tagOptions
  );

  // a11y 门禁的种子书库没有分组 / 标签，筛选条在那轮里是收起的；这里补量新控件的可聚焦性与目标尺寸
  // （WCAG 2.2 SC 2.5.8 最小 24×24；下拉 / 按钮都用现有造型，不新增颜色）。
  const filterTargets = await exec(`(() => {
    const tag = document.getElementById('shelf-tag-filter');
    const manage = document.getElementById('btn-shelf-group-manage');
    const box = (el) => { const rect = el.getBoundingClientRect(); return { w: Math.round(rect.width), h: Math.round(rect.height) }; };
    return {
      tag: box(tag),
      manage: box(manage),
      tagTabIndex: tag.tabIndex,
      manageTabIndex: manage.tabIndex,
      tagHidden: tag.classList.contains('hidden'),
      manageHidden: manage.classList.contains('hidden')
    };
  })()`);
  check(
    '书架筛选条：标签下拉与「管理分组…」可见、可聚焦，目标尺寸都 ≥24×24',
    filterTargets.tagHidden === false &&
      filterTargets.manageHidden === false &&
      filterTargets.tagTabIndex === 0 &&
      filterTargets.manageTabIndex === 0 &&
      filterTargets.tag.w >= 24 &&
      filterTargets.tag.h >= 24 &&
      filterTargets.manage.w >= 24 &&
      filterTargets.manage.h >= 24,
    filterTargets
  );

  // ---------- ② 分组 / 标签 / 搜索三种筛选的 AND 组合 ----------
  await exec(`window.__cwTest.setShelfGroup(${JSON.stringify(GROUP_A)})`);
  const groupFiltered = await exec('window.__cwTest.shelfFilteredTitles()');
  check(
    '书架分组：选「F5甲组」只显示这一组的书',
    groupFiltered.includes('F5甲书') && !groupFiltered.includes('F5乙书'),
    groupFiltered
  );

  await exec("window.__cwTest.setShelfGroup('')");
  await exec(`window.__cwTest.setShelfTag(${JSON.stringify(TAG_X)})`);
  const tagFiltered = await exec('window.__cwTest.shelfFilteredTitles()');
  check(
    '书架标签：选「#F5标签甲」只显示带这个标签的书',
    tagFiltered.includes('F5甲书') &&
      tagFiltered.includes('F5乙书') &&
      !tagFiltered.includes('F5无组书'),
    tagFiltered
  );

  await exec(`window.__cwTest.setShelfTag(${JSON.stringify(TAG_Y)})`);
  await exec(`window.__cwTest.setShelfGroup(${JSON.stringify(GROUP_B)})`);
  const bothFiltered = await exec('window.__cwTest.shelfFilteredTitles()');
  check('书架筛选：分组与标签是 AND（F5乙组 + #F5标签乙 = 空）', bothFiltered.length === 0, bothFiltered);

  await exec("window.__cwTest.setShelfGroup('')");
  await exec(`window.__cwTest.setShelfTag(${JSON.stringify(TAG_X)})`);
  await exec(`window.__cwTest.setShelfQuery('F5乙书')`);
  const searchAndTag = await exec('window.__cwTest.shelfFilteredTitles()');
  check(
    '书架筛选：搜索与标签是 AND（F5乙书 + #F5标签甲 = 命中）',
    searchAndTag.includes('F5乙书') && !searchAndTag.includes('F5无组书'),
    searchAndTag
  );
  await exec(`window.__cwTest.setShelfQuery('F5无组书')`);
  const searchAndTagMiss = await exec('window.__cwTest.shelfFilteredTitles()');
  check('书架筛选：搜索命中但标签不符 → 不显示', searchAndTagMiss.length === 0, searchAndTagMiss);
  await exec("window.__cwTest.setShelfQuery('')");
  await exec("window.__cwTest.setShelfTag('')");

  // ---------- ③ 存一条书签 + 打开一次，作为「改名只动 meta」的对照 ----------
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(pathA)})`);
  await waitFor(`window.__cwTest.view() === 'editor'`, 8000);
  await exec("window.__cwTest.setText('　　F5正文：分组改名不该动这里。')");
  await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false', 8000);
  await exec('window.__cwTest.openFindPanel()');
  await waitFor('window.__cwTest.findPanelOpen() === true', 4000);
  const bookmarksBeforeAdd = await exec('window.__cwTest.findBookmarks()');
  await exec("window.__cwTest.setFindFields({ query: 'F5正文', scope: 'current', caseSensitive: false })");
  await exec('window.__cwTest.findRun()');
  await waitFor('window.__cwTest.findHighlightCount() === 1', 4000);
  await exec("document.getElementById('btn-find-bookmark').click()");
  await waitFor(
    `window.__cwTest.findBookmarks().length === ${bookmarksBeforeAdd.length + 1}`,
    8000
  );
  const bookmarksAfterAdd = await exec('window.__cwTest.findBookmarks()');
  const bookmarkIndex = bookmarksAfterAdd.findIndex((item) => item.bookPath === pathA);
  check('查找书签：存下来的书签指向这本演练书（后续用它验证改名不失效）', bookmarkIndex >= 0, bookmarksAfterAdd);
  await exec('window.__cwTest.closeFindPanel()');
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");

  const configBefore = await readConfig();
  const bookmarksBefore = JSON.stringify(configBefore.findBookmarks || []);
  const lastBookBefore = JSON.stringify(configBefore.lastBook || null);

  // 「只改书目」的对照基准要取在保存之后（保存本身会改字数 / lastOpenChapterId / updatedAt）：
  // 正文 txt 的字节与 mtime、书目除 group / updatedAt 外的全部字段、书文件夹里的文件清单。
  const metaABaseline = await storage.readBookMeta(pathA);
  const txtABytes = await fs.readFile(txtAPath);
  const txtAStat = await fs.stat(txtAPath);
  const dirABefore = (await fs.readdir(pathA)).sort().join('|');
  const shapeABefore = shapeOf(metaABaseline);

  // ---------- ④ 分组管理 → 改名 ----------
  await exec('window.__cwTest.openGroupManageDialog()');
  await waitFor('window.__cwTest.groupManageOpen() === true', 4000);
  const rows = await exec('window.__cwTest.groupManageRows()');
  check(
    '分组管理：弹层列出分组与本数',
    rows.some((row) => row.group === GROUP_A && row.text.includes('1 本')) &&
      rows.some((row) => row.group === GROUP_B && row.text.includes('1 本')),
    rows
  );

  await exec(`window.__cwTest.clickGroupManageAction(${JSON.stringify(GROUP_A)}, 'rename')`);
  await waitFor('window.__cwTest.modalOpen() === true', 4000);
  check(
    '分组改名：询问框初值 = 旧分组名，管理弹层先收起（不叠两个弹层）',
    (await exec('window.__cwTest.dialog()')) === '重命名分组' &&
      (await exec("document.getElementById('modal-input').value")) === GROUP_A &&
      (await exec('window.__cwTest.groupManageOpen()')) === false
  );
  await exec(`document.getElementById('modal-input').value = ${JSON.stringify(GROUP_C)}`);
  await exec("window.__cwTest.answerModal('ok')");
  await waitFor(
    `window.__cwTest.shelfGroupOptions().some((item) => item.value === ${JSON.stringify(GROUP_C)})`,
    8000
  );

  const optionsAfterRename = await exec('window.__cwTest.shelfGroupOptions()');
  const metaAAfter = await storage.readBookMeta(pathA);
  const txtAAfter = await fs.readFile(txtAPath);
  const txtAStatAfter = await fs.stat(txtAPath);
  const dirAAfter = (await fs.readdir(pathA)).sort().join('|');
  const configAfterRename = await readConfig();
  check(
    '分组改名：选项从 F5甲组（1）变成 F5丙组（1），旧分组消失',
    findOption(optionsAfterRename, GROUP_C)?.label === label(GROUP_C, 1) &&
      !findOption(optionsAfterRename, GROUP_A),
    optionsAfterRename
  );
  check(
    '分组改名：书目只有 group 变（其余字段、正文 txt 字节 / mtime、文件清单都不动）',
    metaAAfter.group === GROUP_C &&
      shapeOf(metaAAfter) === shapeABefore &&
      Buffer.compare(txtAAfter, txtABytes) === 0 &&
      txtAStatAfter.mtimeMs === txtAStat.mtimeMs &&
      dirAAfter === dirABefore,
    { group: metaAAfter.group, dir: dirAAfter === dirABefore, bytes: Buffer.compare(txtAAfter, txtABytes) === 0 }
  );
  check(
    '分组改名：config.json 里的书签与「最近书」不变（只动 meta）',
    JSON.stringify(configAfterRename.findBookmarks || []) === bookmarksBefore &&
      JSON.stringify(configAfterRename.lastBook || null) === lastBookBefore &&
      !('shelfGroup' in configAfterRename) &&
      !('shelfTag' in configAfterRename)
  );

  // 书签仍可用：书签面板只在写作页可用（书已打开才给跳），先打开这本书再跳一次
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(pathA)})`);
  await waitFor(`window.__cwTest.view() === 'editor'`, 8000);
  const bookmarkAfter = (await exec('window.__cwTest.findBookmarks()'))[bookmarkIndex] || {};
  const jumpResult = await exec(`window.__cwTest.findBookmarkJump(${bookmarkIndex})`);
  check(
    '分组改名：旧书签条目原样保留，跳转仍落到原书原章',
    bookmarkAfter.bookPath === pathA &&
      bookmarkAfter.query === 'F5正文' &&
      jumpResult &&
      jumpResult.ok === true &&
      jumpResult.index === 0 &&
      (await exec('window.__cwTest.bookPathValue()')) === pathA
  );
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");

  // ---------- ⑤ 分组管理 → 合并 ----------
  await exec('window.__cwTest.openGroupManageDialog()');
  await waitFor('window.__cwTest.groupManageOpen() === true', 4000);
  await exec(`window.__cwTest.clickGroupManageAction(${JSON.stringify(GROUP_B)}, 'merge')`);
  await waitFor('window.__cwTest.modalOpen() === true', 4000);
  const mergeMessage = await exec('window.__cwTest.modalMessage()');
  check('分组合并：提示里列出已有分组名（方便直接照着填）', mergeMessage.includes(GROUP_C), mergeMessage);
  await exec(`document.getElementById('modal-input').value = ${JSON.stringify(GROUP_C)}`);
  await exec("window.__cwTest.answerModal('ok')");
  await waitFor(
    `window.__cwTest.shelfGroupOptions().some((item) => item.value === ${JSON.stringify(GROUP_C)} && item.label === ${JSON.stringify(
      label(GROUP_C, 2)
    )})`,
    8000
  );
  const optionsAfterMerge = await exec('window.__cwTest.shelfGroupOptions()');
  const metaBAfter = await storage.readBookMeta(pathB);
  check(
    '分组合并：两本书落在同一分组、计数变 2，旧分组从选项里消失',
    metaBAfter.group === GROUP_C && !findOption(optionsAfterMerge, GROUP_B),
    optionsAfterMerge
  );

  // ---------- ⑥ 书卡右键「移到分组…」（单本；1.6.0b 改成菜单内联列表，不再弹询问框） ----------
  const menuTexts = await exec('window.__cwTest.bookMenuTexts()');
  check('移到分组：书卡右键菜单里有「移到分组…」', menuTexts.includes('移到分组…'), menuTexts);
  await exec(`window.__cwTest.openBookMenuForPath(${JSON.stringify(pathC)})`);
  check(
    '移到分组：点一下在菜单里展开分组列表，不弹询问框',
    (await exec('window.__cwTest.bookMenuOpen()')) === true &&
      (await exec(`window.__cwTest.clickBookMenuAction('move-group')`)) === true &&
      (await exec('window.__cwTest.bookGroupChooserOpen()')) === true &&
      (await exec('window.__cwTest.modalOpen()')) === false
  );
  const chooserOptions = await exec('window.__cwTest.bookMenuGroupOptions()');
  const groupOptionC = chooserOptions.find((item) => item.group === GROUP_C) || null;
  const noneOption = chooserOptions.find((item) => item.action === 'move-group-pick' && item.group === '') || null;
  check(
    '移到分组：列表带本数 / 当前分组打勾，另有「未分组」与「新建分组…」',
    groupOptionC?.label === `${GROUP_C} · 2 本` &&
      noneOption?.current === true &&
      /^✓ 未分组 · \d+ 本$/.test(noneOption?.label || '') &&
      chooserOptions.some((item) => item.action === 'move-group-new' && item.label === '新建分组…'),
    chooserOptions
  );
  await exec(`window.__cwTest.clickBookMenuGroup(${JSON.stringify(GROUP_C)})`);
  await waitFor(
    `window.__cwTest.shelfGroupOptions().some((item) => item.value === ${JSON.stringify(GROUP_C)} && item.label === ${JSON.stringify(
      label(GROUP_C, 3)
    )})`,
    8000
  );
  const metaCAfter = await storage.readBookMeta(pathC);
  const cardC = await exec('window.__cwTest.bookCardInfo(' + JSON.stringify(path.basename(pathC)) + ')');
  check(
    '移到分组：点选目标分组只写这一本，书卡上的分组签立刻更新',
    metaCAfter.group === GROUP_C && String((cardC && cardC.tags) || '').includes(GROUP_C),
    { group: metaCAfter.group, card: cardC }
  );

  // 收尾：三本演练书走书架删除（进 _trash），不留可见污染
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  for (const bookPath of created) await deleteBookWithRetry(bookPath);
  await exec('window.__cwTest.refreshShelf()');
  await waitFor("!window.__cwTest.shelfTitles().includes('F5甲书')", 8000);
};