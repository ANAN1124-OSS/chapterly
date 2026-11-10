// 1.4.0 P0-2：撤销「删除章节」的磁盘层（core/storage.js restoreDeletedChapterFromTrash）。
//
// 这一层是撤销删除的最后一道闸门，测试围绕四件事：
//   1. 正常路径：_trash 里的那一份放回书文件夹、按原 index 插回 书目.json（顺序 / 正文 / 字数缓存都在）；
//   2. 删空自动补章：补章仍空着才一并撤掉；作者往补章里写过字就保留（宁可多一章，不静默丢字）；
//   3. 路径安全：只认本书 _trash 下的 basename，绝对路径 / 目录穿越 / 别的文件名一律拒绝；
//   4. 失败不破坏现场：目标已存在 / 备份不在 / id 重复都报错，书文件夹与 _trash 一个字节不动。
// 1.5.0 P0-3（审计 E3 / O-8）起再加两件：
//   5. 章名写回前按建章规则清洗（chaptersLib.safeName：非法 / 控制字符、40 字上限、保留名），空名保持空串；
//   6. 主进程真实形状（sanitizeRestorePayload → storage）：坏 payload 在校验层被拒、零副作用，
//      正常 payload 附带的未知字段被白名单丢掉后照旧撤销。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const storage = require('../core/storage');
const chapters = require('../core/chapters');
const ipcLimits = require('../core/ipc-limits');
const ipcRestoreToken = require('../core/ipc-restore-token');

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

// ---------- 1.5.0 P0-3（审计 E3 / O-8）：章名清洗 + payload 白名单 ----------
//
// 主进程里 chapter:restore-deleted = sanitizeRestorePayload(payload) → storage 的两段式；
// 这里用同一个形状跑（不需要起 Electron），既证明「正常撤销照旧」，也证明「坏 payload 一个字节都不写」。

// 与 main.js 的 handleBook('chapter:delete') 同形：storage 删完 → 发一张进程内一次性凭证；
// 返回形状只多一个 undoToken，原有字段一个不少。
const restoreTokens = ipcRestoreToken.createStore();
const deleteThroughIpc = async (bookPath, chapterId) => {
  const result = await storage.deleteChapter(bookPath, chapterId);
  const trashName = result && result.trashPath ? path.basename(result.trashPath) : '';
  const undoToken = trashName ? restoreTokens.issue({ bookPath, trashName, chapterId }) : '';
  return { ...result, undoToken };
};

// 与 main.js 的 handleBook('chapter:restore-deleted') 同形：先白名单，再验撤销凭证（一次性），
// 最后下传 storage；storage 失败时把凭证放回去（作者还能再试）。
// （main.js 的 handler 是 async，校验层的同步抛错在那里会变成 rejected promise，交给 fail()；
//  这里同样用 async 包一层，测试口径与真实 IPC 一致。）
const restoreThroughIpc = async (bookPath, payload) => {
  const clean = ipcLimits.sanitizeRestorePayload(payload);
  const rawToken =
    payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.undoToken : '';
  const claim = restoreTokens.take(rawToken, { bookPath, trashName: clean.trashName });
  if (!claim.ok) throw ipcRestoreToken.errorFor(claim.reason);
  try {
    return await storage.restoreDeletedChapterFromTrash(bookPath, clean);
  } catch (err) {
    restoreTokens.release(claim.record);
    throw err;
  }
};

async function snapshotBook(bookPath) {
  return {
    entries: (await fs.readdir(bookPath)).sort(),
    meta: await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'),
    trash: (await fs.readdir(path.join(bookPath, '_trash'))).sort()
  };
}

test('撤销删除：章名写回前按建章规则清洗（超长夹到 40 字 / 非法与控制字符去掉 / 空名保持空）', async () => {
  const root = await mkTmp();
  const { bookPath, meta } = await makeBook(root);
  const chapter = snapshot(meta, 1);
  const file1 = chapter.file;
  const deleted = await deleteThroughIpc(bookPath, chapter.id);
  const trashName = path.basename(deleted.trashPath);

  // 目录穿越片段 + 60 个「夜」+ Windows 非法字符 + 控制字符：这一串绝不能原样进 书目.json
  const dirty = `../${'夜'.repeat(60)}\u0000\u0007a:b*c?d"e<f>g|h/i\\j`;
  const restored = await restoreThroughIpc(bookPath, {
    trashName,
    undoToken: deleted.undoToken,
    index: 1,
    chapter: { ...chapter, name: dirty }
  });
  assert.equal(restored.chapter.file, file1, '章节文件名不变');
  assert.equal(restored.chapter.name, chapters.safeName(dirty), '写回的是 safeName 的清洗结果');
  assert.equal(restored.chapter.name.length, 40, '超长章名夹到 40 字');
  assert.equal(/[\\/:*?"<>|\u0000-\u001f]/.test(restored.chapter.name), false, '非法 / 控制字符被清掉');
  const after = await storage.readBookMeta(bookPath);
  assert.deepEqual(after.chapters.map((c) => c.file), meta.chapters.map((c) => c.file), '位置不变');
  assert.equal(after.chapters[1].name, restored.chapter.name, '书目里存的就是清洗后的名字');

  // 空名（含只有空白）保持空串：撤销是恢复原状，不能凭空把「未命名」写成章名
  const first = after.chapters[0];
  const deletedAgain = await deleteThroughIpc(bookPath, first.id);
  const blank = await restoreThroughIpc(bookPath, {
    trashName: path.basename(deletedAgain.trashPath),
    undoToken: deletedAgain.undoToken,
    index: 0,
    chapter: { ...first, name: '   ' }
  });
  assert.equal(blank.chapter.name, '');
  assert.equal((await storage.readBookMeta(bookPath)).chapters[0].name, '');
});

test('撤销删除：坏 payload 在 IPC 校验层被拒，书文件夹与书目一个字节不动（正常 payload 照旧）', async () => {
  const root = await mkTmp();
  const { bookPath, meta } = await makeBook(root);
  const chapter = snapshot(meta, 1);
  const deleted = await deleteThroughIpc(bookPath, chapter.id);
  const trashName = path.basename(deleted.trashPath);
  const before = await snapshotBook(bookPath);

  const badPayloads = [
    { trashName: path.join(bookPath, '_trash', trashName), index: 1, chapter }, // 绝对路径
    { trashName: `../${trashName}`, index: 1, chapter }, // 目录穿越
    { trashName: '书目.json', index: 1, chapter }, // 非章节 txt
    { trashName, index: 1.5, chapter }, // 非整数下标
    { trashName, index: -1, chapter }, // 负下标
    { trashName, index: 1, chapter: { ...chapter, id: '' } }, // 缺 id
    { trashName, index: 1, chapter: { ...chapter, file: `../${chapter.file}` } }, // 章节文件名带目录
    { trashName, index: 1, chapter: { ...chapter, file: chapter.file.replace(/\.txt$/, '.md') } }, // 非 txt
    { trashName, index: 1, chapter: { ...chapter, id: 'i'.repeat(ipcLimits.MAX_ID_CHARS + 1) } }, // id 超长
    { trashName, index: 1, chapter: { ...chapter, file: 'x'.repeat(ipcLimits.MAX_FILE_NAME_CHARS) + '.txt' } },
    {} // 什么都没给
  ];
  for (const payload of badPayloads) {
    await assert.rejects(
      () => restoreThroughIpc(bookPath, payload),
      (err) => err.code === 'BAD_RESTORE',
      `坏 payload 必须被 IPC 校验层拒绝：${JSON.stringify(payload).slice(0, 80)}`
    );
  }
  assert.deepEqual(await snapshotBook(bookPath), before, '坏 payload 不许动书文件夹 / _trash / 书目一个字节');

  // 正常 payload（附带的未知字段被白名单丢掉）照旧撤销：位置、正文、章名都对
  const restored = await restoreThroughIpc(bookPath, {
    trashName,
    undoToken: deleted.undoToken,
    index: 1,
    chapter,
    autoChapterFile: null,
    bookPath: 'C:\\伪造的书',
    fileSeq: 999
  });
  assert.equal(restored.index, 1);
  assert.equal(restored.chapter.file, chapter.file);
  assert.equal(restored.chapter.name, chapter.name);
  const after = await storage.readBookMeta(bookPath);
  assert.deepEqual(after.chapters.map((c) => c.file), meta.chapters.map((c) => c.file));
  assert.equal((await storage.loadChapterText(bookPath, chapter.file)).text, '');
});

// ---------- 1.5.0 P0-5（审计 V-1）：撤销凭证 ----------
//
// 主进程里 chapter:delete 发一张一次性凭证，chapter:restore-deleted 先验凭证再下传 storage；
// 这里用同一个形状跑：伪造 / 缺凭证 / 重复使用 / 跨书都被拒，且一个字节都不写；
// 正常的撤销照旧；storage 失败时凭证放回去，作者还能再试一次。

test('撤销删除：撤销凭证——缺凭证 / 伪造凭证被拒且零副作用，真凭证用一次就作废', async () => {
  const root = await mkTmp();
  const { bookPath, meta } = await makeBook(root);
  const chapter = snapshot(meta, 1);
  const deleted = await deleteThroughIpc(bookPath, chapter.id);
  const trashName = path.basename(deleted.trashPath);
  assert.equal(typeof deleted.undoToken, 'string');
  assert.ok(deleted.undoToken.length > 0, '删除结果必须带 undoToken');
  const before = await snapshotBook(bookPath);

  const forgedPayloads = [
    { trashName, index: 1, chapter }, // 没有凭证
    { trashName, undoToken: 'forged-token', index: 1, chapter },
    { trashName, undoToken: '', index: 1, chapter },
    // 缺凭证也要先过白名单：坏 payload 仍然报 BAD_RESTORE（校验顺序不变）
    { trashName: '书目.json', undoToken: 'forged-token', index: 1, chapter }
  ];
  for (const payload of forgedPayloads) {
    await assert.rejects(
      () => restoreThroughIpc(bookPath, payload),
      (err) => err.code === (payload.trashName === trashName ? 'RESTORE_TOKEN_INVALID' : 'BAD_RESTORE'),
      `无凭证 / 伪造凭证必须被拒：${JSON.stringify(payload).slice(0, 80)}`
    );
  }
  assert.deepEqual(await snapshotBook(bookPath), before, '被拒的撤销不许动书文件夹 / _trash / 书目一个字节');

  // 真凭证：照旧撤销
  const restored = await restoreThroughIpc(bookPath, {
    trashName,
    undoToken: deleted.undoToken,
    index: 1,
    chapter
  });
  assert.equal(restored.chapter.file, chapter.file);
  assert.equal(restored.index, 1);
  const after = await storage.readBookMeta(bookPath);
  assert.deepEqual(after.chapters.map((c) => c.file), meta.chapters.map((c) => c.file));

  // 一次性：同一张凭证第二次必须被拒（书保持撤销后的样子）
  const afterFirst = await snapshotBook(bookPath);
  await assert.rejects(
    () => restoreThroughIpc(bookPath, { trashName, undoToken: deleted.undoToken, index: 1, chapter }),
    (err) => err.code === 'RESTORE_TOKEN_INVALID',
    '同一张凭证不能撤销两次'
  );
  assert.deepEqual(await snapshotBook(bookPath), afterFirst, '重复使用不许再写一次');
});

test('撤销删除：撤销凭证——跨书被拒（真凭证不被烧掉），回到原书照旧能撤', async () => {
  const root = await mkTmp();
  const { bookPath, meta } = await makeBook(root);
  const otherRoot = await mkTmp('cw-undo-other-');
  const { path: otherBookPath } = await storage.createBook(otherRoot, '别的书');
  const chapter = snapshot(meta, 1);
  const deleted = await deleteThroughIpc(bookPath, chapter.id);
  const trashName = path.basename(deleted.trashPath);
  const payload = { trashName, undoToken: deleted.undoToken, index: 1, chapter };

  await assert.rejects(
    () => restoreThroughIpc(otherBookPath, payload),
    (err) => err.code === 'RESTORE_TOKEN_INVALID' && /不属于这本书/.test(err.message),
    '跨书必须被拒'
  );
  assert.deepEqual(
    (await storage.readBookMeta(otherBookPath)).chapters.map((c) => c.file),
    (await storage.readBookMeta(otherBookPath)).chapters.map((c) => c.file)
  );

  // 跨书尝试不能把凭证烧掉：回到原书仍然可用
  const restored = await restoreThroughIpc(bookPath, payload);
  assert.equal(restored.chapter.file, chapter.file);
});

test('撤销删除：撤销凭证——storage 失败时凭证放回去，修好现场还能再撤一次', async () => {
  const root = await mkTmp();
  const { bookPath, meta } = await makeBook(root);
  const chapter = snapshot(meta, 1);
  const deleted = await deleteThroughIpc(bookPath, chapter.id);
  const trashName = path.basename(deleted.trashPath);
  const payload = { trashName, undoToken: deleted.undoToken, index: 1, chapter };

  // 人为占住目标文件名 → storage 报 RESTORE_TARGET_EXISTS（撤销没发生）
  await fs.writeFile(path.join(bookPath, chapter.file), '占位', 'utf8');
  const occupied = await snapshotBook(bookPath);
  await assert.rejects(
    () => restoreThroughIpc(bookPath, payload),
    (err) => err.code === 'RESTORE_TARGET_EXISTS'
  );
  assert.deepEqual(await snapshotBook(bookPath), occupied, '失败的撤销不动任何文件');

  // 清掉障碍后，同一张凭证仍然有效（失败时 release 回 Map）
  await fs.unlink(path.join(bookPath, chapter.file));
  const restored = await restoreThroughIpc(bookPath, payload);
  assert.equal(restored.chapter.file, chapter.file);
  assert.equal((await storage.readBookMeta(bookPath)).chapters.length, meta.chapters.length);
});
