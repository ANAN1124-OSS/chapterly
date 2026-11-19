// WP6（N2，审计中 #7）的渲染层换根通知单测。
//
// 场景：多窗口 A 在设置里换了书架根目录 → 主进程广播 config:changed → 窗口 B 里开着旧根的
// 书成了「孤岛」：所有书域 IPC 都会用新的 cfg.booksRoot 过 assertBookPath，保存从此 BAD_PATH；
// 修前渲染层既没有通知通道，也没有救稿出口（RESCUE_CODES 不含 BAD_PATH）。N2 的三个验收锚点：
//   ① 多窗口 A 换根 → B 即时感知（一次性提示，不反复打断）；
//   ② 旧根书保存失败有救稿出口（另存 / 复制正文）；
//   ③「继续上次写作」旧根入口隐藏（既有 continueTarget 口径，见 tests/shelf-ui.test.js）。
// 这里用假 host 逐条钉「点了哪个按钮 → 谁被调用、提示是什么、dirty 有没有被动」，再用静态闸门
// 保证 main.js 广播 / preload 通道 / index.html + 装配清单 / renderer.js 接线不会在以后被改回去。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const configChangeUi = require('../renderer/config-change-ui');
const manifest = require('../renderer/assembly-manifest');
const { loadSourceGate } = require('./ui-test-preambles');

const ROOT = path.join(__dirname, '..');
const { rendererCode, indexSrc, moduleSrc, moduleCode } = loadSourceGate('config-change-ui.js');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const OLD_ROOT_BOOK = 'C:/旧书架/书甲';
const NEW_ROOT = 'D:/新书架';

function makeHost(options = {}) {
  const calls = { modal: [], toast: [], rescue: [], shelf: [], refreshShelf: 0, refreshConfig: 0 };
  const state = {
    view: options.view === undefined ? 'editor' : options.view,
    bookPath: options.bookPath === undefined ? OLD_ROOT_BOOK : options.bookPath,
    dirty: options.dirty === undefined ? true : Boolean(options.dirty),
    // 五-M17（SS-08）：当前生效配置（booksRoot 由 refreshConfig 刷新）——提示期间的根 / 书变化
    // 要靠它复核「还是不是孤岛」。老用例不传 = 没有配置快照，退回按 payload 里的根判定。
    config: options.config === undefined ? null : options.config
  };
  const host = {
    state,
    openModal: async (payload) => {
      calls.modal.push(payload);
      if (typeof options.onModal === 'function') options.onModal(state);
      const action = typeof options.modalAction === 'function'
        ? options.modalAction(payload)
        : (options.modalAction === undefined ? 'stay' : options.modalAction);
      return { action };
    },
    toast: (message, kind) => calls.toast.push([message, kind]),
    rescueCopy: async (mode) => {
      calls.rescue.push(mode);
      if (options.rescueThrows) throw new Error('EPERM: 写盘被拒');
      return { canceled: false, filePath: 'C:/tmp/救稿.txt' };
    },
    goBackToShelf: async () => {
      calls.shelf.push(true);
      if (options.backThrows) throw new Error('releaseBook 失败');
    },
    refreshShelf: async () => {
      calls.refreshShelf += 1;
      if (options.refreshShelfThrows) throw new Error('列目录失败');
    },
    refreshConfig: async () => {
      calls.refreshConfig += 1;
      if (options.refreshConfigThrows) throw new Error('config:get 失败');
    }
  };
  return { host, state, calls };
}

function create(host) {
  return configChangeUi.create(host);
}

function rootPayload(booksRoot = NEW_ROOT) {
  return { reason: 'booksRoot', booksRoot };
}

// ---------- 契约 ----------
test('契约：REQUIRED_HOST 逐成员校验（缺一个 / null 都当场 TypeError）', () => {
  assert.deepEqual(
    [...configChangeUi.REQUIRED_HOST],
    ['state', 'openModal', 'toast', 'rescueCopy', 'goBackToShelf', 'refreshShelf', 'refreshConfig']
  );
  assert.throws(() => configChangeUi.create(null), /createConfigChangeUi 需要 host 对象/);
  assert.throws(() => configChangeUi.create('x'), /createConfigChangeUi 需要 host 对象/);
  for (const key of configChangeUi.REQUIRED_HOST) {
    const { host } = makeHost();
    delete host[key];
    assert.throws(() => configChangeUi.create(host), /缺少/, key);
    const { host: nulled } = makeHost();
    nulled[key] = null;
    assert.throws(() => configChangeUi.create(nulled), /缺少/, `${key}（null 也算缺）`);
  }
  assert.doesNotThrow(() => configChangeUi.create(makeHost().host));
});

// ---------- R1：纯判定 ----------
test('R1（N2）：isInsideRoot 认大小写 / 正反斜杠 / 末尾分隔符 / 中文空格路径，同前缀兄弟目录算外', () => {
  const cases = [
    ['C:/书架/测试书', 'C:/书架', true],
    ['c:\\书架\\测试书', 'C:/书架/', true],
    ['C:/书架/测试书/', 'c:\\书架\\', true],
    ['C:/书架', 'C:/书架', true, '书路径等于根（不是孤岛：根目录本身不在书架里，宁可当可访问）'],
    ['D:/我的 书架/中文 书', 'd:\\我的 书架', true],
    ['C:/书架2/测试书', 'C:/书架', false, '同前缀兄弟目录不在根下'],
    ['C:/书架/../别人/书', 'C:/书架', false, '含 .. 段一律当外'],
    [' ', 'C:/书架', false],
    ['C:/书架/测试书', '', false],
    ['', 'C:/书架', false],
    [null, 'C:/书架', false],
    ['C:/书架/测试书', 1234, false],
    ['相对路径/测试书', 'C:/书架', false]
  ];
  for (const [bookPath, booksRoot, expected, why] of cases) {
    assert.equal(configChangeUi.isInsideRoot(bookPath, booksRoot), expected, `${bookPath} @ ${booksRoot}：${why || ''}`);
  }
  // 归一化只用于判定：统一小写 / 正斜杠、去掉末尾分隔符，不改中文与空格
  assert.equal(configChangeUi.normalizeRootPath('  C:\\我的 书架\\  '), 'c:/我的 书架');
  assert.equal(configChangeUi.normalizeRootPath('D:/书库//'), 'd:/书库');
  assert.equal(configChangeUi.normalizeRootPath(null), '');
});

test('R1b（N2）：strandedBook 只在「非书架视图 + 有书 + 书不在新根下」时为真', () => {
  assert.equal(configChangeUi.strandedBook({ view: 'editor', bookPath: OLD_ROOT_BOOK }, NEW_ROOT), true);
  assert.equal(configChangeUi.strandedBook({ view: 'reading', bookPath: OLD_ROOT_BOOK }, NEW_ROOT), true);
  assert.equal(configChangeUi.strandedBook({ view: 'shelf', bookPath: OLD_ROOT_BOOK }, NEW_ROOT), false);
  assert.equal(configChangeUi.strandedBook({ view: 'editor', bookPath: null }, NEW_ROOT), false);
  assert.equal(configChangeUi.strandedBook({ view: 'editor', bookPath: 'D:/新书架/书乙' }, NEW_ROOT), false);
  assert.equal(configChangeUi.strandedBook(null, NEW_ROOT), false);
});

// ---------- R2：孤岛一次性提示 ----------
test('R2（N2）：孤岛书收到换根 → 弹「书架目录已更换」四出口，正文与 dirty 一个字节都不动', async () => {
  const { host, state, calls } = makeHost({ modalAction: 'stay' });
  const result = await create(host).handleConfigChanged(rootPayload());

  assert.equal(calls.modal.length, 1, '孤岛书必须收到一次性提示');
  const modal = calls.modal[0];
  assert.equal(modal.title, '书架目录已更换');
  assert.match(modal.message, /另一个窗口把书架目录改成了「D:\/新书架」/);
  assert.match(modal.message, /旧目录/, '要点明这本书在旧目录里');
  assert.match(modal.message, /先另存/, '要给出救稿指引');
  assert.deepEqual(modal.buttons, [
    { label: '留在这里', value: 'stay' },
    { label: '复制正文', value: 'copy' },
    { label: '回书架', value: 'shelf' },
    { label: '另存这一章为 txt…', value: 'save', kind: 'primary' }
  ]);
  assert.equal(modal.cancelValue, 'stay');
  assert.equal(state.dirty, true, '提示不是「丢弃」：dirty 必须保留');
  assert.equal(host.state.bookPath, OLD_ROOT_BOOK, '提示不改当前书身份');
  assert.deepEqual(calls.rescue, [], '选「留在这里」不碰救稿 IPC');
  assert.deepEqual(calls.shelf, [], '选「留在这里」不回书架');
  assert.ok(
    calls.toast.some(([message, kind]) => kind === 'warn' && /保存会被阻止/.test(message)),
    '留在这里之后要有一条 warn，说明现在保存会被阻止'
  );
  assert.equal(result.handled, true);
  assert.equal(result.prompted, true);
  assert.equal(result.action, 'stay');
  assert.equal(calls.refreshConfig, 1, '收到换根先刷新本窗口的全局配置');
});

// ---------- R3：救稿出口 ----------
test('R3（N2）：提示里选「另存这一章为 txt…」/「复制正文」→ 复用救稿出口，失败明确报错', async () => {
  const saved = makeHost({ modalAction: 'save' });
  await create(saved.host).handleConfigChanged(rootPayload());
  assert.deepEqual(saved.calls.rescue, ['save'], '另存走 save-rescue-ui 同一条 chapter:rescue');
  assert.equal(saved.state.dirty, true);

  const copied = makeHost({ modalAction: 'copy' });
  await create(copied.host).handleConfigChanged(rootPayload());
  assert.deepEqual(copied.calls.rescue, ['copy']);

  const broken = makeHost({ modalAction: 'save', rescueThrows: true });
  await create(broken.host).handleConfigChanged(rootPayload());
  assert.ok(
    broken.calls.toast.some(([message, kind]) => kind === 'error' && /救稿出口失败/.test(message)),
    '救稿 IPC 自己失败也要给 error（不许静默）'
  );
  assert.equal(broken.state.dirty, true);
});

// ---------- R4：回书架 ----------
test('R4（N2）：提示里选「回书架」→ 走既有 backToShelf（有未保存仍由它先问）', async () => {
  const { host, calls } = makeHost({ modalAction: 'shelf' });
  const result = await create(host).handleConfigChanged(rootPayload());
  assert.deepEqual(calls.shelf, [true], '回书架交给既有 backToShelf，不在本模块里直接清状态');
  assert.deepEqual(calls.rescue, []);
  assert.equal(result.action, 'shelf');

  const broken = makeHost({ modalAction: 'shelf', backThrows: true });
  await create(broken.host).handleConfigChanged(rootPayload());
  assert.ok(
    broken.calls.toast.some(([message, kind]) => kind === 'error' && /返回书架失败/.test(message)),
    '回书架失败要给 error toast（不误报已回到书架）'
  );
});

// ---------- R5：一次性（同一个根只处理一次） ----------
test('R5（N2）：同一个根重复广播只提示一次；换另一个根再提示一次', async () => {
  const { host, calls } = makeHost({ modalAction: 'stay' });
  const ui = create(host);
  const first = await ui.handleConfigChanged(rootPayload('D:/新书架/'));
  const second = await ui.handleConfigChanged(rootPayload('d:\\新书架')); // 同根的不同写法
  assert.equal(first.handled, true);
  assert.equal(second.handled, false);
  assert.equal(second.reason, 'duplicate');
  assert.equal(calls.modal.length, 1, '同一个根只弹一次（多窗口先后 set 同一根也不重复打断）');
  assert.equal(calls.refreshConfig, 1, '重复通知连配置都不用再取');

  await ui.handleConfigChanged(rootPayload('E:/再换一个书架'));
  assert.equal(calls.modal.length, 2, '真的换了另一个根要重新提示');
});

// ---------- R6：非孤岛 / 书架 / 坏 payload ----------
test('R6（N2）：书在新根内只 toast 不弹窗；书架视图刷新书架；坏 payload 完全忽略', async () => {
  const inside = makeHost({ bookPath: 'D:/新书架/书乙', view: 'editor' });
  const insideResult = await create(inside.host).handleConfigChanged(rootPayload());
  assert.deepEqual(inside.calls.modal, [], '书在新根下：不打断作者');
  assert.equal(insideResult.prompted, false);
  assert.ok(
    inside.calls.toast.some(([message]) => /保存照常/.test(message)),
    '要告诉作者这本书仍可正常保存'
  );

  const shelf = makeHost({ view: 'shelf' });
  const shelfResult = await create(shelf.host).handleConfigChanged(rootPayload());
  assert.equal(shelf.calls.refreshShelf, 1, '书架视图收到换根要刷新成新目录的书架');
  assert.deepEqual(shelf.calls.modal, []);
  assert.ok(shelf.calls.toast.some(([message]) => /书架目录已更换/.test(message)));
  assert.equal(shelfResult.prompted, false);

  const ignored = makeHost();
  const ui = create(ignored.host);
  for (const payload of [null, undefined, 'x', [], {}, { reason: 'other', booksRoot: NEW_ROOT }, { reason: 'booksRoot' }, { reason: 'booksRoot', booksRoot: 123 }]) {
    const result = await ui.handleConfigChanged(payload);
    assert.equal(result.handled, false, JSON.stringify(payload));
  }
  assert.deepEqual(ignored.calls.modal, []);
  assert.deepEqual(ignored.calls.toast, []);
  assert.equal(ignored.calls.refreshShelf, 0);
});

// ---------- R7：失败注入（IO 失败不吞、不阻断） ----------
test('R7（N2）：refreshConfig / refreshShelf 失败不吞掉提示，也不假装刷新成功', async () => {
  const configBroken = makeHost({ modalAction: 'stay', refreshConfigThrows: true });
  const result = await create(configBroken.host).handleConfigChanged(rootPayload());
  assert.equal(result.prompted, true, '配置取失败不阻断孤岛提示（提示才是保命路径）');
  assert.equal(configBroken.calls.modal.length, 1);

  const shelfBroken = makeHost({ view: 'shelf', refreshShelfThrows: true });
  const shelfResult = await create(shelfBroken.host).handleConfigChanged(rootPayload());
  assert.equal(shelfResult.handled, true);
  assert.ok(
    shelfBroken.calls.toast.some(([message, kind]) => kind === 'error' && /刷新书架失败/.test(message)),
    '书架刷新失败要明确报错，不能让作者以为已经切到新目录'
  );
});

// ---------- 五-M17（SS-08）：换根孤岛提示按「当前生效根 / 当前书」复核 ----------
// 模态可能排队等一会儿：期间别的窗口把根换回去 / 再换、或作者切到新根下的另一本书，
// 已弹出的模态仍断言「现在保存会被阻止」并按旧文案执行救稿 / 回书架（会救错对象）。
// 修复后：答复后执行动作前按当前生效根 + 当前书复核，已不孤岛就撤销警告、不执行动作。
test('M17（SS-08）：提示期间根被换回（书已在新根下）→ 答复后不救稿、不弹旧路径，改发「提示已作废」', async () => {
  const host = makeHost({
    config: { booksRoot: NEW_ROOT },
    modalAction: 'copy',
    onModal: (state) => { state.config = { booksRoot: 'C:/旧书架' }; } // 提示期间根被换回这本书所在的目录
  });
  const result = await create(host.host).handleConfigChanged(rootPayload());
  assert.equal(host.calls.modal.length, 1, '提示照常先弹（当时确实孤岛）');
  assert.deepEqual(host.calls.rescue, [], '已经不再孤岛：不许再执行「复制正文」救稿');
  assert.equal(result.action, 'stale', '返回「提示已作废」而不是动作');
  assert.equal(result.prompted, true, '提示确实弹过');
  assert.ok(
    host.calls.toast.some(([message]) => /提示已作废/.test(message)),
    '要明确撤销过期警告（不能让作者以为还在孤岛）'
  );
  assert.equal(host.calls.toast.some(([message]) => /保存会被阻止/.test(message)), false, '过期警告不许再说一遍');
  assert.equal(host.state.bookPath, OLD_ROOT_BOOK, '不碰当前书身份');
});

test('M17（SS-08）：提示期间作者切到新根下的书 → 答复「回书架」也不执行；旧根下的书仍照旧执行', async () => {
  const switched = makeHost({
    config: { booksRoot: NEW_ROOT },
    modalAction: 'shelf',
    onModal: (state) => { state.bookPath = 'D:/新书架/书乙'; }
  });
  const switchedResult = await create(switched.host).handleConfigChanged(rootPayload());
  assert.deepEqual(switched.calls.shelf, [], '当前书已在新根下，回书架动作与换根无关，不再执行');
  assert.deepEqual(switched.calls.rescue, []);
  assert.equal(switchedResult.action, 'stale');
  assert.ok(switched.calls.toast.some(([message]) => /提示已作废/.test(message)));

  // 对照：提示期间什么都没变 → 动作照旧执行
  const still = makeHost({ config: { booksRoot: NEW_ROOT }, modalAction: 'shelf' });
  const stillResult = await create(still.host).handleConfigChanged(rootPayload());
  assert.deepEqual(still.calls.shelf, [true]);
  assert.equal(stillResult.action, 'shelf');
});

test('M17（SS-08）：收到的根已过期（当前生效根下这本书正常）→ 不弹过期提示，只提示保存照常', async () => {
  // 乱序 / 延迟到达的广播：本窗口已经刷新到 R1（书在根下），又收到一条 R2 的换根通知
  const host = makeHost({ config: { booksRoot: 'C:/旧书架' } });
  const result = await create(host.host).handleConfigChanged(rootPayload());
  assert.deepEqual(host.calls.modal, [], '按当前生效根判定：这本书不孤岛，不该弹保命提示');
  assert.ok(host.calls.toast.some(([message]) => /保存照常/.test(message)));
  assert.equal(result.prompted, false);
});

test('R1c（SS-08）：currentRoot 只认 state.config.booksRoot 的字符串值，取不到回空串（调用方再兜底）', () => {
  assert.equal(configChangeUi.currentRoot({ config: { booksRoot: ' C:/书架 ' } }), ' C:/书架 ');
  assert.equal(configChangeUi.currentRoot({ config: { booksRoot: 123 } }), '');
  assert.equal(configChangeUi.currentRoot({ config: null }), '');
  assert.equal(configChangeUi.currentRoot({}), '');
  assert.equal(configChangeUi.currentRoot(null), '');
});

// ---------- R8：静态接线 ----------
test('R8（N2）：装配接线——index 顺序 / 清单 / renderer 订阅 / preload 通道 / main 换根广播', () => {
  // 模块在浏览器里挂全局名、Node 里只取 assert-host（不碰 fs / IPC / document）
  assert.match(moduleSrc, /root\.CWConfigChangeUi = factory\(root\.CWAssertHost && root\.CWAssertHost\.assertHost\);/);
  const runtimeCode = moduleCode.split("module.exports = factory(require('../core/assert-host').assertHost);").join('');
  for (const forbidden of ['require(', 'ipcRenderer', 'node:fs', 'child_process', 'fetch(', 'document.']) {
    assert.equal(runtimeCode.includes(forbidden), false, `换根提示模块不该依赖 ${forbidden}`);
  }

  // index.html：只加载一次、排在 renderer.js 之前（救稿模块之后，同一块「保存/换根」）
  const order = [...indexSrc.matchAll(/<script src="([^"]+)"><\/script>/g)].map((hit) => hit[1]);
  const at = order.indexOf('config-change-ui.js');
  assert.ok(at > -1, 'index.html 必须加载 config-change-ui.js');
  assert.equal(order.filter((name) => name === 'config-change-ui.js').length, 1);
  assert.ok(at < order.indexOf('renderer.js'), '必须排在 renderer.js 之前');
  assert.ok(order.indexOf('save-rescue-ui.js') < at, '排在 save-rescue-ui.js 之后');

  // 装配清单：文件 / 全局名 / renderer 本地名三处对得上（顺序由 assembly-manifest.test.js 总闸盯）
  const entry = manifest.MODULES.find(([file]) => file === 'config-change-ui.js');
  assert.ok(entry, '装配清单要登记 config-change-ui.js');
  assert.equal(entry[1], 'CWConfigChangeUi');
  assert.equal(entry[2], 'configChangeUiModule');

  // renderer.js：只声明一次、只 create 一次、只订阅一次，payload 交给 handleConfigChanged
  assert.equal((rendererCode.match(/const configChangeUiModule = window\.CWConfigChangeUi;/g) || []).length, 1);
  assert.equal((rendererCode.match(/configChangeUiModule\.create\(/g) || []).length, 1, '只 create 一次');
  assert.match(
    rendererCode,
    /const configChangeUi = configChangeUiModule\.create\(\{[\s\S]{0,600}\bstate\b[\s\S]{0,600}\bopenModal\b[\s\S]{0,600}\btoast\b[\s\S]{0,600}\brescueCopy\b[\s\S]{0,800}\bgoBackToShelf\b[\s\S]{0,400}\brefreshShelf\b[\s\S]{0,400}\brefreshConfig\b/,
    'create 的 host 缺成员'
  );
  assert.match(rendererCode, /rescueCopy: \(mode\) => saveRescueUi\.rescueCopy\(mode\)/, '救稿复用同一份实现');
  assert.match(rendererCode, /goBackToShelf: \(\) => backToShelf\(\)/, '回书架走既有 backToShelf（惰性取，避免 TDZ）');
  assert.equal((rendererCode.match(/api\.onConfigChanged\(/g) || []).length, 1, '只订阅一次换根通知');
  assert.match(
    rendererCode,
    /api\.onConfigChanged\(\(payload\) => \{[\s\S]{0,120}configChangeUi\.handleConfigChanged\(payload\)/,
    '订阅回调必须把 payload 交给 handleConfigChanged'
  );

  // preload：换根是单向通知（不是 invoke），频道名与 main.js 广播一致
  const preload = read('preload.js');
  assert.match(preload, /onConfigChanged: \(cb\) => on\('config:changed', cb\)/, 'preload 要暴露 config:changed 订阅');

  // main.js：换书架根要广播（只带 reason / booksRoot），且判据与清锁同一个 booksRootChanged
  const main = read('main.js');
  const start = main.indexOf("handle('config:set'");
  assert.ok(start > 0, 'main.js 里找不到 config:set');
  const body = main.slice(start, main.indexOf('\n  handle(', start + 1));
  assert.match(
    body,
    /broadcast\('config:changed', \{ reason: 'booksRoot', booksRoot: nextConfig\.booksRoot \}\)/,
    '换根要广播 config:changed（payload 只带 reason / booksRoot）'
  );
  const branchAt = body.indexOf('if (configGate.booksRootChanged(previousRoot, nextConfig.booksRoot))');
  const lockAt = body.indexOf('storage.clearBookLocks();', branchAt);
  const broadcastAt = body.indexOf("broadcast('config:changed'", branchAt);
  const syncAt = body.indexOf('syncClipboardWatch();');
  assert.ok(
    branchAt > -1 && lockAt > branchAt && broadcastAt > lockAt && syncAt > broadcastAt,
    '广播必须与换根清锁同一判据、在配置写盘之后、在立即启停剪贴板监听之前'
  );
});