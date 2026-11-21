// A4（审计 #11 / O3、P6）：同一本书的「读-改-写」串行化统一到 core/common.js 的 keyed 写队列，
// 书锁条目随链 settle 回收，删书 / 换书架根目录时还有主动回收。
//
// 这一轮是纯重构：对外行为（同书串行 / 异书并行 / 失败不堵 / idle 语义）必须零变化，
// 所以测试分两层：
//   1. 行为：withBookLock 的四条旧语义逐条钉住（含「大小写不同的同一路径算一把锁」）；
//   2. 回收：链 settle 后条目数回到基线（Map 不再只增不删）、主动回收绝不拆正在飞的链；
//      另加一条静态闸门，防止 storage 里再长出第二份 promise 链、main.js 的两个回收入口被删。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const storage = require('../core/storage');
const common = require('../core/common');
const tmpCleanup = require('./tmp-cleanup');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// 等一拍让「settle 后回收」的微任务跑完（回收发生在 settled.then 里，晚于调用方的 await）
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('withBookLock：同一本书（含大小写不同的同一路径）严格串行', async () => {
  const order = [];
  const first = storage.withBookLock('C:\\Books\\A', async () => {
    order.push('a1:start');
    await common.sleep(15);
    order.push('a1:end');
  });
  const second = storage.withBookLock('c:\\books\\a', async () => {
    order.push('a2:start');
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['a1:start', 'a1:end', 'a2:start'], '同一路径的写操作必须串行（大小写不敏感）');
});

test('withBookLock：不同书的写操作互不排队', async () => {
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = storage.withBookLock('C:\\Books\\parallel-a', async () => {
    await gate;
  });
  let secondRan = false;
  const second = storage.withBookLock('C:\\Books\\parallel-b', async () => {
    secondRan = true;
  });
  await second;
  assert.equal(secondRan, true, '第二本书不该等第一本书的锁');
  releaseFirst();
  await first;
});

test('withBookLock：一个任务失败不会堵住同一本书后面的写操作', async () => {
  const bookPath = 'C:\\Books\\failure';
  await assert.rejects(
    storage.withBookLock(bookPath, async () => {
      throw new Error('写盘失败');
    }),
    /写盘失败/
  );
  assert.equal(await storage.withBookLock(bookPath, async () => 'ok'), 'ok', '失败的任务不能堵死后面的任务');
});

test('withBookLock：链 settle 后锁条目被回收（Map 不再只增不删）', async () => {
  const bookPath = 'C:\\Books\\recycle';
  const before = storage.bookLockCount();
  const running = storage.withBookLock(bookPath, async () => {
    await common.sleep(5);
  });
  assert.equal(storage.bookLockCount(), before + 1, '排队 / 在跑期间应有一条锁记录');
  await running;
  await flush();
  assert.equal(storage.bookLockCount(), before, '链跑完后条目必须回收');
});

test('withBookLock：主动回收只清空闲条目，正在飞的链绝不拆', async () => {
  const bookPath = 'C:\\Books\\live-clear';
  const before = storage.bookLockCount();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const running = storage.withBookLock(bookPath, async () => {
    await gate;
  });
  assert.equal(storage.clearBookLock(bookPath), false, '在飞条目不能拆');
  assert.equal(storage.bookLockCount(), before + 1, '拆了锁，后来者就会和它并发');
  storage.clearBookLocks(); // 换书架根目录时的全量主动回收同样不拆在飞条目
  assert.equal(storage.bookLockCount(), before + 1);
  release();
  await running;
  await flush();
  assert.equal(storage.bookLockCount(), before);
});

// ---------------------------------------------------------------- 审计修复 #55（M6）
// 三个底层写入口（writeBookMeta / saveChapterText / prepareChapterSave）出口内置书锁后，
// 已经在 withBookLock 里的调用（主进程 chapter:save 的「读-改-写」整段）必须能重入，不能自己等自己。

test('withBookLock：同一本书在已持锁上下文里可重入（不新增队列条目、不死锁）', async () => {
  const bookPath = 'C:\\Books\\reentrant';
  const before = storage.bookLockCount();
  let nestedRan = false;
  let countInside = -1;
  const outer = storage.withBookLock(bookPath, async () => {
    countInside = storage.bookLockCount();
    await storage.withBookLock(bookPath, async () => {
      nestedRan = true;
    });
    assert.equal(storage.bookLockCount(), countInside, '重入不能往同一条链里再排一个条目');
  });
  // 死锁会让 outer 永远 pending；用超时把它变成可读的失败，而不是整轮测试挂住
  await Promise.race([
    outer,
    common.sleep(800).then(() => {
      throw new Error('withBookLock 同书重入死锁');
    })
  ]);
  assert.equal(nestedRan, true, '重入任务必须真的执行');
  assert.equal(countInside, before + 1, '外层持锁期间只有一条队列条目');
  await flush();
  assert.equal(storage.bookLockCount(), before);
});

test('withBookLock：持锁期间锁另一本书仍是独立链（不把两本书并成一把锁）', async () => {
  let otherRan = false;
  await storage.withBookLock('C:\\Books\\outer-a', async () => {
    await storage.withBookLock('C:\\Books\\outer-b', async () => {
      otherRan = true;
    });
  });
  assert.equal(otherRan, true);
});

test('三个内置锁写入口：在 withBookLock 里按 chapter:save 的顺序整段调用不丢结果（M6）', async () => {
  const dir = await tmpCleanup.mkTmp('cw-write-lock-');
  try {
    const created = await storage.createBook(dir, '锁内保存');
    const bookPath = created.path;
    const chapter = created.meta.chapters[0];
    // 与 main.js 的 chapter:save 同形：外层 withBookLock + 三个已内置锁的写入口
    const saved = await storage.withBookLock(bookPath, async () => {
      const prepared = await storage.prepareChapterSave(bookPath, chapter.id);
      const result = await storage.saveChapterText(bookPath, prepared.chapter.file, '锁内正文\n');
      prepared.chapter.chars = result.chars;
      return storage.writeBookMeta(bookPath, prepared.meta, { ensureDir: false });
    });
    assert.equal(saved.chapters[0].chars, 4, '书目缓存里的字数要随保存更新');
    assert.equal((await storage.loadChapterText(bookPath, chapter.file)).text, '锁内正文\n');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('静态闸门：书锁只保留一份 keyed 实现，三个写入口内置锁，删书 / 换根入口主动回收', () => {
  const storageSource = read('core/storage.js');
  assert.equal(/bookLocks\.(get|set)\(/.test(storageSource), false, '不该再自己维护 bookLocks Map 的 promise 链');
  assert.equal(/const bookLocks = new Map\(\)/.test(storageSource), false, 'bookLocks Map 必须收进 common 的 keyed 队列');
  assert.match(storageSource, /createKeyedWriteQueue\(\)/, 'storage 必须用 core/common.js 的 keyed 写队列');
  assert.match(storageSource, /const heldBookLocks = new AsyncLocalStorage\(\);/, '同书重入必须靠 AsyncLocalStorage 记「当前上下文已持有哪把锁」');
  assert.match(
    storageSource,
    /if \(held && held\.has\(key\)\) return Promise\.resolve\(\)\.then\(task\);/,
    '同一把锁已在当前上下文里时必须直接执行（否则内置锁的写入口在锁内调用会死锁）'
  );
  assert.match(storageSource, /writeBookMeta: lockedWriteEntry\(writeBookMeta\)/, '导出面里 writeBookMeta 必须内置书锁');
  assert.match(storageSource, /saveChapterText: lockedWriteEntry\(saveChapterText\)/, '导出面里 saveChapterText 必须内置书锁');
  assert.match(storageSource, /prepareChapterSave: lockedWriteEntry\(prepareChapterSave\)/, '导出面里 prepareChapterSave 必须内置书锁');
  assert.equal(/^\s{2}writeBookMeta,$/m.test(storageSource), false, '导出表里不许再保留裸 writeBookMeta');
  assert.equal(/^\s{2}saveChapterText,$/m.test(storageSource), false, '导出表里不许再保留裸 saveChapterText');
  assert.equal(/^\s{2}prepareChapterSave,$/m.test(storageSource), false, '导出表里不许再保留裸 prepareChapterSave');
  const commonSource = read('core/common.js');
  assert.match(commonSource, /function createKeyedWriteQueue\s*\(/, 'keyed 写队列必须只有 common 这一份实现');
  assert.match(commonSource, /function createWriteQueue\s*\(/, '全局写队列仍要在（收成 keyed 单链特例）');
  // v1.8.0 WP-34（V114）：book:delete 已搬进 ipc/book.js —— 两个回收入口一起扫。
  const mainSource = read('main.js') + read('ipc/book.js');
  assert.match(mainSource, /storage\.clearBookLock\(target\)/, '删书成功后要回收这本书的锁');
  assert.match(mainSource, /storage\.clearBookLocks\(\)/, '换书架根目录后要主动回收旧锁');
});

// 审计残留修复 #R11（#55/M6）：lockedWriteEntry 与 locked 曾是两段逐字相同的包装器 —— 导出面
// 一半用这个名、一半用那个名。现在只留一份 lockedWriteEntry，导出面全部走它。
test('M6/#R11：书锁包装器只留一份（lockedWriteEntry），导出面不许再出现第二个同名包装', () => {
  const storageSource = read('core/storage.js');
  // 只有一份「(...args) => withBookLock(args[0], …)」包装器，且名字是 lockedWriteEntry
  const wrappers = [...storageSource.matchAll(/^function (\w+)\(fn\) \{\r?\n {2}return \(\.\.\.args\) => withBookLock\(/gm)];
  assert.deepEqual(wrappers.map((match) => match[1]), ['lockedWriteEntry'], 'withBookLock 包装器只许有一份，且叫 lockedWriteEntry');
  assert.equal(/function locked\(fn\)/.test(storageSource), false, '重复的 locked() 包装器不许回潮');
  assert.equal(/[^A-Za-z0-9_]locked\(/.test(storageSource), false, '导出面不许再用旧名 locked(...)');
  // 导出面里内置锁的写入口都走同一个包装器（分卷 / 整理 / 收尾几个跨段抽样）
  for (const name of ['createChapter', 'createVolume', 'formatBook', 'restoreHistoryFile', 'setLastOpenChapter']) {
    assert.match(storageSource, new RegExp(`${name}: lockedWriteEntry\\(${name}\\)`), `${name} 必须内置书锁`);
  }
});
