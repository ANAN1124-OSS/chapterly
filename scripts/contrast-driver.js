'use strict';
// 章回 · 对比度采样驱动（v0.9 A-4 视觉细节，开发自检专用）
//
// 只在 `--contrast` 时由 main.js 的 runAutomation() 懒加载（和 bench-driver / screenshot-driver
// 同一条路）；打包配置 build.files 不含 scripts/，安装版里没有这段代码，正常启动也不会 require。
//
// 边界与 bench-driver 一致：本文件**不 require electron**，窗口 / app / 启动参数全部由 host 传入，
// 所以 tests/contrast.test.js 可以直接 require 它做静态与语法检查。
//
// 干什么：等渲染层测试钩子就绪 → 把 contrastScenario 整段注入页面 → 页面里**只收集颜色**
// （元素的计算文字色 + 从元素往上走的背景色栈、字号字重；令牌类用临时探针把 var() / color-mix()
// 解析成实际 rgb）→ 把结果打回主进程。判断阈值、算对比度、打表都由 Node 侧
// `scripts/contrast-color.js` 做：一处公式，脚本与单测共用同一份。
//
// 为什么页面里不直接算对比度：颜色合成与 WCAG 公式必须只有一份（见 contrast-color.js 的文件头）。
// 页面里只做「浏览器最擅长的事」——把样式解析成实际 rgb。
//
// 采样口径（改之前先读）：
//   * 每套主题都切一次 `body.theme-*`（和渲染层 applyEditorStyle / loadConfig 的做法一致），
//     切完**读一次 body.offsetHeight 强制同步样式与布局**——不用 requestAnimationFrame、
//     也不用固定 sleep：工作站锁屏 / 窗口被遮挡时 Chromium 会把 rAF 与定时器节流到秒级，
//     而同步布局在任何可见性状态下都照算。
//   * 采的是「当前这一刻真实算出来的颜色」，不读 CSS 文本、不假设 color-mix / var() 的结果。
//   * 元素不存在（还没渲染 / 当前视图没有）就标记 found=false，算「未采样」而不是失败。
//   * 主按钮（保存）默认是禁用态（opacity .45，本来就豁免对比度检查），所以它单独在
//     「让当前章变脏之后」那一批里采——禁用按钮的对比度没有参考价值。
//   * 令牌类采样（焦点环 / 滚动条 / 状态色）允许带 `fallbackToken`：某个令牌是**这一轮新加的**
//     时候，改前那一遍还没有它，就退回它替换掉的那个旧令牌，这样「改前 / 改后」量的是同一个
//     位置、同一件事，而不是「改前量别的、改后量这个」。

// ---------- 采样规格 ----------
// kind 由字段决定：有 `token` = 令牌（var / color-mix 解析成实际 rgb，bg 用 bgToken）；
// 否则 = 元素（selector + 可选 pseudo；底色从元素自身往上走）。
// `ui: true` 的按 WCAG 1.4.11「非文字界面图形」3:1 判，其余按文字（大字号自动 3:1）。
// `optional: true` 的元素允许不存在（例如没有备注的章节、没有冲突副本的书架），不算失败。
const SPECS = {
  shelf: [
    { key: 'shelf.bookTitle', label: '书架：书卡书名', selector: '.book-card[data-path] .book-card-title' },
    { key: 'shelf.bookAuthor', label: '书架：书卡作者', selector: '.book-card[data-path] .book-card-author', optional: true },
    { key: 'shelf.bookTags', label: '书架：书卡标签', selector: '.book-card[data-path] .book-card-tags', optional: true },
    { key: 'shelf.bookBrief', label: '书架：书卡简介', selector: '.book-card[data-path] .book-card-brief', optional: true },
    { key: 'shelf.bookTime', label: '书架：书卡「最后修改」', selector: '.book-card[data-path] .book-card-time' },
    {
      key: 'shelf.conflictBadge',
      label: '书架：同步冲突副本提示',
      selector: '.book-conflict-badge',
      optional: true
    },
    { key: 'shelf.newBook', label: '书架：「新建一本书」卡', selector: '.book-card.new-book' },
    { key: 'shelf.rootLabel', label: '书架：书库路径', selector: '#books-root-label' },
    {
      key: 'shelf.searchPlaceholder',
      label: '书架：搜索框占位提示',
      selector: '#shelf-search',
      pseudo: '::placeholder'
    },
    { key: 'shelf.ghostBtn', label: '书架：顶栏次级按钮', selector: '#btn-settings' },
    {
      key: 'shelf.corruptTitle',
      label: '书架：损坏书卡的标题',
      selector: '.book-card.corrupt .book-card-title',
      optional: true
    }
  ],
  editor: [
    { key: 'editor.title', label: '写作：章节标题', selector: '#chapter-title' },
    { key: 'editor.body', label: '写作：正文', selector: '#editor' },
    {
      key: 'editor.placeholder',
      label: '写作：正文占位提示',
      selector: '#editor',
      pseudo: '::placeholder'
    },
    {
      key: 'editor.chapterName',
      label: '写作：章节列表章名',
      selector: '#chapter-list .chapter-item:not(.active) .chapter-name'
    },
    {
      key: 'editor.chapterNum',
      label: '写作：章节号',
      selector: '#chapter-list .chapter-item:not(.active) .chapter-num',
      optional: true
    },
    {
      key: 'editor.chapterChars',
      label: '写作：章节字数',
      selector: '#chapter-list .chapter-item:not(.active) .chapter-chars'
    },
    {
      key: 'editor.chapterNote',
      label: '写作：章节备注标记',
      selector: '#chapter-list .chapter-item:not(.active) .chapter-note-mark',
      optional: true
    },
    {
      key: 'editor.activeChapterName',
      label: '写作：当前章章名',
      selector: '#chapter-list .chapter-item.active .chapter-name'
    },
    {
      key: 'editor.activeChapterNum',
      label: '写作：当前章章节号（强调色）',
      selector: '#chapter-list .chapter-item.active .chapter-num',
      optional: true
    },
    {
      key: 'editor.activeChapterChars',
      label: '写作：当前章字数',
      selector: '#chapter-list .chapter-item.active .chapter-chars'
    },
    {
      key: 'editor.volumeName',
      label: '写作：分卷名',
      selector: '#chapter-list .volume-item .volume-name',
      optional: true
    },
    { key: 'editor.statusText', label: '写作：状态栏文字', selector: '#status-text' },
    {
      key: 'editor.statusKbd',
      label: '写作：状态栏快捷键提示',
      selector: '.status-hints .kbd',
      optional: true
    },
    { key: 'editor.ghostBtn', label: '写作：顶栏次级按钮', selector: '#btn-find' },
    {
      key: 'token.focusRing',
      label: '通用：焦点环',
      token: '--focus-ring',
      fallbackToken: '--accent-soft',
      bgToken: '--paper-soft',
      ui: true
    },
    {
      key: 'token.scrollThumb',
      label: '通用：滚动条滑块',
      token: '--scroll-thumb',
      fallbackToken: '--line-strong',
      bgToken: '--paper',
      ui: true
    },
    { key: 'token.warn', label: '通用：警示色文字', token: '--warn', bgToken: '--paper-soft' },
    { key: 'token.danger', label: '通用：危险色文字', token: '--danger', bgToken: '--paper-soft' },
    { key: 'token.ok', label: '通用：成功色文字', token: '--ok', bgToken: '--paper-soft' },
    { key: 'token.inkFaint', label: '通用：次要文字色', token: '--ink-faint', bgToken: '--paper-soft' }
  ],
  dirty: [
    {
      key: 'dirty.saveBtn',
      label: '写作：主按钮「保存」（启用态）',
      selector: '#btn-save'
    }
  ],
  // ---------- 弹层内部（V-3 M5：补齐 A-4 遗留的「弹层内部」） ----------
  // 每个 view 由场景在页面里真实打开对应弹层后逐主题采样；选择器都取「读文字的人真正看的那一层」。
  settings: [
    { key: 'dialog.settings.title', label: '设置：弹层标题', selector: '#settings-title' },
    { key: 'dialog.settings.scopeHint', label: '设置：作用域提示', selector: '.settings-scope-hint' },
    { key: 'dialog.settings.label', label: '设置：字段标签', selector: '.settings-row > span' },
    { key: 'dialog.settings.control', label: '设置：字段控件文字', selector: '.settings-row .text-input' },
    { key: 'dialog.settings.hint', label: '设置：字段说明小字', selector: '.settings-row .muted.small' },
    { key: 'dialog.settings.primary', label: '设置：主按钮「保存设置」', selector: '#btn-settings-save' },
    { key: 'dialog.settings.ghost', label: '设置：次按钮「取消」', selector: '#btn-settings-cancel' }
  ],
  export: [
    { key: 'dialog.export.title', label: '导出范围：弹层标题', selector: '#export-title' },
    { key: 'dialog.export.scopeLabel', label: '导出范围：范围行标签', selector: '.export-scope-row > span' },
    { key: 'dialog.export.summary', label: '导出范围：汇总框文字', selector: '#export-summary' },
    { key: 'dialog.export.note', label: '导出范围：简繁转换说明', selector: '#export-conversion-note' },
    { key: 'dialog.export.primary', label: '导出范围：主按钮「导出…」', selector: '#btn-export-confirm' },
    { key: 'dialog.export.ghost', label: '导出范围：次按钮「取消」', selector: '#btn-export-cancel' }
  ],
  format: [
    { key: 'dialog.format.title', label: '排版：弹层标题', selector: '#format-title' },
    { key: 'dialog.format.ruleLabel', label: '排版：规则行标签', selector: '.format-rules .field > span' },
    { key: 'dialog.format.preview', label: '排版：预览区文字', selector: '#fmt-preview' },
    { key: 'dialog.format.primary', label: '排版：主按钮「套用到本章」', selector: '#btn-format-apply' },
    { key: 'dialog.format.ghost', label: '排版：次按钮「默认规则」', selector: '#btn-format-reset' }
  ],
  find: [
    { key: 'dialog.find.title', label: '查找：弹层标题', selector: '#find-title' },
    { key: 'dialog.find.placeholder', label: '查找：输入框占位提示', selector: '#find-query', pseudo: '::placeholder' },
    { key: 'dialog.find.summary', label: '查找：结果汇总', selector: '#find-summary' },
    { key: 'dialog.find.chapter', label: '查找：结果章名', selector: '.find-result .find-chapter' },
    { key: 'dialog.find.snippet', label: '查找：结果片段', selector: '.find-result .find-snippet' },
    { key: 'dialog.find.close', label: '查找：底栏「关闭」', selector: '#btn-find-close' }
  ],
  proofread: [
    { key: 'dialog.proofread.title', label: '校对：弹层标题', selector: '#proofread-title' },
    { key: 'dialog.proofread.summary', label: '校对：汇总行', selector: '.proofread-summary' },
    { key: 'dialog.proofread.rule', label: '校对：规则名（彩色小签）', selector: '.proofread-result .proofread-rule' },
    { key: 'dialog.proofread.snippet', label: '校对：命中片段', selector: '.proofread-result .proofread-snippet' },
    { key: 'dialog.proofread.scope', label: '校对：范围下拉', selector: '#proofread-scope' },
    { key: 'dialog.proofread.close', label: '校对：底栏「关闭」', selector: '#btn-proofread-close' }
  ],
  history: [
    { key: 'dialog.history.title', label: '历史：弹层标题', selector: '#history-title' },
    { key: 'dialog.history.summary', label: '历史：汇总行', selector: '#history-summary' },
    { key: 'dialog.history.fileName', label: '历史：备份文件名', selector: '.history-file .history-file-name' },
    { key: 'dialog.history.fileTag', label: '历史：备份状态小签', selector: '.history-file .history-file-tag' },
    { key: 'dialog.history.preview', label: '历史：预览正文', selector: '#history-preview-text' }
  ],
  // ---------- 交互态（V-3 M5：hover / active / disabled） ----------
  // 由驱动用 CDP CSS.forcePseudoState 在真实元素上强制伪类（等价真实指针 / 按键），
  // 不是往产品 DOM 里加测试类；每组的「强制目标」见 STATE_TARGETS。
  hoverBook: [
    { key: 'state.hover.bookTitle', label: '悬停：书卡书名', selector: '.book-card[data-path] .book-card-title' },
    { key: 'state.hover.bookTime', label: '悬停：书卡「最后修改」', selector: '.book-card[data-path] .book-card-time' },
    {
      key: 'state.hover.bookAuthor',
      label: '悬停：书卡作者',
      selector: '.book-card[data-path] .book-card-author',
      optional: true
    }
  ],
  hoverButton: [{ key: 'state.hover.ghostBtn', label: '悬停：顶栏次级按钮', selector: '#btn-settings' }],
  hoverChapter: [
    { key: 'state.hover.chapterName', label: '悬停：章节名', selector: '.chapter-item:not(.active) .chapter-name' },
    { key: 'state.hover.chapterNum', label: '悬停：章节号', selector: '.chapter-item:not(.active) .chapter-num' },
    { key: 'state.hover.chapterChars', label: '悬停：章节字数', selector: '.chapter-item:not(.active) .chapter-chars' }
  ],
  hoverMenu: [{ key: 'state.hover.menuItem', label: '悬停：下拉菜单条目', selector: '#display-menu button' }],
  hoverFind: [
    { key: 'state.hover.findChapter', label: '悬停：查找结果章名', selector: '.find-result .find-chapter' },
    { key: 'state.hover.findSnippet', label: '悬停：查找结果片段', selector: '.find-result .find-snippet' }
  ],
  hoverProofread: [
    { key: 'state.hover.proofreadRule', label: '悬停：校对规则名', selector: '.proofread-result .proofread-rule' },
    { key: 'state.hover.proofreadSnippet', label: '悬停：校对命中片段', selector: '.proofread-result .proofread-snippet' }
  ],
  hoverHistory: [
    { key: 'state.hover.historyName', label: '悬停：历史文件名', selector: '.history-file .history-file-name' },
    { key: 'state.hover.historyTag', label: '悬停：历史状态小签', selector: '.history-file .history-file-tag' }
  ],
  activeButton: [{ key: 'state.active.ghostBtn', label: '按下：顶栏次级按钮', selector: '#btn-find' }],
  activePrimary: [{ key: 'state.active.primaryBtn', label: '按下：主按钮「保存」', selector: '#btn-save' }],
  activeMenu: [{ key: 'state.active.menuItem', label: '按下：下拉菜单条目', selector: '#display-menu button' }],
  // 禁用态按 WCAG 1.4.3 豁免（inactive controls），只记录实测比值、不计入失败；
  // 产品里这是「按得动 / 按不动」的观感差别，不按正文文字要求 4.5:1。
  disabled: [{ key: 'state.disabled.saveBtn', label: '禁用：主按钮「保存」', selector: '#btn-save', exempt: true }],
  disabledMenu: [
    {
      key: 'state.disabled.menuItem',
      label: '禁用：整理菜单「撤销上次整理」',
      selector: '#format-undo-item',
      exempt: true
    }
  ]
};

// 交互态每组「强制哪个元素、强制哪些伪类」（CSS.forcePseudoState 的目标）。
// 选择器必须能在对应视图里命中；「撤销上次整理」在整理菜单里，不强制伪类（天然 disabled）。
const STATE_TARGETS = {
  hoverBook: { selector: '.book-card[data-path]', pseudo: ['hover'] },
  hoverButton: { selector: '#btn-settings', pseudo: ['hover'] },
  hoverChapter: { selector: '.chapter-item:not(.active)', pseudo: ['hover'] },
  hoverMenu: { selector: '#display-menu button', pseudo: ['hover'] },
  hoverFind: { selector: '.find-result', pseudo: ['hover'] },
  hoverProofread: { selector: '.proofread-result', pseudo: ['hover'] },
  hoverHistory: { selector: '.history-file', pseudo: ['hover'] },
  activeButton: { selector: '#btn-find', pseudo: ['active'] },
  activePrimary: { selector: '#btn-save', pseudo: ['active'] },
  activeMenu: { selector: '#display-menu button', pseudo: ['active'] },
  disabled: { selector: null, pseudo: [] }
};

// 这个函数会被 toString() 丢进渲染层执行：**只能用浏览器全局**（window / document /
// getComputedStyle / JSON），不许引用本文件里的任何变量或 Node API，否则页面里 ReferenceError。
function contrastScenario(cfg) {
  return (async () => {
    const T = window.__cwTest;
    if (!T) return { ok: false, error: '测试钩子没加载（地址里应当带 ?test=1）' };
    // 6 套纸色主题：paper 是默认（不加类），其余各有一个 body.theme-* 类（见 renderer/styles.css）。
    const THEME_CLASSES = ['cream', 'green', 'kraft', 'grid', 'night'];
    const themes =
      Array.isArray(cfg.themes) && cfg.themes.length ? cfg.themes : ['paper', ...THEME_CLASSES];
    const specs = cfg.specs || {};
    // 关掉颜色过渡再采样：.btn / .chapter-item / 书卡带 120–150ms 的 transition，切完主题
    // 立刻读 computed style 会读到**过渡中间帧**（实测夜间主按钮被读成浅色主题的底色）。
    // 做法是往「已经允许加载」的 styles.css 里插一条时长归零的规则（CSSOM，CSP 不拦；
    // 用构造样式表也行，但插入 / 删除规则最直观），采样结束后删掉——不留任何痕迹。
    const noTransition = (() => {
      const sheet = Array.from(document.styleSheets).find(
        (item) => item.href && /styles\.css$/.test(item.href)
      );
      if (!sheet) return null;
      try {
        const index = sheet.insertRule(
          '*{transition-duration:0s !important;transition-delay:0s !important;' +
            'animation-duration:0s !important;animation-delay:0s !important}',
          sheet.cssRules.length
        );
        return { sheet, index };
      } catch {
        return null; // 插不进去就照常采样（颜色可能会读到过渡中间帧，报告里能看出来）
      }
    })();

    const applyTheme = (theme) => {
      for (const name of THEME_CLASSES) {
        document.body.classList.toggle('theme-' + name, name === theme);
      }
      // 强制一次同步样式 / 布局，让新主题的颜色真的算出来（不靠 rAF / 定时器）。
      return document.body.offsetHeight;
    };

    // 元素「实际看到的底色」：从元素自身往上收集 backgroundColor，交给 Node 侧合成。
    // 第一个是最上层（元素自己的底色），最后是 body / html。半透明层也照收，Node 侧会叠。
    const bgChainOf = (el) => {
      const chain = [];
      for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
        const bg = getComputedStyle(node).backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') chain.push(bg);
      }
      return chain;
    };

    // 令牌 / 伪元素色的实际值：往 body 里插一个临时探针，把 `var(--x)` / `color-mix(...)`
    // 交给浏览器解析成 rgb 再读回来（CSSOM 赋值不受 CSP 限制，项目里色块也是这么写的）。
    const resolveColor = (declaration, useBackground) => {
      const el = document.createElement('span');
      el.style.position = 'absolute';
      el.style.left = '-10000px';
      el.style.top = '0';
      el.style.visibility = 'hidden';
      el.style.color = declaration;
      el.style.backgroundColor = declaration;
      document.body.appendChild(el);
      const styles = getComputedStyle(el);
      const value = useBackground ? styles.backgroundColor : styles.color;
      el.remove();
      return value;
    };

    // 主题里有没有定义这个自定义属性（新加的令牌在改前那一遍还不存在，要用 fallbackToken）。
    const hasVar = (name) => {
      if (!name) return false;
      return String(getComputedStyle(document.body).getPropertyValue(name) || '').trim() !== '';
    };

    const sampleOne = (view, theme, spec) => {
      const base = { view, theme, key: spec.key, label: spec.label, ui: Boolean(spec.ui) };
      try {
        if (spec.token) {
          const name = hasVar(spec.token) ? spec.token : spec.fallbackToken;
          if (!name || !hasVar(name)) {
            return { ...base, found: false, error: '主题里没有这个令牌：' + spec.token };
          }
          const bgName = spec.bgToken && hasVar(spec.bgToken) ? spec.bgToken : '--paper';
          return {
            ...base,
            found: true,
            color: resolveColor('var(' + name + ')', false),
            bgStack: [resolveColor('var(' + bgName + ')', true)],
            fontSize: Number(spec.fontSize) || 14,
            fontWeight: Number(spec.fontWeight) || 400,
            source: 'token ' + name
          };
        }
        const el = document.querySelector(spec.selector);
        if (!el) return { ...base, found: false, optional: Boolean(spec.optional) };
        const styles = getComputedStyle(el, spec.pseudo || null);
        const bgEl = spec.bgSelector ? document.querySelector(spec.bgSelector) || el : el;
        return {
          ...base,
          found: true,
          color: styles.color,
          bgStack: bgChainOf(bgEl),
          bgImage: getComputedStyle(bgEl).backgroundImage,
          fontSize: parseFloat(styles.fontSize) || 0,
          fontWeight: Number(styles.fontWeight) || 400,
          source: spec.selector + (spec.pseudo || '')
        };
      } catch (err) {
        return { ...base, found: false, error: String(err && err.message ? err.message : err) };
      }
    };

    const result = [];
    const env = {
      windowSize: window.innerWidth + '×' + window.innerHeight,
      dpr: window.devicePixelRatio,
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
      // 采样前有没有关掉颜色过渡：false 时读到的可能是过渡中间帧，报告里要看这一项。
      transitionsOff: Boolean(noTransition)
    };

    // ---------- 1. 书架 ----------
    if (T.state.view !== 'shelf') await T.backToShelf();
    await T.refreshShelf();
    for (const theme of themes) {
      applyTheme(theme);
      for (const spec of specs.shelf || []) result.push(sampleOne('shelf', theme, spec));
    }

    // ---------- 2. 写作页（普通章） ----------
    await T.openBookPath(cfg.bookPath);
    // 固定到第 1 章：CLI 的夹具把第 1 章做成空正文，这样输入框的占位提示也在采样范围里。
    if (cfg.chapterIndex != null && Number(cfg.chapterIndex) >= 0) {
      await T.switchTo(Number(cfg.chapterIndex), 'discard');
    }
    for (const theme of themes) {
      applyTheme(theme);
      for (const spec of specs.editor || []) result.push(sampleOne('editor', theme, spec));
    }

    // ---------- 3. 让当前章变脏（保存按钮从禁用变启用）再采一次 ----------
    // 只改编辑区、不写盘（CLI 用的是临时书库，退出即丢）；禁用态的对比度本来就豁免检查。
    if (T.state.view === 'editor' && !T.dirty()) {
      await T.setText(String(T.text() || '') + '字');
    }
    for (const theme of themes) {
      applyTheme(theme);
      for (const spec of specs.dirty || []) result.push(sampleOne('dirty', theme, spec));
    }

    // ---------- 4. 弹层内部（V-3 M5：设置 / 导出范围 / 排版 / 查找 / 校对 / 历史） ----------
    // 每个弹层只真实打开一次，再逐主题采样（切主题不动弹层内容，比重开六次快也少状态残留）。
    const sampleDialog = (view, list) => {
      for (const theme of themes) {
        applyTheme(theme);
        for (const spec of list || []) result.push(sampleOne(view, theme, spec));
      }
    };
    const closeBackdrop = (id) => {
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    };
    // 弹层里的查找 / 校对要有真实命中：切到第 2 章（有正文），先丢弃编辑区里的改动。
    await T.switchTo(1, 'discard');
    if (specs.settings && specs.settings.length) {
      await T.openSettings();
      sampleDialog('settings', specs.settings);
      await T.closeSettings();
    }
    if (specs.export && specs.export.length) {
      const toggle = document.getElementById('btn-export');
      if (toggle) toggle.click();
      const txtItem = document.querySelector('#export-menu button[data-action="txt"]');
      if (txtItem) txtItem.click();
      // 打开弹层时汇总还在异步读取，主按钮是临时禁用态（禁用态另有豁免项）；这里临时清掉
      // disabled 采「用户真正看到并按下」的启用态外观，采完立刻还原。
      const primary = document.getElementById('btn-export-confirm');
      const wasDisabled = primary ? primary.disabled : false;
      if (primary) primary.disabled = false;
      sampleDialog('export', specs.export);
      if (primary) primary.disabled = wasDisabled;
      const cancel = document.getElementById('btn-export-cancel');
      if (cancel) cancel.click();
      closeBackdrop('export-backdrop');
    }
    if (specs.format && specs.format.length) {
      T.openFormatDialog();
      // 排版预览也是异步排期计算的，主按钮同样先禁用；采启用态。
      const apply = document.getElementById('btn-format-apply');
      const wasDisabled = apply ? apply.disabled : false;
      if (apply) apply.disabled = false;
      sampleDialog('format', specs.format);
      if (apply) apply.disabled = wasDisabled;
      const cancel = document.getElementById('btn-format-cancel');
      if (cancel) cancel.click();
      closeBackdrop('format-backdrop');
    }
    if (specs.find && specs.find.length) {
      T.openFindPanel();
      // 整本范围才渲染「结果清单」；当前章范围只移动光标 / 画高亮，没有 .find-result 行。
      T.setFindFields({ query: '灯芯', scope: 'book' });
      await T.findRun();
      sampleDialog('find', specs.find);
      T.closeFindPanel();
    }
    if (specs.proofread && specs.proofread.length) {
      await T.openProofreadPanel();
      sampleDialog('proofread', specs.proofread);
      T.closeProofreadPanel();
    }
    if (specs.history && specs.history.length) {
      await T.openHistoryForCurrentBook();
      sampleDialog('history', specs.history);
      T.closeHistory();
    }

    // 复原主题与过渡规则（不残留到下一次启动的同进程场景；CLI 随后就退出）。
    applyTheme(cfg.restoreTheme || 'paper');
    if (noTransition) {
      try {
        noTransition.sheet.deleteRule(noTransition.index);
      } catch {
        /* 规则已经被别处删掉也无所谓 */
      }
    }
    return { ok: true, env, themes, samples: result };
  })().catch((err) => ({ ok: false, error: String((err && err.stack) || err) }));
}

// 交互态采样（V-3 M5）：驱动先用 CDP CSS.forcePseudoState 在**真实元素**上强制 :hover / :active
// （与真实指针 / 按键走同一套样式解析，不是往产品 DOM 里加测试类），再把这段脚本丢进页面逐主题
// 读计算色。同样只引用浏览器全局（window / document / getComputedStyle）——页面里没有 Node API。
function stateSampleScenario(cfg) {
  const THEME_CLASSES = ['cream', 'green', 'kraft', 'grid', 'night'];
  const themes = Array.isArray(cfg.themes) && cfg.themes.length ? cfg.themes : ['paper', ...THEME_CLASSES];
  const specs = cfg.specs || [];
  const view = cfg.view || 'state';
  const applyTheme = (theme) => {
    for (const name of THEME_CLASSES) {
      document.body.classList.toggle('theme-' + name, name === theme);
    }
    return document.body.offsetHeight;
  };
  const bgChainOf = (el) => {
    const chain = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') chain.push(bg);
    }
    return chain;
  };
  const resolveColor = (declaration, useBackground) => {
    const el = document.createElement('span');
    el.style.position = 'absolute';
    el.style.left = '-10000px';
    el.style.top = '0';
    el.style.visibility = 'hidden';
    el.style.color = declaration;
    el.style.backgroundColor = declaration;
    document.body.appendChild(el);
    const styles = getComputedStyle(el);
    const value = useBackground ? styles.backgroundColor : styles.color;
    el.remove();
    return value;
  };
  const hasVar = (name) => {
    if (!name) return false;
    return String(getComputedStyle(document.body).getPropertyValue(name) || '').trim() !== '';
  };
  const sampleOne = (theme, spec) => {
    const base = { view, theme, key: spec.key, label: spec.label, ui: Boolean(spec.ui), exempt: Boolean(spec.exempt) };
    try {
      if (spec.token) {
        const name = hasVar(spec.token) ? spec.token : spec.fallbackToken;
        if (!name || !hasVar(name)) return { ...base, found: false, error: '主题里没有这个令牌：' + spec.token };
        const bgName = spec.bgToken && hasVar(spec.bgToken) ? spec.bgToken : '--paper';
        return {
          ...base,
          found: true,
          color: resolveColor('var(' + name + ')', false),
          bgStack: [resolveColor('var(' + bgName + ')', true)],
          fontSize: Number(spec.fontSize) || 14,
          fontWeight: Number(spec.fontWeight) || 400,
          source: 'token ' + name
        };
      }
      const el = document.querySelector(spec.selector);
      if (!el) return { ...base, found: false, optional: Boolean(spec.optional) };
      const styles = getComputedStyle(el, spec.pseudo || null);
      const bgEl = spec.bgSelector ? document.querySelector(spec.bgSelector) || el : el;
      return {
        ...base,
        found: true,
        color: styles.color,
        bgStack: bgChainOf(bgEl),
        bgImage: getComputedStyle(bgEl).backgroundImage,
        fontSize: parseFloat(styles.fontSize) || 0,
        fontWeight: Number(styles.fontWeight) || 400,
        source: spec.selector + (spec.pseudo || '')
      };
    } catch (err) {
      return { ...base, found: false, error: String(err && err.message ? err.message : err) };
    }
  };
  const result = [];
  for (const theme of themes) {
    applyTheme(theme);
    for (const spec of specs) result.push(sampleOne(theme, spec));
  }
  applyTheme(cfg.restoreTheme || 'paper');
  return { ok: true, view, samples: result };
}

function buildStateScript(cfg) {
  return `(${stateSampleScenario.toString()})(${JSON.stringify(cfg)})`;
}

// 交互态采样前把颜色过渡关掉（CSSOM 临时插规则，采样结束后删）：强制 :hover 会触发
// 120ms 的底色过渡，立刻读计算值会读到中间帧。规则只存在于这一次自检进程里。
const NO_TRANSITION_ON = `(() => {
  const sheet = Array.from(document.styleSheets).find((item) => item.href && /styles\\.css$/.test(item.href));
  if (!sheet) return false;
  try {
    window.__cwContrastRule = sheet.insertRule(
      '*{transition-duration:0s !important;transition-delay:0s !important;' +
        'animation-duration:0s !important;animation-delay:0s !important}',
      sheet.cssRules.length
    );
    window.__cwContrastSheet = sheet;
    return true;
  } catch (err) {
    return false;
  }
})()`;
const NO_TRANSITION_OFF = `(() => {
  try { window.__cwContrastSheet.deleteRule(window.__cwContrastRule); } catch (err) { /* 已删掉也无所谓 */ }
  return true;
})()`;

// 把「强制伪类 + 逐主题采样」逐组跑完；返回原始采样（与页面场景里的 sample 同构）。
// 目标元素不存在时（例如没有备份可看的历史列表）该组整组跳过 → 报告里自然记成缺采样。
async function collectStateSamples(win, cfg, themes) {
  const exec = (code) => win.webContents.executeJavaScript(code, true);
  const call = (code) => exec(`(async () => (${code}))()`);
  const samples = [];
  let dbg = null;
  let attachedHere = false;
  try {
    dbg = win.webContents.debugger;
    if (!dbg.isAttached()) {
      dbg.attach('1.3');
      attachedHere = true;
    }
    await dbg.sendCommand('DOM.enable');
    await dbg.sendCommand('CSS.enable');
  } catch (err) {
    console.warn('[contrast] 交互态采样跳过（CDP 不可用）：', err && err.message ? err.message : err);
    if (dbg && attachedHere) {
      try { dbg.detach(); } catch { /* 忽略 */ }
    }
    return samples;
  }
  await exec(NO_TRANSITION_ON);
  const force = async (selector, pseudo) => {
    const doc = await dbg.sendCommand('DOM.getDocument', { depth: 0 });
    const hit = await dbg.sendCommand('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    if (!hit || !hit.nodeId) return null;
    if (pseudo && pseudo.length) {
      await dbg.sendCommand('CSS.forcePseudoState', { nodeId: hit.nodeId, forcedPseudoClasses: pseudo });
    }
    return hit.nodeId;
  };
  const clear = async (nodeId) => {
    if (!nodeId) return;
    try {
      await dbg.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    } catch { /* DOM 已经重建过也无所谓 */ }
  };
  const collect = async (view, target, specs) => {
    if (!specs || !specs.length) return;
    let nodeId = null;
    if (target) {
      nodeId = await force(target.selector, target.pseudo);
      if (!nodeId) return;
    }
    try {
      const data = await exec(buildStateScript({ view, specs, themes }));
      if (data && data.ok) samples.push(...data.samples);
    } finally {
      await clear(nodeId);
    }
  };
  const viewSpecs = (specs) => SPECS[specs] || [];
  try {
    // ---------- 书架：书卡 / 顶栏按钮的悬停 ----------
    await call('window.__cwTest.backToShelf()');
    await call('window.__cwTest.refreshShelf()');
    await collect('hoverBook', STATE_TARGETS.hoverBook, viewSpecs('hoverBook'));
    await collect('hoverButton', STATE_TARGETS.hoverButton, viewSpecs('hoverButton'));

    // ---------- 写作页：章节条目悬停 / 按钮按下 / 禁用主按钮 ----------
    await call('window.__cwTest.openBookPath(' + JSON.stringify(cfg.bookPath) + ')');
    await call('window.__cwTest.switchTo(0, "discard")');
    await collect('disabled', null, viewSpecs('disabled'));
    await collect('hoverChapter', STATE_TARGETS.hoverChapter, viewSpecs('hoverChapter'));
    await collect('activeButton', STATE_TARGETS.activeButton, viewSpecs('activeButton'));
    // 主按钮按下态：先让当前章变脏（保存按钮启用），再强制 :active。
    await call(`window.__cwTest.setText(String(window.__cwTest.text()) + '字')`);
    await collect('activePrimary', STATE_TARGETS.activePrimary, viewSpecs('activePrimary'));

    // ---------- 下拉菜单：条目悬停 / 按下 / 禁用项 ----------
    await call('window.__cwTest.openDisplayMenu()');
    await collect('hoverMenu', STATE_TARGETS.hoverMenu, viewSpecs('hoverMenu'));
    await collect('activeMenu', STATE_TARGETS.activeMenu, viewSpecs('activeMenu'));
    await call('window.__cwTest.openFormatMenu()');
    await collect('disabledMenu', null, viewSpecs('disabledMenu'));
    await call('window.__cwTest.closeDisplayMenu()');

    // ---------- 弹层里的结果行悬停 ----------
    // 校对面板只检查「当前章」：切到有正文的第 2 章，才有 .proofread-result 行可采。
    await call('window.__cwTest.switchTo(1, "discard")');
    await call('window.__cwTest.openFindPanel()');
    await call(`window.__cwTest.setFindFields({ query: '灯芯', scope: 'book' })`);
    await call('window.__cwTest.findRun()');
    await collect('hoverFind', STATE_TARGETS.hoverFind, viewSpecs('hoverFind'));
    await call('window.__cwTest.closeFindPanel()');

    await call('window.__cwTest.openProofreadPanel()');
    await collect('hoverProofread', STATE_TARGETS.hoverProofread, viewSpecs('hoverProofread'));
    await call('window.__cwTest.closeProofreadPanel()');

    await call('window.__cwTest.openHistoryForCurrentBook()');
    await collect('hoverHistory', STATE_TARGETS.hoverHistory, viewSpecs('hoverHistory'));
    await call('window.__cwTest.closeHistory()');
  } finally {
    await exec(NO_TRANSITION_OFF);
    if (attachedHere && dbg) {
      try { dbg.detach(); } catch { /* 忽略 */ }
    }
  }
  return samples;
}

// 注入脚本 = 函数源码 + 参数（和 bench-driver 一样用 toString()，页面里跑的就是本文件这一份）。
function buildContrastScript(cfg) {
  return `(${contrastScenario.toString()})(${JSON.stringify(cfg)})`;
}

function contrastConfig(argValue) {
  const read = typeof argValue === 'function' ? argValue : () => null;
  const themes = String(read('contrast-themes') || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    bookPath: String(read('contrast-book') || ''),
    chapterIndex: read('contrast-chapter') == null ? 0 : Number(read('contrast-chapter')),
    themes
  };
}

async function run(host) {
  const win = host.getWin();
  const app = host.app;
  try {
    if (!win || win.isDestroyed()) throw new Error('对比度模式没有可用窗口');
    if (!win.isVisible()) win.show();
    win.focus(); // 采样不看焦点，但让窗口真显示出来，避免走离屏渲染的不同字体路径
    const { waitForRenderer } = require('./screenshot-driver');
    await waitForRenderer(win, 'Boolean(window.__cwTest && window.__cwTest.ready)', 20000);
    const cfg = contrastConfig(host.argValue);
    cfg.specs = SPECS;
    const script = buildContrastScript(cfg);
    const result = await win.webContents.executeJavaScript(script, true);
    if (result && result.ok && cfg.state !== false) {
      // 交互态（hover / active / disabled）要真实伪类，只能由主进程用 CDP 强制再逐组采样。
      try {
        const stateSamples = await collectStateSamples(win, cfg, result.themes || cfg.themes);
        result.samples = (result.samples || []).concat(stateSamples);
        result.stateCount = stateSamples.length;
      } catch (err) {
        result.stateError = String((err && err.stack) || err);
      }
    }
    console.log(`CONTRAST_RESULT ${JSON.stringify(result)}`);
    app.exit(result && result.ok ? 0 : 1);
  } catch (err) {
    console.error('[contrast] 失败:', err && err.stack ? err.stack : err);
    console.log(
      `CONTRAST_RESULT ${JSON.stringify({ ok: false, error: String((err && err.stack) || err) })}`
    );
    app.exit(1);
  }
}

module.exports = {
  SPECS,
  STATE_TARGETS,
  run,
  contrastScenario,
  stateSampleScenario,
  buildContrastScript,
  buildStateScript,
  collectStateSamples,
  contrastConfig
};
