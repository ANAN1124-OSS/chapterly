// 搜索索引测试（T9 / 第 10 轮按性质拆分）：纯函数与索引解析（不落盘）。
// 本文件覆盖：查询归一化 / 双字哈希 → Bloom 位图（绝不漏报、编码解码往返、空书全零）→
// 上下文片段（前后各一段、换行折空格、截断标记）→ 索引文件解析（只认当前版本、坏条目清洗、
// 超长章节文件名整条丢弃）→ 双字集合上限放弃位图（bloomOmitted）→ #33 总量预算淘汰（纯函数）。
//
// 来源：原 tests/search-index.test.js（1,678 行 / 51 例）按性质拆成夹具 + 四个文件，**只搬家不改断言**——
// 用例标题与断言逐字保留，共用夹具收进 tests/search-index-fixtures.js（T9 纪律，见 tests/README.md）。
const test = require('node:test');
const assert = require('node:assert/strict');
const search = require('../core/search-index');

test('正文索引：查询归一化（去首尾空白 + 小写）与双字哈希稳定', () => {
  assert.equal(search.normalizeQuery('  林婉儿  '), '林婉儿');
  assert.equal(search.normalizeQuery('Hello World'), 'hello world');
  assert.equal(search.normalizeQuery(null), '');
  const one = search.queryBigrams('林婉儿');
  assert.equal(one.length, 2); // 林婉、婉儿
  assert.deepEqual(search.queryBigrams('林婉儿'), one);
  assert.equal(search.queryBigrams('林').length, 0);
  assert.equal(search.bigramHash(0x6797, 0x5a49), search.bigramHash(0x6797, 0x5a49));
  assert.notEqual(search.bigramHash(0x6797, 0x5a49), search.bigramHash(0x5a49, 0x6797));
});

test('正文索引：Bloom 位图对文中出现过的双字绝不漏报，编码解码往返一致', () => {
  const texts = ['林婉儿撑着一把青柠色的雨伞，站在旧车站的月台上。', '雨还在下，钟停在 3:17。'];
  const built = search.makeBookBloom(texts);
  assert.ok(built.bits >= search.MIN_BLOOM_BITS);
  assert.ok(built.items > 0);
  for (const query of ['青柠色', '旧车站', '林婉儿', '3:17', '雨还在下']) {
    for (const hash of search.queryBigrams(query)) {
      assert.equal(search.bloomHas(built.bloom, built.bits, hash), true, `不能漏报：${query}`);
    }
  }
  const encoded = search.encodeBloom(built.bloom);
  const builtCrc = search.crc32(built.bloom);
  const decoded = search.decodeBloom(encoded, built.bits, builtCrc);
  assert.ok(Buffer.isBuffer(decoded));
  assert.deepEqual(decoded, built.bloom);
  assert.equal(search.decodeBloom('不是 base64', built.bits + 8, builtCrc), null);
  assert.equal(search.decodeBloom('', built.bits, builtCrc), null);
  // 位数与字节数对不上（索引被截断 / 损坏）时不给位图：搜索按「本书永远是候选」处理
  assert.equal(search.decodeBloom(encoded, built.bits * 2, builtCrc), null);
  // E5（审计修复 #8）：CRC 对不上 / 缺 CRC / bits 不是字节数 × 8 一律不给位图。
  assert.equal(search.decodeBloom(encoded, built.bits, (builtCrc + 1) >>> 0), null, 'CRC 不符要拒绝');
  assert.equal(search.decodeBloom(encoded, built.bits, undefined), null, '没有 CRC 的条目当候选');
  const flipped = Buffer.from(built.bloom);
  flipped[0] ^= 0xff; // 同长度位翻转：旧实现查不出
  assert.equal(search.decodeBloom(flipped.toString('base64'), built.bits, builtCrc), null);
  const oneByte = Buffer.from([0xff]).toString('base64');
  assert.equal(search.decodeBloom(oneByte, 0, search.crc32(Buffer.from([0xff]))), null, 'bloomBits:0 不再混过');
  assert.equal(search.decodeBloom(oneByte, 8, search.crc32(Buffer.from([0xff]))), null, '低于最小位数也拒绝');
});

test('正文索引：空书不误报（全零位图）', () => {
  const built = search.makeBookBloom([]);
  assert.equal(built.items, 0);
  for (const hash of search.queryBigrams('青柠')) {
    assert.equal(search.bloomHas(built.bloom, built.bits, hash), false);
  }
});

test('正文索引：上下文片段保留前后各一段、换行折成空格、标明是否截断', () => {
  const text = '第一行。\n他撑着一把青柠色的雨伞，站在旧车站的月台上。\n风很轻。';
  const at = text.indexOf('青柠色');
  const snip = search.snippetAround(text, at, 3, 6);
  assert.equal(snip.match, '青柠色');
  assert.equal(snip.before.includes('\n'), false);
  assert.equal(snip.after.includes('\n'), false);
  assert.equal(snip.cutBefore, true);
  assert.equal(snip.cutAfter, true);

  const head = search.snippetAround('青柠色雨伞', 0, 3, 16);
  assert.equal(head.before, '');
  assert.equal(head.match, '青柠色');
  assert.equal(head.after, '雨伞');
  assert.equal(head.cutBefore, false);
  assert.equal(head.cutAfter, false);

  const tail = search.snippetAround('一把青柠色', 2, 3, 16);
  assert.equal(tail.after, '');
  assert.equal(tail.cutAfter, false);
});

test('正文索引：索引文件解析只认当前版本，坏 JSON / 坏条目一律清洗掉', () => {
  assert.equal(search.parseIndex('不是 json'), null);
  assert.equal(search.parseIndex('{}'), null);
  const wrong = search.serializeIndex({ version: 999, root: 'x', books: [] });
  assert.equal(search.parseIndex(wrong), null);

  const dirty = {
    version: search.INDEX_VERSION,
    root: 'C:\\Books',
    builtAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    books: [
      null,
      { path: '', chapters: [] },
      {
        path: 'C:\\Books\\A',
        folder: 'A',
        title: '测试书',
        metaMtimeMs: 123,
        lastModified: 100,
        bloom: 'AAAA',
        bloomBits: 24,
        itemCount: 2,
        chapters: [
          { file: '001-x.txt', name: '起风', index: 0, mtimeMs: 10, size: 20, chars: 3 },
          { file: '', name: '坏章' },
          null
        ]
      }
    ]
  };
  const parsed = search.parseIndex(JSON.stringify(dirty));
  assert.ok(parsed);
  assert.equal(parsed.books.length, 1);
  assert.equal(parsed.books[0].chapters.length, 1); // 空 file 的坏章被丢掉
  assert.equal(parsed.books[0].chapters[0].name, '起风');
  assert.equal(parsed.books[0].title, '测试书');
  assert.equal(search.totalChapters(parsed), 1);
});

// P3（审计修复 #19）：整本建图时中间「不重复双字」集合也有硬上限 —— 以前只有最终位图受
// MAX_BLOOM_BITS 限制，中间 Set 随正文无限长大（千万字级巨书可达数百 MB）。
test('正文索引（P3）：双字集合到上限就放弃位图（bloomOmitted），不是截断位图', () => {
  const text = '林婉儿撑着一把青柠色的雨伞，站在旧车站的月台上。';
  const saturated = search.makeBookBloom([text], { maxItems: 8 });
  assert.equal(saturated.omitted, true, '超限必须如实标「放弃位图」');
  assert.equal(saturated.bloom, null, '放弃 = 不给位图（截断位图会静默漏报）');
  assert.equal(saturated.items, 0);
  // 上限内照旧出位图；重复双字不重复计数，不会因为「重复读同一句」被误判超限
  const within = search.makeBookBloom([text, text], { maxItems: 40 });
  assert.equal(within.omitted, false);
  const normal = search.makeBookBloom([text, text]);
  assert.deepEqual(within, normal, '上限内与默认路径逐字节一致');
  assert.ok(Buffer.isBuffer(normal.bloom));
  // 上限常量：1M 不重复双字 → 8M bit ≈ 1 MB 位图，远超真实中文书（25 万字约 5–8 万不重复双字）
  assert.equal(search.MAX_BLOOM_ITEMS, 1024 * 1024);
});

// 丢掉整本书的位图（章节指纹保留），被丢的书搜索时永远当候选、逐章核对：只降速、不漏结果。
test('正文索引（#33）：总量预算超限时淘汰最旧书目的位图（纯函数，字节上界 + 指纹保留）', () => {
  // 写盘预算必须明显小于读盘上限：自己写出的索引一定读得回来
  assert.equal(search.MAX_INDEX_BYTES, 32 * 1024 * 1024);
  assert.ok(search.MAX_INDEX_BYTES < search.MAX_INDEX_READ_BYTES);
  const makeEntry = (folder, lastModified) => ({
    path: `C:\\books\\${folder}`,
    folder,
    id: `b_${folder}`,
    title: folder,
    metaMtimeMs: lastModified,
    lastModified,
    bloom: Buffer.alloc(2048, 7).toString('base64'),
    bloomBits: 16384,
    bloomCrc: 123,
    itemCount: 99,
    bloomOmitted: false,
    bloomDropped: false,
    chapters: [{ id: 'ch_001', name: '章', file: '001.txt', index: 0, mtimeMs: 1, size: 2, contentHash: 'abc', chars: 3 }]
  });
  const index = {
    version: search.INDEX_VERSION,
    root: 'C:\\books',
    builtAt: 'x',
    updatedAt: 'y',
    books: [makeEntry('新书', 200), makeEntry('旧书', 100), makeEntry('中书', 150)]
  };
  const fullBytes = Buffer.byteLength(search.serializeIndex(index));
  assert.equal(search.enforceIndexBudget(index, fullBytes).dropped, 0, '预算内一根手指都不动');
  const capped = search.enforceIndexBudget(index, fullBytes - 1);
  assert.equal(capped.dropped, 1);
  assert.ok(Buffer.byteLength(search.serializeIndex(capped.index)) <= fullBytes - 1, '序列化字节数必须回到预算内');
  const dropped = capped.index.books.find((book) => book.folder === '旧书');
  assert.equal(dropped.bloom, '');
  assert.equal(dropped.bloomDropped, true);
  assert.deepEqual(dropped.chapters, index.books[1].chapters, '章节指纹一条不丢（下次校验仍能发现正文变化）');
  assert.ok(capped.index.books.find((book) => book.folder === '新书').bloom, '最后修改最新的书保留位图');
  assert.equal(index.books[1].bloom.length > 0, true, '纯函数不改入参');
  const tiny = search.enforceIndexBudget(index, 50);
  assert.equal(tiny.dropped, 3, '连章节指纹都放不下时，把能丢的位图全丢掉（不假装成功）');
  assert.ok(tiny.index.books.every((book) => book.bloomDropped === true && book.bloom === ''));
});

// ---------- 审计修复 #46（E21）：260 截断 / 错误透传 / saveNow 归一链 ----------
test('E21（#46）：解析索引时不静默截断章节文件名 —— 真实名照原样保留，离谱长的整条丢弃', () => {
  const longName = `${'x'.repeat(300)}.txt`; // 远超旧 slice(0,260) 的截断线，但仍是真实文件名的量级
  const absurdName = `${'y'.repeat(5000)}.txt`; // 只可能是坏索引 / 手改 JSON
  const raw = JSON.stringify({
    version: search.INDEX_VERSION,
    root: '/books',
    books: [
      {
        path: '/books/书甲',
        folder: '书甲',
        chapters: [
          { file: longName, index: 0, mtimeMs: 1, size: 2, contentHash: 'h' },
          { file: absurdName, index: 1, mtimeMs: 1, size: 2, contentHash: 'h' }
        ]
      }
    ]
  });
  const parsed = search.parseIndex(raw);
  const files = parsed.books[0].chapters.map((chapter) => chapter.file);
  assert.deepEqual(files, [longName], '旧实现会把长度 300 的名字切成 260，永远匹配不到真实章节');
  assert.equal(files[0].length, longName.length);
});
