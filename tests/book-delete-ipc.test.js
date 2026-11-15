// 审计修复 #4（S1、E20）的 IPC 入口回归：book:delete 在回收站 / 兜底删除两条分支之前，
// 必须先确认「目标是书架根下的一本真书」—— `_trash`（全部删书备份）/ `_碎片`（灵感箱）
// 也是书架根的直接子目录，只判「父目录 == 书架根」时会被当成书整个丢掉。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const storage = require('../core/storage');
const pathUtils = require('../core/path-utils');
const bookIpc = require('../ipc/book');

const tmpCleanup = require('./tmp-cleanup');

async function mkTmp() {
  return tmpCleanup.track(await fs.mkdtemp(path.join(os.tmpdir(), 'cw-book-delete-')));
}

// 装配真实的 ipc/book.js，只把 Electron / 窗口 / 配置这些宿主替换成最小桩：
// handle / handleBook 收到的频道函数按名字存进 Map，测试直接调 book:delete。
function makeHost(root) {
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
    shell: { trashItem: async () => {} },
    getConfig: async () => ({ booksRoot: root }),
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
    isE2E: true
  };
  bookIpc.register(host);
  return channels;
}

test('book:delete：_trash / _碎片 / 无书目的文件夹不许当书删，真书仍走兜底删除（S1）', async () => {
  const root = await mkTmp();
  const channels = makeHost(root);
  const deleteBook = channels.get('book:delete');
  assert.equal(typeof deleteBook, 'function', 'ipc/book 必须注册 book:delete');

  const { path: bookPath } = await storage.createBook(root, '可删的书');
  await fs.mkdir(path.join(root, '_trash'), { recursive: true });
  await fs.mkdir(path.join(root, '_碎片'), { recursive: true });
  await fs.mkdir(path.join(root, '普通文件夹'), { recursive: true });

  // 上游 handleBook 已经做过「书架直接子目录」校验；这里测的是频道内的「是不是书」再校验
  await assert.rejects(() => deleteBook(path.join(root, '_trash')), (err) => err.code === 'BAD_PATH');
  await assert.rejects(() => deleteBook(path.join(root, '_碎片')), (err) => err.code === 'BAD_PATH');
  await assert.rejects(() => deleteBook(path.join(root, '普通文件夹')), (err) => err.code === 'NOT_A_BOOK');
  await assert.rejects(() => deleteBook(path.join(root, '不存在')), (err) => err.code === 'NOT_FOUND');

  // 被拒的目标一个都没动
  assert.equal(await storage.exists(path.join(root, '_trash')), true);
  assert.equal(await storage.exists(path.join(root, '_碎片')), true);
  assert.equal(await storage.exists(path.join(root, '普通文件夹')), true);

  // 真书：E2E 分支走 trashBook，返回 move + 目录名 + _trash 目标路径
  const result = await deleteBook(bookPath);
  assert.equal(result.method, 'move');
  assert.equal(result.folder, path.basename(bookPath));
  assert.equal(await storage.exists(bookPath), false);
  assert.ok(result.trashPath.startsWith(path.join(root, '_trash')));
});