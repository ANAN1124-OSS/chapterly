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
  'app',
  'fsSync',
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
    path, app, fsSync, getConfig,
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
  async function collectExportTexts(bookPath, meta, override, indexes) {
    const selected = Array.isArray(indexes) ? new Set(indexes) : null;
    const overrideIndex = exporter.chapterIndexOf(meta, override);
    const chapters = meta.chapters;
    // B4（审计 P4）：选中章的正文并行读；texts 仍按书目下标填，顺序 / 空串占位完全不变
    const texts = new Array(chapters.length).fill('');
    let chars = 0;
    for (let start = 0; start < chapters.length; start += CHAPTER_BATCH_SIZE) {
      const batch = chapters.slice(start, start + CHAPTER_BATCH_SIZE);
      const loaded = await mapLimit(batch, CHAPTER_READ_CONCURRENCY, async (chapter, offset) => {
        const index = start + offset;
        if (selected && !selected.has(index)) return '';
        if (index === overrideIndex) return override.text;
        return (await storage.loadChapterText(bookPath, chapter.file)).text;
      });
      for (let offset = 0; offset < loaded.length; offset += 1) {
        texts[start + offset] = loaded[offset];
        chars += chaptersLib.countChars(loaded[offset]);
      }
    }
    return {
      texts,
      chars,
      includedUnsaved: overrideIndex >= 0 && (!selected || selected.has(overrideIndex))
    };
  }

  // 导出范围预览（只读）：对话框里实时显示「选中几章 / 多少字 / 默认文件名」。
  // 字数优先用书目里的 chars 缓存求和（审计 F3）；缓存缺失 / 坏值才读盘现算，
  // 编辑区里当前章的未保存内容（override）永远现算。正式导出仍读全文，不受这里影响。
  // v0.9 C-5：override / range 先过 core/ipc-limits.js——正文超过 500 万字报 TEXT_TOO_LARGE，
  // 坏形状按旧行为降级（override 当没有、range 当全书 / 越界收紧）。
  handleBook('book:export-plan', async (bookPath, override, range) => {
    const meta = await storage.readBookMeta(bookPath);
    const safeOverride = ipcLimits.sanitizeOverride(override);
    const safeRange = ipcLimits.sanitizeRange(range);
    const plan = exporter.resolveExportRange(meta, safeRange);
    const overrideIndex = exporter.chapterIndexOf(meta, safeOverride);
    let chars = 0;
    const needDisk = [];
    for (const index of plan.indexes) {
      if (index === overrideIndex) {
        chars += chaptersLib.countChars(safeOverride.text);
        continue;
      }
      const chapter = meta.chapters[index];
      const cached = exporter.cachedCharsOf(chapter);
      if (cached != null) {
        chars += cached;
        continue;
      }
      needDisk.push(index);
    }
    // B4（审计 P4）：缓存缺失的章并行读盘现算（顺序不影响求和；仍只读不写）
    if (needDisk.length) {
      const counted = await mapLimit(needDisk, CHAPTER_READ_CONCURRENCY, async (index) => {
        const text = (await storage.loadChapterText(bookPath, meta.chapters[index].file)).text;
        return chaptersLib.countChars(text);
      });
      for (const value of counted) chars += value;
    }
    return {
      mode: plan.mode,
      label: plan.label,
      chapterCount: plan.count,
      chars,
      from: plan.from,
      to: plan.to,
      volumeId: plan.volumeId,
      empty: plan.empty,
      fileName: exporter.exportFileName(meta, safeRange),
      epubFileName: epubLib.epubFileName(meta, safeRange),
      docxFileName: docxLib.docxFileName(meta, safeRange),
      includedUnsaved: overrideIndex >= 0 && plan.indexes.includes(overrideIndex)
    };
  });

  // 目录是否存在（导出默认目录兜底用）：读不到就当不存在
  function isDirectory(dir) {
    try {
      return fsSync.statSync(dir).isDirectory();
    } catch {
      return false;
    }
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
    // 默认落到「上一次导出保存到的目录」；没记过、或那个目录已经不存在了，才退回「文档」
    const defaultDir = exporter.resolveExportDir(cfg.lastExportDir, app.getPath('documents'), isDirectory);
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
              chars += chaptersLib.countChars(text);
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
  });

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
    })
  );

  // 导出 DOCX（v0.8 P0 N9）：整本或按卷 / 按章节范围 → 一份 Word 能直接打开的书稿。
  // 和 EPUB 导出同一套规则：范围解析复用 exporter.resolveExportRange，只读选中的章，
  // 章标题走 chapters.formatTitle（范围按全书顺序，标题按书的编号方式）；当前章未保存内容参与、只读、原子写盘、简繁转换只作用于副本。
  handleBook('book:export-docx', async (bookPath, override, range) =>
    exportStructured(bookPath, override, range, {
      title: '导出 DOCX',
      filters: [{ name: 'Word 文档', extensions: ['docx'] }],
      defaultName: (prepared) => docxLib.docxFileName(prepared.meta, prepared.range),
      stream: (input, write) => docxLib.streamDocx(input, write)
    })
  );

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
      collected = await collectExportTexts(bookPath, meta, safeOverride, selected);
    } finally {
      releaseLease();
    }
    const { texts, chars, includedUnsaved } = collected;
    const text = selected ? exporter.composeSelected(meta, texts, selected) : exporter.composeBook(meta, texts);
    await getClipboard().writeText(text);
    return {
      chapterCount: selected ? selected.length : meta.chapters.length,
      chars,
      includedUnsaved
    };
  });

  // 复制本章（平台格式）：只取这一章的正文，段首缩进两个全角空格、段间空一行（空行也带缩进），
  // 直接进剪贴板；不写盘。ref = { chapterId?, chapterFile?, text? }：
  // 带了 text 就用它（编辑区里当前章未保存的最新内容，沿用户导出惯例），没带就读磁盘。
  handleBook('chapter:copy-platform', async (bookPath, ref) => {
    const safeRef = ipcLimits.sanitizeOverride(ref);
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
  });

  // 审计修复 #6（V302）：保存被 BOOK_MISSING / CHAPTER_MISSING 阻断时的救稿出口。
  // 书文件夹 / 章节文件可能已经在应用外被删 / 移走 —— 这条通道因此**完全不碰书库**：正文由渲染层
  // 从编辑区现取（text），这里只负责选落点并原子写盘（mode='save'），或写进系统剪贴板（mode='copy'）。
  // 正文仍走 core/ipc-limits.js 的 500 万字上限（与 chapter:save 同一条口径）；文件名只作默认值，
  // 主进程用 chaptersLib.safeName 清洗后再拼进保存对话框，用户可以在对话框里改成任何路径。
  // 写出的 txt 与章节文件同格式（UTF-8 无 BOM、CRLF 换行），落点确认之后才写盘（与三个导出同一时序）。
  handle('chapter:rescue', async (text, mode, suggestedName) => {
    const body = ipcLimits.assertText(text);
    if (mode === 'copy') {
      await getClipboard().writeText(body);
      return { copied: true, chars: chaptersLib.countChars(body) };
    }
    const cfg = await getConfig();
    const defaultDir = exporter.resolveExportDir(cfg.lastExportDir, app.getPath('documents'), isDirectory);
    const { canceled, filePath } = await showSaveDialog({
      title: '另存这一章为 TXT',
      defaultPath: path.join(defaultDir, `${chaptersLib.safeName(suggestedName)}.txt`),
      filters: [{ name: '文本文件', extensions: ['txt'] }]
    });
    if (canceled || !filePath) return { canceled: true };
    await atomicWriteFile(filePath, chaptersLib.toDiskNewlines(body), 'utf8');
    // 记住这次落点，下次另存 / 导出默认还开在这里（记不住也不影响救稿结果）
    await rememberExportDir(path.dirname(filePath));
    return { canceled: false, filePath, chars: chaptersLib.countChars(body) };
  });
}

module.exports = { register: registerExportIpc };
