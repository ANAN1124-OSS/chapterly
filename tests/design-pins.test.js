// 2026-11-04 拍板视觉项 · 静态钉子（长跑 b7 的「测试补齐」）
//
// 为什么还要这一份：b1 / b4 / b5 那几批已经给每项补了 E2E 几何断言（书架封顶、F11 键帽、朗读条 28px、
// 历史分栏……），但 E2E 量的是「窗口里的实际像素」，受窗口尺寸、字体、滚动条宽度影响，偶发一次就被当成
// 环境问题重跑；而这几项**只由 CSS / index.html 的几行决定**，真正怕的是「以后有人顺手把这行删了」。
// 所以这里用源码闸门钉住「决定本身」：改回去（或改数字）立即红，一眼看出是哪一项的拍板被人动了。
//
// 口径：只钉**决定**（排行号无关的结构 + 关键数值 + 关系），不钉注释措辞、不钉格式化，
// 避免「改一句注释就要改测试」。其余 12 项（#1 千分位、#3 设置 ×、#6 toast 抬起、#8 询问框顺序、
// #9 灵感箱分组、#16a/b/c 键盘）已经在各自的域单测里有行为 / 静态闸门，这里不重复。
//
// 2026-11-08 追加（1.3.0 T2 = 规范 T-09 路线 A）：标点挤压只做「显式声明」——正文 / 标记层 /
// 打字机测量层 / 阅读容器四处都写 text-spacing-trim: normal，且不许出现 T-14 禁用的未实现值
//（trim-both / trim-all / auto）。这一条没有行为可测（当前无视觉变化），只能钉源码决定。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CSS = read('renderer/styles.css');
const HTML = read('renderer/index.html');

// 取一个选择器规则块（`选择器 { … }`，非贪婪到第一个 `}`；本文件的规则里没有嵌套花括号）。
// 允许选择器前面有缩进（@media 里的规则是缩进两格的），也允许单行规则（`{ flex-direction: row; }`）。
function ruleOf(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(^|\\n)[ \\t]*${escaped}[ \\t]*\\{([\\s\\S]*?)\\}`).exec(source);
  return match ? match[2] : '';
}

// 取一个 @media 块（本文件的 @media 都是一层、内部规则不嵌套 @media）
function mediaOf(source, query) {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = source.indexOf(`@media ${query}`);
  if (start < 0) return '';
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return '';
}

test('#2 宽屏书架内容封顶：@media (min-width:1600px) 把 .shelf-body 封到 1576px 居中（= 1520 网格 + 28×2 + 10 滚动条槽）', () => {
  const block = mediaOf(CSS, '(min-width: 1600px)');
  assert.ok(block, 'styles.css 里必须有 @media (min-width: 1600px) 这一段（拍板 #2）');
  const body = ruleOf(block, '.shelf-body');
  assert.ok(body, '这段里必须有 .shelf-body 规则（封顶的就是它，不是 .shelf-scroll）');
  assert.match(body, /max-width:\s*1576px;/, '.shelf-body 必须封到 1576px（1520 网格 + 28×2 边距 + 10 常驻滚动条槽）');
  assert.match(body, /margin-left:\s*auto;/, '必须居中（左 auto）');
  assert.match(body, /margin-right:\s*auto;/, '必须居中（右 auto）');
  // 底栏跟内容同一条左边缘：padding 用同一个 1576 常量算，不能写死
  const footer = ruleOf(block, '.shelf-footer');
  assert.ok(footer, '这段里必须有 .shelf-footer 规则（发丝线要跟着内容对齐）');
  assert.match(footer, /padding-left:\s*calc\(28px \+ max\(0px, \(100% - 1576px\) \/ 2\)\);/, '底栏左边距必须与封顶后的内容对齐');
  assert.match(footer, /padding-right:\s*calc\(28px \+ max\(0px, \(100% - 1576px\) \/ 2\)\);/, '底栏右边距必须对称');
});

test('#5 专注退出条：Esc / F11 两个键帽并排，键帽间隔 4px', () => {
  const button = /<button id="btn-focus-exit"[\s\S]*?<\/button>/.exec(HTML);
  assert.ok(button, 'index.html 里必须有专注退出按钮 #btn-focus-exit');
  assert.match(button[0], /<span class="focus-kbd">Esc<\/span>/, '退出条要显示 Esc 键帽');
  assert.match(button[0], /<span class="focus-kbd">F11<\/span>/, '拍板 #5：退出条也要显示 F11 键帽（Esc 之外还能按 F11 退出）');
  assert.match(button[0], /title="[^"]*F11[^"]*"/, '按钮 title 也要提到 F11，否则鼠标用户不知道');
  const kbd = ruleOf(CSS, '.focus-kbd');
  assert.ok(kbd, 'styles.css 必须有 .focus-kbd 键帽样式');
  const pair = ruleOf(CSS, '.focus-kbd + .focus-kbd');
  assert.ok(pair, '两个键帽并排时必须有 .focus-kbd + .focus-kbd 的间距规则');
  assert.match(pair, /margin-left:\s*4px;/, '键帽间距是 4px（拍板值）');
});

test('#7 朗读条控件统一 28px：按钮与下拉同高，× 关闭键不在内', () => {
  const buttons = ruleOf(CSS, '.tts-bar .btn:not(.tts-close)');
  assert.ok(buttons, '朗读条按钮必须有 .tts-bar .btn:not(.tts-close) 规则（× 关闭键不能被一起拉高）');
  assert.match(buttons, /height:\s*28px;/, '朗读条按钮高度 = 28px（拍板 #7）');
  assert.match(buttons, /min-height:\s*28px;/, 'min-height 也要写，否则 .btn 的基准会顶回去');
  const inputs = ruleOf(CSS, '.tts-bar .text-input');
  assert.ok(inputs, '朗读条下拉必须有 .tts-bar .text-input 规则');
  assert.match(inputs, /height:\s*28px;/, '下拉高度 = 28px，与按钮齐平');
  assert.match(inputs, /min-height:\s*28px;/);
  // 反向：28px 的规则不许漏掉 :not(.tts-close) 去命中关闭键（改回 `.tts-bar .btn` 就会红）
  assert.equal(ruleOf(CSS, '.tts-bar .btn'), '', '不许出现不分按钮类型的 .tts-bar .btn 规则（会连 × 一起拉高）');
});

test('#13 历史预览宽窗左右分栏：.history-main 做 flex 容器，≥980 列表 58% / 预览 40%，窄窗回落上下', () => {
  // DOM：列表与预览都在 .history-main 里（顺序不变，只多一层布局容器）
  const mainAt = HTML.indexOf('class="history-main"');
  assert.ok(mainAt > 0, 'index.html 里必须有 .history-main 布局容器（拍板 #13）');
  const listAt = HTML.indexOf('history-list', mainAt);
  const previewAt = HTML.indexOf('history-preview', mainAt);
  assert.ok(listAt > mainAt, '历史列表必须在 .history-main 里面');
  assert.ok(previewAt > mainAt, '历史预览必须在 .history-main 里面');
  assert.ok(listAt < previewAt, 'DOM 顺序保持「列表在前、预览在后」（Tab 顺序不变）');
  // CSS：窄窗竖排（默认），宽窗横排 + 比例
  const main = ruleOf(CSS, '.history-main');
  assert.ok(main, 'styles.css 必须有 .history-main 基础规则');
  assert.match(main, /display:\s*flex;/, '默认是 flex 容器');
  assert.match(main, /flex-direction:\s*column;/, '窄窗（<980）回落上下排');
  const wide = mediaOf(CSS, '(min-width: 980px)');
  assert.ok(wide, 'styles.css 里必须有 @media (min-width: 980px) 这一档（应用最小宽 960，分栏从 980 起）');
  assert.match(ruleOf(wide, '.history-main'), /flex-direction:\s*row;/, '≥980 改成左右排');
  assert.match(ruleOf(wide, '.history-scroll'), /flex:\s*1 1 58%;/, '列表占 58%');
  assert.match(ruleOf(wide, '.history-preview'), /flex:\s*0 0 40%;/, '预览占 40%');
});

test('T-09 标点挤压显式声明：正文 / 标记层 / 打字机测量层 / 阅读容器四处都写 text-spacing-trim: normal（路线 A，无视觉变化）', () => {
  // 四处必须和 text-autospace（T-08）在同一批规则里：标记影子层 / 打字机测量层是「跟着正文量」的，
  // 少写一处就会和正文走不同的排版口径。值只许 normal —— 规范 T-14 明确禁用尚未实现的值。
  const selectors = ['.editor', '.editor-marks', '.focus-mirror', '.reading-chapter-text'];
  for (const selector of selectors) {
    const block = ruleOf(CSS, selector);
    assert.ok(block, `styles.css 里必须有 ${selector} 规则`);
    assert.match(
      block,
      /text-spacing-trim:\s*normal;/,
      `${selector} 必须显式声明 text-spacing-trim: normal（T-09 路线 A 只做显式声明，不靠继承默认值）`
    );
  }
  // 反向闸门：全表只允许这 4 条声明、值只允许 normal（T-14：trim-both / trim-all / auto 尚未被浏览器实现，
  // 写上去等于静默失效还骗过审计）。
  const declarations = CSS.match(/text-spacing-trim\s*:\s*[^;}]+/g) || [];
  assert.equal(
    declarations.length,
    selectors.length,
    `text-spacing-trim 只允许这 ${selectors.length} 处声明（多出来就是第二套来源）`
  );
  for (const declaration of declarations) {
    assert.match(declaration, /:\s*normal$/, `text-spacing-trim 只允许 normal（T-14 禁用的值：${declaration}）`);
  }
});

test('I-06 空状态三件套：书架 / 章节栏 / 剪贴板 / 查找四处都有说明状态 + 学习线索 + 直接路径，且标注 loading / vacuum / filtered', () => {
  // 1.3.0 T4 的验收方式：空态是纯文案 + 少量 DOM，行为在 E2E 里只有「出现 / 收起」，
  // 真正怕的是以后顺手把「为什么空 / 接下来点哪」删成一句「暂无内容」。这里按源码钉住四处的
  // 三件套与三类标注；同时钉住「不加插画」——四处空态都不许 new Image / <img。
  const RENDERER = read('renderer/renderer.js');
  const BOOKINFO = read('renderer/bookinfo-ui.js');
  const SHELF_FILTER = read('renderer/shelf-filter-ui.js');
  const FIND = read('renderer/find-ui.js');
  const CAPTURE = read('renderer/capture-ui.js');

  // ① 书架：真空 / 筛选空 / 加载中三类都用 data-empty-kind 标出来，文案各含状态 + 线索 + 路径。
  assert.match(BOOKINFO, /empty\.dataset\.emptyKind = 'vacuum';/);
  assert.match(BOOKINFO, /empty\.dataset\.emptyKind = 'filtered';/);
  assert.match(BOOKINFO, /empty\.dataset\.emptyKind = 'loading';/);
  assert.match(BOOKINFO, /这里还没有书。一本书 = 一个文件夹/);
  assert.match(BOOKINFO, /点右上「导入小说」/);
  assert.match(BOOKINFO, /正在正文里继续找，找到后会出现在上方「正文命中」/);
  assert.match(BOOKINFO, /搜索会看书名 \/ 作者 \/ 分组 \/ 标签 \/ 章节名，也会在正文里找/);

  // ② 章节栏：真空（0 章）——现有按钮 / Ctrl+N 是直接路径，章节模板是学习线索。
  assert.match(RENDERER, /if \(!state\.chapters\.length\) \{/);
  assert.match(RENDERER, /className = 'chapter-list-empty muted small'/);
  assert.match(RENDERER, /empty\.dataset\.emptyKind = 'vacuum'/);
  assert.match(RENDERER, /点左下「＋ 新建章节」或按 Ctrl\+N/);
  assert.match(RENDERER, /新章会自动套用设置里的章节模板/);
  assert.match(CSS, /\.chapter-list-empty\s*\{[\s\S]*?padding:\s*22px 8px;/);

  // ③ 剪贴板：真空——summary 说明只驻内存，空态给设置路径 / 快捷键 / 两个动作。
  assert.match(CAPTURE, /本次运行还没有记到复制过的文字（只在本机内存，关闭应用即清空）。/);
  assert.match(CAPTURE, /在「设置 → 写作统计」里打开「后台监听剪贴板」后/);
  assert.match(CAPTURE, /按 Ctrl\+Alt\+V 捕获当前剪贴板的一段/);
  assert.match(CAPTURE, /点「正文」或「章节」处理，处理完就从列表移除/);
  assert.match(CAPTURE, /emptyEl\.dataset\.emptyKind = empty \? 'vacuum' : ''/);

  // ④ 查找无结果 + 书架正文命中空态：筛选空——学习线索是「字面匹配 / 全角半角」，
  // 直接路径是换词 / 选中正文再按 Ctrl+F / Esc 清空，全部沿用现有入口。
  assert.match(FIND, /empty\.className = 'find-empty'/);
  assert.match(FIND, /empty\.dataset\.emptyKind = 'filtered'/);
  assert.match(FIND, /查找是字面匹配（不做正则），区分全角 \/ 半角/);
  assert.match(FIND, /先在正文里选中一个词再按 Ctrl\+F/);
  assert.match(SHELF_FILTER, /empty\.dataset\.emptyKind = 'filtered'/);
  assert.match(SHELF_FILTER, /换个更短或更具体的词再试/);
  assert.match(SHELF_FILTER, /按 Esc 清空搜索/);

  // 加插画 = 红（规范 I-06：不加插画、不做营销文案、不新增按钮；路径都用现有入口）。
  for (const source of [BOOKINFO, SHELF_FILTER, FIND, CAPTURE, RENDERER]) {
    assert.doesNotMatch(source, /createElement\(['"]img['"]\)/);
    assert.doesNotMatch(source, /new Image\(/);
  }
});

test('I-07 自绘标题栏：现有顶栏就是拖拽区、交互元素全部 no-drag、右上角按 env(titlebar-area-*) 让位', () => {
  // 1.3.0 T6 的验收方式是「真窗口里拖 / 双击 / Snap」，这些在 E2E 里量不了（要真实鼠标），
  // 所以这里按源码钉住三条决定：①拖拽区铺在现有顶栏上、不新增横栏；②按钮 / 输入框 / 下拉
  // 一律 no-drag（否则点不动）；③系统按钮区靠 env(titlebar-area-*) 让位，不写死像素。
  const MAIN = read('main.js');
  const RENDERER = read('renderer/renderer.js');

  // ① 拖拽区 = 现有顶栏（书架 / 写作页 / 阅读页 / 专注条），没有新增一条「标题栏」横栏
  assert.match(CSS, /\.topbar,\s*\n\.editor-header,\s*\n\.reading-header,\s*\n\.focus-bar \{ -webkit-app-region: drag; \}/);
  assert.match(CSS, /#editor-view\.focus-mode \.editor-main::before \{[\s\S]*?-webkit-app-region: drag;/, '专注模式顶栏藏起来了，正文上方的留白要能拖');
  // ② 交互元素退出拖拽区
  for (const selector of ['.topbar button', '.topbar input', '.topbar .topbar-actions', '.editor-header .btn', '.editor-header #btn-save', '.reading-header .btn', '.focus-bar .focus-btn']) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(CSS, new RegExp(`${escaped}[\\s\\S]{0,400}?-webkit-app-region: no-drag`), `${selector} 必须 no-drag`);
  }
  // ③ 让位规则：三个顶栏 + 专注条都读同一个 --titlebar-inset-right（由 env() 算），不写死 138px
  assert.match(CSS, /--titlebar-inset-right:\s*max\(0px, calc\(100vw - env\(titlebar-area-x, 0px\) - env\(titlebar-area-width, 100vw\)\)\);/);
  assert.match(CSS, /\.topbar \{[\s\S]*?padding-right:\s*calc\(26px \+ var\(--titlebar-inset-right, 0px\)\);/);
  assert.match(CSS, /\.editor-header \{[\s\S]*?padding-right:\s*calc\(20px \+ var\(--titlebar-inset-right, 0px\)\);/);
  assert.match(CSS, /\.reading-header \{[\s\S]*?padding-right:\s*calc\(22px \+ var\(--titlebar-inset-right, 0px\)\);/);
  assert.match(CSS, /\.focus-bar \{[\s\S]*?right:\s*calc\(18px \+ var\(--titlebar-inset-right, 0px\)\);/);
  assert.equal((CSS.match(/--titlebar-inset-right/g) || []).length >= 6, true, '让位只许读这一个变量');

  // 顶栏底色与窗口边缘同色（系统按钮区由主进程按 --paper 画，顶栏还是 --folio-sheet 会出现色块）
  assert.match(CSS, /\.editor-header \{[\s\S]*?background:\s*var\(--paper\);/);
  assert.match(CSS, /\.reading-header \{[\s\S]*?background:\s*var\(--paper\);/);

  // 主进程：隐藏原生标题栏 + 保留系统按钮 + 不引入 Mica / 亚克力
  assert.match(MAIN, /titleBarStyle: 'hidden'/);
  assert.match(MAIN, /titleBarOverlay: windowChrome\.overlayFor\(themeName\)/);
  assert.doesNotMatch(MAIN, /backgroundMaterial|vibrancy|setBackgroundMaterial/, '不引入 Mica / 亚克力（半透明破坏纸感）');

  // 失焦降级：body class + 2% 暗层 + 朱红降灰（两档，浅色 5 套共用 + 夜间单独）
  assert.match(RENDERER, /window\.CWWindowChromeUi\.createWindowChromeUi\(\)\.install\(\)/);
  assert.match(CSS, /body\.window-inactive \{\s*\n\s*--accent: #774940;\s*\n\s*--accent-soft: #a86e5e;/);
  assert.match(CSS, /body\.theme-night\.window-inactive \{\s*\n\s*--accent: #b8897b;\s*\n\s*--accent-soft: #986452;/);
  assert.match(CSS, /body\.window-inactive #app::after \{[\s\S]*?pointer-events: none;[\s\S]*?background:\s*rgba\(0, 0, 0, \.02\);/);

  // index.html 里 window-chrome-ui.js 必须排在 renderer.js 之前（renderer 启动时就要用）
  const scriptOrder = [...HTML.matchAll(/<script src="([^"]+)"><\/script>/g)].map((hit) => hit[1]);
  assert.ok(scriptOrder.indexOf('window-chrome-ui.js') > -1, 'index.html 必须加载 window-chrome-ui.js');
  assert.ok(scriptOrder.indexOf('window-chrome-ui.js') < scriptOrder.indexOf('renderer.js'), '必须排在 renderer.js 之前');
});
