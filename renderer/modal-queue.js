/* 通用询问框的单实例排队（v1.8.0 WP-13 / 审计 C11）——纯状态机，不碰 DOM、不依赖 Electron。
 *
 * 以前 renderer.js 的 openModal 直接覆盖 state.modal：外部修改检测（statusbar-ui.js 的 focus
 * 监听）在 await statChapter 期间撞上「未保存询问」时，新弹框把旧弹框的 resolve 实体覆盖掉，
 * 旧 Promise 永远不 resolve —— 切章 / 关窗流程就此永久挂起（作者只看到界面没反应）。
 * 串行化的口径：**同一时刻只画一个框，后来的排队**。每个 open() 返回的 Promise 一定会有结果：
 *   · 当前框被点掉（show 回调的 close(result)）→ 它自己的 Promise resolve，队首立刻顶上；
 *   · 重复 close / 没有当前框时 close 都是空操作，不会误结束下一框；
 *   · resolve 安排在「下一框已经画好」之后（Promise 续体是微任务），作者连点两下也不会让
 *     第一段续体插到第二框前面去。
 * 渲染层只提供两个回调：show(opts, close) 负责画，hide() 负责收（DOM / state.modal 都在那边）。
 *
 * 浏览器挂 window.CWModalQueue（index.html 排在 renderer.js 之前），Node 里可 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWModalQueue = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // handlers = { show(opts, close), hide() }：缺任何一个直接抛 TypeError（宁可在装配时炸）。
  function createModalQueue(handlers) {
    if (!handlers || typeof handlers !== 'object') throw new TypeError('createModalQueue 需要 handlers 对象');
    const { show, hide } = handlers;
    if (typeof show !== 'function') throw new TypeError('createModalQueue 的 handlers 缺少 show');
    if (typeof hide !== 'function') throw new TypeError('createModalQueue 的 handlers 缺少 hide');

    const queue = [];
    let current = null;

    function present(entry) {
      current = entry;
      show(entry.opts, (result) => settle(entry, result));
    }

    function settle(entry, result) {
      // 过期回调（已经在别处结算过 / 被新一框顶掉）一律忽略，绝不二次 resolve。
      if (!entry || entry !== current) return null;
      current = null;
      hide();
      entry.resolve(result || { action: null });
      const next = queue.shift();
      if (next) present(next);
      return entry.opts;
    }

    function open(opts) {
      const options = opts && typeof opts === 'object' ? opts : {};
      return new Promise((resolve) => {
        const entry = { opts: options, resolve };
        if (current) queue.push(entry);
        else present(entry);
      });
    }

    function close(result) {
      return settle(current, result);
    }

    return {
      open,
      close,
      isOpen: () => current !== null,
      pendingCount: () => queue.length + (current ? 1 : 0)
    };
  }

  return { create: createModalQueue };
});