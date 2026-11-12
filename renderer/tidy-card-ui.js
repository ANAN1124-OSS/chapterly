/* 「整理」按钮的悬浮选择卡 + 「显示」菜单（第 4 步 renderer 九刀·第八刀：从 renderer.js 整段搬出来）。
 *
 * 搬走的段（原 renderer.js 3862–4172，311 行，去掉两个共享胶水函数后 294 行）——「整理 / 显示」两个顶栏下拉：
 *   整理卡（formatCardOpen / refreshFormatCard / showFormatCard / scheduleHideFormatCard / cancelFormatCardTimer）+
 *   显示菜单（displayMenuOpen / showDisplayMenu / hideDisplayMenu / toggleDisplayMenu）+
 *   格式预览与排版对话框（scheduleFormatPreview / renderFormatPreview / updateFormatPreview / openFormatDialog /
 *   closeFormatDialog）+ 整理撤销（pushFormatUndo / formatUndoSteps / canUndoFormat / undoFormat / formatChapterRunning）+
 *   当前章整理与写回编辑区（insertFormattedText / formatCurrentChapterFromConfig / applyFormatToEditor / mapCaretPosition）。
 * **只搬不改行为**：文案 / class / 定时器延迟 / 撤销上限 / 光标映射 / 预览令牌全部一字未改。
 * 事件绑定随域搬进 setupTidyCardUi()（整理 ▾ / 整理卡 / 显示 ▾ / 显示菜单 / 取色器 / 格式对话框 6 组绑定）。
 *
 * 契约：createTidyCardUi(host) 由渲染层调用一次。host 8 个成员（含 3 个语义分组，分组内每个真实依赖都列在这里）：
 *   host = {
 *     $, state, api, call, toast,          // 基础 5：DOM 查询 / 共享状态（formatUndo 等）/ IPC 白名单 / IPC 包装 / 提示
 *     format: {                             // 排版纯逻辑 + 编辑区
 *       formatUi,                           //   renderer/format-ui.js：默认规则 / 合并 / 文案
 *       MAX_FORMAT_UNDO,                    //   撤销步数上限（渲染层常量）
 *       readFormatOptions, writeFormatOptions, // 对话框表单读写（排版域提供，唯一一份）
 *       editorEl,                           //   编辑区（预览 / 插入 / 撤销都只动它，不写盘）
 *       onEditorInput,                      //   插入后触发一次输入处理（保持 dirty / 字数口径）
 *       chaptersLib,                        //   core/chapters.js：mapCaretPosition 的字符口径
 *       caretColorLib                       //   core/caret-color.js：取色器预览的颜色清洗
 *     },
 *     menus: {                              // 顶栏菜单互斥 / 标记菜单
 *       hideBookMenu, hideExportMenu, hideMenu,
 *       renderMarksMenu                     //   显示菜单开关状态文案
 *     },
 *     peers: {                              // 跨域动作
 *       openSettings,                       //   「显示 → 显示设置…」
 *       toggleMarks,                        //   「显示 → 不可见字符 / 超长段落」
 *       setDisplayPreset,                   //   「显示 → 紧凑 / 标准 / 宽松」
 *       applyCaretColor, setCaretParagraphPersisted, setCaretColorPersisted, // 当前段落高亮
 *       runFormatBook,                      //   「一键整理本书…」（一键整理域）
 *       scrollCaretIntoView                 //   整理 / 撤销后把光标滚进视野（共享胶水，本体留在 renderer）
 *     }
 *   }
 * 缺任何一个（含分组内成员）直接抛 TypeError。分组在 create 时一次解构，行为等价。
 * create() 不注册事件、不建定时器、不碰 DOM；事件绑定在 setupTidyCardUi()，由 bindEvents() 在原位置调用一次。
 * 两个模块级 let（formatCardTimer / formatPreviewTimer）随模块走；它们不在测试钩子 scope 键里。
 *
 * 刻意不搬（留在 renderer.js）：hideHeaderMenus / scrollCaretIntoView 两个被 6–10 个域入站的共享胶水函数
 * （避免早期域装配 TDZ）、Esc 动作表、全局 click-outside、测试钩子宿主契约（按名字取本模块入口）。
 *
 * 浏览器里挂成全局 CWTidyCardUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWTidyCardUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HOST = ['$', 'state', 'api', 'call', 'toast', 'format', 'menus', 'peers'];

  function createTidyCardUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createTidyCardUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) throw new TypeError('createTidyCardUi 的 host 缺少 ' + key);
    }
    const { $, state, api, call, toast, format, menus, peers } = host;
    if (typeof format !== 'object') throw new TypeError('createTidyCardUi 的 host.format 必须是对象');
    for (const key of ['formatUi', 'MAX_FORMAT_UNDO', 'readFormatOptions', 'writeFormatOptions', 'editorEl', 'onEditorInput', 'chaptersLib', 'caretColorLib']) {
      if (format[key] === undefined || format[key] === null) throw new TypeError('createTidyCardUi 的 host.format 缺少 ' + key);
    }
    if (typeof menus !== 'object') throw new TypeError('createTidyCardUi 的 host.menus 必须是对象');
    for (const key of ['hideBookMenu', 'hideExportMenu', 'hideMenu', 'renderMarksMenu']) {
      if (menus[key] === undefined || menus[key] === null) throw new TypeError('createTidyCardUi 的 host.menus 缺少 ' + key);
    }
    if (typeof peers !== 'object') throw new TypeError('createTidyCardUi 的 host.peers 必须是对象');
    for (const key of ['openSettings', 'toggleMarks', 'setDisplayPreset', 'applyCaretColor', 'setCaretParagraphPersisted', 'setCaretColorPersisted', 'runFormatBook', 'scrollCaretIntoView']) {
      if (peers[key] === undefined || peers[key] === null) throw new TypeError('createTidyCardUi 的 host.peers 缺少 ' + key);
    }
    const { formatUi, MAX_FORMAT_UNDO, readFormatOptions, writeFormatOptions, editorEl, onEditorInput, chaptersLib, caretColorLib } = format;
    const { hideBookMenu, hideExportMenu, hideMenu, renderMarksMenu } = menus;
    const { openSettings, toggleMarks, setDisplayPreset, applyCaretColor, setCaretParagraphPersisted, setCaretColorPersisted, runFormatBook, scrollCaretIntoView } = peers;

  // ---------- 「整理」按钮的悬浮选择卡 + 「显示」菜单（v0.8.5 R1） ----------
  // 点「整理」= 直接用上次记住的规则整理本章（见 formatCurrentChapterFromConfig）；
  // 鼠标悬浮 / 键盘 Tab 聚焦 = 出这张选择卡（排版设置… / 一键整理本书… / 撤销上次整理）。
  // 卡片只是入口，原来的对话框、整本整理、撤销与光标映射都没变。
  let formatCardTimer = null;

  function formatCardOpen() {
    return !$('format-menu').classList.contains('hidden');
  }

  function displayMenuOpen() {
    return !$('display-menu').classList.contains('hidden');
  }

  // 卡片里「撤销上次整理」那一行的可用状态与文案（几秒钟前刚整理过也能马上反映出来）
  function refreshFormatCard() {
    const item = $('format-undo-item');
    if (!item) return;
    const steps = formatUndoSteps();
    item.disabled = steps === 0;
    item.textContent = formatUi.undoLabel(steps);
  }

  function cancelFormatCardTimer() {
    if (formatCardTimer) {
      clearTimeout(formatCardTimer);
      formatCardTimer = null;
    }
  }

  function showFormatCard() {
    cancelFormatCardTimer();
    hideExportMenu();
    hideDisplayMenu();
    refreshFormatCard();
    $('format-menu').classList.remove('hidden');
  }

  function hideFormatMenu() {
    cancelFormatCardTimer();
    hideMenu('format-menu');
  }

  // 鼠标离开按钮 / 卡片、焦点移走时「短延迟」再收起：留出从按钮挪到卡片、或点卡片按钮的时间
  function scheduleHideFormatCard(delay = 240) {
    cancelFormatCardTimer();
    formatCardTimer = setTimeout(() => {
      formatCardTimer = null;
      $('format-menu').classList.add('hidden');
    }, delay);
  }

  function showDisplayMenu() {
    hideFormatMenu();
    hideExportMenu();
    renderMarksMenu();
    $('display-menu').classList.remove('hidden');
  }

  function hideDisplayMenu() {
    hideMenu('display-menu');
  }

  function toggleDisplayMenu() {
    if (displayMenuOpen()) hideDisplayMenu();
    else showDisplayMenu();
  }

  // 写作页顶栏的几个弹层一起收起（切视图 / 进专注模式 / 关窗 / 按 Esc / 窗口缩放时用）

  let formatPreviewToken = 0;
  let formatPreviewTimer = null;

  function scheduleFormatPreview(delay = 140) {
    const token = formatPreviewToken + 1;
    formatPreviewToken = token;
    if (formatPreviewTimer) clearTimeout(formatPreviewTimer);
    formatPreviewTimer = setTimeout(() => {
      formatPreviewTimer = null;
      updateFormatPreview(token);
    }, delay);
  }

  function renderFormatPreview(res, raw) {
    if (!String(raw == null ? '' : raw).trim()) {
      $('fmt-summary').textContent = formatUi.emptyPanelText();
      $('fmt-preview').textContent = '';
      $('btn-format-apply').disabled = true;
      return;
    }
    $('fmt-summary').textContent = res.changed
      ? formatUi.statsText(res.stats)
      : formatUi.noChangePanelText();
    $('btn-format-apply').disabled = !res.changed;
    const preview = res.text.length > 700 ? `${res.text.slice(0, 700)}\n…` : res.text;
    $('fmt-preview').textContent = preview || '（整理后为空）';
  }

  async function updateFormatPreview(token) {
    try {
      const res = await call(api.formatText, editorEl.value, readFormatOptions());
      if (token !== formatPreviewToken) return; // 已经切到新的预览请求，丢弃旧结果
      renderFormatPreview(res, editorEl.value);
    } catch (err) {
      if (token !== formatPreviewToken) return;
      $('fmt-summary').textContent = `预览失败：${err.message}`;
      $('fmt-preview').textContent = '';
    }
  }

  function openFormatDialog() {
    hideFormatMenu();
    hideDisplayMenu();
    if (!state.bookPath || state.index < 0) {
      toast('先打开一本书的章节再整理', 'warn');
      return;
    }
    writeFormatOptions(state.config && state.config.formatOptions);
    $('fmt-summary').textContent = '正在预览…';
    $('fmt-preview').textContent = '';
    $('btn-format-apply').disabled = true;
    $('format-backdrop').classList.remove('hidden');
    scheduleFormatPreview(0);
  }

  function closeFormatDialog() {
    $('format-backdrop').classList.add('hidden');
    formatPreviewToken += 1; // 让还没回来的预览结果失效
    if (formatPreviewTimer) {
      clearTimeout(formatPreviewTimer);
      formatPreviewTimer = null;
    }
  }

  // 把整理结果写进编辑区：用 execCommand 走原生输入，保住 Ctrl+Z 的原生撤销链；
  // 失败再退回直接赋值。两条路都会触发 input → 标记未保存。
  // hint = { text: 整理前的正文, pos: 整理前光标位置 }，用来把光标映射回原来的位置。
  function insertFormattedText(text, hint) {
    const pos = hint && Number.isFinite(hint.pos) ? hint.pos : 0;
    const caret = hint && typeof hint.text === 'string'
      ? mapCaretPosition(hint.text, text, pos)
      : Math.min(pos, text.length);
    editorEl.focus();
    editorEl.setSelectionRange(0, editorEl.value.length);
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch {
      inserted = false;
    }
    if (!inserted || editorEl.value !== text) {
      editorEl.value = text;
      onEditorInput();
    }
    editorEl.setSelectionRange(caret, caret);
    scrollCaretIntoView(caret);
  }

  // 整理只动空白/标点，正文有效字符的顺序不变：按「第 N 个非空白字符」把光标映射回去，
  // 避免整理/撤销后光标被拉回章首（长章里接着打字会插到全章最前面）。
  function mapCaretPosition(sourceText, targetText, sourcePos) {
    const contentBefore = String(sourceText).slice(0, Math.max(0, sourcePos));
    const wanted = chaptersLib.countChars(contentBefore);
    if (!wanted) return 0;
    let count = 0;
    for (let i = 0; i < targetText.length; i += 1) {
      if (!/\s/.test(targetText[i])) {
        count += 1;
        if (count >= wanted) return i + 1;
      }
    }
    return targetText.length;
  }


  function pushFormatUndo(before, after) {
    const chapter = state.chapters[state.index];
    if (!chapter) return;
    state.formatUndo.push({ bookPath: state.bookPath, chapterId: chapter.id, before, after });
    while (state.formatUndo.length > MAX_FORMAT_UNDO) state.formatUndo.shift();
  }

  // 当前章还能连续撤销几步：从栈顶往下，只有当第 N 步的 after 正好等于第 N-1 步的 before
  // 时才真正连得上（中间如果手动改过字，链条就断了）。
  function formatUndoSteps() {
    const chapter = state.chapters[state.index];
    if (!chapter) return 0;
    let steps = 0;
    let expected = editorEl.value;
    for (let i = state.formatUndo.length - 1; i >= 0; i -= 1) {
      const snap = state.formatUndo[i];
      if (snap.bookPath !== state.bookPath || snap.chapterId !== chapter.id) break;
      if (snap.after !== expected) break;
      steps += 1;
      expected = snap.before;
    }
    return steps;
  }

  function canUndoFormat() {
    return formatUndoSteps() > 0;
  }

  function undoFormat() {
    if (!canUndoFormat()) return false;
    const top = state.formatUndo.pop();
    const caret = editorEl.selectionStart || 0;
    insertFormattedText(top.before, { text: top.after, pos: caret });
    toast('已撤销整理（仍在编辑区，未写盘）');
    return true;
  }

  // 点「整理」= 直接用上次记住的规则（config.formatOptions）整理当前章。
  // 不弹窗、只改编辑区、仍是未保存（Ctrl+S 才写盘），Ctrl+Z 或选择卡里的「撤销上次整理」可退回；
  // 无改动时只提示一句，不往撤销栈里塞东西。
  let formatChapterRunning = false;

  async function formatCurrentChapterFromConfig() {
    if (!state.bookPath || state.index < 0) {
      toast('先打开一本书的章节再整理', 'warn');
      return { ok: false, reason: 'no-book' };
    }
    if (formatChapterRunning) return { ok: false, reason: 'busy' };
    const before = editorEl.value;
    const beforeCaret = editorEl.selectionStart || 0;
    if (!String(before == null ? '' : before).trim()) {
      toast(formatUi.emptyToast(), 'warn');
      return { ok: false, reason: 'empty' };
    }
    const options = formatUi.mergeOptions(state.config && state.config.formatOptions);
    const bookPath = state.bookPath;
    const chapterId = state.chapters[state.index] && state.chapters[state.index].id;
    formatChapterRunning = true;
    try {
      const res = await call(api.formatText, before, options);
      if (!res.changed) {
        // 没有可改的地方：编辑区一个字不动，撤销栈也不动
        toast(formatUi.noChangeToast(options));
        return { ok: true, changed: 0, stats: res.stats };
      }
      // 期间换了书 / 换了章 / 正文被改过：这次结果作废（绝不把 A 章的内容写进 B 章的编辑区）
      const chapter = state.chapters[state.index];
      if (
        state.bookPath !== bookPath ||
        !chapter ||
        chapter.id !== chapterId ||
        editorEl.value !== before
      ) {
        toast('正文刚改过，这次整理没有套用，请再点一次「整理」', 'warn');
        return { ok: false, reason: 'stale' };
      }
      insertFormattedText(res.text, { text: before, pos: beforeCaret });
      pushFormatUndo(before, res.text);
      toast(formatUi.successToast(options, res.stats));
      return { ok: true, changed: 1, stats: res.stats, steps: formatUndoSteps() };
    } catch (err) {
      toast(`整理失败：${err.message}`, 'error');
      return { ok: false, reason: 'error', message: err.message };
    } finally {
      formatChapterRunning = false;
      refreshFormatCard();
    }
  }

  async function applyFormatToEditor() {
    if (!state.bookPath || state.index < 0) return;
    const before = editorEl.value;
    const beforeCaret = editorEl.selectionStart || 0;
    if (!String(before == null ? '' : before).trim()) {
      toast(formatUi.emptyToast(), 'warn');
      return;
    }
    const bookPath = state.bookPath;
    const chapterId = state.chapters[state.index] && state.chapters[state.index].id;
    const options = readFormatOptions();
    $('btn-format-apply').disabled = true;
    try {
      const res = await call(api.formatText, before, options);
      // 和点「整理」同一套三行校验：await 期间换了书 / 换了章 / 章被删 / 正文被改过，这次结果作废
      // （绝不把 A 章的内容写进 B 章的编辑区）
      const chapter = state.chapters[state.index];
      if (
        state.bookPath !== bookPath ||
        !chapter ||
        chapter.id !== chapterId ||
        editorEl.value !== before
      ) {
        toast('正文刚改过，这次整理没有套用，请再点一次「整理」', 'warn');
        return { ok: false, reason: 'stale' };
      }
      // 记住这次勾选的规则，下次打开对话框沿用（只记规则，不碰正文）
      try {
        state.config = await call(api.setConfig, { formatOptions: options });
      } catch { /* 记不住规则不影响整理 */ }
      closeFormatDialog();
      if (!res.changed) {
        // 和点「整理」走同一句（哪套规则 + 没有可改的地方），别在这里写第二种说法
        toast(formatUi.noChangeToast(options));
        return;
      }
      insertFormattedText(res.text, { text: before, pos: beforeCaret });
      pushFormatUndo(before, res.text);
      toast(formatUi.successToast(options, res.stats));
    } catch (err) {
      toast(`整理失败：${err.message}`, 'error');
    } finally {
      $('btn-format-apply').disabled = false;
    }
  }

  // 事件绑定（与搬前 bindEvents() 里的整理 / 显示 / 格式对话框块逐行一致；由渲染层在原位置调用一次）
  function setupTidyCardUi() {
    // 「整理 ▾」：点击 = 直接用记住的规则整理本章；鼠标悬浮 / Tab 聚焦 = 出选择卡
    $('btn-format').addEventListener('click', (event) => {
      event.stopPropagation();
      hideFormatMenu();
      void formatCurrentChapterFromConfig();
    });
    // 选择卡：排版设置… / 一键整理本书… / 撤销上次整理（原来的三个流程，一个都没变）
    $('format-menu').addEventListener('click', async (event) => {
      const btn = event.target.closest('button[data-action]');
      if (!btn) return;
      event.stopPropagation();
      const action = btn.dataset.action;
      if (action === 'settings') {
        openFormatDialog(); // 自带 hideFormatMenu()
        return;
      }
      hideFormatMenu();
      if (action === 'undo') {
        if (!undoFormat()) toast('没有可撤销的整理', 'warn');
        else refreshFormatCard();
      } else if (action === 'apply-book') await runFormatBook();
    });
    // 悬浮：进入按钮或卡片就出卡，离开两者（短延迟）收起；键盘 Tab 进按钮 / 卡片也算
    const formatDropdown = $('format-dropdown');
    formatDropdown.addEventListener('pointerenter', () => showFormatCard());
    formatDropdown.addEventListener('pointerleave', () => scheduleHideFormatCard());
    formatDropdown.addEventListener('focusin', () => showFormatCard());
    formatDropdown.addEventListener('focusout', (event) => {
      if (event.relatedTarget && formatDropdown.contains(event.relatedTarget)) return;
      scheduleHideFormatCard(160);
    });

    // 「显示 ▾」：点一下展开（只改 CSS 的显示项，正文一个字都不动）
    $('btn-display').addEventListener('click', (event) => {
      event.stopPropagation();
      toggleDisplayMenu();
    });
    $('display-menu').addEventListener('click', async (event) => {
      // 高亮色块（v0.8-10b）：不关菜单，方便作者连着试几个颜色；点一下 = 按书保存一色
      const swatch = event.target.closest('[data-caret-color]');
      if (swatch) {
        event.preventDefault();
        event.stopPropagation();
        await setCaretColorPersisted(swatch.dataset.caretColor);
        return;
      }
      const btn = event.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      hideDisplayMenu();
      if (action === 'preset-compact') await setDisplayPreset('compact');
      else if (action === 'preset-normal') await setDisplayPreset('normal');
      else if (action === 'preset-loose') await setDisplayPreset('loose');
      else if (action === 'toggle-invisibles') toggleMarks('invisibles');
      else if (action === 'toggle-long-para') toggleMarks('longParagraphs');
      else if (action === 'toggle-caret-para') await setCaretParagraphPersisted(!state.marks.caretParagraph);
      else if (action === 'display-settings') openSettings();
    });
    // 取色器：拖动时只预览（不写盘），松手（change）才按书保存
    const caretPicker = $('format-caret-color');
    if (caretPicker) {
      caretPicker.addEventListener('input', () => {
        applyCaretColor({ caretParagraphColor: caretColorLib.normalizeColor(caretPicker.value) });
      });
      caretPicker.addEventListener('change', () => {
        void setCaretColorPersisted(caretPicker.value);
      });
    }

    // 整理对话框：勾选/切换规则时实时刷新预览
    for (const id of ['fmt-indent', 'fmt-trailing', 'fmt-punct', 'fmt-quotes', 'fmt-ellipsis', 'fmt-cjkspace']) {
      $(id).addEventListener('change', () => scheduleFormatPreview());
    }
    $('fmt-blank').addEventListener('change', () => scheduleFormatPreview());
    $('btn-format-apply').addEventListener('click', applyFormatToEditor);
    $('btn-format-cancel').addEventListener('click', closeFormatDialog);
    $('btn-format-reset').addEventListener('click', () => {
      writeFormatOptions(null);
      scheduleFormatPreview(0);
    });
  }


    return {
      formatCardOpen,
      displayMenuOpen,
      refreshFormatCard,
      showFormatCard,
      hideFormatMenu,
      scheduleHideFormatCard,
      showDisplayMenu,
      hideDisplayMenu,
      openFormatDialog,
      closeFormatDialog,
      formatUndoSteps,
      canUndoFormat,
      undoFormat,
      formatCurrentChapterFromConfig,
      applyFormatToEditor,
      setupTidyCardUi
    };
  }

  return { create: createTidyCardUi, REQUIRED_HOST };
});
