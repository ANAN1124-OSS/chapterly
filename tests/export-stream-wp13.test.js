'use strict';
// WP13（B1 / X-N8 / X-N9）的红-绿锚点：
//   R1  streamZip 与 buildZip 逐字节一致（含分块 / store 兜底 / 空包 / 非法名）
//   R2  streamZip 真流式（边产边写、不物化整包）
//   R3  streamEpub 与 buildEpub 逐字节一致 + 逐章惰性 + 空范围零读零写
//   R4  streamDocx 与 buildDocx 逐字节一致 + 逐章惰性 + 自定义模板
//   R5  X-N8 toInt：null / undefined / '' / 纯空白 = 没传 = 全书端点
//   R6  X-N9 convertMeta 转换 titleTemplate，三格式章标题逐字节一致
//   R7  IPC 端到端：真实 ipc/export.js + 真实 core，转换 / override / 含空格路径 / 覆盖已有目标
//   R8  极值 × IO 失败注入：ENOSPC 中途失败、目标旧文件不动、无临时残留、300 章大书
//   R9  静态闸门：接线与「不物化整本」
//   R10 保护性：buildZip / buildEpub / buildDocx 固定 sha256 不回退
//
// 红阶段事实：streamZip / streamEpub / streamDocx 尚不存在；toInt(null) 仍是 0；
// convertMeta 不转 titleTemplate；ipc/export.js 仍整本读 texts。修复后全绿。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const zipLib = require('../core/zip');
const exporter = require('../core/exporter');
const chaptersLib = require('../core/chapters');
const epubLib = require('../core/epub');
const docxLib = require('../core/docx');
const s2tLib = require('../core/s2t');
const ipcLimits = require('../core/ipc-limits');
const storage = require('../core/storage');
const atomic = require('../core/atomic');
const exportIpc = require('../ipc/export');
const { readZip } = require('../scripts/export-check');
const tmpCleanup = require('./tmp-cleanup');

const ROOT = path.join(__dirname, '..');
const FIXED = new Date('2026-11-01T00:00:00Z');
const FIXED_ISO = FIXED.toISOString().replace(/\.\d{3}Z$/, 'Z');

function readSource(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

// 与 tests/export-read-order.test.js 同口径：从锚点切到下一个顶格两空格的声明。
function sliceFrom(source, startMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `找不到锚点：${startMarker}`);
  const rest = source.slice(start + startMarker.length);
  const next = rest.search(/\n {2}(?:async function |function |handleBook\(|handle\()/);
  return next === -1 ? rest : rest.slice(0, next);
}

function sliceFunction(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `找不到函数：${marker}`);
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `找不到函数结尾：${marker}`);
  return source.slice(start, end + 2);
}

function makeSink() {
  const chunks = [];
  return {
    chunks,
    async write(chunk) {
      if (chunk == null) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (buf.length) chunks.push(Buffer.from(buf));
    }
  };
}

function concatChunks(sink) {
  return Buffer.concat(sink.chunks);
}

// 固定伪随机（不可压）：xorshift32，逐字节写满，测试可复现。
function pseudoRandomBytes(size) {
  const out = Buffer.alloc(size);
  let x = 0x9e3779b9;
  for (let i = 0; i < size; i += 1) {
    x ^= (x << 13) >>> 0;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

function* piecesOf(buffer, size) {
  for (let i = 0; i < buffer.length; i += size) yield buffer.subarray(i, i + size);
}

// 6 章 + 1 卷 + 未分卷章，含空章 / 特殊字符 / 中文标点。
function metaOf() {
  return {
    title: '门后的人',
    id: 'b_wp13',
    author: '说话人',
    chapterNumbering: 'continuous',
    titleTemplate: '第{num}章：{name}',
    volumes: [{ id: 'v1', name: '上卷' }],
    chapters: [
      { id: 'c1', file: '001.txt', name: '开端' },
      { id: 'c2', file: '002.txt', name: '夜航 & <比较>' },
      { id: 'c3', file: '003.txt', name: '转折', volumeId: 'v1' },
      { id: 'c4', file: '004.txt', name: '', volumeId: 'v1' },
      { id: 'c5', file: '005.txt', name: '楔子' },
      { id: 'c6', file: '006.txt', name: '大结局' }
    ]
  };
}

function textsOf() {
  return [
    '第一段正文。\n第二段：带标点，带「引号」。',
    '夜航船上，风从海面吹来。\n\n第二段 & <转义> 测试。',
    '转折之处，灯灭了。',
    '',
    '楔子：很久以后。',
    '大结局：门关上了。'
  ];
}

function mkTmp(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix)).then((dir) => tmpCleanup.track(dir));
}

// ---------- R1 ----------

test('R1 streamZip 与 buildZip 逐字节一致（store / 可压 / 不可压 / 空 / 分块 / 非法名）', async () => {
  const streamZip = zipLib.streamZip;
  assert.equal(typeof streamZip, 'function', 'core/zip.js 必须导出 streamZip');

  const random = pseudoRandomBytes(65536);
  const compressible = Buffer.from('分块正文'.repeat(12000), 'utf8');

  const dataEntries = [
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'OEBPS/a.xhtml', data: '正文 & <转义>'.repeat(4000) },
    { name: 'OEBPS/random.bin', data: random },
    { name: 'OEBPS/empty.txt', data: '' },
    { name: 'OEBPS/compressible.txt', data: compressible }
  ];
  const streamEntries = [
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'OEBPS/a.xhtml', data: '正文 & <转义>'.repeat(4000) },
    { name: 'OEBPS/random.bin', chunks: () => piecesOf(random, 4093) },
    { name: 'OEBPS/empty.txt', data: '' },
    { name: 'OEBPS/compressible.txt', chunks: () => piecesOf(compressible, 777) }
  ];

  const expected = await zipLib.buildZip(dataEntries, { date: FIXED });
  const sink = makeSink();
  const result = await streamZip(streamEntries, { date: FIXED }, sink.write);
  const actual = concatChunks(sink);

  assert.deepEqual(actual, expected, '流式打包的字节必须与 buildZip 完全一致');
  assert.equal(result.bytes, expected.length, '回传 bytes = 实际写出字节数');
  assert.equal(result.count, dataEntries.length);
  // 分块入口真的分块写了（不是悄悄 join 成一块）
  assert.ok(sink.chunks.length > streamEntries.length * 2, '分块载荷应逐块写出');

  // 不可压的 chunks 走 store 兜底：工厂被调用两次（先试压缩、再收原文）
  let randomCalls = 0;
  const fallbackSink = makeSink();
  const fallbackResult = await streamZip(
    [{ name: 'OEBPS/random.bin', chunks: () => { randomCalls += 1; return piecesOf(random, 4093); } }],
    { date: FIXED },
    fallbackSink.write
  );
  const fallbackSingle = await zipLib.buildZip([{ name: 'OEBPS/random.bin', data: random }], { date: FIXED });
  assert.deepEqual(concatChunks(fallbackSink), fallbackSingle, '不可压分块的 store 兜底也要逐字节一致');
  assert.equal(randomCalls, 2, '压缩反而更大时必须重跑工厂按 store 收原文');
  assert.equal(fallbackResult.bytes, fallbackSingle.length);

  // 生成器入口 + 非法名：错误在任何写盘之前抛出
  const badSink = makeSink();
  await assert.rejects(
    () => streamZip((function* () { yield { name: '../逃逸.txt', data: 'x' }; })(), { date: FIXED }, badSink.write),
    /ZIP 条目名不合法/
  );
  assert.equal(badSink.chunks.length, 0, '非法条目名不许写出半个包');
});

// ---------- R2 ----------

test('R2 streamZip 真流式：边产边写，不物化整包', async () => {
  const streamZip = zipLib.streamZip;
  assert.equal(typeof streamZip, 'function');

  const sink = makeSink();
  const produced = [];
  async function* entries() {
    for (let i = 0; i < 4; i += 1) {
      // 每次要下一条之前，前面已产出的条目必须已经完整写进写入器
      if (i > 0) {
        assert.ok(sink.chunks.length >= 3 * i, `第 ${i + 1} 条被拉取时，前 ${i} 条还没写完（不是流式）`);
      }
      produced.push(i);
      yield { name: `OEBPS/e${i}.txt`, data: `内容${i}`.repeat(500) };
    }
  }
  await streamZip(entries(), { date: FIXED }, sink.write);
  assert.equal(produced.length, 4);

  const source = readSource('core/zip.js');
  const body = sliceFunction(source, 'async function streamZip(');
  assert.doesNotMatch(body, /localParts/, 'streamZip 不许再攒 localParts 整包数组');
  assert.doesNotMatch(body, /Buffer\.concat/, 'streamZip 不许整包 Buffer.concat');
  assert.match(body, /await write\(/, 'streamZip 必须逐块写给调用方');
  assert.match(body, /centralParts/, '中央目录（小）仍要累积到最后写出');
});

// ---------- R3 ----------

test('R3 streamEpub 与 buildEpub 逐字节一致 + 逐章惰性 + 空范围零读零写', async () => {
  const streamEpub = epubLib.streamEpub;
  assert.equal(typeof streamEpub, 'function', 'core/epub.js 必须导出 streamEpub');
  const meta = metaOf();
  const texts = textsOf();

  const cases = [
    ['全书', null],
    ['按卷', { mode: 'volume', volumeId: 'v1' }],
    ['按章范围', { mode: 'range', from: 2, to: 3 }],
    ['range 缺省（X-N8）', { mode: 'range' }]
  ];
  for (const [label, range] of cases) {
    const expected = await epubLib.buildEpub({ meta, texts: [...texts], range, modified: FIXED, zipDate: FIXED });
    const sink = makeSink();
    const result = await streamEpub({ meta, readText: async (index) => texts[index], range, modified: FIXED, zipDate: FIXED }, sink.write);
    assert.deepEqual(concatChunks(sink), expected.buffer, `${label}：流式 EPUB 必须与整本构建逐字节一致`);
    assert.equal(result.bytes, expected.buffer.length, `${label}：bytes 一致`);
    assert.equal(result.chapterCount, expected.chapterCount);
    assert.equal(result.volumeCount, expected.volumeCount);
    assert.equal(result.modified, FIXED_ISO);
  }

  // 逐章惰性：每次读章时，写入器里的块数必须比上一次读时更多（读-写交错，不是先全读再写）
  const sink = makeSink();
  const reads = [];
  await streamEpub(
    {
      meta,
      readText: async (index) => {
        reads.push({ index, chunksAtRead: sink.chunks.length });
        return texts[index];
      },
      modified: FIXED,
      zipDate: FIXED
    },
    sink.write
  );
  assert.deepEqual(reads.map((r) => r.index), [0, 1, 2, 3, 4, 5], '每章读一次、按目录顺序');
  const marks = reads.map((r) => r.chunksAtRead);
  assert.ok(marks.every((mark, i) => i === 0 || mark > marks[i - 1]), `读章与写盘必须交错：${marks.join(',')}`);

  // 空范围：在写任何字节 / 读任何章之前抛 EMPTY_EXPORT_RANGE
  const emptySink = makeSink();
  let emptyReads = 0;
  await assert.rejects(
    () =>
      streamEpub(
        {
          meta,
          range: { mode: 'range', from: 4, to: 2 },
          readText: async () => {
            emptyReads += 1;
            return 'x';
          },
          modified: FIXED
        },
        emptySink.write
      ),
    /EMPTY_EXPORT_RANGE/
  );
  assert.equal(emptyReads, 0, '空范围不许读正文');
  assert.equal(emptySink.chunks.length, 0, '空范围不许写半个包');
});

// ---------- R4 ----------

test('R4 streamDocx 与 buildDocx 逐字节一致 + 逐章惰性 + 自定义模板', async () => {
  const streamDocx = docxLib.streamDocx;
  assert.equal(typeof streamDocx, 'function', 'core/docx.js 必须导出 streamDocx');
  const meta = metaOf();
  const texts = textsOf();

  const cases = [
    ['全书', null],
    ['按卷', { mode: 'volume', volumeId: 'v1' }],
    ['按章范围', { mode: 'range', from: 2, to: 3 }],
    ['自定义模板', { meta: { ...meta, titleTemplate: '第{num}节：{name}' }, range: null }]
  ];
  for (const [label, rangeOrMeta] of cases) {
    const caseMeta = rangeOrMeta && rangeOrMeta.meta ? rangeOrMeta.meta : meta;
    const range = rangeOrMeta && rangeOrMeta.meta ? rangeOrMeta.range : rangeOrMeta;
    const expected = await docxLib.buildDocx({ meta: caseMeta, texts: [...texts], range, modified: FIXED, zipDate: FIXED });
    const sink = makeSink();
    const result = await streamDocx(
      { meta: caseMeta, readText: async (index) => texts[index], range, modified: FIXED, zipDate: FIXED },
      sink.write
    );
    assert.deepEqual(concatChunks(sink), expected.buffer, `${label}：流式 DOCX 必须与整本构建逐字节一致`);
    assert.equal(result.bytes, expected.buffer.length, `${label}：bytes 一致`);
    assert.equal(result.chapterCount, expected.chapterCount);
    assert.equal(result.volumeCount, expected.volumeCount);
  }

  const sink = makeSink();
  const reads = [];
  await streamDocx(
    {
      meta,
      readText: async (index) => {
        reads.push({ index, chunksAtRead: sink.chunks.length });
        return texts[index];
      },
      modified: FIXED,
      zipDate: FIXED
    },
    sink.write
  );
  assert.deepEqual(reads.map((r) => r.index), [0, 1, 2, 3, 4, 5]);
  // DOCX 的 word/document.xml 是单一 zip 条目：本地头要压缩后长度，所以分块 XML 先被
  // deflate 收完（读章发生在这一段），再整条写出。这里能钉的是「逐章读、每章只读一次、
  // 读章发生在前面三个静态部位写完之后」，以及「XML 由分块生成器喂入」（R9 静态）；
  // 真正的内存收益由 bench（§9.5）实测，不拿静态截图当内存证据。
  assert.ok(reads[0].chunksAtRead > 0, '读第一章时，zip 头部（mimetype / rels 等）应已开始写出');
  assert.equal(reads.length, 6, '6 章各读一次（不许整本预读）');
});

// ---------- R5 ----------

test('R5 X-N8：toInt 对 null / undefined / \'\' / 纯空白 = 没传 = 全书端点', () => {
  const meta = metaOf();
  const total = meta.chapters.length;
  const shapes = [
    { mode: 'range' },
    { mode: 'range', from: null, to: null },
    { mode: 'range', from: undefined, to: undefined },
    { mode: 'range', from: '', to: '' },
    { mode: 'range', from: '   ', to: '   ' }
  ];
  for (const shape of shapes) {
    const plan = exporter.resolveExportRange(meta, shape);
    assert.equal(plan.mode, 'range');
    assert.deepEqual(plan.indexes, meta.chapters.map((_, i) => i), `${JSON.stringify(shape)}：必须导出全书`);
    assert.equal(plan.from, 1);
    assert.equal(plan.to, total);
    assert.equal(plan.count, total);
    assert.equal(plan.label, `第1-${total}章`, `${JSON.stringify(shape)}：不能再静默只导第 1 章`);
  }
  // 单端缺省：另一端照常
  assert.deepEqual(exporter.resolveExportRange(meta, { mode: 'range', from: '', to: 3 }).indexes, [0, 1, 2]);
  assert.deepEqual(exporter.resolveExportRange(meta, { mode: 'range', from: 2, to: '' }).indexes, [1, 2, 3, 4, 5]);
  // 显式 0 仍是「传了数字」：夹到第 1 章（旧口径不变）
  assert.deepEqual(exporter.resolveExportRange(meta, { mode: 'range', from: 0, to: 0 }).indexes, [0]);
  // sanitizeRange 的缺省形状（{mode:'range', from:null, to:null}）在核心层等价于全书
  assert.deepEqual(
    exporter.resolveExportRange(meta, ipcLimits.sanitizeRange({ mode: 'range' })).indexes,
    meta.chapters.map((_, i) => i)
  );
  // composeBook 同口径：range 缺省 = 全书
  const texts = textsOf();
  assert.equal(
    exporter.composeBook(meta, texts, { mode: 'range' }),
    exporter.composeBook(meta, texts, null),
    'TXT 拼接的 range 缺省必须等于全书'
  );
});

test('R5b X-N8 走真实 book:export-plan：range 缺省回包 = 全书', async () => {
  const dir = await mkTmp('cw-wp13-plan-');
  const root = path.join(dir, '书库');
  await fsp.mkdir(root, { recursive: true });
  const { path: bookPath } = await storage.createBook(root, '范围缺省');
  try {
    for (let i = 1; i < 3; i += 1) {
      const created = await storage.createChapterWithText(bookPath, {
        insertIndex: i,
        name: `第${i + 1}章`,
        text: `第${i + 1}章正文。`
      });
      assert.ok(created.chapter.id);
    }
    const { channels } = makeHost({ dir, targetPath: path.join(dir, 'unused.txt') });
    const plan = await channels.get('book:export-plan')(bookPath, null, { mode: 'range' });
    assert.equal(plan.chapterCount, 3, 'range 缺省必须按整本算章数');
    assert.equal(plan.from, 1);
    assert.equal(plan.to, 3);
    assert.equal(plan.label, '第1-3章');
    assert.equal(plan.mode, 'range');
  } finally {
    // 临时目录由 tmp-cleanup 收；这里提前删也没关系
  }
});

// ---------- R6 ----------

test('R6 X-N9：convertMeta 转换 titleTemplate，占位符保留、既有字段不变', () => {
  const meta = {
    id: 'b_tpl',
    title: '门后的人',
    author: '说话人',
    titleTemplate: '第{num}节：{name}',
    chapters: [{ id: 'c1', file: '001.txt', name: '开端' }],
    volumes: [{ id: 'v1', name: '上卷' }]
  };
  const before = JSON.stringify(meta);
  const converted = s2tLib.convertMeta(meta, 's2t');
  assert.equal(JSON.stringify(meta), before, '不修改调用方对象');
  assert.equal(converted.titleTemplate, '第{num}節：{name}', '模板里的简体字要一起转换');
  assert.ok(converted.titleTemplate.includes('{num}') && converted.titleTemplate.includes('{name}'), '占位符必须原样保留');
  assert.equal(converted.title, '門後的人');
  assert.equal(converted.chapters[0].name, '開端');
  assert.equal(converted.volumes[0].name, '上卷');
  // t2s 反向
  assert.equal(s2tLib.convertMeta(converted, 't2s').titleTemplate, '第{num}节：{name}');
  // 默认模板简繁同形，不受影响
  assert.equal(s2tLib.convertMeta({ titleTemplate: '第{num}章：{name}' }, 's2t').titleTemplate, '第{num}章：{name}');
  // 非字符串 / 缺失：不动、不补
  assert.equal(s2tLib.convertMeta({ titleTemplate: 123 }, 's2t').titleTemplate, 123);
  assert.equal('titleTemplate' in s2tLib.convertMeta({ title: '书' }, 's2t'), false);
});

test('R6b X-N9：自定义模板下 TXT / EPUB / DOCX 章标题逐字节一致且全繁体', async () => {
  const meta = {
    ...metaOf(),
    titleTemplate: '第{num}节：{name}',
    chapters: [
      { id: 'c1', file: '001.txt', name: '开端' },
      { id: 'c2', file: '002.txt', name: '转折' }
    ],
    volumes: []
  };
  const texts = ['第一段。', '第二段。'];
  const converted = s2tLib.convertMeta(meta, 's2t');
  const expectedTitle = '第2節：轉折';

  // TXT：composeBook 的标题行
  const txt = exporter.composeBook(converted, texts, null);
  assert.ok(txt.includes(`${expectedTitle}\r\n\r\n第二段。`), txt.slice(0, 80));
  assert.ok(!txt.includes('节：'), '模板部分也必须全繁体');

  // EPUB：nav 与章页 h1
  const epub = await epubLib.buildEpub({ meta: converted, texts: [...texts], modified: FIXED, zipDate: FIXED });
  const epubZip = readZip(epub.buffer);
  const nav = epubZip.entries.find((entry) => entry.name === 'OEBPS/nav.xhtml').data.toString('utf8');
  const chapter = epubZip.entries.find((entry) => entry.name === 'OEBPS/text/chapter-0002.xhtml').data.toString('utf8');
  assert.ok(nav.includes(`>${expectedTitle}</a>`), nav);
  assert.ok(chapter.includes(`<h1 class="chapter-title">${expectedTitle}</h1>`), chapter);

  // DOCX：document.xml 里的标题段
  const docx = await docxLib.buildDocx({ meta: converted, texts: [...texts], modified: FIXED, zipDate: FIXED });
  const docxZip = readZip(docx.buffer);
  const documentXml = docxZip.entries.find((entry) => entry.name === 'word/document.xml').data.toString('utf8');
  assert.ok(documentXml.includes(`<w:t xml:space="preserve">${expectedTitle}</w:t>`), 'DOCX 标题必须与 TXT / EPUB 逐字一致');

  // 三格式都不许出现简体模板字 / 简体章名
  for (const [label, text] of [['TXT', txt], ['EPUB-ncx', nav], ['DOCX', documentXml]]) {
    assert.ok(!text.includes('第2节'), `${label}：模板没转换（简繁混排）`);
    assert.ok(!text.includes('转折'), `${label}：章名没转换`);
  }
});

// ---------- R7 / R8：真实 ipc/export.js 装配 ----------

function makeHost({ dir, targetPath, canceled = false, failingStreamAt = 0 } = {}) {
  const channels = new Map();
  const calls = { dialogs: [], exportDirs: [], reads: [], events: [], failAt: failingStreamAt, writeCount: 0 };
  const writableTarget = targetPath || path.join(dir, '导出.txt');
  const host = {
    handle: (name, fn) => { channels.set(name, fn); },
    handleBook: (name, fn) => { channels.set(name, fn); },
    storage: {
      readBookMeta: (bookPath) => storage.readBookMeta(bookPath),
      loadChapterText: async (bookPath, file) => {
        calls.reads.push(file);
        calls.events.push(`read:${file}`);
        return storage.loadChapterText(bookPath, file);
      }
    },
    exporter,
    chaptersLib,
    epubLib,
    docxLib,
    s2tLib,
    ipcLimits,
    mapLimit: async (items, _limit, fn) => Promise.all(items.map(fn)),
    CHAPTER_READ_CONCURRENCY: 4,
    CHAPTER_BATCH_SIZE: 16,
    path,
    app: { getPath: () => path.join(os.tmpdir(), 'cw-documents') },
    fsSync: require('node:fs'),
    getConfig: async () => ({ exportConversion: 's2t', lastExportDir: '' }),
    getClipboard: () => ({ writeText: async (text) => { calls.events.push(`copy:${text.length}`); } }),
    showSaveDialog: async (options) => {
      calls.dialogs.push(options);
      calls.events.push('dialog');
      if (canceled) return { canceled: true, filePath: undefined };
      return { canceled: false, filePath: writableTarget };
    },
    rememberExportDir: async (target) => { calls.exportDirs.push(target); },
    atomicWriteFile: atomic.atomicWriteFile,
    atomicWriteFileStream: async (filePath, produce) => {
      if (!calls.failAt) return atomic.atomicWriteFileStream(filePath, produce);
      return atomic.atomicWriteFileStream(filePath, async (write) => {
        await produce(async (chunk) => {
          calls.writeCount += 1;
          if (calls.writeCount >= calls.failAt) {
            const err = new Error('ENOSPC: no space left on device, write');
            err.code = 'ENOSPC';
            throw err;
          }
          return write(chunk);
        });
      });
    }
  };
  exportIpc.register(host);
  return { channels, calls };
}

async function makeBookWithChapters(root, title, names) {
  const { path: bookPath } = await storage.createBook(root, title);
  const meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[0].file, `第一章正文（${names[0]}）。\n第二段。`);
  for (let i = 1; i < names.length; i += 1) {
    await storage.createChapterWithText(bookPath, {
      insertIndex: i,
      name: names[i],
      text: `第${i + 1}章正文（${names[i]}）。`
    });
  }
  return bookPath;
}

test('R7 IPC 端到端：三格式流式导出、转简繁、override、含空格中文路径、覆盖已有目标', async () => {
  const dir = await mkTmp('cw-wp13-ipc-');
  const root = path.join(dir, '书库');
  const outDir = path.join(dir, '导出 目录');
  await fsp.mkdir(root, { recursive: true });
  await fsp.mkdir(outDir, { recursive: true });
  const bookPath = await makeBookWithChapters(root, '模板书', ['开端', '转折', '尾声']);
  try {
    const storeMeta = await storage.readBookMeta(bookPath);
    // 用真实 storage 写回自定义模板，让 handler 读到（readBookMeta 会走迁移，字段保留）
    const metaPath = path.join(bookPath, '书目.json');
    const raw = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
    raw.titleTemplate = '第{num}节：{name}';
    await fsp.writeFile(metaPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    let expectedChars = 0;
    for (const chapter of storeMeta.chapters) {
      expectedChars += chaptersLib.countChars((await storage.loadChapterText(bookPath, chapter.file)).text);
    }

    const targets = {
      epub: path.join(outDir, '共享 书.epub'),
      docx: path.join(outDir, '共享 书.docx'),
      txt: path.join(outDir, '共享 书.txt')
    };
    const expectedTitle = '第2節：轉折';
    const results = {};

    for (const [format, channel] of [
      ['epub', 'book:export-epub'],
      ['docx', 'book:export-docx'],
      ['txt', 'book:export']
    ]) {
      const { channels, calls } = makeHost({ dir, targetPath: targets[format] });
      results[format] = await channels.get(channel)(bookPath, null, null);
      assert.equal(results[format].canceled, false);
      assert.equal(results[format].filePath, targets[format]);
      assert.equal(results[format].chars, expectedChars, `${format}：chars = 原始正文去空白计数（override 前）`);
      assert.ok(results[format].chars > 0, `${format}：chars 要如实回传`);
      assert.equal(results[format].conversion, 's2t');
      const stat = await fsp.stat(targets[format]);
      assert.equal(results[format].bytes === undefined ? stat.size : results[format].bytes, stat.size, `${format}：bytes = 实际文件长度`);
      // 读正文必须发生在对话框之后（事件顺序）
      const dialogAt = calls.events.indexOf('dialog');
      const firstReadAt = calls.events.findIndex((event) => event.startsWith('read:'));
      assert.notEqual(firstReadAt, -1, `${format}：必须逐章读正文`);
      assert.ok(dialogAt >= 0 && dialogAt < firstReadAt, `${format}：正文必须在保存对话框确认之后才读（#7）`);
      assert.equal(calls.reads.length, 3, `${format}：3 章各读一次（不许整本预读两遍）`);
      assert.deepEqual(calls.exportDirs, [outDir], `${format}：记住导出目录`);
    }

    // 返回字段集合与修复前一致
    assert.deepEqual(Object.keys(results.epub).sort(), [
      'bytes', 'canceled', 'chapterCount', 'chars', 'conversion', 'filePath',
      'includedUnsaved', 'rangeLabel', 'volumeCount'
    ].sort());
    assert.deepEqual(Object.keys(results.docx).sort(), Object.keys(results.epub).sort());
    assert.deepEqual(Object.keys(results.txt).sort(), [
      'canceled', 'chars', 'chapterCount', 'conversion', 'filePath', 'includedUnsaved', 'rangeLabel'
    ].sort());

    // 三格式章标题逐字节一致（X-N9）
    const txtText = await fsp.readFile(targets.txt, 'utf8');
    assert.ok(txtText.includes(`${expectedTitle}\r\n\r\n`), 'TXT 标题');
    const epubZip = readZip(await fsp.readFile(targets.epub));
    const epubNav = epubZip.entries.find((entry) => entry.name === 'OEBPS/nav.xhtml').data.toString('utf8');
    const epubChapter = epubZip.entries.find((entry) => entry.name === 'OEBPS/text/chapter-0002.xhtml').data.toString('utf8');
    assert.ok(epubNav.includes(`>${expectedTitle}</a>`), 'EPUB nav 标题');
    assert.ok(epubChapter.includes(`<h1 class="chapter-title">${expectedTitle}</h1>`), 'EPUB 章页标题');
    const docxZip = readZip(await fsp.readFile(targets.docx));
    const docxDocument = docxZip.entries.find((entry) => entry.name === 'word/document.xml').data.toString('utf8');
    assert.ok(docxDocument.includes(`<w:t xml:space="preserve">${expectedTitle}</w:t>`), 'DOCX 标题');

    // override：当前章未保存内容进导出、不写盘
    const chapter2 = storeMeta.chapters[1];
    const diskBefore = (await storage.loadChapterText(bookPath, chapter2.file)).text;
    const overrideText = '这段还没保存，但导出里必须出现。';
    const { channels: overrideHost } = makeHost({ dir, targetPath: path.join(outDir, 'override.epub') });
    const overrideResult = await overrideHost
      .get('book:export-epub')(bookPath, { chapterId: chapter2.id, text: overrideText }, null);
    assert.equal(overrideResult.includedUnsaved, true);
    const overrideZip = readZip(await fsp.readFile(path.join(outDir, 'override.epub')));
    const overrideChapter = overrideZip.entries.find((entry) => entry.name === 'OEBPS/text/chapter-0002.xhtml').data.toString('utf8');
    const convertedOverride = s2tLib.convertText(overrideText, 's2t');
    assert.notEqual(convertedOverride, overrideText, '测试语料确实会被简繁转换');
    assert.ok(overrideChapter.includes(convertedOverride), '未保存内容要进导出（按 s2t 转换后）');
    assert.equal((await storage.loadChapterText(bookPath, chapter2.file)).text, diskBefore, '导出不许写盘');
    assert.equal(
      overrideResult.chars,
      expectedChars - chaptersLib.countChars(diskBefore) + chaptersLib.countChars(overrideText),
      'chars 应按 override 正文重算'
    );

    // 覆盖已有目标：同一路径再导出一次（原子替换）
    const target = path.join(outDir, '共享 书.epub');
    await fsp.writeFile(target, '旧内容', 'utf8');
    const { channels: againHost } = makeHost({ dir, targetPath: target });
    const again = await againHost.get('book:export-epub')(bookPath, null, null);
    assert.equal(again.canceled, false);
    const againBytes = await fsp.readFile(target);
    assert.equal(againBytes.slice(0, 2).toString('latin1'), 'PK', '覆盖后是新 zip');
    assert.equal(againBytes.length, again.bytes);
  } finally {
    // tmp-cleanup 收尾
  }
});

test('R8 极值 × IO 失败注入：ENOSPC 中途失败 → 目标旧文件不动、无临时残留；取消零读零写', async () => {
  const dir = await mkTmp('cw-wp13-fail-');
  const root = path.join(dir, '书库');
  await fsp.mkdir(root, { recursive: true });
  const bookPath = await makeBookWithChapters(root, '失败书', ['甲', '乙', '丙']);
  try {
    const target = path.join(dir, '已有.epub');
    await fsp.writeFile(target, '旧文件必须逐字节不动', 'utf8');
    const { channels, calls } = makeHost({ dir, targetPath: target, failingStreamAt: 4 });
    await assert.rejects(() => channels.get('book:export-epub')(bookPath, null, null), /ENOSPC/);
    assert.ok(calls.writeCount >= 4, '失败注入确实在写入过程中触发');
    assert.equal((await fsp.readFile(target, 'utf8')), '旧文件必须逐字节不动', '导出失败不许碰目标旧文件');
    const leftovers = (await fsp.readdir(dir)).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, [], '失败后不许留临时文件');

    // 取消：一次正文都不读、不写
    const { channels: cancelChannels, calls: cancelCalls } = makeHost({ dir, targetPath: path.join(dir, '取消.epub'), canceled: true });
    const canceled = await cancelChannels.get('book:export-epub')(bookPath, null, null);
    assert.deepEqual(canceled, { canceled: true });
    assert.equal(cancelCalls.reads.length, 0, '取消对话框后不许读正文');
    assert.deepEqual(cancelCalls.exportDirs, []);

    // 极值：300 章 × 2000 字大书，流式 EPUB 与整本构建逐字节一致
    const bigChapters = Array.from({ length: 300 }, (_, i) => ({ id: `bc${i}`, file: `${String(i + 1).padStart(3, '0')}.txt`, name: `第${i + 1}章` }));
    const bigMeta = { title: '大书', id: 'b_big', titleTemplate: '第{num}章：{name}', chapters: bigChapters, volumes: [] };
    const makeText = (index) => `第${index + 1}章正文。` + '风从海面吹来，灯还亮着。'.repeat(100);
    const texts = bigChapters.map((_, index) => makeText(index));
    const expected = await epubLib.buildEpub({ meta: bigMeta, texts, modified: FIXED, zipDate: FIXED });
    const sink = makeSink();
    const result = await epubLib.streamEpub({ meta: bigMeta, readText: async (index) => makeText(index), modified: FIXED, zipDate: FIXED }, sink.write);
    assert.equal(result.chapterCount, 300);
    assert.deepEqual(concatChunks(sink), expected.buffer, '300 章大书的流式产物必须与整本构建逐字节一致');
  } finally {
    // tmp-cleanup 收尾
  }
});

// ---------- R9 ----------

test('R9 静态闸门：ipc/export 流式接线 + 三个 core 模块不物化整本 + toInt / titleTemplate 源码', () => {
  const ipcSource = readSource('ipc/export.js');
  const kernel = sliceFrom(ipcSource, '  async function exportStructured(bookPath, override, range, options) {');
  assert.match(kernel, /atomicWriteFileStream\(filePath/, 'EPUB / DOCX 要流式原子写盘');
  assert.match(kernel, /options\.stream\(/, '共享内核要调格式的流式构建');
  assert.match(kernel, /readText: async \(index, chapter\)/, '共享内核要提供逐章读取回调');
  assert.match(kernel, /loadChapterText\(bookPath, chapter\.file\)/, '逐章读取仍走 storage.loadChapterText');
  assert.doesNotMatch(kernel, /readExportTexts|collectExportTexts/, '共享内核不许再整本读 texts');
  assert.doesNotMatch(kernel, /convertTextsInPlace|releaseTexts/, '流式路径不需要整本转换 / 整本释放');
  assert.match(kernel, /chaptersLib\.countChars\((?:raw|text)\)/, 'chars 口径：原始正文去空白计数');

  for (const [channel, call] of [
    ['book:export-epub', 'epubLib.streamEpub('],
    ['book:export-docx', 'docxLib.streamDocx(']
  ]) {
    const body = sliceFrom(ipcSource, `  handleBook('${channel}', async (bookPath, override, range) =>\n    exportStructured(`);
    assert.ok(body.includes(call), `${channel}：要传格式的流式构建入口`);
    assert.ok(body.includes('defaultName:'), `${channel}：默认文件名仍传进共享内核`);
    assert.equal(body.includes('showSaveDialog('), false, `${channel}：不许自己弹对话框`);
  }
  // book:copy 仍是整本读取（不走流式）
  const copy = sliceFrom(ipcSource, "  handleBook('book:copy', async (bookPath, override, indexes) => {");
  assert.match(copy, /collectExportTexts\(/, 'book:copy 保持整本读取');
  // 旧 readExportTexts 已收掉（它只为整本导出存在）
  assert.equal(ipcSource.includes('async function readExportTexts('), false, '整本读正文的 readExportTexts 应删除');

  const zipSource = readSource('core/zip.js');
  assert.match(zipSource, /async function streamZip\(entries, options, write\)/, 'core/zip.js 要有 streamZip');
  assert.match(zipSource, /module\.exports = \{[^}]*streamZip/s, 'streamZip 要导出');
  const epubSource = readSource('core/epub.js');
  assert.match(epubSource, /async function streamEpub\(input, write\)/, 'core/epub.js 要有 streamEpub');
  assert.match(epubSource, /module\.exports = \{[^}]*streamEpub/s, 'streamEpub 要导出');
  const docxSource = readSource('core/docx.js');
  assert.match(docxSource, /async function streamDocx\(input, write\)/, 'core/docx.js 要有 streamDocx');
  assert.match(docxSource, /chunks: \(\) =>/, 'document.xml 要用分块入口喂 zip');
  assert.match(docxSource, /documentXmlChunks\(/, '分块生成器要存在并被 streamDocx 使用');
  assert.match(docxSource, /module\.exports = \{[^}]*streamDocx/s, 'streamDocx 要导出');

  const exporterSource = readSource('core/exporter.js');
  const toInt = sliceFunction(exporterSource, 'function toInt(value) {');
  assert.match(toInt, /value == null/, 'toInt 要先把 null / undefined 当没传');
  assert.match(toInt, /trim\(\) === ''/, "toInt 要把空串 / 纯空白当没传");
  const s2tSource = readSource('core/s2t.js');
  assert.match(s2tSource, /copy\.titleTemplate = convertText\(meta\.titleTemplate, m\)/, 'convertMeta 要转换 titleTemplate');
});

// ---------- R10 ----------

test('R10 保护性：buildZip / buildEpub / buildDocx 的固定 sha256 不回退', async () => {
  const meta = metaOf();
  const texts = textsOf();
  // X-N12（WP18）：buildEpub 删掉 OPF 里语义不符的 EPUB2 `<meta name="cover">`（16 字节），
  // 产物长度 / 哈希相应更新；其余字节必须保持原样（不允许再漂移）。
  const epub = await epubLib.buildEpub({ meta, texts: [...texts], modified: FIXED, zipDate: FIXED });
  assert.equal(epub.buffer.length, 6404, 'buildEpub 产物长度漂移');
  assert.equal(
    crypto.createHash('sha256').update(epub.buffer).digest('hex'),
    '418f24160cd535948c99be207a3ea0f62a066983682431b3960ad77ba07e26be',
    'buildEpub 逐字节产物漂移（整本构建必须保持原样，X-N12 删 meta 后重新定基线）'
  );
  const docx = await docxLib.buildDocx({ meta, texts: [...texts], modified: FIXED, zipDate: FIXED });
  assert.equal(docx.buffer.length, 3444, 'buildDocx 产物长度漂移');
  assert.equal(
    crypto.createHash('sha256').update(docx.buffer).digest('hex'),
    '848ccc8ebaea84f60b36b2395e9eb42e2e19969e8d92f854ff0c8cfb44a3aa76',
    'buildDocx 逐字节产物漂移（整本构建必须保持原样）'
  );
  const zip = await zipLib.buildZip(
    [
      { name: 'mimetype', data: 'application/epub+zip', store: true },
      { name: 'OEBPS/a.xhtml', data: '第一章：夜航船\n\n风从海面吹来。'.repeat(40) },
      { name: 'OEBPS/empty.txt', data: '' },
      { name: 'OEBPS/small.txt', data: 'x' }
    ],
    { date: FIXED }
  );
  assert.equal(zip.length, 516);
  assert.equal(
    crypto.createHash('sha256').update(zip).digest('hex'),
    '5ae565f820d32dd244f20c512aff57caa0102b980ca4c2ca2274f0c9f0b96e60',
    'buildZip 逐字节产物漂移（crc32 重构不许改变字节）'
  );
});