const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const search = require('../core/search-index');

const tmpCleanup = require('./tmp-cleanup');

// TB-02：临时目录统一经 tests/tmp-cleanup.js 的 mkTmp（mkdtemp + 登记回收）。
const mkTmp = (prefix = 'cw-search-') => tmpCleanup.mkTmp(prefix);

function pad3(n) {
  return String(n).padStart(3, '0');
}

// 手写一本书（不经过 storage.createBook），字段形状与 v0.4.1 书目一致，且可选「旧书目」形状
async function makeBook(booksRoot, folder, title, chapters, options = {}) {
  const bookPath = path.join(booksRoot, folder);
  await fs.mkdir(bookPath, { recursive: true });
  const meta = {
    version: 1,
    id: options.id || `b_${folder}`,
    title,
    titleTemplate: '第{num}章',
    fileSeq: chapters.length,
    chapters: [],
    createdAt: '2026-10-31T12:00:00.000Z'
  };
  if (!options.oldShape) meta.schemaVersion = 1;
  for (let i = 0; i < chapters.length; i += 1) {
    const chapter = chapters[i];
    const file = `${pad3(i + 1)}-${chapter.slug || chapter.name || `章${i + 1}`}.txt`;
    await fs.writeFile(path.join(bookPath, file), chapter.text, 'utf8');
    meta.chapters.push({
      id: chapter.id || `ch_${pad3(i + 1)}`,
      file,
      name: chapter.name || '',
      createdAt: '2026-10-31T12:00:00.000Z'
    });
    if (Number.isFinite(chapter.chars)) meta.chapters[meta.chapters.length - 1].chars = chapter.chars;
  }
  await fs.writeFile(path.join(bookPath, '书目.json'), JSON.stringify(meta, null, 2), 'utf8');
  return { bookPath, meta };
}

async function readMeta(bookPath) {
  return JSON.parse(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'));
}

async function writeMeta(bookPath, meta) {
  await fs.writeFile(path.join(bookPath, '书目.json'), JSON.stringify(meta, null, 2), 'utf8');
}

function makeStore(userData, options = {}) {
  return search.createSearchStore({
    userDataDir: userData,
    validateIntervalMs: 0, // 单测里每次 ensure 都做全量校验，外部改 txt 能立刻发现
    ...options
  });
}

// TESTC-06：搜索索引夹具的「userData + booksRoot 双目录」唯一构造器。
// 以前每个用例手抄 4 行（36 处、约 200 行）；目录名 / 是否建目录这类细节只在这一点。
async function makeWorld(base) {
  const userData = path.join(base, 'userdata');
  const booksRoot = path.join(base, 'books');
  await fs.mkdir(userData);
  await fs.mkdir(booksRoot);
  return { userData, booksRoot };
}

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

// E4（审计修复 #8）：旧指纹只有 mtime / size，robocopy /COPY:DAT、rsync -t、部分同步盘
// 保留时间戳的同大小改写会漏检 → Bloom 缺新内容的双字 → 静默漏报。每章指纹补首尾 4 KB 内容哈希。
test('正文索引（E4）：保留 mtime / size 的同大小改写也会被首尾内容指纹发现并重建', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  const { bookPath, meta } = await makeBook(booksRoot, '指纹书', '指纹书', [
    { name: '章一', text: '旧车站的雨伞是灰色的。' }
  ]);
  const chapterPath = path.join(bookPath, meta.chapters[0].file);
  // 固定到整秒时间戳，稍后原样 utimes 回去（避开 Windows 文件时间精度抖动）
  const fixedAt = new Date(Math.floor((Date.now() - 60000) / 1000) * 1000);
  await fs.utimes(chapterPath, fixedAt, fixedAt);
  const before = await fs.stat(chapterPath);
  const oldHash = await search.chapterContentHashOf(chapterPath, before.size);
  assert.match(oldHash, /^\d+:[0-9a-f]{8}:[0-9a-f]{8}$/, '首尾指纹形状：size:headHash:tailHash');

  const store = makeStore(userData);
  await store.ensure({ booksRoot });
  const builtIndex = JSON.parse(await fs.readFile(path.join(userData, search.INDEX_FILE_NAME), 'utf8'));
  const builtChapter = builtIndex.books.find((book) => book.folder === '指纹书').chapters[0];
  assert.equal(builtChapter.contentHash, oldHash, '建索引时要把首尾指纹记进索引');

  // 同大小改写 + 把 mtime 原样改回去（模拟 robocopy /COPY:DAT、rsync -t）
  const nextSource = '旧车站的雨伞是青柠的。';
  assert.equal(Buffer.byteLength(nextSource, 'utf8'), before.size, '前提：字节数完全相同');
  await fs.writeFile(chapterPath, nextSource, 'utf8');
  await fs.utimes(chapterPath, before.atime, before.mtime);
  const after = await fs.stat(chapterPath);
  assert.equal(after.size, before.size, '前提：大小没变');
  assert.equal(after.mtimeMs, before.mtimeMs, '前提：时间戳也没变（否则测的是旧 mtime 口径）');

  const status = await store.ensure({ booksRoot });
  assert.equal(status.lastRun.rebuiltBooks, 1, '同大小同时间戳的改写必须重建位图');
  const freshIndex = JSON.parse(await fs.readFile(path.join(userData, search.INDEX_FILE_NAME), 'utf8'));
  const freshChapter = freshIndex.books.find((book) => book.folder === '指纹书').chapters[0];
  assert.notEqual(freshChapter.contentHash, oldHash, '内容指纹必须跟着变');
  const newTerm = await store.search({ booksRoot, query: '青柠' });
  assert.equal(newTerm.results.length, 1, '新内容要能搜到（不许静默漏报）');
  const oldTerm = await store.search({ booksRoot, query: '灰色' });
  assert.equal(oldTerm.results.length, 0, '旧内容不许再命中');
});

// E5（审计修复 #8）：decodeBloom 以前只查 ceil(bits/8)，bloomBits:0 + 1 字节能混过，
// 同长度位翻转也查不出。现在 bits 必须 === 字节数 × 8 且落在合法区间，另加每书 CRC32。
test('正文索引（E5）：位图 CRC / bits 校验不过 → 当候选逐章核对（不漏报）并在下一次校验重建自愈', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  await makeBook(booksRoot, '坏位图书', '坏位图书', [{ name: '章一', text: '青柠色的雨伞挂在门口。' }]);
  const indexPath = path.join(userData, search.INDEX_FILE_NAME);
  const warmStore = makeStore(userData);
  await warmStore.ensure({ booksRoot });

  // ① 建好的索引里有每书 CRC 与每章内容指纹；CRC 与位图对得上
  const first = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  assert.equal(first.version, search.INDEX_VERSION);
  const warm = first.books.find((book) => book.folder === '坏位图书');
  assert.equal(warm.bloomCrc, search.crc32(Buffer.from(warm.bloom, 'base64')));
  assert.ok(Buffer.isBuffer(search.decodeBloom(warm.bloom, warm.bloomBits, warm.bloomCrc)), '正常位图要能解码');

  // ② 篡改位图但保持长度 / bits / CRC 字段不变（同长度位翻转）：新窗口读回这份坏索引
  const damaged = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  const target = damaged.books.find((book) => book.folder === '坏位图书');
  const buffer = Buffer.from(target.bloom, 'base64');
  buffer[0] ^= 0xff;
  target.bloom = buffer.toString('base64');
  await fs.writeFile(indexPath, JSON.stringify(damaged), 'utf8');

  const store = makeStore(userData);
  const hit = await store.search({ booksRoot, query: '青柠色' });
  assert.equal(hit.results.length, 1, '位图坏了不能漏报：本书必须当候选书逐章核对');
  assert.ok(
    store.dirtyList().some((item) => item.endsWith('坏位图书')),
    '解码失败要登记脏书，关掉搜索窗口让下一次校验重建'
  );
  const rebuilt = await store.ensure({ booksRoot });
  assert.equal(rebuilt.lastRun.rebuiltBooks, 1, '下一次校验必须重建这本（自愈）');
  const repaired = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  const fixed = repaired.books.find((book) => book.folder === '坏位图书');
  assert.ok(search.decodeBloom(fixed.bloom, fixed.bloomBits, fixed.bloomCrc), '重建后位图与 CRC 对得上');
  assert.equal((await store.search({ booksRoot, query: '青柠色' })).results.length, 1);
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

test('正文索引：建索引落在 userData（不进书库），只存指纹与位图、不存正文', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  const marker = '这是一整段绝对不该被写进索引文件里面的正文';
  await makeBook(booksRoot, '测试书', '测试书', [
    { name: '旧车站', text: `雨还在下。${marker}。他撑着一把青柠色的雨伞。` },
    { name: '夜雨', text: '风从海面吹来，带着咸味。' }
  ]);
  await makeBook(booksRoot, '另一本', '另一本', [{ name: '起风', text: '清晨的街道很安静。' }]);

  const store = makeStore(userData);
  const status = await store.ensure({ booksRoot });
  assert.equal(status.books, 2);
  assert.equal(status.chapters, 3);
  assert.equal(status.problem, null);
  assert.ok(status.bytes > 0);
  assert.ok(status.builtAt);

  // 索引只写 userData，书库 / 书文件夹里没有多出文件
  assert.equal(await exists(path.join(userData, search.INDEX_FILE_NAME)), true);
  assert.equal(await exists(path.join(booksRoot, search.INDEX_FILE_NAME)), false);
  assert.deepEqual((await fs.readdir(booksRoot)).sort(), ['另一本', '测试书'].sort());
  assert.deepEqual((await fs.readdir(path.join(booksRoot, '测试书'))).sort(), ['001-旧车站.txt', '002-夜雨.txt', '书目.json']);

  const raw = await fs.readFile(path.join(userData, search.INDEX_FILE_NAME), 'utf8');
  assert.equal(raw.includes(marker), false, '索引里不能有正文');
  assert.equal(raw.includes('青柠色的雨伞'), false);
  assert.ok(JSON.parse(raw).books.length === 2);
  const first = JSON.parse(raw).books.find((book) => book.folder === '测试书');
  assert.ok(first.bloom.length > 0);
  assert.equal(first.chapters.length, 2);
  assert.ok(first.chapters[0].mtimeMs > 0 && first.chapters[0].size > 0);
});

// C17（v1.8.0 WP-19）：索引文件也要先 stat 再读 —— 以前直接 readFile 再 JSON.parse，
// 被外部程序换成 2 GB 文件时（误放的视频 / 坏同步盘）会把主进程内存打爆。
test('正文索引：索引文件超限 → 记 INDEX_TOO_LARGE 且一次都不读，随后按空索引重建覆盖', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  await makeBook(booksRoot, '测试书', '测试书', [{ name: '旧车站', text: '雨还在下，他在旧车站等谁。' }]);
  const indexPath = path.join(userData, search.INDEX_FILE_NAME);
  await fs.writeFile(indexPath, '{"version":1,"books":[]}', 'utf8');
  await fs.truncate(indexPath, search.MAX_INDEX_READ_BYTES + 1); // 稀疏文件：只改大小，不真写 64 MB

  const realReadFile = fs.readFile;
  let indexReads = 0;
  fs.readFile = async (...args) => {
    if (String(args[0]) === indexPath) {
      indexReads += 1;
      throw new Error('超限索引不许走进 readFile');
    }
    return realReadFile(...args);
  };
  const store = makeStore(userData);
  try {
    await store.load();
  } finally {
    fs.readFile = realReadFile;
  }

  assert.equal(indexReads, 0, '超限索引一次都不许 readFile（不许进内存）');
  assert.equal(store.getProblem(), 'INDEX_TOO_LARGE', '错误码要和「索引内容坏了」的 CORRUPT 可区分');
  assert.equal(store.getIndex().books.length, 0);
  assert.equal(store.getBytes(), 0);

  // 下一次校验自动重建（与索引损坏同一条自愈路径）：超限文件被正常索引覆盖，搜索照常
  const status = await store.ensure({ booksRoot, force: true });
  assert.equal(status.books, 1);
  assert.equal(status.problem, null);
  assert.ok((await fs.stat(indexPath)).size < 1024 * 1024, '重建后索引恢复正常大小');
  const hit = await store.search({ booksRoot, query: '旧车站' });
  assert.equal(hit.tooShort, false);
  assert.equal(hit.results.length, 1);
});

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

test('正文索引：改章名只更新元数据（不重读正文、不重建位图）', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  const { bookPath } = await makeBook(booksRoot, '测试书', '测试书', [
    { name: '旧名字', text: '青柠色的雨伞。' }
  ]);
  const store = makeStore(userData);
  await store.ensure({ booksRoot });
  const before = await store.search({ booksRoot, query: '青柠色' });
  assert.equal(before.results[0].chapterName, '旧名字');
  const bloomBefore = JSON.parse(await fs.readFile(path.join(userData, search.INDEX_FILE_NAME), 'utf8')).books[0].bloom;

  // 只改章名（模拟应用内重命名：只写 书目.json，不动 txt）
  const meta = await readMeta(bookPath);
  meta.chapters[0].name = '新名字';
  await writeMeta(bookPath, meta);
  const status = await store.ensure({ booksRoot });
  assert.equal(status.lastRun.rebuiltBooks, 0);
  assert.equal(status.lastRun.reusedBooks, 1);
  const after = await store.search({ booksRoot, query: '青柠色' });
  assert.equal(after.results[0].chapterName, '新名字');
  const bloomAfter = JSON.parse(await fs.readFile(path.join(userData, search.INDEX_FILE_NAME), 'utf8')).books[0].bloom;
  assert.equal(bloomAfter, bloomBefore, '正文没变时位图不应该重建');
});

test('正文索引：重建判定只看正文指纹（序号 / 章名变化不重建，mtime / size 变化才重建）', async () => {
  const base = await mkTmp();
  const booksRoot = path.join(base, 'books');
  await fs.mkdir(booksRoot);
  const { bookPath } = await makeBook(booksRoot, '测试书', '测试书', [
    { name: '甲', text: '青柠色的雨伞。' },
    { name: '乙', text: '旧车站的钟。' }
  ]);
  const first = await search.buildBookEntry(bookPath, '测试书', null, {});
  assert.equal(first.rebuilt, true);
  assert.equal((await search.buildBookEntry(bookPath, '测试书', first.entry, {})).rebuilt, false);

  // 只交换章节顺序（txt / 指纹都不变）：序号 previous.index 参与不了判定，位图原样复用；
  // chapters.index 跟着新顺序更新（这正是审计 F8 清掉的死条件，行为保持不变）。
  const meta = await readMeta(bookPath);
  meta.chapters = [meta.chapters[1], meta.chapters[0]];
  await writeMeta(bookPath, meta);
  const reordered = await search.buildBookEntry(bookPath, '测试书', first.entry, {});
  assert.equal(reordered.rebuilt, false, '只改顺序不重建位图');
  assert.deepEqual(
    reordered.entry.chapters.map((chapter) => chapter.index),
    [0, 1]
  );
  assert.deepEqual(
    reordered.entry.chapters.map((chapter) => chapter.file),
    [meta.chapters[0].file, meta.chapters[1].file]
  );
  assert.equal(reordered.entry.bloom, first.entry.bloom);

  // 只改章名：仍复用位图，只更新元数据
  meta.chapters[0].name = '新名字';
  await writeMeta(bookPath, meta);
  const renamed = await search.buildBookEntry(bookPath, '测试书', reordered.entry, {});
  assert.equal(renamed.rebuilt, false);
  assert.equal(renamed.entry.chapters[0].name, '新名字');

  // mtime 变了、size 没变：必须重算位图（整数秒，避免文件系统时间精度抖动）
  const target = path.join(bookPath, meta.chapters[0].file);
  const later = new Date(Math.floor((Date.now() + 5000) / 1000) * 1000);
  await fs.utimes(target, later, later);
  const touched = await search.buildBookEntry(bookPath, '测试书', renamed.entry, {});
  assert.equal(touched.rebuilt, true, 'mtime 变化必须重建');

  // size 变了、mtime 调回同一时刻：也必须重算位图
  await fs.writeFile(target, '青柠色的雨伞。多写一句。', 'utf8');
  await fs.utimes(target, later, later);
  const grown = await search.buildBookEntry(bookPath, '测试书', touched.entry, {});
  assert.equal(grown.rebuilt, true, 'size 变化必须重建');

  // old 里没有的新章：同样算正文变化
  const added = await search.buildBookEntry(
    bookPath,
    '测试书',
    { ...grown.entry, chapters: grown.entry.chapters.slice(1) },
    {}
  );
  assert.equal(added.rebuilt, true, '出现 old 里没有的章必须重建');
});

// P2-1（作业卡 1.5.0）：整本建位图改成 32 章一批读正文、逐批并进同一个 Set，
// 不再把全书 texts 常驻内存。这里钉四件事：
//   1. 跨批（70 章 = 3 批）的位图编码 / 位数 / 项数与「整本一次建」逐字节一致；
//   2. 批边界上的字数补写一章不漏（含第 32 / 64 章这种边界章）；
//   3. 任一章读不了（哪怕在第 2 批）→ 整本不给位图、字数不补，且在第 2 批就停，
//      不再把后面整本的正文都读一遍；
//   4. 静态闸门：buildBookEntry 里不能再出现「整本 chapters 一次 mapLimit」。
test('正文索引：整本建位图按批累积，跨批边界结果与整本一次建逐字节一致', async () => {
  const base = await mkTmp();
  const booksRoot = path.join(base, 'books');
  await fs.mkdir(booksRoot);
  const CHAPTERS = 70; // 32 章/批 → 批边界在 31/32/63 前后
  const chapters = [];
  for (let i = 0; i < CHAPTERS; i += 1) {
    chapters.push({
      name: `第${i + 1}节`,
      text: `第${i + 1}段。阿明在旧车站等了 ${i + 1} 分钟，雨还在下。${i % 7 === 0 ? '青柠色的雨伞。' : ''}`
    });
  }
  const { bookPath } = await makeBook(booksRoot, '分批书', '分批书', chapters);
  const built = await search.buildBookEntry(bookPath, '分批书', null, {});
  assert.equal(built.rebuilt, true);
  // 期望值 = 同一批正文一次性交给兼容入口（走「整本一次」路径），两边字节必须完全相同
  const wholeBook = search.makeBookBloom(chapters.map((chapter) => chapter.text));
  assert.equal(built.entry.bloom, search.encodeBloom(wholeBook.bloom));
  assert.equal(built.entry.bloomBits, wholeBook.bits);
  assert.equal(built.entry.itemCount, wholeBook.items);
  assert.equal(built.entry.chapters.length, CHAPTERS);
  for (let i = 0; i < CHAPTERS; i += 1) {
    const expectedChars = chapters[i].text.replace(/\s/g, '').length;
    assert.equal(built.entry.chapters[i].chars, expectedChars, `第 ${i + 1} 章字数要补上`);
  }

  // 读不了正文的章（在第 2 批里）：整本位图作废、字数不补，后面的批不再读
  const storage = require('../core/storage');
  const originalLoad = storage.loadChapterText;
  const meta = await readMeta(bookPath);
  const failingFile = meta.chapters[32].file;
  let reads = 0;
  storage.loadChapterText = async (targetBookPath, file) => {
    reads += 1;
    if (file === failingFile) throw new Error('模拟读不出来');
    return originalLoad(targetBookPath, file);
  };
  try {
    const broken = await search.buildBookEntry(bookPath, '分批书', null, {});
    assert.equal(broken.rebuilt, true);
    assert.equal(broken.entry.bloom, '');
    assert.equal(broken.entry.bloomBits, 0);
    assert.equal(broken.entry.itemCount, 0);
    for (const chapter of broken.entry.chapters) assert.equal(chapter.chars, null, '失败时字数不补（旧口径）');
    assert.ok(reads < CHAPTERS, `第 2 批就读不下去，不应该读完整本（实际读了 ${reads} 章）`);
  } finally {
    storage.loadChapterText = originalLoad;
  }

  // 静态闸门：不允许退回「整本 texts 数组一次常驻」
  const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'core', 'search-index.js'), 'utf8');
  const anchor = source.indexOf('async function buildBookEntry');
  const nextFn = source.indexOf('function createSearchStore', anchor);
  // TESTC-03：锚点缺 -1 防护时 slice(anchor, -1) 会静默截取几乎全文（或反向截成空串），闸门会误挂 / 误绿。
  assert.ok(anchor >= 0, '找不到 buildBookEntry（锚点失效）');
  assert.ok(nextFn > anchor, '找不到 createSearchStore（终点锚点失效）');
  const body = source.slice(anchor, nextFn);
  assert.equal(/mapLimit\(chapters,/.test(body), false, '整本 chapters 不能再一次性 mapLimit');
  assert.equal(body.includes('BLOOM_BUILD_BATCH'), true);
  assert.equal(body.includes('missingText'), true);
});

// V107（v1.8.0 WP-21）：lastModified 以前写 `Math.max(metaMtimeMs, ...chapters.map(...), 0)` ——
// 把整个章节数组展开成函数实参，10 万+ 章时抛 RangeError，又被 buildBookEntry 外层吞成
// 「这本书不建索引」（书还在书架上却搜不到）。现在改循环累加：这里用 20 万条假章节钉住
// 「不展开实参、不爆栈、取到真正的最大值」，并用静态闸门钉住 buildBookEntry 的调用点。
test('V107/WP-21：lastModified 改循环取最大（20 万章不展开实参），buildBookEntry 必须走它', async () => {
  const HUGE = 200000;
  const huge = Array.from({ length: HUGE }, (_, i) => ({ mtimeMs: i + 1 }));
  assert.equal(search.latestModifiedMs(0, huge), HUGE);
  // 书目 mtime 更大时取书目；空 / 坏形状按旧口径的 0 / 忽略处理
  assert.equal(search.latestModifiedMs(HUGE + 1, huge), HUGE + 1);
  assert.equal(search.latestModifiedMs(0, []), 0);
  assert.equal(search.latestModifiedMs(0, null), 0);
  assert.equal(search.latestModifiedMs(NaN, [{ mtimeMs: 5 }]), 5);
  assert.equal(search.latestModifiedMs(0, [{ mtimeMs: NaN }, { mtimeMs: 'x' }, { mtimeMs: 7 }]), 7);

  // 真实小书：lastModified = max(书目 mtime, 各章 mtime)，与旧口径逐字一致（换实现不改语义）
  const base = await mkTmp();
  const booksRoot = path.join(base, 'books');
  await fs.mkdir(booksRoot);
  const { bookPath } = await makeBook(booksRoot, '时间书', '时间书', [
    { name: '一', text: '甲' },
    { name: '二', text: '乙' }
  ]);
  const built = await search.buildBookEntry(bookPath, '时间书', null, {});
  const metaStat = await fs.stat(path.join(bookPath, '书目.json'));
  const chapterStats = await Promise.all(
    built.entry.chapters.map((chapter) => fs.stat(path.join(bookPath, chapter.file)))
  );
  // 期望值用循环取最大（TESTC-07：这条用例自己也不许用「展开整章数组」的写法，否则与它钉的口径相反）。
  let expectedLastModified = metaStat.mtimeMs;
  for (const item of chapterStats) expectedLastModified = Math.max(expectedLastModified, item.mtimeMs);
  assert.equal(built.entry.lastModified, expectedLastModified);

  // 静态闸门：不许再出现「把 chapters 展开成 Math.max 实参」（只看代码行，注释里的历史写法不算）
  const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'core', 'search-index.js'), 'utf8');
  // TESTC-02：声明「注释里的历史写法不算」就要真的全剥——整行 // 之外还要剥块注释与行尾注释
  //（行尾注释只在前面有空白时剥，免得把字符串里的 https:// 切坏）。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
  const anchor = source.indexOf('async function buildBookEntry');
  const nextFn = source.indexOf('function createSearchStore', anchor);
  assert.ok(anchor >= 0, '找不到 buildBookEntry（锚点失效）');
  assert.ok(nextFn > anchor, '找不到 createSearchStore（终点锚点失效）');
  const body = source.slice(anchor, nextFn);
  assert.equal(/\.\.\.\s*chapters/.test(code), false, '不许再把整个 chapters 数组展开成实参');
  assert.equal(/Math\.max\(\s*metaMtimeMs/.test(code), false, 'Math.max 展开写法不许回潮');
  assert.equal(body.includes('latestModifiedMs(metaMtimeMs, chapters)'), true, 'buildBookEntry 必须走循环版最大值');
});

test('正文索引：外部改 txt（mtime / size 变了）会被发现并更新索引', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  const { bookPath, meta } = await makeBook(booksRoot, '测试书', '测试书', [
    { name: '旧车站', text: '旧车站的雨伞是灰色的。' }
  ]);
  const store = makeStore(userData);
  await store.ensure({ booksRoot });
  assert.equal((await store.search({ booksRoot, query: '灰色' })).results.length, 1);

  // 直接改磁盘上的章节 txt（模拟在别的编辑器里改过）
  const chapterPath = path.join(bookPath, meta.chapters[0].file);
  await fs.writeFile(chapterPath, '旧车站的雨伞换成了青柠色的。', 'utf8');
  const status = await store.ensure({ booksRoot });
  assert.equal(status.lastRun.rebuiltBooks, 1);
  const oldTerm = await store.search({ booksRoot, query: '灰色' });
  assert.equal(oldTerm.results.length, 0);
  const newTerm = await store.search({ booksRoot, query: '青柠色' });
  assert.equal(newTerm.results.length, 1);
});

test('正文索引：章节文件被删 / 章被删，索引跟着剔除，不会崩也不会再命中', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  const { bookPath, meta } = await makeBook(booksRoot, '测试书', '测试书', [
    { name: '旧车站', text: '青柠色的雨伞。' },
    { name: '夜雨', text: '灰蓝色的雨伞。' }
  ]);
  const store = makeStore(userData);
  await store.ensure({ booksRoot });

  // 只在书目里删掉第二章（文件还在）：索引「章节数」要跟着书目走
  const nextMeta = await readMeta(bookPath);
  nextMeta.chapters = nextMeta.chapters.slice(0, 1);
  await writeMeta(bookPath, nextMeta);
  const afterMeta = await store.ensure({ booksRoot });
  assert.equal(afterMeta.chapters, 1);
  assert.equal((await store.search({ booksRoot, query: '灰蓝色' })).results.length, 0);

  // 章节文件被删（书目里还在）：跳过该章，不抛错
  await fs.unlink(path.join(bookPath, meta.chapters[0].file));
  const afterMissing = await store.ensure({ booksRoot });
  assert.equal(afterMissing.chapters, 0);
  assert.equal((await store.search({ booksRoot, query: '青柠色' })).results.length, 0);
});

test('正文索引：整本书被删掉后从索引消失', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  await makeBook(booksRoot, '要删掉的书', '要删掉的书', [{ name: '章', text: '青柠色的雨伞。' }]);
  await makeBook(booksRoot, '留下的书', '留下的书', [{ name: '章', text: '普通的一段。' }]);
  const store = makeStore(userData);
  await store.ensure({ booksRoot });
  assert.equal((await store.search({ booksRoot, query: '青柠色' })).results.length, 1);
  await fs.rm(path.join(booksRoot, '要删掉的书'), { recursive: true, force: true });
  const status = await store.ensure({ booksRoot });
  assert.equal(status.books, 1);
  assert.equal(status.lastRun.removedBooks, 1);
  assert.equal((await store.search({ booksRoot, query: '青柠色' })).results.length, 0);
});

test('正文索引：索引文件坏了 / 版本不对 → 自动重建，不抛错', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  await makeBook(booksRoot, '测试书', '测试书', [{ name: '章', text: '青柠色的雨伞。' }]);
  await fs.writeFile(path.join(userData, search.INDEX_FILE_NAME), '{"version":999,"books":[]}', 'utf8');
  const store = makeStore(userData);
  const status = await store.ensure({ booksRoot });
  assert.equal(status.books, 1);
  assert.equal(status.chapters, 1);
  assert.equal((await store.search({ booksRoot, query: '青柠色' })).results.length, 1);
  const reloaded = makeStore(userData);
  const status2 = await reloaded.ensure({ booksRoot });
  assert.equal(status2.books, 1);
});

test('正文索引：书架目录换了 → 旧索引作废、按新目录重建（不会串书）', async () => {
  const base = await mkTmp();
  const userData = path.join(base, 'userdata');
  const booksA = path.join(base, 'booksA');
  const booksB = path.join(base, 'booksB');
  await fs.mkdir(userData);
  await fs.mkdir(booksA);
  await fs.mkdir(booksB);
  await makeBook(booksA, 'A书', 'A书', [{ name: '章', text: '青柠色的雨伞。' }]);
  await makeBook(booksB, 'B书', 'B书', [{ name: '章', text: '灰蓝色的雨伞。' }]);
  const store = makeStore(userData);
  assert.equal((await store.ensure({ booksRoot: booksA })).books, 1);
  assert.equal((await store.search({ booksRoot: booksA, query: '青柠色' })).results.length, 1);
  assert.equal((await store.ensure({ booksRoot: booksB })).books, 1);
  assert.equal((await store.search({ booksRoot: booksB, query: '青柠色' })).results.length, 0);
  assert.equal((await store.search({ booksRoot: booksB, query: '灰蓝色' })).results.length, 1);
});

test('正文索引：markDirty 让最近保存过的书立即重建（不必等外部校验）', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  const { bookPath } = await makeBook(booksRoot, '测试书', '测试书', [{ name: '章', text: '青柠色的雨伞。' }]);
  const store = makeStore(userData);
  await store.ensure({ booksRoot });
  store.markDirty(bookPath);
  const status = await store.ensure({ booksRoot });
  assert.equal(status.lastRun.rebuiltBooks, 1);
  assert.equal(store.dirtyList().length, 0, '重建后脏标记要清掉');
});

test('正文索引：索引写盘失败（位置被目录占住）时搜索照常，恢复后 flush 成功', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  await makeBook(booksRoot, '测试书', '测试书', [{ name: '章', text: '青柠色的雨伞。' }]);
  const indexPath = path.join(userData, search.INDEX_FILE_NAME);
  await fs.mkdir(indexPath); // 用同名目录占住索引文件的位置
  const store = makeStore(userData);
  const status = await store.ensure({ booksRoot });
  assert.equal(status.books, 1);
  assert.ok(status.saveError);
  const found = await store.search({ booksRoot, query: '青柠色' });
  assert.equal(found.results.length, 1, '索引写不进去也不能挡搜索');
  await fs.rm(indexPath, { recursive: true, force: true });
  await store.flush();
  assert.equal(search.parseIndex(await fs.readFile(indexPath, 'utf8')) !== null, true);
});

test('正文索引：旧书目（v0.4.1 形状，没有 schemaVersion）照常建索引与搜索', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  const { bookPath } = await makeBook(
    booksRoot,
    '旧书',
    '旧书',
    [{ name: '', text: '旧车站的雨伞是青柠色的。' }],
    { oldShape: true }
  );
  const metaBefore = await fs.readFile(path.join(bookPath, '书目.json'), 'utf8');
  const store = makeStore(userData);
  const status = await store.ensure({ booksRoot });
  assert.equal(status.books, 1);
  const found = await store.search({ booksRoot, query: '青柠色' });
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].chapterName, '');
  // 建索引 / 搜索全程不改书目、不写书库
  assert.equal(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'), metaBefore);
  const meta = await readMeta(bookPath);
  assert.equal('schemaVersion' in meta, false);
});

test('正文索引：空书架 / 不存在的书架目录不崩', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  const store = makeStore(userData);
  const status = await store.ensure({ booksRoot });
  assert.equal(status.books, 0);
  assert.equal(status.chapters, 0);
  const found = await store.search({ booksRoot, query: '青柠色' });
  assert.equal(found.results.length, 0);
  const missing = makeStore(userData);
  const missingStatus = await missing.ensure({ booksRoot: path.join(base, '不存在') });
  assert.equal(missingStatus.error, 'ENOENT');
  assert.equal((await missing.search({ booksRoot: path.join(base, '不存在'), query: '青柠色' })).results.length, 0);
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

// ---------- P22-4：一章内全部命中（每章真命中数 + focus 聚焦一章） ----------
function nthIndex(text, needle, n) {
  let at = -1;
  let from = 0;
  for (let i = 0; i < n; i += 1) {
    at = text.indexOf(needle, from);
    if (at < 0) return -1;
    from = at + needle.length;
  }
  return at;
}

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

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

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

test('正文索引（P3）：放弃位图的书照常可搜、下次校验不重读正文（复用放弃结论）', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  const text = '青柠色的雨伞挂在门口，林婉儿站在旧车站的月台上。';
  const { bookPath } = await makeBook(booksRoot, '巨书', '巨书', [{ name: '第一章', text }]);

  const store = makeStore(userData, { bloomMaxItems: 8 });
  await store.ensure({ booksRoot });
  const entry = store.getIndex().books[0];
  assert.equal(entry.bloomOmitted, true, '超限的书要在索引里记住「主动放弃位图」');
  assert.equal(entry.bloom, '');
  assert.equal(entry.itemCount, 0);

  // 没有位图 = 本书永远进候选、逐章核对 → 搜索照样命中（只降速不漏报）
  const found = await store.search({ booksRoot, query: '青柠色' });
  assert.equal(found.results.length, 1);
  assert.equal(found.candidateBooks, 1);

  // 复用：下一轮校验不许重读正文（只认 bloom 不认 bloomOmitted 的话，每轮校验都会白读全书）
  const storage = require('../core/storage');
  const original = storage.loadChapterText;
  let reads = 0;
  storage.loadChapterText = async (...args) => {
    reads += 1;
    return original(...args);
  };
  try {
    const again = await search.buildBookEntry(bookPath, '巨书', entry, { bloomMaxItems: 8 });
    assert.equal(again.rebuilt, false);
    assert.equal(again.entry.bloomOmitted, true);
    assert.equal(reads, 0, '同一本书再次校验不许重读正文');
  } finally {
    storage.loadChapterText = original;
  }
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

test('正文索引（P-01）：窗口过期 / 根目录签名变化后仍会重新校验并重建', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  await makeBook(booksRoot, '书甲', '书甲', [{ name: '第一章', text: '青柠色的雨伞挂在门口。' }]);

  let clockMs = Date.parse('2026-11-11T20:00:00.000Z');
  const store = makeStore(userData, {
    validateIntervalMs: 2000,
    now: () => new Date(clockMs),
    stat: (target) => fs.stat(target)
  });
  const warm = await store.search({ booksRoot, query: '青柠色' });
  assert.equal(warm.results.length, 1);

  // ① 新书出现 → 根目录 mtime 变了：签名节流窗口外的下一次搜索就能发现（不必等 60 s）
  await makeBook(booksRoot, '书乙', '书乙', [{ name: '第一章', text: '灯芯在风里晃了一下。' }]);
  clockMs += 3000;
  const bySig = await store.search({ booksRoot, query: '灯芯' });
  assert.equal(bySig.results.length, 1, '根目录签名变化后必须重新校验，新书要能被搜到');

  // ② 60 s 窗口过期 → 重新校验（书内改正文不改书架根目录签名：窗口内看不到，过期后必须看到）
  await fs.writeFile(path.join(booksRoot, '书甲', '001-第一章.txt'), '青柠色的雨伞旁边多了一只铜锁扣。', 'utf8');
  clockMs += 30000; // 累计仍在 60 s 窗口内
  const inWindow = await store.search({ booksRoot, query: '铜锁扣' });
  assert.equal(inWindow.results.length, 0, '窗口内的搜索不该为每本书再 stat 一遍');
  clockMs += 40000; // 累计 70 s > 60 s
  const afterWindow = await store.search({ booksRoot, query: '铜锁扣' });
  assert.equal(afterWindow.results.length, 1, '窗口过期后必须重新校验，改过的正文要能被搜到');
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

// CTXT-A-03（低）：search() 从未消费 onProgress，调用点却传了它 —— 静默吞参误导维护者。
test('正文索引（CTXT-A-03）：main.js 不再给 search() 传无人消费的 onProgress，ensure 通道仍保留', async () => {
  const mainSrc = await fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8');
  const searchAt = mainSrc.indexOf('getSearchIndexStore().search({');
  assert.ok(searchAt > 0, '找不到 search:content 的调用点');
  const callBody = mainSrc.slice(searchAt, searchAt + 500);
  assert.equal(/onProgress/.test(callBody), false, 'search() 不支持 onProgress，调用点不许再传');
  const ensureAt = mainSrc.indexOf('getSearchIndexStore().ensure({');
  assert.ok(ensureAt > 0);
  assert.match(mainSrc.slice(ensureAt, ensureAt + 500), /onProgress: sendSearchProgress/, 'ensure 通道的进度上报保留');
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

test('正文索引（#33）：预算淘汰落盘后可读回、搜索仍命中被淘汰的书、重载后不每轮重建', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  await makeBook(booksRoot, '旧书', '旧书', [{ name: '章一', text: '旧书的青柠色雨伞挂在门口。' }]);
  await makeBook(booksRoot, '新书', '新书', [{ name: '章一', text: '新书的琥珀色路灯亮着。' }]);
  // lastModified = 书目 mtime 与全部章节 mtime 的最大值：把两本书的时间拉开，淘汰顺序才是确定的
  const touch = async (folder, when) => {
    const dir = path.join(booksRoot, folder);
    for (const name of await fs.readdir(dir)) {
      if (name.endsWith('.txt') || name === '书目.json') await fs.utimes(path.join(dir, name), when, when);
    }
  };
  await touch('旧书', new Date('2026-01-01T00:00:00Z'));
  await touch('新书', new Date('2026-02-01T00:00:00Z'));

  const filePath = path.join(userData, search.INDEX_FILE_NAME);
  const probe = makeStore(userData);
  await probe.ensure({ booksRoot });
  const built = JSON.parse(await fs.readFile(filePath, 'utf8'));
  // 预算只比整份索引少 1 字节：淘汰掉一本的位图就够，另一本必须保留位图（不是把两本都丢光）
  const cap = Buffer.byteLength(search.serializeIndex(built)) - 1;

  const store = makeStore(userData, { indexMaxBytes: cap });
  await store.ensure({ booksRoot });
  const raw = await fs.readFile(filePath, 'utf8');
  assert.ok(Buffer.byteLength(raw) <= cap, '写出的索引不超过预算');
  const saved = JSON.parse(raw);
  const savedOld = saved.books.find((book) => book.folder === '旧书');
  assert.equal(savedOld.bloomDropped, true, '最久没改的书被淘汰位图');
  assert.equal(saved.books.find((book) => book.folder === '新书').bloomDropped, false, '最新修改的书保留位图');
  assert.equal(savedOld.chapters.length, 1, '淘汰位图 ≠ 把整本书从索引里删掉');
  const budgetStatus = await store.status();
  assert.ok(budgetStatus.droppedBlooms >= 1, '状态里能看出被淘汰的书数');

  const found = await store.search({ booksRoot, query: '青柠色雨伞' });
  assert.equal(found.results.length >= 1, true, '位图被淘汰 ≠ 搜不到：被淘汰的书当候选、逐章核对');
  assert.equal(found.results[0].bookTitle, '旧书');

  // 新进程读回「已淘汰」的索引：搜索一致，且第二轮校验不再为同一本书白读正文重建位图
  const reopened = makeStore(userData, { indexMaxBytes: cap });
  const again = await reopened.search({ booksRoot, query: '琥珀色路灯' });
  assert.equal(again.results.length >= 1, true);
  const rerun = await reopened.ensure({ booksRoot });
  assert.equal(rerun.lastRun.rebuiltBooks, 0, '被淘汰且正文没变的书不许每轮重建位图');
  assert.ok(Buffer.byteLength(await fs.readFile(filePath, 'utf8')) <= cap, '重载后仍不超过预算');
});

// S8（审计修复 #45）：索引文件「先 stat 再按路径 readFile」的 TOCTOU —— 闸门与读盘必须绑在同一个句柄上。
test('S8（#45）：索引文件的大小闸门与读盘走同一个句柄（open → fstat → handle.readFile）', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'core', 'search-index.js'), 'utf8');
  const start = src.indexOf('function load()');
  assert.ok(start >= 0, '找不到 load()');
  const body = src.slice(start, src.indexOf('function ensure()', start));
  assert.ok(body.includes('fs.open(filePath, \'r\')'), '必须先 open 再 fstat');
  assert.ok(body.includes('handle.stat()'), '上限要用句柄上的 fstat 结论');
  assert.ok(body.includes("handle.readFile('utf8')"), '内容必须从同一个句柄读');
  assert.equal(body.includes('fs.readFile(filePath'), false, '不许再按路径 readFile（TOCTOU 窗口）');
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

test('E21（#46）：书架根读不了 → status / search 都透传错误码（不再静默空结果），且旧索引不被提前清空', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  await makeBook(booksRoot, '旧书', '旧书', [{ name: '旧车站', text: '雨还在下，他在旧车站等谁。' }]);
  const { normalizePath } = require('../core/path-utils');
  const store = makeStore(userData);
  const built = await store.ensure({ booksRoot, force: true });
  assert.equal(built.books, 1);
  assert.equal(built.error, '');
  assert.equal((await store.status()).error, '');

  // 换到一个不存在的书架根：错误码要能被看见
  const missingRoot = path.join(base, '没有这个书架');
  const failed = await store.ensure({ booksRoot: missingRoot });
  assert.equal(failed.error, 'ENOENT');
  assert.equal((await store.status()).error, 'ENOENT', 'status 也要带错误码（界面 / 排查能看出是书架路径问题）');
  const searched = await store.search({ booksRoot: missingRoot, query: '旧车站' });
  assert.equal(searched.error, 'ENOENT');
  assert.equal(searched.results.length, 0);

  // 确认新根可读之前不许清旧索引：内存里仍是旧根那一份（旧实现先清成空，回旧根要从头重建）
  assert.equal((await store.status()).root, normalizePath(booksRoot));
  assert.equal((await store.status()).books, 1);

  // 根恢复后搜索照常命中，错误码被成功校验清掉
  const back = await store.search({ booksRoot, query: '旧车站' });
  assert.equal(back.error, undefined);
  assert.ok(back.results.length >= 1);
  assert.equal((await store.status()).error, '');
});

test('E21（#46）：落盘只有一条串行链 —— doEnsure / load 不再绕过 flush 直接 await saveNow()', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'core', 'search-index.js'), 'utf8');
  // 串行链唯一入队口
  assert.ok(src.includes('function saveThrough()'), '缺 saveThrough');
  assert.ok(/savePromise = savePromise\.then\(saveNow, saveNow\)/.test(src));
  // 两个曾经绕开链的调用点 (load / doEnsure) 改为入队：只钉调用结构，不钉注释措辞 / 审计编号（TESTC-01）。
  const loadAt = src.indexOf('function load()');
  const statusAt = src.indexOf('function status()', loadAt);
  assert.ok(loadAt >= 0 && statusAt > loadAt, '要能定位 load() 的函数体');
  assert.ok(src.slice(loadAt, statusAt).includes('await saveThrough();'), 'load 不许绕过串行链直写');
  const ensureAt = src.indexOf('async function doEnsure');
  const ensureEnd = src.indexOf('function ensure(', ensureAt);
  assert.ok(ensureAt >= 0 && ensureEnd > ensureAt, '要能定位 doEnsure() 的函数体');
  assert.ok(src.slice(ensureAt, ensureEnd).includes('await saveThrough();'), 'doEnsure 不许绕过串行链直写');
  // 除串行链自身以外，任何地方都不许再直调 saveNow()
  const calls = src.match(/await saveNow\(\);/g) || [];
  assert.equal(calls.length, 0, `仍有 ${calls.length} 处直调 saveNow()`);
});

// 五-M27（CI-1）：markDirty 与在途 doEnsure 的竞态 —— 书 A 已被本趟 ensure 处理过之后才保存标脏，
// 旧实现 ensure 尾部无条件把复用窗口重开（lastEnsureAt=now），脏标记在复用路径不被消费：
// 60 s 窗口内搜索直接用保存前的位图，刚保存的内容静默漏报（违反「位图只会误报、不会漏报」）。
// 现在尾部只在脏集为空时重开窗口，复用判据也要求脏集为空 —— 标脏必校验。
test('五-M27（CI-1）：ensure 在途时才标脏的书，ensure 结束后搜索仍会先校验（不静默漏报）', async () => {
  const base = await mkTmp();
  // TESTC-06：双目录统一走 makeWorld
  const { userData, booksRoot } = await makeWorld(base);
  const { bookPath: bookAPath, meta: bookAMeta } = await makeBook(booksRoot, 'A书', 'A书', [
    { name: '第一章', text: '青柠色的雨伞挂在门口。' }
  ]);
  const { bookPath: bookBPath } = await makeBook(booksRoot, 'B书', 'B书', [
    { name: '第一章', text: '灰蓝色的窗帘。' }
  ]);

  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let triggerReached;
  const trigger = new Promise((resolve) => {
    triggerReached = resolve;
  });
  let heldOnce = false;
  // buildBookEntry 的 书目.json / 章节 stat 都直调 fs.stat：在 B 书的书目 stat 上把 ensure 按住，
  // 让「A 书已按保存前内容处理完」的时序成为确定事实。
  const realStat = fs.stat;
  fs.stat = async (target, ...rest) => {
    if (path.resolve(String(target)) === path.resolve(bookBPath, '书目.json') && !heldOnce) {
      heldOnce = true;
      triggerReached();
      await held;
    }
    return realStat(target, ...rest);
  };
  const store = makeStore(userData, { validateIntervalMs: 2000 }); // 非 0：搜索侧 60 s 复用窗口生效

  try {
    const running = store.ensure({ booksRoot });
    await trigger;
    // A 书处理完之后作者才保存：改正文 + markDirty（此时 ensure 还没跑完）
    await fs.writeFile(
      path.join(bookAPath, bookAMeta.chapters[0].file),
      '青柠色的雨伞挂在门口。灯芯在风里晃了一下。',
      'utf8'
    );
    store.markDirty(bookAPath);
    release();
    await running;
  } finally {
    fs.stat = realStat;
  }

  assert.equal(store.dirtyList().length, 1, 'A 书已被本趟 ensure 处理过，脏标记要留到下一趟');
  // 旧实现：ensure 尾部把复用窗口重开 → 这次搜索直接复用保存前的位图，0 命中
  const found = await store.search({ booksRoot, query: '灯芯' });
  assert.ok(found.results.length >= 1, '刚保存的内容不许在复用窗口里静默漏报');
  assert.equal(store.dirtyList().length, 0, '搜索前的那趟校验要消费掉脏标记');
});
