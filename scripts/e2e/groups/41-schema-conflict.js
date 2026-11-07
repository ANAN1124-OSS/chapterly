// E2E 第 41 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：新建「冲突检测测试书」
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group41SchemaConflict(t) {
  const { exec, check, waitFor, storage } = t;

  // 41. 书目 schemaVersion + 同步冲突副本检测（v0.5-5）
  await exec("window.__cwTest.newBook('冲突检测测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const conflictBookPath = await exec('window.__cwTest.bookPathValue()');
  const conflictMetaPath = path.join(conflictBookPath, '书目.json');
  await exec("window.__cwTest.renameChapterAt(0, '起风')");
  await exec("window.__cwTest.setText('起风正文。')");
  await exec('window.__cwTest.save()');
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");

  // 41a. 新建书的书目落盘带当前格式版本
  const conflictMetaRaw = JSON.parse(await fs.readFile(conflictMetaPath, 'utf8'));
  check(
    'schemaVersion：新建书的书目带 schemaVersion=1',
    conflictMetaRaw.schemaVersion === 1,
    conflictMetaRaw.schemaVersion
  );

  // 41b. 模拟同步盘在书文件夹里生成冲突副本（OneDrive 英文名 + 坚果云中文名）
  const conflictNormalFile = path.join(conflictBookPath, conflictMetaRaw.chapters[0].file);
  const conflictNormalStat = await fs.stat(conflictNormalFile);
  const conflictNames = [
    '001-未命名 (conflicted copy 2026-10-31).txt',
    '书目-冲突副本.json'
  ];
  await fs.writeFile(path.join(conflictBookPath, conflictNames[0]), '冲突副本里的旧稿。', 'utf8');
  await fs.writeFile(path.join(conflictBookPath, conflictNames[1]), '{"chapters":[]}', 'utf8');
  const conflictStats = [];
  for (const name of conflictNames) {
    const stat = await fs.stat(path.join(conflictBookPath, name));
    conflictStats.push({ size: stat.size, mtimeMs: stat.mtimeMs });
  }

  await exec('window.__cwTest.refreshShelf()');
  const conflictBadge = await waitFor("window.__cwTest.shelfConflictBadgeText('冲突检测测试书')");
  check(
    '冲突副本：书卡标黄提示 2 个同步冲突副本',
    conflictBadge.includes('检测到同步冲突副本') && conflictBadge.includes('2'),
    conflictBadge
  );
  check(
    '冲突副本：书卡带 has-conflict 标记、没被当成损坏',
    (await exec("window.__cwTest.conflictCardHasClass('冲突检测测试书', 'has-conflict')")) === true &&
      (await exec("window.__cwTest.conflictCardHasClass('冲突检测测试书', 'corrupt')")) === false
  );

  // 冲突副本不能变成章节，也不能妨碍正常打开
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(conflictBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  check(
    '冲突副本：打开书后章节仍是 1 章（副本没有被读成章节）',
    JSON.stringify(await exec('window.__cwTest.chapterNames()')) === JSON.stringify(['起风'])
  );
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");

  // 41c. 点提示看明细：列出文件名、明确不自动合并；Esc 关闭
  const conflictOpened = await exec("window.__cwTest.openConflictDialogFor('冲突检测测试书')");
  check(
    '冲突副本：点提示能打开明细弹层',
    conflictOpened === true && (await exec('window.__cwTest.conflictDialogOpen()')) === true
  );
  const conflictDialogFiles = await exec('window.__cwTest.conflictFileTexts()');
  check(
    '冲突副本：明细弹层列出两个副本文件名',
    conflictDialogFiles.length === 2 && conflictNames.every((name) => conflictDialogFiles.includes(name)),
    conflictDialogFiles
  );
  const conflictDialogSummary = await exec('window.__cwTest.conflictSummary()');
  check(
    '冲突副本：弹层明确「只提示、不自动合并或删除」',
    conflictDialogSummary.includes('不会自动合并') && conflictDialogSummary.includes('2'),
    conflictDialogSummary
  );
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  check('冲突副本：Esc 关闭明细弹层', (await exec('window.__cwTest.conflictDialogOpen()')) === false);

  // 41d. 全程只读：冲突文件、正常章节 txt、书目 chapters 都没被改动
  let conflictFilesUntouched = true;
  for (let i = 0; i < conflictNames.length; i += 1) {
    const stat = await fs.stat(path.join(conflictBookPath, conflictNames[i]));
    if (stat.size !== conflictStats[i].size || stat.mtimeMs !== conflictStats[i].mtimeMs) {
      conflictFilesUntouched = false;
    }
  }
  const conflictNormalAfter = await fs.stat(conflictNormalFile);
  const conflictMetaAfter = await storage.readBookMeta(conflictBookPath);
  check(
    '冲突副本：提示全程没有改动/删除副本文件，也没有动章节 txt',
    conflictFilesUntouched &&
      conflictNormalAfter.size === conflictNormalStat.size &&
      conflictNormalAfter.mtimeMs === conflictNormalStat.mtimeMs &&
      conflictMetaAfter.chapters.length === 1 &&
      conflictMetaAfter.chapters[0].file === conflictMetaRaw.chapters[0].file &&
      (await fs.readFile(path.join(conflictBookPath, conflictNames[0]), 'utf8')) === '冲突副本里的旧稿。'
  );

  // 41e. 手动把副本移走后，提示自动消失
  for (const name of conflictNames) await fs.unlink(path.join(conflictBookPath, name));
  await exec('window.__cwTest.refreshShelf()');
  check(
    '冲突副本：手动移走后书卡提示消失',
    (await exec("window.__cwTest.shelfConflictBadgeText('冲突检测测试书')")) === ''
  );

  // 41f. 旧书兼容：v0.4.1 形状（没有 schemaVersion）照常读、写盘才补
  const conflictLegacyRaw = JSON.parse(await fs.readFile(conflictMetaPath, 'utf8'));
  delete conflictLegacyRaw.schemaVersion;
  await fs.writeFile(conflictMetaPath, JSON.stringify(conflictLegacyRaw, null, 2), 'utf8');
  const conflictLegacyRead = await storage.readBookMeta(conflictBookPath);
  check(
    '旧书目兼容：没有 schemaVersion 也能读，内存里按 1 处理',
    conflictLegacyRead.schemaVersion === 1 && conflictLegacyRead.chapters.length === 1,
    conflictLegacyRead.schemaVersion
  );
  await exec('window.__cwTest.refreshShelf()');
  check(
    '旧书目兼容：书架照常显示这本书（不标损坏）',
    (await exec("window.__cwTest.conflictCardHasClass('冲突检测测试书', 'corrupt')")) === false
  );
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(conflictBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  check(
    '旧书目兼容：打开后章节正常',
    (await exec('window.__cwTest.currentTitle()')).includes('起风')
  );
  await exec("window.__cwTest.renameChapterAt(0, '起风改名')");
  const conflictMigratedRaw = JSON.parse(await fs.readFile(conflictMetaPath, 'utf8'));
  check(
    '旧书目兼容：正常写盘后补上 schemaVersion=1，章名改动照常生效',
    conflictMigratedRaw.schemaVersion === 1 && conflictMigratedRaw.chapters[0].name === '起风改名',
    { version: conflictMigratedRaw.schemaVersion, name: conflictMigratedRaw.chapters[0].name }
  );
};
