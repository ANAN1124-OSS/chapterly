// 「打开中的书」登记 / 重复打开 / 最近窗口 / 保存前校验 / 跨窗口拦截的纯逻辑单测。
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const openBooks = require('../core/open-books');

const BOOK_A = path.join('D:\\Books', '甲书');
const BOOK_B = path.join('D:\\Books', '乙书');

test('打开登记：窗口登记后能查到，换书时旧书释放', () => {
  const registry = openBooks.createRegistry();
  registry.registerWindow(1);
  assert.deepStrictEqual(registry.counts(), { windows: 1, openBooks: 0 });
  const first = registry.setBook(1, BOOK_A);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(registry.findWindow(BOOK_A), '1');
  assert.strictEqual(registry.getBook(1), openBooks.normalizeBookPath(BOOK_A));
  const second = registry.setBook(1, BOOK_B);
  assert.strictEqual(second.ok, true);
  assert.strictEqual(registry.findWindow(BOOK_A), null);
  assert.strictEqual(registry.findWindow(BOOK_B), '1');
  assert.deepStrictEqual(registry.counts(), { windows: 1, openBooks: 1 });
});

test('打开登记：同一个窗口重复打开同一本书是允许的（刷新），不会变成两个登记', () => {
  const registry = openBooks.createRegistry();
  registry.registerWindow(7);
  assert.strictEqual(registry.setBook(7, BOOK_A).ok, true);
  assert.strictEqual(registry.setBook(7, BOOK_A).ok, true);
  assert.deepStrictEqual(registry.list(), [{ windowId: '7', bookPath: openBooks.normalizeBookPath(BOOK_A) }]);
});

test('打开登记：路径比较不区分大小写、能识别斜杠差异', () => {
  const registry = openBooks.createRegistry();
  registry.registerWindow('w1');
  registry.setBook('w1', 'D:\\Books\\甲书');
  const result = registry.setBook('w2', 'd:/books/甲书/');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, openBooks.CODE.BOOK_OPEN_IN_OTHER_WINDOW);
  assert.strictEqual(result.ownerWindowId, 'w1');
  // 被拒绝时不能改动已有登记
  assert.strictEqual(registry.getBook('w2'), null);
  assert.strictEqual(registry.findWindow(BOOK_A), 'w1');
});

test('重复打开拒绝：另一窗口返回拒绝 + 提醒切换', () => {
  const registry = openBooks.createRegistry();
  registry.registerWindow(1);
  registry.registerWindow(2);
  registry.setBook(1, BOOK_A);
  const denied = openBooks.checkOpenBook({ registry, windowId: 2, bookPath: BOOK_A });
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.code, openBooks.CODE.BOOK_OPEN_IN_OTHER_WINDOW);
  assert.strictEqual(denied.ownerWindowId, '1');
  assert.match(denied.message, /另一个窗口/);
  assert.strictEqual(registry.getBook(2), null);
  assert.strictEqual(registry.findWindow(BOOK_A), '1');
});

test('窗口释放：关窗 / 回书架只释放这个窗口，别窗口的书不动', () => {
  const registry = openBooks.createRegistry();
  registry.registerWindow(1);
  registry.registerWindow(2);
  registry.setBook(1, BOOK_A);
  registry.setBook(2, BOOK_B);
  assert.strictEqual(registry.clearBook(1), true);
  assert.strictEqual(registry.getBook(1), null);
  assert.strictEqual(registry.findWindow(BOOK_A), null);
  assert.strictEqual(registry.getBook(2), openBooks.normalizeBookPath(BOOK_B));
  registry.unregisterWindow(2);
  assert.strictEqual(registry.getBook(2), null);
  registry.unregisterWindow(1);
  assert.deepStrictEqual(registry.counts(), { windows: 0, openBooks: 0 });
});

test('clearPath：书被删除时清掉所有窗口对它的登记', () => {
  const registry = openBooks.createRegistry();
  registry.setBook(1, BOOK_A);
  registry.setBook(2, BOOK_B);
  assert.strictEqual(registry.clearPath(BOOK_A), true);
  assert.strictEqual(registry.findWindow(BOOK_A), null);
  assert.strictEqual(registry.getBook(1), null);
  assert.strictEqual(registry.clearPath(BOOK_A), false);
  assert.strictEqual(registry.findWindow(BOOK_B), '2');
});

test('最近窗口：按最近激活时间选择，没开书的窗口也算', () => {
  const registry = openBooks.createRegistry();
  registry.registerWindow(1, { now: 1000 });
  registry.registerWindow(2, { now: 2000 });
  registry.setBook(1, BOOK_A, { now: 3000 });
  assert.strictEqual(registry.mostRecentWindow(), '1');
  registry.touch(2, { now: 4000 });
  assert.strictEqual(registry.mostRecentWindow(), '2');
  registry.unregisterWindow(2);
  assert.strictEqual(registry.mostRecentWindow(), '1');
  registry.unregisterWindow(1);
  assert.strictEqual(registry.mostRecentWindow(), null);
});

test('最近窗口：同一毫秒内后登记 / 后激活的窗口优先', () => {
  const registry = openBooks.createRegistry();
  registry.registerWindow('a', { now: 5000 });
  registry.registerWindow('b', { now: 5000 });
  assert.strictEqual(registry.mostRecentWindow(), 'b');
  registry.touch('a', { now: 5000 });
  assert.strictEqual(registry.mostRecentWindow(), 'a');
});

test('跨窗口拦截：别的窗口开着的书拒绝删除 / 改名 / 保存，自己窗口允许', () => {
  const registry = openBooks.createRegistry();
  registry.registerWindow(1);
  registry.registerWindow(2);
  registry.setBook(2, BOOK_A);
  for (const action of ['delete', 'rename', 'format', 'replace', 'save']) {
    const denied = openBooks.checkMutation({ registry, windowId: 1, bookPath: BOOK_A, action });
    assert.strictEqual(denied.ok, false, action);
    assert.strictEqual(denied.code, openBooks.CODE.CROSS_WINDOW_BUSY);
    assert.strictEqual(denied.ownerWindowId, '2');
    assert.match(denied.message, /请先关掉另一个窗口/);
  }
  assert.strictEqual(
    openBooks.checkMutation({ registry, windowId: 2, bookPath: BOOK_A, action: 'save' }).ok,
    true
  );
});

test('跨窗口拦截：没有窗口开着的书 / 未知窗口 ID 不受影响', () => {
  const registry = openBooks.createRegistry();
  assert.strictEqual(
    openBooks.checkMutation({ registry, windowId: 1, bookPath: BOOK_B, action: 'delete' }).ok,
    true
  );
  registry.setBook(2, BOOK_A);
  assert.strictEqual(
    openBooks.checkMutation({ registry, windowId: undefined, bookPath: BOOK_A, action: 'delete' }).ok,
    false
  );
});

test('路径归一：空值 / 相对路径 / 环境差异都安全，空路径不能登记', () => {
  assert.strictEqual(openBooks.normalizeBookPath(null), '');
  assert.strictEqual(openBooks.normalizeBookPath('  '), '');
  assert.strictEqual(
    openBooks.normalizeBookPath('D:\\Books\\甲书\\'),
    path.resolve('D:\\Books\\甲书').toLowerCase()
  );
  const registry = openBooks.createRegistry();
  assert.strictEqual(registry.setBook(1, '').ok, false);
  assert.strictEqual(registry.setBook(1, '').code, 'BAD_PATH');
});

test('保存前校验：书文件夹不在了 → 阻止保存', () => {
  const result = openBooks.verifySaveTarget({
    bookPath: BOOK_A,
    bookExists: false,
    chapterId: 'ch_001',
    chapterExists: false
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, openBooks.CODE.BOOK_MISSING);
  assert.match(result.message, /影子文件/);
});

test('保存前校验：书目读不出来 → 阻止保存（解析失败给出修复提示）', () => {
  const missing = openBooks.verifySaveTarget({
    bookPath: BOOK_A,
    bookExists: true,
    meta: null,
    chapterId: 'ch_001',
    chapterExists: true
  });
  assert.strictEqual(missing.code, openBooks.CODE.BOOK_MISSING);
  const broken = openBooks.verifySaveTarget({
    bookPath: BOOK_A,
    bookExists: true,
    meta: null,
    metaCode: 'PARSE_ERROR',
    chapterId: 'ch_001',
    chapterExists: true
  });
  assert.strictEqual(broken.code, 'PARSE_ERROR');
  assert.match(broken.message, /修复/);
});

test('保存前校验：章节已不在书目里 → 阻止保存', () => {
  const meta = { chapters: [{ id: 'ch_001', file: '001-未命名.txt' }] };
  const result = openBooks.verifySaveTarget({
    bookPath: BOOK_A,
    bookExists: true,
    meta,
    chapterId: 'ch_999',
    chapterExists: true
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, openBooks.CODE.CHAPTER_NOT_FOUND);
  assert.match(result.message, /不在书目里/);
});

test('保存前校验：章节记录指向的文件名变了 → 阻止保存（不写错文件）', () => {
  const meta = { chapters: [{ id: 'ch_001', file: '001-未命名.txt' }] };
  const result = openBooks.verifySaveTarget({
    bookPath: BOOK_A,
    bookExists: true,
    meta,
    chapterId: 'ch_001',
    file: '002-旧名.txt',
    chapterExists: true
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, openBooks.CODE.CHAPTER_NOT_FOUND);
});

test('保存前校验：章节文件不存在 → 阻止保存，不重建 txt', () => {
  const meta = { chapters: [{ id: 'ch_001', file: '001-未命名.txt' }] };
  const result = openBooks.verifySaveTarget({
    bookPath: BOOK_A,
    bookExists: true,
    meta,
    chapterId: 'ch_001',
    file: '001-未命名.txt',
    chapterExists: false
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, openBooks.CODE.CHAPTER_MISSING);
  assert.match(result.message, /影子文件/);
});

test('保存前校验：书 / 章都在书目里 → 允许保存，并返回章节记录', () => {
  const chapter = { id: 'ch_001', file: '001-未命名.txt', name: '起风' };
  const result = openBooks.verifySaveTarget({
    bookPath: BOOK_A,
    bookExists: true,
    meta: { chapters: [chapter] },
    chapterId: 'ch_001',
    file: '001-未命名.txt',
    chapterExists: true
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.chapter, chapter);
  assert.strictEqual(result.index, 0);
});

test('保存前校验：坏 meta（chapters 不是数组）也不会抛错', () => {
  const result = openBooks.verifySaveTarget({
    bookPath: BOOK_A,
    bookExists: true,
    meta: { chapters: null },
    chapterId: 'ch_001',
    chapterExists: true
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, openBooks.CODE.CHAPTER_NOT_FOUND);
});

test('错误提示：不同动作用不同动词，且都提示先关 / 先切另一个窗口', () => {
  const registry = openBooks.createRegistry();
  registry.setBook(9, BOOK_A);
  for (const [action, verb] of [
    ['delete', '删除'],
    ['rename', '改名'],
    ['format', '整理'],
    ['replace', '替换'],
    ['save', '保存']
  ]) {
    const denied = openBooks.checkMutation({ registry, windowId: 1, bookPath: BOOK_A, action });
    assert.ok(denied.message.includes(verb), action);
    assert.ok(denied.message.includes('请先关掉另一个窗口'), action);
  }
});

// T-20（三审）：文件夹名上限 40 字，超长书名整名内嵌错误文案时会被 core/logs.js 的
// 「≥24 连续汉字 = 疑似正文」遮罩整段换成 [正文已隐藏 N 字]，日志里的诊断直接报废。
// 修法：书名在提示里首尾截断（中间 '…'），任何一段都不到遮罩阈值；正常长度书名一字不改。
test('T-20：超长书名首尾截断，日志遮罩不再把整条诊断吞掉', () => {
  const logsLib = require('../core/logs');
  const longName = '长'.repeat(30);
  const longBook = path.join('D:\\书架', longName);

  const message = openBooks.openInOtherWindowMessage(longBook);
  const masked = logsLib.maskLongCjk(message);
  assert.match(message, /…/, '超长书名要首尾截断');
  assert.doesNotMatch(masked, /正文已隐藏/, '书名不许被日志遮罩当成正文');
  assert.ok(masked.includes('长'.repeat(14)), '首段（14 字）保留');
  assert.ok(masked.includes('长'.repeat(8)), '尾段（8 字）保留');
  assert.strictEqual(Array.from(openBooks.bookLabel(longBook)).filter((c) => c === '长').length, 22);

  // 正常长度（≤24 字）的书名一字不改：界面提示与旧行为一致
  assert.strictEqual(openBooks.bookLabel(BOOK_A), '甲书');
  assert.strictEqual(openBooks.bookLabel(path.join('D:\\书架', '长'.repeat(24))), '长'.repeat(24));
  // 保存前校验 / 跨窗口拦截的文案同样可诊断（不被遮罩）
  const denied = openBooks.verifySaveTarget({ bookPath: longBook, bookExists: false });
  assert.doesNotMatch(logsLib.maskLongCjk(denied.message), /正文已隐藏/);
});

test('多窗口规模：登记 / 释放与最近窗口在多个窗口下保持一致', () => {
  const registry = openBooks.createRegistry();
  for (let i = 1; i <= 5; i += 1) registry.registerWindow(i, { now: i });
  for (let i = 1; i <= 5; i += 1) registry.setBook(i, path.join('D:\\Books', `书${i}`), { now: 10 + i });
  assert.deepStrictEqual(registry.counts(), { windows: 5, openBooks: 5 });
  assert.strictEqual(registry.mostRecentWindow(), '5');
  registry.clearBook(5);
  assert.strictEqual(registry.mostRecentWindow(), '5'); // 窗口还在，只是没开书
  assert.strictEqual(registry.findWindow(path.join('D:\\Books', '书5')), null);
  assert.strictEqual(registry.findWindow(path.join('D:\\Books', '书4')), '4');
});

// ---------- 审计修复 #5（V301）：保存前校验的眼 → expectedMtimeMs 比对 ----------
test('保存前校验（V301）：载入后磁盘 mtime 变了 → EXTERNAL_CHANGE，拦下这次保存', () => {
  const chapter = { id: 'ch_001', file: '001-未命名.txt' };
  const result = openBooks.verifySaveTarget({
    bookPath: BOOK_A,
    bookExists: true,
    meta: { chapters: [chapter] },
    chapterId: 'ch_001',
    file: '001-未命名.txt',
    chapterExists: true,
    chapterMtimeMs: 222,
    expectedMtimeMs: 111
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, openBooks.CODE.EXTERNAL_CHANGE);
  assert.match(result.message, /应用外/);
  assert.match(result.message, /已阻止这次保存/);
});

test('保存前校验（V301）：mtime 一致 / 没带 expectedMtimeMs / 传 0 覆盖 → 放行', () => {
  const chapter = { id: 'ch_001', file: '001-未命名.txt' };
  const base = {
    bookPath: BOOK_A,
    bookExists: true,
    meta: { chapters: [chapter] },
    chapterId: 'ch_001',
    file: '001-未命名.txt',
    chapterExists: true,
    chapterMtimeMs: 111
  };
  // 一致：正常保存
  assert.strictEqual(openBooks.verifySaveTarget({ ...base, expectedMtimeMs: 111 }).ok, true);
  // 不带 / 0 / 坏值：老调用方与「覆盖保存」都不拦
  assert.strictEqual(openBooks.verifySaveTarget(base).ok, true);
  assert.strictEqual(openBooks.verifySaveTarget({ ...base, expectedMtimeMs: 0 }).ok, true);
  assert.strictEqual(openBooks.verifySaveTarget({ ...base, expectedMtimeMs: null }).ok, true);
  assert.strictEqual(openBooks.verifySaveTarget({ ...base, expectedMtimeMs: 'x' }).ok, true);
  // 不看 mtime 的旧语义不能变：书 / 章没了仍是各自的错误码（mtime 检查排在 chapterExists 之后）
  assert.strictEqual(
    openBooks.verifySaveTarget({ ...base, chapterExists: false, expectedMtimeMs: 111 }).code,
    openBooks.CODE.CHAPTER_MISSING
  );
});

// KNOWN-SINGLE（2026-11-26 复核）：第二个实例早到（第一个窗口还在启动链里建）时不再开第二扇窗。
test('KNOWN-SINGLE：第二个实例的处置（有窗口聚焦 / 启动建窗在途忽略 / 否则新建）', () => {
  assert.equal(openBooks.secondInstanceAction({ hasSession: true }), 'focus');
  assert.equal(openBooks.secondInstanceAction({ hasSession: true, startupPending: true }), 'focus');
  assert.equal(openBooks.secondInstanceAction({ hasSession: false, startupPending: true }), 'ignore');
  assert.equal(openBooks.secondInstanceAction({ hasSession: false, startupPending: false }), 'create');
  assert.equal(openBooks.secondInstanceAction(), 'create');
  const fs = require('node:fs');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const at = main.indexOf("app.on('second-instance'");
  assert.ok(at > 0, '找不到 second-instance 处理器');
  const block = main.slice(at, at + 1400);
  assert.match(block, /openBooksLib\.secondInstanceAction\(\{/, 'second-instance 要走唯一判据');
  assert.match(block, /startupPending: startupWindowPending/, '判据要读启动建窗在途标记');
  assert.match(main, /let startupWindowPending = false;/, '要声明启动建窗标记');
  assert.match(
    main,
    /startupWindowPending = true;[\s\S]{0,120}?await createWindow\(\{ runAutomationFlow: true \}\)/,
    '建窗前把标记置位'
  );
});
