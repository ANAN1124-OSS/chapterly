/* 章节列表 / 卷章目录显示层（WP17 A3 第一刀：从 renderer.js 整段搬出来）。
 *
 * 搬走的一段：renderer.js「章节列表」分区 1516–2430 行（915 行），48 个入口：
 *   筛选（查询 / 命中 / 计数 / 防抖 / 回写输入框）、全书概览行、卷头（吸顶 / 折叠 / 全部折叠）、
 *   条目的 tooltip / 章号 / 字数 / 备注 / ⋯、事件委托（点击 / 双击 / 右键 / 键盘多选 / 拖拽起手）、
 *   多选选择态（高亮 / 批量条 / prune / ensure）、整表重建（平铺 / 按卷分组 / 筛选空态 / 真空态）。
 * **只碰显示层与 state 的既有显示字段**：不写盘、不改正文、不碰 IPC 白名单、不改数据格式；
 * 文案 / class / DOM 结构 / 返回值形状 / 事件入口全部照旧（行为零改动）。
 *
 * 契约：createChapterDirectoryUi(host) 由渲染层调用一次，host 提供：
 *   host = {
 *     $, state, chapterTitle, chapterListLabel, chaptersLib, chapterFilterLogic,
 *     chapterCharsOf, formatCount, editorLogic, imeGuard, listKeyboard, chapterSelectionLib,
 *     chapterStatus, chapterNote, CHAPTER_STATUS_LABELS,
 *     switchChapter,                    // 惰性转发：装配点在 const 声明之前
 *     showContextMenu, showVolumeMenu, startChapterDrag, renameChapterAt,
 *     copySelectedChapters, exportSelectedChapters, deleteSelectedChapters, openVolumeChooserInMenu,
 *     markCommandsDirty,
 *     getCachedActiveChapterItem, setCachedActiveChapterItem  // 当前章条目缓存：可变句柄按引用现取
 *   }
 * 缺任何一个直接抛 TypeError（宁可在启动时炸，也不要到点目录时 ReferenceError）。
 *
 * 事件监听仍由渲染层 bindEvents 调 setupChapterDirectory / setupChapterListEvents / setupChapterBatchBar
 * 一次装上；Esc 动作表 / 测试钩子 / 各面板按原名取入口（renderer.js 里是同一批 const）。
 * 当前章条目缓存（1.6.0 A5/P-09）的变量仍归渲染层（切章快路径 syncActiveChapterItem 直接写它），
 * 模块通过 get / set 两个宿主成员读写，避免把切章快路径也拖进这一刀。
 *
 * 浏览器里挂成全局 CWChapterDirectoryUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../core/assert-host').assertHost);
  } else if (root) {
    root.CWChapterDirectoryUi = factory(root.CWAssertHost && root.CWAssertHost.assertHost);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (assertHost) {
  'use strict';

  const REQUIRED_HOST = [
    '$', 'state', 'chapterTitle', 'chapterListLabel', 'chaptersLib',
    'chapterFilterLogic', 'chapterCharsOf', 'formatCount', 'editorLogic', 'imeGuard',
    'listKeyboard', 'chapterSelectionLib', 'chapterStatus', 'chapterNote', 'CHAPTER_STATUS_LABELS',
    'switchChapter', 'showContextMenu', 'showVolumeMenu', 'startChapterDrag', 'renameChapterAt',
    'copySelectedChapters', 'exportSelectedChapters', 'deleteSelectedChapters', 'openVolumeChooserInMenu', 'markCommandsDirty',
    'getCachedActiveChapterItem', 'setCachedActiveChapterItem',
  ];

  function createChapterDirectoryUi(host) {
    assertHost('createChapterDirectoryUi', host, REQUIRED_HOST);
    const { $, state, chapterTitle, chapterListLabel, chaptersLib, chapterFilterLogic, chapterCharsOf, formatCount, editorLogic, imeGuard, listKeyboard, chapterSelectionLib, chapterStatus, chapterNote, CHAPTER_STATUS_LABELS, switchChapter, showContextMenu, showVolumeMenu, startChapterDrag, renameChapterAt, copySelectedChapters, exportSelectedChapters, deleteSelectedChapters, openVolumeChooserInMenu, markCommandsDirty } = host;
    const getCachedActiveChapterItem = host.getCachedActiveChapterItem;
    const setCachedActiveChapterItem = host.setCachedActiveChapterItem;

  // ---------- 章节列表 ----------
  // 2026-11-10 卷章目录重设计：书架返回 / 书名 / 全书概览 / 筛选 / 卷章树 / 底部一行操作。
  // 这里只加显示层的东西：筛选词存在 state.chapterFilter（内存），换书 / 新建章时清空；
  // 打开 / 保存 / 折叠 / 拖拽 / 右键 / 键盘的全部旧入口一个不改。
  function chapterFilterQuery() {
    return chapterFilterLogic.normalizeQuery(state.chapterFilter);
  }

  function chapterFilterActive() {
    return chapterFilterQuery() !== '';
  }

  // 归一后的查询词在匹配循环外算一次（RSHE-B-04：以前每章重跑一遍 normalizeQuery，
  // 千章书一次筛选就是 1000 次全串归一）。外部按 index 单独调用时仍可只传 index。
  function chapterIndexMatchesFilter(index, normalizedQuery) {
    const chapter = state.chapters[index];
    if (!chapter) return false;
    const query = normalizedQuery === undefined ? chapterFilterQuery() : normalizedQuery;
    if (!query) return true;
    // 章号按界面显示的编号方式算（按卷编号 = 卷内号），和目录 / 顶栏 / 状态栏同一份口径
    return chapterFilterLogic.matchChapter(
      chapter,
      index,
      chapterTitle(index, chapter.name),
      query,
      chaptersLib.chapterNumber(state.meta, index)
    );
  }

  function matchingChapterIndexes(normalizedQuery) {
    const query = normalizedQuery === undefined ? chapterFilterQuery() : normalizedQuery;
    const out = [];
    state.chapters.forEach((chapter, index) => {
      if (chapterIndexMatchesFilter(index, query)) out.push(index);
    });
    return out;
  }

  // 目录概览的字数口径：书目缓存里有的章才算（和章节行 / 状态栏同一份 chapter.chars），
  // 一本书都没保存过（全 null）就只显示章数，不假装 0 字。
  function chapterCharsTotal(indexes) {
    let total = 0;
    let known = 0;
    for (const index of indexes) {
      const chars = chapterCharsOf(state.chapters[index]);
      if (chars != null) {
        total += chars;
        known += 1;
      }
    }
    return { total, known };
  }

  function formatCharsLabel(chars) {
    return chars >= 10000 ? `${editorLogic.formatCharsShort(chars)}字` : `${formatCount(chars)} 字`;
  }

  // matchedCount：renderChapterList 已经算过命中时就传进来，省掉第二遍全表匹配（RSHE-B-04）。
  function renderBookMeta(matchedCount) {
    const el = $('book-meta');
    if (!el) return;
    const total = state.chapters.length;
    if (!total) {
      el.textContent = '';
      el.title = '';
      return;
    }
    // RSHE-B-04：归一一次，筛选判定与文案共用（以前 chapterFilterActive 与 chapterFilterQuery 各归一一遍）。
    const query = chapterFilterQuery();
    if (query) {
      const matched = Number.isFinite(matchedCount) ? matchedCount : matchingChapterIndexes(query).length;
      // 筛选时这一行就是结果计数：读屏也跟着播报（属性先于文案设置，变化才会被读出来）
      el.setAttribute('aria-live', 'polite');
      el.textContent = `找到 ${matched} 章 · 共 ${total} 章`;
      el.title = `筛选「${query}」：找到 ${matched} 章（全书 ${total} 章）`;
      return;
    }
    el.setAttribute('aria-live', 'off');
    const all = state.chapters.map((chapter, index) => index);
    const { total: chars, known } = chapterCharsTotal(all);
    el.textContent = known ? `${total} 章 · ${formatCharsLabel(chars)}` : `${total} 章`;
    el.title = known
      ? `全书 ${total} 章；${formatCount(chars)} 字（书目缓存，保存后更新）`
      : `全书 ${total} 章`;
  }

  // 筛选词 → 输入框 / 清除键 / 概览行。目录重绘和事件处理共用这一份口径。
  function syncChapterFilterUi() {
    const input = $('chapter-filter');
    const clear = $('btn-clear-filter');
    const value = String(state.chapterFilter == null ? '' : state.chapterFilter);
    if (input && input.value !== value) input.value = value;
    if (clear) clear.classList.toggle('hidden', !chapterFilterActive());
  }

  // 1.5.0 P0-2（审计 P1）：目录筛选原来每敲一个键就整表重建（千章书每键全表 DOM）。
  // 查询词仍立刻写回 state（计数 / 清除键 / 回车 / Esc 都用最新值），「目录重排」走
  // 250ms 防抖 + 下一帧（与书架搜索同一套节奏）。清空 / Esc / 点浮标这类显式动作仍立即重画。
  let chapterFilterTimer = 0;
  let chapterFilterFrame = 0;

  function cancelScheduledChapterFilter() {
    if (chapterFilterTimer) {
      clearTimeout(chapterFilterTimer);
      chapterFilterTimer = 0;
    }
    if (chapterFilterFrame) {
      cancelAnimationFrame(chapterFilterFrame);
      chapterFilterFrame = 0;
    }
  }

  function scheduleChapterFilterRender(value) {
    state.chapterFilter = String(value == null ? '' : value);
    syncChapterFilterUi();
    renderBookMeta(); // 计数即时：列表可以等停手，概览行不能慢半拍
    if (chapterFilterTimer) clearTimeout(chapterFilterTimer);
    chapterFilterTimer = setTimeout(() => {
      chapterFilterTimer = 0;
      if (chapterFilterFrame) return;
      chapterFilterFrame = requestAnimationFrame(() => {
        chapterFilterFrame = 0;
        renderChapterList();
      });
    }, 250);
  }

  function setChapterFilter(value) {
    cancelScheduledChapterFilter();
    state.chapterFilter = String(value == null ? '' : value);
    syncChapterFilterUi();
    renderChapterList();
  }

  // 筛选命中的章名：把命中的那段文字包进 <mark>（只包最先命中的一个词；章号命中时章名不变），
  // 让作者一眼看出「为什么这一条留下来了」。textContent 仍是完整章名（标题统一测试不受影响）。
  function appendChapterName(el, name, query) {
    const terms = String(query || '').split(' ').filter(Boolean);
    const text = String(name == null ? '' : name);
    const lower = text.toLowerCase();
    let best = null;
    for (const term of terms) {
      const at = lower.indexOf(String(term).toLowerCase());
      if (at >= 0 && (!best || at < best.at)) best = { at, length: String(term).length };
    }
    if (!best) {
      el.textContent = text;
      return;
    }
    el.textContent = '';
    el.appendChild(document.createTextNode(text.slice(0, best.at)));
    const mark = document.createElement('mark');
    mark.className = 'chapter-hit';
    mark.textContent = text.slice(best.at, best.at + best.length);
    el.appendChild(mark);
    el.appendChild(document.createTextNode(text.slice(best.at + best.length)));
  }

  // 卷头（吸顶）的「全部折叠 / 全部展开」：只在有卷且没在筛选时出现。
  // 折叠状态只存在内存里（换书重置），和单卷折叠走同一份 state.collapsedVolumes。
  function volumeGroupKeys() {
    const volumes = volumeList();
    // 没分卷的书没有「卷」可折叠：不给「全部折叠」按钮（否则会把整张平铺目录收没）
    if (!volumes.length) return [];
    const ids = new Set(volumes.map((volume) => volume.id));
    const keys = volumes.map((volume) => volume.id);
    const hasOrphans = state.chapters.some((chapter) => {
      const volumeId = chapterVolumeId(chapter);
      return !(volumeId && ids.has(volumeId));
    });
    if (hasOrphans) keys.push('');
    return keys;
  }

  function renderVolumeToggle() {
    const btn = $('btn-toggle-volumes');
    if (!btn) return;
    const keys = volumeGroupKeys();
    if (!keys.length || chapterFilterActive()) {
      btn.classList.add('hidden');
      return;
    }
    btn.classList.remove('hidden');
    const allCollapsed = keys.every((key) => state.collapsedVolumes.has(key));
    btn.textContent = allCollapsed ? '全部展开' : '全部折叠';
    btn.title = allCollapsed ? '展开全部卷（只影响侧栏显示）' : '折叠全部卷（只影响侧栏显示）';
  }

  function toggleAllVolumes() {
    const keys = volumeGroupKeys();
    if (!keys.length) return;
    const allCollapsed = keys.every((key) => state.collapsedVolumes.has(key));
    keys.forEach((key) => {
      if (allCollapsed) state.collapsedVolumes.delete(key);
      else state.collapsedVolumes.add(key);
    });
    renderChapterList({ keepScroll: true });
  }


  function activeChapterItem() {
    const cached = getCachedActiveChapterItem();
    if (cached && cached.isConnected) return cached;
    const list = $('chapter-list');
    setCachedActiveChapterItem(list ? list.querySelector('.chapter-item.active') : null);
    return getCachedActiveChapterItem();
  }

  // 当前章被折叠时，在它所在的卷头上留 2px 朱红细线：目录收起后也知道自己写的那一卷在哪。
  // 只在「当前卷确实被折叠」时加，展开 / 筛选（强制展开）时都不加，避免多出一个无信息量的标记。
  function syncCurrentVolumeMarker() {
    const list = $('chapter-list');
    if (!list) return;
    // RSHE-B-06：筛选中所有卷被强制展开、卷头只作分组标签，不再挂「当前卷被折叠」的朱红标记
    // （那时当前章就在结果里看得见，标记只会误导成「当前卷被折叠」）。
    const key = chapterFilterActive() ? null : currentChapterGroupKey();
    const collapsed = key !== null && state.collapsedVolumes.has(key);
    list.querySelectorAll('.volume-item').forEach((row) => {
      row.classList.toggle('has-current', collapsed && row.dataset.volumeId === key);
    });
  }

  // 当前章所在的卷组 key（'' = 未分卷；null = 这本书没有卷，不存在「被折叠」）
  function currentChapterGroupKey() {
    if (state.index < 0 || !state.chapters[state.index]) return null;
    const volumes = volumeList();
    if (!volumes.length) return null;
    const ids = new Set(volumes.map((volume) => volume.id));
    const volumeId = chapterVolumeId(state.chapters[state.index]);
    return volumeId && ids.has(volumeId) ? volumeId : '';
  }

  // 「回到当前章」浮标：当前章被滚出目录 / 被吸顶卷头盖住 / 当前卷被折叠时，
  // 出现在目录底部给一条回去的路。只读 DOM 位置，不滚也不写任何状态；
  // 筛选时收起（筛选是一次「找别的章」的动作，不抢眼）。
  function updateCurrentChapterPill() {
    const pill = $('btn-return-current');
    const list = $('chapter-list');
    if (!pill || !list) return;
    const chapter = state.chapters[state.index];
    if (!chapter) {
      pill.classList.add('hidden');
      return;
    }
    const filtering = chapterFilterActive();
    const active = list.querySelector('.chapter-item.active');
    if (filtering) {
      // 当前章在筛选结果里 → 位置看得见，浮标收起。
      // 当前章被筛掉 → 浮标变成「清空筛选并回去」的唯一鼠标入口（筛选时不出「全部折叠」）。
      if (active) {
        pill.classList.add('hidden');
        return;
      }
      pill.textContent = `回到第${chaptersLib.chapterNumber(state.meta, state.index)}章（清空筛选）`;
      pill.title = `当前章不在筛选结果里：点一下清空筛选并回到「${chapterTitle(state.index, chapter.name)}」`;
      pill.classList.remove('hidden');
      return;
    }
    if (!active) {
      // 当前章在折叠的卷里：列表里没有这一条，但浮标仍然是回得去的（点一下展开并定位）
      const key = currentChapterGroupKey();
      if (key === null || !state.collapsedVolumes.has(key)) {
        pill.classList.add('hidden');
        return;
      }
      pill.textContent = `回到第${chaptersLib.chapterNumber(state.meta, state.index)}章`;
      pill.title = `当前章在已折叠的「${volumeDisplayName(key)}」里：点一下展开并定位`;
      pill.classList.remove('hidden');
      return;
    }
    const listRect = list.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    // 卷头吸顶高度 34px：条目压在卷头下面同样算看不见
    const coverTop = listRect.top + (list.querySelector('.volume-item') ? 34 : 0);
    const visible = activeRect.top >= coverTop - 0.5 && activeRect.bottom <= listRect.bottom + 0.5;
    if (visible) {
      pill.classList.add('hidden');
      return;
    }
    pill.textContent = `回到第${chaptersLib.chapterNumber(state.meta, state.index)}章`;
    pill.title = `回到当前章：${chapterTitle(state.index, chapter.name)}`;
    pill.classList.remove('hidden');
  }

  function scrollToCurrentChapter() {
    // 筛选把当前章藏起来时，浮标同时承担「清空筛选」：先回到完整目录，再滚到当前章
    if (chapterFilterActive()) setChapterFilter('');
    let active = activeChapterItem();
    if (!active) {
      // 当前卷被折叠：先展开再滚（与点卷头是同一份折叠状态）
      const key = currentChapterGroupKey();
      if (key !== null && state.collapsedVolumes.has(key)) {
        state.collapsedVolumes.delete(key);
        renderChapterList();
        active = activeChapterItem();
      }
    }
    if (!active) return;
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    active.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    updateCurrentChapterPill();
  }

  // 目录工具条：输入即筛（章名 / 第N章 / 纯章号，多词 AND）、Esc 清空、回车跳到第一条、
  // ↓ 把焦点交给目录第一行。全部走现有入口（switchChapter / listKeyboard），没有新写业务。
  function setupChapterDirectory() {
    const input = $('chapter-filter');
    const clear = $('btn-clear-filter');
    const pill = $('btn-return-current');
    const toggleVolumes = $('btn-toggle-volumes');
    if (input) {
      // 1.5.0 P0-2：输入即写回 state（计数 / 回车 / Esc 立刻拿到最新词），目录重排等停手
      input.addEventListener('input', () => scheduleChapterFilterRender(input.value));
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          if (!input.value) return;
          event.preventDefault();
          event.stopPropagation();
          setChapterFilter('');
          return;
        }
        if (event.key === 'Enter') {
          // WP-04（审计 C8 / V112）：输入法组字中的 Enter 是上屏候选词，不切章、也不拦默认行为。
          if (imeGuard.isImeComposing(event)) return;
          const first = matchingChapterIndexes()[0];
          if (first == null) return;
          event.preventDefault();
          void switchChapter(first);
          return;
        }
        if (event.key === 'ArrowDown') {
          const list = $('chapter-list');
          const items = list ? Array.from(list.querySelectorAll('.chapter-item')) : [];
          if (!items.length) return;
          event.preventDefault();
          listKeyboard.applyTabStops(items, 0);
          if (typeof items[0].focus === 'function') items[0].focus();
        }
      });
    }
    if (clear) {
      clear.addEventListener('click', () => {
        setChapterFilter('');
        if (input) input.focus();
      });
    }
    if (pill) pill.addEventListener('click', scrollToCurrentChapter);
    if (toggleVolumes) toggleVolumes.addEventListener('click', toggleAllVolumes);
    const list = $('chapter-list');
    if (list) {
      // 滚动事件只更新浮标：requestAnimationFrame 合并到一帧，拖滚动条时不做重复测量。
      let pending = 0;
      list.addEventListener('scroll', () => {
        if (pending) return;
        pending = window.requestAnimationFrame(() => {
          pending = 0;
          updateCurrentChapterPill();
        });
      }, { passive: true });
    }
    // 窗口高度变了，当前章可能从「看得见」变成「看不见」：浮标跟着重量一次（不依赖滚动事件）
    window.addEventListener('resize', updateCurrentChapterPill, { passive: true });
  }

  // 1.5.0 P0-2（审计 P1）：1000 章原来每条 6 个监听（点击 / 双击 / 右键 / pointerdown + ⋯ 两个），
  // 一次整表重建就是 6000 个闭包；改成 #chapter-list 容器挂一套，按 dataset.index 分派。
  // 必须保住的旧行为：roving tabindex、aria-label、startChapterDrag、state.suppressChapterClick、
  // list-keyboard 方向键、右键菜单、⋯ 按钮（同一张菜单）。
  function chapterItemAt(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return null;
    const item = target.closest('.chapter-item');
    if (!item) return null;
    const index = Number(item.dataset && item.dataset.index);
    if (!Number.isInteger(index) || index < 0 || index >= state.chapters.length) return null;
    return { item, index };
  }

  function chapterMoreAt(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return null;
    return target.closest('.chapter-more');
  }

  function setupChapterListEvents() {
    const list = $('chapter-list');
    if (!list) return;
    list.addEventListener('pointerdown', (event) => {
      // ⋯ 只服务点击：不要在它上面起拖拽（老实现靠 stopPropagation 挡住）
      if (chapterMoreAt(event)) return;
      // 1.5.0 功能-1：Ctrl / Shift 是「多选」，不是拖拽起手（否则一按就进拖拽、点击被 suppress）
      if (event.ctrlKey || event.metaKey || event.shiftKey) return;
      const hit = chapterItemAt(event);
      if (!hit) return;
      // 委托后 event.currentTarget 是容器，拖拽要的条目元素显式传进去
      startChapterDrag(event, hit.index, hit.item);
    });
    list.addEventListener('click', (event) => {
      const hit = chapterItemAt(event);
      // 点列表空白：清空多选（没有多选时什么都不做，不拦其它行为）
      if (!hit) {
        clearChapterSelection();
        return;
      }
      const more = chapterMoreAt(event);
      if (more) {
        // ⋯ 落在已选章上：菜单动作作用于全部已选；落在未选章上：先切成单选（与右键一致）
        ensureChapterSelected(hit.index);
        const rect = more.getBoundingClientRect();
        showContextMenu({ clientX: rect.right - 4, clientY: rect.bottom - 2 }, hit.index);
        return;
      }
      if (state.suppressChapterClick && Date.now() < state.suppressChapterClick) {
        state.suppressChapterClick = 0;
        return; // 刚拖拽完，别把这次点击当成切章
      }
      // Ctrl+单击：切换选中，不切章；Shift+单击：从 anchor 连到这一章，不切章（1.5.0 功能-1）
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const id = chapterIdAt(hit.index);
        if (id) setChapterSelection(chapterSelectionLib.toggle(chapterSelectionSnapshot(), id));
        return;
      }
      if (event.shiftKey) {
        event.preventDefault();
        const id = chapterIdAt(hit.index);
        if (id) {
          setChapterSelection(
            chapterSelectionLib.extendTo(
              chapterSelectionSnapshot(),
              // 五-M23（CD-01）：order 取**当前渲染出来的行**（与键盘 Ctrl+A / Shift+↑↓ 同口径）。
              // 以前传全书顺序，筛选 / 折叠下 Shift+连选会把看不见的章一起选进批量目标集
              // （批量删除 / 移卷 / 改状态波及不可见章）。anchor 失效时回落当前章，但当前章
              // 不在可见行里时模型只会选中目标这一条，不再按全书范围扩。
              renderedChapterIds(),
              id,
              currentChapterId()
            )
          );
        }
        return;
      }
      // 普通单击：清空多选 + 照旧切章
      clearChapterSelection();
      void switchChapter(hit.index);
    });
    list.addEventListener('dblclick', (event) => {
      const hit = chapterItemAt(event);
      if (hit) renameChapterAt(hit.index);
    });
    list.addEventListener('contextmenu', (event) => {
      // 卷头右键有卷头自己的监听（showVolumeMenu），这里只接章节条目
      const hit = chapterItemAt(event);
      if (!hit) return;
      event.preventDefault();
      // 落在已选章上：保留多选，菜单动作作用于全部已选；落在未选章上：先切成单选
      ensureChapterSelected(hit.index);
      showContextMenu(event, hit.index);
    });
    // 键盘：Ctrl+Space 切换焦点章的多选（方向键仍由 list-keyboard.js 负责，互不抢键）。
    // 1.6.0 F1：Shift+↑/↓ 扩选由下面 install() 的 onExtend 接，Ctrl+A 全选在全局 keydown 里。
    list.addEventListener('keydown', (event) => {
      if (event.key !== ' ' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const hit = chapterItemAt(event);
      if (!hit) return;
      event.preventDefault();
      event.stopPropagation();
      const id = chapterIdAt(hit.index);
      if (id) setChapterSelection(chapterSelectionLib.toggle(chapterSelectionSnapshot(), id));
    });
  }

  // 批量条「改状态 / 移卷」复用同一张右键菜单（只留能作用到全部已选章的动作）：
// 这样不用为批量再写一套弹层 / 不用新增颜色和焦点管理，键盘通道（menu-keyboard）也直接继承。
  function openBatchMenu(button, kind) {
    const indexes = selectedChapterIndexes();
    if (!indexes.length) return;
    state.batchMenu = true;
    const rect = button.getBoundingClientRect();
    showContextMenu({ clientX: rect.left, clientY: rect.top - 6 }, indexes[0]);
    if (kind === 'move') openVolumeChooserInMenu(-1);
  }

  function setupChapterBatchBar() {
    const bar = $('chapter-batch-bar');
    if (!bar) return;
    bar.addEventListener('click', (event) => {
      const btn = event.target.closest('button[id^="btn-batch-"]');
      if (!btn) return;
      if (btn.id === 'btn-batch-clear') {
        clearChapterSelection();
        return;
      }
      if (btn.id === 'btn-batch-copy') {
        void copySelectedChapters();
        return;
      }
      if (btn.id === 'btn-batch-export') {
        exportSelectedChapters();
        return;
      }
      if (btn.id === 'btn-batch-status') {
        openBatchMenu(btn, 'status');
        return;
      }
      if (btn.id === 'btn-batch-move') {
        openBatchMenu(btn, 'move');
        return;
      }
      if (btn.id === 'btn-batch-delete') void deleteSelectedChapters();
    });
  }

  function volumeList() {
    return state.meta && Array.isArray(state.meta.volumes) ? state.meta.volumes : [];
  }

  function volumeById(volumeId) {
    return volumeList().find((v) => v.id === volumeId) || null;
  }

  function volumeDisplayName(volumeId) {
    if (!volumeId) return '未分卷';
    const volume = volumeById(volumeId);
    return (volume && String(volume.name || '').trim()) || '未命名卷';
  }

  function chapterVolumeId(chapter) {
    // 1.5.0 P0-1（审计 E1 / A2）：章→卷只认 core/chapters.js 的 chapterVolumeKey 一份实现。
    // 指向已删除卷的章按「未分卷」算，和目录分组 / 卷内章号 / 折叠同一口径；
    // 对外仍保持 null = 未分卷（测试钩子 / 拖拽排序按 null 比对）。
    return chaptersLib.chapterVolumeKey(state.meta, chapter) || null;
  }

  function toggleVolumeCollapse(volumeId) {
    // 筛选时所有卷强制展开（命中结果要一眼看得见）：卷头点击先不接，
    // 免得留下一个看不见的折叠状态，清空筛选后才突然生效。
    if (chapterFilterActive()) return;
    const key = volumeId || '';
    if (state.collapsedVolumes.has(key)) state.collapsedVolumes.delete(key);
    else state.collapsedVolumes.add(key);
    renderChapterList({ keepScroll: true });
  }

  // 卷头（吸顶）：左侧折叠箭头 + 宋体卷名；右侧「6 章 · 1.1万字」。
  // 只加显示节点，折叠 / 右键 / 键盘仍在同一行上；E2E 与对比度脚本读的
  // .volume-item / .volume-name / .volume-count 都还在。
  function makeVolumeHeader(volumeId, name, count, chars, totalCount, totalChars) {
    const key = volumeId || '';
    const collapsed = state.collapsedVolumes.has(key);
    const filtering = chapterFilterActive();
    const allCount = Number.isFinite(totalCount) ? totalCount : count;
    const allChars = Number.isFinite(totalChars) ? totalChars : chars;
    const row = document.createElement('div');
    row.className = 'volume-item' + (collapsed ? ' collapsed' : '') + (volumeId ? '' : ' orphan-volume');
    row.dataset.volumeId = key;
    const arrow = document.createElement('span');
    arrow.className = 'volume-arrow';
    arrow.textContent = collapsed ? '▸' : '▾';
    const label = document.createElement('span');
    label.className = 'volume-name';
    label.textContent = name;
    const meta = document.createElement('span');
    meta.className = 'volume-meta';
    const num = document.createElement('span');
    num.className = 'volume-count';
    if (filtering) {
      // 筛选时不能把「整卷合计」静默换成「命中合计」：写清楚两个数，扫读时不会以为内容丢了
      num.textContent = `命中 ${count} / 共 ${allCount} 章`;
      meta.title =
        `筛选命中 ${count} 章（本卷共 ${allCount} 章）` +
        (chars > 0 ? `；命中 ${formatCount(chars)} 字` : '') +
        (allChars > 0 ? `，整卷 ${formatCount(allChars)} 字` : '');
    } else {
      num.textContent = `${count} 章`;
      meta.title = '卷内章数与字数（按上次保存的字数统计）';
    }
    meta.appendChild(num);
    if (!filtering && chars > 0) {
      const sep = document.createElement('span');
      sep.className = 'volume-meta-sep';
      sep.setAttribute('aria-hidden', 'true');
      sep.textContent = '·';
      const charsEl = document.createElement('span');
      charsEl.className = 'volume-chars';
      charsEl.textContent = formatCharsLabel(chars);
      meta.appendChild(sep);
      meta.appendChild(charsEl);
    }
    row.appendChild(arrow);
    row.appendChild(label);
    row.appendChild(meta);
    // RSHE-B-06：筛选时卷头只作分组标签（折叠加开被强制、箭头收起），提示语同步收口，
    // 不能再承诺「单击折叠 / 展开」；右键菜单仍可用（筛选不影响重命名 / 删除卷）。
    row.title = filtering
      ? '筛选中：卷头只作分组标签；右键更多（重命名卷 / 在此卷新建章节 / 删除卷）'
      : '单击折叠 / 展开；右键更多（重命名卷 / 在此卷新建章节 / 删除卷）';
    row.addEventListener('click', () => toggleVolumeCollapse(volumeId));
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showVolumeMenu(event, volumeId);
    });
    return row;
  }

  // 章节条目的 tooltip / 字数节点（B5 保存后只更新这一条时复用，和整表重建保持同一套口径）
  function chapterItemTip(chapter, index) {
    const status = chapterStatus(chapter);
    const note = chapterNote(chapter);
    const chars = chapterCharsOf(chapter);
    const previousChars = index > 0 ? chapterCharsOf(state.chapters[index - 1]) : null;
    const comparison = chars != null ? editorLogic.compareChapterChars(chars, previousChars) : null;
    return [
      `状态：${CHAPTER_STATUS_LABELS[status]}`,
      note ? `备注：${note}` : '',
      chars != null ? `本章 ${formatCount(chars)} 字` : '',
      comparison && comparison.direction === 'shorter' ? comparison.message : ''
    ]
      .filter(Boolean)
      .join('\n');
  }

  function chapterItemTitleText(chapter, index) {
    // 第一行就是完整章名：250px 下章名会省略号，悬停 / 长按先看到全名，再看能做什么
    return [
      chapterTitle(index, chapter.name),
      '单击切换；双击重命名；右键更多',
      chapterItemTip(chapter, index)
    ]
      .filter(Boolean)
      .join('\n');
  }

  // ---------- 章节多选（1.5.0 功能-1）----------
  // 选择模型（四种点法 / anchor 失效回落 / 按目录顺序取已选）全在 renderer/chapter-selection.js，
  // 这里只做三件事：把 state 里的 Set 交给纯函数算新值、把结果同步到 DOM（高亮 + 批量条）、
  // 以及批量动作（删除 / 移到卷 / 改状态 / 导出 / 复制）。红线：多选只记内存，不写书目 / 配置 / 跨书。
  function chapterSelectionSnapshot() {
    return { ids: state.selectedIds, anchorId: state.selectAnchorId };
  }

  function chapterIdAt(index) {
    const chapter = state.chapters[index];
    return chapter && chapter.id != null ? String(chapter.id) : '';
  }

  function currentChapterId() {
    return chapterIdAt(state.index);
  }

  function chapterIdsInBookOrder() {
    return state.chapters.map((chapter) => (chapter && chapter.id != null ? String(chapter.id) : ''));
  }

  // 当前**渲染出来**的章节 id（按 DOM 顺序）：筛选 / 折叠后只含看得见的行。
  // Ctrl+A 与 Shift+↑/↓ 用它当 order —— 键盘只作用于看得见的章，不偷选隐藏的；
  // 按下标取 dataset.chapterId（筛选后 DOM 位置 ≠ 书内下标）。
  function renderedChapterIds() {
    const list = $('chapter-list');
    if (!list) return [];
    return Array.from(list.querySelectorAll('.chapter-item')).map((row) =>
      row.dataset ? String(row.dataset.chapterId || '') : ''
    );
  }

  // 已选章节的**书内下标**（按目录顺序）：批量删除 / 移动 / 改状态 / 导出 / 复制都从这里取，
  // 作者怎么点的都不影响执行顺序。
  function selectedChapterIndexes() {
    if (!state.selectedIds.size) return [];
    const indexes = [];
    state.chapters.forEach((chapter, index) => {
      if (chapter && chapter.id != null && state.selectedIds.has(String(chapter.id))) indexes.push(index);
    });
    return indexes;
  }

  function syncChapterBatchBar() {
    const count = state.selectedIds.size;
    const bar = $('chapter-batch-bar');
    if (bar) bar.classList.toggle('hidden', count === 0);
    const countEl = $('chapter-batch-count');
    if (countEl) countEl.textContent = `已选 ${count} 章`;
  }

  // 选择变化时只改条目上的两个标记（class + aria-pressed），不重建整张列表：
  // 千章书里 Ctrl+点一下不会让滚动位置跳走，也不会把当前章那一条重新滚进视口。
  // X2（v1.8.0 WP-41）：条目是 role=button，button 角色不支持 aria-selected；多选态改用
  // aria-pressed（切换按钮的「按下 / 未按下」），读屏能播报「已选中」。
  function syncChapterSelectionUi() {
    const list = $('chapter-list');
    if (list) {
      for (const item of list.querySelectorAll('.chapter-item')) {
        const id = item.dataset ? String(item.dataset.chapterId || '') : '';
        const on = id !== '' && state.selectedIds.has(id);
        item.classList.toggle('selected', on);
        item.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }
    syncChapterBatchBar();
  }

  function setChapterSelection(next) {
    state.selectedIds = next.ids;
    state.selectAnchorId = next.anchorId;
    syncChapterSelectionUi();
  }

  // 返回是否真的清了（用来避免每次点空白都白跑一遍 DOM）
  function clearChapterSelection() {
    if (!state.selectedIds.size && state.selectAnchorId === null) return false;
    state.selectedIds = new Set();
    state.selectAnchorId = null;
    syncChapterSelectionUi();
    return true;
  }

  // 章节数组换了（删章 / 换书 / 保存后重建）以后收口：已不存在的 id / anchor 丢掉。
  // 在 renderChapterList 建表**之前**跑，保证列表里不会出现一条指向已删章的高亮。
  function pruneChapterSelection() {
    const pruned = chapterSelectionLib.prune(chapterSelectionSnapshot(), chapterIdsInBookOrder());
    if (pruned.ids.size !== state.selectedIds.size || pruned.anchorId !== state.selectAnchorId) {
      state.selectedIds = pruned.ids;
      state.selectAnchorId = pruned.anchorId;
    }
  }

  // 右键 / ⋯ 落在未选中的章上：先把它切成单选（与资源管理器一致），再弹菜单。
  function ensureChapterSelected(index) {
    const id = chapterIdAt(index);
    if (!id) return;
    if (state.selectedIds.has(id)) return;
    setChapterSelection({ ids: new Set([id]), anchorId: id });
  }

  function makeChapterItem(chapter, index) {
    const status = chapterStatus(chapter);
    const note = chapterNote(chapter);
    const chars = chapterCharsOf(chapter);
    const label = chapterListLabel(index, chapter.name);
    const item = document.createElement('div');
    item.className = `chapter-item status-${status}` + (index === state.index ? ' active' : '');
    if (chapterSelectionLib.isSelected(chapterSelectionSnapshot(), chapter.id)) item.classList.add('selected');
    if (index === state.index && state.dirty) item.classList.add('dirty');
    item.dataset.index = String(index);
    item.dataset.status = status;
    // 章节 id（v0.9 A-2）：切章只挪高亮、不重建列表时用它核对「列表还是不是这份章节数组」
    item.dataset.chapterId = String(chapter.id == null ? '' : chapter.id);
    item.dataset.title = chapterTitle(index, chapter.name);
    item.title = chapterItemTitleText(chapter, index);
    // 键盘可达（v0.9 A-5b）：章节条目本身可 Tab 到、Enter / 空格切章；整张列表只有当前章
    // 是 Tab 停留点（roving tabindex），方向键在列表内移焦点——1000 章不会变成 1000 个 Tab 站。
    item.tabIndex = index === state.index ? 0 : -1;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', `打开${chapterTitle(index, chapter.name)}`);
    // 多选是另一套标记（不和 .active 当前章互覆盖）：1.5.0 功能-1。
    // X2（v1.8.0 WP-41）：多选态用 aria-pressed —— button 角色不支持 aria-selected，
    // 切换按钮的「按下」正好表达「已选中」，读屏才播报得出来。
    item.setAttribute(
      'aria-pressed',
      chapterSelectionLib.isSelected(chapterSelectionSnapshot(), chapter.id) ? 'true' : 'false'
    );

    const dot = document.createElement('span');
    dot.className = 'chapter-status-dot';
    dot.title = `状态：${CHAPTER_STATUS_LABELS[status]}（右键可改）`;

    const num = document.createElement('span');
    num.className = 'chapter-num';
    num.textContent = label.num;
    // 视觉上只露纯章号（9 / 18）；完整「第N章：」文本留在 DOM 里（标题统一测试 / 读屏）。
    // 按卷编号时这里是卷内章号，和标题 / 导出 / 状态栏同一份 chaptersLib.chapterNumber。
    num.dataset.num = label.num ? String(chaptersLib.chapterNumber(state.meta, index)) : '';

    const name = document.createElement('span');
    name.className = 'chapter-name';
    if (chapterFilterActive()) appendChapterName(name, label.name, chapterFilterQuery());
    else name.textContent = label.name;

    item.appendChild(dot);
    item.appendChild(num);
    item.appendChild(name);
    if (note) {
      const noteMark = document.createElement('span');
      noteMark.className = 'chapter-note-mark';
      noteMark.textContent = '✎';
      noteMark.title = `备注：${note}`;
      item.appendChild(noteMark);
    }
    // 章节列表每项显示字数（书目缓存，紧凑显示）；保存后自动更新
    if (chars != null) {
      const charsEl = document.createElement('span');
      charsEl.className = 'chapter-chars';
      charsEl.textContent = editorLogic.formatCharsShort(chars);
      charsEl.title = `本章 ${formatCount(chars)} 字（书目缓存；保存后更新）`;
      item.appendChild(charsEl);
    }
    // 行尾「⋯」更多：只服务鼠标（悬停出现，24×24），打开的是同一张右键菜单；
    // 键盘用户仍走 Shift+F10 / 右键键，所以它不进 Tab 序（tabIndex -1、aria-hidden）。
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'chapter-more';
    more.tabIndex = -1;
    more.setAttribute('aria-hidden', 'true');
    more.title = '更多：双击重命名；右键菜单（标记状态 / 备注 / 移到卷 / 删除）';
    more.textContent = '⋯';
    item.appendChild(more);
    // 1.5.0 P0-2（审计 P1）：条目不再逐条绑 6 个监听 —— 点击 / 双击 / 右键 / pointerdown
    // 全部由 #chapter-list 容器委托（setupChapterListEvents）按 dataset.index 分派。
    // roving tabindex / aria-label / ⋯ 按钮 / 右键菜单 / suppressChapterClick 逐项保持原行为。
    return item;
  }

  // RSHE-B-03（第五轮审计）：可选 { keepScroll }。折叠 / 展开只影响显隐，不改变「当前章」，
  // 旧实现复用整表重建后又无条件 scrollIntoView(当前章) —— 用户滚到离当前章很远处折叠一卷，
  // 视口会被拉回当前章、浏览位置丢失。传 keepScroll 时重建后恢复原 scrollTop（夹到新范围）。
  function renderChapterList(options = {}) {
    const keepScroll = Boolean(options && options.keepScroll);
    markCommandsDirty(); // 章节列表是命令面板「章节」条目的源：这里一变就作废缓存（1.5.0 P0-6）
    // 1.5.0 功能-1：建表前先把多选收口 —— 已删的章 / 换了书以后，选中集合里不能留下幽灵 id。
    pruneChapterSelection();
    const list = $('chapter-list');
    const scrollTopBefore = keepScroll && list ? Number(list.scrollTop) || 0 : 0;
    // 先离线拼好整条列表，再一次性挂上去：千章书一次重建 1000 条时，逐条 appendChild
    // 会让容器反复失效（实测能省掉几毫秒）；配合 CSS 的 content-visibility，屏幕外的
    // 条目连布局都跳过。
    const frag = document.createDocumentFragment();
    const volumes = volumeList();
    const query = chapterFilterQuery();
    const filtering = query !== '';
    // 筛选只影响「显示哪些章」：折叠状态在筛选时全部展开（要先看见命中结果），
    // 命中为 0 时给一条筛选空态（与书架 / 查找同一套三件套文案口径）。
    const matched = matchingChapterIndexes();
    const matchedSet = new Set(matched);
    // 1.3.0 T4（规范 I-06）：章节栏真空（0 章）。正常新建 / 删到空都会自动补一章，这里兜的是
    // 手改书目 / 从外部导入的书；只有「真空」一种状态（打开书是一次性读盘，没有加载中 / 筛选空）。
    // 文案按三件套写：说明状态 + 学习线索（章节模板）+ 直接路径（现有按钮 / Ctrl+N），不加新按钮。
    if (!state.chapters.length) {
      const empty = document.createElement('div');
      empty.className = 'chapter-list-empty muted small';
      empty.dataset.emptyKind = 'vacuum';
      empty.textContent =
        '这本书还没有章节。点左下「＋ 新建章节」或按 Ctrl+N 开始写第一章；' +
        '新章会自动套用设置里的章节模板（填了才生效）。';
      frag.appendChild(empty);
    } else if (filtering && !matched.length) {
      const empty = document.createElement('div');
      empty.className = 'chapter-list-empty muted small';
      empty.dataset.emptyKind = 'filtered';
      empty.textContent =
        `没有匹配「${query}」的章节。\n换个关键词，或按 Esc 清空筛选。`;
      frag.appendChild(empty);
    } else if (!volumes.length) {
      // 没分卷的书：平铺章节（筛选时只留命中的那几条）
      state.chapters.forEach((chapter, index) => {
        if (filtering && !matchedSet.has(index)) return;
        frag.appendChild(makeChapterItem(chapter, index));
      });
    } else {
      const buckets = new Map(volumes.map((v) => [v.id, []]));
      const totals = new Map(volumes.map((v) => [v.id, []]));
      const orphans = [];
      const totalOrphans = [];
      state.chapters.forEach((chapter, index) => {
        // 先记整卷合计（筛选时卷头要同时显示「命中 N / 共 M 章」，不能只剩命中数）
        const volumeId = chapterVolumeId(chapter);
        if (volumeId && totals.has(volumeId)) totals.get(volumeId).push(index);
        else totalOrphans.push(index);
        if (filtering && !matchedSet.has(index)) return;
        if (volumeId && buckets.has(volumeId)) buckets.get(volumeId).push({ chapter, index });
        else orphans.push({ chapter, index });
      });
      const charsOfItems = (items) =>
        chapterCharsTotal(items.map((item) => item.index)).total;
      if (orphans.length) {
        frag.appendChild(
          makeVolumeHeader(
            null,
            '未分卷',
            orphans.length,
            charsOfItems(orphans),
            totalOrphans.length,
            chapterCharsTotal(totalOrphans).total
          )
        );
        if (filtering || !state.collapsedVolumes.has('')) {
          orphans.forEach(({ chapter, index }) => frag.appendChild(makeChapterItem(chapter, index)));
        }
      }
      for (const volume of volumes) {
        const items = buckets.get(volume.id) || [];
        // 筛选时整卷没有命中的卷头不占位置；不筛选时空卷也要留着（新建的卷要在侧栏里看得见）
        if (filtering && !items.length) continue;
        const all = totals.get(volume.id) || [];
        frag.appendChild(
          makeVolumeHeader(
            volume.id,
            volumeDisplayName(volume.id),
            items.length,
            charsOfItems(items),
            all.length,
            chapterCharsTotal(all).total
          )
        );
        if (filtering || !state.collapsedVolumes.has(volume.id)) {
          items.forEach(({ chapter, index }) => frag.appendChild(makeChapterItem(chapter, index)));
        }
      }
    }
    list.replaceChildren(frag);
    // 1.6.0 A5/P-09：整表重建后重算「当前章条目」缓存（旧条目已掉出文档，不能再给它挂 dirty）
    setCachedActiveChapterItem(list.querySelector('.chapter-item.active'));
    // 筛选时卷头只作分组标签（折叠箭头收起、不接点击）：见 toggleVolumeCollapse
    list.classList.toggle('filtering', filtering);
    syncCurrentVolumeMarker();
    // 当前章在折叠的卷里时列表里一条 tabIndex 0 都没有：给第一个条目补一个 Tab 停留点
    listKeyboard.ensureTabStop(list, '.chapter-item');
    if (filtering) {
      // 筛选结果从第一条读起：不把当前章滚到底部，免得用户输一个词只看得到最后一条
      list.scrollTop = 0;
    } else if (keepScroll) {
      // RSHE-B-03：折叠 / 展开后保持浏览位置；行数变少时夹到新的可滚动范围，别停在越界空白。
      let restored = scrollTopBefore;
      const max = Number(list.scrollHeight) - Number(list.clientHeight);
      if (Number.isFinite(max) && max >= 0) restored = Math.min(restored, max);
      list.scrollTop = restored;
    } else {
      const active = getCachedActiveChapterItem();
      if (active) active.scrollIntoView({ block: 'nearest' });
    }
    syncChapterFilterUi();
    syncChapterBatchBar();
    // 命中已由上面算过，直接传给概览行（RSHE-B-04：不再重跑一遍全表匹配）。
    renderBookMeta(matched.length);
    renderVolumeToggle();
    updateCurrentChapterPill();
  }

    return {
      chapterFilterQuery,
      chapterFilterActive,
      chapterIndexMatchesFilter,
      matchingChapterIndexes,
      chapterCharsTotal,
      formatCharsLabel,
      renderBookMeta,
      syncChapterFilterUi,
      cancelScheduledChapterFilter,
      scheduleChapterFilterRender,
      setChapterFilter,
      appendChapterName,
      volumeGroupKeys,
      renderVolumeToggle,
      toggleAllVolumes,
      activeChapterItem,
      syncCurrentVolumeMarker,
      currentChapterGroupKey,
      updateCurrentChapterPill,
      scrollToCurrentChapter,
      setupChapterDirectory,
      chapterItemAt,
      chapterMoreAt,
      setupChapterListEvents,
      openBatchMenu,
      setupChapterBatchBar,
      volumeList,
      volumeById,
      volumeDisplayName,
      chapterVolumeId,
      toggleVolumeCollapse,
      makeVolumeHeader,
      chapterItemTip,
      chapterItemTitleText,
      chapterSelectionSnapshot,
      chapterIdAt,
      currentChapterId,
      chapterIdsInBookOrder,
      renderedChapterIds,
      selectedChapterIndexes,
      syncChapterBatchBar,
      syncChapterSelectionUi,
      setChapterSelection,
      clearChapterSelection,
      pruneChapterSelection,
      ensureChapterSelected,
      makeChapterItem,
      renderChapterList
    };
  }

  return { create: createChapterDirectoryUi, REQUIRED_HOST };
});
