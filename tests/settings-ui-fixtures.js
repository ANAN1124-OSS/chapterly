// 设置面板测试的共用夹具（T9 / 第 10 轮：原 tests/settings-ui.test.js 按性质拆成四个文件）。
//
// 拆法（与 storage / config / capture-ui / search-index 的 T9 拆分同口径，见 tests/README.md 的「临时目录与夹具」）：
//   · 本文件放**夹具**：极简假 DOM（makeEl / makeDocument / SETTINGS_EL_SPEC，本体用共享基线
//     preambles.makeEl + 本域 style / [data-*] 选择器）、host 工厂 build()（假 api + calls 记账）、
//     BASE_IDS / DISPLAY_IDS / formatBytes，以及几份源码常量（ROOT / rendererSrc / indexSrc /
//     moduleSrc / moduleCode）与 flush()。
//   · 用例按性质分四个 .test.js：settings-ui（契约 / 打开回填 / 台账 / 更新）、-save（保存 / 取消 /
//     重置 / 失败 / 重定基 / 在途）、-render（渲染小件 / 表单件 / 接线 / 搜索）、-static（静态闸门 /
//     UMD / 结构闸门 / 同源清单）。
// 本文件不叫 *.test.js：`node --test "tests/**/*.test.js"` 不会把它当用例跑。
const fs = require('node:fs');
const path = require('node:path');
const settingsUi = require('../renderer/settings-ui');
const caretColorLib = require('../core/caret-color');
const templateLib = require('../core/template');
const s2tLib = require('../core/s2t');
const commonLib = require('../core/common');
const editorLogic = require('../renderer/editor-logic');
const chaptersLib = require('../core/chapters');

const preambles = require('./ui-test-preambles');

// 第 4 步 renderer 九刀·第七刀：设置（原 renderer.js 4305–4787，483 行）搬到 renderer/settings-ui.js。
// 这一域是胶水中心：作用域切换 / 表单回填与预览 / 保存（全局 + 按书两条路径）/ 数据台账（词表 / 日志 / 更新）。
// 搬之前只有 E2E 黑盒覆盖（打开设置 → 改项 → 保存 / 取消）；各作用域显隐、保存 payload、网络状态文案、
// 词表三态、失败兜底在 Node 里一步都测不到。搬出来以后用「假 host + 假 DOM」逐条钉住。
//
// 契约：host 9 个成员 = 基础 5（$, state, api, call, toast）+ chaptersLib + display{12} +
// peers{stats,writeTimer,editor,words,refreshShelf} + texts{commonLib,formatBytes}；分组内每个真实依赖都写进模块头注释。

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const moduleSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'settings-ui.js'), 'utf8');
const moduleCode = moduleSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------- 假 DOM ----------
// 本体用共享基线（TEST-D-02）：本域只注入 style 桩（--swatch 变量）与 [data-*] 领域选择器。
function makeStyle() {
  return { _props: {}, setProperty(k, v) { this._props[k] = v; }, removeProperty(k) { delete this._props[k]; } };
}
const SETTINGS_EL_SPEC = {
  style: makeStyle,
  query(selector, el) {
    const out = [];
    const m = /^\[data-([\w-]+)\]$/.exec(selector);
    const camel = m ? m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase()) : null;
    const visit = (node) => {
      for (const c of node.children || []) {
        if (m && Object.prototype.hasOwnProperty.call(c.dataset, camel)) out.push(c);
        visit(c);
      }
    };
    visit(el);
    return out;
  }
};
const makeEl = (tag = 'div', id = '') => preambles.makeEl(tag, id, SETTINGS_EL_SPEC);


function makeDocument() {
  const map = new Map();
  let lookups = 0;
  const doc = {
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => { lookups += 1; return map.get(id) || null; }
  };
  return {
    doc, map,
    get lookups() { return lookups; },
    $: (id) => doc.getElementById(id),
    ensure(id) { if (!map.has(id)) map.set(id, makeEl('div', id)); return map.get(id); }
  };
}

const BASE_IDS = [
  'settings-backdrop', 'settings-root', 'settings-root-field', 'settings-font', 'settings-font-name',
  'settings-size', 'settings-line-height', 'settings-letter-spacing', 'settings-padding-x', 'settings-page-width',
  'settings-text-autospace',
  'settings-paper', 'settings-caret-paragraph', 'settings-caret-color', 'settings-caret-colors', 'settings-caret-hint',
  'settings-chapter-numbering',
  'settings-long-para-threshold', 'settings-long-para-hint',
  'settings-snapshot-enabled', 'settings-snapshot-days', 'settings-daily-goal', 'settings-write-duration',
  'settings-clipboard-watch', 'settings-clipboard-field',
  'settings-crash-draft-field', 'settings-crash-draft-enabled',
  'settings-chapter-template', 'settings-template-preview', 'settings-export-conversion',
  'settings-sensitive-path', 'settings-sensitive-status', 'settings-proofread-path', 'settings-proofread-status',
  'settings-logs-status', 'settings-update-version', 'settings-update-status', 'settings-scope-hint',
  'settings-snapshot-field', 'settings-snapshot-days-field', 'settings-template-field', 'settings-snapshot-group',
  'settings-stats-group', 'settings-daily-goal-field', 'settings-duration-field', 'settings-stats-chart-field',
  'settings-calendar-field', 'settings-stats-hint', 'settings-sensitive-group', 'settings-sensitive-field',
  'settings-proofread-group', 'settings-proofread-field', 'settings-template-group', 'settings-export-group',
  'settings-export-field', 'settings-logs-group', 'settings-logs-field', 'settings-update-group', 'settings-update-field',
  'btn-settings', 'btn-settings-cancel', 'btn-settings-close', 'btn-settings-save', 'btn-reset-book-display',
  'btn-pick-folder', 'btn-pick-font', 'btn-reset-font', 'btn-pick-sensitive', 'btn-clear-sensitive',
  'btn-pick-proofread', 'btn-clear-proofread', 'btn-proofread-pick', 'btn-open-logs',
  'btn-check-update', 'btn-open-update'
];
const DISPLAY_IDS = ['settings-size', 'settings-line-height', 'settings-letter-spacing', 'settings-padding-x', 'settings-page-width', 'settings-paper'];

function formatBytes(n) {
  const value = Math.max(0, Number(n) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function build(options = {}) {
  const dom = options.dom || makeDocument();
  for (const id of BASE_IDS) dom.ensure(id);
  dom.map.get('settings-backdrop').classList.add('hidden');
  globalThis.document = dom.doc;
  const state = {
    view: options.view === undefined ? 'editor' : options.view,
    bookPath: options.bookPath === undefined ? '/书库/书甲' : options.bookPath,
    bookId: options.bookId === undefined ? 'id-1' : options.bookId,
    index: options.index === undefined ? 0 : options.index,
    meta: options.meta === undefined ? { title: '书甲' } : options.meta,
    config: options.config === undefined ? { booksRoot: '/书库', editorFont: 'serif' } : options.config,
    globalConfig: options.config || { booksRoot: '/书库' },
    bookDisplay: options.bookDisplay || {},
    settingsScope: options.scope || 'global',
    settingsBackup: options.settingsBackup === undefined ? null : options.settingsBackup,
    settingsFontDraft: { path: '', name: '' },
    settingsCaretColorDraft: '',
    sensitiveWordsDraft: options.sensitiveWordsDraft || '',
    sensitiveWordsInfo: null,
    proofreadWordsDraft: options.proofreadWordsDraft || '',
    proofreadWordsInfo: null,
    logInfo: options.logInfo === undefined ? null : options.logInfo,
    appVersion: '0.10.0',
    update: { busy: false, result: null },
    marks: { caretParagraph: false, caretLine: 0 },
    writeTimer: { running: false }
  };
  // TEST-D-04：只留真的会被断言的记账旋钮；无断言的（hideHeaderMenus / showView / closeSettings /
  // openSettings / setTimeoutCalls / pickFont）已删，避免读者误以为那些路径有 Node 层覆盖。
  const calls = {
    setConfig: [], setBookDisplay: [], setChapterNumbering: [], resetBookDisplay: [], toast: [], getConfig: 0, refreshStats: 0, renderStatsChart: 0,
    renderDurationSettings: 0, renderWriteTimer: 0, applyWriteTimerConfig: 0, flushWriteTimer: 0,
    renderEditorMarks: 0, renderMarksMenu: 0, refreshShelf: 0,
    refreshSensitiveWordList: 0, refreshProofreadWordList: 0, pickSensitiveWords: [], pickProofreadWords: [],
    applyEditorStyle: [], syncCaretParagraphFromConfig: 0, applySidebarWidth: [], loadCustomFont: [], applyChapterNumbering: [],
    logInfo: 0, sensitiveWordsInfo: 0, proofreadWordsInfo: 0, checkUpdate: 0, openUpdateDownload: 0, pickFolder: 0,
    previewSettings: []
  };
  const api = {
    async setConfig(patch) { calls.setConfig.push(patch); if (options.setConfigGate) await options.setConfigGate; if (options.saveError) throw new Error(options.saveError); return { ...state.globalConfig, ...patch }; },
    async setBookDisplay(bookId, patch) { calls.setBookDisplay.push([bookId, patch]); if (options.saveError) throw new Error(options.saveError); return patch; },
    // 五-M15（SS-04）：章号走 书目.json（与 bookDisplay 是两个文件，没有跨文件事务）
    async setChapterNumbering(bookPath, mode) {
      calls.setChapterNumbering.push([bookPath, mode]);
      if (options.numberingError) throw new Error(options.numberingError);
      return { meta: { ...(state.meta || {}), chapterNumbering: mode } };
    },
    async resetBookDisplay(bookId) { calls.resetBookDisplay.push(bookId); if (options.resetError) throw new Error(options.resetError); return {}; },
    // 五-M14（SS-11）：config:get 回包（本窗口的 state.globalConfig 可能是旧快照，主进程才是唯一事实源）
    async getConfig() {
      calls.getConfig += 1;
      if (options.getConfigGate) await options.getConfigGate;
      if (options.getConfigError) throw new Error(options.getConfigError);
      return options.getConfigResult === undefined ? state.globalConfig : options.getConfigResult;
    },
    async sensitiveWordsInfo() {
      calls.sensitiveWordsInfo += 1;
      if (options.infoGate) await options.infoGate;
      if (options.wordInfoError) throw new Error(options.wordInfoError);
      return options.sensitiveInfo === undefined ? { ok: true, name: '敏感词.txt', count: 3 } : options.sensitiveInfo;
    },
    async proofreadWordsInfo() {
      calls.proofreadWordsInfo += 1;
      if (options.infoGate) await options.infoGate;
      if (options.wordInfoError) throw new Error(options.wordInfoError);
      return options.proofreadInfo === undefined ? { ok: true, name: '校对.txt', count: 4 } : options.proofreadInfo;
    },
    async logInfo() {
      calls.logInfo += 1;
      if (options.infoGate) await options.infoGate;
      if (options.logError) throw new Error(options.logError);
      return options.logResult === undefined ? { files: [{ bytes: 2048 }, { bytes: 1024 }] } : options.logResult;
    },
    async checkUpdate() { calls.checkUpdate += 1; if (options.updateError) throw new Error(options.updateError); return options.updateResult || { status: 'latest', currentVersion: '0.10.0' }; },
    async openUpdateDownload() { calls.openUpdateDownload += 1; return options.downloadResult === undefined ? { opened: true } : options.downloadResult; },
    async pickFolder() { calls.pickFolder += 1; return options.folder === undefined ? '/新书库' : options.folder; },
    async pickFont() { return options.fontPick === undefined ? { canceled: true } : options.fontPick; },
    async pickSensitiveWords() { return options.sensitivePick || { canceled: true }; },
    async pickProofreadWords() { return options.proofreadPick || { canceled: true }; }
  };
  const host = {
    $: dom.$,
    state,
    api,
    call: async (fn, ...args) => fn(...args),
    // 信息架构（分区 / 搜索 / 深链）纯逻辑；老用例不传 ia，模块退回一长条设置（行为不变）。
    // 五-L16（SS-06）的搜索用例要注入真 ia 才能覆盖「按作用域过滤搜索单位」。
    ia: options.ia || null,
    toast(message, kind) { calls.toast.push([message, kind]); },
    chaptersLib,
    display: {
      applyEditorStyle(cfg) { calls.applyEditorStyle.push(cfg); if (options.applyEditorStyleThrows) throw new Error('重绘失败'); },
      syncCaretParagraphFromConfig() { calls.syncCaretParagraphFromConfig += 1; },
      // 与 renderer.js 的 effectiveConfig 同口径：生效值 = 全局配置 + 当前书的覆盖（state.config 是缓存）
      effectiveConfig: () => ({ ...(state.globalConfig || state.config || {}), ...(state.bookDisplay || {}) }),
      applySidebarWidth(w) { calls.applySidebarWidth.push(w); },
      async loadCustomFont(path, opts) { calls.loadCustomFont.push([path, opts]); return true; },
      readDisplayForm: () => options.displayForm || {
        editorFont: 'serif', editorFontSize: 18, editorLineHeight: 1.95, editorLetterSpacing: 0.02,
        editorPaddingX: 56, editorPageWidth: 0, editorPaper: 'paper', caretParagraph: false, caretParagraphColor: ''
      },
      displaySettingsIds: DISPLAY_IDS,
      caretColorLib,
      s2tLib,
      templateLib,
      editorLogic,
      // 与 renderer.js 的 applyChapterNumberingMeta 同口径：回执落地后 state.meta 就换成新 meta
      applyChapterNumbering(meta) { calls.applyChapterNumbering.push(meta); if (meta && typeof meta === 'object') state.meta = meta; }
    },
    peers: {
      stats: { async refreshStats() { calls.refreshStats += 1; if (options.statsGate) await options.statsGate; }, renderStatsChart() { calls.renderStatsChart += 1; } },
      writeTimer: {
        renderDurationSettings() { calls.renderDurationSettings += 1; },
        renderWriteTimer() { calls.renderWriteTimer += 1; },
        applyWriteTimerConfig() { calls.applyWriteTimerConfig += 1; },
        writeDurationEnabled: () => Boolean(options.writeDurationEnabled),
        async flushWriteTimer() { calls.flushWriteTimer += 1; }
      },
      editor: { renderEditorMarks() { calls.renderEditorMarks += 1; }, renderMarksMenu() { calls.renderMarksMenu += 1; } },
      words: {
        async refreshSensitiveWordList() { calls.refreshSensitiveWordList += 1; return { ok: true }; },
        async refreshProofreadWordList() { calls.refreshProofreadWordList += 1; return { ok: true }; },
        sensitiveWordListText: (info) => (info && info.ok ? `敏感词表 ${info.count} 个` : '词表不可用'),
        proofreadWordListText: (info) => (info && info.ok ? `校对词表 ${info.count} 个` : '校对词表不可用'),
        async pickSensitiveWords(opts) { calls.pickSensitiveWords.push(opts); return { canceled: true }; },
        async pickProofreadWords(opts) { calls.pickProofreadWords.push(opts); return { canceled: true }; }
      },
      async refreshShelf() { calls.refreshShelf += 1; }
    },
    texts: { commonLib, formatBytes }
  };
  const ui = settingsUi.create(host);
  return { ui, host, state, dom, calls };
}

module.exports = {
  build,
  makeDocument,
  makeEl,
  DISPLAY_IDS,
  ROOT,
  rendererSrc,
  indexSrc,
  moduleSrc,
  moduleCode,
  flush,
  settingsUi,
  caretColorLib,
  templateLib,
};
