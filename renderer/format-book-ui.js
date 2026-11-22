/* 一键整理本书的整段编排 —— M1（第一轮·低）拆分第三刀：从 renderer.js 整段搬出。
 *
 * 为什么单独一个模块：这条流只在点「一键整理本书…」时走，却把四段编排串在 4,472 行的编排器里：
 *   1. 未保存拦截（五-H3 / L-F1 口径：保存回执后复核 dirty，仍脏就再问一轮）；
 *   2. 预检查 + 整本整理都在长操作锁内（WP-02/C2：锁编辑区防重复触发，回执只属于发起时那本书）；
 *   3. 完成后按「书没换 / 期间有没有新输入」三路分流（换了书只动书架 / 保留编辑区 / 正常重载当前章）；
 *   4. 成功登记 10 秒撤销：撤销前核对备份指纹，并拒绝在「已换书 / 编辑区有未保存修改」时动手。
 * 搬出来以后这些分流可以用假 state + 桩 IPC 在 Node 里逐条钉住，不必开 Electron 整理一本千章书。
 *
 * 契约：createFormatBookUi(host) 只调用一次；host 正好 29 个成员：
 *   state, editorEl, api, call, toast,
 *   hideFormatMenu, hideDisplayMenu,
 *   saveForTransition, currentChapterLabel, loadChapterAt,
 *   formatUi, longOpLocked, beginLongOpLock, endLongOpLock,
 *   showFormatBookProgress, hideFormatBookProgress,
 *   chapterTitle, runBookOp, openBook,
 *   refreshShelf, renderChapterList, renderEditorHeader, updateStatus,
 *   saveLogic, longOpLogic, backupGuard, undoUi,
 *   reloadOpenBookFromDisk, reloadAfterPartialFailure
 *   · runBookOp 由渲染层注入：整本整理那一步必须走 testBookOp || call（E2E 注入延迟时不破坏这里的时序）；
 *   · openBook 只用于「整理完重读同一本书的书目」，换书一律走渲染层的换书入口，本模块不碰；
 *   · 缺任何一个必填成员直接抛 TypeError（宁可在启动时炸，也不要到点「整理本书」时 ReferenceError）。
 *
 * 只读 state、调 host 注入的入口；不写盘、不自己拼 IPC 频道名。
 *
 * 浏览器里挂成全局 CWFormatBookUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../core/assert-host').assertHost);
  } else if (root) {
    root.CWFormatBookUi = factory(root.CWAssertHost && root.CWAssertHost.assertHost);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (assertHost) {
  'use strict';

  const REQUIRED_HOST = [
    'state',
    'editorEl',
    'api',
    'call',
    'toast',
    'hideFormatMenu',
    'hideDisplayMenu',
    'saveForTransition',
    'currentChapterLabel',
    'loadChapterAt',
    'formatUi',
    'longOpLocked',
    'beginLongOpLock',
    'endLongOpLock',
    'showFormatBookProgress',
    'hideFormatBookProgress',
    'chapterTitle',
    'runBookOp',
    'openBook',
    'refreshShelf',
    'renderChapterList',
    'renderEditorHeader',
    'updateStatus',
    'saveLogic',
    'longOpLogic',
    'backupGuard',
    'undoUi',
    'reloadOpenBookFromDisk',
    'reloadAfterPartialFailure'
  ];

  function createFormatBookUi(host) {
    assertHost('createFormatBookUi', host, REQUIRED_HOST);
    const {
      state, editorEl, api, call, toast,
      hideFormatMenu, hideDisplayMenu,
      saveForTransition, currentChapterLabel, loadChapterAt,
      formatUi, longOpLocked, beginLongOpLock, endLongOpLock,
      showFormatBookProgress, hideFormatBookProgress,
      chapterTitle, runBookOp, openBook,
      refreshShelf, renderChapterList, renderEditorHeader, updateStatus,
      saveLogic, longOpLogic, backupGuard, undoUi,
      reloadOpenBookFromDisk, reloadAfterPartialFailure
    } = host;

    // 一键整理本书：复用上次「整理本章」的规则 → 预检查 → 直接整理（1.4.0 P0-2 起不再弹确认框，写前备份）
    async function runFormatBook() {
      if (!state.bookPath || !state.meta) {
        toast('先打开一本书再整理', 'warn');
        return { ok: false };
      }
      if (state.formatBookRunning || longOpLocked()) {
        toast('正在整理这本书，请稍候', 'warn');
        return { ok: false, busy: true };
      }
      hideFormatMenu();
      hideDisplayMenu();
      if (state.dirty) {
        // 五-H3（L-F1）：整本整理自身的未保存拦截与历史还原共用同一条语义——保存回执后复核 dirty，
        // 仍脏（保存在途敲了字）就再问一轮；选「不保存」才用磁盘旧内容继续。旧实现只看 saved.ok，
        // 整理备份里不含「保存期间输入」，随后 keep-edits + Ctrl+S + 10 秒撤销会把这份输入静默弄丢。
        const guard = await saveForTransition({
          title: '整理本书前先处理未保存的修改',
          message: `「${currentChapterLabel()}」还有未保存的修改；整本整理会直接写盘，建议先保存。`,
          saveLabel: '保存后整理',
          discardLabel: '不保存（按磁盘内容整理）'
        });
        if (!guard.ok) return guard.canceled ? { ok: false, canceled: true } : (guard.saved || { ok: false });
        if (guard.discarded) await loadChapterAt(state.index); // 用磁盘上的旧内容继续
      }

      const options = formatUi.mergeOptions(state.config && state.config.formatOptions);
      // WP-02/C2：从预检查起就锁编辑区（预检查也要读完整本书，千章书不短），并把「进行中」
      // 标志提前到预检查之前防重复触发。完成时按「书没换 / 期间有没有新输入」决定怎么重载。
      state.formatBookRunning = true;
      const bookPath = state.bookPath;
      beginLongOpLock();
      try {
        let preview;
        try {
          showFormatBookProgress('正在检查整本书…（编辑区已暂锁）');
          preview = await call(api.formatPreviewBook, bookPath, options);
        } catch (err) {
          toast(`预检查失败：${err.message}`, 'error');
          return { ok: false, message: err.message };
        }
        if (!preview.chaptersChanged) {
          toast('这本书已经是整理后的格式，没有可改的地方' + (preview.skippedTooLarge ? `；有 ${preview.skippedTooLarge} 章超过 128 MB，本次已跳过（文件没动）` : ''));
          return { ok: true, changed: 0, data: preview };
        }

        const listText = preview.changed
          .slice(0, 6)
          .map((item) => chapterTitle(item.index, item.name))
          .join('、');
        const moreText =
          preview.chaptersChanged > 6
            ? ` 等共 ${preview.chaptersChanged} 章`
            : `（共 ${preview.chaptersChanged} 章）`;
        // 1.4.0 P0-2（撤销优先于确认）：整本整理不再弹确认框 —— 直接整理（写前照旧备份到
        // _trash/整理备份-*），10 秒内可撤销（撤销 = 用这份备份还原整组，还原前还会再备份一份）。
        // 准备信息进 toast，作者不用点确认也知道改了几章。
        const planText = `规则：${formatUi.describeRules(options)}；会改 ${preview.chaptersChanged} 章（${listText}${moreText}）`;

        showFormatBookProgress(`正在整理整本书…（共 ${preview.chaptersChanged} 章要改，编辑区暂锁）`);
        // WP-02/C2：只整理发起时捕获的那本书（不使用 await 之后的活值）。
        const result = await runBookOp(bookPath, options);
        const doneText = `已整理全书：${result.chaptersChanged} 章${planText ? `（${planText}）` : ''}${
          result.backupDir ? ' · 原文已备份到 _trash' : ''
        }${
          result.skippedTooLarge ? `；有 ${result.skippedTooLarge} 章超过 128 MB，本次已跳过（文件没动）` : ''
        }`;
        // 完成时先按「书没换 / 期间有没有新输入」判定（C2）：回执只属于发起时那本书。
        const decide = () =>
          longOpLogic.decideAfterLongOp({
            expectedBookPath: bookPath,
            currentBookPath: state.bookPath,
            dirty: saveLogic.isDirtyAgainstSnapshot(state.baseText, editorEl.value)
          });
        let plan = decide();
        if (plan === 'book-changed') {
          // 整理期间切了书：旧书照常整理完，但界面一个字都不动（以前会用活值重载到另一本书）
          await refreshShelf();
          toast(`${doneText}（你已切换到另一本书，切回后看到的就是整理结果）`);
          return { ok: true, changed: result.chaptersChanged, data: result };
        }
        // 同一本书：读回整理后的书目（章节字数缓存变了）
        const opened = await openBook(bookPath);
        plan = decide(); // 读回书目期间也可能换书 / 再输入
        if (plan === 'book-changed') {
          await refreshShelf();
          toast(`${doneText}（你已切换到另一本书，切回后看到的就是整理结果）`);
          return { ok: true, changed: result.chaptersChanged, data: result };
        }
        const liveId = state.chapters[state.index] && state.chapters[state.index].id;
        state.meta = opened.meta;
        state.chapters = opened.meta.chapters;
        if (plan === 'keep-edits') {
          // 整理期间编辑区里又有字（输入法补字 / 程序化写入等漏网输入）：磁盘已经整理好，
          // 但正文优先——保留编辑区并维持未保存态，绝不拿整理结果盖掉作者的字。
          state.dirty = true;
          renderChapterList();
          renderEditorHeader();
          updateStatus();
          toast(doneText);
          toast('整理已完成写盘；你在整理期间输入的修改还留在编辑区（未保存，Ctrl+S 保存后生效）', 'warn');
        } else {
          // 整理后重新载入当前章（章节 id 保持不变；期间切过章就按现在这一章重载）
          const index = liveId
            ? Math.max(0, state.chapters.findIndex((chapter) => chapter.id === liveId))
            : Math.min(state.index, Math.max(0, state.chapters.length - 1));
          await loadChapterAt(index);
          renderChapterList();
          renderEditorHeader();
          toast(doneText);
        }
        await refreshShelf();
        // 撤销：用这次整理写盘前的备份整组还原（storage 会先把现在的内容再备份到 _trash/还原前备份-*）
        const backupName = result.backupDir ? String(result.backupDir).split(/[\\/]/).pop() : '';
        if (result.chaptersChanged && backupName) {
          // 1.5.0 P0-5（审计 V-2）：登记撤销时记下整理备份的指纹；撤销前核对它还是不是那一份。
          const expectedBackup = await backupGuard.fingerprint(bookPath, backupName);
          undoUi.activate(`已整理全书 ${result.chaptersChanged} 章`, async () => {
            if (!longOpLogic.sameBookPath(state.bookPath, bookPath)) throw new Error('已经换了书，不能撤销');
            // 五-H3（L-F1）：撤销会拿整理备份整组覆盖磁盘 + 从磁盘重载；编辑区有未保存的字时执行
            // 会把它们连磁盘带编辑区一起盖掉（reload 的脏闸拦不住已经发生的写盘）。
            if (state.dirty) throw new Error('编辑区有未保存的修改，请先保存后再撤销');
            await backupGuard.assertUnchanged(bookPath, expectedBackup);
            const data = await call(api.restoreHistoryDir, bookPath, `dir:${backupName}`);
            if (!data || !Number(data.restored)) throw new Error('整理备份里没有可还原的章节');
            await reloadOpenBookFromDisk(bookPath);
            await refreshShelf();
          }, { groupId: 'dir:' + backupName, bookPath });
        }
        return { ok: true, changed: result.chaptersChanged, data: result };
      } catch (err) {
        toast(`整理本书失败：${err.message}`, 'error');
        await reloadAfterPartialFailure(bookPath); // 可能已经整理了好几章，别让编辑区停在旧正文上
        return { ok: false, message: err.message };
      } finally {
        endLongOpLock();
        state.formatBookRunning = false;
        hideFormatBookProgress();
      }
    }

    // 只暴露入口（与搬前等价：编排器里同名转发）。不要在渲染层再长第二份（tests/format-book-ui.test.js 的机器清单会红）。
    return { runFormatBook };
  }

  return { create: createFormatBookUi, REQUIRED_HOST };
});
