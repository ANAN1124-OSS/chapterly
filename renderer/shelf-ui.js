/* 书架交互（v0.9 B-5 第六刀：从 renderer.js 三个小分区整段搬出来）。
 *
 * 搬走的三段（原 renderer.js 行号，均为相邻或独立小分区）：
 *   「继续上次写作」1040–1081（42 行）—— 书架头的继续写作卡：找最近一本可继续的书、
 *     渲染「继续写《书名》 · 第N章：xxx」与「最后写作 … · 共 N 章」，以及打开那本书；
 *   「同步冲突副本提示」1082–1108（27 行）—— 冲突副本清单对话框的打开 / 关闭
 *     （只提示、不合并、不动文件，自动处理风险太大）；
 *   「切换 / 新建 / 重命名 / 删除」3824–3850（27 行）—— 当前章节标签 + 切章
 *     （含未保存修改的 askUnsaved 拦截）。
 * 合计 96 行。**只碰渲染层与一次 state 读取**：不写盘、不改正文、不碰 IPC 白名单、不改 config、
 * 不改数据格式；文案 / class / DOM 结构 / 返回值形状全部照旧。
 *
 * 契约：createShelfUi(host) 由渲染层调用一次，host 提供：
 *   host = {
 *     $, state, chapterTitle, formatRelativeTime,
 *     openBookByPath, askUnsaved, saveCurrent, loadChapterAt
 *   }
 * 缺任何一个直接抛 TypeError（宁可在启动时炸，也不要到点书架 / 切章时 ReferenceError）。
 * host 成员全是一次性解构的稳定引用；它们在渲染层都是函数声明（会提升）或先于装配点的
 * const，所以装配点即使比 openBookByPath / saveCurrent / loadChapterAt 的声明位置靠前也不影响。
 *
 * 为什么这三块合成一刀：它们同属「书架 / 切章」这一层，彼此没有调用关系
 * （continueTarget 只在本模块内用，不对外导出），但都很小；一次装配、一次加载顺序、一条
 * commit 比连开三刀更省验证成本。
 *
 * 搬过来的东西（行为一字未改）：
 *   - 继续写作卡：continueTarget 的取书规则（recentBook 按 path 小写比对；找不到 / corrupt 就当没有）、
 *     章节下标夹取（Math.round → 夹到 total-1）、标题与 title 属性、元信息拼接、hidden 切换；
 *   - 冲突副本对话框：state.conflictBook 记在渲染层状态上、清单逐行建 div.conflict-file、
 *     backdrop 的 hidden 切换；
 *   - 切章：同章直接 { ok: true, same: true }、越界「章节不存在」、dirty 时 askUnsaved 询问
 *     （取消 → { ok: false, canceled: true }；保存失败原样透传）、最后 loadChapterAt。
 *
 * 红线不变：只读 state（冲突对话框写 state.conflictBook，与搬之前同一行）、只改 DOM；
 * 本模块不注册任何事件监听、不进 Esc 动作表、不改测试钩子的宿主契约——
 * 事件绑定 / Esc 动作表 / 测试钩子仍在 renderer.js 里按名字取这几个 const。
 *
 * 浏览器里挂成全局 CWShelfUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWShelfUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HOST = ['$', 'state', 'chapterTitle', 'formatRelativeTime', 'openBookByPath', 'askUnsaved', 'saveCurrent', 'loadChapterAt'];

  function createShelfUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createShelfUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) {
        throw new TypeError('createShelfUi 的 host 缺少 ' + key);
      }
    }
    const { $, state, chapterTitle, formatRelativeTime, openBookByPath, askUnsaved, saveCurrent, loadChapterAt } = host;
  // ---------- 继续上次写作 ----------
  // 主进程在打开书 / 切章 / 保存时记 config.lastBook；这里只负责把它显示出来。
  // 书架里已经找不到那本书（被删/改名）或是损坏书时，入口直接隐藏，不做任何猜测。
  function continueTarget() {
    const recent = state.recentBook;
    if (!recent || !recent.path) return null;
    const wanted = String(recent.path).toLowerCase();
    const book = (state.books || []).find((item) => String(item.path || '').toLowerCase() === wanted);
    if (!book || book.status === 'corrupt') return null;
    return { book, recent };
  }

  function renderContinueWriting() {
    const wrap = $('shelf-continue');
    if (!wrap) return;
    const target = continueTarget();
    if (!target) {
      wrap.classList.add('hidden');
      return;
    }
    const { book, recent } = target;
    const total = Math.max(0, Number(book.chapterCount) || 0);
    let chapterIndex = Math.max(0, Math.round(Number(recent.chapterIndex) || 0));
    if (total > 0) chapterIndex = Math.min(chapterIndex, total - 1);
    const label = total > 0 ? chapterTitle(chapterIndex, recent.chapterName) : '';
    const title = `继续写《${book.title}》${label ? ` · ${label}` : ''}`;
    $('continue-title').textContent = title;
    $('continue-title').title = title;
    const metaParts = [];
    if (recent.at) metaParts.push(`最后写作 ${formatRelativeTime(recent.at)}`);
    if (total > 0) metaParts.push(`共 ${total} 章`);
    $('continue-meta').textContent = metaParts.join(' · ');
    wrap.classList.remove('hidden');
  }

  async function openContinueBook() {
    const target = continueTarget();
    if (!target) return { ok: false, message: '没有可继续的书' };
    await openBookByPath(target.book.path);
    return { ok: state.view === 'editor', index: state.index };
  }

  // ---------- 同步冲突副本提示 ----------
  // 只提示、不合并、不动文件：冲突副本可能含用户没合并的手稿，自动处理风险太大。
  function openConflictDialog(book) {
    if (!book) return;
    const conflicts = Array.isArray(book.conflicts) ? book.conflicts.slice() : [];
    if (!conflicts.length) return;
    state.conflictBook = book;
    $('conflict-book').textContent = `《${book.title || book.folder}》 · ${book.path || ''}`;
    $('conflict-book').title = book.path || '';
    $('conflict-summary').textContent = `共 ${conflicts.length} 个冲突副本（只提示，不会自动合并或删除）`;
    const list = $('conflict-files');
    list.innerHTML = '';
    for (const name of conflicts) {
      const row = document.createElement('div');
      row.className = 'conflict-file';
      row.textContent = name;
      row.title = name;
      list.appendChild(row);
    }
    $('conflict-backdrop').classList.remove('hidden');
  }

  function closeConflictDialog() {
    state.conflictBook = null;
    $('conflict-backdrop').classList.add('hidden');
  }

  // ---------- 切换 / 新建 / 重命名 / 删除 ----------
  function currentChapterLabel() {
    if (state.index < 0 || !state.chapters[state.index]) return '当前章节';
    return chapterTitle(state.index, state.chapters[state.index].name);
  }

  async function switchChapter(index, options = {}) {
    if (index === state.index) return { ok: true, same: true };
    if (index < 0 || index >= state.chapters.length) return { ok: false, message: '章节不存在' };
    if (state.dirty) {
      let action = options.dirtyAction;
      if (!action) {
        action = await askUnsaved({
          title: '切换章节前保存',
          message: `「${currentChapterLabel()}」有未保存的修改，切换会丢失这些内容。`
        });
      }
      if (action === 'cancel') return { ok: false, canceled: true };
      if (action === 'save') {
        const saved = await saveCurrent();
        if (!saved.ok) return saved;
      }
    }
    await loadChapterAt(index);
    return { ok: true };
  }

    return {
      renderContinueWriting,
      openContinueBook,
      openConflictDialog,
      closeConflictDialog,
      currentChapterLabel,
      switchChapter
    };
  }

  return { create: createShelfUi, REQUIRED_HOST };
});
