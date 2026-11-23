// b8（剪贴板联动）：core/clipboard-watch.js 的判定逻辑。
//
// 隐私红线在这层就能钉住：watcher 只留「长度 + 指纹」，不保存正文；这里也不碰 fs / 日志。
const test = require('node:test');
const assert = require('node:assert/strict');
const watchLib = require('../core/clipboard-watch');

function makeClock(start = 1000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    }
  };
}

const LONG = '这是一段足够长的正文，用来测试后台剪贴板监听会不会给出轻提示（超过二十个字）。';
const LONG2 = '另一段也足够长的正文，说明剪贴板内容确实变了，应该再提示一次（同样超过二十个字）。';

test('未开启时一律不提示；开启时以「当前剪贴板」为基线（打开开关前就有的内容不提示）', () => {
  const watcher = watchLib.createWatcher({ now: makeClock().now });
  assert.equal(watcher.isEnabled(), false);
  assert.deepEqual(watcher.evaluate(LONG), { changed: false, record: false, notify: false, chars: 0, reason: 'disabled' });

  watcher.enable(LONG);
  assert.equal(watcher.isEnabled(), true);
  assert.equal(watcher.evaluate(LONG).notify, false, '刚打开开关时剪贴板里已有的内容不算新复制');
  const changed = watcher.evaluate(LONG2);
  assert.equal(changed.notify, true);
  assert.equal(changed.chars, LONG2.length);
  assert.equal(changed.reason, 'changed');
});

test('短文本照样记录、只是不提示；同一段文字只提示一次；空 / 纯空白不处理', () => {
  const clock = makeClock();
  const watcher = watchLib.createWatcher({ minChars: 20, now: clock.now });
  watcher.enable('');
  const short = watcher.evaluate('短文本');
  assert.equal(short.reason, 'too-short');
  assert.equal(short.record, true, '短标题 / 短句也是一次复制，必须记进队列');
  assert.equal(short.notify, false, '短文本不弹轻提示');
  assert.equal(watcher.evaluate('短文本').reason, 'unchanged');
  assert.equal(watcher.evaluate('').reason, 'empty');
  const blank = watcher.evaluate('   \n  ');
  assert.equal(blank.reason, 'blank', '只复制空白：没有内容可写');
  assert.equal(blank.record, false);
  assert.equal(watcher.evaluate(LONG).notify, true);
  // 同一段文字（剪贴板没变）不再提示
  assert.equal(watcher.evaluate(LONG).reason, 'unchanged');
  // 内容变了但还在冷却里 → 不提示
  assert.equal(watcher.evaluate(LONG2).reason, 'cooldown');
});

test('冷却：两次提示至少隔 cooldownMs；过了冷却才提示下一段（同一段内容不会因冷却结束而补提示）', () => {
  const clock = makeClock();
  const watcher = watchLib.createWatcher({ minChars: 5, cooldownMs: 8000, now: clock.now });
  watcher.enable('');
  assert.equal(watcher.evaluate(LONG).notify, true);
  clock.advance(7999);
  assert.equal(watcher.evaluate(LONG2).reason, 'cooldown');
  // 冷却中看到的内容已经记成基线：冷却结束后不会为同一段内容补一条提示
  clock.advance(1);
  assert.equal(watcher.evaluate(LONG2).reason, 'unchanged');
  const LONG3 = '又复制了一段新的、足够长的正文，冷却已经过了，这一次应该给提示（超过五个字）。';
  assert.equal(watcher.evaluate(LONG3).notify, true);
});

test('关闭后不再提示；重新打开以当时的剪贴板重建基线（关闭期间复制的不再提示）', () => {
  const clock = makeClock();
  const watcher = watchLib.createWatcher({ minChars: 5, now: clock.now });
  watcher.enable('');
  assert.equal(watcher.evaluate(LONG).notify, true);
  watcher.disable();
  assert.equal(watcher.isEnabled(), false);
  assert.equal(watcher.evaluate(LONG2).reason, 'disabled');
  watcher.enable(LONG2);
  assert.equal(watcher.evaluate(LONG2).reason, 'unchanged', '重新打开时以当前内容为基线');
  assert.equal(watcher.evaluate(LONG).notify, true);
});

test('指纹：只用于「是不是同一段文字」，长度 + 哈希，不含原文；同一输入稳定', () => {
  const a = watchLib.fingerprint('同样的文字');
  const b = watchLib.fingerprint('同样的文字');
  const c = watchLib.fingerprint('同样得文字');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(a.startsWith('5:'), '指纹里带长度前缀');
  assert.equal(a.includes('同样'), false, '指纹不包含原文');
  assert.equal(watchLib.fingerprint(null), '0:811c9dc5'.replace('811c9dc5', (0x811c9dc5).toString(36)));
});

test('参数兜底：minChars / cooldownMs 坏值用默认（20 / 8000），且不低于 1', () => {
  assert.equal(watchLib.createWatcher().minChars, 20);
  assert.equal(watchLib.createWatcher().cooldownMs, 8000);
  assert.equal(watchLib.createWatcher({ minChars: 0 }).minChars, 20);
  assert.equal(watchLib.createWatcher({ minChars: -5 }).minChars, 20);
  assert.equal(watchLib.createWatcher({ cooldownMs: 'abc' }).cooldownMs, 8000);
  assert.equal(watchLib.createWatcher({ minChars: 3 }).minChars, 3);
});

test('记录与提示拆开（2026-11-06 捕获队列）：冷却里 / 同文再来一次仍记录，只有提示受限', () => {
  const clock = makeClock();
  const watcher = watchLib.createWatcher({ minChars: 20, cooldownMs: 8000, now: clock.now });
  watcher.enable('');
  const longer = '第一段足够长的正文，用来验证记录与提示拆开以后第一段会提示也会记录（超过二十字）。';
  const second = '第二段足够长的正文，是在冷却时间里复制的，应该记录但不提示（同样超过二十字）。';
  const third = '第三段足够长的正文，用来验证指纹没变时连记录都不重复（也超过二十字）。';
  const first = watcher.evaluate(longer);
  assert.deepEqual([first.changed, first.record, first.notify], [true, true, true]);
  // 冷却内又复制一段新的：不提示，但要记录（连续复制的几段各留一条）
  const cooling = watcher.evaluate(second);
  assert.deepEqual([cooling.changed, cooling.record, cooling.notify], [true, true, false]);
  assert.equal(cooling.reason, 'cooldown');
  // 同一段内容（指纹没变）不重复记录
  const same = watcher.evaluate(second);
  assert.deepEqual([same.changed, same.record, same.notify], [false, false, false]);
  // 太短照记（只压提示）；空 / 纯空白 / 关闭不记录
  const short = watcher.evaluate(third.slice(0, 3));
  assert.deepEqual([short.record, short.notify], [true, false]);
  assert.equal(watcher.evaluate('').record, false);
  assert.equal(watcher.evaluate(' \n\t ').record, false);
  watcher.disable();
  assert.equal(watcher.evaluate(third).record, false);
});

test('回归（2026-11-07）：「复制 4 次只记 2 次」——短标题 / 正文混排也一条不少', () => {
  const watcher = watchLib.createWatcher({ minChars: 20, now: makeClock().now });
  watcher.enable('');
  const copies = [
    '第3章 雨夜',
    '雨从傍晚开始下，到夜里也没有停。屋檐下的水线连成一片，像有人在黑暗里慢慢磨着一把钝刀。',
    '深夜的解绳',
    '他把窗子推开一条缝，风带着潮气钻进来，桌上的稿纸被吹翻了一页，墨迹在纸背上洇开一小片。'
  ];
  const decisions = copies.map((text) => watcher.evaluate(text));
  assert.deepEqual(
    decisions.map((d) => d.record),
    [true, true, true, true],
    '4 次复制 = 4 条记录（以前 <20 字的两次会被吞掉）'
  );
  assert.deepEqual(
    decisions.map((d) => d.notify),
    [false, true, false, false],
    '轻提示仍受最小长度 + 8 秒冷却限制'
  );
});

// 接线闸门：b8 的关键是「默认关 + 只发派生信息 + 随应用启停 + 点提示才开面板」。
// V39（审计 2026-11-13）：stop→start 之间有一拍读数还在飞时，旧读数返回后可能把「打开监听前
// 就在剪贴板里」的内容记进新队列、还会把去重基准推走。每次 start / stop 都推进启动 token，
// 每拍读数前记下 token，回写时 token 已经不是当前值就整拍作废（不记队列 / 不提示 / 不动基准）。
function makeDeferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('在飞读数跨过 stop→start 边界就作废：不记新队列、不提示、不推进去重基准（V39）', async () => {
  const clock = makeClock();
  const watcher = watchLib.createWatcher({ now: clock.now });
  const STALE = '打开监听前就在剪贴板里、读数还在飞的那段正文（二十个字以上，本来会提示）。';
  const CURRENT = '重新打开监听那一刻剪贴板里的内容（新的去重基准）。';
  watcher.enable('');
  const inFlight = watcher.token(); // 这一拍开始读剪贴板时拿到的启动 token
  const deferred = makeDeferred(); // 可控时序：读数挂起，等 stop→start 之后才返回
  // 读数在飞期间：关掉监听，300ms 内又打开（新基线 = 打开那一刻剪贴板里的内容）
  watcher.disable();
  watcher.enable(CURRENT);
  deferred.resolve(STALE);
  const stale = watcher.evaluate(await deferred.promise, inFlight);
  assert.deepEqual([stale.changed, stale.record, stale.notify], [false, false, false], '旧读数不许记进新队列、不许提示');
  assert.equal(stale.reason, 'stale');
  // 基准没被旧读数推走：重新打开后这段文字真被复制一次，仍按「新的复制」处理
  const again = watcher.evaluate(STALE);
  assert.deepEqual([again.changed, again.record], [true, true], '旧读数不许把去重基准推走');
  // 当前 token 的读数照常生效：新复制仍然记录 + 提示（先过 8 秒冷却）
  clock.advance(8000);
  const fresh = watcher.evaluate(CURRENT + LONG, watcher.token());
  assert.deepEqual([fresh.record, fresh.notify], [true, true], '正常单次读数行为不变');
  // 只关不开同样推进 token：关监听前拿到的读数一样作废
  const beforeStop = watcher.token();
  watcher.disable();
  watcher.enable('');
  assert.equal(watcher.evaluate(STALE, beforeStop).reason, 'stale', '关掉监听也推进 token');
});

// CTXT-B-02：大文本自适应降频（主进程不再每 300ms 读整串 + 全文哈希）。
test('CTXT-B-02：大文本自适应降频——同长度大文本跳过若干拍，长度一变立即恢复', () => {
  const pacer = watchLib.createLargeTextPacer({ threshold: 100, skipTicks: 3 });
  // 第一次见到大文本：当拍正常读，还没安排跳过；下一拍发现长度没变 → 安排 3 拍
  assert.equal(pacer.shouldSkip(), false);
  assert.equal(pacer.observe(150), 0);
  assert.equal(pacer.shouldSkip(), false);
  assert.equal(pacer.observe(150), 3);
  for (let i = 0; i < 3; i += 1) assert.equal(pacer.shouldSkip(), true, `第 ${i + 1} 拍应跳过`);
  assert.equal(pacer.shouldSkip(), false, '跳过额度用完就恢复读');
  // 长度变短：不再降频
  assert.equal(pacer.observe(50), 0);
  assert.equal(pacer.shouldSkip(), false);
  // 再来一段同样长度的大文本：重新安排（同长度换内容最晚 skipTicks 拍后发现）
  assert.equal(pacer.observe(150), 0);
  assert.equal(pacer.shouldSkip(), false);
  assert.equal(pacer.observe(150), 3);
  // 跳过额度里被读到的长度一变，立即清掉额度（新复制的一段不被压进降频窗口）
  assert.equal(pacer.shouldSkip(), true);
  assert.equal(pacer.observe(300), 0);
  assert.equal(pacer.shouldSkip(), false);
  // reset：关闭监听后不再带着旧长度
  pacer.observe(500);
  assert.equal(pacer.observe(500), 3);
  pacer.reset();
  assert.deepEqual(pacer.state(), { lastLength: -1, remaining: 0 });
  assert.equal(pacer.shouldSkip(), false);

  // 默认阈值 30 万字 / 10 拍（约 3 秒）：低于阈值的整章复制（30 万字以下）不降频。
  const defaults = watchLib.createLargeTextPacer();
  defaults.observe(200000);
  assert.equal(defaults.shouldSkip(), false);
  assert.equal(defaults.observe(200000), 0, '低于阈值不降频');
  defaults.observe(300001);
  assert.equal(defaults.shouldSkip(), false);
  assert.equal(defaults.observe(300001), 10, '大文本没换长度 → 跳 10 拍');
});

// 隐私红线（不落盘 / 不写日志 / 不存正文）在 main.js 里靠「只发 { chars, queued }」守住，这里静态钉住。
test('静态闸门：主进程轮询只在开关打开时跑，只发字数，随配置启停、随退出停止（b8）', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
  const main = read('main.js');

  assert.match(main, /const clipboardWatchLib = require\('\.\/core\/clipboard-watch'\);/);
  assert.match(main, /clipboard\.readText\(\)/, '主进程轮询读剪贴板');
  // 2026-11-06 修：Electron 45 的 clipboard.readText() 返回 Promise —— 后台监听必须 await，
  // 否则读到的是 Promise（length=undefined），真实环境里 b8 轻提示与捕获队列会一直空转。
  assert.match(main, /async function readClipboardForWatch\(\)/, '读剪贴板的封装必须是 async');
  assert.match(main, /String\(\(await clipboard\.readText\(\)\) \|\| ''\)/, '读剪贴板必须 await');
  assert.match(main, /async function pollClipboardWatch\(\)/, '轮询函数必须是 async');
  assert.match(main, /const text = await readClipboardForWatch\(\);/, '轮询里必须 await 读剪贴板');
  assert.match(main, /clipboardWatchPriming/, '打开监听先异步读一次基线，读完前不记录（避免把旧内容当新复制）');
  assert.match(main, /if \(automation && clipboardWatchTestText != null\) return clipboardWatchTestText;/, 'E2E 注入只在 automation 下生效');
  assert.match(main, /handle\('clipboard:test-set'/, 'E2E 注入频道（只在 automation 分支注册）');
  const testSetAt = main.indexOf("handle('clipboard:test-set'");
  const guardAt = main.lastIndexOf('if (automation) {', testSetAt);
  assert.ok(guardAt > 0 && testSetAt - guardAt < 1200, 'clipboard:test-set 必须在 automation 分支里');
  assert.match(main, /setInterval\(pollClipboardWatch, CLIPBOARD_WATCH_INTERVAL_MS\)/, '按固定间隔轮询');
  // 2026-11-07：900ms 太稀（快速连续复制漏拍）→ 300ms
  assert.match(main, /const CLIPBOARD_WATCH_INTERVAL_MS = 300;/, '轮询间隔 300ms');
  // CTXT-B-02：大文本降频必须先于读剪贴板（否则整串副本已经分配完，降频失去意义），关闭时要 reset。
  assert.match(main, /const clipboardPacer = clipboardWatchLib\.createLargeTextPacer\(\);/, '主进程使用共享降频器');
  const skipAt = main.indexOf('if (clipboardPacer.shouldSkip()) return;');
  const readAt = main.indexOf('const text = await readClipboardForWatch();', skipAt);
  assert.notEqual(skipAt, -1, '轮询开始必须先问降频器');
  assert.ok(skipAt < readAt, '降频判断必须先于读剪贴板');
  assert.match(main, /clipboardPacer\.observe\(text\.length\);/, '读过之后登记长度');
  assert.match(main, /clipboardPacer\.reset\(\);/, '关闭监听时清掉降频状态');
  // 2026-11-06 捕获队列：自动通知仍然只发「字数 + 已记条数」，绝不发正文
  assert.match(main, /const payload = \{ chars: decision\.chars, queued: captureQueue\.size\(\) \}/, '通知只带字数与队列条数');
  assert.match(main, /broadcast\('clipboard:changed', payload\)/, '用不含正文的 payload 经 broadcast 发通知（A1 单点发送）');
  assert.equal(/send\('clipboard:changed'[^)]*text/i.test(main), false, '不许把剪贴板正文发给渲染层');
  // 2026-11-07：每次「记录」都发一个只带条数的轻量事件（短复制没有轻提示，靠它刷新面板列表）
  assert.match(main, /broadcast\('clipboard:recorded', recordedPayload\)/, '每次入队都经 broadcast 通知渲染层（只带条数）');
  assert.equal(/send\('clipboard:recorded'[^)]*text/i.test(main), false, '记录事件同样不许带正文');
  assert.match(main, /async function flushClipboardWatchOnce\(\)/, '打开面板前补一拍监听');
  assert.match(main, /handle\('capture:flush'/, '补拍 IPC');
  // 记录与提示拆开：队列只驻主进程内存，写章成功才删条目；关闭监听 / 退出清空
  assert.match(main, /const captureQueueLib = require\('\.\/core\/capture-queue'\);/);
  assert.match(main, /const captureQueue = captureQueueLib\.createCaptureQueue\(\);/);
  assert.match(main, /if \(decision\.record\) captureQueue\.add\(text\);/, '轮询里按 record 入队');
  // V39：每拍读数前拿启动 token，回写时带上；token 变了整拍作废（不记队列 / 不提示 / 不动基准）
  assert.match(main, /const watchToken = clipboardWatcher\.token\(\);/, '每拍开始先拿启动 token');
  assert.match(main, /const decision = clipboardWatcher\.evaluate\(text, watchToken\);/, '回写前带上 token 校验');
  assert.ok(
    main.indexOf('const watchToken = clipboardWatcher.token();') < main.indexOf('const decision = clipboardWatcher.evaluate(text, watchToken);'),
    'token 必须在 await 读数之前拿到'
  );
  assert.match(main, /captureQueue\.clear\(\);/, '关闭监听 / 退出时清空队列');
  assert.match(main, /handle\('capture:queue-list'/, '队列列表 IPC');
  assert.match(main, /handle\('capture:queue-get'/, '按条目取正文 IPC（用户显式点开才取）');
  assert.match(main, /handle\('capture:queue-clear'/, '清空队列 IPC');
  // 2026-11-08：「正文」插入成功后消费该条（与「章节」口径一致）
  assert.match(main, /handle\('capture:queue-remove'/, '正文插入成功后消费该条的 IPC');
  assert.match(
    main,
    // I7（三审，断言跟错）：坏 id / 非 owner 的软错误收编成 { ok:false, code, message }（removed:false
    // 作为附加字段保留），锚点从「返回一个光秃秃的 { removed:false }」换成 softFailure + 两种拒绝码。
    /handle\('capture:queue-remove'[\s\S]{0,900}?softFailure\('QUEUE_BAD_ID'[\s\S]{0,400}?softFailure\('QUEUE_FOREIGN_WINDOW'[\s\S]{0,400}?captureQueue\.remove\(round\)/,
    '队列删除只按数字 id，非数字不猜（S1：先过窗口归属校验再删；软错误统一包络）'
  );
  assert.match(
    main,
    /if \(clipboardWatchEnabledNow\(\)\) \{\n    const decision = clipboardWatcher\.evaluate\(text\);/,
    'Ctrl+Alt+V 触发时立刻跑一拍 watcher（刚复制的那段不用等轮询）'
  );
  assert.match(main, /const queued = captureQueue\.hasText\(text\);/, '触发时告诉渲染层这段是否已入队');
  // N-18（二次审查）：写章成功后的删除必须带窗口归属（以前裸 remove(id)：任一窗口猜 id 就能删别人的记录）。
  assert.match(
    main,
    /const rawQueueId = Number\(data\.queueId\);[\s\S]{0,500}?captureQueue\.removeFor\(queueRound, queueWindowId\)[\s\S]{0,400}?'QUEUE_FOREIGN_WINDOW'[\s\S]{0,200}?'QUEUE_MISSING'/,
    '写章成功后才删队列条目，且按窗口归属删（非 owner / 已消失各自回软错误码）'
  );
  assert.equal(
    /captureQueue\.remove\(Math\.round\(rawQueueId\)\)/.test(main),
    false,
    'commit-record 不许再用无归属的 remove(id)'
  );
  // v0.13.2 剪贴板面板改造：逐行表单的两个 IPC 删除，改成「整条记录 → 新建一章」
  assert.equal(/handle\('capture:analyze'/.test(main), false, 'capture:analyze 已随逐行表单删除');
  assert.equal(/handleBook\('capture:commit'/.test(main), false, 'capture:commit 已改名 capture:commit-record');
  assert.match(main, /handleBook\('capture:commit-record'/, '一条记录 → 新建一章的写盘 IPC');
  // I6（三审，断言跟错）：mutation 取值收编 ipc/book-mutations.js 的常量表 —— 这里钉的锚点从
  // 字面量 'write' 换成 MUTATION.WRITE（值仍是 'write'，跨窗口拦截 / 书架刷新语义不变）。
  assert.match(
    main,
    /handleBook\('capture:commit-record'[\s\S]{0,4000}?\{ mutation: MUTATION\.WRITE \}/,
    '新建章节是写书操作，必须走 mutation:write（跨窗口拦截 / 书架刷新）'
  );
  assert.match(main, /captureLib\.splitRecordTitle\(text\)/, '章名 / 正文规则由主进程 core/capture.js 统一算');
  assert.match(main, /if \(bodyChars > 0\) \{/, '整条就是章名（正文为空）时不记字数统计');
  assert.match(main, /titleOnly: Boolean\(parts\.title && !parts\.body\)/, '返回 titleOnly 给面板提示');
  assert.match(main, /if \(!clipboardWatchEnabledNow\(\)\) \{\n    stopClipboardWatch\(\);/, '开关关掉就停');
  assert.match(main, /syncClipboardWatch\(\);\n    if \(gated\.rejected\.length\)/, 'config:set 后立即启停');
  assert.match(main, /app\.on\('will-quit', \(event\) => \{\n    \/\/ b8：后台剪贴板监听随应用关闭停止/, '退出时停止监听');

  const preload = read('preload.js');
  assert.match(preload, /onClipboardChanged: \(cb\) => on\('clipboard:changed', cb\)/);
  assert.match(preload, /onClipboardRecorded: \(cb\) => on\('clipboard:recorded', cb\)/, '记录事件订阅');
  assert.match(preload, /captureFlushWatch: \(\) => invoke\('capture:flush'\)/, '打开面板前补一拍');
  assert.match(preload, /captureQueueList: \(\) => invoke\('capture:queue-list'\)/);
  assert.match(preload, /captureQueueGet: \(id\) => invoke\('capture:queue-get', id\)/);
  assert.match(preload, /captureQueueRemove: \(id\) => invoke\('capture:queue-remove', id\)/, '正文消费接口');
  assert.match(preload, /captureQueueClear: \(\) => invoke\('capture:queue-clear'\)/);
  // v0.13.2：preload 只留「一条记录 → 新建一章」，不再暴露分析 / 逐行提交
  assert.match(
    preload,
    /captureCommitRecord: \(bookPath, payload\) => invoke\('capture:commit-record', bookPath, payload\)/
  );
  assert.equal(/analyzeCapture|commitCapture/.test(preload), false, '旧分析 / 提交接口已从 preload 删除');
  assert.equal(/invoke\('capture:commit'/.test(preload), false, '旧 capture:commit 频道已删除');

  const renderer = read('renderer/renderer.js');
  // M1（第 9 轮）：实现搬到 renderer/toast-ui.js（行为锚点 tests/toast-ui.test.js），编排器只剩同名转发。
  assert.match(renderer, /\{ toast, toastActionable \} = toastUi;/, '可点提示仍从编排器可达（转发到 toast-ui）');
  assert.match(read('renderer/toast-ui.js'), /function toastActionable\(/, '可点提示实现在 toast-ui.js');
  // M1 第 14 轮第八刀（断言跟错）：这 4 条订阅 / 文案整段搬进 renderer/notify-events-ui.js，
  // 闸门改读模块（行为锚点 tests/notify-events-ui.test.js）；编排器只留装配与一次 bind()。
  const notifySrc = read('renderer/notify-events-ui.js');
  assert.match(notifySrc, /api\.onClipboardChanged\(\(payload\) => \{/, '渲染层订阅剪贴板变化');
  assert.match(notifySrc, /api\.onClipboardRecorded\(\(\) => \{/, '渲染层订阅「已记进队列」事件（面板即时刷新）');
  assert.match(notifySrc, /void captureUi\.open\(\)/, '点提示才打开捕获面板');
  assert.match(notifySrc, /新复制 \$\{formatCount\(chars\)\} 字/, '提示文案只含字数');
  assert.equal(renderer.includes('api.onClipboardChanged('), false, '订阅不许回流编排器（模块只有一份）');

  const html = read('renderer/index.html');
  assert.match(html, /id="settings-clipboard-watch"/, '设置里有开关');
  const settingsUi = read('renderer/settings-ui.js');
  assert.match(settingsUi, /clipboardWatchEnabled: \$\('settings-clipboard-watch'\)/, '保存设置带上开关');
  assert.match(settingsUi, /cfg\.clipboardWatchEnabled === true/, '回填只认真正的 true');
});

// S1（一轮·中）/ T6（三审·中）：剪贴板捕获的跨窗口归属与一次性触发凭证。
// main.js 不可在 Node 里 require（需要 electron），所以这里用「机器清单」钉住四个强制点 ——
// 行为本身由 core/capture-queue.js 的归属用例（capture-queue.test.js 的 S1 / T6）覆盖。
test('S1 / T6 接线闸门：读剪贴板要一次性凭证；队列按窗口归属；关窗回收', () => {
  const fsMod = require('node:fs');
  const pathMod = require('node:path');
  const readMain = (rel) => fsMod.readFileSync(pathMod.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
  const mainSrc = readMain('main.js');
  const preloadSrc = readMain('preload.js');
  const captureSrc = readMain('renderer/capture-ui.js');

  // ① 凭证签发 / 校验 / 消费各只有一份实现，且都只在主进程内存里（N-15：拆成三个动作）。
  assert.match(mainSrc, /function issueCaptureGesture\(windowId\)/, '主进程签发一次性读剪贴板凭证');
  assert.match(mainSrc, /function checkCaptureGesture\(windowId, token\)/, '主进程校验凭证（不消费）');
  assert.match(mainSrc, /function consumeCaptureGesture\(windowId, token\)/, '主进程消费凭证（用掉即废）');
  assert.match(
    mainSrc,
    /const captureGestures = captureGestureLib\.createCaptureGestures\(\);/,
    '凭证状态收进 core/capture-gesture.js（签发 / 校验 / 消费三分离，行为见 tests/capture-gesture.test.js）'
  );
  // N-15：先校验（不置 used）→ 读剪贴板 → 长度校验 → 成功后才消费。
  const clipHandleAt = mainSrc.indexOf("handle('capture:clipboard'");
  assert.notEqual(clipHandleAt, -1, 'capture:clipboard 频道存在');
  const clipBody = mainSrc.slice(clipHandleAt, clipHandleAt + 900);
  const checkAt = clipBody.indexOf('checkCaptureGesture(session.id, token)');
  const readAt = clipBody.indexOf('activeClipboard.readText()');
  const assertTextAt = clipBody.indexOf('assertText(text)');
  const consumeAt = clipBody.indexOf('consumeCaptureGesture(session.id, token)');
  assert.ok(checkAt > 0, 'capture:clipboard 必须先验本窗口的一次性凭证（注入的渲染层不能再随时读作者剪贴板）');
  assert.ok(checkAt < readAt, '校验在读取剪贴板之前');
  assert.ok(readAt < assertTextAt && assertTextAt < consumeAt, '读到正文并通过长度校验之后才消费（N-15：失败可重试）');
  assert.match(
    mainSrc,
    /handle\('capture:flush'[\s\S]{0,600}?issueCaptureGesture\(session\.id\)/,
    '打开捕获面板（capture:flush）就是主进程侧的触发手势，顺手签发凭证'
  );

  // ② 队列按窗口归属：list 先认领无主记录并只列本窗口的；get / remove / clear 都验归属。
  assert.match(mainSrc, /captureQueue\.claim\(windowId\)/, '打开面板的窗口认领无主记录');
  assert.match(mainSrc, /captureQueue\.listFor\(windowId\)/, '队列列表只给本窗口可见的记录');
  assert.match(
    mainSrc,
    /handle\('capture:queue-get'[\s\S]{0,400}?!captureQueue\.canAccess\(round, windowId\)/,
    'queue-get 非 owner 直接拒（读不到别人的剪贴板历史）'
  );
  assert.match(mainSrc, /captureQueue\.removeFor|QUEUE_FOREIGN_WINDOW/, 'queue-remove 非 owner 不删');
  assert.match(mainSrc, /captureQueue\.clearFor\(/, 'queue-clear 只清本窗口的');

  // ③ 发布路径：绑定到具体窗口的复制直接归它；后台监听拍记进来的等面板认领。
  assert.match(mainSrc, /captureQueue\.add\(text, \{ ownerWindowId: target\.id \}\)/, '全局快捷键的这次复制归要弹面板的窗口');

  // ④ 关窗回收：这一扇窗口的记录与凭证随窗口一起丢弃。
  assert.match(
    mainSrc,
    /browserWin\.on\('closed'[\s\S]{0,1800}?captureQueue\.releaseOwner\(session\.id\)/,
    '关窗要回收该窗口的捕获队列记录（隐私口径「关窗即弃」）'
  );
  assert.match(mainSrc, /captureGestures\.release\(session\.id\)/, '关窗要作废该窗口的凭证');

  // ⑤ preload / 渲染层：凭证必须原样带过去（签名改了，调用点不能漏传）。
  assert.match(preloadSrc, /captureClipboard: \(token\) => invoke\('capture:clipboard', token\)/, 'preload 透传凭证');
  assert.match(captureSrc, /panel\.gesture = \(flushed && flushed\.gesture\) \|\| null;/, '面板打开时收下凭证');
  assert.match(captureSrc, /await call\(api\.captureClipboard, panel\.gesture\)/, '读剪贴板必须带凭证');
  assert.match(captureSrc, /panel\.gesture = null;/, '关面板即作废凭证');
});

// N-06（二次审查，中）：全局快捷键捕获是唯一没有长度闸门的捕获通道 ——
// 剪贴板里几十 MB 的日志 / 网页全文会被 countChars 全扫、经 IPC 整串发给渲染层。
// main.js 不可在 Node 里 require，所以这里用机器清单钉住「闸门在入队与回包之前、超限只发元数据」；
// 限额判定本身的边界由 tests/capture-perf-wp11.test.js 的 checkCaptureLimits 用例覆盖，
// 渲染层收到超限元数据后的行为由 tests/notify-events-ui.test.js 覆盖。
test('N-06 接线闸门：capture:triggered 超限只发元数据，正文不出主进程', () => {
  const fsMod = require('node:fs');
  const pathMod = require('node:path');
  const readSource = (rel) => fsMod.readFileSync(pathMod.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
  const mainSrc = readSource('main.js');

  const start = mainSrc.indexOf('async function triggerClipboardCapture()');
  assert.notEqual(start, -1, 'triggerClipboardCapture 必须存在');
  const end = mainSrc.indexOf('\nfunction registerCaptureShortcut()', start);
  assert.ok(end > start, 'triggerClipboardCapture 的函数边界可定位');
  const body = mainSrc.slice(start, end);

  const gateAt = body.indexOf('captureLib.checkCaptureLimits(text)');
  const addAt = body.indexOf('captureQueue.add(text');
  const sendAt = body.indexOf("sendToSession(target, 'capture:triggered', { text,");
  assert.ok(gateAt > 0, '快捷键捕获必须先过 checkCaptureLimits（与 capture:clipboard / 队列同一口径）');
  assert.ok(addAt > gateAt, '长度闸门必须先于入队（超限不做全文 trim / countChars）');
  assert.ok(sendAt > gateAt, '长度闸门必须先于回包（超限不把正文发进渲染层）');
  assert.match(
    body,
    /tooLarge: true,[\s\S]{0,200}?reason: limits\.reason,[\s\S]{0,200}?chars: limits\.chars,[\s\S]{0,200}?rawLength: limits\.rawLength/,
    '超限回包只带原因 / 字数 / 原文长度（不带 text）'
  );
  const tooLargeBlock = body.slice(gateAt, addAt);
  assert.match(tooLargeBlock, /sendToSession\(target, 'capture:triggered'/, '超限也回一条（让渲染层提示原因）');
  assert.equal(
    /sendToSession\(target, 'capture:triggered', \{ text/.test(tooLargeBlock),
    false,
    '超限分支不许把剪贴板正文塞进回包'
  );
  assert.match(tooLargeBlock, /queued: false/, '超限时没有入队');
  assert.ok(
    tooLargeBlock.indexOf('return;') > tooLargeBlock.indexOf('tooLarge: true'),
    '超限分支发完元数据立刻返回（不继续入队）'
  );

  // 渲染层：识别超限元数据 → 只提示，不打开捕获面板。
  const notifySrc = readSource('renderer/notify-events-ui.js');
  const notifyStart = notifySrc.indexOf('api.onCaptureTriggered(');
  assert.notEqual(notifyStart, -1, '渲染层订阅 capture:triggered');
  const notifyEnd = notifySrc.indexOf('\n      });', notifyStart);
  const notifyBody = notifySrc.slice(notifyStart, notifyEnd > notifyStart ? notifyEnd : notifyStart + 1200);
  assert.match(notifyBody, /payload\.tooLarge === true/, '渲染层识别超限元数据');
  assert.ok(
    notifyBody.indexOf('payload.tooLarge') < notifyBody.indexOf('openTriggered'),
    '超限分支在 openTriggered 之前提前返回（不打开面板）'
  );
  assert.match(notifyBody, /没有打开捕获面板/, '提示原因：超限没有打开面板');
  assert.equal(/tooLarge === true[\s\S]{0,400}?payload\.text/.test(notifyBody), false, '超限分支不读 payload.text');
});

