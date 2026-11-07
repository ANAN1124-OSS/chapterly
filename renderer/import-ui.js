/* 导入 / 删除小说（v0.9 B-5 第四刀：从 renderer.js 的书架级操作分区整段搬出来）。
 *
 * 搬走的一段：原 renderer.js「导入 / 删除小说（书架级操作）」4461–4572 行（112 行），
 * 含导入方式询问（按原文章节 / 整本一章）、导入进度提示（逐项汇报）、导入结果汇总
 * （已导入 / 跳过 / 失败的前几条原因）、删除单本书（Windows 回收站 / 书架 _trash 兜底）。
 * **只碰渲染层**：真正的分析 / 复制 / 拆章 / 移动都在主进程（core/importer.js）里，
 * 这里只发 IPC、显示进度、弹确认框、刷新书架。不写盘、不改正文、不改 dirty、
 * 不碰 IPC 白名单。
 *
 * 契约：createImportUi(host) 由渲染层调用一次，host 提供：
 *   host = { $, api, call, openModal, refreshShelf, state, toast }
 * 缺任何一个直接抛 TypeError（宁可在启动时炸，也不要到点「导入小说」时 ReferenceError）。
 * host 成员全是一次性解构的稳定引用；导入进度的 toast 元素由本模块独占
 * （是模块内的活状态，不放在渲染层），事件绑定的进度监听问 hasImportProgress()。
 *
 * 搬过来的东西（行为一字未改，文案 / class / 按钮文字 / 提示语 / IPC 参数都照旧）：
 *   - importBooksFlow：发 api.importBooks、进度 toast、「已导入 N 本：… 跳过 N 个（…）」
 *     汇总文案、失败 / 取消分支、导入后刷新书架；
 *   - onImportClick：导入方式询问框（按原文章节导入 / 整本一章 / 取消）；
 *   - deleteBookFlow：删除确认框（移到回收站可还原）+ 回收站 / _trash 两条成功提示 + 失败提示；
 *   - setImportProgressText / summarizeImport：进度文案与汇总文案的纯逻辑。
 *
 * 红线不变：只读 state / 只改 DOM，删除走主进程（回收站或 _trash），本模块不真删任何东西。
 * 浏览器里挂成全局 CWImportUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWImportUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HOST = ['$', 'api', 'call', 'openModal', 'refreshShelf', 'state', 'toast'];

  function createImportUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createImportUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) {
        throw new TypeError('createImportUi 的 host 缺少 ' + key);
      }
    }
    const { $, api, call, openModal, refreshShelf, state, toast } = host;
  // ---------- 导入 / 删除小说（书架级操作） ----------
  let importProgressEl = null;

  function setImportProgressText(text) {
    if (importProgressEl) importProgressEl.textContent = text;
  }

  function summarizeImport(imported, skipped, failed) {
    const messages = [];
    if (imported.length) {
      const titles = imported.map((b) => b.title);
      const shown = titles.slice(0, 3).join('、');
      messages.push(
        imported.length > 3
          ? `已导入 ${imported.length} 本：${shown} 等`
          : `已导入 ${imported.length} 本：${shown}`
      );
    }
    if (skipped.length) {
      const reasons = [...new Set(skipped.map((s) => s.reason))].slice(0, 2).join('；');
      messages.push(`跳过 ${skipped.length} 个（${reasons}）`);
    }
    if (failed.length) {
      const reasons = failed.map((f) => f.message).slice(0, 2).join('；');
      messages.push(`${failed.length} 个失败（${reasons}）`);
    }
    return messages.join('。') || '没有可导入的内容';
  }

  async function importBooksFlow(explicitPaths, mode = 'chapters') {
    if (state.importing) return { busy: true };
    state.importing = true;
    const importButton = $('btn-import');
    if (importButton) importButton.disabled = true;
    importProgressEl = document.createElement('div');
    importProgressEl.className = 'toast';
    importProgressEl.textContent = '正在分析要导入的内容…';
    $('toast-area').appendChild(importProgressEl);

    let data = null;
    let error = null;
    try {
      data = await call(api.importBooks, explicitPaths, { mode });
    } catch (err) {
      error = err;
    } finally {
      if (importProgressEl && importProgressEl.parentNode) importProgressEl.remove();
      importProgressEl = null;
      state.importing = false;
      if (importButton) importButton.disabled = false;
    }

    if (error) {
      toast(`导入失败：${error.message}`, 'error');
      return { error: error.message };
    }
    if (data.canceled) return { canceled: true };

    toast(
      summarizeImport(data.imported, data.skipped, data.failed),
      data.failed.length ? 'error' : data.skipped.length ? 'warn' : 'info'
    );
    await refreshShelf();
    return data;
  }

  // 点「导入小说」先问导入方式：默认按原文章节拆开，也可整本一章
  async function onImportClick() {
    if (state.importing) return;
    const res = await openModal({
      title: '导入小说',
      message:
        '请选择导入方式：\n\n' +
        '• 按原文章节导入（推荐）：按原文的「第X章 / 楔子」等标题拆成多章，章名照抄原文、正文一字不改\n' +
        '• 整本一章导入：不拆章，整本小说放在一章「全文」里（原样复制）',
      buttons: [
        { label: '按原文章节导入', value: 'chapters', kind: 'primary' },
        { label: '整本一章', value: 'raw' },
        { label: '取消', value: 'cancel' }
      ],
      cancelValue: 'cancel'
    });
    if (res.action !== 'chapters' && res.action !== 'raw') return;
    await importBooksFlow(undefined, res.action);
  }

  async function deleteBookFlow(book, { skipConfirm = false } = {}) {
    if (!book || !book.path) return;
    if (!skipConfirm) {
      const res = await openModal({
        title: '删除这本书',
        message: `确定删除「${book.title}」吗？\n\n整本书（${book.chapterCount} 章）会被移到 Windows 回收站，可以从回收站还原。`,
        buttons: [
          { label: '删除这本书', value: 'delete', kind: 'danger' },
          { label: '取消', value: 'cancel', kind: 'primary' }
        ],
        cancelValue: 'cancel'
      });
      if (res.action !== 'delete') return;
    }
    try {
      const data = await call(api.deleteBook, book.path);
      if (data.method === 'recycle') {
        toast(`已删除「${book.title}」，可在 Windows 回收站里还原`);
      } else {
        toast(`已删除「${book.title}」，已移到书架 _trash${data.note ? `（${data.note}）` : ''}`);
      }
      await refreshShelf();
    } catch (err) {
      toast(`删除失败：${err.message}`, 'error');
    }
  }
    // 导入进度的 toast 元素归本模块所有；渲染层的事件绑定问这一句（原来直接读
    // if (!importProgressEl) return;，行为等价）。
    function hasImportProgress() {
      return Boolean(importProgressEl);
    }

    return {
      setImportProgressText,
      hasImportProgress,
      summarizeImport,
      importBooksFlow,
      onImportClick,
      deleteBookFlow
    };
  }

  return { create: createImportUi, REQUIRED_HOST };
});
