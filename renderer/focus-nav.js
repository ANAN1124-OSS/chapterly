/* 焦点可达性与聚焦助手（REDT-C-06）——浏览器侧纯策略，不碰数据、不写盘。
 *
 * 为什么单独一个文件：同一族判定以前有三份实现，细节已经漂移：
 *   · renderer/menu-keyboard.js 的 isUsableItem（吃「事实」对象，查 .hidden 类，不查 inert / 样式）
 *     + 自己的 doFocus（只 preventScroll，不滚入视图）；
 *   · renderer/dialog-focus.js 的 isTabbable（查 [inert] 与 display / visibility，不查 .hidden 类）
 *     + 自己的 doFocus（会 scrollIntoView nearest）；
 *   · renderer/list-keyboard.js 的 Tab 停靠逻辑（内联 focus + scrollIntoView）。
 * 可达性口径的任何修正都要同步三处，漏一处就出现「弹层里跳过了 .hidden 的按钮、菜单里跳过了 inert
 * 的条目」这类分叉。这里收成一份：**事实采集**（factsOf / isUsableFacts 纯函数，单测不用搭 DOM）
 * 与**聚焦助手**（focusElement：preventScroll + nearest 滚入视图，两处同口径）。
 *
 * 步进语义（菜单绕回、列表夹住）是文档化的刻意差异，不在这里合并。
 *
 * 浏览器里挂成全局 CWFocusNav（index.html 排在 menu-keyboard / dialog-focus 之前），Node 里可 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWFocusNav = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 一个元素「现在能不能拿焦点」的原始事实。做成纯数据，方便单测直接构造。
  function factsOf(el, view) {
    const style = view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle(el) : null;
    return {
      disabled: Boolean(el.disabled),
      ariaHidden: Boolean(el.getAttribute && el.getAttribute('aria-hidden') === 'true'),
      tabIndex: typeof el.tabIndex === 'number' ? el.tabIndex : 0,
      hiddenClass: Boolean(el.classList && el.classList.contains('hidden')),
      hasRects: typeof el.getClientRects !== 'function' ? true : el.getClientRects().length > 0,
      inert: Boolean(el.closest && el.closest('[inert]')),
      displayNone: Boolean(style && style.display === 'none'),
      visibilityHidden: Boolean(style && style.visibility === 'hidden')
    };
  }

  // 判定口径（菜单条目与弹层可 Tab 元素共用）：
  // 禁用 / aria-hidden / 负 tabindex / .hidden 类 / 祖先 inert / 0 尺寸 / display:none / visibility:hidden
  // 都不可达。任何一项为真就排除 —— 宁可少一个 Tab 停靠点，也不要把焦点送进看不见的控件。
  function isUsableFacts(facts) {
    if (!facts) return false;
    if (facts.disabled) return false;
    if (facts.ariaHidden) return false;
    if (Number.isFinite(facts.tabIndex) && facts.tabIndex < 0) return false;
    if (facts.hiddenClass) return false;
    if (facts.inert) return false;
    if (facts.hasRects === false) return false;
    if (facts.displayNone || facts.visibilityHidden) return false;
    return true;
  }

  function isUsable(el, view) {
    if (!el || typeof el !== 'object') return false;
    return isUsableFacts(factsOf(el, view));
  }

  // 聚焦助手：先 preventScroll（别让页面乱跳），再把控件按 nearest 滚进可视区 —— 弹层里 Tab 绕回
  // 第一个 / 最后一个控件时，焦点环可能落在滚动容器视口外，滚一次让用户看见焦点去哪了。
  // scrollIntoView 缺失 / 抛错都不影响聚焦本身（老 Chromium 与假 DOM 里跳过这一步）。
  function focusElement(el, options) {
    if (!el || typeof el.focus !== 'function') return false;
    const opts = options && typeof options === 'object' ? options : {};
    let ok = false;
    try {
      el.focus({ preventScroll: true });
      ok = true;
    } catch {
      try {
        el.focus();
        ok = true;
      } catch {
        return false;
      }
    }
    if (ok && opts.scroll !== false && typeof el.scrollIntoView === 'function') {
      try {
        el.scrollIntoView({ block: 'nearest' });
      } catch {
        /* 滚不动就算了，焦点已经到位 */
      }
    }
    return ok;
  }

  return { factsOf, isUsableFacts, isUsable, focusElement };
});
