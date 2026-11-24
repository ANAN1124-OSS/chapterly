'use strict';
// 开发自检驱动的公共骨架（审计修复 #53 / R7）。
//
// 背景：bench / contrast / screenshot / a11y 四个驱动各自实现了「等页面表达式就绪」的轮询
//（screenshot-driver 的 waitForRenderer、a11y-gate 的 waitTarget / waitEval，bench 与 contrast
// 后来改成复用 waitForRenderer）。同一件事四份实现，超时文案 / 轮询间隔 / 异常吞掉的口径各不相同，
// 门禁行为不可预期一致。这里只收两件事：
//   · pollUntil：带截止时间的保守轮询 —— 每次试探抛错都当作「页面还没好」继续等（页面切换间隙），
//     超时才抛错；轮询间隔 / 超时文案由调用方给（各驱动的既有文案逐字保留）。
//   · execInRenderer：统一「往渲染进程注入一段脚本」的调用形态（executeJavaScript + userGesture）。
//
// 约束：只 require core/common.js 的 sleep（纯逻辑，不碰 Electron），本文件可脱离主进程单独 require；
// 不在本文件里做任何业务判定。
const { sleep } = require('../core/common');

// 轮询直到 probe() 返回真值；超时抛 Error。
// options：
//   timeout  毫秒，默认 12000
//   interval 两次试探之间的等待，默认 120
//   label    超时文案里的条件描述（默认「条件」）
//   timeoutMessage 完整的超时文案（字符串，或返回字符串的函数 —— 供「超时现场」现取）
//   beforeProbe 每轮试探前调用；可以抛错（例如「窗口已销毁」这类必须立刻中止的等待）。
async function pollUntil(probe, options = {}) {
  const settings = options && typeof options === 'object' ? options : {};
  const timeout = Number.isFinite(Number(settings.timeout)) ? Number(settings.timeout) : 12000;
  const interval = Number.isFinite(Number(settings.interval)) ? Math.max(0, Number(settings.interval)) : 120;
  const label = settings.label == null ? '条件' : String(settings.label);
  // sleep 可注入（E2E harness 的等待在单测里是假的，不能换成真睡眠）。
  const sleepImpl = typeof settings.sleep === 'function' ? settings.sleep : sleep;
  const deadline = Date.now() + Math.max(0, timeout);
  for (;;) {
    // CI-F7：有的等待必须能立刻中止（E2E 窗口已销毁时继续轮询只是白等满 timeout）。
    // beforeProbe 的异常不当作「页面还没好」吞掉，直接穿出去。
    if (typeof settings.beforeProbe === 'function') await settings.beforeProbe();
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      /* 页面还没加载完 / 正在切换：继续等 */
    }
    if (Date.now() > deadline) {
      if (typeof settings.timeoutMessage === 'function') {
        throw new Error(String(await settings.timeoutMessage()));
      }
      if (settings.timeoutMessage) throw new Error(String(settings.timeoutMessage));
      throw new Error(`等待超时：${label}`);
    }
    await sleepImpl(interval);
  }
}

// 往渲染进程注入脚本：默认 userGesture=true（与既有驱动逐字一致）。
function execInRenderer(win, code, userGesture = true) {
  return win.webContents.executeJavaScript(code, userGesture);
}

module.exports = { pollUntil, execInRenderer };
