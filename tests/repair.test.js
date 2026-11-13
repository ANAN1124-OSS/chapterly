const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const storage = require('../core/storage');
const repair = require('../core/repair');
const { sleep } = require('../core/common');

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

// ---------- D5（1.7.2）：repair 三补的锚点（V78 / V79 / V80） ----------
// 三条都是「失败时才看得见」的路径：改名重试、回退失败的日志、同秒归档重名。
// 先写锚点再改 core/repair.js，四条都必须先红。

test('修复重建：temp → meta 改名遇到 EPERM 按 renameWithRetry 重试，第 3 次成功（V78）', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '改名要重试的书');
  await fs.mkdir(bookPath);
  await fs.writeFile(path.join(bookPath, '001-起风.txt'), '起风正文', 'utf8');
  await fs.writeFile(path.join(bookPath, '书目.json'), '{ 坏', 'utf8');
  const metaPath = path.join(bookPath, '书目.json');

  const attempts = [];
  let res = null;
  let thrown = null;
  try {
    res = await repair.rebuildFromFiles(bookPath, {
      rename: async (from, to) => {
        attempts.push(to);
        // 前两次模拟「杀毒 / 同步盘短暂占着文件」（EPERM），第三次真的改名
        if (attempts.length < 3) {
          const err = new Error('操作被系统拒绝');
          err.code = 'EPERM';
          throw err;
        }
        return fs.rename(from, to);
      }
    });
  } catch (err) {
    thrown = err;
  }

  assert.equal(thrown, null, `EPERM 只该重试、不许把修复直接判失败：${thrown && thrown.message}`);
  assert.equal(attempts.length, 3, 'temp → 书目.json 要走 atomic.renameWithRetry（3 次尝试）');
  assert.ok(attempts.every((to) => to === metaPath), '重试的必须是 temp → 书目.json 这一步');
  assert.equal(res.count, 1);
  assert.ok(res.archived && res.archived.includes(storage.CORRUPT_PREFIX), '前两步归档的坏书目仍在');
  const meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters.length, 1, '重试成功后书目真的换成了新的');
});

test('修复重建：回退（归档改回原名）也失败时，必须留一条 logError（V78）', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '改不回原名的书');
  await fs.mkdir(bookPath);
  await fs.writeFile(path.join(bookPath, '001-起风.txt'), '起风正文', 'utf8');
  const metaPath = path.join(bookPath, '书目.json');
  await fs.writeFile(metaPath, '{ 坏', 'utf8');

  const logged = [];
  const logError = (kind, err, extra) => logged.push({ kind, err, extra });
  let thrown = null;
  try {
    await repair.rebuildFromFiles(bookPath, {
      logError,
      rename: async (from, to) => {
        if (to === metaPath) {
          // 第三步失败后，归档改回原名也会撞上这个同名目录（Windows 下 rename 文件到目录 → EPERM）
          if (!(await fs.stat(metaPath).then(() => true, () => false))) await fs.mkdir(metaPath);
          const err = new Error('操作被系统拒绝');
          err.code = 'EPERM';
          throw err;
        }
        return fs.rename(from, to);
      }
    });
  } catch (err) {
    thrown = err;
  }

  assert.equal(thrown && thrown.code, 'EPERM', '原始错误照旧抛给调用方（界面提示不变）');
  assert.equal(logged.length, 1, '回退失败不许被 .catch(() => {}) 静默吞掉，至少留一条日志');
  assert.equal(logged[0].kind, 'repair-rollback', '日志类型要能一眼看出是修复回退失败');
  assert.equal(logged[0].extra && logged[0].extra.code, 'META_ROLLBACK_FAILED');
  // 日志工具是 main.js 现有的 logError（removed: 不新造第二套 logger）：产品调用必须把它接进来
  const mainSource = require('node:fs').readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  for (const fn of ['restoreFromBak', 'rebuildFromFiles']) {
    assert.match(
      mainSource,
      new RegExp(`repair\\.${fn}\\(bookPath, \\{ logError \\}\\)`),
      `main.js 的 ${fn} 必须传 { logError }，否则回退失败在生产里仍然静默`
    );
  }
});

test('修复重建：同一秒内两次归档不重名，两份坏书目都留着（V79）', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '同秒两次修复');
  await fs.mkdir(bookPath);
  await fs.writeFile(path.join(bookPath, '001-起风.txt'), '起风正文', 'utf8');
  const metaPath = path.join(bookPath, '书目.json');

  // 等到刚跨秒再开跑：两次重建都在同一秒里完成，旧实现（秒精度）会撞名
  await sleep(1000 - (Date.now() % 1000) + 10);
  await fs.writeFile(metaPath, '{ 第一次坏', 'utf8');
  const first = await repair.rebuildFromFiles(bookPath);
  await fs.writeFile(metaPath, '{ 第二次坏', 'utf8');
  const second = await repair.rebuildFromFiles(bookPath);

  assert.notEqual(first.archived, second.archived, '同一秒两次归档必须换一个名字（归档名要带毫秒）');
  const archives = (await fs.readdir(bookPath)).filter((name) => name.startsWith(storage.CORRUPT_PREFIX));
  assert.equal(archives.length, 2, '两份坏书目都要留在文件夹里，第二次不许覆盖第一次');
  const meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters.length, 1, '两次重建后书目仍是合法 JSON');
});

test('从目录重建：超大序号夹到 9999，fileSeq 不许放大成超长路径（V80）', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '超大序号的书');
  await fs.mkdir(bookPath);
  await fs.writeFile(path.join(bookPath, '001-起风.txt'), '起风正文', 'utf8');
  await fs.writeFile(path.join(bookPath, '999999999999-巨大序号.txt'), '巨大序号正文', 'utf8');

  const res = await repair.rebuildFromFiles(bookPath);
  assert.equal(res.count, 2);
  assert.equal(res.meta.fileSeq, 9999, '重建出的 fileSeq 要夹在 9999，下一章文件名才不会超长');
  assert.ok(res.meta.chapters.some((c) => c.file === '999999999999-巨大序号.txt'), '超限号的原文件照旧列进书目（不删不改名）');
  const meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.fileSeq, 9999, '写盘后的书目里也是 9999');
});
