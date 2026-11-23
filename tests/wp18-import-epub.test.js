'use strict';
// WP18 第 1–2 轮（2026-11-18）的导入 / EPUB 锚点（TEST-D-01：按子域从 tests/wp18-low-batch.test.js 拆出）。
// 本文件只收「导入复制过滤 / s2t 准字表 / EPUB 固定文案与 cover meta」：
//   R1-R4  X-N6 现成书 / 章节目录导入：冲突副本与损坏归档不复制、保护例外照旧、cp EPERM 无暂存残留
//   R5      X-N10 s2t 补「准→準」（保护短语不动 / T2S 反推）
//   R6-R7   X-N11 EPUB 固定文案随 labels 转换；X-N12 删 legacy cover meta
//   R8      X-N11 / X-N12 IPC 端到端（真实 ipc/export.js + s2t 档位）
// 审计编号保留在用例名里，供台账溯源。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const storage = require('../core/storage');
const importer = require('../core/importer');
const s2t = require('../core/s2t');
const epub = require('../core/epub');
const exporter = require('../core/exporter');
const chaptersLib = require('../core/chapters');
const docxLib = require('../core/docx');
const ipcLimits = require('../core/ipc-limits');
const atomic = require('../core/atomic');
const pathUtils = require('../core/path-utils');
const exportIpc = require('../ipc/export');
const { readZip } = require('../scripts/export-check');
const tmpCleanup = require('./tmp-cleanup');

// TB-02：临时目录统一经 tests/tmp-cleanup.js 的 mkTmp（mkdtemp + 登记回收）。
const mkTmp = (prefix = 'cw-wp18-') => tmpCleanup.mkTmp(prefix);

function readSource(rel) {
  return require('node:fs').readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
}

function sliceFrom(source, startMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `找不到锚点：${startMarker}`);
  const rest = source.slice(start + startMarker.length);
  const next = rest.search(/\n {2}(?:async function |function |handleBook\(|handle\()/);
  return next === -1 ? rest : rest.slice(0, next);
}

function zipEntries(buffer) {
  const zip = readZip(buffer);
  return new Map(zip.entries.map((entry) => [entry.name, entry.data]));
}
// ---------- R1 / R2 / R3 / R4：X-N6 导入复制过滤 ----------

test('R1 X-N6 现成书：冲突副本 / 损坏归档不进新书，.bak 与真章节照旧', async () => {
  const base = await mkTmp('cw-wp18-xn6-book-');
  const externalRoot = path.join(base, '外部');
  await fs.mkdir(externalRoot);
  const created = await storage.createBook(externalRoot, '过滤书');
  await storage.saveChapterText(created.path, created.meta.chapters[0].file, '第一章正文');
  await storage.createChapterWithText(created.path, { insertIndex: 1, name: '夜雨', text: '第二章正文' });

  // 同步盘会生成的垃圾：冲突副本书目 / 顶层与子目录的冲突副本 txt / 损坏书目归档
  await fs.writeFile(path.join(created.path, '书目 (conflicted copy 1).json'), JSON.stringify({ title: '别抄我' }), 'utf8');
  await fs.writeFile(path.join(created.path, '001-夜雨-冲突副本.txt'), '冲突副本内容', 'utf8');
  await fs.mkdir(path.join(created.path, '子目录'), { recursive: true });
  await fs.writeFile(path.join(created.path, '子目录', '003-冲突副本.txt'), '嵌套冲突副本', 'utf8');
  await fs.writeFile(path.join(created.path, `${storage.BOOK_FILE}.corrupt-20260101T000000`), '{ 这不是 json', 'utf8');
  // 正常恢复副本 / 点前缀 / _trash：.bak 要留，其余照旧排除
  await fs.writeFile(path.join(created.path, `${storage.BOOK_FILE}.bak`), '{"old":true}\n', 'utf8');
  await fs.writeFile(path.join(created.path, '.hidden.txt'), '隐藏文件', 'utf8');
  await fs.mkdir(path.join(created.path, storage.TRASH_DIR), { recursive: true });
  await fs.writeFile(path.join(created.path, storage.TRASH_DIR, '回收.txt'), '回收', 'utf8');

  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [created.path]);
  assert.equal(res.failed.length, 0, `不该失败：${JSON.stringify(res.failed)}`);
  assert.equal(res.imported.length, 1);
  const importedPath = res.imported[0].path;
  const flat = (await fs.readdir(importedPath, { recursive: true })).map((name) =>
    String(name).split(path.sep).join('/')
  );

  assert.equal(
    flat.some((name) => /conflicted|冲突副本/i.test(name)),
    false,
    `冲突副本不许进新书：${flat.join(', ')}`
  );
  assert.equal(
    flat.some((name) => name.startsWith(storage.CORRUPT_PREFIX)),
    false,
    `损坏书目归档不许进新书：${flat.join(', ')}`
  );
  assert.ok(flat.includes(`${storage.BOOK_FILE}.bak`), '.bak 是恢复副本，照旧保留');
  assert.equal(
    (await fs.readFile(path.join(importedPath, `${storage.BOOK_FILE}.bak`), 'utf8')),
    '{"old":true}\n',
    '.bak 内容逐字节不动'
  );
  assert.equal(flat.includes('.hidden.txt'), false, '点前缀文件照旧不复制');
  assert.equal(flat.some((name) => name === storage.TRASH_DIR || name.startsWith(`${storage.TRASH_DIR}/`)), false);

  const meta = await storage.readBookMeta(importedPath);
  assert.equal(meta.chapters.length, 2, '真章节一个不少');
  for (const chapter of meta.chapters) {
    assert.ok(flat.includes(chapter.file), `书目引用的章节要在：${chapter.file}`);
  }
  assert.equal((await storage.loadChapterText(importedPath, meta.chapters[1].file)).text, '第二章正文');
});

test('R2 X-N6 章节目录：冲突副本不进复制 / 超限清单；真章完整', async () => {
  const base = await mkTmp('cw-wp18-xn6-chapters-');
  const src = path.join(base, '章节目录');
  await fs.mkdir(src, { recursive: true });
  await fs.writeFile(path.join(src, '001-甲.txt'), '甲章正文', 'utf8');
  await fs.writeFile(path.join(src, '002-乙.txt'), '乙章正文', 'utf8');
  await fs.writeFile(path.join(src, '003-丙-冲突副本.txt'), '冲突副本不许当章', 'utf8');
  // 极值：128 MB + 1 字节的稀疏「冲突副本」——它本来就不复制，也不该被报成超限跳过
  const huge = path.join(src, '004-超大-冲突副本.txt');
  const handle = await fs.open(huge, 'w');
  try {
    await handle.truncate(128 * 1024 * 1024 + 1);
  } finally {
    await handle.close();
  }

  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [src]);
  assert.equal(res.failed.length, 0, `不该失败：${JSON.stringify(res.failed)}`);
  assert.equal(res.imported.length, 1);
  assert.deepEqual(res.skipped || [], [], '被过滤的冲突副本不该再进「超限跳过」清单');
  const importedPath = res.imported[0].path;
  const files = (await fs.readdir(importedPath)).filter((name) => name !== storage.BOOK_FILE).sort();
  assert.deepEqual(files, ['001-甲.txt', '002-乙.txt'], '只复制真章节');
  const meta = await storage.readBookMeta(importedPath);
  assert.equal(meta.chapters.length, 2);
  assert.deepEqual(meta.chapters.map((chapter) => chapter.file).sort(), ['001-甲.txt', '002-乙.txt']);
});

test('R3 X-N6 保护例外：源书目引用的「冲突副本」文件名章节不许丢', async () => {
  const base = await mkTmp('cw-wp18-xn6-keep-');
  const externalRoot = path.join(base, '外部');
  await fs.mkdir(externalRoot);
  const created = await storage.createBook(externalRoot, '保护书');
  await storage.saveChapterText(created.path, created.meta.chapters[0].file, '第一章正文');
  const added = await storage.createChapterWithText(created.path, {
    insertIndex: 1,
    name: '冲突副本',
    text: '这章名字里有冲突副本四个字，但它是书目引用的真章节'
  });
  const sourceMeta = await storage.readBookMeta(created.path);
  assert.equal(sourceMeta.chapters.length, 2);
  assert.match(added.chapter.file, /冲突副本/, '测试前提：章节文件名确实撞上冲突副本识别规则');

  const booksRoot = path.join(base, '书架');
  const res = await importer.importFolders(booksRoot, [created.path]);
  assert.equal(res.failed.length, 0, `不该失败：${JSON.stringify(res.failed)}`);
  assert.equal(res.imported.length, 1);
  const importedPath = res.imported[0].path;
  const meta = await storage.readBookMeta(importedPath);
  assert.equal(meta.chapters.length, 2, '被书目引用的章节不许当垃圾过滤');
  for (const chapter of meta.chapters) {
    assert.equal(
      await storage.exists(path.join(importedPath, chapter.file)),
      true,
      `导入后书目引用的章节必须存在：${chapter.file}`
    );
  }
  assert.equal((await storage.loadChapterText(importedPath, added.chapter.file)).text, '这章名字里有冲突副本四个字，但它是书目引用的真章节');

  // 源目录本身的名字撞上冲突副本识别规则（作者明确选它导入）→ 根目录不做名字过滤，整本照常复制
  const wholeConflict = await storage.createBook(externalRoot, '整本-冲突副本');
  await storage.saveChapterText(wholeConflict.path, wholeConflict.meta.chapters[0].file, '整本冲突副本里的真正文');
  const res2 = await importer.importFolders(booksRoot, [wholeConflict.path]);
  assert.equal(res2.failed.length, 0, `整本冲突副本文件夹不该失败：${JSON.stringify(res2.failed)}`);
  assert.equal(res2.imported.length, 1);
  const wholeMeta = await storage.readBookMeta(res2.imported[0].path);
  assert.equal(wholeMeta.chapters.length, 1);
  assert.equal(
    (await storage.loadChapterText(res2.imported[0].path, wholeMeta.chapters[0].file)).text,
    '整本冲突副本里的真正文',
    '根目录名撞规则时内容照旧复制'
  );
});

test('R4 X-N6 极值 × IO 失败注入：fs.cp EPERM → 失败、无暂存残留、源不动', async () => {
  const base = await mkTmp('cw-wp18-xn6-fail-');
  const externalRoot = path.join(base, '外部');
  await fs.mkdir(externalRoot);
  const created = await storage.createBook(externalRoot, '复制失败书');
  await storage.saveChapterText(created.path, created.meta.chapters[0].file, '不能被删的正文');
  const booksRoot = path.join(base, '书架');

  const originalCp = fs.cp;
  fs.cp = async () => {
    const err = new Error('EPERM: operation not permitted, copyfile');
    err.code = 'EPERM';
    throw err;
  };
  let res;
  try {
    res = await importer.importFolders(booksRoot, [created.path]);
  } finally {
    fs.cp = originalCp;
  }
  assert.equal(res.imported.length, 0);
  assert.equal(res.failed.length, 1, '复制失败要如实记 failed，不许静默');
  assert.match(res.failed[0].message, /复制失败/);
  assert.deepEqual(await fs.readdir(booksRoot), [], '失败后不许留暂存 / 半本书');
  assert.equal(await fs.readFile(path.join(created.path, '书目.json'), 'utf8').then(() => true), true);
  assert.equal(
    (await storage.loadChapterText(created.path, created.meta.chapters[0].file)).text,
    '不能被删的正文',
    '源书一个字节不动'
  );
});

// ---------- R5：X-N10 s2t 准字表 ----------

test('R5 X-N10：准→準进字表，保护短语仍保持原样，T2S 反推同步', () => {
  assert.equal(s2t.convertText('标准 准备 准确 准时 准绳 准予', 's2t'), '標準 準備 準確 準時 準繩 准予');
  // 7 条保护短语：短语优先于字表，「批准 / 不准 / 核准」这类词里的 准 保持原字
  assert.equal(
    s2t.convertText('批准 准许 不准 准予 核准 照准 允准', 's2t'),
    '批准 准許 不准 准予 核准 照准 允准'
  );
  // 完整句子里两套规则并存
  assert.equal(
    s2t.convertText('批准之前先准备，标准要准确。', 's2t'),
    '批准之前先準備，標準要準確。'
  );
  // 繁→简反推：準→准
  assert.equal(s2t.convertText('標準 準備 準確', 't2s'), '标准 准备 准确');
  // 字表不变量：不能引入重复 / 冲突条目
  assert.deepEqual(s2t.INVALID_PAIRS, []);
  assert.deepEqual(s2t.PAIR_CONFLICTS, []);
  assert.deepEqual(s2t.T2S_CONFLICTS, []);
  const map = new Map(s2t.S2T_PAIRS.map((pair) => [pair[0], pair[1]]));
  assert.equal(map.get('准'), '準');
  // 文件头声明与实现对齐：干 / 冲 只由短语表覆盖，不再声称已进字表
  const source = readSource('core/s2t.js');
  const header = source.slice(0, source.indexOf('const S2T_RAW'));
  assert.match(header, /准/);
  assert.doesNotMatch(header, /准 \/ 划 \/[\s\S]{0,80}干 \/ 冲[\s\S]{0,40}以最常用写法进字表/, '干 / 冲 不该再声称进字表');
});

// ---------- R6 / R7：X-N11 固定文案 + X-N12 cover meta ----------

function epubMeta() {
  return {
    title: '门后的人',
    id: 'b_wp18_epub',
    author: '说话人',
    titleTemplate: '第{num}章：{name}',
    volumes: [],
    chapters: [
      { id: 'c1', file: '001.txt', name: '开端' },
      { id: 'c2', file: '002.txt', name: '夜雨' }
    ]
  };
}

const EPUB_TEXTS = ['第一段正文。\n第二段。', '夜里的雨声。'];
const FIXED = new Date('2026-11-01T00:00:00Z');
const TRAD_LABELS = { nav: '目錄', cover: '封面', toc: '目錄' };

function makeSink() {
  const chunks = [];
  return {
    chunks,
    async write(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (buffer.length) chunks.push(Buffer.from(buffer));
    }
  };
}

test('R6 X-N11：EPUB 固定文案随 labels 转换，默认不变，流式与整本逐字节一致', async () => {
  const plain = await epub.buildEpub({ meta: epubMeta(), texts: [...EPUB_TEXTS], modified: FIXED, zipDate: FIXED });
  const plainZip = zipEntries(plain.buffer);
  const plainNav = plainZip.get('OEBPS/nav.xhtml').toString('utf8');
  const plainOpf = plainZip.get('OEBPS/content.opf').toString('utf8');
  assert.match(plainNav, /<h1>目录<\/h1>/, '默认档位仍是「目录」');
  assert.match(plainOpf, /<reference type="cover" title="封面" href="cover.xhtml"\/>/, '默认封面 guide');
  assert.match(plainOpf, /<reference type="toc" title="目录" href="nav.xhtml"\/>/, '默认目录 guide');

  const converted = await epub.buildEpub({
    meta: epubMeta(),
    texts: [...EPUB_TEXTS],
    modified: FIXED,
    zipDate: FIXED,
    labels: TRAD_LABELS
  });
  const convertedZip = zipEntries(converted.buffer);
  const nav = convertedZip.get('OEBPS/nav.xhtml').toString('utf8');
  const opf = convertedZip.get('OEBPS/content.opf').toString('utf8');
  assert.match(nav, /<h1>目錄<\/h1>/, '繁体档位的目录页大标题必须是「目錄」');
  assert.match(opf, /<reference type="toc" title="目錄" href="nav.xhtml"\/>/, 'OPF guide 目录标题也要转');
  assert.match(opf, /<reference type="cover" title="封面" href="cover.xhtml"\/>/, '封面标题繁简同形');
  assert.equal((nav.match(/<h1>/g) || []).length, 1, '目录页只有一个大标题');

  // labels 坏值 / 空串回默认，产物与默认逐字节一致
  const fallback = await epub.buildEpub({
    meta: epubMeta(),
    texts: [...EPUB_TEXTS],
    modified: FIXED,
    zipDate: FIXED,
    labels: { nav: '   ', cover: null, toc: 42 }
  });
  assert.deepEqual(fallback.buffer, plain.buffer, '坏 labels 必须回默认文案');

  // 流式路径与整本构建逐字节一致（labels 走同一个 normalizeInput）
  const sink = makeSink();
  await epub.streamEpub(
    {
      meta: epubMeta(),
      texts: [...EPUB_TEXTS],
      readText: async (index) => EPUB_TEXTS[index],
      modified: FIXED,
      zipDate: FIXED,
      labels: TRAD_LABELS
    },
    sink.write
  );
  assert.deepEqual(Buffer.concat(sink.chunks), converted.buffer, 'streamEpub 也要带上 labels');
});

test('R7 X-N12：删掉 legacy cover meta，guide cover reference 保留', async () => {
  const built = await epub.buildEpub({ meta: epubMeta(), texts: [...EPUB_TEXTS], modified: FIXED, zipDate: FIXED });
  const zip = zipEntries(built.buffer);
  const opf = zip.get('OEBPS/content.opf').toString('utf8');
  assert.equal(opf.includes('<meta name="cover" content="cover"/>'), false, 'EPUB2 封面图片声明必须删掉');
  assert.equal(/<meta name="cover"/.test(opf), false);
  assert.match(opf, /<reference type="cover" title="封面" href="cover.xhtml"\/>/, 'guide 的正确声明要留着');
  // 封面页本身仍是文字封面
  const cover = zip.get('OEBPS/cover.xhtml').toString('utf8');
  assert.match(cover, /class="cover-title"/);
  // 静态：core/epub.js 不再写这行，且固定文案走 labels
  const source = readSource('core/epub.js');
  assert.equal(/name="cover"/.test(source), false);
  assert.match(source, /heading/, 'navDocument 要用传入的 heading');
});

// ---------- R8：X-N11 / X-N12 IPC 端到端 ----------

function makeExportHost({ targetPath, conversion }) {
  const channels = new Map();
  const host = {
    handle: (name, fn) => { channels.set(name, fn); },
    handleBook: (name, fn) => { channels.set(name, fn); },
    storage: {
      readBookMeta: (bookPath) => storage.readBookMeta(bookPath),
      loadChapterText: (bookPath, file) => storage.loadChapterText(bookPath, file)
    },
    exporter,
    chaptersLib,
    epubLib: epub,
    docxLib,
    s2tLib: s2t,
    ipcLimits,
    mapLimit: async (items, _limit, fn) => Promise.all(items.map(fn)),
    CHAPTER_READ_CONCURRENCY: 4,
    CHAPTER_BATCH_SIZE: 16,
    path,
    pathUtils,
    app: { getPath: () => path.join(os.tmpdir(), 'cw-documents') },
    fs,
    fsSync: require('node:fs'),
    getConfig: async () => ({ exportConversion: conversion, lastExportDir: '' }),
    getClipboard: () => ({ writeText: async () => {} }),
    showSaveDialog: async () => ({ canceled: false, filePath: targetPath }),
    rememberExportDir: async () => {},
    atomicWriteFile: atomic.atomicWriteFile,
    atomicWriteFileStream: atomic.atomicWriteFileStream
  };
  exportIpc.register(host);
  return channels;
}

test('R8 X-N11/X-N12 IPC 端到端：s2t 导出 EPUB 的目录页 / guide / cover meta', async () => {
  const base = await mkTmp('cw-wp18-ipc-epub-');
  const booksRoot = path.join(base, '书库');
  await fs.mkdir(booksRoot, { recursive: true });
  const created = await storage.createBook(booksRoot, '测试书');
  await storage.saveChapterText(created.path, created.meta.chapters[0].file, '第一段内容。');
  await storage.createChapterWithText(created.path, { insertIndex: 1, name: '开端', text: '第二段内容。' });

  const tradTarget = path.join(base, '繁体.epub');
  const tradChannels = makeExportHost({ targetPath: tradTarget, conversion: 's2t' });
  const trad = await tradChannels.get('book:export-epub')(created.path, null, null);
  assert.equal(trad.canceled, false);
  const tradZip = zipEntries(await fs.readFile(tradTarget));
  const tradNav = tradZip.get('OEBPS/nav.xhtml').toString('utf8');
  const tradOpf = tradZip.get('OEBPS/content.opf').toString('utf8');
  const tradNcx = tradZip.get('OEBPS/toc.ncx').toString('utf8');
  assert.match(tradNav, /<h1>目錄<\/h1>/, '繁体导出的目录页大标题必须是「目錄」');
  assert.match(tradOpf, /<reference type="toc" title="目錄" href="nav.xhtml"\/>/, 'OPF guide 目录标题也要转');
  assert.equal(tradOpf.includes('name="cover"'), false, '导出的 OPF 不许再有 legacy cover meta');
  assert.match(tradNcx, /<docTitle><text>測試書<\/text><\/docTitle>/, '书名照旧转繁（对照）');

  const plainTarget = path.join(base, '简体.epub');
  const plainChannels = makeExportHost({ targetPath: plainTarget, conversion: '' });
  const plain = await plainChannels.get('book:export-epub')(created.path, null, null);
  assert.equal(plain.canceled, false);
  const plainZip = zipEntries(await fs.readFile(plainTarget));
  const plainNav = plainZip.get('OEBPS/nav.xhtml').toString('utf8');
  const plainOpf = plainZip.get('OEBPS/content.opf').toString('utf8');
  assert.match(plainNav, /<h1>目录<\/h1>/);
  assert.match(plainOpf, /<reference type="toc" title="目录" href="nav.xhtml"\/>/);

  // 静态接线：共享内核把转换后的固定文案传给格式的流式构建
  const kernel = sliceFrom(readSource('ipc/export.js'), '  async function exportStructured(bookPath, override, range, options) {');
  assert.match(kernel, /s2tLib\.convertText\('目录', conversion\)/, '目录固定文案要过 convertText');
  assert.match(kernel, /s2tLib\.convertText\('封面', conversion\)/, '封面固定文案要过 convertText');
  assert.match(kernel, /labels,/, '转换后的 labels 要随 stream 输入传下去');
});

