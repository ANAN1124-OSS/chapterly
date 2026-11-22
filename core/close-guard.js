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
// `runForceCloseSteps()` 干强制退出。真实关窗行为仍由 E2E 第 10 / 11 / 12 / 55 组覆盖。
//
// C6（WP-09）：关窗放行的交叉判定（E5/S5 + N3）抽成 closeReleaseDecision()，规则只写一份。
// 回执到达时算一次；`await saveRecentWindowBounds()` 之后必须用同一判据再算一次——写窗口位置是
// 一次真实 await，期间渲染层还能继续输入并上报 app:dirty；只按回执那一刻的结果 forceClose，
// close 事件会直接放行，把这几毫秒 ~ 几十毫秒内的新编辑一起关掉。

const CLOSE_TIMEOUT_MS = 8000;
const FORCE_CLOSE_CHANNEL = 'app:force-close';
const FORCE_CLOSE_GRACE_MS = 500;
// 旧M3（一轮·中）：关窗前写「最近窗口位置」的截止时间。configStore.get/set 内部是真写盘，
// 配置写队列被同步盘 / 杀软 / 网络 userData 挂起时可能永远不回来；8 秒看门狗在回执进门那一刻
// 就被 clearTimeout 解除了，以前会无限等、作者只能强杀进程。超时照常关窗（位置没记住是小事）。
const BOUNDS_WRITE_TIMEOUT_MS = 2500;
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

// C6（WP-09）：关窗放行的唯一判据。allowed 之外还要看主进程自己掌握的脏状态：
//   · 界面说「不脏」→ 放行；
//   · 仍脏，但主进程看到过「变脏之后（严格晚于）的一次保存成功回执」→ 放行（E5/S5 + N3）；
//   · 其余（含 allowed=false）→ 拦下。
// 只做纯计算、不碰 Electron：回执那一刻与 await 写窗口位置之后各调一次，两次用的是同一份规则。
// 返回的 code：CLOSE_OK / CLOSE_DIRTY（allowed 为真但数据没落盘）/ CLOSE_DENIED（渲染层自己说不关）。
function closeReleaseDecision(state) {
  const source = state || {};
  const allowed = Boolean(source.allowed);
  const dirty = Boolean(source.dirty);
  const lastSaveAt = Number(source.lastSaveAt) || 0;
  const dirtyAt = Number(source.dirtyAt) || 0;
  // N3：回执必须严格晚于这次变脏的上升沿；同毫秒时宁可多拦一次。
  const savedAfterDirty = lastSaveAt > 0 && lastSaveAt > dirtyAt;
  const okToClose = allowed && (!dirty || savedAfterDirty);
  let code = 'CLOSE_DENIED';
  if (okToClose) code = 'CLOSE_OK';
  else if (allowed) code = 'CLOSE_DIRTY';
  return { allowed, dirty, savedAfterDirty, okToClose, code };
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

// 旧M3（一轮·中）：给一段异步工作加截止时间。先完成 → { timedOut:false, value }；到点 →
// { timedOut:true }。工作本身**不取消**（配置写盘让它继续在后台做完更好，只是不再压着关窗）。
// 计时器用完即清（失败 / 超时两条路都清），不会给退出流程留悬挂句柄。
// 纯逻辑：计时器可注入，单测直接跑，不需要真的等 2.5 秒。
async function withDeadline(task, options = {}) {
  const raw = Number(options && options.ms);
  const ms = Number.isFinite(raw) && raw > 0 ? raw : BOUNDS_WRITE_TIMEOUT_MS;
  const setTimer = typeof (options && options.setTimeoutFn) === 'function' ? options.setTimeoutFn : setTimeout;
  const clearTimer =
    typeof (options && options.clearTimeoutFn) === 'function' ? options.clearTimeoutFn : clearTimeout;
  let handle = null;
  const deadline = new Promise((resolve) => {
    handle = setTimer(() => resolve({ timedOut: true, value: undefined }), ms);
    if (handle && typeof handle.unref === 'function') handle.unref();
  });
  const work = Promise.resolve()
    .then(() => (typeof task === 'function' ? task() : task))
    .then(
      (value) => ({ timedOut: false, value }),
      (error) => ({ timedOut: false, value: undefined, error })
    );
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (handle) clearTimer(handle);
  }
}

module.exports = {
  CLOSE_TIMEOUT_MS,
  BOUNDS_WRITE_TIMEOUT_MS,
  FORCE_CLOSE_CHANNEL,
  FORCE_CLOSE_GRACE_MS,
  forceClosePlan,
  runForceCloseSteps,
  closeReleaseDecision,
  withDeadline,
  timeoutPrompt
};