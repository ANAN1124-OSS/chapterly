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
function makeHost({ targetPath = '', canceled = false, readThrows = false, lastExportDir = '', readDelayMs = 0 } = {}) {
  const channels = new Map();
  const events = [];
  const calls = { dialogs: 0, reads: [], writes: 0, dialogOptions: [], inFlight: 0, peak: 0 };
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
        // PERF-EXP-01：并发读峰值探针（有界预取的验证口径）
        calls.inFlight += 1;
        calls.peak = Math.max(calls.peak, calls.inFlight);
        try {
          if (readDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, readDelayMs));
          return await storage.loadChapterText(bookPath, file);
        } finally {
          calls.inFlight -= 1;
        }
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
    fs: fsp,
    fsSync: fs,
    getConfig: async () => ({ exportConversion: '', lastExportDir }),
    getClipboard: () => ({
      writeText: async (text) => {
        clipboard.push(text);
        events.push('clipboard');
      }
    }),
    showSaveDialog: async (options) => {
      calls.dialogs += 1;
      calls.dialogOptions.push(options || {});
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

test('R7-2 确认保存：事件顺序严格 dialog → read:*，三格式各读 3 章一次（有界预取窗口内、不重复读）', async () => {
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

// N-10 / N-11 / N-12（二次审查）的导出域行为断言。
// N-10：默认目录探测改异步 + 有界等待（不再 statSync 卡主线程），目录没了回「文档」；
// N-11：book:export-plan 只用书目缓存，缺缓存的章不读正文（回 charsPending）；
// N-12：book:copy 逐块拼装，输出与 composeBook / composeSelected 逐字节一致。

test('N-10：导出默认目录探测不在主线程同步 stat——存在的上次目录照用，没了的回「文档」', async () => {
  const fsSync = require('node:fs');
  const dir = await makeTmpDir('cw-export-dir-probe-');
  const root = path.join(dir, '书库');
  await fsp.mkdir(root, { recursive: true });
  const bookPath = await makeBook(root, ['开端', '转折']);
  const documents = path.join(os.tmpdir(), 'cw-documents');
  const keep = path.join(dir, '导出 目录');
  await fsp.mkdir(keep, { recursive: true });

  const kept = makeHost({ targetPath: path.join(dir, '导出.txt'), canceled: true, lastExportDir: keep });
  await kept.channels.get('book:export')(bookPath, null, null);
  assert.equal(path.dirname(kept.calls.dialogOptions[0].defaultPath), keep, '上次导出目录还在就继续用它');

  const gone = makeHost({
    targetPath: path.join(dir, '导出.txt'),
    canceled: true,
    lastExportDir: path.join(dir, '已经不存在的盘', '导出')
  });
  const canceled = await gone.channels.get('book:export')(bookPath, null, null);
  assert.deepEqual(canceled, { canceled: true }, '目录探测失败不影响取消路径');
  assert.equal(
    path.dirname(gone.calls.dialogOptions[0].defaultPath),
    documents,
    '探测不到（断网盘 / 已删除）就退回「文档」，保证对话框一定打得开'
  );

  // 救稿入口同一份探测（断盘上同样不许阻塞 / 抛错）
  const rescue = makeHost({ canceled: true, lastExportDir: path.join(dir, '也不存在') });
  const rescued = await rescue.channels.get('chapter:rescue')('这一段正文。', 'save', '救稿');
  assert.deepEqual(rescued, { canceled: true });
  assert.equal(path.dirname(rescue.calls.dialogOptions[0].defaultPath), documents);

  // 静态闸门：主线程同步 statSync 必须消失，改成 withDeadline + 异步 fs.stat
  const src = fsSync.readFileSync(path.join(__dirname, '..', 'ipc', 'export.js'), 'utf8');
  assert.equal(src.includes('fsSync.statSync('), false, 'ipc/export 不许再用同步 statSync 探测目录（N-10）');
  assert.match(
    src,
    /const EXPORT_DIR_PROBE_MS = 2000;/,
    '目录探测要有明确上限（SMB 超时不再拖住主进程）'
  );
  assert.match(
    src,
    /closeGuard\.withDeadline\(\(\) => fs\.stat\(dir\), \{ ms: EXPORT_DIR_PROBE_MS \}\)/,
    '异步 stat 必须有界等待；到点按「目录不存在」处理'
  );
});

test('N-11：book:export-plan 只用书目字数缓存——缺缓存的章不读正文，回 charsPending 让界面标「待统计」', async () => {
  const dir = await makeTmpDir('cw-export-plan-cache-');
  const root = path.join(dir, '书库');
  await fsp.mkdir(root, { recursive: true });
  const bookPath = await makeBook(root, ['开端', '转折', '尾声']);
  const metaPath = path.join(bookPath, '书目.json');
  // 先把三章字数缓存补齐（真实书在书架扫描 / 保存后都有），再只删第 2 章的缓存
  const loaded = await storage.readBookMeta(bookPath);
  for (const chapter of loaded.chapters) {
    chapter.chars = chaptersLib.countChars((await storage.loadChapterText(bookPath, chapter.file)).text);
  }
  await storage.writeBookMeta(bookPath, loaded);
  const raw = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
  const knownChars = raw.chapters[0].chars + raw.chapters[2].chars;
  assert.equal(Number.isFinite(knownChars), true, '用例前提：其余两章有字数缓存');
  delete raw.chapters[1].chars; // 第 2 章缓存缺失
  await fsp.writeFile(metaPath, JSON.stringify(raw, null, 2), 'utf8');

  const { channels, calls } = makeHost({ canceled: true });
  const plan = await channels.get('book:export-plan')(bookPath, null, null);
  assert.equal(plan.chapterCount, 3);
  assert.equal(plan.chars, knownChars, '预览字数 = 已有缓存之和（缺缓存的不猜）');
  assert.equal(plan.charsPending, 1, '缺缓存的章数要如实回给界面');
  assert.equal(calls.reads.length, 0, '对话框出现之前一个章节正文都不许读（N-11 核心）');

  // 当前章未保存内容（override）仍按编辑区现算；命中的就是缺缓存那章 → 待统计归零
  const meta = await storage.readBookMeta(bookPath);
  const override = { chapterId: meta.chapters[1].id, text: '编辑区里这一版。' };
  const withOverride = await channels.get('book:export-plan')(bookPath, override, null);
  assert.equal(withOverride.chars, knownChars + 8, '覆盖章按编辑区正文的 countChars 现算（8 字）');
  assert.equal(withOverride.charsPending, 0, '每一章的字数都有来源了');
  assert.equal(withOverride.includedUnsaved, true);
  assert.equal(calls.reads.length, 0, 'override 也一样：预览阶段不读盘');
});

test('N-12：book:copy 逐块拼装的输出与 composeBook / composeSelected 逐字节一致（读正文后立刻拼块）', async () => {
  const dir = await makeTmpDir('cw-export-copy-blocks-');
  const root = path.join(dir, '书库');
  await fsp.mkdir(root, { recursive: true });
  const created = await storage.createBook(root, '复制拼装书');
  const bookPath = created.path;
  await storage.saveChapterText(bookPath, created.meta.chapters[0].file, '第一章正文。\n第二段。');
  const volume = await storage.createVolume(bookPath, '上卷');
  await storage.createChapterWithText(bookPath, {
    insertIndex: 1,
    name: '卷内章',
    text: '卷内正文。',
    volumeId: volume.volume.id
  });
  const meta = await storage.readBookMeta(bookPath);
  const texts = [];
  for (const chapter of meta.chapters) {
    texts.push((await storage.loadChapterText(bookPath, chapter.file)).text);
  }

  // 整本：卷名行 / 章标题 / 块间空行 / 末尾换行都要与 composeBook 逐字节一致
  const whole = makeHost();
  const wholeResult = await whole.channels.get('book:copy')(bookPath, null, null);
  assert.equal(wholeResult.chapterCount, 2);
  assert.equal(whole.clipboard.length, 1);
  assert.equal(whole.clipboard[0], exporter.composeBook(meta, texts), '整本复制与 composeBook 逐字节一致');
  assert.ok(whole.clipboard[0].includes('上卷'), '有分卷时卷名行还在');

  // 选中章：无卷名行、去重升序，与 composeSelected 逐字节一致
  const picked = makeHost();
  const pickedResult = await picked.channels.get('book:copy')(bookPath, null, [1, '0', 1, 99]);
  assert.equal(pickedResult.chapterCount, 2);
  assert.equal(picked.clipboard[0], exporter.composeSelected(meta, texts, [0, 1]), '选中章复制与 composeSelected 逐字节一致');
  assert.equal(picked.clipboard[0].includes('上卷'), false, '选中章复制不带卷名行');

  // 实现闸门：不再物化整本 texts 数组，走 entries + 逐块拼装
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'ipc', 'export.js'), 'utf8');
  assert.equal(/collectExportTexts\(/.test(src), false, '旧的整本 texts 收集（函数 / 调用）必须删掉（N-12）');
  assert.match(src, /exporter\.copyEntries\(meta, indexes\)/);
  assert.match(src, /exporter\.copyBlock\(meta, entries\[batch\[offset\]\]\.index, text\)/);
  assert.match(src, /exporter\.joinCopyBlocks\(blocks\)/);
});

// PERF-EXP-01（2026-11-24 复核补审）：TXT / EPUB / DOCX 的流式导出加有界读预取 —— 逐章消费顺序
// 与产物不变，读盘之间重叠（慢盘上整本导出不再 ≈ 章数 × 单章延迟），同时在飞的读 ≤ 窗口 + 当前章。
test('PERF-EXP-01：三格式逐章读有界预取（峰值 ≥2 且 ≤4），TXT 产物与整本构建逐字节一致', async () => {
  const dir = await makeTmpDir('cw-prefetch-');
  const root = path.join(dir, '书库');
  await fsp.mkdir(root, { recursive: true });
  const names = Array.from({ length: 12 }, (_, i) => `第${i + 1}章`);
  const bookPath = await makeBook(root, names);
  const meta = await storage.readBookMeta(bookPath);
  const texts = [];
  for (const chapter of meta.chapters) {
    texts.push((await storage.loadChapterText(bookPath, chapter.file)).text);
  }
  const oracle = exporter.buildTxtExport(meta, texts.slice(), null, '', null);

  const txtTarget = path.join(dir, '预取.txt');
  const txtHost = makeHost({ targetPath: txtTarget, readDelayMs: 10 });
  const txtResult = await txtHost.channels.get('book:export')(bookPath, null, null);
  assert.equal(txtResult.canceled, false);
  assert.ok(txtHost.calls.peak >= 2, `TXT 读盘要有重叠（实测峰值 ${txtHost.calls.peak}）`);
  assert.ok(txtHost.calls.peak <= 4, `TXT 预取窗口有界（实测峰值 ${txtHost.calls.peak}）`);
  assert.equal(txtHost.calls.reads.length, 12, '每章仍然只读一次');
  assert.deepEqual(await fsp.readFile(txtTarget), oracle, 'TXT 产物必须与整本构建逐字节一致');

  for (const [channel, ext] of [['book:export-epub', 'epub'], ['book:export-docx', 'docx']]) {
    const target = path.join(dir, `预取.${ext}`);
    const host = makeHost({ targetPath: target, readDelayMs: 10 });
    const result = await host.channels.get(channel)(bookPath, null, null);
    assert.equal(result.canceled, false, `${channel} 正常导出`);
    assert.ok(
      host.calls.peak >= 2 && host.calls.peak <= 4,
      `${channel} 读盘峰值 ${host.calls.peak} 必须 ≥2（有重叠）且 ≤4（窗口有界）`
    );
    assert.ok(result.bytes > 0);
    assert.equal(fs.existsSync(target), true, `${channel} 产物已写出`);
  }

  // 40 章对拍：窗口不随章数增长，产物与整本构建逐字节一致
  const bigRoot = path.join(dir, '书库40');
  await fsp.mkdir(bigRoot, { recursive: true });
  const bigPath = await makeBook(bigRoot, Array.from({ length: 40 }, (_, i) => `第${i + 1}章`));
  const bigMeta = await storage.readBookMeta(bigPath);
  const bigTexts = [];
  for (const chapter of bigMeta.chapters) {
    bigTexts.push((await storage.loadChapterText(bigPath, chapter.file)).text);
  }
  const bigOracle = exporter.buildTxtExport(bigMeta, bigTexts.slice(), null, '', null);
  const bigTarget = path.join(dir, '预取40.txt');
  const bigHost = makeHost({ targetPath: bigTarget, readDelayMs: 5 });
  const bigResult = await bigHost.channels.get('book:export')(bigPath, null, null);
  assert.equal(bigResult.canceled, false);
  assert.equal(bigHost.calls.reads.length, 40, '40 章各读一次');
  assert.ok(bigHost.calls.peak <= 4, `40 章峰值仍是 ≤4（实测 ${bigHost.calls.peak}）`);
  assert.deepEqual(await fsp.readFile(bigTarget), bigOracle, '40 章产物逐字节一致');
});

// 2026-11-25：0 章书复制整本 → 明确 NO_CHAPTERS，不把空串写进剪贴板（不清空作者剪贴板）。
test('R7-6 book:copy：0 章书拒绝复制（NO_CHAPTERS），剪贴板一个字节不动', async () => {
  const dir = await makeTmpDir('cw-read-order-empty-');
  const root = path.join(dir, '书库');
  await fsp.mkdir(root, { recursive: true });
  const created = await storage.createBook(root, '空章节书', { createFirstChapter: false });
  const { channels, calls, clipboard } = makeHost();
  await assert.rejects(
    () => channels.get('book:copy')(created.path, null, null),
    (err) => err && err.code === 'NO_CHAPTERS'
  );
  assert.equal(calls.reads.length, 0, '0 章书不读正文');
  assert.equal(clipboard.length, 0, '不许把空串写进剪贴板');
});
