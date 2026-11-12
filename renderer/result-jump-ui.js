/* 校对 / 敏感词预检共用的「点结果 → 跳过去选中」（1.7.0 P4-1 / 审计 V29 重复实现收编）。
 *
 * 收编前 renderer/proofread-ui.js 的 jumpToProofreadIssue 与 renderer/sensitive-ui.js 的
 * jumpToSensitiveMatch 是逐行复制的两份（只有「关哪个面板」和取词不同），任何一处改动都要同步两遍。
 *
 * 契约（行为与收编前逐字一致）：
 *   create({ state, toast, peers: { matchRangeAt }, nav: { editorEl, switchChapter }, view: { scrollCaretIntoView } })
 *     → { jumpToResult(item, closePanel) }
 *   item 只用 chapterId / chapterIndex / 命中位置字段（校对 issue 与敏感词 match 同构）。
 * 顺序：先关面板 → 切章（失败原样返回 canceled）→ 定位 → focus → 选中 → 滚进视野。
 * 模块不碰 DOM / 不注册监听 / 不建定时器；浏览器挂全局 CWResultJumpUi，Node 里直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWResultJumpUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HOST = ['state', 'toast', 'peers', 'nav', 'view'];

  function createResultJumpUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createResultJumpUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) {
        throw new TypeError('createResultJumpUi 的 host 缺少 ' + key);
      }
    }
    const { state, toast, peers, nav, view } = host;
    const matchRangeAt = peers.matchRangeAt;
    if (typeof matchRangeAt !== 'function') {
      throw new TypeError('createResultJumpUi 的 host.peers 缺少 matchRangeAt');
    }
    const editorEl = nav.editorEl;
    const switchChapter = nav.switchChapter;
    const scrollCaretIntoView = view.scrollCaretIntoView;
    if (typeof switchChapter !== 'function') throw new TypeError('createResultJumpUi 的 host.nav 缺少 switchChapter');
    if (typeof scrollCaretIntoView !== 'function') {
      throw new TypeError('createResultJumpUi 的 host.view 缺少 scrollCaretIntoView');
    }

    // item = 校对的一条 issue / 敏感词的一处命中；closePanel = 调用方自己的面板关闭函数。
    async function jumpToResult(item, closePanel) {
      if (!state.bookPath) return { ok: false };
      let index = Number(item.chapterIndex);
      const byIndex =
        Number.isInteger(index) &&
        index >= 0 &&
        state.chapters[index] &&
        state.chapters[index].id === item.chapterId;
      if (!byIndex) index = state.chapters.findIndex((chapter) => chapter.id === item.chapterId);
      // 兜底：当前章的结果万一没带章信息，就落在正在看的这一章
      if (index < 0 && item.chapterId == null) index = state.index;
      if (index < 0) {
        toast('这一章已经不存在了', 'warn');
        return { ok: false };
      }
      closePanel();
      if (index !== state.index) {
        const switched = await switchChapter(index);
        if (!switched || switched.ok === false) {
          return { ok: false, canceled: Boolean(switched && switched.canceled) };
        }
      }
      const range = matchRangeAt(editorEl.value, item);
      editorEl.focus();
      editorEl.setSelectionRange(range.start, range.end);
      scrollCaretIntoView(range.start);
      return { ok: true, start: range.start, end: range.end };
    }

    return { jumpToResult };
  }

  return { REQUIRED_HOST, create: createResultJumpUi };
});
