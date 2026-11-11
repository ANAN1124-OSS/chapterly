const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const storage = require('../core/storage');
const repair = require('../core/repair');

const tmpCleanup = require('./tmp-cleanup');

async function mkTmp() {
  return tmpCleanup.track(await fs.mkdtemp(path.join(os.tmpdir(), 'cw-repair-')));
}

test('从目录 txt 重建：按创建序号排序、名字回填、损坏 json 被保留', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '旧书');
  await fs.mkdir(bookPath);
  // 故意打乱文件，模拟目录顺序和章节顺序不同
  await fs.writeFile(path.join(bookPath, '003-夜雨.txt'), '夜雨正文', 'utf8');
  await fs.writeFile(path.join(bookPath, '001-起风.txt'), '起风正文', 'utf8');
  await fs.writeFile(path.join(bookPath, '002-未命名.txt'), '', 'utf8');
  await fs.writeFile(path.join(bookPath, '书目.json'), '{ 坏掉了', 'utf8');

  const res = await repair.rebuildFromFiles(bookPath);
  assert.equal(res.count, 3);
  assert.deepEqual(res.meta.chapters.map((c) => c.file), ['001-起风.txt', '002-未命名.txt', '003-夜雨.txt']);
  assert.deepEqual(res.meta.chapters.map((c) => c.name), ['起风', '', '夜雨']);
  assert.equal(res.meta.fileSeq, 3);
  // 损坏的 json 被改名为 .corrupt-*，不是被删掉
  const files = await fs.readdir(bookPath);
  assert.ok(files.some((f) => f.startsWith('书目.json.corrupt-')), '损坏文件应被保留');
  // 重建后可以正常读取
  const meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters.length, 3);
  // 重建出来的书目也带当前格式版本；没有冲突副本时跳过数为 0
  assert.equal(meta.schemaVersion, 1);
  assert.equal(res.skippedConflicts, 0);
  assert.deepEqual(res.conflictCopies, []);
});

test('从目录重建：同步冲突副本不算章节，原样留在文件夹里', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '带冲突副本的书');
  await fs.mkdir(bookPath);
  await fs.writeFile(path.join(bookPath, '001-起风.txt'), '起风正文', 'utf8');
  await fs.writeFile(path.join(bookPath, '002-夜雨.txt'), '夜雨正文', 'utf8');
  await fs.writeFile(path.join(bookPath, '001-起风 (conflicted copy).txt'), '冲突副本里的旧稿', 'utf8');
  await fs.writeFile(path.join(bookPath, '书目-冲突副本.json'), '{"chapters":[]}', 'utf8');
  await fs.writeFile(path.join(bookPath, '书目.json'), '{ 坏掉了', 'utf8');

  const res = await repair.rebuildFromFiles(bookPath);
  assert.equal(res.count, 2);
  assert.deepEqual(res.meta.chapters.map((c) => c.file), ['001-起风.txt', '002-夜雨.txt']);
  // 只有 .txt 会参与「从目录重建」，所以只统计被跳过的 txt 冲突副本（书目副本本来就不算章节）
  assert.equal(res.skippedConflicts, 1);
  assert.deepEqual(res.conflictCopies, ['001-起风 (conflicted copy).txt']);
  // 冲突副本原样保留，没有被删掉或改名
  const files = await fs.readdir(bookPath);
  assert.ok(files.includes('001-起风 (conflicted copy).txt'));
  assert.ok(files.includes('书目-冲突副本.json'));
  assert.equal(await fs.readFile(path.join(bookPath, '001-起风 (conflicted copy).txt'), 'utf8'), '冲突副本里的旧稿');
});

test('从目录重建：只有冲突副本时给出可读错误，不产生书目', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '只有副本');
  await fs.mkdir(bookPath);
  await fs.writeFile(path.join(bookPath, '001-起风 (conflicted copy).txt'), '旧稿', 'utf8');
  await assert.rejects(
    () => repair.rebuildFromFiles(bookPath),
    (err) => err.code === 'NO_FILES' && /同步冲突副本/.test(err.message)
  );
  assert.equal(await fs.access(path.join(bookPath, '书目.json')).then(() => true, () => false), false);
});

test('无 txt 时重建报错，不产生书目', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '空目录');
  await fs.mkdir(bookPath);
  await assert.rejects(() => repair.rebuildFromFiles(bookPath), (err) => err.code === 'NO_FILES');
});

test('从 .bak 恢复：坏掉的书目换成上一版，坏文件被保留', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '恢复测试');
  // 制造一个 .bak：先改名一次（写入时自动生成 bak = 旧版）
  await storage.renameBook(bookPath, '恢复测试-第二版');
  // 现在把主文件写坏
  await fs.writeFile(path.join(bookPath, '书目.json'), '彻底坏掉', 'utf8');
  const res = await repair.restoreFromBak(bookPath);
  assert.equal(res.meta.title, '恢复测试');
  const files = await fs.readdir(bookPath);
  assert.ok(files.some((f) => f.startsWith('书目.json.corrupt-')));
  const meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.title, '恢复测试');
});

test('没有 .bak 时给出可读错误', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '无备份');
  await assert.rejects(() => repair.restoreFromBak(bookPath), (err) => err.code === 'NO_BAK');
});

// ---------- 修复失败语义（1.6.0 A3 / 审计 E-07） ----------
// 修书目必须「先写新书目 → 再归档旧文件」。反过来做（旧代码）一旦写盘失败（ENOSPC / EPERM），
// 坏书目已经被改名挪走，书在书架上看不见了，只能靠用户自己翻 _trash 找回来。
test('修复重建：新书目写不进去时，坏书目一个字节不动（不先归档）', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '修不动的书');
  await fs.mkdir(bookPath);
  await fs.writeFile(path.join(bookPath, '001-起风.txt'), '起风正文', 'utf8');
  await fs.writeFile(path.join(bookPath, '书目.json'), '{ 坏掉的书目', 'utf8');
  const before = await fs.readFile(path.join(bookPath, '书目.json'), 'utf8');

  await assert.rejects(
    repair.rebuildFromFiles(bookPath, {
      writeJson: async () => {
        const err = new Error('磁盘满了');
        err.code = 'ENOSPC';
        throw err;
      }
    }),
    (err) => err.code === 'ENOSPC',
    '写不进去时要把错误原样抛出来（调用方据此给中文提示）'
  );
  const names = await fs.readdir(bookPath);
  assert.ok(!names.some((name) => name.startsWith(storage.CORRUPT_PREFIX)), '新书目没写成之前不许归档旧文件');
  assert.ok(!names.some((name) => name.startsWith('.repair-meta')), '失败时不许留临时文件');
  assert.equal(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'), before, '坏书目原样留着才能再修一次');

  // 障碍消失后再修一次就能成（幂等）
  const fixed = await repair.rebuildFromFiles(bookPath);
  assert.equal(fixed.count, 1);
  assert.ok(fixed.archived && fixed.archived.includes(storage.CORRUPT_PREFIX), '成功后才归档坏书目');
});

test('修复重建：归档后改名失败，要把坏书目改回原名（失败可回退）', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '改不回去的书');
  await fs.mkdir(bookPath);
  await fs.writeFile(path.join(bookPath, '001-起风.txt'), '起风正文', 'utf8');
  await fs.writeFile(path.join(bookPath, '书目.json'), '{ 坏', 'utf8');
  const metaPath = path.join(bookPath, '书目.json');

  await assert.rejects(
    repair.rebuildFromFiles(bookPath, {
      rename: async (from, to) => {
        if (to === metaPath) {
          const err = new Error('操作被系统拒绝');
          err.code = 'EPERM';
          throw err;
        }
        return fs.rename(from, to);
      }
    }),
    (err) => err.code === 'EPERM'
  );
  const names = await fs.readdir(bookPath);
  assert.ok(names.includes('书目.json'), '失败后坏书目要回到原名（书仍然看得见）');
  assert.ok(!names.some((name) => name.startsWith('.repair-meta')), '临时文件要清掉');
  assert.equal(await fs.readFile(metaPath, 'utf8'), '{ 坏');
});

test('从 .bak 恢复：同样先写新书目再归档，写失败时主文件与 .bak 都不动', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '备份恢复失败书');
  await fs.mkdir(bookPath);
  await fs.writeFile(path.join(bookPath, '001-起风.txt'), '正文', 'utf8');
  await fs.writeFile(path.join(bookPath, '书目.json'), '{ 坏', 'utf8');
  const bak = {
    version: 1,
    schemaVersion: 1,
    id: 'b_bak',
    title: '备份恢复失败书',
    chapters: [{ id: 'ch_001', file: '001-起风.txt', name: '起风' }]
  };
  await fs.writeFile(path.join(bookPath, '书目.json.bak'), JSON.stringify(bak), 'utf8');
  const bakBefore = await fs.readFile(path.join(bookPath, '书目.json.bak'), 'utf8');

  await assert.rejects(
    repair.restoreFromBak(bookPath, {
      writeJson: async () => {
        const err = new Error('磁盘满了');
        err.code = 'ENOSPC';
        throw err;
      }
    }),
    (err) => err.code === 'ENOSPC'
  );
  const names = await fs.readdir(bookPath);
  assert.ok(!names.some((name) => name.startsWith(storage.CORRUPT_PREFIX)), '写失败时坏文件不许先被归档');
  assert.equal(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'), '{ 坏');
  assert.equal(await fs.readFile(path.join(bookPath, '书目.json.bak'), 'utf8'), bakBefore, '.bak 一个字节不动');
});
