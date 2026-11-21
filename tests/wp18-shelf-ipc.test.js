'use strict';
// WP18 第 2–4 轮的删书 / 书架卡片 / preload / 接线锚点（TEST-D-01：按子域从 tests/wp18-low-batch.test.js 拆出）。
// 本文件只收「主进程删书入锁、书架卡片增量、preload 传输层、接线审计」：
//   R9   台账 #1 / E-N7：book:delete 生产分支入书锁（等待 / EPERM 兜底 / E2E 重入不死锁）
//   R10-R12  B2 书架增量：readBookCard 数据面 / shelf-ui 单卡增量 / books:card 接线
//   R13  C4 / CTXT-A-01：preload 传输层异常只回固定文案（不再手抄脱敏副本）
//   R14-R15  台账 #3：app:force-close 活监听 / E2E-only api 登记
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const storage = require('../core/storage');
const bookIpc = require('../ipc/book');
const pathUtils = require('../core/path-utils');
const tmpCleanup = require('./tmp-cleanup');

async function mkTmp(prefix = 'cw-wp18-') {
  return tmpCleanup.track(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readSource(rel) {
  return require('node:fs').readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
}

function sliceFrom(source, startMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `找不到锚点：${startMarker}`);
  const rest = source.slice(start + startMarker.length);
  const next = rest.search(/\n {2}(?:async function |function |handleBook\(|handle\()/);
  return next === -1 ? rest : rest.slice(0, next);
}
// ---------- R9：台账 #1 / E-N7 删书入锁 ----------

function makeDeleteHost(root, { isE2E = false, trashItem } = {}) {
  const channels = new Map();
  const host = {
    handle: (name, fn) => { channels.set(name, fn); },
    handleBook: (name, fn) => { channels.set(name, fn); },
    storage,
    repair: {},
    importer: {},
    openBooksLib: {},
    ipcLimits: {},
    ipcPaths: {},
    ipcRestoreToken: {},
    restoreTokens: {},
    errorText: {
      describeForUi: (err) => ({ message: String((err && err.message) || err) }),
      cleanText: (text) => String(text == null ? '' : text),
      redactPaths: (text) => String(text == null ? '' : text)
    },
    pathUtils,
    fs,
    path,
    shell: { trashItem: trashItem || (async () => {}) },
    getConfig: async () => ({ booksRoot: root }),
    // 五-L1（CI-2）：删书成功后按 meta.id 清显示覆盖（真实实现由 main.js 注入 configStore）
    getConfigStore: () => ({ resetBookDisplay: async () => true }),
    flowSession: () => null,
    sessionById: () => null,
    focusSession: () => {},
    flushLastOpenBeforeRead: async () => {},
    lastOpenWrites: new Map(),
    bookKeyOf: (p) => pathUtils.pathKey(p),
    rememberRecentBook: () => {},
    notifyShelfChanged: () => {},
    sendToFlow: () => {},
    logError: () => {},
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    automation: { enabled: false },
    isE2E
  };
  bookIpc.register(host);
  return channels;
}

test('R9 台账 #1：book:delete 生产分支入书锁（等待 / EPERM 兜底 / E2E 重入不死锁）', async () => {
  const base = await mkTmp('cw-wp18-delete-lock-');
  const root = path.join(base, '书架');
  await fs.mkdir(root, { recursive: true });

  // 1) 书锁被长任务持有时：删除必须等锁，不允许把目录搬走
  const first = await storage.createBook(root, '并发删除书');
  let releaseLock;
  let acquiredResolve;
  const acquired = new Promise((resolve) => { acquiredResolve = resolve; });
  const held = storage.withBookLock(first.path, async () => {
    acquiredResolve();
    await new Promise((resolve) => { releaseLock = resolve; });
  });
  await acquired;
  const recycleDir = path.join(base, '回收站');
  await fs.mkdir(recycleDir, { recursive: true });
  const channels = makeDeleteHost(root, {
    trashItem: async (target) => {
      // 模拟真实的回收站：把目录搬走（可恢复）
      await fs.rename(target, path.join(recycleDir, path.basename(target)));
    }
  });
  const deleteBook = channels.get('book:delete');
  const pending = deleteBook(first.path).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
  await sleep(80);
  assert.equal(
    await storage.exists(path.join(first.path, '书目.json')),
    true,
    '书锁没释放之前，book:delete 必须等待（旧实现会立刻把目录搬走）'
  );
  releaseLock();
  await held;
  const outcome = await pending;
  assert.equal(outcome.ok, true, `删除失败：${outcome.ok ? '' : outcome.error.message}`);
  assert.equal(outcome.value.method, 'recycle');
  assert.equal(await storage.exists(first.path), false, '锁释放后照常完成删除');

  // 2) 回收站不可用（EPERM）→ _trash 兜底，仍在锁内完成；锁自己不能卡死
  const second = await storage.createBook(root, '兜底删除书');
  const fallbackChannels = makeDeleteHost(root, {
    trashItem: async () => {
      const err = new Error('EPERM: operation not permitted, rename');
      err.code = 'EPERM';
      throw err;
    }
  });
  const fallback = await fallbackChannels.get('book:delete')(second.path);
  assert.equal(fallback.method, 'move');
  assert.match(fallback.note, /回收站不可用/);
  assert.ok(fallback.trashPath.startsWith(path.join(root, storage.TRASH_DIR)));
  assert.equal(await storage.exists(second.path), false);
  await Promise.race([
    storage.withBookLock(second.path, async () => {}),
    sleep(3000).then(() => { throw new Error('删除失败后书锁没有释放（3s 超时）'); })
  ]);

  // 3) E2E 分支走 storage.trashBook（内部自带书锁）→ 外层书锁重入，不许死锁
  const third = await storage.createBook(root, 'E2E删除书');
  const e2eChannels = makeDeleteHost(root, { isE2E: true });
  const e2e = await Promise.race([
    e2eChannels.get('book:delete')(third.path),
    sleep(3000).then(() => { throw new Error('E2E 分支重入书锁死锁（3s 超时）'); })
  ]);
  assert.equal(e2e.method, 'move');
  assert.equal(await storage.exists(third.path), false);

  // 静态：删除动作包在 storage.withBookLock 里（检查 / 搬目录同一临界区）
  const deleteBody = sliceFrom(readSource('ipc/book.js'), "  handleBook('book:delete', async (bookPath) => {");
  assert.match(deleteBody, /storage\.withBookLock\(target, async \(\) =>/, 'book:delete 必须入书锁');
  assert.ok(
    deleteBody.indexOf('storage.withBookLock(target') < deleteBody.indexOf('shell.trashItem(target)'),
    '锁要包住回收站分支'
  );
});

// ---------- R10 / R11 / R12：B2 书架增量广播 ----------

test('R10 B2 数据面：readBookCard 与 listBooks 同书卡片逐字段一致（NO_BOOK / 坏书目）', async () => {
  const root = await mkTmp('cw-wp18-card-');
  const first = await storage.createBook(root, '甲书');
  await storage.saveChapterText(first.path, first.meta.chapters[0].file, '第一章正文'.repeat(200));
  await storage.createChapterWithText(first.path, { insertIndex: 1, name: '开端', text: '第二段正文' });
  const second = await storage.createBook(root, '乙书');
  await fs.writeFile(path.join(second.path, '001-夜雨-冲突副本.txt'), '冲突副本', 'utf8');
  // 不含书目的普通目录：整表跳过、单读必须报 NO_BOOK（不伪造一张空卡）
  const plain = path.join(root, '普通文件夹');
  await fs.mkdir(plain, { recursive: true });

  const listed = await storage.listBooks(root);
  assert.equal(listed.length, 2, `普通文件夹不该进书架：${JSON.stringify(listed.map((book) => book.folder))}`);
  for (const book of listed) {
    const card = await storage.readBookCard(book.path);
    assert.deepEqual(card, book, `单读卡片必须与整表同书条目逐字段一致（${book.folder}）`);
  }
  await assert.rejects(() => storage.readBookCard(plain), (err) => err && err.code === 'NO_BOOK');
  assert.equal(
    listed.find((book) => book.folder === path.basename(second.path)).conflicts.length,
    1,
    '冲突副本提示要跟着单读一起回来'
  );

  // 坏书目：整表给 corrupt 卡（书架照旧能显示并点修复），单读抛错（渲染层据此整表兜底）
  const broken = path.join(root, '坏书');
  await fs.mkdir(broken, { recursive: true });
  await fs.writeFile(path.join(broken, storage.BOOK_FILE), '{ 这不是 json', 'utf8');
  const withBroken = await storage.listBooks(root);
  const corrupt = withBroken.find((book) => book.path === broken);
  assert.ok(corrupt, '坏书目仍要在整表里占一张 corrupt 卡');
  assert.equal(corrupt.status, 'corrupt');
  assert.deepEqual(corrupt.conflicts, []);
  await assert.rejects(() => storage.readBookCard(broken), '坏书目单读必须 reject，不许把 corrupt 卡伪装成正常书');
});

const shelfUiModule = require('../renderer/shelf-ui');

function makeShelfChangedHost(options = {}) {
  const calls = { read: [], rendered: 0, refreshed: 0, marked: 0, stats: 0, patched: 0 };
  const state = options.state || {
    view: 'shelf',
    books: [],
    importing: false,
    formatBookRunning: false,
    chapters: [],
    index: 0,
    dirty: false,
    recentBook: null
  };
  const cards = options.cards || {};
  const api = {
    readBookCard: async (bookPath) => {
      calls.read.push(bookPath);
      if (options.onRead) return options.onRead(bookPath);
      return cards[bookPath] || null;
    }
  };
  const shelfUi = shelfUiModule.create({
    $: () => null,
    state,
    chapterTitle: () => '',
    formatRelativeTime: () => '',
    openBookByPath: async () => ({ ok: true }),
    askUnsaved: async () => 'cancel',
    saveCurrent: async () => ({ ok: true }),
    loadChapterAt: async () => {},
    api,
    call: async (fn, ...args) => fn(...args),
    renderShelf: () => { calls.rendered += 1; },
    refreshShelf: async () => { calls.refreshed += 1; },
    refreshStats: async () => { calls.stats += 1; },
    markCommandsDirty: () => { calls.marked += 1; },
    // RSHE-C-01：宿主可选提供单卡 DOM 增量；patchResult 控制返回 true / false。
    ...(typeof options.patchResult === 'boolean'
      ? { patchShelfCard: () => { calls.patched += 1; return options.patchResult; } }
      : {})
  });
  return { shelfUi, state, calls };
}

test('RSHE-C-01：宿主给了单卡 DOM 增量就不再整表重绘；增量返回 false 时整表兜底', async () => {
  const bookA = { path: 'C:\\书架\\甲书', title: '甲书', lastModified: 100, chapterCount: 1 };
  const bookB = { path: 'C:\\书架\\乙书', title: '乙书', lastModified: 300, chapterCount: 2 };
  const updatedA = { path: 'C:\\书架\\甲书', title: '甲书（改名）', lastModified: 120, chapterCount: 3 };
  const state = {
    view: 'shelf',
    books: [bookA, bookB],
    importing: false,
    formatBookRunning: false,
    chapters: [],
    index: 0,
    dirty: false,
    recentBook: null
  };
  const viaPatch = makeShelfChangedHost({ state, cards: { [bookA.path]: updatedA }, patchResult: true });
  const result = await viaPatch.shelfUi.handleShelfChanged({ reason: 'chapter:save', bookPath: bookA.path });
  assert.equal(result.mode, 'card');
  assert.equal(viaPatch.calls.patched, 1, '单卡增量入口要走一次');
  assert.equal(viaPatch.calls.rendered, 0, '增量成功时不许整表重绘（书多时白建 N 张卡）');
  assert.equal(viaPatch.calls.marked, 1);
  assert.equal(viaPatch.calls.stats, 1);

  const fallback = makeShelfChangedHost({ state: { ...state, books: [bookA, bookB] }, cards: { [bookA.path]: updatedA }, patchResult: false });
  const fell = await fallback.shelfUi.handleShelfChanged({ reason: 'chapter:save', bookPath: bookA.path });
  assert.equal(fell.mode, 'card');
  assert.equal(fallback.calls.patched, 1);
  assert.equal(fallback.calls.rendered, 1, '增量说「顺序 / 筛选集变了」时必须整表兜底');
});

test('R11 B2 渲染层：单书增量 / 删除删卡 / 无路径整表 / 读失败整表兜底 / 非书架跳过', async () => {
  assert.throws(
    () => shelfUiModule.create({}),
    /createShelfUi 的 host 缺少/,
    'REQUIRED_HOST 校验照旧（可选成员不能把它弄丢）'
  );
  const bookA = { path: 'C:\\书架\\甲书', title: '甲书', lastModified: 100, chapterCount: 1 };
  const bookB = { path: 'C:\\书架\\乙书', title: '乙书', lastModified: 300, chapterCount: 2 };
  const updatedA = { path: 'C:\\书架\\甲书', title: '甲书（改名）', lastModified: 500, chapterCount: 3 };

  // 1) 单书 mutation：只读这一张卡，不整表刷新；替换 + 按 lastModified 重排 + 重绘
  const one = makeShelfChangedHost({
    state: {
      view: 'shelf',
      books: [bookB, bookA],
      importing: false,
      formatBookRunning: false,
      chapters: [],
      index: 0,
      dirty: false,
      recentBook: null
    },
    cards: { [bookA.path]: updatedA }
  });
  const cardResult = await one.shelfUi.handleShelfChanged({ reason: 'chapter:save', bookPath: bookA.path });
  assert.equal(cardResult.mode, 'card');
  assert.deepEqual(one.calls.read, [bookA.path], '增量只许读变更的那本书');
  assert.equal(one.calls.refreshed, 0, '单书保存不许整表 books:list');
  assert.equal(one.calls.rendered, 1);
  assert.equal(one.calls.marked, 1, '书名可能变了，命令面板条目要重建');
  assert.equal(one.calls.stats, 1, '字数变了，书架头统计跟着刷新（不重扫全书架）');
  assert.deepEqual(one.state.books.map((book) => book.title), ['甲书（改名）', '乙书'], '按 lastModified 倒序重排');

  // 2) book:delete：直接从书架删卡，一个字节都不读
  const removed = await one.shelfUi.handleShelfChanged({ reason: 'book:delete', bookPath: bookA.path });
  assert.equal(removed.mode, 'remove');
  assert.equal(one.calls.read.length, 1, '删除不读盘');
  assert.deepEqual(one.state.books.map((book) => book.title), ['乙书']);

  // 3) 无 bookPath（多本导入等结构性变更）：照旧整表刷新
  const full = await one.shelfUi.handleShelfChanged({ reason: 'book:import' });
  assert.equal(full.mode, 'full');
  assert.equal(one.calls.refreshed, 1);

  // 4) 读卡失败（坏书 / 路径失效）：退回整表，绝不把卡片弄丢
  const brokenHost = makeShelfChangedHost({
    state: { view: 'shelf', books: [bookA, bookB], importing: false, formatBookRunning: false, chapters: [], index: 0 },
    onRead: async () => { throw new Error('EISDIR'); }
  });
  const fallback = await brokenHost.shelfUi.handleShelfChanged({ reason: 'book:rename', bookPath: bookA.path });
  assert.equal(fallback.mode, 'full');
  assert.equal(brokenHost.calls.refreshed, 1);
  assert.deepEqual(brokenHost.state.books.map((book) => book.title), ['甲书', '乙书'], '兜底时不动现有卡片');

  // 5) 选卡返回的不是对象（旧协议 / 坏回包）→ 同样整表
  const badShapeHost = makeShelfChangedHost({
    state: { view: 'shelf', books: [bookA], importing: false, formatBookRunning: false, chapters: [], index: 0 },
    onRead: async () => 'not-a-card'
  });
  assert.equal((await badShapeHost.shelfUi.handleShelfChanged({ reason: 'book:rename', bookPath: bookA.path })).mode, 'full');
  assert.equal(badShapeHost.calls.refreshed, 1);

  // 6) 写作页 / 导入中 / 整本整理中：一个调用都不发（与旧接线同一守卫）
  for (const view of ['write', 'shelf-importing', 'shelf-formatting']) {
    const guard = makeShelfChangedHost({
      state: {
        view: view === 'write' ? 'write' : 'shelf',
        books: [bookA],
        importing: view === 'shelf-importing',
        formatBookRunning: view === 'shelf-formatting',
        chapters: [],
        index: 0
      }
    });
    const skipped = await guard.shelfUi.handleShelfChanged({ reason: 'chapter:save', bookPath: bookA.path });
    assert.equal(skipped.mode, 'skipped', `${view} 必须跳过`);
    assert.equal(guard.calls.read.length + guard.calls.refreshed, 0, `${view} 不许读盘 / 刷新`);
  }
});

test('R12 B2 接线：books:card IPC + preload.readBookCard + 广播载荷带 bookPath', async () => {
  const root = await mkTmp('cw-wp18-card-ipc-');
  const created = await storage.createBook(root, 'IPC 卡片书');
  const channels = makeDeleteHost(root);
  const readCard = channels.get('books:card');
  assert.equal(typeof readCard, 'function', 'ipc/book 必须注册 books:card');
  const card = await readCard(created.path);
  assert.equal(card.path, created.path);
  assert.equal(card.folder, path.basename(created.path));
  assert.equal(card.title, 'IPC 卡片书');

  const preloadSrc = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'preload.js'), 'utf8');
  assert.match(preloadSrc, /readBookCard: \(bookPath\) => invoke\('books:card', bookPath\)/, 'preload 必须暴露 readBookCard');
  const bookSrc = readSource('ipc/book.js');
  assert.match(bookSrc, /handleBook\('books:card'[\s\S]*?READ_ONLY\)/, 'books:card 是只读频道（不许广播 / 不许拿书锁）');
  assert.match(bookSrc, /notifyShelfChanged\(flowSession\(\), 'book:create', created\.path\)/, '新建书广播要带新书路径');
  assert.match(bookSrc, /notifyShelfChanged\(session, 'book:import'\)/, '多本导入是结构性变更：不带单书路径（整表刷新）');

  const mainSrc = readSource('main.js');
  assert.match(mainSrc, /function notifyShelfChanged\(session, reason = '', bookPath = null\)/, '广播函数必须收 bookPath');
  assert.match(mainSrc, /broadcast\('shelf:changed', \{ reason, bookPath:/, 'shelf:changed 载荷必须带 bookPath');
  assert.match(mainSrc, /notifyShelfChanged\(session, channel, target\)/, 'handleBook 的广播要传这次变更的书路径');
  assert.match(readSource('renderer/renderer.js'), /shelfUi\.handleShelfChanged\(payload\)/, '渲染层事件要交给增量处理器');
});

// ---------- R13：C4 preload 传输层异常脱敏 ----------

function extractFunctionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `找不到函数 ${name}`);
  let depth = 0;
  let began = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') {
      depth += 1;
      began = true;
    } else if (ch === '}') {
      depth -= 1;
      if (began && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`函数 ${name} 的大括号不配对`);
}

test('R13 C4 / CTXT-A-01：preload 传输层异常只回固定文案，不再手抄第二份脱敏实现', () => {
  const preloadSrc = readSource('preload.js');
  // 全仓只剩 core/error-text 一份脱敏口径：preload 里不许再有路径解析 / 遮罩实现
  // （旧副本与 core 已实际漂移：URL 被误遮、引号 POSIX 漏遮、MAX_CHARS 400 对 300）。
  for (const pattern of [
    /sanitizeTransportMessage/,
    /\btailOf\b/,
    /\breadPathEnd\b/,
    /\bPATH_STOP_RE\b/,
    /MAX_CHARS/
  ]) {
    assert.equal(pattern.test(preloadSrc), false, `preload 不许再带脱敏副本：${pattern}`);
  }
  // 固定文案 + 不引用原始异常：路径 / 控制字符 / 超长内容从机制上不可能泄漏。
  assert.match(preloadSrc, /const TRANSPORT_ERROR_MESSAGE = '主进程通道不可用（IPC_ERROR）';/);
  const invokeBody = extractFunctionSource(preloadSrc, 'invoke');
  assert.match(invokeBody, /code: 'IPC_ERROR'/);
  assert.match(invokeBody, /message: TRANSPORT_ERROR_MESSAGE/);
  assert.equal(/err\.message|String\(err\)/.test(invokeBody), false, '传输层兜底文案不许引用原始异常');
});

// ---------- R14 / R15：台账 #3 preload 死监听 / 暴露未用 api ----------

test('R14 台账 #3：app:force-close 是活监听（close-guard 常量 = main 字面量；真实树无死监听）', () => {
  const closeGuard = require('../core/close-guard');
  assert.equal(closeGuard.FORCE_CLOSE_CHANNEL, 'app:force-close');
  const mainSrc = readSource('main.js');
  assert.match(mainSrc, /webContents\.send\('app:force-close'\)/, 'main 发送必须用字面量（接线清单才看得见）');
  assert.equal(/webContents\.send\(plan\.channel\)/.test(mainSrc), false, '不许再用动态 plan.channel 发送');
  assert.match(
    mainSrc,
    /closeGuard\.FORCE_CLOSE_CHANNEL !== 'app:force-close'/,
    '字面量旁边要有「与 close-guard 同源」的显式断言，避免以后两处漂移'
  );

  const wiring = require('../scripts/wiring-check.js');
  const result = wiring.auditWiring(path.join(__dirname, '..'));
  assert.deepEqual(result.violations, [], '真实树接线必须零违规：' + JSON.stringify(result.violations));
  assert.deepEqual(result.facts.deadListeners, [], 'app:force-close 已有发送方，真实树不该再有死监听');
  const checkSrc = readSource('scripts/wiring-check.js');
  assert.match(checkSrc, /const KNOWN_DEAD_LISTENERS = \[\];/, '死监听白名单要清空（不许继续容留历史条目）');
});

test('R15 台账 #3：E2E-only api 登记（真实树 0 提示；名单只登记三条）', () => {
  const wiring = require('../scripts/wiring-check.js');
  const result = wiring.auditWiring(path.join(__dirname, '..'));
  assert.deepEqual(result.warnings, [], '真实树不该再有「暴露未用」提示：' + JSON.stringify(result.warnings));
  const checkSrc = readSource('scripts/wiring-check.js');
  const listMatch = /const E2E_ONLY_APIS = \[([^\]]*)\]/.exec(checkSrc);
  assert.ok(listMatch, 'wiring-check 必须登记 E2E_ONLY_APIS');
  const keys = listMatch[1]
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  assert.deepEqual(keys.sort(), ['findInText', 'setClipboardWatchTestText', 'testPickFont']);
  assert.match(checkSrc, /61-ipc-limits\.js/, '注释要点名 findInText 的 E2E 使用位置');
  assert.match(checkSrc, /26-display-options\.js/, '注释要点名 testPickFont 的 E2E 使用位置');
  assert.match(checkSrc, /72-capture\.js/, '注释要点名 setClipboardWatchTestText 的 E2E 使用位置');
});

