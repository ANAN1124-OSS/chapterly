/* 「替换这一处」回执的书 / 章 / 正文身份复核（v1.8.2 WP3 / 审计 E-N4）——纯逻辑，不碰 DOM、不读盘。
 *
 * 缺陷现场：runReplaceOne 先拍编辑区 text → await findNext → 直接把回执里的 match.index 套到
 * 「当前编辑区」。IPC 往返期间作者可能切章 / 换书 / 改正文；loadChapterAt 已经换掉了正文，旧章的
 * 命中下标于是被拼进新章（越界时退化成追加），随后 onEditorInput 把新章标脏，Ctrl+S 即污染落盘。
 *
 * 这里只放判定，renderer.js 只按结论动界面：
 *   · captureTarget：发起查找时拍下（书路径 + 当前载入章 id + 正文快照）；
 *   · checkTarget：回执到达时逐项核对（载章在途 / 换书 / 切章 / 正文改动），任何一项不一致就作废；
 *   · checkChapterTarget：替换成功后「选中下一处」用（此时正文必然已变，只看书 + 章）；
 *   · matchInBounds / locateNext：下标必须是「非负整数、长度 ≥ 1、index + length ≤ 正文长度」才许用；
 *   · staleHint：每种作废原因对应一句界面文案（入口 loading 也复用它）。
 * 浏览器挂 window.CWReplaceOneGuard（index.html 在 renderer.js 之前加载），Node 里可 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWReplaceOneGuard = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function toText(value) {
    return String(value == null ? '' : value);
  }

  // 章 id 的 null / undefined / '' 统一成 null：没有载入章节就是没有目标，别和空串互相冒充。
  function toId(value) {
    return value == null || value === '' ? null : String(value);
  }

  function sameBookPath(a, b) {
    return toText(a) === toText(b);
  }

  function readSnapshot(snapshot) {
    return snapshot && typeof snapshot === 'object' ? snapshot : {};
  }

  // 发起替换时拍下的身份快照；路径 / id / 正文都归一，后面比较不会因类型差异抖动。
  function captureTarget(options) {
    const opts = options && typeof options === 'object' ? options : {};
    return {
      bookPath: toText(opts.bookPath),
      chapterId: toId(opts.chapterId),
      text: toText(opts.text)
    };
  }

  // 回执能不能用：载章在途最先判（马上要被新章覆盖，换了书 / 章也来不及救）。
  function checkTarget(snapshot, current) {
    const before = readSnapshot(snapshot);
    const now = readSnapshot(current);
    if (now.loading === true) return { same: false, reason: 'loading' };
    if (!sameBookPath(before.bookPath, now.bookPath)) return { same: false, reason: 'book-changed' };
    if (toId(before.chapterId) !== toId(now.chapterId)) return { same: false, reason: 'chapter-changed' };
    if (toText(before.text) !== toText(now.text)) return { same: false, reason: 'text-changed' };
    return { same: true, reason: '' };
  }

  // 只看「还是不是同一本书的这一章」：替换成功后编辑区正文已经变了，不能拿正文比。
  function checkChapterTarget(snapshot, current) {
    const before = readSnapshot(snapshot);
    const now = readSnapshot(current);
    if (now.loading === true) return { same: false, reason: 'loading' };
    if (!sameBookPath(before.bookPath, now.bookPath)) return { same: false, reason: 'book-changed' };
    if (toId(before.chapterId) !== toId(now.chapterId)) return { same: false, reason: 'chapter-changed' };
    return { same: true, reason: '' };
  }

  // 命中下标必须完整落在正文里：文末命中（index + length === 长度）合法，越界 1 字都不行。
  // 主进程回执被外部改坏时（负数 / 0 长度 / 非整数 / 超大值）也一律拒绝，宁可少换一处。
  function matchInBounds(match, textLength) {
    if (!match || typeof match !== 'object') return false;
    const index = match.index;
    const length = match.length;
    const total = Number(textLength);
    if (!Number.isInteger(index) || !Number.isInteger(length)) return false;
    if (index < 0 || length < 1) return false;
    if (!Number.isInteger(total) || total < 0) return false;
    return index + length <= total;
  }

  // 第二个 await（找下一处）的回执：同章 + 在界内才给选中位置；有命中但身份变了 / 越界 → stale，
  // 调用方只放弃「选中」，绝不改正文；没有命中（null）不算 stale，走原有「光标放替换处之后」。
  function locateNext(rawMatch, snapshot, current) {
    if (!rawMatch || typeof rawMatch !== 'object') return { index: null, length: 0, stale: false };
    const now = readSnapshot(current);
    if (!checkChapterTarget(snapshot, now).same) return { index: null, length: 0, stale: true };
    if (!matchInBounds(rawMatch, now.textLength)) return { index: null, length: 0, stale: true };
    return { index: rawMatch.index, length: rawMatch.length, stale: false };
  }

  function staleHint(reason) {
    switch (reason) {
      case 'loading':
        return '正在切换章节，「替换这一处」先等一下再试';
      case 'book-changed':
        return '查找期间换了书，「替换这一处」已取消；请重新查找后再替换';
      case 'chapter-changed':
        return '查找期间切了章，「替换这一处」已取消；请重新查找后再替换';
      case 'text-changed':
        return '查找期间正文有改动，「替换这一处」已取消；请重新查找后再替换';
      default:
        return '查找结果已过期，「替换这一处」已取消；请重新查找后再替换';
    }
  }

  return { captureTarget, checkTarget, checkChapterTarget, matchInBounds, locateNext, staleHint };
});