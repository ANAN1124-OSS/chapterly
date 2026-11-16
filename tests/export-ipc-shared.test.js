// 审计修复 #24（R2）的 IPC 入口回归：EPUB / DOCX 两个导出频道共用同一套 exportStructured
// （保存对话框 → 读正文 → 简繁转换 → 构建 → 原子写盘 → 记目录 → 回形状）。
//
// 装配真实的 ipc/export.js 与真实 core/epub.js / core/docx.js，只把 Electron / 窗口 / 配置
// 这些宿主换成最小桩（不启动 Electron）。钉住两件事：
//   1. 两个频道仍然只差「对话框文案 / 默认文件名 / build 函数」，返回形状逐字段一致；
//   2. 「保存对话框确认之后才读正文」这条时序对两个格式都成立（取消时一次正文都不读）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const exportIpc = require('../ipc/export');
const storage = require('../core/storage');
const exporter = require('../core/exporter');
const chaptersLib = require('../core/chapters');
const epubLib = require('../core/epub');
const docxLib = require('../core/docx');
const s2tLib = require('../core/s2t');
const ipcLimits = require('../core/ipc-limits');
const atomic = require('../core/atomic');
const tmpCleanup = require('./tmp-cleanup');

async function mkTmp() {
  return tmpCleanup.track(await fs.mkdtemp(path.join(os.tmpdir(), 'cw-export-shared-')));
}

function makeHost({ targetPath, canceled = false } = {}) {
  const channels = new Map();
  const calls = { dialogs: [], exportDirs: [], reads: 0 };
  const host = {
    handle: (name, fn) => { channels.set(name, fn); },
    handleBook: (name, fn) => { channels.set(name, fn); },
    storage: {
      readBookMeta: (bookPath) => storage.readBookMeta(bookPath),
      loadChapterText: async (bookPath, file) => {
        calls.reads += 1;
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
    app: { getPath: () => path.join(os.tmpdir(), 'cw-documents') },
    fsSync: require('node:fs'),
    getConfig: async () => ({ exportConversion: '', lastExportDir: '' }),
    getClipboard: () => ({ writeText: async () => {} }),
    showSaveDialog: async (options) => {
      calls.dialogs.push(options);
      if (canceled) return { canceled: true, filePath: undefined };
      return { canceled: false, filePath: targetPath };
    },
    rememberExportDir: async (dir) => { calls.exportDirs.push(dir); },
    atomicWriteFile: atomic.atomicWriteFile,
    atomicWriteFileStream: atomic.atomicWriteFileStream
  };
  exportIpc.register(host);
  return { channels, calls };
}

async function makeBook(root) {
  const { path: bookPath } = await storage.createBook(root, '共享导出');
  const meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '第一段正文。\n第二段：还带一点标点，');
  return bookPath;
}

test('#24 R2：book:export-epub / book:export-docx 共用 exportStructured，返回形状逐字段一致', async () => {
  const dir = await mkTmp();
  const root = path.join(dir, '书库');
  await fs.mkdir(root, { recursive: true });
  const bookPath = await makeBook(root);
  const epubPath = path.join(dir, '共享.epub');
  const docxPath = path.join(dir, '共享.docx');

  const epubHost = makeHost({ targetPath: epubPath });
  const epub = await epubHost.channels.get('book:export-epub')(bookPath, null, null);
  const docxHost = makeHost({ targetPath: docxPath });
  const docx = await docxHost.channels.get('book:export-docx')(bookPath, null, null);

  for (const [label, result, target, dialogTitle, extension, host] of [
    ['EPUB', epub, epubPath, '导出 EPUB', 'epub', epubHost],
    ['DOCX', docx, docxPath, '导出 DOCX', 'docx', docxHost]
  ]) {
    assert.equal(result.canceled, false, `${label}：导出成功`);
    assert.equal(result.filePath, target);
    assert.equal(result.chapterCount, 1, `${label}：章数来自范围计划`);
    assert.equal(result.chars, chaptersLib.countChars('第一段正文。\n第二段：还带一点标点，'));
    assert.equal(result.includedUnsaved, false);
    assert.equal(result.conversion, '');
    assert.equal(result.rangeLabel, '全书');
    assert.ok(result.bytes > 0, `${label}：bytes 要如实回传`);
    const bytes = await fs.readFile(target);
    assert.equal(bytes.slice(0, 2).toString('latin1'), 'PK', `${label}：产物是 zip 包`);
    assert.equal(bytes.length, result.bytes, `${label}：bytes 与实际写盘一致`);
    // 默认文件名来自各自的纯函数（共享内核只负责把 defaultName 塞进对话框）
    assert.equal(
      path.basename(host.calls.dialogs[0].defaultPath),
      `共享导出.${extension}`,
      `${label}：默认文件名按格式命名规则`
    );
    assert.equal(host.calls.dialogs[0].title, dialogTitle, `${label}：对话框标题按格式`);
    assert.deepEqual(host.calls.exportDirs, [dir], `${label}：记住导出目录`);
  }
  // 两个格式的返回键集合完全一致（#24 R2：形状差异只来自 built，不来自两套流程）
  assert.deepEqual(Object.keys(epub).sort(), Object.keys(docx).sort());
});

test('#24 R2：取消导出时两个格式都不读正文、不写盘（共享内核的时序）', async () => {
  const dir = await mkTmp();
  const root = path.join(dir, '书库');
  await fs.mkdir(root, { recursive: true });
  const bookPath = await makeBook(root);
  for (const channel of ['book:export-epub', 'book:export-docx']) {
    const { channels, calls } = makeHost({ targetPath: path.join(dir, `不该出现.${channel.endsWith('epub') ? 'epub' : 'docx'}`), canceled: true });
    const result = await channels.get(channel)(bookPath, null, null);
    assert.deepEqual(result, { canceled: true }, `${channel}：取消回同一形状`);
    assert.equal(calls.reads, 0, `${channel}：对话框取消后不许读正文`);
    assert.deepEqual(calls.exportDirs, [], `${channel}：取消不记导出目录`);
  }
  assert.deepEqual(await fs.readdir(dir), ['书库'], '取消没有写出任何文件');
});

test('#24 R2：默认文件名在对话框之前算好（EPUB / DOCX 各自复用 TXT 的范围命名）', async () => {
  const dir = await mkTmp();
  const root = path.join(dir, '书库');
  await fs.mkdir(root, { recursive: true });
  const bookPath = await makeBook(root);
  const host = makeHost({ targetPath: path.join(dir, '不该出现.epub') });
  // 用不存在的范围提前结束：只要证明默认名是按格式纯函数算的、和 range 无关地传进对话框
  const meta = await storage.readBookMeta(bookPath);
  const range = { mode: 'range', from: 1, to: 1 };
  assert.equal(
    epubLib.epubFileName(meta, range),
    '共享导出-第1章.epub',
    'EPUB 默认名规则'
  );
  assert.equal(docxLib.docxFileName(meta, range), '共享导出-第1章.docx', 'DOCX 默认名规则');
  await host.channels.get('book:export-epub')(bookPath, null, range);
  assert.equal(
    path.basename(host.calls.dialogs[0].defaultPath),
    '共享导出-第1章.epub',
    '共享内核把 defaultName 传给对话框（不是写死书名）'
  );
});