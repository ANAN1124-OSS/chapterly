const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const writeTimerUi = require('../renderer/write-timer-ui');
const editorLogic = require('../renderer/editor-logic');
const { makeEl } = require('./ui-test-preambles');

// 第 4 步 renderer 九刀·补刀 11：写作时长（原 renderer.js 1490–1672，183 行）搬到 renderer/write-timer-ui.js。
// 搬之前只有 E2E 黑盒覆盖（状态栏点开始 / 暂停、设置里看今天与近 30 天）；串行化上报 / 失败回填 /
// 30 秒定时 / 关掉记录时兜底 / 本次秒表 / 标题文案在 Node 里都测不到。搬出来以后逐条钉住。
//
// 契约：host 6 个成员 = 基础 4（$, state, api, call）+ common{formatStopwatch,formatDuration,
// WRITE_TIMER_FLUSH_MS} + statsUi{renderStatsUi}。

const realDocument = globalThis.document;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const realDateNow = Date.now;
test.after(() => {
  if (realDocument === undefined) delete globalThis.document;
  else globalThis.document = realDocument;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  Date.now = realDateNow;
});
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}
function formatStopwatch(seconds) {
  return editorLogic.formatStopwatch(seconds);
}
function formatDuration(n) {
  return editorLogic.formatDuration(n);
}
// 五-L12（ES-3）：上报载荷带上秒数所属的本地日期（跨午夜 / 失败积压按天拆开）
function localDayKey(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const moduleSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'write-timer-ui.js'), 'utf8');
// M1 第十二刀：码字日历三个按钮的接线搬进 renderer/stats-ui.js（断言跟着实现搬家）。
const statsSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'stats-ui.js'), 'utf8');
const moduleCode = moduleSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------- 假 DOM ----------
function makeDocument() {
  const map = new Map();
  let lookups = 0;
  const doc = { getElementById: (id) => { lookups += 1; return map.get(id) || null; } };
  return {
    doc, map,
    get lookups() { return lookups; },
    $: (id) => doc.getElementById(id),
    ensure(id) { if (!map.has(id)) map.set(id, makeEl('div', id)); return map.get(id); }
  };
}

const BASE_IDS = ['btn-write-timer', 'write-timer-text', 'settings-duration-summary'];

function build(options = {}) {
  const dom = options.dom || makeDocument();
  for (const id of BASE_IDS) dom.ensure(id);
  globalThis.document = dom.doc;
  const state = {
    view: options.view === undefined ? 'editor' : options.view,
    bookPath: options.bookPath === undefined ? '/书库/书甲' : options.bookPath,
    config: options.config === undefined ? { writeDurationEnabled: true } : options.config,
    stats: options.stats === undefined ? { todaySeconds: 125, recentSeconds: 3600 } : options.stats,
    streak: null,
    writeTimer: {
      running: false,
      segmentStart: 0,
      sessionMs: 0,
      unsentMs: 0,
      flushTimer: null,
      tickTimer: null,
      ...(options.timer || {})
    }
  };
  const calls = { api: [], renderStatsUi: 0, formatDuration: [], formatStopwatch: [] };
  const api = {
    async addStatsDuration(payload) {
      calls.api.push(payload);
      if (options.addError) throw new Error(options.addError);
      return options.addResult === undefined
        ? { recorded: payload.seconds, stats: { todaySeconds: 200, recentSeconds: 3000, streak: 3 } }
        : options.addResult;
    }
  };
  const host = {
    $: dom.$,
    state,
    api,
    call: async (fn, ...args) => fn(...args),
    common: {
      formatStopwatch: (n) => { calls.formatStopwatch.push(n); return formatStopwatch(n); },
      formatDuration: (n) => { calls.formatDuration.push(n); return formatDuration(n); },
      WRITE_TIMER_FLUSH_MS: 30000
    },
    statsUi: {
      renderStatsUi() { calls.renderStatsUi += 1; }
    }
  };
  const ui = writeTimerUi.create(host);
  return { ui, host, state, dom, calls };
}

// ---------- host 契约 ----------
test('host 契约：6 个成员 + 分组内每个真实依赖；缺任何一个都抛 TypeError', () => {
  assert.deepEqual([...writeTimerUi.REQUIRED_HOST].sort(), ['$', 'api', 'call', 'common', 'state', 'statsUi']);
  assert.equal(writeTimerUi.REQUIRED_HOST.length, 6);
  const ctx = build();
  assert.doesNotThrow(() => writeTimerUi.create(ctx.host));
  assert.throws(() => writeTimerUi.create(null), /createWriteTimerUi 需要 host 对象/);
  for (const key of writeTimerUi.REQUIRED_HOST) {
    const broken = { ...ctx.host };
    delete broken[key];
    assert.throws(() => writeTimerUi.create(broken), new RegExp('host 缺少 ' + key.replace('$', '\\$')), '缺 ' + key);
  }
  for (const key of ['formatStopwatch', 'formatDuration', 'WRITE_TIMER_FLUSH_MS']) {
    const broken = { ...ctx.host, common: { ...ctx.host.common } };
    delete broken.common[key];
    assert.throws(() => writeTimerUi.create(broken), new RegExp('host\\.common 缺少 ' + key));
  }
  const brokenStats = { ...ctx.host, statsUi: {} };
  assert.throws(() => writeTimerUi.create(brokenStats), /host\.statsUi 缺少 renderStatsUi/);
});

test('RPAN-B03：flush 失败后 reset 不许静默清零未上报秒数，要如实提示', async () => {
  const ctx = build({ addError: '磁盘只读', timer: { running: true, segmentStart: Date.now() - 65000, sessionMs: 65000 } });
  const toasts = [];
  // 可选宿主成员：有 toast 就把「没计入统计的秒数」说给作者听
  ctx.host.toast = (message, kind) => toasts.push({ message, kind });
  const ui = writeTimerUi.create(ctx.host);
  await ui.flushWriteTimer();
  assert.equal(ctx.state.writeTimer.unsentMs >= 60000, true, '上报失败时秒数放回待重试');
  await ui.resetWriteTimer();
  assert.equal(ctx.state.writeTimer.unsentMs, 0, '秒表结束，余额清零（当前行为）');
  assert.equal(toasts.length, 1, '清零前必须提示一次「没能计入统计」');
  assert.equal(toasts[0].kind, 'warn');
  assert.match(toasts[0].message, /没能计入写作统计/);
  assert.match(toasts[0].message, /1 分钟/, '文案带上真实时长');

  // 没有失败余额时不许打扰
  const ok = build();
  const quietToasts = [];
  ok.host.toast = (message, kind) => quietToasts.push({ message, kind });
  const okUi = writeTimerUi.create(ok.host);
  await okUi.resetWriteTimer({ flush: false });
  assert.deepEqual(quietToasts, [], '没有未上报余额时不提示');
});

test('create() 只建表：不碰 DOM / 不建定时器，交出 14 个入口', () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  assert.equal(dom.lookups, 0);
  // 五-M32（PM-3）：新增 handleSystemSuspend / handleSystemResume 两个系统睡眠 / 唤醒入口
  assert.deepEqual(Object.keys(ctx.ui).sort(), [
    'applyWriteTimerConfig', 'flushWriteTimer', 'handleSystemResume', 'handleSystemSuspend',
    'pauseWriteTimer', 'renderDurationSettings', 'renderWriteTimer', 'resetWriteTimer',
    'setupWriteTimerUi', 'startWriteTimer', 'writeDurationEnabled',
    'writeTimerSessionSeconds', 'writeTimerTodaySeconds', 'writeTimerUnsentMs'
  ]);
  assert.equal(moduleCode.includes('setTimeout'), false);
});

// ---------- 纯计算 ----------
test('writeDurationEnabled / 今日秒数 / 本次秒数 / 未上报毫秒：按 state 与 Date.now 算，坏值归零', () => {
  const ctx = build({ config: { writeDurationEnabled: true }, stats: { todaySeconds: 61.4 } });
  assert.equal(ctx.ui.writeDurationEnabled(), true);
  assert.equal(build({ config: {} }).ui.writeDurationEnabled(), false);
  assert.equal(build({ config: { writeDurationEnabled: 'yes' } }).ui.writeDurationEnabled(), false, '只认 true');
  assert.equal(ctx.ui.writeTimerTodaySeconds(), 61);

  const zero = build({ stats: { todaySeconds: 'bad', recentSeconds: -5 } });
  assert.equal(zero.ui.writeTimerTodaySeconds(), 0);

  const running = build();
  running.state.writeTimer.running = true;
  running.state.writeTimer.segmentStart = 1000;
  running.state.writeTimer.sessionMs = 2000;
  running.state.writeTimer.unsentMs = 500;
  Date.now = () => 4000;
  assert.equal(running.ui.writeTimerSessionSeconds(), 5); // (2000 + 3000ms) / 1000
  assert.equal(running.ui.writeTimerUnsentMs(), 3500);
  Date.now = realDateNow;
});

// ---------- 状态栏按钮 ----------
test('renderWriteTimer：书架 / 没书 / 关闭记录时隐藏；空闲 / 运行 / 暂停 三种文案与 class / title', () => {
  const ctx = build();
  ctx.ui.renderWriteTimer();
  const btn = ctx.dom.map.get('btn-write-timer');
  assert.equal(btn.classList.contains('hidden'), false);
  assert.equal(ctx.dom.map.get('write-timer-text').textContent, '写作计时');
  assert.equal(btn.title, `点击开始写作计时（只记时长，不记内容）。今天已写 ${formatDuration(125)}`);

  const running = build();
  Date.now = () => 5000;
  running.state.writeTimer.running = true;
  running.state.writeTimer.segmentStart = 5000;
  running.state.writeTimer.sessionMs = 0;
  running.ui.renderWriteTimer();
  assert.equal(running.dom.map.get('write-timer-text').textContent, '计时 ' + formatStopwatch(0));
  assert.equal(running.dom.map.get('btn-write-timer').classList.contains('running'), true);
  assert.match(running.dom.map.get('btn-write-timer').title, /^正在计时：点一下暂停/);
  Date.now = realDateNow;

  const paused = build();
  paused.state.writeTimer.sessionMs = 65000;
  paused.state.writeTimer.unsentMs = 0;
  paused.ui.renderWriteTimer();
  assert.equal(paused.dom.map.get('write-timer-text').textContent, '已暂停 ' + formatStopwatch(65));
  assert.equal(paused.dom.map.get('btn-write-timer').classList.contains('paused'), true);

  const shelf = build({ view: 'shelf' });
  shelf.ui.renderWriteTimer();
  assert.equal(shelf.dom.map.get('btn-write-timer').classList.contains('hidden'), true);
  const disabled = build({ config: {} });
  disabled.ui.renderWriteTimer();
  assert.equal(disabled.dom.map.get('btn-write-timer').classList.contains('hidden'), true);
});

test('renderDurationSettings：未开启文案；开启后今天 / 近 30 天 / 正在计时；不回填 checkbox', () => {
  const off = build({ config: {} });
  off.ui.renderDurationSettings();
  assert.equal(off.dom.map.get('settings-duration-summary').className, 'muted small');
  assert.match(off.dom.map.get('settings-duration-summary').textContent, /^未开启/);

  const on = build({ stats: { todaySeconds: 125, recentSeconds: 3600 } });
  on.ui.renderDurationSettings();
  assert.equal(on.dom.map.get('settings-duration-summary').textContent, '今天写作 ' + formatDuration(125) + ' · 近 30 天 ' + formatDuration(3600));

  on.state.writeTimer.running = true;
  Date.now = () => 0;
  on.state.writeTimer.segmentStart = 0;
  on.state.writeTimer.unsentMs = 0;
  on.state.stats.todaySeconds = 0;
  on.ui.renderDurationSettings();
  assert.match(on.dom.map.get('settings-duration-summary').textContent, / · 正在计时$/);
  Date.now = realDateNow;
});

// ---------- 开始 / 暂停 / ticker ----------
test('startWriteTimer：关闭记录 / 书架 / 没书都不起表；开启后建两个定时器并立刻刷新界面', () => {
  const intervals = [];
  globalThis.setInterval = (fn, ms) => { intervals.push({ fn, ms, cleared: false }); return intervals.length; };
  globalThis.clearInterval = (id) => { if (intervals[id - 1]) intervals[id - 1].cleared = true; };
  try {
  const off = build({ config: {} });
  assert.equal(off.ui.startWriteTimer(), false);
  assert.equal(intervals.length, 0);
  assert.equal(build({ view: 'shelf' }).ui.startWriteTimer(), false);
  assert.equal(build({ bookPath: null }).ui.startWriteTimer(), false);

  const ctx = build();
  Date.now = () => 10000;
  assert.equal(ctx.ui.startWriteTimer(), true);
  assert.equal(ctx.state.writeTimer.running, true);
  assert.equal(ctx.state.writeTimer.segmentStart, 10000);
  assert.equal(intervals.length, 2);
  assert.deepEqual(intervals.map((i) => i.ms).sort((a, b) => a - b), [1000, 30000]);
  assert.equal(ctx.dom.map.get('write-timer-text').textContent, '计时 ' + formatStopwatch(0));
  // 再点一次不会重复起
  assert.equal(ctx.ui.startWriteTimer(), true);
  assert.equal(intervals.length, 2);
  } finally {
    Date.now = realDateNow;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});

test('ticker 回调：30 秒定时 flush、1 秒定时只刷新文字；暂停 / 重置会清掉两个定时器', async () => {
  const intervals = [];
  globalThis.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
  globalThis.clearInterval = (id) => { if (intervals[id - 1]) intervals[id - 1].cleared = true; };
  try {
  const ctx = build();
  ctx.ui.startWriteTimer();
  const flushTimer = intervals.find((i) => i.ms === 30000);
  flushTimer.fn();
  await flush();
  assert.equal(ctx.calls.api.length, 0, '没到 1 秒不上报');
  ctx.state.writeTimer.unsentMs = 2500;
  flushTimer.fn();
  await flush();
  assert.equal(ctx.calls.api.length, 1);
  assert.deepEqual(ctx.calls.api[0], { seconds: 2, day: localDayKey() });

  await ctx.ui.pauseWriteTimer();
  assert.equal(intervals.every((i) => i.cleared), true, '暂停后两个定时器都清掉');
  assert.equal(ctx.state.writeTimer.running, false);
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});

// ---------- 上报 ----------
test('flushWriteTimer：关掉 / 不足 1 秒不写盘；成功更新 stats 与 streak、重绘统计；失败把秒数放回', async () => {
  const off = build({ config: {} });
  off.state.writeTimer.unsentMs = 5000;
  assert.equal(await off.ui.flushWriteTimer(), 0);
  assert.deepEqual(off.calls.api, []);
  assert.equal(off.state.writeTimer.unsentMs, 5000, '关掉记录时秒数原样留着');

  const short = build();
  short.state.writeTimer.unsentMs = 999;
  assert.equal(await short.ui.flushWriteTimer(), 0);
  assert.deepEqual(short.calls.api, []);

  const ok = build();
  ok.state.writeTimer.unsentMs = 2600;
  const recorded = await ok.ui.flushWriteTimer();
  assert.equal(recorded, 2);
  assert.deepEqual(ok.calls.api, [{ seconds: 2, day: localDayKey() }]);
  assert.equal(ok.state.stats.todaySeconds, 200);
  assert.equal(ok.state.streak, 3);
  assert.equal(ok.calls.renderStatsUi, 1);
  assert.equal(ok.state.writeTimer.unsentMs, 600);

  const fail = build({ addError: '磁盘满' });
  fail.state.writeTimer.unsentMs = 3000;
  assert.equal(await fail.ui.flushWriteTimer(), 0);
  assert.equal(fail.state.writeTimer.unsentMs, 3000, '失败放回去下次再试');
});

test('flushWriteTimer：运行中先把当前段落计入本次与未上报；上报串行化（两次并发不重复扣零头）', async () => {
  const ctx = build();
  Date.now = () => 5000;
  ctx.state.writeTimer.running = true;
  ctx.state.writeTimer.segmentStart = 3000;
  ctx.state.writeTimer.sessionMs = 1000;
  ctx.state.writeTimer.unsentMs = 0;
  const recorded = await ctx.ui.flushWriteTimer();
  assert.equal(recorded, 2);
  assert.equal(ctx.state.writeTimer.sessionMs, 3000);
  assert.equal(ctx.state.writeTimer.unsentMs, 0);
  assert.equal(ctx.state.writeTimer.segmentStart, 5000);
  Date.now = realDateNow;

  const serial = build();
  serial.state.writeTimer.unsentMs = 5000;
  await Promise.all([serial.ui.flushWriteTimer(), serial.ui.flushWriteTimer()]);
  assert.deepEqual(serial.calls.api, [{ seconds: 5, day: localDayKey() }], '第二次时未上报已清零，不重复上报');
});

// ---------- 暂停 / 重置 / 应用配置 ----------
test('pauseWriteTimer / resetWriteTimer：先 flush；暂停清本次运行态，重置清空本次秒表', async () => {
  const pause = build();
  pause.state.writeTimer.running = true;
  Date.now = () => 3000;
  pause.state.writeTimer.segmentStart = 0;
  pause.state.writeTimer.unsentMs = 0;
  await pause.ui.pauseWriteTimer();
  assert.equal(pause.calls.api.length, 1);
  assert.equal(pause.state.writeTimer.running, false);
  assert.equal(pause.state.writeTimer.segmentStart, 0);
  Date.now = realDateNow;

  const reset = build();
  reset.state.writeTimer.running = true;
  reset.state.writeTimer.sessionMs = 9000;
  reset.state.writeTimer.unsentMs = 9000;
  await reset.ui.resetWriteTimer();
  assert.equal(reset.state.writeTimer.sessionMs, 0);
  assert.equal(reset.state.writeTimer.unsentMs, 0);
  assert.equal(reset.state.writeTimer.running, false);

  const noFlush = build();
  noFlush.state.writeTimer.unsentMs = 4000;
  await noFlush.ui.resetWriteTimer({ flush: false });
  assert.deepEqual(noFlush.calls.api, []);
  assert.equal(noFlush.state.writeTimer.unsentMs, 0);
});

test('applyWriteTimerConfig：关掉时停表并隐藏；开启时按当前状态重绘按钮与设置摘要', async () => {
  const off = build({ config: {} });
  off.state.writeTimer.running = true;
  await off.ui.applyWriteTimerConfig();
  assert.equal(off.state.writeTimer.running, false);
  assert.equal(off.dom.map.get('btn-write-timer').classList.contains('hidden'), true);

  const on = build();
  on.ui.applyWriteTimerConfig();
  assert.equal(on.dom.map.get('btn-write-timer').classList.contains('hidden'), false);
  assert.match(on.dom.map.get('settings-duration-summary').textContent, /^今天写作/);
});

// ---------- 事件绑定 ----------
test('setupWriteTimerUi：点按钮在开始与暂停之间切换', async () => {
  const ctx = build();
  ctx.ui.setupWriteTimerUi();
  assert.equal(ctx.dom.map.get('btn-write-timer')._listeners.length, 1);
  Date.now = () => 1000;
  ctx.dom.map.get('btn-write-timer')._fire('click');
  assert.equal(ctx.state.writeTimer.running, true);
  ctx.dom.map.get('btn-write-timer')._fire('click');
  await flush();
  assert.equal(ctx.state.writeTimer.running, false);
  Date.now = realDateNow;
});

// ---------- 五-M32（PM-3）：系统睡眠 / 唤醒不污染写作时长 ----------
// 计时按墙钟差累计：合盖睡眠数小时，唤醒后第一次 flush 会把整段睡眠算进 unsentMs（单日 86400
// 秒夹住、次日继续）。主进程 powerMonitor 的 suspend / resume 广播到这里：睡眠前先把已经写的那一段
// 结掉，唤醒后从当前时刻续（不补睡眠）；手动暂停中的计时器不会被自动拉起。
test('五-M32（PM-3）：睡眠前结算、唤醒后不把睡眠时段计入写作时长', async () => {
  const ctx = build({ config: { writeDurationEnabled: true } });
  const t = ctx.state.writeTimer;
  try {
    Date.now = () => 1000;
    assert.equal(ctx.ui.startWriteTimer(), true);

    // 已经写了 10 秒 → 系统进入睡眠
    Date.now = () => 11000;
    assert.equal(ctx.ui.handleSystemSuspend(), true);
    assert.equal(t.running, true, '睡眠不改变「作者正在计时」这个状态');
    assert.equal(t.sessionMs, 10000, '睡眠前已经写的那 10 秒照常累计');
    assert.equal(t.unsentMs, 10000);

    // 睡眠 3 小时：期间任何查询都不许把这段算进去
    Date.now = () => 11000 + 3 * 60 * 60 * 1000;
    assert.equal(ctx.ui.writeTimerSessionSeconds(), 10);
    assert.equal(ctx.ui.writeTimerUnsentMs(), 10000);
    ctx.ui.renderWriteTimer();
    assert.match(ctx.dom.map.get('write-timer-text').textContent, /计时 0:10/);

    // 唤醒：从当前时刻继续，醒后再写 5 秒才 +5
    assert.equal(ctx.ui.handleSystemResume(), true);
    Date.now = () => 11000 + 3 * 60 * 60 * 1000 + 5000;
    assert.equal(ctx.ui.writeTimerSessionSeconds(), 15);
    assert.equal(ctx.ui.writeTimerUnsentMs(), 15000);

    await ctx.ui.pauseWriteTimer();
    assert.equal(t.running, false);
    assert.deepEqual(ctx.calls.api, [{ seconds: 15, day: localDayKey() }], '上报的是真实写作秒数，不含睡眠（日期取自唤醒后的当前本地日）');
  } finally {
    // 失败时也要收掉 ticker，别让 node --test 进程被真实 setInterval 挂着
    ctx.ui.resetWriteTimer({ flush: false });
    Date.now = realDateNow;
  }
});

test('五-M32（PM-3）：手动暂停中的计时器不会被唤醒自动拉起；坏事件 / 重复事件幂等', async () => {
  const ctx = build({ config: { writeDurationEnabled: true } });
  const t = ctx.state.writeTimer;
  try {
    assert.equal(ctx.ui.handleSystemSuspend(), false, '没在计时：suspend 是空操作');
    assert.equal(ctx.ui.handleSystemResume(), false, '没在计时：resume 也不会自动开始');
    assert.equal(t.running, false);

    Date.now = () => 2000;
    ctx.ui.startWriteTimer();
    await ctx.ui.pauseWriteTimer(); // 作者手动暂停
    assert.equal(t.running, false);
    assert.equal(ctx.ui.handleSystemSuspend(), false, '暂停中睡眠：不改变暂停状态');
    assert.equal(ctx.ui.handleSystemResume(), false, '暂停中唤醒：不许偷偷开始计时');
    assert.equal(t.running, false);

    // 睡眠事件重复到达（不同平台可能连发）：第二次不重复结算
    Date.now = () => 3000;
    ctx.ui.startWriteTimer();
    Date.now = () => 9000;
    ctx.ui.handleSystemSuspend();
    const settled = t.sessionMs;
    assert.equal(settled, 6000);
    assert.equal(ctx.ui.handleSystemSuspend(), true);
    assert.equal(t.sessionMs, settled, '重复 suspend 不重复累计');
    assert.equal(ctx.ui.handleSystemResume(), true);
    assert.equal(ctx.ui.handleSystemResume(), false, '重复 resume 幂等');
    await ctx.ui.pauseWriteTimer();
  } finally {
    ctx.ui.resetWriteTimer({ flush: false });
    Date.now = realDateNow;
  }
});

// ---------- 五-L12（ES-3）：写作计时按「秒数所属日期」记账 ----------
// 旧实现只报一个总秒数，主进程按回执到达时刻算日期：跨午夜最后 ≤30 秒、IPC 连续失败积压的整段
// 都会被记到成功那一刻的新一天；单日上限夹住的差额则静默蒸发。现在按本地午夜拆日上报 { seconds, day }。
test('五-L12（ES-3）：跨午夜的计时段按本地日期拆开上报（午夜前记前一天）', async () => {
  const beforeMidnight = new Date(2026, 10, 20, 23, 59, 40).getTime();
  const afterMidnight = new Date(2026, 10, 21, 0, 0, 10).getTime();
  const ctx = build({ config: { writeDurationEnabled: true } });
  try {
    Date.now = () => beforeMidnight;
    ctx.ui.startWriteTimer();
    Date.now = () => afterMidnight;
    await ctx.ui.pauseWriteTimer();
    assert.deepEqual(
      ctx.calls.api,
      [
        { seconds: 20, day: '2026-11-20' },
        { seconds: 10, day: '2026-11-21' }
      ],
      '午夜前 20 秒记前一天、午夜后 10 秒记当天（逐日上报，旧实现整段记到新一天）'
    );
    assert.equal(ctx.state.writeTimer.unsentMs, 0, '全部上报完，零头归零');
    assert.deepEqual(ctx.state.writeTimer.unsentDays, {}, '按日队列清空，不留空条目');
  } finally {
    ctx.ui.resetWriteTimer({ flush: false });
    Date.now = realDateNow;
  }
});

test('五-L12（ES-3）：单日上限夹住的差额不静默蒸发，也不留在队列里无限重试', async () => {
  const ctx = build({
    addResult: { recorded: 2, capped: true, day: '2026-11-20', stats: { todaySeconds: 86400 } }
  });
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    ctx.state.writeTimer.unsentMs = 5000;
    ctx.state.writeTimer.unsentDays = { '2026-11-20': 5000 };
    const recorded = await ctx.ui.flushWriteTimer();
    assert.equal(recorded, 2);
    assert.equal(ctx.state.writeTimer.unsentMs, 0, '上限夹住的部分丢弃，不留在队列里每次 flush 重试');
    assert.deepEqual(ctx.state.writeTimer.unsentDays, {});
    assert.equal(warnings.length, 1, '不许静默蒸发：至少留一次说明');
    assert.match(warnings[0], /单日上限/);
    assert.match(warnings[0], /3 秒/);
    await ctx.ui.flushWriteTimer();
    assert.equal(ctx.calls.api.length, 1, '清掉之后不会拿同一批秒数反复上报');
    // 同一天再被夹住：不重复刷同一条提示
    ctx.state.writeTimer.unsentMs = 4000;
    ctx.state.writeTimer.unsentDays = { '2026-11-20': 4000 };
    await ctx.ui.flushWriteTimer();
    assert.equal(warnings.length, 1, '每个日期只提示一次');
  } finally {
    console.warn = realWarn;
  }
});

test('五-L12（ES-3）：非上限原因的「少记」把差额放回该日期，下次再试', async () => {
  const ctx = build({ addResult: { recorded: 2, stats: { todaySeconds: 10 } } });
  ctx.state.writeTimer.unsentMs = 5000;
  ctx.state.writeTimer.unsentDays = { '2026-11-20': 5000 };
  const recorded = await ctx.ui.flushWriteTimer();
  assert.equal(recorded, 2);
  assert.equal(ctx.state.writeTimer.unsentMs, 3000, '少记的 3 秒回到未上报队列（旧实现直接蒸发）');
  assert.equal(ctx.state.writeTimer.unsentDays['2026-11-20'], 3000, '差额记在所属日期上，不会挪到今天');
});

// ---------- 静态闸门 ----------
test('静态闸门：renderer.js 不再内嵌写作时长实现，只剩装配与转发', () => {
  for (const shape of [
    'function writeDurationEnabled(',
    'function writeTimerTodaySeconds(',
    'function renderWriteTimer(',
    'function renderDurationSettings(',
    'function stopWriteTimerTicker(',
    'function startWriteTimerTicker(',
    'function startWriteTimer(',
    'function flushWriteTimer(',
    'async function flushWriteTimerNow(',
    'async function pauseWriteTimer(',
    'async function resetWriteTimer(',
    'function applyWriteTimerConfig('
  ]) {
    assert.equal(rendererSrc.includes(shape), false, 'renderer.js 里还有第二份：' + shape);
  }
  assert.equal(rendererSrc.split('writeTimerUiModule.create(').length - 1, 1, '装配只许一处');
  assert.ok(rendererSrc.includes('const writeTimerUiModule = window.CWWriteTimerUi;'));
  for (const line of [
    '    $, state, api, call,',
    '    common: { formatStopwatch, formatDuration, WRITE_TIMER_FLUSH_MS },',
    '    statsUi: { renderStatsUi }'
  ]) {
    assert.ok(rendererSrc.includes(line), '装配少了：' + line);
  }
  assert.ok(rendererSrc.includes(
    'const { writeDurationEnabled, renderWriteTimer, renderDurationSettings, startWriteTimer, pauseWriteTimer, flushWriteTimer, resetWriteTimer, applyWriteTimerConfig, writeTimerTodaySeconds, writeTimerSessionSeconds, writeTimerUnsentMs, setupWriteTimerUi } = writeTimerUi;'
  ), '12 个入口按原名解构');
  assert.equal(rendererSrc.includes("$('btn-write-timer').addEventListener"), false, '绑定应该只在模块里');
  assert.equal(rendererSrc.split('setupWriteTimerUi();').length - 1, 1, 'setup 只调一次');
  // 码字日历的三个按钮绑定不属于本域；第十二刀起随实现搬进 stats-ui.js（编排器里不许回流）
  for (const id of ['calendar-prev', 'calendar-next', 'calendar-today']) {
    assert.equal(rendererSrc.includes(`$('${id}').addEventListener`), false, '日历绑定该在 stats-ui.js：' + id);
    assert.ok(statsSrc.includes(`$('${id}').addEventListener`), 'stats-ui.js 里缺日历绑定：' + id);
  }
  // stats 装配里的三个写计时依赖改成惰性转发（写作时长在 stats 之后装配）
  assert.ok(rendererSrc.includes(
    '    writeDurationEnabled: () => writeDurationEnabled(), renderDurationSettings: () => renderDurationSettings(), renderWriteTimer: () => renderWriteTimer(), calendarSummaryText,'
  ), 'stats 装配应改为惰性转发');
  for (const key of ['flushWriteTimer', 'pauseWriteTimer', 'resetWriteTimer', 'startWriteTimer', 'writeDurationEnabled', 'writeTimerSessionSeconds', 'writeTimerTodaySeconds', 'writeTimerUnsentMs']) {
    assert.match(rendererSrc, new RegExp('^      ' + key + ',$', 'm'), 'testHooksScope 少了 ' + key);
  }
});

test('静态闸门：index.html 在 renderer.js 之前加载 write-timer-ui.js，且只加载一次', () => {
  const at = indexSrc.indexOf('<script src="write-timer-ui.js"></script>');
  const rendererAt = indexSrc.indexOf('<script src="renderer.js"></script>');
  assert.notEqual(at, -1);
  assert.ok(at < rendererAt);
  assert.equal(indexSrc.split('write-timer-ui.js').length - 1, 1);
});

test('静态闸门：模块不 require / 不摸 Electron·fs / 不注册全局监听；setTimeout 为 0、setInterval 只有两个', () => {
  // A8（WP-32）：允许的 require 只有 UMD 的 Node 分支 —— core/assert-host.js（host 校验）与
  // core/common.js（pad2 共用实现，五-L12；浏览器走 window.CWCommon）；运行时代码仍不许 require 任何东西。
  const umdNodeBranch = "module.exports = factory(require('../core/common'), require('../core/assert-host').assertHost);";
  assert.ok(moduleCode.includes(umdNodeBranch), 'UMD 的 Node 分支要从 ./assert-host 与 ./common 取共享实现');
  const runtimeCode = moduleCode.split(umdNodeBranch).join('');
  for (const forbidden of ['require(', 'ipcRenderer', 'node:fs', 'child_process', 'localStorage', 'fetch(', 'window.', 'process.']) {
    assert.equal(runtimeCode.includes(forbidden), false, 'write-timer-ui.js 不许出现 ' + forbidden);
  }
  assert.equal(/window\.addEventListener|document\.addEventListener/.test(moduleCode), false);
  assert.equal((moduleCode.match(/setTimeout\(/g) || []).length, 0);
  assert.equal((moduleCode.match(/setInterval\(/g) || []).length, 2);
});

test('五-M32 静态闸门：主进程 powerMonitor 广播 → preload 订阅 → 渲染层交给写作计时', () => {
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  assert.match(mainSrc, /powerMonitor/, '主进程要接 Electron powerMonitor（全仓唯一睡眠感知来源）');
  assert.match(
    mainSrc,
    /powerMonitor\.on\('suspend',[\s\S]{0,80}broadcast\('power:suspend'/,
    'suspend 要广播 power:suspend'
  );
  assert.match(
    mainSrc,
    /powerMonitor\.on\('resume',[\s\S]{0,80}broadcast\('power:resume'/,
    'resume 要广播 power:resume'
  );
  assert.match(preloadSrc, /onPowerSuspend: \(cb\) => on\('power:suspend', cb\)/, 'preload 暴露 suspend 订阅');
  assert.match(preloadSrc, /onPowerResume: \(cb\) => on\('power:resume', cb\)/, 'preload 暴露 resume 订阅');
  assert.equal((rendererSrc.match(/api\.onPowerSuspend\(/g) || []).length, 1, 'suspend 只订阅一次');
  assert.equal((rendererSrc.match(/api\.onPowerResume\(/g) || []).length, 1, 'resume 只订阅一次');
  assert.match(rendererSrc, /api\.onPowerSuspend\(\(\) => writeTimerUi\.handleSystemSuspend\(\)\)/);
  assert.match(rendererSrc, /api\.onPowerResume\(\(\) => writeTimerUi\.handleSystemResume\(\)\)/);
  // F3（三审·中/低）：Windows 锁屏不发 suspend —— lock-screen / unlock-screen 复用同一对冻结 / 续算
  // 事件（Electron 45 的 powerMonitor 在 darwin / win32 都提供这两个事件）。
  assert.match(
    mainSrc,
    /powerMonitor\.on\('lock-screen',[\s\S]{0,80}broadcast\('power:suspend'/,
    '锁屏要复用 power:suspend（写作计时冻结）'
  );
  assert.match(
    mainSrc,
    /powerMonitor\.on\('unlock-screen',[\s\S]{0,80}broadcast\('power:resume'/,
    '解锁要复用 power:resume（写作计时续算）'
  );
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWWriteTimerUi，且不乱造别的全局', () => {
  const win = { CWCommon: { pad2: (n) => String(n).padStart(2, '0') } };
  const context = vm.createContext(win);
  vm.runInContext(moduleSrc, context, { filename: 'renderer/write-timer-ui.js' });
  assert.equal(typeof win.CWWriteTimerUi, 'object');
  assert.deepEqual(Object.keys(win.CWWriteTimerUi).sort(), ['REQUIRED_HOST', 'create']);
  assert.equal(win.CWWriteTimerUi.REQUIRED_HOST.length, 6);
  assert.equal(win.CWFragmentsUi, undefined);
});
