const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const proofreadUi = require('../renderer/proofread-ui');
const chaptersLib = require('../core/chapters');

// 第 4 步 renderer 九刀·第四刀：校对（原 renderer.js 3991–4343，353 行）搬到 renderer/proofread-ui.js。
// 搬之前这一域只有 E2E 黑盒覆盖（打开面板 → 跑校对 → 点结果跳过去）；词表状态文案 / 摘要各分支 /
// 结果行结构 / 截断提示 / 跳转兜底 / 忙碌态 / 选词表 persist 两条路径在 Node 里一步都测不到。
// 搬出来以后用「假 host + 假 DOM」逐条钉住，再用静态闸门保证渲染层不长回第二份。
//
// 契约：host 8 个成员 = 基础 5（$, state, api, call, toast）+ peers{closeFindPanel,renderProofreadSettings}
// + nav{chapterTitle,editorEl,switchChapter} + view{effectiveConfig,hideHeaderMenus,scrollCaretIntoView}。

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
const moduleSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'proofread-ui.js'), 'utf8');
const moduleCode = moduleSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------- 假 DOM ----------
function makeEl(tag = 'div', id = '') {
  const classes = new Set();
  const listeners = [];
  const el = {
    tagName: tag,
    id,
    className: '',
    _attrs: {},
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
    setAttribute(name, value) { el._attrs[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(el._attrs, name) ? el._attrs[name] : null; },
    removeAttribute(name) { delete el._attrs[name]; },
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

// 1.5.0 功能-2：默认规则开关（与 core/proofread.DEFAULT_RULES 一致；下面有一致性测试钉住）
const DEFAULT_RULES = {
  'halfwidth-punct': true,
  'long-paragraph': true,
  'repeat-word': true,
  'punct-run': true,
  'blank-lines': true,
  'cjk-latin-spacing': false,
  ellipsis: true,
  dash: true,
  'fullwidth-digit': true,
  'custom-word': true
};

const BASE_IDS = [
  'proofread-backdrop', 'proofread-scope', 'proofread-wordlist-text', 'proofread-busy',
  'btn-proofread-run', 'proofread-summary', 'proofread-results', 'find-backdrop',
  'btn-proofread', 'btn-proofread-close', 'proofread-rules'
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
  dom.map.get('proofread-backdrop').classList.add('hidden');
  dom.map.get('find-backdrop').classList.add('hidden');
  // 范围下拉的 value 才是运行时事实来源（proofreadScope() 读 DOM）
  dom.map.get('proofread-scope').value = options.scope === undefined ? 'current' : options.scope;
  globalThis.document = dom.doc;
  const state = {
    bookPath: options.bookPath === undefined ? '/书库/书甲' : options.bookPath,
    chapters: options.chapters === undefined ? makeChapters() : options.chapters,
    index: options.index === undefined ? 0 : options.index,
    proofreadScope: options.scope === undefined ? 'current' : options.scope,
    proofreadBusy: false,
    proofread: null,
    proofreadWordList: options.wordList === undefined ? null : options.wordList,
    proofreadWordsDraft: '',
    proofreadWordsInfo: null,
    globalConfig: {},
    config: options.config || {}
  };
  const calls = {
    proofreadWordsInfo: 0, proofreadBook: [], proofreadText: [], pickProofreadWords: 0, setConfig: [],
    toast: [], closeFindPanel: 0, renderProofreadSettings: 0, hideHeaderMenus: 0, effectiveConfig: 0,
    switchChapter: [], scrollCaretIntoView: []
  };
  const api = {
    async proofreadWordsInfo() {
      calls.proofreadWordsInfo += 1;
      if (options.wordInfoError) throw new Error(options.wordInfoError);
      return options.wordInfo === undefined ? { ok: true, name: '校对词表.txt', count: 10 } : options.wordInfo;
    },
    async proofreadBook(...args) {
      calls.proofreadBook.push(args);
      if (options.proofreadError) throw new Error(options.proofreadError);
      return options.bookResult || {
        total: 2, chapterCount: 2, chapterHitCount: 1, skippedChapters: 0,
        byRule: { 'halfwidth-punct': 2 }, issues: []
      };
    },
    async proofreadText(text, optionsArg) {
      calls.proofreadText.push([text, optionsArg]);
      if (options.proofreadError) throw new Error(options.proofreadError);
      return options.textResult || {
        total: 1, byRule: { 'repeat-word': 1 }, truncated: false,
        issues: [{ rule: 'repeat-word', index: 2, length: 2, match: '的的', message: '重复用词', line: 1, column: 3, snippet: { before: '正文', match: '的的', after: '内容', ellipsisStart: true, ellipsisEnd: true } }]
      };
    },
    async pickProofreadWords() {
      calls.pickProofreadWords += 1;
      if (options.pickError) throw new Error(options.pickError);
      return options.picked === undefined ? { ok: true, path: '/词表/校对.txt', name: '校对词表.txt', count: 10 } : options.picked;
    },
    async setConfig(patch) {
      calls.setConfig.push(patch);
      return { proofreadWordsPath: patch.proofreadWordsPath };
    }
  };
  const editorEl = makeEl('textarea');
  editorEl.value = options.text === undefined ? '正文的的内容' : options.text;
  const host = {
    $: dom.$,
    state,
    api,
    call: async (fn, ...args) => fn(...args),
    toast(message, kind) { calls.toast.push([message, kind]); },
    peers: {
      closeFindPanel() { calls.closeFindPanel += 1; },
      renderProofreadSettings() { calls.renderProofreadSettings += 1; }
    },
    nav: {
      chapterTitle: (index, name) => chaptersLib.formatTitle(state.meta || null, index, name),
      editorEl,
      async switchChapter(index) {
        calls.switchChapter.push(index);
        if (options.switchFails) return { ok: false };
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
  const ui = proofreadUi.create(host);
  return { ui, host, state, dom, calls, editorEl };
}

// ---------- host 契约 ----------
test('host 契约：8 个成员 + 分组内每个真实依赖；缺任何一个都抛 TypeError', () => {
  assert.deepEqual([...proofreadUi.REQUIRED_HOST].sort(), ['$', 'api', 'call', 'nav', 'peers', 'state', 'toast', 'view']);
  assert.equal(proofreadUi.REQUIRED_HOST.length, 8);
  const ctx = build();
  assert.doesNotThrow(() => proofreadUi.create(ctx.host));
  assert.throws(() => proofreadUi.create(null), /createProofreadUi 需要 host 对象/);
  for (const key of proofreadUi.REQUIRED_HOST) {
    const broken = { ...ctx.host };
    delete broken[key];
    assert.throws(() => proofreadUi.create(broken), new RegExp('host 缺少 ' + key.replace('$', '\\$')), '缺 ' + key);
  }
  for (const key of ['closeFindPanel', 'renderProofreadSettings']) {
    const broken = { ...ctx.host, peers: { ...ctx.host.peers } };
    delete broken.peers[key];
    assert.throws(() => proofreadUi.create(broken), new RegExp('host\\.peers 缺少 ' + key));
  }
  for (const key of ['chapterTitle', 'editorEl', 'switchChapter']) {
    const broken = { ...ctx.host, nav: { ...ctx.host.nav } };
    delete broken.nav[key];
    assert.throws(() => proofreadUi.create(broken), new RegExp('host\\.nav 缺少 ' + key));
  }
  for (const key of ['effectiveConfig', 'hideHeaderMenus', 'scrollCaretIntoView']) {
    const broken = { ...ctx.host, view: { ...ctx.host.view } };
    delete broken.view[key];
    assert.throws(() => proofreadUi.create(broken), new RegExp('host\\.view 缺少 ' + key));
  }
  assert.throws(() => proofreadUi.create({ ...ctx.host, peers: 'x' }), /host\.peers 必须是对象/);
});

test('create() 只建表：不碰 DOM / 不注册事件 / 不建定时器，交出 10 个入口', () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  assert.equal(dom.lookups, 0, 'create() 一次 $ 都不该调');
  assert.deepEqual(Object.keys(ctx.ui).sort(), [
    'closeProofreadPanel', 'currentChapterRef', 'matchRangeAt', 'openProofreadPanel',
    'pickProofreadWords', 'proofreadScope', 'proofreadWordListText', 'refreshProofreadWordList',
    'runProofread', 'setupProofreadUi'
  ]);
  assert.equal(moduleCode.includes('setInterval'), false);
});

// ---------- 词表状态文案 ----------
test('proofreadWordListText：未读数 / 未配置 / 读失败 / 正常 / 各种忽略项 的文案逐字钉住', () => {
  const { ui } = build();
  assert.equal(ui.proofreadWordListText(null), '正在读取校对词表…');
  assert.match(ui.proofreadWordListText({ ok: false, code: 'GLOSSARY_NOT_CONFIGURED' }), /还没有指定校对词表/);
  assert.equal(ui.proofreadWordListText({ ok: false, message: '文件没了' }), '文件没了');
  assert.equal(ui.proofreadWordListText({ ok: false }), '校对词表读取失败');
  assert.equal(
    ui.proofreadWordListText({ ok: true, name: '词表.txt', count: 8 }),
    '校对词表：词表.txt（8 个词）'
  );
  assert.equal(
    ui.proofreadWordListText({ ok: true, name: '词表.txt', count: 8, stats: { suggestions: 3 } }),
    '校对词表：词表.txt（8 个词，3 个带建议）'
  );
  assert.equal(
    ui.proofreadWordListText({
      ok: true, name: '词表.txt', count: 8,
      stats: { duplicates: 1, tooLong: 2, invalid: 3, comments: 4, truncated: true }
    }),
    '校对词表：词表.txt（8 个词）（已忽略 1 个重复、2 行超长、3 行没有词、4 行注释、超过 5000 个只取前 5000 个）'
  );
});

test('refreshProofreadWordList：成功写 state + 渲染文案；失败写回错误结构并加 warn', async () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  const info = await ctx.ui.refreshProofreadWordList();
  assert.equal(ctx.calls.proofreadWordsInfo, 1);
  assert.deepEqual(info, { ok: true, name: '校对词表.txt', count: 10 });
  assert.equal(ctx.state.proofreadWordList, info);
  const textEl = dom.map.get('proofread-wordlist-text');
  assert.equal(textEl.textContent, '校对词表：校对词表.txt（10 个词）');
  assert.equal(textEl.classList.contains('warn'), false);

  const failDom = makeDocument();
  const fail = build({ dom: failDom, wordInfoError: 'EACCES' });
  const failInfo = await fail.ui.refreshProofreadWordList();
  assert.equal(failInfo.ok, false);
  assert.match(failInfo.message, /读取校对词表失败：EACCES/);
  assert.equal(failDom.map.get('proofread-wordlist-text').classList.contains('warn'), true);
});

// ---------- matchRangeAt ----------
test('matchRangeAt：位置对上 / 附近找到 / 找不到落回原位置 / 空 match 用 length / 坏输入都不崩', () => {
  const { ui } = build();
  const text = '0123456789abcdefghij';
  assert.deepEqual(ui.matchRangeAt(text, { index: 2, match: '234' }), { start: 2, end: 5 });
  // 原位置对不上，但在附近（往回 500 字）能再找到一次（text 里 'ab' 在 10）
  assert.deepEqual(ui.matchRangeAt(text, { index: 8, match: 'ab' }), { start: 10, end: 12 });
  // 附近也没有：落在原位置
  assert.deepEqual(ui.matchRangeAt(text, { index: 20, match: 'zzz' }), { start: 20, end: 20 });
  // 空 match：按 length 取（至少 1，最多到文末）
  assert.deepEqual(ui.matchRangeAt('abc', { index: 1, length: 2 }), { start: 1, end: 3 });
  assert.deepEqual(ui.matchRangeAt('abc', { index: 99, length: 2 }), { start: 3, end: 4 }, '位置夹到文末，长度至少 1');
  // 坏输入
  assert.deepEqual(ui.matchRangeAt(null, { index: 0, match: 'a' }), { start: 0, end: 0 });
  assert.deepEqual(ui.matchRangeAt('abc', {}), { start: 0, end: 1 });
});

// ---------- 面板开 / 关 / 范围 ----------
test('openProofreadPanel：没书 → 警告 toast 并返回 false，不碰面板', async () => {
  const ctx = build({ bookPath: null });
  assert.equal(await ctx.ui.openProofreadPanel(), false);
  assert.deepEqual(ctx.calls.toast, [['先打开一本书再校对', 'warn']]);
  assert.deepEqual(ctx.calls.proofreadText, []);
});

test('openProofreadPanel：收顶栏菜单、关查找框、回填范围、显示面板、先读词表再自动跑一次', async () => {
  const dom = makeDocument();
  const ctx = build({ dom, scope: 'book' });
  dom.map.get('find-backdrop').classList.remove('hidden');
  const res = await ctx.ui.openProofreadPanel();
  assert.equal(res, true);
  assert.equal(ctx.calls.hideHeaderMenus, 1);
  assert.equal(ctx.calls.closeFindPanel, 1, '查找面板开着要先关');
  assert.equal(dom.map.get('proofread-scope').value, 'book');
  assert.equal(dom.map.get('proofread-backdrop').classList.contains('hidden'), false);
  assert.equal(ctx.calls.proofreadWordsInfo, 1);
  assert.equal(ctx.calls.proofreadBook.length, 1, '打开后按范围自动跑一次（scope=book 走整本）');
});

test('closeProofreadPanel / proofreadScope：收起面板；范围只认 book / current', () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  dom.map.get('proofread-backdrop').classList.remove('hidden');
  ctx.ui.closeProofreadPanel();
  assert.equal(dom.map.get('proofread-backdrop').classList.contains('hidden'), true);
  assert.equal(ctx.ui.proofreadScope(), 'current');
  dom.map.get('proofread-scope').value = 'book';
  assert.equal(ctx.ui.proofreadScope(), 'book');
  dom.map.get('proofread-scope').value = '怪值';
  assert.equal(ctx.ui.proofreadScope(), 'current');
});

test('currentChapterRef：没章节返回 null；否则带 chapterId / chapterFile / 编辑区最新正文', () => {
  const empty = build({ chapters: [] });
  assert.equal(empty.ui.currentChapterRef(), null);
  const ctx = build({ text: '编辑区里的正文' });
  assert.deepEqual(ctx.ui.currentChapterRef(), { chapterId: 'c1', chapterFile: 'c1.txt', text: '编辑区里的正文' });
});

// ---------- 跑校对 ----------
test('runProofread：没书 / 没章节 / 忙碌 三种早退', async () => {
  const noBook = build({ bookPath: null });
  noBook.dom.map.get('proofread-summary');
  assert.deepEqual(await noBook.ui.runProofread(), { ok: false, message: '没有章节' });
  assert.equal(noBook.dom.map.get('proofread-summary').textContent, '这本书里还没有章节');

  const busy = build();
  busy.state.proofreadBusy = true;
  assert.deepEqual(await busy.ui.runProofread(), { ok: false, message: '正在校对中' });
  assert.deepEqual(busy.calls.proofreadText, []);
});

test('runProofread（当前章）：用编辑区内容调 proofreadText，结果补上章信息并渲染摘要 / 列表', async () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  const res = await ctx.ui.runProofread();
  assert.equal(res.ok, true);
  assert.equal(res.total, 1);
  assert.equal(res.scope, 'current');
  assert.deepEqual(ctx.calls.proofreadText, [
    ['正文的的内容', { rules: { ...DEFAULT_RULES } }]
  ]);
  const payload = ctx.state.proofread;
  assert.equal(payload.scope, 'current');
  assert.equal(payload.chapterId, 'c1');
  assert.equal(payload.chapterIndex, 0);
  assert.equal(payload.chapterName, '第一章');
  assert.deepEqual(payload.chapters, [{
    chapterId: 'c1', chapterIndex: 0, name: '第一章', total: 1, byRule: { 'repeat-word': 1 }, truncated: false
  }]);
  assert.equal(dom.map.get('proofread-summary').textContent, '本章共 1 处可疑：重复用词 1');
  const box = dom.map.get('proofread-results');
  assert.equal(box.children.length, 1);
  const row = box.children[0];
  assert.equal(row.className, 'proofread-result');
  assert.equal(row.dataset.rule, 'repeat-word');
  assert.equal(row.dataset.chapterId, 'c1');
  assert.equal(row.dataset.index, '2');
  assert.equal(row.children[0].children[0].textContent, '重复用词', '当前章不显示章名');
  assert.equal(row.children[1].textContent, '重复用词');
  assert.equal(row.children[2].children[0].textContent, '…');
  assert.equal(row.children[2].children[1].textContent, '正文');
  assert.equal(row.children[2].children[2].tagName, 'mark');
  assert.equal(row.children[2].children[2].textContent, '的的');
  assert.equal(row.children[2].children[3].textContent, '内容');
  assert.equal(row.children[2].children[4].textContent, '…');
  assert.equal(dom.map.get('proofread-busy').classList.contains('hidden'), true, '跑完收起忙碌态');
  assert.equal(dom.map.get('btn-proofread-run').disabled, false);
});

test('runProofread（整本）：调 proofreadBook 并带上「当前章编辑区内容」override；scope=book', async () => {
  const dom = makeDocument();
  const ctx = build({ dom, scope: 'book', text: '未保存的当前章' });
  const res = await ctx.ui.runProofread();
  assert.equal(res.ok, true);
  assert.equal(ctx.state.proofreadScope, 'book');
  assert.equal(ctx.calls.proofreadBook.length, 1);
  const [bookPath, opts, override] = ctx.calls.proofreadBook[0];
  assert.equal(bookPath, '/书库/书甲');
  assert.deepEqual(opts, { rules: { ...DEFAULT_RULES } });
  assert.deepEqual(override, { chapterId: 'c1', chapterFile: 'c1.txt', text: '未保存的当前章' });
  assert.equal(ctx.state.proofread.scope, 'book');
  assert.equal(dom.map.get('proofread-summary').textContent, '全书 2 章共 2 处可疑，涉及 1 章：半角标点 2');
});

test('runProofread：整本 0 处 / 跳过缺文件章节 的摘要文案', async () => {
  const ctx = build({ scope: 'book', bookResult: { total: 0, chapterCount: 5, chapterHitCount: 0, skippedChapters: 2, byRule: {}, issues: [] } });
  await ctx.ui.runProofread();
  assert.equal(ctx.dom.map.get('proofread-summary').textContent, '全书 5 章没有发现可疑的地方（跳过 2 个缺文件的章节）');
});

test('runProofread：当前章 0 处的说明文案（解释只查什么）', async () => {
  const ctx = build({ textResult: { total: 0, byRule: {}, truncated: false, issues: [] } });
  await ctx.ui.runProofread();
  assert.equal(
    ctx.dom.map.get('proofread-summary').textContent,
    '本章没有发现可疑的地方（只检查空白、标点、段落长度、重复用词和你的校对词表，不判断文字好坏）'
  );
  const empty = ctx.dom.map.get('proofread-results').children[0];
  assert.equal(empty.className, 'proofread-empty');
  assert.equal(empty.textContent, '这一章没有发现可疑的地方');
});

test('runProofread：失败 → 摘要「校对失败：」+ 清空列表 + 收起忙碌态', async () => {
  const dom = makeDocument();
  const ctx = build({ dom, proofreadError: '主进程炸了' });
  dom.map.get('proofread-results').appendChild(makeEl('div'));
  const res = await ctx.ui.runProofread();
  assert.deepEqual(res, { ok: false, message: '主进程炸了' });
  assert.equal(dom.map.get('proofread-summary').textContent, '校对失败：主进程炸了');
  assert.equal(dom.map.get('proofread-results').children.length, 0);
  assert.equal(ctx.state.proofread, null);
  assert.equal(dom.map.get('proofread-busy').classList.contains('hidden'), true);
});

test('结果列表：整本时每行带章名；明细超过 300 条时给截断提示', async () => {
  const issues = [];
  for (let i = 0; i < 305; i += 1) {
    issues.push({ rule: 'long-paragraph', index: i, match: 'x', message: '超长', line: i + 1, column: 1, chapterId: 'c1', chapterIndex: 0, chapterName: '第一章' });
  }
  const ctx = build({
    scope: 'book',
    bookResult: { total: 305, chapterCount: 1, chapterHitCount: 1, skippedChapters: 0, byRule: { 'long-paragraph': 305 }, issues }
  });
  await ctx.ui.runProofread();
  const box = ctx.dom.map.get('proofread-results');
  assert.equal(box.children.length, 301, '300 条明细 + 1 条「还有…」提示');
  const firstHead = box.children[0].children[0];
  assert.equal(firstHead.children.length, 3, '整本结果行：规则 + 章名 + 位置');
  assert.equal(firstHead.children[1].className, 'proofread-chapter');
  assert.equal(firstHead.children[1].textContent, chaptersLib.formatTitle(null, 0, '第一章'));
  const more = box.children[300];
  assert.equal(more.className, 'proofread-more');
  assert.equal(more.textContent, '还有 5 条没有显示（一次最多列 300 条；可以先只校对当前章）');
});

test('结果列表：点一行 → 同章直接按 index + match 选中并滚动', async () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  await ctx.ui.runProofread();
  const row = dom.map.get('proofread-results').children[0];
  row._fire('click');
  await flush();
  assert.equal(ctx.editorEl._focus, 1);
  assert.equal(ctx.editorEl.selectionStart, 2, '同章：按 index + match 定位');
  assert.equal(ctx.editorEl.selectionEnd, 4);
  assert.deepEqual(ctx.calls.scrollCaretIntoView, [2]);
  assert.deepEqual(ctx.calls.switchChapter, []);
});

test('结果列表：跨章结果 → 先 switchChapter 再选中；切章被取消 / 失败就停住；章节已删 toast 提示', async () => {
  // 跨章成功
  const cross = build({ scope: 'book' });
  cross.dom.map.get('proofread-backdrop').classList.remove('hidden');
  const bookIssue = { rule: 'repeat-word', index: 1, length: 2, match: '的的', message: '重复用词', line: 1, column: 1, chapterId: 'c2', chapterIndex: 1, chapterName: '第二章' };
  cross.host.api.proofreadBook = async () => ({ total: 1, chapterCount: 2, chapterHitCount: 1, skippedChapters: 0, byRule: { 'repeat-word': 1 }, issues: [bookIssue] });
  await cross.ui.runProofread();
  cross.dom.map.get('proofread-results').children[0]._fire('click');
  await flush();
  assert.deepEqual(cross.calls.switchChapter, [1]);
  assert.equal(cross.editorEl.selectionStart, 2);

  // 切章被取消：不选中、不滚
  const canceled = build({ scope: 'book', switchCancel: true });
  canceled.host.api.proofreadBook = async () => ({ total: 1, chapterCount: 2, chapterHitCount: 1, skippedChapters: 0, byRule: { 'repeat-word': 1 }, issues: [bookIssue] });
  await canceled.ui.runProofread();
  canceled.dom.map.get('proofread-results').children[0]._fire('click');
  await flush();
  assert.deepEqual(canceled.calls.scrollCaretIntoView, []);
  assert.deepEqual(canceled.calls.switchChapter, [1]);

  // 章节已删除：toast 提示，不切章
  const gone = build({ scope: 'book' });
  gone.host.api.proofreadBook = async () => ({ total: 1, chapterCount: 2, chapterHitCount: 1, skippedChapters: 0, byRule: { 'repeat-word': 1 }, issues: [{ ...bookIssue, chapterId: 'gone', chapterIndex: 0 }] });
  await gone.ui.runProofread();
  gone.dom.map.get('proofread-results').children[0]._fire('click');
  await flush();
  assert.deepEqual(gone.calls.toast, [['这一章已经不存在了', 'warn']]);
  assert.deepEqual(gone.calls.switchChapter, []);
});

test('pickProofreadWords：取消 / 词表不可用 / persist=false 只进草稿 / persist=true 立刻写配置并按需重跑', async () => {
  const cancel = build({ picked: { canceled: true } });
  assert.deepEqual(await cancel.ui.pickProofreadWords({ persist: false }), { canceled: true });
  assert.deepEqual(cancel.calls.setConfig, []);

  const bad = build({ picked: { ok: false, message: '编码坏了' } });
  assert.deepEqual(await bad.ui.pickProofreadWords(), { ok: false, message: '编码坏了' });
  assert.deepEqual(bad.calls.toast, [['这个词表不能用：编码坏了', 'error']]);

  const draft = build();
  const picked = await draft.ui.pickProofreadWords({ persist: false });
  assert.equal(picked.ok, true);
  assert.equal(draft.state.proofreadWordsDraft, '/词表/校对.txt');
  assert.equal(draft.state.proofreadWordsInfo, picked);
  assert.equal(draft.state.proofreadWordList, picked);
  assert.equal(draft.calls.renderProofreadSettings, 1);
  assert.deepEqual(draft.calls.toast, [['已选择校对词表：校对词表.txt（10 个词）', undefined]]);
  assert.deepEqual(draft.calls.setConfig, []);

  const persist = build();
  await persist.ui.pickProofreadWords({ persist: true });
  assert.deepEqual(persist.calls.setConfig, [{ proofreadWordsPath: '/词表/校对.txt' }]);
  assert.equal(persist.calls.effectiveConfig, 1);
  assert.equal(persist.state.proofreadWordsDraft, '/词表/校对.txt');
  assert.equal(persist.calls.proofreadText.length, 0, '面板没开就不重跑');

  // 面板开着 + persist → 选完自动重跑
  const open = build();
  open.dom.map.get('proofread-backdrop').classList.remove('hidden');
  await open.ui.pickProofreadWords({ persist: true });
  assert.equal(open.calls.proofreadText.length, 1);

  const fail = build({ pickError: '磁盘满' });
  assert.deepEqual(await fail.ui.pickProofreadWords(), { ok: false, message: '磁盘满' });
  assert.deepEqual(fail.calls.toast, [['选择校对词表失败：磁盘满', 'error']]);
});

// ---------- 事件绑定 ----------
test('setupProofreadUi：3 个按钮 + 范围 change 全部注册；范围切换清结果并按范围给提示', async () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  ctx.ui.setupProofreadUi();
  for (const id of ['btn-proofread', 'btn-proofread-run', 'btn-proofread-close']) {
    assert.equal(dom.map.get(id)._listeners.length, 1, id + ' 注册一次');
    assert.equal(dom.map.get(id)._listeners[0].type, 'click');
  }
  const scope = dom.map.get('proofread-scope');
  assert.deepEqual(scope._listeners.map((l) => l.type), ['change']);

  scope.value = 'book';
  scope._fire('change');
  assert.equal(ctx.state.proofreadScope, 'book');
  assert.equal(ctx.state.proofread, null);
  assert.equal(dom.map.get('proofread-summary').textContent, '已切到整本书：点「开始校对」通读全书（只读，缺文件的章节会跳过）。');
  scope.value = 'current';
  scope._fire('change');
  assert.equal(dom.map.get('proofread-summary').textContent, '已切到当前这一章：点「开始校对」检查编辑区里的最新内容。');

  // 关闭按钮
  dom.map.get('btn-proofread-close')._fire('click');
  assert.equal(dom.map.get('proofread-backdrop').classList.contains('hidden'), true);
});

// ---------- 静态闸门 ----------
test('静态闸门：renderer.js 不再内嵌校对实现，只剩装配与转发', () => {
  for (const shape of [
    'function proofreadWordListText(',
    'async function refreshProofreadWordList(',
    'async function openProofreadPanel(',
    'function closeProofreadPanel(',
    'function proofreadScope(',
    'function currentChapterRef(',
    'function matchRangeAt(',
    'async function runProofread(',
    'async function pickProofreadWords(',
    'function renderProofreadResults('
  ]) {
    assert.equal(rendererSrc.includes(shape), false, 'renderer.js 里还有第二份：' + shape);
  }
  assert.equal(rendererSrc.split('proofreadUiModule.create(').length - 1, 1, '装配只许一处');
  assert.ok(rendererSrc.includes('const proofreadUiModule = window.CWProofreadUi;'));
  for (const line of [
    '    $, state, api, call, toast,',
    '    peers: { closeFindPanel, renderProofreadSettings: () => renderProofreadSettings() },',
    '    nav: { chapterTitle, editorEl, switchChapter },',
    '    view: { effectiveConfig, hideHeaderMenus, scrollCaretIntoView }'
  ]) {
    assert.ok(rendererSrc.includes(line), '装配少了：' + line);
  }
  assert.ok(rendererSrc.includes(
    'const { proofreadWordListText, refreshProofreadWordList, openProofreadPanel, closeProofreadPanel, proofreadScope, currentChapterRef, matchRangeAt, runProofread, pickProofreadWords, setupProofreadUi } = proofreadUi;'
  ), '10 个入口按原名解构');
  // 绑定块搬走：renderer 里不再注册校对 3 按钮 / 范围 change，只留一次 setup 调用
  for (const id of ['btn-proofread', 'btn-proofread-run', 'btn-proofread-close', 'proofread-scope']) {
    assert.equal(rendererSrc.includes(`$('${id}').addEventListener`), false, '绑定应该只在模块里：' + id);
  }
  assert.equal(rendererSrc.split('proofreadUi.setupProofreadUi();').length - 1, 1, 'setup 只调一次');
  // Esc 动作表 / 查找替换 / 敏感词 / 设置 / 测试钩子仍按名字取
  assert.match(rendererSrc, /'close-proofread': \(\) => closeProofreadPanel\(\),/);
  assert.ok(rendererSrc.includes('proofreadWordListText'), '设置域仍按名字用 proofreadWordListText');
  assert.ok(rendererSrc.includes('refreshProofreadWordList'), '设置域仍按名字用 refreshProofreadWordList');
  assert.ok(rendererSrc.includes('pickProofreadWords'), '设置面板按钮仍按名字用 pickProofreadWords');
  assert.ok(rendererSrc.includes('currentChapterRef') && rendererSrc.includes('matchRangeAt'), '敏感词域仍按名字用两个共享定位函数');
  for (const key of ['proofreadWordListText', 'refreshProofreadWordList', 'openProofreadPanel', 'closeProofreadPanel', 'proofreadScope', 'runProofread']) {
    assert.match(rendererSrc, new RegExp('^      ' + key + ',$', 'm'), 'testHooksScope 少了 ' + key);
  }
});

test('静态闸门：index.html 在 renderer.js 之前加载 proofread-ui.js，且只加载一次', () => {
  const at = indexSrc.indexOf('<script src="proofread-ui.js"></script>');
  const rendererAt = indexSrc.indexOf('<script src="renderer.js"></script>');
  assert.notEqual(at, -1);
  assert.ok(at < rendererAt);
  assert.equal(indexSrc.split('proofread-ui.js').length - 1, 1);
});

test('静态闸门：模块不 require / 不摸 Electron·fs·网络，也不注册全局监听', () => {
  for (const forbidden of ['require(', 'ipcRenderer', 'node:fs', 'child_process', 'localStorage', 'fetch(', 'window.', 'process.']) {
    assert.equal(moduleCode.includes(forbidden), false, 'proofread-ui.js 不许出现 ' + forbidden);
  }
  assert.equal(/window\.addEventListener|document\.addEventListener/.test(moduleCode), false, '模块不注册全局监听');
  assert.equal((moduleCode.match(/setTimeout\(/g) || []).length, 0, '模块不建定时器');
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWProofreadUi，且不乱造别的全局', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(moduleSrc, context, { filename: 'renderer/proofread-ui.js' });
  assert.equal(typeof win.CWProofreadUi, 'object');
  assert.deepEqual(Object.keys(win.CWProofreadUi).sort(), ['REQUIRED_HOST', 'create']);
  assert.equal(win.CWProofreadUi.REQUIRED_HOST.length, 8);
  assert.equal(win.CWEditorMarksUi, undefined);
});

// ---------- 1.5.0 功能-2：规则开关 ----------

test('规则表一致性：面板画的 10 行与 core/proofread 的 RULE_ORDER / 文案 / 默认开关逐个对齐', async () => {
  const core = require('../core/proofread');
  const dom = makeDocument();
  const ctx = build({ dom });
  await ctx.ui.runProofread();
  const box = dom.map.get('proofread-rules');
  assert.deepEqual(box.children.map((row) => row.dataset.rule), [...core.RULE_ORDER]);
  assert.deepEqual(
    box.children.map((row) => row.children[0].textContent),
    core.RULE_ORDER.map((rule) => core.RULE_LABELS[rule])
  );
  assert.deepEqual(
    box.children.map((row) => row.getAttribute('aria-pressed') === 'true'),
    core.RULE_ORDER.map((rule) => core.DEFAULT_RULES[rule])
  );
});

test('规则开关：默认只关「中英间距」；命中数取本次 byRule，没跑过是「—」', async () => {
  const dom = makeDocument();
  const ctx = build({
    dom,
    textResult: {
      total: 3,
      byRule: { ellipsis: 2, dash: 1 },
      truncated: false,
      issues: []
    }
  });
  assert.deepEqual(ctx.dom.map.get('proofread-rules').children, [], 'create() 不画 DOM');
  await ctx.ui.runProofread();
  const box = dom.map.get('proofread-rules');
  const row = (rule) => box.children.find((item) => item.dataset.rule === rule);
  assert.equal(row('ellipsis').children[1].textContent, '2');
  assert.equal(row('dash').children[1].textContent, '1');
  assert.equal(row('cjk-latin-spacing').children[1].textContent, '0');
  assert.equal(row('cjk-latin-spacing').classList.contains('off'), true);
  assert.equal(row('cjk-latin-spacing').getAttribute('aria-pressed'), 'false');
  assert.equal(row('ellipsis').classList.contains('off'), false);
  assert.equal(row('ellipsis').getAttribute('aria-pressed'), 'true');
  // 每行给屏幕阅读器一份完整说明（名字 + 状态 + 本次命中数）
  assert.match(row('ellipsis').getAttribute('aria-label'), /省略号：已开启，本次命中 2 处/);
  assert.match(row('cjk-latin-spacing').getAttribute('aria-label'), /中英间距：已关闭，本次命中 0 处/);
});

test('规则开关：点一下翻转、立刻按新开关重跑，命中数跟着归零；再点回来恢复', async () => {
  let byRule = { ellipsis: 1, dash: 1 };
  const dom = makeDocument();
  const ctx = build({
    dom,
    textResult: { total: 2, byRule, truncated: false, issues: [] }
  });
  await ctx.ui.runProofread();
  // 模拟面板开着（真实流程是 openProofreadPanel 里去掉 hidden）
  dom.map.get('proofread-backdrop').classList.remove('hidden');
  const box = dom.map.get('proofread-rules');
  const row = (rule) => box.children.find((item) => item.dataset.rule === rule);
  assert.equal(ctx.calls.proofreadText.length, 1);

  // 关掉省略号：重跑一次，选项里 ellipsis=false
  row('ellipsis')._fire('click');
  assert.equal(ctx.state.proofreadRules.ellipsis, false);
  assert.equal(row('ellipsis').getAttribute('aria-pressed'), 'false');
  assert.equal(row('ellipsis').classList.contains('off'), true);
  await flush();
  await flush();
  assert.equal(ctx.calls.proofreadText.length, 2, '面板开着要立刻重跑');
  assert.deepEqual(ctx.calls.proofreadText[1][1], {
    rules: { ...DEFAULT_RULES, ellipsis: false }
  });

  // 再点回来
  row('ellipsis')._fire('click');
  assert.equal(ctx.state.proofreadRules.ellipsis, true);
  assert.equal(row('ellipsis').getAttribute('aria-pressed'), 'true');
  await flush();
  await flush();
  assert.equal(ctx.calls.proofreadText.length, 3);
  assert.deepEqual(ctx.calls.proofreadText[2][1], { rules: { ...DEFAULT_RULES } });
});

test('规则开关：面板没开时只改内存不跑校对；整本范围也带同一份开关', async () => {
  const dom = makeDocument();
  const ctx = build({ dom, scope: 'book' });
  await ctx.ui.runProofread();
  assert.equal(ctx.calls.proofreadBook.length, 1);
  assert.deepEqual(ctx.calls.proofreadBook[0][1], { rules: { ...DEFAULT_RULES } });

  // 关掉面板再点：不再重跑
  dom.map.get('proofread-backdrop').classList.add('hidden');
  const box = dom.map.get('proofread-rules');
  box.children.find((item) => item.dataset.rule === 'dash')._fire('click');
  await flush();
  await flush();
  assert.equal(ctx.state.proofreadRules.dash, false);
  assert.equal(ctx.calls.proofreadBook.length, 1);
  // 不写配置：整段开关只在内存
  assert.equal(ctx.calls.setConfig.length, 0);
});

test('规则开关：校对进行中被点开关不吞点击，跑完立刻按最新开关补跑一次', async () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  const original = ctx.host.api.proofreadText;
  let release;
  let calls = 0;
  ctx.host.api.proofreadText = async (...args) => {
    calls += 1;
    if (calls === 1) await new Promise((resolve) => { release = resolve; });
    return original(...args);
  };
  const opening = ctx.ui.openProofreadPanel();
  await flush();
  await flush();
  assert.equal(calls, 1);
  assert.equal(ctx.state.proofreadBusy, true, '第一轮还卡在 IPC 上');
  const box = dom.map.get('proofread-rules');
  box.children.find((row) => row.dataset.rule === 'ellipsis')._fire('click');
  assert.equal(ctx.state.proofreadRules.ellipsis, false);
  assert.equal(calls, 1, '正在跑时不并发第二次');
  release();
  await opening;
  await flush();
  await flush();
  assert.equal(calls, 2, '跑完按新开关补跑一次');
  assert.deepEqual(ctx.calls.proofreadText[1][1], { rules: { ...DEFAULT_RULES, ellipsis: false } });
});

test('规则开关：不写配置、不新增字段——模块里没有把 proofreadRules 传进 setConfig', () => {
  assert.equal(moduleCode.includes('proofreadRulesPath'), false);
  assert.equal(moduleCode.includes('proofreadRules:'), false, '没有把开关写进任何配置 patch');
  assert.equal(/setConfig\([^)]*proofreadRules/.test(moduleCode), false);
  // 面板里有规则容器 + 「开关不保存」小字
  assert.match(indexSrc, /id="proofread-rules"/);
  assert.match(indexSrc, /开关只对本次会话有效/);
});
