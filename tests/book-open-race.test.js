// RACE-01：book:open 全程持只读租约。
//
// 打开流程要走「落盘上次章节 → 读书目 → 登记打开」三段；登记完成之前，删除闸门（main.js 的
// handleBook 包装 → storage.assertBookNotBusy(action='delete')）只看得见「没被任何窗口打开」。
// 同窗口「回书架 → 删同书」撞进这个窗口时，书目录被搬走，后面的 chapter:load 按文件名就可能
// 读到同名新建的那本。修复是 book:open 一开始就 beginReadLease(bookPath)、finally 释放。
//
// 这里复刻 main.js 包装里最小的一层删除闸门（mutation 非空先 assertBookNotBusy），再用一个
// 可控延迟把 book:open 停在 openBook 之前，验证并发的 book:delete 真的被租约挡住。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const storage = require('../core/storage');
const openBooksLib = require('../core/open-books');
const pathUtils = require('../core/path-utils');
const bookIpc = require('../ipc/book');
const bookDataIpc = require('../ipc/book-data');

const tmpCleanup = require('./tmp-cleanup');

const mkTmp = (prefix = 'cw-book-open-race-') => tmpCleanup.mkTmp(prefix);

function makeHost(root, options = {}) {
  const channels = new Map();
  const windowId = options.windowId || 'win-a';
  // main.js handleBook 包装的最小复刻：mutation 非空先过跨窗口 / 只读租约闸门，再执行频道体。
  const wrap = (fn, opts) => async (bookPath, ...args) => {
    const mutation = opts && opts.mutation;
    if (mutation) storage.assertBookNotBusy(bookPath, windowId, mutation);
    return fn(bookPath, ...args);
  };
  const host = {
    handle: (name, fn) => { channels.set(name, fn); },
    handleBook: (name, fn, opts) => { channels.set(name, wrap(fn, opts)); },
    storage: options.storage || storage,
    repair: {},
    importer: {},
    openBooksLib,
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
    shell: { trashItem: async () => {} },
    getConfig: options.getConfig || (async () => ({ booksRoot: root })),
    getConfigStore: () => ({ resetBookDisplay: async () => true }),
    flowSession: () => ({ id: windowId }),
    sessionById: () => null,
    focusSession: () => {},
    flushLastOpenBeforeRead: async () => {},
    lastOpenWrites: new Map(),
    bookKeyOf: (p) => pathUtils.pathKey(p),
    rememberRecentBook: async () => {},
    notifyShelfChanged: () => {},
    sendToFlow: () => {},
    logError: () => {},
    getSearchIndexStore: () => ({ markDirty: () => {} }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    automation: { enabled: false },
    isE2E: true
  };
  const registered = bookIpc.register(host) || channels;
  registered.logs = [];
  return registered;
}

test('RACE-01：book:open 在途持只读租约，并发的 book:delete 被 READ_LEASE_BUSY 拒', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '正在打开的书');
  let releaseOpen = () => {};
  const gate = new Promise((resolve) => { releaseOpen = resolve; });
  let markStarted = () => {};
  const started = new Promise((resolve) => { markStarted = resolve; });

  // 只在 openBook 前卡住（之前是落盘上次章节），让它在书目录被删除前已经进入打开流程。
  const delayedStorage = Object.create(storage);
  delayedStorage.openBook = async (...args) => {
    markStarted();
    await gate;
    return storage.openBook(...args);
  };
  const channels = makeHost(root, { storage: delayedStorage });

  try {
    const opening = channels.get('book:open')(bookPath);
    await started;
    assert.equal(storage.isBookReadLeased(bookPath), true, '打开流程在途时必须持租约');

    await assert.rejects(
      () => channels.get('book:delete')(bookPath),
      (err) => err && err.code === 'READ_LEASE_BUSY',
      '打开在途时删除必须被租约拒绝，不能把正读着的书搬走'
    );
    assert.equal(await storage.exists(bookPath), true, '被拒绝的删除一个字节都不许动');
    assert.equal(await storage.exists(path.join(root, '_trash')), false, '删除被拒时不该建 _trash');

    releaseOpen();
    const opened = await opening;
    assert.equal(opened.meta.title, '正在打开的书');
    assert.ok(Array.isArray(opened.meta.chapters));
    assert.equal(storage.isBookReadLeased(bookPath), false, 'open 成功后租约释放');
  } finally {
    releaseOpen();
    storage.releaseOpenBookPath(bookPath);
  }
});

test('RACE-01：租约按路径记——删除后同名重建，在途打开仍挡住同一个路径上的删除', async () => {
  const root = await mkTmp();
  const first = await storage.createBook(root, '同名书');
  // 模拟「这本书刚被删掉、同名书立刻重建」：旧目录搬进 _trash，同一路径上又出现一本新书。
  const trashDir = path.join(root, '_trash');
  await fs.mkdir(trashDir, { recursive: true });
  await fs.rename(first.path, path.join(trashDir, 'old-同名书'));
  const second = await storage.createBook(root, '同名书');
  assert.equal(pathUtils.pathKey(second.path), pathUtils.pathKey(first.path), '重建后仍是同一个路径');

  const release = storage.beginReadLease(first.path);
  try {
    assert.throws(
      () => storage.assertBookNotBusy(first.path, 'win-b', 'delete'),
      (err) => err && err.code === 'READ_LEASE_BUSY',
      '同名重建不能绕过在途打开的租约'
    );
  } finally {
    release();
  }
  assert.doesNotThrow(() => storage.assertBookNotBusy(first.path, 'win-b', 'delete'), '释放后恢复可删');
});

// LEASE-01（2026-11-24 复核补审）：book:search / book:format-preview 读取期间也登记只读租约
// （与导出 / 校对 / 整本复制同口径）——同窗口「回书架 → 删同书」会被 READ_LEASE_BUSY 拒绝，
// 不会读到一半把书目录搬走（loadTextOrSkip 会把缺章静默跳过，结果失真）。
test('LEASE-01：book:search / book:format-preview 读取期间持租约，完成 / 失败都释放', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '读取中的书');
  const channels = new Map();
  const gates = [];
  const fakeStorage = Object.create(storage);
  const gated = (impl) => async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    gates.push({ gate, release });
    await gate;
    return impl();
  };
  fakeStorage.searchBook = gated(async () => ({ results: [] }));
  fakeStorage.previewFormatBook = gated(async () => ({ chaptersChanged: 0 }));
  bookDataIpc.register({
    handleBook: (channel, fn) => channels.set(channel, fn),
    storage: fakeStorage,
    ipcLimits: { sanitizeSearchOptions: (value) => value || {} },
    fs,
    path,
    shell: { openPath: async () => '' },
    errorText: {
      describeForUi: (err) => ({ message: String((err && err.message) || err) }),
      cleanText: (text) => String(text == null ? '' : text),
      redactPaths: (text) => String(text == null ? '' : text)
    },
    sendToFlow: () => {},
    getSearchIndexStore: () => ({ markDirty: () => {} }),
    logError: () => {}
  });
  for (const channel of ['book:search', 'book:format-preview']) {
    const pending = channels.get(channel)(bookPath, {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(storage.isBookReadLeased(bookPath), true, `${channel} 读取期间必须持租约`);
    assert.throws(
      () => storage.assertBookNotBusy(bookPath, 'win-b', 'delete'),
      (err) => err && err.code === 'READ_LEASE_BUSY',
      `${channel} 在途时删除必须被拒`
    );
    gates.at(-1).release();
    await pending;
    assert.equal(storage.isBookReadLeased(bookPath), false, `${channel} 完成后释放租约`);
  }
  // 抛错也要释放：不能因为一次搜索失败把这本书永久锁成「不能删」
  fakeStorage.searchBook = gated(async () => {
    throw Object.assign(new Error('search failed'), { code: 'SEARCH_FAILED' });
  });
  const failing = channels.get('book:search')(bookPath, {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(storage.isBookReadLeased(bookPath), true);
  gates.at(-1).release();
  await assert.rejects(failing, (err) => err.code === 'SEARCH_FAILED');
  assert.equal(storage.isBookReadLeased(bookPath), false, '搜索失败后租约也要释放');
});

// IPC-02（第 5 轮）：book:delete 的跨窗口闸门在 handleBook 包装层（取书锁之前）就跑完了；
// book:open 在频道体内才取租约 / 完成登记，也不拿书锁。中间这段间隙里另一窗口把这本书打开，
// 旧实现照样把书目录搬走 —— 锁内没有二次 assertBookNotBusy。修法两条：
//   ① book:delete 在书锁内用同一个窗口身份再查一次（别的窗口开着 / 正在打开都要拒）；
//   ② book:open 的「查归属 → 读书目 → 登记」整段进书锁：先拿到锁的登记完，后来者看见登记；
//      先拿到锁的是删除，打开排在后面、书已不在 → 如实报 NO_BOOK，绝不会打开一本刚搬走的书。
test('IPC-02：删除过包装层之后另一窗口打开这本书，锁内二次闸门必须拒绝', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '交错删除的书');
  let releaseDelete = () => {};
  const deleteGate = new Promise((resolve) => { releaseDelete = resolve; });
  let signalEntered = () => {};
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  // win-a 的 getConfig 是频道体的第一处 await：此刻包装层的删除闸门已经放行、书锁还没取。
  const channelsA = makeHost(root, {
    windowId: 'win-a',
    getConfig: async () => {
      signalEntered();
      await deleteGate;
      return { booksRoot: root };
    }
  });
  const channelsB = makeHost(root, { windowId: 'win-b' });
  try {
    const deleting = channelsA.get('book:delete')(bookPath);
    await entered;
    assert.equal(storage.findOpenBookWindow(bookPath), null, '删除过闸门那一刻还没有窗口登记这本书');

    // 另一窗口在这个间隙里把书完整打开（取租约 → 读书目 → 登记 → 释放租约）
    const opened = await channelsB.get('book:open')(bookPath);
    assert.equal(opened.meta.title, '交错删除的书');
    assert.equal(storage.findOpenBookWindow(bookPath), 'win-b', '打开完成后这本书登记在 win-b');

    releaseDelete();
    await assert.rejects(
      deleting,
      (err) => err && err.code === 'CROSS_WINDOW_BUSY',
      '包装层闸门之后才被打开的书，锁内二次闸门必须拒绝删除'
    );
    assert.equal(await storage.exists(bookPath), true, '别的窗口开着的书一个字节都不许动');
    assert.equal(await storage.exists(path.join(root, '_trash')), false, '被拒绝的删除不该建 _trash');
  } finally {
    releaseDelete();
    storage.releaseOpenBookPath(bookPath);
  }
});

test('IPC-02：删除持锁在途时另一窗口的 book:open 必须排队，不能打开一本正被搬走的书', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '删除中的书');
  let releaseTrash = () => {};
  const trashGate = new Promise((resolve) => { releaseTrash = resolve; });
  let signalAtTrash = () => {};
  const atTrash = new Promise((resolve) => { signalAtTrash = resolve; });
  // 删除已经拿到书锁、停在搬目录（E2E 分支的 trashBook）之前。
  const deleteStorage = Object.create(storage);
  deleteStorage.trashBook = async (...args) => {
    signalAtTrash();
    await trashGate;
    return storage.trashBook(...args);
  };
  const channelsA = makeHost(root, { windowId: 'win-a', storage: deleteStorage });
  let signalOpenBook = () => {};
  const openBookCalled = new Promise((resolve) => { signalOpenBook = resolve; });
  const openStorage = Object.create(storage);
  openStorage.openBook = async (...args) => {
    signalOpenBook();
    return storage.openBook(...args);
  };
  const channelsB = makeHost(root, { windowId: 'win-b', storage: openStorage });
  try {
    const deleting = channelsA.get('book:delete')(bookPath);
    await atTrash;
    const opening = channelsB.get('book:open')(bookPath);
    assert.equal(storage.isBookReadLeased(bookPath), true, '打开一开始就同步取租约（锁外，立即生效）');
    // 删除持锁期间打开不许进 openBook：修前打开不排队，几百毫秒内就跑完并登记。
    const raced = await Promise.race([
      openBookCalled.then(() => 'open-started'),
      new Promise((resolve) => setTimeout(() => resolve('delete-lock-held'), 300))
    ]);
    assert.equal(raced, 'delete-lock-held', '删除持锁在途时，打开必须排在书锁后面');
    assert.equal(storage.findOpenBookWindow(bookPath), null, '排队中的打开不许登记');

    releaseTrash();
    const deleted = await deleting;
    assert.equal(deleted.method, 'move', '没有别的窗口开着时删除照常成功');
    await assert.rejects(
      opening,
      (err) => err && err.code === 'NO_BOOK',
      '排在删除后面的打开要如实报「书已经不在了」，不能打开一本刚搬走的书'
    );
    assert.equal(await storage.exists(bookPath), false);
    assert.equal(storage.findOpenBookWindow(bookPath), null, '失败的打开不许留下登记');
  } finally {
    releaseTrash();
    storage.releaseOpenBookPath(bookPath);
  }
});
