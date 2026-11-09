/* 全局撤销条（1.4.0 P0-2：删除 / 移动等确认型弹层改为「直接执行 + 撤销」）。
 *
 * 只做 DOM 与定时器：条子在哪、写什么字、点了以后跑什么，全由调用方决定。
 *   - activate(label, run)：登记一条撤销动作并显示「已删除「…」 [撤销]」；
 *   - runUndo()：执行当前这条（异步）；成功收起，失败弹一句「撤销失败：…」并保留到 TTL 到期，
 *     作者可以再点一次（例如临时占用 / 权限问题）；
 *   - clear()：换书 / 回书架 / 关窗时调用，10 秒窗口不跨书；
 *   - setup()：给「撤销」按钮挂点击（幂等，只挂一次）。
 *
 * 契约：createUndoUi(host) 只调用一次；host = { $, slot, toast }：
 *   - $ 是渲染层的 getElementById 包装（#undo-bar / #undo-label / #btn-undo）；
 *   - slot 是 renderer/undo-action.js 的 createUndoSlot()（单槽 + TTL 逻辑全在那边）；
 *   - toast 用来报「撤销失败」，绝不静默。
 * 缺任何一个直接抛 TypeError（宁可在启动时炸，也不要到撤销时 ReferenceError）。
 *
 * 浏览器里挂成全局 CWUndoUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWUndoUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HOST = ['$', 'slot', 'toast'];
  const TTL_MS = 10000;

  function createUndoUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createUndoUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) {
        throw new TypeError('createUndoUi 的 host 缺少 ' + key);
      }
    }
    const { $, slot, toast } = host;
    // 停留时长以 slot 的 TTL 为准（单测会传很小的值；生产是 undo-action.js 的 10s）
    const ttlMs = Number.isFinite(slot.ttlMs) && slot.ttlMs > 0 ? slot.ttlMs : TTL_MS;
    let timer = null;
    let bound = false;
    let running = false;

    function barEl() {
      return $('undo-bar');
    }

    function labelEl() {
      return $('undo-label');
    }

    function hide() {
      if (timer) clearTimeout(timer);
      timer = null;
      const el = barEl();
      if (el) {
        el.classList.add('hidden');
        el.setAttribute('aria-hidden', 'true');
      }
      const label = labelEl();
      if (label) label.textContent = '';
    }

    function scheduleExpire() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        // 定时器醒来再核对一次现场：这 10 秒里可能又被新动作顶掉 / 已经撤销成功收起了。
        if (slot.expire() || !slot.hasPending()) hide();
      }, ttlMs);
    }

    function show(label) {
      const el = barEl();
      const text = labelEl();
      if (text) text.textContent = String(label || '');
      if (el) {
        el.classList.remove('hidden');
        el.setAttribute('aria-hidden', 'false');
      }
      scheduleExpire();
      return Boolean(el);
    }

    function activate(label, run) {
      slot.push({ label, run });
      const current = slot.peek();
      show(current ? current.label : String(label || ''));
      return current;
    }

    async function runUndo() {
      const entry = slot.peek();
      if (!entry) {
        hide();
        return false;
      }
      if (running) return false;
      running = true;
      try {
        await entry.run();
        slot.clear();
        hide();
        return true;
      } catch (err) {
        const message = err && err.message ? err.message : '原因不明';
        if (typeof toast === 'function') toast(`撤销失败：${message}`, 'error');
        // 失败不把条子收掉：同一个动作可能只是临时失败（文件被占用等），留到 TTL 到期前可再点。
        scheduleExpire();
        return false;
      } finally {
        running = false;
      }
    }

    function clear() {
      slot.clear();
      hide();
    }

    function setup() {
      if (bound) return false;
      bound = true;
      const btn = $('btn-undo');
      if (btn && typeof btn.addEventListener === 'function') {
        btn.addEventListener('click', (event) => {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          void runUndo();
        });
      }
      return true;
    }

    return {
      activate,
      runUndo,
      clear,
      hide,
      hasPending: () => slot.hasPending(),
      label: () => {
        const entry = slot.peek();
        return entry ? entry.label : '';
      },
      setup
    };
  }

  return { create: createUndoUi, REQUIRED_HOST, TTL_MS };
});
