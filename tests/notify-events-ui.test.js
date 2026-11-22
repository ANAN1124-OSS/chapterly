// M1（第一轮·低，第 14 轮第八刀）：主进程 → 渲染层通知接线的**行为**锚点。
//
// 背景：renderer.js 的 bindEvents 里紧挨着「快捷键一览」之后是一整排 api.on* 订阅——导入进度 /
// 捕获触发 / 剪贴板变化 / 剪贴板入队 / 关窗 / 强制退出 / 命令面板 / 书架变更；第 16 轮第十三刀再把
// 配置变更 / 系统睡眠唤醒 / 内部错误 / 整本排版进度 / 搜索索引进度这 6 条并入。它们都是
// 「收到一条主进程通知 → 调一个既有入口 / 出一条既有提示」，实现整段在
// renderer/notify-events-ui.js（renderer.js 只留一次装配 + bind()）。
// 这里用假 api + 假 host 把每条订阅的分流、提前返回与文案逐条钉住，再用机器清单钉
// 「实现只有一份、index.html 的加载顺序、编排器的接线都到位、订阅顺序没被重排」。
const test = require('node:test');
const assert = require('node:assert/strict');
const notifyEvents = require('../renderer/notify-events-ui');
const { loadSourceGate, stripAssertHostBranch } = require('./ui-test-preambles');

const flush = () => new Promise((resolve) => setImmediate(resolve));

// 订阅顺序 = 原 bindEvents 里的调用顺序（顺序变了要在这里显式改，别偷偷重排）。
const CHANNELS = [
  'onImportProgress',
  'onCaptureTriggered',
  'onClipboardChanged',
  'onClipboardRecorded',
  'onCloseRequested',
  'onForceClose',
  'onCommandPalette',
  'onShelfChanged',
  // 第 16 轮第十三刀（接在原有 8 条之后，顺序 = 原 bindEvents 的注册顺序）
  'onConfigChanged',
  'onPowerSuspend',
  'onPowerResume',
  'onInternalError',
  'onFormatProgress',
  'onSearchProgress'
];

// ------------------------------------------------------------------ 假 host
// 只实现这 8 条订阅真正读到的东西：假 api（按频道收回调）、记调用顺序的桩函数；
// 需要特殊行为的用例用 options 换掉个别成员。
function makeHost(options = {}) {
  const calls = [];
  const subscriptions = [];
  const record = (name) => (...args) => {
    calls.push([name, ...args]);
  };
  const api = { closeReady: record('closeReady') };
  for (const channel of CHANNELS) {
    api[channel] = (cb) => {
      subscriptions.push({ channel, cb });
      return () => {};
    };
  }
  const handleCloseRequest = async function handleCloseRequest() {
    calls.push(['handleCloseRequest']);
    return { ok: true };
  };
  const host = {
    api,
    state: { modal: Boolean(options.modal), ...(options.state || {}) },
    toast: record('toast'),
    toastActionable: (message, action, onClick) => {
      calls.push(['toastActionable', message, action]);
      host.__action = onClick;
    },
    formatCount: (n) => String(n),
    hasImportProgress: () => options.hasProgress !== false,
    setImportProgressText: record('setImportProgressText'),
    captureUi: {
      isOpen: () => Boolean(options.captureOpen),
      openTriggered: async (text, queued) => {
        calls.push(['openTriggered', text, queued]);
      },
      refreshQueue: async () => {
        calls.push(['refreshQueue']);
      },
      open: async () => {
        calls.push(['open']);
      }
    },
    hideHeaderMenus: record('hideHeaderMenus'),
    handleCloseRequest,
    saveCurrent: async (opts) => {
      calls.push(['saveCurrent', opts]);
      if (options.saveRejects) throw new Error('保存失败');
      return options.saveResult || { ok: true };
    },
    shelfUi: {
      handleShelfChanged: async (payload) => {
        calls.push(['handleShelfChanged', payload]);
        if (options.shelfRejects) throw new Error('刷新失败');
      }
    },
    openCommandPalette: record('openCommandPalette'),
    // 第 16 轮第十三刀：配置变更 / 睡眠唤醒 / 内部错误 / 排版进度 / 搜索进度
    configChangeUi: {
      handleConfigChanged: async (payload) => {
        calls.push(['handleConfigChanged', payload]);
        if (options.configRejects) throw new Error('配置刷新失败');
      }
    },
    refreshGlobalConfigFromMain: async () => {
      calls.push(['refreshGlobalConfigFromMain']);
      if (options.refreshRejects) throw new Error('刷新失败');
    },
    handleExternalConfigChange: async () => {
      calls.push(['handleExternalConfigChange']);
    },
    writeTimerUi: {
      handleSystemSuspend: () => calls.push(['handleSystemSuspend']),
      handleSystemResume: () => calls.push(['handleSystemResume'])
    },
    showFormatBookProgress: record('showFormatBookProgress'),
    shelfQueryText: () => (options.shelfQuery === undefined ? '关键词' : options.shelfQuery),
    CONTENT_SEARCH_MIN_CHARS: 2,
    scheduleContentSearch: record('scheduleContentSearch'),
    renderShelfContent: record('renderShelfContent')
  };
  Object.assign(host, options.overrides || {});
  const ui = notifyEvents.create(host);
  if (options.autoBind !== false) ui.bind();
  const callbacks = (channel) => subscriptions.filter((entry) => entry.channel === channel).map((entry) => entry.cb);
  const emit = (channel, ...args) => {
    const list = callbacks(channel);
    assert.equal(list.length, 1, channel + ' 必须恰好订阅一次');
    return list[0](...args);
  };
  return { ui, host, api, calls, subscriptions, callbacks, emit };
}

const namesOf = (calls) => calls.map((entry) => entry[0]);

// ------------------------------------------------------------------ host 契约
test('host 契约：缺任何一个成员都当场抛 TypeError（不等到通知到达才 ReferenceError）', () => {
  const { host } = makeHost();
  for (const key of notifyEvents.REQUIRED_HOST) {
    const broken = { ...host };
    delete broken[key];
    assert.throws(
      () => notifyEvents.create(broken),
      new RegExp('createNotifyEventsUi 的 host 缺少 ' + key.replace(/\$/g, '\\$')),
      '缺 ' + key + ' 时必须当场报错'
    );
  }
  assert.throws(() => notifyEvents.create(), /createNotifyEventsUi 需要 host 对象/);
  assert.throws(() => notifyEvents.create(null), /createNotifyEventsUi 需要 host 对象/);
  assert.equal(new Set(notifyEvents.REQUIRED_HOST).size, notifyEvents.REQUIRED_HOST.length, '成员清单不许重复');
  assert.equal(notifyEvents.REQUIRED_HOST.length, 22, '成员清单数量变了（新增 / 删除请同步本闸门）');
});

test('create() 只建对象、不订阅；bind() 才订阅（订阅一次、顺序与原来一致）', () => {
  const quiet = makeHost({ autoBind: false });
  assert.deepEqual(quiet.subscriptions, [], 'create() 不许订阅任何频道');
  assert.deepEqual(Object.keys(quiet.ui).sort(), ['bind'], '实例只暴露 bind');

  quiet.ui.bind();
  assert.deepEqual(
    quiet.subscriptions.map((entry) => entry.channel),
    CHANNELS,
    '订阅顺序 = 原 bindEvents 的注册顺序（重排会改变同一通知的先后处理）'
  );
  assert.deepEqual(namesOf(quiet.calls), [], 'bind() 只订阅，不许调任何入口');
  assert.deepEqual(quiet.callbacks('onCloseRequested'), [quiet.host.handleCloseRequest], '关窗询问按原函数身份注册');
});

// ------------------------------------------------------------------ 导入进度
test('导入进度：没有进度元素时静默；分析 / 收尾 / 逐项三档文案', () => {
  const silent = makeHost({ hasProgress: false });
  silent.emit('onImportProgress', { done: 1, total: 3, current: 'a.txt' });
  assert.deepEqual(namesOf(silent.calls), [], '没有进度元素时不写文案');

  const analyse = makeHost();
  analyse.emit('onImportProgress', null);
  assert.deepEqual(analyse.calls, [['setImportProgressText', '正在分析要导入的内容…']], '没有 total = 分析中');

  analyse.calls.length = 0;
  analyse.emit('onImportProgress', { total: 0 });
  assert.deepEqual(analyse.calls, [['setImportProgressText', '正在分析要导入的内容…']], 'total 为 0 也算分析中');

  analyse.calls.length = 0;
  analyse.emit('onImportProgress', { done: 3, total: 3 });
  assert.deepEqual(analyse.calls, [['setImportProgressText', '正在收尾（共 3 项）…']], 'done >= total = 收尾');

  analyse.calls.length = 0;
  analyse.emit('onImportProgress', { done: 1, total: 3, current: '第2章.txt' });
  assert.deepEqual(
    analyse.calls,
    [['setImportProgressText', '正在导入 2/3：第2章.txt']],
    '逐项进度 = 下一个序号 + 当前项'
  );

  analyse.calls.length = 0;
  analyse.emit('onImportProgress', { done: 0, total: 5, current: '目录', files: { done: 4, total: 20 } });
  assert.deepEqual(
    analyse.calls,
    [['setImportProgressText', '正在导入 1/5：目录（已复制 4/20 个文件）']],
    'P6：目录形态带「已复制 x/y 个文件」'
  );

  analyse.calls.length = 0;
  analyse.emit('onImportProgress', { done: 0, total: 5, files: { done: 7, total: 20 } });
  assert.deepEqual(
    analyse.calls,
    [['setImportProgressText', '正在导入 1/5：（已复制 7/20 个文件）']],
    '当前项缺失时保留空位，文件进度照常报'
  );
});

// ------------------------------------------------------------------ 捕获触发
test('捕获触发：先收顶栏菜单，再把原文 / 是否刚入队交给捕获面板', () => {
  const h = makeHost();
  h.emit('onCaptureTriggered', { text: '一段原文', queued: true });
  assert.deepEqual(h.calls, [
    ['hideHeaderMenus'],
    ['openTriggered', '一段原文', true]
  ]);

  h.calls.length = 0;
  h.emit('onCaptureTriggered', undefined);
  assert.deepEqual(h.calls, [
    ['hideHeaderMenus'],
    ['openTriggered', undefined, false]
  ], '没有载荷时原文 undefined、queued false（面板自己去读剪贴板）');

  h.calls.length = 0;
  h.emit('onCaptureTriggered', { text: 123, queued: 1 });
  assert.deepEqual(h.calls, [
    ['hideHeaderMenus'],
    ['openTriggered', undefined, true]
  ], '非字符串原文不往面板里塞');
});

// ------------------------------------------------------------------ 剪贴板变化
test('剪贴板变化：字数无效直接忽略（不提示、不刷新）', () => {
  for (const payload of [null, {}, { chars: 0 }, { chars: -1 }, { chars: 'abc' }]) {
    const h = makeHost();
    h.emit('onClipboardChanged', payload);
    assert.deepEqual(namesOf(h.calls), [], '非法字数：' + JSON.stringify(payload));
  }
});

test('剪贴板变化：单条超限给 warn 文案，不再弹「要捕获吗」', () => {
  const h = makeHost();
  h.emit('onClipboardChanged', { chars: 1200, tooLarge: true });
  assert.deepEqual(h.calls, [
    [
      'toast',
      '这段 1200 字超过单条上限（30 万字），没有自动记录；按 Ctrl+Alt+V 可直接捕获，或用「导入小说…」按章节拆',
      'warn'
    ]
  ]);
});

test('剪贴板变化：单条超限优先于「面板开着 / 询问框开着」', () => {
  const h = makeHost({ captureOpen: true, modal: true });
  h.emit('onClipboardChanged', { chars: 1200, tooLarge: true });
  assert.deepEqual(namesOf(h.calls).filter((name) => name !== 'toast'), [], '超限先明说原因');
  assert.equal(h.calls[0][0], 'toast');
});

test('剪贴板变化：面板开着就整表刷新，不再弹提示', () => {
  const h = makeHost({ captureOpen: true });
  h.emit('onClipboardChanged', { chars: 120 });
  assert.deepEqual(namesOf(h.calls), ['refreshQueue']);
});

test('剪贴板变化：询问框开着时不打扰', () => {
  const h = makeHost({ modal: true });
  h.emit('onClipboardChanged', { chars: 120 });
  assert.deepEqual(namesOf(h.calls), []);
});

test('剪贴板变化：面板没开 → 可点提示；点了才收菜单并打开面板', () => {
  const h = makeHost();
  h.emit('onClipboardChanged', { chars: 1200 });
  assert.deepEqual(h.calls, [['toastActionable', '新复制 1200 字，要捕获吗？', '捕获']]);
  assert.equal(typeof h.host.__action, 'function', '提示要带「捕获」按钮');
  h.host.__action();
  assert.deepEqual(namesOf(h.calls), ['toastActionable', 'hideHeaderMenus', 'open']);
});

// ------------------------------------------------------------------ 剪贴板入队
test('剪贴板入队：面板开着刷新列表，没开就忽略（不弹提示）', () => {
  const open = makeHost({ captureOpen: true });
  open.emit('onClipboardRecorded');
  assert.deepEqual(namesOf(open.calls), ['refreshQueue']);

  const closed = makeHost();
  closed.emit('onClipboardRecorded');
  assert.deepEqual(namesOf(closed.calls), [], '短复制没有轻提示，也不打扰');
});

// ------------------------------------------------------------------ 关窗 / 强制退出
test('关窗：订阅直接注册现成的 handleCloseRequest（不包一层新逻辑）', async () => {
  const h = makeHost();
  const result = await h.emit('onCloseRequested');
  assert.deepEqual(h.calls, [['handleCloseRequest']]);
  assert.deepEqual(result, { ok: true });
});

test('强制退出：先静默保存，再把保存结论交回主进程', async () => {
  const ok = makeHost();
  ok.emit('onForceClose');
  await flush();
  assert.deepEqual(ok.calls, [['saveCurrent', { silent: true }], ['closeReady', true]]);

  const notOk = makeHost({ saveResult: { ok: false } });
  notOk.emit('onForceClose');
  await flush();
  assert.deepEqual(notOk.calls, [['saveCurrent', { silent: true }], ['closeReady', false]], '保存失败不许谎报成功');

  const rejected = makeHost({ saveRejects: true });
  rejected.emit('onForceClose');
  await flush();
  assert.deepEqual(rejected.calls, [['saveCurrent', { silent: true }], ['closeReady', false]], '异常按失败降级');
});

// ------------------------------------------------------------------ 命令面板 / 书架
test('命令面板：走现成的 openCommandPalette（不另写一套开面板逻辑）', () => {
  const h = makeHost();
  h.emit('onCommandPalette');
  assert.deepEqual(h.calls, [['openCommandPalette']]);
});

test('书架变更：交给 shelfUi.handleShelfChanged；失败静默（不阻断别的窗口的写操作）', async () => {
  const h = makeHost();
  h.emit('onShelfChanged', { reason: 'chapter:save', bookPath: '/书库/书甲' });
  await flush();
  assert.deepEqual(h.calls, [['handleShelfChanged', { reason: 'chapter:save', bookPath: '/书库/书甲' }]]);

  const rejected = makeHost({ shelfRejects: true });
  rejected.emit('onShelfChanged', { reason: 'book:delete', bookPath: '/书库/书甲' });
  await flush();
  assert.deepEqual(namesOf(rejected.calls), ['handleShelfChanged'], '刷新失败要吞掉（原 .catch(() => {})），否则会变成未处理拒绝');
});

// ------------------------------------------------------------------ 第 16 轮第十三刀：其余 6 条
test('配置变更：换根 → configChangeUi + 表单重定基；非换根先刷新快照；坏载荷只交给 configChangeUi', async () => {
  const root = makeHost();
  root.emit('onConfigChanged', { reason: 'booksRoot', booksRoot: 'D:/新书架' });
  await flush();
  assert.deepEqual(namesOf(root.calls), ['handleConfigChanged', 'handleExternalConfigChange'], '换根：先提示孤岛 / 救稿出口，再给表单重定基');

  const plain = makeHost();
  plain.emit('onConfigChanged', { reason: 'config', changed: ['theme'] });
  await flush();
  assert.deepEqual(namesOf(plain.calls), ['refreshGlobalConfigFromMain', 'handleExternalConfigChange'], '非换根：先刷新 globalConfig 快照再重定基');

  const bad = makeHost();
  bad.emit('onConfigChanged', null);
  await flush();
  assert.deepEqual(namesOf(bad.calls), ['handleConfigChanged'], '坏载荷也交给模块自己忽略（这里不许抛）');

  const rejected = makeHost({ refreshRejects: true });
  rejected.emit('onConfigChanged', { reason: 'config' });
  await flush();
  assert.deepEqual(namesOf(rejected.calls), ['refreshGlobalConfigFromMain'], '刷新失败就到此为止（通知是尽力而为）');
});

test('系统睡眠 / 唤醒：交给写作计时结算与续算（不碰正文）', () => {
  const h = makeHost();
  h.emit('onPowerSuspend');
  h.emit('onPowerResume');
  assert.deepEqual(namesOf(h.calls), ['handleSystemSuspend', 'handleSystemResume']);
});

test('内部错误：同一个 kind|code 只提示一次；不同 kind 各提示一次；负载缺失走固定文案', () => {
  const h = makeHost();
  h.emit('onInternalError', { kind: 'unhandled', code: 'E1', message: '主进程内部错误' });
  assert.deepEqual(h.calls, [['toast', '主进程内部错误', 'error']]);
  assert.equal(h.host.state.lastInternalError.code, 'E1', '仍要记录最近一次内部错误（细节不丢）');
  h.emit('onInternalError', { kind: 'unhandled', code: 'E1', message: '第二次' });
  assert.equal(h.calls.length, 1, '同一个 kind|code 在本窗口不再刷 toast');
  h.emit('onInternalError', { kind: 'render', code: 'E1', message: '另一类' });
  assert.equal(h.calls.length, 2, 'kind 不同算不同错误');
  h.emit('onInternalError', null);
  assert.deepEqual(h.calls[2], ['toast', '程序遇到一个内部错误，已写进日志。', 'error'], '没有负载时走固定文案');
});

test('整本排版进度：只在整理进行中显示；done 超过 total 时夹紧；没有 total 不显示', () => {
  const idle = makeHost({ state: { formatBookRunning: false } });
  idle.emit('onFormatProgress', { done: 1, total: 3 });
  assert.deepEqual(idle.calls, [], '没在整理就忽略');

  const running = makeHost({ state: { formatBookRunning: true } });
  running.emit('onFormatProgress', { done: 1, total: 3 });
  assert.deepEqual(running.calls, [['showFormatBookProgress', '正在整理整本书：1/3 章']]);
  running.calls.length = 0;
  running.emit('onFormatProgress', { done: 9, total: 3 });
  assert.deepEqual(running.calls, [['showFormatBookProgress', '正在整理整本书：3/3 章']], 'done 超过 total 时夹紧');
  running.calls.length = 0;
  running.emit('onFormatProgress', { done: 2 });
  assert.deepEqual(running.calls, [], '没有 total 不算进度');
});

test('搜索索引进度：合并 indexStatus；书架 + 查询够长时 done 分支自动重搜，其余只刷新提示', () => {
  const make = (meta) => makeHost({ state: { view: 'shelf', shelfContent: { indexStatus: { books: 3 }, meta } } });
  const building = make({ index: { building: true } });
  building.emit('onSearchProgress', { phase: 'scan', books: 5, chapters: 9 });
  assert.deepEqual(namesOf(building.calls), ['renderShelfContent'], '普通进度只刷新提示');
  assert.deepEqual(
    building.host.state.shelfContent.indexStatus,
    { books: 5, chapters: 9, building: true, ready: false, progress: { phase: 'scan', books: 5, chapters: 9 } },
    'indexStatus 要把进度合并进去（旧字段保留）'
  );

  const done = make({ index: { building: true } });
  done.emit('onSearchProgress', { phase: 'done' });
  assert.deepEqual(namesOf(done.calls), ['scheduleContentSearch'], '首建完成 → 按原查询自动重搜');
  assert.equal(done.host.state.shelfContent.indexStatus.building, false, 'done 要把 building 置回 false');
  assert.equal(done.host.state.shelfContent.indexStatus.books, 3, '没带数字时保留旧值');

  const refreshed = make({});
  refreshed.emit('onSearchProgress', { phase: 'done' });
  assert.deepEqual(namesOf(refreshed.calls), ['renderShelfContent'], '已建好（不是首建中）只刷新提示');

  const short = makeHost({ state: { view: 'shelf', shelfContent: { meta: {} } }, shelfQuery: '关' });
  short.emit('onSearchProgress', { phase: 'done' });
  assert.deepEqual(short.calls, [], '查询不到阈值不刷新（不打断作者）');

  const editor = makeHost({ state: { view: 'editor', shelfContent: { meta: {} } } });
  editor.emit('onSearchProgress', { phase: 'done' });
  assert.deepEqual(editor.calls, [], '不在书架不刷新');

  const none = makeHost({ state: { view: 'shelf', shelfContent: { meta: {} } } });
  none.emit('onSearchProgress', null);
  assert.deepEqual(none.calls, [], '没有负载直接忽略');
});

// ------------------------------------------------------------------ 机器清单
test('静态闸门：14 条订阅只有模块一份，编排器只剩装配与 bind()', () => {
  const { rendererSrc, indexSrc, moduleSrc, moduleCode } = loadSourceGate('notify-events-ui.js');
  for (const channel of CHANNELS) {
    assert.equal(
      rendererSrc.includes('api.' + channel + '('),
      false,
      '订阅必须整段在 renderer/notify-events-ui.js：' + channel
    );
    assert.equal(
      moduleSrc.split('api.' + channel + '(').length - 1,
      1,
      '模块里每条订阅只许注册一次：' + channel
    );
  }
  assert.match(rendererSrc, /^  const notifyEventsUiModule = window\.CWNotifyEventsUi;$/m, 'renderer.js 要取模块全局名');
  assert.match(rendererSrc, /const notifyEventsUi = notifyEventsUiModule\.create\(\{/, 'renderer.js 要装配模块');
  assert.match(rendererSrc, /notifyEventsUi\.bind\(\);/, 'renderer.js 要在原位置订阅（bind 只调用一次）');
  assert.equal((rendererSrc.match(/notifyEventsUi\.bind\(\);/g) || []).length, 1, 'bind() 只许调用一次');
  // 第十三刀：configChangeUi / crashRecoveryUi 的实例要在 bindEvents 之前装配（订阅段依赖它们）
  const asmAt = rendererSrc.indexOf('const configChangeUi = configChangeUiModule.create(');
  const crashAt = rendererSrc.indexOf('crashRecoveryUi = crashRecoveryUiModule.create(');
  const bindEventsAt = rendererSrc.indexOf('  function bindEvents() {');
  assert.ok(asmAt > 0 && asmAt < bindEventsAt, 'configChangeUi 要在 bindEvents 之前装配');
  assert.ok(crashAt > 0 && crashAt < bindEventsAt, 'crashRecoveryUi 要在 bindEvents 之前装配');
  assert.match(rendererSrc, /crashRecoveryUi\.start\(\);/, 'start() 仍在 bindEvents 原位（启动时机不变）');

  const moduleAt = indexSrc.indexOf('src="notify-events-ui.js"');
  assert.ok(moduleAt > 0, 'index.html 必须加载 renderer/notify-events-ui.js');
  assert.ok(moduleAt < indexSrc.indexOf('src="renderer.js"'), 'notify-events-ui.js 必须排在 renderer.js 之前');
  assert.equal(indexSrc.split('notify-events-ui.js').length - 1, 1, 'notify-events-ui.js 只许加载一次');

  // 纯接线模块：除 UMD 的 require 外不许碰任何东西；也不许摸 Electron / 文件系统。
  const runtimeSrc = stripAssertHostBranch(moduleSrc);
  assert.equal(/\brequire\s*\(/.test(runtimeSrc), false, '运行时代码不许 require');
  assert.equal(/window\.cwApi|\bipcRenderer\b|node:fs/.test(moduleSrc), false, '模块不许摸 Electron / 文件系统');
  assert.match(moduleSrc, /assertHost\('createNotifyEventsUi', host, REQUIRED_HOST\);/, '必须走共享 assertHost');
  assert.match(moduleSrc, /return \{ bind \};/, '实例只暴露 bind');
  // 纯度：不许在模块里另写保存 / 写盘 / 切章（这一域只做「通知 → 分发」）。
  assert.equal(/localStorage|sessionStorage|writeFile|Ctrl\+S/.test(moduleCode), false, '这一域不许自己写盘 / 抢保存');
});
