/* 主进程 IPC 域模块：校对 / 敏感词预检（v1.8.0 WP-34 / D1 + V114，D-6 已定范围）。
 *
 * 搬走的段（原 main.js 的 registerIpc() 内，行号按搬前代码）：
 *   · 校对区（1687–1824）：proofreadWordlistInfoNow / pickWordListFile 两个同域助手 +
 *     text:proofread / proofread:words-info / proofread:pick-words / proofread:wordlists-add /
 *     proofread:wordlists-remove / sensitive:words-info / sensitive:pick-words / text:sensitive-check；
 *   · 整本检查区（2220–2407）：walkChapterTexts + book:proofread / book:sensitive-check。
 *
 * 只搬不改行为：词表路径仍然只认系统对话框（rememberPickedConfigPath 记账、config:set 再校验）、
 * 整本检查仍按 CHAPTER_BATCH_SIZE 批读 + CHAPTER_READ_CONCURRENCY 并发、回调仍按书目顺序、
 * 缺章跳过与 tooLarge / truncated 口径一字未改（B4 / WP-27）。
 *
 * 契约：register(host) —— host 成员逐条列在 REQUIRED_HOST 里；缺任何一个在 registerIpc() 装配时
 * 直接抛 TypeError（宁可在启动时炸，也不要到点频道才 ReferenceError）。host 成员都是 main.js 的
 * 函数 / 常量 / 活绑定，模块自己不 require electron、不缓存状态快照。
 *
 * 模块内仍保留原注释与缩进（只搬不改）：频道名 / 参数顺序 / 返回形状 / 文案 / 读盘与写盘顺序
 * 与搬运前逐字一致；依赖取值处只有两处被改成 getter —— 剪贴板句柄与配置仓库句柄都是可变绑定
 * （activeClipboard 由自检宿主替换、configStore 在 getConfig 里懒建），快照会过期。
 */
const { assertHost } = require('../core/assert-host');
// MAIN-01：本域 2 个 handleBook 都是只读（校对 / 敏感词预检只读正文与书目，全程不写盘），
// 显式传 READ_ONLY —— 不再靠「省略第三个参数」碰巧只读。
const { READ_ONLY } = require('./book-mutations');
// I7（三审）：软错误包络的唯一构造器（成功回包里的「这次没做成」统一成 { ok:false, code, message }）。
const { softFailure } = require('./soft-error');

const REQUIRED_HOST = [
  'handle',
  'handleBook',
  'storage',
  'exporter',
  'proofreadLib',
  'glossaryLib',
  'sensitiveLib',
  'ipcLimits',
  'assertText',
  'mapLimit',
  'CHAPTER_READ_CONCURRENCY',
  'CHAPTER_BATCH_SIZE',
  'WORDLIST_MAX',
  'path',
  'fs',
  'pathUtils',
  'getConfig',
  'getConfigStore',
  'applyConfig',
  'showOpenDialog',
  'rememberPickedConfigPath'
];

function registerProofreadIpc(host) {
  assertHost('ipc/proofread.registerProofreadIpc', host, REQUIRED_HOST);
  const {
    handle, handleBook, storage, exporter,
    proofreadLib, glossaryLib, sensitiveLib, ipcLimits,
    assertText, mapLimit, CHAPTER_READ_CONCURRENCY, CHAPTER_BATCH_SIZE,
    WORDLIST_MAX, path, fs, pathUtils,
    getConfig, getConfigStore, applyConfig, showOpenDialog,
    rememberPickedConfigPath
  } = host;

  // 校对（提案 5.1 / N6）：只报告、不改动。当前章正文由渲染层传上来（和查找一样，不读盘）；
  // 整本版走 book:proofread，逐章只读磁盘。index 是归一 CRLF 后的字符位置，可直接选中。
  // 校对词表（1.7.0 F3b2，可选）：配置里可以有多份（proofreadWordlists），空数组回落旧的单份路径。
  // 1.7.2 D2（V60）：配置口径 / 读取 / 合并 / 公开信息 / enabledLists 过滤全部在 core/glossary.js
  // （纯逻辑，可单测），主进程只保留接线；行为与搬前逐字一致——多份为空回落单份、公开信息永远
  // 描述全部词表、enabledLists 只影响参与校对。
  async function proofreadWordlistInfoNow() {
    const cfg = await getConfig();
    const paths = glossaryLib.proofreadWordlistPaths(cfg);
    return glossaryLib.proofreadWordListInfo(await glossaryLib.readGlossaryFiles(paths), paths);
  }

  handle('text:proofread', async (text, options) => {
    assertText(text);
    const cfg = await getConfig();
    // 1.7.2 D2（V44/V46）：词表一次读完（勾选子集在 core 里内存过滤），读取出口的词条已清洗，
    // 给 proofreadText 带上「已清洗」标记，同一份词表不再 sanitize 第二遍；旧调用方不受影响。
    const words = await glossaryLib.readProofreadWordlistForRequest(cfg, options);
    // 审计修复 #47（E22）：单章校对的 options 与整本版走同一套 core 清洗（阈值夹紧 + 规则开关
    // 补齐默认值），不再把渲染层传来的任意键 / 任意类型原样透传给 proofreadText。
    const proofOptions = {
      ...proofreadLib.sanitizeOptions(options),
      rules: proofreadLib.sanitizeRules(options && options.rules),
      entriesSanitized: true
    };
    const result = proofreadLib.proofreadText(text, proofOptions, words.entries);
    return { ...result, wordList: words.wordList };
  });

  // 校对词表状态（只读，1.7.0 F3b2）：多份 lists + total，单份补齐旧字段；绝不带路径与词表正文
  // 1.7.1 P6（V52）：多份事实只看配置里的 proofreadWordlists（哪怕只 1 份），渲染层不再靠 lists.length 猜；
  // multi 是新增的可选布尔，其余字段一个不动，旧单份用户恒为 false（行为不变）。
  // 1.7.2 D2（V46）：复用 readProofreadWordlistForRequest 这一个出口，不再单独多读一遍。
  handle('proofread:words-info', async () => {
    const cfg = await getConfig();
    const words = await glossaryLib.readProofreadWordlistForRequest(cfg);
    return { ...words.wordList, multi: glossaryLib.hasProofreadWordlists(cfg) };
  });

  // 选词表（校对 / 敏感词共用）：只允许通过系统文件对话框选，渲染层不能自己指定路径去读任意文件。
  // read 负责把选中的文件解析成「公开信息」（只含数量 / 提示，绝不含词表正文）。
  // field：这个对话框选出来的路径属于配置里的哪一项（v0.9 C-2b 的来源校验靠它记账——
  // 设置里点「选择…」→ 主进程记下这次选中的文件 → config:set 才允许写进配置）。
  async function pickWordListFile({ title, read, field }) {
    const { canceled, filePaths } = await showOpenDialog({
      title,
      buttonLabel: '使用这个词表',
      properties: ['openFile'],
      filters: [
        { name: '文本文件', extensions: ['txt'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (canceled || !filePaths || !filePaths.length) return { canceled: true };
    rememberPickedConfigPath(field, filePaths[0]);
    return { canceled: false, ...(await read(filePaths[0])) };
  }

  // 选校对词表：只允许通过系统对话框选（渲染层不能自己指定路径去读任意文件）
  handle('proofread:pick-words', async () => {
    return pickWordListFile({
      title: '选择校对词表（每行一个词，可写「错词 → 建议」）',
      field: 'proofreadWordsPath',
      read: async (filePath) => glossaryLib.publicGlossaryInfo(await glossaryLib.readGlossaryFile(filePath))
    });
  });
  // 多份校对词表（1.7.0 F3b2）：添加只允许通过系统对话框挑文件（渲染层给不了路径），
  // 移除只收索引 + 点击时看到的份数（五-M12 身份核对：份数对不上说明列表已变，拒绝而不按错位索引删）。
  // 渲染层既不能指定路径，也拿不到路径；落盘走配置仓库，
  // 配置清洗会再兜一遍绝对路径 / 去重 / WORDLIST_MAX 条上限（托底，不靠这一层）。
  // 1.7.2 D4（V42）：条数上限与提示文案都取 core/config.js 的 WORDLIST_MAX，这里不再声明同名常量。
  // 1.7.2 D4（V53）：先校验（stat / 重复 / 上限）再读词表；picked 是 path.resolve 的结果、恒为绝对
  // 路径，原来那条 path.isAbsolute 死分支已删。拒绝分支仍回最新 info（渲染层据此重画列表），
  // 但读取都发生在校验之后，不再先把全部词表读一遍才发现路径不能用。
  handle('proofread:wordlists-add', async () => {
    const { canceled, filePaths } = await showOpenDialog({
      title: '添加校对词表（每行一个词，可写「错词 → 建议」）',
      buttonLabel: '添加这份词表',
      properties: ['openFile'],
      filters: [
        { name: '文本文件', extensions: ['txt'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (canceled || !filePaths || !filePaths.length) return { canceled: true };
    const picked = path.resolve(filePaths[0]);
    const cfg = await getConfig();
    const current = Array.isArray(cfg.proofreadWordlists) ? cfg.proofreadWordlists.slice() : [];
    const stat = await fs.stat(picked).catch(() => null);
    if (!stat || !stat.isFile()) {
      return { ...softFailure('WORDLIST_MISSING', '这个词表文件不存在（可能被移动或删除了）'), canceled: false, added: false, ...(await proofreadWordlistInfoNow()) };
    }
    if (current.some((item) => pathUtils.pathKey(item) === pathUtils.pathKey(picked))) {
      return { ...softFailure('WORDLIST_DUPLICATE', '这份词表已经在列表里了'), canceled: false, added: false, ...(await proofreadWordlistInfoNow()) };
    }
    if (current.length >= WORDLIST_MAX) {
      return { ...softFailure('WORDLIST_LIMIT', `最多 ${WORDLIST_MAX} 份校对词表`), canceled: false, added: false, ...(await proofreadWordlistInfoNow()) };
    }
    const next = await getConfigStore().set({ proofreadWordlists: [...current, picked] });
    applyConfig(next);
    return { canceled: false, added: true, ...(await proofreadWordlistInfoNow()) };
  });

  handle('proofread:wordlists-remove', async (index, expectedCount) => {
    const cfg = await getConfig();
    const current = Array.isArray(cfg.proofreadWordlists) ? cfg.proofreadWordlists.slice() : [];
    // 审计修复 #12（E8）：判型先要求 number —— Number(null / '' / false / []) 全是 0，会通过下面的
    // 整数与边界检查，把「没带索引」的坏调用当成「删第 0 份」，静默删掉作者的第一份词表。
    // 非 number 一律记 -1（走同一条 WORDLIST_NOT_FOUND，不新增错误码，界面文案不变）。
    const at = typeof index === 'number' && Number.isInteger(index) ? index : -1;
    if (at < 0 || at >= current.length) {
      return { ...softFailure('WORDLIST_NOT_FOUND', '这一份词表不在列表里，可能已经被移除了'), canceled: false, removed: false, ...(await proofreadWordlistInfoNow()) };
    }
    // 五-M12（PR-02）：索引只是渲染时看到的列表位置。两次移除交叠（快速连点 / 双窗口）时配置已经
    // 前移，仅判边界会删到下一份。渲染层把「点击时看到的份数」一起发来；对不上就明确拒绝并回最新
    // 列表（渲染层据此重画），绝不再按错位索引 splice。旧调用不带份数时保持既有行为。
    if (Number.isInteger(expectedCount) && expectedCount >= 0 && expectedCount !== current.length) {
      return { ...softFailure('WORDLIST_CHANGED', '词表列表已经变了（可能在另一个窗口改过），请确认后再移除'), canceled: false, removed: false, ...(await proofreadWordlistInfoNow()) };
    }
    current.splice(at, 1);
    const next = await getConfigStore().set({ proofreadWordlists: current });
    applyConfig(next);
    return { canceled: false, removed: true, ...(await proofreadWordlistInfoNow()) };
  });

  // 敏感词预检（提案 5.2）：词表完全由作者管理，应用不内置任何词表。
  // 词表路径存在 config 里（渲染层不传路径）；这里只读词表、只报告命中，绝不改正文、不写盘。
  // 渲染层也拿不到词表内容——只回数量与状态（publicWordListInfo 会剥掉 words）。
  handle('sensitive:words-info', async () => {
    const cfg = await getConfig();
    return sensitiveLib.publicWordListInfo(await sensitiveLib.readWordListFile(cfg.sensitiveWordsPath));
  });

  // 选敏感词表：只允许通过系统对话框选（渲染层不能自己指定路径去读任意文件）
  handle('sensitive:pick-words', async () => {
    return pickWordListFile({
      title: '选择敏感词表（每行一个词）',
      field: 'sensitiveWordsPath',
      read: async (filePath) => sensitiveLib.publicWordListInfo(await sensitiveLib.readWordListFile(filePath))
    });
  });

  handle('text:sensitive-check', async (text, options) => {
    assertText(text);
    const cfg = await getConfig();
    const list = await sensitiveLib.readWordListFile(cfg.sensitiveWordsPath);
    const wordList = sensitiveLib.publicWordListInfo(list);
    // I7（三审）：软错误统一成 { ok:false, code, message }（wordList 作为附加字段保留）。
    if (!list.ok) return softFailure(list.code, list.message, { wordList });
    // 审计修复 #47（E22）：单章预检也先过 core/sensitive.sanitizeOptions（maxIssues 夹紧），
    // 与整本版同一入口口径；scanText 内部还会再兜一次，不依赖调用方。
    const result = sensitiveLib.scanText(text, list.words, sensitiveLib.sanitizeOptions(options));
    return { ok: true, ...result, wordList };
  });

  // 整本检查（校对 / 敏感词）共用：逐章读正文；当前章用 override 的最新内容；
  // 缺文件的章节跳过并计数（不让整本检查失败）。只读，不写盘。
  // B4（审计 P4）：各章正文并行读（上限 CHAPTER_READ_CONCURRENCY），回调仍按书目顺序逐章触发，
  // 统计 / 顺序与串行版完全一致。
  // P2-2（1.5.0）：再按 CHAPTER_BATCH_SIZE 章一批读（批内仍限并发、批间串行）——一批的回调跑完，
  // 这批正文就可以回收，整本书的正文不再同时常驻。回调顺序 / 跳过计数与「一次读完再逐章」完全一致；
  // 读盘抛错仍然整本失败（整本检查只读，失败时上层不产出任何结果，不会留下半份统计）。
  async function walkChapterTexts(bookPath, meta, override, onChapter) {
    const overrideIndex = exporter.chapterIndexOf(meta, override);
    const chapters = meta.chapters;
    let skippedChapters = 0;
    for (let start = 0; start < chapters.length; start += CHAPTER_BATCH_SIZE) {
      const batch = chapters.slice(start, start + CHAPTER_BATCH_SIZE);
      const loaded = await mapLimit(batch, CHAPTER_READ_CONCURRENCY, async (chapter, offset) => {
        const index = start + offset;
        if (index === overrideIndex) return { text: override.text };
        try {
          return { text: (await storage.loadChapterText(bookPath, chapter.file)).text };
        } catch (err) {
          if (err.code === 'CHAPTER_MISSING') {
            // I4（三审）：缺一章并跳过是既有语义（书里本来就没有这一章的 txt）；但**整本书都不在了**
            // 不是「跳过一章」—— 旧实现把删书后的全部 ENOENT 记成 skipped，面板拿到「完成、0 命中、
            // N 章跳过」的失真完成态。书文件夹没了就整体失败，由面板如实报错。
            if (!(await storage.exists(bookPath))) {
              throw new storage.StorageError(
                'BOOK_GONE',
                '这本书的文件夹已经不在了（可能刚被删除或移走），这次整本检查已中止'
              );
            }
            return { missing: true };
          }
          throw err;
        }
      });
      for (let offset = 0; offset < loaded.length; offset += 1) {
        const item = loaded[offset];
        if (item.missing) {
          skippedChapters += 1;
          continue;
        }
        onChapter(item.text, chapters[start + offset], start + offset);
      }
    }
    return skippedChapters;
  }

  // 校对整本（提案 5.1）：逐章只读正文，按 core/proofread.js 的规则列出可疑位置；
  // 全程不写盘。当前章未保存的内容用 override 传进来（和导出同一个惯例：只参与这一次检查）。
  // 每章最多保留 maxIssues 条明细，整本明细上限 1500 条，但总数 / 各规则条数照实统计。
  // I4（三审·低）：整本检查是「逐章读盘」的只读长流程，与三导出 / 整本复制同一份在途租约：
  // 期间同窗口「回书架 → 删同书」会被 storage.assertBookNotBusy(action=delete) 拒 READ_LEASE_BUSY，
  // 不再出现「删书后读到一半、面板给出 0 命中 + N 章跳过」的失真完成态。成功 / 失败都在 finally 释放。
  handleBook('book:proofread', async (bookPath, options, override) => {
    const releaseLease = storage.beginReadLease(bookPath);
    try {
      const meta = await storage.readBookMeta(bookPath);
      // v0.9 C-5：当前章未保存内容（override）先过边界（坏形状当没有；正文超 500 万字拒绝）
      const safeOverride = ipcLimits.sanitizeOverride(override);
      const limits = proofreadLib.sanitizeOptions(options);
      // 1.5.0：规则开关（只在这份请求里生效，不落配置）。sanitizeOptions 只管阈值，
      // 把清洗后的 rules 拼回去，整本每章用同一份开关。
      const bookRules = proofreadLib.sanitizeRules(options && options.rules);
      // 1.7.2 D2（V44）：整本每章共用同一份已清洗词条，proofreadText 不再逐章 sanitize。
      const chapterOptions = { ...limits, rules: bookRules, entriesSanitized: true };
      // 校对词表只读一次，整本每章共用（没设置 / 读不了 = 只跑内置规则，面板会提示）
      // 1.7.0 F3b2：多份词表合并读取；options.enabledLists 只让勾选的那几份参与（缺省全开）。
      // 1.7.2 D2（V46）：一次读完配置里的全部词表，勾选子集在 core 里内存过滤。
      const cfg = await getConfig();
      const words = await glossaryLib.readProofreadWordlistForRequest(cfg, options);
      const wordList = words.wordList;
      const customEntries = words.entries;
      const BOOK_ISSUE_LIMIT = 1500;
      const byRule = {};
      for (const rule of proofreadLib.RULE_ORDER) byRule[rule] = 0;
      const chapters = [];
      const issues = [];
      let total = 0;
      let truncated = false;
      // B4（v1.8.0 WP-27）：某一章正文超过校对规模闸（core/proofread.js 的 MAX_SOURCE_CHARS）时，
      // 该章只扫了前缀；整本回包要把「有章节没查全」如实带给面板，不能只说「总数照实统计」。
      let tooLarge = false;
      // P-08（1.6.0 A5）：明细预算（1500 条）用完后，后面的章只需要条数 / 各规则计数——
      // 传 snippets:false 就不再为每条命中拼上下文片段（那些明细反正会被丢掉）。
      let snippetsWanted = true;
      // B5（审计 #14）：预算用尽后每章的单章明细额度也降到下限（core 的唯一事实源）——
      // snippets:false 只省了片段，旧实现仍按默认 maxIssues 为每条规则建 issue 对象再整批丢弃；
      // 降到下限后每章只建「规则数 × 下限」个对象（多出来的只计数）。
      const chapterIssueFloor = proofreadLib.OPTION_LIMITS.maxIssues[0];
      const skippedChapters = await walkChapterTexts(bookPath, meta, safeOverride, (text, chapter, index) => {
        const result = proofreadLib.proofreadText(
          text,
          snippetsWanted ? chapterOptions : { ...chapterOptions, snippets: false, maxIssues: chapterIssueFloor },
          customEntries
        );
        total += result.total;
        for (const rule of proofreadLib.RULE_ORDER) byRule[rule] += result.byRule[rule] || 0;
        if (result.total) {
          chapters.push({
            chapterId: chapter.id,
            chapterIndex: index,
            name: chapter.name,
            total: result.total,
            byRule: result.byRule,
            truncated: result.truncated
          });
        }
        if (result.truncated) truncated = true;
        if (result.tooLarge) tooLarge = true;
        for (const issue of result.issues) {
          if (issues.length >= BOOK_ISSUE_LIMIT) {
            truncated = true;
            break;
          }
          issues.push({
            ...issue,
            chapterId: chapter.id,
            chapterIndex: index,
            chapterName: chapter.name
          });
        }
        if (issues.length >= BOOK_ISSUE_LIMIT) snippetsWanted = false;
      });
      return {
        scope: 'book',
        total,
        byRule,
        issues,
        chapters,
        chapterCount: meta.chapters.length,
        // 有问题的章数（chapters 只收有问题的章）
        chapterHitCount: chapters.length,
        skippedChapters,
        truncated: truncated || total > issues.length,
        // B4（WP-27）：有章节超出校对规模闸（只扫了前缀）→ 面板说明「只校对了前 100 万字」
        tooLarge,
        wordList,
        customWordCount: customEntries.length,
        options: limits
      };
    } finally {
      releaseLease();
    }
  }, READ_ONLY);

  // 敏感词预检整本（提案 5.2）：逐章只读磁盘，按作者词表列出命中；全程不写盘。
  // 当前章未保存的内容用 override 传进来（只参与这一次检查，和导出 / 校对同一个惯例）。
  // 每章明细上限由 core/sensitive.js 的 maxIssues 控制，整本明细上限 1500 条，但总数照实统计。
  // I4（三审·低）：与 book:proofread 同一份在途租约 —— 校对 / 敏感词都是逐章读整本的长流程，
  // 期间「回书架 → 删同书」必须被 book:delete 的 READ_LEASE_BUSY 闸门拦下。
  handleBook('book:sensitive-check', async (bookPath, options, override) => {
    const releaseLease = storage.beginReadLease(bookPath);
    try {
      const cfg = await getConfig();
      const list = await sensitiveLib.readWordListFile(cfg.sensitiveWordsPath);
      const wordList = sensitiveLib.publicWordListInfo(list);
      // I7（三审）：软错误统一成 { ok:false, code, message }（wordList 作为附加字段保留）。
      if (!list.ok) return softFailure(list.code, list.message, { wordList });
      const meta = await storage.readBookMeta(bookPath);
      // v0.9 C-5：override 与上面校对同一条边界（坏形状当没有；正文超 500 万字拒绝）
      const safeOverride = ipcLimits.sanitizeOverride(override);
      const limits = sensitiveLib.sanitizeOptions(options);
      const matches = [];
      const chapters = [];
      const byWordMap = new Map();
      let total = 0;
      let truncated = false;
      // B5（审计 #14）：整本明细预算（1500 条）用完后，后面的章只需要 total / byWord ——
      // scanText 走 details:false（不建明细 / 不算行号 / 不拼片段），计数口径完全不变。
      let detailsWanted = true;
      const skippedChapters = await walkChapterTexts(bookPath, meta, safeOverride, (text, chapter, index) => {
        // CTXT-B-01：list.words 是 parseWordList 已清洗过的词表，整本循环里只该洗一次。
        const result = sensitiveLib.scanText(
          text,
          list.words,
          detailsWanted ? { ...limits, wordsSanitized: true } : { ...limits, details: false, wordsSanitized: true }
        );
        total += result.total;
        for (const item of result.byWord) {
          byWordMap.set(item.word, (byWordMap.get(item.word) || 0) + item.count);
        }
        if (result.total) {
          chapters.push({
            chapterId: chapter.id,
            chapterIndex: index,
            name: chapter.name,
            total: result.total,
            truncated: result.truncated
          });
        }
        if (result.truncated) truncated = true;
        for (const match of result.issues) {
          if (matches.length >= sensitiveLib.BOOK_ISSUE_LIMIT) {
            truncated = true;
            break;
          }
          matches.push({
            ...match,
            chapterId: chapter.id,
            chapterIndex: index,
            chapterName: chapter.name
          });
        }
        if (matches.length >= sensitiveLib.BOOK_ISSUE_LIMIT) detailsWanted = false;
      });
      const byWord = Array.from(byWordMap, ([word, count]) => ({ word, count }))
        .sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0))
        .slice(0, sensitiveLib.BY_WORD_LIMIT);
      return {
        ok: true,
        scope: 'book',
        total,
        matches,
        byWord,
        wordHitCount: byWordMap.size,
        wordCount: list.words.length,
        chapters,
        chapterCount: meta.chapters.length,
        // 有命中的章数（chapters 只收有命中的章）
        chapterHitCount: chapters.length,
        skippedChapters,
        truncated: truncated || total > matches.length,
        wordList,
        options: limits
      };
    } finally {
      releaseLease();
    }
  }, READ_ONLY);
}

module.exports = { register: registerProofreadIpc };
