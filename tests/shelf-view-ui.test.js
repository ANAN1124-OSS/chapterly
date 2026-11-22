// 旧M5（一轮·中/低）：书架视图的两条异步链（开书套显示设置 / 回书架刷新）必须带世代令牌 ——
// 快速连开两本书时 A 的字体 / 纸色 / 侧栏不许盖到 B；换根 / 多窗口广播并发时不许显示旧列表。
// 纯接线锚点：模块只做「先核令牌再落状态 / 重画」，DOM / IPC 全用假宿主。
const test = require('node:test');
const assert = require('node:assert/strict');
const shelfViewUi = require('../renderer/shelf-view-ui');

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function build(options = {}) {
  const calls = {
    renderShelf: 0,
    refreshStats: 0,
    applyEditorStyle: 0,
    syncCaretParagraph: 0,
    applySidebarWidth: [],
    markCommandsDirty: 0,
    ensureSearchIndex: 0,
    scheduleContentSearch: 0,
    toast: []
  };
  const state = {
    bookPath: null,
    books: [],
    recentBook: null,
    bookDisplay: {},
    config: options.config || { editorFont: 'serif', editorSidebarWidth: 300 },
    globalConfig: null,
    shelfContent: { query: '' }
  };
  const api = options.api || {};
  const host = {
    state,
    api,
    call: async (fn, ...args) => fn(...args),
    toast: (message, kind) => calls.toast.push([message, kind]),
    $: () => null,
    refreshStats: async () => { calls.refreshStats += 1; },
    markCommandsDirty: () => { calls.markCommandsDirty += 1; },
    renderShelf: () => { calls.renderShelf += 1; },
    ensureSearchIndex: () => { calls.ensureSearchIndex += 1; },
    shelfQueryText: () => '',
    scheduleContentSearch: () => { calls.scheduleContentSearch += 1; },
    resetShelfContent: () => {},
    shelfSearchResults: () => [],
    openBookByPath: () => {},
    openContentResult: async () => {},
    renderShelfContent: () => {},
    imeGuard: { isImeComposing: () => false },
    effectiveConfig: () => ({ ...(state.globalConfig || state.config), ...state.bookDisplay }),
    loadCustomFont: async () => {},
    applyEditorStyle: () => { calls.applyEditorStyle += 1; },
    syncCaretParagraphFromConfig: () => { calls.syncCaretParagraph += 1; },
    applySidebarWidth: (width) => { calls.applySidebarWidth.push(width); },
    CONTENT_SEARCH_MIN_CHARS: 2,
    CONTENT_PAGE_SIZE: 8
  };
  const ui = shelfViewUi.create(host);
  return { ui, host, state, api, calls };
}

test('旧M5：快速连开两本书时，先发起的那份显示设置回执不许盖到后打开的书', async () => {
  const gates = new Map();
  const ctx = build({
    api: {
      getBookDisplay: (bookId) =>
        gates.has(bookId) ? gates.get(bookId).promise : Promise.resolve({})
    }
  });
  gates.set('A', createDeferred());
  gates.set('B', createDeferred());

  const first = ctx.ui.applyBookDisplay('A');
  const second = ctx.ui.applyBookDisplay('B');
  // B（后发起、后打开的那本）先回来；A 晚回来时必须整份丢弃
  gates.get('B').resolve({ editorSidebarWidth: 320 });
  await second;
  gates.get('A').resolve({ editorSidebarWidth: 180 });
  await first;

  assert.equal(ctx.state.bookDisplay.editorSidebarWidth, 320, 'B 的显示设置生效');
  assert.equal(ctx.calls.applySidebarWidth.at(-1), 320, '侧栏宽度是 B 的');
  assert.equal(ctx.calls.applyEditorStyle, 1, 'A 的旧回执不许再套一次样式（只应用 B 那一次）');
});

test('旧M5：并发刷新书架时旧世代的回执整份丢弃（不显示旧列表 / 不覆盖新统计）', async () => {
  const firstGate = createDeferred();
  const secondGate = createDeferred();
  let gate = firstGate;
  let listCalls = 0;
  const ctx = build({
    api: {
      getRecentBook: () => gate.promise,
      listBooks: async () => {
        listCalls += 1;
        return [{ path: 'B' }];
      }
    }
  });
  const first = ctx.ui.refreshShelf();
  gate = secondGate;
  const second = ctx.ui.refreshShelf();

  secondGate.resolve({ bookPath: 'B', chapterIndex: 0 });
  await second;
  assert.equal(ctx.state.recentBook.bookPath, 'B');
  assert.deepEqual(ctx.state.books, [{ path: 'B' }]);
  assert.equal(ctx.calls.renderShelf, 1, '后发起的刷新重画书架');
  assert.equal(listCalls, 1, '只有新世代读了书目');

  // 旧世代晚回来：不许改 state / 不许再重画 / 不许再读统计
  firstGate.resolve({ bookPath: 'A', chapterIndex: 9 });
  await first;
  assert.equal(ctx.state.recentBook.bookPath, 'B', '旧回执不许覆盖新状态');
  assert.equal(ctx.calls.renderShelf, 1, '旧回执不许再重画书架');
  assert.equal(ctx.calls.refreshStats, 1, '旧回执在拿到 recentBook 后立刻停住');
  assert.equal(listCalls, 1, '旧回执不许再读书目');
});
