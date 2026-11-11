// 关窗看门狗阈值与「强制退出」顺序（1.6.0 A1 / 审计 E-03）——不碰 Electron，可在 Node 里直接测。
//
// 问题：关闭窗口时主进程等渲染层回执，3 秒（`setTimeout(..., 3000)`）就弹「编辑器无响应」。
// 慢盘 / 大文件保存（整本整理、导出前保存）常常 3 秒还没回；作者一看「无响应」就点强退，
// 刚写的正文直接丢。另一个毛病：点「强制退出」立刻 `destroy()`，渲染层连落盘的机会都没有。
//
// 现在的口径：
//   · 看门狗 8 秒（CLOSE_TIMEOUT_MS），文案跟着改成「已等 8 秒」；
//   · 点「强制退出」不再立刻 destroy：先 `webContents.send('app:force-close')` 通知渲染层，
//     等 FORCE_CLOSE_GRACE_MS = 500 ms 给它一次落盘 / 收尾机会，到点（窗口还在）再 destroy；
//   · 顺序写在 FORCE_CLOSE_STEPS 里，由 runForceCloseSteps() 逐条执行——执行器不自己重排，
//     单测可以「注入乱序计划 → 结果跟着乱」把顺序钉死。
//   · 窗口已经销毁时 send / destroy 一律跳过（不往死掉的 webContents 上发）。
//
// 主进程只装配：`closeGuard.timeoutPrompt()` 进 showMessageBox、`forceClosePlan()` +
// `runForceCloseSteps()` 干强制退出。真实关窗行为仍由 E2E 第 10 / 11 / 12 组覆盖。

const CLOSE_TIMEOUT_MS = 8000;
const FORCE_CLOSE_CHANNEL = 'app:force-close';
const FORCE_CLOSE_GRACE_MS = 500;
// 顺序即语义：先通知、再等、最后才 destroy。测试直接钉这个数组。
const FORCE_CLOSE_STEPS = ['send', 'wait', 'destroy'];

// 强制退出的计划：{ steps, channel, graceMs, send, wait, destroy }。
// steps 每次都返回新数组；destroyed 时 send / wait / destroy 全关（没有任何一步可做）。
function forceClosePlan(options) {
  const destroyed = Boolean(options && options.destroyed);
  return {
    steps: FORCE_CLOSE_STEPS.slice(),
    channel: FORCE_CLOSE_CHANNEL,
    graceMs: FORCE_CLOSE_GRACE_MS,
    send: !destroyed,
    wait: !destroyed,
    destroy: !destroyed
  };
}

// 逐条执行计划：send → wait(graceMs) → destroy，执行器不重排、不跳步（除非计划里标了 false，
// 或 canDestroy() 说窗口已经没了）。返回真正执行过的步骤，方便主进程 / 测试核对。
async function runForceCloseSteps(plan, handlers) {
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
  const h = handlers || {};
  const done = [];
  for (const step of steps) {
    if (step === 'send') {
      if (plan.send === false) continue;
      if (typeof h.send === 'function') h.send();
    } else if (step === 'wait') {
      if (plan.wait === false) continue;
      if (typeof h.wait === 'function') await h.wait(plan.graceMs);
    } else if (step === 'destroy') {
      if (plan.destroy === false) continue;
      if (typeof h.canDestroy === 'function' && !h.canDestroy()) continue;
      if (typeof h.destroy === 'function') h.destroy();
    } else {
      continue;
    }
    done.push(step);
  }
  return done;
}

// 8 秒没回执时给作者看的弹窗内容。文案与按钮顺序放这里，单测钉住（避免再退回「3 秒」）。
// 默认 / 取消都停在「继续等待」：多等一下通常比丢字安全。
function timeoutPrompt() {
  return {
    type: 'warning',
    title: '编辑器无响应',
    message: `保存还没有完成（已等 ${CLOSE_TIMEOUT_MS / 1000} 秒）。`,
    detail: '继续等待通常更安全；强制退出会先通知编辑器把能存的存下来，但仍可能丢失最后一点未保存的内容。',
    buttons: ['继续等待', '强制退出'],
    defaultId: 0,
    cancelId: 0
  };
}

module.exports = {
  CLOSE_TIMEOUT_MS,
  FORCE_CLOSE_CHANNEL,
  FORCE_CLOSE_GRACE_MS,
  forceClosePlan,
  runForceCloseSteps,
  timeoutPrompt
};