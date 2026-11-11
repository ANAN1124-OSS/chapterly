const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const bookInfo = require('../core/bookinfo');
const storage = require('../core/storage');

const tmpCleanup = require('./tmp-cleanup');

async function mkTmp(prefix = 'cw-bookinfo-') {
  return tmpCleanup.track(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

test('书籍信息：作者单行化、去首尾空白、限长；非字符串当空', () => {
  assert.equal(bookInfo.sanitizeAuthor('  张三  '), '张三');
  assert.equal(bookInfo.sanitizeAuthor('张\n三\t著'), '张 三 著');
  assert.equal(bookInfo.sanitizeAuthor('张   三'), '张 三');
  assert.equal(bookInfo.sanitizeAuthor(42), '');
  assert.equal(bookInfo.sanitizeAuthor(null), '');
  assert.equal(bookInfo.sanitizeAuthor('名'.repeat(bookInfo.MAX_AUTHOR_LENGTH + 20)).length, bookInfo.MAX_AUTHOR_LENGTH);
});

test('书籍信息：分组是单行短文本，超长截断', () => {
  assert.equal(bookInfo.sanitizeGroup('  玄幻  '), '玄幻');
  assert.equal(bookInfo.sanitizeGroup('短篇\r\n合集'), '短篇 合集');
  assert.equal(bookInfo.sanitizeGroup('组'.repeat(bookInfo.MAX_GROUP_LENGTH + 5)).length, bookInfo.MAX_GROUP_LENGTH);
  assert.equal(bookInfo.sanitizeGroup(undefined), '');
});

test('书籍信息：简介保留换行、去行尾空白、合并多余空行、限长', () => {
  assert.equal(bookInfo.sanitizeBrief('第一行\r\n\r\n\r\n第二行   '), '第一行\n\n第二行');
  assert.equal(bookInfo.sanitizeBrief('\r\n\r\n开头有空行\n\n\n\n结尾也有\r\n\r\n'), '开头有空行\n\n结尾也有');
  assert.equal(bookInfo.sanitizeBrief('   '), '');
  assert.equal(bookInfo.sanitizeBrief(123), '');
  const long = '段'.repeat(bookInfo.MAX_BRIEF_LENGTH + 100);
  assert.equal(bookInfo.sanitizeBrief(long).length, bookInfo.MAX_BRIEF_LENGTH);
  // 代理对不被从中间切开
  const emoji = bookInfo.sanitizeBrief('😀'.repeat(700));
  assert.equal(emoji.length % 2, 0);
  assert.equal(/[\uD800-\uDBFF]$/.test(emoji), false);
});

test('书籍信息：标签支持数组 / 各种分隔符、去空去重、限个数与长度', () => {
  assert.deepEqual(bookInfo.sanitizeTags([' 爽文 ', '', '升级', '爽文']), ['爽文', '升级']);
  assert.deepEqual(bookInfo.sanitizeTags('爽文，升级、悬疑; 短篇、爽文'), ['爽文', '升级', '悬疑', '短篇']);
  assert.deepEqual(bookInfo.sanitizeTags('a\nb'), ['a', 'b']);
  assert.deepEqual(bookInfo.sanitizeTags(12), []);
  const many = Array.from({ length: 15 }, (_, i) => `标签${i + 1}`);
  assert.equal(bookInfo.sanitizeTags(many).length, bookInfo.MAX_TAGS);
  const longTag = '标'.repeat(bookInfo.MAX_TAG_LENGTH + 8);
  assert.equal(bookInfo.sanitizeTags([longTag])[0].length, bookInfo.MAX_TAG_LENGTH);
});

test('书籍信息：旧书没有可选字段时读成空值，不补字段', () => {
  const meta = { title: '旧书', chapters: [{ id: 'ch_001', file: '001.txt' }] };
  assert.deepEqual(bookInfo.readBookInfo(meta), { author: '', brief: '', group: '', tags: [] });
  const cleaned = bookInfo.cleanBookInfo(meta);
  assert.deepEqual(cleaned, meta);
  assert.equal('author' in cleaned, false);
  assert.equal('tags' in cleaned, false);
});

test('书籍信息：脏值读取时清洗，不改原对象；空值不落字段', () => {
  const meta = {
    title: '书',
    chapters: [],
    author: '  张三\n',
    brief: '第一行\r\n\r\n\r\n第二行',
    group: 42,
    tags: [' 爽文 ', '爽文', 7, '']
  };
  const info = bookInfo.readBookInfo(meta);
  assert.deepEqual(info, { author: '张三', brief: '第一行\n\n第二行', group: '', tags: ['爽文'] });
  assert.equal(meta.author, '  张三\n', '不修改传入对象');
  const cleaned = bookInfo.cleanBookInfo(meta);
  assert.equal(cleaned.author, '张三');
  assert.equal(cleaned.brief, '第一行\n\n第二行');
  assert.equal('group' in cleaned, false, '非法分组被清掉');
  assert.deepEqual(cleaned.tags, ['爽文']);
  assert.equal(cleaned.title, '书');
  assert.deepEqual(cleaned.chapters, []);
});

test('书籍信息：patch 只认四个白名单字段，类型不对返回 null', () => {
  assert.equal(bookInfo.bookInfoPatchFields(null), null);
  assert.equal(bookInfo.bookInfoPatchFields([]), null);
  assert.equal(bookInfo.bookInfoPatchFields({}), null);
  assert.equal(bookInfo.bookInfoPatchFields({ title: '改书名' }), null);
  assert.equal(bookInfo.bookInfoPatchFields({ author: 42 }), null);
  assert.equal(bookInfo.bookInfoPatchFields({ brief: null }), null);
  assert.equal(bookInfo.bookInfoPatchFields({ tags: { a: 1 } }), null);
  assert.equal(bookInfo.bookInfoPatchFields({ tags: ['ok', 3] }), null);
  assert.deepEqual(bookInfo.bookInfoPatchFields({ author: ' 张三 ' }), { author: '张三' });
  assert.deepEqual(bookInfo.bookInfoPatchFields({ group: '' }), { group: '' });
  assert.deepEqual(bookInfo.bookInfoPatchFields({ tags: [] }), { tags: [] });
  assert.deepEqual(bookInfo.bookInfoPatchFields({ tags: '爽文，升级' }), { tags: ['爽文', '升级'] });
});

test('书籍信息：sameBookInfo 比较四个字段，标签顺序算不同', () => {
  const base = { author: '张三', brief: '简介', group: '玄幻', tags: ['爽文', '升级'] };
  assert.equal(bookInfo.sameBookInfo(base, { ...base, tags: [...base.tags] }), true);
  assert.equal(bookInfo.sameBookInfo(base, { ...base, author: '李四' }), false);
  assert.equal(bookInfo.sameBookInfo(base, { ...base, tags: ['升级', '爽文'] }), false);
  assert.equal(bookInfo.sameBookInfo({}, { author: '', brief: '', group: '', tags: [] }), true);
});

test('书籍信息：书架搜索补作者 / 分组 / 标签，字面量不区分大小写', () => {
  const info = { author: '张三', group: '玄幻', tags: ['爽文', 'Upgrade'] };
  assert.equal(bookInfo.bookInfoMatches(info, '张三'), true);
  assert.equal(bookInfo.bookInfoMatches(info, '玄幻'), true);
  assert.equal(bookInfo.bookInfoMatches(info, '爽'), true);
  assert.equal(bookInfo.bookInfoMatches(info, 'upgrade'), true);
  assert.equal(bookInfo.bookInfoMatches(info, ' 张三 '), true);
  assert.equal(bookInfo.bookInfoMatches(info, '李四'), false);
  assert.equal(bookInfo.bookInfoMatches(info, ''), false);
  assert.equal(bookInfo.bookInfoMatches(null, '张三'), false);
});

test('书籍信息：摘要只拼非空字段', () => {
  assert.equal(
    bookInfo.bookInfoSummary({ author: '张三', group: '玄幻', tags: ['爽文', '升级'] }),
    '作者：张三 · 分组：玄幻 · #爽文 #升级'
  );
  assert.equal(bookInfo.bookInfoSummary({}), '');
});

test('书籍信息：updateBookInfo 只写书目可选字段，章节 txt / 文件名 / 文件夹不变', async () => {
  const root = await mkTmp();
  const created = await storage.createBook(root, '信息测试书');
  const bookPath = created.path;
  let meta = await storage.readBookMeta(bookPath);
  const file = meta.chapters[0].file;
  const filePath = path.join(bookPath, file);
  await storage.saveChapterText(bookPath, file, '第一章正文\n');
  const beforeText = await fs.readFile(filePath);
  const beforeStat = await fs.stat(filePath);
  const beforeEntries = (await fs.readdir(bookPath)).sort();
  const beforeMetaBytes = await fs.readFile(path.join(bookPath, '书目.json'));

  const result = await storage.updateBookInfo(bookPath, {
    author: ' 张三 ',
    brief: '第一行\r\n\r\n\r\n第二行  ',
    group: ' 玄幻 ',
    tags: ['爽文', ' 爽文 ', '升级', '']
  });
  assert.equal(result.changed, true);

  meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.author, '张三');
  assert.equal(meta.brief, '第一行\n\n第二行');
  assert.equal(meta.group, '玄幻');
  assert.deepEqual(meta.tags, ['爽文', '升级']);

  const onDisk = JSON.parse(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'));
  assert.equal(onDisk.author, '张三');
  assert.equal(onDisk.group, '玄幻');
  assert.deepEqual(onDisk.tags, ['爽文', '升级']);
  // 上一版书目留在 .bak（原样，不是脏值）
  const bak = JSON.parse(await fs.readFile(path.join(bookPath, '书目.json.bak'), 'utf8'));
  assert.equal(bak.author, undefined);
  assert.equal(bak.title, created.meta.title);
  assert.deepEqual(beforeMetaBytes, await fs.readFile(path.join(bookPath, '书目.json.bak')));

  // 章节 txt、文件名、文件夹内容都没变（只有书目 / .bak 被原子替换）
  assert.deepEqual(await fs.readFile(filePath), beforeText);
  const afterStat = await fs.stat(filePath);
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
  const afterEntries = (await fs.readdir(bookPath)).sort();
  const contentFiles = (names) => names.filter((name) => name !== '书目.json' && name !== '书目.json.bak');
  assert.deepEqual(contentFiles(afterEntries), contentFiles(beforeEntries), '章节 txt 等文件一个不多一个不少');

  // 书架列表带上这四个可选字段（旧书则是空值）
  const listed = (await storage.listBooks(root)).find((book) => book.path === bookPath);
  assert.equal(listed.author, '张三');
  assert.equal(listed.brief, '第一行\n\n第二行');
  assert.equal(listed.group, '玄幻');
  assert.deepEqual(listed.tags, ['爽文', '升级']);
});

test('书籍信息：清空可选字段 = 从书目里删掉；没有变化时不写盘', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '清空测试');
  await storage.updateBookInfo(bookPath, { author: '张三', brief: '简介', group: '玄幻', tags: ['爽文'] });

  const first = await storage.updateBookInfo(bookPath, { author: '', brief: '', group: '', tags: [] });
  assert.equal(first.changed, true);
  let meta = await storage.readBookMeta(bookPath);
  assert.equal('author' in meta, false);
  assert.equal('brief' in meta, false);
  assert.equal('group' in meta, false);
  assert.equal('tags' in meta, false);

  // 同样的值再存一次：changed=false，书目字节与 mtime 都不动（不无意义轮换 .bak）
  const metaPath = path.join(bookPath, '书目.json');
  const beforeBytes = await fs.readFile(metaPath);
  const beforeStat = await fs.stat(metaPath);
  const again = await storage.updateBookInfo(bookPath, { author: '', group: '', tags: [] });
  assert.equal(again.changed, false);
  assert.deepEqual(await fs.readFile(metaPath), beforeBytes);
  assert.equal((await fs.stat(metaPath)).mtimeMs, beforeStat.mtimeMs);
  meta = await storage.readBookMeta(bookPath);
  assert.equal('author' in meta, false);

  // 非法 patch 直接拒绝，不静默清空
  await assert.rejects(
    () => storage.updateBookInfo(bookPath, { author: 42 }),
    (err) => err.code === 'BAD_BOOK_INFO'
  );
  await assert.rejects(
    () => storage.updateBookInfo(bookPath, {}),
    (err) => err.code === 'BAD_BOOK_INFO'
  );
  await assert.rejects(
    () => storage.updateBookInfo(bookPath, { tags: [1, 2] }),
    (err) => err.code === 'BAD_BOOK_INFO'
  );
});

test('书籍信息：旧书（没有可选字段）照常改名 / 改章信息，不补书籍字段', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '旧书兼容');
  const meta = await storage.readBookMeta(bookPath);
  assert.equal('author' in meta, false);
  assert.equal('brief' in meta, false);
  assert.equal('group' in meta, false);
  assert.equal('tags' in meta, false);

  await storage.renameBook(bookPath, '旧书兼容-改名');
  await storage.updateChapterMeta(bookPath, meta.chapters[0].id, { status: 'done', note: '旧书备注' });
  const onDisk = JSON.parse(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'));
  assert.equal(onDisk.title, '旧书兼容-改名');
  assert.equal(onDisk.chapters[0].status, 'done');
  for (const key of ['author', 'brief', 'group', 'tags']) {
    assert.equal(key in onDisk, false, `改名 / 改章信息不应补 ${key}`);
  }
  const listed = (await storage.listBooks(root)).find((book) => book.path === bookPath);
  assert.deepEqual([listed.author, listed.brief, listed.group, listed.tags], ['', '', '', []]);
});

test('书籍信息：书目里的脏值（类型不对 / 超长）读取时清洗，不写盘', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '脏值测试');
  const metaPath = path.join(bookPath, '书目.json');
  const raw = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  raw.author = 42;
  raw.group = '  玄幻\n下篇 ';
  raw.tags = [' 爽文 ', 9, '爽文'];
  raw.brief = '第一行\r\n\r\n\r\n第二行';
  await fs.writeFile(metaPath, JSON.stringify(raw, null, 2), 'utf8');
  const bytes = await fs.readFile(metaPath);

  const meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.author, undefined);
  assert.equal(meta.group, '玄幻 下篇');
  assert.deepEqual(meta.tags, ['爽文']);
  assert.equal(meta.brief, '第一行\n\n第二行');
  assert.deepEqual(await fs.readFile(metaPath), bytes, '只读不清洗落盘；下次正常写盘才落');

  const listed = (await storage.listBooks(root)).find((book) => book.path === bookPath);
  assert.equal(listed.author, '');
  assert.equal(listed.group, '玄幻 下篇');
  assert.deepEqual(listed.tags, ['爽文']);
});

// ---------- 书架筛选 / 分组管理纯逻辑（1.6.0 F5） ----------
// 分组是自由字符串：书架筛选条要按它过滤，分组管理要能改名 / 合并。
// 这里只算「哪些书要改成什么」，真正写盘仍由 storage.updateBookInfo 一本一本做（只动 书目.json）。
test('分组统计：按作者写法聚合、中文排序、未分组单独计数、坏数据不炸', () => {
  const books = [
    { path: '/库/甲', title: '甲', group: '玄幻' },
    { path: '/库/乙', title: '乙', group: '短篇' },
    { path: '/库/丙', title: '丙', group: ' 玄幻 ' },
    { path: '/库/丁', title: '丁' },
    { path: '/库/戊', title: '戊', group: '   ' },
    { path: '/库/己', title: '己', group: 42 },
    null,
    { path: '/库/庚', title: '庚', group: ' 短篇\n合集 ' }
  ];
  assert.deepEqual(bookInfo.collectGroupStats(books), {
    groups: [
      { name: '短篇', count: 1 },
      { name: '短篇 合集', count: 1 },
      { name: '玄幻', count: 2 }
    ],
    ungrouped: 3,
    total: 7
  });
  assert.deepEqual(bookInfo.collectGroupStats([]), { groups: [], ungrouped: 0, total: 0 });
  assert.deepEqual(bookInfo.collectGroupStats(null), { groups: [], ungrouped: 0, total: 0 });
});

test('标签统计：跨书累加、同书内已去重、中文排序、坏数据不炸', () => {
  const books = [
    { path: '/库/甲', tags: ['升级', '爽文'] },
    { path: '/库/乙', tags: [' 爽文 ', '悬疑', '爽文'] },
    { path: '/库/丙' },
    { path: '/库/丁', tags: '升级，系统' },
    null
  ];
  assert.deepEqual(bookInfo.collectTagStats(books), [
    { name: '升级', count: 2 },
    { name: '爽文', count: 2 },
    { name: '系统', count: 1 },
    { name: '悬疑', count: 1 }
  ]);
  assert.deepEqual(bookInfo.collectTagStats([]), []);
});

test('筛选判定：分组 / 标签各自精确匹配，两条同时生效就是 AND', () => {
  const book = { path: '/库/甲', group: '玄幻', tags: ['升级', '爽文'] };
  assert.equal(bookInfo.bookMatchesFilters(book, {}), true);
  assert.equal(bookInfo.bookMatchesFilters(book, { group: '', tag: '' }), true);
  assert.equal(bookInfo.bookMatchesFilters(book, { group: '玄幻' }), true);
  assert.equal(bookInfo.bookMatchesFilters(book, { group: '玄幻 ' }), true, '分组按清洗后比较');
  assert.equal(bookInfo.bookMatchesFilters(book, { group: '短篇' }), false);
  assert.equal(bookInfo.bookMatchesFilters(book, { group: '__none__' }), false);
  assert.equal(bookInfo.bookMatchesFilters({ path: '/库/乙' }, { group: '__none__' }), true);
  assert.equal(bookInfo.bookMatchesFilters({ path: '/库/乙' }, { group: '玄幻' }), false);
  assert.equal(bookInfo.bookMatchesFilters(book, { tag: '升级' }), true);
  assert.equal(bookInfo.bookMatchesFilters(book, { tag: '升' }), false, '标签是全名精确匹配，不做子串');
  assert.equal(bookInfo.bookMatchesFilters(book, { group: '玄幻', tag: '悬疑' }), false);
  assert.equal(bookInfo.bookMatchesFilters(book, { group: '玄幻', tag: '爽文' }), true);
  assert.equal(bookInfo.bookMatchesFilters(null, {}), true, '没有书对象 = 不筛');
  assert.equal(bookInfo.bookMatchesFilters(null, { group: '玄幻' }), false);
});

test('分组名归一：大小写 / 首尾与内部空白归一，能对上已有写法就用已有写法', () => {
  const groups = ['玄幻', 'Group A', '短篇'];
  assert.equal(bookInfo.canonicalGroupName(groups, '  玄幻 '), '玄幻');
  assert.equal(bookInfo.canonicalGroupName(groups, 'group   A'), 'Group A', '大小写 + 连续空白归一');
  assert.equal(bookInfo.canonicalGroupName(groups, '新组'), '新组');
  assert.equal(bookInfo.canonicalGroupName(groups, '   '), '');
  assert.equal(bookInfo.canonicalGroupName([], ' 都市 '), '都市');
});

test('分组改名 / 合并计划：只列要改的书、目标归一、不改入参、同组返回空', () => {
  const books = [
    { path: '/库/甲', title: '甲', group: '玄幻' },
    { path: '/库/乙', title: '乙', group: '玄幻 ' },
    { path: '/库/丙', title: '丙', group: 'group a' },
    { path: '/库/丁', title: '丁' },
    { title: '没有路径' }
  ];
  const snapshot = JSON.stringify(books);
  assert.deepEqual(bookInfo.planGroupChange(books, '玄幻', '仙侠'), [
    { path: '/库/甲', title: '甲', from: '玄幻', to: '仙侠' },
    { path: '/库/乙', title: '乙', from: '玄幻', to: '仙侠' }
  ]);
  // 合并到已存在的组：大小写归一后归到已有写法，不多造一个「GROUP A」
  assert.deepEqual(
    bookInfo.planGroupChange(books, '玄幻', 'GROUP A').map((change) => [change.path, change.to]),
    [['/库/甲', 'group a'], ['/库/乙', 'group a']]
  );
  // 未分组 → 某个组
  assert.deepEqual(
    bookInfo.planGroupChange(books, '', '玄幻').map((change) => [change.path, change.to]),
    [['/库/丁', '玄幻']]
  );
  // 某个组 → 未分组（清空）
  assert.deepEqual(
    bookInfo.planGroupChange(books, '玄幻', '   ').map((change) => [change.path, change.to]),
    [['/库/甲', ''], ['/库/乙', '']]
  );
  // 归一后同名 = 没有变化
  assert.deepEqual(bookInfo.planGroupChange(books, '玄幻', ' 玄幻 '), []);
  assert.deepEqual(bookInfo.planGroupChange([], '玄幻', '仙侠'), []);
  assert.equal(JSON.stringify(books), snapshot, '不改入参');
});
