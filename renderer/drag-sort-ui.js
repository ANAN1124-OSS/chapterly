/* 章节拖拽排序（v0.9 B-5 第五刀：从 renderer.js 的「章节拖拽排序」分区整段搬出来）。
 *
 * 搬走的一段：原 renderer.js「章节拖拽排序」1539–1745 行（207 行），含
 * pointer 拖拽（pointerdown 起手 / pointermove 跟手 / pointerup 落点）、拖拽落点计算
 * （插到章节前 / 后、丢进卷标题、指针在末尾之后落到最后一组末尾）、拖动到列表顶部 / 底部
 * 附近自动滚动、拖拽标记的清理、原地不动不写盘的短路判断、以及两条写盘路径：
 *   - moveChapterByDrop → api.moveChapterTo（带卷 / 落点前的章节 id）；
 *   - moveChapterByDrag → api.moveChapter（按目标下标整体移动，测试钩子 / 键盘入口用）。
 * **只改 书目.json 的顺序**：章节文件永不改名 / 移动，正文一个字不动；真正的写盘与
 * 顺序重排都在主进程（core/chapters.js），这里只发 IPC、刷新列表、提示。
 *
 * 契约：createDragSortUi(host) 由渲染层调用一次，host 提供：
 *   host = { $, api, call, chapterVolumeId, renderChapterList, renderEditorHeader,
 *            state, toast, updateStatus, volumeDisplayName }
 * 缺任何一个直接抛 TypeError（宁可在启动时炸，也不要拖到第一次拖拽时 ReferenceError）。
 * host 成员全是一次性解构的稳定引用；拖拽过程（chapterDrag）是本模块独占的活状态，
 * 不放在渲染层。模块只读 / 写 state 的既有字段（meta / chapters / index /
 * suppressChapterClick），字段语义与搬运前一致。
 *
 * 事件监听（window 的 pointermove / pointerup / pointercancel）由 setupChapterDrag 一次装上，
 * 仍然是渲染层在事件绑定段调用它；章节条目的 pointerdown 仍由 renderChapterList 的标记里
 * 绑到 startChapterDrag —— 这两处调用点一个字没改。
 *
 * 红线不变：章节文件永不改名 / 移动；只改 书目.json 顺序；不写盘、不改正文、不改 dirty。
 * 浏览器里挂成全局 CWDragSortUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWDragSortUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HOST = ['$', 'api', 'call', 'chapterVolumeId', 'renderChapterList', 'renderEditorHeader', 'state', 'toast', 'updateStatus', 'volumeDisplayName'];

  // 键盘上下移动（Phase D / D1）：Alt+↑/↓ 把这一章在本卷内上移 / 下移一格，等价于「拖一行」。
  // 章节数组顺序 = 界面显示顺序，且按卷分组连续（core/chapters.js 的顺序约定），所以同卷的
  // 相邻下标就是界面上的相邻两行。跨卷（卷首往上 / 卷尾往下）返回 null —— 换卷归属是显式的
  // 拖拽 /「移到卷…」动作，键盘不偷偷改；调用方据此停住，不写盘。
  // 返回 { kind: 'index', toIndex } 或 null；纯逻辑，不碰 DOM / 不 require。
  function stepMoveTarget(chapters, index, direction, volumeOf) {
    const list = Array.isArray(chapters) ? chapters : [];
    const from = Math.floor(Number(index));
    const step = Math.floor(Number(direction));
    if (!Number.isFinite(from) || !Number.isFinite(step) || step === 0) return null;
    if (from < 0 || from >= list.length) return null;
    const to = from + (step > 0 ? 1 : -1);
    if (to < 0 || to >= list.length) return null;
    const volumeAt = typeof volumeOf === 'function' ? volumeOf : () => null;
    if (volumeAt(list[from]) !== volumeAt(list[to])) return null;
    return { kind: 'index', toIndex: to };
  }

  function createDragSortUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createDragSortUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) {
        throw new TypeError('createDragSortUi 的 host 缺少 ' + key);
      }
    }
    const { $, api, call, chapterVolumeId, renderChapterList, renderEditorHeader, state, toast, updateStatus, volumeDisplayName } = host;
  // ---------- 章节拖拽排序 ----------
  // 只改 书目.json 的顺序，章节文件永不重命名；拖拽用 pointer 事件（比 HTML5 DnD 好测、也不挑渲染层）。
  let chapterDrag = null;

  function startChapterDrag(event, index) {
    if (event.button !== 0) return;
    if (state.saving || state.loading || !state.bookPath) return;
    if (state.chapters.length < 2) return;
    chapterDrag = {
      index,
      volumeId: chapterVolumeId(state.chapters[index]),
      startY: event.clientY,
      active: false,
      targetIndex: index,
      drop: null,
      item: event.currentTarget
    };
  }

  function clearDragMarks() {
    const list = $('chapter-list');
    if (!list) return;
    list.querySelectorAll('.chapter-item.dragging, .chapter-item.drop-before, .chapter-item.drop-after, .volume-item.drop-into')
      .forEach((el) => el.classList.remove('dragging', 'drop-before', 'drop-after', 'drop-into'));
    document.body.classList.remove('chapter-dragging');
  }

  // 拖拽落点：可以落在章节条目上（插到它前/后），也可以落在卷标题上（放进这一卷）
  function computeDropTarget(event) {
    const list = $('chapter-list');
    const children = Array.from(list.children);
    if (!children.length) return null;
    const y = event.clientY;
    let hovered = null;
    for (const el of children) {
      const rect = el.getBoundingClientRect();
      if (y >= rect.top && y <= rect.bottom) {
        hovered = el;
        break;
      }
    }
    const chapterOf = (el) => (el && el.classList.contains('chapter-item') ? state.chapters[Number(el.dataset.index)] : null);
    if (!hovered) {
      // 指针在列表末尾之后：落到最后一组的末尾
      for (let i = children.length - 1; i >= 0; i -= 1) {
        const el = children[i];
        const chapter = chapterOf(el);
        if (chapter) return { volumeId: chapterVolumeId(chapter), beforeChapterId: null, el, mode: 'after' };
        if (el.classList.contains('volume-item')) {
          return { volumeId: el.dataset.volumeId || null, beforeChapterId: null, el, mode: 'header' };
        }
      }
      return null;
    }
    if (hovered.classList.contains('volume-item')) {
      const volumeId = hovered.dataset.volumeId || null;
      const start = children.indexOf(hovered);
      let before = null;
      for (let i = start + 1; i < children.length; i += 1) {
        const el = children[i];
        if (el.classList.contains('volume-item')) break;
        const chapter = chapterOf(el);
        if (chapter) {
          before = chapter;
          break;
        }
      }
      return { volumeId, beforeChapterId: before ? before.id : null, el: hovered, mode: 'header' };
    }
    const chapter = chapterOf(hovered);
    if (!chapter) return null;
    const volumeId = chapterVolumeId(chapter);
    const rect = hovered.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) {
      return { volumeId, beforeChapterId: chapter.id, el: hovered, mode: 'before' };
    }
    const start = children.indexOf(hovered);
    let next = null;
    for (let i = start + 1; i < children.length; i += 1) {
      const el = children[i];
      if (el.classList.contains('volume-item')) break;
      const candidate = chapterOf(el);
      if (candidate) {
        if (chapterVolumeId(candidate) === volumeId) next = candidate;
        break;
      }
    }
    return { volumeId, beforeChapterId: next ? next.id : null, el: hovered, mode: 'after' };
  }

  function nextChapterIdInVolume(chapter) {
    const volumeId = chapterVolumeId(chapter);
    const index = state.chapters.findIndex((c) => c.id === chapter.id);
    for (let i = index + 1; i < state.chapters.length; i += 1) {
      if (chapterVolumeId(state.chapters[i]) !== volumeId) return null;
      return state.chapters[i].id;
    }
    return null;
  }

  function updateChapterDrag(event) {
    if (!chapterDrag) return;
    if (!chapterDrag.active) {
      if (Math.abs(event.clientY - chapterDrag.startY) < 5) return;
      chapterDrag.active = true;
      chapterDrag.item.classList.add('dragging');
      document.body.classList.add('chapter-dragging');
    }
    const list = $('chapter-list');
    list.querySelectorAll('.chapter-item.drop-before, .chapter-item.drop-after, .volume-item.drop-into')
      .forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-into'));

    const target = computeDropTarget(event);
    chapterDrag.drop = target;
    if (target && target.el) {
      if (target.mode === 'header') target.el.classList.add('drop-into');
      else if (target.mode === 'before') target.el.classList.add('drop-before');
      else target.el.classList.add('drop-after');
    }

    // 拖动到列表顶部/底部附近时自动滚动
    const listRect = list.getBoundingClientRect();
    if (event.clientY < listRect.top + 28) list.scrollTop -= 12;
    else if (event.clientY > listRect.bottom - 28) list.scrollTop += 12;
  }

  async function endChapterDrag() {
    if (!chapterDrag) return;
    const drag = chapterDrag;
    chapterDrag = null;
    clearDragMarks();
    if (!drag.active) return; // 普通点击，交给 click 处理
    state.suppressChapterClick = Date.now() + 300;
    const chapter = state.chapters[drag.index];
    const target = drag.drop;
    if (!chapter || !target) return;
    // 原地不动就不写盘：落在自己身上、或落回自己原来的位置
    if (target.beforeChapterId === chapter.id) return;
    if (target.volumeId === chapterVolumeId(chapter) && target.beforeChapterId === nextChapterIdInVolume(chapter)) return;
    await moveChapterByDrop(chapter, target);
  }

  async function moveChapterByDrop(chapter, target) {
    const currentId = (state.chapters[state.index] || {}).id;
    try {
      const data = await call(
        api.moveChapterTo,
        state.bookPath,
        chapter.id,
        target.volumeId || null,
        target.beforeChapterId || null
      );
      state.meta = data.meta;
      state.chapters = data.meta.chapters;
      if (currentId) {
        const at = state.chapters.findIndex((c) => c.id === currentId);
        if (at >= 0) state.index = at;
      }
      renderChapterList();
      renderEditorHeader();
      updateStatus();
      toast(`已移动章节（${target.volumeId ? volumeDisplayName(target.volumeId) : '未分卷'}）`);
      if (currentId) {
        try {
          const currentChapter = state.chapters.find((c) => c.id === currentId);
          // B1（审计 E6）：走统一 call()，失败才真的进这个 catch（裸 await api.* 时 preload 回
          // {ok:false} 不抛错，这里的兜底等于没写）
          await call(api.setLastOpenChapter, state.bookPath, currentId, {
            title: state.meta && state.meta.title,
            chapterIndex: state.index,
            chapterName: currentChapter ? currentChapter.name : ''
          });
        } catch {
          /* 记不住也无所谓 */
        }
      }
      return { ok: true };
    } catch (err) {
      toast(`移动章节失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  async function moveChapterByDrag(fromIndex, toIndex) {
    const chapter = state.chapters[fromIndex];
    if (!chapter || fromIndex === toIndex) return;
    const currentId = (state.chapters[state.index] || {}).id;
    try {
      const data = await call(api.moveChapter, state.bookPath, chapter.id, toIndex);
      state.chapters = data.meta.chapters;
      state.meta = { ...state.meta, chapters: data.meta.chapters, updatedAt: data.meta.updatedAt };
      const newCurrent = currentId ? state.chapters.findIndex((c) => c.id === currentId) : -1;
      if (newCurrent >= 0) state.index = newCurrent;
      renderChapterList();
      renderEditorHeader();
      updateStatus();
      toast(`已移动章节：第${data.from + 1}章 → 第${data.to + 1}章（章节文件没有改名）`);
      if (currentId) {
        try {
          const currentChapter = state.chapters.find((c) => c.id === currentId);
          // B1（审计 E6）：同上，统一 call()（失败会被下面的 catch 接住，不再被悄悄丢掉）
          await call(api.setLastOpenChapter, state.bookPath, currentId, {
            title: state.meta && state.meta.title,
            chapterIndex: state.index,
            chapterName: currentChapter ? currentChapter.name : ''
          });
        } catch { /* 记不住也无所谓 */ }
      }
    } catch (err) {
      toast(`移动章节失败：${err.message}`, 'error');
    }
  }

  function setupChapterDrag() {
    window.addEventListener('pointermove', (event) => {
      if (chapterDrag) updateChapterDrag(event);
    });
    window.addEventListener('pointerup', () => {
      if (chapterDrag) endChapterDrag();
    });
    window.addEventListener('pointercancel', () => clearDragMarks());
  }
    return {
      setupChapterDrag,
      startChapterDrag,
      computeDropTarget,
      moveChapterByDrag,
      moveChapterByDrop
    };
  }

  return { create: createDragSortUi, REQUIRED_HOST, stepMoveTarget };
});
