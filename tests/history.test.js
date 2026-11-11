const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const history = require('../core/history');
const storage = require('../core/storage');

const tmpCleanup = require('./tmp-cleanup');

async function mkTmp(prefix = 'cw-history-') {
  return tmpCleanup.track(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function makeBook(root, title = '历史测试书') {
  return storage.createBook(root, title);
}

async function writeBackupDir(bookPath, name, files) {
  const dir = path.join(bookPath, '_trash', name);
  await fs.mkdir(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, file), text, 'utf8');
  }
  return dir;
}

async function listDirNames(dir) {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

test('历史：解析备份目录名里的时间戳', () => {
  const at = new Date(2026, 9, 31, 21, 30, 0).getTime();
  assert.equal(history.parseStampTime('2026-10-31-213000'), at);
  assert.equal(history.parseStampTime('2026-10-31-213000-2'), at);
  assert.equal(history.parseStampTime('2026-13-01-000000'), 0);
  assert.equal(history.parseStampTime('2026-02-30-120000'), 0);
  assert.equal(history.parseStampTime('乱七八糟'), 0);
  assert.equal(history.parseStampTime(''), 0);
  assert.equal(history.parseStampTime(null), 0);
});

test('历史：时间显示为本地时间（YYYY-MM-DD HH:mm）', () => {
  const at = new Date(2026, 0, 2, 3, 4, 5).getTime();
  assert.equal(history.formatHistoryTime(at), '2026-01-02 03:04');
  assert.equal(history.formatHistoryTime(0), '');
  assert.equal(history.formatHistoryTime('x'), '');
});

test('历史：删除章节的散文件（含撞名序号）不会把 3 位原文件名误当序号', () => {
  assert.deepEqual(history.parseDeletedName('2026-10-31-213000-001-起风.txt'), {
    stamp: '2026-10-31-213000',
    originalName: '001-起风.txt'
  });
  assert.deepEqual(history.parseDeletedName('2026-10-31-213000-2-001-起风.txt'), {
    stamp: '2026-10-31-213000',
    originalName: '001-起风.txt'
  });
  assert.deepEqual(history.parseDeletedName('2026-10-31-213000-12-003-夜雨.txt'), {
    stamp: '2026-10-31-213000',
    originalName: '003-夜雨.txt'
  });
  for (const bad of ['001-起风.txt', '2026-10-31-213000-书目.json', '', null, 42]) {
    assert.equal(history.parseDeletedName(bad), null, String(bad));
  }
});

test('历史：备份目录 / 散文件归类', () => {
  assert.equal(history.classifyDirName('替换备份-2026-10-31-213000').source, 'replace');
  assert.equal(history.classifyDirName('整理备份-2026-10-31-213000').source, 'format');
  assert.equal(history.classifyDirName('还原前备份-2026-10-31-213000').source, 'restore');
  assert.equal(history.classifyDirName('快照-2026-10-31-213000').source, 'snapshot');
  assert.equal(history.classifyDirName('随便一个文件夹').source, 'other');
  assert.equal(history.classifyDirName('../逃出去'), null);
  assert.equal(history.classifyDirName('.hidden'), null);

  assert.equal(history.classifyLooseName('书目.json.bak').source, 'bookmeta');
  const deleted = history.classifyLooseName('2026-10-31-213000-001-起风.txt');
  assert.equal(deleted.source, 'delete');
  assert.equal(deleted.originalName, '001-起风.txt');
  assert.equal(history.classifyLooseName('随便.txt').source, 'other');
  assert.equal(history.classifyLooseName('../逃出去.txt'), null);
  assert.equal(history.classifyLooseName('.tmp-1'), null);

  assert.equal(history.sourceLabel('replace'), '整本替换');
  assert.equal(history.sourceLabel('bookmeta'), '书目备份');
  assert.equal(history.sourceLabel('unknown'), '其他备份');
});

test('历史：扫描 _trash 与 书目.json.bak，标出还在书里的章节', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '书');
  await fs.mkdir(bookPath, { recursive: true });
  await fs.writeFile(path.join(bookPath, '001-a.txt'), '现稿', 'utf8');
  await fs.writeFile(path.join(bookPath, '书目.json.bak'), '{"chapters":[]}', 'utf8');

  await writeBackupDir(bookPath, '替换备份-2026-10-31-210000', {
    '001-a.txt': '替换前的甲',
    '009-gone.txt': '替换前的乙',
    '说明.md': '人工备注'
  });
  await writeBackupDir(bookPath, '整理备份-2026-10-31-200000', { '001-a.txt': '整理前的甲' });
  await writeBackupDir(bookPath, '还原前备份-2026-10-31-220000-2', { '001-a.txt': '还原前的甲' });
  await writeBackupDir(bookPath, '快照-2026-10-31-230000', { '001-a.txt': '快照里的甲' });
  await writeBackupDir(bookPath, '随便一个文件夹', { 'x.txt': '未知' });
  await fs.writeFile(path.join(bookPath, '_trash', '2026-10-31-215000-009-gone.txt'), '已删章节', 'utf8');
  await fs.writeFile(path.join(bookPath, '_trash', '未知文件.bin'), '未知', 'utf8');
  await fs.writeFile(path.join(bookPath, '_trash', '.tmp-1'), '临时', 'utf8');

  const data = await history.listHistory(bookPath, { chapterFiles: ['001-a.txt'] });
  assert.equal(data.groupCount, 8);

  const bySource = (source) => data.groups.filter((group) => group.source === source);
  assert.equal(bySource('replace').length, 1);
  assert.equal(bySource('format').length, 1);
  assert.equal(bySource('restore').length, 1);
  assert.equal(bySource('snapshot').length, 1);
  assert.equal(bySource('delete').length, 1);
  assert.equal(bySource('bookmeta').length, 1);
  assert.equal(bySource('other').length, 2);

  const replace = bySource('replace')[0];
  assert.equal(replace.sourceLabel, '整本替换');
  assert.equal(replace.kind, 'dir');
  assert.equal(replace.fileCount, 3);
  assert.equal(replace.restorableCount, 1);
  const current = replace.files.find((file) => file.name === '001-a.txt');
  const gone = replace.files.find((file) => file.name === '009-gone.txt');
  const doc = replace.files.find((file) => file.name === '说明.md');
  assert.equal(current.restorable, true);
  assert.equal(current.inBook, true);
  assert.equal(gone.restorable, false);
  assert.equal(gone.inBook, false);
  assert.match(gone.reason, /不在书里/);
  assert.equal(doc.restorable, false);
  assert.equal(doc.previewable, true);

  const deleted = bySource('delete')[0];
  assert.equal(deleted.kind, 'file');
  assert.equal(deleted.files[0].name, '009-gone.txt');
  assert.equal(deleted.files[0].restorable, true);
  assert.equal(deleted.files[0].previewable, true);

  const meta = bySource('bookmeta')[0];
  assert.equal(meta.id, 'bak');
  assert.equal(meta.files[0].name, '书目.json.bak');
  assert.equal(meta.files[0].restorable, false);
  assert.equal(meta.restorableCount, 0);
  assert.match(meta.note, /只供查看/);

  // 有明确时间戳的组按时间倒序：快照 23:00 > 还原前 22:00 > 删章 21:50 > 替换 21:00 > 整理 20:00
  const stampOrder = data.groups
    .filter((group) => ['snapshot', 'restore', 'delete', 'replace', 'format'].includes(group.source))
    .map((group) => group.source);
  assert.deepEqual(stampOrder, ['snapshot', 'restore', 'delete', 'replace', 'format']);

  // 只读：扫描不删/不改任何备份或章节
  assert.equal(await fs.readFile(path.join(bookPath, '_trash', '未知文件.bin'), 'utf8'), '未知');
  assert.equal(await fs.readFile(path.join(bookPath, '001-a.txt'), 'utf8'), '现稿');
});

test('历史：没有 _trash、没有 .bak 的旧书返回空列表', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '空书');
  await fs.mkdir(bookPath, { recursive: true });
  const data = await history.listHistory(bookPath, { chapterFiles: [] });
  assert.equal(data.groupCount, 0);
  assert.equal(data.fileCount, 0);
  assert.deepEqual(data.groups, []);
  assert.equal(data.trashPath, path.join(bookPath, '_trash'));
});

test('历史：预览只读、去 BOM、拒绝目录穿越', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '书');
  await fs.mkdir(path.join(bookPath, '_trash'), { recursive: true });
  await fs.writeFile(path.join(bookPath, '书目.json.bak'), '{"chapters":[{"file":"001-a.txt"}]}', 'utf8');
  await writeBackupDir(bookPath, '替换备份-2026-10-31-210000', {
    '001-a.txt': '\uFEFF替换前正文\r\n第二行'
  });

  const preview = await history.readHistoryFile(
    bookPath,
    'dir:替换备份-2026-10-31-210000',
    '001-a.txt'
  );
  assert.equal(preview.text, '替换前正文\r\n第二行');
  assert.equal(preview.truncated, false);
  assert.equal(preview.fileName, '001-a.txt');
  assert.equal(preview.sourceLabel, '整本替换');

  const bak = await history.readHistoryFile(bookPath, 'bak', '书目.json.bak');
  assert.match(bak.text, /001-a\.txt/);
  assert.equal(bak.source, 'bookmeta');

  await assert.rejects(
    history.readHistoryFile(bookPath, 'dir:替换备份-2026-10-31-210000', '../书目.json', {}),
    (err) => err.code === 'BAD_FILE'
  );
  await assert.rejects(history.readHistoryFile(bookPath, 'dir:../逃出去', 'x'), (err) => err.code === 'BAD_GROUP');
  await assert.rejects(
    history.readHistoryFile(bookPath, 'dir:替换备份-2026-10-31-210000', '不存在.txt'),
    (err) => err.code === 'HISTORY_FILE_MISSING'
  );
});

test('历史：大文件预览只读开头并标记 truncated', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '书');
  await fs.mkdir(bookPath, { recursive: true });
  const bigText = '甲'.repeat(300000); // 900KB UTF-8，超过 512KB 上限
  await writeBackupDir(bookPath, '整理备份-2026-10-31-210000', { '001-big.txt': bigText });
  const preview = await history.readHistoryFile(bookPath, 'dir:整理备份-2026-10-31-210000', '001-big.txt');
  assert.equal(preview.truncated, true);
  assert.ok(preview.text.length > 100000);
  assert.ok(preview.size > history.PREVIEW_MAX_BYTES);
});

test('历史：storage.listBookHistory 读取当前章节，书目损坏时也能列出备份', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await makeBook(root, '历史列表书');
  await storage.createChapter(bookPath, 1, '夜雨');
  let meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters.length, 2);
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '第一章现稿\n');
  await storage.saveChapterText(bookPath, meta.chapters[1].file, '第二章现稿\n');
  await storage.renameBook(bookPath, '历史列表书-改名'); // 触发第二版书目，生成 .bak
  await writeBackupDir(bookPath, '替换备份-2026-10-31-210000', {
    [meta.chapters[0].file]: '第一章旧稿\n'
  });

  const listed = await storage.listBookHistory(bookPath);
  assert.equal(listed.title, '历史列表书-改名');
  assert.ok(listed.groups.length >= 2);
  const replace = listed.groups.find((group) => group.source === 'replace');
  assert.ok(replace);
  assert.equal(replace.files[0].inBook, true);
  assert.equal(replace.files[0].restorable, true);
  assert.ok(listed.groups.some((group) => group.source === 'bookmeta'));

  // 书目坏了：列表照常可用（章节按「不在书里」处理），预览备份不受影响
  await fs.writeFile(path.join(bookPath, '书目.json'), '{坏掉的', 'utf8');
  const broken = await storage.listBookHistory(bookPath);
  assert.equal(broken.title, '');
  const brokenReplace = broken.groups.find((group) => group.source === 'replace');
  assert.equal(brokenReplace.files[0].inBook, false);
  assert.equal(brokenReplace.files[0].restorable, false);
});

test('历史：还原单章覆盖书内正文，先把当前内容备份到 还原前备份-*', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await makeBook(root, '还原单章书');
  await storage.createChapter(bookPath, 1, '夜雨');
  let meta = await storage.readBookMeta(bookPath);
  const [file1, file2] = meta.chapters.map((chapter) => chapter.file);
  await storage.saveChapterText(bookPath, file1, '第一章现稿。\n');
  await storage.saveChapterText(bookPath, file2, '第二章现稿。\n');
  meta = await storage.readBookMeta(bookPath);
  meta.chapters[0].chars = 6;
  meta.chapters[1].chars = 6;
  await storage.writeBookMeta(bookPath, meta);
  await writeBackupDir(bookPath, '替换备份-2026-10-31-210000', {
    [file1]: '第一章备份旧稿。\r\n',
    [file2]: '第二章备份旧稿。\r\n'
  });

  const result = await storage.restoreHistoryFile(
    bookPath,
    'dir:替换备份-2026-10-31-210000',
    file1
  );
  assert.equal(result.restored, 1);
  assert.equal(result.skipped, 1);
  assert.ok(result.restoreBackupDir);

  const restored = await storage.loadChapterText(bookPath, file1);
  assert.equal(restored.text, '第一章备份旧稿。\n');
  const untouched = await storage.loadChapterText(bookPath, file2);
  assert.equal(untouched.text, '第二章现稿。\n');

  const restoreDir = result.restoreBackupDir;
  assert.equal(await fs.readFile(path.join(restoreDir, file1), 'utf8'), '第一章现稿。\r\n');

  meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters[0].chars, 8);
  assert.equal(meta.chapters[1].chars, 6);

  // 原备份不消耗，可以重复还原
  const again = await storage.listBookHistory(bookPath);
  const replace = again.groups.find((group) => group.source === 'replace');
  assert.equal(replace.fileCount, 2);
  assert.equal(replace.restorableCount, 2);
});

test('历史：还原整组只还原当前章节，已删章节不复活，逐章先备份当前内容', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await makeBook(root, '还原整组书');
  await storage.createChapter(bookPath, 1, '夜雨');
  let meta = await storage.readBookMeta(bookPath);
  const [file1, file2] = meta.chapters.map((chapter) => chapter.file);
  await storage.saveChapterText(bookPath, file1, '第一章现稿。\n');
  await storage.saveChapterText(bookPath, file2, '第二章现稿。\n');
  await writeBackupDir(bookPath, '整理备份-2026-10-31-210000', {
    [file1]: '第一章整理前。\r\n',
    [file2]: '第二章整理前。\r\n',
    '003-已删.txt': '这一章已经不在书里。\r\n'
  });

  const result = await storage.restoreHistoryGroup(bookPath, 'dir:整理备份-2026-10-31-210000');
  assert.equal(result.restored, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.total, 3);

  assert.equal((await storage.loadChapterText(bookPath, file1)).text, '第一章整理前。\n');
  assert.equal((await storage.loadChapterText(bookPath, file2)).text, '第二章整理前。\n');
  await assert.rejects(fs.access(path.join(bookPath, '003-已删.txt')), (err) => err.code === 'ENOENT');

  const restoreFiles = (await fs.readdir(result.restoreBackupDir)).sort();
  assert.deepEqual(restoreFiles, [file1, file2].sort());
  assert.equal(await fs.readFile(path.join(result.restoreBackupDir, file1), 'utf8'), '第一章现稿。\r\n');

  meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters.length, 2);
  assert.equal(meta.chapters[0].chars, 7);
  assert.equal(meta.chapters[1].chars, 7);
  assert.equal(meta.schemaVersion, 1);
});

// P2-3（1.5.0）：历史还原读备份文件前先看 stat.size，超限明确拒绝且一个字节都不写。
test('历史：备份文件超过读取上限时明确拒绝，不建还原前备份、正文不动', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await makeBook(root, '历史超大备份');
  const meta = await storage.readBookMeta(bookPath);
  const file1 = meta.chapters[0].file;
  await storage.saveChapterText(bookPath, file1, '第一章现稿。\n');
  const dir = await writeBackupDir(bookPath, '替换备份-2026-11-11-010000', {
    [file1]: '第一章备份。\n'
  });
  const backupFile = path.join(dir, file1);
  // 稀疏文件：只把长度改到上限 +1，不真的写 128 MB 字节
  await fs.truncate(backupFile, storage.MAX_CHAPTER_READ_BYTES + 1);

  let failed = null;
  try {
    failed = await storage
      .restoreHistoryFile(bookPath, 'dir:替换备份-2026-11-11-010000', file1)
      .then(() => null, (err) => err);
  } finally {
    await fs.truncate(backupFile, 0).catch(() => {});
  }

  assert.ok(failed, '超限备份必须明确报错');
  assert.equal(failed.code, 'HISTORY_TOO_LARGE');
  assert.match(failed.message, /128 MB/);
  assert.ok(failed.message.includes(file1));
  assert.ok(!failed.message.includes(root));
  // 正文一个字节没动；连「还原前备份-*」目录都没建
  assert.equal((await storage.loadChapterText(bookPath, file1)).text, '第一章现稿。\n');
  const trashNames = await fs.readdir(path.join(bookPath, '_trash'));
  assert.deepEqual(trashNames.filter((name) => name.startsWith('还原前备份-')), []);
});

test('历史：整组还原时任一备份超限就整批拒绝（顺序在前的正常章也不许先写）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await makeBook(root, '历史超大整组');
  await storage.createChapter(bookPath, 1, '夜雨');
  let meta = await storage.readBookMeta(bookPath);
  const [file1, file2] = meta.chapters.map((chapter) => chapter.file);
  await storage.saveChapterText(bookPath, file1, '第一章现稿。\n');
  await storage.saveChapterText(bookPath, file2, '第二章现稿。\n');
  const dir = await writeBackupDir(bookPath, '整理备份-2026-11-11-010000', {
    [file1]: '第一章整理前。\n',
    [file2]: '第二章整理前。\n'
  });
  // 第二章（排序在后）超限：预检必须在写第一章之前就拒绝
  const backupFile2 = path.join(dir, file2);
  await fs.truncate(backupFile2, storage.MAX_CHAPTER_READ_BYTES + 1);

  let failed = null;
  try {
    failed = await storage
      .restoreHistoryGroup(bookPath, 'dir:整理备份-2026-11-11-010000')
      .then(() => null, (err) => err);
  } finally {
    await fs.truncate(backupFile2, 0).catch(() => {});
  }

  assert.ok(failed, '整组里有一个超限就必须整批拒绝');
  assert.equal(failed.code, 'HISTORY_TOO_LARGE');
  assert.ok(failed.message.includes(file2));
  // 两章都还是现稿（第一章没有被提前写回），也没建还原前备份目录
  assert.equal((await storage.loadChapterText(bookPath, file1)).text, '第一章现稿。\n');
  assert.equal((await storage.loadChapterText(bookPath, file2)).text, '第二章现稿。\n');
  const trashNames = await fs.readdir(path.join(bookPath, '_trash'));
  assert.deepEqual(trashNames.filter((name) => name.startsWith('还原前备份-')), []);
});

test('历史：还原删章备份只把 txt 放回书文件夹，不改章节列表、不覆盖同名文件', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await makeBook(root, '找回删章书');
  let meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '现稿。\n');
  await storage.renameBook(bookPath, '找回删章书-改名');
  const metaBefore = await fs.readFile(path.join(bookPath, '书目.json'), 'utf8');
  await fs.mkdir(path.join(bookPath, '_trash'), { recursive: true });
  await fs.writeFile(
    path.join(bookPath, '_trash', '2026-10-31-215000-003-丢失的章节.txt'),
    '丢失章节的正文。\r\n',
    'utf8'
  );

  const result = await storage.restoreHistoryFile(
    bookPath,
    'file:2026-10-31-215000-003-丢失的章节.txt',
    '003-丢失的章节.txt'
  );
  assert.equal(result.restored, 1);
  assert.equal(result.addedToBook, false);
  assert.equal(result.needsRebuild, true);
  assert.equal(
    await fs.readFile(path.join(bookPath, '003-丢失的章节.txt'), 'utf8'),
    '丢失章节的正文。\r\n'
  );
  // 书目一个字节没动：不自动加回章节、不改章号
  assert.equal(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'), metaBefore);
  meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters.length, 1);

  // 书里已有同名文件：拒绝覆盖（保护书里现在的内容）
  await assert.rejects(
    storage.restoreHistoryFile(
      bookPath,
      'file:2026-10-31-215000-003-丢失的章节.txt',
      '003-丢失的章节.txt'
    ),
    (err) => err.code === 'HISTORY_TARGET_EXISTS'
  );
  assert.equal(
    await fs.readFile(path.join(bookPath, '003-丢失的章节.txt'), 'utf8'),
    '丢失章节的正文。\r\n'
  );
});

test('历史：书目备份 / 未识别备份不能还原，缺组时报错清楚', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await makeBook(root, '不能还原书');
  await storage.renameBook(bookPath, '不能还原书-改名');
  await assert.rejects(storage.restoreHistoryFile(bookPath, 'bak', '书目.json.bak'), (err) => err.code === 'HISTORY_NOT_RESTORABLE');
  await assert.rejects(storage.restoreHistoryGroup(bookPath, 'bak'), (err) => err.code === 'HISTORY_NOT_RESTORABLE');
  await writeBackupDir(bookPath, '随便一个文件夹', { 'x.txt': '未知' });
  await assert.rejects(
    storage.restoreHistoryFile(bookPath, 'dir:随便一个文件夹', 'x.txt'),
    (err) => err.code === 'HISTORY_NOT_CURRENT' || err.code === 'HISTORY_NO_TARGET'
  );
  await assert.rejects(
    storage.restoreHistoryFile(bookPath, 'dir:替换备份-2999-01-01-000000', 'x.txt'),
    (err) => err.code === 'HISTORY_GROUP_MISSING'
  );
  await assert.rejects(
    storage.restoreHistoryFile(bookPath, 'dir:../逃出去', 'x.txt'),
    (err) => err.code === 'BAD_GROUP'
  );
});

test('历史：v0.4.1 形状的旧书目（无 schemaVersion / 无新字段）照样能看历史并还原', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '旧书');
  await fs.mkdir(bookPath, { recursive: true });
  const oldMeta = {
    version: 1,
    id: 'b_old',
    title: '旧书',
    titleTemplate: '第{n}章 {name}',
    fileSeq: 2,
    chapters: [
      { id: 'ch_001', file: '001-起风.txt', name: '起风', createdAt: '2026-10-30T00:00:00.000Z' },
      { id: 'ch_002', file: '002-夜雨.txt', name: '夜雨', createdAt: '2026-10-30T00:00:00.000Z' }
    ],
    lastOpenChapterId: 'ch_001'
  };
  await fs.writeFile(path.join(bookPath, '书目.json'), JSON.stringify(oldMeta, null, 2), 'utf8');
  await fs.writeFile(path.join(bookPath, '001-起风.txt'), '旧书第一章。\n', 'utf8');
  await fs.writeFile(path.join(bookPath, '002-夜雨.txt'), '旧书第二章。\n', 'utf8');
  await writeBackupDir(bookPath, '替换备份-2026-10-31-210000', {
    '001-起风.txt': '旧书第一章备份。\r\n'
  });

  const listed = await storage.listBookHistory(bookPath);
  assert.equal(listed.title, '旧书');
  const replace = listed.groups.find((group) => group.source === 'replace');
  assert.equal(replace.files[0].restorable, true);

  const result = await storage.restoreHistoryFile(bookPath, replace.id, '001-起风.txt');
  assert.equal(result.restored, 1);
  assert.equal((await storage.loadChapterText(bookPath, '001-起风.txt')).text, '旧书第一章备份。\n');
  // 还原写盘时只补 schemaVersion（迁移），章节顺序/文件/章名不变
  const metaOnDisk = JSON.parse(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'));
  assert.equal(metaOnDisk.schemaVersion, 1);
  assert.deepEqual(metaOnDisk.chapters.map((chapter) => chapter.file), ['001-起风.txt', '002-夜雨.txt']);
  assert.deepEqual(metaOnDisk.chapters.map((chapter) => chapter.name), ['起风', '夜雨']);
});

// ---------- P22-5：每日快照组的目录名字段 + 「清空某天」的路径校验 ----------

test('历史：每日快照组带严格解析出的 snapshotName / snapshotDay，其它组不带', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '书');
  await fs.mkdir(bookPath, { recursive: true });
  await writeBackupDir(bookPath, '快照-20261107', { '001-a.txt': '今天的快照' });
  await writeBackupDir(bookPath, '快照-20260231', { '001-a.txt': '日期不存在' });
  await writeBackupDir(bookPath, '快照-2026-11-07', { '001-a.txt': '不是应用生成的格式' });
  await writeBackupDir(bookPath, '替换备份-2026-10-31-210000', { '001-a.txt': '替换备份' });

  const data = await history.listHistory(bookPath, { chapterFiles: ['001-a.txt'] });
  const byId = (id) => data.groups.find((group) => group.id === id);

  const today = byId('dir:快照-20261107');
  assert.equal(today.source, 'snapshot');
  assert.equal(today.snapshotName, '快照-20261107');
  assert.equal(today.snapshotDay, '2026-11-07');

  // 名字对不上严格格式的目录仍然归到「每日快照」，但不给清除入口（没有 snapshotName 字段）
  const badDay = byId('dir:快照-20260231');
  assert.equal(badDay.source, 'snapshot');
  assert.equal(badDay.snapshotName, undefined);
  assert.equal(badDay.snapshotDay, undefined);
  const badFormat = byId('dir:快照-2026-11-07');
  assert.equal(badFormat.source, 'snapshot');
  assert.equal(badFormat.snapshotName, undefined);
  assert.equal(badFormat.snapshotDay, undefined);

  // 其它来源的组没有这个字段（渲染层只看 snapshotName，不用自己切 id）
  const replace = byId('dir:替换备份-2026-10-31-210000');
  assert.equal(replace.source, 'replace');
  assert.equal(replace.snapshotName, undefined);

  // 扫描只读：快照目录和里面的文件一个都没动
  assert.equal(
    await fs.readFile(path.join(bookPath, '_trash', '快照-20261107', '001-a.txt'), 'utf8'),
    '今天的快照'
  );
});

test('历史：清空快照的路径校验只认本书 _trash 下的「快照-YYYYMMDD」，不删任何东西', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '书');
  const snapshotDir = path.join(bookPath, '_trash', '快照-20261107');
  await fs.mkdir(snapshotDir, { recursive: true });
  await fs.writeFile(path.join(snapshotDir, '001-a.txt'), '快照正文', 'utf8');

  // 合法：返回绝对路径，正好是本书 _trash 的直接子目录
  const dir = storage.snapshotDirForClear(bookPath, '快照-20261107');
  assert.equal(dir, snapshotDir);
  assert.equal(path.dirname(dir), path.join(bookPath, '_trash'));
  assert.equal(path.isAbsolute(dir), true);
  // 只是校验路径：一个文件都没动、也没读正文
  assert.equal(await fs.readFile(path.join(snapshotDir, '001-a.txt'), 'utf8'), '快照正文');

  for (const bad of [
    '快照-20260231', // 日期不存在
    '快照-20261301', // 月份越界
    '快照-2026110', // 位数不够
    '快照-202611070', // 位数太多
    '快照-2026-11-07', // 带横线
    '快照-2026-11-07-220000', // 自带时间戳（不是按天目录）
    '..',
    '.',
    '../快照-20261107',
    '..\\快照-20261107',
    '快照-20261107\\..\\..\\书目.json',
    'C:\\快照-20261107',
    'C:\\书\\_trash\\快照-20261107',
    '/快照-20261107',
    '替换备份-2026-10-31-210000',
    '整理备份-2026-10-31-210000',
    '其它备份-x',
    '快照-',
    '',
    null,
    undefined,
    42
  ]) {
    assert.throws(
      () => storage.snapshotDirForClear(bookPath, bad),
      (err) => err instanceof storage.StorageError && err.code === 'BAD_SNAPSHOT_DIR',
      `应拒绝：${String(bad)}`
    );
  }
  // 缺书路径：直接 BAD_BOOK，连目录名都不看
  assert.throws(
    () => storage.snapshotDirForClear('', '快照-20261107'),
    (err) => err instanceof storage.StorageError && err.code === 'BAD_BOOK'
  );
  // 被拒绝的那些名字一个都没被动过
  assert.equal(await fs.readFile(path.join(snapshotDir, '001-a.txt'), 'utf8'), '快照正文');
  assert.deepEqual((await fs.readdir(path.join(bookPath, '_trash'))).sort(), ['快照-20261107']);
});

// ---------- 整组还原的失败语义（1.6.0 A3 / 审计 E-08） ----------
test('历史：整组还原中途失败要说清还原了几章 + 备份目录，后续章一个字节不动', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await makeBook(root, '整组还原失败书');
  await storage.createChapter(bookPath, 1, '夜雨');
  await storage.createChapter(bookPath, 2, '晚风');
  const meta = await storage.readBookMeta(bookPath);
  const files = meta.chapters.map((chapter) => chapter.file);
  assert.equal(files.length, 3);
  for (const file of files) await storage.saveChapterText(bookPath, file, `现稿：${file}\n`);
  await writeBackupDir(bookPath, '整理备份-2026-10-31-210000', {
    [files[0]]: '第一章旧稿\r\n',
    [files[1]]: '第二章旧稿\r\n',
    [files[2]]: '第三章旧稿\r\n'
  });
  // 让第二章的目标文件只读：原子写回时 rename 会 EPERM（Windows 实测）
  const lockedPath = path.join(bookPath, files[1]);
  await fs.chmod(lockedPath, 0o444);
  let failed = null;
  try {
    await storage.restoreHistoryGroup(bookPath, 'dir:整理备份-2026-10-31-210000');
  } catch (err) {
    failed = err;
  } finally {
    await fs.chmod(lockedPath, 0o666).catch(() => {});
  }
  assert.ok(failed, '中途失败必须抛错，不能假装全还原了');
  assert.equal(failed.code, 'RESTORE_FAILED');
  assert.match(failed.message, /已经还原 1 章/);
  assert.match(failed.message, /还原前的正文备份在/);
  assert.match(failed.message, /再点一次/, '要告诉作者备份没被消耗、可以重试');
  assert.equal((await storage.loadChapterText(bookPath, files[0])).text, '第一章旧稿\n', '失败前已还原的章保留');
  assert.equal(
    (await storage.loadChapterText(bookPath, files[1])).text,
    `现稿：${files[1]}\n`,
    '失败的那一章不许写坏（原子写回要么全成要么不动）'
  );
  assert.equal(
    (await storage.loadChapterText(bookPath, files[2])).text,
    `现稿：${files[2]}\n`,
    '后续章一个字节都不许动'
  );
  // 原备份没被消耗，解除只读后可以整组重试
  await fs.chmod(lockedPath, 0o666);
  const retry = await storage.restoreHistoryGroup(bookPath, 'dir:整理备份-2026-10-31-210000');
  assert.equal(retry.restored, 3);
});

// A4 / P-11（审计：_trash 双层串行 stat —— 每个备份目录、每个文件各 await 一次）：
// 改成两段式并发（目录 readdir 8 路、文件 stat 8 路），并发度可注入、结果逐字段不变。
test('历史（P-11）：备份文件 stat 并发执行（峰值=并发度，结果不变）', async () => {
  const base = await mkTmp();
  const { path: bookPath } = await makeBook(base, '并发测试书');
  const fileCount = 6;
  const stamps = ['213001', '213002', '213003'];
  const expected = [];
  for (let d = 0; d < stamps.length; d += 1) {
    const files = {};
    for (let i = 0; i < fileCount; i += 1) {
      files[`${String(i + 1).padStart(3, '0')}-替换-${d}.txt`] = `正文-${d}-${i}`;
    }
    expected.push(files);
    await writeBackupDir(bookPath, `替换备份-2026-10-31-${stamps[d]}`, files);
  }

  let inFlight = 0;
  let peak = 0;
  let statCalls = 0;
  const stat = async (target) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    statCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    return fs.stat(target);
  };

  const result = await history.listHistory(bookPath, { chapterFiles: [], stat, concurrency: 8 });

  assert.equal(peak, 8, `并发度应为 8，实际峰值 ${peak}`);
  assert.equal(inFlight, 0);
  // 书目.json.bak（可能不存在，也会走一次注入的 stat）+ 每个备份文件一次
  let bakCount = 0;
  try {
    await fs.stat(path.join(bookPath, '书目.json.bak'));
    bakCount = 1;
  } catch {
    bakCount = 0;
  }
  assert.equal(statCalls, bakCount + stamps.length * fileCount);
  assert.equal(result.groupCount, stamps.length + bakCount);
  assert.equal(result.fileCount, stamps.length * fileCount);
  const expectedBytes = expected.reduce(
    (sum, files) =>
      sum + Object.values(files).reduce((inner, text) => inner + Buffer.byteLength(text, 'utf8'), 0),
    0
  );
  assert.equal(result.totalBytes, expectedBytes);
  for (const group of result.groups) {
    for (const file of group.files) {
      assert.ok(file.size > 0, `文件大小不能为 0：${file.name}`);
      assert.equal(file.previewable, true);
    }
  }
});

test('历史（P-11）：并发度可降到 1（串行），结果与并发版逐字段一致', async () => {
  const base = await mkTmp();
  const { path: bookPath } = await makeBook(base, '串行对照书');
  const files = {};
  for (let i = 0; i < 5; i += 1) files[`${i + 1}-替换.txt`] = `对照-${i}`;
  await writeBackupDir(bookPath, '替换备份-2026-10-31-220000', files);

  const serialResult = await history.listHistory(bookPath, { chapterFiles: [], concurrency: 1 });
  const parallelResult = await history.listHistory(bookPath, { chapterFiles: [], concurrency: 8 });
  assert.deepEqual(parallelResult.groups, serialResult.groups);
  assert.equal(parallelResult.groupCount, serialResult.groupCount);
  assert.equal(parallelResult.totalBytes, serialResult.totalBytes);
});
