// RSHE-B-04 / RSHE-B-06：卷章目录的筛选渲染口径。
//
// B-04：一次筛选渲染对全书做两遍 O(N) 匹配，而且每章都重跑一遍 normalizeQuery
//（千章书 = 1000 次全串归一 + 2 遍匹配）。修法：查询词在循环外归一一次，命中数由
// renderChapterList 传给概览行。这里用计数桩钉住「只归一 1 次」「给了命中数就不再重跑」。
//
// B-06：筛选态所有卷被强制展开、卷头只作分组标签，但卷头 title 仍承诺「单击折叠 / 展开」，
// 当前卷还挂着「被折叠」的朱红标记。这里钉住筛选态的提示与标记收口。
const test = require('node:test');
const assert = require('node:assert/strict');

const directoryUi = require('../renderer/chapter-directory-ui');

function makeClassList() {
  const set = new Set();
  return {
    add(name) {
      set.add(name);
    },
    remove(name) {
      set.delete(name);
    },
    toggle(name, on) {
      if (on) set.add(name);
      else set.delete(name);
    },
    contains(name) {
      return set.has(name);
    }
  };
}

// 极简假 DOM：只要 makeVolumeHeader 用到的那几个成员（createElement / appendChild /
// classList / dataset / textContent / title / addEventListener）。
function makeDocument() {
  const created = [];
  const makeElement = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(),
      className: '',
      textContent: '',
      title: '',
      style: {},
      dataset: {},
      children: [],
      attributes: {},
      classList: makeClassList(),
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      addEventListener(type, fn) {
        this.listeners = this.listeners || {};
        this.listeners[type] = fn;
      },
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      remove() {},
      focus() {}
    };
    created.push(el);
    return el;
  };
  return {
    created,
    createElement: makeElement,
    createDocumentFragment() {
      return makeElement('fragment');
    }
  };
}

// 27 个 host 成员：只有本文件真正走到的几项有行为，其余是「用来过契约校验」的桩。
function build(overrides = {}) {
  const els = new Map();
  const counters = { normalizeQuery: 0, matchChapter: 0 };
  const state = {
    chapters: [],
    meta: { volumes: [] },
    chapterFilter: '',
    collapsedVolumes: new Set(),
    index: 0,
    selectedIds: new Set(),
    selectAnchorId: null,
    ...(overrides.state || {})
  };
  const host = {
    $: (id) => els.get(id) || null,
    state,
    chapterTitle: (index, name) => `第${index + 1}章${name ? '：' + name : ''}`,
    chapterListLabel: (index) => `第${index + 1}章`,
    chaptersLib: {
      chapterNumber: () => 1,
      chapterVolumeKey: (meta, chapter) => (chapter && chapter.volumeId) || ''
    },
    chapterFilterLogic: {
      normalizeQuery(value) {
        counters.normalizeQuery += 1;
        return String(value == null ? '' : value).trim();
      },
      matchChapter(chapter, index, title, query) {
        counters.matchChapter += 1;
        return String(title).includes(query);
      }
    },
    chapterCharsOf: () => null,
    formatCount: (n) => String(n),
    editorLogic: { formatCharsShort: (n) => String(n), compareChapterChars: () => null },
    imeGuard: { isImeComposing: () => false },
    listKeyboard: { ensureTabStop: () => {} },
    chapterSelectionLib: {},
    chapterStatus: () => 'draft',
    chapterNote: () => '',
    CHAPTER_STATUS_LABELS: { draft: '草稿' },
    switchChapter: async () => ({ ok: true }),
    showContextMenu: () => {},
    showVolumeMenu: () => {},
    startChapterDrag: () => {},
    renameChapterAt: async () => ({ ok: true }),
    copySelectedChapters: async () => ({ ok: true }),
    exportSelectedChapters: async () => ({ ok: true }),
    deleteSelectedChapters: async () => ({ ok: true }),
    openVolumeChooserInMenu: async () => ({ ok: true }),
    markCommandsDirty: () => {},
    getCachedActiveChapterItem: () => null,
    setCachedActiveChapterItem: () => {},
    ...(overrides.host || {})
  };
  const ui = directoryUi.create(host);
  return { ui, host, state, els, counters };
}

test('RSHE-B-04：千章书一次筛选只归一查询词 1 次，命中数直接传给概览行', () => {
  const { ui, state, els, counters } = build();
  state.chapters = Array.from({ length: 1000 }, (_, i) => ({ id: 'c' + i, name: i % 3 === 0 ? '起风' : '落雨' }));
  state.chapterFilter = '起风';
  // matchingChapterIndexes：循环外归一一次（以前每章一次 = 1001 次）
  counters.normalizeQuery = 0;
  counters.matchChapter = 0;
  const matched = ui.matchingChapterIndexes();
  assert.equal(matched.length, 334, '0,3,6…999 共 334 章');
  assert.equal(counters.matchChapter, 1000, '每章只匹配一次');
  assert.equal(counters.normalizeQuery, 1, '整次筛选只归一一次查询词（以前是 1 + 1000）');

  // renderBookMeta 收到命中数时不再重跑全表匹配
  els.set('book-meta', { textContent: '', title: '', attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } });
  counters.matchChapter = 0;
  counters.normalizeQuery = 0;
  ui.renderBookMeta(matched.length);
  assert.equal(counters.matchChapter, 0, '概览行不许再跑第二遍全表匹配');
  assert.equal(counters.normalizeQuery, 1, '概览行只归一一次查询词');
  assert.equal(els.get('book-meta').textContent, '找到 334 章 · 共 1000 章');
});

test('RSHE-B-06：筛选态卷头不承诺折叠、不挂「当前卷被折叠」标记', () => {
  globalThis.document = makeDocument();
  const { ui, state, els } = build();
  state.meta = { volumes: [{ id: 'v1', name: '第一卷' }] };
  state.chapters = [{ id: 'c0', name: '一', volumeId: 'v1' }];
  state.index = 0;
  state.collapsedVolumes = new Set(['v1']);
  // 卷头：正常态承诺折叠，筛选态改成「只作分组标签」
  const normal = ui.makeVolumeHeader('v1', '第一卷', 1, 0, 1, 0);
  assert.match(normal.title, /单击折叠 \/ 展开/);
  state.chapterFilter = '一';
  const filtered = ui.makeVolumeHeader('v1', '第一卷', 1, 0, 1, 0);
  assert.match(filtered.title, /筛选中/);
  assert.equal(filtered.title.includes('单击折叠'), false, '筛选态不许再承诺可折叠');
  assert.match(filtered.title, /右键更多/);

  // 当前卷标记：卷被折叠且当前章在那卷里 → 正常态挂 has-current；筛选态（强制展开）不挂
  const rows = [{ dataset: { volumeId: 'v1' }, classList: makeClassList() }];
  els.set('chapter-list', { querySelectorAll: () => rows });
  ui.syncCurrentVolumeMarker();
  assert.equal(rows[0].classList.contains('has-current'), false, '筛选态所有卷强制展开，不该挂折叠标记');
  state.chapterFilter = '';
  ui.syncCurrentVolumeMarker();
  assert.equal(rows[0].classList.contains('has-current'), true, '不筛选时仍按「当前卷被折叠」挂标记');
  state.collapsedVolumes = new Set();
  ui.syncCurrentVolumeMarker();
  assert.equal(rows[0].classList.contains('has-current'), false, '卷展开时不挂标记');
});
