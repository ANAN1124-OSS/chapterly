// C1（审计 #1 / P1、P3）：整本操作按批读正文 + 导出中间引用及时释放。
//
// 这里钉四件事：
//   1. 分批等价：跨过批边界（32 章）的查找 / 替换 / 整理，结果与「逐章直接算」逐字一致，
//      一章不漏、一章不重；批内缺文件的章照旧只跳过它自己；
//   2. 只改「什么时候读」：进度回调仍从 1 连续走到 total，统计 / 备份 / 字数缓存口径不变；
//   3. 导出链路：buildTxtExport 的字节与「compose → convert → buffer」逐字节一致，
//      并在 compose / 转换之后分别放掉 texts / composed（输入数组会被就地清空）；
//   4. 静态闸门：四处整本操作都走 forEachChapterBatch，三个导出入口都用新助手，
//      防止以后又退回「整本 texts 数组一次常驻」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const storage = require('../core/storage');
const exporter = require('../core/exporter');
const formatLib = require('../core/format');
const chaptersLib = require('../core/chapters');
const s2tLib = require('../core/s2t');

const tmpCleanup = require('./tmp-cleanup');

async function mkTmp(prefix = 'cw-batch-') {
  return tmpCleanup.track(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

const CHAPTERS = 70; // 32 章/批 → 3 批，批边界在 31/32/63 前后
const FORMAT_OPTIONS = { indent: '2', blankLines: 'keep', trimTrailing: true, normalizePunct: true };

// 造一本 CHAPTERS 章的书；textFor(index) 决定每章正文。
async function makeBook(textFor, count = CHAPTERS) {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '分批书');
  for (let i = 1; i < count; i += 1) {
    await storage.createChapter(bookPath, i, `第${i + 1}章`);
  }
  let meta = await storage.readBookMeta(bookPath);
  for (let i = 0; i < meta.chapters.length; i += 1) {
    await storage.saveChapterText(bookPath, meta.chapters[i].file, textFor(i));
  }
  meta = await storage.readBookMeta(bookPath);
  return { root, bookPath, meta };
}

// 命中的章分散在三个批里，并且正好压着批边界（下标 31 / 32 / 33 / 63）
const HIT_INDEXES = [0, 31, 32, 33, 63, 69];
const hitText = (index) => `开头。阿明走到第 ${index + 1} 章。阿明回头。`;
const missText = () => '这一章没有那个人。';

const readSource = (rel) =>
  require('node:fs').readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

const mainSource = readSource('main.js');

// 从锚点切到下一个顶格两空格的函数 / handler 之前（与 tests/export-read-order.test.js 同一手法）
function sliceFrom(source, startMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `找不到锚点：${startMarker}`);
  const rest = source.slice(start + startMarker.length);
  const next = rest.search(/\n {2}(?:async function |function |handleBook\(|handle\()/);
  return next === -1 ? rest : rest.slice(0, next);
}

test('全书查找：跨批（32 章/批）命中全部在、顺序对、不多不少', async () => {
  const hits = new Set(HIT_INDEXES);
  const { bookPath, meta } = await makeBook((index) => (hits.has(index) ? hitText(index) : missText()));
  const res = await storage.searchBook(bookPath, { query: '阿明' });
  const expectedIds = HIT_INDEXES.map((index) => meta.chapters[index].id);
  assert.deepEqual(res.results.map((item) => item.chapterId), expectedIds, '顺序必须按书目顺序');
  assert.equal(res.chapterCount, HIT_INDEXES.length);
  assert.equal(res.totalMatches, HIT_INDEXES.length * 2, '每章 2 处命中');
  for (const result of res.results) {
    assert.equal(result.count, 2);
    assert.deepEqual(result.matches.map((match) => match.match), ['阿明', '阿明']);
    assert.equal(result.file, meta.chapters[HIT_INDEXES[res.results.indexOf(result)]].file);
  }
  // 边界两侧都有命中（31 / 32 / 33 连续三章）——分批最怕的就是在批边界漏章
  const boundary = res.results.filter((item) =>
    [meta.chapters[31].id, meta.chapters[32].id, meta.chapters[33].id].includes(item.chapterId)
  );
  assert.equal(boundary.length, 3);
});

test('全书替换：跨批全量替换、备份是替换前原文、字数缓存跟着更新', async () => {
  const hits = new Set(HIT_INDEXES);
  const { bookPath, meta } = await makeBook((index) => (hits.has(index) ? hitText(index) : missText()));
  const res = await storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' });
  assert.equal(res.chaptersChanged, HIT_INDEXES.length);
  assert.equal(res.occurrences, HIT_INDEXES.length * 2);
  assert.ok(res.backupDir.includes('替换备份-'));
  const after = await storage.readBookMeta(bookPath);
  for (const index of HIT_INDEXES) {
    const file = meta.chapters[index].file;
    const text = (await storage.loadChapterText(bookPath, file)).text;
    assert.equal(text, `开头。小明走到第 ${index + 1} 章。小明回头。`, `第 ${index + 1} 章要替换干净`);
    assert.equal(after.chapters[index].chars, chaptersLib.countChars(text), '字数缓存按新正文更新');
    assert.equal(await fs.readFile(path.join(res.backupDir, file), 'utf8'), hitText(index), '备份是替换前原文');
  }
  // 没命中的章一个字节都不动（包括批边界两侧的 34 章）
  const untouched = await storage.loadChapterText(bookPath, meta.chapters[34].file);
  assert.equal(untouched.text, missText());
  const backupFiles = await fs.readdir(res.backupDir);
  assert.equal(backupFiles.length, HIT_INDEXES.length, '没改动的章不进备份');
});

test('整本整理：预览 / 执行都跨批，进度 1..total，每章结果与直接 formatText 一致', async () => {
  const sourceTexts = Array.from({ length: CHAPTERS }, (_, index) => `  第${index + 1}段  `);
  const { bookPath, meta } = await makeBook((index) => sourceTexts[index]);
  const expected = sourceTexts.map((text) => formatLib.formatText(text, FORMAT_OPTIONS));
  const expectedStats = {};
  for (const item of expected) {
    for (const key of Object.keys(item.stats)) expectedStats[key] = (expectedStats[key] || 0) + item.stats[key];
  }

  // 预检查只读：统计与直接逐章算出来的合计一致
  const preview = await storage.previewFormatBook(bookPath, FORMAT_OPTIONS);
  assert.equal(preview.chapterCount, CHAPTERS);
  assert.equal(preview.chaptersChanged, CHAPTERS);
  assert.deepEqual(preview.stats, expectedStats);
  assert.equal(preview.changed.length, 12, 'changed 明细仍只给前 12 章');
  assert.equal(preview.changedTruncated, true);
  assert.equal(
    await fs.readFile(path.join(bookPath, meta.chapters[0].file), 'utf8'),
    sourceTexts[0],
    '预检查不能写盘'
  );

  const progress = [];
  const res = await storage.formatBook(bookPath, FORMAT_OPTIONS, (item) => progress.push(item.done));
  assert.deepEqual(progress, Array.from({ length: CHAPTERS }, (_, index) => index + 1));
  assert.equal(res.chaptersChanged, CHAPTERS);
  assert.equal(res.changed.length, 12);
  for (let index = 0; index < CHAPTERS; index += 1) {
    const text = (await storage.loadChapterText(bookPath, meta.chapters[index].file)).text;
    assert.equal(text, expected[index].text, `第 ${index + 1} 章整理结果`);
  }
  const backupFiles = await fs.readdir(res.backupDir);
  assert.equal(backupFiles.length, CHAPTERS, '每章改动前都要备份');
});

test('整本操作：批内缺文件只跳过那一章，前后批照常处理', async () => {
  const { bookPath, meta } = await makeBook((index) => (index === 31 || index === 32 ? '阿明。' : '  正文。'), 40);
  await fs.unlink(path.join(bookPath, meta.chapters[31].file));
  const res = await storage.searchBook(bookPath, { query: '阿明' });
  assert.equal(res.totalMatches, 1, '缺文件的章跳过，后面的章照常命中');
  assert.equal(res.results[0].chapterId, meta.chapters[32].id);
  const preview = await storage.previewFormatBook(bookPath, FORMAT_OPTIONS);
  assert.equal(preview.chapterCount, 40, '章数口径仍是书目里的章数');
  assert.equal(preview.chaptersChanged, 39);
  const fmt = await storage.formatBook(bookPath, FORMAT_OPTIONS);
  assert.equal(fmt.chaptersChanged, 39);
});

test('buildTxtExport：字节与 compose→convert→buffer 一致，并就地清空 texts', () => {
  const meta = {
    title: '分批书',
    chapters: [
      { id: 'c0', file: '0.txt', name: '甲' },
      { id: 'c1', file: '1.txt', name: '乙' }
    ]
  };
  const texts = ['风从海面吹来。', '雨下了一夜。'];
  const expected = exporter.exportBufferFromText(exporter.composeBook(meta, texts.slice()));
  const buffer = exporter.buildTxtExport(meta, texts, null, '', s2tLib.convertText);
  assert.deepEqual(buffer, expected);
  assert.equal(texts.length, 0, 'compose 之后整本正文数组要就地清空');

  // 带简繁转换 + 按范围：逐字节等于原来的手动链
  const texts2 = ['头发乱了。', '皇后来了。'];
  const converted = exporter.buildTxtExport(
    meta,
    texts2,
    { mode: 'range', from: 2, to: 2 },
    's2t',
    s2tLib.convertText
  );
  const manual = exporter.exportBufferFromText(
    s2tLib.convertText(exporter.composeBook(meta, ['头发乱了。', '皇后来了。'], { mode: 'range', from: 2, to: 2 }), 's2t')
  );
  assert.deepEqual(converted, manual);
  assert.equal(texts2.length, 0);
});

test('convertTextsInPlace / releaseTexts：就地转换、空模式零拷贝、用完即清', () => {
  const texts = ['头发', '皇后'];
  const same = exporter.convertTextsInPlace(texts, '', s2tLib.convertText);
  assert.strictEqual(same, texts, '不转换时返回同一个数组');
  assert.deepEqual(texts, ['头发', '皇后'], '不转换时一个元素都不动');
  exporter.convertTextsInPlace(texts, 's2t', s2tLib.convertText);
  assert.deepEqual(texts, [s2tLib.convertText('头发', 's2t'), s2tLib.convertText('皇后', 's2t')]);
  exporter.releaseTexts(texts);
  assert.equal(texts.length, 0);
  exporter.releaseTexts(null); // 非数组不炸
  exporter.releaseTexts(undefined);
});

test('静态闸门：整本查找 / 替换 / 预览 / 整理四处都按批读，不再一次读全书', () => {
  const source = readSource('core/storage.js');
  assert.match(source, /const CHAPTER_BATCH_SIZE = 32;/, '批大小 32 是 C1 的取值');
  assert.match(source, /async function forEachChapterBatch\(bookPath, chapters, onBatch\)/);
  const batchCalls = source.match(/forEachChapterBatch\(bookPath, meta\.chapters/g) || [];
  assert.equal(batchCalls.length, 4, '查找 / 替换 / 预览 / 整理四处都要走分批读');
  assert.doesNotMatch(
    source,
    /mapLimit\(meta\.chapters, CHAPTER_READ_CONCURRENCY/,
    '不许再出现「全书正文一次读进数组」（findMissingChapters 只 stat 文件，不在此列）'
  );
});

test('静态闸门：三个导出入口释放中间引用（TXT 走 buildTxtExport，归档就地转换 + 用完即清）', () => {
  const txt = sliceFrom(mainSource, "  handleBook('book:export', async (bookPath, override, range) => {");
  assert.match(txt, /exporter\.buildTxtExport\(meta, texts, safeRange, conversion, s2tLib\.convertText\)/);
  assert.doesNotMatch(txt, /exporter\.composeBook/, 'TXT 导出不再手动 compose（buildTxtExport 里已经串好）');
  for (const channel of ['book:export-epub', 'book:export-docx']) {
    const body = sliceFrom(mainSource, `  handleBook('${channel}', async (bookPath, override, range) => {`);
    assert.match(
      body,
      /exporter\.convertTextsInPlace\(texts, conversion, s2tLib\.convertText\)/,
      `${channel} 要就地转换（不再 texts.map 造第二份全书数组）`
    );
    assert.match(body, /exporter\.releaseTexts\(texts\)/, `${channel} 打包完要放掉整本正文`);
    assert.doesNotMatch(body, /texts\.map\(\(text\) => s2tLib\.convertText/);
  }
});

// P2-2（1.5.0）：整本校对 / 整本导出也按 32 章分批读。
// 读法对齐 core/storage.js 的 CHAPTER_BATCH_SIZE（32 章）：批内仍限并发 CHAPTER_READ_CONCURRENCY、
// 批间严格串行 —— 只改「什么时候读」，顺序 / 内容 / 统计口径与「一次读完再处理」逐字一致
// （本轮用 git show HEAD:main.js 的旧实现并排跑 70 章临时书对过账：整本 / 稀疏下标 / override /
// 空数组六种入参的 texts / chars / includedUnsaved 全同，TXT 导出字节全同，校对回调序列与总数全同）。
test('静态闸门：整本校对 / 整本导出按 32 章分批读（P2-2）', () => {
  assert.match(mainSource, /const CHAPTER_BATCH_SIZE = 32;/, '批大小 32 要与 core/storage.js 的 CHAPTER_BATCH_SIZE 同值');
  const targets = [
    ['walkChapterTexts', '  async function walkChapterTexts(bookPath, meta, override, onChapter) {'],
    ['collectExportTexts', '  async function collectExportTexts(bookPath, meta, override, indexes) {']
  ];
  for (const [name, anchor] of targets) {
    const body = sliceFrom(mainSource, anchor);
    assert.doesNotMatch(body, /mapLimit\(meta\.chapters,/, `${name} 不许再一次 mapLimit 整本书`);
    assert.match(body, /for \(let start = 0; start < .+; start \+= CHAPTER_BATCH_SIZE\) \{/, `${name} 要按批推进`);
    assert.match(body, /chapters\.slice\(start, start \+ CHAPTER_BATCH_SIZE\)/, `${name} 每批最多 32 章`);
    assert.match(body, /mapLimit\(batch, CHAPTER_READ_CONCURRENCY/, `${name} 批内仍限并发（批间串行）`);
  }
  // 两个整本检查（校对 / 敏感词）都走 walkChapterTexts，分批只在它里面做一次
  const walkCalls = mainSource.match(/walkChapterTexts\(bookPath, meta, safeOverride/g) || [];
  assert.equal(walkCalls.length, 2, '校对 / 敏感词两个整本检查都走同一条分批读路径');
});
