/* 全局键盘接线（M1 第一轮·低 第七刀：从 renderer.js 的 bindEvents 整段搬出来）。
 *
 * 为什么搬这一块：bindEvents 里最后一块大骨头是这一个 document keydown 监听（178 行、30 余个
 * 闭包）。它不是若干独立小绑定，而是一整条**有序的分流链**：输入法守卫 → 全局 Esc 链（esc-registry）
 * → 快捷键一览 → 命令面板 → F11 / F3 / F2 → 段落导航 → 复制本章 → Ctrl+A 全选 → Ctrl+PageUp /
 * PageDown 切章 → Ctrl+G 跳章 → Ctrl+F 查找 → 全局撤销 → 整理快照撤销 → Ctrl+S / Ctrl+N。
 * 顺序本身就是行为（Esc 链必须先于所有快捷键；输入法守卫必须先于一切），所以整段搬、不拆，
 * 注册点仍在 bindEvents 的原位（同层监听器的追加顺序不变）。
 *
 * 契约：createGlobalKeysUi(host) 由渲染层调用一次；bind() 只做一件事——把唯一一个 keydown
 * 监听挂到 host.document 上。host 交出这条分流链真正读到的东西（状态 / 入口 / 判定表），
 * 模块不反向持有大对象；缺任何一个成员直接抛 TypeError（宁可在启动时炸，也不要到按键时才
 * ReferenceError）。
 *
 * 红线不变：这一域只做「按键 → 分发」——不写盘、不改正文、不切章（切章仍走 switchChapter，
 * 保存仍走 saveCurrent，撤销仍走 undoUi / undoFormat 的既有实现）。
 * 浏览器里挂成全局 CWGlobalKeysUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../core/assert-host').assertHost);
  } else if (root) {
    root.CWGlobalKeysUi = factory(root.CWAssertHost && root.CWAssertHost.assertHost);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (assertHost) {
  'use strict';

  const REQUIRED_HOST = [
    'document', '$', 'state', 'editorEl', 'imeGuard', 'escLib', 'escProbe', 'escRun',
    'anyBackdropOpen', 'commandPalette', 'openShortcutsPage', 'openCommandPalette',
    'toggleFocusMode', 'findSessionActive', 'stepFind', 'listKeyboard', 'renameChapterAt',
    'jumpParagraph', 'copyChapterPlatformFlow', 'renderedChapterIds', 'setChapterSelection',
    'chapterSelectionLib', 'switchChapter', 'focusChapterItem', 'reportChainFailure',
    'openJumpDialog', 'openFindPanel', 'undoUi', 'undoActionModule', 'undoFormat',
    'saveCurrent', 'createChapterAt'
  ];

  function createGlobalKeysUi(host) {
    // A8（WP-32）：REQUIRED_HOST 逐成员校验走共享实现（文案不变）。
    assertHost('createGlobalKeysUi', host, REQUIRED_HOST);
    const {
      document, $, state, editorEl, imeGuard, escLib, escProbe, escRun, anyBackdropOpen,
      commandPalette, openShortcutsPage, openCommandPalette, toggleFocusMode, findSessionActive,
      stepFind, listKeyboard, renameChapterAt, jumpParagraph, copyChapterPlatformFlow,
      renderedChapterIds, setChapterSelection, chapterSelectionLib, switchChapter, focusChapterItem,
      reportChainFailure, openJumpDialog, openFindPanel, undoUi, undoActionModule, undoFormat,
      saveCurrent, createChapterAt
    } = host;

    // 分流链的函数体与搬前逐字一致（只有自由变量改成 host 解构出来的同名常量）。
    function onKeyDown(event) {
      // 1.7.1 P1（审计 V73）/ WP-04（V112）：输入法组字期间一切全局键都不响应。组字中按 Enter 是「上屏候选词」，
      // 不是提交 —— 这一判放在 Esc 链与快捷键之前，兜住注册表上所有 Enter 语义
      // （通用询问框的 modalInput → modal-confirm、新建书名等），否则中文作者会把半截表单提交掉。
      // 判据统一走 ime-guard.js（isComposing || keyCode 229），别在这里另写一份。
      if (imeGuard.isImeComposing(event)) return;
      // 全局 Esc 链（v0.9 B-4）：顺序与命中判定全在 renderer/esc-registry.js 的有序表里，这里只执行动作。
      // 命中就到此为止——锁键弹层（通用询问框 + 冲突 / 书籍信息 / 历史 / 排版 / 导出 / 设置 / 跳章）
      // 连别的按键也一并接走，所以它们开着时 Ctrl+S / F11 也不会响（改前每段末尾那个裸 return 就是这个意思）。
      // 1.6.0 A5/P-09：探针只在「Esc 键 / 有锁键层」时现算 —— escProbe() 要读约 30 个元素与状态，
      // 而打字 / 输入法组字的每个 keydown 原本都先摊一份，纯属浪费。非 Esc 键只有在锁键层开着时
      // 才会被注册表接走（锁键层吞所有键），没有锁键层时 resolve 一定不命中。
      const escProbeNeeded = escLib.isEscapeKey(event.key) || anyBackdropOpen() || commandPalette.isOpen();
      const escHit = escProbeNeeded ? escLib.resolve(escProbe(), event.key) : null;
      if (escHit) {
        if (escHit.action) {
          if (escHit.preventDefault) event.preventDefault();
          escRun(escHit.action);
        }
        return;
      }
      // 快捷键一览（1.5.0 功能-4）：写作页按 ? / 中文输入法的 ？ 打开；Esc 由上面的快捷键锁键层收起。
      // 焦点在输入类目标（正文 textarea / 搜索框）里时 ? 是普通字符，不抢；任何弹层开着时也不开
      // （锁键弹层已经被上面的 Esc 链吞掉，这里兜住不锁键的面板，避免两层叠在一起）。
      // 不判 shiftKey：`?` 本身就是 Shift+/ 打出来的，判了反而永远不响。
      if (
        (event.key === '?' || event.key === '？') &&
        !event.ctrlKey && !event.altKey && !event.metaKey
      ) {
        if (imeGuard.isImeComposing(event)) return;
        if (undoActionModule.isTypingTarget(document.activeElement)) return;
        if (anyBackdropOpen()) return;
        event.preventDefault();
        openShortcutsPage();
        return;
      }
      // 命令面板（1.4.0 P0-3 / 规范 I-03）：Ctrl+K 打开；再按一次收起。锁键弹层开着时不抢
      // （与 Esc 链同一口径：通用询问框 / 冲突 / 历史 / 排版 / 导出 / 设置 / 跳章 / 命令面板本身）。
      if (
        event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey &&
        String(event.key).toLowerCase() === 'k'
      ) {
        // 面板开着时这一支走不到（esc-registry 的 command 层是锁键层，会先吞掉按键）；
        // 「再按一次 Ctrl+K 收起」由面板自己的输入框处理（command-palette-ui.js）。
        // 长按不重复开关（1.5.0 P0-4 / H-9）：event.repeat 派发的按键只吞掉、不再开合面板。
        if (!imeGuard.isImeComposing(event) && !event.repeat && !anyBackdropOpen()) {
          event.preventDefault();
          openCommandPalette();
        }
        return;
      }
      // 查找面板里的回车由 find-ui 自己的 `#find-query` 监听器处理（它 preventDefault + stopPropagation，
      // 按键不会再冒泡到这里）；这里不再重复一份，避免同一键按两次触发两次查找。
      // 专注模式（提案 3.5）：F11 来回切换（只在写作页；不写配置、不写盘）
      if (event.key === 'F11') {
        if (state.view === 'editor' && state.bookPath) {
          event.preventDefault();
          toggleFocusMode();
        }
        return;
      }
      // 查找：F3 / Shift+F3 重复上次查找（写作页，面板关着也能用；到两端绕回）
      if (event.key === 'F3' && !event.ctrlKey && !event.altKey && !event.metaKey) {
        if (state.view === 'editor' && state.bookPath && findSessionActive()) {
          event.preventDefault();
          void stepFind(event.shiftKey ? -1 : 1);
        }
        return;
      }
      // 重命名当前章（Phase D / D2）：F2 = 文件管理器 / 表格里的通用「重命名」。
      // 弹层打开时上面的 Esc 注册表先接走（锁键弹层连 F2 也吃），这里只管写作页；
      // 焦点在别的输入框里时不抢（查找 / 跳章 / 碎片 / 设置），编辑区自己除外。
      // 列表里用方向键只移焦点、不切章，所以「改哪一条」交给 renameTargetIndex 按焦点算。
      if (event.key === 'F2' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
        if (state.view !== 'editor' || !state.bookPath || state.index < 0) return;
        if (listKeyboard.isTypingTarget(document.activeElement, editorEl)) return;
        event.preventDefault();
        const target = listKeyboard.renameTargetIndex(document.activeElement, state.chapters.length, state.index);
        if (target >= 0) void renameChapterAt(target);
        return;
      }
      // 段落导航（提案 4.1）：Alt+↑/↓ 在自然段开头之间跳，只移动光标、不改字
      if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        if (state.view === 'editor' && state.bookPath) {
          event.preventDefault();
          jumpParagraph(event.key === 'ArrowDown' ? 1 : -1);
        }
        return;
      }
      // 复制本章（平台格式）：Ctrl+Shift+C；不抢 Ctrl+C 的普通复制
      if (event.ctrlKey && event.shiftKey && !event.altKey && String(event.key).toLowerCase() === 'c') {
        if (state.view === 'editor' && state.bookPath) {
          event.preventDefault();
          copyChapterPlatformFlow(state.index);
        }
        return;
      }
      const ctrl = event.ctrlKey && !event.altKey && !event.shiftKey;
      // 1.6.0 F1：章节列表里的 Ctrl+A = 全选（只认当前渲染出来的行，筛选 / 折叠时不偷选隐藏的章）。
      // 焦点在编辑区 / 输入框 / 别的区域时一律不管——原生全选正文 / 输入框的行为不变。
      if (ctrl && String(event.key).toLowerCase() === 'a') {
        const inList = event.target && typeof event.target.closest === 'function'
          ? event.target.closest('#chapter-list')
          : null;
        if (!inList) return;
        if (state.view !== 'editor' || !state.bookPath) return;
        const renderedIds = renderedChapterIds();
        if (!renderedIds.length) return;
        event.preventDefault();
        setChapterSelection(chapterSelectionLib.selectAll(renderedIds));
        return;
      }
      // 写作页切章（v0.13 U-D12）：Ctrl+PageUp / PageDown = 上一章 / 下一章。保存语义与点章节栏
      // 完全一致——只调 switchChapter（未保存走现成的询问框、保存走 saveCurrent），不新增静默保存、
      // 也不绕过它直接 loadChapterAt。首章 PageUp / 末章 PageDown 什么都不做（不绕回、不提示）；
      // 书架 / 阅读页 / 弹层开着时都不接管（弹层由上面的 Esc 注册表先接走）。
      if (ctrl && (event.key === 'PageUp' || event.key === 'PageDown')) {
        if (state.view !== 'editor' || !state.bookPath) return;
        event.preventDefault();
        // 上一趟切章还在读盘（连按 / 按住不放）就不叠第二趟，免得 state.index 与正文对不上
        if (state.loading) return;
        const target = listKeyboard.chapterSwitchTarget(state.index, event.key, state.chapters.length);
        if (target < 0) return;
        // B1（审计 E2）：切章失败要出声（原来 .then 没有 .catch，前面的步骤 reject 时静默不执行）
        void switchChapter(target)
          .then((result) => {
            if (!result || result.ok !== true || result.same) return;
            focusChapterItem({ mode: 'switch', index: target });
          })
          .catch((err) => reportChainFailure('切换章节失败', err));
        return;
      }
      if (ctrl && String(event.key).toLowerCase() === 'g') {
        event.preventDefault();
        if (state.view === 'editor' && state.bookPath) openJumpDialog();
        return;
      }
      if (ctrl && String(event.key).toLowerCase() === 'f') {
        event.preventDefault();
        if (state.view === 'editor' && state.bookPath) {
          openFindPanel();
        } else if (state.view === 'shelf') {
          $('shelf-search').focus();
          $('shelf-search').select();
        }
        return;
      }
      // 全局撤销（1.4.0 P0-2）：删除等动作留下的撤销优先于原生文本撤销；
      // 焦点在编辑区 / 输入框 / 下拉框 / contenteditable 里时一律不抢（isTypingTarget）。
      if (
        undoUi.hasPending() &&
        undoActionModule.isUndoKey(event, undoActionModule.isTypingTarget(document.activeElement))
      ) {
        event.preventDefault();
        void undoUi.runUndo();
        return;
      }
      if (ctrl && String(event.key).toLowerCase() === 'z') {
        // 「整理本章」留下的快照优先撤销；没有快照就让原生 Ctrl+Z 照常工作
        // 审计残留修复 #40（V403）：补焦点守卫 —— 焦点在查找 / 替换 / 跳章 / 书架搜索这些输入
        // 控件里时，Ctrl+Z 是框内自己的文本撤销，不能拿正文整理快照抢走（与相邻 undoUi 分支
        // 同一套 isTypingTarget 口径）。编辑区自己例外：整理快照撤的就是正文，焦点在正文里仍生效。
        const focusEl = document.activeElement;
        const inOtherInput = focusEl !== editorEl && undoActionModule.isTypingTarget(focusEl);
        if (!inOtherInput && state.view === 'editor' && state.bookPath && undoFormat()) {
          event.preventDefault();
          return;
        }
      }
      if (ctrl && String(event.key).toLowerCase() === 's') {
        event.preventDefault();
        if (state.view === 'editor' && state.bookPath) saveCurrent();
      } else if (ctrl && String(event.key).toLowerCase() === 'n') {
        event.preventDefault();
        if (state.view === 'editor' && state.bookPath) createChapterAt(state.chapters.length);
      }
      // 兜底的 Esc（收起右键菜单 / 顶栏菜单）在注册表最后一层，不用再写一遍。
    }

    // 注册点由渲染层决定（bindEvents 里与原监听同一位置）：同层监听器的追加顺序不变。
    function bind() {
      document.addEventListener('keydown', onKeyDown);
    }

    return { bind };
  }

  return { create: createGlobalKeysUi, REQUIRED_HOST };
});
