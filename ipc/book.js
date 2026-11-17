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
const { assertHost } = require('../renderer/assert-host');
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
    fs, path, shell, getConfig,
    flowSession, sessionById, focusSession, flushLastOpenBeforeRead,
    lastOpenWrites, bookKeyOf, rememberRecentBook, notifyShelfChanged,
    sendToFlow, logError, showOpenDialog, automation,
    isE2E
  } = host;

  handle('books:list', async () => {
    // B3：书架列表要显示每本书的章节 / 字数，先把防抖中的「上次打开章节」落盘再读
    await flushLastOpenBeforeRead(null);
    const cfg = await getConfig();
    return storage.listBooks(cfg.booksRoot);
  });

  handle('book:create', async (title) => {
    const cfg = await getConfig();
    await fs.mkdir(cfg.booksRoot, { recursive: true });
    const created = await storage.createBook(cfg.booksRoot, title);
    notifyShelfChanged(flowSession(), 'book:create');
    return created;
  });

  handleBook('book:open', async (bookPath) => {
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
    const data = await storage.openBook(bookPath);
    if (session) {
      const registered = storage.registerOpenBook(session.id, bookPath);
      if (!registered.ok) {
        focusSession(sessionById(registered.ownerWindowId));
        throw new storage.StorageError(registered.code, registered.message);
      }
    }
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
  }, READ_ONLY);
  handleBook('book:verify', async (bookPath) => storage.verifyBook(bookPath), READ_ONLY);
  handleBook('book:rename', async (bookPath, title) => storage.renameBook(bookPath, title), {
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
      return await storage.restoreDeletedChapterFromTrash(bookPath, clean);
    } catch (err) {
      restoreTokens.release(claim.record);
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
    if (!(await storage.exists(target))) {
      throw new storage.StorageError('NOT_FOUND', '这本书的文件夹已经不存在了');
    }
    // 审计修复 #4（S1）：是书架目录的直接子目录还不够，必须确认「目标是一本书」——
    // `_trash`（全部删书备份）/ `_碎片`（灵感箱）也是书架根的直接子目录，注入脚本以前能把它们
    // 整个丢进回收站。保留目录（_ / . 开头）与没有 书目.json 的普通文件夹一律拒绝。
    const folder = path.basename(target);
    if (folder.startsWith('_') || folder.startsWith('.')) {
      throw new storage.StorageError('BAD_PATH', '书架保留目录不能当书删除');
    }
    if (!(await storage.exists(path.join(target, storage.BOOK_FILE)))) {
      throw new storage.StorageError('NOT_A_BOOK', '这不是一本书（文件夹里没有 书目.json）');
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
    storage.clearBookLock(target);
    return result;
  }, { mutation: MUTATION.DELETE });
}

module.exports = { register: registerBookIpc };
