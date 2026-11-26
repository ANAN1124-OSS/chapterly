const test = require('node:test');
const assert = require('node:assert/strict');
const shelfUiModule = require('../renderer/shelf-ui');

// 五-M6（SS-03）：书架增量刷新 handleShelfChanged 的世代 / 时序复核。
// 现状：读卡 await 回来直接 applyShelfCard（at<0 时无条件 push），中间不管「这本书是不是刚被删掉」
// 「这次回执是不是已被更新的一次变更 / 整表刷新取代」。本文件把两条可感知后果钉成行为用例：
//   1) 删书广播 + 在途读卡 → 已删书卡被插回书架（点它弹「修复」）；
//   2) 同书两次变更的读卡回执乱序 → 后到的旧卡盖掉新卡；整表刷新后的旧回执同理。

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function shelfState(books) {
  return {
    view: 'shelf',
    books,
    importing: false,
    formatBookRunning: false,
    chapters: [],
    index: 0,
    dirty: false,
    recentBook: null
  };
}

function makeShelfHost(options = {}) {
  const calls = { read: [], rendered: 0, refreshed: 0, marked: 0, stats: 0, recent: 0 };
  const state = options.state || shelfState([]);
  const api = {
    // A2-SHELF-01：「继续上次写作」的来源（增量刷新落地后要补取一次）
    getRecentBook: async () => {
      calls.recent += 1;
      return options.recent === undefined ? null : options.recent;
    },
    readBookCard: async (bookPath) => {
      calls.read.push(bookPath);
      if (options.onRead) return options.onRead(bookPath);
      return null;
    }
  };
  const shelfUi = shelfUiModule.create({
    $: () => null,
    state,
    chapterTitle: () => '',
    formatRelativeTime: () => '',
    openBookByPath: async () => ({ ok: true }),
    askUnsaved: async () => 'cancel',
    saveCurrent: async () => ({ ok: true }),
    loadChapterAt: async () => {},
    api,
    call: async (fn, ...args) => fn(...args),
    renderShelf: () => { calls.rendered += 1; },
    refreshShelf: async () => {
      calls.refreshed += 1;
      if (options.onRefresh) options.onRefresh(state);
    },
    refreshStats: async () => { calls.stats += 1; },
    markCommandsDirty: () => { calls.marked += 1; }
  });
  return { shelfUi, state, calls };
}

test('handleShelfChanged：在途读卡期间收到 book:delete，回执到达不得把已删书卡复活', async () => {
  const bookA = { path: 'C:\\书架\\甲书', title: '甲书', lastModified: 2000 };
  const bookB = { path: 'C:\\书架\\乙书', title: '乙书', lastModified: 1000 };
  const gate = deferred();
  const host = makeShelfHost({
    state: shelfState([bookA, bookB]),
    onRead: () => gate.promise
  });

  // 1) 保存广播 → 读卡在途（还没回来）
  const inFlight = host.shelfUi.handleShelfChanged({ reason: 'chapter:save', bookPath: bookA.path });
  assert.deepEqual(host.calls.read, [bookA.path], '先发出这本书的读卡（在途）');

  // 2) 删除广播先到：从书架删卡（路径大小写不同也要按同一本书处理）
  const removed = await host.shelfUi.handleShelfChanged({ reason: 'book:delete', bookPath: bookA.path.toLowerCase() });
  assert.deepEqual(removed, { mode: 'remove', removed: true });
  assert.deepEqual(host.state.books.map((book) => book.title), ['乙书']);
  assert.equal(host.calls.rendered, 1, '删除时重画一次');

  // 3) 在途读卡的回执现在才到：书已经删了，回执必须作废，不能把卡插回来
  gate.resolve({ path: bookA.path, title: '甲书（旧卡）', lastModified: 5000 });
  const stale = await inFlight;
  assert.equal(stale.mode, 'stale', '删书之后到达的读卡回执要作废');
  assert.deepEqual(host.state.books.map((book) => book.title), ['乙书'], '已删的书不许被旧回执插回书架');
  assert.equal(host.calls.rendered, 1, '过期回执不再重画');

  // 4) 尚未进列表的新书同理：建书读卡在途 → 删除广播（removed:false）→ 回执不许 push
  const gate2 = deferred();
  const host2 = makeShelfHost({
    state: shelfState([bookB]),
    onRead: () => gate2.promise
  });
  const pendingNew = host2.shelfUi.handleShelfChanged({ reason: 'book:create', bookPath: 'C:\\书架\\丙书' });
  const removedNew = await host2.shelfUi.handleShelfChanged({ reason: 'book:delete', bookPath: 'C:\\书架\\丙书' });
  assert.deepEqual(removedNew, { mode: 'remove', removed: false });
  assert.deepEqual(host2.state.books.map((book) => book.title), ['乙书']);
  gate2.resolve({ path: 'C:\\书架\\丙书', title: '丙书', lastModified: 9999 });
  assert.equal((await pendingNew).mode, 'stale');
  assert.deepEqual(host2.state.books.map((book) => book.title), ['乙书'], '未入列表就被删掉的书也不许被回执插回');
});

test('handleShelfChanged：同书两次变更的读卡回执乱序到达 → 后到的旧卡不得覆盖新卡', async () => {
  const bookA = { path: 'C:\\书架\\甲书', title: '甲书（旧）', lastModified: 1000 };
  const oldGate = deferred();
  let reads = 0;
  const host = makeShelfHost({
    state: shelfState([bookA]),
    onRead: () => {
      reads += 1;
      if (reads === 1) return oldGate.promise; // 第一次（较早的变更）读卡卡住
      return { path: bookA.path, title: '甲书（新）', lastModified: 2000 };
    }
  });

  // 第一次变更的读卡在途；紧接着第二次变更的读卡立刻回来并先落地
  const first = host.shelfUi.handleShelfChanged({ reason: 'chapter:save', bookPath: bookA.path });
  const second = await host.shelfUi.handleShelfChanged({ reason: 'book:rename', bookPath: bookA.path });
  assert.equal(second.mode, 'card');
  assert.deepEqual(host.state.books.map((book) => book.title), ['甲书（新）']);

  // 旧回执后到：不许把新卡盖回旧书名
  oldGate.resolve({ path: bookA.path, title: '甲书（旧）', lastModified: 3000 });
  const stale = await first;
  assert.equal(stale.mode, 'stale');
  assert.deepEqual(host.state.books.map((book) => book.title), ['甲书（新）'], '旧卡不许盖掉新卡');
  assert.equal(host.calls.rendered, 1, '只有新回执画了一次，旧回执不重画');
});

test('handleShelfChanged：N-02 正反斜杠写法不同仍按同一本书处理（不重复插卡 / 删得掉）', async () => {
  // 书架列表里的路径是主进程 resolve 过的反斜杠形式；广播若带正斜杠（或反之），
  // 以前只做 toLowerCase 的比较会把同一本书判成两本：增量刷新 push 出重复卡，
  // 删除广播则一张都删不掉。
  const bookA = { path: 'C:\\书架\\甲书', title: '甲书（旧）', lastModified: 1000 };
  const host = makeShelfHost({
    state: shelfState([bookA]),
    onRead: () => ({ path: 'C:\\书架\\甲书', title: '甲书（新）', lastModified: 2000 })
  });
  const updated = await host.shelfUi.handleShelfChanged({ reason: 'chapter:save', bookPath: 'C:/书架/甲书' });
  assert.equal(updated.mode, 'card');
  assert.deepEqual(host.state.books.map((book) => book.title), ['甲书（新）'], '同一本书要替换而不是新增一张卡');
  assert.equal(host.state.books.length, 1);

  // 删除广播用另一种斜杠写法也要删掉已存在的书卡
  const removed = await host.shelfUi.handleShelfChanged({ reason: 'book:delete', bookPath: 'C:/书架/甲书' });
  assert.deepEqual(removed, { mode: 'remove', removed: true });
  assert.deepEqual(host.state.books, []);
});
test('handleShelfChanged：整表刷新之后到达的在途读卡回执作废（不再覆盖刷新结果）', async () => {
  const before = { path: 'C:\\书架\\甲书', title: '甲书（刷新前）', lastModified: 100 };
  const after = { path: 'C:\\书架\\甲书', title: '甲书（刷新后）', lastModified: 900 };
  const gate = deferred();
  const host = makeShelfHost({
    state: shelfState([before]),
    onRead: () => gate.promise,
    onRefresh: (state) => { state.books = [after]; }
  });

  const inFlight = host.shelfUi.handleShelfChanged({ reason: 'chapter:save', bookPath: before.path });
  const full = await host.shelfUi.handleShelfChanged({ reason: 'book:import' });
  assert.equal(full.mode, 'full');
  assert.deepEqual(host.state.books.map((book) => book.title), ['甲书（刷新后）']);

  gate.resolve(before);
  const stale = await inFlight;
  assert.equal(stale.mode, 'stale', '刷新前发出的读卡回执作废');
  assert.deepEqual(host.state.books.map((book) => book.title), ['甲书（刷新后）'], '刷新结果不许被旧卡覆盖');
  assert.equal(host.calls.rendered, 0, '整表刷新由宿主自己重画，过期增量回执不许再画');
});

// A2-SHELF-01（低）：书架增量只换书卡时 state.recentBook 保持旧值 —— 另一个窗口刚保存的书在
// 「继续上次写作」卡上仍不是最近那一本（同屏口径矛盾）。增量落地后要补取一次。
test('A2-SHELF-01：增量刷新落地后补取「继续上次写作」并写回 state', async () => {
  const bookA = { path: 'C:\\书架\\甲书', title: '甲书', lastModified: 1000 };
  const recent = { path: bookA.path, chapterId: 'c1', chapterIndex: 0, chapterName: '第一章' };
  const host = makeShelfHost({
    state: shelfState([bookA]),
    recent,
    onRead: () => ({ path: bookA.path, title: '甲书', lastModified: 3000 })
  });
  const result = await host.shelfUi.handleShelfChanged({ reason: 'chapter:save', bookPath: bookA.path });
  assert.equal(result.mode, 'card');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.calls.recent, 1, '增量路径也要重取一次最近写作');
  assert.deepEqual(host.state.recentBook, recent, '新 recent 要写回 state');
});