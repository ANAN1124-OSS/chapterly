const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const writeTimerUi = require('../renderer/write-timer-ui');
const editorLogic = require('../renderer/editor-logic');

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

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const moduleSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'write-timer-ui.js'), 'utf8');
const moduleCode = moduleSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------- 假 DOM ----------
function makeEl(tag = 'div', id = '') {
  const classes = new Set();
  const listeners = [];
  const el = {
    tagName: tag, id, className: '', textContent: '', title: '', disabled: false, children: [], dataset: {},
    _classes: classes, _listeners: listeners,
    classList: {
      add: (...n) => n.forEach((x) => classes.add(x)),
      remove: (...n) => n.forEach((x) => classes.delete(x)),
      contains: (n) => classes.has(n),
      toggle(n, on) {
        const next = on === undefined ? !classes.has(n) : Boolean(on);
        if (next) classes.add(n);
        else classes.delete(n);
      }
    },
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); String(v || '').split(/\s+/).filter(Boolean).forEach((x) => classes.add(x)); },
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    _fire(type, event) {
      let result;
      for (const l of listeners) if (l.type === type) result = l.fn(event);
      return result;
    }
  };
  return el;
}
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

test('create() 只建表：不碰 DOM / 不建定时器，交出 12 个入口', () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  assert.equal(dom.lookups, 0);
  assert.deepEqual(Object.keys(ctx.ui).sort(), [
    'applyWriteTimerConfig', 'flushWriteTimer', 'pauseWriteTimer', 'renderDurationSettings',
    'renderWriteTimer', 'resetWriteTimer', 'setupWriteTimerUi', 'startWriteTimer', 'writeDurationEnabled',
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
  Date.now = realDateNow;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
});

test('ticker 回调：30 秒定时 flush、1 秒定时只刷新文字；暂停 / 重置会清掉两个定时器', async () => {
  const intervals = [];
  globalThis.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
  globalThis.clearInterval = (id) => { if (intervals[id - 1]) intervals[id - 1].cleared = true; };
  const ctx = build();
  ctx.ui.startWriteTimer();
  const flushTimer = intervals.find((i) => i.ms === 30000);
  const tickTimer = intervals.find((i) => i.ms === 1000);
  flushTimer.fn();
  await flush();
  assert.equal(ctx.calls.api.length, 0, '没到 1 秒不上报');
  ctx.state.writeTimer.unsentMs = 2500;
  flushTimer.fn();
  await flush();
  assert.equal(ctx.calls.api.length, 1);
  assert.deepEqual(ctx.calls.api[0], { seconds: 2 });

  await ctx.ui.pauseWriteTimer();
  assert.equal(intervals.every((i) => i.cleared), true, '暂停后两个定时器都清掉');
  assert.equal(ctx.state.writeTimer.running, false);
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
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
  assert.deepEqual(ok.calls.api, [{ seconds: 2 }]);
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
  assert.deepEqual(serial.calls.api, [{ seconds: 5 }], '第二次时未上报已清零，不重复上报');
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
  assert.equal(rendererSrc.split('writeTimerUi.setupWriteTimerUi();').length - 1, 1, 'setup 只调一次');
  // 码字日历的三个按钮绑定不属于本域，仍留在 renderer
  assert.ok(rendererSrc.includes("$('calendar-prev').addEventListener"));
  assert.ok(rendererSrc.includes("$('calendar-next').addEventListener"));
  assert.ok(rendererSrc.includes("$('calendar-today').addEventListener"));
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
  for (const forbidden of ['require(', 'ipcRenderer', 'node:fs', 'child_process', 'localStorage', 'fetch(', 'window.', 'process.']) {
    assert.equal(moduleCode.includes(forbidden), false, 'write-timer-ui.js 不许出现 ' + forbidden);
  }
  assert.equal(/window\.addEventListener|document\.addEventListener/.test(moduleCode), false);
  assert.equal((moduleCode.match(/setTimeout\(/g) || []).length, 0);
  assert.equal((moduleCode.match(/setInterval\(/g) || []).length, 2);
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWWriteTimerUi，且不乱造别的全局', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(moduleSrc, context, { filename: 'renderer/write-timer-ui.js' });
  assert.equal(typeof win.CWWriteTimerUi, 'object');
  assert.deepEqual(Object.keys(win.CWWriteTimerUi).sort(), ['REQUIRED_HOST', 'create']);
  assert.equal(win.CWWriteTimerUi.REQUIRED_HOST.length, 6);
  assert.equal(win.CWFragmentsUi, undefined);
});
