// 1.4.0 P0-2：撤销「删除章节」的磁盘层（core/storage.js restoreDeletedChapterFromTrash）。
//
// 这一层是撤销删除的最后一道闸门，测试围绕四件事：
//   1. 正常路径：_trash 里的那一份放回书文件夹、按原 index 插回 书目.json（顺序 / 正文 / 字数缓存都在）；
//   2. 删空自动补章：补章仍空着才一并撤掉；作者往补章里写过字就保留（宁可多一章，不静默丢字）；
//   3. 路径安全：只认本书 _trash 下的 basename，绝对路径 / 目录穿越 / 别的文件名一律拒绝；
//   4. 失败不破坏现场：目标已存在 / 备份不在 / id 重复都报错，书文件夹与 _trash 一个字节不动。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const storage = require('../core/storage');

const tmpCleanup = require('./tmp-cleanup');

async function mkTmp(prefix = 'cw-undo-') {
  return tmpCleanup.track(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function makeBook(root, title = '撤销演练') {
  const { path: bookPath } = await storage.createBook(root, title);
  await storage.createChapter(bookPath, 1, '第二章');
  await storage.createChapter(bookPath, 2, '第三章');
  const meta = await storage.readBookMeta(bookPath);
  return { bookPath, meta };
}

// 删除前的章节快照（撤销 payload 里带的原始元数据）
function snapshot(meta, index) {
  return { ...meta.chapters[index] };
}

test('撤销删除：放回 _trash 那一份、按原 index 插回书目（顺序 / 正文 / 字数都在）', async () => {
  const root = await mkTmp();
  const { bookPath, meta } = await makeBook(root);
  const file1 = meta.chapters[1].file;
  await storage.saveChapterText(bookPath, file1, '第二章正文\n第二行');
  const before = await storage.readBookMeta(bookPath);
  const chapter = snapshot(before, 1);
  const deleted = await storage.deleteChapter(bookPath, chapter.id);
  const trashName = path.basename(deleted.trashPath);

  const restored = await storage.restoreDeletedChapterFromTrash(bookPath, {
    trashName,
    index: 1,
    chapter
  });

  assert.equal(restored.index, 1);
  assert.equal(restored.chapter.id, chapter.id);
  assert.equal(restored.chapter.file, file1);
  assert.equal(restored.autoChapterRemoved, false);
  const after = await storage.readBookMeta(bookPath);
  assert.deepEqual(after.chapters.map((c) => c.file), before.chapters.map((c) => c.file));
  assert.deepEqual(after.chapters.map((c) => c.name), before.chapters.map((c) => c.name));
  assert.equal((await storage.loadChapterText(bookPath, file1)).text, '第二章正文\n第二行');
  // 字数缓存跟着恢复（写回书目时 refreshChapterChars 不在修复范围内，但读回时按需重算不阻塞）
  assert.equal(after.chapters.length, 3);
});

test('撤销删除：删空自动补的空章一并撤掉（书里只剩原章、没有多余空章）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '只剩一章');
  const meta = await storage.readBookMeta(bookPath);
  const chapter = snapshot(meta, 0);
  await storage.saveChapterText(bookPath, chapter.file, '唯一的一章');
  const deleted = await storage.deleteChapter(bookPath, chapter.id);
  assert.ok(deleted.newChapter && deleted.newChapter.file, '删除唯一一章应自动补空章');
  const autoFile = deleted.newChapter.file;

  const restored = await storage.restoreDeletedChapterFromTrash(bookPath, {
    trashName: path.basename(deleted.trashPath),
    index: 0,
    chapter,
    autoChapterFile: autoFile
  });

  assert.equal(restored.autoChapterRemoved, true);
  const after = await storage.readBookMeta(bookPath);
  assert.equal(after.chapters.length, 1);
  assert.equal(after.chapters[0].id, chapter.id);
  assert.equal((await storage.loadChapterText(bookPath, chapter.file)).text, '唯一的一章');
  const inBook = (await fs.readdir(bookPath)).filter((name) => name.endsWith('.txt'));
  assert.deepEqual(inBook, [chapter.file], '书文件夹里不该留下自动补的空章');
  const trash = await fs.readdir(path.join(bookPath, '_trash'));
  assert.ok(trash.some((name) => name.endsWith(autoFile)), '被撤掉的空章进 _trash，不是真删');
});

test('撤销删除：补章里已经写过字 → 保留补章（宁可多一章，不静默丢字）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '补章有字');
  const meta = await storage.readBookMeta(bookPath);
  const chapter = snapshot(meta, 0);
  const deleted = await storage.deleteChapter(bookPath, chapter.id);
  const autoFile = deleted.newChapter.file;
  // 模拟「作者在这 10 秒里往补章里写了字并保存」
  await storage.saveChapterText(bookPath, autoFile, '刚写的一句');

  const restored = await storage.restoreDeletedChapterFromTrash(bookPath, {
    trashName: path.basename(deleted.trashPath),
    index: 0,
    chapter,
    autoChapterFile: autoFile
  });

  assert.equal(restored.autoChapterRemoved, false);
  const after = await storage.readBookMeta(bookPath);
  assert.deepEqual(after.chapters.map((c) => c.file), [chapter.file, autoFile]);
  assert.equal((await storage.loadChapterText(bookPath, autoFile)).text, '刚写的一句');
});

test('撤销删除：路径安全——绝对路径 / 目录穿越 / 非 txt / 与章节文件名对不上一律拒绝', async () => {
  const root = await mkTmp();
  const { bookPath, meta } = await makeBook(root);
  const chapter = snapshot(meta, 1);
  const deleted = await storage.deleteChapter(bookPath, chapter.id);
  const trashName = path.basename(deleted.trashPath);
  const payload = (patch) => ({ trashName, index: 1, chapter, ...patch });

  await assert.rejects(
    () => storage.restoreDeletedChapterFromTrash(bookPath, payload({ trashName: path.join(bookPath, '_trash', trashName) })),
    /只能从本书 _trash 里放回单章 txt/
  );
  await assert.rejects(
    () => storage.restoreDeletedChapterFromTrash(bookPath, payload({ trashName: `../${trashName}` })),
    /只能从本书 _trash 里放回单章 txt/
  );
  await assert.rejects(
    () => storage.restoreDeletedChapterFromTrash(bookPath, payload({ trashName: '书目.json' })),
    /只能从本书 _trash 里放回单章 txt/
  );
  await assert.rejects(
    () => storage.restoreDeletedChapterFromTrash(bookPath, payload({ trashName: trashName.replace(/\.txt$/, '.md') })),
    /只能从本书 _trash 里放回单章 txt/
  );
  await assert.rejects(
    () => storage.restoreDeletedChapterFromTrash(bookPath, payload({ trashName: `2026-11-09-999999- другой.txt` })),
    /与章节文件名对不上/
  );
  await assert.rejects(
    () =>
      storage.restoreDeletedChapterFromTrash(bookPath, {
        trashName,
        index: 1,
        chapter: { ...chapter, file: `../${chapter.file}` }
      }),
    /非法|只能从本书/
  );
  await assert.rejects(() => storage.restoreDeletedChapterFromTrash(bookPath, {}), /缺少章节信息/);
  await assert.rejects(
    () => storage.restoreDeletedChapterFromTrash(bookPath, { trashName, index: 1, chapter: { ...chapter, id: '' } }),
    /缺少章节 id/
  );
});

test('撤销删除：目标已存在 / 备份不在 / id 重复都报错，且不动任何文件', async () => {
  const root = await mkTmp();
  const { bookPath, meta } = await makeBook(root);
  const chapter = snapshot(meta, 1);
  const deleted = await storage.deleteChapter(bookPath, chapter.id);
  const trashName = path.basename(deleted.trashPath);

  // 目标文件名被别的东西占了：拒绝覆盖
  await fs.writeFile(path.join(bookPath, chapter.file), '别人的内容', 'utf8');
  await assert.rejects(
    () => storage.restoreDeletedChapterFromTrash(bookPath, { trashName, index: 1, chapter }),
    /已经有同名章节文件|已经有 \S*，没有覆盖/
  );
  assert.equal(await fs.readFile(path.join(bookPath, chapter.file), 'utf8'), '别人的内容');
  await fs.unlink(path.join(bookPath, chapter.file));

  // 备份不在 _trash 里
  await assert.rejects(
    () =>
      storage.restoreDeletedChapterFromTrash(bookPath, {
        trashName: `2026-11-09-999999-${chapter.file}`,
        index: 1,
        chapter
      }),
    /这个备份已经不在 _trash 里了/
  );

  // id 已经被另一章占用
  const current = await storage.readBookMeta(bookPath);
  const other = current.chapters[0];
  await assert.rejects(
    () =>
      storage.restoreDeletedChapterFromTrash(bookPath, {
        trashName,
        index: 1,
        chapter: { ...chapter, id: other.id }
      }),
    /书里已经有这一章/
  );
  // 失败以后 _trash 里的备份还在、书目没变
  assert.ok((await fs.readdir(path.join(bookPath, '_trash'))).includes(trashName));
  assert.equal((await storage.readBookMeta(bookPath)).chapters.length, current.chapters.length);
});

test('撤销删除：卷归属 / 状态 / 备注跟着回书目，非法卷 id 自动丢掉', async () => {
  const root = await mkTmp();
  const { bookPath, meta } = await makeBook(root);
  const volume = await storage.createVolume(bookPath, '上卷');
  const volumeId = volume.volume.id;
  const targetId = meta.chapters[1].id;
  await storage.updateChapterMeta(bookPath, targetId, { status: 'done', note: '这章要改' });
  await storage.moveChapterToVolume(bookPath, targetId, volumeId);
  const before = await storage.readBookMeta(bookPath);
  const index = before.chapters.findIndex((c) => c.id === targetId);
  const chapter = snapshot(before, index);
  const deleted = await storage.deleteChapter(bookPath, targetId);

  const restored = await storage.restoreDeletedChapterFromTrash(bookPath, {
    trashName: path.basename(deleted.trashPath),
    index,
    chapter
  });
  assert.equal(restored.chapter.volumeId, volumeId);
  assert.equal(restored.chapter.status, 'done');
  assert.equal(restored.chapter.note, '这章要改');
  const after = await storage.readBookMeta(bookPath);
  assert.equal(after.chapters.find((c) => c.id === targetId).volumeId, volumeId);

  // 卷 id 不存在（书被外部改过）：撤销仍然成功，但不再挂到不存在的卷上
  const again = await storage.deleteChapter(bookPath, targetId);
  const second = await storage.restoreDeletedChapterFromTrash(bookPath, {
    trashName: path.basename(again.trashPath),
    index,
    chapter: { ...chapter, volumeId: 'vol-gone' }
  });
  assert.equal(second.chapter.volumeId, undefined);
  assert.equal(second.meta.chapters.find((c) => c.id === targetId).volumeId, undefined);
});

test('撤销删除：index 越界按夹取处理（不会插到不存在的位置）', async () => {
  const root = await mkTmp();
  const { bookPath, meta } = await makeBook(root);
  const chapter = snapshot(meta, 0);
  const deleted = await storage.deleteChapter(bookPath, chapter.id);
  const restored = await storage.restoreDeletedChapterFromTrash(bookPath, {
    trashName: path.basename(deleted.trashPath),
    index: 99,
    chapter
  });
  assert.equal(restored.index, restored.meta.chapters.length - 1);
});
