'use strict';
// WP18 第 1 轮（2026-11-18，HEAD dcb1d5d）的红-绿锚点：
//   R1  X-N6 现成书导入：冲突副本 / 损坏归档不进新书，.bak / 真章节照旧
//   R2  X-N6 章节目录导入：冲突副本 txt 不复制、不进超限清单；真章完整
//   R3  X-N6 保护例外：源书目真的引用了「冲突副本」名字的章节时不许丢
//   R4  X-N6 极值 × IO 失败注入：fs.cp EPERM → 导入失败、无暂存残留、源不动
//   R5  X-N10 s2t 补「准→準」：未保护词全转、7 条保护短语仍保持原样、T2S 反推
//   R6  X-N11 EPUB 固定文案（nav 大标题 / OPF guide）随 labels 转换；默认不变；流式一致
//   R7  X-N12 删 legacy cover meta（guide cover reference 保留）
//   R8  X-N11/X-N12 IPC 端到端：真实 ipc/export.js + s2t 档位
//   R9  台账 #1 / E-N7：book:delete 生产分支入书锁（等待 / EPERM 兜底 / E2E 重入不死锁）
// WP18 第 2 轮（2026-11-18，HEAD c0b661e）追加：
//   R10 B2 数据面：storage.readBookCard 与 listBooks 同书卡片逐字段一致（NO_BOOK / 坏书目）
//   R11 B2 渲染层：shelf-ui.handleShelfChanged 单书增量 / 删除删卡 / 无路径整表 / 读失败整表兜底
//   R12 B2 接线：books:card IPC + preload.readBookCard + main 广播带 bookPath（静态）
//   R13 C4：preload 传输层异常文案过脱敏（盘符 / UNC / file URL / 控制字符 / 限长）
//   R14 台账 #3：app:force-close 是活监听（close-guard 常量 = main 字面量、真实树无死监听）
//   R15 台账 #3：E2E-only api 登记（真实树 0 提示；新未用 api 仍提示见 wiring-manifest 负控）
//   R16 C3：启动回收 lastExportDir 的孤儿 tmp（口径与 userData / 书目录一致）
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
const bookIpc = require('../ipc/book');
const exportIpc = require('../ipc/export');
const pathUtils = require('../core/path-utils');
const { readZip } = require('../scripts/export-check');
const tmpCleanup = require('./tmp-cleanup');

async function mkTmp(prefix = 'cw-wp18-') {
  return tmpCleanup.track(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    app: { getPath: () => path.join(os.tmpdir(), 'cw-documents') },
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

// ---------- R9：台账 #1 / E-N7 删书入锁 ----------

function makeDeleteHost(root, { isE2E = false, trashItem } = {}) {
  const channels = new Map();
  const host = {
    handle: (name, fn) => { channels.set(name, fn); },
    handleBook: (name, fn) => { channels.set(name, fn); },
    storage,
    repair: {},
    importer: {},
    openBooksLib: {},
    ipcLimits: {},
    ipcPaths: {},
    ipcRestoreToken: {},
    restoreTokens: {},
    errorText: {
      describeForUi: (err) => ({ message: String((err && err.message) || err) }),
      cleanText: (text) => String(text == null ? '' : text),
      redactPaths: (text) => String(text == null ? '' : text)
    },
    pathUtils,
    fs,
    path,
    shell: { trashItem: trashItem || (async () => {}) },
    getConfig: async () => ({ booksRoot: root }),
    flowSession: () => null,
    sessionById: () => null,
    focusSession: () => {},
    flushLastOpenBeforeRead: async () => {},
    lastOpenWrites: new Map(),
    bookKeyOf: (p) => pathUtils.pathKey(p),
    rememberRecentBook: () => {},
    notifyShelfChanged: () => {},
    sendToFlow: () => {},
    logError: () => {},
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    automation: { enabled: false },
    isE2E
  };
  bookIpc.register(host);
  return channels;
}

test('R9 台账 #1：book:delete 生产分支入书锁（等待 / EPERM 兜底 / E2E 重入不死锁）', async () => {
  const base = await mkTmp('cw-wp18-delete-lock-');
  const root = path.join(base, '书架');
  await fs.mkdir(root, { recursive: true });

  // 1) 书锁被长任务持有时：删除必须等锁，不允许把目录搬走
  const first = await storage.createBook(root, '并发删除书');
  let releaseLock;
  let acquiredResolve;
  const acquired = new Promise((resolve) => { acquiredResolve = resolve; });
  const held = storage.withBookLock(first.path, async () => {
    acquiredResolve();
    await new Promise((resolve) => { releaseLock = resolve; });
  });
  await acquired;
  const recycleDir = path.join(base, '回收站');
  await fs.mkdir(recycleDir, { recursive: true });
  const channels = makeDeleteHost(root, {
    trashItem: async (target) => {
      // 模拟真实的回收站：把目录搬走（可恢复）
      await fs.rename(target, path.join(recycleDir, path.basename(target)));
    }
  });
  const deleteBook = channels.get('book:delete');
  const pending = deleteBook(first.path).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
  await sleep(80);
  assert.equal(
    await storage.exists(path.join(first.path, '书目.json')),
    true,
    '书锁没释放之前，book:delete 必须等待（旧实现会立刻把目录搬走）'
  );
  releaseLock();
  await held;
  const outcome = await pending;
  assert.equal(outcome.ok, true, `删除失败：${outcome.ok ? '' : outcome.error.message}`);
  assert.equal(outcome.value.method, 'recycle');
  assert.equal(await storage.exists(first.path), false, '锁释放后照常完成删除');

  // 2) 回收站不可用（EPERM）→ _trash 兜底，仍在锁内完成；锁自己不能卡死
  const second = await storage.createBook(root, '兜底删除书');
  const fallbackChannels = makeDeleteHost(root, {
    trashItem: async () => {
      const err = new Error('EPERM: operation not permitted, rename');
      err.code = 'EPERM';
      throw err;
    }
  });
  const fallback = await fallbackChannels.get('book:delete')(second.path);
  assert.equal(fallback.method, 'move');
  assert.match(fallback.note, /回收站不可用/);
  assert.ok(fallback.trashPath.startsWith(path.join(root, storage.TRASH_DIR)));
  assert.equal(await storage.exists(second.path), false);
  await Promise.race([
    storage.withBookLock(second.path, async () => {}),
    sleep(3000).then(() => { throw new Error('删除失败后书锁没有释放（3s 超时）'); })
  ]);

  // 3) E2E 分支走 storage.trashBook（内部自带书锁）→ 外层书锁重入，不许死锁
  const third = await storage.createBook(root, 'E2E删除书');
  const e2eChannels = makeDeleteHost(root, { isE2E: true });
  const e2e = await Promise.race([
    e2eChannels.get('book:delete')(third.path),
    sleep(3000).then(() => { throw new Error('E2E 分支重入书锁死锁（3s 超时）'); })
  ]);
  assert.equal(e2e.method, 'move');
  assert.equal(await storage.exists(third.path), false);

  // 静态：删除动作包在 storage.withBookLock 里（检查 / 搬目录同一临界区）
  const deleteBody = sliceFrom(readSource('ipc/book.js'), "  handleBook('book:delete', async (bookPath) => {");
  assert.match(deleteBody, /storage\.withBookLock\(target, async \(\) =>/, 'book:delete 必须入书锁');
  assert.ok(
    deleteBody.indexOf('storage.withBookLock(target') < deleteBody.indexOf('shell.trashItem(target)'),
    '锁要包住回收站分支'
  );
});

// ---------- R10 / R11 / R12：B2 书架增量广播 ----------

test('R10 B2 数据面：readBookCard 与 listBooks 同书卡片逐字段一致（NO_BOOK / 坏书目）', async () => {
  const root = await mkTmp('cw-wp18-card-');
  const first = await storage.createBook(root, '甲书');
  await storage.saveChapterText(first.path, first.meta.chapters[0].file, '第一章正文'.repeat(200));
  await storage.createChapterWithText(first.path, { insertIndex: 1, name: '开端', text: '第二段正文' });
  const second = await storage.createBook(root, '乙书');
  await fs.writeFile(path.join(second.path, '001-夜雨-冲突副本.txt'), '冲突副本', 'utf8');
  // 不含书目的普通目录：整表跳过、单读必须报 NO_BOOK（不伪造一张空卡）
  const plain = path.join(root, '普通文件夹');
  await fs.mkdir(plain, { recursive: true });

  const listed = await storage.listBooks(root);
  assert.equal(listed.length, 2, `普通文件夹不该进书架：${JSON.stringify(listed.map((book) => book.folder))}`);
  for (const book of listed) {
    const card = await storage.readBookCard(book.path);
    assert.deepEqual(card, book, `单读卡片必须与整表同书条目逐字段一致（${book.folder}）`);
  }
  await assert.rejects(() => storage.readBookCard(plain), (err) => err && err.code === 'NO_BOOK');
  assert.equal(
    listed.find((book) => book.folder === path.basename(second.path)).conflicts.length,
    1,
    '冲突副本提示要跟着单读一起回来'
  );

  // 坏书目：整表给 corrupt 卡（书架照旧能显示并点修复），单读抛错（渲染层据此整表兜底）
  const broken = path.join(root, '坏书');
  await fs.mkdir(broken, { recursive: true });
  await fs.writeFile(path.join(broken, storage.BOOK_FILE), '{ 这不是 json', 'utf8');
  const withBroken = await storage.listBooks(root);
  const corrupt = withBroken.find((book) => book.path === broken);
  assert.ok(corrupt, '坏书目仍要在整表里占一张 corrupt 卡');
  assert.equal(corrupt.status, 'corrupt');
  assert.deepEqual(corrupt.conflicts, []);
  await assert.rejects(() => storage.readBookCard(broken), '坏书目单读必须 reject，不许把 corrupt 卡伪装成正常书');
});

const shelfUiModule = require('../renderer/shelf-ui');

function makeShelfChangedHost(options = {}) {
  const calls = { read: [], rendered: 0, refreshed: 0, marked: 0, stats: 0 };
  const state = options.state || {
    view: 'shelf',
    books: [],
    importing: false,
    formatBookRunning: false,
    chapters: [],
    index: 0,
    dirty: false,
    recentBook: null
  };
  const cards = options.cards || {};
  const api = {
    readBookCard: async (bookPath) => {
      calls.read.push(bookPath);
      if (options.onRead) return options.onRead(bookPath);
      return cards[bookPath] || null;
    }
  };
  const shelfUi = shelfUiModule.create({
    $: () => null,
    state,
    chapterTitle: () => '',
    formatRelativeTime: () => '',
    openBookByPath: async () => ({ ok: true }),
    askUnsaved: async () => 'cancel',
    saveCurrent: async () => ({ ok: true }),
    loadChapterAt: async () => {},
    api,
    call: async (fn, ...args) => fn(...args),
    renderShelf: () => { calls.rendered += 1; },
    refreshShelf: async () => { calls.refreshed += 1; },
    refreshStats: async () => { calls.stats += 1; },
    markCommandsDirty: () => { calls.marked += 1; }
  });
  return { shelfUi, state, calls };
}

test('R11 B2 渲染层：单书增量 / 删除删卡 / 无路径整表 / 读失败整表兜底 / 非书架跳过', async () => {
  assert.throws(
    () => shelfUiModule.create({}),
    /createShelfUi 的 host 缺少/,
    'REQUIRED_HOST 校验照旧（可选成员不能把它弄丢）'
  );
  const bookA = { path: 'C:\\书架\\甲书', title: '甲书', lastModified: 100, chapterCount: 1 };
  const bookB = { path: 'C:\\书架\\乙书', title: '乙书', lastModified: 300, chapterCount: 2 };
  const updatedA = { path: 'C:\\书架\\甲书', title: '甲书（改名）', lastModified: 500, chapterCount: 3 };

  // 1) 单书 mutation：只读这一张卡，不整表刷新；替换 + 按 lastModified 重排 + 重绘
  const one = makeShelfChangedHost({
    state: {
      view: 'shelf',
      books: [bookB, bookA],
      importing: false,
      formatBookRunning: false,
      chapters: [],
      index: 0,
      dirty: false,
      recentBook: null
    },
    cards: { [bookA.path]: updatedA }
  });
  const cardResult = await one.shelfUi.handleShelfChanged({ reason: 'chapter:save', bookPath: bookA.path });
  assert.equal(cardResult.mode, 'card');
  assert.deepEqual(one.calls.read, [bookA.path], '增量只许读变更的那本书');
  assert.equal(one.calls.refreshed, 0, '单书保存不许整表 books:list');
  assert.equal(one.calls.rendered, 1);
  assert.equal(one.calls.marked, 1, '书名可能变了，命令面板条目要重建');
  assert.equal(one.calls.stats, 1, '字数变了，书架头统计跟着刷新（不重扫全书架）');
  assert.deepEqual(one.state.books.map((book) => book.title), ['甲书（改名）', '乙书'], '按 lastModified 倒序重排');

  // 2) book:delete：直接从书架删卡，一个字节都不读
  const removed = await one.shelfUi.handleShelfChanged({ reason: 'book:delete', bookPath: bookA.path });
  assert.equal(removed.mode, 'remove');
  assert.equal(one.calls.read.length, 1, '删除不读盘');
  assert.deepEqual(one.state.books.map((book) => book.title), ['乙书']);

  // 3) 无 bookPath（多本导入等结构性变更）：照旧整表刷新
  const full = await one.shelfUi.handleShelfChanged({ reason: 'book:import' });
  assert.equal(full.mode, 'full');
  assert.equal(one.calls.refreshed, 1);

  // 4) 读卡失败（坏书 / 路径失效）：退回整表，绝不把卡片弄丢
  const brokenHost = makeShelfChangedHost({
    state: { view: 'shelf', books: [bookA, bookB], importing: false, formatBookRunning: false, chapters: [], index: 0 },
    onRead: async () => { throw new Error('EISDIR'); }
  });
  const fallback = await brokenHost.shelfUi.handleShelfChanged({ reason: 'book:rename', bookPath: bookA.path });
  assert.equal(fallback.mode, 'full');
  assert.equal(brokenHost.calls.refreshed, 1);
  assert.deepEqual(brokenHost.state.books.map((book) => book.title), ['甲书', '乙书'], '兜底时不动现有卡片');

  // 5) 选卡返回的不是对象（旧协议 / 坏回包）→ 同样整表
  const badShapeHost = makeShelfChangedHost({
    state: { view: 'shelf', books: [bookA], importing: false, formatBookRunning: false, chapters: [], index: 0 },
    onRead: async () => 'not-a-card'
  });
  assert.equal((await badShapeHost.shelfUi.handleShelfChanged({ reason: 'book:rename', bookPath: bookA.path })).mode, 'full');
  assert.equal(badShapeHost.calls.refreshed, 1);

  // 6) 写作页 / 导入中 / 整本整理中：一个调用都不发（与旧接线同一守卫）
  for (const view of ['write', 'shelf-importing', 'shelf-formatting']) {
    const guard = makeShelfChangedHost({
      state: {
        view: view === 'write' ? 'write' : 'shelf',
        books: [bookA],
        importing: view === 'shelf-importing',
        formatBookRunning: view === 'shelf-formatting',
        chapters: [],
        index: 0
      }
    });
    const skipped = await guard.shelfUi.handleShelfChanged({ reason: 'chapter:save', bookPath: bookA.path });
    assert.equal(skipped.mode, 'skipped', `${view} 必须跳过`);
    assert.equal(guard.calls.read.length + guard.calls.refreshed, 0, `${view} 不许读盘 / 刷新`);
  }
});

test('R12 B2 接线：books:card IPC + preload.readBookCard + 广播载荷带 bookPath', async () => {
  const root = await mkTmp('cw-wp18-card-ipc-');
  const created = await storage.createBook(root, 'IPC 卡片书');
  const channels = makeDeleteHost(root);
  const readCard = channels.get('books:card');
  assert.equal(typeof readCard, 'function', 'ipc/book 必须注册 books:card');
  const card = await readCard(created.path);
  assert.equal(card.path, created.path);
  assert.equal(card.folder, path.basename(created.path));
  assert.equal(card.title, 'IPC 卡片书');

  const preloadSrc = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(preloadSrc, /readBookCard: \(bookPath\) => invoke\('books:card', bookPath\)/, 'preload 必须暴露 readBookCard');
  const bookSrc = readSource('ipc/book.js');
  assert.match(bookSrc, /handleBook\('books:card'[\s\S]*?READ_ONLY\)/, 'books:card 是只读频道（不许广播 / 不许拿书锁）');
  assert.match(bookSrc, /notifyShelfChanged\(flowSession\(\), 'book:create', created\.path\)/, '新建书广播要带新书路径');
  assert.match(bookSrc, /notifyShelfChanged\(session, 'book:import'\)/, '多本导入是结构性变更：不带单书路径（整表刷新）');

  const mainSrc = readSource('main.js');
  assert.match(mainSrc, /function notifyShelfChanged\(session, reason = '', bookPath = null\)/, '广播函数必须收 bookPath');
  assert.match(mainSrc, /broadcast\('shelf:changed', \{ reason, bookPath:/, 'shelf:changed 载荷必须带 bookPath');
  assert.match(mainSrc, /notifyShelfChanged\(session, channel, target\)/, 'handleBook 的广播要传这次变更的书路径');
  assert.match(readSource('renderer/renderer.js'), /shelfUi\.handleShelfChanged\(payload\)/, '渲染层事件要交给增量处理器');
});

// ---------- R13：C4 preload 传输层异常脱敏 ----------

function extractFunctionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `找不到函数 ${name}`);
  let depth = 0;
  let began = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') {
      depth += 1;
      began = true;
    } else if (ch === '}') {
      depth -= 1;
      if (began && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`函数 ${name} 的大括号不配对`);
}

test('R13 C4：preload 传输层异常文案过脱敏（盘符 / UNC / file URL / 控制字符 / 限长）', () => {
  const preloadSrc = readSource('preload.js');
  const body = extractFunctionSource(preloadSrc, 'sanitizeTransportMessage');
  const sanitize = new Function(`${body}; return sanitizeTransportMessage;`)();

  // 盘符路径只留最后一节，路径上的用户名 / 书名不出去
  assert.equal(
    sanitize('Error invoking remote method \'book:open\': Error: ENOENT: C:\\Users\\zhang\\我的小说\\第1章.txt'),
    'Error invoking remote method \'book:open\': Error: ENOENT: …\\第1章.txt'
  );
  // UNC 共享路径同样收口
  assert.equal(sanitize('打开失败 \\\\server\\share\\书\\ch1.txt 不存在'), '打开失败 …\\ch1.txt 不存在');
  // file:// URL
  assert.equal(sanitize('file:///D:/写书/导出/书.epub 打不开'), '…\\书.epub 打不开');
  // 控制字符清掉；没有本机路径的文案一个字节不动
  assert.equal(sanitize('通道\u0000未注册\u001f'), '通道未注册');
  assert.equal(sanitize("Error invoking remote method 'chapter:save': Error: 磁盘空间不足"), "Error invoking remote method 'chapter:save': Error: 磁盘空间不足");
  // 超长消息截断（传输异常偶尔会把整个参数带回来）
  const long = sanitize('x'.repeat(1200));
  assert.equal(long.length, 400);
  assert.equal(long.endsWith('…'), true);
  // 非字符串安全化，绝不抛
  assert.equal(sanitize(null), '');
  assert.equal(sanitize(undefined), '');
  assert.equal(typeof sanitize({ name: 'x' }), 'string');

  // 静态：invoke 的 catch 必须走脱敏（不是原来的 err.message）
  const invokeBody = sliceFrom(preloadSrc, 'async function invoke(channel, ...args) {');
  assert.match(invokeBody, /sanitizeTransportMessage\(/, 'invoke 兜底文案必须过 sanitizeTransportMessage');
  assert.equal(/message: \(err && err\.message\) \|\| String\(err\)/.test(invokeBody), false, '不许再原样回 err.message');
});

// ---------- R14 / R15：台账 #3 preload 死监听 / 暴露未用 api ----------

test('R14 台账 #3：app:force-close 是活监听（close-guard 常量 = main 字面量；真实树无死监听）', () => {
  const closeGuard = require('../core/close-guard');
  assert.equal(closeGuard.FORCE_CLOSE_CHANNEL, 'app:force-close');
  const mainSrc = readSource('main.js');
  assert.match(mainSrc, /webContents\.send\('app:force-close'\)/, 'main 发送必须用字面量（接线清单才看得见）');
  assert.equal(/webContents\.send\(plan\.channel\)/.test(mainSrc), false, '不许再用动态 plan.channel 发送');
  assert.match(
    mainSrc,
    /closeGuard\.FORCE_CLOSE_CHANNEL !== 'app:force-close'/,
    '字面量旁边要有「与 close-guard 同源」的显式断言，避免以后两处漂移'
  );

  const wiring = require('../scripts/wiring-check.js');
  const result = wiring.auditWiring(path.join(__dirname, '..'));
  assert.deepEqual(result.violations, [], '真实树接线必须零违规：' + JSON.stringify(result.violations));
  assert.deepEqual(result.facts.deadListeners, [], 'app:force-close 已有发送方，真实树不该再有死监听');
  const checkSrc = readSource('scripts/wiring-check.js');
  assert.match(checkSrc, /const KNOWN_DEAD_LISTENERS = \[\];/, '死监听白名单要清空（不许继续容留历史条目）');
});

test('R15 台账 #3：E2E-only api 登记（真实树 0 提示；名单只登记三条）', () => {
  const wiring = require('../scripts/wiring-check.js');
  const result = wiring.auditWiring(path.join(__dirname, '..'));
  assert.deepEqual(result.warnings, [], '真实树不该再有「暴露未用」提示：' + JSON.stringify(result.warnings));
  const checkSrc = readSource('scripts/wiring-check.js');
  const listMatch = /const E2E_ONLY_APIS = \[([^\]]*)\]/.exec(checkSrc);
  assert.ok(listMatch, 'wiring-check 必须登记 E2E_ONLY_APIS');
  const keys = listMatch[1]
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  assert.deepEqual(keys.sort(), ['findInText', 'setClipboardWatchTestText', 'testPickFont']);
  assert.match(checkSrc, /61-ipc-limits\.js/, '注释要点名 findInText 的 E2E 使用位置');
  assert.match(checkSrc, /26-display-options\.js/, '注释要点名 testPickFont 的 E2E 使用位置');
  assert.match(checkSrc, /72-capture\.js/, '注释要点名 setClipboardWatchTestText 的 E2E 使用位置');
});

// ---------- R16：C3 导出目录孤儿 tmp ----------

test('R16 C3：启动回收 lastExportDir 的孤儿 tmp（口径与 userData / 书目录一致）', async () => {
  const dir = await mkTmp('cw-wp18-exportdir-');
  const now = Date.now();
  const oldName = `.导出书.epub.tmp-999999-${now - 2 * 60 * 60 * 1000}-abcd12`;
  const freshName = `.导出书.epub.tmp-999999-${now - 1000}-efgh34`;
  const ownName = `.导出书.epub.tmp-${process.pid}-${now - 2 * 60 * 60 * 1000}-ijkl56`;
  await fs.writeFile(path.join(dir, oldName), '崩溃残留', 'utf8');
  await fs.writeFile(path.join(dir, freshName), '另一个进程可能正在写', 'utf8');
  await fs.writeFile(path.join(dir, ownName), '本进程的临时文件', 'utf8');
  // 判据是**文件 mtime**（名字里的时间戳只是标识）：把崩溃残留 / 本进程的临时文件都退到 2 小时前
  const old = new Date(now - 2 * 60 * 60 * 1000);
  await fs.utimes(path.join(dir, oldName), old, old);
  await fs.utimes(path.join(dir, ownName), old, old);
  await fs.writeFile(path.join(dir, '导出书.epub'), '正常产物', 'utf8');
  await fs.writeFile(path.join(dir, '.别人的临时文件'), '不是本应用命名的', 'utf8');
  await fs.mkdir(path.join(dir, '.目录.tmp-999999-1-zzzz11'));

  const swept = await atomic.cleanupOrphanTmpFiles(dir, { now });
  assert.deepEqual(swept, { removed: 1, kept: 2 }, '只清崩溃残留（外 pid + 超 1 小时）');
  assert.equal(await storage.exists(path.join(dir, oldName)), false, '崩溃残留要清掉');
  for (const keep of [freshName, ownName, '导出书.epub', '.别人的临时文件']) {
    assert.equal(await storage.exists(path.join(dir, keep)), true, `不许动：${keep}`);
  }
  assert.equal(await storage.exists(path.join(dir, '.目录.tmp-999999-1-zzzz11')), true, '同名目录不碰');

  // 目录不存在 / 目标被普通文件占据：返回 0/0，绝不抛（导出目录可能在移动硬盘上）
  assert.deepEqual(await atomic.cleanupOrphanTmpFiles(path.join(dir, '没有这个目录'), { now }), { removed: 0, kept: 0 });
  await fs.writeFile(path.join(dir, '其实是个文件'), 'x', 'utf8');
  assert.deepEqual(await atomic.cleanupOrphanTmpFiles(path.join(dir, '其实是个文件'), { now }), { removed: 0, kept: 0 });

  // 静态：启动链在配置读完（getConfig）之后、建窗之前回收 lastExportDir，且失败不影响启动
  const mainSrc = readSource('main.js');
  const userDataAt = mainSrc.indexOf("cleanupOrphanTmpFiles(app.getPath('userData'))");
  const exportAt = mainSrc.indexOf('cleanupOrphanTmpFiles(exportDir)');
  assert.ok(userDataAt > 0, 'userData 回收必须仍在');
  assert.ok(exportAt > userDataAt, '导出目录回收要排在 userData 之后（启动链同一处）');
  assert.ok(exportAt < mainSrc.indexOf('createWindow({ runAutomationFlow: true })'), '要在建窗之前回收');
  assert.match(mainSrc, /const exportDir = .*lastExportDir/, '导出目录取自配置的 lastExportDir');
  assert.match(mainSrc, /cleanupOrphanTmpFiles\(exportDir\)\.catch\(\(\) => \{\}\)/, '尽力而为：失败不影响启动');
});