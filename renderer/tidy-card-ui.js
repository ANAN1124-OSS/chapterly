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
 * 契约：createTidyCardUi(host) 由渲染层调用一次。host 9 个成员（含 3 个语义分组，分组内每个真实依赖都列在这里）：
 *   host = {
 *     $, state, api, call, toast,          // 基础 5：DOM 查询 / 共享状态（formatUndo 等）/ IPC 白名单 / IPC 包装 / 提示
 *     recordFallbackWrite,                 // 审计修复 #39（V402）：execCommand 兜底整串赋值后由渲染层记账 + 提示
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
 *       scrollCaretIntoView,                //   整理 / 撤销后把光标滚进视野（共享胶水，本体留在 renderer）
 *       effectiveConfig                     //   生效配置 = 全局 + 当前书覆盖（1.8.0 WP-12 / V201：setConfig 回包是纯全局，不能直接赋给 state.config）
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
    module.exports = factory(require('../core/assert-host').assertHost);
  } else if (root) {
    root.CWTidyCardUi = factory(root.CWAssertHost && root.CWAssertHost.assertHost);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (assertHost) {
  'use strict';

  const REQUIRED_HOST = ['$', 'state', 'api', 'call', 'toast', 'recordFallbackWrite', 'format', 'menus', 'peers'];

  function createTidyCardUi(host) {
    // A8（WP-32）：REQUIRED_HOST 逐成员校验走共享实现（文案不变）。
    assertHost('createTidyCardUi', host, REQUIRED_HOST);
    const { $, state, api, call, toast, recordFallbackWrite, format, menus, peers } = host;
    // 审计修复 #39（V402）：兜底整串赋值要由渲染层统一记快照 + 提示（模块自己没有编辑器级拦截器）
    if (typeof recordFallbackWrite !== 'function') {
      throw new TypeError('createTidyCardUi 的 host.recordFallbackWrite 必须是函数');
    }
    if (typeof format !== 'object') throw new TypeError('createTidyCardUi 的 host.format 必须是对象');
    for (const key of ['formatUi', 'MAX_FORMAT_UNDO', 'readFormatOptions', 'writeFormatOptions', 'editorEl', 'onEditorInput', 'chaptersLib', 'caretColorLib']) {
      if (format[key] === undefined || format[key] === null) throw new TypeError('createTidyCardUi 的 host.format 缺少 ' + key);
    }
    if (typeof menus !== 'object') throw new TypeError('createTidyCardUi 的 host.menus 必须是对象');
    for (const key of ['hideBookMenu', 'hideExportMenu', 'hideMenu', 'renderMarksMenu']) {
      if (menus[key] === undefined || menus[key] === null) throw new TypeError('createTidyCardUi 的 host.menus 缺少 ' + key);
    }
    if (typeof peers !== 'object') throw new TypeError('createTidyCardUi 的 host.peers 必须是对象');
    for (const key of ['openSettings', 'toggleMarks', 'setDisplayPreset', 'applyCaretColor', 'setCaretParagraphPersisted', 'setCaretColorPersisted', 'runFormatBook', 'scrollCaretIntoView', 'effectiveConfig']) {
      if (peers[key] === undefined || peers[key] === null) throw new TypeError('createTidyCardUi 的 host.peers 缺少 ' + key);
    }
    const { formatUi, MAX_FORMAT_UNDO, readFormatOptions, writeFormatOptions, editorEl, onEditorInput, chaptersLib, caretColorLib } = format;
    const { hideExportMenu, hideMenu, renderMarksMenu } = menus;
    const { openSettings, toggleMarks, setDisplayPreset, applyCaretColor, setCaretParagraphPersisted, setCaretColorPersisted, runFormatBook, scrollCaretIntoView, effectiveConfig } = peers;

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
  // 五-H7（TC-01）：排版对话框「套用」的代数令牌。closeFormatDialog（Esc / 取消 / 关闭）推进它，
  // 在途 apply 在后面的 await 落地时发现自己已过期，就丢弃结果——作者点了套用又马上反悔时，
  // 旧整理稿绝不能在 setConfig 写盘落地后再整串盖进编辑区（尤其已按 Esc 后开始打字 / 切章）。
  let formatApplyToken = 0;

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
    // 审计修复 #43（E17）：发起时把正文快照下来。回执只按这份正文结算 —— 以前只拿「回来那一刻」
    // 的编辑区判空，预览在飞期间正文被改（原生 Ctrl+Z / 兜底写入都会绕过对话框的 change 事件）时，
    // 旧正文的结果会贴在新正文上（「无改动」按钮却按新正文可套用，或反过来）。
    const requestedText = editorEl.value;
    try {
      const res = await call(api.formatText, requestedText, readFormatOptions());
      if (token !== formatPreviewToken) return; // 已经切到新的预览请求，丢弃旧结果
      if (editorEl.value !== requestedText) {
        // 正文已经不是这份结果算的那份了：按同一份规则重排一次预览（新号，旧号自然作废），
        // 不拿旧结果给新正文贴结论。
        scheduleFormatPreview(0);
        return;
      }
      renderFormatPreview(res, requestedText);
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
    // 五-H7（TC-01）：关框 = 取消在途「套用」；Esc 之后锁键层解除，作者打字 / 切章都合法，
    // 旧 apply 必须在下次 await 落地时作废，不能再写回编辑区。
    formatApplyToken += 1;
    if (formatPreviewTimer) {
      clearTimeout(formatPreviewTimer);
      formatPreviewTimer = null;
    }
  }

  // 把整理结果写进编辑区：用 execCommand 走原生输入，保住 Ctrl+Z 的原生撤销链；
  // 失败再退回直接赋值。两条路都会触发 input → 标记未保存。
  // hint = { text: 整理前的正文, pos: 整理前光标位置 }，用来把光标映射回原来的位置。
  function insertFormattedText(text, hint, options) {
    const opts = options && typeof options === 'object' ? options : {};
    // 五-H7（TC-01）：整串替换前的最后一道身份闸。hint 是调用方「这次替换所依据的编辑区快照」：
    //   · apply / 一键整理 = 整理前的 (bookPath, chapterId, 正文)；
    //   · 撤销整理 = 撤销后应回的 (bookPath, chapterId, 正文)。
    // await / 弹层窗口里现场已经变了（换书 / 切章 / 作者打字 / Esc 后重开再套用）就拒绝写入，
    // 由调用方按 stale 处理——绝不把 A 章整理稿盖进 B 章编辑区，也不盖掉作者刚敲的字。
    if (hint && typeof hint === 'object') {
      const chapter = state.chapters[state.index];
      if (
        (hint.bookPath !== undefined && hint.bookPath !== state.bookPath) ||
        (hint.chapterId !== undefined && (!chapter || chapter.id !== hint.chapterId)) ||
        (typeof hint.text === 'string' && editorEl.value !== hint.text)
      ) {
        return false;
      }
    }
    // 审计修复 #39（V402）：兜底整串赋值前的正文（撤销基准；不能只信 hint.text，调用方可能不传）
    const beforeText = editorEl.value;
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
    let fallbackUsed = false;
    if (!inserted || editorEl.value !== text) {
      editorEl.value = text;
      onEditorInput();
      fallbackUsed = true;
    }
    editorEl.setSelectionRange(caret, caret);
    scrollCaretIntoView(caret);
    if (fallbackUsed && opts.recordFallback !== false) {
      // 审计修复 #39（V402）：兜底整串赋值清空浏览器撤销栈 —— 由渲染层记一次性快照 + 提示
      // （放在 onEditorInput 之后：输入处理会作废旧快照）。撤销整理自己回退时传 recordFallback:false，
      // 免得把「撤销」这一步又包装成一次可撤销写入。
      recordFallbackWrite({ before: beforeText, after: text, start: caret, label: '整理本章' });
    }
    return true;
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
    const top = state.formatUndo[state.formatUndo.length - 1];
    const caret = editorEl.selectionStart || 0;
    // 五-H7（TC-01）：写回前再核一次书 / 章 / 正文快照（insertFormattedText 的身份闸）；
    // 通过后才弹出快照——被拒绝时这一步仍可重试，不会白丢撤销退路。
    if (
      !insertFormattedText(
        top.before,
        { bookPath: top.bookPath, chapterId: top.chapterId, text: top.after, pos: caret },
        { recordFallback: false }
      )
    ) {
      toast('正文刚改过，这次撤销没有套用', 'warn');
      return false;
    }
    state.formatUndo.pop();
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
      if (!insertFormattedText(res.text, { bookPath, chapterId, text: before, pos: beforeCaret })) {
        toast('正文刚改过，这次整理没有套用，请再点一次「整理」', 'warn');
        return { ok: false, reason: 'stale' };
      }
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
    // 五-H7（TC-01）：这次 apply 的代数。closeFormatDialog（Esc / 取消 / 关闭）会推进它——
    // 作者「点了套用又马上反悔」时，下面的 setConfig 落地后会发现代数已过期，旧结果一律丢弃。
    const applyToken = ++formatApplyToken;
    $('btn-format-apply').disabled = true;
    try {
      const res = await call(api.formatText, before, options);
      // 和点「整理」同一套三行校验：await 期间换了书 / 换了章 / 章被删 / 正文被改过，这次结果作废
      // （绝不把 A 章的内容写进 B 章的编辑区）
      const chapter = state.chapters[state.index];
      if (
        applyToken !== formatApplyToken ||
        state.bookPath !== bookPath ||
        !chapter ||
        chapter.id !== chapterId ||
        editorEl.value !== before
      ) {
        toast('正文刚改过，这次整理没有套用，请再点一次「整理」', 'warn');
        return { ok: false, reason: 'stale' };
      }
      // 记住这次勾选的规则，下次打开对话框沿用（只记规则，不碰正文）
      // 1.8.0 WP-12（审计 V201）：setConfig 的回包是**纯全局配置**，不能直接赋给 state.config——
      // 后者是「全局 + 本书覆盖」的生效值。直接赋值会让本书的显示覆盖只在内存里消失，
      // 随后打开按书设置（回填读 state.config）再保存，就把全局值写成本书覆盖（静默覆盖写盘）。
      // 按全仓标准写法两行：先更新全局，再用 effectiveConfig() 重算生效值。
      try {
        const cfg = await call(api.setConfig, { formatOptions: options });
        state.globalConfig = cfg;
        state.config = effectiveConfig();
      } catch { /* 记不住规则不影响整理 */ }
      // 五-H7（TC-01）：setConfig 是**第二个 await**。落地后必须重跑同一份三行复核 + 核对这次 apply
      // 仍是当前代数——期间按 Esc（closeFormatDialog 推进代数）后作者打字 / 切章 / 重开再套用都合法，
      // 旧整理稿绝不能在此时整串盖进编辑区（旧实现只核第一个 await，切章时会把旧章整理稿写进新章）。
      const chapterAfter = state.chapters[state.index];
      if (
        applyToken !== formatApplyToken ||
        state.bookPath !== bookPath ||
        !chapterAfter ||
        chapterAfter.id !== chapterId ||
        editorEl.value !== before
      ) {
        toast('正文刚改过，这次整理没有套用，请再点一次「整理」', 'warn');
        return { ok: false, reason: 'stale' };
      }
      closeFormatDialog();
      if (!res.changed) {
        // 和点「整理」走同一句（哪套规则 + 没有可改的地方），别在这里写第二种说法
        toast(formatUi.noChangeToast(options));
        return { ok: true, changed: 0, stats: res.stats };
      }
      if (!insertFormattedText(res.text, { bookPath, chapterId, text: before, pos: beforeCaret })) {
        toast('正文刚改过，这次整理没有套用，请再点一次「整理」', 'warn');
        return { ok: false, reason: 'stale' };
      }
      pushFormatUndo(before, res.text);
      toast(formatUi.successToast(options, res.stats));
      return { ok: true, changed: 1, stats: res.stats, steps: formatUndoSteps() };
    } catch (err) {
      toast(`整理失败：${err.message}`, 'error');
      return { ok: false, reason: 'error', message: err.message };
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
