'use strict';
// bench-driver / contrast-driver 共用的驱动前置步骤（TOOL-B05 的「同类外壳重复」部分）。
//
// 两个驱动的 run(host) 都做同一件事：取窗口 → 没显示就 show → 抢焦点 → 等渲染层测试钩子
// 就绪（同一个表达式、同一个 20000ms 超时写死两份）。任一参数改动漏改另一份，两个自检
// 就会在慢机上表现不一致。这里只保留一份；驱动自己的场景 / 结果上报仍各写各的。
//
// 边界：不 require electron（窗口对象由 host 传入），不进安装包。
async function prepareWindow(host, label) {
  const win = host && typeof host.getWin === 'function' ? host.getWin() : null;
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) {
    throw new Error(`${label || '自动化'}模式没有可用窗口`);
  }
  if (typeof win.isVisible === 'function' && !win.isVisible()) win.show();
  if (typeof win.focus === 'function') win.focus();
  return win;
}

// 等渲染层测试钩子 / 首帧就绪（倒计时式轮询，超时抛错）。
async function waitForAppReady(win, timeoutMs = 20000) {
  const { waitForRenderer } = require('./screenshot-driver');
  await waitForRenderer(win, 'Boolean(window.__cwTest && window.__cwTest.ready)', timeoutMs);
}

module.exports = { prepareWindow, waitForAppReady };
