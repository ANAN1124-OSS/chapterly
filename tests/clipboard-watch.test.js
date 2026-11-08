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
  // 2026-11-06 捕获队列：自动通知仍然只发「字数 + 已记条数」，绝不发正文
  assert.match(main, /const payload = \{ chars: decision\.chars, queued: captureQueue\.size\(\) \}/, '通知只带字数与队列条数');
  assert.match(main, /send\('clipboard:changed', payload\)/, '用不含正文的 payload 发通知');
  assert.equal(/send\('clipboard:changed'[^)]*text/i.test(main), false, '不许把剪贴板正文发给渲染层');
  // 2026-11-07：每次「记录」都发一个只带条数的轻量事件（短复制没有轻提示，靠它刷新面板列表）
  assert.match(main, /send\('clipboard:recorded', recordedPayload\)/, '每次入队都通知渲染层（只带条数）');
  assert.equal(/send\('clipboard:recorded'[^)]*text/i.test(main), false, '记录事件同样不许带正文');
  assert.match(main, /async function flushClipboardWatchOnce\(\)/, '打开面板前补一拍监听');
  assert.match(main, /handle\('capture:flush'/, '补拍 IPC');
  // 记录与提示拆开：队列只驻主进程内存，写章成功才删条目；关闭监听 / 退出清空
  assert.match(main, /const captureQueueLib = require\('\.\/core\/capture-queue'\);/);
  assert.match(main, /const captureQueue = captureQueueLib\.createCaptureQueue\(\);/);
  assert.match(main, /if \(decision\.record\) captureQueue\.add\(text\);/, '轮询里按 record 入队');
  assert.match(main, /captureQueue\.clear\(\);/, '关闭监听 / 退出时清空队列');
  assert.match(main, /handle\('capture:queue-list'/, '队列列表 IPC');
  assert.match(main, /handle\('capture:queue-get'/, '按条目取正文 IPC（用户显式点开才取）');
  assert.match(main, /handle\('capture:queue-clear'/, '清空队列 IPC');
  // 2026-11-08：「正文」插入成功后消费该条（与「章节」口径一致）
  assert.match(main, /handle\('capture:queue-remove'/, '正文插入成功后消费该条的 IPC');
  assert.match(
    main,
    /handle\('capture:queue-remove'[\s\S]{0,300}?captureQueue\.remove\(Math\.round\(numeric\)\)/,
    '队列删除只按数字 id，非数字不猜'
  );
  assert.match(
    main,
    /if \(clipboardWatchEnabledNow\(\)\) \{\n    const decision = clipboardWatcher\.evaluate\(text\);/,
    'Ctrl+Alt+V 触发时立刻跑一拍 watcher（刚复制的那段不用等轮询）'
  );
  assert.match(main, /const queued = captureQueue\.hasText\(text\);/, '触发时告诉渲染层这段是否已入队');
  assert.match(
    main,
    /const queueRemoved = Number\.isFinite\(rawQueueId\) \? captureQueue\.remove\(Math\.round\(rawQueueId\)\) : false;/,
    '写章成功后才删队列条目'
  );
  // v0.13.2 剪贴板面板改造：逐行表单的两个 IPC 删除，改成「整条记录 → 新建一章」
  assert.equal(/handle\('capture:analyze'/.test(main), false, 'capture:analyze 已随逐行表单删除');
  assert.equal(/handleBook\('capture:commit'/.test(main), false, 'capture:commit 已改名 capture:commit-record');
  assert.match(main, /handleBook\('capture:commit-record'/, '一条记录 → 新建一章的写盘 IPC');
  assert.match(
    main,
    /handleBook\('capture:commit-record'[\s\S]{0,4000}?\{ mutation: 'write' \}/,
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
  assert.match(renderer, /function toastActionable\(/, '可点提示');
  assert.match(renderer, /api\.onClipboardChanged\(\(payload\) => \{/, '渲染层订阅剪贴板变化');
  assert.match(renderer, /api\.onClipboardRecorded\(\(\) => \{/, '渲染层订阅「已记进队列」事件（面板即时刷新）');
  assert.match(renderer, /void captureUi\.open\(\)/, '点提示才打开捕获面板');
  assert.match(renderer, /新复制 \$\{formatCount\(chars\)\} 字/, '提示文案只含字数');

  const html = read('renderer/index.html');
  assert.match(html, /id="settings-clipboard-watch"/, '设置里有开关');
  const settingsUi = read('renderer/settings-ui.js');
  assert.match(settingsUi, /clipboardWatchEnabled: \$\('settings-clipboard-watch'\)/, '保存设置带上开关');
  assert.match(settingsUi, /cfg\.clipboardWatchEnabled === true/, '回填只认真正的 true');
});
