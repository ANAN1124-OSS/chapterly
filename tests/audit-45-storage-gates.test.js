// 审计修复 #45（E19、E20、S8）：存储闸门一致性批修。
//   · E19：.bak 轮换的读盘闸门、写侧字节闸门、还原 / 反向备份目标过 assertChapterFile；
//   · E20：_trash 撞名不覆盖先备份、kept 只数快照目录、ALREADY_TODAY 的 bytes 口径、错误码透传；
//   · S8：词表 / 索引「先 stat 后按路径 readFile」的 TOCTOU（在各自的测试文件里钉）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const storage = require('../core/storage');
const tmpCleanup = require('./tmp-cleanup');

// TB-02：临时目录统一经 tests/tmp-cleanup.js 的 mkTmp（mkdtemp + 登记回收）。
const mkTmp = (prefix = 'cw-audit45-') => tmpCleanup.mkTmp(prefix);

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
  // V221-GATE-01：以前预置名用测试进程的 new Date()、deleteChapter 内部再取一次 —— 跨整秒时两个
  // 时间戳不同，预置的备份不撞名，断言随机假红（约 1%/轮）。现在把同一只时钟注入进去。
  const pad2 = (n) => String(n).padStart(2, '0');
  const date = new Date(2001, 1, 3, 4, 5, 6);
  const stamp =
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}-` +
    `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  const trash = path.join(bookPath, '_trash');
  await fs.mkdir(trash, { recursive: true });
  const planted = path.join(trash, `${stamp}-${target.file}`);
  await fs.writeFile(planted, '预置的旧备份', 'utf8');

  const deleted = await storage.deleteChapter(bookPath, target.id, { now: date });
  assert.ok(path.basename(deleted.trashPath).startsWith(`${stamp}-2-`), `撞名要顺延：${path.basename(deleted.trashPath)}`);
  assert.equal(await fs.readFile(planted, 'utf8'), '预置的旧备份', '先备份的字节一个都没被覆盖');
  assert.equal(await fs.readFile(deleted.trashPath, 'utf8'), '要被删掉的正文\r\n', '这次删章的内容完整落在新名字上');
});

// 审计残留修复 #45（E20）：占用表必须「先登记、再查 exists」。旧实现是
// `while (has(dest) || await exists(dest))` 通过之后才 add —— 两次检查之间跨了一次 await，
// 同秒并发（直接调 moveToTrash 绕过书锁，模拟防御性路径）时两边都在 add 之前判成空闲，
// 后一次 rename 直接把前一次的备份覆盖掉（Windows rename 是替换语义）。
test('残留 E20（#45）：同秒并发 moveToTrash 两份备份 —— 名字不撞、谁也没覆盖谁', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '并发撞名');
  const first = await storage.readBookMeta(bookPath);
  const fileA = first.chapters[0].file;
  await storage.saveChapterText(bookPath, fileA, '甲的正文\n');
  await storage.createChapterWithText(bookPath, { insertIndex: 1, name: '乙', text: '乙的正文\n' });
  const second = await storage.readBookMeta(bookPath);
  const fileB = second.chapters[1].file;

  const [destA, destB] = await Promise.all([
    storage.moveToTrash(bookPath, fileA),
    storage.moveToTrash(bookPath, fileB)
  ]);
  assert.notEqual(destA, destB, '两个目的名必须不同（占用表先登记再查）');
  const trash = path.join(bookPath, '_trash');
  assert.deepEqual(
    (await fs.readdir(trash)).sort(),
    [path.basename(destA), path.basename(destB)].sort(),
    '_trash 里正好两份备份（旧实现会在同一个名字上互相覆盖，只剩一份）'
  );
  assert.equal(await fs.readFile(destA, 'utf8'), '甲的正文\r\n');
  assert.equal(await fs.readFile(destB, 'utf8'), '乙的正文\r\n');
});

// 静态闸门：claimTrashTarget 里「登记」必须早于「查磁盘」——顺序反过来就又会跨 await 暴露窗口。
test('残留 E20（#45）静态闸门：_trash 目标名先登记占用再查 exists', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'core', 'storage.js'), 'utf8');
  const claimAt = src.indexOf('async function claimTrashTarget(');
  assert.ok(claimAt > 0, '找不到 claimTrashTarget');
  const body = src.slice(claimAt, claimAt + 900);
  const addAt = body.indexOf('inflightTrashTargets.add(dest)');
  const existsAt = body.indexOf('await exists(dest)');
  assert.ok(addAt > 0 && existsAt > 0, 'claim 里必须有 add 与 exists');
  assert.ok(addAt < existsAt, '必须先 inflightTrashTargets.add(dest) 再 await exists(dest)');
  assert.match(body, /inflightTrashTargets\.delete\(dest\)/, '让位 / 出错时要释放登记');
});

// 审计残留修复 #45（S8）：.bak 轮换的尺寸闸门与读盘必须绑在同一个句柄上 ——
// 旧实现 stat 之后按路径 readFile，间隙里主文件被换成大文件就绕过 32 MB 上限、整份读进内存。
test('残留 S8（#45）：.bak 轮换的尺寸闸门与读盘走同一个句柄（open → fstat → handle.readFile）', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'core', 'storage.js'), 'utf8');
  const start = src.indexOf('async function writeBookMeta(');
  const end = src.indexOf('async function listTxtFiles(', start);
  assert.ok(start >= 0 && end > start, '找不到 writeBookMeta');
  const body = src.slice(start, end);
  assert.ok(body.includes("fs.open(metaPath, 'r')"), '必须先 open 主文件');
  assert.ok(body.includes('handle.stat()'), '.bak 上限要用句柄上的 fstat 结论');
  assert.ok(body.includes('handle.readFile()'), '内容必须从同一个句柄读');
  assert.equal(body.includes('fs.readFile(metaPath)'), false, '不许再按路径读主文件（TOCTOU 窗口）');
  assert.equal(body.includes('fs.stat(metaPath)'), false, '不许再按路径 stat 主文件（闸门与读盘脱节）');
});

// ---------- CSTO-A01 / A02 / A03（2026-11-21 第五轮审计） ----------

// CSTO-A02：读侧的三条主路径（书目光 / 章节正文 / 还原来源）都改成「同一个文件句柄」：
// 闸门看的是句柄上的 fstat，读的也是这个句柄。旧实现按路径 stat 再按路径 readFile，
// 间隙里换成超大文件就能绕过上限。这里用一个「fstat 报超大、readFile 一旦被调用就记一次」
// 的假句柄：只有同句柄实现才会在读盘前拒绝。
test('CSTO-A02：书目 / 章节 / 还原来源的尺寸闸门与读盘绑在同一句柄上', async () => {
  const root = await mkTmp();
  const { path: bookPath, meta } = await storage.createBook(root, '同句柄闸门');
  const file = meta.chapters[0].file;
  const metaPath = path.join(bookPath, '书目.json');
  const chapterPath = path.join(bookPath, file);
  const sourcePath = path.join(root, '还原来源.txt');
  await fs.writeFile(sourcePath, '还原来源正文');
  const realOpen = fs.open;
  let readCalls = 0;
  const fakeLargeHandle = () => ({
    stat: async () => ({ size: storage.MAX_META_READ_BYTES + 1, mtimeMs: 1, isFile: () => true }),
    readFile: async () => {
      readCalls += 1;
      return '{}';
    },
    close: async () => {}
  });
  try {
    fs.open = async (target, ...rest) => {
      const normalized = path.resolve(String(target)).toLowerCase();
      if (normalized === path.resolve(metaPath).toLowerCase()) return fakeLargeHandle();
      if (normalized === path.resolve(chapterPath).toLowerCase()) {
        return {
          stat: async () => ({ size: storage.MAX_CHAPTER_READ_BYTES + 1, mtimeMs: 1, isFile: () => true }),
          readFile: async () => {
            readCalls += 1;
            return '超限章节';
          },
          close: async () => {}
        };
      }
      if (normalized === path.resolve(sourcePath).toLowerCase()) {
        return {
          stat: async () => ({ size: storage.MAX_CHAPTER_READ_BYTES + 1, mtimeMs: 1, isFile: () => true }),
          readFile: async () => {
            readCalls += 1;
            return '超限来源';
          },
          close: async () => {}
        };
      }
      return realOpen(target, ...rest);
    };
    await assert.rejects(() => storage.readBookMeta(bookPath), (err) => {
      assert.equal(err.code, 'META_TOO_LARGE');
      assert.match(err.message, /没有读进内存/);
      return true;
    });
    await assert.rejects(() => storage.loadChapterText(bookPath, file), (err) => {
      assert.equal(err.code, 'CHAPTER_TOO_LARGE');
      return true;
    });
  } finally {
    fs.open = realOpen;
  }
  // loadChapterSource 不在公开面（还原流程内部用），用静态闸门钉住它同样走同句柄读。
  const storageSrc = require('node:fs').readFileSync(path.join(__dirname, '..', 'core', 'storage.js'), 'utf8');
  const sourceStart = storageSrc.indexOf('async function loadChapterSource(');
  assert.ok(sourceStart >= 0, '找不到 loadChapterSource');
  const sourceBody = storageSrc.slice(sourceStart, storageSrc.indexOf('\n}', sourceStart));
  assert.match(sourceBody, /readFileWithSizeGate\(/, 'loadChapterSource 必须复用同句柄读（不许 stat 后按路径 readFile）');
  assert.equal(readCalls, 0, '超过上限的文件必须一个字节都不读（不许走进 readFile）');
});

// CSTO-A01：整本整理可能在 20000 章的书上跑几分钟。期间外部程序（同步盘 / 另一个窗口 / 记事本）
// 改过书目时，结束时绝不能拿开始时的内存快照整份覆盖。这里在整理进度回调里同步改一次书目。
test('CSTO-A01：整本整理期间外部改了书目 → 结束时拒绝覆盖，外部版本原样保留', async () => {
  const fsNode = require('node:fs');
  const root = await mkTmp();
  const { path: bookPath, meta } = await storage.createBook(root, '并发保护');
  const file = meta.chapters[0].file;
  await storage.saveChapterText(bookPath, file, '第一段正文   ');
  const metaPath = path.join(bookPath, '书目.json');
  const err = await storage
    .formatBook(bookPath, { trimTrailing: true }, (progress) => {
      if (progress.done !== 1) return;
      // 模拟另一个窗口 / 记事本在整理在途时改书目（同步写，确保赶在最终 writeBookMeta 之前）
      const current = JSON.parse(fsNode.readFileSync(metaPath, 'utf8'));
      current.title = '外部改过的书名';
      current.notes = '外部新增的说明';
      fsNode.writeFileSync(metaPath, JSON.stringify(current, null, 2), 'utf8');
    })
    .then(() => null, (e) => e);
  assert.ok(err, '外部改动必须让整理结束时拒绝写书目');
  assert.equal(err.code, 'FORMAT_FAILED');
  assert.match(err.message, /被应用外的程序改过|META_CHANGED/);
  const after = await storage.readBookMeta(bookPath);
  assert.equal(after.title, '外部改过的书名', '外部改的书目不许被旧快照覆盖');
  assert.equal(after.notes, '外部新增的说明');
});

// CSTO-A03：整本整理中途失败时，失败前已经整理好的章在内存里算过新 chars，但书目没写 ——
// 磁盘书目会留下「陈旧但有限」的缓存，扫描回填只补缺失、永不重算。失败分支要如实补写一次。
test('CSTO-A03：整本整理中途失败后，已整理章的新字数补写进书目（不留陈旧缓存）', async () => {
  const chaptersLib = require('../core/chapters');
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '失败补记');
  await storage.createChapter(bookPath, 1, '第二章');
  const fresh = await storage.readBookMeta(bookPath);
  const firstFile = fresh.chapters[0].file;
  const secondFile = fresh.chapters[1].file;
  await storage.saveChapterText(bookPath, firstFile, '未完...');
  await storage.saveChapterText(bookPath, secondFile, '未完...');
  const before = await storage.readBookMeta(bookPath);
  const oldFirstChars = before.chapters[0].chars;
  const realStat = fs.stat;
  let injected = false;
  fs.stat = async (target, ...rest) => {
    // 第二章写正文成功后、saveChapterText 的写后 stat 时注入失败：正文已落盘，chars 没进内存
    if (!injected && String(target).toLowerCase() === path.resolve(path.join(bookPath, secondFile)).toLowerCase()) {
      injected = true;
      const err = new Error('模拟杀软占住');
      err.code = 'EACCES';
      throw err;
    }
    return realStat(target, ...rest);
  };
  let err = null;
  try {
    err = await storage.formatBook(bookPath, { ellipsis: true }).then(() => null, (e) => e);
  } finally {
    fs.stat = realStat;
  }
  assert.ok(err, '注入的写后校验失败必须让整理停下');
  assert.equal(err.code, 'FORMAT_FAILED');
  assert.match(err.message, /已经整理好 1 章/);
  const after = await storage.readBookMeta(bookPath);
  assert.notEqual(oldFirstChars, chaptersLib.countChars('未完……'), '用例前提：整理后字数确实变了');
  assert.equal(after.chapters[0].chars, chaptersLib.countChars('未完……'), '已整理章的新字数必须落盘（不许留旧缓存）');
  assert.equal(after.chapters[1].chars, before.chapters[1].chars, '没进内存的那一章不冒充已更新');
});

// STORAGE-01（2026-11-26 审计）：CSTO-A02 只把「书目光 / 章节正文 / 还原来源」三条主路径改成了同句柄读，
// 另有三处漏在外面，仍是「按路径 stat 判上限 → 按同一路径 readFile」：
//   ① 书架扫描的字数回填（readChapterTextForCount，1.6.1 R3a 的 128 MB 闸门）；
//   ② 撤销删除时读旧版本「删空自动补章」，判断它是不是还空着（C17/V104 的补章闸门）；
//   ③ 从 .bak 恢复时读 书目.json.bak（V104 的 32 MB 闸门）。
// stat 与 readFile 之间文件被换成超大文件（同步盘正在落盘 / 外部程序改写）时，上限按旧尺寸放行，
// 超限内容整份读进主进程内存 —— 正是 C17 / V104 注释声称要防的「顶爆主进程」。
// 这里沿用 CSTO-A02 的假句柄写法：fstat 报超限、readFile 一旦被调用就记一次；
// 只有三处都改成同句柄读，才会在读盘前拒绝。
test('STORAGE-01：扫描回填 / 撤销删除补章 / .bak 恢复的尺寸闸门都绑在同一句柄上', async () => {
  const repair = require('../core/repair');
  const root = await mkTmp();

  // ① 回填的现场：章节正文直接落盘（不经 saveChapterText），所以书目里这一章没有 chars 缓存
  const { path: scanBook } = await storage.createBook(root, '回填同句柄');
  const scanFile = (await storage.readBookMeta(scanBook)).chapters[0].file;
  const scanPath = path.join(scanBook, scanFile);
  await fs.writeFile(scanPath, '起风正文', 'utf8');

  // ② 撤销删除的现场：删掉唯一一章（进 _trash），再手工还原旧版本「删空自动补章」的磁盘现场
  const { path: undoBook } = await storage.createBook(root, '撤销同句柄');
  const undoChapter = { ...(await storage.readBookMeta(undoBook)).chapters[0] };
  await storage.saveChapterText(undoBook, undoChapter.file, '唯一的一章');
  const deleted = await storage.deleteChapter(undoBook, undoChapter.id);
  const autoFile = '002-未命名.txt';
  const autoPath = path.join(undoBook, autoFile);
  await fs.writeFile(autoPath, '', 'utf8');
  const undoMetaPath = path.join(undoBook, storage.BOOK_FILE);
  const rawUndoMeta = JSON.parse(await fs.readFile(undoMetaPath, 'utf8'));
  rawUndoMeta.chapters.push({ id: 'ch_auto_legacy', file: autoFile, name: '', createdAt: new Date().toISOString() });
  await fs.writeFile(undoMetaPath, JSON.stringify(rawUndoMeta, null, 2), 'utf8');

  // ③ .bak 恢复的现场：路径先算出来（真实现场在假句柄生效后再造，否则 ② 读到的就是坏书目）
  const bakPath = path.join(undoBook, storage.BOOK_BAK);

  const hugeTargets = new Map([
    [path.resolve(scanPath).toLowerCase(), storage.MAX_CHAPTER_READ_BYTES + 1],
    [path.resolve(autoPath).toLowerCase(), storage.MAX_CHAPTER_READ_BYTES + 1],
    [path.resolve(bakPath).toLowerCase(), storage.MAX_META_READ_BYTES + 1]
  ]);
  const hugeReads = [];
  const realOpen = fs.open;
  fs.open = async (target, ...rest) => {
    const key = path.resolve(String(target)).toLowerCase();
    if (!hugeTargets.has(key)) return realOpen(target, ...rest);
    return {
      stat: async () => ({ size: hugeTargets.get(key), mtimeMs: 1, isFile: () => true }),
      readFile: async () => {
        hugeReads.push(key);
        return '';
      },
      close: async () => {}
    };
  };
  let charsChanged;
  let undoResult;
  let bakError;
  try {
    // ① 回填：闸门看句柄 → 超限 → 这一章按「跳过」处理（不读、不算、不写缓存）
    const pending = (await storage.readBookMeta(scanBook)).chapters.filter((c) => !Number.isFinite(c.chars));
    charsChanged = await storage.backfillChapterChars(scanBook, pending);
    // ② 撤销删除：补章报超限 → 量不出「空」→ 按非空处理（保留补章，宁可多一章）
    undoResult = await storage.restoreDeletedChapterFromTrash(undoBook, {
      trashName: path.basename(deleted.trashPath),
      index: 0,
      chapter: undoChapter,
      autoChapterFile: autoFile
    });
    // ③ .bak 恢复：改名一次让上一版成为 书目.json.bak，再把主文件写坏
    await storage.renameBook(undoBook, '撤销同句柄-第二版');
    await fs.writeFile(undoMetaPath, '彻底坏掉', 'utf8');
    // ③ .bak 恢复：.bak 过不了尺寸闸门 → BAK_TOO_LARGE，一个字节都不读
    bakError = await repair.restoreFromBak(undoBook).then(() => null, (err) => err);
  } finally {
    fs.open = realOpen;
  }

  assert.equal(charsChanged, false, '超限章的字数回填必须跳过，不许读进内存');
  assert.equal(undoResult.autoChapterRemoved, false, '量不出空的补章按非空保留（宁可多一章也不静默丢字）');
  assert.equal(bakError && bakError.code, 'BAK_TOO_LARGE', '.bak 超限要如实报 BAK_TOO_LARGE');
  assert.equal(bakError && String(bakError.message).includes(undoBook), false, '错误文案不带本机完整路径');
  assert.deepEqual(hugeReads, [], '三处超限文件都一个字节不许读（不许走进 readFile）');
});