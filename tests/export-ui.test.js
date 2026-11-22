const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const exportUi = require('../renderer/export-ui');
const staleGuard = require('../renderer/stale-guard');
const s2t = require('../core/s2t');
const commonLib = require('../core/common');
const { loadSourceGate, restoreGlobalsAfter, stripAssertHostBranch } = require('./ui-test-preambles');

// v0.9 B-5 第一刀：「导出 / 复制」整段（原 renderer.js 4736–5068 行，333 行）搬到 renderer/export-ui.js。
// 搬之前这一域只有 E2E 里 30 多处「点开导出范围对话框 → 真导出」的黑盒覆盖，范围校验 / 计划令牌 /
// 默认文件名的分支在 Node 里一步都测不到；搬出来以后用「假 host + 假 DOM」把这些分支逐条钉住。
// 三个静态闸门保证「渲染层不许再长出第二份实现」「index.html 的加载顺序不许反」「模块自己的边界」。

// 模块运行时会摸 document（querySelector / createElement）：真身由共享前导存下，test.after 放回。
restoreGlobalsAfter(test, ['document']);

const { rendererSrc, indexSrc, moduleSrc, moduleCode } = loadSourceGate('export-ui.js');

function makeEl(id) {
  const classes = new Set();
  return {
    id,
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    max: '',
    min: '',
    innerHTML: '',
    options: [],
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      toggle(name, on) {
        const next = on === undefined ? !classes.has(name) : Boolean(on);
        if (next) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name)
    },
    appendChild(child) {
      this.options.push(child);
      return child;
    },
    // M1 第十刀：bindDialogEvents 的接线测试要记录「哪个元素挂了哪些监听」
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    listenerCount(type) {
      return (this.listeners[type] || []).length;
    },
    dispatch(type, event) {
      let result;
      for (const fn of this.listeners[type] || []) result = fn(event);
      return result;
    }
  };
}

// 假 host：只实现模块真正用到的 10 个成员 + exportFormat 这对活绑定（get / set）。
function makeHost(options = {}) {
  const els = new Map();
  const toasts = [];
  const calls = [];
  const menus = [];
  const sensitivePanels = [];
  const state = {
    bookPath: options.bookPath === undefined ? 'C:/tmp/books/测试书' : options.bookPath,
    chapters: options.chapters || [
      { id: 'c1', name: '第一章', volumeId: '' },
      { id: 'c2', name: '第二章', volumeId: 'v1' }
    ],
    index: options.index === undefined ? 0 : options.index,
    dirty: Boolean(options.dirty),
    config: options.config || {}
  };
  const volumes = options.volumes || [];
  const box = { format: options.format || 'txt' };

  const host = {
    api: {
      exportPlan: 'book:export-plan',
      copyBook: 'book:copy',
      copyChapterPlatform: 'book:copy-chapter-platform',
      exportBook: 'book:export',
      exportEpub: 'book:export-epub',
      exportDocx: 'book:export-docx',
      openBookFolder: 'book:open-folder'
    },
    $: (id) => {
      if (!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
    editorEl: { value: options.editorValue === undefined ? '编辑区里的最新内容' : options.editorValue },
    s2tLib: s2t,
    state,
    toast: (message, kind) => { toasts.push({ message, kind: kind || 'info' }); },
    volumeList: () => volumes,
    chapterVolumeId: (chapter) => (chapter && chapter.volumeId) || null,
    hideExportMenu: () => { menus.push('hide'); },
    // M1 第十刀：导出菜单里的两个跨域入口由渲染层按箭头转发注入（真实来源是 historyUi / sensitiveUi）
    document: installedDoc,
    openSensitivePanel: () => {
      sensitivePanels.push('sensitive');
    },
    openHistoryForCurrentBook: () => {
      sensitivePanels.push('history');
    },
    formatCount: commonLib.formatCount,
    // WP-15（C37）：计划范围键比较用（生产由 renderer.js 注入 window.CWStaleGuard）
    staleGuard,
    get exportFormat() { return box.format; },
    set exportFormat(value) { box.format = value; },
    async call(channel, ...rest) {
      calls.push({ channel, rest });
      const handler = options.onCall ? options.onCall(channel, rest) : undefined;
      if (handler instanceof Error) throw handler;
      if (handler !== undefined) return handler;
      return {
        empty: false,
        chapterCount: 2,
        chars: 1234,
        fileName: '测试书.txt',
        epubFileName: '测试书.epub',
        docxFileName: '测试书.docx',
        volumeCount: 1,
        paragraphs: 3,
        title: '第一章',
        filePath: 'C:/tmp/out/测试书.txt'
      };
    }
  };
  return { host, state, els, toasts, calls, menus, box, sensitivePanels };
}

// 范围选择靠 document.querySelector 的两个选择器：checked 的 radio + 「全书」那个 radio。
// M1 第十刀：bindDialogEvents 通过 document.querySelectorAll('input[name="export-scope"]')
// 挂三个范围单选的 change 监听；这里用一个可换的数组喂它（每个用例自己决定放几个）。
let checkedScope = 'all';
let scopeRadios = [];
let installedDoc = null;
function installDom() {
  installedDoc = {
    querySelector(selector) {
      if (selector === 'input[name="export-scope"]:checked') {
        return checkedScope ? { value: checkedScope } : null;
      }
      if (selector === 'input[name="export-scope"][value="all"]') {
        return { checked: false };
      }
      return null;
    },
    querySelectorAll(selector) {
      return selector === 'input[name="export-scope"]' ? scopeRadios : [];
    },
    createElement: (tag) => ({ tag, value: '', textContent: '' })
  };
  globalThis.document = installedDoc;
}
installDom();
test.beforeEach(() => {
  checkedScope = 'all';
  scopeRadios = [];
  installDom();
});

test('host 契约：缺任何一个成员都当场抛 TypeError（不等到点导出才 ReferenceError）', () => {
  assert.throws(() => exportUi.create(), /createExportUi 需要 host 对象/);
  assert.throws(() => exportUi.create(null), /createExportUi 需要 host 对象/);
  const { host } = makeHost();
  for (const key of exportUi.REQUIRED_HOST) {
    const broken = { ...host };
    delete broken[key];
    assert.throws(
      () => exportUi.create(broken),
      new RegExp('createExportUi 的 host 缺少 ' + key.replace(/\$/g, '\\$')),
      '缺 ' + key + ' 时必须当场报错'
    );
  }
  // exportFormat 是活绑定（get / set），不是快照：给 undefined 也必须报错
  const { host: noFormat } = makeHost();
  assert.throws(
    () => exportUi.create({ ...noFormat, exportFormat: undefined }),
    /exportFormat（当前导出格式的活绑定）/
  );
  delete noFormat.exportFormat;
  assert.throws(() => exportUi.create(noFormat), /exportFormat/);
});

test('create() 只建表：不碰 DOM、不读 state（Node 里能直接调）', () => {
  const realDoc = globalThis.document;
  globalThis.document = null;
  try {
    const { host } = makeHost();
    const ui = exportUi.create(host);
    // 9 个入口 + 接线 + 校验 / 摘要 / 覆盖三组给单测直接调的内部件（拿不到 DOM 也照样建得出来）
    assert.deepEqual(Object.keys(ui).sort(), [
      'archiveSummaryParts',
      'bindDialogEvents',
      'closeExportDialog',
      'confirmExportDialog',
      'conversionTag',
      'copyBookFlow',
      'copyChapterPlatformFlow',
      'currentChapterOverride',
      'exportConversionMode',
      'openBookFolderFlow',
      'openExportDialog',
      'outputSummary',
      'readExportRange',
      'refreshExportSummary',
      'scheduleExportSummary',
      'validateExportRange'
    ]);
  } finally {
    globalThis.document = realDoc;
  }
});

test('readExportRange：三种范围 + 「未分卷」哨兵值翻译成 null', () => {
  const { host } = makeHost();
  const ui = exportUi.create(host);

  checkedScope = 'all';
  assert.deepEqual(ui.readExportRange(), { mode: 'all' });

  checkedScope = 'volume';
  host.$('export-volume').value = '__none__';
  assert.deepEqual(ui.readExportRange(), { mode: 'volume', volumeId: null });
  host.$('export-volume').value = 'v1';
  assert.deepEqual(ui.readExportRange(), { mode: 'volume', volumeId: 'v1' });

  checkedScope = 'range';
  host.$('export-from').value = '3';
  host.$('export-to').value = '7';
  assert.deepEqual(ui.readExportRange(), { mode: 'range', from: 3, to: 7 });
  // 空输入 / 非数字 → NaN（范围校验那边给中文提示，这里不悄悄改成 0）
  host.$('export-from').value = '';
  host.$('export-to').value = 'abc';
  const bad = ui.readExportRange();
  assert.equal(Number.isNaN(bad.from), true);
  assert.equal(Number.isNaN(bad.to), true);
});

test('readExportRange：一个都没选中时按「全书」（改前就是这个兜底）', () => {
  const { host } = makeHost();
  const ui = exportUi.create(host);
  checkedScope = null;
  assert.deepEqual(ui.readExportRange(), { mode: 'all' });
});

test('validateExportRange：合法 / 非整数 / 越界 / 反序的中文提示逐条写死', () => {
  const { host } = makeHost({ chapters: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }] });
  const ui = exportUi.create(host);

  assert.equal(ui.validateExportRange({ mode: 'all' }), '');
  assert.equal(ui.validateExportRange({ mode: 'volume', volumeId: 'v1' }), '');
  assert.equal(ui.validateExportRange({ mode: 'range', from: 1, to: 3 }), '');
  assert.equal(ui.validateExportRange({ mode: 'range', from: 2, to: 2 }), '');
  assert.equal(ui.validateExportRange({ mode: 'range', from: NaN, to: 3 }), '请输入起始章和结束章');
  assert.equal(ui.validateExportRange({ mode: 'range', from: 1, to: NaN }), '请输入起始章和结束章');
  assert.equal(ui.validateExportRange({ mode: 'range', from: 1.5, to: 3 }), '请输入起始章和结束章');
  assert.equal(ui.validateExportRange({ mode: 'range', from: 0, to: 3 }), '章节范围要在第 1–3 章之间');
  assert.equal(ui.validateExportRange({ mode: 'range', from: 1, to: 4 }), '章节范围要在第 1–3 章之间');
  assert.equal(ui.validateExportRange({ mode: 'range', from: 3, to: 1 }), '起始章不能大于结束章');
});

test('currentChapterOverride：干净章返回 null；脏章带编辑区内容；index 越界返回 null', () => {
  const clean = makeHost({ dirty: false });
  assert.equal(exportUi.create(clean.host).currentChapterOverride(), null);

  // 脏章但编辑区有新内容 → 导出 / 复制带上它（只参与这一次拼接，不写盘）
  const dirty = makeHost({ dirty: true, index: 1, editorValue: '还没保存的这一段' });
  assert.deepEqual(exportUi.create(dirty.host).currentChapterOverride(), {
    chapterId: 'c2',
    text: '还没保存的这一段'
  });

  const outOfRange = makeHost({ dirty: true, index: 99 });
  assert.equal(exportUi.create(outOfRange.host).currentChapterOverride(), null);
});

test('outputSummary / archiveSummaryParts：措辞逐字写死（范围 / 卷数 / 未保存）', () => {
  const { host } = makeHost();
  const ui = exportUi.create(host);

  assert.equal(ui.outputSummary({ chapterCount: 2, chars: 1234 }), '（2 章 · 1,234 字）', '拍板 #1：千分位');
  assert.equal(
    ui.outputSummary({ chapterCount: 2, chars: '99', includedUnsaved: true }),
    '（2 章 · 99 字 · 含当前章未保存内容）'
  );
  assert.equal(
    ui.outputSummary({ rangeLabel: '第 3–4 章', chapterCount: 2, chars: 0 }),
    '（第 3–4 章 · 2 章 · 0 字）'
  );
  // 「全书」不重复说一遍
  assert.equal(ui.outputSummary({ rangeLabel: '全书', chapterCount: 2, chars: 0 }), '（2 章 · 0 字）');

  assert.deepEqual(ui.archiveSummaryParts({ chapterCount: 2, chars: 30 }), ['2 章', '30 字']);
  assert.deepEqual(
    ui.archiveSummaryParts({ rangeLabel: '第 2 卷', chapterCount: 5, volumeCount: 2, chars: 900, includedUnsaved: true }),
    ['第 2 卷', '5 章', '2 卷', '900 字', '含当前章未保存内容']
  );
});

test('简繁转换：档位读设置、提示只在真的转换时补一句（真实 core/s2t.js 的口径）', () => {
  const off = makeHost();
  const offUi = exportUi.create(off.host);
  assert.equal(offUi.exportConversionMode(), '');
  assert.equal(offUi.conversionTag(''), '');
  assert.equal(offUi.conversionTag(undefined), '');
  assert.equal(offUi.conversionTag('乱写的档位'), '');

  const on = makeHost({ config: { exportConversion: 's2t' } });
  const onUi = exportUi.create(on.host);
  assert.equal(onUi.exportConversionMode(), 's2t');
  assert.equal(onUi.conversionTag('s2t'), '（已简体 → 繁体）');
  assert.equal(onUi.conversionTag('t2s'), '（已繁体 → 简体）');
});

test('openExportDialog：没有书 / 没有章节时只弹提示，不开弹层', async () => {
  const noBook = makeHost({ bookPath: null });
  await exportUi.create(noBook.host).openExportDialog('txt');
  assert.equal(noBook.els.get('export-backdrop'), undefined, '没有书时不该碰弹层');
  assert.deepEqual(noBook.toasts, []);

  const noChapters = makeHost({ chapters: [] });
  await exportUi.create(noChapters.host).openExportDialog('epub');
  assert.deepEqual(noChapters.toasts, [
    { message: '这本书里还没有章节，没有可导出的内容', kind: 'warn' }
  ]);
  assert.equal(noChapters.els.get('export-backdrop'), undefined, '没有章节时不该开弹层');
});

test('openExportDialog：标题 / 说明 / 范围输入框按格式写死，未知格式回落 TXT', async () => {
  const { host, els, box, menus } = makeHost();
  const ui = exportUi.create(host);

  // 等 IPC 回来之前就是「正在读取」+ 按钮禁用（同步重置，这段不能 await 掉）
  ui.openExportDialog('epub');
  assert.deepEqual(menus, ['hide'], '打开前先收起导出菜单');
  assert.equal(box.format, 'epub', '当前导出格式要写回渲染层那个活绑定');
  assert.equal(els.get('export-title').textContent, '导出 EPUB');
  assert.match(els.get('export-message').textContent, /^选择导出范围。导出成 EPUB 3 电子书/);
  assert.equal(els.get('export-all-count').textContent, '（2 章）');
  assert.equal(els.get('export-from').value, '1');
  assert.equal(els.get('export-to').value, '2');
  assert.equal(els.get('export-from').max, '2');
  assert.equal(els.get('export-to').min, '1');
  assert.equal(els.get('export-backdrop').classList.contains('hidden'), false);
  assert.equal(els.get('export-summary').textContent, '正在读取导出信息…');
  assert.equal(els.get('btn-export-confirm').disabled, true);

  ui.openExportDialog('docx');
  assert.equal(els.get('export-title').textContent, '导出 DOCX');
  assert.equal(box.format, 'docx');

  ui.openExportDialog('txt');
  assert.equal(els.get('export-title').textContent, '导出 TXT');
  assert.equal(box.format, 'txt');

  // 乱写的格式（菜单里点了不认识的东西）回落 TXT，不抛
  ui.openExportDialog('pdf');
  assert.equal(els.get('export-title').textContent, '导出 TXT');
  assert.equal(box.format, 'txt');
  await new Promise((resolve) => setImmediate(resolve));
});

test('openExportDialog — 卷下拉：有卷才显示那一行，全没分卷时留一项「未分卷」', async () => {
  const withVolumes = makeHost({
    chapters: [
      { id: 'c1', volumeId: '' },
      { id: 'c2', volumeId: 'v1' },
      { id: 'c3', volumeId: 'v1' }
    ],
    volumes: [{ id: 'v1', name: '第一卷' }]
  });
  await exportUi.create(withVolumes.host).openExportDialog('txt');
  assert.deepEqual(
    withVolumes.els.get('export-volume').options.map((o) => [o.value, o.textContent]),
    [['__none__', '未分卷（1 章）'], ['v1', '第一卷（2 章）']]
  );
  assert.equal(withVolumes.els.get('export-volume-row').classList.contains('hidden'), false);

  // 没有卷：下拉整行收起来，但选项里仍有「未分卷」，选中卷不会是个空下拉
  const noVolumes = makeHost({ chapters: [{ id: 'c1', volumeId: '' }], volumes: [] });
  await exportUi.create(noVolumes.host).openExportDialog('txt');
  assert.deepEqual(
    noVolumes.els.get('export-volume').options.map((o) => [o.value, o.textContent]),
    [['__none__', '未分卷（1 章）']]
  );
  assert.equal(noVolumes.els.get('export-volume-row').classList.contains('hidden'), true);

  // 全书都分过卷、又没有卷表（旧书目 / 手改坏了）→ 兜底留一项「未分卷（0 章）」
  const fallback = makeHost({ chapters: [{ id: 'c1', volumeId: 'v1' }], volumes: [] });
  await exportUi.create(fallback.host).openExportDialog('txt');
  assert.deepEqual(
    fallback.els.get('export-volume').options.map((o) => [o.value, o.textContent]),
    [['__none__', '未分卷（0 章）']]
  );
});

test('openExportDialog：重新打开时先清掉上一次的计划 / 摘要（在计划回来之前就是「正在读取」）', async () => {
  const { host, els } = makeHost();
  const ui = exportUi.create(host);
  ui.openExportDialog('txt');
  assert.equal(els.get('export-summary').textContent, '正在读取导出信息…');
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(els.get('export-summary').textContent, /默认文件名：测试书\.txt$/);
  assert.equal(els.get('btn-export-confirm').disabled, false);

  // 第二次打开又是同步重置：上一次的 2 章摘要不许留在屏幕上
  ui.openExportDialog('txt');
  assert.equal(els.get('export-summary').textContent, '正在读取导出信息…');
  assert.equal(els.get('btn-export-confirm').disabled, true);
  await new Promise((resolve) => setImmediate(resolve));
});

test('refreshExportSummary：范围非法 / 计划为空 / IPC 失败三种提示 + 确认按钮禁用', async () => {
  checkedScope = 'range';
  const invalid = makeHost();
  const invalidUi = exportUi.create(invalid.host);
  invalid.host.$('export-from').value = '1';
  invalid.host.$('export-to').value = '99';
  await invalidUi.refreshExportSummary();
  assert.equal(invalid.els.get('export-summary').textContent, '章节范围要在第 1–2 章之间');
  assert.equal(invalid.els.get('export-summary').classList.contains('warn'), true);
  assert.equal(invalid.els.get('btn-export-confirm').disabled, true);
  assert.deepEqual(invalid.calls, [], '范围非法时不该打 IPC');

  const empty = makeHost({ onCall: () => ({ empty: true }) });
  checkedScope = 'all';
  await exportUi.create(empty.host).refreshExportSummary();
  assert.equal(empty.els.get('export-summary').textContent, '所选范围里没有章节，换个范围试试');
  assert.equal(empty.els.get('btn-export-confirm').disabled, true);

  const failing = makeHost({ onCall: () => new Error('目录只读') });
  await exportUi.create(failing.host).refreshExportSummary();
  assert.equal(failing.els.get('export-summary').textContent, '无法读取导出信息：目录只读');
  assert.equal(failing.els.get('export-summary').classList.contains('warn'), true);
  assert.equal(failing.els.get('btn-export-confirm').disabled, true);
});

test('refreshExportSummary：成功摘要的措辞 + 按当前格式挑默认文件名（读的是活绑定）', async () => {
  const { host, els, calls, box } = makeHost();
  const ui = exportUi.create(host);

  await ui.openExportDialog('txt');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(els.get('export-summary').textContent, '将导出 2 章 · 1,234 字；默认文件名：测试书.txt');
  assert.equal(els.get('export-summary').classList.contains('warn'), false);
  assert.equal(els.get('btn-export-confirm').disabled, false);
  // 打开对话框打的是只读的 export-plan，参数是「书 + 当前章覆盖 + 范围」
  assert.deepEqual(calls[0], {
    channel: 'book:export-plan',
    rest: ['C:/tmp/books/测试书', null, { mode: 'all' }]
  });

  // 当前格式是模块外那个 let：改它，摘要里的默认文件名跟着换（不是 create 时的快照）
  box.format = 'epub';
  await ui.refreshExportSummary();
  assert.match(els.get('export-summary').textContent, /默认文件名：测试书\.epub$/);
  box.format = 'docx';
  await ui.refreshExportSummary();
  assert.match(els.get('export-summary').textContent, /默认文件名：测试书\.docx$/);

  // 脏章：计划里带「含当前章未保存内容」，请求里也真的带上编辑区内容
  const dirty = makeHost({
    dirty: true,
    onCall: () => ({ chapterCount: 1, chars: 5, fileName: 'a.txt', includedUnsaved: true })
  });
  const dirtyUi = exportUi.create(dirty.host);
  await dirtyUi.refreshExportSummary();
  assert.equal(
    dirty.els.get('export-summary').textContent,
    '将导出 1 章 · 5 字 · 含当前章未保存内容；默认文件名：a.txt'
  );
  assert.deepEqual(dirty.calls[0].rest[1], { chapterId: 'c1', text: '编辑区里的最新内容' });
});

test('refreshExportSummary：先发后到的旧计划不许盖掉新摘要（令牌闸门）', async () => {
  const pending = [];
  const { host, els } = makeHost({
    onCall: () => {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      pending.push({ promise, release });
      return promise;
    }
  });
  const ui = exportUi.create(host);

  const first = ui.refreshExportSummary();
  const second = ui.refreshExportSummary();
  assert.equal(pending.length, 2);
  // 后发的先回：摘要写的是第二次的结果
  pending[1].release({ chapterCount: 9, chars: 900, fileName: 'new.txt' });
  await second;
  assert.equal(els.get('export-summary').textContent, '将导出 9 章 · 900 字；默认文件名：new.txt');
  // 先发的后回：令牌已经变了，直接丢掉（不覆盖）
  pending[0].release({ chapterCount: 1, chars: 1, fileName: 'stale.txt' });
  await first;
  assert.equal(els.get('export-summary').textContent, '将导出 9 章 · 900 字；默认文件名：new.txt');
});

test('closeExportDialog：收起弹层 + 让在途摘要失效 + 清掉待跑的防抖定时器', async () => {
  const pending = [];
  const { host, els, calls } = makeHost({
    onCall: () => {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      pending.push({ promise, release });
      return promise;
    }
  });
  const ui = exportUi.create(host);
  els.set('export-summary', makeEl('export-summary'));
  els.get('export-summary').textContent = '正在读取导出信息…';
  const inflight = ui.refreshExportSummary();
  ui.scheduleExportSummary(20);
  ui.closeExportDialog();
  assert.equal(els.get('export-backdrop').classList.contains('hidden'), true);
  pending[0].release({ chapterCount: 3, chars: 30, fileName: 'late.txt' });
  await inflight;
  assert.equal(els.get('export-summary').textContent, '正在读取导出信息…', '关掉以后在途计划不许再写摘要');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.length, 1, '关掉以后那个防抖定时器不该再打 IPC');
});

test('confirmExportDialog：范围非法 / 没有计划时只弹提示，一条导出都不发起', async () => {
  const { host, toasts, calls } = makeHost();
  await exportUi.create(host).confirmExportDialog();
  assert.deepEqual(toasts, [{ message: '所选范围里没有章节，换个范围试试', kind: 'warn' }]);
  assert.deepEqual(calls, []);

  checkedScope = 'range';
  const invalid = makeHost();
  const invalidUi = exportUi.create(invalid.host);
  invalid.host.$('export-from').value = '9';
  invalid.host.$('export-to').value = '9';
  await invalidUi.confirmExportDialog();
  assert.deepEqual(invalid.toasts, [{ message: '章节范围要在第 1–2 章之间', kind: 'warn' }]);
  assert.deepEqual(invalid.calls, []);
});

test('confirmExportDialog：先关弹层，再按当前格式走三种导出之一', async () => {
  const cases = [
    ['txt', 'book:export', '已导出：'],
    ['epub', 'book:export-epub', '已导出 EPUB：'],
    ['docx', 'book:export-docx', '已导出 DOCX：']
  ];
  for (const [format, channel, prefix] of cases) {
    const { host, calls, toasts, els } = makeHost({
      onCall: (ch) => (ch === 'book:export-plan'
        ? { chapterCount: 2, chars: 1234, fileName: '测试书.txt', epubFileName: '测试书.epub', docxFileName: '测试书.docx' }
        : { filePath: 'C:/tmp/out/测试书.' + format, chapterCount: 2, volumeCount: 1, chars: 1234, conversion: '' })
    });
    const ui = exportUi.create(host);
    await ui.openExportDialog(format);
    await new Promise((resolve) => setImmediate(resolve));
    await ui.confirmExportDialog();
    const exportCall = calls[calls.length - 1];
    assert.equal(exportCall.channel, channel, format + ' 应该走 ' + channel);
    assert.deepEqual(exportCall.rest, ['C:/tmp/books/测试书', null, { mode: 'all' }]);
    assert.equal(els.get('export-backdrop').classList.contains('hidden'), true, '确认后弹层先关');
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].kind, 'info');
    assert.ok(toasts[0].message.startsWith(prefix), format + ' 的提示语变了：' + toasts[0].message);
    assert.match(toasts[0].message, /^已导出.*C:\/tmp\/out\/测试书\./);
  }
});

test('confirmExportDialog：取消另存（canceled）时不弹成功提示', async () => {
  const { host, toasts } = makeHost({
    onCall: (ch) => (ch === 'book:export-plan' ? { chapterCount: 1, chars: 9, fileName: 'a.txt' } : { canceled: true })
  });
  const ui = exportUi.create(host);
  await ui.openExportDialog('txt');
  await new Promise((resolve) => setImmediate(resolve));
  await ui.confirmExportDialog();
  assert.deepEqual(toasts, [], '作者在另存对话框按了取消，不该再弹「已导出」');
});

test('copyChapterPlatformFlow：脏章带编辑区内容、空章提示、失败返回 null', async () => {
  const { host, calls, toasts } = makeHost({
    dirty: true,
    index: 0,
    onCall: () => ({ paragraphs: 3, chars: 210, title: '第一章', includedUnsaved: true })
  });
  const ui = exportUi.create(host);
  const data = await ui.copyChapterPlatformFlow(0);
  assert.equal(data.paragraphs, 3);
  assert.deepEqual(calls[0], {
    channel: 'book:copy-chapter-platform',
    rest: ['C:/tmp/books/测试书', { chapterId: 'c1', text: '编辑区里的最新内容' }]
  });
  assert.deepEqual(toasts, [{
    message: '已复制「第一章」正文（段首缩进 + 段间空行：3 段 · 210 字 · 含未保存内容）',
    kind: 'info'
  }]);

  // 非当前章：不带编辑区内容（只按 chapterId 让主进程读盘）
  const other = makeHost({ dirty: true, index: 0, onCall: () => ({ paragraphs: 1, chars: 2, title: '第二章' }) });
  await exportUi.create(other.host).copyChapterPlatformFlow(1);
  assert.deepEqual(other.calls[0].rest[1], { chapterId: 'c2' });

  const empty = makeHost({ onCall: () => ({ empty: true }) });
  assert.deepEqual(await exportUi.create(empty.host).copyChapterPlatformFlow(0), { empty: true });
  assert.deepEqual(empty.toasts, [
    { message: '本章还没有正文，没有可复制的内容（剪贴板没动）', kind: 'warn' }
  ]);

  const failing = makeHost({ onCall: () => new Error('剪贴板被占用') });
  assert.equal(await exportUi.create(failing.host).copyChapterPlatformFlow(0), null);
  assert.deepEqual(failing.toasts, [{ message: '复制本章失败：剪贴板被占用', kind: 'error' }]);

  // 没有书 / 章节不存在：静默返回 null（改前就是这样）
  const noBook = makeHost({ bookPath: null });
  assert.equal(await exportUi.create(noBook.host).copyChapterPlatformFlow(0), null);
  assert.deepEqual(noBook.toasts, []);
  const outOfRange = makeHost();
  assert.equal(await exportUi.create(outOfRange.host).copyChapterPlatformFlow(9), null);
});

test('copyBookFlow / openBookFolderFlow：成功与失败的提示逐字写死', async () => {
  const ok = makeHost({ onCall: () => ({ chapterCount: 2, chars: 77 }) });
  await exportUi.create(ok.host).copyBookFlow();
  assert.deepEqual(ok.calls[0], { channel: 'book:copy', rest: ['C:/tmp/books/测试书', null] });
  assert.deepEqual(ok.toasts, [{ message: '已复制整本（2 章 · 77 字）', kind: 'info' }]);

  const bad = makeHost({ onCall: () => new Error('剪贴板被占用') });
  await exportUi.create(bad.host).copyBookFlow();
  assert.deepEqual(bad.toasts, [{ message: '复制失败：剪贴板被占用', kind: 'error' }]);

  const folder = makeHost({ onCall: () => ({}) });
  await exportUi.create(folder.host).openBookFolderFlow();
  assert.deepEqual(folder.calls[0], { channel: 'book:open-folder', rest: ['C:/tmp/books/测试书'] });
  assert.deepEqual(folder.toasts, []);

  const folderBad = makeHost({ onCall: () => new Error('路径不存在') });
  await exportUi.create(folderBad.host).openBookFolderFlow();
  assert.deepEqual(folderBad.toasts, [{ message: '打开文件夹失败：路径不存在', kind: 'error' }]);

  // 没有书：一个 IPC 都不打
  const noBook = makeHost({ bookPath: null });
  const noBookUi = exportUi.create(noBook.host);
  await noBookUi.copyBookFlow();
  await noBookUi.openBookFolderFlow();
  assert.deepEqual(noBook.calls, []);
});

test('scheduleExportSummary：连续改动只跑最后一次（clearTimeout 防抖）', async () => {
  const { host, calls } = makeHost();
  const ui = exportUi.create(host);
  ui.scheduleExportSummary(5);
  ui.scheduleExportSummary(5);
  ui.scheduleExportSummary(5);
  assert.equal(calls.length, 0, '防抖窗口内不该打 IPC');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(calls.length, 1, '三次改动只算最后一次');
});

// ---------- M1（第一轮·低）第十刀：导出菜单 / 范围对话框接线（bindDialogEvents） ----------
// 22 行接线（导出菜单 7 个分流 + 范围对话框 5 个输入 + 取消 / 确认）从 renderer.js 的 bindEvents
// 整段搬进 export-ui.js 的 bindDialogEvents()；这里用假 DOM 把「哪个元素 → 哪个入口」逐条钉住。
function bindDialogs(options = {}) {
  const h = makeHost(options);
  scopeRadios = [makeEl('scope-all'), makeEl('scope-volume'), makeEl('scope-range')];
  const ui = exportUi.create(h.host);
  ui.bindDialogEvents();
  return { ...h, ui };
}

function makeMenuClick(action) {
  return {
    target: {
      closest: (selector) =>
        selector === 'button[data-action]' ? { dataset: { action } } : null
    }
  };
}

test('M1 第十刀：导出菜单七个分流走模块既有入口（copy / txt / epub / docx / sensitive / folder / history）', async () => {
  const h = bindDialogs();
  const menu = h.els.get('export-menu');
  assert.equal(menu.listenerCount('click'), 1, '导出菜单只挂一份点击监听');

  // 复制整本：先收菜单，再走 copyBookFlow
  await menu.dispatch('click', makeMenuClick('copy'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.menus.length, 1, '点动作先收菜单');
  assert.deepEqual(h.calls.map((call) => call.channel), ['book:copy']);
  assert.match(h.toasts.at(-1).message, /^已复制整本/);

  // 三种格式都从模块自己的 openExportDialog 开框（标题跟着格式换）
  const titles = { txt: '导出 TXT', epub: '导出 EPUB', docx: '导出 DOCX' };
  for (const format of ['txt', 'epub', 'docx']) {
    await menu.dispatch('click', makeMenuClick(format));
    assert.equal(h.box.format, format, format + ' 菜单项要开对应格式的导出框');
    assert.equal(h.els.get('export-title').textContent, titles[format]);
  }

  // 敏感词预检 / 本书历史：两个跨域入口按注入的箭头转发
  await menu.dispatch('click', makeMenuClick('sensitive'));
  await menu.dispatch('click', makeMenuClick('history'));
  assert.deepEqual(h.sensitivePanels, ['sensitive', 'history'], '导出菜单要按动作调注入的跨域入口');

  // 打开书文件夹
  await menu.dispatch('click', makeMenuClick('folder'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.some((call) => call.channel === 'book:open-folder'), true, 'folder 项要打开书文件夹');

  // 不是 data-action 按钮 / 未知动作：只收菜单，什么都不做
  const realCalls = h.calls.filter((call) => call.channel !== 'book:export-plan').length;
  const panelsBefore = h.sensitivePanels.length;
  await menu.dispatch('click', { target: { closest: () => null } });
  await menu.dispatch('click', makeMenuClick('unknown-action'));
  assert.equal(h.calls.filter((call) => call.channel !== 'book:export-plan').length, realCalls, '非动作点击不许打 IPC');
  assert.equal(h.sensitivePanels.length, panelsBefore, '未知动作不许碰跨域入口');
});

test('M1 第十刀：范围对话框的 5 个输入各挂一份监听；改范围立刻作废旧计划并重算', async () => {
  const h = bindDialogs();
  for (const radio of scopeRadios) assert.equal(radio.listenerCount('change'), 1, '三个范围单选各挂一份 change');
  assert.equal(h.els.get('export-volume').listenerCount('change'), 1);
  assert.equal(h.els.get('export-from').listenerCount('input'), 1);
  assert.equal(h.els.get('export-to').listenerCount('input'), 1);
  assert.equal(h.els.get('btn-export-cancel').listenerCount('click'), 1);
  assert.equal(h.els.get('btn-export-confirm').listenerCount('click'), 1);

  // 三个单选触发的是模块自己的 refreshExportSummary（打 book:export-plan）
  scopeRadios[0].dispatch('change');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.calls.map((call) => call.channel), ['book:export-plan']);
  h.els.get('export-volume').dispatch('change');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.length, 2);

  // 范围输入是 120ms 防抖：两次输入只算最后一次，防抖窗口里不打 IPC
  h.els.get('export-from').dispatch('input');
  h.els.get('export-to').dispatch('input');
  assert.equal(h.calls.length, 2, '防抖窗口里不许打 IPC');
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.equal(h.calls.length, 3, '两次输入只算最后一次');

  // 取消：收起弹层（模块自己的 closeExportDialog）
  const backdrop = h.host.$('export-backdrop');
  backdrop.classList.remove('hidden');
  h.els.get('btn-export-cancel').dispatch('click');
  assert.equal(backdrop.classList.contains('hidden'), true, '取消要收起导出范围弹层');

  // 确认：没有计划时只提示、一条导出都不发起
  await h.els.get('btn-export-confirm').dispatch('click');
  assert.deepEqual(h.toasts.at(-1), { message: '所选范围里没有章节，换个范围试试', kind: 'warn' });
  assert.equal(h.calls.some((call) => call.channel !== 'book:export-plan'), false, '没有计划不许发起导出');
});

test('M1 第十刀：bindDialogEvents 幂等；静态闸门——接线只在 export-ui.js，编排器只剩一次调用', () => {
  const h = bindDialogs();
  h.ui.bindDialogEvents();
  assert.equal(h.els.get('export-menu').listenerCount('click'), 1, '重入不许挂出第二份菜单监听');
  for (const radio of scopeRadios) assert.equal(radio.listenerCount('change'), 1, '重入不许挂出第二份范围监听');
  for (const [id, type] of [
    ['export-volume', 'change'],
    ['export-from', 'input'],
    ['export-to', 'input'],
    ['btn-export-cancel', 'click'],
    ['btn-export-confirm', 'click']
  ]) {
    assert.equal(h.els.get(id).listenerCount(type), 1, id + ' 的监听只许一份');
  }

  assert.match(rendererSrc, /exportUi\.bindDialogEvents\(\);/, '编排器要在原位置调用 bindDialogEvents()');
  assert.equal((rendererSrc.match(/exportUi\.bindDialogEvents\(\);/g) || []).length, 1, '只许调用一次');
  assert.equal(/\$\('export-menu'\)\.addEventListener/.test(rendererSrc), false, '导出菜单监听必须整段搬出编排器');
  assert.equal(/querySelectorAll\('input\[name="export-scope"\]'\)/.test(rendererSrc), false, '范围单选接线不许回流编排器');
  assert.match(moduleSrc, /function bindDialogEvents\(\)/, '模块要提供 bindDialogEvents()');
  for (const id of ['export-menu', 'export-volume', 'export-from', 'export-to', 'btn-export-cancel', 'btn-export-confirm']) {
    assert.ok(moduleSrc.includes("$('" + id + "')"), '模块里缺接线：' + id);
  }
});

test('静态闸门：renderer.js 不再内嵌导出 / 复制的实现，只剩接线', () => {
  for (const name of [
    'currentChapterOverride', 'outputSummary', 'archiveSummaryParts', 'readExportRange',
    'validateExportRange', 'fillExportVolumeOptions', 'syncExportScopeInputs', 'refreshExportSummary',
    'scheduleExportSummary', 'openExportDialog', 'renderExportConversionNote', 'confirmExportDialog',
    'copyBookFlow', 'copyChapterPlatformFlow', 'exportBookFlow', 'exportEpubFlow', 'exportDocxFlow',
    'openBookFolderFlow'
  ]) {
    assert.equal(
      new RegExp('^  (?:async )?function ' + name + '\\b', 'm').test(rendererSrc),
      false,
      'renderer.js 里又有 ' + name + ' 的第二份实现（该在 export-ui.js）'
    );
  }
  // 常量表与三个模块级私有的「计划状态」也不许回到渲染层
  for (const name of ['EXPORT_UNVOLUMED', 'EXPORT_MESSAGES', 'EXPORT_TITLES', 'exportPlanTimer', 'exportPlanToken', 'lastExportPlan']) {
    assert.equal(rendererSrc.includes(name), false, 'renderer.js 里不该再有 ' + name);
  }
  // 接线：模块只 create 一次，13 个成员 + exportFormat 的 get / set 都传进去
  assert.match(rendererSrc, /const exportUi = exportUiModule\.create\(\{/);
  for (const key of ['api', '$', 'editorEl', 's2tLib', 'call', 'state', 'toast', 'volumeList', 'chapterVolumeId', 'hideExportMenu', 'document']) {
    assert.match(rendererSrc, new RegExp('^    ' + key.replace(/\$/g, '\\$') + ',$', 'm'), 'host 少了 ' + key);
  }
  // 两个跨域入口是后段解构的 const（historyUi / sensitiveUi），只能按箭头转发（直接取值会撞 TDZ）
  assert.match(rendererSrc, /^    openSensitivePanel: \(\) => openSensitivePanel\(\),$/m, 'host 少了 openSensitivePanel');
  assert.match(rendererSrc, /^    openHistoryForCurrentBook: \(\) => openHistoryForCurrentBook\(\),$/m, 'host 少了 openHistoryForCurrentBook');
  assert.match(rendererSrc, /get exportFormat\(\) \{\r?\n      return exportFormat;\r?\n    \},/);
  assert.match(rendererSrc, /set exportFormat\(value\) \{\r?\n      exportFormat = value;\r?\n    \}/);
  // 「当前导出格式」这个活绑定必须还是渲染层的模块级 let（testHooksScope / E2E 按名字读它）
  assert.match(rendererSrc, /^  let exportFormat = 'txt';$/m);
  // 5 个入口是模块级 const（Esc 注册表 / 章节菜单 / 测试钩子照旧按名字取）。M1 第十刀把导出菜单
  // 与范围对话框接线搬进模块后，refreshExportSummary / scheduleExportSummary / confirmExportDialog /
  // copyBookFlow 只在模块内部用，编排器不再需要这 4 个别名（删除后 eslint no-unused-vars 才绿）。
  for (const name of ['openExportDialog', 'closeExportDialog', 'copyChapterPlatformFlow', 'openBookFolderFlow', 'readExportRange']) {
    assert.match(
      rendererSrc,
      new RegExp('^  const ' + name + ' = exportUi\\.' + name + ';$', 'm'),
      name + ' 的接线丢了'
    );
  }
});

test('静态闸门：index.html 在 renderer.js 之前加载 export-ui.js，模块自己不许碰后端', () => {
  const moduleIdx = indexSrc.indexOf('src="export-ui.js"');
  const rendererIdx = indexSrc.indexOf('src="renderer.js"');
  assert.ok(moduleIdx > 0, 'index.html 没有加载 export-ui.js');
  assert.ok(moduleIdx < rendererIdx, 'export-ui.js 必须排在 renderer.js 之前');
  // 排在 esc-registry.js 之后（两者互不依赖，位置跟在它后面便于阅读）
  assert.ok(indexSrc.indexOf('src="esc-registry.js"') < moduleIdx);
  // A8（WP-32）：唯一允许的 require 是 UMD 的 Node 分支取 core/assert-host.js；
  // 运行时代码仍不许 require 任何东西。
  // T8（三审·低）：UMD 分支闸门只留 tests/assert-host.test.js 一处（那里逐个模块核对 require / 全局名 / 工厂签名）。
  const runtimeCode = stripAssertHostBranch(moduleCode);
  assert.equal(/\brequire\s*\(/.test(runtimeCode), false, 'export-ui.js 不许 require');
  assert.equal(/ipcRenderer|node:fs|\bwindow\s*\.\s*cwApi/.test(moduleCode), false, '不许自己摸 Electron / 文件系统');
  assert.equal(/^ {2}\$\(/m.test(moduleCode), false, '模块顶层不许直接查 DOM');
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWExportUi，且不乱造别的全局', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(moduleSrc, context, { filename: 'renderer/export-ui.js' });
  assert.equal(typeof win.CWExportUi, 'object');
  assert.deepEqual(Object.keys(win.CWExportUi).sort(), ['REQUIRED_HOST', 'create']);
  assert.deepEqual(Array.from(win.CWExportUi.REQUIRED_HOST).sort(), Array.from(exportUi.REQUIRED_HOST).sort());
  assert.equal(typeof win.CWExportUi.create, 'function');
  assert.equal(win.CWTtsUi, undefined, '单独加载 export-ui 不该顺手造出别的全局');
  assert.equal(win.CWChapters, undefined);
});

// ---------- WP-15 / C37：导出计划与当前范围的绑定 ----------
test('refreshExportSummary（WP-15 / C37）：新计划在飞时确认按钮禁用，直接点确认不发起导出', async () => {
  const pending = [];
  const { host, els, toasts, calls } = makeHost({
    onCall: () => {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      pending.push({ promise, release });
      return promise;
    }
  });
  const ui = exportUi.create(host);
  const refreshing = ui.refreshExportSummary();
  assert.equal(els.get('btn-export-confirm').disabled, true, '计划没回来之前不许确认');

  await ui.confirmExportDialog();
  assert.deepEqual(calls.map((call) => call.channel), ['book:export-plan'], '在途窗口里不许发起导出');
  assert.deepEqual(toasts, [{ message: '所选范围里没有章节，换个范围试试', kind: 'warn' }]);

  pending[0].release({ chapterCount: 2, chars: 1234, fileName: '测试书.txt' });
  await refreshing;
  assert.equal(els.get('btn-export-confirm').disabled, false, '计划落地后按钮才恢复');
});

test('confirmExportDialog（WP-15 / C37）：计划与当前范围对不上时不放行，并立刻按当前范围补算', async () => {
  const { host, els, toasts, calls } = makeHost();
  const ui = exportUi.create(host);
  await ui.openExportDialog('txt');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1, '打开时按「全书」算过一次计划');

  // 没走 input 事件就把范围改成 2–2（模拟脚本改值 / 事件漏发）：计划还是「全书」那一份
  checkedScope = 'range';
  host.$('export-from').value = '2';
  host.$('export-to').value = '2';
  assert.equal(els.get('btn-export-confirm').disabled, false, '按钮此刻仍是旧计划放行的状态');

  await ui.confirmExportDialog();
  assert.equal(
    calls.some((call) => call.channel !== 'book:export-plan'),
    false,
    '范围对不上时一条导出都不许发起'
  );
  assert.deepEqual(toasts.at(-1), { message: '导出信息还在更新，请稍候再点一次', kind: 'warn' });
  assert.equal(
    calls.filter((call) => call.channel === 'book:export-plan').length,
    2,
    '确认被拦下时顺手按当前范围补算一次计划'
  );
  await new Promise((resolve) => setImmediate(resolve));
});

test('scheduleExportSummary（WP-15 / C37）：范围一改旧计划立刻作废、按钮先禁用（防抖窗口也不放行）', async () => {
  const { host, els, toasts, calls } = makeHost();
  const ui = exportUi.create(host);
  await ui.openExportDialog('txt');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(els.get('btn-export-confirm').disabled, false);

  checkedScope = 'range';
  host.$('export-from').value = '2';
  host.$('export-to').value = '2';
  ui.scheduleExportSummary(50);
  assert.equal(els.get('btn-export-confirm').disabled, true, '防抖窗口里按钮必须先禁用');

  await ui.confirmExportDialog();
  assert.equal(
    calls.some((call) => call.channel !== 'book:export-plan'),
    false,
    '防抖窗口里点确认不许拿旧范围的计划导出'
  );
  assert.deepEqual(toasts.at(-1), { message: '所选范围里没有章节，换个范围试试', kind: 'warn' });
  ui.closeExportDialog();
});
