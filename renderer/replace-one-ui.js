/* 「替换这一处」的整段入口 —— M1（第一轮·低）拆分第四刀：从 renderer.js 整段搬出。
 *
 * 为什么单独一个模块：这条流只在查找面板里点「替换这一处」才走，却是全仓时序最刁的一处——
 *   · 先拍「这本书 + 这一章 + 这版正文」的身份快照（replaceOneGuard.captureTarget）；
 *   · 两次 await findNext，回执可能迟到（期间切章 / 换书 / 改正文 / 载章在途）；
 *   · 回执只能用在「还是那一版正文」上：身份不一致 / 下标越界一律返回 STALE_TARGET，
 *     绝不许把旧章下标拼进新章正文（E-N4 / WP3 的丢字现场）；
 *   · 替换用 execCommand 保住原生 Ctrl+Z；execCommand 不可用时才退回字符串拼接，
 *     并记一次性快照（审计 #39 / V402：兜底会清浏览器撤销栈）。
 * 搬出来以后这四件事可以用假 guard / 桩 findNext 在 Node 里逐条钉住，不必开 Electron 抬两个回执。
 *
 * 契约：createReplaceOneUi(host) 只调用一次；host 正好 12 个成员：
 *   $, state, editorEl, api, call, readFindOptions, replaceOneGuard,
 *   getTestFindNext, replaceEditorTextNative, onEditorInput, recordFallbackWrite, scrollCaretIntoView
 *   · getTestFindNext 是**取值函数**（不是值）：E2E 通过测试钩子把 findNext 换成带延迟的实现，
 *     create 时解构会拿到 null 的旧快照，所以每次调用前现取；
 *   · 缺任何一个必填成员直接抛 TypeError（宁可在启动时炸，也不要到点「替换这一处」时 ReferenceError）。
 *
 * 只读 state / 编辑区，改写也只发生在编辑区（未保存）；不写盘、不发别的 IPC。
 *
 * 浏览器里挂成全局 CWReplaceOneUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../core/assert-host').assertHost);
  } else if (root) {
    root.CWReplaceOneUi = factory(root.CWAssertHost && root.CWAssertHost.assertHost);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (assertHost) {
  'use strict';

  const REQUIRED_HOST = [
    '$',
    'state',
    'editorEl',
    'api',
    'call',
    'readFindOptions',
    'replaceOneGuard',
    'getTestFindNext',
    'replaceEditorTextNative',
    'onEditorInput',
    'recordFallbackWrite',
    'scrollCaretIntoView'
  ];

  function createReplaceOneUi(host) {
    assertHost('createReplaceOneUi', host, REQUIRED_HOST);
    const {
      $, state, editorEl, api, call, readFindOptions, replaceOneGuard,
      getTestFindNext, replaceEditorTextNative, onEditorInput, recordFallbackWrite, scrollCaretIntoView
    } = host;

    // 「只替换这一处」：只改编辑区（未保存），替换完自动选中下一处，方便连续按。
    // 用 execCommand 替换当前选中文本，保住原生 Ctrl+Z 撤销链。
    async function runReplaceOne() {
      const options = readFindOptions();
      if (!options.query.trim()) {
        $('find-summary').textContent = '先在查找框里输入内容';
        return { ok: false };
      }
      if (options.scope !== 'current') {
        $('find-summary').textContent = '「替换这一处」只用于当前章；整本替换请用「全部替换」。';
        return { ok: false };
      }
      const text = editorEl.value;
      const from = editorEl.selectionStart || 0;
      // 审计 E-N4（WP3）：载章在途时编辑区马上要被新章覆盖，这次替换会静默丢失——入口直接拒绝。
      if (state.loading) {
        $('find-summary').textContent = replaceOneGuard.staleHint('loading');
        return { ok: false, code: 'STALE_TARGET', reason: 'loading' };
      }
      // 活绑定：E2E 通过测试钩子把 findNext 换成带延迟的实现，create 时就解构会拿到 null 的旧快照。
      const testFindNext = getTestFindNext();
      // 发起查找时拍下「这本书 + 这一章 + 这版正文」：findNext 回执迟到（切章 / 换书 / 改正文）就整段作废。
      const target = replaceOneGuard.captureTarget({
        bookPath: state.bookPath,
        chapterId: state.loadedChapterId,
        text
      });
      let picked;
      try {
        picked = await (testFindNext || call)(api.findNext, text, options.query, from, {
          caseSensitive: options.caseSensitive
        });
      } catch (err) {
        $('find-summary').textContent = `查找失败：${err.message}`;
        return { ok: false };
      }
      if (!picked || !picked.match) {
        // 审计修复 #10（E6）：命中超过单章 5000 处上限时，光标之后的位置已不在命中列表里，
        // 要说清是「被上限截断」而不是「本章没有下一处」。
        $('find-summary').textContent =
          picked && picked.truncated
            ? '本章命中超过单章上限 5000 处，光标之后的位置不再定位；换个更具体的词或先用「全部替换」'
            : `光标之后没有找到「${options.query}」了`;
        return { ok: false, truncated: Boolean(picked && picked.truncated) };
      }
      const match = picked.match;
      const replacement = options.replacement;
      // 回执可能迟到：这期间切了书 / 切了章 / 改了正文——旧下标绝不能套到眼前的正文上，越界也不拼接。
      const verdict = replaceOneGuard.checkTarget(target, {
        bookPath: state.bookPath,
        chapterId: state.loadedChapterId,
        text: editorEl.value,
        loading: state.loading
      });
      if (!verdict.same || !replaceOneGuard.matchInBounds(match, text.length)) {
        $('find-summary').textContent = replaceOneGuard.staleHint(verdict.same ? 'stale' : verdict.reason);
        return { ok: false, code: 'STALE_TARGET', reason: verdict.same ? 'out-of-bounds' : verdict.reason };
      }
      editorEl.focus();
      editorEl.setSelectionRange(match.index, match.index + match.length);
      const inserted = replaceEditorTextNative(replacement);
      let fallbackUsed = false;
      if (!inserted) {
        // 极端兜底：execCommand 不可用时手动拼接（会丢原生撤销链，但不会丢内容）
        const current = editorEl.value;
        editorEl.value =
          current.slice(0, match.index) + replacement + current.slice(match.index + match.length);
        fallbackUsed = true;
      }
      onEditorInput();
      // 审计修复 #39（V402）：兜底拼接会清空浏览器撤销栈 —— 记一次性快照并提示（放在输入处理之后）
      if (fallbackUsed) {
        recordFallbackWrite({ before: text, after: editorEl.value, start: match.index, label: '替换这一处' });
      }

      // 选中下一处，方便连续替换
      let next = null;
      try {
        const after = match.index + replacement.length;
        next = await (testFindNext || call)(api.findNext, editorEl.value, options.query, after, {
          caseSensitive: options.caseSensitive
        });
      } catch { /* 找下一处失败不影响已经替换的内容 */ }
      // 第二个回执也可能迟到：旧章命中只用来定位，切章后绝不把下标套到新章（只改选中，不改正文）。
      const locate = replaceOneGuard.locateNext(next && next.match, target, {
        bookPath: state.bookPath,
        chapterId: state.loadedChapterId,
        textLength: editorEl.value.length,
        loading: state.loading
      });
      if (locate.index != null) {
        editorEl.setSelectionRange(locate.index, locate.index + locate.length);
        scrollCaretIntoView(locate.index);
      } else if (!locate.stale) {
        const caret = match.index + replacement.length;
        editorEl.setSelectionRange(caret, caret);
        scrollCaretIntoView(caret);
      }
      const nextHint = locate.stale
        ? '；期间章节已变，不再定位下一处'
        : locate.index != null
          ? `；已选中下一处（第 ${next.index + 1} 处）`
          : '；本章后面没有下一处了';
      const truncated = Boolean(picked.truncated);
      const totalLabel = truncated ? `${picked.total}+` : String(picked.total);
      const truncatedHint = truncated ? '（本章命中超过单章上限 5000 处，只统计 / 处理前 5000 处）' : '';
      $('find-summary').textContent =
        `已替换第 ${picked.index + 1}/${totalLabel} 处（未保存：Ctrl+S 写盘，Ctrl+Z 可撤销）${nextHint}${truncatedHint}`;
      return { ok: true, index: picked.index, total: picked.total, truncated, hasNext: locate.index != null };
    }

    // 只暴露入口（与搬前等价：编排器里同名转发）。不要在渲染层再长第二份（tests/replace-one-ui.test.js 的机器清单会红）。
    return { runReplaceOne };
  }

  return { create: createReplaceOneUi, REQUIRED_HOST };
});
