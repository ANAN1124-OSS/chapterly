// C2（审计 #2 / P2）：消「预览 → 执行」双读 —— 整本整理 / 整本替换的正文快照。
//
// 这里钉五件事：
//   1. 命中：预览（整本查找 / 整理预检查）→ 执行（整本替换 / 整本整理）时，执行阶段
//      **一章都不再读盘**（用 patch fs.readFile 计数），结果与「再读一遍」逐字一致；
//   2. 失效回退：预览之后章节文件被外部改过（mtime 变、尺寸不变也算）→ 只重读那一章，
//      并且按新正文算结果（绝不拿预览时的旧正文去改作者的书）；
//   3. 没有预览 = 原行为：直接执行照旧逐章读盘（零回归）；
//   4. 缓存本体：mtime + size 校验、take 一次性、TTL、正文容量上界、快照数上限、drop；
//   5. 静态闸门：只有「查找 / 预检查」记录快照、「替换 / 整理」消费快照；缓存只存内存不碰磁盘；
//      loadChapterText 必须先 stat 再读（否则预览可能记下比正文更新的 mtime）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const storage = require('../core/storage');
const previewCacheLib = require('../core/preview-cache');
const formatLib = require('../core/format');
const chaptersLib = require('../core/chapters');

const tmpCleanup = require('./tmp-cleanup');

const FORMAT_OPTIONS = { indent: '2', blankLines: 'keep', trimTrailing: true, normalizePunct: true };
const NOOP_FORMAT_OPTIONS = { indent: 'none', blankLines: 'keep', trimTrailing: false, normalizePunct: false };

async function mkTmp(prefix = 'cw-preview-cache-') {
  return tmpCleanup.track(await fsp.mkdtemp(path.join(os.tmpdir(), prefix)));
}

// 造一本 count 章的书；textFor(index) 决定每章正文。
async function makeBook(textFor, count = 5) {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '快照书');
  for (let i = 1; i < count; i += 1) await storage.createChapter(bookPath, i, `第${i + 1}章`);
  let meta = await storage.readBookMeta(bookPath);
  for (let i = 0; i < meta.chapters.length; i += 1) {
    await storage.saveChapterText(bookPath, meta.chapters[i].file, textFor(i));
  }
  meta = await storage.readBookMeta(bookPath);
  return { root, bookPath, meta };
}

// 统计这本书的章节正文读盘次数（storage / core/atomic 用的是同一个 node:fs/promises 对象，
// 所以临时替换 readFile 就能精确看到「哪些章真的读了」；书目.json 不算）。
async function countChapterReads(bookPath, task) {
  const bookPrefix = path.resolve(bookPath).toLowerCase();
  const original = fsp.readFile;
  const reads = [];
  fsp.readFile = async function patchedReadFile(file, ...rest) {
    const target = String(file).toLowerCase();
    if (target.startsWith(bookPrefix) && target.endsWith('.txt')) reads.push(String(file));
    return original.call(fsp, file, ...rest);
  };
  try {
    const value = await task();
    return { value, reads };
  } finally {
    fsp.readFile = original;
  }
}

const readSource = (rel) =>
  require('node:fs').readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

// ---------- 缓存本体 ----------

test('预览快照：只在 mtime + size 都一致时才复用正文', () => {
  const cache = previewCacheLib.createPreviewCache();
  const snapshot = cache.begin('D:\\书库\\甲书');
  assert.equal(
    snapshot.remember('001.txt', { mtimeMs: 1000, size: 6, text: '正文甲' }),
    true
  );
  assert.equal(snapshot.entryCount(), 1);
  assert.equal(snapshot.textChars, 3);

  assert.deepEqual(snapshot.lookup('001.txt'), { mtimeMs: 1000, size: 6, text: '正文甲' });
  assert.equal(snapshot.lookup('002.txt'), null);
  // 校验口径是「值和预览时完全一致」，不是「更新过就行」
  const later = previewCacheLib.createPreviewCache();
  const other = later.begin('D:\\书库\\甲书');
  other.remember('001.txt', { mtimeMs: 1000, size: 6, text: '正文甲' });
  assert.equal(other.lookup('001.txt').mtimeMs, 1000);
  // 同尺寸但 mtime 不同 = 变过；不同尺寸当然也是变过 —— 调用方据此回退读盘
  assert.notEqual(other.lookup('001.txt').mtimeMs, 1001);
  assert.notEqual(other.lookup('001.txt').size, 7);
});

test('预览快照：take 一次性取走，drop / 过期都释放正文', () => {
  let clock = 1000;
  const cache = previewCacheLib.createPreviewCache({ ttlMs: 100, now: () => clock });
  const snapshot = cache.begin('D:\\书库\\乙书');
  snapshot.remember('001.txt', { mtimeMs: 5, size: 2, text: '甲' });
  const taken = cache.take('D:\\书库\\乙书');
  assert.strictEqual(taken, snapshot, '执行阶段拿到的就是预览那份快照');
  assert.equal(taken.lookup('001.txt').text, '甲');
  assert.equal(cache.take('D:\\书库\\乙书'), null, 'take 之后仓库里就没有了（一次预览只服务一次执行）');
  assert.deepEqual(cache.sizes(), { snapshots: 0, textChars: 0 });

  // drop：重复调用、传 null 都安全，正文被清掉
  cache.drop(taken);
  cache.drop(taken);
  cache.drop(null);
  assert.equal(taken.entryCount(), 0);
  assert.equal(taken.textChars, 0);

  // 过期：take 直接丢，绝不复用超时的正文
  const expired = cache.begin('D:\\书库\\丙书');
  expired.remember('001.txt', { mtimeMs: 5, size: 2, text: '乙' });
  clock += 101;
  assert.equal(cache.take('D:\\书库\\丙书'), null);
  assert.deepEqual(cache.sizes(), { snapshots: 0, textChars: 0 });
});

test('预览快照：容量与快照数都有上界，放不下的章不缓存（执行阶段照旧读盘）', () => {
  const cache = previewCacheLib.createPreviewCache({ maxTextChars: 6, maxEntries: 2, maxSnapshots: 2 });
  const snapshot = cache.begin('D:\\书库\\丁书');
  assert.equal(snapshot.remember('001.txt', { mtimeMs: 1, size: 1, text: '1234' }), true);
  assert.equal(
    snapshot.remember('002.txt', { mtimeMs: 1, size: 1, text: '5678' }),
    false,
    '正文预算用完就不缓存'
  );
  assert.equal(snapshot.remember('003.txt', { mtimeMs: 1, size: 1, text: '' }), true, '空正文不占预算，仍可缓存');
  assert.equal(snapshot.lookup('002.txt'), null);
  assert.equal(snapshot.entryCount(), 2);
  assert.equal(snapshot.remember('004.txt', { mtimeMs: 1, size: 1, text: '' }), false, '条目数上界同样生效');
  // 非法入参不记（编号空、stat 不完整、正文不是字符串）
  assert.equal(snapshot.remember('', { mtimeMs: 1, size: 1, text: 'x' }), false);
  assert.equal(snapshot.remember('005.txt', { mtimeMs: 1, size: 1 }), false);
  assert.equal(snapshot.remember('006.txt', { size: 1, text: 'x' }), false);
  assert.equal(snapshot.remember('007.txt', { mtimeMs: 1, size: 1, text: 7 }), false);

  // 快照数上限：最旧的先淘汰；同一本书再预览会替换旧快照
  cache.begin('D:\\书库\\戊书').remember('a.txt', { mtimeMs: 1, size: 1, text: 'x' });
  cache.begin('D:\\书库\\己书').remember('a.txt', { mtimeMs: 1, size: 1, text: 'y' });
  const again = cache.begin('D:\\书库\\戊书');
  assert.equal(cache.sizes().snapshots, 2);
  assert.strictEqual(cache.take('D:\\书库\\戊书'), again);
  assert.equal(cache.take('D:\\书库\\丁书'), null, '丁书是最旧的快照，被挤掉了');
});

test('预览快照：书路径键大小写不敏感（与 withBookLock 同口径）', () => {
  assert.equal(
    previewCacheLib.bookKey('D:\\书库\\甲书'),
    previewCacheLib.bookKey('d:\\书库\\甲书')
  );
  assert.equal(previewCacheLib.bookKey(null), previewCacheLib.bookKey(''));
});

// ---------- 与 storage 的集成 ----------

test('整本整理：预览 → 执行复用快照，执行阶段一章都不读盘，结果与逐章 formatText 一致', async () => {
  const sourceTexts = ['  第一段  ', '　　已经整理好。', '  第三段  ', '  第四段  ', '  第五段  '];
  const { bookPath, meta } = await makeBook((index) => sourceTexts[index]);
  const expected = sourceTexts.map((text) => formatLib.formatText(text, FORMAT_OPTIONS));

  const preview = await storage.previewFormatBook(bookPath, FORMAT_OPTIONS);
  assert.equal(preview.chaptersChanged, 4, '第 2 章本来就是整理后的样子');

  const { value: res, reads } = await countChapterReads(bookPath, () =>
    storage.formatBook(bookPath, FORMAT_OPTIONS)
  );
  assert.deepEqual(reads, [], '执行阶段必须复用预览读到的正文（0 次读盘）');
  assert.equal(res.chaptersChanged, 4);
  assert.deepEqual(res.stats, preview.stats, '统计与预览完全一致');
  for (let index = 0; index < meta.chapters.length; index += 1) {
    const text = (await storage.loadChapterText(bookPath, meta.chapters[index].file)).text;
    assert.equal(text, expected[index].text, `第 ${index + 1} 章整理结果`);
  }
  const after = await storage.readBookMeta(bookPath);
  assert.equal(after.chapters[0].chars, chaptersLib.countChars(expected[0].text), '字数缓存照旧更新');
  const backupFiles = await fsp.readdir(res.backupDir);
  assert.equal(backupFiles.length, 4, '要改动的章都先备份');
});

test('整本整理：快照只复用正文，换一组规则执行时按新规则重算（不会被预览的结论带偏）', async () => {
  const sourceTexts = ['  甲段  ', '  乙段  '];
  const { bookPath, meta } = await makeBook((index) => sourceTexts[index], 2);
  const bare = await storage.previewFormatBook(bookPath, NOOP_FORMAT_OPTIONS);
  assert.equal(bare.chaptersChanged, 0, '先用「不整理」的规则预览一遍（只读，什么都不改）');

  const { value: res, reads } = await countChapterReads(bookPath, () =>
    storage.formatBook(bookPath, FORMAT_OPTIONS)
  );
  assert.deepEqual(reads, [], '正文仍然可以复用预览读到的版本');
  assert.equal(res.chaptersChanged, 2, '改动与否由执行阶段的规则 + 正文现算，不看预览结论');
  for (let index = 0; index < meta.chapters.length; index += 1) {
    const text = (await storage.loadChapterText(bookPath, meta.chapters[index].file)).text;
    assert.equal(text, formatLib.formatText(sourceTexts[index], FORMAT_OPTIONS).text);
  }
});

test('整本整理：预览之后被外部改过的章回退重读（同尺寸但 mtime 变了也算）', async () => {
  // 两章同字节数：'  旧章  ' → '  新章  '（都是 2+3+2 个 UTF-8 字节）
  const { bookPath, meta } = await makeBook((index) => (index === 1 ? '  旧章  ' : '  原样  '), 2);
  await storage.previewFormatBook(bookPath, FORMAT_OPTIONS);

  const changedFile = path.join(bookPath, meta.chapters[1].file);
  const before = await fsp.stat(changedFile);
  await fsp.writeFile(changedFile, '  新章  ');
  const bumped = new Date(before.mtimeMs + 5000);
  await fsp.utimes(changedFile, bumped, bumped);
  const afterWrite = await fsp.stat(changedFile);
  assert.equal(afterWrite.size, before.size, '尺寸没变 —— 只能靠 mtime 判出「文件变过」');
  assert.notEqual(afterWrite.mtimeMs, before.mtimeMs);

  const { value: res, reads } = await countChapterReads(bookPath, () =>
    storage.formatBook(bookPath, FORMAT_OPTIONS)
  );
  assert.equal(reads.length, 1, '只有被改过的那一章回退读盘，另一章仍复用快照');
  assert.equal(reads[0].toLowerCase(), changedFile.toLowerCase());
  assert.equal(res.chaptersChanged, 2);
  assert.equal(
    (await storage.loadChapterText(bookPath, meta.chapters[1].file)).text,
    formatLib.formatText('  新章  ', FORMAT_OPTIONS).text,
    '必须按新正文整理，不能拿预览时的旧正文写盘'
  );
});

test('整本替换：查找 → 替换复用快照，0 次读盘，备份 / 字数 / 结果与读盘版一致', async () => {
  const { bookPath, meta } = await makeBook(
    (index) => (index === 0 ? '阿明走进屋里。' : index === 2 ? '阿明抬头。' : '这里没有那个人。'),
    3
  );
  const preview = await storage.searchBook(bookPath, { query: '阿明' });
  assert.equal(preview.totalMatches, 2);

  const { value: res, reads } = await countChapterReads(bookPath, () =>
    storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' })
  );
  assert.deepEqual(reads, [], '执行阶段必须复用整本查找读到的正文（0 次读盘）');
  assert.equal(res.chaptersChanged, 2);
  assert.equal(res.occurrences, 2);
  const after = await storage.readBookMeta(bookPath);
  assert.equal((await storage.loadChapterText(bookPath, after.chapters[0].file)).text, '小明走进屋里。');
  assert.equal((await storage.loadChapterText(bookPath, after.chapters[1].file)).text, '这里没有那个人。');
  assert.equal((await storage.loadChapterText(bookPath, after.chapters[2].file)).text, '小明抬头。');
  assert.equal((await fsp.readFile(path.join(res.backupDir, meta.chapters[0].file), 'utf8')), '阿明走进屋里。');
  assert.equal(after.chapters[0].chars, chaptersLib.countChars('小明走进屋里。'));
});

test('整本替换：预览之后被外部改过的章回退重读，替换按最新正文算', async () => {
  const { bookPath, meta } = await makeBook((index) => (index === 0 ? '阿明甲' : '阿明乙'), 2);
  await storage.searchBook(bookPath, { query: '阿明' });

  const changedFile = path.join(bookPath, meta.chapters[0].file);
  const before = await fsp.stat(changedFile);
  await fsp.writeFile(changedFile, '阿明丙');
  const bumped = new Date(before.mtimeMs + 5000);
  await fsp.utimes(changedFile, bumped, bumped);
  assert.equal((await fsp.stat(changedFile)).size, before.size, '尺寸相同，靠 mtime 判出改动');

  const { value: res, reads } = await countChapterReads(bookPath, () =>
    storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' })
  );
  assert.equal(reads.length, 1, '只重读被改过的那一章');
  assert.equal(res.chaptersChanged, 2);
  const after = await storage.readBookMeta(bookPath);
  assert.equal((await storage.loadChapterText(bookPath, after.chapters[0].file)).text, '小明丙');
  assert.equal((await storage.loadChapterText(bookPath, after.chapters[1].file)).text, '小明乙');
});

test('整本替换：没有预览时照旧逐章读盘（零回归）', async () => {
  const { bookPath } = await makeBook((index) => `第${index + 1}章 阿明。`, 3);
  const { value: res, reads } = await countChapterReads(bookPath, () =>
    storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' })
  );
  assert.equal(reads.length, 3, '没有快照就走原来的读盘路径，一章一次');
  assert.equal(res.chaptersChanged, 3);
});

test('整本替换：快照按书隔离，另一本书的预览不会被拿来用', async () => {
  const bookA = await makeBook(() => '阿明甲。', 2);
  const bookB = await makeBook(() => '阿明乙。', 3);
  await storage.searchBook(bookA.bookPath, { query: '阿明' });
  const { value: res, reads } = await countChapterReads(bookB.bookPath, () =>
    storage.replaceInBook(bookB.bookPath, { query: '阿明', replacement: '小明' })
  );
  assert.equal(reads.length, 3, '乙书没有自己的快照，必须逐章读盘');
  assert.equal(res.chaptersChanged, 3);
});

// ---------- 静态闸门 ----------

test('静态闸门：预览两条记录快照、执行两条消费快照，缓存模块不碰磁盘', () => {
  const storageSource = readSource('core/storage.js');
  assert.match(storageSource, /const chapterPreviewCache = previewCacheLib\.createPreviewCache\(\);/);
  assert.equal(
    (storageSource.match(/withPreviewSnapshot\(bookPath, \(\) =>/g) || []).length,
    2,
    '只有整本查找 / 整理预检查两处记录快照'
  );
  assert.equal(
    (storageSource.match(/withReusedSnapshot\(bookPath, \(\) =>/g) || []).length,
    2,
    '只有整本替换 / 整本整理两处消费快照'
  );
  assert.match(
    storageSource,
    /if \(entry\.mtimeMs !== stat\.mtimeMs \|\| entry\.size !== stat\.size\) return undefined;/,
    '复用前必须按 mtime + size 校验'
  );
  assert.match(storageSource, /if \(chapterReadContexts\.get\(key\) === context\) chapterReadContexts\.delete\(key\);/);

  // 缓存只存在内存里：不许出现任何 fs / 磁盘写入
  const cacheSource = readSource('core/preview-cache.js');
  assert.doesNotMatch(cacheSource, /require\('node:fs/);
  assert.doesNotMatch(cacheSource, /\b(writeFile|readFile|mkdir|copyFile|appendFile)\b/);

  // loadChapterText 必须先 stat 再读：反过来会在「读与 stat 之间被改」时记下更新的 mtime，
  // 执行阶段就会把旧正文当新正文用（快照校验的前提）
  const loadStart = storageSource.indexOf('async function loadChapterText(bookPath, file) {');
  assert.notEqual(loadStart, -1);
  const loadEnd = storageSource.indexOf('\nasync function statChapter(', loadStart);
  assert.notEqual(loadEnd, -1);
  const loadBody = storageSource.slice(loadStart, loadEnd);
  const statIndex = loadBody.indexOf('await fs.stat(p)');
  const readIndex = loadBody.indexOf("await fs.readFile(p, 'utf8')");
  assert.ok(statIndex > -1, 'loadChapterText 里要有 stat');
  assert.ok(readIndex > statIndex, 'stat 必须在 readFile 之前');
});
