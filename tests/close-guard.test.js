// C5（审计 E5/S5）：关窗放行改主进程交叉判定。
//
// 问题：app:close-ready 完全信任渲染层传上来的 allowed——主进程自己就有 session.dirty
// （渲染层持续上报）和最近一次保存成功回执，却没用。渲染层一个坏回包（或注入脚本）就能让
// 主进程关掉一个还有未保存修改的窗口。
//
// 现在的判定：allowed === true 且（session.dirty 为 false 或「保存回执晚于这次变脏的时间」）。
// 「不保存退出」是作者主动丢弃：渲染层先把脏状态清成 false 再回 allowed（见 renderer 的
// discardUnsavedForClose）。真实行为由 E2E 第 10 / 11 / 12 / 24 / 55 组覆盖，这里钉接线。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const MAIN = read('main.js');
const RENDERER = read('renderer/renderer.js');
const PRELOAD = read('preload.js');

function between(source, from, to) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `找不到：${from}`);
  const end = source.indexOf(to, start + 1);
  assert.ok(end > start, `找不到结尾：${to}`);
  return source.slice(start, end);
}

test('静态闸门：主进程用 session.dirty + 最近保存回执交叉判定关窗（E5/S5）', () => {
  const sessionSrc = between(MAIN, 'function createSession(browserWin) {', '\n}');
  assert.match(sessionSrc, /dirtyAt: 0/, 'session 要记「这次变脏」的时间');
  assert.match(sessionSrc, /lastSaveAt: 0/, 'session 要记最近一次保存成功回执');
  // 保存成功回执：chapter:save 成功尾部写 lastSaveAt
  const saveAt = MAIN.indexOf("handleBook('chapter:save'");
  assert.ok(saveAt > 0);
  const saveBody = MAIN.slice(saveAt, MAIN.indexOf('\n  });', saveAt));
  assert.match(saveBody, /session\.lastSaveAt = Date\.now\(\);/, '章节保存成功要留回执时间');
  // app:dirty：变脏时记时间，干净时清零
  const dirtySrc = between(MAIN, "ipcMain.on('app:dirty'", '\n  });');
  assert.match(dirtySrc, /session\.dirtyAt = Date\.now\(\)/, '变脏要记时间');
  assert.match(dirtySrc, /if \(!next\) session\.dirtyAt = 0;/, '回到干净要清零');
  // close-ready：allowed 之外还要看 dirty / 回执
  const closeSrc = between(MAIN, "ipcMain.on('app:close-ready'", '\n  });');
  assert.match(closeSrc, /const savedAfterDirty = session\.lastSaveAt > 0 && session\.lastSaveAt > session\.dirtyAt;/);
  assert.match(closeSrc, /const okToClose = Boolean\(allowed\) && \(!session\.dirty \|\| savedAfterDirty\);/);
  assert.match(closeSrc, /code: 'CLOSE_DIRTY'/, '被拦下要留一条日志，方便排查「关不掉窗」');
  // e2eCloseReady 记录的必须是主进程判定后的结果（E2E 用它断言，语义不能退化成 allowed）
  assert.match(closeSrc, /session\.e2eCloseReady = okToClose;/);
  assert.match(closeSrc, /e2eLastCloseReady = okToClose;/);
});

test('静态闸门 + 时序：同毫秒的保存回执不放行关窗（N3：宁可多拦一次）', () => {
  const closeSrc = between(MAIN, "ipcMain.on('app:close-ready'", '\n  });');
  const m = closeSrc.match(
    /const savedAfterDirty = session\.lastSaveAt > 0 && session\.lastSaveAt (>=|>) session\.dirtyAt;/
  );
  assert.ok(m, '找不到关窗交叉判定的比较表达式');
  assert.equal(m[1], '>', '必须严格晚于：同毫秒时宁可多拦一次，不能按「可能丢几毫秒编辑」放行');
  // 用源码里的运算符复算三种时序（不是把语义再抄一遍）：同毫秒 → 拦；确实晚于 → 放行；无回执 → 拦。
  const decide = (lastSaveAt, dirtyAt) => lastSaveAt > 0 && (m[1] === '>' ? lastSaveAt > dirtyAt : lastSaveAt >= dirtyAt);
  assert.equal(decide(1000, 1000), false, '同一毫秒的保存回执与再次变脏 → 不放行');
  assert.equal(decide(1001, 1000), true, '保存回执确实晚于变脏 → 放行');
  assert.equal(decide(0, 0), false, '没有保存回执 → 不放行');
});

test('静态闸门：渲染层「不保存退出」先如实清掉脏状态，再放行关窗（E5/S5）', () => {
  const helperSrc = between(RENDERER, 'function discardUnsavedForClose() {', '\n  }');
  assert.match(helperSrc, /state\.dirty = false;/, '主动丢弃要清脏状态');
  assert.match(helperSrc, /updateStatus\(\);/, '清完要上报主进程（app:dirty）');
  const discardSrc = between(RENDERER, "if (action === 'discard') {", 'return;');
  assert.match(discardSrc, /discardUnsavedForClose\(\);[\s\S]{0,80}api\.closeReady\(true\);/, 'discard 分支要先清脏再放行');
  // 保存失败后选「放弃修改退出」这条也要清
  const failedDiscardSrc = between(RENDERER, "if (again.action !== 'discard') {", 'api.closeReady(true);');
  assert.match(failedDiscardSrc, /discardUnsavedForClose\(\);/, '保存失败后放弃退出也要先清脏');
  // 取消分支仍然明确拒绝关窗
  assert.match(RENDERER, /if \(action === 'cancel'\) \{[\s\S]{0,80}api\.closeReady\(false\);/, '取消仍要拒绝关窗');
});

// ---------- A1（审计 E-03）：关窗看门狗阈值与强制退出顺序 ----------
// 3 秒对「慢盘 / 大文件保存」太紧：保存还没写完就弹「编辑器无响应」，作者很容易点「强制退出」
// 把刚写的几万字丢掉。改成 8 秒；就算真的要点强制退出，也先告诉渲染层「要强关了」并给 500 ms
// 落盘时间，到点才 destroy。阈值 / 顺序 / 文案全抽到 core/close-guard.js（纯函数），
// 单测钉住，不用真等 8 秒。

const closeGuardLib = require(path.join(ROOT, 'core', 'close-guard.js'));

test('A1 关窗看门狗：阈值 8 秒，强制退出的计划是「先 send → 等 500 ms → 再 destroy」', () => {
  assert.equal(closeGuardLib.CLOSE_TIMEOUT_MS, 8000, '看门狗阈值必须是 8 秒');
  assert.equal(closeGuardLib.FORCE_CLOSE_CHANNEL, 'app:force-close');
  assert.equal(closeGuardLib.FORCE_CLOSE_GRACE_MS, 500);
  const plan = closeGuardLib.forceClosePlan();
  assert.deepEqual(plan.steps, ['send', 'wait', 'destroy'], '顺序：先通知、再等、最后才 destroy');
  assert.equal(plan.channel, 'app:force-close');
  assert.equal(plan.graceMs, 500);
  // 窗口已经销毁：send / destroy 都要跳过（不往死掉的 webContents 上发、也不再 destroy）
  const dead = closeGuardLib.forceClosePlan({ destroyed: true });
  assert.equal(dead.send, false);
  assert.equal(dead.destroy, false);
  // 每次给新的 steps 数组：调用方改了不能污染下一次
  plan.steps.push('extra');
  assert.deepEqual(closeGuardLib.forceClosePlan().steps, ['send', 'wait', 'destroy']);
});

test('A1 强制退出执行器：严格按 plan.steps 调 send → wait(500) → destroy，顺序不同结果不同', async () => {
  const calls = [];
  await closeGuardLib.runForceCloseSteps(closeGuardLib.forceClosePlan(), {
    send: () => calls.push('send'),
    wait: (ms) => calls.push('wait:' + ms),
    canDestroy: () => true,
    destroy: () => calls.push('destroy')
  });
  assert.deepEqual(calls, ['send', 'wait:500', 'destroy'], '先给 500 ms 二次机会，最后才 destroy');
  // 顺序错了就得跟着错（执行器不许自己重排）——这一步就是「顺序错则失败」的锚点
  const wrong = [];
  await closeGuardLib.runForceCloseSteps(
    { steps: ['destroy', 'send', 'wait'], channel: 'app:force-close', graceMs: 500, send: true, wait: true, destroy: true },
    { send: () => wrong.push('send'), wait: () => wrong.push('wait'), canDestroy: () => true, destroy: () => wrong.push('destroy') }
  );
  assert.notDeepEqual(wrong, calls);
  assert.deepEqual(wrong, ['destroy', 'send', 'wait']);
  // 执行中窗口已经死掉：不再 destroy（send 与等待照计划走完）
  const deadCalls = [];
  await closeGuardLib.runForceCloseSteps(closeGuardLib.forceClosePlan(), {
    send: () => deadCalls.push('send'),
    wait: () => deadCalls.push('wait'),
    canDestroy: () => false,
    destroy: () => deadCalls.push('destroy')
  });
  assert.deepEqual(deadCalls, ['send', 'wait'], '窗口已销毁：跳过 destroy');
});

test('A1 静态闸门：主进程改走 8 秒 + plan / 执行器；提示文案写「已等 8 秒」', () => {
  const prompt = closeGuardLib.timeoutPrompt();
  assert.equal(prompt.type, 'warning');
  assert.equal(prompt.message, '保存还没有完成（已等 8 秒）。');
  assert.deepEqual(prompt.buttons, ['继续等待', '强制退出']);
  assert.equal(prompt.defaultId, 0, '默认停在「继续等待」');
  assert.equal(prompt.cancelId, 0, 'Esc / 关弹窗也停在「继续等待」');
  const closeFlow = between(MAIN, 'function setupCloseFlow(session) {', '\n}\n');
  assert.equal(closeFlow.includes('}, 3000);'), false, '3 秒看门狗必须已经改掉');
  assert.equal(closeFlow.includes('3 秒内完成'), false, '旧文案也要一起换掉');
  assert.match(closeFlow, /closeGuard\.CLOSE_TIMEOUT_MS/, '超时时刻由 core/close-guard.js 给');
  assert.match(closeFlow, /closeGuard\.timeoutPrompt\(\)/, '提示文案由纯函数给（单测能钉住）');
  const forceAt = closeFlow.indexOf('closeGuard.runForceCloseSteps(');
  assert.ok(forceAt > 0, '强制退出必须走执行器（顺序可测）');
  const forceSeg = closeFlow.slice(forceAt, forceAt + 900);
  assert.match(forceSeg, /send:[\s\S]*webContents\.send\(plan\.channel\)/, '先 send app:force-close');
  assert.match(forceSeg, /destroy:[\s\S]*destroy\(\)/, '最后才 destroy');
  assert.equal(forceSeg.indexOf('webContents.send') < forceSeg.indexOf('destroy:'), true, '源码顺序也必须是先通知');
});

// ---------- P-01（1.6.1 R5）：app:force-close 是「谁发 / 谁收」两头都要钉的频道 ----------
// 审查报告 P-01：main.js 点「强制退出」后 `webContents.send(plan.channel)`，但 preload 没有任何
// 订阅面收这条通知、renderer 更没有处理——500 ms 宽限是空转，行为等价于「延迟 500 ms 硬关」。
// 而且原来的奇偶校验（tests/security-regression.test.js）正则只抓 `webContents.send('字面量'`，
// 恰好漏掉 `send(plan.channel)` 这个动态频道。下面三条把「发 → 收 → 处理」三头都钉住。

// 主进程实发的通知频道。`webContents.send(plan.channel)` 是动态的：字面量登记在
// core/close-guard.js 的 FORCE_CLOSE_CHANNEL，这里按那个常量核（改频道名 / 忘了同步 preload 都会红）。
function mainSentChannels() {
  const sent = new Set();
  for (const re of [
    /sendToSession\([^,\n]+,\s*'([^']+)'/g,
    /sendToFlow\('([^']+)'/g,
    /webContents\.send\('([^']+)'/g,
    /broadcast\('([^']+)'/g
  ]) {
    for (const match of MAIN.matchAll(re)) sent.add(match[1]);
  }
  if (/webContents\.send\(plan\.channel\)/.test(MAIN)) sent.add(closeGuardLib.FORCE_CLOSE_CHANNEL);
  return [...sent];
}

// preload 实际的订阅面：vm 里跑一遍 preload（把 electron 换成假的），再把每个 api 成员当订阅函数
// 调一次——和 tests/security-regression.test.js 的 loadPreload() 同一套手法，不靠读源码猜。
function preloadSubscribedChannels() {
  const subscribed = [];
  let exposed = null;
  const fakeElectron = {
    contextBridge: {
      exposeInMainWorld(key, api) {
        exposed = api;
      }
    },
    ipcRenderer: {
      async invoke() {
        return { ok: true };
      },
      on(channel) {
        subscribed.push(channel);
      },
      send() {}
    }
  };
  new vm.Script(PRELOAD, { filename: 'preload.js' }).runInNewContext({
    require: (id) => {
      assert.equal(id, 'electron', `preload 只该 require('electron')，实际 require('${id}')`);
      return fakeElectron;
    },
    console
  });
  assert.ok(exposed, 'preload.js 没有调用 contextBridge.exposeInMainWorld');
  for (const fn of Object.values(exposed)) fn(() => {});
  return [...new Set(subscribed)];
}

test('P-01：preload 暴露 onForceClose 并订阅 app:force-close（否则 500 ms 宽限是空转）', () => {
  const subscribed = preloadSubscribedChannels();
  assert.ok(
    subscribed.includes(closeGuardLib.FORCE_CLOSE_CHANNEL),
    `preload 必须订阅 ${closeGuardLib.FORCE_CLOSE_CHANNEL}：main.js 发了这条通知，没人收就等于没发`
  );
  assert.match(
    PRELOAD,
    /onForceClose:\s*\(cb\)\s*=>\s*on\(\s*'app:force-close'\s*,\s*cb\s*\)/,
    'preload 要用 onForceClose 暴露这个通知（命名与 onCloseRequested 一致）'
  );
});

test('P-01：main 实发频道 ⊆ preload 订阅频道（含 plan.channel 这个动态频道）', () => {
  const subscribed = new Set(preloadSubscribedChannels());
  const sent = mainSentChannels();
  assert.ok(
    sent.includes(closeGuardLib.FORCE_CLOSE_CHANNEL),
    '动态频道 webContents.send(plan.channel) 必须被这条闸门核到（不能只抓字面量）'
  );
  const orphan = sent.filter((channel) => !subscribed.has(channel));
  assert.deepEqual(orphan, [], `这些频道主进程发了但没人收：${orphan.join(' / ')}`);
});

test('P-01：renderer 收到 app:force-close 后先 saveCurrent 再 closeReady 交回主进程', () => {
  assert.ok(RENDERER.includes('api.onForceClose('), 'renderer 必须订阅 app:force-close');
  const seg = between(RENDERER, 'api.onForceClose(', '\n    });');
  const saveAt = seg.indexOf('saveCurrent(');
  const readyAt = seg.indexOf('api.closeReady(');
  assert.ok(saveAt > 0, '收到强制退出通知要先调现成的 saveCurrent()');
  assert.ok(readyAt > saveAt, '保存之后再 api.closeReady(...) 把结果交回主进程');
  assert.match(seg, /silent:\s*true/, '失败要静默：500 ms 内来不及让作者读第二个框');
  assert.equal(/openModal|askUnsaved/.test(seg), false, '不许在强制退出路径上再弹二次确认框');
});

