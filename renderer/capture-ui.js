/* 剪贴板面板（单列表视图；2026-11-07 契约 v1 重写，替代旧「逐行三态表单 + 队列视图」两套 UI）。
 *
 * 产品行为（契约 §1）：面板只有一列「复制记录」，每条整块展示截断正文 + 字数 + 时间 + 序号，
 * 右侧两个按钮「正文」「章节」：
 *   · 正文 = 把这一条插到当前打开章节的光标处（有选区替换选区），只标脏、不自动保存；
 *            成功后 toast、面板不关；**这一条随即从列表消失**（2026-11-08 作者要求：与「章节」一样，
 *            用过就消费——pending 清本层内存、队列条目调 capture:queue-remove 由主进程删）。
 *   · 章节 = 用这一条新建一章（章名怎么拆由主进程 core/capture 的 splitRecordTitle 决定；这里只把
 *            原文、插入位置、队列 id 交给 capture:commit-record）。写成功后编辑器跳到新章、面板不关、
 *            被消费的那条记录消失（主进程写章成功才删队列里的原文）。
 * 直捕（Ctrl+Alt+V / 后台监听关 / 队列空）同样落到列表：显示一条「当前剪贴板」pending 记录。
 *
 * 为什么删掉逐行三态表单：让作者逐行选「章节 / 正文 / 忽略」是额外的决策成本；剪贴板历史本质是
 * 「挑一条，要么插正文、要么开新章」。标题拆分规则收到主进程后，渲染层不再需要让作者逐行确认。
 * 旧的 capture:analyze / capture:commit IPC 随之删除（契约 §4）。
 *
 * 分工：本模块只算 + 只改 DOM；读队列 / 读剪贴板 / 写盘全部走 host.api + host.call（白名单 IPC）。
 * 事件绑定（列表点击委托 / 插入位置 change / Esc）留在 renderer.js（与其它已拆模块同一惯例）；
 * 测试钩子在 renderer/test-hooks.js，按名字调用这里交出的入口。
 *
 * 契约：createCaptureUi(host) 由渲染层调用一次，host 正好 9 个成员（契约 §5）：
 *   { $, state, api, call, toast, saveCurrent, loadChapterAt, renderStatsUi, insertIntoBody }
 * 缺任何一个直接抛 TypeError（宁可在启动时炸，也不要到点捕获时 ReferenceError）。
 * insertIntoBody(text) → { ok, chars?, message? }：T3 在 renderer.js 实现（原生 execCommand 保 Ctrl+Z，
 * 失败手动拼接兜底）；本模块只负责「什么时候调、成功 / 失败怎么反馈」。
 *
 * 队列条目正文不随 list() 下发：只有点「正文」/「章节」时才按 id 走 capture:queue-get 取回，
 * 面板列表拿到的只是主进程截好的 previewText（最多 300 字 / 6 行），隐私口径与旧队列一致。
 *
 * 面板状态只在本模块内存里（open / busy / position / queue / pendingText / tooLarge），不进渲染层 state。
 * 浏览器里挂成全局 CWCaptureUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 * 红线：只读 state / 只走既有 IPC 白名单 / 只改 DOM；不写盘、不改正文、不改数据格式 / config。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../core/chapters'), require('../core/capture'), require('../core/common'));
  } else if (root) {
    root.CWCaptureUi = factory(root.CWChapters, root.CWCapture, root.CWCommon);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (chaptersLib, captureLib, commonLib) {
  'use strict';

  // 依赖只认契约保留的公开面：章节标题格式化（toast 用）、字数 / 截断 / 上限（core/capture），
  // 千分位与补零（core/common，全应用同一份实现）。缺了就在加载期炸，别等到打开面板才 ReferenceError。
  if (!chaptersLib || typeof chaptersLib.formatTitle !== 'function') {
    throw new TypeError('capture-ui 需要 core/chapters.js（window.CWChapters）先加载');
  }
  if (
    !captureLib ||
    typeof captureLib.countChars !== 'function' ||
    typeof captureLib.recordPreview !== 'function'
  ) {
    throw new TypeError('capture-ui 需要 core/capture.js（window.CWCapture）的 countChars / recordPreview 先加载');
  }
  if (!commonLib || typeof commonLib.formatCount !== 'function' || typeof commonLib.pad2 !== 'function') {
    throw new TypeError('capture-ui 需要 core/common.js（window.CWCommon）先加载');
  }
  const { formatCount, pad2 } = commonLib;

  // 契约 §5：host 正好 9 个成员。insertIntoBody 是 2026-11-07 新增的（正文按钮把内容插进当前章）。
  const REQUIRED_HOST = [
    '$',
    'state',
    'api',
    'call',
    'toast',
    'saveCurrent',
    'loadChapterAt',
    'renderStatsUi',
    'insertIntoBody'
  ];

  // 1.3.0 T4（I-06）：空状态三件套。列表为空时 summary 说明状态（真空，只驻内存），下面这行给
  // 学习线索 + 直接路径——都指向现有入口（设置里的后台监听 / Ctrl+Alt+V / 每条记录的「正文」「章节」），
  // 不加新按钮、不加插画。
  const EMPTY_TEXT =
    '在「设置 → 写作统计」里打开「后台监听剪贴板」后，复制的新文字会各记一条；' +
    '也可以直接按 Ctrl+Alt+V 捕获当前剪贴板的一段。每条记录右侧点「正文」或「章节」处理，处理完就从列表移除。';
  const EMPTY_PREVIEW = '（没有可预览的文字）';

  // 插入位置（b11）：新章插到哪——「全书末尾」（默认）/「当前章之后」。
  // 返回 { insertIndex, volumeId }：卷跟随当前章（与现有「新建章节」同一条规则；
  // 有卷时 storage.createChapterWithText 会插到该卷末尾，不会跑到别的卷中间）。
  // 当前章不存在（索引越界 / 空书）时一律回退到全书末尾。
  function computeInsertTarget(chapters, index, mode) {
    const list = Array.isArray(chapters) ? chapters : [];
    const currentIndex = Number.isInteger(index) && index >= 0 && index < list.length ? index : -1;
    const current = currentIndex >= 0 ? list[currentIndex] : null;
    const volumeId = current && current.volumeId ? current.volumeId : null;
    if (mode === 'after-current' && current) {
      return { insertIndex: currentIndex + 1, volumeId };
    }
    return { insertIndex: list.length, volumeId };
  }

  function createCaptureUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createCaptureUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) {
        throw new TypeError('createCaptureUi 的 host 缺少 ' + key);
      }
    }
    const { $, state, api, call, toast, saveCurrent, loadChapterAt, renderStatsUi, insertIntoBody } = host;

    // ---------- 面板状态（只在内存；不进渲染层 state） ----------
    const panel = {
      open: false,
      busy: false, // 正文插入 / 新建章节 / 清空进行中：所有动作按钮 + 清空 + 取消全禁用
      position: 'end', // b11：'end'（全书末尾，默认）/ 'after-current'（当前章之后）
      queue: [], // [{ id, chars, at, previewText }] 主进程队列元数据，不含正文
      pendingText: null, // 直捕：当前剪贴板原文（未入队，只有这一条在渲染层内存里）
      tooLarge: false // 直捕正文 >30 万字点「章节」后置位：显示「去导入小说…」
    };

    // 时间只显示「时:分」：队列只记本次运行，日期没有信息量。
    function clockText(at) {
      const ms = Number(at);
      if (!Number.isFinite(ms) || ms <= 0) return '';
      const date = new Date(ms);
      return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    }

    // 拉一次队列元数据（不含正文）。IPC 异常往上抛，由调用方决定「当空」还是提示。
    async function fetchQueue() {
      if (!api || typeof api.captureQueueList !== 'function') return [];
      const data = await call(api.captureQueueList);
      const entries = data && Array.isArray(data.entries) ? data.entries : [];
      return entries
        .map((item) => {
          // previewText 是契约 §3 的新字段（300 字 / 6 行）；T2 未升级的主进程只给首行 preview，
          // 这里兼容一下，面板不至于空白。
          const previewText =
            typeof (item && item.previewText) === 'string'
              ? item.previewText
              : typeof (item && item.preview) === 'string'
                ? item.preview
                : '';
          return {
            id: Number(item && item.id),
            chars: Number(item && item.chars) || 0,
            at: Number(item && item.at) || 0,
            previewText
          };
        })
        .filter((item) => Number.isFinite(item.id));
    }

    function queueSupported() {
      return Boolean(api && typeof api.captureQueueList === 'function');
    }

    // 渲染用的记录清单：pending（当前剪贴板）在前，队列按复制顺序（旧 → 新）在后。
    // chars 用原文长度：与主进程队列条目同一口径（core/capture-queue 的 chars = source.length）。
    function buildRecords() {
      const records = [];
      const pending = panel.pendingText;
      if (typeof pending === 'string' && pending.trim()) {
        records.push({
          kind: 'pending',
          chars: pending.length,
          at: 0,
          previewText: captureLib.recordPreview(pending)
        });
      }
      const queue = Array.isArray(panel.queue) ? panel.queue : [];
      queue.forEach((item, index) => {
        records.push({
          kind: 'queue',
          id: item.id,
          no: index + 1,
          chars: item.chars,
          at: item.at,
          previewText: item.previewText || ''
        });
      });
      return records;
    }

    function summaryText(records) {
      const queueCount = (panel.queue || []).length;
      const hasPending = Boolean(panel.pendingText && panel.pendingText.trim());
      if (!records.length) return '本次运行还没有记到复制过的文字（只在本机内存，关闭应用即清空）。';
      const parts = [];
      if (queueCount > 0) parts.push(`本次运行共记了 ${queueCount} 段`);
      if (hasPending) parts.push('当前剪贴板一段（未入队）');
      return `${parts.join('，')}（只在本机内存；关闭应用即清空）。点「正文」插到当前章光标处，点「章节」用这一条新建一章。`;
    }

    function recordRow(record) {
      const row = document.createElement('div');
      row.className = 'capture-record';
      if (typeof row.setAttribute === 'function') row.setAttribute('role', 'listitem');
      if (record.kind === 'queue') row.dataset.id = String(record.id);
      else row.dataset.pending = '1';

      const head = document.createElement('div');
      head.className = 'capture-record-head';
      const no = document.createElement('span');
      no.className = 'capture-record-no';
      no.textContent = record.kind === 'queue' ? String(record.no) : '·';
      head.appendChild(no);
      const meta = document.createElement('span');
      meta.className = 'capture-record-meta';
      const clock = clockText(record.at);
      meta.textContent = `${formatCount(record.chars)} 字${clock ? ` · ${clock}` : ''}`;
      head.appendChild(meta);
      if (record.kind === 'pending') {
        const badge = document.createElement('span');
        badge.className = 'capture-record-badge';
        badge.textContent = '当前剪贴板';
        head.appendChild(badge);
      }
      row.appendChild(head);

      const text = document.createElement('div');
      text.className = 'capture-record-text';
      text.textContent = record.previewText || EMPTY_PREVIEW;
      row.appendChild(text);

      const actions = document.createElement('div');
      actions.className = 'capture-record-actions';
      for (const [action, label] of [
        ['body', '正文'],
        ['chapter', '章节']
      ]) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn ghost tiny';
        btn.textContent = label;
        btn.dataset.action = action;
        if (record.kind === 'queue') btn.dataset.id = String(record.id);
        else btn.dataset.pending = '1';
        btn.disabled = panel.busy;
        actions.appendChild(btn);
      }
      row.appendChild(actions);
      return row;
    }

    function render() {
      if (!panel.open) return;
      const records = buildRecords();
      // 单列表视图：容器始终显示（旧 HTML 带 hidden 的缓存页也兜一下）。
      const viewEl = $('capture-queue-view');
      if (viewEl) viewEl.classList.remove('hidden');
      const summaryEl = $('capture-queue-summary');
      if (summaryEl) summaryEl.textContent = summaryText(records);
      const positionEl = $('capture-position');
      if (positionEl) positionEl.value = panel.position;

      const listEl = $('capture-queue-list');
      if (listEl) {
        listEl.innerHTML = '';
        // 整队列先离线拼进 DocumentFragment，最后一次性挂上：长队列不再逐条碰 live DOM。
        const frag = document.createDocumentFragment();
        for (const record of records) frag.appendChild(recordRow(record));
        listEl.appendChild(frag);
      }

      const emptyEl = $('capture-queue-empty');
      if (emptyEl) {
        const empty = records.length === 0;
        emptyEl.textContent = empty ? EMPTY_TEXT : '';
        emptyEl.dataset.emptyKind = empty ? 'vacuum' : '';
        emptyEl.classList.toggle('hidden', !empty);
      }

      // b9：只有「直捕正文超限」才显示「去导入小说…」；跳转由 renderer.js 绑定（关面板 → 回书架 →
      // 打开导入对话框，这里不写任何文件）。
      const importBtn = $('btn-capture-import');
      if (importBtn) {
        importBtn.classList.toggle('hidden', !panel.tooLarge);
        importBtn.disabled = panel.busy;
      }
      const clearBtn = $('btn-capture-queue-clear');
      if (clearBtn) clearBtn.disabled = panel.busy || records.length === 0;
      const cancelBtn = $('btn-capture-queue-cancel');
      if (cancelBtn) cancelBtn.disabled = panel.busy;
    }

    // 打开 / 重画后把焦点给第一条记录的「正文」；没有记录就给「取消」。
    function focusList() {
      setTimeout(() => {
        if (!panel.open) return;
        const list = $('capture-queue-list');
        const first =
          list && typeof list.querySelector === 'function' ? list.querySelector('button[data-action]') : null;
        if (first && typeof first.focus === 'function') {
          first.focus();
          return;
        }
        const cancel = $('btn-capture-queue-cancel');
        if (cancel && !cancel.disabled && typeof cancel.focus === 'function') cancel.focus();
      }, 30);
    }

    // 打开列表视图：entries 是队列元数据，pendingText 是「当前剪贴板」（没有就 null）。
    function showList(entries, pendingText) {
      panel.open = true;
      panel.busy = false;
      panel.queue = Array.isArray(entries) ? entries : [];
      panel.pendingText = typeof pendingText === 'string' && pendingText.trim() ? pendingText : null;
      panel.tooLarge = false;
      panel.position = 'end'; // b11：每次打开都回到默认「全书末尾」
      const backdrop = $('capture-backdrop');
      if (backdrop) backdrop.classList.remove('hidden');
      render();
      focusList();
    }

    // 打开前的公共检查（优先级与旧实现一致：已开着 → 没打开书 → 别的弹层挡着）。
    function preflight() {
      if (panel.open) return { ok: false, code: 'ALREADY_OPEN' }; // 保护用户正在看的列表
      if (!state.bookPath || state.view !== 'editor') {
        toast('先打开一本书，再从剪贴板捕获', 'warn');
        return { ok: false, code: 'NO_BOOK' };
      }
      if (panelBlocked()) {
        toast('先关闭当前弹窗，再从剪贴板捕获', 'warn');
        return { ok: false, code: 'PANEL_BUSY' };
      }
      return null;
    }

    function panelBlocked() {
      return [
        'modal-backdrop',
        'settings-backdrop',
        'export-backdrop',
        'find-backdrop',
        'format-backdrop',
        'jump-backdrop',
        'history-backdrop',
        'bookinfo-backdrop',
        'conflict-backdrop'
      ].some((id) => {
        const el = $(id);
        return el && !el.classList.contains('hidden');
      });
    }

    // 打开面板：preloadedText 是全局快捷键 / 测试钩子已经读好的剪贴板原文。
    // 传了原文 → 列表里只有一条 pending；没传 → 先看队列，队列空才读剪贴板（空剪贴板 toast 不开面板）。
    // options.beforeOpen：通过遮挡检查后、真正读剪贴板之前调用（渲染层用它收起顶栏菜单）。
    async function open(preloadedText, options = {}) {
      const blocked = preflight();
      if (blocked) return blocked;
      if (typeof options.beforeOpen === 'function') options.beforeOpen();
      if (typeof preloadedText === 'string') {
        if (!preloadedText.trim()) {
          toast('剪贴板里没有文字。先复制正文，再按 Ctrl+Alt+V', 'warn');
          return { ok: false, code: 'EMPTY_CLIPBOARD' };
        }
        showList([], preloadedText);
        return { ok: true, view: 'list', count: 0, pending: true, queued: false };
      }
      // 打开前补一拍监听（2026-11-07 修「复制 4 次只记 2 次」）：轮询已缩到 300ms，
      // 但「刚复制就点捕获」仍可能落在两拍之间；先让主进程主动读一次，队列里才不会有缺口。
      if (api && typeof api.captureFlushWatch === 'function') {
        try {
          await call(api.captureFlushWatch);
        } catch {
          /* 补拍失败不影响打开面板 */
        }
      }
      let entries = [];
      let queueReadFailed = false;
      try {
        entries = await fetchQueue();
      } catch (err) {
        queueReadFailed = true; // 队列读不到就当空：读当前剪贴板仍然可用，别把作者挡在面板外
      }
      if (!queueReadFailed && entries.length > 0) {
        showList(entries, null);
        return { ok: true, view: 'list', count: entries.length, pending: false, queued: false };
      }
      let text = '';
      try {
        const data = await call(api.captureClipboard);
        text = (data && data.text) || '';
      } catch (err) {
        toast(`读取剪贴板失败：${err.message}`, 'error');
        return { ok: false, message: err.message, code: err.code };
      }
      if (!String(text).trim()) {
        toast('剪贴板里没有文字。先复制正文，再按 Ctrl+Alt+V', 'warn');
        return { ok: false, code: 'EMPTY_CLIPBOARD' };
      }
      showList([], text);
      return { ok: true, view: 'list', count: 0, pending: true, queued: false };
    }

    // 全局快捷键 / 主进程 capture:triggered 的入口：payload 带 { text, queued }。
    // queued=true 表示这段已经进队列（不再重复显示「当前剪贴板」行）；队列里若已有别的记录也一并列出，
    // 作者可以顺手处理。队列空且没入队 → 退回 open（读剪贴板），最终仍然是列表视图。
    async function openTriggered(preloadedText, queued) {
      const blocked = preflight();
      if (blocked) return blocked;
      const wasQueued = queued === true;
      const text = typeof preloadedText === 'string' && preloadedText.trim() ? preloadedText : null;
      let entries = [];
      let queueReadFailed = false;
      try {
        entries = await fetchQueue();
      } catch (err) {
        queueReadFailed = true;
      }
      if (!queueReadFailed && entries.length > 0) {
        showList(entries, wasQueued ? null : text);
        return { ok: true, view: 'list', queued: wasQueued, count: entries.length };
      }
      if (text) {
        showList([], text);
        return { ok: true, view: 'list', queued: false, count: 0, pending: true };
      }
      return open();
    }

    function close() {
      panel.open = false;
      panel.busy = false;
      panel.queue = [];
      panel.pendingText = null;
      panel.tooLarge = false;
      panel.position = 'end';
      const backdrop = $('capture-backdrop');
      if (backdrop) backdrop.classList.add('hidden');
      // 列表内容只在 render 里重建；关掉时顺手清空，避免下次打开前旧记录还挂在隐藏 DOM 上。
      const list = $('capture-queue-list');
      if (list) list.innerHTML = '';
      return { ok: true, closed: true };
    }

    // 取消 / Esc：单列表视图没有「回上一视图」，一律关面板（处理中不允许关，等结果出来）。
    function cancel() {
      if (!panel.open) return { ok: false, code: 'CLOSED' };
      if (panel.busy) return { ok: false, code: 'BUSY' };
      close();
      return { ok: true, closed: true };
    }

    // 队列写失败 / 记录已被别处消费时，尽最大努力重新拉一次列表（失败保留现有列表）。
    async function reloadQueue(excludeId) {
      try {
        panel.queue = await fetchQueue();
      } catch (err) {
        if (excludeId != null) panel.queue = panel.queue.filter((item) => item.id !== excludeId);
      }
    }

    // 再拉一次队列元数据：单列表视图，面板开着就原地重画（新复制的那条直接出现）。
    async function refreshQueue() {
      if (!panel.open) return panel.queue;
      if (panel.busy) return panel.queue;
      try {
        panel.queue = await fetchQueue();
      } catch (err) {
        toast(`读取捕获队列失败：${err.message}`, 'error');
      }
      render();
      return panel.queue;
    }

    // 清空本次运行的队列（只清主进程内存；不删任何章节 / 文件）。pending 行也一起收掉。
    async function clearQueue() {
      if (!panel.open) return { ok: false, code: 'CLOSED' };
      if (panel.busy) return { ok: false, code: 'BUSY' };
      if (!queueSupported() || typeof api.captureQueueClear !== 'function') {
        return { ok: false, code: 'UNSUPPORTED' };
      }
      panel.busy = true;
      render();
      try {
        await call(api.captureQueueClear);
      } catch (err) {
        toast(`清空捕获队列失败：${err.message}`, 'error');
        return { ok: false, code: err.code, message: err.message };
      } finally {
        panel.busy = false;
      }
      panel.queue = [];
      panel.pendingText = null;
      panel.tooLarge = false;
      render();
      toast('已清空本次运行的捕获队列');
      return { ok: true, cleared: true };
    }

    // 把 ref（{ id } 队列条目 / { pending: true } 当前剪贴板）解析成原文。
    // 队列正文不在渲染层：点按钮时才按 id 取回；取不到说明已被消费 / 清空，带上 missing 让调用方刷新列表。
    async function resolveRecordText(ref) {
      if (ref && ref.pending === true) {
        const text = panel.pendingText;
        if (typeof text !== 'string' || !text.trim()) return { ok: false, code: 'NO_PENDING' };
        return { ok: true, text, pending: true };
      }
      const id = Number(ref && ref.id);
      if (!Number.isFinite(id)) return { ok: false, code: 'BAD_ID' };
      const queueId = Math.round(id);
      let data;
      try {
        data = await call(api.captureQueueGet, queueId);
      } catch (err) {
        return { ok: false, code: err.code || 'QUEUE_MISSING', message: err.message, missing: true };
      }
      const text = data && typeof data.text === 'string' ? data.text : '';
      if (!text.trim()) return { ok: false, code: 'EMPTY_ENTRY', missing: true };
      return { ok: true, text, id: queueId };
    }

    // 解析失败时统一提示 + 刷新列表（记录确实不在了，列表必须跟着变）。
    async function resolveOrReport(ref) {
      const resolved = await resolveRecordText(ref);
      if (resolved.ok) return resolved;
      if (resolved.missing) {
        toast('这条复制记录已经不在了', 'warn');
        await reloadQueue(ref && Number(ref.id));
      }
      return resolved;
    }

    // 「正文」：插到当前章光标处。只标脏、不自动保存；插入成功后消费这一条（2026-11-08 作者要求：
    // 与「章节」一样，点完就从列表消失，避免同一条被重复插入、列表越积越多），面板不关。
    async function applyBody(ref) {
      if (!panel.open) return { ok: false, code: 'CLOSED' };
      if (panel.busy) return { ok: false, code: 'BUSY' };
      panel.busy = true;
      render();
      try {
        const resolved = await resolveOrReport(ref);
        if (!resolved.ok) return resolved;
        let result;
        try {
          result = await insertIntoBody(resolved.text);
        } catch (err) {
          result = { ok: false, message: err.message };
        }
        if (!result || result.ok === false) {
          const message = (result && result.message) || '未知错误';
          toast(`插入正文失败：${message}`, 'error');
          return { ok: false, code: 'INSERT_FAILED', message };
        }
        const chars = Number(result.chars) || captureLib.countChars(resolved.text);
        // 只有插入成功才消费。pending 只在本层内存里，直接清；队列条目交给主进程原子删。
        // 删失败 / 这条已被别处消费也不把记录留在列表上：正文已经进编辑区，再点一次只会重复插入。
        if (resolved.pending) {
          panel.pendingText = null;
        } else {
          let removed = false;
          try {
            if (api && typeof api.captureQueueRemove === 'function') {
              const data = await call(api.captureQueueRemove, resolved.id);
              removed = Boolean(data && data.removed);
            }
          } catch {
            /* 插入已经成功：删队列失败不打断，下面兜底把本地列表里这条去掉 */
          }
          if (removed) await reloadQueue(resolved.id);
          else panel.queue = panel.queue.filter((item) => item.id !== resolved.id);
        }
        toast(`已插入正文（${formatCount(chars)} 字），这条记录已从列表移除`);
        // 键盘连续处理：焦点交给下一条的「正文」（列表空了就落到「取消」），不用每次重新 Tab。
        focusList();
        return { ok: true, chars, consumed: true };
      } finally {
        panel.busy = false;
        render();
      }
    }

    // 「章节」：用这一条新建一章。写前当前章有未保存修改先保存（与「新建章节」同一行为，不弹窗）。
    // 成功后：换书目 → 刷新统计 → 编辑器跳到新章 → 重新拉队列（被消费的记录消失）→ 面板保持打开。
    async function createChapter(ref) {
      if (!panel.open) return { ok: false, code: 'CLOSED' };
      if (panel.busy) return { ok: false, code: 'BUSY' };
      panel.busy = true;
      render();
      try {
        const resolved = await resolveOrReport(ref);
        if (!resolved.ok) return resolved;
        const text = resolved.text;
        const chars = text.length;
        // 单条 >30 万字本来就不入队；直捕的超长内容点「章节」时这里拦下：不调 IPC，给导入引导。
        if (chars > captureLib.MAX_BODY_CHARS) {
          panel.tooLarge = true;
          toast(
            `内容太长（${formatCount(chars)} 字，最多 ${formatCount(captureLib.MAX_BODY_CHARS)} 字）；` +
              '剪贴板捕获一次只新建一章，请先拆成多段再捕获，或用「去导入小说…」',
            'warn'
          );
          return { ok: false, code: 'TOO_LARGE', chars };
        }
        if (state.dirty) {
          const saved = await saveCurrent();
          if (!saved || saved.ok === false) return saved || { ok: false, code: 'SAVE_FAILED' };
        }
        const target = state.bookPath;
        const insertTarget = computeInsertTarget(state.chapters, state.index, panel.position);
        const payload = { text, insertIndex: insertTarget.insertIndex, volumeId: insertTarget.volumeId };
        // 从队列来的才带 queueId：主进程写章成功后才原子删除该条（失败 / 取消都不删）。
        if (resolved.id != null) payload.queueId = resolved.id;
        let data;
        try {
          data = await call(api.captureCommitRecord, target, payload);
        } catch (err) {
          toast(`新建章节失败：${err.message}`, 'error');
          return { ok: false, message: err.message, code: err.code };
        }
        if (!data || !data.meta || !Array.isArray(data.meta.chapters)) {
          toast('新建章节失败：主进程没有返回书目', 'error');
          return { ok: false, code: 'BAD_RESPONSE' };
        }
        state.meta = data.meta;
        state.chapters = data.meta.chapters;
        if (data.stats) {
          state.stats = data.stats;
          if (data.stats.streak) state.streak = data.stats.streak;
          renderStatsUi();
        }
        await loadChapterAt(data.index);
        // 被消费的记录消失：pending 只在本层内存里，直接清；队列重新拉（主进程已按 queueId 删掉原文）。
        if (resolved.pending) panel.pendingText = null;
        await reloadQueue(resolved.id);
        panel.tooLarge = false;
        // titleOnly（整条 <100 字当章名、没有正文）时主进程返回 bodyChars=0 / chars=0：
        // 不能拿整条原文长度回退，否则 toast 会把章名字数当成正文字数报出去。
        const written = Number(data.bodyChars) || Number(data.chars) || 0;
        const chapterName = data.chapter && data.chapter.name ? data.chapter.name : '';
        const displayTitle = chaptersLib.formatTitle(state.meta, data.index, chapterName);
        const detail = data.titleOnly ? '仅章名' : `${formatCount(written)} 字`;
        toast(`已从剪贴板新建：${displayTitle}（${detail}）`);
        return {
          ok: true,
          index: data.index,
          chars: written,
          title: data.title,
          titleOnly: Boolean(data.titleOnly),
          queueRemoved: Boolean(data.queueRemoved)
        };
      } finally {
        panel.busy = false;
        render();
      }
    }

    // b11：插入位置（renderer.js 在 select change 时调用；测试钩子也用它）。非法值按默认处理。
    function setPosition(mode) {
      panel.position = mode === 'after-current' ? 'after-current' : 'end';
      const el = $('capture-position');
      if (el) el.value = panel.position;
      return panel.position;
    }

    return {
      // 渲染层 / 测试钩子用到的入口（页面里的按钮事件绑定仍留在 renderer.js 的 bindEvents）
      open,
      openTriggered,
      close,
      cancel,
      refreshQueue,
      clearQueue,
      applyBody,
      createChapter,
      setPosition,
      position: () => panel.position,
      // 单列表视图：旧 view() 的 'queue' / 'form' 两态已经不存在，恒为 'list'（E2E / 钩子兼容用）。
      view: () => 'list',
      queueItems: () => (panel.queue || []).map((item) => ({ ...item })),
      queueSummaryText: () => {
        const el = $('capture-queue-summary');
        return el ? el.textContent : '';
      },
      queueEmptyText: () => {
        const el = $('capture-queue-empty');
        return el ? el.textContent : '';
      },
      isOpen: () => panel.open,
      isBusy: () => panel.busy,
      // 测试钩子：面板当前展示的记录（不含正文，只有元数据 + 截断预览）。
      records: () =>
        buildRecords().map((record) => {
          const out = { kind: record.kind, chars: record.chars, previewText: record.previewText };
          if (record.kind === 'queue') out.id = record.id;
          return out;
        })
    };
  }

  return { create: createCaptureUi, REQUIRED_HOST, computeInsertTarget };
});
