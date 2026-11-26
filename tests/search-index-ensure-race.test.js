// 2026-11-25 审计修复 · 正文索引 ensure 的两条中危（B2）：
//
// SEARCH-01：doEnsure 在 buildBookEntry 之前读「这本书脏不脏」，成功后在循环尾部无条件
//   `dirtyBooks.delete(key)`。同一本书正在建位图时另一窗口保存并 markDirty，标记会被这一趟的
//   delete 吞掉；这一趟尾部又按「脏集为空」重开 60 秒复用窗口 —— 下一次搜索直接用保存前的位图，
//   刚保存的正文被当「不匹配」滤掉（违反「位图只会误报、不会漏报」的不变量）。
//   修法：markDirty 递增每本书的脏版本；构建前取版本，成功后版本没变才清。
//   （五-M27 覆盖的是「这本书已经处理完、ensure 还没跑完」才标脏；这里补的是「同一本书正在处理途中」被标脏。）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const search = require('../core/search-index');
const storage = require('../core/storage');
const { normalizePath } = require('../core/path-utils');
const { mkTmp, makeBook, makeWorld } = require('./search-index-fixtures');

// 等一个「信号来了 / 超时」二选一。超时定时器必须清掉（并 unref），否则用例结束进程还会被它拖住。
function settleWithin(promise, timeoutMs) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise.then(() => true), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// Node 22 的 node:test 在事件循环先清空时，会把仍挂起的用例判成 cancelledByParent
// （「Promise resolution is still pending but the event loop has already resolved」）。
// store 的「隐式 ensure 超时」定时器是 unref 的（生产里不该拖住进程），所以只等它的 promise
// 时没有任何 ref'd handle —— Node 22 上会直接收工，Node 24 的测试运行器恰好替我们撑住了循环。
// 这里加一个会自清理的 ref'd 看门狗：计时期间循环不空转；真超时按失败抛错（不是放宽断言）。
const LOOP_GUARD_TIMEOUT = Symbol('loop-guard-timeout');
async function awaitWithLoopGuard(promise, timeoutMs, label) {
  let timer = null;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(LOOP_GUARD_TIMEOUT), timeoutMs);
  });
  const result = await Promise.race([promise, guard]);
  if (timer) clearTimeout(timer);
  if (result === LOOP_GUARD_TIMEOUT) throw new Error(`${label || '等待'}超过 ${timeoutMs}ms 仍未结束`);
  return result;
}

// SEARCH-01：33 章 = 建位图批大小（32）+ 1。第 2 批开始读正文时，第 1 批（含第 1 章）的正文已经全部
// 读完 —— 只有这时候落盘的保存才是「这一趟索引没读到的正文」，才谈得上漏报。夹具沿用
// tests/search-index-fixtures.js（临时目录 / 书目 / 双目录统一构造器）。
test('SEARCH-01：建索引途中被保存标脏的书不能被清脏（60 秒复用窗口内不许用旧位图漏搜）', async () => {
  const base = await mkTmp();
  const { userData, booksRoot } = await makeWorld(base);
  const chapters = [];
  for (let i = 1; i <= 33; i += 1) {
    chapters.push({ name: `第${i}章`, text: i === 1 ? '旧稿里的青柠色雨伞。' : `第${i}章正文。` });
  }
  const { bookPath, meta } = await makeBook(booksRoot, '在途书', '在途书', chapters);
  const firstChapterPath = path.join(bookPath, meta.chapters[0].file);
  const lastChapterFile = meta.chapters[meta.chapters.length - 1].file;

  // 把「第 2 批正文读取」按住：此时第 1 批正文已经进过内存，索引这一趟不会再读第 1 章。
  let releaseLastBatch;
  const lastBatchGate = new Promise((resolve) => {
    releaseLastBatch = resolve;
  });
  let lastBatchEntered;
  const lastBatchReached = new Promise((resolve) => {
    lastBatchEntered = resolve;
  });
  let heldOnce = false;
  const realLoadChapterText = storage.loadChapterText;
  storage.loadChapterText = async (book, file) => {
    if (!heldOnce && file === lastChapterFile) {
      heldOnce = true;
      lastBatchEntered();
      await lastBatchGate;
    }
    return realLoadChapterText(book, file);
  };

  // 非 0 的 validateIntervalMs：搜索侧 60 秒复用窗口生效（不这样的话每次搜索都会自己再校验一趟，
  // 把「复用旧位图」这条漏报路径掩掉）。
  const store = search.createSearchStore({ userDataDir: userData, validateIntervalMs: 60000 });
  let reached = false;
  let dirtyAfterEnsure;
  let found;
  try {
    const running = store.ensure({ booksRoot });
    reached = await settleWithin(lastBatchReached, 5000);
    if (reached) {
      // 第 1 批正文已读完；此刻作者保存第 1 章并标脏（与 ipc 保存成功后调 markDirty 同一入口）。
      await fs.writeFile(firstChapterPath, '旧稿里的青柠色雨伞。灯芯在风里晃了一下。', 'utf8');
      store.markDirty(bookPath);
    }
    releaseLastBatch();
    await running;
    dirtyAfterEnsure = store.dirtyList();
    found = await store.search({ booksRoot, query: '灯芯' });
  } finally {
    storage.loadChapterText = realLoadChapterText;
  }

  assert.equal(reached, true, '前提：建位图已经读到第 2 批（第 1 批正文读完）');
  assert.deepEqual(
    dirtyAfterEnsure,
    [normalizePath(bookPath)],
    '建索引途中标脏的书在 ensure 尾部不能被清掉（要留到下一趟校验）'
  );
  assert.ok(
    found.results.length >= 1,
    '保存后第一次搜索必须能搜到新正文 —— 建索引途中标的脏要留到下一趟，不许拿保存前的位图静默漏报'
  );
  assert.deepEqual(store.dirtyList(), [], '下一趟校验把脏标记消费掉');
});

// SEARCH-02：done 进度原来只在 run.changed / rootChanged 时发。搜索侧 T-06 超时先回 building 快照，
// 渲染层靠 notify-events-ui.js 的 done 分支把 building 放下、并按原查询自动重搜 —— 后台校验若没有变化，
// 界面就永远收不到结束信号（卡在「正在建索引」，也不会自动更新结果）。
// 修法：doEnsure 每一条出口都无条件 report done（含书架根读不了时的提前返回）。
test('SEARCH-02：ensure 的每一条出口都要发 done（无变化的后台校验 / 书架根读不了）', async () => {
  // 场景 A：搜索侧超时（校验卡在书架根签名探测上）→ 放行后后台校验「没有变化」→ 仍要发 done。
  const base = await mkTmp();
  const { userData, booksRoot } = await makeWorld(base);
  await makeBook(booksRoot, '书甲', '书甲', [{ name: '第一章', text: '青柠色的雨伞挂在门口。' }]);
  const realStat = fs.stat;
  let armed = false;
  let releaseSignature;
  const signatureGate = new Promise((resolve) => {
    releaseSignature = resolve;
  });
  let signatureEntered;
  const signatureReached = new Promise((resolve) => {
    signatureEntered = resolve;
  });
  const progress = [];
  const store = search.createSearchStore({
    userDataDir: userData,
    validateIntervalMs: 0,
    searchEnsureTimeoutMs: 40,
    stat: async (target) => {
      // 只按住书架根签名探测这一次 stat（模拟 SMB / 网络盘超时，与 T-06 用例同一手法）
      if (armed && String(target) === booksRoot) {
        signatureEntered();
        await signatureGate;
      }
      return realStat(target);
    }
  });
  await store.ensure({ booksRoot }); // 先把索引建好：这一趟有变化，不作为断言对象
  armed = true;
  const pending = store.search({
    booksRoot,
    query: '青柠色',
    onEnsureProgress: (info) => progress.push(info)
  });
  const stalled = await settleWithin(signatureReached, 5000);
  // SEARCH-02：这里等的是 store 里 unref 的「隐式 ensure 超时」定时器，必须用 ref'd 看门狗撑住循环
  // （否则 Node 22 会因事件循环先清空取消用例；Node 24 本地不复现）。
  const quick = await awaitWithLoopGuard(pending, 5000, '搜索超时快照');
  releaseSignature();
  const idle = await settleWithin(
    (async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (!(await store.status()).building) return true;
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      return false;
    })(),
    6000
  );

  assert.equal(stalled, true, '前提：校验已经卡在书架根签名探测上（否则 40ms 超时来不及触发）');
  assert.equal(quick.index.building, true, '前提：搜索先回「正在建索引」快照（T-06 超时）');
  assert.equal(idle, true, '后台校验要在用例预算内结束');
  assert.equal(
    progress.some((info) => info && info.phase === 'done'),
    true,
    '没有变化的后台校验结束也要发 done —— 否则界面永远停在 building、不会按原查询自动重搜'
  );
  assert.equal((await store.status()).building, false, 'done 之后 building 要落下');

  // 场景 B：书架根读不了时 ensure 提前返回 —— 超时快照之后同样只能靠 done 收尾。
  const baseB = await mkTmp();
  const worldB = await makeWorld(baseB);
  const missingRoot = path.join(baseB, '不存在的书架');
  const progressB = [];
  const storeB = search.createSearchStore({ userDataDir: worldB.userData, validateIntervalMs: 0 });
  const missing = await storeB.search({
    booksRoot: missingRoot,
    query: '青柠色',
    onEnsureProgress: (info) => progressB.push(info)
  });
  assert.equal(missing.error, 'ENOENT', '前提：书架根读不了要如实透传错误码');
  assert.equal(
    progressB.some((info) => info && info.phase === 'done'),
    true,
    '书架根读不了也要发 done（这是超时快照之后唯一的结束信号，界面不会永远停在 building）'
  );
});

// SEARCH-03②（2026-11-25 审计·低）：ensure 的串行链只排队、不合并 —— 一趟慢校验（大书架 / 网络盘）
// 期间每打一次搜索都往队尾追加一整趟完整校验。5 次搜索 = 5 趟全架 stat + 5 份索引写。
// 修法：同根同 deep 的请求合并到正在飞 / 排队的那一趟（force 例外：它要求真的重新校验）。
// 锚点：按住第一趟校验的书架根签名 stat，连发 5 次搜索（各自 30ms 超时先回 building 快照），
// 放行后数 stat 次数：合并后只应有一趟（根签名 1 次 + 复用那本书的 书目.json 1 次 = 2 次）。
test('SEARCH-03（合并）：ensure 在飞时连发 5 次搜索只执行一趟校验', async () => {
  const base = await mkTmp();
  const { userData, booksRoot } = await makeWorld(base);
  await makeBook(booksRoot, '书甲', '书甲', [{ name: '第一章', text: '青柠色的雨伞挂在门口。' }]);
  const realStat = fs.stat;
  let armed = false;
  let held = false;
  let statCalls = 0;
  let releaseSignature = () => {};
  const signatureGate = new Promise((resolve) => {
    releaseSignature = resolve;
  });
  let signatureEntered;
  const signatureReached = new Promise((resolve) => {
    signatureEntered = resolve;
  });
  const store = search.createSearchStore({
    userDataDir: userData,
    // 0 = 每次搜索都会自己发起一趟校验（旧实现下 5 次搜索 = 5 趟）
    validateIntervalMs: 0,
    searchEnsureTimeoutMs: 30,
    stat: async (target) => {
      if (armed) {
        statCalls += 1;
        // 只按住第一趟校验的书架根签名探测（模拟 SMB / 网络盘的慢 stat，与 T-06 / SEARCH-02 同一手法）
        if (!held && String(target) === booksRoot) {
          held = true;
          signatureEntered();
          await signatureGate;
        }
      }
      return realStat(target);
    }
  });
  await store.ensure({ booksRoot }); // 预热：先把索引建好（这一趟不受闸门影响）
  armed = true;
  let stalled = false;
  let idle = false;
  let quick = [];
  try {
    const searches = [];
    for (let i = 0; i < 5; i += 1) searches.push(store.search({ booksRoot, query: '青柠色' }));
    stalled = await settleWithin(signatureReached, 5000);
    // SEARCH-03：同 SEARCH-02 —— 5 次搜索各自等 store 里 unref 的超时定时器，用 ref'd 看门狗撑住循环。
    quick = await awaitWithLoopGuard(Promise.all(searches), 5000, '5 次搜索的超时快照');
    releaseSignature();
    idle = await settleWithin(
      (async () => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          if (!(await store.status()).building) return true;
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        return false;
      })(),
      6000
    );
  } finally {
    releaseSignature();
    armed = false;
  }
  assert.equal(stalled, true, '前提：第一趟校验卡在书架根签名探测上（30ms 超时来不及）');
  assert.equal(
    quick.filter((found) => found.index.building === true).length,
    5,
    '5 次搜索都要先回「正在建索引」快照（超时路径不变）'
  );
  assert.equal(idle, true, '后台校验要在用例预算内结束');
  assert.equal(
    statCalls,
    2,
    '5 次搜索只执行一趟校验（根签名 1 次 + 复用那本书的 书目.json 1 次）；旧实现排 5 趟 = 10 次'
  );
});
