'use strict';
// 章回 · 无障碍门禁二期（1.3.0 T8 / 《卷册规范 v2》A-03 / A-04）
//
// 干什么：把无障碍从「只量对比度」扩到 **WCAG 2.2 AA 的四条 + 主题令牌齐全**：
//   1. 2.5.8 目标尺寸：真实测量所有可点元素的盒子，≥24×24 CSS px；
//      小目标按 WCAG 的「间距例外」放行（24px 圆不与相邻目标相交），其余进显式允许清单（带原因 / 上限）。
//   2. 2.4.11 焦点不被遮挡：弹层 / 面板里逐个聚焦，量焦点框与视口 / 滚动容器 / 最上层命中的关系。
//   3. 2.5.7 拖动替代：章节排序的键盘替代 Alt+↑/↓ 接线与 E2E 断言（静态，不改产品）。
//   4. 3.3.7 不重复录入：人工走查（脚本不自动判），结论随报告输出并写进 README / 验收清单。
//   5. 6 套主题令牌键齐全：:root + 5 个 body.theme-* 都必须给齐「纸面身份」15 个令牌；
//      主题块里的额外令牌必须在 :root 有兜底，或只在带 fallback 的 var() 里用；主题名单四处一致。
//   6. APCA 影子参考（A-04）：只算、不判、不阻断（APCA-W3 是非商业 Beta 许可，不进产品）。
//
// 不作为门禁的：「关掉弹层后焦点归还给触发元素」——它已经由 `tests/dialog-focus.test.js`（纯决策
// 函数）与 E2E 的 Tab / Esc 用例钉住；动态复测对时序太敏感（同一段脚本在长序列里偶尔读到 body），
// 做成门禁会变成噪声，所以这里不测，只测 2.4.11 正文要求的「焦点不被遮挡」。
//
// 口径（改脚本前先读）：
//   * 实测用**真实 Electron + 真实渲染层**（DevTools Protocol 连上去，页面里 ?test=1 的钩子只用来摆状态），
//     书库与 userData 全在**系统临时目录**，跑完只留临时目录；绝不读写真实书架 / 真实配置。
//   * 目标尺寸看的是**有效目标盒**：checkbox / radio 套在 <label> 里时量 label 的盒子（点 label 也算点它）。
//   * 小目标两条出路：间距例外（WCAG 2.5.8 原文口径）或允许清单（带原因 + 条数上限，多一条就报红）。
//   * 允许清单只收「确实改不了 / 有替代路径」的，不收「懒得改」的；产品代码一行不改（T8 只做工具侧）。
//
// 用法：
//   node scripts/a11y-gate.js              # 静态 + 实测（阻断；有任何红就返回 1）
//   node scripts/a11y-gate.js --static     # 只跑静态（不需要 Electron，秒回）
//   node scripts/a11y-gate.js --report     # 实测照跑，但有红也只报告（不返回 1）
//   node scripts/a11y-gate.js --widths=1294,960 --json=shots/a11y-gate/x.json
//   node scripts/a11y-gate.js --help
//
// 退出码：0 = 全绿；1 = 有红（或被 --report 降级成「只报告」时永远 0）。

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const REPORT_DIR = path.join(ROOT, 'shots', 'a11y-gate');

// ---------- 门禁口径（常量） ----------

// WCAG 2.2 SC 2.5.8 的最小目标尺寸（CSS px）
const MIN_TARGET = 24;

// 6 套纸色主题：paper 是默认（:root），其余各有一个 body.theme-* 块。
const THEME_NAMES = Object.freeze(['paper', 'cream', 'green', 'kraft', 'grid', 'night']);

// 「纸面身份」令牌：换主题时**必须逐套给全**，否则某套主题会掉回上一套的纸色 / 线色。
// 依据：styles.css 里 5 个主题块本来都声明了这 15 个（2026-11-08 实测交集），这里把它固定成契约。
const REQUIRED_PALETTE = Object.freeze([
  '--paper',
  '--paper-soft',
  '--paper-deep',
  '--line',
  '--line-strong',
  '--input-bg',
  '--folio-sheet',
  '--folio-raised',
  '--folio-sunk',
  '--folio-line-soft',
  '--folio-field-border',
  '--folio-menu-bg',
  '--caret-para-tint',
  '--caret-para-edge',
  '--editor-caret'
]);

// 可点目标的判定范围（与 WCAG「pointer target」口径对齐：原生控件 + 显式角色 + 可聚焦容器）
const TARGET_SELECTOR = [
  'button',
  'a[href]',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[role="button"]',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

// 允许清单：真实测过、确实小于 24×24 且**有替代路径**的目标。
// 每行 = 选择器（id / class 列表 / path）+ 原因 + 允许条数上限（实测多了就报红，防止悄悄新增）。
// 空数组也行：全部靠间距例外过。加行必须有原因，且写进 验收清单 · V42。
// 1.4.0 P1：原来的唯一一条（书架搜索清除键 20×20）已经做到 24×24，清单回归空数组。
const TARGET_ALLOW = Object.freeze([]);

// 焦点检查的允许清单（默认空：先报告模式，测出来再决定要不要登记）。
const FOCUS_ALLOW = Object.freeze([]);

// 实测状态：每个状态 = 摆好界面 → 扫当前可见界面（可选：只在某个弹层范围里扫焦点）。
// 设置分区状态的 setup 生成器（1.4.0 P0-1）：门禁主流程停在写作页，打开设置 = 按书作用域（只有
// 「显示」）。这里点状态栏「今日字数」走与用户相同的入口 —— 它打开的是**全局设置**并定位到码字
// 日历（写作分区），然后再点目标分区。只轮询 DOM，不注入 <style>、不改产品状态。
const settingsTabSetup = (tab) => `(() => {
  document.getElementById('status-stats').click();
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      const bd = document.getElementById('settings-backdrop');
      const writing = document.getElementById('settings-tab-writing');
      const target = document.getElementById('settings-tab-${tab}');
      const open = bd && !bd.classList.contains('hidden');
      if (open && writing && writing.getAttribute('aria-selected') === 'true' && target) {
        if (target.getAttribute('aria-selected') !== 'true') target.click();
        resolve(true);
        return;
      }
      if (Date.now() - startedAt > 8000) {
        reject(new Error('设置分区 setup 超时：${tab}'));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
})()`;

const STATES = [
  {
    id: 'shelf',
    label: '书架',
    setup: null,
    wait: "window.__cwTest.view() === 'shelf'",
    teardown: null
  },
  {
    id: 'shelfSearch',
    label: '书架（搜索态）',
    setup: "window.__cwTest.setShelfQuery('门禁')",
    wait: "window.__cwTest.shelfQuery() === '门禁'",
    teardown: "window.__cwTest.setShelfQuery('')"
  },
  {
    id: 'editor',
    label: '写作页',
    setup: 'window.__cwTest.openBookPath(__BOOK__)',
    wait: "window.__cwTest.view() === 'editor'",
    teardown: null
  },
  {
    id: 'focusMode',
    label: '专注模式',
    setup: 'window.__cwTest.focusToggle()',
    wait: 'Boolean(window.__cwTest.focusState().on)',
    teardown: 'window.__cwTest.focusToggle()'
  },
  {
    id: 'settings',
    label: '设置弹层',
    setup: 'window.__cwTest.openSettings()',
    wait: 'window.__cwTest.settingsOpen() === true',
    teardown: 'window.__cwTest.closeSettings()',
    focusScope: '#settings-backdrop'
  },
  // 1.4.0 P0-1：设置改成「左导航 + 单分区」后，一次只渲染一个分区；其余四个分区各扫一遍，
  // 保证原来 423 条目标里的设置项一条都没从门禁里掉出去（不降判据、也不靠隐藏控件蒙混过关）。
  {
    id: 'settingsWriting',
    label: '设置弹层（写作分区）',
    // 主流程此时停在写作页（打开设置 = 按书作用域，只有「显示」）：先走状态栏算日历入口拿
    // 「全局作用域 + 写作分区」，再逐个点其它分区，四个分区的控件都能被门禁扫到。
    setup: settingsTabSetup('writing'),
    wait:
      "window.__cwTest.settingsOpen() === true && window.__cwTest.settingsScope() === 'global' && document.getElementById('settings-tab-writing').getAttribute('aria-selected') === 'true'",
    teardown: 'window.__cwTest.closeSettings()',
    focusScope: '#settings-backdrop'
  },
  {
    id: 'settingsContent',
    label: '设置弹层（内容分区）',
    // 主流程此时停在写作页（打开设置 = 按书作用域，只有「显示」）：先走状态栏算日历入口拿
    // 「全局作用域 + 写作分区」，再逐个点其它分区，四个分区的控件都能被门禁扫到。
    setup: settingsTabSetup('content'),
    wait:
      "window.__cwTest.settingsOpen() === true && window.__cwTest.settingsScope() === 'global' && document.getElementById('settings-tab-content').getAttribute('aria-selected') === 'true'",
    teardown: 'window.__cwTest.closeSettings()',
    focusScope: '#settings-backdrop'
  },
  {
    id: 'settingsData',
    label: '设置弹层（数据分区）',
    // 主流程此时停在写作页（打开设置 = 按书作用域，只有「显示」）：先走状态栏算日历入口拿
    // 「全局作用域 + 写作分区」，再逐个点其它分区，四个分区的控件都能被门禁扫到。
    setup: settingsTabSetup('data'),
    wait:
      "window.__cwTest.settingsOpen() === true && window.__cwTest.settingsScope() === 'global' && document.getElementById('settings-tab-data').getAttribute('aria-selected') === 'true'",
    teardown: 'window.__cwTest.closeSettings()',
    focusScope: '#settings-backdrop'
  },
  {
    id: 'settingsAbout',
    label: '设置弹层（关于分区）',
    // 主流程此时停在写作页（打开设置 = 按书作用域，只有「显示」）：先走状态栏算日历入口拿
    // 「全局作用域 + 写作分区」，再逐个点其它分区，四个分区的控件都能被门禁扫到。
    setup: settingsTabSetup('about'),
    wait:
      "window.__cwTest.settingsOpen() === true && window.__cwTest.settingsScope() === 'global' && document.getElementById('settings-tab-about').getAttribute('aria-selected') === 'true'",
    teardown: 'window.__cwTest.closeSettings()',
    focusScope: '#settings-backdrop'
  },
  {
    id: 'find',
    label: '查找弹层',
    setup: 'window.__cwTest.openFindPanel()',
    wait: 'window.__cwTest.findPanelOpen() === true',
    teardown: 'window.__cwTest.closeFindPanel()',
    focusScope: '#find-backdrop'
  },
  {
    id: 'export',
    label: '导出范围弹层',
    setup:
      "document.getElementById('btn-export').click();" +
      "document.querySelector('#export-menu button[data-action=\"txt\"]').click()",
    wait: 'window.__cwTest.exportDialogOpen() === true',
    teardown: "document.getElementById('btn-export-cancel').click()",
    focusScope: '#export-backdrop'
  },
  {
    id: 'history',
    label: '本书历史弹层',
    setup: 'window.__cwTest.openHistoryForCurrentBook()',
    wait: 'window.__cwTest.historyOpen() === true',
    teardown: 'window.__cwTest.closeHistory()',
    focusScope: '#history-backdrop'
  },
  {
    id: 'bookinfo',
    label: '书籍信息弹层',
    setup: 'window.__cwTest.openBookInfoForPath(__BOOK__)',
    wait: 'window.__cwTest.bookInfoDialogOpen() === true',
    teardown: 'window.__cwTest.closeBookInfoDialog()',
    focusScope: '#bookinfo-backdrop'
  },
  {
    id: 'fragments',
    label: '插入碎片弹层',
    setup: 'window.__cwTest.openInsertFragmentDialog()',
    wait: 'window.__cwTest.insertFragmentDialogOpen() === true',
    teardown: 'window.__cwTest.closeInsertFragmentDialog()',
    focusScope: '#fragments-backdrop'
  },
  {
    id: 'capture',
    label: '剪贴板捕获弹层',
    setup: "window.__cwTest.openCapture('门禁样本：从剪贴板捕获的一段正文。')",
    wait: 'window.__cwTest.captureOpen() === true',
    teardown: 'window.__cwTest.closeCapture()',
    focusScope: '#capture-backdrop'
  },
  {
    // 1.5.0 功能-4：`?` 快捷键一览。用真实全局 keydown 打开（编辑区失焦后 `?` 才接），
    // 收起走右上「×」按钮（不依赖 Esc 链，量的是弹层本身的目标 / 焦点）。
    id: 'shortcuts',
    label: '快捷键一览弹层',
    setup:
      "document.getElementById('editor').blur();" +
      "document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true }))",
    wait: "document.getElementById('shortcuts-backdrop').classList.contains('hidden') === false",
    teardown: "document.getElementById('btn-shortcuts-close').click()",
    focusScope: '#shortcuts-backdrop'
  },
  {
    id: 'reading',
    label: '阅读模式',
    setup: 'window.__cwTest.openReading()',
    wait: 'window.__cwTest.readingViewVisible() === true',
    teardown: 'window.__cwTest.closeReading()',
    focusScope: '#reading-view'
  },
  {
    id: 'tts',
    label: '朗读条',
    setup: 'window.__cwTest.ttsInstallFakeSpeech(); window.__cwTest.ttsOpen({ autoplay: false })',
    wait: 'window.__cwTest.ttsBarOpen() === true',
    teardown: 'window.__cwTest.ttsClose()',
    focusScope: '#tts-bar'
  },
  {
    id: 'jump',
    label: '跳章弹层',
    setup: 'window.__cwTest.openJumpDialog()',
    wait: 'window.__cwTest.jumpDialogOpen() === true',
    teardown: 'window.__cwTest.closeJumpDialog()',
    focusScope: '#jump-backdrop'
  },
  {
    id: 'format',
    label: '排版弹层',
    setup: 'window.__cwTest.openFormatDialog()',
    wait: 'window.__cwTest.formatDialogOpen() === true',
    teardown: "document.getElementById('btn-format-cancel').click()",
    focusScope: '#format-backdrop'
  },
  {
    id: 'proofread',
    label: '校对弹层',
    setup: 'window.__cwTest.openProofreadPanel()',
    wait: 'window.__cwTest.proofreadPanelOpen() === true',
    teardown: 'window.__cwTest.closeProofreadPanel()',
    focusScope: '#proofread-backdrop'
  },
  {
    id: 'sensitive',
    label: '敏感词弹层',
    setup: 'window.__cwTest.openSensitivePanel()',
    wait: 'window.__cwTest.sensitivePanelOpen() === true',
    teardown: 'window.__cwTest.closeSensitivePanel()',
    focusScope: '#sensitive-backdrop'
  }
];

// 只在窄窗复扫的状态（布局在窄窗会变：顶栏折行、章节栏收窄、设置弹层改单列）
const NARROW_STATES = Object.freeze(['shelf', 'editor', 'settings']);

const DEFAULTS = {
  staticOnly: false,
  report: false,
  widths: [1294, 960],
  json: null,
  timeout: 180000,
  help: false
};

// ---------- 静态：CSS 解析 ----------

// 去掉 /* */ 注释（本项目 CSS 的注释里没有字符串，够用；字符串里的注释样式在下面的扫描里另判）。
function stripCssComments(text) {
  return String(text || '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// 顶层规则扫描：返回 [{ selector, body }]，selector 去空白、body 是花括号里的原文。
// 嵌套规则（@media / @supports 里面的）不单独返回——主题令牌都写在顶层。
function parseCssBlocks(cssText) {
  const text = stripCssComments(cssText);
  const blocks = [];
  let i = 0;
  let start = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === '{') {
      const selector = text.slice(start, i).trim();
      let depth = 1;
      let j = i + 1;
      while (j < text.length && depth > 0) {
        const c = text[j];
        if (c === '"' || c === "'") {
          const q = c;
          j += 1;
          while (j < text.length && text[j] !== q) {
            if (text[j] === '\\') j += 1;
            j += 1;
          }
          j += 1;
          continue;
        }
        if (c === '{') depth += 1;
        else if (c === '}') depth -= 1;
        j += 1;
      }
      blocks.push({ selector, body: text.slice(i + 1, j - 1) });
      i = j;
      start = j;
      continue;
    }
    if (ch === '}') start = i + 1;
    i += 1;
  }
  return blocks;
}

// 一段声明里声明的自定义属性名（排序、去重）。
function declarationKeys(body) {
  const keys = [];
  for (const raw of String(body || '').split(';')) {
    const hit = /^\s*(--[A-Za-z0-9-]+)\s*:/.exec(raw);
    if (hit && !keys.includes(hit[1])) keys.push(hit[1]);
  }
  return keys.sort();
}

// 这个令牌有没有「带兜底」的 var() 用法（var(--x, fallback)）——有的话主题块可以只给自己的主题加，
// 其他主题落到兜底值，不算缺键。
function hasFallbackUsage(cssText, key) {
  const escaped = key.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
  return new RegExp(`var\\(\\s*${escaped}\\s*,`).test(stripCssComments(cssText));
}

function themeBlocksOf(cssText) {
  const blocks = parseCssBlocks(cssText);
  const root = blocks.filter((block) => block.selector === ':root');
  const themes = {};
  for (const block of blocks) {
    const hit = /^body\.theme-([a-z-]+)$/.exec(block.selector);
    if (hit) themes[hit[1]] = block;
  }
  return { root, themes, blocks };
}

// 6 套主题的「纸面身份」令牌是否齐全 + 主题块额外令牌是否有兜底。
function themeTokenReport(cssText, options = {}) {
  const required = options.required || REQUIRED_PALETTE;
  const themes = options.themes || THEME_NAMES;
  const { root, themes: blocks } = themeBlocksOf(cssText);
  const problems = [];
  if (root.length !== 1) {
    problems.push(`:root 块应当只有 1 个，实际 ${root.length} 个`);
  }
  const rootKeys = declarationKeys(root.length ? root[0].body : '');
  const missingRoot = required.filter((key) => !rootKeys.includes(key));
  if (missingRoot.length) problems.push(`:root 缺纸面令牌：${missingRoot.join(' / ')}`);

  const report = { paper: { declared: rootKeys.length, missing: missingRoot, extraWithoutFallback: [] } };
  for (const name of themes) {
    if (name === 'paper') continue;
    const block = blocks[name];
    if (!block) {
      problems.push(`styles.css 里没有 body.theme-${name} 块`);
      continue;
    }
    const keys = declarationKeys(block.body);
    const missing = required.filter((key) => !keys.includes(key));
    const extra = keys.filter((key) => !rootKeys.includes(key));
    const withoutFallback = extra.filter((key) => !hasFallbackUsage(cssText, key));
    if (missing.length) problems.push(`body.theme-${name} 缺纸面令牌：${missing.join(' / ')}`);
    if (withoutFallback.length) {
      problems.push(
        `body.theme-${name} 定义了 :root 没有的令牌且没有带 fallback 的用法：${withoutFallback.join(' / ')}`
      );
    }
    report[name] = { declared: keys.length, missing, extraWithoutFallback: withoutFallback };
  }
  const unknown = Object.keys(blocks).filter((name) => !themes.includes(name));
  if (unknown.length) problems.push(`styles.css 里有名单外的主题块：${unknown.join(' / ')}`);
  return { ok: problems.length === 0, problems, report };
}

// ---------- 静态：主题名单四处一致 ----------

function themeNamesFromChrome(source) {
  const hit = /const\s+THEMES\s*=\s*Object\.freeze\(\{([\s\S]*?)\n\s*\}\);/.exec(String(source || ''));
  if (!hit) return null;
  return Array.from(hit[1].matchAll(/^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*Object\.freeze\(/gm)).map(
    (item) => item[1]
  );
}

function themeNamesFromContrast(source) {
  const hit = /const\s+THEMES\s*=\s*\[([^\]]*)\]/.exec(String(source || ''));
  if (!hit) return null;
  return Array.from(hit[1].matchAll(/'([a-z-]+)'|"([a-z-]+)"/g)).map((item) => item[1] || item[2]);
}

function themeNamesFromIndexHtml(html) {
  const text = String(html || '');
  const start = text.indexOf('id="settings-paper"');
  if (start < 0) return null;
  const end = text.indexOf('</select>', start);
  if (end < 0) return null;
  return Array.from(text.slice(start, end).matchAll(/<option\s+value="([a-z-]+)"/g)).map((m) => m[1]);
}

function themeListReport(sources) {
  const expected = (sources.themes || THEME_NAMES).slice().sort();
  const found = {
    'core/window-chrome.js': sources.chrome,
    'scripts/contrast.js': sources.contrast,
    'renderer/index.html#settings-paper': sources.indexHtml
  };
  const problems = [];
  for (const [name, list] of Object.entries(found)) {
    if (!list) {
      problems.push(`${name}：没解析到主题名单`);
      continue;
    }
    const sorted = list.slice().sort();
    if (sorted.join(',') !== expected.join(',')) {
      problems.push(`${name}：主题名单 ${sorted.join('/')} != 期望 ${expected.join('/')}`);
    }
  }
  return { ok: problems.length === 0, problems, expected, found };
}

// ---------- 静态：2.5.7 拖动替代 / 3.3.7 不重复录入 ----------

function keyboardAlternativeReport(sources) {
  const checks = [
    ['renderer/list-keyboard.js', /onAltMove/, '章节列表接管 Alt+↑/↓'],
    ['renderer/list-keyboard.js', /ArrowUp/, 'list-keyboard 里有 ArrowUp 分支'],
    ['renderer/renderer.js', /onAltMove/, '章节列表把 onAltMove 接到 moveChapterStep'],
    ['renderer/renderer.js', /function\s+moveChapterStep/, 'moveChapterStep 存在'],
    ['scripts/e2e/groups/27-drag-sort.js', /Alt\+↓/, 'E2E 有 Alt+↓ 挪章断言'],
    ['scripts/e2e/groups/27-drag-sort.js', /Alt\+↑/, 'E2E 有 Alt+↑ 挪章断言']
  ];
  const problems = [];
  const rows = [];
  for (const [file, pattern, label] of checks) {
    const text = sources[file];
    const ok = typeof text === 'string' && pattern.test(text);
    rows.push({ file, label, ok });
    if (!ok) problems.push(`${file}：${label}（找不到 ${pattern}）`);
  }
  return { ok: problems.length === 0, problems, rows };
}

// ---------- 2.5.8 目标尺寸判定（纯函数，单测覆盖） ----------

function classListOf(entry) {
  if (Array.isArray(entry.classes)) return entry.classes;
  return String(entry.cls || '')
    .split(/\s+/)
    .filter(Boolean);
}

function matchAllow(entry, row) {
  if (!row) return false;
  if (row.id && entry.id === row.id) return true;
  if (row.path && entry.path === row.path) return true;
  if (row.cls) {
    const wanted = String(row.cls)
      .split('.')
      .map((item) => item.trim())
      .filter(Boolean);
    const have = classListOf(entry);
    if (wanted.length && wanted.every((name) => have.includes(name))) return true;
  }
  if (row.tag && String(entry.tag).toLowerCase() === String(row.tag).toLowerCase()) return true;
  return false;
}

function centerOf(item) {
  return { cx: item.x + item.w / 2, cy: item.y + item.h / 2 };
}

// 圆心到矩形最近点的距离（矩形外为正值，矩形内为 0）
function centerToRect(center, rect) {
  const nx = Math.max(rect.x, Math.min(center.cx, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(center.cy, rect.y + rect.h));
  return Math.hypot(center.cx - nx, center.cy - ny);
}

// items：扫描结果（含 x / y / w / h）；allow：允许清单
// 判定：≥24×24 → ok；允许清单命中 → allow；否则看间距例外（24px 圆不与别的目标相交）→ spacing；都不满足 → fail。
function evaluateTargets(items, options = {}) {
  const min = Number(options.min) > 0 ? Number(options.min) : MIN_TARGET;
  const radius = min / 2;
  const allow = options.allow || [];
  const allowUsage = new Map();
  const results = [];
  for (const item of items) {
    if (item.w >= min && item.h >= min) {
      results.push({ ...item, verdict: 'ok' });
      continue;
    }
    const row = allow.find((candidate) => matchAllow(item, candidate));
    if (row) {
      allowUsage.set(row, (allowUsage.get(row) || 0) + 1);
      results.push({ ...item, verdict: 'allow', reason: row.reason || '' });
      continue;
    }
    if (item.nested) {
      // 被更大的可点祖先包住（点它等于点祖先）：按祖先的盒子算，不重复判。
      results.push({ ...item, verdict: 'covered' });
      continue;
    }
    const center = centerOf(item);
    let blocker = null;
    for (const other of items) {
      if (other === item) continue;
      if (other.nested) continue;
      // 间距例外只在同一层里比：弹层盖住页面时，页面上那块大字正文不算「相邻目标」。
      if (item.layer && other.layer && item.layer !== other.layer) continue;
      const otherCenter = centerOf(other);
      const centerDistance = Math.hypot(center.cx - otherCenter.cx, center.cy - otherCenter.cy);
      if (centerDistance < min) {
        blocker = { path: other.path, why: `与相邻目标中心距 ${centerDistance.toFixed(1)}px < ${min}px` };
        break;
      }
      const distance = centerToRect(center, other);
      if (distance < radius) {
        blocker = { path: other.path, why: `24px 圆与相邻目标重叠（${distance.toFixed(1)}px）` };
        break;
      }
    }
    results.push({ ...item, verdict: blocker ? 'fail' : 'spacing', blocker });
  }

  const count = (verdict) => results.filter((item) => item.verdict === verdict).length;
  const problems = [];
  for (const result of results) {
    if (result.verdict === 'fail') {
      problems.push(
        `${result.path}：${result.w}×${result.h} < ${min}×${min}` +
          (result.blocker ? `；${result.blocker.why}（相邻 ${result.blocker.path}）` : '')
      );
    }
  }
  for (const row of allow) {
    const used = allowUsage.get(row) || 0;
    const max = Number(row.max);
    if (Number.isFinite(max) && used > max) {
      problems.push(
        `允许清单 ${row.id || row.cls || row.path}：实测 ${used} 条 > 上限 ${max}（新增了同类小目标，要么改大，要么补进清单并写原因）`
      );
    }
  }
  const allowUsageRows = allow.map((row) => ({
    key: row.id || row.cls || row.path || '(未命名)',
    used: allowUsage.get(row) || 0
  }));
  return {
    ok: problems.length === 0,
    problems,
    total: results.length,
    okCount: count('ok'),
    spacingCount: count('spacing'),
    allowCount: count('allow'),
    coveredCount: count('covered'),
    failCount: count('fail'),
    smallCount: results.filter((item) => item.w < min || item.h < min).length,
    allowUsage: allowUsageRows,
    results
  };
}

// ---------- 2.4.11 焦点判定（纯函数，单测覆盖） ----------

// entries：每项 { path, focused, inViewport, clippedBy, coveredBy, rect:{x,y,w,h} }
// 判定：能聚焦、焦点框完整落在视口与所有滚动容器可视区内、中心点最上层命中自己（或自己的后代 / 祖先）。
function evaluateFocus(entries, options = {}) {
  const allow = options.allow || [];
  const results = [];
  const problems = [];
  for (const entry of entries) {
    const row = allow.find((candidate) => matchAllow(entry, candidate));
    if (row) {
      results.push({ ...entry, verdict: 'allow', reason: row.reason || '' });
      continue;
    }
    const reasons = [];
    if (!entry.focused) reasons.push('无法聚焦');
    if (entry.focused && entry.inViewport === false) reasons.push('焦点框超出视口');
    if (entry.clippedBy) reasons.push(`被滚动容器裁切（${entry.clippedBy}）`);
    if (entry.coveredBy) reasons.push(`被上层元素盖住（${entry.coveredBy}）`);
    if (reasons.length) {
      problems.push(`${entry.path}：${reasons.join('；')}`);
      results.push({ ...entry, verdict: 'fail', reasons });
    } else {
      results.push({ ...entry, verdict: 'ok' });
    }
  }
  return {
    ok: problems.length === 0,
    problems,
    total: results.length,
    okCount: results.filter((item) => item.verdict === 'ok').length,
    failCount: results.filter((item) => item.verdict === 'fail').length,
    allowCount: results.filter((item) => item.verdict === 'allow').length,
    results
  };
}

// ---------- APCA 影子参考（A-04：只算不判） ----------

function parseHexColor(value) {
  const text = String(value || '').trim();
  const hit = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (!hit) return null;
  let hex = hit[1];
  if (hex.length === 3) hex = hex.split('').map((ch) => ch + ch).join('');
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16)
  };
}

// APCA-W3 0.1.9 的公开算式（sRGB → 亮度 Y，再做软钳位与 BoW / WoB 两条分支）。
// 参考值：黑字白底 Lc≈106、白字黑底 Lc≈-108。这里只当「影子参考」打印，不参与门禁判定。
function apcaLc(textColor, bgColor) {
  const toY = (color) => {
    const channel = (value) => {
      const v = value / 255;
      return Math.pow(v, 2.4);
    };
    return 0.2126729 * channel(color.r) + 0.7151522 * channel(color.g) + 0.072175 * channel(color.b);
  };
  const clampY = (y) => (y > 0.022 ? y : y + Math.pow(0.022 - y, 1.414));
  const txtY = clampY(toY(textColor));
  const bgY = clampY(toY(bgColor));
  if (Math.abs(bgY - txtY) < 0.0005) return 0;
  if (bgY > txtY) {
    const sapc = (Math.pow(bgY, 0.56) - Math.pow(txtY, 0.57)) * 1.14;
    const output = sapc < 0.1 ? 0 : sapc < 0.027 ? 0 : (sapc - 0.027) * 100;
    return Math.round(output * 100) / 100;
  }
  const sapc = (Math.pow(bgY, 0.65) - Math.pow(txtY, 0.62)) * 1.14;
  const output = sapc > -0.1 ? 0 : sapc > -0.027 ? 0 : (sapc + 0.027) * 100;
  return Math.round(output * 100) / 100;
}

// 从 styles.css 的 :root / 主题块里取令牌值，算 4 组核心配色的 APCA Lc（参考，不阻断）。
function apcaShadowReport(cssText, options = {}) {
  const themes = options.themes || THEME_NAMES;
  const { root, themes: blocks } = themeBlocksOf(cssText);
  const rootBody = root.length ? root[0].body : '';
  const valueOf = (body) => {
    const map = {};
    for (const raw of String(body || '').split(';')) {
      const hit = /^\s*(--[A-Za-z0-9-]+)\s*:\s*([^;]+)/.exec(raw);
      if (hit) map[hit[1]] = hit[2].trim();
    }
    return map;
  };
  const rootValues = valueOf(rootBody);
  const rows = [];
  for (const name of themes) {
    const values = { ...rootValues, ...(name === 'paper' ? {} : valueOf(blocks[name] ? blocks[name].body : '')) };
    const pairs = [
      ['--ink', '--paper', '正文 / 纸色'],
      ['--ink', '--folio-sheet', '正文 / 纸张'],
      ['--ink-soft', '--paper', '次要文字 / 纸色'],
      ['--ink-faint', '--paper', '更淡文字 / 纸色']
    ];
    for (const [textToken, bgToken, label] of pairs) {
      const text = parseHexColor(values[textToken]);
      const bg = parseHexColor(values[bgToken]);
      if (!text || !bg) {
        rows.push({ theme: name, pair: label, lc: null, note: `${textToken} / ${bgToken} 不是十六进制色` });
        continue;
      }
      rows.push({ theme: name, pair: label, lc: apcaLc(text, bg), text: values[textToken], bg: values[bgToken] });
    }
  }
  return rows;
}

// ---------- 参数 ----------

function usageText() {
  return [
    '章回 · 无障碍门禁二期（1.3.0 T8 / 规范 A-03 / A-04）',
    '',
    '用法：node scripts/a11y-gate.js [选项]',
    '  --static         只跑静态检查（主题令牌 / 主题名单 / 拖动替代接线），不启动 Electron',
    '  --report         实测照跑，但有红也只报告（退出码 0）',
    '  --widths=1294,960 实测的视口宽度（默认 1294,960）',
    '  --json=<路径>    报告 JSON 的落点（默认 shots/a11y-gate/a11y-<时间>.json）',
    '  --timeout=<ms>   实测总超时（默认 180000）',
    '  --help           显示这段说明',
    '',
    '口径：2.5.8 目标 ≥24×24（间距例外 + 允许清单）；2.4.11 弹层里逐个聚焦、量遮不遮；',
    '      2.5.7 章节排序的 Alt+↑/↓ 键盘替代（静态 + E2E 断言）；3.3.7 人工走查；',
    '      6 套主题令牌键齐全；APCA 影子参考只算不判。只读：书库与 userData 全在临时目录。'
  ].join('\n');
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS, widths: DEFAULTS.widths.slice() };
  for (const raw of argv || []) {
    if (raw === '--help' || raw === '-h') {
      opts.help = true;
      continue;
    }
    if (raw === '--static') {
      opts.staticOnly = true;
      continue;
    }
    if (raw === '--report') {
      opts.report = true;
      continue;
    }
    const hit = /^--([a-z-]+)(?:=(.*))?$/.exec(String(raw));
    if (!hit) continue;
    const key = hit[1];
    const value = hit[2];
    if (key === 'widths') {
      const widths = String(value || '')
        .split(',')
        .map((item) => Number(item.trim()))
        .filter((item) => Number.isFinite(item) && item >= 320 && item <= 4096);
      if (widths.length) opts.widths = widths;
    } else if (key === 'json' && value) {
      opts.json = value;
    } else if (key === 'timeout') {
      const ms = Number(value);
      if (Number.isFinite(ms) && ms >= 5000) opts.timeout = ms;
    }
  }
  return opts;
}

// ---------- 实测：临时目录 / 夹具 ----------

function assertTempDir(target) {
  const resolved = path.resolve(target);
  const temp = path.resolve(os.tmpdir());
  if (!resolved.startsWith(temp + path.sep)) {
    throw new Error(`拒绝在临时目录外操作：${resolved}`);
  }
  return resolved;
}

function stamp(when = new Date()) {
  return when.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function createFixtures(base) {
  const storage = require('../core/storage');
  const booksRoot = assertTempDir(path.join(base, 'books'));
  await fsp.mkdir(booksRoot, { recursive: true });
  const created = await storage.createBook(booksRoot, '门禁样本甲');
  const bookPath = created.path;
  await storage.createChapter(bookPath, 1, '第二章 起风');
  const meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(
    bookPath,
    meta.chapters[0].file,
    '门禁样本：第一章的正文。灯芯在窗边跳了一下，屋子里很安静。'
  );
  await storage.saveChapterText(bookPath, meta.chapters[1].file, '门禁样本：第二章的正文。');
  await storage.setLastOpenChapter(bookPath, meta.chapters[0].id);
  const second = await storage.createBook(booksRoot, '门禁样本乙');
  return { booksRoot, bookPath, secondPath: second.path };
}

// ---------- 实测：CDP 连接 ----------

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(1000, () => req.destroy(new Error('timeout')));
  });
}

async function waitTarget(port, timeout = 25000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const list = await httpJson(`http://127.0.0.1:${port}/json/list`);
      const page = (list || []).find(
        (item) => item.type === 'page' && /index\.html/.test(String(item.url || ''))
      );
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) throw new Error('等待 Electron 远程调试端口超时');
    await sleep(150);
  }
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!message.id) return;
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id);
      if (message.error) item.reject(new Error(`${message.error.message || 'CDP error'} (${item.method})`));
      else item.resolve(message.result || {});
    });
    ws.addEventListener('close', () => {
      for (const item of this.pending.values()) item.reject(new Error('CDP 连接已关闭'));
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* 忽略 */
    }
  }
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return new CdpClient(ws);
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
    throw new Error(`渲染层执行失败：${String(expression).slice(0, 120)} → ${detail || result.exceptionDetails.text}`);
  }
  return result.result ? result.result.value : undefined;
}

async function waitEval(cdp, expression, timeout = 15000, label = expression) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let value;
    try {
      value = await evaluate(cdp, expression);
    } catch {
      /* 页面切换间隙 */
    }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await sleep(100);
  }
}

async function setViewport(cdp, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false
  });
  await waitEval(
    cdp,
    `Math.abs(window.innerWidth - ${width}) <= 1 ? window.innerWidth : 0`,
    8000,
    `视口宽 ${width}`
  );
}

// ---------- 实测：页面里的扫描（函数被 toString() 丢进渲染层，只能用浏览器全局） ----------

function a11yScan(cfg) {
  const INTERACTIVE = cfg.selector;
  const MIN = cfg.min;
  const visible = (el) => {
    try {
      if (typeof el.checkVisibility === 'function') {
        return el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true });
      }
    } catch {
      /* 老内核 */
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const pathOf = (el) => {
    if (!el || el.nodeType !== 1) return '?';
    let out = el.tagName.toLowerCase();
    if (el.id) out += '#' + el.id;
    if (el.classList && el.classList.length) {
      out += '.' + Array.from(el.classList).slice(0, 3).join('.');
    }
    let parent = el.parentElement;
    while (parent && parent !== document.body) {
      if (parent.id) {
        out += ' @#' + parent.id;
        break;
      }
      parent = parent.parentElement;
    }
    return out;
  };
  // 可点目标：禁用的控件不是 pointer target（WCAG 2.5.8 只管能点的），跳过。
  const isDisabled = (el) => {
    if (el.disabled === true) return true;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
    return Boolean(el.closest && el.closest('[inert]'));
  };
  // 层级：当前打开的是哪个弹层（顶层的 .backdrop），没开弹层就是 page。
  // 间距例外的比较只在**同一层**里做——弹层盖住页面时，页面上的大块（正文）不算「相邻目标」。
  const layerOf = (el) => {
    const backdrop = el.closest ? el.closest('.backdrop') : null;
    if (backdrop && backdrop.id) return backdrop.id;
    return 'page';
  };
  const labelOf = (el) => {
    const text = String(el.innerText || el.value || el.getAttribute('aria-label') || el.title || '')
      .replace(/\s+/g, ' ')
      .trim();
    return text.slice(0, 42);
  };
  const boxOf = (el) => {
    let target = el;
    const tag = el.tagName;
    if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      const label = el.closest('label');
      if (label) target = label;
    }
    return target;
  };
  const scope = cfg.scope ? document.querySelector(cfg.scope) : document.body;
  if (!scope) return { ok: false, error: '扫描范围不存在：' + cfg.scope };
  const items = [];
  const all = Array.from(scope.querySelectorAll(INTERACTIVE));
  for (const el of all) {
    if (isDisabled(el)) continue;
    if (!visible(el)) continue;
    const target = boxOf(el);
    if (!visible(target)) continue;
    const rect = target.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) continue;
    let nested = false;
    let ancestor = el.parentElement;
    while (ancestor) {
      if (ancestor.matches && ancestor.matches(INTERACTIVE)) {
        nested = true;
        break;
      }
      ancestor = ancestor.parentElement;
    }
    items.push({
      path: pathOf(target === el ? el : target) + (target === el ? '' : ' <= ' + pathOf(el)),
      tag: target.tagName.toLowerCase(),
      id: target.id || '',
      classes: target.classList ? Array.from(target.classList) : [],
      rectText: labelOf(target === el ? el : target),
      layer: layerOf(target === el ? el : target),
      x: Math.round(rect.left * 10) / 10,
      y: Math.round(rect.top * 10) / 10,
      w: Math.round(rect.width * 10) / 10,
      h: Math.round(rect.height * 10) / 10,
      nested
    });
  }
  return {
    ok: true,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scroll: { x: window.scrollX, y: window.scrollY },
    items
  };
}

function a11yFocusScan(cfg) {
  const INTERACTIVE = cfg.selector;
  const scope = cfg.scope ? document.querySelector(cfg.scope) : document.body;
  if (!scope) return { ok: false, error: '焦点扫描范围不存在：' + cfg.scope };
  const visible = (el) => {
    try {
      if (typeof el.checkVisibility === 'function') {
        return el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true });
      }
    } catch {
      /* 老内核 */
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const pathOf = (el) => {
    if (!el || el.nodeType !== 1) return '?';
    let out = el.tagName.toLowerCase();
    if (el.id) out += '#' + el.id;
    if (el.classList && el.classList.length) out += '.' + Array.from(el.classList).slice(0, 3).join('.');
    return out;
  };
  const entries = [];
  const isDisabled = (el) =>
    el.disabled === true ||
    (el.getAttribute && el.getAttribute('aria-disabled') === 'true') ||
    Boolean(el.closest && el.closest('[inert]'));
  const focusables = Array.from(scope.querySelectorAll(INTERACTIVE)).filter(
    (el) => visible(el) && !isDisabled(el)
  );
  for (const el of focusables) {
    el.focus({ preventScroll: true });
    const focused = document.activeElement === el;
    if (!focused) {
      entries.push({ path: pathOf(el), focused: false });
      continue;
    }
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const rect = el.getBoundingClientRect();
    const inViewport =
      rect.top >= -0.5 &&
      rect.left >= -0.5 &&
      rect.bottom <= window.innerHeight + 0.5 &&
      rect.right <= window.innerWidth + 0.5;
    // 最近的滚动祖先：焦点框必须完整落在它的可视区里（CSS 裁切 / sticky 遮住都算）
    let clippedBy = null;
    let ancestor = el.parentElement;
    while (ancestor && ancestor !== document.body) {
      const style = getComputedStyle(ancestor);
      const scrollable =
        /(auto|scroll|hidden)/.test(style.overflowY + style.overflowX) &&
        (ancestor.scrollHeight > ancestor.clientHeight + 1 || ancestor.scrollWidth > ancestor.clientWidth + 1);
      if (scrollable) {
        const box = ancestor.getBoundingClientRect();
        if (
          rect.top < box.top - 0.5 ||
          rect.bottom > box.bottom + 0.5 ||
          rect.left < box.left - 0.5 ||
          rect.right > box.right + 0.5
        ) {
          clippedBy = pathOf(ancestor);
          break;
        }
      }
      ancestor = ancestor.parentElement;
    }
    // 中心点最上层命中：弹层背景 / toast / 悬浮条盖住焦点框都要报
    const cx = Math.min(Math.max(rect.left + rect.width / 2, 1), window.innerWidth - 1);
    const cy = Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 1);
    const hit = document.elementFromPoint(cx, cy);
    let coveredBy = null;
    if (!hit) coveredBy = '（视口外，没有命中元素）';
    else if (hit !== el && !el.contains(hit) && !hit.contains(el)) coveredBy = pathOf(hit);
    entries.push({
      path: pathOf(el),
      focused: true,
      inViewport,
      clippedBy,
      coveredBy,
      rect: {
        x: Math.round(rect.left * 10) / 10,
        y: Math.round(rect.top * 10) / 10,
        w: Math.round(rect.width * 10) / 10,
        h: Math.round(rect.height * 10) / 10
      }
    });
  }
  if (document.activeElement && typeof document.activeElement.blur === 'function') {
    document.activeElement.blur();
  }
  return { ok: true, viewport: { width: window.innerWidth, height: window.innerHeight }, entries };
}

// ---------- 实测：主流程 ----------

async function measure(opts, fixtures, log) {
  const userData = assertTempDir(path.join(fixtures.base, 'user-data'));
  await fsp.mkdir(userData, { recursive: true });
  const port = 9400 + (process.pid % 400);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const args = [
    path.join(ROOT, 'scripts', 'start.js'),
    `--user-data=${userData}`,
    `--books-root=${fixtures.booksRoot}`,
    `--remote-debugging-port=${port}`
  ];
  log(`[a11y] 启动 Electron（端口 ${port}）…`);
  const child = spawn(process.execPath, args, { cwd: ROOT, env });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  let cdp = null;
  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* 忽略 */
    }
  }, opts.timeout);
  timer.unref();
  try {
    const target = await waitTarget(port);
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // 窗口没抢到系统焦点时，Chromium 的 focus / blur 事件与 activeElement 行为会飘（同一段脚本
    // 一次有 focusin、一次没有）。这里显式把页面提到前台，并让 CDP 模拟「页面处于激活态」。
    await cdp.send('Page.bringToFront').catch(() => {});
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await waitEval(cdp, "document.readyState === 'complete' && Boolean(window.api)", 20000, '首屏加载');
    await sleep(250);
    // 测试钩子只在 ?test=1 下挂出来（main.js 只给自动化启动加，这里手动导航过去）
    await cdp.send('Page.navigate', {
      url: `${target.url}${target.url.includes('?') ? '&' : '?'}test=1`
    });
    await waitEval(cdp, 'Boolean(window.__cwTest && window.__cwTest.ready)', 25000, '测试钩子');
    log('[a11y] 测试钩子就绪');

    const widths = opts.widths.slice();
    const results = [];

    for (const width of widths) {
      await setViewport(cdp, width, 900);
      const first = width === widths[0];
      const states = first ? STATES : STATES.filter((state) => NARROW_STATES.includes(state.id));
      if (!first) {
        // 窄窗复扫从书架开始：先把视图退回去（上一轮停在写作页）。
        const view = await evaluate(cdp, 'window.__cwTest.view()');
        if (view === 'editor') {
          await evaluate(cdp, "document.getElementById('btn-back').click()");
        }
        await waitEval(cdp, "window.__cwTest.view() === 'shelf'", 15000, '回到书架（窄窗）');
      }
      for (const state of states) {
        const record = { id: state.id, label: state.label, width, ok: true };
        const runState = state;
        // teardown 放 finally：某个状态自己失败时也要把它打开的弹层收掉，否则后面每个状态
        // 都会量到「被上层弹层盖住」，把一处失败放大成一片（2026-11-09 实测踩过）。
        const teardown = runState.teardown;
        try {
          const setup = runState.setup
            ? runState.setup.replace(/__BOOK__/g, JSON.stringify(fixtures.bookPath))
            : null;
          if (setup) await evaluate(cdp, setup);
          await waitEval(cdp, runState.wait, 15000, `${runState.label}（${width}）`);
          const scan = await evaluate(
            cdp,
            `(${a11yScan.toString()})(${JSON.stringify({ selector: TARGET_SELECTOR, min: MIN_TARGET, scope: null })})`
          );
          record.targets = scan;
          if (runState.focusScope) {
            const focusScan = await evaluate(
              cdp,
              `(${a11yFocusScan.toString()})(${JSON.stringify({
                selector: TARGET_SELECTOR,
                scope: runState.focusScope
              })})`
            );
            record.focus = focusScan;
          }
        } catch (err) {
          record.ok = false;
          record.error = String((err && err.message) || err);
        } finally {
          if (teardown) {
            await evaluate(cdp, teardown).catch((err) => {
              record.teardownError = String((err && err.message) || err);
            });
          }
        }
        results.push(record);
        log(
          `[a11y] ${width} · ${state.label}：目标 ${record.targets ? record.targets.items.length : 0}` +
            `${record.focus ? ` / 焦点 ${record.focus.entries.length}` : ''}` +
            `${record.ok ? '' : '（失败）'}`
        );
      }
    }

    // 焦点归还（2.4.11「关闭后归还」/ I-04）：设置从书架按钮开、查找从写作页按钮开。
    return { target, results, stderr: stderr.slice(-800) };
  } finally {
    clearTimeout(timer);
    if (cdp) cdp.close();
    try {
      child.kill();
    } catch {
      /* 忽略 */
    }
  }
}

// ---------- 汇总 ----------

function summarize({ staticChecks, target, focus, apca }) {
  const problems = [];
  for (const check of staticChecks) {
    if (!check.ok) problems.push(...check.problems);
  }
  if (target && !target.ok) problems.push(...target.problems);
  if (focus && !focus.ok) problems.push(...focus.problems);
  return {
    ok: problems.length === 0,
    problems,
    stats: {
      staticChecks: staticChecks.length,
      targetTotal: target ? target.total : 0,
      targetSmall: target ? target.smallCount : 0,
      targetSpacing: target ? target.spacingCount : 0,
      targetAllow: target ? target.allowCount : 0,
      targetFail: target ? target.failCount : 0,
      focusTotal: focus ? focus.total : 0,
      focusFail: focus ? focus.failCount : 0,
      apcaRows: (apca || []).length
    }
  };
}

// ---------- main ----------

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(usageText());
    return 0;
  }
  const log = (line) => console.log(line);
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  // 1) 静态：主题令牌 / 主题名单 / 拖动替代
  const cssText = read('renderer/styles.css');
  const staticChecks = [];
  const tokenReport = themeTokenReport(cssText);
  staticChecks.push({ id: 'theme-tokens', label: '6 套主题令牌键齐全', ...tokenReport });
  const listReport = themeListReport({
    chrome: themeNamesFromChrome(read('core/window-chrome.js')),
    contrast: themeNamesFromContrast(read('scripts/contrast.js')),
    indexHtml: themeNamesFromIndexHtml(read('renderer/index.html'))
  });
  staticChecks.push({ id: 'theme-list', label: '主题名单四处一致', ...listReport });
  const keyboardReport = keyboardAlternativeReport({
    'renderer/list-keyboard.js': read('renderer/list-keyboard.js'),
    'renderer/renderer.js': read('renderer/renderer.js'),
    'scripts/e2e/groups/27-drag-sort.js': read('scripts/e2e/groups/27-drag-sort.js')
  });
  staticChecks.push({ id: 'drag-alt', label: '2.5.7 拖动替代（Alt+↑/↓）接线', ...keyboardReport });
  for (const check of staticChecks) {
    log(`[a11y] 静态 · ${check.label}：${check.ok ? 'ok' : 'FAIL'}`);
    for (const problem of check.problems || []) log(`         - ${problem}`);
  }
  const apca = apcaShadowReport(cssText);
  log(
    '[a11y] APCA 影子参考（只算不判）：' +
      apca
        .filter((row) => row.theme === 'paper' || row.theme === 'night')
        .map((row) => `${row.theme}/${row.pair} Lc=${row.lc}`)
        .join('；')
  );

  if (opts.staticOnly) {
    const summary = summarize({ staticChecks, apca });
    log('');
    log(summary.ok ? 'A11Y OK（只静态）' : 'A11Y FAIL（只静态）');
    return summary.ok ? 0 : 1;
  }

  // 2) 实测：真实 Electron + 临时书库 / userData
  const startedAt = new Date();
  const base = assertTempDir(path.join(os.tmpdir(), `cw-a11y-${stamp(startedAt)}-${process.pid}`));
  await fsp.mkdir(base, { recursive: true });
  log(`[a11y] 临时目录：${base}`);
  const fixtures = { ...(await createFixtures(base)), base };
  let measured;
  try {
    measured = await measure(opts, fixtures, log);
  } catch (err) {
    const message = String((err && err.stack) || err);
    console.error(`[a11y] 实测失败：${message}`);
    if (!opts.report) return 1;
    measured = { results: [], measureError: message };
  }

  // 3) 判定：按状态分别判（允许清单的条数上限按「同一状态」计），再汇总。
  const targetStates = [];
  const focusStates = [];
  const failedStates = [];
  for (const record of measured.results || []) {
    const stateLabel = `${record.width} · ${record.label}`;
    if (!record.ok) {
      // 状态自己没测到（弹层没打开 / 等待超时）也记一笔，最后算门禁失败：
      // 静默跳过等于把这一屏的控件漏出判据（1.4.0 P0-1 加分区状态时踩过）。
      failedStates.push(`${stateLabel}：${record.error}`);
      log(`[a11y] 状态失败：${stateLabel}：${record.error}`);
      continue;
    }
    const targetVerdict = evaluateTargets((record.targets && record.targets.items) || [], {
      min: MIN_TARGET,
      allow: TARGET_ALLOW
    });
    targetStates.push({ state: stateLabel, verdict: targetVerdict });
    if (record.focus) {
      const focusVerdict = evaluateFocus(record.focus.entries || [], { allow: FOCUS_ALLOW });
      focusStates.push({ state: stateLabel, verdict: focusVerdict });
    }
  }
  const combine = (list) => {
    const totals = {
      ok: list.every((item) => item.verdict.ok),
      total: 0,
      okCount: 0,
      spacingCount: 0,
      allowCount: 0,
      coveredCount: 0,
      failCount: 0,
      smallCount: 0,
      problems: []
    };
    for (const item of list) {
      const verdict = item.verdict;
      totals.total += verdict.total;
      totals.okCount += verdict.okCount || 0;
      totals.spacingCount += verdict.spacingCount || 0;
      totals.allowCount += verdict.allowCount || 0;
      totals.coveredCount += verdict.coveredCount || 0;
      totals.failCount += verdict.failCount || 0;
      totals.smallCount += verdict.smallCount || 0;
      for (const problem of verdict.problems) totals.problems.push(`${item.state} › ${problem}`);
    }
    totals.ok = totals.problems.length === 0;
    return totals;
  };
  const targetVerdict = combine(targetStates);
  const focusVerdict = combine(focusStates);
  // 允许清单要「真的用上」：整轮没用到一条说明条目已经过期（产品改大了 / 选择器改名），不能装没看见。
  const usage = new Map();
  for (const item of targetStates) {
    for (const row of item.verdict.allowUsage || []) {
      usage.set(row.key, (usage.get(row.key) || 0) + row.used);
    }
  }
  for (const [key, used] of usage) {
    if (used === 0) targetVerdict.problems.push(`允许清单 ${key}：整轮实测 0 条，条目已过期（删掉或更新）`);
  }
  targetVerdict.ok = targetVerdict.problems.length === 0;
  log(
    `[a11y] 目标尺寸：共 ${targetVerdict.total} 条，<24 的 ${targetVerdict.smallCount} 条` +
      `（间距例外 ${targetVerdict.spacingCount} / 允许清单 ${targetVerdict.allowCount} / 被祖先覆盖 ${targetVerdict.coveredCount} / 违规 ${targetVerdict.failCount}）`
  );
  for (const problem of targetVerdict.problems) log(`         - ${problem}`);
  log(
    `[a11y] 焦点：共 ${focusVerdict.total} 条，违规 ${focusVerdict.failCount}` +
      (focusVerdict.allowCount ? `，允许清单 ${focusVerdict.allowCount}` : '')
  );
  for (const problem of focusVerdict.problems) log(`         - ${problem}`);

  const summary = summarize({
    staticChecks,
    target: targetVerdict,
    focus: focusVerdict,
    apca
  });
  if (measured.measureError) summary.ok = false;
  if (failedStates.length) {
    summary.ok = false;
    for (const item of failedStates) summary.problems.push(`状态测量失败：${item}`);
  }

  // 4) 报告 JSON（shots/ 是 gitignored，可以留着对照）
  const report = {
    ok: summary.ok,
    tool: 'chapterly a11y gate (1.3.0 T8 / WCAG 2.2 AA 门禁二期)',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    node: process.version,
    options: { widths: opts.widths, report: opts.report },
    fixtures,
    static: staticChecks,
    targets: targetVerdict,
    focus: focusVerdict,
    apca,
    states: (measured.results || []).map((record) => ({
      id: record.id,
      label: record.label,
      width: record.width,
      ok: record.ok,
      targetCount: record.targets ? record.targets.items.length : 0,
      focusCount: record.focus ? record.focus.entries.length : 0,
      error: record.error || null
    })),
    summary,
    manual: [
      '3.3.7 不重复录入：人工走查（2026-11-08）——新建一本 = 书文件夹名（导入时用文件夹名，不再追问书名）；',
      '书籍信息（作者 / 分组 / 标签）只在「书籍信息」弹层填一次，导出 / 复制沿用；导出范围只问一次（整本 / 按卷 / 按章范围），',
      '不重复要求同一信息。脚本不自动判，结论写进 README「无障碍」段与 验收清单 V42。'
    ]
  };
  const outPath = opts.json
    ? path.resolve(ROOT, opts.json)
    : path.join(REPORT_DIR, `a11y-${stamp(new Date())}.json`);
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  await fsp.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
  log('');
  log(`A11Y ${summary.ok ? 'OK' : 'FAIL'} :: 静态 ${staticChecks.length} 项 / 目标 ${targetVerdict.total} 条 / 焦点 ${focusVerdict.total} 条 / 违规 ${summary.problems.length}`);
  log(`报告 JSON：${outPath}`);
  if (!summary.ok) {
    for (const problem of summary.problems) log(`  - ${problem}`);
  }
  if (opts.report) {
    log('（--report：只报告，不因违规返回 1）');
    return 0;
  }
  return summary.ok ? 0 : 1;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err && err.stack ? err.stack : err);
      process.exit(1);
    });
}

module.exports = {
  MIN_TARGET,
  THEME_NAMES,
  REQUIRED_PALETTE,
  TARGET_SELECTOR,
  TARGET_ALLOW,
  FOCUS_ALLOW,
  STATES,
  NARROW_STATES,
  DEFAULTS,
  usageText,
  parseArgs,
  stripCssComments,
  parseCssBlocks,
  declarationKeys,
  hasFallbackUsage,
  themeBlocksOf,
  themeTokenReport,
  themeNamesFromChrome,
  themeNamesFromContrast,
  themeNamesFromIndexHtml,
  themeListReport,
  keyboardAlternativeReport,
  matchAllow,
  centerOf,
  centerToRect,
  evaluateTargets,
  evaluateFocus,
  parseHexColor,
  apcaLc,
  apcaShadowReport,
  assertTempDir,
  stamp,
  a11yScan,
  a11yFocusScan,
  summarize,
  main
};
