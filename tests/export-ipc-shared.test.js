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

// TB-02：临时目录统一经 tests/tmp-cleanup.js 的 mkTmp（mkdtemp + 登记回收）。
const mkTmp = (prefix = 'cw-export-shared-') => tmpCleanup.mkTmp(prefix);

function makeHost({ targetPath, canceled = false, readHook = null, docxLib: docxLibOverride = null } = {}) {
  const channels = new Map();
  const calls = { dialogs: [], exportDirs: [], reads: 0 };
  const host = {
    handle: (name, fn) => { channels.set(name, fn); },
    handleBook: (name, fn) => { channels.set(name, fn); },
    storage: {
      readBookMeta: (bookPath) => storage.readBookMeta(bookPath),
      loadChapterText: async (bookPath, file) => {
        calls.reads += 1;
        if (readHook) await readHook(bookPath, file);
        return storage.loadChapterText(bookPath, file);
      },
      // 五-M33（IE-02）：只读长流程在途租约（真实实现，行为用例要用它拦删除）
      beginReadLease: (bookPath) => storage.beginReadLease(bookPath)
    },
    exporter,
    chaptersLib,
    epubLib,
    docxLib: docxLibOverride || docxLib,
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
// 五-M33（IE-02）：导出 / 整本复制是只读长流程 —— 不拿书写锁（会阻塞同书正常保存），但同窗口
// 「回书架 → 删同书」在逐章读盘期间能把源文件夹整个搬进回收站，导出中途撞 CHAPTER_MISSING。
// 现在主进程按 bookPath 登记在途租约：book:delete 的闸门据此拒绝（保存 / 整理等写操作照常），
// 导出成功或失败都在 finally 释放，删除不再依赖「作者不会在导出时删书」。
test('五-M33（IE-02）：导出在途时同一本书的删除被租约拦下，导出结束立即释放', async () => {
  const dir = await mkTmp();
  const root = path.join(dir, '书库');
  await fs.mkdir(root, { recursive: true });
  const bookPath = await makeBook(root);
  let blocked = null;
  const { channels } = makeHost({
    targetPath: path.join(dir, '租约.epub'),
    readHook: () => {
      if (blocked) return;
      try {
        storage.assertBookNotBusy(bookPath, 'win-any', 'delete');
      } catch (err) {
        blocked = err;
      }
    }
  });

  const res = await channels.get('book:export-epub')(bookPath);
  assert.equal(res.canceled, false);
  assert.ok(blocked, '导出读正文期间删除必须被拦下（而不是让导出打到一半 CHAPTER_MISSING）');
  assert.equal(blocked.code, 'READ_LEASE_BUSY');
  assert.match(blocked.message, /正在被只读长流程使用/);
  assert.equal(storage.isBookReadLeased(bookPath), false, '导出结束（成功 / 失败）租约都要释放');
  // 结束之后正常删除闸门不再被拦
  assert.doesNotThrow(() => storage.assertBookNotBusy(bookPath, 'win-any', 'delete'));
});

test('五-M33 静态闸门：TXT / EPUB+DOCX / 整本复制三条长读取流程都登记并释放租约', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'ipc', 'export.js'), 'utf8');
  assert.ok(
    (src.match(/beginReadLease\(bookPath\)/g) || []).length >= 3,
    'TXT 导出 / exportStructured / book:copy 都要登记在途租约'
  );
  assert.ok(
    (src.match(/releaseLease\(\)/g) || []).length >= 3,
    '每条租约都要有释放点（finally）'
  );
  assert.match(
    src,
    /handleBook\('book:copy'[\s\S]{0,900}beginReadLease\(bookPath\)/,
    '整本复制（collectExportTexts 逐章读）也要登记'
  );
});

// TC-4（五-L6）：streamZip 在 document.xml「deflate 后不更小」时会第二次调用 chunks 工厂（store 兜底），
// readText 随工厂重跑一遍 —— 旧实现每跑一遍就 `chars +=` 一次，导出回包字数翻倍（XML 必可压缩，
// 几乎不可达，但 chars 副作用没有按幂等设计）。现在 chars 按章（index）只计一次。
// 这里用假 docxLib 精确模拟「工厂被调用两遍」：真实压缩兜底路径没法在单测里稳定制造。
test('五-L6（TC-4）：streamDocx 压缩兜底二次调用工厂，chars 仍按章只计一次（不翻倍）', async () => {
  const dir = await mkTmp();
  const root = path.join(dir, '书库');
  await fs.mkdir(root, { recursive: true });
  const bookPath = await makeBook(root);
  const meta = await storage.readBookMeta(bookPath);
  const body = '第一段正文。\n第二段：还带一点标点，';
  let factoryRuns = 0;
  const fakeDocx = {
    docxFileName: () => '兜底.docx',
    streamDocx: async (input, write) => {
      // 模拟文档 XML 的 chunks 工厂被 zip 兜底调用第二遍：同一章 readText 再执行一次
      for (let pass = 0; pass < 2; pass += 1) {
        for (const index of [0]) {
          await input.readText(index, meta.chapters[index]);
          factoryRuns += 1;
        }
      }
      await write(Buffer.from('PK-fake'));
      return { bytes: 7, chapterCount: 1, rangeMode: 'book', rangeLabel: '全书' };
    }
  };
  const { channels } = makeHost({ targetPath: path.join(dir, '兜底.docx'), docxLib: fakeDocx });
  const result = await channels.get('book:export-docx')(bookPath, null, null);
  assert.equal(result.canceled, false);
  assert.equal(factoryRuns, 2, '前提：工厂确实被调用了两遍');
  assert.equal(
    result.chars,
    chaptersLib.countChars(body),
    'chars 按章只计一次（旧实现二次调用再累加 → 翻倍）'
  );
  assert.equal(await fs.readFile(result.filePath, 'utf8'), 'PK-fake', '兜底包装照样写盘');
});
