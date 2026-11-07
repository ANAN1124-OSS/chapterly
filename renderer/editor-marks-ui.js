/* 编辑器小件（第 4 步 renderer 九刀·第三刀：从 renderer.js 的「编辑器小件」分区整段搬出来）。
 *
 * 搬走的段（原 renderer.js 1519–1951，433 行）—— 全部只读、可开关的写作页辅助显示（提案 4.1）：
 *   选中字数 / 超长段落左侧黄线 / 不可见字符标记层 / 当前段落高亮 / Alt+↑↓ 段落导航 / 章节列表字数对比，
 *   以及「排版 ▾」里的三个开关菜单与高亮色板（renderMarksMenu / renderCaretColorRow）。
 *   标记层（#editor-marks）与左侧黄线（#editor-marks-gutter）只画在影子层上，字体 / 行高 / 字距 / 宽高
 *   都从编辑区实测值同步；三个开关全关时整层隐藏。
 * **只搬不改行为**：marksPlan 切分、超长（>30 万字）整层收起只提示一次、光标跨到干净行时整层重建、
 *   IME 拼字中不重画、色板 data-active / aria-pressed / --swatch、菜单文案（✓ / 标题 tooltip）全部一字未改；
 *   setupEditorMarks 里 6 处监听（含 scroll passive / composition / 3 个 type 循环 / document selectionchange /
 *   ResizeObserver / 状态栏超长提示按钮）原样搬进模块。
 *
 * 契约：createEditorMarksUi(host) 由渲染层调用一次。host 9 个成员（含 4 个语义分组，分组内每个真实依赖都列在这里）：
 *   host = {
 *     $, state, toast,                     // 基础 3：DOM 查询 / 共享状态（state.marks、state.focus、state.find）/ 超长提示
 *     persistMarks,                        // 「不可见字符 / 超长段落」开关写盘回调：本模块只交补丁，不碰 config 细节
 *     editor: {                            // 编辑器本体与纯逻辑
 *       editorEl,                          //   编辑区 textarea（正文 / 光标 / 滚动位置都从它读）
 *       editorLogic,                       //   renderer/editor-logic.js：marksPlan / 段落导航 / 超长段落 / 选中字数
 *       getLongParagraphThreshold,         //   「超长段落」生效阈值（1.1.0：全局默认 + 按书覆盖，每次现取）
 *       caretColorLib,                     //   core/caret-color.js：当前段落高亮颜色的清洗 / 色板预设
 *       caretColorValue                    //   「当前生效的高亮颜色」唯一口径（跟随主题时为空串）
 *     },
 *     find: { renderFindHighlights, syncFindOverlayScroll },   // 查找高亮层：和标记层共用对齐 / 重画时机
 *     focus: { focusActive, scheduleTypewriterAlign },         // 专注模式：光标行放回 1/3 处（打字机）
 *     stats: { renderSelectionStats },                          // 状态栏「选中字数」（本域提供触发器）
 *     scroll: { scrollCaretIntoView }                           // 段落跳转后把光标滚进视野
 *   }
 * 缺任何一个（含分组内成员）直接抛 TypeError。分组在 create 时一次解构，行为等价。
 * create() 不注册事件、不建定时器、不碰 DOM；事件绑定在 setupEditorMarks()，由 bindEvents() 在原位置调用一次
 * （ResizeObserver 若运行环境没有就跳过，与搬前一致）。模块自己不读写配置、不改正文：只有 toggleMarks 把
 * 「不可见字符 / 超长段落」的开关补丁交给 host.persistMarks（渲染层按当前书写 config.json 的 bookDisplay）。
 *
 * 刻意不搬（留在 renderer.js）：状态栏的 renderSelectionStats 实现（statusbar-ui.js）、查找会话实现、
 * 专注模式实现、Esc 动作表 / 测试钩子宿主契约（都按名字取本模块入口）。
 *
 * 浏览器里挂成全局 CWEditorMarksUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWEditorMarksUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HOST = ['$', 'state', 'toast', 'persistMarks', 'editor', 'find', 'focus', 'stats', 'scroll'];

  function createEditorMarksUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createEditorMarksUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) throw new TypeError('createEditorMarksUi 的 host 缺少 ' + key);
    }
    // 两个编辑器小件开关按书记忆（1.1.0）：写盘回调必须是函数，否则 create 时就报错，别等到点开关才发现。
    if (typeof host.persistMarks !== 'function') {
      throw new TypeError('createEditorMarksUi 的 host.persistMarks 必须是函数');
    }
    const { $, state, toast, persistMarks, editor, find, focus, stats, scroll } = host;
    if (typeof editor !== 'object') throw new TypeError('createEditorMarksUi 的 host.editor 必须是对象');
    for (const key of ['editorEl', 'editorLogic', 'getLongParagraphThreshold', 'caretColorLib', 'caretColorValue']) {
      if (editor[key] === undefined || editor[key] === null) throw new TypeError('createEditorMarksUi 的 host.editor 缺少 ' + key);
    }
    // 生效阈值必须每次现取（设置里改完 / 打开别的书要不重载模块就换值），所以契约是函数，不是常量。
    if (typeof editor.getLongParagraphThreshold !== 'function') {
      throw new TypeError('createEditorMarksUi 的 host.editor.getLongParagraphThreshold 必须是函数');
    }
    if (typeof find !== 'object') throw new TypeError('createEditorMarksUi 的 host.find 必须是对象');
    for (const key of ['renderFindHighlights', 'syncFindOverlayScroll']) {
      if (find[key] === undefined || find[key] === null) throw new TypeError('createEditorMarksUi 的 host.find 缺少 ' + key);
    }
    if (typeof focus !== 'object') throw new TypeError('createEditorMarksUi 的 host.focus 必须是对象');
    for (const key of ['focusActive', 'scheduleTypewriterAlign']) {
      if (focus[key] === undefined || focus[key] === null) throw new TypeError('createEditorMarksUi 的 host.focus 缺少 ' + key);
    }
    if (typeof stats !== 'object' || stats.renderSelectionStats === undefined || stats.renderSelectionStats === null) {
      throw new TypeError('createEditorMarksUi 的 host.stats 缺少 renderSelectionStats');
    }
    // 千分位（拍板 #1）：超长段落气泡里的「第 N 行 · M 字」用共享实现的 formatCount
    if (stats.formatCount === undefined || stats.formatCount === null) {
      throw new TypeError('createEditorMarksUi 的 host.stats 缺少 formatCount');
    }
    if (typeof scroll !== 'object' || scroll.scrollCaretIntoView === undefined || scroll.scrollCaretIntoView === null) {
      throw new TypeError('createEditorMarksUi 的 host.scroll 缺少 scrollCaretIntoView');
    }
    const { editorEl, editorLogic, getLongParagraphThreshold, caretColorLib, caretColorValue } = editor;
    const { renderFindHighlights, syncFindOverlayScroll } = find;
    const { focusActive, scheduleTypewriterAlign } = focus;
    const { renderSelectionStats, formatCount } = stats;
    const { scrollCaretIntoView } = scroll;

  // ---------- 编辑器小件（提案 4.1）----------
  // 全部只读、可开关：选中字数 / 超长段落提示 / 不可见字符 / Alt+↑↓ 段落导航 / 章节列表字数对比。
  // 「超长段落」和「不可见字符」画在一层绝对定位的影子层（#editor-marks）上：字体、行高、字距、宽高都从
  // 编辑区实测值同步，文字本身透明，只画底色和 ␣ / · 标记 —— 正文一个字节都不动，也不写盘。
  // 三个开关都关时这一层一直是 hidden，没有任何额外开销。
  function marksEnabled() {
    return Boolean(state.marks.invisibles || state.marks.longParagraphs || state.marks.caretParagraph);
  }

  // 超长段落阈值（1.1.0）：每次渲染 / 读菜单时向宿主现取生效值（本书覆盖 ?? 全局默认），
  // 再走 editor-logic 同一份夹紧（50–20000，坏值 500）。这样设置保存 / 打开别的书之后，
  // 菜单文案、状态栏标签、气泡提示与黄线判定不会各拿各的旧常量。
  function longParagraphThreshold() {
    return editorLogic.sanitizeThreshold(getLongParagraphThreshold());
  }

  // 当前段落高亮（v0.8-10，提案 N10）：只算「光标落在哪一段」给显示层用。
  // 正文超过 30 万字时 renderEditorMarks 入口已经把整层收起（F9），这里只是第二道防线，
  // 不单独提示（提示统一由入口门控弹一次）。
  function currentCaretParagraph() {
    if (!state.marks.caretParagraph) return null;
    if (editorEl.value.length > editorLogic.MAX_MARK_CHARS) {
      state.marks.caretTooLarge = true;
      return null;
    }
    state.marks.caretTooLarge = false;
    return editorLogic.caretParagraph(editorEl.value, editorEl.selectionStart || 0);
  }

  function scheduleMarksRender(delay = 80) {
    if (state.marks.timer) clearTimeout(state.marks.timer);
    state.marks.timer = setTimeout(() => {
      state.marks.timer = null;
      renderEditorMarks();
      // 查找高亮层和标记层共用同一套对齐 / 重画时机（字体、页宽、窗口大小变了也跟着对齐）
      if (state.find.total) renderFindHighlights();
    }, Math.max(0, Number(delay) || 0));
  }

  function hideEditorMarks() {
    const overlay = $('editor-marks');
    const gutter = $('editor-marks-gutter');
    if (gutter) {
      gutter.classList.add('hidden');
      gutter.textContent = '';
    }
    if (!overlay) return;
    overlay.classList.add('hidden');
    overlay.textContent = '';
    state.marks.longItems = [];
    state.marks.longCount = 0;
    state.marks.markCounts = { fullwidth: 0, trailing: 0 };
    state.marks.caretLine = 0;
    renderLongParaChip();
  }

  // 把影子层改成和编辑区正文框完全一样的位置、大小、字体度量；返回实测值（测试钩子也用）。
  // 标记层（#editor-marks）和查找高亮层（#editor-find-marks）共用这一份对齐逻辑。
  function syncEditorOverlay(overlay) {
    if (!overlay || overlay.classList.contains('hidden')) return null;
    const styles = getComputedStyle(editorEl);
    const px = (value) => {
      const n = parseFloat(value);
      return Number.isFinite(n) ? n : 0;
    };
    const padding = {
      top: px(styles.paddingTop),
      bottom: px(styles.paddingBottom),
      left: px(styles.paddingLeft),
      right: px(styles.paddingRight)
    };
    const width = Math.max(0, editorEl.clientWidth - padding.left - padding.right);
    const height = Math.max(0, editorEl.clientHeight - padding.top - padding.bottom);
    overlay.style.left = `${editorEl.offsetLeft + padding.left}px`;
    overlay.style.top = `${editorEl.offsetTop + padding.top}px`;
    overlay.style.width = `${width}px`;
    overlay.style.height = `${height}px`;
    // 正文显示设置（字体 / 字号 / 行距 / 字距 / 页宽 / 边距）随时会变：每次都用实测值，别写死
    overlay.style.fontFamily = styles.fontFamily;
    overlay.style.fontSize = styles.fontSize;
    overlay.style.fontWeight = styles.fontWeight;
    overlay.style.fontStyle = styles.fontStyle;
    overlay.style.lineHeight = styles.lineHeight;
    overlay.style.letterSpacing = styles.letterSpacing;
    overlay.scrollTop = editorEl.scrollTop;
    overlay.scrollLeft = editorEl.scrollLeft;
    return { width, height, padding };
  }

  function syncMarksLayout() {
    return syncEditorOverlay($('editor-marks'));
  }

  function syncMarksScroll() {
    const overlay = $('editor-marks');
    if (!overlay || overlay.classList.contains('hidden')) return;
    overlay.scrollTop = editorEl.scrollTop;
    overlay.scrollLeft = editorEl.scrollLeft;
    syncLongParaBars();
  }

  // 超长段落的左侧黄线：画在正文左边距里（不压字），逐行按 .long-para 的实测行框定位；
  // 滚动时只改 top（行位置本身不变），所以不用每帧重新量。
  function renderLongParagraphBars() {
    const gutter = $('editor-marks-gutter');
    const overlay = $('editor-marks');
    if (!gutter) return;
    gutter.textContent = '';
    gutter.classList.add('hidden');
    if (!overlay || overlay.classList.contains('hidden') || !state.marks.longParagraphs) return;
    const nodes = overlay.querySelectorAll('.long-para');
    if (!nodes.length) return;
    const styles = getComputedStyle(editorEl);
    const px = (value) => {
      const n = parseFloat(value);
      return Number.isFinite(n) ? n : 0;
    };
    const padLeft = px(styles.paddingLeft);
    const mainRect = gutter.parentElement.getBoundingClientRect();
    const editorRect = editorEl.getBoundingClientRect();
    // 默认放在正文左边 9px（正文左右边距 56px 时很宽裕）；边距很小时贴着正文左缘，不跑到窗口外
    const barLeft = Math.max(
      editorRect.left - mainRect.left + 2,
      editorRect.left - mainRect.left + padLeft - 9
    );
    const baseScrollTop = editorEl.scrollTop || 0;
    for (const node of nodes) {
      const rects = node.getClientRects();
      for (const rect of rects) {
        if (rect.width < 1 || rect.height < 1) continue;
        const bar = document.createElement('div');
        bar.className = 'long-para-bar';
        bar.style.left = `${Math.round(barLeft * 100) / 100}px`;
        bar.style.top = `${Math.round((rect.top - mainRect.top) * 100) / 100}px`;
        bar.style.height = `${Math.round(rect.height * 100) / 100}px`;
        bar.dataset.baseTop = String(rect.top - mainRect.top);
        gutter.appendChild(bar);
      }
    }
    state.marks.barBaseScrollTop = baseScrollTop;
    gutter.classList.remove('hidden');
    syncLongParaBars();
  }

  function syncLongParaBars() {
    const gutter = $('editor-marks-gutter');
    if (!gutter || gutter.classList.contains('hidden')) return;
    const delta = (editorEl.scrollTop || 0) - (state.marks.barBaseScrollTop || 0);
    for (const bar of gutter.children) {
      const base = Number(bar.dataset.baseTop);
      if (!Number.isFinite(base)) continue;
      bar.style.top = `${Math.round((base - delta) * 100) / 100}px`;
    }
  }

  // 标记层超长提示只弹一次（代码审计 F9）：超长期间每次按键都会重新渲染，不能每次都 toast。
  // 回到 30 万字以内后重新武装，下次再超长还会提示一次。
  function warnMarksTooLargeOnce() {
    if (state.marks.tooLargeWarned) return;
    state.marks.tooLargeWarned = true;
    toast(
      '正文超过 30 万字，暂时不画标记层（不可见字符 / 超长段落 / 当前段落高亮）；正文和保存不受影响',
      'warn'
    );
  }

  function renderEditorMarks() {
    const overlay = $('editor-marks');
    if (!overlay) return;
    if (state.view !== 'editor' || !state.bookPath || state.index < 0 || !marksEnabled()) {
      hideEditorMarks();
      return;
    }
    const text = editorEl.value;
    // 代码审计 F9：整层是「整章正文的 DOM 镜像」——超长时只清标记项挡不住镜像本身的构建，
    // 所以入口直接整层收起、只提示一次；正文与保存完全不受影响。
    if (editorLogic.marksTooLarge(text)) {
      hideEditorMarks();
      state.marks.marksTooLarge = true;
      state.marks.caretTooLarge = true;
      warnMarksTooLargeOnce();
      return;
    }
    state.marks.tooLargeWarned = false;
    const longResult = state.marks.longParagraphs
      ? editorLogic.longParagraphs(text, longParagraphThreshold())
      : { items: [], count: 0, truncated: false, tooLarge: false };
    const invisibleResult = state.marks.invisibles
      ? editorLogic.invisibleMarks(text)
      : { items: [], counts: { fullwidth: 0, trailing: 0 }, truncated: false, tooLarge: false };
    state.marks.longItems = longResult.items;
    state.marks.longCount = longResult.count;
    state.marks.longTruncated = longResult.truncated;
    state.marks.markCounts = invisibleResult.counts;
    state.marks.markTruncated = invisibleResult.truncated;
    state.marks.marksTooLarge = Boolean(invisibleResult.tooLarge);
    // 当前段落高亮：整段（一个非空行，含折行）画淡色底 + 左侧细线；空行 / 超长正文不高亮。
    const caret = currentCaretParagraph();
    state.marks.caretLine = caret && !caret.blank ? caret.line : 0;

    overlay.classList.remove('hidden');
    syncMarksLayout();
    overlay.textContent = '';
    const longLines = new Set(longResult.items.map((item) => item.line));
    const marks = invisibleResult.items;
    const fragment = document.createDocumentFragment();
    // v0.9 A-3：不再「一行一个 span」。逐行 span 只是 .long-para / .caret-para 的锚点，
    // 干净行合并成一个文本节点后，10 万字整层重建从 35.1ms 降到 ~7ms（1500 个行内盒太贵）。
    // 切法由纯逻辑 editorLogic.marksPlan() 决定（单测覆盖），这里只按计划建节点。
    for (const segment of editorLogic.marksPlan(text, {
      longLines,
      caretLine: state.marks.caretLine,
      marks
    })) {
      if (segment.kind === 'text') {
        fragment.appendChild(document.createTextNode(segment.text));
        continue;
      }
      const lineEl = document.createElement('span');
      lineEl.className = 'marks-line';
      lineEl.dataset.line = String(segment.line);
      if (segment.long) lineEl.classList.add('long-para');
      if (segment.caret) lineEl.classList.add('caret-para');
      let cursor = 0;
      for (const mark of segment.marks) {
        if (mark.start > cursor) {
          lineEl.appendChild(document.createTextNode(segment.text.slice(cursor, mark.start)));
          cursor = mark.start;
        }
        const markEl = document.createElement('span');
        const rawMark = segment.text.slice(mark.start, mark.end);
        if (mark.type === 'trailing') {
          markEl.className = 'mark-trail';
          markEl.appendChild(document.createTextNode(rawMark));
          const dot = document.createElement('i');
          dot.textContent = '·';
          markEl.appendChild(dot);
        } else {
          markEl.className = 'mark-fw';
          markEl.appendChild(document.createTextNode(rawMark));
          const glyph = document.createElement('i');
          glyph.textContent = '␣';
          markEl.appendChild(glyph);
        }
        lineEl.appendChild(markEl);
        cursor = mark.end;
      }
      if (cursor < segment.text.length) {
        lineEl.appendChild(document.createTextNode(segment.text.slice(cursor)));
      }
      fragment.appendChild(lineEl);
    }
    overlay.appendChild(fragment);
    syncMarksScroll();
    renderLongParagraphBars();
    renderLongParaChip();
  }

  // 光标移动时尽量只改 class（不重画整层）：把上一段的高亮摘掉、给新段落加上。
  // 空行（只有空白）不高亮；正文超过 30 万字时 renderEditorMarks 入口已把整层收起（带 hidden），
  // 这里判断 overlay 隐藏就直接跳过——不是在「已经建好的空层」上补高亮。
  function updateCaretParagraph() {
    const overlay = $('editor-marks');
    if (!overlay || overlay.classList.contains('hidden') || !state.marks.caretParagraph) return;
    if (state.view !== 'editor' || !state.bookPath || state.index < 0) return;
    // 输入法拼字中不重画也不动高亮（中间态会闪）：compositionend 会再整层重画一次。
    if (state.marks.composing) return;
    const caret = currentCaretParagraph();
    const line = caret && !caret.blank ? caret.line : 0;
    if (line === state.marks.caretLine) return;
    const previous = overlay.querySelector('.caret-para');
    if (previous) previous.classList.remove('caret-para');
    state.marks.caretLine = line;
    if (!line) return;
    const next = overlay.querySelector(`.marks-line[data-line="${line}"]`);
    if (next) {
      next.classList.add('caret-para');
      return;
    }
    // v0.9 A-3：干净行现在合并成文本节点（不再一行一个 span），光标移到这种行时没有现成的
    // span 可以挂 class —— 整层重建一次（重建后这一行就是 span）。10 万字实测约 8.7ms，
    // 只在光标跨到「本次没被标记的行」时发生；同一行内继续打字仍然是 O(1) 改 class。
    renderEditorMarks();
  }

  function longParagraphsTitle() {
    const items = state.marks.longItems || [];
    const count = state.marks.longCount || 0;
    const lines = [`超过 ${longParagraphThreshold()} 字的段落：`];
    for (const item of items.slice(0, 6)) lines.push(`第 ${item.line} 行 · ${formatCount(item.chars)} 字`);
    if (count > Math.min(items.length, 6)) {
      lines.push(`…还有 ${count - Math.min(items.length, 6)} 段`);
    }
    lines.push('单击跳到下一段（只移动光标，不改字）');
    return lines.join('\n');
  }

  function renderLongParaChip() {
    const chip = $('status-long-para');
    if (!chip) return;
    const show =
      state.marks.longParagraphs && state.marks.longCount > 0 && state.bookPath && state.index >= 0 && state.view === 'editor';
    chip.classList.toggle('hidden', !show);
    if (!show) {
      chip.textContent = '超长段落';
      chip.title = '';
      return;
    }
    chip.textContent = `超长段落 ${state.marks.longCount} 段`;
    chip.title = longParagraphsTitle();
  }

  function jumpToNextLongParagraph() {
    if (!state.marks.longParagraphs) return false;
    const item = editorLogic.nextLongParagraph(state.marks.longItems, editorEl.selectionStart || 0);
    if (!item) return false;
    editorEl.focus();
    editorEl.setSelectionRange(item.start, item.start);
    scrollCaretIntoView(item.start);
    syncMarksScroll();
    renderSelectionStats();
    return true;
  }

  // Alt+↑ / Alt+↓：在自然段开头之间跳（只移动光标，不改字）
  function jumpParagraph(direction) {
    if (state.view !== 'editor' || !state.bookPath || state.index < 0) return false;
    const target = editorLogic.paragraphJumpTarget(
      editorEl.value,
      editorEl.selectionStart || 0,
      Number(direction) < 0 ? -1 : 1
    );
    if (target == null) return false;
    editorEl.focus();
    editorEl.setSelectionRange(target, target);
    scrollCaretIntoView(target);
    syncMarksScroll();
    renderSelectionStats();
    return true;
  }

  // 「排版 ▾」里的高亮色板：当前生效颜色打圈；'' 时「跟随主题」那个拼色圆点打圈。
  // 只改 class / 取色器的显示值，不写配置。
  function renderCaretColorRow() {
    const value = caretColorValue(state.config);
    const row = $('format-caret-colors');
    if (row) {
      for (const btn of row.querySelectorAll('[data-caret-color]')) {
        const swatch = caretColorLib.normalizeColor(btn.dataset.caretColor);
        const active = swatch === value;
        btn.dataset.active = active ? '1' : '0';
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        // 色块颜色用 CSSOM 写（CSP 不允许静态 style 属性）；空值交给 .caret-swatch-theme 的拼色渐变
        if (swatch) btn.style.setProperty('--swatch', swatch);
        else btn.style.removeProperty('--swatch');
      }
    }
    const picker = $('format-caret-color');
    if (picker) {
      // input[type=color] 不能显示 ''：跟随主题时给最后一个色板色，只作为取色器起点，
      // 真正保存的颜色仍以 state.config 为准（点取色器才会改成自定义）。
      picker.value = value || caretColorLib.PRESET_VALUES[0];
    }
  }

  function renderMarksMenu() {
    const invisibles = $('format-invisibles');
    const long = $('format-long-para');
    const caret = $('format-caret-para');
    const threshold = longParagraphThreshold();
    if (invisibles) {
      invisibles.textContent = `${state.marks.invisibles ? '✓ ' : ''}显示不可见字符（␣ / 行尾空白）`;
      invisibles.dataset.on = state.marks.invisibles ? '1' : '0';
      invisibles.title =
        '只在正文上面画标记：全角空格标成 ␣、行尾空白标成浅红底。正文一个字都不会改，也不写盘。';
    }
    if (long) {
      long.textContent = `${state.marks.longParagraphs ? '✓ ' : ''}超长段落提示（>${threshold} 字左侧黄线）`;
      long.dataset.on = state.marks.longParagraphs ? '1' : '0';
      long.title = `超过 ${threshold} 字的段落，左侧画一条淡黄竖线（为手机阅读排版着想）。阈值可在设置「正文显示设置」里改（50–20000 字，按书生效）。只显示，不改正文。`;
    }
    if (caret) {
      caret.textContent = `${state.marks.caretParagraph ? '✓ ' : ''}当前段落高亮（光标所在段）`;
      caret.dataset.on = state.marks.caretParagraph ? '1' : '0';
      caret.title =
        '光标所在的那一段（含折行）画一层淡色底 + 左侧细线。开关和颜色都按书记忆（只写 config.json，不碰正文 / 书目 / 章节文件）；没单独设置过的书用全局默认。';
    }
    renderCaretColorRow();
  }

  // 两个「编辑器小件」开关按书记忆（1.1.0）：切换时写 config.json 的 bookDisplay[本书]。
  // 写盘只认 host.persistMarks（renderer.js 那边按当前书调 setBookDisplay），本模块不碰配置格式。
  // 写盘是异步的：界面先按新状态显示；写失败只 toast，不回滚内存态——本次会话仍按新状态显示，
  // 下次打开这本书回到上次成功保存的值（文案里写明）。「当前段落高亮」有自己的写盘入口
  // （renderer.js 的 setCaretParagraphPersisted），这里不重复写。
  const MARKS_BOOK_DISPLAY = Object.freeze({
    invisibles: 'marksInvisibles',
    longParagraphs: 'marksLongParagraphs'
  });
  const MARKS_TOGGLE_LABELS = Object.freeze({ invisibles: '显示不可见字符', longParagraphs: '超长段落提示' });

  function persistMarksSwitch(name, on) {
    const field = MARKS_BOOK_DISPLAY[name];
    if (!field) return;
    const failureText = `保存「${MARKS_TOGGLE_LABELS[name]}」开关失败：`;
    const note = '（本次仍按新状态显示，下次打开这本书回到上次保存的值）';
    try {
      const pending = persistMarks({ [field]: on });
      if (pending && typeof pending.then === 'function') {
        pending.then(
          () => {},
          (err) => toast(`${failureText}${(err && err.message) || err}${note}`, 'error')
        );
      }
    } catch (err) {
      toast(`${failureText}${(err && err.message) || err}${note}`, 'error');
    }
  }

  function setMarksToggle(name, on) {
    if (name !== 'invisibles' && name !== 'longParagraphs' && name !== 'caretParagraph') return false;
    state.marks[name] = Boolean(on);
    renderMarksMenu();
    // 超长正文的提示统一由 renderEditorMarks 的入口门控弹一次（F9）：这里不再按开关各弹一句，
    // 否则「打开一个开关」会同时收到门控与开关两条提示，超长期间反复切换也会重复弹。
    renderEditorMarks();
    return state.marks[name];
  }

  function toggleMarks(name) {
    if (name !== 'invisibles' && name !== 'longParagraphs' && name !== 'caretParagraph') return false;
    const toggled = setMarksToggle(name, !state.marks[name]);
    // setMarksToggle 只改内存（测试钩子 / 恢复快照也用它，不写盘）；从菜单点开关走 toggleMarks，
    // 两个编辑器小件开关顺手按书记住。
    if (MARKS_BOOK_DISPLAY[name]) persistMarksSwitch(name, toggled);
    return toggled;
  }

  function setupEditorMarks() {
    editorEl.addEventListener(
      'scroll',
      () => {
        syncMarksScroll();
        syncFindOverlayScroll();
      },
      { passive: true }
    );
    editorEl.addEventListener('compositionstart', () => {
      state.marks.composing = true;
    });
    editorEl.addEventListener('compositionend', () => {
      state.marks.composing = false;
      scheduleMarksRender(0);
    });
    for (const type of ['keyup', 'mouseup', 'select']) {
      editorEl.addEventListener(type, () => {
        renderSelectionStats();
        updateCaretParagraph();
        syncMarksScroll();
        syncFindOverlayScroll();
        // 键盘 / 鼠标移动光标后，打字机模式跟着把光标行放回 1/3 处
        if (focusActive() && state.focus.typewriter) scheduleTypewriterAlign(20);
      });
    }
    document.addEventListener('selectionchange', () => {
      renderSelectionStats();
      updateCaretParagraph();
    });
    if (typeof ResizeObserver === 'function') {
      state.marks.resizeObserver = new ResizeObserver(() => scheduleMarksRender(40));
      state.marks.resizeObserver.observe(editorEl);
    }
    $('status-long-para').addEventListener('click', () => jumpToNextLongParagraph());
    renderMarksMenu();
  }

    return {
      scheduleMarksRender,
      hideEditorMarks,
      syncEditorOverlay,
      renderEditorMarks,
      renderMarksMenu,
      syncMarksScroll,
      updateCaretParagraph,
      jumpToNextLongParagraph,
      jumpParagraph,
      renderCaretColorRow,
      setMarksToggle,
      toggleMarks,
      setupEditorMarks
    };
  }

  return { create: createEditorMarksUi, REQUIRED_HOST };
});
