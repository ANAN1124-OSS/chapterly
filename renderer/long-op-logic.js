/* 长异步操作收尾的纯逻辑（v1.8.0 WP-02 / 审计 C2）——不碰 DOM、不读盘、不依赖 Electron。
 *
 * 整本整理 / 还原替换备份 / 从磁盘重载这类操作要等 IPC 往返（整理还要逐章写盘）：发起时
 * 查过一次「有没有未保存修改」，等回来时现场可能已经变了——作者切了书，或者又敲了几行字。
 * 以前完成路径直接用 await 之后的活值重载：整理期间切书会重载到另一本书；期间输入被
 * loadChapterAt 无条件覆盖、dirty 还被清成 false（静默丢稿）。
 * 这里把「回执还能不能拿来重载」的判定收成纯函数，renderer.js 只按结论动界面：
 *   · 书换了（expected != current）→ 回执属于原来那本，界面一个字都不动；
 *   · 同一本书但有未保存字（dirty）→ 正文优先，保留编辑区，只刷新目录 / 书目。
 *
 * 浏览器挂 window.CWLongOpLogic（index.html 在 renderer.js 之前加载），Node 里可 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWLongOpLogic = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // N-02：渲染层「是不是同一本书」的路径口径只留这一份（书架增量刷新 / 长操作收尾 / 保存链 /
  // 救稿 / 历史还原共用）。Windows 大小写不敏感；null / undefined 按空串不炸。
  // 以前各模块各写一套、部分只做 toLowerCase：主进程返回的路径一般是 resolve 过的，但只要某条
  // 通道给了正斜杠形式（`D:/书库/甲`），同一本书就会被判成两本 → 重复书卡 / 更新落空 / 拒绝重载。
  // 渲染层没有 node:path，这里不做 resolve（解析侧仍以 core/path-utils.js 的 pathKey 为准），
  // 只做「去首尾空白 + 正斜杠归反斜杠 + 小写」这三步等价归一。
  function bookPathKey(value) {
    return String(value == null ? '' : value).trim().replace(/\//g, '\\').toLowerCase();
  }

  function sameBookPath(a, b) {
    return bookPathKey(a) === bookPathKey(b);
  }

  // 长操作完成后的处置：'book-changed' | 'keep-edits' | 'reload'
  function decideAfterLongOp(options) {
    const opts = options || {};
    if (!sameBookPath(opts.expectedBookPath, opts.currentBookPath)) return 'book-changed';
    if (opts.dirty === true) return 'keep-edits';
    return 'reload';
  }

  // 从磁盘重载前的闸门：书换了 / 有未保存修改 → 不允许重载（作者的字优先于界面刷新）。
  function canReloadFromDisk(options) {
    const opts = options || {};
    if (!sameBookPath(opts.expectedBookPath, opts.currentBookPath)) return false;
    return opts.dirty !== true;
  }

  return { bookPathKey, sameBookPath, decideAfterLongOp, canReloadFromDisk };
});