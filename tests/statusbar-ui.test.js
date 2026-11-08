const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const statusbarUi = require('../renderer/statusbar-ui');
const editorLogic = require('../renderer/editor-logic');
const chaptersLib = require('../core/chapters');
const commonLib = require('../core/common');
const { loadSourceGate, restoreGlobalsAfter } = require('./ui-test-preambles');

// v0.9 B-5 第七刀：两个小分区（「状态栏」79 行 +「外部修改检测」32 行，合计 111 行）从
// renderer.js 搬到 renderer/statusbar-ui.js。搬之前这两块只有 E2E 黑盒覆盖（打字看本章字数 /
// 选字看选中字数 / 回到前台弹一次外部修改），「超大单章 400ms 防抖怎么算 / 上一章没字数不比较 /
// mtime 没变不打扰 / 有未保存修改只警告 / 失焦不到 500ms 忽略」这些分支在 Node 里一步都测不到。
// 搬出来以后用「假 host + 假 DOM + 假 window」逐条钉住文案与行为，再用静态闸门保证渲染层
// 不许长回第二份实现。

// 模块运行时会摸 document / window：真身由共享前导存下，test.after 放回。
restoreGlobalsAfter(test, ['document', 'window']);

const { rendererSrc, indexSrc, moduleSrc, moduleCode } = loadSourceGate('statusbar-ui.js');

// 渲染层 formatChars 的同一份口径（renderer.js 里是函数声明；模块通过 host 拿到）
function formatChars(n) {
  const value = Number(n) || 0;
  if (value < 10000) return `${value} 字`;
  if (value < 100000000) return `${(value / 10000).toFixed(2)} 万字`;
  return `${(value / 100000000).toFixed(2)} 亿字`;
}

function makeEl(id) {
  const classes = new Set();
  return {
    id,
    textContent: '',
    title: '',
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains: (name) => classes.has(name)
    },
    _classes: classes
  };
}

function makeHost(options = {}) {
  const els = new Map();
  const calls = { stat: [], call: [], toast: [], modal: [], load: [] };
  const state = {
    view: options.view || 'editor',
    bookPath: options.bookPath === undefined ? 'C:/tmp/books/测试书' : options.bookPath,
    index: options.index === undefined ? 0 : options.index,
    chapters: options.chapters || [
      { id: 'c1', name: '第一章', file: '0001.txt', chars: 0 },
      { id: 'c2', name: '第二章', file: '0002.txt', chars: 0 }
    ],
    loadedMtimeMs: options.loadedMtimeMs === undefined ? 111 : options.loadedMtimeMs,
    dirty: Boolean(options.dirty),
    loading: Boolean(options.loading),
    saving: Boolean(options.saving),
    modal: Boolean(options.modal),
    reading: { open: Boolean(options.readingOpen) }
  };
  const editorEl = {
    value: options.text || '',
    selectionStart: options.selectionStart || 0,
    selectionEnd: options.selectionEnd || 0
  };
  const host = {
    $: (id) => {
      if (options.missing && options.missing.includes(id)) return null;
      if (!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
    state,
    editorEl,
    formatChars,
    formatCount: commonLib.formatCount,
    chaptersLib: options.chaptersLib || chaptersLib,
    editorLogic: options.editorLogic || editorLogic,
    call: async (fn, ...args) => {
      calls.call.push(args);
      return fn(...args);
    },
    api: {
      statChapter: async (bookPath, file) => {
        calls.stat.push([bookPath, file]);
        if (options.statThrows) throw new Error('stat 失败');
        return { mtimeMs: options.mtimeMs === undefined ? 111 : options.mtimeMs };
      }
    },
    toast: (message, kind) => { calls.toast.push([message, kind]); },
    openModal: async (payload) => {
      calls.modal.push(payload);
      return { action: options.modalAction || 'keep' };
    },
    loadChapterAt: async (index) => {
      calls.load.push(index);
      return { ok: true };
    }
  };
  return { host, state, els, editorEl, calls };
}

// 模块的 setupExternalChangeWatch() 直接摸 window.addEventListener；Node 里给一个最小替身。
function installWindow() {
  const listeners = {};
  globalThis.window = {
    addEventListener(type, fn) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(fn);
    }
  };
  return listeners;
}

test('host 契约：12 个成员缺任何一个都抛 TypeError，空 host / null 也抛', () => {
  const { host } = makeHost();
  assert.deepEqual(
    [...statusbarUi.REQUIRED_HOST].sort(),
    ['$', 'state', 'editorEl', 'formatChars', 'formatCount', 'chaptersLib', 'editorLogic', 'call', 'api', 'toast', 'openModal', 'loadChapterAt'].sort()
  );
  assert.throws(() => statusbarUi.create(null), /createStatusbarUi 需要 host 对象/);
  assert.throws(() => statusbarUi.create('x'), /createStatusbarUi 需要 host 对象/);
  for (const key of statusbarUi.REQUIRED_HOST) {
    const broken = { ...host };
    delete broken[key];
    assert.throws(() => statusbarUi.create(broken), /缺少/, key);
    const nulled = { ...host, [key]: null };
    assert.throws(() => statusbarUi.create(nulled), /缺少/, key + '（null 也算缺）');
  }
  assert.doesNotThrow(() => statusbarUi.create(host));
});

test('create() 只建表：没有 document / window 也建得出来，交出的入口都是函数', () => {
  delete globalThis.document;
  delete globalThis.window;
  const { host } = makeHost();
  const ui = statusbarUi.create(host);
  assert.deepEqual(Object.keys(ui).sort(), ['chapterCharsOf', 'renderCharCount', 'renderSelectionStats', 'setupExternalChangeWatch']);
  for (const name of Object.keys(ui)) assert.equal(typeof ui[name], 'function', name);
  // 内部件不导出（charCountTimer / updateCharCountText / lastBlurAt 都是模块内部状态）
  assert.equal(ui.updateCharCountText, undefined);
  assert.equal(ui.charCountTimer, undefined);
});

test('chapterCharsOf：null / 缺失 / 非法 / 负数都算没有，合法值四舍五入', () => {
  const { host } = makeHost();
  const { chapterCharsOf } = statusbarUi.create(host);
  assert.equal(chapterCharsOf(null), null);
  assert.equal(chapterCharsOf({}), null);
  assert.equal(chapterCharsOf({ chars: 'abc' }), null);
  assert.equal(chapterCharsOf({ chars: -1 }), null);
  assert.equal(chapterCharsOf({ chars: 0 }), 0);
  assert.equal(chapterCharsOf({ chars: 12 }), 12);
  assert.equal(chapterCharsOf({ chars: '12.6' }), 13);
  assert.equal(chapterCharsOf({ chars: '  7  ' }), 7);
});

test('updateCharCountText：没书 / 章节下标为负 / 元素不在 → 清空文案与提示，不报错', () => {
  const noEl = makeHost({ missing: ['char-count'] });
  assert.doesNotThrow(() => statusbarUi.create(noEl.host).renderCharCount());

  const noBook = makeHost({ bookPath: '' });
  statusbarUi.create(noBook.host).renderCharCount();
  const el = noBook.els.get('char-count');
  assert.equal(el.textContent, '');
  assert.equal(el.title, '');
  assert.equal(el.classList.contains('count-short'), false);
  // 1.3.0 T7：中段整段收起（第 N 章 + 本章字数都不显示）
  assert.equal(noBook.els.get('status-chapter').classList.contains('hidden'), true);
  assert.equal(noBook.els.get('status-chapter-label').textContent, '');

  const negIndex = makeHost({ index: -1 });
  statusbarUi.create(negIndex.host).renderCharCount();
  assert.equal(negIndex.els.get('char-count').textContent, '');
  assert.equal(negIndex.els.get('status-chapter').classList.contains('hidden'), true);
});

test('updateCharCountText：正常章节即时算，文案与 title 逐字', () => {
  const { host, els } = makeHost({ text: '你好 世界', index: 0 });
  statusbarUi.create(host).renderCharCount();
  const el = els.get('char-count');
  assert.equal(el.textContent, '本章 4 字');
  assert.equal(el.title, '本章字数（不含空白）；未保存的编辑也算。');
  assert.equal(el.classList.contains('count-short'), false);
  // 1.3.0 T7（规范 C-05 / I-01）：中段「第 N 章 · 本章 X 字」——章节位置与标题栏同一口径
  assert.equal(els.get('status-chapter-label').textContent, '第1章');
  assert.equal(els.get('status-chapter').classList.contains('hidden'), false);
});

test('updateCharCountText：比上一章短 ≥40% → 追加软提示、加 count-short、title 换成完整说明', () => {
  const { host, els } = makeHost({
    text: 'x'.repeat(100),
    index: 1,
    chapters: [
      { id: 'c1', name: '第一章', file: '0001.txt', chars: 1000 },
      { id: 'c2', name: '第二章', file: '0002.txt', chars: 100 }
    ]
  });
  statusbarUi.create(host).renderCharCount();
  const el = els.get('char-count');
  assert.equal(el.textContent, '本章 100 字 · 比上章短 90%');
  assert.equal(el.classList.contains('count-short'), true);
  assert.equal(
    el.title,
    '本章 100 字，上一章 1,000 字（短了 90%）。只是提醒，不改任何东西；如果这一章还没写完，可能是漏了内容。'
  );
});

test('updateCharCountText：上一章没字数 / 太短（<500）→ 不比较、不加提示', () => {
  const noCache = makeHost({ text: 'x'.repeat(100), index: 1 });
  statusbarUi.create(noCache.host).renderCharCount();
  assert.equal(noCache.els.get('char-count').textContent, '本章 100 字');
  assert.equal(noCache.els.get('char-count').classList.contains('count-short'), false);

  const tooShort = makeHost({
    text: 'x'.repeat(100),
    index: 1,
    chapters: [
      { id: 'c1', name: '第一章', file: '0001.txt', chars: 100 },
      { id: 'c2', name: '第二章', file: '0002.txt', chars: 100 }
    ]
  });
  statusbarUi.create(tooShort.host).renderCharCount();
  assert.equal(tooShort.els.get('char-count').textContent, '本章 100 字');
  assert.equal(tooShort.els.get('char-count').classList.contains('count-short'), false);
});

test('renderCharCount：超大单章（>20 万字符）走 400ms 防抖，连打几次只算最后一次', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let counted = 0;
    const { host, els, editorEl } = makeHost({
      text: 'x'.repeat(200001),
      chaptersLib: {
        countChars(text) {
          counted += 1;
          return chaptersLib.countChars(text);
        }
      }
    });
    const ui = statusbarUi.create(host);
    const el = host.$('char-count');
    ui.renderCharCount();
    assert.equal(counted, 0, '200001 字符时不许同步算');
    assert.equal(el.textContent, '');
    editorEl.value = 'y'.repeat(200002);
    ui.renderCharCount();
    t.mock.timers.tick(399);
    assert.equal(counted, 0, '400ms 之前不算');
    t.mock.timers.tick(1);
    assert.equal(counted, 1, '两次调用只算最后一次');
    assert.equal(el.textContent, '本章 20.00 万字');
  } finally {
    t.mock.timers.reset();
  }
});

test('renderCharCount：20 万字符以内同步算，并清掉上一个待跑的定时器', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { host, els, editorEl } = makeHost({ text: 'x'.repeat(200001) });
    const ui = statusbarUi.create(host);
    ui.renderCharCount(); // 起一个 400ms 定时器
    editorEl.value = 'x'.repeat(5); // 换成小文本
    ui.renderCharCount(); // 应清掉定时器、同步算
    assert.equal(els.get('char-count').textContent, '本章 5 字');
    t.mock.timers.tick(400);
    assert.equal(els.get('char-count').textContent, '本章 5 字', '旧定时器不许再写一遍');
  } finally {
    t.mock.timers.reset();
  }
});

test('renderSelectionStats：没元素 / 非编辑视图 / 没书 / 下标为负 → 隐藏并清空', () => {
  assert.doesNotThrow(() => statusbarUi.create(makeHost({ missing: ['status-selection'] }).host).renderSelectionStats());

  const shelf = makeHost({ view: 'shelf' });
  statusbarUi.create(shelf.host).renderSelectionStats();
  assert.equal(shelf.els.get('status-selection').classList.contains('hidden'), true);
  assert.equal(shelf.els.get('status-selection').textContent, '');

  const noBook = makeHost({ bookPath: '' });
  statusbarUi.create(noBook.host).renderSelectionStats();
  assert.equal(noBook.els.get('status-selection').classList.contains('hidden'), true);

  const negIndex = makeHost({ index: -1 });
  statusbarUi.create(negIndex.host).renderSelectionStats();
  assert.equal(negIndex.els.get('status-selection').classList.contains('hidden'), true);
});

test('renderSelectionStats：没真选字 / 只选了空白 → 隐藏', () => {
  const collapsed = makeHost({ text: 'abc', selectionStart: 1, selectionEnd: 1 });
  statusbarUi.create(collapsed.host).renderSelectionStats();
  assert.equal(collapsed.els.get('status-selection').classList.contains('hidden'), true);

  const blank = makeHost({ text: 'abc\ndef', selectionStart: 3, selectionEnd: 4 });
  statusbarUi.create(blank.host).renderSelectionStats();
  assert.equal(blank.els.get('status-selection').classList.contains('hidden'), true);
  assert.equal(blank.els.get('status-selection').textContent, '');
});

test('renderSelectionStats：正常选区 → 「选中 N 字 / M 段」与 title 逐字，去掉 hidden', () => {
  const { host, els } = makeHost({ text: '第一段\n第二段', selectionStart: 0, selectionEnd: 7 });
  statusbarUi.create(host).renderSelectionStats();
  const el = els.get('status-selection');
  assert.equal(el.classList.contains('hidden'), false);
  assert.equal(el.textContent, '选中 6 字 / 2 段');
  assert.equal(el.title, '选中的字数（不含空白，和「本章字数」同口径）与触及的自然段数');
});

test('setupExternalChangeWatch：只在 window 上挂 blur / focus 两个监听', () => {
  const listeners = installWindow();
  const { host } = makeHost();
  statusbarUi.create(host).setupExternalChangeWatch();
  assert.deepEqual(Object.keys(listeners).sort(), ['blur', 'focus']);
  assert.equal(listeners.blur.length, 1);
  assert.equal(listeners.focus.length, 1);
});

test('外部修改检测：没书 / 加载中 / 保存中 / 弹层开着 / 阅读模式 / 失焦不到 500ms 都不查文件', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  try {
    const cases = [
      { bookPath: '' },
      { index: -1 },
      { loading: true },
      { saving: true },
      { modal: true },
      { readingOpen: true }
    ];
    for (const options of cases) {
      const listeners = installWindow();
      const { host, calls } = makeHost(options);
      statusbarUi.create(host).setupExternalChangeWatch();
      await listeners.focus[0]();
      assert.equal(calls.stat.length, 0, JSON.stringify(options));
    }
    // 失焦 499ms 回来：忽略；满 500ms 才查
    const listeners = installWindow();
    const { host, calls } = makeHost();
    statusbarUi.create(host).setupExternalChangeWatch();
    listeners.blur[0]();
    t.mock.timers.tick(499);
    await listeners.focus[0]();
    assert.equal(calls.stat.length, 0, '499ms 不许查');
    t.mock.timers.tick(1);
    await listeners.focus[0]();
    assert.equal(calls.stat.length, 1, '500ms 要查一次');
  } finally {
    t.mock.timers.reset();
  }
});

test('外部修改检测：mtime 没变 → 不弹框不重载', async () => {
  const listeners = installWindow();
  const { host, calls } = makeHost({ loadedMtimeMs: 111, mtimeMs: 111 });
  statusbarUi.create(host).setupExternalChangeWatch();
  await listeners.focus[0]();
  assert.deepEqual(calls.stat, [['C:/tmp/books/测试书', '0001.txt']]);
  assert.deepEqual(calls.toast, []);
  assert.deepEqual(calls.modal, []);
  assert.deepEqual(calls.load, []);
});

test('外部修改检测：变了 + 有未保存修改 → 只 toast 警告（warn），不弹框不重载', async () => {
  const listeners = installWindow();
  const { host, calls } = makeHost({ loadedMtimeMs: 111, mtimeMs: 222, dirty: true });
  statusbarUi.create(host).setupExternalChangeWatch();
  await listeners.focus[0]();
  assert.deepEqual(calls.toast, [['本章在应用外被修改过；你还有未保存的修改，保存会覆盖外部内容', 'warn']]);
  assert.deepEqual(calls.modal, []);
  assert.deepEqual(calls.load, []);
});

test('外部修改检测：变了 + 没未保存修改 → 询问框逐字；保留当前不重载，重新加载才 loadChapterAt', async () => {
  const keep = installWindow();
  const kept = makeHost({ loadedMtimeMs: 111, mtimeMs: 222, modalAction: 'keep' });
  statusbarUi.create(kept.host).setupExternalChangeWatch();
  await keep.focus[0]();
  assert.equal(kept.calls.modal.length, 1);
  assert.deepEqual(kept.calls.modal[0], {
    title: '检测到外部修改',
    message: '当前章节文件在应用外被修改过（可能是用记事本改的）。要重新加载磁盘上的内容吗？',
    buttons: [
      { label: '重新加载', value: 'reload', kind: 'primary' },
      { label: '保留当前', value: 'keep' }
    ]
  });
  assert.deepEqual(kept.calls.load, []);

  const reload = installWindow();
  const reloaded = makeHost({ loadedMtimeMs: 111, mtimeMs: 222, modalAction: 'reload' });
  statusbarUi.create(reloaded.host).setupExternalChangeWatch();
  await reload.focus[0]();
  assert.deepEqual(reloaded.calls.load, [0]);
});

test('外部修改检测：stat 抛错（文件可能被删）→ 静默吞掉；章节不在 → 不查', async () => {
  const listeners = installWindow();
  const { host, calls } = makeHost({ statThrows: true });
  statusbarUi.create(host).setupExternalChangeWatch();
  await assert.doesNotReject(() => listeners.focus[0]());
  assert.equal(calls.stat.length, 1);
  assert.deepEqual(calls.toast, []);
  assert.deepEqual(calls.modal, []);

  const missing = installWindow();
  const bad = makeHost({ index: 5 });
  statusbarUi.create(bad.host).setupExternalChangeWatch();
  await missing.focus[0]();
  assert.deepEqual(bad.calls.stat, []);
});

test('静态闸门：两段实现已经不在 renderer.js 里，渲染层只剩接线', () => {
  for (const impl of [
    '  function chapterCharsOf(chapter) {',
    '  function updateCharCountText() {',
    '  function renderCharCount() {',
    '  function renderSelectionStats() {',
    '  let charCountTimer = null;',
    '  const CHAR_COUNT_DEFER_ABOVE = 200000;',
    "  window.addEventListener('blur', () => {",
    "  window.addEventListener('focus', async () => {"
  ]) {
    assert.equal(rendererSrc.includes(impl), false, impl);
  }
  // 装配只有一处，host 成员逐个点名
  assert.equal((rendererSrc.match(/statusbarUiModule\.create\(/g) || []).length, 1);
  for (const key of ['$', 'state', 'editorEl', 'formatChars', 'chaptersLib', 'editorLogic', 'call', 'api', 'toast', 'openModal', 'loadChapterAt']) {
    assert.match(rendererSrc, new RegExp('statusbarUiModule\\.create\\(\\{[\\s\\S]{0,400}' + key.replace(/\$/g, '\\$') + '(?=[,\\s}])'));
  }
  // 入口仍以原名在渲染层可见（章节列表 / 写作时长 / 编辑器小件 / 测试钩子按名字取）
  assert.match(rendererSrc, /const \{ chapterCharsOf, renderCharCount, renderSelectionStats \} = statusbarUi;/);
  assert.match(rendererSrc, /statusbarUi\.setupExternalChangeWatch\(\);/);
  assert.equal((rendererSrc.match(/statusbarUi\.setupExternalChangeWatch\(\);/g) || []).length, 1);
  // 测试钩子宿主契约里的键还在
  assert.match(rendererSrc, /\r?\n      renderSelectionStats,\r?\n/);
});

test('静态闸门：index.html 在 renderer.js 之前加载 statusbar-ui.js，且只加载一次', () => {
  const at = indexSrc.indexOf('<script src="statusbar-ui.js"></script>');
  const rendererAt = indexSrc.indexOf('<script src="renderer.js"></script>');
  assert.notEqual(at, -1);
  assert.notEqual(rendererAt, -1);
  assert.ok(at < rendererAt, 'statusbar-ui.js 必须排在 renderer.js 之前');
  assert.equal(indexSrc.split('statusbar-ui.js').length - 1, 1);
  // 模块自己挂全局 CWStatusbarUi，渲染层按这个全局名字取
  assert.match(moduleSrc, /root\.CWStatusbarUi = factory\(\);/);
  assert.match(rendererSrc, /const statusbarUiModule = window\.CWStatusbarUi;/);
});

test('静态闸门：模块只读 state / 只碰 DOM 与 window，不摸文件系统与 IPC', () => {
  for (const forbidden of ['require(', 'ipcRenderer', 'node:fs', 'child_process', 'localStorage', 'fetch(', 'document.']) {
    assert.equal(moduleCode.includes(forbidden), false, forbidden);
  }
  // 只读 state：一处写都没有（外部修改检测也只读 state）
  assert.equal(/state\.[A-Za-z_$][\w$]*\s*=/.test(moduleCode), false, '模块不许写 state');
  // 事件监听只许 blur / focus 两个，且没有别的监听
  const listens = [...moduleCode.matchAll(/addEventListener\('([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(listens.sort(), ['blur', 'focus']);
  assert.equal(moduleCode.includes('removeEventListener'), false);
  // 两个阈值写死在模块里（搬走前就在这一段）
  assert.match(moduleCode, /const CHAR_COUNT_DEFER_ABOVE = 200000;/);
  assert.match(moduleCode, /since < 500/);
  assert.match(moduleCode, /\}, 400\);/);
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWStatusbarUi，且不乱造别的全局', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(moduleSrc, context, { filename: 'renderer/statusbar-ui.js' });
  assert.equal(typeof win.CWStatusbarUi, 'object');
  assert.deepEqual(Object.keys(win.CWStatusbarUi).sort(), ['REQUIRED_HOST', 'create']);
  assert.deepEqual(Array.from(win.CWStatusbarUi.REQUIRED_HOST), Array.from(statusbarUi.REQUIRED_HOST));
  assert.equal(typeof win.CWStatusbarUi.create, 'function');
  assert.equal(win.CWExportUi, undefined, '单独加载 statusbar-ui 不该顺手造出别的全局');
  assert.equal(win.CWChapters, undefined);
});
