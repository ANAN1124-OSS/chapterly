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
 * 事件监听（window 的 pointermove / pointerup / pointercancel / blur）由 setupChapterDrag 一次
 * 装上，仍然是渲染层在事件绑定段调用它。1.5.0 P0-2 起章节条目的 pointerdown 由 #chapter-list
 * 容器事件委托分派（整表重建不再逐条绑），调用方把条目元素当第 3 个参数传进来：
 * startChapterDrag(event, index, itemEl) —— 省略时仍退回 event.currentTarget（老调用不变）。
 *
 * 红线不变：章节文件永不改名 / 移动；只改 书目.json 顺序；不写盘、不改正文、不改 dirty。
 * 浏览器里挂成全局 CWDragSortUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../core/assert-host').assertHost);
  } else if (root) {
    root.CWDragSortUi = factory(root.CWAssertHost && root.CWAssertHost.assertHost);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (assertHost) {
  'use strict';

  const REQUIRED_HOST = ['$', 'api', 'call', 'chapterVolumeId', 'renderChapterList', 'renderEditorHeader', 'state', 'toast', 'updateStatus', 'volumeDisplayName'];

  // 键盘上下移动（Phase D / D1）：Alt+↑/↓ 把这一章在本卷内上移 / 下移一格，等价于「拖一行」。
  // 章节数组顺序 = 界面显示顺序，且按卷分组连续（core/chapters.js 的顺序约定），所以同卷的
  // 相邻下标就是界面上的相邻两行。
  // 卷边界（卷首往上 / 卷尾往下）返回 null —— 本函数只算**同卷相邻**，不跨卷、不写盘；
  // 跨卷由渲染层 moveChapterStep 接手：它对 null 再走 chaptersLib.crossVolumeTarget + moveChapterByDrop，
  // 把这一章挪到相邻卷并登记 10 秒撤销（U-D1 的显式键盘跨卷能力）。两处注释同口径（REDT-C-07）。
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
    // A8（WP-32）：REQUIRED_HOST 逐成员校验走共享实现（文案不变）。
    assertHost('createDragSortUi', host, REQUIRED_HOST);
    const { $, api, call, chapterVolumeId, renderChapterList, renderEditorHeader, state, toast, updateStatus, volumeDisplayName } = host;
  // ---------- 章节拖拽排序 ----------
  // 只改 书目.json 的顺序，章节文件永不重命名；拖拽用 pointer 事件（比 HTML5 DnD 好测、也不挑渲染层）。
  let chapterDrag = null;
  // 审计修复 #20（P4）：拖拽行几何缓存 + 定点清标记。
  // 旧实现每次 pointermove（跟手时约每帧一次）都对 #chapter-list 的全部子节点读一遍
  // getBoundingClientRect —— 千章书就是每帧上千次布局读；落点标记也是每帧全表 querySelectorAll 清。
  // 现在一次拖拽只在「进入拖拽态」那一刻量一次几何（{ listTop, items }，top 用列表内容坐标），
  // 之后每帧只拿指针位置 + 实时 scrollTop 折算后二分查行；标记只摘掉上一次打上的那一行。
  // 缓存整场有效的依据：保存 / 加载中不许起手、拖拽期间不重建章节列表，落点标记只用 box-shadow
  // 与 opacity（不改布局）；边缘自动滚动只改 scrollTop，折算时读的就是实时值。
  let dragMarkEl = null;

  // C38：拖到列表顶部 / 底部边缘时，以前只在 pointermove 那一拍滚 12px——指针停在边缘不动就
  // 不滚，长列表拖不到底。现在进入边缘区先滚一拍（保持原来「一进边缘立刻有反应」的手感），
  // 再起一个 16ms 的持续滚动；指针离开边缘 / 松手 / 系统打断都立刻停。
  const EDGE_ZONE = 28;
  const EDGE_STEP = 12;
  const EDGE_INTERVAL_MS = 16;
  let edgeScroll = null; // { dir: -1|1, lastY, timer }

  function stopEdgeScroll() {
    if (!edgeScroll) return false;
    clearInterval(edgeScroll.timer);
    edgeScroll = null;
    return true;
  }

  function startEdgeScroll(dir, clientY) {
    const want = dir < 0 ? -1 : 1;
    if (edgeScroll && edgeScroll.dir === want) {
      edgeScroll.lastY = clientY;
      return edgeScroll;
    }
    stopEdgeScroll();
    edgeScroll = { dir: want, lastY: clientY, timer: setInterval(edgeScrollTick, EDGE_INTERVAL_MS) };
    return edgeScroll;
  }

  function edgeScrollTick() {
    if (!chapterDrag || !edgeScroll) return stopEdgeScroll();
    const list = $('chapter-list');
    if (!list) return stopEdgeScroll();
    list.scrollTop += edgeScroll.dir * EDGE_STEP;
    // 列表滚了、指针没动：指针下面换了一条章节，落点标记要跟着重算（不然松开时落错位置）
    if (Number.isFinite(edgeScroll.lastY)) updateDragTarget(edgeScroll.lastY);
    return true;
  }

  function startChapterDrag(event, index, itemEl) {
    if (event.button !== 0) return;
    if (state.saving || state.loading || !state.bookPath) return;
    if (state.chapters.length < 2) return;
    stopEdgeScroll(); // C38：上一次拖拽若没走完收手流程，别把旧定时器带进这次
    // 审计修复 #2（E2）：起手时把「是哪本书的哪一章」一起记下来。拖拽是异步结算的
    // （pointerup 之后还要等 IPC 回包），在途切书 / 切章时不能再拿旧下标去套新列表。
    // 委托后 event.currentTarget 是 #chapter-list 容器；由调用方显式给条目元素
    const item = itemEl || event.currentTarget;
    chapterDrag = {
      index,
      chapterId: (state.chapters[index] || {}).id,
      bookPath: state.bookPath,
      volumeId: chapterVolumeId(state.chapters[index]),
      startY: event.clientY,
      active: false,
      targetIndex: index,
      drop: null,
      // 审计修复 #20（P4）：进入拖拽态时量一次的行几何（{ listTop, items }），跟手阶段只读它
      geometry: null,
      item,
      // 五-M22（ES-1）：记住起手的 pointerId。没有指针捕获时，把指针拖出窗口再松手，Chromium
      // 不会把 pointerup 派给本窗口（pointercancel 也不触发）——chapterDrag 以 active=true 残留，
      // 回窗后的第一帧 move 甚至任意一次普通 pointerup 就会按幽灵落点 moveChapterTo 改写书目。
      // 起手就 setPointerCapture，让窗口外的松手也回到这里结算；pointerId 用于拒别的指针。
      pointerId: Number.isFinite(event.pointerId) ? event.pointerId : null
    };
    if (chapterDrag.pointerId != null && item && typeof item.setPointerCapture === 'function') {
      try {
        item.setPointerCapture(chapterDrag.pointerId);
      } catch {
        /* 元素已 detach / 浏览器不支持：取消路径（blur / pointercancel）仍会兜底清状态 */
      }
    }
  }

  // 五-M22（ES-1）：释放起手时的指针捕获（收手 / 取消都走这里；已自动释放时 release 会抛，忽略）。
  function releaseChapterDragCapture(drag) {
    if (!drag || drag.pointerId == null || !drag.item) return;
    if (typeof drag.item.releasePointerCapture !== 'function') return;
    try {
      drag.item.releasePointerCapture(drag.pointerId);
    } catch {
      /* 已经自动释放 / 元素已 detach：没有副作用要处理 */
    }
  }

  // 五-M22（ES-1）：取消拖拽（系统打断 / 失焦 / 主键已松开）。与 endChapterDrag 不同：
  // 这不是「收手」，绝不结算落点、也不设 suppressChapterClick（否则紧随其后的点击被吞 300ms）。
  function cancelChapterDrag() {
    stopEdgeScroll();
    const drag = chapterDrag;
    chapterDrag = null;
    releaseChapterDragCapture(drag);
    clearDragMarks();
  }

  function clearDragMarks() {
    const list = $('chapter-list');
    if (!list) return;
    // 整表清扫只留在这里（收手 / 系统打断各一次）：拖拽跟手期间的清标记走 dragMarkEl 定点清理。
    list.querySelectorAll('.chapter-item.dragging, .chapter-item.drop-before, .chapter-item.drop-after, .volume-item.drop-into')
      .forEach((el) => el.classList.remove('dragging', 'drop-before', 'drop-after', 'drop-into'));
    dragMarkEl = null;
    document.body.classList.remove('chapter-dragging');
  }

  // 审计修复 #20（P4）：量一次列表几何。top 统一折算成「列表内容坐标」（含当时的 scrollTop），
  // 之后指针位置也按同一个坐标折算，滚动只影响折算值、不用重新量行。
  function captureDragGeometry() {
    const list = $('chapter-list');
    if (!list) return null;
    const listRect = list.getBoundingClientRect();
    const scrollTop = Number(list.scrollTop) || 0;
    const items = Array.from(list.children).map((el) => {
      const rect = el.getBoundingClientRect();
      return { el, top: rect.top - listRect.top + scrollTop, height: rect.height };
    });
    return { listTop: listRect.top, items };
  }

  // 审计残留修复 #20（P4）：缓存失效判据。拖拽期间窗口尺寸变化（行高 / 列表位置变了，见 resize
  // 监听）或列表被重建（筛选 / 外部刷新）时，按旧几何算落点会把章插到错位置（或落在已 detach 的
  // 行上）。这里用 DOM 上可观察的两件事判定：行集合是否仍与列表当前子节点一一对应、行还在不在文档里。
  function geometryIsCurrent(geometry, list) {
    if (!geometry || !list) return false;
    const items = geometry.items;
    if (items.length !== list.children.length) return false;
    for (let i = 0; i < items.length; i += 1) {
      const row = items[i];
      if (row.el !== list.children[i]) return false;
      if (typeof row.el.isConnected === 'boolean' && !row.el.isConnected) return false;
    }
    return true;
  }

  // 拖拽中取几何：缓存仍有效就复用（跟手零 rect 读）；列表重建 / resize 后现量一次（只多一次）。
  // 直接调用 computeDropTarget（单测 / 测试钩子）没有拖拽活状态时现量一次，语义与搬前一致。
  function dragGeometryFor(list) {
    if (!chapterDrag) return captureDragGeometry();
    if (!geometryIsCurrent(chapterDrag.geometry, list)) chapterDrag.geometry = captureDragGeometry();
    return chapterDrag.geometry;
  }

  // 缓存行按文档流顺序 top 单调递增：二分找「top ≤ 指针内容坐标」的最后一行（O(log n)）。
  function rowIndexAt(items, y) {
    let lo = 0;
    let hi = items.length - 1;
    let hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (items[mid].top <= y) {
        hit = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return hit;
  }

  // 拖拽落点：可以落在章节条目上（插到它前/后），也可以落在卷标题上（放进这一卷）
  function computeDropTarget(event) {
    const list = $('chapter-list');
    if (!list) return null;
    // 拖拽中复用起手时量好的几何；直接调用（单测 / 测试钩子）没有拖拽，就现量一次，语义不变。
    // 审计残留修复 #20（P4）：拖拽期间列表被重建 / 窗口 resize 时缓存自动失效（dragGeometryFor）。
    const geometry = dragGeometryFor(list);
    if (!geometry) return null;
    const items = geometry.items;
    if (!items.length) return null;
    const count = items.length;
    const y = event.clientY - geometry.listTop + (Number(list.scrollTop) || 0);
    const hit = rowIndexAt(items, y);
    const hovered = hit >= 0 && y <= items[hit].top + items[hit].height ? items[hit].el : null;
    const chapterOf = (el) => (el && el.classList.contains('chapter-item') ? state.chapters[Number(el.dataset.index)] : null);
    // REDT-C-03（第五轮审计）：hit < 0 表示指针在首行上方（拖过列表顶边、悬在筛选输入区），
    // 旧实现与「列表末尾之后」共用同一分支，往上拖反而把章落到全书末尾。这里单独按
    // 「插到首行之前」处理：首行是章 → 插到它前面；首行是卷头 → 放进该卷开头（卷内第一章之前）。
    if (hit < 0 && items.length) {
      const first = items[0].el;
      const firstChapter = chapterOf(first);
      if (firstChapter) {
        return {
          volumeId: chapterVolumeId(firstChapter),
          beforeChapterId: firstChapter.id,
          el: first,
          mode: 'before'
        };
      }
      if (first.classList.contains('volume-item')) {
        const volumeId = first.dataset.volumeId || null;
        // 复验残留（REDT-C-02 同型）：卷头落点按全书取该卷第一章（firstChapterIdInVolume）。
        return { volumeId, beforeChapterId: firstChapterIdInVolume(volumeId), el: first, mode: 'header' };
      }
    }
    if (!hovered) {
      // 指针在列表末尾之后：落到最后一组的末尾
      for (let i = count - 1; i >= 0; i -= 1) {
        const el = items[i].el;
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
      // 复验残留（REDT-C-02 同型）：拖到卷头 = 插到该卷开头，按全书顺序取该卷第一章——
      // 筛选隐藏了卷首章时不能取「第一个可见章」，卷里一章都看不见时也不能落到卷末。
      return { volumeId, beforeChapterId: firstChapterIdInVolume(volumeId), el: hovered, mode: 'header' };
    }
    const chapter = chapterOf(hovered);
    if (!chapter) return null;
    const volumeId = chapterVolumeId(chapter);
    const top = items[hit].top;
    const height = items[hit].height;
    if (y < top + height / 2) {
      return { volumeId, beforeChapterId: chapter.id, el: hovered, mode: 'before' };
    }
    // REDT-C-02（第五轮审计）：「插到这一章之后」的落点必须来自**全书顺序**，不能从渲染行里
    // 找下一行——筛选生效时渲染行会跳过被隐藏的章，找不到就返回 null（= 卷末），落点标记与
    // 实际落点不一致。nextChapterIdInVolume 按 state.chapters 找同卷下一章（末章返回 null）。
    return { volumeId, beforeChapterId: nextChapterIdInVolume(chapter), el: hovered, mode: 'after' };
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

  // 复验残留（2026-11-22，REDT-C-02 同型）：两个卷头落点分支以前从**可见行**里找该卷第一章——
  // 筛选隐藏了卷首章时会取到后面的章、卷里一章都看不见时落到卷末。卷头语义是「插到该卷开头」，
  // 必须按全书顺序取该卷真正的第一章，落点标记与实际落点才始终一致。
  function firstChapterIdInVolume(volumeId) {
    for (const chapter of state.chapters) {
      if (chapterVolumeId(chapter) === volumeId) return chapter.id;
    }
    return null;
  }

  function updateDragTarget(clientY) {
    if (!chapterDrag) return;
    const list = $('chapter-list');
    if (!list) return;
    // 审计修复 #20（P4）：定点清标记 —— 只摘掉上一帧打上的那一行，不再整表 querySelectorAll。
    // 拖拽期间不会有人从模块外改落点标记（起手 / 收手 / cancel 各有一条完整清扫路径）。
    if (dragMarkEl) {
      dragMarkEl.classList.remove('drop-before', 'drop-after', 'drop-into');
      dragMarkEl = null;
    }

    const target = computeDropTarget({ clientY });
    chapterDrag.drop = target;
    if (target && target.el) {
      if (target.mode === 'header') target.el.classList.add('drop-into');
      else if (target.mode === 'before') target.el.classList.add('drop-before');
      else target.el.classList.add('drop-after');
      dragMarkEl = target.el;
    }
  }

  // C38：边缘自动滚动——进入上 / 下 28px 区先滚一拍（老手感），再交给持续滚动定时器。
  function updateEdgeScroll(clientY) {
    const list = $('chapter-list');
    if (!list) return stopEdgeScroll();
    const listRect = list.getBoundingClientRect();
    if (clientY < listRect.top + EDGE_ZONE) {
      list.scrollTop -= EDGE_STEP;
      startEdgeScroll(-1, clientY);
    } else if (clientY > listRect.bottom - EDGE_ZONE) {
      list.scrollTop += EDGE_STEP;
      startEdgeScroll(1, clientY);
    } else {
      stopEdgeScroll();
    }
  }

  function updateChapterDrag(event) {
    if (!chapterDrag) return;
    // 五-M22（ES-1）：主键已经松开（窗外松手后回窗的第一帧 move 就是 buttons=0）→ 这次拖拽
    // 已经没有「按着」的指针，立刻取消。旧实现不看 buttons，落点标记还会跟着悬停走，随后任意
    // 一次普通 pointerup 就按幽灵落点改写书目。buttons 缺省（老调用 / 单测）按「仍按着」处理。
    if (Number.isFinite(event.buttons) && (event.buttons & 1) === 0) {
      cancelChapterDrag();
      return;
    }
    // 别的指针的移动不许推进这次拖拽（多指触控 / 笔 + 触摸混用）
    if (
      chapterDrag.pointerId != null &&
      Number.isFinite(event.pointerId) &&
      event.pointerId !== chapterDrag.pointerId
    ) {
      return;
    }
    if (!chapterDrag.active) {
      if (Math.abs(event.clientY - chapterDrag.startY) < 5) return;
      chapterDrag.active = true;
      // 审计修复 #20（P4）：进入拖拽态才量几何（一次拖拽只量这一次），跟手阶段全部走缓存。
      chapterDrag.geometry = captureDragGeometry();
      chapterDrag.item.classList.add('dragging');
      document.body.classList.add('chapter-dragging');
    }
    updateDragTarget(event.clientY);
    // 拖动到列表顶部/底部附近时自动滚动（C38：进入边缘区后持续滚，不再依赖指针继续移动）
    updateEdgeScroll(event.clientY);
  }

  async function endChapterDrag(event) {
    stopEdgeScroll(); // C38：松手就停持续滚动（不管这次算不算有效拖拽）
    if (!chapterDrag) return;
    // 五-M22（ES-1）：只有「原拖拽指针、主键真的松开」的 pointerup 才算收手。
    // 别的 pointerId（多指抬起）或还有键按着（buttons≠0）都当成跟手杂音，忽略这一发。
    // buttons / pointerId 缺省（老调用 / 单测）保持旧行为：收到 pointerup 就结算。
    if (event && Number.isFinite(event.buttons) && event.buttons !== 0) return;
    if (
      event &&
      Number.isFinite(event.pointerId) &&
      chapterDrag.pointerId != null &&
      event.pointerId !== chapterDrag.pointerId
    ) {
      return;
    }
    const drag = chapterDrag;
    chapterDrag = null;
    releaseChapterDragCapture(drag);
    clearDragMarks();
    if (!drag.active) return; // 普通点击，交给 click 处理
    state.suppressChapterClick = Date.now() + 300;
    // 审计修复 #2（E2）：松手时书已经换了（拖拽在途切书）→ 这次拖拽作废，绝不写盘。
    if (state.bookPath !== drag.bookPath) return;
    // 按起手时记下的 chapter.id 结算；原来的那一章不在了（切章 / 删章 / 列表被重建）就不动，
    // 不用旧下标去猜现在第 N 行是谁。
    const chapter = drag.chapterId
      ? state.chapters.find((item) => item && item.id === drag.chapterId)
      : null;
    const target = drag.drop;
    if (!chapter || !target) return;
    // 原地不动就不写盘：落在自己身上、或落回自己原来的位置
    if (target.beforeChapterId === chapter.id) return;
    if (target.volumeId === chapterVolumeId(chapter) && target.beforeChapterId === nextChapterIdInVolume(chapter)) return;
    await moveChapterByDrop(chapter, target);
  }

  async function moveChapterByDrop(chapter, target) {
    // 审计修复 #2（E2）：发起前捕获身份；await 期间切书时，旧书的回包只允许丢弃，不许覆盖新书状态。
    const bookPath = state.bookPath;
    const movingId = chapter && chapter.id;
    if (!bookPath || !movingId) return { ok: false, message: '章节身份已变化，未移动' };
    try {
      const data = await call(
        api.moveChapterTo,
        bookPath,
        movingId,
        target.volumeId || null,
        target.beforeChapterId || null
      );
      // 回包到达时已经不是发起时那本书：主进程的移动已经生效在旧书上；
      // 这里绝不能把旧书 meta 写进新书的内存状态（也不 toast 误导当前窗口）。
      if (state.bookPath !== bookPath) return { ok: true, stale: true };
      // 结算时用户真正停在的那一章（await 期间可能已切章）：按 id 重新定位，不按旧下标
      const selectedId = (state.chapters[state.index] || {}).id;
      state.meta = data.meta;
      state.chapters = data.meta.chapters;
      if (selectedId) {
        const at = state.chapters.findIndex((c) => c && c.id === selectedId);
        if (at >= 0) state.index = at;
      }
      renderChapterList();
      renderEditorHeader();
      updateStatus();
      toast(`已移动章节（${target.volumeId ? volumeDisplayName(target.volumeId) : '未分卷'}）`);
      if (selectedId) {
        try {
          const currentChapter = state.chapters.find((c) => c && c.id === selectedId);
          // B1（审计 E6）：走统一 call()，失败才真的进这个 catch（裸 await api.* 时 preload 回
          // {ok:false} 不抛错，这里的兜底等于没写）
          await call(api.setLastOpenChapter, bookPath, selectedId, {
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
    // 审计修复 #2（E2）：与 moveChapterByDrop 同一套身份捕获 / 回包复核。
    const bookPath = state.bookPath;
    const movingId = chapter.id;
    if (!bookPath || !movingId) return { ok: false, message: '章节身份已变化，未移动' };
    try {
      const data = await call(api.moveChapter, bookPath, movingId, toIndex);
      if (state.bookPath !== bookPath) return { ok: true, stale: true };
      const selectedId = (state.chapters[state.index] || {}).id;
      state.chapters = data.meta.chapters;
      state.meta = { ...state.meta, chapters: data.meta.chapters, updatedAt: data.meta.updatedAt };
      const newCurrent = selectedId ? state.chapters.findIndex((c) => c && c.id === selectedId) : -1;
      if (newCurrent >= 0) state.index = newCurrent;
      renderChapterList();
      renderEditorHeader();
      updateStatus();
      toast(`已移动章节：第 ${data.from + 1} 位 → 第 ${data.to + 1} 位（章节文件没有改名）`);
      if (selectedId) {
        try {
          const currentChapter = state.chapters.find((c) => c && c.id === selectedId);
          // B1（审计 E6）：同上，统一 call()（失败会被下面的 catch 接住，不再被悄悄丢掉）
          await call(api.setLastOpenChapter, bookPath, selectedId, {
            title: state.meta && state.meta.title,
            chapterIndex: state.index,
            chapterName: currentChapter ? currentChapter.name : ''
          });
        } catch { /* 记不住也无所谓 */ }
      }
      return { ok: true };
    } catch (err) {
      toast(`移动章节失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  function setupChapterDrag() {
    // 审计残留修复 #20（P4）：拖拽期间窗口尺寸变化会让缓存的行高 / 列表位置过期 —— 作废缓存，
    // 下一次跟手现量一次（不取消拖拽，也不逐帧重量）。
    window.addEventListener('resize', () => {
      if (chapterDrag) chapterDrag.geometry = null;
    });
    window.addEventListener('pointermove', (event) => {
      if (chapterDrag) updateChapterDrag(event);
    });
    window.addEventListener('pointerup', (event) => {
      if (chapterDrag) endChapterDrag(event);
    });
    // 五-M22（ES-1）：Alt+Tab 切走窗口时指针可能还在按着（松手事件落在别的窗口）——失焦就把
    // 拖拽活状态一起取消，回窗后不会被残留态继续消费。取消不是收手，不设 suppressChapterClick。
    window.addEventListener('blur', () => {
      if (chapterDrag) cancelChapterDrag();
    });
    window.addEventListener('pointercancel', () => {
      // V24（1.6.1 R1）：系统打断拖拽（来电 / 手势 / 指针被夺走）时必须把拖拽活状态一起清掉。
      // 只清视觉标记不够：残留的 chapterDrag 会被下一次普通 pointerup 继续消费，静默 moveChapterTo 改写 书目.json。
      // 这里不走 endChapterDrag()：cancel 不是「收手」，不设 suppressChapterClick（否则紧随其后的点击被吞 300 ms）。
      cancelChapterDrag();
    });
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
