/* 状态栏 + 外部修改检测（v0.9 B-5 第七刀：从 renderer.js 两个小分区整段搬出来）。
 *
 * 搬走的两段（原 renderer.js 行号，均为独立小分区）：
 *   「状态栏」1744–1822（79 行）—— 本章字数（正常章节即时算；超过 20 万字符的超大单章
 *     改成 400ms 防抖，多打几个字只算最后一次）+「比上章短」软提示 + 选中字数 / 段数；
 *   「外部修改检测」4394–4425（32 行）—— 窗口失焦再回到前台时比对本章 mtime：
 *     没变就不管、有未保存修改只 toast 警告、否则问要不要重新加载磁盘内容。
 * 合计 111 行。**只搬不改行为**：文案 / class / 时间阈值（400ms / 500ms）/ 20 万字符阈值 /
 * 防抖与旧响应语义全部照旧；不写盘、不改正文、不改 dirty、不碰 IPC 白名单、不改 config / 数据格式。
 *
 * 契约：createStatusbarUi(host) 由渲染层调用一次，host 提供：
 *   host = {
 *     $, state, editorEl, formatChars, chaptersLib, editorLogic,
 *     call, api, toast, openModal, loadChapterAt
 *   }
 * 缺任何一个直接抛 TypeError（宁可在启动时炸，也不要到打字 / 回到前台时 ReferenceError）。
 * host 成员全是一次性解构的稳定引用；它们在渲染层都是函数声明（会提升）或先于装配点的 const。
 *
 * 事件监听：外部修改检测的两个 window 监听由 setupExternalChangeWatch() 注册，渲染层在**原来的
 * 位置**（原 4394 行处）调用它——监听顺序与搬之前逐条一致；create() 本身不注册任何监听。
 * 状态栏的 400ms 防抖定时器（charCountTimer）与 lastBlurAt 都是本模块内部状态，不对外导出。
 *
 * 浏览器里挂成全局 CWStatusbarUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWStatusbarUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HOST = ['$', 'state', 'editorEl', 'formatChars', 'formatCount', 'chaptersLib', 'editorLogic', 'call', 'api', 'toast', 'openModal', 'loadChapterAt'];

  function createStatusbarUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createStatusbarUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) {
        throw new TypeError('createStatusbarUi 的 host 缺少 ' + key);
      }
    }
    const { $, state, editorEl, formatChars, formatCount, chaptersLib, editorLogic, call, api, toast, openModal, loadChapterAt } = host;
  // ---------- 状态栏 ----------
  // 本章字数：正常章节即时算；MB 级的超大单章（「整本一章」导入）每个字都全文正则统计会卡，
  // 超过 20 万字符改成 400ms 防抖，多打几个字只算最后一次。
  let charCountTimer = null;
  const CHAR_COUNT_DEFER_ABOVE = 200000;

  // 章节字数：书目里的 chars 缓存（打开书 / 保存后由主进程补齐）；没有就是 null
  function chapterCharsOf(chapter) {
    if (!chapter) return null;
    const n = Number(chapter.chars);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  }

  // 本章字数 + 「比上章短」软提示（提案 4.1：章节字数对比）。
  // 当前章按编辑区实时算（未保存也算），上一章按书目缓存；只提示，不改任何东西。
  function updateCharCountText() {
    const el = $('char-count');
    if (!el) return;
    if (!state.bookPath || state.index < 0) {
      el.textContent = '';
      el.classList.remove('count-short');
      el.title = '';
      return;
    }
    const liveChars = chaptersLib.countChars(editorEl.value);
    let text = `本章 ${formatChars(liveChars)}`;
    el.classList.remove('count-short');
    el.title = '本章字数（不含空白）；未保存的编辑也算。';
    const previousChars = state.index > 0 ? chapterCharsOf(state.chapters[state.index - 1]) : null;
    const compared = editorLogic.compareChapterChars(liveChars, previousChars);
    if (compared.direction === 'shorter') {
      text += ` · ${compared.message}`;
      el.classList.add('count-short');
      el.title =
        `本章 ${formatCount(liveChars)} 字，上一章 ${formatCount(previousChars)} 字（短了 ${Math.abs(compared.percent)}%）。` +
        '只是提醒，不改任何东西；如果这一章还没写完，可能是漏了内容。';
    }
    el.textContent = text;
  }

  function renderCharCount() {
    if (!state.bookPath || state.index < 0) {
      clearTimeout(charCountTimer);
      updateCharCountText();
      return;
    }
    const text = editorEl.value;
    if (text.length <= CHAR_COUNT_DEFER_ABOVE) {
      clearTimeout(charCountTimer);
      updateCharCountText();
      return;
    }
    clearTimeout(charCountTimer);
    charCountTimer = setTimeout(() => {
      if (!state.bookPath || state.index < 0) return;
      updateCharCountText();
    }, 400);
  }

  // 选中字数：只在真选了文字时显示；和「本章字数」同口径（不含空白），段数按触及的非空行算。
  function renderSelectionStats() {
    const el = $('status-selection');
    if (!el) return;
    if (state.view !== 'editor' || !state.bookPath || state.index < 0) {
      el.classList.add('hidden');
      el.textContent = '';
      return;
    }
    const stats = editorLogic.selectionStats(editorEl.value, editorEl.selectionStart, editorEl.selectionEnd);
    if (stats.collapsed || (stats.chars === 0 && stats.paragraphs === 0)) {
      el.classList.add('hidden');
      el.textContent = '';
      return;
    }
    el.classList.remove('hidden');
    el.textContent = `选中 ${formatChars(stats.chars)} / ${stats.paragraphs} 段`;
    el.title = '选中的字数（不含空白，和「本章字数」同口径）与触及的自然段数';
  }

  // ---------- 外部修改检测 ----------
  let lastBlurAt = 0;

  // 在渲染层原来的位置（原 4394 行处）装配；监听顺序与搬之前一致。
  function setupExternalChangeWatch() {
    window.addEventListener('blur', () => {
      lastBlurAt = Date.now();
    });
    window.addEventListener('focus', async () => {
      const since = Date.now() - lastBlurAt;
      lastBlurAt = 0;
      if (!state.bookPath || state.index < 0 || state.loading || state.saving || state.modal || state.reading.open || since < 500) return;
      const chapter = state.chapters[state.index];
      if (!chapter) return;
      try {
        const stat = await call(api.statChapter, state.bookPath, chapter.file);
        if (stat.mtimeMs === state.loadedMtimeMs) return;
        if (state.dirty) {
          toast('本章在应用外被修改过；你还有未保存的修改，保存会覆盖外部内容', 'warn');
          return;
        }
        const res = await openModal({
          title: '检测到外部修改',
          message: '当前章节文件在应用外被修改过（可能是用记事本改的）。要重新加载磁盘上的内容吗？',
          buttons: [
            { label: '重新加载', value: 'reload', kind: 'primary' },
            { label: '保留当前', value: 'keep' }
          ]
        });
        if (res.action === 'reload') await loadChapterAt(state.index);
      } catch {
        /* 文件可能被删了，忽略 */
      }
    });
  }

    return {
      chapterCharsOf,
      renderCharCount,
      renderSelectionStats,
      setupExternalChangeWatch
    };
  }

  return { create: createStatusbarUi, REQUIRED_HOST };
});
