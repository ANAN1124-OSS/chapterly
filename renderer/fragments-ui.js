/* 灵感箱 / 碎片速记（第 4 步 renderer 九刀·补刀 10：从 renderer.js 的「灵感箱」分区整段搬出来）。
 *
 * 搬走的段（原 renderer.js 2747–2978，232 行）——书架「＋ 碎片」与写作页「插入碎片…」两个弹层：
 *   updateFragmentCounter / setFragmentSaveState / openFragmentDialog / closeFragmentDialog / saveFragment /
 *   fragmentSizeText / fragmentMetaText / openInsertFragmentDialog / closeInsertFragmentDialog /
 *   highlightSelectedFragment / renderFragments / refreshFragments / selectFragmentByName / insertSelectedFragment。
 * **只搬不改行为**：碎片文件全部由主进程 core/fragments.js 读写（原子写 / 防覆盖有单测）；这里只做两个弹层，
 * 文案 / class / dataset / 空态 / 保存防重 / execCommand 撤销链与手动拼接兜底 / 预览 2 万字上限 /
 * 插入位置按「打开面板前的选区」全部一字未改；插入只改编辑区、绝不写盘、绝不删除原碎片。
 * 1.5.0 功能-3：插入面板的碎片行可以**拖进正文**。拖拽和「插入到光标处」共用同一个 insertFragmentAt()
 * （仍是 execCommand('insertText')，原生 Ctrl+Z 撤销链不变）；dataTransfer 只带碎片名，完整内容按名字现读；
 * 落点用 document.caretPositionFromPoint（textarea 在 Chromium 里只有它会回字符下标），取不到退回当前光标。
 * 事件绑定随域搬进 setupFragmentsUi()（＋碎片 / 保存 / 取消 / 计数 / Ctrl+Enter / 插入面板 4 个按钮）。
 *
 * 契约：createFragmentsUi(host) 由渲染层调用一次。host 8 个成员（2 个语义分组 + 基础 5 + 1 个胶水）：
 *   host = {
 *     $, state, api, call, toast,          // 基础 5：DOM 查询 / 共享状态（fragments、fragmentSelected、fragmentBusy、insertFragmentRange）/ IPC 白名单 / IPC 包装 / 提示
 *     common: {                             // 共享纯逻辑 / 格式化
 *       chaptersLib,                        //   core/chapters.js：正文字数口径 countChars
 *       formatRelativeTime                  //   「3 分钟前」…
 *     },
 *     editor: {                             // 编辑区
 *       editorEl,                           //   插入碎片只改它（不写盘）
 *       onEditorInput,                      //   插入后触发一次输入处理（dirty / 字数）
 *       scrollCaretIntoView                 //   插入后把光标滚进视野（共享胶水）
 *     },
 *     hideHeaderMenus                       // 打开弹层前收起顶栏菜单
 *   }
 * 缺任何一个（含分组内成员）直接抛 TypeError。分组在 create 时一次解构，行为等价。
 * create() 不注册事件、不建定时器、不碰 DOM；事件绑定在 setupFragmentsUi()，由 bindEvents() 在原位置调用一次
 * （openFragmentDialog 里的 30ms 聚焦定时器是原有行为，随函数搬走）。
 *
 * 刻意不搬（留在 renderer.js）：书架 / 写作页顶栏按钮本身、Esc 动作表、测试钩子宿主契约。
 *
 * 浏览器里挂成全局 CWFragmentsUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWFragmentsUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HOST = ['$', 'state', 'api', 'call', 'toast', 'common', 'editor', 'hideHeaderMenus'];

  function createFragmentsUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createFragmentsUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) throw new TypeError('createFragmentsUi 的 host 缺少 ' + key);
    }
    const { $, state, api, call, toast, common, editor, hideHeaderMenus } = host;
    if (typeof common !== 'object') throw new TypeError('createFragmentsUi 的 host.common 必须是对象');
    for (const key of ['chaptersLib', 'formatRelativeTime', 'formatCount']) {
      if (common[key] === undefined || common[key] === null) throw new TypeError('createFragmentsUi 的 host.common 缺少 ' + key);
    }
    if (typeof editor !== 'object') throw new TypeError('createFragmentsUi 的 host.editor 必须是对象');
    for (const key of ['editorEl', 'onEditorInput', 'scrollCaretIntoView']) {
      if (editor[key] === undefined || editor[key] === null) throw new TypeError('createFragmentsUi 的 host.editor 缺少 ' + key);
    }
    const { chaptersLib, formatRelativeTime, formatCount } = common;
    const { editorEl, onEditorInput, scrollCaretIntoView } = editor;

  // 拖拽插入（1.5.0 功能-3）：自定义 MIME 只放碎片名（长碎片不塞进 dataTransfer，避免拖拽数据过大）。
  // 面板是模态的：拖拽期间给 #fragments-backdrop 挂这个 class（透明 + 不拦指针），
  // 落在编辑区的 drop 才收得到；不摘掉拖拽源（display:none 可能让原生拖拽提前结束）。
  const FRAGMENT_DRAG_TYPE = 'application/x-cw-fragment';
  const DRAG_GHOST_CLASS = 'drag-ghost';

  // ---------- 灵感箱（碎片速记；提案 3.4） ----------
  // 碎片是书架根目录 _碎片 里的普通 txt：文件名 / 原子写 / 防覆盖都在主进程 core/fragments.js（有单测）。
  // 这里只做两个弹层：书架「＋ 碎片」记一条；写作页「插入碎片…」把选中的一条插到光标处。
  // 插入只改编辑区、不写盘，原碎片文件永远保留（不提供「用后删除」，删除只走回收站 / _trash 的规矩）。
  function updateFragmentCounter() {
    $('fragment-counter').textContent = `${formatCount(chaptersLib.countChars($('fragment-text').value))} 字`;
  }

  function setFragmentSaveState(text, kind = '') {
    const el = $('fragment-save-state');
    el.textContent = text || '';
    el.classList.toggle('fragment-error', kind === 'error');
  }

  function openFragmentDialog() {
    hideHeaderMenus();
    $('fragment-text').value = '';
    setFragmentSaveState('');
    updateFragmentCounter();
    $('fragment-backdrop').classList.remove('hidden');
    setTimeout(() => {
      const el = $('fragment-text');
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 30);
    return true;
  }

  function closeFragmentDialog() {
    $('fragment-backdrop').classList.add('hidden');
  }

  async function saveFragment() {
    if (state.fragmentBusy) return { ok: false, message: '正在保存…' };
    const text = $('fragment-text').value;
    if (!chaptersLib.countChars(text)) {
      setFragmentSaveState('碎片内容是空的，写点什么再保存吧', 'error');
      $('fragment-text').focus();
      return { ok: false, message: '碎片内容是空的' };
    }
    state.fragmentBusy = true;
    $('btn-fragment-save').disabled = true;
    setFragmentSaveState('正在保存…');
    try {
      const data = await call(api.createFragment, text);
      closeFragmentDialog();
      toast(`碎片已保存：_碎片\\${data.name}（${formatCount(data.chars)} 字）`);
      // 插入面板如果正开着（理论上不会，但别让列表和磁盘对不上）
      if (!$('fragments-backdrop').classList.contains('hidden')) await refreshFragments();
      return { ok: true, name: data.name, path: data.path, chars: data.chars, bytes: data.bytes };
    } catch (err) {
      setFragmentSaveState(`保存失败：${err.message}`, 'error');
      toast(`保存碎片失败：${err.message}`, 'error');
      return { ok: false, message: err.message, code: err.code };
    } finally {
      state.fragmentBusy = false;
      $('btn-fragment-save').disabled = false;
    }
  }

  function fragmentSizeText(size) {
    const bytes = Math.max(0, Number(size) || 0);
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  function fragmentMetaText(fragment) {
    const time = formatRelativeTime(fragment.mtimeMs);
    if (fragment.date) return `${fragment.date} · 第 ${fragment.seq} 条 · ${time}`;
    return `手工放入的 txt · ${time}`;
  }

  function openInsertFragmentDialog() {
    if (!state.bookPath) {
      toast('先打开一本书再插入碎片', 'warn');
      return false;
    }
    hideHeaderMenus();
    // 记下打开面板前的位置：弹层期间点列表/预览不会把光标位置弄丢
    state.insertFragmentRange = {
      start: editorEl.selectionStart || 0,
      end: editorEl.selectionEnd || 0
    };
    state.fragmentSelected = null;
    $('fragment-preview').textContent = '';
    $('fragment-preview-name').textContent = '选一条碎片看内容';
    $('btn-fragment-insert').disabled = true;
    const range = state.insertFragmentRange;
    $('fragment-hint').textContent =
      range.end > range.start
        ? `将替换打开面板前选中的第 ${range.start + 1}–${range.end} 字；只改编辑区、不写盘，原碎片文件保留。`
        : `将插在打开面板前的光标处（第 ${range.start + 1} 字）；只改编辑区、不写盘，原碎片文件保留。`;
    $('fragments-backdrop').classList.remove('hidden');
    refreshFragments();
    return true;
  }

  function closeInsertFragmentDialog() {
    $('fragments-backdrop').classList.add('hidden');
  }

  function highlightSelectedFragment(name) {
    const items = document.querySelectorAll('#fragments-list .fragment-item');
    items.forEach((item) => item.classList.toggle('selected', item.dataset.name === name));
  }

  // ---- 日期分组（拍板 #9）----
  // 碎片文件名固定是 `YYYY-MM-DD-N.txt`（core/fragments.js 生成），日期就是文件名前 10 位；
  // 手工丢进 _碎片 的 txt 没有日期前缀 → 返回空串，统一归到「更早」组。
  // 这里只解析名字、绝不改文件名，也不碰插入 / 保存语义。
  // 「今天 / 昨天」按**本地日历日**差算（不拼日期字符串，因此不必再复刻一份 pad2；
  // Asia/Shanghai 无夏令时，即使有也只在 ±1h 内，四舍五入到天是稳的）。
  function fragmentDayKey(name) {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(name == null ? '' : name));
    return m ? m[1] : '';
  }
  function fragmentDayLabel(key, now = new Date()) {
    if (!key) return '更早';
    const [yy, mm, dd] = key.split('-').map(Number);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thatDay = new Date(yy, mm - 1, dd);
    const diffDays = Math.round((today - thatDay) / 86400000);
    if (diffDays === 0) return '今天';
    if (diffDays === 1) return '昨天';
    return `${mm}月${dd}日`;
  }

  function renderFragments(data) {
    const list = $('fragments-list');
    const summary = $('fragments-summary');
    list.innerHTML = '';
    if (!data.fragments.length) {
      const empty = document.createElement('div');
      empty.className = 'fragment-empty';
      empty.textContent = '还没有碎片。回书架点「＋ 碎片」记一条；直接放进 _碎片 文件夹的 txt 也会出现在这里。';
      list.appendChild(empty);
      summary.textContent = '共 0 条碎片';
      return;
    }
    summary.textContent = `共 ${data.total} 条碎片（最新在前）${
      data.truncated ? `，只列出前 ${data.fragments.length} 条` : ''
    }`;
    // 分组小标题不是 button、也不带 .fragment-item：test-hooks 的 fragmentRowCount /
    // clickFragmentRow 只认 .fragment-item，所以行数与点行选中都不受影响。
    let lastDay = null;
    for (const fragment of data.fragments) {
      const dayKey = fragmentDayKey(fragment.name);
      if (dayKey !== lastDay) {
        const day = document.createElement('div');
        day.className = 'fragment-day';
        day.textContent = fragmentDayLabel(dayKey);
        list.appendChild(day);
        lastDay = dayKey;
      }
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'fragment-item';
      item.dataset.name = fragment.name;
      // 1.5.0 功能-3：行本身可拖进正文（拖拽只带名字，完整内容落点再读）
      item.draggable = true;
      item.title = '点一下选中预览；也可以直接拖进正文，落在哪儿就插到哪儿';
      const name = document.createElement('div');
      name.className = 'fragment-item-name';
      name.textContent = fragment.name;
      name.title = fragment.name;
      item.appendChild(name);
      const meta = document.createElement('div');
      meta.className = 'fragment-item-meta';
      meta.textContent = `${fragmentMetaText(fragment)} · ${fragmentSizeText(fragment.size)}`;
      item.appendChild(meta);
      const preview = document.createElement('div');
      preview.className = 'fragment-item-preview';
      preview.textContent = fragment.preview || '（空文件）';
      item.appendChild(preview);
      item.addEventListener('click', () => {
        selectFragmentByName(fragment.name);
      });
      item.addEventListener('dragstart', (event) => handleFragmentDragStart(event, fragment.name));
      item.addEventListener('dragend', handleFragmentDragEnd);
      list.appendChild(item);
    }
  }

  async function refreshFragments() {
    const summary = $('fragments-summary');
    summary.textContent = '正在读取 _碎片…';
    let data;
    try {
      data = await call(api.listFragments);
    } catch (err) {
      summary.textContent = `读取碎片失败：${err.message}`;
      $('fragments-list').innerHTML = '';
      state.fragments = [];
      state.fragmentSelected = null;
      $('btn-fragment-insert').disabled = true;
      return { ok: false, message: err.message };
    }
    state.fragments = data.fragments;
    renderFragments(data);
    // 打开 / 刷新后默认选中第一条（只读预览，不会自动插进正文）
    if (data.fragments.length) await selectFragmentByName(data.fragments[0].name);
    return { ok: true, total: data.total, truncated: data.truncated, fragments: data.fragments };
  }

  async function selectFragmentByName(name) {
    const fragment = (state.fragments || []).find((item) => item.name === name);
    if (!fragment) return { ok: false, message: '这条碎片已经不在列表里了' };
    state.fragmentSelected = null;
    $('btn-fragment-insert').disabled = true;
    try {
      const data = await call(api.readFragment, name);
      state.fragmentSelected = data;
      $('fragment-preview-name').textContent = `${data.name} · ${formatCount(data.chars)} 字 · ${fragmentSizeText(data.size)}`;
      // 预览只塞前 2 万字进 DOM（几十万字的碎片也不卡界面）；插入时仍然是完整内容。
      const previewLimit = 20000;
      $('fragment-preview').textContent =
        data.text.length > previewLimit
          ? `${data.text.slice(0, previewLimit)}\n…（预览只显示前 ${previewLimit} 字，插入的是完整内容）`
          : data.text;
      $('btn-fragment-insert').disabled = false;
      highlightSelectedFragment(name);
      return { ok: true, name: data.name, chars: data.chars, size: data.size };
    } catch (err) {
      $('fragment-preview-name').textContent = '读取碎片失败';
      $('fragment-preview').textContent = err.message;
      toast(`读取碎片失败：${err.message}`, 'error');
      return { ok: false, message: err.message, code: err.code };
    }
  }

  // 插入核心（对话框与拖拽共用）：focus + setSelectionRange 后用 execCommand('insertText')
  // 走原生输入，保住 Ctrl+Z；execCommand 不可用 / 结果对不上时手动拼接兜底（会丢原生撤销链，但不丢内容）。
  // 只改编辑区（onEditorInput 会标未保存），绝不自动保存、绝不删除原碎片。
  function insertFragmentAt(fragment, start, end) {
    const length = editorEl.value.length;
    const from = Math.max(0, Math.min(Number(start) || 0, length));
    const to = Math.max(from, Math.min(Number(end) || from, length));
    const before = editorEl.value;
    editorEl.focus();
    editorEl.setSelectionRange(from, to);
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, fragment.text);
    } catch {
      inserted = false;
    }
    const expectedLength = before.length - (to - from) + fragment.text.length;
    if (!inserted || editorEl.value.length !== expectedLength) {
      // 极端兜底：execCommand 不可用时手动拼接（会丢原生撤销链，但不会丢内容）
      editorEl.value = before.slice(0, from) + fragment.text + before.slice(to);
      editorEl.setSelectionRange(from + fragment.text.length, from + fragment.text.length);
    }
    onEditorInput();
    scrollCaretIntoView(editorEl.selectionStart || 0);
    return {
      ok: true,
      name: fragment.name,
      chars: fragment.chars,
      start: from,
      end: to,
      dirty: state.dirty,
      textLength: editorEl.value.length
    };
  }

  function insertSelectedFragment() {
    const fragment = state.fragmentSelected;
    if (!fragment) return { ok: false, message: '先选一条碎片' };
    if (!state.bookPath) return { ok: false, message: '先打开一本书' };
    const range = state.insertFragmentRange || { start: editorEl.selectionStart || 0, end: editorEl.selectionEnd || 0 };
    const result = insertFragmentAt(fragment, range.start, range.end);
    closeInsertFragmentDialog();
    toast(`已插入碎片 ${fragment.name}（${formatCount(fragment.chars)} 字）· 仍是未保存，Ctrl+S 写盘`);
    return result;
  }

  // ---- 拖拽插入（1.5.0 功能-3）----
  // 只认「从碎片列表开始的那次拖拽」（拖拽状态里有碎片名 + dataTransfer 带自定义 MIME / text/plain）；
  // 外部文本 / 文件拖进来一律不拦、不插。
  function isOwnFragmentDrag(event) {
    if (!state.fragmentDragName) return false;
    const dt = event && event.dataTransfer;
    if (!dt) return false;
    let types = [];
    try {
      types = Array.from(dt.types || []);
    } catch {
      types = [];
    }
    return types.indexOf(FRAGMENT_DRAG_TYPE) !== -1 || types.indexOf('text/plain') !== -1;
  }

  // 落点：Chromium 里 textarea 只有 caretPositionFromPoint 会回「textarea + 字符下标」
  // （caretRangeFromPoint 对 textarea 会回到 BODY）；两个都取不到就退回当前光标，不猜。
  function caretOffsetFromPointEvent(event) {
    const length = editorEl.value.length;
    const clamp = (value) => Math.max(0, Math.min(Number(value) || 0, length));
    const x = event ? Number(event.clientX) : NaN;
    const y = event ? Number(event.clientY) : NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return clamp(editorEl.selectionStart);
    const offsetOf = (point) => {
      if (!point) return null;
      const node = point.offsetNode || point.startContainer || null;
      const offset = point.offsetNode ? point.offset : point.startOffset;
      if (node === editorEl && Number.isFinite(Number(offset))) return Number(offset);
      return null;
    };
    try {
      if (typeof document.caretPositionFromPoint === 'function') {
        const offset = offsetOf(document.caretPositionFromPoint(x, y));
        if (offset !== null) return clamp(offset);
      }
      if (typeof document.caretRangeFromPoint === 'function') {
        const offset = offsetOf(document.caretRangeFromPoint(x, y));
        if (offset !== null) return clamp(offset);
      }
    } catch {
      /* 落点算不出来就退回当前光标 */
    }
    return clamp(editorEl.selectionStart);
  }

  function handleFragmentDragStart(event, name) {
    const fragment = (state.fragments || []).find((item) => item.name === name);
    if (!fragment) return;
    state.fragmentDragName = fragment.name;
    state.fragmentDragDropped = false;
    const dt = event && event.dataTransfer;
    if (dt) {
      try {
        dt.effectAllowed = 'copy';
        // 只写碎片名：落点按名字现读完整内容，长碎片不塞进 dataTransfer
        dt.setData(FRAGMENT_DRAG_TYPE, fragment.name);
        dt.setData('text/plain', fragment.name);
      } catch {
        /* 个别引擎会拦自定义 MIME：拖拽状态本身仍然可用 */
      }
    }
    $('fragments-backdrop').classList.add(DRAG_GHOST_CLASS);
  }

  function handleFragmentDragEnd() {
    // 落点已在处理时不要收 ghost：等 drop 收尾，免得面板闪一下
    if (state.fragmentDragDropped) return;
    state.fragmentDragName = null;
    $('fragments-backdrop').classList.remove(DRAG_GHOST_CLASS);
  }

  function onEditorDragOver(event) {
    if (!isOwnFragmentDrag(event)) return;
    event.preventDefault(); // 不 preventDefault 就不会触发 drop
    event.stopPropagation();
    try {
      event.dataTransfer.dropEffect = 'copy';
    } catch {
      /* 只影响光标样式 */
    }
  }

  async function onEditorDrop(event) {
    if (!isOwnFragmentDrag(event)) return null;
    event.preventDefault();
    event.stopPropagation();
    const name = state.fragmentDragName;
    const offset = caretOffsetFromPointEvent(event);
    const bookPath = state.bookPath;
    state.fragmentDragDropped = true;
    try {
      if (!bookPath) {
        toast('先打开一本书再插入碎片', 'warn');
        return { ok: false, message: '先打开一本书' };
      }
      const fragment = (state.fragments || []).find((item) => item.name === name);
      if (!fragment) {
        toast('这条碎片已经不在列表里了', 'warn');
        return { ok: false, message: '这条碎片已经不在列表里了' };
      }
      // 完整内容按名字现读：dataTransfer 里只有名字
      const data = await call(api.readFragment, fragment.name);
      if (state.bookPath !== bookPath) {
        // 读的过程中换了书：绝不把内容写进另一本书的编辑区
        toast('已经换了书，插入取消', 'warn');
        return { ok: false, message: '已经换了书，插入取消' };
      }
      const result = insertFragmentAt({ name: data.name, text: data.text, chars: data.chars }, offset, offset);
      closeInsertFragmentDialog();
      toast(`已插入碎片 ${data.name}（${formatCount(data.chars)} 字）· 仍是未保存，Ctrl+S 写盘`);
      return result;
    } catch (err) {
      toast(`插入碎片失败：${err.message}`, 'error');
      return { ok: false, message: err.message, code: err.code };
    } finally {
      state.fragmentDragName = null;
      state.fragmentDragDropped = false;
      $('fragments-backdrop').classList.remove(DRAG_GHOST_CLASS);
    }
  }

  // 事件绑定（与搬前 bindEvents() 里的灵感箱块逐行一致；由渲染层在原位置调用一次）
  function setupFragmentsUi() {
    // 灵感箱：书架「＋ 碎片」记一条；写作页「插入碎片…」把碎片插到光标处（不写盘）
    $('btn-add-fragment').addEventListener('click', openFragmentDialog);
    $('btn-fragment-cancel').addEventListener('click', closeFragmentDialog);
    $('btn-fragment-save').addEventListener('click', () => saveFragment());
    $('fragment-text').addEventListener('input', updateFragmentCounter);
    $('fragment-text').addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        saveFragment();
      }
    });
    $('btn-insert-fragment').addEventListener('click', openInsertFragmentDialog);
    $('btn-fragments-close').addEventListener('click', closeInsertFragmentDialog);
    $('btn-fragment-insert').addEventListener('click', () => insertSelectedFragment());
    $('btn-fragments-refresh').addEventListener('click', () => refreshFragments());
    // 1.5.0 功能-3：碎片拖进正文。dragover 必须 preventDefault 才会收到 drop；
    // drop 只认从碎片列表开始的那次拖拽（外部文本 / 文件一律不拦）。
    editorEl.addEventListener('dragover', onEditorDragOver);
    editorEl.addEventListener('drop', onEditorDrop);
  }


    return {
      updateFragmentCounter,
      openFragmentDialog,
      closeFragmentDialog,
      saveFragment,
      openInsertFragmentDialog,
      closeInsertFragmentDialog,
      insertSelectedFragment,
      selectFragmentByName,
      refreshFragments,
      setupFragmentsUi
    };
  }

  return { create: createFragmentsUi, REQUIRED_HOST };
});
