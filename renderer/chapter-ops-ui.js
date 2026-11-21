/* 章节模板 / 分卷 / 批量动作（WP17 A3 第四刀：从渲染层编排器整段搬出来）。
 *
 * 搬走的一段（22 个函数式单元）：
 *   · 章节模板 —— chapterTemplateText / applyChapterTemplate / applyMetaAndRelocate / createChapterAt；
 *   · 分卷操作 —— createVolumeFlow / renameVolumeFlow / moveVolumeFlow / deleteVolumeFlow /
 *     openVolumeChooserInMenu / moveChapterToVolume / renameChapterAt / deleteChapterAt /
 *     activateDeleteUndo / updateChapterInfo / setChapterStatusAt；
 *   · 批量动作 —— deleteSelectedChapters / activateBatchDeleteUndo / moveSelectedChaptersToVolume /
 *     setSelectedChaptersStatus / exportSelectedChapters / copySelectedChapters / editChapterNoteAt。
 * **只搬不改行为**：函数体与行为注释逐字保留（含 _trash 撤销凭证 / 原下标插回 / 未保存拦截等红线）。
 * 撤销槽（undoUi）与共享 state 仍归编排器，模块通过 host 注入读写，不新增第二份状态。
 *
 * 契约：createChapterOpsUi(host) 由渲染层在 bindEvents 之前装配一次；缺成员在装配时 TypeError
 * （宁可在启动时炸，也不要到点新建章节才 ReferenceError）。host 成员见 REQUIRED_HOST，全部是
 * 编排器里已绑定的 const / 提升函数。
 * 编排器仍保留同名包装（函数声明会提升），调用点 / 测试钩子一个字都不改。
 *
 * 浏览器里挂成全局 CWChapterOpsUi（index.html 排在编排器之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../core/assert-host').assertHost);
  } else if (root) {
    root.CWChapterOpsUi = factory(root.CWAssertHost && root.CWAssertHost.assertHost);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (assertHost) {
  'use strict';

  const REQUIRED_HOST = [
    'state',
    'api',
    'call',
    'toast',
    'editorEl',
    '$',
    'chaptersLib',
    'templateLib',
    'CHAPTER_STATUS_LABELS',
    'promptText',
    'askUnsaved',
    'chapterTitle',
    'chapterStatus',
    'chapterNote',
    'formatCount',
    'chapterVolumeId',
    'volumeList',
    'volumeById',
    'volumeDisplayName',
    'chapterMenuIsBatch',
    'selectedChapterIndexes',
    'clearChapterSelection',
    'currentChapterId',
    'currentChapterLabel',
    'renderChapterList',
    'renderEditorHeader',
    'syncChapterFilterUi',
    'syncVolumeHeaderName',
    'syncChapterItemInfo',
    'syncChapterBatchBar',
    'markCommandsDirty',
    'updateStatus',
    'loadChapterAt',
    'saveCurrent',
    'refreshShelf',
    'flushWriteTimer',
    'undoUi',
    'moveChapterByDrop',
    'openExportDialog',
    'replaceEditorTextNative',
    'onEditorInput',
    'recordFallbackWrite',
    'scrollCaretIntoView',
    'placeMenuAt'
  ];

  function createChapterOpsUi(host) {
    assertHost('createChapterOpsUi', host, REQUIRED_HOST);
    const {
      state,
      api,
      call,
      toast,
      editorEl,
      $,
      chaptersLib,
      templateLib,
      CHAPTER_STATUS_LABELS,
      promptText,
      askUnsaved,
      chapterTitle,
      chapterStatus,
      chapterNote,
      formatCount,
      chapterVolumeId,
      volumeList,
      volumeById,
      volumeDisplayName,
      chapterMenuIsBatch,
      selectedChapterIndexes,
      clearChapterSelection,
      currentChapterId,
      currentChapterLabel,
      renderChapterList,
      renderEditorHeader,
      syncChapterFilterUi,
      syncVolumeHeaderName,
      syncChapterItemInfo,
      syncChapterBatchBar,
      markCommandsDirty,
      updateStatus,
      loadChapterAt,
      saveCurrent,
      refreshShelf,
      flushWriteTimer,
      undoUi,
      moveChapterByDrop,
      openExportDialog,
      replaceEditorTextNative,
      onEditorInput,
      recordFallbackWrite,
      scrollCaretIntoView,
      placeMenuAt
    } = host;

  // ---------- 章节模板（v0.8 P0 N5） ----------
  // 模板只存在全局配置 chapterTemplate（旧配置没有 = 不套用）；这里只负责把展开后的
  // 文字填进编辑区——不写盘、不改书目、不动章节文件，Ctrl+S 才保存，可 Ctrl+Z 撤销。
  function chapterTemplateText() {
    const cfg = state.globalConfig || state.config || {};
    return templateLib.sanitizeTemplate(cfg.chapterTemplate);
  }

  function applyChapterTemplate(chapterIndex, chapterName) {
    const template = chapterTemplateText();
    if (!templateLib.hasTemplate(template)) return { applied: false, reason: 'NO_TEMPLATE' };
    if (!templateLib.isBlankText(editorEl.value)) return { applied: false, reason: 'NOT_EMPTY' };
    const text = templateLib.applyTemplate(template, {
      chapterNumber: chaptersLib.chapterNumber(state.meta, chapterIndex),
      chapterName: chapterName || '',
      now: new Date()
    });
    if (!text.trim()) return { applied: false, reason: 'EMPTY_RESULT' };
    // 空章（可能只剩空白）整段替换成模板；用原生输入保住 Ctrl+Z 撤销链
    const before = editorEl.value;
    editorEl.focus();
    editorEl.setSelectionRange(0, before.length);
    const inserted = replaceEditorTextNative(text);
    let fallbackUsed = false;
    if (!inserted || editorEl.value !== text) {
      // 极端兜底：execCommand 不可用时手动替换（会丢原生撤销链，但不会丢内容）
      editorEl.value = text;
      fallbackUsed = true;
    }
    // 统一走 onEditorInput：标记未保存、刷新字数 / 状态栏 / 标记层
    onEditorInput();
    // 审计修复 #39（V402）：兜底整串赋值会清空浏览器撤销栈 —— 记一次性快照并提示（放在输入处理之后）
    if (fallbackUsed) recordFallbackWrite({ before, after: text, start: before.length, label: '套用章节模板' });
    const caret = editorEl.value.length;
    editorEl.setSelectionRange(caret, caret);
    scrollCaretIntoView(caret);
    return { applied: true, text, chars: text.length };
  }

  // 章节 / 分卷类写盘成功后统一收口：把主进程返回的 data.meta 换进 state（书目 + 章节数组），
  // 并按「操作前的当前章 id」把它找回来 —— 移动 / 插入 / 删除之后旧下标已经不可靠。
  // currentId 省略 = 只换书目（章节顺序和 id 都没变的场景：重命名章节 / 改章节信息 / 新建章节等）。
  // 返回当前章在新数组里的下标（-1 = 找不到；调用方自己决定保留原下标还是回第 0 章 / 交给 loadChapterAt）。
  // 只动 state，不重画 DOM：各入口要重画的范围本来就不同（有的还要重画顶栏 / 状态栏）。
  function applyMetaAndRelocate(data, currentId) {
    state.meta = data.meta;
    state.chapters = data.meta.chapters;
    // 书目 / 章节数组换了：命令面板的章节标题与章号要按新书目重建（1.5.0 P0-6）。
    markCommandsDirty();
    if (!currentId) return -1;
    const at = state.chapters.findIndex((c) => c && c.id === currentId);
    if (at >= 0) state.index = at;
    return at;
  }

  async function createChapterAt(insertIndex, nameOverride, volumeIdOverride) {
    if (!state.bookPath) return { ok: false };
    // 作者要求（2026-10-31）：新建 / 插入章节前，当前章有未保存修改就自动保存，不再弹窗
    if (state.dirty) {
      const saved = await saveCurrent();
      if (!saved.ok) return saved; // 保存失败会弹错误提示并停在这里，不建新章
    }
    const appending = insertIndex >= state.chapters.length;
    // 新章默认落在「当前章所在的卷」；从卷菜单进来时用指定的卷
    const currentChapter = state.chapters[state.index];
    const volumeId =
      volumeIdOverride !== undefined ? volumeIdOverride : chapterVolumeId(currentChapter);
    let name = nameOverride;
    if (name === undefined) {
      name = await promptText({
        title: appending ? '新建章节' : '插入章节',
        message:
          '输入章节名，可留空（只显示章号）。章号由顺序自动生成，不用自己写。' +
          (volumeId ? `\n新章会放进「${volumeDisplayName(volumeId)}」。` : ''),
        placeholder: '例如：夜雨'
      });
      if (name === null) return { ok: false, canceled: true };
    }
    try {
      const data = await call(api.createChapter, state.bookPath, insertIndex, name, volumeId || null);
      applyMetaAndRelocate(data);
      // 新章名不一定命中当前筛选：清掉筛选，保证刚建好的章在目录里看得见（输入框同步清空）
      if (state.chapterFilter) {
        state.chapterFilter = '';
        syncChapterFilterUi();
      }
      await loadChapterAt(data.index);
      // 章节模板：只填进编辑区（未保存、可 Ctrl+Z），绝不自动写盘
      const templateResult = applyChapterTemplate(data.index, data.chapter.name);
      const where = volumeId ? `（${volumeDisplayName(volumeId)}）` : '';
      const templateNote = templateResult.applied ? ' · 已套用章节模板（未保存，Ctrl+S 写盘）' : '';
      toast(`${appending ? '已新建' : '已插入'}：${chapterTitle(data.index, data.chapter.name)}${where}${templateNote}`);
      return { ok: true, index: data.index, template: templateResult };
    } catch (err) {
      toast(`新建章节失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  // ---------- 分卷操作 ----------
  async function createVolumeFlow(nameOverride) {
    if (!state.bookPath) return { ok: false };
    let name = nameOverride;
    if (name === undefined) {
      name = await promptText({
        title: '新建卷',
        message: '输入卷名（原文自带「第N卷」的书照抄原文即可）。卷只影响侧栏分组和导出，不改章号。',
        placeholder: '例如：第1卷：单篇'
      });
      if (name === null) return { ok: false, canceled: true };
    }
    try {
      const data = await call(api.createVolume, state.bookPath, name);
      // 分卷操作不改变章节顺序，当前章还是同一张卡片；按 id 找回来即可（找不到就不动下标）
      const currentId = (state.chapters[state.index] || {}).id;
      applyMetaAndRelocate(data, currentId);
      renderChapterList();
      updateStatus();
      toast(`已新建卷：${volumeDisplayName(data.volume.id)}`);
      return { ok: true, volume: data.volume };
    } catch (err) {
      toast(`新建卷失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  async function renameVolumeFlow(volumeId, nameOverride) {
    if (!state.bookPath || !volumeId) return { ok: false };
    let name = nameOverride;
    if (name === undefined) {
      name = await promptText({
        title: '重命名卷',
        message: '只改卷名，不影响里面的章节。',
        value: volumeDisplayName(volumeId),
        placeholder: '卷名'
      });
      if (name === null) return { ok: false, canceled: true };
    }
    try {
      const data = await call(api.renameVolume, state.bookPath, volumeId, name);
      applyMetaAndRelocate(data);
      // B17：卷改名只改卷头文字；找不到卷头 / 筛选生效时退回整表重建
      if (!syncVolumeHeaderName(volumeId)) renderChapterList();
      toast('已重命名卷');
      return { ok: true };
    } catch (err) {
      toast(`重命名卷失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  // 卷上下移动（只改卷序，章节跟着卷走）
  async function moveVolumeFlow(volumeId, delta) {
    if (!state.bookPath || !volumeId) return { ok: false };
    const volumes = volumeList();
    const from = volumes.findIndex((v) => v.id === volumeId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= volumes.length) return { ok: false };
    try {
      const data = await call(api.moveVolume, state.bookPath, volumeId, to);
      // 卷序变了但章节数组顺序没变：当前章按 id 找回原卡片
      const currentId = (state.chapters[state.index] || {}).id;
      applyMetaAndRelocate(data, currentId);
      renderChapterList();
      renderEditorHeader();
      updateStatus();
      toast(`已${delta < 0 ? '上移' : '下移'}卷：${volumeDisplayName(volumeId)}`);
      return { ok: true };
    } catch (err) {
      toast(`移动卷失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  async function deleteVolumeFlow(volumeId, skipConfirm = false) {
    if (!state.bookPath || !volumeId) return { ok: false };
    const bookPath = state.bookPath;
    const volume = volumeById(volumeId);
    // 撤销用：卷名 + 卷序 + 卷里章节的 id（按全书顺序），删完直接执行、10 秒内可撤销。
    const volumeName = (volume && String(volume.name || '').trim()) || '未命名卷';
    const volumeIndex = Math.max(0, volumeList().findIndex((v) => v.id === volumeId));
    const chapterIds = state.chapters.filter((c) => chapterVolumeId(c) === volumeId).map((c) => c.id);
    const count = chapterIds.length;
    // skipConfirm 只给自动化钩子用（1.4.0 P0-2 起不再有确认框，保留参数是为了钩子签名不变）
    void skipConfirm;
    try {
      const data = await call(api.deleteVolume, state.bookPath, volumeId);
      // 卷里的章回到「未分卷」，顺序不变：当前章按 id 找回；万一找不到（书目被外部改坏）回第 1 章
      const currentId = (state.chapters[state.index] || {}).id;
      const at = applyMetaAndRelocate(data, currentId);
      if (at < 0) state.index = 0;
      renderChapterList();
      renderEditorHeader();
      updateStatus();
      undoUi.activate(
        `已删除卷「${volumeName}」${count ? `，${count} 章回到未分卷` : ''}`,
        async () => {
          if (state.bookPath !== bookPath) throw new Error('已经换了书，不能撤销');
          // 先按原名建卷，再把章按原顺序逐条放回去（moveChapterToVolume 追加到卷尾，顺序自然对）
          const created = await call(api.createVolume, bookPath, volumeName);
          const newId = created && created.volume ? created.volume.id : null;
          if (!newId) throw new Error('没能重建这一卷');
          for (const chapterId of chapterIds) {
            await call(api.moveChapterToVolume, bookPath, chapterId, newId);
          }
          // 卷序也放回原位置（建卷会追加到末尾）
          try {
            await call(api.moveVolume, bookPath, newId, volumeIndex);
          } catch { /* 卷序放不回去也不影响章节归属，别让整次撤销失败 */ }
          const reopened = await call(api.openBook, bookPath);
          state.meta = reopened.meta;
          state.chapters = reopened.meta.chapters;
          const keep = (state.chapters[state.index] || {}).id;
          const back = keep ? state.chapters.findIndex((c) => c.id === keep) : -1;
          if (back >= 0) state.index = back;
          renderChapterList();
          renderEditorHeader();
          await refreshShelf();
        }
      );
      toast(`已删除卷，${count} 章回到「未分卷」（章节文件未动）`);
      return { ok: true };
    } catch (err) {
      toast(`删除卷失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  // 移到卷（1.4.0 P0-2：不再弹模态选择框）——点右键菜单里的「移到卷…」，就在同一个菜单下面
  // 展开这个卷列表，选一个即执行。模态只留两处（未保存拦截 / 删除整本书），这里属于「选择」不是
  // 「确认」，所以改成菜单内联展开：菜单本来就有键盘通道（menu-keyboard 会把焦点带进第一条）。
  function openVolumeChooserInMenu(index) {
    const holder = $('context-menu-volumes');
    // 1.5.0 功能-1：index < 0 = 批量条打开的菜单（作用于全部已选章）；否则按「这一章是否在多选里」判断
    const batch = index < 0 || chapterMenuIsBatch(index);
    const indexes = batch ? selectedChapterIndexes() : [index];
    const chapter = state.chapters[indexes[0]];
    if (!holder || !chapter) return false;
    const currentVolume = chapterVolumeId(chapter);
    const volumes = volumeList();
    holder.textContent = '';
    const title = document.createElement('div');
    title.className = 'context-menu-label';
    title.textContent =
      batch && indexes.length > 1
        ? `把选中的 ${indexes.length} 章移到`
        : `把「${chapterTitle(indexes[0], chapter.name)}」移到`;
    holder.appendChild(title);
    let count = 0;
    for (const volume of volumes) {
      if (!volume) continue;
      // 单章：当前卷不用再列；批量：全部卷都列（已在该卷里的章移动时自动跳过，只移动真正换卷的）
      if (!batch && volume.id === currentVolume) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.action = `move-volume:${volume.id}`;
      btn.textContent = volumeDisplayName(volume.id);
      holder.appendChild(btn);
      count += 1;
    }
    const anyInVolume = batch
      ? indexes.some((at) => chapterVolumeId(state.chapters[at]))
      : Boolean(currentVolume);
    if (anyInVolume) {
      const back = document.createElement('button');
      back.type = 'button';
      back.dataset.action = 'move-volume:';
      back.textContent = '移回「未分卷」';
      holder.appendChild(back);
      count += 1;
    }
    if (!count) {
      const empty = document.createElement('div');
      empty.className = 'context-menu-label';
      empty.textContent = volumes.length ? '这一章已经在唯一的卷里了' : '这本书还没有卷，先「＋ 新建卷」';
      holder.textContent = '';
      holder.appendChild(empty);
    }
    holder.classList.remove('hidden');
    // 菜单可能贴着窗口下沿：展开后往窗口里收一下（placeMenuAt 同一套夹紧逻辑）
    placeMenuAt($('context-menu'), parseFloat($('context-menu').style.left) || 0, parseFloat($('context-menu').style.top) || 0);
    return true;
  }

  async function moveChapterToVolume(index, volumeId) {
    const chapter = state.chapters[index];
    if (!chapter || !state.bookPath) return { ok: false };
    const bookPath = state.bookPath;
    // 撤销用：原卷 + 原来的下一章（和跨卷移动同一口径：撤销 = 插回原来那一章前面）
    const fromVolumeId = chapterVolumeId(chapter);
    const beforeId = state.chapters[index + 1] ? state.chapters[index + 1].id : null;
    const currentId = (state.chapters[state.index] || {}).id;
    try {
      const data = await call(api.moveChapterToVolume, state.bookPath, chapter.id, volumeId || null);
      applyMetaAndRelocate(data, currentId);
      renderChapterList();
      renderEditorHeader();
      updateStatus();
      const target = volumeDisplayName(volumeId);
      undoUi.activate(`已把「${chapterTitle(index, chapter.name)}」移到「${target}」`, async () => {
        if (state.bookPath !== bookPath) throw new Error('已经换了书，不能撤销');
        const at = state.chapters.findIndex((c) => c.id === chapter.id);
        if (at < 0) throw new Error('这一章已经不在书里了');
        const back = await moveChapterByDrop(state.chapters[at], {
          volumeId: fromVolumeId,
          beforeChapterId: beforeId
        });
        if (!back || back.ok !== true) throw new Error((back && back.message) || '移动没有生效');
      });
      toast(`已移到「${target}」`);
      return { ok: true, index: data.index };
    } catch (err) {
      toast(`移动失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  async function renameChapterAt(index, nameOverride) {
    const chapter = state.chapters[index];
    if (!chapter) return;
    if (state.dirty && index === state.index) {
      toast('当前章节还有未保存的修改，先保存再改名（或切换前选择保存）', 'warn');
      return;
    }
    let name = nameOverride;
    if (name === undefined) {
      name = await promptText({
        title: '重命名章节',
        message: '只改显示名，文件名不变（这样插入/删除永远不会因为改名失败而丢稿）。',
        value: chapter.name || '',
        placeholder: '章节名'
      });
      if (name === null) return;
    }
    try {
      const data = await call(api.renameChapter, state.bookPath, chapter.id, name);
      applyMetaAndRelocate(data);
      // B17：只改这一条的章名 / tooltip；筛选 / 条目对不上时退回整表重建
      if (!syncChapterItemInfo(index)) renderChapterList();
      if (index === state.index) renderEditorHeader();
      updateStatus();
      toast('已重命名（文件名未改）');
    } catch (err) {
      toast(`重命名失败：${err.message}`, 'error');
    }
  }

  // 返回 true = 真的删了（写盘成功）；false = 没删（取消未保存拦截 / 保存失败 / 出错）。
  // 1.4.0 P0-2（撤销优先）：删除改为「直接执行 + 10 秒撤销」——不再弹「确定删除？」确认框。
  // 只有「删的是当前章且还有没保存的字」仍走未保存拦截（两处保留确认之一）：撤销找得回磁盘上
  // 那一版，但找不回编辑区里还没写盘的字，所以这一步不能省。skipConfirm 只给自动化钩子用。
  async function deleteChapterAt(index, skipConfirm = false) {
    const chapter = state.chapters[index];
    if (!chapter) return false;
    const bookPath = state.bookPath;
    if (!bookPath) return false;
    const wasCurrent = index === state.index;
    const currentId = wasCurrent ? null : (state.chapters[state.index] || {}).id;
    // 1.5.0 P0-4（审计 H-2）：记下删除那一刻的左右邻居 id。撤销时若这一章的下标已经不对
    // （10 秒里又删了别的章 / 调过序），就按「找回那个邻居、插回它旁边」重算落点。
    const neighborBeforeId = index > 0 && state.chapters[index - 1] ? state.chapters[index - 1].id : '';
    const neighborAfterId = state.chapters[index + 1] ? state.chapters[index + 1].id : '';
    if (!skipConfirm && wasCurrent && state.dirty) {
      const action = await askUnsaved({
        title: '删除前先处理未保存的修改',
        message:
          `「${currentChapterLabel()}」还有未保存的修改。\n` +
          '删除会把磁盘上的这一章移到本书的 _trash，编辑区里还没保存的字不会跟着进去。',
        saveLabel: '保存后删除',
        discardLabel: '不保存，直接删除'
      });
      if (action === 'cancel') return false;
      if (action === 'save') {
        const saved = await saveCurrent();
        if (!saved.ok) return false;
      }
    }
    try {
      const data = await call(api.deleteChapter, bookPath, chapter.id);
      const at = applyMetaAndRelocate(data, currentId);
      // 主进程回传的是绝对路径：只取文件名（撤销只传 basename，绝不把本机路径再递回去）。
      const trashName = String(data.trashPath || '').split(/[\\/]/).pop();
      // 1.5.0 P0-5（审计 V-1）：主进程给这次删除发了一张一次性凭证，撤销时必须原样交回。
      const undoToken = typeof data.undoToken === 'string' ? data.undoToken : '';
      if (data.newChapter) toast('最后一章被删除，已自动补一个空章');
      if (wasCurrent) {
        state.dirty = false;
        await loadChapterAt(data.index);
      } else if (at < 0) {
        // REDT-C-04：删的虽不是当前章，但回包书目里当前章也不见了（书目被外部改坏等异常）。
        // 只改下标不重载会让编辑区留着已消失章的文字、dirty 原样保留，接着 Ctrl+S 就把旧章正文
        // 写进新下标指向的章文件 —— 与批量删除同一口径：回落下标、清脏、重载编辑区。
        state.index = Math.min(index, state.chapters.length - 1);
        state.dirty = false;
        await loadChapterAt(state.index);
      } else {
        renderChapterList();
        renderEditorHeader();
        updateStatus();
      }
      if (trashName) {
        activateDeleteUndo({
          bookPath,
          chapter,
          index,
          trashName,
          undoToken,
          wasCurrent,
          newChapter: data.newChapter,
          neighborBeforeId,
          neighborAfterId
        });
      }
      return true;
    } catch (err) {
      toast(`删除失败：${err.message}`, 'error');
      return false;
    }
  }

  // 删除章节后的撤销登记（1.4.0 P0-2）：10 秒内点撤销条 / 按 Ctrl+Z 把章节文件与书目位置一起找回。
  // 撤销执行前 flushWriteTimer()、再核对还是同一本书；失败由 renderer/undo-ui.js 报「撤销失败：…」，绝不静默。
  function activateDeleteUndo(info) {
    const title = chapterTitle(info.index, info.chapter.name);
    undoUi.activate(`已删除「${title}」`, async () => {
      if (state.bookPath !== info.bookPath) throw new Error('已经换了书，不能撤销');
      await flushWriteTimer();
      const dirtyNow = Boolean(state.dirty);
      const current = state.chapters[state.index];
      const autoFile = info.newChapter && info.newChapter.file ? info.newChapter.file : '';
      // 删空自动补的空章：只在「它仍空着、编辑区也没动过它」时一并撤掉。
      // 作者在这 10 秒里已经往补章里写了字，就保留它（宁可多一章，也不静默丢字）。
      const canRemoveAuto = Boolean(autoFile) && !(dirtyNow && current && current.file === autoFile);
      // 1.5.0 P0-4（审计 H-2）：撤销时按 id 重查书目，优先用「现在」的字段与落点；
      // 这一章已经不在列表里（正常情况）就用删除时的左右邻居重算落点，最后才退回删除那一刻的下标。
      // 目标：10 秒内改名 / 调序 / 又删了别的章，撤销仍落回原来的上下文，而不是把旧下标硬塞进去。
      const foundAt = state.chapters.findIndex((item) => item && item.id === info.chapter.id);
      const liveChapter = foundAt >= 0 ? state.chapters[foundAt] : null;
      const source = liveChapter || info.chapter;
      const afterAt = info.neighborAfterId
        ? state.chapters.findIndex((item) => item && item.id === info.neighborAfterId)
        : -1;
      const beforeAt = info.neighborBeforeId
        ? state.chapters.findIndex((item) => item && item.id === info.neighborBeforeId)
        : -1;
      const restoreIndex =
        foundAt >= 0
          ? foundAt
          : afterAt >= 0
            ? afterAt
            : beforeAt >= 0
              ? beforeAt + 1
              : Math.min(info.index, state.chapters.length);
      const data = await call(api.restoreDeletedChapter, info.bookPath, {
        trashName: info.trashName,
        // 1.5.0 P0-5（审计 V-1）：主进程只认「删除时发的那张一次性凭证」；伪造 / 过期 / 跨书 / 重复用都被拒。
        undoToken: info.undoToken || '',
        index: restoreIndex,
        chapter: {
          id: source.id,
          file: source.file,
          name: source.name,
          createdAt: source.createdAt,
          volumeId: source.volumeId,
          status: source.status,
          note: source.note
        },
        autoChapterFile: canRemoveAuto ? autoFile : null
      });
      // 有未保存的字就不切章（切章会把它丢掉），只把书目换回来；
      // 其它情况按「当前章 id」重定位，免得撤销把一章插到当前章前面后下标错位。
      const willLoad = info.wasCurrent && !dirtyNow;
      const keepId = current && !willLoad ? current.id : null;
      const at = applyMetaAndRelocate(data, keepId);
      if (at >= 0) state.index = at;
      renderChapterList();
      renderEditorHeader();
      if (willLoad) await loadChapterAt(data.index);
      else updateStatus();
      const note = autoFile && !data.autoChapterRemoved ? '（自动补的空章里已经有内容，保留）' : '';
      toast(`已撤销删除：${chapterTitle(data.index, data.chapter.name)}${note}`);
    });
  }

  // 章节状态 / 备注：只写 书目.json 的可选字段，正文一个字都不动。
  async function updateChapterInfo(index, patch) {
    const chapter = state.chapters[index];
    if (!chapter || !state.bookPath) return { ok: false, message: '没有打开的章节' };
    try {
      const data = await call(api.updateChapterMeta, state.bookPath, chapter.id, patch);
      applyMetaAndRelocate(data);
      // B17：状态 / 备注只改这一条（备注标记要增删时 syncChapterItemInfo 返回 false → 整表重建）
      if (!syncChapterItemInfo(index)) renderChapterList();
      renderEditorHeader();
      return { ok: true, changed: Boolean(data.changed), chapter: data.chapter };
    } catch (err) {
      toast(`保存章节信息失败：${err.message}`, 'error');
      return { ok: false, message: err.message, code: err.code };
    }
  }

  async function setChapterStatusAt(index, status) {
    const label = CHAPTER_STATUS_LABELS[status];
    if (!label || !state.chapters[index]) return { ok: false };
    const res = await updateChapterInfo(index, { status });
    if (!res.ok) return res;
    if (res.changed) toast(`已标记为${label}（只改书目，正文没动）`);
    return { ok: true, status: chapterStatus(state.chapters[index]), changed: res.changed };
  }

  // ---------- 章节多选：批量动作（1.5.0 功能-1）----------
  // 全部复用现有 IPC，不新增频道 / 字段：删除逐章 api.deleteChapter（收集 _trash 文件名 + 撤销凭证），
  // 移到卷逐章 api.moveChapterToVolume，改状态逐章 api.updateChapterMeta，导出走现有范围对话框，
  // 复制走 api.copyBook 的「选中章下标」可选参数（主进程按书名 / 章名 / 正文同一套格式拼接）。
  // 破坏性动作只有一条撤销：一次恢复全部章 / 一次移回全部章（顺序见各函数里的注释）。
  async function deleteSelectedChapters() {
    if (!state.bookPath) return false;
    const indexes = selectedChapterIndexes();
    if (!indexes.length) return false;
    // 只选了一章：复用单章删除（未保存拦截 / _trash / 撤销文案 / 焦点恢复全都不变）
    if (indexes.length === 1) {
      const deleted = await deleteChapterAt(indexes[0]);
      if (deleted) clearChapterSelection();
      return deleted;
    }
    const bookPath = state.bookPath;
    const firstIndex = indexes[0];
    const currentSelected = indexes.includes(state.index);
    const keepCurrentId = currentSelected ? '' : currentChapterId();
    // 「当前章有未保存修改」只问一次（和单章删除同一条拦截；批量里只问当前章，别的章没有编辑区内容）
    if (currentSelected && state.dirty) {
      const action = await askUnsaved({
        title: '删除前先处理未保存的修改',
        message:
          `选中的章里有正在写的「${currentChapterLabel()}」，它还有未保存的修改。\n` +
          '删除会把磁盘上的章节文件移到本书的 _trash，编辑区里还没保存的字不会跟着进去。',
        saveLabel: '保存后删除',
        discardLabel: '不保存，直接删除'
      });
      if (action === 'cancel') return false;
      if (action === 'save') {
        const saved = await saveCurrent();
        if (!saved.ok) return false;
      }
    }
    // 从后往前删：前面还没删的章下标不会被后来的删除挤动，收集到的 index 就是**原始位置**；
    // 撤销时反过来从前往后按原下标插回，章序才和删除前一致。
    const deleted = [];
    let failed = null;
    for (let n = indexes.length - 1; n >= 0; n -= 1) {
      const index = indexes[n];
      const chapter = state.chapters[index];
      if (!chapter) continue;
      const neighborBeforeId = index > 0 && state.chapters[index - 1] ? state.chapters[index - 1].id : '';
      const neighborAfterId = state.chapters[index + 1] ? state.chapters[index + 1].id : '';
      try {
        const data = await call(api.deleteChapter, bookPath, chapter.id);
        deleted.push({
          chapter,
          index,
          trashName: String(data.trashPath || '').split(/[\\/]/).pop(),
          undoToken: typeof data.undoToken === 'string' ? data.undoToken : '',
          neighborBeforeId,
          neighborAfterId,
          newChapter: data.newChapter || null
        });
        applyMetaAndRelocate(data, currentSelected ? null : keepCurrentId);
      } catch (err) {
        failed = err;
        break;
      }
    }
    // 选中集合是一次性动作的上下文：执行完就收起（失败也收起，避免重试时重复删已删的章）
    state.selectedIds = new Set();
    state.selectAnchorId = null;
    if (currentSelected) {
      state.index = Math.min(firstIndex, Math.max(0, state.chapters.length - 1));
      state.dirty = false;
      await loadChapterAt(state.index);
    } else if (!state.chapters[state.index]) {
      // 当前章在书目里找不到了（极端情况：书目被外部改坏）：回第一处原下标，别停在一个空下标上
      state.index = Math.min(firstIndex, Math.max(0, state.chapters.length - 1));
      await loadChapterAt(state.index);
    } else {
      renderChapterList();
      renderEditorHeader();
      updateStatus();
    }
    syncChapterBatchBar();
    if (deleted.length) {
      activateBatchDeleteUndo(bookPath, deleted);
      const suffix = failed ? `（有 ${indexes.length - deleted.length} 章没删成：${failed.message}）` : '，10 秒内可撤销';
      toast(`已把 ${deleted.length} 章移到本书 _trash${suffix}`, failed ? 'warn' : undefined);
    }
    if (failed && !deleted.length) toast(`删除失败：${failed.message}`, 'error');
    return deleted.length > 0;
  }

  // 批量删除的撤销：按删除的**逆序**（从前往后）逐章按原始下标插回，最后一条撤销动作即可全部找回。
  // 顺序为什么是「从前往后」：删除是从后往前做的，原始下标在那一刻有效；倒过来插回才逐条落回原位。
  function activateBatchDeleteUndo(bookPath, deleted) {
    const count = deleted.length;
    const ordered = deleted.slice().sort((a, b) => a.index - b.index);
    undoUi.activate(`已删除 ${count} 章`, async () => {
      if (state.bookPath !== bookPath) throw new Error('已经换了书，不能撤销');
      await flushWriteTimer();
      const keepId = currentChapterId();
      let lastData = null;
      for (const entry of ordered) {
        const autoFile = entry.newChapter && entry.newChapter.file ? entry.newChapter.file : '';
        const current = state.chapters[state.index];
        // 删空自动补的空章：只在它还空着、编辑区也没动过它时一起收走（与单章撤销同一口径）
        const canRemoveAuto = Boolean(autoFile) && !(state.dirty && current && current.file === autoFile);
        lastData = await call(api.restoreDeletedChapter, bookPath, {
          trashName: entry.trashName,
          undoToken: entry.undoToken || '',
          index: entry.index,
          chapter: {
            id: entry.chapter.id,
            file: entry.chapter.file,
            name: entry.chapter.name,
            createdAt: entry.chapter.createdAt,
            volumeId: entry.chapter.volumeId,
            status: entry.chapter.status,
            note: entry.chapter.note
          },
          autoChapterFile: canRemoveAuto ? autoFile : null
        });
        applyMetaAndRelocate(lastData, keepId || undefined);
      }
      const at = keepId ? state.chapters.findIndex((chapter) => chapter && String(chapter.id) === keepId) : -1;
      renderChapterList();
      renderEditorHeader();
      if (at >= 0) {
        state.index = at;
        updateStatus();
      } else {
        // 当前停在「删除整本后自动补的空章」上，它已经被收走：回第一处原下标重新读一章
        state.index = Math.min(ordered[0] ? ordered[0].index : 0, Math.max(0, state.chapters.length - 1));
        await loadChapterAt(state.index);
      }
      toast(`已撤销删除：${count} 章已放回原位`);
    });
  }

  async function moveSelectedChaptersToVolume(volumeId) {
    if (!state.bookPath) return { ok: false };
    const indexes = selectedChapterIndexes();
    if (!indexes.length) return { ok: false };
    if (indexes.length === 1) {
      const res = await moveChapterToVolume(indexes[0], volumeId);
      if (res && res.ok) clearChapterSelection();
      return res;
    }
    const bookPath = state.bookPath;
    const targetName = volumeDisplayName(volumeId);
    const keepCurrentId = currentChapterId();
    // 已经在目标卷里的章不动（否则只是给它们换顺序）：只移动真正换卷的那些
    const moves = indexes
      .map((index) => {
        const chapter = state.chapters[index];
        return {
          chapter,
          fromVolumeId: chapterVolumeId(chapter),
          beforeId: state.chapters[index + 1] ? state.chapters[index + 1].id : null
        };
      })
      .filter((move) => move.chapter && move.fromVolumeId !== (volumeId || null));
    if (!moves.length) {
      toast(`选中的章节已经在「${targetName}」里了`, 'warn');
      return { ok: false };
    }
    const done = [];
    let failed = null;
    for (const move of moves) {
      try {
        const data = await call(api.moveChapterToVolume, bookPath, move.chapter.id, volumeId || null);
        applyMetaAndRelocate(data, keepCurrentId);
        done.push(move);
      } catch (err) {
        failed = err;
        break;
      }
    }
    state.selectedIds = new Set();
    state.selectAnchorId = null;
    renderChapterList();
    renderEditorHeader();
    updateStatus();
    syncChapterBatchBar();
    if (done.length) {
      // 一条撤销：按原顺序逐条插回原来的下一章前面（跨卷移动撤销的同一口径）。
      // REDT-C-01（高）：必须**从后往前**插回。beforeId 记的是「原顺序里的下一章」；同批相邻章
      // 全在移动集合里时，从前往后插会让锚点还留在目标卷，splice 到的是锚点现位（目标卷）里，
      // normalize 后除最后一段外都被排到原卷末尾（例：[X,A,B,C] 选 A、B 移到卷 W 后撤销得
      // [X,B,C,A]）。倒序保证每一章的锚点已经先回原位，段内相对顺序与位置才能逐字还原。
      undoUi.activate(`已把 ${done.length} 章移到「${targetName}」`, async () => {
        if (state.bookPath !== bookPath) throw new Error('已经换了书，不能撤销');
        for (let i = done.length - 1; i >= 0; i -= 1) {
          const move = done[i];
          const at = state.chapters.findIndex(
            (chapter) => chapter && String(chapter.id) === String(move.chapter.id)
          );
          if (at < 0) throw new Error('有一章已经不在书里了');
          const back = await moveChapterByDrop(state.chapters[at], {
            volumeId: move.fromVolumeId,
            beforeChapterId: move.beforeId
          });
          if (!back || back.ok !== true) throw new Error((back && back.message) || '移动没有生效');
        }
      });
      toast(`已把 ${done.length} 章移到「${targetName}」`);
    }
    if (failed && !done.length) toast(`移动失败：${failed.message}`, 'error');
    return { ok: done.length > 0 };
  }

  async function setSelectedChaptersStatus(status) {
    const label = CHAPTER_STATUS_LABELS[status];
    if (!label) return { ok: false };
    const indexes = selectedChapterIndexes();
    if (!indexes.length) return { ok: false };
    if (indexes.length === 1) {
      const res = await setChapterStatusAt(indexes[0], status);
      clearChapterSelection();
      return res;
    }
    const bookPath = state.bookPath;
    let changed = 0;
    let failed = 0;
    for (const index of indexes) {
      const chapter = state.chapters[index];
      if (!chapter) continue;
      try {
        const data = await call(api.updateChapterMeta, bookPath, chapter.id, { status });
        applyMetaAndRelocate(data);
        if (data.changed) changed += 1;
      } catch {
        failed += 1;
      }
    }
    state.selectedIds = new Set();
    state.selectAnchorId = null;
    // B17：批量改状态只同步这几条（多选清空后的 selected 类由 syncChapterItemInfo 一起摘掉）；
    // 任一条对不上（被折叠 / 换了书）就退回整表重建。
    let fastDone = true;
    for (const index of indexes) {
      if (!syncChapterItemInfo(index)) {
        fastDone = false;
        break;
      }
    }
    if (!fastDone) renderChapterList();
    renderEditorHeader();
    syncChapterBatchBar();
    if (changed) toast(`已把 ${changed} 章标记为${label}（只改书目，正文没动）`);
    else if (!failed) toast(`选中的章节本来就是${label}`);
    if (failed) toast(`${failed} 章改状态失败`, 'error');
    return { ok: changed > 0 || failed === 0, changed, failed };
  }

  // 导出选中章：只支持**连续范围**（与现有「第 X–Y 章」导出一致）。非连续时明确提示，不静默扩大。
  function exportSelectedChapters() {
    const indexes = selectedChapterIndexes();
    if (!indexes.length) return;
    const contiguous = indexes.every((value, i) => i === 0 || value === indexes[i - 1] + 1);
    if (!contiguous) {
      toast('导出只支持连续范围，请用 Shift 连选或改用范围导出', 'warn');
      return;
    }
    openExportDialog('txt', { from: indexes[0] + 1, to: indexes[indexes.length - 1] + 1 });
  }

  // 复制选中章：主进程按目录顺序拼「标题 \r\n\r\n 正文」（与导出拼接格式一致），一次写剪贴板。
  // 当前章有未保存内容时用编辑区文本（与导出 / 复制整本同一口径）；空选择不写。
  async function copySelectedChapters() {
    if (!state.bookPath) return null;
    const indexes = selectedChapterIndexes();
    if (!indexes.length) {
      toast('先选章节再复制', 'warn');
      return null;
    }
    const current = state.chapters[state.index];
    const override =
      state.dirty && indexes.includes(state.index) && current
        ? { chapterId: current.id, text: editorEl.value }
        : null;
    try {
      const data = await call(api.copyBook, state.bookPath, override, indexes);
      const parts = [`${data.chapterCount} 章`, `${formatCount(Number(data.chars) || 0)} 字`];
      if (data.includedUnsaved) parts.push('含当前章未保存内容');
      toast(`已复制选中的章节（${parts.join(' · ')}）`);
      return data;
    } catch (err) {
      toast(`复制失败：${err.message}`, 'error');
      return null;
    }
  }

  async function editChapterNoteAt(index) {
    const chapter = state.chapters[index];
    if (!chapter) return null;
    // 五-M7：prompt 在途时章节数组可能已被删章 / 移卷 / 整本替换换掉。
    // 记下 prompt 打开的是哪一章（id），回来后现场解析下标 —— 旧 index 可能已经指向另一章。
    const chapterId = chapter.id;
    const value = await promptText({
      title: `章节备注：${chapterTitle(index, chapter.name)}`,
      message: '给自己记一句话（最多 200 字，只存进书目.json，不碰正文）。清空后确定 = 删除备注。',
      value: chapter.note || '',
      placeholder: '比如：这章结尾要重写'
    });
    if (value === null) return null;
    const at = state.chapters.findIndex((item) => item && item.id === chapterId);
    if (at < 0) {
      toast('这一章已经不在书里了，备注没有保存', 'warn');
      return null;
    }
    const res = await updateChapterInfo(at, { note: value });
    if (!res.ok) return null;
    const freshNote = chapterNote(state.chapters[at]);
    toast(freshNote ? '备注已保存' : '备注已清除');
    return freshNote;
  }


    return { chapterTemplateText, applyChapterTemplate, applyMetaAndRelocate, createChapterAt, createVolumeFlow, renameVolumeFlow, moveVolumeFlow, deleteVolumeFlow, openVolumeChooserInMenu, moveChapterToVolume, renameChapterAt, deleteChapterAt, activateDeleteUndo, updateChapterInfo, setChapterStatusAt, deleteSelectedChapters, activateBatchDeleteUndo, moveSelectedChaptersToVolume, setSelectedChaptersStatus, exportSelectedChapters, copySelectedChapters, editChapterNoteAt };
  }

  return { create: createChapterOpsUi, REQUIRED_HOST };
});
