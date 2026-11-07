// E2E 第 50 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：回书架 → 新建「编辑器小件测试书」；50i/50m/50n 用组 47 旧书与组 49 的 ttsLegacyMetaPath
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group50EditorWidgets(t) {
  const {
    exec,
    check,
    waitFor,
    sleep,
    win,
    storage,
    userData,
    booksRoot,
    ensureWindowFocus,
    setWindowSize,
    fileExists,
    chaptersLib
  } = t;
  const { fragLegacyBookPath, ttsLegacyMetaPath } = t.state;

  // 50. 编辑器小件（v0.7-4，提案 4.1）：选中字数 / 超长段落提示 / 不可见字符 ␣ / Alt+↑↓ 段落导航 / 章节字数对比。
  // 全部只读、可开关：标记只画在 #editor-marks 影子层上，正文 txt 一个字节都不动、不写盘。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec("window.__cwTest.newBook('编辑器小件测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const marksBookPath = await exec('window.__cwTest.bookPathValue()');
  await exec("window.__cwTest.renameChapterAt(0, '长段')");
  const marksLongStartText = '他沿着堤岸往回走，风把衣角吹得猎猎作响。';
  const marksLongParagraph = `　　${marksLongStartText.repeat(55)}`;
  const marksText = [
    '　　开头一段，有全角空格和行尾空白。  ',
    marksLongParagraph,
    '　　结尾一段。'
  ].join('\n');
  await exec(`window.__cwTest.setText(${JSON.stringify(marksText)})`);
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");
  await exec("window.__cwTest.newChapter('短章')");
  await waitFor("window.__cwTest.currentTitle().includes('短章')");
  const marksShortText = '　　这一章很短。\n\n　　只有两段。';
  await exec(`window.__cwTest.setText(${JSON.stringify(marksShortText)})`);
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");

  const marksExpectedOne = chaptersLib.countChars(marksText);
  const marksExpectedTwo = chaptersLib.countChars(marksShortText);
  // 拍板 #1：章节列表的紧凑字数在万以内也要千分位（1234 → '1,234'）。这里用 toLocaleString('en-US')
  // 当独立口径，而不是照抄实现里的正则——两边算出同一个字符串才算过。
  const shortCharsText = (n) => (n < 10000 ? Number(n).toLocaleString('en-US') : null);
  // 状态栏「选中 N 字」走的是 renderer 的 formatChars（万以内千分位、万 / 亿两位小数），
  // 同样是独立口径（toLocaleString 分组），不抄实现里的正则。
  const formatCharsText = (n) => {
    const value = Math.max(0, Math.floor(Number(n) || 0));
    const group = (v) => Number(v).toLocaleString('en-US');
    if (value < 10000) return `${group(value)} 字`;
    if (value < 100000000) {
      const [ints, dec] = (value / 10000).toFixed(2).split('.');
      return `${group(ints)}.${dec} 万字`;
    }
    const [ints, dec] = (value / 100000000).toFixed(2).split('.');
    return `${group(ints)}.${dec} 亿字`;
  };
  const marksChapterChars = await exec('window.__cwTest.chapterCharsTexts()');
  check(
    '编辑器小件：章节列表每项显示字数（保存后跟书目缓存一致）',
    marksChapterChars.length === 2 &&
      marksChapterChars[0] === shortCharsText(marksExpectedOne) &&
      marksChapterChars[1] === shortCharsText(marksExpectedTwo),
    { marksChapterChars, expected: [shortCharsText(marksExpectedOne), shortCharsText(marksExpectedTwo)] }
  );
  check(
    '编辑器小件：这一章比上一章短很多时，状态栏给「比上章短」软提示',
    (await exec('window.__cwTest.charCountWarn()')) === true &&
      (await exec('window.__cwTest.charCountText()')).includes('比上章短')
  );
  check(
    '编辑器小件：章节条目 tooltip 也写明「比上章短」（只提示，不改任何东西）',
    (await exec('window.__cwTest.chapterItemTitles()'))[1].includes('比上章短')
  );

  await exec('window.__cwTest.switchTo(0)');
  await waitFor(`window.__cwTest.text() === ${JSON.stringify(marksText)}`);
  const marksMetaBefore = JSON.stringify((await storage.readBookMeta(marksBookPath)).chapters);
  const marksTxtBefore = [];
  for (const chapter of JSON.parse(marksMetaBefore)) {
    const stat = await fs.stat(path.join(marksBookPath, chapter.file));
    marksTxtBefore.push({ file: chapter.file, size: stat.size, mtimeMs: stat.mtimeMs });
  }

  // 50b. 「显示 ▾」里的两个开关：打开后标记层显示，正文不动（v0.8.5 R1 从「排版 ▾」拆出来）
  await exec("document.getElementById('btn-display').click()");
  await waitFor('window.__cwTest.displayMenuOpen() === true');
  const marksMenuTexts = await exec(
    "Array.from(document.querySelectorAll('#display-menu button')).map((el) => el.textContent)"
  );
  check(
    '编辑器小件：「显示 ▾」菜单里有「显示不可见字符」「超长段落提示」两个开关',
    marksMenuTexts.some((text) => text.includes('显示不可见字符')) &&
      marksMenuTexts.some((text) => text.includes('超长段落提示'))
  );
  await exec(
    `document.querySelector('#display-menu button[data-action="toggle-invisibles"]').click()`
  );
  await waitFor('window.__cwTest.marksFlags().invisibles === true');
  check(
    '编辑器小件：打开「不可见字符」后标记层显示，正文仍是干净状态',
    (await exec('window.__cwTest.marksOverlayVisible()')) === true &&
      (await exec('window.__cwTest.dirty()')) === false
  );
  await exec("document.getElementById('btn-display').click()");
  await exec(
    `document.querySelector('#display-menu button[data-action="toggle-long-para"]').click()`
  );
  await waitFor('window.__cwTest.marksFlags().longParagraphs === true');
  await exec("document.getElementById('btn-display').click()");
  const marksCheckedMenu = await exec(
    "Array.from(document.querySelectorAll('#display-menu button[data-on=\"1\"]')).map((el) => el.textContent)"
  );
  check(
    '编辑器小件：开着的开关在菜单里显示 ✓',
    marksCheckedMenu.length === 2 && marksCheckedMenu.every((text) => text.startsWith('✓')),
    marksCheckedMenu
  );
  await exec('window.__cwTest.closeDisplayMenu()'); // 收起菜单

  // 50c. 不可见字符：全角空格逐个标 ␣，行尾空白只标一处；标记层文字与正文一一对应
  check(
    '编辑器小件：全角空格逐个标 ␣、行尾空白只标一处（行尾全角空格不重复算）',
    (await exec('window.__cwTest.marksFullwidthCount()')) === 6 &&
      (await exec('window.__cwTest.marksTrailingCount()')) === 1,
    {
      fullwidth: await exec('window.__cwTest.marksFullwidthCount()'),
      trailing: await exec('window.__cwTest.marksTrailingCount()')
    }
  );
  check(
    '编辑器小件：标记层的文字与正文一一对应（只多了 ␣ / · 两个标记字符）',
    (await exec("window.__cwTest.marksText().split('␣').join('').split('·').join('')")) === marksText
  );
  const marksMetrics = await exec('window.__cwTest.marksMetrics()');
  check(
    '编辑器小件：标记层与编辑区同宽同高、字体/行高一致（标记位置对得上）',
    marksMetrics.visible &&
      Math.abs(marksMetrics.overlayWidth - marksMetrics.contentWidth) <= 0.5 &&
      Math.abs(marksMetrics.overlayScrollHeight - marksMetrics.contentHeight) <= 1 &&
      marksMetrics.editorFontFamily === marksMetrics.overlayFontFamily &&
      marksMetrics.overlayLineHeight === marksMetrics.editorLineHeight &&
      Math.abs(parseFloat(marksMetrics.overlayFontSize) - parseFloat(marksMetrics.editorFontSize)) <= 0.1,
    marksMetrics
  );

  // 50d. 超长段落：识别 1 段，左侧黄线按行画（不是只画第一行），状态栏标签可跳转
  const marksLongFragments = (await exec('window.__cwTest.longParaRects()'))[0] || [];
  check(
    '编辑器小件：超长段落识别 1 段，左侧黄线按行画出来（每行一条）',
    (await exec('window.__cwTest.marksLongParaCount()')) === 1 &&
      marksLongFragments.length >= 3 &&
      (await exec('window.__cwTest.longParaBarCount()')) === marksLongFragments.length &&
      (await exec('window.__cwTest.longParaBarRects()')).every(
        (rect) => rect.width <= 4 && rect.height > 10
      ),
    { fragments: marksLongFragments.length, bars: await exec('window.__cwTest.longParaBarCount()') }
  );
  check(
    '编辑器小件：状态栏「超长段落 1 段」标签给出段数与行号提示',
    (await exec('window.__cwTest.longParaChipVisible()')) === true &&
      (await exec('window.__cwTest.longParaChipText()')) === '超长段落 1 段' &&
      (await exec('window.__cwTest.longParaChipTitle()')).includes('第 2 行')
  );
  await exec('window.__cwTest.setCaret(0)');
  await exec('window.__cwTest.clickLongParaChip()');
  check(
    '编辑器小件：点「超长段落」标签跳到段首（只移动光标，不改字）',
    (await exec('window.__cwTest.caret()')) === marksText.indexOf(marksLongStartText)
  );

  // 50e. 选中字数：只选了文字才显示，段数按触及的非空行算
  await exec('window.__cwTest.selectRange(0, 10)');
  check(
    '编辑器小件：选中后状态栏显示「选中 N 字 / M 段」',
    (await exec('window.__cwTest.selectionStatsVisible()')) === true &&
      (await exec('window.__cwTest.selectionStatsText()')) ===
        `选中 ${formatCharsText(chaptersLib.countChars(marksText.slice(0, 10)))} / 1 段`
  );
  await exec(`window.__cwTest.selectRange(0, ${marksText.length})`);
  check(
    '编辑器小件：跨 3 段选择显示 3 段（空行不算段）',
    (await exec('window.__cwTest.selectionStatsText()')) ===
      `选中 ${formatCharsText(chaptersLib.countChars(marksText))} / 3 段`
  );
  await exec('window.__cwTest.selectRange(3, 3)');
  check(
    '编辑器小件：取消选择后选中字数隐藏',
    (await exec('window.__cwTest.selectionStatsVisible()')) === false
  );

  // 50f. 段落导航：Alt+↑/↓ 在段首之间跳（跳过段首缩进）
  const marksFirstStart = marksText.indexOf('开头一段');
  const marksSecondStart = marksText.indexOf(marksLongStartText);
  const marksThirdStart = marksText.indexOf('结尾一段');
  await exec('window.__cwTest.selectRange(0, 0)');
  await exec(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))"
  );
  check(
    '编辑器小件：Alt+↓ 从章首跳到第一段段首（段首缩进之后）',
    (await exec('window.__cwTest.caret()')) === marksFirstStart
  );
  await exec(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))"
  );
  check(
    '编辑器小件：Alt+↓ 再去下一段段首',
    (await exec('window.__cwTest.caret()')) === marksSecondStart
  );
  await exec(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }))"
  );
  check(
    '编辑器小件：Alt+↑ 回上一段段首',
    (await exec('window.__cwTest.caret()')) === marksFirstStart
  );
  await exec(`window.__cwTest.selectRange(${marksSecondStart + 5}, ${marksSecondStart + 5})`);
  await exec(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }))"
  );
  check(
    '编辑器小件：光标在段中间时 Alt+↑ 回到本段开头',
    (await exec('window.__cwTest.caret()')) === marksSecondStart
  );
  await exec(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))"
  );
  check(
    '编辑器小件：Alt+↓ 从段首去下一段段首',
    (await exec('window.__cwTest.caret()')) === marksThirdStart
  );

  // 50g. 滚动时标记层 / 左侧黄线跟着正文走
  await exec('window.__cwTest.setEditorScroll(0)');
  const marksTopsBefore = (await exec('window.__cwTest.longParaBarRects()')).map((rect) => rect.top);
  const marksScrolled = await exec('window.__cwTest.setEditorScroll(140)');
  const marksScrollMetrics = await exec('window.__cwTest.marksMetrics()');
  const marksTopsAfter = (await exec('window.__cwTest.longParaBarRects()')).map((rect) => rect.top);
  check(
    '编辑器小件：滚动时标记层跟随，超长段落黄线跟着正文走',
    marksScrolled > 0 &&
      marksScrollMetrics.scrollLocked === true &&
      Math.abs(marksScrollMetrics.overlayScrollTop - marksScrollMetrics.editorScrollTop) < 0.5 &&
      marksTopsAfter.length === marksTopsBefore.length &&
      marksTopsAfter.every((top, index) => Math.abs(marksTopsBefore[index] - marksScrolled - top) <= 1),
    { marksScrolled, scrollLocked: marksScrollMetrics.scrollLocked }
  );
  await exec('window.__cwTest.setEditorScroll(0)');

  // 50h. 关掉开关：标记层收起，正文 / 书目 / txt 都不动
  await exec("window.__cwTest.setMarksToggle('invisibles', false)");
  check(
    '编辑器小件：关掉「不可见字符」后只剩超长段落黄线',
    (await exec('window.__cwTest.marksFullwidthCount()')) === 0 &&
      (await exec('window.__cwTest.marksTrailingCount()')) === 0 &&
      (await exec('window.__cwTest.marksLongParaCount()')) === 1 &&
      (await exec('window.__cwTest.marksOverlayVisible()')) === true
  );
  await exec("window.__cwTest.setMarksToggle('longParagraphs', false)");
  check(
    '编辑器小件：两个开关都关掉后标记层收起，正文一个字都不变',
    (await exec('window.__cwTest.marksOverlayVisible()')) === false &&
      (await exec('window.__cwTest.longParaGutterVisible()')) === false &&
      (await exec('window.__cwTest.longParaChipVisible()')) === false &&
      (await exec('window.__cwTest.text()')) === marksText &&
      (await exec('window.__cwTest.dirty()')) === false
  );
  const marksTxtAfter = [];
  for (const item of marksTxtBefore) {
    const stat = await fs.stat(path.join(marksBookPath, item.file));
    marksTxtAfter.push({ file: item.file, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  check(
    '编辑器小件：全程只读（txt 大小+mtime、书目 chapters、无 _trash 都没变）',
    JSON.stringify(marksTxtAfter) === JSON.stringify(marksTxtBefore) &&
      JSON.stringify((await storage.readBookMeta(marksBookPath)).chapters) === marksMetaBefore &&
      !(await fileExists(path.join(marksBookPath, '_trash')))
  );

  // 50i. 旧数据兼容：v0.4.1 形状的老书照常显示标记，书目不被补字段
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const marksLegacyBefore = await fs.readFile(ttsLegacyMetaPath, 'utf8');
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(fragLegacyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec(
    "window.__cwTest.setMarksToggle('invisibles', true); window.__cwTest.setMarksToggle('longParagraphs', true);"
  );
  await waitFor('window.__cwTest.marksOverlayVisible() === true');
  const marksLegacyAfter = await fs.readFile(ttsLegacyMetaPath, 'utf8');
  // v0.9 A-3：干净行现在合并成文本节点，旧书正文没有超长段 / 标记时 .marks-line 可以一行都没有，
  // 所以这条不再数 span，改成「影子层真的把正文镜像出来了」——比数节点更贴近要证明的事。
  const marksLegacyMirror = await exec(
    "window.__cwTest.marksText().split(String.fromCharCode(0x2423)).join('').split(String.fromCharCode(0xb7)).join('')"
  );
  check(
    '编辑器小件：没有 schemaVersion 的旧书照常用标记，书目不被补字段',
    marksLegacyMirror.length > 0 &&
      marksLegacyMirror === (await exec('window.__cwTest.text()')) &&
      marksLegacyAfter === marksLegacyBefore &&
      marksLegacyAfter.includes('"schemaVersion"') === false
  );
  await exec(
    "window.__cwTest.setMarksToggle('invisibles', false); window.__cwTest.setMarksToggle('longParagraphs', false);"
  );

  // 50j. 当前段落高亮（v0.8-10，提案 N10）：光标所在那一段在影子层上画淡色底 + 左侧细线；
  // 颜色跟着背景主题走；纯只读显示层——不改正文、不写盘、不写配置，开关和「不可见字符」一样只记在本次会话。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec("window.__cwTest.newBook('段落高亮测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const caretBookPath = await exec('window.__cwTest.bookPathValue()');
  const caretMetaPath = path.join(caretBookPath, '书目.json');
  const caretConfigPath = path.join(userData, 'config.json');
  await exec("window.__cwTest.renameChapterAt(0, '雨夜')");
  const caretSentence = '他把伞收起来，靠在门边，听雨点落在铁皮棚顶上，一下一下，像有人在很远的地方敲门。';
  const caretLonger = `${caretSentence}${caretSentence}`;
  const caretParagraphs = [];
  for (let i = 1; i <= 20; i += 1) {
    caretParagraphs.push(i % 5 === 0 ? `　　${caretLonger}` : `　　第${i}段：${caretSentence}`);
  }
  const caretHlText = caretParagraphs.join('\n\n');
  const caretStarts = [];
  {
    let offset = 0;
    for (const paragraph of caretParagraphs) {
      caretStarts.push(offset);
      offset += paragraph.length + 2; // 段落之间空一行
    }
  }
  // 影子层里的行文本包含段首缩进（和编辑区逐字对齐），所以这里也带缩进比较
  const caretParaText = (index) => caretParagraphs[index - 1];
  await exec(`window.__cwTest.setText(${JSON.stringify(caretHlText)})`);
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");
  const caretChapterFile = JSON.parse(await fs.readFile(caretMetaPath, 'utf8')).chapters[0].file;
  const caretTxtPath = path.join(caretBookPath, caretChapterFile);
  const caretTxtBefore = await fs.stat(caretTxtPath);
  const caretMetaBefore = await fs.readFile(caretMetaPath, 'utf8');
  const caretConfigBefore = await fs.readFile(caretConfigPath, 'utf8');
  const caretDirBefore = (await fs.readdir(caretBookPath)).sort().join('|');

  check(
    '当前段落高亮：这本书没设置过 → 默认关（全局默认也是关），标记层不显示',
    (await exec('window.__cwTest.marksFlags()')).caretParagraph === false &&
      (await exec('window.__cwTest.caretSettings()')).configEnabled === false &&
      (await exec('window.__cwTest.marksCaretParaCount()')) === 0 &&
      (await exec('window.__cwTest.marksOverlayVisible()')) === false
  );
  await exec("document.getElementById('btn-display').click()");
  const caretMenuTexts = await exec(
    "Array.from(document.querySelectorAll('#display-menu button')).map((el) => el.textContent)"
  );
  check(
    '当前段落高亮：「显示 ▾」菜单里多了一个默认不打勾的开关',
    caretMenuTexts.some((text) => text.includes('当前段落高亮')) &&
      (await exec("document.getElementById('format-caret-para').dataset.on")) === '0'
  );
  await exec(
    'document.querySelector(\'#display-menu button[data-action="toggle-caret-para"]\').click()'
  );
  await waitFor('window.__cwTest.caretSettings().bookDisplay.caretParagraph === true');
  check(
    '当前段落高亮：打开开关后标记层显示，菜单里打勾',
    (await exec('window.__cwTest.marksOverlayVisible()')) === true &&
      (await exec("document.getElementById('format-caret-para').dataset.on")) === '1' &&
      (await exec("document.getElementById('format-caret-para').textContent")).startsWith('✓') &&
      (await exec('window.__cwTest.dirty()')) === false
  );
  // 开关按书记忆（N10b）：切换只写 config.json 的 bookDisplay，不碰正文 / 书目 / 章节文件
  const caretBookId = await exec('window.__cwTest.bookId()');
  const caretConfigAfterOn = await fs.readFile(caretConfigPath, 'utf8');
  const caretConfigAfterOnJson = JSON.parse(caretConfigAfterOn);
  const caretTxtAfterOn = await fs.stat(caretTxtPath);
  check(
    '当前段落高亮：开关按书记忆——写进 config.json 的 bookDisplay[本书]，正文/书目/章节文件都不动',
    Boolean(caretBookId) &&
      caretConfigAfterOnJson.bookDisplay &&
      caretConfigAfterOnJson.bookDisplay[caretBookId] &&
      caretConfigAfterOnJson.bookDisplay[caretBookId].caretParagraph === true &&
      (await exec('window.__cwTest.caretSettings()')).bookDisplay.caretParagraph === true &&
      (await fs.readFile(caretMetaPath, 'utf8')) === caretMetaBefore &&
      caretTxtAfterOn.size === caretTxtBefore.size &&
      caretTxtAfterOn.mtimeMs === caretTxtBefore.mtimeMs
  );

  // 50j-1. 光标在哪一段，高亮就在哪一段（段首缩进里也算这一段；空行不高亮）
  await exec(`window.__cwTest.setCaret(${caretStarts[0] + 3})`);
  const caretFirst = await exec('window.__cwTest.marksCaretParaInfo()');
  check(
    '当前段落高亮：光标所在的第一段整段画上淡色底 + 左侧细线（只一处）',
    Boolean(caretFirst) &&
      caretFirst.line === 1 &&
      caretFirst.text === caretParaText(1) &&
      caretFirst.background !== 'rgba(0, 0, 0, 0)' &&
      caretFirst.background !== 'transparent' &&
      caretFirst.boxShadow.includes('inset') &&
      (await exec('window.__cwTest.marksCaretParaCount()')) === 1
  );
  await exec(`window.__cwTest.setCaret(${caretStarts[0] + 1})`);
  const caretIndent = await exec('window.__cwTest.marksCaretParaInfo()');
  check(
    '当前段落高亮：光标在段首缩进里也算这一段（不是只高亮缩进）',
    Boolean(caretIndent) && caretIndent.line === 1 && caretIndent.text === caretParaText(1)
  );
  await exec(`window.__cwTest.setCaret(${caretStarts[1] - 1})`);
  check(
    '当前段落高亮：光标停在空行时不高亮（也不会报错）',
    (await exec('window.__cwTest.marksCaretParaCount()')) === 0 &&
      (await exec('window.__cwTest.marksCaretLine()')) === 0 &&
      (await exec('window.__cwTest.marksFlags()')).caretParagraph === true
  );
  await exec(`window.__cwTest.setCaret(${caretStarts[1] + 5})`);
  const caretSecond = await exec('window.__cwTest.marksCaretParaInfo()');
  check(
    '当前段落高亮：光标移到第二段，高亮跟着换（同一时间只有一处）',
    Boolean(caretSecond) &&
      caretSecond.line === 3 &&
      caretSecond.text === caretParaText(2) &&
      (await exec('window.__cwTest.marksCaretParaCount()')) === 1
  );
  await exec(`window.__cwTest.setCaret(${caretStarts[4] + 10})`);
  const caretWrapped = await exec('window.__cwTest.marksCaretParaInfo()');
  check(
    '当前段落高亮：折成好几行的长段落整段都高亮（按行框画，不是只画第一行）',
    Boolean(caretWrapped) &&
      caretWrapped.line === 9 &&
      caretWrapped.text === caretParaText(5) &&
      caretWrapped.rects.length >= 2
  );

  // 50j-2. 和不可见字符叠着用；滚动时高亮跟着正文走
  await exec("window.__cwTest.setMarksToggle('invisibles', true)");
  await waitFor('window.__cwTest.marksFullwidthCount() > 0');
  check(
    '当前段落高亮：和「不可见字符」可以同时开（两种标记互不覆盖）',
    (await exec('window.__cwTest.marksFullwidthCount()')) === 40 &&
      (await exec('window.__cwTest.marksCaretParaCount()')) === 1 &&
      (await exec('window.__cwTest.marksOverlayVisible()')) === true
  );
  await exec("window.__cwTest.setMarksToggle('invisibles', false)");
  await exec(`window.__cwTest.setCaret(${caretStarts[14] + 8})`);
  await exec('window.__cwTest.setEditorScroll(0)');
  const caretTopBefore = (await exec('window.__cwTest.marksCaretParaInfo()')).rects[0].top;
  const caretScrolled = await exec('window.__cwTest.setEditorScroll(180)');
  const caretScrollMetrics = await exec('window.__cwTest.marksMetrics()');
  const caretTopAfter = (await exec('window.__cwTest.marksCaretParaInfo()')).rects[0].top;
  check(
    '当前段落高亮：滚动时高亮跟着正文走（影子层和编辑区滚动同步）',
    caretScrolled > 0 &&
      caretScrollMetrics.scrollLocked === true &&
      Math.abs(caretTopBefore - caretScrolled - caretTopAfter) <= 1.5,
    { caretScrolled, caretTopBefore, caretTopAfter }
  );
  await exec('window.__cwTest.setEditorScroll(0)');

  // 50j-3. 主题色细化：高亮底色 / 光标颜色跟着背景主题走，切换主题不写配置
  const caretPaperInfo = await exec('window.__cwTest.marksCaretParaInfo()');
  const caretPaperColor = await exec('window.__cwTest.editorCaretColor()');
  await exec('window.__cwTest.openSettings()');
  check(
    '当前段落高亮：写作页打开的是按这本书的显示设置',
    (await exec('window.__cwTest.settingsScope()')) === 'book'
  );
  await exec("window.__cwTest.setSelect('settings-paper', 'night')");
  await waitFor("window.__cwTest.displayStyle().paperClass.includes('theme-night')");
  const caretNightInfo = await exec('window.__cwTest.marksCaretParaInfo()');
  const caretNightColor = await exec('window.__cwTest.editorCaretColor()');
  check(
    '当前段落高亮：夜间主题有一套单独的高亮色 / 光标色，不会刺眼',
    Boolean(caretNightInfo) &&
      caretNightInfo.line === caretPaperInfo.line &&
      caretNightInfo.background !== caretPaperInfo.background &&
      caretNightColor !== caretPaperColor
  );
  await exec("window.__cwTest.setSelect('settings-paper', 'kraft')");
  await waitFor("window.__cwTest.displayStyle().paperClass.includes('theme-kraft')");
  const caretKraftInfo = await exec('window.__cwTest.marksCaretParaInfo()');
  const caretKraftColor = await exec('window.__cwTest.editorCaretColor()');
  check(
    '当前段落高亮：牛皮纸主题也有自己的高亮色（6 套主题分别调过色）',
    Boolean(caretKraftInfo) &&
      caretKraftInfo.background !== caretPaperInfo.background &&
      caretKraftInfo.background !== caretNightInfo.background &&
      caretKraftColor !== caretPaperColor
  );
  await exec('window.__cwTest.closeSettings()');
  await waitFor("!window.__cwTest.displayStyle().paperClass.includes('theme-kraft')");
  check(
    '当前段落高亮：切换主题只是预览，取消设置后主题恢复、config.json 一个字节没写',
    (await fs.readFile(caretConfigPath, 'utf8')) === caretConfigAfterOn
  );

  // 50j-4. 没保存的新段落也高亮；超长正文跳过；关掉开关就收起
  await exec(
    `window.__cwTest.setText(${JSON.stringify(`${caretHlText}\n\n　　临时加的一段，还没有保存。`)})`
  );
  await waitFor('window.__cwTest.marksCaretParaCount() === 1');
  const caretUnsaved = await exec('window.__cwTest.marksCaretParaInfo()');
  check(
    '当前段落高亮：编辑区里没保存的新段落也会高亮（只改显示层，不写盘）',
    (await exec('window.__cwTest.dirty()')) === true &&
      Boolean(caretUnsaved) &&
      caretUnsaved.text.trim() === '临时加的一段，还没有保存。'
  );
  await exec(`window.__cwTest.setText(${JSON.stringify(caretHlText)})`);
  await waitFor("window.__cwTest.dirty() === false");
  // 50j-4b. 标记层超长门控（v0.8.6 R5，代码审计 F9）：只开「当前段落高亮」时，以前也会把整章正文
  // 塞进 #editor-marks（每次按键重建约 1MB 的 DOM 镜像）——现在 renderEditorMarks 入口直接整层收起。
  await exec('window.__cwTest.clearToasts()');
  await exec("window.__cwTest.setText('长'.repeat(300001))");
  // 标记层渲染是 80ms 防抖的 setTimeout；窗口被遮挡时 Chromium 会把后台定时器节流到 1s 以上，
  // 以前固定 sleep(250) 偶发不够（2026-11-01 v0.9 B-2 实测连挂两次：标记层还是上一次 21 行的旧镜像）。
  // 这里等「超长提示真的弹出来」——那句 toast 只有在 renderEditorMarks 的超长分支里才发，
  // 所以它出现就等于入口门控跑过、整层已收起。断言一个字没变，只是不再靠猜时间。
  // （不能等 marksCaretTooLarge：光标移动时 currentCaretParagraph 也会把它置 true，不等价。）
  await waitFor('window.__cwTest.toasts().length === 1', 8000);
  const marksTooLargeToasts = await exec('window.__cwTest.toasts()');
  check(
    '标记层超长门控：正文超过 30 万字时整层镜像不建（只开当前段落高亮也不建），正文照常可编辑',
    (await exec('window.__cwTest.marksOverlayVisible()')) === false &&
      (await exec('window.__cwTest.marksLineCount()')) === 0 &&
      (await exec('window.__cwTest.marksLongParaCount()')) === 0 &&
      (await exec('window.__cwTest.longParaBarCount()')) === 0 &&
      (await exec('window.__cwTest.marksCaretParaCount()')) === 0 &&
      (await exec('window.__cwTest.marksCaretTooLarge()')) === true &&
      (await exec('window.__cwTest.marksFlags()')).caretParagraph === true &&
      (await exec('window.__cwTest.text()')).length === 300001 &&
      (await exec('window.__cwTest.dirty()')) === true
  );
  check(
    '标记层超长门控：超长只提示一次，文案说明标记层收起、正文与保存不受影响',
    marksTooLargeToasts.length === 1 &&
      marksTooLargeToasts[0].kind === 'warn' &&
      marksTooLargeToasts[0].message.includes('30 万字') &&
      marksTooLargeToasts[0].message.includes('标记层')
  );
  await exec("window.__cwTest.setText('长'.repeat(300002))");
  await sleep(200);
  check(
    '标记层超长门控：超长期间继续打字不会再弹提示（一次性，不是每按键一次）',
    (await exec('window.__cwTest.toasts()')).length === 1 &&
      (await exec('window.__cwTest.marksOverlayVisible()')) === false &&
      (await exec('window.__cwTest.marksLineCount()')) === 0
  );
  await exec(`window.__cwTest.setText(${JSON.stringify(caretHlText)})`);
  await waitFor('window.__cwTest.marksCaretParaCount() === 1');
  check(
    '标记层超长门控：回到 30 万字以内标记层恢复（镜像重新建、当前段落高亮照常）',
    (await exec('window.__cwTest.marksOverlayVisible()')) === true &&
      (await exec('window.__cwTest.marksLineCount()')) > 0 &&
      (await exec('window.__cwTest.marksCaretParaCount()')) === 1
  );
  await exec("window.__cwTest.setText('长'.repeat(300001))");
  // 同上：等第二句超长提示出现（同样只有入口门控会发），不靠固定 sleep
  await waitFor('window.__cwTest.toasts().length === 2', 8000);
  check(
    '标记层超长门控：回到上限以内后再次超长会重新提示一次（不是永久静音）',
    (await exec('window.__cwTest.toasts()')).length === 2 &&
      (await exec('window.__cwTest.marksLineCount()')) === 0
  );
  await exec(`window.__cwTest.setText(${JSON.stringify(caretHlText)})`);
  await waitFor('window.__cwTest.marksCaretParaCount() === 1');
  await exec("document.getElementById('btn-display').click()");
  await exec(
    'document.querySelector(\'#display-menu button[data-action="toggle-caret-para"]\').click()'
  );
  await waitFor('window.__cwTest.marksFlags().caretParagraph === false');
  check(
    '当前段落高亮：关掉开关后标记层收起、菜单恢复不打勾，正文一个字不变',
    (await exec('window.__cwTest.marksCaretParaCount()')) === 0 &&
      (await exec('window.__cwTest.marksOverlayVisible()')) === false &&
      (await exec("document.getElementById('format-caret-para').dataset.on")) === '0' &&
      (await exec('window.__cwTest.text()')) === caretHlText &&
      (await exec('window.__cwTest.dirty()')) === false
  );

  // 50j-5. 只读 + 开关按书落 config；v0.4.1 旧书照常高亮
  await waitFor("window.__cwTest.caretSettings().bookDisplay.caretParagraph === false");
  const caretTxtAfter = await fs.stat(caretTxtPath);
  const caretMetaAfter = await fs.readFile(caretMetaPath, 'utf8');
  const caretConfigAfter = await fs.readFile(caretConfigPath, 'utf8');
  const caretDirAfter = (await fs.readdir(caretBookPath)).sort().join('|');
  check(
    '当前段落高亮：正文 / 书目 / 章节文件全程只读（txt 大小+mtime、书目、书内文件都没变，无 _trash / 临时文件）',
    caretTxtAfter.size === caretTxtBefore.size &&
      caretTxtAfter.mtimeMs === caretTxtBefore.mtimeMs &&
      caretMetaAfter === caretMetaBefore &&
      caretDirAfter === caretDirBefore &&
      !caretDirAfter.includes('_trash') &&
      !caretDirAfter.includes('.tmp-')
  );
  const caretConfigJson = JSON.parse(caretConfigAfter);
  const caretConfigBeforeJson = JSON.parse(caretConfigBefore);
  const caretBookDisplayAfter = caretConfigJson.bookDisplay && caretConfigJson.bookDisplay[caretBookId];
  delete caretConfigJson.lastBook;
  delete caretConfigBeforeJson.lastBook;
  delete caretConfigJson.bookDisplay;
  delete caretConfigBeforeJson.bookDisplay;
  const caretConfigDiff = {};
  for (const key of new Set([...Object.keys(caretConfigBeforeJson), ...Object.keys(caretConfigJson)])) {
    if (JSON.stringify(caretConfigBeforeJson[key]) !== JSON.stringify(caretConfigJson[key])) {
      caretConfigDiff[key] = [caretConfigBeforeJson[key], caretConfigJson[key]];
    }
  }
  check(
    '当前段落高亮：config.json 只多出 bookDisplay[本书] 的开关（关掉后记 false），没有其它新字段',
    JSON.stringify(caretConfigJson) === JSON.stringify(caretConfigBeforeJson) &&
      Boolean(caretBookDisplayAfter) &&
      caretBookDisplayAfter.caretParagraph === false &&
      !caretBookDisplayAfter.caretParagraphColor &&
      caretConfigJson.caretParagraph === false &&
      caretConfigJson.caretParagraphColor === '' &&
      ['marksCaret', 'editorCaret', 'caretLine', 'caretHighlight'].every(
        (key) => !(key in caretConfigJson)
      ),
    { diff: caretConfigDiff, bookDisplay: caretBookDisplayAfter }
  );
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const caretLegacyMetaBefore = await fs.readFile(ttsLegacyMetaPath, 'utf8');
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(fragLegacyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec("window.__cwTest.setMarksToggle('caretParagraph', true); window.__cwTest.setCaret(0);");
  const caretLegacyInfo = await exec('window.__cwTest.marksCaretParaInfo()');
  const caretLegacyMetaAfter = await fs.readFile(ttsLegacyMetaPath, 'utf8');
  check(
    '当前段落高亮：没有 schemaVersion 的旧书照常高亮，书目不被补字段',
    Boolean(caretLegacyInfo) &&
      caretLegacyInfo.line === 1 &&
      caretLegacyInfo.text === '旧书正文。' &&
      caretLegacyMetaAfter === caretLegacyMetaBefore &&
      caretLegacyMetaAfter.includes('"schemaVersion"') === false
  );
  await exec("window.__cwTest.setMarksToggle('caretParagraph', false)");

  // 50k. 查找增强（v0.8-11，提案 N11）：当前章「上一处 / 下一处」+ 结果持续高亮。
  // 只移动选区 / 滚动 + 在只读影子层上画高亮：不改正文、不写盘、不写配置。
  // 关掉面板后高亮还在、F3 / Shift+F3 还能继续跳，Esc 清除；命中太多时只画当前附近一屏。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec("window.__cwTest.newBook('查找增强测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const findBookPath = await exec('window.__cwTest.bookPathValue()');
  const findMetaPath = path.join(findBookPath, '书目.json');
  const findConfigPath = path.join(userData, 'config.json');
  await exec("window.__cwTest.renameChapterAt(0, '雨夜')");
  const findLine1 = '　　阿明推开门，阿明看见雨。';
  const findLine2 = '　　巷口没有人，阿明把伞收起来。';
  const findLine3 = '　　阿明说：Rain rain 都要停了。';
  const findText = [findLine1, '', findLine2, '', findLine3].join('\n');
  const findStart1 = findText.indexOf('阿明');
  const findStart2 = findText.indexOf('阿明', findStart1 + 1);
  const findStart3 = findText.indexOf('阿明', findStart2 + 1);
  const findStart4 = findText.indexOf('阿明', findStart3 + 1);
  const findRainLower = findText.indexOf('rain');
  const findRainUpper = findText.indexOf('Rain');
  await exec(`window.__cwTest.setText(${JSON.stringify(findText)})`);
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");
  // 第二章：整本查找跳过来以后，本章命中也要全部高亮
  await exec("window.__cwTest.newChapter('归途')");
  await waitFor("window.__cwTest.currentIndex() === 1");
  const findChapter2 = '　　阿明在归途上想：阿明该回家了。';
  await exec(`window.__cwTest.setText(${JSON.stringify(findChapter2)})`);
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await waitFor("window.__cwTest.currentIndex() === 0");
  const findMetaBeforeJson = JSON.parse(await fs.readFile(findMetaPath, 'utf8'));
  const findChapterFile = findMetaBeforeJson.chapters[0].file;
  const findTxtPath = path.join(findBookPath, findChapterFile);
  const findTxtBefore = await fs.stat(findTxtPath);
  const findMetaBefore = await fs.readFile(findMetaPath, 'utf8');
  const findConfigBefore = await fs.readFile(findConfigPath, 'utf8');
  const findDirBefore = (await fs.readdir(findBookPath)).sort().join('|');

  check(
    '查找增强：默认没有查找会话，状态栏没有小标签、正文上没有高亮层',
    (await exec('window.__cwTest.findSession()')) === null &&
      (await exec('window.__cwTest.findChipVisible()')) === false &&
      (await exec('window.__cwTest.findOverlayVisible()')) === false
  );

  // 50k-1. 当前章查找：全部命中都画出来，选中第 1 处，第 1/4 处
  await exec('window.__cwTest.openFindPanel()');
  await exec(
    "window.__cwTest.setFindFields({ query: '阿明', scope: 'current', caseSensitive: false })"
  );
  await exec('window.__cwTest.findRun()');
  await waitFor('window.__cwTest.findHighlightCount() === 4');
  const findFirst = await exec('window.__cwTest.findSession()');
  check(
    '查找增强：当前章查找列出全部 4 处并选中第 1 处（第 1/4 处）',
    findFirst &&
      findFirst.total === 4 &&
      findFirst.index === 0 &&
      (await exec('window.__cwTest.selection()')).start === findStart1,
    findFirst
  );
  check(
    '查找增强：本章所有命中都在只读影子层上高亮，当前那处单独标色（只有一处）',
    (await exec('window.__cwTest.findHighlightCount()')) === 4 &&
      (await exec('window.__cwTest.findCurrentOrdinal()')) === 0 &&
      (await exec('window.__cwTest.findOverlayVisible()')) === true
  );
  check(
    '查找增强：面板显示「第 1/4 处」与快捷键行，正文仍是已保存状态',
    (await exec('window.__cwTest.findSummary()')).includes('本章命中 4 处（第 1/4 处）') &&
      (await exec("document.querySelector('.find-nav-hint').textContent")).includes('Enter / F3') &&
      (await exec('window.__cwTest.findNavCount()')) === '1 / 4' &&
      (await exec('window.__cwTest.dirty()')) === false
  );
  check(
    '查找增强：状态栏出现「查找 1 / 4」小标签',
    (await exec('window.__cwTest.findChipVisible()')) === true &&
      (await exec('window.__cwTest.findChipText()')) === '查找 1 / 4'
  );
  const findStyleCurrent = await exec('window.__cwTest.findHitStyle()');
  const findStyleOther = await exec('window.__cwTest.findHitStyle(1)');
  check(
    '查找增强：当前命中的底色比其它命中更重',
    Boolean(findStyleCurrent) &&
      Boolean(findStyleOther) &&
      findStyleCurrent.background !== 'rgba(0, 0, 0, 0)' &&
      findStyleCurrent.background !== findStyleOther.background &&
      (await exec('window.__cwTest.findHighlightCount()')) === 4
  );

  // 50k-2. 面板里的「上一处 / 下一处」按钮：只移动选区与当前高亮，命中总数不变
  await exec("document.getElementById('btn-find-next').click()");
  await waitFor('window.__cwTest.findSession().index === 1');
  check(
    '查找增强：点「下一处」到第 2 处（选区跟着走、4 处高亮都在）',
    (await exec('window.__cwTest.selection()')).start === findStart2 &&
      (await exec('window.__cwTest.findCurrentOrdinal()')) === 1 &&
      (await exec('window.__cwTest.findHighlightCount()')) === 4 &&
      (await exec('window.__cwTest.findNavCount()')) === '2 / 4'
  );
  await exec("document.getElementById('btn-find-prev').click()");
  await waitFor('window.__cwTest.findSession().index === 0');
  check(
    '查找增强：点「上一处」回到第 1 处',
    (await exec('window.__cwTest.selection()')).start === findStart1 &&
      (await exec('window.__cwTest.findCurrentOrdinal()')) === 0
  );
  await exec('window.__cwTest.findGoTo(3)');
  await exec("document.getElementById('btn-find-next').click()");
  await waitFor('window.__cwTest.findSummary().includes("已到末尾")');
  check(
    '查找增强：最后一处再按「下一处」绕回第 1 处，摘要说明绕回',
    (await exec('window.__cwTest.selection()')).start === findStart1 &&
      (await exec('window.__cwTest.findSession()')).index === 0 &&
      (await exec('window.__cwTest.findSummary()')).includes('已到末尾，回到第 1 处')
  );
  await exec("document.getElementById('btn-find-prev').click()");
  await waitFor('window.__cwTest.findSummary().includes("已到开头")');
  check(
    '查找增强：第 1 处再按「上一处」绕到最后一处',
    (await exec('window.__cwTest.selection()')).start === findStart4 &&
      (await exec('window.__cwTest.findSession()')).index === 3 &&
      (await exec('window.__cwTest.findSummary()')).includes('已到开头，回到最后一处')
  );

  // 50k-3. 快捷键：查找框里 Enter / Shift+Enter，面板关着时 F3 / Shift+F3
  await exec("document.getElementById('find-query').focus()");
  await exec(
    "document.getElementById('find-query').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))"
  );
  await waitFor('window.__cwTest.findSession().index === 0');
  check(
    '查找增强：查找框里按 Enter = 下一处（绕回第 1 处，不必重新点「查找」）',
    (await exec('window.__cwTest.selection()')).start === findStart1
  );
  await exec(
    "document.getElementById('find-query').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }))"
  );
  await waitFor('window.__cwTest.findSession().index === 3');
  check(
    '查找增强：查找框里按 Shift+Enter = 上一处（绕到最后一处）',
    (await exec('window.__cwTest.selection()')).start === findStart4
  );
  await exec('window.__cwTest.closeFindPanel()');
  await waitFor('window.__cwTest.findPanelOpen() === false');
  check(
    '查找增强：关掉面板后高亮和状态栏标签都还在（结果持续高亮）',
    (await exec('window.__cwTest.findOverlayVisible()')) === true &&
      (await exec('window.__cwTest.findHighlightCount()')) === 4 &&
      (await exec('window.__cwTest.findChipVisible()')) === true &&
      (await exec('window.__cwTest.findChipText()')) === '查找 4 / 4'
  );
  await exec(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3', bubbles: true, cancelable: true }))"
  );
  await waitFor('window.__cwTest.findSession().index === 0');
  check(
    '查找增强：面板关着也能按 F3 跳到下一处（最后一处绕回第 1 处）',
    (await exec('window.__cwTest.selection()')).start === findStart1 &&
      (await exec('window.__cwTest.findChipText()')) === '查找 1 / 4'
  );
  await exec(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3', shiftKey: true, bubbles: true, cancelable: true }))"
  );
  await waitFor('window.__cwTest.findSession().index === 3');
  check(
    '查找增强：Shift+F3 跳上一处（第 1 处绕到最后一处）',
    (await exec('window.__cwTest.selection()')).start === findStart4
  );
  await exec(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))"
  );
  await waitFor('window.__cwTest.findSession() === null');
  check(
    '查找增强：面板关着时 Esc 清除高亮和标签，正文一个字没动',
    (await exec('window.__cwTest.findOverlayVisible()')) === false &&
      (await exec('window.__cwTest.findHighlightCount()')) === 0 &&
      (await exec('window.__cwTest.findChipVisible()')) === false &&
      (await exec('window.__cwTest.text()')) === findText
  );

  // 50k-4. 大小写 / 改词 / 换范围：旧高亮立刻收起，不拿旧位置继续亮
  await exec('window.__cwTest.openFindPanel()');
  await exec(
    "window.__cwTest.setFindFields({ query: 'rain', scope: 'current', caseSensitive: false })"
  );
  await exec('window.__cwTest.findRun()');
  await waitFor("window.__cwTest.findSession() && window.__cwTest.findSession().total === 2");
  check(
    '查找增强：不区分大小写时 Rain / rain 都算（2 处，选中第 1 处）',
    (await exec('window.__cwTest.findHighlightCount()')) === 2 &&
      (await exec('window.__cwTest.selection()')).start === findRainUpper
  );
  await exec("window.__cwTest.setFindFields({ caseSensitive: true })");
  await exec(
    "document.getElementById('find-case').dispatchEvent(new Event('change', { bubbles: true }))"
  );
  await waitFor('window.__cwTest.findSession() === null');
  check(
    '查找增强：改「区分大小写」后旧高亮立刻收起（不再对着旧结果亮）',
    (await exec('window.__cwTest.findOverlayVisible()')) === false &&
      (await exec('window.__cwTest.findChipVisible()')) === false
  );
  await exec('window.__cwTest.findRun()');
  await waitFor("window.__cwTest.findSession() && window.__cwTest.findSession().total === 1");
  check(
    '查找增强：区分大小写后只剩小写 rain 一处',
    (await exec('window.__cwTest.findHighlightCount()')) === 1 &&
      (await exec('window.__cwTest.selection()')).start === findRainLower
  );
  await exec("window.__cwTest.findTypeQuery('巷口')");
  await waitFor('window.__cwTest.findSession() === null');
  check(
    '查找增强：在查找框里改词，旧高亮立刻收起',
    (await exec('window.__cwTest.findOverlayVisible()')) === false
  );
  await exec('window.__cwTest.findRun()');
  await waitFor("window.__cwTest.findSession() && window.__cwTest.findSession().total === 1");
  check(
    '查找增强：重新查「巷口」只命中 1 处并高亮',
    (await exec('window.__cwTest.findHighlightCount()')) === 1 &&
      (await exec('window.__cwTest.selection()')).start === findText.indexOf('巷口')
  );
  // 主题：夜间有一套单独的命中高亮色（只预览，不写配置）
  await exec("window.__cwTest.setFindFields({ query: '阿明' })");
  await exec('window.__cwTest.findRun()');
  await waitFor('window.__cwTest.findHighlightCount() === 4');
  const findPaperHit = await exec('window.__cwTest.findHitStyle()');
  await exec('window.__cwTest.openSettings()');
  await exec("window.__cwTest.setSelect('settings-paper', 'night')");
  await waitFor("window.__cwTest.displayStyle().paperClass.includes('theme-night')");
  const findNightHit = await exec('window.__cwTest.findHitStyle()');
  check(
    '查找增强：夜间主题有单独的命中高亮色（暗底上不刺眼，只改显示）',
    Boolean(findNightHit) &&
      findNightHit.background !== findPaperHit.background &&
      findNightHit.boxShadow.includes('inset')
  );
  await exec('window.__cwTest.closeSettings()');
  await waitFor("!window.__cwTest.displayStyle().paperClass.includes('theme-night')");
  check(
    '查找增强：切换主题只是预览，取消后配置一个字节没写',
    (await fs.readFile(findConfigPath, 'utf8')) === findConfigBefore
  );

  // 50k-5. 整本查找跳过来：本章命中全部高亮；换章自动结束
  await exec("window.__cwTest.setFindFields({ query: '阿明', scope: 'book' })");
  await exec('window.__cwTest.findRun()');
  await waitFor("window.__cwTest.findSummary().includes('整本命中')");
  check(
    '查找增强：整本查找仍按章列结果（2 章共 6 处）',
    (await exec('window.__cwTest.findSummary()')).includes('整本命中 6 处，分布在 2 章') &&
      (await exec('window.__cwTest.findResultCount()')) === 2
  );
  await exec('window.__cwTest.clickFindResult(1)');
  await waitFor('window.__cwTest.currentIndex() === 1');
  await waitFor('window.__cwTest.findHighlightCount() === 2');
  check(
    '查找增强：点整本结果跳到那一章后，本章命中全部高亮并选中第 1 处',
    (await exec('window.__cwTest.findSession()')).total === 2 &&
      (await exec('window.__cwTest.findChipText()')) === '查找 1 / 2' &&
      (await exec('window.__cwTest.selection()')).start === findChapter2.indexOf('阿明')
  );
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await waitFor('window.__cwTest.findSession() === null');
  check(
    '查找增强：换一章后高亮自动结束（不会拿上一章的位置亮着）',
    (await exec('window.__cwTest.findOverlayVisible()')) === false &&
      (await exec('window.__cwTest.findChipVisible()')) === false
  );

  // 50k-6. 改正文结束会话；命中太多只画一屏；滚动同步
  await exec('window.__cwTest.openFindPanel()');
  await exec("window.__cwTest.setFindFields({ query: '阿明', scope: 'current' })");
  await exec('window.__cwTest.findRun()');
  await waitFor('window.__cwTest.findHighlightCount() === 4');
  const findEditedText = `${findText}\n\n　　后来他想起那把伞。`;
  await exec(`window.__cwTest.setText(${JSON.stringify(findEditedText)})`);
  await waitFor('window.__cwTest.findSession() === null');
  check(
    '查找增强：改正文后高亮结束（位置对不上了），正文仍是未保存',
    (await exec('window.__cwTest.dirty()')) === true &&
      (await exec('window.__cwTest.findOverlayVisible()')) === false &&
      (await exec('window.__cwTest.text()')) === findEditedText
  );
  await exec(`window.__cwTest.setText(${JSON.stringify(findText)})`);
  await waitFor("window.__cwTest.dirty() === false");
  // 600 处命中：只画 500 处，当前命中仍在窗口里，导航序号仍是全局的
  await exec(`window.__cwTest.setText(${JSON.stringify('阿明'.repeat(600))})`);
  await waitFor('window.__cwTest.dirty() === true');
  await exec('window.__cwTest.openFindPanel()');
  await exec("window.__cwTest.setFindFields({ query: '阿明', scope: 'current' })");
  await exec('window.__cwTest.findRun()');
  await waitFor("window.__cwTest.findSession() && window.__cwTest.findSession().total === 600");
  const findBig = await exec('window.__cwTest.findSession()');
  check(
    '查找增强：命中太多（600 处）时只画一屏，摘要说明，当前命中仍在其中',
    (await exec('window.__cwTest.findHighlightCount()')) === 500 &&
      findBig.truncated === true &&
      (await exec('window.__cwTest.findSummary()')).includes('命中太多') &&
      (await exec('window.__cwTest.findCurrentOrdinal()')) === 0 &&
      findBig.windowStart === 0 &&
      findBig.windowEnd === 500
  );
  await exec('window.__cwTest.findGoTo(549)');
  await waitFor('window.__cwTest.findCurrentOrdinal() === 549');
  const findBigShifted = await exec('window.__cwTest.findSession()');
  check(
    '查找增强：跳到第 550 处时高亮窗口跟着移动，当前命中仍在高亮层里',
    (await exec('window.__cwTest.findHighlightCount()')) === 500 &&
      findBigShifted.windowStart > 0 &&
      findBigShifted.windowStart <= 549 &&
      findBigShifted.windowEnd > 549 &&
      findBigShifted.windowEnd <= 600
  );
  const findScrolled = await exec('window.__cwTest.setEditorScroll(180)');
  const findOverlayScroll = await exec('window.__cwTest.findOverlayScroll()');
  check(
    '查找增强：滚动正文时高亮层跟着滚（和标记层同一套同步）',
    findScrolled > 0 &&
      findOverlayScroll.top === findOverlayScroll.editorTop &&
      Math.abs(findOverlayScroll.top - findScrolled) <= 1,
    { findScrolled, findOverlayScroll }
  );
  await exec('window.__cwTest.setEditorScroll(0)');
  // 恢复成磁盘上的正文（这一章没有保存过 600 处命中的临时内容）
  await exec(`window.__cwTest.setText(${JSON.stringify(findText)})`);
  await waitFor("window.__cwTest.dirty() === false");
  await exec('window.__cwTest.closeFindPanel()');

  // 50k-7. 全程只读；配置不新增查找字段；v0.4.1 旧书照常查找 / 高亮
  const findTxtAfter = await fs.stat(findTxtPath);
  const findMetaAfterJson = JSON.parse(await fs.readFile(findMetaPath, 'utf8'));
  const findConfigAfterJson = JSON.parse(await fs.readFile(findConfigPath, 'utf8'));
  const findConfigBeforeJson = JSON.parse(findConfigBefore);
  delete findConfigAfterJson.lastBook; // 切章会正常记「上次打开的书 / 章」，和查找无关
  delete findConfigBeforeJson.lastBook;
  const findDirAfter = (await fs.readdir(findBookPath)).sort().join('|');
  check(
    '查找增强：全程只读（章节 txt 大小+mtime、书目 chapters、配置、书内文件都没变，无 _trash / 临时文件）',
    findTxtAfter.size === findTxtBefore.size &&
      findTxtAfter.mtimeMs === findTxtBefore.mtimeMs &&
      JSON.stringify(findMetaAfterJson.chapters) === JSON.stringify(findMetaBeforeJson.chapters) &&
      JSON.stringify(findConfigAfterJson) === JSON.stringify(findConfigBeforeJson) &&
      findDirAfter === findDirBefore &&
      !findDirAfter.includes('_trash') &&
      !findDirAfter.includes('.tmp-'),
    { txt: [findTxtBefore.size, findTxtAfter.size], meta: findMetaAfterJson.chapters.length }
  );
  check(
    '查找增强：配置没有新增查找字段（会话只记内存，不写配置）',
    ['findSession', 'findQuery', 'findHighlight', 'lastFind', 'findNav'].every(
      (key) => !(key in findConfigAfterJson)
    )
  );
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const findLegacyMetaBefore = await fs.readFile(ttsLegacyMetaPath, 'utf8');
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(fragLegacyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec('window.__cwTest.openFindPanel()');
  await exec("window.__cwTest.setFindFields({ query: '旧书', scope: 'current' })");
  await exec('window.__cwTest.findRun()');
  await waitFor('window.__cwTest.findHighlightCount() === 1');
  const findLegacyMetaAfter = await fs.readFile(ttsLegacyMetaPath, 'utf8');
  check(
    '查找增强：没有 schemaVersion 的旧书照常查找 / 高亮，书目不被补字段',
    (await exec('window.__cwTest.findSession()')).total === 1 &&
      (await exec('window.__cwTest.selection()')).start === 0 &&
      findLegacyMetaAfter === findLegacyMetaBefore &&
      findLegacyMetaAfter.includes('"schemaVersion"') === false
  );
  await exec('window.__cwTest.closeFindPanel()');
  await exec(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))"
  );
  await waitFor('window.__cwTest.findSession() === null');
  check(
    '查找增强：旧书上 Esc 也能清除高亮，正文 / 书目不动',
    (await exec('window.__cwTest.findOverlayVisible()')) === false &&
      (await exec('window.__cwTest.text()')) === '旧书正文。'
  );

  // 50m. 当前段落高亮按书记忆 + 自定义颜色（v0.8-10b，提案 N10b）：
  // 开关 / 颜色都存 config.json 的 bookDisplay（按书），没设置过的书回落全局默认；
  // 只写 config，不碰正文 / 书目 / 章节文件，旧 config / 旧书照常打开。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const caretMemConfigPath = path.join(userData, 'config.json');
  const readCaretMemConfig = async () => JSON.parse(await fs.readFile(caretMemConfigPath, 'utf8'));

  await exec("window.__cwTest.newBook('按书高亮 A')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const caretBookA = await exec('window.__cwTest.bookPathValue()');
  const caretBookIdA = await exec('window.__cwTest.bookId()');
  const caretMetaA = path.join(caretBookA, '书目.json');
  const caretMemText = '第一段：雨落在铁皮棚上。\n\n第二段：他把伞收起来。\n\n第三段：灯还亮着。';
  await exec(`window.__cwTest.setText(${JSON.stringify(caretMemText)})`);
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");
  const caretTxtNameA = JSON.parse(await fs.readFile(caretMetaA, 'utf8')).chapters[0].file;
  const caretTxtA = path.join(caretBookA, caretTxtNameA);
  const caretTxtAStat = await fs.stat(caretTxtA);
  const caretMetaABytes = await fs.readFile(caretMetaA, 'utf8');
  const caretDirABefore = (await fs.readdir(caretBookA)).sort().join('|');

  await exec("document.getElementById('btn-display').click()");
  await exec('document.querySelector(\'#display-menu button[data-action="toggle-caret-para"]\').click()');
  await waitFor("window.__cwTest.caretSettings().bookDisplay.caretParagraph === true");
  const caretCfgAOn = await readCaretMemConfig();
  check(
    '按书高亮：A 书打开开关 → 只写 config.bookDisplay[A] 的 caretParagraph=true，颜色默认跟随主题',
    Boolean(caretBookIdA) &&
      caretCfgAOn.bookDisplay[caretBookIdA].caretParagraph === true &&
      !('caretParagraphColor' in caretCfgAOn.bookDisplay[caretBookIdA]) &&
      (await exec('window.__cwTest.caretSettings()')).color === '' &&
      (await exec('window.__cwTest.caretMenuColor()')).active === '' &&
      (await exec('window.__cwTest.view()')) === 'editor'
  );
  await exec(`window.__cwTest.setCaret(${caretMemText.indexOf('第一段') + 3})`);
  await waitFor('window.__cwTest.marksCaretParaCount() === 1');
  const caretThemeInfo = await exec('window.__cwTest.marksCaretParaInfo()');
  const caretThemeColor = await exec('window.__cwTest.caretColorInfo()');
  const caretThemeRgb = (caretThemeColor.tint.match(/\d+/g) || []).slice(0, 3).join(', ');
  check(
    '按书高亮：没选自定义颜色时沿用当前背景主题配好的颜色（不写内联色、不落自定义色）',
    caretThemeColor.value === '' &&
      caretThemeColor.inlineTint === '' &&
      caretThemeColor.inlineEdge === '' &&
      caretThemeRgb.length > 0 &&
      Boolean(caretThemeInfo) &&
      caretThemeInfo.background.startsWith(`rgba(${caretThemeRgb},`) &&
      caretThemeInfo.background !== 'rgba(0, 0, 0, 0)',
    { color: caretThemeColor, info: caretThemeInfo, bodyClass: await exec('window.__cwTest.displayStyle().paperClass') }
  );

  // 色板：点湖蓝 → 立刻换色并按书保存
  await exec('document.querySelector(\'#format-caret-colors [data-caret-color="#3f7fbf"]\').click()');
  await waitFor("window.__cwTest.caretSettings().bookDisplay.caretParagraphColor === '#3f7fbf'");
  await waitFor('window.__cwTest.marksCaretParaCount() === 1');
  const caretCfgABlue = await readCaretMemConfig();
  const caretBlueInfo = await exec('window.__cwTest.marksCaretParaInfo()');
  const caretBlueColor = await exec('window.__cwTest.caretColorInfo()');
  check(
    '按书高亮：色板选「湖蓝」→ 高亮底色 / 左边线换成蓝色，颜色按书存进 config',
    caretCfgABlue.bookDisplay[caretBookIdA].caretParagraphColor === '#3f7fbf' &&
      caretBlueColor.value === '#3f7fbf' &&
      caretBlueColor.tint === 'rgba(63, 127, 191, 0.16)' &&
      caretBlueColor.edge === 'rgba(63, 127, 191, 0.82)' &&
      Boolean(caretBlueInfo) &&
      caretBlueInfo.background === 'rgba(63, 127, 191, 0.16)' &&
      caretBlueInfo.boxShadow.includes('rgba(63, 127, 191') &&
      (await exec('window.__cwTest.caretMenuColor()')).active === '#3f7fbf' &&
      (await exec('window.__cwTest.caretMenuColor()')).picker === '#3f7fbf'
  );
  const caretTxtAAfterToggle = await fs.stat(caretTxtA);
  check(
    '按书高亮：开关 / 颜色只写 config，正文 txt 与书目一个字节没动、书内没有 _trash / 临时文件',
    caretTxtAAfterToggle.size === caretTxtAStat.size &&
      caretTxtAAfterToggle.mtimeMs === caretTxtAStat.mtimeMs &&
      (await fs.readFile(caretMetaA, 'utf8')) === caretMetaABytes &&
      (await fs.readdir(caretBookA)).sort().join('|') === caretDirABefore &&
      !caretDirABefore.includes('_trash')
  );

  // 全局默认：回到书架 → 设置（全局）→ 打开 + 藤紫 → 保存
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec('window.__cwTest.openSettings()');
  const caretGlobalState = await exec('window.__cwTest.settingsCaretState()');
  check(
    '按书高亮：书架「设置」是全局默认（当前段落高亮分组照常显示，默认关 + 跟随主题）',
    (await exec('window.__cwTest.settingsScope()')) === 'global' &&
      caretGlobalState.visible === true &&
      caretGlobalState.checked === false &&
      caretGlobalState.draft === '' &&
      caretGlobalState.active === '' &&
      caretGlobalState.hint.includes('全局默认')
  );
  const caretConfigBeforeGlobalSave = await fs.readFile(caretMemConfigPath, 'utf8');
  await exec("window.__cwTest.setCheck('settings-caret-paragraph', true)");
  await exec('document.querySelector(\'#settings-caret-colors [data-settings-caret-color="#7a63b0"]\').click()');
  const caretGlobalDraft = await exec('window.__cwTest.settingsCaretState()');
  check(
    '按书高亮：设置里勾选 + 选色只改界面草稿，不点保存不写 config',
    caretGlobalDraft.checked === true &&
      caretGlobalDraft.draft === '#7a63b0' &&
      caretGlobalDraft.active === '#7a63b0' &&
      (await fs.readFile(caretMemConfigPath, 'utf8')) === caretConfigBeforeGlobalSave
  );
  await exec('window.__cwTest.saveSettings()');
  await waitFor("window.__cwTest.settingsOpen() === false");
  await waitFor("window.__cwTest.globalConfig().caretParagraph === true");
  const caretCfgGlobal = await readCaretMemConfig();
  check(
    '按书高亮：全局默认保存后落到 config 顶层（开 + 藤紫），A 书自己的湖蓝覆盖不受影响',
    caretCfgGlobal.caretParagraph === true &&
      caretCfgGlobal.caretParagraphColor === '#7a63b0' &&
      caretCfgGlobal.bookDisplay[caretBookIdA].caretParagraphColor === '#3f7fbf' &&
      (await exec('window.__cwTest.globalConfig()')).caretParagraphColor === '#7a63b0'
  );

  // B 书：没有单独设置 → 继承全局（开 + 藤紫）
  await exec("window.__cwTest.newBook('按书高亮 B')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const caretBookB = await exec('window.__cwTest.bookPathValue()');
  const caretBookIdB = await exec('window.__cwTest.bookId()');
  const caretCfgBInherit = await readCaretMemConfig();
  check(
    '按书高亮：没单独设置过的 B 书继承全局默认（开 + 藤紫），bookDisplay 里没有 B',
    (await exec('window.__cwTest.caretSettings()')).enabled === true &&
      (await exec('window.__cwTest.caretSettings()')).color === '#7a63b0' &&
      (await exec('window.__cwTest.caretColorInfo()')).tint === 'rgba(122, 99, 176, 0.16)' &&
      !('caretParagraph' in (await exec('window.__cwTest.caretSettings()')).bookDisplay) &&
      !(caretCfgBInherit.bookDisplay || {})[caretBookIdB]
  );

  // B 书单独关掉 → 覆盖全局的「开」；换书再回来仍是关
  await exec("document.getElementById('btn-display').click()");
  await exec('document.querySelector(\'#display-menu button[data-action="toggle-caret-para"]\').click()');
  await waitFor("window.__cwTest.caretSettings().bookDisplay.caretParagraph === false");
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(caretBookB)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  check(
    '按书高亮：B 书单独关掉后覆盖全局的「开」，重新打开 B 仍是关（正文 / 书目不变）',
    (await exec('window.__cwTest.caretSettings()')).enabled === false &&
      (await exec('window.__cwTest.caretSettings()')).configEnabled === false &&
      (await exec('window.__cwTest.caretSettings()')).bookDisplay.caretParagraph === false &&
      (await readCaretMemConfig()).bookDisplay[caretBookIdB].caretParagraph === false &&
      JSON.parse(await fs.readFile(path.join(caretBookB, '书目.json'), 'utf8')).chapters.length === 1
  );

  // C 书：没设置过 → 全局默认（开 + 藤紫）
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec("window.__cwTest.newBook('按书高亮 C')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const caretBookIdC = await exec('window.__cwTest.bookId()');
  const caretCfgC = await readCaretMemConfig();
  check(
    '按书高亮：另一本没设置过的 C 书同样继承全局默认，bookDisplay 里没有 C',
    (await exec('window.__cwTest.caretSettings()')).enabled === true &&
      (await exec('window.__cwTest.caretSettings()')).color === '#7a63b0' &&
      !(caretCfgC.bookDisplay || {})[caretBookIdC]
  );

  // 回到 A：这本书自己的蓝色覆盖优先于全局藤紫；「恢复本书默认」后回全局
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(caretBookA)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec(`window.__cwTest.setCaret(${caretMemText.indexOf('第二段') + 3})`);
  await waitFor('window.__cwTest.marksCaretParaCount() === 1');
  const caretAReopen = await exec('window.__cwTest.marksCaretParaInfo()');
  check(
    '按书高亮：重新打开 A 书恢复自己的开关 + 湖蓝（优先于全局默认藤紫）',
    (await exec('window.__cwTest.caretSettings()')).enabled === true &&
      (await exec('window.__cwTest.caretSettings()')).color === '#3f7fbf' &&
      Boolean(caretAReopen) &&
      caretAReopen.background === 'rgba(63, 127, 191, 0.16)' &&
      (await exec('window.__cwTest.caretMenuColor()')).active === '#3f7fbf'
  );
  await exec('window.__cwTest.openSettings()');
  const caretBookSettings = await exec('window.__cwTest.settingsCaretState()');
  check(
    '按书高亮：写作页设置是「按这本书」作用域，显示 A 的开关 / 湖蓝，并说明只影响这本书',
    (await exec('window.__cwTest.settingsScope()')) === 'book' &&
      caretBookSettings.visible === true &&
      caretBookSettings.checked === true &&
      caretBookSettings.draft === '#3f7fbf' &&
      caretBookSettings.active === '#3f7fbf' &&
      caretBookSettings.hint.includes('只影响这本书')
  );
  await exec("document.getElementById('btn-reset-book-display').click()");
  await waitFor("window.__cwTest.settingsCaretState().draft === '#7a63b0'");
  const caretCfgReset = await readCaretMemConfig();
  check(
    '按书高亮：「恢复本书默认」清掉 bookDisplay[A]（开关 + 颜色），A 回到全局默认（开 + 藤紫）',
    !(caretCfgReset.bookDisplay || {})[caretBookIdA] &&
      (await exec('window.__cwTest.caretSettings()')).enabled === true &&
      (await exec('window.__cwTest.caretSettings()')).color === '#7a63b0' &&
      (await exec('window.__cwTest.caretColorInfo()')).tint === 'rgba(122, 99, 176, 0.16)'
  );
  await exec('window.__cwTest.closeSettings()');

  // 收尾：A 的正文 / 书目从头到尾没被开关 / 换色动过
  const caretTxtAFinal = await fs.stat(caretTxtA);
  check(
    '按书高亮：全程只写 config（A 的正文 txt 大小+mtime、书目字节、书内文件列表都不变，无 _trash）',
    caretTxtAFinal.size === caretTxtAStat.size &&
      caretTxtAFinal.mtimeMs === caretTxtAStat.mtimeMs &&
      (await fs.readFile(caretMetaA, 'utf8')) === caretMetaABytes &&
      (await fs.readdir(caretBookA)).sort().join('|') === caretDirABefore &&
      !caretDirABefore.includes('.tmp-')
  );

  // 收尾：把全局默认清回（关 + 跟随主题），不给后面的用例留副作用
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec('window.__cwTest.openSettings()');
  await exec("window.__cwTest.setCheck('settings-caret-paragraph', false)");
  await exec('document.querySelector(\'#settings-caret-colors [data-settings-caret-color=""]\').click()');
  await exec('window.__cwTest.saveSettings()');
  await waitFor("window.__cwTest.settingsOpen() === false");
  await waitFor("window.__cwTest.globalConfig().caretParagraph === false");
  const caretCfgClean = await readCaretMemConfig();
  check(
    '按书高亮：全局默认能改回「关 + 跟随主题」，配置里只有顶层默认与按书覆盖，没有书库 / 章节字段',
    caretCfgClean.caretParagraph === false &&
      caretCfgClean.caretParagraphColor === '' &&
      ['books', 'chapters', 'chapterFiles', 'bookMeta'].every((key) => !(key in caretCfgClean))
  );

  // 50n. 查找书签（v0.8-11b，提案 N11b）：把当前章的查询词与大小写选项按「书 + 章」
  // 存进 config.json；打开这一章自动高亮；正文改过后按新正文重新扫描定位；面板可列 / 跳 / 删。
  // 只写 config（userData），绝不写书库 / 书目 / 章节文件，渲染层仍然没有 fs 权限。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec("window.__cwTest.newBook('查找书签测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const bmBookPath = await exec('window.__cwTest.bookPathValue()');
  const bmBookId = await exec('window.__cwTest.bookId()');
  const bmBookTitle = '查找书签测试书';
  const bmMetaPath = path.join(bmBookPath, '书目.json');
  const bmConfigPath = path.join(userData, 'config.json');
  await exec("window.__cwTest.renameChapterAt(0, '旧雨')");
  const bmText1 = '　　阿明推开门，阿明看见雨。\n\n　　巷口没有人，阿明把伞收起来。\n\n　　阿明说：雨要停了。';
  await exec(`window.__cwTest.setText(${JSON.stringify(bmText1)})`);
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");
  await exec("window.__cwTest.newChapter('归途')");
  await waitFor('window.__cwTest.currentIndex() === 1');
  const bmText2 = '　　阿明在归途上想：阿明该回家了。\n\n　　Rain rain 都停了。';
  await exec(`window.__cwTest.setText(${JSON.stringify(bmText2)})`);
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await waitFor('window.__cwTest.currentIndex() === 0');
  const bmMetaSetup = JSON.parse(await fs.readFile(bmMetaPath, 'utf8'));
  const bmMetaBeforeBytes = await fs.readFile(bmMetaPath, 'utf8');
  const bmTxt1Path = path.join(bmBookPath, bmMetaSetup.chapters[0].file);
  const bmTxt2Path = path.join(bmBookPath, bmMetaSetup.chapters[1].file);
  const bmTxt1Before = await fs.stat(bmTxt1Path);
  const bmTxt2Before = await fs.stat(bmTxt2Path);
  const bmDirBefore = (await fs.readdir(bmBookPath)).sort().join('|');
  const bmConfigBefore = JSON.parse(await fs.readFile(bmConfigPath, 'utf8'));
  const bmAllowedKeys = [
    'bookId',
    'bookPath',
    'bookTitle',
    'caseSensitive',
    'chapterId',
    'chapterIndex',
    'chapterName',
    'createdAt',
    'query',
    'updatedAt'
  ]
    .sort()
    .join(',');
  check(
    '查找书签：默认没有书签（旧配置缺字段照常打开），不在书库里留任何东西',
    (await exec('window.__cwTest.findBookmarkCount()')) === 0 &&
      Array.isArray(bmConfigBefore.findBookmarks) &&
      bmConfigBefore.findBookmarks.length === 0 &&
      (await exec('window.__cwTest.view()')) === 'editor' &&
      (await exec('window.__cwTest.findOverlayVisible()')) === false
  );

  await exec('window.__cwTest.openFindPanel()');
  await waitFor('window.__cwTest.findPanelOpen() === true');
  check(
    '查找书签：面板里的书签区默认是空状态，按钮是「存成书签」',
    (await exec('window.__cwTest.findBookmarkRows()')).length === 0 &&
      (await exec('window.__cwTest.findBookmarksCountText()')).includes('本机还没有书签') &&
      (await exec('window.__cwTest.findBookmarkButtonText()')) === '存成书签' &&
      (await exec("document.getElementById('find-bookmark-list').textContent")).includes('还没有书签')
  );

  await exec("window.__cwTest.setFindFields({ query: '阿明', scope: 'current', caseSensitive: false })");
  await exec('window.__cwTest.findRun()');
  await waitFor('window.__cwTest.findHighlightCount() === 4');
  await exec("document.getElementById('btn-find-bookmark').click()");
  await waitFor('window.__cwTest.findBookmarkCount() === 1');
  const bmCfg1 = JSON.parse(await fs.readFile(bmConfigPath, 'utf8'));
  const bmEntry1 = bmCfg1.findBookmarks[0];
  check(
    '查找书签：存成书签 → 只写 config.findBookmarks（书 + 章 + 查询词 + 大小写），不存正文',
    bmCfg1.findBookmarks.length === 1 &&
      bmEntry1.bookId === bmBookId &&
      bmEntry1.chapterId === bmMetaSetup.chapters[0].id &&
      bmEntry1.chapterIndex === 1 &&
      bmEntry1.chapterName === '旧雨' &&
      bmEntry1.bookTitle === bmBookTitle &&
      bmEntry1.bookPath === bmBookPath &&
      bmEntry1.query === '阿明' &&
      bmEntry1.caseSensitive === false &&
      Object.keys(bmEntry1).sort().join(',') === bmAllowedKeys,
    bmEntry1
  );
  await waitFor("window.__cwTest.findBookmarkRows().length === 1");
  const bmRow0 = (await exec('window.__cwTest.findBookmarkRows()'))[0];
  check(
    '查找书签：面板列出这一条（书名 · 第1章：旧雨「阿明」、标出本章、按钮变「更新本章书签」）',
    bmRow0.text.includes('《查找书签测试书》') &&
      bmRow0.text.includes('第1章：旧雨') &&
      bmRow0.text.includes('「阿明」') &&
      bmRow0.current === true &&
      (await exec('window.__cwTest.findBookmarkButtonText()')) === '更新本章书签' &&
      (await exec('window.__cwTest.findBookmarksCountText()')).includes('本机 1 个书签 · 1 本书')
  );
  check(
    '查找书签：存完立刻按当前正文高亮，状态栏小标签变成「书签 1 / 4」',
    (await exec('window.__cwTest.findSession()')).fromBookmark === true &&
      (await exec('window.__cwTest.findChipText()')) === '书签 1 / 4' &&
      (await exec('window.__cwTest.findHighlightCount()')) === 4
  );
  const bmTxt1AfterSave = await fs.stat(bmTxt1Path);
  check(
    '查找书签：存书签只写 config，章节 txt（大小 + mtime）、书目字节、书内文件列表都不变',
    bmTxt1AfterSave.size === bmTxt1Before.size &&
      bmTxt1AfterSave.mtimeMs === bmTxt1Before.mtimeMs &&
      (await fs.readFile(bmMetaPath, 'utf8')) === bmMetaBeforeBytes &&
      (await fs.readdir(bmBookPath)).sort().join('|') === bmDirBefore
  );

  // 第二章再存一条：查询词 + 区分大小写选项都按「书 + 章」持久化
  await exec('window.__cwTest.closeFindPanel()');
  await waitFor('window.__cwTest.findPanelOpen() === false');
  await exec("window.__cwTest.switchTo(1, 'discard')");
  await waitFor('window.__cwTest.currentIndex() === 1');
  await exec('window.__cwTest.openFindPanel()');
  await exec("window.__cwTest.setFindFields({ query: 'rain', scope: 'current', caseSensitive: true })");
  await exec('window.__cwTest.findRun()');
  await waitFor("window.__cwTest.findSession() && window.__cwTest.findSession().total === 1");
  await exec("document.getElementById('btn-find-bookmark').click()");
  await waitFor('window.__cwTest.findBookmarkCount() === 2');
  const bmCfg2 = JSON.parse(await fs.readFile(bmConfigPath, 'utf8'));
  check(
    '查找书签：第二章存「rain + 区分大小写」→ 两条书签按最近保存在前，大小写选项原样保留',
    bmCfg2.findBookmarks.length === 2 &&
      bmCfg2.findBookmarks[0].chapterId === bmMetaSetup.chapters[1].id &&
      bmCfg2.findBookmarks[0].query === 'rain' &&
      bmCfg2.findBookmarks[0].caseSensitive === true &&
      bmCfg2.findBookmarks[1].chapterId === bmMetaSetup.chapters[0].id
  );
  await waitFor("window.__cwTest.findBookmarkRows().length === 2");
  const bmRows2 = await exec('window.__cwTest.findBookmarkRows()');
  check(
    '查找书签：列表显示两条（第2章：归途「rain」区分大小写，只有本章那条高亮）',
    bmRows2[0].text.includes('第2章：归途') &&
      bmRows2[0].text.includes('「rain」') &&
      bmRows2[0].text.includes('区分大小写') &&
      bmRows2[0].current === true &&
      bmRows2[1].current === false &&
      (await exec('window.__cwTest.findChipText()')) === '书签 1 / 1'
  );

  // 点书签跳回第一章：关面板、切章、自动高亮 4 处
  await exec("document.querySelectorAll('#find-bookmark-list .find-bookmark-main')[1].click()");
  await waitFor('window.__cwTest.currentIndex() === 0');
  await waitFor('window.__cwTest.findHighlightCount() === 4');
  check(
    '查找书签：点书签跳到那一章 → 关面板、切章、自动高亮 4 处，查找框带回书签的条件',
    (await exec('window.__cwTest.findPanelOpen()')) === false &&
      (await exec('window.__cwTest.findSession()')).total === 4 &&
      (await exec('window.__cwTest.findSession()')).fromBookmark === true &&
      (await exec('window.__cwTest.findChipText()')) === '书签 1 / 4' &&
      (await exec('window.__cwTest.findQueryField()')) === '阿明' &&
      (await exec('window.__cwTest.findCaseField()')) === false
  );

  // 正常打开书（不经过书签面板）也自动高亮：打开的书签所在章
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bmBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await waitFor('window.__cwTest.findHighlightCount() === 4');
  check(
    '查找书签：重新打开这本书 → 回到书签所在章并自动高亮（不用再查一次）',
    (await exec('window.__cwTest.findSession()')).fromBookmark === true &&
      (await exec('window.__cwTest.findHighlightCount()')) === 4 &&
      (await exec('window.__cwTest.findChipText()')) === '书签 1 / 4' &&
      (await exec('window.__cwTest.text()')) === bmText1
  );

  // 正文改动后按新正文重扫定位：前面加一段（不含查找词）→ 保存后 4 处整体后移
  const bmPrefix = '　　开头新加的一段，没有那个词。\n\n';
  const bmText1Shifted = bmPrefix + bmText1;
  await exec(`window.__cwTest.setText(${JSON.stringify(bmText1Shifted)})`);
  await waitFor("window.__cwTest.dirty() === true");
  check(
    '查找书签：正文一改旧高亮先收起，书签本身不动（等保存后按新正文重扫）',
    (await exec('window.__cwTest.findOverlayVisible()')) === false &&
      (await exec('window.__cwTest.findChipVisible()')) === false &&
      (await exec('window.__cwTest.findBookmarkCount()')) === 2
  );
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");
  await waitFor('window.__cwTest.findHighlightCount() === 4');
  const bmIndexesShifted = await exec('window.__cwTest.findMatchIndexes()');
  check(
    '查找书签：保存后按新正文重新扫描定位（4 处整体后移，不是拿旧位置亮）',
    bmIndexesShifted.length === 4 &&
      bmIndexesShifted[0] === bmText1Shifted.indexOf('阿明') &&
      bmIndexesShifted[3] === bmText1Shifted.lastIndexOf('阿明') &&
      (await exec('window.__cwTest.findSession()')).fromBookmark === true
  );

  // 再改一次：末尾多一处命中 → 保存后 5 处
  const bmText1More = `${bmText1Shifted}\n\n　　阿明又回来了。`;
  await exec(`window.__cwTest.setText(${JSON.stringify(bmText1More)})`);
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");
  await waitFor("window.__cwTest.findSession() && window.__cwTest.findSession().total === 5");
  const bmIndexesMore = await exec('window.__cwTest.findMatchIndexes()');
  check(
    '查找书签：再改正文（多一处命中）→ 按新正文重扫成 5 处，最后一处在新位置',
    bmIndexesMore.length === 5 &&
      bmIndexesMore[4] === bmText1More.lastIndexOf('阿明') &&
      (await exec('window.__cwTest.findHighlightCount()')) === 5
  );

  // 改到没有命中：高亮收起，但书签保留；重新打开这一章仍按最新正文扫描
  const bmText1NoHit = bmText1More.replace(/阿明/g, '小明');
  await exec(`window.__cwTest.setText(${JSON.stringify(bmText1NoHit)})`);
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");
  await waitFor('window.__cwTest.findSession() === null');
  check(
    '查找书签：正文改到没有命中 → 高亮收起，书签仍保留（不因没命中被删）',
    (await exec('window.__cwTest.findBookmarkCount()')) === 2 &&
      (await exec('window.__cwTest.findOverlayVisible()')) === false &&
      (await exec('window.__cwTest.findChipVisible()')) === false &&
      JSON.parse(await fs.readFile(bmConfigPath, 'utf8')).findBookmarks.length === 2
  );
  await exec("window.__cwTest.switchTo(1, 'discard')");
  await waitFor('window.__cwTest.currentIndex() === 1');
  await waitFor('window.__cwTest.findHighlightCount() === 1');
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await waitFor('window.__cwTest.currentIndex() === 0');
  await waitFor('window.__cwTest.findSession() === null');
  check(
    '查找书签：重新打开这一章仍按最新正文扫描（没有命中就不亮），查找框带回书签条件',
    (await exec('window.__cwTest.findHighlightCount()')) === 0 &&
      (await exec('window.__cwTest.findChipVisible()')) === false &&
      (await exec('window.__cwTest.findQueryField()')) === '阿明' &&
      (await exec('window.__cwTest.text()')) === bmText1NoHit
  );

  // 改回原样：再按原位置高亮 4 处
  await exec(`window.__cwTest.setText(${JSON.stringify(bmText1)})`);
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");
  await waitFor('window.__cwTest.findHighlightCount() === 4');
  const bmIndexesFinal = await exec('window.__cwTest.findMatchIndexes()');
  check(
    '查找书签：把正文改回原样并保存后，按原位置重新高亮 4 处',
    bmIndexesFinal.length === 4 &&
      bmIndexesFinal[0] === bmText1.indexOf('阿明') &&
      bmIndexesFinal[3] === bmText1.lastIndexOf('阿明') &&
      (await exec('window.__cwTest.text()')) === bmText1
  );

  // 跨书跳转 + 删除：这一段的书库 / 书目 / 章节文件应该完全不动
  const bmTxt1BeforeOps = await fs.stat(bmTxt1Path);
  const bmTxt2BeforeOps = await fs.stat(bmTxt2Path);
  const bmMetaChaptersBeforeOps = JSON.stringify(
    JSON.parse(await fs.readFile(bmMetaPath, 'utf8')).chapters
  );
  const bmDirBeforeOps = (await fs.readdir(bmBookPath)).sort().join('|');
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec("window.__cwTest.newBook('查找书签 B')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const bmBookBPath = await exec('window.__cwTest.bookPathValue()');
  await exec('window.__cwTest.openFindPanel()');
  await waitFor("window.__cwTest.findBookmarkRows().length === 2");
  check(
    '查找书签：在另一本书里打开查找面板也能看到「本机」全部书签（带书名 / 章名）',
    (await exec('window.__cwTest.findBookmarksCountText()')).includes('本机 2 个书签 · 1 本书') &&
      (await exec('window.__cwTest.findBookmarkRows()'))[0].text.includes('《查找书签测试书》')
  );
  await exec("document.querySelectorAll('#find-bookmark-list .find-bookmark-main')[0].click()");
  await waitFor(`window.__cwTest.bookPathValue() === ${JSON.stringify(bmBookPath)}`);
  await waitFor('window.__cwTest.currentIndex() === 1');
  await waitFor('window.__cwTest.findHighlightCount() === 1');
  check(
    '查找书签：点别的书的书签 → 打开那本书的那一章，按书签条件（区分大小写）自动高亮',
    (await exec('window.__cwTest.view()')) === 'editor' &&
      (await exec('window.__cwTest.findSession()')).total === 1 &&
      (await exec('window.__cwTest.findSession()')).fromBookmark === true &&
      (await exec('window.__cwTest.findChipText()')) === '书签 1 / 1' &&
      (await exec('window.__cwTest.findQueryField()')) === 'rain' &&
      (await exec('window.__cwTest.findCaseField()')) === true,
    { bookB: bmBookBPath }
  );

  await exec('window.__cwTest.openFindPanel()');
  await waitFor("window.__cwTest.findBookmarkRows().length === 2");
  await exec("document.querySelectorAll('#find-bookmark-list .find-bookmark-delete')[0].click()");
  await waitFor('window.__cwTest.findBookmarkCount() === 1');
  await waitFor('window.__cwTest.findSession() === null');
  const bmCfgAfterDelete1 = JSON.parse(await fs.readFile(bmConfigPath, 'utf8'));
  check(
    '查找书签：删除当前章的条目 → 只删 config 里这一条，高亮收起，另一条还在',
    bmCfgAfterDelete1.findBookmarks.length === 1 &&
      bmCfgAfterDelete1.findBookmarks[0].chapterId === bmMetaSetup.chapters[0].id &&
      (await exec('window.__cwTest.findSession()')) === null &&
      (await exec('window.__cwTest.findOverlayVisible()')) === false &&
      (await exec('window.__cwTest.findChipVisible()')) === false &&
      (await exec('window.__cwTest.findBookmarkRows()')).length === 1
  );
  await exec("document.querySelectorAll('#find-bookmark-list .find-bookmark-delete')[0].click()");
  await waitFor('window.__cwTest.findBookmarkCount() === 0');
  const bmCfgClean = JSON.parse(await fs.readFile(bmConfigPath, 'utf8'));
  check(
    '查找书签：删除最后一条 → config.findBookmarks 为空，面板回到空状态，正文 / 书目不动',
    Array.isArray(bmCfgClean.findBookmarks) &&
      bmCfgClean.findBookmarks.length === 0 &&
      (await exec('window.__cwTest.findBookmarkButtonText()')) === '存成书签' &&
      (await exec("document.getElementById('find-bookmark-list').textContent")).includes('还没有书签')
  );
  const bmTxt1AfterOps = await fs.stat(bmTxt1Path);
  const bmTxt2AfterOps = await fs.stat(bmTxt2Path);
  const bmMetaChaptersAfterOps = JSON.stringify(
    JSON.parse(await fs.readFile(bmMetaPath, 'utf8')).chapters
  );
  const bmDirAfterOps = (await fs.readdir(bmBookPath)).sort().join('|');
  check(
    '查找书签：书签的存 / 跳 / 删全程不写书库（txt 大小+mtime、书目 chapters、书内文件列表都不变，无 _trash / 临时文件）',
    bmTxt1AfterOps.size === bmTxt1BeforeOps.size &&
      bmTxt1AfterOps.mtimeMs === bmTxt1BeforeOps.mtimeMs &&
      bmTxt2AfterOps.size === bmTxt2BeforeOps.size &&
      bmTxt2AfterOps.mtimeMs === bmTxt2BeforeOps.mtimeMs &&
      bmMetaChaptersAfterOps === bmMetaChaptersBeforeOps &&
      bmDirAfterOps === bmDirBeforeOps &&
      !bmDirAfterOps.includes('_trash') &&
      !bmDirAfterOps.includes('.tmp-'),
    { dir: bmDirAfterOps }
  );
  check(
    '查找书签：配置里只有查询条件（没有书库 / 章节内容字段），收尾书签为空数组',
    Array.isArray(bmCfgClean.findBookmarks) &&
      bmCfgClean.findBookmarks.length === 0 &&
      ['books', 'chapters', 'chapterFiles', 'bookMeta', 'chapterTexts'].every(
        (key) => !(key in bmCfgClean)
      )
  );
  await exec('window.__cwTest.closeFindPanel()');
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");

  // 50o. 「整理」交互改版（v0.8.5 R1，作者 2026-11-01 11:12 要求）：
  // 点「整理」= 直接用上次记住的 config.formatOptions 整理当前章（不弹窗、只改编辑区、仍是未保存、
  // Ctrl+Z / 卡里「撤销上次整理」可退回、toast 带规则摘要与改动统计、无改动时不塞撤销栈）；
  // 鼠标悬浮 / Tab 聚焦「整理」= 出「选择卡」（排版设置… / 一键整理本书… / 撤销上次整理），
  // 离开按钮与卡片（短延迟）或 Esc 后收起；原来的显示项搬到新的「显示 ▾」。
  // 全部只动编辑区 / DOM：不写章节 txt、不改书目、不生成 _trash / 临时文件。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec("window.__cwTest.newBook('整理交互测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const r1BookPath = await exec('window.__cwTest.bookPathValue()');
  const r1MetaPath = path.join(r1BookPath, '书目.json');
  const r1ConfigPath = path.join(userData, 'config.json');
  await exec("window.__cwTest.renameChapterAt(0, '第一刀')");
  const r1Messy = '他说,"你好."   \n\n\n第二段  ';
  const r1Formatted = '　　他说，"你好。"\n\n　　第二段';
  await exec(`window.__cwTest.setText(${JSON.stringify(r1Messy)})`);
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");
  const r1Meta = JSON.parse(await fs.readFile(r1MetaPath, 'utf8'));
  const r1Txt0Path = path.join(r1BookPath, r1Meta.chapters[0].file);
  const r1Txt0Before = await fs.stat(r1Txt0Path);
  const r1MetaBeforeBytes = await fs.readFile(r1MetaPath, 'utf8');
  const r1DirBefore = (await fs.readdir(r1BookPath)).sort().join('|');
  const r1ConfigKeysBefore = Object.keys(JSON.parse(await fs.readFile(r1ConfigPath, 'utf8'))).sort().join(',');
  const r1Rules = {
    indent: '2',
    blankLines: 'single',
    trimTrailing: true,
    normalizePunct: true,
    removeCjkSpaces: false,
    curlyQuotes: false,
    ellipsis: false
  };
  await exec(`window.__cwTest.setFormatOptions(${JSON.stringify(r1Rules)})`);
  check(
    '整理交互：点之前没有整理撤销步数，选择卡默认是收起的',
    (await exec('window.__cwTest.formatUndoSteps()')) === 0 &&
      (await exec('window.__cwTest.formatCardOpen()')) === false
  );

  // 50o-1. 点「整理」= 直接整理本章：不弹窗、结果只进编辑区、可撤销、toast 带规则与统计
  const r1DepthBefore = await exec('window.__cwTest.formatUndoDepth()');
  await exec("document.getElementById('btn-format').click()");
  await waitFor('window.__cwTest.formatUndoSteps() === 1');
  const r1DepthAfterClick = await exec('window.__cwTest.formatUndoDepth()');
  check(
    '整理交互：直接整理往撤销栈里正好压了一步',
    r1DepthAfterClick === r1DepthBefore + 1,
    { r1DepthBefore, r1DepthAfterClick }
  );
  const r1AfterClick = await exec('window.__cwTest.text()');
  check(
    '整理交互：点「整理」直接用记住的规则整理当前章（不弹任何对话框）',
    r1AfterClick === r1Formatted &&
      (await exec('window.__cwTest.formatDialogOpen()')) === false &&
      (await exec('window.__cwTest.modalOpen()')) === false &&
      (await exec('window.__cwTest.formatCardOpen()')) === false,
    r1AfterClick
  );
  const r1Toast = await exec("document.getElementById('toast-area').textContent");
  check(
    '整理交互：成功提示带规则摘要 + 改动统计 + 保存 / 撤销说明',
    r1Toast.includes('已整理本章（段首缩进 2 字符 · 段间空一行') &&
      r1Toast.includes('共 2 段') &&
      r1Toast.includes('标点转全角 2 处') &&
      r1Toast.includes('Ctrl+S 保存') &&
      r1Toast.includes('Ctrl+Z 撤销'),
    r1Toast
  );
  check(
    '整理交互：结果只在编辑区（仍是未保存），磁盘上的章节 txt 一个字节没动',
    (await exec('window.__cwTest.dirty()')) === true &&
      (await exec('window.__cwTest.chapterTextAt(0)')) === r1Messy
  );
  const r1Txt0AfterClick = await fs.stat(r1Txt0Path);
  check(
    '整理交互：直接整理不写书库（txt 大小 + mtime、书目字节、书内文件列表都不变，无 _trash / 临时文件）',
    r1Txt0AfterClick.size === r1Txt0Before.size &&
      r1Txt0AfterClick.mtimeMs === r1Txt0Before.mtimeMs &&
      (await fs.readFile(r1MetaPath, 'utf8')) === r1MetaBeforeBytes &&
      (await fs.readdir(r1BookPath)).sort().join('|') === r1DirBefore &&
      !(await fs.readdir(r1BookPath)).join('|').includes('_trash')
  );

  // 撤销：Ctrl+Z 也能退回（快捷键先走「撤销上次整理」的快照，没有快照才交给原生撤销）
  await exec(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))"
  );
  await sleep(200);
  check(
    '整理交互：Ctrl+Z 撤销上次整理 → 编辑区回到整理前，快照栈清空',
    (await exec('window.__cwTest.text()')) === r1Messy &&
      (await exec('window.__cwTest.formatUndoSteps()')) === 0 &&
      // 磁盘上本来就是整理前的内容，所以撤销后又变回「已保存」状态（没有脏改动）
      (await exec('window.__cwTest.dirty()')) === false &&
      (await exec('window.__cwTest.chapterTextAt(0)')) === r1Messy
  );

  // 再整理一次 → 已经很干净时再点：只提示「本章已经是整理后的格式，没有可改的地方」，不往撤销栈里塞东西
  await exec("document.getElementById('btn-format').click()");
  await waitFor('window.__cwTest.formatUndoSteps() === 1');
  await exec("document.getElementById('btn-format').click()");
  await sleep(300);
  const r1NoChangeToast = await exec("document.getElementById('toast-area').textContent");
  check(
    '整理交互：无改动时提示「本章已经是整理后的格式，没有可改的地方」，不动正文、撤销步数不增加',
    r1NoChangeToast.includes('本章已经是整理后的格式，没有可改的地方') &&
      r1NoChangeToast.includes('规则：') &&
      (await exec('window.__cwTest.text()')) === r1Formatted &&
      (await exec('window.__cwTest.formatUndoSteps()')) === 1 &&
      (await exec('window.__cwTest.formatUndoDepth()')) === r1DepthAfterClick,
    r1NoChangeToast
  );
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");

  // 50o-2. 悬浮 / 聚焦出「选择卡」，离开按钮与卡片（短延迟）或 Esc 收起
  // 选择卡是「按钮下方」的下拉层：如果（真实的）鼠标指针正好停在卡片要出现的位置，
  // Chromium 会在卡片显示后补发一次 trusted pointerenter（卡片又展开），
  // 这样「离开后收起」就永远等不到。E2E 先把模拟指针挪到正文区，再派发悬浮 / 离开事件。
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 60, y: 360 });
  await sleep(120);
  await exec(
    "document.getElementById('format-dropdown').dispatchEvent(new PointerEvent('pointerenter'))"
  );
  await waitFor('window.__cwTest.formatCardOpen() === true');
  const r1CardItems = await exec('window.__cwTest.formatCardItems()');
  check(
    '整理交互：悬浮「整理」出选择卡，卡里正好三项（排版设置… / 一键整理本书… / 撤销上次整理）',
    r1CardItems.map((item) => item.action).join(',') === 'settings,apply-book,undo' &&
      r1CardItems[0].label.includes('排版设置') &&
      r1CardItems[1].label.includes('一键整理本书') &&
      r1CardItems[2].label.includes('撤销上次整理（可撤销 1 步）') &&
      r1CardItems[2].disabled === false,
    r1CardItems
  );
  check(
    '整理交互：选择卡顶上一句说明 + 卡片里都是真按钮（键盘可 Tab / Enter）',
    (await exec('window.__cwTest.formatCardNote()')).includes('点「整理」') &&
      (await exec(
        "Array.from(document.querySelectorAll('#format-menu button[data-action]')).every((el) => el.tagName === 'BUTTON' && el.type === 'button')"
      )) === true &&
      (await exec("document.getElementById('btn-format').tagName")) === 'BUTTON' &&
      (await exec("document.getElementById('btn-format').textContent")).includes('整理')
  );
  await exec(
    "document.getElementById('format-dropdown').dispatchEvent(new PointerEvent('pointerleave'))"
  );
  await sleep(120);
  check(
    '整理交互：鼠标刚离开时卡片还在（留出从按钮挪到卡片的时间）',
    (await exec('window.__cwTest.formatCardOpen()')) === true
  );
  await waitFor('window.__cwTest.formatCardOpen() === false', 4000);
  check('整理交互：离开按钮与卡片后（短延迟）自动收起', (await exec('window.__cwTest.formatCardOpen()')) === false);

  // 键盘：Tab 聚焦「整理」按钮也出卡；Esc 收起
  // 先 blur 再 focus：保证焦点确实发生「变化」（若按钮已经是 activeElement，focus() 是空操作，
  // 不会派发 focusin，这里会白等到超时——2026-11-01 基线首跑偶发过一次）。
  // 再确认窗口有系统焦点（2026-11-01 v0.9 B-4 第二轮复跑踩到：跑到这里时窗口被别的窗口抢走焦点，
  // `document.hasFocus()` 为 false，Chromium 不给程序化的 focus() 派发 focusin，
  // 现场是 `{activeId:"btn-format", hasFocus:false}`——按钮已经是 activeElement，卡片却不出）。
  await ensureWindowFocus();
  await exec('if (document.activeElement && document.activeElement.blur) document.activeElement.blur()');
  await exec("document.getElementById('btn-format').focus()");
  await waitFor('window.__cwTest.formatCardOpen() === true');
  check(
    '整理交互：键盘聚焦「整理」按钮也出选择卡',
    (await exec('window.__cwTest.formatCardOpen()')) === true &&
      (await exec('document.activeElement.id')) === 'btn-format'
  );
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await sleep(80);
  check(
    '整理交互：Esc 收起选择卡（焦点留在按钮上，不丢给正文）',
    (await exec('window.__cwTest.formatCardOpen()')) === false &&
      (await exec('window.__cwTest.text()')) === r1Formatted &&
      (await exec('window.__cwTest.dirty()')) === false
  );

  // 50o-3. 卡里三项分别可用：排版设置… 打开原对话框
  await exec('window.__cwTest.openFormatMenu()');
  await exec("document.querySelector('#format-menu button[data-action=\"settings\"]').click()");
  await waitFor('window.__cwTest.formatDialogOpen() === true');
  check(
    '整理交互：卡里「排版设置…」打开原来的智能排版对话框，卡片同时收起',
    (await exec('window.__cwTest.formatDialogOpen()')) === true &&
      (await exec('window.__cwTest.formatCardOpen()')) === false &&
      (await exec('window.__cwTest.dialog()')) === null
  );
  await waitFor("window.__cwTest.formatSummary() !== '正在预览…'");
  check(
    '整理交互：对话框照样有实时预览（这章已经整理过，提示没有可改的地方）',
    (await exec('window.__cwTest.formatSummary()')).includes('没有可改的地方')
  );
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor('window.__cwTest.formatDialogOpen() === false');
  check(
    '整理交互：关掉对话框后正文不动（对话框本身仍是预览 + 套用到本章）',
    (await exec('window.__cwTest.text()')) === r1Formatted &&
      (await exec('window.__cwTest.dirty()')) === false
  );

  // 50o-4. 卡里「一键整理本书…」打开原来的整本确认框；取消后不写盘
  await exec("window.__cwTest.newChapter('第二刀')");
  await waitFor('window.__cwTest.currentIndex() === 1');
  const r1Messy2 = ' 第二段,"脏."  ';
  await exec(`window.__cwTest.setText(${JSON.stringify(r1Messy2)})`);
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");
  const r1MetaAfterSecond = JSON.parse(await fs.readFile(r1MetaPath, 'utf8'));
  const r1Txt1Path = path.join(r1BookPath, r1MetaAfterSecond.chapters[1].file);
  const r1Txt1Before = await fs.stat(r1Txt1Path);
  const r1Txt0BeforeModal = await fs.stat(r1Txt0Path);
  const r1MetaBeforeModal = await fs.readFile(r1MetaPath, 'utf8');
  const r1DirBeforeModal = (await fs.readdir(r1BookPath)).sort().join('|');
  await exec('window.__cwTest.openFormatMenu()');
  await exec("document.querySelector('#format-menu button[data-action=\"apply-book\"]').click()");
  await waitFor('window.__cwTest.modalOpen()');
  check(
    '整理交互：卡里「一键整理本书…」打开原来的整本确认框（规则摘要仍是同一套文案）',
    (await exec('window.__cwTest.dialog()')) === '一键整理本书' &&
      (await exec('window.__cwTest.modalMessage()')).includes('规则：段首缩进 2 字符 · 段间空一行') &&
      (await exec('window.__cwTest.formatCardOpen()')) === false
  );
  await exec("window.__cwTest.answerModal('cancel')");
  await waitFor('window.__cwTest.modalOpen() === false');
  check(
    '整理交互：整本整理取消后一个字都没写（txt 大小 + mtime、书目、书内文件列表不变）',
    (await fs.stat(r1Txt1Path)).mtimeMs === r1Txt1Before.mtimeMs &&
      (await fs.stat(r1Txt0Path)).mtimeMs === r1Txt0BeforeModal.mtimeMs &&
      (await fs.readFile(r1MetaPath, 'utf8')) === r1MetaBeforeModal &&
      (await fs.readdir(r1BookPath)).sort().join('|') === r1DirBeforeModal
  );

  // 50o-5. 卡里「撤销上次整理」：有 N 步时可点、点了退回；没步数时是灰的
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await waitFor('window.__cwTest.currentIndex() === 0');
  check(
    '整理交互：这一章还有 1 步可撤销（切回来仍然连着）',
    (await exec('window.__cwTest.formatUndoSteps()')) === 1
  );
  await exec('window.__cwTest.openFormatMenu()');
  const r1UndoItem = (await exec('window.__cwTest.formatCardItems()'))[2];
  check(
    '整理交互：卡片里「撤销上次整理（可撤销 1 步）」可点',
    r1UndoItem.disabled === false && r1UndoItem.label === '撤销上次整理（可撤销 1 步）',
    r1UndoItem
  );
  await exec("document.querySelector('#format-menu button[data-action=\"undo\"]').click()");
  await sleep(200);
  check(
    '整理交互：卡里点「撤销上次整理」→ 回到整理前（仍是编辑区、未保存）',
    (await exec('window.__cwTest.text()')) === r1Messy &&
      (await exec('window.__cwTest.dirty()')) === true &&
      (await exec('window.__cwTest.formatUndoSteps()')) === 0 &&
      (await exec('window.__cwTest.chapterTextAt(0)')) === r1Formatted
  );
  check(
    '整理交互：卡里撤销全程没有内部错误（toast 里不出现「内部错误」）',
    !(await exec("document.getElementById('toast-area').textContent")).includes('内部错误')
  );
  await exec('window.__cwTest.openFormatMenu()');
  const r1UndoItemEmpty = (await exec('window.__cwTest.formatCardItems()'))[2];
  check(
    '整理交互：没有可撤销的步数时，卡片里那一项是灰的、文案不带数字',
    r1UndoItemEmpty.disabled === true && r1UndoItemEmpty.label === '撤销上次整理',
    r1UndoItemEmpty
  );
  await exec('window.__cwTest.closeFormatMenu()');
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");

  // 50o-6. 原来的显示项搬到「显示 ▾」：点一下展开，仍是只改 CSS 的显示（正文不动）
  const r1TextBeforeDisplay = await exec('window.__cwTest.text()');
  const r1Txt0BeforeDisplay = await fs.stat(r1Txt0Path);
  const r1MetaBeforeDisplay = await fs.readFile(r1MetaPath, 'utf8');
  await exec("document.getElementById('btn-display').click()");
  await waitFor('window.__cwTest.displayMenuOpen() === true');
  const r1DisplayActions = await exec('window.__cwTest.displayMenuItems()');
  check(
    '整理交互：「显示 ▾」接管原来的显示项（三档预设 / 三个开关 / 正文显示设置）',
    ['preset-compact', 'preset-normal', 'preset-loose', 'toggle-invisibles', 'toggle-long-para', 'toggle-caret-para', 'display-settings'].every(
      (action) => r1DisplayActions.includes(action)
    ),
    r1DisplayActions
  );
  await exec("document.querySelector('#display-menu button[data-action=\"display-settings\"]').click()");
  await waitFor('window.__cwTest.settingsOpen() === true');
  check(
    '整理交互：「正文显示设置…」打开设置并收起显示菜单',
    (await exec('window.__cwTest.displayMenuOpen()')) === false &&
      (await exec('window.__cwTest.settingsOpen()')) === true
  );
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor('window.__cwTest.settingsOpen() === false');
  check(
    '整理交互：打开 / 关掉显示设置不碰正文，也不写书库',
    (await exec('window.__cwTest.text()')) === r1TextBeforeDisplay &&
      (await exec('window.__cwTest.dirty()')) === false &&
      (await fs.stat(r1Txt0Path)).mtimeMs === r1Txt0BeforeDisplay.mtimeMs &&
      (await fs.readFile(r1MetaPath, 'utf8')) === r1MetaBeforeDisplay &&
      (await fs.readdir(r1BookPath)).sort().join('|') === r1DirBeforeModal &&
      !(await fs.readdir(r1BookPath)).join('|').includes('_trash')
  );
  check(
    '整理交互：全程没有给配置加新字段（只沿用 formatOptions），书库里也没有多出文件',
    Object.keys(JSON.parse(await fs.readFile(r1ConfigPath, 'utf8'))).sort().join(',') ===
      r1ConfigKeysBefore
  );
  // 50p. 前端界面优化（v0.8.5 R2）：顶栏按钮分组 / 间距 / 悬停按下禁用反馈、
  // 下拉菜单与悬浮选择卡视觉统一、章节列表当前章强调、状态栏信息层级、
  // 1294×766（作者窗口）与窄窗口不挤压、亮色与夜间两套主题都成立。
  // 纯 CSS / class 改动：按钮 id、顺序、事件都不变；不写章节 txt / 书目，不给配置加字段。
  const uiBookSidebar = await exec('window.__cwTest.sidebarWidth()');
  const uiTxt0Before = await fs.stat(r1Txt0Path);
  const uiMetaBefore = await fs.readFile(r1MetaPath, 'utf8');
  const uiDirBefore = (await fs.readdir(r1BookPath)).sort().join('|');
  const uiLayout = await exec(`(() => {
    const header = document.querySelector('.editor-header');
    const groups = Array.from(document.querySelectorAll('.editor-actions > .action-group'));
    const groupIds = groups.map((g) => Array.from(g.querySelectorAll(':scope > .btn, :scope > .dropdown > .btn')).map((b) => b.id));
    const save = document.getElementById('btn-save');
    const items = Array.from(document.querySelectorAll('.editor-actions .btn')).concat([save]);
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { id: el.id, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, ws: cs.whiteSpace, opacity: cs.opacity, cursor: cs.cursor, disabled: el.disabled };
    };
    const rects = items.map(rect);
    const overlaps = [];
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i];
        const b = rects[j];
        if (a.width > 0 && b.width > 0 && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps.push([a.id, b.id]);
      }
    }
    const clipped = rects.filter((r) => r.left < -0.5 || r.right > window.innerWidth + 0.5 || r.width < 36 || r.height < 26);
    const sep = groups.length > 1 ? getComputedStyle(groups[1], '::before') : null;
    const menuPick = (id) => {
      const cs = getComputedStyle(document.getElementById(id));
      return { id, bg: cs.backgroundColor, border: cs.borderTopColor, radius: cs.borderTopLeftRadius, shadow: cs.boxShadow, pad: cs.paddingTop + '/' + cs.paddingLeft, minWidth: cs.minWidth };
    };
    return {
      vw: window.innerWidth,
      headerH: Math.round(header.getBoundingClientRect().height),
      groups: groups.length,
      groupIds,
      saveParent: save.parentElement.className,
      rects,
      clipped,
      overlaps,
      sep: sep ? { width: sep.width, height: sep.height } : null,
      menus: ['format-menu', 'display-menu', 'export-menu'].map(menuPick),
      menuItem: (() => { const cs = getComputedStyle(document.querySelector('#display-menu button')); return { radius: cs.borderTopLeftRadius, minHeight: cs.minHeight }; })(),
      chapter: (() => {
        const active = document.querySelector('.chapter-item.active');
        const sidebar = document.getElementById('sidebar');
        if (!active || !sidebar) return null;
        const a = getComputedStyle(active);
        const bar = getComputedStyle(active, '::before');
        return { bg: a.backgroundColor, sidebarBg: getComputedStyle(sidebar).backgroundColor, borderW: a.borderLeftWidth, borderColor: a.borderLeftColor, weight: a.fontWeight, radius: a.borderTopLeftRadius, ring: a.boxShadow, barW: bar.width, barBg: bar.backgroundColor };
      })(),
      status: (() => {
        const bar = document.querySelector('.statusbar');
        const char = document.getElementById('char-count');
        const hints = document.querySelector('.status-hints');
        if (!bar || !char || !hints) return null;
        return { barH: Math.round(bar.getBoundingClientRect().height), charBorder: getComputedStyle(char).borderLeftWidth, hintBorder: getComputedStyle(hints).borderLeftWidth, hintDisplay: getComputedStyle(hints).display, kbd: hints.querySelectorAll('.kbd').length, statusWeight: getComputedStyle(document.getElementById('status-text')).fontWeight };
      })(),
      save: (() => {
        const el = document.getElementById('btn-save');
        const cs = getComputedStyle(el);
        const probe = document.createElement('button');
        probe.className = 'btn primary';
        probe.style.position = 'absolute';
        probe.style.visibility = 'hidden';
        document.body.appendChild(probe);
        const enabledBg = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const rect = rects.find((r) => r.id === 'btn-save') || {};
        return { ...rect, disabled: el.disabled === true, opacity: cs.opacity, cursor: cs.cursor, bg: cs.backgroundColor, enabledBg };
      })()
    };
  })()`);
  const uiTops = uiLayout.rects.map((r) => Math.round(r.top));
  check(
    '界面优化：顶栏按「写作 / 插入 / 整理与显示 / 导出」分成 4 组，按钮 id 与顺序不变、保存按钮独立在组外',
    uiLayout.groups === 4 &&
      JSON.stringify(uiLayout.groupIds) ===
        JSON.stringify([
          ['btn-find', 'btn-focus', 'btn-reading', 'btn-proofread', 'btn-tts'],
          ['btn-capture', 'btn-insert-fragment', 'btn-insert'],
          ['btn-format', 'btn-display'],
          ['btn-export']
        ]) &&
      uiLayout.saveParent.split(' ').includes('editor-header'),
    { groups: uiLayout.groups, groupIds: uiLayout.groupIds, saveParent: uiLayout.saveParent }
  );
  check(
    '界面优化：组与组之间有一条 1×18px 的细分隔线（不是靠大空隙硬隔开）',
    Boolean(uiLayout.sep) && uiLayout.sep.width === '1px' && uiLayout.sep.height === '18px',
    uiLayout.sep
  );
  check(
    '界面优化：顶栏按钮不折字、不互相重叠、不被窗口裁掉（宽度 / 高度都完整）',
    uiLayout.clipped.length === 0 &&
      uiLayout.overlaps.length === 0 &&
      uiLayout.rects.every((r) => r.ws === 'nowrap'),
    { vw: uiLayout.vw, clipped: uiLayout.clipped, overlaps: uiLayout.overlaps }
  );
  check(
    '界面优化：禁用的「保存」有明确的禁用外观（不是实心主按钮色 + 默认光标）',
    uiLayout.save && uiLayout.save.disabled === true && uiLayout.save.cursor === 'default' && uiLayout.save.bg !== uiLayout.save.enabledBg,
    uiLayout.save
  );
  const uiMenuSig = uiLayout.menus.map((m) => [m.bg, m.border, m.radius, m.shadow, m.pad].join('|'));
  check(
    '界面优化：下拉菜单与悬浮选择卡视觉统一（同一套底色 / 描边 / 圆角 / 投影 / 内边距）',
    new Set(uiMenuSig).size === 1 && uiLayout.menus[0].radius === '2px',
    uiLayout.menus
  );
  check(
    '界面优化：菜单条目统一 32px 高、2px 圆角（三处弹层同一套）',
    uiLayout.menuItem.radius === '2px' && uiLayout.menuItem.minHeight === '32px',
    uiLayout.menuItem
  );
  check(
    '界面优化：章节列表当前章有更重的底色 + 2px 左侧强调线 + 1px 细边，和侧栏底色分得开',
    uiLayout.chapter &&
      uiLayout.chapter.borderW === '1px' &&
      uiLayout.chapter.weight === '600' &&
      uiLayout.chapter.radius === '2px' &&
      uiLayout.chapter.bg !== uiLayout.chapter.sidebarBg &&
      uiLayout.chapter.ring === 'none' &&
      uiLayout.chapter.barW === '2px' &&
      uiLayout.chapter.barBg !== 'rgba(0, 0, 0, 0)',
    uiLayout.chapter
  );
  check(
    '界面优化：状态栏用细竖线分出「本章字数 / 快捷键」层级，两条快捷键提示成组',
    uiLayout.status &&
      uiLayout.status.barH === 34 &&
      uiLayout.status.charBorder === '1px' &&
      uiLayout.status.hintBorder === '1px' &&
      uiLayout.status.hintDisplay !== 'none' &&
      uiLayout.status.kbd === 2,
    uiLayout.status
  );

  // 1294×766（作者窗口）：默认 250px 章节栏时顶栏仍是一行，按钮完整可见
  const uiOrigBounds = win.getBounds();
  // 窗口 resize 是异步的（偶发拿到上一次的 innerWidth，见 harness.setWindowSize 注释）：
  // 宽窗等内宽 ≥ 1200、窄窗等 ≤ 960 再量；下面断言本身一个字没改。
  await setWindowSize(1294, 766, { minInner: 1200 });
  await sleep(200);
  const uiWide = await exec(`(() => {
    const header = document.querySelector('.editor-header');
    const items = Array.from(document.querySelectorAll('.editor-actions .btn')).concat([document.getElementById('btn-save')]);
    const rects = items.map((el) => { const r = el.getBoundingClientRect(); return { id: el.id, l: r.left, r: r.right, t: Math.round(r.top), w: r.width, h: r.height }; });
    return { vw: window.innerWidth, headerH: Math.round(header.getBoundingClientRect().height), rects, sidebar: window.__cwTest.sidebarWidth() };
  })()`);
  check(
    '界面优化：1294×766 顶栏一行放下全部按钮（不挤压、不裁切、标题不换行）',
    uiWide.vw >= 1200 &&
      new Set(uiWide.rects.map((r) => r.t)).size === 1 &&
      uiWide.headerH <= 64 &&
      uiWide.rects.every((r) => r.l >= -0.5 && r.r <= uiWide.vw + 0.5 && r.w >= 40),
    uiWide
  );
  await setWindowSize(uiOrigBounds.width, uiOrigBounds.height, { minInner: 1000 });
  await sleep(200);

  // 窄窗口（960 宽，应用允许的最小值）：顶栏自动排成两行，按钮仍然完整可见
  await setWindowSize(960, 700, { maxInner: 960 });
  await sleep(200);
  const uiNarrow = await exec(`(() => {
    const header = document.querySelector('.editor-header');
    const items = Array.from(document.querySelectorAll('.editor-actions .btn')).concat([document.getElementById('btn-save')]);
    const rects = items.map((el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { id: el.id, l: r.left, r: r.right, t: Math.round(r.top), w: r.width, h: r.height, ws: cs.whiteSpace }; });
    const overlaps = [];
    for (let i = 0; i < rects.length; i += 1) for (let j = i + 1; j < rects.length; j += 1) {
      const a = rects[i]; const b = rects[j];
      if (a.l < b.r - 1 && b.l < a.r - 1 && a.t === b.t && a.t < b.t + b.h - 1 && b.t < a.t + a.h - 1) overlaps.push([a.id, b.id]);
    }
    return { vw: window.innerWidth, headerH: Math.round(header.getBoundingClientRect().height), rows: new Set(rects.map((r) => r.t)).size, rects, overlaps };
  })()`);
  check(
    '界面优化：960 窄窗口顶栏排成两行（标题 + 保存 / 工具按钮），按钮不折字、不重叠、不出窗口',
    uiNarrow.vw <= 960 &&
      uiNarrow.rows >= 2 &&
      uiNarrow.overlaps.length === 0 &&
      uiNarrow.rects.every((r) => r.ws === 'nowrap' && r.l >= -0.5 && r.r <= uiNarrow.vw + 0.5 && r.w >= 40 && r.h >= 26),
    uiNarrow
  );
  await setWindowSize(uiOrigBounds.width, uiOrigBounds.height, { minInner: 1000 });
  await sleep(300);
  check(
    '界面优化：窗口尺寸来回变完，顶栏回到原布局（按钮顺序 / 分组没乱）',
    (await exec("document.querySelectorAll('.editor-actions > .action-group').length")) === 4 &&
      (await exec("document.querySelector('.editor-header').getBoundingClientRect().height")) < 90
  );

  // 亮色 / 夜间两套主题：夜间时菜单 / 选择卡 / 当前章 / 状态栏都换成深色，不是白底浅字
  const uiBookId = await exec('window.__cwTest.bookId()');
  const uiConfigPaperBefore = JSON.parse(await fs.readFile(r1ConfigPath, 'utf8')).editorPaper;
  await exec('window.__cwTest.openSettings()');
  await waitFor('window.__cwTest.settingsOpen() === true');
  await exec("window.__cwTest.setSelect('settings-paper', 'night')");
  await sleep(250);
  const uiNight = await exec(`(() => {
    const pick = (el) => { const cs = getComputedStyle(el); return { bg: cs.backgroundColor, border: cs.borderTopColor, color: cs.color }; };
    const rgb = (value) => (value.match(/\\d+/g) || []).map(Number);
    const menu = pick(document.getElementById('format-menu'));
    const item = pick(document.querySelector('#format-menu button'));
    const bar = pick(document.querySelector('.statusbar'));
    const active = pick(document.querySelector('.chapter-item.active'));
    const lightActiveBg = ${JSON.stringify(uiLayout.chapter.bg)};
    return { bodyClass: document.body.className, menu, item, bar, active, menuDark: rgb(menu.bg).slice(0, 3).every((n) => n < 80), itemLight: rgb(item.color).slice(0, 3).every((n) => n > 150), barDark: rgb(bar.bg).slice(0, 3).every((n) => n < 80), activeDiff: active.bg !== lightActiveBg };
  })()`);
  check(
    '界面优化：夜间主题下菜单 / 选择卡是深色底、浅色字（不出现白底白字）',
    uiNight.bodyClass.includes('theme-night') &&
      uiNight.menuDark &&
      uiNight.itemLight &&
      uiNight.menu.border !== 'rgba(0, 0, 0, 0)' &&
      uiNight.barDark &&
      uiNight.activeDiff,
    uiNight
  );
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor('window.__cwTest.settingsOpen() === false');
  await sleep(250);
  const uiConfigAfterPreview = JSON.parse(await fs.readFile(r1ConfigPath, 'utf8'));
  check(
    '界面优化：夜间只是界面预览（关掉设置后配置里仍是原主题、这本书没有多出夜间覆盖）',
    uiConfigAfterPreview.editorPaper === uiConfigPaperBefore &&
      !(uiConfigAfterPreview.bookDisplay && uiConfigAfterPreview.bookDisplay[uiBookId] && uiConfigAfterPreview.bookDisplay[uiBookId].editorPaper) &&
      !(await exec('document.body.className')).includes('theme-night'),
    { paper: uiConfigAfterPreview.editorPaper, before: uiConfigPaperBefore, bookDisplay: uiConfigAfterPreview.bookDisplay ? uiConfigAfterPreview.bookDisplay[uiBookId] : null }
  );

  // 分组 / 换行之后按钮仍然接原来的事件：点「查找」照常开面板，Esc 关掉
  await exec("document.getElementById('btn-find').click()");
  await waitFor('window.__cwTest.findPanelOpen() === true');
  check(
    '界面优化：顶栏重新分组后按钮事件不变（点「查找」照常打开查找面板）',
    (await exec('window.__cwTest.findPanelOpen()')) === true
  );
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor('window.__cwTest.findPanelOpen() === false');
  check(
    '界面优化：界面调整全程不写书库（txt 大小 + mtime、书目、书内文件列表都不变，无 _trash / 临时文件）',
    (await fs.stat(r1Txt0Path)).size === uiTxt0Before.size &&
      (await fs.stat(r1Txt0Path)).mtimeMs === uiTxt0Before.mtimeMs &&
      (await fs.readFile(r1MetaPath, 'utf8')) === uiMetaBefore &&
      (await fs.readdir(r1BookPath)).sort().join('|') === uiDirBefore &&
      !(await fs.readdir(r1BookPath)).join('|').includes('_trash')
  );
  const uiTextAfter = await exec('window.__cwTest.text()');
  const uiDirtyAfter = await exec('window.__cwTest.dirty()');
  const uiConfigKeysAfter = Object.keys(JSON.parse(await fs.readFile(r1ConfigPath, 'utf8'))).sort().join(',');
  check(
    '界面优化：章节正文与未保存状态都没被界面操作碰到，配置也没加新字段',
    uiTextAfter === r1Messy && uiDirtyAfter === false && uiConfigKeysAfter === r1ConfigKeysBefore,
    {
      sidebar: uiBookSidebar,
      textSame: uiTextAfter === r1Messy,
      textNow: uiTextAfter,
      textExpected: r1Messy,
      dirty: uiDirtyAfter,
      keysNow: uiConfigKeysAfter,
      keysBefore: r1ConfigKeysBefore
    }
  );

  // 50q. 代码精简（v0.8.5 R3）回归：菜单定位 / 菜单条目样式这些被合并的公共 helper，
  // 行为仍和以前一样（只读：不写书库、不改配置、不动正文）。
  const r3Menu = await exec(`(() => {
    const styleOf = (el) => {
      const cs = getComputedStyle(el);
      return {
        minHeight: cs.minHeight, paddingTop: cs.paddingTop, paddingLeft: cs.paddingLeft,
        radius: cs.borderTopLeftRadius, font: cs.fontSize, family: cs.fontFamily,
        color: cs.color, bg: cs.backgroundColor, border: cs.borderTopWidth, align: cs.textAlign
      };
    };
    document.getElementById('btn-display').click();
    const displayMenu = document.getElementById('display-menu');
    const displayRect = displayMenu.getBoundingClientRect();
    const displayStyle = styleOf(displayMenu.querySelector('button'));
    const chapter = document.querySelectorAll('#chapter-list .chapter-item')[0];
    chapter.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 120 }));
    const contextMenu = document.getElementById('context-menu');
    const contextRect = contextMenu.getBoundingClientRect();
    const contextStyle = styleOf(contextMenu.querySelector('button'));
    const sep = (el) => { const cs = getComputedStyle(el); return [cs.height, cs.marginTop, cs.marginLeft, cs.backgroundColor].join('|'); };
    return {
      displayOpen: !displayMenu.classList.contains('hidden'),
      displayInside: displayRect.left >= 0 && displayRect.right <= window.innerWidth && displayRect.top >= 0 && displayRect.bottom <= window.innerHeight,
      contextLeft: contextRect.left,
      contextTop: contextRect.top,
      displayStyle,
      contextStyle,
      dropdownSep: sep(document.querySelector('.dropdown-sep')),
      contextSep: sep(document.querySelector('.context-menu-sep'))
    };
  })()`);
  check(
    '代码精简：下拉菜单仍在窗口内、右键菜单仍出现在鼠标处（合并后的定位 helper 行为不变）',
    r3Menu.displayOpen &&
      r3Menu.displayInside &&
      Math.abs(r3Menu.contextLeft - 100) < 1.5 &&
      Math.abs(r3Menu.contextTop - 120) < 1.5,
    { displayOpen: r3Menu.displayOpen, displayInside: r3Menu.displayInside, left: r3Menu.contextLeft, top: r3Menu.contextTop }
  );
  const r3StyleKeys = ['minHeight', 'paddingTop', 'paddingLeft', 'radius', 'font', 'family', 'color', 'bg', 'border', 'align'];
  check(
    '代码精简：菜单条目并成同一套基础样式后，下拉菜单与右键菜单的计算样式仍一致',
    r3StyleKeys.every((key) => r3Menu.displayStyle[key] === r3Menu.contextStyle[key]),
    { display: r3Menu.displayStyle, context: r3Menu.contextStyle }
  );
  check(
    '代码精简：两条分隔线合并后仍是 1px 高、同样的外边距与颜色',
    r3Menu.dropdownSep === r3Menu.contextSep && r3Menu.dropdownSep.startsWith('1px'),
    { dropdownSep: r3Menu.dropdownSep, contextSep: r3Menu.contextSep }
  );

  // 右键点在窗口右下角（离边 2px）：整张菜单收进可视区，不越界
  const r3EdgeMenu = await exec(`(() => {
    const chapter = document.querySelectorAll('#chapter-list .chapter-item')[0];
    chapter.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: window.innerWidth - 2, clientY: window.innerHeight - 2 }));
    const menu = document.getElementById('context-menu');
    const r = menu.getBoundingClientRect();
    return { hidden: menu.classList.contains('hidden'), left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: window.innerWidth, h: window.innerHeight };
  })()`);
  check(
    '代码精简：右键菜单在窗口右下角自动收进可视区（不越界、条目都点得到）',
    r3EdgeMenu.hidden === false &&
      r3EdgeMenu.left >= 0 &&
      r3EdgeMenu.top >= 0 &&
      r3EdgeMenu.right <= r3EdgeMenu.w &&
      r3EdgeMenu.bottom <= r3EdgeMenu.h,
    r3EdgeMenu
  );
  const r3MenuHidden = await exec(`(() => {
    document.getElementById('editor').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return document.getElementById('context-menu').classList.contains('hidden');
  })()`);
  check('代码精简：点正文别处照常收起右键菜单（合并后的 hideMenu 行为不变）', r3MenuHidden === true);
  await exec("document.getElementById('btn-display').click()");
  await waitFor('window.__cwTest.displayMenuOpen() === true');
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor('window.__cwTest.displayMenuOpen() === false');
  check('代码精简：「显示 ▾」菜单照常 Esc 收起', (await exec('window.__cwTest.displayMenuOpen()')) === false);

  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");

  // 50r. 代码精简（v0.8.5 R3）回归第 2 组：书卡右键菜单同样收进窗口；
  // 整本校对（共用逐章读取 helper）遇到「章节 txt 被外部挪走」仍然跳过那一章跑完、且绝不重建影子文件。
  const r3BookMenu = await exec(`(() => {
    const card = document.querySelector('.book-card[data-path]');
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: window.innerWidth - 2, clientY: window.innerHeight - 2 }));
    const menu = document.getElementById('book-menu');
    const r = menu.getBoundingClientRect();
    return { open: !menu.classList.contains('hidden'), left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: window.innerWidth, h: window.innerHeight, items: menu.querySelectorAll('button').length };
  })()`);
  check(
    '代码精简：书卡右键菜单在右下角也收进可视区，菜单项一个不少',
    r3BookMenu.open &&
      r3BookMenu.left >= 0 &&
      r3BookMenu.top >= 0 &&
      r3BookMenu.right <= r3BookMenu.w &&
      r3BookMenu.bottom <= r3BookMenu.h &&
      r3BookMenu.items >= 3,
    r3BookMenu
  );
  await exec("document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))");

  await exec("window.__cwTest.newBook('精简回归测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const r3BookPath = await exec('window.__cwTest.bookPathValue()');
  await exec("window.__cwTest.renameChapterAt(0, '第一章')");
  await exec("window.__cwTest.setText('第一章：他走了,没有回头。')");
  await exec('window.__cwTest.save()');
  await exec("window.__cwTest.newChapter('第二章')");
  await exec("window.__cwTest.setText('第二章：风停了,雨也停了。')");
  await exec('window.__cwTest.save()');
  const r3MetaPath = path.join(r3BookPath, '书目.json');
  const r3Meta = JSON.parse(await fs.readFile(r3MetaPath, 'utf8'));
  check('代码精简回归：准备了一本 2 章的书', r3Meta.chapters.length === 2, r3Meta.chapters.length);
  const r3MissingFile = r3Meta.chapters[0].file;
  const r3MovedPath = path.join(path.dirname(booksRoot), 'r3-moved-chapter.txt');
  await fs.rename(path.join(r3BookPath, r3MissingFile), r3MovedPath);
  await exec('window.__cwTest.openProofreadPanel()');
  await waitFor("window.__cwTest.proofreadSummary().includes('本章')");
  await exec("window.__cwTest.setProofreadScope('book')");
  const r3BookProof = await exec('window.__cwTest.proofreadRun()');
  const r3ProofPayload = await exec('window.__cwTest.proofreadPayload()');
  check(
    '代码精简回归：整本校对遇到缺文件的章仍跑完（跳过 1 章、其余章照常统计）',
    r3BookProof.ok === true &&
      r3ProofPayload &&
      r3ProofPayload.skippedChapters === 1 &&
      r3ProofPayload.chapterCount === 2 &&
      r3ProofPayload.total > 0,
    { run: r3BookProof, skipped: r3ProofPayload && r3ProofPayload.skippedChapters, total: r3ProofPayload && r3ProofPayload.total }
  );
  check(
    '代码精简回归：整本校对没有重建被外部挪走的章节文件（绝不生成影子 txt）',
    (await fileExists(path.join(r3BookPath, r3MissingFile))) === false
  );
  await fs.rename(r3MovedPath, path.join(r3BookPath, r3MissingFile));
  await exec('window.__cwTest.closeProofreadPanel()');
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec("window.__cwTest.deleteBookByFolder('精简回归测试书', { skipConfirm: true })");
};
