const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const storage = require('../core/storage');
const chapters = require('../core/chapters');
const importer = require('../core/importer');

const tmpCleanup = require('./tmp-cleanup');

async function mkTmp() {
  return tmpCleanup.track(await fs.mkdtemp(path.join(os.tmpdir(), 'cw-import-')));
}

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
