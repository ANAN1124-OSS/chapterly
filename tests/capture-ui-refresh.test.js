// 剪贴板面板测试（T9 / 第 9 轮按性质拆分）：剪贴板面板的刷新竞态与清空失败。
//
// 来源：原 tests/capture-ui.test.js（1,921 行）拆成夹具 + 三个文件，**只搬家不改断言**——
// 用例标题与断言逐字保留，共用夹具收进 tests/capture-ui-fixtures.js。
// 本文件覆盖：V35 一次性挂载 DocumentFragment / WP-15 的旧快照不覆盖新刷新（两种在途回执）/ WP-16 清空失败
// 复位的两例 + 静态闸门 / RPAN-A-04 busy 期间刷新补拉 / 五-M4 换书在途回执丢弃。
const test = require('node:test');
const assert = require('node:assert/strict');
const { captureUiModule, moduleSrc, actionButtons, QUEUE_A, QUEUE_B, build, withFakeDocument } = require('./capture-ui-fixtures');

// V35：整队列先离线拼进 DocumentFragment，再一次性挂上；不许再逐条 appendChild 到 live 列表。
test('长列表渲染：队列先拼 DocumentFragment 再一次性挂载（V35）', () => {
  assert.match(moduleSrc, /document\.createDocumentFragment\(\)/, '队列渲染应先离线拼装');
  assert.match(moduleSrc, /listEl\.appendChild\(frag\)/, '队列应当一次性挂载');
  assert.doesNotMatch(moduleSrc, /for \(const record of records\) listEl\.appendChild/, '不许逐条 appendChild 到 live 容器');
});

// ---------- WP-15 / C36：队列刷新的世代令牌 ----------
test('refreshQueue（WP-15 / C36）：先发后到的旧队列快照不覆盖后发的新刷新', () =>
  withFakeDocument(async () => {
    const ctx = build({ queue: [{ text: QUEUE_A }] });
    const ui = captureUiModule.create(ctx.host);
    await ui.open();
    const gates = [];
    ctx.api.captureQueueList = () => new Promise((resolve) => gates.push(resolve));

    const first = ui.refreshQueue();
    const second = ui.refreshQueue();
    assert.equal(gates.length, 2, '两次刷新都要真的发 IPC');
    gates[1]({
      ok: true,
      data: {
        entries: [
          { id: 1, chars: 3, at: 1, previewText: '甲' },
          { id: 9, chars: 3, at: 2, previewText: '乙' }
        ],
        total: 2
      }
    });
    await second;
    assert.deepEqual(ui.records().filter((item) => item.kind === 'queue').map((item) => item.id), [1, 9]);

    gates[0]({ ok: true, data: { entries: [{ id: 1, chars: 3, at: 1, previewText: '甲' }], total: 1 } });
    await first;
    assert.deepEqual(
      ui.records().filter((item) => item.kind === 'queue').map((item) => item.id),
      [1, 9],
      '旧刷新回执作废，队列不许被旧快照盖回去'
    );
  }));

test('refreshQueue（WP-15 / C36）：清空期间在途的刷新回执不许把记录画回来', () =>
  withFakeDocument(async () => {
    const ctx = build({ queue: [{ text: QUEUE_A }] });
    const ui = captureUiModule.create(ctx.host);
    await ui.open();
    let release;
    ctx.api.captureQueueList = () => new Promise((resolve) => { release = resolve; });

    const refreshing = ui.refreshQueue();
    const cleared = await ui.clearQueue();
    assert.equal(cleared.ok, true);
    assert.deepEqual(ui.records(), [], '清空后面板立即空');
    release({ ok: true, data: { entries: [{ id: 1, chars: 3, at: 1, previewText: '甲' }], total: 1 } });
    await refreshing;
    assert.deepEqual(ui.records(), [], '清空开始即作废在途刷新，旧快照不许复活记录');
  }));

// ---------- WP-16 / C14：清空队列的失败路径也要把 busy 画面画回去 ----------
test('清空队列（WP-16 / C14）：IPC 失败 → busy 复位、按钮 / 记录回到可用态、失败文案逐字', () =>
  withFakeDocument(async () => {
    let release;
    const ctx = build({ queue: [{ text: QUEUE_A }, { text: QUEUE_B }] });
    ctx.api.captureQueueClear = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const ui = captureUiModule.create(ctx.host);
    await ui.open();
    const clearing = ui.clearQueue();
    // 在途：列表与按钮先按 busy 禁用（作者看到的是「处理中」）
    assert.equal(ui.isBusy(), true);
    assert.deepEqual(
      actionButtons(ctx.dom).map((btn) => btn.disabled),
      [true, true, true, true]
    );
    assert.equal(ctx.dom.map.get('btn-capture-queue-clear').disabled, true);
    assert.equal(ctx.dom.map.get('btn-capture-queue-cancel').disabled, true);
    release({ ok: false, code: 'IPC_ERROR', message: '主进程不可用' });
    const result = await clearing;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'IPC_ERROR');
    assert.equal(result.message, '主进程不可用');
    assert.equal(ui.isBusy(), false, '失败后必须复位 busy');
    assert.equal(ui.isOpen(), true, '失败不关面板');
    assert.deepEqual(
      ui.records().map((item) => item.kind),
      ['queue', 'queue'],
      '清空失败，记录原样保留'
    );
    // C14 本体：旧实现只在成功路径 render，失败后按钮停在 busy 期的禁用画面
    assert.deepEqual(
      actionButtons(ctx.dom).map((btn) => btn.disabled),
      [false, false, false, false],
      '动作按钮必须重画回可点'
    );
    assert.equal(ctx.dom.map.get('btn-capture-queue-clear').disabled, false, '清空按钮必须重画回可点');
    assert.equal(ctx.dom.map.get('btn-capture-queue-cancel').disabled, false, '取消按钮必须重画回可点');
    assert.deepEqual(
      actionButtons(ctx.dom).map((btn) => btn.dataset.id || btn.dataset.pending),
      ['1', '1', '2', '2'],
      '放在记录上的动作按钮仍对应原记录'
    );
    assert.ok(
      ctx.log.some((item) => item === 'toast:error:清空捕获队列失败：主进程不可用'),
      '失败文案逐字'
    );
    assert.equal(
      ctx.log.some((item) => item.startsWith('toast:info:已清空本次运行的捕获队列')),
      false,
      '失败不许报成功'
    );
  }));

test('清空队列（WP-16 / C14）：失败后按钮可用、能再点一次；成功文案与空态逐字不变', () =>
  withFakeDocument(async () => {
    const ctx = build({ queue: [{ text: QUEUE_A }, { text: QUEUE_B }] });
    let attempts = 0;
    ctx.api.captureQueueClear = async () => {
      attempts += 1;
      ctx.log.push(`api.captureQueueClear:${attempts}`);
      if (attempts === 1) return { ok: false, code: 'IPC_ERROR', message: '主进程不可用' };
      const cleared = ctx.queue.length;
      ctx.queue.length = 0;
      return { ok: true, data: { cleared } };
    };
    const ui = captureUiModule.create(ctx.host);
    await ui.open();
    const failed = await ui.clearQueue();
    assert.equal(failed.ok, false);
    assert.equal(ui.isBusy(), false);
    assert.equal(
      ctx.dom.map.get('capture-queue-empty').classList.contains('hidden'),
      true,
      '失败时记录还在，空态不出现'
    );

    const cleared = await ui.clearQueue();
    assert.equal(cleared.ok, true);
    assert.equal(cleared.cleared, true);
    assert.equal(attempts, 2, '失败后按钮可用，作者能再点一次');
    assert.equal(ui.records().length, 0);
    assert.equal(
      ui.queueSummaryText(),
      '本次运行还没有记到复制过的文字（只在本机内存，关闭应用即清空）。'
    );
    assert.equal(
      ui.queueEmptyText(),
      '在「设置 → 写作统计」里打开「后台监听剪贴板」后，复制的新文字会各记一条；' +
        '也可以直接按 Ctrl+Alt+V 捕获当前剪贴板的一段。每条记录右侧点「正文」或「章节」处理，处理完就从列表移除。'
    );
    assert.equal(ctx.dom.map.get('capture-queue-empty').dataset.emptyKind, 'vacuum');
    assert.equal(ctx.dom.map.get('btn-capture-queue-clear').disabled, true, '清空后按钮禁用');
    assert.ok(ctx.log.some((item) => item.startsWith('toast:info:已清空本次运行的捕获队列')));
  }));

test('静态闸门（WP-16 / C14）：clearQueue 的 finally 统一复位 busy 并重画', () => {
  const start = moduleSrc.indexOf('async function clearQueue');
  assert.ok(start > 0, '模块里应有 clearQueue');
  const end = moduleSrc.indexOf('\n    }', start);
  assert.ok(end > start, '要能截出 clearQueue 函数体');
  const body = moduleSrc.slice(start, end);
  // RPAN-A-04：busy 复位 + 重画收敛到 endBusy()（并负责补拉 busy 期间被丢弃的队列刷新）。
  assert.match(
    body,
    /finally\s*\{[\s\S]*?endBusy\(\);/,
    'busy 复位必须走 endBusy()（失败路径也要把按钮画回可用态）'
  );
  const endBusyAt = moduleSrc.indexOf('function endBusy()');
  assert.ok(endBusyAt > 0, '模块里应有 endBusy() 收尾 helper');
  const endBusyEnd = moduleSrc.indexOf('\n    }', endBusyAt);
  const endBusyBody = moduleSrc.slice(endBusyAt, endBusyEnd);
  assert.match(endBusyBody, /panel\.busy = false;[\s\S]*?render\(\);/, 'endBusy 必须复位 busy 并重画');
  assert.match(body, /refreshSeq\.next\(\)/, 'WP-15 / C36：清空开始即作废在途刷新，不能被这次重画弄丢');
  // TESTC-01：只钉「成功文案只留一处」，不钉引号 / 包裹写法（文案本身仍必须出现）。
  assert.equal(
    (body.match(/toast\([^)]*已清空本次运行的捕获队列[^)]*\)/g) || []).length,
    1,
    '成功文案只留一处，且仍在 try 之后'
  );
});

// RPAN-A-04：busy 期间（正文插入 / 新建章节 / 清空，两次 IPC 往返可达数百毫秒）到达的
// clipboard:recorded 会被 refreshQueue 早退丢弃，事后也不补拉 —— 作者刚复制的一段不在列表里，
// 看起来像「没记上」。修法：busy 早退时登记补拉请求，动作收尾 endBusy() 补一次。
test('RPAN-A-04：busy 期间到达的队列刷新不丢，动作收尾补拉一次', () =>
  withFakeDocument(async () => {
    let releaseInsert;
    const gate = new Promise((resolve) => {
      releaseInsert = resolve;
    });
    const ctx = build({
      queue: ['第一条复制', '第二条复制'],
      // 删队列失败：这条路径不 reloadQueue，补拉次数可以精确数（成功路径本身还会再拉一次）
      removeFails: true,
      insertIntoBody: async () => {
        await gate;
        return { ok: true, chars: 4 };
      }
    });
    const ui = captureUiModule.create(ctx.host);
    await ui.open();
    const listCalls = () => ctx.log.filter((item) => item === 'api.captureQueueList').length;
    const before = listCalls();
    const applying = ui.applyBody({ id: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ui.isBusy(), true, '插入正文应处于 busy');
    // 忙期间「又复制了一段」：renderer 的 clipboard:recorded 会调 refreshQueue —— 这次请求不许被丢掉
    await ui.refreshQueue();
    assert.equal(listCalls(), before, 'busy 期间不立刻发刷新（防旧快照盖回 / 白跑 IPC）');
    // 模拟这段复制已入主进程队列
    ctx.queue.push({ id: 99, text: '忙时复制的一段', chars: 7, rawLength: 7, at: 1762340100000 });
    releaseInsert();
    await applying;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(listCalls(), before + 1, '动作收尾必须补拉一次队列');
    assert.ok(
      ui.records().some((record) => String(record.previewText).includes('忙时复制的一段')),
      '补拉后 busy 窗口内复制的记录必须出现在列表上'
    );
    // 没有错过请求时，收尾不再多发一次（补拉请求是一次性的）
    const settled = listCalls();
    await ui.refreshQueue();
    assert.equal(listCalls(), settled + 1, '非 busy 的刷新照旧立即发');
  }));

// 五-M4（BP-04）：新建章节 commit 回执落地前核书身份——在途换书不许把旧书的 meta/chapters
// 盖进新书状态（否则目录 / 统计显示旧书，loadChapterAt 还会按「新书路径 + 旧章 file」读错对象）。
test('五-M4：新建章节 commit 在途换书 → 回执丢弃、状态不被旧书覆盖，记录仍算消费', () =>
  withFakeDocument(async () => {
    const ctx = build();
    const ui = captureUiModule.create(ctx.host);
    await ui.open('正文一段');
    const chaptersBefore = ctx.state.chapters.length;
    const commit = ctx.api.captureCommitRecord;
    ctx.api.captureCommitRecord = async (...args) => {
      const res = await commit(...args);
      ctx.state.bookPath = '/tmp/books/书乙'; // openBook 回执先提交了新书
      return res;
    };
    const result = await ui.createChapter({ pending: true });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'BOOK_CHANGED');
    assert.equal(ctx.state.bookPath, '/tmp/books/书乙');
    assert.equal(ctx.state.chapters.length, chaptersBefore, '旧书的章节数组不许盖进新书状态');
    assert.equal(ctx.state.meta.chapters.length, chaptersBefore, '旧书 meta 不许盖回来');
    const toastLine = ctx.log.find((line) => line.startsWith('toast:warn:'));
    assert.ok(toastLine, '要有一条提示');
    assert.match(toastLine, /已新建章节「撞见了幽灵」/);
    assert.match(toastLine, /你已经切换了书/);
    assert.match(toastLine, /新章在《书甲》里/);
    assert.deepEqual(ui.records(), [], '主进程已写章 = 记录已消费（不许重复插入）');
    assert.equal(ui.isBusy(), false);
  }));
