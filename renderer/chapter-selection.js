/* 章节多选的**选择模型**（1.5.0 功能-1：章节多选 + 批量动作）——纯逻辑，不碰 DOM、不碰 IPC。
 *
 * 为什么单独一个模块：多选的四种点法（普通单击 / Ctrl+单击 / Shift+单击 / 点空白或 Esc 清空）
 * 和「anchor 失效回落到当前章」全是纯计算，塞进 renderer.js 只能靠 E2E 撞；这里可以在 Node 里
 * 逐个断言。渲染层只负责把 click 事件翻译成「调哪个函数、传哪份章节 id 顺序」，然后照返回值
 * 改 state / 重画高亮。
 *
 * 模型：{ ids: Set<string>, anchorId: string|null }
 *   · ids       已选章节 id（String；章节目录里的 chapter.id 本来就是短字符串）
 *   · anchorId  上一次单击的章（Ctrl / Shift / 普通单击都会更新），Shift 连选的起点；
 *               它**不要求**仍在 ids 里（Ctrl 再点一下取消选中时，起点仍是那一章，和资源管理器一致）。
 *
 * 四个函数都是**纯函数**：不改入参、返回新对象（ids 也是新的 Set），渲染层可以放心把旧值丢掉。
 *   toggle(selection, id)                               Ctrl+单击：切换这一章，anchor 移到它
 *   extendTo(selection, order, targetId, fallbackAnchorId)
 *                                                       Shift+单击：从 anchor 连到 target；anchor 不在
 *                                                       order 里（那一章被删了 / 换书了）就用
 *                                                       fallbackAnchorId（当前章），再不行只选 target
 *   clear()                                             点空白 / Esc：空集合
 *   isSelected(selection, id)                           只读判断
 * 1.6.0 F1 键盘多选二期（仍零 DOM）：
 *   selectAll(order)                                    Ctrl+A：全选这一串，anchor 落第一条
 *   moveFocus(order, focusId, step)                     ↑/↓ 该把焦点挪到哪一章（两端夹住）
 *   extendFocus(selection, order, focusId, step, …)     Shift+↑/↓：挪一格 + 从 anchor 并集扩选，
 *                                                       返回 { ids, anchorId, focusId }
 *
 * 另外给渲染层两个小工具：
 *   prune(selection, order)                             章节数组变了以后丢掉已不存在的 id（anchor 也清）
 *   idsInOrder(selection, order)                        按**目录顺序**（不是点击顺序）列出已选 id，
 *                                                       批量动作（删除 / 导出 / 复制）统一用它排序
 *
 * 「连选」是**并集**：Ctrl 点出来的几章 + Shift 拉一段，不会互相清掉（批量操作时更不容易误删）；
 * Shift 再点一次仍从同一个 anchor 起算，范围可以来回拉。
 *
 * 浏览器里挂成全局 CWChapterSelection（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWChapterSelection = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 章节 id 在书目里是短字符串；这里统一成 String，避免「点出来的 '12'」和「数组里的 12」对不上。
  // 空串 / null / undefined / 对象一律当无效（不猜，也不会把 '[object Object]' 塞进 Set）。
  function normalizeId(value) {
    if (typeof value === 'string') return value === '' ? null : value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return null;
  }

  function normalizeOrder(order) {
    if (!Array.isArray(order)) return [];
    const out = [];
    for (const item of order) {
      const id = normalizeId(item);
      if (id !== null && out.indexOf(id) < 0) out.push(id);
    }
    return out;
  }

  // 任何输入（含 null / 坏形状）都归一成一份新的 { ids, anchorId }；渲染层不用到处判空。
  function normalizeSelection(selection) {
    const ids = new Set();
    let anchorId = null;
    if (selection && typeof selection === 'object') {
      if (selection.ids && typeof selection.ids.forEach === 'function') {
        selection.ids.forEach((value) => {
          const id = normalizeId(value);
          if (id !== null) ids.add(id);
        });
      }
      anchorId = normalizeId(selection.anchorId);
    }
    return { ids, anchorId };
  }

  function createSelection(anchorId) {
    return { ids: new Set(), anchorId: normalizeId(anchorId) };
  }

  function isSelected(selection, id) {
    const key = normalizeId(id);
    if (key === null) return false;
    return Boolean(selection && selection.ids && typeof selection.ids.has === 'function' && selection.ids.has(key));
  }

  function count(selection) {
    return selection && selection.ids && typeof selection.ids.size === 'number' ? selection.ids.size : 0;
  }

  // Ctrl+单击：这一章没选中就加进去、已选中就移出来；不管加还是移，anchor 都落到这一章
  // （之后 Shift 从这个位置起算）。无效 id 原样返回，不制造空 anchor。
  function toggle(selection, id) {
    const next = normalizeSelection(selection);
    const key = normalizeId(id);
    if (key === null) return next;
    if (next.ids.has(key)) next.ids.delete(key);
    else next.ids.add(key);
    next.anchorId = key;
    return next;
  }

  // anchor 的解析：selection.anchorId 仍在 order 里就用它；否则用调用方给的 fallbackAnchorId
  // （渲染层传「当前章」）——这就是「anchor 失效回落到当前章」。都没有返回 null。
  function resolveAnchor(selection, order, fallbackAnchorId) {
    const list = normalizeOrder(order);
    const anchor = selection ? normalizeId(selection.anchorId) : null;
    if (anchor !== null && list.indexOf(anchor) >= 0) return anchor;
    const fallback = normalizeId(fallbackAnchorId);
    if (fallback !== null && list.indexOf(fallback) >= 0) return fallback;
    return null;
  }

  // Shift+单击：从 anchor 到 target 的范围并进已选集合（并集），返回的 anchor 仍是解析后的起点
  // （不是 target）——再按一次 Shift+单击可以从同一个起点重新拉范围。
  function extendTo(selection, order, targetId, fallbackAnchorId) {
    const next = normalizeSelection(selection);
    const list = normalizeOrder(order);
    const target = normalizeId(targetId);
    const targetAt = target === null ? -1 : list.indexOf(target);
    if (targetAt < 0) return next;
    const anchor = resolveAnchor(selection, list, fallbackAnchorId);
    const anchorAt = anchor === null ? -1 : list.indexOf(anchor);
    if (anchorAt < 0) {
      // 起点和当前章都不在章节数组里：只选目标这一条，anchor 也落到它（下一次能继续拉）
      next.ids.add(target);
      next.anchorId = target;
      return next;
    }
    const from = Math.min(anchorAt, targetAt);
    const to = Math.max(anchorAt, targetAt);
    for (let i = from; i <= to; i += 1) next.ids.add(list[i]);
    next.anchorId = anchor;
    return next;
  }

  function clear() {
    return { ids: new Set(), anchorId: null };
  }

  // 章节数组换了（保存后重建 / 删章 / 换书）以后收口：已不在 order 里的 id 丢掉；
  // 一个都不剩时 anchor 也清掉（不把一个指向已删章的起点留给下一次 Shift）。
  function prune(selection, order) {
    const list = normalizeOrder(order);
    const present = new Set(list);
    const next = normalizeSelection(selection);
    for (const id of Array.from(next.ids)) {
      if (!present.has(id)) next.ids.delete(id);
    }
    if (!next.ids.size) next.anchorId = null;
    else if (next.anchorId !== null && !present.has(next.anchorId)) next.anchorId = null;
    return next;
  }

  // 按目录顺序（不是点击顺序）列已选 id：批量删除 / 导出 / 复制统一用这个顺序，
  // 作者怎么点的都不影响结果。
  function idsInOrder(selection, order) {
    const selected = selection && selection.ids;
    if (!selected || typeof selected.has !== 'function' || !selected.size) return [];
    return normalizeOrder(order).filter((id) => selected.has(id));
  }

  // Ctrl+A（1.6.0 F1）：把「列表里这一串」全选，anchor 落到第一条——之后再按 Shift+↓ 还有起点。
  // 传进来的 order 由渲染层按**当前渲染出来的行**给（筛选 / 折叠时只全选看得见的那几章，
  // 和文件管理器一致）。空目录 / 坏输入返回空选择，不抛。
  function selectAll(order) {
    const list = normalizeOrder(order);
    return { ids: new Set(list), anchorId: list.length ? list[0] : null };
  }

  // ↑/↓（1.6.0 F1）该把焦点挪到哪一章：一次挪 step 格、两端夹住不绕回。
  // 焦点章不在目录里（筛选 / 折叠后那一行没了）返回 null——调用方当「没这回事」，
  // 不猜它原本在哪，也不顺手跳到第一行。
  function moveFocus(order, focusId, step) {
    const list = normalizeOrder(order);
    const focus = normalizeId(focusId);
    const at = focus === null ? -1 : list.indexOf(focus);
    if (at < 0) return null;
    const delta = Math.trunc(Number(step));
    if (!Number.isFinite(delta) || delta === 0) return list[at];
    return list[Math.min(list.length - 1, Math.max(0, at + delta))];
  }

  // Shift+↑/↓（1.6.0 F1）：焦点挪一格 + 把 anchor 到新焦点的范围并进选择（与鼠标 Shift 连选
  // 同一口径，并集、不误删）。返回 { ids, anchorId, focusId }：
  //   · focusId 是焦点该落到的那一章（DOM 焦点仍由 list-keyboard 的 roving tabindex 挪）；
  //   · 首按时选择里还没有 anchor（或 anchor 已失效），起点用**按下 Shift 前焦点那一章**
  //     （fallbackAnchorId，没给就用 focusId），不是正在写的当前章——键盘用户按的是看到的那行。
  // 焦点已经到头（挪不动）时返回原选择 + 原 focusId，不制造越界 id。
  function extendFocus(selection, order, focusId, step, fallbackAnchorId) {
    const next = normalizeSelection(selection);
    const focus = normalizeId(focusId);
    const target = moveFocus(order, focus, step);
    if (target === null) return { ids: next.ids, anchorId: next.anchorId, focusId: null };
    const anchorFallback = normalizeId(fallbackAnchorId) || focus;
    const extended = extendTo(next, order, target, anchorFallback);
    return { ids: extended.ids, anchorId: extended.anchorId, focusId: target };
  }

  return {
    createSelection,
    toggle,
    extendTo,
    clear,
    isSelected,
    count,
    resolveAnchor,
    prune,
    idsInOrder,
    selectAll,
    moveFocus,
    extendFocus
  };
});