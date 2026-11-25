// E2E 第 83 组（v1.8.2 WP5 / 审计 N1，中 #6；作者拍板项 1=B）：渲染崩溃自动重载 + 可选崩溃草稿。
//
// 验收锚点（作业卡 §3.6）：
//   1. 默认关：临时 userData 里没有 crash-drafts 目录（一个字节都不写）；tick 直接 DISABLED。
//   2. 打开开关 → 主进程建立会话（session.json 只在 userData）。
//   3. 新建临时书 + 未保存正文 → crashDraftTick → 草稿只在 userData\crash-drafts、
//      正文与编辑区逐字一致；书库（书目.json / 章节 txt / 书文件夹）一个字节都不变。
//   4. win.webContents.forcefullyCrashRenderer() → 主进程自动 reload → 新渲染进程 __cwTest.ready 回来
//      → 恢复提示出现（写明「不是自动保存」）。
//   5. 点「恢复这份草稿」→ 正文回到编辑区且 dirty=true（仍要 Ctrl+S 才写盘）→ 草稿删除。
//   6. 关开关 → 标记 + 草稿清空，之后不再写盘；删掉临时书，不给后面的组留垃圾。
//
// 自足：组文件只 require node 内建（静态闸门要求），书 / 草稿 / 配置都在临时 userData 与临时书库里。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group83CrashRecovery(t) {
  const {
    exec, check, waitFor, sleep, win, userData, storage, deleteBookWithRetry,
    // CLOSE-02：不真的销毁窗口（后面第 55 组多窗口还要用），用主进程判定断言「这次关窗会被放行」。
    resetCloseReady, waitCloseReady
  } = t;

  const TITLE = '崩溃恢复测试书';
  const DRAFT_TEXT = '崩溃草稿正文：这段还没按 Ctrl+S，只在编辑区里。\n第二行也要逐字回来。';
  const crashDraftsDir = path.join(userData, 'crash-drafts');
  const draftFileRe = /^draft-[a-f0-9]{16}\.json$/;
  let bookPath = null;
  let cleaned = false;

  const exists = async (target) => {
    try {
      await fs.stat(target);
      return true;
    } catch {
      return false;
    }
  };
  const listDraftFiles = async () => {
    try {
      return (await fs.readdir(crashDraftsDir)).filter((name) => draftFileRe.test(name));
    } catch {
      return [];
    }
  };

  const cleanup = async () => {
    cleaned = true;
    try {
      await exec('window.__cwTest.setCrashDraftEnabled(false)');
    } catch {
      /* 关闭失败也继续清现场 */
    }
    try {
      if ((await exec('window.__cwTest.dirty()')) === true) await exec('window.__cwTest.save()');
      await exec('window.__cwTest.backToShelf()');
      if (bookPath) await deleteBookWithRetry(bookPath);
      else await exec(`window.__cwTest.deleteBookByFolder(${JSON.stringify(TITLE)}, { skipConfirm: true })`);
      await exec('window.__cwTest.refreshShelf()');
    } catch (err) {
      console.warn('[e2e] 第 83 组收尾删临时书失败（留给排查）：', err.message);
    }
    await fs.rm(crashDraftsDir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    // ---------- 前导：回到书架（前面的组可能停在编辑区） ----------
    if ((await exec('window.__cwTest.dirty()')) === true) await exec('window.__cwTest.save()');
    if ((await exec('window.__cwTest.view()')) !== 'shelf') {
      await exec('window.__cwTest.backToShelf()');
      await waitFor("window.__cwTest.view() === 'shelf'");
    }

    // ---------- 83a. 默认关：一个字节都不写 ----------
    const dirBefore = await exists(crashDraftsDir);
    const statusOff = await exec('window.__cwTest.crashRecoveryStatus()');
    const tickOff = await exec('window.__cwTest.crashDraftTick()');
    const recoveryOff = await exec('window.api.crashRecovery()');
    check(
      '崩溃草稿（默认关）：临时 userData 里没有 crash-drafts 目录，tick / recovery 直接 DISABLED、不写盘',
      dirBefore === false &&
        statusOff &&
        statusOff.enabled === false &&
        tickOff &&
        tickOff.ok === false &&
        tickOff.code === 'DISABLED' &&
        recoveryOff &&
        recoveryOff.ok === true &&
        recoveryOff.data &&
        recoveryOff.data.enabled === false &&
        Array.isArray(recoveryOff.data.drafts) &&
        recoveryOff.data.drafts.length === 0 &&
        (await exists(crashDraftsDir)) === false,
      { dirBefore, statusOff, tickOff, recoveryOff }
    );

    // ---------- 83b. 打开开关 → 主进程建立会话（只写 userData） ----------
    const enabled = await exec('window.__cwTest.setCrashDraftEnabled(true)');
    await waitFor("window.__cwTest.crashRecoveryStatus().enabled === true");
    const sessionFile = path.join(crashDraftsDir, 'session.json');
    const sessionExists = await exists(sessionFile);
    let sessionMarker = null;
    try {
      sessionMarker = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
    } catch {
      sessionMarker = null;
    }
    check(
      '崩溃草稿（开）：开关打开后主进程写运行标记（crash-drafts/session.json 只在 userData）',
      enabled === true &&
        sessionExists &&
        sessionMarker &&
        Number.isFinite(Number(sessionMarker.pid)) &&
        Number(sessionMarker.pid) > 0 &&
        typeof sessionMarker.startedAt === 'string' &&
        Number.isNaN(Date.parse(sessionMarker.startedAt)) === false,
      { enabled, sessionExists, sessionMarker }
    );

    // ---------- 83c. 临时书 + 未保存正文 → 周期上报 → 草稿只在 userData ----------
    await exec(`window.__cwTest.newBook(${JSON.stringify(TITLE)})`);
    await waitFor("window.__cwTest.view() === 'editor'", 15000);
    const bookPathValue = await exec('window.__cwTest.bookPathValue()');
    bookPath = bookPathValue;
    await exec("window.__cwTest.renameChapterAt(0, '崩溃章')");
    const meta = await storage.readBookMeta(bookPath);
    const chapter = meta.chapters[0];
    const chapterFile = path.join(bookPath, chapter.file);
    await exec(`window.__cwTest.setText(${JSON.stringify(DRAFT_TEXT)})`);
    const metaBefore = await fs.readFile(path.join(bookPath, '书目.json'));
    const txtBefore = await fs.readFile(chapterFile);
    const bookEntriesBefore = await fs.readdir(bookPath);

    const tick = await exec('window.__cwTest.crashDraftTick()');
    const draftNames = await listDraftFiles();
    let draft = null;
    let draftText = '';
    try {
      // P2（一轮·中）：草稿拆成「元数据 .json + 正文 .txt」——列表 / 启动恢复只读元数据，
      // 正文单独存，readDraft 才读那一个文件。这里按新布局逐字核对正文。
      draft = JSON.parse(await fs.readFile(path.join(crashDraftsDir, draftNames[0]), 'utf8'));
      draftText = draft && typeof draft.body === 'string'
        ? await fs.readFile(path.join(crashDraftsDir, draft.body), 'utf8')
        : String((draft && draft.text) || '');
    } catch {
      draft = null;
    }
    const statusOn = await exec('window.__cwTest.crashRecoveryStatus()');
    check(
      '崩溃草稿：crashDraftTick 后草稿只在 userData\\crash-drafts，正文与编辑区逐字一致（P2：元数据与正文分文件）',
      tick &&
        tick.ok === true &&
        /^[a-f0-9]{16}$/.test(String(tick.draftId || '')) &&
        draftNames.length === 1 &&
        draft &&
        draft.text === undefined &&
        draft.body === `draft-${draft.draftId}.txt` &&
        draftText === DRAFT_TEXT &&
        draft.bookPath === bookPath &&
        draft.chapterId === chapter.id &&
        statusOn &&
        statusOn.lastDraftId === tick.draftId &&
        statusOn.lastSnapshotChars === DRAFT_TEXT.length,
      { tick, draftNames, draft: draft && { ...draft, text: undefined }, draftTextLen: draftText.length, statusOn }
    );
    const bookEntriesAfter = await fs.readdir(bookPath);
    check(
      '崩溃草稿：书库一个字节都不变（书目 / 章节 txt / 书文件夹都没多出草稿文件）',
      metaBefore.equals(await fs.readFile(path.join(bookPath, '书目.json'))) &&
        txtBefore.equals(await fs.readFile(chapterFile)) &&
        bookEntriesAfter.length === bookEntriesBefore.length &&
        bookEntriesAfter.includes('crash-drafts') === false &&
        bookEntriesAfter.some((name) => /^draft-.*\.json$/.test(name)) === false,
      { bookEntriesBefore, bookEntriesAfter }
    );

    // ---------- 83d. 渲染进程真崩溃 → 主进程自动 reload ----------
    // 先留一个只在旧渲染进程里存在的标记：reload 后读不到它，才算真的换了渲染进程。
    await exec('window.__cwE2ECrashReloadSentinel = 1; 1');
    win.webContents.forcefullyCrashRenderer();
    await waitFor('Boolean(window.__cwTest && window.__cwTest.ready)', 30000);
    const reloaded = await exec(`(() => ({
      ready: window.__cwTest.ready === true,
      sentinel: typeof window.__cwE2ECrashReloadSentinel,
      view: window.__cwTest.view(),
      status: window.__cwTest.crashRecoveryStatus()
    }))()`);
    check(
      '渲染崩溃：forcefullyCrashRenderer 后主进程自动 reload，新渲染进程 __cwTest.ready 回来',
      reloaded &&
        reloaded.ready === true &&
        reloaded.sentinel === 'undefined' &&
        reloaded.status &&
        reloaded.status.enabled === true,
      reloaded
    );

    // ---------- 83e. 恢复提示（一次性，写明「不是自动保存」） ----------
    await waitFor('window.__cwTest.modalOpen() === true', 20000);
    const dialog = await exec(`(() => {
      const modal = window.__cwTest.state.modal;
      if (!modal) return null;
      const buttons = (modal.opts.buttons || []).map((button) =>
        typeof button === 'string' ? { value: button } : { value: button.value, label: button.label, kind: button.kind }
      );
      return { title: modal.opts.title, message: modal.opts.message, cancelValue: modal.opts.cancelValue, buttons };
    })()`);
    const buttonValues = dialog && Array.isArray(dialog.buttons) ? dialog.buttons.map((button) => button.value) : [];
    check(
      '渲染崩溃：重载后出现恢复提示（书名 / 字数 / 不是自动保存；恢复 / 丢弃 / 先留着三个出口）',
      dialog &&
        dialog.title === '发现上次崩溃时未保存的稿子' &&
        dialog.message.includes(TITLE) &&
        dialog.message.includes(`${DRAFT_TEXT.length} 字`) &&
        dialog.message.includes('不是自动保存') &&
        buttonValues.join(',') === 'later,discard,restore' &&
        dialog.cancelValue === 'later',
      dialog
    );

    // ---------- 83e-2. 「先留着，下次再恢复」→ 写保留标记（CRASH-03） ----------
    // 这份草稿是**本次运行**（刚崩溃重载前）写的，ownerToken 就是本进程；主进程干净退出
    // endSession 默认清本进程草稿。「先留着」以前只是关掉对话框、什么都不写 = 作者选了保留，
    // 退出即丢。这里点「先留着」核对三件事：草稿文件仍在、元数据有 keep:true（跨退出有效）、
    // 正文没有进编辑区（不是恢复）。随后重跑一次恢复检查，确认它仍会被再问（下次启动同 Path）。
    await exec("window.__cwTest.answerModal('later')");
    let keptDraft = null;
    let keptNames = [];
    for (let i = 0; i < 50; i += 1) {
      keptNames = await listDraftFiles();
      keptDraft = null;
      if (keptNames.length === 1) {
        try {
          keptDraft = JSON.parse(await fs.readFile(path.join(crashDraftsDir, keptNames[0]), 'utf8'));
        } catch {
          keptDraft = null;
        }
      }
      if (keptDraft && keptDraft.keep === true) break;
      await sleep(120);
    }
    const afterLater = await exec(`(() => ({
      text: window.__cwTest.text(),
      dirty: window.__cwTest.dirty(),
      view: window.__cwTest.view()
    }))()`);
    check(
      '崩溃恢复（CRASH-03）：点「先留着」写入保留标记（keep=true），草稿仍在、正文未进编辑区；重跑恢复检查仍会再问',
      keptDraft &&
        keptDraft.keep === true &&
        keptDraft.draftId === draft.draftId &&
        afterLater &&
        afterLater.text !== DRAFT_TEXT &&
        afterLater.dirty === false,
      { keptNames, keep: keptDraft && keptDraft.keep, afterLater }
    );

    // 重跑恢复检查（不 await：它在等作者回答对话框）；草稿仍在 → 同一个恢复提示会再出现。
    await exec('(() => { void window.__cwTest.crashRecoveryCheck(); return true; })()');
    await waitFor('window.__cwTest.modalOpen() === true', 20000);

    // ---------- 83f. 点「恢复」→ 正文回来且 dirty=true → 草稿**保留**（旧M4） ----------
    await exec("window.__cwTest.answerModal('restore')");
    await waitFor(`window.__cwTest.text() === ${JSON.stringify(DRAFT_TEXT)}`, 20000);
    await waitFor('window.__cwTest.dirty() === true', 5000);
    // 旧M4（一轮·中）：恢复只把草稿标记成「本窗口已恢复」，**不删文件** —— 恢复出来的正文只在
    // 编辑区（仍未保存），草稿是它唯一的磁盘兜底；删掉再崩一次就彻底没救了。
    // 草稿只会在「成功 Ctrl+S」（保存链干净回执 → noteSaved）或「下一次周期草稿落盘覆盖」后消失。
    const draftsKept = (await listDraftFiles()).length === 1;
    const restored = await exec(`(() => ({
      text: window.__cwTest.text(),
      dirty: window.__cwTest.dirty(),
      bookPath: window.__cwTest.bookPathValue(),
      loaded: window.__cwTest.state.loadedChapterId,
      view: window.__cwTest.view()
    }))()`);
    check(
      '崩溃恢复：点「恢复」→ 正文逐字回到编辑区且 dirty=true（Ctrl+S 才写盘），草稿保留（旧M4：恢复当下不删）',
      restored &&
        restored.text === DRAFT_TEXT &&
        restored.dirty === true &&
        restored.view === 'editor' &&
        restored.bookPath === bookPath &&
        restored.loaded === chapter.id &&
        draftsKept === true,
      { restored, draftsKept, draftsLeft: await listDraftFiles() }
    );

    // ---------- 83g. 成功保存 → 草稿删除；关开关 → 清标记与草稿，之后不再写盘 ----------
    // 旧M4：草稿的删除时机挪到「成功 Ctrl+S」（保存链按快照身份调 noteSaved）之后。
    await exec('window.__cwTest.save()');
    await waitFor("window.__cwTest.dirty() === false");
    let draftsGoneAfterSave = false;
    for (let i = 0; i < 50; i += 1) {
      if ((await listDraftFiles()).length === 0) {
        draftsGoneAfterSave = true;
        break;
      }
      await sleep(120);
    }
    const disabled = await exec('window.__cwTest.setCrashDraftEnabled(false)');
    const filesAfterOff = await fs.readdir(crashDraftsDir).catch(() => []);
    const tickAfterOff = await exec('window.__cwTest.crashDraftTick()');
    const configAfterOff = JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8'));
    check(
      '崩溃草稿：成功保存后才删草稿；关开关后清空标记与草稿（目录里一个文件都不剩），tick 回到 DISABLED 不再写盘',
      draftsGoneAfterSave === true &&
        disabled === false &&
        filesAfterOff.length === 0 &&
        tickAfterOff &&
        tickAfterOff.code === 'DISABLED' &&
        configAfterOff.crashDraftEnabled === false,
      { draftsGoneAfterSave, disabled, filesAfterOff, tickAfterOff, crashDraftEnabled: configAfterOff.crashDraftEnabled }
    );

    // ---------- CLOSE-02：崩溃自动重载后主进程脏状态必须归零 ----------
    // 复现路径：编辑区有未保存正文 → 渲染进程崩溃 → 主进程自动 reload → 新文档停在书架，init
    // 不会再上报 app:dirty。旧实现下主进程 session.dirty 残留为 true，关窗时渲染层回 closeReady(true)，
    // 主进程仍按 CLOSE_DIRTY 静默拦下——窗口再也关不掉（作者只能强杀进程）。
    // 这里用主进程侧的 getCloseReady() 断言「这次关窗会被放行」，口径与第 10 / 12 组一致：
    // 默认不真关窗（e2eRealClose=false），所以窗口还在，后面的多窗口组不受影响。
    await exec("window.__cwTest.setText('崩溃重载后仍未保存的一段字')");
    await waitFor('window.__cwTest.dirty() === true', 5000);
    win.webContents.forcefullyCrashRenderer();
    await waitFor('Boolean(window.__cwTest && window.__cwTest.ready)', 30000);
    const freshAfterReload = await exec(`(() => ({
      view: window.__cwTest.view(),
      dirty: window.__cwTest.dirty(),
      status: window.__cwTest.crashRecoveryStatus()
    }))()`);
    resetCloseReady();
    win.webContents.send('app:close-requested');
    const closeAllowedAfterReload = await waitCloseReady();
    check(
      '关闭回归（CLOSE-02）：崩溃自动重载后主进程脏状态已重置，关窗不再被 CLOSE_DIRTY 永久拦下（判定放行且窗口仍在）',
      freshAfterReload &&
        freshAfterReload.view === 'shelf' &&
        freshAfterReload.dirty === false &&
        freshAfterReload.status &&
        freshAfterReload.status.enabled === false &&
        closeAllowedAfterReload === true &&
        win.isDestroyed() === false,
      { freshAfterReload, closeAllowedAfterReload }
    );

    // ---------- 收尾：删临时书 ----------
    // 刚经历「崩溃 → 重载 → 恢复 → 保存」的目录在 Windows 上偶发一次 rename EPERM（杀软 / 索引器还攥着句柄），
    // 用 harness 的 deleteBookWithRetry（真实 Electron 删书重试 10 次）而不是一次性调用。
    await exec('window.__cwTest.backToShelf()');
    await waitFor("window.__cwTest.view() === 'shelf'");
    const deleted = await deleteBookWithRetry(bookPath);
    await exec('window.__cwTest.refreshShelf()');
    let gone = false;
    for (let i = 0; i < 50; i += 1) {
      const titles = await exec('window.__cwTest.shelfTitles()');
      if (Array.isArray(titles) && titles.includes(TITLE) === false && (await exists(bookPath)) === false) {
        gone = true;
        break;
      }
      await sleep(120);
    }
    const remaining = await exec('window.__cwTest.shelfTitles()');
    check(
      '崩溃恢复：临时书已从书架移除（不给后面的多窗口组留垃圾）',
      Boolean(deleted && deleted.ok === true) &&
        gone === true &&
        Array.isArray(remaining) &&
        remaining.includes(TITLE) === false &&
        (await exists(bookPath)) === false,
      { deleted, remaining, bookPath, bookExists: await exists(bookPath) }
    );
  } finally {
    if (!cleaned) await cleanup();
  }
};