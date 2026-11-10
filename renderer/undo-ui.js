/* 全局撤销条（1.4.0 P0-2：删除 / 移动等确认型弹层改为「直接执行 + 撤销」；1.5.0 P0-4：小栈 + 手动关闭）。
 *
 * 只做 DOM 与定时器：条子在哪、写什么字、点了以后跑什么，全由调用方决定。
 *   - activate(label, run)：登记一条撤销动作并显示「已删除「…」 [撤销] [×]」；
 *     栈满被顶掉最旧一条时用 toast 提一句（不静默吞掉一步退路）；
 *   - runUndo()：执行当前这条（异步）；成功后栈里还有更早的就把条子换成下一条继续显示，
 *     没有才收起；失败弹一句「撤销失败：…」并保留到**这条自己的** TTL 到期，
 *     作者可以再点一次（例如临时占用 / 权限问题），重试不把 10 秒重新续满；
 *   - dismiss()：手动关掉（× 或 Esc）——清空栈、收起条子、焦点还给打开撤销条之前的那个元素；
 *   - clear()：换书 / 回书架 / 关窗时调用，10 秒窗口不跨书；
 *   - setup()：给「撤销」与「×」按钮挂点击（幂等，只挂一次）。
 *
 * 契约：createUndoUi(host) 只调用一次；host = { $, slot, toast }：
 *   - $ 是渲染层的 getElementById 包装（#undo-bar / #undo-label / #btn-undo / #btn-undo-close）；
 *   - slot 是 renderer/undo-action.js 的 createUndoSlot()（小栈 + 每条自己的 TTL 都在那边）；
 *   - toast 用来报「撤销失败」与被顶掉的提示，绝不静默。
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
    // 打开撤销条时焦点在谁身上：手动关掉以后要还回去（删章用右键菜单触发时，焦点不该丢在空气里）。
    let lastFocused = null;

    function barEl() {
      return $('undo-bar');
    }

    function labelEl() {
      return $('undo-label');
    }

    function rememberFocus() {
      if (typeof document === 'undefined' || !document) return;
      const active = document.activeElement;
      if (!active || active === document.body) return;
      if (typeof active.focus !== 'function') return;
      lastFocused = active;
    }

    function restoreFocus() {
      const target = lastFocused;
      lastFocused = null;
      if (target && typeof target.focus === 'function') {
        try {
          target.focus();
          return true;
        } catch {
          /* 原焦点已经不在了：往下走，回到编辑区 */
        }
      }
      // 没记到原焦点（删除不是从菜单 / 编辑区触发的，焦点本来在 body 上）：退回编辑区。
      if (typeof document !== 'undefined' && document && typeof document.getElementById === 'function') {
        const editor = document.getElementById('editor');
        if (editor && typeof editor.focus === 'function') {
          try {
            editor.focus();
            return true;
          } catch {
            return false;
          }
        }
      }
      return false;
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

    // 只写条子内容与可见性，不碰定时器（定时器由 scheduleExpire 统一管，避免递归重排）。
    function paint(label) {
      const el = barEl();
      const text = labelEl();
      if (text) text.textContent = String(label || '');
      if (el) {
        el.classList.remove('hidden');
        el.setAttribute('aria-hidden', 'false');
      }
      return Boolean(el);
    }

    // 当前这条自己还剩多少毫秒（过期逐条清理，不按「最后一次动作」统一续时）。
    function currentDelay() {
      const remaining = typeof slot.remainingMs === 'function' ? slot.remainingMs() : ttlMs;
      return Number.isFinite(remaining) ? remaining : ttlMs;
    }

    function onExpireTick() {
      timer = null;
      slot.expire();
      const next = slot.peek();
      if (!next) {
        hide();
        return;
      }
      // 最新那条过期了，但更早的还在自己的窗口里：换成它继续显示。
      paint(next.label);
      scheduleExpire();
    }

    function scheduleExpire() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const remaining = currentDelay();
      if (remaining <= 0) {
        onExpireTick();
        return;
      }
      timer = setTimeout(onExpireTick, remaining);
    }

    function show(label) {
      paint(label);
      scheduleExpire();
      return Boolean(barEl());
    }

    function activate(label, run) {
      rememberFocus();
      const entry = slot.push({ label, run });
      // H-1：栈满时最旧那一步的退路会被顶掉 —— 明说一句，别让作者以为它还在。
      if (entry && entry.evicted && typeof toast === 'function') {
        toast(`上一步（${entry.evicted.label}）的撤销已被新动作替换`, 'info');
      }
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
        // 精确弹掉执行过的那条：这期间若又登记了新动作，不会把新的误删。
        if (typeof slot.take === 'function') slot.take(entry);
        else slot.clear();
        const next = slot.peek();
        if (next) {
          paint(next.label);
          scheduleExpire();
        } else {
          hide();
          restoreFocus();
        }
        return true;
      } catch (err) {
        const message = err && err.message ? err.message : '原因不明';
        if (typeof toast === 'function') toast(`撤销失败：${message}`, 'error');
        // 失败不把条子收掉：同一个动作可能只是临时失败（文件被占用等），留到 TTL 到期前可再点；
        // 重排用的是这条自己的剩余时间，**不**重新起算 10 秒。
        scheduleExpire();
        return false;
      } finally {
        running = false;
      }
    }

    function clear() {
      lastFocused = null;
      slot.clear();
      hide();
    }

    // 手动关闭（× 按钮 / 没有弹层时按 Esc）：清空退路、收起条子、焦点回原处。
    function dismiss() {
      const had = slot.hasPending();
      slot.clear();
      hide();
      restoreFocus();
      return had;
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
      const close = $('btn-undo-close');
      if (close && typeof close.addEventListener === 'function') {
        close.addEventListener('click', (event) => {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          dismiss();
        });
      }
      return true;
    }

    return {
      activate,
      runUndo,
      clear,
      dismiss,
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