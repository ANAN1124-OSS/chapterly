/* 撤销层纯逻辑（1.4.0 P0-2：撤销优先，确认弹层只留两处；1.5.0 P0-4：单槽改小栈）。
 *
 * 为什么单独一个模块：删除章节从「弹确认框」改成「直接执行 + 10 秒内撤销」以后，
 * 三件必须可单测的事不能再塞进 renderer.js ——
 *   1. 小栈撤销（深度 3：最近三条各留一条退路，新动作压在最上面；每条从自己登记那刻起 10 秒失效）；
 *   2. Ctrl+Z 的键位判定（Ctrl + Z，不带 Shift / Alt / Meta）；
 *   3. 焦点保护（在输入框 / 下拉框 / 编辑区 / contenteditable 里按 Ctrl+Z 必须还是
 *      「文本撤销」，不能被全局撤销条抢走）。
 *
 * 契约：本模块不碰 DOM、不碰 IPC、不读配置，只做上面三件事。
 *   createUndoSlot({ ttlMs, maxDepth, now }) 返回
 *     { push, peek, take, clear, expire, hasPending, remainingMs, size, ttlMs }
 *     - push({ label, run, bookPath })：登记一条撤销动作；run 必须是函数（返回值随意）。
 *       超出深度时丢最旧的一条，被丢的那条挂在返回值的 `evicted` 上（只带 id / label / bookPath / at，
 *       不带 run —— 给 UI 提一句「上一步的撤销已被替换」，但不留一个还会被调用的闭包）。
 *     - peek()：还活着就返回**最新**一条（顺手清掉已过期的），返回 null 表示没有可撤销的动作。
 *     - take(match)：取走并返回最新一条；传了 match 就只取走同一个对象（执行成功后精确弹出这一条，
 *       不会误伤这期间刚登记的新动作）。
 *     - expire()：只清「已过期」的条目（可能一次清掉多条），返回是否清掉了。
 *     - remainingMs()：最新那条距离过期还剩多少毫秒（0 = 没有 / 已过期）。
 *     - size()：未过期的条数（调试 / 单测用）。
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
  // 最近几条可退（H-1：连续两个破坏性动作不再互相顶掉退路，但也不做无限历史）。
  const MAX_DEPTH = 3;
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
    const maxDepth =
      Number.isFinite(opts.maxDepth) && opts.maxDepth >= 1 ? Math.floor(opts.maxDepth) : MAX_DEPTH;
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    // 旧 → 新。只有最新那条会被 peek / take 取到；更早的在自己过期前仍可退。
    const entries = [];
    let seq = 0;

    function isExpired(item) {
      return !item || now() - item.at >= ttlMs;
    }

    // 从新到旧扫一遍，把过期的条目就地删掉；返回删了几条。
    function prune() {
      let dropped = 0;
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        if (isExpired(entries[i])) {
          entries.splice(i, 1);
          dropped += 1;
        }
      }
      return dropped;
    }

    function push(action) {
      if (!action || typeof action !== 'object') throw new TypeError('undo.push 需要 { label, run }');
      if (typeof action.run !== 'function') throw new TypeError('undo.push 的 run 必须是函数');
      prune();
      seq += 1;
      const entry = {
        id: seq,
        label: action.label == null || action.label === '' ? DEFAULT_LABEL : String(action.label),
        bookPath: typeof action.bookPath === 'string' ? action.bookPath : '',
        run: action.run,
        at: now(),
        evicted: null
      };
      entries.push(entry);
      let evicted = null;
      while (entries.length > maxDepth) {
        const dropped = entries.shift();
        // 只保留提示需要的字段：被顶掉的那条 run 不再被任何地方持有（不留悬空闭包 / 数据）。
        evicted = { id: dropped.id, label: dropped.label, bookPath: dropped.bookPath, at: dropped.at };
        entry.evicted = evicted;
      }
      return entry;
    }

    function peek() {
      prune();
      return entries.length ? entries[entries.length - 1] : null;
    }

    function take(match) {
      prune();
      if (!entries.length) return null;
      if (match) {
        const at = entries.indexOf(match);
        if (at >= 0) entries.splice(at, 1);
        else return null;
        return match;
      }
      return entries.pop();
    }

    function clear() {
      entries.length = 0;
    }

    function expire() {
      return prune() > 0;
    }

    function hasPending() {
      return Boolean(peek());
    }

    function remainingMs() {
      const current = peek();
      if (!current) return 0;
      return Math.max(0, ttlMs - (now() - current.at));
    }

    function size() {
      prune();
      return entries.length;
    }

    return { push, peek, take, clear, expire, hasPending, remainingMs, size, ttlMs, maxDepth };
  }

  return { TTL_MS, MAX_DEPTH, DEFAULT_LABEL, createUndoSlot, isUndoKey, isTypingTarget };
});