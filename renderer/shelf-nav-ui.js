/* 返回书架 + 书改名（v0.9 B-5 第十刀：从 renderer.js 的两个相邻小分区整段搬出来）。
 *
 * 搬走的段（原 renderer.js 3888–3949，62 行，含两个分区注释）——书架与写作页之间的两个高频动作：
 *   backToShelf（返回书架：有未保存修改先 askUnsaved 三选一（保存并继续 / 不保存丢弃 / 取消）→
 *     释放「打开中的书」登记 api.releaseBook（失败静默，主进程关窗时兜底）→ 清空当前书的 state
 *     （view / bookPath / meta / bookId / bookDisplay / chapters / index / dirty / saveError / baseText）
 *     + 清空编辑区 + 结束查找会话 + 切回全局显示设置（编辑器样式 / 当前段落高亮 / 章节栏宽度）→
 *     showView('shelf') → await refreshShelf()）
 *   renameBookFlow（书改名：promptText 问书名 → 主进程 api.renameBook 只改 书目.json 里的 title、
 *     书文件夹名保持不变 → 更新顶栏书名与窗口标题 → toast）
 * 只走 window.api 白名单（releaseBook / renameBook 都是既有 IPC），不读正文、不写盘、不改数据格式 / config。
 * **只搬不改行为**：三选一的三条分支与提前 return、清空的 state 字段与先后顺序、「释放失败由主进程兜底」
 * 的静默 catch、「返回书架前保存」与「有未保存的修改」文案、编辑区清空、查找会话与全局显示设置的切回时机、
 * 改名提示词与两处 toast 文案全部一字未改（indent / 空行也保持原样）。
 *
 * 契约：createShelfNavUi(host) 由渲染层调用一次，host 提供：
 *   host = { $, api, state, editorEl, askUnsaved, saveCurrent, currentChapterLabel, clearFindSession,
 *            effectiveConfig, applyEditorStyle, syncCaretParagraphFromConfig, applySidebarWidth,
 *            showView, refreshShelf, promptText, call, updateWindowTitle, toast }
 * 缺任何一个直接抛 TypeError（宁可在启动时炸，也不要到点「返回书架」/「改名」时才 ReferenceError）。
 * host 成员都是渲染层 IIFE 闭包里的函数 / 常量 / 活绑定引用，装配点早于任何调用；模块自己不缓存状态快照。
 * create() 不注册任何事件、不建定时器、不碰 DOM（只在被调用时才动 DOM）。
 *
 * 不搬的（刻意留在 renderer.js）：顶栏「返回」「改名」两个按钮的 click 绑定（事件绑定段）、
 * 测试钩子宿主契约段——两处都按原名取本模块交出的入口。
 *
 * 浏览器里挂成全局 CWShelfNavUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWShelfNavUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HOST = ['$', 'api', 'state', 'editorEl', 'askUnsaved', 'saveCurrent', 'currentChapterLabel', 'clearFindSession', 'effectiveConfig', 'applyEditorStyle', 'syncCaretParagraphFromConfig', 'applySidebarWidth', 'showView', 'refreshShelf', 'promptText', 'call', 'updateWindowTitle', 'toast'];

  function createShelfNavUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createShelfNavUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) {
        throw new TypeError('createShelfNavUi 的 host 缺少 ' + key);
      }
    }
    const {
      $, api, state, editorEl, askUnsaved, saveCurrent, currentChapterLabel, clearFindSession, effectiveConfig,
      applyEditorStyle, syncCaretParagraphFromConfig, applySidebarWidth, showView, refreshShelf,
      promptText, call, updateWindowTitle, toast
    } = host;
  // ---------- 返回书架 ----------
  async function backToShelf() {
    if (state.dirty) {
      const action = await askUnsaved({
        title: '返回书架前保存',
        message: `「${currentChapterLabel()}」有未保存的修改。`
      });
      if (action === 'cancel') return;
      if (action === 'save') {
        const saved = await saveCurrent();
        if (!saved.ok) return;
      }
    }
    // 释放「打开中的书」登记：关掉这个窗口 / 回书架后，别的窗口就能打开这本书
    try {
      // B1（审计 E6）：走统一 call() —— preload 在 IPC 异常时回 {ok:false} 而不抛，
      // 以前裸 await 让这个 catch 几乎永不触发；现在失败真的会进 catch（仍按原语义静默，
      // 由主进程在窗口销毁时兜底）。
      await call(api.releaseBook);
    } catch {
      /* 释放失败由主进程在窗口销毁时兜底 */
    }
    state.view = 'shelf';
    state.bookPath = null;
    state.meta = null;
    state.bookId = null;
    state.bookDisplay = {};
    state.chapters = [];
    state.index = -1;
    state.dirty = false;
    state.saveError = null;
    state.baseText = '';
    editorEl.value = '';
    // 回书架：查找会话跟着结束（高亮层只在写作页有意义）
    if (state.find.total) clearFindSession();
    // 回到书架就切回全局显示设置（当前段落高亮也回到全局默认，下一本书打开时再按书覆盖）
    state.config = effectiveConfig();
    applyEditorStyle();
    syncCaretParagraphFromConfig();
    applySidebarWidth(state.config.editorSidebarWidth != null ? state.config.editorSidebarWidth : 250);
    showView('shelf');
    await refreshShelf();
  }

  // ---------- 改名 ----------
  async function renameBookFlow() {
    if (!state.bookPath || !state.meta) return;
    const title = await promptText({
      title: '修改书名',
      message: '只改书目里的书名，文件夹名保持不变（与「不重命名文件」一致）。',
      value: state.meta.title || '',
      placeholder: '书名'
    });
    if (title === null) return;
    try {
      const meta = await call(api.renameBook, state.bookPath, title);
      state.meta = meta;
      $('book-title').textContent = meta.title;
      $('book-title').title = meta.title;
      updateWindowTitle();
      toast('书名已更新');
    } catch (err) {
      toast(`改名失败：${err.message}`, 'error');
    }
  }

    return {
      backToShelf,
      renameBookFlow
    };
  }

  return { create: createShelfNavUi, REQUIRED_HOST };
});
