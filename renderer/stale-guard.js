/* 长 IPC 回执的「世代令牌 + 身份快照」纯逻辑（v1.8.0 WP-15 / 审计 C15/C16/C36/C37/C40/V111/V202）
 *
 * 渲染层同一族竞态以前在 9 个面板各写各的：有的只有书级校验，有的连令牌都没有。IPC 往返期间
 * 作者可能切书 / 切章 / 连点两次，先发后到的旧回执就会把新结果盖掉（last-response-wins），
 * 甚至被标到另一章名下。这里把同一条纪律收成两个纯判定：
 *   · createSeq()：发起时 next() 取号，回来 isCurrent(号) 才允许落地——只要又发起了新的，旧回执整段作废；
 *   · chapterIdentity(state) / sameChapterIdentity(a, b)：发起时记下「书 + 第几章 + 章 id」，
 *     回来核对还是不是同一份；换书或换章就作废（不能把旧书的命中写进新书、也不能标到新章名下）。
 *
 * 只放判定，不碰 DOM、不读盘、不依赖 Electron；各面板自己决定作废后怎么写提示 / 是否保留编辑区。
 * 浏览器挂 window.CWStaleGuard（index.html 在消费者之前加载），Node 里可 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWStaleGuard = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 世代令牌：只有最后发起的那次算数。闭包只存一个数字，不建定时器、不占内存。
  function createSeq() {
    let last = 0;
    return {
      next() {
        last += 1;
        return last;
      },
      isCurrent(token) {
        return token === last;
      },
      current() {
        return last;
      }
    };
  }

  // 两份额外身份是否完全一致（键集合与每个值都相同）。缺任何一侧、空对象都算不一致，
  // 免得「两边都没传」被当成同一次。
  function sameIdentity(expected, current) {
    if (!expected || !current || typeof expected !== 'object' || typeof current !== 'object') return false;
    const keys = Object.keys(expected);
    if (!keys.length || keys.length !== Object.keys(current).length) return false;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(current, key)) return false;
      if (expected[key] !== current[key]) return false;
    }
    return true;
  }

  // 当前「书 + 章」身份快照：bookPath / 第几章 / 章 id 一起记。
  // 没有章（index 越界 / chapters 还没载入）时 chapterId 记 null，比较时同样按 null 算。
  function chapterIdentity(state) {
    const source = state || {};
    const chapters = Array.isArray(source.chapters) ? source.chapters : [];
    const index = Number.isInteger(source.index) ? source.index : -1;
    const chapter = index >= 0 && index < chapters.length ? chapters[index] : null;
    return {
      bookPath: source.bookPath == null ? '' : String(source.bookPath),
      chapterIndex: index,
      chapterId: chapter && chapter.id != null ? String(chapter.id) : null
    };
  }

  function sameChapterIdentity(expected, current) {
    if (!expected || !current) return false;
    return (
      expected.bookPath === current.bookPath &&
      expected.chapterIndex === current.chapterIndex &&
      expected.chapterId === current.chapterId
    );
  }

  return { createSeq, sameIdentity, chapterIdentity, sameChapterIdentity };
});