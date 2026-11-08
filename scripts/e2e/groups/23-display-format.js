// E2E 第 23 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：回书架再按 currentBookDir 重开「章节小说 - 作者」
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。

module.exports = async function group23DisplayFormat(t) {
  const { exec, check, waitFor, sleep } = t;
  const { currentBookDir, formattedText } = t.state;

  // 23. 显示排版：预设 / 设置实时预览与取消恢复（按书记忆：只影响这本书，全局默认不动）
  const displayBookId = await exec('window.__cwTest.bookId()');
  const styleBefore = await exec('window.__cwTest.displayStyle()');
  await exec("window.__cwTest.applyDisplayPreset('loose')");
  await sleep(250);
  const styleLoose = await exec('window.__cwTest.displayStyle()');
  check(
    '预设「宽松」改行距生效',
    Math.abs(parseFloat(styleLoose.lineHeight) - parseFloat(styleLoose.fontSize) * 2.4) <= 1.5,
    { lineHeight: styleLoose.lineHeight, fontSize: styleLoose.fontSize }
  );
  check('预设「宽松」限制正文宽度 800px', styleLoose.maxWidth === '800px', styleLoose.maxWidth);
  check('显示预设不碰正文', (await exec('window.__cwTest.text()')) === formattedText);
  const looseDisplay = await exec(
    `window.api.getBookDisplay(${JSON.stringify(displayBookId)}).then((r) => (r.ok ? r.data : null))`
  );
  check(
    '显示预设按这本书记住',
    Boolean(looseDisplay) && looseDisplay.editorLineHeight === 2.4 && looseDisplay.editorPageWidth === 800,
    looseDisplay
  );
  const globalAfterPreset = await exec('window.api.getConfig().then((r) => (r.ok ? r.data : null))');
  check(
    '显示预设不改全局默认',
    globalAfterPreset.editorLineHeight === 1.95 && globalAfterPreset.editorPageWidth === 0,
    { lineHeight: globalAfterPreset.editorLineHeight, pageWidth: globalAfterPreset.editorPageWidth }
  );

  await exec('window.__cwTest.openSettings()');
  check('从写作页能打开设置', (await exec('window.__cwTest.settingsOpen()')) === true);
  check('写作页里打开设置只作用于这本书', (await exec('window.__cwTest.settingsScope()')) === 'book');
  await exec("window.__cwTest.setSelect('settings-paper', 'green')");
  // 中西文自动间距（1.3.0 T-08）：设置里的开关实时预览 → 关掉后正文计算值必须是 no-autospace
  // （Chromium 初始值就是 no-autospace，所以两个方向都显式写，这里正反都量）
  await exec("window.__cwTest.setCheck('settings-text-autospace', false)");
  const styleGreen = await exec('window.__cwTest.displayStyle()');
  check(
    '设置里改底色会实时预览',
    styleGreen.paperClass.includes('theme-green') && styleGreen.textAutospace === 'no-autospace',
    { paper: styleGreen.paperClass, textAutospace: styleGreen.textAutospace }
  );
  await exec('window.__cwTest.closeSettings()');
  const styleRestored = await exec('window.__cwTest.displayStyle()');
  check(
    '设置取消后恢复原底色',
    !styleRestored.paperClass.includes('theme-green') && styleRestored.textAutospace === 'normal',
    { paper: styleRestored.paperClass, textAutospace: styleRestored.textAutospace }
  );

  // 拍板 #3：设置弹层右上新增「×」关闭，与底栏「取消」完全同义（含关闭前的预览还原）
  await exec('window.__cwTest.openSettings()');
  const settingsCloseBtn = await exec(`(() => {
    const btn = document.getElementById('btn-settings-close');
    if (!btn) return null;
    const modal = document.querySelector('.settings-modal');
    const box = btn.getBoundingClientRect();
    const frame = modal.getBoundingClientRect();
    return {
      tag: btn.tagName,
      text: btn.textContent,
      label: btn.getAttribute('aria-label'),
      title: btn.getAttribute('title'),
      isModalClose: btn.classList.contains('modal-close'),
      w: Math.round(box.width),
      h: Math.round(box.height),
      top: Math.round(box.top - frame.top),
      right: Math.round(frame.right - box.right),
      focusable: btn.tabIndex >= 0,
      // 标题右侧留白：× 不能压在「设置」两个字上
      overlapsTitle: box.left < document.getElementById('settings-title').getBoundingClientRect().right
    };
  })()`);
  check(
    '设置弹层右上有「×」关闭按钮（28×28、贴右上角、可聚焦，不压标题）',
    settingsCloseBtn &&
      settingsCloseBtn.tag === 'BUTTON' &&
      settingsCloseBtn.text === '×' &&
      settingsCloseBtn.label === '关闭设置' &&
      settingsCloseBtn.isModalClose === true &&
      settingsCloseBtn.w === 28 &&
      settingsCloseBtn.h === 28 &&
      // 绝对定位参照 padding box，弹层还有 1px 边框，所以是 10–11 / 12–13
      settingsCloseBtn.top >= 8 &&
      settingsCloseBtn.top <= 14 &&
      settingsCloseBtn.right >= 10 &&
      settingsCloseBtn.right <= 16 &&
      settingsCloseBtn.focusable === true &&
      settingsCloseBtn.overlapsTitle === false,
    settingsCloseBtn
  );
  await exec("window.__cwTest.setSelect('settings-paper', 'green')");
  const styleGreenBeforeX = await exec('window.__cwTest.displayStyle()');
  check('设置里改底色在点「×」前已实时预览', styleGreenBeforeX.paperClass.includes('theme-green'), styleGreenBeforeX.paperClass);
  await exec("document.getElementById('btn-settings-close').click()");
  const styleAfterX = await exec('window.__cwTest.displayStyle()');
  const bookDisplayAfterX = await exec(
    `window.api.getBookDisplay(${JSON.stringify(displayBookId)}).then((r) => (r.ok ? r.data : null))`
  );
  check(
    '点右上「×」关掉设置并恢复关闭前的底色（未保存的预览不落盘）',
    (await exec('window.__cwTest.settingsOpen()')) === false &&
      !styleAfterX.paperClass.includes('theme-green') &&
      Boolean(bookDisplayAfterX) &&
      bookDisplayAfterX.editorPaper === undefined &&
      (await exec('window.__cwTest.text()')) === formattedText,
    { paper: styleAfterX.paperClass, book: bookDisplayAfterX }
  );

  await exec('window.__cwTest.openSettings()');
  await exec("window.__cwTest.setSelect('settings-paper', 'green')");
  await exec("document.getElementById('btn-settings-save').click()");
  await waitFor(
    `window.api.getBookDisplay(${JSON.stringify(displayBookId)}).then((r) => (r.ok && r.data.editorPaper === 'green'))`,
    10000
  );
  const savedBookPaper = await exec(
    `window.api.getBookDisplay(${JSON.stringify(displayBookId)}).then((r) => (r.ok ? r.data : null))`
  );
  const globalAfterBookSettings = await exec('window.api.getConfig().then((r) => (r.ok ? r.data : null))');
  check(
    '设置保存后护眼底色写入「这本书」',
    savedBookPaper.editorPaper === 'green' && savedBookPaper.editorTextAutospace === true,
    savedBookPaper
  );
  check(
    '设置保存不改全局默认纸色',
    globalAfterBookSettings.editorPaper === 'paper',
    globalAfterBookSettings.editorPaper
  );
  check('设置保存后正文仍未变', (await exec('window.__cwTest.text()')) === formattedText);

  // 「恢复本书默认」：清掉这本书的覆盖，回到全局设置
  await exec('window.__cwTest.openSettings()');
  await exec("document.getElementById('btn-reset-book-display').click()");
  await sleep(300);
  const displayAfterReset = await exec(
    `window.api.getBookDisplay(${JSON.stringify(displayBookId)}).then((r) => (r.ok ? r.data : null))`
  );
  check(
    '「恢复本书默认」清空这本书的显示覆盖',
    Boolean(displayAfterReset) && Object.keys(displayAfterReset).length === 0,
    displayAfterReset
  );
  const styleAfterReset = await exec('window.__cwTest.displayStyle()');
  check(
    '恢复默认后行距回到全局值',
    Math.abs(parseFloat(styleAfterReset.lineHeight) - 18 * 1.95) <= 1.5,
    styleAfterReset.lineHeight
  );
  await exec('window.__cwTest.closeSettings()');

  // 从书架改「全局默认」：没单独设置过的书都用它
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec('window.__cwTest.openSettings()');
  check('从书架打开设置改的是全局默认', (await exec('window.__cwTest.settingsScope()')) === 'global');
  await exec("window.__cwTest.setSelect('settings-paper', 'cream')");
  await exec("document.getElementById('btn-settings-save').click()");
  await waitFor("window.api.getConfig().then((r) => (r.ok && r.data.editorPaper === 'cream'))", 10000);
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(currentBookDir)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await sleep(300);
  const globalPaperStyle = await exec('window.__cwTest.displayStyle()');
  check('没有单独设置的书沿用全局纸色', globalPaperStyle.paperClass.includes('theme-cream'), globalPaperStyle.paperClass);
};
