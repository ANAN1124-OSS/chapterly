// 键盘可达（v0.9 A-5b）：章节列表与书架书卡的「Tab 可达 + Enter / 空格激活 + 方向键移焦点」。
//
// 以前章节条目与书卡都是普通 <div>（tabIndex -1）：只用键盘时能 Tab 到书卡右上角的「⋯」，
// 却打不开书；能 Tab 到顶栏，却切不了章。这个模块只补「键盘」这一条通道——所有处理都挂在
// 容器的 keydown 上，不碰 click / dblclick / contextmenu / pointerdown，鼠标与拖拽行为一个字不改。
//
// 两个列表都用 roving tabindex：整张列表只有「当前章 / 当前这张卡」一个 Tab 停留点，方向键在
// 列表内移动焦点、Tab 直接跳出列表（1000 章的书不会变成 1000 个 Tab 站）。
//
// 纯逻辑（isActivateKey / nextIndex / keyAction / applyTabStops）与 DOM 接线分开，
// 前者可在 Node 里逐个断言；后者只做「找条目 → 调纯逻辑 → 改焦点与 tabIndex」。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CWListKeyboard = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // 空格在旧 Chromium / 某些输入法里报 'Spacebar'，两个都认
  const ACTIVATE_KEYS = ['Enter', ' ', 'Spacebar'];
  const PREV_KEYS = ['ArrowUp', 'ArrowLeft'];
  const NEXT_KEYS = ['ArrowDown', 'ArrowRight'];

  function isActivateKey(key) {
    return ACTIVATE_KEYS.indexOf(key) >= 0;
  }

  // 焦点在列表里的第 position 个条目时按 key，应该落到第几个条目（夹在 0..count-1）。
  // 不认识的键、空列表、非数字 count 一律返回 null（调用方就当没这回事，别 preventDefault）。
  function nextIndex(position, key, count) {
    if (!Number.isFinite(count) || count <= 0) return null;
    const last = count - 1;
    let at = Number.isFinite(position) ? Math.floor(position) : -1;
    if (at < 0 || at > last) at = 0;
    if (key === 'Home') return 0;
    if (key === 'End') return last;
    if (NEXT_KEYS.indexOf(key) >= 0) return Math.min(last, at + 1);
    if (PREV_KEYS.indexOf(key) >= 0) return Math.max(0, at - 1);
    return null;
  }

  // 网格（书架书卡）：焦点在第 position 张卡、网格有 columns 列时按 key 该落到第几张。
  // 与 nextIndex 的差别只有「换行」：←/→ 不出当前行（到行首 / 行尾就停住），↑/↓ 按列数跨行，
  // Home / End 走「本行首 / 本行尾」。
  // 上下到边也**停住**（不夹到 0 / 最后一张）：第一行按 ↑ 若夹到 0 会从第 3 列跳到第 1 列，
  // 最后一行不满时按 ↓ 夹到 last 同样是斜着跳 —— 网格里保持「同一列上下」更可预期。
  // columns 不是 >1 的数时退化为 1 列（等价于 nextIndex 的 ↑/↓ 语义，Home/End 也按行算）。
  function nextGridIndex(position, key, count, columns) {
    if (!Number.isFinite(count) || count <= 0) return null;
    const cols = Number.isFinite(columns) && columns > 1 ? Math.floor(columns) : 1;
    const last = count - 1;
    let at = Number.isFinite(position) ? Math.floor(position) : 0;
    if (at < 0 || at > last) at = 0;
    const rowStart = at - (at % cols);
    const rowEnd = Math.min(last, rowStart + cols - 1);
    if (key === 'Home') return rowStart;
    if (key === 'End') return rowEnd;
    if (key === 'ArrowLeft') return Math.max(rowStart, at - 1);
    if (key === 'ArrowRight') return Math.min(rowEnd, at + 1);
    if (key === 'ArrowUp') return at - cols >= 0 ? at - cols : at;
    if (key === 'ArrowDown') return at + cols <= last ? at + cols : at;
    return null;
  }

  // 一次按键的「计划」：{ type: 'activate' } / { type: 'move', index } / { type: 'delete', index } / null。
  // 带 Ctrl / Alt / Meta / Shift 的一律不管：那些组合有自己的含义（选中、跳词、系统快捷键），
  // 列表不该半路接管。
  // options.columns > 1 时方向键 / Home / End 走网格版（书架书卡）；否则一字不差地走原来的
  // nextIndex（章节列表是单列，行为不许变）。
  // options.allowDelete 只在章节列表打开（U-D9）：Delete = 删焦点所在这一条；书架书卡没有
  // 删除语义，不传就一个键都不碰。
  function keyAction(event, position, count, options) {
    if (!event || typeof event.key !== 'string') return null;
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return null;
    if (isActivateKey(event.key)) return { type: 'activate', index: position };
    if (event.key === 'Delete' && options && options.allowDelete) return { type: 'delete', index: position };
    const columns = options ? Number(options.columns) : 1;
    const index = Number.isFinite(columns) && columns > 1
      ? nextGridIndex(position, event.key, count, columns)
      : nextIndex(position, event.key, count);
    return index === null ? null : { type: 'move', index };
  }

  // 写作页切章（v0.13 U-D12）：Ctrl+PageUp / Ctrl+PageDown = 上一章 / 下一章。
  // 这里只算「该切到第几章」，不碰保存与 DOM：首章 PageUp / 末章 PageDown、坏下标、空书、
  // 不认识的键一律 -1（调用方当没这回事——不切章、不提示、也不绕回）。
  // 真正的切章仍走 shelf-ui 唯一的 switchChapter（未保存询问 / 保存 / 读盘都在里面）。
  function chapterSwitchTarget(index, key, count) {
    if (!Number.isFinite(count) || count <= 0) return -1;
    const step = key === 'PageUp' ? -1 : key === 'PageDown' ? 1 : 0;
    if (!step) return -1;
    const at = Number.isFinite(index) ? Math.floor(index) : -1;
    if (at < 0 || at >= count) return -1;
    const next = at + step;
    return next >= 0 && next < count ? next : -1;
  }

  // roving tabindex：只有 activeIndex 那一个是 0，其余 -1。越界的 activeIndex 落到第一个。
  function applyTabStops(items, activeIndex) {
    const list = Array.isArray(items) ? items : Array.from(items || []);
    if (!list.length) return 0;
    const want = Number.isFinite(activeIndex) && activeIndex >= 0 && activeIndex < list.length
      ? Math.floor(activeIndex)
      : 0;
    for (let i = 0; i < list.length; i += 1) {
      list[i].tabIndex = i === want ? 0 : -1;
    }
    return list.length;
  }

  // 当前章在折叠的卷里（列表里没这一条）时，列表会一个 tabIndex 0 都没有：
  // 把第一个条目补成 Tab 停留点，键盘至少进得来。
  function ensureTabStop(container, itemSelector) {
    if (!container || !container.querySelectorAll) return false;
    const items = Array.from(container.querySelectorAll(itemSelector));
    if (!items.length) return false;
    if (items.some((el) => el.tabIndex === 0)) return false;
    items[0].tabIndex = 0;
    return true;
  }

  // 全局 F2「重命名」的目标章（Phase D / D2）：焦点停在章节条目上就改那一条 —— 列表里的
  // 方向键只移焦点、不切章，所以「改哪一条」必须看焦点；焦点不在列表里（编辑区 / 按钮 /
  // 空白处）就改当前章。下标越界 / 不是数字 / 没有章节时回落 fallback，再不行返回 -1（不猜）。
  function renameTargetIndex(active, count, fallback) {
    const total = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    if (!total) return -1;
    const item = active && typeof active.closest === 'function' ? active.closest('#chapter-list .chapter-item') : null;
    const raw = item && item.dataset ? item.dataset.index : null;
    // 注意 Number(null) === 0：没有条目时必须先判 item，否则「焦点不在列表」会被当成第 0 条
    const focused = item ? Number(raw) : NaN;
    if (Number.isFinite(focused) && focused >= 0 && focused < total) return Math.floor(focused);
    const at = Number.isFinite(fallback) ? Math.floor(fallback) : -1;
    return at >= 0 && at < total ? at : -1;
  }

  // F2 只该在「不在别的输入框里」时生效：编辑区自己是 textarea（欢迎 F2），但查找 / 跳章 /
  // 碎片 / 设置里的输入框、下拉框有自己的按键语义，不能被全局快捷键抢走。
  function isTypingTarget(active, editorEl) {
    if (!active) return false;
    const tag = String(active.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'SELECT') return true;
    return tag === 'TEXTAREA' && active !== editorEl;
  }

  // 容器事件委托：Tab 到条目上之后，Enter / 空格激活；arrows 为真时方向键 / Home / End 移焦点。
  // activate 只在**条目自己被聚焦**时触发（卡片里还套着「⋯」按钮，按 Enter 该走它自己的点击）。
  // columns（数字或 () => 当前列数）只在 arrows 为真时生效：>1 走网格版方向键（书架书卡），
  // 每次按键现算，所以窗口 resize / 响应式换列会自动跟随。
  function install(options) {
    const opts = options || {};
    const container = opts.container;
    const itemSelector = opts.itemSelector || '.item';
    if (!container || !container.addEventListener) return { destroy() {} };
    const itemsOf = () => Array.from(container.querySelectorAll(itemSelector));
    const resolveColumns = () => {
      let raw;
      try {
        raw = typeof opts.columns === 'function' ? opts.columns() : opts.columns;
      } catch {
        return 1;
      }
      const n = Math.floor(Number(raw));
      return Number.isFinite(n) && n > 0 ? n : 1;
    };
    const handler = (event) => {
      const item = event.target && event.target.closest ? event.target.closest(itemSelector) : null;
      if (!item || !container.contains(item)) return;
      const items = itemsOf();
      const position = items.indexOf(item);
      if (position < 0) return;
      // Alt+↑/↓（Phase D / D1）：列表自己接管「在本卷内上移 / 下移这一章」，并拦住冒泡，
      // 不能再落到 document 上触发段落导航。没装 onAltMove（书架书卡）时照旧不管。
      if (event.altKey) {
        const direction = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
        if (direction && typeof opts.onAltMove === 'function' && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
          event.preventDefault();
          if (typeof event.stopPropagation === 'function') event.stopPropagation();
          opts.onAltMove(item, position, direction);
        }
        return;
      }
      const columns = opts.arrows ? resolveColumns() : 1;
      const action = keyAction(event, position, items.length, { columns, allowDelete: Boolean(opts.allowDelete) });
      if (!action) return;
      if (action.type === 'delete') {
        // U-D9：只有「条目自己被聚焦」+ 宿主提供了 onDelete（章节列表）才接管删除键。
        // 没提供就当没这回事：既不 preventDefault，也不吞键（书架书卡的 Delete 一个字都不碰）。
        if (event.target !== item || typeof opts.onDelete !== 'function') return;
        event.preventDefault();
        opts.onDelete(item, position);
        return;
      }
      if (action.type === 'activate') {
        // 焦点在条目里的按钮上（例如书卡里的「⋯」）：这一下完全交给它自己，
        // 连 preventDefault 都不做——否则按钮的默认激活（Enter / 空格触发 click）会被拦掉。
        if (event.target !== item) return;
        event.preventDefault();
        if (typeof opts.onActivate === 'function') opts.onActivate(item, position);
        return;
      }
      if (!opts.arrows) return;
      const target = items[action.index];
      if (!target || target === item) return;
      event.preventDefault();
      applyTabStops(items, action.index);
      if (typeof target.focus === 'function') target.focus();
      if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'nearest' });
      if (typeof opts.onMove === 'function') opts.onMove(target, action.index);
    };
    container.addEventListener('keydown', handler);
    return {
      destroy() {
        container.removeEventListener('keydown', handler);
      }
    };
  }

  // 分卷标题行（v0.9 A-5c）：以前是普通 <div>（tabIndex -1），Tab 到不了、键盘收不起卷。
  // 这里只补「可聚焦 + Enter / 空格折叠展开 + 重建后焦点回到同一卷」：激活直接复用原来的
  // click 处理（折叠逻辑只有一份），鼠标点行照旧；列表重建时靠 MutationObserver 重新装饰。
  function installVolumeHeaders(options) {
    const opts = options || {};
    const container = opts.container;
    const rowSelector = opts.itemSelector || '.volume-item';
    const MO = opts.MutationObserver || (typeof MutationObserver === 'function' ? MutationObserver : null);
    if (!container || !container.addEventListener) return { decorate() { return 0; }, destroy() {} };

    const rowsOf = () => Array.from(container.querySelectorAll(rowSelector));
    const decorate = () => {
      const rows = rowsOf();
      for (const row of rows) {
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-expanded', row.classList.contains('collapsed') ? 'false' : 'true');
      }
      return rows.length;
    };

    // 折叠 / 展开会把整张列表重建，旧的行连同焦点一起消失：记下是哪个卷，重建后把焦点放回去。
    let pendingKey = null;
    const refocus = () => {
      if (pendingKey === null) return false;
      const key = pendingKey;
      pendingKey = null;
      const row = rowsOf().find((el) => (el.dataset ? el.dataset.volumeId || '' : '') === key);
      if (row && typeof row.focus === 'function') {
        row.focus();
        return true;
      }
      return false;
    };

    const onKeyDown = (event) => {
      if (!event || typeof event.key !== 'string') return;
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
      const row = event.target && typeof event.target.closest === 'function' ? event.target.closest(rowSelector) : null;
      if (!row || (typeof container.contains === 'function' && !container.contains(row))) return;
      if (event.preventDefault) event.preventDefault();
      pendingKey = row.dataset ? row.dataset.volumeId || '' : '';
      if (typeof row.click === 'function') row.click();
    };

    let observer = null;
    if (typeof MO === 'function') {
      observer = new MO(() => {
        decorate();
        refocus();
      });
      observer.observe(container, { childList: true });
    }
    decorate();
    container.addEventListener('keydown', onKeyDown);
    return {
      decorate,
      refocus,
      destroy() {
        container.removeEventListener('keydown', onKeyDown);
        if (observer) observer.disconnect();
      }
    };
  }

  return { isActivateKey, nextIndex, nextGridIndex, keyAction, chapterSwitchTarget, applyTabStops, ensureTabStop, renameTargetIndex, isTypingTarget, install, installVolumeHeaders };
});
