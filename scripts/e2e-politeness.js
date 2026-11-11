// 章回 · E2E 礼貌化（1.6.0 A6）
//
// E2E 跑 2 分钟左右，之前有两处对用户不太礼貌：
//   1. 剪贴板探针把用户自己的剪贴板内容冲掉，跑完也不还原；
//   2. 为了 sendInputEvent / resize 断言，每 600 ms 把窗口抢到前台——全程都在抢。
// 现在：探针前先存原文、收尾写回；只有真的发真实键盘事件的组（69 / 70 / 71）前后才开抢焦点。
//
// 为什么单独一个文件：driver（scripts/screenshot-driver.js）和组索引（scripts/e2e/groups/index.js）
// 是同一个进程里的两个模块，需要共享「现在允不允许抢焦点」这一个开关；放这里两边都 require
// 同一份，不把状态挂在全局对象上。纯逻辑、不 require electron，单测直接 require 它。
//
// 边界：scripts/ 不进安装包（build.files 不含），这里不 require 任何产品代码。

// 只有这三组发真实键盘事件、依赖窗口焦点；组边界在 runGroups 里开关（见 groups/index.js）。
const FOCUS_STEAL_GROUPS = Object.freeze([69, 70, 71]);

function focusStealWindow(groupId) {
  return FOCUS_STEAL_GROUPS.includes(Number(groupId));
}

// 开关状态：默认关（礼貌）。runGroupWithPoliteness 在键盘组前后翻一次。
let focusStealEnabled = false;

function enableFocusSteal() {
  focusStealEnabled = true;
}

function disableFocusSteal() {
  focusStealEnabled = false;
}

function isFocusStealEnabled() {
  return focusStealEnabled;
}

// 抢焦点决策（主进程的 600 ms 轮询每拍调一次）：开关没开就一律不动；
// 已聚焦 / 窗口已销毁 / 前台是应用自己的另一个窗口都不抢（多窗口组 55 自己按焦点走）。
function shouldStealFocus({ enabled, destroyed, focused, anotherAppWindowFocused } = {}) {
  if (!enabled) return false;
  if (destroyed) return false;
  if (focused) return false;
  if (anotherAppWindowFocused) return false;
  return true;
}

// 组边界统一入口：键盘组运行期间开抢焦点，退出（含异常）立刻关掉。
async function runGroupWithPoliteness(groupId, runFn) {
  const steal = focusStealWindow(groupId);
  if (steal) enableFocusSteal();
  try {
    return await runFn();
  } finally {
    if (steal) disableFocusSteal();
  }
}

// 剪贴板恢复计划（纯函数，便于单测）：
//   - 系统剪贴板不可用（锁屏 / 无交互桌面）→ 用的是进程内替身，不碰系统剪贴板；
//   - 探针前没读到原文（读失败）→ 不知道原文，不瞎写；
//   - 其余情况把探针前的原文写回去。
function clipboardRestorePlan({ systemOk, originalText } = {}) {
  if (!systemOk) return { restore: false };
  if (typeof originalText !== 'string') return { restore: false };
  return { restore: true, text: originalText };
}

// 收尾恢复：失败只告警（E2E 已经跑完，不该因为剪贴板锁住再抛一次）。
async function restoreE2EClipboard(clipboard, info = {}) {
  const plan = clipboardRestorePlan(info);
  if (!plan.restore) return false;
  try {
    await clipboard.writeText(plan.text);
    return true;
  } catch (err) {
    console.warn(`[e2e] 系统剪贴板原文恢复失败：${String((err && err.message) || err)}`);
    return false;
  }
}

module.exports = {
  FOCUS_STEAL_GROUPS,
  focusStealWindow,
  enableFocusSteal,
  disableFocusSteal,
  isFocusStealEnabled,
  shouldStealFocus,
  runGroupWithPoliteness,
  clipboardRestorePlan,
  restoreE2EClipboard
};