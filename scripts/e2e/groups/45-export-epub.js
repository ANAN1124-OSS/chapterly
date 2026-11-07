// E2E 第 45 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：新建「EPUB导出测试书」（+ 分卷）
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group45ExportEpub(t) {
  const {
    exec,
    check,
    waitFor,
    sleep,
    storage,
    booksRoot,
    app,
    waitForFile,
    waitForSummary,
    fileExists,
    readZip,
    assertWellFormedXml,
    dialog,
    saveDialog,
    withSavePath,
    restoreSaveDialog,
    openExportDialogFromMenu
  } = t;

  // 45. 导出 EPUB（v0.7-1）：整本书 → EPUB 3；分卷做目录级、一章一个 XHTML、纯文字封面
  await exec("window.__cwTest.newBook('EPUB导出测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const epubBookPath = await exec('window.__cwTest.bookPathValue()');
  const epubMetaPath = path.join(epubBookPath, '书目.json');
  await exec("window.__cwTest.newVolume('上卷')");
  await exec("window.__cwTest.newChapterInVolume(0, '上卷一')");
  await exec("window.__cwTest.newChapterInVolume(0, '上卷二')");
  const epubTexts = [
    '楔子里的一段 & 符号。\n\n第二段 <比较>。',
    '上卷第一章正文。',
    '上卷第二章正文。'
  ];
  for (let i = 0; i < epubTexts.length; i += 1) {
    await exec(`window.__cwTest.switchTo(${i}, 'discard')`);
    await exec(`window.__cwTest.setText(${JSON.stringify(epubTexts[i])})`);
    await exec('window.__cwTest.save()');
  }
  const epubMetaBefore = await storage.readBookMeta(epubBookPath);
  const epubDiskTexts = [];
  const epubStatBefore = [];
  const epubFilesOnDisk = [];
  for (const chapter of epubMetaBefore.chapters) {
    const filePath = path.join(epubBookPath, chapter.file);
    epubFilesOnDisk.push(filePath);
    epubDiskTexts.push((await storage.loadChapterText(epubBookPath, chapter.file)).text);
    const stat = await fs.stat(filePath);
    epubStatBefore.push({ size: stat.size, mtimeMs: stat.mtimeMs });
  }
  check(
    'EPUB 导出：准备了一本 3 章 / 1 卷的书（第 1 章未分卷）',
    epubMetaBefore.chapters.length === 3 &&
      (await exec('window.__cwTest.volumeNames()')).join(',') === '上卷' &&
      JSON.stringify(epubDiskTexts) === JSON.stringify(epubTexts),
    { chapters: epubMetaBefore.chapters.length, texts: epubDiskTexts }
  );

  // 45a. 入口：导出菜单里有「导出 EPUB…」
  check(
    'EPUB 导出：导出菜单有「导出 EPUB…」',
    (await exec('window.__cwTest.exportMenuTexts()')).includes('导出 EPUB…'),
    await exec('window.__cwTest.exportMenuTexts()')
  );

  const epubDir = path.join(path.dirname(booksRoot), 'epub-exports');
  await fs.mkdir(epubDir, { recursive: true });
  const epubPath = path.join(epubDir, 'book.epub');
  withSavePath(epubPath);
  try {
    await openExportDialogFromMenu('epub');
    await waitForSummary('EPUB导出测试书.epub');
    check(
      'EPUB 导出：导出对话框标题是「导出 EPUB」、摘要给出 .epub 默认文件名',
      (await exec('window.__cwTest.exportTitle()')) === '导出 EPUB' &&
        (await exec('window.__cwTest.exportFormat()')) === 'epub' &&
        (await exec('window.__cwTest.exportSummary()')).includes('EPUB导出测试书.epub')
    );
    await exec("document.getElementById('btn-export-confirm').click()");
    await waitForFile(epubPath);
  } finally {
    restoreSaveDialog();
  }
  await waitFor(
    "Array.from(document.querySelectorAll('#toast-area .toast')).some((el) => el.textContent.includes('已导出 EPUB：'))"
  );
  const epubToast = await exec(`(() => {
    const el = Array.from(document.querySelectorAll('#toast-area .toast')).find((item) => item.textContent.includes('已导出 EPUB：'));
    return el ? el.textContent : '';
  })()`);
  check(
    'EPUB 导出：成功提示带范围 / 章 / 卷 / 字数（共用的提示拼装没变）',
    epubToast.includes('已导出 EPUB：') &&
      epubToast.includes('3 章') &&
      epubToast.includes('1 卷') &&
      /\d+ 字/.test(epubToast),
    epubToast
  );
  check(
    'EPUB 导出：保存对话框默认文件名 = 书名.epub，类型带 epub',
    Boolean(saveDialog.last) &&
      path.basename(saveDialog.last.defaultPath) === 'EPUB导出测试书.epub' &&
      Array.isArray(saveDialog.last.filters) &&
      saveDialog.last.filters.some((filter) => Array.isArray(filter.extensions) && filter.extensions.includes('epub')),
    saveDialog.last && { defaultPath: saveDialog.last.defaultPath, filters: saveDialog.last.filters }
  );

  const epubBuffer = await fs.readFile(epubPath);
  const epubZip = readZip(epubBuffer);
  const epubEntries = new Map(epubZip.entries.map((entry) => [entry.name, entry]));
  const epubText = (name) => {
    const entry = epubEntries.get(name);
    return entry ? entry.data.toString('utf8') : '';
  };
  check(
    'EPUB 导出：mimetype 第一个、不压缩、没有扩展字段，内容正确',
    epubZip.entries[0].name === 'mimetype' &&
      epubZip.entries[0].method === 0 &&
      epubZip.entries[0].data.toString('utf8') === 'application/epub+zip' &&
      epubBuffer.readUInt16LE(6) === 0 &&
      epubBuffer.readUInt16LE(28) === 0,
    { first: epubZip.entries[0].name, method: epubZip.entries[0].method }
  );
  check(
    'EPUB 导出：container.xml 指向 OEBPS/content.opf',
    epubText('META-INF/container.xml').includes('full-path="OEBPS/content.opf"')
  );
  const epubOpf = epubText('OEBPS/content.opf');
  const epubManifestHrefs = [...epubOpf.matchAll(/<item [^>]*href="([^"]+)"/g)].map((match) => match[1]);
  const epubSpine = [...epubOpf.matchAll(/<itemref idref="([^"]+)"/g)].map((match) => match[1]);
  check(
    'EPUB 导出：OPF 书名 / 语言 / 标识齐全，manifest 里每个文件都在包里',
    epubOpf.includes('<dc:title>EPUB导出测试书</dc:title>') &&
      epubOpf.includes('<dc:language>zh-CN</dc:language>') &&
      /urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/.test(epubOpf) &&
      epubManifestHrefs.length >= 8 &&
      epubManifestHrefs.every((href) => epubEntries.has(`OEBPS/${href}`)),
    { hrefs: epubManifestHrefs }
  );
  check(
    'EPUB 导出：spine = 封面 → 未分卷章 → 卷名页 → 卷内章',
    JSON.stringify(epubSpine) === JSON.stringify(['cover', 'ch1', 'vol1', 'ch2', 'ch3']),
    epubSpine
  );
  check(
    'EPUB 导出：分卷是二级目录（上卷带两章）',
    epubText('OEBPS/nav.xhtml').includes('<a href="text/volume-0001.xhtml">上卷</a>') &&
      epubText('OEBPS/nav.xhtml').includes('<li><a href="text/chapter-0001.xhtml">第1章</a></li>') &&
      epubText('OEBPS/nav.xhtml').includes('<li><a href="text/chapter-0002.xhtml">第2章：上卷一</a></li>') &&
      epubText('OEBPS/nav.xhtml').includes('<li><a href="text/chapter-0003.xhtml">第3章：上卷二</a></li>') &&
      (epubText('OEBPS/nav.xhtml').match(/<ol>/g) || []).length === 2,
    epubText('OEBPS/nav.xhtml')
  );
  check(
    'EPUB 导出：一章一个 XHTML，章名 / 章号与 TXT 导出一致',
    epubText('OEBPS/text/chapter-0001.xhtml').includes('<h1 class="chapter-title">第1章</h1>') &&
      epubText('OEBPS/text/chapter-0002.xhtml').includes('<h1 class="chapter-title">第2章：上卷一</h1>') &&
      epubText('OEBPS/text/volume-0001.xhtml').includes('<h1 class="part-title">上卷</h1>')
  );
  check(
    'EPUB 导出：正文按段落输出、特殊字符都转义了',
    epubText('OEBPS/text/chapter-0001.xhtml').includes('<p>楔子里的一段 &amp; 符号。</p>') &&
      epubText('OEBPS/text/chapter-0001.xhtml').includes('<p>第二段 &lt;比较&gt;。</p>') &&
      !epubText('OEBPS/text/chapter-0001.xhtml').includes('楔子里的一段 & 符号'),
    epubText('OEBPS/text/chapter-0001.xhtml')
  );
  check(
    'EPUB 导出：纯文字封面页带书名与章数 / 卷数',
    epubText('OEBPS/cover.xhtml').includes('<h1 class="cover-title">EPUB导出测试书</h1>') &&
      epubText('OEBPS/cover.xhtml').includes('共 3 章 · 1 卷'),
    epubText('OEBPS/cover.xhtml')
  );
  check(
    'EPUB 导出：排版用 CSS 做段首缩进 2 字 + 段间空一行',
    epubText('OEBPS/style.css').includes('text-indent: 2em') &&
      epubText('OEBPS/style.css').includes('margin: 0 0 1.75em 0')
  );
  let epubXmlOk = true;
  let epubXmlChecked = 0;
  let epubXmlError = '';
  for (const entry of epubZip.entries) {
    if (!/\.(xhtml|opf|ncx|xml)$/.test(entry.name)) continue;
    try {
      assertWellFormedXml(entry.data.toString('utf8'), entry.name);
      epubXmlChecked += 1;
    } catch (err) {
      epubXmlOk = false;
      epubXmlError = err.message;
      break;
    }
  }
  check(
    'EPUB 导出：所有 XML 文件都合法（含容器 / OPF / 目录 / 章节页）',
    epubXmlOk && epubXmlChecked >= 9,
    { checked: epubXmlChecked, error: epubXmlError }
  );

  // 45b. 当前章未保存的内容进 EPUB，但绝不写盘
  await exec("window.__cwTest.switchTo(1, 'discard')");
  const epubUnsavedText = '这段还没保存，但 EPUB 里必须有';
  await exec(`window.__cwTest.setText(${JSON.stringify(epubUnsavedText)})`);
  const epubUnsavedPath = path.join(epubDir, 'unsaved.epub');
  withSavePath(epubUnsavedPath);
  try {
    await openExportDialogFromMenu('epub');
    await waitForSummary('含当前章未保存内容');
    await exec("document.getElementById('btn-export-confirm').click()");
    await waitForFile(epubUnsavedPath);
  } finally {
    restoreSaveDialog();
  }
  const epubUnsavedZip = readZip(await fs.readFile(epubUnsavedPath));
  const epubUnsavedChapter = epubUnsavedZip.entries
    .find((entry) => entry.name === 'OEBPS/text/chapter-0002.xhtml')
    .data.toString('utf8');
  check(
    'EPUB 导出：当前章未保存内容进了 EPUB，磁盘正文没被偷偷改写',
    epubUnsavedChapter.includes(epubUnsavedText) &&
      !epubUnsavedChapter.includes('上卷第一章正文。') &&
      (await storage.loadChapterText(epubBookPath, epubMetaBefore.chapters[1].file)).text ===
        '上卷第一章正文。' &&
      (await exec('window.__cwTest.dirty()')) === true,
    { chapter: epubUnsavedChapter, dirty: await exec('window.__cwTest.dirty()') }
  );

  // 45c. 取消保存对话框：不写文件、仍停在编辑页
  dialog.showSaveDialog = async () => ({ canceled: true, filePath: null });
  try {
    await openExportDialogFromMenu('epub');
    await waitForSummary('EPUB导出测试书.epub');
    await exec("document.getElementById('btn-export-confirm').click()");
    await sleep(500);
  } finally {
    restoreSaveDialog();
  }
  check(
    'EPUB 导出：取消保存对话框不写文件、仍停在编辑页',
    !(await fileExists(path.join(epubDir, 'cancel.epub'))) &&
      (await exec("window.__cwTest.view() === 'editor'"))
  );

  // 45d. 只读 + 目录记忆：章节 txt 大小 / mtime、书目 chapters 都没被导出改写
  await exec("window.__cwTest.switchTo(2, 'discard')");
  let epubFilesUntouched = true;
  for (let i = 0; i < epubFilesOnDisk.length; i += 1) {
    const stat = await fs.stat(epubFilesOnDisk[i]);
    if (stat.size !== epubStatBefore[i].size || stat.mtimeMs !== epubStatBefore[i].mtimeMs) {
      epubFilesUntouched = false;
    }
  }
  const epubMetaAfter = await storage.readBookMeta(epubBookPath);
  let epubConfigNow = null;
  try {
    epubConfigNow = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'config.json'), 'utf8'));
  } catch {
    /* 读不到就当失败 */
  }
  check(
    'EPUB 导出：章节 txt 与书目的章节记录都没被导出改写（纯读）',
    epubFilesUntouched &&
      JSON.stringify(epubMetaAfter.chapters) === JSON.stringify(epubMetaBefore.chapters),
    { untouched: epubFilesUntouched }
  );
  check(
    'EPUB 导出：导出过的目录被记住，下次默认还开在这里',
    Boolean(epubConfigNow && epubConfigNow.lastExportDir === epubDir),
    epubConfigNow && epubConfigNow.lastExportDir
  );

  // 45e. 旧数据兼容：v0.4.1 形状（没有 schemaVersion）的书照常导出，且导出不改书目
  await exec("window.__cwTest.newBook('EPUB旧书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const epubLegacyBookPath = await exec('window.__cwTest.bookPathValue()');
  const epubLegacyMetaPath = path.join(epubLegacyBookPath, '书目.json');
  await exec("window.__cwTest.renameChapterAt(0, '起风')");
  await exec("window.__cwTest.setText('旧书正文。')");
  await exec('window.__cwTest.save()');
  const epubLegacyRaw = JSON.parse(await fs.readFile(epubLegacyMetaPath, 'utf8'));
  delete epubLegacyRaw.schemaVersion;
  // 再模拟一本真正的 v0.4.1 旧书：去掉本轮新增之外的所有可选字段
  for (const chapter of epubLegacyRaw.chapters) {
    delete chapter.status;
    delete chapter.note;
  }
  await fs.writeFile(epubLegacyMetaPath, JSON.stringify(epubLegacyRaw, null, 2), 'utf8');
  await exec('window.__cwTest.backToShelf()');
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(epubLegacyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  check(
    'EPUB 导出：没有 schemaVersion 的旧书照常打开',
    (await exec('window.__cwTest.currentTitle()')).includes('起风')
  );
  const epubLegacyExportPath = path.join(epubDir, 'legacy.epub');
  withSavePath(epubLegacyExportPath);
  try {
    await openExportDialogFromMenu('epub');
    await waitForSummary('EPUB旧书.epub');
    await exec("document.getElementById('btn-export-confirm').click()");
    await waitForFile(epubLegacyExportPath);
  } finally {
    restoreSaveDialog();
  }
  const epubLegacyZip = readZip(await fs.readFile(epubLegacyExportPath));
  const epubLegacyOpf = epubLegacyZip.entries
    .find((entry) => entry.name === 'OEBPS/content.opf')
    .data.toString('utf8');
  const epubLegacyAfter = JSON.parse(await fs.readFile(epubLegacyMetaPath, 'utf8'));
  check(
    'EPUB 导出：v0.4.1 形状旧书（没有 schemaVersion）照常导出，书目没被补字段',
    epubLegacyOpf.includes('<dc:title>EPUB旧书</dc:title>') &&
      epubLegacyZip.names.includes('OEBPS/text/chapter-0001.xhtml') &&
      epubLegacyAfter.schemaVersion === undefined,
    { version: epubLegacyAfter.schemaVersion, names: epubLegacyZip.names }
  );
};
