// 审计修复 #4（S1、E20）的 IPC 入口回归：book:delete 在回收站 / 兜底删除两条分支之前，
// 必须先确认「目标是书架根下的一本真书」—— `_trash`（全部删书备份）/ `_碎片`（灵感箱）
// 也是书架根的直接子目录，只判「父目录 == 书架根」时会被当成书整个丢掉。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const storage = require('../core/storage');
const pathUtils = require('../core/path-utils');
const bookIpc = require('../ipc/book');

const tmpCleanup = require('./tmp-cleanup');

// TB-02：临时目录统一经 tests/tmp-cleanup.js 的 mkTmp（mkdtemp + 登记回收）。
const mkTmp = (prefix = 'cw-book-delete-') => tmpCleanup.mkTmp(prefix);

// 装配真实的 ipc/book.js，只把 Electron / 窗口 / 配置这些宿主替换成最小桩：
// handle / handleBook 收到的频道函数按名字存进 Map，测试直接调 book:delete。
function makeHost(root, options = {}) {
  const channels = new Map();
  const logs = [];
  const defaultStore = { resetBookDisplay: async () => true };
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
    // 五-L1（CI-2）：删书成功后按 meta.id 清掉这本书的显示覆盖（configStore 由 main.js 注入）
    getConfigStore: () => options.configStore || defaultStore,
    flowSession: () => null,
    sessionById: () => null,
    focusSession: () => {},
    flushLastOpenBeforeRead: async () => {},
    lastOpenWrites: new Map(),
    bookKeyOf: (p) => pathUtils.pathKey(p),
    rememberRecentBook: () => {},
    notifyShelfChanged: () => {},
    sendToFlow: () => {},
    logError: (kind, err, meta) => { logs.push([kind, err && err.message, meta && meta.code, meta && meta.level]); },
    // T-08：chapter:restore-deleted 成功后标脏搜索索引
    getSearchIndexStore: () => ({ markDirty: () => {} }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    automation: { enabled: false },
    isE2E: true
  };
  const registered = bookIpc.register(host) || channels;
  // 既有调用点按 Map 用（channels.get(channel)）；另挂 logs 给新用例看留痕，不改变返回形状
  registered.logs = logs;
  return registered;
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
// CI-2（五-L1）：每本书的显示覆盖（bookDisplay[meta.id]）过去只有「渲染层主动重置显示设置」一个
// 删除入口 —— 删书后该 id 永久留在 config.json，条目随「曾经调过显示设置的书数」单调增长，
// 每次写配置（窗口位置防抖 / lastBook 自动写）都整份重写。删书成功时按书目 id 一并清掉。
test('五-L1（CI-2）：删书成功后按书目 id 清掉这本书的显示覆盖', async () => {
  const root = await mkTmp();
  const resets = [];
  const channels = makeHost(root, {
    configStore: {
      resetBookDisplay: async (id) => { resets.push(id); return true; }
    }
  });
  const created = await storage.createBook(root, '调过字体的书');
  const result = await channels.get('book:delete')(created.path);
  assert.equal(result.method, 'move');
  assert.deepEqual(resets, [created.meta.id], '删掉的是哪本书，就清哪个 id 的显示覆盖');
});

// E2（一轮·低）：删书成功后这本书的查找书签也要一并清掉（书签全局上限 200 条，已删的书不许
// 继续占配额）。假 store 两个清理入口都提供，钉住「用哪个 id」与「不抢删除结果」。
test('E2：删书成功后按书目 id 清掉这本书的查找书签（与显示覆盖同一份 id）', async () => {
  const root = await mkTmp();
  const cleared = [];
  const channels = makeHost(root, {
    configStore: {
      resetBookDisplay: async () => true,
      resetFindBookmarksForBook: async (id) => {
        cleared.push(id);
        return 3;
      }
    }
  });
  const created = await storage.createBook(root, '带书签的书');
  const result = await channels.get('book:delete')(created.path);
  assert.equal(result.method, 'move');
  assert.deepEqual(cleared, [created.meta.id], '按书目 meta.id 清，与 bookDisplay 同一份 id');

  // 清理失败只留 warn，删除结果不变
  const failingRoot = await mkTmp();
  const failing = makeHost(failingRoot, {
    configStore: {
      resetBookDisplay: async () => true,
      resetFindBookmarksForBook: async () => {
        throw new Error('EACCES: 配置只读');
      }
    }
  });
  const failingBook = await storage.createBook(failingRoot, '书签清不掉的书');
  const failingResult = await failing.get('book:delete')(failingBook.path);
  assert.equal(failingResult.method, 'move', '书签没清掉也不许把删除报成失败');
  assert.deepEqual(
    failing.logs.map((item) => item[2]),
    ['BOOK_BOOKMARKS_RESET_FAILED'],
    '清不掉要留一条可诊断的 warn'
  );
  assert.equal(failing.logs[0][3], 'warn');
});

test('五-L1（CI-2）：清理失败 / 书目已坏都不影响删书本身（收尾不许盖住删除结果）', async () => {
  const root = await mkTmp();
  const channels = makeHost(root, {
    configStore: {
      resetBookDisplay: async () => { throw new Error('EACCES: 配置只读'); }
    }
  });
  const created = await storage.createBook(root, '配置只读时的书');
  const result = await channels.get('book:delete')(created.path);
  assert.equal(result.method, 'move', '显示覆盖没清掉也不许把删除报成失败');
  assert.deepEqual(
    channels.logs.map((item) => item[2]),
    ['BOOK_DISPLAY_RESET_FAILED'],
    '清不掉要留一条可诊断的 warn 日志'
  );
  assert.equal(channels.logs[0][3], 'warn');

  // 书目已经坏了：读不出可信 id 就跳过清理，删除语义不变（坏书目本来就是允许删的）
  const brokenRoot = await mkTmp();
  const brokenChannels = makeHost(brokenRoot, {
    configStore: { resetBookDisplay: async () => { throw new Error('不该被调用'); } }
  });
  const brokenPath = path.join(brokenRoot, '坏书目的书');
  await fs.mkdir(brokenPath, { recursive: true });
  await fs.writeFile(path.join(brokenPath, storage.BOOK_FILE), '{ 坏掉了', 'utf8');
  const brokenResult = await brokenChannels.get('book:delete')(brokenPath);
  assert.equal(brokenResult.method, 'move');
});
