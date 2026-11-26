const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const statsUi = require('../renderer/stats-ui');
const statsLogic = require('../renderer/stats-logic');
const staleGuard = require('../renderer/stale-guard');
const editorLogic = require('../renderer/editor-logic');
const commonLib = require('../core/common');
const { loadSourceGate, restoreGlobalsAfter, makeEl: makeBaseEl, stripAssertHostBranch } = require('./ui-test-preambles');

// v0.9 B-5 第三刀：「每日字数统计」+「码字日历 / 连续写作天数 / 月度汇总」两个相邻分区
// （原 renderer.js 3609–3715 + 3717–3720 + 3725–3817 行，205 行）搬到 renderer/stats-ui.js。
// 搬之前这两段只有 E2E 里「保存 → 看书架今日字数 / 状态栏 / 设置柱状图 / 翻月 / 汇总文案」
// 的黑盒覆盖；空态 / 坏值 / 失败提示 / 按钮禁用 / 连续天数三种说法在 Node 里一步都测不到。
// 搬出来以后用「假 host + 假 DOM」逐条钉住文案与状态，再用静态闸门保证渲染层不许长回第二份。

// 模块运行时会摸 document：真身由共享前导存下，test.after 放回。
restoreGlobalsAfter(test, ['document']);

const { rendererSrc, indexSrc, moduleSrc, moduleCode } = loadSourceGate('stats-ui.js');

// 2026-11 当作「现在」：翻月 / 按钮状态都相对它算（模块本身不传 now，由 host 回调固定）。
const NOW = new Date(2026, 10, 15, 12, 0, 0, 0);

function formatChars(n) {
  const value = Number(n) || 0;
  if (value < 10000) return `${value} 字`;
  if (value < 100000000) return `${(value / 10000).toFixed(2)} 万字`;
  return `${(value / 100000000).toFixed(2)} 亿字`;
}
const formatDuration = editorLogic.formatDuration;
const statsFormat = { formatChars, formatDuration };

// 共享最小假 DOM 基线（A5）：本体行为统一，$ / createElement 的历史调用口径留在本文件。
const makeEl = (value) => makeBaseEl('div', value);

// 模块运行时摸 document（createElement），Node 里给一个最小替身。
function installDocument() {
  const created = [];
  globalThis.document = {
    createElement(tag) {
      const el = makeEl(tag);
      el.tagName = String(tag).toUpperCase();
      created.push(el);
      return el;
    }
  };
  return created;
}

function makeHost(options = {}) {
  const els = new Map();
  const calls = [];
  const renders = { durationSettings: 0, writeTimer: 0 };
  const calendarEntries = [];
  const state = { stats: null, streak: null, calendar: null, config: {} };
  const missing = options.missing || [];
  const host = {
    $: (id) => {
      if (missing.includes(id)) return null;
      if (!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
    api: { getStats: 'stats:get', getStatsCalendar: 'stats:calendar' },
    async call(channel, payload) {
      calls.push({ channel, payload });
      const handler = options.onCall ? options.onCall(channel, payload) : undefined;
      if (handler instanceof Error) throw handler;
      if (handler !== undefined) return handler;
      return {};
    },
    state,
    statsLogic,
    statsFormat,
    formatChars,
    formatCount: commonLib.formatCount,
    formatDuration,
    writeDurationEnabled: () => Boolean(state.config && state.config.writeDurationEnabled === true),
    renderDurationSettings: () => { renders.durationSettings += 1; },
    renderWriteTimer: () => { renders.writeTimer += 1; },
    calendarSummaryText: (view) => statsLogic.calendarSummaryText(view, statsFormat),
    calendarCells: (view) => statsLogic.calendarCells(view, statsFormat),
    shiftCalendarCursor: (cursor, delta) => statsLogic.shiftCalendarCursor(cursor, delta, NOW),
    calendarStreakLabel: () => statsLogic.calendarStreakLabel(state.streak),
    // 审计修复 #14（E11）：翻月世代令牌（与其它面板同一份实现，生产由 renderer.js 注入）
    staleGuard,
    // M1 第十二刀：状态栏「今日字数」入口（真实来源 settings-ui 的 openStatsCalendar）
    openStatsCalendar: () => { calendarEntries.push('open'); }
  };
  return { host, state, els, calls, renders, calendarEntries };
}

// 一个「本月」的日历视图（月首空格 3 + 2 天 + 月尾空格 2）
function calendarView(overrides = {}) {
  const now = statsLogic.currentYearMonth();
  return {
    year: now.year,
    month: now.month,
    label: `${now.year} 年 ${now.month} 月`,
    isCurrentMonth: true,
    firstWeekday: 3,
    days: [
      { day: `${now.year}-${String(now.month).padStart(2, '0')}-01`, dayOfMonth: 1, chars: 0, seconds: 0, level: 0, written: false, goalMet: false, today: false, future: false },
      { day: `${now.year}-${String(now.month).padStart(2, '0')}-02`, dayOfMonth: 2, chars: 3000, seconds: 600, level: 4, written: true, goalMet: true, today: true, future: false }
    ],
    writtenDays: 1,
    total: 3000,
    average: 3000,
    goal: 2000,
    goalDays: 1,
    totalSeconds: 600,
    bestDay: { day: `${now.year}-${String(now.month).padStart(2, '0')}-02`, chars: 3000 },
    ...overrides
  };
}

test('host 契约：18 个成员缺任何一个都抛 TypeError，空 host / null 也抛', () => {
  const { host } = makeHost();
  assert.deepEqual([...statsUi.REQUIRED_HOST].sort(), [
    '$', 'api', 'call', 'calendarCells', 'calendarStreakLabel', 'calendarSummaryText',
    'formatChars', 'formatCount', 'formatDuration', 'openStatsCalendar', 'renderDurationSettings', 'renderWriteTimer',
    'shiftCalendarCursor', 'staleGuard', 'state', 'statsFormat', 'statsLogic', 'writeDurationEnabled'
  ].sort());
  assert.throws(() => statsUi.create(null), /createStatsUi 需要 host 对象/);
  assert.throws(() => statsUi.create('x'), /createStatsUi 需要 host 对象/);
  for (const key of statsUi.REQUIRED_HOST) {
    const broken = { ...host };
    delete broken[key];
    assert.throws(() => statsUi.create(broken), new RegExp('createStatsUi 的 host 缺少 ' + key.replace(/\$/g, '\\$')));
  }
  // null 也算缺（不是「用假值兜底」）
  const nulled = { ...host, call: null };
  assert.throws(() => statsUi.create(nulled), /createStatsUi 的 host 缺少 call/);
});

test('create() 只建表：没有 document 也能创建，11 个成员都在', () => {
  const { host } = makeHost();
  delete globalThis.document;
  const ui = statsUi.create(host);
  assert.deepEqual(Object.keys(ui).sort(), [
    'applyStatsFilter', 'buildStatsCsv', 'goToCurrentCalendarMonth', 'loadStatsCalendar',
    'refreshStats', 'renderStatsCalendar', 'renderStatsChart', 'renderStatsUi',
    'setupCalendarUi', 'setupStatsUi', 'shiftStatsCalendar'
  ].sort());
});

test('refreshStats：走 api.getStats，写 state.stats / streak / calendar，渲染两份显示', async () => {
  installDocument();
  const payload = {
    todayChars: 1200,
    goal: 2000,
    goalPercent: 60,
    goalMet: false,
    days: [],
    recentTotal: 5000,
    todaySeconds: 0,
    streak: { current: 2, best: 4 },
    calendar: calendarView()
  };
  const { host, state, calls, renders } = makeHost({ onCall: (channel) => (channel === 'stats:get' ? payload : undefined) });
  const ui = statsUi.create(host);
  const got = await ui.refreshStats();
  // 1.6.0 F2：取数带上「全部书 / 全部年」筛选（主进程按它现算汇总，不改 stats.json）
  assert.deepEqual(calls, [{ channel: 'stats:get', payload: { bookId: '', year: 0 } }]);
  assert.equal(got, payload);
  assert.equal(state.stats, payload);
  assert.equal(state.streak, payload.streak);
  assert.equal(state.calendar, payload.calendar);
  assert.equal(host.$('shelf-stats').classList.contains('hidden'), false);
  assert.equal(host.$('shelf-stats-today').textContent, '今天 +1200 字');
  assert.equal(host.$('status-stats-text').textContent, '今日 1200 字 / 2000 字');
  assert.equal(renders.durationSettings, 1);
  assert.equal(renders.writeTimer, 1);

  // payload 里缺 streak / calendar → 兜底 null（不保留上一份）
  const bare = { todayChars: 5, goal: 0, goalPercent: 0, goalMet: false, days: [], recentTotal: 5, todaySeconds: 0 };
  const second = makeHost({ onCall: (channel) => (channel === 'stats:get' ? bare : undefined) });
  const ui2 = statsUi.create(second.host);
  await ui2.refreshStats();
  assert.equal(second.state.streak, null);
  assert.equal(second.state.calendar, null);
});

// 五-L15（RF-04）：连续天数是书架常显信息，不属于「用户正在看哪个月」—— 旧实现把 streak 与
// calendar 绑在同一个「日历停在本月」闸门里：翻到历史月 / 跨午夜后再保存，刷新回执里的 streak
// 永远写不进来，书架头「连续 N 天」停在翻月前的旧值，要手动点「本月」才恢复。
test('五-L15（RF-04）：翻历史月 / 跨午夜后刷新，连续天数随最新回执更新，日历视图留在原月', async () => {
  installDocument();
  const october = calendarView({ month: 10, label: '2026 年 10 月', isCurrentMonth: false });
  const payload = {
    todayChars: 800,
    goal: 0,
    goalPercent: 0,
    goalMet: false,
    days: [],
    recentTotal: 800,
    todaySeconds: 0,
    streak: { current: 4, best: 9 },
    calendar: calendarView()
  };
  const { host, state } = makeHost({ onCall: (channel) => (channel === 'stats:get' ? payload : undefined) });
  const ui = statsUi.create(host);
  // 用户翻到历史月；或应用开着跨过午夜、日历游标还停在上一月（两种场景同一个闸门）
  state.calendar = october;
  state.streak = { current: 3, best: 9 };
  await ui.refreshStats();
  assert.deepEqual(state.streak, payload.streak, '连续天数必须随最新回执更新（与月份视图无关）');
  assert.equal(state.calendar, october, '日历仍留在用户翻到的月份（E-N8 的日历闸门不变）');
  assert.equal(host.$('shelf-stats-streak').textContent, '连续 4 天', '书架头立刻显示最新连续天数');
  assert.equal(host.$('shelf-stats-streak').title, '已连续写作 4 天 · 最长连续 9 天');
});

test('refreshStats：IPC 失败不炸、保留上一次数据、照常重绘', async () => {
  installDocument();
  const { host, state, calls } = makeHost({ onCall: (channel) => (channel === 'stats:get' ? new Error('统计坏了') : undefined) });
  const ui = statsUi.create(host);
  const old = { todayChars: 500, goal: 0, goalPercent: 0, goalMet: false, days: [], recentTotal: 500, todaySeconds: 0 };
  state.stats = old;
  const got = await ui.refreshStats();
  assert.equal(got, old);
  assert.equal(state.stats, old, '失败时不许把旧数据清掉');
  assert.equal(calls.length, 1);
  assert.equal(host.$('shelf-stats-today').textContent, '今天 +500 字');
});

test('renderStatsUi：没有统计时两块都隐藏，目标行 / 进度条收起', () => {
  installDocument();
  const { host } = makeHost();
  const ui = statsUi.create(host);
  ui.renderStatsUi();
  assert.equal(host.$('shelf-stats').classList.contains('hidden'), true);
  assert.equal(host.$('status-stats').classList.contains('hidden'), true);
  assert.equal(host.$('settings-stats-summary').textContent, '还没有统计数据（保存一次后开始记录）');
  assert.equal(host.$('settings-goal-state').textContent, '未设目标');
});

test('renderStatsUi：今日字数 / 目标百分比 / 达标 / 连续天数 / 状态栏文案逐字写死', () => {
  installDocument();
  const { host, state } = makeHost();
  const ui = statsUi.create(host);
  state.stats = { todayChars: 2500, goal: 2000, goalPercent: 100, goalMet: true, days: [], recentTotal: 2500, todaySeconds: 0 };
  state.streak = { current: 3, best: 5 };
  ui.renderStatsUi();

  assert.equal(host.$('shelf-stats').classList.contains('hidden'), false);
  assert.equal(host.$('shelf-stats').classList.contains('is-quiet'), false);
  assert.equal(host.$('shelf-stats-today').textContent, '今天 +2500 字');
  assert.equal(host.$('shelf-stats-goal').textContent, '目标 2000 字 · 100% · 已达标');
  assert.equal(host.$('shelf-stats-goal').classList.contains('hidden'), false);
  assert.equal(host.$('shelf-goal-track').classList.contains('hidden'), false);
  assert.equal(host.$('shelf-goal-fill').style.width, '100%');
  assert.equal(host.$('shelf-stats-streak').textContent, '连续 3 天');
  assert.equal(host.$('shelf-stats-streak').classList.contains('hidden'), false);
  assert.equal(host.$('shelf-stats-streak').title, '已连续写作 3 天 · 最长连续 5 天');
  assert.equal(host.$('shelf-stats').title, '只统计保存动作写下的字数（不含未保存内容；删字不倒扣）。今日目标 2,000 字。');
  assert.equal(host.$('status-stats-text').textContent, '今日 2500 字 / 2000 字');
  assert.equal(host.$('status-stats-text').title, '只统计保存动作写下的字数（不含未保存内容；删字不倒扣）。今日目标 2,000 字。点它打开码字日历（只读）。');
  assert.equal(host.$('status-stats').title, '只统计保存动作写下的字数（不含未保存内容；删字不倒扣）。今日目标 2,000 字。点它打开码字日历（只读）。');
});

test('RSHE-A-06：目标百分比三处同一夹紧口径（负值不会被算成负进度）', () => {
  installDocument();
  const { host, state } = makeHost();
  const ui = statsUi.create(host);
  // 脏数据：主进程 / 旧 stats.json 里可能出现负数或超 100 的百分比
  state.stats = { todayChars: 10, goal: 2000, goalPercent: -20, goalMet: false, days: [], recentTotal: 10, todaySeconds: 0 };
  ui.renderStatsUi();
  assert.equal(host.$('shelf-stats-goal').textContent, '目标 2000 字 · 0%');
  assert.equal(host.$('shelf-goal-fill').style.width, '0%');
  // 柱状图汇总行过去少了 Math.max(0, …) 下界，三处会互相矛盾；现在三处都走 clampGoalPercent
  ui.renderStatsChart();
  assert.match(host.$('settings-stats-summary').textContent, /目标 2000 字（0%）/);
  assert.equal(host.$('settings-goal-state').textContent, '今天完成 0%');
  state.stats = { todayChars: 3000, goal: 2000, goalPercent: 150, goalMet: true, days: [], recentTotal: 3000, todaySeconds: 0 };
  ui.renderStatsUi();
  assert.equal(host.$('shelf-stats-goal').textContent, '目标 2000 字 · 100% · 已达标');
  ui.renderStatsChart();
  assert.match(host.$('settings-stats-summary').textContent, /目标 2000 字（100%）/);
});

test('renderStatsUi：今天没写字时书架头切安静排法，没设目标时提示去设置里设', () => {
  installDocument();
  const { host, state } = makeHost();
  const ui = statsUi.create(host);
  state.stats = { todayChars: 0, goal: 0, goalPercent: 0, goalMet: false, days: [], recentTotal: 0, todaySeconds: 0 };
  ui.renderStatsUi();
  assert.equal(host.$('shelf-stats').classList.contains('is-quiet'), true);
  assert.equal(host.$('shelf-stats-today').textContent, '今天还没写字');
  assert.equal(host.$('shelf-stats-goal').textContent, '');
  assert.equal(host.$('shelf-stats-goal').classList.contains('hidden'), true);
  assert.equal(host.$('shelf-goal-track').classList.contains('hidden'), true);
  assert.equal(host.$('shelf-goal-fill').style.width, '0%');
  assert.equal(host.$('shelf-stats-streak').textContent, '');
  assert.equal(host.$('shelf-stats-streak').classList.contains('hidden'), true);
  assert.equal(host.$('shelf-stats').title, '只统计保存动作写下的字数（不含未保存内容；删字不倒扣）。可在「设置 → 写作统计」里设每日目标。');
  assert.equal(host.$('status-stats-text').textContent, '今日 0 字');
});

test('renderStatsChart：30 天柱子高度 / 今天高亮 / 汇总与达标状态逐字写死', () => {
  const created = installDocument();
  const { host, state } = makeHost();
  const ui = statsUi.create(host);
  state.stats = {
    todayChars: 500,
    goal: 2000,
    goalPercent: 25,
    goalMet: false,
    days: [{ day: '2026-10-05', chars: 0 }, { day: '2026-10-06', chars: 100 }, { day: '2026-10-07', chars: 5000 }],
    recentTotal: 12345,
    todaySeconds: 125
  };
  ui.renderStatsChart();
  const chart = host.$('settings-stats-chart');
  assert.equal(chart.children.length, 3);
  assert.equal(chart.children[0].className, 'stats-bar');
  assert.equal(chart.children[2].className, 'stats-bar today');
  assert.equal(chart.children[0].children[0].style.height, '0%');
  assert.equal(chart.children[1].children[0].style.height, '2%', '非零值至少 2%，四舍五入到整数');
  assert.equal(chart.children[2].children[0].style.height, '100%');
  assert.equal(chart.children[0].title, '2026-10-05 · 0 字');
  assert.equal(chart.children[2].title, '2026-10-07 · 5000 字');
  assert.equal(
    host.$('settings-stats-summary').textContent,
    '今天 500 字 · 近 30 天 1.23 万字 · 目标 2000 字（25%） · 今日写作 2 分钟'
  );
  assert.equal(host.$('settings-goal-state').textContent, '今天完成 25%');

  // 没设目标 + 写作计时开着（秒数为 0 也要显示「今日写作 0 秒」）
  state.config = { writeDurationEnabled: true };
  state.stats = { todayChars: 0, goal: 0, goalPercent: 0, goalMet: false, days: [], recentTotal: 0, todaySeconds: 0 };
  ui.renderStatsChart();
  assert.equal(
    host.$('settings-stats-summary').textContent,
    '今天 0 字 · 近 30 天 0 字 · 未设目标 · 今日写作 0 秒'
  );
  assert.equal(host.$('settings-goal-state').textContent, '未设目标');
  assert.equal(chart.children.length, 0, '重新渲染要先清空，不能叠加');
  assert.ok(created.length > 0);
});

test('loadStatsCalendar：按年月走 api.getStatsCalendar，写 state 并重绘；失败给中文提示', async () => {
  installDocument();
  const view = calendarView({ month: 10, isCurrentMonth: false });
  const { host, state, calls } = makeHost({
    onCall: (channel) => (channel === 'stats:calendar' ? { calendar: view, streak: { current: 1, best: 2 } } : undefined)
  });
  const ui = statsUi.create(host);
  const got = await ui.loadStatsCalendar(2026, 10);
  assert.deepEqual(calls, [{ channel: 'stats:calendar', payload: { year: 2026, month: 10 } }]);
  assert.equal(state.calendar, view);
  assert.deepEqual(state.streak, { current: 1, best: 2 });
  assert.equal(got, view);
  assert.equal(host.$('calendar-label').textContent, view.label);
  assert.ok(host.$('calendar-grid').children.length > 0);

  // 返回里没有 calendar / streak → 保留上一份，不覆盖
  const keep = makeHost({ onCall: () => ({}) });
  keep.state.calendar = view;
  keep.state.streak = { current: 9, best: 9 };
  const ui2 = statsUi.create(keep.host);
  assert.equal(await ui2.loadStatsCalendar(2026, 10), view);
  assert.equal(keep.state.calendar, view);
  assert.deepEqual(keep.state.streak, { current: 9, best: 9 });

  // 失败：汇总位置写「读取码字日历失败：…」，返回 null，不动 state
  const fail = makeHost({ onCall: (channel) => (channel === 'stats:calendar' ? new Error('读日历失败') : undefined) });
  fail.state.calendar = view;
  const ui3 = statsUi.create(fail.host);
  assert.equal(await ui3.loadStatsCalendar(2026, 10), null);
  assert.equal(fail.state.calendar, view);
  assert.equal(fail.host.$('calendar-summary').textContent, '读取码字日历失败：读日历失败');
});

test('shiftStatsCalendar：不翻到未来 / delta 0 不动 / 往前一个月真的换月；1970-01 是下限', async () => {
  installDocument();
  const view = calendarView();
  const { host, state, calls } = makeHost({ onCall: () => ({}) });
  const ui = statsUi.create(host);
  state.calendar = view;

  assert.equal(await ui.shiftStatsCalendar(1), false, '本月再往后 = 未来，不翻');
  assert.equal(await ui.shiftStatsCalendar(0), false, 'delta 0 不翻');
  assert.equal(calls.length, 0, '不该翻的时候一个 IPC 都不打');

  state.calendar = { year: 2026, month: 11 };
  await ui.shiftStatsCalendar(-1);
  assert.deepEqual(calls, [{ channel: 'stats:calendar', payload: { year: 2026, month: 10 } }]);

  state.calendar = { year: 1970, month: 1 };
  assert.equal(await ui.shiftStatsCalendar(-1), false);
  assert.equal(calls.length, 1);
});

test('goToCurrentCalendarMonth：按本地当前年月重新载入（回到本月）', async () => {
  installDocument();
  const { host, calls } = makeHost({ onCall: () => ({}) });
  const ui = statsUi.create(host);
  await ui.goToCurrentCalendarMonth();
  const now = statsLogic.currentYearMonth();
  assert.deepEqual(calls, [{ channel: 'stats:calendar', payload: { year: now.year, month: now.month } }]);
});

// 审计修复 #14（E11）：翻月没有请求令牌时，两次请求乱序返回会让日历停在先那次请求的月份。
test('翻月竞态：旧回执晚到整段作废，日历停在最新一次翻月的月份（E11）', async () => {
  installDocument();
  const gates = [];
  const { host, state } = makeHost({
    onCall: (channel) => {
      if (channel !== 'stats:calendar') return undefined;
      return new Promise((resolve) => gates.push(resolve));
    }
  });
  const ui = statsUi.create(host);
  state.calendar = calendarView(); // 停在本月（11 月）
  state.streak = { current: 5, best: 9 };

  const first = ui.shiftStatsCalendar(-1); // 10 月
  const second = ui.shiftStatsCalendar(-2); // 9 月（第一次还在途，游标仍是本月）
  assert.equal(gates.length, 2, '两次翻月各发一个请求');

  // 后发的先回：九月落盘 + 重绘
  const september = calendarView({ month: 9, label: '2026 年 9 月', isCurrentMonth: false });
  gates[1]({ calendar: september, streak: { current: 9, best: 9 } });
  assert.equal(await second, september);
  assert.equal(state.calendar.month, 9);
  assert.equal(host.$('calendar-label').textContent, '2026 年 9 月');

  // 先发的后回：必须作废 —— 不许把界面拉回十月，streak 也不许跟着回退
  const october = calendarView({ month: 10, label: '2026 年 10 月', isCurrentMonth: false });
  gates[0]({ calendar: october, streak: { current: 10, best: 10 } });
  assert.equal(await first, null, '旧回执不结算');
  assert.equal(state.calendar.month, 9, '停在最新一次翻月的月份');
  assert.deepEqual(state.streak, { current: 9, best: 9 });
  assert.equal(host.$('calendar-label').textContent, '2026 年 9 月');

  // 旧请求的失败也不许在汇总行上留下「读取失败」（新月份已经读到）
  const failGates = [];
  const fail = makeHost({
    onCall: (channel) => {
      if (channel !== 'stats:calendar') return undefined;
      return new Promise((resolve, reject) => failGates.push({ resolve, reject }));
    }
  });
  const failUi = statsUi.create(fail.host);
  fail.state.calendar = calendarView();
  const stale = failUi.shiftStatsCalendar(-1);
  const fresh = failUi.shiftStatsCalendar(-2);
  failGates[1].resolve({ calendar: september });
  await fresh;
  failGates[0].reject(new Error('旧请求超时'));
  assert.equal(await stale, null);
  assert.equal(fail.state.calendar, september);
  assert.ok(
    !fail.host.$('calendar-summary').textContent.includes('读取码字日历失败'),
    '旧失败的提示不许盖掉新结果：' + fail.host.$('calendar-summary').textContent
  );
});

// 审计残留修复 #R13（#14/E10-E11）+ WP14 E-N8：日历与刷新拆世代号。
// 旧契约（#R13）是「刷新与翻月共用 calendarSeq，最新发出者写日历」——它挡住了旧回执，
// 但留下 E-N8 的实测缺陷：
//   ① 用户翻到历史月后，筛选变化 / 保存后的 refreshStats 成为最新请求，把日历拉回本月；
//   ② 用户在途翻月的回执被后发的刷新判成 stale，翻月白点。
// 新契约：calendarSeq 只服务翻月（翻月的乱序仍按 E11 作废旧回执）；
// refreshStats 用 statsSeq 管自己的汇总数据；state.calendar 只有「当前显示本月 / 还没有日历」
// 时才回写（历史月视图归用户显式翻月，刷新无权改）；连续天数按五-L15 无条件随最新回执更新
// —— 它是书架常显信息，不属于月份视图，不许被同一道闸门冻结。
test('跨路径：刷新不把历史月拉回本月、翻月回执按自己的世代号结算（E-N8 / #R13）', async () => {
  installDocument();
  // ① 先翻到历史月，再刷新统计：日历 / 连续天数不动，汇总与柱状图照常更新。
  const october = calendarView({ month: 10, label: '2026 年 10 月', isCurrentMonth: false });
  const historyGates = [];
  const history = makeHost({
    onCall: (channel) => {
      if (channel === 'stats:get') return new Promise((resolve) => historyGates.push(resolve));
      return undefined;
    }
  });
  const historyUi = statsUi.create(history.host);
  history.state.calendar = october;
  history.state.streak = { current: 10, best: 10 };
  const historyRefresh = historyUi.refreshStats();
  const refreshedInHistory = {
    todayChars: 1200,
    goal: 2000,
    goalPercent: 60,
    goalMet: false,
    days: [],
    recentTotal: 5000,
    todaySeconds: 0,
    streak: { current: 1, best: 1 },
    calendar: calendarView()
  };
  historyGates[0](refreshedInHistory);
  assert.equal(await historyRefresh, refreshedInHistory);
  assert.equal(history.state.stats, refreshedInHistory, '汇总 / 柱状图的数据照常更新');
  assert.equal(history.state.calendar, october, '历史月视图不许被刷新拉回本月');
  assert.deepEqual(
    history.state.streak,
    refreshedInHistory.streak,
    '五-L15：连续天数随最新刷新更新（不属于月份视图），日历仍停在历史月'
  );

  // ② 刷新先发、翻月后发：翻月先回，刷新晚到 —— 汇总更新，日历停在十月。
  const statsGates = [];
  const calendarGates = [];
  const { host, state } = makeHost({
    onCall: (channel) => {
      if (channel === 'stats:get') return new Promise((resolve) => statsGates.push(resolve));
      if (channel === 'stats:calendar') return new Promise((resolve) => calendarGates.push(resolve));
      return undefined;
    }
  });
  const ui = statsUi.create(host);
  state.calendar = calendarView(); // 停在本月
  state.streak = { current: 5, best: 9 };

  const refreshing = ui.refreshStats(); // 先发出：带默认月的 payload
  const loaded = ui.loadStatsCalendar(2026, 10); // 后发出：翻到十月
  assert.equal(statsGates.length, 1);
  assert.equal(calendarGates.length, 1);

  calendarGates[0]({ calendar: october, streak: { current: 10, best: 10 } });
  assert.equal(await loaded, october);
  assert.equal(state.calendar.month, 10);
  assert.equal(host.$('calendar-label').textContent, '2026 年 10 月');

  const late = {
    todayChars: 1200,
    goal: 2000,
    goalPercent: 60,
    goalMet: false,
    days: [],
    recentTotal: 5000,
    todaySeconds: 0,
    streak: { current: 1, best: 1 },
    calendar: calendarView()
  };
  statsGates[0](late);
  assert.equal(await refreshing, late);
  assert.equal(state.stats, late, '汇总 / 柱状图的数据照常更新');
  assert.equal(state.calendar.month, 10, '日历停在用户翻到的月份');
  assert.deepEqual(state.streak, late.streak, '五-L15：连续天数跟随最新刷新回执（日历仍停在十月）');
  assert.equal(host.$('calendar-label').textContent, '2026 年 10 月');

  // ③ 翻月先发、刷新后发：刷新先回也不许吃掉在途翻月；用户显式翻到的九月最终生效。
  const reverseGates = [];
  const reverse = makeHost({
    onCall: (channel) => new Promise((resolve) => reverseGates.push({ channel, resolve }))
  });
  const ui2 = statsUi.create(reverse.host);
  reverse.state.calendar = calendarView(); // 停在本月
  reverse.state.streak = { current: 5, best: 9 };
  const flipToSeptember = ui2.loadStatsCalendar(2026, 9);
  const refreshAfter = ui2.refreshStats();
  assert.equal(reverseGates[0].channel, 'stats:calendar');
  assert.equal(reverseGates[1].channel, 'stats:get');
  const payload = {
    todayChars: 5,
    goal: 0,
    goalPercent: 0,
    goalMet: false,
    days: [],
    recentTotal: 5,
    todaySeconds: 0,
    streak: { current: 2, best: 2 },
    calendar: october
  };
  reverseGates[1].resolve(payload); // 刷新（后发）先回
  assert.equal(await refreshAfter, payload);
  reverseGates[0].resolve({
    calendar: calendarView({ month: 9, label: '2026 年 9 月', isCurrentMonth: false }),
    streak: { current: 9, best: 9 }
  });
  const septemberView = calendarView({ month: 9, label: '2026 年 9 月', isCurrentMonth: false });
  assert.deepEqual(await flipToSeptember, septemberView, '翻月自己的世代号仍是最新，不被刷新作废');
  assert.equal(reverse.state.calendar.month, 9, '用户显式翻到的月份最终生效');
  assert.deepEqual(reverse.state.streak, { current: 9, best: 9 });
});

test('renderStatsCalendar：没有视图时清空格子、汇总给提示、三个按钮都禁用', () => {
  installDocument();
  const { host, state } = makeHost();
  const ui = statsUi.create(host);
  state.calendar = null;
  host.$('calendar-grid').children = [makeEl('x')];
  ui.renderStatsCalendar();
  assert.equal(host.$('calendar-grid').children.length, 0);
  assert.equal(host.$('calendar-label').textContent, '');
  assert.equal(host.$('calendar-summary').textContent, '还没有统计数据（保存一次后开始记录）');
  assert.equal(host.$('calendar-streak').textContent, '');
  assert.equal(host.$('calendar-prev').disabled, true);
  assert.equal(host.$('calendar-next').disabled, true);
  assert.equal(host.$('calendar-today').disabled, true);
});

test('renderStatsCalendar：星期表头只建一次；空格 / 格子 / dataset / 汇总 / 连续天数逐条钉住', () => {
  installDocument();
  const { host, state } = makeHost();
  const ui = statsUi.create(host);
  const view = calendarView();
  state.calendar = view;
  state.streak = { current: 2, best: 3 };
  ui.renderStatsCalendar();

  const weekdays = host.$('calendar-weekdays');
  assert.equal(weekdays.children.length, 7);
  assert.equal(weekdays.children[0].textContent, '一');
  ui.renderStatsCalendar();
  assert.equal(weekdays.children.length, 7, '第二次渲染不该再追加表头');

  const grid = host.$('calendar-grid');
  // 3 个空格 + 2 天 + 2 个空格
  assert.equal(grid.children.length, 7);
  assert.equal(grid.children[0].className, 'cal-day empty');
  assert.equal(grid.children[3].className, 'cal-day');
  assert.equal(grid.children[3].children[0].textContent, '1');
  assert.equal(grid.children[4].className, 'cal-day written lv4 goal-met today');
  assert.deepEqual(grid.children[4].dataset, {
    day: view.days[1].day, chars: '3000', seconds: '600', level: '4', goalMet: '1'
  });
  assert.equal(grid.children[4].children[0].textContent, '2');
  assert.equal(grid.children[4].title, `${view.days[1].day} · 3000 字 · 用时 10 分钟 · 已达标 · 今天`);
  assert.equal(grid.children[6].className, 'cal-day empty');

  assert.equal(host.$('calendar-label').textContent, view.label);
  assert.equal(
    host.$('calendar-summary').textContent,
    `本月 3000 字 · 写了 1 天 · 日均 3000 字 · 达标 1 天 · 最高 ${view.days[1].day.slice(5)}（3000 字） · 用时 10 分钟`
  );
  assert.equal(host.$('calendar-streak').textContent, '已连续写作 2 天 · 最长 3 天');
  assert.equal(host.$('calendar-streak').classList.contains('off'), false);
  // 本月：下一月 / 本月按钮禁用，上一月可用
  assert.equal(host.$('calendar-prev').disabled, false);
  assert.equal(host.$('calendar-next').disabled, true);
  assert.equal(host.$('calendar-today').disabled, true);

  // 连续天数断了：文案换一种说法 + 加 off 类
  state.streak = { current: 0, best: 3 };
  ui.renderStatsCalendar();
  assert.equal(host.$('calendar-streak').textContent, '连续写作中断 · 最长 3 天');
  assert.equal(host.$('calendar-streak').classList.contains('off'), true);
});

test('元素缺失也不炸：$ 全返回 null 时 renderStatsUi / renderStatsCalendar 静默跳过', () => {
  const { host, state } = makeHost({ missing: ['shelf-stats', 'status-stats', 'calendar-grid', 'settings-stats-chart', 'settings-stats-summary', 'settings-goal-state'] });
  const ui = statsUi.create(host);
  state.stats = { todayChars: 10, goal: 0, goalPercent: 0, goalMet: false, days: [{ day: '2026-11-01', chars: 10 }], recentTotal: 10, todaySeconds: 0 };
  assert.doesNotThrow(() => ui.renderStatsUi());
  assert.doesNotThrow(() => ui.renderStatsCalendar());
  assert.doesNotThrow(() => ui.renderStatsChart());
});

// ---------- M1（第一轮·低）第十二刀：码字日历 + 状态栏「今日字数」接线（setupCalendarUi） ----------
// 15 行接线（翻月 / 回到本月 / 今日字数入口）从 renderer.js 的 bindEvents 整段搬进 stats-ui.js；
// 这里用假 DOM 把「哪个按钮 → 哪个模块入口」逐条钉住。
function fire(el, type, event) {
  let result;
  for (const listener of el._listeners.filter((item) => item.type === type)) result = listener.fn(event);
  return result;
}

test('M1 第十二刀：日历三按钮 + 状态栏入口各挂一份监听，点击走模块既有入口', async () => {
  const h = makeHost({ onCall: () => ({}) });
  const ui = statsUi.create(h.host);
  ui.setupCalendarUi();
  for (const id of ['calendar-prev', 'calendar-next', 'calendar-today', 'status-stats']) {
    assert.equal(h.els.get(id)._listeners.filter((item) => item.type === 'click').length, 1, id + ' 只挂一份点击监听');
  }

  // 翻月：state.calendar 有视图（本月）才能算出上 / 下一个月，然后走 loadStatsCalendar
  h.state.calendar = calendarView();
  fire(h.els.get('calendar-prev'), 'click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.filter((call) => call.channel === 'stats:calendar').length, 1, '上一月要重新载入日历');
  // 回执落地会换掉 state.calendar；下一月不能翻到未来（模块的边界口径），所以从 9 月往后翻
  h.state.calendar = calendarView({ month: 9 }); // 回执落地会换掉 state.calendar，下一次翻月要有视图才能算月份
  fire(h.els.get('calendar-next'), 'click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.filter((call) => call.channel === 'stats:calendar').length, 2, '下一月要重新载入日历');
  fire(h.els.get('calendar-today'), 'click');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.filter((call) => call.channel === 'stats:calendar').length, 3, '回到本月也要重新载入');

  // 状态栏「今日字数」= 打开设置里的日历分区（注入的取值函数）
  fire(h.els.get('status-stats'), 'click');
  assert.deepEqual(h.calendarEntries, ['open'], '状态栏今日字数要调注入的 openStatsCalendar');
});

test('M1 第十二刀：setupCalendarUi 幂等；静态闸门——接线只在 stats-ui.js，编排器只剩一次调用', () => {
  const h = makeHost();
  const ui = statsUi.create(h.host);
  ui.setupCalendarUi();
  ui.setupCalendarUi();
  for (const id of ['calendar-prev', 'calendar-next', 'calendar-today', 'status-stats']) {
    assert.equal(h.els.get(id)._listeners.filter((item) => item.type === 'click').length, 1, id + ' 重入不许挂第二份');
  }

  assert.match(rendererSrc, /^    setupCalendarUi\(\);$/m, '编排器要在原位置调用 setupCalendarUi()');
  assert.equal((rendererSrc.match(/setupCalendarUi\(\);/g) || []).length, 1, '只许调用一次');
  for (const id of ['calendar-prev', 'calendar-next', 'calendar-today', 'status-stats']) {
    assert.equal(rendererSrc.includes(`$('${id}').addEventListener`), false, '日历 / 状态栏绑定必须整段搬出编排器：' + id);
    assert.ok(moduleSrc.includes(`$('${id}').addEventListener`), '模块里缺接线：' + id);
  }
  assert.match(moduleSrc, /function setupCalendarUi\(\)/, '模块要提供 setupCalendarUi()');
});

test('静态闸门：renderer.js 不再内嵌两份实现，只剩接线 + 薄封装', () => {
  for (const name of ['refreshStats', 'renderStatsUi', 'renderStatsChart', 'loadStatsCalendar',
    'shiftStatsCalendar', 'goToCurrentCalendarMonth', 'appendCalendarBlank', 'renderStatsCalendar']) {
    assert.equal(
      new RegExp('^  (?:async )?function ' + name + '\\b', 'm').test(rendererSrc),
      false,
      'renderer.js 里又有 ' + name + ' 的第二份实现（该在 stats-ui.js）'
    );
  }
  // 接线：模块只 create 一次，18 个 host 成员都传进去（第十二刀补 openStatsCalendar）
  assert.match(rendererSrc, /const statsUi = statsUiModule\.create\(\{/);
  for (const key of ['$', 'api', 'call', 'state', 'statsLogic', 'statsFormat', 'formatChars', 'formatCount',
    'formatDuration', 'writeDurationEnabled', 'renderDurationSettings', 'renderWriteTimer',
    'calendarSummaryText', 'calendarCells', 'shiftCalendarCursor', 'calendarStreakLabel', 'openStatsCalendar']) {
    assert.ok(rendererSrc.includes(key), 'host 少了 ' + key);
  }
  // 5 个入口是模块级 const（视图切换 / 设置 / 事件绑定 / 测试钩子照旧按名字取）
  assert.match(rendererSrc, /^  const \{ refreshStats, renderStatsUi, renderStatsChart, shiftStatsCalendar, goToCurrentCalendarMonth \} = statsUi;$/m);
  // 测试钩子的 host 契约 + stats-logic 静态闸门钉住的薄封装 / 三个调用点还在
  assert.match(rendererSrc, /^  function calendarSummaryText\(view\) \{$/m);
  assert.match(rendererSrc, /statsLogic\.calendarCells\(view, statsFormat\)/);
  assert.match(rendererSrc, /statsLogic\.shiftCalendarCursor\(/);
  assert.match(rendererSrc, /statsLogic\.calendarStreakLabel\(state\.streak\)/);
  // 头部从全局拿模块
  assert.match(rendererSrc, /^  const statsUiModule = window\.CWStatsUi;$/m);
});

test('静态闸门：index.html 在 renderer.js 之前加载 stats-ui.js，模块自己不许碰后端', () => {
  const moduleIdx = indexSrc.indexOf('src="stats-ui.js"');
  const rendererIdx = indexSrc.indexOf('src="renderer.js"');
  assert.ok(moduleIdx > 0, 'index.html 没有加载 stats-ui.js');
  assert.ok(moduleIdx < rendererIdx, 'stats-ui.js 必须排在 renderer.js 之前');
  // A2-GATE-05：indexOf 找不到时返回 -1，-1 < moduleIdx 恒真 —— 先断言真找到了再比顺序。
  const logicIdx = indexSrc.indexOf('src="stats-logic.js"');
  assert.ok(logicIdx > 0, 'index.html 没有加载 stats-logic.js');
  assert.ok(logicIdx < moduleIdx, '排在 stats-logic.js 之后');
  // A8（WP-32）：唯一允许的 require 是 UMD 的 Node 分支取 core/assert-host.js；
  // 运行时代码仍不许 require 任何东西。
  // T8（三审·低）：UMD 分支闸门只留 tests/assert-host.test.js 一处（那里逐个模块核对 require / 全局名 / 工厂签名）。
  const runtimeCode = stripAssertHostBranch(moduleCode);
  assert.equal(/\brequire\s*\(/.test(runtimeCode), false, 'stats-ui.js 不许 require');
  assert.equal(/ipcRenderer|node:fs|\bwindow\s*\.\s*cwApi/.test(moduleCode), false, '不许自己摸 Electron / 文件系统');
  assert.equal(/^ {2}\$\(/m.test(moduleCode), false, '模块顶层不许直接查 DOM');
  assert.equal(/\bprocess\./.test(moduleCode), false, 'stats-ui.js 不许碰 process');
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWStatsUi，且不乱造别的全局', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(moduleSrc, context, { filename: 'renderer/stats-ui.js' });
  assert.equal(typeof win.CWStatsUi, 'object');
  assert.deepEqual(Object.keys(win.CWStatsUi).sort(), ['REQUIRED_HOST', 'create']);
  assert.deepEqual(Array.from(win.CWStatsUi.REQUIRED_HOST), Array.from(statsUi.REQUIRED_HOST));
  assert.equal(typeof win.CWStatsUi.create, 'function');
  assert.equal(win.CWExportUi, undefined, '单独加载 stats-ui 不该顺手造出别的全局');
  assert.equal(win.CWStatsLogic, undefined);
});
// ---------- 统计筛选 + CSV（1.6.0 F2） ----------
// 两个下拉（全部书 / 某书；全部年 / 某年）驱动主进程的 aggregate，汇总行只显示筛选后的
// 总字数 / 写作天数 / 日均；CSV 由渲染层拼字符串（本窗口没有落盘通道，见执行卡 §9）。

function aggregateFixture() {
  return {
    filter: { bookId: '', year: 0 },
    totals: { totalChars: 1050, writtenDays: 4, averageChars: 263 },
    days: [
      { day: '2025-12-31', chars: 150 },
      { day: '2026-01-01', chars: 200 },
      { day: '2026-01-02', chars: 300 },
      { day: '2026-02-10', chars: 400 }
    ],
    months: [
      { month: '2025-12', chars: 150, writtenDays: 1 },
      { month: '2026-01', chars: 500, writtenDays: 2 },
      { month: '2026-02', chars: 400, writtenDays: 1 }
    ],
    options: {
      books: [
        { id: 'b1', chars: 700, writtenDays: 3 },
        { id: 'b2', chars: 350, writtenDays: 2 }
      ],
      years: [
        { year: 2026, chars: 900 },
        { year: 2025, chars: 150 }
      ]
    }
  };
}

test('统计筛选：两个下拉的选项来自 aggregate.options，书名走书架标题、认不出给 id 前缀', async () => {
  installDocument();
  const payload = { todayChars: 10, goal: 0, goalPercent: 0, goalMet: false, days: [], recentTotal: 10, todaySeconds: 0 };
  payload.aggregate = aggregateFixture();
  const { host, state } = makeHost({ onCall: (channel) => (channel === 'stats:get' ? payload : undefined) });
  state.books = [{ id: 'b1', title: '书甲' }];
  const ui = statsUi.create(host);
  await ui.refreshStats();

  const books = host.$('stats-filter-book');
  assert.deepEqual(books.children.map((el) => el.value), ['', 'b1', 'b2']);
  assert.deepEqual(books.children.map((el) => el.textContent), ['全部书', '书甲 · 700 字', '不在书架（b2） · 350 字']);
  const years = host.$('stats-filter-year');
  assert.deepEqual(years.children.map((el) => el.value), ['0', '2026', '2025']);
  assert.deepEqual(years.children.map((el) => el.textContent), ['全部年', '2026 年 · 900 字', '2025 年 · 150 字']);
  assert.equal(host.$('settings-stats-totals').textContent, '总字数 1050 字 · 写作天数 4 天 · 日均 263 字 · 覆盖 3 个月');
});

test('统计筛选：切换下拉带 filter 重新取数、汇总行跟着变、CSV 文本被清掉', async () => {
  installDocument();
  const unfiltered = { todayChars: 10, goal: 0, goalPercent: 0, goalMet: false, days: [], recentTotal: 10, todaySeconds: 0 };
  unfiltered.aggregate = aggregateFixture();
  const filtered = {
    ...unfiltered,
    aggregate: {
      ...aggregateFixture(),
      filter: { bookId: 'b1', year: 2026 },
      totals: { totalChars: 600, writtenDays: 2, averageChars: 300 },
      days: [{ day: '2026-01-01', chars: 200 }, { day: '2026-02-10', chars: 400 }],
      months: [
        { month: '2026-01', chars: 200, writtenDays: 1 },
        { month: '2026-02', chars: 400, writtenDays: 1 }
      ]
    }
  };
  const { host, state, calls } = makeHost({
    onCall: (channel, payload) => (channel === 'stats:get' ? (payload.bookId ? filtered : unfiltered) : undefined)
  });
  state.books = [{ id: 'b1', title: '书甲' }, { id: 'b2', title: '书乙' }];
  const ui = statsUi.create(host);
  await ui.refreshStats();
  host.$('stats-csv-text').value = '上一份 CSV';
  host.$('stats-csv-text').classList.remove('hidden');

  await ui.applyStatsFilter('b1', 2026);
  assert.deepEqual(calls[1], { channel: 'stats:get', payload: { bookId: 'b1', year: 2026 } });
  assert.equal(host.$('settings-stats-totals').textContent, '总字数 600 字 · 写作天数 2 天 · 日均 300 字 · 覆盖 2 个月');
  assert.equal(host.$('stats-filter-book').value, 'b1');
  assert.equal(host.$('stats-filter-year').value, '2026');
  assert.equal(host.$('stats-csv-text').value, '', '换筛选后旧 CSV 不能留着冒充新数据');
  assert.equal(host.$('stats-csv-text').classList.contains('hidden'), true);

  // 回到「全部书 / 全部年」：filter 归零，旧选项不会被重复追加
  await ui.applyStatsFilter('', 0);
  assert.deepEqual(calls[2], { channel: 'stats:get', payload: { bookId: '', year: 0 } });
  assert.equal(host.$('stats-filter-book').children.length, 3);
  assert.equal(host.$('settings-stats-totals').textContent, '总字数 1050 字 · 写作天数 4 天 · 日均 263 字 · 覆盖 3 个月');
});

test('统计 CSV：按当前汇总生成文本（BOM / 表头 / 合计），空数据给一句提示不生成空文件', async () => {
  installDocument();
  const payload = { todayChars: 0, goal: 0, goalPercent: 0, goalMet: false, days: [], recentTotal: 0, todaySeconds: 0 };
  payload.aggregate = aggregateFixture();
  const { host } = makeHost({ onCall: (channel) => (channel === 'stats:get' ? payload : undefined) });
  const ui = statsUi.create(host);
  await ui.refreshStats();

  const text = ui.buildStatsCsv();
  assert.equal(text.charCodeAt(0), 0xfeff);
  assert.deepEqual(text.slice(1).split('\r\n'), [
    '日期,字数',
    '2025-12-31,150',
    '2026-01-01,200',
    '2026-01-02,300',
    '2026-02-10,400',
    '合计,1050',
    ''
  ]);
  assert.equal(host.$('stats-csv-text').value, text);
  assert.equal(host.$('stats-csv-text').classList.contains('hidden'), false);
  assert.ok(host.$('stats-csv-hint').textContent.includes('全选复制'));

  // 没有记录：不留空 textarea，只把提示换成「还没有记录」
  const empty = { todayChars: 0, goal: 0, goalPercent: 0, goalMet: false, days: [], recentTotal: 0, todaySeconds: 0 };
  empty.aggregate = { ...aggregateFixture(), totals: { totalChars: 0, writtenDays: 0, averageChars: 0 }, days: [], months: [] };
  const second = makeHost({ onCall: (channel) => (channel === 'stats:get' ? empty : undefined) });
  const ui2 = statsUi.create(second.host);
  await ui2.refreshStats();
  assert.equal(ui2.buildStatsCsv(), '');
  assert.equal(second.host.$('stats-csv-text').classList.contains('hidden'), true);
  assert.ok(second.host.$('stats-csv-hint').textContent.includes('还没有'));
});

// A2-STATS-UI-01（低）：aggregate 被合法覆盖（保存回执 / 时长 flush / 采集建章只给摘要）后，
// buildStatsCsv 把「字段缺失」当「没有记录」→ 清掉作者刚生成的 CSV 并谎报无记录。
test('A2-STATS-UI-01：摘要型 payload（没有 aggregate）不清已生成的 CSV，也不谎报没有记录', async () => {
  installDocument();
  const payload = { todayChars: 0, goal: 0, goalPercent: 0, goalMet: false, days: [], recentTotal: 0, todaySeconds: 0 };
  payload.aggregate = aggregateFixture();
  const { host, state } = makeHost({ onCall: (channel) => (channel === 'stats:get' ? payload : undefined) });
  const ui = statsUi.create(host);
  await ui.refreshStats();
  const generated = ui.buildStatsCsv();
  assert.ok(generated.length > 0, '前提：先生成一份 CSV');
  // 合法覆盖：保存回执 / 时长 flush / 采集建章只给摘要，不带 aggregate
  state.stats = { todayChars: 12, goal: 0, goalPercent: 0, goalMet: false, days: [], totalChars: 0 };
  assert.equal(ui.buildStatsCsv(), '');
  assert.equal(host.$('stats-csv-text').value, generated, '字段缺失不许清掉已生成的 CSV');
  assert.match(host.$('stats-csv-hint').textContent, /还在读取/, '提示要说「汇总还在读取」，不是「没有记录」');
});

test('统计筛选：筛选值不在选项里（书被删 / 年份没记录）时仍显示它，汇总行和下拉不打架', async () => {
  installDocument();
  const payload = { todayChars: 0, goal: 0, goalPercent: 0, goalMet: false, days: [], recentTotal: 0, todaySeconds: 0 };
  payload.aggregate = {
    ...aggregateFixture(),
    filter: { bookId: 'b_gone', year: 2031 },
    totals: { totalChars: 0, writtenDays: 0, averageChars: 0 },
    days: [],
    months: []
  };
  const { host } = makeHost({ onCall: (channel) => (channel === 'stats:get' ? payload : undefined) });
  const ui = statsUi.create(host);
  await ui.applyStatsFilter('b_gone', 2031);
  assert.equal(host.$('stats-filter-book').value, 'b_gone');
  assert.equal(host.$('stats-filter-year').value, '2031');
  assert.ok(host.$('stats-filter-book').children.some((el) => el.textContent.includes('不在书架（b_gone）')));
  assert.ok(host.$('stats-filter-year').children.some((el) => el.textContent === '2031 年 · 0 字'));
  assert.equal(host.$('settings-stats-totals').textContent, '这段时间还没有记录。');
  assert.equal(ui.buildStatsCsv(), '', '没有一天记录时不生成 CSV 文本');
  assert.ok(host.$('stats-csv-hint').textContent.includes('还没有'));
});
