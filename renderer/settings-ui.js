/* 设置（第 4 步 renderer 九刀·第七刀：从 renderer.js 的「设置」分区整段搬出来）。
 *
 * 搬走的段（原 renderer.js 4303–4786，484 行）—— 设置弹层（全局默认 / 按书显示设置两种作用域）：
 *   作用域判定与各分区显隐（settingsScopeForView / updateSettingsScopeUi）、表单回填与预览
 *   （fillSettingsFields / renderSettingsCaretColors / renderChapterTemplatePreview / previewSettings）、
 *   打开 / 关闭 / 保存 / 恢复全局默认（openSettings / closeSettings / saveSettings / resetBookDisplay）、
 *   状态栏「今日字数」→ 码字日历入口（openStatsCalendar：全局作用域 + 定位到日历；v0.13 U-D4）、
 *   数据台账子区（敏感词表 / 校对词表 / 诊断日志 / 检查更新 / 版本显示：renderSensitiveSettings /
 *   refreshSensitiveSettingsInfo / renderProofreadSettings / refreshProofreadSettingsInfo / renderLogSettings /
 *   refreshLogInfo / formatUpdateDate / renderUpdateSettings / checkUpdate / openUpdateDownload）、
 *   两个纯表单读取（readSnapshotForm / readStatsForm）。
 * **只搬不改行为**：文案 / class / DOM 结构 / 返回结构 / 两种作用域的分支 / 保存失败兜底 / 词表只读状态全一字未改。
 * 事件绑定随域搬进 setupSettingsUi()（设置 3 个按钮 + 章节模板预览 + 重置本书显示 + 选目录 + 词表/日志/更新 +
 *   自定义字体 + 显示项实时预览/高亮色板；写作计时与日历的绑定不属设置域，留在 renderer）。
 *
 * 契约：createSettingsUi(host) 由渲染层调用一次。host 9 个成员（含 3 个语义分组，分组内每个真实依赖都列在这里）：
 *   host = {
 *     $, state, api, call, toast,          // 基础 5：DOM 查询 / 共享状态（config、bookDisplay、settings* 草稿）/ IPC 白名单 / IPC 包装 / 提示
 *     chaptersLib,                         // core/chapters.js：章→卷判定（chapterVolumeKey，1.5.0 P0-1 起唯一一份）
 *     display: {                            // 显示层与显示设置表单
 *       applyEditorStyle,                   //   把生效显示配置写到 CSS 变量 / body class
 *       syncCaretParagraphFromConfig,       //   当前段落高亮开关 / 颜色同步到显示层
 *       effectiveConfig,                    //   生效配置 = 全局设置 + 当前书覆盖
 *       applySidebarWidth,                  //   章节栏宽度写到 CSS 变量
 *       loadCustomFont,                     //   自定义字体（FontFace 注册，主进程读文件）
 *       readDisplayForm,                    //   从设置表单读显示项（排版域提供，唯一一份）
 *       displaySettingsIds,                 //   显示项输入框 id 列表（实时预览循环用）
 *       caretColorLib,                      //   core/caret-color.js：高亮颜色清洗 / 色板预设
 *       s2tLib,                             //   core/s2t.js：导出简繁档位清洗
 *       templateLib,                        //   core/template.js：章节模板清洗 / 预览展开
 *       editorLogic                         //   renderer/editor-logic.js：超长段落阈值的夹紧口径
 *       applyChapterNumbering,              //   章节编号显示项（渲染层同一份）：host.display 也校验它
 *     },
 *     peers: {                              // 其它域模块 / 跨域动作
 *       stats: { refreshStats, renderStatsChart },                 // 统计域
 *       writeTimer: { renderDurationSettings, renderWriteTimer, applyWriteTimerConfig, writeDurationEnabled, flushWriteTimer }, // 写作时长域
 *       editor: { renderEditorMarks, renderMarksMenu },            // 编辑器小件域
 *       words: { refreshSensitiveWordList, refreshProofreadWordList, sensitiveWordListText, proofreadWordListText, pickSensitiveWords, pickProofreadWords }, // 敏感词 / 校对域
 *       refreshShelf                        // 保存后刷新书架
 *     },
 *     texts: { commonLib, formatBytes }    // 共享纯格式化：commonLib = core/common.js（pad2 = commonLib.pad2）/ formatBytes（日志体积文案）
 *   }
 * 缺任何一个（含分组内成员）直接抛 TypeError。分组在 create 时一次解构，行为等价。
 *
 * 1.4.0 P0-1 补一句话：设置面板的「5 个分区 / 顶部搜索 / 深链切分区」纯逻辑在
 * renderer/settings-ia.js，由渲染层通过可选的 host.ia 传入（不在 REQUIRED_HOST 里）。
 * 不传时（老单测的假 host）退化成原来的「一长条设置」，行为一个字不变。
 * create() 不注册事件、不建定时器、不碰 DOM；事件绑定在 setupSettingsUi()，由 bindEvents() 在
 * 原设置块的位置调用一次（渲染层里写作计时 / 日历的绑定位置不变）。
 *
 * 刻意不搬（留在 renderer.js）：写作计时 / 码字日历的绑定、排版域、测试钩子宿主契约（按名字取本模块入口）。
 *
 * 浏览器里挂成全局 CWSettingsUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWSettingsUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HOST = ['$', 'state', 'api', 'call', 'toast', 'display', 'peers', 'texts', 'chaptersLib'];

  // 1.4.0 P0-1：设置面板信息架构（分区 / 搜索 / 深链）的纯逻辑在 renderer/settings-ia.js，
  // 由渲染层通过 host.ia 传进来（正式路径 window.CWSettingsIa）。它**不在 REQUIRED_HOST 里**：
  // 老单测的假 host 不传，本模块就退回原来的一长条设置，行为一个字不变。
  function resolveSettingsIa(host) {
    if (host && host.ia && typeof host.ia.planSearch === 'function') return host.ia;
    return null;
  }

  function createSettingsUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createSettingsUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) throw new TypeError('createSettingsUi 的 host 缺少 ' + key);
    }
    const { $, state, api, call, toast, display, peers, texts, chaptersLib } = host;
    if (typeof display !== 'object') throw new TypeError('createSettingsUi 的 host.display 必须是对象');
    for (const key of ['applyEditorStyle', 'syncCaretParagraphFromConfig', 'effectiveConfig', 'applySidebarWidth', 'loadCustomFont', 'readDisplayForm', 'displaySettingsIds', 'caretColorLib', 's2tLib', 'templateLib', 'editorLogic', 'applyChapterNumbering']) {
      if (display[key] === undefined || display[key] === null) throw new TypeError('createSettingsUi 的 host.display 缺少 ' + key);
    }
    if (typeof peers !== 'object') throw new TypeError('createSettingsUi 的 host.peers 必须是对象');
    for (const group of ['stats', 'writeTimer', 'editor', 'words']) {
      if (typeof peers[group] !== 'object' || peers[group] === null) throw new TypeError('createSettingsUi 的 host.peers.' + group + ' 必须是对象');
    }
    for (const key of ['refreshStats', 'renderStatsChart']) {
      if (peers.stats[key] === undefined || peers.stats[key] === null) throw new TypeError('createSettingsUi 的 host.peers.stats 缺少 ' + key);
    }
    for (const key of ['renderDurationSettings', 'renderWriteTimer', 'applyWriteTimerConfig', 'writeDurationEnabled', 'flushWriteTimer']) {
      if (peers.writeTimer[key] === undefined || peers.writeTimer[key] === null) throw new TypeError('createSettingsUi 的 host.peers.writeTimer 缺少 ' + key);
    }
    for (const key of ['renderEditorMarks', 'renderMarksMenu']) {
      if (peers.editor[key] === undefined || peers.editor[key] === null) throw new TypeError('createSettingsUi 的 host.peers.editor 缺少 ' + key);
    }
    for (const key of ['refreshSensitiveWordList', 'refreshProofreadWordList', 'sensitiveWordListText', 'proofreadWordListText', 'pickSensitiveWords', 'pickProofreadWords']) {
      if (peers.words[key] === undefined || peers.words[key] === null) throw new TypeError('createSettingsUi 的 host.peers.words 缺少 ' + key);
    }
    if (peers.refreshShelf === undefined || peers.refreshShelf === null) throw new TypeError('createSettingsUi 的 host.peers 缺少 refreshShelf');
    if (typeof texts !== 'object') throw new TypeError('createSettingsUi 的 host.texts 必须是对象');
    for (const key of ['commonLib', 'formatBytes']) {
      if (texts[key] === undefined || texts[key] === null) throw new TypeError('createSettingsUi 的 host.texts 缺少 ' + key);
    }
    const { applyEditorStyle, syncCaretParagraphFromConfig, effectiveConfig, applySidebarWidth, loadCustomFont, readDisplayForm, displaySettingsIds, caretColorLib, s2tLib, templateLib, editorLogic, applyChapterNumbering } = display;
    const { refreshStats, renderStatsChart } = peers.stats;
    const { renderDurationSettings, renderWriteTimer, applyWriteTimerConfig, writeDurationEnabled, flushWriteTimer } = peers.writeTimer;
    const { renderEditorMarks, renderMarksMenu } = peers.editor;
    const { refreshSensitiveWordList, refreshProofreadWordList, sensitiveWordListText, proofreadWordListText, pickSensitiveWords, pickProofreadWords } = peers.words;
    const { refreshShelf } = peers;
    const { commonLib, formatBytes } = texts;
    const pad2 = commonLib.pad2;

  // ---------- 设置面板信息架构（1.4.0 P0-1：左导航 / 顶部搜索 / 深链） ----------
  // ia 是纯逻辑模块（见文件头）；拿不到时下面每个函数都直接 return，界面就退回原来的一长条。
  const ia = resolveSettingsIa(host);
  const DEFAULT_SETTINGS_TAB = ia ? ia.DEFAULT_TAB : 'display';
  // 当前分区只存在内存里（不写 config、不进保存 payload）；每次打开设置回到默认分区。
  let settingsActiveTab = DEFAULT_SETTINGS_TAB;

  function settingsTabNodes() {
    const nav = $('settings-nav');
    if (!nav || typeof nav.querySelectorAll !== 'function') return [];
    return Array.from(nav.querySelectorAll('[data-settings-tab]'));
  }

  function settingsSectionNode(tab) {
    return $('settings-section-' + tab);
  }

  // 只切分区显隐：字段自己的 .hidden（作用域逐项隐藏）一律不碰，两条显隐互不覆盖。
  function applySettingsTabs() {
    if (!ia) return;
    const allowed = ia.sectionsForScope(state.settingsScope);
    const active = ia.resolveTab(state.settingsScope, settingsActiveTab);
    settingsActiveTab = active;
    for (const node of settingsTabNodes()) {
      const tab = node.dataset ? node.dataset.settingsTab : '';
      const usable = allowed.indexOf(tab) >= 0;
      node.classList.toggle('hidden', !usable);
      const selected = usable && tab === active;
      node.setAttribute('aria-selected', selected ? 'true' : 'false');
      node.setAttribute('tabindex', selected ? '0' : '-1');
    }
    for (const tab of ia.TAB_IDS) {
      const section = settingsSectionNode(tab);
      if (section) section.hidden = tab !== active;
    }
    const scroller = $('settings-scroll');
    if (scroller) scroller.scrollTop = 0;
  }

  function setSettingsTab(tab, options = {}) {
    if (!ia) return settingsActiveTab;
    settingsActiveTab = ia.resolveTab(state.settingsScope, tab);
    applySettingsTabs();
    if (options.focus) {
      const node = $('settings-tab-' + settingsActiveTab);
      if (node && typeof node.focus === 'function') node.focus();
    }
    return settingsActiveTab;
  }

  // 搜索时把「分区里的每个顶层块」当成一行：field-group 标题算分组，其余都算行。
  // 行的文本用 textContent（label + 说明文字一起匹配），分组标题用于「命中整组」。
  function settingsSearchUnits() {
    const units = [];
    if (!ia) return units;
    for (const tab of ia.TAB_IDS) {
      const section = settingsSectionNode(tab);
      if (!section || !section.children) continue;
      let groupId = tab + ':0';
      let groupIndex = 0;
      let rowIndex = 0;
      for (const child of Array.from(section.children)) {
        if (!child) continue;
        const isGroup = Boolean(child.classList && child.classList.contains('field-group'));
        if (isGroup) {
          groupIndex += 1;
          groupId = tab + ':' + groupIndex;
          units.push({ id: tab + ':g' + groupIndex, kind: 'group', groupId, text: child.textContent || '', section: tab, el: child });
        } else {
          rowIndex += 1;
          units.push({ id: tab + ':r' + groupIndex + ':' + rowIndex, kind: 'row', groupId, text: child.textContent || '', section: tab, el: child });
        }
      }
    }
    return units;
  }

  function settingsSearchInput() {
    return $('settings-search');
  }

  // 清空搜索并把分区恢复成「只显示当前分区」
  function resetSettingsSearch() {
    const input = settingsSearchInput();
    if (input) input.value = '';
    applySettingsSearch();
  }

  function applySettingsSearch() {
    if (!ia) return;
    const input = settingsSearchInput();
    const query = input ? String(input.value || '') : '';
    const units = settingsSearchUnits();
    const plan = ia.planSearch(query, units);
    const clearBtn = $('btn-settings-search-clear');
    if (clearBtn) clearBtn.classList.toggle('hidden', !plan.active);
    const emptyBox = $('settings-empty');
    if (emptyBox) emptyBox.classList.toggle('hidden', !plan.empty);
    const status = $('settings-search-status');
    if (status) status.textContent = ia.searchStatusText(plan);
    if (!plan.active) {
      for (const unit of units) if (unit.el && unit.el.classList) unit.el.classList.remove('search-hidden');
      applySettingsTabs();
      return;
    }
    const visible = {};
    for (const id of plan.visible) visible[id] = true;
    for (const unit of units) {
      if (!unit.el || !unit.el.classList) continue;
      unit.el.classList.toggle('search-hidden', visible[unit.id] !== true);
    }
    // 搜索是跨分区的：命中的分区都露出来（没命中的藏起来），避免「搜索命中却在别的分区里」
    const allowed = ia.sectionsForScope(state.settingsScope);
    for (const tab of ia.TAB_IDS) {
      const section = settingsSectionNode(tab);
      if (!section) continue;
      section.hidden = allowed.indexOf(tab) < 0 || plan.sections.indexOf(tab) < 0;
    }
    for (const node of settingsTabNodes()) {
      const tab = node.dataset ? node.dataset.settingsTab : '';
      node.classList.toggle('hidden', allowed.indexOf(tab) < 0);
      // 搜索结果不属于任何一个分区：搜索期间 nav 不保留选中态（都 aria-selected=false、
      // 不可 Tab），清空搜索后由 applySettingsTabs() 按当前分区恢复。
      node.setAttribute('aria-selected', 'false');
      node.setAttribute('tabindex', '-1');
    }
  }

  // ---------- 设置 ----------
  function setSelectValue(id, value, fallback) {
    const el = $(id);
    const wanted = String(value == null ? fallback : value);
    el.value = wanted;
    if (el.value !== wanted) el.value = String(fallback); // 值不在选项里时回到默认
  }

  // 正文宽度档位（1.3.0 T-06 / 规范 T-06）：通栏 / 720 / 800 / 840。
  // 840 ≈ 39.6 字，落回 clreq 推荐的 17–40 字；界面不再提供 900 / 1000（会到 43–48 字）。
  // 但**历史配置里可能还存着** 900 / 1000 这类值（config 的 clamp 仍是 600–1600，照常加载）：
  // 这类值用一个 hidden 的动态 option 原样显示 —— 不静默改成 840、也不把值丢掉；
  // 保存时读的就是表单里选中的值，所以旧值保存回去还是旧值。
  const PAGE_WIDTH_CHOICES = [0, 720, 800, 840];

  function setPageWidthValue(value) {
    const el = $('settings-page-width');
    if (!el) return;
    const width = Number(value);
    const wanted = Number.isFinite(width) && width > 0 ? String(Math.round(width)) : '0';
    // 上一次回填留下的历史值 option 先清掉（同一弹层换书 / 换配置反复回填时不堆积）
    for (const stale of Array.from(el.querySelectorAll('[data-page-width-history]'))) {
      if (stale && typeof stale.remove === 'function') stale.remove();
    }
    if (!PAGE_WIDTH_CHOICES.includes(Number(wanted))) {
      const option = document.createElement('option');
      option.value = wanted;
      option.textContent = `${wanted} px · 历史值（保留原值）`;
      option.hidden = true;
      option.dataset.pageWidthHistory = '1';
      el.appendChild(option);
    }
    el.value = wanted;
    if (el.value !== wanted) el.value = '0'; // 兜底：连动态 option 都加不上时按通栏，不留空白
  }

  function settingsScopeForView() {
    return state.view === 'editor' && state.bookId ? 'book' : 'global';
  }

  // 显式作用域（v0.13 U-D4）：状态栏「今日字数」在写作页里也要打开「全局设置」看码字日历。
  // 不传 / 认不出时仍按视图判定（书架 = 全局；写作页 = 按书），原有入口的行为一个都不变。
  function resolveSettingsScope(options) {
    const wanted = options && typeof options === 'object' ? options.scope : '';
    if (wanted === 'global') return 'global';
    if (wanted === 'book' && state.bookId) return 'book';
    return settingsScopeForView();
  }

  // 表单回填按作用域取配置：全局作用域只回填「全局默认」，不拿本书覆盖后的生效值。
  // 否则在写作页里打开全局设置会把本书的显示设置显示成全局默认，一保存就污染全局配置
  // （这是 D4 的配置语义风险点）。全局配置还没读到（首启 / 单测）时退回生效值兜底。
  function settingsBackfillConfig(scope) {
    if (scope === 'global') {
      return state.globalConfig && typeof state.globalConfig === 'object'
        ? state.globalConfig
        : state.config || {};
    }
    return state.config || {};
  }

  // 设置弹层里的分区锚点：码字日历是唯一需要「从入口直接定位过去」的分区（U-D4）。
  const SETTINGS_SECTIONS = { calendar: 'settings-calendar-field' };

  // 弹层打开后把某个分区滚进可视区（只滚设置弹层自己的 .settings-scroll；不写任何东西）。
  // 1.4.0 P0-1：先切到锚点所属分区（calendar → 写作）再滚；分区不在当前作用域
  //（例如按书设置里日历被隐藏）时不切也不滚，返回 false。
  function revealSettingsSection(section) {
    const link = ia ? ia.resolveDeepLink(section, state.settingsScope) : null;
    if (link && !link.available) return false;
    const id = link ? link.field : SETTINGS_SECTIONS[section];
    if (!id) return false;
    const field = $(id);
    if (!field) return false;
    if (field.classList && field.classList.contains('hidden')) return false;
    if (link && link.tab !== settingsActiveTab) {
      settingsActiveTab = link.tab;
      applySettingsTabs();
    }
    if (typeof field.scrollIntoView === 'function') {
      try {
        field.scrollIntoView({ block: 'center' });
      } catch {
        /* 老环境不认参数：不滚也不影响设置照常可用 */
      }
    }
    return true;
  }

  // 设置弹层里的高亮色板：当前草稿色打圈（'' = 跟随主题）；取色器只作为自定义入口。
  function renderSettingsCaretColors() {
    const row = $('settings-caret-colors');
    const value = caretColorLib.normalizeColor(state.settingsCaretColorDraft);
    if (row) {
      for (const btn of row.querySelectorAll('[data-settings-caret-color]')) {
        const swatch = caretColorLib.normalizeColor(btn.dataset.settingsCaretColor);
        const active = swatch === value;
        btn.dataset.active = active ? '1' : '0';
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        if (swatch) btn.style.setProperty('--swatch', swatch);
        else btn.style.removeProperty('--swatch');
      }
    }
    const picker = $('settings-caret-color');
    if (picker) picker.value = value || caretColorLib.PRESET_VALUES[0];
  }

  // 设置弹层里各输入框按给定配置回填
  function fillSettingsFields(cfg) {
    state.settingsFontDraft = {
      path: cfg.editorCustomFontPath || '',
      name: cfg.editorCustomFontName || ''
    };
    $('settings-root').value = cfg.booksRoot || '';
    setSelectValue('settings-font', cfg.editorFont, 'serif');
    if ($('settings-font').value === 'custom' && !state.settingsFontDraft.path) {
      $('settings-font').value = 'serif';
    }
    $('settings-font-name').value = state.settingsFontDraft.name || state.settingsFontDraft.path || '';
    setSelectValue('settings-size', cfg.editorFontSize, 18);
    setSelectValue('settings-line-height', cfg.editorLineHeight, 1.95);
    setSelectValue('settings-letter-spacing', cfg.editorLetterSpacing, 0.02);
    setSelectValue('settings-padding-x', cfg.editorPaddingX, 56);
    // 正文宽度（1.3.0 T-06）：通栏 / 720 / 800 / 840 四档；历史值 900 / 1000 用 hidden 动态 option 原样显示
    setPageWidthValue(cfg.editorPageWidth);
    // 中西文自动间距（1.3.0 T-08）：默认开，只有明确存过 false 的才是关（旧配置没有这个键 = 勾上）
    $('settings-text-autospace').checked = cfg.editorTextAutospace !== false;
    setSelectValue('settings-paper', cfg.editorPaper, 'paper');
    // 章号（2026-11-10）：按书存 书目.json，不在 config 里；默认连续
    const numberingSelect = $('settings-chapter-numbering');
    if (numberingSelect) {
      numberingSelect.value = state.meta && state.meta.chapterNumbering === 'volume' ? 'volume' : 'continuous';
    }
    // 当前段落高亮（N10b）：开关 / 颜色都是显示设置，写作页按书、书架按全局
    $('settings-caret-paragraph').checked = cfg.caretParagraph === true;
    state.settingsCaretColorDraft = caretColorLib.normalizeColor(cfg.caretParagraphColor);
    renderSettingsCaretColors();
    // 超长段落阈值（1.1.0）：回填生效值（按书 = 本书覆盖；全局 = 全局默认），坏值 / 缺字段按 500
    $('settings-long-para-threshold').value = String(editorLogic.sanitizeThreshold(cfg.longParagraphThreshold));
    $('settings-snapshot-enabled').checked = cfg.snapshotEnabled === true;
    setSelectValue('settings-snapshot-days', cfg.snapshotKeepDays, 7);
    const goal = Math.max(0, Math.round(Number(cfg.dailyGoal) || 0));
    $('settings-daily-goal').value = String(goal);
    // 写作时长：默认关，只认真正的 true（旧配置没有这个键 = 关）
    $('settings-write-duration').checked = cfg.writeDurationEnabled === true;
    // b8：剪贴板后台监听（全局设置，默认关；旧配置没有这个键 = 关）
    const clipboardWatch = $('settings-clipboard-watch');
    if (clipboardWatch) clipboardWatch.checked = cfg.clipboardWatchEnabled === true;
    renderDurationSettings();
    // 章节模板：全局设置，留空 = 不套用（旧配置没有这个键也回空）
    $('settings-chapter-template').value = templateLib.sanitizeTemplate(cfg.chapterTemplate);
    renderChapterTemplatePreview();
    // 导出简繁转换（全局设置）：旧配置没有这个键 = 不转换
    setSelectValue('settings-export-conversion', s2tLib.normalizeMode(cfg.exportConversion), '');
    // 敏感词表：只记路径，词表本身只读；具体状态在 openSettings 里异步读一次
    state.sensitiveWordsDraft = typeof cfg.sensitiveWordsPath === 'string' ? cfg.sensitiveWordsPath : '';
    state.sensitiveWordsInfo = null;
    renderSensitiveSettings();
    // 校对词表（可选）：同样只记路径，词表只读；具体状态在 openSettings 里异步读一次
    state.proofreadWordsDraft = typeof cfg.proofreadWordsPath === 'string' ? cfg.proofreadWordsPath : '';
    state.proofreadWordsInfo = null;
    renderProofreadSettings();
    renderStatsChart();
  }

  // 章节模板预览：按「下一个新章」的章号 / 示例章名 / 今天展开一次，让作者看清实际效果。
  // 只读草稿，不写配置；真正保存要点「保存设置」。
  function renderChapterTemplatePreview() {
    const el = $('settings-template-preview');
    if (!el) return;
    const template = $('settings-chapter-template').value;
    if (!templateLib.hasTemplate(template)) {
      el.textContent = '预览：（未设置模板，新建章节仍是空章）';
      return;
    }
    // 新章默认接在「当前章所在卷」的末尾：按卷编号时预览要算同卷章数 + 1，不是全书章数 + 1
    let nextNumber = 1;
    if (state.view === 'editor' && state.bookPath && state.chapters.length) {
      const meta = state.meta || {};
      // 1.5.0 P0-1（审计 E1 / A2）：章→卷统一用 core/chapters.js 的 chapterVolumeKey，
      // 指向已删除卷的章按未分卷算，和目录分组 / 卷内章号同一口径。
      const keyOf = (chapter) => chaptersLib.chapterVolumeKey(meta, chapter);
      if (meta.chapterNumbering === 'volume') {
        const current = state.chapters[state.index] || state.chapters[state.chapters.length - 1];
        const key = keyOf(current);
        nextNumber = state.chapters.filter((chapter) => keyOf(chapter) === key).length + 1;
      } else {
        nextNumber = state.chapters.length + 1;
      }
    }
    const text = templateLib.applyTemplate(template, {
      chapterNumber: nextNumber,
      chapterName: '示例章名',
      now: new Date()
    });
    el.textContent = `预览（第 ${nextNumber} 章）：\n${text}`;
  }

  // 设置弹层里的词表状态（未设置 / 词表 N 个词 / 文件不存在 / 编码异常都直说）
  function renderSensitiveSettings() {
    const pathEl = $('settings-sensitive-path');
    if (pathEl) pathEl.value = state.sensitiveWordsDraft || '';
    const status = $('settings-sensitive-status');
    if (!status) return;
    if (!state.sensitiveWordsDraft) {
      status.textContent = '未设置：预检前需要先选一个自己的词表 txt（应用不内置任何词表）';
      status.className = 'muted small';
      return;
    }
    const info = state.sensitiveWordsInfo;
    if (!info) {
      status.textContent = '正在读取词表…';
      status.className = 'muted small';
      return;
    }
    status.textContent = sensitiveWordListText(info);
    status.className = info.ok ? 'muted small' : 'muted small warn';
  }

  // 打开设置时按已保存的路径读一次词表状态（刚选的草稿直接用 pick 返回的信息，不重读）
  async function refreshSensitiveSettingsInfo() {
    if (!state.sensitiveWordsDraft) {
      state.sensitiveWordsInfo = null;
      renderSensitiveSettings();
      return null;
    }
    try {
      state.sensitiveWordsInfo = await call(api.sensitiveWordsInfo);
    } catch (err) {
      state.sensitiveWordsInfo = { ok: false, message: `读取词表失败：${err.message}` };
    }
    renderSensitiveSettings();
    return state.sensitiveWordsInfo;
  }

  // 设置弹层里的校对词表状态（未设置 / N 个词 / 文件不存在 / 编码异常都直说）
  function renderProofreadSettings() {
    const pathEl = $('settings-proofread-path');
    if (pathEl) pathEl.value = state.proofreadWordsDraft || '';
    const status = $('settings-proofread-status');
    if (!status) return;
    if (!state.proofreadWordsDraft) {
      status.textContent = '未设置：校对时只跑内置的五条规则（词表是可选的）';
      status.className = 'muted small';
      return;
    }
    const info = state.proofreadWordsInfo;
    if (!info) {
      status.textContent = '正在读取词表…';
      status.className = 'muted small';
      return;
    }
    status.textContent = proofreadWordListText(info);
    status.className = info.ok ? 'muted small' : 'muted small warn';
  }

  // 打开设置时按已保存的路径读一次校对词表状态（只读，不复制词表）
  async function refreshProofreadSettingsInfo() {
    if (!state.proofreadWordsDraft) {
      state.proofreadWordsInfo = null;
      renderProofreadSettings();
      return null;
    }
    try {
      state.proofreadWordsInfo = await call(api.proofreadWordsInfo);
    } catch (err) {
      state.proofreadWordsInfo = { ok: false, message: `读取校对词表失败：${err.message}` };
    }
    renderProofreadSettings();
    return state.proofreadWordsInfo;
  }

  // 设置弹层「诊断日志」：只显示日志目录里有几份、多大；正文永远不进日志
  function renderLogSettings() {
    const status = $('settings-logs-status');
    if (!status) return;
    const info = state.logInfo;
    if (!info) {
      status.textContent = '正在读取日志目录…';
      status.className = 'muted small';
      return;
    }
    if (info.error) {
      status.textContent = `读取日志目录失败：${info.error}`;
      status.className = 'muted small warn';
      return;
    }
    const files = Array.isArray(info.files) ? info.files : [];
    const bytes = files.reduce((sum, file) => sum + (Number(file.bytes) || 0), 0);
    status.textContent = files.length
      ? `已有 ${files.length} 个日志文件，共 ${formatBytes(bytes)}（不含正文）`
      : '还没有日志文件（应用没有出错时不会写日志）';
    status.className = 'muted small';
  }

  // 打开设置弹层时读一次日志目录（只读；写作页的按书设置里不显示这一组）
  async function refreshLogInfo() {
    try {
      state.logInfo = await call(api.logInfo);
    } catch (err) {
      state.logInfo = { error: err.message };
    }
    renderLogSettings();
    return state.logInfo;
  }

  // 检查更新（提案 7.1）：只在作者点「检查更新」时访问 GitHub；不下载、不安装、不写配置。
  // 网络失败 / 超时 / 限流都只显示一句提示，设置弹层照常能用，写作不受影响。
  function formatUpdateDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function renderUpdateSettings() {
    const versionEl = $('settings-update-version');
    if (versionEl) versionEl.textContent = state.appVersion ? `v${state.appVersion}` : '未知';
    const statusEl = $('settings-update-status');
    const checkBtn = $('btn-check-update');
    const openBtn = $('btn-open-update');
    const update = state.update || {};
    const result = update.result;
    if (checkBtn) {
      checkBtn.disabled = update.busy === true;
      checkBtn.textContent = update.busy ? '正在检查…' : '检查更新';
    }
    let text = '尚未检查（只在点按钮时联网，不会自动检查）';
    let tone = 'muted small';
    if (update.busy) {
      text = '正在检查…（只读版本号，不会下载或安装任何东西）';
    } else if (result && result.status === 'update') {
      const date = formatUpdateDate(result.publishedAt);
      text = `发现新版本 v${result.latestVersion}（当前 v${result.currentVersion}）${date ? ` · 发布于 ${date}` : ''}`;
    } else if (result && result.status === 'latest') {
      text = `已是最新版本（v${result.currentVersion || state.appVersion || '?'}）`;
    } else if (result && result.status === 'error') {
      text = `检查失败：${result.message || '未知错误'}`;
      tone = 'muted small warn';
    }
    if (statusEl) {
      statusEl.textContent = text;
      statusEl.className = tone;
    }
    if (openBtn) openBtn.classList.toggle('hidden', !(result && result.status === 'update'));
  }

  async function checkUpdate() {
    if (state.update.busy) return state.update.result;
    state.update.busy = true;
    state.update.result = null;
    renderUpdateSettings();
    let result;
    try {
      result = await call(api.checkUpdate);
    } catch (err) {
      result = {
        status: 'error',
        code: 'IPC_ERROR',
        message: `检查更新失败：${err.message}（不影响写作）`,
        currentVersion: state.appVersion || ''
      };
    }
    state.update.busy = false;
    state.update.result = result;
    renderUpdateSettings();
    if (result && result.status === 'update') {
      toast(`发现新版本 v${result.latestVersion}（当前 v${result.currentVersion}）`);
    }
    return result;
  }

  async function openUpdateDownload() {
    try {
      const data = await call(api.openUpdateDownload);
      if (data && data.opened) {
        toast('已用浏览器打开 GitHub 下载页（应用不会自动下载或安装）');
      } else if (data && data.url) {
        // 自检 / 截图环境不打开浏览器，只回报地址
        toast(`下载页：${data.url}`);
      } else {
        toast((data && data.message) || '还没有可用的下载页，请先点「检查更新」', 'warn');
      }
      return data;
    } catch (err) {
      toast(`打开下载页失败：${err.message}`, 'error');
      return null;
    }
  }

  function readSnapshotForm() {
    return {
      snapshotEnabled: $('settings-snapshot-enabled').checked === true,
      snapshotKeepDays: Number($('settings-snapshot-days').value)
    };
  }

  // 每日目标是全局设置（0 = 不设目标）；写作时长开关同样是全局的（默认关）。
  // 主进程/配置层还会再清洗一次范围与布尔值。
  function readStatsForm() {
    const n = Number($('settings-daily-goal').value);
    return {
      dailyGoal: Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0,
      writeDurationEnabled: $('settings-write-duration').checked === true
    };
  }

  function updateSettingsScopeUi() {
    const isBook = state.settingsScope === 'book';
    const rootField = $('settings-root-field');
    if (rootField) rootField.classList.toggle('hidden', isBook);
    // 每日快照是全局设置：按书覆盖没有意义，写作页里不显示
    const snapshotField = $('settings-snapshot-field');
    if (snapshotField) snapshotField.classList.toggle('hidden', isBook);
    const snapshotDays = $('settings-snapshot-days-field');
    if (snapshotDays) snapshotDays.classList.toggle('hidden', isBook);
    // 写作统计 / 每日目标 / 写作时长也是全局设置：按书覆盖没有意义，写作页里不显示
    // b8：后台监听剪贴板同样是全局开关（一个应用一个），按书设置里不显示
    for (const id of [
      'settings-stats-group',
      'settings-daily-goal-field',
      'settings-duration-field',
      'settings-clipboard-field',
      'settings-stats-chart-field',
      'settings-stats-totals-field',
      'settings-calendar-field',
      'settings-stats-hint'
    ]) {
      const el = $(id);
      if (el) el.classList.toggle('hidden', isBook);
    }
    // 敏感词表同样是全局设置（所有书共用一份词表），写作页的按书设置里不显示
    for (const id of ['settings-sensitive-group', 'settings-sensitive-field']) {
      const el = $(id);
      if (el) el.classList.toggle('hidden', isBook);
    }
    // 校对词表也是全局设置（所有书共用一份），写作页的按书设置里不显示
    for (const id of ['settings-proofread-group', 'settings-proofread-field']) {
      const el = $(id);
      if (el) el.classList.toggle('hidden', isBook);
    }
    // 章节模板也是全局设置（新书 / 所有书共用一套），写作页的按书设置里不显示
    for (const id of ['settings-template-group', 'settings-template-field']) {
      const el = $(id);
      if (el) el.classList.toggle('hidden', isBook);
    }
    // 导出简繁转换也是全局设置（导出格式对所有书一样），写作页的按书设置里不显示
    for (const id of ['settings-export-group', 'settings-export-field']) {
      const el = $(id);
      if (el) el.classList.toggle('hidden', isBook);
    }
    // 诊断日志也是全局的（一个应用一份日志），写作页的按书设置里不显示
    for (const id of ['settings-logs-group', 'settings-logs-field']) {
      const el = $(id);
      if (el) el.classList.toggle('hidden', isBook);
    }
    // 检查更新也是全局的（一个应用一个版本），写作页的按书设置里不显示
    for (const id of ['settings-update-group', 'settings-update-field']) {
      const el = $(id);
      if (el) el.classList.toggle('hidden', isBook);
    }
    // 当前段落高亮在两种作用域里都显示：按书设置时只影响这本书，书架设置时改全局默认
    const caretHint = $('settings-caret-hint');
    if (caretHint) {
      caretHint.textContent = isBook
        ? '只影响这本书：开关与颜色存进 config.json 的 bookDisplay；没单独设置过的书继续用全局默认。'
        : '全局默认：没有单独设置过的书都用这一份；在写作页里改只影响当前这本书。';
    }
    // 超长段落阈值同样两种作用域都显示：按书只影响本书，全局改默认（50–20000 字，坏值回落 500）
    const longParaHint = $('settings-long-para-hint');
    if (longParaHint) {
      longParaHint.textContent = isBook
        ? '只影响这本书：存进 config.json 的 bookDisplay；没单独设置过的书继续用全局默认。范围 50–20000 字。'
        : '全局默认：没单独设置过的书都用这一档；范围 50–20000 字，超出会夹到边界，留空 / 非数字按 500。';
    }
    // 章号是这本书的属性（存 书目.json），全局设置里没有对象可改
    const numberingField = $('settings-numbering-field');
    if (numberingField) numberingField.classList.toggle('hidden', !isBook);
    const resetBtn = $('btn-reset-book-display');
    if (resetBtn) {
      resetBtn.classList.toggle('hidden', !isBook || !Object.keys(state.bookDisplay || {}).length);
    }
    // 1.4.0 P0-1：分区导航跟着作用域走（按书只剩「显示」，当前分区不可用时自动退回「显示」）；
    // 搜索态下重算一次，避免作用域切换后把别的分区露出来。
    applySettingsSearch();
    const hint = $('settings-scope-hint');
    if (!hint) return;
    hint.textContent = isBook
      ? `只影响「${state.meta ? state.meta.title : '这本书'}」的显示设置；书架 →「设置」里改的是全局默认（没单独设置过的书都用它）。`
      : state.view === 'editor' && state.bookId
        ? '这里是全局默认设置：没单独设置过的书都用这一份；当前这本书有自己的显示设置时仍以本书为准。只想改这本书，用「显示 → 正文显示设置…」。'
        : '这里是全局默认设置：没有单独设置过的书都用这一份；在写作页里改设置只影响当前这本书。';
  }

  function previewSettings() {
    if (!state.settingsBackup) return;
    const form = readDisplayForm();
    applyEditorStyle({ ...state.settingsBackup, ...form });
    // 勾选 / 取消「当前段落高亮」时顺便预览开关本身（只改显示层，点保存才写 config）
    if (state.view === 'editor' && state.bookPath && state.index >= 0) {
      state.marks.caretParagraph = form.caretParagraph === true;
      renderMarksMenu();
      state.marks.caretLine = 0;
      renderEditorMarks();
    }
  }

  async function openSettings(options = {}) {
    state.settingsScope = resolveSettingsScope(options);
    // 回填按作用域取配置：全局 = 全局默认；按书 = 生效值（全局 + 本书覆盖）。
    const cfg = settingsBackfillConfig(state.settingsScope);
    state.settingsBackup = state.config ? { ...state.config } : null;
    // 打开时刷新一次今天 / 近 30 天，避免跨过午夜后还显示昨天的数字
    await refreshStats();
    fillSettingsFields(cfg);
    // 1.4.0 P0-1：每次打开都回到默认分区、清空搜索框（深链入口在下面再切分区并滚过去）
    settingsActiveTab = DEFAULT_SETTINGS_TAB;
    const searchInput = settingsSearchInput();
    if (searchInput) searchInput.value = '';
    updateSettingsScopeUi();
    $('settings-backdrop').classList.remove('hidden');
    // 入口指定了分区（U-D4 的码字日历）时立刻滚到那里 —— 放在异步台账读取之前，
    // 弹层一出现就已经在日历上，不会先停在顶部再跳一下。普通打开没有 section，一个字都不动。
    if (options && options.section) revealSettingsSection(options.section);
    // 全局设置里顺手读一次三份台账（词表 / 校对词表 / 日志目录，都只读；按书设置里不显示这几组）。
    // 三者互不依赖，一次并发发起，省掉两趟串行 IPC；各自的返回值、状态字段与分区渲染都不变。
    if (state.settingsScope === 'global') {
      await Promise.all([
        refreshSensitiveSettingsInfo(),
        refreshProofreadSettingsInfo(),
        refreshLogInfo()
      ]);
    }
    // 检查更新：只显示当前版本和上次检查结果（不自动联网；点按钮才检查）
    if (state.settingsScope === 'global') renderUpdateSettings();
  }

  // v0.13 U-D4：状态栏「今日字数」= 码字日历入口。
  // 打开「全局设置」（日历 / 每日目标 / 统计本来就是全局项），并按全局默认回填；只滚动定位，
  // 不写配置、不新增保存路径 —— 点「取消」照旧一个字节不写。
  async function openStatsCalendar() {
    await openSettings({ scope: 'global', section: 'calendar' });
    return state.settingsScope;
  }

  function closeSettings({ restore = true } = {}) {
    $('settings-backdrop').classList.add('hidden');
    // 关掉时顺手清空搜索（只动界面，不写配置）：下次打开不会带着上次的过滤词
    const searchInput = settingsSearchInput();
    if (searchInput && String(searchInput.value || '') !== '') searchInput.value = '';
    if (restore && state.settingsBackup) {
      state.config = state.settingsBackup;
      applyEditorStyle();
      // 取消设置：开关 / 颜色回到打开前的生效配置（只读配置，不写盘）
      syncCaretParagraphFromConfig();
      renderWriteTimer();
      renderDurationSettings();
    }
    state.settingsBackup = null;
  }

  // 忘掉这本书的单独设置，恢复用全局默认
  async function resetBookDisplay() {
    if (state.settingsScope !== 'book' || !state.bookId) return false;
    try {
      await call(api.resetBookDisplay, state.bookId);
      state.bookDisplay = {};
      state.config = effectiveConfig();
      if (state.config.editorFont === 'custom' && state.config.editorCustomFontPath) {
        await loadCustomFont(state.config.editorCustomFontPath, { silent: true });
      }
      applyEditorStyle();
      syncCaretParagraphFromConfig();
      applySidebarWidth(state.config.editorSidebarWidth != null ? state.config.editorSidebarWidth : 250);
      fillSettingsFields(state.config);
      state.settingsBackup = { ...state.config };
      updateSettingsScopeUi();
      toast('已恢复为全局默认（这本书不再有单独设置）');
      return true;
    } catch (err) {
      toast(`恢复默认失败：${err.message}`, 'error');
      return false;
    }
  }

  async function saveSettings() {
    try {
      const form = readDisplayForm();
      if (state.settingsScope === 'book' && state.bookId) {
        // 章号是书目字段（不是 bookDisplay）：先按需写 书目.json，再存显示设置
        const numberingEl = $('settings-chapter-numbering');
        const numberingWanted = numberingEl && numberingEl.value === 'volume' ? 'volume' : 'continuous';
        const numberingNow = state.meta && state.meta.chapterNumbering === 'volume' ? 'volume' : 'continuous';
        if (numberingWanted !== numberingNow) {
          const saved = await call(api.setChapterNumbering, state.bookPath, numberingWanted);
          if (saved && saved.meta) applyChapterNumbering(saved.meta);
        }
        const display = await call(api.setBookDisplay, state.bookId, form);
        state.bookDisplay = display || {};
        state.config = effectiveConfig();
        applyEditorStyle();
        syncCaretParagraphFromConfig();
        applySidebarWidth(state.config.editorSidebarWidth != null ? state.config.editorSidebarWidth : 250);
        closeSettings({ restore: false });
        toast('已保存：这本书的显示设置（只影响本书）');
        return;
      }
      // 关掉「写作时长」前，先把计时器里还没上报的整秒记下来（配置一改主进程就不再接收）
      if (writeDurationEnabled() && $('settings-write-duration').checked !== true) {
        await flushWriteTimer();
      }
      const cfg = await call(api.setConfig, {
        booksRoot: $('settings-root').value.trim(),
        ...form,
        ...readSnapshotForm(),
        ...readStatsForm(),
        // b8：剪贴板后台监听（全局开关；主进程 config:set 后立即启停轮询）
        clipboardWatchEnabled: $('settings-clipboard-watch') ? $('settings-clipboard-watch').checked === true : false,
        chapterTemplate: $('settings-chapter-template').value,
        exportConversion: $('settings-export-conversion').value,
        sensitiveWordsPath: (state.sensitiveWordsDraft || '').trim(),
        proofreadWordsPath: (state.proofreadWordsDraft || '').trim()
      });
      state.globalConfig = cfg;
      state.config = effectiveConfig();
      applyEditorStyle();
      syncCaretParagraphFromConfig();
      applyWriteTimerConfig();
      closeSettings({ restore: false });
      toast('设置已保存（全局默认）');
      await refreshShelf();
      // 词表路径可能刚改过：刷新一下状态，下次打开预检面板直接可用
      await refreshSensitiveWordList();
      await refreshProofreadWordList();
    } catch (err) {
      toast(`保存设置失败：${err.message}`, 'error');
    }
  }

  // 事件绑定（与搬前 bindEvents() 里的 6 个设置块逐行一致；由渲染层在原位置调用一次；
  // 写作计时 / 码字日历的绑定不在本域，仍留在渲染层原位置）
  function setupSettingsUi() {
    $('btn-settings').addEventListener('click', openSettings);
    $('btn-settings-cancel').addEventListener('click', closeSettings);
    // 右上「×」与底栏「取消」完全同义（含关闭前的预览还原，拍板 #3）
    $('btn-settings-close').addEventListener('click', closeSettings);
    $('btn-settings-save').addEventListener('click', saveSettings);
    // 1.4.0 P0-1：左导航切分区（Tab 可达；方向键 / Home / End 按标准 tablist 走，点击也切）
    const nav = $('settings-nav');
    if (nav) {
      nav.addEventListener('click', (event) => {
        const target = event && event.target;
        const btn = target && typeof target.closest === 'function' ? target.closest('[data-settings-tab]') : null;
        if (!btn || !btn.dataset) return;
        // 正在搜索时点分区 = 先退出搜索模式，再看这个分区
        const input = settingsSearchInput();
        if (input && String(input.value || '') !== '') resetSettingsSearch();
        setSettingsTab(btn.dataset.settingsTab);
      });
      nav.addEventListener('keydown', (event) => {
        if (!ia) return;
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].indexOf(event.key) < 0) return;
        const tabs = settingsTabNodes().filter((node) => !node.classList.contains('hidden'));
        if (!tabs.length) return;
        const active = typeof document !== 'undefined' && document ? document.activeElement : null;
        let at = tabs.indexOf(active);
        if (at < 0) at = tabs.findIndex((node) => node.getAttribute('aria-selected') === 'true');
        if (at < 0) at = 0;
        let next = at;
        if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (at + 1) % tabs.length;
        else next = (at - 1 + tabs.length) % tabs.length;
        event.preventDefault();
        event.stopPropagation();
        setSettingsTab(tabs[next].dataset.settingsTab, { focus: true });
      });
    }
    // 顶部搜索：输入即过滤（跨分区）；搜索框里 Esc 先清空搜索，搜索框已空时这一次 Esc
    // 不拦，照旧交给全局 Esc 链关弹层（esc-registry 的关闭语义一个字不改）。
    const searchInput = settingsSearchInput();
    if (searchInput) {
      searchInput.addEventListener('input', applySettingsSearch);
      searchInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (String(searchInput.value || '') === '') return;
        event.preventDefault();
        event.stopPropagation();
        resetSettingsSearch();
        if (typeof searchInput.focus === 'function') searchInput.focus();
      });
    }
    for (const id of ['btn-settings-search-clear', 'btn-settings-search-clear-empty']) {
      const btn = $(id);
      if (!btn) continue;
      btn.addEventListener('click', () => {
        resetSettingsSearch();
        const input = settingsSearchInput();
        if (input && typeof input.focus === 'function') input.focus();
      });
    }
    // 章节模板：边打字边更新预览（只读草稿，保存仍要点「保存设置」）
    const templateField = $('settings-chapter-template');
    if (templateField) templateField.addEventListener('input', renderChapterTemplatePreview);
    $('btn-reset-book-display').addEventListener('click', resetBookDisplay);
    $('btn-pick-folder').addEventListener('click', async () => {
      try {
        const folder = await call(api.pickFolder);
        if (folder) $('settings-root').value = folder;
      } catch (err) {
        toast(`选择目录失败：${err.message}`, 'error');
      }
    });
    // 敏感词预检：词表归作者管理，应用不内置任何词表；设置里只记路径（点「保存设置」才落配置）
    $('btn-pick-sensitive').addEventListener('click', () => pickSensitiveWords({ persist: false }));
    $('btn-clear-sensitive').addEventListener('click', () => {
      state.sensitiveWordsDraft = '';
      state.sensitiveWordsInfo = null;
      renderSensitiveSettings();
      toast('已清除敏感词表（点「保存设置」后生效）');
    });

    // 校对词表（v0.8-6）：同样只记路径；面板里选完立刻写配置并重新校对
    $('btn-pick-proofread').addEventListener('click', () => pickProofreadWords({ persist: false }));
    $('btn-clear-proofread').addEventListener('click', () => {
      state.proofreadWordsDraft = '';
      state.proofreadWordsInfo = null;
      renderProofreadSettings();
      toast('已清除校对词表（点「保存设置」后生效）');
    });
    const proofreadPickBtn = $('btn-proofread-pick');
    if (proofreadPickBtn) proofreadPickBtn.addEventListener('click', () => pickProofreadWords({ persist: true }));

    // 诊断日志：只让主进程打开日志文件夹（渲染层没有 fs 权限）；日志内容从不进界面
    const openLogsBtn = $('btn-open-logs');
    if (openLogsBtn) {
      openLogsBtn.addEventListener('click', async () => {
        try {
          const data = await call(api.openLogFolder);
          const dir = (data && data.dir) || '';
          if (dir) $('settings-logs-status').textContent = `日志文件夹：${dir}`;
          toast(
            data && data.opened
              ? '已在资源管理器中打开日志文件夹'
              : `日志文件夹：${dir}${data && data.note ? `（${data.note}）` : ''}`
          );
        } catch (err) {
          toast(`打开日志文件夹失败：${err.message}`, 'error');
        }
      });
    }

    // 自动更新轻量版：检查更新只读版本号；「打开下载页」交给系统浏览器，应用不下载、不安装
    const checkUpdateBtn = $('btn-check-update');
    if (checkUpdateBtn) checkUpdateBtn.addEventListener('click', () => checkUpdate());
    const openUpdateBtn = $('btn-open-update');
    if (openUpdateBtn) openUpdateBtn.addEventListener('click', () => openUpdateDownload());
    // 自定义字体：选择 → 主进程读文件 → FontFace 注册 → 实时预览（点「保存设置」才记住）
    $('btn-pick-font').addEventListener('click', async () => {
      try {
        const picked = await call(api.pickFont);
        if (!picked || picked.canceled || !picked.path) return;
        const ok = await loadCustomFont(picked.path);
        if (!ok) return;
        state.settingsFontDraft = { path: picked.path, name: picked.name };
        $('settings-font-name').value = picked.name;
        $('settings-font').value = 'custom';
        previewSettings();
        toast(`已选字体：${picked.name}（点「保存设置」后长期生效）`);
      } catch (err) {
        toast(`选择字体失败：${err.message}`, 'error');
      }
    });
    $('btn-reset-font').addEventListener('click', () => {
      state.settingsFontDraft = { path: '', name: '' };
      $('settings-font-name').value = '';
      $('settings-font').value = 'serif';
      previewSettings();
      toast('已恢复默认字体（宋体）');
    });
    $('settings-font').addEventListener('change', async () => {
      const draft = state.settingsFontDraft || {};
      if ($('settings-font').value === 'custom') {
        if (!draft.path) {
          toast('先点「选择…」挑一个 .ttf / .otf 字体文件', 'warn');
          $('settings-font').value = 'serif';
        } else {
          await loadCustomFont(draft.path, { silent: true });
        }
      }
      previewSettings();
    });
    // 设置里改显示项时实时预览，点「取消」恢复原样
    for (const id of displaySettingsIds) {
      $(id).addEventListener('change', previewSettings);
    }
    // 当前段落高亮（v0.8-10b）：勾选 / 色板 / 取色器都先改草稿并实时预览，点「保存设置」才写 config
    $('settings-caret-paragraph').addEventListener('change', previewSettings);
    const settingsCaretRow = $('settings-caret-colors');
    if (settingsCaretRow) {
      settingsCaretRow.addEventListener('click', (event) => {
        const swatch = event.target.closest('[data-settings-caret-color]');
        if (!swatch) return;
        state.settingsCaretColorDraft = caretColorLib.normalizeColor(swatch.dataset.settingsCaretColor);
        renderSettingsCaretColors();
        previewSettings();
      });
    }
    const settingsCaretPicker = $('settings-caret-color');
    if (settingsCaretPicker) {
      const syncDraft = () => {
        state.settingsCaretColorDraft = caretColorLib.normalizeColor(settingsCaretPicker.value);
        renderSettingsCaretColors();
        previewSettings();
      };
      settingsCaretPicker.addEventListener('input', syncDraft);
      settingsCaretPicker.addEventListener('change', syncDraft);
    }
  }


    return {
      setSelectValue,
      renderSettingsCaretColors,
      renderChapterTemplatePreview,
      renderSensitiveSettings,
      renderProofreadSettings,
      checkUpdate,
      openUpdateDownload,
      previewSettings,
      openSettings,
      openStatsCalendar,
      closeSettings,
      resetBookDisplay,
      saveSettings,
      setupSettingsUi
    };
  }

  return { create: createSettingsUi, REQUIRED_HOST };
});
