/* 写作计时 / 写作时长（第 4 步 renderer 九刀·补刀 11：从 renderer.js 的「写作时长」分区整段搬出来）。
 *
 * 搬走的段（原 renderer.js 1490–1672，183 行）——状态栏秒表（v0.8-2，提案 N2，参考口袋写作 tb_stat.writeDuration）：
 *   writeDurationEnabled / writeTimerTodaySeconds / writeTimerTodaySecondsLive / writeTimerSegmentMs /
 *   writeTimerSessionMs / writeTimerSessionSeconds / writeTimerUnsentMs / renderWriteTimer /
 *   renderDurationSettings（设置 →「写作统计」里的时长状态）/ stopWriteTimerTicker / startWriteTimerTicker /
 *   startWriteTimer / flushWriteTimer（串行化上报）/ flushWriteTimerNow / pauseWriteTimer / resetWriteTimer /
 *   applyWriteTimerConfig。
 * **只搬不改行为**：语义仍是秒表（只手动开始、只记实际经过秒数、暂停 / 回书架 / 关窗就停、不读正文、
 * 不记按键、不做番茄钟）；每 30 秒上报一次、暂停 / 保存 / 关窗前先 flush、上报失败把秒数放回下次再试、
 * 关掉记录时兜底不写盘——全部一字未改。事件绑定（状态栏「写作计时」按钮）随域搬进 setupWriteTimerUi()。
 *
 * 契约：createWriteTimerUi(host) 由渲染层调用一次。host 6 个成员（1 个语义分组 + 基础 5）：
 *   host = {
 *     $, state, api, call,          // 基础 4：DOM 查询 / 共享状态（state.writeTimer、config、stats）/ IPC 白名单 / IPC 包装
 *     common: {                      // 共享格式化 / 常量
 *       formatStopwatch,             //   秒表文字 01:23
 *       formatDuration,              //   「1 分 5 秒」
 *       WRITE_TIMER_FLUSH_MS         //   每 30 秒上报一次的间隔
 *     },
 *     statsUi: { renderStatsUi }     // 统计域：上报成功后重绘状态栏统计（同一份实现）
 *   }
 * 缺任何一个（含分组内成员）直接抛 TypeError。分组在 create 时一次解构，行为等价。
 * create() 不注册事件、不建定时器；事件绑定在 setupWriteTimerUi()，由 bindEvents() 在原位置调用一次
 * （两个 setInterval 只在点「开始」后由 startWriteTimer 建，原有行为）。
 *
 * 刻意不搬（留在 renderer.js）：码字日历的三个按钮绑定（统计域）、回书架 / 保存 / 关窗流程里对
 * resetWriteTimer / flushWriteTimer 的运行时调用、设置模块里的按钮绑定、测试钩子宿主契约。
 *
 * 浏览器里挂成全局 CWWriteTimerUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWWriteTimerUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HOST = ['$', 'state', 'api', 'call', 'common', 'statsUi'];

  function createWriteTimerUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createWriteTimerUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) throw new TypeError('createWriteTimerUi 的 host 缺少 ' + key);
    }
    const { $, state, api, call, common, statsUi } = host;
    if (typeof common !== 'object') throw new TypeError('createWriteTimerUi 的 host.common 必须是对象');
    for (const key of ['formatStopwatch', 'formatDuration', 'WRITE_TIMER_FLUSH_MS']) {
      if (common[key] === undefined || common[key] === null) throw new TypeError('createWriteTimerUi 的 host.common 缺少 ' + key);
    }
    if (typeof statsUi !== 'object') throw new TypeError('createWriteTimerUi 的 host.statsUi 必须是对象');
    for (const key of ['renderStatsUi']) {
      if (statsUi[key] === undefined || statsUi[key] === null) throw new TypeError('createWriteTimerUi 的 host.statsUi 缺少 ' + key);
    }
    const { formatStopwatch, formatDuration, WRITE_TIMER_FLUSH_MS } = common;
    const { renderStatsUi } = statsUi;

  // ---------- 写作时长（v0.8-2，提案 N2，参考口袋写作 tb_stat.writeDuration） ----------
  // 默认关：设置里打开后才在状态栏出现「写作计时」按钮。
  // 语义 = 秒表：只在你手动点开始时按实际经过时间累计秒数，暂停 / 回书架 / 关窗时停；
  // 不读正文、不记按键、不做番茄钟倒计时；秒数按天存 userData/stats.json（和字数同一份）。
  function writeDurationEnabled() {
    return Boolean(state.config && state.config.writeDurationEnabled === true);
  }

  function writeTimerTodaySeconds() {
    const stats = state.stats || {};
    return Math.max(0, Math.round(Number(stats.todaySeconds) || 0));
  }

  // 只用于界面显示：已上报的今天秒数 + 还在内存里没上报的整秒
  function writeTimerTodaySecondsLive() {
    return writeTimerTodaySeconds() + Math.floor(writeTimerUnsentMs() / 1000);
  }

  function writeTimerSegmentMs() {
    const t = state.writeTimer;
    return t.running ? Math.max(0, Date.now() - t.segmentStart) : 0;
  }

  function writeTimerSessionMs() {
    return Math.max(0, state.writeTimer.sessionMs + writeTimerSegmentMs());
  }

  function writeTimerSessionSeconds() {
    return Math.floor(writeTimerSessionMs() / 1000);
  }

  function writeTimerUnsentMs() {
    return Math.max(0, state.writeTimer.unsentMs + writeTimerSegmentMs());
  }

  function renderWriteTimer() {
    const btn = $('btn-write-timer');
    if (!btn) return;
    const visible = state.view === 'editor' && Boolean(state.bookPath) && writeDurationEnabled();
    btn.classList.toggle('hidden', !visible);
    if (!visible) return;
    const t = state.writeTimer;
    const seconds = writeTimerSessionSeconds();
    const label = $('write-timer-text');
    if (label) {
      if (t.running) label.textContent = `计时 ${formatStopwatch(seconds)}`;
      else if (seconds > 0) label.textContent = `已暂停 ${formatStopwatch(seconds)}`;
      else label.textContent = '写作计时';
    }
    btn.classList.toggle('running', t.running === true);
    btn.classList.toggle('paused', !t.running && seconds > 0);
    const todayText = formatDuration(writeTimerTodaySecondsLive());
    btn.title =
      (t.running ? '正在计时：点一下暂停（只记时长，不记内容）' : '点击开始写作计时（只记时长，不记内容）') +
      `。今天已写 ${writeTimerTodaySecondsLive() > 0 ? todayText : '0 秒'}` +
      (t.running || seconds > 0 ? ` · 本次 ${formatStopwatch(seconds)}` : '');
  }

  // 设置 →「写作统计」里的时长状态（未开启 / 今天 / 近 30 天）
  // 注意：这里只更新状态文字，不回填 checkbox（否则会把用户还没保存的勾选改掉）。
  function renderDurationSettings() {
    const summary = $('settings-duration-summary');
    if (!summary) return;
    if (!writeDurationEnabled()) {
      summary.textContent = '未开启（默认关；开启后只在写作页点「写作计时」时累计，不记录任何内容）';
      summary.className = 'muted small';
      return;
    }
    const stats = state.stats || {};
    const recent = Math.max(0, Math.round(Number(stats.recentSeconds) || 0));
    const today = writeTimerTodaySecondsLive();
    summary.textContent =
      `今天写作 ${formatDuration(today)} · 近 30 天 ${formatDuration(recent)}` +
      (state.writeTimer.running ? ' · 正在计时' : '');
    summary.className = 'muted small';
  }

  function stopWriteTimerTicker() {
    const t = state.writeTimer;
    if (t.flushTimer) clearInterval(t.flushTimer);
    if (t.tickTimer) clearInterval(t.tickTimer);
    t.flushTimer = null;
    t.tickTimer = null;
  }

  function startWriteTimerTicker() {
    const t = state.writeTimer;
    stopWriteTimerTicker();
    t.flushTimer = setInterval(() => {
      void flushWriteTimer();
    }, WRITE_TIMER_FLUSH_MS);
    // 只刷新按钮上的秒表文字，不写盘、不碰正文
    t.tickTimer = setInterval(() => renderWriteTimer(), 1000);
  }

  function startWriteTimer() {
    if (!writeDurationEnabled() || state.view !== 'editor' || !state.bookPath) return false;
    const t = state.writeTimer;
    if (t.running) return true;
    t.running = true;
    t.segmentStart = Date.now();
    startWriteTimerTicker();
    renderWriteTimer();
    renderDurationSettings();
    return true;
  }

  // 上报串行化：暂停 / 保存 / 30 秒定时 可能同时触发，排队执行才不会重复扣零头
  let writeTimerQueue = Promise.resolve();

  function flushWriteTimer() {
    const run = writeTimerQueue.then(
      () => flushWriteTimerNow(),
      () => flushWriteTimerNow()
    );
    writeTimerQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function flushWriteTimerNow() {
    const t = state.writeTimer;
    if (t.running) {
      const now = Date.now();
      const delta = Math.max(0, now - t.segmentStart);
      t.segmentStart = now;
      t.sessionMs += delta;
      t.unsentMs += delta;
    }
    const seconds = Math.floor(t.unsentMs / 1000);
    // 关掉记录时不写盘：配置切换前会先 flush 一次，这里只是兜底。
    if (seconds <= 0 || !writeDurationEnabled()) {
      renderWriteTimer();
      return 0;
    }
    t.unsentMs -= seconds * 1000;
    try {
      const res = await call(api.addStatsDuration, { seconds });
      if (res && res.stats) {
        state.stats = res.stats;
        if (res.stats.streak) state.streak = res.stats.streak;
        renderStatsUi();
      }
      return (res && res.recorded) || 0;
    } catch {
      // 统计写失败不能影响写作：把秒数放回去，下次暂停 / 保存 / 定时再试
      t.unsentMs += seconds * 1000;
      return 0;
    }
  }

  async function pauseWriteTimer() {
    const t = state.writeTimer;
    await flushWriteTimer();
    t.running = false;
    t.segmentStart = 0;
    stopWriteTimerTicker();
    renderWriteTimer();
    renderDurationSettings();
    return true;
  }

  // 离开这本书 / 回书架 / 关窗：先把没上报的整秒发出去，再清空本次秒表。
  async function resetWriteTimer({ flush = true } = {}) {
    if (flush) await flushWriteTimer();
    const t = state.writeTimer;
    t.running = false;
    t.segmentStart = 0;
    t.sessionMs = 0;
    t.unsentMs = 0;
    stopWriteTimerTicker();
    renderWriteTimer();
    renderDurationSettings();
  }

  // 设置保存后调用：关掉时立刻停表并隐藏按钮；开启时按钮跟着出现。
  function applyWriteTimerConfig() {
    if (!writeDurationEnabled()) {
      void resetWriteTimer({ flush: false });
    } else {
      renderWriteTimer();
      renderDurationSettings();
    }
  }

  // 事件绑定（与搬前 bindEvents() 里的写作计时块逐行一致；由渲染层在原位置调用一次）
  function setupWriteTimerUi() {
    // 写作计时（v0.8-2）：手动开始 / 暂停；只记时长不记内容，不做番茄钟
    const writeTimerBtn = $('btn-write-timer');
    if (writeTimerBtn) {
      writeTimerBtn.addEventListener('click', () => {
        if (state.writeTimer.running) void pauseWriteTimer();
        else startWriteTimer();
      });
    }
  }


    return {
      writeDurationEnabled,
      renderWriteTimer,
      renderDurationSettings,
      startWriteTimer,
      pauseWriteTimer,
      flushWriteTimer,
      resetWriteTimer,
      applyWriteTimerConfig,
      writeTimerTodaySeconds,
      writeTimerSessionSeconds,
      writeTimerUnsentMs,
      setupWriteTimerUi
    };
  }

  return { create: createWriteTimerUi, REQUIRED_HOST };
});
