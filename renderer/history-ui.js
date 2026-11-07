/* 本书历史（第 4 步 renderer 九刀·第一刀：从 renderer.js 的「本书历史」分区整段搬出来）。
 *
 * 搬走的段（原 renderer.js 4355–4668 / 当前 HEAD 4369–4668，300 行）——「统一查看 / 还原 _trash 备份」面板：
 *   openHistoryForPath（打开面板：先收顶栏菜单、建 state.history、拉清单）
 *   openHistoryForCurrentBook（没有打开的书就 toast 提示）
 *   refreshHistory（拉 api.listHistory，旧响应按 token 作废）
 *   closeHistoryDialog / closeHistoryPreview（关面板 / 关预览）
 *   renderHistoryPreview / historyFileTag / buildHistoryGroup / renderHistory（预览与分组清单 DOM）
 *   previewHistoryBackup（api.previewHistoryFile）
 *   confirmHistoryRestore（未保存三选一 → openModal 二次确认 → api.restoreHistoryDir/File → 还原后刷新书架 / 重载 / 再拉清单 / toast）
 *   sameBookPath（纯函数；「整本替换的备份还原」也在用，渲染层按名字转发）
 * **只搬不改行为**：文案 / class / DOM 结构 / 返回值形状 / token 作废逻辑 / 失败兜底全部一字未改
 * （indent / 空行也保持原样）；面板 CSS 与 index.html 的 DOM 一个字节没动。
 *
 * 契约：createHistoryUi(host) 由渲染层调用一次。host 8 个成员（含 3 个语义分组，分组内每个真实依赖都列在这里）：
 *   host = {
 *     $, state, api, call, toast,                      // 基础 5：DOM 查询 / 共享状态 / IPC 白名单 / IPC 包装 / 提示
 *     collab: {                                        // 与「当前书 / 当前编辑区」协作的渲染层回调
 *       confirmRestoreWithUnsaved,                     //   「还原前」未保存三选一 + 保存失败即停（与整本替换备份还原共用一份实现）
 *       openModal,                                     //   还原二次确认弹窗
 *       refreshShelf,                                  //   还原后刷新书架
 *       reloadAfterPartialFailure,                     //   还原失败后按磁盘真相重载（可能已还原了几章）
 *       reloadOpenBookFromDisk                         //   这本书开着时，还原成功后从磁盘重载
 *     },
 *     menus: { hideBookMenu, hideExportMenu },         // 打开历史前先收起顶栏菜单（与搬前调用顺序一致）
 *     fmt: { formatBytes }                             // 字节数格式化（「N 个文件 · 1.2 MB」文案）
 *   }
 * 缺任何一个（含分组内成员）直接抛 TypeError（宁可在启动时炸，也不要到点「本书历史」时 ReferenceError）。
 * 分组在 create 时一次解构，行为与平铺 8 个参数完全等价。
 * create() 不注册事件、不建定时器、不碰 DOM（只在被调用时才动 DOM）；事件绑定在 setupHistoryUi() 里，
 * 由渲染层 bindEvents() 在原「历史 4 个按钮」的位置调用一次——注册内容与搬前逐行一致。
 *
 * 刻意不搬（留在 renderer.js）：
 *   - 查找面板（renderFindResults / jumpToFindResult / runFind / replaceEditorText / runReplaceAll）：
 *     它和本分区挨着只是因为历史与查找都渲染在同一个侧栏里，职责属于「查找 / 替换」，留给补刀；
 *   - 「整本替换」里对 sameBookPath 的调用：渲染层解构转发本模块的同一个实现（不复制第二份）；
 *   - 测试钩子宿主契约（testHooksScope 按名字取本模块入口）、Esc 动作表（按名字取关闭函数）。
 *
 * 浏览器里挂成全局 CWHistoryUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWHistoryUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HOST = ['$', 'state', 'api', 'call', 'toast', 'collab', 'menus', 'fmt'];

  function createHistoryUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createHistoryUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) throw new TypeError('createHistoryUi 的 host 缺少 ' + key);
    }
    const { $, state, api, call, toast, collab, menus, fmt } = host;
    if (typeof collab !== 'object') throw new TypeError('createHistoryUi 的 host.collab 必须是对象');
    for (const key of ['confirmRestoreWithUnsaved', 'openModal', 'refreshShelf', 'reloadAfterPartialFailure', 'reloadOpenBookFromDisk']) {
      if (collab[key] === undefined || collab[key] === null) throw new TypeError('createHistoryUi 的 host.collab 缺少 ' + key);
    }
    if (typeof menus !== 'object') throw new TypeError('createHistoryUi 的 host.menus 必须是对象');
    for (const key of ['hideBookMenu', 'hideExportMenu']) {
      if (menus[key] === undefined || menus[key] === null) throw new TypeError('createHistoryUi 的 host.menus 缺少 ' + key);
    }
    if (typeof fmt !== 'object' || fmt.formatBytes === undefined || fmt.formatBytes === null) {
      throw new TypeError('createHistoryUi 的 host.fmt 缺少 formatBytes');
    }
    const { confirmRestoreWithUnsaved, openModal, refreshShelf, reloadAfterPartialFailure, reloadOpenBookFromDisk } = collab;
    const { hideBookMenu, hideExportMenu } = menus;
    const { formatBytes } = fmt;

  // ---------- 本书历史（统一查看 / 还原 _trash 备份） ----------
  // 备份来源由 core/history.js 扫描：替换 / 整理 / 还原前 / 快照 / 删章散文件 / 书目.json.bak。
  // 这里只负责展示、预览和二次确认；真正的写盘在 storage（先备份当前内容再原子写）。
  function sameBookPath(a, b) {
    return String(a == null ? '' : a).toLowerCase() === String(b == null ? '' : b).toLowerCase();
  }

  async function openHistoryForPath(bookPath, title) {
    if (!bookPath) return false;
    hideExportMenu();
    hideBookMenu();
    state.history = {
      path: bookPath,
      title: String(title == null ? '' : title),
      groups: [],
      fileCount: 0,
      totalBytes: 0,
      loading: true,
      error: '',
      preview: null,
      token: 0
    };
    $('history-backdrop').classList.remove('hidden');
    renderHistory();
    await refreshHistory();
    return true;
  }

  function openHistoryForCurrentBook() {
    if (!state.bookPath) {
      toast('先打开一本书再查看历史', 'warn');
      return Promise.resolve(false);
    }
    return openHistoryForPath(state.bookPath, state.meta ? state.meta.title : '');
  }

  async function refreshHistory() {
    const current = state.history;
    if (!current) return null;
    const token = current.token + 1;
    current.token = token;
    current.loading = true;
    current.error = '';
    renderHistory();
    let data;
    try {
      data = await call(api.listHistory, current.path);
    } catch (err) {
      if (state.history !== current || current.token !== token) return null;
      current.loading = false;
      current.error = err.message;
      renderHistory();
      return null;
    }
    if (state.history !== current || current.token !== token) return null;
    current.loading = false;
    current.title = data && data.title ? data.title : current.title;
    current.groups = Array.isArray(data && data.groups) ? data.groups : [];
    current.fileCount = Number(data && data.fileCount) || 0;
    current.totalBytes = Number(data && data.totalBytes) || 0;
    renderHistory();
    return data;
  }

  function closeHistoryDialog() {
    state.history = null;
    $('history-backdrop').classList.add('hidden');
    $('history-preview').classList.add('hidden');
  }

  function closeHistoryPreview() {
    if (state.history) state.history.preview = null;
    renderHistoryPreview();
  }

  function renderHistoryPreview() {
    const current = state.history;
    const pane = $('history-preview');
    if (!pane) return;
    if (!current || !current.preview) {
      pane.classList.add('hidden');
      return;
    }
    pane.classList.remove('hidden');
    $('history-preview-title').textContent =
      `${current.preview.sourceLabel} · ${current.preview.fileName}` +
      (current.preview.truncated ? '（文件较大，只预览开头）' : '');
    $('history-preview-text').textContent = current.preview.text || '（空文件）';
  }

  function historyFileTag(group, file) {
    if (group.source === 'delete') return { text: file.inBook ? '书里已有同名文件' : '已从书中删除', className: 'deleted' };
    if (group.source === 'bookmeta') return { text: '只供查看', className: '' };
    if (file.inBook && file.restorable) return { text: '当前章节', className: 'current' };
    if (group.source === 'other') return { text: '未识别备份', className: '' };
    if (!file.inBook) return { text: '已不在书里', className: '' };
    return { text: '只供查看', className: '' };
  }

  function buildHistoryGroup(group) {
    const card = document.createElement('div');
    card.className = 'history-group';
    card.dataset.groupId = group.id;
    card.dataset.source = group.source;

    const head = document.createElement('div');
    head.className = 'history-group-head';
    const source = document.createElement('span');
    source.className = 'history-source';
    source.textContent = group.sourceLabel;
    const time = document.createElement('span');
    time.className = 'history-time';
    time.textContent = group.timeText || '时间未知';
    const count = document.createElement('span');
    count.className = 'history-count';
    count.textContent = `${group.fileCount} 个文件 · ${formatBytes(group.totalBytes)}`;
    head.append(source, time, count);
    if (group.kind === 'dir' && group.restorableCount > 0) {
      const restoreGroupBtn = document.createElement('button');
      restoreGroupBtn.type = 'button';
      restoreGroupBtn.className = 'btn ghost tiny history-restore-group';
      restoreGroupBtn.textContent = `还原整组（${group.restorableCount}）`;
      restoreGroupBtn.title = '只还原现在仍在书里的章节；还原前先把当前内容备份一份';
      restoreGroupBtn.addEventListener('click', () => confirmHistoryRestore(group, null, true));
      head.appendChild(restoreGroupBtn);
    }
    card.appendChild(head);

    const note = document.createElement('div');
    note.className = 'history-note';
    note.textContent = group.note;
    card.appendChild(note);

    for (const file of group.files) {
      const row = document.createElement('div');
      row.className = 'history-file';
      row.dataset.fileName = file.name;

      const name = document.createElement('span');
      name.className = 'history-file-name';
      name.textContent = file.name;
      name.title = file.reason || file.name;

      const tagInfo = historyFileTag(group, file);
      const tag = document.createElement('span');
      tag.className = `history-file-tag ${tagInfo.className}`.trim();
      tag.textContent = tagInfo.text;

      const actions = document.createElement('span');
      actions.className = 'history-file-actions';
      if (file.previewable) {
        const previewBtn = document.createElement('button');
        previewBtn.type = 'button';
        previewBtn.className = 'btn ghost tiny';
        previewBtn.textContent = '预览';
        previewBtn.addEventListener('click', () => previewHistoryBackup(group.id, file.name));
        actions.appendChild(previewBtn);
      }
      if (file.restorable) {
        const restoreBtn = document.createElement('button');
        restoreBtn.type = 'button';
        restoreBtn.className = 'btn ghost tiny';
        restoreBtn.textContent = group.source === 'delete' ? '放回书文件夹' : '还原';
        restoreBtn.title =
          group.source === 'delete'
            ? '只把 txt 放回书文件夹，不改章节列表；书里已有同名文件时不覆盖'
            : '用备份覆盖这一章；还原前会先把现在的内容备份一份';
        restoreBtn.addEventListener('click', () => confirmHistoryRestore(group, file, false));
        actions.appendChild(restoreBtn);
      }
      row.append(name, tag, actions);
      card.appendChild(row);
    }
    return card;
  }

  function renderHistory() {
    const current = state.history;
    if (!current) return;
    const titleEl = $('history-title');
    if (titleEl) {
      titleEl.textContent = current.title ? `本书历史 · 《${current.title}》` : '本书历史';
    }
    const summary = $('history-summary');
    const list = $('history-list');
    list.innerHTML = '';
    if (current.loading) {
      summary.textContent = '正在读取备份…';
    } else if (current.error) {
      summary.textContent = '读取失败';
      const empty = document.createElement('div');
      empty.className = 'history-empty warn';
      empty.textContent = `读取备份失败：${current.error}`;
      list.appendChild(empty);
    } else if (!current.groups.length) {
      summary.textContent = '没有历史备份';
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent =
        '这本书里还没有历史备份。做过替换、整本整理、删除章节或保存过书目后，备份会自动出现在这里。';
      list.appendChild(empty);
    } else {
      summary.textContent =
        `共 ${current.groups.length} 组备份 · ${current.fileCount} 个文件 · ` +
        `${formatBytes(current.totalBytes)}（新 → 旧）`;
      for (const group of current.groups) list.appendChild(buildHistoryGroup(group));
    }
    renderHistoryPreview();
  }

  async function previewHistoryBackup(groupId, fileName) {
    const current = state.history;
    if (!current) return null;
    try {
      const data = await call(api.previewHistoryFile, current.path, groupId, fileName);
      if (state.history !== current) return null;
      current.preview = data;
      renderHistoryPreview();
      return data;
    } catch (err) {
      toast(`预览失败：${err.message}`, 'error');
      return null;
    }
  }

  async function confirmHistoryRestore(group, file, wholeGroup) {
    const current = state.history;
    if (!current || !group) return { ok: false };
    if (state.dirty && sameBookPath(state.bookPath, current.path)) {
      // 与「整本替换的备份还原」共用同一份未保存拦截（取消 / 放弃并还原 / 保存后再还原，
      // 保存失败就停在原地不继续还原）；本模块只负责「看的是不是当前这本」这道前提。
      const guard = await confirmRestoreWithUnsaved(
        '还原会从磁盘重新载入这本书的正文；当前章未保存的修改会丢失。'
      );
      if (!guard.ok) return guard.canceled ? { ok: false, canceled: true } : guard.saved;
    }
    const skippedHint =
      wholeGroup && group.files.length > group.restorableCount
        ? `\n\n另有 ${group.files.length - group.restorableCount} 个文件不是当前章节，会跳过（不会复活已删章节）。`
        : '';
    let title;
    let message;
    if (wholeGroup) {
      title = '还原整组备份';
      message =
        `会用「${group.sourceLabel}」这组备份里的 ${group.restorableCount} 个当前章节覆盖书里的同名章节。` +
        `${skippedHint}\n\n还原前会先把现在的内容备份到 _trash/还原前备份-时间戳/，这一步也能找回。`;
    } else if (group.source === 'delete') {
      title = '把删除的章节放回书文件夹';
      message =
        `会把「${file.name}」复制回书文件夹。\n\n` +
        '它不会自动加回章节列表（避免乱改章号和顺序）；需要的话可以用书卡的「修复 → 从目录重建」找回。' +
        '书里已有同名文件时不会覆盖。';
    } else {
      title = '还原这一章';
      message =
        `会用备份里的「${file.name}」覆盖书里这一章。\n\n` +
        '还原前会先把现在的内容备份到 _trash/还原前备份-时间戳/。';
    }
    const confirmed = await openModal({
      title,
      message,
      buttons: [
        { label: '取消', value: 'cancel' },
        { label: '还原', value: 'ok', kind: 'danger' }
      ],
      cancelValue: 'cancel'
    });
    if (confirmed.action !== 'ok') return { ok: false, canceled: true };
    try {
      const data = wholeGroup
        ? await call(api.restoreHistoryDir, current.path, group.id)
        : await call(api.restoreHistoryFile, current.path, group.id, file.name);
      const wasOpen = sameBookPath(state.bookPath, current.path);
      if (wasOpen && Number(data && data.restored) > 0 && group.source !== 'delete') {
        await reloadOpenBookFromDisk();
      }
      await refreshShelf();
      if (state.history === current) await refreshHistory();
      if (data && data.file && group.source === 'delete') {
        toast(`已把「${data.file}」放回书文件夹（章节列表未变，需要时可从目录重建找回）`);
      } else {
        toast(
          `已还原 ${Number(data && data.restored) || 0} 章` +
            `${data && data.skipped ? `（跳过 ${data.skipped} 个不是当前章节的文件）` : ''}，` +
            '还原前的内容已备份到 _trash'
        );
      }
      return { ok: true, data };
    } catch (err) {
      toast(`还原失败：${err.message}`, 'error');
      await reloadAfterPartialFailure(current.path); // 可能已经还原了几章，界面回到磁盘的真相
      return { ok: false, message: err.message };
    }
  }

  // 事件绑定（与搬前 bindEvents() 里的历史块逐行一致；由渲染层在原位置调用一次）
  function setupHistoryUi() {
    $('btn-history-close').addEventListener('click', closeHistoryDialog);
    $('btn-history-refresh').addEventListener('click', () => refreshHistory());
    $('btn-history-preview-close').addEventListener('click', closeHistoryPreview);
    $('btn-history-open-folder').addEventListener('click', async () => {
      const target = state.history;
      if (!target) return;
      try {
        await call(api.openBookFolder, target.path);
        toast('已在资源管理器打开书文件夹（备份在 _trash 里）');
      } catch (err) {
        toast(`打开文件夹失败：${err.message}`, 'error');
      }
    });
  }


    return {
      sameBookPath,
      openHistoryForPath,
      openHistoryForCurrentBook,
      refreshHistory,
      closeHistoryDialog,
      closeHistoryPreview,
      previewHistoryBackup,
      confirmHistoryRestore,
      setupHistoryUi
    };
  }

  return { create: createHistoryUi, REQUIRED_HOST };
});
