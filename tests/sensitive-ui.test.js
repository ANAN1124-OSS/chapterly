const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sensitiveUi = require('../renderer/sensitive-ui');
const chaptersLib = require('../core/chapters');

// 第 4 步 renderer 九刀·第五刀：敏感词预检（原 renderer.js 4005–4327，323 行）搬到 renderer/sensitive-ui.js。
// 搬之前这一域只有 E2E 黑盒覆盖（选词表 → 预检 → 点命中跳过去）；词表状态文案 / 摘要各分支 /
// payload.ok===false 的降级 / 结果行结构 / 截断提示 / 跳转兜底 / persist 两条路径在 Node 里一步都测不到。
// 搬出来以后用「假 host + 假 DOM」逐条钉住，再用静态闸门保证渲染层不长回第二份。
//
// 契约：host 8 个成员 = 基础 5（$, state, api, call, toast）+ peers{closeFindPanel,closeProofreadPanel,
// currentChapterRef,matchRangeAt,renderSensitiveSettings} + nav{chapterTitle,editorEl,switchChapter} +
// view{effectiveConfig,hideHeaderMenus,scrollCaretIntoView}。

const realDocument = globalThis.document;
test.after(() => {
  if (realDocument === undefined) delete globalThis.document;
  else globalThis.document = realDocument;
});
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const moduleSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'sensitive-ui.js'), 'utf8');
const moduleCode = moduleSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------- 假 DOM ----------
function makeEl(tag = 'div', id = '') {
  const classes = new Set();
  const listeners = [];
  const el = {
    tagName: tag,
    id,
    className: '',
    textContent: '',
    value: '',
    disabled: false,
    dataset: {},
    children: [],
    parentNode: null,
    _classes: classes,
    _listeners: listeners,
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      contains: (n) => classes.has(n),
      toggle(n, on) {
        const next = on === undefined ? !classes.has(n) : Boolean(on);
        if (next) classes.add(n);
        else classes.delete(n);
      }
    },
    append(...nodes) { nodes.forEach((n) => el.appendChild(n)); },
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
    focus() { el._focus = (el._focus || 0) + 1; },
    setSelectionRange(start, end) { el.selectionStart = start; el.selectionEnd = end; },
    _fire(type, event) {
      let result;
      for (const l of listeners) if (l.type === type) result = l.fn(event);
      return result;
    }
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return ''; },
    set() { el.children.length = 0; }
  });
  return el;
}

function makeDocument() {
  const map = new Map();
  let lookups = 0;
  const doc = {
    createElement: (tag) => makeEl(tag),
    createTextNode(text) { const n = makeEl('#text'); n._textNode = true; n.textContent = text; return n; },
    getElementById: (id) => { lookups += 1; return map.get(id) || null; }
  };
  return {
    doc,
    map,
    get lookups() { return lookups; },
    $: (id) => doc.getElementById(id),
    ensure(id) { if (!map.has(id)) map.set(id, makeEl('div', id)); return map.get(id); }
  };
}

const BASE_IDS = [
  'sensitive-backdrop', 'sensitive-scope', 'sensitive-wordlist-text', 'sensitive-busy',
  'btn-sensitive-run', 'sensitive-summary', 'sensitive-results', 'find-backdrop', 'proofread-backdrop',
  'btn-sensitive', 'btn-sensitive-close', 'btn-sensitive-pick'
];

function makeChapters() {
  return [
    { id: 'c1', name: '第一章', file: 'c1.txt' },
    { id: 'c2', name: '第二章', file: 'c2.txt' }
  ];
}

function build(options = {}) {
  const dom = options.dom || makeDocument();
  for (const id of BASE_IDS) dom.ensure(id);
  dom.map.get('sensitive-backdrop').classList.add('hidden');
  dom.map.get('find-backdrop').classList.add('hidden');
  dom.map.get('proofread-backdrop').classList.add('hidden');
  dom.map.get('sensitive-scope').value = options.scope === undefined ? 'current' : options.scope;
  globalThis.document = dom.doc;
  const state = {
    bookPath: options.bookPath === undefined ? '/书库/书甲' : options.bookPath,
    chapters: options.chapters === undefined ? makeChapters() : options.chapters,
    index: options.index === undefined ? 0 : options.index,
    sensitiveScope: options.scope === undefined ? 'current' : options.scope,
    sensitiveBusy: false,
    sensitive: null,
    sensitiveWordList: options.wordList === undefined ? null : options.wordList,
    sensitiveWordsDraft: '',
    sensitiveWordsInfo: null,
    globalConfig: {},
    config: options.config || {}
  };
  const calls = {
    sensitiveWordsInfo: 0, sensitiveCheckBook: [], sensitiveCheckText: [], pickSensitiveWords: 0, setConfig: [],
    toast: [], closeFindPanel: 0, closeProofreadPanel: 0, renderSensitiveSettings: 0, hideHeaderMenus: 0,
    effectiveConfig: 0, switchChapter: [], scrollCaretIntoView: []
  };
  const api = {
    async sensitiveWordsInfo() {
      calls.sensitiveWordsInfo += 1;
      if (options.wordInfoError) throw new Error(options.wordInfoError);
      return options.wordInfo === undefined ? { ok: true, name: '敏感词.txt', count: 6 } : options.wordInfo;
    },
    async sensitiveCheckBook(...args) {
      calls.sensitiveCheckBook.push(args);
      if (options.checkError) throw new Error(options.checkError);
      return options.bookResult || {
        total: 2, chapterCount: 2, chapterHitCount: 1, wordHitCount: 2, skippedChapters: 0,
        byWord: [{ word: '血', count: 2 }], matches: []
      };
    },
    async sensitiveCheckText(text, opts) {
      calls.sensitiveCheckText.push([text, opts]);
      if (options.checkError) throw new Error(options.checkError);
      return options.textResult || {
        total: 1, wordHitCount: 1, byWord: [{ word: '血', count: 1 }], truncated: false,
        issues: [{ word: '血', index: 2, length: 1, line: 1, column: 3, snippet: { before: '正文', match: '血', after: '内容', ellipsisStart: true, ellipsisEnd: true } }]
      };
    },
    async pickSensitiveWords() {
      calls.pickSensitiveWords += 1;
      if (options.pickError) throw new Error(options.pickError);
      return options.picked === undefined ? { ok: true, path: '/词表/敏感词.txt', name: '敏感词.txt', count: 6 } : options.picked;
    },
    async setConfig(patch) {
      calls.setConfig.push(patch);
      return { sensitiveWordsPath: patch.sensitiveWordsPath };
    }
  };
  const editorEl = makeEl('textarea');
  editorEl.value = options.text === undefined ? '正文血内容' : options.text;
  const host = {
    $: dom.$,
    state,
    api,
    call: async (fn, ...args) => fn(...args),
    toast(message, kind) { calls.toast.push([message, kind]); },
    peers: {
      closeFindPanel() { calls.closeFindPanel += 1; },
      closeProofreadPanel() { calls.closeProofreadPanel += 1; },
      currentChapterRef: () => ({ chapterId: 'c1', chapterFile: 'c1.txt', text: editorEl.value }),
      matchRangeAt: (text, match) => {
        const source = String(text == null ? '' : text);
        const start = Math.min(Math.max(0, Number(match.index) || 0), source.length);
        return { start, end: start + Math.max(1, Number(match.length) || 1) };
      },
      renderSensitiveSettings() { calls.renderSensitiveSettings += 1; }
    },
    nav: {
      chapterTitle: (index, name) => chaptersLib.formatTitle(state.meta || null, index, name),
      editorEl,
      async switchChapter(index) {
        calls.switchChapter.push(index);
        if (options.switchCancel) return { ok: false, canceled: true };
        state.index = index;
        return { ok: true };
      }
    },
    view: {
      effectiveConfig() { calls.effectiveConfig += 1; return state.config; },
      hideHeaderMenus() { calls.hideHeaderMenus += 1; },
      scrollCaretIntoView(pos) { calls.scrollCaretIntoView.push(pos); }
    }
  };
  const ui = sensitiveUi.create(host);
  return { ui, host, state, dom, calls, editorEl };
}

// ---------- host 契约 ----------
test('host 契约：8 个成员 + 分组内每个真实依赖；缺任何一个都抛 TypeError', () => {
  assert.deepEqual([...sensitiveUi.REQUIRED_HOST].sort(), ['$', 'api', 'call', 'nav', 'peers', 'state', 'toast', 'view']);
  assert.equal(sensitiveUi.REQUIRED_HOST.length, 8);
  const ctx = build();
  assert.doesNotThrow(() => sensitiveUi.create(ctx.host));
  assert.throws(() => sensitiveUi.create(null), /createSensitiveUi 需要 host 对象/);
  for (const key of sensitiveUi.REQUIRED_HOST) {
    const broken = { ...ctx.host };
    delete broken[key];
    assert.throws(() => sensitiveUi.create(broken), new RegExp('host 缺少 ' + key.replace('$', '\\$')), '缺 ' + key);
  }
  for (const key of ['closeFindPanel', 'closeProofreadPanel', 'currentChapterRef', 'matchRangeAt', 'renderSensitiveSettings']) {
    const broken = { ...ctx.host, peers: { ...ctx.host.peers } };
    delete broken.peers[key];
    assert.throws(() => sensitiveUi.create(broken), new RegExp('host\\.peers 缺少 ' + key));
  }
  for (const key of ['chapterTitle', 'editorEl', 'switchChapter']) {
    const broken = { ...ctx.host, nav: { ...ctx.host.nav } };
    delete broken.nav[key];
    assert.throws(() => sensitiveUi.create(broken), new RegExp('host\\.nav 缺少 ' + key));
  }
  for (const key of ['effectiveConfig', 'hideHeaderMenus', 'scrollCaretIntoView']) {
    const broken = { ...ctx.host, view: { ...ctx.host.view } };
    delete broken.view[key];
    assert.throws(() => sensitiveUi.create(broken), new RegExp('host\\.view 缺少 ' + key));
  }
  assert.throws(() => sensitiveUi.create({ ...ctx.host, peers: 'x' }), /host\.peers 必须是对象/);
});

test('create() 只建表：不碰 DOM / 不注册事件 / 不建定时器，交出 8 个入口', () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  assert.equal(dom.lookups, 0, 'create() 一次 $ 都不该调');
  assert.deepEqual(Object.keys(ctx.ui).sort(), [
    'closeSensitivePanel', 'openSensitivePanel', 'pickSensitiveWords', 'refreshSensitiveWordList',
    'runSensitiveCheck', 'sensitiveScope', 'sensitiveWordListText', 'setupSensitiveUi'
  ]);
  assert.equal(moduleCode.includes('setInterval'), false);
});

// ---------- 词表文案 ----------
test('sensitiveWordListText：未读数 / 未配置 / 读失败 / 正常 / 各种跳过项 的文案逐字钉住', () => {
  const { ui } = build();
  assert.equal(ui.sensitiveWordListText(null), '正在读取词表…');
  assert.match(ui.sensitiveWordListText({ ok: false, code: 'WORD_LIST_NOT_CONFIGURED' }), /还没有指定词表/);
  assert.equal(ui.sensitiveWordListText({ ok: false, message: '文件没了' }), '文件没了');
  assert.equal(ui.sensitiveWordListText({ ok: false }), '词表读取失败');
  assert.equal(ui.sensitiveWordListText({ ok: true, name: '敏感词.txt', count: 6 }), '词表：敏感词.txt（6 个词）');
  assert.equal(
    ui.sensitiveWordListText({ ok: true, name: '敏感词.txt', count: 6, stats: { duplicates: 1, tooLong: 2, truncated: true } }),
    '词表：敏感词.txt（6 个词）（已跳过 1 个重复、2 行超长、超过 5000 个只取前 5000 个）'
  );
});

test('refreshSensitiveWordList：成功写 state + 渲染文案；失败写错误结构并加 warn', async () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  const info = await ctx.ui.refreshSensitiveWordList();
  assert.equal(ctx.calls.sensitiveWordsInfo, 1);
  assert.deepEqual(info, { ok: true, name: '敏感词.txt', count: 6 });
  assert.equal(ctx.state.sensitiveWordList, info);
  const el = dom.map.get('sensitive-wordlist-text');
  assert.equal(el.textContent, '词表：敏感词.txt（6 个词）');
  assert.equal(el.classList.contains('warn'), false);

  const failDom = makeDocument();
  const fail = build({ dom: failDom, wordInfoError: 'EACCES' });
  const failInfo = await fail.ui.refreshSensitiveWordList();
  assert.deepEqual(failInfo, { ok: false, code: 'ERROR', message: '读取词表失败：EACCES' });
  assert.equal(failDom.map.get('sensitive-wordlist-text').classList.contains('warn'), true);
});

// ---------- 面板开 / 关 / 范围 ----------
test('openSensitivePanel：没书 → 警告 toast false；有书 → 收菜单、关查找/校对框、回填范围、词表可用就自动预检', async () => {
  const noBook = build({ bookPath: null });
  assert.equal(await noBook.ui.openSensitivePanel(), false);
  assert.deepEqual(noBook.calls.toast, [['先打开一本书再预检', 'warn']]);

  const dom = makeDocument();
  const ctx = build({ dom, scope: 'book' });
  dom.map.get('find-backdrop').classList.remove('hidden');
  dom.map.get('proofread-backdrop').classList.remove('hidden');
  const res = await ctx.ui.openSensitivePanel();
  assert.equal(res, true);
  assert.equal(ctx.calls.hideHeaderMenus, 1);
  assert.equal(ctx.calls.closeFindPanel, 1);
  assert.equal(ctx.calls.closeProofreadPanel, 1);
  assert.equal(dom.map.get('sensitive-scope').value, 'book');
  assert.equal(dom.map.get('sensitive-backdrop').classList.contains('hidden'), false);
  assert.equal(ctx.calls.sensitiveCheckBook.length, 1, 'scope=book 自动跑整本');
});

test('openSensitivePanel：词表不可用 → 不自动跑，只清空结果并按词表状态给摘要', async () => {
  const dom = makeDocument();
  const ctx = build({ dom, wordInfo: { ok: false, message: '词表文件不见了' } });
  const res = await ctx.ui.openSensitivePanel();
  assert.equal(res, true);
  assert.equal(ctx.calls.sensitiveCheckText.length, 0);
  assert.equal(ctx.calls.sensitiveCheckBook.length, 0);
  assert.equal(dom.map.get('sensitive-summary').textContent, '词表文件不见了');
});

test('closeSensitivePanel / sensitiveScope：收起面板；范围只认 book / current', () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  dom.map.get('sensitive-backdrop').classList.remove('hidden');
  ctx.ui.closeSensitivePanel();
  assert.equal(dom.map.get('sensitive-backdrop').classList.contains('hidden'), true);
  assert.equal(ctx.ui.sensitiveScope(), 'current');
  dom.map.get('sensitive-scope').value = 'book';
  assert.equal(ctx.ui.sensitiveScope(), 'book');
  dom.map.get('sensitive-scope').value = 'x';
  assert.equal(ctx.ui.sensitiveScope(), 'current');
});

// ---------- 摘要 ----------
test('renderSensitiveSummary：payload.ok===false 时摘要显示原因（降级路径）', async () => {
  const ctx = build({ textResult: { ok: false, message: '词表不可用：编码不对', issues: [] } });
  await ctx.ui.runSensitiveCheck();
  assert.equal(ctx.dom.map.get('sensitive-summary').textContent, '词表不可用：编码不对');
});

test('runSensitiveCheck（当前章）：用编辑区内容调 sensitiveCheckText，结果补章信息；摘要 + 结果行逐项钉住', async () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  const res = await ctx.ui.runSensitiveCheck();
  assert.deepEqual(res, { ok: true, total: 1, scope: 'current' });
  assert.deepEqual(ctx.calls.sensitiveCheckText, [['正文血内容', {}]]);
  const payload = ctx.state.sensitive;
  assert.equal(payload.scope, 'current');
  assert.equal(payload.chapterId, 'c1');
  assert.equal(payload.matches[0].chapterId, 'c1');
  assert.equal(payload.matches[0].chapterIndex, 0);
  assert.equal(payload.matches[0].chapterName, '第一章');
  assert.equal(dom.map.get('sensitive-summary').textContent, '本章命中 1 处，涉及 1 个词：血 1');
  const box = dom.map.get('sensitive-results');
  assert.equal(box.children.length, 1);
  const row = box.children[0];
  assert.equal(row.className, 'proofread-result sensitive-result');
  assert.equal(row.dataset.word, '血');
  assert.equal(row.dataset.chapterId, 'c1');
  assert.equal(row.dataset.index, '2');
  const head = row.children[0];
  assert.equal(head.children.length, 2, '当前章：词 + 位置（无章名）');
  assert.equal(head.children[0].className, 'proofread-rule sensitive-word');
  assert.equal(head.children[0].textContent, '「血」');
  assert.equal(head.children[1].className, 'proofread-pos');
  assert.equal(head.children[1].textContent, '第 1 行 · 第 3 字');
  const snippet = row.children[1];
  assert.deepEqual(snippet.children.map((c) => c.textContent), ['…', '正文', '血', '内容', '…']);
  assert.equal(dom.map.get('sensitive-busy').classList.contains('hidden'), true);
});

test('runSensitiveCheck（整本）：调 sensitiveCheckBook 并带「当前章编辑区 override」；byWord 最多列 6 个 + 截断提示', async () => {
  const dom = makeDocument();
  const byWord = [];
  for (let i = 0; i < 8; i += 1) byWord.push({ word: `词${i}`, count: i + 1 });
  const ctx = build({
    dom, scope: 'book', text: '未保存的当前章',
    bookResult: { total: 8, chapterCount: 3, chapterHitCount: 2, wordHitCount: 8, skippedChapters: 1, byWord, matches: [], truncated: true }
  });
  await ctx.ui.runSensitiveCheck();
  const [bookPath, opts, override] = ctx.calls.sensitiveCheckBook[0];
  assert.equal(bookPath, '/书库/书甲');
  assert.deepEqual(opts, {});
  assert.deepEqual(override, { chapterId: 'c1', chapterFile: 'c1.txt', text: '未保存的当前章' });
  assert.equal(ctx.state.sensitive.scope, 'book');
  assert.equal(
    dom.map.get('sensitive-summary').textContent,
    '全书 3 章命中 8 处，涉及 2 章、8 个词：词0 1 · 词1 2 · 词2 3 · 词3 4 · 词4 5 · 词5 6（明细只列出一部分）'
  );
});

test('runSensitiveCheck：整本 0 命中（含跳过章节）/ 当前章 0 命中 的说明文案', async () => {
  const book = build({ scope: 'book', bookResult: { total: 0, chapterCount: 4, chapterHitCount: 0, wordHitCount: 0, skippedChapters: 3, byWord: [], matches: [] } });
  await book.ui.runSensitiveCheck();
  assert.equal(book.dom.map.get('sensitive-summary').textContent, '全书 4 章没有命中词表里的词（跳过 3 个缺文件的章节）');

  const current = build({ textResult: { total: 0, wordHitCount: 0, byWord: [], truncated: false, issues: [] } });
  await current.ui.runSensitiveCheck();
  assert.equal(current.dom.map.get('sensitive-summary').textContent, '本章没有命中词表里的词（只按你的词表做字面匹配，不判断文字好坏）');
  const empty = current.dom.map.get('sensitive-results').children[0];
  assert.equal(empty.className, 'proofread-empty');
  assert.equal(empty.textContent, '这一章没有命中词表里的词');
});

test('runSensitiveCheck：主进程返回 ok:false（词表坏）→ 降级为空结果 + 摘要显示原因 + 返回 ok:false', async () => {
  const dom = makeDocument();
  const ctx = build({ dom, textResult: { ok: false, message: '词表编码不对', issues: [] } });
  const res = await ctx.ui.runSensitiveCheck();
  assert.equal(res.ok, false);
  assert.equal(ctx.state.sensitive.ok, false);
  assert.equal(ctx.state.sensitive.total, 0);
  assert.deepEqual(ctx.state.sensitive.matches, []);
  assert.equal(dom.map.get('sensitive-summary').textContent, '词表编码不对');
  assert.equal(dom.map.get('sensitive-results').children.length, 0);
});

test('runSensitiveCheck：没书 / 忙碌 / 抛错三条分支', async () => {
  const noBook = build({ bookPath: null });
  assert.deepEqual(await noBook.ui.runSensitiveCheck(), { ok: false, message: '没有章节' });
  assert.equal(noBook.dom.map.get('sensitive-summary').textContent, '这本书里还没有章节');

  const busy = build();
  busy.state.sensitiveBusy = true;
  assert.deepEqual(await busy.ui.runSensitiveCheck(), { ok: false, message: '正在预检中' });
  assert.deepEqual(busy.calls.sensitiveCheckText, []);

  const boom = build({ checkError: '主进程炸了' });
  const res = await boom.ui.runSensitiveCheck();
  assert.deepEqual(res, { ok: false, message: '主进程炸了' });
  assert.equal(boom.dom.map.get('sensitive-summary').textContent, '预检失败：主进程炸了');
  assert.equal(boom.dom.map.get('sensitive-results').children.length, 0);
  assert.equal(boom.dom.map.get('sensitive-busy').classList.contains('hidden'), true);
});

test('结果列表：整本时每行带章名；明细超过 300 条时给截断提示', async () => {
  const matches = [];
  for (let i = 0; i < 305; i += 1) {
    matches.push({ word: '血', index: i, length: 1, line: i + 1, column: 1, chapterId: 'c1', chapterIndex: 0, chapterName: '第一章' });
  }
  const ctx = build({ scope: 'book', bookResult: { total: 305, chapterCount: 1, chapterHitCount: 1, wordHitCount: 1, skippedChapters: 0, byWord: [{ word: '血', count: 305 }], matches } });
  await ctx.ui.runSensitiveCheck();
  const box = ctx.dom.map.get('sensitive-results');
  assert.equal(box.children.length, 301);
  const head = box.children[0].children[0];
  assert.equal(head.children.length, 3);
  assert.equal(head.children[1].className, 'proofread-chapter');
  assert.equal(head.children[1].textContent, chaptersLib.formatTitle(null, 0, '第一章'));
  const more = box.children[300];
  assert.equal(more.className, 'proofread-more');
  assert.equal(more.textContent, '还有 5 条没有显示（一次最多列 300 条；可以先只预检当前章）');
});

test('结果列表：点一行 → 同章选中；跨章先切章；章节已删 toast 提示', async () => {
  const same = build();
  await same.ui.runSensitiveCheck();
  same.dom.map.get('sensitive-results').children[0]._fire('click');
  await flush();
  assert.equal(same.editorEl._focus, 1);
  assert.equal(same.editorEl.selectionStart, 2);
  assert.deepEqual(same.calls.scrollCaretIntoView, [2]);
  assert.deepEqual(same.calls.switchChapter, []);

  const cross = build({ scope: 'book' });
  cross.host.api.sensitiveCheckBook = async () => ({
    total: 1, chapterCount: 2, chapterHitCount: 1, wordHitCount: 1, skippedChapters: 0, byWord: [{ word: '血', count: 1 }],
    matches: [{ word: '血', index: 1, length: 1, line: 1, column: 2, chapterId: 'c2', chapterIndex: 1, chapterName: '第二章' }]
  });
  await cross.ui.runSensitiveCheck();
  cross.dom.map.get('sensitive-results').children[0]._fire('click');
  await flush();
  assert.deepEqual(cross.calls.switchChapter, [1]);
  assert.equal(cross.editorEl.selectionStart, 1);

  const gone = build({ scope: 'book' });
  gone.host.api.sensitiveCheckBook = async () => ({
    total: 1, chapterCount: 2, chapterHitCount: 1, wordHitCount: 1, skippedChapters: 0, byWord: [{ word: '血', count: 1 }],
    matches: [{ word: '血', index: 0, length: 1, line: 1, column: 1, chapterId: 'gone', chapterIndex: 0, chapterName: '没了' }]
  });
  await gone.ui.runSensitiveCheck();
  gone.dom.map.get('sensitive-results').children[0]._fire('click');
  await flush();
  assert.deepEqual(gone.calls.toast, [['这一章已经不存在了', 'warn']]);
  assert.deepEqual(gone.calls.switchChapter, []);
});

// ---------- 选词表 ----------
test('pickSensitiveWords：取消 / 不可用 / persist=false 草稿 / persist=true 写配置并按需重跑 / 抛错', async () => {
  const cancel = build({ picked: { canceled: true } });
  assert.deepEqual(await cancel.ui.pickSensitiveWords({ persist: false }), { canceled: true });

  const bad = build({ picked: { ok: false, message: '编码坏了' } });
  assert.deepEqual(await bad.ui.pickSensitiveWords(), { ok: false, message: '编码坏了' });
  assert.deepEqual(bad.calls.toast, [['这个词表不能用：编码坏了', 'error']]);

  const draft = build();
  const picked = await draft.ui.pickSensitiveWords({ persist: false });
  assert.equal(picked.ok, true);
  assert.equal(draft.state.sensitiveWordsDraft, '/词表/敏感词.txt');
  assert.equal(draft.state.sensitiveWordsInfo, picked);
  assert.equal(draft.state.sensitiveWordList, picked);
  assert.equal(draft.calls.renderSensitiveSettings, 1);
  assert.deepEqual(draft.calls.toast, [['已选择词表：敏感词.txt（6 个词）', undefined]]);
  assert.deepEqual(draft.calls.setConfig, []);

  const persist = build();
  await persist.ui.pickSensitiveWords({ persist: true });
  assert.deepEqual(persist.calls.setConfig, [{ sensitiveWordsPath: '/词表/敏感词.txt' }]);
  assert.equal(persist.calls.effectiveConfig, 1);
  assert.equal(persist.calls.sensitiveCheckText.length, 0, '面板没开就不重跑');

  const open = build();
  open.dom.map.get('sensitive-backdrop').classList.remove('hidden');
  await open.ui.pickSensitiveWords({ persist: true });
  assert.equal(open.calls.sensitiveCheckText.length, 1);

  const fail = build({ pickError: '磁盘满' });
  assert.deepEqual(await fail.ui.pickSensitiveWords(), { ok: false, message: '磁盘满' });
  assert.deepEqual(fail.calls.toast, [['选择词表失败：磁盘满', 'error']]);
});

// ---------- 事件绑定 ----------
test('setupSensitiveUi：3 个按钮 + 范围 change 注册；范围切换清结果并按范围给提示', () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  ctx.ui.setupSensitiveUi();
  for (const id of ['btn-sensitive-run', 'btn-sensitive-close', 'btn-sensitive-pick']) {
    assert.equal(dom.map.get(id)._listeners.length, 1, id + ' 注册一次');
    assert.equal(dom.map.get(id)._listeners[0].type, 'click');
  }
  const scope = dom.map.get('sensitive-scope');
  assert.deepEqual(scope._listeners.map((l) => l.type), ['change']);
  scope.value = 'book';
  scope._fire('change');
  assert.equal(ctx.state.sensitiveScope, 'book');
  assert.equal(ctx.state.sensitive, null);
  assert.equal(dom.map.get('sensitive-summary').textContent, '已切到整本书：点「开始预检」按词表通读全书（只读，缺文件的章节会跳过）。');
  scope.value = 'current';
  scope._fire('change');
  assert.equal(dom.map.get('sensitive-summary').textContent, '已切到当前这一章：点「开始预检」检查编辑区里的最新内容。');

  dom.map.get('btn-sensitive-close')._fire('click');
  assert.equal(dom.map.get('sensitive-backdrop').classList.contains('hidden'), true);
});

// ---------- 静态闸门 ----------
test('静态闸门：renderer.js 不再内嵌敏感词预检实现，只剩装配与转发', () => {
  for (const shape of [
    'function sensitiveWordListText(',
    'async function refreshSensitiveWordList(',
    'async function openSensitivePanel(',
    'function closeSensitivePanel(',
    'function sensitiveScope(',
    'function renderSensitiveSummary(',
    'function renderSensitiveResults(',
    'async function jumpToSensitiveMatch(',
    'async function runSensitiveCheck(',
    'async function pickSensitiveWords('
  ]) {
    assert.equal(rendererSrc.includes(shape), false, 'renderer.js 里还有第二份：' + shape);
  }
  assert.equal(rendererSrc.split('sensitiveUiModule.create(').length - 1, 1, '装配只许一处');
  assert.ok(rendererSrc.includes('const sensitiveUiModule = window.CWSensitiveUi;'));
  for (const line of [
    '    $, state, api, call, toast,',
    '    peers: { closeFindPanel, closeProofreadPanel, currentChapterRef, matchRangeAt, renderSensitiveSettings: () => renderSensitiveSettings() },',
    '    nav: { chapterTitle, editorEl, switchChapter },',
    '    view: { effectiveConfig, hideHeaderMenus, scrollCaretIntoView }'
  ]) {
    assert.ok(rendererSrc.includes(line), '装配少了：' + line);
  }
  assert.ok(rendererSrc.includes(
    'const { sensitiveWordListText, refreshSensitiveWordList, openSensitivePanel, closeSensitivePanel, sensitiveScope, runSensitiveCheck, pickSensitiveWords, setupSensitiveUi } = sensitiveUi;'
  ), '8 个入口按原名解构');
  for (const id of ['btn-sensitive-run', 'btn-sensitive-close', 'btn-sensitive-pick', 'sensitive-scope']) {
    assert.equal(rendererSrc.includes(`$('${id}').addEventListener`), false, '绑定应该只在模块里：' + id);
  }
  assert.equal(rendererSrc.split('sensitiveUi.setupSensitiveUi();').length - 1, 1, 'setup 只调一次');
  assert.match(rendererSrc, /'close-sensitive': \(\) => closeSensitivePanel\(\),/);
  assert.match(rendererSrc, /else if \(btn\.dataset\.action === 'sensitive'\) await openSensitivePanel\(\);/);
  assert.ok(rendererSrc.includes('sensitiveWordListText'), '设置域仍按名字用 sensitiveWordListText');
  assert.ok(rendererSrc.includes('refreshSensitiveWordList'), '设置域仍按名字用 refreshSensitiveWordList');
  assert.ok(rendererSrc.includes('pickSensitiveWords'), '设置面板按钮仍按名字用 pickSensitiveWords');
  for (const key of ['sensitiveWordListText', 'refreshSensitiveWordList', 'openSensitivePanel', 'closeSensitivePanel', 'sensitiveScope', 'runSensitiveCheck']) {
    assert.match(rendererSrc, new RegExp('^      ' + key + ',$', 'm'), 'testHooksScope 少了 ' + key);
  }
});

test('静态闸门：index.html 在 renderer.js 之前加载 sensitive-ui.js，且只加载一次', () => {
  const at = indexSrc.indexOf('<script src="sensitive-ui.js"></script>');
  const rendererAt = indexSrc.indexOf('<script src="renderer.js"></script>');
  assert.notEqual(at, -1);
  assert.ok(at < rendererAt);
  assert.equal(indexSrc.split('sensitive-ui.js').length - 1, 1);
});

test('静态闸门：模块不 require / 不摸 Electron·fs·网络，也不注册全局监听 / 不建定时器', () => {
  for (const forbidden of ['require(', 'ipcRenderer', 'node:fs', 'child_process', 'localStorage', 'fetch(', 'window.', 'process.']) {
    assert.equal(moduleCode.includes(forbidden), false, 'sensitive-ui.js 不许出现 ' + forbidden);
  }
  assert.equal(/window\.addEventListener|document\.addEventListener/.test(moduleCode), false);
  assert.equal((moduleCode.match(/setTimeout\(/g) || []).length, 0);
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWSensitiveUi，且不乱造别的全局', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(moduleSrc, context, { filename: 'renderer/sensitive-ui.js' });
  assert.equal(typeof win.CWSensitiveUi, 'object');
  assert.deepEqual(Object.keys(win.CWSensitiveUi).sort(), ['REQUIRED_HOST', 'create']);
  assert.equal(win.CWSensitiveUi.REQUIRED_HOST.length, 8);
  assert.equal(win.CWProofreadUi, undefined);
});
