// E2E 第 28 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：续「拖拽排序书」（全书查找 / 整本替换）
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group28FindReplace(t) {
  const { exec, check, waitFor, sleep, storage } = t;
  const { sortBookPath } = t.state;

  // 28. 全书查找 / 替换（替换前自动备份原章节）
  await exec('window.__cwTest.switchTo(0, "discard")');
  await exec("window.__cwTest.setText('阿明走进屋里。\\n阿明坐下。')");
  await exec('window.__cwTest.save()');
  await exec('window.__cwTest.switchTo(1, "discard")');
  await exec("window.__cwTest.setText('这里没有那个人。')");
  await exec('window.__cwTest.save()');
  await exec('window.__cwTest.switchTo(2, "discard")');
  await exec("window.__cwTest.setText('阿明抬头看了看天。')");
  await exec('window.__cwTest.save()');

  await exec('window.__cwTest.openFindPanel()');
  check('Ctrl+F /「查找」按钮能打开查找面板', (await exec('window.__cwTest.findPanelOpen()')) === true);
  await exec("window.__cwTest.setFindFields({ query: '阿明', replacement: '小明', scope: 'book' })");
  await exec('window.__cwTest.findRun()');
  await waitFor("window.__cwTest.findSummary().includes('整本命中')");
  check(
    '全书查找：命中数与章节数正确',
    (await exec('window.__cwTest.findSummary()')).includes('整本命中 3 处，分布在 2 章'),
    await exec('window.__cwTest.findSummary()')
  );
  check('全书查找：结果列表按章列出', (await exec('window.__cwTest.findResultCount()')) === 2);

  await exec('window.__cwTest.clickFindResult(1)');
  await waitFor('window.__cwTest.currentIndex() === 2');
  check('点击结果能跳到那一章', (await exec('window.__cwTest.currentIndex()')) === 2);
  await sleep(200);
  const selectionAfterJump = await exec('window.__cwTest.state.index');
  check('跳转后仍停在该章（没有被点击误切走）', selectionAfterJump === 2);

  // 当前章替换：只改编辑区，不写盘
  await exec('window.__cwTest.switchTo(0, "discard")');
  await exec('window.__cwTest.openFindPanel()');
  await exec("window.__cwTest.setFindFields({ query: '阿明', replacement: '小明', scope: 'current' })");
  await exec('window.__cwTest.findReplaceAll()');
  await sleep(300);
  check(
    '当前章替换：编辑区已改',
    (await exec('window.__cwTest.text()')) === '小明走进屋里。\n小明坐下。'
  );
  check('当前章替换：仍是未保存状态', (await exec('window.__cwTest.dirty()')) === true);
  check(
    '当前章替换：磁盘上还是旧内容',
    (await exec('window.__cwTest.chapterTextAt(0)')) === '阿明走进屋里。\n阿明坐下。'
  );
  await exec('window.__cwTest.save()');
  await exec('window.__cwTest.closeFindPanel()');

  // 恢复成含「阿明」的原文，再测整本替换
  await exec('window.__cwTest.switchTo(0, "discard")');
  await exec("window.__cwTest.setText('阿明走进屋里。\\n阿明坐下。')");
  await exec('window.__cwTest.save()');

  await exec('window.__cwTest.openFindPanel()');
  await exec("window.__cwTest.setFindFields({ query: '阿明', replacement: '小明', scope: 'book' })");
  const replacePromise = exec('window.__cwTest.findReplaceAll()');
  await waitFor('window.__cwTest.modalOpen()');
  check('整本替换会先弹确认框', (await exec('window.__cwTest.dialog()')) === '整本替换确认');
  await exec("window.__cwTest.answerModal('ok')");
  await replacePromise;
  await waitFor("window.__cwTest.findPanelOpen() === false", 15000);
  await sleep(400);

  const replacedMeta = await storage.readBookMeta(sortBookPath);
  const replacedText0 = await storage.loadChapterText(sortBookPath, replacedMeta.chapters[0].file);
  const replacedText1 = await storage.loadChapterText(sortBookPath, replacedMeta.chapters[1].file);
  const replacedText2 = await storage.loadChapterText(sortBookPath, replacedMeta.chapters[2].file);
  check(
    '整本替换：命中章节已改写',
    replacedText0.text === '小明走进屋里。\n小明坐下。' && replacedText2.text === '小明抬头看了看天。',
    { replacedText0: replacedText0.text, replacedText2: replacedText2.text }
  );
  check('整本替换：没有命中的章节原样不动', replacedText1.text === '这里没有那个人。');
  check(
    '整本替换：字数缓存已更新',
    replacedMeta.chapters[0].chars === 12 && replacedMeta.chapters[2].chars === 9,
    replacedMeta.chapters.map((c) => c.chars)
  );
  const trashEntries = await fs.readdir(path.join(sortBookPath, '_trash')).catch(() => []);
  const backupName = trashEntries.find((name) => name.startsWith('替换备份-'));
  check('整本替换：原文已备份到书内 _trash', Boolean(backupName), trashEntries);
  const backupText = await fs.readFile(path.join(sortBookPath, '_trash', backupName, replacedMeta.chapters[0].file), 'utf8');
  check('整本替换：备份里是替换前的原文', backupText === '阿明走进屋里。\r\n阿明坐下。', backupText);
  check(
    '整本替换：当前章已从磁盘重新载入',
    (await exec('window.__cwTest.text()')) === '小明走进屋里。\n小明坐下。'
  );
};
