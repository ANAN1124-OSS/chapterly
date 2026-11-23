// 审计修复 #6（V302）的 IPC 入口回归：chapter:rescue 是「保存被 BOOK_MISSING / CHAPTER_MISSING
// 阻断」时的救稿出口。书 / 章文件可能已经在应用外被删 / 移走 —— 这条通道必须完全不碰书库，
// 只把渲染层从编辑区取来的正文另存成用户选的 txt，或写进系统剪贴板。
//
// 装配真实的 ipc/export.js，只把 Electron / 窗口 / 配置这些宿主换成最小桩（不用启动 Electron）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const exportIpc = require('../ipc/export');
const pathUtils = require('../core/path-utils');
const chaptersLib = require('../core/chapters');
const ipcLimits = require('../core/ipc-limits');
const exporter = require('../core/exporter');
const atomic = require('../core/atomic');
const tmpCleanup = require('./tmp-cleanup');

// TB-02：临时目录统一经 tests/tmp-cleanup.js 的 mkTmp（mkdtemp + 登记回收）。
const mkTmp = (prefix = 'cw-chapter-rescue-') => tmpCleanup.mkTmp(prefix);

function makeHost(options = {}) {
  const channels = new Map();
  const calls = { dialogs: [], clipboard: [], exportDirs: [], storageReads: 0 };
  const host = {
    handle: (name, fn) => { channels.set(name, fn); },
    handleBook: (name, fn) => { channels.set(name, fn); },
    // 书库一律拒绝：救稿通道不该读写书库（书 / 章可能已经不存在了，这正是它被需要的原因）
    storage: new Proxy({}, {
      get(_target, key) {
        // N-16：落点闸门用 storage.StorageError 报软错误 —— 这是错误类，不是书库读写。
        if (key === 'StorageError') return require('../core/storage').StorageError;
        return () => {
          calls.storageReads += 1;
          throw new Error('chapter:rescue 不该碰 storage');
        };
      }
    }),
    exporter,
    chaptersLib,
    epubLib: {},
    docxLib: {},
    s2tLib: {},
    ipcLimits,
    mapLimit: async (items, _limit, fn) => Promise.all(items.map(fn)),
    CHAPTER_READ_CONCURRENCY: 1,
    CHAPTER_BATCH_SIZE: 1,
    path,
    pathUtils,
    app: { getPath: () => path.join(os.tmpdir(), 'cw-documents') },
    fs,
    fsSync: require('node:fs'),
    getConfig: async () => ({ lastExportDir: '', booksRoot: options.booksRoot || '' }),
    getClipboard: () => ({
      writeText: async (text) => { calls.clipboard.push(text); }
    }),
    showSaveDialog: async (dialogOptions) => {
      calls.dialogs.push(dialogOptions);
      if (options.canceled) return { canceled: true, filePath: undefined };
      return { canceled: false, filePath: options.filePath };
    },
    rememberExportDir: async (dir) => { calls.exportDirs.push(dir); },
    atomicWriteFile: atomic.atomicWriteFile,
    atomicWriteFileStream: atomic.atomicWriteFileStream
  };
  exportIpc.register(host);
  return { channels, calls };
}

test('chapter:rescue：注册在导出域、走 handle（不 require 书路径）', () => {
  const { channels } = makeHost();
  assert.equal(typeof channels.get('chapter:rescue'), 'function', 'ipc/export 必须注册 chapter:rescue');
  // 导出域原有的 6 个频道一个都没少
  for (const channel of ['book:export', 'book:export-plan', 'book:export-epub', 'book:export-docx', 'book:copy', 'chapter:copy-platform']) {
    assert.equal(typeof channels.get(channel), 'function', channel);
  }
});

test('chapter:rescue（save）：另存对话框确认之后才写盘；txt 与章节文件同格式（UTF-8 无 BOM + CRLF）', async () => {
  const dir = await mkTmp();
  const target = path.join(dir, '救稿-第3章.txt');
  const { channels, calls } = makeHost({ filePath: target });
  const body = '第一段。\n第二段：还没落盘的 2000 字。';
  const result = await channels.get('chapter:rescue')(body, 'save', '第3章：夜雨');

  // 对话框：标题 / 建议文件名（章号 + 章名，主进程再走 safeName）/ 只认 txt
  assert.equal(calls.dialogs.length, 1);
  assert.equal(calls.dialogs[0].title, '另存这一章为 TXT');
  assert.equal(path.basename(calls.dialogs[0].defaultPath), `${chaptersLib.safeName('第3章：夜雨')}.txt`);
  assert.deepEqual(calls.dialogs[0].filters, [{ name: '文本文件', extensions: ['txt'] }]);

  // 落盘内容：CRLF、没有 BOM（章节文件同款），字数按去空白口径
  const bytes = await fs.readFile(target);
  assert.equal(bytes[0], 0xE7, '不许写 BOM（首字节是「第」的 UTF-8 首字节）');
  assert.equal(bytes.toString('utf8'), '第一段。\r\n第二段：还没落盘的 2000 字。');
  assert.deepEqual(result, {
    canceled: false,
    filePath: target,
    chars: chaptersLib.countChars(body)
  });
  // 记住这次落点（下次另存 / 导出默认还开在这里）
  assert.deepEqual(calls.exportDirs, [path.dirname(target)]);
  assert.equal(calls.storageReads, 0, '救稿通道一个书库读写都不该有');
});

// N-16（二次审查）：救稿本来就是「章节文件可能已经不在」时才用，更容易顺手存回书库；
// 落点在 booksRoot 下时必须在写盘前拒绝（软错误 + 提示换目录），不碰任何文件。
test('N-16：救稿落点落在书库内 → 软错误拒绝，不写盘、不记导出目录', async () => {
  const dir = await mkTmp();
  const booksRoot = path.join(dir, '书库');
  const target = path.join(booksRoot, '某书', '001-第1章.txt');
  const { channels, calls } = makeHost({ filePath: target, booksRoot });
  await assert.rejects(
    () => channels.get('chapter:rescue')('还没落盘的正文', 'save', '第1章'),
    (err) => err && err.code === 'EXPORT_TARGET_IN_LIBRARY' && /书库/.test(err.message)
  );
  assert.deepEqual(calls.exportDirs, [], '拒绝后不许记导出目录');
  await assert.rejects(() => fs.stat(target), /ENOENT/, '拒绝时一个字节都不写');
});

test('chapter:rescue（save）：对话框取消 → 不写盘、不记目录', async () => {
  const dir = await mkTmp();
  const { channels, calls } = makeHost({ canceled: true, filePath: path.join(dir, '不该出现.txt') });
  const result = await channels.get('chapter:rescue')('正文', 'save', '第1章');
  assert.deepEqual(result, { canceled: true });
  assert.deepEqual(await fs.readdir(dir), []);
  assert.deepEqual(calls.exportDirs, []);
});

test('chapter:rescue（copy）：正文进系统剪贴板，返回字数；不弹对话框、不写盘', async () => {
  const dir = await mkTmp();
  const { channels, calls } = makeHost({ filePath: path.join(dir, '不该出现.txt') });
  const body = '复制正文：这一章还在编辑区里。';
  const result = await channels.get('chapter:rescue')(body, 'copy', '第1章');
  assert.deepEqual(calls.clipboard, [body]);
  assert.deepEqual(calls.dialogs, []);
  assert.deepEqual(await fs.readdir(dir), []);
  assert.deepEqual(result, { copied: true, chars: chaptersLib.countChars(body) });
});

// P1（三审）：这条通道是「能打开但存不进书库」那一类章的唯一应用内出口 —— 上限从保存上限
// （5,000,000）放宽到「能打开」同口径（ipcLimits.MAX_CHAPTER_RESCUE_CHARS），否则救援入口
// 和被救的目标一起被 500 万字挡住。断言随之改为：null 仍拒绝；超过**救稿上限**才拒绝；
// 正好超过保存上限（5,000,001）必须能救出去。
test('chapter:rescue：正文走救稿上限（比保存上限宽），null / 超过救稿上限仍拒绝', async () => {
  const { channels, calls } = makeHost({ filePath: path.join(os.tmpdir(), 'never.txt') });
  await assert.rejects(() => channels.get('chapter:rescue')(null, 'save', '第1章'), (err) => err.code === 'BAD_TEXT');
  assert.ok(
    ipcLimits.MAX_CHAPTER_RESCUE_CHARS > ipcLimits.MAX_TEXT_CHARS,
    '救稿上限必须比保存上限宽（能打开才能救稿）'
  );
  const overSave = '字'.repeat(ipcLimits.MAX_TEXT_CHARS + 1);
  const rescued = await channels.get('chapter:rescue')(overSave, 'copy', '第1章');
  assert.deepEqual(calls.clipboard, [overSave], '超 500 万字的章必须能复制出去');
  assert.equal(rescued.copied, true);
  assert.equal(rescued.chars, chaptersLib.countChars(overSave));
  await assert.rejects(
    () => channels.get('chapter:rescue')('字'.repeat(ipcLimits.MAX_CHAPTER_RESCUE_CHARS + 1), 'copy', '第1章'),
    (err) => err.code === 'TEXT_TOO_LARGE' && /救稿正文太长/.test(err.message)
  );
  assert.deepEqual(calls.dialogs, []);
});