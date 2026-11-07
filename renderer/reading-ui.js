/* 阅读模式（第 4 步 renderer 九刀·第二刀：从 renderer.js 的「阅读模式」分区整段搬出来）。
 *
 * 搬走的段（原 renderer.js 2616–3056，441 行）——整本只读通读（v0.8-4 提案 N4）：
 *   块渲染与测量（readingScrollEl / readingBlockElements / readingBlockIndexAt / readingLoadedIndexes /
 *     readingMeasureBlocks / readingCurrentIndex / readingVisibleIndex / readingHasBlock / readingSummaryText）
 *   加载与滚动（setReadingLoading / readingNearBottom / renderReadingToc / readingApplyStyle / setReadingPref /
 *     updateReadingUi / readingScrollToBlock / onReadingScroll / pruneReadingBlocks / createReadingBlock /
 *     fetchReadingBlock / readingReplaceAt / readingAppendNext / readingPrependPrev / autoFillReading /
 *     scheduleReadingScrollCheck / readingGo / readingJumpTo / openReadingMode / exitReadingMode）
 * **只搬不改行为**：只读 IPC（chapter:load）、token 作废旧响应、自动接章上限 8、最多留 40 块、
 * 字号 / 行距只改 CSS 变量不写配置、未保存提示文案、退出后回写作页并归还焦点——全部一字未改。
 *
 * 契约：createReadingUi(host) 由渲染层调用一次。host 8 个成员（含 3 个语义分组，分组内每个真实依赖都列在这里）：
 *   host = {
 *     $, state, api, call, toast,          // 基础 5：DOM 查询 / 共享状态 / IPC 白名单 / IPC 包装 / 提示
 *     reading: {                            // 阅读纯逻辑 + 字数格式化
 *       readingLogic,                       //   renderer/reading-logic.js：档位 / 进度 / 步进 / 接近底部 / 块定位
 *       formatChars                         //   「共 N 章 · 约 X 字」的字数口径（与书架 / 状态栏同一份）
 *     },
 *     view: {                               // 视图切换与顶栏菜单（进出阅读模式时用）
 *       showView,                           //   切到 reading / editor 视图
 *       hideContextMenu, hideVolumeMenu, hideHeaderMenus, // 进入阅读前收起三个顶栏菜单
 *       editorEl,                           //   退出阅读后把焦点还给编辑区
 *       scheduleMarksRender,                //   退出阅读后重排当前段落高亮
 *       updateWindowTitle                   //   当前章变了就重算窗口标题（渲染层唯一一份标题口径）
 *     },
 *     chapterTitle                          // 「第N章 标题」唯一口径（core/chapters.js）
 *   }
 * 缺任何一个（含分组内成员）直接抛 TypeError。分组在 create 时一次解构，行为等价。
 * create() 不注册事件、不建定时器、不碰 DOM；事件绑定在 setupReadingUi()，由 bindEvents() 在原「阅读模式
 * 按钮 / 目录 / 字号 / 行距 / 滚动」块的位置调用一次（scroll 监听保持 { passive: true } 原样）。
 *
 * 刻意不搬（留在 renderer.js）：Esc 动作表的 'exit-reading' 入口、window resize 里的
 * scheduleReadingScrollCheck(80) 调用、测试钩子宿主契约（按名字取本模块入口）。
 *
 * 2026-11-04 长跑（Phase D / D3）在搬走之后补了一件事：**阅读视图里 ← / → 翻上一章 / 下一章**。
 * 和顶栏「‹ 上一章」「下一章 ›」走同一条 readingGo（不先滚到章底——方向键是「整章跳」的显式动作，
 * PageUp / PageDown / 滚轮仍归浏览器滚动）；焦点在字号 / 行距 / 目录下拉里时方向键让给控件。
 * 只读语义一个字没变：不写正文、不写书目、不写配置。
 *
 * 2026-11-04 长跑（Phase D / D6）又补了：**Ctrl+滚轮 / Ctrl+= / Ctrl+- 调阅读字号**。
 * 三条入口全走同一个 setReadingPref('font', …)（与顶栏字号下拉同一条），只改阅读视图的 CSS 变量、
 * 不写配置；Ctrl+滚轮必须 preventDefault（否则 Chromium 拿它当整页缩放）。
 *
 * 2026-11-04 长跑（Phase D / D8）再补：**阅读模式的窗口标题带当前章号**（`…（阅读 · 第 2/3 章）`）。
 * 后缀文案在 readingLogic.readingTitleSuffix（纯函数），标题本身仍由渲染层的 updateWindowTitle 写
 * （那是全书唯一一份标题口径：书名、未保存星号、视图后缀都在那里）；本模块只在「当前章变了」时
 * 通过 host.view.updateWindowTitle 请它重算一次 —— 每次 updateReadingUi 都会喊（滚动换章也走这条），
 * 渲染层自己按「值没变就不写」去抖。
 *
 * 2026-11-04 长跑（Phase D / D14）再补：**目录下拉按卷分段**（`<optgroup>`）。分段规则是纯函数
 * `readingLogic.tocGroups`：按章节数组的连续卷段切组（书目归一时已保证「未分卷 → 第1卷 → …」连续），
 * 单卷 / 无卷书只有一段 —— 仍平铺渲染，外观与以前一字不差。只读 state.meta.volumes，不写盘。
 *
 * 2026-11-04 长跑（Phase D / D13）再补：**字号 / 行距按书记忆**（只记本次运行）。档位以前是全局一份，
 * 换本书还沿用上一本的字号；现在本模块里存一张 Map<书路径, {fontLevel, lineLevel}>（纯逻辑在
 * `readingLogic.prefsForBook / withBookPrefs`），进阅读时按 state.bookPath 取回、调档时回写。
 * 仍然不写 config.json、不进书目，重开应用回到默认档 —— 与「字号 / 行距不写配置」的只读语义一致。
 *
 * 2026-11-06（v0.13 / U-D10）再补：**阅读位置按书记忆**（同样只记本次运行）。退出阅读时把
 * 「视口上沿停在哪一章、章内比例」记进第二张 Map<书路径, {index, ratio, editorIndex}>
 * （纯逻辑在 `readingLogic.positionAtScroll / readingPositionForBook / withReadingPosition /
 * readingStartIndex`），重进这本书时回到上次读到的位置（章 + 章内位置都回来）。
 * 只活在内存里：不写 config.json、不进书目，重开应用回到默认（从当前写作章开始）—— 所以
 * README 的「不做书签」立场不变（书签要落盘）。两条边界：① 作者在编辑器里明确换了章
 * （state.index 与记位置时的 editorIndex 不同）→ 按编辑器当前章开始，不抢他的选择；
 * ② 本次阅读里出现过「读取失败」区块 → 不记位置，保住上一次的好位置。
 * 只读语义一个字没变：不写正文、不写书目、不写配置、不生成 _trash。
 *
 * 浏览器里挂成全局 CWReadingUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWReadingUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HOST = ['$', 'state', 'api', 'call', 'toast', 'reading', 'view', 'chapterTitle'];

  function createReadingUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createReadingUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) throw new TypeError('createReadingUi 的 host 缺少 ' + key);
    }
    const { $, state, api, call, toast, reading, view, chapterTitle } = host;
    if (typeof reading !== 'object') throw new TypeError('createReadingUi 的 host.reading 必须是对象');
    for (const key of ['readingLogic', 'formatChars']) {
      if (reading[key] === undefined || reading[key] === null) throw new TypeError('createReadingUi 的 host.reading 缺少 ' + key);
    }
    if (typeof view !== 'object') throw new TypeError('createReadingUi 的 host.view 必须是对象');
    for (const key of ['showView', 'hideContextMenu', 'hideVolumeMenu', 'hideHeaderMenus', 'editorEl', 'scheduleMarksRender', 'updateWindowTitle']) {
      if (view[key] === undefined || view[key] === null) throw new TypeError('createReadingUi 的 host.view 缺少 ' + key);
    }
    const { readingLogic, formatChars } = reading;
    const { showView, hideContextMenu, hideVolumeMenu, hideHeaderMenus, editorEl, scheduleMarksRender, updateWindowTitle } = view;

  // ---------- 阅读模式（v0.8-4，提案 N4） ----------
  // 整本只读通读：正文全部通过 chapter:load 从磁盘读（只读 IPC），不写正文 / 书目 / 配置，
  // 不生成 _trash，也不改「上次打开章节」。连续滚动时滚到接近底部自动接下一章；
  // 字号 / 行距只改阅读视图的 CSS 变量（只记内存，不写配置）。
  const READING_AUTO_FILL_MAX = 8; // 一次自动补齐最多接 8 章（很多空章时也不会无限读盘）
  // 字号 / 行距的按书记忆（Phase D / D13）：Map<书路径, { fontLevel, lineLevel }>，只活这一次运行。
  // 不写 config.json、不进书目；换本书不沿用上一本的档位，重开应用回到默认档。
  let readingPrefsByBook = new Map();
  // 阅读位置的按书记忆（v0.13 / U-D10）：Map<书路径, { index, ratio, editorIndex }>，只活这一次运行。
  // 不写 config.json、不进书目；重开应用回到默认（从当前写作章开始）。纯逻辑在 readingLogic 里。
  let readingPositionsByBook = new Map();

  function readingScrollEl() {
    return $('reading-scroll');
  }

  function readingBlockElements() {
    const content = $('reading-content');
    return content ? Array.from(content.querySelectorAll('.reading-chapter')) : [];
  }

  function readingBlockIndexAt(el) {
    if (!el || !el.dataset) return -1;
    const index = Number(el.dataset.index);
    return Number.isFinite(index) ? index : -1;
  }

  function readingLoadedIndexes() {
    return readingBlockElements()
      .map((el) => readingBlockIndexAt(el))
      .filter((index) => index >= 0);
  }

  // 每章区块顶端相对滚动内容顶部的位置（用来算「当前看到第几章」），顺带带上区块高度
  // （v0.13 / U-D10 记阅读位置要用：比例 = 视口上沿落在这一块里的位置 / 这一块的高度）。
  function readingMeasureBlocks() {
    const scroll = readingScrollEl();
    if (!scroll) return [];
    const scrollRect = scroll.getBoundingClientRect();
    return readingBlockElements()
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          index: readingBlockIndexAt(el),
          top: rect.top - scrollRect.top + scroll.scrollTop,
          height: rect.height
        };
      })
      .filter((block) => block.index >= 0);
  }

  function readingCurrentIndex() {
    if (!state.reading.open) return -1;
    const total = state.chapters.length;
    if (!total) return -1;
    return Math.max(0, Math.min(Math.floor(Number(state.reading.index) || 0), total - 1));
  }

  // 手动滚动时用：视野中线落在哪一章（章太短、顶不到屏幕顶时也能保持直觉）
  function readingVisibleIndex() {
    const scroll = readingScrollEl();
    const blocks = readingMeasureBlocks();
    if (!scroll || !blocks.length) return readingCurrentIndex();
    const line = Math.max(0, scroll.clientHeight / 2);
    const visible = readingLogic.blockAtScroll(blocks, scroll.scrollTop, line);
    return visible >= 0 ? visible : readingCurrentIndex();
  }

  function readingHasBlock(index) {
    return readingBlockElements().some((el) => readingBlockIndexAt(el) === index);
  }

  function readingSummaryText() {
    const total = state.chapters.length;
    const chars = readingLogic.bookChars(state.chapters);
    return `共 ${total} 章${chars > 0 ? ` · 约 ${formatChars(chars)}` : ''}`;
  }

  function setReadingLoading(on) {
    const loading = $('reading-loading');
    if (loading) loading.classList.toggle('hidden', !on);
    const content = $('reading-content');
    if (content) content.setAttribute('aria-busy', on ? 'true' : 'false');
  }

  function readingNearBottom() {
    const scroll = readingScrollEl();
    if (!scroll) return false;
    return readingLogic.nearBottom({
      scrollTop: scroll.scrollTop,
      scrollHeight: scroll.scrollHeight,
      clientHeight: scroll.clientHeight
    });
  }

  // 当前的阅读位置（v0.13 / U-D10）：视口上沿落在哪一章、章内比例。
  // 本次阅读里出现过「读取失败」区块就返回 null —— 读到坏章不算读到哪了，保住上一次的好位置。
  // 滚动还没量出来（没有区块）也返回 null。
  function readingPositionNow() {
    const content = $('reading-content');
    if (content && content.querySelectorAll('.reading-chapter-error').length > 0) return null;
    const scroll = readingScrollEl();
    const blocks = readingMeasureBlocks();
    if (!scroll || !blocks.length) return null;
    return readingLogic.positionAtScroll(blocks, scroll.scrollTop);
  }

  // 退出阅读时把位置记进内存（v0.13 / U-D10）：只记本次运行，不写盘。
  // 正在读盘时不记（DOM 里可能只有半截），让上一次的位置留着。
  function rememberReadingPosition() {
    if (!state.bookPath || state.reading.loading) return;
    const position = readingPositionNow();
    if (!position) return;
    readingPositionsByBook = readingLogic.withReadingPosition(
      readingPositionsByBook,
      state.bookPath,
      { index: position.index, ratio: position.ratio, editorIndex: state.index },
      state.chapters.length
    );
  }

  function renderReadingToc(selected) {
    const toc = $('reading-toc');
    if (!toc) return;
    const fragment = document.createDocumentFragment();
    // 有分卷时按卷分段（Phase D / D14）：长书几百章，平铺一长串根本找不到卷；卷名与左侧
    // 章节栏里的卷标题同一份（state.meta.volumes）。单卷 / 无卷时只有一段，仍走平铺，外观不变。
    const volumes = state.meta && Array.isArray(state.meta.volumes) ? state.meta.volumes : [];
    const groups = readingLogic.tocGroups(state.chapters, volumes);
    const makeOption = (index) => {
      const chapter = state.chapters[index] || {};
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = chapterTitle(index, chapter.name);
      return option;
    };
    if (groups.length > 1) {
      for (const group of groups) {
        const optgroup = document.createElement('optgroup');
        optgroup.label = group.label;
        for (const index of group.indexes) optgroup.appendChild(makeOption(index));
        fragment.appendChild(optgroup);
      }
    } else {
      state.chapters.forEach((_chapter, index) => fragment.appendChild(makeOption(index)));
    }
    toc.innerHTML = '';
    toc.appendChild(fragment);
    const maxIndex = Math.max(0, state.chapters.length - 1);
    const safe = Math.max(0, Math.min(Math.floor(Number(selected) || 0), maxIndex));
    toc.value = String(safe);
  }

  // 只改阅读视图的 CSS 变量；不写 config.json
  function readingApplyStyle() {
    const fontLevel = readingLogic.fontLevel(state.readingPrefs.fontLevel);
    const lineLevel = readingLogic.lineLevel(state.readingPrefs.lineLevel);
    state.readingPrefs.fontLevel = fontLevel;
    state.readingPrefs.lineLevel = lineLevel;
    const root = document.documentElement.style;
    root.setProperty('--reading-font-size', `${readingLogic.fontSize(fontLevel)}px`);
    root.setProperty('--reading-line-height', String(readingLogic.lineHeight(lineLevel)));
    const fontSelect = $('reading-font-level');
    const lineSelect = $('reading-line-level');
    if (fontSelect) fontSelect.value = String(fontLevel);
    if (lineSelect) lineSelect.value = String(lineLevel);
    if (state.reading.open) scheduleReadingScrollCheck(60);
  }

  // 进阅读模式时把这本书上次的档位取回来（Phase D / D13）：没有记录就是默认档，
  // 换一本书不会沿用上一本的字号 / 行距。只读内存表，不碰磁盘。
  function loadBookPrefs() {
    const saved = readingLogic.prefsForBook(readingPrefsByBook, state.bookPath);
    state.readingPrefs.fontLevel = saved.fontLevel;
    state.readingPrefs.lineLevel = saved.lineLevel;
  }

  function setReadingPref(kind, value) {
    if (kind === 'font') state.readingPrefs.fontLevel = readingLogic.fontLevel(value);
    else state.readingPrefs.lineLevel = readingLogic.lineLevel(value);
    readingApplyStyle();
    // 回写这本书的档位（Phase D / D13）：写完档位之后再记，存的就是夹紧后的值。
    // 只活在这一次运行里 —— 不写配置、不进书目。
    readingPrefsByBook = readingLogic.withBookPrefs(readingPrefsByBook, state.bookPath, state.readingPrefs);
    return kind === 'font' ? state.readingPrefs.fontLevel : state.readingPrefs.lineLevel;
  }

  function updateReadingUi() {
    if (!state.reading.open) return;
    const total = state.chapters.length;
    const current = readingCurrentIndex();
    const progress = readingLogic.readingProgress(current, total);
    const progressEl = $('reading-progress');
    if (progressEl) progressEl.textContent = progress.text;
    const toc = $('reading-toc');
    if (toc && document.activeElement !== toc) toc.value = String(Math.max(0, progress.index));
    const prevBtn = $('btn-reading-prev');
    const nextBtn = $('btn-reading-next');
    if (prevBtn) prevBtn.disabled = current <= 0;
    if (nextBtn) nextBtn.disabled = current < 0 || current >= total - 1;
    const loaded = readingLoadedIndexes();
    const end = $('reading-end');
    if (end) {
      end.classList.toggle('hidden', !(loaded.length && total > 0 && loaded[loaded.length - 1] === total - 1));
    }
    const summary = $('reading-summary');
    if (summary) summary.textContent = readingSummaryText();
    // 当前章变了就把窗口标题交给渲染层重算一次（Phase D / D8）：滚动换章、按钮翻章、目录跳章、
    // 进入阅读都会走到这里。标题文案只有渲染层一份，本模块不自己拼字符串。
    updateWindowTitle();
  }

  // 滚到目标章；ratio > 0 时再往这一章内部偏移（0 = 章顶，1 = 章底；v0.13 / U-D10 恢复阅读位置用）。
  // 不传 / 坏值按章顶处理，行为与之前一字不差。
  function readingScrollToBlock(index, ratio) {
    const scroll = readingScrollEl();
    const el = readingBlockElements().find((node) => readingBlockIndexAt(node) === index);
    if (!scroll || !el) return false;
    const scrollRect = scroll.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const top = rect.top - scrollRect.top + scroll.scrollTop;
    const keep = readingLogic.positionRatio(ratio);
    const inside = keep > 0 ? keep * Math.max(0, rect.height) : 0;
    scroll.scrollTop = Math.max(0, Math.round(top) - 4 + Math.round(inside));
    // 跳章时以目标章为准；章太短、滚不到顶时滚动位置会被浏览器夹到底部，
    // 进度仍显示用户点的这一章（不会被「视野中线」算回上一章）
    state.reading.index = index;
    state.reading.programmaticScrollTop = scroll.scrollTop;
    return true;
  }

  function onReadingScroll() {
    if (!state.reading.open) return;
    const scroll = readingScrollEl();
    if (!scroll) return;
    if (Math.abs(scroll.scrollTop - state.reading.programmaticScrollTop) >= 1) {
      state.reading.index = readingVisibleIndex();
    }
    scheduleReadingScrollCheck(140);
  }

  // 一次阅读会话最多留 40 章在 DOM 里；超了只从最前面移除（不动当前正在看的章）
  function pruneReadingBlocks() {
    const content = $('reading-content');
    const scroll = readingScrollEl();
    if (!content || !scroll) return;
    const nodes = readingBlockElements();
    if (nodes.length <= readingLogic.MAX_LOADED_BLOCKS) return;
    const current = readingCurrentIndex();
    let remove = nodes.length - readingLogic.MAX_LOADED_BLOCKS;
    for (const node of nodes) {
      if (remove <= 0) break;
      const index = readingBlockIndexAt(node);
      if (index >= current - 1) break;
      const before = scroll.scrollHeight;
      node.remove();
      const after = scroll.scrollHeight;
      scroll.scrollTop = Math.max(0, scroll.scrollTop - Math.max(0, before - after));
      remove -= 1;
    }
  }

  function createReadingBlock(index, text, options = {}) {
    const chapter = state.chapters[index] || {};
    const block = document.createElement('section');
    block.className = 'reading-chapter';
    block.dataset.index = String(index);
    const title = document.createElement('h2');
    title.className = 'reading-chapter-title';
    title.textContent = chapterTitle(index, chapter.name);
    block.appendChild(title);
    if (options.error) {
      const error = document.createElement('div');
      error.className = 'reading-chapter-error';
      error.textContent = `读取失败：${options.error}（章节文件可能被移动或删除了；阅读模式不会重建文件）`;
      block.appendChild(error);
      return block;
    }
    const body = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    if (!body.trim()) {
      const empty = document.createElement('div');
      empty.className = 'reading-chapter-empty';
      empty.textContent = '（本章暂无正文）';
      block.appendChild(empty);
      return block;
    }
    const content = document.createElement('div');
    content.className = 'reading-chapter-text';
    content.textContent = body;
    block.appendChild(content);
    return block;
  }

  async function fetchReadingBlock(index, token) {
    const chapter = state.chapters[index];
    if (!chapter) return null;
    try {
      const data = await call(api.loadChapter, state.bookPath, chapter.file);
      if (!state.reading.open || token !== state.reading.token) return null;
      return createReadingBlock(index, data.text);
    } catch (err) {
      if (!state.reading.open || token !== state.reading.token) return null;
      return createReadingBlock(index, '', { error: err.message });
    }
  }

  // 换一批内容（跳章 / 进入阅读时用）：先清空，只留目标章
  async function readingReplaceAt(index) {
    if (state.reading.loading) return null;
    const token = state.reading.token + 1;
    state.reading.token = token;
    state.reading.loading = true;
    setReadingLoading(true);
    $('reading-content').innerHTML = '';
    try {
      const node = await fetchReadingBlock(index, token);
      if (!node) return null;
      $('reading-content').appendChild(node);
      const scroll = readingScrollEl();
      if (scroll) scroll.scrollTop = 0;
      state.reading.index = index;
      state.reading.programmaticScrollTop = 0;
      updateReadingUi();
      scheduleReadingScrollCheck(40);
      return node;
    } finally {
      if (token === state.reading.token) {
        state.reading.loading = false;
        setReadingLoading(false);
      }
    }
  }

  async function readingAppendNext() {
    if (state.reading.loading) return null;
    const loaded = readingLoadedIndexes();
    const last = loaded.length ? loaded[loaded.length - 1] : -1;
    if (last < 0 || last >= state.chapters.length - 1) return null;
    const token = state.reading.token;
    state.reading.loading = true;
    setReadingLoading(true);
    try {
      const node = await fetchReadingBlock(last + 1, token);
      if (!node) return null;
      $('reading-content').appendChild(node);
      pruneReadingBlocks();
      updateReadingUi();
      return node;
    } finally {
      if (token === state.reading.token) {
        state.reading.loading = false;
        setReadingLoading(false);
      }
    }
  }

  async function readingPrependPrev() {
    if (state.reading.loading) return null;
    const loaded = readingLoadedIndexes();
    const first = loaded.length ? loaded[0] : -1;
    if (first <= 0) return null;
    const token = state.reading.token;
    state.reading.loading = true;
    setReadingLoading(true);
    try {
      const node = await fetchReadingBlock(first - 1, token);
      if (!node) return null;
      const content = $('reading-content');
      content.insertBefore(node, content.firstChild);
      updateReadingUi();
      return node;
    } finally {
      if (token === state.reading.token) {
        state.reading.loading = false;
        setReadingLoading(false);
      }
    }
  }

  // 连续滚动：在接近底部时自动把下一章接在后面
  async function autoFillReading() {
    if (!state.reading.open || state.reading.loading) return 0;
    let added = 0;
    for (let i = 0; i < READING_AUTO_FILL_MAX; i += 1) {
      if (!state.reading.open || state.reading.loading || !readingNearBottom()) break;
      const loaded = readingLoadedIndexes();
      const last = loaded.length ? loaded[loaded.length - 1] : -1;
      if (last < 0 || last >= state.chapters.length - 1) break;
      const node = await readingAppendNext();
      if (!node) break;
      added += 1;
    }
    if (added) updateReadingUi();
    return added;
  }

  function scheduleReadingScrollCheck(delay = 140) {
    if (!state.reading.open) return;
    if (state.reading.timer) clearTimeout(state.reading.timer);
    state.reading.timer = setTimeout(() => {
      state.reading.timer = null;
      if (!state.reading.open) return;
      updateReadingUi();
      void autoFillReading();
    }, Math.max(0, Number(delay) || 0));
  }

  async function readingGo(direction) {
    if (!state.reading.open) return { ok: false, message: '不在阅读模式' };
    if (state.reading.loading) return { ok: false, busy: true };
    const total = state.chapters.length;
    const current = readingCurrentIndex();
    const target = readingLogic.stepIndex(current, total, direction);
    if (target == null) {
      updateReadingUi();
      return { ok: false, edge: true, index: current };
    }
    if (readingHasBlock(target)) {
      readingScrollToBlock(target);
      updateReadingUi();
      scheduleReadingScrollCheck(60);
      return { ok: true, index: target };
    }
    // 相邻章还没加载：往前翻就补在最前面，往后翻就接在最后面
    const node = target > current ? await readingAppendNext() : await readingPrependPrev();
    if (!node) {
      updateReadingUi();
      return { ok: false, message: '读取章节失败' };
    }
    readingScrollToBlock(target);
    updateReadingUi();
    scheduleReadingScrollCheck(60);
    return { ok: true, index: target };
  }

  async function readingJumpTo(index) {
    if (!state.reading.open) return { ok: false, message: '不在阅读模式' };
    const total = state.chapters.length;
    if (!total) return { ok: false, message: '没有章节' };
    const target = Math.max(0, Math.min(Math.floor(Number(index) || 0), total - 1));
    if (readingHasBlock(target)) {
      readingScrollToBlock(target);
      updateReadingUi();
      scheduleReadingScrollCheck(60);
      return { ok: true, index: target };
    }
    if (state.reading.loading) return { ok: false, busy: true };
    await readingReplaceAt(target);
    const scroll = readingScrollEl();
    if (scroll) scroll.focus({ preventScroll: true });
    return { ok: true, index: target };
  }

  async function openReadingMode() {
    if (!state.bookPath || !state.meta) return { ok: false, message: '先打开一本书' };
    if (state.reading.open) return { ok: true, already: true };
    if (!state.chapters.length) {
      toast('这本书还没有章节，没法进入阅读模式', 'warn');
      return { ok: false, message: '没有章节' };
    }
    hideContextMenu();
    hideVolumeMenu();
    hideHeaderMenus();
    state.reading.open = true;
    const total = state.chapters.length;
    const editorIndex = Math.max(0, Math.min(state.index < 0 ? 0 : state.index, total - 1));
    // 阅读位置记忆（v0.13 / U-D10）：编辑区还停在记位置时的那一章 → 回到上次读到的章；
    // 否则按编辑区当前章开始（作者明确换了章 / 第一次进这本书）。只看内存，不读盘。
    const saved = readingLogic.readingPositionForBook(readingPositionsByBook, state.bookPath, total);
    const startIndex = readingLogic.readingStartIndex(saved, editorIndex, total);
    state.reading.startIndex = startIndex;
    state.reading.index = state.reading.startIndex;
    state.reading.programmaticScrollTop = 0;
    state.reading.loading = false;
    state.reading.token += 1;
    const title = state.meta.title || '';
    $('reading-book-title').textContent = title;
    $('reading-book-title').title = title;
    const dirtyNote = state.dirty
      ? '当前章有未保存的修改：阅读视图显示的是磁盘上的内容，你的修改还留在编辑区，退出阅读后照常可以保存。'
      : '';
    $('reading-note').textContent = dirtyNote;
    $('reading-note').classList.toggle('hidden', !dirtyNote);
    renderReadingToc(state.reading.startIndex);
    // Phase D / D13：先取回这本书自己的字号 / 行距，再写 CSS 变量（换书不沿用上一本的档位）
    loadBookPrefs();
    readingApplyStyle();
    $('reading-content').innerHTML = '';
    $('reading-end').classList.add('hidden');
    $('reading-summary').textContent = readingSummaryText();
    showView('reading');
    const scroll = readingScrollEl();
    if (scroll) scroll.scrollTop = 0;
    await readingReplaceAt(state.reading.startIndex);
    // 回到上次读到的章内位置（v0.13 / U-D10）：只在这一章就是记下来的那一章、且比例 > 0 时滚；
    // 章顶 / 换了起点都保持原来的「从章首开始」。
    if (state.reading.open && startIndex === saved.index && saved.ratio > 0) {
      readingScrollToBlock(startIndex, saved.ratio);
      updateReadingUi();
    }
    if (state.reading.open && scroll) scroll.focus({ preventScroll: true });
    return { ok: true, startIndex: state.reading.startIndex };
  }

  function exitReadingMode() {
    if (!state.reading.open) return false;
    // 先记下「读到哪了」（v0.13 / U-D10）：只进内存 Map，不写盘；读盘没回来 / 有坏章时不记。
    rememberReadingPosition();
    state.reading.open = false;
    state.reading.loading = false;
    state.reading.token += 1;
    if (state.reading.timer) {
      clearTimeout(state.reading.timer);
      state.reading.timer = null;
    }
    setReadingLoading(false);
    $('reading-content').innerHTML = '';
    $('reading-end').classList.add('hidden');
    $('reading-note').classList.add('hidden');
    $('reading-toc').innerHTML = '';
    // 回到写作页：不重新加载章节、不移动正文、不写盘；未保存内容原样还在编辑区
    showView('editor');
    scheduleMarksRender(0);
    try {
      editorEl.focus({ preventScroll: true });
    } catch { /* 焦点回不去不影响正文 */ }
    return true;
  }

  // 键盘翻章（Phase D / D3）：← / → 和顶栏两个按钮是同一件事，都走 readingGo。
  // · 不先滚到章底：PageUp / PageDown / 滚轮负责滚动，方向键只做「整章跳」，到章首 / 章尾停住；
  // · 焦点在字号 / 行距 / 目录下拉里时让给控件（方向键在那里是改选项），带修饰键的组合一律放行；
  // · 只在阅读模式里生效（视图隐藏时本来收不到按键，这里再守一道，合成事件也进不来）。
  // Phase D / D6 在这里多接一组键：Ctrl+= / Ctrl+- 调字号（与字号下拉同一条 setReadingPref，
  // 只改 CSS 变量、不写配置）。Shift 只在键名已经是 '+' / '_' 时才放过（Ctrl+Shift+= 就是 Ctrl++）。
  function isReadingControl(target) {
    if (!target || typeof target !== 'object') return false;
    const tag = String(target.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
    return target.isContentEditable === true;
  }

  function onReadingFontStep(step) {
    setReadingPref('font', state.readingPrefs.fontLevel + step);
  }

  function onReadingKeydown(event) {
    if (!state.reading.open || !event || event.defaultPrevented) return;
    const key = String(event.key == null ? '' : event.key);
    if (event.ctrlKey && !event.altKey && !event.metaKey) {
      const step = readingLogic.fontStepForKey(key);
      if (step) {
        event.preventDefault();
        onReadingFontStep(step);
        return;
      }
    }
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    if (key !== 'ArrowLeft' && key !== 'ArrowRight') return;
    if (isReadingControl(event.target)) return;
    event.preventDefault();
    void readingGo(key === 'ArrowLeft' ? -1 : 1);
  }

  // Ctrl+滚轮调字号（Phase D / D6）：读长文时手不离滚动。
  // · 只认「单按 Ctrl」的滚轮：不按 Ctrl 的滚动、Ctrl+Shift / Ctrl+Alt 的组合照旧归浏览器 / 系统；
  // · 必须 preventDefault —— Chromium 会把 Ctrl+滚轮当整页缩放（连顶栏按钮一起变大）；
  // · deltaY < 0 = 上滚 = 放大；档位与越界由 setReadingPref / readingLogic.fontLevel 夹紧。
  function onReadingWheel(event) {
    if (!state.reading.open || !event || !event.ctrlKey) return;
    if (event.altKey || event.metaKey || event.shiftKey) return;
    const deltaY = Number(event.deltaY);
    if (!Number.isFinite(deltaY) || deltaY === 0) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    onReadingFontStep(deltaY < 0 ? 1 : -1);
  }

  // 事件绑定（与搬前 bindEvents() 里的阅读模式块逐行一致；由渲染层在原位置调用一次）
  function setupReadingUi() {
    $('btn-reading').addEventListener('click', () => void openReadingMode());
    $('btn-reading-exit').addEventListener('click', () => exitReadingMode());
    $('btn-reading-first').addEventListener('click', () => void readingJumpTo(0));
    $('btn-reading-prev').addEventListener('click', () => void readingGo(-1));
    $('btn-reading-next').addEventListener('click', () => void readingGo(1));
    $('reading-font-level').addEventListener('change', () =>
      setReadingPref('font', $('reading-font-level').value)
    );
    $('reading-line-level').addEventListener('change', () =>
      setReadingPref('line', $('reading-line-level').value)
    );
    $('reading-toc').addEventListener('change', () =>
      void readingJumpTo(Number($('reading-toc').value))
    );
    // 键盘翻章挂在阅读视图这一层：焦点在正文区 / 顶栏按钮上都能收到（下拉自己先接走方向键）
    $('reading-view').addEventListener('keydown', onReadingKeydown);
    // Ctrl+滚轮调字号（Phase D / D6）：挂整个阅读视图，指针在正文 / 顶栏 / 页脚上都一样好使。
    // passive:false 是必须的 —— 默认被动监听里 preventDefault() 会被忽略，整页缩放就漏过去了。
    $('reading-view').addEventListener('wheel', onReadingWheel, { passive: false });
    $('reading-scroll').addEventListener('scroll', onReadingScroll, {
      passive: true
    });
  }


    return {
      readingScrollEl,
      readingBlockElements,
      readingBlockIndexAt,
      readingLoadedIndexes,
      readingMeasureBlocks,
      readingCurrentIndex,
      readingVisibleIndex,
      readingNearBottom,
      setReadingPref,
      updateReadingUi,
      readingScrollToBlock,
      scheduleReadingScrollCheck,
      readingGo,
      readingJumpTo,
      openReadingMode,
      exitReadingMode,
      setupReadingUi
    };
  }

  return { create: createReadingUi, REQUIRED_HOST };
});
