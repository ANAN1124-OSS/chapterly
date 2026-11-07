// E2E 第 34 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：新建「显示测试A」「显示测试B」（两本互切）
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。

module.exports = async function group34PerBookDisplay(t) {
  const { exec, check, waitFor, sleep } = t;

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
};
