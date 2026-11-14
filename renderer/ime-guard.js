/* 输入法组字守卫（v1.8.0 WP-04 / 审计 C3、C8、V112）——纯函数，不碰 DOM、不依赖 Electron。
 *
 * 中文输入法组字期间按 Enter 是「上屏候选词」，不是提交。Chromium 正常会给 keydown 带上
 * event.isComposing = true；部分旧版 / 第三方输入法只报 keyCode 229（V112 的防御性加固——
 * 229 不是 V73 当初的判据要求，是这次统一判据时顺带补上的一道保险）。
 * 全仓的「Enter = 提交」链路（查找 / 替换、章节筛选、命令面板、跳章、书架搜索、书籍信息、
 * 全局 Enter 兜底）统一调这个函数，别在各监听器里再手写一份 `event.isComposing`。
 *
 * 浏览器挂 window.CWImeGuard（index.html 排在所有消费者之前），Node 里可 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWImeGuard = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 组字中：isComposing 是标准判据；keyCode === 229 兜住只报「放行键」的旧版 / 第三方输入法。
  // 没有 event（合成调用 / 测试）一律按「不在组字」处理，守卫本身绝不能把提交键弄哑。
  function isImeComposing(event) {
    if (!event) return false;
    if (event.isComposing === true) return true;
    return event.keyCode === 229;
  }

  return { isImeComposing };
});