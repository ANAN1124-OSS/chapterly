/* 专注模式（第 4 步 renderer 九刀·补刀 12：从 renderer.js 的「专注模式」分区整段搬出来）。
 *
 * 搬走的段（原 renderer.js 1285–1454，170 行）——隐藏左栏与顶栏、只留正文与极简退出条（提案 3.5）：
 *   focusActive / updateFocusBar / ensureFocusMirror（打字机测量层）/ measureCaretTop / alignTypewriter /
 *   scheduleTypewriterAlign / restoreFocusScroll / setFocusMode / toggleFocusMode / setFocusTypewriter。
 * **只搬不改行为**：F11 / 顶栏「专注」进出、Esc 退出、可选打字机模式（光标行保持在正文上方约 1/3、
 * 死区内不动）、退出后按「光标行顶端 - 滚动位置」还原视口、只改 DOM class / scrollTop / 选区，
 * 不碰正文、不写盘、不写配置——全部一字未改。绑定（顶栏「专注」/ 退出条「退出专注」/「打字机」）随域
 * 搬进 setupFocusModeUi()。
 *
 * 契约：createFocusModeUi(host) 由渲染层调用一次。host 5 个成员（3 个语义分组 + 基础 2）：
 *   host = {
 *     $, state,                       // 基础 2：DOM 查询 / 共享状态（state.focus）
 *     focus: { focusLogic, editorEl },// core/focus-logic.js：打字机滚动计划 / 光标测量上限 / 滚动夹取
 *     marks: { scheduleMarksRender, syncMarksScroll },  // 编辑器小件域：标记层重绘 / 跟随滚动
 *     menus: { hideContextMenu, hideHeaderMenus, hideVolumeMenu } // 进入专注前收起所有浮层（共享胶水）
 *   }
 * 缺任何一个（含分组内成员）直接抛 TypeError。分组在 create 时一次解构，行为等价。
 * create() 不注册事件；事件绑定在 setupFocusModeUi()，由 bindEvents() 在原位置调用一次。
 * scheduleTypewriterAlign 的 30ms 定时器是原有行为（随函数搬走）。
 *
 * 刻意不搬（留在 renderer.js）：F11 / Esc 的全局 keydown、视图切换里的 setFocusMode 调用、
 * 编辑区事件里的打字机对齐调用、测试钩子宿主契约。
 *
 * 浏览器里挂成全局 CWFocusModeUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWFocusModeUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HOST = ['$', 'state', 'focus', 'marks', 'menus'];

  function createFocusModeUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createFocusModeUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) throw new TypeError('createFocusModeUi 的 host 缺少 ' + key);
    }
    const { $, state, focus, marks, menus } = host;
    if (typeof focus !== 'object') throw new TypeError('createFocusModeUi 的 host.focus 必须是对象');
    for (const key of ['focusLogic', 'editorEl']) {
      if (focus[key] === undefined || focus[key] === null) throw new TypeError('createFocusModeUi 的 host.focus 缺少 ' + key);
    }
    if (typeof marks !== 'object') throw new TypeError('createFocusModeUi 的 host.marks 必须是对象');
    for (const key of ['scheduleMarksRender', 'syncMarksScroll']) {
      if (marks[key] === undefined || marks[key] === null) throw new TypeError('createFocusModeUi 的 host.marks 缺少 ' + key);
    }
    if (typeof menus !== 'object') throw new TypeError('createFocusModeUi 的 host.menus 必须是对象');
    for (const key of ['hideContextMenu', 'hideHeaderMenus', 'hideVolumeMenu']) {
      if (menus[key] === undefined || menus[key] === null) throw new TypeError('createFocusModeUi 的 host.menus 缺少 ' + key);
    }
    const { focusLogic, editorEl } = focus;
    const { scheduleMarksRender, syncMarksScroll } = marks;
    const { hideContextMenu, hideHeaderMenus, hideVolumeMenu } = menus;

  // ---------- 专注模式（提案 3.5）----------
  // 隐藏左栏与顶栏，只留正文与一条极简退出条：F11 / 顶栏「专注」进出，Esc 退出。
  // 可选「打字机模式」：光标所在行保持在正文区上方约 1/3 处，只调 textarea.scrollTop。
  // 全部只改显示（DOM class / 滚动位置），不碰正文、不写盘、不写配置。
  function focusActive() {
    return Boolean(state.focus.on && state.view === 'editor' && state.bookPath);
  }

  function updateFocusBar() {
    const bar = $('focus-bar');
    if (bar) bar.classList.toggle('hidden', !focusActive());
    const title = $('focus-chapter');
    if (title) title.textContent = focusActive() ? $('chapter-title').textContent || '' : '';
    const typewriter = $('btn-focus-typewriter');
    if (typewriter) {
      typewriter.textContent = `${state.focus.typewriter ? '✓ ' : ''}打字机`;
      typewriter.dataset.on = state.focus.typewriter ? '1' : '0';
      typewriter.title = state.focus.typewriter
        ? '打字机模式已开：光标所在行保持在正文上方约 1/3 处（只调滚动，不改正文、不写盘）'
        : '打字机模式：光标所在行保持在正文上方约 1/3 处（只调滚动，不改正文、不写盘）';
    }
  }

  // 打字机模式的光标测量层：和正文同样的字体 / 行高 / 宽度，绝对定位在屏幕外。
  // 往里面放「光标前的正文 + 一个零宽标记」，量标记的 offsetTop 就知道光标行在哪。
  function ensureFocusMirror() {
    let mirror = $('focus-mirror');
    if (mirror) return mirror;
    mirror = document.createElement('div');
    mirror.id = 'focus-mirror';
    mirror.className = 'focus-mirror';
    mirror.setAttribute('aria-hidden', 'true');
    const main = document.querySelector('.editor-main');
    (main || document.body).appendChild(mirror);
    return mirror;
  }

  // 光标所在行的顶端（相对正文内容顶部、含 padding，px）；量不出来返回 null（就这次不对齐）
  function measureCaretTop(position) {
    const text = editorEl.value;
    if (text.length > focusLogic.MAX_TYPEWRITER_CHARS) return null;
    const styles = getComputedStyle(editorEl);
    const px = (value) => {
      const n = parseFloat(value);
      return Number.isFinite(n) ? n : 0;
    };
    const width = Math.max(0, editorEl.clientWidth - px(styles.paddingLeft) - px(styles.paddingRight));
    if (width <= 0) return null;
    const mirror = ensureFocusMirror();
    mirror.style.width = `${width}px`;
    mirror.style.fontFamily = styles.fontFamily;
    mirror.style.fontSize = styles.fontSize;
    mirror.style.fontWeight = styles.fontWeight;
    mirror.style.fontStyle = styles.fontStyle;
    mirror.style.lineHeight = styles.lineHeight;
    mirror.style.letterSpacing = styles.letterSpacing;
    const pos = Math.max(0, Math.min(Math.floor(Number(position) || 0), text.length));
    mirror.textContent = text.slice(0, pos);
    const marker = document.createElement('span');
    marker.className = 'focus-mirror-caret';
    marker.textContent = '\u200b'; // 零宽空格：不占宽度、不影响换行，只用来定位
    mirror.appendChild(marker);
    const offsetTop = marker.offsetTop - mirror.offsetTop;
    mirror.textContent = '';
    if (!Number.isFinite(offsetTop)) return null;
    return Math.round((px(styles.paddingTop) + offsetTop) * 100) / 100;
  }

  // 打字机模式：把光标行放到正文区上方约 1/3 处（死区内不动，免得每打一个字都抖）
  function alignTypewriter() {
    if (!focusActive() || !state.focus.typewriter) return false;
    const caretTop = measureCaretTop(editorEl.selectionStart || 0);
    if (caretTop == null) return false;
    const plan = focusLogic.planTypewriterScroll({
      caretTop,
      currentScrollTop: editorEl.scrollTop,
      viewportHeight: editorEl.clientHeight,
      maxScrollTop: editorEl.scrollHeight - editorEl.clientHeight,
      ratio: focusLogic.TYPEWRITER_RATIO_DEFAULT
    });
    if (!plan.adjust) return false;
    editorEl.scrollTop = plan.scrollTop;
    syncMarksScroll();
    return true;
  }

  function scheduleTypewriterAlign(delay = 30) {
    if (state.focus.timer) clearTimeout(state.focus.timer);
    state.focus.timer = setTimeout(() => {
      state.focus.timer = null;
      alignTypewriter();
    }, Math.max(0, Number(delay) || 0));
  }

  // 退出专注模式后把「你刚才看的那一段」放回原处：
  // 专注模式下正文变宽、换行会变，死记 scrollTop 会偏；所以按「光标行顶端 - 滚动位置」
  // 这个相对位置还原来，宽度变了也能把光标那一行放回原来的屏幕高度。
  function restoreFocusScroll() {
    if (state.view !== 'editor' || !state.bookPath) return false;
    const savedScrollTop = Math.max(0, Number(state.focus.savedScrollTop) || 0);
    const caret = Math.max(0, Number(state.focus.savedCaret) || 0);
    let top = savedScrollTop;
    if (state.focus.savedCaretOffset != null) {
      const caretTop = measureCaretTop(caret);
      if (caretTop != null) top = caretTop - state.focus.savedCaretOffset;
    }
    editorEl.scrollTop = focusLogic.clampScrollTop(top, editorEl.scrollHeight - editorEl.clientHeight);
    try {
      editorEl.focus();
      editorEl.setSelectionRange(caret, caret);
    } catch { /* 光标对不上不影响正文 */ }
    syncMarksScroll();
    return true;
  }

  function setFocusMode(on, options = {}) {
    const want = Boolean(on);
    if (want === state.focus.on) {
      updateFocusBar();
      return state.focus.on;
    }
    if (want && !(state.view === 'editor' && state.bookPath)) return false;
    const view = $('editor-view');
    const restore = options.restore !== false;
    if (want) {
      // 记下进入前的滚动位置与「光标在视口里的位置」，退出时还回去
      state.focus.savedScrollTop = Math.max(0, Number(editorEl.scrollTop) || 0);
      state.focus.savedCaret = Math.max(0, Number(editorEl.selectionStart) || 0);
      const caretTop = measureCaretTop(state.focus.savedCaret);
      state.focus.savedCaretOffset =
        caretTop == null ? null : Math.round((caretTop - state.focus.savedScrollTop) * 100) / 100;
      hideContextMenu();
      hideHeaderMenus();
      hideVolumeMenu();
      state.focus.on = true;
      if (view) view.classList.add('focus-mode');
      document.body.classList.add('focus-mode');
      updateFocusBar();
      scheduleMarksRender(0);
      // 打字机模式：进来就先把光标行放到 1/3 处
      if (state.focus.typewriter) scheduleTypewriterAlign(0);
      try {
        editorEl.focus();
        editorEl.setSelectionRange(state.focus.savedCaret, state.focus.savedCaret);
      } catch { /* 光标对不上不影响正文 */ }
    } else {
      state.focus.on = false;
      if (state.focus.timer) {
        clearTimeout(state.focus.timer);
        state.focus.timer = null;
      }
      if (view) view.classList.remove('focus-mode');
      document.body.classList.remove('focus-mode');
      updateFocusBar();
      if (restore) restoreFocusScroll();
      scheduleMarksRender(0);
    }
    return state.focus.on;
  }

  function toggleFocusMode() {
    return setFocusMode(!state.focus.on);
  }

  function setFocusTypewriter(on) {
    state.focus.typewriter = Boolean(on);
    updateFocusBar();
    if (state.focus.typewriter) alignTypewriter();
    return state.focus.typewriter;
  }

  // 事件绑定（与搬前 bindEvents() 里的专注模式块逐行一致；由渲染层在原位置调用一次）
  function setupFocusModeUi() {
    // 专注模式（提案 3.5）：顶栏「专注」进出 + 极简退出条上的「打字机 / 退出专注」
    $('btn-focus').addEventListener('click', () => toggleFocusMode());
    $('btn-focus-exit').addEventListener('click', () => setFocusMode(false));
    $('btn-focus-typewriter').addEventListener('click', () => setFocusTypewriter(!state.focus.typewriter));
  }


    return {
      focusActive,
      updateFocusBar,
      ensureFocusMirror,
      measureCaretTop,
      alignTypewriter,
      scheduleTypewriterAlign,
      restoreFocusScroll,
      setFocusMode,
      toggleFocusMode,
      setFocusTypewriter,
      setupFocusModeUi
    };
  }

  return { create: createFocusModeUi, REQUIRED_HOST };
});
