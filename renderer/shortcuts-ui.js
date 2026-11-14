/* 快捷键一览（v1.5.0 功能-4；1.6.0 F4a 补系统键；v1.8.0 WP-34 / D1：从 renderer.js 整段搬出来）。
 *
 * 搬走的段（原 renderer.js「快捷键一览」分区，约 94 行）：写作页按 `?` 打开的锁键层 ——
 * 行渲染（分组标题 + 命令键帽 + 系统键的「在哪儿生效」列 + 空态）、开合、焦点归位。
 * 数据源仍是 renderer/command-catalog.js 的同一份声明：命令表里带键帽的 8 条 +「系统键」表
 * （Ctrl+K / Ctrl+Z / Esc / Shift+F10 … 非命令表的快捷键）。**这里不维护第二份快捷键表** ——
 * 目录里加一条带键位的命令、或加一个系统键，这一页与 README 的系统键表都会自动多一行。
 * 也不用 buildCommandItems()：那份按当前视图过滤（书架页会把保存 / 新建章节等编辑类命令滤掉，
 * 一览页在书架页按 ? 就成了空表）；一览页只读声明表，与视图无关。
 *
 * 只搬不改行为：行 DOM 结构与 class、分组标题的判定、系统键 scope 列的显隐、空态文案、
 * 打开时把焦点放到右上「×」、关闭时只在焦点掉进 body / 弹层里才还给打开前的元素 —— 全部逐字保留。
 *
 * 契约：createShortcutsUi(host)，host = { $, state, editorEl, commandCatalog, groupLabels }；
 * 缺任何一个直接抛 TypeError（宁可在启动时炸，也不要到点按 ? 才 ReferenceError）。
 * `groupLabels` 就是命令面板的 GROUP_LABELS（命令行沿用它的分组名）；模块不读 commandPaletteModule。
 * 开合状态（快捷一览的 backdrop class / 打开前焦点）由本模块自己持有；其余状态都是渲染层引用。
 *
 * 不搬的（刻意留在 renderer.js）：Esc 链里 `'close-shortcuts'` 的动作接线、两个「关闭」按钮的
 * click 绑定、按 `?` 的键盘入口、测试钩子宿主契约段 —— 都按原名取本模块交出的入口。
 *
 * 浏览器里挂成全局 CWShortcutsUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./assert-host').assertHost);
  } else if (root) {
    root.CWShortcutsUi = factory(root.CWAssertHost && root.CWAssertHost.assertHost);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (assertHost) {
  'use strict';

  const REQUIRED_HOST = ['$', 'state', 'editorEl', 'commandCatalog', 'groupLabels'];

  function createShortcutsUi(host) {
    // A8（WP-32）：host 契约逐成员校验走共享实现（缺依赖在启动装配时直接抛）。
    assertHost('createShortcutsUi', host, REQUIRED_HOST);
    const { $, state, editorEl, commandCatalog, groupLabels } = host;

  function shortcutRows() {
    return commandCatalog.shortcutRows(groupLabels || {});
  }

  function renderShortcutRows() {
    const list = $('shortcuts-list');
    if (!list) return 0;
    list.textContent = '';
    const rows = shortcutRows();
    let lastGroup = null;
    for (const row of rows) {
      if (row.groupLabel !== lastGroup) {
        lastGroup = row.groupLabel;
        const head = document.createElement('div');
        head.className = 'shortcut-group';
        head.setAttribute('role', 'presentation');
        head.textContent = row.groupLabel;
        list.appendChild(head);
      }
      const item = document.createElement('div');
      item.className = 'shortcut-row';
      item.setAttribute('role', 'listitem');
      item.dataset.shortcutId = row.id;
      const title = document.createElement('span');
      title.className = 'shortcut-title';
      title.textContent = row.title;
      const kbd = document.createElement('span');
      kbd.className = 'kbd shortcut-kbd';
      kbd.textContent = row.kbd;
      item.appendChild(title);
      // 系统键多一列「在哪儿生效」（命令行没有 scope，不画空气）。
      if (row.scope) {
        const scope = document.createElement('span');
        scope.className = 'shortcut-scope';
        scope.textContent = row.scope;
        item.appendChild(scope);
      }
      item.appendChild(kbd);
      list.appendChild(item);
    }
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'shortcut-empty muted small';
      empty.textContent = '命令表里暂时没有带键位的命令';
      list.appendChild(empty);
    }
    return rows.length;
  }

  function shortcutsOpen() {
    const backdrop = $('shortcuts-backdrop');
    return Boolean(backdrop && !backdrop.classList.contains('hidden'));
  }

  // 打开前的焦点（关闭时归还；dialog-focus 也会兜一层，这里显式还给编辑区 / 原按钮）
  let shortcutsOpener = null;

  function openShortcutsPage() {
    const backdrop = $('shortcuts-backdrop');
    if (!backdrop || shortcutsOpen()) return false;
    renderShortcutRows();
    const active = document.activeElement;
    shortcutsOpener = active && active !== document.body && active !== document.documentElement ? active : null;
    backdrop.classList.remove('hidden');
    // 焦点先落在右上「×」上：标题会被读屏连同弹层一起念出来，Tab 一次就到下面唯一的「关闭」。
    const closeButton = $('btn-shortcuts-close');
    if (closeButton && typeof closeButton.focus === 'function') closeButton.focus();
    return true;
  }

  function closeShortcutsPage() {
    const backdrop = $('shortcuts-backdrop');
    if (!backdrop || backdrop.classList.contains('hidden')) return false;
    backdrop.classList.add('hidden');
    const opener = shortcutsOpener;
    shortcutsOpener = null;
    const active = document.activeElement;
    // 焦点还留在刚关掉的弹层里 / 掉到 body 上 → 还给打开前的元素（编辑区或原按钮）。
    // 业务代码要是已经把焦点给了别处，就不抢。
    const lost = !active || active === document.body || active === document.documentElement || backdrop.contains(active);
    if (lost) {
      const target = opener && opener.isConnected ? opener : (state.view === 'editor' && state.bookPath ? editorEl : null);
      if (target && typeof target.focus === 'function') {
        try { target.focus(); } catch { /* 元素刚好不可聚焦：交给 dialog-focus 兜底 */ }
      }
    }
    return true;
  }

    return {
      shortcutRows,
      renderShortcutRows,
      shortcutsOpen,
      openShortcutsPage,
      closeShortcutsPage
    };
  }

  return { create: createShortcutsUi, REQUIRED_HOST };
});