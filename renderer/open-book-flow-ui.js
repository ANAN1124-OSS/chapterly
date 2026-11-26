/* 换书入口 + 「提交新书」整段 —— M1（第一轮·低）拆分第六刀：从 renderer.js 整段搬出。
 *
 * 为什么单独一个模块：这是丢稿类缺陷最集中的一段（审计 V101 / V102 / C9 / C10 / E-01 / SS-07），
 * 三段时序全在 4,181 行的编排器里，只能开 Electron 连点两本书才撞得到：
 *   1. 换书前先处理当前章未保存的修改（保存并继续 / 丢弃 / 取消）——取消或保存失败都停在原地；
 *   2. 每次开书一个世代号：await 回来先核对，过期响应一个字都不许写进界面（连开两本时先点的后返回）；
 *   3. 提交新书：清空 / 遮罩编辑区、换书目、按 resolveOpenTarget 选起点章；目标章被删时标 targetMissing，
 *      绝不把旧章命中下标套到回落章正文上。
 * 搬出来以后这些分流可以用假 state + 桩 IPC 在 Node 里逐条钉住，不必真开两本书制造乱序。
 *
 * 契约：createOpenBookFlowUi(host) 只调用一次；host 正好 28 个成员：
 *   state, editorEl, $, openBookGuard, askUnsaved, saveCurrent, currentChapterLabel,
 *   applyEditorEditable, waitForSavingIdle, openBookOp, toast, openRepair, selectEditorRange,
 *   nextOpenSeq, currentOpenSeq, setOpeningBook,
 *   stopTtsForChapterChange, undoUi, clearEditorUndoSnapshots,
 *   resetWriteTimer, clearFindSession, setChapterMask, showView, renderChapterList,
 *   applyBookDisplay, loadChapterAt, renderEditorHeader, updateStatus
 *   · openBookOp 由渲染层注入：开书那一步必须走 testOpenBook || call（E2E 用 setTestOpenBookDelay
 *     在 IPC 外包一层延迟，create 时传值会让延迟注入失效）；
 *   · nextOpenSeq / currentOpenSeq / setOpeningBook 是编排器里 let 的活绑定：世代令牌与「正在开书」
 *     标记仍归 renderer.js（保存链的只读出口、插入闸、测试钩子都读它），模块只按发起时拍的 seq 核对；
 *   · 缺任何一个必填成员直接抛 TypeError（宁可在启动时炸，也不要到点开书时 ReferenceError）。
 *
 * 只读 state、调 host 注入的入口；不自己拼 IPC 频道名、不写盘。
 *
 * 浏览器里挂成全局 CWOpenBookFlowUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../core/assert-host').assertHost);
  } else if (root) {
    root.CWOpenBookFlowUi = factory(root.CWAssertHost && root.CWAssertHost.assertHost);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (assertHost) {
  'use strict';

  const REQUIRED_HOST = [
    'state',
    'editorEl',
    '$',
    'openBookGuard',
    'askUnsaved',
    'saveCurrent',
    'currentChapterLabel',
    'applyEditorEditable',
    'waitForSavingIdle',
    'openBookOp',
    'toast',
    'openRepair',
    'selectEditorRange',
    'nextOpenSeq',
    'currentOpenSeq',
    'setOpeningBook',
    'stopTtsForChapterChange',
    'undoUi',
    'clearEditorUndoSnapshots',
    'resetWriteTimer',
    'clearFindSession',
    'setChapterMask',
    'showView',
    'renderChapterList',
    'renderEditorHeader',
    'updateStatus',
    'applyBookDisplay',
    'loadChapterAt'
  ];

  function createOpenBookFlowUi(host) {
    assertHost('createOpenBookFlowUi', host, REQUIRED_HOST);
    const {
      state, editorEl, $, openBookGuard, askUnsaved, saveCurrent, currentChapterLabel,
      applyEditorEditable, waitForSavingIdle, openBookOp, toast, openRepair, selectEditorRange,
      nextOpenSeq, currentOpenSeq, setOpeningBook,
      stopTtsForChapterChange, undoUi, clearEditorUndoSnapshots,
      resetWriteTimer, clearFindSession, setChapterMask, showView, renderChapterList,
      renderEditorHeader, updateStatus, applyBookDisplay, loadChapterAt
    } = host;

    async function openBookByPath(bookPath, target = null) {
      // WP-03（V102）：每次开书一个世代号。await 回来先核对；过期响应一个字都不许写进界面——
      // 以前快速连开两本时，「响应最后返回」的那本会盖掉最后点击的那本（还可能把 index / chapters /
      // bookPath 带进不一致的中间态）。
      const seq = nextOpenSeq();
      const stale = () => seq !== currentOpenSeq();
      // 1.6.0 H1（审计 E-01，丢稿）：换书前先处理当前章节的未保存修改 —— 保存并继续 / 丢弃 / 取消。
      // 「取消」或「保存失败」都停在原地（正文、dirty、撤销条全不动）；决策是 open-book-guard.js
      // 里的纯函数（Node 单测覆盖），这里只负责弹窗与保存。四个换书入口都走这一个函数。
      // C10 同族：保存在途时先等它按快照章身份完成，再按「剩下真正没保存的字」询问——
      // 否则作者刚选的「不保存」会被在途写入违背。
      //
      // V221-OPEN-01（高，丢稿）：保存 IPC 往返（fsync / 书目 / 统计写盘，冷盘 / 杀软下可达数百 ms）
      // 期间作者可能继续敲字，saveCurrent 的回执按正文快照重算 dirty → 又变脏。旧实现把**发起换书前**
      // 的脏值快照当作守卫输入，保存成功就继续换书，紧接着 commitOpenBook 的
      // editorEl.value='' / 清撤销栈把这几个字静默覆盖。现在与 saveForTransition 同口径：
      // 每一轮都按**活值** state.dirty 判定；保存成功但仍脏就回到三选一重新问，绝不带着未保存输入继续。
      for (;;) {
        if (state.saving && state.dirty) {
          await waitForSavingIdle();
          if (stale()) return { ok: false, code: 'STALE' };
        }
        const dirtyNow = state.dirty === true;
        if (openBookGuard.decideOpenBook({ dirty: dirtyNow }).action !== 'prompt') break;
        const choice = await askUnsaved({
          title: '换书前先处理未保存的修改',
          message: `「${currentChapterLabel()}」还有未保存的修改。换到另一本书后，编辑区里这些字不会跟着过去。`
        });
        if (stale()) return { ok: false, code: 'STALE' };
        let saveResult = null;
        if (choice === 'save') saveResult = await saveCurrent();
        if (stale()) return { ok: false, code: 'STALE' };
        const guard = openBookGuard.decideOpenBook({ dirty: dirtyNow, choice, saveResult });
        // 失败提示 saveCurrent 已经弹过（与还原 / 删除前拦截同口径），这里只负责别继续换。
        // REDT-A-05：取消也是可判定的形状（以前裸 return → undefined，调用方按 result.ok 判定会分叉）。
        if (guard.action === 'abort') return { ok: false, canceled: true };
        // 无法判定的选择（正常 UI 不会出现）：留在原地重新问，绝不猜。
        if (guard.action === 'prompt') continue;
        // 'save' 成功也要回顶部按活值复核 dirty（保存期间又敲字 → 再问一次）；
        // 'discard' 是作者明确放弃这些字，直接放行。
        if (choice === 'discard') break;
      }
      // 从「决定换书」这一刻起锁住编辑区：开书 IPC 往返期间作者可能还在上一本里敲字。
      // 开成功就整块换成新书（这些字不能静默消失），开失败 / 取消则原样留在上一本（编辑区没动过）。
      setOpeningBook(true);
      applyEditorEditable();
      let committed = false;
      try {
        let data;
        try {
          // WP-03 验收锚点：?test=1 下 E2E 用 setTestOpenBookDelay 包一层延迟制造「响应乱序」窗口；
          // 正常启动 testOpenBook 恒为 null，直接走生产同一条开书 IPC。
          data = await openBookOp(bookPath);
        } catch (err) {
          if (stale()) return { ok: false, code: 'STALE' };
          if (err.code === 'BOOK_OPEN_IN_OTHER_WINDOW') {
            // 同一本书只允许一个窗口：主进程已经聚焦了那个窗口
            toast(err.message || '这本书已经在另一个窗口打开，已切换到那个窗口', 'warn');
            return { ok: false, code: err.code };
          }
          if (err.code === 'PARSE_ERROR' || err.code === 'INVALID_META' || err.code === 'NO_BOOK') {
            const known = (state.books || []).find((b) => b.path === bookPath);
            await openRepair(
              known || { path: bookPath, title: '这本书', status: 'corrupt', reason: err.message }
            );
            return { ok: false, code: err.code };
          }
          toast(`打开失败：${err.message}`, 'error');
          return { ok: false, code: err.code || 'OPEN_FAILED', message: err.message };
        }
        if (stale()) return { ok: false, code: 'STALE' };
        if (data.missing && data.missing.length) {
          toast(`注意：${data.missing.length} 个章节文件缺失，可在「导出 → 打开本书文件夹」里检查`, 'warn');
        }
        // 提交新书：清空 / 遮罩 / 换书目 / 载本章。提交完成后即使载章失败也停在新书的遮罩态（V101）。
        committed = await commitOpenBook(bookPath, data, target, stale);
        if (!committed) return { ok: false, code: 'STALE' };
        if (stale()) return { ok: false, code: 'STALE' };
        if (target && Number.isFinite(Number(target.matchIndex))) {
          // 五-M3（SS-07）：目标章在打开前被删（chapterId 没命中）时，绝不把属于旧章的命中下标
          // 套到回落章正文上（越界还会夹到文末）；明确提示作者，让他重新搜索。
          if (committed.targetMissing) {
            toast('查找命中的章节已经不在了（可能刚被删除），已打开上次阅读的章节；请重新搜索', 'warn');
          } else {
            selectEditorRange(Number(target.matchIndex), Number(target.matchLength) || 0);
          }
        }
        // REDT-A-05：成功也带 ok:true（回执字段原样展开，不破坏任何现有消费点）；以前裸 data 没有
        // ok 字段，任何按 result.ok === true 判成功的调用都会把成功开书误判成失败。
        return Object.assign({ ok: true }, data);
      } finally {
        // 只有「还是当前这次开书」才允许解自己的锁；过期响应不能把后一次开书的锁解掉。
        if (!committed && seq === currentOpenSeq()) {
          setOpeningBook(false);
          applyEditorEditable();
        }
      }
    }

    // 新书提交（WP-03 / V101）：调用方已确认这次响应属于当前世代。返回 false = 提交前又被新的开书取代，
    // 什么都没提交（调用方按过期处理）；返回 true = 书目已换成本书（即使后面载章失败也不回滚）。
    async function commitOpenBook(bookPath, data, target, isStale) {
      // 五-M21（MP-03）：换书先停朗读。朗读条 / 语音属于「上一本书的那一章」，commitOpenBook 全程
      // 不切视图（showView('editor') 时本来就是 editor，走不到 closeTtsBar），旧书正文会继续念，
      // 段末 advanceTts → selectTtsChunk 还会把旧书分段的偏移套进新书已清空 / 遮罩的编辑区；
      // 若新书载章失败，载章成功路径上的 stopTtsForChapterChange 永不执行，旧书朗读无限期继续。
      // 放在清任何状态之前：这时 chunks 还是旧书的，toast 文案才对。
      stopTtsForChapterChange();
      // 换书：撤销条不跨书（撤销闭包里还会再核对一次 state.bookPath）
      undoUi.clear();
      // 审计修复 #7（V401）：大段插入的一次性快照也必须跟着换书作废 —— 以前这里只清 undoUi，
      // bulkWriteUndo 会跨书活到「新书载章失败」的遮罩态：那时编辑区只是 readOnly（仍可聚焦），
      // 一下 Ctrl+Z 就把上一本整章正文写进新书空编辑区 + 假脏态。快照自身也带身份核对（见 undoBulkWrite）。
      // 审计修复 #39（V402）：兜底写入的一次性快照同样不跨书（与 bulk 同一套生命周期）。
      clearEditorUndoSnapshots();
      // 换书前先停掉上一本的写作计时：把没上报的整秒记下，新书从 0 开始
      await resetWriteTimer({ flush: true });
      if (isStale()) return false;
      // WP-03（V101）：提交新书状态前先清空 / 遮罩编辑区并置 index=-1、loadedChapterId=null。
      // 目标章读取失败时界面已经属于新书，编辑区绝不能还留着上一本的正文（否则输入 + Ctrl+S
      // 会把上一本正文写进新书同下标章节，且保存不备份正文）。
      state.bookPath = bookPath;
      state.meta = data.meta;
      state.bookId = data.meta.id;
      state.chapters = data.meta.chapters;
      state.collapsedVolumes = new Set(); // 换书重置折叠状态
      state.chapterFilter = ''; // 换书清空目录筛选（否则新书会带着上一本的筛选词，看起来像丢章）
      state.selectedIds = new Set(); // 换书清空多选（1.5.0 功能-1：多选不跨书）
      state.selectAnchorId = null;
      state.batchMenu = false;
      state.index = -1;
      state.loadedChapterId = null;
      state.dirty = false;
      state.saveError = null;
      state.baseText = '';
      editorEl.value = '';
      if (state.find.total) clearFindSession(); // 上一本的高亮位置不属于新书
      setChapterMask(true, '正在载入章节…');
      $('book-title').textContent = data.meta.title;
      $('book-title').title = data.meta.title;
      showView('editor');
      renderChapterList();
      // 套用这本书自己的显示设置（没有单独设置过就沿用全局）
      await applyBookDisplay(data.meta.id);
      // applyBookDisplay 期间可能有更晚的一次开书已经提交了自己的书：界面归它，这里不再载章，
      // 也不许解它的锁（openingBook 仍归那一次）。
      if (state.bookPath !== bookPath) return { ok: true, targetMissing: false };
      if (!isStale()) {
        setOpeningBook(false);
        applyEditorEditable();
      }
      // 空章节（2026-11-25 作者要求）：新书 / 删空的书打开后不自动建章，也不许停在
      // 「正在载入章节…」的遮罩上 —— 编辑区给一条可读的空态提示，章节栏显示「还没有章节」，
      // 作者点「＋ 新建章节」（或 Ctrl+N）开始写第一章。保存 / 导出等入口由调用方按 0 章拦。
      if (!state.chapters.length) {
        setChapterMask(true, '这本书还没有章节。点左下「＋ 新建章节」或按 Ctrl+N 开始写第一章。');
        // 章节栏已在上面 renderChapterList() 渲染过「还没有章节」空态；这里只补标题与状态栏。
        renderEditorHeader();
        updateStatus();
        return { ok: true, targetMissing: false, empty: true };
      }
      // 五-M3（SS-07）：起点章与「目标章是否命中」收进 open-book-guard 纯逻辑——目标章被删时
      // 回落上次阅读章并标记 targetMissing，调用方据此提示 + 不套旧命中下标。
      const resolved = openBookGuard.resolveOpenTarget({
        chapters: state.chapters,
        target,
        lastOpenChapterId: data.meta.lastOpenChapterId
      });
      await loadChapterAt(resolved.startIndex);
      return { ok: true, targetMissing: resolved.targetMissing };
    }

    // 只暴露换书入口（与搬前等价：编排器里同名转发）。commitOpenBook 只服务本模块内部。
    return { openBookByPath };
  }

  // A2-WINDOW-01（2026-11-26 审计）：主进程建窗时已经把书预登记给这个窗口；渲染层启动后
  // `?open=<书路径>` 的开书回执如果不是 ok:true（书被外部删了 / 提交被新的开书顶掉 / 打开失败），
  // 必须回滚这次**预登记** —— 否则登记悬空：别的窗口再打开同一本书会被聚焦到这个空窗口，
  // 写操作被 CROSS_WINDOW_BUSY 误拦，直到关窗才释放。只用于「新窗口自动开书」这一个入口。
  function startupOpenNeedsRelease(result) {
    return !result || result.ok !== true;
  }

  return { create: createOpenBookFlowUi, REQUIRED_HOST, startupOpenNeedsRelease };
});
