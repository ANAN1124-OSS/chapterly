// E2E 第 48 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：续组 47 的旧书 + 新建「敏感词测试书」
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group48SensitiveWords(t) {
  const { exec, check, waitFor, storage, userData, fileExists } = t;
  const { fragLegacyBookPath } = t.state;

  // 48. 敏感词预检（v0.7-3，提案 5.2）：词表归作者管理、应用不内置词表；只报告、不改动、不写盘
  const sensitiveDir = path.join(userData, '敏感词');
  await fs.mkdir(sensitiveDir, { recursive: true });
  const sensitiveWordsPath = path.join(sensitiveDir, '我的词表.txt');
  await fs.writeFile(sensitiveWordsPath, '色情\r\n暴力\r\n色情\r\n\r\n', 'utf8');
  const sensitiveWordsBytesBefore = await fs.readFile(sensitiveWordsPath);
  const sensitiveWordsStatBefore = await fs.stat(sensitiveWordsPath);

  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const sensitiveSetPath = await exec(
    `window.__cwTest.setSensitiveWordsPath(${JSON.stringify(sensitiveWordsPath)})`
  );
  const sensitiveCfgDisk = JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8'));
  check(
    '敏感词预检：词表路径真的落进 config.json',
    sensitiveSetPath === sensitiveWordsPath && sensitiveCfgDisk.sensitiveWordsPath === sensitiveWordsPath,
    { set: sensitiveSetPath, disk: sensitiveCfgDisk.sensitiveWordsPath }
  );

  await exec('window.__cwTest.openSettings()');
  await waitFor('window.__cwTest.settingsOpen() === true');
  // 词表状态是异步读回来的，等它显示出来再断言
  await waitFor("window.__cwTest.sensitiveSettingsStatus().includes('2 个词')");
  check(
    '敏感词预检：设置里显示词表路径、词数与跳过的重复行',
    (await exec('window.__cwTest.sensitiveSettingsVisible()')) === true &&
      (await exec('window.__cwTest.sensitiveSettingsPath()')) === sensitiveWordsPath &&
      (await exec('window.__cwTest.sensitiveSettingsStatus()')).includes('2 个词') &&
      (await exec('window.__cwTest.sensitiveSettingsStatus()')).includes('1 个重复'),
    await exec('window.__cwTest.sensitiveSettingsStatus()')
  );
  await exec('window.__cwTest.closeSettings()');
  await waitFor('window.__cwTest.settingsOpen() === false');

  // 48b. 当前章预检：命中词、行号列号、上下文；点结果只改选区、不改正文
  await exec("window.__cwTest.newBook('敏感词测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const sensitiveBookPath = await exec('window.__cwTest.bookPathValue()');
  await exec("window.__cwTest.renameChapterAt(0, '起风')");
  const sensitiveChapterOne = '第一行没有。\n第二行有色情和暴力。\n第三行又见色情。';
  await exec(`window.__cwTest.setText(${JSON.stringify(sensitiveChapterOne)})`);
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");
  await exec("window.__cwTest.newChapter('夜雨')");
  await waitFor("window.__cwTest.currentTitle().includes('夜雨')");
  await exec("window.__cwTest.setText('这里只有暴力。')");
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await waitFor("window.__cwTest.currentTitle().includes('起风')");

  // 写作页的「设置」是按书设置：词表是全局的，不该在这里出现
  await exec('window.__cwTest.openSettings()');
  await waitFor('window.__cwTest.settingsOpen() === true');
  check(
    '敏感词预检：写作页的按书设置里不显示全局词表',
    (await exec('window.__cwTest.sensitiveSettingsVisible()')) === false
  );
  await exec('window.__cwTest.closeSettings()');
  await waitFor('window.__cwTest.settingsOpen() === false');

  const sensitiveMetaBefore = await storage.readBookMeta(sensitiveBookPath);
  const sensitiveChaptersBefore = JSON.stringify(sensitiveMetaBefore.chapters);
  const sensitiveStatsBefore = [];
  for (const chapter of sensitiveMetaBefore.chapters) {
    const stat = await fs.stat(path.join(sensitiveBookPath, chapter.file));
    sensitiveStatsBefore.push({ file: chapter.file, size: stat.size, mtimeMs: stat.mtimeMs });
  }

  check(
    '敏感词预检：导出菜单里有「敏感词预检…」入口',
    (await exec('window.__cwTest.exportMenuTexts()')).includes('敏感词预检…')
  );
  await exec(
    "document.getElementById('btn-export').click(); document.querySelector('#export-menu button[data-action=\"sensitive\"]').click()"
  );
  await waitFor("window.__cwTest.sensitivePanelOpen() === true");
  await waitFor("window.__cwTest.sensitiveSummary().includes('本章命中 3 处')");
  const sensitiveCurrent = await exec('window.__cwTest.sensitivePayload()');
  check(
    '敏感词预检：打开面板自动检查当前章（3 处、2 个词、词表 2 个词）',
    sensitiveCurrent &&
      sensitiveCurrent.ok === true &&
      sensitiveCurrent.scope === 'current' &&
      sensitiveCurrent.total === 3 &&
      sensitiveCurrent.wordHitCount === 2 &&
      JSON.stringify(sensitiveCurrent.byWord.map((item) => [item.word, item.count])) ===
        JSON.stringify([
          ['色情', 2],
          ['暴力', 1]
        ]) &&
      (await exec('window.__cwTest.sensitiveWordListText()')).includes('2 个词') &&
      (await exec('window.__cwTest.sensitiveRowCount()')) === 3,
    sensitiveCurrent
  );
  const sensitiveRowTexts = await exec('window.__cwTest.sensitiveRowTexts()');
  check(
    '敏感词预检：结果行带命中词、行号列号与上下文',
    sensitiveRowTexts[0].includes('「色情」') &&
      sensitiveRowTexts[0].includes('第 2 行 · 第 5 字') &&
      sensitiveRowTexts[0].includes('第二行有') &&
      (await exec('window.__cwTest.sensitiveWordTexts()')).join(',') === '「色情」,「暴力」,「色情」',
    sensitiveRowTexts[0]
  );
  check(
    '敏感词预检：渲染层只拿词表数量，不拿词表内容',
    sensitiveCurrent.wordList &&
      sensitiveCurrent.wordList.count === 2 &&
      sensitiveCurrent.wordList.words === undefined
  );
  await exec('window.__cwTest.clickSensitiveRow(0)');
  await waitFor('window.__cwTest.sensitivePanelOpen() === false');
  check(
    '敏感词预检：点结果定位到命中位置（只选中，不改正文）',
    (await exec('window.__cwTest.selectionText()')) === '色情' &&
      (await exec('window.__cwTest.selection()')).start === 11 &&
      (await exec('window.__cwTest.dirty()')) === false
  );
  const sensitiveStatsAfterCurrent = [];
  for (const item of sensitiveStatsBefore) {
    const stat = await fs.stat(path.join(sensitiveBookPath, item.file));
    sensitiveStatsAfterCurrent.push({ file: item.file, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  check(
    '敏感词预检：当前章扫描只读（txt 大小+mtime、书目、无 _trash 都没变）',
    JSON.stringify(sensitiveStatsAfterCurrent) === JSON.stringify(sensitiveStatsBefore) &&
      JSON.stringify((await storage.readBookMeta(sensitiveBookPath)).chapters) === sensitiveChaptersBefore &&
      !(await fileExists(path.join(sensitiveBookPath, '_trash')))
  );

  // 48c. 整本预检：跨章命中、带章名；点第 2 章的结果会切章并选中
  await exec('window.__cwTest.openSensitivePanel()');
  await waitFor("window.__cwTest.sensitiveSummary().includes('本章命中 3 处')");
  await exec("window.__cwTest.setSensitiveScope('book')");
  const sensitiveBookRun = await exec('window.__cwTest.sensitiveRun()');
  const sensitiveBookPayload = await exec('window.__cwTest.sensitivePayload()');
  check(
    '敏感词预检：整本命中 4 处、涉及 2 章、2 个词',
    sensitiveBookRun &&
      sensitiveBookRun.ok === true &&
      sensitiveBookPayload.scope === 'book' &&
      sensitiveBookPayload.total === 4 &&
      sensitiveBookPayload.chapterCount === 2 &&
      sensitiveBookPayload.chapterHitCount === 2 &&
      sensitiveBookPayload.wordHitCount === 2 &&
      (await exec('window.__cwTest.sensitiveSummary()')).includes(
        '全书 2 章命中 4 处，涉及 2 章、2 个词'
      ),
    sensitiveBookPayload
  );
  const sensitiveBookRows = await exec('window.__cwTest.sensitiveRowTexts()');
  check(
    '敏感词预检：整本结果带章名（第1章 3 条 / 第2章 1 条）',
    sensitiveBookRows.filter((text) => text.includes('第1章：起风')).length === 3 &&
      sensitiveBookRows.filter((text) => text.includes('第2章：夜雨')).length === 1,
    sensitiveBookRows
  );
  const sensitiveNightIndex = sensitiveBookPayload.matches.findIndex((match) => match.chapterIndex === 1);
  check('敏感词预检：整本结果里能找到第 2 章的命中', sensitiveNightIndex >= 0, sensitiveNightIndex);
  await exec(`window.__cwTest.clickSensitiveRow(${sensitiveNightIndex})`);
  await waitFor("window.__cwTest.currentTitle().includes('夜雨')");
  await waitFor('window.__cwTest.sensitivePanelOpen() === false');
  // 同上（校对词表那一处）：标题与面板先到位，选词要等 loadChapterAt 的异步收尾，
  // 等选区真的变成「暴力」再断言（等不到照样红）。实测改前读到的是选区还停在末尾的中间态（7,7）。
  await waitFor("window.__cwTest.selectionText() === '暴力'", 5000);
  const sensitiveSecondSelection = {
    selection: await exec('window.__cwTest.selection()'),
    selectionText: await exec('window.__cwTest.selectionText()'),
    title: await exec('window.__cwTest.currentTitle()')
  };
  check(
    '敏感词预检：点整本结果会切章并选中命中的词',
    sensitiveSecondSelection.selectionText === '暴力' &&
      sensitiveSecondSelection.title.includes('夜雨'),
    sensitiveSecondSelection
  );

  // 48d. 当前章未保存的内容参与检查，但绝不写盘
  await exec("window.__cwTest.setText('这里只有暴力。另外加了色情。')");
  check('敏感词预检：先制造未保存修改', (await exec('window.__cwTest.dirty()')) === true);
  await exec("window.__cwTest.setSensitiveScope('current')");
  await exec('window.__cwTest.openSensitivePanel()');
  await waitFor("window.__cwTest.sensitiveSummary().includes('本章命中 2 处')");
  const sensitiveUnsaved = await exec('window.__cwTest.sensitivePayload()');
  const sensitiveDiskDuringUnsaved = await fs.readFile(
    path.join(sensitiveBookPath, sensitiveMetaBefore.chapters[1].file),
    'utf8'
  );
  check(
    '敏感词预检：未保存的内容参与检查，但磁盘正文没变',
    sensitiveUnsaved.total === 2 && sensitiveDiskDuringUnsaved === '这里只有暴力。'
  );
  await exec('window.__cwTest.closeSensitivePanel()');
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await waitFor("window.__cwTest.currentTitle().includes('起风')");
  await exec("window.__cwTest.switchTo(1, 'discard')");
  await waitFor("window.__cwTest.currentTitle().includes('夜雨')");
  check(
    '敏感词预检：丢弃未保存内容后读到磁盘旧正文',
    (await exec('window.__cwTest.text()')) === '这里只有暴力。'
  );

  // 48e. 词表出问题要说清楚（不存在 / 编码异常 / 空词表），应用照常可用
  const sensitiveMovedPath = `${sensitiveWordsPath}.moved`;
  await fs.rename(sensitiveWordsPath, sensitiveMovedPath);
  await exec('window.__cwTest.openSensitivePanel()');
  await waitFor("window.__cwTest.sensitiveSummary().includes('词表文件不存在')");
  check(
    '敏感词预检：词表文件不存在时明确提示，不误报',
    (await exec('window.__cwTest.sensitiveRowCount()')) === 0 &&
      (await exec('window.__cwTest.sensitiveWordListText()')).includes('不存在') &&
      (await exec('window.__cwTest.sensitivePayload()')) === null
  );
  await exec('window.__cwTest.closeSensitivePanel()');
  await fs.rename(sensitiveMovedPath, sensitiveWordsPath);

  const sensitiveBadPath = path.join(sensitiveDir, '伪装词表.txt');
  await fs.writeFile(sensitiveBadPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]));
  await exec(`window.__cwTest.setSensitiveWordsPath(${JSON.stringify(sensitiveBadPath)})`);
  await exec('window.__cwTest.openSensitivePanel()');
  await waitFor("window.__cwTest.sensitiveSummary().includes('不像是纯文本')");
  check(
    '敏感词预检：词表编码异常（二进制）有明确提示',
    (await exec('window.__cwTest.sensitiveRowCount()')) === 0 &&
      (await exec('window.__cwTest.sensitiveWordListText()')).includes('UTF-8')
  );
  await exec('window.__cwTest.closeSensitivePanel()');

  const sensitiveEmptyPath = path.join(sensitiveDir, '空词表.txt');
  await fs.writeFile(sensitiveEmptyPath, '\r\n\r\n   \r\n', 'utf8');
  await exec(`window.__cwTest.setSensitiveWordsPath(${JSON.stringify(sensitiveEmptyPath)})`);
  await exec('window.__cwTest.openSensitivePanel()');
  await waitFor("window.__cwTest.sensitiveSummary().includes('没有有效的词')");
  check(
    '敏感词预检：空词表有明确提示',
    (await exec('window.__cwTest.sensitiveRowCount()')) === 0
  );
  await exec('window.__cwTest.closeSensitivePanel()');
  // 恢复成可用词表，并确认配置也跟着恢复
  await exec(`window.__cwTest.setSensitiveWordsPath(${JSON.stringify(sensitiveWordsPath)})`);
  const sensitiveCfgAfter = JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8'));
  const sensitiveWordsBytesAfter = await fs.readFile(sensitiveWordsPath);
  const sensitiveWordsStatAfter = await fs.stat(sensitiveWordsPath);
  check(
    '敏感词预检：词表文件只读（字节与修改时间都没变），配置路径恢复',
    sensitiveWordsBytesAfter.equals(sensitiveWordsBytesBefore) &&
      sensitiveWordsStatAfter.mtimeMs === sensitiveWordsStatBefore.mtimeMs &&
      sensitiveCfgAfter.sensitiveWordsPath === sensitiveWordsPath
  );

  // 48f. 旧数据兼容：v0.4.1 形状的书（没有 schemaVersion）照常预检，书目不被补字段
  const sensitiveLegacyMetaPath = path.join(fragLegacyBookPath, '书目.json');
  const sensitiveLegacyBefore = await fs.readFile(sensitiveLegacyMetaPath, 'utf8');
  await exec('window.__cwTest.backToShelf()');
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(fragLegacyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec('window.__cwTest.openSensitivePanel()');
  await waitFor("window.__cwTest.sensitiveSummary().includes('本章没有命中')");
  const sensitiveLegacyAfter = await fs.readFile(sensitiveLegacyMetaPath, 'utf8');
  check(
    '敏感词预检：没有 schemaVersion 的旧书照常预检，书目不被补字段',
    sensitiveLegacyAfter === sensitiveLegacyBefore &&
      sensitiveLegacyAfter.includes('"schemaVersion"') === false &&
      (await exec('window.__cwTest.sensitivePayload()')).total === 0
  );

  // 48g. Esc 关闭面板
  await exec('window.__cwTest.openSensitivePanel()');
  await waitFor('window.__cwTest.sensitivePanelOpen() === true');
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  check(
    '敏感词预检：Esc 关闭面板',
    (await exec('window.__cwTest.sensitivePanelOpen()')) === false
  );
};
