// 审计修复 #45（E19、E20、S8）：存储闸门一致性批修。
//   · E19：.bak 轮换的读盘闸门、写侧字节闸门、还原 / 反向备份目标过 assertChapterFile；
//   · E20：_trash 撞名不覆盖先备份、kept 只数快照目录、ALREADY_TODAY 的 bytes 口径、错误码透传；
//   · S8：词表 / 索引「先 stat 后按路径 readFile」的 TOCTOU（在各自的测试文件里钉）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const storage = require('../core/storage');
const tmpCleanup = require('./tmp-cleanup');

async function mkTmp() {
  return tmpCleanup.track(await fs.mkdtemp(path.join(os.tmpdir(), 'cw-audit45-')));
}

function day(y, m, d) {
  return new Date(y, m - 1, d, 12, 0, 0);
}

// ---------- E19：.bak 轮换与写侧的字节闸门 ----------
test('E19（#45）：书目 .bak 轮换前也过 32 MB 闸门 —— 主文件被换成超大文件时不做「整份读进内存再备份」', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '轮换闸门');
  const metaPath = path.join(bookPath, '书目.json');
  const bakPath = path.join(bookPath, '书目.json.bak');
  const good = await storage.readBookMeta(bookPath);

  // 把主文件撑到上限之上（稀疏文件，不真占盘）：再过一次结构性写盘
  await fs.truncate(metaPath, storage.MAX_META_READ_BYTES + 1);
  const saved = await storage.writeBookMeta(bookPath, good, { structural: true });

  // 主文件照常写回（这次写的是合法书目），但没有把超大文件复制成 .bak
  assert.equal(saved.title, '轮换闸门');
  assert.equal(await storage.exists(bakPath), false, '超大的上一版不许被轮换成 .bak');
  assert.equal((await storage.readBookMeta(bookPath)).title, '轮换闸门', '写回的书目仍可读');

  // 正常大小的上一版照旧轮换（没有被这条闸门误伤）
  await storage.writeBookMeta(bookPath, saved, { structural: true });
  assert.equal(await storage.exists(bakPath), true, '正常大小照旧留上一版');
});

test('E19（#45）：写侧字节闸门 —— 超过 32 MB 的书目明确报 META_TOO_LARGE，一个字节都不写', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '写侧闸门');
  const metaPath = path.join(bookPath, '书目.json');
  const before = await fs.readFile(metaPath);
  const meta = await storage.readBookMeta(bookPath);
  const huge = {
    ...meta,
    // 一条超长章名：JSON 序列化后必然越过 32 MB 上限（这条路径不经过 IPC 的字段清洗）
    chapters: [{ ...meta.chapters[0], name: 'x'.repeat(storage.MAX_META_READ_BYTES + 1024) }]
  };
  await assert.rejects(
    () => storage.writeBookMeta(bookPath, huge, { structural: true }),
    (err) => err && err.code === 'META_TOO_LARGE' && /没有写盘/.test(err.message)
  );
  assert.deepEqual(await fs.readFile(metaPath), before, '主文件一个字节没变');
  assert.equal(await storage.exists(path.join(bookPath, '书目.json.bak')), false, '超限时也不轮换 .bak');
});

// ---------- E19：还原 / 反向备份的目标过 assertChapterFile（静态闸门） ----------
test('E19（#45）：还原 / 反向备份三处目标都过 assertChapterFile（不再只 assertInside）', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'core', 'storage.js'), 'utf8');
  for (const name of ['backupCurrentToRestoreDir', 'copyHistoryEntryToBook', 'restoreDeletedChapter']) {
    const start = src.indexOf(`async function ${name}(`);
    assert.ok(start >= 0, `找不到 ${name}`);
    const next = src.indexOf('\nasync function ', start + 1);
    const body = src.slice(start, next < 0 ? src.length : next);
    assert.ok(body.includes('assertChapterFile(bookPath'), `${name} 的目标必须过 assertChapterFile`);
    assert.equal(body.includes('assertInside(bookPath'), false, `${name} 不许退回只做前缀检查`);
  }
});

// ---------- E20：kept 只数快照目录 ----------
test('E20（#45）：cleanupSnapshots 的 kept 只数「快照-YYYYMMDD」，替换 / 整理 / 还原前备份不算', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '快照计数');
  const trash = path.join(bookPath, '_trash');
  const dirs = [
    '快照-20261031',
    '替换备份-2026-10-31-120000',
    '整理备份-2026-10-31-120000',
    '还原前备份-2026-10-31-120000'
  ];
  for (const dir of dirs) {
    await fs.mkdir(path.join(trash, dir), { recursive: true });
    await fs.writeFile(path.join(trash, dir, 'x.txt'), 'x', 'utf8');
  }
  const result = await storage.cleanupSnapshots(bookPath, { keepDays: 7, now: day(2026, 10, 31) });
  assert.deepEqual(result.removed, []);
  assert.equal(result.kept, 1, '只有快照-20261031 算一份快照（以前四个目录全被算成 4）');
  // 三种备份目录原样留着
  for (const dir of dirs.slice(1)) {
    assert.equal(await storage.exists(path.join(trash, dir, 'x.txt')), true, `不应碰 ${dir}`);
  }
});

test('E20（#45）：清理过期快照后 kept 按「快照目录 - 移除」算', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '快照计数二');
  const trash = path.join(bookPath, '_trash');
  for (const dir of ['快照-20261020', '快照-20261031', '我的备份-20200101']) {
    await fs.mkdir(path.join(trash, dir), { recursive: true });
    await fs.writeFile(path.join(trash, dir, 'x.txt'), 'x', 'utf8');
  }
  const result = await storage.cleanupSnapshots(bookPath, { keepDays: 7, now: day(2026, 10, 31) });
  assert.deepEqual(result.removed, ['快照-20261020']);
  assert.equal(result.kept, 1, '留下的快照只有今天那一份');
  assert.equal(await storage.exists(path.join(trash, '我的备份-20200101')), true, '别人的目录不碰也不计数');
});

// ---------- E20：ALREADY_TODAY 的 bytes 口径 ----------
test('E20（#45）：ALREADY_TODAY 回的是已有快照的大小，不是源文件现在的尺寸', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '快照字节口径');
  const meta = await storage.readBookMeta(bookPath);
  const file = meta.chapters[0].file;
  const now = day(2026, 10, 31);
  await storage.saveChapterText(bookPath, file, '短\n');
  const first = await storage.takeDailySnapshot(bookPath, file, { keepDays: 7, now });
  assert.equal(first.taken, true);
  const snapshotPath = path.join(bookPath, '_trash', '快照-20261031', file);
  const snapshotBytes = (await fs.stat(snapshotPath)).size;

  // 同一天又保存了一次，源文件明显变长：快照不覆盖，bytes 必须还是快照自己的大小
  await storage.saveChapterText(bookPath, file, '第二版长了很多很多字的正文\n');
  const sourceBytes = (await fs.stat(path.join(bookPath, file))).size;
  assert.notEqual(sourceBytes, snapshotBytes, '用例前提：源与快照大小不同');
  const second = await storage.takeDailySnapshot(bookPath, file, { keepDays: 7, now });
  assert.equal(second.taken, false);
  assert.equal(second.reason, 'ALREADY_TODAY');
  assert.equal(second.bytes, snapshotBytes);
});

// ---------- E20：setLastOpenChapter 不再吞错误码 ----------
test('E20（#45）：setLastOpenChapter 的兜底回包保留错误码与脱敏文案', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '错误码透传');
  await fs.writeFile(path.join(bookPath, '书目.json'), '{ 这不是 JSON', 'utf8');
  const res = await storage.setLastOpenChapter(bookPath, 'ch_001');
  assert.equal(res.ok, false);
  assert.equal(res.code, 'PARSE_ERROR', '以前只回 { ok: false }，错误码被吞掉');
  assert.match(res.message, /解析失败/);

  // 真正不存在的章节 id 仍然给 CHAPTER_NOT_FOUND（这条路上原有的错误码没被换掉）
  const root2 = await mkTmp();
  const second = await storage.createBook(root2, '错误码透传二');
  const bad = await storage.setLastOpenChapter(second.path, 'ch_999');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'CHAPTER_NOT_FOUND');
});

// ---------- E20：_trash 撞名不覆盖 ----------
test('E20（#45）：_trash 里已有同秒同名备份时，moveToTrash 顺延序号、不覆盖先前的备份', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '撞名不覆盖');
  const meta = await storage.readBookMeta(bookPath);
  const file = meta.chapters[0].file;
  await storage.saveChapterText(bookPath, file, '要被删掉的正文\n');
  await storage.createChapterWithText(bookPath, { insertIndex: 1, name: '留下', text: '留着\n' });
  const target = (await storage.readBookMeta(bookPath)).chapters[0];

  // 按「现在这一秒」预置一份同名备份（模拟外部 / 上一次操作留下的同秒文件）
  const pad2 = (n) => String(n).padStart(2, '0');
  const date = new Date();
  const stamp =
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}-` +
    `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  const trash = path.join(bookPath, '_trash');
  await fs.mkdir(trash, { recursive: true });
  const planted = path.join(trash, `${stamp}-${target.file}`);
  await fs.writeFile(planted, '预置的旧备份', 'utf8');

  const deleted = await storage.deleteChapter(bookPath, target.id);
  assert.ok(path.basename(deleted.trashPath).startsWith(`${stamp}-2-`), `撞名要顺延：${path.basename(deleted.trashPath)}`);
  assert.equal(await fs.readFile(planted, 'utf8'), '预置的旧备份', '先备份的字节一个都没被覆盖');
  assert.equal(await fs.readFile(deleted.trashPath, 'utf8'), '要被删掉的正文\r\n', '这次删章的内容完整落在新名字上');
});