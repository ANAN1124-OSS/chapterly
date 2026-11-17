'use strict';
// WP10（审计 E-N5 / P-N1）：索引候选上限与「无位图书」对齐 + 深度校验内容哈希按书降频。
//
// 两条发现的口径（审计 2026-11-17，中 #9 / 中 #10）：
//   E-N5：预算淘汰（bloomDropped）/ 建图放弃（bloomOmitted）/ 位图坏掉的书**没有位图**，
//         本来就只能逐章核对；旧实现把它们和「有位图书」一起按 lastModified 排序后 slice(0,60)，
//         被淘汰书多时靠后的书根本不扫——与「只降速、不漏结果」的注释承诺冲突。
//   P-N1：深度校验（回书架 / 启动，约 10 s 节流）逐章 open + 读首尾 4 KB 算内容指纹；
//         3000 章 ≈ 3000 open + ≤24 MB 读。mtime/size 都没变时这些读盘每一趟都在白付。
//         改法：stat 仍逐章（mtime/size 变化立刻发现），内容哈希按书低频复核（默认 5 分钟，
//         按路径稳定抖动散开）。同大小 + 保留 mtime 的改写（E4 威胁）最迟在复核时发现。
//
// 本文件全部断言都先于实现写就（真红记录见作业卡 §9.1），实现后不许改断言口径。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const search = require('../core/search-index');
const tmpCleanup = require('./tmp-cleanup');

const ROOT = path.join(__dirname, '..');
const read = (rel) => require('node:fs').readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

async function mkTmp(prefix = 'cw-wp10-') {
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

function makeStore(userData, options = {}) {
  return search.createSearchStore({ userDataDir: userData, validateIntervalMs: 0, ...options });
}

// 把一本书的书目 mtime 固定到给定毫秒（索引的 lastModified = 书目 mtime 与章节 mtime 的最大值）
async function setMetaMtime(bookPath, ms) {
  const at = new Date(ms);
  await fs.utimes(path.join(bookPath, '书目.json'), at, at);
}

// ---------------------------------------------------------------- E-N5（中 #9）

test('E-N5/§R1：无位图书（预算淘汰）不受 60 本候选上限截断，未扫本数如实回报', async () => {
  const base = await mkTmp();
  const userData = path.join(base, 'userdata');
  const booksRoot = path.join(base, 'books');
  await fs.mkdir(userData);
  await fs.mkdir(booksRoot);
  // 10 本书都含同一个常见双字「青柠」；书目 mtime 递增（书 10 最新、书 1 最旧）。
  const future = Date.now() + 60000;
  const books = [];
  for (let i = 1; i <= 10; i += 1) {
    const book = await makeBook(booksRoot, `书${pad3(i)}`, `书${i}`, [
      `第${i}本的正文：青柠色的雨伞挂在门口。`,
      `第${i}本的第二章：雨还在下。`
    ]);
    await setMetaMtime(book.bookPath, future + i * 1000);
    books.push(book);
  }
  const indexPath = path.join(userData, search.INDEX_FILE_NAME);
  const warm = makeStore(userData);
  await warm.ensure({ booksRoot });
  await warm.flush();

  // 模拟索引总量预算淘汰：最旧的 6 本丢掉位图（章节指纹保留 = 真实 dropBookBloom 的形状）
  const index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  assert.equal(index.books.length, 10);
  const oldestSix = new Set(books.slice(0, 6).map((_, i) => `书${pad3(i + 1)}`));
  for (const entry of index.books) {
    if (!oldestSix.has(entry.folder)) continue;
    entry.bloom = '';
    entry.bloomBits = 0;
    entry.bloomCrc = 0;
    entry.itemCount = 0;
    entry.bloomDropped = true;
  }
  await fs.writeFile(indexPath, JSON.stringify(index), 'utf8');

  const store = makeStore(userData);
  const found = await store.search({ booksRoot, query: '青柠', maxBooks: 2, timeBudgetMs: 5000 });
  assert.equal(found.candidateBooks, 10, '前提：10 本都是候选（6 本无位 + 4 本命中的）');
  // 2 本有位（最新）+ 6 本无位（最旧）全部要扫；剩下 2 本「有位但超过上限」才是没扫的。
  assert.equal(found.scannedBooks, 8, `无位图书必须追加扫描：实际 ${found.scannedBooks} 本`);
  assert.equal(found.unscannedBooks, 2, '被上限挡住又有位图的书数要如实回报');
  assert.equal(found.truncated, true, '确实没扫完 → truncated 必须为 true');
  const titles = new Set(found.results.map((row) => row.bookTitle));
  for (let i = 1; i <= 6; i += 1) {
    assert.ok(titles.has(`书${i}`), `无位图书「书${i}」必须被逐章核对到（不许被上限静默丢掉）`);
  }
});

test('E-N5/§R2：候选组装代码与常量口径一致（无位图书追加，不再一刀切）', () => {
  assert.equal(search.MAX_CANDIDATE_BOOKS, 60, '有位图书的候选上限仍是 60（既有产品口径不变）');
  const src = read('core/search-index.js');
  assert.match(src, /无位图书/, '注释要写明「无位图书」的处理口径');
  assert.match(src, /unscannedBooks/, '结果要带未扫本数（界面据此明说部分旧书未扫描）');
  assert.match(src, /bloomless/, '候选要区分「有没有位图」');
  // 候选组装处必须真的把无位候选追加进 scanTarget，而不是只改注释
  const start = src.indexOf('const candidates = [];');
  assert.ok(start > 0, '找不到候选组装段');
  const block = src.slice(start, start + 2200);
  assert.match(block, /bloomless/, '候选组装段要标记无位图书');
  assert.match(block, /scanTarget\.push/, '无位图书要追加进扫描目标（不受 maxBooks 截断）');
  assert.match(src, /scanTarget = candidates\.slice\(0, maxBooks\)/);
});

// ---------------------------------------------------------------- P-N1（中 #10）

test('P-N1/§R3：mtime/size 未变时第二次深度校验不再重复算内容哈希（零 open）', async () => {
  const base = await mkTmp();
  const userData = path.join(base, 'userdata');
  const booksRoot = path.join(base, 'books');
  await fs.mkdir(userData);
  await fs.mkdir(booksRoot);
  const texts = Array.from({ length: 40 }, (_, i) => `第${i + 1}章：雨落在青柠色的伞上。`);
  await makeBook(booksRoot, '薄书', '薄书', texts);

  let clockMs = Date.parse('2026-11-17T20:00:00.000Z');
  const hashCalls = [];
  const store = makeStore(userData, {
    hashRecheckIntervalMs: 300000,
    now: () => new Date(clockMs),
    contentHashOf: async (filePath, size) => {
      hashCalls.push(path.basename(filePath));
      return search.chapterContentHashOf(filePath, size);
    }
  });
  const first = await store.ensure({ booksRoot });
  assert.equal(first.lastRun.addedBooks, 1, '首趟是「新增一本」');
  assert.equal(hashCalls.length, 40, '建索引时 40 章各算一次内容指纹');

  clockMs += 1000; // 1 秒后（远未到 5 分钟复核期）
  hashCalls.length = 0;
  const second = await store.ensure({ booksRoot });
  assert.equal(hashCalls.length, 0, `信封（mtime+size）没变时不许重复 open 算哈希：实际 ${hashCalls.length} 次`);
  assert.equal(second.lastRun.rebuiltBooks, 0, '没变化就不重建');
  assert.equal(second.lastRun.reusedBooks, 1);
});

test('P-N1/§R4：低频复核到期仍能抓住「同大小 + 保留 mtime」的改写（E4 不退化）', async () => {
  const base = await mkTmp();
  const userData = path.join(base, 'userdata');
  const booksRoot = path.join(base, 'books');
  await fs.mkdir(userData);
  await fs.mkdir(booksRoot);
  const { bookPath, meta } = await makeBook(booksRoot, '指纹书', '指纹书', ['旧车站的雨伞是灰色的。']);
  const chapterPath = path.join(bookPath, meta.chapters[0].file);
  const fixedAt = new Date(Math.floor((Date.now() - 60000) / 1000) * 1000);
  await fs.utimes(chapterPath, fixedAt, fixedAt);
  const before = await fs.stat(chapterPath);

  let clockMs = Date.parse('2026-11-17T20:00:00.000Z');
  const hashCalls = [];
  const store = makeStore(userData, {
    hashRecheckIntervalMs: 300000,
    now: () => new Date(clockMs),
    contentHashOf: async (filePath, size) => {
      hashCalls.push(path.basename(filePath));
      return search.chapterContentHashOf(filePath, size);
    }
  });
  await store.ensure({ booksRoot });
  assert.equal(hashCalls.length, 1);
  const firstHash = store.getIndex().books[0].chapters[0].contentHash;
  assert.match(firstHash, /^\d+:[0-9a-f]{8}:[0-9a-f]{8}$/);

  // 同大小改写 + 把 mtime 原样改回去（robocopy /COPY:DAT、rsync -t 的形态）
  const nextSource = '旧车站的雨伞是青柠的。';
  assert.equal(Buffer.byteLength(nextSource, 'utf8'), before.size, '前提：字节数完全相同');
  await fs.writeFile(chapterPath, nextSource, 'utf8');
  await fs.utimes(chapterPath, before.atime, before.mtime);

  // ① 未到复核期：这一趟如实「还没发现」（降频的代价，注释与 README 第 21 条已经写明盲区）
  clockMs += 1000;
  hashCalls.length = 0;
  const throttled = await store.ensure({ booksRoot });
  assert.equal(hashCalls.length, 0, '未到期不复核');
  assert.equal(throttled.lastRun.rebuiltBooks, 0);

  // ② 到期（> 5 分钟 + 抖动上限）：必须复核并发现改写 → 重建、新词可搜、旧词消失
  clockMs += 400000;
  hashCalls.length = 0;
  const due = await store.ensure({ booksRoot });
  assert.equal(hashCalls.length, 1, '到期要真算一次内容指纹');
  assert.equal(due.lastRun.rebuiltBooks, 1, '同大小同时间戳的改写必须在复核时重建位图');
  const freshHash = store.getIndex().books[0].chapters[0].contentHash;
  assert.notEqual(freshHash, firstHash, '内容指纹必须跟着变');
  const hit = await store.search({ booksRoot, query: '青柠' });
  assert.equal(hit.results.length, 1, '新内容要能搜到（不许静默漏报）');
  const old = await store.search({ booksRoot, query: '灰色' });
  assert.equal(old.results.length, 0, '旧内容不许再命中');
});

test('P-N1/§R5：mtime 变化走即时路径（只算那一章，其余章不陪跑）', async () => {
  const base = await mkTmp();
  const userData = path.join(base, 'userdata');
  const booksRoot = path.join(base, 'books');
  await fs.mkdir(userData);
  await fs.mkdir(booksRoot);
  const { bookPath, meta } = await makeBook(booksRoot, '三章书', '三章书', [
    '第一章：青柠色的雨伞。',
    '第二章：雨还在下。',
    '第三章：风很轻。'
  ]);

  let clockMs = Date.parse('2026-11-17T20:00:00.000Z');
  const hashCalls = [];
  const store = makeStore(userData, {
    hashRecheckIntervalMs: 300000,
    now: () => new Date(clockMs),
    contentHashOf: async (filePath, size) => {
      hashCalls.push(path.basename(filePath));
      return search.chapterContentHashOf(filePath, size);
    }
  });
  await store.ensure({ booksRoot });
  assert.equal(hashCalls.length, 3);

  const targetFile = meta.chapters[1].file;
  const future = new Date(Date.now() + 5000);
  await fs.utimes(path.join(bookPath, targetFile), future, future);

  clockMs += 1000;
  hashCalls.length = 0;
  const second = await store.ensure({ booksRoot });
  assert.deepEqual(hashCalls, [targetFile], `只该重算 mtime 变了的这一章：实际 ${hashCalls.join(',')}`);
  assert.equal(second.lastRun.rebuiltBooks, 1, '信封变了 → 这一本要重建（但在不够复核期时只付一章的 open）');
});

test('P-N1/§R6：节流参数极值清洗 + 常量落在「低频但让 E4 可发现」的范围', async () => {
  const T = search.HASH_RECHECK_INTERVAL_MS;
  assert.ok(Number.isFinite(T) && T >= 60000 && T <= 600000, `默认复核间隔要低频且不许退化成永不：${T}`);

  const cases = [
    { value: 0, expected: 'every' },
    { value: -1, expected: 'default' },
    { value: Number.NaN, expected: 'default' },
    { value: 'x', expected: 'default' },
    { value: Infinity, expected: 'default' }
  ];
  for (const item of cases) {
    const base = await mkTmp();
    const userData = path.join(base, 'userdata');
    const booksRoot = path.join(base, 'books');
    await fs.mkdir(userData);
    await fs.mkdir(booksRoot);
    await makeBook(booksRoot, '书', '书', ['青柠色的雨伞。', '雨还在下。']);
    let clockMs = Date.parse('2026-11-17T20:00:00.000Z');
    let calls = 0;
    const store = makeStore(userData, {
      hashRecheckIntervalMs: item.value,
      now: () => new Date(clockMs),
      contentHashOf: async (filePath, size) => {
        calls += 1;
        return search.chapterContentHashOf(filePath, size);
      }
    });
    await store.ensure({ booksRoot });
    assert.equal(calls, 2, `${String(item.value)}：建索引要算 2 章`);
    clockMs += 1000;
    calls = 0;
    await store.ensure({ booksRoot });
    const want = item.expected === 'every' ? 2 : 0;
    assert.equal(calls, want, `${String(item.value)}：第二趟哈希次数应为 ${want}，实际 ${calls}`);
  }
});

test('P-N1/§R7：内容指纹读失败（占用 / EPERM → 空串）不缓存成「没变」，下次必重算', async () => {
  const base = await mkTmp();
  const userData = path.join(base, 'userdata');
  const booksRoot = path.join(base, 'books');
  await fs.mkdir(userData);
  await fs.mkdir(booksRoot);
  await makeBook(booksRoot, '失败书', '失败书', ['第一章：青柠色。', '第二章：雨。', '第三章：风。']);

  let clockMs = Date.parse('2026-11-17T20:00:00.000Z');
  let phase = 1;
  const calls = [];
  const store = makeStore(userData, {
    hashRecheckIntervalMs: 300000,
    now: () => new Date(clockMs),
    contentHashOf: async (filePath) => {
      const name = path.basename(filePath);
      calls.push(name);
      if (phase === 1 && (name.startsWith('002-') || name.startsWith('003-'))) return '';
      return `fp:${phase}:${name}`;
    }
  });
  await store.ensure({ booksRoot });
  assert.equal(calls.length, 3);
  const built = store.getIndex().books[0];
  assert.equal(built.chapters[0].contentHash, 'fp:1:001-章1.txt');
  assert.equal(built.chapters[1].contentHash, '', '读不到指纹如实记空串');
  assert.equal(built.chapters[2].contentHash, '');

  clockMs += 1000; // 仍在 5 分钟节流窗内
  phase = 2;
  calls.length = 0;
  const second = await store.ensure({ booksRoot });
  assert.deepEqual(
    calls.slice().sort(),
    ['002-章2.txt', '003-章3.txt'],
    `空指纹不许当「没变」复用：实际 ${calls.join(',')}`
  );
  assert.equal(store.getIndex().books[0].chapters[0].contentHash, 'fp:1:001-章1.txt', '有指纹的章照常复用');
  assert.equal(store.getIndex().books[0].chapters[1].contentHash, 'fp:2:002-章2.txt');
  assert.equal(second.lastRun.rebuiltBooks, 1);
});

test('P-N1/§R8：静态接线——流控参数、注入点与「先判再哈希」的数据形状', () => {
  const src = read('core/search-index.js');
  assert.match(src, /hashRecheckIntervalMs/);
  assert.match(src, /contentHashOf/);
  assert.match(src, /recheckHashes/);
  assert.match(src, /hashCheckedAt/);
  const buildStart = src.indexOf('async function buildBookEntry(');
  const buildEnd = src.indexOf('\nfunction createSearchStore');
  assert.ok(buildStart > 0 && buildEnd > buildStart);
  const buildBody = src.slice(buildStart, buildEnd);
  assert.match(buildBody, /const recheckHashes = options\.recheckHashes !== false/);
  assert.ok(buildBody.indexOf('recheckHashes') < buildBody.indexOf('contentHash:'), '先判「这一趟要不要复核」再决定算不算');
  assert.equal(
    /contentHash: await chapterContentHashOf\(filePath, stat\.size\)/.test(buildBody),
    false,
    '不许保留「每章无条件算指纹」的老路径'
  );
  assert.match(buildBody, /reusable/);
});