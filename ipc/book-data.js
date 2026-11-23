/* 主进程 IPC 域模块：书域数据面（v1.8.0 审计修复 #38 / ▲V306）。
 *
 * 搬走的段（原 main.js 的 registerIpc() 内，行号按搬前代码，2010–2110）：
 *   · 全书查找 / 替换：book:search / book:replace；
 *   · 整本替换的还原：book:list-replace-backups / book:restore-replace-backup；
 *   · 本书历史：book:list-history / book:preview-history-file / book:restore-history-file /
 *     book:restore-history-dir / book:plan-delete-history-backups / book:delete-history-backups /
 *     book:clear-snapshot-day；
 *   · 整本智能排版：book:format-preview / book:format；
 *   · 打开书文件夹：shell:open-book-folder。
 *
 * 为什么单独一个域模块（▲V306）：这些是书域里最危险的一批写操作（整本替换 / 整理 / 历史还原 /
 * 清快照），以前和 CRUD 分居 main.js / ipc/book.js 两处；新增频道时 mutation 标记、书锁、
 * notifyShelfChanged 三个口径最容易漏（O6 就是这类漏网的产物）。
 *
 * 只搬不改行为：频道名 / 参数顺序 / 返回形状 / 文案 / 读盘与写盘顺序与搬运前逐字一致；
 * 唯一的变化是**每条频道显式选一个 mutation 或 READ_ONLY**（取值见 ipc/book-mutations.js，
 * 与搬前显式带的那几处逐字相同；只读频道以前靠省略参数，现在写出来）。
 *
 * 契约：register(host) —— host 成员逐条列在 REQUIRED_HOST 里；缺任何一个在 registerIpc() 装配时
 * 直接抛 TypeError。模块自己不 require electron、不缓存状态快照。
 */
const { assertHost } = require('../core/assert-host');
const deletePlanToken = require('../core/delete-plan-token');
const { MUTATION, READ_ONLY } = require('./book-mutations');

const REQUIRED_HOST = [
  'handleBook',
  'storage',
  'ipcLimits',
  'fs',
  'path',
  'shell',
  'errorText',
  'sendToFlow',
  // T-08（三次审查）：六个正文改写通道成功后要标脏搜索索引（与 ipc/save.js:109 同口径）。
  'getSearchIndexStore',
  'logError'
];

// T-08：正文改写通道统一用它标脏搜索索引。根签名探测只 stat 书架根目录 mtime，同名覆写章节文件
// 探测不到——不标脏时，替换 / 整理 / 还原后 60 秒复用窗口内会拿旧位图：新词搜不到、已删旧文还能命中。
// 标脏失败绝不能把「正文已经写好」的操作报成失败：只留痕（与保存链的 INDEX_DIRTY_FAILED 同一口径）。
function markSearchDirty(getSearchIndexStore, logError, bookPath) {
  try {
    getSearchIndexStore().markDirty(bookPath);
  } catch (err) {
    logError('book-data', err, { level: 'warn', code: 'INDEX_DIRTY_FAILED' });
  }
}

function registerBookDataIpc(host) {
  assertHost('ipc/book-data.registerBookDataIpc', host, REQUIRED_HOST);
  const {
    handleBook, storage, ipcLimits, fs, path, shell, errorText, sendToFlow, getSearchIndexStore, logError
  } = host;
  const markDirty = (bookPath) => markSearchDirty(getSearchIndexStore, logError, bookPath);
  // WP4（审计 S-N1）：清理备份的一次性计划令牌（进程内、只在主进程）。每次 register 一份 ——
  // 模块本身不缓存全局状态（单测各自装配，互不串令牌）。
  const deletePlanTokens = deletePlanToken.createStore();

  // 全书查找 / 替换：替换写盘前 storage 会把原章节备份到书内 _trash。
  // v0.9 C-5：options 由 core/ipc-limits.js 清洗——查找词 / 替换词必须是文本且各限 1 万字，
  // 非对象 options 按 {}（旧行为：没传选项 = 默认口径），坏类型直接回 BAD_QUERY / BAD_REPLACEMENT，
  // 不让一个超长替换词把整本书的 txt 撑爆（替换最多 5000 处 / 章）。
  // R4b（V9）/ 1.7.2 D4（V40）：整本操作遇到超过 128 MB 的章会跳过，core 在结果里直接带
  // skippedTooLarge；这里原样返回 core 的结果，不再包一层恒等复制（渲染层照旧读这个字段）。
  handleBook('book:search', async (bookPath, options) =>
    storage.searchBook(bookPath, ipcLimits.sanitizeSearchOptions(options)), READ_ONLY
  );
  handleBook('book:replace', async (bookPath, options) => {
    const result = await storage.replaceInBook(bookPath, ipcLimits.sanitizeReplaceOptions(options));
    // T-08：整本替换逐章重写 txt，成功后标脏索引（否则 60 秒内搜索仍拿旧位图）。
    markDirty(bookPath);
    return result;
  }, {
    mutation: MUTATION.REPLACE
  });

  // 整本替换的还原：列出 / 还原书内 _trash/替换备份-*/（还原前把当前内容再备份一份）
  handleBook('book:list-replace-backups', async (bookPath) =>
    storage.listReplaceBackups(bookPath), READ_ONLY
  );
  handleBook('book:restore-replace-backup', async (bookPath, backupName) => {
    const result = await storage.restoreReplaceBackup(bookPath, backupName);
    markDirty(bookPath); // T-08
    return result;
  }, { mutation: MUTATION.REPLACE });

  // 本书历史：统一列出 / 预览 / 还原书内 _trash 的各种备份（替换/整理/还原前/快照/删章 + 书目.json.bak）
  handleBook('book:list-history', async (bookPath) => storage.listBookHistory(bookPath), READ_ONLY);
  handleBook('book:preview-history-file', async (bookPath, groupId, fileName) =>
    storage.previewHistoryFile(bookPath, groupId, fileName), READ_ONLY
  );
  handleBook('book:restore-history-file', async (bookPath, groupId, fileName) => {
    const result = await storage.restoreHistoryFile(bookPath, groupId, fileName);
    markDirty(bookPath); // T-08
    return result;
  }, { mutation: MUTATION.WRITE });
  handleBook('book:restore-history-dir', async (bookPath, groupId) => {
    const result = await storage.restoreHistoryGroup(bookPath, groupId);
    markDirty(bookPath); // T-08
    return result;
  }, { mutation: MUTATION.WRITE });
  // B6（v1.8.0 WP-28 / D-5）：手动清理三类备份（替换 / 整理 / 还原前）—— 只有历史面板的两步确认
  // 才会调到这里；存储层只认 `dir:<三类备份目录>`、再校验落在本书 _trash 下，并跳过仍被
  // 10 秒撤销条引用的组（protectedGroupIds 由渲染层按 TTL 现算）。绝不自动调用、绝不碰快照 / 散文件。
  //
  // WP4（审计 S-N1）：清理拆成「计划 → 执行」两步，堵住「渲染层传什么、主进程删什么」的信任缺口：
  //   ① 计划（只读、不广播）：主进程用 storage 自己的解析判断哪些组真的可清理，并发一张一次性令牌
  //      （绑本书 + 组清单摘要 + 2 分钟过期；随机 UUID 只存内存）；
  //   ② 执行：必须带 planToken 回来，四条全过才放行（存在 / 没过期 / 同一本书 / 组清单一致），
  //      成功后令牌立刻作废。删除动作只认主进程注入的 shell.trashItem（可恢复），渲染层传的
  //      options.trash 一律被覆盖掉。
  handleBook('book:plan-delete-history-backups', async (bookPath, groupIds, options) => {
    const settings = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
    const plan = await storage.planHistoryBackupDeletion(bookPath, groupIds, settings);
    // 五-M29（IPC-02）：令牌不只绑原始 groupIds，还把「计划实际解析出的可清理集合」绑进去 ——
    // 执行阶段撤掉 protectedGroupIds 也删不到确认框里明示跳过的组（storage 执行前会复核）。
    const planToken = deletePlanTokens.issue({
      bookPath,
      groupIds,
      cleanableIds: (plan.cleanable || []).map((entry) => entry.id)
    });
    if (!planToken) {
      throw new storage.StorageError('DELETE_PLAN_INVALID', '这次清理没有拿到确认凭证，一个文件都没有动');
    }
    return { ...plan, planToken, ttlMs: deletePlanTokens.ttlMs };
  }, READ_ONLY);
  handleBook('book:delete-history-backups', async (bookPath, groupIds, options) => {
    const settings = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
    const claim = deletePlanTokens.take(settings.planToken, { bookPath, groupIds });
    if (!claim.ok) throw deletePlanToken.errorFor(claim.reason);
    try {
      return await storage.deleteHistoryBackups(bookPath, groupIds, {
        // 渲染层能给的只有保护列表 / stat 注入这类补充信息；删除动作由主进程现填。
        ...settings,
        // 五-M29（IPC-02）：执行清单只认计划里确认过的可清理集合 —— 渲染层临时改 protectedGroupIds
        // 让解析结果多出没确认过的组时，storage 整次拒绝（一个文件都不动），令牌放回可重试。
        confirmedGroupIds: claim.record.cleanable,
        // 主进程唯一可用的删除动作：移入 Windows 回收站。失败就逐组如实报错，绝不降级成硬删。
        trash: (dir) => shell.trashItem(dir)
      });
    } catch (err) {
      // 执行阶段整体失败（回收站暂时不可用 / 书被别的窗口占住）：令牌放回去，作者可以原地再试一次。
      deletePlanTokens.release(claim.record);
      throw err;
    }
  }, { mutation: MUTATION.WRITE });
  // 清空某一天的每日快照（P22-5）：只把这个目录**移入 Windows 回收站**，绝不硬删。
  // 参数只认快照目录名（storage.snapshotDirForClear 严格校验「快照-YYYYMMDD」+ 日期真实存在 +
  // 必须落在本书 _trash 下），不接受任意路径；校验不过 / 回收站不可用都只报错返回，一个文件都不动。
  //
  // I3（三审·低）：书域 mutation 里**唯一**在书锁外执行删除的频道，现在也包进 withBookLock。
  // 反例：chapter:save 在锁内往 `_trash/快照-YYYYMMDD/` 复制上一版期间，本频道能把该目录整个
  // 移进回收站 —— 那一次快照复制半途失败 / 新快照随目录被回收。同域删除 / 还原都走 lockedWriteEntry，
  // 这里补上同一把锁（lstat 校验也在锁内，回收站动作与保存的「复制上一版」不再交错）。
  handleBook('book:clear-snapshot-day', async (bookPath, groupName) =>
    storage.withBookLock(bookPath, async () => {
      const dir = storage.snapshotDirForClear(bookPath, groupName);
      let stat;
      try {
        stat = await fs.lstat(dir);
      } catch (err) {
        if (err.code === 'ENOENT') {
          throw new storage.StorageError('HISTORY_GROUP_MISSING', '这个快照目录已经不存在了');
        }
        throw err;
      }
      // 联接 / 符号链接不是普通文件夹：宁可不清，也不要把书库外面的东西卷进来
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new storage.StorageError('SNAPSHOT_NOT_DIR', '这个快照不是一个普通文件夹，没有清空');
      }
      try {
        await shell.trashItem(dir);
      } catch (err) {
        // 回收站不可用（被策略禁用 / 磁盘问题…）：报错返回，不重试、不降级成硬删
        throw new storage.StorageError(
          'SNAPSHOT_TRASH_FAILED',
          `移入回收站失败，快照没有动：${errorText.describeForUi(err).message}`
        );
      }
      return { dir: path.basename(dir) };
    }), { mutation: MUTATION.WRITE });

  // 整本智能排版：预检查只算不写；正式整理逐章写盘（写前把原章节备份到 _trash/整理备份-*）
  // 1.7.2 D4（V40）：同 book:search / book:replace，core 结果里的 skippedTooLarge 原样透传。
  handleBook('book:format-preview', async (bookPath, options) =>
    storage.previewFormatBook(bookPath, options), READ_ONLY
  );
  handleBook('book:format', async (bookPath, options) => {
    const result = await storage.formatBook(bookPath, options, (progress) => {
      sendToFlow('format:progress', progress);
    });
    // T-08：整理会逐章重写正文，成功后标脏索引。
    markDirty(bookPath);
    return result;
  }, { mutation: MUTATION.FORMAT });

  handleBook('shell:open-book-folder', async (bookPath) => {
    // C6（审计 E13）：先 stat 确认目标是目录，再交给系统默认程序打开——书架根下的直接子文件
    // （比如作者误放的一个 exe / 快捷方式）不会被「打开书文件夹」顺带执行。
    const stat = await fs.stat(bookPath);
    if (!stat.isDirectory()) {
      throw new storage.StorageError('NOT_A_DIRECTORY', '这个路径不是书文件夹，没有打开');
    }
    const err = await shell.openPath(bookPath);
    if (err) throw new storage.StorageError('OPEN_FAILED', errorText.cleanText(errorText.redactPaths(err)));
    return true;
  }, READ_ONLY);
}

module.exports = { register: registerBookDataIpc };