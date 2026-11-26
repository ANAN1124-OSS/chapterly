// 剪贴板面板测试的共用夹具（T9 / 第 9 轮：原 tests/capture-ui.test.js 按性质拆成三个文件）。
//
// 拆法（与 storage / config 的 T9 拆分同口径，见 tests/README.md 的「临时目录与夹具」）：
//   · 本文件放**夹具**：极简假 DOM（makeEl / hasClass）、假 host 工厂 build(options)、
//     withFakeDocument（装/收全局 document）、以及三个静态闸门共用的源码读取（read / stripComments
//     与 moduleSrc / indexSrc / stylesSrc / rendererSrc / hooksSrc 那几份常量）。
//   · 用例按性质分三个 .test.js：capture-ui（打开 / 正文 / 章节 / 队列等行为）、
//     capture-ui-static（六条静态闸门）、capture-ui-refresh（刷新竞态 / 清空失败 / 补拉）。
// 本文件不叫 *.test.js：`node --test "tests/**/*.test.js"` 不会把它当用例跑。
//
// 保留原有完整性自检：core/capture.js 缺 recordPreview 时当场抛错（以前垫过永久 fallback，
// 真实现缺失时本套测试能「自证通过」——那条兜底绝不许回来）。
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const capture = require('../core/capture');

// 被测模块的真实现就在 core/capture.js（契约 §3）。缺了必须当场失败：
// 之前这里垫了一个永久 fallback，真实现缺失时本文件仍能靠测试内的假实现「自证通过」，等于没测被测代码。
if (typeof capture.recordPreview !== 'function') {
  throw new Error('core/capture.js 缺少 recordPreview（契约 §3）：真实现缺失，测试不能拿测试内的假实现自证');
}

const captureUiModule = require('../renderer/capture-ui');
const staleGuard = require('../renderer/stale-guard');
const backdropRegistry = require('../renderer/backdrop-registry');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// 剥掉块注释与整行 // 注释，供「renderer.js 里不许再长第二份面板实现」这类纯度闸门用。
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const moduleSrc = read('renderer/capture-ui.js');
const moduleCode = stripComments(moduleSrc);
const indexSrc = read('renderer/index.html');
const stylesSrc = read('renderer/styles.css');
const rendererSrc = read('renderer/renderer.js');
const rendererCode = stripComments(rendererSrc);
// M1 第 14 轮第八刀（断言跟错）：剪贴板变化 / 入队的订阅整段搬进 renderer/notify-events-ui.js，
// 「面板开着原地刷新」的闸门改读模块（行为锚点 tests/notify-events-ui.test.js）。
const notifyEventsSrc = read('renderer/notify-events-ui.js');
const hooksSrc = read('renderer/test-hooks.js');

// ---------- 极简假 DOM ----------
function hasClass(el, name) {
  return String(el.className).split(/\s+/).includes(name);
}

function makeEl(tag = 'div') {
  const classes = new Set();
  const attrs = {};
  let textValue = '';
  const el = {
    tagName: tag,
    dataset: {},
    children: [],
    value: '',
    disabled: false,
    title: '',
    type: '',
    _focus: 0,
    _attrs: attrs,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle(name, force) {
        const want = force === undefined ? !classes.has(name) : Boolean(force);
        if (want) classes.add(name);
        else classes.delete(name);
        return want;
      }
    },
    appendChild(child) {
      // DocumentFragment 挂载：把碎片里的节点搬进来（与真实 DOM 的可视结果一致）
      if (child && child.isFragment) {
        for (const node of child.children) el.children.push(node);
        child.children.length = 0;
        return child;
      }
      el.children.push(child);
      return child;
    },
    setAttribute(name, value) {
      attrs[name] = String(value);
    },
    getAttribute(name) {
      return attrs[name];
    },
    focus() {
      el._focus += 1;
    },
    querySelector(selector) {
      return findFirst(el, selector);
    },
    querySelectorAll(selector) {
      return findAll(el, selector);
    }
  };
  Object.defineProperty(el, 'className', {
    get() {
      return [...classes].join(' ');
    },
    set(value) {
      classes.clear();
      String(value || '')
        .split(/\s+/)
        .filter(Boolean)
        .forEach((name) => classes.add(name));
    }
  });
  Object.defineProperty(el, 'textContent', {
    get() {
      return el.children.length ? el.children.map((child) => child.textContent).join('') : textValue;
    },
    set(value) {
      textValue = String(value);
      el.children.length = 0;
    }
  });
  Object.defineProperty(el, 'innerHTML', {
    get() {
      return '';
    },
    set(value) {
      // TESTC-05：手写假 DOM 只支持「清空」这一种用法（renderer/capture-ui.js 只用 `innerHTML = ''`）。
      // 非空赋值直接抛错——以前是静默吞掉、连子节点都不建，改走 innerHTML 构建节点时测试会莫名错位或假绿。
      if (String(value) !== '') throw new Error('假 DOM 只支持清空 innerHTML（不支持用 innerHTML 建节点）');
      el.children.length = 0;
    }
  });
  return el;
}

// 只支持测试里用到的单段选择器：tag / .class / [attr] / [attr="value"] 的组合。
function matchesSelector(el, selector) {
  let rest = String(selector || '').trim();
  const tagMatch = /^[a-zA-Z]*/.exec(rest);
  const tag = tagMatch ? tagMatch[0] : '';
  rest = rest.slice(tag.length);
  if (tag && el.tagName !== tag) return false;
  while (rest.length) {
    let m = /^\.([\w-]+)/.exec(rest);
    if (m) {
      if (!hasClass(el, m[1])) return false;
      rest = rest.slice(m[0].length);
      continue;
    }
    m = /^\[([\w-]+)(?:="([^"]*)")?\]/.exec(rest);
    if (m) {
      const value = el.dataset[m[1]] !== undefined ? el.dataset[m[1]] : el._attrs[m[1]];
      if (value === undefined) return false;
      if (m[2] !== undefined && String(value) !== m[2]) return false;
      rest = rest.slice(m[0].length);
      continue;
    }
    return false;
  }
  return true;
}

function findAll(root, selector) {
  const out = [];
  for (const child of root.children) {
    if (matchesSelector(child, selector)) out.push(child);
    out.push(...findAll(child, selector));
  }
  return out;
}

function findFirst(root, selector) {
  for (const child of root.children) {
    if (matchesSelector(child, selector)) return child;
    const nested = findFirst(child, selector);
    if (nested) return nested;
  }
  return null;
}

function makeDom() {
  const map = new Map();
  for (const id of [
    'capture-backdrop',
    'capture-queue-view',
    'capture-title',
    'capture-queue-summary',
    'capture-position',
    'capture-queue-list',
    'capture-queue-empty',
    'btn-capture-import',
    'btn-capture-queue-clear',
    'btn-capture-queue-cancel',
    'modal-backdrop',
    'settings-backdrop',
    'export-backdrop',
    'find-backdrop',
    'format-backdrop',
    'jump-backdrop',
    'history-backdrop',
    'bookinfo-backdrop',
    'conflict-backdrop',
    // WP-17（C35）：注册表里的另外 7 层（以前手写清单漏掉的）
    'proofread-backdrop',
    'sensitive-backdrop',
    'fragment-backdrop',
    'fragments-backdrop',
    'group-manage-backdrop',
    'command-backdrop',
    'shortcuts-backdrop'
  ]) {
    map.set(id, makeEl(id.endsWith('-backdrop') ? 'div' : id === 'capture-position' ? 'select' : 'span'));
  }
  for (const id of [
    'capture-backdrop',
    'modal-backdrop',
    'settings-backdrop',
    'export-backdrop',
    'find-backdrop',
    'format-backdrop',
    'jump-backdrop',
    'history-backdrop',
    'bookinfo-backdrop',
    'conflict-backdrop',
    'proofread-backdrop',
    'sensitive-backdrop',
    'fragment-backdrop',
    'fragments-backdrop',
    'group-manage-backdrop',
    'command-backdrop',
    'shortcuts-backdrop',
    'btn-capture-import'
  ]) {
    map.get(id).classList.add('hidden');
  }
  return { map, $: (id) => map.get(id) || null };
}

// 取列表里所有记录 / 所有动作按钮
function recordEls(dom) {
  const list = dom.map.get('capture-queue-list');
  return list.children.filter((el) => hasClass(el, 'capture-record'));
}
function actionButtons(dom) {
  const out = [];
  for (const record of recordEls(dom)) {
    const actions = record.children.find((el) => hasClass(el, 'capture-record-actions'));
    if (actions) out.push(...actions.children);
  }
  return out;
}

// ---------- 假 host ----------
// 队列正文只按 id 走 captureQueueGet 取回（与主进程同口径）；队列 mock 在 build 闭包里可被消费。
const QUEUE_A = `第1章 甲\n\n${'甲正文内容'.repeat(12)}`;
const QUEUE_B = `第2章 乙\n\n${'乙正文内容'.repeat(12)}`;
const PENDING_TEXT = '第7章 短触发\n\n这一段因为太短没有进队列，但仍然可以直接插正文或新建一章。';

function build(options = {}) {
  const log = [];
  const commitPayloads = [];
  const insertPayloads = [];
  const dom = makeDom();
  const queue = (Array.isArray(options.queue) ? options.queue : []).map((item, index) => {
    const source = typeof item === 'string' ? item : String(item && item.text !== undefined ? item.text : '');
    const rawAt = item && item.at !== undefined ? Number(item.at) : NaN;
    return {
      id: item && item.id !== undefined ? Number(item.id) : index + 1,
      text: source,
      // V108（WP-24）：主进程队列条目的 chars 是按 countChars 算的（去空白），rawLength 是原文长度
      chars: capture.countChars(source),
      rawLength: source.length,
      at: Number.isFinite(rawAt) ? rawAt : 1762340000000 + index * 60000
    };
  });
  const chapters =
    options.chapters === undefined
      ? [
          { name: '旧章', volumeId: 'vol-1' },
          { name: '第二章', volumeId: null }
        ]
      : options.chapters;
  const initialIndex = options.index === undefined ? 1 : options.index;
  const state = {
    view: options.view === undefined ? 'editor' : options.view,
    bookPath: options.bookPath === undefined ? '/tmp/books/书甲' : options.bookPath,
    meta: { title: '书甲', titleTemplate: '', chapters },
    chapters,
    index: initialIndex,
    // WP14 E-N10：新建章后要检查载章结果，并按编辑区实际载入的章对齐 index。
    loadedChapterId:
      options.loadedChapterId === undefined
        ? chapters[initialIndex] && chapters[initialIndex].id !== undefined
          ? chapters[initialIndex].id
          : null
        : options.loadedChapterId,
    dirty: Boolean(options.dirty),
    stats: null,
    streak: null
  };
  const api = {
    captureClipboard: async () => {
      log.push('api.captureClipboard');
      return {
        ok: true,
        data: { text: options.clipboardText === undefined ? PENDING_TEXT : options.clipboardText }
      };
    },
    // 主进程 list() 只给元数据 + 截断预览（契约 §3：previewText = recordPreview(entry.text)）
    captureQueueList: async () => {
      log.push('api.captureQueueList');
      return {
        ok: true,
        data: {
          entries: queue.map((item) => ({
            id: item.id,
            chars: item.chars,
            rawLength: item.rawLength,
            at: item.at,
            previewText: capture.recordPreview(item.text),
            preview: item.text.split(/\r?\n/)[0]
          })),
          total: queue.length
        }
      };
    },
    captureQueueGet: async (id) => {
      log.push(`api.captureQueueGet:${id}`);
      const found = queue.find((item) => item.id === Number(id));
      if (!found) return { ok: false, code: 'QUEUE_MISSING', message: '这条复制记录已经不在了' };
      return { ok: true, data: { id: found.id, text: found.text, chars: found.chars, rawLength: found.rawLength, at: found.at } };
    },
    // 2026-11-08：「正文」插入成功后消费这一条（与「章节」同一口径）
    captureQueueRemove: async (id) => {
      log.push(`api.captureQueueRemove:${id}`);
      if (options.removeFails) return { ok: false, code: 'IPC_ERROR', message: '主进程不可用' };
      const at = queue.findIndex((item) => item.id === Number(id));
      if (at < 0) return { ok: true, data: { removed: false } };
      queue.splice(at, 1);
      return { ok: true, data: { removed: true } };
    },
    captureQueueClear: async () => {
      log.push('api.captureQueueClear');
      const cleared = queue.length;
      queue.length = 0;
      return { ok: true, data: { cleared } };
    },
    // 契约 §4 的新 IPC：payload = { text, insertIndex, volumeId, queueId? }
    captureCommitRecord: async (bookPath, payload) => {
      log.push(`api.captureCommitRecord:${bookPath}`);
      commitPayloads.push(payload);
      if (options.commitFails) return { ok: false, code: 'WRITE_FAIL', message: '磁盘只读' };
      let queueRemoved = false;
      if (payload && payload.queueId != null) {
        const at = queue.findIndex((item) => item.id === payload.queueId);
        if (at >= 0) {
          queue.splice(at, 1);
          queueRemoved = true;
        }
      }
      const index = options.commitIndex === undefined ? state.chapters.length : options.commitIndex;
      const nextChapters = state.chapters.slice();
      const chapter = {
        id: 'ch_new',
        name: options.commitName === undefined ? '撞见了幽灵' : options.commitName,
        volumeId: null
      };
      nextChapters.splice(index, 0, chapter);
      const bodyChars =
        options.commitBodyChars !== undefined
          ? options.commitBodyChars
          : options.titleOnly
            ? 0 // titleOnly（整条 <100 字当章名）时主进程 bodyChars=0 / chars=0
            : 42;
      return {
        ok: true,
        data: {
          meta: { title: '书甲', titleTemplate: '', chapters: nextChapters },
          chapter,
          index,
          chars: options.commitChars === undefined ? bodyChars : options.commitChars,
          title: options.commitTitle === undefined ? '撞见了幽灵' : options.commitTitle,
          titleOnly: Boolean(options.titleOnly),
          bodyChars,
          stats: options.noStats ? null : { today: 100, streak: 3 },
          // A2-STATS-02：统计写盘失败时主进程带脱敏后的原因（渲染层要消费它给弱提示）
          statsError: options.commitStatsError || null,
          queueRemoved
        }
      };
    }
  };
  const call = async (fn, ...args) => {
    const res = await fn(...args);
    if (!res || res.ok === false) {
      const err = new Error((res && res.message) || '未知错误');
      err.code = res && res.code;
      throw err;
    }
    return res.data;
  };
  const host = {
    $: dom.$,
    state,
    api,
    call,
    toast: (message, kind) => log.push(`toast:${kind || 'info'}:${message}`),
    saveCurrent: async () => {
      log.push('saveCurrent');
      return { ok: options.saveOk !== false };
    },
    loadChapterAt: async (index) => {
      log.push(`loadChapterAt:${index}`);
      if (options.loadFails) {
        return { ok: false, code: 'LOAD_FAILED', message: options.loadFailMessage || '读取新章失败' };
      }
      state.index = index;
      state.loadedChapterId = state.chapters[index] && state.chapters[index].id !== undefined
        ? state.chapters[index].id
        : null;
      return { ok: true };
    },
    renderStatsUi: () => log.push('renderStatsUi'),
    staleGuard,
    insertIntoBody: async (text) => {
      log.push('insertIntoBody');
      insertPayloads.push(text);
      if (typeof options.insertIntoBody === 'function') return options.insertIntoBody(text);
      if (options.insertFails) return { ok: false, message: '编辑器不可用' };
      return { ok: true, chars: capture.countChars(text) };
    },
    // 五-H5：可选成员 host.saveForTransition（统一「过渡前保存」原语）由用例按需注入；
    // 不注入时走原有 saveCurrent 路径，既有用例一字不改。
    ...(options.extraHost || {})
  };
  return { host, dom, state, api, log, commitPayloads, insertPayloads, queue };
}

const realDocument = globalThis.document;
test.after(() => {
  if (realDocument === undefined) delete globalThis.document;
  else globalThis.document = realDocument;
});

function withFakeDocument(fn) {
  global.document = {
    createElement: (tag) => makeEl(tag),
    createDocumentFragment: () => {
      const fragment = makeEl('fragment');
      fragment.isFragment = true;
      return fragment;
    }
  };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (realDocument === undefined) delete globalThis.document;
      else globalThis.document = realDocument;
    });
}

module.exports = {
  captureUiModule,
  backdropRegistry,
  moduleSrc,
  rendererSrc,
  notifyEventsSrc,
  recordEls,
  actionButtons,
  QUEUE_A,
  QUEUE_B,
  PENDING_TEXT,
  build,
  withFakeDocument,
  moduleCode,
  indexSrc,
  stylesSrc,
  rendererCode,
  hooksSrc,
  capture,
};
