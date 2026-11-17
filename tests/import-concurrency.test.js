// WP7 / X-N2（审计中 #22）：导入的并发安全与「暂存 + 原子 rename」提交。
//
// 旧实现：importBookFolder 先 uniqueFolderName 探测空闲名，再把**正式目标**交给 fs.cp 直接复制，
// 失败 catch 里 fs.rm(target) 删的也是正式目标 —— 两个窗口并发导入同名来源时双方探测都空闲，
// 同名章节互相合并（丢章）；任一方失败还会把另一方已复制进同一目录的内容一起删掉。
// 本文件钉住：并发不合并、撞名只换后缀、失败只清自己暂存、跨窗口预检按最终撞名目标名。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const storage = require('../core/storage');
const importer = require('../core/importer');

const tmpCleanup = require('./tmp-cleanup');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fsSync.readFileSync(path.join(ROOT, rel), 'utf8');

async function mkTmp() {
  return tmpCleanup.track(await fs.mkdtemp(path.join(os.tmpdir(), 'cw-import-conc-')));
}

// 造一个「一本书的章节目录」来源：文件夹名可以同名（模拟两个窗口各自选到同名文件夹）
async function makeChapterSource(parent, folderName, files) {
  const dir = path.join(parent, folderName);
  await fs.mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), text, 'utf8');
  }
  return dir;
}

function chapterFiles(prefix, count) {
  const files = {};
  for (let i = 1; i <= count; i += 1) {
    files[`${String(i).padStart(3, '0')}-${prefix}${i}.txt`] = `${prefix}第${i}章正文`;
  }
  return files;
}

async function stagingLeftovers(booksRoot) {
  const names = await fs.readdir(booksRoot);
  return names.filter((name) => name.startsWith(importer.STAGING_PREFIX));
}

// C1：两个窗口并发导入同名来源（内容不同）→ 必须变成两本独立的书，章节绝不能被合并。
test('X-N2 C1：并发导入同名来源 → 两本独立的书（旧稿 / 旧稿-2），章节不合并、无暂存残留', async () => {
  const base = await mkTmp();
  const booksRoot = path.join(base, '书架');
  const fileCount = 6; // 多几个文件，保证两边都在探测目标名之后才开始复制
  const srcA = await makeChapterSource(path.join(base, '窗口A'), '同名旧稿', chapterFiles('甲', fileCount));
  const srcB = await makeChapterSource(path.join(base, '窗口B'), '同名旧稿', chapterFiles('乙', fileCount));

  const [resA, resB] = await Promise.all([
    importer.importFolders(booksRoot, [srcA]),
    importer.importFolders(booksRoot, [srcB])
  ]);

  assert.equal(resA.failed.length, 0, `窗口 A 不该失败：${JSON.stringify(resA.failed)}`);
  assert.equal(resB.failed.length, 0, `窗口 B 不该失败：${JSON.stringify(resB.failed)}`);
  assert.equal(resA.imported.length, 1);
  assert.equal(resB.imported.length, 1);
  const folders = [resA.imported[0].folder, resB.imported[0].folder].sort();
  assert.deepEqual(folders, ['同名旧稿', '同名旧稿-2'], '并发同名导入必须各占一个文件夹，不许合并');

  // 每本书里只有自己的章节（不是 12 章合并）
  for (const result of [resA, resB]) {
    const meta = await storage.readBookMeta(result.imported[0].path);
    assert.equal(meta.chapters.length, fileCount, `${result.imported[0].folder} 的章节被并进别人的了`);
    const names = meta.chapters.map((c) => c.name).sort();
    const own = names.every((name) => name.startsWith('甲')) || names.every((name) => name.startsWith('乙'));
    assert.equal(own, true, `${result.imported[0].folder} 里混进了另一个来源的章节：${names.join('、')}`);
  }
  const books = await storage.listBooks(booksRoot);
  assert.equal(books.length, 2);
  assert.deepEqual(await stagingLeftovers(booksRoot), [], '导入成功后不许留下 .import- 暂存目录');
});

// C2：提交撞名 —— 暂存完成之后才发现目标名被占（另一个窗口刚提交完）→ 换 -2 提交，原目标不动。
test('X-N2 C2：commitStagedFolder 撞名 → 换下一个后缀提交，原目标一个字节不动', async () => {
  assert.equal(typeof importer.createStagingRoot, 'function', '缺少 createStagingRoot');
  assert.equal(typeof importer.commitStagedFolder, 'function', '缺少 commitStagedFolder');
  assert.equal(typeof importer.safeFolderName, 'function', '缺少 safeFolderName（暂存层目录名与 uniqueFolderName 同口径）');

  const base = await mkTmp();
  const booksRoot = path.join(base, '书架');
  await fs.mkdir(booksRoot, { recursive: true });
  const existing = path.join(booksRoot, '旧稿');
  await fs.mkdir(existing);
  await fs.writeFile(path.join(existing, '001-旧.txt'), '旧内容', 'utf8');

  const stagingRoot = await importer.createStagingRoot(booksRoot);
  const staging = path.join(stagingRoot, importer.safeFolderName('旧稿'));
  await fs.mkdir(staging);
  await fs.writeFile(path.join(staging, '001-新.txt'), '新内容', 'utf8');

  try {
    const committed = await importer.commitStagedFolder(booksRoot, staging, '旧稿');
    assert.equal(committed.folder, '旧稿-2');
    assert.equal(committed.path, path.join(booksRoot, '旧稿-2'));
    assert.deepEqual(await fs.readdir(existing), ['001-旧.txt'], '原目标不许被改名覆盖');
    assert.equal(await fs.readFile(path.join(existing, '001-旧.txt'), 'utf8'), '旧内容');
    assert.equal(await fs.readFile(path.join(committed.path, '001-新.txt'), 'utf8'), '新内容');
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
});

// C3：撞名重试必须有界 —— 连续撞名到上限就明确报 BAD_PATH，暂存原样留给调用方清理，
//     正式目录里被占的目录一个字节不动（绝不在正式目录里乱删）。
test('X-N2 C3：提交连续撞名 → 有界重试后 BAD_PATH，暂存与正式目录都不被误删', async () => {
  const base = await mkTmp();
  const booksRoot = path.join(base, '书架');
  await fs.mkdir(booksRoot, { recursive: true });
  // 非空目录（POSIX 上 rename 到空目录会成功替换，非空才必然失败；Windows 上都会 EPERM）
  const occupied = path.join(booksRoot, '占位');
  await fs.mkdir(occupied);
  await fs.writeFile(path.join(occupied, '001-占.txt'), '占位内容', 'utf8');

  const stagingRoot = await importer.createStagingRoot(booksRoot);
  const staging = path.join(stagingRoot, importer.safeFolderName('旧稿'));
  await fs.mkdir(staging);
  await fs.writeFile(path.join(staging, '001-新.txt'), '新内容', 'utf8');

  const tried = [];
  try {
    await assert.rejects(
      () =>
        importer.commitStagedFolder(booksRoot, staging, '旧稿', {
          maxAttempts: 3,
          resolveFolder: async (attempt) => {
            tried.push(attempt);
            return '占位';
          }
        }),
      (err) => {
        assert.equal(err.code, 'BAD_PATH');
        assert.match(err.message, /重试 3 次/);
        assert.equal(err.message.includes(booksRoot), false, '错误文案不能带本机路径');
        return true;
      }
    );
    assert.deepEqual(tried, [1, 2, 3], '重试次数必须钉在上限，不许无限循环');
    assert.equal(await storage.exists(staging), true, '失败后暂存原样保留（调用方只清自己的暂存）');
    assert.equal(await fs.readFile(path.join(occupied, '001-占.txt'), 'utf8'), '占位内容');
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
});

// C4：跨窗口预检拿到的必须是「最终撞名目标名」—— 已存在 旧稿 时导入同名来源会落到 旧稿-2，
//     预检就要查 旧稿-2（旧实现只查来源 basename 旧稿，既可能误拦也可能漏拦）。
test('X-N2 C4：预检收到最终撞名目标名（旧稿-2）而不是来源 basename', async () => {
  const base = await mkTmp();
  const booksRoot = path.join(base, '书架');
  await fs.mkdir(booksRoot, { recursive: true });
  await fs.mkdir(path.join(booksRoot, '旧稿')); // 已存在的同名书（没有登记打开）
  const src = await makeChapterSource(path.join(base, '来源'), '旧稿', { '001-甲.txt': '甲正文' });

  const seen = [];
  const res = await importer.importFolders(booksRoot, [src], {
    guardTarget: async (target) => {
      seen.push(target);
    }
  });

  assert.equal(res.imported.length, 1);
  assert.equal(seen.length, 1, '每本书导入前必须恰好问一次最终目标');
  assert.equal(seen[0].folder, '旧稿-2');
  assert.equal(seen[0].path, path.join(booksRoot, '旧稿-2'));
  assert.equal(seen[0].sourceDir, src);
  assert.equal(res.imported[0].folder, '旧稿-2');
});

// C5：预检拒绝 → 整次导入在复制开始前中止（书库零变化、无暂存），错误码原样上抛给 IPC。
test('X-N2 C5：预检拒绝（CROSS_WINDOW_BUSY）→ 复制前中止，书库不出现新书 / 暂存', async () => {
  const base = await mkTmp();
  const booksRoot = path.join(base, '书架');
  await fs.mkdir(booksRoot, { recursive: true });
  const src = await makeChapterSource(path.join(base, '来源'), '旧稿', { '001-甲.txt': '甲正文' });

  await assert.rejects(
    () =>
      importer.importFolders(booksRoot, [src], {
        guardTarget: async ({ folder }) => {
          throw new storage.StorageError(
            'CROSS_WINDOW_BUSY',
            `导入目标「${folder}」正在另一个窗口打开。请先关掉另一个窗口，或先切换到那个窗口后再导入。`
          );
        }
      }),
    (err) => {
      assert.equal(err.code, 'CROSS_WINDOW_BUSY');
      assert.match(err.message, /另一个窗口/);
      return true;
    }
  );
  assert.deepEqual(await fs.readdir(booksRoot), [], '拒绝之后书库里不许有任何新东西（含暂存）');
});

// C6：并发同名 + 一方失败 —— 成功的书要完整保留，失败方只清自己的暂存
//     （旧实现两边共用正式目标：失败方 catch 的 fs.rm(target) 会把成功方已复制的内容一起删掉）。
test('X-N2 C6：并发同名导入、一方失败 → 成功的书完整，失败方只清自己暂存', async () => {
  const base = await mkTmp();
  const booksRoot = path.join(base, '书架');
  const srcGood = await makeChapterSource(
    path.join(base, '窗口A'),
    '同名旧稿',
    chapterFiles('甲', 6)
  );
  // 只含同步冲突副本：analyzeSource 判成章节目录，但 rebuildFromFiles 过滤后无文件 → 复制后失败
  const srcBad = await makeChapterSource(path.join(base, '窗口B'), '同名旧稿', {
    '001-甲-冲突副本.txt': '冲突副本内容'
  });

  const [good, bad] = await Promise.all([
    importer.importFolders(booksRoot, [srcGood]),
    importer.importFolders(booksRoot, [srcBad])
  ]);

  assert.equal(good.failed.length, 0, `成功方不该失败：${JSON.stringify(good.failed)}`);
  assert.equal(good.imported.length, 1, '成功方必须留下完整的一本书');
  const goodMeta = await storage.readBookMeta(good.imported[0].path);
  assert.equal(goodMeta.chapters.length, 6, '成功方不许被失败方的清理删掉内容');

  assert.equal(bad.imported.length, 0);
  assert.equal(bad.failed.length, 1, '失败方要如实记 failed');
  assert.match(bad.failed[0].message, /同步冲突副本/);
  assert.deepEqual(await stagingLeftovers(booksRoot), [], '失败方只许清自己的暂存');
  const books = await storage.listBooks(booksRoot);
  assert.equal(books.length, 1, '书架上只有成功的那一本');
});

// C7：单本 txt 并发导入同一来源 → 两边都要成功（后到者拿 -2），不再白丢一次。
test('X-N2 C7：同一个 txt 并发导入两次 → 两本都成功（小说 / 小说-2），各自完整', async () => {
  const base = await mkTmp();
  const srcDir = path.join(base, '收藏夹');
  await fs.mkdir(srcDir, { recursive: true });
  const text = Array.from({ length: 12 }, (_, i) => `第${i + 1}章 标题${i + 1}\n\n正文${i + 1}`).join('\n\n');
  await fs.writeFile(path.join(srcDir, '小说.txt'), text, 'utf8');
  const booksRoot = path.join(base, '书架');

  const [resA, resB] = await Promise.all([
    importer.importFolders(booksRoot, [srcDir]),
    importer.importFolders(booksRoot, [srcDir])
  ]);
  for (const result of [resA, resB]) {
    assert.equal(result.failed.length, 0, `并发导入不该出现失败：${JSON.stringify(result.failed)}`);
    assert.equal(result.imported.length, 1);
  }
  const folders = [resA.imported[0].folder, resB.imported[0].folder].sort();
  assert.deepEqual(folders, ['小说', '小说-2']);
  for (const result of [resA, resB]) {
    const meta = await storage.readBookMeta(result.imported[0].path);
    assert.equal(meta.chapters.length, 12);
  }
  assert.deepEqual(await stagingLeftovers(booksRoot), []);
});

// C8：静态接线 —— 暂存/提交/预检必须都在装配位置，失败清理不许再删正式目标。
test('X-N2 C8：静态接线（暂存 + rename / 失败只清暂存 / ipc 预检走 guardTarget）', () => {
  const importerSrc = read(path.join('core', 'importer.js'));
  assert.match(importerSrc, /async function createStagingRoot\(/, '缺 createStagingRoot');
  assert.match(importerSrc, /async function commitStagedFolder\(/, '缺 commitStagedFolder');
  assert.match(importerSrc, /await fs\.rename\(staging, target\)/, '提交必须是原子 rename');
  assert.equal(/fs\.rm\(target\b/.test(importerSrc), false, '失败清理不许删正式目标');
  assert.match(importerSrc, /guardTarget/, 'importFolders 必须支持 guardTarget 预检');

  const bookSrc = read(path.join('ipc', 'book.js'));
  assert.match(bookSrc, /guardTarget/, 'book:import 必须把 guardTarget 传给 importFolders');
  assert.match(bookSrc, /findOpenBookWindow/, '预检要查跨窗口打开登记');
});

// C9（复核缺口 / WP7 补漏）：暂存书目录 mkdir 失败 → 只清自己刚建的暂存根，不留 .import- 残留。
// 旧写法 createStagingRoot / mkdir(staging) 在 try 外，mkdir 一失败暂存根就没人清（崩溃残留要等 1 小时）。
test('C9（WP7 补漏）：暂存书目录 mkdir 失败 → finally 清掉暂存根（不留 .import- 残留）', async () => {
  const root = await mkTmp();
  const booksRoot = path.join(root, '书架 根');
  const src = path.join(root, '暂存失败演练.txt');
  await fs.writeFile(src, '第1章 起风\n正文。\n', 'utf8');

  const originalMkdir = fs.mkdir;
  let stagingMkdirs = 0;
  fs.mkdir = async (target, options) => {
    if (String(target).includes('.import-')) {
      stagingMkdirs += 1;
      // 第 1 次是暂存根（要成功），第 2 次是暂存书目录（注入失败）
      if (stagingMkdirs >= 2) {
        throw Object.assign(new Error('injected: 暂存书目录 mkdir 失败'), { code: 'EACCES' });
      }
    }
    return originalMkdir(target, options);
  };
  let failure = null;
  try {
    await importer.importNovelFile(booksRoot, src, { mode: 'chapters' });
  } catch (err) {
    failure = err;
  } finally {
    fs.mkdir = originalMkdir;
  }
  assert.ok(failure, '用例前提：注入的 mkdir 失败必须让导入失败（否则这个注入没有意义）');
  assert.equal(failure.code, 'EACCES');
  assert.ok(stagingMkdirs >= 2, '用例前提：暂存根建成功后才轮到暂存书目录失败');
  const leftovers = (await fs.readdir(booksRoot).catch(() => [])).filter((name) => name.startsWith('.import-'));
  assert.deepEqual(leftovers, [], '失败只清自己的暂存根：书架根下不许留 .import- 残留');
});