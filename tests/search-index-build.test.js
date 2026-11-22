// 搜索索引测试（T9 / 第 10 轮按性质拆分）：建索引 / 校验 / 重建 / 索引文件落盘。
// 本文件覆盖：内容指纹（E4 同大小改写 / E5 位图 CRC）→ 索引落 userData、只存指纹与位图 →
// 索引文件超限（INDEX_TOO_LARGE）/ 坏 JSON / 版本不对 → 重建判定只看正文指纹（章名 / 序号不算）→
// 整本位图按批累积 → 外部改 txt / 删章 / 删书 / 换书架根 → markDirty → 写盘失败 → 旧书目形状 →
// 空书架 → 放弃位图的书下次校验复用结论 → 校验窗口过期 → #33 预算淘汰落盘 → 书架根读不了要透传错误码 →
// 五-M27 在途标脏不被复用窗口吞掉。
//
// 来源：原 tests/search-index.test.js（1,678 行 / 51 例）按性质拆成夹具 + 四个文件，**只搬家不改断言**——
// 用例标题与断言逐字保留，共用夹具收进 tests/search-index-fixtures.js（T9 纪律，见 tests/README.md）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const search = require('../core/search-index');
const { mkTmp, makeBook, readMeta, writeMeta, makeStore, makeWorld, exists } = require('./search-index-fixtures');

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
