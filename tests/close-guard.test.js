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
// MAIN-03：chapter:save 已下沉 ipc/save.js —— 保存回执的源码闸门改读新落点。
const SAVE = read('ipc/save.js');
const RENDERER = read('renderer/renderer.js');
// WP17 A3 第二刀：关窗拦截与「不保存退出」清脏整段迁到 save-chain-ui.js（源码闸门改读模块）。
const SAVE_CHAIN = read('renderer/save-chain-ui.js');
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
  const saveAt = SAVE.indexOf("handleBook('chapter:save'");
  assert.ok(saveAt > 0);
  const saveBody = SAVE.slice(saveAt, SAVE.indexOf('\n  }, { mutation: MUTATION.SAVE });', saveAt));
  assert.match(saveBody, /session\.lastSaveAt = Date\.now\(\);/, '章节保存成功要留回执时间');
  // app:dirty：变脏时记时间，干净时清零
  const dirtySrc = between(MAIN, "ipcMain.on('app:dirty'", '\n  });');
  assert.match(dirtySrc, /session\.dirtyAt = Date\.now\(\)/, '变脏要记时间');
  assert.match(dirtySrc, /if \(!next\) session\.dirtyAt = 0;/, '回到干净要清零');
  // close-ready：allowed 之外还要看 dirty / 回执
  const closeSrc = between(MAIN, "ipcMain.on('app:close-ready'", '\n  });');
  // CGRD-03：主进程这一处只调 close-guard.js 的唯一判据，不再内联复算比较表达式。
  assert.match(closeSrc, /const decision = closeGuard\.closeReleaseDecision\(\{/, '放行判定必须走唯一判据');
  assert.match(closeSrc, /const okToClose = decision\.okToClose;/, 'okToClose 从判据结果取');
  assert.equal(
    /const savedAfterDirty = session\.lastSaveAt > 0/.test(closeSrc),
    false,
    'main.js 不许再内联一份 savedAfterDirty（规则只写一份）'
  );
  assert.equal(/const okToClose = Boolean\(allowed\)/.test(closeSrc), false, 'main.js 不许再内联 okToClose 复算');
  assert.match(closeSrc, /decision\.code === 'CLOSE_DIRTY'/, '被拦下要留一条日志，方便排查「关不掉窗」');
  // e2eCloseReady 记录的必须是主进程判定后的结果（E2E 用它断言，语义不能退化成 allowed）
  assert.match(closeSrc, /session\.e2eCloseReady = okToClose;/);
  assert.match(closeSrc, /e2eLastCloseReady = okToClose;/);
});

test('静态闸门 + 时序：同毫秒的保存回执不放行关窗（N3：宁可多拦一次）', () => {
  // CGRD-03：比较表达式只有 core/close-guard.js 一份；main.js 只调判据。
  const closeSrc = between(MAIN, "ipcMain.on('app:close-ready'", '\n  });');
  const m = read('core/close-guard.js').match(/const savedAfterDirty = lastSaveAt > 0 && lastSaveAt (>=|>) dirtyAt;/);
  assert.ok(m, '找不到关窗交叉判定的比较表达式（close-guard.js）');
  assert.match(closeSrc, /closeGuard\.closeReleaseDecision\(/, 'main.js 必须走同一判据');
  assert.equal(m[1], '>', '必须严格晚于：同毫秒时宁可多拦一次，不能按「可能丢几毫秒编辑」放行');
  // 用源码里的运算符复算三种时序（不是把语义再抄一遍）：同毫秒 → 拦；确实晚于 → 放行；无回执 → 拦。
  const decide = (lastSaveAt, dirtyAt) => lastSaveAt > 0 && (m[1] === '>' ? lastSaveAt > dirtyAt : lastSaveAt >= dirtyAt);
  assert.equal(decide(1000, 1000), false, '同一毫秒的保存回执与再次变脏 → 不放行');
  assert.equal(decide(1001, 1000), true, '保存回执确实晚于变脏 → 放行');
  assert.equal(decide(0, 0), false, '没有保存回执 → 不放行');
});

test('静态闸门：渲染层「不保存退出」先如实清掉脏状态，再放行关窗（E5/S5）', () => {
  const helperSrc = between(SAVE_CHAIN, 'function discardUnsavedForClose() {', '\n  }');
  assert.match(helperSrc, /state\.dirty = false;/, '主动丢弃要清脏状态');
  assert.match(helperSrc, /updateStatus\(\);/, '清完要上报主进程（app:dirty）');
  const discardSrc = between(SAVE_CHAIN, "if (action === 'discard') {", 'return;');
  assert.match(discardSrc, /discardUnsavedForClose\(\);[\s\S]{0,80}api\.closeReady\(true\);/, 'discard 分支要先清脏再放行');
  // 保存失败后选「放弃修改退出」这条也要清
  const failedDiscardSrc = between(SAVE_CHAIN, "if (again.action !== 'discard') {", 'api.closeReady(true);');
  assert.match(failedDiscardSrc, /discardUnsavedForClose\(\);/, '保存失败后放弃退出也要先清脏');
  // 取消分支仍然明确拒绝关窗
  assert.match(SAVE_CHAIN, /if \(action === 'cancel'\) \{[\s\S]{0,80}api\.closeReady\(false\);/, '取消仍要拒绝关窗');
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
  // WP18（台账 #3）：send 分支里多了「字面量 / close-guard 常量互钉」的注释与漂移守卫，
// 片段窗口相应放宽（只截取源码片段，断言本身不变）。
  const forceSeg = closeFlow.slice(forceAt, forceAt + 1600);
  // 台账 #3（WP18）：发送改成字面量（接线清单才看得见 app:force-close 有发送方）；
  // 动态 plan.channel 必须下线，否则静态清单会把它误判成死监听（见 tests/wp18-shelf-ipc.test.js › R14）。
  assert.match(forceSeg, /send:[\s\S]*webContents\.send\('app:force-close'\)/, '先 send app:force-close（字面量）');
  assert.equal(/webContents\.send\(plan\.channel\)/.test(forceSeg), false, '不许再用动态 plan.channel 发送');
  assert.match(forceSeg, /closeGuard\.FORCE_CLOSE_CHANNEL !== 'app:force-close'/, '字面量要与 close-guard 常量互钉');
  assert.match(forceSeg, /destroy:[\s\S]*destroy\(\)/, '最后才 destroy');
  assert.equal(forceSeg.indexOf('webContents.send') < forceSeg.indexOf('destroy:'), true, '源码顺序也必须是先通知');
});

// ---------- P-01（1.6.1 R5）：app:force-close 是「谁发 / 谁收」两头都要钉的频道 ----------
// 审查报告 P-01：main.js 点「强制退出」后 `webContents.send(plan.channel)`，但 preload 没有任何
// 订阅面收这条通知、renderer 更没有处理——500 ms 宽限是空转，行为等价于「延迟 500 ms 硬关」。
// 而且原来的奇偶校验（tests/security-regression.test.js）正则只抓 `webContents.send('字面量'`，
// 恰好漏掉 `send(plan.channel)` 这个动态频道。下面三条把「发 → 收 → 处理」三头都钉住。

// 主进程实发的通知频道。WP18（台账 #3）把强制退出的发送从动态 `send(plan.channel)` 改成字面量
// `send('app:force-close')`（接线清单只认静态字符串），所以这里不再需要「动态频道」特判 ——
// 字面量会被下面 webContents.send 的正则直接抓到；与 core/close-guard.js 常量的互钉见 A1 静态闸门。
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

test('P-01：main 实发频道 ⊆ preload 订阅频道（force-close 字面量也在核）', () => {
  const subscribed = new Set(preloadSubscribedChannels());
  const sent = mainSentChannels();
  assert.ok(
    sent.includes(closeGuardLib.FORCE_CLOSE_CHANNEL),
    'webContents.send 字面量必须被这条闸门抓到（WP18 后台账 #3 的发送已是字面量）'
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

// ---------- C6（v1.8.0 WP-09）：关窗放行后的复查 ----------
// 回执那一刻的判定之后、forceClose 之前还有一次 `await saveRecentWindowBounds`（整份配置写盘，
// 慢盘上可达几十毫秒）。写盘期间渲染层还能继续输入并上报 app:dirty；只按回执时的旧判定
// forceClose，setupCloseFlow 的 close 事件看到 forceClose 直接放行，这几毫秒 ~ 几十毫秒内的
// 新编辑就一起被关掉了（C5/N3 拦不住）。修法：await 之后用同一判据再算一次，不通过就不置
// forceClose、不关窗。规则抽到 core/close-guard.js 的 closeReleaseDecision()，只写一份。

test('C6 / WP-09：closeReleaseDecision 用同一判据算关窗放行（allowed × dirty × 保存回执）', () => {
  const decide = closeGuardLib.closeReleaseDecision;
  assert.deepEqual(decide({ allowed: false, dirty: false }), {
    allowed: false,
    dirty: false,
    savedAfterDirty: false,
    okToClose: false,
    code: 'CLOSE_DENIED'
  });
  assert.equal(decide({ allowed: true, dirty: false }).okToClose, true, '界面说不脏就放行');
  assert.equal(
    decide({ allowed: true, dirty: true, lastSaveAt: 0, dirtyAt: 0 }).okToClose,
    false,
    '仍脏且没有保存回执 → 拦'
  );
  assert.equal(
    decide({ allowed: true, dirty: true, lastSaveAt: 0, dirtyAt: 0 }).code,
    'CLOSE_DIRTY',
    '被拦的合法回执要带 CLOSE_DIRTY 码（日志按它排查）'
  );
  assert.equal(
    decide({ allowed: true, dirty: true, lastSaveAt: 1500, dirtyAt: 1500 }).okToClose,
    false,
    '同一毫秒的保存回执与变脏不可分辨 → 宁可多拦一次（N3）'
  );
  assert.equal(
    decide({ allowed: true, dirty: true, lastSaveAt: 1501, dirtyAt: 1500 }).okToClose,
    true,
    '保存回执确实晚于变脏 → 放行'
  );
  assert.equal(decide().allowed, false, '缺参数按不放行处理，不抛错');
  // 每次返回新对象：调用方改了不能污染下一次
  const first = decide({ allowed: true });
  first.okToClose = false;
  assert.equal(decide({ allowed: true }).okToClose, true);
});

test('C6 / WP-09：主进程在写窗口位置之后、forceClose 之前用同一判据复查（静态闸门）', () => {
  const closeSrc = between(MAIN, "ipcMain.on('app:close-ready'", '\n  });');
  // 旧M3（一轮·中）：写窗口位置不再是裸 await —— 配置写队列挂起时它可能永远不回来，而 8 秒看门狗
  // 在回执进门时已经解除。现在包在 closeGuard.withDeadline（2.5 秒）里：到点照常关窗。
  const awaitAt = closeSrc.indexOf('await closeGuard.withDeadline(() => saveRecentWindowBounds(session)');
  assert.ok(awaitAt > 0, '关窗前仍要先记窗口位置（带截止时间，不许无限等配置写队列）');
  assert.match(closeSrc, /bounds\.timedOut/, '超时要有明确分支（不许静默当成写成功）');
  assert.match(closeSrc, /CLOSE_BOUNDS_TIMEOUT/, '超时要留一条日志，方便排查「窗口位置没记住」');
  const recheckAt = closeSrc.indexOf('closeGuard.closeReleaseDecision(', awaitAt);
  assert.ok(recheckAt > awaitAt, '复查必须在写窗口位置之后（之前算等于没修）');
  const forceAt = closeSrc.indexOf('session.forceClose = true;');
  assert.ok(forceAt > recheckAt, '复查必须在 forceClose = true 之前');
  const seg = closeSrc.slice(recheckAt, forceAt);
  assert.match(seg, /if \(!recheck\.okToClose\)/, '复查不通过要拦下');
  assert.match(seg, /code: 'CLOSE_DIRTY'/, '拦下要留一条日志，方便排查「关不掉窗」');
  assert.match(seg, /return;/, '拦下就不许继续 forceClose / close');
  assert.match(seg, /dirty: session\.dirty/, '复查读的是主进程自己的脏状态');
  assert.match(seg, /lastSaveAt: session\.lastSaveAt/);
  assert.match(seg, /dirtyAt: session\.dirtyAt/);
  // E2E 记录的是「主进程最终放行了吗」：复查翻盘也要如实回写
  assert.match(seg, /session\.e2eCloseReady = false;/);
  assert.match(seg, /e2eLastCloseReady = false;/);
  // 判据本体只许有一份（core/close-guard.js），main.js 不许再手搓一套比较
  assert.match(read('core/close-guard.js'), /function closeReleaseDecision\(/, '判据本体在 close-guard.js');
});

test('C6 / WP-09：自检注入的写盘延迟只认 --e2e，场景把开关交给组 10', () => {
  const saveSrc = between(MAIN, 'async function saveRecentWindowBounds(session) {', '\n}');
  assert.match(
    saveSrc,
    /if \(isE2E && e2eCloseBoundsDelayMs > 0\) \{/,
    '延迟只能在 --e2e 且显式打开时生效（生产 / 截图流程不额外等）'
  );
  assert.match(
    saveSrc,
    /await new Promise\(\(resolve\) => setTimeout\(resolve, e2eCloseBoundsDelayMs\)\)/,
    '延迟必须真的拖慢这次写盘（否则复现不了回执后的窗口）'
  );
  const hostSrc = between(MAIN, 'function automationHost() {', '\n}\n');
  assert.match(hostSrc, /setCloseBoundsDelay: \(ms\) =>/, '自检宿主要暴露开关');
  assert.match(
    read('scripts/screenshot-driver.js'),
    /setCloseBoundsDelay: \(ms\) => host\.setCloseBoundsDelay\(ms\)/,
    '驱动把开关从宿主转给场景'
  );
  assert.match(read('scripts/e2e-scenario.js'), /setCloseBoundsDelay/, '场景要把它交进 groupContext');
  const group10 = read('scripts/e2e/groups/10-close-guard-cancel.js');
  assert.match(group10, /setCloseBoundsDelay\(900\)/, '组 10 用它把写窗口位置拖慢');
  assert.match(group10, /setRealClose\(true\)/, '组 10 要开「真实关窗」才能走到复查 / forceClose 那一段');
  assert.match(group10, /setRealClose\(false\)/, '组 10 跑完必须关掉真实关窗（后面的组依赖窗口继续存在）');
});

// 旧M3（一轮·中）：关窗前写窗口位置是一次真写盘 —— 配置写队列被同步盘 / 杀软 / 网络 userData
// 挂起时它可能永远不回来，而 8 秒看门狗在回执进门那一刻已经 clearTimeout。withDeadline 给它
// 2.5 秒上限：到点照常关窗，工作本身继续在后台做完（写盘不取消）。
test('旧M3：withDeadline——到点如实回 timedOut，先完成则用结果且清掉计时器（不许漏悬挂句柄）', async () => {
  assert.equal(closeGuardLib.BOUNDS_WRITE_TIMEOUT_MS, 2500, '关窗写窗口位置的截止时间是 2.5 秒');

  // ① 工作先完成：用它的结果，计时器要被清掉一次。
  let cleared = 0;
  const fast = await closeGuardLib.withDeadline(async () => 'ok', {
    ms: 1000,
    setTimeoutFn: () => ({ unref() {} }),
    clearTimeoutFn: () => {
      cleared += 1;
    }
  });
  assert.deepEqual(fast, { timedOut: false, value: 'ok' });
  assert.equal(cleared, 1, '先完成也要清计时器');

  // ② 工作永远不回来：到点（注入的计时器手动触发）如实回 timedOut，不吊死关窗流程。
  let fire = null;
  let timedOutCleared = 0;
  const pending = closeGuardLib.withDeadline(() => new Promise(() => {}), {
    ms: 2500,
    setTimeoutFn: (fn) => {
      fire = fn;
      return { unref() {} };
    },
    clearTimeoutFn: () => {
      timedOutCleared += 1;
    }
  });
  fire();
  const slow = await pending;
  assert.equal(slow.timedOut, true);
  assert.equal(timedOutCleared, 1, '超时后同样清计时器（不给退出流程留悬挂句柄）');

  // ③ 工作抛错不抛给调用方：关窗流程不许被写盘异常打断（错误原样带回去给日志侧）。
  const failed = await closeGuardLib.withDeadline(async () => {
    throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
  }, { ms: 1000 });
  assert.equal(failed.timedOut, false);
  assert.equal(failed.error.code, 'EPERM');
  assert.equal(failed.value, undefined);

  // ④ 非函数任务（直接给值）也照常工作；非法 ms 退回默认值。
  assert.deepEqual(await closeGuardLib.withDeadline('v', { ms: 0 }), { timedOut: false, value: 'v' });
});


