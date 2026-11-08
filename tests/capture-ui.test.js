/* 剪贴板面板（2026-11-07 契约 v1：单列表视图）的自检。
 *
 * 行为：Node 里用假 DOM + 假 host 走真实流程——打开面板（队列 / 当前剪贴板 / 空剪贴板）→ 每条记录
 *   整块渲染 + 两个按钮 → 「正文」走 host.insertIntoBody（不写盘；成功后消费该条：pending 清内存、
 *   队列条目走 api.captureQueueRemove）→ 「章节」走
 *   api.captureCommitRecord（payload 正确、成功后换书目 / 刷统计 / 跳新章 / 重拉队列 / 记录消失）→
 *   busy 防重 / 失败保留 / 空队列与空剪贴板 toast。不碰真剪贴板、不写盘。
 * 契约：host 必须正好 9 个成员（契约 §5，新增 insertIntoBody），缺一个 create 当场 TypeError。
 * 静态闸门：面板实现只在 renderer/capture-ui.js（renderer.js 里不许再长回第二份）；
 *   index.html 只留列表视图 DOM + 脚本顺序；styles.css 换成 .capture-record*；Esc 走 captureUi.cancel()；
 *   列表点击委托接上「正文 / 章节」两个动作；test-hooks 钩子改成列表版。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const capture = require('../core/capture');

// T2 正在并行给 core/capture.js 加 recordPreview（契约 §3）：在它落地前的窗口期，这里按同一规则
// 垫一个仅测试用的实现，让本文件的其它断言可以先跑；T2 落地后自动走真实现（不覆盖已有函数）。
function fallbackRecordPreview(text, options = {}) {
  const source = typeof text === 'string' ? text.replace(/\r\n/g, '\n') : '';
  if (!source.trim()) return '';
  const maxChars = Number(options.maxChars) > 0 ? Math.round(options.maxChars) : 300;
  const maxLines = Number(options.maxLines) > 0 ? Math.round(options.maxLines) : 6;
  const allLines = source.split('\n');
  let out = allLines.slice(0, maxLines).join('\n');
  let truncated = allLines.length > maxLines;
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    truncated = true;
  }
  return truncated ? `${out}…` : out;
}
if (typeof capture.recordPreview !== 'function') capture.recordPreview = fallbackRecordPreview;

const captureUiModule = require('../renderer/capture-ui');

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
    set() {
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
    'conflict-backdrop'
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
      chars: source.length,
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
  const state = {
    view: options.view === undefined ? 'editor' : options.view,
    bookPath: options.bookPath === undefined ? '/tmp/books/书甲' : options.bookPath,
    meta: { title: '书甲', titleTemplate: '', chapters },
    chapters,
    index: options.index === undefined ? 1 : options.index,
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
      return { ok: true, data: { id: found.id, text: found.text, chars: found.chars, at: found.at } };
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
          statsError: null,
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
      state.index = index;
    },
    renderStatsUi: () => log.push('renderStatsUi'),
    insertIntoBody: async (text) => {
      log.push('insertIntoBody');
      insertPayloads.push(text);
      if (typeof options.insertIntoBody === 'function') return options.insertIntoBody(text);
      if (options.insertFails) return { ok: false, message: '编辑器不可用' };
      return { ok: true, chars: capture.countChars(text) };
    }
  };
  return { host, dom, state, api, log, commitPayloads, insertPayloads, queue };
}

const realDocument = globalThis.document;
test.after(() => {
  if (realDocument === undefined) delete globalThis.document;
  else globalThis.document = realDocument;
});

function withFakeDocument(fn) {
  global.document = { createElement: (tag) => makeEl(tag) };
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (realDocument === undefined) delete globalThis.document;
      else globalThis.document = realDocument;
    });
}

// ---------- 契约 ----------

test('契约：createCaptureUi 的 host 正好 9 个成员（含 insertIntoBody），缺一个当场 TypeError', () => {
  assert.deepEqual([...captureUiModule.REQUIRED_HOST].sort(), [
    '$',
    'api',
    'call',
    'insertIntoBody',
    'loadChapterAt',
    'renderStatsUi',
    'saveCurrent',
    'state',
    'toast'
  ]);
  assert.equal(captureUiModule.REQUIRED_HOST.length, 9, 'host 成员数按契约 §5 是 9 个');
  assert.throws(() => captureUiModule.create(null), /需要 host 对象/);
  for (const key of captureUiModule.REQUIRED_HOST) {
    const { host } = build();
    const broken = { ...host };
    delete broken[key];
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.throws(
      () => captureUiModule.create(broken),
      new RegExp(`缺少 ${escaped}`),
      `缺 ${key} 必须当场抛 TypeError`
    );
  }
  // 成员在但是 null / undefined 也算缺（渲染层忘了实现 insertIntoBody = 正文按钮点了没反应）
  for (const key of captureUiModule.REQUIRED_HOST) {
    const { host } = build();
    assert.throws(() => captureUiModule.create({ ...host, [key]: null }), /缺少/);
  }
});

test('契约：导出 API 齐全；旧逐行表单 API 全部删除；view() 恒为 list', () => {
  const ui = captureUiModule.create(build().host);
  for (const name of [
    'open',
    'openTriggered',
    'close',
    'cancel',
    'refreshQueue',
    'clearQueue',
    'applyBody',
    'createChapter',
    'setPosition',
    'position',
    'view',
    'queueItems',
    'queueSummaryText',
    'queueEmptyText',
    'isOpen',
    'isBusy',
    'records'
  ]) {
    assert.equal(typeof ui[name], 'function', `capture-ui 缺导出 ${name}`);
  }
  for (const removed of [
    'selectEntry',
    'selectPending',
    'backToQueue',
    'commit',
    'expand',
    'visibleLines',
    'titleText',
    'summaryText',
    'warningTexts',
    'setKind',
    'allAsBody',
    'commitDisabled'
  ]) {
    assert.equal(ui[removed], undefined, `旧表单 API ${removed} 必须删掉`);
  }
  assert.equal(ui.view(), 'list');
  assert.equal(ui.isOpen(), false);
  assert.equal(ui.isBusy(), false);
});

// ---------- 打开 ----------

test('打开：队列为空 → 现读剪贴板 → 列表 pending 一条（两个按钮 / 预览 / 空态隐藏）', () =>
  withFakeDocument(async () => {
    const ctx = build({ clipboardText: PENDING_TEXT });
    const ui = captureUiModule.create(ctx.host);
    const result = await ui.open();
    assert.equal(result.ok, true);
    assert.equal(result.view, 'list');
    assert.equal(result.pending, true);
    assert.equal(ui.isOpen(), true);
    assert.equal(ui.view(), 'list');
    assert.ok(ctx.log.includes('api.captureQueueList'));
    assert.ok(ctx.log.includes('api.captureClipboard'));
    assert.equal(ctx.log.some((item) => item.startsWith('api.captureQueueGet')), false, '打开列表不取正文');

    const records = ui.records();
    assert.equal(records.length, 1);
    assert.deepEqual(Object.keys(records[0]).sort(), ['chars', 'kind', 'previewText']);
    assert.equal(records[0].kind, 'pending');
    assert.equal(records[0].chars, PENDING_TEXT.length);
    assert.match(records[0].previewText, /^第7章 短触发/);

    assert.equal(ctx.dom.map.get('capture-backdrop').classList.contains('hidden'), false, '面板必须显示');
    assert.equal(ctx.dom.map.get('capture-queue-empty').classList.contains('hidden'), true);
    assert.equal(ui.queueEmptyText(), '');
    assert.match(ctx.dom.map.get('capture-queue-summary').textContent, /当前剪贴板一段（未入队）/);
    assert.match(ui.queueSummaryText(), /当前剪贴板一段（未入队）/);

    const rows = recordEls(ctx.dom);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.dataset.pending, '1');
    const head = row.children[0];
    assert.equal(head.children[0].textContent, '·');
    assert.match(head.children[1].textContent, /字/);
    assert.equal(head.children[2].textContent, '当前剪贴板');
    assert.equal(row.children[1].className, 'capture-record-text');
    assert.match(row.children[1].textContent, /第7章 短触发/);

    const buttons = actionButtons(ctx.dom);
    assert.equal(buttons.length, 2);
    assert.deepEqual(
      buttons.map((btn) => btn.textContent),
      ['正文', '章节']
    );
    assert.deepEqual(
      buttons.map((btn) => btn.dataset.action),
      ['body', 'chapter']
    );
    assert.deepEqual(
      buttons.map((btn) => btn.dataset.pending),
      ['1', '1']
    );
    assert.equal(buttons.every((btn) => btn.disabled), false);

    // b11：位置默认全书末尾；b9：导入入口默认隐藏；底栏可用
    assert.equal(ui.position(), 'end');
    assert.equal(ctx.dom.map.get('capture-position').value, 'end');
    assert.equal(ctx.dom.map.get('btn-capture-import').classList.contains('hidden'), true);
    assert.equal(ctx.dom.map.get('btn-capture-queue-clear').disabled, false);
    assert.equal(ctx.dom.map.get('btn-capture-queue-cancel').disabled, false);
  }));

test('打开：队列非空 → 直接列表（previewText 来自 list / 序号 / 字数 / 时间；不读剪贴板）', () =>
  withFakeDocument(async () => {
    const ctx = build({ queue: [{ text: QUEUE_A }, { text: QUEUE_B }] });
    const ui = captureUiModule.create(ctx.host);
    const result = await ui.open();
    assert.equal(result.ok, true);
    assert.equal(result.count, 2);
    assert.equal(ctx.log.includes('api.captureClipboard'), false, '队列非空不该再读剪贴板');

    const records = ui.records();
    assert.deepEqual(
      records.map((item) => item.kind),
      ['queue', 'queue']
    );
    assert.deepEqual(
      records.map((item) => item.id),
      [1, 2],
      '按复制顺序（旧 → 新）'
    );
    assert.equal(records[0].chars, QUEUE_A.length);
    assert.equal(records[0].previewText, capture.recordPreview(QUEUE_A));

    const rows = recordEls(ctx.dom);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].dataset.id, '1');
    const head = rows[0].children[0];
    assert.equal(head.children[0].textContent, '1', '序号从 1 起');
    assert.match(head.children[1].textContent, /字 · \d{2}:\d{2}/, '元信息 = 字数 · 时间');
    assert.equal(head.children[2], undefined, '队列条目没有「当前剪贴板」徽标');
    const buttons = actionButtons(ctx.dom).slice(0, 2);
    assert.deepEqual(
      buttons.map((btn) => btn.dataset.id),
      ['1', '1']
    );
    assert.equal('pending' in buttons[0].dataset, false);
    assert.match(ui.queueSummaryText(), /本次运行共记了 2 段/);
    assert.equal(ctx.dom.map.get('capture-queue-empty').classList.contains('hidden'), true);
  }));

test('打开：传入原文 → 只有 pending 一条；空白原文 / 空剪贴板 toast 且不开面板', () =>
  withFakeDocument(async () => {
    const ctx = build({ queue: [{ text: QUEUE_A }] });
    const ui = captureUiModule.create(ctx.host);
    const result = await ui.open('第9章 直接给\n\n正文');
    assert.equal(result.ok, true);
    assert.equal(result.pending, true);
    assert.equal(ctx.log.includes('api.captureQueueList'), false, '传了原文只看 pending，不抢队列');
    assert.equal(ctx.log.includes('api.captureClipboard'), false);
    assert.deepEqual(
      ui.records().map((item) => item.kind),
      ['pending']
    );

    const emptyArg = build();
    const uiEmptyArg = captureUiModule.create(emptyArg.host);
    assert.equal((await uiEmptyArg.open('   \r\n  ')).code, 'EMPTY_CLIPBOARD');
    assert.equal(uiEmptyArg.isOpen(), false);

    const emptyClip = build({ clipboardText: '   \r\n\r\n' });
    const uiEmptyClip = captureUiModule.create(emptyClip.host);
    assert.equal((await uiEmptyClip.open()).code, 'EMPTY_CLIPBOARD');
    assert.equal(uiEmptyClip.isOpen(), false);
    assert.ok(emptyClip.log.some((item) => item.startsWith('toast:warn:剪贴板里没有文字')));
  }));

test('打开：没打开书 / 别的弹层挡着 → 预检拦下；已开着再开 → ALREADY_OPEN；beforeOpen 时机不变', () =>
  withFakeDocument(async () => {
    const noBook = build({ view: 'shelf', bookPath: null });
    const uiNoBook = captureUiModule.create(noBook.host);
    assert.equal((await uiNoBook.open('正文')).code, 'NO_BOOK');

    const blocked = build();
    blocked.dom.map.get('settings-backdrop').classList.remove('hidden');
    const uiBlocked = captureUiModule.create(blocked.host);
    let beforeOpenCalls = 0;
    const blockedResult = await uiBlocked.open('正文', {
      beforeOpen: () => {
        beforeOpenCalls += 1;
      }
    });
    assert.equal(blockedResult.code, 'PANEL_BUSY');
    assert.equal(beforeOpenCalls, 0, '被挡时不该收起顶栏菜单');

    const normal = build();
    const uiNormal = captureUiModule.create(normal.host);
    let opens = 0;
    await uiNormal.open('正文', {
      beforeOpen: () => {
        opens += 1;
      }
    });
    assert.equal(opens, 1, '正常打开前要收起顶栏菜单');
    assert.equal((await uiNormal.open('正文')).code, 'ALREADY_OPEN');
  }));

test('openTriggered：未入队 + 队列非空 → pending 一条 + 队列条目；已入队 → 不重复 pending', () =>
  withFakeDocument(async () => {
    const ctx = build({ queue: [{ text: QUEUE_A }] });
    const ui = captureUiModule.create(ctx.host);
    const result = await ui.openTriggered(PENDING_TEXT, false);
    assert.equal(result.ok, true);
    assert.equal(result.view, 'list');
    assert.equal(result.queued, false);
    assert.deepEqual(
      ui.records().map((item) => item.kind),
      ['pending', 'queue']
    );
    assert.equal(recordEls(ctx.dom).length, 2);
    assert.equal(recordEls(ctx.dom)[0].dataset.pending, '1');

    const queuedCtx = build({ queue: [{ text: QUEUE_A }] });
    const uiQueued = captureUiModule.create(queuedCtx.host);
    const queuedResult = await uiQueued.openTriggered(QUEUE_A, true);
    assert.equal(queuedResult.queued, true);
    assert.deepEqual(
      uiQueued.records().map((item) => item.kind),
      ['queue'],
      '已入队的触发不再重复显示「当前剪贴板」'
    );
  }));

test('openTriggered：队列空 + 未入队 → 仍是列表 pending（不再回旧直捕表单）；没给原文才读剪贴板', () =>
  withFakeDocument(async () => {
    const ctx = build();
    const ui = captureUiModule.create(ctx.host);
    const result = await ui.openTriggered('第1章 撞见了幽灵\n\n直捕正文', false);
    assert.equal(result.ok, true);
    assert.equal(result.view, 'list');
    assert.equal(ui.view(), 'list');
    assert.equal(ui.records()[0].kind, 'pending');
    assert.equal(ctx.log.includes('api.captureClipboard'), false, '触发时原文已给，不该再读剪贴板');

    const noText = build({ clipboardText: QUEUE_A });
    const uiNoText = captureUiModule.create(noText.host);
    await uiNoText.openTriggered(undefined, false);
    assert.equal(uiNoText.records()[0].kind, 'pending');
    assert.ok(noText.log.includes('api.captureClipboard'));
  }));

// ---------- 正文 ----------

test('正文：队列条目 → queue-get 取原文 → insertIntoBody → 消费该条（captureQueueRemove）；不写盘、面板不关', () =>
  withFakeDocument(async () => {
    const ctx = build({ queue: [{ text: QUEUE_A }, { text: QUEUE_B }] });
    const ui = captureUiModule.create(ctx.host);
    await ui.open();
    const result = await ui.applyBody({ id: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.consumed, true, '结果要标记这条已被消费');
    assert.equal(ctx.log.filter((item) => item === 'api.captureQueueGet:1').length, 1);
    assert.deepEqual(ctx.insertPayloads, [QUEUE_A], '插的是这一条队列正文');
    assert.equal(ctx.commitPayloads.length, 0, '正文按钮绝不走写盘 IPC');
    assert.equal(ctx.log.filter((item) => item === 'api.captureQueueRemove:1').length, 1, '插入成功后消费这一条');
    assert.equal(ctx.queue.length, 1, '被消费的那条从队列删除');
    assert.equal(ctx.queue[0].id, 2, '只删这一条');
    assert.equal(ui.isOpen(), true, '面板保持打开');
    assert.equal(ui.isBusy(), false);
    assert.deepEqual(
      ui.records().map((item) => item.id),
      [2],
      '列表里只剩另一条'
    );
    assert.ok(ctx.log.some((item) => item.startsWith('toast:info:已插入正文')));
  }));

test('正文：pending 条目 → 直接用当前剪贴板原文，不走队列 IPC；成功后记录消失', () =>
  withFakeDocument(async () => {
    const ctx = build({ clipboardText: PENDING_TEXT });
    const ui = captureUiModule.create(ctx.host);
    await ui.open();
    const result = await ui.applyBody({ pending: true });
    assert.equal(result.ok, true);
    assert.equal(result.consumed, true);
    assert.deepEqual(ctx.insertPayloads, [PENDING_TEXT]);
    assert.equal(ctx.log.some((item) => item.startsWith('api.captureQueueGet')), false);
    assert.equal(ctx.log.some((item) => item.startsWith('api.captureQueueRemove')), false, 'pending 不碰队列 IPC');
    assert.equal(ui.isOpen(), true);
    assert.equal(ui.records().length, 0, 'pending 记录消失');
    assert.equal(ctx.dom.map.get('capture-queue-empty').classList.contains('hidden'), false, '空态提示出现');
    assert.ok(ctx.log.some((item) => item.startsWith('toast:info:已插入正文')));
  }));

test('正文：消费 IPC 失败 → 插入仍算成功，本地列表兜底去掉这一条（不让它被重复插入）', () =>
  withFakeDocument(async () => {
    const ctx = build({ queue: [{ text: QUEUE_A }, { text: QUEUE_B }], removeFails: true });
    const ui = captureUiModule.create(ctx.host);
    await ui.open();
    const result = await ui.applyBody({ id: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.consumed, true);
    assert.ok(ctx.log.includes('api.captureQueueRemove:1'));
    assert.equal(ctx.queue.length, 2, '模拟主进程没删掉');
    assert.equal(ui.isOpen(), true);
    assert.equal(ui.isBusy(), false);
    assert.deepEqual(
      ui.records().map((item) => item.id),
      [2],
      '本地兜底：正文已经进编辑区，列表里不能再留着这条'
    );
  }));

test('正文：insertIntoBody 失败 → 保留记录 + toast error + 解锁', () =>
  withFakeDocument(async () => {
    const ctx = build({ queue: [{ text: QUEUE_A }], insertFails: true });
    const ui = captureUiModule.create(ctx.host);
    await ui.open();
    const result = await ui.applyBody({ id: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INSERT_FAILED');
    assert.equal(ui.isOpen(), true);
    assert.equal(ui.isBusy(), false, '失败后必须解锁');
    assert.equal(ctx.queue.length, 1, '失败不消费记录');
    assert.equal(ctx.log.some((item) => item.startsWith('api.captureQueueRemove')), false, '失败不许删队列');
    assert.ok(ctx.log.some((item) => item.startsWith('toast:error:插入正文失败：编辑器不可用')));
  }));

test('正文：处理中所有动作按钮 / 清空 / 取消全禁用，重复点击返回 BUSY（防重）', () =>
  withFakeDocument(async () => {
    let release;
    const ctx = build({ queue: [{ text: QUEUE_A }] });
    ctx.host.insertIntoBody = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const ui = captureUiModule.create(ctx.host);
    await ui.open();
    const first = ui.applyBody({ id: 1 });
    // 同步段已置 busy：按钮应立刻禁用
    assert.equal(ui.isBusy(), true);
    assert.deepEqual(
      actionButtons(ctx.dom).map((btn) => btn.disabled),
      [true, true]
    );
    assert.equal(ctx.dom.map.get('btn-capture-queue-clear').disabled, true);
    assert.equal(ctx.dom.map.get('btn-capture-queue-cancel').disabled, true);
    assert.equal((await ui.applyBody({ id: 1 })).code, 'BUSY');
    assert.equal((await ui.createChapter({ pending: true })).code, 'BUSY', '处理中不许再建章');
    assert.equal(ctx.commitPayloads.length, 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ctx.log.filter((item) => item === 'api.captureQueueGet:1').length, 1, '重复点击不该再取一次正文');
    release({ ok: true, chars: 10 });
    const firstResult = await first;
    assert.equal(firstResult.ok, true);
    assert.equal(ui.isBusy(), false);
    // 成功后会消费这一条：列表清空、没有可点的动作按钮，清空按钮回到禁用
    assert.deepEqual(actionButtons(ctx.dom), []);
    assert.equal(ctx.dom.map.get('btn-capture-queue-clear').disabled, true);
  }));

test('正文：记录已被消费 → toast + 重新拉队列（列表跟着变），面板不关', () =>
  withFakeDocument(async () => {
    const ctx = build({ queue: [{ text: QUEUE_A }, { text: QUEUE_B }] });
    const ui = captureUiModule.create(ctx.host);
    await ui.open();
    // 模拟主进程那边这条已经没了（例如另一个窗口先捕获了）
    const index = ctx.queue.findIndex((item) => item.id === 1);
    ctx.queue.splice(index, 1);
    const result = await ui.applyBody({ id: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'QUEUE_MISSING');
    assert.ok(ctx.log.some((item) => item.startsWith('toast:warn:这条复制记录已经不在了')));
    assert.equal(ui.isOpen(), true);
    assert.equal(ui.isBusy(), false);
    assert.deepEqual(
      ui.records().map((item) => item.id),
      [2],
      '重新拉队列后那条消失'
    );
    assert.equal(ctx.insertPayloads.length, 0);
  }));

// ---------- 章节 ----------

test('章节：pending 成功 → payload 正确 / 换书目 / 刷统计 / 跳新章 / 重拉队列 / 面板不关 / 记录消失', () =>
  withFakeDocument(async () => {
    const ctx = build({ clipboardText: PENDING_TEXT });
    const ui = captureUiModule.create(ctx.host);
    await ui.open();
    const listCallsBefore = ctx.log.filter((item) => item === 'api.captureQueueList').length;
    const result = await ui.createChapter({ pending: true });
    assert.equal(result.ok, true);

    assert.equal(ctx.commitPayloads.length, 1);
    const payload = ctx.commitPayloads[0];
    assert.equal(payload.text, PENDING_TEXT);
    assert.equal('queueId' in payload, false, '直捕不带 queueId');
    assert.equal(payload.insertIndex, 2, '默认全书末尾（打开时共 2 章）');
    assert.equal(payload.volumeId, null);

    // 顺序：写盘 → 刷新统计 → 载入新章 → 重新拉队列
    const commitAt = ctx.log.findIndex((item) => item.startsWith('api.captureCommitRecord'));
    assert.ok(commitAt >= 0, '必须调用新写盘 IPC');
    const statsAt = ctx.log.indexOf('renderStatsUi');
    const loadAt = ctx.log.indexOf('loadChapterAt:2');
    assert.ok(statsAt > commitAt, '写盘后刷新统计');
    assert.ok(loadAt > commitAt, '写盘后载入新章');
    assert.equal(statsAt < loadAt, true, '先刷统计再跳章');
    const listCalls = ctx.log.map((value, index) => ({ value, index })).filter((item) => item.value === 'api.captureQueueList');
    assert.equal(listCalls.length, listCallsBefore + 1, '成功后要重新拉一次队列');
    assert.ok(listCalls[listCalls.length - 1].index > loadAt, '重拉队列在跳新章之后');

    // 状态
    assert.equal(ctx.state.meta.chapters.length, 3);
    assert.equal(ctx.state.chapters.length, 3);
    assert.equal(ctx.state.stats.today, 100);
    assert.equal(ctx.state.streak, 3);
    assert.equal(ctx.state.index, 2);

    // 面板：保持打开、记录消失、不解锁前不关
    assert.equal(ui.isOpen(), true, '面板保持打开');
    assert.equal(ui.isBusy(), false);
    assert.deepEqual(ui.records(), [], '被消费的 pending 记录消失');
    assert.equal(ctx.dom.map.get('capture-backdrop').classList.contains('hidden'), false);
    assert.ok(ctx.log.some((item) => item.startsWith('toast:info:已从剪贴板新建：')));
  }));

test('章节：titleOnly（整条当章名、没有正文）→ toast 标「仅章名」，不把章名字数报成正文字数', () =>
  withFakeDocument(async () => {
    const ctx = build({ clipboardText: '短标题的一段话', titleOnly: true });
    const ui = captureUiModule.create(ctx.host);
    await ui.open();
    const result = await ui.createChapter({ pending: true });
    assert.equal(result.ok, true);
    assert.equal(result.titleOnly, true);
    assert.equal(result.chars, 0, 'titleOnly 的正文字数是 0');
    const toastLine = ctx.log.find((item) => item.startsWith('toast:info:已从剪贴板新建：'));
    assert.ok(toastLine, '要有成功 toast');
    assert.match(toastLine, /（仅章名）/, 'titleOnly 文案要标「仅章名」');
    assert.equal(/\d+ 字/.test(toastLine), false, '不能把章名字数当正文字数报出去');
  }));

test('章节：队列条目成功 → payload 带 queueId、被消费的记录消失、其余记录保留、面板不关', () =>
  withFakeDocument(async () => {    const ctx = build({ queue: [{ text: QUEUE_A }, { text: QUEUE_B }] });
    const ui = captureUiModule.create(ctx.host);
    await ui.open();
    const result = await ui.createChapter({ id: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.queueRemoved, true);
    assert.equal(ctx.commitPayloads[0].queueId, 1);
    assert.equal(ctx.commitPayloads[0].text, QUEUE_A);
    assert.equal(ctx.queue.length, 1, '主进程写章成功后才删掉这一条');
    assert.deepEqual(
      ui.records().map((item) => item.id),
      [2],
      '列表重画后只剩另一条'
    );
    assert.equal(recordEls(ctx.dom).length, 1);
    assert.equal(ui.isOpen(), true);
    assert.equal(ui.isBusy(), false);
  }));

test('章节：dirty 先 saveCurrent；保存失败就中止，记录保留、不写盘', () =>
  withFakeDocument(async () => {
    const okCtx = build({ dirty: true, commitBodyChars: 42 });
    const uiOk = captureUiModule.create(okCtx.host);
    await uiOk.open('正文一段');
    await uiOk.createChapter({ pending: true });
    const saveAt = okCtx.log.indexOf('saveCurrent');
    const commitAt = okCtx.log.findIndex((item) => item.startsWith('api.captureCommitRecord'));
    assert.ok(saveAt >= 0, 'dirty 时必须先保存当前章');
    assert.ok(saveAt < commitAt, '保存要在写盘之前');

    const failCtx = build({ dirty: true, saveOk: false });
    const uiFail = captureUiModule.create(failCtx.host);
    await uiFail.open('正文一段');
    const failed = await uiFail.createChapter({ pending: true });
    assert.equal(failed.ok, false);
    assert.equal(failCtx.commitPayloads.length, 0, '保存失败不许写盘');
    assert.equal(uiFail.isOpen(), true);
    assert.equal(uiFail.isBusy(), false);
    assert.deepEqual(
      uiFail.records().map((item) => item.kind),
      ['pending'],
      '失败保留记录'
    );
  }));

test('章节：写盘失败 → toast error、记录保留、面板不关、不载入章节', () =>
  withFakeDocument(async () => {
    const ctx = build({ queue: [{ text: QUEUE_A }], commitFails: true });
    const ui = captureUiModule.create(ctx.host);
    await ui.open();
    const result = await ui.createChapter({ id: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'WRITE_FAIL');
    assert.equal(ctx.log.some((item) => item.startsWith('loadChapterAt')), false, '失败不该载入任何章节');
    assert.equal(ui.isOpen(), true);
    assert.equal(ui.isBusy(), false, '失败后必须解锁（还能再点一次）');
    assert.equal(ctx.queue.length, 1, '记录保留');
    assert.equal(recordEls(ctx.dom).length, 1);
    assert.ok(ctx.log.some((item) => item.startsWith('toast:error:新建章节失败：磁盘只读')));
  }));

test('章节：直捕 >10 万字 → 不调写盘 IPC、toast + 显示「去导入小说…」；普通捕获不显示', () =>
  withFakeDocument(async () => {
    const huge = '字'.repeat(capture.MAX_BODY_CHARS + 10);
    const ctx = build({ clipboardText: huge });
    const ui = captureUiModule.create(ctx.host);
    await ui.open();
    const result = await ui.createChapter({ pending: true });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TOO_LARGE');
    assert.equal(ctx.commitPayloads.length, 0, '超限不调 IPC');
    assert.equal(ui.isOpen(), true);
    assert.equal(ctx.dom.map.get('btn-capture-import').classList.contains('hidden'), false, '超限时显示导入入口');
    assert.ok(ctx.log.some((item) => item.startsWith('toast:warn:内容太长')));
    assert.deepEqual(
      ui.records().map((item) => item.kind),
      ['pending'],
      '超限时记录保留'
    );

    const normal = build({ clipboardText: PENDING_TEXT });
    const uiNormal = captureUiModule.create(normal.host);
    await uiNormal.open();
    assert.equal(normal.dom.map.get('btn-capture-import').classList.contains('hidden'), true);
  }));

test('插入位置：默认全书末尾 / after-current 用当前章下标 +1 并跟随卷；每次打开回默认', () =>
  withFakeDocument(async () => {
    const chapters = [
      { name: '第一章', volumeId: 'vol-1' },
      { name: '第二章', volumeId: null },
      { name: '第三章', volumeId: 'vol-2' }
    ];
    assert.deepEqual(captureUiModule.computeInsertTarget(chapters, 1, 'end'), { insertIndex: 3, volumeId: null });
    assert.deepEqual(captureUiModule.computeInsertTarget(chapters, 1, 'after-current'), {
      insertIndex: 2,
      volumeId: null
    });
    assert.deepEqual(captureUiModule.computeInsertTarget(chapters, 0, 'after-current'), {
      insertIndex: 1,
      volumeId: 'vol-1'
    });
    // 越界 / 空书 / 坏输入一律回退「全书末尾」
    assert.deepEqual(captureUiModule.computeInsertTarget(chapters, 99, 'after-current'), {
      insertIndex: 3,
      volumeId: null
    });
    assert.deepEqual(captureUiModule.computeInsertTarget([], 0, 'after-current'), { insertIndex: 0, volumeId: null });

    const ctx = build({ chapters });
    const ui = captureUiModule.create(ctx.host);
    await ui.open('正文一段');
    assert.equal(ui.position(), 'end');
    assert.equal(ctx.dom.map.get('capture-position').value, 'end');
    assert.equal(ui.setPosition('after-current'), 'after-current');
    assert.equal(ctx.dom.map.get('capture-position').value, 'after-current');
    await ui.createChapter({ pending: true });
    assert.equal(ctx.commitPayloads[0].insertIndex, 2);
    assert.equal(ctx.commitPayloads[0].volumeId, null, '当前章（第二章）没有卷');

    // 关掉再打开：位置回默认；当前章有卷时卷跟随当前章
    ui.close();
    await ui.open('正文两段');
    assert.equal(ui.position(), 'end', '每次打开都回到默认「全书末尾」');
    ctx.state.index = 0;
    ui.setPosition('after-current');
    await ui.createChapter({ pending: true });
    assert.equal(ctx.commitPayloads[1].insertIndex, 1);
    assert.equal(ctx.commitPayloads[1].volumeId, 'vol-1');
    assert.equal(ui.setPosition('not-a-mode'), 'end', '非法值按默认处理');
  }));

// ---------- 队列维护 / 关闭 ----------

test('清空队列：调 IPC、列表清空、空态文案、面板不关、清空按钮禁用', () =>
  withFakeDocument(async () => {
    const ctx = build({ queue: [{ text: QUEUE_A }, { text: QUEUE_B }] });
    const ui = captureUiModule.create(ctx.host);
    await ui.open();
    const result = await ui.clearQueue();
    assert.equal(result.ok, true);
    assert.ok(ctx.log.includes('api.captureQueueClear'));
    assert.equal(ui.records().length, 0);
    assert.equal(ui.isOpen(), true, '清空只清队列，不关面板');
    assert.match(ui.queueSummaryText(), /还没有记到/);
    const empty = ctx.dom.map.get('capture-queue-empty');
    assert.equal(empty.classList.contains('hidden'), false);
    assert.match(empty.textContent, /后台监听/);
    assert.equal(ctx.dom.map.get('btn-capture-queue-clear').disabled, true, '空列表时清空按钮禁用');
    assert.ok(ctx.log.some((item) => item.startsWith('toast:info:已清空本次运行的捕获队列')));
  }));

test('refreshQueue：新复制进来原地刷新（pending 保留）；面板没开不调 IPC', () =>
  withFakeDocument(async () => {
    const ctx = build({ queue: [{ text: QUEUE_A }] });
    const ui = captureUiModule.create(ctx.host);
    await ui.openTriggered(PENDING_TEXT, false);
    ctx.queue.push({ id: 9, text: QUEUE_B, chars: QUEUE_B.length, at: 1762350000000 });
    await ui.refreshQueue();
    assert.deepEqual(
      ui.records().map((item) => item.kind),
      ['pending', 'queue', 'queue']
    );
    assert.deepEqual(
      ui.records()
        .filter((item) => item.kind === 'queue')
        .map((item) => item.id),
      [1, 9]
    );
    assert.equal(recordEls(ctx.dom).length, 3);

    const closedCtx = build();
    const uiClosed = captureUiModule.create(closedCtx.host);
    const before = closedCtx.log.length;
    await uiClosed.refreshQueue();
    assert.equal(closedCtx.log.length, before, '面板没开就不该调 IPC');
  }));

test('cancel / close：空闲关面板并重置；处理中拒绝关闭；下次打开位置回默认', () =>
  withFakeDocument(async () => {
    let release;
    const ctx = build({ queue: [{ text: QUEUE_A }] });
    ctx.host.insertIntoBody = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const ui = captureUiModule.create(ctx.host);
    await ui.open();
    const inFlight = ui.applyBody({ id: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ui.cancel().code, 'BUSY', '处理中不允许关');
    release({ ok: true, chars: 5 });
    await inFlight;
    assert.equal(ui.cancel().ok, true);
    assert.equal(ui.isOpen(), false);
    assert.equal(ctx.dom.map.get('capture-backdrop').classList.contains('hidden'), true);
    assert.equal(ui.view(), 'list', '视图恒为 list（哪怕关着）');
    assert.equal((await ui.cancel()).code, 'CLOSED');

    await ui.open('新一段');
    assert.equal(ui.position(), 'end');
    assert.deepEqual(
      ui.records().map((item) => item.kind),
      ['pending']
    );
  }));

test('records()：pending 预览走 recordPreview（≤300 字 / ≤6 行 / 末尾省略号）', () =>
  withFakeDocument(async () => {
    const text = Array.from({ length: 12 }, (_, index) => `第${index + 1}行${'字'.repeat(60)}`).join('\n');
    const ctx = build();
    const ui = captureUiModule.create(ctx.host);
    await ui.open(text);
    const pending = ui.records()[0];
    assert.equal(pending.kind, 'pending');
    assert.ok(pending.previewText.startsWith('第1行'), '保留开头');
    assert.ok(pending.previewText.endsWith('…'), '截断要加省略号');
    assert.ok(pending.previewText.split('\n').length <= 6, '最多 6 行');
    assert.ok(pending.previewText.length <= 301, '最多 300 字 + 省略号');
  }));

// ---------- 静态闸门 ----------

test('静态闸门：index.html 只留列表视图 DOM，必要 id 都在、旧表单 id 全删、脚本顺序不变', () => {
  for (const id of [
    'capture-backdrop',
    'capture-title',
    'capture-queue-view',
    'capture-queue-summary',
    'capture-position',
    'capture-queue-list',
    'capture-queue-empty',
    'btn-capture-import',
    'btn-capture-queue-clear',
    'btn-capture-queue-cancel'
  ]) {
    assert.ok(indexSrc.includes(`id="${id}"`), `index.html 缺 #${id}`);
  }
  for (const id of [
    'capture-form-view',
    'capture-summary',
    'capture-warnings',
    'capture-title-count',
    'capture-lines',
    'capture-list-note',
    'capture-list-head',
    'btn-capture-expand',
    'btn-capture-back',
    'btn-capture-all-body',
    'btn-capture-commit',
    'btn-capture-cancel'
  ]) {
    assert.equal(indexSrc.includes(`id="${id}"`), false, `旧表单 #${id} 必须删掉`);
  }
  assert.match(indexSrc, /<h2 class="modal-title" id="capture-title">剪贴板<\/h2>/);
  assert.match(indexSrc, /<div id="capture-queue-list" class="capture-record-list" role="list">/);
  assert.match(indexSrc, /<option value="end">全书末尾（默认）<\/option>/);
  assert.match(indexSrc, /<option value="after-current">当前章之后<\/option>/);
  assert.match(indexSrc, /<button id="btn-capture-import" class="btn ghost hidden"/);
  assert.equal(/id="capture-queue-view"[^>]*hidden/.test(indexSrc), false, '列表视图是唯一视图，不该默认隐藏');

  const at = (needle) => {
    const index = indexSrc.indexOf(needle);
    assert.notEqual(index, -1, `index.html 里找不到 ${needle}`);
    return index;
  };
  assert.ok(at('../core/chapters.js') < at('../core/capture.js'), 'capture.js 要用 chapters.js 的字数 / 常量');
  assert.ok(at('../core/capture.js') < at('capture-ui.js'), 'capture-ui 要先拿到 window.CWCapture');
  assert.ok(at('capture-ui.js') < at('renderer.js'), 'capture-ui.js 必须在 renderer.js 之前加载');
});

test('静态闸门：styles.css 换成 .capture-record* 列表样式，旧表单 / 旧队列行样式删净', () => {
  for (const cls of [
    'capture-record-list',
    'capture-record-head',
    'capture-record-text',
    'capture-record-actions',
    'capture-record-no',
    'capture-record-meta',
    'capture-record-badge'
  ]) {
    assert.match(stylesSrc, new RegExp(`\\.${cls}\\s*\\{`), `styles.css 缺 .${cls}`);
  }
  assert.match(stylesSrc, /\.capture-record\s*\{/, 'styles.css 缺 .capture-record');
  assert.match(stylesSrc, /\.capture-record-list\s*\{[^}]*max-height:\s*46vh/, '列表最大高度按契约 46vh');
  for (const old of [
    'capture-line',
    'capture-tag',
    'capture-form-view',
    'capture-list-head',
    'capture-lines',
    'capture-list-foot',
    'capture-hint',
    'capture-warnings',
    'capture-warning',
    'capture-queue-item',
    'capture-queue-no',
    'capture-queue-meta',
    'capture-queue-preview',
    'capture-queue-pending'
  ]) {
    assert.equal(new RegExp(`\\.${old}\\b`).test(stylesSrc), false, `styles.css 里旧样式 .${old} 应已删除`);
  }
  assert.equal(/#capture-title-count/.test(stylesSrc), false);

  const start = stylesSrc.indexOf('/* ---------- 剪贴板（P0）：单列表视图');
  const end = stylesSrc.indexOf('/* ---------- 章节拖拽排序');
  assert.ok(start >= 0 && end > start, 'styles.css 里找不到新的剪贴板样式段');
  const block = stylesSrc.slice(start, end);
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(block), false, '颜色只能走现有 CSS 变量，不新造令牌');
  assert.equal(/rgba?\(|hsla?\(/.test(block), false, '颜色只能走现有 CSS 变量，不新造令牌');
});

test('静态闸门：renderer.js 只接线（9 成员 host / 列表委托 / 插入位置 / 导入 / Esc / 刷新）', () => {
  const createBlock = /const captureUi = captureUiModule\.create\(\{([\s\S]{0,400}?)\}\);/.exec(rendererSrc);
  assert.ok(createBlock, 'renderer.js 里找不到 captureUiModule.create({...})');
  assert.match(createBlock[1], /\$\s*,/, 'captureUi.create 缺 $');
  for (const key of [
    'state',
    'api',
    'call',
    'toast',
    'saveCurrent',
    'loadChapterAt',
    'renderStatsUi',
    'insertIntoBody'
  ]) {
    assert.match(createBlock[1], new RegExp(`\\b${key}\\b`), `captureUi.create 缺 ${key}`);
  }
  // insertIntoBody 有真实实现（不只是把名字交给模块）
  assert.match(
    rendererSrc,
    /function insertIntoBody\(|const insertIntoBody\s*=|insertIntoBody:\s*(?:async\s*)?\(/,
    'renderer.js 缺 insertIntoBody 实现'
  );

  // 列表点击委托：两个动作 + 两种 ref
  const listBind = rendererSrc.indexOf("$('capture-queue-list').addEventListener('click'");
  assert.notEqual(listBind, -1, '缺 #capture-queue-list 点击委托');
  const delegate = rendererSrc.slice(listBind, listBind + 800);
  for (const needle of [
    'data-action',
    'captureUi.applyBody(',
    'captureUi.createChapter(',
    'dataset.pending',
    'dataset.id'
  ]) {
    assert.ok(delegate.includes(needle), `列表委托里缺 ${needle}`);
  }
  // 底栏 / 插入位置 / 导入
  assert.match(rendererSrc, /\$\('btn-capture-queue-clear'\)\.addEventListener\('click'/);
  assert.match(rendererSrc, /\$\('btn-capture-queue-cancel'\)\.addEventListener\('click'/);
  assert.match(
    rendererSrc,
    /\$\('capture-position'\)\.addEventListener\('change', \(\) => \{[\s\S]{0,160}?captureUi\.setPosition\(/
  );
  assert.match(
    rendererSrc,
    /\$\('btn-capture-import'\)\.addEventListener\('click', \(\) => \{[\s\S]{0,260}?captureUi\.close\(\);[\s\S]{0,140}?backToShelf\(\)[\s\S]{0,80}?onImportClick\(\)/,
    '去导入小说要：关面板 → 回书架 → 打开导入对话框'
  );
  // Esc：确认取消路径走 captureUi.cancel()（处理中不许关），不再直接 close
  const escCapture = /'close-capture': \(\) => \{([\s\S]{0,180}?)\},/.exec(rendererSrc);
  assert.ok(escCapture, 'renderer.js 里找不到 close-capture 动作');
  assert.match(escCapture[1], /captureUi\.cancel\(\)/, 'Esc 要走 cancel');
  assert.equal(/captureUi\.close\(\)/.test(escCapture[1]), false, 'Esc 不许再直接 close');
  // 剪贴板变化：面板开着就刷新（单列表视图不再区分 view）
  assert.match(
    rendererSrc,
    /if \(captureUi\.isOpen\(\)\) \{[\s\S]{0,200}?captureUi\.refreshQueue\(\)/,
    '面板开着时新复制要原地刷新列表'
  );
  assert.equal(rendererSrc.includes('captureUi.view() ==='), false, '单列表视图不该再判断 view');
  // 旧表单绑定全删
  for (const old of [
    'btn-capture-commit',
    'btn-capture-all-body',
    'btn-capture-back',
    'btn-capture-expand',
    'btn-capture-cancel',
    'captureUi.selectEntry(',
    'captureUi.selectPending(',
    'captureUi.commit(',
    'captureUi.allAsBody(',
    'captureUi.expand(',
    'captureUi.backToQueue('
  ]) {
    assert.equal(rendererSrc.includes(old), false, `renderer.js 里旧接线还在：${old}`);
  }
});

test('静态闸门：面板实现只在 renderer/capture-ui.js，renderer.js 不许长回第二份', () => {
  assert.ok(moduleSrc.includes('function createCaptureUi(host)'), '模块必须交出 createCaptureUi(host)');
  assert.ok(
    moduleSrc.includes('root.CWCaptureUi = factory(root.CWChapters, root.CWCapture, root.CWCommon)'),
    '浏览器挂载口径'
  );
  assert.ok(moduleSrc.includes('REQUIRED_HOST'), '必须有 host 契约清单');
  for (const forbidden of [
    'capture-record',
    'capture-line',
    'capture-tag',
    'capture-form-view',
    'captureWarnings',
    'renderCapturePanel',
    'visibleLines',
    'composeBody',
    'analyzeCapture',
    'prepareCaptureCommit',
    'state.capture'
  ]) {
    assert.equal(rendererCode.includes(forbidden), false, `renderer.js 里不该再有 ${forbidden}（面板实现要留在模块里）`);
  }
});

test('静态闸门：test-hooks 钩子改成列表版（applyBody / createChapter / records），旧表单钩子全删', () => {
  for (const name of [
    'openCapture',
    'closeCapture',
    'captureOpen',
    'captureQueue',
    'captureQueueClear',
    'captureView',
    'captureApplyBody',
    'captureCreateChapter',
    'captureRecords'
  ]) {
    assert.ok(hooksSrc.includes(name), `renderer/test-hooks.js 缺 ${name}`);
  }
  assert.match(hooksSrc, /captureApplyBody[\s\S]{0,100}?captureUi\.applyBody\(/, 'captureApplyBody 要转调 applyBody');
  assert.match(
    hooksSrc,
    /captureCreateChapter[\s\S]{0,100}?captureUi\.createChapter\(/,
    'captureCreateChapter 要转调 createChapter'
  );
  assert.match(hooksSrc, /captureRecords[\s\S]{0,100}?captureUi\.records\(/, 'captureRecords 要转调 records');
  assert.match(hooksSrc, /captureView: \(\) => captureUi\.view\(\)/, 'captureView 恒 list');
  for (const old of [
    'captureLines',
    'captureTitle',
    'captureSummary',
    'captureWarningTexts',
    'setCaptureKind',
    'setAllCaptureBody',
    'commitCapture',
    'captureCommitDisabled',
    'captureSelectEntry'
  ]) {
    assert.equal(hooksSrc.includes(old), false, `旧表单钩子 ${old} 应删除`);
  }
});

test('静态闸门：模块不碰 Electron / 文件系统 / localStorage，只走白名单 IPC', () => {
  for (const forbidden of [
    "require('electron')",
    'ipcRenderer',
    'node:fs',
    'document.getElementById',
    'clipboard.read',
    'localStorage',
    'setInterval',
    'analyzeCapture',
    'commitCapture',
    'prepareCaptureCommit',
    'composeBody',
    'selectEntry',
    'selectPending',
    'backToQueue'
  ]) {
    assert.equal(moduleCode.includes(forbidden), false, `capture-ui.js 不该出现 ${forbidden}（只算 + 只改 DOM）`);
  }
  for (const apiName of [
    'captureQueueList',
    'captureQueueGet',
    'captureQueueRemove',
    'captureQueueClear',
    'captureClipboard',
    'captureCommitRecord'
  ]) {
    assert.ok(moduleSrc.includes(apiName), `模块缺白名单 IPC ${apiName}`);
  }
});
