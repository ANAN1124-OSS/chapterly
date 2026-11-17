// v1.8.3 WP9（审计 C1 / 中 #8）：退出 flush 看门狗。
//
// 问题：`will-quit` 里等 `lastOpenWrites.flushAll()`（把防抖中的「上次打开章节」落盘）+
// `endCrashDraftSession()`（删运行标记 + 草稿），没有任何超时。书在断开的网络盘 / 同步盘，
// 或书锁被整本长操作持有时，这个等待可能永远不回来，退出就被无限期推迟 —— 关窗路径早有
// 8 秒看门狗（core/close-guard.js），退出路径没有。
//
// 现在的口径：收尾工作包进有界等待（2.5 秒），到点直接 quit。超时放弃的只是便利数据
// （lastOpenChapterId 下次切章可重建；崩溃草稿残留由下次启动按 pid 判「上次异常退出」），
// 正文 / 书目已写内容一个字节不动。quit 严格一次（超时后迟到的 resolve / reject 不再 quit）。
//
// 真实 Electron 的退出链覆盖不到（E2E 下 window-all-closed 不退出），所以这里钉两件事：
//   ① 纯逻辑的行为（注入永不回来的收尾 / ENOSPC / EPERM / 同步抛 / quit 自己抛 / 迟到结果）；
//   ② main.js 的接线（preventDefault → 有界收尾 → quit，且没有旧的裸 Promise.all().finally）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const guard = require('../core/quit-flush-guard');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const MAIN = read('main.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const never = () => new Promise(() => {});

// 统一的假 quit / 假日志；返回的 result 由各用例 await。
function harness(work, options = {}) {
  const quits = [];
  const logs = [];
  const result = guard.runQuitCleanup({
    work,
    timeoutMs: options.timeoutMs,
    quit: () => quits.push(Date.now()),
    log: (entry) => logs.push(entry)
  });
  return { result, quits, logs };
}

test('R1 快速完成：收尾写完才 quit、只 quit 一次，不误报超时', async () => {
  const h = harness(async () => {
    await sleep(5);
  }, { timeoutMs: 60 });

  const result = await h.result;
  assert.equal(result.outcome, 'done');
  assert.equal(result.timedOut, false);
  assert.equal(result.quitCount, 1);
  assert.equal(h.quits.length, 1, '收尾完成就要 quit');
  assert.deepEqual(h.logs, [], '正常完成不该留日志');

  // 超时窗口过去后仍不能有第二次 quit：说明定时器在收尾完成时被清掉了。
  await sleep(150);
  assert.equal(h.quits.length, 1, '定时器没清：迟到的超时又 quit 了一次');
});

test('R2 锁竞争 / 网络盘挂起：到点直接 quit（不无限等），并留一条超时日志', async () => {
  const h = harness(never, { timeoutMs: 40 });
  const started = Date.now();
  const result = await h.result;
  const elapsed = Date.now() - started;

  assert.equal(result.outcome, 'timeout');
  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutMs, 40);
  assert.equal(h.quits.length, 1, '超时也必须退出');
  assert.ok(elapsed < 2000, `看门狗没生效：等了 ${elapsed} ms`);
  assert.equal(h.logs.length, 1, '超时留一条日志');
  assert.equal(h.logs[0].code, 'QUIT_FLUSH_TIMEOUT');
  assert.match(h.logs[0].message, /直接退出/, '日志要说清「不等了」');
});

test('R3 收尾 IO 失败（ENOSPC / EPERM）：照样 quit、不抛，并留一条失败日志', async () => {
  for (const code of ['ENOSPC', 'EPERM']) {
    const h = harness(async () => {
      const err = new Error('写入失败');
      err.code = code;
      throw err;
    }, { timeoutMs: 300 });

    const result = await h.result;
    assert.equal(result.outcome, 'failed', `${code} 应判失败`);
    assert.equal(result.timedOut, false);
    assert.equal(result.errorCode, code, '错误码要原样回给调用方');
    assert.equal(h.quits.length, 1, `${code} 也要退出`);
    assert.equal(h.logs.length, 1);
    assert.equal(h.logs[0].code, 'QUIT_FLUSH_FAILED');
    assert.equal(h.logs[0].errorCode, code);
    assert.ok(!h.logs[0].message.includes('D:\\'), '日志文案不能带本机绝对路径');
  }
});

test('R4 超时后迟到的 resolve / reject：不许二次 quit、不许二次日志、不许抛出去', async () => {
  // a) 超时后收尾才写完
  let release = null;
  const slowOk = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness(() => slowOk, { timeoutMs: 30 });
  const result = await h.result;
  assert.equal(result.outcome, 'timeout');
  release();
  await sleep(40);
  assert.equal(h.quits.length, 1, '迟到的完成不许再 quit');
  assert.equal(h.logs.length, 1, '迟到的完成不许再记日志');

  // b) 超时后收尾才失败（迟到 reject 必须被吞掉，不能变成 unhandled rejection）
  let fail = null;
  const slowFail = new Promise((resolve, reject) => {
    fail = reject;
  });
  const h2 = harness(() => slowFail, { timeoutMs: 30 });
  await h2.result;
  fail(new Error('迟到的 EPERM'));
  await sleep(40);
  assert.equal(h2.quits.length, 1, '迟到的失败不许再 quit');
  assert.equal(h2.logs.length, 1, '迟到的失败不许再记日志');
});

test('R5 收尾同步抛 / quit 自己抛：都不往外抛，quit 仍只算一次', async () => {
  const thrown = harness(() => {
    throw new Error('书锁对象坏了');
  }, { timeoutMs: 100 });
  const result = await thrown.result;
  assert.equal(result.outcome, 'failed');
  assert.equal(thrown.quits.length, 1, '同步抛也要退出');

  // quit 自己抛错（例如 app.quit 在异常状态下）不能挡住退出流程，也不能把异常抛给 will-quit
  const calls = [];
  const result2 = await guard.runQuitCleanup({
    work: async () => {},
    timeoutMs: 100,
    quit: () => {
      calls.push(1);
      throw new Error('app.quit 抛了');
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(result2.outcome, 'done');
  assert.equal(result2.quitCount, 1);
});

test('R6 超时参数：只认有限正数，其余落 2.5 秒默认；常量在 2–3 秒', async () => {
  assert.equal(guard.QUIT_FLUSH_TIMEOUT_MS, 2500);
  assert.ok(
    guard.QUIT_FLUSH_TIMEOUT_MS >= 2000 && guard.QUIT_FLUSH_TIMEOUT_MS <= 3000,
    '审计要求 2–3 秒'
  );
  for (const bad of [undefined, null, 0, -1, NaN, Infinity, '30', '', {}]) {
    assert.equal(
      guard.normalizeTimeoutMs(bad),
      guard.QUIT_FLUSH_TIMEOUT_MS,
      `不该接受 ${String(bad)} 当超时值`
    );
  }
  assert.equal(guard.normalizeTimeoutMs(40), 40);
  assert.equal(guard.normalizeTimeoutMs(3000), 3000);

  // 不传 timeoutMs 时用默认值，但快速完成不能真的空等 2.5 秒
  const h = harness(async () => {}, {});
  const result = await h.result;
  assert.equal(result.timeoutMs, guard.QUIT_FLUSH_TIMEOUT_MS);
  assert.equal(result.outcome, 'done');
});

test('R7 组合收尾（flush + 崩溃草稿会话）：任一挂起按超时退；一个先失败就立刻退', async () => {
  // a) flush 成功、崩溃草稿会话卡死 → 超时退出
  const hanging = harness(() => Promise.all([Promise.resolve('flushed'), never()]), { timeoutMs: 40 });
  const result = await hanging.result;
  assert.equal(result.outcome, 'timeout', '组合收尾里任一挂起都要按超时退');
  assert.equal(hanging.quits.length, 1);

  // b) flush 写盘 ENOSPC、崩溃草稿会话卡死 → 立刻失败退出，不空等超时
  const failing = Promise.resolve().then(() => {
    const err = new Error('书目写入失败');
    err.code = 'ENOSPC';
    throw err;
  });
  const fast = harness(() => Promise.all([failing, never()]), { timeoutMs: 5000 });
  const started = Date.now();
  const result2 = await fast.result;
  assert.equal(result2.outcome, 'failed');
  assert.equal(result2.errorCode, 'ENOSPC');
  assert.ok(Date.now() - started < 2000, '一个先失败时应立刻退出，不空等 5 秒超时');
  assert.equal(fast.quits.length, 1);
  assert.equal(fast.logs.length, 1);
  assert.equal(fast.logs[0].code, 'QUIT_FLUSH_FAILED');
});

test('R8 静态接线闸门：will-quit 走有界收尾，旧的裸 Promise.all 必须收掉', () => {
  const start = MAIN.indexOf("app.on('will-quit', (event) => {");
  assert.ok(start > 0, 'main.js 里找不到 will-quit');
  const end = MAIN.indexOf('\n  });', start);
  assert.ok(end > start, '找不到 will-quit 的结尾');
  const body = MAIN.slice(start, end);

  assert.match(
    MAIN,
    /const quitFlushGuard = require\('\.\/core\/quit-flush-guard'\);/,
    'main.js 要引入退出收尾看门狗模块'
  );

  // B3 / WP5 的收尾语义不能丢
  assert.match(body, /event\.preventDefault\(\);/, '仍然拦一次退出等收尾');
  assert.match(body, /lastOpenWrites\.flushAll\(\)/, 'WP9 顺手改：B3 的 flush 不能丢');
  assert.match(body, /endCrashDraftSession\(\)/, 'WP5 的崩溃草稿会话收尾不能丢');

  // 有界收尾 + 日志 + 唯一出口
  assert.match(body, /quitFlushGuard\.runQuitCleanup\(/, 'will-quit 必须走有界收尾');
  assert.match(
    body,
    /timeoutMs: quitFlushGuard\.QUIT_FLUSH_TIMEOUT_MS/,
    '超时值必须用模块常量（2.5 秒）'
  );
  assert.match(body, /quit: \(\) => app\.quit\(\)/, '收尾结束时才 quit');
  assert.match(
    body,
    /log: \(entry\) => logError\('quit-flush', entry, \{ level: 'warn' \}\)/,
    '超时 / 失败要留一条脱敏日志'
  );
  assert.equal((body.match(/app\.quit\(\)/g) || []).length, 1, 'quit 只能有这一个出口');
  assert.doesNotMatch(
    body,
    /Promise\.all\(\[flush, closeCrash\]\)\.finally\(/,
    '旧的裸 Promise.all().finally(app.quit) 必须换掉'
  );

  // 模块自身：常量 2.5 秒、三个出口都导出（main 用常量 + runQuitCleanup，测试用 normalizeTimeoutMs）
  const moduleSrc = read('core/quit-flush-guard.js');
  assert.match(moduleSrc, /const QUIT_FLUSH_TIMEOUT_MS = 2500;/, '常量写成 2500');
  assert.match(moduleSrc, /^module\.exports = \{[\s\S]*?QUIT_FLUSH_TIMEOUT_MS,[\s\S]*?normalizeTimeoutMs,[\s\S]*?runQuitCleanup[\s\S]*?\};/m);
});