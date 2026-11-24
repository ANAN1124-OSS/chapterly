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
    getConfig: async () => ({ booksRoot: root }),
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
