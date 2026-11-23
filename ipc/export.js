/* 主进程 IPC 域模块：导出 / 复制（v1.8.0 WP-34 / D1 + V114，D-6 已定范围）。
 *
 * 只搬不改行为：三个导出入口仍是「保存对话框确认之后才读正文」（审计 #7）；TXT / EPUB / DOCX 都走
 * atomicWriteFileStream + core/*.stream*（逐章读、流式打包，不常驻整本正文 / 整包 Buffer），字节产物
 * 与整本构建路径逐字节一致（tests/export-stream-wp13.test.js R1/R3/R4/R10 对拍）。chapter:rescue 是
 * 本域唯一新增（V302）：保存被阻断时的救稿出口，复用本模块的保存对话框 / 原子写 / 剪贴板句柄，
 * 刻意不读也不写书库（书 / 章文件可能已经不在）。其余频道（导入 / 整理 / 历史 / 排版…）仍留在
 * main.js —— D-6 只拆导出 / 校对 / 书 CRUD 三块。
 *
 * 契约：register(host) —— host 成员逐条列在 REQUIRED_HOST，缺任何一个在 registerIpc() 装配时抛
 * TypeError（不在频道调用时才 ReferenceError）。模块自己不 require electron、不缓存状态快照；剪贴板与
 * 配置仓库句柄按 getter 现取（两者都是可变绑定，快照会过期）。
 */
const { assertHost } = require('../core/assert-host');
// N-10：导出 / 救稿前的「上次导出目录还在不在」要异步 + 有界等待（见 defaultExportDir）。
const closeGuard = require('../core/close-guard');
// MAIN-01：本域 8 个 handleBook 全部是只读（导出 / 复制只读正文与书目，写的是用户选定的外部文件 /
// 剪贴板），显式传 READ_ONLY —— 不再靠「省略第三个参数」碰巧只读，与 ipc/book-data.js 同一纪律。
const { READ_ONLY } = require('./book-mutations');

const REQUIRED_HOST = [
  'handle',
  'handleBook',
  'storage',
  'exporter',
  'chaptersLib',
  'epubLib',
  'docxLib',
  's2tLib',
  'ipcLimits',
  'mapLimit',
  'CHAPTER_READ_CONCURRENCY',
  'CHAPTER_BATCH_SIZE',
  'path',
  'pathUtils',
  'app',
  'fs',
  'getConfig',
  'getClipboard',
  'showSaveDialog',
  'rememberExportDir',
  'atomicWriteFile',
  'atomicWriteFileStream'
];

function registerExportIpc(host) {
  assertHost('ipc/export.registerExportIpc', host, REQUIRED_HOST);
  const {
    handle, handleBook, storage, exporter,
    chaptersLib, epubLib, docxLib, s2tLib,
    ipcLimits, mapLimit, CHAPTER_READ_CONCURRENCY, CHAPTER_BATCH_SIZE,
    path, pathUtils, app, fs, getConfig,
    getClipboard, showSaveDialog, rememberExportDir, atomicWriteFile,
    atomicWriteFileStream
  } = host;

  // 五-M33（IE-02）：只读长流程（导出三格式 / 整本复制）的在途租约 —— 不拿书写锁（会阻塞同书
  // 正常保存），但 book:delete 的闸门会据此拒绝「导出途中把自己正在读的书删掉」。宿主没提供时
  // 退化为空租约（最小桩单测 / 老宿主），生产始终由 core/storage.js 实现。
  const beginReadLease =
    typeof storage.beginReadLease === 'function' ? storage.beginReadLease : () => () => {};

  // 拼导出/复制用的正文：默认读磁盘；override 是编辑区里当前章的最新内容（未保存也算，只参与拼接不写盘）
  // chars 回报的是「正文字数」（去掉空白/换行，和编辑页字数统计同一口径），不是文件字节数
  // indexes 可选：只读选中的章（按范围导出用），没选中的位置留空字符串但保持下标对齐
  // P2-2（1.5.0）：按 CHAPTER_BATCH_SIZE 章一批读（批内仍限并发 CHAPTER_READ_CONCURRENCY、批间串行）。
  // texts 仍按书目下标填、没选中的位置留空串，顺序 / 内容 / chars 与「一次读完再求和」逐字一致。
  // 审计残留修复 #R14（#44/E18）口径注记：override 在「整本 / 按范围导出」与「复制整本」里是
  // 「能对上就替、对不上就按磁盘」——过期 chapterId（章刚被删 / 编辑区换了书）只会让
  // includedUnsaved 如实回 false，导出照常按磁盘内容完成（不报错、也不会拼进错章，见
  // core/exporter.js chapterRefIndex 的「有 id 只按 id 结算」）。只有单章动作
  // chapter:copy-platform 找不到章才抛 CHAPTER_NOT_FOUND —— 那一条的语义就是「复制这一章」，
  // 章不在就不能拿别的章冒充。README「已知限制」里写明同一条口径。
  // N-12（二次审查）：整本复制改成「读一批 → 立刻拼成输出块 → 丢掉正文」，不再保留整本 texts 数组；
  // 最终串仍必须整份给剪贴板（剪贴板只能收整串），峰值从「texts + blocks + 最终串」降到「blocks + 最终串」。
  async function collectCopyBlocks(bookPath, meta, override, indexes) {
    const entries = exporter.copyEntries(meta, indexes);
    const overrideIndex = exporter.chapterIndexOf(meta, override);
    // 卷名行直接落在自己那一格；章节格先留空，读完一批立刻填上并丢掉正文。
    const blocks = new Array(entries.length);
    const chapterSlots = [];
    for (let i = 0; i < entries.length; i += 1) {
      if (entries[i].name !== undefined) blocks[i] = entries[i].name;
      else chapterSlots.push(i);
    }
    let chars = 0;
    for (let start = 0; start < chapterSlots.length; start += CHAPTER_BATCH_SIZE) {
      const batch = chapterSlots.slice(start, start + CHAPTER_BATCH_SIZE);
      const loaded = await mapLimit(batch, CHAPTER_READ_CONCURRENCY, async (slot) => {
        const index = entries[slot].index;
        if (index === overrideIndex) return override.text;
        return (await storage.loadChapterText(bookPath, meta.chapters[index].file)).text;
      });
      for (let offset = 0; offset < batch.length; offset += 1) {
        const text = loaded[offset];
        chars += chaptersLib.countChars(text);
        blocks[batch[offset]] = exporter.copyBlock(meta, entries[batch[offset]].index, text);
      }
    }
    return {
      text: exporter.joinCopyBlocks(blocks),
      chars,
      chapterCount: chapterSlots.length,
      includedUnsaved: overrideIndex >= 0 && entries.some((entry) => entry.index === overrideIndex)
    };
  }

  // 导出范围预览（只读）：对话框里实时显示「选中几章 / 多少字 / 默认文件名」。
  // 字数**只用书目里的 chars 缓存**求和（审计 F3）；编辑区里当前章的未保存内容（override）永远现算。
  // N-11（二次审查）：缓存缺失的章不再在对话框出现前读盘现算（旧实现 8 路 loadChapterText 读整本），
  // 否则「点导出」会先读完缺缓存的大书才弹框，与「确认后才读正文」的纪律冲突、网络盘上像假死。
  // 缺缓存的章回 charsPending，界面标「另有 N 章字数待统计」；正式导出仍在确认后读全文。
  // v0.9 C-5：override / range 先过 core/ipc-limits.js——正文超过 500 万字报 TEXT_TOO_LARGE，
  // 坏形状按旧行为降级（override 当没有、range 当全书 / 越界收紧）。
  handleBook('book:export-plan', async (bookPath, override, range) => {
    const meta = await storage.readBookMeta(bookPath);
    const safeOverride = ipcLimits.sanitizeOverride(override);
    const safeRange = ipcLimits.sanitizeRange(range);
    const plan = exporter.resolveExportRange(meta, safeRange);
    const overrideIndex = exporter.chapterIndexOf(meta, safeOverride);
    let chars = 0;
    let charsPending = 0;
    for (const index of plan.indexes) {
      if (index === overrideIndex) {
        chars += chaptersLib.countChars(safeOverride.text);
        continue;
      }
      const cached = exporter.cachedCharsOf(meta.chapters[index]);
      if (cached != null) chars += cached;
      else charsPending += 1;
    }
    return {
      mode: plan.mode,
      label: plan.label,
      chapterCount: plan.count,
      chars,
      // N-11：选中范围内「字数还没缓存」的章数（0 = 上面这个字数是精确值；>0 = 只统计了已知部分）
      charsPending,
      from: plan.from,
      to: plan.to,
      volumeId: plan.volumeId,
      empty: plan.empty,
      fileName: exporter.exportFileName(meta, safeRange),
      epubFileName: epubLib.epubFileName(meta, safeRange),
      docxFileName: docxLib.docxFileName(meta, safeRange),
      includedUnsaved: overrideIndex >= 0 && plan.indexes.includes(overrideIndex)
    };
  }, READ_ONLY);

  // N-16（二次审查）：导出 / 救稿的落点不许落在书库（或当前书文件夹）内。保存对话框里可以一路
  // 导航到书文件夹并选中 `001-第1章.txt`，Windows 只问一次「是否替换」，确认后整本导出的内容就把
  // 那一章的正文覆盖掉（章节没有自动备份，除非开了每日快照）。判定只用字符串级 pathKey，不读盘：
  // 落点等于 / 位于 booksRoot 或当前书目录下时抛软错误，让作者换一个书库外的目录。
  function isPathInside(target, dir) {
    const targetKey = pathUtils.pathKey(target);
    const dirKey = pathUtils.pathKey(dir);
    if (!targetKey || !dirKey) return false;
    if (targetKey === dirKey) return true;
    const prefix = dirKey.endsWith(path.sep) ? dirKey : dirKey + path.sep;
    return targetKey.startsWith(prefix);
  }

  function assertExportTargetOutsideLibrary(filePath, cfg, bookPath) {
    const roots = [];
    if (cfg && cfg.booksRoot) roots.push(cfg.booksRoot);
    if (bookPath) roots.push(bookPath);
    for (const root of roots) {
      if (!isPathInside(filePath, root)) continue;
      throw new storage.StorageError(
        'EXPORT_TARGET_IN_LIBRARY',
        '这个位置在书库里，保存会覆盖章节正文；请换一个书库外的目录'
      );
    }
  }

  // 目录是否存在（导出默认目录兜底用）。N-10（二次审查）：这里原来用 fsSync.statSync 在主线程同步
  // 探测 lastExportDir —— 它可能是已断开的映射网络盘 / 休眠 USB / 被策略限制的共享目录，SMB 超时
  // 能让主进程（连同所有窗口）卡住几十秒。现在改异步 stat + 有界等待：到点按「目录不存在」处理，
  // 保证保存对话框一定能打开（落回「文档」而不是无限等待）。读不到 / 坏路径同样当不存在。
  const EXPORT_DIR_PROBE_MS = 2000;
  async function isDirectoryWithinDeadline(dir) {
    const outcome = await closeGuard.withDeadline(() => fs.stat(dir), { ms: EXPORT_DIR_PROBE_MS });
    if (outcome.timedOut || outcome.error) return false;
    const stat = outcome.value;
    return Boolean(stat && typeof stat.isDirectory === 'function' && stat.isDirectory());
  }

  // 导出 / 救稿默认落点：上一次导出目录（还存在才用）→ 否则「文档」。
  // 目录判定的 trim / 空值 / 只认 true 语义仍由 core/exporter.resolveExportDir 唯一决定；
  // 这里只负责把「异步有界探测」变成那次调用的同步布尔。
  async function defaultExportDir(cfg) {
    const remembered = cfg && typeof cfg.lastExportDir === 'string' ? cfg.lastExportDir : '';
    const fallback = app.getPath('documents');
    const dir = remembered.trim();
    if (!dir) return fallback;
    const exists = await isDirectoryWithinDeadline(dir);
    return exporter.resolveExportDir(remembered, fallback, () => exists);
  }

  // 导出 TXT / EPUB / DOCX 共用的前置：读书目 → 解析范围（空范围明确报错）
  // → 准备「上次导出目录 / 文档」作为默认落点。三个入口只负责各自的保存对话框、格式细节与返回字段。
  // 审计 #7（O2 / P4）：这里**只做只读前置**，正文（texts / chars / includedUnsaved）不读——
  // 交给下面 readExportTexts，等保存对话框确认之后再读。用户取消导出时一次正文都不会读，
  // 对话框停留期间也不会把整本书常驻内存。
  // v0.9 C-5：override / range 在这里统一过 core/ipc-limits.js（超长正文拒绝、坏形状降级），
  // 三个导出与下面的复制 / 校对 / 敏感词预检共用同一套口径，避免某个入口漏掉。
  async function prepareExport(bookPath, override, range) {
    const meta = await storage.readBookMeta(bookPath);
    const safeOverride = ipcLimits.sanitizeOverride(override);
    const safeRange = ipcLimits.sanitizeRange(range);
    const plan = exporter.resolveExportRange(meta, safeRange);
    if (!plan.count) {
      throw new storage.StorageError(
        'EMPTY_EXPORT_RANGE',
        plan.mode === 'all' ? '这本书里还没有章节' : '所选范围里没有章节'
      );
    }
    const cfg = await getConfig();
    // 默认落到「上一次导出保存到的目录」；没记过、或那个目录已经不存在了，才退回「文档」。
    // N-10：探测走异步 + 有界等待（不再同步 statSync 卡住主线程）。
    const defaultDir = await defaultExportDir(cfg);
    return { meta, plan, override: safeOverride, cfg, defaultDir, range: safeRange };
  }

  // 保存对话框确认之后才走的正文读取（审计 #7）已并进 exportStructured 的逐章回调：
  // EPUB / DOCX 走流式构建（B1 / WP13），TXT 走 writeTxtExport → streamTxtExport（WP-28）。
  // 三处共同纪律：只读、按章读、对话框确认之后才第一次读盘；chars 仍按原始正文去空白计数。

  // B5（v1.8.0 WP-28）：TXT 导出流式写盘 —— 每章读出来 → 拼块 → 简繁转换 → 立刻写进临时文件，
  // 整本 texts 数组 / 整本串 / 整本 Buffer 都不常驻（峰值从「约 2 份全书」降到「一章 + 它的导出块」）。
  // 字节口径与旧链（collectExportTexts → buildTxtExport）逐字节一致：BOM 先写、块间 `\r\n\r\n`、末尾一个 `\r\n`。
  // 顺序仍是「保存对话框确认 → 才开始读正文」（审计 #7）；中途失败由 atomicWriteFileStream 删掉临时文件，
  // 目标文件一个字节不动。B1（WP13）起 EPUB / DOCX 也走同一条流式写盘纪律（见 exportStructured）。
  async function writeTxtExport(filePath, bookPath, prepared) {
    const { meta, plan, override } = prepared;
    const conversion = s2tLib.normalizeMode(prepared.cfg.exportConversion);
    const overrideIndex = exporter.chapterIndexOf(meta, override);
    let chars = 0;
    // 五-M33（IE-02）：逐章读盘期间登记在途租约（删除闸门据此拒绝），finally 保证成功 / 失败都释放
    const releaseLease = beginReadLease(bookPath);
    try {
      await atomicWriteFileStream(filePath, async (write) => {
        await write(exporter.BOM);
        const summary = await exporter.streamTxtExport(meta, prepared.range, {
          conversion,
          convertText: s2tLib.convertText,
          readText: async (index, chapter) => {
            if (index === overrideIndex) return override.text;
            return (await storage.loadChapterText(bookPath, chapter.file)).text;
          },
          onChunk: (chunk) => write(chunk)
        });
        chars = summary.chars;
      });
    } finally {
      releaseLease();
    }
    return {
      chars,
      includedUnsaved: overrideIndex >= 0 && plan.indexes.includes(overrideIndex),
      conversion
    };
  }

  // EPUB / DOCX 导出成功后的返回字段（两个入口完全一致，只是 built 来自不同的纯函数）
  function archiveExportResult(filePath, built, chars, includedUnsaved, conversion, plan) {
    return {
      canceled: false,
      filePath,
      chapterCount: built.chapterCount,
      volumeCount: built.volumeCount,
      chars,
      includedUnsaved,
      bytes: built.bytes,
      conversion,
      rangeLabel: plan.label
    };
  }

  // 审计修复 #24（R2）：EPUB / DOCX 的导出流程 = 保存对话框 → 逐章读正文 → 简繁转换 → 流式构建 / 写盘
  // → 记目录 → 回形状，两个入口以前各抄一份（≈24 行近逐字重复）。现在只留这一份：
  // 每个格式只提供自己的对话框标题 / 扩展名 / 默认文件名与 stream 函数，其余全共用。
  // B1（审计 #17 / WP13）：正文不再一次读成整本 texts —— readText 回调把「读盘 + override + chars
  // + 简繁转换」按章交给格式的流式构建，整本正文 / 整本串 / 整包 Buffer 都不常驻。
  // 时序纪律不变（审计 #7）：readText 定义在取消分支之后，取消 / 改主意都不读一个字节正文。
  async function exportStructured(bookPath, override, range, options) {
    const prepared = await prepareExport(bookPath, override, range);
    const { meta, cfg, defaultDir, range: safeRange } = prepared;
    const defaultName = options.defaultName(prepared);
    const { canceled, filePath } = await showSaveDialog({
      title: options.title,
      defaultPath: path.join(defaultDir, defaultName),
      filters: options.filters
    });
    if (canceled || !filePath) return { canceled: true };
    // N-16：落点落在书库 / 本书目录里会覆盖章节正文，直接软错误拒绝（不读正文、不写盘）。
    assertExportTargetOutsideLibrary(filePath, prepared.cfg, bookPath);
    // 审计 #7：落点确认之后才读正文（取消 / 改主意都不会白读）。B1 起改成逐章读。
    // 简繁转换：书名 / 卷名 / 章名 / 模板 / 正文都换成导出用的副本，目录和正文才一致；
    // 书目与章节 txt 一概不动（chars 仍按原稿字数算）。
    const conversion = s2tLib.normalizeMode(cfg.exportConversion);
    const exportMeta = s2tLib.convertMeta(meta, conversion);
    // X-N11（WP18）：EPUB 的固定文案（目录页大标题 / OPF guide 的「封面」「目录」）也随档位转换；
    // 否则繁体导出的书名 / 目录条目 / 正文都转繁，唯目录页大标题仍「目录」。DOCX / TXT 没有这些
    // 固定文案，多传一个 labels 字段不会影响它们（core/epub 缺省回简体）。
    const labels = conversion
      ? {
          nav: s2tLib.convertText('目录', conversion),
          cover: s2tLib.convertText('封面', conversion),
          toc: s2tLib.convertText('目录', conversion)
        }
      : null;
    const overrideIndex = exporter.chapterIndexOf(meta, prepared.override);
    const includedUnsaved = overrideIndex >= 0 && prepared.plan.indexes.includes(overrideIndex);
    let chars = 0;
    // TC-4（五-L6）：streamZip 在 document.xml「deflate 后不更小」时会第二次调用 chunks 工厂
    // （store 兜底），readText 随工厂重跑一遍 —— chars 不能跟着再累加一次（旧实现回包字数翻倍）。
    // 按章 index 记账：同一章无论工厂被调用几遍，只计一次原稿字数。
    const countedChapters = new Set();
    let built = null;
    // 五-M33（IE-02）：EPUB / DOCX 同样在逐章读盘期间登记在途租约，finally 释放
    const releaseLease = beginReadLease(bookPath);
    try {
      await atomicWriteFileStream(filePath, async (write) => {
        built = await options.stream(
          {
            meta: exportMeta,
            range: safeRange,
            labels,
            // 每章只读一次：override 章用编辑区最新内容（不写盘），其余读磁盘；chars 按原始正文计。
            readText: async (index, chapter) => {
              const text =
                index === overrideIndex
                  ? prepared.override.text
                  : (await storage.loadChapterText(bookPath, chapter.file)).text;
              if (!countedChapters.has(index)) {
                countedChapters.add(index);
                chars += chaptersLib.countChars(text);
              }
              return conversion ? s2tLib.convertText(text, conversion) : text;
            }
          },
          write
        );
      });
    } finally {
      releaseLease();
    }
    await rememberExportDir(path.dirname(filePath));
    return archiveExportResult(filePath, built, chars, includedUnsaved, conversion, prepared.plan);
  }

  handleBook('book:export', async (bookPath, override, range) => {
    const prepared = await prepareExport(bookPath, override, range);
    const { meta, plan, defaultDir, range: safeRange } = prepared;
    // 文件名默认带上范围：书名.txt / 书名-卷名.txt / 书名-第X-Y章.txt（可在保存对话框里改）
    const defaultName = exporter.exportFileName(meta, safeRange);
    const { canceled, filePath } = await showSaveDialog({
      title: '导出 TXT',
      defaultPath: path.join(defaultDir, defaultName),
      filters: [{ name: '文本文件', extensions: ['txt'] }]
    });
    if (canceled || !filePath) return { canceled: true };
    // N-16：与 EPUB / DOCX 同一道闸门 —— 不许把导出的整本内容写回书库、覆盖章节 txt。
    assertExportTargetOutsideLibrary(filePath, prepared.cfg, bookPath);
    // 审计 #7：落点确认之后才读整本正文（取消 / 改主意都不会白读）。
    // B5（v1.8.0 WP-28）：TXT 改流式写盘，边读边拼边写，不物化整本 texts / 整本串 / 整本 Buffer。
    const { chars, includedUnsaved, conversion } = await writeTxtExport(filePath, bookPath, prepared);
    // 记住这次导出的目录，下次导出默认还开在这里（记不住也不影响导出结果）
    await rememberExportDir(path.dirname(filePath));
    return {
      canceled: false,
      filePath,
      chapterCount: plan.count,
      chars,
      includedUnsaved,
      rangeLabel: plan.label,
      conversion
    };
  }, READ_ONLY);

  // 导出 EPUB（提案 6.3 / v0.8 P0 N8）：整本或按卷 / 按章节范围 → 一本 EPUB 3
  // （分卷做目录级、一章一个 XHTML、没有封面图就生成纯文字封面页）。排版沿用「段首缩进 + 空一行」，
  // 由 EPUB 里的 CSS 控制，不动任何 txt 字节。和 TXT 导出一样：当前章未保存的内容参与拼接、只读、原子写盘。
  // range 不传 = 全书；只把选中的章节读出来打进包里。范围输入按全书顺序算；章标题走
  // chapters.formatTitle，按这本书的编号方式（按卷编号的书是各卷自己的卷内号）。
  handleBook('book:export-epub', async (bookPath, override, range) =>
    exportStructured(bookPath, override, range, {
      title: '导出 EPUB',
      filters: [{ name: 'EPUB 电子书', extensions: ['epub'] }],
      defaultName: (prepared) => epubLib.epubFileName(prepared.meta, prepared.range),
      stream: (input, write) => epubLib.streamEpub(input, write)
    }), READ_ONLY);

  // 导出 DOCX（v0.8 P0 N9）：整本或按卷 / 按章节范围 → 一份 Word 能直接打开的书稿。
  // 和 EPUB 导出同一套规则：范围解析复用 exporter.resolveExportRange，只读选中的章，
  // 章标题走 chapters.formatTitle（范围按全书顺序，标题按书的编号方式）；当前章未保存内容参与、只读、原子写盘、简繁转换只作用于副本。
  handleBook('book:export-docx', async (bookPath, override, range) =>
    exportStructured(bookPath, override, range, {
      title: '导出 DOCX',
      filters: [{ name: 'Word 文档', extensions: ['docx'] }],
      defaultName: (prepared) => docxLib.docxFileName(prepared.meta, prepared.range),
      stream: (input, write) => docxLib.streamDocx(input, write)
    }), READ_ONLY);

  handleBook('book:copy', async (bookPath, override, indexes) => {
    const meta = await storage.readBookMeta(bookPath);
    const safeOverride = ipcLimits.sanitizeOverride(override);
    // 1.5.0 功能-1：可选第三参数 = 只复制这些章（章节多选「复制选中章」）。
    // 没传 = 整本复制，行为与 1.4.0 逐字节一致；传了空数组 = 什么都不写（不拿空数组当整本）。
    const selected = ipcLimits.sanitizeChapterIndexes(indexes, { total: meta.chapters.length });
    if (selected && !selected.length) {
      return { chapterCount: 0, chars: 0, includedUnsaved: false, empty: true };
    }
    // 五-M33（IE-02）：整本 / 选中章复制同样逐章读盘 —— 复制途中删书会让剪贴板只拿到半本书
    const releaseLease = beginReadLease(bookPath);
    let collected;
    try {
      // N-12：逐块拼装（读一章 → 拼一块 → 丢正文），不再先物化整本 texts 数组
      collected = await collectCopyBlocks(bookPath, meta, safeOverride, selected);
    } finally {
      releaseLease();
    }
    const { text, chars, chapterCount, includedUnsaved } = collected;
    await getClipboard().writeText(text);
    return { chapterCount, chars, includedUnsaved };
  }, READ_ONLY);

  // 复制本章（平台格式）：只取这一章的正文，段首缩进两个全角空格、段间空一行（空行也带缩进），
  // 直接进剪贴板；不写盘。ref = { chapterId?, chapterFile?, text? }：
  // 带了 text 就用它（编辑区里当前章未保存的最新内容，沿用户导出惯例），没带就读磁盘。
  handleBook('chapter:copy-platform', async (bookPath, ref) => {
    // P1（三审）：复制本章也是「救稿出口」的一条 —— 编辑区里那一章可能超过保存上限
    // （老版本 raw 导入的书 / 外部换进来的大章），复制正文不该被 500 万字挡住；
    // 上限与「能打开」同口径（core/limits.js 的 MAX_CHAPTER_RESCUE_CHARS）。
    const safeRef = ipcLimits.sanitizeOverride(ref, { maxText: ipcLimits.MAX_CHAPTER_RESCUE_CHARS });
    const meta = await storage.readBookMeta(bookPath);
    const index = exporter.chapterRefIndex(meta, safeRef);
    if (index < 0) throw new storage.StorageError('CHAPTER_NOT_FOUND', '找不到这一章（可能刚被删除）');
    const chapter = meta.chapters[index];
    const fromEditor = Boolean(safeRef && typeof safeRef.text === 'string');
    const text = fromEditor
      ? safeRef.text
      : (await storage.loadChapterText(bookPath, chapter.file)).text;
    const result = exporter.platformChapterText(text);
    const title = chaptersLib.formatTitle(meta, index, chapter.name);
    if (result.empty) {
      // 空章不覆盖剪贴板：免得把作者刚复制的东西冲掉
      return { empty: true, title, paragraphs: 0, chars: 0, includedUnsaved: fromEditor };
    }
    await getClipboard().writeText(result.text);
    return {
      empty: false,
      title,
      paragraphs: result.paragraphs,
      chars: result.chars,
      includedUnsaved: fromEditor
    };
  }, READ_ONLY);

  // 审计修复 #6（V302）：保存被 BOOK_MISSING / CHAPTER_MISSING 阻断时的救稿出口。
  // 书文件夹 / 章节文件可能已经在应用外被删 / 移走 —— 这条通道因此**完全不碰书库**：正文由渲染层
  // 从编辑区现取（text），这里只负责选落点并原子写盘（mode='save'），或写进系统剪贴板（mode='copy'）。
  // P1（三审）：正文上限改走 core/limits.js 的 MAX_CHAPTER_RESCUE_CHARS（= 单章载入上限，比保存上限宽）——
  // 老版本 raw 导入的超 500 万字章「能打开但存不回去」，这条通道就是唯一的应用内出口；
  // 上限仍保留（防止渲染层把无穷字符串塞进保存对话框 / 剪贴板），错误码仍是 TEXT_TOO_LARGE。
  // 文件名只作默认值，主进程用 chaptersLib.safeName 清洗后再拼进保存对话框，用户可以在对话框里改成任何路径。
  // 写出的 txt 与章节文件同格式（UTF-8 无 BOM、CRLF 换行），落点确认之后才写盘（与三个导出同一时序）。
  handle('chapter:rescue', async (text, mode, suggestedName) => {
    const body = ipcLimits.assertText(text, {
      max: ipcLimits.MAX_CHAPTER_RESCUE_CHARS,
      label: '救稿正文'
    });
    if (mode === 'copy') {
      await getClipboard().writeText(body);
      return { copied: true, chars: chaptersLib.countChars(body) };
    }
    const cfg = await getConfig();
    // N-10：与导出同一份「异步 + 有界等待」的目录探测（救稿也可能在断开的网络盘上）。
    const defaultDir = await defaultExportDir(cfg);
    const { canceled, filePath } = await showSaveDialog({
      title: '另存这一章为 TXT',
      defaultPath: path.join(defaultDir, `${chaptersLib.safeName(suggestedName)}.txt`),
      filters: [{ name: '文本文件', extensions: ['txt'] }]
    });
    if (canceled || !filePath) return { canceled: true };
    // N-16：救稿本来就是「章节文件可能已经不在」时才用，更容易顺手存回书库；同样只许书库外。
    // 这条频道不拿 bookPath（书可能已缺失），按 booksRoot 判定即可覆盖所有章节 txt。
    assertExportTargetOutsideLibrary(filePath, cfg, '');
    await atomicWriteFile(filePath, chaptersLib.toDiskNewlines(body), 'utf8');
    // 记住这次落点，下次另存 / 导出默认还开在这里（记不住也不影响救稿结果）
    await rememberExportDir(path.dirname(filePath));
    return { canceled: false, filePath, chars: chaptersLib.countChars(body) };
  });
}

module.exports = { register: registerExportIpc };
