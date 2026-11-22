const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const storage = require('../core/storage');
const chapters = require('../core/chapters');
const importer = require('../core/importer');

const tmpCleanup = require('./tmp-cleanup');

// TB-02：临时目录统一经 tests/tmp-cleanup.js 的 mkTmp（mkdtemp + 登记回收）。
const mkTmp = (prefix = 'cw-import-') => tmpCleanup.mkTmp(prefix);

test('导入现成的章回书：整本复制、内容一致、源文件夹保留', async () => {
  const base = await mkTmp();
  const externalRoot = path.join(base, '外部');
  await fs.mkdir(externalRoot);
  const created = await storage.createBook(externalRoot, '星海旅人');
  await storage.createChapter(created.path, 1, '夜雨');
  await storage.saveChapterText(created.path, created.meta.chapters[0].file, '第一章内容');

  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [created.path]);
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].kind, 'book');
  assert.equal(res.imported[0].title, '星海旅人');
  assert.equal(res.imported[0].chapters, 2);

  const importedPath = res.imported[0].path;
  const meta = await storage.readBookMeta(importedPath);
  assert.equal(meta.chapters.length, 2);
  assert.equal((await storage.loadChapterText(importedPath, meta.chapters[0].file)).text, '第一章内容');
  // 源文件夹仍然在（只复制不移动）
  await fs.access(path.join(created.path, '书目.json'));
});

test('导入一堆 txt：按文件名重建书目、内容完整、书名取文件夹名', async () => {
  const base = await mkTmp();
  const src = path.join(base, '旧稿');
  await fs.mkdir(src);
  await fs.writeFile(path.join(src, '003-丙.txt'), '丙的正文', 'utf8');
  await fs.writeFile(path.join(src, '001-甲.txt'), '甲的正文', 'utf8');
  await fs.writeFile(path.join(src, '002-乙.txt'), '', 'utf8');

  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [src]);
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].kind, 'chapter-folder');
  assert.equal(res.imported[0].chapters, 3);
  assert.equal(res.imported[0].title, '旧稿');

  const target = res.imported[0].path;
  assert.equal(path.basename(target), '旧稿');
  const meta = await storage.readBookMeta(target);
  assert.deepEqual(meta.chapters.map((c) => c.name), ['甲', '乙', '丙']);
  assert.equal((await storage.loadChapterText(target, meta.chapters[0].file)).text, '甲的正文');
  // 书架扫描能看到这本新书
  const books = await storage.listBooks(booksRoot);
  assert.equal(books.length, 1);
  assert.equal(books[0].folder, '旧稿');
});

test('重复导入同名文件夹自动加 -2', async () => {
  const base = await mkTmp();
  const src = path.join(base, '旧稿');
  await fs.mkdir(src);
  await fs.writeFile(path.join(src, '001-甲.txt'), '内容', 'utf8');
  const booksRoot = path.join(base, '书架');

  const first = await importer.importFolders(booksRoot, [src]);
  const second = await importer.importFolders(booksRoot, [src]);
  assert.equal(first.imported[0].folder, '旧稿');
  assert.equal(second.imported[0].folder, '旧稿-2');
  const books = await storage.listBooks(booksRoot);
  assert.equal(books.length, 2);
});

// V106（v1.8.0 WP-21）：导入文件夹撞名探测以前是 `for (;;)`，没有上限（理论上不可终止 /
// 同名书极多时 O(n²) 次 stat）。现在与 core/chapters.js 的章节名后缀同一口径：`-2` … `-999`
// 用完仍撞名就抛 BAD_PATH。maxSuffix 可注入，单测不必真造 999 个文件夹。
test('V106/WP-21：导入文件夹撞名后缀 999 硬上限，撞满明确报 BAD_PATH 而不是无限探测', async () => {
  assert.equal(importer.MAX_FOLDER_SUFFIX, 999);
  // 与章节名撞名后缀同一口径（chapters.js 的 MAX_NAME_SUFFIX 故意不导出，按源码钉住数值）
  const chaptersSource = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'core', 'chapters.js'),
    'utf8'
  );
  assert.match(chaptersSource, /const MAX_NAME_SUFFIX = 999;/);

  const base = await mkTmp();
  const booksRoot = path.join(base, '书架');
  await fs.mkdir(booksRoot);
  await fs.mkdir(path.join(booksRoot, '导入的书'));
  await fs.mkdir(path.join(booksRoot, '导入的书-2'));

  // 只撞到 base / base-2：照常拿 base-3（上限只拦「全撞满」，不改变正常 -N 编号）
  assert.equal(await importer.uniqueFolderName(booksRoot, '导入的书', { maxSuffix: 3 }), '导入的书-3');
  // 再占掉 base-3：maxSuffix=3 已试完 → 明确报错，不无限循环
  await fs.mkdir(path.join(booksRoot, '导入的书-3'));
  await assert.rejects(
    () => importer.uniqueFolderName(booksRoot, '导入的书', { maxSuffix: 3 }),
    (err) => {
      assert.equal(err.code, 'BAD_PATH');
      assert.match(err.message, /已试到第 3 个后缀/);
      assert.equal(err.message.includes(booksRoot), false, '错误文案不能带本机路径');
      return true;
    }
  );
  // 默认上限下的正常路径逐字不变（本书架里 base / base-2 / base-3 都有 → base-4）
  assert.equal(await importer.uniqueFolderName(booksRoot, '导入的书'), '导入的书-4');
});

// C30（v1.8.0 WP-26）：目录包含判定走 core/path-utils 的 normalizePath（resolve + 小写），
// 与 core/storage.js 的 assertInside / assertBookPath 同一口径。旧实现逐字 startsWith：
// Windows 上大小写不同的同一目录会绕过「已经在书架里 / 不能导入上级」两道守卫。
test('C30/WP-26：isInside 大小写不敏感（书架根守卫与 storage.assertInside 同口径）', () => {
  const base = path.join(os.tmpdir(), 'cw-import-inside', '书架');
  const child = path.join(base, '子目录');
  assert.equal(importer.isInside(base, child), true);
  assert.equal(importer.isInside(base.toLowerCase(), child.toUpperCase()), true, '大小写不同的同一路径仍算在内');
  assert.equal(importer.isInside(child, base), false, '反方向不算包含');
  assert.equal(importer.isInside(base, `${base}2`), false, '前缀相同但不是子目录');
  // 相对路径先 resolve 再比较（旧实现同样先 resolve）
  assert.equal(importer.isInside(path.resolve('书架'), path.resolve(path.join('书架', '书'))), true);
});

test('没有书也没有 txt 的文件夹被跳过', async () => {
  const base = await mkTmp();
  const src = path.join(base, '空文件夹');
  await fs.mkdir(src);
  const res = await importer.importFolders(path.join(base, '书架'), [src]);
  assert.equal(res.imported.length, 0);
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /没有/);
});

test('书架目录里的文件夹不能再导入（避免自我复制）', async () => {
  const base = await mkTmp();
  const booksRoot = path.join(base, '书架');
  const created = await storage.createBook(booksRoot, '已有的书');
  const res = await importer.importFolders(booksRoot, [created.path]);
  assert.equal(res.imported.length, 0);
  assert.match(res.skipped[0].reason, /已经在书架目录里/);
});

test('不能导入包含书架目录的上级文件夹', async () => {
  const base = await mkTmp();
  const booksRoot = path.join(base, '书架');
  await fs.mkdir(booksRoot, { recursive: true });
  const res = await importer.importFolders(booksRoot, [base]);
  assert.equal(res.imported.length, 0);
  assert.match(res.skipped[0].reason, /不能导入包含书架目录/);
});

test('损坏的书目 + txt 会走「按 txt 重建」导入', async () => {
  const base = await mkTmp();
  const src = path.join(base, '坏书');
  await fs.mkdir(src);
  await fs.writeFile(path.join(src, '001-甲.txt'), '甲', 'utf8');
  await fs.writeFile(path.join(src, '书目.json'), '{ 坏掉的', 'utf8');
  const booksRoot = path.join(base, '书架');

  const res = await importer.importFolders(booksRoot, [src]);
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].kind, 'chapter-folder');
  const meta = await storage.readBookMeta(res.imported[0].path);
  assert.equal(meta.chapters.length, 1);
  assert.equal(meta.chapters[0].name, '甲');
});

test('不存在的路径记为跳过而不是崩溃', async () => {
  const base = await mkTmp();
  const res = await importer.importFolders(path.join(base, '书架'), [path.join(base, '不存在')]);
  assert.equal(res.imported.length, 0);
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /不是文件夹/);
});

test('导入小说收藏夹（自动分章模式）：每个 txt 一本书并拆分章节', async () => {
  const base = await mkTmp();
  const src = path.join(base, '收藏夹');
  await fs.mkdir(src);
  await fs.writeFile(
    path.join(src, '第一本小说.txt'),
    '第1章 开端\n\n正文一\n\n第2章 转折\n\n正文二',
    'utf8'
  );
  await fs.writeFile(
    path.join(src, '第二本小说.txt'),
    '楔子\n\n引子内容\n\n第一章 雪夜\n\n雪夜正文',
    'utf8'
  );

  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [src], { mode: 'split' });
  assert.equal(res.imported.length, 2);
  assert.deepEqual(
    res.imported.map((b) => b.title).sort(),
    ['第一本小说', '第二本小说']
  );

  const first = res.imported.find((b) => b.title === '第一本小说');
  assert.equal(first.chapters, 2);
  const meta = await storage.readBookMeta(first.path);
  assert.deepEqual(meta.chapters.map((c) => c.name), ['开端', '转折']);
  assert.equal((await storage.loadChapterText(first.path, meta.chapters[0].file)).text, '正文一');

  const second = res.imported.find((b) => b.title === '第二本小说');
  const meta2 = await storage.readBookMeta(second.path);
  assert.deepEqual(meta2.chapters.map((c) => c.name), ['楔子', '雪夜']);

  const books = await storage.listBooks(booksRoot);
  assert.equal(books.length, 2);
});

test('整本一章模式：没有标题行的短篇，一章「全文」', async () => {
  const base = await mkTmp();
  const src = path.join(base, '短篇');
  await fs.mkdir(src);
  await fs.writeFile(path.join(src, '一个短篇 - 作者.txt'), '正文第一段。\n\n正文第二段。', 'utf8');
  const res = await importer.importFolders(path.join(base, '书架'), [src], { mode: 'raw' });
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].title, '一个短篇 - 作者');
  const meta = await storage.readBookMeta(res.imported[0].path);
  assert.equal(meta.chapters.length, 1);
  assert.equal(meta.chapters[0].name, '全文');
  assert.ok((await storage.loadChapterText(res.imported[0].path, meta.chapters[0].file)).text.includes('正文第二段'));
});

test('GBK 编码的小说能自动识别（默认按原文章节导入）', async () => {
  const base = await mkTmp();
  const src = path.join(base, 'GBK收藏');
  await fs.mkdir(src);
  // “第一章 中文”的 GBK 字节
  const gbk = Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x20, 0xd6, 0xd0, 0xce, 0xc4]);
  await fs.writeFile(path.join(src, 'GBK小说.txt'), gbk);
  const res = await importer.importFolders(path.join(base, '书架'), [src]);
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].title, 'GBK小说');
  const meta = await storage.readBookMeta(res.imported[0].path);
  assert.equal(meta.chapters.length, 1);
  assert.equal(meta.chapters[0].name, '第一章 中文');
});

test('默认「按原文章节导入」：章名照抄原文、正文原样保留', async () => {
  const base = await mkTmp();
  const src = path.join(base, '原样');
  await fs.mkdir(src);
  const original = '第1章 开端\n\n正文一，带 全角空格　。\n\n第2章 转折\n\n正文二\n';
  await fs.writeFile(path.join(src, '一本书 - 作者.txt'), original, 'utf8');

  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [src]);
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].chapters, 2);

  const meta = await storage.readBookMeta(res.imported[0].path);
  assert.deepEqual(meta.chapters.map((c) => c.name), ['第1章 开端', '第2章 转折']);
  // 正文不做 trim：保留原文的空白行
  assert.equal((await storage.loadChapterText(res.imported[0].path, meta.chapters[0].file)).text, '\n正文一，带 全角空格　。\n');
  assert.equal((await storage.loadChapterText(res.imported[0].path, meta.chapters[1].file)).text, '\n正文二\n');
});

// TC-8（五-L8）：源文件以空行开头（抓取 / 排版常见的文件头留白）时，旧实现按 preface.trim()
// 判假把纯空白前言整段丢弃 —— 与默认 chapters 模式「正文一字不改」的承诺不符。
test('TC-8（五-L8）：文件开头的纯空白前言原样并入第一章，正文 = 原文去掉标题行', async () => {
  const base = await mkTmp();
  const src = path.join(base, '带留白前言');
  await fs.mkdir(src);
  const title = '第一章 起';
  const original = `\n\n${title}\n\n正文`;
  await fs.writeFile(path.join(src, '留白.txt'), original, 'utf8');

  const res = await importer.importFolders(path.join(base, '书架'), [src]);
  assert.equal(res.imported.length, 1);
  const meta = await storage.readBookMeta(res.imported[0].path);
  const text = (await storage.loadChapterText(res.imported[0].path, meta.chapters[0].file)).text;
  assert.equal(text, original.replace(`${title}\n`, ''), '正文必须逐字等于原文去掉标题行');
  assert.equal(text, '\n\n\n正文', '开头的两行留白不许静默吞掉');
});

test('C25/WP-24：按原文章节导入的 chars 只算正文（不含标题行），书架字数 = 各章正文之和', async () => {
  const base = await mkTmp();
  const src = path.join(base, '字数口径');
  await fs.mkdir(src);
  // 标题行带序号 + 空格；正文带空行与全角空格 —— 旧实现 chars = countChars(标题 + 正文)，
  // 两章的标题（各 5 个非空白字）会白算进去，导入后书架字数虚高、第一次保存又回落。
  const title1 = '第1章 开端';
  const body1 = '\n正文一，带 全角空格　。\n';
  const title2 = '第2章 转折';
  const body2 = '\n正文二\n';
  const original = `${title1}${body1}${title2}${body2}`;
  await fs.writeFile(path.join(src, '按原文拆章.txt'), original, 'utf8');

  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [src]);
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].chapters, 2);

  const bookPath = res.imported[0].path;
  const meta = await storage.readBookMeta(bookPath);
  assert.deepEqual(meta.chapters.map((c) => c.name), [title1, title2]);

  // 每章 chars = 写盘正文（body）的去空白字数，不是 countChars(标题 + body)
  assert.equal(meta.chapters[0].chars, chapters.countChars(body1), '第一章只算 body');
  assert.equal(meta.chapters[0].chars, 10, '正文一，带 全角空格　。= 10 个非空白字');
  assert.equal(meta.chapters[1].chars, chapters.countChars(body2), '第二章只算 body');
  assert.notEqual(meta.chapters[0].chars, chapters.countChars(`${title1}${body1}`), '不许再把标题行算进字数');

  // 与磁盘正文同一口径（首次保存后 storage 会按文件内容重算 chars，这里先钉住「重算也不变」）
  for (const chapter of meta.chapters) {
    const loaded = await storage.loadChapterText(bookPath, chapter.file);
    assert.equal(chapter.chars, chapters.countChars(loaded.text), `${chapter.name} 的 chars 必须等于写盘正文的正字数`);
  }

  // 书架字数 = 各章 body 之和（不是 标题+正文 之和）
  const opened = await storage.openBook(bookPath);
  assert.equal(opened.totalChars, chapters.countChars(body1) + chapters.countChars(body2));
  assert.equal(opened.totalChars, 13, '10 + 3');
  const books = await storage.listBooks(booksRoot);
  assert.equal(books.length, 1);
  assert.equal(books[0].totalChars, opened.totalChars, '书架卡片上的字数与各章之和一致');
});

test('整本一章模式：UTF-8 源文件按字节原样复制', async () => {
  const base = await mkTmp();
  const src = path.join(base, '字节一致');
  await fs.mkdir(src);
  // 故意包含标题行、全角空格、CRLF，验证一个字节都不改
  const original = '第1章 开端\r\n\r\n正文一，带 全角空格　。\r\n\r\n第2章 转折\r\n\r\n正文二\r\n';
  const buffer = Buffer.from(original, 'utf8');
  await fs.writeFile(path.join(src, '很长的书名 - 作者.txt'), buffer);

  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [src], { mode: 'raw' });
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].chapters, 1, '不拆章，全文只有一章');

  const meta = await storage.readBookMeta(res.imported[0].path);
  assert.equal(meta.chapters.length, 1);
  assert.equal(meta.chapters[0].name, '全文');
  const importedBytes = await fs.readFile(path.join(res.imported[0].path, meta.chapters[0].file));
  assert.deepEqual(importedBytes, buffer, '导入的章节文件应与源 txt 字节完全一致');
});

test('收藏夹默认按原文章节导入：每本 txt 一本书、按原文标题拆章', async () => {
  const base = await mkTmp();
  const src = path.join(base, '收藏夹');
  await fs.mkdir(src);
  await fs.writeFile(path.join(src, '书甲.txt'), '第1章 一\n\n甲正文\n\n第2章 二\n\n甲二段', 'utf8');
  await fs.writeFile(path.join(src, '书乙.txt'), '乙的整篇内容', 'utf8');
  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [src]);
  assert.equal(res.imported.length, 2);

  const bookA = res.imported.find((b) => b.title === '书甲');
  const bookB = res.imported.find((b) => b.title === '书乙');
  assert.equal(bookA.chapters, 2);
  assert.equal(bookB.chapters, 1);
  const metaA = await storage.readBookMeta(bookA.path);
  assert.deepEqual(metaA.chapters.map((c) => c.name), ['第1章 一', '第2章 二']);
  const metaB = await storage.readBookMeta(bookB.path);
  assert.deepEqual(metaB.chapters.map((c) => c.name), ['']);

  const books = await storage.listBooks(booksRoot);
  assert.equal(books.length, 2);
});

// v0.9 C-3（安全审计 C6）：导入是「整个 txt 读进内存 → 解码 → 切章」，
// 用大小闸门挡住病态大文件（免得主进程 OOM），用 NUL 闸门挡住二进制 / 坏编码，
// 而不是把一本乱码书塞进书架。
test('导入边界：大小闸门（纯逻辑）——上限内放过，超限回 FILE_TOO_LARGE，提示不含目录', () => {
  assert.equal(importer.importSizeProblem(0, '书'), null);
  assert.equal(importer.importSizeProblem(importer.MAX_IMPORT_BYTES, '书'), null);
  const over = importer.importSizeProblem(importer.MAX_IMPORT_BYTES + 1, '超大字');
  assert.equal(over.code, 'FILE_TOO_LARGE');
  assert.ok(over.message.includes('超大字'), over.message);
  assert.ok(over.message.includes('128 MB'), over.message);
  assert.ok(!over.message.includes('\\') && !over.message.includes('/'), '提示里不该带目录');
  // stat 拿不到 / 坏值不拦（交给后面的读盘报错）
  assert.equal(importer.importSizeProblem(NaN, '书'), null);
  assert.equal(importer.importSizeProblem(-1, '书'), null);
  assert.equal(importer.importSizeProblem(undefined, '书'), null);
  // 体量文案
  assert.equal(importer.formatImportSize(0), '0 B');
  assert.equal(importer.formatImportSize(512), '512 B');
  assert.equal(importer.formatImportSize(1536), '1.5 KB');
  assert.equal(importer.formatImportSize(128 * 1024 * 1024), '128 MB');
  assert.equal(importer.formatImportSize(3 * 1024 * 1024 * 1024), '3.0 GB');
});

test('导入边界：编码闸门（纯逻辑）——含 NUL 的当二进制，带 BOM 的 UTF-16 放过', () => {
  assert.equal(importer.isProbablyBinary(Buffer.from('正常中文文本', 'utf8')), false);
  assert.equal(importer.isProbablyBinary(Buffer.alloc(0)), false);
  assert.equal(importer.isProbablyBinary(null), false);
  assert.equal(importer.isProbablyBinary(Buffer.from([0x00, 0x01, 0x02])), true);
  assert.equal(importer.isProbablyBinary(Buffer.from('正文\u0000尾巴', 'utf8')), true);
  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('第1章 开端', 'utf16le')]);
  assert.equal(importer.hasUtf16Bom(utf16le), true);
  assert.equal(importer.isProbablyBinary(utf16le), false);
  assert.equal(importer.hasUtf16Bom(Buffer.from([0xfe, 0xff, 0x00])), true);
  assert.equal(importer.hasUtf16Bom(Buffer.from([0xef, 0xbb, 0xbf])), false);
  // TC-5（五-L7）：UTF-32BE 的 00 00 FE FF 同样「本来就一半是 0」，不能当二进制拒掉
  const utf32be = Buffer.concat([Buffer.from([0x00, 0x00, 0xfe, 0xff]), Buffer.alloc(4)]);
  assert.equal(importer.isProbablyBinary(utf32be), false, 'UTF-32BE BOM 是文本');
  assert.equal(importer.isProbablyBinary(Buffer.from([0x00, 0x00, 0x01, 0x02])), true, '只是 NUL 开头、没有 BOM 仍是二进制');
});

test('导入边界：超过上限的 txt 直接拒绝，不建书、不留临时目录、不建书架目录', async () => {
  const base = await mkTmp();
  const src = path.join(base, '收藏夹');
  await fs.mkdir(src);
  const huge = path.join(src, '超大书.txt');
  await fs.writeFile(huge, '');
  // 稀疏文件：只把长度改到上限 +1，不真的写 128 MB 字节
  await fs.truncate(huge, importer.MAX_IMPORT_BYTES + 1);
  const booksRoot = path.join(base, '书架');
  await assert.rejects(
    () => importer.importNovelFile(booksRoot, huge),
    (err) =>
      err.code === 'FILE_TOO_LARGE' &&
      err.message.includes('128 MB') &&
      err.message.includes('超大书') &&
      !err.message.includes(base)
  );
  const entries = await fs.readdir(booksRoot).catch(() => []);
  assert.deepEqual(entries, [], '被拒绝的导入不该在书架里留下任何东西');
});

// V25（1.6.1 R2）：文件夹形态导入是「原样复制、不读正文」，以前不受单本 128 MB 闸门约束——
// 复制前逐 txt 过闸门：超限的单个文件跳过并记进 skipped，其余文件照常导入，整批不中断。
test('文件夹导入：129 MB 稀疏文件跳过、其余 txt 照常导入，结果 skipped=1', async () => {
  const base = await mkTmp();
  const src = path.join(base, '书目录');
  await fs.mkdir(src);
  await fs.writeFile(path.join(src, '001-开端.txt'), '第1章 开端\n\n正文一。', 'utf8');
  await fs.writeFile(path.join(src, '002-承接.txt'), '第2章 承接\n\n正文二。', 'utf8');
  const huge = path.join(src, '003-巨大.txt');
  await fs.writeFile(huge, '');
  // 稀疏文件：只把长度改到上限 +1，不真的写 128 MB 字节
  await fs.truncate(huge, importer.MAX_IMPORT_BYTES + 1);
  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [src]);

  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].kind, 'chapter-folder');
  assert.equal(res.failed.length, 0);
  // 超限文件跳过、其余两个 txt 照常导入
  assert.equal(res.skipped.length, 1, JSON.stringify(res.skipped));
  assert.equal(res.skipped[0].code, 'FILE_TOO_LARGE');
  assert.ok(res.skipped[0].reason.includes('128 MB'), res.skipped[0].reason);
  assert.ok(res.skipped[0].reason.includes('003-巨大'), res.skipped[0].reason);
  assert.ok(!res.skipped[0].reason.includes(base), '提示里不该带本机目录');
  assert.equal(res.skippedTooLarge, 1);
  // V45（1.7.2 D3）：结果里只留 skipped[] 一套表示（每条带 tooLarge），不再有 skippedFiles / 结果级计数
  assert.deepEqual(res.imported[0].skipped.map((entry) => entry.source), ['003-巨大.txt']);
  assert.equal(res.imported[0].skipped[0].tooLarge, true);

  const importedPath = res.imported[0].path;
  const files = (await storage.listTxtFiles(importedPath)).sort();
  assert.deepEqual(files, ['001-开端.txt', '002-承接.txt'], '只导入闸门内的 txt');
  assert.equal(res.imported[0].chapters, 2);
  const meta = await storage.readBookMeta(importedPath);
  assert.equal(meta.chapters.length, 2);
  // 源文件夹一个文件都不少（只复制不移动）
  assert.equal((await fs.readdir(src)).length, 3);
});

test('现成书文件夹导入：章节文件超限时跳过该章、其余章节照常导入', async () => {
  const base = await mkTmp();
  const externalRoot = path.join(base, '外部');
  await fs.mkdir(externalRoot);
  const created = await storage.createBook(externalRoot, '大体量书');
  await storage.createChapter(created.path, 2, '承接');
  await storage.createChapter(created.path, 3, '巨大');
  const sourceMeta = await storage.readBookMeta(created.path);
  assert.equal(sourceMeta.chapters.length, 3);
  await storage.saveChapterText(created.path, sourceMeta.chapters[0].file, '第一章内容');
  await storage.saveChapterText(created.path, sourceMeta.chapters[1].file, '第二章内容');
  const huge = path.join(created.path, sourceMeta.chapters[2].file);
  await fs.writeFile(huge, '');
  await fs.truncate(huge, importer.MAX_IMPORT_BYTES + 1);

  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [created.path]);
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].kind, 'book');
  assert.equal(res.failed.length, 0);
  assert.equal(res.skipped.length, 1);
  assert.equal(res.skipped[0].code, 'FILE_TOO_LARGE');
  assert.equal(res.skippedTooLarge, 1);
  // V45（1.7.2 D3）：同一套表示 —— 被跳过的章以相对名记在结果的 skipped[] 里
  assert.deepEqual(res.imported[0].skipped.map((entry) => entry.source), [sourceMeta.chapters[2].file]);

  const importedPath = res.imported[0].path;
  const files = await storage.listTxtFiles(importedPath);
  assert.ok(!files.includes(sourceMeta.chapters[2].file), '超限章节文件不该被复制进来');
  assert.equal(files.length, 2);
  // 书目只列真实存在的章节：每一章都能读，不会留下打不开的悬挂章节
  assert.equal(res.imported[0].chapters, 2);
  const importedMeta = await storage.readBookMeta(importedPath);
  assert.equal(importedMeta.chapters.length, 2);
  for (const chapter of importedMeta.chapters) {
    assert.ok(files.includes(chapter.file), chapter.file);
    const loaded = await storage.loadChapterText(importedPath, chapter.file);
    assert.ok(loaded.text.length > 0);
  }
  assert.ok(importedMeta.chapters.some((c) => c.id === importedMeta.lastOpenChapterId));
});

test('导入边界：二进制 txt 不导入乱码书（NOT_TEXT，不建书）', async () => {
  const base = await mkTmp();
  const src = path.join(base, '收藏夹');
  await fs.mkdir(src);
  const bin = path.join(src, '其实是图片.txt');
  await fs.writeFile(bin, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0x00, 0x01, 0x02]));
  const booksRoot = path.join(base, '书架');
  await assert.rejects(
    () => importer.importNovelFile(booksRoot, bin),
    (err) => err.code === 'NOT_TEXT' && err.message.includes('不是纯文本')
  );
  assert.deepEqual(await fs.readdir(booksRoot).catch(() => []), []);
});

test('导入边界：收藏夹里混着坏文件 → 好书照常导入、坏文件进 failed，不中断整批', async () => {
  const base = await mkTmp();
  const src = path.join(base, '收藏夹');
  await fs.mkdir(src);
  await fs.writeFile(path.join(src, '好书.txt'), '第1章 开端\n\n正文。', 'utf8');
  await fs.writeFile(path.join(src, '坏书.txt'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [src]);
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].title, '好书');
  assert.equal(res.failed.length, 1);
  assert.ok(res.failed[0].source.endsWith('坏书.txt'));
  assert.ok(res.failed[0].message.includes('不是纯文本'), res.failed[0].message);
  const books = await storage.listBooks(booksRoot);
  assert.equal(books.length, 1);
});

test('导入边界：UTF-16（带 BOM）的 txt 照旧按原文导入，不被 NUL 闸门误伤', async () => {
  const base = await mkTmp();
  const src = path.join(base, '收藏夹');
  await fs.mkdir(src);
  const file = path.join(src, 'UTF16书.txt');
  await fs.writeFile(file, Buffer.from('\uFEFF第1章 开端\n\n正文。', 'utf16le'));
  const booksRoot = path.join(base, '书架');
  const res = await importer.importNovelFile(booksRoot, file);
  assert.equal(res.chapters, 1);
  const meta = await storage.readBookMeta(res.path);
  assert.equal(meta.chapters.length, 1);
  assert.equal(meta.chapters[0].name, '第1章 开端');
  assert.ok((await storage.loadChapterText(res.path, meta.chapters[0].file)).text.includes('正文。'));
});

test('b10：导入无标题长文（>6 万字）自动切片；有标题的正常拆章不受影响', async () => {
  const base = await mkTmp();
  const src = path.join(base, '长文来源');
  await fs.mkdir(src);
  const paragraph = `${'这'.repeat(9998)}\n\n`;
  const body = paragraph.repeat(13); // 13 万字、没有任何章节标题
  const file = path.join(src, '无标题长文.txt');
  await fs.writeFile(file, body, 'utf8');
  const booksRoot = path.join(base, '书架');

  const res = await importer.importNovelFile(booksRoot, file, { mode: 'chapters' });
  assert.equal(res.chapters, 3);
  const meta = await storage.readBookMeta(res.path);
  assert.deepEqual(meta.chapters.map((chapter) => chapter.name), ['第 1 部分', '第 2 部分', '第 3 部分']);
  const texts = [];
  for (const chapter of meta.chapters) {
    texts.push((await storage.loadChapterText(res.path, chapter.file)).text);
  }
  assert.equal(texts.join(''), body, '切片后拼回原文必须逐字相同');
  assert.ok(texts.every((text) => text.length <= 50000 + 2), '每片不超过目标长度（空行最多多 2 字符）');

  // 自动分章模式同样兜底（那边没有标题时只给一章「全文」）
  const splitFile = path.join(src, '无标题长文-自动分章.txt');
  await fs.writeFile(splitFile, body, 'utf8');
  const splitRes = await importer.importNovelFile(booksRoot, splitFile, { mode: 'split' });
  assert.equal(splitRes.chapters, 3);
  const splitMeta = await storage.readBookMeta(splitRes.path);
  assert.deepEqual(splitMeta.chapters.map((chapter) => chapter.name), ['第 1 部分', '第 2 部分', '第 3 部分']);

  // 有标题的正常拆章：完全不受 b10 影响
  const titled = path.join(src, '有标题.txt');
  await fs.writeFile(titled, '第1章 开端\n\n正文一。\n\n第2章 继续\n\n正文二。', 'utf8');
  const titledRes = await importer.importNovelFile(booksRoot, titled, { mode: 'chapters' });
  const titledMeta = await storage.readBookMeta(titledRes.path);
  assert.equal(titledMeta.chapters.length, 2);
  assert.deepEqual(titledMeta.chapters.map((chapter) => chapter.name), ['第1章 开端', '第2章 继续']);
});

// V50（1.7.2 D3）：「一个能导入的文件都不剩」是**跳过**（FILE_TOO_LARGE +「已跳过」），不是复制失败。
// 这条 StorageError 抛在 importBookFolder 的 try 里，被同函数 catch 无条件包成 IMPORT_FAILED
// （文案前缀变成「复制失败：」、错误码丢成 IMPORT_FAILED），整源落进 failed 显示成红色失败。
test('全部超限 → failed=0 / skipped=1 / code=FILE_TOO_LARGE / 文案含「已跳过」（V50）', async () => {
  const base = await mkTmp();
  const src = path.join(base, '全都超限');
  await fs.mkdir(src);
  const huge = path.join(src, '001-巨大.txt');
  await fs.writeFile(huge, '');
  // 稀疏文件：只把长度改到上限 +1，不真的写 128 MB 字节
  await fs.truncate(huge, importer.MAX_IMPORT_BYTES + 1);

  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [src]);

  assert.equal(res.imported.length, 0);
  assert.equal(res.failed.length, 0, JSON.stringify(res.failed));
  assert.equal(res.skipped.length, 1, JSON.stringify(res.skipped));
  assert.equal(res.skipped[0].code, 'FILE_TOO_LARGE');
  assert.ok(res.skipped[0].reason.includes('已跳过'), res.skipped[0].reason);
  assert.ok(!res.skipped[0].reason.includes('复制失败'), res.skipped[0].reason);
  assert.ok(!res.skipped[0].reason.includes(base), '提示里不该带本机目录');
  // 一个能导入的文件都不剩时不留一本空书
  assert.deepEqual(await fs.readdir(booksRoot), []);
});

// V57（1.7.2 D3）：文件夹形态导入是 fs.cp 递归复制，子目录里的 txt 也在复制范围内 ——
// 只按顶层 listTxtFiles 过闸门时，子目录里的 129 MB txt 会被整个抄进书库（绕过 128 MB 闸门）。
test('子目录里的超限 txt 也被 128 MB 闸门拦下（V57）', async () => {
  const base = await mkTmp();
  const externalRoot = path.join(base, '外部');
  await fs.mkdir(externalRoot);
  const created = await storage.createBook(externalRoot, '带附卷的书');
  await storage.saveChapterText(created.path, created.meta.chapters[0].file, '第一章正文');
  const subDir = path.join(created.path, '附卷');
  await fs.mkdir(subDir);
  const huge = path.join(subDir, '009-巨大.txt');
  await fs.writeFile(huge, '');
  await fs.truncate(huge, importer.MAX_IMPORT_BYTES + 1);

  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [created.path]);

  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].kind, 'book');
  assert.equal(res.failed.length, 0, JSON.stringify(res.failed));
  assert.equal(res.skipped.length, 1, JSON.stringify(res.skipped));
  assert.equal(res.skipped[0].code, 'FILE_TOO_LARGE');
  assert.equal(res.skipped[0].source, path.join('附卷', '009-巨大.txt'));
  assert.ok(res.skipped[0].reason.includes('009-巨大'), res.skipped[0].reason);
  assert.ok(!res.skipped[0].reason.includes(base), '提示里不该带本机目录');

  const importedPath = res.imported[0].path;
  await assert.rejects(
    fs.access(path.join(importedPath, '附卷', '009-巨大.txt')),
    '子目录里的超限文件不该被复制进来'
  );
  // 闸门内的章节照常导入、照常可读
  const meta = await storage.readBookMeta(importedPath);
  assert.equal(meta.chapters.length, 1);
  assert.equal((await storage.loadChapterText(importedPath, meta.chapters[0].file)).text, '第一章正文');
});

// V69（1.7.2 D3）：回给渲染层的跳过 / 失败项只带相对名，不再把作者本机的绝对路径带出主进程
// （渲染层只显示 reason，但绝对路径经 IPC 回到渲染层既无用又多泄露一份目录结构）。
test('skipped[].source 只回相对名，不带本机路径（V69）', async () => {
  const base = await mkTmp();
  const booksRoot = path.join(base, '书架');

  // ① 文件级跳过：相对源文件夹的路径
  const src = path.join(base, '书目录');
  await fs.mkdir(src);
  await fs.writeFile(path.join(src, '001-开端.txt'), '第1章 开端\n\n正文。', 'utf8');
  const huge = path.join(src, '002-巨大.txt');
  await fs.writeFile(huge, '');
  await fs.truncate(huge, importer.MAX_IMPORT_BYTES + 1);
  const res = await importer.importFolders(booksRoot, [src]);
  assert.equal(res.skipped.length, 1, JSON.stringify(res.skipped));
  assert.equal(res.skipped[0].source, '002-巨大.txt');
  assert.equal(path.isAbsolute(res.skipped[0].source), false, res.skipped[0].source);
  assert.ok(!/[A-Za-z]:[\\/]/.test(res.skipped[0].source), res.skipped[0].source);
  assert.ok(!res.skipped[0].source.includes(base), res.skipped[0].source);

  // ② 整源跳过：只回文件夹名（这个来源根本不存在）
  const res2 = await importer.importFolders(booksRoot, [path.join(base, '不存在的文件夹')]);
  assert.equal(res2.skipped.length, 1);
  assert.equal(res2.skipped[0].source, '不存在的文件夹');
  assert.equal(path.isAbsolute(res2.skipped[0].source), false, res2.skipped[0].source);

  // ③ 失败项同样不带本机路径（收藏夹里混着坏文件）
  const mixed = path.join(base, '收藏夹');
  await fs.mkdir(mixed);
  await fs.writeFile(path.join(mixed, '好书.txt'), '第1章 开端\n\n正文。', 'utf8');
  await fs.writeFile(path.join(mixed, '坏书.txt'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  const res3 = await importer.importFolders(booksRoot, [mixed]);
  assert.equal(res3.failed.length, 1, JSON.stringify(res3.failed));
  assert.equal(res3.failed[0].source, '坏书.txt');
  assert.equal(path.isAbsolute(res3.failed[0].source), false, res3.failed[0].source);
});

// V57（1.7.2 D3）：dropped / willLose 按「相对书目录的路径」比，不按 basename ——
// 否则子目录里的 卷/002.txt 会把它同名的根目录章 002.txt 一起判成丢失：轻则书目把还在的章删掉，
// 重则 willLose 满额把整源误判成「全部超限」。这份书目用手写 JSON 造（本应用的 assertChapterFile
// 不许章节进子目录，但导入进来的外部文件夹可以是任意形状）。
test('dropped / willLose 用相对名，同名不同目录的章不会被一起判成丢失（V57）', async () => {
  const base = await mkTmp();
  const src = path.join(base, '外部书');
  await fs.mkdir(src);
  await fs.writeFile(path.join(src, '002.txt'), '第1章 甲\n\n正文甲', 'utf8');
  await fs.mkdir(path.join(src, '卷'));
  const huge = path.join(src, '卷', '002.txt');
  await fs.writeFile(huge, '');
  await fs.truncate(huge, importer.MAX_IMPORT_BYTES + 1);
  await fs.writeFile(
    path.join(src, '书目.json'),
    JSON.stringify({
      version: 1,
      id: 'b_external',
      title: '外部书',
      fileSeq: 2,
      chapters: [
        { id: 'ch_001', file: '002.txt', name: '甲', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'ch_002', file: '卷/002.txt', name: '乙', createdAt: '2026-01-01T00:00:01.000Z' }
      ],
      lastOpenChapterId: 'ch_001',
      createdAt: '2026-01-01T00:00:00.000Z'
    }),
    'utf8'
  );

  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [src]);
  assert.equal(res.imported.length, 1, JSON.stringify({ skipped: res.skipped, failed: res.failed }));
  assert.equal(res.imported[0].kind, 'book');
  assert.equal(res.imported[0].chapters, 1, '只剩没超限的那章');
  assert.equal(res.skipped.length, 1, JSON.stringify(res.skipped));
  assert.equal(res.skipped[0].source, path.join('卷', '002.txt'));

  const importedPath = res.imported[0].path;
  await assert.rejects(fs.access(path.join(importedPath, '卷', '002.txt')), '超限章节不该被复制进来');
  const meta = await storage.readBookMeta(importedPath);
  assert.deepEqual(meta.chapters.map((c) => c.file), ['002.txt'], '同名的根目录章不能被一起删掉');
  assert.ok(meta.chapters.some((c) => c.id === meta.lastOpenChapterId), '上次打开章节要落在仍在的章上');
  assert.equal((await storage.loadChapterText(importedPath, '002.txt')).text, '第1章 甲\n\n正文甲');
});

// ---------- 审计修复 #13（E9）：章节文件名判定复用 heading 词表 + 认纯数字名 ----------

test('E9 形态判定：数字 / 单位 / 关键词跟 heading.js 的 import 词表走，纯数字名也算章节', () => {
  // 章节文件：序号 + 分隔符 / 「第X章」式标题（含 话 / 幕）/ 纯数字名 / 关键词标题
  for (const name of [
    '001-雪夜.txt',
    '12_卷名.txt',
    '3、序.txt',
    '第1章 雪夜.txt',
    '第 12 章.txt',
    '第3话 归途.txt', // 旧实现词表写死成 章节回卷集篇部，话 / 幕 不算章节
    '第7幕 收束.txt',
    '楔子.txt',
    '序章.txt',
    '番外1.txt',
    'Chapter 1.txt',
    '001.txt', // 纯数字名：旧实现要求尾随分隔符，整目录被判成 novels
    '1.txt',
    '12.txt',
    '123.txt',
    '0001.txt'
  ]) {
    assert.equal(importer.looksLikeChapterFile(name), true, '应算章节文件：' + name);
  }
  // 独立小说：书名 / 「书名 - 作者」/ 年份或纯数字书名 / 非章节式标题
  for (const name of [
    '星海旅人.txt',
    '星海旅人 - 某作者.txt',
    '1984.txt', // 4 位纯数字更像年份 / 书名，仍按一本独立小说
    '2024年度总结.txt', // 数字后面直接接汉字，不是章节序号
    '第X章.txt', // 非数字序号不算
    '第1話.txt' // import 场景有意不认繁体「話」（heading.test.js 的跨场景差异表）
  ]) {
    assert.equal(importer.looksLikeChapterFile(name), false, '应算独立小说：' + name);
  }
});

test('E9：纯数字文件名的章节目录整目录导入成一本书（不再每个文件各导成一书）', async () => {
  const base = await mkTmp();
  const src = path.join(base, '纯数字章节目录');
  await fs.mkdir(src);
  await fs.writeFile(path.join(src, '001.txt'), '开篇正文', 'utf8');
  await fs.writeFile(path.join(src, '002.txt'), '承接正文', 'utf8');
  await fs.writeFile(path.join(src, '003.txt'), '收束正文', 'utf8');

  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [src]);
  assert.equal(res.imported.length, 1, '三个 001/002/003.txt 是同一本书的三章');
  assert.equal(res.imported[0].kind, 'chapter-folder');
  assert.equal(res.imported[0].chapters, 3);
  assert.equal(res.imported[0].title, '纯数字章节目录');

  const meta = await storage.readBookMeta(res.imported[0].path);
  assert.equal(meta.chapters.length, 3);
  assert.equal((await storage.loadChapterText(res.imported[0].path, '002.txt')).text, '承接正文');
  assert.equal((await storage.listBooks(booksRoot)).length, 1, '书架里只有一本书');
});

test('E9：单个纯数字 txt 按「一本书的章节目录」导入，不占书名', async () => {
  const base = await mkTmp();
  const src = path.join(base, '旧稿夹');
  await fs.mkdir(src);
  await fs.writeFile(path.join(src, '001.txt'), '唯一一章的正文', 'utf8');

  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [src]);
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].kind, 'chapter-folder', '单个 001.txt 就是章节目录');
  assert.equal(res.imported[0].title, '旧稿夹', '书名取文件夹名（独立小说才取文件名）');
});

// ---------- 五-M24（TC-6）＋ TC-2：导入来源的排除口径三形态统一 ----------

// 五-M24（TC-6）：novels 形态（「一堆独立小说」文件夹）以前整条绕过 X-N6 的冲突副本闸门 ——
// 正本与同步盘生成的「-冲突副本.txt」各导成一本书，书架多出重复书。现在与 copyAsTexts 同口径
// 排除，并把被排除的文件记进 skipped（既不静默导入，也不静默消失）。
test('五-M24：novels 形态不把同步冲突副本当独立小说导入，记 skipped', async () => {
  const base = await mkTmp();
  const src = path.join(base, '独立小说集');
  await fs.mkdir(src);
  await fs.writeFile(path.join(src, '星海旅人.txt'), '第1章 夜雨\n\n正文。', 'utf8');
  await fs.writeFile(path.join(src, '星海旅人-冲突副本.txt'), '第1章 夜雨\n\n旧稿正文。', 'utf8');

  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [src]);

  assert.equal(res.failed.length, 0, JSON.stringify(res.failed));
  assert.equal(res.imported.length, 1, '正本导入一本，冲突副本不再各成一本');
  assert.equal(res.imported[0].title, '星海旅人');
  assert.equal(res.skipped.length, 1, JSON.stringify(res.skipped));
  assert.equal(res.skipped[0].source, '星海旅人-冲突副本.txt');
  assert.match(res.skipped[0].reason, /同步冲突副本/);
  assert.ok(!res.skipped[0].reason.includes(base), '提示里不该带本机目录');
  assert.equal((await storage.listBooks(booksRoot)).length, 1, '书架里只有正本一本');
  // 只跳过不删源：源文件夹原样保留两个文件
  assert.equal((await fs.readdir(src)).length, 2);
});

// TC-2（与五-M24 同根因）：点前缀文件（macOS / SMB 共享的 AppleDouble `._001-起风.txt`、
// 作者放的 `.notes.txt`）不是章节 —— 不参与形态判定、不复制进书库、不重建进书目。
test('五-M24 / TC-2：点前缀 txt 不参与形态判定、不复制、不进书目', async () => {
  const base = await mkTmp();
  const src = path.join(base, '跨平台目录');
  await fs.mkdir(src);
  const real = [];
  for (let i = 1; i <= 5; i += 1) {
    const name = `00${i}-第${i}章.txt`;
    real.push(name);
    await fs.writeFile(path.join(src, name), `第${i}章 标题\n\n正文${i}。`, 'utf8');
    // AppleDouble 资源叉：二进制、扩展名仍是 .txt
    await fs.writeFile(path.join(src, `.${name}`), Buffer.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02]));
  }
  assert.deepEqual(await storage.listTxtFiles(src), real, 'listTxtFiles 统一排除点前缀');

  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [src]);

  assert.equal(res.imported.length, 1, '5 个真章是一本书的章节目录，不是 5 本小说');
  assert.equal(res.imported[0].kind, 'chapter-folder');
  assert.equal(res.imported[0].chapters, 5, '._ 文件没有被收编成章节');
  const importedPath = res.imported[0].path;
  const copied = await fs.readdir(importedPath);
  assert.equal(copied.some((name) => name.startsWith('.')), false, '点前缀文件不许进书库');
  const meta = await storage.readBookMeta(importedPath);
  assert.deepEqual(meta.chapters.map((chapter) => chapter.file), real);
});

// TC-2 同口径：形态判定只数「可导入」的文件 —— 冲突副本再多也不能把章节目录翻转成 novels，
// 否则每个真章会被当成一本独立小说导入（100 个真章 + 100 个冲突副本 → 书架多出 100 本书）。
test('五-M24：同步冲突副本不参与形态判定，章节目录不会被翻转成一堆独立小说', async () => {
  const base = await mkTmp();
  const src = path.join(base, '混合目录');
  await fs.mkdir(src);
  for (let i = 1; i <= 3; i += 1) {
    await fs.writeFile(path.join(src, `00${i}-第${i}章.txt`), `第${i}章 标题\n\n正文${i}。`, 'utf8');
  }
  for (let i = 1; i <= 4; i += 1) {
    await fs.writeFile(path.join(src, `旧稿${i} (conflicted copy ${i}).txt`), `旧稿内容${i}`, 'utf8');
  }

  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [src]);

  assert.equal(res.imported.length, 1, '3 个真章仍是一本书的章节目录');
  assert.equal(res.imported[0].kind, 'chapter-folder');
  assert.equal(res.imported[0].chapters, 3, '冲突副本不进书目');
});

// ---------- 五-M25（TC-7）：大小闸门与读盘 / 复制必须绑在同一趟上 ----------

// 单本形态：旧的「先 stat 后 readFile」两趟在间隙里被同步盘换大就会绕过 128 MB 闸门，
// 整份读进主进程。现在改成单句柄 open → fstat → handle.readFile（S8 口径），
// 并按句柄实际读到的字节再复核一次。这里用一个假句柄模拟「fstat 时还小、读出来已经超限」。
test('五-M25：单本读取的尺寸闸门绑在同一个句柄上，读出来超限也拒绝（不 OOM）', async () => {
  const base = await mkTmp();
  const src = path.join(base, '收藏夹');
  await fs.mkdir(src);
  const file = path.join(src, '会变大的书.txt');
  await fs.writeFile(file, '第1章 开端\n\n正文。', 'utf8');

  const realOpen = fs.open;
  let opened = 0;
  fs.open = async (target, ...rest) => {
    if (path.resolve(String(target)) !== path.resolve(file)) return realOpen(target, ...rest);
    opened += 1;
    return {
      async stat() {
        return { size: 16 };
      },
      async readFile() {
        return Buffer.alloc(importer.MAX_IMPORT_BYTES + 1, 0x41);
      },
      async close() {}
    };
  };
  const booksRoot = path.join(base, '书架');
  try {
    await assert.rejects(
      () => importer.importNovelFile(booksRoot, file),
      (err) => err.code === 'FILE_TOO_LARGE' && /128 MB/.test(err.message) && !err.message.includes(base)
    );
  } finally {
    fs.open = realOpen;
  }
  assert.equal(opened, 1, '闸门与读盘必须走同一个句柄');
  assert.deepEqual(await fs.readdir(booksRoot).catch(() => []), [], '被拒绝的导入不留任何东西');
});

// 章节目录形态：collectOversizedTxt 之后到 fs.copyFile 之间被换大，旧实现会把 >128 MB 的文件
// 抄进书库（之后永久打不开）。现在复制完按暂存副本的实际字节复核，超限的删掉自己刚复制的
// 那一份并记 skipped（源文件不动）。
test('五-M25：章节目录复制后复核实际字节，间隙里被换大的 txt 删除并记 skipped', async () => {
  const base = await mkTmp();
  const src = path.join(base, '书目录');
  await fs.mkdir(src);
  await fs.writeFile(path.join(src, '001-开端.txt'), '第1章 开端\n\n正文一。', 'utf8');
  await fs.writeFile(path.join(src, '002-承接.txt'), '第2章 承接\n\n正文二。', 'utf8');

  const realCopyFile = fs.copyFile;
  fs.copyFile = async (from, to, ...rest) => {
    const result = await realCopyFile(from, to, ...rest);
    if (path.basename(String(from)) === '002-承接.txt') {
      // 复制瞬间被同步盘换大：只在暂存副本上做稀疏截断，源文件保持原样
      await fs.truncate(String(to), importer.MAX_IMPORT_BYTES + 1);
    }
    return result;
  };
  const booksRoot = path.join(base, '书架');
  let res;
  try {
    res = await importer.importFolders(booksRoot, [src]);
  } finally {
    fs.copyFile = realCopyFile;
  }

  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].kind, 'chapter-folder');
  assert.equal(res.imported[0].chapters, 1, '超限那一章不进书目');
  assert.equal(res.skipped.length, 1, JSON.stringify(res.skipped));
  assert.equal(res.skipped[0].code, 'FILE_TOO_LARGE');
  assert.equal(res.skipped[0].source, '002-承接.txt');
  assert.equal(res.skippedTooLarge, 1);
  const importedPath = res.imported[0].path;
  await assert.rejects(fs.access(path.join(importedPath, '002-承接.txt')), '超限副本不该发布');
  const meta = await storage.readBookMeta(importedPath);
  assert.deepEqual(meta.chapters.map((chapter) => chapter.file), ['001-开端.txt']);
  // 源文件一个字节都没动（只清理暂存里的副本）
  assert.equal((await fs.stat(path.join(src, '002-承接.txt'))).size, Buffer.byteLength('第2章 承接\n\n正文二。'));
});

// 现成书形态：fs.cp 整目录复制同样有「先扫描后复制」的间隙。复制后按暂存副本实际字节复核，
// 超限章节从书目剔掉并记 skipped —— 不能让书库里出现永久打不开的章节文件。
test('五-M25：现成书整目录复制后复核实际字节，超限章节剔出书目并记 skipped', async () => {
  const base = await mkTmp();
  const externalRoot = path.join(base, '外部');
  await fs.mkdir(externalRoot);
  const created = await storage.createBook(externalRoot, '外部书');
  await storage.createChapter(created.path, 2, '承接');
  const sourceMeta = await storage.readBookMeta(created.path);
  await storage.saveChapterText(created.path, sourceMeta.chapters[0].file, '第一章内容');
  await storage.saveChapterText(created.path, sourceMeta.chapters[1].file, '第二章内容');
  const targetChapterFile = sourceMeta.chapters[1].file;

  const realCp = fs.cp;
  fs.cp = async (from, to, options) => {
    const result = await realCp(from, to, options);
    if (path.resolve(String(from)) === path.resolve(created.path)) {
      await fs.truncate(path.join(String(to), targetChapterFile), importer.MAX_IMPORT_BYTES + 1);
    }
    return result;
  };
  const booksRoot = path.join(base, '书架');
  let res;
  try {
    res = await importer.importFolders(booksRoot, [created.path]);
  } finally {
    fs.cp = realCp;
  }

  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].kind, 'book');
  assert.equal(res.imported[0].chapters, 1, '超限章节从书目里剔掉');
  assert.equal(res.skipped.length, 1, JSON.stringify(res.skipped));
  assert.equal(res.skipped[0].code, 'FILE_TOO_LARGE');
  assert.equal(res.skipped[0].source, targetChapterFile);
  const importedPath = res.imported[0].path;
  await assert.rejects(fs.access(path.join(importedPath, targetChapterFile)), '超限章节不该发布');
  const importedMeta = await storage.readBookMeta(importedPath);
  assert.equal(importedMeta.chapters.length, 1);
  assert.ok(importedMeta.chapters.some((chapter) => chapter.id === importedMeta.lastOpenChapterId));
});
// ---------- 第五轮审计：CIO-A-01 / CIO-A-02（导入产物的「书目=真实文件」口径） ----------

// 半坏来源：书目引用了 _trash 下的章节（copyAsBook 无条件过滤，keep 豁免不生效）。
// 旧逻辑只剔 oversized 命中的章，这条引用会原样进新书 → 永远打不开的悬挂章节。
test('CIO-A-02：来源书目引用 _trash 里的章节时，导入书目把它剔掉（不留悬挂章节）', async () => {
  const base = await mkTmp();
  const externalRoot = path.join(base, '外部');
  await fs.mkdir(externalRoot);
  const created = await storage.createBook(externalRoot, '半坏来源');
  await storage.createChapter(created.path, 1, '第二章');
  const meta = await storage.readBookMeta(created.path);
  const first = meta.chapters[0].file;
  await storage.saveChapterText(created.path, first, '第一章正文');
  await fs.mkdir(path.join(created.path, '_trash'), { recursive: true });
  await fs.writeFile(path.join(created.path, '_trash', '002-挪走.txt'), '旧稿', 'utf8');
  await storage.writeBookMeta(created.path, {
    ...meta,
    chapters: [meta.chapters[0], { ...meta.chapters[1], file: '_trash/002-挪走.txt' }]
  });

  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [created.path]);
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].kind, 'book');
  assert.equal(res.imported[0].chapters, 1, '悬挂章节不进新书');
  assert.equal(res.skipped.length, 1, JSON.stringify(res.skipped));
  assert.equal(res.skipped[0].code, 'CHAPTER_MISSING');
  assert.equal(res.skipped[0].tooLarge, false, '缺失不是体量超限，不许冒充 tooLarge');
  assert.match(res.skipped[0].reason, /没有复制进新书/);
  const importedMeta = await storage.readBookMeta(res.imported[0].path);
  assert.equal(importedMeta.chapters.length, 1);
  assert.equal(importedMeta.chapters[0].file, first);
  assert.equal(importedMeta.chapters.some((chapter) => chapter.file.startsWith('_trash')), false);
});

// CIO-A-01：预检之后所有章节都被剔光（复制期间被换大 / 全在排除目录）时，旧实现落到
// `kept[0].id` 抛 TypeError，被包成 IMPORT_FAILED「复制失败：Cannot read properties…」。
// 现在按整源跳过报 FILE_TOO_LARGE，与章节目录分支对称。
test('CIO-A-01：复制后章节全被剔光 → 按整源跳过，不抛 TypeError 变成「复制失败」', async () => {
  const base = await mkTmp();
  const externalRoot = path.join(base, '外部');
  await fs.mkdir(externalRoot);
  const created = await storage.createBook(externalRoot, '全悬挂来源');
  const meta = await storage.readBookMeta(created.path);
  await storage.saveChapterText(created.path, meta.chapters[0].file, '正文');
  await fs.mkdir(path.join(created.path, '_trash'), { recursive: true });
  await fs.writeFile(path.join(created.path, '_trash', '001-挪走.txt'), '旧稿', 'utf8');
  await storage.writeBookMeta(created.path, {
    ...meta,
    chapters: [{ ...meta.chapters[0], file: '_trash/001-挪走.txt' }]
  });

  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [created.path]);
  assert.equal(res.imported.length, 0, '一个能导入的章节都不剩时不留空书');
  assert.equal(res.failed.length, 0, '这是「跳过」，不是「复制失败」');
  assert.equal(res.skipped.length, 1, JSON.stringify(res.skipped));
  assert.equal(res.skipped[0].code, 'FILE_TOO_LARGE');
  assert.match(res.skipped[0].reason, /没能复制进新书/);
  assert.match(res.skipped[0].reason, /已跳过/);
  assert.deepEqual(await fs.readdir(booksRoot).catch(() => []), [], '暂存已清，书架里不留空书');
});

// CIO-A-03：暂存残留判据取「树内最新 mtime」+ 跳过仍存活的 pid。
// 暂存根只会有一个书子目录、其后写入都在更深一层，根目录 mtime 停在创建时刻——
// 只看根目录会把超过 1 小时的在途长导入误删。
test('CIO-A-03：长导入的暂存目录不被误删（看树内活动 + 跳过存活 pid）', async () => {
  const base = await mkTmp();
  const source = path.join(base, '源书');
  await fs.mkdir(source);
  const created = await storage.createBook(source, '源书');
  await storage.createChapter(created.path, 1, '一');
  const booksRoot = path.join(base, '书架');
  await fs.mkdir(booksRoot, { recursive: true });
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const tag = Date.now().toString(36);

  // 1) 根目录很老，但书子目录里刚写过 = 另一个窗口正在导入 → 必须留下
  const live = path.join(booksRoot, `.import-99999-${tag}-live01`);
  await fs.mkdir(path.join(live, '书'), { recursive: true });
  await fs.writeFile(path.join(live, '书', '001.txt'), '正在写', 'utf8');
  await fs.utimes(live, old, old); // 根停在创建时刻（这就是旧实现的判据）
  // 2) 全树都老 + pid 已死 = 崩溃残留 → 回收
  const stale = path.join(booksRoot, `.import-99999-${tag}-stale1`);
  await fs.mkdir(path.join(stale, '书'), { recursive: true });
  await fs.writeFile(path.join(stale, '书', '001.txt'), '旧', 'utf8');
  await fs.utimes(path.join(stale, '书', '001.txt'), old, old);
  await fs.utimes(path.join(stale, '书'), old, old);
  await fs.utimes(stale, old, old);
  // 3) 名字里的 pid 仍存活（本进程）→ 哪怕全树都老也不动
  const mine = path.join(booksRoot, `.import-${process.pid}-${tag}-mine01`);
  await fs.mkdir(path.join(mine, '书'), { recursive: true });
  await fs.writeFile(path.join(mine, '书', '001.txt'), '本进程在写', 'utf8');
  await fs.utimes(mine, old, old);

  const res = await importer.importFolders(booksRoot, [created.path]);
  assert.equal(res.imported.length, 1);
  const left = (await fs.readdir(booksRoot)).filter((name) => name.startsWith('.import-'));
  assert.ok(left.includes(path.basename(live)), '树内刚写过 → 不许当残留删');
  assert.ok(!left.includes(path.basename(stale)), '全树超 1 小时 + pid 已死 → 回收');
  assert.ok(left.includes(path.basename(mine)), 'pid 仍存活 → 不许动');
});

// CIO-A-04：书 id 不再只靠毫秒时间戳（跨窗口同毫秒会撞 id），追加随机后缀。
test('CIO-A-04：导入生成的 book id 带随机后缀，形状仍以 b_ 开头', async () => {
  const base = await mkTmp();
  const src = path.join(base, '独立小说');
  await fs.mkdir(src);
  const booksRoot = path.join(base, '书架');
  const ids = [];
  for (const title of ['甲书', '乙书']) {
    const file = path.join(src, `${title}.txt`);
    await fs.writeFile(file, '第一章 开端\n\n正文。', 'utf8');
    const res = await importer.importNovelFile(booksRoot, file);
    const meta = await storage.readBookMeta(res.path);
    ids.push(meta.id);
    assert.match(meta.id, /^b_[0-9a-z]+_[0-9a-z]{4,8}$/, 'id = 毫秒时间戳 + 随机后缀');
  }
  assert.notEqual(ids[0], ids[1], '两本书不会拿到同一个 id');
});
// CIO-A-05：analyzeSource 的 reason 只写不读（每个分支的调用方都用固定文案），已删。
test('CIO-A-05：analyzeSource 不再返回只写不读的 reason 死字段', async () => {
  const raw = await fs.readFile(path.join(__dirname, '..', 'core', 'importer.js'), 'utf8');
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/reason:\s*err\.message/.test(code), false, 'reason 死数据已删');
});

// ---------- 三审 P1 / E1（T3 / T4）：导入侧体量上限的行为锚点 ----------

// P1（三审·高）的纯判定边界：导入切出来的每一章都必须能保存（chapter:save 的 500 万字上限）。
// maxChars 只给这里注入小上限；生产调用不传，走 core/limits.js 的唯一常量。
test('P1：firstOversizedPart 正好上限放行 / 多一个字拒绝（三种导入模式共用同一判定）', () => {
  const maxChars = 1000;
  assert.equal(importer.firstOversizedPart([{ title: 'a', body: '字'.repeat(maxChars) }], { maxChars }), null);
  const over = importer.firstOversizedPart(
    [
      { title: 'a', body: '字'.repeat(maxChars) },
      { title: 'b', body: '字'.repeat(maxChars + 1) }
    ],
    { maxChars }
  );
  assert.deepEqual(over, { index: 1, length: maxChars + 1, title: 'b' });
  // split 模式的正文在 text 字段
  const split = importer.firstOversizedPart([{ title: 'a', text: '字'.repeat(maxChars + 1) }], { maxChars, pick: 'text' });
  assert.equal(split.index, 0);
  // 默认值就是 core/limits.js 的保存上限（不另立小上限）
  assert.equal(require('../core/limits').MAX_CHAPTER_SAVE_CHARS, 5000000);
});

// T3（三审·高）：raw「整本一章」超 500 万字的整链 —— 以前 128 MB 内的文件会原样导成单章，
// 导出的书「能打开、Ctrl+S / 救稿全被拒」。现在写盘前明确拒绝，书架里不留半本书；
// 拒绝文案要给出可操作下一步（拆源文件 / 改用按原文章节导入）。
test('T3：整本一章超 500 万字 → 写盘前拒绝、不留半本书，并提示改用按原文章节导入（P1）', async () => {
  const limits = require('../core/limits');
  const base = await mkTmp();
  const src = path.join(base, '超长篇');
  await fs.mkdir(src);
  const file = path.join(src, '超长篇.txt');
  await fs.writeFile(file, '字'.repeat(limits.MAX_CHAPTER_SAVE_CHARS + 100), 'utf8');
  const booksRoot = path.join(base, '书架');

  await assert.rejects(
    () => importer.importNovelFile(booksRoot, file, { mode: 'raw' }),
    (err) => {
      assert.equal(err.code, 'TEXT_TOO_LARGE');
      assert.match(err.message, /5,000,100 字/);
      assert.match(err.message, /超过单章上限 5,000,000 字/);
      assert.match(err.message, /没有导入/);
      assert.match(err.message, /按原文章节导入/);
      assert.equal(err.message.includes(file), false, '错误文案不带本机完整路径');
      return true;
    }
  );
  // 拒绝发生在建暂存目录之前：书架根里一个 .import- 残留都没有
  const leftovers = await fs.readdir(booksRoot).catch(() => []);
  assert.deepEqual(leftovers, [], '拒绝导入不产生暂存残留 / 正式书目录');

  // 走 importFolders 的整批路径：失败如实进 failed（界面汇总显示原因），不会静默丢
  const throughFolders = await importer.importFolders(booksRoot, [src], { mode: 'raw' });
  assert.equal(throughFolders.imported.length, 0);
  assert.equal(throughFolders.failed.length, 1);
  assert.match(throughFolders.failed[0].message, /超过单章上限/);
  assert.deepEqual((await fs.readdir(booksRoot)).filter((name) => !name.startsWith('.import-')), [], '书架里没有书');
});

// T4（三审·高）：导入切出的章数在写盘前校验 —— 旧实现有多少标题写多少章，20,001 章的
// 书目能写盘、读侧直接判损坏（E1「应用自己导入出一本打不开的书」）。
test('T4：按原文拆出 20,001 章 → 写盘前拒绝，绝不出保存在不了的书目（E1）', async () => {
  const limits = require('../core/limits');
  const base = await mkTmp();
  const src = path.join(base, '超多章');
  await fs.mkdir(src);
  const lines = [];
  for (let i = 1; i <= limits.MAX_META_CHAPTERS + 1; i += 1) {
    lines.push(`第${i}章 标题${i}\n\n正文${i}`);
  }
  const file = path.join(src, '超多章.txt');
  await fs.writeFile(file, lines.join('\n\n'), 'utf8');
  const booksRoot = path.join(base, '书架');

  await assert.rejects(
    () => importer.importNovelFile(booksRoot, file, {}),
    (err) => {
      assert.equal(err.code, 'META_TOO_MANY_CHAPTERS');
      assert.match(err.message, /20,001 条/);
      assert.match(err.message, /超过单本上限 20,000 条/);
      assert.match(err.message, /没有导入/);
      return true;
    }
  );
  const leftovers = await fs.readdir(booksRoot).catch(() => []);
  assert.deepEqual(leftovers, [], '拒绝时一个章节文件都不写（也没有 .import- 残留）');
  // 正好 20,000 条是放行的：只钉纯判定，避免真写两万个章节文件
  assert.equal(limits.chapterCountProblem(limits.MAX_META_CHAPTERS), null);
});
