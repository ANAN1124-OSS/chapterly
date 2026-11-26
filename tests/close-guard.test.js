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
// T7（三审·低）：源码切片改走公共探针（按大括号配对，不依赖「收尾那行长什么样」）。
const { extractFunctionSource, extractBlock } = require('./source-probe');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const MAIN = read('main.js');
// MAIN-03：chapter:save 已下沉 ipc/save.js —— 保存回执的源码闸门改读新落点。
const SAVE = read('ipc/save.js');
const RENDERER = read('renderer/renderer.js');
// WP17 A3 第二刀：关窗拦截与「不保存退出」清脏整段迁到 save-chain-ui.js（源码闸门改读模块）。
const SAVE_CHAIN = read('renderer/save-chain-ui.js');
// M1 第 14 轮第八刀（断言跟错）：强制退出订阅整段搬进 renderer/notify-events-ui.js
// （行为锚点 tests/notify-events-ui.test.js）。
const NOTIFY = read('renderer/notify-events-ui.js');
const PRELOAD = read('preload.js');

test('静态闸门：主进程用 session.dirty + 最近保存回执交叉判定关窗（E5/S5）', () => {
  const sessionSrc = extractFunctionSource(MAIN, 'createSession');
  assert.match(sessionSrc, /dirtyAt: 0/, 'session 要记「这次变脏」的时间');
  assert.match(sessionSrc, /lastSaveAt: 0/, 'session 要记最近一次保存成功回执');
  // 保存成功回执：chapter:save 成功尾部写 lastSaveAt
  const saveBody = extractBlock(SAVE, "handleBook('chapter:save'");
  assert.match(saveBody, /session\.lastSaveAt = Date\.now\(\);/, '章节保存成功要留回执时间');
  // app:dirty：变脏时记时间，干净时清零
  const dirtySrc = extractBlock(MAIN, "ipcMain.on('app:dirty'");
  assert.match(dirtySrc, /session\.dirtyAt = Date\.now\(\)/, '变脏要记时间');
  assert.match(dirtySrc, /if \(!next\) session\.dirtyAt = 0;/, '回到干净要清零');
  // close-ready：allowed 之外还要看 dirty / 回执
  const closeSrc = extractBlock(MAIN, "ipcMain.on('app:close-ready'");
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

// ---------- CLOSE-02（高）：崩溃自动重载后主进程脏状态必须归零 ----------
// 现场：渲染进程崩溃 / 无响应 → 主进程自动 reload → 新文档停在书架，init 不会再上报 app:dirty
//（reportedDirty 初值 null，只有用户动作才会 updateStatus）。主进程保留 reload 前的 session.dirty=true，
// 关窗时渲染层回 closeReady(true)，主进程却按 CLOSE_DIRTY 静默拦下——窗口再也关不掉，只能强杀进程。
// 修法：会话脏状态跟着「当前文档」走——文档加载完成（did-finish-load：首次加载 / 崩溃重载 / 无响应重载
// 都会走）时把 dirty / dirtyAt 归零，新文档从书架起步，本来就没有未保存正文。
// 真实行为由 E2E 第 83 组末尾「关闭回归（CLOSE-02）」覆盖（崩溃 → 自动重载 → 断言主进程放行关窗），
// 这里只钉接线：不许把重置漏掉 / 只改 dirty 不改 dirtyAt / 只修主窗口。
test('CLOSE-02：文档重新加载完成后重置主进程会话脏状态（否则崩溃重载后关窗被 CLOSE_DIRTY 永久拦下）', () => {
  const reloadHandler = extractBlock(MAIN, "webContents.on('did-finish-load'");
  assert.match(reloadHandler, /session\.dirty = false;/, '重载后要清脏状态');
  assert.match(reloadHandler, /session\.dirtyAt = 0;/, '重载后要清「这次变脏」的时间（否则旧的 dirtyAt 仍参与关窗判定）');
  // 每窗口一份会话：监听器必须按窗口注册在 createWindow 里，不能写全局变量 / 只修主窗口
  const createWindowSrc = extractFunctionSource(MAIN, 'createWindow');
  assert.ok(createWindowSrc.includes("webContents.on('did-finish-load'"), '监听器要在 createWindow 里按窗口注册');
});

test('静态闸门 + 时序：同毫秒的保存回执不放行关窗（N3：宁可多拦一次）', () => {
  // T7：不再从源码抓比较运算符复算（那是实现形状）。语义直接用纯函数算三种时序——
  // 「必须严格晚于」这条纪律由这里的 > 边界钉住，规则本体仍然只有 core/close-guard.js 一份。
  const closeSrc = extractBlock(MAIN, "ipcMain.on('app:close-ready'");
  assert.match(closeSrc, /closeGuard\.closeReleaseDecision\(/, 'main.js 必须走同一判据');
  const decide = closeGuardLib.closeReleaseDecision;
  assert.equal(decide({ allowed: true, dirty: true, lastSaveAt: 1000, dirtyAt: 1000 }).okToClose, false, '同一毫秒的保存回执与再次变脏 → 不放行（宁可多拦一次）');
  assert.equal(decide({ allowed: true, dirty: true, lastSaveAt: 1001, dirtyAt: 1000 }).okToClose, true, '保存回执确实晚于变脏 → 放行');
  assert.equal(decide({ allowed: true, dirty: true, lastSaveAt: 0, dirtyAt: 0 }).okToClose, false, '没有保存回执 → 不放行');
});

test('静态闸门：渲染层「不保存退出」先如实清掉脏状态，再放行关窗（E5/S5）', () => {
  // T7：三条分支的行为由 wp17-a3-save-chain.test.js 的 B6（模态框先拒 / 干净放行 / 放弃退出清脏 /
  // 保存失败后放弃 / 返回保存保持脏）与 E2E 第 10 组（取消不关窗）覆盖，这里只留机器清单：
  // 清脏原语只许一份、关窗流程的两条放弃分支都确实调它。
  assert.equal((SAVE_CHAIN.match(/function discardUnsavedForClose\(/g) || []).length, 1, '清脏原语只许定义一次');
  const helperSrc = extractFunctionSource(SAVE_CHAIN, 'discardUnsavedForClose');
  assert.match(helperSrc, /state\.dirty = false;/, '主动丢弃要清脏状态');
  assert.match(helperSrc, /updateStatus\(\);/, '清完要上报主进程（app:dirty）');
  const closeFlow = extractFunctionSource(SAVE_CHAIN, 'handleCloseRequest');
  assert.ok(
    (closeFlow.match(/discardUnsavedForClose\(\);/g) || []).length >= 2,
    '关窗流程的放弃分支都要先清脏再放行（现 3 处调用点）'
  );
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
  const closeFlow = extractFunctionSource(MAIN, 'setupCloseFlow');
  // T7：不再用「旧字面量不存在」当通过条件（那是拿缺席当证据），改成正面钉「看门狗延时就是那个常量」。
  assert.match(closeFlow, /setTimeout\([\s\S]*, closeGuard\.CLOSE_TIMEOUT_MS\);/, '看门狗延时由 core/close-guard.js 给（不许再写字面量）');
  assert.match(closeFlow, /closeGuard\.timeoutPrompt\(\)/, '提示文案由纯函数给（单测能钉住）');
  assert.ok(closeFlow.includes('closeGuard.runForceCloseSteps('), '强制退出必须走执行器（顺序可测）');
  // 台账 #3（WP18）：发送改成字面量（接线清单才看得见 app:force-close 有发送方）；
  // 动态 plan.channel 必须下线，否则静态清单会把它误判成死监听（见 tests/wp18-shelf-ipc.test.js › R14）。
  // 「先 send → 等 500 ms → 再 destroy」的顺序由 close-guard.js 的 forceClosePlan / runForceCloseSteps
  // 行为用例钉住，这里只留「三个步骤都在」。
  assert.match(closeFlow, /send:[\s\S]*webContents\.send\('app:force-close'\)/, '步骤一：先 send app:force-close（字面量）');
  assert.equal(/webContents\.send\(plan\.channel\)/.test(closeFlow), false, '不许再用动态 plan.channel 发送');
  assert.match(closeFlow, /closeGuard\.FORCE_CLOSE_CHANNEL !== 'app:force-close'/, '字面量要与 close-guard 常量互钉');
  assert.match(closeFlow, /destroy:[\s\S]*destroy\(\)/, '步骤三：最后才 destroy');
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
  assert.ok(NOTIFY.includes('api.onForceClose('), 'notify-events-ui 必须订阅 app:force-close');
  assert.equal(RENDERER.includes('api.onForceClose('), false, '订阅不许回流编排器（模块只有一份）');
  const seg = extractBlock(NOTIFY, 'api.onForceClose(');
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
  const closeSrc = extractBlock(MAIN, "ipcMain.on('app:close-ready'");
  // 旧M3（一轮·中）：写窗口位置不再是裸 await —— 配置写队列挂起时它可能永远不回来，而 8 秒看门狗
  // 在回执进门时已经解除。现在包在 closeGuard.withDeadline（2.5 秒）里：到点照常关窗。
  assert.match(
    closeSrc,
    /withDeadline\(\s*\(\)\s*=>\s*saveRecentWindowBounds\(session\)/,
    '关窗前仍要先记窗口位置（带截止时间，不许无限等配置写队列）'
  );
  assert.match(closeSrc, /closeGuard\.BOUNDS_WRITE_TIMEOUT_MS/, '截止时间由 close-guard 常量给');
  assert.match(closeSrc, /bounds\.timedOut/, '超时要有明确分支（不许静默当成写成功）');
  assert.match(closeSrc, /CLOSE_BOUNDS_TIMEOUT/, '超时要留一条日志，方便排查「窗口位置没记住」');
  // T7：不再用源码下标钉「复查在写盘之后、forceClose 之前」——那段时序由 E2E 第 10 组真跑
  // （拖慢写盘、期间输入 → 本次关窗作废、窗口与刚敲的字都还在）覆盖。这里只留机器清单：
  // 同一判据算两次、复查读主进程自己的脏状态、拦下要有日志并 return、E2E 回写如实。
  assert.equal(
    (closeSrc.match(/closeGuard\.closeReleaseDecision\(/g) || []).length,
    2,
    '回执判定 + 写盘后复查各一次（判据本体只在 core/close-guard.js）'
  );
  assert.match(closeSrc, /dirty: session\.dirty/, '复查读的是主进程自己的脏状态');
  assert.match(closeSrc, /lastSaveAt: session\.lastSaveAt/);
  assert.match(closeSrc, /dirtyAt: session\.dirtyAt/);
  assert.match(closeSrc, /if \(!recheck\.okToClose\)/, '复查不通过要拦下');
  assert.match(closeSrc, /code: 'CLOSE_DIRTY'/, '拦下要留一条日志，方便排查「关不掉窗」');
  assert.match(closeSrc, /session\.e2eCloseReady = false;/, '复查翻盘要如实回写 E2E 记录');
  assert.match(closeSrc, /e2eLastCloseReady = false;/);
  assert.match(read('core/close-guard.js'), /function closeReleaseDecision\(/, '判据本体在 close-guard.js');
});

test('C6 / WP-09：自检注入的写盘延迟只认 --e2e，场景把开关交给组 10', () => {
  const saveSrc = extractFunctionSource(MAIN, 'saveRecentWindowBounds');
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
  const hostSrc = extractFunctionSource(MAIN, 'automationHost');
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



// V221-CRASH-01 / V221-CRASH-02（2026-11-26 复核）：渲染进程 gone 之后优雅关闭永远等不到
// close-ready ——「关闭这个窗口」/ Esc 变成死按钮、或让作者空等 8 秒看门狗。判据与接线都在这里钉住。
test('V221-CRASH-01/02：渲染进程崩溃时关窗直接销毁，不再等永不回来的 close-ready', () => {
  assert.deepEqual(closeGuardLib.crashedCloseDecision({ crashed: true }), { destroyNow: true });
  assert.deepEqual(closeGuardLib.crashedCloseDecision({ crashed: false }), { destroyNow: false });
  assert.deepEqual(closeGuardLib.crashedCloseDecision(null), { destroyNow: false });

  const closeSrc = extractFunctionSource(MAIN, 'setupCloseFlow');
  assert.match(closeSrc, /webContents\.isCrashed\(\)/, '关窗流程要识别渲染进程已崩溃');
  assert.match(
    closeSrc,
    /closeGuard\.crashedCloseDecision\(\{ crashed: rendererCrashed \}\)/,
    '崩溃判定走 core/close-guard.js 的唯一纯函数'
  );
  assert.match(closeSrc, /session\.forceClose = true;[\s\S]{0,160}?browserWin\.destroy\(\);/, '崩溃窗口直接销毁');

  // 崩溃对话框与「重载失败」对话框的关闭动作（含 Esc → cancelId=1 → close）都必须销毁窗口。
  const destroyCloseBranch = MAIN.match(
    /action === 'close' && !browserWin\.isDestroyed\(\)\) \{[\s\S]{0,220}?browserWin\.destroy\(\);/g
  ) || [];
  assert.ok(destroyCloseBranch.length >= 2, `两处恢复对话框的关闭动作都要直接销毁（实际 ${destroyCloseBranch.length} 处）`);
});
