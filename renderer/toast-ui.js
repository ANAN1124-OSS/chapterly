/* 提示条出口（toast / 可点提示）——M1（第一轮·低）拆分第一刀：从 renderer.js 整段搬出。
 *
 * 为什么单独一个模块：toast 是应用里唯一的「短暂提示」出口（保存失败 / 读取失败 / 章节太长 /
 * 撤销条 / 剪贴板联动……），以前它长在 4,600 行的 renderer.js 里，只有 E2E 打字才能看到
 * 「8 秒自消失」「点按钮先关再回调」这些行为。搬出来以后用假 DOM + 假定时器逐条钉住，
 * renderer.js 只保留同名转发（40 个调用点一个字不改）。
 *
 * 契约：createToastUi(host) 只调用一次；host = { $, state, document }。
 *   · $ / state 是渲染层同一份引用（state 只读 testMode / toastLog 两个字段）；
 *   · document 用来建条目（浏览器里就是全局 document；单测注入假 DOM）。
 *   缺任何一个直接抛 TypeError（宁可在启动时炸，也不要等到第一次要提示时 ReferenceError）。
 *
 * 行为（与搬出前逐字一致）：
 *   1. toast(message, kind)：往 #toast-area 追加一条 <div class="toast [warn|error]">；
 *      3600ms 后加 .leaving 淡出，再过 300ms 移除。文案用 textContent 写（读屏 live region 靠它播报）。
 *   2. toastActionable(message, actionLabel, onAction, options)：多一个动作按钮（撤销条 / 捕获）；
 *      默认 8000ms 后自消失（钳在 1000–30000）；点按钮 = 先关提示再执行回调，回调抛错只记
 *      console.error，绝不让撤销条的动作把主流程带崩。
 *   3. ?test=1 时把 { message, kind, actionable? } 记进 state.toastLog（上限 60 条）——
 *      E2E 的「保存提示先出、缺章警告后到」靠它；生产里这段整体不执行，数组不增长。
 *
 * 浏览器里挂成全局 CWToastUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../core/assert-host').assertHost);
  } else if (root) {
    root.CWToastUi = factory(root.CWAssertHost && root.CWAssertHost.assertHost);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (assertHost) {
  'use strict';

  const REQUIRED_HOST = ['$', 'state', 'document'];
  // 3600ms 后淡出、300ms 后移除：与 styles.css 的 .toast.leaving（0.16s）和全界面动效同一档。
  const TOAST_TTL_MS = 3600;
  const TOAST_LEAVE_MS = 300;
  // ?test=1 的记录上限：E2E 只读最近几条（提示先出 / 缺章警告后到），不能无限增长。
  const TOAST_LOG_LIMIT = 60;
  // 可点提示的存活时长：默认 8s（够读完一句话再点），钳在 1–30s。
  const ACTIONABLE_DEFAULT_MS = 8000;
  const ACTIONABLE_MIN_MS = 1000;
  const ACTIONABLE_MAX_MS = 30000;

  function createToastUi(host) {
    assertHost('createToastUi', host, REQUIRED_HOST);
    const { $, state, document } = host;

    // 只有 ?test=1 才记（生产里 state.toastLog 一直是空数组，不增长）。
    function log(message, kind, actionable) {
      if (!state.testMode) return;
      const entry = { message: String(message), kind };
      if (actionable) entry.actionable = true;
      state.toastLog.push(entry);
      if (state.toastLog.length > TOAST_LOG_LIMIT) state.toastLog.shift();
    }

    // 条目 class 的唯一拼法：`toast [actionable] [warn|error]`（CSS / E2E 选择器按这个口径）。
    function kindClass(base, kind) {
      const tone = kind === 'warn' ? 'warn' : kind === 'error' ? 'error' : '';
      return tone ? base + ' ' + tone : base;
    }

    // 普通提示：只自动消失，没有动作。
    function toast(message, kind = 'info') {
      const area = $('toast-area');
      const el = document.createElement('div');
      el.className = kindClass('toast', kind);
      el.textContent = message;
      area.appendChild(el);
      log(message, kind, false);
      setTimeout(() => {
        // 淡出（0.16s，与全界面动效同一档）与透明度都在 styles.css 的 .toast.leaving 里：
        // 以前这里写死 .25s 的内联过渡，比别的动效慢一拍；内联简写里也不能写 var()（CSSOM 会丢）。
        el.classList.add('leaving');
        setTimeout(() => el.remove(), TOAST_LEAVE_MS);
      }, TOAST_TTL_MS);
    }

    // b8（剪贴板联动）：可点提示——普通 toast 只自动消失，这条带一个动作按钮，作者点了才执行。
    // 提示里只出现派生信息（字数），绝不含剪贴板正文（隐私红线：不落盘 / 不写日志 / 不做历史）。
    function toastActionable(message, actionLabel, onAction, options = {}) {
      const kind = options.kind || 'info';
      const durationMs = Number.isFinite(Number(options.durationMs))
        ? Number(options.durationMs)
        : ACTIONABLE_DEFAULT_MS;
      const area = $('toast-area');
      const el = document.createElement('div');
      el.className = kindClass('toast actionable', kind);
      const text = document.createElement('span');
      text.className = 'toast-text';
      text.textContent = message;
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'toast-action';
      action.textContent = actionLabel;
      el.appendChild(text);
      el.appendChild(action);
      area.appendChild(el);
      log(message, kind, true);
      let closed = false;
      let timer = null;
      const dismiss = () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        el.classList.add('leaving');
        setTimeout(() => el.remove(), TOAST_LEAVE_MS);
      };
      action.addEventListener('click', () => {
        dismiss();
        try {
          onAction();
        } catch (err) {
          console.error('剪贴板提示的动作失败', err);
        }
      });
      timer = setTimeout(dismiss, Math.max(ACTIONABLE_MIN_MS, Math.min(durationMs, ACTIONABLE_MAX_MS)));
    }

    return { toast, toastActionable };
  }

  return {
    create: createToastUi,
    REQUIRED_HOST,
    TOAST_TTL_MS,
    TOAST_LEAVE_MS,
    TOAST_LOG_LIMIT,
    ACTIONABLE_DEFAULT_MS,
    ACTIONABLE_MIN_MS,
    ACTIONABLE_MAX_MS
  };
});
