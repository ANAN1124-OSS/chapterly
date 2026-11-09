// E2E 第 30 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：续「拖拽排序书」（替换备份还原）
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group30ReplaceBackup(t) {
  const { exec, check, waitFor, sleep, storage } = t;
  const { sortBookPath } = t.state;

  // 30. 整本替换的备份还原：列出备份 → 二次确认 → 正文回到替换前（当前内容再备份一份）
  await exec('window.__cwTest.openFindPanel()');
  const backups = await exec('window.__cwTest.refreshReplaceBackups()');
  check(
    '替换备份：查找面板能列出最近一次整本替换的备份',
    Array.isArray(backups) && backups.length >= 1 && backups[0].fileCount === 2,
    backups && backups.map((item) => ({ name: item.name, fileCount: item.fileCount }))
  );
  // 1.4.0 P0-2（撤销优先于确认）：还原到替换前不再弹二次确认 —— 直接还原（还原前照旧再备份一份），
  // 10 秒内可撤销。
  const restoreResult = await exec('window.__cwTest.restoreReplaceBackupFlow()');
  check('替换备份：还原不再弹确认框（直接执行）', (await exec('window.__cwTest.modalOpen()')) === false);
  check(
    '替换备份：还原后出现 10 秒撤销条',
    (await exec("!document.getElementById('undo-bar').classList.contains('hidden')")) === true
  );
  check('替换备份：还原成功', restoreResult && restoreResult.ok === true, restoreResult);
  await sleep(300);
  const restoredMeta = await storage.readBookMeta(sortBookPath);
  const restoredText0 = (await storage.loadChapterText(sortBookPath, restoredMeta.chapters[0].file)).text;
  const restoredText2 = (await storage.loadChapterText(sortBookPath, restoredMeta.chapters[2].file)).text;
  check('替换备份：正文回到替换前', restoredText0 === '阿明走进屋里。\n阿明坐下。', restoredText0);
  check('替换备份：其他命中章节也回到替换前', restoredText2 === '阿明抬头看了看天。', restoredText2);
  const trashAfterRestore = await fs.readdir(path.join(sortBookPath, '_trash'));
  check(
    '替换备份：还原前把当前内容又备份了一份',
    trashAfterRestore.some((name) => name.startsWith('还原前备份-')),
    trashAfterRestore
  );
  check(
    '替换备份：字数缓存已按还原后的正文更新',
    restoredMeta.chapters[0].chars === 12 && restoredMeta.chapters[2].chars === 9,
    restoredMeta.chapters.map((chapter) => chapter.chars)
  );
  check(
    '替换备份：编辑器已从磁盘重新载入',
    (await exec('window.__cwTest.text()')) === '阿明走进屋里。\n阿明坐下。'
  );
  check(
    '替换备份：原备份还在，可以重复还原',
    (await exec('window.__cwTest.replaceBackups()')).length === 1
  );
  await exec('window.__cwTest.closeFindPanel()');
};
