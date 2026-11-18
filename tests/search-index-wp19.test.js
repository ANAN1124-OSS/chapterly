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
//   * §R2 保护：root 内合法多书的命中 / 顺序 / 片段 / 字段集合与修复前逐字段一致，且一个都不跳过。
//
// S-N3 / R-N3 / P-N3（§R3–§R5）在 WP19.2–19.4 往本文件续写，本刀不占用编号。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const search = require('../core/search-index');
const storage = require('../core/storage');
const tmpCleanup = require('./tmp-cleanup');

const ROOT = path.join(__dirname, '..');
const read = (rel) => require('node:fs').readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

async function mkTmp(prefix = 'cw-wp19-') {
  return tmpCleanup.track(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

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