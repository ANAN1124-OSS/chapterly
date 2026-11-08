// E2E 第 72 组：剪贴板面板（2026-11-07 单列表视图改造，契约 v1 重写）。
//
// 覆盖链路：直捕 pending → 列表一条记录 + 「正文」「章节」两个按钮 → 正文插入当前章光标处
// （多段原样 / 有选区替换 / 只标脏不自动保存 / 插入成功后这条记录消失、不能重复点）→ 章节新建的三条标题规则
// （首行标题行 / <100 字整条当章名 / 长正文整条进正文自动编号）→ 队列路径（后台监听连续复制
// 两段 → 2 条记录；正文、章节都消费；「当前章之后」插入位置）→ 清空 / Esc / 空队列文案
// → 隐私（列表只有截断的 previewText、日志里没有正文）。
//
// 只走临时书库 + 临时 userData（run-e2e.js 已隔离）；真实系统剪贴板集成不在这里碰：
// 工作站锁屏时 Windows 会拒绝 clipboard.readText()（恒空），后台监听用 clipboard:test-set
// 注入文本（仅 automation 频道；生产路径仍是真实剪贴板读取）。主进程触发那条路径直接
// send('capture:triggered')，与真实全局快捷键 Ctrl+Alt+V 走的渲染层入口完全一样。
//
// 断言只依赖契约里的公开面（capture-ui 的 DOM / 测试钩子 / 主进程队列 IPC），不读模块内部状态；
// 章名 / 正文口径由 core/capture.js 的 splitRecordTitle 决定，这里按冻结口径逐条核。
const fs = require('node:fs/promises');
const path = require('node:path');

// 「正字数」口径：去掉所有空白后的 UTF-16 长度（与 core/chapters.js 的 countChars 一致）。
const countChars = (text) => String(text == null ? '' : text).replace(/\s/g, '').length;
// 章节 txt 落盘统一 CRLF（core/chapters.js 的 toDiskNewlines）：比较时先折回 LF。
const toLf = (text) => String(text == null ? '' : text).replace(/\r\n?/g, '\n');
const todayKey = (now = new Date()) => {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

// ---------- 直捕样本：9 行 / 含空行 / 尾部标记刻意放在第 6 行之后 ----------
// 列表预览只截 300 字 / 6 行（core/capture.recordPreview），尾部标记不该出现在 DOM 里；
// 但点「正文」时整条原文必须一字不差地插进编辑区（预览截断 ≠ 内容截断）。
const DIRECT_MARKER = 'DIRECT_BODY_MARKER';
const DIRECT_TAIL_MARKER = 'DIRECT_TAIL_MARKER';
const DIRECT_TEXT = [
  `第一段（${DIRECT_MARKER}）：这一整段是从主进程剪贴板触发里带过来的原文，用来验证列表只有一条「当前剪贴板」记录；为了超过预览的六行上限，下面还会多写几行。`,
  '',
  '第二段：段与段之间的空行要原样保留，插入之后编辑区里这两段之间仍然是一行空行。',
  '',
  '第三段：等到插入完成以后，这一段也会出现在编辑区里，而列表 DOM 只应该显示前面六行的预览。',
  '',
  '第四段：多写一行，确保预览真的被截断（而不是整条都显示）。',
  '',
  `尾巴标记 ${DIRECT_TAIL_MARKER} 放在最后一行：正文插进去之后应该能在编辑区里找到它，列表预览里不应该出现它。`
].join('\n');

// 当前章原有正文：光标放在最后一行前面，插入后应正好嵌在中间。
const BASE_TEXT = [
  '开篇第一行：这是当前章节原有的正文。',
  '',
  '中间那一行后面要插入剪贴板里的内容。',
  '',
  '收尾最后一行。'
].join('\n');
const INSERT_AT = BASE_TEXT.indexOf('收尾最后一行。');
const REPLACE_TARGET = '收尾最后一行。';

// ---------- 章节三规则的样本（口径见 CONTRACT §3 splitRecordTitle） ----------
// 规则①：首行标题行（≤40 字）+ 其余正文正字数 ≥50 → 章名=标题行，正文不含标题行、
// 标题行后的连续空行去掉（正文不以空行开头），正文内部空行保留。
const RULE1_TITLE = '第7章 标题行测试';
const RULE1_BODY = [
  '标题行下面的第一段正文：这段用来验证章名取的是标题行，而正文里不再包含它，段落之间的空行要保留。',
  '',
  '第二段正文：内容要够长，让「标题行 + 其余正文不少于五十个字」这条规则成立，否则整条会被当成短内容。'
].join('\n');
const RULE1_TEXT = `${RULE1_TITLE}\n\n\n${RULE1_BODY}`; // 标题行后故意留两个空行

// 规则②：整条正字数 <100 → 章名=整条内容（空白折成一个空格 + trim，可超过 40 字），正文为空。
const RULE2_TEXT = '短内容整条当章名。\n第二行也并进章名里';
const RULE2_NAME = '短内容整条当章名。 第二行也并进章名里';

// 规则③：否则章名留空（界面自动「第N章」），整条内容原样进正文。
const RULE3_TEXT = [
  '这一段开头没有章节标题，所以整条内容都会原样写进正文，章名留空交给界面自动生成「第N章」。为了触发第三条规则，整条要超过一百个字，这里多写几句把字数堆上去，确保测试不会因为差几个字而走成短内容规则。',
  '',
  '第二段：内部空行也要原样保留下来，正文一个字都不改动。'
].join('\n');

// ---------- 队列样本：两次复制各一段（都带标题行，拆章时按规则①） ----------
const QUEUE_A_MARKER = 'QUEUE_A_BODY_MARKER';
const QUEUE_B_MARKER = 'QUEUE_B_BODY_MARKER';
const QUEUE_D_MARKER = 'QUEUE_D_BODY_MARKER';
const QUEUE_A_TITLE = '第8章 队列甲段';
const QUEUE_A_BODY = [
  `${QUEUE_A_MARKER}：先复制的一段，用来验证队列第 1 条只把这一段写进新章；这里多写一些字，让标题之后的正文字数稳稳超过五十个字。`,
  '甲段第二行：正文内部的换行要保留。'
].join('\n');
const QUEUE_A_TEXT = `${QUEUE_A_TITLE}\n\n${QUEUE_A_BODY}`;
const QUEUE_B_TITLE = '第8章 队列乙段';
const QUEUE_B_BODY = [
  `${QUEUE_B_MARKER}：后复制的一段，用来验证逐条消费不会串到前面那一条；这一段也写长一点，保证标题之后的正文字数超过五十个字。`,
  '乙段第二行：正文内部换行同样保留。'
].join('\n');
const QUEUE_B_TEXT = `${QUEUE_B_TITLE}\n\n${QUEUE_B_BODY}`;

module.exports = async function group72Capture(t) {
  const { exec, check, waitFor, sleep, deleteBookWithRetry, userData, win, readLogs } = t;
  const booksRoot = t.booksRoot;
  const statsPath = path.join(userData, 'stats.json');
  const readMeta = async (bookPath) => JSON.parse(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'));
  const readChapterDisk = async (bookPath, file) => toLf(await fs.readFile(path.join(bookPath, file), 'utf8'));

  // 72a. 造一本干净的书（自带一个空章）：后面所有章节都从这一本里长出来
  await exec("window.__cwTest.newBook('剪贴板面板测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const bookPath = await exec('window.__cwTest.bookPathValue()');
  check(
    '剪贴板面板：顶栏「捕获」按钮就位（界面显式触发入口）',
    (await exec("Boolean(document.getElementById('btn-capture'))")) === true
  );

  // 72b. 直捕：主进程 capture:triggered（真实全局快捷键走的就是这条链路）→ 列表里只有 pending 一条
  await win.webContents.send('capture:triggered', { text: DIRECT_TEXT, accelerator: 'Control+Alt+V' });
  await waitFor('window.__cwTest.captureOpen() === true');
  check(
    '剪贴板面板：主进程 capture:triggered 触发后打开单列表视图',
    (await exec('window.__cwTest.captureOpen()')) === true &&
      (await exec('window.__cwTest.captureView()')) === 'list'
  );
  const pendingRecords = await exec('window.__cwTest.captureRecords()');
  check(
    '剪贴板面板：直捕的多段正文在列表里仍只有一条「当前剪贴板（未入队）」记录（不按行拆）',
    pendingRecords.length === 1 &&
      pendingRecords[0].kind === 'pending' &&
      typeof pendingRecords[0].previewText === 'string' &&
      pendingRecords[0].previewText.includes(DIRECT_MARKER),
    { pendingRecords }
  );
  const pendingDom = await exec(`(() => {
    const rows = Array.from(document.querySelectorAll('#capture-queue-list .capture-record'));
    const row = rows[0] || null;
    const buttons = row ? Array.from(row.querySelectorAll('button[data-action]')) : [];
    return {
      count: rows.length,
      pending: Boolean(row && row.dataset.pending === '1'),
      hasQueueId: Boolean(row && row.dataset.id),
      actions: buttons.map((btn) => btn.dataset.action),
      labels: buttons.map((btn) => btn.textContent.trim()),
      hasBadge: Boolean(row && row.querySelector('.capture-record-badge')),
      previewText: row ? String(row.querySelector('.capture-record-text').textContent) : '',
      emptyHidden: document.getElementById('capture-queue-empty').classList.contains('hidden'),
      summary: document.getElementById('capture-queue-summary').textContent,
      position: document.getElementById('capture-position').value
    };
  })()`);
  check(
    '剪贴板面板：pending 记录整块展示（序号 / 字数 / 预览 / 当前剪贴板标记），空态收起、插入位置默认全书末尾',
    pendingDom.count === 1 &&
      pendingDom.pending === true &&
      pendingDom.hasQueueId === false &&
      pendingDom.hasBadge === true &&
      pendingDom.emptyHidden === true &&
      pendingDom.position === 'end' &&
      pendingDom.summary.includes('当前剪贴板'),
    pendingDom
  );
  check(
    '剪贴板面板：pending 记录有两个按钮「正文」「章节」，都带 data-action（点击委托入口）',
    pendingDom.actions.length === 2 &&
      pendingDom.actions.includes('body') &&
      pendingDom.actions.includes('chapter') &&
      pendingDom.labels.includes('正文') &&
      pendingDom.labels.includes('章节'),
    pendingDom
  );
  // 隐私：列表正文区只是截断预览（300 字 / 6 行），原文尾部标记不应出现在 DOM 里
  check(
    '剪贴板面板：列表只显示截断预览，DOM 里没有 pending 原文的尾部标记（隐私）',
    pendingDom.previewText.includes(DIRECT_MARKER) &&
      pendingDom.previewText.includes(DIRECT_TAIL_MARKER) === false &&
      pendingDom.previewText.length <= 301,
    { previewLength: pendingDom.previewText.length }
  );

  // 72c. 「正文」按钮：插到当前打开章节的光标处，多段与空行原样、面板不关、插入成功后消费该条、只标脏
  await exec(`window.__cwTest.setText(${JSON.stringify(BASE_TEXT)})`);
  await exec(`window.__cwTest.setCaret(${INSERT_AT})`);
  const expectedAfterInsert = BASE_TEXT.slice(0, INSERT_AT) + DIRECT_TEXT + BASE_TEXT.slice(INSERT_AT);
  await exec("document.querySelector('#capture-queue-list button[data-action=\"body\"]').click()");
  await waitFor(`window.__cwTest.text().includes(${JSON.stringify(DIRECT_TAIL_MARKER)})`);
  const textAfterInsert = await exec('window.__cwTest.text()');
  check(
    '剪贴板面板：点「正文」插到当前章光标处，多段与空行原样保留',
    textAfterInsert === expectedAfterInsert,
    { got: textAfterInsert.length, want: expectedAfterInsert.length }
  );
  check(
    '剪贴板面板：插入后光标停在插入内容末尾（这条已消费，不会误插到前面）',
    (await exec('window.__cwTest.caret()')) === INSERT_AT + DIRECT_TEXT.length
  );
  const afterBodyState = {
    open: await exec('window.__cwTest.captureOpen()'),
    records: await exec('window.__cwTest.captureRecords()'),
    dirty: await exec('window.__cwTest.dirty()'),
    titles: await exec('window.__cwTest.chapterTitles()'),
    index: await exec('window.__cwTest.currentIndex()')
  };
  check(
    '剪贴板面板：正文插入后面板保持打开、这一条随即消失（正文也消费记录）、正文标脏、没有新建章节',
    afterBodyState.open === true &&
      afterBodyState.records.length === 0 &&
      afterBodyState.dirty === true &&
      afterBodyState.titles.length === 1 &&
      afterBodyState.index === 0,
    { afterBodyState }
  );
  // 只标脏、不自动保存：磁盘上这一章还是建书时的空文件
  const metaBefore = await readMeta(bookPath);
  const diskBeforeSave = await readChapterDisk(bookPath, metaBefore.chapters[0].file);
  check(
    '剪贴板面板：正文只标脏不自动保存（磁盘上的原章还是空的）',
    diskBeforeSave === '',
    { diskBeforeSave }
  );

  // 72c2. 记录消费后同一段不能再点第二次（避免重复插入）：列表清空、再调返回 NO_PENDING、文字不变
  const repeatResult = JSON.parse(
    await exec('window.__cwTest.captureApplyBody({ pending: true }).then((r) => JSON.stringify(r || null))')
  );
  const textAfterRepeat = await exec('window.__cwTest.text()');
  const afterBodyDom = await exec(`(() => ({
    rows: document.querySelectorAll('#capture-queue-list .capture-record').length,
    emptyHidden: document.getElementById('capture-queue-empty').classList.contains('hidden'),
    open: window.__cwTest.captureOpen()
  }))()`);
  check(
    '剪贴板面板：正文消费后列表清空、空态出现，再点不会重复插入（NO_PENDING）',
    repeatResult.ok === false &&
      repeatResult.code === 'NO_PENDING' &&
      textAfterRepeat === expectedAfterInsert &&
      afterBodyDom.rows === 0 &&
      afterBodyDom.emptyHidden === false &&
      afterBodyDom.open === true,
    { repeatResult, afterBodyDom }
  );

  // 72c3. 有选区时替换选区（不是插在选区两侧）：记录已消费，重新打开面板再给一次同一段直捕原文
  await exec('window.__cwTest.closeCapture()');
  await exec(`window.__cwTest.openCapture(${JSON.stringify(DIRECT_TEXT)})`);
  await waitFor('window.__cwTest.captureOpen() === true && window.__cwTest.captureRecords().length === 1');
  const replaceRange = await exec(`(() => {
    const text = window.__cwTest.text();
    const at = text.lastIndexOf(${JSON.stringify(REPLACE_TARGET)});
    window.__cwTest.selectRange(at, at + ${JSON.stringify(REPLACE_TARGET)}.length);
    return { at };
  })()`);
  const expectedAfterReplace =
    textAfterInsert.slice(0, replaceRange.at) +
    DIRECT_TEXT +
    textAfterInsert.slice(replaceRange.at + REPLACE_TARGET.length);
  await exec("document.querySelector('#capture-queue-list button[data-action=\"body\"]').click()");
  await waitFor(`window.__cwTest.text() === ${JSON.stringify(expectedAfterReplace)}`);
  const textAfterReplace = await exec('window.__cwTest.text()');
  check(
    '剪贴板面板：编辑区有选区时「正文」替换选区（不是插在两侧）',
    textAfterReplace === expectedAfterReplace &&
      textAfterReplace.includes(REPLACE_TARGET) === false,
    { got: textAfterReplace.length, want: expectedAfterReplace.length }
  );

  // 72d. 章节规则①：首行标题行 → 章名=标题行，正文不含标题行；写前先保存当前章的未保存正文
  // 直捕 pending 只保留「最近一次触发」：先把这一条换成规则①样本，否则点「章节」用的还是 72b 的直捕原文。
  await exec('window.__cwTest.closeCapture()');
  await exec(`window.__cwTest.openCapture(${JSON.stringify(RULE1_TEXT)})`);
  await waitFor('window.__cwTest.captureOpen() === true');
  await waitFor('window.__cwTest.captureRecords().length === 1');
  const beforeRule1Text = await exec('window.__cwTest.text()');
  const beforeRule1Titles = await exec('window.__cwTest.chapterTitles()');
  await exec("document.querySelector('#capture-queue-list button[data-action=\"chapter\"]').click()");
  await waitFor(`window.__cwTest.chapterTitles().length === ${beforeRule1Titles.length + 1}`);
  await waitFor('window.__cwTest.dirty() === false');
  const meta1 = await readMeta(bookPath);
  const chapter1 = meta1.chapters[1];
  const disk1 = await readChapterDisk(bookPath, chapter1.file);
  const diskPrev = await readChapterDisk(bookPath, meta1.chapters[0].file);
  check(
    '剪贴板面板：首行是标题行（≤40 字）且正文 ≥50 字 → 章名=标题行、正文不含标题行',
    meta1.chapters.length === 2 &&
      chapter1.name === RULE1_TITLE &&
      disk1 === RULE1_BODY &&
      disk1.includes(RULE1_TITLE) === false,
    { chapterName: chapter1.name, disk1 }
  );
  check(
    '剪贴板面板：标题行后的连续空行被去掉（正文不以空行开头），正文内部空行保留',
    disk1.startsWith('\n') === false && disk1.includes('\n\n') === true && disk1 === RULE1_BODY,
    { disk1 }
  );
  check(
    '剪贴板面板：新建章节前先保存当前章的未保存正文（saveCurrent，不弹询问）',
    toLf(diskPrev) === beforeRule1Text,
    { got: diskPrev.length, want: beforeRule1Text.length }
  );
  const afterRule1 = {
    titles: await exec('window.__cwTest.chapterTitles()'),
    text: await exec('window.__cwTest.text()'),
    index: await exec('window.__cwTest.currentIndex()'),
    dirty: await exec('window.__cwTest.dirty()'),
    open: await exec('window.__cwTest.captureOpen()'),
    records: await exec('window.__cwTest.captureRecords()')
  };
  check(
    '剪贴板面板：章节成功后编辑器跳到新章、面板保持打开、pending 记录清空',
    afterRule1.text === RULE1_BODY &&
      afterRule1.titles[1] === RULE1_TITLE &&
      afterRule1.index === 1 &&
      afterRule1.dirty === false &&
      afterRule1.open === true &&
      afterRule1.records.length === 0,
    { afterRule1 }
  );
  // 统计口径（契约 §4）：只有正文正字数 >0 才记当日统计，写章成功即计入
  const statsAfterRule1 = JSON.parse(await fs.readFile(statsPath, 'utf8'));
  const todayAfterRule1 = (statsAfterRule1.days && statsAfterRule1.days[todayKey()]) || {};
  check(
    '剪贴板面板：新建章节的正文字数计入当日统计（按书）',
    Number((todayAfterRule1.books || {})[meta1.id] || 0) >= countChars(RULE1_BODY),
    { today: todayAfterRule1, bookId: meta1.id, expectedAtLeast: countChars(RULE1_BODY) }
  );

  // 72d2. 章节规则②：整条 <100 字 → 章名=整条内容（空白折成一个空格），正文为空章节
  await exec('window.__cwTest.closeCapture()');
  await exec(`window.__cwTest.openCapture(${JSON.stringify(RULE2_TEXT)})`);
  await waitFor('window.__cwTest.captureOpen() === true');
  await waitFor('window.__cwTest.captureRecords().length === 1');
  await exec("document.querySelector('#capture-queue-list button[data-action=\"chapter\"]').click()");
  await waitFor(`window.__cwTest.chapterTitles().length === ${afterRule1.titles.length + 1}`);
  const meta2 = await readMeta(bookPath);
  const chapter2 = meta2.chapters[2];
  const disk2 = await readChapterDisk(bookPath, chapter2.file);
  const afterRule2 = {
    text: await exec('window.__cwTest.text()'),
    index: await exec('window.__cwTest.currentIndex()'),
    open: await exec('window.__cwTest.captureOpen()'),
    records: await exec('window.__cwTest.captureRecords()')
  };
  check(
    '剪贴板面板：整条 <100 字 → 章名=整条内容（空白折成一个空格）、正文为空',
    chapter2.name === RULE2_NAME && disk2 === '' && afterRule2.text === '',
    { chapterName: chapter2.name, disk2, text: afterRule2.text }
  );
  check(
    '剪贴板面板：短内容成章后面板保持打开、pending 记录清空、编辑器停在新章',
    afterRule2.open === true && afterRule2.records.length === 0 && afterRule2.index === 2,
    { afterRule2 }
  );

  // 72d3. 章节规则③：长正文且认不出标题行 → 章名留空（界面自动「第N章」），整条原样进正文
  await exec('window.__cwTest.closeCapture()');
  await exec(`window.__cwTest.openCapture(${JSON.stringify(RULE3_TEXT)})`);
  await waitFor('window.__cwTest.captureOpen() === true');
  await waitFor('window.__cwTest.captureRecords().length === 1');
  const rule3Result = JSON.parse(
    await exec('window.__cwTest.captureCreateChapter({ pending: true }).then((r) => JSON.stringify(r || null))')
  );
  const meta3 = await readMeta(bookPath);
  const chapter3 = meta3.chapters[3];
  const disk3 = await readChapterDisk(bookPath, chapter3.file);
  const afterRule3 = {
    titles: await exec('window.__cwTest.chapterTitles()'),
    text: await exec('window.__cwTest.text()'),
    index: await exec('window.__cwTest.currentIndex()'),
    open: await exec('window.__cwTest.captureOpen()'),
    records: await exec('window.__cwTest.captureRecords()')
  };
  check(
    '剪贴板面板：长正文认不出标题行 → 章名留空（界面自动「第N章」）、整条原样进正文',
    meta3.chapters.length === 4 &&
      chapter3.name === '' &&
      disk3 === RULE3_TEXT &&
      afterRule3.text === RULE3_TEXT &&
      afterRule3.titles[3] === '第4章' &&
      afterRule3.index === 3,
    { chapterName: chapter3.name, title: afterRule3.titles[3], disk3, afterRule3 }
  );
  check(
    '剪贴板面板：规则③成章后面板保持打开、pending 记录清空',
    rule3Result.ok === true &&
      afterRule3.open === true &&
      afterRule3.records.length === 0
  );
  await exec('window.__cwTest.closeCapture()');

  // 72e. 队列路径：设置里打开后台监听（真实开关）→ 连续复制 A / B 两段各记一条
  const chapterCountBeforeQueue = meta3.chapters.length;
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec('window.__cwTest.openSettings()');
  await waitFor('window.__cwTest.settingsOpen() === true');
  await exec("window.__cwTest.setCheck('settings-clipboard-watch', true)");
  await exec('window.__cwTest.saveSettings()');
  await waitFor('window.api.getConfig().then((r) => r.ok && r.data.clipboardWatchEnabled === true)');
  check(
    '剪贴板面板：设置里打开后台监听（真实开关，配置真的落盘）',
    (await exec('window.api.getConfig()')).data.clipboardWatchEnabled === true
  );
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(bookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  // 打开监听时主进程会先异步读一次剪贴板当基线（读完之前不记录）：等基线落定再注入，免得第一段
  // 被当成「打开监听时已有的内容」。config:set 已经落盘，这里只是给基线那一次异步读留时间。
  await sleep(300);
  await exec('window.api.captureQueueClear()');
  await waitFor('window.__cwTest.captureQueue().then((list) => list.length === 0)');
  await exec('window.__cwTest.clearToasts()');

  // 工作站锁屏时系统剪贴板读不到：用 automation 专用频道注入文本并立刻跑一拍监听
  //（生产路径仍是 clipboard.readText()，见 main.js 的 readClipboardForWatch）。
  await exec(`window.api.setClipboardWatchTestText(${JSON.stringify(QUEUE_A_TEXT)})`);
  await waitFor('window.__cwTest.captureQueue().then((list) => list.length === 1)');
  await exec(`window.api.setClipboardWatchTestText(${JSON.stringify(QUEUE_B_TEXT)})`);
  await waitFor('window.__cwTest.captureQueue().then((list) => list.length === 2)');
  const queueEntries = await exec('window.__cwTest.captureQueue()');
  check(
    '剪贴板面板：监听开着时连续复制两段（每段都是多行正文）各记一条、顺序旧 → 新、字数不同',
    queueEntries.length === 2 &&
      queueEntries[0].id < queueEntries[1].id &&
      String(queueEntries[0].previewText).includes(QUEUE_A_TITLE) &&
      String(queueEntries[1].previewText).includes(QUEUE_B_TITLE) &&
      queueEntries[0].previewText.split('\n').length > 1 &&
      queueEntries[0].chars !== queueEntries[1].chars,
    { queueEntries }
  );
  // 隐私：队列元数据只有 previewText / preview，没有正文（text）字段
  check(
    '剪贴板面板：队列列表只下发展示元数据（previewText / preview），没有正文 text 字段（隐私）',
    queueEntries.every(
      (entry) =>
        typeof entry.previewText === 'string' &&
        entry.previewText.length <= 301 &&
        Object.prototype.hasOwnProperty.call(entry, 'text') === false
    ),
    { keys: queueEntries.map((entry) => Object.keys(entry)) }
  );

  // 顶栏「捕获」：队列非空 → 直接打开列表（2 条队列记录，不读当前剪贴板）
  await exec("document.getElementById('btn-capture').click()");
  await waitFor("window.__cwTest.captureOpen() === true && window.__cwTest.captureView() === 'list'");
  await waitFor('window.__cwTest.captureRecords().length === 2');
  const queueListView = await exec(`(() => {
    const rows = Array.from(document.querySelectorAll('#capture-queue-list .capture-record'));
    return {
      count: rows.length,
      ids: rows.map((row) => row.dataset.id || ''),
      pending: rows.some((row) => row.dataset.pending === '1'),
      buttons: rows.map((row) => Array.from(row.querySelectorAll('button[data-action]')).map((btn) => btn.dataset.action)),
      emptyHidden: document.getElementById('capture-queue-empty').classList.contains('hidden'),
      summary: document.getElementById('capture-queue-summary').textContent
    };
  })()`);
  const queueRecords = await exec('window.__cwTest.captureRecords()');
  check(
    '剪贴板面板：顶栏「捕获」打开列表，2 条队列记录各带两个 data-action 按钮',
    queueListView.count === 2 &&
      queueListView.pending === false &&
      queueListView.ids[0] === String(queueEntries[0].id) &&
      queueListView.ids[1] === String(queueEntries[1].id) &&
      queueListView.buttons.every((actions) => actions.includes('body') && actions.includes('chapter')) &&
      queueListView.emptyHidden === true &&
      queueListView.summary.includes('共记了 2 段') &&
      queueRecords.length === 2 &&
      queueRecords.every((record) => record.kind === 'queue'),
    { queueListView, queueRecords }
  );

  // 72e2. 队列「正文」：插入当前章（A 段整条原样），**消费**该条（正文也用完即消失）
  const queueChapterBefore = await exec('window.__cwTest.text()');
  await exec(`window.__cwTest.setCaret(${queueChapterBefore.length})`);
  const idA = queueEntries[0].id;
  const idB = queueEntries[1].id;
  await exec(
    `document.querySelector('#capture-queue-list .capture-record[data-id="${idA}"] button[data-action="body"]').click()`
  );
  await waitFor(`window.__cwTest.text().includes(${JSON.stringify(QUEUE_A_MARKER)})`);
  const afterQueueBody = {
    text: await exec('window.__cwTest.text()'),
    queue: await exec('window.__cwTest.captureQueue()'),
    records: await exec('window.__cwTest.captureRecords()'),
    open: await exec('window.__cwTest.captureOpen()'),
    dirty: await exec('window.__cwTest.dirty()')
  };
  check(
    '剪贴板面板：从队列点「正文」把整条原文插到当前章末尾（标题行 + 正文都进编辑区）',
    afterQueueBody.text === queueChapterBefore + QUEUE_A_TEXT &&
      afterQueueBody.text.includes(QUEUE_A_BODY) &&
      afterQueueBody.dirty === true,
    { got: afterQueueBody.text.length, want: (queueChapterBefore + QUEUE_A_TEXT).length }
  );
  check(
    '剪贴板面板：队列「正文」插入成功后该条被消费（只剩另 1 条，面板保持打开）',
    afterQueueBody.queue.length === 1 &&
      afterQueueBody.queue[0].id === idB &&
      afterQueueBody.records.length === 1 &&
      afterQueueBody.open === true,
    { queue: afterQueueBody.queue.length, records: afterQueueBody.records.length }
  );

  // 72e3. 队列「章节」：插入位置选「当前章之后」→ 新章插在当前章（第 1 章）后面，并消费该条
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await waitFor('window.__cwTest.currentIndex() === 0');
  const positionValue = await exec(`(() => {
    const el = document.getElementById('capture-position');
    el.value = 'after-current';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  })()`);
  await exec(
    `document.querySelector('#capture-queue-list .capture-record[data-id="${idB}"] button[data-action="chapter"]').click()`
  );
  await waitFor(`window.__cwTest.chapterTitles().length === ${chapterCountBeforeQueue + 1}`);
  const meta4 = await readMeta(bookPath);
  const chapterB = meta4.chapters[1];
  const diskB = await readChapterDisk(bookPath, chapterB.file);
  const afterQueueChapter = {
    queue: await exec('window.__cwTest.captureQueue()'),
    records: await exec('window.__cwTest.captureRecords()'),
    open: await exec('window.__cwTest.captureOpen()'),
    index: await exec('window.__cwTest.currentIndex()')
  };
  check(
    '剪贴板面板：选「当前章之后」时新章插在当前章后面（第 1 章之后），章名 / 正文按规则①拆分',
    positionValue === 'after-current' &&
      meta4.chapters.length === chapterCountBeforeQueue + 1 &&
      chapterB.name === QUEUE_B_TITLE &&
      diskB === QUEUE_B_BODY &&
      meta4.chapters[2].name === RULE1_TITLE,
    { chapterName: chapterB.name, diskB, order: meta4.chapters.map((chapter) => chapter.name) }
  );
  check(
    '剪贴板面板：章节成功后该条队列记录删除、面板保持打开、编辑器跳到新章',
    afterQueueChapter.queue.length === 0 &&
      afterQueueChapter.records.length === 0 &&
      afterQueueChapter.open === true &&
      afterQueueChapter.index === 1,
    { afterQueueChapter }
  );

  // 72f. 清空队列：先再复制一段（保证列表有东西），清空后列表清空、空态说明出现、面板不关
  // （只清内存，不碰章节 / 文件）
  await exec(`window.api.setClipboardWatchTestText(${JSON.stringify('第9章 待清空段')})`);
  await waitFor('window.__cwTest.captureQueue().then((list) => list.length === 1)');
  await waitFor('window.__cwTest.captureRecords().length === 1');
  await exec("document.getElementById('btn-capture-queue-clear').click()");
  await waitFor('window.__cwTest.captureQueue().then((list) => list.length === 0)');
  await waitFor('window.__cwTest.captureRecords().length === 0');
  const clearedState = await exec(`(() => ({
    rows: document.querySelectorAll('#capture-queue-list .capture-record').length,
    emptyHidden: document.getElementById('capture-queue-empty').classList.contains('hidden'),
    emptyText: document.getElementById('capture-queue-empty').textContent,
    summary: document.getElementById('capture-queue-summary').textContent,
    open: window.__cwTest.captureOpen()
  }))()`);
  check(
    '剪贴板面板：清空队列 → 列表清空、出现空态说明（面板不关，只清内存）',
    clearedState.rows === 0 &&
      clearedState.emptyHidden === false &&
      clearedState.emptyText.includes('后台监听') &&
      clearedState.summary.includes('还没有记到') &&
      clearedState.open === true,
    clearedState
  );

  // 72f2. 回归（2026-11-07）：「复制 4 次只记 2 次」——短文本（<20 字）也入队，
  // 且面板开着时列表靠 clipboard:recorded 即时刷新（短复制没有轻提示）。
  await exec(`window.api.setClipboardWatchTestText(${JSON.stringify('第9章 短标题')})`);
  await waitFor('window.__cwTest.captureQueue().then((list) => list.length === 1)');
  await waitFor('window.__cwTest.captureRecords().length === 1');
  const shortCopy = await exec('window.__cwTest.captureRecords()');
  check(
    '剪贴板面板：短于 20 字的复制也入队（不再被长度门槛吞掉），面板开着时列表即时刷新',
    shortCopy.length === 1 &&
      shortCopy[0].kind === 'queue' &&
      String(shortCopy[0].previewText).includes('第9章 短标题'),
    { shortCopy }
  );

  // 72g. Esc 关面板（capture 层仍走 captureUi.cancel()；处理中不关由跑完的处理保证）
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor('window.__cwTest.captureOpen() === false');
  check('剪贴板面板：Esc 关闭面板', (await exec('window.__cwTest.captureOpen()')) === false);

  // 72h. 队列空 + 空剪贴板：只提示、不打开面板（空内容不会出现在列表里）
  await exec('window.__cwTest.clearToasts()');
  const emptyOpen = JSON.parse(
    await exec("window.__cwTest.openCapture('').then((r) => JSON.stringify(r || null))")
  );
  check(
    '剪贴板面板：空剪贴板不打开面板（提示先复制正文）',
    emptyOpen.ok === false &&
      emptyOpen.code === 'EMPTY_CLIPBOARD' &&
      (await exec('window.__cwTest.captureOpen()')) === false,
    { emptyOpen }
  );

  // 72i. 隐私红线：隔离 userData 的日志里不许出现剪贴板正文标记（只允许派生信息）
  const logs = await readLogs();
  const logMarkers = [DIRECT_MARKER, DIRECT_TAIL_MARKER, QUEUE_A_MARKER, QUEUE_B_MARKER, QUEUE_D_MARKER];
  check(
    '剪贴板面板：日志里没有剪贴板正文（隐私红线）',
    logMarkers.every((marker) => logs.text.includes(marker) === false),
    { logNames: logs.names }
  );

  // 72j. 关掉后台监听：队列立刻清空（隐私口径），之后再复制也不入队
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec('window.__cwTest.openSettings()');
  await waitFor('window.__cwTest.settingsOpen() === true');
  await exec("window.__cwTest.setCheck('settings-clipboard-watch', false)");
  await exec('window.__cwTest.saveSettings()');
  await waitFor('window.api.getConfig().then((r) => r.ok && r.data.clipboardWatchEnabled === false)');
  const queueAfterOff = await exec('window.__cwTest.captureQueue()');
  await exec('window.__cwTest.clearToasts()');
  const queueDText = [
    '第8章 队列丁段',
    '',
    `${QUEUE_D_MARKER}：这一条只用来验证关掉监听以后新复制不再入队。`
  ].join('\n');
  await exec(`window.api.setClipboardWatchTestText(${JSON.stringify(queueDText)})`);
  await sleep(1200);
  const afterOff = {
    queue: await exec('window.__cwTest.captureQueue()'),
    toasts: await exec('window.__cwTest.toasts()')
  };
  check(
    '剪贴板面板：关掉后台监听即清空队列，之后新复制不再入队 / 不再提示',
    queueAfterOff.length === 0 &&
      afterOff.queue.length === 0 &&
      afterOff.toasts.every((item) => String(item.message).includes('新复制') === false),
    { queueAfterOff, afterOff }
  );

  // 72k. 清理：删掉这本测试书（只进回收站 / _trash，不真删），书库根目录不留垃圾
  const cleanup = await deleteBookWithRetry(bookPath);
  check('剪贴板面板：清理测试书成功（只进回收站 / _trash）', cleanup && cleanup.ok === true, { cleanup });
  check(
    '剪贴板面板：书库根目录没有留下多余文件',
    (await fs.readdir(booksRoot)).includes(path.basename(bookPath)) === false
  );
};
