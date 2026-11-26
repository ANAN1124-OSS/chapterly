/* 命令面板的 DOM / 键盘（1.4.0 P0-3：Ctrl+K，规范 I-03）。
 *
 * 面板里「命令 / 章节 / 书混排」，键盘优先：↑↓ 移、Home/End 到头、Enter 执行、Esc 收起。
 * 检索与排序全在 renderer/command-registry.js（纯逻辑，可单测）；这里只做三件事：
 *   1. 把条目画成 role=listbox 的行（组标题 + 行尾键帽）；
 *   2. 维护 active 项（aria-activedescendant + 滚动到可视区）；
 *   3. 打开 / 关闭时把焦点交给输入框、关闭后还给打开它的元素。
 *
 * 契约：createCommandPaletteUi(host) 只调用一次；host = { $, imeGuard, registry, closeOnRun? }
 *   · host.imeGuard：ime-guard.js 的 isImeComposing（组字中的 Enter 不执行命令，WP-04 / C8 / V112）
 *   · host.registry：command-registry.js 的实例（search / recordUse）
 *   · host.items()：返回条目数组。**只在打开面板 / 调 invalidateItems() 后的下一次重画时取一次**
 *     （1.5.0 P0-6 / 审计 O-1：以前每敲一个字都重建上千条对象）；章节 / 书变了由渲染层
 *     调 invalidateItems() 作废快照，面板不必自己知道数据什么时候变。
 *   · host.onRun(item)：执行一条（由渲染层给，里面调真正的入口函数）
 *   · host.onClose()：收起后的收尾（归还焦点、清搜索）
 * 缺任何一个直接抛 TypeError（宁可在启动时炸，也不要到按 Ctrl+K 时 ReferenceError）。
 *
 * 不改数据、不写盘、不发 IPC：命令都是「调已有入口」。面板自己也不新增快捷键，
 * 只吃 Ctrl+K 与输入框里的按键（全局 Ctrl+K 的接线在 renderer.js 的 keydown 里）。
 *
 * 浏览器里挂成全局 CWCommandPaletteUi（index.html 排在 renderer.js 之前），Node 里可 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../core/assert-host').assertHost);
  } else if (root) {
    root.CWCommandPaletteUi = factory(root.CWAssertHost && root.CWAssertHost.assertHost);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (assertHost) {
  'use strict';

  const REQUIRED_HOST = ['$', 'imeGuard', 'registry', 'items', 'onRun', 'onClose'];
  const GROUP_LABELS = { command: '命令', chapter: '章节', book: '书' };
  const MAX_ROWS = 60;

  function createCommandPaletteUi(host) {
    // A8（WP-32）：REQUIRED_HOST 逐成员校验走共享实现（文案不变）。
    assertHost('createCommandPaletteUi', host, REQUIRED_HOST);
    const { $, imeGuard, registry, items, onRun, onClose } = host;
    // 测试里没有全局 document：允许 host.doc 注入（浏览器里就是真 document）
    const doc = host.doc || (typeof document !== 'undefined' ? document : null);
    let open = false;
    let rows = [];
    let active = 0;
    let opener = null;
    let bound = false;
    // 条目快照（1.5.0 P0-6 / O-1）：打开面板时取一次，输入过滤只在这个数组上跑；
    // 数据变了由渲染层调 invalidateItems() 置空，下一次重画再取。
    let itemsSnapshot = null;

    function takeItems() {
      if (itemsSnapshot !== null) return itemsSnapshot;
      const source = typeof items === 'function' ? items() : items;
      itemsSnapshot = Array.isArray(source) ? source : [];
      return itemsSnapshot;
    }

    function invalidateItems() {
      itemsSnapshot = null;
      return true;
    }

    function backdrop() {
      return $('command-backdrop');
    }

    function inputEl() {
      return $('command-input');
    }

    function listEl() {
      return $('command-list');
    }

    function emptyEl() {
      return $('command-empty');
    }

    function isOpen() {
      return open;
    }

    function visibleRows() {
      return rows;
    }

    function activeItem() {
      return rows[active] || null;
    }

    function render() {
      const list = listEl();
      if (!list) return false;
      list.textContent = '';
      const query = inputEl() ? inputEl().value : '';
      const found = registry.search(takeItems(), query);
      rows = found.slice(0, MAX_ROWS);
      // RSHE-C-07：截断要留话。千章书的空查询会被「命令 + 章节」占满 60 行，书条目整组被切掉；
      // 以前没有任何提示，作者会以为「书不在命令面板里」。列表尾补一行 muted 说明（不进 rows，
      // 键盘 / aria-activedescendant 完全不受影响）。
      const truncated = found.length > MAX_ROWS;
      if (!rows.length) {
        active = 0;
        if (emptyEl()) {
          emptyEl().textContent = query.trim() ? '没有匹配的命令 / 章节 / 书' : '没有可执行的命令';
          emptyEl().classList.remove('hidden');
        }
        if (inputEl()) inputEl().setAttribute('aria-activedescendant', '');
        return true;
      }
      if (emptyEl()) emptyEl().classList.add('hidden');
      active = Math.min(Math.max(0, active), rows.length - 1);
      let lastGroup = null;
      rows.forEach((item, index) => {
        if (item.group && item.group !== lastGroup) {
          lastGroup = item.group;
          const head = doc.createElement('div');
          head.className = 'command-group';
          head.setAttribute('role', 'presentation');
          head.textContent = GROUP_LABELS[item.group] || '其它';
          list.appendChild(head);
        }
        const row = doc.createElement('div');
        row.id = `command-option-${index}`;
        row.className = 'command-row';
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', index === active ? 'true' : 'false');
        row.dataset.index = String(index);
        row.dataset.commandId = item.id;
        if (item.group) row.dataset.group = item.group;
        const title = doc.createElement('span');
        title.className = 'command-title';
        title.textContent = item.title;
        row.appendChild(title);
        if (item.hint) {
          const hint = doc.createElement('span');
          hint.className = 'command-hint';
          hint.textContent = item.hint;
          row.appendChild(hint);
        }
        if (item.kbd) {
          const kbd = doc.createElement('span');
          kbd.className = 'kbd command-kbd';
          kbd.textContent = item.kbd;
          row.appendChild(kbd);
        }
        list.appendChild(row);
      });
      const el = inputEl();
      if (el) el.setAttribute('aria-activedescendant', `command-option-${active}`);
      // 截断说明（RSHE-C-07）：放在最后，颜色 / 字号走通用 muted small，不参与键盘选择。
      if (truncated && doc) {
        const note = doc.createElement('div');
        note.className = 'command-truncated muted small';
        note.setAttribute('role', 'presentation');
        note.textContent = `只显示前 ${MAX_ROWS} 条，输入关键词筛选`;
        list.appendChild(note);
      }
      scrollActiveIntoView();
      return true;
    }

    function scrollActiveIntoView() {
      const list = listEl();
      if (!list) return;
      const row = list.querySelector(`#command-option-${active}`);
      if (row && typeof row.scrollIntoView === 'function') {
        try {
          row.scrollIntoView({ block: 'nearest' });
        } catch {
          /* 老环境不认参数：不滚也不影响用键盘选 */
        }
      }
    }

    function setActive(next) {
      if (!rows.length) return false;
      const clamped = Math.min(Math.max(0, next), rows.length - 1);
      if (clamped === active) return false;
      active = clamped;
      const list = listEl();
      if (!list) return true;
      for (const row of Array.from(list.querySelectorAll('.command-row'))) {
        const isActive = row.dataset.index === String(active);
        row.setAttribute('aria-selected', isActive ? 'true' : 'false');
      }
      const el = inputEl();
      if (el) el.setAttribute('aria-activedescendant', `command-option-${active}`);
      scrollActiveIntoView();
      return true;
    }

    function openPalette(fromElement) {
      const bd = backdrop();
      if (!bd) return false;
      opener = fromElement && fromElement.focus ? fromElement : (doc && doc.activeElement) || null;
      // A2-CMD-01（低）：document.body / documentElement 的 focus() 是空转（没有 tabindex），
      // 记成 opener 会让关闭后焦点「还给」body：正文再敲字无效、Tab 从页首开始。统一当没有 opener，
      // 调用方的兜底（写作页交回编辑区）才会生效。
      if (opener && doc && (opener === doc.body || opener === doc.documentElement)) opener = null;
      open = true;
      active = 0;
      // 每次打开都取一份新快照：上次看面板之后书架 / 书目可能变过。
      invalidateItems();
      bd.classList.remove('hidden');
      bd.setAttribute('aria-hidden', 'false');
      const el = inputEl();
      if (el) {
        el.value = '';
        if (typeof el.focus === 'function') el.focus();
      }
      render();
      return true;
    }

    function closePalette() {
      const bd = backdrop();
      open = false;
      rows = [];
      active = 0;
      itemsSnapshot = null;
      if (bd) {
        bd.classList.add('hidden');
        bd.setAttribute('aria-hidden', 'true');
      }
      const el = inputEl();
      if (el) el.value = '';
      if (typeof onClose === 'function') onClose(opener || null);
      opener = null;
      return true;
    }

    function runActive() {
      const item = activeItem();
      if (!item) return false;
      registry.recordUse(item.id);
      // 先收起再执行：命令可能要开别的弹层（设置 / 查找 / 历史…），面板留在上面会挡住
      closePalette();
      if (typeof onRun === 'function') onRun(item);
      return true;
    }

    function inputChanged() {
      active = 0;
      return render();
    }

    function onKeyDown(event) {
      if (!open || !event) return false;
      const key = event.key;
      if (key === 'ArrowDown' || key === 'Down') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        setActive(active + 1);
        return true;
      }
      if (key === 'ArrowUp' || key === 'Up') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        setActive(active - 1);
        return true;
      }
      if (key === 'Home') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        setActive(0);
        return true;
      }
      if (key === 'End') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        setActive(rows.length - 1);
        return true;
      }
      if (key === 'Enter') {
        // WP-04（审计 C8 / V112）：输入法组字中的 Enter 只上屏候选词，不执行命令、也不拦默认行为。
        if (imeGuard.isImeComposing(event)) return false;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        runActive();
        return true;
      }
      if (key === 'Escape') {
        // RSHE-C-02：与 Enter 同口径 —— 组字中按 Esc 是「取消候选词」，不是收起面板。
        // ime-guard 的判据覆盖「只报 keyCode 229 的旧版 / 第三方输入法」，这些环境里
        // keydown 的 key 未必是 'Escape' 之外的 'Process'，所以同一份守卫必须前置。
        if (imeGuard.isImeComposing(event)) return false;
        if (typeof event.preventDefault === 'function') event.preventDefault();
        closePalette();
        return true;
      }
      // 再按一次 Ctrl+K：收起。必须 stopPropagation —— 否则同一个按键冒泡到 document，
      // 渲染层看到「面板已关」又会立刻打开一次。
      if ((event.ctrlKey || event.metaKey) && String(key).toLowerCase() === 'k') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        if (typeof event.stopPropagation === 'function') event.stopPropagation();
        closePalette();
        return true;
      }
      return false;
    }

    function setup() {
      if (bound) return false;
      bound = true;
      const el = inputEl();
      if (el) {
        el.addEventListener('input', () => inputChanged());
        el.addEventListener('keydown', onKeyDown);
      }
      const bd = backdrop();
      if (bd) {
        // 点遮罩空白处收起（点行本身由下面的 click 处理；不新增强制焦点行为）
        bd.addEventListener('click', (event) => {
          if (event.target === bd) closePalette();
        });
      }
      const list = listEl();
      if (list) {
        list.addEventListener('click', (event) => {
          const row = event.target.closest ? event.target.closest('.command-row') : null;
          if (!row) return;
          const index = Number(row.dataset.index);
          if (!Number.isFinite(index)) return;
          active = Math.min(Math.max(0, index), Math.max(0, rows.length - 1));
          runActive();
        });
      }
      return true;
    }

    return {
      open: openPalette,
      close: closePalette,
      isOpen,
      setup,
      render,
      inputChanged,
      activeItem,
      visibleRows,
      setActive,
      // 渲染层在 state.chapters / state.books / state.meta 变化时调用（1.5.0 P0-6）
      invalidateItems
    };
  }

  return { create: createCommandPaletteUi, REQUIRED_HOST, GROUP_LABELS, MAX_ROWS };
});