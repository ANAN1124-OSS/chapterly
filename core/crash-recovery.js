// WP5（N1 / 中 #6）：渲染进程崩溃 / 窗口无响应的纯决策。
//
// 背景（审计 N1）：v1.8.1 的 main.js 对 render-process-gone / unresponsive 只写一行日志，
// 渲染进程一崩窗口就白屏、未保存正文丢自上次 Ctrl+S；假死时作者也没有任何出口。
//
// 这一层只做「怎么处置」的纯判定，便于单测：
//   · 首次崩溃 / 距上次重载超过保护窗 → 自动 reload（页面自己恢复）；
//   · 保护窗内再次崩溃 → 交给对话框出口（避免 reload 成环）；
//   · clean-exit / 正在退出 → 什么都不做（关窗 / 退出不许误重载）；
//   · 假死 → 「继续等待 / 强制重载」；reload 失败 → 「打开日志文件夹 / 关闭这个窗口」。
//
// 文案只含固定说明，绝不带本机路径 / 正文；main.js 只负责 showMessageBox + 按 actions 执行。
const RELOAD_GUARD_MS = 60 * 1000;
const CLEAN_REASONS = new Set(['clean-exit']);

function normalizedReason(reason) {
  const text = typeof reason === 'string' ? reason.trim() : '';
  return text || 'unknown';
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanText(value) {
  const text = typeof value === 'string' ? value : '';
  return Array.from(text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim())
    .slice(0, 300)
    .join('');
}

// 崩溃处置计划。返回的 nextLastReloadAtMs / nextReloadCount 由调用方写回自己的崩溃状态。
function decideRenderCrash(input = {}) {
  const reason = normalizedReason(input.reason);
  if (input.quitting === true) return { action: 'none', reason: 'quitting' };
  if (CLEAN_REASONS.has(reason)) return { action: 'none', reason: 'clean' };
  const nowMs = finiteNumber(input.nowMs, Date.now());
  const lastReloadAtMs = Math.max(0, finiteNumber(input.lastReloadAtMs, 0));
  const reloadCount = Math.max(0, Math.round(finiteNumber(input.reloadCount, 0)));
  if (!lastReloadAtMs || nowMs - lastReloadAtMs > RELOAD_GUARD_MS) {
    return { action: 'reload', reason: 'first-crash', nextLastReloadAtMs: nowMs, nextReloadCount: 1 };
  }
  return { action: 'ask', reason: 'reload-loop', nextLastReloadAtMs: lastReloadAtMs, nextReloadCount: reloadCount + 1 };
}

// 保护窗内再次崩溃：不再自动重载，给「重载界面 / 打开日志文件夹 / 关闭这个窗口」三个出口。
function renderCrashDialog(options = {}) {
  const reason = normalizedReason(options.reason);
  return {
    type: 'error',
    title: '界面崩溃了',
    message:
      `界面进程意外退出（${reason}），刚才未保存的内容可能已经丢了。\n\n` +
      '可以重载界面继续写；诊断日志里记了这次崩溃的原因（不含正文）。',
    buttons: ['打开日志文件夹', '关闭这个窗口', '重载界面'],
    actions: ['logs', 'close', 'reload'],
    defaultId: 2,
    cancelId: 1,
    noLink: true
  };
}

// 窗口假死：默认「继续等待」（不做任何动作），作者明确点了才强制重载。
function unresponsivePlan() {
  return {
    type: 'warning',
    title: '窗口无响应',
    message:
      '界面暂时没有响应（可能正在处理很大的操作）。\n\n' +
      '可以继续等待它恢复；正文只在你按保存时写盘，继续等待期间不会有额外写盘。',
    buttons: ['继续等待', '强制重载'],
    actions: ['wait', 'reload'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  };
}

// reload 自己失败（页面没加载出来）：不再重试，给「打开日志文件夹 / 关闭这个窗口」出口。
function reloadFailureDialog(options = {}) {
  const detail = cleanText(options.message) || '页面没有重新加载出来';
  return {
    type: 'error',
    title: '界面重载失败',
    message: `界面没有重新加载出来：${detail}\n\n可打开诊断日志排查，或关闭这个窗口后重开应用。`,
    buttons: ['打开日志文件夹', '关闭这个窗口'],
    actions: ['logs', 'close'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  };
}

module.exports = {
  RELOAD_GUARD_MS,
  decideRenderCrash,
  renderCrashDialog,
  unresponsivePlan,
  reloadFailureDialog
};