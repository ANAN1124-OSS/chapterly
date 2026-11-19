/* 保存链（WP17 A3 第二刀：从渲染层编排器整段搬出来）。
 *
 * 搬走的一段（约 380 行）：
 *   · 载章状态机 —— 世代令牌 + 成功才提交 + 失败保持遮罩（WP-03 / C9、V101）；
 *   · 保存热路径 —— 正文快照 / 4 个失败分支 / 救稿出口 / 覆盖重入单收尾（C1、V301、V302、R-N2）；
 *   · 关窗拦截 —— 保存 / 丢弃 / 取消三选 + 主进程交叉判定（C5）；
 *   · 状态栏四态入口 updateStatus、编辑区只读态 / 遮罩、载章 / 保存在途等待者。
 * **只搬不改行为**：函数体逐字保留（含注释红线），只把「编排器闭包里的活状态」改成 host 注入：
 *   getOpeningBook / setBulkWriteUndo / setFallbackWriteUndo / getTestLoadChapter / getTestSaveChapter /
 *   getTestVerifyBook / getCrashRecoveryUi —— 这些 let 仍归编排器（测试钩子直写它们），模块按引用现取。
 * 载章令牌 / 等待者队列 / 保存深度 / 遮罩态是本域私有活状态，随模块走；编排器顶部对应的 let 已删除。
 *
 * 契约：createSaveChainUi(host) 由渲染层调用一次；缺成员在装配时 TypeError（宁可在启动时炸，
 * 也不要到点保存才 ReferenceError）。host 成员见 REQUIRED_HOST，全部是编排器里已绑定的 const / 提升函数。
 * 编排器仍保留同名包装（函数声明会提升），调用点 / 测试钩子一个字都不改。
 *
 * 浏览器里挂成全局 CWSaveChainUi（index.html 排在编排器之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../core/assert-host').assertHost);
  } else if (root) {
    root.CWSaveChainUi = factory(root.CWAssertHost && root.CWAssertHost.assertHost);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (assertHost) {
  'use strict';

  const REQUIRED_HOST = [
    'state', 'api', 'call', 'editorEl', 'toast', 'chaptersLib', 'saveLogic', 'openModal',
    'saveStatusUi', 'saveRescueUi', 'formatChars', '$', 'renderCharCount', 'renderSelectionStats',
    'updateWindowTitle', 'clearFindSession', 'stopTtsForChapterChange', 'syncActiveChapterItem',
    'renderEditorHeader', 'renderChapterList', 'syncChapterCharsAfterSave', 'renderStatsUi',
    'flushWriteTimer', 'restoreFindBookmarkForCurrentChapter', 'scheduleMarksRender',
    'scheduleTypewriterAlign', 'longOpLocked', 'askUnsaved', 'escLib', 'escProbe', 'escRun',
    'DEFAULT_EDITOR_PLACEHOLDER', 'getOpeningBook', 'setBulkWriteUndo', 'setFallbackWriteUndo',
    'getTestLoadChapter', 'getTestSaveChapter', 'getTestVerifyBook', 'getCrashRecoveryUi'
  ];

  function createSaveChainUi(host) {
    assertHost('createSaveChainUi', host, REQUIRED_HOST);
    const {
      state, api, call, editorEl, toast, chaptersLib, saveLogic, openModal,
      saveStatusUi, saveRescueUi, formatChars, $, renderCharCount, renderSelectionStats,
      updateWindowTitle, clearFindSession, stopTtsForChapterChange, syncActiveChapterItem,
      renderEditorHeader, renderChapterList, syncChapterCharsAfterSave, renderStatsUi,
      flushWriteTimer, restoreFindBookmarkForCurrentChapter, scheduleMarksRender,
      scheduleTypewriterAlign, longOpLocked, askUnsaved, escLib, escProbe, escRun,
      DEFAULT_EDITOR_PLACEHOLDER, getOpeningBook, setBulkWriteUndo, setFallbackWriteUndo,
      getTestLoadChapter, getTestSaveChapter, getTestVerifyBook, getCrashRecoveryUi
    } = host;

    // ---------- 本域私有活状态（随模块走；编排器顶部的对应 let 已删除，避免两份状态漂移） ----------
    let loadChapterSeq = 0;
    let loadingWaiters = [];
    let savingWaiters = [];
    let editorChapterMasked = false;
    // WP20（R-N2）：同一笔用户保存的 force 重入（「仍然覆盖保存」）会嵌套进 saveCurrent。深度在真正
    // 开始写盘的 try 里加一、finally 里减一；只有最外层归零才唤醒等待者 / 收尾状态栏——否则内外
    // 两层各收尾一次，状态栏双跳、等待者被提前唤醒（审计 R-N2）。
    let saveDepth = 0;

    // N3（审计低）：载入大章软告知阈值——按**显示字数**（去空白）判定，只影响一条非阻塞 info toast，
    // 不拒载、不改 dirty / baseText / 遮罩。口径与「标记层超过 30 万字整层收起」（editor-marks-ui.js）、
    // 捕获 raw 原文上限 3,000,000 字符（core/capture.js 唯一实现）明确区分；这里不是硬限。
    const LARGE_CHAPTER_SOFT_CHARS = 500000;

  // 编辑区只读态的唯一出口：长操作锁 / 正在打开新书 / 正在载章 / 没有有效章节，任一成立就只读。
  // 统一走这里，避免「谁最后解自己的锁」互相覆盖（典型事故：长操作结束把载章中的锁一起解掉）。
  function applyEditorEditable() {
    const locked = longOpLocked() || getOpeningBook() || state.loading || editorChapterMasked;
    editorEl.readOnly = locked;
    if (locked) editorEl.setAttribute('aria-busy', 'true');
    else editorEl.removeAttribute('aria-busy');
  }

  // 没有有效章节时的遮罩：编辑区只读 + 一句给人看的占位提示；解除时恢复 index.html 的原文案。
  function setChapterMask(masked, placeholder) {
    editorChapterMasked = masked === true;
    editorEl.placeholder = editorChapterMasked
      ? String(placeholder || '当前章节没有打开（换一章或重新打开本书）')
      : DEFAULT_EDITOR_PLACEHOLDER;
    applyEditorEditable();
  }

  // 切章前等「载章 / 保存在途」落定（C9 / C10）。waiters 在各自的 finally 里统一唤醒；
  // 同一时刻只允许一个载章 / 保存（早退分支不会压着状态不放），所以不需要按令牌区分等待者。
  function waitForLoadingIdle() {
    if (!state.loading) return Promise.resolve();
    return new Promise((resolve) => loadingWaiters.push(resolve));
  }

  function notifyLoadingIdle() {
    const waiters = loadingWaiters;
    loadingWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function waitForSavingIdle() {
    if (!state.saving) return Promise.resolve();
    return new Promise((resolve) => savingWaiters.push(resolve));
  }

  function notifySavingIdle() {
    const waiters = savingWaiters;
    savingWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function updateStatus(options) {
    // 保存态四态（正在保存… / 未保存 · HH:MM 最后编辑 / 已保存 HH:MM:SS / 保存失败：原因）
    // 与圆点、失败态重试按钮、成功 2s 淡化都在 renderer/save-status-ui.js 里；
    // 这里不再自己拼第二套文案（1.3.0 T7 = 规范 C-05 / I-01）。
    saveStatusUi.render();
    // 1.6.0 A5/P-09：输入路径（options.typing）的本章字数走 200ms 防抖；切章 / 保存 / 套用等
    // 非输入路径不传 typing，仍然同步算（切过来就要看见字数）。
    renderCharCount({ defer: Boolean(options && options.typing) });
    $('btn-save').disabled = !state.dirty || state.saving;
    // 把未保存状态同步给主进程，供 Windows 关机拦截使用
    if (state.dirty !== state.reportedDirty) {
      state.reportedDirty = state.dirty;
      try {
        api.reportDirty(state.dirty);
      } catch { /* 忽略 */ }
    }
    updateWindowTitle();
  }

  // C5（审计 E5/S5）：关窗「不保存退出」= 作者主动丢弃未保存内容。主进程现在会用自己掌握的
  // 脏状态 + 最近保存回执交叉判定关窗，所以这里先把脏状态如实清掉（updateStatus 会同步上报
  // app:dirty），再回 closeReady(true)；否则主进程会按「仍脏且没有保存回执」把这次关窗拦下。
  function discardUnsavedForClose() {
    if (!state.dirty) return;
    state.dirty = false;
    updateStatus();
  }

  // WP-03（C9）：载章一律带 (bookPath, chapterId) 世代令牌。await 回来先核对「令牌还是最新的 +
  // 书没换 + 目标章还在原位」，只有全部成立才提交 index / baseText / editor.value；过期回执直接丢弃。
  // 加载期间编辑区只读：作者在「点了另一章、新章还没到」的窗口里敲的字不会无声消失。
  async function loadChapterAt(index) {
    if (!state.bookPath || !state.chapters.length) return { ok: false, code: 'NO_BOOK' };
    const safeIndex = Math.max(0, Math.min(index, state.chapters.length - 1));
    const chapter = state.chapters[safeIndex];
    if (!chapter || !chapter.file) return { ok: false, code: 'NO_CHAPTER' };
    const bookPath = state.bookPath;
    const chapterId = chapter.id;
    const token = ++loadChapterSeq;
    const stale = () =>
      token !== loadChapterSeq ||
      bookPath !== state.bookPath ||
      !state.chapters[safeIndex] ||
      state.chapters[safeIndex].id !== chapterId;
    state.loading = true;
    applyEditorEditable();
    try {
      // WP-03 验收锚点：?test=1 下 E2E 用 setTestLoadChapterDelay 包一层延迟制造「载章在途」窗口；
      // 正常启动 testLoadChapter 恒为 null，直接走生产同一条 call(api.loadChapter, ...)。
      const data = getTestLoadChapter()
        ? await getTestLoadChapter()(api.loadChapter, bookPath, chapter.file)
        : await call(api.loadChapter, bookPath, chapter.file);
      if (stale()) return { ok: false, code: 'STALE' };
      // 成功才提交（V101：失败保持原状态——开书失败时就是「index=-1 + 遮罩」）。
      state.index = safeIndex;
      state.loadedChapterId = chapterId;
      state.loadedMtimeMs = data.mtimeMs;
      state.baseText = data.text;
      state.dirty = false;
      state.saveError = null;
      editorEl.value = data.text;
      // 换章了：上一章的大段插入快照不能留着（撤销会把旧章正文写进新章）。
      setBulkWriteUndo(null);
      setFallbackWriteUndo(null); // 审计修复 #39（V402）：兜底写入快照同理，换章即作废
      editorEl.scrollTop = 0;
      // 有效章节已载入：解除开书失败留下的遮罩（长操作锁 / 载章锁仍由 applyEditorEditable 管）
      setChapterMask(false);
      // 换了一章：上一章的查找高亮（位置是旧正文的）直接结束
      if (state.find.total) clearFindSession();
      // 专注模式下切了章：退出的还原点改到新章开头，不要把上一章的光标 / 滚动套过来
      if (state.focus.on) {
        state.focus.savedScrollTop = 0;
        state.focus.savedCaret = 0;
        state.focus.savedCaretOffset = 0;
      }
      // 切章后正在念的已经不是眼前这一章了，立刻停
      stopTtsForChapterChange();
      // 只挪「当前章」高亮（v0.9 A-2）：千章书每切一章都整表重建 1000 条纯属浪费；
      // 章节列表和 state.chapters 对不上时 syncActiveChapterItem 会自己退回整表重建。
      syncActiveChapterItem();
      renderEditorHeader();
      updateStatus();
      renderSelectionStats();
      scheduleMarksRender(0);
      if (state.focus.typewriter) scheduleTypewriterAlign(0);
      // N3（审计低）：大章载入软告知。只读判定 + 一条非阻塞 toast：不写 state / dirty / baseText、
      // 不动遮罩与只读态；每次成功载入只跑一遍（失败 / stale 在上面的提前返回里已经走了）。
      // 显示字数优先用书目缓存（chapter.chars，状态栏 / 章节列表同一口径）；缓存缺失（null / 坏值）
      // 才回落到刚从磁盘读到的正文去空白字数——不能把 null 当 0 字，否则老书目会漏提示。
      const cachedChars = chapter.chars == null ? NaN : Number(chapter.chars);
      const loadedChars = Number.isFinite(cachedChars) && cachedChars >= 0
        ? Math.round(cachedChars)
        : chaptersLib.countChars(data.text);
      if (loadedChars > LARGE_CHAPTER_SOFT_CHARS) {
        toast('本章超过 50 万字，编辑/查找可能较慢，可考虑拆分章节', 'info');
      }
      // 主进程按书合并 1.5 秒内的连续切章（B3），这里只等它受理；真正落盘前若有读操作
      // （书架 / 打开书 / 继续上次写作）主进程会先 flush，重开书不会回到旧章。
      // 「继续上次写作」的书架级记忆在切章当下就写（配置很小），只把书目.json 的大写入防抖。
      try {
        // B1（审计 E6）：走统一 call() —— preload 在 IPC 异常时回 {ok:false} 而不抛，
        // 以前裸 await 让这个 catch 几乎永不触发，失败被悄悄丢掉；现在失败会真的进 catch。
        await call(api.setLastOpenChapter, state.bookPath, chapter.id, {
          title: state.meta && state.meta.title,
          chapterIndex: state.index,
          chapterName: chapter.name
        });
      } catch { /* 记不住也无所谓 */ }
      // 这一章有查找书签的话，按刚从磁盘读到的正文自动高亮（打开书签所在章就有；
      // 书签只存查询条件，命中位置仍按当前正文现算，正文改过也能重新定位）
      await restoreFindBookmarkForCurrentChapter();
      return { ok: true, data };
    } catch (err) {
      if (!stale()) {
        toast(`读取章节失败：${err.message}`, 'error');
        // 没有任何有效章节（典型：开书时目标章缺文件 / 超限 / 权限）：保持遮罩并写明原因，
        // 编辑区不接收输入、保存也没有可写目标（V101）。
        if (!state.loadedChapterId) {
          setChapterMask(true, '当前章节没有载入（文件缺失或读取失败），换一章或重新打开本书');
        }
      }
      return { ok: false, code: (err && err.code) || 'LOAD_FAILED', message: err && err.message };
    } finally {
      // 只有「还是当前这次载章」才允许清 loading / 唤醒等待者；过期回执交给新那次收尾。
      if (token === loadChapterSeq) {
        state.loading = false;
        notifyLoadingIdle();
      }
      applyEditorEditable();
    }
  }

  // WP10（P-N2）：保存后的全书校验走单飞 / 合并（纯逻辑在 save-logic.js）——
  // 同一本书在途时再保存只标记「结束后补一次」，连按 Ctrl+S 不会叠出 N 趟全量 stat；
  // 不同书互不影响。保存热路径仍不 await 校验（F2 语义不变）。
  const verifyBookScheduler = saveLogic.createVerifySingleFlight(async (bookPath) => {
    try {
      const verify = getTestVerifyBook() || ((target) => call(api.verifyBook, target));
      const report = await verify(bookPath);
      const warn = saveLogic.verifyWarnText(report);
      if (warn) toast(warn, 'warn');
    } catch (err) {
      console.warn('保存后的全书校验失败（已忽略，不影响保存结果）', err);
    }
  });

  function verifyBookInBackground(bookPath) {
    verifyBookScheduler.request(bookPath);
  }

  async function saveCurrent({ silent = false, force = false } = {}) {
    if (!state.bookPath || state.index < 0) {
      return { ok: false, code: 'NO_CHAPTER', message: '当前没有可保存的章节' };
    }
    if (state.saving) {
      return { ok: false, code: 'BUSY', message: '正在保存中，请稍候再试' };
    }
    if (!state.dirty) {
      if (!silent) toast('当前章节没有改动');
      updateStatus();
      return { ok: true, skipped: true };
    }
    const chapter = state.chapters[state.index];
    if (!chapter) return { ok: false, message: '章节不存在' };
    // WP-03（V101）：保存只认「编辑区里真正载入的那一章」。索引可能已经被另一次开书 / 切章推着走，
    // 但编辑区还是别处的内容——这种情况拒绝写盘并从磁盘重载，绝不把别书 / 别章的正文写进来。
    if (state.loadedChapterId !== chapter.id) {
      const message = '编辑区内容不属于当前章节，已拒绝保存并重新载入';
      state.saveError = message;
      updateStatus();
      if (!silent) toast(message, 'warn');
      await loadChapterAt(state.index);
      return { ok: false, code: 'CHAPTER_MISMATCH', message };
    }
    // C1（审计高优先级）：await 前先拍正文快照，之后只认这一份——以前回执到达后重读活值并把
    // dirty 置 false，IPC 往返（fsync / 书目 / 统计写盘）期间敲入的字没写盘却被并进基线：
    // 切章不再提醒（静默丢稿）、关窗时渲染层自报干净还绕过了主进程的交叉判定。
    // WP-03（C10）：同时拍下发起的 (bookPath, chapterId)，回执只按这一份身份落地。
    const bookPath = state.bookPath;
    const chapterId = chapter.id;
    const text = editorEl.value;
    // 审计修复 #5（V301）：把「载入时那一版磁盘 mtime」带进保存请求。主进程比对不符时抛
    // EXTERNAL_CHANGE（同步盘后台落盘 / 记事本改过 / 检测只 toast 过的场景都在这里被拦下），
    // 绝不静默覆盖外部那一版正文。force = 作者在对话框里明确选了「仍然覆盖保存」。
    const expectedMtimeMs = force ? 0 : state.loadedMtimeMs;
    state.saving = true;
    updateStatus();
    try {
      saveDepth += 1;
      // WP-01 验收锚点：?test=1 下 E2E 注入保存延迟；正常启动 testSaveChapter 恒为 null
      const data = await (getTestSaveChapter() || call)(api.saveChapter, bookPath, chapterId, text, expectedMtimeMs);
      // WP-03（C10）：保存在途时作者可能已经切章 / 换书。回执按快照章身份完成——
      // 快照那一章的字数缓存该更新，但当前章的 mtime / baseText / dirty / 状态栏一个字都不许回写。
      const sameBook = bookPath === state.bookPath;
      const sameChapter = sameBook && state.loadedChapterId === chapterId;
      const snapshotAt = sameBook
        ? state.chapters.findIndex((item) => item && item.id === chapterId)
        : -1;
      if (Number.isFinite(Number(data.chars)) && snapshotAt >= 0) {
        state.chapters[snapshotAt].chars = Number(data.chars);
        // 保存后同步本章字数缓存：章节列表的字数 / 「比上章短」提示跟着更新
        // B5（审计 P5）：千章书不再整表重建，只改这一条（+ 下一章的对比提示）；失配才退回整表。
        if (!syncChapterCharsAfterSave(snapshotAt)) renderChapterList();
      }
      if (!sameChapter) {
        // 书换了 = 这次保存属于上一本；章切了 = 回执属于快照那一章：都不碰眼前这一章。
        return { ok: true, data };
      }
      state.baseText = text;
      state.loadedMtimeMs = data.mtimeMs;
      // WP5（N1）：这一章已经落盘——旧崩溃草稿（只服务「未保存」状态）顺手删掉。
      if (getCrashRecoveryUi()) void getCrashRecoveryUi().noteSaved(bookPath, chapterId).catch(() => {});
      state.savedAt = new Date();
      state.saveError = null;
      // 保存期间作者又敲了字：磁盘里只有快照，编辑区多出来的内容必须保持未保存（C1 的核心）
      state.dirty = saveLogic.isDirtyAgainstSnapshot(text, editorEl.value);
      // 主进程已经把「这次保存带来的新增字数」记进 stats.json，返回的摘要直接显示，
      // 不再多跑一次 IPC（统计失败时 data.stats 为 null，界面保留旧数字）。
      if (data.stats) {
        state.stats = data.stats;
        if (data.stats.streak) state.streak = data.stats.streak;
        renderStatsUi();
      }
      // 写作时长：保存时顺手把还没上报的整秒记下（只影响统计，失败不影响保存结果）
      if (state.writeTimer.running || state.writeTimer.unsentMs > 0) void flushWriteTimer();
      updateStatus();
      // 保存后：这一章有查找书签的话，按刚写盘的新正文重新扫描定位。
      // 只在没有手动查找会话、或高亮本来就来自书签时做，免得覆盖作者正在看的其它查找结果。
      if (state.find.total === 0 || state.find.fromBookmark) {
        await restoreFindBookmarkForCurrentChapter();
      }
      // 保存热路径（代码审计 F2）：保存一成功就先刷新状态栏——章数直接用书目里的章节数
      // （保存不会增减章节，和以前 report.chapterCount 是同一个值），不再为了拿这个数字去等
      // 一趟全书校验（千章书每次 Ctrl+S 都在付这份成本）。
      // 1.3.0 T7（规范 C-05 / I-01）：保存成功**不再弹 toast**，反馈收敛到状态栏；
      // 原来 toast 里的完整摘要（章数 / 本章字数 / 快照 / 字数未计入）逐字保留，
      // 改挂到状态栏的 title 上（鼠标悬停可查），不再打断纸面。
      // 不采纳审计里「chars 没变就跳过 writeBookMeta」那条：那会冻结书目 updatedAt。
      if (!silent) {
        saveStatusUi.setSavedDetail(
          saveLogic.savedToastText({
            chapterCount: state.chapters.length,
            charsText: formatChars(data.chars),
            snapshotTaken: Boolean(data.snapshot && data.snapshot.taken),
            // C0（审计 #3 / E1）：字数基线读不到时主进程会带这个标记，提示「本次字数未计入」
            charsBaselineMissing: Boolean(data.charsBaselineMissing)
          })
        );
      }
      // 全书校验挪到后台：发现缺章才 warn（文案不变），校验本身失败只记日志，
      // 不阻塞保存热路径、也不再误报「已保存当前章（全书校验失败）」。
      verifyBookInBackground(bookPath);
      return { ok: true, data };
    } catch (err) {
      // 失败回执同样只认快照章身份：切走了就别把错误写到眼前这一章的状态栏上。
      const sameChapter = bookPath === state.bookPath && state.loadedChapterId === chapterId;
      // A7（审计 E4）：部分成功——正文已落盘、只有书目更新失败。不能按「保存失败」提示：
      // 正文不会丢，dirty 保持（再按一次保存会重写正文并重试书目），字数缓存先用主进程回的值更新。
      if (err.code === 'META_SAVE_FAILED' && err.bodySaved === true) {
        if (Number.isFinite(Number(err.chars))) {
          const at = state.chapters.findIndex((item) => item && item.id === chapterId);
          if (at >= 0) {
            state.chapters[at].chars = Number(err.chars);
            if (!syncChapterCharsAfterSave(at)) renderChapterList();
          }
        }
        if (!sameChapter) return { ok: false, code: err.code, message: err.message, bodySaved: true };
        // WP14 E-N6（审计低批）：正文已经落盘，mtime 跟着变了；把主进程带回的落盘 mtime 同步到
        // 「编辑器手上这一版」，下一次保存不会拿载入时的旧 mtime 比对而误报 EXTERNAL_CHANGE。
        state.loadedMtimeMs = saveLogic.retryMtimeMs(err, state.loadedMtimeMs);
        state.saveError = err.message;
        updateStatus();
        if (!silent) toast(err.message, 'warn');
        return { ok: false, code: err.code, message: err.message, bodySaved: true };
      }
      if (!sameChapter) return { ok: false, code: err.code, message: err.message };
      // WP1 补漏（M-N1）：META_CHANGED 也带回正文落盘后的新 mtime（同 META_SAVE_FAILED 口径），
      // 更新基线后下一次保存不再误报 EXTERNAL_CHANGE；冲突本身照报，dirty / 救稿语义不变。
      if (err.code === 'META_CHANGED') state.loadedMtimeMs = saveLogic.retryMtimeMs(err, state.loadedMtimeMs);
      state.saveError = err.message;
      updateStatus();
      // 审计修复 #5 / #6（V301 / V302）：两个「救稿出口」只在这两个码上出现——
      //   ① EXTERNAL_CHANGE：外部改动三选（覆盖 / 先另存一份 / 放弃我的修改并重载）；
      //   ② BOOK_MISSING / CHAPTER_MISSING：另存这一章为 txt… / 复制正文 / 留在这里。
      // 其余失败照旧只写状态栏 + 一条 toast；救稿出口自己弹完对话框后原样上抛失败结果。
      if (saveRescueUi.rescuePlanFor(err.code)) {
        return await saveRescueUi.handleSaveFailure(err, { silent, conflictBookPath: bookPath, conflictChapterId: chapterId });
      }
      if (!silent) toast(`保存失败：${err.message}`, 'error');
      return { ok: false, code: err.code, message: err.message };
    } finally {
      saveDepth -= 1;
      state.saving = false;
      // WP20（R-N2）：覆盖重入（saveCurrent → 救稿出口 → saveCurrent({force:true})）是同一笔用户
      // 保存的延续：内层 finally 只结算 saving，状态栏与等待者留给最外层 —— 一次保存恰好收尾一次。
      if (saveDepth === 0) {
        notifySavingIdle();
        updateStatus();
      }
    }
  }

  // 五-H2/H3/H5/M9（审计 BP-02 / BP-03 / L-F1 / L-F6 / SS-02）：统一「过渡前保存」原语。
  // 任何「保存成功后就要重载 / 覆盖编辑区 / 离开写作页 / 建新章」的过渡都必须走这里。原因是
  // **保存成功 ≠ 编辑区干净**：saveCurrent 的回执按发起时的正文快照重算 dirty（C1 的正确行为），
  // 保存 IPC 往返（fsync / 书目 / 统计写盘，冷盘/杀软下可达数百 ms）期间敲入的字会让 dirty 重新为 true。
  // 以前各入口只看 saved.ok 就继续，于是出现「保存期间输入」被重载 / 载新章静默覆盖（H1 族第六类入口）。
  //
  // 做法：先按调用方口径询问（silentFirst 时第一趟静默保存，与捕获面板「章节」的既有行为一致）；
  // 保存回执落地后复核 dirty，仍脏就再问一次，绝不带着未保存输入继续过渡。
  // 作者明确选「不保存 / 丢弃」时当场清脏并同步基线 / 状态栏——下游 reloadOpenBookFromDisk 的脏闸
  // 靠这个放行，否则会出现「磁盘已还原、编辑区没变、toast 假报成功」（BP-02 的确定性失效）。
  // 返回 { ok:true, discarded? } / { ok:false, canceled:true } / { ok:false, saved }（失败回执原样上抛）。
  async function saveForTransition(options = {}) {
    const {
      title = '保存后继续',
      message = '当前章节有未保存的修改。',
      saveLabel = '保存并继续',
      discardLabel = '不保存，丢弃修改',
      silentFirst = false
    } = options || {};
    // 询问期间可能换书（弹窗不阻塞其它入口）：脏标记属于哪本书必须按发起时这一本来判，
    // 绝不拿 A 书的「放弃修改」去清 B 书的脏标记。
    const startBookPath = state.bookPath;
    const sameStartBook = () =>
      String(state.bookPath == null ? '' : state.bookPath) === String(startBookPath == null ? '' : startBookPath);
    let silent = silentFirst === true;
    for (;;) {
      if (!state.dirty) return { ok: true };
      if (silent) {
        silent = false;
        const saved = await saveCurrent();
        if (!saved || saved.ok === false) return { ok: false, saved };
        continue; // 保存回执后复核 dirty：仍脏（保存期间又输入）就交给作者决定，不静默继续
      }
      const action = await askUnsaved({ title, message, saveLabel, discardLabel });
      if (action === 'cancel') return { ok: false, canceled: true };
      if (action !== 'save') {
        // 作者明确选择丢弃。只有仍是发起时那本书才清脏（换书后这份脏属于新书，见上面的身份说明）。
        if (sameStartBook()) {
          state.dirty = false;
          state.baseText = editorEl.value;
          updateStatus();
        }
        return { ok: true, discarded: true };
      }
      const saved = await saveCurrent();
      if (!saved || saved.ok === false) return { ok: false, saved };
      // 保存成功但编辑区仍脏 → 下一轮重新询问（不直接返回 ok）
    }
  }

  async function handleCloseRequest() {
    // 关窗前先把写作计时里没上报的整秒记下（异步：统计写失败也不影响关窗判断）
    await flushWriteTimer();
    if (state.modal) {
      api.closeReady(false);
      return;
    }
    // 关窗前先把顶栏弹层 / 排版 / 设置 / 导出这几层收掉：否则「保存 / 不保存 / 取消」的询问会被它们压住。
    // 收哪几层、按什么顺序由 renderer/esc-registry.js 的 CLEANUP 决定（**只 6 项，是有意的子集**：
    // 书籍信息 / 查找 / 灵感箱 / 插入碎片 / 校对 / 敏感词本来就不会挡着关窗询问，照改前口径不收）。
    for (const action of escLib.cleanupActions(escProbe())) escRun(action);
    // 五-M9（ES-2）：保存在途时先等它按快照章身份落定，再判定脏状态 / 弹三选一——否则
    // 「保存并退出」必然撞 BUSY 被当成「保存失败」弹误导框，「不保存退出」也可能被在途写入违背。
    for (;;) {
      if (state.saving) await waitForSavingIdle();
      if (!state.dirty || !state.bookPath) {
        api.closeReady(true);
        return;
      }
      const action = await askUnsaved({
        title: '退出前保存',
        message: '当前章节有未保存的修改，退出会丢失这些内容。',
        saveLabel: '保存并退出',
        discardLabel: '不保存退出'
      });
      if (action === 'cancel') {
        api.closeReady(false);
        return;
      }
      if (action === 'discard') {
        discardUnsavedForClose();
        api.closeReady(true);
        return;
      }
      const saved = await saveCurrent();
      if (!saved.ok) {
        // 五-M9：等过在途保存仍撞 BUSY（另一笔保存刚好又开始）——这是一句状态提示，不是「保存失败」；
        // 绝不弹「保存失败：正在保存中… / 仍要退出吗」诱导作者把正在写的稿子丢掉。
        if (saved.code === 'BUSY') {
          toast('正在保存中，请稍候再试', 'warn');
          api.closeReady(false);
          return;
        }
        const again = await openModal({
          title: '保存失败',
          message: `保存失败：${saved.message}\n仍要退出吗？`,
          buttons: [
            { label: '返回保存', value: 'cancel', kind: 'primary' },
            { label: '放弃修改退出', value: 'discard', kind: 'danger' }
          ],
          cancelValue: 'cancel'
        });
        if (again.action !== 'discard') {
          api.closeReady(false);
          return;
        }
        discardUnsavedForClose();
        api.closeReady(true);
        return;
      }
      // 五-H3 同口径：保存成功 ≠ 编辑区干净（保存期间又敲了字会让 dirty 重新为 true）——
      // 仍脏就回到三选一重新问，绝不把「保存并退出」当成已经保存干净。
      if (!state.dirty) {
        discardUnsavedForClose();
        api.closeReady(true);
        return;
      }
    }
  }

    return {
      loadChapterAt, saveCurrent, saveForTransition, updateStatus, discardUnsavedForClose,
      setChapterMask, applyEditorEditable,
      waitForLoadingIdle, notifyLoadingIdle, waitForSavingIdle, notifySavingIdle,
      verifyBookInBackground, handleCloseRequest
    };
  }

  return { create: createSaveChainUi, REQUIRED_HOST };
});
