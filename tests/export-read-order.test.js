'use strict';
// 审计 #7（O2 / P4）：导出读正文必须挪到保存对话框确认之后。
// WP16（R-N4）把这条**核心修复的静态源码闸门改成行为断言**：不再读 `ipc/export.js` 切字符串，
// 而是用真实 `ipc/export.js` + 真实 `core/*` + 假 host 跑 IPC，从事件顺序上钉住：
//   1. 取消保存 → 三格式 0 次读正文、0 次写盘、目标文件不存在（用户改主意不白读整本）；
//   2. 确认保存 → 事件顺序严格 `dialog` 先于任何 `read:*`，且 3 章各读一次（不预读、不重复读）；
//   3. TXT 流式（40 章）→ 第一次写盘发生在最后一次读正文之前（真流式，不是整本读完再写）；
//   4. `book:copy` 不走保存对话框，直接读正文并写剪贴板；
//   5. 前置阶段不读正文 → `loadChapterText` 一调用就抛 EPERM 的 host 上，取消导出仍正常返回。
//
// 为什么改行为：旧版（5 条测试 / 124 行）全部是 readFileSync + 字符串切片，等价重构（改名 / 搬家 / 重排）
// 会假红，而「先读正文再弹框」的行为回归只要关键字还在就放行。WP16 负控：临时在
// `exportStructured` 的 `showSaveDialog` 之前插一次 `storage.loadChapterText`，本文件必须红（见作业卡 §9.1）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const storage = require('../core/storage');
const exporter = require('../core/exporter');
const chaptersLib = require('../core/chapters');
const epubLib = require('../core/epub');
const docxLib = require('../core/docx');
const s2tLib = require('../core/s2t');
const ipcLimits = require('../core/ipc-limits');
const atomic = require('../core/atomic');
const exportIpc = require('../ipc/export');
const pathUtils = require('../core/path-utils');
const tmpCleanup = require('./tmp-cleanup');

// TB-02：临时目录统一经 tests/tmp-cleanup.js（不再本地复制 mkdtemp + track）。
const makeTmpDir = (prefix = 'cw-export-order-') => tmpCleanup.mkTmp(prefix);

// 真实 ipc/export.js 的 host：只替换「可观察的边界」（对话框、时钟、剪贴板、原子写），
// 存储 / 格式 / 范围解析全部走真实 core（与 WP13 R7/R8 同一套装配口径）。
function makeHost({ targetPath = '', canceled = false, readThrows = false } = {}) {
  const channels = new Map();
  const events = [];
  const calls = { dialogs: 0, reads: [], writes: 0 };
  const clipboard = [];
  const host = {
    handle: (name, fn) => channels.set(name, fn),
    handleBook: (name, fn) => channels.set(name, fn),
    storage: {
      // N-16：落点拒绝用 storage.StorageError（与生产同一类），最小桩也要给。
      StorageError: storage.StorageError,
      readBookMeta: (bookPath) => storage.readBookMeta(bookPath),
      loadChapterText: async (bookPath, file) => {
        if (readThrows) {
          const err = new Error('EPERM: operation not permitted, open');
          err.code = 'EPERM';
          throw err;
        }
        calls.reads.push(file);
        events.push(`read:${file}`);
        return storage.loadChapterText(bookPath, file);
      }
    },
    exporter,
    chaptersLib,
    epubLib,
    docxLib,
    s2tLib,
    ipcLimits,
    mapLimit: async (items, _limit, fn) => Promise.all(items.map(fn)),
    CHAPTER_READ_CONCURRENCY: 4,
    CHAPTER_BATCH_SIZE: 16,
    path,
    pathUtils,
    app: { getPath: () => path.join(os.tmpdir(), 'cw-documents') },
    fsSync: fs,
    getConfig: async () => ({ exportConversion: '', lastExportDir: '' }),
    getClipboard: () => ({
      writeText: async (text) => {
        clipboard.push(text);
        events.push('clipboard');
      }
    }),
    showSaveDialog: async () => {
      calls.dialogs += 1;
      events.push('dialog');
      if (canceled) return { canceled: true, filePath: undefined };
      return { canceled: false, filePath: targetPath };
    },
    rememberExportDir: async () => {},
    atomicWriteFile: atomic.atomicWriteFile,
    atomicWriteFileStream: async (filePath, produce) =>
      atomic.atomicWriteFileStream(filePath, async (write) =>
        produce(async (chunk) => {
          calls.writes += 1;
          events.push('write');
          return write(chunk);
        })
      )
  };
  exportIpc.register(host);
  return { channels, calls, events, clipboard };
}

async function makeBook(root, chapterNames) {
  const created = await storage.createBook(root, '导出时序书');
  const bookPath = created.path;
  const meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '第一章正文。\n第二段。');
  for (let i = 1; i < chapterNames.length; i += 1) {
    await storage.createChapterWithText(bookPath, {
      insertIndex: i,
      name: chapterNames[i],
      text: `第${i + 1}章正文（${chapterNames[i]}）。\n第二段。`
    });
  }
  return bookPath;
}

const FORMATS = [
  ['txt', 'book:export', 'txt'],
  ['epub', 'book:export-epub', 'epub'],
  ['docx', 'book:export-docx', 'docx']
];

test('R7-1 取消保存：三格式 0 次读正文 / 0 次写盘 / 目标文件不存在（审计 #7 核心）', async () => {
  const dir = await makeTmpDir('cw-read-order-cancel-');
  const root = path.join(dir, '书库');
  await fsp.mkdir(root, { recursive: true });
  const bookPath = await makeBook(root, ['开端', '转折', '尾声']);
  for (const [format, channel, ext] of FORMATS) {
    const target = path.join(dir, `取消-${format}.${ext}`);
    const { channels, calls } = makeHost({ targetPath: target, canceled: true });
    const result = await channels.get(channel)(bookPath, null, null);
    assert.deepEqual(result, { canceled: true }, `${channel}：取消必须原样返回 { canceled: true }`);
    assert.equal(calls.dialogs, 1, `${channel}：只弹一次保存对话框`);
    assert.equal(calls.reads.length, 0, `${channel}：取消后不许读正文（否则就白读整本）`);
    assert.equal(calls.writes, 0, `${channel}：取消后不许写盘`);
    assert.equal(fs.existsSync(target), false, `${channel}：取消后目标文件不该被创建`);
  }
});

test('R7-2 确认保存：事件顺序严格 dialog → read:*，三格式各读 3 章一次（不预读、不重复读）', async () => {
  const dir = await makeTmpDir('cw-read-order-confirm-');
  const root = path.join(dir, '书库');
  await fsp.mkdir(root, { recursive: true });
  const bookPath = await makeBook(root, ['开端', '转折', '尾声']);
  for (const [, channel, ext] of FORMATS) {
    const target = path.join(dir, `导出 目录`, `共享 书.${ext}`);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const { channels, calls, events } = makeHost({ targetPath: target });
    const result = await channels.get(channel)(bookPath, null, null);
    assert.equal(result.canceled, false, `${channel}：确认后应正常导出`);
    assert.equal(calls.dialogs, 1, `${channel}：弹一次保存对话框`);
    assert.equal(events[0], 'dialog', `${channel}：第一个可观察事件必须是保存对话框（正文还没读）`);
    const firstReadAt = events.findIndex((event) => event.startsWith('read:'));
    assert.notEqual(firstReadAt, -1, `${channel}：确认后必须逐章读正文`);
    assert.ok(firstReadAt > 0, `${channel}：正文读取必须发生在对话框确认之后（#7）`);
    assert.equal(calls.reads.length, 3, `${channel}：3 章各读一次，不许预读 / 重复读`);
    assert.ok(calls.writes > 0, `${channel}：确认后必须写盘`);
    assert.ok(result.chars > 0, `${channel}：chars 要如实回传`);
    assert.equal(fs.existsSync(target), true, `${channel}：目标文件应写出`);
  }
});

test('R7-3 TXT 40 章真流式：第一次写盘早于最后一次读正文（不是整本读完再写）', async () => {
  const dir = await makeTmpDir('cw-read-order-stream-');
  const root = path.join(dir, '书库');
  await fsp.mkdir(root, { recursive: true });
  const names = Array.from({ length: 40 }, (_, i) => `第${i + 1}章`);
  const bookPath = await makeBook(root, names);
  const target = path.join(dir, '流式书.txt');
  const { channels, calls, events } = makeHost({ targetPath: target });
  const result = await channels.get('book:export')(bookPath, null, null);
  assert.equal(result.canceled, false);
  assert.equal(calls.reads.length, 40, '40 章各读一次');
  const lastReadAt = events.reduce((last, event, index) => (event.startsWith('read:') ? index : last), -1);
  const firstWriteAt = events.indexOf('write');
  assert.ok(firstWriteAt >= 0, '必须真的写盘');
  assert.ok(
    firstWriteAt < lastReadAt,
    `第一次写（事件 ${firstWriteAt}）必须早于最后一次读（事件 ${lastReadAt}）：整本读完再写就不是流式`
  );
  const stat = await fsp.stat(target);
  assert.ok(stat.size > 0, '流式产物不能是空文件');
});

test('R7-4 book:copy 不弹保存对话框：直接读正文并写剪贴板（#7 只约束导出三入口）', async () => {
  const dir = await makeTmpDir('cw-read-order-copy-');
  const root = path.join(dir, '书库');
  await fsp.mkdir(root, { recursive: true });
  const bookPath = await makeBook(root, ['开端', '转折', '尾声']);
  const { channels, calls, events, clipboard } = makeHost({ canceled: true });
  const result = await channels.get('book:copy')(bookPath, null, null);
  assert.equal(calls.dialogs, 0, 'book:copy 本来就不走保存对话框，不该借道弹框');
  assert.equal(calls.reads.length, 3, '复制整本要读 3 章正文');
  assert.equal(clipboard.length, 1, '复制结果要写进剪贴板');
  assert.equal(result.chapterCount, 3);
  assert.ok(result.chars > 0);
  assert.ok(clipboard[0].includes('第一章正文'), '剪贴板内容要包含正文');
  assert.equal(events[0].startsWith('read:'), true, '复制路径先读正文，不经过 dialog');
  assert.ok(!events.includes('dialog'));
});

test('R7-5 前置阶段不读正文：loadChapterText 一调用就抛 EPERM，取消导出仍正常返回', async () => {
  const dir = await makeTmpDir('cw-read-order-prepare-');
  const root = path.join(dir, '书库');
  await fsp.mkdir(root, { recursive: true });
  const bookPath = await makeBook(root, ['开端', '转折', '尾声']);
  for (const [format, channel, ext] of FORMATS) {
    const { channels, calls } = makeHost({
      targetPath: path.join(dir, `准备-${format}.${ext}`),
      canceled: true,
      readThrows: true
    });
    // 若 prepareExport 在这个阶段读正文，EPERM 会直接把 handler 打挂；能正常返回就证明没读。
    const result = await channels.get(channel)(bookPath, null, null);
    assert.deepEqual(result, { canceled: true }, `${channel}：前置阶段读正文会把取消路径打挂`);
    assert.equal(calls.reads.length, 0);
  }
});