const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const statsUi = require('../renderer/stats-ui');
const statsLogic = require('../renderer/stats-logic');
const editorLogic = require('../renderer/editor-logic');
const commonLib = require('../core/common');
const { loadSourceGate, restoreGlobalsAfter } = require('./ui-test-preambles');

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

function makeEl(id) {
  const classes = new Set();
  const el = {
    id,
    tagName: '',
    className: '',
    textContent: '',
    title: '',
    value: '',
    hidden: false,
    disabled: false,
    dataset: {},
    style: {},
    children: [],
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      toggle(name, on) {
        const next = on === undefined ? !classes.has(name) : Boolean(on);
        if (next) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name)
    },
    appendChild(child) { this.children.push(child); return child; },
    _classes: classes
  };
  Object.defineProperty(el, 'childElementCount', { get() { return this.children.length; } });
  // 代码里靠 `list.innerHTML = ''` 清列表；假 DOM 也要真的清，否则第二次渲染会数错行
  let innerHTML = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return innerHTML; },
    set(value) {
      innerHTML = value;
      if (value === '') el.children = [];
    },
    enumerable: true
  });
  return el;
}

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
    calendarStreakLabel: () => statsLogic.calendarStreakLabel(state.streak)
  };
  return { host, state, els, calls, renders };
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

test('host 契约：16 个成员缺任何一个都抛 TypeError，空 host / null 也抛', () => {
  const { host } = makeHost();
  assert.deepEqual([...statsUi.REQUIRED_HOST].sort(), [
    '$', 'api', 'call', 'calendarCells', 'calendarStreakLabel', 'calendarSummaryText',
    'formatChars', 'formatCount', 'formatDuration', 'renderDurationSettings', 'renderWriteTimer',
    'shiftCalendarCursor', 'state', 'statsFormat', 'statsLogic', 'writeDurationEnabled'
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

test('create() 只建表：没有 document 也能创建，10 个成员都在', () => {
  const { host } = makeHost();
  delete globalThis.document;
  const ui = statsUi.create(host);
  assert.deepEqual(Object.keys(ui).sort(), [
    'applyStatsFilter', 'buildStatsCsv', 'goToCurrentCalendarMonth', 'loadStatsCalendar',
    'refreshStats', 'renderStatsCalendar', 'renderStatsChart', 'renderStatsUi',
    'setupStatsUi', 'shiftStatsCalendar'
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
  assert.equal(host.$('shelf-stats-goal').hidden, false);
  assert.equal(host.$('shelf-goal-track').classList.contains('hidden'), false);
  assert.equal(host.$('shelf-goal-fill').style.width, '100%');
  assert.equal(host.$('shelf-stats-streak').textContent, '连续 3 天');
  assert.equal(host.$('shelf-stats-streak').hidden, false);
  assert.equal(host.$('shelf-stats-streak').title, '已连续写作 3 天 · 最长连续 5 天');
  assert.equal(host.$('shelf-stats').title, '只统计保存动作写下的字数（不含未保存内容；删字不倒扣）。今日目标 2,000 字。');
  assert.equal(host.$('status-stats-text').textContent, '今日 2500 字 / 2000 字');
  assert.equal(host.$('status-stats-text').title, '只统计保存动作写下的字数（不含未保存内容；删字不倒扣）。今日目标 2,000 字。点它打开码字日历（只读）。');
  assert.equal(host.$('status-stats').title, '只统计保存动作写下的字数（不含未保存内容；删字不倒扣）。今日目标 2,000 字。点它打开码字日历（只读）。');
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
  assert.equal(host.$('shelf-stats-goal').hidden, true);
  assert.equal(host.$('shelf-goal-track').classList.contains('hidden'), true);
  assert.equal(host.$('shelf-goal-fill').style.width, '0%');
  assert.equal(host.$('shelf-stats-streak').textContent, '');
  assert.equal(host.$('shelf-stats-streak').hidden, true);
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

test('静态闸门：renderer.js 不再内嵌两份实现，只剩接线 + 薄封装', () => {
  for (const name of ['refreshStats', 'renderStatsUi', 'renderStatsChart', 'loadStatsCalendar',
    'shiftStatsCalendar', 'goToCurrentCalendarMonth', 'appendCalendarBlank', 'renderStatsCalendar']) {
    assert.equal(
      new RegExp('^  (?:async )?function ' + name + '\\b', 'm').test(rendererSrc),
      false,
      'renderer.js 里又有 ' + name + ' 的第二份实现（该在 stats-ui.js）'
    );
  }
  // 接线：模块只 create 一次，16 个 host 成员都传进去
  assert.match(rendererSrc, /const statsUi = statsUiModule\.create\(\{/);
  for (const key of ['$', 'api', 'call', 'state', 'statsLogic', 'statsFormat', 'formatChars', 'formatCount',
    'formatDuration', 'writeDurationEnabled', 'renderDurationSettings', 'renderWriteTimer',
    'calendarSummaryText', 'calendarCells', 'shiftCalendarCursor', 'calendarStreakLabel']) {
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
  assert.ok(indexSrc.indexOf('src="stats-logic.js"') < moduleIdx, '排在 stats-logic.js 之后');
  assert.equal(/\brequire\s*\(/.test(moduleCode), false, 'stats-ui.js 不许 require');
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
  host.$('stats-csv-text').hidden = false;

  await ui.applyStatsFilter('b1', 2026);
  assert.deepEqual(calls[1], { channel: 'stats:get', payload: { bookId: 'b1', year: 2026 } });
  assert.equal(host.$('settings-stats-totals').textContent, '总字数 600 字 · 写作天数 2 天 · 日均 300 字 · 覆盖 2 个月');
  assert.equal(host.$('stats-filter-book').value, 'b1');
  assert.equal(host.$('stats-filter-year').value, '2026');
  assert.equal(host.$('stats-csv-text').value, '', '换筛选后旧 CSV 不能留着冒充新数据');
  assert.equal(host.$('stats-csv-text').hidden, true);

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
  assert.equal(host.$('stats-csv-text').hidden, false);
  assert.ok(host.$('stats-csv-hint').textContent.includes('全选复制'));

  // 没有记录：不留空 textarea，只把提示换成「还没有记录」
  const empty = { todayChars: 0, goal: 0, goalPercent: 0, goalMet: false, days: [], recentTotal: 0, todaySeconds: 0 };
  empty.aggregate = { ...aggregateFixture(), totals: { totalChars: 0, writtenDays: 0, averageChars: 0 }, days: [], months: [] };
  const second = makeHost({ onCall: (channel) => (channel === 'stats:get' ? empty : undefined) });
  const ui2 = statsUi.create(second.host);
  await ui2.refreshStats();
  assert.equal(ui2.buildStatsCsv(), '');
  assert.equal(second.host.$('stats-csv-text').hidden, true);
  assert.ok(second.host.$('stats-csv-hint').textContent.includes('还没有'));
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
