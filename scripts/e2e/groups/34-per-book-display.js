// E2E 第 34 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：新建「显示测试A」「显示测试B」（两本互切）
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group34PerBookDisplay(t) {
  const { exec, check, waitFor, sleep, userData } = t;

  // 34. 按书记忆显示设置：两本书互不影响，恢复默认回全局
  await exec("window.__cwTest.newBook('显示测试A')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const bookAPath = await exec('window.__cwTest.state.bookPath');
  const bookAId = await exec('window.__cwTest.bookId()');
  await exec("window.__cwTest.applyDisplayPreset('loose')");
  await exec('window.__cwTest.persistSidebarWidth(410)');
  await sleep(300);
  const aDisplay = await exec(
    `window.api.getBookDisplay(${JSON.stringify(bookAId)}).then((r) => (r.ok ? r.data : null))`
  );
  check(
    '按书记忆：A 书预设与章节栏宽度都记到 A',
    Boolean(aDisplay) && aDisplay.editorLineHeight === 2.4 && aDisplay.editorSidebarWidth === 410,
    aDisplay
  );
  check('按书记忆：A 书宽度应用到页面', (await exec('window.__cwTest.sidebarWidth()')) === 410);

  await exec("window.__cwTest.newBook('显示测试B')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const bookBPath = await exec('window.__cwTest.bookPathValue()');
  const bookBId = await exec('window.__cwTest.bookId()');
  await sleep(300);
  const bDisplay = await exec(
    `window.api.getBookDisplay(${JSON.stringify(bookBId)}).then((r) => (r.ok ? r.data : null))`
  );
  const bStyle = await exec('window.__cwTest.displayStyle()');
  check('按书记忆：B 书没有单独设置', Boolean(bDisplay) && Object.keys(bDisplay).length === 0, bDisplay);
  check(
    '按书记忆：B 书用全局行距',
    Math.abs(parseFloat(bStyle.lineHeight) - 18 * 1.95) <= 1.5,
    bStyle.lineHeight
  );
  check('按书记忆：B 书章节栏回到全局宽度', (await exec('window.__cwTest.sidebarWidth()')) === 250);

  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookAPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await sleep(300);
  const aStyleAgain = await exec('window.__cwTest.displayStyle()');
  check(
    '按书记忆：重新打开 A 还是 A 自己的行距',
    Math.abs(parseFloat(aStyleAgain.lineHeight) - 18 * 2.4) <= 1.5,
    aStyleAgain.lineHeight
  );
  check(
    '按书记忆：重新打开 A 还是 A 自己的章节栏宽度',
    (await exec('window.__cwTest.sidebarWidth()')) === 410
  );

  await exec('window.__cwTest.openSettings()');
  check('按书记忆：A 书设置作用域是 book', (await exec('window.__cwTest.settingsScope()')) === 'book');
  check(
    '按书记忆：有单独设置时显示「恢复本书默认」',
    (await exec("document.getElementById('btn-reset-book-display').classList.contains('hidden')")) === false
  );
  await exec("document.getElementById('btn-reset-book-display').click()");
  await sleep(300);
  const aAfterReset = await exec(
    `window.api.getBookDisplay(${JSON.stringify(bookAId)}).then((r) => (r.ok ? r.data : null))`
  );
  check(
    '按书记忆：恢复默认清空 A 的覆盖',
    Boolean(aAfterReset) && Object.keys(aAfterReset).length === 0,
    aAfterReset
  );
  check(
    '按书记忆：恢复后 A 回到全局行距',
    Math.abs(parseFloat((await exec('window.__cwTest.displayStyle()')).lineHeight) - 18 * 1.95) <= 1.5
  );
  await exec('window.__cwTest.closeSettings()');
  const cfgOnDisk = await exec('window.api.getConfig().then((r) => (r.ok ? r.data : null))');
  check(
    '按书记忆：设置落进 config.json（重启也能保持）',
    Boolean(cfgOnDisk.bookDisplay) &&
      Object.keys(cfgOnDisk.bookDisplay).length > 0 &&
      !cfgOnDisk.bookDisplay[bookAId],
    cfgOnDisk.bookDisplay && Object.keys(cfgOnDisk.bookDisplay)
  );

  // 34b. 超长段落阈值按书覆盖（1.1.0）：A 书改 620 → 显示菜单文案用本书值；B 书回落全局 500；
  // 切回 A 仍是 620；config.json 只多 bookDisplay[A] 的显示表单字段，全局默认 / 书目一个字节没动。
  const thresholdMenuText = () => exec("document.getElementById('format-long-para').textContent");
  const thresholdConfigPath = path.join(userData, 'config.json');
  const readThresholdConfig = async () => JSON.parse(await fs.readFile(thresholdConfigPath, 'utf8'));
  const aMetaBefore = await fs.readFile(path.join(bookAPath, '书目.json'), 'utf8');
  check(
    '超长段落阈值：没设置过的 A 书显示菜单阈值 500',
    (await thresholdMenuText()) === '超长段落提示（>500 字左侧黄线）'
  );

  await exec('window.__cwTest.openSettings()');
  await waitFor("window.__cwTest.settingsScope() === 'book'");
  check(
    '超长段落阈值：设置里按书回填全局默认 500，并提示只影响这本书',
    (await exec("document.getElementById('settings-long-para-threshold').value")) === '500' &&
      (await exec("document.getElementById('settings-long-para-hint').textContent")).includes('只影响这本书')
  );
  const thresholdConfigBefore = await readThresholdConfig();
  await exec("document.getElementById('settings-long-para-threshold').value = '620'");
  await exec("document.getElementById('btn-settings-save').click()");
  await waitFor('window.__cwTest.bookDisplay().longParagraphThreshold === 620');
  check(
    '超长段落阈值：A 书设置 620 后显示菜单换成本书值',
    (await thresholdMenuText()) === '超长段落提示（>620 字左侧黄线）'
  );

  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookBPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await waitFor(`window.__cwTest.bookId() === ${JSON.stringify(bookBId)}`);
  check(
    '超长段落阈值：切到没设置过的 B 书回落全局 500',
    (await thresholdMenuText()) === '超长段落提示（>500 字左侧黄线）' &&
      !(await exec('window.__cwTest.bookDisplay()')).longParagraphThreshold
  );

  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookAPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await waitFor(`window.__cwTest.bookId() === ${JSON.stringify(bookAId)}`);
  check(
    '超长段落阈值：切回 A 书仍是本书的 620',
    (await thresholdMenuText()) === '超长段落提示（>620 字左侧黄线）'
  );

  const thresholdConfigAfter = await readThresholdConfig();
  const aThresholdEntry = (thresholdConfigAfter.bookDisplay || {})[bookAId] || null;
  const displayKeys = [
    'caretParagraph', 'caretParagraphColor', 'editorCustomFontName', 'editorCustomFontPath',
    'editorFont', 'editorFontSize', 'editorLetterSpacing', 'editorLineHeight', 'editorPaddingX',
    'editorPageWidth', 'editorPaper', 'longParagraphThreshold'
  ];
  const baseWithoutBook = (cfg, bookId) => {
    const copy = { ...cfg };
    delete copy.lastBook;
    const display = { ...(copy.bookDisplay || {}) };
    delete display[bookId];
    copy.bookDisplay = display;
    return copy;
  };
  check(
    '超长段落阈值：config 只多 bookDisplay[A] 的显示表单字段（longParagraphThreshold=620），全局默认仍是 500',
    Boolean(aThresholdEntry) &&
      aThresholdEntry.longParagraphThreshold === 620 &&
      JSON.stringify(Object.keys(aThresholdEntry).sort()) === JSON.stringify(displayKeys.slice().sort()) &&
      thresholdConfigAfter.longParagraphThreshold === 500 &&
      JSON.stringify(baseWithoutBook(thresholdConfigBefore, bookAId)) ===
        JSON.stringify(baseWithoutBook(thresholdConfigAfter, bookAId))
  );
  check(
    '超长段落阈值：改阈值只写 config.json，书目 / 章节文件一个字节没变',
    (await fs.readFile(path.join(bookAPath, '书目.json'), 'utf8')) === aMetaBefore
  );

  // 收尾：恢复 A 的本书默认（清掉这次覆盖），B 本来就没有覆盖；两本书留给后续组（与改动前一致）
  await exec('window.__cwTest.openSettings()');
  await waitFor("window.__cwTest.settingsScope() === 'book'");
  await exec("document.getElementById('btn-reset-book-display').click()");
  await sleep(300);
  check(
    '超长段落阈值：恢复本书默认后 A 回到全局 500，bookDisplay 里不再有 A',
    (await thresholdMenuText()) === '超长段落提示（>500 字左侧黄线）' &&
      !(await readThresholdConfig()).bookDisplay[bookAId]
  );
  await exec('window.__cwTest.closeSettings()');
};
