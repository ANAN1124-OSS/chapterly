'use strict';
// T-08（三次审查 · 中）：六个正文改写通道成功后必须标脏搜索索引。
//
// 为什么是行为断言而不是源码 grep：markDirty 的作用是「让下一次 ensure 立刻重建位图」；只查源码里
// 有没有这行字，等价重构会假红，也拦不住「把调用放进错误分支 / 成功前就标脏」。这里装配真实的
// ipc/book-data.js 与 ipc/book.js，逐个调用处理函数：
//   · 成功 → markDirty(bookPath) 恰好一次；
//   · 存储层失败 → 不标脏、错误如实抛出（不许把失败当成功放过）；
//   · 标脏自身失败 → 已完成的写入仍按成功返回，只留 INDEX_DIRTY_FAILED 痕（与保存链同口径）。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const bookDataIpc = require('../ipc/book-data');
const bookIpc = require('../ipc/book');

const BOOK = 'D:\\书库\\测试书';

function makeBookDataHost(storageOverrides = {}) {
  const channels = new Map();
  const dirty = [];
  const logs = [];
  const storage = {
    replaceInBook: async () => ({ ok: true }),
    restoreReplaceBackup: async () => ({ ok: true }),
    restoreHistoryFile: async () => ({ ok: true }),
    restoreHistoryGroup: async () => ({ ok: true }),
    formatBook: async () => ({ ok: true }),
    ...storageOverrides
  };
  const host = {
    handleBook: (channel, fn, options) => channels.set(channel, { fn, options }),
    storage,
    ipcLimits: {
      sanitizeSearchOptions: (value) => value,
      sanitizeReplaceOptions: (value) => value
    },
    fs: {},
    path,
    shell: {},
    errorText: {
      describeForUi: (err) => ({ message: String((err && err.message) || err) }),
      cleanText: (text) => String(text == null ? '' : text),
      redactPaths: (text) => String(text == null ? '' : text)
    },
    sendToFlow: () => {},
    getSearchIndexStore: () => ({ markDirty: (bookPath) => dirty.push(bookPath) }),
    logError: (kind, err, meta) => logs.push({ kind, code: meta && meta.code })
  };
  bookDataIpc.register(host);
  return { channels, dirty, logs };
}

// 五个 book-data 通道的调用形状（顺序与 ipc/book-data.js 里的注册顺序一致）。
const BOOK_DATA_CASES = [
  ['book:replace', [BOOK, { query: '甲', replacement: '乙' }]],
  ['book:restore-replace-backup', [BOOK, 'dir:替换备份-2026-10-31-210000']],
  ['book:restore-history-file', [BOOK, 'dir:整理备份-2026-10-31-210000', '001-第1章.txt']],
  ['book:restore-history-dir', [BOOK, 'dir:还原前-2026-10-31-210000']],
  ['book:format', [BOOK, {}]]
];

for (const [channel, args] of BOOK_DATA_CASES) {
  test(`T-08 ${channel}：成功后标脏搜索索引恰好一次（含存储层原始返回值透传）`, async () => {
    const { channels, dirty } = makeBookDataHost();
    const entry = channels.get(channel);
    assert.ok(entry, `ipc/book-data.js 没有注册 ${channel}`);
    const result = await entry.fn(...args);
    assert.equal(result && result.ok, true, '处理函数必须原样返回 storage 的结果');
    assert.deepEqual(dirty, [BOOK], `${channel} 成功后必须 markDirty(bookPath)`);
  });
}

test('T-08：book:replace 存储层失败时不标脏、错误如实抛出（不许吞成成功）', async () => {
  const { channels, dirty } = makeBookDataHost({
    replaceInBook: async () => {
      throw Object.assign(new Error('磁盘忙'), { code: 'EBUSY' });
    }
  });
  await assert.rejects(() => channels.get('book:replace').fn(BOOK, { query: '甲' }), /磁盘忙/);
  assert.deepEqual(dirty, [], '失败的替换不该标脏（否则会把没写成的书当新内容索引）');
});

test('T-08：标脏自身失败不把已完成的替换报成失败，只留 INDEX_DIRTY_FAILED 痕', async () => {
  const channels = new Map();
  const logs = [];
  bookDataIpc.register({
    handleBook: (channel, fn, options) => channels.set(channel, { fn, options }),
    storage: { replaceInBook: async () => ({ ok: true, chaptersChanged: 1 }) },
    ipcLimits: { sanitizeSearchOptions: (v) => v, sanitizeReplaceOptions: (v) => v },
    fs: {},
    path,
    shell: {},
    errorText: { describeForUi: (e) => ({ message: String(e) }), cleanText: (t) => String(t), redactPaths: (t) => String(t) },
    sendToFlow: () => {},
    getSearchIndexStore: () => {
      throw new Error('index store 未就绪');
    },
    logError: (kind, err, meta) => logs.push({ kind, code: meta && meta.code })
  });
  const result = await channels.get('book:replace').fn(BOOK, { query: '甲' });
  assert.equal(result.ok, true, '正文已经写好，标脏失败不能把这次替换报成失败');
  assert.deepEqual(logs, [{ kind: 'book-data', code: 'INDEX_DIRTY_FAILED' }]);
});

function makeBookCrudHost(storageOverrides = {}) {
  const channels = new Map();
  const dirty = [];
  const logs = [];
  const host = {
    handle: (name, fn) => channels.set(name, fn),
    handleBook: (name, fn) => channels.set(name, fn),
    storage: { restoreDeletedChapterFromTrash: async () => ({ ok: true, chapterId: 'c1' }), ...storageOverrides },
    repair: {},
    importer: {},
    openBooksLib: {},
    ipcLimits: { sanitizeRestorePayload: (payload) => payload },
    ipcPaths: {},
    ipcRestoreToken: { errorFor: () => new Error('凭证无效') },
    restoreTokens: { take: () => ({ ok: true, record: {} }), release: () => {} },
    errorText: {
      describeForUi: (err) => ({ message: String((err && err.message) || err) }),
      cleanText: (text) => String(text == null ? '' : text),
      redactPaths: (text) => String(text == null ? '' : text)
    },
    pathUtils: { pathKey: (p) => String(p).toLowerCase() },
    fs: {},
    path,
    shell: {},
    getConfig: async () => ({ booksRoot: 'D:\\书库' }),
    getConfigStore: () => ({}),
    flowSession: () => null,
    sessionById: () => null,
    focusSession: () => {},
    flushLastOpenBeforeRead: async () => {},
    lastOpenWrites: new Map(),
    bookKeyOf: (p) => String(p).toLowerCase(),
    rememberRecentBook: () => {},
    notifyShelfChanged: () => {},
    sendToFlow: () => {},
    logError: (kind, err, meta) => logs.push({ kind, code: meta && meta.code }),
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    automation: { enabled: false },
    isE2E: true,
    getSearchIndexStore: () => ({ markDirty: (bookPath) => dirty.push(bookPath) })
  };
  bookIpc.register(host);
  return { channels, dirty, logs };
}

test('T-08 chapter:restore-deleted：把章节放回书里后标脏搜索索引', async () => {
  const { channels, dirty } = makeBookCrudHost();
  const result = await channels.get('chapter:restore-deleted')(BOOK, { trashName: 'x.txt', chapter: { id: 'c1' } });
  assert.equal(result.ok, true);
  assert.deepEqual(dirty, [BOOK], '撤销删除成功后必须 markDirty(bookPath)');
});

test('T-08 chapter:restore-deleted：storage 还原失败时不标脏、错误如实抛出', async () => {
  const { channels, dirty } = makeBookCrudHost({
    restoreDeletedChapterFromTrash: async () => {
      throw new Error('目标章已存在');
    }
  });
  await assert.rejects(
    () => channels.get('chapter:restore-deleted')(BOOK, { trashName: 'x.txt', chapter: { id: 'c1' } }),
    /目标章已存在/
  );
  assert.deepEqual(dirty, []);
});
