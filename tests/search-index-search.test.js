// 搜索索引测试（T9 / 第 10 轮按性质拆分）：搜索 / 命中 / focus / 缓存与并发。
// 本文件覆盖：搜正文的章名 / 上下文 / 命中位置 → limit 截断 → 每章 3 条 → P22-4 真命中数 / focus 聚焦一章
// （越权 / 片段上限 / 单章计数硬上限）→ 200 章规模 → P-01 根签名 stat 只一次 → V76 toLowerCase 长度变化 →
// V92 building 透传 → V93 / 五-L4 / P3 位图缓存（条数 + 字节预算 + 只缓存候选）→ P1 首建期回 building →
// CTXT-A-02 跨根校验不阻塞 → P4 同根并发「最近一次胜出」。
//
// 来源：原 tests/search-index.test.js（1,678 行 / 51 例）按性质拆成夹具 + 四个文件，**只搬家不改断言**——
// 用例标题与断言逐字保留，共用夹具收进 tests/search-index-fixtures.js（T9 纪律，见 tests/README.md）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const search = require('../core/search-index');
const { mkTmp, pad3, makeBook, makeStore, makeWorld, nthIndex } = require('./search-index-fixtures');

test('正文索引：搜正文返回章名 / 上下文 / 命中位置，大小写不敏感，搜不到的返回空', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  const text = '雨还在下。他撑着一把青柠色的雨伞，站在旧车站的月台上。\n风很轻。';
  await makeBook(booksRoot, '测试书', '测试书', [
    { name: '旧车站', text },
    { name: '夜雨', text: 'Nothing about that here.' }
  ]);
  const store = makeStore(userData);

  const hit = await store.search({ booksRoot, query: '青柠色' });
  assert.equal(hit.tooShort, false);
  assert.equal(hit.results.length, 1);
  const row = hit.results[0];
  assert.equal(row.bookTitle, '测试书');
  assert.equal(row.chapterIndex, 0);
  assert.equal(row.chapterName, '旧车站');
  assert.equal(row.matchIndex, text.indexOf('青柠色'));
  assert.equal(text.slice(row.matchIndex, row.matchIndex + row.matchLength), '青柠色');
  assert.equal(row.snippet.match, '青柠色');
  assert.ok(row.snippet.before.length > 0);
  assert.ok(row.snippet.after.length > 0);
  assert.equal(hit.index.books, 1);
  assert.equal(hit.index.chapters, 2);
  assert.equal(hit.scannedBooks, 1);

  const latin = await store.search({ booksRoot, query: 'NOTHING' });
  assert.equal(latin.results.length, 1);
  assert.equal(latin.results[0].chapterName, '夜雨');

  const miss = await store.search({ booksRoot, query: '绝对不存在的词xyz' });
  assert.equal(miss.results.length, 0);
  assert.equal(miss.truncated, false);

  const short = await store.search({ booksRoot, query: '雨' });
  assert.equal(short.tooShort, true);
  assert.equal(short.results.length, 0);
});

test('正文索引：结果按 limit 截断并标记 truncated（分页 / 限量）', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  const chapters = [];
  for (let i = 0; i < 5; i += 1) {
    chapters.push({ name: `第${i + 1}节`, text: `青柠色的雨伞每天都出现（第${i + 1}章）。` });
  }
  await makeBook(booksRoot, '多章书', '多章书', chapters);
  const store = makeStore(userData);
  const limited = await store.search({ booksRoot, query: '青柠色', limit: 2 });
  assert.equal(limited.results.length, 2);
  assert.equal(limited.limit, 2);
  assert.equal(limited.truncated, true);
  assert.equal(limited.matchedChapters, 2);
  const all = await store.search({ booksRoot, query: '青柠色', limit: 60 });
  assert.equal(all.results.length, 5);
  assert.equal(all.truncated, false);
});

test('正文索引：一本书里多个命中按章返回，最多每章 3 条（列表不会炸）', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  const repeated = Array.from({ length: 6 }, (_, i) => `青柠色第${i + 1}次。`).join('');
  await makeBook(booksRoot, '重复书', '重复书', [{ name: '多命中', text: repeated }]);
  const store = makeStore(userData);
  const found = await store.search({ booksRoot, query: '青柠色', limit: 40 });
  assert.equal(found.results.length, search.MAX_SNIPPETS_PER_CHAPTER);
  assert.equal(found.matchedChapters, 1);
  // P22-4：totalMatches 从「已列出的片段数」改成真命中数（本章 6 处，列表仍只列 3 条）。
  assert.equal(found.totalMatches, 6);
  assert.equal(found.truncated, false);
});

test('正文索引（P22-4）：单章 10 处命中仍只列 3 条，但 chapterMatchCount / totalMatches 是真命中数', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  const text10 = Array.from({ length: 10 }, (_, i) => `灯芯第${i + 1}次亮起。`).join('');
  const text2 = '灯芯又亮了一次。灯芯最后暗了下去。';
  const { bookPath, meta } = await makeBook(booksRoot, '章内计数书', '章内计数书', [
    { name: '灯芯章', text: text10 },
    { name: '收尾章', text: text2 }
  ]);
  const store = makeStore(userData);
  const found = await store.search({ booksRoot, query: '灯芯' });
  assert.equal(found.results.length, search.MAX_SNIPPETS_PER_CHAPTER + 2, '第一章只列 3 条 + 第二章列 2 条');
  assert.equal(found.results.filter((row) => row.chapterIndex === 0).length, search.MAX_SNIPPETS_PER_CHAPTER);
  assert.equal(found.results.filter((row) => row.chapterIndex === 1).length, 2);
  assert.equal(found.matchedChapters, 2);
  assert.equal(found.totalMatches, 12, 'totalMatches 改成真命中数：10 + 2');
  assert.equal(found.truncated, false, '每章只列 3 条不算整次 truncated（旧语义不变）');

  const firstRows = found.results.filter((row) => row.chapterIndex === 0);
  assert.equal(firstRows[0].chapterFile, meta.chapters[0].file);
  assert.equal(firstRows[0].bookPath, bookPath);
  for (const row of firstRows) {
    assert.equal(row.chapterMatchCount, 10, '同一章每行都带本章真命中数');
    assert.equal(row.chapterCountCapped, false);
    assert.equal(row.bookTitle, '章内计数书');
    assert.equal(row.chapterName, '灯芯章');
  }
  assert.deepEqual(
    firstRows.map((row) => row.matchIndex),
    [nthIndex(text10, '灯芯', 1), nthIndex(text10, '灯芯', 2), nthIndex(text10, '灯芯', 3)],
    '默认结果仍按位置取前 3 条、顺序不变'
  );
  const secondRows = found.results.filter((row) => row.chapterIndex === 1);
  assert.equal(secondRows[0].chapterFile, meta.chapters[1].file);
  for (const row of secondRows) assert.equal(row.chapterMatchCount, 2);
});

test('正文索引（P22-4）：focus 只读目标一章，返回该章全部命中（按位置、带上下文片段）', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  const text10 = Array.from({ length: 10 }, (_, i) => `灯芯第${i + 1}次亮起。`).join('');
  const book = await makeBook(booksRoot, '聚焦书', '聚焦书', [
    { name: '灯芯章', text: text10 },
    { name: '别的章', text: '这一章也有灯芯。' }
  ]);
  const store = makeStore(userData);
  const chapterFile = book.meta.chapters[0].file;
  const focused = await store.search({
    booksRoot,
    query: '灯芯',
    limit: 2, // focus 不受整次 limit 40 / 这里传入的 2 限制
    focus: { bookPath: book.bookPath, chapterFile }
  });
  assert.equal(focused.focus, true);
  assert.equal(focused.focusError, undefined);
  assert.equal(focused.limit, search.MAX_FOCUS_SNIPPETS);
  assert.equal(focused.results.length, 10);
  assert.equal(focused.totalMatches, 10);
  assert.equal(focused.matchedChapters, 1);
  assert.equal(focused.scannedBooks, 1);
  assert.equal(focused.scannedChapters, 1);
  assert.equal(focused.truncated, false);
  assert.equal(focused.results[0].chapterFile, chapterFile);
  assert.equal(focused.results[0].chapterMatchCount, 10);
  assert.equal(focused.results[0].chapterCountCapped, false);
  assert.deepEqual(
    focused.results.map((row) => row.matchIndex),
    Array.from({ length: 10 }, (_, i) => nthIndex(text10, '灯芯', i + 1)),
    '按正文位置升序'
  );
  assert.deepEqual(
    focused.results.map((row) => row.snippet.match),
    Array.from({ length: 10 }, () => '灯芯'),
    '每条都带命中上下文片段'
  );
  assert.ok(focused.results[9].snippet.before.includes('第9次'));
  assert.ok(focused.results[9].snippet.before.length > 0);
});

test('正文索引（P22-4）：focus 的书 / 章不在索引里、或路径越权 → 空结果 + focusError（不读任意路径）', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  const book = await makeBook(booksRoot, '聚焦书', '聚焦书', [{ name: '灯芯章', text: '灯芯亮着。' }]);
  const outside = await makeBook(base, '库外书', '库外书', [{ name: '库外章', text: '灯芯在库外。' }]);
  const store = makeStore(userData);
  const chapterFile = book.meta.chapters[0].file;

  const missingBook = await store.search({
    booksRoot,
    query: '灯芯',
    focus: { bookPath: path.join(booksRoot, '没有这本书'), chapterFile }
  });
  assert.equal(missingBook.focus, true);
  assert.equal(missingBook.focusError, '聚焦的书籍不在书架索引里');
  assert.deepEqual(missingBook.results, []);

  const outsideBook = await store.search({
    booksRoot,
    query: '灯芯',
    focus: { bookPath: outside.bookPath, chapterFile: '001-库外章.txt' }
  });
  assert.equal(outsideBook.focusError, '聚焦的书籍不在书架索引里', '书架目录外的书即使真实存在也不认');

  const escapeBook = await store.search({
    booksRoot,
    query: '灯芯',
    focus: { bookPath: path.join(booksRoot, '..', '库外书'), chapterFile: '001-库外章.txt' }
  });
  assert.equal(escapeBook.focusError, '聚焦的书籍不在书架索引里', '.. 越权归一化后不在 index.root 下');

  const missingChapter = await store.search({
    booksRoot,
    query: '灯芯',
    focus: { bookPath: book.bookPath, chapterFile: '999-不存在.txt' }
  });
  assert.equal(missingChapter.focusError, '聚焦的章节不在书架索引里');

  for (const chapterFileBad of ['../书目.json', '..\\书目.json', '001-灯芯章.txt/../书目.json']) {
    const bad = await store.search({
      booksRoot,
      query: '灯芯',
      focus: { bookPath: book.bookPath, chapterFile: chapterFileBad }
    });
    assert.equal(bad.focusError, '聚焦的书籍或章节无效', chapterFileBad);
    assert.deepEqual(bad.results, []);
  }

  const badShape = await store.search({
    booksRoot,
    query: '灯芯',
    focus: { bookPath: 42, chapterFile }
  });
  assert.equal(badShape.focusError, '聚焦的书籍或章节无效');
  const tooLong = await store.search({
    booksRoot,
    query: '灯芯',
    focus: { bookPath: book.bookPath, chapterFile: 'x'.repeat(search.MAX_FOCUS_FIELD_CHARS + 1) }
  });
  assert.equal(tooLong.focusError, '聚焦的书籍或章节无效');
});

test('正文索引（P22-4）：focus 片段上限 200 条 + truncated，totalMatches 仍是真命中数', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  const text = Array.from({ length: 260 }, (_, i) => `灯芯${i + 1}。`).join('');
  const book = await makeBook(booksRoot, '很多命中', '很多命中', [{ name: '灯芯章', text }]);
  const store = makeStore(userData);
  const focused = await store.search({
    booksRoot,
    query: '灯芯',
    focus: { bookPath: book.bookPath, chapterFile: book.meta.chapters[0].file }
  });
  assert.equal(focused.results.length, search.MAX_FOCUS_SNIPPETS);
  assert.equal(focused.totalMatches, 260);
  assert.equal(focused.truncated, true, '超过片段上限要明确标记 truncated');
  assert.equal(focused.results[0].chapterMatchCount, 260);
  assert.equal(focused.results[search.MAX_FOCUS_SNIPPETS - 1].matchIndex, nthIndex(text, '灯芯', 200));
});

test('正文索引（P22-4）：单章计数硬上限 10000，超过后 chapterCountCapped 显示 N+', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  const total = search.MAX_CHAPTER_MATCH_COUNT + 3;
  const text = '灯芯。'.repeat(total);
  const book = await makeBook(booksRoot, '超多命中', '超多命中', [{ name: '灯芯章', text }]);
  const store = makeStore(userData);
  const found = await store.search({ booksRoot, query: '灯芯' });
  assert.equal(found.results.length, search.MAX_SNIPPETS_PER_CHAPTER);
  assert.equal(found.totalMatches, search.MAX_CHAPTER_MATCH_COUNT);
  for (const row of found.results) {
    assert.equal(row.chapterMatchCount, search.MAX_CHAPTER_MATCH_COUNT);
    assert.equal(row.chapterCountCapped, true);
  }
  const focused = await store.search({
    booksRoot,
    query: '灯芯',
    focus: { bookPath: book.bookPath, chapterFile: book.meta.chapters[0].file }
  });
  assert.equal(focused.results.length, search.MAX_FOCUS_SNIPPETS);
  assert.equal(focused.totalMatches, search.MAX_CHAPTER_MATCH_COUNT);
  assert.equal(focused.results[0].chapterCountCapped, true);
  assert.equal(focused.truncated, true);
});

test('正文索引：200 章规模的书建索引 / 搜索可用（不要求速度，只要求不出错）', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  const chapters = [];
  for (let i = 0; i < 200; i += 1) {
    const filler = '风从海面吹来，带着咸味。'.repeat(20);
    chapters.push({ name: `第${i + 1}章`, text: `${filler}${i === 137 ? '青柠色的雨伞。' : ''}` });
  }
  await makeBook(booksRoot, '大部头', '大部头', chapters);
  const store = makeStore(userData);
  const status = await store.ensure({ booksRoot });
  assert.equal(status.books, 1);
  assert.equal(status.chapters, 200);
  const found = await store.search({ booksRoot, query: '青柠色' });
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].chapterIndex, 137);
});

// A4 / P-01（审计：搜索每次都 ensure → 每本书一次 书目.json stat，280 本 ≈ 280 次/键）：
// 索引已就绪、同一个书架根、版本一致时，搜索侧在窗口内直接复用内存索引；
// 失效靠「根目录签名 + 2 s 节流」与「60 s 窗口」，两者命中时才重新校验。
// 口径：预热后连续两次 search 合计只发生 1 次 stat（根目录签名），逐书 书目.json 的 stat 必须是 0。
test('正文索引（P-01）：连续两次 search 只做一次根签名 stat、逐书 书目.json stat 为 0', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  await makeBook(booksRoot, '书甲', '书甲', [{ name: '第一章', text: '青柠色的雨伞挂在门口。' }]);

  let clockMs = Date.parse('2026-11-11T20:00:00.000Z');
  const statCalls = [];
  const store = makeStore(userData, {
    validateIntervalMs: 2000, // 非 0：搜索侧窗口生效（默认 60 s）
    now: () => new Date(clockMs),
    stat: (target) => {
      statCalls.push(path.resolve(String(target)));
      return fs.stat(target);
    }
  });

  // 预热：第一次搜索建索引（这一步允许逐书 stat）
  const first = await store.search({ booksRoot, query: '青柠色' });
  assert.equal(first.results.length, 1);

  // 越过 2 s 签名节流、留在 60 s 窗口内 → 两次搜索合计只允许一次根签名 stat
  clockMs += 5000;
  statCalls.length = 0;
  const second = await store.search({ booksRoot, query: '青柠色' });
  const third = await store.search({ booksRoot, query: '灯芯' });
  assert.equal(second.results.length, 1);
  assert.equal(third.results.length, 0);

  const metaStats = statCalls.filter((file) => file.endsWith(`${path.sep}书目.json`));
  const rootStats = statCalls.filter((file) => file === path.resolve(booksRoot));
  assert.equal(statCalls.length, 1, `两次搜索只该 stat 一次，实际：${statCalls.join(' | ')}`);
  assert.equal(rootStats.length, 1);
  assert.equal(metaStats.length, 0, `窗口内不许逐书 stat 书目.json，实际：${metaStats.join(' | ')}`);
});

// V76（1.7.2 D6）：个别字符小写后会「变长」（'İ' U+0130 → 'i' + U+0307，两个码元）。
// 以前拿整章 toLowerCase() 的结果当扫描用的干草堆：长度一变，matchIndex 与片段位置整体后移，
// 结果列表里高亮的不是命中的那几个字。core/find.js:18-20 对同一件事有长度防御，这里对齐：
// 小写化长度变了就回退原文扫描（宁可少一次大小写不敏感匹配，也不许把片段指到别的字上）。
test('正文索引（V76）：toLowerCase 改变长度时回退原文，matchIndex / 片段不错位', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  const text = 'İİ青柠色的雨伞挂在门口。';
  assert.equal(text.toLowerCase().length, text.length + 2, '前提：这个字符小写后长度变了（否则本用例不成立）');
  await makeBook(booksRoot, '书甲', '书甲', [{ name: '第一章', text }]);

  const store = makeStore(userData);
  const found = await store.search({ booksRoot, query: '青柠色' });
  assert.equal(found.results.length, 1);
  const hit = found.results[0];
  assert.equal(hit.matchIndex, text.indexOf('青柠色'), 'matchIndex 必须是原文里的下标');
  assert.equal(hit.matchLength, 3);
  assert.equal(hit.snippet.match, '青柠色', '片段要正好落在命中的那三个字上');
  assert.equal(hit.snippet.before, 'İİ', '前文按原文取，不能带上小写化多出来的码元');
});

// V92（1.7.2 D6）：后台重建在飞时，搜索回包里的 index.building 必须透传 state.building。
// 以前写字面量 false：界面上正显示「正在建索引」，搜索结果却自称 ready，进度条 / 重试提示判断错。
test('正文索引（V92）：indexInfo.building 透传 state.building（后台重建在飞时为 true）', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  const { bookPath } = await makeBook(booksRoot, '书甲', '书甲', [{ name: '第一章', text: '青柠色的雨伞挂在门口。' }]);

  const clockMs = Date.parse('2026-11-11T20:00:00.000Z');
  // 卡门闸：第二次 ensure 的根目录签名 stat 停在这里，保证搜索读 status() 时重建「确实在飞」。
  let holdRootStat = false;
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const store = makeStore(userData, {
    validateIntervalMs: 2000, // 非 0：搜索侧 60 s 窗口生效，窗口内直接读 status()
    now: () => new Date(clockMs),
    stat: (target) => {
      if (holdRootStat && path.resolve(String(target)) === path.resolve(booksRoot)) {
        return gate.then(() => fs.stat(target));
      }
      return fs.stat(target);
    }
  });

  const warm = await store.ensure({ booksRoot });
  assert.equal(warm.ready, true);

  // 阴性对照：没有重建在飞时 building 必须是 false（修完不许把这里写成死 true）
  const idle = await store.search({ booksRoot, query: '青柠色' });
  assert.equal(idle.index.building, false, '没有重建在飞：index.building 是 false');

  holdRootStat = true;
  const rebuilding = store.ensure({ booksRoot }); // 故意不 await：ensurePromise 在飞

  const plain = await store.search({ booksRoot, query: '青柠色' });
  assert.equal(plain.results.length, 1);
  assert.equal(plain.index.building, true, '后台重建在飞：搜索结果里的 index.building 必须是 true');

  const focus = await store.search({
    booksRoot,
    query: '青柠色',
    focus: { bookPath, chapterFile: '001-第一章.txt' }
  });
  assert.equal(focus.results.length, 1);
  assert.equal(focus.index.building, true, '聚焦一章那条路径同样要透传（不是另写一份 false）');

  holdRootStat = false; // 放行那次根目录 stat（卡门闸只卡这一下）
  release();
  await rebuilding;
});

// V93（1.7.2 D6）：bloomCache（path → 解码后的位图 Buffer）以前只增不减，一直开到换书架根。
// 位图按字数增长（几十 KB/本），长书架上「搜过一遍」就等于把整架书的位图全留在主进程里。
// 现在加上界（32 条 LRU）：淘汰的只是缓存，命中的结果不许少。
test('正文索引（V93）：bloomCache 有上界 32 条（LRU），长书架不把位图全留在内存', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  const TOTAL = 40;
  for (let i = 0; i < TOTAL; i += 1) {
    await makeBook(booksRoot, `书${pad3(i)}`, `书${pad3(i)}`, [
      { name: '第一章', text: `第 ${i} 本：青柠色的雨伞挂在门口。` }
    ]);
  }

  const store = makeStore(userData);
  await store.ensure({ booksRoot });
  const found = await store.search({ booksRoot, query: '青柠色', limit: 60 });
  assert.equal(found.candidateBooks, TOTAL, '前提：40 本都要过一遍位图（每本都会被 bloomFor 摸到）');
  assert.equal(search.BLOOM_CACHE_MAX, 32, '上界常量是 32 条（V93）');
  const cached = store.getBloomCacheSize();
  assert.ok(cached <= search.BLOOM_CACHE_MAX, `缓存条数必须有上界：实际 ${cached}`);
  assert.equal(cached, 32, '40 本都过了一遍位图，缓存也只留 32 条');

  // 被淘汰的书下一次搜索时重新解码位图，结果一条都不许少
  const again = await store.search({ booksRoot, query: '青柠色', limit: 60 });
  assert.equal(again.results.length, TOTAL);
  assert.equal(again.totalMatches, TOTAL);
  assert.ok(store.getBloomCacheSize() <= search.BLOOM_CACHE_MAX);
});

// 五-L4（CI-7）：旧候选循环对整架每本书都 bloomFor → rememberBloom。书架 >32 本时，本轮缓存里
// 只剩顺序上最后 32 本；下一轮从第 1 本开始又逐本 miss、把上一轮留下的也挤掉 —— 跨搜索命中率恒为 0
// （280 本 ≈ 22MB 位图每次搜索整架 base64 解码 + CRC32，纯属白付）。现在只把「位图筛选通过、
// 真要去读正文」的候选登记进缓存，让 32 条上界覆盖注释所说的候选热区。
test('五-L4（CI-7）：只有通过位图筛选的候选进 bloomCache，非候选不再冲刷整架热区', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  const TOTAL = 40;
  for (let i = 0; i < TOTAL; i += 1) {
    const text = i === TOTAL - 1 ? '第 40 本：青柠色的雨伞挂在门口。' : `第 ${i} 本：窗外的雨下了一夜。`;
    await makeBook(booksRoot, `书${pad3(i)}`, `书${pad3(i)}`, [{ name: '第一章', text }]);
  }
  const store = makeStore(userData);
  await store.ensure({ booksRoot });
  const found = await store.search({ booksRoot, query: '青柠色', limit: 60 });
  assert.equal(found.candidateBooks, 1, '前提：只有一本书的位图能通过筛选');
  assert.equal(found.results.length, 1);
  assert.equal(
    store.getBloomCacheSize(),
    1,
    '缓存只留真候选（旧实现把整架最后 32 本塞进去，跨搜索命中率恒为 0）'
  );
  // 第二次搜索：结果一致，缓存仍是那一份候选热区（没被非候选重新冲刷）
  const again = await store.search({ booksRoot, query: '青柠色', limit: 60 });
  assert.equal(again.results.length, 1);
  assert.equal(again.candidateBooks, 1);
  assert.equal(store.getBloomCacheSize(), 1);
});

// P3（审计修复 #19）：条数上界（32）不等于字节上界 —— 32 条 × 单本最大 8 MB 位图 ≈ 256 MB。
test('正文索引（P3）：位图缓存除条数外还有字节预算（超预算按 LRU 淘汰，结果不丢）', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  const TOTAL = 6;
  for (let i = 0; i < TOTAL; i += 1) {
    await makeBook(booksRoot, `书${pad3(i)}`, `书${pad3(i)}`, [
      { name: '第一章', text: `第 ${i} 本：青柠色的雨伞挂在门口。` }
    ]);
  }
  // 每本的最小位图 = MIN_BLOOM_BITS / 8 = 128 字节；预算 256 字节只装得下两本
  const store = makeStore(userData, { bloomCacheMaxBytes: 256 });
  await store.ensure({ booksRoot });
  const found = await store.search({ booksRoot, query: '青柠色', limit: 60 });
  assert.equal(found.results.length, TOTAL, '前提：六本都过了一遍位图');
  assert.equal(search.BLOOM_CACHE_MAX_BYTES, 32 * 1024 * 1024, '生产字节预算 32 MB');
  assert.equal(store.getBloomCacheSize(), 2, '256 字节预算 + 128 字节位图 → 只留两本');
  assert.ok(store.getBloomCacheBytes() <= 256, `字节预算必须生效：实际 ${store.getBloomCacheBytes()} 字节`);

  // 淘汰只是缓存：再搜一次结果一条不少，字节数仍受预算约束
  const again = await store.search({ booksRoot, query: '青柠色', limit: 60 });
  assert.equal(again.results.length, TOTAL);
  assert.equal(again.totalMatches, TOTAL);
  assert.ok(store.getBloomCacheBytes() <= 256);
});

// P1（审计修复 #9）：首建期搜索不再 await ensure —— 旧实现排在在途构建之后再跑一遍校验，
// 1800 ms 预算从 ensure 返回后才起算，大书架首建期搜索可阻塞数分钟。同一书架根已有校验在飞时，
// 搜索直接回 building:true + 空结果；建完后由渲染层的进度事件按原查询自动重搜。
test('正文索引（P1）：首建期搜索立即回 building + 空结果，建完后同一查询立即可用', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  await makeBook(booksRoot, '书甲', '书甲', [{ name: '第一章', text: '青柠色的雨伞挂在门口。' }]);

  // 卡门闸：首建的根目录签名 stat 停在这里，保证搜索发生时「构建确实在飞」。
  let released = false;
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const store = makeStore(userData, {
    stat: (target) => {
      const resolved = path.resolve(String(target));
      if (!released && resolved === path.resolve(booksRoot)) return gate.then(() => fs.stat(target));
      return fs.stat(target);
    }
  });
  const buildingRun = store.ensure({ booksRoot }); // 故意不 await：首建在飞
  const startedAt = Date.now();
  const during = await store.search({ booksRoot, query: '青柠色' });
  const elapsed = Date.now() - startedAt;
  assert.equal(during.index.building, true, '构建在飞：搜索结果必须标 building');
  assert.deepEqual(during.results, [], '首建期先回空结果，不冒充「没找到」的精确结论');
  assert.equal(during.truncated, true, '截断标记如实（建好后会按原查询自动重搜）');
  assert.equal(during.index.books, 0, '此时本根还没有可用索引');
  assert.ok(elapsed < 1000, `首建期搜索必须立即返回（实际 ${elapsed} ms）`);

  released = true;
  release();
  const done = await buildingRun;
  assert.equal(done.books, 1);
  const after = await store.search({ booksRoot, query: '青柠色' });
  assert.equal(after.results.length, 1, '建完后同一查询能拿到结果（不漏结果）');
  assert.equal((await store.status()).building, false, '这一轮校验结束后不再是 building');
});

// CTXT-A-02（审计）：ensure 队列是全局单链；跨书架根时搜索不能再排到别根的分钟级校验后面。
test('正文索引（CTXT-A-02）：跨根在途校验不阻塞搜索，回 building 并立即返回', async () => {
  const base = await mkTmp();
  const userData = path.join(base, 'userdata');
  const rootA = path.join(base, 'books-a');
  const rootB = path.join(base, 'books-b');
  await fs.mkdir(userData);
  await fs.mkdir(rootA);
  await fs.mkdir(rootB);
  await makeBook(rootA, '甲书', '甲书', [{ name: '第一章', text: '青柠色的雨伞挂在门口。' }]);
  await makeBook(rootB, '乙书', '乙书', [{ name: '第一章', text: '旧车站的钟停在四点。' }]);

  // 卡门闸：B 根的首建停在根目录签名 stat 上，保证搜索 A 时「B 的校验确实在飞」。
  let released = false;
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const store = makeStore(userData, {
    stat: (target) => {
      const resolved = path.resolve(String(target));
      if (!released && resolved === path.resolve(rootB)) return gate.then(() => fs.stat(target));
      return fs.stat(target);
    }
  });
  const buildingB = store.ensure({ booksRoot: rootB }); // 故意不 await：B 的首建在飞
  const startedAt = Date.now();
  const during = await Promise.race([
    store.search({ booksRoot: rootA, query: '青柠色' }),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('跨根搜索被别根的校验阻塞')), 3000))
  ]);
  const elapsed = Date.now() - startedAt;
  assert.equal(during.index.building, true, '别根校验在飞：本根还没有可用索引，必须标 building');
  assert.deepEqual(during.results, [], '先回空结果，不冒充「没找到」');
  assert.equal(during.truncated, true);
  assert.ok(elapsed < 1000, `跨根搜索必须立即返回（实际 ${elapsed} ms）`);

  released = true;
  release();
  await buildingB;
  const after = await store.search({ booksRoot: rootA, query: '青柠色' });
  assert.equal(after.results.length, 1, '本根自己的索引建好后同一查询能拿到结果（不漏结果）');
});

// ---------- P4（一轮·低）：同根并发的「最近一次胜出」 ----------
// 渲染层已有 320ms 防抖 + 查询令牌丢弃旧回执，但主进程旧查询的全文扫描仍会跑完（CPU / 磁盘白费）。
// search() 现在领票：更新的搜索一到，旧查询在 await 边界提前收工，返回 { superseded: true }。
test('P4（一轮·低）：同根并发搜索「最近一次胜出」，旧查询提前收工不再扫完', async () => {
  const base = await mkTmp('cw-search-p4-');
  const { userData, booksRoot } = await makeWorld(base);
  await makeBook(booksRoot, '书甲', '书甲', [
    { name: '一', text: '青柠色的段落'.repeat(200) },
    { name: '二', text: '灰蓝色的段落'.repeat(200) }
  ]);
  const store = makeStore(userData);
  // 先建好索引（首建期搜索按设计只回 building:true，不参与本项竞态）
  await store.search({ booksRoot, query: '预热' });
  // 让旧查询在读盘上停 60ms：期间新查询发车，旧查询恢复后必须发现票过期。
  const storage = require('../core/storage');
  const realLoad = storage.loadChapterText;
  let delayed = false;
  storage.loadChapterText = async (...args) => {
    if (!delayed) {
      delayed = true;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    return realLoad(...args);
  };
  try {
    const older = store.search({ booksRoot, query: '青柠色' });
    await new Promise((resolve) => setImmediate(resolve));
    const newer = store.search({ booksRoot, query: '灰蓝色' });
    const [oldResult, newResult] = await Promise.all([older, newer]);
    assert.equal(oldResult.superseded, true, '旧查询必须被新查询顶掉并提前收工');
    assert.deepEqual(oldResult.results, [], '旧查询不再交出结果（渲染层反正按令牌丢弃）');
    assert.equal(newResult.superseded, undefined, '最新查询不受影响');
    assert.ok(newResult.results.length >= 1, '最新查询照常返回结果');
  } finally {
    storage.loadChapterText = realLoad;
  }
});
