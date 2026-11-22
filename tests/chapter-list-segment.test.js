// P5（一轮·低）：章节目录「分段渲染」的行为锚点。
//
// 背景：书目最多允许 20,000 章，旧实现只在 renderChapterList 里同步建完所有条目 DOM ——
// 一次几百毫秒的单帧长任务（筛选输入停 250ms 后还要再整表重建一次）。修法是把「显示哪些行」
// 先算成纯内存的行计划：行数超过阈值时第一段同步挂载（首屏立刻可见），其余分段在后续任务里
// 追加；世代号一变，旧分段立即作废。小书（≤ 阈值）仍一次性挂载，行为与旧实现逐字节一致。
//
// 这里用假 DOM + 真模块（不碰 Electron / 真布局）钉四件事：
//   1. 小书仍一次挂完（千章书的旧路径没被改坏）；
//   2. 20,000 章：首段同步可见、其余补齐、顺序与书内下标一致；
//   3. 分段期间 renderedChapterIds() 已经是完整显示行（Ctrl+A / Shift 扩选不只见得到一半）；
//   4. 新一代渲染开始时旧分段作废（不会把旧书的行追到新列表里），筛选结果同样分段。
const test = require('node:test');
const assert = require('node:assert/strict');

const directoryUi = require('../renderer/chapter-directory-ui');
const chapterSelectionLib = require('../renderer/chapter-selection');

function selectorMatches(el, selector) {
  for (const part of String(selector).split(',')) {
    const text = part.trim();
    if (!text) continue;
    const tokens = text.split('.').filter(Boolean);
    let ok = true;
    let start = 0;
    if (!text.startsWith('.')) {
      ok = el.tagName === tokens[0].toUpperCase();
      start = 1;
    }
    for (let i = start; i < tokens.length && ok; i += 1) ok = el.classList.contains(tokens[i]);
    if (ok) return true;
  }
  return false;
}

function makeEl(tag) {
  const classes = new Set();
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    dataset: {},
    attributes: {},
    textContent: '',
    title: '',
    value: '',
    tabIndex: -1,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    style: {},
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle(name, on) {
        if (on === undefined ? !classes.has(name) : Boolean(on)) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name)
    },
    get className() { return [...classes].join(' '); },
    set className(value) {
      classes.clear();
      String(value || '').split(/\s+/).filter(Boolean).forEach((name) => classes.add(name));
    },
    appendChild(child) {
      if (child && child._isFragment) {
        child.children.slice().forEach((item) => el.appendChild(item));
        child.children.length = 0;
        return child;
      }
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    replaceChildren(...nodes) {
      el.children.length = 0;
      for (const node of nodes) el.appendChild(node);
    },
    setAttribute(name, value) { el.attributes[name] = value; },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(el.attributes, name) ? el.attributes[name] : null;
    },
    querySelectorAll(selector) {
      const out = [];
      const visit = (node) => {
        for (const child of node.children || []) {
          if (selectorMatches(child, selector)) out.push(child);
          visit(child);
        }
      };
      visit(el);
      return out;
    },
    querySelector(selector) { return el.querySelectorAll(selector)[0] || null; },
    getBoundingClientRect() { return { top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }; },
    scrollIntoView() { el.scrolledIntoView = (el.scrolledIntoView || 0) + 1; },
    focus() {},
    addEventListener() {},
    closest() { return null; }
  };
  return el;
}

function build(chapters) {
  const list = makeEl('div');
  const bookMeta = makeEl('div');
  const byId = { 'chapter-list': list, 'book-meta': bookMeta };
  const state = {
    chapters,
    meta: { volumes: [] },
    chapterFilter: '',
    collapsedVolumes: new Set(),
    index: 0,
    selectedIds: new Set(),
    selectAnchorId: null,
    view: 'editor',
    bookPath: '/书库/书甲'
  };
  globalThis.document = {
    createElement: (tag) => makeEl(tag),
    createTextNode: (text) => {
      const node = makeEl('#text');
      node.textContent = text;
      return node;
    },
    createDocumentFragment() {
      const fragment = makeEl('fragment');
      fragment._isFragment = true;
      return fragment;
    }
  };
  const host = {
    $: (id) => (id === 'chapter-list' ? list : byId[id] || null),
    state,
    chapterTitle: (index, name) => `第${index + 1}章${name ? '：' + name : ''}`,
    chapterListLabel: (index, name) => ({ num: String(index + 1), name: name || '' }),
    chaptersLib: {
      chapterNumber: () => 1,
      chapterVolumeKey: (meta, chapter) => (chapter && chapter.volumeId) || ''
    },
    chapterFilterLogic: {
      normalizeQuery: (value) => String(value == null ? '' : value).trim(),
      matchChapter: (chapter, index, title, query) => !query || String(title).includes(query)
    },
    chapterCharsOf: () => null,
    formatCount: (value) => String(value),
    editorLogic: { formatCharsShort: (value) => String(value), compareChapterChars: () => null },
    imeGuard: { isImeComposing: () => false },
    listKeyboard: { ensureTabStop() {}, applyTabStops() {} },
    chapterSelectionLib,
    chapterStatus: () => 'draft',
    chapterNote: () => '',
    CHAPTER_STATUS_LABELS: { draft: '草稿' },
    switchChapter: async () => ({ ok: true }),
    showContextMenu() {},
    showVolumeMenu() {},
    startChapterDrag() {},
    renameChapterAt: async () => ({ ok: true }),
    copySelectedChapters: async () => ({ ok: true }),
    exportSelectedChapters: async () => ({ ok: true }),
    deleteSelectedChapters: async () => ({ ok: true }),
    openVolumeChooserInMenu: async () => ({ ok: true }),
    markCommandsDirty() {},
    getCachedActiveChapterItem: () => null,
    setCachedActiveChapterItem() {}
  };
  const ui = directoryUi.create(host);
  return { ui, state, list };
}

const makeChapters = (count) => Array.from({ length: count }, (_, index) => ({ id: `c${index}`, name: `n${index}` }));

async function waitFor(predicate, timeout = 8000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

test('P5：千章书（≤ 分段阈值）仍一次性挂载，顺序与书内下标一致', () => {
  const chapters = makeChapters(1000);
  const { ui, list } = build(chapters);
  ui.renderChapterList();
  assert.equal(list.children.length, 1000, '小书一次挂完（同步返回时就完整）');
  for (let i = 0; i < 1000; i += 1) {
    assert.equal(list.children[i].dataset.index, String(i), `第 ${i} 条顺序不对`);
    assert.equal(list.children[i].dataset.chapterId, `c${i}`);
  }
});

test('P5：20,000 章分段挂载 —— 首段同步可见、其余分段补齐，顺序完整不重复', async () => {
  const chapters = makeChapters(20000);
  const { ui, list } = build(chapters);
  ui.renderChapterList();
  const first = list.children.length;
  assert.ok(first > 0, '首段必须同步挂上（首屏立刻有内容）');
  assert.ok(first < 20000, `首段只挂一部分（实际 ${first}），其余交给后续任务`);
  // 分段期间 Ctrl+A / Shift+↑↓ 的「当前显示行」必须是完整计划（不能只知道已挂的那一半）
  assert.equal(ui.renderedChapterIds().length, 20000, 'renderedChapterIds 在分段期间按完整显示行返回');
  // 首段还没滚到当前章也没关系，但不能把「当前章条目缓存」写坏：收尾在全部挂完后才跑
  assert.ok(await waitFor(() => list.children.length === 20000), `分段没有补齐（停在 ${list.children.length}）`);
  let ordered = true;
  let unique = new Set();
  for (let i = 0; i < list.children.length; i += 1) {
    const index = Number(list.children[i].dataset.index);
    if (index !== i) ordered = false;
    unique.add(index);
  }
  assert.ok(ordered, '挂载顺序 = 书内下标顺序（分段追加不能乱序）');
  assert.equal(unique.size, 20000, '没有重复行');
});

test('P5：新一代渲染开始时旧分段立即作废（旧书的行不会追到新列表里）', async () => {
  const { ui, state, list } = build(makeChapters(20000));
  ui.renderChapterList();
  assert.ok(list.children.length > 0 && list.children.length < 20000);
  // 换书：新书只有 3,000 章
  state.chapters = makeChapters(3000);
  ui.renderChapterList();
  assert.ok(list.children.length > 0 && list.children.length < 3000, '换书后仍是首段同步');
  assert.ok(await waitFor(() => list.children.length === 3000), `新书没有补齐（停在 ${list.children.length}）`);
  // 旧世代的分段任务如果还在跑，会继续往这个列表追加 → 这里等两拍确认它真的停了
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(list.children.length, 3000, '旧分段必须被世代号拦住（不许追加旧书的行）');
  assert.equal(new Set(list.children.map((row) => row.dataset.chapterId)).size, 3000, '没有旧书的行混进来');
});

test('P5：筛选结果同样分段（命中行数超阈值也走分段）', async () => {
  const { ui, state, list } = build(makeChapters(20000));
  ui.renderChapterList();
  // 命中所有带数字 9 的章节（约 6,800 条，远超分段阈值）
  state.chapterFilter = '9';
  ui.renderChapterList();
  const matches = ui.matchingChapterIndexes();
  assert.ok(matches.length > 1200, `筛选命中应当超过分段阈值（实际 ${matches.length}）`);
  assert.ok(list.children.length > 0 && list.children.length < matches.length, '筛选结果也是首段先挂');
  assert.equal(ui.renderedChapterIds().length, matches.length, '筛选态的显示行按命中数算');
  assert.ok(await waitFor(() => list.children.length === matches.length), `筛选结果没有补齐（停在 ${list.children.length}）`);
  assert.ok(list.classList.contains('filtering'), '筛选态 class 照旧');
});
