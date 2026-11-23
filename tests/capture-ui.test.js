// 剪贴板面板测试（T9 / 第 9 轮按性质拆分）：剪贴板面板（单列表视图）的行为。
//
// 来源：原 tests/capture-ui.test.js（1,921 行）拆成夹具 + 三个文件，**只搬家不改断言**——
// 用例标题与断言逐字保留，共用夹具收进 tests/capture-ui-fixtures.js。
// 本文件覆盖：契约（host 10 成员 / 导出 API / view()）→ 打开（队列 / 当前剪贴板 / 空剪贴板 / 预检 / backdrop）→
// openTriggered → 正文（queue-get / pending / 消费 / 失败保留 / 防重）→ 章节（payload / 仅章名 /
// dirty 先保存 / 五-H5 统一原语 / 写盘失败 / 超长闸门 / 载章失败）→ 插入位置 → 清空 / 刷新 /
// cancel / close / records()。
const test = require('node:test');
const assert = require('node:assert/strict');
const { capture, captureUiModule, backdropRegistry, moduleSrc, rendererSrc, recordEls, actionButtons, QUEUE_A, QUEUE_B, PENDING_TEXT, build, withFakeDocument } = require('./capture-ui-fixtures');

// ---------- 契约 ----------

test('契约：createCaptureUi 的 host 正好 10 个成员（含 insertIntoBody / staleGuard），缺一个当场 TypeError', () => {
  assert.deepEqual([...captureUiModule.REQUIRED_HOST].sort(), [
    '$',
    'api',
    'call',
    'insertIntoBody',
    'loadChapterAt',
    'renderStatsUi',
    'saveCurrent',
    'staleGuard',
    'state',
    'toast'
  ]);
  assert.equal(captureUiModule.REQUIRED_HOST.length, 10, 'host 成员数按契约 §5 是 10 个');
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

// 审计修复 #41（V404）：契约注释与 REQUIRED_HOST 的成员数必须一致。V404 前源码两处还写着「9 个成员」
// （测试早已是 10），按注释理解契约的人会数不出第 10 个 staleGuard。这里把三处注释一起钉住。
test('契约注释（V404）：capture-ui / renderer.js 的成员计数与清单对齐 REQUIRED_HOST', () => {
  assert.equal(/正好 9 个成员|这 9 个键/.test(moduleSrc), false, 'capture-ui.js 还有「9 个成员」的旧计数');
  // TESTC-01：防的是「注释写 9、实现 10」这类失实，不是注释排版——只钉计数，不钉星号 / 空格 / 标点。
  assert.ok(
    (moduleSrc.match(/host 正好 10 个成员/g) || []).length >= 2,
    '契约头部与 §5 说明两处都要写「host 正好 10 个成员」'
  );
  // 契约成员清单与 REQUIRED_HOST 对齐（清单内容比注释格式重要：成员名逐个对，排版随便）。
  const headerStart = moduleSrc.indexOf('契约：createCaptureUi(host)');
  assert.notEqual(headerStart, -1, '找不到契约头部注释');
  const headerEnd = moduleSrc.indexOf('另有可选成员', headerStart);
  assert.notEqual(headerEnd, -1, '找不到契约头部结尾（另有可选成员）');
  const listed = moduleSrc.slice(headerStart, headerEnd).match(/\{\s*([^}]+)\s*\}/);
  assert.ok(listed, '契约头部的成员清单不见了');
  assert.deepEqual(listed[1].split(',').map((item) => item.trim()), captureUiModule.REQUIRED_HOST);
  assert.equal(/host 正好 9 个成员/.test(rendererSrc), false, 'renderer.js 装配注释还在写 9 个成员');
  assert.match(rendererSrc, /createCaptureUi\(host\) 一次装配，host 正好 10 个成员/);
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
    assert.equal(records[0].chars, capture.countChars(PENDING_TEXT), 'pending 行按去空白字数（V108）');
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
    assert.equal(records[0].chars, capture.countChars(QUEUE_A));
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

// T-21（三审，低）：连按两下「捕获」/ 提示条时，两次 open 会并发通过 preflight（panel.open 仍是 false），
// 第二次补拍换到的新凭证会顶掉第一次的 → 两句 captureClipboard 都带后一张，主进程按「一次性已用」
// 拒掉后到的那句，作者看到一条误导的「读取剪贴板失败」。opening 标志保证只补一拍、只读一次。
test('T-21：并发打开（连按两下）只走一次补拍 / 读剪贴板，后到的回 OPENING', () =>
  withFakeDocument(async () => {
    const ctx = build({ clipboardText: PENDING_TEXT });
    let releaseFlush;
    const flushGate = new Promise((resolve) => {
      releaseFlush = resolve;
    });
    let flushCalls = 0;
    let seq = 0;
    ctx.api.captureFlushWatch = async () => {
      flushCalls += 1;
      await flushGate;
      seq += 1;
      return { ok: true, data: { enabled: true, recorded: false, gesture: `g-${seq}` } };
    };
    const ui = captureUiModule.create(ctx.host);
    const first = ui.open();
    const second = ui.open();
    releaseFlush();
    const [opened, rejected] = await Promise.all([first, second]);
    assert.equal(flushCalls, 1, '连按两下只补一拍（不会换第二张凭证顶掉第一张）');
    assert.equal(rejected.ok, false, '后到的那次不开第二次');
    assert.equal(rejected.code, 'OPENING');
    assert.equal(opened.ok, true, '第一次照常打开');
    assert.equal(ui.isOpen(), true);
    assert.equal(ctx.log.filter((item) => item === 'api.captureClipboard').length, 1, '只读一次剪贴板');
    assert.equal(ctx.log.filter((item) => item === 'api.captureQueueList').length, 1, '只拉一次队列');
  }));

test('WP-17（C35）：弹层清单走统一注册表——17 个 backdrop 里除自己外任一开着都拦下捕获面板', () =>
  withFakeDocument(async () => {
    const blockedLayers = backdropRegistry.LIST.filter((name) => name !== 'capture');
    assert.equal(blockedLayers.length, 16, '注册表 17 层，除 capture 自己外都要拦');
    for (const name of blockedLayers) {
      const ctx = build();
      ctx.dom.map.get(`${name}-backdrop`).classList.remove('hidden');
      const ui = captureUiModule.create(ctx.host);
      assert.equal((await ui.open('正文')).code, 'PANEL_BUSY', `${name} 开着时捕获面板不该叠上来`);
      assert.equal(ui.isOpen(), false, `${name} 挡下时不许打开面板`);
      assert.ok(
        ctx.log.includes('toast:warn:先关闭当前弹窗，再从剪贴板捕获'),
        `${name} 挡下时要给同一句提示`
      );
      assert.equal(ctx.log.includes('api.captureQueueList'), false, '被挡时不读队列');
    }

    // 自己那层（capture-backdrop）不算阻塞：面板已开着时由 preflight 的 ALREADY_OPEN 先挡，
    // panelBlocked 的 except 保证不会把自己算成「别的弹窗挡着」。
    const selfCtx = build();
    selfCtx.dom.map.get('capture-backdrop').classList.remove('hidden');
    const uiSelf = captureUiModule.create(selfCtx.host);
    const opened = await uiSelf.open('正文');
    assert.equal(opened.ok, true, 'capture-backdrop 不该被当成别的弹层');
    assert.equal(uiSelf.isOpen(), true);
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
    assert.equal(ctx.dom.map.get('capture-queue-empty').dataset.emptyKind, 'vacuum');
    assert.ok(ctx.log.some((item) => item.startsWith('toast:info:已插入正文')));
  }));

// V108（v1.8.0 WP-24）：面板里的「N 字」、插入成功后 toast 里的字数、状态栏本章字数必须是
// 同一个数字（都走 core/chapters.js 的 countChars，去空白）。以前 pending 行用原文长度，
// 含缩进 / 空行时同一段文字在列表与状态栏会差 10%+。
test('V108/WP-24：pending / 队列记录的「N 字」= 插入回报的字数（同一段文字不再有两个字数）', () =>
  withFakeDocument(async () => {
    const spaced = '　　第一段 正文。\n\n第二段\t正文。';
    const expected = capture.countChars(spaced);
    assert.ok(expected < spaced.length, '样本必须含空白，否则这个用例证明不了口径');

    const ctx = build({ clipboardText: spaced });
    const ui = captureUiModule.create(ctx.host);
    await ui.open();
    assert.equal(ui.records().length, 1);
    assert.equal(ui.records()[0].kind, 'pending');
    assert.equal(ui.records()[0].chars, expected, '列表行按去空白字数显示');
    assert.equal(
      recordEls(ctx.dom)[0].children[0].children[1].textContent.startsWith(`${expected} 字`),
      true,
      'DOM 里的「N 字」= 去空白字数'
    );

    const result = await ui.applyBody({ pending: true });
    assert.equal(result.ok, true);
    assert.equal(result.chars, expected, '插入回报的字数与列表同一口径（状态栏也用这个数）');
    assert.ok(ctx.log.includes(`toast:info:已插入正文（${expected} 字），这条记录已从列表移除`));

    // 队列条目走主进程契约：list() 的 chars 与 get() 的原文同一口径（都去空白）
    const queued = build({ queue: [{ text: QUEUE_A }] });
    const uiQueued = captureUiModule.create(queued.host);
    await uiQueued.open();
    assert.equal(uiQueued.records()[0].chars, capture.countChars(QUEUE_A));
    assert.ok(
      uiQueued.records()[0].chars < QUEUE_A.length,
      '样本含空行：raw 长度更大，正说明两者不是一回事'
    );
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
    // 审计修复 #42（V405）+ WP14 E-N9：删队列失败必须出声，而且只发一条合并提示——
    // 以前 warn「没能从队列移除」之后还无条件跟一条「已从列表移除」，两条自相矛盾。
    assert.ok(
      ctx.log.includes(
        `toast:warn:已插入正文（${result.chars} 字），但这条记录没能从队列移除（本窗口已隐藏它，刷新不会再画回来；其它窗口若仍出现请勿重复插入）`
      ),
      '删队列失败要有一条合并后的 warn 提示'
    );
    assert.equal(
      ctx.log.some((item) => item.includes('这条记录已从列表移除')),
      false,
      '删队列失败时不许再报「已从列表移除」'
    );
    assert.equal(ctx.log.filter((item) => item.startsWith('toast:')).length, 1, '插入结果只发一条提示');

    // 再刷新一次（模拟作者又复制了一段 → clipboard:recorded → refreshQueue 全量重拉）：
    // 主进程队列里这条还在，但本地消费登记把它挡住 —— 不许画回来，否则再点「正文」就是重复插入。
    await ui.refreshQueue();
    assert.deepEqual(ui.records().map((item) => item.id), [2], '刷新后也不许把已消费的那条画回来');
    assert.equal(
      ui.records()[0].kind,
      'queue',
      '剩下的仍是那条没处理过的队列记录'
    );

    // 面板关掉再打开（fetchQueue 同样过滤）：不许借「重新打开」绕开消费登记
    ui.close();
    await ui.open();
    assert.deepEqual(ui.records().map((item) => item.id), [2], '关掉再打开也不许画回来');
  }));

test('正文：清空队列成功后消费登记作废（新记录不会被上一次失败的登记误过滤）', () =>
  withFakeDocument(async () => {
    const ctx = build({ queue: [{ text: QUEUE_A }], removeFails: true });
    const ui = captureUiModule.create(ctx.host);
    await ui.open();
    await ui.applyBody({ id: 1 });
    assert.deepEqual(ui.records().map((item) => item.id), [], '失败的这一条已从本地列表摘掉');
    // 主进程清空成功：队列真空，消费登记必须一起作废
    ctx.queue.length = 0;
    await ui.clearQueue();
    // 之后主进程又有了一条新记录（id 复用也不该被上一次的登记挡住）
    ctx.queue.push({ id: 1, text: QUEUE_B, chars: capture.countChars(QUEUE_B), rawLength: QUEUE_B.length, at: 1762340000000 });
    await ui.refreshQueue();
    assert.deepEqual(ui.records().map((item) => item.id), [1], '清空之后的新记录照常显示');
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
  withFakeDocument(async () => {
    const ctx = build({ queue: [{ text: QUEUE_A }, { text: QUEUE_B }] });
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

// 五-H5（L-F6）：静默保存后发现编辑区仍脏（保存期间输入）——必须停下询问，不建章、不消费记录。
// 旧实现只看 saved.ok，直接 captureCommitRecord + loadChapterAt，把这份输入静默盖掉（H1 族新入口）。
test('五-H5：有统一原语时「章节」走它；保存回执后仍脏就停下，不建章、不消费记录', () =>
  withFakeDocument(async () => {
    const seen = [];
    const ctx = build({
      dirty: true,
      extraHost: {
        saveForTransition: async (options) => {
          seen.push(options);
          return { ok: false, canceled: true };
        }
      }
    });
    const ui = captureUiModule.create(ctx.host);
    await ui.open('正文一段');
    const result = await ui.createChapter({ pending: true });
    assert.equal(result.ok, false);
    assert.equal(result.canceled, true, '作者取消 → 调用方要知道这是取消而不是写盘失败');
    assert.equal(seen.length, 1, '走统一原语，不再自己 saveCurrent');
    assert.equal(seen[0].silentFirst, true, '「章节」沿用静默保存口径（首趟不弹窗）');
    assert.equal(ctx.log.includes('saveCurrent'), false, '有原语就不再自己保存');
    assert.equal(ctx.commitPayloads.length, 0, '没保存干净就不许建章写盘');
    assert.equal(ui.isOpen(), true);
    assert.equal(ui.isBusy(), false, '失败后要解锁');
    assert.deepEqual(ui.records().map((item) => item.kind), ['pending'], '记录保留，可以再处理');
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

test('章节：直捕 >30 万字 → 不调写盘 IPC、toast + 显示「去导入小说…」；普通捕获不显示', () =>
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

test('章节：原文 >300 万字符（空白重型）→ 渲染层按同一闸提前拦下 + 「去导入小说…」，不调写盘 IPC（台账 #2）', () =>
  withFakeDocument(async () => {
    // 去空白字数很小、原文长度超过 MAX_RAW_CHARS：正是审计 B3 的空白重型 payload。
    const hugeRaw = `${'\n'.repeat(capture.MAX_RAW_CHARS + 10)}正文一段`;
    const ctx = build({ clipboardText: hugeRaw });
    const ui = captureUiModule.create(ctx.host);
    await ui.open();
    assert.ok(capture.countChars(hugeRaw) < capture.MAX_BODY_CHARS, '样本字数不超限，只有原文长度超限');
    const result = await ui.createChapter({ pending: true });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'TOO_LARGE');
    assert.equal(result.reason, 'raw', '必须能区分「原文太长」与「字数太长」');
    assert.equal(ctx.commitPayloads.length, 0, '注定被主进程拒绝的 payload 不再发 IPC');
    assert.equal(ctx.log.some((item) => item.startsWith('saveCurrent')), false, '闸门在保存当前章之前');
    const warn = ctx.log.find((item) => item.startsWith('toast:warn:原文太长'));
    assert.ok(warn, '要与主进程同口径提示原文太长');
    assert.match(warn, /去导入小说/, '空白重型 payload 也要给「去导入小说…」出口（台账 #2）');
    assert.equal(ctx.dom.map.get('btn-capture-import').classList.contains('hidden'), false, '显示导入入口');
    assert.deepEqual(ui.records().map((item) => item.kind), ['pending'], '超限时记录保留');
    assert.equal(ui.isBusy(), false);
  }));

test('章节：载章失败 → 不报成功、index 对齐编辑区实际章、记录仍算消费（E-N10）', () =>
  withFakeDocument(async () => {
    const chapters = [
      { id: 'ch_a', name: '旧章', volumeId: 'vol-1' },
      { id: 'ch_b', name: '第二章', volumeId: null }
    ];
    // 新章插到当前章之前（按卷插入的真实情形）：载章失败后旧的 state.index 会指向新章，
    // 下次保存就会拿旧章正文按新章身份写 → CHAPTER_MISMATCH。
    const ctx = build({
      clipboardText: PENDING_TEXT,
      chapters,
      index: 0,
      loadedChapterId: 'ch_a',
      commitIndex: 0,
      loadFails: true
    });
    const ui = captureUiModule.create(ctx.host);
    await ui.open();
    const result = await ui.createChapter({ pending: true });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'LOAD_FAILED');
    assert.equal(result.index, 0, '新章确实建好了（回包带它的下标）');
    assert.equal(
      ctx.log.some((item) => item.startsWith('toast:info:已从剪贴板新建：')),
      false,
      '载章失败不许报「已从剪贴板新建」成功'
    );
    const errorToast = ctx.log.find((item) => item.startsWith('toast:error:'));
    assert.ok(errorToast, '必须给一条 error');
    assert.match(errorToast, /已新建章节/);
    assert.match(errorToast, /打开新章失败/);
    assert.match(errorToast, /读取新章失败/, '带上载章失败原因');
    // 编辑区仍是 ch_a：index 必须对齐到它在新闻目里的新位置（0 → 1）
    assert.equal(ctx.state.index, 1, 'state.index 跟随编辑区实际章');
    assert.equal(ctx.state.loadedChapterId, 'ch_a');
    assert.equal(ctx.state.chapters.length, 3);
    // 正文已落盘 = 记录已消费：pending 清空、队列重拉，再点不会重复建章
    assert.deepEqual(ui.records().map((item) => item.kind), []);
    const loadAt = ctx.log.indexOf('loadChapterAt:0');
    const listCalls = ctx.log
      .map((value, index) => ({ value, index }))
      .filter((item) => item.value === 'api.captureQueueList');
    assert.ok(listCalls.some((item) => item.index > loadAt), '失败后也要重拉队列');
    assert.equal(ctx.commitPayloads.length, 1);
    await ui.createChapter({ pending: true });
    assert.equal(ctx.commitPayloads.length, 1, '记录已消费，再点不会重复建章');
    assert.equal(ui.isBusy(), false);
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
    assert.equal(
      ui.queueSummaryText(),
      '本次运行还没有记到复制过的文字（只在本机内存，关闭应用即清空）。'
    );
    const empty = ctx.dom.map.get('capture-queue-empty');
    assert.equal(empty.classList.contains('hidden'), false);
    assert.equal(empty.dataset.emptyKind, 'vacuum');
    assert.equal(
      empty.textContent,
      '在「设置 → 写作统计」里打开「后台监听剪贴板」后，复制的新文字会各记一条；' +
        '也可以直接按 Ctrl+Alt+V 捕获当前剪贴板的一段。每条记录右侧点「正文」或「章节」处理，处理完就从列表移除。'
    );
    assert.equal(ctx.dom.map.get('btn-capture-queue-clear').disabled, true, '空列表时清空按钮禁用');
    assert.ok(ctx.log.some((item) => item.startsWith('toast:info:已清空本次运行的捕获队列')));
  }));

test('refreshQueue：新复制进来原地刷新（pending 保留）；面板没开不调 IPC', () =>
  withFakeDocument(async () => {
    const ctx = build({ queue: [{ text: QUEUE_A }] });
    const ui = captureUiModule.create(ctx.host);
    await ui.openTriggered(PENDING_TEXT, false);
    ctx.queue.push({
      id: 9,
      text: QUEUE_B,
      chars: capture.countChars(QUEUE_B),
      rawLength: QUEUE_B.length,
      at: 1762350000000
    });
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
