/* 主进程 IPC 域模块：书 / 章 / 卷 CRUD（v1.8.0 WP-34 / D1 + V114，D-6 已定范围）。
 *
 * 搬走的段（原 main.js 的 registerIpc() 内，行号按搬前代码）：
 *   · 书卡片区（1592–1679）：books:list / book:create / book:open / book:verify / book:rename /
 *     book:update-info / book:set-chapter-numbering / book:set-last / chapter:load / chapter:stat；
 *   · 章 / 卷结构区（2135–2204）：chapter:create / rename / update-meta / delete / restore-deleted /
 *     move、volume:create / rename / delete、chapter:move-to-volume / volume:move / chapter:move-to；
 *   · 书生命周期区（2774–2860）：book:repair / book:import / book:delete。
 *
 * 只搬不改行为：路径入口仍走 handleBook 的统一 assertBookPath（book:import 仍走
 * ipc-paths.importSourceDirs + automation 闸门）、跨窗口互斥 / 打开登记 / 书架广播顺序不变、
 * 撤销删除仍发一次性凭证（undoToken）、book:delete 仍优先回收站（E2E 走 trashBook）。
 *
 * 契约：register(host) —— host 成员逐条列在 REQUIRED_HOST 里；缺任何一个在 registerIpc() 装配时
 * 直接抛 TypeError（宁可在启动时炸，也不要到点频道才 ReferenceError）。host 成员都是 main.js 的
 * 函数 / 常量 / 活绑定，模块自己不 require electron、不缓存状态快照。
 *
 * 模块内仍保留原注释与缩进（只搬不改）：频道名 / 参数顺序 / 返回形状 / 文案 / 读盘与写盘顺序
 * 与搬运前逐字一致；依赖取值处只有两处被改成 getter —— 剪贴板句柄与配置仓库句柄都是可变绑定
 * （activeClipboard 由自检宿主替换、configStore 在 getConfig 里懒建），快照会过期。
 *
 * 审计修复 #38（▲V306）：mutation 改用 ipc/book-mutations.js 的域内常量表；只读频道显式传
 * READ_ONLY（以前靠省略第三个参数）。新增书域频道必须在 MUTATION.X / READ_ONLY 里二选一，
 * tests/book-data-ipc.test.js 会逐条核对（漏选 / 只读漏标都会红）。
 */
const { assertHost } = require('../core/assert-host');
const { MUTATION, READ_ONLY } = require('./book-mutations');

const REQUIRED_HOST = [
  'handle',
  'handleBook',
  'storage',
  'repair',
  'importer',
  'openBooksLib',
  'ipcLimits',
  'ipcPaths',
  'ipcRestoreToken',
  'restoreTokens',
  'errorText',
  'pathUtils',
  'fs',
  'path',
  'shell',
  'getConfig',
  // 五-L1（CI-2）：删书成功后按书目 id 清掉这本书的显示覆盖（config.json 的 bookDisplay）
  'getConfigStore',
  'flowSession',
  'sessionById',
  'focusSession',
  'flushLastOpenBeforeRead',
  'lastOpenWrites',
  'bookKeyOf',
  'rememberRecentBook',
  'notifyShelfChanged',
  'sendToFlow',
  'logError',
  // T-08（三次审查）：撤销删除会把章节正文放回书里，成功后必须标脏搜索索引（同 chapter:save 口径）。
  'getSearchIndexStore',
  'showOpenDialog',
  'automation',
  'isE2E'
];

function registerBookIpc(host) {
  assertHost('ipc/book.registerBookIpc', host, REQUIRED_HOST);
  const {
    handle, handleBook, storage, repair,
    importer, openBooksLib, ipcLimits, ipcPaths,
    ipcRestoreToken, restoreTokens, errorText, pathUtils,
    fs, path, shell, getConfig, getConfigStore,
    flowSession, sessionById, focusSession, flushLastOpenBeforeRead,
    lastOpenWrites, bookKeyOf, rememberRecentBook, notifyShelfChanged,
    sendToFlow, logError, showOpenDialog, automation,
    isE2E, getSearchIndexStore
  } = host;

  handle('books:list', async () => {
    // B3：书架列表要显示每本书的章节 / 字数，先把防抖中的「上次打开章节」落盘再读
    await flushLastOpenBeforeRead(null);
    const cfg = await getConfig();
    return storage.listBooks(cfg.booksRoot);
  });

  // B2（WP18 / 审计中 #18）：书架增量刷新 —— 别的窗口保存 / 改书目 / 改名后，`shelf:changed`
  // 会带上变更的 bookPath，停在书架的窗口只重读这一张卡（O(1)），不再整表逐书扫书目。
  // 只读频道：不写盘、不拿书锁、不广播（handleBook 的书名参数已经过 assertBookPath）。
  handleBook('books:card', async (bookPath) => storage.readBookCard(bookPath), READ_ONLY);

  handle('book:create', async (title) => {
    const cfg = await getConfig();
    await fs.mkdir(cfg.booksRoot, { recursive: true });
    const created = await storage.createBook(cfg.booksRoot, title);
    // B2（WP18）：带上新书路径 —— 其它窗口的书架只插这一张卡（多本导入才走整表）
    notifyShelfChanged(flowSession(), 'book:create', created.path);
    return created;
  });

  handleBook('book:open', async (bookPath) => {
    // RACE-01：打开流程从「落盘上次章节 → 读书目 → 登记打开」走完之前，删除闸门（main.js 的
    // handleBook 包装 → storage.assertBookNotBusy(action='delete')）只看见「没被任何窗口打开」，
    // 同窗口「回书架 → 删同书」撞进来会把正读着的书目录搬走；随后的 chapter:load 按文件名
    // 就会落到同名新建的书上。全程持只读租约：删除被拒 READ_LEASE_BUSY；finally 释放，
    // 成功 / 失败都不漏（登记成功的书此后由打开登记挡删除，租约只补这一段窗口）。
    const beginReadLease =
      typeof storage.beginReadLease === 'function' ? storage.beginReadLease : () => () => {};
    const releaseLease = beginReadLease(bookPath);
    try {
      const session = flowSession();
      // B3：读书目之前先把防抖中的「上次打开章节」落盘，保证重开书回到的是最后一次切到的章
      await flushLastOpenBeforeRead(bookPath);
      // 同一本书只允许一个窗口：已开在别处就聚焦那个窗口并拒绝
      const owner = storage.findOpenBookWindow(bookPath);
      if (owner && session && String(owner) !== String(session.id)) {
        focusSession(sessionById(owner));
        throw new storage.StorageError(
          openBooksLib.CODE.BOOK_OPEN_IN_OTHER_WINDOW,
          openBooksLib.openInOtherWindowMessage(bookPath)
        );
      }
      const data = await storage.openBook(bookPath, { skipStats: true });
      if (session) {
        const registered = storage.registerOpenBook(session.id, bookPath);
        if (!registered.ok) {
          focusSession(sessionById(registered.ownerWindowId));
          throw new storage.StorageError(registered.code, registered.message);
        }
      }
      // N-07：字数缓存回填挪到后台（同一本书单飞）—— 打开大书 / 老书时窗口先可用，
      // 不再先读完所有缺缓存章节的正文才返回；回填只补书目里的 chars，不顶 updatedAt。
      void storage.backfillBookStatsInBackground(bookPath);
      const meta = data && data.meta;
      if (meta && Array.isArray(meta.chapters) && meta.chapters.length) {
        let index = meta.chapters.findIndex((chapter) => chapter && chapter.id === meta.lastOpenChapterId);
        if (index < 0) index = 0;
        const chapter = meta.chapters[index];
        await rememberRecentBook(bookPath, {
          title: meta.title,
          chapterId: chapter.id,
          chapterIndex: index,
          chapterName: chapter.name
        });
      }
      return data;
    } finally {
      releaseLease();
    }
  }, READ_ONLY);
  handleBook('book:verify', async (bookPath) => storage.verifyBook(bookPath), READ_ONLY);
  handleBook('book:rename', async (bookPath, title) => {
    const meta = await storage.renameBook(bookPath, title);
    // N2（二轮·低）：限长的唯一入口在 storage（core/limits.js），这里只把「书名被截短」如实
    // 带回渲染层 —— 请求名非空、保存后的 title 与它不同就是超限截断。渲染层据此提示作者，
    // 不再静默改名。
    const requested = String(title == null ? '' : title).trim();
    return { ...meta, titleTruncated: Boolean(requested) && meta.title !== requested };
  }, {
    mutation: MUTATION.RENAME
  });
  // 书籍信息（v0.8-3）：作者 / 简介 / 分组 / 标签只写 书目.json 的可选字段，不动书文件夹 / 章节文件。
  handleBook('book:update-info', async (bookPath, patch) => storage.updateBookInfo(bookPath, patch), {
    mutation: MUTATION.WRITE
  });
  // 章号编号方式（2026-11-10）：全书连续 / 按卷独立，只写 书目.json 的可选字段。
  handleBook('book:set-chapter-numbering', async (bookPath, numbering) => storage.setChapterNumbering(bookPath, numbering), {
    mutation: MUTATION.WRITE
  });
  handleBook('book:set-last', async (bookPath, chapterId, info) => {
    // B3（审计 P3）：只记「最新一次」，1.5 秒内的连续切章合并成一次写盘（lastOpenWrites）。
    // 章节是否还存在 / 书是否被挪走留给落盘时校验（返回 { ok:false } 与旧行为一致，渲染层本来就不看）。
    const chapterIdText = String(chapterId == null ? '' : chapterId);
    lastOpenWrites.schedule(bookKeyOf(bookPath), {
      bookPath,
      chapterId: chapterIdText,
      at: Date.now()
    });
    // 「继续上次写作」的书架级记忆（config.json，很小）仍在切章当下就写：渲染层把章的显示信息
    // 一起传上来（不必为此再读一遍书目），迟到的记录有 rememberRecentBook 的顺序保护。
    // 审计修复 #47（E22）：info 的 title / chapterIndex / chapterName 在入口先判型限长
    // （core/ipc-limits.sanitizeRecentBookInfo）；坏形状 → null，不再把任意对象交给
    // rememberRecentBook 的 String / slice 兜底。
    const display = ipcLimits.sanitizeRecentBookInfo(info);
    // 审计残留修复 #R15（#47/E22）：章名 trim 后为空 / chapterId 为空 → 不记最近书。旧实现只判
    // typeof chapterName === 'string'，纯空白章名也会被记成一条空名最近书；空名对「继续上次写作」
    // 没有信息量，这里按「没有可用章名就不记」处理（与 sanitizeRecentBookInfo 的注释同一口径）。
    if (display && display.chapterName && chapterIdText) {
      await rememberRecentBook(bookPath, {
        title: display.title,
        chapterId: chapterIdText,
        chapterIndex: display.chapterIndex,
        chapterName: display.chapterName,
        at: Date.now()
      });
    }
    return { ok: true, queued: true, chapterId: chapterIdText };
  }, { mutation: MUTATION.SAVE });

  handleBook('chapter:load', async (bookPath, file) =>
    // WP1（E-N2）：{ track: true } 让主进程记下「编辑器载入这一版」的内容指纹（只存内存）——
    // 保存前用它发现 rsync -t / robocopy /COPY:DAT 这类保留时间戳的外部改写。
    storage.loadChapterText(bookPath, file, { track: true }), READ_ONLY
  );
  handleBook('chapter:stat', async (bookPath, file) =>
    storage.statChapter(bookPath, file), READ_ONLY
  );

  handleBook('chapter:create', async (bookPath, insertIndex, name, volumeId) =>
    storage.createChapter(bookPath, insertIndex, name, volumeId), { mutation: MUTATION.WRITE }
  );
  handleBook('chapter:rename', async (bookPath, chapterId, name) =>
    storage.renameChapter(bookPath, chapterId, name), { mutation: MUTATION.RENAME }
  );
  // 章节状态 / 备注：只改书目可选字段（txt 不动）
  handleBook('chapter:update-meta', async (bookPath, chapterId, patch) =>
    storage.updateChapterMeta(bookPath, chapterId, patch), { mutation: MUTATION.WRITE }
  );
  // 1.5.0 P0-5（审计 V-1）：删除成功后发一张进程内一次性凭证（crypto.randomUUID），
  // 只在内存 Map 里记 { bookPath, trashName, chapterId, expiresAt }（10 分钟，带上限与过期清理）。
  // 撤销时必须原样带回来 —— 只靠 trashName 的四道自证证明不了「这个备份是本次删除产生的」。
  // 返回形状只**扩展**一个 undoToken 字段：频道名 / preload 方法名 / 原有的 meta·trashPath·
  // newChapter·index 一个都不变。
  handleBook('chapter:delete', async (bookPath, chapterId) => {
    const result = await storage.deleteChapter(bookPath, chapterId);
    const trashName = result && result.trashPath ? path.basename(result.trashPath) : '';
    const undoToken = trashName
      ? restoreTokens.issue({ bookPath, trashName, chapterId })
      : '';
    return { ...result, undoToken };
  }, {
    mutation: MUTATION.DELETE
  });
  // 撤销删除（1.4.0 P0-2）：只把本书 _trash 下的那一个 txt 放回书文件夹，并按原位置插回书目。
  // 入参形状由 core/storage.js 的 restoreDeletedChapterFromTrash 自己校验（不信任渲染层给的路径）。
  // 1.5.0 P0-3（审计 E3 / O-8）：先过 core/ipc-limits.js 的白名单 —— 只留
  // trashName / index / chapter{id,file,name,createdAt,volumeId,status,note} / autoChapterFile，
  // 必填字段不合法直接抛 BAD_RESTORE（fail() 统一文案），一个字节都不会写盘；
  // 交给 storage 的必须是清洗后的 payload，不是原始参数。
  // 1.5.0 P0-5（审计 V-1）：白名单之后还要验撤销凭证（存在 / 未过期 / 同一本书 / 同一个 trashName），
  // 验过立刻作废（一次性）；storage 还原失败时把凭证放回去，作者还能原地再试一次。
  // 审计修复 #56（S4）：chapterId 也一起比对 —— 凭证发放时记的章节 id 与这次清洗后的 chapter.id
  // 必须一致，持合法凭证改 id 换不回别的章（对不上只拒绝，不烧凭证）。
  handleBook('chapter:restore-deleted', async (bookPath, payload) => {
    const clean = ipcLimits.sanitizeRestorePayload(payload);
    const rawToken =
      payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.undoToken : '';
    const claim = restoreTokens.take(rawToken, {
      bookPath,
      trashName: clean.trashName,
      chapterId: clean.chapter.id
    });
    if (!claim.ok) throw ipcRestoreToken.errorFor(claim.reason);
    try {
      const result = await storage.restoreDeletedChapterFromTrash(bookPath, clean);
      // T-08：撤销删除把正文放回书里——标脏搜索索引，否则 60 秒复用窗口里搜索还拿旧位图。
      // 与保存链同口径：标脏失败只留痕，不能把已经完成的还原报成失败。
      try {
        getSearchIndexStore().markDirty(bookPath);
      } catch (err) {
        logError('book', err, { level: 'warn', code: 'INDEX_DIRTY_FAILED' });
      }
      return result;
    } catch (err) {
      // 五-M31（IPC-01）：回滚也失败（唯一副本留在书文件夹、_trash 已无备份）时不要把凭证放回去 ——
      // 那种现场原地重试必然撞 RESTORE_MISSING / RESTORE_TARGET_EXISTS，给出与恢复指引矛盾的
      // 第二条错误。其余失败（占用 / 书目暂时写不进去）照旧放回，作者修好现场还能再撤一次。
      if (!(err && err.restoreOrphan)) restoreTokens.release(claim.record);
      throw err;
    }
  }, {
    mutation: MUTATION.WRITE
  });
  handleBook('chapter:move', async (bookPath, chapterId, toIndex) =>
    storage.moveChapter(bookPath, chapterId, toIndex), { mutation: MUTATION.WRITE }
  );
  // 分卷：新建 / 改名 / 删除（章节回未分卷，不删章）/ 把章移到别的卷
  handleBook('volume:create', async (bookPath, name) => storage.createVolume(bookPath, name), {
    mutation: MUTATION.WRITE
  });
  handleBook('volume:rename', async (bookPath, volumeId, name) =>
    storage.renameVolume(bookPath, volumeId, name), { mutation: MUTATION.WRITE }
  );
  handleBook('volume:delete', async (bookPath, volumeId) => storage.deleteVolume(bookPath, volumeId), {
    mutation: MUTATION.WRITE
  });
  handleBook('chapter:move-to-volume', async (bookPath, chapterId, volumeId) =>
    storage.moveChapterToVolume(bookPath, chapterId, volumeId), { mutation: MUTATION.WRITE }
  );
  handleBook('volume:move', async (bookPath, volumeId, toIndex) =>
    storage.moveVolume(bookPath, volumeId, toIndex), { mutation: MUTATION.WRITE }
  );
  handleBook('chapter:move-to', async (bookPath, chapterId, volumeId, beforeChapterId) =>
    storage.moveChapterTo(bookPath, chapterId, volumeId, beforeChapterId), { mutation: MUTATION.WRITE }
  );

  handleBook('book:repair', async (bookPath, mode) => {
    // io.logError：换书目「回退也失败」时走现有 logError 留一条诊断日志（core/repair.js，V78）；
    // 不新造第二套 logger —— 日志仍然只落在设置 → 诊断日志指向的那一份。
    if (mode === 'bak') return repair.restoreFromBak(bookPath, { logError });
    if (mode === 'rebuild') return repair.rebuildFromFiles(bookPath, { logError });
    throw new storage.StorageError('BAD_MODE', `未知的修复方式：${mode}`);
  }, { mutation: MUTATION.WRITE });

  handle('book:import', async (explicitPaths, options) => {
    // 路径入口（v0.9 C-2）：导入目录的唯一正当来源是下面这个系统对话框。
    // 渲染层如果自己传了目录，只有 automation（自检 / 截图）才认；生产环境一律拒（BAD_IMPORT_PATH），
    // 免得被注入的脚本让主进程把任意文件夹（桌面 / 别的盘 / D:\我的小说）复制进书架。
    let dirs = ipcPaths.importSourceDirs(explicitPaths, { allowExplicit: automation });
    const cfg = await getConfig();
    await fs.mkdir(cfg.booksRoot, { recursive: true });
    if (!dirs.length) {
      const { canceled, filePaths } = await showOpenDialog({
        title: '导入小说（选择一个或多个书文件夹）',
        buttonLabel: '导入',
        properties: ['openDirectory', 'multiSelections', 'dontAddToRecent']
      });
      if (canceled || !filePaths || !filePaths.length) {
        return { canceled: true, imported: [], skipped: [], failed: [] };
      }
      dirs = filePaths;
    }
    // 导入会往书库里写文件夹：目标正好是别的窗口正开着的书 → 拒绝（「导入覆盖」也要拦）。
    const session = flowSession();
    // 审计 WP7（X-N2）：预检按「最终撞名目标名」—— 导入会先 uniqueFolderName 解析真正的目标
    // （同名书已存在时自动 -2 / -3），旧实现却拿来源 basename 去查打开登记：既可能误拦
    // （目标是 -2，预检拦的是同名旧书），也会漏拦（-2 正被另一个窗口开着）。
    // 现在两处都查：最终目标名（新增的漏拦面）+ 来源 basename 目标（E2E 55 的既有拒绝行为不回退），
    // 同一个 key 去重。拒绝语义与旧实现一致：整次导入在复制开始前中止并抛 CROSS_WINDOW_BUSY。
    const guardImportTarget = async ({ sourceDir, path: finalTarget }) => {
      const candidates = [finalTarget];
      const sourceTarget = path.join(cfg.booksRoot, path.basename(path.resolve(String(sourceDir))));
      if (pathUtils.pathKey(sourceTarget) !== pathUtils.pathKey(finalTarget)) {
        candidates.push(sourceTarget);
      }
      const seen = new Set();
      for (const candidate of candidates) {
        const key = pathUtils.pathKey(candidate);
        if (seen.has(key)) continue;
        seen.add(key);
        const owner = storage.findOpenBookWindow(candidate);
        if (owner && (!session || String(owner) !== String(session.id))) {
          throw new storage.StorageError(
            'CROSS_WINDOW_BUSY',
            `导入目标「${path.basename(candidate)}」正在另一个窗口打开。请先关掉另一个窗口，或先切换到那个窗口后再导入。`
          );
        }
      }
    };
    const imported = await importer.importFolders(cfg.booksRoot, dirs, {
      mode: options && options.mode,
      guardTarget: guardImportTarget,
      onProgress: (progress) => {
        sendToFlow('import:progress', progress);
      }
    });
    notifyShelfChanged(session, 'book:import');
    return imported;
  });

  handleBook('book:delete', async (bookPath) => {
    const cfg = await getConfig();
    const root = path.resolve(cfg.booksRoot);
    const target = path.resolve(String(bookPath || ''));
    // A9（v1.8.0 WP-31）：「同一目录」判定统一走 core/path-utils.js 的 pathKey（不再手写小写比较）
    if (pathUtils.pathKey(path.dirname(target)) !== pathUtils.pathKey(root)) {
      throw new storage.StorageError('BAD_PATH', '只能删除书架目录下的书');
    }
    // 别的窗口正开着这本书：拒绝，绝不让它在另一个窗口里继续盯着被删的文件夹
    // 台账 #1（E-N7，WP18）：删除是写 mutation —— 「还在不在 / 是不是书 / 搬目录」必须在同一把
    // 书锁里，与同书的保存 / 改书目 / 改章互斥。旧实现只有 E2E 分支经 storage.trashBook 间接入锁，
    // 生产分支的 shell.trashItem 在锁外：保存写盘途中目录可能被搬走。
    // 审计修复 #4（S1）：是书架目录的直接子目录还不够，必须确认「目标是一本书」——
    // `_trash`（全部删书备份）/ `_碎片`（灵感箱）也是书架根的直接子目录，注入脚本以前能把它们
    // 整个丢进回收站。DATA-01：只拒真正的保留目录（_trash / _碎片 / . 开头的隐藏目录），
    // 不再一棍子拒掉所有 `_` 开头目录 —— 旧版本没有写侧闸门，_x 可能是作者的真书；下面
    // 「有 书目.json」的校验才是「是不是书」的判据。没有书目的普通文件夹一律拒绝。
    const folder = path.basename(target);
    if (storage.isReservedBookFolderName(folder)) {
      throw new storage.StorageError('BAD_PATH', '书架保留目录不能当书删除');
    }
    return storage.withBookLock(target, async () => {
      if (!(await storage.exists(target))) {
        throw new storage.StorageError('NOT_FOUND', '这本书的文件夹已经不存在了');
      }
      if (!(await storage.exists(path.join(target, storage.BOOK_FILE)))) {
        throw new storage.StorageError('NOT_A_BOOK', '这不是一本书（文件夹里没有 书目.json）');
      }
      // 五-L1（CI-2）：删书后这本书的按书显示覆盖（字体 / 纸色 / 字号…）已经没有归属，按书目
      // meta.id 一并清掉。id 读不出来（书目坏了）就当没有可清的条目 —— 删除语义不变。
      let displayBookId = '';
      try {
        const meta = await storage.readBookMeta(target);
        displayBookId = String((meta && meta.id) || '').trim();
      } catch {
        /* 坏书目没有可信 id：跳过显示覆盖清理，删除照常 */
      }
      let result;
      // 测试环境用固定兜底路径，避免把测试数据丢进你的回收站
      if (isE2E) {
        const trashPath = await storage.trashBook(cfg.booksRoot, target);
        result = { method: 'move', folder: path.basename(target), trashPath };
      } else {
        try {
          await shell.trashItem(target);
          result = { method: 'recycle', folder: path.basename(target) };
        } catch (err) {
          const trashPath = await storage.trashBook(cfg.booksRoot, target);
          result = {
            method: 'move',
            folder: path.basename(target),
            trashPath,
            note: `回收站不可用（${errorText.describeForUi(err).message}），已移到书架的 _trash`
          };
        }
      }
      // 删除成功：清掉可能存在的登记（自己的 / 残留的）；书架变动的广播由 handleBook 统一发
      storage.releaseOpenBookPath(target);
      // A4（审计 #11 / O3、P6）：这本书的锁条目（若有）也一并回收；在飞的链留到 settle 后自己回收。
      // 当前这条删除链正在跑（pending > 0），clearIdle 只清空闲条目，不会把正在跑的锁拆掉。
      storage.clearBookLock(target);
      // 五-L1（CI-2）：显示覆盖随书一起作废（config.json 不再随「曾经调过显示设置的书数」单调增长）。
      // 清不掉只留一条 warn：书已经删掉了，配置收尾失败不许把删除结果改判成失败。
      if (displayBookId) {
        const configStore = getConfigStore();
        try {
          await configStore.resetBookDisplay(displayBookId);
        } catch (err) {
          logError('book-delete', err, { level: 'warn', code: 'BOOK_DISPLAY_RESET_FAILED' });
        }
        // E2（一轮·低）：这本书的查找书签也一并清掉 —— 书签全局上限 200 条，旧实现只清
        // bookDisplay，已删的书签会继续占配额、出现在查找面板里点开必然失败。
        // 旧宿主 / 单测的假 store 没有这个方法时跳过（与 resetBookDisplay 同一套可选注入口径）。
        if (configStore && typeof configStore.resetFindBookmarksForBook === 'function') {
          try {
            await configStore.resetFindBookmarksForBook(displayBookId);
          } catch (err) {
            logError('book-delete', err, { level: 'warn', code: 'BOOK_BOOKMARKS_RESET_FAILED' });
          }
        }
      }
      return result;
    });
  }, { mutation: MUTATION.DELETE });
}

module.exports = { register: registerBookIpc };
