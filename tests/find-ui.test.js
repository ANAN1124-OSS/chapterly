const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const findUi = require('../renderer/find-ui');
const imeGuard = require('../renderer/ime-guard');
const longOpLogic = require('../renderer/long-op-logic');
const staleGuard = require('../renderer/stale-guard');
const findLogic = require('../renderer/find-logic');
const chaptersLib = require('../core/chapters');

// 第 4 步 renderer 九刀·补刀 9a：查找 / 替换核心（原 renderer.js 的「查找会话」213 行 +「查找替换」41 行 +
// 「本书历史」分区里残留的查找面板 218 行）搬到 renderer/find-ui.js。
// 搬之前只有 E2E 黑盒覆盖（Ctrl+F → 查当前章 / 整本 → 点结果 → 替换）；高亮窗口 / 当前命中 class /
// 令牌与旧结果 / F3 环绕提示 / 整本清单结构 / 当前章替换撤销链 / 整本替换确认与备份提示在 Node 里都测不到。
// 搬出来以后用「假 host + 假 DOM」逐条钉住，再用静态闸门保证渲染层不长回第二份。
//
// 契约：host 10 个成员 = 基础 5（$, state, api, call, toast）+ imeGuard（输入法组字守卫，WP-04）+
// longOpLogic（整本替换回执的书身份判定，WP-13/C2）+ find{...} + nav{...} + collab{...11 个跨域回调，其中 4 个惰性转发}。

const realDocument = globalThis.document;
const realWindow = globalThis.window;
test.after(() => {
  if (realDocument === undefined) delete globalThis.document;
  else globalThis.document = realDocument;
  if (realWindow === undefined) delete globalThis.window;
  else globalThis.window = realWindow;
});
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const moduleSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'find-ui.js'), 'utf8');
const moduleCode = moduleSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------- 假 DOM ----------
function makeEl(tag = 'div', id = '') {
  const classes = new Set();
  const listeners = [];
  const el = {
    tagName: tag, id, className: '', textContent: '', title: '', value: '', checked: false, disabled: false,
    dataset: {}, children: [], parentNode: null, scrollTop: 0, scrollLeft: 0,
    _classes: classes, _listeners: listeners, _attrs: {}, _focus: 0, selectionStart: 0, selectionEnd: 0,
    classList: {
      add: (...n) => n.forEach((x) => classes.add(x)),
      remove: (...n) => n.forEach((x) => classes.delete(x)),
      contains: (n) => classes.has(n),
      toggle(n, on) {
        const next = on === undefined ? !classes.has(n) : Boolean(on);
        if (next) classes.add(n);
        else classes.delete(n);
      }
    },
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); String(v || '').split(/\s+/).filter(Boolean).forEach((x) => classes.add(x)); },
    append(...n) { n.forEach((x) => el.appendChild(x)); },
    appendChild(child) {
      if (child && child._isFragment) {
        child.children.slice().forEach((c) => el.appendChild(c));
        child.children.length = 0;
        return child;
      }
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    setAttribute(k, v) { el._attrs[k] = v; },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el._attrs, k) ? el._attrs[k] : null; },
    focus() { el._focus += 1; },
    select() { el._selected = true; },
    setSelectionRange(start, end) { el.selectionStart = start; el.selectionEnd = end; },
    querySelectorAll(selector) {
      const out = [];
      const ordinal = /^\.find-hit\[data-ordinal="(\d+)"\]$/.exec(selector);
      const cls = /^\.([\w-]+)$/.exec(selector);
      const visit = (node) => {
        for (const c of node.children || []) {
          if (ordinal && c.dataset.ordinal === ordinal[1]) out.push(c);
          else if (cls && String(c.className).split(/\s+/).includes(cls[1])) out.push(c);
          visit(c);
        }
      };
      visit(el);
      return out;
    },
    querySelector(selector) { return el.querySelectorAll(selector)[0] || null; },
    _fire(type, event) {
      let result;
      for (const l of listeners) if (l.type === type) result = l.fn(event);
      return result;
    }
  };
  Object.defineProperty(el, 'innerHTML', { get() { return ''; }, set() { el.children.length = 0; } });
  let textValue = '';
  Object.defineProperty(el, 'textContent', {
    get() { return el.children.length ? '' : textValue; },
    set(value) { textValue = String(value); el.children.length = 0; }
  });
  return el;
}
function makeDocument() {
  const map = new Map();
  let lookups = 0;
  const doc = {
    createElement: (tag) => makeEl(tag),
    createTextNode(text) { const n = makeEl('#text'); n._textNode = true; n.textContent = text; return n; },
    createDocumentFragment() { const frag = makeEl('fragment'); frag._isFragment = true; return frag; },
    execCommand: null,
    getElementById: (id) => { lookups += 1; return map.get(id) || null; }
  };
  return {
    doc, map,
    get lookups() { return lookups; },
    $: (id) => doc.getElementById(id),
    ensure(id) { if (!map.has(id)) map.set(id, makeEl('div', id)); return map.get(id); }
  };
}

const BASE_IDS = [
  'editor-find-marks', 'find-backdrop', 'find-query', 'find-case', 'find-scope', 'find-replace',
  'find-nav-count', 'status-find', 'find-summary', 'find-results', 'proofread-backdrop',
  'btn-find', 'btn-find-run', 'btn-find-prev', 'btn-find-next', 'btn-find-replace-one', 'btn-find-replace', 'btn-find-close'
];

function collectText(node) {
  if (!node) return '';
  if (node._textNode) return String(node.textContent);
  if (!node.children || node.children.length === 0) return String(node.textContent || '');
  return node.children.map((c) => collectText(c)).join('');
}

function build(options = {}) {
  const dom = options.dom || makeDocument();
  for (const id of BASE_IDS) dom.ensure(id);
  dom.map.get('editor-find-marks').classList.add('hidden');
  dom.map.get('find-backdrop').classList.add('hidden');
  dom.map.get('proofread-backdrop').classList.add('hidden');
  if (options.query !== undefined) dom.map.get('find-query').value = options.query;
  if (options.replace !== undefined) dom.map.get('find-replace').value = options.replace;
  dom.map.get('find-scope').value = options.scope === undefined ? 'current' : options.scope;
  if (options.caseSensitive !== undefined) dom.map.get('find-case').checked = options.caseSensitive;
  globalThis.document = dom.doc;
  globalThis.window = options.selection === undefined
    ? { getSelection: () => ({ toString: () => '' }) }
    : { getSelection: () => ({ toString: () => String(options.selection) }) };
  const state = {
    view: 'editor',
    bookPath: options.bookPath === undefined ? '/书库/书甲' : options.bookPath,
    index: options.index === undefined ? 0 : options.index,
    dirty: Boolean(options.dirty),
    chapters: options.chapters === undefined ? [
      { id: 'c1', name: '第一章', file: 'c1.txt' },
      { id: 'c2', name: '第二章', file: 'c2.txt' }
    ] : options.chapters,
    find: {
      overlay: null,
      query: '',
      caseSensitive: false,
      matches: [],
      index: -1,
      total: 0,
      windowKey: '',
      windowStart: 0,
      windowEnd: 0,
      highlighted: 0,
      truncated: false,
      fromBookmark: false
    }
  };
  const editorEl = makeEl('textarea');
  editorEl.value = options.text === undefined ? '张三说张三笑了' : options.text;
  const calls = {
    api: [], toast: [], syncEditorOverlay: [], scrollCaretIntoView: [], onEditorInput: 0,
    hideHeaderMenus: 0, closeProofreadPanel: 0, renderFindBookmarks: 0, refreshFindBookmarks: 0, refreshReplaceBackups: 0,
    switchChapter: [], loadChapterAt: [], openModal: [], askUnsaved: [], saveCurrent: 0, refreshShelf: 0,
    renderChapterList: 0, reloadAfterPartialFailure: 0, registerUndo: []
  };
  const api = {
    async findAll(...args) {
      calls.api.push(['findAll', ...args]);
      if (options.findAllError) throw new Error(options.findAllError);
      if (options.findAll) return options.findAll(...args);
      return { count: 2, matches: [{ index: 0, length: 2 }, { index: 3, length: 2 }] };
    },
    async searchBook(...args) {
      calls.api.push(['searchBook', ...args]);
      // WP-13（C2）：E2E / 单测要制造「预览在途」的窗口，注入一个可控的等待点
      if (options.searchBookGate) await options.searchBookGate;
      if (options.searchBookError) throw new Error(options.searchBookError);
      return options.searchBook || { totalMatches: 1, chapterCount: 1, results: [{ chapterId: 'c1', name: '第一章', count: 1, matches: [{ index: 0, length: 2, before: '', match: '张三', after: '说' }] }] };
    },
    async replaceInText(...args) {
      calls.api.push(['replaceInText', ...args]);
      // WP-14（C13）：制造「当前章替换在途」窗口，验证回执只写回给发起时那份正文
      if (options.replaceInTextGate) await options.replaceInTextGate;
      if (options.replaceError) throw new Error(options.replaceError);
      return options.replaceInText || { count: 1, text: '李四说张三笑了' };
    },
    async replaceBook(...args) {
      calls.api.push(['replaceBook', ...args]);
      // WP-13（C12）：制造「整本替换在途」窗口，验证防重入与回来时的 C2 判定
      if (options.replaceBookGate) await options.replaceBookGate;
      if (options.replaceBookError) throw new Error(options.replaceBookError);
      return options.replaceBook || { chaptersChanged: 1, occurrences: 2, backupDir: '/书库/书甲/_trash/替换备份-1' };
    },
    // 1.4.0 P0-2：整本替换的撤销走「用替换备份还原」
    async restoreReplaceBackup(...args) {
      calls.api.push(['restoreReplaceBackup', ...args]);
      return { restored: 1, skipped: 0, restoreBackupDir: '/书库/书甲/_trash/还原前备份-1' };
    }
  };
  const host = {
    $: dom.$,
    state,
    api,
    call: async (fn, ...args) => fn(...args),
    toast(message, kind) { calls.toast.push([message, kind]); },
    imeGuard,
    longOpLogic,
    staleGuard,
    find: {
      findLogic,
      editorEl,
      syncEditorOverlay(overlay) { calls.syncEditorOverlay.push(overlay); return { width: 1, height: 1 }; },
      scrollCaretIntoView(pos) { calls.scrollCaretIntoView.push(pos); },
      onEditorInput: () => { calls.onEditorInput += 1; }
    },
    nav: {
      chapterTitle: (index, name) => chaptersLib.formatTitle(null, index, name),
      async switchChapter(index) {
        calls.switchChapter.push(index);
        if (options.switchCancel) return { ok: false, canceled: true };
        state.index = index;
        return { ok: true };
      },
      async loadChapterAt(index) { calls.loadChapterAt.push(index); },
      currentChapterLabel: () => '第1章 第一章',
      hideHeaderMenus() { calls.hideHeaderMenus += 1; }
    },
    collab: {
      async askUnsaved(opts) {
        calls.askUnsaved.push(opts);
        // WP-13（C2）：询问框在途时可能切了书，测试用这个钩子模拟
        if (options.askUnsavedHook) options.askUnsavedHook(state);
        return options.askAction === undefined ? 'discard' : options.askAction;
      },
      async saveCurrent() { calls.saveCurrent += 1; return { ok: options.saveOk !== false }; },
      async openModal(opts) { calls.openModal.push(opts); return options.modalAction === undefined ? { action: 'cancel' } : options.modalAction; },
      async refreshShelf() { calls.refreshShelf += 1; },
      renderChapterList() { calls.renderChapterList += 1; },
      async reloadAfterPartialFailure() { calls.reloadAfterPartialFailure += 1; },
      closeProofreadPanel() { calls.closeProofreadPanel += 1; },
      async runReplaceOne() { calls.runReplaceOne = (calls.runReplaceOne || 0) + 1; },
      renderFindBookmarks() { calls.renderFindBookmarks += 1; },
      async refreshFindBookmarks() { calls.refreshFindBookmarks += 1; },
      async refreshReplaceBackups() { calls.refreshReplaceBackups += 1; },
      // 1.4.0 P0-2：整本替换把「用替换备份还原」登记成 10 秒撤销
      registerUndo(label, run) { calls.registerUndo.push({ label, run }); }
    }
  };
  const ui = findUi.create(host);
  return { ui, host, state, dom, calls, editorEl };
}

// ---------- host 契约 ----------
test('host 契约：11 个成员 + 分组内每个真实依赖；缺任何一个都抛 TypeError', () => {
  assert.deepEqual([...findUi.REQUIRED_HOST].sort(), ['$', 'api', 'call', 'collab', 'find', 'imeGuard', 'longOpLogic', 'nav', 'staleGuard', 'state', 'toast']);
  assert.equal(findUi.REQUIRED_HOST.length, 11);
  const ctx = build();
  assert.doesNotThrow(() => findUi.create(ctx.host));
  assert.throws(() => findUi.create(null), /createFindUi 需要 host 对象/);
  for (const key of findUi.REQUIRED_HOST) {
    const broken = { ...ctx.host };
    delete broken[key];
    assert.throws(() => findUi.create(broken), new RegExp('host 缺少 ' + key.replace('$', '\\$')), '缺 ' + key);
  }
  for (const key of ['findLogic', 'editorEl', 'syncEditorOverlay', 'scrollCaretIntoView', 'onEditorInput']) {
    const broken = { ...ctx.host, find: { ...ctx.host.find } };
    delete broken.find[key];
    assert.throws(() => findUi.create(broken), new RegExp('host\\.find 缺少 ' + key));
  }
  for (const key of ['chapterTitle', 'switchChapter', 'loadChapterAt', 'currentChapterLabel', 'hideHeaderMenus']) {
    const broken = { ...ctx.host, nav: { ...ctx.host.nav } };
    delete broken.nav[key];
    assert.throws(() => findUi.create(broken), new RegExp('host\\.nav 缺少 ' + key));
  }
  for (const key of ['askUnsaved', 'saveCurrent', 'openModal', 'registerUndo', 'refreshShelf', 'renderChapterList', 'reloadAfterPartialFailure', 'closeProofreadPanel', 'runReplaceOne', 'renderFindBookmarks', 'refreshFindBookmarks', 'refreshReplaceBackups']) {
    const broken = { ...ctx.host, collab: { ...ctx.host.collab } };
    delete broken.collab[key];
    assert.throws(() => findUi.create(broken), new RegExp('host\\.collab 缺少 ' + key));
  }
});

test('create() 只建表：不碰 DOM / 不注册事件 / 不建定时器，交出 24 个入口', () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  assert.equal(dom.lookups, 0);
  assert.deepEqual(Object.keys(ctx.ui).sort(), [
    'clearFindSession', 'closeFindPanel', 'findNavCountText', 'findOverlayEl', 'findPanelOpen',
    'findSessionActive', 'findSessionMatchesOptions', 'hideFindHighlights', 'jumpToFindResult',
    'markFindCurrentHit', 'openFindPanel', 'readFindOptions', 'renderFindHighlights', 'renderFindResults',
    'renderFindStatusChip', 'replaceEditorText', 'runFind', 'runReplaceAll', 'selectFindMatch',
    'setupFindUi', 'startFindSession', 'stepFind', 'syncFindOverlayScroll', 'updateFindNavUi'
  ]);
  assert.equal(moduleCode.includes('setInterval'), false);
});

// ---------- 会话状态 ----------
test('findOverlayEl / findPanelOpen / findSessionActive / findSessionMatchesOptions：状态判定逐条钉住', () => {
  const ctx = build({ query: '张三', caseSensitive: false });
  assert.equal(ctx.ui.findOverlayEl(), ctx.dom.map.get('editor-find-marks'));
  assert.equal(ctx.ui.findPanelOpen(), false);
  ctx.dom.map.get('find-backdrop').classList.remove('hidden');
  assert.equal(ctx.ui.findPanelOpen(), true);

  assert.equal(ctx.ui.findSessionActive(), false);
  ctx.state.find.total = 2;
  ctx.state.find.matches = [{ index: 0, length: 1 }];
  assert.equal(ctx.ui.findSessionActive(), true);
  ctx.state.view = 'shelf';
  assert.equal(ctx.ui.findSessionActive(), false, '书架视图不算会话活跃');

  ctx.state.view = 'editor';
  ctx.state.find.query = '张三';
  assert.equal(ctx.ui.findSessionMatchesOptions({ query: '张三', caseSensitive: false }), true);
  assert.equal(ctx.ui.findSessionMatchesOptions({ query: '张三', caseSensitive: true }), false);
  assert.equal(ctx.ui.findSessionMatchesOptions({ query: '李四', caseSensitive: false }), false);
  ctx.state.find.total = 0;
  assert.equal(ctx.ui.findSessionMatchesOptions({ query: '张三', caseSensitive: false }), false);
});

test('hideFindHighlights：清空影子层与窗口态；clearFindSession：清会话字段并按需 toast', () => {
  const ctx = build({ query: '张三' });
  const overlay = ctx.dom.map.get('editor-find-marks');
  overlay.classList.remove('hidden');
  overlay.appendChild(makeEl('span'));
  ctx.state.find.windowKey = 'k';
  ctx.state.find.highlighted = 3;
  ctx.ui.hideFindHighlights();
  assert.equal(overlay.classList.contains('hidden'), true);
  assert.equal(overlay.children.length, 0);
  assert.equal(ctx.state.find.windowKey, '');
  assert.equal(ctx.state.find.highlighted, 0);

  Object.assign(ctx.state.find, { query: '张三', caseSensitive: true, matches: [{ index: 0 }], index: 0, total: 1, truncated: true, fromBookmark: true });
  ctx.ui.clearFindSession({ toastHint: true });
  assert.deepEqual(
    ['query', 'caseSensitive', 'matches', 'index', 'total', 'truncated', 'fromBookmark'].map((k) => ctx.state.find[k]),
    ['', false, [], -1, 0, false, false]
  );
  assert.deepEqual(ctx.calls.toast, [['已结束查找高亮（正文没改，也没写盘）', undefined]]);
});

test('updateFindNavUi / renderFindStatusChip：无会话时藏小标签；有会话时标签文案 / title / 书签标记 / 截断说明', () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  ctx.ui.updateFindNavUi();
  assert.equal(dom.map.get('find-nav-count').textContent, findLogic.formatCounter(-1, 0));
  assert.equal(dom.map.get('status-find').classList.contains('hidden'), true);

  Object.assign(ctx.state.find, { total: 12, index: 2, query: '张三', fromBookmark: false, truncated: true, highlighted: 8 });
  ctx.ui.updateFindNavUi();
  assert.equal(dom.map.get('find-nav-count').textContent, findLogic.formatCounter(2, 12));
  const chip = dom.map.get('status-find');
  assert.equal(chip.classList.contains('hidden'), false);
  assert.equal(chip.textContent, `查找 ${findLogic.formatCounter(2, 12)}`);
  assert.match(chip.title, /^查找「张三」：第 3\/12 处/);
  assert.match(chip.title, /只高亮当前附近 8 处/);
  assert.match(chip.title, /单击 = 下一处；F3 \/ Shift\+F3/);

  ctx.state.find.fromBookmark = true;
  ctx.ui.renderFindStatusChip();
  assert.equal(dom.map.get('status-find').textContent, `书签 ${findLogic.formatCounter(2, 12)}`);
  assert.match(dom.map.get('status-find').title, /^书签「张三」/);
});

test('syncFindOverlayScroll：层隐藏不动作；可见时同步编辑区滚动', () => {
  const ctx = build();
  const overlay = ctx.dom.map.get('editor-find-marks');
  ctx.ui.syncFindOverlayScroll();
  assert.equal(overlay.scrollTop, 0);
  overlay.classList.remove('hidden');
  ctx.editorEl.scrollTop = 42;
  ctx.editorEl.scrollLeft = 7;
  ctx.ui.syncFindOverlayScroll();
  assert.equal(overlay.scrollTop, 42);
  assert.equal(overlay.scrollLeft, 7);
});

// ---------- 高亮层 ----------
test('renderFindHighlights：无会话 → 收起并刷小标签；有会话 → 画命中 span / 当前命中 class / 文本可还原', () => {
  const dom = makeDocument();
  const ctx = build({ dom, text: '张三说张三笑了' });
  ctx.ui.renderFindHighlights();
  assert.equal(dom.map.get('editor-find-marks').classList.contains('hidden'), true);

  ctx.state.find.query = '张三';
  ctx.state.find.matches = [{ index: 0, length: 2 }, { index: 3, length: 2 }];
  ctx.state.find.total = 2;
  ctx.state.find.index = 1;
  ctx.ui.renderFindHighlights({ force: true });
  const overlay = dom.map.get('editor-find-marks');
  assert.equal(overlay.classList.contains('hidden'), false);
  assert.equal(ctx.calls.syncEditorOverlay.length, 1, '对齐逻辑走 syncEditorOverlay（与标记层同一套）');
  assert.equal(collectText(overlay), '张三说张三笑了');
  const hits = overlay.querySelectorAll('.find-hit');
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((h) => h.dataset.ordinal), ['0', '1']);
  assert.equal(overlay.querySelectorAll('.find-hit-current').length, 1);
  assert.equal(overlay.querySelector('.find-hit-current').dataset.ordinal, '1');

  // 同一窗口再画：不重建（只同步+换 class），节点还是同一批
  const firstHit = hits[0];
  ctx.ui.renderFindHighlights();
  assert.equal(overlay.querySelectorAll('.find-hit')[0], firstHit, '同窗口不重建');

  // 换查询强制重画
  ctx.state.find.query = '李四';
  ctx.state.find.matches = [];
  ctx.state.find.total = 0;
  ctx.ui.renderFindHighlights();
  assert.equal(overlay.classList.contains('hidden'), true);
});

test('markFindCurrentHit：摘旧 class、给新 ordinal 加 class；index<0 时只摘不加', () => {
  const ctx = build();
  const overlay = ctx.dom.map.get('editor-find-marks');
  const oldHit = makeEl('span');
  oldHit.className = 'find-hit find-hit-current';
  oldHit.dataset.ordinal = '0';
  const newHit = makeEl('span');
  newHit.className = 'find-hit';
  newHit.dataset.ordinal = '1';
  overlay.append(oldHit, newHit);
  ctx.state.find.index = 1;
  ctx.ui.markFindCurrentHit();
  assert.equal(oldHit.classList.contains('find-hit-current'), false);
  assert.equal(newHit.classList.contains('find-hit-current'), true);

  ctx.state.find.index = -1;
  ctx.ui.markFindCurrentHit();
  assert.equal(overlay.querySelectorAll('.find-hit-current').length, 0);
});

// ---------- 会话 / 步进 ----------
test('startFindSession：过滤坏命中、夹取 index、写 state 并强制重画', () => {
  const ctx = build({ text: 'abcdef' });
  const session = ctx.ui.startFindSession('bc', false, [
    { index: 1, length: 2 },
    { index: 'x', length: 1 },
    { index: 3, length: 0 },
    null
  ], 99);
  assert.equal(session.query, 'bc');
  assert.equal(session.total, 1);
  assert.equal(session.index, 0);
  assert.equal(ctx.dom.map.get('editor-find-marks').classList.contains('hidden'), false);
});

test('selectFindMatch：没会话返回 null；夹取下标、选中、滚动、刷新高亮与小标签', () => {
  const ctx = build({ text: 'abcdef' });
  assert.equal(ctx.ui.selectFindMatch(0), null);
  ctx.state.find.matches = [{ index: 1, length: 2 }, { index: 4, length: 2 }];
  ctx.state.find.total = 2;
  const res = ctx.ui.selectFindMatch(99);
  assert.equal(res.index, 1);
  assert.equal(ctx.editorEl.selectionStart, 4);
  assert.equal(ctx.editorEl.selectionEnd, 6);
  assert.deepEqual(ctx.calls.scrollCaretIntoView, [4]);
  assert.equal(ctx.editorEl._focus, 1);
  assert.equal(ctx.dom.map.get('editor-find-marks').classList.contains('hidden'), false);
});

test('stepFind：空查询 / 条件变了先查 / 无相邻命中 / 正常步进（含环绕提示与行号）', async () => {
  const empty = build({ query: '' });
  assert.deepEqual(await empty.ui.stepFind(1), { ok: false });
  assert.equal(empty.dom.map.get('find-summary').textContent, '先在查找框里输入内容');

  const changed = build({ query: '张三', text: '张三说张三笑了' });
  assert.deepEqual(await changed.ui.stepFind(1), { ok: false, searched: true });
  assert.equal(changed.calls.api[0][0], 'findAll');

  const noStep = build({ query: '张三' });
  Object.assign(noStep.state.find, { query: '张三', matches: [{ index: 0, length: 2 }], total: 1, index: 0 });
  assert.deepEqual(await noStep.ui.stepFind(1), { ok: true, index: 0, total: 1, wrapped: false }, '只有一处时下一处仍返回这一处（不环绕）');

  const ctx = build({ query: '张三', text: '张三说张三笑了' });
  Object.assign(ctx.state.find, {
    query: '张三', caseSensitive: false,
    matches: [{ index: 0, length: 2 }, { index: 3, length: 2 }], total: 2, index: 1
  });
  const res = await ctx.ui.stepFind(1);
  assert.equal(res.ok, true);
  assert.equal(res.index, 0);
  assert.equal(res.wrapped, true);
  assert.match(ctx.dom.map.get('find-summary').textContent, /第 1\/2 处 · 第 1 行（已到末尾，回到第 1 处）/);
});

// ---------- 面板开 / 关 / 选项 ----------
test('openFindPanel：没书警告；有书 → 收菜单、关校对框、带选中文字、显示并聚焦、刷书签与替换备份入口', async () => {
  const noBook = build({ bookPath: null });
  assert.equal(noBook.ui.openFindPanel(), undefined);
  assert.deepEqual(noBook.calls.toast, [['先打开一本书再查找', 'warn']]);

  const ctx = build({ selection: '选中的词' });
  ctx.dom.map.get('proofread-backdrop').classList.remove('hidden');
  ctx.ui.openFindPanel();
  await flush();
  assert.equal(ctx.calls.hideHeaderMenus, 1);
  assert.equal(ctx.calls.closeProofreadPanel, 1);
  assert.equal(ctx.dom.map.get('find-query').value, '选中的词');
  assert.equal(ctx.dom.map.get('find-backdrop').classList.contains('hidden'), false);
  assert.equal(ctx.editorEl.value, '张三说张三笑了');
  assert.equal(ctx.dom.map.get('find-query')._focus, 1);
  assert.equal(ctx.dom.map.get('find-query')._selected, true);
  assert.equal(ctx.calls.renderFindBookmarks, 1);
  assert.equal(ctx.calls.refreshFindBookmarks, 1);
  assert.equal(ctx.calls.refreshReplaceBackups, 1);

  // 长选中 / 含换行的选中不带进查找框
  const longSel = build({ selection: 'x'.repeat(61) });
  longSel.dom.map.get('find-query').value = '旧词';
  longSel.ui.openFindPanel();
  assert.equal(longSel.dom.map.get('find-query').value, '旧词');
});

test('openFindPanel：编辑器 textarea 选中 3 个字 → 查找框带入这 3 个字且选区不被清掉（V32 / 1.6.1 R7）', () => {
  // ① textarea 里选中「张三说」：窗口选区对 <textarea> 恒为空，必须改读编辑器自身的 selectionStart/End
  const ctx = build({ selection: '' });
  ctx.editorEl.setSelectionRange(0, 3);
  ctx.ui.openFindPanel();
  assert.equal(ctx.dom.map.get('find-query').value, '张三说', '编辑器选区应带入查找框');
  assert.equal(ctx.editorEl.selectionStart, 0, '带入后编辑器选区起点不能被清掉');
  assert.equal(ctx.editorEl.selectionEnd, 3, '带入后编辑器选区终点不能被清掉');

  // ② 编辑器里没有选区（光标收起）时旧行为不变：仍读 window.getSelection()
  const fallback = build({ selection: '选中的词' });
  fallback.editorEl.setSelectionRange(5, 5);
  fallback.ui.openFindPanel();
  assert.equal(fallback.dom.map.get('find-query').value, '选中的词', '无编辑器选区时沿用窗口选区');

  // ③ 编辑器选中过长 / 含换行仍不带入（沿用旧的 60 字与单行闸门）
  const long = build({ selection: '', text: '甲'.repeat(61) + '\n乙' });
  long.editorEl.setSelectionRange(0, 61);
  long.ui.openFindPanel();
  assert.equal(long.dom.map.get('find-query').value, '', '超长编辑器选区不带入');
  const multiline = build({ selection: '', text: '第一节\n第二节' });
  multiline.editorEl.setSelectionRange(0, 7);
  multiline.ui.openFindPanel();
  assert.equal(multiline.dom.map.get('find-query').value, '', '跨行编辑器选区不带入');
});

test('closeFindPanel / readFindOptions：关面板不结束会话；四个选项从 DOM 读', () => {
  const ctx = build({ query: '张三', replace: '李四', scope: 'book', caseSensitive: true });
  ctx.ui.openFindPanel();
  ctx.dom.map.get('find-backdrop').classList.remove('hidden');
  ctx.ui.closeFindPanel();
  assert.equal(ctx.dom.map.get('find-backdrop').classList.contains('hidden'), true);
  assert.deepEqual(ctx.ui.readFindOptions(), { query: '张三', replacement: '李四', scope: 'book', caseSensitive: true });
});

// ---------- 整本结果清单 ----------
test('renderFindResults：空清单文案 / 行结构（章名 + 处数 + 片段 mark）/ 点行跳转', () => {
  const dom = makeDocument();
  const ctx = build({ dom, query: '张三' });
  ctx.ui.renderFindResults({ query: '张三', results: [] });
  assert.equal(dom.map.get('find-results').children[0].className, 'find-empty');
  assert.equal(dom.map.get('find-results').children[0].dataset.emptyKind, 'filtered');
  assert.equal(
    dom.map.get('find-results').children[0].textContent,
    '没有找到「张三」。查找是字面匹配（不做正则），区分全角 / 半角；' +
      '换个更短或更具体的词再试，或先在正文里选中一个词再按 Ctrl+F，查找框会直接带上它。'
  );

  ctx.ui.renderFindResults({
    query: '张三',
    results: [{ chapterId: 'c2', name: '第二章', count: 2, matches: [{ index: 5, length: 2, before: '前文', match: '张三', after: '后文' }] }]
  });
  const list = dom.map.get('find-results');
  assert.equal(list.children.length, 1);
  const row = list.children[0];
  assert.equal(row.className, 'find-result');
  assert.equal(row.dataset.chapterId, 'c2');
  assert.equal(row.children[0].children[0].textContent, chaptersLib.formatTitle(null, 1, '第二章'));
  assert.equal(row.children[0].children[1].textContent, '2 处');
  assert.deepEqual(row.children[1].children.map((c) => c.textContent), ['前文', '张三', '后文']);
  assert.equal(row.children[1].children[1].tagName, 'mark');
  // 点行 → jumpToFindResult（异步）：切章 + 本章高亮
  row._fire('click');
  return flush().then(() => {
    assert.deepEqual(ctx.calls.switchChapter, [1]);
    assert.equal(ctx.calls.api.some((c) => c[0] === 'findAll'), true);
    assert.equal(ctx.state.find.total, 2);
    assert.match(ctx.calls.toast[ctx.calls.toast.length - 1][0], /^「张三」在本章 2 处，已高亮/);
  });
});

test('jumpToFindResult：章节已不存在 toast；本章无命中时退回第一条命中位置', async () => {
  const gone = build();
  await gone.ui.jumpToFindResult({ chapterId: 'nope', name: '没了', matches: [] });
  assert.deepEqual(gone.calls.toast, [['这一章已经不存在了', 'warn']]);
  assert.deepEqual(gone.calls.switchChapter, []);

  const ctx = build({ text: '张三说张三笑了', findAll: () => ({ count: 0, matches: [] }) });
  await ctx.ui.jumpToFindResult({
    chapterId: 'c1', name: '第一章',
    matches: [{ index: 3, length: 2 }]
  });
  assert.equal(ctx.editorEl.selectionStart, 3);
  assert.equal(ctx.editorEl.selectionEnd, 5);
  assert.deepEqual(ctx.calls.scrollCaretIntoView, [3]);
});

// ---------- 查找 / 替换执行 ----------
test('runFind：空查询 / 当前章成功 / 当前章无命中 / 失败 / 整本清单', async () => {
  const empty = build({ query: '  ' });
  await empty.ui.runFind();
  assert.equal(empty.dom.map.get('find-summary').textContent, '先在查找框里输入内容');
  assert.equal(empty.dom.map.get('find-results').children.length, 0);

  const current = build({ query: '张三', text: '张三说张三笑了' });
  await current.ui.runFind();
  assert.equal(current.state.find.total, 2);
  assert.match(current.dom.map.get('find-summary').textContent, /^本章命中 2 处（第 1\/2 处）/);

  const none = build({ query: '不存在', findAll: () => ({ count: 0, matches: [] }) });
  await none.ui.runFind();
  assert.equal(none.state.find.total, 0);
  assert.equal(none.dom.map.get('find-summary').textContent, '本章没有找到「不存在」');

  const fail = build({ query: '张三', findAllError: '主进程炸了' });
  await fail.ui.runFind();
  assert.equal(fail.dom.map.get('find-summary').textContent, '查找失败：主进程炸了');

  const book = build({ query: '张三', scope: 'book' });
  await book.ui.runFind();
  assert.equal(book.calls.api[0][0], 'searchBook');
  assert.match(book.dom.map.get('find-summary').textContent, /^整本命中 1 处，分布在 1 章/);
  assert.equal(book.dom.map.get('find-results').children.length, 1);

  const bookNone = build({ query: '没有', scope: 'book', searchBook: { totalMatches: 0, chapterCount: 0, results: [] } });
  await bookNone.ui.runFind();
  assert.equal(bookNone.dom.map.get('find-summary').textContent, '整本没有找到「没有」');
});

test('runFind：命中被单章上限截断时摘要说「至少」，结果行计数带 +（C4 / WP-05）', async () => {
  const current = build({
    query: '张三',
    findAll: () => ({
      count: 3,
      truncated: true,
      limit: 3,
      matches: [
        { index: 0, length: 2 },
        { index: 3, length: 2 },
        { index: 6, length: 2 }
      ]
    })
  });
  await current.ui.runFind();
  const currentSummary = current.dom.map.get('find-summary').textContent;
  assert.match(currentSummary, /^本章至少命中 3 处（第 1\/3 处）/);
  assert.match(currentSummary, /超过单章上限，只列出 \/ 替换前 3 处/);

  const book = build({
    query: '张三',
    scope: 'book',
    searchBook: {
      totalMatches: 5000,
      truncated: true,
      matchLimit: 5000,
      chapterCount: 1,
      results: [
        {
          chapterId: 'c1',
          name: '第一章',
          count: 5000,
          truncated: true,
          matches: [{ index: 0, length: 2, before: '', match: '张三', after: '说' }]
        }
      ]
    }
  });
  await book.ui.runFind();
  const bookSummary = book.dom.map.get('find-summary').textContent;
  assert.match(bookSummary, /^整本至少命中 5000 处，分布在 1 章/);
  assert.match(bookSummary, /单章命中超过 5000 处时只统计 \/ 替换前 5000 处/);
  assert.ok(collectText(book.dom.map.get('find-results')).includes('5000+ 处'), '结果行计数必须带 +');
});

test('replaceEditorText：写回编辑区并触发输入处理（dirty / 字数）；execCommand 不可用时走直接赋值', () => {
  const ctx = build({ text: '旧正文' });
  ctx.ui.replaceEditorText('新正文');
  assert.equal(ctx.editorEl.value, '新正文');
  assert.equal(ctx.calls.onEditorInput, 1);
  assert.equal(ctx.editorEl._focus, 1);
  assert.equal(ctx.editorEl.selectionStart, 0);
});

test('runReplaceAll（当前章）：空查询提示 / 无命中不替换 / 成功写回编辑区并提示未保存', async () => {
  const empty = build({ query: ' ' });
  await empty.ui.runReplaceAll();
  assert.equal(empty.dom.map.get('find-summary').textContent, '先在查找框里输入内容');
  assert.deepEqual(empty.calls.api, []);

  const none = build({ query: '张三', replace: '李四', replaceInText: { count: 0 } });
  await none.ui.runReplaceAll();
  assert.equal(none.dom.map.get('find-summary').textContent, '本章没有找到「张三」，未做替换');

  const ok = build({ query: '张三', replace: '李四', replaceInText: { count: 1, text: '李四说张三笑了' } });
  await ok.ui.runReplaceAll();
  assert.equal(ok.editorEl.value, '李四说张三笑了');
  assert.equal(ok.dom.map.get('find-summary').textContent, '本章已替换 1 处（还没保存：Ctrl+S 写盘，Ctrl+Z 可撤销）');
  assert.deepEqual(ok.calls.toast, [['本章替换 1 处（未保存）', undefined]]);

  const fail = build({ query: '张三', replace: '李四', replaceInText: null, replaceError: '写盘失败' });
  await fail.ui.runReplaceAll();
  assert.deepEqual(fail.calls.toast, [['替换失败：写盘失败', 'error']]);
});

test('runReplaceAll：单章 / 整本命中被上限截断时只说「只替换了前 N 处」，不报完成（C4 / WP-05）', async () => {
  const current = build({
    query: '张三',
    replace: '李四',
    replaceInText: { count: 5000, truncated: true, limit: 5000, text: '李四'.repeat(5000) }
  });
  await current.ui.runReplaceAll();
  assert.match(current.dom.map.get('find-summary').textContent, /^本章只替换了前 5000 处/);
  assert.deepEqual(current.calls.toast, [['本章只替换了前 5000 处（未保存）', 'warn']]);
  assert.equal(current.editorEl.value.length, 10000, '替换结果仍写回编辑区（只是如实报告截断）');

  const book = build({
    query: '张三',
    replace: '李四',
    scope: 'book',
    searchBook: {
      totalMatches: 5000,
      truncated: true,
      matchLimit: 5000,
      chapterCount: 1,
      results: [{ chapterId: 'c1', name: '第一章', count: 5000, truncated: true, matches: [] }]
    },
    replaceBook: {
      chaptersChanged: 1,
      occurrences: 5000,
      truncated: true,
      chaptersTruncated: 1,
      matchLimit: 5000,
      backupDir: '/书库/书甲/_trash/替换备份-1'
    }
  });
  await book.ui.runReplaceAll();
  const lastToast = book.calls.toast[book.calls.toast.length - 1][0];
  assert.ok(!lastToast.includes('替换完成'), '截断时不许报「完成」');
  assert.match(
    lastToast,
    /^整本替换：1 章 \/ 5000 处；有 1 章命中超过单章 5000 处上限，只替换了前 5000 处，其余未改动/
  );
  assert.match(book.calls.registerUndo[0].label, /部分章截断/, '撤销条也要标明部分章截断');
});

test('runReplaceAll（整本）：未保存三选一 / 不再二次确认（登记撤销）/ 成功后备份提示 / 失败重载', async () => {
  // 取消
  const cancel = build({ query: '张三', replace: '李四', scope: 'book', dirty: true, askAction: 'cancel' });
  await cancel.ui.runReplaceAll();
  assert.equal(cancel.calls.askUnsaved.length, 1);
  assert.deepEqual(cancel.calls.openModal, []);

  // 保存失败 → 停
  const saveFail = build({ query: '张三', replace: '李四', scope: 'book', dirty: true, askAction: 'save', saveOk: false });
  await saveFail.ui.runReplaceAll();
  assert.equal(saveFail.calls.saveCurrent, 1);
  assert.deepEqual(saveFail.calls.openModal, []);

  // 1.4.0 P0-2：不再弹二次确认（模态只留两处），直接替换
  const noConfirm = build({ query: '张三', replace: '李四', scope: 'book' });
  await noConfirm.ui.runReplaceAll();
  assert.deepEqual(noConfirm.calls.openModal, [], '整本替换不许再弹确认框');
  assert.equal(noConfirm.calls.api.some((c) => c[0] === 'replaceBook'), true);

  // 无命中 → 提示不替换
  const none = build({ query: '张三', replace: '李四', scope: 'book', searchBook: { totalMatches: 0, chapterCount: 0, results: [] } });
  await none.ui.runReplaceAll();
  assert.equal(none.dom.map.get('find-summary').textContent, '整本没有找到「张三」，未做替换');

  // 成功
  const ok = build({ query: '张三', replace: '李四', scope: 'book' });
  await ok.ui.runReplaceAll();
  assert.equal(ok.calls.api.some((c) => c[0] === 'replaceBook'), true);
  assert.deepEqual(ok.calls.loadChapterAt, [0]);
  assert.equal(ok.calls.renderChapterList, 1);
  assert.equal(ok.calls.refreshShelf, 1);
  assert.match(ok.calls.toast[ok.calls.toast.length - 1][0], /^整本替换完成：1 章 \/ 2 处 · 原文已备份到 _trash（10 秒内可撤销）/);
  // 撤销：登记一条，执行时调 restoreReplaceBackup（用这次替换的备份还原，只传目录名）
  assert.equal(ok.calls.registerUndo.length, 1, '整本替换要登记 10 秒撤销');
  assert.match(ok.calls.registerUndo[0].label, /已整本替换 1 章 \/ 2 处/);
  await ok.calls.registerUndo[0].run();
  assert.equal(
    ok.calls.api.some((c) => c[0] === 'restoreReplaceBackup' && c[2] === '替换备份-1'),
    true,
    '撤销走替换备份还原（只传目录名，不传绝对路径）'
  );

  // 失败 → toast + 重载
  const fail = build({ query: '张三', replace: '李四', scope: 'book', replaceBookError: '磁盘满' });
  await fail.ui.runReplaceAll();
  assert.deepEqual(fail.calls.toast, [['整本替换失败：磁盘满', 'error']]);
  assert.equal(fail.calls.reloadAfterPartialFailure, 1);
});

// ---------- WP-13：整本替换防重入（C12）+ 回执按捕获的书判定（C2 口径） ----------

test('runReplaceAll 防重入：替换在途再按一次，只跑一条整本替换链（C12）', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ctx = build({ query: '张三', replace: '李四', scope: 'book', replaceBookGate: gate });
  const first = ctx.ui.runReplaceAll();
  const second = ctx.ui.runReplaceAll(); // 同一拍再按一次：busy 已置位，直接忽略
  await flush();
  assert.equal(ctx.calls.api.filter((c) => c[0] === 'replaceBook').length, 1, '在途时只许一次 replaceBook');
  release();
  await Promise.all([first, second]);
  assert.equal(ctx.calls.api.filter((c) => c[0] === 'replaceBook').length, 1);
  assert.equal(ctx.calls.registerUndo.length, 1, '撤销只登记一条（旧实现第二份备份已是替换后状态）');
  assert.equal(ctx.calls.toast.filter(([m]) => String(m).startsWith('整本替换完成')).length, 1, '只弹一条完成提示');
  assert.deepEqual(ctx.calls.loadChapterAt, [0]);
});

test('runReplaceAll 防重入：失败 / 成功后 busy 都复位，下一轮还能跑（不会永久卡住）', async () => {
  const fail = build({ query: '张三', replace: '李四', scope: 'book', replaceBookError: '磁盘满' });
  await fail.ui.runReplaceAll();
  await fail.ui.runReplaceAll();
  assert.equal(fail.calls.api.filter((c) => c[0] === 'replaceBook').length, 2, '失败后 busy 必须复位');

  const ok = build({ query: '张三', replace: '李四', scope: 'book' });
  await ok.ui.runReplaceAll();
  await ok.ui.runReplaceAll();
  assert.equal(ok.calls.api.filter((c) => c[0] === 'replaceBook').length, 2, '成功后 busy 必须复位');
});

test('runReplaceAll（C2）：替换在途换了书 → 原书回执照常提示，但不刷新另一本的界面', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ctx = build({ query: '张三', replace: '李四', scope: 'book', replaceBookGate: gate });
  const running = ctx.ui.runReplaceAll();
  await flush();
  ctx.state.bookPath = '/书库/书乙'; // 在途切到了另一本
  release();
  await running;
  assert.deepEqual(ctx.calls.loadChapterAt, [], '不许把另一本当成本书重载');
  assert.equal(ctx.calls.renderChapterList, 0, '不许重画另一本的章节栏');
  assert.equal(ctx.calls.refreshShelf, 0);
  const last = ctx.calls.toast[ctx.calls.toast.length - 1][0];
  assert.match(last, /^原书整本替换完成：1 章 \/ 2 处/);
  assert.match(last, /当前已打开另一本书，界面没有刷新/);
  assert.equal(ctx.calls.registerUndo.length, 1, '撤销仍登记（闭包自己核对书身份，切回来还能撤）');
});

test('runReplaceAll（C2）：替换在途又敲了字 → 正文优先，不从磁盘重载覆盖', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ctx = build({ query: '张三', replace: '李四', scope: 'book', replaceBookGate: gate });
  const running = ctx.ui.runReplaceAll();
  await flush();
  ctx.editorEl.value = '在途敲的字';
  ctx.state.dirty = true;
  release();
  await running;
  assert.deepEqual(ctx.calls.loadChapterAt, [], '有未保存修改时不许从磁盘重载');
  assert.equal(ctx.editorEl.value, '在途敲的字', '作者刚写的字一个字都不能丢');
  assert.equal(ctx.calls.renderChapterList, 1, '目录 / 统计照常刷新');
  assert.equal(ctx.calls.refreshShelf, 1);
  assert.match(ctx.calls.toast[ctx.calls.toast.length - 1][0], /当前章有未保存修改，没有从磁盘重新载入/);
});

test('runReplaceAll（C2）：预览在途换了书 → 取消，不拿旧书的命中替换新书', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ctx = build({ query: '张三', replace: '李四', scope: 'book', searchBookGate: gate });
  const running = ctx.ui.runReplaceAll();
  await flush();
  ctx.state.bookPath = '/书库/书乙';
  release();
  await running;
  assert.equal(ctx.calls.api.some((c) => c[0] === 'replaceBook'), false, '不许把旧书的预览回执用到新书上');
  assert.deepEqual(ctx.calls.toast, [['已经换了书，取消整本替换', 'warn']]);
});

test('runReplaceAll（C2）：未保存询问在途换了书 → 取消整本替换', async () => {
  const ctx = build({
    query: '张三', replace: '李四', scope: 'book', dirty: true, askAction: 'discard',
    askUnsavedHook: (state) => { state.bookPath = '/书库/书乙'; }
  });
  await ctx.ui.runReplaceAll();
  assert.equal(ctx.calls.api.some((c) => c[0] === 'replaceBook'), false);
  assert.equal(ctx.calls.api.some((c) => c[0] === 'searchBook'), false, '换书后连预览都不该发');
  assert.deepEqual(ctx.calls.toast, [['已经换了书，取消整本替换', 'warn']]);
});

// ---------- WP-14：当前章替换回执按快照校验（C13） ----------

test('runReplaceAll（当前章 / C13）：替换在途又敲了字 → 回执作废，正文保留、不置脏、不动撤销链', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ctx = build({
    query: '张三',
    replace: '李四',
    replaceInTextGate: gate,
    replaceInText: { count: 1, text: '李四说李四笑了' }
  });
  const running = ctx.ui.runReplaceAll();
  await flush();
  // 发起时交给主进程的就是快照（不是回执到达时的活值）
  assert.deepEqual(ctx.calls.api, [['replaceInText', '张三说张三笑了', '张三', '李四', { caseSensitive: false }]]);
  ctx.editorEl.value = '张三说张三笑了，在途补的字'; // 替换 IPC 在途，作者继续敲字
  release();
  await running;
  assert.equal(ctx.editorEl.value, '张三说张三笑了，在途补的字', '旧回执一个字都不许写回（C13 核心）');
  assert.equal(ctx.calls.onEditorInput, 0, '没写回编辑区就不触发输入处理，dirty / 字数都不动');
  assert.equal(ctx.state.dirty, false, '作废路径不许把状态置脏');
  assert.deepEqual(ctx.calls.toast, [['正文已经变了，替换已取消（未改动）', 'warn']]);
  assert.equal(
    ctx.dom.map.get('find-summary').textContent,
    '替换已取消：替换过程中正文发生了变化，这次结果没有写入（正文未改动）'
  );
});

test('runReplaceAll（当前章 / C13）：在途换章 / 换书（正文恰好相同）→ 按发起时身份作废，不写进新章', async () => {
  // 切章：两章正文可能恰好相同（空章 / 模板章），只比正文会漏
  let releaseChapter;
  const chapterGate = new Promise((resolve) => { releaseChapter = resolve; });
  const chapterCtx = build({ query: '张三', replace: '李四', replaceInTextGate: chapterGate });
  const chapterRun = chapterCtx.ui.runReplaceAll();
  await flush();
  chapterCtx.state.loadedChapterId = 'c2';
  releaseChapter();
  await chapterRun;
  assert.equal(chapterCtx.editorEl.value, '张三说张三笑了');
  assert.equal(chapterCtx.calls.onEditorInput, 0, '不许把旧章的回执写进新载入的章');
  assert.deepEqual(chapterCtx.calls.toast, [['正文已经变了，替换已取消（未改动）', 'warn']]);

  // 换书：正文恰好相同也按身份作废
  let releaseBook;
  const bookGate = new Promise((resolve) => { releaseBook = resolve; });
  const bookCtx = build({ query: '张三', replace: '李四', replaceInTextGate: bookGate });
  const bookRun = bookCtx.ui.runReplaceAll();
  await flush();
  bookCtx.state.bookPath = '/书库/书乙';
  releaseBook();
  await bookRun;
  assert.equal(bookCtx.editorEl.value, '张三说张三笑了');
  assert.equal(bookCtx.calls.onEditorInput, 0);
  assert.deepEqual(bookCtx.calls.toast, [['正文已经变了，替换已取消（未改动）', 'warn']]);
});

test('runReplaceAll（当前章 / C13）：回执作废时即使 count=0 也不拿旧结果说「本章没有找到」', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ctx = build({ query: '张三', replace: '李四', replaceInTextGate: gate, replaceInText: { count: 0 } });
  const running = ctx.ui.runReplaceAll();
  await flush();
  ctx.editorEl.value = '换成另一段正文';
  release();
  await running;
  assert.equal(
    ctx.dom.map.get('find-summary').textContent,
    '替换已取消：替换过程中正文发生了变化，这次结果没有写入（正文未改动）',
    '「没找到」说的是旧正文，不能拿来描述现在这段'
  );
  assert.deepEqual(ctx.calls.toast, [['正文已经变了，替换已取消（未改动）', 'warn']]);
});

test('静态闸门：当前章替换不再把活值 editorEl.value 交给 replaceInText，且先校验快照再写回（C13 回潮）', () => {
  assert.equal(/call\(api\.replaceInText,\s*editorEl\.value/.test(moduleCode), false, '回执必须对应发起时的正文快照');
  assert.match(moduleCode, /const snapshot = editorEl\.value;/);
  assert.match(moduleCode, /editorEl\.value === snapshot/);
  const callAt = moduleCode.indexOf('call(api.replaceInText, snapshot');
  const staleAt = moduleCode.indexOf('!stillSameText()');
  const writeAt = moduleCode.indexOf('replaceEditorText(res.text)');
  assert.ok(callAt >= 0, '当前章替换要把快照交给 replaceInText');
  assert.ok(staleAt > callAt, '回执到达后先过快照校验');
  assert.ok(writeAt > staleAt, '校验通过才允许写回编辑区');
});

// ---------- 事件绑定 ----------
test('输入法组字中的 Enter 不触发查找 / 替换（WP-04 / 审计 C3、V112）', async () => {
  const dom = makeDocument();
  const ctx = build({ dom, query: '张三', text: '张三说张三笑了' });
  ctx.ui.setupFindUi();
  let prevented = 0;
  const findAllCalls = () => ctx.calls.api.filter((c) => c[0] === 'findAll').length;
  const replaceCalls = () => ctx.calls.api.filter((c) => c[0] === 'replaceInText').length;

  // 查找框：isComposing = true 的 Enter 是「上屏候选词」
  dom.map.get('find-query').value = '张三';
  dom.map.get('find-query')._fire('keydown', {
    key: 'Enter', isComposing: true, preventDefault() { prevented += 1; }, stopPropagation() {}
  });
  await flush();
  assert.equal(findAllCalls(), 0, '组字中按 Enter 不许发查找 IPC');
  assert.equal(ctx.state.find.total, 0);
  assert.equal(prevented, 0, '组字中的 Enter 也不该拦默认行为（否则输入法收不到上屏事件）');

  // V112 的防御性加固：旧版 / 第三方输入法只报 keyCode 229（isComposing 为假）
  dom.map.get('find-query')._fire('keydown', {
    key: 'Enter', keyCode: 229, preventDefault() { prevented += 1; }, stopPropagation() {}
  });
  await flush();
  assert.equal(findAllCalls(), 0, 'keyCode 229 同样按组字处理');
  assert.equal(prevented, 0);

  // 替换框：组字中的 Enter 不许触发整本替换（1.4.0 起无二次确认，误触直接写盘）
  dom.map.get('find-replace').value = '李四';
  dom.map.get('find-scope').value = 'book';
  dom.map.get('find-replace')._fire('keydown', { key: 'Enter', isComposing: true, preventDefault() { prevented += 1; } });
  await flush();
  assert.equal(replaceCalls(), 0, '组字中按 Enter 不许触发整本替换');
  assert.equal(dom.map.get('find-backdrop').classList.contains('hidden'), true, '面板不许在组字中被收起');
  assert.equal(prevented, 0);
  dom.map.get('find-replace')._fire('keydown', { key: 'Enter', keyCode: 229, preventDefault() { prevented += 1; } });
  await flush();
  assert.equal(replaceCalls(), 0, 'keyCode 229 同样不许触发整本替换');
  assert.equal(prevented, 0);

  // 组字结束后的普通 Enter：旧行为不变（真的查一遍；范围回到当前章，走 findAll）
  dom.map.get('find-scope').value = 'current';
  dom.map.get('find-query')._fire('keydown', { key: 'Enter', shiftKey: false, preventDefault() {}, stopPropagation() {} });
  await flush();
  assert.equal(findAllCalls(), 1, '普通 Enter 照旧查找');
  assert.equal(ctx.state.find.total, 2);
});

test('setupFindUi：打开 / 上一处下一处 / 状态栏 / 词变化 / 替换 / 关闭 / 回车 全部注册并接到真实函数', async () => {
  const dom = makeDocument();
  const ctx = build({ dom, query: '张三', text: '张三说张三笑了' });
  ctx.ui.setupFindUi();
  const ids = ['btn-find', 'btn-find-run', 'btn-find-prev', 'btn-find-next', 'btn-find-replace-one', 'btn-find-replace', 'btn-find-close'];
  for (const id of ids) assert.equal(dom.map.get(id)._listeners.length, 1, id);
  assert.deepEqual(dom.map.get('find-query')._listeners.map((l) => l.type), ['input', 'keydown']);
  assert.deepEqual(dom.map.get('find-case')._listeners.map((l) => l.type), ['change']);
  assert.deepEqual(dom.map.get('find-scope')._listeners.map((l) => l.type), ['change']);
  assert.deepEqual(dom.map.get('find-replace')._listeners.map((l) => l.type), ['keydown']);
  assert.deepEqual(dom.map.get('status-find')._listeners.map((l) => l.type), ['click']);

  // 打开
  dom.map.get('btn-find')._fire('click');
  await flush();
  assert.equal(dom.map.get('find-backdrop').classList.contains('hidden'), false);

  // 范围改动 → 清会话与清单
  dom.map.get('find-scope')._fire('change');
  assert.equal(dom.map.get('find-results').children.length, 0);

  // 词变化 → 收起旧高亮
  ctx.state.find.total = 2;
  ctx.state.find.query = '旧词';
  ctx.state.find.matches = [{ index: 0, length: 1 }];
  dom.map.get('find-query').value = '新词';
  dom.map.get('find-query')._fire('input');
  assert.equal(ctx.state.find.total, 0);

  // 回车：查一遍并选中第一处
  dom.map.get('find-query').value = '张三';
  dom.map.get('find-query')._fire('keydown', { key: 'Enter', shiftKey: false, preventDefault() {}, stopPropagation() {} });
  await flush();
  assert.equal(ctx.state.find.total, 2);

  // 下一处按钮
  const before = ctx.state.find.index;
  dom.map.get('btn-find-next')._fire('click');
  await flush();
  assert.notEqual(ctx.state.find.index, before);

  // 替换两个按钮：当前章替换走 runReplaceAll（这次没有命中则只写提示，不抛）
  dom.map.get('btn-find-replace')._fire('click');
  await flush();
  assert.equal(ctx.calls.api.some((c) => c[0] === 'replaceInText'), true);

  // 关闭
  dom.map.get('btn-find-close')._fire('click');
  assert.equal(dom.map.get('find-backdrop').classList.contains('hidden'), true);
});

// ---------- 静态闸门 ----------
test('静态闸门：renderer.js 不再内嵌查找 / 替换实现，只剩装配与转发', () => {
  for (const shape of [
    'function findOverlayEl(',
    'function renderFindHighlights(',
    'async function stepFind(',
    'function selectFindMatch(',
    'function openFindPanel(',
    'function closeFindPanel(',
    'function readFindOptions(',
    'function renderFindResults(',
    'async function runFind(',
    'function replaceEditorText(',
    'async function runReplaceAll(',
    'function startFindSession(',
    'function clearFindSession('
  ]) {
    assert.equal(rendererSrc.includes(shape), false, 'renderer.js 里还有第二份：' + shape);
  }
  assert.equal(rendererSrc.split('findUiModule.create(').length - 1, 1, '装配只许一处');
  assert.ok(rendererSrc.includes('const findUiModule = window.CWFindUi;'));
  for (const line of [
    '    $, state, api, call, toast,',
    '    longOpLogic,',
    '    find: { findLogic, editorEl, syncEditorOverlay, scrollCaretIntoView, onEditorInput },',
    '    nav: { chapterTitle, switchChapter: (index) => switchChapter(index), loadChapterAt, currentChapterLabel: () => currentChapterLabel(), hideHeaderMenus },',
  ]) {
    assert.ok(rendererSrc.includes(line), '装配少了：' + line);
  }
  // WP-13：防重入（C12）与「回执按发起时捕获的书判定」（C2 口径）都长在模块里
  assert.match(moduleSrc, /let replaceAllBusy = false;/);
  assert.match(moduleSrc, /if \(replaceAllBusy\) return;/);
  assert.match(moduleSrc, /const bookPath = state\.bookPath;[\s\S]{0,160}readFindOptions\(\)/, 'C2：发起时先捕获书');
  assert.equal(moduleSrc.split('longOpLogic.sameBookPath(state.bookPath, bookPath)').length - 1, 2, '询问 / 预览两次 await 后都要核对');
  assert.match(moduleSrc, /longOpLogic\.decideAfterLongOp\(\{/);
  assert.match(moduleSrc, /await reloadAfterPartialFailure\(bookPath\)/, '失败兜底也只重载发起时那本');
  assert.equal(rendererSrc.split('findUi.setupFindUi();').length - 1, 1, 'setup 只调一次');
  for (const key of ['clearFindSession', 'closeFindPanel', 'findPanelOpen', 'findSessionActive', 'openFindPanel', 'runFind', 'selectFindMatch', 'stepFind', 'syncFindOverlayScroll']) {
    assert.match(rendererSrc, new RegExp('^      ' + key + ',$', 'm'), 'testHooksScope 少了 ' + key);
  }
  // Esc 动作表仍按名字取
  assert.match(rendererSrc, /'close-find': \(\) => closeFindPanel\(\),/);
  assert.match(rendererSrc, /'clear-find-session': \(\) => clearFindSession\(\{ toastHint: true \}\),/);
  // 查找书签按钮绑定已在补刀 9b 随书签域搬到 find-bookmark-ui.js：这里只断言 renderer 不再内嵌
  assert.equal(rendererSrc.includes("$('btn-find-bookmark').addEventListener"), false, '书签绑定应只在书签模块');
  assert.ok(rendererSrc.includes('findBookmarkUi.setupFindBookmarkUi();'), '书签 setup 调用一次');
});

test('静态闸门：index.html 在 renderer.js 之前加载 find-ui.js，且只加载一次', () => {
  const at = indexSrc.indexOf('<script src="find-ui.js"></script>');
  const rendererAt = indexSrc.indexOf('<script src="renderer.js"></script>');
  assert.notEqual(at, -1);
  assert.ok(at < rendererAt);
  assert.equal(indexSrc.split('find-ui.js').length - 1, 1);
});

test('静态闸门：模块不 require / 不摸 Electron·fs / 不注册全局监听；window 只读选区', () => {
  for (const forbidden of ['require(', 'ipcRenderer', 'node:fs', 'child_process', 'localStorage', 'fetch(', 'process.']) {
    assert.equal(moduleCode.includes(forbidden), false, 'find-ui.js 不许出现 ' + forbidden);
  }
  assert.equal(/window\.addEventListener|document\.addEventListener/.test(moduleCode), false);
  assert.ok(moduleCode.includes('window.getSelection'), '只允许读选区');
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWFindUi，且不乱造别的全局', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(moduleSrc, context, { filename: 'renderer/find-ui.js' });
  assert.equal(typeof win.CWFindUi, 'object');
  assert.deepEqual(Object.keys(win.CWFindUi).sort(), ['REQUIRED_HOST', 'create']);
  assert.equal(win.CWFindUi.REQUIRED_HOST.length, 11);
  assert.equal(win.CWTidyCardUi, undefined);
});

// ---------- WP-15 / C36：查找回执的世代令牌与身份复核 ----------
test('runFind（WP-15 / C36）：连按回车时先发后到的旧结果不覆盖新结果', async () => {
  const gates = [];
  const ctx = build({
    query: '张三',
    findAll: () => new Promise((resolve) => gates.push(resolve))
  });
  const first = ctx.ui.runFind();
  const second = ctx.ui.runFind();
  assert.equal(gates.length, 2);

  gates[1]({ count: 2, matches: [{ index: 3, length: 2 }, { index: 6, length: 2 }] });
  await second;
  const latestSummary = ctx.dom.map.get('find-summary').textContent;
  assert.match(latestSummary, /^本章命中 2 处/);
  assert.equal(ctx.state.find.total, 2);

  gates[0]({ count: 1, matches: [{ index: 0, length: 2 }] });
  assert.deepEqual(await first, { ok: false, stale: true }, '旧回执被令牌作废');
  assert.equal(ctx.dom.map.get('find-summary').textContent, latestSummary, '旧结果不许覆盖新摘要');
  assert.equal(ctx.state.find.total, 2, '旧命中不许改查找会话');
});

test('runFind（WP-15 / C36）：当前章查找在途切章 → 结果作废，不标到新章上', async () => {
  let release;
  const ctx = build({ query: '张三', findAll: () => new Promise((resolve) => { release = resolve; }) });
  const pending = ctx.ui.runFind();
  ctx.state.index = 1; // 载章流程会先改 index；这里模拟「查找在飞期间切到第二章」
  release({ count: 1, matches: [{ index: 0, length: 2 }] });
  assert.deepEqual(await pending, { ok: false, stale: true });
  assert.equal(
    ctx.dom.map.get('find-summary').textContent,
    '查找期间已经换了章节，这次结果没有显示；请重新查找'
  );
  assert.equal(ctx.state.find.total, 0, '旧正文的命中不许进新章的查找会话');
  assert.equal(ctx.dom.map.get('find-results').children.length, 0);
});

test('runFind（WP-15 / C36）：整本查找在途换书 → 旧书的清单不显示在新书面板里', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const ctx = build({ query: '张三', scope: 'book', searchBookGate: gate });
  const pending = ctx.ui.runFind();
  ctx.state.bookPath = '/书库/书乙';
  release();
  assert.deepEqual(await pending, { ok: false, stale: true });
  assert.equal(
    ctx.dom.map.get('find-summary').textContent,
    '查找期间已经换了书，这次结果没有显示；请重新查找'
  );
  assert.equal(ctx.dom.map.get('find-results').children.length, 0, '旧书的章名不许留在新书面板');
});
