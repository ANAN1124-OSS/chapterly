/* 撤销层纯逻辑（1.4.0 P0-2：撤销优先，确认弹层只留两处）。
 *
 * 为什么单独一个模块：删除章节从「弹确认框」改成「直接执行 + 10 秒内撤销」以后，
 * 三件必须可单测的事不能再塞进 renderer.js ——
 *   1. 单槽撤销（只留最近一条，新动作覆盖旧的；10 秒后失效）；
 *   2. Ctrl+Z 的键位判定（Ctrl + Z，不带 Shift / Alt / Meta）；
 *   3. 焦点保护（在输入框 / 下拉框 / 编辑区 / contenteditable 里按 Ctrl+Z 必须还是
 *      「文本撤销」，不能被全局撤销条抢走）。
 *
 * 契约：本模块不碰 DOM、不碰 IPC、不读配置，只做上面三件事。
 *   createUndoSlot({ ttlMs, now }) 返回 { push, peek, take, clear, expire, hasPending, remainingMs, ttlMs }
 *     - push({ label, run, bookPath })：登记一条撤销动作；run 必须是函数（返回值随意）。
 *     - peek()：还活着就返回当前条目（过期即清空并返回 null）。
 *     - take()：取走并清空（执行成功由调用方再 clear，失败可保留到 TTL 到期重试）。
 *     - expire()：只清「已过期」的那条，返回是否清掉了。
 *     - remainingMs()：距离过期还剩多少毫秒（0 = 没有 / 已过期）。
 *   isUndoKey(event, typing)：键位是 Ctrl+Z 且焦点不在输入类目标上。
 *   isTypingTarget(element)：input / select / textarea / contenteditable。
 *
 * 浏览器里挂成全局 CWUndoAction（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWUndoAction = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 撤销条停留时长（与 renderer/undo-ui.js 的淡出定时器、验收清单文案同一组数字）。
  const TTL_MS = 10000;
  const DEFAULT_LABEL = '上次操作';

  // 焦点保护：这些目标里的 Ctrl+Z 属于「文本撤销」，全局撤销条一律不抢。
  // 编辑区（#editor）本身就是 textarea，所以不必再单独判断；contenteditable 一并算输入类。
  function isTypingTarget(target) {
    if (!target) return false;
    const tag = String(target.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
    if (target.isContentEditable === true) return true;
    if (typeof target.getAttribute === 'function') {
      const attr = target.getAttribute('contenteditable');
      if (attr !== null && String(attr).toLowerCase() !== 'false') return true;
    }
    return false;
  }

  // Ctrl+Z（不带 Shift / Alt / Meta）；typing = 当前焦点是否在输入类目标上。
  function isUndoKey(event, typing) {
    if (!event) return false;
    if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return false;
    if (String(event.key || '').toLowerCase() !== 'z') return false;
    return !typing;
  }

  function createUndoSlot(options) {
    const opts = options || {};
    const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? Math.floor(opts.ttlMs) : TTL_MS;
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    let entry = null;
    let seq = 0;

    function isExpired(item) {
      return !item || now() - item.at >= ttlMs;
    }

    function push(action) {
      if (!action || typeof action !== 'object') throw new TypeError('undo.push 需要 { label, run }');
      if (typeof action.run !== 'function') throw new TypeError('undo.push 的 run 必须是函数');
      seq += 1;
      entry = {
        id: seq,
        label: action.label == null || action.label === '' ? DEFAULT_LABEL : String(action.label),
        bookPath: typeof action.bookPath === 'string' ? action.bookPath : '',
        run: action.run,
        at: now()
      };
      return entry;
    }

    function peek() {
      if (!entry) return null;
      if (isExpired(entry)) {
        entry = null;
        return null;
      }
      return entry;
    }

    function take() {
      const current = peek();
      entry = null;
      return current;
    }

    function clear() {
      entry = null;
    }

    function expire() {
      if (!entry) return false;
      if (!isExpired(entry)) return false;
      entry = null;
      return true;
    }

    function hasPending() {
      return Boolean(peek());
    }

    function remainingMs() {
      const current = peek();
      if (!current) return 0;
      return Math.max(0, ttlMs - (now() - current.at));
    }

    return { push, peek, take, clear, expire, hasPending, remainingMs, ttlMs };
  }

  return { TTL_MS, DEFAULT_LABEL, createUndoSlot, isUndoKey, isTypingTarget };
});
