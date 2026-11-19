// 五-M23（CD-01）：目录筛选 / 折叠下的**鼠标 Shift+连选**必须和键盘通道同口径——只作用于
// 当前渲染出来的行，绝不把看不见的章偷选进批量目标集。
//
// 缺陷：chapter-directory-ui.js 的 Shift+单击把 chapterIdsInBookOrder()（全书顺序）交给
// chapter-selection.extendTo()，而键盘 Ctrl+A / Shift+↑↓ 用的是 renderedChapterIds()。于是
// 筛选 / 折叠时 Shift+连选会按全书范围把隐藏章一起选上：批量条只报数量、批量删除 / 移卷 / 改状态
// 直接作用于那些不可见的章。这里用假 DOM + 真选择模型走点击委托，钉住「选中集合 = 可见行」。
const test = require('node:test');
const assert = require('node:assert/strict');

const directoryUi = require('../renderer/chapter-directory-ui');
const chapterSelectionLib = require('../renderer/chapter-selection');

function makeClassList() {
  const set = new Set();
  return {
    toggle(name, on) {
      if (on) set.add(name);
      else set.delete(name);
    },
    contains(name) {
      return set.has(name);
    }
  };
}

function makeEl() {
  return {
    classList: makeClassList(),
    attributes: {},
    textContent: '',
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
  };
}

function makeRow(index, id) {
  const row = makeEl();
  row.dataset = { index: String(index), chapterId: String(id) };
  row.closest = (selector) => (selector === '.chapter-item' ? row : null);
  row.focus = () => {};
  return row;
}

function makeList(rows) {
  const handlers = {};
  const list = makeEl();
  list.addEventListener = (type, fn) => {
    handlers[type] = fn;
  };
  list.querySelectorAll = (selector) => (selector === '.chapter-item' ? rows : []);
  list.contains = () => true;
  return { list, handlers };
}

// 6 章（c0..c5）的目录：rows 只放「当前渲染出来的行」，书内下标与渲染位置故意错开。
function build(options = {}) {
  const rows = (options.visible || []).map(([index, id]) => makeRow(index, id));
  const { list, handlers } = makeList(rows);
  const bar = makeEl();
  const count = makeEl();
  const byId = { 'chapter-list': list, 'chapter-batch-bar': bar, 'chapter-batch-count': count };
  const chapters = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'].map((id, index) => ({ id, name: `第${index}章` }));
  const state = {
    chapters,
    index: options.index === undefined ? 3 : options.index, // 当前章 c3：筛选时不可见
    selectedIds: options.selectedIds || new Set(),
    selectAnchorId: options.anchorId === undefined ? null : options.anchorId,
    chapterFilter: '',
    suppressChapterClick: 0
  };
  const host = {
    $: (id) => byId[id] || null,
    state,
    chapterTitle: (index, name) => name || '',
    chapterListLabel: () => '',
    chaptersLib: { chapterNumber: () => 1, countChars: () => 0 },
    chapterFilterLogic: { normalizeQuery: (value) => String(value || '').trim(), matchChapter: () => true },
    chapterCharsOf: () => 0,
    formatCount: (n) => String(n),
    editorLogic: {},
    imeGuard: {},
    listKeyboard: { applyTabStops() {} },
    chapterSelectionLib,
    chapterStatus: () => '',
    chapterNote: () => '',
    CHAPTER_STATUS_LABELS: {},
    switchChapter: async () => ({ ok: true }),
    showContextMenu() {},
    showVolumeMenu() {},
    startChapterDrag() {},
    renameChapterAt() {},
    copySelectedChapters() {},
    exportSelectedChapters() {},
    deleteSelectedChapters() {},
    openVolumeChooserInMenu() {},
    markCommandsDirty() {},
    getCachedActiveChapterItem: () => null,
    setCachedActiveChapterItem() {}
  };
  const ui = directoryUi.create(host);
  ui.setupChapterListEvents();
  const shiftClick = (row) =>
    handlers.click({
      target: row,
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
      preventDefault() {},
      stopPropagation() {}
    });
  return { ui, state, rows, shiftClick, bar, count };
}

test('五-M23：筛选后 Shift+单击可见行，anchor 失效（当前章不可见）时只选目标这一条', () => {
  // 可见行只有书内第 1 章、第 4 章；正在写的第 3 章被筛掉。
  const ctx = build({ visible: [[1, 'c1'], [4, 'c4']], index: 3 });
  ctx.shiftClick(ctx.rows[1]);
  assert.deepEqual([...ctx.state.selectedIds], ['c4'], '当前章不在可见行里时只选目标，不按全书范围扩');
  assert.equal(ctx.state.selectAnchorId, 'c4', 'anchor 落到目标，下一次 Shift 能继续拉');
  assert.equal(ctx.count.textContent, '已选 1 章');
  assert.equal(ctx.rows.filter((row) => row.classList.contains('selected')).length, 1, '高亮数 = 选中数');
});

test('五-M23：可见 anchor 到可见目标之间只选可见行，折叠 / 筛掉的中间章一个都不许偷选', () => {
  // anchor=c1（可见），目标=c4（可见）；全书顺序里夹着 c2 / c3，但渲染行只有 c1、c4。
  const ctx = build({ visible: [[1, 'c1'], [4, 'c4']], index: 3, anchorId: 'c1' });
  ctx.shiftClick(ctx.rows[1]);
  assert.deepEqual(
    [...ctx.state.selectedIds].sort(),
    ['c1', 'c4'],
    '选中集合 = 可见范围内那几条（旧实现会选中 c1..c4 共 4 章，含 2 条看不见的）'
  );
  assert.equal(ctx.state.selectedIds.has('c2'), false, '隐藏章 c2 不许进批量目标集');
  assert.equal(ctx.state.selectedIds.has('c3'), false, '隐藏章 c3 不许进批量目标集');
  assert.equal(ctx.count.textContent, '已选 2 章', '批量条计数与真实目标集一致');
  assert.equal(
    ctx.rows.filter((row) => row.classList.contains('selected')).length,
    ctx.state.selectedIds.size,
    '高亮数与批量目标数一致（批量删除不会再波及看不见的章）'
  );
});