const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const shelfNavUi = require('../renderer/shelf-nav-ui');

// v0.9 B-5 第十刀：「返回书架」+「改名」两个相邻小分区（62 行）从 renderer.js 搬到
// renderer/shelf-nav-ui.js。搬出来以后用「假 host + 假 state + 调用顺序日志」逐条钉住
// 返回书架的三条分支（保存 / 不保存 / 取消）、状态清空、显示设置切回、改名成功 / 失败，
// 再用静态闸门保证渲染层不许长回第二份实现。

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const moduleSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'shelf-nav-ui.js'), 'utf8');
// 纯边界闸门只看代码：注释里提 window / state 是在解释契约，不算越界
const moduleCode = moduleSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function el(tag) {
  return { tag, textContent: '', title: '', className: '' };
}

function makeDom(ids) {
  const map = new Map();
  for (const id of ids) map.set(id, el('div'));
  return {
    map,
    $: (id) => map.get(id) || null
  };
}

// ---------- 假 host + 调用顺序日志 ----------
function build(options = {}) {
  const log = [];
  const calls = { askUnsaved: [], saveCurrent: 0, promptText: [], releaseBook: 0, rename: [], toast: [], windowTitle: 0, clearFind: 0, sidebarWidth: [] };
  const state = {
    view: 'edit',
    bookPath: '/books/书甲',
    meta: { title: '书甲', folder: '书甲' },
    bookId: 'id-1',
    bookDisplay: { title: '书甲' },
    chapters: [{ name: '第一章' }, { name: '第二章' }],
    index: 1,
    dirty: Boolean(options.dirty),
    saveError: '上次保存失败',
    baseText: '旧正文',
    find: { total: options.findTotal === undefined ? 0 : options.findTotal },
    config: { editorSidebarWidth: 250 }
  };
  const editorEl = { value: '编辑区里的旧正文' };
  const dom = makeDom(['book-title']);
  const host = {
    $: dom.$,
    state,
    editorEl,
    api: {
      async releaseBook() {
        calls.releaseBook += 1;
        log.push('releaseBook');
        if (options.releaseFails) throw new Error('窗口正在销毁');
      },
      renameBook(folderPath, title) {
        calls.rename.push(folderPath);
        calls.rename.push(title);
        log.push('api.renameBook');
        if (options.renameFails) throw new Error('书目只读');
        return { title, folder: state.meta.folder };
      }
    },
    async askUnsaved(opts) {
      calls.askUnsaved.push(opts);
      log.push('askUnsaved');
      return options.action === undefined ? 'discard' : options.action;
    },
    async saveCurrent() {
      calls.saveCurrent += 1;
      log.push('saveCurrent');
      if (typeof options.saveCurrent === 'function') return options.saveCurrent();
      return { ok: options.saveOk !== false };
    },
    currentChapterLabel() {
      log.push('currentChapterLabel');
      return options.chapterLabel === undefined ? '第2章 第二章' : options.chapterLabel;
    },
    clearFindSession() {
      calls.clearFind += 1;
      log.push('clearFindSession');
    },
    effectiveConfig() {
      log.push('effectiveConfig');
      return options.effective === undefined ? { editorSidebarWidth: 300 } : options.effective;
    },
    applyEditorStyle() { log.push('applyEditorStyle'); },
    syncCaretParagraphFromConfig() { log.push('syncCaret'); },
    applySidebarWidth(width) {
      calls.sidebarWidth.push(width);
      log.push('applySidebarWidth');
    },
    showView(view) { log.push('showView:' + view); },
    async refreshShelf() { log.push('refreshShelf'); },
    async promptText(opts) {
      calls.promptText.push(opts);
      log.push('promptText');
      return options.promptValue === undefined ? '新书名' : options.promptValue;
    },
    async call(fn, ...args) {
      log.push('call');
      if (options.callFails) throw new Error('主进程炸了');
      return fn(...args);
    },
    updateWindowTitle() {
      calls.windowTitle += 1;
      log.push('updateWindowTitle');
    },
    toast(message, kind) {
      calls.toast.push([message, kind]);
      log.push('toast');
    },
    // 五-M9：可选成员（waitForSavingIdle / waitForLoadingIdle / saveForTransition）由用例按需注入；
    // 不注入时走模块里的旧路径，既有用例一字不改。
    ...(options.extraHost || {})
  };
  const ui = shelfNavUi.create(host);
  return { ui, host, state, editorEl, dom, calls, log };
}

test('host 契约：18 个成员缺任何一个都抛 TypeError，null 也算缺', () => {
  assert.deepEqual([...shelfNavUi.REQUIRED_HOST].sort(), [
    '$', 'api', 'applyEditorStyle', 'applySidebarWidth', 'askUnsaved', 'call', 'clearFindSession',
    'currentChapterLabel', 'editorEl', 'effectiveConfig', 'promptText', 'refreshShelf',
    'saveCurrent', 'showView', 'state', 'syncCaretParagraphFromConfig', 'toast', 'updateWindowTitle'
  ]);
  assert.equal(shelfNavUi.REQUIRED_HOST.length, 18);
  const full = build();
  assert.doesNotThrow(() => shelfNavUi.create(full.host));

  for (const key of shelfNavUi.REQUIRED_HOST) {
    const broken = { ...full.host };
    delete broken[key];
    assert.throws(() => shelfNavUi.create(broken), new RegExp('createShelfNavUi 的 host 缺少 ' + key.replace('$', '\\$')), '缺 ' + key + ' 必须抛');
    const nulled = { ...full.host, [key]: null };
    assert.throws(() => shelfNavUi.create(nulled), TypeError, key + ' = null 也必须抛');
  }
  assert.throws(() => shelfNavUi.create(null), new TypeError('createShelfNavUi 需要 host 对象'));
  assert.throws(() => shelfNavUi.create('host'), new TypeError('createShelfNavUi 需要 host 对象'));
});

test('create() 只建表：不碰 DOM、不注册事件、不建定时器，交出 2 个入口', () => {
  const ctx = build();
  assert.deepEqual(ctx.log, [], '装配时一个 host 成员都不调用');
  assert.deepEqual(Object.keys(ctx.ui).sort(), ['backToShelf', 'renameBookFlow']);
  assert.equal(typeof ctx.ui.backToShelf, 'function');
  assert.equal(typeof ctx.ui.renameBookFlow, 'function');
  assert.equal(moduleCode.includes('setTimeout'), false, '模块不建定时器');
  assert.equal(moduleCode.includes('setInterval'), false, '模块不建定时器');
  assert.equal(moduleCode.includes('addEventListener'), false, '模块不注册事件');
});

test('backToShelf：没未保存修改 → 不弹三选一，清空当前书并切回全局显示设置', async () => {
  const ctx = build({ dirty: false });
  await ctx.ui.backToShelf();

  assert.deepEqual(ctx.calls.askUnsaved, [], '干净状态不该问');
  assert.equal(ctx.calls.saveCurrent, 0);
  assert.equal(ctx.calls.releaseBook, 1, '回书架要释放「打开中的书」登记');
  assert.equal(ctx.state.view, 'shelf');
  assert.equal(ctx.state.bookPath, null);
  assert.equal(ctx.state.meta, null);
  assert.equal(ctx.state.bookId, null);
  assert.deepEqual(ctx.state.bookDisplay, {});
  assert.deepEqual(ctx.state.chapters, []);
  assert.equal(ctx.state.index, -1);
  assert.equal(ctx.state.dirty, false);
  assert.equal(ctx.state.saveError, null);
  assert.equal(ctx.state.baseText, '');
  assert.equal(ctx.editorEl.value, '', '编辑区要清空');
  assert.deepEqual(ctx.state.config, { editorSidebarWidth: 300 }, '回书架切回全局显示设置');
  assert.deepEqual(ctx.calls.sidebarWidth, [300], '章节栏宽度取全局 config 的值');
  assert.equal(ctx.calls.clearFind, 0, '没有查找结果就不用结束会话');

  // 顺序：先释放登记 → 清状态 → 结束查找（无）→ 切全局设置 → 三件显示设置 → showView → 刷新书架
  // B1（审计 E6）：释放登记改走统一 call()（失败才真的进 catch），所以日志里多一条 'call' 打头。
  assert.deepEqual(ctx.log, [
    'call', 'releaseBook', 'effectiveConfig', 'applyEditorStyle', 'syncCaret', 'applySidebarWidth', 'showView:shelf',
    'refreshShelf'
  ]);
});

test('backToShelf：未保存 + 取消 → 一个字段都不动、不释放、不刷新', async () => {
  const ctx = build({ dirty: true, action: 'cancel', chapterLabel: '第3章 第三章' });
  const snapshot = JSON.stringify(ctx.state);
  await ctx.ui.backToShelf();

  assert.deepEqual(ctx.calls.askUnsaved, [{ title: '返回书架前保存', message: '「第3章 第三章」有未保存的修改。' }]);
  assert.equal(ctx.calls.saveCurrent, 0);
  assert.equal(ctx.calls.releaseBook, 0);
  assert.equal(JSON.stringify(ctx.state), snapshot, '取消后 state 一字未动');
  assert.equal(ctx.editorEl.value, '编辑区里的旧正文');
  assert.equal(ctx.log.includes('showView:shelf'), false);
  assert.equal(ctx.log.includes('refreshShelf'), false);
});

test('backToShelf：未保存 + 保存成功 → 先 askUnsaved、再 saveCurrent，然后照常回书架', async () => {
  const ctx = build({ dirty: true, action: 'save', saveOk: true });
  await ctx.ui.backToShelf();

  assert.equal(ctx.calls.askUnsaved.length, 1);
  assert.equal(ctx.calls.saveCurrent, 1);
  assert.equal(ctx.calls.releaseBook, 1);
  assert.equal(ctx.state.view, 'shelf');
  // B1（审计 E6）：'call' 是释放登记走统一 call() 的那一跳（见上一条用例）
  assert.deepEqual(ctx.log.slice(0, 5), ['currentChapterLabel', 'askUnsaved', 'saveCurrent', 'call', 'releaseBook']);
  assert.equal(ctx.log[ctx.log.length - 1], 'refreshShelf');
});

test('backToShelf：未保存 + 保存失败 → 停在保存那一步，不回书架', async () => {
  const ctx = build({ dirty: true, action: 'save', saveOk: false });
  await ctx.ui.backToShelf();

  assert.equal(ctx.calls.saveCurrent, 1);
  assert.equal(ctx.calls.releaseBook, 0, '保存失败不能继续');
  assert.equal(ctx.state.view, 'edit');
  assert.equal(ctx.state.bookPath, '/books/书甲');
  assert.equal(ctx.log.includes('showView:shelf'), false);
  assert.equal(ctx.log.includes('refreshShelf'), false);
});

test('backToShelf：未保存 + 不保存丢弃 → 保存一次都不调，直接回书架', async () => {
  const ctx = build({ dirty: true, action: 'discard' });
  await ctx.ui.backToShelf();

  assert.equal(ctx.calls.saveCurrent, 0);
  assert.equal(ctx.calls.releaseBook, 1);
  assert.equal(ctx.state.view, 'shelf');
});

test('backToShelf：releaseBook 抛错也只有静默兜底，回书架照常走完', async () => {
  const ctx = build({ dirty: false, releaseFails: true });
  await assert.doesNotReject(() => ctx.ui.backToShelf());
  assert.equal(ctx.calls.releaseBook, 1);
  assert.equal(ctx.state.view, 'shelf');
  assert.equal(ctx.log[ctx.log.length - 1], 'refreshShelf');
});

test('backToShelf：有查找结果时结束查找会话，没结果不碰', async () => {
  const withFind = build({ findTotal: 3 });
  await withFind.ui.backToShelf();
  assert.equal(withFind.calls.clearFind, 1);
  assert.ok(withFind.log.indexOf('clearFindSession') > withFind.log.indexOf('releaseBook'));

  const noFind = build({ findTotal: 0 });
  await noFind.ui.backToShelf();
  assert.equal(noFind.calls.clearFind, 0);
});

test('backToShelf：章节栏宽度优先取 config.editorSidebarWidth，null / 缺省兜底 250', async () => {
  const custom = build({ effective: { editorSidebarWidth: 412 } });
  await custom.ui.backToShelf();
  assert.deepEqual(custom.calls.sidebarWidth, [412]);

  const nulled = build({ effective: { editorSidebarWidth: null } });
  await nulled.ui.backToShelf();
  assert.deepEqual(nulled.calls.sidebarWidth, [250]);

  const missing = build({ effective: {} });
  await missing.ui.backToShelf();
  assert.deepEqual(missing.calls.sidebarWidth, [250]);
});

test('renameBookFlow：没有打开的书 / 没有 meta 时一个 IPC 都不打', async () => {
  const noPath = build();
  noPath.state.bookPath = null;
  await noPath.ui.renameBookFlow();
  assert.deepEqual(noPath.calls.promptText, []);
  assert.deepEqual(noPath.calls.rename, []);

  const noMeta = build();
  noMeta.state.meta = null;
  await noMeta.ui.renameBookFlow();
  assert.deepEqual(noMeta.calls.promptText, []);
  assert.deepEqual(noMeta.calls.rename, []);
});

test('renameBookFlow：问书名时取消（返回 null）→ 不调主进程、不改标题', async () => {
  const ctx = build({ promptValue: null });
  await ctx.ui.renameBookFlow();

  assert.deepEqual(ctx.calls.promptText, [{
    title: '修改书名',
    message: '只改书目里的书名，文件夹名保持不变（与「不重命名文件」一致）。',
    value: '书甲',
    placeholder: '书名'
  }]);
  assert.deepEqual(ctx.calls.rename, [], '取消后不许调 renameBook');
  assert.deepEqual(ctx.state.meta, { title: '书甲', folder: '书甲' });
  assert.equal(ctx.calls.windowTitle, 0);
  assert.deepEqual(ctx.calls.toast, []);
});

test('renameBookFlow：成功 → 只改书目 title，顶栏 / 窗口标题 / toast 一起更新', async () => {
  const ctx = build({ promptValue: '新书名' });
  await ctx.ui.renameBookFlow();

  assert.deepEqual(ctx.calls.rename, ['/books/书甲', '新书名'], 'call(api.renameBook, bookPath, title)');
  assert.deepEqual(ctx.state.meta, { title: '新书名', folder: '书甲' }, 'meta 换成主进程返回值、folder 不动');
  assert.equal(ctx.dom.map.get('book-title').textContent, '新书名');
  assert.equal(ctx.dom.map.get('book-title').title, '新书名');
  assert.equal(ctx.calls.windowTitle, 1);
  assert.deepEqual(ctx.calls.toast, [['书名已更新', undefined]]);
  assert.deepEqual(ctx.log.slice(0, 2), ['promptText', 'call']);
});

test('renameBookFlow：meta.title 为空时输入框初值是空串（不是 undefined）', async () => {
  const ctx = build({ promptValue: null });
  ctx.state.meta = { title: '', folder: '书甲' };
  await ctx.ui.renameBookFlow();
  assert.equal(ctx.calls.promptText[0].value, '');
  assert.equal(ctx.calls.promptText[0].placeholder, '书名');
});

test('renameBookFlow：主进程报错 → 错误 toast 带原因，状态与标题一律不动', async () => {
  const ctx = build({ promptValue: '新书名', renameFails: true });
  await ctx.ui.renameBookFlow();

  assert.deepEqual(ctx.state.meta, { title: '书甲', folder: '书甲' });
  assert.equal(ctx.calls.windowTitle, 0, '失败不更新窗口标题');
  assert.deepEqual(ctx.calls.toast, [['改名失败：书目只读', 'error']]);
  assert.equal(ctx.dom.map.get('book-title').textContent, '');
});

test('静态闸门：renderer.js 不许长回实现，装配只有一处，18 个 host 成员与 2 个入口按名字接线', () => {
  for (const shape of ['async function backToShelf(', 'async function renameBookFlow(']) {
    assert.equal(rendererSrc.includes(shape), false, 'renderer.js 不许再定义 ' + shape);
  }
  assert.equal(rendererSrc.split('shelfNavUiModule.create(').length - 1, 1, '装配只许一处');
  // host 的 18 个成员逐个点名（三行字面量逐字钉住，少一个名字就红）
  assert.ok(rendererSrc.includes('    $, api, state, editorEl, askUnsaved, saveCurrent, currentChapterLabel, clearFindSession,'), 'host 第 1 行');
  assert.ok(rendererSrc.includes('    effectiveConfig, applyEditorStyle, syncCaretParagraphFromConfig, applySidebarWidth,'), 'host 第 2 行');
  assert.ok(rendererSrc.includes('    showView, refreshShelf, promptText, call, updateWindowTitle, toast'), 'host 第 3 行');
  assert.ok(rendererSrc.includes('const { backToShelf, renameBookFlow } = shelfNavUi;'), '两个入口按原名取');
  // 事件绑定段与测试钩子宿主契约段没搬：两行 click 绑定 + 钩子键仍按原名取
  assert.ok(rendererSrc.includes("$('btn-back').addEventListener('click', backToShelf);"), '返回按钮绑定原样留在事件绑定段');
  assert.ok(rendererSrc.includes("$('btn-rename-book').addEventListener('click', renameBookFlow);"), '改名按钮绑定原样留在事件绑定段');
  assert.match(rendererSrc, /^\s+backToShelf,$/m, '测试钩子宿主契约里 backToShelf 键还在');
});

test('静态闸门：index.html 顺序（shelf-filter-ui → shelf-search-ui → shelf-nav-ui → renderer.js）且只加载一次', () => {
  const rendererAt = indexSrc.indexOf('<script src="renderer.js"></script>');
  const filterAt = indexSrc.indexOf('<script src="shelf-filter-ui.js"></script>');
  const searchAt = indexSrc.indexOf('<script src="shelf-search-ui.js"></script>');
  const navAt = indexSrc.indexOf('<script src="shelf-nav-ui.js"></script>');
  assert.ok(rendererAt > 0 && filterAt > 0 && searchAt > 0 && navAt > 0);
  assert.ok(filterAt < searchAt && searchAt < navAt && navAt < rendererAt, 'shelf-nav-ui.js 必须排在 shelf-search-ui.js 之后、renderer.js 之前');
  assert.equal(indexSrc.split('shelf-nav-ui.js').length - 1, 1, '只加载一次');
  assert.ok(rendererSrc.includes('window.CWShelfNavUi'), '渲染层按 CWShelfNavUi 取模块');
});

test('静态闸门：模块不 require / 不摸 Electron·fs·网络·window，state 只写回书架那 12 个既有字段', () => {
  // A8（WP-32）：唯一允许的 require 是 UMD 的 Node 分支取 core/assert-host.js（浏览器走 window.CWAssertHost）；
  // 运行时代码仍不许 require 任何东西。
  const assertHostBranch = "module.exports = factory(require('../core/assert-host').assertHost);";
  assert.ok(moduleCode.includes(assertHostBranch), 'UMD 的 Node 分支必须从 ./assert-host 取共享 host 校验');
  const runtimeCode = moduleCode.split(assertHostBranch).join('');
  for (const forbidden of ['require(', 'ipcRenderer', 'node:fs', 'child_process', 'localStorage', 'fetch(', 'window.', 'document.']) {
    assert.equal(runtimeCode.includes(forbidden), false, 'shelf-nav-ui.js 不许出现 ' + forbidden);
  }
  const writes = [...moduleCode.matchAll(/\bstate\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)].map((m) => m[1]);
  // WP-03（V101）新增 loadedChapterId：回书架后清空「编辑区属于哪一章」，下次开书由 loadChapterAt 重新登记。
  assert.deepEqual(
    [...new Set(writes)].sort(),
    ['baseText', 'bookDisplay', 'bookId', 'bookPath', 'chapters', 'config', 'dirty', 'index', 'loadedChapterId', 'meta', 'saveError', 'view'],
    '只写回书架原有的 11 个字段 + WP-03 的 loadedChapterId，不许再新增别的 state 字段'
  );
});

test('UMD：浏览器分支挂成 CWShelfNavUi，不顺手造别的全局', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(moduleSrc, context, { filename: 'renderer/shelf-nav-ui.js' });
  assert.equal(typeof win.CWShelfNavUi, 'object');
  assert.equal(typeof win.CWShelfNavUi.create, 'function');
  assert.equal(win.CWShelfNavUi.REQUIRED_HOST.length, 18);
  assert.equal(win.CWShelfNavUi.REQUIRED_HOST.includes('currentChapterLabel'), true);
  assert.equal(win.CWShelfFilterUi, undefined, '单独加载 shelf-nav 不该顺手造出别的全局');
});

// ---------- 五-M9 / 五-H3（第五轮审计 SS-02 / L-F1） ----------
// 缺陷：backToShelf 是切章 / 换书两个入口修掉「不等 saved.idle」后的漏网第三入口——
// 选「不保存丢弃」会被在途写入违背；选「保存」撞 BUSY 静默 return（按钮像坏了）。
// 修法：与 switchChapter 同口径先 waitForSavingIdle / waitForLoadingIdle，再询问；
// 保存走统一原语（保存回执后复核 dirty）。

test('五-M9：回书架先等保存在途落定，再按剩余脏字走统一原语；原语取消就不回书架', async () => {
  const order = [];
  let ctx;
  ctx = build({
    dirty: true,
    extraHost: {
      waitForSavingIdle: async () => {
        order.push('waitForSavingIdle');
        ctx.state.saving = false; // 在途保存落定后现场已干净（下面不再询问）
      },
      saveForTransition: async (options) => {
        order.push('saveForTransition');
        ctx.calls.guardOptions = options;
        return { ok: false, canceled: true };
      }
    }
  });
  ctx.state.saving = true;
  await ctx.ui.backToShelf();
  assert.deepEqual(order, ['waitForSavingIdle', 'saveForTransition'], '先等保存在途，再走统一原语');
  assert.deepEqual(ctx.calls.guardOptions, { title: '返回书架前保存', message: '「第2章 第二章」有未保存的修改。' });
  assert.equal(ctx.calls.askUnsaved.length, 0, '有统一原语就不再自己 ask');
  assert.equal(ctx.calls.saveCurrent, 0, '保存动作全交给原语');
  assert.equal(ctx.calls.releaseBook, 0, '原语返回取消 → 不回书架');
  assert.equal(ctx.state.view, 'edit', '取消后仍停在写作页');
});

test('五-M9：没有可选原语时（旧宿主）保存在途仍先等落定；BUSY 要给 toast，不再静默返回', async () => {
  // 等落定后再询问：询问时 dirty 已被在途保存抹平 → 一个框都不弹，直接回书架。
  const waited = build({
    dirty: true,
    extraHost: {
      waitForSavingIdle: async () => {
        waited.state.dirty = false; // 在途保存已把这份草稿写盘
        waited.state.saving = false;
      }
    }
  });
  waited.state.saving = true;
  await waited.ui.backToShelf();
  assert.equal(waited.calls.askUnsaved.length, 0, '等落定后已干净 → 不用再问');
  assert.equal(waited.calls.releaseBook, 1, '照常回书架');

  // 另一笔保存刚好开始 → saveCurrent 返回 BUSY：给状态提示，不静默、也不回书架。
  const busy = build({ dirty: true, action: 'save', saveCurrent: () => ({ ok: false, code: 'BUSY', message: '正在保存中，请稍候再试' }) });
  await busy.ui.backToShelf();
  assert.deepEqual(busy.calls.toast, [['正在保存中，请稍候再试', 'warn']], 'BUSY 要出声');
  assert.equal(busy.calls.releaseBook, 0, '没保存成功不回书架');
});
