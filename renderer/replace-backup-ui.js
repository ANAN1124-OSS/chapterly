/* 「整本替换」的备份列表与还原 —— M1（第一轮·低）拆分第五刀：从 renderer.js 整段搬出。
 *
 * 为什么单独一个模块：这是「整本替换」唯一的退路，却把三件事串在 4,261 行的编排器里：
 *   1. 列备份（书内 _trash/替换备份-*，storage 负责读写，这里只展示横幅 / 下拉）；
 *   2. 还原前先处理当前章的未保存修改（保存并继续 / 丢弃 / 取消），「取消 / 保存失败」一律停在原地；
 *   3. 还原是长操作：锁编辑区 → IPC → 从磁盘重载 → 书架刷新 → 登记 10 秒撤销
 *      （撤销前再核「书没换 / 编辑区干净 / 还原前备份还是那一份」）。
 * 搬出来以后这些分流可以用假 state + 桩 IPC 在 Node 里逐条钉住，不必开 Electron 往返一本真书。
 *
 * 契约：createReplaceBackupUi(host) 只调用一次；host 正好 19 个成员：
 *   $, state, api, call, toast, formatBytes,
 *   longOpLocked, beginLongOpLock, endLongOpLock,
 *   showFormatBookProgress, hideFormatBookProgress,
 *   confirmRestoreWithUnsaved, restoreBookOp,
 *   reloadOpenBookFromDisk, refreshShelf, reloadAfterPartialFailure,
 *   backupGuard, undoUi, longOpLogic
 *   · restoreBookOp 由渲染层注入：还原那一步必须走 testBookOp || call（E2E 用 setTestBookOpDelay
 *     在 IPC 外包一层延迟，create 时传值会让延迟注入失效）；
 *   · 缺任何一个必填成员直接抛 TypeError（宁可在启动时炸，也不要到点「还原备份」时 ReferenceError）。
 *
 * 只改 state.replaceBackups（列表缓存）与界面横幅；不自己拼 IPC 频道名、不写盘。
 *
 * 浏览器里挂成全局 CWReplaceBackupUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../core/assert-host').assertHost);
  } else if (root) {
    root.CWReplaceBackupUi = factory(root.CWAssertHost && root.CWAssertHost.assertHost);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (assertHost) {
  'use strict';

  const REQUIRED_HOST = [
    '$',
    'state',
    'api',
    'call',
    'toast',
    'formatBytes',
    'longOpLocked',
    'beginLongOpLock',
    'endLongOpLock',
    'showFormatBookProgress',
    'hideFormatBookProgress',
    'confirmRestoreWithUnsaved',
    'restoreBookOp',
    'reloadOpenBookFromDisk',
    'refreshShelf',
    'reloadAfterPartialFailure',
    'backupGuard',
    'undoUi',
    'longOpLogic'
  ];

  function createReplaceBackupUi(host) {
    assertHost('createReplaceBackupUi', host, REQUIRED_HOST);
    const {
      $, state, api, call, toast, formatBytes,
      longOpLocked, beginLongOpLock, endLongOpLock,
      showFormatBookProgress, hideFormatBookProgress,
      confirmRestoreWithUnsaved, restoreBookOp,
      reloadOpenBookFromDisk, refreshShelf, reloadAfterPartialFailure,
      backupGuard, undoUi, longOpLogic
    } = host;

    // ---------- 整本替换的备份还原 ----------
    // 备份都在书内 _trash/替换备份-时间戳/（storage 负责读写），这里只负责展示和确认。
    async function refreshReplaceBackups() {
      const row = $('find-backup-row');
      if (!state.bookPath) {
        state.replaceBackups = [];
        row.classList.add('hidden');
        return state.replaceBackups;
      }
      try {
        const backups = await call(api.listReplaceBackups, state.bookPath);
        state.replaceBackups = Array.isArray(backups) ? backups : [];
      } catch {
        state.replaceBackups = [];
      }
      if (!state.replaceBackups.length) {
        row.classList.add('hidden');
        return state.replaceBackups;
      }
      const latest = state.replaceBackups[0];
      $('find-backup-text').textContent =
        `最近一次整本替换的备份：${latest.name}（${latest.fileCount} 个文件，${formatBytes(latest.totalBytes)}）`;
      row.classList.remove('hidden');
      return state.replaceBackups;
    }

    // 从最近的「整本替换」备份还原；还原前先处理未保存修改，并由 storage 把当前内容再备份一份。
    // WP-02/C2：入口先捕获 bookPath，之后每个 await（列备份 / 未保存询问 / 还原 / 重载）回来
    // 都核对还是不是这本书——期间换了书就取消，绝不把回执用到另一本书上。
    async function restoreReplaceBackupFlow(backupName) {
      const bookPath = state.bookPath;
      if (!bookPath) {
        toast('还没有打开一本书', 'warn');
        return { ok: false };
      }
      if (longOpLocked()) {
        toast('正在执行另一个长操作，请稍候', 'warn');
        return { ok: false, busy: true };
      }
      await refreshReplaceBackups();
      if (!longOpLogic.sameBookPath(state.bookPath, bookPath)) {
        toast('已经换了书，取消还原', 'warn');
        return { ok: false };
      }
      const target =
        state.replaceBackups.find((item) => item.name === backupName) || state.replaceBackups[0];
      if (!target) {
        toast('这本书里没有可还原的替换备份', 'warn');
        return { ok: false };
      }
      if (state.dirty) {
        const guard = await confirmRestoreWithUnsaved(
          '还原会用备份覆盖磁盘上的章节，并从磁盘重新载入正文；当前章的未保存修改会丢失。'
        );
        if (!guard.ok) return guard.canceled ? { ok: false, canceled: true } : guard.saved;
        // 询问期间也可能切了书（弹窗不阻塞其它入口）：这时的 target 属于原来那本，不能还原。
        if (!longOpLogic.sameBookPath(state.bookPath, bookPath)) {
          toast('已经换了书，取消还原', 'warn');
          return { ok: false };
        }
      }
      const others = state.replaceBackups.length - 1;
      // 1.4.0 P0-2（撤销优先于确认）：还原到替换前不再弹二次确认 —— 直接还原
      // （storage 会先把当前内容备份到 _trash/还原前备份-*），10 秒内可撤销（= 用那份还原前备份再还原一次）。
      // 未保存拦截仍在前一步：这个动作会从磁盘重载正文，编辑区没写盘的字找不回来。
      beginLongOpLock();
      showFormatBookProgress('正在从备份还原…（编辑区已暂锁）');
      try {
        // WP-02/C2：还原只针对发起时捕获的那本书；延迟注入只包 IPC，不改变还原链路本身。
        const data = await restoreBookOp(bookPath, target.name);
        // 期间换了书 / 又敲了字时，reloadOpenBookFromDisk 内部会拒绝重载（正文优先），
        // 这里的刷新与撤销登记仍然按捕获的 bookPath 走。
        await reloadOpenBookFromDisk(bookPath);
        await refreshShelf();
        await refreshReplaceBackups();
        const undoName = data.restoreBackupDir ? String(data.restoreBackupDir).split(/[\\/]/).pop() : '';
        if (undoName) {
          // 1.5.0 P0-5（审计 V-2）：登记撤销时记下这份「还原前备份」的指纹；撤销前核对它还是不是那一份。
          const expectedBackup = await backupGuard.fingerprint(bookPath, undoName);
          undoUi.activate(`已还原到「${target.name}」前的正文`, async () => {
            if (!longOpLogic.sameBookPath(state.bookPath, bookPath)) throw new Error('已经换了书，不能撤销');
            // 五-H3（L-F1）：撤销会拿备份整组覆盖磁盘 + 从磁盘重载。编辑区有未保存的字时执行，
            // 等于把作者刚写的正文连磁盘带编辑区一起盖掉（reload 的脏闸也拦不住已经发生的写盘）。
            if (state.dirty) throw new Error('编辑区有未保存的修改，请先保存后再撤销');
            await backupGuard.assertUnchanged(bookPath, expectedBackup);
            const back = await call(api.restoreHistoryDir, bookPath, `dir:${undoName}`);
            if (!back || !Number(back.restored)) throw new Error('还原前备份里没有可还原的章节');
            await reloadOpenBookFromDisk(bookPath);
            await refreshShelf();
            await refreshReplaceBackups();
          }, { groupId: 'dir:' + undoName, bookPath });
        }
        toast(
          `已还原 ${data.restored} 个章节${
            data.skipped ? `（跳过 ${data.skipped} 个已不存在的章节）` : ''
          }，当前内容已备份到 _trash${others > 0 ? `（还有 ${others} 次更早的替换备份）` : ''}`
        );
        return { ok: true, data };
      } catch (err) {
        toast(`还原失败：${err.message}`, 'error');
        await reloadAfterPartialFailure(bookPath); // 可能已经还原了几章，界面回到磁盘的真相
        return { ok: false, message: err.message };
      } finally {
        endLongOpLock();
        hideFormatBookProgress();
      }
    }

    // 只暴露两个入口（与搬前等价：编排器里同名转发）。不要再长第二份（机器清单会红）。
    return { refreshReplaceBackups, restoreReplaceBackupFlow };
  }

  return { create: createReplaceBackupUi, REQUIRED_HOST };
});
