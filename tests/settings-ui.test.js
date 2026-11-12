const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const settingsUi = require('../renderer/settings-ui');
const caretColorLib = require('../core/caret-color');
const templateLib = require('../core/template');
const s2tLib = require('../core/s2t');
const commonLib = require('../core/common');
const editorLogic = require('../renderer/editor-logic');
const chaptersLib = require('../core/chapters');

// 第 4 步 renderer 九刀·第七刀：设置（原 renderer.js 4305–4787，483 行）搬到 renderer/settings-ui.js。
// 这一域是胶水中心：作用域切换 / 表单回填与预览 / 保存（全局 + 按书两条路径）/ 数据台账（词表 / 日志 / 更新）。
// 搬之前只有 E2E 黑盒覆盖（打开设置 → 改项 → 保存 / 取消）；各作用域显隐、保存 payload、网络状态文案、
// 词表三态、失败兜底在 Node 里一步都测不到。搬出来以后用「假 host + 假 DOM」逐条钉住。
//
// 契约：host 9 个成员 = 基础 5（$, state, api, call, toast）+ chaptersLib + display{12} +
// peers{stats,writeTimer,editor,words,refreshShelf} + texts{commonLib,formatBytes}；分组内每个真实依赖都写进模块头注释。

const realDocument = globalThis.document;
const realDateNow = Date.now;
test.after(() => {
  if (realDocument === undefined) delete globalThis.document;
  else globalThis.document = realDocument;
  Date.now = realDateNow;
});
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const moduleSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'settings-ui.js'), 'utf8');
const moduleCode = moduleSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------- 假 DOM ----------
function makeStyle() {
  return { _props: {}, setProperty(k, v) { this._props[k] = v; }, removeProperty(k) { delete this._props[k]; } };
}
function makeEl(tag = 'div', id = '') {
  const classes = new Set();
  const listeners = [];
  const el = {
    tagName: tag, id, className: '', textContent: '', title: '', value: '', checked: false, disabled: false,
    dataset: {}, children: [], parentNode: null, style: makeStyle(),
    _classes: classes, _listeners: listeners, _attrs: {},
    classList: {
      add: (...n) => n.forEach((x) => classes.add(x)),
      remove: (...n) => n.forEach((x) => classes.delete(x)),
      contains: (n) => classes.has(n),
      toggle(n, on) {
        const next = on === undefined ? !classes.has(n) : Boolean(on);
        if (next) classes.add(n);
        else classes.delete(n);
      }
    },
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); String(v || '').split(/\s+/).filter(Boolean).forEach((x) => classes.add(x)); },
    append(...n) { n.forEach((x) => el.appendChild(x)); },
    appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
    removeChild(child) {
      const at = el.children.indexOf(child);
      if (at >= 0) el.children.splice(at, 1);
      child.parentNode = null;
      return child;
    },
    // 正文宽度历史值 option 的回填清理用（1.3.0 T-06）：真实 DOM 的原生 remove()
    remove() { if (el.parentNode) el.parentNode.removeChild(el); },
    addEventListener(type, fn) { listeners.push({ type, fn }); },
    setAttribute(k, v) { el._attrs[k] = v; },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(el._attrs, k) ? el._attrs[k] : null; },
    focus() { el._focus = (el._focus || 0) + 1; },
    querySelectorAll(selector) {
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
    },
    _fire(type, event) {
      let result;
      for (const l of listeners) if (l.type === type) result = l.fn(event);
      return result;
    }
  };
  Object.defineProperty(el, 'innerHTML', { get() { return ''; }, set() { el.children.length = 0; } });
  return el;
}
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
  'settings-long-para-threshold', 'settings-long-para-hint',
  'settings-snapshot-enabled', 'settings-snapshot-days', 'settings-daily-goal', 'settings-write-duration',
  'settings-clipboard-watch', 'settings-clipboard-field',
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
  const calls = {
    setConfig: [], setBookDisplay: [], resetBookDisplay: [], toast: [], refreshStats: 0, renderStatsChart: 0,
    renderDurationSettings: 0, renderWriteTimer: 0, applyWriteTimerConfig: 0, flushWriteTimer: 0,
    renderEditorMarks: 0, renderMarksMenu: 0, refreshShelf: 0,
    refreshSensitiveWordList: 0, refreshProofreadWordList: 0, pickSensitiveWords: [], pickProofreadWords: [],
    applyEditorStyle: [], syncCaretParagraphFromConfig: 0, applySidebarWidth: [], loadCustomFont: [], applyChapterNumbering: [],
    hideHeaderMenus: 0, showView: [],
    logInfo: 0, sensitiveWordsInfo: 0, proofreadWordsInfo: 0, checkUpdate: 0, openUpdateDownload: 0, pickFolder: 0, pickFont: 0,
    closeSettings: 0, openSettings: 0, previewSettings: [],
    setTimeoutCalls: []
  };
  const api = {
    async setConfig(patch) { calls.setConfig.push(patch); if (options.saveError) throw new Error(options.saveError); return { ...state.globalConfig, ...patch }; },
    async setBookDisplay(bookId, patch) { calls.setBookDisplay.push([bookId, patch]); if (options.saveError) throw new Error(options.saveError); return patch; },
    async resetBookDisplay(bookId) { calls.resetBookDisplay.push(bookId); if (options.resetError) throw new Error(options.resetError); return {}; },
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
    async pickFont() { calls.pickFont += 1; return options.fontPick === undefined ? { canceled: true } : options.fontPick; },
    async pickSensitiveWords() { return options.sensitivePick || { canceled: true }; },
    async pickProofreadWords() { return options.proofreadPick || { canceled: true }; }
  };
  const host = {
    $: dom.$,
    state,
    api,
    call: async (fn, ...args) => fn(...args),
    toast(message, kind) { calls.toast.push([message, kind]); },
    chaptersLib,
    display: {
      applyEditorStyle(cfg) { calls.applyEditorStyle.push(cfg); },
      syncCaretParagraphFromConfig() { calls.syncCaretParagraphFromConfig += 1; },
      effectiveConfig: () => state.config,
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
      applyChapterNumbering(meta) { calls.applyChapterNumbering.push(meta); }
    },
    peers: {
      stats: { refreshStats() { calls.refreshStats += 1; }, renderStatsChart() { calls.renderStatsChart += 1; } },
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

// ---------- host 契约 ----------
test('host 契约：9 个成员 + 分组内每个真实依赖；缺任何一个都抛 TypeError', () => {
  assert.deepEqual([...settingsUi.REQUIRED_HOST].sort(), ['$', 'api', 'call', 'chaptersLib', 'display', 'peers', 'state', 'texts', 'toast']);
  assert.equal(settingsUi.REQUIRED_HOST.length, 9);
  const ctx = build();
  assert.doesNotThrow(() => settingsUi.create(ctx.host));
  assert.throws(() => settingsUi.create(null), /createSettingsUi 需要 host 对象/);
  for (const key of settingsUi.REQUIRED_HOST) {
    const broken = { ...ctx.host };
    delete broken[key];
    assert.throws(() => settingsUi.create(broken), new RegExp('host 缺少 ' + key.replace('$', '\\$')), '缺 ' + key);
  }
  for (const key of ['applyEditorStyle', 'syncCaretParagraphFromConfig', 'effectiveConfig', 'applySidebarWidth', 'loadCustomFont', 'readDisplayForm', 'displaySettingsIds', 'caretColorLib', 's2tLib', 'templateLib', 'editorLogic', 'applyChapterNumbering']) {
    const broken = { ...ctx.host, display: { ...ctx.host.display } };
    delete broken.display[key];
    assert.throws(() => settingsUi.create(broken), new RegExp('host\\.display 缺少 ' + key));
  }
  for (const key of ['refreshStats', 'renderStatsChart']) {
    const broken = { ...ctx.host, peers: { ...ctx.host.peers, stats: { ...ctx.host.peers.stats } } };
    delete broken.peers.stats[key];
    assert.throws(() => settingsUi.create(broken), new RegExp('host\\.peers\\.stats 缺少 ' + key));
  }
  for (const key of ['renderDurationSettings', 'renderWriteTimer', 'applyWriteTimerConfig', 'writeDurationEnabled', 'flushWriteTimer']) {
    const broken = { ...ctx.host, peers: { ...ctx.host.peers, writeTimer: { ...ctx.host.peers.writeTimer } } };
    delete broken.peers.writeTimer[key];
    assert.throws(() => settingsUi.create(broken), new RegExp('host\\.peers\\.writeTimer 缺少 ' + key));
  }
  for (const key of ['refreshSensitiveWordList', 'refreshProofreadWordList', 'sensitiveWordListText', 'proofreadWordListText', 'pickSensitiveWords', 'pickProofreadWords']) {
    const broken = { ...ctx.host, peers: { ...ctx.host.peers, words: { ...ctx.host.peers.words } } };
    delete broken.peers.words[key];
    assert.throws(() => settingsUi.create(broken), new RegExp('host\\.peers\\.words 缺少 ' + key));
  }
  assert.throws(() => settingsUi.create({ ...ctx.host, peers: { ...ctx.host.peers, refreshShelf: null } }), /host\.peers 缺少 refreshShelf/);
  for (const key of ['commonLib', 'formatBytes']) {
    const broken = { ...ctx.host, texts: { ...ctx.host.texts } };
    delete broken.texts[key];
    assert.throws(() => settingsUi.create(broken), new RegExp('host\\.texts 缺少 ' + key));
  }
});

test('create() 只建表：不碰 DOM / 不注册事件 / 不建定时器，交出 14 个入口', () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  assert.equal(dom.lookups, 0);
  assert.deepEqual(Object.keys(ctx.ui).sort(), [
    'checkUpdate', 'closeSettings', 'openSettings', 'openStatsCalendar', 'openUpdateDownload', 'previewSettings',
    'renderChapterTemplatePreview', 'renderProofreadSettings', 'renderSensitiveSettings', 'renderSettingsCaretColors',
    'resetBookDisplay', 'saveSettings', 'setSelectValue', 'setupSettingsUi'
  ]);
  assert.equal(moduleCode.includes('setInterval'), false);
});

// ---------- 表单 / 颜色 / 模板 ----------
test('setSelectValue：值合法就写；不在选项里时回到 fallback', () => {
  const ctx = build();
  ctx.dom.map.get('settings-font').value = '怪值';
  ctx.ui.setSelectValue('settings-font', 'serif', 'serif');
  assert.equal(ctx.dom.map.get('settings-font').value, 'serif');
});

// 正文宽度档位（1.3.0 T3 / 规范 T-06）：设置项改成 通栏 / 720 / 800 / 840（840 ≈ 39.6 字，
// 落回 clreq 推荐 17–40 字）；900 / 1000 从界面下线，但历史配置照常加载 —— 打开设置要显示原值、
// 不静默改写、也不丢值（config 的 clamp 仍是 600–1600）。
test('正文宽度档位（T-06）：通栏 / 720 / 800 / 840；历史 900 / 1000 用 hidden 动态 option 原样显示、不改写', async () => {
  const widthOf = (ctx) => ctx.dom.map.get('settings-page-width');
  const legacyOf = (ctx) => widthOf(ctx).querySelectorAll('[data-page-width-history]');

  // 1) 新档位：值就在选项里，不挂动态 option
  for (const width of [0, 720, 800, 840]) {
    const ctx = build({ view: 'shelf', bookId: null, config: { booksRoot: '/书库', editorPageWidth: width } });
    await ctx.ui.openSettings();
    assert.equal(widthOf(ctx).value, String(width), '新档位 ' + width + ' 正常回填');
    assert.equal(legacyOf(ctx).length, 0, '新档位不挂历史 option');
    ctx.ui.closeSettings();
  }

  // 2) 历史值 900 / 1000：select 显示原值 + 一个 hidden 动态 option（不静默改成 840 / 0）
  for (const width of [900, 1000]) {
    const ctx = build({ view: 'shelf', bookId: null, config: { booksRoot: '/书库', editorPageWidth: width } });
    await ctx.ui.openSettings();
    assert.equal(widthOf(ctx).value, String(width), '历史配置照常显示原值 ' + width);
    const legacy = legacyOf(ctx);
    assert.equal(legacy.length, 1, '历史值挂一个动态 option');
    assert.equal(legacy[0].value, String(width));
    assert.equal(legacy[0].hidden, true, '历史 option 隐藏：关闭态显示值，下拉列表里不再提供');
    assert.match(legacy[0].textContent, new RegExp('^' + width + ' px · 历史值'));
    // 只打开 / 取消不写盘：值没有被静默改写（保存读的是表单里选中的值，旧值保存回去还是旧值）
    ctx.ui.closeSettings();
    assert.deepEqual(ctx.calls.setConfig, [], '取消不写盘');
  }

  // 3) clamp 允许但不在档位里的值（600–1600 内，例如 650）同样原样保留
  const custom = build({ view: 'shelf', bookId: null, config: { booksRoot: '/书库', editorPageWidth: 650 } });
  await custom.ui.openSettings();
  assert.equal(widthOf(custom).value, '650');
  assert.equal(legacyOf(custom).length, 1);

  // 4) 同一 select 反复回填：历史 option 先清掉再挂，不堆积；切到新档位后不残留
  await custom.ui.openSettings();
  assert.equal(legacyOf(custom).length, 1, '重新打开不堆积历史 option');
  custom.state.config = { booksRoot: '/书库', editorPageWidth: 800 };
  custom.state.globalConfig = custom.state.config;
  await custom.ui.openSettings();
  assert.equal(widthOf(custom).value, '800');
  assert.equal(legacyOf(custom).length, 0, '切到新档位后历史 option 被清掉');

  // 5) 坏值 / 缺字段按通栏（配置层已经夹过，这里兜底一层）
  const broken = build({ view: 'shelf', bookId: null, config: { booksRoot: '/书库', editorPageWidth: 'x' } });
  await broken.ui.openSettings();
  assert.equal(widthOf(broken).value, '0');
  assert.equal(legacyOf(broken).length, 0);
});

test('静态闸门（T-06）：index.html 的正文宽度只剩 4 档，模块的档位表与它一致，表单读的是 select 的值', () => {
  // index.html 的 #settings-page-width 块：选项正好 通栏 / 720 / 800 / 840，900 / 1000 一个都不剩
  const at = indexSrc.indexOf('id="settings-page-width"');
  assert.notEqual(at, -1);
  const block = indexSrc.slice(at, indexSrc.indexOf('</select>', at));
  const values = [...block.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(values, ['0', '720', '800', '840'], '正文宽度档位 = 通栏 / 720 / 800 / 840');
  assert.equal(block.includes('900'), false, '900 已从界面下线');
  assert.equal(block.includes('1000'), false, '1000 已从界面下线');
  // 模块里的档位表与 index.html 同源（两处漂移就红）
  assert.match(moduleSrc, /const PAGE_WIDTH_CHOICES = \[0, 720, 800, 840\];/);
  // 保存 / 预览读的就是 select 里选中的值：历史值不会被静默改写
  assert.match(rendererSrc, /editorPageWidth: Number\(\$\('settings-page-width'\)\.value\),/);
  // config 的 clamp 保留 600–1600（历史 900 / 1000 照常加载）
  const configSrc = fs.readFileSync(path.join(ROOT, 'core', 'config.js'), 'utf8');
  assert.equal(configSrc.split('clampRoundedInt(width, 600, 1600, DEFAULTS.editorPageWidth)').length - 1, 1);
  assert.equal(configSrc.split('clampRoundedInt(pageWidth, 600, 1600, DEFAULTS.editorPageWidth)').length - 1, 1);
});

test('renderSettingsCaretColors：色板 data-active / aria-pressed / --swatch，取色器空值退回预设色', () => {
  const ctx = build();
  const row = ctx.dom.map.get('settings-caret-colors');
  const preset = caretColorLib.PRESET_VALUES[0];
  const s1 = makeEl('button');
  s1.dataset.settingsCaretColor = '#c0392b';
  const s2 = makeEl('button');
  s2.dataset.settingsCaretColor = preset;
  row.append(s1, s2);
  ctx.state.settingsCaretColorDraft = '#c0392b';
  ctx.ui.renderSettingsCaretColors();
  assert.equal(s1.dataset.active, '1');
  assert.equal(s2.dataset.active, '0');
  assert.equal(s1.getAttribute('aria-pressed'), 'true');
  assert.equal(s1.style._props['--swatch'], '#c0392b');
  assert.equal(ctx.dom.map.get('settings-caret-color').value, '#c0392b');
});

test('renderChapterTemplatePreview：未设置模板给说明；设置了按「下一个章号」展开预览', () => {
  const ctx = build({ view: 'editor', bookPath: '/书库/书甲' });
  ctx.state.chapters = [1, 2, 3];
  ctx.dom.map.get('settings-chapter-template').value = '';
  ctx.ui.renderChapterTemplatePreview();
  assert.equal(ctx.dom.map.get('settings-template-preview').textContent, '预览：（未设置模板，新建章节仍是空章）');

  const tpl = '第{n}章：{title}';
  ctx.dom.map.get('settings-chapter-template').value = tpl;
  ctx.ui.renderChapterTemplatePreview();
  const expected = templateLib.applyTemplate(tpl, { chapterNumber: 4, chapterName: '示例章名', now: new Date() });
  assert.equal(ctx.dom.map.get('settings-template-preview').textContent, `预览（第 4 章）：\n${expected}`);
  assert.equal(ctx.dom.map.get('settings-template-preview').textContent, '预览（第 4 章）：\n第4章：示例章名');
});

test('openSettings（全局）：回填全部输入框、按全局作用域显隐、刷统计、读台账（词表三态 / 日志 / 更新）', async () => {
  const ctx = build({
    view: 'shelf', bookId: null,
    config: {
      booksRoot: '/书库', editorFont: 'custom', editorCustomFontPath: '', editorCustomFontName: '',
      editorFontSize: 20, editorLineHeight: 2, editorLetterSpacing: 0.05, editorPaddingX: 40, editorPageWidth: 800,
      editorPaper: 'night', caretParagraph: true, caretParagraphColor: '#c0392b',
      editorTextAutospace: true,
      longParagraphThreshold: 620,
      snapshotEnabled: true, snapshotKeepDays: 14, dailyGoal: 1200, writeDurationEnabled: true,
      clipboardWatchEnabled: true,
      chapterTemplate: '第{n}章：{title}', exportConversion: 's2t',
      sensitiveWordsPath: '/词表/敏感', proofreadWordsPath: '/词表/校对'
    },
    logResult: { files: [{ bytes: 2048 }, { bytes: 1024 }] }
  });
  await ctx.ui.openSettings();
  assert.equal(ctx.state.settingsScope, 'global');
  assert.equal(ctx.calls.refreshStats, 1);
  assert.equal(ctx.dom.map.get('settings-backdrop').classList.contains('hidden'), false);
  assert.equal(ctx.dom.map.get('settings-root').value, '/书库');
  assert.equal(ctx.dom.map.get('settings-font').value, 'serif', 'custom 但没草稿路径 → serif');
  assert.equal(ctx.dom.map.get('settings-size').value, '20');
  assert.equal(ctx.dom.map.get('settings-paper').value, 'night');
  assert.equal(ctx.dom.map.get('settings-caret-paragraph').checked, true);
  // 中西文自动间距（1.3.0 T-08）：回填生效值，默认开
  assert.equal(ctx.dom.map.get('settings-text-autospace').checked, true);
  assert.equal(ctx.state.settingsCaretColorDraft, '#c0392b');
  // 超长段落阈值（1.1.0）：回填全局默认，范围提示与作用域一起更新
  assert.equal(ctx.dom.map.get('settings-long-para-threshold').value, '620');
  assert.match(ctx.dom.map.get('settings-long-para-hint').textContent, /^全局默认/);
  assert.equal(ctx.dom.map.get('settings-snapshot-enabled').checked, true);
  assert.equal(ctx.dom.map.get('settings-daily-goal').value, '1200');
  assert.equal(ctx.dom.map.get('settings-chapter-template').value, '第{n}章：{title}');
  assert.equal(ctx.dom.map.get('settings-export-conversion').value, 's2t');
  assert.equal(ctx.calls.renderDurationSettings, 1);
  assert.equal(ctx.calls.renderStatsChart, 1);
  // 全局作用域里数据台账：敏感词 / 校对词表（异步读一次）、日志、更新版本
  assert.equal(ctx.calls.sensitiveWordsInfo, 1);
  assert.equal(ctx.calls.proofreadWordsInfo, 1);
  assert.equal(ctx.dom.map.get('settings-sensitive-status').textContent, '敏感词表 3 个');
  assert.equal(ctx.dom.map.get('settings-proofread-status').textContent, '校对词表 4 个');
  assert.equal(ctx.calls.logInfo, 1);
  assert.equal(ctx.dom.map.get('settings-logs-status').textContent, '已有 2 个日志文件，共 3.0 KB（不含正文）');
  assert.equal(ctx.dom.map.get('settings-update-version').textContent, 'v0.10.0');
  assert.equal(ctx.dom.map.get('settings-update-status').textContent, '尚未检查（只在点按钮时联网，不会自动检查）');
  // 全局作用域：全局分区可见、重置本书显示按钮隐藏
  assert.equal(ctx.dom.map.get('settings-root-field').classList.contains('hidden'), false);
  assert.equal(ctx.dom.map.get('btn-reset-book-display').classList.contains('hidden'), true);
  assert.match(ctx.dom.map.get('settings-scope-hint').textContent, /^这里是全局默认设置/);
});

test('openSettings（按书）：隐藏全局分区、显示重置按钮、换成按书提示，且不读台账', async () => {
  const ctx = build({
    view: 'editor', bookId: 'id-1',
    config: { booksRoot: '/书库', editorFont: 'serif', longParagraphThreshold: 640, editorTextAutospace: false },
    sensitiveWordsDraft: '/词表/敏感.txt',
    proofreadWordsDraft: '/词表/校对.txt'
  });
  await ctx.ui.openSettings();
  assert.equal(ctx.state.settingsScope, 'book');
  for (const id of ['settings-root-field', 'settings-snapshot-field', 'settings-snapshot-days-field', 'settings-stats-group',
    'settings-duration-field', 'settings-clipboard-field',
    'settings-sensitive-group', 'settings-proofread-group', 'settings-template-group', 'settings-export-group',
    'settings-logs-group', 'settings-update-group']) {
    assert.equal(ctx.dom.map.get(id).classList.contains('hidden'), true, id + ' 应隐藏');
  }
  assert.equal(ctx.calls.sensitiveWordsInfo, 0, '按书作用域不读词表');
  assert.equal(ctx.calls.proofreadWordsInfo, 0);
  assert.equal(ctx.calls.logInfo, 0, '按书作用域不读日志');
  assert.match(ctx.dom.map.get('settings-caret-hint').textContent, /^只影响这本书/);
  assert.equal(ctx.dom.map.get('settings-long-para-threshold').value, '640');
  assert.match(ctx.dom.map.get('settings-long-para-hint').textContent, /^只影响这本书/);
  // 中西文自动间距（1.3.0 T-08）：这本书单独关过 → 回填不勾；别的书不勾时回落全局默认开
  assert.equal(ctx.dom.map.get('settings-text-autospace').checked, false);
  assert.match(ctx.dom.map.get('settings-scope-hint').textContent, /^只影响「书甲」的显示设置/);
});

test('renderSensitiveSettings / renderProofreadSettings：未设置 / 读取中 / 有状态（ok / 不 ok）三态', () => {
  const ctx = build();
  ctx.state.sensitiveWordsDraft = '';
  ctx.state.sensitiveWordsInfo = null;
  ctx.ui.renderSensitiveSettings();
  assert.match(ctx.dom.map.get('settings-sensitive-status').textContent, /^未设置：预检前需要先选一个自己的词表 txt/);
  ctx.state.sensitiveWordsDraft = '/词表/敏感.txt';
  ctx.ui.renderSensitiveSettings();
  assert.equal(ctx.dom.map.get('settings-sensitive-status').textContent, '正在读取词表…');
  ctx.state.sensitiveWordsInfo = { ok: true, count: 3 };
  ctx.ui.renderSensitiveSettings();
  assert.equal(ctx.dom.map.get('settings-sensitive-status').textContent, '敏感词表 3 个');
  ctx.state.sensitiveWordsInfo = { ok: false };
  ctx.ui.renderSensitiveSettings();
  assert.equal(ctx.dom.map.get('settings-sensitive-status').className, 'muted small warn');

  ctx.state.proofreadWordsDraft = '';
  ctx.ui.renderProofreadSettings();
  assert.match(ctx.dom.map.get('settings-proofread-status').textContent, /^未设置：校对时只跑内置的五条规则/);
  ctx.state.proofreadWordsDraft = '/词表/校对.txt';
  ctx.ui.renderProofreadSettings();
  assert.equal(ctx.dom.map.get('settings-proofread-status').textContent, '正在读取词表…');
  ctx.state.proofreadWordsInfo = { ok: true, count: 4 };
  ctx.ui.renderProofreadSettings();
  assert.equal(ctx.dom.map.get('settings-proofread-status').textContent, '校对词表 4 个');
});

test('数据台账异步失败：词表读失败写进状态、日志读失败写 error（都只显示不抛）', async () => {
  const ctx = build({
    view: 'shelf', bookId: null,
    config: { booksRoot: '/书库', sensitiveWordsPath: '/词表/敏感', proofreadWordsPath: '/词表/校对' },
    wordInfoError: 'EACCES', logError: '目录没权限'
  });
  await ctx.ui.openSettings();
  assert.deepEqual(ctx.state.sensitiveWordsInfo, { ok: false, message: '读取词表失败：EACCES' });
  assert.deepEqual(ctx.state.proofreadWordsInfo, { ok: false, message: '读取校对词表失败：EACCES' });
  assert.equal(ctx.dom.map.get('settings-proofread-status').className, 'muted small warn');
  assert.equal(ctx.dom.map.get('settings-logs-status').textContent, '读取日志目录失败：目录没权限');
});

test('checkUpdate：忙碌短路、发现新版本 toast、失败结构化；下载页打开 / 只回报地址 / 无地址 / 抛错', async () => {
  const busy = build();
  busy.state.update = { busy: true, result: { status: 'old' } };
  assert.deepEqual(await busy.ui.checkUpdate(), { status: 'old' });
  assert.equal(busy.calls.checkUpdate, 0);

  const ok = build({ updateResult: { status: 'update', latestVersion: '0.11.0', currentVersion: '0.10.0' } });
  const result = await ok.ui.checkUpdate();
  assert.equal(result.status, 'update');
  assert.deepEqual(ok.calls.toast, [['发现新版本 v0.11.0（当前 v0.10.0）', undefined]]);
  assert.equal(ok.state.update.busy, false);
  // checkUpdate 之后设置弹层状态区也跟着刷（发现新版本 → 下载页按钮出现）
  assert.match(ok.dom.map.get('settings-update-status').textContent, /^发现新版本 v0.11.0/);
  assert.equal(ok.dom.map.get('btn-open-update').classList.contains('hidden'), false);

  const fail = build({ updateError: '网络断了' });
  const errResult = await fail.ui.checkUpdate();
  assert.equal(errResult.status, 'error');
  assert.match(errResult.message, /检查更新失败：网络断了/);
  assert.equal(fail.state.update.busy, false);
  assert.equal(fail.dom.map.get('settings-update-status').className, 'muted small warn');

  const opened = build({ downloadResult: { opened: true } });
  await opened.ui.openUpdateDownload();
  assert.deepEqual(opened.calls.toast, [['已用浏览器打开 GitHub 下载页（应用不会自动下载或安装）', undefined]]);

  const urlOnly = build({ downloadResult: { url: 'https://example.com' } });
  await urlOnly.ui.openUpdateDownload();
  assert.deepEqual(urlOnly.calls.toast, [['下载页：https://example.com', undefined]]);

  const none = build({ downloadResult: { message: '没有下载页' } });
  await none.ui.openUpdateDownload();
  assert.deepEqual(none.calls.toast, [['没有下载页', 'warn']]);

  const boom = build();
  boom.host.api.openUpdateDownload = async () => { throw new Error('主进程炸了'); };
  assert.equal(await boom.ui.openUpdateDownload(), null);
  assert.deepEqual(boom.calls.toast, [['打开下载页失败：主进程炸了', 'error']]);
});

// ---------- 作用域显隐 / 预览 ----------
test('previewSettings：没有备份直接返回；有备份就按表单预览显示项，写作页里顺便预览当前段落高亮', () => {
  const ctx = build({ view: 'editor', bookPath: '/书库/书甲', index: 0 });
  ctx.state.settingsBackup = { booksRoot: '/书库' };
  ctx.ui.previewSettings();
  assert.deepEqual(ctx.calls.applyEditorStyle, [{ booksRoot: '/书库', editorFont: 'serif', editorFontSize: 18, editorLineHeight: 1.95, editorLetterSpacing: 0.02, editorPaddingX: 56, editorPageWidth: 0, editorPaper: 'paper', caretParagraph: false, caretParagraphColor: '' }]);
  assert.equal(ctx.calls.renderMarksMenu, 1);
  assert.equal(ctx.calls.renderEditorMarks, 1);
  assert.equal(ctx.state.marks.caretLine, 0);

  const noBackup = build();
  noBackup.ui.previewSettings();
  assert.deepEqual(noBackup.calls.applyEditorStyle, []);
});

// ---------- 打开 / 关闭 / 保存 ----------
test('openSettings：按视图定作用域、备份配置、刷统计、回填、显隐，全局作用域再读词表 / 日志 / 更新', async () => {
  const ctx = build({ view: 'shelf', bookId: null, config: { booksRoot: '/书库' } });
  await ctx.ui.openSettings();
  assert.equal(ctx.state.settingsScope, 'global');
  assert.deepEqual(ctx.state.settingsBackup, { booksRoot: '/书库' });
  assert.equal(ctx.calls.refreshStats, 1);
  assert.equal(ctx.dom.map.get('settings-backdrop').classList.contains('hidden'), false);
  assert.equal(ctx.calls.sensitiveWordsInfo, 0, '没设置词表路径不读');
  assert.equal(ctx.calls.proofreadWordsInfo, 0);
  assert.equal(ctx.calls.logInfo, 1, '全局作用域读一次日志目录');
  // 版本区至少渲染一次
  assert.equal(ctx.dom.map.get('settings-update-version').textContent, 'v0.10.0');

  const book = build({ view: 'editor', bookId: 'id-1', config: {} });
  await book.ui.openSettings();
  assert.equal(book.state.settingsScope, 'book', '写作页且有书 → 按书作用域');
});

test('openSettings（U-D4 全局入口）：写作页里打开全局设置按全局默认回填，不把本书覆盖值当全局', async () => {
  const ctx = build({
    view: 'editor', bookId: 'id-1',
    // 生效值 = 全局 + 本书覆盖：字号 22 / 夜间 / 高亮开（都来自 bookDisplay）
    config: { booksRoot: '/书库', editorFontSize: 22, editorPaper: 'night', dailyGoal: 3000, caretParagraph: true, caretParagraphColor: '#3f7fbf' },
    bookDisplay: { editorFontSize: 22, editorPaper: 'night', dailyGoal: 3000, caretParagraph: true, caretParagraphColor: '#3f7fbf' }
  });
  // 全局默认是另一份：字号 18 / 纸色 paper / 高亮关 / 目标 1200
  ctx.state.globalConfig = { booksRoot: '/书库', editorFontSize: 18, editorPaper: 'paper', dailyGoal: 1200, caretParagraph: false, caretParagraphColor: '' };
  await ctx.ui.openSettings({ scope: 'global' });
  assert.equal(ctx.state.settingsScope, 'global');
  assert.equal(ctx.dom.map.get('settings-size').value, '18', '回填全局默认，不是本书覆盖的 22');
  assert.equal(ctx.dom.map.get('settings-paper').value, 'paper');
  assert.equal(ctx.dom.map.get('settings-caret-paragraph').checked, false);
  assert.equal(ctx.state.settingsCaretColorDraft, '');
  assert.equal(ctx.dom.map.get('settings-daily-goal').value, '1200');
  // 写作页里的全局设置提示改成「全局默认 / 本书仍以本书为准」，不再说「只影响当前这本书」
  assert.match(ctx.dom.map.get('settings-scope-hint').textContent, /^这里是全局默认设置/);
  assert.match(ctx.dom.map.get('settings-scope-hint').textContent, /正文显示设置/);
  // 全局作用域照旧读台账（词表 / 日志 / 更新）
  assert.equal(ctx.calls.logInfo, 1);
  assert.equal(ctx.dom.map.get('settings-update-version').textContent, 'v0.10.0');
});

test('openStatsCalendar（U-D4）：打开全局设置并定位到码字日历；按书作用域 / 没有 scrollIntoView 时都不抛', async () => {
  const ctx = build({ view: 'editor', bookId: 'id-1', config: { booksRoot: '/书库' } });
  const calendarField = ctx.dom.map.get('settings-calendar-field');
  const scrolls = [];
  calendarField.scrollIntoView = (opts) => scrolls.push(opts);
  assert.equal(await ctx.ui.openStatsCalendar(), 'global');
  assert.equal(ctx.state.settingsScope, 'global');
  assert.equal(ctx.dom.map.get('settings-backdrop').classList.contains('hidden'), false);
  assert.equal(calendarField.classList.contains('hidden'), false, '全局作用域日历可见');
  assert.deepEqual(scrolls, [{ block: 'center' }], '只滚日历分区、居中');

  // 按书作用域里日历是隐藏分区：传了 section 也不该滚（防以后误用）
  const book = build({ view: 'editor', bookId: 'id-1' });
  const bookField = book.dom.map.get('settings-calendar-field');
  const bookScrolls = [];
  bookField.scrollIntoView = (opts) => bookScrolls.push(opts);
  await book.ui.openSettings({ scope: 'book', section: 'calendar' });
  assert.equal(book.state.settingsScope, 'book');
  assert.equal(bookField.classList.contains('hidden'), true);
  assert.deepEqual(bookScrolls, [], '隐藏分区不滚');

  // 老环境 / 假 DOM 没有 scrollIntoView：打开照常成功，不抛
  const plain = build({ view: 'shelf', bookId: null, config: { booksRoot: '/书库' } });
  await plain.ui.openStatsCalendar();
  assert.equal(plain.state.settingsScope, 'global');
  assert.equal(plain.dom.map.get('settings-backdrop').classList.contains('hidden'), false);
});

test('openStatsCalendar（U-D4）取消不写盘：打开日历再取消，setConfig / bookDisplay 一个写调用都没有', async () => {
  const ctx = build({ view: 'editor', bookId: 'id-1', config: { booksRoot: '/书库', editorFontSize: 20 }, bookDisplay: { editorFontSize: 20 } });
  ctx.state.globalConfig = { booksRoot: '/书库', editorFontSize: 18 };
  const before = { ...ctx.state.config };
  await ctx.ui.openStatsCalendar();
  ctx.ui.closeSettings();
  assert.deepEqual(ctx.calls.setConfig, []);
  assert.deepEqual(ctx.calls.setBookDisplay, []);
  assert.deepEqual(ctx.calls.resetBookDisplay, []);
  assert.deepEqual(ctx.state.config, before, '取消后生效配置回到打开前');
  assert.equal(ctx.dom.map.get('settings-backdrop').classList.contains('hidden'), true);
  assert.equal(ctx.state.settingsBackup, null);
});

test('saveSettings（U-D4 全局入口）：写作页里保存的是全局默认值，只走 setConfig', async () => {
  const ctx = build({
    view: 'editor', bookId: 'id-1',
    config: { booksRoot: '/书库', editorFontSize: 22, dailyGoal: 3000 },
    bookDisplay: { editorFontSize: 22, dailyGoal: 3000 },
    displayForm: {
      editorFont: 'serif', editorFontSize: 18, editorLineHeight: 1.95, editorLetterSpacing: 0.02,
      editorPaddingX: 56, editorPageWidth: 0, editorPaper: 'paper', caretParagraph: false, caretParagraphColor: ''
    }
  });
  ctx.state.globalConfig = { booksRoot: '/书库', editorFontSize: 18, dailyGoal: 1200 };
  await ctx.ui.openSettings({ scope: 'global' });
  await ctx.ui.saveSettings();
  assert.equal(ctx.calls.setConfig.length, 1);
  assert.equal(ctx.calls.setBookDisplay.length, 0, '全局入口不写按书覆盖');
  assert.equal(ctx.calls.setConfig[0].editorFontSize, 18, '写全局默认值，不是本书的 22');
  assert.equal(ctx.calls.setConfig[0].dailyGoal, 1200);
  assert.deepEqual(ctx.calls.toast, [['设置已保存（全局默认）', undefined]]);
});

test('openSettings（U-D4 旧配置）：全局配置缺统计 / 时长 / 模板键也能打开，按默认回填且取消不写盘', async () => {
  const ctx = build({ view: 'editor', bookId: 'id-1', config: { booksRoot: '/书库' } });
  // 旧 config：没有任何统计 / 时长 / 剪贴板 / 模板 / 导出键（本单元没有新增字段，缺键照旧按默认）
  ctx.state.globalConfig = { booksRoot: '/书库' };
  await ctx.ui.openSettings({ scope: 'global' });
  assert.equal(ctx.dom.map.get('settings-daily-goal').value, '0');
  assert.equal(ctx.dom.map.get('settings-write-duration').checked, false);
  assert.equal(ctx.dom.map.get('settings-clipboard-watch').checked, false);
  assert.equal(ctx.dom.map.get('settings-chapter-template').value, '');
  assert.equal(ctx.dom.map.get('settings-export-conversion').value, '');
  assert.equal(ctx.dom.map.get('settings-snapshot-enabled').checked, false);
  assert.equal(ctx.dom.map.get('settings-snapshot-days').value, '7');
  ctx.ui.closeSettings();
  assert.deepEqual(ctx.calls.setConfig, [], '只打开 / 取消不写盘');
});

test('closeSettings：默认回到打开前的配置并重绘显示层；restore=false 只关弹层；两种情况都清备份', () => {
  const ctx = build();
  const backup = { booksRoot: '/旧书库' };
  ctx.state.settingsBackup = backup;
  ctx.dom.map.get('settings-backdrop').classList.remove('hidden');
  ctx.ui.closeSettings();
  assert.equal(ctx.dom.map.get('settings-backdrop').classList.contains('hidden'), true);
  assert.equal(ctx.state.config, backup);
  assert.deepEqual(ctx.calls.applyEditorStyle, [undefined]);
  assert.equal(ctx.calls.syncCaretParagraphFromConfig, 1);
  assert.equal(ctx.calls.renderWriteTimer, 1);
  assert.equal(ctx.calls.renderDurationSettings, 1);
  assert.equal(ctx.state.settingsBackup, null);

  const noRestore = build();
  noRestore.state.settingsBackup = { booksRoot: '/旧书库' };
  noRestore.ui.closeSettings({ restore: false });
  assert.deepEqual(noRestore.calls.applyEditorStyle, []);
  assert.equal(noRestore.state.settingsBackup, null);
});

test('右上 × 关闭（拍板 #3）：与「取消」完全同义；即使监听把 MouseEvent 当参数传进来也照样还原预览', () => {
  const ctx = build();
  ctx.ui.setupSettingsUi();
  // × 只注册一次点击，且和「取消」是同一套行为（不是另一个函数）
  assert.deepEqual(ctx.dom.map.get('btn-settings-close')._listeners.map((l) => l.type), ['click']);
  assert.deepEqual(ctx.dom.map.get('btn-settings-cancel')._listeners.map((l) => l.type), ['click']);

  const backup = { booksRoot: '/旧书库' };
  ctx.state.settingsBackup = backup;
  ctx.state.config = { booksRoot: '/新书库', editorFont: 'custom' };
  ctx.dom.map.get('settings-backdrop').classList.remove('hidden');
  // 真实浏览器里监听收到的是 MouseEvent：解构 {restore=true} 不能让 restore 变成 undefined 之外的东西
  ctx.dom.map.get('btn-settings-close')._fire('click', { type: 'click', target: null });
  assert.equal(ctx.dom.map.get('settings-backdrop').classList.contains('hidden'), true, '点 × 收起弹层');
  assert.equal(ctx.state.config, backup, '× 也要还原打开前的预览配置');
  assert.deepEqual(ctx.calls.applyEditorStyle, [undefined]);
  assert.equal(ctx.calls.syncCaretParagraphFromConfig, 1);
  assert.equal(ctx.calls.renderWriteTimer, 1);
  assert.equal(ctx.calls.renderDurationSettings, 1);
  assert.equal(ctx.state.settingsBackup, null, '备份用完即清');

  // 已经关掉再点一次不炸（幂等）
  ctx.dom.map.get('btn-settings-close')._fire('click', { type: 'click' });
  assert.equal(ctx.dom.map.get('settings-backdrop').classList.contains('hidden'), true);
  assert.equal(ctx.state.settingsBackup, null);
});

test('静态闸门：设置弹层右上只有一个 ×，标签与 aria 到位，绑定只在 settings-ui 里', () => {
  const backdropAt = indexSrc.indexOf('id="settings-backdrop"');
  const closeAt = indexSrc.indexOf('id="btn-settings-close"');
  assert.notEqual(closeAt, -1, 'index.html 要有 btn-settings-close');
  assert.ok(backdropAt !== -1 && backdropAt < closeAt, '× 必须在设置弹层里');
  // 紧随标题之后（同一行块内），class 用通用的 .modal-close
  const block = indexSrc.slice(backdropAt, backdropAt + 400);
  assert.match(block, /<h2 class="modal-title" id="settings-title">设置<\/h2>\s*<button id="btn-settings-close" class="modal-close" type="button"/);
  assert.match(block, /title="关闭设置（Esc）" aria-label="关闭设置">×<\/button>/);
  assert.equal(indexSrc.split('id="btn-settings-close"').length - 1, 1, '只加一个');
  assert.equal(rendererSrc.includes("$('btn-settings-close').addEventListener"), false, '绑定只在模块里');
  assert.equal(moduleSrc.includes("$('btn-settings-close').addEventListener('click', closeSettings);"), true);
});

test('resetBookDisplay：不是按书作用域直接 false；成功写回全局默认并重填表单；失败 toast', async () => {
  const notBook = build({ scope: 'global' });
  assert.equal(await notBook.ui.resetBookDisplay(), false);

  const ctx = build({ scope: 'book', bookId: 'id-1', config: { editorFont: 'custom', editorCustomFontPath: '/字体/a.ttf' } });
  assert.equal(await ctx.ui.resetBookDisplay(), true);
  assert.deepEqual(ctx.calls.resetBookDisplay, ['id-1']);
  assert.deepEqual(ctx.state.bookDisplay, {});
  assert.equal(ctx.calls.loadCustomFont.length, 1, '自定义字体要重新加载');
  assert.deepEqual(ctx.calls.applySidebarWidth, [250]);
  assert.deepEqual(ctx.state.settingsBackup, ctx.state.config);
  assert.deepEqual(ctx.calls.toast, [['已恢复为全局默认（这本书不再有单独设置）', undefined]]);

  const fail = build({ scope: 'book', bookId: 'id-1', resetError: '读不到' });
  assert.equal(await fail.ui.resetBookDisplay(), false);
  assert.deepEqual(fail.calls.toast, [['恢复默认失败：读不到', 'error']]);
});

test('saveSettings（按书）：写 bookDisplay、重绘显示层、关弹层并提示「只影响本书」', async () => {
  const ctx = build({ scope: 'book', bookId: 'id-1' });
  ctx.state.settingsScope = 'book';
  await ctx.ui.saveSettings();
  assert.equal(ctx.calls.setBookDisplay.length, 1);
  assert.equal(ctx.calls.setBookDisplay[0][0], 'id-1');
  assert.equal(ctx.calls.syncCaretParagraphFromConfig, 1);
  assert.deepEqual(ctx.calls.applySidebarWidth, [250]);
  assert.equal(ctx.calls.toast.length, 1);
  assert.deepEqual(ctx.calls.toast[0], ['已保存：这本书的显示设置（只影响本书）', undefined]);
  assert.equal(ctx.dom.map.get('settings-backdrop').classList.contains('hidden'), true);
  assert.deepEqual(ctx.calls.setConfig, []);
});

test('saveSettings（全局）：关闭写作时长前 flush、setConfig payload 逐字段、刷新书架与两个词表', async () => {
  const ctx = build({ writeDurationEnabled: true });
  ctx.state.settingsScope = 'global';
  ctx.dom.map.get('settings-root').value = '  /新书库  ';
  ctx.dom.map.get('settings-snapshot-enabled').checked = true;
  ctx.dom.map.get('settings-snapshot-days').value = '14';
  ctx.dom.map.get('settings-daily-goal').value = 'abc';
  ctx.dom.map.get('settings-write-duration').checked = false;
  ctx.dom.map.get('settings-clipboard-watch').checked = true;
  ctx.dom.map.get('settings-chapter-template').value = '第{chapterNumber}章';
  ctx.dom.map.get('settings-export-conversion').value = 's2t';
  ctx.state.sensitiveWordsDraft = ' /词表/敏感.txt ';
  ctx.state.proofreadWordsDraft = '/词表/校对.txt';
  await ctx.ui.saveSettings();
  assert.equal(ctx.calls.flushWriteTimer, 1, '关掉写作时长前先 flush');
  assert.equal(ctx.calls.setConfig.length, 1);
  const patch = ctx.calls.setConfig[0];
  assert.equal(patch.booksRoot, '/新书库');
  assert.equal(patch.snapshotEnabled, true);
  assert.equal(patch.snapshotKeepDays, 14);
  assert.equal(patch.dailyGoal, 0, '坏值按 0');
  assert.equal(patch.writeDurationEnabled, false);
  assert.equal(patch.clipboardWatchEnabled, true, 'b8：剪贴板后台监听开关随设置保存');
  assert.equal(patch.chapterTemplate, '第{chapterNumber}章');
  assert.equal(patch.exportConversion, 's2t');
  assert.equal(patch.sensitiveWordsPath, '/词表/敏感.txt');
  assert.equal(patch.proofreadWordsPath, '/词表/校对.txt');
  assert.equal(ctx.calls.applyWriteTimerConfig, 1);
  assert.deepEqual(ctx.calls.toast, [['设置已保存（全局默认）', undefined]]);
  assert.equal(ctx.calls.refreshShelf, 1);
  assert.equal(ctx.calls.refreshSensitiveWordList, 1);
  assert.equal(ctx.calls.refreshProofreadWordList, 1);

  const fail = build({ saveError: '写盘失败' });
  fail.state.settingsScope = 'global';
  await fail.ui.saveSettings();
  assert.deepEqual(fail.calls.toast, [['保存设置失败：写盘失败', 'error']]);
});

test('超长段落阈值（1.1.0）：回填按同一夹紧口径，保存 payload 两种作用域都带阈值，取消不写盘', async () => {
  // 回填：越界 / 坏值按 editor-logic 同一口径（20001→20000 / 49→50 / 缺字段→500）
  for (const [raw, expected] of [[20001, '20000'], [49, '50'], [undefined, '500']]) {
    const ctx = build({
      view: 'shelf',
      bookId: null,
      config: { booksRoot: '/书库', longParagraphThreshold: raw }
    });
    await ctx.ui.openSettings();
    assert.equal(ctx.dom.map.get('settings-long-para-threshold').value, expected, String(raw));
  }

  // 表单里的阈值原样进按书保存路径（真正读输入框的 readDisplayForm 在 renderer.js，E2E 覆盖）
  const displayForm = {
    editorFont: 'serif', editorFontSize: 18, editorLineHeight: 1.95, editorLetterSpacing: 0.02,
    editorPaddingX: 56, editorPageWidth: 0, editorPaper: 'paper',
    caretParagraph: false, caretParagraphColor: '', editorTextAutospace: false, longParagraphThreshold: 650
  };
  const book = build({ scope: 'book', bookId: 'id-1', displayForm });
  book.state.settingsScope = 'book';
  await book.ui.saveSettings();
  assert.equal(book.calls.setBookDisplay.length, 1);
  assert.equal(book.calls.setBookDisplay[0][1].longParagraphThreshold, 650);
  assert.equal(book.calls.setBookDisplay[0][1].editorTextAutospace, false, '按书保存带上中西文间距开关');
  assert.deepEqual(book.calls.setConfig, [], '按书保存不碰全局默认');

  // 取消：打开设置、改输入框、直接关 → 一个写调用都没有（草稿只活在表单里）
  const cancel = build({ view: 'shelf', bookId: null, displayForm });
  await cancel.ui.openSettings();
  cancel.dom.map.get('settings-long-para-threshold').value = '700';
  cancel.ui.closeSettings();
  assert.deepEqual(cancel.calls.setConfig, []);
  assert.deepEqual(cancel.calls.setBookDisplay, []);
  assert.equal(cancel.dom.map.get('settings-backdrop').classList.contains('hidden'), true);

  // 全局保存：同一份表单进 setConfig（书架设置里改的是全局默认）
  const globalCtx = build({ view: 'shelf', bookId: null, displayForm });
  globalCtx.state.settingsScope = 'global';
  await globalCtx.ui.saveSettings();
  assert.equal(globalCtx.calls.setConfig.length, 1);
  assert.equal(globalCtx.calls.setConfig[0].longParagraphThreshold, 650);
  assert.equal(globalCtx.calls.setConfig[0].editorTextAutospace, false, '全局保存同样带中西文间距开关');
});

// ---------- 事件绑定 ----------
test('setupSettingsUi：注册设置域的全部监听（含显示项循环 / 色板 / 取色器 / 两个条件按钮）', () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  ctx.ui.setupSettingsUi();
  for (const id of ['btn-settings', 'btn-settings-cancel', 'btn-settings-close', 'btn-settings-save', 'btn-reset-book-display',
    'btn-pick-folder', 'btn-pick-sensitive', 'btn-clear-sensitive', 'btn-pick-proofread', 'btn-clear-proofread',
    'btn-open-logs', 'btn-check-update', 'btn-open-update', 'btn-pick-font', 'btn-reset-font',
    'settings-chapter-template', 'settings-font', 'settings-caret-paragraph', 'settings-caret-colors',
    'settings-caret-color', 'btn-proofread-pick']) {
    assert.equal(dom.map.get(id)._listeners.length >= 1, true, id + ' 应该有监听');
  }
  for (const id of DISPLAY_IDS) assert.equal(dom.map.get(id)._listeners.length, 1, id + ' 显示项循环注册');
  assert.deepEqual(dom.map.get('settings-caret-color')._listeners.map((l) => l.type), ['input', 'change']);

  // 触发：取消 → 关弹层
  dom.map.get('settings-backdrop').classList.remove('hidden');
  dom.map.get('btn-settings-cancel')._fire('click');
  assert.equal(dom.map.get('settings-backdrop').classList.contains('hidden'), true);

  // 清敏感词：清草稿 + 刷新设置里的词表状态
  dom.map.get('btn-clear-sensitive')._fire('click');
  assert.equal(ctx.state.sensitiveWordsDraft, '');
  // 清校对词表
  dom.map.get('btn-clear-proofread')._fire('click');
  assert.equal(ctx.state.proofreadWordsDraft, '');
});

test('setupSettingsUi：字体 change 选 custom 但没草稿 → 警告并回 serif；选目录写回 root 输入框', async () => {
  const dom = makeDocument();
  const ctx = build({ dom, folder: '/新书库' });
  ctx.state.settingsFontDraft = { path: '', name: '' };
  ctx.ui.setupSettingsUi();
  dom.map.get('settings-font').value = 'custom';
  dom.map.get('settings-font')._fire('change', {});
  await flush();
  assert.equal(dom.map.get('settings-font').value, 'serif');
  assert.deepEqual(ctx.calls.toast, [['先点「选择…」挑一个 .ttf / .otf 字体文件', 'warn']]);

  await dom.map.get('btn-pick-folder')._fire('click');
  await flush();
  assert.equal(ctx.calls.pickFolder, 1);
  assert.equal(dom.map.get('settings-root').value, '/新书库');
});

// ---------- 静态闸门 ----------
test('静态闸门：renderer.js 不再内嵌设置实现，只剩装配与转发', () => {
  for (const shape of [
    'function setSelectValue(',
    'function renderSettingsCaretColors(',
    'function fillSettingsFields(',
    'function renderChapterTemplatePreview(',
    'function renderSensitiveSettings(',
    'function renderProofreadSettings(',
    'function renderLogSettings(',
    'function formatUpdateDate(',
    'async function checkUpdate(',
    'async function openUpdateDownload(',
    'async function openSettings(',
    'async function saveSettings(',
    'async function resetBookDisplay(',
    'function updateSettingsScopeUi(',
    'function previewSettings('
  ]) {
    assert.equal(rendererSrc.includes(shape), false, 'renderer.js 里还有第二份：' + shape);
  }
  assert.equal(rendererSrc.split('settingsUiModule.create(').length - 1, 1, '装配只许一处');
  assert.ok(rendererSrc.includes('const settingsUiModule = window.CWSettingsUi;'));
  for (const line of [
    '    $, state, api, call, toast, chaptersLib,',
    '    display: { applyEditorStyle, syncCaretParagraphFromConfig, effectiveConfig, applySidebarWidth, loadCustomFont, readDisplayForm, displaySettingsIds, caretColorLib, s2tLib, templateLib, editorLogic, applyChapterNumbering: applyChapterNumberingMeta },',
    '      stats: { refreshStats, renderStatsChart },',
    '      writeTimer: { renderDurationSettings, renderWriteTimer, applyWriteTimerConfig, writeDurationEnabled, flushWriteTimer },',
    '      editor: { renderEditorMarks, renderMarksMenu },',
    '      words: { refreshSensitiveWordList, refreshProofreadWordList, sensitiveWordListText, proofreadWordListText, pickSensitiveWords, pickProofreadWords },',
    '    texts: { commonLib, formatBytes }'
  ]) {
    assert.ok(rendererSrc.includes(line), '装配少了：' + line);
  }
  assert.ok(rendererSrc.includes(
    'const { setSelectValue, renderSettingsCaretColors, renderChapterTemplatePreview, renderSensitiveSettings, renderProofreadSettings, checkUpdate, openUpdateDownload, previewSettings, openSettings, openStatsCalendar, closeSettings, resetBookDisplay, saveSettings, setupSettingsUi } = settingsUi;'
  ), '14 个入口按原名解构');
  // 6 个绑定块里的设置 id 不再出现在 renderer 的事件绑定里（写作计时 / 日历绑定仍留）
  for (const id of ['btn-settings', 'btn-settings-cancel', 'btn-settings-save', 'btn-reset-book-display', 'btn-pick-folder',
    'btn-pick-font', 'btn-reset-font', 'settings-font', 'settings-caret-paragraph', 'settings-caret-color']) {
    assert.equal(rendererSrc.includes(`$('${id}').addEventListener`), false, '绑定应该只在模块里：' + id);
  }
  assert.equal(rendererSrc.split('settingsUi.setupSettingsUi();').length - 1, 1, 'setup 只调一次');
  assert.match(rendererSrc, /'close-settings': \(\) => closeSettings\(\),/);
  // 校对 / 敏感词装配里的 render*Settings 现在是惰性转发（TDZ）
  assert.ok(rendererSrc.includes('renderProofreadSettings: () => renderProofreadSettings()'));
  assert.ok(rendererSrc.includes('renderSensitiveSettings: () => renderSensitiveSettings()'));
  // 整理卡 / 显示菜单已随第八刀搬到 tidy-card-ui.js，这里不再断言 renderer 里直接调 openSettings；
  // 只确认 scope 键 openSettings 仍在（上面已逐个断言）
  for (const key of ['setSelectValue', 'renderSettingsCaretColors', 'renderChapterTemplatePreview', 'renderSensitiveSettings', 'renderProofreadSettings', 'checkUpdate', 'openUpdateDownload', 'previewSettings', 'openSettings', 'closeSettings', 'resetBookDisplay', 'saveSettings']) {
    assert.match(rendererSrc, new RegExp('^      ' + key + ',$', 'm'), 'testHooksScope 少了 ' + key);
  }
});

test('静态闸门（U-D4）：状态栏今日字数是按钮、点击只在渲染层接线，打开 / 回填 / 定位口径只在模块里', () => {
  // index.html：一个 button（不是 span），带 type / aria / 说明
  assert.equal(indexSrc.split('id="status-stats"').length - 1, 1);
  assert.match(indexSrc, /<button id="status-stats" class="status-stats hidden" type="button" aria-haspopup="dialog"/);
  assert.equal(indexSrc.includes('<span id="status-stats"'), false, 'span 已换成 button');
  // renderer.js 只接线：点击 → 模块入口；不自己拼作用域 / 不自己开弹层
  assert.ok(rendererSrc.includes("$('status-stats').addEventListener('click', () => {"));
  assert.ok(rendererSrc.includes('void openStatsCalendar();'));
  assert.equal(rendererSrc.includes("openSettings({ scope: 'global'"), false, '作用域口径只在模块里');
  // 模块：一个入口函数，固定「全局 + 日历分区」，复用 openSettings / closeSettings
  assert.equal((moduleSrc.match(/async function openStatsCalendar\(/g) || []).length, 1);
  assert.ok(moduleSrc.includes("await openSettings({ scope: 'global', section: 'calendar' });"));
  assert.ok(moduleSrc.includes("const SETTINGS_SECTIONS = { calendar: 'settings-calendar-field' };"));
  // 状态栏统计仍由 stats-ui 渲染（设置模块不碰 #status-stats 的文案）
  assert.equal(moduleSrc.includes("$('status-stats')"), false);
});

test('静态闸门：index.html 在 renderer.js 之前加载 settings-ui.js，且只加载一次', () => {
  const at = indexSrc.indexOf('<script src="settings-ui.js"></script>');
  const rendererAt = indexSrc.indexOf('<script src="renderer.js"></script>');
  assert.notEqual(at, -1);
  assert.ok(at < rendererAt);
  assert.equal(indexSrc.split('settings-ui.js').length - 1, 1);
});

test('静态闸门：模块不 require / 不摸 Electron·fs·网络；无全局监听 / 无定时器', () => {
  for (const forbidden of ['require(', 'ipcRenderer', 'node:fs', 'child_process', 'localStorage', 'fetch(', 'window.', 'process.']) {
    assert.equal(moduleCode.includes(forbidden), false, 'settings-ui.js 不许出现 ' + forbidden);
  }
  assert.equal(/window\.addEventListener|document\.addEventListener/.test(moduleCode), false);
  assert.equal((moduleCode.match(/setTimeout\(/g) || []).length, 0);
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWSettingsUi，且不乱造别的全局', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(moduleSrc, context, { filename: 'renderer/settings-ui.js' });
  assert.equal(typeof win.CWSettingsUi, 'object');
  assert.deepEqual(Object.keys(win.CWSettingsUi).sort(), ['REQUIRED_HOST', 'create']);
  assert.equal(win.CWSettingsUi.REQUIRED_HOST.length, 9);
  assert.equal(win.CWBookinfoUi, undefined);
});

// ---------- 结构闸门：头注释契约成员 ↔ 代码实际校验（V30） ----------
// 头注释是设置模块唯一的人读契约；它列的 host 成员必须和 createSettingsUi 真正校验的成员逐个对上，
// 否则渲染层照注释接线、少传一个成员，只会在运行时抛 TypeError。
test('结构闸门：头注释列出的 host 成员与代码实际校验一致（V30）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'settings-ui.js'), 'utf8');
  const head = src.slice(0, src.indexOf('*/'));
  assert.ok(head.length > 0, '找不到模块头注释');

  // 头注释第一段写了「host N 个成员」，N 必须等于 REQUIRED_HOST 的实际长度
  const declaredCount = Number((head.match(/host (\d+) 个成员/) || [])[1]);
  assert.equal(declaredCount, settingsUi.REQUIRED_HOST.length, '头注释的成员数要等于 REQUIRED_HOST 的实际长度');

  // display 分组：注释里逐个列出的成员 ↔ 代码里 host.display 的校验表
  const displayStart = head.indexOf('display: {');
  const displayEnd = head.indexOf('},', displayStart);
  assert.notEqual(displayStart, -1, '头注释里找不到 display 分组');
  assert.notEqual(displayEnd, -1, '头注释 display 分组没有收尾');
  const commentKeys = [...head.slice(displayStart, displayEnd).matchAll(/^\s*\*\s+([A-Za-z_$][\w$]*)\s*,?\s*(?:\/\/.*)?$/gm)].map((m) => m[1]);
  assert.ok(commentKeys.length > 0, '头注释 display 分组没解析出成员');

  const codeMatch = src.match(/for \(const key of \[([^\]]+)\]\) \{\s*if \(display\[key\]/);
  assert.ok(codeMatch, '代码里找不到 host.display 的校验表');
  const codeKeys = [...codeMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.equal(codeKeys.length, codeKeys.filter((k) => k).length);
  assert.deepEqual([...commentKeys].sort(), [...codeKeys].sort(), '头注释 display 成员要和实际校验逐个对上（缺一即红）');
});

// V34：设置面板打开时三份台账（词表 / 校对词表 / 日志目录）互不依赖——要并发发起，不许一个等一个。
test('打开设置：三份台账读取并发发起（不串行等）', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  // 词表 / 校对词表只有在「已保存路径」存在时才会去读 IPC（没路径只在本地渲染「未设置」）
  const ctx = build({
    infoGate: gate,
    config: { booksRoot: '/书库', editorFont: 'serif', sensitiveWordsPath: '/书库/敏感词.txt', proofreadWordsPath: '/书库/校对.txt' }
  });
  const opening = ctx.ui.openSettings({ scope: 'global' });
  for (let i = 0; i < 3; i += 1) await flush();
  assert.equal(ctx.calls.sensitiveWordsInfo, 1, '打开设置应先发起敏感词表读取');
  assert.equal(ctx.calls.proofreadWordsInfo, 1, '校对词表读取要同时发起（不能等敏感词表回来）');
  assert.equal(ctx.calls.logInfo, 1, '日志目录读取要同时发起（不能等前两份回来）');
  release();
  await opening;
  // 渲染结果与返回值不变：三份状态都落到 state，日志仍按条数渲染
  assert.equal(ctx.state.sensitiveWordsInfo.ok, true);
  assert.equal(ctx.state.proofreadWordsInfo.ok, true);
  assert.equal(ctx.state.logInfo.files.length, 2);
});
