/* 每日字数统计 + 码字日历（v0.9 B-5 第三刀：从 renderer.js 的两个相邻分区整段搬出来）。
 *
 * 搬走的两段：原 renderer.js「每日字数统计（提案 3.2）」3609–3715 行（107 行）+
 * 「码字日历 / 连续写作天数 / 月度汇总（v0.8-1，提案 N1）」3717–3720 + 3725–3817 行
 * （97 行），合计 205 行。只碰渲染层：书架头 / 状态栏的今日字数与目标、设置里的近 30 天
 * 柱状图、码字日历的月视图（格子 / 翻月 / 连续天数 / 月度汇总）。**不写盘、不改正文、
 * 不碰 IPC 白名单**——统计数字由主进程从 userData/stats.json 现算，这里只显示。
 *
 * 契约：createStatsUi(host) 由渲染层调用一次，host 提供：
 *   host = {
 *     $, api, call, state, statsLogic, statsFormat, formatChars, formatDuration,
 *     writeDurationEnabled, renderDurationSettings, renderWriteTimer, calendarSummaryText,
 *     calendarCells, shiftCalendarCursor, calendarStreakLabel
 *   }
 * 缺任何一个直接抛 TypeError（宁可在启动时炸，也不要到刷新统计时才 ReferenceError）。
 * statsFormat = { formatChars, formatDuration } 是渲染层的格式化口径（与书架同一套），
 * 日历的纯逻辑（月份游标 / 格子计划 / 汇总文案）仍全在 renderer/stats-logic.js（单测覆盖）。
 *
 * 为什么 calendarSummaryText / calendarCells / shiftCalendarCursor / calendarStreakLabel
 * 走 host 回调而不是直接调 statsLogic：tests/stats-logic.test.js 的静态闸门按字面把
 * 「statsLogic.calendarCells(view, statsFormat)」等调用钉在 renderer.js（证明渲染层真的接上
 * 了纯逻辑模块）；把调用点留在渲染层、以回调注入，行为与调用时机完全不变。
 * calendarSummaryText 还多一条：测试钩子的 host 契约里还有这个名字，薄封装必须留在渲染层。
 *
 * 搬过来的东西（行为一字未改，文案 / class / 按钮文字 / 提示语都照旧）：
 *   - 今日字数 / 每日目标 / 进度条 / 连续写作天数（书架头 + 状态栏两份显示）；
 *   - 设置里的近 30 天柱状图与汇总（含写作时长那一句）；
 *   - 码字日历：月视图格子、翻月按钮边界、连续天数、月度汇总、失败提示。
 *
 * 红线不变：只读 state / 只改 DOM，**不写盘、不改正文、不改 dirty**。
 * 浏览器里挂成全局 CWStatsUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWStatsUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HOST = ['$', 'api', 'call', 'state', 'statsLogic', 'statsFormat', 'formatChars', 'formatCount', 'formatDuration', 'writeDurationEnabled', 'renderDurationSettings', 'renderWriteTimer', 'calendarSummaryText', 'calendarCells', 'shiftCalendarCursor', 'calendarStreakLabel'];

  function createStatsUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createStatsUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) {
        throw new TypeError('createStatsUi 的 host 缺少 ' + key);
      }
    }
    const {
      $, api, call, state, statsLogic, statsFormat, formatChars, formatCount, formatDuration,
      writeDurationEnabled, renderDurationSettings, renderWriteTimer, calendarSummaryText,
      calendarCells, shiftCalendarCursor, calendarStreakLabel
    } = host;
  // ---------- 每日字数统计（提案 3.2） ----------
  // 只统计「保存动作」带来的新增字数：没保存的编辑不计数，删字也不会倒扣今天。
  // 日期 / 增量都在主进程算，渲染层只负责显示；统计文件在 userData，不碰书库。
  async function refreshStats() {
    try {
      const payload = await call(api.getStats);
      state.stats = payload;
      state.streak = payload && payload.streak ? payload.streak : null;
      state.calendar = payload && payload.calendar ? payload.calendar : null;
    } catch {
      /* 统计读不到不影响写作，保留上一次显示 */
    }
    renderStatsUi();
    return state.stats;
  }

  function renderStatsUi() {
    const stats = state.stats;
    const shelf = $('shelf-stats');
    const status = $('status-stats');
    const today = Math.max(0, Math.round(Number(stats && stats.todayChars) || 0));
    const goal = Math.max(0, Math.round(Number(stats && stats.goal) || 0));
    const percent = Math.max(0, Math.min(100, Math.floor(Number(stats && stats.goalPercent) || 0)));
    const met = Boolean(stats && stats.goalMet);
    const title =
      `只统计保存动作写下的字数（不含未保存内容；删字不倒扣）。` +
      (goal > 0 ? `今日目标 ${formatCount(goal)} 字。` : '可在「设置 → 写作统计」里设每日目标。');

    if (shelf) {
      shelf.classList.toggle('hidden', !stats);
      // 空态（今天还没写字）是提示语，不是数字：换个安静的排法，别让 20px 宋体占满 72px 头部。
      // 只加显示类，文案 / 数据都不动。
      shelf.classList.toggle('is-quiet', Boolean(stats) && today <= 0);
      if (stats) {
        $('shelf-stats-today').textContent = statsLogic.statsTodayText(stats, statsFormat);
        $('shelf-stats-goal').textContent = goal > 0 ? `目标 ${formatChars(goal)} · ${percent}%${met ? ' · 已达标' : ''}` : '';
        $('shelf-stats-goal').hidden = goal <= 0;
        $('shelf-goal-track').classList.toggle('hidden', goal <= 0);
        $('shelf-goal-fill').style.width = goal > 0 ? `${percent}%` : '0%';
        const streakEl = $('shelf-stats-streak');
        const currentStreak = Math.max(0, Math.round(Number(state.streak && state.streak.current) || 0));
        const bestStreak = Math.max(0, Math.round(Number(state.streak && state.streak.best) || 0));
        if (streakEl) {
          streakEl.textContent = currentStreak > 0 ? `连续 ${currentStreak} 天` : '';
          streakEl.hidden = currentStreak <= 0;
          streakEl.title =
            currentStreak > 0 ? `已连续写作 ${currentStreak} 天 · 最长连续 ${bestStreak} 天` : '';
        }
        shelf.title = title;
      }
    }
    if (status) {
      status.classList.toggle('hidden', !stats);
      if (stats) {
        // v0.13 U-D4：状态栏这一块本身就是码字日历入口（写作页里点开全局设置 → 定位到日历）。
        // 书架头只显示统计、不能点，所以两处标题分开写：书架仍是纯说明，状态栏多一句去处。
        const statusTitle = `${title}点它打开码字日历（只读）。`;
        $('status-stats-text').textContent =
          goal > 0 ? `今日 ${formatChars(today)} / ${formatChars(goal)}` : `今日 ${formatChars(today)}`;
        $('status-goal-track').classList.toggle('hidden', goal <= 0);
        $('status-goal-fill').style.width = goal > 0 ? `${percent}%` : '0%';
        $('status-stats-text').title = statusTitle;
        status.title = statusTitle;
      }
    }
    renderStatsChart();
    renderStatsCalendar();
    renderDurationSettings();
    renderWriteTimer();
  }

  // 设置里的近 30 天柱状图：纯 CSS 高度，不引第三方库。今天那根高亮。
  function renderStatsChart() {
    const chart = $('settings-stats-chart');
    if (!chart) return;
    const stats = state.stats;
    const days = stats && Array.isArray(stats.days) ? stats.days : [];
    const goal = Math.max(0, Math.round(Number(stats && stats.goal) || 0));
    const values = days.map((item) => Math.max(0, Math.round(Number(item && item.chars) || 0)));
    const max = Math.max(goal, ...values, 1);
    chart.innerHTML = '';
    days.forEach((item, index) => {
      const value = values[index];
      const bar = document.createElement('div');
      bar.className = 'stats-bar' + (index === days.length - 1 ? ' today' : '');
      const fill = document.createElement('i');
      const height = value > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
      fill.style.height = `${Math.min(100, height)}%`;
      bar.appendChild(fill);
      bar.title = `${item.day} · ${formatChars(value)}`;
      chart.appendChild(bar);
    });
    const summaryEl = $('settings-stats-summary');
    if (summaryEl) {
      const durationText =
        stats && (writeDurationEnabled() || Number(stats.todaySeconds) > 0)
          ? ` · 今日写作 ${formatDuration(stats.todaySeconds)}`
          : '';
      summaryEl.textContent = stats
        ? `今天 ${formatChars(stats.todayChars)} · 近 30 天 ${formatChars(stats.recentTotal)}` +
          (goal > 0 ? ` · 目标 ${formatChars(goal)}（${Math.min(100, Math.floor(Number(stats.goalPercent) || 0))}%）` : ' · 未设目标') +
          durationText
        : '还没有统计数据（保存一次后开始记录）';
    }
    const goalState = $('settings-goal-state');
    if (goalState) {
      const percent = Math.max(0, Math.min(100, Math.floor(Number(stats && stats.goalPercent) || 0)));
      goalState.textContent = goal > 0 ? `今天完成 ${percent}%${stats && stats.goalMet ? ' · 已达标' : ''}` : '未设目标';
    }
  }

  // ---------- 码字日历 / 连续写作天数 / 月度汇总（v0.8-1，提案 N1） ----------
  // 月视图由主进程从 stats.json 现算（只读，不另存文件）；渲染层只负责显示和翻月。
  // v0.9 B-6：月份游标、翻月边界、网格计划、汇总 / 连续天数文案都搬到 renderer/stats-logic.js，
  // 这里只剩 DOM 与 IPC。calendarSummaryText 保留薄封装是因为测试钩子的 host 契约里还有这个名字。
  async function loadStatsCalendar(year, month) {
    try {
      const data = await call(api.getStatsCalendar, { year, month });
      if (data && data.calendar) state.calendar = data.calendar;
      if (data && data.streak) state.streak = data.streak;
      renderStatsCalendar();
      return state.calendar;
    } catch (err) {
      const summaryEl = $('calendar-summary');
      if (summaryEl) summaryEl.textContent = `读取码字日历失败：${err.message}`;
      return null;
    }
  }

  // 只允许往前 / 回到本月，不翻到未来（未来月份没有码字记录，翻过去只会看到空格子）。
  // 边界判断（未来 / 1970 下限 / delta 为 0）在 stats-logic.js 的 shiftCalendarCursor 里，有单测。
  async function shiftStatsCalendar(delta) {
    const next = shiftCalendarCursor(statsLogic.calendarCursor(state.calendar), delta);
    if (!next) return false;
    return loadStatsCalendar(next.year, next.month);
  }

  async function goToCurrentCalendarMonth() {
    const now = statsLogic.currentYearMonth();
    return loadStatsCalendar(now.year, now.month);
  }

  function appendCalendarBlank(grid) {
    const blank = document.createElement('div');
    blank.className = 'cal-day empty';
    grid.appendChild(blank);
  }

  function renderStatsCalendar() {
    const grid = $('calendar-grid');
    if (!grid) return;
    const view = state.calendar;
    const weekdaysEl = $('calendar-weekdays');
    const labelEl = $('calendar-label');
    const summaryEl = $('calendar-summary');
    const streakEl = $('calendar-streak');
    const prevBtn = $('calendar-prev');
    const nextBtn = $('calendar-next');
    const todayBtn = $('calendar-today');

    if (weekdaysEl && weekdaysEl.childElementCount === 0) {
      for (const text of statsLogic.weekdayLabels(view)) {
        const cell = document.createElement('span');
        cell.textContent = text;
        weekdaysEl.appendChild(cell);
      }
    }

    if (!view) {
      if (labelEl) labelEl.textContent = '';
      grid.innerHTML = '';
      if (summaryEl) summaryEl.textContent = '还没有统计数据（保存一次后开始记录）';
      if (streakEl) streakEl.textContent = '';
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
      if (todayBtn) todayBtn.disabled = true;
      return;
    }

    if (labelEl) labelEl.textContent = view.label;
    const buttons = statsLogic.calendarButtons(view);
    if (prevBtn) prevBtn.disabled = buttons.prevDisabled;
    if (nextBtn) nextBtn.disabled = buttons.nextDisabled;
    if (todayBtn) todayBtn.disabled = buttons.todayDisabled;

    // 网格（月首空格 / 每天格子的 class + 悬停提示 + dataset / 月尾补空格）由纯逻辑算好，
    // 这里只按计划建 DOM，不再自己算空格数和 class。
    const plan = calendarCells(view);
    grid.innerHTML = '';
    for (let i = 0; i < plan.blanksBefore; i += 1) appendCalendarBlank(grid);
    for (const item of plan.cells) {
      const cell = document.createElement('div');
      cell.className = item.className;
      for (const key of statsLogic.CELL_DATASET_KEYS) cell.dataset[key] = item.dataset[key];
      const num = document.createElement('span');
      num.textContent = item.dayOfMonth;
      cell.appendChild(num);
      cell.title = item.title;
      grid.appendChild(cell);
    }
    for (let i = 0; i < plan.blanksAfter; i += 1) appendCalendarBlank(grid);

    if (summaryEl) summaryEl.textContent = calendarSummaryText(view);
    if (streakEl) {
      streakEl.textContent = calendarStreakLabel();
      streakEl.classList.toggle('off', !(state.streak && state.streak.current > 0));
    }
  }
    return {
      refreshStats,
      renderStatsUi,
      renderStatsChart,
      loadStatsCalendar,
      shiftStatsCalendar,
      goToCurrentCalendarMonth,
      renderStatsCalendar
    };
  }

  return { create: createStatsUi, REQUIRED_HOST };
});
