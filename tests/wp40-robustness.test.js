'use strict';
// WP-40（X6 / X8 / X9 / X10 / X11）：健壮性小项。
//
// 这些锚点钉的是「极端场景下不出错」的承诺，而不是新功能：
//   X6  自动机缓存命中后先核对词表等值，指纹碰撞时重建（不静默复用错图 / 不串 patternIndex）；
//   X8  原子写的孤儿临时文件回收：只认本应用命名 + 非本进程 pid + 超过 1 小时；启动清 userData、
//       打开书清本书目录；正文 / 书目 / 新鲜临时文件一个不碰；
//   X9  搜索索引首载并发共享同一趟读盘（第二个调用方不再先拿到空索引）；
//   X10 碎片 store 缓存改 LRU + 仅空闲淘汰（正在写的实例绝不挤掉 → 不会同根两条写队列）；
//   X11 index.html 脚本 defer 评估结论 = 保持同步加载（顺序闸门优先），有静态锚点。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const atomic = require('../core/atomic');
const fragments = require('../core/fragments');
const search = require('../core/search-index');
const wordscan = require('../core/wordscan');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const tmpCleanup = require('./tmp-cleanup');

async function mkTmp(prefix = 'cw-wp40-') {
  return tmpCleanup.track(await fsp.mkdtemp(path.join(os.tmpdir(), prefix)));
}

// ---------- X6：自动机缓存等值兜底 ----------

test('X6：wordscan 缓存命中先核对词表等值——指纹碰撞时重建，不静默复用错图', () => {
  wordscan.resetAutomatonCache();
  const a = ['甲', '甲乙'];
  const b = ['甲乙', '甲']; // 同一个「甲乙」在两份词表里的下标不同
  const forced = () => 'forced-collision';
  const first = wordscan.scanTerms('甲乙', a, { fingerprint: forced });
  assert.deepEqual(
    first.hits.map((hit) => [a[hit.patternIndex], hit.index, hit.length]),
    [['甲乙', 0, 2]]
  );
  const second = wordscan.scanTerms('甲乙', b, { fingerprint: forced });
  assert.deepEqual(
    second.hits.map((hit) => [b[hit.patternIndex], hit.index, hit.length]),
    [['甲乙', 0, 2]],
    '碰撞后必须按新词表重建（复用旧图会拿到「甲」/长度 1，张冠李戴）'
  );
  const stats = wordscan.automatonCacheStats();
  assert.equal(stats.collisions, 1, '指纹撞车 + 词表不等值要记一次碰撞');
  assert.equal(stats.builds, 2, '碰撞只多建一次图');

  // 等值但不同引用的词表 = 正常命中（缓存的意义所在），不能误判成碰撞
  wordscan.resetAutomatonCache();
  const forced2 = () => 'forced-reuse';
  wordscan.scanTerms('甲乙', a, { fingerprint: forced2 });
  const reused = wordscan.scanTerms('甲乙', a.slice(), { fingerprint: forced2 });
  assert.deepEqual(
    reused.hits.map((hit) => [a[hit.patternIndex], hit.index]),
    [['甲乙', 0]]
  );
  const reuseStats = wordscan.automatonCacheStats();
  assert.equal(reuseStats.builds, 1);
  assert.equal(reuseStats.hits, 1);
  assert.equal(reuseStats.collisions, 0);

  // 原地改数组不能骗过等值核对：缓存留存的是建图那一刻的词表快照
  wordscan.resetAutomatonCache();
  const mutable = ['甲'];
  const forced3 = () => 'forced-mutate';
  wordscan.scanTerms('甲', mutable, { fingerprint: forced3 });
  mutable[0] = '乙';
  const after = wordscan.scanTerms('乙', mutable, { fingerprint: forced3 });
  assert.deepEqual(
    after.hits.map((hit) => [mutable[hit.patternIndex], hit.index]),
    [['乙', 0]]
  );
  assert.equal(wordscan.automatonCacheStats().collisions, 1, '快照与原地修改后的数组不等值 → 按碰撞重建');
});

test('X6：samePatterns 的边界（引用快路径 / 长度 / 顺序 / 脏条目）', () => {
  const base = ['甲', '乙'];
  assert.equal(wordscan.samePatterns(base, base), true);
  assert.equal(wordscan.samePatterns(base, ['甲', '乙']), true);
  assert.equal(wordscan.samePatterns(base, ['乙', '甲']), false);
  assert.equal(wordscan.samePatterns(base, ['甲']), false);
  assert.equal(wordscan.samePatterns(['a', null, 5], ['a', null, 5]), true);
  assert.equal(wordscan.samePatterns(['a', null, 5], ['a', undefined, 5]), false);
  assert.equal(wordscan.samePatterns(null, ['甲']), false);
  assert.equal(wordscan.samePatterns(['甲'], null), false);
});

// ---------- X8：原子写孤儿临时文件回收 ----------

test('X8：临时文件命名解析只认本应用格式', () => {
  assert.deepEqual(atomic.parseTmpName('.001-旧车站.txt.tmp-12345-1700000000000-ab12cd'), {
    base: '001-旧车站.txt',
    pid: 12345,
    stamp: 1700000000000,
    tag: 'ab12cd'
  });
  assert.equal(atomic.parseTmpName('普通.txt'), null);
  assert.equal(atomic.parseTmpName('.a.txt.tmp-abc'), null);
  assert.equal(atomic.parseTmpName('.a.txt.tmp-1-2'), null);
  assert.equal(atomic.parseTmpName('.a.txt.tmp-1-2-AB'), null);
  assert.equal(atomic.parseTmpName(null), null);
  assert.equal(atomic.ORPHAN_TMP_MIN_AGE_MS, 60 * 60 * 1000);
});

test('X8：孤儿回收只删「本应用命名 + 非本进程 + 超过阈值」，正文 / 新鲜文件 / 同名目录不动', async () => {
  const dir = await mkTmp();
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const orphan = path.join(dir, '.001-旧章.txt.tmp-99999-1700000000000-orphan1');
  const ownPid = path.join(dir, `.001-旧章.txt.tmp-${process.pid}-1700000000000-ownpid`);
  const fresh = path.join(dir, `.002-新章.txt.tmp-88888-${Date.now()}-fresh1`);
  const normal = path.join(dir, '001-旧章.txt');
  const strange = path.join(dir, '.笔记.tmp-不是我们的');
  const dirNamedLikeTmp = path.join(dir, '.003-目录.txt.tmp-777-1700000000000-dirname');
  await Promise.all([orphan, ownPid, fresh, normal, strange].map((file) => fsp.writeFile(file, '正文', 'utf8')));
  await fsp.utimes(orphan, old, old);
  await fsp.utimes(ownPid, old, old); // 本进程的临时文件再老也不删（可能正在写）
  await fsp.mkdir(dirNamedLikeTmp);

  const result = await atomic.cleanupOrphanTmpFiles(dir);
  assert.deepEqual(result, { removed: 1, kept: 2 }, '只删 1 个孤儿；本进程 / 新鲜的各留 1 个');

  const left = (await fsp.readdir(dir)).sort();
  assert.deepEqual(
    left,
    [path.basename(ownPid), path.basename(fresh), path.basename(normal), path.basename(strange), path.basename(dirNamedLikeTmp)].sort()
  );
  assert.equal(await fsp.readFile(normal, 'utf8'), '正文', '正文一个字节不动');
});

test('CSTO-A06：depth>0 时回收备份子目录里的孤儿；depth 默认只扫单层（书目录内的旧行为不变）', async () => {
  const dir = await mkTmp();
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  // 书内 _trash 的备份目录：atomicCopyFile 的临时文件正是建在这里
  const backupDir = path.join(dir, '_trash', '替换备份-2026-11-01-10-00-00');
  await fsp.mkdir(backupDir, { recursive: true });
  const nestedOrphan = path.join(backupDir, '.001-起风.txt.tmp-99999-1700000000000-nested');
  const nestedNormal = path.join(backupDir, '001-起风.txt');
  await Promise.all([nestedOrphan, nestedNormal].map((file) => fsp.writeFile(file, '正文', 'utf8')));
  await fsp.utimes(nestedOrphan, old, old);

  // 默认 depth=0：不碰子目录（书目录自己那一层的老行为不变）
  assert.deepEqual(await atomic.cleanupOrphanTmpFiles(dir), { removed: 0, kept: 0 });
  assert.equal(await fsp.readFile(nestedOrphan, 'utf8'), '正文', '没开 depth 时子目录里的文件不动');

  // depth=2：_trash → 备份组 → 文件，落到备份子目录里的孤儿被回收，同层的正常章节不动
  assert.deepEqual(await atomic.cleanupOrphanTmpFiles(dir, { depth: 2 }), { removed: 1, kept: 0 });
  assert.equal(await fsp.readFile(nestedNormal, 'utf8'), '正文', '备份里的正常章节一个字节不动');
  assert.equal(await fsp.readFile(nestedOrphan, 'utf8').then(() => true, () => false), false, '孤儿必须被删掉');
});

test('X8：回收对不存在的目录 / 空路径是空操作，阈值可注入（0 = 只排除本进程 pid）', async () => {
  const missing = path.join(os.tmpdir(), `cw-wp40-missing-${Date.now()}`);
  assert.deepEqual(await atomic.cleanupOrphanTmpFiles(missing), { removed: 0, kept: 0 });
  assert.deepEqual(await atomic.cleanupOrphanTmpFiles(''), { removed: 0, kept: 0 });
  assert.deepEqual(await atomic.cleanupOrphanTmpFiles(null), { removed: 0, kept: 0 });

  const dir = await mkTmp();
  const modern = path.join(dir, '.a.txt.tmp-777-1-modern');
  await fsp.writeFile(modern, 'x', 'utf8');
  // now 注入 + 阈值 0：只要不是本进程 pid 就删（NTFS 的 mtime 可能比 Date.now() 超前零点几毫秒，
  // 所以把 now 明确推后，让「够不够老」只由阈值决定）。
  assert.deepEqual(
    await atomic.cleanupOrphanTmpFiles(dir, { olderThanMs: 0, now: Date.now() + 5000 }),
    { removed: 1, kept: 0 }
  );
});

test('X8：启动清 userData、打开书清本书目录，删除判据只在 core/atomic.js 一份', () => {
  const atomicSrc = read('core/atomic.js');
  assert.match(atomicSrc, /const TMP_FILE_RE = \/\^\\\.\(\.\+\)\\\.tmp-/, '临时文件命名模式在 atomic.js');
  assert.match(atomicSrc, /parsed\.pid === process\.pid/, '本进程临时文件一律不动');
  assert.match(atomicSrc, /nowMs - info\.mtimeMs < minAgeMs/, '新鲜临时文件一律不动');
  assert.equal(
    (atomicSrc.match(/\.\$\{base\}\.tmp-\$\{process\.pid\}-/g) || []).length,
    2,
    '两个原子写入口共用同一套命名（atomicWriteFile / atomicWriteFileStream）'
  );

  const mainSrc = read('main.js');
  assert.match(
    mainSrc,
    /await getConfig\(\)[\s\S]{0,900}cleanupOrphanTmpFiles\(app\.getPath\('userData'\)\)/,
    '启动时清 userData 的孤儿临时文件（在 getConfig 之后）'
  );

  const storageSrc = read('core/storage.js');
  const openAt = storageSrc.indexOf('async function openBook(bookPath) {');
  assert.ok(openAt > 0, 'storage.openBook 必须在');
  const openBody = storageSrc.slice(openAt, openAt + 900);
  // CSTO-A06：打开书时不仅要清书目录，还要往下扫 _trash 的备份子目录（atomicCopyFile 的临时文件
  // 建在目标目录里），所以这里认「带 depth 参数的调用」，而不是要求恰好只传目录。
  const cleanupAt = openBody.search(/cleanupOrphanTmpFiles\(bookPath,\s*\{\s*depth:\s*([1-9]\d*)\s*\}\)/);
  const readAt = openBody.indexOf('readBookMeta(bookPath)');
  assert.ok(cleanupAt > 0, '打开书时必须清本书目录（含 _trash 备份子目录）的孤儿临时文件');
  assert.ok(readAt > cleanupAt, '清理要排在读书目之前（读完再清已经晚了）');

  // 回收实现 / 命名模式不许在别处再抄一份
  for (const [rel, src] of [['main.js', mainSrc], ['core/storage.js', storageSrc]]) {
    assert.ok(!src.includes('TMP_FILE_RE'), `${rel} 不许再抄一份临时文件命名模式`);
    assert.ok(!src.includes('function cleanupOrphanTmpFiles'), `${rel} 不许再抄一份回收实现`);
  }
});

// ---------- X9：搜索索引首载竞态 ----------

function pad3(n) {
  return String(n).padStart(3, '0');
}

async function makeBook(booksRoot, folder, title, chapters) {
  const bookPath = path.join(booksRoot, folder);
  await fsp.mkdir(bookPath, { recursive: true });
  const meta = {
    version: 1,
    id: `b_${folder}`,
    title,
    titleTemplate: '第{num}章',
    fileSeq: chapters.length,
    chapters: [],
    createdAt: '2026-10-31T12:00:00.000Z'
  };
  for (let index = 0; index < chapters.length; index += 1) {
    const chapter = chapters[index];
    const file = `${pad3(index + 1)}-${chapter.name}.txt`;
    await fsp.writeFile(path.join(bookPath, file), chapter.text, 'utf8');
    meta.chapters.push({
      id: `ch_${pad3(index + 1)}`,
      file,
      name: chapter.name,
      createdAt: '2026-10-31T12:00:00.000Z'
    });
  }
  await fsp.writeFile(path.join(bookPath, '书目.json'), JSON.stringify(meta, null, 2), 'utf8');
  return bookPath;
}

test('X9：索引首载并发共享同一趟读盘——第二个调用方不会再先拿到空索引', async () => {
  const base = await mkTmp();
  const userData = path.join(base, 'userdata');
  const booksRoot = path.join(base, 'books');
  await fsp.mkdir(userData, { recursive: true });
  await fsp.mkdir(booksRoot, { recursive: true });
  await makeBook(booksRoot, '测试书', '测试书', [{ name: '旧车站', text: '雨还在下，他在旧车站等谁。' }]);

  // 先借 ensure 写出一份真索引文件
  const writer = search.createSearchStore({ userDataDir: userData, validateIntervalMs: 0 });
  const built = await writer.ensure({ booksRoot, force: true });
  assert.equal(built.books, 1);
  const indexPath = path.join(userData, search.INDEX_FILE_NAME);
  assert.ok((await fsp.stat(indexPath)).size > 0);

  const store = search.createSearchStore({ userDataDir: userData, validateIntervalMs: 0 });
  // 审计修复 #45（S8）：首载改成 open → fstat → handle.readFile，这里改为卡住 open 来观察并发共享。
  const realOpen = fsp.open;
  let indexReads = 0;
  let releaseRead;
  const readGate = new Promise((resolve) => {
    releaseRead = resolve;
  });
  fsp.open = async (...args) => {
    if (String(args[0]) === indexPath) {
      indexReads += 1;
      await readGate;
    }
    return realOpen(...args);
  };
  try {
    const first = store.load();
    const second = store.load();
    assert.equal(second, first, '并发首载必须共享同一个读盘 Promise');
    let secondSettled = false;
    second.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      }
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(secondSettled, false, '读盘尚未完成时，第二次 load 不许先返回空索引');
    assert.equal(store.getIndex().books.length, 0, '读盘完成前内存里仍是空索引');
    releaseRead();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(b, a, '两个调用方拿到同一份索引');
    assert.equal(a.books.length, 1);
    assert.equal(indexReads, 1, '首载只读一次盘');
    assert.equal((await store.load()).books.length, 1, '已加载后直接复用内存索引');
    assert.equal(indexReads, 1);
  } finally {
    fsp.open = realOpen;
  }
});

test('X9：首载读盘失败也只尝试一次（与原口径一致），并发失败不会卡住后续调用', async () => {
  const base = await mkTmp();
  const userData = path.join(base, 'userdata');
  const booksRoot = path.join(base, 'books');
  await fsp.mkdir(userData, { recursive: true });
  await fsp.mkdir(booksRoot, { recursive: true });
  const indexPath = path.join(userData, search.INDEX_FILE_NAME);
  await fsp.writeFile(indexPath, '{"version":1,"books":[]}', 'utf8');

  // 审计修复 #45（S8）：读盘入口改成 open（失败码也从这里出），模拟读失败要卡在 open 上。
  const realOpen = fsp.open;
  let reads = 0;
  fsp.open = async (...args) => {
    if (String(args[0]) === indexPath) {
      reads += 1;
      throw Object.assign(new Error('EACCES: 模拟读失败'), { code: 'EACCES' });
    }
    return realOpen(...args);
  };
  const store = search.createSearchStore({ userDataDir: userData, validateIntervalMs: 0 });
  try {
    const [a, b] = await Promise.all([store.load(), store.load()]);
    assert.equal(b, a, '并发失败也共享同一趟读盘');
    assert.equal(a.books.length, 0);
    assert.equal(store.getProblem(), 'EACCES', '错误码照旧记进 problem');
    assert.equal(reads, 1, '并发只读一次');
    await store.load();
    assert.equal(reads, 1, '进程内只尝试一次（后续由 ensure 走重建 / 自愈）');
  } finally {
    fsp.open = realOpen;
  }
});

// ---------- X10：碎片 store 缓存 LRU + 仅空闲淘汰 ----------

function fakeStoreFactory() {
  const created = [];
  const factory = () => {
    const store = {
      busy: false,
      hasPendingWrites() {
        return this.busy;
      }
    };
    created.push(store);
    return store;
  };
  return { created, factory };
}

const cacheKey = (root) => path.resolve(String(root)).toLowerCase();

test('X10：store 缓存按 LRU 淘汰（命中算最近使用），不是按创建顺序', () => {
  fragments.resetFragmentStoreCache();
  const { created, factory } = fakeStoreFactory();
  const root = (name) => path.join(os.tmpdir(), `cw-wp40-lru-${name}`);

  const a = fragments.getFragmentStore(root('a'), { storeFactory: factory });
  const b = fragments.getFragmentStore(root('b'), { storeFactory: factory });
  assert.notEqual(a, b);
  assert.equal(fragments.getFragmentStore(root('a'), { storeFactory: factory }), a, '同根命中同一实例');

  const c = fragments.getFragmentStore(root('c'), { storeFactory: factory });
  assert.equal(created.length, 3, 'a / b / c 各建一次');
  assert.deepEqual(
    fragments.fragmentStoreCacheKeys(),
    [cacheKey(root('a')), cacheKey(root('c'))],
    'B 最久没用被淘汰；A 因刚命中保留'
  );
  assert.equal(fragments.getFragmentStore(root('c'), { storeFactory: factory }), c);
  assert.equal(fragments.fragmentStoreCacheKeys().length, fragments.STORE_CACHE_MAX);

  // B 已被淘汰：再取会新建（不是原来的对象）
  const b2 = fragments.getFragmentStore(root('b'), { storeFactory: factory });
  assert.notEqual(b2, b, '被淘汰的根目录再取要新建实例');
  assert.equal(created.length, 4);
});

test('X10：正在写的 store 绝不淘汰（宁可临时超上限），空闲后才回到上限', () => {
  const root = (name) => path.join(os.tmpdir(), `cw-wp40-busy-${name}`);

  // 场景 1：最久没用的 A 正忙 → 跳过 A、淘汰 B
  fragments.resetFragmentStoreCache();
  const first = fakeStoreFactory();
  const a = fragments.getFragmentStore(root('a'), { storeFactory: first.factory });
  a.busy = true;
  const b = fragments.getFragmentStore(root('b'), { storeFactory: first.factory });
  const c = fragments.getFragmentStore(root('c'), { storeFactory: first.factory });
  assert.equal(fragments.fragmentStoreCacheKeys().length, fragments.STORE_CACHE_MAX);
  assert.equal(fragments.getFragmentStore(root('a'), { storeFactory: first.factory }), a, '忙的 A 不能被挤掉');
  assert.equal(fragments.getFragmentStore(root('c'), { storeFactory: first.factory }), c);
  const b2 = fragments.getFragmentStore(root('b'), { storeFactory: first.factory });
  assert.notEqual(b2, b, 'B 空闲且更久没用 → 被淘汰');

  // 场景 2：全部在忙 → 缓存临时超过上限（也绝不挤掉在写实例）
  fragments.resetFragmentStoreCache();
  const second = fakeStoreFactory();
  const x = fragments.getFragmentStore(root('x'), { storeFactory: second.factory });
  const y = fragments.getFragmentStore(root('y'), { storeFactory: second.factory });
  x.busy = true;
  y.busy = true;
  const z = fragments.getFragmentStore(root('z'), { storeFactory: second.factory });
  assert.equal(
    fragments.fragmentStoreCacheKeys().length,
    fragments.STORE_CACHE_MAX + 1,
    '全忙时宁可临时超上限，也不制造同根第二条写队列'
  );
  assert.equal(fragments.getFragmentStore(root('z'), { storeFactory: second.factory }), z);

  // 忙完以后：下一次新增按 LRU 把空闲实例淘汰回上限
  x.busy = false;
  y.busy = false;
  const w = fragments.getFragmentStore(root('w'), { storeFactory: second.factory });
  assert.deepEqual(
    fragments.fragmentStoreCacheKeys(),
    [cacheKey(root('z')), cacheKey(root('w'))],
    '回到上限：最久没用的 X / Y 依次淘汰'
  );
  assert.equal(fragments.getFragmentStore(root('w'), { storeFactory: second.factory }), w);
});

test('X10：真 store 的 hasPendingWrites 覆盖排队与在跑，写完成后复位', async () => {
  const root = await mkTmp();
  const store = fragments.createFragmentStore(root);
  assert.equal(store.hasPendingWrites(), false, '空闲时不算忙');

  const first = store.create('第一条碎片');
  const second = store.create('第二条碎片');
  assert.equal(store.hasPendingWrites(), true, '排队的写也算忙（缓存淘汰要看这条）');
  const [a, b] = await Promise.all([first, second]);
  assert.equal(store.hasPendingWrites(), false, '全部写完必须复位');
  assert.notEqual(a.name, b.name);

  await assert.rejects(store.create('   '), /碎片内容是空的/);
  assert.equal(store.hasPendingWrites(), false, '失败路径也要复位');
});

// ---------- X11：index.html 脚本 defer 评估 ----------

test('X11：index.html 脚本 defer 评估结论 = 保持同步加载（顺序闸门优先）', () => {
  const html = read('renderer/index.html');
  assert.ok(html.includes('X11（v1.8.0 WP-40）评估结论'), 'index.html 要写明 defer 的评估结论');
  assert.match(html, /保持同步加载、严格按依赖顺序执行，不加 defer \/ async/);
  assert.ok(!/<script[^>]*\basync\b/.test(html), 'async 会打乱依赖顺序，不许出现');
  assert.ok(!/<script[^>]*\bdefer\b/.test(html), '当前结论是不加 defer；要加先整体改顺序闸门与 UMD 浏览器链');

  const tags = Array.from(html.matchAll(/<script\s+src="([^"]+)"><\/script>/g), (match) => match[1]);
  assert.ok(tags.length > 60, `脚本数量不应减少（实际 ${tags.length}）`);
  assert.equal(tags[0], '../core/common.js', 'common.js 仍排第一（UMD 依赖链的根）');
  assert.equal(tags[tags.length - 1], 'renderer.js', 'renderer.js 仍排最后（装配所有模块）');
  assert.ok(html.lastIndexOf('<script ') < html.lastIndexOf('</body>'), '脚本块仍在 </body> 之前');
});