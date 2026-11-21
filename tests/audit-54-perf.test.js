'use strict';
// 审计修复 #54（P7–P11）：性能小项的回归锚点。
//   P7 校对额度预检（满了不再拼 snippet / 建对象）+ repeat-word 不再建按码点的 chars/starts 数组；
//   P8 补字数缓存锁内「文件身份没变就不重读」+ 单组历史还原只扫目标组；
//   P9 stats:get 同一份已清洗统计不再洗四遍；
//   P10 导入 raw 模式的编码判定与解码同源（128 MB 文件不再双倍解码）；
//   P11 字体 base64 缓存给字节预算。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const tmpCleanup = require('./tmp-cleanup');

const ROOT = path.join(__dirname, '..');
const read = (rel) => require('node:fs').readFileSync(path.join(ROOT, rel), 'utf8');
const sliceFunction = (source, name) => {
  const start = source.indexOf(name);
  assert.ok(start > 0, `找不到 ${name}`);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, `${name} 的函数体没有按预期结束`);
  return source.slice(start, end);
};

// TB-02：临时目录统一经 tests/tmp-cleanup.js 的 mkTmp（mkdtemp + 登记回收）。
const mkTmp = (prefix = 'cw-audit54-') => tmpCleanup.mkTmp(prefix);

// ---------------------------------------------------------------- P7

test('P7/#54：明细额度已满的规则只计数，不再为被丢弃的命中拼 snippet / 建 issue 对象', () => {
  const proofread = require('../core/proofread');
  const findLib = require('../core/find');
  const original = findLib.makeSnippet;
  let calls = 0;
  findLib.makeSnippet = (...args) => {
    calls += 1;
    return original(...args);
  };
  try {
    // 200 段「。。。a」= 200 条 punct-run；maxIssues 20 → 后 180 条会被 collector 丢掉
    const text = '。。。a'.repeat(200);
    const rules = {};
    for (const rule of proofread.RULE_ORDER) rules[rule] = false;
    rules['punct-run'] = true;
    const res = proofread.proofreadText(text, { maxIssues: 20, rules });
    assert.equal(res.byRule['punct-run'], 200, '总数照实统计（一条都不许漏计）');
    assert.equal(res.issues.length, 20);
    assert.equal(res.truncated, true);
    assert.ok(calls <= 20, `只为保留下来的明细拼片段：实际 ${calls} 次`);
    assert.ok(calls > 0, '保留的明细仍要有片段');
  } finally {
    findLib.makeSnippet = original;
  }
});

test('P7/#54：repeatWordIssues 不再建按码点的 chars/starts 数组（单遍扫描 + 结果折算）', () => {
  const body = sliceFunction(read('core/proofread.js'), 'function repeatWordIssues');
  assert.equal(/const chars = \[\]/.test(body), false, '不再建 chars 数组');
  assert.equal(/const starts = \[\]/.test(body), false, '不再建 starts 数组');
  assert.ok(body.includes('positions.set(word, [prevCp])'), '二字词位置直接记码点序号');
  // 行为不变：连续重复仍按「不重叠贪心」只报一条（既有 E14 用例的简化锚点）
  const proofread = require('../core/proofread');
  const rules = {};
  for (const rule of proofread.RULE_ORDER) rules[rule] = false;
  rules['repeat-word'] = true;
  const res = proofread.proofreadText('哈哈哈哈哈。', { rules, repeatCount: 2, repeatWindow: 10 });
  assert.equal(res.byRule['repeat-word'], 1, '「哈哈哈哈哈」按不重叠贪心只报一条');
});

// ---------------------------------------------------------------- P8

test('P8/#54：readBookMeta 的文件身份不可枚举；openBook 补字数缓存照常落盘且不顶 updatedAt', async () => {
  const storage = require('../core/storage');
  const dir = await mkTmp();
  const booksRoot = path.join(dir, 'books');
  await fs.mkdir(booksRoot);
  const created = await storage.createBook(booksRoot, '性能测试书');
  const meta = await storage.readBookMeta(created.path);
  assert.equal(Object.getOwnPropertySymbols(meta).length, 1, '书目对象上要挂一份文件身份');
  assert.equal(JSON.stringify(meta).includes('bookMetaStamp'), false, '文件身份不许进 JSON / 写盘');
  assert.equal('bookMetaStamp' in { ...meta }, false, '展开书目也不带文件身份');
  const opened = await storage.openBook(created.path);
  assert.equal(opened.meta.chapters.length, 1);
  const disk = await storage.readBookMeta(created.path);
  assert.equal(disk.chapters[0].chars, 0, '缺字数缓存要补进书目（空章 = 0 字）');
  assert.equal(disk.updatedAt, meta.updatedAt, '只补缓存不改 updatedAt（审计 E-06 口径不变）');
});

test('P8/#54：bookStats 锁内先比文件身份，findHistoryGroup 只扫目标组（静态 + 行为）', () => {
  const storageSrc = read('core/storage.js');
  const statsBody = sliceFunction(storageSrc, 'async function bookStats');
  assert.ok(statsBody.includes('readFreshBookMetaForCache(bookPath, meta)'), '缺字数缓存写盘前要走轻量重读');
  assert.equal(statsBody.includes('await readBookMeta(bookPath)'), false, '不再无条件整份重读');
  const groupBody = sliceFunction(storageSrc, 'async function findHistoryGroup');
  assert.ok(groupBody.includes('only: groupId'), '单组还原要把 only 传进 listHistory');
  assert.ok(groupBody.includes('readFreshBookMetaForCache') === false);
});

test('P8/#54：listHistory 的 only 只读目标组（其它组的文件连 stat 都不碰）；坏组名照旧拒绝', async () => {
  const history = require('../core/history');
  const dir = await mkTmp();
  const bookPath = path.join(dir, '书');
  const trash = path.join(bookPath, '_trash');
  await fs.mkdir(path.join(trash, '替换备份-2026-11-15-120000'), { recursive: true });
  await fs.mkdir(path.join(trash, '整理备份-2026-11-15-130000'), { recursive: true });
  await fs.writeFile(path.join(trash, '替换备份-2026-11-15-120000', '001-a.txt'), '甲', 'utf8');
  await fs.writeFile(path.join(trash, '整理备份-2026-11-15-130000', '001-a.txt'), '乙', 'utf8');
  // 全部都要保留：只要没被 stat 就不会出现在 statted 里
  const statted = [];
  const stat = async (target) => {
    statted.push(path.relative(bookPath, target));
    return fs.stat(target);
  };
  const data = await history.listHistory(bookPath, {
    chapterFiles: ['001-a.txt'],
    only: 'dir:替换备份-2026-11-15-120000',
    stat
  });
  assert.equal(data.groupCount, 1, '只出一个组');
  assert.equal(data.groups[0].id, 'dir:替换备份-2026-11-15-120000');
  assert.equal(data.groups[0].fileCount, 1);
  assert.ok(statted.length > 0);
  assert.equal(
    statted.some((name) => name.includes('整理备份')),
    false,
    `其它备份组的文件不许被 stat：${JSON.stringify(statted)}`
  );
  await assert.rejects(
    () => history.listHistory(bookPath, { chapterFiles: [], only: '../跑出去' }),
    (err) => err.code === 'BAD_GROUP'
  );
});

// ---------------------------------------------------------------- P9

test('P9/#54：stats 的 sanitized:true 跳过重复清洗（坏键不再被丢掉），默认行为不变', () => {
  const statsLib = require('../core/stats');
  const raw = {
    version: 1,
    days: {
      'bad-key': { books: { b1: 50 } },
      '2026-11-15': { books: { b1: 10 } }
    }
  };
  assert.equal(statsLib.aggregate(raw).totals.totalChars, 10, '默认仍按清洗后的数据算');
  assert.equal(
    statsLib.aggregate(raw, null, { sanitized: true }).totals.totalChars,
    60,
    'sanitized:true 表示「调用方保证已清洗」，不再二次清洗'
  );
  // 正常数据上两种口径结果一致（summary / streak / monthView 同一条口径）
  const now = new Date(2026, 10, 15, 12);
  const clean = { version: 1, days: { '2026-11-15': { books: { b1: 1200 } } } };
  assert.deepEqual(
    statsLib.summary(clean, { now }),
    statsLib.summary(clean, { now, sanitized: true })
  );
  assert.deepEqual(statsLib.streak(clean, { now }), statsLib.streak(clean, { now, sanitized: true }));
  assert.deepEqual(
    statsLib.monthView(clean, { year: 2026, month: 11, now }),
    statsLib.monthView(clean, { year: 2026, month: 11, now, sanitized: true })
  );
  // main.js 的 stats:get / stats:calendar 必须真的用上已清洗标记
  const main = read('main.js');
  assert.match(main, /statsLib\.summary\(stats, \{ goal: cfg\.dailyGoal, now, sanitized: true \}\)/);
  assert.match(main, /statsLib\.streak\(stats, \{ now, sanitized: true \}\)/);
  assert.match(main, /statsLib\.monthView\(stats, \{ now, goal: cfg\.dailyGoal, sanitized: true \}\)/);
  assert.match(main, /statsLib\.aggregate\(stats, filter, \{ sanitized: true \}\)/);
});

// ---------------------------------------------------------------- P10

test('P10/#54：decodeBufferWithEncoding 一次给出文本与编码；decodeBuffer 行为不变', () => {
  const txt = require('../core/txt');
  assert.deepEqual(txt.decodeBufferWithEncoding(Buffer.from('第一章 雪夜', 'utf8')), {
    text: '第一章 雪夜',
    encoding: 'utf-8'
  });
  assert.deepEqual(
    txt.decodeBufferWithEncoding(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文', 'utf16le')])),
    { text: '中文', encoding: 'utf-16le' }
  );
  const utf32 = Buffer.concat([
    Buffer.from([0xff, 0xfe, 0x00, 0x00]),
    ...Array.from('中文', (ch) => {
      const buf = Buffer.alloc(4);
      buf.writeUInt32LE(ch.codePointAt(0), 0);
      return buf;
    })
  ]);
  assert.deepEqual(txt.decodeBufferWithEncoding(utf32), { text: '中文', encoding: 'utf-32le' });
  assert.deepEqual(txt.decodeBufferWithEncoding(Buffer.from([0xc9, 0xab, 0xc7, 0xe9])), {
    text: '色情',
    encoding: 'gb18030'
    // 五-H6（TC-1）反向校验：真 GBK 的常用字占比 ≈ 0.99 → 不再标 encodingSuspect
    // （半步版一律标可疑会在每本 GBK 书上误报；中间区才提示，见 txt-encoding-tolerance.test.js）
  });
  assert.deepEqual(txt.decodeBufferWithEncoding(Buffer.alloc(0)), { text: '', encoding: 'empty' });
  // 旧入口结果不变（含坏字节的 GB18030 兜底）
  assert.equal(txt.decodeBuffer(Buffer.from('第一章 雪夜', 'utf8')), '第一章 雪夜');
  assert.equal(txt.decodeBuffer(Buffer.from([0xff])), '\uFFFD');
  // 导入 raw 模式不再有第二次整本解码：isUtf8 已删，编码判定与解码同源
  const importer = read('core/importer.js');
  assert.equal(/function isUtf8\(/.test(importer), false, 'isUtf8 二次解码已删');
  assert.ok(importer.includes('decodeBufferWithEncoding(buffer)'), '导入只解码一趟');
  assert.match(importer, /decodedInfo\.encoding === 'utf-8'/, 'raw 模式用同一趟的编码判定');
});

// ---------------------------------------------------------------- P11

test('P11/#54：字体 base64 缓存有字节预算；单份超预算不入缓存，同 key 替换不重复记账', () => {
  const { createFontReadCache, DEFAULT_MAX_ENTRIES, DEFAULT_MAX_BYTES } = require('../core/font-cache');
  assert.equal(DEFAULT_MAX_ENTRIES, 2);
  assert.equal(DEFAULT_MAX_BYTES, 40 * 1024 * 1024, '默认预算 40 MB（两份 24MB 字体的 base64 约 64MB）');

  const cache = createFontReadCache({ maxEntries: 3, maxBytes: 10 });
  const keyA = cache.keyOf('/字体/a.ttf', { mtimeMs: 1, size: 1 });
  const keyB = cache.keyOf('/字体/b.ttf', { mtimeMs: 1, size: 1 });
  assert.equal(cache.put(keyA, { name: 'a.ttf', size: 1, base64: 'AAAAAA' }), true);
  assert.equal(cache.bytes(), 6);
  assert.equal(cache.put(keyB, { name: 'b.ttf', size: 1, base64: 'BBBBBB' }), true);
  assert.equal(cache.size(), 1, '两份 6 字符合计 12 > 10：挤掉最久未用的');
  assert.equal(cache.get(keyA), null);
  assert.notEqual(cache.get(keyB), null);
  assert.equal(cache.bytes(), 6);
  // 同一个 key 替换：只按新长度记账
  assert.equal(cache.put(keyB, { name: 'b.ttf', size: 2, base64: 'BBBB' }), true);
  assert.equal(cache.bytes(), 4);

  // 单份就超预算：不入缓存（返回 false，缓存保持空）
  const tight = createFontReadCache({ maxEntries: 3, maxBytes: 5 });
  assert.equal(tight.put(tight.keyOf('/大字体.ttf', { mtimeMs: 1, size: 1 }), { base64: 'AAAAAA' }), false);
  assert.equal(tight.size(), 0);
  assert.equal(tight.bytes(), 0);

  // maxEntries 仍是硬上限（预算放得下也不许多收）
  const two = createFontReadCache({ maxEntries: 2, maxBytes: 1024 });
  for (const name of ['a', 'b', 'c']) {
    two.put(two.keyOf(`/${name}.ttf`, { mtimeMs: 1, size: 1 }), { name, base64: 'AAAA' });
  }
  assert.equal(two.size(), 2);
  assert.equal(two.bytes(), 8);
  two.clear();
  assert.equal(two.bytes(), 0);

  // main.js 仍按 2 份创建（默认预算生效）
  assert.match(read('main.js'), /createFontReadCache\(\{ maxEntries: 2 \}\)/);
});