'use strict';
// WP19（补漏低批：S-N2 / S-N3=M-N2 / R-N3 / P-N3）：索引纵深与 bloom 口径。
//
// S-N2（本文件 §R1 / §R1b / §R2，WP19.1 单独一刀）：常规搜索的候选循环只信索引里的 book.path；
// focus 分支（search-index.js:1397-1402）已有 root 前缀校验，常规搜索没有。索引被外部改写指向
// 书架外（绝对外路径 / `..` 越界 / 兄弟目录 books2 / book===root）时，纵深不能押在「上一步一定
// 跑过重建」上。本文件把这条钉成契约 + 行为两条：
//   * §R1 源码契约：候选组装段必须在 candidates.push 之前按 index.root 算 rootPrefix（与 focus
//     逐字同口径，尾部分隔符拒绝兄弟前缀），越界条目跳过、计数并在结果对象里如实带出（不静默）。
//     —— 修复前红（记录见作业卡 §9）。
//   * §R1b 行为集成：真 tmp 书架 + 篡改索引（绝对外 / `..` 越界 / 兄弟前缀 / book===root /
//     含空格路径 / 读盘必失败条目的 IO 注入 / 保留 mtime 伪装）→ 常规搜索一次越界读盘都不许发生、
//     结果不含它们；focus 对同一本书同样拒绝（口径对齐）。当前 HEAD 上 ensure 重建会先剔除越界
//     条目，所以「不读外」这一半修复前就是绿的（红的是「结果带出计数」这一半，见作业卡 §9）。
//   * §R1c 行为窗口：索引窗口内复用内存索引（60s 不再 ensure）时把 book.path 改成书架外真实可读的
//     目录 → 常规搜索必须由候选循环自己跳过（skippedOutOfRoot=1）且一次盘都不读（§R1b 只覆盖
//     「ensure 重建兜底」那条路径，计数恒为 0，钉不到纵深本体）。
//   * §R2 保护：root 内合法多书的命中 / 顺序 / 片段 / 字段集合与修复前逐字段一致，且一个都不跳过。
//
// S-N3 / R-N3 / P-N3（§R3–§R5，WP19.2–19.4）：
//   * §R3 坏索引单本 bloom 塞超长 base64（1200 万字符）→ 清洗后按「位 → 字节 → base64 字符」换算
//     出的上限截断，解码回到 8 MB 量级；合法 8 MB 位图（恰好压在上限、含 = 填充）逐字不变、仍可解码。
//   * §R4 dropped / omitted 三态互斥：坏索引同时写两个标记 → 以 dropped 为准；dropBookBloom 清掉
//     omitted；只有 omitted 的书语义不变（无位图永远当候选）。
//   * §R5 未超预算的 flush 不白做第二份 withoutBloom 序列化（探针 getter 计数钉死）；超预算的淘汰
//     顺序 / 保留对象 / 字节上界与 eager 口径逐本一致。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const search = require('../core/search-index');
const storage = require('../core/storage');
const tmpCleanup = require('./tmp-cleanup');

const ROOT = path.join(__dirname, '..');
const read = (rel) => require('node:fs').readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

// TB-02：临时目录统一经 tests/tmp-cleanup.js 的 mkTmp（mkdtemp + 登记回收）。
const mkTmp = (prefix = 'cw-wp19-') => tmpCleanup.mkTmp(prefix);

function pad3(n) {
  return String(n).padStart(3, '0');
}

// 手写一本书（不经 storage.createBook），字段形状与现有索引用例一致。
async function makeBook(booksRoot, folder, title, texts) {
  const bookPath = path.join(booksRoot, folder);
  await fs.mkdir(bookPath, { recursive: true });
  const meta = {
    version: 1,
    schemaVersion: 1,
    id: `b_${folder}`,
    title,
    titleTemplate: '第{num}章',
    fileSeq: texts.length,
    chapters: [],
    createdAt: '2026-10-31T12:00:00.000Z'
  };
  for (let i = 0; i < texts.length; i += 1) {
    const file = `${pad3(i + 1)}-章${i + 1}.txt`;
    await fs.writeFile(path.join(bookPath, file), texts[i], 'utf8');
    meta.chapters.push({ id: `ch_${pad3(i + 1)}`, file, name: `章${i + 1}`, createdAt: meta.createdAt });
  }
  await fs.writeFile(path.join(bookPath, '书目.json'), JSON.stringify(meta, null, 2), 'utf8');
  return { bookPath, meta };
}

function makeStore(userData) {
  return search.createSearchStore({ userDataDir: userData, validateIntervalMs: 0 });
}

// 把一本书的书目 mtime 固定到给定毫秒（索引的 lastModified = 书目 mtime 与章节 mtime 的最大值）。
async function setMetaMtime(bookPath, ms) {
  const at = new Date(ms);
  await fs.utimes(path.join(bookPath, '书目.json'), at, at);
}

// 篡改索引里的书目条目（外部改写只需要 path / chapters 能过 sanitize，其余字段给默认值）。
function fakeEntry(bookPath, title, chapters) {
  return {
    path: bookPath,
    folder: title,
    id: `b_${title}`,
    title,
    metaMtimeMs: 0,
    lastModified: Date.now() + 3600000,
    bloom: '',
    bloomBits: 0,
    bloomCrc: 0,
    itemCount: 0,
    bloomOmitted: false,
    bloomDropped: false,
    chapters: chapters.map((file, i) => ({
      id: `ch_${pad3(i + 1)}`,
      name: `章${i + 1}`,
      file,
      index: i,
      mtimeMs: 0,
      size: 0,
      contentHash: '',
      chars: 20
    }))
  };
}

// ---------------------------------------------------------------- S-N2（WP19.1）

test('S-N2/§R1：常规搜索候选组装与 focus 同一套 root 纵深校验（源码契约，修复前红）', () => {
  const src = read('core/search-index.js');
  // 基准（不动）：focus 分支的既有口径 —— resolve + 小写，尾部补分隔符防「兄弟前缀」（books2）。
  assert.match(src, /const rootKey = normalizePath\(index\.root\)/, '前提：focus 分支的 root 归一仍在');
  assert.match(src, /rootKey\.endsWith\(path\.sep\) \? rootKey : rootKey \+ path\.sep/, '前提：focus 的 rootPrefix 口径仍在');

  const start = src.indexOf('const candidates = [];');
  assert.ok(start > 0, '找不到常规搜索的候选组装段');
  // 取候选段前后各一段：修复前 focus 分支的 root 归一离这里有 2476 字符（不会被误当成本段），
  // 修复后守卫就在 candidates 上方数行内（313 字符）。
  const block = src.slice(Math.max(0, start - 1200), start + 3200);

  // ① 候选段必须先算 root 前缀，且口径与 focus 逐字相同。
  assert.match(block, /const rootKey = normalizePath\(index\.root\)/, '常规搜索候选段没有 root 归一（只信索引路径）');
  assert.match(
    block,
    /rootKey\.endsWith\(path\.sep\) \? rootKey : rootKey \+ path\.sep/,
    'rootPrefix 必须与 focus 同口径（尾部分隔符拒绝 root2 / books2 这类兄弟前缀）'
  );

  // ② 守卫必须发生在 candidates.push 之前：先判越界，再谈位图 / 候选。
  const guardAt = block.indexOf('rootKey.endsWith(path.sep)');
  const pushAt = block.indexOf('candidates.push');
  assert.ok(pushAt > 0, '前提：候选段仍有 candidates.push');
  assert.ok(guardAt > 0 && guardAt < pushAt, 'root 校验必须在 candidates.push 之前（越界书不进候选、不读盘）');

  // ③ 越界书要跳过并计数，结果对象如实带出（静默跳过 = 作者不知道索引被动过）。
  const self = block.slice(guardAt);
  assert.match(self, /skippedOutOfRoot \+= 1/, '越界书要计数');
  assert.equal(src.split('skippedOutOfRoot').length - 1, 3, '三处：计数声明 / 越界自增 / 结果对象带出');
});

test('S-N2/§R1b：索引被外部改写指向书架外 → 常规搜索不读盘、不返回；focus 同书同样拒绝', async () => {
  const base = await mkTmp('cw-wp19-n2-');
  const userData = path.join(base, 'userdata');
  const booksRoot = path.join(base, 'books');
  await fs.mkdir(userData);
  await fs.mkdir(booksRoot);
  const inside = await makeBook(booksRoot, '书001', '书1', ['书里的正文：青柠色的雨伞挂在门口。']);
  // 书架外的真实可读目录：绝对外路径（含空格）与 `..` 相对越界（归一化后在 root 外）。
  const outside = await makeBook(path.join(base, '外部 书架'), '秘密书', '外部书', ['外面的秘密：青柠色的钥匙在抽屉里。']);
  const escape = path.join(booksRoot, '书001', '..', '..', '外部 书架', '秘密书');
  // root 兄弟前缀（books2 → 不能因为前缀字符串相同就放行）。
  const sibling = await makeBook(path.join(base, 'books2'), '兄弟书', '兄弟书', ['兄弟的秘密：青柠色的杯子在桌上。']);
  // book===root：书架根目录本身放一个真实可读的 txt（旧口径不校验就会当「书」去读）。
  await fs.writeFile(path.join(booksRoot, '直排章.txt'), '根目录直排：青柠色的灯。', 'utf8');
  // IO 失败注入：越界条目的章节文件是个目录 → 真去读一定 EISDIR（去试本身就是错）。
  const badRead = path.join(base, '坏读书架', '坏书');
  await fs.mkdir(path.join(badRead, '001-章1.txt'), { recursive: true });
  // 保留 mtime 伪装：把外面那本书的章节 mtime 压回 2020（攻击者「保留 mtime 改写」手法）。
  const outsideChapter = path.join(outside.bookPath, outside.meta.chapters[0].file);
  await fs.utimes(outsideChapter, new Date('2020-01-02T03:04:05Z'), new Date('2020-01-02T03:04:05Z'));

  // 先建一份合法索引，再手改成「越界条目 + 合法条目」的坏索引（外部改写 / 同步盘冲突的形态）。
  const indexPath = path.join(userData, search.INDEX_FILE_NAME);
  const warm = makeStore(userData);
  await warm.ensure({ booksRoot });
  await warm.flush();
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  assert.equal(index.books.length, 1, '前提：真实书架里只有一本合法的书');
  index.books.push(fakeEntry(outside.bookPath, '外部书', [outside.meta.chapters[0].file]));
  index.books.push(fakeEntry(escape, '越界书', [outside.meta.chapters[0].file]));
  index.books.push(fakeEntry(sibling.bookPath, '兄弟书', [sibling.meta.chapters[0].file]));
  index.books.push(fakeEntry(booksRoot, '根目录书', ['直排章.txt']));
  index.books.push(fakeEntry(badRead, '坏读书', ['001-章1.txt']));
  // 撞名：两条条目指向同一个外部目录（不同标题）。
  index.books.push(fakeEntry(outside.bookPath, '外部书（副本）', [outside.meta.chapters[0].file]));
  await fs.writeFile(indexPath, JSON.stringify(index), 'utf8');

  const original = storage.loadChapterText;
  const readCalls = [];
  storage.loadChapterText = async (bookPath, file, options) => {
    readCalls.push({ bookPath, file });
    return original(bookPath, file, options);
  };
  try {
    const store = makeStore(userData);
    const found = await store.search({ booksRoot, query: '青柠', timeBudgetMs: 5000 });

    // 行为：spy 记录的是实际读盘入参 —— 一次越界读盘都不许发生（保证不依赖 storage 的二次校验）。
    const rootKey = path.resolve(booksRoot).toLowerCase();
    const rootPrefix = `${rootKey}${path.sep}`;
    const outsideReads = readCalls.filter((call) => {
      const key = path.resolve(call.bookPath).toLowerCase();
      return key !== rootKey && !key.startsWith(rootPrefix);
    });
    assert.deepEqual(outsideReads, [], `常规搜索读了书架外路径：${JSON.stringify(outsideReads)}`);

    // 结果：只允许书架内的那本书；越界条目一条都不许冒出来。
    assert.ok(found.results.length > 0, '合法书必须照常命中');
    assert.deepEqual(
      Array.from(new Set(found.results.map((row) => path.resolve(row.bookPath).toLowerCase()))),
      [path.resolve(inside.bookPath).toLowerCase()],
      '结果只能来自书架内的书'
    );
    assert.deepEqual(Array.from(new Set(found.results.map((row) => row.bookTitle))), ['书1']);

    // 静默性：越界条目被跳过这件事要在结果里如实带出计数，不许蒸发。
    assert.ok(Number.isInteger(found.skippedOutOfRoot), '结果对象要带出越界跳过计数（不静默）');
    // 当前 ensure 重建会先把越界条目剔除（探针证据见作业卡 §9），所以这一趟没有书需要候选循环跳过；
    // 计数必须是 0 而不是把合法书误伤成「越界」。
    assert.equal(found.skippedOutOfRoot, 0, '合法书不误伤：这一趟没有需要候选循环跳过的越界条目');

    // 口径对齐：focus 对同一本外部书早就拒了（本刀只把常规搜索拉齐，不动 focus 行为）。
    const focused = await store.search({
      booksRoot,
      query: '青柠',
      focus: { bookPath: outside.bookPath, chapterFile: outside.meta.chapters[0].file },
      timeBudgetMs: 5000
    });
    assert.equal(focused.focusError, '聚焦的书籍不在书架索引里', 'focus 对书架外的书必须拒绝（基准口径）');
    assert.deepEqual(focused.results, []);
  } finally {
    storage.loadChapterText = original;
  }
});

test('S-N2/§R1c：搜索窗口复用内存索引时，被篡改的越界 book.path 在候选循环被跳过且绝不读盘', async () => {
  // §R1b 走的是「坏索引落盘 → 新 store → ensure 重建」：重建会把越界条目先剔除，候选循环这一趟
  // 没有需要跳过的书（所以只能钉 skippedOutOfRoot=0）。本用例走另一条真实窗口：索引已就绪 +
  // 同一书架根 + 60s 搜索窗口内不再 ensure（search-index.js:1347-1358），此时内存索引被外部
  // 改写（同步盘冲突 / 索引被手改）就必须由候选循环自己兜住 —— 这是 S-N2 的纵深本体。
  const base = await mkTmp('cw-wp19-n2-window-');
  const userData = path.join(base, 'userdata');
  const booksRoot = path.join(base, 'books');
  const outsideDir = path.join(base, '外部 书架', '越界书');
  await fs.mkdir(userData);
  await fs.mkdir(booksRoot);
  await fs.mkdir(outsideDir, { recursive: true });
  const inside = await makeBook(booksRoot, '书001', '书1', ['书里的正文：青柠色的雨伞挂在门口。']);
  // 书架外放一份真实可读的章节文件：越界条目哪怕「文件真实存在」也不许读。
  await fs.copyFile(path.join(inside.bookPath, '001-章1.txt'), path.join(outsideDir, '001-章1.txt'));

  const clockMs = Date.parse('2026-11-18T10:00:00.000Z');
  const store = search.createSearchStore({ userDataDir: userData, now: () => new Date(clockMs) });
  await store.ensure({ booksRoot });
  const live = store.getIndex();
  assert.equal(live.books.length, 1, '前提：内存索引里只有一本合法的书');
  live.books[0].path = outsideDir; // 外部改写：book.path 指向书架外

  const original = storage.loadChapterText;
  const readCalls = [];
  storage.loadChapterText = async (bookPath, file, options) => {
    readCalls.push({ bookPath, file });
    return original(bookPath, file, options);
  };
  try {
    const found = await store.search({ booksRoot, query: '青柠色', timeBudgetMs: 5000 });
    assert.equal(found.skippedOutOfRoot, 1, '窗口内复用内存索引也必须跳过越界书并计数（不静默）');
    assert.deepEqual(readCalls, [], '越界书一次盘都不许读（文件真实存在也不许碰）');
    assert.equal(found.results.length, 0, '越界书不许出现在结果里');
  } finally {
    storage.loadChapterText = original;
  }
});

test('S-N2/§R2：root 内合法多书搜索逐字段不回退（顺序 / 命中 / 片段 / 字段集合）', async () => {
  const base = await mkTmp('cw-wp19-n2-ok-');
  const userData = path.join(base, 'userdata');
  const booksRoot = path.join(base, 'books');
  await fs.mkdir(userData);
  await fs.mkdir(booksRoot);
  const text1 = '第1本：青柠色的雨伞挂在门口。';
  const text2 = '第2本：青柠色的杯子在桌上，青柠很香。';
  const first = await makeBook(booksRoot, '书001', '书1', [text1]);
  const second = await makeBook(booksRoot, '书002', '书2', [text2]);
  // lastModified 递增：书2 更新 → 先扫书2（既有「从新到旧」顺序）。
  const future = Date.now() + 60000;
  await setMetaMtime(first.bookPath, future + 1000);
  await setMetaMtime(second.bookPath, future + 2000);

  const store = makeStore(userData);
  const found = await store.search({ booksRoot, query: '青柠', timeBudgetMs: 5000 });

  const expectedSnippets = [
    // 书2 第一处：at=4
    { before: '第2本：', match: '青柠', after: '色的杯子在桌上，青柠很香。', cutBefore: false, cutAfter: false },
    // 书2 第二处：at=14
    { before: '第2本：青柠色的杯子在桌上，', match: '青柠', after: '很香。', cutBefore: false, cutAfter: false },
    // 书1：at=4
    { before: '第1本：', match: '青柠', after: '色的雨伞挂在门口。', cutBefore: false, cutAfter: false }
  ];
  const expected = [
    {
      bookPath: second.bookPath,
      bookTitle: '书2',
      folder: '书002',
      chapterId: 'ch_001',
      chapterIndex: 0,
      chapterName: '章1',
      chapterFile: '001-章1.txt',
      matchIndex: text2.indexOf('青柠'),
      matchLength: 2,
      snippet: expectedSnippets[0],
      chapterMatchCount: 2,
      chapterCountCapped: false
    },
    {
      bookPath: second.bookPath,
      bookTitle: '书2',
      folder: '书002',
      chapterId: 'ch_001',
      chapterIndex: 0,
      chapterName: '章1',
      chapterFile: '001-章1.txt',
      matchIndex: text2.indexOf('青柠', text2.indexOf('青柠') + 2),
      matchLength: 2,
      snippet: expectedSnippets[1],
      chapterMatchCount: 2,
      chapterCountCapped: false
    },
    {
      bookPath: first.bookPath,
      bookTitle: '书1',
      folder: '书001',
      chapterId: 'ch_001',
      chapterIndex: 0,
      chapterName: '章1',
      chapterFile: '001-章1.txt',
      matchIndex: text1.indexOf('青柠'),
      matchLength: 2,
      snippet: expectedSnippets[2],
      chapterMatchCount: 1,
      chapterCountCapped: false
    }
  ];
  // 逐字段一致：行对象字段集合固定（新增字段只能在顶层结果，不许塞进行里）。
  assert.deepEqual(Object.keys(found.results[0]), [
    'bookPath',
    'bookTitle',
    'folder',
    'chapterId',
    'chapterIndex',
    'chapterName',
    'chapterFile',
    'matchIndex',
    'matchLength',
    'snippet',
    'chapterMatchCount',
    'chapterCountCapped'
  ]);
  assert.deepEqual(found.results, expected, '合法索引的命中 / 顺序 / 片段必须与修复前逐字段一致');
  assert.equal(found.skippedOutOfRoot, 0, '合法索引一个都不许跳过（新增计数不得误伤）');
  assert.equal(found.candidateBooks, 2);
  assert.equal(found.scannedBooks, 2);
  assert.equal(found.scannedChapters, 2);
  assert.equal(found.skippedChapters, 0);
  assert.equal(found.matchedChapters, 2);
  assert.equal(found.totalMatches, 3);
  assert.equal(found.truncated, false);
});

// ---------------------------------------------------------------- S-N3（WP19.2）

test('S-N3/§R3：坏索引超长 bloom 按「位→字节→base64 字符」截断（≤8MB），合法 8MB 位图逐字不变', () => {
  // 与实现独立算一遍：位上限 8 MB → base64 字符上限 = ceil(bits / 8 / 3) * 4。
  // 取 ceil 是必须的：合法 8 MB 位图（8,388,608 字节，尾部一个 = 填充）编码后**恰好**是这个字符数，
  // 用 floor 会把合法位图切掉 4 个字符。代价是「无填充的坏串」最多多解 1 字节（≤8 MB + 1），
  // decodeBloom 的「bits === 字节数 × 8」校验会拒掉这种错位（不会当合法位图用）。
  const MAX_BITS = 64 * 1024 * 1024;
  const MAX_CHARS = Math.ceil(MAX_BITS / 8 / 3) * 4;

  const mkIndex = (bloom, bloomBits, bloomCrc) => ({
    version: search.INDEX_VERSION,
    root: 'C:\\books',
    builtAt: 'x',
    updatedAt: 'y',
    books: [
      {
        path: 'C:\\books\\坏书',
        folder: '坏书',
        id: 'b_bad',
        title: '坏书',
        metaMtimeMs: 0,
        lastModified: 0,
        bloom,
        bloomBits,
        bloomCrc,
        itemCount: 1,
        bloomOmitted: false,
        bloomDropped: false,
        chapters: []
      }
    ]
  });

  // ① 坏索引（外部改写 / 同步盘冲突）：单本塞 1200 万 base64 字符（> 字符上限，但远小于旧的
  //    64M 字符闸门）→ 清洗后必须按字符上限截断，解码尺寸回到 8 MB 量级（修复前放行 1200 万字符）。
  const oversized = 'A'.repeat(12000000);
  assert.ok(oversized.length > MAX_CHARS, '前提：坏串确实超过字符上限');
  const bad = search.parseIndex(JSON.stringify(mkIndex(oversized, MAX_BITS, 0)));
  assert.ok(bad && bad.books.length === 1, '前提：坏索引仍能过版本 / 路径清洗');
  const kept = bad.books[0].bloom;
  assert.equal(kept.length, MAX_CHARS, `坏位图必须截到 base64 字符上限（实际 ${kept.length}）`);
  const keptBytes = Buffer.from(kept, 'base64').length;
  assert.ok(keptBytes <= MAX_BITS / 8 + 1, `截断后解码不许再是 ≈48MB 量级（实际 ${keptBytes} 字节）`);

  // ② 保护：合法 8 MB 位图（真实位图上限）编码后逐字保留、仍能解码 —— 收紧上限不许误伤上限本身。
  const legalBuffer = Buffer.alloc(8 * 1024 * 1024, 0xff);
  const legal = legalBuffer.toString('base64');
  assert.equal(legal.length, MAX_CHARS, '前提：8 MB 位图的 base64 恰好是字符上限（含 = 填充）');
  const okIndex = search.parseIndex(
    JSON.stringify(mkIndex(legal, MAX_BITS, search.crc32(legalBuffer)))
  );
  assert.equal(okIndex.books[0].bloom, legal, '合法 8 MB 位图必须逐字不变');
  const decoded = search.decodeBloom(
    okIndex.books[0].bloom,
    okIndex.books[0].bloomBits,
    okIndex.books[0].bloomCrc
  );
  assert.ok(decoded && decoded.length === 8 * 1024 * 1024, '合法 8 MB 位图仍可正常解码');
});

// ---------------------------------------------------------------- R-N3（WP19.3）

test('R-N3/§R4：dropped 与 omitted 三态互斥（坏索引不许并存，淘汰主导）', () => {
  const rawBook = (patch) => ({
    path: 'C:\\books\\书',
    folder: '书',
    id: 'b_1',
    title: '书',
    metaMtimeMs: 0,
    lastModified: 0,
    bloom: 'QUJD',
    bloomBits: 24,
    bloomCrc: 0,
    itemCount: 5,
    bloomOmitted: false,
    bloomDropped: false,
    chapters: [],
    ...patch
  });
  const rawIndex = (books) => ({
    version: search.INDEX_VERSION,
    root: 'C:\\books',
    builtAt: '',
    updatedAt: '',
    books
  });

  // ① 清洗：坏索引同时写 bloomDropped:true + bloomOmitted:true + 非空 bloom → 收口成「dropped 主导」。
  const parsed = search.parseIndex(
    JSON.stringify(rawIndex([rawBook({ bloomDropped: true, bloomOmitted: true })]))
  );
  assert.ok(parsed && parsed.books.length === 1);
  const book = parsed.books[0];
  assert.equal(book.bloom, '', 'dropped 书的位图必须清空');
  assert.equal(book.bloomBits, 0);
  assert.equal(book.itemCount, 0);
  assert.equal(book.bloomDropped, true);
  assert.equal(book.bloomOmitted, false, 'dropped 与 omitted 不许并存（dropped 主导）');

  // ② 预算淘汰路径（dropBookBloom）：被淘汰的书记住 dropped，同时清掉 omitted。
  const dropped = search.enforceIndexBudget(
    rawIndex([rawBook({ bloomOmitted: true })]),
    1
  );
  assert.equal(dropped.dropped, 1, '前提：预算 1 字节 → 这本的位图必被淘汰');
  const out = dropped.index.books[0];
  assert.equal(out.bloom, '');
  assert.equal(out.bloomDropped, true);
  assert.equal(out.bloomOmitted, false, 'dropBookBloom 必须同时清掉 bloomOmitted');

  // ③ 保护：只有 omitted（没有 dropped）的书照旧 omitted=true —— 「无位图永远当候选」语义不变。
  const omitted = search.parseIndex(
    JSON.stringify(rawIndex([rawBook({ bloomOmitted: true, bloom: '', bloomBits: 0, bloomCrc: -1 })]))
  );
  assert.equal(omitted.books[0].bloomOmitted, true);
  assert.equal(omitted.books[0].bloomDropped, false);
});

// ---------------------------------------------------------------- P-N3（WP19.4）

test('P-N3/§R5：未超预算不白做第二份序列化（懒算 withoutBloom）；超预算淘汰顺序与 eager 口径一致', () => {
  const bloomA = Buffer.alloc(4096, 1).toString('base64');
  const bloomB = Buffer.alloc(4096, 2).toString('base64');
  const mkBook = (folder, lastModified, bloom) => ({
    path: `C:\\books\\${folder}`,
    folder,
    id: `b_${folder}`,
    title: folder,
    metaMtimeMs: lastModified,
    lastModified,
    bloom,
    bloomBits: bloom ? 16384 : 0,
    bloomCrc: bloom ? 7 : 0,
    itemCount: bloom ? 99 : 0,
    bloomOmitted: false,
    bloomDropped: false,
    chapters: [{ id: 'ch_001', name: '章', file: '001.txt', index: 0, mtimeMs: 1, size: 2, contentHash: 'abc', chars: 3 }]
  });
  // 探针 getter：每次被「展开 / 逐属性读取」都计数。withBloom 序列化读 1 次；
  // 旧实现为了算 withoutBloom 还要对每本有位图的书再 spread 一次（再读 1 次）。
  let probeReads = 0;
  const withProbe = (book) => {
    Object.defineProperty(book, 'probe', {
      enumerable: true,
      configurable: true,
      get() {
        probeReads += 1;
        return 'p';
      }
    });
    return book;
  };
  const index = {
    version: search.INDEX_VERSION,
    root: 'C:\\books',
    builtAt: 'x',
    updatedAt: 'y',
    books: [withProbe(mkBook('新书', 300, bloomA)), withProbe(mkBook('旧书', 100, bloomB))]
  };
  const fullBytes = Buffer.byteLength(search.serializeIndex(index));
  assert.ok(probeReads > 0, '前提：探针 getter 能观察到序列化读取');

  // ① 未超预算：只许算 withBloom（每本一次）；修复前会给每本有位图的书白算一份 withoutBloom。
  probeReads = 0;
  const under = search.enforceIndexBudget(index, fullBytes + 1000);
  assert.equal(under.dropped, 0);
  assert.equal(probeReads, index.books.length, `未超预算只许序列化一份（观察到 ${probeReads} 次，eager 版应为 ${index.books.length * 2} 次）`);

  // ② 超预算：从最旧（lastModified 小）开始淘汰；只差 1 字节 → 丢最旧一本的位图就够。
  //    淘汰本数 / 保留对象 / 字节上界必须与 eager 版逐本一致（懒算只省未超预算的那份）。
  const capped = search.enforceIndexBudget(index, fullBytes - 1);
  assert.equal(capped.dropped, 1, '预算只少 1 字节：丢掉最旧一本的位图就够');
  const dropped = capped.index.books.find((item) => item.folder === '旧书');
  assert.equal(dropped.bloomDropped, true, '最久没改的书被淘汰位图');
  assert.equal(dropped.bloom, '');
  const kept = capped.index.books.find((item) => item.folder === '新书');
  assert.equal(kept.bloom, bloomA, '最新修改的书保留位图（淘汰顺序不许变）');
  assert.equal(kept.bloomDropped, false);
  assert.ok(Buffer.byteLength(search.serializeIndex(capped.index)) <= fullBytes - 1, '淘汰后回到预算内');
  assert.equal(index.books[1].bloom, bloomB, '纯函数不改入参');
});