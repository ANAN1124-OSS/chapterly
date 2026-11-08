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
const path = require('node:path');
const storage = require('../core/storage');
const common = require('../core/common');

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

test('静态闸门：书锁只保留一份 keyed 实现，删书 / 换根入口主动回收', () => {
  const storageSource = read('core/storage.js');
  assert.equal(/bookLocks\.(get|set)\(/.test(storageSource), false, '不该再自己维护 bookLocks Map 的 promise 链');
  assert.equal(/const bookLocks = new Map\(\)/.test(storageSource), false, 'bookLocks Map 必须收进 common 的 keyed 队列');
  assert.match(storageSource, /createKeyedWriteQueue\(\)/, 'storage 必须用 core/common.js 的 keyed 写队列');
  assert.match(storageSource, /function withBookLock\(bookPath, task\) \{\s*return bookQueue\.enqueue\(bookLockKey\(bookPath\), task\);/, 'withBookLock 只做「按路径分链」');
  const commonSource = read('core/common.js');
  assert.match(commonSource, /function createKeyedWriteQueue\s*\(/, 'keyed 写队列必须只有 common 这一份实现');
  assert.match(commonSource, /function createWriteQueue\s*\(/, '全局写队列仍要在（收成 keyed 单链特例）');
  const mainSource = read('main.js');
  assert.match(mainSource, /storage\.clearBookLock\(target\)/, '删书成功后要回收这本书的锁');
  assert.match(mainSource, /storage\.clearBookLocks\(\)/, '换书架根目录后要主动回收旧锁');
});
