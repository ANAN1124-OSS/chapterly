const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const snapshot = require('../core/snapshot');
const storage = require('../core/storage');

const tmpCleanup = require('./tmp-cleanup');

async function mkTmp(prefix = 'cw-snapshot-') {
  return tmpCleanup.track(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

const DAY = (year, month, day, hour = 12, minute = 0) =>
  new Date(year, month - 1, day, hour, minute, 0);

test('快照目录命名：本地日期 YYYYMMDD，非法时间返回 null', () => {
  assert.equal(snapshot.localDayKey(DAY(2026, 1, 2)), '20260102');
  assert.equal(snapshot.snapshotDirName(DAY(2026, 10, 31)), '快照-20261031');
  assert.equal(snapshot.localDayKey(new Date(Number.NaN)), null);
  assert.equal(snapshot.localDayKey('不是时间'), null);
});

test('快照目录解析：只认严格格式和真实存在的日期', () => {
  assert.deepEqual(snapshot.parseSnapshotDirName('快照-20261031'), {
    name: '快照-20261031',
    dayKey: '20261031',
    startMs: DAY(2026, 10, 31, 0, 0).getTime()
  });
  for (const bad of [
    '快照-20260230', // 2 月没有 30 号
    '快照-20261301', // 13 月
    '快照-20261031-2', // 多了后缀（那是别的备份命名习惯）
    '快照-2026103', // 位数不够
    '替换备份-20261031',
    '书目.json.bak',
    '',
    null
  ]) {
    assert.equal(snapshot.parseSnapshotDirName(bad), null, `不应识别：${bad}`);
  }
});

test('保留天数清洗：非法回落 7，范围 1–90 天', () => {
  assert.equal(snapshot.normalizeKeepDays(undefined), 7);
  assert.equal(snapshot.normalizeKeepDays('abc'), 7);
  assert.equal(snapshot.normalizeKeepDays(0), 1);
  assert.equal(snapshot.normalizeKeepDays(-10), 1);
  assert.equal(snapshot.normalizeKeepDays(999), 90);
  assert.equal(snapshot.normalizeKeepDays('3'), 3);
  assert.equal(snapshot.normalizeKeepDays(3.6), 4);
});

test('保留窗口：keepDays=7 保今天 + 前 6 天，未来日期与乱写目录都不动', () => {
  const now = DAY(2026, 10, 31);
  // 10-25 是窗口第一天（含），10-24 及更早都该清理
  assert.equal(snapshot.retentionCutoff(now, 7), DAY(2026, 10, 25, 0, 0).getTime());
  assert.equal(snapshot.isExpiredSnapshotDir('快照-20261024', now, 7), true);
  assert.equal(snapshot.isExpiredSnapshotDir('快照-20261025', now, 7), false);
  assert.equal(snapshot.isExpiredSnapshotDir('快照-20261031', now, 7), false);
  assert.equal(snapshot.isExpiredSnapshotDir('快照-20260301', now, 1), true);
  assert.equal(snapshot.isExpiredSnapshotDir('快照-20261101', now, 1), false, '未来日期不清理');
  assert.equal(snapshot.isExpiredSnapshotDir('快照-乱写', now, 1), false);
  assert.equal(snapshot.isExpiredSnapshotDir('替换备份-20260101', now, 1), false);
  assert.deepEqual(
    snapshot.selectExpiredSnapshotDirs(
      ['快照-20261024', '快照-20261025', '快照-乱写', '我的备份', '快照-29991231'],
      now,
      7
    ),
    ['快照-20261024']
  );
  // 保留 1 天 = 只留今天
  assert.deepEqual(
    snapshot.selectExpiredSnapshotDirs(['快照-20261030', '快照-20261031'], now, 1),
    ['快照-20261030']
  );
  assert.deepEqual(snapshot.selectExpiredSnapshotDirs('不是数组', now, 7), []);
});

test('每日快照：保存前复制上一版字节，同章当天只留一份', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '快照测试书');
  let meta = await storage.readBookMeta(bookPath);
  const file = meta.chapters[0].file;
  await storage.saveChapterText(bookPath, file, '第一版\n第二行\n');
  const sourceBefore = await fs.readFile(path.join(bookPath, file));
  const beforeStat = await fs.stat(path.join(bookPath, file));
  const now = DAY(2026, 10, 31, 23, 30);

  const first = await storage.takeDailySnapshot(bookPath, file, { keepDays: 7, now });
  assert.equal(first.taken, true);
  assert.equal(first.reason, 'TAKEN');
  assert.equal(first.dir, '快照-20261031');
  assert.equal(first.file, file);
  assert.equal(first.bytes, sourceBefore.length);
  const snapshotPath = path.join(bookPath, '_trash', '快照-20261031', file);
  assert.deepEqual(await fs.readFile(snapshotPath), sourceBefore, '快照必须是原样字节（含 CRLF）');

  // 同一章同一天再保存：不重复复制、不覆盖当天第一份
  await storage.saveChapterText(bookPath, file, '第二版\n');
  // v0.9 B-5：注释说「复制了或当天已有一份都会清理过期快照」，用断言钉住后者
  const expiredDir = path.join(bookPath, '_trash', '快照-20260101');
  await fs.mkdir(expiredDir, { recursive: true });
  await fs.writeFile(path.join(expiredDir, 'old.txt'), '很旧的快照\n', 'utf8');
  const second = await storage.takeDailySnapshot(bookPath, file, { keepDays: 7, now });
  assert.equal(second.taken, false);
  assert.equal(second.reason, 'ALREADY_TODAY');
  assert.deepEqual(second.cleanup.removed, ['快照-20260101'], '当天已有一份时也要清理过期快照');
  assert.equal(await storage.exists(expiredDir), false);
  assert.deepEqual(await fs.readFile(snapshotPath), sourceBefore, '当天第一份快照不能被后来的保存覆盖');
  assert.equal((await fs.readdir(path.join(bookPath, '_trash', '快照-20261031'))).length, 1);

  // 保存本身不受影响：磁盘上是新正文，字数缓存可正常读取
  assert.equal((await storage.loadChapterText(bookPath, file)).text, '第二版\n');
  meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters.length, 1);
  const afterStat = await fs.stat(path.join(bookPath, file));
  assert.notEqual(afterStat.mtimeMs, beforeStat.mtimeMs);
});

test('每日快照：同一天不同章各留一份', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '多章快照');
  const created = await storage.createChapter(bookPath, 1, '第二章');
  assert.equal(created.chapter.name, '第二章');
  let meta = await storage.readBookMeta(bookPath);
  const [file1, file2] = meta.chapters.map((chapter) => chapter.file);
  await storage.saveChapterText(bookPath, file1, '第一章正文\n');
  await storage.saveChapterText(bookPath, file2, '第二章正文\n');
  const now = DAY(2026, 10, 31);

  const a = await storage.takeDailySnapshot(bookPath, file1, { keepDays: 7, now });
  const b = await storage.takeDailySnapshot(bookPath, file2, { keepDays: 7, now });
  assert.equal(a.taken, true);
  assert.equal(b.taken, true);
  const names = (await fs.readdir(path.join(bookPath, '_trash', '快照-20261031'))).sort();
  assert.deepEqual(names, [file1, file2].sort());
  assert.equal((await fs.readFile(path.join(bookPath, '_trash', '快照-20261031', file2), 'utf8')), '第二章正文\r\n');
});

test('每日快照：过期目录按保留天数清理，只动自己的「快照-YYYYMMDD」', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '快照清理');
  const meta = await storage.readBookMeta(bookPath);
  const file = meta.chapters[0].file;
  await storage.saveChapterText(bookPath, file, '要保存的正文\n');
  const trash = path.join(bookPath, '_trash');
  const oldDir = path.join(trash, '快照-20260101');
  const boundaryDir = path.join(trash, '快照-20261025');
  const unknownDir = path.join(trash, '我的备份-20200101');
  const invalidDir = path.join(trash, '快照-20260230');
  const futureDir = path.join(trash, '快照-29991231');
  for (const dir of [oldDir, boundaryDir, unknownDir, invalidDir, futureDir]) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'keep.txt'), '别动我\n', 'utf8');
  }
  await fs.writeFile(path.join(trash, '快照-20260101.txt'), '散文件也别动\n', 'utf8');

  const result = await storage.takeDailySnapshot(bookPath, file, {
    keepDays: 7,
    now: DAY(2026, 10, 31)
  });
  assert.equal(result.taken, true);
  assert.deepEqual(result.cleanup.removed, ['快照-20260101']);
  assert.deepEqual(result.cleanup.failed, []);
  for (const dir of [boundaryDir, unknownDir, invalidDir, futureDir]) {
    assert.equal(await storage.exists(path.join(dir, 'keep.txt')), true, `不应删除：${path.basename(dir)}`);
  }
  assert.equal(await storage.exists(path.join(trash, '快照-20260101')), false);
  assert.equal(await storage.exists(path.join(trash, '快照-20260101.txt')), true);
  assert.equal(await storage.exists(path.join(trash, '快照-20261031', file)), true);
});

test('每日快照：保留 1 天时保留今天、清掉昨天', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '快照一天');
  const meta = await storage.readBookMeta(bookPath);
  const file = meta.chapters[0].file;
  await storage.saveChapterText(bookPath, file, '今天的正文\n');
  const yesterday = path.join(bookPath, '_trash', '快照-20261030');
  await fs.mkdir(yesterday, { recursive: true });
  await fs.writeFile(path.join(yesterday, 'old.txt'), '昨天的\n', 'utf8');

  const result = await storage.takeDailySnapshot(bookPath, file, {
    keepDays: 1,
    now: DAY(2026, 10, 31)
  });
  assert.deepEqual(result.cleanup.removed, ['快照-20261030']);
  assert.equal(await storage.exists(path.join(bookPath, '_trash', '快照-20261031', file)), true);
});

test('每日快照：章节缺失不建空目录；非法文件名直接拒绝', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '快照边界');
  const missing = await storage.takeDailySnapshot(bookPath, '999-不存在.txt', {
    keepDays: 7,
    now: DAY(2026, 10, 31)
  });
  assert.equal(missing.taken, false);
  assert.equal(missing.reason, 'MISSING');
  assert.equal(await storage.exists(path.join(bookPath, '_trash')), false, '不应为缺失章节建目录');

  for (const bad of ['../越界.txt', '书目.json', '', null]) {
    await assert.rejects(
      () => storage.takeDailySnapshot(bookPath, bad, { keepDays: 7, now: DAY(2026, 10, 31) }),
      (err) => err && err.code === 'BAD_SNAPSHOT_FILE'
    );
  }
});

test('每日快照：v0.4.1 形状的旧书目照常可用（快照只碰 _trash）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '旧书快照');
  // 手工改成 v0.4.1 形状：没有 schemaVersion，章节没有 status/note
  const legacy = {
    title: '旧书快照',
    chapters: [{ id: 'ch_old_1', file: '001-起风.txt', name: '起风' }],
    volumes: [],
    fileSeq: 1
  };
  await fs.writeFile(path.join(bookPath, '书目.json'), JSON.stringify(legacy, null, 2), 'utf8');
  await fs.writeFile(path.join(bookPath, '001-起风.txt'), '旧书正文\r\n', 'utf8');
  const meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters.length, 1);
  const result = await storage.takeDailySnapshot(bookPath, '001-起风.txt', {
    keepDays: 7,
    now: DAY(2026, 10, 31)
  });
  assert.equal(result.taken, true);
  assert.equal(
    await fs.readFile(path.join(bookPath, '_trash', '快照-20261031', '001-起风.txt'), 'utf8'),
    '旧书正文\r\n'
  );
  // 快照不写书目、不改章节文件名
  const raw = JSON.parse(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'));
  assert.equal(raw.schemaVersion, undefined);
  assert.deepEqual(raw.chapters, legacy.chapters);
});

test('清理快照：没有 _trash 时安全返回空结果', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '没有备份');
  const result = await storage.cleanupSnapshots(bookPath, { keepDays: 7, now: DAY(2026, 10, 31) });
  assert.deepEqual(result, { removed: [], failed: [], kept: 0 });
});

// P2-3（1.5.0）：还原 / 快照都是「整个文件读进内存 → 原子写回」，先按 stat.size 设闸门。
test('读取上限：纯逻辑边界（上限放行、超限拒绝、文案带体量与上限）', () => {
  const MAX = storage.MAX_CHAPTER_READ_BYTES;
  assert.equal(MAX, 128 * 1024 * 1024, '口径对齐 core/importer.js 的 128 MB 导入上限');
  assert.equal(storage.readSizeProblem(MAX, { code: 'SNAPSHOT_TOO_LARGE', label: '文件' }), null);
  assert.equal(storage.readSizeProblem(0, { code: 'SNAPSHOT_TOO_LARGE', label: '文件' }), null);
  const over = storage.readSizeProblem(MAX + 1, {
    code: 'BACKUP_TOO_LARGE',
    label: '替换备份里的「001-起风.txt」',
    tail: '没有覆盖书里的正文'
  });
  assert.equal(over.code, 'BACKUP_TOO_LARGE');
  assert.ok(over.message.includes('替换备份里的「001-起风.txt」'), over.message);
  assert.ok(over.message.includes('超过单文件读取上限 128 MB'), over.message);
  assert.ok(over.message.endsWith('没有覆盖书里的正文'), over.message);
  // stat 拿不到 / 坏尺寸不拦（交给读盘按原样报错）
  for (const bad of [NaN, -1, undefined, 'x']) {
    assert.equal(storage.readSizeProblem(bad, { code: 'X', label: '文件' }), null, String(bad));
  }
  // 体量文案与 core/importer.js 的 formatImportSize 同口径（<10 保留 1 位小数）
  assert.ok(
    storage
      .readSizeProblem(3 * 1024 * 1024 * 1024, { code: 'X', label: '文件' })
      .message.includes('3.0 GB')
  );
});

test('每日快照：正文超过读取上限时明确拒绝，不读进内存、不建快照目录', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '快照超大章');
  const meta = await storage.readBookMeta(bookPath);
  const file = meta.chapters[0].file;
  await storage.saveChapterText(bookPath, file, '正常正文。');
  const source = path.join(bookPath, file);
  // 稀疏文件：只把长度改到上限 +1，不真的写 128 MB 字节（与 tests/importer.test.js 同一做法）
  await fs.truncate(source, storage.MAX_CHAPTER_READ_BYTES + 1);

  await assert.rejects(
    () => storage.takeDailySnapshot(bookPath, file, { keepDays: 7, now: DAY(2026, 11, 11) }),
    (err) =>
      err.code === 'SNAPSHOT_TOO_LARGE' &&
      err.message.includes('128 MB') &&
      err.message.includes(file) &&
      !err.message.includes(root)
  );
  // 一个字节都没写：快照目录根本不存在，章节文件长度原样（也没被整份读进内存）
  assert.equal(await storage.exists(path.join(bookPath, '_trash')), false, '超限时不该建任何快照目录');
  assert.equal((await fs.stat(source)).size, storage.MAX_CHAPTER_READ_BYTES + 1);

  // 恢复正常大小后照常留快照（正常路径不变）
  await fs.writeFile(source, '正常正文。', 'utf8');
  const taken = await storage.takeDailySnapshot(bookPath, file, { keepDays: 7, now: DAY(2026, 11, 11) });
  assert.equal(taken.taken, true);
  assert.equal(taken.bytes, Buffer.byteLength('正常正文。'));
  assert.equal(await storage.exists(path.join(bookPath, '_trash', '快照-20261111', file)), true);
});
