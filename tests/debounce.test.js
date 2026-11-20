// B3（审计 P3）：core/debounce.js 的按 key 合并写盘器。
//
// 单测不靠 sleep：注入假定时器（capture 回调后手动触发），断言「合并 / flush / 不丢最后一次」。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createKeyedDebouncer } = require('../core/debounce');

function fakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(fn) {
      const id = nextId;
      nextId += 1;
      timers.set(id, fn);
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    runAll() {
      const fns = Array.from(timers.values());
      timers.clear();
      for (const fn of fns) fn();
    },
    count() {
      return timers.size;
    }
  };
}

async function tick() {
  // 让 debouncer 自动触发路径里的 Promise.resolve().then 跑完
  await new Promise((resolve) => setImmediate(resolve));
}

test('同 key 连续 schedule 只排一个定时器，到点只写最后一次（合并）', async () => {
  const timers = fakeTimers();
  const writes = [];
  const debouncer = createKeyedDebouncer({
    delayMs: 1500,
    save: async (payload) => writes.push(payload),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  debouncer.schedule('b1', '甲章');
  debouncer.schedule('b1', '乙章');
  debouncer.schedule('b1', '丙章');
  assert.equal(debouncer.size(), 1, '同一本书只留一条待写');
  assert.equal(timers.count(), 1, '同一本书只排一个定时器');
  assert.deepEqual(writes, [], '延时没到不该写');
  timers.runAll();
  await tick();
  assert.deepEqual(writes, ['丙章'], '只写最后一次');
  assert.equal(debouncer.size(), 0);
});

test('不同 key 各自合并；flushAll 把待写的都写掉并清空', async () => {
  const timers = fakeTimers();
  const writes = [];
  const debouncer = createKeyedDebouncer({
    save: async (payload, key) => writes.push([key, payload]),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  debouncer.schedule('b1', '甲');
  debouncer.schedule('b2', '乙');
  debouncer.schedule('b1', '甲2');
  assert.equal(debouncer.size(), 2);
  assert.equal(timers.count(), 2);
  await debouncer.flushAll();
  assert.deepEqual(writes.sort((a, b) => a[0].localeCompare(b[0])), [['b1', '甲2'], ['b2', '乙']]);
  assert.equal(debouncer.size(), 0, 'flushAll 后没有待写');
  assert.equal(timers.count(), 0, 'flushAll 要取消所有定时器');
});

test('flush(key) 立刻写并取消定时器；没有待写返回 null、不重复写', async () => {
  const timers = fakeTimers();
  const writes = [];
  const debouncer = createKeyedDebouncer({
    save: async (payload) => {
      writes.push(payload);
      return `saved:${payload}`;
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  debouncer.schedule('b1', '甲');
  const result = await debouncer.flush('b1');
  assert.equal(result, 'saved:甲');
  assert.deepEqual(writes, ['甲']);
  assert.equal(timers.count(), 0, 'flush 要取消定时器');
  assert.equal(await debouncer.flush('b1'), null, '没有待写返回 null');
  assert.equal(await debouncer.flush('没排过'), null);
  timers.runAll();
  await tick();
  assert.deepEqual(writes, ['甲'], '定时器已取消，不会再写一次');
});

test('不丢最后一次：上一次 flush 还在写盘时又切了章，新的那次要照常落盘', async () => {
  const timers = fakeTimers();
  const writes = [];
  let releaseFirst;
  const firstWrite = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const debouncer = createKeyedDebouncer({
    save: async (payload) => {
      writes.push(payload);
      if (payload === '甲') await firstWrite;
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  debouncer.schedule('b1', '甲');
  const flushing = debouncer.flush('b1'); // 开始写「甲」（卡住）
  debouncer.schedule('b1', '乙'); // 写盘期间又切到「乙」
  assert.equal(debouncer.size(), 1, '「乙」要留成新的待写');
  timers.runAll();
  await tick();
  releaseFirst();
  await flushing;
  assert.deepEqual(writes, ['甲', '乙'], '两次切章都不能丢（前一次在写、后一次排队）');
});

test('定时器路径写盘失败不往外抛（不会变成 unhandledRejection 打断主进程）', async () => {
  const timers = fakeTimers();
  let attempts = 0;
  const debouncer = createKeyedDebouncer({
    save: async () => {
      attempts += 1;
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  debouncer.schedule('b1', '甲');
  timers.runAll();
  await tick();
  assert.equal(attempts, 1, '自动路径失败只吞掉，不影响后续');
  debouncer.schedule('b1', '乙');
  await debouncer.flush('b1').then(
    () => assert.fail('手动 flush 的失败要抛给调用方'),
    (err) => assert.equal(err.code, 'EPERM')
  );
  assert.equal(attempts, 2);
});

test('dispose：清掉定时器、之后 schedule 不再接受', async () => {
  const timers = fakeTimers();
  const writes = [];
  const debouncer = createKeyedDebouncer({
    save: async (payload) => writes.push(payload),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  debouncer.schedule('b1', '甲');
  debouncer.dispose();
  assert.equal(debouncer.size(), 0);
  assert.equal(timers.count(), 0);
  debouncer.schedule('b1', '乙');
  timers.runAll();
  await tick();
  assert.deepEqual(writes, []);
});

// 接线闸门：B3 的关键不是工具本身，而是 main.js 真的用了它、并在读书目前 / 退出前 flush。
// 少接一处就会出现「重开书回到旧章」或「退出丢最后一次切章」，所以静态钉住。
test('静态闸门：main.js 的切章走防抖，读书目前与退出前都 flush（B3）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = [
    // v1.8.0 WP-34（V114）：书 CRUD / 导出的频道搬进 ipc/*.js —— B3 的两个读入口跟着搬走。
    fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'ipc', 'book.js'), 'utf8')
  ]
    .join('\n')
    .replace(/\r\n/g, '\n');
  assert.match(source, /const \{ createKeyedDebouncer \} = require\('\.\/core\/debounce'\);/);
  // book:set-last 不再同步读写书目，只 schedule
  const setLastStart = source.indexOf("handleBook('book:set-last'");
  assert.ok(setLastStart > 0, 'main.js 里找不到 book:set-last');
  const setLastBody = source.slice(setLastStart, source.indexOf('\n  });', setLastStart));
  assert.ok(setLastBody.includes('lastOpenWrites.schedule('), 'book:set-last 必须走防抖队列');
  assert.equal(setLastBody.includes('storage.setLastOpenChapter('), false, 'book:set-last 不该再同步读写书目');
  // 三个读入口 + 关窗 + 退出：都要 flush
  for (const channel of ['books:list', 'app:recent-book', 'book:open', 'window:open-book']) {
    const at = source.indexOf(`handle('${channel}'`) >= 0
      ? source.indexOf(`handle('${channel}'`)
      : source.indexOf(`handleBook('${channel}'`);
    assert.ok(at > 0, `main.js 里找不到 ${channel}`);
    const body = source.slice(at, at + 2000);
    assert.ok(body.includes('flushLastOpenBeforeRead('), `${channel} 读书目前必须 flush 防抖队列`);
  }
  assert.ok(source.includes("browserWin.on('closed'"), '窗口关闭事件要保留');
  assert.match(source, /browserWin\.on\('closed', \(\) => \{[\s\S]{0,300}?lastOpenWrites\.flushAll\(\)/, '关窗前要 flush');
  assert.match(source, /app\.on\('will-quit', \(event\) => \{[\s\S]{0,900}?lastOpenWrites[\s\S]{0,200}?flushAll\(\)/, '退出前要 flush（并拦一次退出等写完）');
  assert.match(source, /event\.preventDefault\(\);[\s\S]{0,120}?flushAll\(\)/, '退出 flush 要用 preventDefault 等写完再 quit');
  // 「继续上次写作」的 at 必须是切章发生的时间：防抖会推迟落盘，用落盘时间会让迟到的切章记录
  // 盖掉另一本书更晚的保存（多窗口 E2E 55c 抓到过）。
  assert.ok(setLastBody.includes('at: Date.now()'), 'book:set-last 要把切章时间一起排进队列');
  assert.match(source, /const at = Number\.isFinite\(Number\(info\.at\)\)/, 'rememberRecentBook 要用调用方给的切章时间');
  // C28（v1.8.0 WP-26）：读旧值 / 比较 / 写盘都在 configStore 的写队列里（main 不再自己 get 之后 set）。
  const configSrc = fs.readFileSync(path.join(__dirname, '..', 'core', 'config.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(
    source,
    /configStore\.rememberLastBook\(payload, \{ auto: true, now \}\)/,
    '最近书交给 configStore 的写队列（比较与写盘不可分离）'
  );
  assert.match(configSrc, /Number\(prev\.at\) > next\.at\)/, '迟到的切章记录守卫在 configStore 里');
  assert.match(
    configSrc,
    /function rememberLastBook\([\s\S]{0,600}?return enqueue\(/,
    '最近书的比较与写盘必须在同一个写队列任务里'
  );
  // 「继续上次写作」写 config.json（小文件）在切章当下就做；防抖队列只负责书目.json 的大写入。
  // 否则一次迟到的 config 写盘会干扰别处「配置一个字节没写」之类的只读比对（E2E 第 50 组抓到过）。
  assert.ok(setLastBody.includes('await rememberRecentBook('), '切章当下就要记 lastBook');
  assert.match(setLastBody, /display\.chapterName/, '渲染层要把章的显示信息一起传上来（避免为此再读一遍书目）');
  const flushStart = source.indexOf('const lastOpenWrites = createKeyedDebouncer({');
  const flushBody = source.slice(flushStart, source.indexOf('\n});', flushStart));
  assert.equal(flushBody.includes('rememberRecentBook'), false, '防抖落盘只写书目，不再写 config');
});

// PM-1（五-L9）：storage.setLastOpenChapter 读 / 写失败会收成 { ok:false } 正常 resolve，
// 而 debounce 的唯一生产 save 直接把它 return —— flush 永不 reject、定时器路径自己 catch、
// 退出 flush .catch(()=>{})：全链路没有一处看结果或记日志。「重开书回到上次章」偶尔静默回退、
// 事后零线索，与 debounce.js「写入失败不吞」的契约不符。
// 这里直接执行 main.js 的 saveLastOpenChapter 包装（提取源码 + 假 storage / logError）。
test('五-L9（PM-1）：防抖落盘检查 { ok:false } —— 非竞态失败留 warn 并 reject，章已删记 info 不抛', async () => {
  const fsMod = require('node:fs');
  const pathMod = require('node:path');
  const mainSource = fsMod.readFileSync(pathMod.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  const marker = mainSource.indexOf('async function saveLastOpenChapter(');
  assert.ok(marker > 0, 'main.js 必须把防抖落盘的 save 抽成 saveLastOpenChapter（可单测）');
  // 括号配平切出函数真身
  const openBrace = mainSource.indexOf('{', mainSource.indexOf(')', marker));
  let depth = 0;
  let fnSource = '';
  for (let i = openBrace; i < mainSource.length; i += 1) {
    if (mainSource[i] === '{') depth += 1;
    else if (mainSource[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        fnSource = mainSource.slice(marker, i + 1);
        break;
      }
    }
  }
  assert.ok(fnSource, 'saveLastOpenChapter 的大括号要配平');
  const make = (setLastOpenChapter, logs) =>
    new Function('storage', 'logError', `${fnSource}; return saveLastOpenChapter;`)(
      { setLastOpenChapter },
      (kind, err, meta) => logs.push([kind, err, meta])
    );

  // ① 成功：零日志、原样回包
  const okLogs = [];
  const ok = make(async () => ({ ok: true, changed: true }), okLogs);
  assert.deepEqual(await ok({ bookPath: 'D:/书库/书', chapterId: 'c1' }), { ok: true, changed: true });
  assert.equal(okLogs.length, 0);

  // ② 写盘失败（EBUSY）：留 warn + 按契约 reject（flush 调用方能看到）
  const failLogs = [];
  const failing = make(
    async () => ({ ok: false, code: 'EBUSY', message: '文件正被别的程序占用' }),
    failLogs
  );
  await assert.rejects(
    () => failing({ bookPath: 'D:/书库/书', chapterId: 'c1' }),
    (err) => err.code === 'EBUSY' && /占用/.test(err.message)
  );
  assert.equal(failLogs.length, 1, '失败必须留一条可查的日志');
  assert.equal(failLogs[0][0], 'set-last');
  assert.equal(failLogs[0][2].level, 'warn');
  assert.equal(failLogs[0][2].code, 'EBUSY');

  // ③ 章在防抖窗口里被删（正常竞态）：记 info、不抛（删章流程不该出现告警噪音）
  const benignLogs = [];
  const benign = make(async () => ({ ok: false, code: 'CHAPTER_NOT_FOUND', chapterCount: 0 }), benignLogs);
  const result = await benign({ bookPath: 'D:/书库/书', chapterId: 'c9' });
  assert.equal(result.ok, false);
  assert.equal(benignLogs.length, 1);
  assert.equal(benignLogs[0][2].level, 'info');
  assert.equal(benignLogs[0][2].code, 'CHAPTER_NOT_FOUND');
});
