const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const shelfFilterUi = require('../renderer/shelf-filter-ui');
const realBookInfo = require('../core/bookinfo');

// v0.9 B-5 第九刀：「书架搜索」分区（186 行）从 renderer.js 搬到 renderer/shelf-filter-ui.js。
// 搬出来以后用「假 host + 假 state + 假 DOM」逐条钉住内存过滤、分组筛选、正文结果区渲染与搜索摘要，
// 再用静态闸门保证渲染层不许长回第二份实现。

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const moduleSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'shelf-filter-ui.js'), 'utf8');
// 纯边界闸门只看代码：注释里提 window / state 是在解释契约，不算越界
const moduleCode = moduleSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------- 最小假 DOM ----------
function el(tag) {
  const classes = new Set();
  const node = {
    tag,
    className: '',
    textContent: '',
    type: '',
    value: '',
    dataset: {},
    children: [],
    attrs: {},
    handlers: {},
    focus() {},
    appendChild(child) {
      node.children.push(child);
      return child;
    },
    setAttribute(key, value) {
      node.attrs[key] = value;
    },
    addEventListener(type, fn) {
      (node.handlers[type] = node.handlers[type] || []).push(fn);
    },
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        if (force === undefined) { if (classes.has(name)) classes.delete(name); else classes.add(name); } else if (force) classes.add(name); else classes.delete(name);
      }
    },
    hasClass(name) { return classes.has(name); }
  };
  Object.defineProperty(node, 'innerHTML', {
    get() { return node._html || ''; },
    set(value) { node._html = value; if (value === '') node.children.length = 0; }
  });
  return node;
}

function textNode(text) {
  return { nodeType: 3, textContent: text };
}

function makeDom(ids) {
  const map = new Map();
  for (const id of ids) map.set(id, el('div'));
  return {
    map,
    $: (id) => map.get(id) || null,
    document: {
      createElement: (tag) => el(tag),
      createTextNode: (text) => textNode(text)
    }
  };
}

const SHELF_IDS = ['shelf-content', 'shelf-content-summary', 'shelf-content-list', 'btn-shelf-content-more'];
const SEARCH_IDS = ['shelf-search-summary', 'btn-shelf-search-clear'];

function withDom(dom, fn) {
  const prev = globalThis.document;
  globalThis.document = dom.document;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete globalThis.document; else globalThis.document = prev;
  }
}

// ---------- 假 host ----------
function makeHost(options = {}) {
  const state = {
    view: options.view === undefined ? 'shelf' : options.view,
    shelfQuery: options.shelfQuery === undefined ? '张三' : options.shelfQuery,
    shelfGroup: options.shelfGroup === undefined ? '' : options.shelfGroup,
    shelfTag: options.shelfTag === undefined ? '' : options.shelfTag,
    books: options.books === undefined ? [] : options.books,
    shelfContent: {
      loading: Boolean(options.loading),
      results: options.results || [],
      meta: options.meta === undefined ? null : options.meta,
      error: options.error || null,
      shown: options.shown === undefined ? 8 : options.shown,
      query: options.contentQuery === undefined ? '' : options.contentQuery,
      indexStatus: options.indexStatus === undefined ? null : options.indexStatus,
      expanded: options.expanded || {}
    }
  };
  const calls = { title: [], open: [], sanitize: [], matches: [], expand: [] };
  const dom = options.dom || makeDom(SHELF_IDS.concat(SEARCH_IDS));
  const host = {
    state,
    $: dom.$,
    CONTENT_SEARCH_MIN_CHARS: 2,
    // P22-4：「展开本章全部」由正文搜索模块晚一步交出，这里是可选的惰性转发（默认给一个记录调用的替身）。
    expandContentChapter(row, expandOptions) {
      calls.expand.push({ row, options: expandOptions });
      return Promise.resolve(true);
    },
    bookInfoLib: {
      sanitizeGroup(value) {
        calls.sanitize.push(value);
        if (typeof value !== 'string') return '';
        return value.trim();
      },
      // 1.6.0 F5：分组 / 标签筛选判定用真实现（模块只负责把 state 传进来，逻辑本身在 core/bookinfo）
      bookMatchesFilters(book, filters) {
        return realBookInfo.bookMatchesFilters(book, filters);
      },
      bookInfoMatches(book, queryLower) {
        calls.matches.push({ book, queryLower });
        if (options.infoMatch !== undefined) return Boolean(options.infoMatch);
        return String((book && book.brief) || '').toLowerCase().includes(queryLower);
      }
    },
    chapterTitle(index, name) {
      calls.title.push({ index, name });
      return '第' + (index + 1) + '章·' + name;
    },
    openContentResult(row) {
      calls.open.push(row);
      return Promise.resolve();
    }
  };
  return { host, state, calls, dom, ui: null };
}

function build(options) {
  const ctx = makeHost(options);
  ctx.ui = shelfFilterUi.create(ctx.host);
  return ctx;
}

function row(overrides = {}) {
  return {
    bookTitle: '书甲',
    chapterIndex: 2,
    chapterName: '第三章',
    chapterId: 'c3',
    matchIndex: 10,
    matchLength: 2,
    snippet: { before: '前文', match: '张三', after: '后文', cutBefore: false, cutAfter: false },
    ...overrides
  };
}

test('host 契约：6 个成员缺任何一个都抛 TypeError，空 host / null 也抛', () => {
  const { host } = makeHost();
  assert.deepEqual([...shelfFilterUi.REQUIRED_HOST].sort(), [
    '$',
    'CONTENT_SEARCH_MIN_CHARS',
    'bookInfoLib',
    'chapterTitle',
    'openContentResult',
    'state'
  ]);
  assert.throws(() => shelfFilterUi.create(null), /createShelfFilterUi 需要 host 对象/);
  assert.throws(() => shelfFilterUi.create('x'), /createShelfFilterUi 需要 host 对象/);
  for (const key of shelfFilterUi.REQUIRED_HOST) {
    const broken = { ...host };
    delete broken[key];
    assert.throws(() => shelfFilterUi.create(broken), /缺少/, key);
    const nulled = { ...host, [key]: null };
    assert.throws(() => shelfFilterUi.create(nulled), /缺少/, key + '（null 也算缺）');
  }
});

test('create() 只建表：不碰 document / 不建定时器，交出 7 个入口、内部件不导出', () => {
  const prevDocument = globalThis.document;
  delete globalThis.document;
  try {
    const ctx = makeHost({});
    const ui = shelfFilterUi.create(ctx.host);
    assert.deepEqual(Object.keys(ui).sort(), [
      'bookGroupOf',
      'renderShelfContent',
      'shelfContentActive',
      'shelfGroupList',
      'shelfQueryText',
      'shelfSearchResults',
      'updateShelfSearchUi'
    ]);
    for (const fn of Object.values(ui)) assert.equal(typeof fn, 'function');
    assert.equal(ui.matchBookForSearch, undefined, 'matchBookForSearch 是内部件，不导出');
    assert.equal(ui.shelfGroupMatches, undefined, 'shelfGroupMatches 是内部件，不导出');
  } finally {
    if (prevDocument !== undefined) globalThis.document = prevDocument;
  }
});

test('shelfQueryText：trim、空值 / 非字符串兜底', () => {
  assert.equal(build({ shelfQuery: '  张三  ' }).ui.shelfQueryText(), '张三');
  assert.equal(build({ shelfQuery: '' }).ui.shelfQueryText(), '');
  assert.equal(build({ shelfQuery: null }).ui.shelfQueryText(), '');
  assert.equal(build({ shelfQuery: '   ' }).ui.shelfQueryText(), '');
});

test('bookGroupOf / shelfGroupList：走 bookInfoLib 清洗、去空、去重、按中文排序', () => {
  const ctx = build({
    books: [
      { title: 'A', group: '乙组' },
      { title: 'B', group: '甲组' },
      { title: 'C', group: '乙组' },
      { title: 'D', group: '   ' },
      { title: 'E' }
    ]
  });
  assert.equal(ctx.ui.bookGroupOf({ group: '  甲组  ' }), '甲组');
  assert.equal(ctx.ui.bookGroupOf(null), '');
  const groups = ctx.ui.shelfGroupList();
  assert.deepEqual(groups, ['甲组', '乙组'], '按 zh-Hans-CN 排序，重复分组只出现一次、空分组不出现');
  assert.equal(ctx.calls.sanitize.length, 7, 'bookGroupOf 2 次 + 每本书分组各 1 次，全走 bookInfoLib.sanitizeGroup');
});

test('分组筛选（经 shelfSearchResults）：不筛选 / __none__ / 指定分组三种口径', () => {
  const books = [
    { title: '甲一', group: '甲组' },
    { title: '乙一', group: '乙组' },
    { title: '无组一', group: '   ' }
  ];
  const titles = (ctx) => ctx.ui.shelfSearchResults().map((r) => r.book.title);

  assert.deepEqual(titles(build({ books, shelfQuery: '' })), ['甲一', '乙一', '无组一']);
  assert.deepEqual(titles(build({ books, shelfQuery: '', shelfGroup: '__none__' })), ['无组一']);
  assert.deepEqual(titles(build({ books, shelfQuery: '', shelfGroup: '甲组' })), ['甲一']);
});

test('shelfSearchResults：书名 / 文件夹 / 作者简介 / 章节名四种命中与可见性', () => {
  const books = [
    { title: '张三传', folder: 'b1', chapterNames: ['序'] },
    { title: '别的书', folder: '张三-别集', chapterNames: ['第一章'] },
    { title: '丙', folder: 'b3', brief: '张三的短篇', chapterNames: ['一'] },
    { title: '丁', folder: 'b4', chapterNames: ['第一章', '张三出场', '张三归来', '张三结局'] },
    { title: '戊', folder: 'b5', chapterNames: ['无关'] }
  ];
  const ctx = build({ books, shelfQuery: '张三' });
  const rows = ctx.ui.shelfSearchResults();
  assert.deepEqual(rows.map((r) => r.book.title), ['张三传', '别的书', '丙', '丁']);
  assert.equal(rows[0].info.titleMatch, true);
  assert.equal(rows[0].info.chapterHits.length, 0);
  assert.equal(rows[1].info.titleMatch, true);
  assert.equal(rows[2].info.titleMatch, false);
  assert.equal(rows[2].info.infoMatch, true);
  assert.equal(rows[3].info.visible, true);
  assert.deepEqual(rows[3].info.chapterHits.map((h) => h.index), [1, 2, 3], '章名命中最多 3 条');
  assert.deepEqual(rows[3].info.chapterHits[0], { index: 1, name: '张三出场' });
});

test('shelfSearchResults：空查询全部可见 + 先按分组再按查询词过滤', () => {
  const books = [{ title: '张三', group: '甲组' }, { title: '张三', group: '乙组' }, { title: '李四', group: '甲组' }];
  const all = build({ books, shelfQuery: '' });
  const rows = all.ui.shelfSearchResults();
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.info), [
    { visible: true, titleMatch: false, infoMatch: false, chapterHits: [] },
    { visible: true, titleMatch: false, infoMatch: false, chapterHits: [] },
    { visible: true, titleMatch: false, infoMatch: false, chapterHits: [] }
  ]);

  const filtered = build({ books, shelfQuery: '张三', shelfGroup: '甲组' });
  assert.deepEqual(filtered.ui.shelfSearchResults().map((r) => r.book.title), ['张三']);
});

test('shelfContentActive：书架视图 + 查询词达到最少字数才算活跃', () => {
  assert.equal(build({ view: 'shelf', shelfQuery: '张' }).ui.shelfContentActive(), false);
  assert.equal(build({ view: 'shelf', shelfQuery: '张三' }).ui.shelfContentActive(), true);
  assert.equal(build({ view: 'editor', shelfQuery: '张三' }).ui.shelfContentActive(), false);
  assert.equal(build({ view: 'shelf', shelfQuery: '' }).ui.shelfContentActive(), false);
});

test('renderShelfContent：容器不在 / 不活跃时不报错、只把结果区藏起来', () => {
  const empty = makeHost({ dom: makeDom([]) });
  const ui = shelfFilterUi.create(empty.host);
  assert.doesNotThrow(() => ui.renderShelfContent());

  const ctx = build({ shelfQuery: '' });
  withDom(ctx.dom, () => ctx.ui.renderShelfContent());
  const wrap = ctx.dom.$('shelf-content');
  assert.equal(wrap.hasClass('hidden'), true);
  assert.equal(wrap.attrs['aria-busy'], 'false');
  assert.equal(ctx.dom.$('shelf-content-list').children.length, 0, '不活跃时一条结果都不渲染');
});

test('renderShelfContent：加载中 / 报错 / 字数不够三种摘要 + 没有结果时不插空态', () => {
  const loading = build({ shelfQuery: '张三', loading: true });
  withDom(loading.dom, () => loading.ui.renderShelfContent());
  assert.equal(loading.dom.$('shelf-content').attrs['aria-busy'], 'true');
  assert.equal(loading.dom.$('shelf-content-summary').textContent, '正在正文里查找…');
  assert.equal(loading.dom.$('shelf-content-list').children.length, 0);
  assert.equal(loading.dom.$('btn-shelf-content-more').hasClass('hidden'), true);

  const failed = build({ shelfQuery: '张三', error: 'boom' });
  withDom(failed.dom, () => failed.ui.renderShelfContent());
  assert.equal(failed.dom.$('shelf-content-summary').textContent, '正文搜索暂时不可用：boom');

  const short = build({ shelfQuery: '张三', meta: { tooShort: true } });
  withDom(short.dom, () => short.ui.renderShelfContent());
  assert.equal(short.dom.$('shelf-content-summary').textContent, '正文搜索至少 2 个字');
});

test('renderShelfContent：结果行 DOM（书名 / 章名 / 高亮片段 / 省略号 / 显示更多 / 点击打开）', () => {
  const hit = row();
  const ctx = build({
    shelfQuery: '张三',
    results: [
      hit,
      row({ bookTitle: '书乙', snippet: { before: '', match: '张三', after: '', cutBefore: true, cutAfter: true } }),
      row({ bookTitle: '书丙' })
    ],
    meta: { results: [hit, hit, hit], truncated: true, scannedBooks: 3, candidateBooks: 5 },
    shown: 2
  });
  withDom(ctx.dom, () => ctx.ui.renderShelfContent());
  const summary = ctx.dom.$('shelf-content-summary').textContent;
  assert.match(summary, /^正文命中 3 处（显示 2 条） · 只查了最近的一部分书 · 已查 3\/5 本 · 章号按全书顺序显示（书设为「每卷重新编号」时，写作页显示的是卷内号，两处不同）$/);

  const list = ctx.dom.$('shelf-content-list');
  assert.equal(list.children.length, 2);
  const first = list.children[0];
  assert.equal(first.tag, 'button');
  assert.equal(first.type, 'button');
  assert.equal(first.className, 'shelf-content-row');
  assert.equal(first.dataset.index, '0');
  assert.equal(first.children.length, 2, '结果行 = 标题行 + 片段行');
  const head = first.children[0];
  assert.equal(head.className, 'shelf-content-title');
  assert.equal(head.children[0].className, 'shelf-content-book');
  assert.equal(head.children[0].textContent, '书甲');
  assert.equal(head.children[1].className, 'shelf-content-chapter');
  assert.equal(head.children[1].textContent, '第3章·第三章');
  assert.deepEqual(ctx.calls.title[0], { index: 2, name: '第三章' });
  const snippet = first.children[1];
  assert.equal(snippet.className, 'shelf-content-snippet');
  assert.deepEqual(snippet.children.map((n) => n.textContent), ['前文', '张三', '后文']);
  assert.equal(snippet.children[1].tag, 'mark');
  const second = list.children[1].children[1];
  assert.deepEqual(second.children.map((n) => n.textContent), ['…', '', '张三', '', '…']);
  assert.equal(ctx.dom.$('btn-shelf-content-more').hasClass('hidden'), false);
  assert.equal(ctx.dom.$('btn-shelf-content-more').textContent, '显示更多（还有 1 条）');

  const event = { prevented: 0, stopped: 0, preventDefault() { this.prevented += 1; }, stopPropagation() { this.stopped += 1; } };
  first.handlers.click[0](event);
  assert.equal(event.prevented, 1);
  assert.equal(event.stopped, 1);
  assert.deepEqual(ctx.calls.open, [hit]);
});

test('renderShelfContent：没有结果时的空态两种文案（截断 / 全查了）', () => {
  const truncated = build({ shelfQuery: '张三', meta: { results: [], truncated: true } });
  withDom(truncated.dom, () => truncated.ui.renderShelfContent());
  let list = truncated.dom.$('shelf-content-list');
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].className, 'shelf-content-empty muted small');
  assert.equal(list.children[0].dataset.emptyKind, 'filtered');
  assert.equal(
    list.children[0].textContent,
    '最近的一部分书里没有找到。正文索引只查了最近的一部分书；换个更具体一点的词再试，或按 Esc 清空搜索。'
  );

  const full = build({ shelfQuery: '张三', meta: { results: [], truncated: false } });
  withDom(full.dom, () => full.ui.renderShelfContent());
  list = full.dom.$('shelf-content-list');
  assert.equal(list.children[0].dataset.emptyKind, 'filtered');
  assert.equal(list.children[0].textContent, '书名、章节名和正文里都没找到。换个更短或更具体的词再试；按 Esc 清空搜索。');
});

test('renderShelfContent：正文索引在建时摘要带进度（有 total / 没 total 两种）', () => {
  const withTotal = build({
    shelfQuery: '张三',
    indexStatus: { building: true, progress: { book: '书甲', books: 2, total: 9 } }
  });
  withDom(withTotal.dom, () => withTotal.ui.renderShelfContent());
  assert.match(withTotal.dom.$('shelf-content-summary').textContent, /正在为书架建正文索引（书甲 2\/9 本），建好后自动更新结果$/);

  const noTotal = build({ shelfQuery: '张三', indexStatus: { ready: false } });
  withDom(noTotal.dom, () => noTotal.ui.renderShelfContent());
  assert.match(noTotal.dom.$('shelf-content-summary').textContent, /正在为书架建正文索引，建好后自动更新结果$/);
});

// ---------- P22-4：正文命中按「书 + 章」聚合 + 展开本章全部 ----------
function groupKey(row) {
  return String(row.bookPath) + '\u0000' + String(row.chapterFile);
}

function contentRow(overrides = {}) {
  return row({
    bookPath: 'C:/tmp/books/书甲',
    chapterFile: '001-第一章.txt',
    chapterMatchCount: 10,
    chapterCountCapped: false,
    ...overrides
  });
}

function rowsOf(list) {
  return list.children.filter((child) => child.className === 'shelf-content-row');
}

function expandButtonOf(list) {
  return (
    list.children.find(
      (child) => child.tag === 'button' && String(child.className).includes('shelf-content-expand')
    ) || null
  );
}

test('renderShelfContent（P22-4）：按书 + 章分组，组头写「本章 N 处」，章内还有未列出命中时给展开按钮', () => {
  const firstChapter = [
    contentRow({ matchIndex: 0 }),
    contentRow({ matchIndex: 4 }),
    contentRow({ matchIndex: 8 })
  ];
  const secondChapter = [
    contentRow({
      chapterFile: '002-第四章.txt',
      chapterIndex: 3,
      chapterName: '第四章',
      chapterMatchCount: 2,
      matchIndex: 2
    }),
    contentRow({
      chapterFile: '002-第四章.txt',
      chapterIndex: 3,
      chapterName: '第四章',
      chapterMatchCount: 2,
      matchIndex: 6
    })
  ];
  const ctx = build({
    shelfQuery: '张三',
    results: firstChapter.concat(secondChapter),
    shown: 5,
    meta: {
      results: firstChapter.concat(secondChapter),
      totalMatches: 12,
      truncated: false,
      scannedBooks: 1,
      candidateBooks: 1
    }
  });
  withDom(ctx.dom, () => ctx.ui.renderShelfContent());
  const list = ctx.dom.$('shelf-content-list');
  const heads = list.children.filter((child) => child.className === 'shelf-content-group');
  assert.equal(heads.length, 2, '两章 → 两个组头');
  assert.equal(heads[0].textContent, '书甲 · 第3章·第三章 · 本章 10 处');
  assert.equal(heads[1].textContent, '书甲 · 第4章·第四章 · 本章 2 处');
  assert.equal(rowsOf(list).length, 5, '默认仍只列搜索带回来的 5 条');
  const button = expandButtonOf(list);
  assert.ok(button, '第一章 10 处 > 已列 3 条，要有「展开本章全部」');
  assert.equal(button.tag, 'button');
  assert.equal(button.type, 'button');
  assert.equal(button.textContent, '展开本章全部');
  assert.equal(button.attrs['aria-expanded'], 'false');
  assert.equal(button.dataset.group, groupKey(firstChapter[0]));
  assert.equal(
    list.children.filter((child) => String(child.className).includes('shelf-content-expand')).length,
    1,
    '第二章 2 处全部列出，不出现第二个展开按钮'
  );
  assert.match(ctx.dom.$('shelf-content-summary').textContent, /^正文命中 12 处（显示 5 条）/);

  const event = { prevented: 0, stopped: 0, preventDefault() { this.prevented += 1; }, stopPropagation() { this.stopped += 1; } };
  button.handlers.click[0](event);
  assert.equal(event.prevented, 1);
  assert.equal(event.stopped, 1);
  assert.deepEqual(ctx.calls.expand, [{ row: firstChapter[0], options: { collapse: false } }]);
});

test('renderShelfContent（P22-4）：展开后组内就地列出全部命中、按钮变「收起」，收起点回调 collapse', () => {
  const defaults = [
    contentRow({ matchIndex: 0 }),
    contentRow({ matchIndex: 4 }),
    contentRow({ matchIndex: 8 })
  ];
  const expandedRows = Array.from({ length: 10 }, (_, i) => contentRow({ matchIndex: i * 4 }));
  const expanded = {};
  expanded[groupKey(defaults[0])] = { loading: false, rows: expandedRows, error: null, truncated: false };
  const ctx = build({
    shelfQuery: '张三',
    results: defaults,
    shown: 3,
    expanded,
    meta: { results: defaults, totalMatches: 10, truncated: false, scannedBooks: 1, candidateBooks: 1 }
  });
  withDom(ctx.dom, () => ctx.ui.renderShelfContent());
  const list = ctx.dom.$('shelf-content-list');
  assert.equal(rowsOf(list).length, 10, '展开后列出该章全部 10 条（不是 3 + 10）');
  assert.equal(rowsOf(list)[0].children[1].children[1].textContent, '张三');
  const button = expandButtonOf(list);
  assert.equal(button.textContent, '收起');
  assert.equal(button.attrs['aria-expanded'], 'true');
  const event = { prevented: 0, stopped: 0, preventDefault() { this.prevented += 1; }, stopPropagation() { this.stopped += 1; } };
  button.handlers.click[0](event);
  assert.deepEqual(ctx.calls.expand, [{ row: defaults[0], options: { collapse: true } }]);
});

test('renderShelfContent（P22-4）：capped 显示「N+」，达到计数上限也能展开', () => {
  const rows = [contentRow({ chapterMatchCount: 10000, chapterCountCapped: true })];
  const ctx = build({ shelfQuery: '张三', results: rows, shown: 1, meta: { results: rows, totalMatches: 10000 } });
  withDom(ctx.dom, () => ctx.ui.renderShelfContent());
  const list = ctx.dom.$('shelf-content-list');
  const head = list.children.find((child) => child.className === 'shelf-content-group');
  assert.equal(head.textContent, '书甲 · 第3章·第三章 · 本章 10000+ 处');
  assert.equal(expandButtonOf(list).textContent, '展开本章全部');
});

test('renderShelfContent（P22-4）：展开中 / 展开失败 / 命中太多截断 / 展开后 0 条四种行内提示', () => {
  const defaults = [contentRow({ matchIndex: 0 }), contentRow({ matchIndex: 4 }), contentRow({ matchIndex: 8 })];
  const key = groupKey(defaults[0]);

  const loading = {};
  loading[key] = { loading: true, rows: [], error: null, truncated: false };
  const loadingCtx = build({ shelfQuery: '张三', results: defaults, shown: 3, expanded: loading, meta: { results: defaults } });
  withDom(loadingCtx.dom, () => loadingCtx.ui.renderShelfContent());
  let list = loadingCtx.dom.$('shelf-content-list');
  assert.equal(rowsOf(list).length, 3, '展开中仍显示默认 3 条');
  assert.ok(list.children.some((child) => child.className.includes('shelf-content-expand-note') && child.textContent === '正在展开本章全部命中…'));
  assert.equal(expandButtonOf(list).textContent, '展开中…');
  assert.equal(expandButtonOf(list).disabled, true);

  const failed = {};
  failed[key] = { loading: false, rows: [], error: '索引坏了', truncated: false };
  const failedCtx = build({ shelfQuery: '张三', results: defaults, shown: 3, expanded: failed, meta: { results: defaults } });
  withDom(failedCtx.dom, () => failedCtx.ui.renderShelfContent());
  list = failedCtx.dom.$('shelf-content-list');
  assert.ok(list.children.some((child) => child.className.includes('shelf-content-expand-error') && child.textContent === '展开失败：索引坏了'));

  const truncated = {};
  truncated[key] = { loading: false, rows: defaults, error: null, truncated: true };
  const truncatedCtx = build({ shelfQuery: '张三', results: defaults, shown: 3, expanded: truncated, meta: { results: defaults } });
  withDom(truncatedCtx.dom, () => truncatedCtx.ui.renderShelfContent());
  list = truncatedCtx.dom.$('shelf-content-list');
  assert.ok(list.children.some((child) => child.className.includes('shelf-content-expand-note') && child.textContent === '本章命中太多，只列出前 3 处'));

  const empty = {};
  empty[key] = { loading: false, rows: [], error: null, truncated: false };
  const emptyCtx = build({ shelfQuery: '张三', results: defaults, shown: 3, expanded: empty, meta: { results: defaults } });
  withDom(emptyCtx.dom, () => emptyCtx.ui.renderShelfContent());
  list = emptyCtx.dom.$('shelf-content-list');
  assert.ok(list.children.some((child) => child.className.includes('shelf-content-expand-note') && child.textContent === '这一章的命中已经找不到了（正文可能刚被改过）'));
  assert.equal(expandButtonOf(list).textContent, '展开本章全部');
});

test('renderShelfContent（P22-4）：没有 expandContentChapter 时仍按章聚合、只不出现展开按钮（可选 host 成员）', () => {
  const rows = [contentRow(), contentRow({ matchIndex: 2 })];
  const ctx = build({ shelfQuery: '张三', results: rows, shown: 2, meta: { results: rows } });
  delete ctx.host.expandContentChapter;
  withDom(ctx.dom, () => ctx.ui.renderShelfContent());
  const list = ctx.dom.$('shelf-content-list');
  assert.equal(rowsOf(list).length, 2, '结果行仍是两条');
  assert.equal(
    list.children.filter((child) => child.className === 'shelf-content-group').length,
    1,
    '按章聚合的组头仍在（10000 处上限 / 展开按钮只是少一个入口）'
  );
  assert.equal(expandButtonOf(list), null, '没有展开入口时不出现按钮');
  assert.equal(ctx.host.expandContentChapter, undefined);
});

test('updateShelfSearchUi（P22-4）：摘要里的「正文命中」用主进程真命中数（totalMatches）', () => {
  const ctx = build({
    shelfQuery: '灯芯',
    books: [{}],
    results: [contentRow()],
    meta: { results: [contentRow(), contentRow(), contentRow()], totalMatches: 12 }
  });
  ctx.ui.updateShelfSearchUi(0);
  assert.match(ctx.dom.$('shelf-search-summary').textContent, /正文命中 12 处/);
});

test('updateShelfSearchUi：没查询词时收起摘要并藏清除按钮', () => {
  const ctx = build({ shelfQuery: '' });
  const clear = ctx.dom.$('btn-shelf-search-clear');
  assert.doesNotThrow(() => ctx.ui.updateShelfSearchUi(0));
  assert.equal(clear.hasClass('hidden'), true);
  const summary = ctx.dom.$('shelf-search-summary');
  assert.equal(summary.hasClass('hidden'), true);
  assert.equal(summary.textContent, '');
});

test('updateShelfSearchUi：有命中 / 没命中 / 带分组与正文命中提示的逐字文案', () => {
  const hit = build({ shelfQuery: '张三', shelfGroup: '甲组', books: [{}, {}, {}, {}, {}], results: [row()], meta: { results: [row(), row()] } });
  hit.ui.updateShelfSearchUi(3);
  assert.equal(hit.dom.$('btn-shelf-search-clear').hasClass('hidden'), false);
  assert.equal(
    hit.dom.$('shelf-search-summary').textContent,
    '搜索「张三」：3 / 5 本书名 / 作者 / 分组 / 标签 / 章节名命中（已按分组筛选） · 正文命中 2 处（回车打开第一本，Esc 清除）'
  );

  const none = build({ shelfQuery: '李四', books: [{}, {}], results: [], meta: { results: [] } });
  none.ui.updateShelfSearchUi(0);
  assert.equal(none.dom.$('shelf-search-summary').textContent, '搜索「李四」：没有匹配的书名 / 作者 / 分组 / 标签 / 章节名，正文也没有找到（Esc 清除）');

  const loading = build({ shelfQuery: '王五', books: [{}], loading: true });
  loading.ui.updateShelfSearchUi(0);
  assert.equal(loading.dom.$('shelf-search-summary').textContent, '搜索「王五」：没有匹配的书名 / 作者 / 分组 / 标签 / 章节名 · 正在搜正文…（Esc 清除）');
});

test('静态闸门：renderer.js 里不许长回实现，装配只有一处，7 个入口按名字接线', () => {
  for (const shape of [
    'function shelfQueryText(',
    'function bookGroupOf(',
    'function shelfGroupList(',
    'function shelfGroupMatches(',
    'function matchBookForSearch(',
    'function shelfSearchResults(',
    'function shelfContentActive(',
    'function renderShelfContent(',
    'function updateShelfSearchUi('
  ]) {
    assert.equal(rendererSrc.includes(shape), false, 'renderer.js 不许再定义 ' + shape);
  }
  assert.equal(rendererSrc.split('shelfFilterUiModule.create(').length - 1, 1, '装配只许一处');
  for (const member of shelfFilterUi.REQUIRED_HOST) {
    assert.ok(rendererSrc.includes(member), 'host 成员必须逐个点名：' + member);
  }
  for (const entry of ['shelfQueryText', 'bookGroupOf', 'shelfGroupList', 'shelfSearchResults', 'shelfContentActive', 'renderShelfContent', 'updateShelfSearchUi']) {
    assert.ok(rendererSrc.includes(entry), '入口必须按原名取用：' + entry);
  }
  assert.match(rendererSrc, /const \{ shelfQueryText, bookGroupOf, shelfGroupList, shelfSearchResults, shelfContentActive, renderShelfContent, updateShelfSearchUi \} = shelfFilterUi;/);
  assert.ok(rendererSrc.includes('openContentResult: (row) => openContentResult(row)'), '正文搜索模块晚一步交出 openContentResult，惰性转发');
});

test('静态闸门：index.html 顺序（statusbar-ui → shelf-filter-ui → shelf-search-ui → renderer.js）且只加载一次', () => {
  const rendererAt = indexSrc.indexOf('<script src="renderer.js"></script>');
  const filterAt = indexSrc.indexOf('<script src="shelf-filter-ui.js"></script>');
  const searchAt = indexSrc.indexOf('<script src="shelf-search-ui.js"></script>');
  assert.ok(rendererAt > 0 && filterAt > 0 && searchAt > 0);
  assert.ok(filterAt < searchAt && searchAt < rendererAt, 'shelf-filter-ui.js 必须排在 shelf-search-ui.js / renderer.js 之前');
  assert.ok(indexSrc.indexOf('<script src="statusbar-ui.js"></script>') < filterAt);
  assert.equal(indexSrc.split('shelf-filter-ui.js').length - 1, 1, '只加载一次');
  assert.ok(rendererSrc.includes('window.CWShelfFilterUi'), '渲染层按 CWShelfFilterUi 取模块');
});

test('静态闸门：模块不许 require / ipcRenderer / fs / 网络 / window 全局，不写 state', () => {
  for (const forbidden of ['require(', 'ipcRenderer', 'node:fs', 'child_process', 'localStorage', 'fetch(', 'window.']) {
    assert.equal(moduleCode.includes(forbidden), false, 'shelf-filter-ui.js 不许出现 ' + forbidden);
  }
  assert.equal(/(^|[^.\w])state(?:\.[A-Za-z_$][\w$]*)?\s*=[^=]/m.test(moduleCode), false, '模块只读 state，不许写');
});

test('UMD：浏览器分支挂成 CWShelfFilterUi，不顺手造别的全局', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(moduleSrc, context, { filename: 'renderer/shelf-filter-ui.js' });
  assert.equal(typeof win.CWShelfFilterUi, 'object');
  assert.equal(typeof win.CWShelfFilterUi.create, 'function');
  assert.deepEqual([...win.CWShelfFilterUi.REQUIRED_HOST].sort(), ['$', 'CONTENT_SEARCH_MIN_CHARS', 'bookInfoLib', 'chapterTitle', 'openContentResult', 'state']);
  assert.equal(win.CWShelfSearchUi, undefined, '单独加载 shelf-filter 不该顺手造出别的全局');
});

// ---------- 标签筛选（1.6.0 F5） ----------
test('标签筛选：按全名精确匹配，和分组 / 搜索词是 AND', () => {
  const books = [
    { title: '甲', group: '玄幻', tags: ['升级', '爽文'] },
    { title: '乙', group: '玄幻', tags: ['悬疑'] },
    { title: '丙', group: '短篇', tags: ['升级'] },
    { title: '丁', group: '短篇', tags: [] }
  ];
  const titles = (ctx) => ctx.ui.shelfSearchResults().map((r) => r.book.title);
  assert.deepEqual(titles(build({ books, shelfQuery: '' })), ['甲', '乙', '丙', '丁']);
  assert.deepEqual(titles(build({ books, shelfQuery: '', shelfTag: '升级' })), ['甲', '丙']);
  assert.deepEqual(titles(build({ books, shelfQuery: '', shelfTag: '升级', shelfGroup: '玄幻' })), ['甲']);
  assert.deepEqual(titles(build({ books, shelfQuery: '乙', shelfTag: '升级' })), [], '搜索命中但标签不符 → 不显示');
  assert.deepEqual(titles(build({ books, shelfQuery: '甲', shelfTag: '升级' })), ['甲'], '搜索与标签都满足才显示');
  assert.deepEqual(titles(build({ books, shelfQuery: '', shelfTag: '升' })), [], '标签只认全名，不做子串');
  assert.deepEqual(titles(build({ books, shelfQuery: '', shelfTag: '不存在' })), []);
});

test('搜索摘要（F5）：只有分组 / 只有标签 / 两者都有时分别注明筛选条件', () => {
  const onlyTag = build({ shelfQuery: '张三', shelfTag: '升级', books: [{}, {}, {}], results: [] });
  onlyTag.ui.updateShelfSearchUi(2);
  assert.equal(
    onlyTag.dom.$('shelf-search-summary').textContent,
    '搜索「张三」：2 / 3 本书名 / 作者 / 分组 / 标签 / 章节名命中（已按标签筛选）（回车打开第一本，Esc 清除）'
  );

  const both = build({ shelfQuery: '张三', shelfGroup: '甲组', shelfTag: '升级', books: [{}, {}, {}], results: [] });
  both.ui.updateShelfSearchUi(1);
  assert.equal(
    both.dom.$('shelf-search-summary').textContent,
    '搜索「张三」：1 / 3 本书名 / 作者 / 分组 / 标签 / 章节名命中（已按分组筛选）（已按标签筛选）（回车打开第一本，Esc 清除）'
  );
});
