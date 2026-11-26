// WP17 A3 第四刀（编辑域剩余：章节模板 / 分卷 / 批量动作）：行为 / 契约锚点。
//
// 缺陷（结构，非功能）：编辑域剩下的三块还长在渲染层编排器里——
//   · 章节模板（chapterTemplateText / applyChapterTemplate / applyMetaAndRelocate / createChapterAt）；
//   · 分卷操作（新建 / 重命名 / 上下移动 / 删除卷 + 卷内章移动 / 章节改名 / 删除 + 删除撤销）；
//   · 批量动作（批量删除 / 批量移到卷 / 批量改状态 / 导出 / 复制 / 备注）。
// 本刀把它们整段搬到 renderer/chapter-ops-ui.js（只搬不改行为），编排器只留同名包装与装配。
//
// 为什么这样测：新模块是 UMD，Node 里可以 require + create()，所以这里不只读源码：
//   ① 静态半边：模块契约 / 编排器只剩同名包装 / 装配位置（TDZ 顺序）/ 实现标记不许回流；
//   ② 行为半边：假 host 真跑模板（不套 / 非空 / execCommand 兜底）、新建章（保存失败 / 取消 /
//      含空格书目路径）、分卷四流程 + 撤销（含空格卷名 / ENOSPC / 换书不撤销）、删除章（未保存拦截 /
//      _trash 凭证 / 邻居 id / 最后一章补空章）、批量删除（从后往前 / 部分失败 / 500 章极值）、
//      批量移卷 / 改状态、导出连续范围 / 复制含未保存 / 备注。
// 修复前应当全红（模块不存在 / 包装与装配未建立），红输出留在审计目录。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const RENDERER_SRC = read('renderer/renderer.js');
const MODULE_REL = 'renderer/chapter-ops-ui.js';
const MODULE_ABS = path.join(ROOT, MODULE_REL);
const MODULE_SRC = fs.existsSync(MODULE_ABS) ? fs.readFileSync(MODULE_ABS, 'utf8') : '';
const moduleApi = fs.existsSync(MODULE_ABS) ? require('../renderer/chapter-ops-ui') : null;
const chaptersLib = require('../core/chapters');

// 从源码切一个「  [async] function 名字( ... ) { ... }」的真身（形参 / 函数体都按括号配对）。
function extractFunction(source, name) {
  const marker = new RegExp(`(?:^|\\n)  (async )?function ${name}\\(`);
  const match = marker.exec(source);
  assert.ok(match, `找不到 function ${name}(`);
  const start = match.index + (match[0].startsWith('\n') ? 1 : 0);
  const parenStart = source.indexOf('(', start);
  let parenDepth = 0;
  let cursor = parenStart;
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === '(') parenDepth += 1;
    if (source[cursor] === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) break;
    }
  }
  const bodyStart = source.indexOf('{', cursor);
  let depth = 0;
  let mode = 'code';
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i];
    if (mode === 'code') {
      if (ch === '/' && source[i + 1] === '/') { mode = 'line'; i += 1; continue; }
      if (ch === '/' && source[i + 1] === '*') { mode = 'block'; i += 1; continue; }
      if (ch === "'") { mode = 'single'; continue; }
      if (ch === '"') { mode = 'double'; continue; }
      if (ch === '`') { mode = 'template'; continue; }
      if (ch === '{') { depth += 1; continue; }
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(start, i + 1);
      }
      continue;
    }
    if (mode === 'line') { if (ch === '\n') mode = 'code'; continue; }
    if (mode === 'block') { if (ch === '*' && source[i + 1] === '/') { mode = 'code'; i += 1; } continue; }
    if (mode === 'single') { if (ch === '\\') { i += 1; continue; } if (ch === "'") mode = 'code'; continue; }
    if (mode === 'double') { if (ch === '\\') { i += 1; continue; } if (ch === '"') mode = 'code'; continue; }
    if (ch === '\\') { i += 1; continue; }
    if (ch === '`') mode = 'code';
  }
  throw new Error(`function ${name} 的大括号没有配对`);
}

// ---------- ① 静态契约 ----------

const HOST_KEYS = [
  'state', 'api', 'call', 'toast', 'editorEl', '$',
  'chaptersLib', 'templateLib', 'CHAPTER_STATUS_LABELS',
  'promptText', 'askUnsaved',
  'chapterTitle', 'chapterStatus', 'chapterNote', 'formatCount',
  'chapterVolumeId', 'volumeList', 'volumeById', 'volumeDisplayName',
  'chapterMenuIsBatch', 'selectedChapterIndexes', 'clearChapterSelection',
  'currentChapterId', 'currentChapterLabel',
  'renderChapterList', 'renderEditorHeader', 'syncChapterFilterUi', 'syncVolumeHeaderName',
  'syncChapterItemInfo', 'syncChapterBatchBar', 'markCommandsDirty',
  'updateStatus', 'setChapterMask', 'loadChapterAt', 'saveCurrent', 'refreshShelf', 'flushWriteTimer',
  'undoUi', 'moveChapterByDrop', 'openExportDialog',
  'replaceEditorTextNative', 'onEditorInput', 'recordFallbackWrite', 'scrollCaretIntoView',
  'placeMenuAt'
];

const ENTRIES = [
  'chapterTemplateText', 'applyChapterTemplate', 'applyMetaAndRelocate', 'createChapterAt',
  'createVolumeFlow', 'renameVolumeFlow', 'moveVolumeFlow', 'deleteVolumeFlow', 'openVolumeChooserInMenu',
  'moveChapterToVolume', 'renameChapterAt', 'deleteChapterAt', 'activateDeleteUndo', 'updateChapterInfo',
  'setChapterStatusAt', 'deleteSelectedChapters', 'activateBatchDeleteUndo', 'moveSelectedChaptersToVolume',
  'setSelectedChaptersStatus', 'exportSelectedChapters', 'copySelectedChapters', 'editChapterNoteAt'
];

const WRAPPERS = [
  ['createChapterAt', 'async', 'insertIndex, nameOverride, volumeIdOverride'],
  ['createVolumeFlow', 'async', 'nameOverride'],
  ['renameVolumeFlow', 'async', 'volumeId, nameOverride'],
  ['moveVolumeFlow', 'async', 'volumeId, delta'],
  ['deleteVolumeFlow', 'async', 'volumeId, skipConfirm = false'],
  ['openVolumeChooserInMenu', 'plain', 'index'],
  ['moveChapterToVolume', 'async', 'index, volumeId'],
  ['renameChapterAt', 'async', 'index, nameOverride'],
  ['deleteChapterAt', 'async', 'index, skipConfirm = false'],
  ['setChapterStatusAt', 'async', 'index, status'],
  ['deleteSelectedChapters', 'async', ''],
  ['moveSelectedChaptersToVolume', 'async', 'volumeId'],
  ['setSelectedChaptersStatus', 'async', 'status'],
  ['exportSelectedChapters', 'plain', ''],
  ['copySelectedChapters', 'async', ''],
  ['editChapterNoteAt', 'async', 'index']
];

test('A3-Cβ / C1：新模块交出 create + REQUIRED_HOST，UMD 双分支与共享 assertHost 与既有模块同口径', () => {
  assert.ok(MODULE_SRC, `${MODULE_REL} 不存在：编辑域剩余部分还没搬出编排器`);
  assert.match(
    MODULE_SRC,
    /root\.CWChapterOpsUi = factory\(root\.CWAssertHost && root\.CWAssertHost\.assertHost\)/,
    '浏览器分支必须挂 CWChapterOpsUi'
  );
  assert.match(MODULE_SRC, /require\('\.\.\/core\/assert-host'\)/, 'Node 分支必须 require ../core/assert-host');
  assert.match(MODULE_SRC, /function createChapterOpsUi\(host\)/, '模块必须交出 createChapterOpsUi(host)');
  assert.match(MODULE_SRC, /assertHost\('createChapterOpsUi', host, REQUIRED_HOST\);/, '必须走共享 host 校验');
  assert.ok(Array.isArray(moduleApi.REQUIRED_HOST), 'REQUIRED_HOST 必须是数组');
  assert.equal(moduleApi.REQUIRED_HOST.length, HOST_KEYS.length, 'REQUIRED_HOST 成员数按契约');
  for (const key of HOST_KEYS) {
    assert.ok(moduleApi.REQUIRED_HOST.includes(key), `REQUIRED_HOST 缺 ${key}`);
  }
  // 缺成员在装配时炸：不是到点新建章节才 ReferenceError。
  const rt = makeHost();
  delete rt.host.toast;
  assert.throws(() => moduleApi.create(rt.host), /createChapterOpsUi 的 host 缺少 toast/);

  // 22 个入口一个不少（模板 4 / 分卷 11 / 批量 7）。
  const ui = moduleApi.create(makeHost().host);
  assert.equal(ui.chapterTemplateText && typeof ui.chapterTemplateText, 'function');
  for (const name of ENTRIES) {
    assert.equal(typeof ui[name], 'function', `create() 少了入口 ${name}`);
  }
});

test('A3-Cβ / C2：编排器只剩同名包装与一次装配，编辑域实现一个都搜不到', () => {
  assert.match(RENDERER_SRC, /const chapterOpsUiModule = window\.CWChapterOpsUi;/, '编排器要按清单本地名取模块');
  assert.match(RENDERER_SRC, /const chapterOpsUi = chapterOpsUiModule\.create\(\{/, '编排器要装配一次 create(host)');

  // TDZ 顺序：create 必须晚于它依赖的 const（chapterDirectoryUi / dragSortUi / undoUi / exportUi /
  // shelfNavUi）与早于 bindEvents；包装是函数声明，调用点零改动。
  const createAt = RENDERER_SRC.indexOf('const chapterOpsUi = chapterOpsUiModule.create({');
  assert.ok(createAt > 0, '找不到 chapterOpsUi 的装配');
  assert.ok(createAt > RENDERER_SRC.indexOf('const chapterDirectoryUi = chapterDirectoryUiModule.create({'), 'create 要晚于 chapterDirectoryUi');
  assert.ok(createAt > RENDERER_SRC.indexOf('const dragSortUi = dragSortUiModule.create({'), 'create 要晚于 dragSortUi');
  assert.ok(createAt > RENDERER_SRC.indexOf('const undoUi = undoUiModule.create({'), 'create 要晚于 undoUi');
  assert.ok(createAt > RENDERER_SRC.indexOf('const exportUi = exportUiModule.create({'), 'create 要晚于 exportUi（openExportDialog）');
  assert.ok(createAt < RENDERER_SRC.indexOf('  function bindEvents() {'), 'create 要早于 bindEvents（装配区内）');

  // host 字面量必须把 REQUIRED_HOST 的每个成员都接上（漏一个 = 运行时 undefined）。
  const hostBlock = RENDERER_SRC.slice(createAt, RENDERER_SRC.indexOf('});', createAt));
  for (const key of HOST_KEYS) {
    assert.ok(hostBlock.includes(key), `装配 host 字面量缺 ${key}`);
  }

  // 同名包装：16 个仍被编排器调用的入口一个不少，且只有一行转发。
  for (const [name, kind, params] of WRAPPERS) {
    const prefix = kind === 'async' ? 'async function' : 'function';
    const body = extractFunction(RENDERER_SRC, name);
    assert.ok(body.startsWith(`  ${prefix} ${name}(${params})`), `${name} 包装签名不对：${body.split('\n')[0]}`);
    const lines = body.split(/\r?\n/).filter((line) => line.trim());
    assert.ok(lines.length <= 2, `${name} 包装超过 2 行：实现要留在模块里`);
    assert.ok(body.includes(`return chapterOpsUi.${name}(`), `${name} 包装要转发到模块`);
  }

  // 六个只剩模块内部调用的函数不许在编排器里留第二份声明（声明了没人读 = 静默双份）。
  for (const name of ['chapterTemplateText', 'applyChapterTemplate', 'applyMetaAndRelocate', 'activateDeleteUndo', 'activateBatchDeleteUndo', 'updateChapterInfo']) {
    assert.equal(new RegExp(`\\n  (async )?function ${name}\\(`).test(RENDERER_SRC), false, `编排器里还有 ${name} 的实现声明`);
  }

  // 实现标记不许回流：这些字符串只该出现在新模块里。
  for (const marker of [
    'const cfg = state.globalConfig || state.config || {};',
    'templateLib.applyTemplate(template, {',
    'call(api.createChapter, state.bookPath, insertIndex, name, volumeId || null)',
    'call(api.deleteVolume, state.bookPath, volumeId)',
    'data.trashPath || \'\'',
    'restoreDeletedChapter',
    'deleted.push({',
    'call(api.moveChapterToVolume, bookPath, move.chapter.id, volumeId || null)',
    'openExportDialog(\'txt\', { from:'
  ]) {
    assert.equal(RENDERER_SRC.includes(marker), false, `编排器里还有编辑域实现：${marker}`);
  }
});

test('A3-Cβ / C3：机械保真——搬走的实现保留原有行为注释与撤销 / 未保存拦截红线（不是重写）', () => {
  for (const line of [
    '模板只存在全局配置 chapterTemplate（旧配置没有 = 不套用）',
    '作者要求（2026-10-31）：新建 / 插入章节前，当前章有未保存修改就自动保存，不再弹窗',
    '1.4.0 P0-2（撤销优先）：删除改为「直接执行 + 10 秒撤销」',
    '1.5.0 P0-4（审计 H-2）：记下删除那一刻的左右邻居 id',
    '1.5.0 P0-5（审计 V-1）：主进程给这次删除发了一张一次性凭证，撤销时必须原样交回',
    '从后往前删：前面还没删的章下标不会被后来的删除挤动',
    '批量删除的撤销：按删除的**逆序**（从前往后）',
    '导出选中章：只支持**连续范围**'
  ]) {
    assert.ok(MODULE_SRC.includes(line), `模块丢了行为注释：${line}`);
  }
  // 22 个函数整段逐字搬入 create()（2 空格函数声明、原有形参默认值）。
  for (const name of ENTRIES) {
    assert.match(MODULE_SRC, new RegExp(`\\n  (async )?function ${name}\\(`), `${name} 没有逐字搬入 create()`);
  }
  assert.match(MODULE_SRC, /\n  async function deleteChapterAt\(index, skipConfirm = false\) \{/, 'deleteChapterAt 形参默认值保留');
  assert.match(MODULE_SRC, /\n  async function deleteVolumeFlow\(volumeId, skipConfirm = false\) \{/, 'deleteVolumeFlow 形参默认值保留');
  // 红线语义原样：一次性撤销凭证 / 原下标插回；V221-RENDER-03 起删空不再自动补章，
  // 渲染层不再有 autoChapterFile / newChapter 死分支（storage 侧仍保留旧客户端的兼容参数）。
  assert.match(MODULE_SRC, /undoToken: typeof data\.undoToken === 'string' \? data\.undoToken : ''/);
  assert.match(MODULE_SRC, /undoToken: info\.undoToken \|\| ''/);
  assert.equal(/autoChapterFile/.test(MODULE_SRC), false, '删除撤销的死分支要清理（不再发送 autoChapterFile）');
  assert.equal(/newChapter: data\.newChapter/.test(MODULE_SRC), false, 'deleteChapter 固定回 newChapter=null，不许再存死字段');
  assert.match(MODULE_SRC, /neighborBeforeId/, '删除撤销要保留左右邻居 id 重算落点');
});

// ---------- 假 host ----------

function makeHost(overrides = {}) {
  const counts = {
    toast: [], renderList: 0, renderHeader: 0, status: 0, commandsDirty: 0,
    save: [], load: [], refreshShelf: 0, flush: 0, undo: [], drop: [], exportDialog: [],
    input: 0, fallback: [], scroll: [], placeMenuAt: 0, syncFilter: 0, syncItem: [],
    createChapter: [], prompt: [], askUnsaved: [], emptied: 0
  };
  const state = {
    bookPath: 'C:/书架/书 名 带 空格',
    index: 1,
    chapters: [
      { id: 'c1', name: '第一章', file: '001.md', volumeId: 'v1' },
      { id: 'c2', name: '第二章', file: '002.md', volumeId: 'v1' },
      { id: 'c3', name: '第三章', file: '003.md', volumeId: null }
    ],
    meta: {
      title: '测试书',
      volumes: [{ id: 'v1', name: '第一卷' }, { id: 'v2', name: '第二卷' }]
    },
    dirty: false,
    selectedIds: new Set(),
    selectAnchorId: null,
    chapterFilter: '',
    globalConfig: { chapterTemplate: '' },
    config: {}
  };
  state.meta.chapters = state.chapters;
  Object.assign(state, overrides.state || {});

  const editorEl = {
    value: '',
    focusCount: 0,
    selection: null,
    focus() { this.focusCount += 1; },
    setSelectionRange(from, to) { this.selection = [from, to]; }
  };
  Object.assign(editorEl, overrides.editorEl || {});

  function makeEl(id) {
    return {
      id,
      _text: '',
      get textContent() { return this._text; },
      set textContent(value) {
        this._text = value;
        if (value === '') this.children = [];
      },
      style: {},
      children: [],
      classes: [],
      classList: {
        list: [],
        add(name) { this.list.push(name); },
        remove(name) { this.list = this.list.filter((item) => item !== name); }
      },
      appendChild(child) { this.children.push(child); }
    };
  }
  const els = {
    'context-menu-volumes': makeEl('context-menu-volumes'),
    'context-menu': makeEl('context-menu')
  };

  const volumes = () => state.meta.volumes || [];
  const selectedChapterIndexes = () => [...state.selectedIds].sort((a, b) => a - b);
  const chapterVolumeId = (chapter) => (chapter && chapter.volumeId) || null;
  const volumeDisplayName = (id) => {
    if (!id) return '未分卷';
    const volume = volumes().find((item) => item.id === id);
    return volume ? volume.name : '未分卷';
  };

  const api = {
    createChapter: async () => ({ ok: true, data: { index: 0, chapter: { name: '新章' }, meta: state.meta } }),
    createVolume: async (bookPath, name) => ({ ok: true, data: { volume: { id: 'v9', name }, meta: state.meta } }),
    renameVolume: async () => ({ ok: true, data: { meta: state.meta } }),
    moveVolume: async () => ({ ok: true, data: { meta: state.meta } }),
    deleteVolume: async () => ({ ok: true, data: { meta: state.meta } }),
    moveChapterToVolume: async () => ({ ok: true, data: { index: 0, meta: state.meta } }),
    renameChapter: async () => ({ ok: true, data: { meta: state.meta } }),
    deleteChapter: async () => ({ ok: true, data: { index: 0, meta: state.meta, trashPath: 'C:\\书\\_trash\\001.md', undoToken: 'tok' } }),
    restoreDeletedChapter: async () => ({ ok: true, data: { index: 0, chapter: { name: '第一章' }, meta: state.meta } }),
    updateChapterMeta: async () => ({ ok: true, data: { changed: true, chapter: { status: 'done' }, meta: state.meta } }),
    openBook: async () => ({ ok: true, data: { meta: state.meta } }),
    copyBook: async () => ({ ok: true, data: { chapterCount: 2, chars: 1234, includedUnsaved: false } })
  };
  Object.assign(api, overrides.api || {});

  async function call(fn, ...args) {
    const res = await fn(...args);
    if (!res || res.ok === false) {
      const err = new Error((res && res.message) || '未知错误');
      err.code = res && res.code;
      throw err;
    }
    return res.data;
  }

  let promptQueue = (overrides.promptQueue || []).slice();
  let askQueue = (overrides.askQueue || []).slice();
  let syncItemImpl = overrides.syncChapterItemInfo || ((index) => { counts.syncItem.push(index); return true; });
  let syncVolumeImpl = overrides.syncVolumeHeaderName || (() => { return true; });

  const host = {
    state,
    api,
    call,
    toast: (message, kind) => counts.toast.push([message, kind]),
    editorEl,
    $: (id) => els[id] || null,
    chaptersLib: { chapterNumber: (meta, index) => index + 1 },
    templateLib: {
      sanitizeTemplate: (value) => (typeof value === 'string' ? value : ''),
      hasTemplate: (value) => Boolean(value && value.trim()),
      isBlankText: (value) => !value || !String(value).trim(),
      applyTemplate: (template, vars) => template
        .replace(/\{章号\}/g, String(vars.chapterNumber))
        .replace(/\{章名\}/g, vars.chapterName || '')
        .replace(/\{日期\}/g, '2026-11-18')
    },
    CHAPTER_STATUS_LABELS: { draft: '草稿', done: '已完成', revising: '修订中' },
    promptText: async (opts) => {
      counts.prompt.push(opts);
      if (promptQueue.length) return promptQueue.shift();
      return overrides.promptDefault !== undefined ? overrides.promptDefault : '新名字';
    },
    askUnsaved: async (opts) => {
      counts.askUnsaved.push(opts);
      if (askQueue.length) return askQueue.shift();
      return overrides.askUnsavedAction || 'cancel';
    },
    chapterTitle: (index, name) => `第${index + 1}章 ${name || '未命名'}`,
    chapterStatus: (chapter) => (chapter && chapter.status) || 'draft',
    chapterNote: (chapter) => (chapter && chapter.note) || '',
    formatCount: (value) => String(value),
    chapterVolumeId,
    volumeList: volumes,
    volumeById: (id) => volumes().find((item) => item.id === id) || null,
    volumeDisplayName,
    chapterMenuIsBatch: () => false,
    selectedChapterIndexes,
    clearChapterSelection: () => { state.selectedIds = new Set(); state.selectAnchorId = null; },
    currentChapterId: () => (state.chapters[state.index] || {}).id,
    currentChapterLabel: () => '当前章',
    renderChapterList: () => { counts.renderList += 1; },
    renderEditorHeader: () => { counts.renderHeader += 1; },
    syncChapterFilterUi: () => { counts.syncFilter += 1; },
    syncVolumeHeaderName: (id) => syncVolumeImpl(id),
    syncChapterItemInfo: (index) => syncItemImpl(index),
    syncChapterBatchBar: () => { counts.status += 1; },
    markCommandsDirty: () => { counts.commandsDirty += 1; },
    updateStatus: () => { counts.status += 1; },
    // 2026-11-25：删到 0 章时切空态（编辑区只读 + 提示）；假 host 记一笔即可。
    setChapterMask: (masked, placeholder) => {
      counts.mask = (counts.mask || 0) + 1;
      counts.lastMask = [masked, placeholder];
    },
    // H1（三审）：假 loadChapterAt 与真实现同口径 —— 成功才回 { ok:true } 并清脏（失败时返回
    // { ok:false } 且不动 dirty）；「载章失败后保持脏」的用例在同文件 T1 里显式覆盖。
    loadChapterAt: async (index) => {
      counts.load.push(index);
      if (overrides.loadResult) return overrides.loadResult;
      state.index = index;
      state.dirty = false;
      state.baseText = editorEl.value;
      return { ok: true };
    },
    saveCurrent: async (opts) => {
      counts.save.push(opts);
      if (overrides.saveResult) return overrides.saveResult;
      // 与真 saveCurrent 同口径：成功回执落地后基线换成快照、dirty 按快照重算（没人在保存期间
      // 敲字就是干净）。要模拟「保存期间又敲了字」，用例在 saveCurrent 里自己把 dirty 置回 true。
      if (overrides.saveMutatesDuringSave) {
        state.baseText = editorEl.value;
        state.dirty = true;
        return { ok: true };
      }
      state.baseText = editorEl.value;
      state.dirty = false;
      return { ok: true };
    },
    refreshShelf: async () => { counts.refreshShelf += 1; },
    flushWriteTimer: async () => { counts.flush += 1; },
    undoUi: { activate: (title, run) => { counts.undo.push({ title, run }); } },
    moveChapterByDrop: async (chapter, target) => { counts.drop.push([chapter, target]); return { ok: true }; },
    openExportDialog: (format, range) => { counts.exportDialog.push([format, range]); },
    replaceEditorTextNative: (text) => {
      if (overrides.replaceResult === false) return false;
      editorEl.value = text;
      return true;
    },
    onEditorInput: () => { counts.input += 1; },
    recordFallbackWrite: (info) => { counts.fallback.push(info); },
    scrollCaretIntoView: (pos) => { counts.scroll.push(pos); },
    placeMenuAt: () => { counts.placeMenuAt += 1; },
    // V221-RENDER-02：删空后由渲染层注入的统一清理（朗读 / 高亮 / 快照 / 标记层）
    onBookEmptied: () => { counts.emptied += 1; }
  };
  Object.assign(host, overrides.host || {});

  const ui = moduleApi ? moduleApi.create(host) : null;
  return {
    ui, host, state, counts, els, editorEl,
    setPromptQueue: (queue) => { promptQueue = queue.slice(); },
    setAskQueue: (queue) => { askQueue = queue.slice(); },
    setSyncItem: (impl) => { syncItemImpl = impl; },
    setSyncVolume: (impl) => { syncVolumeImpl = impl; }
  };
}

function makeDocumentStub() {
  const created = [];
  const stub = {
    createElement(tag) {
      const el = {
        tag, textContent: '', dataset: {}, type: '',
        className: '', style: {}, children: [],
        appendChild(child) { this.children.push(child); }
      };
      created.push(el);
      return el;
    }
  };
  return { stub, created };
}

// ---------- ② 行为 ----------

test('A3-Cβ / B1：章节模板——没模板 / 编辑区非空 / 结果为空都不套，成功走 onEditorInput，execCommand 失败才记兜底快照', () => {
  const rt = makeHost();
  rt.state.chapters[0].name = '第一章';
  // 没模板：不碰编辑区。
  rt.editorEl.value = '';
  assert.deepEqual(rt.ui.applyChapterTemplate(0, '第一章'), { applied: false, reason: 'NO_TEMPLATE' });
  assert.equal(rt.counts.input, 0);
  // 有模板但编辑区非空：绝不覆盖作者写的字。
  rt.state.globalConfig.chapterTemplate = '第{章号}章 {章名}';
  rt.editorEl.value = '正文';
  assert.deepEqual(rt.ui.applyChapterTemplate(0, '第一章'), { applied: false, reason: 'NOT_EMPTY' });
  // 模板展开后全空白：也不套。
  rt.state.globalConfig.chapterTemplate = '{章名}';
  rt.editorEl.value = '';
  assert.deepEqual(rt.ui.applyChapterTemplate(0, '   '), { applied: false, reason: 'EMPTY_RESULT' });
  // 成功：execCommand 可用 → 不记兜底；焦点 / 选区 / onEditorInput / 光标回末尾各一次。
  rt.state.globalConfig.chapterTemplate = '第{章号}章 {章名}';
  rt.editorEl.value = '';
  const applied = rt.ui.applyChapterTemplate(0, '第一章');
  assert.equal(applied.applied, true);
  assert.equal(applied.text, '第1章 第一章');
  assert.equal(rt.editorEl.value, '第1章 第一章');
  assert.equal(rt.counts.input, 1, '统一走 onEditorInput（标记未保存 / 字数 / 状态栏）');
  assert.equal(rt.counts.fallback.length, 0);
  assert.equal(rt.editorEl.focusCount, 1);
  assert.equal(rt.editorEl.selection[0], rt.editorEl.value.length, '光标回到末尾');
  // 极端兜底：execCommand 被拒 → 手动替换保住内容，并记一次性快照（V402）。
  const rt2 = makeHost({ replaceResult: false });
  rt2.state.globalConfig.chapterTemplate = '模板';
  rt2.editorEl.value = '';
  const fallback = rt2.ui.applyChapterTemplate(0, '');
  assert.equal(fallback.applied, true);
  assert.equal(rt2.editorEl.value, '模板');
  assert.equal(rt2.counts.fallback.length, 1);
  assert.equal(rt2.counts.fallback[0].label, '套用章节模板');
  assert.equal(rt2.counts.input, 1, '兜底也在输入处理之后');
  // globalConfig 缺失时回落到 config（旧配置形态）。
  const rt3 = makeHost();
  rt3.state.globalConfig = null;
  rt3.state.config = { chapterTemplate: '配置模板{章名}' };
  assert.equal(rt3.ui.chapterTemplateText(), '配置模板{章名}');
});

test('A3-Cβ / B2：createChapterAt——脏章先保存、模板只填编辑区、取消 / 保存失败都不建章，含空格书目路径原样', async () => {
  const rt = makeHost();
  rt.state.index = 1;
  rt.state.chapters[1].volumeId = 'v1';
  rt.state.chapterFilter = '目录';
  rt.state.dirty = true;
  const created = [];
  rt.host.api.createChapter = async (bookPath, insertIndex, name, volumeId) => {
    created.push([bookPath, insertIndex, name, volumeId]);
    const chapters = rt.state.chapters.concat([{ id: 'c9', name, file: '009.md', volumeId }]);
    return { ok: true, data: { index: 2, chapter: { name }, meta: { chapters, volumes: rt.state.meta.volumes } } };
  };
  rt.state.globalConfig.chapterTemplate = '第{章号}章 {章名}';
  const result = await rt.ui.createChapterAt(3, '新章');
  assert.equal(result.ok, true);
  assert.equal(result.index, 2);
  assert.equal(result.template.applied, true);
  assert.deepEqual(rt.counts.save, [undefined], '脏章先自动保存（不再弹窗）');
  assert.deepEqual(created, [['C:/书架/书 名 带 空格', 3, '新章', 'v1']], '含空格书目路径 / 当前章所在卷原样传给 IPC');
  assert.equal(rt.state.chapterFilter, '', '新建后清筛选，保证新章在目录里看得见');
  assert.equal(rt.counts.syncFilter, 1);
  assert.equal(rt.counts.commandsDirty, 1, '书目换了要重建命令面板');
  assert.deepEqual(rt.counts.load, [2], '建完切到新章');
  assert.equal(rt.state.chapters.length, 4);
  assert.match(rt.counts.toast[rt.counts.toast.length - 1][0], /^已新建：第3章 新章（第一卷） · 已套用章节模板/);

  // 保存失败：停在这里，不建新章（错误提示由 saveCurrent 负责）。
  const rtFail = makeHost({ saveResult: { ok: false, message: '磁盘满' } });
  rtFail.state.dirty = true;
  const before = rtFail.counts.toast.length;
  const failed = await rtFail.ui.createChapterAt(3, '新章');
  assert.deepEqual(failed, { ok: false, message: '磁盘满' });
  assert.equal(rtFail.counts.toast.length, before, '保存失败不重复弹提示');
  assert.equal(rtFail.state.chapters.length, 3);

  // 取消问名字：不写盘。
  const rtCancel = makeHost({ promptQueue: [null] });
  const canceled = await rtCancel.ui.createChapterAt(3, undefined);
  assert.equal(canceled.ok, false);
  assert.equal(canceled.canceled, true);

  // IPC 失败（ENOSPC）：只一条 error toast，不抛。
  const rtErr = makeHost();
  rtErr.host.api.createChapter = async () => ({ ok: false, code: 'ENOSPC', message: '磁盘满了' });
  const err = await rtErr.ui.createChapterAt(3, '新章');
  assert.equal(err.ok, false);
  assert.match(rtErr.counts.toast[0][0], /^新建章节失败：磁盘满了/);
  assert.equal(rtErr.counts.toast[0][1], 'error');
  // 没有打开的书写盘早退。
  const rtNoBook = makeHost();
  rtNoBook.state.bookPath = null;
  assert.deepEqual(await rtNoBook.ui.createChapterAt(0, '新章'), { ok: false });
});

test('A3-Cβ / B3：分卷四流程——新建 / 重命名（卷头快路径与整表回退）/ 上下移动 / 删除卷撤销原序放回', async () => {
  // 新建卷：不改变章节顺序，当前章按 id 找回，重画 + 状态栏 + 一条成功提示。
  const rt = makeHost();
  const calls = [];
  rt.host.api.createVolume = async (bookPath, name) => {
    calls.push([bookPath, name]);
    const meta = { chapters: rt.state.chapters, volumes: rt.state.meta.volumes.concat([{ id: 'v9', name }]) };
    return { ok: true, data: { volume: { id: 'v9', name }, meta } };
  };
  rt.state.chapters[1].id = 'c2';
  const created = await rt.ui.createVolumeFlow('第三卷');
  assert.equal(created.ok, true);
  assert.deepEqual(calls, [['C:/书架/书 名 带 空格', '第三卷']]);
  assert.equal(rt.state.meta.volumes.length, 3);
  assert.equal(rt.state.index, 1, '按 id 找回当前章，下标不漂');
  assert.equal(rt.counts.renderList, 1);
  assert.equal(rt.counts.status, 1);
  assert.equal(rt.counts.toast.at(-1)[0], '已新建卷：第三卷');
  // 取消 / IPC 失败（EPERM：只读目录）。
  const rtCancel = makeHost({ promptQueue: [null] });
  assert.deepEqual(await rtCancel.ui.createVolumeFlow(undefined), { ok: false, canceled: true });
  const rtErr = makeHost();
  rtErr.host.api.createVolume = async () => ({ ok: false, code: 'EPERM', message: '没有权限' });
  const err = await rtErr.ui.createVolumeFlow('卷');
  assert.equal(err.ok, false);
  assert.match(rtErr.counts.toast[0][0], /^新建卷失败：没有权限/);

  // 重命名卷：卷头找到 → 不整表重建；找不到 / 筛选生效 → 回退整表重建。
  const rtRename = makeHost();
  rtRename.host.api.renameVolume = async () => ({ ok: true, data: { meta: rtRename.state.meta } });
  const renamed = await rtRename.ui.renameVolumeFlow('v1', '卷一');
  assert.equal(renamed.ok, true);
  assert.equal(rtRename.counts.renderList, 0, '卷头快路径成功时不整表重建');
  assert.equal(rtRename.counts.toast.at(-1)[0], '已重命名卷');
  rtRename.setSyncVolume(() => false);
  await rtRename.ui.renameVolumeFlow('v1', '卷一');
  assert.equal(rtRename.counts.renderList, 1, '卷头对不上 → 整表重建');

  // 上下移动卷：越界 / 坏卷 id 不写盘；正常只改卷序，章节顺序不动。
  const rtMove = makeHost();
  const moved = [];
  rtMove.host.api.moveVolume = async (bookPath, volumeId, to) => {
    moved.push([volumeId, to]);
    return { ok: true, data: { meta: rtMove.state.meta } };
  };
  assert.deepEqual(await rtMove.ui.moveVolumeFlow('v9', 1), { ok: false }, '不存在的卷不动');
  assert.deepEqual(await rtMove.ui.moveVolumeFlow('v2', 1), { ok: false }, '已经在末尾，下移越界');
  const okMove = await rtMove.ui.moveVolumeFlow('v1', 1);
  assert.equal(okMove.ok, true);
  assert.deepEqual(moved, [['v1', 1]]);
  assert.equal(rtMove.counts.renderList, 1);
  assert.equal(rtMove.counts.renderHeader, 1);
  assert.equal(rtMove.counts.toast.at(-1)[0], '已下移卷：第一卷');

  // 删除卷：2 章回到未分卷；撤销按原序重建卷 / 逐章放回 / 卷序放回 / 重开书 / 刷新书架。
  const rtDel = makeHost();
  const delCalls = [];
  const volumesAfter = rtDel.state.meta.volumes.filter((volume) => volume.id !== 'v1');
  const chaptersAfter = rtDel.state.chapters.map((chapter) => ({ ...chapter, volumeId: null }));
  rtDel.host.api.deleteVolume = async () => ({ ok: true, data: { meta: { chapters: chaptersAfter, volumes: volumesAfter } } });
  rtDel.host.api.createVolume = async (bookPath, name) => { delCalls.push(['create', name]); return { ok: true, data: { volume: { id: 'vNew', name } } }; };
  rtDel.host.api.moveChapterToVolume = async (bookPath, chapterId, volumeId) => { delCalls.push(['move', chapterId, volumeId]); return { ok: true, data: { index: 0 } }; };
  rtDel.host.api.moveVolume = async (bookPath, volumeId, to) => { delCalls.push(['order', volumeId, to]); return { ok: true, data: {} }; };
  rtDel.host.api.openBook = async (bookPath) => {
    delCalls.push(['open', bookPath]);
    return { ok: true, data: { meta: { chapters: rtDel.state.chapters, volumes: rtDel.state.meta.volumes } } };
  };
  const deleted = await rtDel.ui.deleteVolumeFlow('v1');
  assert.equal(deleted.ok, true);
  assert.equal(rtDel.state.chapters.length, 3);
  assert.equal(rtDel.state.index, 1);
  assert.equal(rtDel.counts.undo.length, 1);
  assert.equal(rtDel.counts.undo[0].title, '已删除卷「第一卷」，2 章回到未分卷');
  assert.equal(rtDel.counts.renderList, 1);
  await rtDel.counts.undo[0].run();
  assert.deepEqual(delCalls, [
    ['create', '第一卷'],
    ['move', 'c1', 'vNew'],
    ['move', 'c2', 'vNew'],
    ['order', 'vNew', 0],
    ['open', 'C:/书架/书 名 带 空格']
  ]);
  assert.equal(rtDel.counts.refreshShelf, 1, '撤销后刷新书架');
  // 换书后撤销要拒（绝不把卷塞进另一本书）。
  rtDel.state.bookPath = 'C:/另一本书';
  await assert.rejects(() => rtDel.counts.undo[0].run(), /已经换了书，不能撤销/);
});

test('A3-Cβ / B4：deleteChapterAt——非当前章不问未保存；当前脏章取消 / 保存失败都不删；_trash 凭证原样登记撤销', async () => {
  // 非当前章：即使全书 dirty 也不问（编辑区里没有这一章的字）。
  const rt = makeHost();
  rt.state.dirty = true;
  rt.state.index = 1;
  const deletedIds = [];
  rt.host.api.deleteChapter = async (bookPath, chapterId) => {
    deletedIds.push([bookPath, chapterId]);
    const chapters = rt.state.chapters.filter((chapter) => chapter.id !== chapterId);
    return { ok: true, data: { index: 0, chapters, meta: { chapters, volumes: rt.state.meta.volumes }, trashPath: 'C:\\书 架\\_trash\\001.md', undoToken: 'tok-001' } };
  };
  const ok = await rt.ui.deleteChapterAt(0);
  assert.equal(ok, true);
  assert.deepEqual(deletedIds, [['C:/书架/书 名 带 空格', 'c1']]);
  assert.equal(rt.counts.askUnsaved.length, 0, '非当前章不问未保存');
  assert.equal(rt.counts.undo.length, 1);
  assert.equal(rt.counts.undo[0].title, '已删除「第1章 第一章」');
  // 撤销信息：绝对路径只留 basename、一次性凭证原样交回、左右邻居 id 记下。
  const rtUndo = makeHost();
  let undoInfo = null;
  rtUndo.host.undoUi.activate = (title, run) => { rtUndo.counts.undo.push({ title, run }); };
  rtUndo.host.api.deleteChapter = async () => ({ ok: true, data: { index: 0, meta: { chapters: rtUndo.state.chapters, volumes: rtUndo.state.meta.volumes }, trashPath: 'C:\\书 架\\_trash\\001.md', undoToken: 'tok-001' } });
  rtUndo.host.state.index = 1;
  await rtUndo.ui.deleteChapterAt(0);
  // 从撤销动作里读不出 info，改用行为：恢复调用参数里必须有 basename / token / 邻居。
  rtUndo.host.api.restoreDeletedChapter = async (bookPath, payload) => {
    undoInfo = [bookPath, payload];
    return { ok: true, data: { index: 0, chapter: { name: '第一章' }, meta: { chapters: rtUndo.state.chapters, volumes: rtUndo.state.meta.volumes } } };
  };
  rtUndo.state.bookPath = 'C:/书架/书 名 带 空格';
  await rtUndo.counts.undo[0].run();
  assert.equal(undoInfo[0], 'C:/书架/书 名 带 空格');
  assert.equal(undoInfo[1].trashName, '001.md', '绝对路径只取 basename，不把本机路径递回去');
  assert.equal(undoInfo[1].undoToken, 'tok-001', '一次性撤销凭证原样交回');
  assert.equal(undoInfo[1].index, 0);
  assert.equal(undoInfo[1].chapter.id, 'c1');

  // 当前脏章 + 取消：不写盘、返回 false。
  const rtCancel = makeHost({ askQueue: ['cancel'] });
  rtCancel.state.index = 1;
  rtCancel.state.dirty = true;
  const canceled = await rtCancel.ui.deleteChapterAt(1);
  assert.equal(canceled, false);
  assert.equal(rtCancel.counts.toast.length, 0);
  // 选择保存但保存失败：也不许删（编辑区的字还没落盘）。
  const rtSaveFail = makeHost({ askQueue: ['save'], saveResult: { ok: false } });
  rtSaveFail.state.index = 1;
  rtSaveFail.state.dirty = true;
  assert.equal(await rtSaveFail.ui.deleteChapterAt(1), false);
  assert.equal(rtSaveFail.counts.load.length, 0);
  // 保存成功再删：切到主进程回传的下标，dirty 清掉。
  const rtSaveOk = makeHost({ askQueue: ['save'] });
  rtSaveOk.state.index = 1;
  rtSaveOk.state.dirty = true;
  rtSaveOk.host.api.deleteChapter = async () => {
    const chapters = rtSaveOk.state.chapters.filter((chapter) => chapter.id !== 'c2');
    return { ok: true, data: { index: 1, chapters, meta: { chapters, volumes: rtSaveOk.state.meta.volumes }, trashPath: '/书/_trash/002.md', undoToken: 'tok-2' } };
  };
  assert.equal(await rtSaveOk.ui.deleteChapterAt(1), true);
  assert.equal(rtSaveOk.state.dirty, false);
  assert.deepEqual(rtSaveOk.counts.load, [1]);

  // 删最后一章（2026-11-25 新语义）：不再自动补章 —— 书目变 0 章，编辑区切空态、提示可撤销。
  const rtLast = makeHost();
  rtLast.host.api.deleteChapter = async () => ({
    ok: true,
    data: {
      index: -1,
      chapters: [],
      meta: { chapters: [], volumes: rtLast.state.meta.volumes },
      trashPath: 'x/001.md',
      undoToken: 'tok-last'
    }
  });
  assert.equal(await rtLast.ui.deleteChapterAt(0), true);
  assert.equal(rtLast.state.chapters.length, 0);
  assert.equal(rtLast.state.index, -1);
  assert.equal(rtLast.state.dirty, false);
  assert.equal(rtLast.counts.emptied, 1, 'V221-RENDER-02：删空要跑一次旧章副作用清理');
  assert.ok(rtLast.counts.toast.some(([message]) => /已删除最后一章/.test(message)), '提示「这本书现在没有章节」');
  assert.equal(rtLast.counts.lastMask[0], true, '编辑区切只读空态');
  assert.equal(rtLast.counts.undo.length, 1, '仍登记撤销（10 秒内能放回）');
  // 极值 × IO 失败：ENOSPC 只一条 error toast，返回 false，不登记撤销。
  const rtErr = makeHost();
  rtErr.host.api.deleteChapter = async () => ({ ok: false, code: 'ENOSPC', message: '磁盘满了' });
  assert.equal(await rtErr.ui.deleteChapterAt(0), false);
  assert.match(rtErr.counts.toast[0][0], /^删除失败：磁盘满了/);
  assert.equal(rtErr.counts.undo.length, 0);
});

test('V221-RENDER-02：渲染层注入的删空清理清单与切章副作用同源（朗读 / 高亮 / 快照 / 标记层）', () => {
  const rendererSrc = require('node:fs').readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const at = rendererSrc.indexOf('onBookEmptied:');
  assert.ok(at > 0, 'renderer 装配 chapterOpsUi 时要注入 onBookEmptied');
  const block = rendererSrc.slice(at, at + 800);
  for (const marker of [
    'clearFindSession()',
    'stopTtsForChapterChange()',
    'bulkWriteUndo = null',
    'fallbackWriteUndo = null',
    'undoUi.clear()',
    'scheduleMarksRender(0)'
  ]) {
    assert.ok(block.includes(marker), `删空清理清单缺 ${marker}`);
  }
});

test('REDT-C-04：删非当前章后当前章从回包书目消失 → 重载编辑区并清脏（不许跨章覆盖）', async () => {
  const rt = makeHost();
  rt.state.index = 1; // 当前章 c2
  rt.state.dirty = true;
  rt.host.api.deleteChapter = async () => {
    // 异常前提：删的是 c1，但回包书目里当前章 c2 也不见了（书目被外部改坏）
    const chapters = rt.state.chapters.filter((chapter) => chapter.id === 'c1');
    return {
      ok: true,
      data: { index: 0, chapters, meta: { chapters, volumes: rt.state.meta.volumes }, trashPath: 'C:\\书\\_trash\\001.md', undoToken: 'tok-9' }
    };
  };
  assert.equal(await rt.ui.deleteChapterAt(0), true);
  assert.equal(rt.state.dirty, false, '编辑区要换成新章，标脏必须清掉（否则 Ctrl+S 把旧章正文写进新章）');
  assert.equal(rt.counts.load.length, 1, '必须重新载入编辑区，不能留着已消失章的文字');
  assert.equal(rt.counts.load[0], rt.state.index, '载入的是回落后与 state.index 一致的那一章');
});

test('A3-Cβ / B5：批量删除——从后往前删、部分失败仍登记已删章、一次撤销按原下标从前往后插回', async () => {
  const rt = makeHost();
  rt.state.selectedIds = new Set([0, 1, 2]);
  rt.state.index = 1;
  rt.state.dirty = false;
  const deleteOrder = [];
  rt.host.api.deleteChapter = async (bookPath, chapterId) => {
    deleteOrder.push(chapterId);
    rt.state.chapters = rt.state.chapters.filter((chapter) => chapter.id !== chapterId);
    rt.state.meta.chapters = rt.state.chapters;
    return { ok: true, data: { index: 0, chapters: rt.state.chapters, meta: { chapters: rt.state.chapters, volumes: rt.state.meta.volumes }, trashPath: `C:\\书\\_trash\\${chapterId}.md`, undoToken: `tok-${chapterId}` } };
  };
  const deleted = await rt.ui.deleteSelectedChapters();
  assert.equal(deleted, true);
  assert.deepEqual(deleteOrder, ['c3', 'c2', 'c1'], '从后往前删（前面还没删的下标不被挤动）');
  assert.equal(rt.state.selectedIds.size, 0, '一次性动作上下文执行完收起');
  assert.equal(rt.state.selectAnchorId, null);
  assert.equal(rt.state.dirty, false);
  assert.deepEqual(rt.counts.load, [], 'RNDC-01：删空后不再拿 0 号章硬载，改走与单章删除同一份空态收尾');
  assert.equal(rt.counts.undo.length, 1);
  assert.equal(rt.counts.undo[0].title, '已删除 3 章');
  assert.match(rt.counts.toast.at(-1)[0], /^已把 3 章移到本书 _trash，10 秒内可撤销/);
  // 撤销：按删除的逆序（从前往后）逐章按原始下标插回。
  const restoreOrder = [];
  rt.host.api.restoreDeletedChapter = async (bookPath, payload) => {
    restoreOrder.push([payload.index, payload.trashName, payload.undoToken, payload.chapter.id]);
    return { ok: true, data: { index: payload.index, chapters: rt.state.chapters, chapter: payload.chapter, meta: { chapters: rt.state.chapters, volumes: rt.state.meta.volumes } } };
  };
  rt.state.bookPath = 'C:/书架/书 名 带 空格';
  await rt.counts.undo[0].run();
  assert.deepEqual(restoreOrder.map((item) => item[0]), [0, 1, 2], '从前往后按原始下标插回');
  assert.deepEqual(restoreOrder.map((item) => item[1]), ['c1.md', 'c2.md', 'c3.md']);
  assert.deepEqual(restoreOrder.map((item) => item[2]), ['tok-c1', 'tok-c2', 'tok-c3'], '每章一次性凭证原样交回');
  assert.equal(rt.counts.flush, 1, '撤销先 flush 秒表');

  // 部分失败：已删的仍可撤销，提示里说清几章没删成。
  const rtPart = makeHost({ state: { selectedIds: new Set([0, 1, 2]) } });
  let call = 0;
  rtPart.host.api.deleteChapter = async (bookPath, chapterId) => {
    call += 1;
    if (call === 2) return { ok: false, code: 'EPERM', message: '没有权限' };
    return { ok: true, data: { index: 0, meta: { chapters: rtPart.state.chapters, volumes: rtPart.state.meta.volumes }, trashPath: `x/${chapterId}.md`, undoToken: `tok-${chapterId}` } };
  };
  const partial = await rtPart.ui.deleteSelectedChapters();
  assert.equal(partial, true);
  assert.equal(rtPart.counts.undo.length, 1);
  assert.equal(rtPart.counts.undo[0].title, '已删除 1 章');
  const warn = rtPart.counts.toast.find(([, kind]) => kind === 'warn');
  assert.match(warn[0], /有 2 章没删成：没有权限/);

  // 单章选择：复用单章删除（撤销文案 / 未保存拦截不另写一份）。
  const rtOne = makeHost({ state: { selectedIds: new Set([2]) } });
  const oneCalls = [];
  rtOne.host.api.deleteChapter = async (bookPath, chapterId) => {
    oneCalls.push(chapterId);
    return { ok: true, data: { index: 2, meta: { chapters: rtOne.state.chapters, volumes: rtOne.state.meta.volumes }, trashPath: 'x/003.md', undoToken: 'tok' } };
  };
  assert.equal(await rtOne.ui.deleteSelectedChapters(), true);
  assert.deepEqual(oneCalls, ['c3']);
  assert.equal(rtOne.state.selectedIds.size, 0);

  // 极值：500 章全选一次删完，只登记一条撤销。
  const rtHuge = makeHost();
  rtHuge.state.chapters = Array.from({ length: 500 }, (_, i) => ({ id: `h${i}`, name: `章${i}`, file: `${i}.md`, volumeId: null }));
  rtHuge.state.meta.chapters = rtHuge.state.chapters;
  rtHuge.state.selectedIds = new Set(Array.from({ length: 500 }, (_, i) => i));
  rtHuge.state.index = 0;
  rtHuge.host.api.deleteChapter = async (bookPath, chapterId) => {
    return { ok: true, data: { index: 0, meta: { chapters: rtHuge.state.chapters, volumes: rtHuge.state.meta.volumes }, trashPath: `x/${chapterId}.md`, undoToken: `tok-${chapterId}` } };
  };
  assert.equal(await rtHuge.ui.deleteSelectedChapters(), true);
  assert.equal(rtHuge.counts.undo[0].title, '已删除 500 章');
});

// A2-CHAPTER-01（中）：批量删除 / 移卷 / 改状态是逐条 await 的秒级窗口，期间 Ctrl+K 换书很常见。
// 旧实现每条回执都 applyMetaAndRelocate（拿旧书 meta 覆盖新书 state），循环后的收尾还读活 state.chapters，
// 于是新书界面被旧书目录接管，收尾再拿新书路径读旧书下标（同名 txt 时正文与 id 错配）。
// 锚点：任一回执落地前核「发起时那本书」，换了书立刻停手，当前界面一个字都不许动。
test('A2-CHAPTER-01：批量删除 / 移卷 / 改状态执行中换书 → 立刻停手，不用旧书回执覆盖新书界面', async () => {
  const NEW_BOOK = 'C:/书架/另一本书';
  const newChapters = [{ id: 'n1', name: '新书第一章', file: 'n1.md', volumeId: null }];
  const switchBook = (rt, oldChapters, oldVolumes) => {
    const oldMeta = { chapters: oldChapters, volumes: oldVolumes };
    rt.state.bookPath = NEW_BOOK;
    rt.state.chapters = newChapters;
    rt.state.meta = { title: '另一本书', chapters: newChapters, volumes: [] };
    rt.state.selectedIds = new Set([0]);
    return oldMeta;
  };

  // ① 批量删除：第一条回执返回前换书
  const del = makeHost({ state: { selectedIds: new Set([0, 1, 2]) } });
  const delCalls = [];
  const delChapters = del.state.chapters;
  const delVolumes = del.state.meta.volumes;
  del.host.api.deleteChapter = async (bookPath, chapterId) => {
    delCalls.push(chapterId);
    const oldMeta = switchBook(del, delChapters, delVolumes);
    return { ok: true, data: { index: 0, meta: oldMeta, trashPath: `x/${chapterId}.md`, undoToken: `tok-${chapterId}` } };
  };
  assert.equal(await del.ui.deleteSelectedChapters(), false, '第一条回执就发现换书：不落地');
  assert.deepEqual(delCalls, ['c3'], '发现换书立即停手，不再继续删后面的章');
  assert.equal(del.state.bookPath, NEW_BOOK, '换书是作者的动作：不许被批量流程改回去');
  assert.equal(del.state.chapters, newChapters, '新书章节数组不许被旧书回执覆盖');
  assert.equal(del.state.selectedIds.size, 1, '新书的多选上下文不许被旧动作清掉');
  assert.equal(del.counts.undo.length, 0, '没有落地任何删除，不许登记撤销');
  assert.ok(del.counts.toast.some(([message, kind]) => kind === 'warn' && /换了书/.test(message)), '要明确提示这次结果没套到当前书');

  // ② 批量移卷：第一条回执返回前换书
  const mv = makeHost({ state: { selectedIds: new Set([0, 1]) } });
  const mvCalls = [];
  const mvChapters = mv.state.chapters;
  const mvVolumes = mv.state.meta.volumes;
  mv.host.api.moveChapterToVolume = async (bookPath, chapterId) => {
    mvCalls.push(chapterId);
    const oldMeta = switchBook(mv, mvChapters, mvVolumes);
    return { ok: true, data: { index: 0, meta: oldMeta } };
  };
  const mvResult = await mv.ui.moveSelectedChaptersToVolume('v2');
  assert.equal(mvResult.ok, false);
  assert.equal(mvResult.code, 'BOOK_CHANGED');
  assert.deepEqual(mvCalls, ['c1'], '发现换书立即停手，不再移动后面的章');
  assert.equal(mv.state.chapters, newChapters);
  assert.equal(mv.state.selectedIds.size, 1);
  assert.equal(mv.counts.undo.length, 0, '没有落地任何移动，不许登记撤销');

  // ③ 批量改状态：第一条回执返回前换书
  const st = makeHost({ state: { selectedIds: new Set([0, 1]) } });
  const stCalls = [];
  const stChapters = st.state.chapters;
  const stVolumes = st.state.meta.volumes;
  st.host.api.updateChapterMeta = async (bookPath, chapterId) => {
    stCalls.push(chapterId);
    const oldMeta = switchBook(st, stChapters, stVolumes);
    return { ok: true, data: { changed: true, chapter: { status: 'done' }, meta: oldMeta } };
  };
  const stResult = await st.ui.setSelectedChaptersStatus('done');
  assert.equal(stResult.code, 'BOOK_CHANGED');
  assert.deepEqual(stCalls, ['c1'], '发现换书立即停手，不再改后面的章');
  assert.equal(st.state.chapters, newChapters);
  assert.equal(st.state.selectedIds.size, 1);
  assert.deepEqual(st.counts.syncItem, [], '不许拿旧书下标去刷新新书的章节条目');
});

// RNDC-01（第 5 轮）：批量删除把最后一批章删空时，旧实现仍按「回落下标 → loadChapterAt(0)」收尾。
// 真 loadChapterAt 在 0 章直接回 { ok:false, code:'NO_BOOK' }（不碰编辑区、不改 state），调用方只
// toast 一句「载入失败」：index 停在 0（指向不存在的章）、编辑区还留着刚删掉那一章的正文、也没有
// 切只读空态 —— 之后保存 / 新建都落在一个不存在的章上。修法：删空与单章删除走同一份空态收尾
// （index=-1、清空并遮罩编辑区、提示「这本书还没有章节」、重画目录），仍登记一次撤销。
test('RNDC-01：批量删除删空后切空态（index=-1 / 编辑区清空 + 只读遮罩），不许拿 0 号章硬载', async () => {
  const loads = [];
  const rt = makeHost({
    state: { selectedIds: new Set([0, 1, 2]), index: 1, dirty: false },
    host: {
      // 与真 loadChapterAt 同口径：0 章直接 NO_BOOK，不清编辑区 / 不改 state（失败只由调用方处理）
      loadChapterAt: async (index) => {
        loads.push(index);
        return { ok: false, code: 'NO_BOOK' };
      }
    }
  });
  rt.editorEl.value = '第二章的正文：删完不该留在编辑区';
  rt.host.api.deleteChapter = async (bookPath, chapterId) => {
    rt.state.chapters = rt.state.chapters.filter((chapter) => chapter.id !== chapterId);
    rt.state.meta.chapters = rt.state.chapters;
    return {
      ok: true,
      data: {
        index: 0,
        chapters: rt.state.chapters,
        meta: { chapters: rt.state.chapters, volumes: rt.state.meta.volumes },
        trashPath: `C:\\书\\_trash\\${chapterId}.md`,
        undoToken: `tok-${chapterId}`
      }
    };
  };
  assert.equal(await rt.ui.deleteSelectedChapters(), true);
  assert.equal(rt.state.chapters.length, 0);
  assert.equal(rt.state.index, -1, '0 章时下标必须回 -1（0 号章已经不存在，保存 / 新建会落空）');
  assert.deepEqual(loads, [], '删空不许再走 loadChapterAt（真实现只回 NO_BOOK，什么都不会修）');
  assert.equal(rt.state.dirty, false);
  assert.equal(rt.state.loadedChapterId, null);
  assert.equal(rt.editorEl.value, '', '编辑区要清掉上一章的正文');
  assert.equal(rt.counts.lastMask[0], true, '编辑区切只读空态遮罩');
  assert.match(rt.counts.lastMask[1], /还没有章节/);
  assert.ok(rt.counts.renderList >= 1, '目录要重画成「还没有章节」');
  assert.equal(rt.counts.undo.length, 1, '删空仍要能一键撤销');
  assert.equal(rt.counts.undo[0].title, '已删除 3 章');
  assert.equal(
    rt.counts.toast.some(([message]) => /载入失败/.test(message)),
    false,
    '删空不是载章失败，不许把「章节载入失败」的 toast 打给作者'
  );
});

test('A3-Cβ / B6：批量移到卷 / 批量改状态——已在该卷跳过、部分失败不许静默、单章走单章流程', async () => {
  const rt = makeHost();
  rt.state.selectedIds = new Set([0, 1, 2]);
  rt.state.chapters[1].volumeId = 'v2';
  const moveCalls = [];
  rt.host.api.moveChapterToVolume = async (bookPath, chapterId, volumeId) => {
    moveCalls.push([chapterId, volumeId]);
    return { ok: true, data: { index: 0, meta: { chapters: rt.state.chapters, volumes: rt.state.meta.volumes } } };
  };
  const moved = await rt.ui.moveSelectedChaptersToVolume('v2');
  assert.equal(moved.ok, true);
  assert.deepEqual(moveCalls, [['c1', 'v2'], ['c3', 'v2']], '已经在目标卷里的 c2 跳过（只移动真正换卷的）');
  assert.deepEqual(rt.counts.load, [], '批量移卷不切章');
  assert.equal(rt.counts.undo.length, 1);
  assert.equal(rt.counts.undo[0].title, '已把 2 章移到「第二卷」');
  // 撤销：从后往前插回（REDT-C-01：正序插回会把段内其余章排到原卷末尾）。
  rt.host.api.moveChapterByDrop = async (chapter, target) => {
    rt.counts.drop.push([chapter.id, target.volumeId, target.beforeChapterId]);
    return { ok: true };
  };
  await rt.counts.undo[0].run();
  assert.deepEqual(rt.counts.drop.map((item) => item[1].volumeId), [null, 'v1']);
  // 全都在目标卷：明确提示，不假装成功。
  const rtSame = makeHost({ state: { selectedIds: new Set([0, 1]) } });
  const same = await rtSame.ui.moveSelectedChaptersToVolume('v1');
  assert.deepEqual(same, { ok: false });
  assert.equal(rtSame.counts.toast[0][1], 'warn');
  assert.match(rtSame.counts.toast[0][0], /已经在「第一卷」里了/);
  // 部分失败：成功几章就撤销几章，一条都没成则 error。
  const rtPart = makeHost({ state: { selectedIds: new Set([0, 2]) } });
  let n = 0;
  rtPart.host.api.moveChapterToVolume = async () => {
    n += 1;
    if (n === 1) return { ok: true, data: { index: 0, meta: { chapters: rtPart.state.chapters, volumes: rtPart.state.meta.volumes } } };
    return { ok: false, code: 'ENOSPC', message: '磁盘满' };
  };
  const part = await rtPart.ui.moveSelectedChaptersToVolume('v2');
  assert.equal(part.ok, true);
  assert.equal(rtPart.counts.undo.length, 1);
  assert.equal(rtPart.counts.undo[0].title, '已把 1 章移到「第二卷」');

  // 批量改状态：changed 计数；一条对不上 → 整表重建；失败章计数提示。
  const rtStatus = makeHost({ state: { selectedIds: new Set([0, 2]) } });
  rtStatus.host.api.updateChapterMeta = async (bookPath, chapterId, patch) => {
    if (chapterId === 'c3') return { ok: true, data: { changed: false, chapter: { status: patch.status }, meta: { chapters: rtStatus.state.chapters, volumes: rtStatus.state.meta.volumes } } };
    return { ok: true, data: { changed: true, chapter: { status: patch.status }, meta: { chapters: rtStatus.state.chapters, volumes: rtStatus.state.meta.volumes } } };
  };
  const status = await rtStatus.ui.setSelectedChaptersStatus('done');
  assert.deepEqual(status, { ok: true, changed: 1, failed: 0 });
  assert.equal(rtStatus.counts.toast.at(-1)[0], '已把 1 章标记为已完成（只改书目，正文没动）');
  assert.equal(rtStatus.state.selectedIds.size, 0);
  rtStatus.setSyncItem(() => false);
  rtStatus.state.selectedIds = new Set([0]);
  await rtStatus.ui.setSelectedChaptersStatus('done');
  assert.ok(rtStatus.counts.renderList >= 1, '条目对不上 → 退回整表重建');
  // 单章：走 setChapterStatusAt → updateChapterInfo（错误码原样带出）。
  const rtOne = makeHost({ state: { selectedIds: new Set([0]) } });
  rtOne.host.api.updateChapterMeta = async () => ({ ok: false, code: 'EACCES', message: '只读' });
  const one = await rtOne.ui.setSelectedChaptersStatus('revising');
  assert.equal(one.ok, false);
  assert.equal(one.code, 'EACCES');
  assert.equal(rtOne.state.selectedIds.size, 0);
  assert.match(rtOne.counts.toast[0][0], /^保存章节信息失败：只读/);
});

// REDT-C-01（高）：批量「移到卷」的撤销把相邻选中章错排到原卷末尾。
// 这里不用打桩返回值，而是按 core/storage.moveChapterToVolume / moveChapterTo 的真实语义
// （改 volumeId → 追加 / 按 beforeId 的**现位** splice → normalizeChapterOrder 归组）
// 维护 state.chapters，才能量出撤销后的章序而不只是调用顺序。
test('REDT-C-01：相邻多选移卷后撤销，逐字还原原章序（不把段内其余章排到原卷末尾）', async () => {
  let rt = null;
  const normalizeState = () => {
    rt.state.chapters = chaptersLib.normalizeChapterOrder(rt.state.meta).chapters;
    rt.state.meta.chapters = rt.state.chapters;
  };
  // 撤销走的是宿主级 moveChapterByDrop（不是 api），必须在 create 之前就把真实语义的实现交进去。
  const simulateDrop = async (chapter, target) => {
    const moved = { ...chapter, volumeId: target.volumeId || null };
    const rest = rt.state.chapters.filter((item) => item.id !== chapter.id).map((item) => ({ ...item }));
    const restMeta = { ...rt.state.meta, chapters: rest };
    const beforeIndex = target.beforeChapterId
      ? rest.findIndex((item) => item.id === target.beforeChapterId)
      : -1;
    const at = beforeIndex >= 0 ? beforeIndex : chaptersLib.insertIndexForVolume(restMeta, target.volumeId);
    const next = rest.slice();
    next.splice(Math.max(0, Math.min(at, next.length)), 0, moved);
    rt.state.meta.chapters = next;
    normalizeState();
    return { ok: true, meta: rt.state.meta };
  };
  rt = makeHost({
    state: {
      index: 0,
      selectedIds: new Set([1, 2]),
      chapters: [
        { id: 'X', name: '序', file: '000.md', volumeId: 'v1' },
        { id: 'A', name: '甲', file: '001.md', volumeId: 'v1' },
        { id: 'B', name: '乙', file: '002.md', volumeId: 'v1' },
        { id: 'C', name: '丙', file: '003.md', volumeId: 'v1' }
      ],
      meta: { title: '测试书', volumes: [{ id: 'v1', name: '第一卷' }, { id: 'v2', name: '第二卷' }] }
    },
    host: { moveChapterByDrop: simulateDrop }
  });
  rt.state.meta.chapters = rt.state.chapters;
  rt.host.api.moveChapterToVolume = async (bookPath, id, volumeId) => {
    const chapter = rt.state.chapters.find((item) => item.id === id);
    const rest = rt.state.chapters.filter((item) => item.id !== id).map((item) => ({ ...item }));
    rt.state.meta.chapters = rest.concat([{ ...chapter, volumeId: volumeId || null }]);
    normalizeState();
    return { ok: true, data: { index: rt.state.chapters.findIndex((item) => item.id === id), meta: rt.state.meta } };
  };
  const moved = await rt.ui.moveSelectedChaptersToVolume('v2');
  assert.equal(moved.ok, true);
  assert.deepEqual(rt.state.chapters.map((item) => item.id), ['X', 'C', 'A', 'B']);
  assert.equal(rt.counts.undo.length, 1);
  await rt.counts.undo[0].run();
  assert.deepEqual(rt.state.chapters.map((item) => item.id), ['X', 'A', 'B', 'C'], '撤销必须还原原章序');
  assert.deepEqual(rt.state.chapters.map((item) => item.volumeId), ['v1', 'v1', 'v1', 'v1']);
});

test('A3-Cβ / B7：导出 / 复制 / 备注——非连续明确拒绝、复制含未保存正文、备注清空 = 删除', async () => {
  // 导出：只支持连续范围。
  const rt = makeHost({ state: { selectedIds: new Set([0, 2]) } });
  rt.ui.exportSelectedChapters();
  assert.equal(rt.counts.exportDialog.length, 0, '非连续不静默扩大范围');
  assert.equal(rt.counts.toast[0][1], 'warn');
  assert.match(rt.counts.toast[0][0], /只支持连续范围/);
  rt.state.selectedIds = new Set([1, 2]);
  rt.ui.exportSelectedChapters();
  assert.deepEqual(rt.counts.exportDialog, [['txt', { from: 2, to: 3 }]], '范围按 1 基章号传出');
  rt.state.selectedIds = new Set();
  rt.ui.exportSelectedChapters();
  assert.equal(rt.counts.exportDialog.length, 1, '空选择什么也不做');

  // 复制：当前章有未保存内容时用编辑区文本（与导出同一口径）。
  const rtCopy = makeHost({ state: { selectedIds: new Set([0, 1]), dirty: true, index: 1 } });
  rtCopy.editorEl.value = '编辑区里还没保存的字';
  const copyArgs = [];
  rtCopy.host.api.copyBook = async (bookPath, override, indexes) => {
    copyArgs.push([bookPath, override, indexes]);
    return { ok: true, data: { chapterCount: 2, chars: 1234, includedUnsaved: true } };
  };
  const copied = await rtCopy.ui.copySelectedChapters();
  assert.deepEqual(copyArgs, [[
    'C:/书架/书 名 带 空格',
    { chapterId: 'c2', text: '编辑区里还没保存的字' },
    [0, 1]
  ]]);
  assert.match(rtCopy.counts.toast.at(-1)[0], /已复制选中的章节（2 章 · 1234 字 · 含当前章未保存内容）/);
  assert.equal(copied.chapterCount, 2);
  // 没书 / 空选择 / IPC 失败（EACCES）都不抛。
  const rtNo = makeHost();
  rtNo.state.bookPath = null;
  assert.equal(await rtNo.ui.copySelectedChapters(), null);
  rtNo.state.bookPath = 'C:/书';
  assert.equal(await rtNo.ui.copySelectedChapters(), null);
  assert.equal(rtNo.counts.toast[0][1], 'warn');
  const rtErr = makeHost({ state: { selectedIds: new Set([0]) } });
  rtErr.host.api.copyBook = async () => ({ ok: false, code: 'EACCES', message: '剪贴板被拒' });
  assert.equal(await rtErr.ui.copySelectedChapters(), null);
  assert.match(rtErr.counts.toast[0][0], /^复制失败：剪贴板被拒/);

  // 备注：prompt → updateChapterInfo → 只改书目；清空后确定 = 删除备注。
  const rtNote = makeHost({ promptQueue: ['这章结尾要重写'] });
  rtNote.host.api.updateChapterMeta = async (bookPath, chapterId, patch) => {
    rtNote.state.chapters[0] = { ...rtNote.state.chapters[0], note: patch.note };
    return { ok: true, data: { changed: true, chapter: rtNote.state.chapters[0], meta: { chapters: rtNote.state.chapters, volumes: rtNote.state.meta.volumes } } };
  };
  assert.equal(await rtNote.ui.editChapterNoteAt(0), '这章结尾要重写');
  assert.equal(rtNote.counts.toast.at(-1)[0], '备注已保存');
  rtNote.setPromptQueue(['']);
  assert.equal(await rtNote.ui.editChapterNoteAt(0), '');
  assert.equal(rtNote.counts.toast.at(-1)[0], '备注已清除');
  // 取消 / 没有这一章 / 写盘失败：返回 null，不抛。
  const rtCancel = makeHost({ promptQueue: [null] });
  assert.equal(await rtCancel.ui.editChapterNoteAt(0), null);
  assert.equal(await rtCancel.ui.editChapterNoteAt(99), null);
  const rtFail = makeHost({ promptQueue: ['备注'] });
  rtFail.host.api.updateChapterMeta = async () => ({ ok: false, code: 'ENOSPC', message: '磁盘满了' });
  assert.equal(await rtFail.ui.editChapterNoteAt(0), null);
  assert.match(rtFail.counts.toast[0][0], /^保存章节信息失败：磁盘满了/);
});

test('A3-Cβ / B8：移到卷菜单——当前卷不再列 / 批量列全部卷 / 唯一卷提示 / 含空格卷名原样', () => {
  const { stub } = makeDocumentStub();
  const realDocument = global.document;
  global.document = stub;
  try {
    const rt = makeHost();
    rt.state.meta.volumes = [{ id: 'v1', name: '第一卷' }, { id: 'v2', name: '第二卷 有空 格' }];
    rt.state.chapters[0].volumeId = 'v1';
    assert.equal(rt.ui.openVolumeChooserInMenu(0), true);
    const holder = rt.els['context-menu-volumes'];
    assert.equal(holder.className, undefined, '菜单容器复用，不新建');
    assert.equal(holder.classList.list.includes('hidden'), false, '展开菜单');
    assert.equal(rt.counts.placeMenuAt, 1);
    // 标题 + 另一个卷 + 移回未分卷 = 3 个节点。
    assert.equal(holder.children.length, 3);
    assert.equal(holder.children[0].className, 'context-menu-label');
    assert.match(holder.children[0].textContent, /把「第1章 第一章」移到/);
    assert.equal(holder.children[1].textContent, '第二卷 有空 格', '含空格卷名原样显示');
    assert.equal(holder.children[1].dataset.action, 'move-volume:v2');
    assert.equal(holder.children[2].textContent, '移回「未分卷」');

    // 批量（index < 0）：所有卷都列，已经是「当前卷」的也列；标题带选中章数。
    const rtBatch = makeHost({ state: { selectedIds: new Set([0, 2]) } });
    rtBatch.state.meta.volumes = [{ id: 'v1', name: '第一卷' }, { id: 'v2', name: '第二卷' }];
    rtBatch.state.chapters[0].volumeId = 'v1';
    assert.equal(rtBatch.ui.openVolumeChooserInMenu(-1), true);
    const batchHolder = rtBatch.els['context-menu-volumes'];
    assert.equal(batchHolder.children.length, 4, '标题 + 2 个卷 + 移回未分卷');
    assert.match(batchHolder.children[0].textContent, /把选中的 2 章移到/);

    // 没有卷：给一条引导，不静默空白菜单。
    const rtEmpty = makeHost({ state: { meta: { chapters: [], volumes: [] } } });
    rtEmpty.state.chapters[0].volumeId = null;
    rtEmpty.state.chapters[1].volumeId = null;
    rtEmpty.state.chapters[2].volumeId = null;
    assert.equal(rtEmpty.ui.openVolumeChooserInMenu(0), true);
    assert.match(rtEmpty.els['context-menu-volumes'].children[0].textContent, /这本书还没有卷，先「＋ 新建卷」/);
    // 越界章：返回 false，不碰 DOM。
    assert.equal(rtEmpty.ui.openVolumeChooserInMenu(99), false);
  } finally {
    if (realDocument === undefined) delete global.document;
    else global.document = realDocument;
  }
});
test('五-M7：备注 prompt 在途时章节数组被换掉——按 prompt 前捕获的章 id 落笔，不拿旧 index 改写另一章', async () => {
  // 方向一：prompt 期间这一章被移到别的下标（移卷 / 排序 / 换数组的回执）→ 备注仍写到原章。
  const box = {};
  const rt = makeHost({
    host: {
      promptText: async () => {
        // prompt 在途：章节数组被替换，c1 从下标 0 挪到末尾
        const chapters = box.rt.state.chapters;
        chapters.push(chapters.splice(0, 1)[0]);
        box.rt.state.meta.chapters = chapters;
        return '写给第一章的备注';
      }
    }
  });
  box.rt = rt;
  const written = [];
  rt.host.api.updateChapterMeta = async (bookPath, chapterId, patch) => {
    written.push(chapterId);
    const target = rt.state.chapters.find((item) => item.id === chapterId);
    if (!target) return { ok: false, code: 'NO_CHAPTER', message: '章节不存在' };
    Object.assign(target, patch);
    return {
      ok: true,
      data: { changed: true, chapter: { ...target }, meta: { chapters: rt.state.chapters, volumes: rt.state.meta.volumes } }
    };
  };
  assert.equal(await rt.ui.editChapterNoteAt(0), '写给第一章的备注');
  assert.deepEqual(written, ['c1'], '备注必须落到 prompt 打开的那一章（c1），不是现在下标 0 的 c2');
  assert.equal(rt.state.chapters.find((item) => item.id === 'c1').note, '写给第一章的备注');
  assert.equal(rt.state.chapters.find((item) => item.id === 'c2').note, undefined, '别的章不许长出备注');

  // 方向二：prompt 期间这一章被删掉 → 不写任何章、给出提示、返回 null。
  const box2 = {};
  const rt2 = makeHost({
    host: {
      promptText: async () => {
        box2.rt.state.chapters = box2.rt.state.chapters.filter((item) => item.id !== 'c1');
        box2.rt.state.meta.chapters = box2.rt.state.chapters;
        return '写给第一章的备注';
      }
    }
  });
  box2.rt = rt2;
  const written2 = [];
  rt2.host.api.updateChapterMeta = async (bookPath, chapterId, patch) => {
    written2.push(chapterId);
    const target = rt2.state.chapters.find((item) => item.id === chapterId);
    if (!target) return { ok: false, code: 'NO_CHAPTER', message: '章节不存在' };
    Object.assign(target, patch);
    return {
      ok: true,
      data: { changed: true, chapter: { ...target }, meta: { chapters: rt2.state.chapters, volumes: rt2.state.meta.volumes } }
    };
  };
  assert.equal(await rt2.ui.editChapterNoteAt(0), null);
  assert.deepEqual(written2, [], '那一章已经不在书里：不许拿旧 index 去写现位置的另一章');
  assert.equal(rt2.state.chapters[0].id, 'c2');
  assert.equal(rt2.state.chapters[0].note, undefined);
  assert.equal(rt2.counts.toast.at(-1)[1], 'warn');
  assert.match(rt2.counts.toast.at(-1)[0], /已经不在书里/);
});

// ---------- T1（三审·高）/ H1（一轮·高）：保存期间输入 → 删当前章 / 批量删 / 建章 ----------
// 三个入口都是「保存成功后立刻重载编辑区」。旧实现只看 saved.ok 就继续，于是保存 IPC 往返
// （fsync / 书目 / 统计写盘，冷盘 / 杀软下可达数百 ms）期间敲入的字不在磁盘上，随后的
// loadChapterAt 把编辑区整段换成新章 —— 这段输入被静默覆盖且无法撤销。
// 现在统一走 saveForTransition：保存回执落地后按发起时的快照复核 dirty，仍脏就再问，
// 绝不带着未保存输入继续删 / 建 / 载。
test('T1 / H1：三个过渡入口都走 saveForTransition——回执后仍脏就停，绝不静默覆盖保存期间输入的字', async () => {
  // ① 删当前章
  const del = makeHost();
  del.state.index = 1;
  del.state.dirty = true;
  del.editorEl.value = '第二章正文';
  const delCalls = [];
  del.host.api.deleteChapter = async (bookPath, chapterId) => {
    delCalls.push(chapterId);
    return { ok: true, data: { index: 0, meta: { chapters: del.state.chapters, volumes: del.state.meta.volumes }, trashPath: 'x/002.md', undoToken: 't' } };
  };
  const delGuards = [];
  del.host.saveForTransition = async (options) => {
    delGuards.push(options);
    // 模拟「保存在途作者又敲了一句」：原语保存回执后复核 dirty，回来的是取消。
    del.editorEl.value = '第二章正文\n保存期间又敲的一句';
    del.state.dirty = true;
    return { ok: false, canceled: true };
  };
  const delUi = moduleApi.create(del.host);
  assert.equal(await delUi.deleteChapterAt(1), false);
  assert.equal(delGuards.length, 1, '删当前章必须先走统一「过渡前保存」原语');
  assert.equal(delGuards[0].saveLabel, '保存后删除');
  assert.deepEqual(delCalls, [], '原语回取消 → 绝不调 deleteChapter');
  assert.equal(del.state.dirty, true, '未落盘的输入仍标脏（关窗 / 切章照常拦截）');
  assert.equal(del.editorEl.value, '第二章正文\n保存期间又敲的一句', '编辑区里的字一个不许少');
  assert.deepEqual(del.counts.load, []);

  // ② 批量删除（当前章在选中集合里）
  const batch = makeHost();
  batch.state.index = 1;
  batch.state.dirty = true;
  batch.state.selectedIds = new Set([0, 1, 2]);
  batch.editorEl.value = '第二章正文';
  const batchDeletes = [];
  batch.host.api.deleteChapter = async (bookPath, chapterId) => {
    batchDeletes.push(chapterId);
    return { ok: true, data: { index: 0, meta: { chapters: batch.state.chapters, volumes: batch.state.meta.volumes }, trashPath: `x/${chapterId}.md`, undoToken: 't' } };
  };
  let batchGuard = 0;
  batch.host.saveForTransition = async () => {
    batchGuard += 1;
    batch.editorEl.value = '第二章正文 + 保存期间敲的字';
    batch.state.dirty = true;
    return { ok: false, canceled: true };
  };
  const batchUi = moduleApi.create(batch.host);
  assert.equal(await batchUi.deleteSelectedChapters(), false);
  assert.equal(batchGuard, 1, '批量删除也必须走统一原语');
  assert.deepEqual(batchDeletes, [], '取消时不删任何一章');
  assert.equal(batch.state.dirty, true);
  assert.equal(batch.state.chapters.length, 3, '书目一章不许少');
  assert.equal(batch.editorEl.value, '第二章正文 + 保存期间敲的字');

  // ③ 建章
  const create = makeHost();
  create.state.dirty = true;
  create.editorEl.value = '当前章正文';
  create.state.globalConfig.chapterTemplate = '第{章号}章 {章名}';
  const created = [];
  create.host.api.createChapter = async (...args) => {
    created.push(args);
    return { ok: true, data: { index: 3, chapter: { name: '新章' }, meta: { chapters: create.state.chapters, volumes: create.state.meta.volumes } } };
  };
  let createGuard = null;
  create.host.saveForTransition = async (options) => {
    createGuard = options;
    create.state.dirty = true;
    return { ok: false, canceled: true };
  };
  const createUi = moduleApi.create(create.host);
  const createResult = await createUi.createChapterAt(3, '新章');
  assert.equal(createResult.ok, false);
  assert.equal(createResult.canceled, true);
  assert.deepEqual(created, [], '原语回取消 → 绝不建新章');
  assert.equal(createGuard && createGuard.silentFirst, true, '建章保留原来的「先静默保存」体验');
  assert.equal(create.counts.input, 0, '模板一个字都不许套进旧章');
  assert.equal(create.editorEl.value, '当前章正文');

  // ④ 干净放行：原语说「已经保存干净」→ 三个入口照常继续。
  const clean = makeHost();
  clean.state.index = 1;
  clean.state.dirty = true;
  const cleanDeletes = [];
  clean.host.api.deleteChapter = async (bookPath, chapterId) => {
    cleanDeletes.push(chapterId);
    const chapters = clean.state.chapters.filter((chapter) => chapter.id !== chapterId);
    return { ok: true, data: { index: 1, meta: { chapters, volumes: clean.state.meta.volumes }, trashPath: 'x/002.md', undoToken: 't' } };
  };
  clean.host.saveForTransition = async () => {
    clean.state.dirty = false; // 与真原语一致：回执落地后按快照复核，干净才返回 ok
    return { ok: true };
  };
  const cleanUi = moduleApi.create(clean.host);
  assert.equal(await cleanUi.deleteChapterAt(1), true);
  assert.deepEqual(cleanDeletes, ['c2']);
  assert.equal(clean.counts.load.length, 1, '删完照常载入新章');
});

test('T1 / H1：宿主没给 saveForTransition 时的兜底——保存成功但回执时仍脏，也绝不动手', async () => {
  // 旧宿主（单测 / 老装配）没有统一原语：deleteSelectedChapters 走「一问一存」，但保存回执后
  // 仍脏时同样必须停下（与统一原语同一纪律），不许只看 saved.ok。
  const del = makeHost({ askQueue: ['save'], saveMutatesDuringSave: true });
  del.state.index = 1;
  del.state.dirty = true;
  del.editorEl.value = '第二章正文';
  const deleted = [];
  del.host.api.deleteChapter = async (bookPath, chapterId) => {
    deleted.push(chapterId);
    return { ok: true, data: { index: 0, meta: { chapters: del.state.chapters, volumes: del.state.meta.volumes }, trashPath: 'x/002.md', undoToken: 't' } };
  };
  assert.equal(await del.ui.deleteChapterAt(1), false);
  assert.deepEqual(deleted, [], '保存成功但仍有未落盘输入 → 不删');
  assert.equal(del.state.dirty, true);

  const create = makeHost({ saveMutatesDuringSave: true });
  create.state.dirty = true;
  const created = [];
  create.host.api.createChapter = async () => {
    created.push(1);
    return { ok: true, data: { index: 0, chapter: { name: 'x' }, meta: { chapters: create.state.chapters, volumes: create.state.meta.volumes } } };
  };
  const createResult = await create.ui.createChapterAt(3, '新章');
  assert.equal(createResult.ok, false);
  assert.equal(createResult.dirty, true);
  assert.deepEqual(created, [], '建章同样不许带着未落盘输入继续');
});

// ---------- 旧M1 / 旧M2（一轮·中）----------
test('旧M1：建章后载章失败 → 不套模板、不报成功（绝不把模板写进旧章）', async () => {
  const rt = makeHost({ loadResult: { ok: false, code: 'LOAD_FAILED', message: '读取章节失败：文件缺失' } });
  rt.state.dirty = false;
  rt.state.chapterFilter = '目录';
  rt.state.globalConfig.chapterTemplate = '第{章号}章 {章名}';
  rt.editorEl.value = '旧章正文';
  const result = await rt.ui.createChapterAt(3, '新章');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CREATE_LOAD_FAILED');
  assert.equal(rt.counts.input, 0, '载章失败不许套模板（onEditorInput 一次都不许走）');
  assert.equal(rt.editorEl.value, '旧章正文', '编辑区仍是旧章正文');
  assert.equal(rt.counts.toast.at(-1)[1], 'error');
  assert.match(rt.counts.toast.at(-1)[0], /载入失败/);
  assert.ok(rt.counts.renderList >= 1, '目录要重画（新章已经建好，作者要能看到它）');
});

test('旧M2：删除后载章失败 → 保持脏 + 提示，不进「正文在、状态栏已保存」矛盾态', async () => {
  // 单章（skipConfirm 自动化钩子）+ 保存期间仍有输入：删除成功但新章载入失败。
  const del = makeHost({ loadResult: { ok: false, code: 'LOAD_FAILED', message: '读取章节失败' } });
  del.state.index = 1;
  del.state.dirty = true;
  del.editorEl.value = '第二章正文（没落盘）';
  del.host.api.deleteChapter = async () => {
    const chapters = del.state.chapters.filter((chapter) => chapter.id !== 'c2');
    return { ok: true, data: { index: 1, meta: { chapters, volumes: del.state.meta.volumes }, trashPath: 'x/002.md', undoToken: 't' } };
  };
  assert.equal(await del.ui.deleteChapterAt(1, true), true);
  assert.equal(del.state.dirty, true, '载章失败必须保持脏（关窗要照常拦截）');
  assert.match(del.counts.toast.at(-1)[0], /载入失败/);

  // 批量删除的当前章分支同一口径（只删 2 章、留 c3：0 章收尾现在是「空态」，不算载章失败 ——
  // 这里要钉的是「批量尾部真的去载章、载失败保持脏」）。
  const batch = makeHost({ loadResult: { ok: false, code: 'LOAD_FAILED', message: '读取章节失败' }, askQueue: ['discard'] });
  batch.state.index = 1;
  batch.state.dirty = true;
  batch.state.selectedIds = new Set([0, 1]);
  batch.editorEl.value = '第二章正文（没落盘）';
  batch.host.api.deleteChapter = async (bookPath, chapterId) => {
    const chapters = batch.state.chapters.filter((chapter) => chapter.id !== chapterId);
    batch.state.chapters = chapters;
    batch.state.meta.chapters = chapters;
    return { ok: true, data: { index: 1, meta: { chapters, volumes: batch.state.meta.volumes }, trashPath: `x/${chapterId}.md`, undoToken: 't' } };
  };
  assert.equal(await batch.ui.deleteSelectedChapters(), true);
  assert.equal(batch.state.dirty, true, '批量删后载章失败同样保持脏');
  assert.ok(batch.counts.toast.some(([message]) => /载入失败/.test(message)));
});


// KNOWN-CHAPTER（2026-11-26 复核）：保存 IPC 正在跑时 saveCurrent 回 BUSY；建章 / 删章入口
// 拿到 ok:false 会静默 return，作者点了像按钮没反应。统一补一句「正在保存中，请稍候再试」。
test('KNOWN-CHAPTER：保存撞 BUSY 时过渡入口给弱提示，不再静默', async () => {
  const rt = makeHost();
  rt.state.dirty = true;
  rt.host.saveForTransition = async () => ({ ok: false, saved: { ok: false, code: 'BUSY', message: '正在保存中' } });
  const res = await moduleApi.create(rt.host).createChapterAt(0);
  assert.equal(res.ok, false);
  assert.deepEqual(rt.counts.createChapter, [], '保存途中不发起建章');
  assert.deepEqual(rt.counts.toast.at(-1), ['正在保存中，请稍候再试', 'warn']);

  const del = makeHost();
  del.state.index = 0; // 删的是当前章才会触发未保存拦截
  del.state.dirty = true;
  del.host.saveForTransition = async () => ({ ok: false, saved: { ok: false, code: 'BUSY', message: '正在保存中' } });
  assert.equal(await moduleApi.create(del.host).deleteChapterAt(0), false);
  assert.deepEqual(del.counts.toast.at(-1), ['正在保存中，请稍候再试', 'warn']);
});
