// 配置层测试（T9 / 第 9 轮按域拆分）：各功能配置键与查找书签。
//
// 来源：原 tests/config.test.js（2,000 行 / 69 例）按域拆成四个文件，**只搬家不改断言**——
// 用例标题与断言逐字保留，共用夹具收进 tests/config-fixtures.js（T9 纪律，见 tests/README.md）。
// 本文件覆盖：每日快照 / 每日目标 / 章节模板 / 敏感词表 / 校对词表 / 写作时长 / 导出简繁转换 /
// 查找书签的清洗与原子增删 / 删书后的书签重置。
const test = require('node:test');
const assert = require('node:assert/strict');
const { path, fs, createConfigStore, sanitize, mkTmp } = require('./config-fixtures');

test('每日快照配置：默认关闭、保留 7 天，旧配置没有这两个键也照常启动', async () => {
  const dir = await mkTmp();
  // 模拟 v0.4.1 的旧配置：完全没有 snapshot 字段
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ booksRoot: 'D:\\旧书架', editorFont: 'kai' }, null, 2),
    'utf8'
  );
  const cfg = await createConfigStore(dir).get();
  assert.equal(cfg.snapshotEnabled, false, '旧配置/缺字段必须按「关」处理');
  assert.equal(cfg.snapshotKeepDays, 7);
  assert.equal(cfg.editorFont, 'kai', '旧配置其它字段不受影响');
});

test('每日快照配置：脏值清洗（只认 true、天数夹到 1–90）', () => {
  assert.equal(sanitize({ snapshotEnabled: 'true' }).snapshotEnabled, false);
  assert.equal(sanitize({ snapshotEnabled: 1 }).snapshotEnabled, false);
  assert.equal(sanitize({ snapshotEnabled: true }).snapshotEnabled, true);
  assert.equal(sanitize({ snapshotKeepDays: 0 }).snapshotKeepDays, 1);
  assert.equal(sanitize({ snapshotKeepDays: 999 }).snapshotKeepDays, 90);
  assert.equal(sanitize({ snapshotKeepDays: 'abc' }).snapshotKeepDays, 7);
  assert.equal(sanitize({ snapshotKeepDays: 14.6 }).snapshotKeepDays, 15);
});

test('每日快照配置：写盘 / 读回，不影响其它配置', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await store.set({ snapshotEnabled: true, snapshotKeepDays: 3, editorFont: 'sans' });
  const reopened = await createConfigStore(dir).get();
  assert.equal(reopened.snapshotEnabled, true);
  assert.equal(reopened.snapshotKeepDays, 3);
  assert.equal(reopened.editorFont, 'sans');
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(raw.snapshotEnabled, true);
  assert.equal(raw.snapshotKeepDays, 3);

  // 关掉后能真正清掉（不会残留 true）
  await store.set({ snapshotEnabled: false });
  assert.equal((await createConfigStore(dir).get()).snapshotEnabled, false);
});

test('每日目标配置：默认 0（不设目标），旧配置没有 dailyGoal 也照常启动', async () => {
  const dir = await mkTmp();
  // 模拟 v0.4.1 / v0.6-2 的旧配置：没有 dailyGoal 字段
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ booksRoot: 'D:\\旧书架', snapshotEnabled: true, snapshotKeepDays: 3 }, null, 2),
    'utf8'
  );
  const cfg = await createConfigStore(dir).get();
  assert.equal(cfg.dailyGoal, 0, '旧配置缺字段 = 不设目标');
  assert.equal(cfg.snapshotEnabled, true, '旧配置其它字段不受影响');
  assert.equal(cfg.snapshotKeepDays, 3);
});

test('每日目标配置：脏值清洗（负数/NaN 回落 0，超大夹到上限）', () => {
  assert.equal(sanitize({ dailyGoal: -100 }).dailyGoal, 0);
  assert.equal(sanitize({ dailyGoal: 'abc' }).dailyGoal, 0);
  assert.equal(sanitize({ dailyGoal: null }).dailyGoal, 0);
  assert.equal(sanitize({ dailyGoal: 2000 }).dailyGoal, 2000);
  assert.equal(sanitize({ dailyGoal: '2500' }).dailyGoal, 2500);
  assert.equal(sanitize({ dailyGoal: 2000.4 }).dailyGoal, 2000);
  assert.equal(sanitize({ dailyGoal: 99999999 }).dailyGoal, 1000000);
});

test('每日目标配置：写盘 / 读回，只影响 dailyGoal', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await store.set({ dailyGoal: 2000, editorFont: 'kai' });
  const reopened = await createConfigStore(dir).get();
  assert.equal(reopened.dailyGoal, 2000);
  assert.equal(reopened.editorFont, 'kai');
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(raw.dailyGoal, 2000);

  // 0 = 关掉目标，能落盘
  await store.set({ dailyGoal: 0 });
  assert.equal((await createConfigStore(dir).get()).dailyGoal, 0);
});

test('章节模板配置：默认空、旧配置缺字段照常启动、脏值清洗', async () => {
  const dir = await mkTmp();
  assert.equal((await createConfigStore(dir).get()).chapterTemplate, '', '默认不套用模板');
  // 模拟 v0.4.1 / v0.8 N4 的旧配置：完全没有 chapterTemplate
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ booksRoot: 'D:\\旧书架', dailyGoal: 800, writeDurationEnabled: true }, null, 2),
    'utf8'
  );
  const cfg = await createConfigStore(dir).get();
  assert.equal(cfg.chapterTemplate, '', '旧配置缺字段 = 空模板');
  assert.equal(cfg.dailyGoal, 800, '旧配置其它字段不受影响');

  assert.equal(sanitize({ chapterTemplate: 123 }).chapterTemplate, '');
  assert.equal(sanitize({ chapterTemplate: null }).chapterTemplate, '');
  // CRLF / CR 统一成 LF，NUL 去掉
  assert.equal(sanitize({ chapterTemplate: '第{n}章：\r\n\r\n' }).chapterTemplate, '第{n}章：\n\n');
  assert.equal(sanitize({ chapterTemplate: '前\u0000后' }).chapterTemplate, '前后');
  // 超长夹到模板上限 2000
  const long = '字'.repeat(2500);
  assert.equal(sanitize({ chapterTemplate: long }).chapterTemplate.length, 2000);
});

test('章节模板配置：写盘 / 读回，清空后落盘为空', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  const template = '第{n}章：{title}\n\n';
  await store.set({ chapterTemplate: template, editorFont: 'kai' });
  const reopened = await createConfigStore(dir).get();
  assert.equal(reopened.chapterTemplate, template);
  assert.equal(reopened.editorFont, 'kai');
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(raw.chapterTemplate, template);

  // 清空模板 = 关掉，落盘是空串（不是删字段，旧版本读也安全）
  await store.set({ chapterTemplate: '' });
  assert.equal((await createConfigStore(dir).get()).chapterTemplate, '');
  const cleared = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(cleared.chapterTemplate, '');
});

test('敏感词表配置：默认未设置，旧配置缺字段照常启动，脏值清洗成空', async () => {
  const dir = await mkTmp();
  assert.equal((await createConfigStore(dir).get()).sensitiveWordsPath, '');
  // 模拟旧配置：完全没有 sensitiveWordsPath
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ booksRoot: 'D:\\旧书架', dailyGoal: 1200 }, null, 2),
    'utf8'
  );
  const cfg = await createConfigStore(dir).get();
  assert.equal(cfg.sensitiveWordsPath, '');
  assert.equal(cfg.dailyGoal, 1200, '其它字段不受影响');

  assert.equal(sanitize({ sensitiveWordsPath: 123 }).sensitiveWordsPath, '');
  assert.equal(sanitize({ sensitiveWordsPath: null }).sensitiveWordsPath, '');
  assert.equal(sanitize({ sensitiveWordsPath: '   ' }).sensitiveWordsPath, '');
  assert.equal(
    sanitize({ sensitiveWordsPath: '  D:\\词表\\敏感词.txt  ' }).sensitiveWordsPath,
    'D:\\词表\\敏感词.txt'
  );
  assert.equal(sanitize({ sensitiveWordsPath: 'x'.repeat(1001) }).sensitiveWordsPath, '');
});

test('敏感词表配置：写盘 / 读回，清除后落盘为空', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await store.set({ sensitiveWordsPath: 'D:\\词表\\我的词表.txt' });
  const reopened = await createConfigStore(dir).get();
  assert.equal(reopened.sensitiveWordsPath, 'D:\\词表\\我的词表.txt');
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(raw.sensitiveWordsPath, 'D:\\词表\\我的词表.txt');

  await store.set({ sensitiveWordsPath: '' });
  assert.equal((await createConfigStore(dir).get()).sensitiveWordsPath, '');
});

test('校对词表配置：默认未设置，旧配置缺字段照常启动，脏值清洗成空', async () => {
  const dir = await mkTmp();
  assert.equal((await createConfigStore(dir).get()).proofreadWordsPath, '');
  // 模拟旧配置：完全没有 proofreadWordsPath（只有 v0.8 之前的字段）
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ booksRoot: 'D:\\旧书架', dailyGoal: 1200, sensitiveWordsPath: 'D:\\敏感词.txt' }, null, 2),
    'utf8'
  );
  const cfg = await createConfigStore(dir).get();
  assert.equal(cfg.proofreadWordsPath, '');
  assert.equal(cfg.sensitiveWordsPath, 'D:\\敏感词.txt', '另一份词表不受影响');
  assert.equal(cfg.dailyGoal, 1200, '其它字段不受影响');

  assert.equal(sanitize({ proofreadWordsPath: 123 }).proofreadWordsPath, '');
  assert.equal(sanitize({ proofreadWordsPath: null }).proofreadWordsPath, '');
  assert.equal(sanitize({ proofreadWordsPath: '   ' }).proofreadWordsPath, '');
  assert.equal(
    sanitize({ proofreadWordsPath: '  D:\\词表\\校对词表.txt  ' }).proofreadWordsPath,
    'D:\\词表\\校对词表.txt'
  );
  assert.equal(sanitize({ proofreadWordsPath: 'x'.repeat(1001) }).proofreadWordsPath, '');
});

test('校对词表配置：写盘 / 读回，清除后落盘为空，且不影响敏感词表', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await store.set({ sensitiveWordsPath: 'D:\\词表\\敏感词.txt' });
  await store.set({ proofreadWordsPath: 'D:\\词表\\校对词表.txt' });
  const reopened = await createConfigStore(dir).get();
  assert.equal(reopened.sensitiveWordsPath, 'D:\\词表\\敏感词.txt');
  assert.equal(reopened.proofreadWordsPath, 'D:\\词表\\校对词表.txt');
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(raw.proofreadWordsPath, 'D:\\词表\\校对词表.txt');

  await store.set({ proofreadWordsPath: '' });
  const cleared = await createConfigStore(dir).get();
  assert.equal(cleared.proofreadWordsPath, '');
  assert.equal(cleared.sensitiveWordsPath, 'D:\\词表\\敏感词.txt');
});

test('写作时长配置：默认关、旧配置缺字段照常启动、只认真正的 true', async () => {
  const dir = await mkTmp();
  assert.equal((await createConfigStore(dir).get()).writeDurationEnabled, false, '默认关');
  // 模拟旧配置：完全没有 writeDurationEnabled
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ booksRoot: 'D:\\旧书架', dailyGoal: 800 }, null, 2),
    'utf8'
  );
  const cfg = await createConfigStore(dir).get();
  assert.equal(cfg.writeDurationEnabled, false, '旧配置缺字段 = 关');
  assert.equal(cfg.dailyGoal, 800, '旧配置其它字段不受影响');

  assert.equal(sanitize({ writeDurationEnabled: 'true' }).writeDurationEnabled, false, '字符串 true 不算');
  assert.equal(sanitize({ writeDurationEnabled: 1 }).writeDurationEnabled, false, '数字 1 不算');
  assert.equal(sanitize({ writeDurationEnabled: true }).writeDurationEnabled, true);
});

test('写作时长配置：开关写盘 / 读回，只影响这个字段', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  const on = await store.set({ writeDurationEnabled: true, editorFont: 'kai' });
  assert.equal(on.writeDurationEnabled, true);
  assert.equal(on.editorFont, 'kai');
  const reopened = await createConfigStore(dir).get();
  assert.equal(reopened.writeDurationEnabled, true);
  assert.equal(reopened.editorFont, 'kai');
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(raw.writeDurationEnabled, true);
  assert.equal(raw.editorFont, 'kai');

  await store.set({ writeDurationEnabled: false });
  assert.equal((await createConfigStore(dir).get()).writeDurationEnabled, false);
});

test('导出简繁转换配置：默认不转换、旧配置缺字段照常启动、脏值当不转换', async () => {
  const dir = await mkTmp();
  assert.equal((await createConfigStore(dir).get()).exportConversion, '', '默认不转换');
  // 模拟旧配置：完全没有 exportConversion（v0.8 N6 及以前）
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ booksRoot: 'D:\\旧书架', dailyGoal: 800, chapterTemplate: '第{n}章：' }, null, 2),
    'utf8'
  );
  const cfg = await createConfigStore(dir).get();
  assert.equal(cfg.exportConversion, '', '旧配置缺字段 = 不转换');
  assert.equal(cfg.chapterTemplate, '第{n}章：', '旧配置其它字段不受影响');

  assert.equal(sanitize({ exportConversion: 's2t' }).exportConversion, 's2t');
  assert.equal(sanitize({ exportConversion: 't2s' }).exportConversion, 't2s');
  assert.equal(sanitize({ exportConversion: 'S2T' }).exportConversion, '', '大小写不同不认');
  assert.equal(sanitize({ exportConversion: 'zh-tw' }).exportConversion, '');
  assert.equal(sanitize({ exportConversion: 123 }).exportConversion, '');
  assert.equal(sanitize({ exportConversion: null }).exportConversion, '');
  assert.equal(sanitize({ exportConversion: '  s2t  ' }).exportConversion, '', '不做 trim 猜测');
});

test('导出简繁转换配置：写盘 / 读回，切回不转换后落盘为空', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await store.set({ exportConversion: 's2t', editorFont: 'kai' });
  const reopened = await createConfigStore(dir).get();
  assert.equal(reopened.exportConversion, 's2t');
  assert.equal(reopened.editorFont, 'kai');
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(raw.exportConversion, 's2t');

  await store.set({ exportConversion: 't2s' });
  assert.equal((await createConfigStore(dir).get()).exportConversion, 't2s');

  // 切回「不转换」= 空串（不是删字段，旧版本读也安全）
  await store.set({ exportConversion: '' });
  assert.equal((await createConfigStore(dir).get()).exportConversion, '');
  const cleared = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(cleared.exportConversion, '');
});

test('查找书签配置：默认空、旧配置缺字段照常启动、坏值清洗', async () => {
  const dir = await mkTmp();
  assert.deepEqual((await createConfigStore(dir).get()).findBookmarks, [], '默认没有书签');

  // 模拟旧配置：完全没有 findBookmarks（v0.8 N11 及以前）
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ booksRoot: 'D:\\旧书架', dailyGoal: 800, exportConversion: 's2t' }, null, 2),
    'utf8'
  );
  const cfg = await createConfigStore(dir).get();
  assert.deepEqual(cfg.findBookmarks, [], '旧配置缺字段 = 没有书签');
  assert.equal(cfg.dailyGoal, 800, '旧配置其它字段不受影响');
  assert.equal(cfg.exportConversion, 's2t');

  assert.deepEqual(sanitize({ findBookmarks: 'x' }).findBookmarks, []);
  assert.deepEqual(sanitize({ findBookmarks: { a: 1 } }).findBookmarks, []);
  const cleaned = sanitize({
    findBookmarks: [
      {
        bookId: 'b1',
        chapterId: 'ch_001',
        bookPath: 'D:\\书库\\书一',
        bookTitle: '书一',
        chapterName: '第一章',
        chapterIndex: 1,
        query: '阿明',
        caseSensitive: 'true',
        createdAt: 1000,
        updatedAt: 1000,
        text: '这条字段不该进配置'
      },
      { bookId: '', chapterId: 'ch_002', query: '坏' },
      { bookId: 'b1', chapterId: 'ch_001', query: '重复' },
      null
    ]
  }).findBookmarks;
  assert.equal(cleaned.length, 1, '坏条目 / 重复的「书 + 章」被丢掉');
  assert.equal(cleaned[0].query, '阿明');
  assert.equal(cleaned[0].caseSensitive, false, '大小写只认真正的 true');
  assert.equal('text' in cleaned[0], false, '正文 / 多余字段不进配置');
});

test('查找书签配置：主进程按「书 + 章」原子增删，只写 config.json', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await store.set({ editorFont: 'kai', dailyGoal: 1200 });

  const first = await store.upsertFindBookmark({
    bookId: 'b_book1',
    chapterId: 'ch_001',
    bookPath: 'D:\\书库\\测试书',
    bookTitle: '测试书',
    chapterName: '雨夜',
    chapterIndex: 1,
    query: '阿明',
    caseSensitive: false,
    createdAt: 111
  });
  assert.equal(first.list.length, 1);
  assert.equal(first.bookmark.query, '阿明');
  assert.equal(first.bookmark.createdAt, 111);

  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(raw.findBookmarks.length, 1);
  assert.equal(raw.editorFont, 'kai', '其它配置字段不受影响');
  assert.equal(raw.dailyGoal, 1200);
  assert.deepEqual((await createConfigStore(dir).get()).findBookmarks.length, 1, '重启后书签还在');

  // 同一「书 + 章」再存 = 更新那一条（保留第一次收藏时间），不新增
  const updated = await store.upsertFindBookmark({
    bookId: 'b_book1',
    chapterId: 'ch_001',
    bookPath: 'D:\\书库\\测试书',
    bookTitle: '测试书',
    chapterName: '雨夜',
    chapterIndex: 1,
    query: '雨',
    caseSensitive: true
  });
  assert.equal(updated.list.length, 1);
  assert.equal(updated.bookmark.query, '雨');
  assert.equal(updated.bookmark.caseSensitive, true);
  assert.equal(updated.bookmark.createdAt, 111, '保留第一次收藏时间');

  // 另一章 = 另一条，最近保存的在最前
  const second = await store.upsertFindBookmark({
    bookId: 'b_book1',
    chapterId: 'ch_002',
    bookTitle: '测试书',
    chapterName: '归途',
    chapterIndex: 2,
    query: '灯',
    caseSensitive: false
  });
  assert.equal(second.list.length, 2);
  assert.equal(second.list[0].chapterId, 'ch_002');
  assert.equal(second.list[1].chapterId, 'ch_001');

  // 删除：只按「书 + 章」精确删，不存在的键不动其它条目
  const removed = await store.removeFindBookmark('b_book1', 'ch_001');
  assert.equal(removed.list.length, 1);
  assert.equal(removed.list[0].chapterId, 'ch_002');
  assert.equal((await store.removeFindBookmark('b_book1', '不存在')).list.length, 1);
  assert.equal((await store.removeFindBookmark('', '')).list.length, 1);

  // 缺书 / 缺章 / 缺词的条目明确报错，不会写一条空书签
  await assert.rejects(() => store.upsertFindBookmark({ bookId: '', chapterId: 'ch_003', query: 'x' }));
  await assert.rejects(() => store.upsertFindBookmark({ bookId: 'b_book1', chapterId: '', query: 'x' }));
  await assert.rejects(() => store.upsertFindBookmark({ bookId: 'b_book1', chapterId: 'ch_003', query: '  ' }));
  assert.equal((await store.listFindBookmarks()).length, 1);

  const finalRaw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(finalRaw.findBookmarks.length, 1);
  assert.equal(finalRaw.editorFont, 'kai');
  assert.equal(finalRaw.dailyGoal, 1200);
  assert.equal('text' in finalRaw.findBookmarks[0], false);
});

// E2（一轮·低）：删书成功后按 bookId 清掉这本书的全部查找书签 —— 书签全局上限 200 条，
// 已删的书不能继续占配额、也不能留在查找面板里（点开必然失败）。

test('E2：resetFindBookmarksForBook 只按 bookId 清这本书的书签，其它书 / 其它字段不动', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await store.set({ editorFont: 'kai', dailyGoal: 1200 });
  const seed = async (bookId, chapterId) =>
    store.upsertFindBookmark({ bookId, chapterId, bookTitle: bookId, query: '查' });
  await seed('b_book1', 'ch_001');
  await seed('b_book1', 'ch_002');
  await seed('b_book2', 'ch_001');

  assert.equal(await store.resetFindBookmarksForBook('b_book1'), 2, '返回实际删掉的条数');
  const list = await store.listFindBookmarks();
  assert.deepEqual(list.map((item) => item.bookId), ['b_book2'], '只删这本书的，别的书的书签原样保留');
  const saved = await store.get();
  assert.equal(saved.editorFont, 'kai', '其它配置字段不受影响');
  assert.equal(saved.dailyGoal, 1200);

  // 没有该书书签 / 空 id：返回 0，且不写盘（重新读到的内容与写盘前一致）
  assert.equal(await store.resetFindBookmarksForBook('b_book2'), 1);
  assert.equal(await store.resetFindBookmarksForBook('b_book2'), 0, '再清一次没有条目 → 0');
  assert.equal(await store.resetFindBookmarksForBook(''), 0);
  assert.equal(await store.resetFindBookmarksForBook(null), 0);
  assert.deepEqual(await store.listFindBookmarks(), []);
  // 重启后仍然是清的（写盘成功，不是只在内存里删）
  assert.deepEqual(await createConfigStore(dir).listFindBookmarks(), []);
});

// 2026-11-25（新建分组）：配置里的空分组清单清洗。
test('bookGroups：空分组清单按分组字段同口径清洗（trim / 去控制字符 / 40 字 / 大小写去重 / 上限 200）', () => {
  const cfg = sanitize({
    bookGroups: [' 短篇 ', '短篇', 'A', 'a', 42, '', '   ', 'x'.repeat(100)]
  });
  assert.deepEqual(cfg.bookGroups, ['短篇', 'A', 'x'.repeat(40)], 'trim / 去重 / 40 字截断');
  assert.deepEqual(sanitize({}).bookGroups || [], [], '旧配置没有这个键 = 空清单（空清单不落盘）');
  const many = Array.from({ length: 250 }, (_, i) => `组${i}`);
  assert.equal(sanitize({ bookGroups: many }).bookGroups.length, 200, '最多 200 个');
});
