// 书级 storage 行为（T9：从 tests/storage.test.js 拆出）。
// 范围：createBook / writeBookMeta / 书架扫描（含字数回填与并发计数）/ listBooks / verifyBook /
// 书目 schemaVersion 与容量闸门（META_TOO_LARGE / META_TOO_MANY_CHAPTERS）/ 保存前校验 / 跨窗口登记 /
// 原子写 ensureDir / trashBook / 书名章名限长。章级与整本操作见 tests/storage-chapter.test.js。

const test = require('node:test');
const { beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const storage = require('../core/storage');
const limits = require('../core/limits');
const { atomicWriteFile } = require('../core/atomic');
const {
  STORAGE_SOURCE,
  topLevelBody,
  mkTmp,
  referenceBackfillChapterIds,
  stripCharsCache,
  makeSparseHuge,
  withFsPatch,
  countReadFileFor
} = require('./storage-fixtures');

// TB-05：打开登记（openBookRegistry）是模块级单例 —— 每个用例前统一重置。
// 单个用例要预置登记时仍可自己 register，测试之间互不影响。
beforeEach(() => {
  storage.openBookRegistry.reset();
});

test('createBook：建文件夹、初始空章、合法书目', async () => {
  const root = await mkTmp();
  const { path: bookPath, meta } = await storage.createBook(root, '星海旅人');
  assert.equal(meta.title, '星海旅人');
  assert.equal(meta.chapters.length, 1);
  assert.equal(meta.fileSeq, 1);
  const files = (await fs.readdir(bookPath)).sort();
  assert.deepEqual(files, ['001-未命名.txt', '书目.json']);
  const metaOnDisk = JSON.parse(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'));
  assert.equal(metaOnDisk.chapters[0].file, '001-未命名.txt');
});


test('createBook：同名自动加后缀，空书名兜底', async () => {
  const root = await mkTmp();
  const a = await storage.createBook(root, '草稿');
  const b = await storage.createBook(root, '草稿');
  const c = await storage.createBook(root, '   ');
  assert.notEqual(a.path, b.path);
  assert.ok(b.path.endsWith('草稿-2'));
  assert.equal(c.meta.title, '我的新书');
});

// C2（一轮·低）：撞名后缀到 999 就明确报错，不再无限探测；报错时磁盘上不许多出任何东西。


test('createBook：同名后缀到 999 上限 → NAME_CONFLICT 中文提示，零副作用', async () => {
  const root = await mkTmp();
  const base = '同名书';
  const folders = [base];
  for (let i = 2; i <= 999; i += 1) folders.push(`${base}-${i}`);
  for (const folder of folders) await fs.mkdir(path.join(root, folder));
  const before = (await fs.readdir(root)).sort();

  await assert.rejects(
    () => storage.createBook(root, base),
    (err) => {
      assert.equal(err.code, 'NAME_CONFLICT', '错误码要能让上层区分「书架满了」而不是写盘失败');
      // 用户可见文案：中文结论 + 两条出路（整理书架 / 换书名），不带本机路径
      assert.match(err.message, /同类文件夹太多了/);
      assert.match(err.message, /999/);
      assert.match(err.message, /请先整理书架或换一个书名/);
      assert.equal(/[A-Za-z]:\\/.test(err.message), false, '不许把本机绝对路径写进提示');
      return true;
    }
  );
  assert.deepEqual((await fs.readdir(root)).sort(), before, '报错时一个目录都没多建');
});


test('writeBookMeta：每次写入前生成 .bak（上一版）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '备份测试');
  let meta = await storage.readBookMeta(bookPath);
  await storage.renameBook(bookPath, '备份测试-改名');
  const bak = JSON.parse(await fs.readFile(path.join(bookPath, '书目.json.bak'), 'utf8'));
  assert.equal(bak.title, '备份测试');
  meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.title, '备份测试-改名');
});


test('书架扫描：书架目录指向普通文件时报 ROOT_UNREADABLE，提示里没有完整路径（v0.9 C-4）', async () => {
  const root = await mkTmp();
  const notADir = path.join(root, '这里是一个文件.txt');
  await fs.writeFile(notADir, '模拟「书架目录被改成某个文件」', 'utf8');
  await assert.rejects(
    () => storage.listBooks(notADir),
    (err) => {
      assert.equal(err.code, 'ROOT_UNREADABLE');
      assert.match(err.message, /^书架目录无法读取：/);
      // 提示里只剩最后一节文件名，书架根目录 / 盘符 / 用户名都不出现
      assert.equal(err.message.includes(root), false);
      assert.equal(/[A-Za-z]:[\\/]/.test(err.message), false);
      assert.match(err.message, /…\\这里是一个文件\.txt$/);
      return true;
    }
  );
  // 目录还是目录的时候照常（这个失败没有把书库弄坏）
  await fs.mkdir(path.join(root, '书'), { recursive: true });
  assert.deepEqual(await storage.listBooks(root), []);
});


test('旧版书目（v0.4.1，无 status/note）：照常打开、不自动补字段、完稿数为 0', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '旧版书');
  // 模拟 v0.4.1 写出的书目：只有 id/file/name/createdAt/chars，没有任何新字段
  const legacy = {
    version: 1,
    id: 'b_legacy',
    title: '旧版书',
    titleTemplate: '第{num}章：{name}',
    fileSeq: 1,
    chapters: [
      {
        id: 'ch_001',
        file: '001-未命名.txt',
        name: '起风',
        chars: 4,
        createdAt: '2026-10-31T00:00:00.000Z'
      }
    ],
    createdAt: '2026-10-31T00:00:00.000Z'
  };
  await fs.writeFile(path.join(bookPath, '书目.json'), JSON.stringify(legacy, null, 2), 'utf8');

  const meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters[0].status, undefined);
  assert.equal(meta.chapters[0].note, undefined);
  const books = await storage.listBooks(root);
  const listed = books.find((book) => book.title === '旧版书');
  assert.ok(listed);
  assert.equal(listed.doneChapters, 0);

  // 普通改名不会把新字段补进旧书目
  await storage.renameChapter(bookPath, 'ch_001', '大风');
  const raw = JSON.parse(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'));
  assert.equal(raw.chapters[0].status, undefined);
  assert.equal(raw.chapters[0].note, undefined);
});

// C32（v1.8.0 WP-26）：缺 id 的章按位置补 `ch_NNN` 必须查唯一性。旧实现直接按位置拼，
// 与既有 id 撞车时 findChapterIndex 只认第一个，改名 / 删除 / 保存会作用到错误的章。


test('C32/WP-26：缺 id 的章补号避撞（位置号被占时顺延，不产生重复 id）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '缺 id 避撞');
  const metaPath = path.join(bookPath, '书目.json');
  const disk = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  const firstFile = disk.chapters[0].file;
  disk.chapters = [
    { file: firstFile, name: '无 id 的章' },
    { id: 'ch_001', file: '002-已有 id.txt', name: '已有 id 的章' }
  ];
  disk.fileSeq = 2;
  await fs.writeFile(metaPath, JSON.stringify(disk, null, 2), 'utf8');

  const meta = await storage.readBookMeta(bookPath);
  const ids = meta.chapters.map((c) => c.id);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2, '补出来的 id 不许与既有 id 撞车');
  assert.equal(ids[1], 'ch_001', '已存在的 id 一个都不改写');
  assert.notEqual(ids[0], 'ch_001', '位置号被占时要顺延');

  // 按补出来的 id 改名只作用到缺 id 那一章（旧行为会改到 ch_001 那一章）
  await storage.renameChapter(bookPath, ids[0], '只改这一章');
  const after = await storage.readBookMeta(bookPath);
  assert.equal(after.chapters.find((c) => c.file === firstFile).name, '只改这一章');
  assert.equal(after.chapters.find((c) => c.id === 'ch_001').name, '已有 id 的章');
});


test('审计 #22（P6）：缺 id 回填与旧算法逐项等价（含空洞 / 高号占用 / 连续缺号）', () => {
  const cases = [
    [{ file: 'a.txt' }, { file: 'b.txt' }],
    [{ file: 'a.txt' }, { id: 'ch_001', file: 'b.txt' }],
    [{ id: 'ch_005', file: 'a.txt' }, { file: 'b.txt' }],
    [{ file: 'a.txt' }, { id: 'ch_002', file: 'b.txt' }, { file: 'c.txt' }],
    // 「指针会跳」的形状：前 9 章已占 ch_001..ch_009，位置号被占时旧算法逐个顺延
    [
      { file: 'a.txt' },
      { id: 'ch_001', file: 'b.txt' },
      { id: 'ch_002', file: 'c.txt' },
      { id: 'ch_003', file: 'd.txt' },
      { id: 'ch_004', file: 'e.txt' },
      { id: 'ch_005', file: 'f.txt' },
      { id: 'ch_006', file: 'g.txt' },
      { id: 'ch_007', file: 'h.txt' },
      { id: 'ch_008', file: 'i.txt' },
      { id: 'ch_009', file: 'j.txt' }
    ],
    // 乱序 / 坏 id（非字符串 / 空串照旧当缺失）
    [{ id: 7, file: 'a.txt' }, { id: '', file: 'b.txt' }, { id: 'ch_003', file: 'c.txt' }, { file: 'd.txt' }]
  ];
  for (const chapters of cases) {
    assert.deepEqual(
      storage.backfillMissingChapterIds(chapters),
      referenceBackfillChapterIds(chapters),
      '编号要与旧算法逐项一致：' + JSON.stringify(chapters.map((c) => c.id))
    );
  }
  // 只补缺失项：已有 id（哪怕不是 ch_NNN）一个都不改写；补号仍按「位置号起步」
  const kept = storage.backfillMissingChapterIds([{ id: 'custom-id', file: 'a.txt' }, { file: 'b.txt' }]);
  assert.deepEqual(kept, ['custom-id', 'ch_002']);
});


test('审计 #22（P6）：20000 章「前一半缺 id + 后一半占满低位号」一次扫完且编号不撞', () => {
  const chapters = [];
  for (let i = 0; i < 20000; i += 1) {
    const file = `${String(i + 1).padStart(4, '0')}-章.txt`;
    // 前 10000 章缺 id（i+1 = 1..10000 全被后一半占住），后 10000 章占着 ch_001..ch_10000
    chapters.push(i < 10000 ? { file } : { id: `ch_${String(i - 9999).padStart(3, '0')}`, file });
  }
  const ids = storage.backfillMissingChapterIds(chapters);
  assert.equal(ids.length, 20000);
  assert.equal(new Set(ids).size, 20000, '补出来的 id 不许重复');
  assert.equal(ids[0], 'ch_10001', '低位号全被占 → 从第 10001 个起顺延');
  assert.equal(ids[9999], 'ch_20000');
  assert.deepEqual(ids.slice(10000, 10003), ['ch_001', 'ch_002', 'ch_003'], '已有 id 一个都不改写');
});


test('审计 #22（P6）：静态闸门 —— 回填不再从 i+1 逐章重扫', () => {
  // TB-01：函数体锚点统一走 topLevelBody（它在找不到函数时 assert 失败）；
  // 旧写法 `src.slice(start, src.indexOf('\nfunction validateMeta(', start))` 在 validateMeta 改名 /
  // 删除后会拿到 slice(start, -1)——范围静默扩大到剩余全文，后续 assert.match 反而更容易通过。
  assert.match(STORAGE_SOURCE, /function backfillMissingChapterIds\(\w+\)/);
  assert.match(STORAGE_SOURCE, /const backfilledIds = backfillMissingChapterIds\(meta\.chapters\)/, 'readBookMeta 必须走这一份');
  const body = topLevelBody('backfillMissingChapterIds');
  assert.match(body, /let cursor = 1/, '必须有单调游标');
  assert.match(body, /Math\.max\(cursor, i \+ 1\)/, '每个缺 id 的章从游标与位置号的较大者起步');
  assert.match(body, /cursor = n/, '探测过后游标只前进');
});


test('书架扫描：完稿章数按 status=done 统计', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '完稿统计');
  await storage.createChapter(bookPath, 1, '第二章');
  await storage.createChapter(bookPath, 2, '第三章');
  let meta = await storage.readBookMeta(bookPath);
  await storage.updateChapterMeta(bookPath, meta.chapters[0].id, { status: 'done' });
  await storage.updateChapterMeta(bookPath, meta.chapters[2].id, { status: 'done' });
  await storage.updateChapterMeta(bookPath, meta.chapters[1].id, { status: 'revising' });
  const books = await storage.listBooks(root);
  assert.equal(books[0].chapterCount, 3);
  assert.equal(books[0].doneChapters, 2);
});


test('listBooks：扫描、统计、损坏标记', async () => {
  const root = await mkTmp();
  const goodBook = await storage.createBook(root, '好书');
  await storage.createChapter(goodBook.path, 1, '夜雨');
  const bad = await storage.createBook(root, '坏书');
  await storage.saveChapterText(bad.path, '001-未命名.txt', '内容内容');
  await fs.writeFile(path.join(bad.path, '书目.json'), '{ 这不是 json', 'utf8');
  // 无书目的子目录应被忽略
  await fs.mkdir(path.join(root, '普通文件夹'));
  // _ 开头的目录应被忽略
  await fs.mkdir(path.join(root, '_backup'));

  const books = await storage.listBooks(root);
  assert.equal(books.length, 2);
  const good = books.find((b) => b.folder === '好书');
  const corrupt = books.find((b) => b.folder === '坏书');
  assert.equal(good.status, 'ok');
  assert.equal(good.chapterCount, 2);
  // 章节名跟着书架列表返回，供书架搜索用（不搜正文）
  assert.deepEqual(good.chapterNames, ['', '夜雨']);
  assert.equal(corrupt.status, 'corrupt');
  assert.deepEqual(corrupt.chapterNames, []);
  assert.match(corrupt.reason, /解析失败/);
});


// N-09（二次审查）：书架卡片不再整本下发章节名 —— 每本最多前 500 条 + 截断标记；
// 需要省载荷的调用方可以 includeChapterNames:false（完全不读章节名）。
test('N-09：readBookCard 章节名截到前 500 条并标记；includeChapterNames:false 不读章节名', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '大书架书');
  await fs.mkdir(bookPath);
  const chapters = Array.from({ length: 501 }, (_, i) => ({
    id: `ch_${i + 1}`,
    file: `${String(i + 1).padStart(3, '0')}-第${i + 1}章.txt`,
    name: `第${i + 1}章`,
    createdAt: new Date().toISOString(),
    // 字数缓存齐全：书卡这条路径不再读任何章节正文（没有 txt 文件也照样出卡）
    chars: 0
  }));
  await fs.writeFile(
    path.join(bookPath, '书目.json'),
    JSON.stringify(
      {
        version: 1,
        schemaVersion: 1,
        id: 'b_cap',
        title: '大书架书',
        titleTemplate: '第{num}章：{name}',
        fileSeq: 501,
        chapters,
        lastOpenChapterId: 'ch_1',
        createdAt: new Date().toISOString()
      },
      null,
      2
    ),
    'utf8'
  );

  const card = await storage.readBookCard(bookPath);
  assert.equal(card.chapterCount, 501);
  assert.equal(card.chapterNames.length, 500, '章节名最多带 500 条（100 本 × 3000 章的 IPC 载荷 / 按键扫描量）');
  assert.equal(card.chapterNames[0], '第1章');
  assert.equal(card.chapterNames[499], '第500章');
  assert.equal(card.chapterNamesTruncated, true, '还有章节名没带来时要如实标记，别让界面把「搜不到」当成「没有」');

  const light = await storage.readBookCard(bookPath, { includeChapterNames: false });
  assert.deepEqual(light.chapterNames, [], 'includeChapterNames:false 时一个章节名都不带');
  assert.equal(light.chapterNamesTruncated, true, '不带章节名的书卡同样要说明「有章节名没带」');
  assert.equal(light.chapterCount, 501, '别的书卡字段照旧');

  // 小书不受影响：全部章节名 + truncated=false（常见书架零变化）
  const small = await storage.createBook(root, '小书');
  await storage.createChapter(small.path, 1, '第二章');
  const smallCard = await storage.readBookCard(small.path);
  assert.equal(smallCard.chapterNames.length, 2);
  assert.equal(smallCard.chapterNamesTruncated, false);
});

test('verifyBook 报告缺失的章节文件', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '缺失测试');
  await storage.createChapter(bookPath, 1, '夜雨');
  const meta = await storage.readBookMeta(bookPath);
  await fs.unlink(path.join(bookPath, meta.chapters[1].file));
  const report = await storage.verifyBook(bookPath);
  assert.equal(report.chapterCount, 2);
  assert.deepEqual(report.missing, [meta.chapters[1].file]);
});


// N-07（二次审查）：打开书不再在关键路径上全量回填字数 —— skipStats 只汇总已有缓存、不写盘；
// 回填交给后台单飞（backfillBookStatsInBackground），补的是同一份 chars 缓存、不顶 updatedAt。
test('N-07：openBook(skipStats) 不读正文也不写缓存；后台回填单飞补齐且不动 updatedAt', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '跳读字数');
  await storage.createChapterWithText(bookPath, { insertIndex: 1, name: '雨夜', text: '窗外下着雨。' });
  const metaFile = path.join(bookPath, '书目.json');
  // 先抹掉两章的字数缓存（模拟老版本 / 外部重建 / 导入后没扫过书架的书）
  const stripped = await stripCharsCache(bookPath);
  const metaBefore = await fs.readFile(metaFile);
  const opened = await storage.openBook(bookPath, { skipStats: true });
  assert.equal(opened.meta.chapters.length, 2);
  assert.equal(opened.statsPending, true, '有章节缺字数缓存时如实标记，界面 / 调用方可据此知道是「已知字数」');
  assert.equal(opened.totalChars, 0, 'skipStats 只汇总已有缓存；缺缓存不读盘、不猜');
  assert.deepEqual(opened.missing, [], '缺失章节检查仍留在关键路径（只 stat，不读正文）');
  assert.deepEqual(await fs.readFile(metaFile), metaBefore, 'skipStats 打开书一个字节都不写盘');

  // 后台回填：同一本书并发请求合并成一趟（返回同一个 Promise），补出真实字数、不顶 updatedAt
  const first = storage.backfillBookStatsInBackground(bookPath);
  const second = storage.backfillBookStatsInBackground(bookPath);
  assert.equal(first, second, '同一本书的回填必须单飞（并发请求复用同一趟）');
  assert.equal(await first, true, '回填成功');
  const disk = JSON.parse(await fs.readFile(metaFile, 'utf8'));
  assert.ok(disk.chapters.every((chapter) => Number.isFinite(chapter.chars)), '后台已把两章字数补进书目');
  assert.equal(disk.chapters[0].chars, 0, '空章 = 0 字（旧版 bookStats 口径）');
  assert.equal(disk.chapters[1].chars, 6, '「窗外下着雨。」= 6 字');
  assert.equal(disk.updatedAt, stripped.updatedAt, '只补缓存不改 updatedAt（审计 E-06 口径不变）');
  assert.equal(await storage.backfillBookStatsInBackground(''), false, '空路径直接回 false，不读盘');
});

test('N-07：book:open 走 skipStats + 后台回填；新窗口预检连缺失章 stat 都跳过（静态接线）', () => {
  const fsSync = require('node:fs');
  const read = (rel) => fsSync.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
  const bookIpc = read('ipc/book.js');
  assert.match(
    bookIpc,
    /storage\.openBook\(bookPath, \{ skipStats: true \}\)/,
    'book:open 必须跳过关键路径上的全量字数回填（N-07）'
  );
  assert.match(
    bookIpc,
    /void storage\.backfillBookStatsInBackground\(bookPath\)/,
    'book:open 要把字数回填排到后台（同一本书单飞）'
  );
  const mainSrc = read('main.js');
  assert.match(
    mainSrc,
    /await storage\.openBook\(target, \{ skipStats: true, skipMissing: true \}\)/,
    'window:open-book 只是可读性预检：不读正文、不逐章 stat（缺失检查留给新窗口自己的 book:open）'
  );
});

test('verifyBook 纯读：字数缓存缺失时只算不写，不偷偷改书目.json', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '校验只读');
  const metaFile = path.join(bookPath, '书目.json');
  // createBook 写的书目里没有 chars 缓存；先写好正文，再校验
  await fs.writeFile(path.join(bookPath, '001-未命名.txt'), '你好世界', 'utf8');
  const metaBefore = await fs.readFile(metaFile);
  const report = await storage.verifyBook(bookPath);
  assert.equal(report.chapterCount, 1);
  assert.equal(report.totalChars, 4);
  assert.deepEqual(report.missing, []);
  // 保存后的后台校验是纯读：书目的字节一个都没变（没有补 chars 缓存）
  assert.deepEqual(await fs.readFile(metaFile), metaBefore);
  // 回填缓存的能力没删：书架扫描 / 打开书照旧把 chars 写回
  const opened = await storage.openBook(bookPath);
  assert.equal(opened.totalChars, 4);
  const cached = JSON.parse(await fs.readFile(metaFile, 'utf8'));
  assert.equal(cached.chapters[0].chars, 4);
});


test('原子写：目标被目录占用时抛错且不残留临时文件', async () => {
  const root = await mkTmp();
  const target = path.join(root, 'x.txt');
  await fs.mkdir(target); // 让 rename 失败
  await assert.rejects(() => atomicWriteFile(target, 'hello'));
  const leftovers = (await fs.readdir(root)).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});


test('整本书兜底删除：移入书架 _trash，扫描时不再出现', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '待删的书');
  const dest = await storage.trashBook(root, bookPath);
  assert.ok(dest.includes('_trash'));
  await fs.access(path.join(dest, '书目.json'));
  const books = await storage.listBooks(root);
  assert.equal(books.length, 0);
  // 留在 _trash 里的书还能被人工读出来
  const meta = await storage.readBookMeta(dest);
  assert.equal(meta.title, '待删的书');
});

// 审计修复 #4（S1、E20）：trashBook 不再只信调用方路径 —— 自己校验「目标是书架根下的真书目录」。


test('审计修复 #4（S1）：trashBook 拒绝保留目录 / 无书目的文件夹 / 书架根 / 孙目录 / 书库外路径', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '合法的书');
  await fs.mkdir(path.join(root, '_trash'), { recursive: true });
  await fs.mkdir(path.join(root, '_碎片'), { recursive: true });
  await fs.mkdir(path.join(root, '.hidden'), { recursive: true });
  await fs.mkdir(path.join(root, '普通文件夹'), { recursive: true });
  const cases = [
    ['书架根本身', root, 'BAD_PATH'],
    ['书架级 _trash', path.join(root, '_trash'), 'BAD_PATH'],
    ['灵感箱 _碎片', path.join(root, '_碎片'), 'BAD_PATH'],
    ['隐藏目录', path.join(root, '.hidden'), 'BAD_PATH'],
    ['没有书目的普通文件夹', path.join(root, '普通文件夹'), 'NOT_A_BOOK'],
    ['书的子目录', path.join(bookPath, '子目录'), 'BAD_PATH'],
    ['书库外路径', path.join(root, '..', '书库外'), 'BAD_PATH']
  ];
  for (const [label, target, code] of cases) {
    await assert.rejects(
      () => storage.trashBook(root, target),
      (err) => err.code === code,
      `${label} 应报 ${code}`
    );
  }
  // 以上全部被拒且一个都没动：合法书仍能删
  assert.equal(await storage.exists(path.join(root, '_trash')), true);
  assert.equal(await storage.exists(path.join(root, '_碎片')), true);
  const dest = await storage.trashBook(root, bookPath);
  assert.ok(dest.startsWith(path.join(root, '_trash')));
  assert.equal(await storage.exists(bookPath), false);
});


test('审计修复 #4（E20）：同一秒删同名书不覆盖已有备份（目标名 -2 起顺延）', async (t) => {
  const root = await mkTmp();
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 15, 12, 0, 0).getTime() });
  try {
    const first = await storage.createBook(root, '同名书');
    const firstDest = await storage.trashBook(root, first.path);
    // 第一本已经搬走，同名文件夹空出来 → 第二本仍叫「同名书」，同一秒删会撞名
    const second = await storage.createBook(root, '同名书');
    assert.equal(path.basename(second.path), '同名书');
    const secondDest = await storage.trashBook(root, second.path);
    assert.notEqual(secondDest, firstDest);
    assert.match(path.basename(secondDest), /-2$/);
    // 第一份备份没被覆盖
    assert.equal((await storage.readBookMeta(firstDest)).title, '同名书');
    await fs.access(path.join(firstDest, '书目.json'));
  } finally {
    t.mock.timers.reset();
  }
});


test('审计修复 #4（S1）：trashBook 排进这本书的写队列，在飞的写操作没 settle 前不搬目录', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '排队删除');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const holder = storage.withBookLock(bookPath, async () => { await gate; });
  const trashing = storage.trashBook(root, bookPath);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(await storage.exists(bookPath), true, '写队列还没放行，目录不许被搬走');
  release();
  await holder;
  const dest = await trashing;
  assert.equal(await storage.exists(bookPath), false);
  assert.ok(dest.includes('_trash'));
});


test('字数缓存：旧书首次扫描会补缓存，之后书架统计不再重读全书', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '字数缓存');
  const meta = await storage.readBookMeta(bookPath);
  // 直接写文件，模拟「没有 chars 缓存的旧书」
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '雨下了一夜。');
  const books = await storage.listBooks(root);
  assert.equal(books[0].totalChars, 6);
  const cached = await storage.readBookMeta(bookPath);
  assert.equal(cached.chapters[0].chars, 6, '首次扫描应把字数缓存写回书目');
  // 再扫一次结果一致
  const again = await storage.listBooks(root);
  assert.equal(again[0].totalChars, 6);
});


test('书目 schemaVersion：新建书带 1；旧书只读补 1 不落盘；写盘才补；未来版本不降级', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '版本测试');
  const metaPath = path.join(bookPath, '书目.json');
  const rawNew = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  assert.equal(rawNew.schemaVersion, 1);

  // 模拟 v0.4.1 写出的书目：没有 schemaVersion
  delete rawNew.schemaVersion;
  await fs.writeFile(metaPath, JSON.stringify(rawNew, null, 2), 'utf8');
  const legacy = await storage.readBookMeta(bookPath);
  assert.equal(legacy.schemaVersion, 1, '内存里按版本 1 读');
  const rawAfterRead = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  assert.equal(rawAfterRead.schemaVersion, undefined, '只是读，不写盘补字段');

  // 正常写盘（改章名）时才补上版本号
  await storage.renameChapter(bookPath, legacy.chapters[0].id, '大风');
  const rawAfterWrite = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  assert.equal(rawAfterWrite.schemaVersion, 1);
  assert.equal(rawAfterWrite.chapters[0].name, '大风');

  // 比本应用新的版本号：能读，写回也不降级
  await fs.writeFile(metaPath, JSON.stringify({ ...rawAfterWrite, schemaVersion: 2 }), 'utf8');
  const future = await storage.readBookMeta(bookPath);
  assert.equal(future.schemaVersion, 2);
  await storage.renameBook(bookPath, '未来版本书');
  const rawFuture = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  assert.equal(rawFuture.schemaVersion, 2);
});


test('listBooks：识别同步冲突副本，不当作章节、不影响统计，冲突文件原样保留', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '同步冲突书');
  await storage.createChapter(bookPath, 1, '夜雨');
  const before = await storage.readBookMeta(bookPath);
  const conflictFiles = [
    '001-未命名 (conflicted copy 1).txt',
    '书目-冲突副本.json'
  ];
  for (const name of conflictFiles) {
    await fs.writeFile(path.join(bookPath, name), '冲突副本内容', 'utf8');
  }
  // _trash 里的旧备份名字带 conflicted 也不算（只看书文件夹顶层）
  await fs.mkdir(path.join(bookPath, '_trash'));
  await fs.writeFile(path.join(bookPath, '_trash', '旧 (conflicted copy).txt'), '备份', 'utf8');

  const books = await storage.listBooks(root);
  const listed = books.find((book) => book.folder === '同步冲突书');
  assert.ok(listed);
  assert.equal(listed.status, 'ok');
  assert.equal(listed.chapterCount, 2, '冲突副本不能算成章节');
  assert.equal(listed.doneChapters, 0);
  assert.deepEqual(listed.conflicts.slice().sort(), conflictFiles.slice().sort());

  // 书目里的章节记录没变（listBooks 只会补字数缓存，不会把冲突副本收进 chapters），冲突文件也没被移动/删除
  const after = await storage.readBookMeta(bookPath);
  const pick = (list) => list.map((c) => ({ id: c.id, file: c.file, name: c.name }));
  assert.deepEqual(pick(after.chapters), pick(before.chapters));
  assert.equal(after.chapters.some((c) => /conflicted|冲突副本/i.test(c.file)), false);
  const files = await fs.readdir(bookPath);
  for (const name of conflictFiles) assert.ok(files.includes(name), `${name} 应原样保留`);
});


test('listBooks：损坏书目的书也带冲突副本提示（方便先修书目再处理副本）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '坏书带冲突');
  await fs.writeFile(path.join(bookPath, '书目.json'), '{ 坏掉了', 'utf8');
  await fs.writeFile(path.join(bookPath, '书目 (conflicted copy 1).json'), '{}', 'utf8');

  const books = await storage.listBooks(root);
  const listed = books.find((book) => book.folder === '坏书带冲突');
  assert.ok(listed);
  assert.equal(listed.status, 'corrupt');
  assert.deepEqual(listed.conflicts, ['书目 (conflicted copy 1).json']);
});

// ---------- 多窗口：打开登记 + 保存前校验 + 跨窗口拦截 ----------
// TB-05：重置由文件级 beforeEach 统一负责（见文件头），用例里不再逐条手工 reset。


test('保存前校验：正常书 / 章返回 meta 与章节，允许保存', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '保存校验');
  const meta = await storage.readBookMeta(bookPath);
  const prepared = await storage.prepareChapterSave(bookPath, meta.chapters[0].id);
  assert.equal(prepared.chapter.id, meta.chapters[0].id);
  assert.equal(prepared.chapter.file, '001-未命名.txt');
  assert.equal(prepared.index, 0);
});


test('保存前校验：章节文件被删掉 → CHAPTER_MISSING，绝不重建影子 txt', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '缺章书');
  const meta = await storage.readBookMeta(bookPath);
  const file = meta.chapters[0].file;
  await fs.unlink(path.join(bookPath, file));
  const before = (await fs.readdir(bookPath)).sort();
  await assert.rejects(
    () => storage.prepareChapterSave(bookPath, meta.chapters[0].id),
    (err) => err.code === 'CHAPTER_MISSING' && /影子文件/.test(err.message)
  );
  assert.deepEqual((await fs.readdir(bookPath)).sort(), before);
  assert.equal(await storage.exists(path.join(bookPath, file)), false);
});


test('保存前校验：书文件夹被删掉 → BOOK_MISSING，绝不 mkdir 重建目录', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '整本没了');
  const meta = await storage.readBookMeta(bookPath);
  await fs.rm(bookPath, { recursive: true, force: true });
  await assert.rejects(
    () => storage.prepareChapterSave(bookPath, meta.chapters[0].id),
    (err) => err.code === 'BOOK_MISSING'
  );
  assert.equal(await storage.exists(bookPath), false);
});


test('保存前校验：章节从书目里删掉 → CHAPTER_NOT_FOUND', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '章没了');
  const meta = await storage.readBookMeta(bookPath);
  const removedId = meta.chapters[0].id;
  await storage.deleteChapter(bookPath, removedId);
  await assert.rejects(
    () => storage.prepareChapterSave(bookPath, removedId),
    (err) => err.code === 'CHAPTER_NOT_FOUND'
  );
});


test('保存前校验：书目损坏 → 明确报错，不写盘', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '书目坏了');
  const meta = await storage.readBookMeta(bookPath);
  await fs.writeFile(path.join(bookPath, '书目.json'), '{ 坏掉了', 'utf8');
  await assert.rejects(
    () => storage.prepareChapterSave(bookPath, meta.chapters[0].id),
    (err) => err.code === 'PARSE_ERROR'
  );
});


test('跨窗口拦截：别的窗口开着的书拒绝保存 / 删除 / 改名 / 整理', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '跨窗口书');
  const meta = await storage.readBookMeta(bookPath);
  storage.registerOpenBook(1, bookPath);
  assert.equal(storage.findOpenBookWindow(bookPath), '1');
  for (const action of ['save', 'delete', 'rename', 'format']) {
    await assert.rejects(
      () => Promise.resolve().then(() => storage.assertBookNotBusy(bookPath, 2, action)),
      (err) => err.code === 'CROSS_WINDOW_BUSY' && /请先关掉另一个窗口/.test(err.message),
      action
    );
  }
  // 自己窗口不受影响，保存校验也能通过
  assert.equal(storage.assertBookNotBusy(bookPath, 1, 'save'), true);
  await storage.prepareChapterSave(bookPath, meta.chapters[0].id, { windowId: 1 });
  // 释放后另一个窗口就能操作了
  storage.releaseOpenBook(1);
  assert.equal(storage.findOpenBookWindow(bookPath), null);
  await storage.prepareChapterSave(bookPath, meta.chapters[0].id, { windowId: 2 });
});


test('跨窗口拦截：删除书后按路径清掉登记', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '删掉的书');
  storage.registerOpenBook(3, bookPath);
  assert.equal(storage.findOpenBookWindow(bookPath), '3');
  assert.equal(storage.releaseOpenBookPath(bookPath), true);
  assert.equal(storage.findOpenBookWindow(bookPath), null);
  assert.equal(storage.openBookRegistry.getBook(3), null);
  assert.equal(storage.releaseOpenBookPath(bookPath), false);
});


test('ensureDir:false：目录不在时原子写直接失败，不会创建目录 / 临时文件', async () => {
  const root = await mkTmp();
  const targetDir = path.join(root, '不存在的书');
  const target = path.join(targetDir, '001-未命名.txt');
  await assert.rejects(() => storage.saveChapterText(targetDir, '001-未命名.txt', '不该落盘', { ensureDir: false }));
  assert.equal(await storage.exists(targetDir), false);
  assert.equal(await storage.exists(target), false);
});


test('ensureDir:false：目录存在时照常原子写（保存校验通过后的正常路径）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '正常写');
  const meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '正文', { ensureDir: false });
  assert.equal((await storage.loadChapterText(bookPath, meta.chapters[0].file)).text, '正文');
});


test('书架扫描：回填字数缓存不改 updatedAt，书架顺序稳定', async () => {
  const root = await mkTmp();
  const older = await storage.createBook(root, '甲书');
  const newer = await storage.createBook(root, '乙书');
  await storage.saveChapterText(older.path, '001-未命名.txt', '甲书的正文十个字');
  await storage.saveChapterText(newer.path, '001-未命名.txt', '乙书正文');
  // 造「老版本」书目：没有 chars 缓存，updatedAt 是固定值（甲早乙晚）
  const stamps = new Map([
    [older.path, '2026-01-01T00:00:00.000Z'],
    [newer.path, '2026-02-01T00:00:00.000Z']
  ]);
  for (const book of [older, newer]) {
    const meta = await storage.readBookMeta(book.path);
    const legacy = {
      ...meta,
      updatedAt: stamps.get(book.path),
      chapters: meta.chapters.map((chapter) => ({ id: chapter.id, file: chapter.file, name: chapter.name }))
    };
    await fs.writeFile(path.join(book.path, '书目.json'), JSON.stringify(legacy), 'utf8');
  }

  const first = await storage.listBooks(root);
  assert.deepEqual(first.map((book) => book.folder), ['乙书', '甲书'], '书架按 updatedAt 倒序');
  assert.ok(first.every((book) => book.totalChars > 0), '扫描要回填字数');
  for (const book of [older, newer]) {
    const meta = await storage.readBookMeta(book.path);
    assert.equal(meta.updatedAt, stamps.get(book.path), '回填字数缓存不许改 updatedAt');
    assert.ok(meta.chapters.every((chapter) => Number.isFinite(chapter.chars)), '字数缓存要写回');
  }
  const second = await storage.listBooks(root);
  assert.deepEqual(second.map((book) => book.folder), ['乙书', '甲书'], '再扫一次顺序不变');
  assert.deepEqual(second.map((book) => book.lastModified), [
    Date.parse('2026-02-01T00:00:00.000Z'),
    Date.parse('2026-01-01T00:00:00.000Z')
  ]);
});


test('书架扫描：缺字数按 8 路并发回填（注入 reader 计数，不测墙钟）', async () => {
  const chapters = Array.from({ length: 20 }, (_, i) => ({ id: `ch_${i}`, file: `0${i}-x.txt` }));
  let inFlight = 0;
  let peak = 0;
  let calls = 0;
  const changed = await storage.backfillChapterChars('/tmp/不用真读', chapters, {
    readText: async () => {
      calls += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 4));
      inFlight -= 1;
      return '一二三四五';
    }
  });
  assert.equal(changed, true);
  assert.equal(calls, 20);
  assert.equal(peak, 8, '并发上限 8（书架列书目是 12、缺章 stat 是 16，各管各的）');
  assert.ok(chapters.every((chapter) => chapter.chars === 5));

  // 章节记录还在但文件被删（ENOENT）：跳过、不抛、不留 chars
  const withMissing = [{ id: 'ch_x', file: 'missing.txt' }, { id: 'ch_y', file: 'ok.txt' }];
  const changed2 = await storage.backfillChapterChars('/tmp/不用真读', withMissing, {
    readText: async (bookPath, chapter) => {
      if (chapter.file === 'missing.txt') {
        const err = new Error('没有这个文件');
        err.code = 'ENOENT';
        throw err;
      }
      return '四个汉字';
    }
  });
  assert.equal(changed2, true);
  assert.equal(withMissing[0].chars, undefined);
  assert.equal(withMissing[1].chars, 4);

  // 全都有缓存：一次都不读（书架二次扫描只算加法）
  let untouched = 0;
  const cached = [{ id: 'ch_c', file: 'c.txt', chars: 9 }];
  const changed3 = await storage.backfillChapterChars('/tmp/不用真读', cached, {
    readText: async () => {
      untouched += 1;
      return '';
    }
  });
  assert.equal(changed3, false);
  assert.equal(untouched, 0);
});

// 审计修复 #25（R4）：backfill / refresh 两条链路的「逐章读盘算字数」收成一个内核。
// 这两条以前各抄一份 mapLimit + 128 MB 闸门 + ENOENT 跳过 + countChars(stripBom())，闸门口径
// 改一处漏一处；这里钉住「只有一份实现，两条链路都必须走它」，防回潮写成两份。


test('审计 #25（R4）：字数回填 / 刷新共用同一个读盘计数内核', () => {
  assert.equal(
    (STORAGE_SOURCE.match(/function countChapterChars\(/g) || []).length,
    1,
    'countChapterChars 只许有一份实现'
  );
  const kernel = topLevelBody('countChapterChars');
  for (const token of ['readChapterTextForCount', 'stripBom', 'countChars', "err.code === 'ENOENT'", 'return null']) {
    assert.ok(kernel.includes(token), `内核必须包含 ${token}`);
  }
  const backfill = topLevelBody('backfillChapterChars');
  // TB-01：只钉「走了同一个内核」，不钉实参名（改名 / 换局部变量名属无害重构）。
  assert.ok(backfill.includes('countChapterChars('), 'backfill 必须走内核');
  assert.equal(backfill.includes('mapLimit('), false, 'backfill 不许再自己 mapLimit');
  assert.equal(backfill.includes('countChars('), false, 'backfill 不许再自己算字数');

  const refresh = topLevelBody('refreshChapterChars');
  assert.ok(refresh.includes('countChapterChars('), 'refresh 必须走同一个内核');
  assert.equal(refresh.includes('mapLimit('), false, 'refresh 不许再自己 mapLimit');
  assert.equal(refresh.includes('stripBom'), false, 'refresh 不许再自己处理 BOM / 计数');
});

// ---------- 1.6.1 R3a：字数回填 128 MB 闸门 ----------
// 书架扫描回填以前是裸 fs.readFile：书目里缺 chars 缓存的章被外部程序换成 129 MB 文件
// （误放的视频 / 日志 / 数据库导出）时会整份读进主进程内存，异常还会把整本书标成 corrupt。
// 现在与 loadChapterText 同口径：先 stat + readSizeProblem(128 MB)，超限章跳过不读、不写缓存。


test('书架扫描：129 MB 章缺字数缓存 → 回填跳过不读盘、书照常列出、总字数不含该章（稀疏文件）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '超限章回填');
  const file = (await storage.readBookMeta(bookPath)).chapters[0].file;
  const hugePath = path.join(bookPath, file);
  await makeSparseHuge(hugePath);
  await stripCharsCache(bookPath);

  const counter = countReadFileFor(hugePath);
  let books;
  try {
    books = await storage.listBooks(root);
  } finally {
    counter.restore();
  }

  assert.equal(counter.hugeReads(), 0, '超限章一次都不许 readFile（不许进内存）');
  assert.equal(books.length, 1, '书照常列出，不能因为超限章整本消失');
  assert.equal(books[0].status, 'ok', '超限章不能把整本书标 corrupt');
  assert.equal(books[0].totalChars, 0, '没算出来的字数不进 totalChars');
  const onDisk = JSON.parse(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'));
  assert.equal(Number.isFinite(onDisk.chapters[0].chars), false, '超限章不写字数缓存');
});


test('书架扫描：1 正常章 + 1 超限章 → 只回填正常章、超限章字数保持缺失且不写缓存', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '混合章回填');
  const normalText = '正常章的正文六个字';
  await storage.createChapterWithText(bookPath, { insertIndex: 1, name: '正常章', text: normalText });
  const meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters.length, 2);
  const hugeFile = meta.chapters[0].file;
  const normalFile = meta.chapters[1].file;
  const hugePath = path.join(bookPath, hugeFile);
  await makeSparseHuge(hugePath);
  await stripCharsCache(bookPath);

  const counter = countReadFileFor(hugePath);
  let books;
  try {
    books = await storage.listBooks(root);
  } finally {
    counter.restore();
  }

  assert.equal(counter.hugeReads(), 0, '超限章一次都不许 readFile');
  assert.equal(books.length, 1);
  assert.equal(books[0].status, 'ok', '超限章不能把整本书标 corrupt');
  const readChapterFiles = counter.paths.filter((target) => target.endsWith('.txt'));
  assert.deepEqual(readChapterFiles, [path.join(bookPath, normalFile)], '只读正常章，一章一次');

  const onDisk = JSON.parse(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'));
  const hugeOnDisk = onDisk.chapters.find((chapter) => chapter.file === hugeFile);
  const normalOnDisk = onDisk.chapters.find((chapter) => chapter.file === normalFile);
  assert.equal(Number.isFinite(hugeOnDisk.chars), false, '超限章字数保持缺失，不许写缓存');
  assert.ok(Number.isFinite(normalOnDisk.chars), '正常章要回填字数缓存');
  assert.ok(normalOnDisk.chars > 0);
  assert.equal(books[0].totalChars, normalOnDisk.chars, '总字数只算正常章');
});

// ---------- C17/V104（v1.8.0 WP-19）：书目 / 撤销删除读盘的独立大小闸门 ----------
// 128 MB 闸门以前只覆盖章节 / 还原 / 快照；书目.json、.bak、撤销删除读 autoChapterFile 仍是裸
// readFile 再 JSON.parse / trim —— 被外部程序换成超大文件时同样会顶爆主进程。这里把三处补上，
// 书目给更小的独立上限（32 MB，够两万章的书目）。


test('readSizeProblem：limit 可给书目 / 索引用更小的独立上限，默认仍是章节的 128 MB', () => {
  const metaBytes = storage.MAX_META_READ_BYTES + 1;
  const problem = storage.readSizeProblem(metaBytes, {
    code: 'META_TOO_LARGE',
    label: '书目.json',
    limit: storage.MAX_META_READ_BYTES,
    tail: '没有读进内存'
  });
  assert.equal(problem.code, 'META_TOO_LARGE');
  assert.equal(problem.message, '书目.json有 32 MB，超过单文件读取上限 32 MB，没有读进内存');
  // 同一个尺寸在章节口径下是放行的 —— 证明 limit 真的在起作用，而不是把默认值改小了
  assert.equal(storage.readSizeProblem(metaBytes, { code: 'X', label: 'x' }), null);
  // 正好等于上限放行；坏 limit（0 / NaN）回落到章节口径 128 MB
  assert.equal(
    storage.readSizeProblem(storage.MAX_META_READ_BYTES, { code: 'X', label: 'x', limit: storage.MAX_META_READ_BYTES }),
    null
  );
  assert.equal(storage.readSizeProblem(metaBytes, { code: 'X', label: 'x', limit: 0 }), null);
  assert.equal(
    storage.readSizeProblem(storage.MAX_CHAPTER_READ_BYTES + 1, { code: 'X', label: 'x', limit: 0 }).code,
    'X'
  );
});


test('C17/WP-19：超大 书目.json 明确报 META_TOO_LARGE、一个字节都不读，书卡 reason 可读且不带路径', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '超大书目');
  const metaPath = path.join(bookPath, storage.BOOK_FILE);
  const original = await fs.readFile(metaPath);
  // 稀疏文件：只把长度改到上限 +1 KB，不真写 32 MB
  await fs.truncate(metaPath, storage.MAX_META_READ_BYTES + 1024);
  const counter = countReadFileFor(metaPath);
  try {
    await assert.rejects(
      () => storage.readBookMeta(bookPath),
      (err) => {
        assert.equal(err.code, 'META_TOO_LARGE');
        assert.match(err.message, /超过单文件读取上限 32 MB/);
        assert.match(err.message, /没有读进内存/);
        assert.equal(err.message.includes(bookPath), false, '错误文案不能带本机完整路径');
        return true;
      }
    );
    assert.equal(counter.hugeReads(), 0, '超限书目一次都不许 readFile（不许进内存）');
    // 书架扫描：书卡照常列出、标 corrupt、reason 是人能看懂的一句（不能被大文件拖死 / 读爆）
    const books = await storage.listBooks(root);
    assert.equal(books.length, 1);
    assert.equal(books[0].status, 'corrupt');
    assert.match(books[0].reason, /超过单文件读取上限/);
    assert.equal(books[0].reason.includes(bookPath), false);
    assert.equal(books[0].totalChars, 0);
  } finally {
    counter.restore();
  }
  // 恢复正常大小：行为逐字不变（错误码只在超限时出现）
  await fs.writeFile(metaPath, original);
  const meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters.length, 1);
  const booksAfter = await storage.listBooks(root);
  assert.equal(booksAfter[0].status, 'ok');
});

// ---------- V107（v1.8.0 WP-21）：书目章节条数硬上限（读侧） ----------
// IPC 写入侧 core/ipc-limits.js 早就按 20000 条截断，读侧以前只校验「chapters 是数组、每条有 file」：
// 手改 / 损坏的书目里塞进十万条章节记录时，书架扫描、排序、逐章 stat、索引构建都会按条数放大开销。
// 现在 readBookMeta 在形状校验之后补同一条硬上限，超限按「书目坏了」处理（与 INVALID_META 同族）。


test('V107/WP-21：正好 20000 章的书目放行，多一条明确报 META_TOO_MANY_CHAPTERS 且书卡 corrupt', async () => {
  const root = await mkTmp();
  const { path: bookPath, meta } = await storage.createBook(root, '章数上限');
  const metaPath = path.join(bookPath, storage.BOOK_FILE);
  const makeChapters = (count) =>
    Array.from({ length: count }, (_, i) => ({
      id: `ch_${String(i + 1).padStart(3, '0')}`,
      file: `${String(i + 1).padStart(3, '0')}-章${i + 1}.txt`,
      name: `章${i + 1}`,
      createdAt: '2026-01-01T00:00:00.000Z'
    }));
  const writeChapters = (count) =>
    fs.writeFile(metaPath, JSON.stringify({ ...meta, chapters: makeChapters(count) }), 'utf8');

  // 正好到上限：放行，条数原样（不静默截断）
  await writeChapters(storage.MAX_META_CHAPTERS);
  const atLimit = await storage.readBookMeta(bookPath);
  assert.equal(atLimit.chapters.length, storage.MAX_META_CHAPTERS);
  assert.equal(
    atLimit.chapters[storage.MAX_META_CHAPTERS - 1].file,
    `${String(storage.MAX_META_CHAPTERS).padStart(3, '0')}-章${storage.MAX_META_CHAPTERS}.txt`
  );

  // 多一条就报错：不向下跑（不迁移 / 不清洗 / 不进 bookStats），文案可读且不带本机路径
  await writeChapters(storage.MAX_META_CHAPTERS + 1);
  await assert.rejects(
    () => storage.readBookMeta(bookPath),
    (err) => {
      assert.equal(err.code, 'META_TOO_MANY_CHAPTERS');
      assert.match(err.message, new RegExp(`有 ${storage.MAX_META_CHAPTERS + 1} 条`));
      assert.match(err.message, new RegExp(`上限 ${storage.MAX_META_CHAPTERS}`));
      assert.equal(err.message.includes(bookPath), false, '错误文案不能带本机完整路径');
      return true;
    }
  );
  // 书架：书卡照常列出、标 corrupt、reason 就是那句可读文案；没有按 20001 章去逐章 stat
  const books = await storage.listBooks(root);
  assert.equal(books.length, 1);
  assert.equal(books[0].status, 'corrupt');
  assert.match(books[0].reason, /超过单本上限/);
  assert.equal(books[0].reason.includes(bookPath), false);
  assert.equal(books[0].chapterCount, 0);
  assert.equal(books[0].totalChars, 0);
});


test('显式保存仍更新 updatedAt：改章节状态 / 改名会写，扫描回填不写', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '保存测试');
  const created = await storage.readBookMeta(bookPath);
  const stamp = '2026-01-01T00:00:00.000Z';
  await fs.writeFile(
    path.join(bookPath, '书目.json'),
    JSON.stringify({ ...created, updatedAt: stamp }),
    'utf8'
  );
  // 扫描把这一章的字数补上，但 updatedAt 不许动。
  // 恒真陷阱：totalChars 是数字，『>= 0』恒成立；改成写死 5 字正文 + 抹掉字数缓存后按正文重算。
  await storage.saveChapterText(bookPath, created.chapters[0].file, '一二三四五');
  await fs.writeFile(
    path.join(bookPath, '书目.json'),
    JSON.stringify({ ...(await storage.readBookMeta(bookPath)), updatedAt: stamp }),
    'utf8'
  );
  await stripCharsCache(bookPath);
  const scanned = await storage.listBooks(root);
  assert.equal(scanned[0].totalChars, 5, '扫描按章正文回填字数');
  assert.equal((await storage.readBookMeta(bookPath)).updatedAt, stamp, '扫描回填不改 updatedAt');
  // 用户显式改章节状态 → 必须更新
  await new Promise((resolve) => setTimeout(resolve, 10));
  const updated = await storage.updateChapterMeta(bookPath, created.chapters[0].id, { status: 'done' });
  assert.equal(updated.changed, true);
  assert.notEqual(updated.meta.updatedAt, stamp, '显式保存必须更新 updatedAt');
  assert.ok(Date.parse(updated.meta.updatedAt) > Date.parse(stamp));
  // 用户显式改名 → 同样更新
  await new Promise((resolve) => setTimeout(resolve, 10));
  const renamed = await storage.renameChapter(bookPath, created.chapters[0].id, '新章名');
  assert.ok(Date.parse(renamed.meta.updatedAt) > Date.parse(updated.meta.updatedAt));
});

// ---------- 建书失败收尾（1.6.0 A3 / 审计 E-07） ----------
// 建书三步：建目录 → 写空章 txt → 写书目。中间任何一步失败，不许在书架里留下
// 「有文件夹、没书目」的空壳（书架会当成损坏书，用户删也删不干净）。


test('建书失败：收掉这次刚建的目录与空章文件，再建一次不受影响', async () => {
  const root = await mkTmp();
  const failingMeta = async () => {
    const err = new Error('写不进去');
    err.code = 'EPERM';
    throw err;
  };
  await assert.rejects(storage.createBook(root, '建书失败', { writeBookMeta: failingMeta }), (err) => err.code === 'EPERM');
  assert.deepEqual(await fs.readdir(root), [], '失败后不许留下空壳书目录');

  // 障碍消失后再建同名书：正常建出来（说明清理是幂等的，没有残留挡住重试）
  const ok = await storage.createBook(root, '建书失败');
  assert.equal(path.basename(ok.path), '建书失败');
  assert.deepEqual((await fs.readdir(ok.path)).sort(), ['001-未命名.txt', '书目.json']);

  // 目录里已经有别人的东西：只收掉这次新建的那个目录，已有文件一个不删
  const busyRoot = await mkTmp();
  await fs.mkdir(path.join(busyRoot, '有人用过的名字'));
  await fs.writeFile(path.join(busyRoot, '有人用过的名字', '别人的.txt'), '不要删我', 'utf8');
  await assert.rejects(
    storage.createBook(busyRoot, '有人用过的名字', { writeBookMeta: failingMeta }),
    (err) => err.code === 'EPERM'
  );
  assert.deepEqual(await fs.readdir(busyRoot), ['有人用过的名字'], '只收掉本次新建的「名字-2」');
  assert.equal(await fs.readFile(path.join(busyRoot, '有人用过的名字', '别人的.txt'), 'utf8'), '不要删我');
});

// ---------- 1.6.1 R3b：书架扫描的全局读盘上限（P-10） ----------
// 以前书架分层扫描：外层 12 本书 × 每本回填 8 章 = 峰值 96 路同时读正文。机械盘 / 杀软下
// 老书首次扫描会把盘打满，同时打开的书也跟着卡。现在整条链路共用一个常量：全局 ≤ 8
// = 外层 4 本 × 每本 2 章；单本直调（打开书 / 保存校验）不嵌套，仍按 8 路走。


test('书架扫描：1000 章并发峰值不超过全局上限 8（注入 reader 计数，不测墙钟）', async () => {
  const root = await mkTmp();
  const bookCount = 10;
  const perBook = 100;
  for (let b = 0; b < bookCount; b += 1) {
    const { path: bookPath } = await storage.createBook(root, `并发书${b}`);
    const meta = await storage.readBookMeta(bookPath);
    // 造「老书」书目：100 章都没有 chars 缓存。注入的 reader 不读盘，所以不用真建 100 个 txt
    const chapters = Array.from({ length: perBook }, (_, i) => ({
      id: `ch_${b}_${i}`,
      file: `${String(i + 1).padStart(3, '0')}-第${i + 1}章.txt`,
      name: `第 ${i + 1} 章`
    }));
    await fs.writeFile(path.join(bookPath, '书目.json'), JSON.stringify({ ...meta, chapters }), 'utf8');
  }

  let inFlight = 0;
  let peak = 0;
  let calls = 0;
  const books = await storage.listBooks(root, {
    readText: async () => {
      calls += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return '一二三四五';
    }
  });
  assert.equal(books.length, bookCount);
  assert.equal(calls, bookCount * perBook, '每个缺字数的章只读一次');
  assert.ok(peak <= 8, `并发峰值 ${peak} 超过全局上限 8（外层扫书 × 每本回填不许相乘放大）`);
  assert.ok(books.every((book) => book.totalChars === perBook * 5), '所有章字数都要回填');
});

// 还原「整本替换」只该重算真正被还原的那几章：以前把整本 meta.chapters 都传给
// refreshChapterChars，还原 1 章会把 1000 章正文全读一遍（白读盘、还原变慢）。


test('读盘失败脱敏：readBookMeta / listBooks 不回完整本机路径（E7 / WP-11）', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '读失败的书');
  await fs.mkdir(bookPath);
  // TB-04：fs 猴子补丁统一走 withFsPatch（defineProperty 安装 + finally 还原）；
  // 只对 书目.json 抛 EACCES，其余文件照常打开。
  const openImpl = (realOpen) => async (file, ...rest) => {
    if (String(file).endsWith('书目.json')) {
      throw Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { code: 'EACCES' });
    }
    return realOpen(file, ...rest);
  };
  await withFsPatch(fs, 'open', openImpl, async () => {
    await assert.rejects(
      () => storage.readBookMeta(bookPath),
      (err) => {
        assert.equal(err.code, 'EACCES', '错误码原样保留（界面与 E2E 按 code 分支）');
        assert.match(err.message, /^读取 书目\.json 失败：没有访问权限：/);
        assert.equal(err.message.includes(root), false, '不许带完整书架路径');
        assert.equal(/[A-Za-z]:[\\/]/.test(err.message), false, '不许带盘符路径');
        assert.match(err.message, /…\\书目\.json$/);
        return true;
      }
    );
    const books = await storage.listBooks(root);
    assert.equal(books.length, 1);
    const corrupt = books[0];
    assert.equal(corrupt.status, 'corrupt');
    // 损坏书卡的 reason 与主进程错误回包同一口径：只留「一句中文 + 最后一节文件名」
    assert.equal(corrupt.reason.includes(root), false, '损坏书卡 reason 不许带完整书架路径');
    assert.equal(/[A-Za-z]:[\\/]/.test(corrupt.reason), false, '损坏书卡 reason 不许带盘符路径');
    assert.match(corrupt.reason, /没有访问权限/);
  });
});


// ---------- 审计修复 #5（V301）：保存前校验带 expectedMtimeMs ----------


test('保存前校验（V301）：expectedMtimeMs 与磁盘一致 → 放行；被外部改过 → EXTERNAL_CHANGE 且一个字节都不写', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '外部改动');
  const meta = await storage.readBookMeta(bookPath);
  const chapter = meta.chapters[0];
  const filePath = path.join(bookPath, chapter.file);
  const loaded = await storage.statChapter(bookPath, chapter.file);

  // 载入后没变：带着载入 mtime 保存 → 允许
  const same = await storage.prepareChapterSave(bookPath, chapter.id, { expectedMtimeMs: loaded.mtimeMs });
  assert.equal(same.chapter.id, chapter.id);

  // 外部把 mtime 推后（记事本 / 同步盘落盘）：旧 expectedMtimeMs 必须被拦下
  const before = await fs.readFile(filePath, 'utf8');
  const future = new Date(Date.now() + 5000);
  await fs.utimes(filePath, future, future);
  await assert.rejects(
    () => storage.prepareChapterSave(bookPath, chapter.id, { expectedMtimeMs: loaded.mtimeMs }),
    (err) => err.code === 'EXTERNAL_CHANGE' && /应用外/.test(err.message) && /已阻止这次保存/.test(err.message)
  );
  assert.equal(await fs.readFile(filePath, 'utf8'), before, '被拦下的保存绝不写盘');

  // 重新 stat 拿到新 mtime → 又能保存（作者在对话框里选「仍然覆盖保存」后走的就是这条）
  const fresh = await storage.statChapter(bookPath, chapter.file);
  assert.notEqual(fresh.mtimeMs, loaded.mtimeMs);
  await storage.prepareChapterSave(bookPath, chapter.id, { expectedMtimeMs: fresh.mtimeMs });

  // 不带 expectedMtimeMs（老调用方 / 覆盖保存传 0）仍然放行
  await storage.prepareChapterSave(bookPath, chapter.id);
  await storage.prepareChapterSave(bookPath, chapter.id, { expectedMtimeMs: 0 });
});

// 审计修复 #32（▲V305）：书目已有重复章节 id 时，第一个保留、第二个及以后按「缺 id」同一套规则
// 重新分配 —— findChapterIndex 只认第一个，不修就会改名 / 删除 / 保存到错误的章。


test('审计 #32（▲V305）：重复章节 id 的第二个及以后重分配（第一个保留、编号不撞车）', () => {
  const ids = ['ch_002', 'ch_002', 'ch_002', 'ch_001'];
  const repairs = storage.reassignDuplicateChapterIds(ids);
  assert.deepEqual(
    repairs.map((item) => [item.index, item.from, item.to]),
    [
      [1, 'ch_002', 'ch_003'],
      [2, 'ch_002', 'ch_004']
    ]
  );
  assert.equal(ids[0], 'ch_002', '第一个保留原 id（既有事实不动）');
  assert.equal(new Set(ids).size, ids.length, '修完必须唯一');
  assert.deepEqual(storage.reassignDuplicateChapterIds(['ch_001', 'ch_005']), [], '没有重复时什么都不做');
});


test('审计 #32（▲V305）：读书目时自愈重复 id、按新 id 操作只作用到那一章、同一本书只记一条日志', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '重复 id 书');
  await storage.createChapter(bookPath, 1, '第二章');
  const metaPath = path.join(bookPath, '书目.json');
  const disk = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  const firstFile = disk.chapters[0].file;
  const secondFile = disk.chapters[1].file;
  disk.chapters = [
    { id: 'ch_007', file: firstFile, name: '第一章' },
    { id: 'ch_007', file: secondFile, name: '第二章' }
  ];
  disk.fileSeq = 2;
  await fs.writeFile(metaPath, JSON.stringify(disk, null, 2), 'utf8');

  const logged = [];
  storage.setDiagnostics({ logError: (kind, err) => logged.push({ kind, ...err }) });
  try {
    const meta = await storage.readBookMeta(bookPath);
    const ids = meta.chapters.map((chapter) => chapter.id);
    assert.equal(ids[0], 'ch_007', '第一个保留原 id');
    assert.notEqual(ids[1], 'ch_007', '第二个必须重分配');
    assert.equal(new Set(ids).size, 2, '修完必须唯一');
    assert.equal(logged.length, 1, '修过的书目要留一条诊断日志');
    assert.equal(logged[0].kind, 'meta-dup-id');
    assert.equal(logged[0].code, 'META_DUP_CHAPTER_ID');
    assert.match(logged[0].message, /重复章节 id/);

    // 书架扫描 / 打开会反复读同一本书：结果稳定、日志不重复写
    const again = await storage.readBookMeta(bookPath);
    assert.deepEqual(again.chapters.map((chapter) => chapter.id), ids);
    assert.equal(logged.length, 1, '同一本书一个进程只记一条');

    // 按第一个 id 改名只作用到第一章（第二个章现在有自己的 id）
    await storage.renameChapter(bookPath, ids[0], '只改第一章');
    const after = await storage.readBookMeta(bookPath);
    assert.equal(after.chapters.find((chapter) => chapter.file === firstFile).name, '只改第一章');
    assert.equal(after.chapters.find((chapter) => chapter.file === secondFile).name, '第二章');
  } finally {
    storage.setDiagnostics({});
  }
});

// 五-M33（IE-02）：只读长流程的在途租约 —— book:delete 的闸门要据此拒绝，保存 / 整理照常。


test('E1：writeBookMeta 写侧章数闸门（20,001 条拒绝写盘、原书目与 .bak 都不动）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '章数写闸');
  const metaPath = path.join(bookPath, storage.BOOK_FILE);
  const bakPath = path.join(bookPath, storage.BOOK_BAK);
  const before = await fs.readFile(metaPath, 'utf8');
  const meta = await storage.readBookMeta(bookPath);
  const makeChapters = (count) =>
    Array.from({ length: count }, (_, i) => ({
      id: `ch_${String(i + 1).padStart(5, '0')}`,
      file: `${String(i + 1).padStart(5, '0')}-章${i + 1}.txt`,
      name: `章${i + 1}`
    }));

  await assert.rejects(
    () => storage.writeBookMeta(bookPath, { ...meta, chapters: makeChapters(storage.MAX_META_CHAPTERS + 1) }, { structural: true }),
    (err) => {
      assert.equal(err.code, 'META_TOO_MANY_CHAPTERS');
      assert.match(err.message, /20,001 条/);
      assert.match(err.message, /20,000 条/);
      assert.equal(err.message.includes(bookPath), false, '错误文案不能带本机完整路径');
      return true;
    }
  );
  assert.equal(await fs.readFile(metaPath, 'utf8'), before, '拒绝时一个字节都不写');
  assert.equal(await storage.exists(bakPath), false, '.bak 也不轮换');

  // 正好到上限放行（闸门是「超过」才拒）—— 写一次真书目确认写侧不会把 20,000 章的正常书判死
  const saved = await storage.writeBookMeta(bookPath, { ...meta, chapters: makeChapters(storage.MAX_META_CHAPTERS) });
  assert.equal(saved.chapters.length, storage.MAX_META_CHAPTERS);
  assert.equal((await storage.readBookMeta(bookPath)).chapters.length, storage.MAX_META_CHAPTERS);
});

// I5（三审·低）：书名 / 章名写盘前统一 truncateSafe + 与 N2 同源的限长；空名保持旧行为。


test('I5：书名 / 章名写盘前统一限长（超长截断、空名不改名、不切开代理对）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '名称限长');
  const longName = '名'.repeat(limits.MAX_CHAPTER_NAME_CHARS + 30);

  const created = await storage.createChapterWithText(bookPath, { insertIndex: 1, name: longName, text: '正文' });
  assert.equal(created.chapter.name.length, limits.MAX_CHAPTER_NAME_CHARS, '建章：章名截到唯一上限');
  const renamed = await storage.renameChapter(bookPath, created.chapter.id, longName);
  assert.equal(renamed.chapter.name.length, limits.MAX_CHAPTER_NAME_CHARS, '改章名：同一条限长');

  const longTitle = '书'.repeat(limits.MAX_BOOK_TITLE_CHARS + 20);
  const renamedBook = await storage.renameBook(bookPath, longTitle);
  assert.equal(renamedBook.title.length, limits.MAX_BOOK_TITLE_CHARS, '改名：书名截到 N2 同源上限');
  const blank = await storage.renameBook(bookPath, '   ');
  assert.equal(blank.title, renamedBook.title, '空名 / 全空白保持旧行为（不改名）');

  // 截断点落在代理对中间时不能留下孤立代理（书目里存进去就再也修不回来）
  const emoji = `${'字'.repeat(limits.MAX_CHAPTER_NAME_CHARS - 1)}𠮷尾`;
  const withEmoji = await storage.createChapterWithText(bookPath, { insertIndex: 0, name: emoji, text: '' });
  assert.ok(withEmoji.chapter.name.length <= limits.MAX_CHAPTER_NAME_CHARS);
  assert.equal(/[\uD800-\uDBFF]$/.test(withEmoji.chapter.name), false, '不能留下孤立高位代理');
  const roundTrip = await storage.readBookMeta(bookPath);
  assert.equal(roundTrip.chapters.some((chapter) => chapter.id === withEmoji.chapter.id), true, '书名 / 章名照样能读回');
});

// N2（二轮·低）：建书书名与书籍信息字段（作者 80 / 分组 40 / 标签 20 / 简介 1000）同一套限长口径，
// 唯一常量在 core/limits.js；被截短时回包带 titleTruncated（渲染层据此明确提示，不静默改名）。
// 文件夹名另有 chapters.safeName 的 40 字清洗，两层互不替代。


test('N2：建书书名截到唯一上限并回报 titleTruncated；文件夹名仍走 40 字清洗', async () => {
  const root = await mkTmp();
  const longTitle = `  ${'书'.repeat(limits.MAX_BOOK_TITLE_CHARS + 20)}  `;
  const created = await storage.createBook(root, longTitle);
  assert.equal(created.titleTruncated, true, '超长书名要如实回报被截断');
  assert.equal(created.meta.title.length, limits.MAX_BOOK_TITLE_CHARS, '书名截到唯一上限');
  assert.equal(created.meta.title, longTitle.trim().slice(0, limits.MAX_BOOK_TITLE_CHARS));
  const onDisk = JSON.parse(await fs.readFile(path.join(created.path, '书目.json'), 'utf8'));
  assert.equal(onDisk.title, created.meta.title, '书目里写的就是截断后的书名');
  assert.ok(path.basename(created.path).length <= 40, '文件夹名另有 40 字清洗（旧口径不变）');

  const plain = await storage.createBook(root, '  正常书名  ');
  assert.equal(plain.titleTruncated, false, '正常书名不算截断');
  assert.equal(plain.meta.title, '正常书名');

  const blank = await storage.createBook(root, '   ');
  assert.equal(blank.titleTruncated, false, '空名回落「我的新书」，不算截断');
  assert.equal(blank.meta.title, '我的新书');

  // 截断点落在代理对中间时不留下孤立代理（书目里写进去就再也修不回来）
  const emoji = `${'字'.repeat(limits.MAX_BOOK_TITLE_CHARS - 1)}𠮷尾`;
  const emojiBook = await storage.createBook(root, emoji);
  assert.ok(emojiBook.meta.title.length <= limits.MAX_BOOK_TITLE_CHARS);
  assert.equal(/[\uD800-\uDBFF]$/.test(emojiBook.meta.title), false, '不能留下孤立高位代理');
  assert.equal(emojiBook.titleTruncated, true, '代理对回退也算截断');
});

test('#10：bookStats 的字数缓存写盘走「读时拍身份、写前核对」入口', () => {
  // 行为面：缓存写出后书目可读、字数落地（既有用例覆盖）。这里钉住「写缓存不再退回不核对身份的
  // writeBookMeta」——应用内并发由锁内重读 + mergeCharsCache 挡住，外部程序在「读 → 写」窗口的
  // 改动只能靠 stamp 核对拦住（清单 #10）。
  const syncFs = require('node:fs');
  const source = syncFs.readFileSync(path.join(__dirname, '..', 'core', 'storage.js'), 'utf8');
  const start = source.indexOf('async function bookStats(');
  assert.ok(start > 0, 'bookStats 还在（改名前请同步本断言）');
  const block = source.slice(start, source.indexOf('\n// 打开书/保存后校验用', start));
  assert.match(block, /writeBookMetaChecked\(bookPath, merged\.meta, \{ touchUpdatedAt: false \}\)/);
  assert.equal(
    /(?<!Checked\()writeBookMeta\(bookPath, merged\.meta/.test(block),
    false,
    '缓存写入不许退回不核对身份的 writeBookMeta'
  );
});

// ---------- META-01：两条章节记录指向同一个正文文件 ----------
// 外部工具（同步盘冲突合并 / 脚本批量改 / 手改 JSON）可能写出「两章共用一个 file」的书目。
// 这不是可自动修复的形状：findChapterIndex 只认 id，删 / 改名其中一条会把另一条正在用的文件
// 移走 / 改掉，保存又写同一份文件（两章内容互相覆盖）。读侧必须按损坏拒绝（书卡标 corrupt、
// 引导修复），绝不能让写入口带着它继续跑。
async function writeDuplicateFileMeta(bookPath, mutate) {
  const metaPath = path.join(bookPath, '书目.json');
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  mutate(meta);
  await fs.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

test('META-01：两章同 file 的书目按 INVALID_META 拒绝，书卡 corrupt，deleteChapter 不误移另一章', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '同文件两章');
  const metaPath = path.join(bookPath, '书目.json');
  const chapterFile = '001-未命名.txt';
  await storage.saveChapterText(bookPath, chapterFile, '两个章节记录指着同一份正文。');
  const chapterPath = path.join(bookPath, chapterFile);
  await writeDuplicateFileMeta(bookPath, (meta) => {
    meta.chapters = [
      { ...meta.chapters[0], id: 'ch_700', file: chapterFile },
      { ...meta.chapters[0], id: 'ch_701', file: chapterFile }
    ];
  });

  // ① 读侧：名字 / 位置都要点名，方便作者照着手改恢复
  await assert.rejects(
    () => storage.readBookMeta(bookPath),
    (err) => {
      assert.equal(err.code, 'INVALID_META');
      assert.match(err.message, /同一个正文文件/);
      assert.match(err.message, /001-未命名\.txt/);
      assert.match(err.message, /第 1 条与第 2 条/);
      assert.equal(err.message.includes(bookPath), false, '错误文案不带本机完整路径');
      return true;
    }
  );

  // ② 书架：书卡照常列出并标 corrupt，字数不把同一份正文算两遍
  const books = await storage.listBooks(root);
  assert.equal(books.length, 1);
  assert.equal(books[0].status, 'corrupt');
  assert.match(books[0].reason, /同一个正文文件/);
  assert.equal(books[0].totalChars, 0);

  // ③ 删章：坏书目必须在任何副作用（建 _trash / rename / 写书目）之前被拒，另一章的文件原地不动
  await assert.rejects(() => storage.deleteChapter(bookPath, 'ch_700'), (err) => err.code === 'INVALID_META');
  assert.equal(await fs.readFile(chapterPath, 'utf8'), '两个章节记录指着同一份正文。', '正文一个字节都不许动');
  assert.equal(
    require('node:fs').existsSync(path.join(bookPath, '_trash')),
    false,
    '拒绝必须发生在建 _trash 之前（不给坏书目留半成品）'
  );

  // ④ 大小写写法不同也算同一个文件（Windows 文件系统大小写不敏感），同样按损坏处理
  await writeDuplicateFileMeta(bookPath, (meta) => {
    meta.chapters = [
      { ...meta.chapters[0], id: 'ch_700', file: chapterFile },
      { ...meta.chapters[0], id: 'ch_701', file: '001-未命名.TXT' }
    ];
  });
  await assert.rejects(() => storage.readBookMeta(bookPath), (err) => err.code === 'INVALID_META');

  // ⑤ 修回唯一 file：读侧恢复正常（判据只看 file 集合，不误伤正常书目）
  await writeDuplicateFileMeta(bookPath, (meta) => {
    meta.chapters = [{ ...meta.chapters[0], id: 'ch_700', file: chapterFile }];
    meta.fileSeq = 1;
  });
  const fixed = await storage.readBookMeta(bookPath);
  assert.equal(fixed.chapters.length, 1);
  assert.equal((await storage.listBooks(root))[0].status, 'ok');
});
