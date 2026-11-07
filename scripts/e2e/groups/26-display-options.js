// E2E 第 26 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：续当前书（字体 / 主题 / 纸纹 / 边距）
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。

module.exports = async function group26DisplayOptions(t) {
  const { exec, check, waitFor, sleep } = t;
  const { indentBlankText } = t.state;

  // 26. 口袋写作同款显示项：字体文件（.ttf）、夜间、纸张纹理、左右边距
  // 代码审计 F1：font:read 不再接受渲染层传来的路径——只读「刚在对话框里选的 / 当前书 / 全局配置」里的字体。
  const testFontPath = 'C:\\Windows\\Fonts\\consola.ttf';
  const otherFontPath = 'C:\\Windows\\Fonts\\arial.ttf';
  const noFontPath = await exec('window.api.readFont()');
  check(
    '字体读取：还没有任何可用路径时读不到（主进程不再按渲染层给的路径读）',
    Boolean(noFontPath && noFontPath.ok === false && noFontPath.code === 'BAD_FONT'),
    noFontPath && { ok: noFontPath.ok, code: noFontPath.code }
  );
  const arbitraryNoPath = await exec(`window.api.readFont(${JSON.stringify(testFontPath)})`);
  check(
    '字体读取：直接传一个真实字体路径也读不到（渲染层说了不算）',
    Boolean(arbitraryNoPath && arbitraryNoPath.ok === false && arbitraryNoPath.code === 'BAD_FONT'),
    arbitraryNoPath && { ok: arbitraryNoPath.ok, code: arbitraryNoPath.code }
  );
  const pickSimulated = await exec(`window.api.testPickFont(${JSON.stringify(testFontPath)})`);
  check(
    '字体读取：模拟「在系统对话框里选中字体文件」（自检专用频道，生产不注册）',
    Boolean(pickSimulated && pickSimulated.ok && pickSimulated.data.name === 'consola.ttf'),
    pickSimulated && { ok: pickSimulated.ok, name: pickSimulated.data && pickSimulated.data.name }
  );
  const fontRead = await exec(`window.api.readFont(${JSON.stringify(otherFontPath)})`);
  check(
    '字体读取：选中后能读成 base64，且渲染层传的路径被忽略（读的是刚选的那个）',
    Boolean(
      fontRead &&
        fontRead.ok &&
        fontRead.data.name === 'consola.ttf' &&
        fontRead.data.size > 1000 &&
        fontRead.data.base64.length > 1000 &&
        fontRead.data.source === 'picked'
    ),
    fontRead && {
      ok: fontRead.ok,
      name: fontRead.data && fontRead.data.name,
      source: fontRead.data && fontRead.data.source
    }
  );
  const pickUsedOnce = await exec('window.api.readFont()');
  check(
    '字体读取：这次选中只用一次——用完回到「当前书 / 全局配置」，不会拿它顶替别的书',
    Boolean(pickUsedOnce && pickUsedOnce.ok === false && pickUsedOnce.code === 'BAD_FONT'),
    pickUsedOnce && { ok: pickUsedOnce.ok, code: pickUsedOnce.code }
  );
  // 非字体文件：写进这本书的显示设置，主进程解析出来之后仍按扩展名拒绝
  const fontBookId = await exec('window.__cwTest.bookId()');
  await exec(
    `window.api.setBookDisplay(${JSON.stringify(fontBookId)}, { editorFont: 'custom', editorCustomFontPath: 'C:\\\\Windows\\\\win.ini' })`
  );
  const badFontRead = await exec('window.api.readFont()');
  check(
    '非字体文件被拒绝（配置里写了 .ini 也读不到）',
    Boolean(badFontRead && badFontRead.ok === false && badFontRead.code === 'BAD_FONT'),
    badFontRead && { ok: badFontRead.ok, code: badFontRead.code }
  );
  await exec(`window.api.testPickFont(${JSON.stringify(testFontPath)})`);
  const customLoaded = await exec(`window.__cwTest.loadCustomFont(${JSON.stringify(testFontPath)})`);
  await sleep(300);
  const customState = await exec('window.__cwTest.customFontLoaded()');
  check('自定义字体能加载进页面（FontFace）', customLoaded === true && customState.ok === true, customState);
  check(
    '字体解码走浏览器原生 data: URL（fetch → arrayBuffer，失败才回退 atob）',
    (await exec('window.__cwTest.fontDecodeMode()')) === 'fetch',
    await exec('window.__cwTest.fontDecodeMode()')
  );
  const customApplied = await exec(
    `window.__cwTest.setCustomFont(${JSON.stringify(testFontPath)}, 'consola.ttf')`
  );
  check('自定义字体写入配置后生效', customApplied === true);
  check(
    '页面字体已切到自定义字体',
    (await exec('window.__cwTest.displayStyle()')).fontFamily.includes('cw-custom-font'),
    (await exec('window.__cwTest.displayStyle()')).fontFamily
  );
  const bookFontRead = await exec(`window.api.readFont(${JSON.stringify(otherFontPath)})`);
  check(
    '字体读取：保存后按「这本书的显示设置」解析，传任意路径仍只拿得到这本书的字体',
    Boolean(
      bookFontRead &&
        bookFontRead.ok &&
        bookFontRead.data.name === 'consola.ttf' &&
        bookFontRead.data.source === 'book'
    ),
    bookFontRead && {
      ok: bookFontRead.ok,
      name: bookFontRead.data && bookFontRead.data.name,
      source: bookFontRead.data && bookFontRead.data.source
    }
  );
  // 「刚选的」路径只留一趟：如果渲染层缓存命中、那一趟没被消费，下一次读别的字体不能拿它顶替
  await exec('window.__cwTest.resetLoadedFont()');
  await exec(`window.api.testPickFont(${JSON.stringify(otherFontPath)})`);
  const healedLoad = await exec(`window.__cwTest.loadCustomFont(${JSON.stringify(testFontPath)})`);
  const healedState = await exec('window.__cwTest.customFontLoaded()');
  check(
    '字体读取：没被消费的「刚选的」字体不会顶替这本书的字体（渲染层发现读回来的不是要的那份会再读一次）',
    healedLoad === true && healedState.ok === true && healedState.name === 'consola.ttf',
    healedState
  );

  const themeBookId = await exec('window.__cwTest.bookId()');
  await exec('window.__cwTest.openSettings()');
  check('写作页里的设置只改这本书', (await exec('window.__cwTest.settingsScope()')) === 'book');
  await exec("window.__cwTest.setSelect('settings-paper', 'night')");
  const nightStyle = await exec('window.__cwTest.displayStyle()');
  check('夜间主题生效（页面换成深色）', nightStyle.paperClass.includes('theme-night'), nightStyle.paperClass);
  const nightRgb = (nightStyle.backgroundColor.match(/\d+/g) || []).map(Number);
  check(
    '夜间主题：正文底色变深、字色不变',
    nightRgb.length >= 3 && nightRgb[0] < 80 && nightRgb[1] < 80 && nightRgb[2] < 80,
    nightStyle.backgroundColor
  );
  await exec("window.__cwTest.setSelect('settings-padding-x', '24')");
  const paddingStyle = await exec('window.__cwTest.displayStyle()');
  check('左右边距可调（24px）', paddingStyle.paddingLeft === '24px' && paddingStyle.paddingRight === '24px', {
    left: paddingStyle.paddingLeft,
    right: paddingStyle.paddingRight
  });
  await exec("window.__cwTest.setSelect('settings-paper', 'kraft')");
  const kraftStyle = await exec('window.__cwTest.displayStyle()');
  check(
    '牛皮纸主题带纹理（CSS 渐变，不加图片文件）',
    kraftStyle.backgroundImage.includes('repeating-linear-gradient'),
    kraftStyle.backgroundImage.slice(0, 80)
  );
  await exec("window.__cwTest.setSelect('settings-paper', 'grid')");
  const gridStyle = await exec('window.__cwTest.displayStyle()');
  check('网格纸主题带纹理', gridStyle.backgroundImage.includes('linear-gradient'), gridStyle.backgroundImage.slice(0, 80));

  await exec("window.__cwTest.setSelect('settings-paper', 'night')");
  await exec("document.getElementById('btn-settings-save').click()");
  await waitFor(
    `window.api.getBookDisplay(${JSON.stringify(themeBookId)}).then((r) => (r.ok && r.data.editorPaper === 'night' && r.data.editorPaddingX === 24))`,
    10000
  );
  const themeBookDisplay = await exec(
    `window.api.getBookDisplay(${JSON.stringify(themeBookId)}).then((r) => (r.ok ? r.data : null))`
  );
  const themeGlobalCfg = await exec('window.api.getConfig().then((r) => (r.ok ? r.data : null))');
  check(
    '夜间主题与左右边距按这本书记住',
    themeBookDisplay.editorPaper === 'night' && themeBookDisplay.editorPaddingX === 24,
    { paper: themeBookDisplay.editorPaper, paddingX: themeBookDisplay.editorPaddingX }
  );
  check(
    '这本书的显示设置不改全局默认（仍是书架里设的米黄）',
    themeGlobalCfg.editorPaper === 'cream',
    themeGlobalCfg.editorPaper
  );
  check('改主题/边距不动正文一个字', (await exec('window.__cwTest.text()')) === indentBlankText);
};
