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
 * 契约：createHistoryUi(host) 由渲染层调用一次。host 9 个成员（含 3 个语义分组，分组内每个真实依赖都列在这里）：
 *   host = {
 *     $, state, api, call, toast,                      // 基础 5：DOM 查询 / 共享状态 / IPC 白名单 / IPC 包装 / 提示
 *     guard: {                                          // 1.5.0 P0-5（审计 V-2）：撤销前的备份指纹核对
 *       fingerprint,                                   //   登记撤销时记 { dirName, fileCount, mtimeMs }（读不到 = null）
 *       assertUnchanged                                //   撤销执行前再核一次，备份变了抛「备份已变化，撤销取消」
 *     },
 *     collab: {                                        // 与「当前书 / 当前编辑区」协作的渲染层回调
 *       confirmRestoreWithUnsaved,                     //   「还原前」未保存三选一 + 保存失败即停（与整本替换备份还原共用一份实现）
 *       openModal,                                     //   通用询问框（1.4.0 P0-2 起历史还原不再二次确认）
 *       registerUndo,                                  //   登记 10 秒撤销（历史还原用还原前备份还原；1.4.0 P0-2）
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
 * P22-5（1.1.0 内容批）：每日快照组（core/history.js 严格认出「快照-YYYYMMDD」的组才带 snapshotName）
 * 默认折叠、组头是带 aria-expanded 的原生 button（键盘可达），并多一个「清空这天的快照」——
 * 二次确认后只走 api.clearSnapshotDay 把那一个目录移入 Windows 回收站（绝不硬删），成功刷新清单 / 书架，
 * 失败只 toast、清单保持原样。折叠状态放在 state.history.collapsed（按组 id，面板关掉即失效，不写盘、不进 config）；
 * 其它来源的组仍然是「默认展开 + 只有还原整组」，行为一个字节没变。
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

  const REQUIRED_HOST = ['$', 'state', 'api', 'call', 'toast', 'guard', 'collab', 'menus', 'fmt'];

  function createHistoryUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createHistoryUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) throw new TypeError('createHistoryUi 的 host 缺少 ' + key);
    }
    const { $, state, api, call, toast, guard, collab, menus, fmt } = host;
    if (typeof guard !== 'object') throw new TypeError('createHistoryUi 的 host.guard 必须是对象');
    for (const key of ['fingerprint', 'assertUnchanged']) {
      if (typeof guard[key] !== 'function') throw new TypeError('createHistoryUi 的 host.guard 缺少 ' + key);
    }
    if (typeof collab !== 'object') throw new TypeError('createHistoryUi 的 host.collab 必须是对象');
    for (const key of ['confirmRestoreWithUnsaved', 'openModal', 'registerUndo', 'refreshShelf', 'reloadAfterPartialFailure', 'reloadOpenBookFromDisk']) {
      if (collab[key] === undefined || collab[key] === null) throw new TypeError('createHistoryUi 的 host.collab 缺少 ' + key);
    }
    if (typeof menus !== 'object') throw new TypeError('createHistoryUi 的 host.menus 必须是对象');
    for (const key of ['hideBookMenu', 'hideExportMenu']) {
      if (menus[key] === undefined || menus[key] === null) throw new TypeError('createHistoryUi 的 host.menus 缺少 ' + key);
    }
    if (typeof fmt !== 'object' || fmt.formatBytes === undefined || fmt.formatBytes === null) {
      throw new TypeError('createHistoryUi 的 host.fmt 缺少 formatBytes');
    }
    const { confirmRestoreWithUnsaved, openModal, registerUndo, refreshShelf, reloadAfterPartialFailure, reloadOpenBookFromDisk } = collab;
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
      // 每日快照组的折叠状态（按组 id）：只活在本面板里，关掉即失效，不写盘、不进 config
      collapsed: {},
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

  // ---------- 每日快照组（P22-5）：默认折叠 + 清空某天（只移入回收站） ----------
  // core/history.js 只给「快照-YYYYMMDD 且日期真实存在」的组带 snapshotName；其它来源的组
  // （替换 / 整理 / 还原前 / 删章 / 书目）一个字节都不变：默认展开、照旧只有「还原整组」。
  function isSnapshotDayGroup(group) {
    return Boolean(group && group.kind === 'dir' && group.snapshotName);
  }

  // 折叠状态只放在 state.history.collapsed（按组 id）：面板一关就没了，不写盘、不进 config。
  // 没记过 = 折叠（每日快照组的默认），记成 false = 作者展开过。
  function collapsedMap() {
    const current = state.history;
    if (!current) return {};
    if (!current.collapsed || typeof current.collapsed !== 'object') current.collapsed = {};
    return current.collapsed;
  }

  function isGroupCollapsed(group) {
    if (!isSnapshotDayGroup(group)) return false;
    return collapsedMap()[group.id] !== false;
  }

  function toggleSnapshotGroup(group) {
    const current = state.history;
    if (!current || !isSnapshotDayGroup(group)) return false;
    collapsedMap()[group.id] = !isGroupCollapsed(group);
    renderHistory();
    return true;
  }

  function makeRestoreGroupButton(group) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn ghost tiny history-restore-group';
    button.textContent = `还原整组（${group.restorableCount}）`;
    button.title = '只还原现在仍在书里的章节；还原前先把当前内容备份一份';
    button.addEventListener('click', () => confirmHistoryRestore(group, null, true));
    return button;
  }

  function makeClearSnapshotButton(group) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn ghost tiny history-clear-snapshot';
    button.textContent = '清空这天的快照';
    button.title = `把 ${group.snapshotName} 整组移入 Windows 回收站（可从回收站恢复）；不影响其它备份`;
    button.addEventListener('click', () => clearSnapshotDay(group));
    return button;
  }

  function buildHistoryGroup(group) {
    const card = document.createElement('div');
    card.className = 'history-group';
    card.dataset.groupId = group.id;
    card.dataset.source = group.source;

    const snapshotGroup = isSnapshotDayGroup(group);
    const collapsed = isGroupCollapsed(group);
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
    if (snapshotGroup) {
      // 组头的主体是一枚原生 button（Tab / Enter / 空格可达）：aria-expanded 跟着折叠状态走，
      // 折叠时组头照样显示来源 / 时间 / N 个文件 / 大小，只是下面的文件行不渲染。
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'history-group-toggle';
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      toggle.title = collapsed ? '展开这一天的快照' : '收起这一天的快照';
      const chevron = document.createElement('span');
      chevron.className = 'history-group-chevron';
      chevron.setAttribute('aria-hidden', 'true');
      chevron.textContent = collapsed ? '▸' : '▾';
      toggle.append(chevron, source, time, count);
      toggle.addEventListener('click', () => toggleSnapshotGroup(group));
      head.appendChild(toggle);
    } else {
      head.append(source, time, count);
    }
    if (snapshotGroup) {
      // 折叠时连「还原整组」一起收起（避免在看不见文件的情况下整组还原）；「清空这天的快照」始终在组头
      const actions = document.createElement('span');
      actions.className = 'history-group-actions';
      if (!collapsed && group.restorableCount > 0) actions.appendChild(makeRestoreGroupButton(group));
      actions.appendChild(makeClearSnapshotButton(group));
      head.appendChild(actions);
    } else if (group.kind === 'dir' && group.restorableCount > 0) {
      head.appendChild(makeRestoreGroupButton(group));
    }
    card.appendChild(head);

    const note = document.createElement('div');
    note.className = 'history-note';
    note.textContent = group.note;
    card.appendChild(note);

    if (collapsed) return card;
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
    // 1.4.0 P0-2（撤销优先于确认）：历史还原不再弹二次确认 —— 直接还原。
    // 覆盖型还原（整组 / 单章覆盖）由 storage 先把现在的内容备份到 _trash/还原前备份-*，10 秒内可撤销；
    // 「删除章节」那种是把 txt 复制回书文件夹（不覆盖、不加回章节列表，属于加法动作），不需要撤销。
    const bookPath = current.path;
    try {
      const data = wholeGroup
        ? await call(api.restoreHistoryDir, current.path, group.id)
        : await call(api.restoreHistoryFile, current.path, group.id, file.name);
      const wasOpen = sameBookPath(state.bookPath, current.path);
      if (wasOpen && Number(data && data.restored) > 0 && group.source !== 'delete') {
        await reloadOpenBookFromDisk();
      }
      const undoName = data && data.restoreBackupDir ? String(data.restoreBackupDir).split(/[\\/]/).pop() : '';
      if (undoName && group.source !== 'delete' && typeof registerUndo === 'function') {
        // 1.5.0 P0-5（审计 V-2）：登记撤销时记下这份「还原前备份」的指纹（目录名 + 文件数 + 最大 mtime）；
        // 撤销执行前再核一次，目录被增删 / 改写就报「备份已变化，撤销取消」并早退，不拿变了的备份覆盖正文。
        const expectedBackup = await guard.fingerprint(bookPath, undoName);
        registerUndo(`已还原 ${Number(data.restored) || 0} 章（${group.sourceLabel}）`, async () => {
          if (state.bookPath !== bookPath) throw new Error('已经换了书，不能撤销');
          await guard.assertUnchanged(bookPath, expectedBackup);
          const back = await call(api.restoreHistoryDir, bookPath, `dir:${undoName}`);
          if (!back || !Number(back.restored)) throw new Error('还原前备份里没有可还原的章节');
          await reloadOpenBookFromDisk();
          await refreshShelf();
          if (state.history === current) await refreshHistory();
        });
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

  // 清空某一天的每日快照（P22-5）：二次确认 → 只把这一个目录移入 Windows 回收站 → 刷新清单 / 汇总。
  // 只认 core/history.js 严格认出「快照-YYYYMMDD」的组；失败（含回收站不可用）只 toast，清单保持原样。
  // 文案写清「只影响这一组、可以从回收站恢复」——这里不做任何删除降级。
  async function clearSnapshotDay(group) {
    const current = state.history;
    if (!current || !isSnapshotDayGroup(group)) return { ok: false };
    // 1.4.0 P0-2：清空某天快照不再弹确认框 —— 直接把这一个快照目录移入 Windows 回收站。
    // 这是「整组移入回收站」而不是硬删，外部回收站可还原；应用内没有撤销资源，属于记录在案的例外。
    try {
      const data = await call(api.clearSnapshotDay, current.path, group.snapshotName);
      if (state.history === current) await refreshHistory();
      await refreshShelf();
      toast(`已把「${group.snapshotName}」移入回收站，可从回收站恢复`);
      return { ok: true, data };
    } catch (err) {
      // 清空失败（校验不过 / 回收站不可用…）：清单保持原样，不动其它任何备份
      toast(`清空失败：${err.message}`, 'error');
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
