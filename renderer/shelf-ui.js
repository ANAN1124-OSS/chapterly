/* 书架交互（v0.9 B-5 第六刀：从 renderer.js 三个小分区整段搬出来）。
 *
 * 搬走的三段（原 renderer.js 行号，均为相邻或独立小分区）：
 *   「继续上次写作」1040–1081（42 行）—— 书架头的继续写作卡：找最近一本可继续的书、
 *     渲染「继续写《书名》 · 第N章：xxx」与「最后写作 … · 共 N 章」，以及打开那本书；
 *   「同步冲突副本提示」1082–1108（27 行）—— 冲突副本清单对话框的打开 / 关闭
 *     （只提示、不合并、不动文件，自动处理风险太大）；
 *   「切换 / 新建 / 重命名 / 删除」3824–3850（27 行）—— 当前章节标签 + 切章
 *     （含未保存修改的 askUnsaved 拦截）。
 * 合计 96 行。**只碰渲染层与一次 state 读取**：不写盘、不改正文、不碰 IPC 白名单、不改 config、
 * 不改数据格式；文案 / class / DOM 结构 / 返回值形状全部照旧。
 *
 * 契约：createShelfUi(host) 由渲染层调用一次，host 提供：
 *   host = {
 *     $, state, chapterTitle, formatRelativeTime,
 *     openBookByPath, askUnsaved, saveCurrent, loadChapterAt,
 *     waitForSavingIdle, waitForLoadingIdle,  // 可选：切章前等「保存在途 / 载章在途」落定（WP-03）
 *     // 可选（B2 / WP18）：shelf:changed 增量刷新。缺任何一个 → handleShelfChanged 退回整表刷新。
 *     api, call, renderShelf, refreshShelf, refreshStats, markCommandsDirty,
 *     patchShelfCard                           // 可选（RSHE-C-01）：单卡 DOM 增量；false 时退回整表
 *   }
 * 缺任何一个直接抛 TypeError（宁可在启动时炸，也不要到点书架 / 切章时 ReferenceError）。
 * host 成员全是一次性解构的稳定引用；它们在渲染层都是函数声明（会提升）或先于装配点的
 * const，所以装配点即使比 openBookByPath / saveCurrent / loadChapterAt 的声明位置靠前也不影响。
 *
 * 为什么这三块合成一刀：它们同属「书架 / 切章」这一层，彼此没有调用关系
 * （continueTarget 只在本模块内用，不对外导出），但都很小；一次装配、一次加载顺序、一条
 * commit 比连开三刀更省验证成本。
 *
 * 搬过来的东西（行为一字未改）：
 *   - 继续写作卡：continueTarget 的取书规则（recentBook 按 path 小写比对；找不到 / corrupt 就当没有）、
 *     章节下标夹取（Math.round → 夹到 total-1）、标题与 title 属性、元信息拼接、hidden 切换；
 *   - 冲突副本对话框：state.conflictBook 记在渲染层状态上、清单逐行建 div.conflict-file、
 *     backdrop 的 hidden 切换；
 *   - 切章：同章直接 { ok: true, same: true }、越界「章节不存在」、dirty 时 askUnsaved 询问
 *     （取消 → { ok: false, canceled: true }；保存失败原样透传）、最后 loadChapterAt。
 *     轮询在途时先等载章 / 保存在途落定（C9 / C10），等完重新核对目标章与 dirty。
 *
 * B2（WP18 / 审计中 #18）追加一段：handleShelfChanged —— 主进程广播 shelf:changed 时，
* bookPath 非空只重读那一张书卡（O(1)），result 为空 / 删除时按语义删卡，无路径才整表刷新。
* 这一段只读 state.books 并写回新数组 + 调宿主给的 renderShelf，不碰 IPC 白名单。
*
* 红线不变：只读 state（冲突对话框写 state.conflictBook，与搬之前同一行）、只改 DOM；
 * 本模块不注册任何事件监听、不进 Esc 动作表、不改测试钩子的宿主契约——
 * 事件绑定 / Esc 动作表 / 测试钩子仍在 renderer.js 里按名字取这几个 const。
 *
 * 浏览器里挂成全局 CWShelfUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../core/assert-host').assertHost);
  } else if (root) {
    root.CWShelfUi = factory(root.CWAssertHost && root.CWAssertHost.assertHost);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (assertHost) {
  'use strict';

  const REQUIRED_HOST = ['$', 'state', 'chapterTitle', 'formatRelativeTime', 'openBookByPath', 'askUnsaved', 'saveCurrent', 'loadChapterAt'];

  function createShelfUi(host) {
    // A8（WP-32）：REQUIRED_HOST 逐成员校验走共享实现（文案不变）。
    assertHost('createShelfUi', host, REQUIRED_HOST);
    const { $, state, chapterTitle, formatRelativeTime, openBookByPath, askUnsaved, saveCurrent, loadChapterAt, waitForSavingIdle, waitForLoadingIdle } = host;
    // B2（WP18）：书架增量刷新的**可选**宿主成员 —— 缺任何一个就退回整表刷新（旧宿主 / 单测不受影响）。
    const api = host.api || null;
    const callApi = typeof host.call === 'function' ? host.call : null;
    const renderShelfNow = typeof host.renderShelf === 'function' ? host.renderShelf : null;
    // RSHE-C-01：单卡 DOM 增量（可选）。返回 false = 顺序 / 筛选集变了，退回 renderShelf 整表。
    const patchShelfCard = typeof host.patchShelfCard === 'function' ? host.patchShelfCard : null;
    const refreshShelfAll = typeof host.refreshShelf === 'function' ? host.refreshShelf : null;
    const refreshShelfStats = typeof host.refreshStats === 'function' ? host.refreshStats : null;
    const markCommandsDirty = typeof host.markCommandsDirty === 'function' ? host.markCommandsDirty : null;
  // ---------- 继续上次写作 ----------
  // 主进程在打开书 / 切章 / 保存时记 config.lastBook；这里只负责把它显示出来。
  // 书架里已经找不到那本书（被删/改名）或是损坏书时，入口直接隐藏，不做任何猜测。
  function continueTarget() {
    const recent = state.recentBook;
    if (!recent || !recent.path) return null;
    const wanted = String(recent.path).toLowerCase();
    const book = (state.books || []).find((item) => String(item.path || '').toLowerCase() === wanted);
    if (!book || book.status === 'corrupt') return null;
    return { book, recent };
  }

  function renderContinueWriting() {
    const wrap = $('shelf-continue');
    if (!wrap) return;
    const target = continueTarget();
    if (!target) {
      wrap.classList.add('hidden');
      return;
    }
    const { book, recent } = target;
    const total = Math.max(0, Number(book.chapterCount) || 0);
    let chapterIndex = Math.max(0, Math.round(Number(recent.chapterIndex) || 0));
    if (total > 0) chapterIndex = Math.min(chapterIndex, total - 1);
    const label = total > 0 ? chapterTitle(chapterIndex, recent.chapterName) : '';
    const title = `继续写《${book.title}》${label ? ` · ${label}` : ''}`;
    $('continue-title').textContent = title;
    $('continue-title').title = title;
    const metaParts = [];
    if (recent.at) metaParts.push(`最后写作 ${formatRelativeTime(recent.at)}`);
    if (total > 0) metaParts.push(`共 ${total} 章`);
    $('continue-meta').textContent = metaParts.join(' · ');
    wrap.classList.remove('hidden');
  }

  async function openContinueBook() {
    const target = continueTarget();
    if (!target) return { ok: false, message: '没有可继续的书' };
    await openBookByPath(target.book.path);
    return { ok: state.view === 'editor', index: state.index };
  }

  // ---------- 同步冲突副本提示 ----------
  // 只提示、不合并、不动文件：冲突副本可能含用户没合并的手稿，自动处理风险太大。
  function openConflictDialog(book) {
    if (!book) return;
    const conflicts = Array.isArray(book.conflicts) ? book.conflicts.slice() : [];
    if (!conflicts.length) return;
    state.conflictBook = book;
    $('conflict-book').textContent = `《${book.title || book.folder}》 · ${book.path || ''}`;
    $('conflict-book').title = book.path || '';
    $('conflict-summary').textContent = `共 ${conflicts.length} 个冲突副本（只提示，不会自动合并或删除）`;
    const list = $('conflict-files');
    list.innerHTML = '';
    for (const name of conflicts) {
      const row = document.createElement('div');
      row.className = 'conflict-file';
      row.textContent = name;
      row.title = name;
      list.appendChild(row);
    }
    $('conflict-backdrop').classList.remove('hidden');
  }

  function closeConflictDialog() {
    state.conflictBook = null;
    $('conflict-backdrop').classList.add('hidden');
  }

  // ---------- 书架增量刷新（B2 / WP18 / 审计中 #18） ----------
  // 主进程每次写 mutation 成功都会广播 shelf:changed = { reason, bookPath }：
  //   · bookPath 非空 → 只重读这一张书卡（books:card，O(1)），替换 / 插入 + 按 lastModified 重排；
  //   · reason === 'book:delete' → 直接从书架删卡（目录已搬走，读盘必然失败，不白试一次）；
  //   · bookPath 为空（多本导入等结构性变更）→ 整表刷新，与改动前完全一致。
  // 任何一步不可用 / 读失败都退回整表刷新：宁可多读一遍，也不能把书卡从书架上弄丢。
  const sameBookPath = (left, right) =>
    String(left == null ? '' : left).toLowerCase() === String(right == null ? '' : right).toLowerCase();

  // 五-M6（SS-03）：增量读卡的世代复核。
  // shelf:changed 只说「哪本书变了」，读卡是异步的；广播一到就推进这本书的世代号（删书也算一次），
  // 在途回执回来时只有仍是最新一代才允许落地。否则「删书广播 + 在途读卡」会把已删书卡插回书架
  // （点它弹「修复」），同书两次变更的回执乱序到达时旧卡还会盖掉新卡。
  // 整表刷新取代此前所有增量读卡，同样推进会话世代，让刷新前发出的回执一并作废。
  let shelfCardSeq = 0;
  let shelfFullEpoch = 0;
  const shelfCardSeqByPath = new Map(); // 小写 path → 这本书最新一次广播的序号

  function applyShelfCard(card, bookPath) {
    const books = Array.isArray(state.books) ? state.books.slice() : [];
    const at = books.findIndex((book) => sameBookPath(book && book.path, bookPath));
    if (at >= 0) books[at] = card;
    else books.push(card);
    books.sort((a, b) => (Number(b && b.lastModified) || 0) - (Number(a && a.lastModified) || 0));
    state.books = books;
  }

  async function handleShelfChanged(payload) {
    const reason = payload && typeof payload.reason === 'string' ? payload.reason : '';
    const bookPath = payload && typeof payload.bookPath === 'string' ? payload.bookPath : '';
    // 五-M6（SS-03）：广播一到就推进这本书的世代（先于所有 await / 早退），
    // 之后到达的旧回执据此知道自己已被更新的一次广播（含删书）取代。
    const cardSeq = bookPath ? ++shelfCardSeq : 0;
    if (bookPath) shelfCardSeqByPath.set(bookPath.toLowerCase(), cardSeq);
    const epochAtStart = shelfFullEpoch;
    // 写作页不打断作者（回书架时会整表刷新）；导入 / 整本整理期间的广播也不插手。
    if (state.view !== 'shelf' || state.importing || state.formatBookRunning) return { mode: 'skipped' };
    const canIncrement = Boolean(
      bookPath && api && typeof api.readBookCard === 'function' && callApi && renderShelfNow
    );
    if (!canIncrement || !refreshShelfAll) {
      if (typeof refreshShelfAll === 'function') {
        shelfFullEpoch += 1; // 整表刷新取代此前所有增量读卡（刷新前发出的回执作废）
        await refreshShelfAll();
      }
      return { mode: 'full' };
    }
    if (reason === 'book:delete') {
      const before = Array.isArray(state.books) ? state.books.length : 0;
      state.books = (state.books || []).filter((book) => !sameBookPath(book && book.path, bookPath));
      if (state.books.length === before) return { mode: 'remove', removed: false };
      renderShelfNow();
      if (typeof refreshShelfStats === 'function') Promise.resolve(refreshShelfStats()).catch(() => {});
      return { mode: 'remove', removed: true };
    }
    let card = null;
    try {
      card = await callApi(api.readBookCard, bookPath);
    } catch {
      card = null; // 坏书 / 路径失效：下面的整表兜底
    }
    if (!card || typeof card !== 'object' || Array.isArray(card) || typeof card.path !== 'string') {
      shelfFullEpoch += 1; // 读失败 → 整表兜底，同样取代在途的增量读卡
      await refreshShelfAll();
      return { mode: 'full' };
    }
    // 五-M6（SS-03）：回执落地前复核世代 —— 期间这本书被删 / 又有更新的一次变更，
    // 或发生过整表刷新 → 丢弃，不插卡、不重画（否则已删书卡会被插回书架）。
    if (epochAtStart !== shelfFullEpoch || shelfCardSeqByPath.get(bookPath.toLowerCase()) !== cardSeq) {
      return { mode: 'stale' };
    }
    applyShelfCard(card, bookPath);
    if (typeof markCommandsDirty === 'function') markCommandsDirty(); // 书名可能变，命令面板「书」条目要重建
    // RSHE-C-01：优先只换这一张书卡的 DOM；顺序 / 筛选集变了（或宿主没给增量入口）再整表渲染。
    const patched = patchShelfCard ? patchShelfCard(bookPath) : false;
    if (!patched) renderShelfNow();
    // 字数 / 今日统计：只读 stats.json，不重扫全书架（与 refreshShelf 的统计刷新同口径）
    if (typeof refreshShelfStats === 'function') Promise.resolve(refreshShelfStats()).catch(() => {});
    return { mode: 'card' };
  }

  // ---------- 切换 / 新建 / 重命名 / 删除 ----------
  function currentChapterLabel() {
    if (state.index < 0 || !state.chapters[state.index]) return '当前章节';
    return chapterTitle(state.index, state.chapters[state.index].name);
  }

  async function switchChapter(index, options = {}) {
    if (index === state.index) return { ok: true, same: true };
    if (index < 0 || index >= state.chapters.length) return { ok: false, message: '章节不存在' };
    // WP-03（C10）：保存在途时先等它按快照章身份完成，再按「剩下真正没保存的字」询问——
    // 否则作者刚选的「不保存」会被在途写入违背（账已按快照章结算，不写新章的 mtime / 字数）。
    if (state.saving && typeof waitForSavingIdle === 'function') await waitForSavingIdle();
    // WP-03（C9）：载章在途时等它落定；同一时刻只让最后一次点击生效，不在交错里互相覆盖。
    if (state.loading && typeof waitForLoadingIdle === 'function') await waitForLoadingIdle();
    // 等待期间现场可能已经变了（书换了 / 目标章没了 / 已经停在目标章）：重新核对一遍再动手。
    if (index === state.index) return { ok: true, same: true };
    if (index < 0 || index >= state.chapters.length) return { ok: false, message: '章节不存在' };
    if (state.dirty) {
      // REDT-B-01（高）：保存成功 ≠ 编辑区干净。saveCurrent 的回执按发起时的快照重算 dirty
      // （保存 IPC 往返期间敲入的字不在磁盘上）；以前这里只看 saved.ok 就 loadChapterAt，
      // 而载章成功会无条件 `state.dirty = false; editorEl.value = data.text`，那部分字被静默
      // 覆盖且无法撤销。与 saveForTransition 同一纪律：保存回执落地后复核 dirty，仍脏就回到
      // 询问再走一轮，绝不带着未落盘输入切章。
      let forcedAction = options.dirtyAction;
      for (;;) {
        if (!state.dirty) break;
        let action = forcedAction;
        // 显式 dirtyAction 只对调用时那一份脏负责：保存在途又敲了字（dirty 重新为真）时按正常
        // 询问处理，不让一次「保存」授权把之后的新输入也一起丢掉。
        forcedAction = null;
        if (!action) {
          action = await askUnsaved({
            title: '切换章节前保存',
            message: `「${currentChapterLabel()}」有未保存的修改，切换会丢失这些内容。`
          });
        }
        if (action === 'cancel') return { ok: false, canceled: true };
        if (action !== 'save') break; // 丢弃：loadChapterAt 成功后自行清脏并覆盖编辑区
        const saved = await saveCurrent();
        if (!saved || saved.ok !== true) return saved;
      }
    }
    await loadChapterAt(index);
    return { ok: true };
  }

    return {
      renderContinueWriting,
      openContinueBook,
      openConflictDialog,
      closeConflictDialog,
      currentChapterLabel,
      switchChapter,
      // B2（WP18）：shelf:changed 的增量处理器（宿主没给增量成员时自动退回整表刷新）
      handleShelfChanged
    };
  }

  return { create: createShelfUi, REQUIRED_HOST };
});
