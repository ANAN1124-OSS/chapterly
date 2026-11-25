// 章级与整本 storage 行为（T9：从 tests/storage.test.js 拆出）。
// 范围：章节保存 / 读取 / 插入 / 重命名 / 删除 / 加载上限 / 分卷 / 章号方式 / 拖拽排序 /
// 全书查找替换与替换备份还原 / 整本排版 / 字数缓存合并 / 只读租约 / renameWithRetry。
// 书级扫描与容量闸门见 tests/storage-book.test.js。

const test = require('node:test');
const { beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const storage = require('../core/storage');
const limits = require('../core/limits');
const { MAX_MATCHES } = require('../core/find');
const {
  mkTmp,
  makeBook,
  countReadFileFor
} = require('./storage-fixtures');

// TB-05：打开登记（openBookRegistry）是模块级单例 —— 每个用例前统一重置。
// 单个用例要预置登记时仍可自己 register，测试之间互不影响。
beforeEach(() => {
  storage.openBookRegistry.reset();
});

test('章节保存/读取往返：落盘 CRLF、无 BOM，读回 LF', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '测试书');
  const meta = await storage.readBookMeta(bookPath);
  const file = meta.chapters[0].file;
  await storage.saveChapterText(bookPath, file, '第一行\n第二行\n');
  const raw = await fs.readFile(path.join(bookPath, file));
  const hasBom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  assert.equal(hasBom, false, '不应有 BOM');
  assert.equal(raw.toString('utf8'), '第一行\r\n第二行\r\n');
  const loaded = await storage.loadChapterText(bookPath, file);
  assert.equal(loaded.text, '第一行\n第二行\n');
});


test('外部 BOM 文件也能正常读入', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '测试书');
  const meta = await storage.readBookMeta(bookPath);
  const file = meta.chapters[0].file;
  await fs.writeFile(path.join(bookPath, file), '\uFEFF带BOM的内容\r\n', 'utf8');
  const loaded = await storage.loadChapterText(bookPath, file);
  assert.equal(loaded.text, '带BOM的内容\n');
});


test('插入章节：新文件命名、旧文件不重命名、顺序正确', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '插入测试');
  await storage.createChapter(bookPath, 1, '起风');
  await storage.createChapter(bookPath, 2, '夜雨');
  let meta = await storage.readBookMeta(bookPath);
  const before = meta.chapters.map((c) => c.file);
  assert.deepEqual(before, ['001-未命名.txt', '002-起风.txt', '003-夜雨.txt']);

  const inserted = await storage.createChapter(bookPath, 1, '灯塔');
  meta = await storage.readBookMeta(bookPath);
  assert.deepEqual(meta.chapters.map((c) => c.name), ['', '灯塔', '起风', '夜雨']);
  assert.deepEqual(meta.chapters.map((c) => c.file), ['001-未命名.txt', '004-灯塔.txt', '002-起风.txt', '003-夜雨.txt']);
  // 旧文件在磁盘上原样存在，未被改名
  for (const f of before) {
    await fs.access(path.join(bookPath, f));
  }
  assert.equal(inserted.index, 1);
});


test('新建章节并写正文：一次完成、字数进书目、正文原样落盘', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '捕获测试');
  const before = await storage.readBookMeta(bookPath);
  const res = await storage.createChapterWithText(bookPath, {
    insertIndex: before.chapters.length,
    name: '撞见了幽灵',
    text: '第一段\n\n第二段'
  });
  const meta = await storage.readBookMeta(bookPath);
  const chapter = meta.chapters[res.index];
  assert.equal(chapter.name, '撞见了幽灵');
  assert.equal(chapter.chars, 6);
  assert.equal(res.chars, 6);
  const raw = await fs.readFile(path.join(bookPath, chapter.file), 'utf8');
  assert.equal(raw, '第一段\r\n\r\n第二段');

  // 不传正文时与旧 createChapter 行为一致：空文件、书目里不出现 chars 字段
  const empty = await storage.createChapterWithText(bookPath, { insertIndex: 999, name: '空章' });
  const after = await storage.readBookMeta(bookPath);
  assert.equal(after.chapters[empty.index].chars, undefined);
  assert.equal(await fs.readFile(path.join(bookPath, after.chapters[empty.index].file), 'utf8'), '');
});


test('重命名章节：只改 name，不动文件名', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '重命名测试');
  const meta = await storage.readBookMeta(bookPath);
  const chapter = meta.chapters[0];
  const res = await storage.renameChapter(bookPath, chapter.id, '新的名字');
  assert.equal(res.chapter.name, '新的名字');
  assert.equal(res.chapter.file, chapter.file);
  await fs.access(path.join(bookPath, chapter.file));
});


test('章节状态/备注：写进书目、txt 一个字节不动、可清空、非法状态被拒', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '状态备注');
  await storage.createChapter(bookPath, 1, '第二章');
  const meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '第一章正文。');
  await storage.saveChapterText(bookPath, meta.chapters[1].file, '第二章正文。');
  const before = [];
  for (const chapter of meta.chapters) {
    const filePath = path.join(bookPath, chapter.file);
    const stat = await fs.stat(filePath);
    before.push({
      file: chapter.file,
      text: await fs.readFile(filePath, 'utf8'),
      mtimeMs: stat.mtimeMs,
      size: stat.size
    });
  }

  const res = await storage.updateChapterMeta(bookPath, meta.chapters[0].id, {
    status: 'done',
    note: '补结尾'
  });
  assert.equal(res.changed, true);
  assert.equal(res.chapter.status, 'done');
  assert.equal(res.chapter.note, '补结尾');

  // 只写书目：txt 的内容、大小、mtime 都没变（「txt 一个字节不动」）
  for (const item of before) {
    const filePath = path.join(bookPath, item.file);
    const stat = await fs.stat(filePath);
    assert.equal(stat.size, item.size);
    assert.equal(stat.mtimeMs, item.mtimeMs);
    assert.equal(await fs.readFile(filePath, 'utf8'), item.text);
  }
  const diskMeta = JSON.parse(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'));
  assert.equal(diskMeta.chapters[0].status, 'done');
  assert.equal(diskMeta.chapters[0].note, '补结尾');
  assert.equal(diskMeta.chapters[1].status, undefined);

  // 备注超过 200 字截断；清空备注 = 删除字段
  const longRes = await storage.updateChapterMeta(bookPath, meta.chapters[1].id, {
    note: '字'.repeat(250)
  });
  assert.equal(longRes.chapter.note.length, 200);
  const clearRes = await storage.updateChapterMeta(bookPath, meta.chapters[1].id, { note: '  ' });
  assert.equal(clearRes.chapter.note, undefined);
  const afterClear = JSON.parse(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'));
  assert.equal(afterClear.chapters[1].note, undefined);

  // 非法状态被拒，书目保持原样
  await assert.rejects(
    () => storage.updateChapterMeta(bookPath, meta.chapters[0].id, { status: 'finished' }),
    (err) => err.code === 'BAD_STATUS'
  );
  const stillDone = await storage.readBookMeta(bookPath);
  assert.equal(stillDone.chapters[0].status, 'done');

  // 没有变化时不写盘（书目 mtime 不变，避免无意义的 .bak 轮换）
  const metaPath = path.join(bookPath, '书目.json');
  const metaStat = await fs.stat(metaPath);
  const noop = await storage.updateChapterMeta(bookPath, meta.chapters[0].id, {
    status: 'done',
    note: '补结尾'
  });
  assert.equal(noop.changed, false);
  assert.equal((await fs.stat(metaPath)).mtimeMs, metaStat.mtimeMs);
});


test('删除章节：文件移入 _trash，json 移除，删空后保持 0 章（不再自动补章）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '删除测试');
  await storage.createChapter(bookPath, 1, '甲');
  let meta = await storage.readBookMeta(bookPath);
  const target = meta.chapters[1];
  const res = await storage.deleteChapter(bookPath, target.id);
  assert.ok(res.trashPath.includes('_trash'));
  await fs.access(res.trashPath);
  meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters.length, 1);
  // 删到空（2026-11-25 作者要求：0 章合法，章节由作者自己建）
  const last = await storage.deleteChapter(bookPath, meta.chapters[0].id);
  meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters.length, 0, '删空后保持 0 章，不再自动补一章');
  assert.equal(last.index, -1, '回包 index = -1，渲染层据此进空态');
  assert.equal(meta.lastOpenChapterId, null, '0 章书没有「上次打开的章」');
});


test('路径越界防护：bookPath 之外的 file 被拒绝', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '越界测试');
  await assert.rejects(
    () => storage.loadChapterText(bookPath, '..\\..\\outside.txt'),
    (err) => err.code === 'BAD_PATH'
  );
  await assert.rejects(
    () => storage.saveChapterText(bookPath, 'C:\\Windows\\win.ini', 'x'),
    (err) => err.code === 'BAD_PATH'
  );
});

// WP-06（审计 C5）：删章也是写入口，书目里的 file 必须过 assertChapterFile —— 坏书目（file 含 ..\）
// 既不许把书外文件 rename 进本书 _trash，也不许沿回滚路径往书外写。被拒时零副作用。


test('删除章节：坏书目 file 含 ..\\ 时按 BAD_PATH 拒绝，书外文件 / 书目 / _trash 零副作用', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '坏书目删章');
  await storage.createChapter(bookPath, 1, '第二章');
  const outsideFile = path.join(root, '书外目标.txt');
  const outsideText = '书外文件：删章不许碰它\n';
  await fs.writeFile(outsideFile, outsideText, 'utf8');
  const metaPath = path.join(bookPath, '书目.json');
  const raw = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  assert.equal(raw.chapters.length, 2);
  // 相对 bookPath 解析正好落到书库根的书外文件 —— 与审计 C5 的坏书目同一形态。
  raw.chapters[1].file = `..${path.sep}${path.basename(outsideFile)}`;
  await fs.writeFile(metaPath, JSON.stringify(raw, null, 2), 'utf8');
  const metaBytesBefore = await fs.readFile(metaPath);
  await assert.rejects(
    () => storage.deleteChapter(bookPath, raw.chapters[1].id),
    (err) => err.code === 'BAD_PATH'
  );
  assert.equal(await fs.readFile(outsideFile, 'utf8'), outsideText, '书外文件一个字节都不许动');
  assert.deepEqual(await fs.readFile(metaPath), metaBytesBefore, '被拒时书目不许改写');
  await assert.rejects(() => fs.access(path.join(bookPath, '_trash')), '被拒时连 _trash 目录都不许建');
  // 正常的另一章还在，书没有被这次失败的删除改动
  const after = await storage.readBookMeta(bookPath);
  assert.equal(after.chapters.length, 2);
  await fs.access(path.join(bookPath, after.chapters[0].file));
});


test('moveToTrash：移文件入口自己就挡越界文件名（删章 / 撤销补章共用）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '移文件闸门');
  const outsideFile = path.join(root, '书外目标.txt');
  await fs.writeFile(outsideFile, '不许动', 'utf8');
  await assert.rejects(
    () => storage.moveToTrash(bookPath, `..${path.sep}${path.basename(outsideFile)}`),
    (err) => err.code === 'BAD_PATH'
  );
  await assert.rejects(() => fs.access(path.join(bookPath, '_trash')), '被拒时不许建 _trash');
  assert.equal(await fs.readFile(outsideFile, 'utf8'), '不许动');
});


test('并发写操作串行化：改名不会被「记住上次章节」覆盖', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '并发测试');
  await storage.createChapter(bookPath, 1, '夜雨');
  const meta = await storage.readBookMeta(bookPath);
  const targetId = meta.chapters[1].id;

  await Promise.all([
    storage.renameChapter(bookPath, meta.chapters[0].id, '改名后'),
    storage.setLastOpenChapter(bookPath, targetId),
    storage.createChapter(bookPath, 2, '第三')
  ]);

  const after = await storage.readBookMeta(bookPath);
  assert.equal(after.chapters[0].name, '改名后', '改名不能被并发写覆盖');
  assert.equal(after.lastOpenChapterId, targetId);
  assert.equal(after.chapters.length, 3, '插入不能被并发写覆盖');
});


test('记住上次章节：返回章节信息；不存在的 id 不写盘', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '上次章节测试');
  await storage.createChapter(bookPath, 1, '夜雨');
  const meta = await storage.readBookMeta(bookPath);
  const target = meta.chapters[1];

  const info = await storage.setLastOpenChapter(bookPath, target.id);
  assert.equal(info.ok, true);
  assert.equal(info.changed, true);
  assert.equal(info.title, '上次章节测试');
  assert.equal(info.chapterId, target.id);
  assert.equal(info.chapterIndex, 1);
  assert.equal(info.chapterName, '夜雨');
  const saved = await storage.readBookMeta(bookPath);
  assert.equal(saved.lastOpenChapterId, target.id);

  // 再记一次同一章：不重复写盘，changed = false（主进程可以据此少写配置）
  const again = await storage.setLastOpenChapter(bookPath, target.id);
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);

  // 不存在的章节 id：返回失败，书目里的 lastOpenChapterId 保持原值
  const bad = await storage.setLastOpenChapter(bookPath, 'ch_999');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'CHAPTER_NOT_FOUND');
  assert.equal(bad.chapterCount, 2);
  const afterBad = await storage.readBookMeta(bookPath);
  assert.equal(afterBad.lastOpenChapterId, target.id, '非法 id 不能覆盖已有记录');
});


test('拖拽排序：只改书目顺序，章节文件一个都不改名', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '排序书');
  let meta = await storage.readBookMeta(bookPath);
  const firstId = meta.chapters[0].id;
  await storage.createChapter(bookPath, 1, '第二章');
  await storage.createChapter(bookPath, 2, '第三章');
  meta = await storage.readBookMeta(bookPath);
  const filesBefore = meta.chapters.map((c) => c.file);
  const idsBefore = meta.chapters.map((c) => c.id);

  // 把第 3 章拖到最前
  const res = await storage.moveChapter(bookPath, idsBefore[2], 0);
  assert.equal(res.moved, true);
  assert.equal(res.from, 2);
  assert.equal(res.to, 0);
  const after = await storage.readBookMeta(bookPath);
  assert.deepEqual(after.chapters.map((c) => c.id), [idsBefore[2], idsBefore[0], idsBefore[1]]);
  assert.deepEqual(after.chapters.map((c) => c.file).sort(), filesBefore.slice().sort(), '文件名不能变');
  // 顺序颠倒后，原文件内容还跟着它自己的章节走
  await storage.saveChapterText(bookPath, after.chapters[0].file, '第三章的内容');
  const loaded = await storage.loadChapterText(bookPath, after.chapters[0].file);
  assert.equal(loaded.text, '第三章的内容');

  // 越界目标被夹住；原地移动返回 moved=false
  const clamped = await storage.moveChapter(bookPath, firstId, 999);
  assert.equal(clamped.to, after.chapters.length - 1);
  const noop = await storage.moveChapter(bookPath, firstId, clamped.to);
  assert.equal(noop.moved, false);
});


test('全书查找：跨章统计命中，返回上下文；只读不写盘', async () => {
  const root = await mkTmp();
  // TB-03：多章夹具统一走 makeBook
  const { bookPath } = await makeBook(root, '查找书', [
    { text: '阿明走进屋里。\n阿明坐下。' },
    { name: '第二章', text: '这里没有那个人。' },
    { name: '第三章', text: '阿明抬头看了看天。' }
  ]);

  const res = await storage.searchBook(bookPath, { query: '阿明' });
  assert.equal(res.totalMatches, 3);
  assert.equal(res.chapterCount, 2);
  assert.equal(res.results[0].count, 2);
  assert.equal(res.results[1].name, '第三章');
  assert.equal(res.results[0].matches[0].match, '阿明');
  assert.ok(res.results[0].matches[0].after.includes('走进'));

  const none = await storage.searchBook(bookPath, { query: '不存在的人' });
  assert.equal(none.totalMatches, 0);
  await assert.rejects(() => storage.searchBook(bookPath, { query: '  ' }), /不能为空/);
});


test('全书替换：先备份原文件到 _trash，再原子写盘并更新字数缓存', async () => {
  const root = await mkTmp();
  // TB-03：多章夹具统一走 makeBook
  const made = await makeBook(root, '替换书', [
    { text: '阿明说：阿明走了。' },
    { name: '第二章', text: '阿明回头。' }
  ]);
  const bookPath = made.bookPath;
  const meta = made.meta;
  const firstFile = meta.chapters[0].file;
  const secondFile = meta.chapters[1].file;

  const res = await storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' });
  assert.equal(res.chaptersChanged, 2);
  assert.equal(res.occurrences, 3);
  assert.ok(res.backupDir && res.backupDir.includes('替换备份-'));
  // 备份里是替换前的原文
  const backupText = await fs.readFile(path.join(res.backupDir, firstFile), 'utf8');
  assert.equal(backupText, '阿明说：阿明走了。');
  // 新内容已落盘（CRLF）
  const raw = await fs.readFile(path.join(bookPath, firstFile), 'utf8');
  assert.equal(raw, '小明说：小明走了。');
  assert.equal((await storage.loadChapterText(bookPath, secondFile)).text, '小明回头。');
  // 书目里的字数缓存跟着更新
  const updated = await storage.readBookMeta(bookPath);
  assert.equal(updated.chapters[0].chars, 9);
  assert.equal(updated.chapters[1].chars, 5);
  // 不命中的替换不产生备份目录
  const res2 = await storage.replaceInBook(bookPath, { query: '不存在', replacement: 'x' });
  assert.equal(res2.chaptersChanged, 0);
  assert.equal(res2.backupDir, null);
});


test('C4 / WP-05：单章命中超过上限时，整本查找 / 整本替换都如实回 truncated（不虚报全部完成）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '超限替换书');
  const meta = await storage.readBookMeta(bookPath);
  const file = meta.chapters[0].file;
  const many = '的'.repeat(MAX_MATCHES + 2);
  await storage.saveChapterText(bookPath, file, many);

  // 整本查找：总数只能报「至少 MAX_MATCHES」，并明确 truncated 与单章上限
  const found = await storage.searchBook(bookPath, { query: '的' });
  assert.equal(found.totalMatches, MAX_MATCHES);
  assert.equal(found.truncated, true);
  assert.equal(found.matchLimit, MAX_MATCHES);
  assert.equal(found.results[0].count, MAX_MATCHES);
  assert.equal(found.results[0].truncated, true);

  // 整本替换：只替换前 MAX_MATCHES 处（与查找看到的是同一批），但必须如实报告截断
  const res = await storage.replaceInBook(bookPath, { query: '的', replacement: '了' });
  assert.equal(res.chaptersChanged, 1);
  assert.equal(res.occurrences, MAX_MATCHES);
  assert.equal(res.truncated, true);
  assert.equal(res.chaptersTruncated, 1);
  assert.equal(res.matchLimit, MAX_MATCHES);
  const disk = (await storage.loadChapterText(bookPath, file)).text;
  assert.equal(disk.length, MAX_MATCHES + 2);
  assert.equal(disk.slice(0, MAX_MATCHES), '了'.repeat(MAX_MATCHES), '前 MAX_MATCHES 处已替换');
  assert.equal(disk.slice(MAX_MATCHES), '的的', '超上限的两处原样保留');
  // 被替换章的备份里仍是完整原文（10 秒撤销 / _trash 找回的语义不变）
  const backup = await fs.readFile(path.join(res.backupDir, file), 'utf8');
  assert.equal(backup, many);
  // 上限以内的书仍走精确口径（不因修复变得「永远说至少」）
  const smallBook = await storage.createBook(root, '未超限替换书');
  const smallMeta = await storage.readBookMeta(smallBook.path);
  await storage.saveChapterText(smallBook.path, smallMeta.chapters[0].file, '阿明来了。阿明走了。');
  const small = await storage.searchBook(smallBook.path, { query: '阿明' });
  assert.equal(small.totalMatches, 2);
  assert.equal(small.truncated, false);
  const smallReplace = await storage.replaceInBook(smallBook.path, { query: '阿明', replacement: '小明' });
  assert.equal(smallReplace.occurrences, 2);
  assert.equal(smallReplace.truncated, false);
  assert.equal(smallReplace.chaptersTruncated, 0);
});


test('替换备份：列出最近一次整本替换的备份（最近在前）', async () => {
  const root = await mkTmp();
  // TB-03：多章夹具统一走 makeBook
  const made = await makeBook(root, '备份列表书', [
    { text: '阿明来了。' },
    { name: '第二章', text: '阿明走了。' }
  ]);
  const bookPath = made.bookPath;
  const meta = made.meta;

  assert.deepEqual(await storage.listReplaceBackups(bookPath), [], '没替换过时没有备份');

  const first = await storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' });
  const list = await storage.listReplaceBackups(bookPath);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, path.basename(first.backupDir));
  assert.equal(list[0].fileCount, 2);
  assert.ok(list[0].totalBytes > 0);
  assert.deepEqual(
    list[0].files.slice().sort(),
    meta.chapters.map((chapter) => chapter.file).sort()
  );
});


test('替换备份（B6/WP-28）：列出时并发 stat，结果与串行版逐字段一致', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '并发备份书');
  const trash = path.join(bookPath, '_trash');
  // 手工造两个替换备份目录（每个 4 个章节副本），不启动真实替换链路
  const names = ['替换备份-2026-10-31-210000', '替换备份-2026-10-31-220000'];
  for (const name of names) {
    const dir = path.join(trash, name);
    await fs.mkdir(dir, { recursive: true });
    for (let i = 1; i <= 4; i += 1) {
      await fs.writeFile(path.join(dir, `00${i}-起风.txt`), `正文-${name}-${i}`, 'utf8');
    }
    await fs.writeFile(path.join(dir, '读我.md'), '不是章节', 'utf8'); // 非 .txt 不计
  }
  const serial = await storage.listReplaceBackups(bookPath, { concurrency: 1 });
  let active = 0;
  let peak = 0;
  const stat = async (target) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      return await fs.stat(target);
    } finally {
      active -= 1;
    }
  };
  const parallel = await storage.listReplaceBackups(bookPath, { stat, concurrency: 8 });
  assert.deepEqual(parallel, serial, '并发版结果与串行版逐字段一致');
  assert.equal(parallel.length, 2);
  assert.ok(parallel.every((item) => item.fileCount === 4), '非 .txt 不计入 fileCount');
  assert.ok(peak >= 2, `stat 应该并发（峰值 ${peak}）`);
  assert.ok(peak <= 8, `并发度不许超过上限（峰值 ${peak}）`);
});


test('替换备份：还原回替换前正文，并把当前内容再备份一份（可回头）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '还原书');
  const meta = await storage.readBookMeta(bookPath);
  const file0 = meta.chapters[0].file;
  await storage.saveChapterText(bookPath, file0, '阿明来了。');
  const replaced = await storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' });
  assert.equal((await storage.loadChapterText(bookPath, file0)).text, '小明来了。');

  const backupName = path.basename(replaced.backupDir);
  const res = await storage.restoreReplaceBackup(bookPath, backupName);
  assert.equal(res.restored, 1);
  assert.equal(res.skipped, 0);
  assert.equal((await storage.loadChapterText(bookPath, file0)).text, '阿明来了。');
  // 还原前把「替换后」的内容也备份了一份，点错了还能找回
  assert.ok(res.restoreBackupDir && res.restoreBackupDir.includes('还原前备份-'));
  const safety = await fs.readFile(path.join(res.restoreBackupDir, file0), 'utf8');
  assert.equal(safety, '小明来了。');
  // 字数缓存跟着还原后的正文更新
  const updated = await storage.readBookMeta(bookPath);
  assert.equal(updated.chapters[0].chars, 5);
  // 原替换备份还在（不消耗），可以再还原；还原前备份不算「替换备份」
  const list = await storage.listReplaceBackups(bookPath);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, backupName);
});


test('替换备份：非法目录名 / 不存在的备份 / 已删章节都被安全处理', async () => {
  const root = await mkTmp();
  // TB-03：多章夹具统一走 makeBook
  const made = await makeBook(root, '安全书', [{ text: '阿明一。' }, { name: '第二章', text: '阿明二。' }]);
  const bookPath = made.bookPath;
  const meta = made.meta;
  const replaced = await storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' });
  const backupName = path.basename(replaced.backupDir);

  await assert.rejects(
    () => storage.restoreReplaceBackup(bookPath, `../${backupName}`),
    /不合法|不存在/
  );
  await assert.rejects(() => storage.restoreReplaceBackup(bookPath, '替换备份-2099'), /不存在/);

  // 删掉第二章后再还原：只还原还在书里的章节，已删章节跳过（不偷偷复活）
  await storage.deleteChapter(bookPath, meta.chapters[1].id);
  const res = await storage.restoreReplaceBackup(bookPath, backupName);
  assert.equal(res.restored, 1);
  assert.equal(res.skipped, 1);
  assert.equal((await storage.loadChapterText(bookPath, meta.chapters[0].file)).text, '阿明一。');
});

// WP-20（审计 C19）：可还原集合以前直接照搬 meta.chapters[].file，而 validateMeta 只查
// 「非空字符串」。坏书目的 file=「书目.json」能通过，备份目录里手工放一份同名文件，
// 还原就会把书目本身原子覆盖（实测 v1.7.2 会写成伪造内容，并留下「还原前备份」）。


test('替换备份还原（C19）：坏书目 file=书目.json 不会被还原覆盖，书目字节一个都不变', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '坏书目光目');
  const baseMeta = await storage.readBookMeta(bookPath);
  const file0 = baseMeta.chapters[0].file;
  await storage.saveChapterText(bookPath, file0, '阿明来了。');
  const replaced = await storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' });
  const backupName = path.basename(replaced.backupDir);

  // 坏书目：第 1 章 file 改成书目.json（validateMeta 只查非空字符串，会放行）
  const badMeta = {
    ...baseMeta,
    chapters: baseMeta.chapters.map((chapter) => ({ ...chapter, file: '书目.json' }))
  };
  const metaPath = path.join(bookPath, '书目.json');
  await fs.writeFile(metaPath, JSON.stringify(badMeta, null, 2), 'utf8');
  const metaBefore = await fs.readFile(metaPath, 'utf8');
  // 备份目录里手放一份同名文件（真实替换不会产生这种条目）
  const planted = '{"title":"这份内容不该写进书里"}';
  await fs.writeFile(path.join(bookPath, '_trash', backupName, '书目.json'), planted, 'utf8');

  await assert.rejects(
    () => storage.restoreReplaceBackup(bookPath, backupName),
    (err) => ['BACKUP_NO_TARGET', 'BAD_PATH'].includes(err.code)
  );
  assert.equal(await fs.readFile(metaPath, 'utf8'), metaBefore, '书目一个字节都不许变');
  assert.equal((await storage.loadChapterText(bookPath, file0)).text, '小明来了。', '章节正文也不许被写');
  // 一个字节都没写：不建「还原前备份」，替换备份里的文件也原样
  const trashNames = await fs.readdir(path.join(bookPath, '_trash'));
  assert.deepEqual(trashNames.filter((name) => name.startsWith('还原前备份-')), []);
  assert.equal(
    await fs.readFile(path.join(bookPath, '_trash', backupName, '书目.json'), 'utf8'),
    planted,
    '备份文件只供查看，不许被消耗'
  );
});


test('替换备份还原（C19）：系统保留名不会被写进书，书目字节不变', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '保留名还原');
  const baseMeta = await storage.readBookMeta(bookPath);
  const badMeta = {
    ...baseMeta,
    chapters: baseMeta.chapters.map((chapter) => ({ ...chapter, file: 'nul.txt' }))
  };
  const metaPath = path.join(bookPath, '书目.json');
  await fs.writeFile(metaPath, JSON.stringify(badMeta, null, 2), 'utf8');
  const metaBefore = await fs.readFile(metaPath, 'utf8');
  // 审计勘误 E1 实测：Node 用扩展路径前缀能把 nul.txt 落成普通文件，所以这条能真的造出来
  const backupName = '替换备份-20991231235958';
  const backupDir = path.join(bookPath, '_trash', backupName);
  await fs.mkdir(backupDir, { recursive: true });
  await fs.writeFile(path.join(backupDir, 'nul.txt'), '保留名内容', 'utf8');

  await assert.rejects(
    () => storage.restoreReplaceBackup(bookPath, backupName),
    (err) => ['BACKUP_NO_TARGET', 'BAD_PATH'].includes(err.code)
  );
  assert.equal(await fs.readFile(metaPath, 'utf8'), metaBefore);
  assert.equal((await fs.readdir(bookPath)).includes('nul.txt'), false, '保留名不许被写进书');
  const trashNames = await fs.readdir(path.join(bookPath, '_trash'));
  assert.deepEqual(trashNames.filter((name) => name.startsWith('还原前备份-')), []);
});


test('替换备份还原（C19）：坏章记录被跳过，正常章照常还原，书目不被伪造内容覆盖', async () => {
  const root = await mkTmp();
  // TB-03：多章夹具统一走 makeBook
  const made = await makeBook(root, '混合坏书目', [
    { text: '阿明一。' },
    { name: '第二章', text: '这里没有那个人。' }
  ]);
  const bookPath = made.bookPath;
  const baseMeta = made.meta;
  const [file0, file1] = baseMeta.chapters.map((chapter) => chapter.file);
  const replaced = await storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' });
  const backupName = path.basename(replaced.backupDir);

  // 只有第 2 章的 file 是坏的：第 1 章必须照常能还原，坏记录原样留着等修复流程
  const badMeta = {
    ...baseMeta,
    chapters: baseMeta.chapters.map((chapter, i) => (i === 1 ? { ...chapter, file: '书目.json' } : chapter))
  };
  const metaPath = path.join(bookPath, '书目.json');
  await fs.writeFile(metaPath, JSON.stringify(badMeta, null, 2), 'utf8');
  const planted = '{"title":"伪造书目"}';
  await fs.writeFile(path.join(bookPath, '_trash', backupName, '书目.json'), planted, 'utf8');

  const res = await storage.restoreReplaceBackup(bookPath, backupName);
  assert.equal(res.restored, 1, '只有第一章可还原');
  assert.equal(res.skipped, 1, '书目.json 不是章节文件，必须跳过');
  assert.equal((await storage.loadChapterText(bookPath, file0)).text, '阿明一。', '正常章照常还原');
  assert.equal((await storage.loadChapterText(bookPath, file1)).text, '这里没有那个人。', '没参与替换的第二章一个字节没动');
  const onDisk = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  assert.equal(onDisk.title, '混合坏书目', '书目没被备份目录里的伪造内容覆盖');
  assert.equal(onDisk.chapters.length, 2);
  assert.equal(onDisk.chapters[1].file, '书目.json', '坏章记录原样留着，等修复流程处理');
  assert.equal(await fs.readFile(path.join(bookPath, '_trash', backupName, '书目.json'), 'utf8'), planted);
});


test('整本排版：预检查只算不写，正式整理逐章写盘并备份原文', async () => {
  const root = await mkTmp();
  // TB-03：多章夹具统一走 makeBook
  const made = await makeBook(root, '整本排版书', [
    { text: '他说,"第一段。"' },
    { name: '第二章', text: '第二段' },
    { name: '第三章', text: '　　已经整理好的。' }
  ]);
  const bookPath = made.bookPath;
  const meta = made.meta;

  const options = { indent: '2', blankLines: 'single', trimTrailing: true, normalizePunct: true };

  // 预检查：只读
  const preview = await storage.previewFormatBook(bookPath, options);
  assert.equal(preview.chapterCount, 3);
  assert.equal(preview.chaptersChanged, 2);
  assert.deepEqual(preview.changed.map((item) => item.index), [0, 1]);
  assert.equal(preview.stats.indentFixed, 2);
  assert.equal(
    (await fs.readFile(path.join(bookPath, meta.chapters[0].file), 'utf8')),
    '他说,"第一段。"',
    '预检查不能写盘'
  );

  // 正式整理：逐章写盘 + 备份
  const progressLog = [];
  const res = await storage.formatBook(bookPath, options, (progress) => progressLog.push(progress.done));
  assert.equal(res.chaptersChanged, 2);
  assert.ok(res.backupDir && res.backupDir.includes('整理备份-'));
  assert.deepEqual(progressLog, [1, 2, 3]);
  // 原文备份：整理前的内容
  const backupText = await fs.readFile(path.join(res.backupDir, meta.chapters[0].file), 'utf8');
  assert.equal(backupText, '他说,"第一段。"');
  await assert.rejects(
    () => fs.access(path.join(res.backupDir, meta.chapters[2].file)),
    '没改动的章节不进备份'
  );
  // 写盘结果
  assert.equal((await storage.loadChapterText(bookPath, meta.chapters[0].file)).text, '　　他说，"第一段。"');
  assert.equal((await storage.loadChapterText(bookPath, meta.chapters[1].file)).text, '　　第二段');
  assert.equal((await storage.loadChapterText(bookPath, meta.chapters[2].file)).text, '　　已经整理好的。');
  // 字数缓存跟着更新
  const updated = await storage.readBookMeta(bookPath);
  assert.equal(updated.chapters[0].chars, 9);
  assert.equal(updated.chapters[1].chars, 3);
  // 再整理一次：没有改动，不弹备份目录也不需要
  const again = await storage.formatBook(bookPath, options);
  assert.equal(again.chaptersChanged, 0);
  assert.equal(again.backupDir, null);
});


test('整本排版：缺文件的章节跳过，不中断整本整理', async () => {
  const root = await mkTmp();
  // TB-03：多章夹具统一走 makeBook
  const made = await makeBook(root, '缺文件排版书', [{ text: '第一段' }, { name: '第二章', text: '第二段' }]);
  const bookPath = made.bookPath;
  const meta = made.meta;
  await fs.unlink(path.join(bookPath, meta.chapters[1].file));

  const res = await storage.formatBook(bookPath, {
    indent: '2',
    blankLines: 'keep',
    trimTrailing: true,
    normalizePunct: true
  });
  assert.equal(res.chaptersChanged, 1);
  assert.equal((await storage.loadChapterText(bookPath, meta.chapters[0].file)).text, '　　第一段');
});


test('字数缓存合并：只补缺 chars 的章，别人新增的章不被覆盖、已删的章跳过', () => {
  const fresh = {
    chapters: [
      { id: 'ch_a', file: '001-a.txt', chars: 5 },
      { id: 'ch_c', file: '003-c.txt' } // 读缓存之后才新建的章
    ]
  };
  const cached = [
    { id: 'ch_a', file: '001-a.txt', chars: 999 }, // 已有缓存，不覆盖
    { id: 'ch_b', file: '002-b.txt', chars: 7 },   // 已经被删掉了，跳过
    { id: 'ch_c', file: '003-c.txt', chars: 11 }   // 补上
  ];
  const merged = storage.mergeCharsCache(fresh, cached);
  assert.equal(merged.changed, true);
  assert.equal(merged.meta.chapters.length, 2, '不能因为合并把新章挤掉');
  assert.equal(merged.meta.chapters[0].chars, 5);
  assert.equal(merged.meta.chapters[1].chars, 11);
});


test('字数缓存合并：没有需要补的章时不算改动', () => {
  const fresh = { chapters: [{ id: 'ch_a', file: '001-a.txt', chars: 5 }] };
  const merged = storage.mergeCharsCache(fresh, [{ id: 'ch_a', file: '001-a.txt', chars: 5 }]);
  assert.equal(merged.changed, false);
});


test('书架扫描补字数不会丢掉同时新建的章节（锁内重读 + 合并）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '并发测试');
  // 造一本「老版本」书：书目里没有 chars 缓存，扫描时才会触发写回
  const meta0 = await storage.readBookMeta(bookPath);
  const legacy = {
    ...meta0,
    chapters: meta0.chapters.map((chapter) => ({ id: chapter.id, file: chapter.file, name: chapter.name }))
  };
  await storage.writeBookMeta(bookPath, legacy);

  for (let i = 1; i <= 8; i += 1) {
    await Promise.all([
      storage.listBooks(root),
      storage.createChapter(bookPath, 999, `并发新章${i}`)
    ]);
  }
  await storage.listBooks(root); // 再扫一次，把最后一轮新建章的字数补上
  const meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters.length, 9, '每轮新建的章都必须还在');
  assert.ok(meta.chapters.every((chapter) => Number.isFinite(chapter.chars)), '扫描后字数缓存应已补齐');
});


test('分卷：新建 / 改名 / 删除卷；删卷不删章、章节文件不动', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '分卷测试');
  // 加两章，并把它们放进新建的卷
  const created1 = await storage.createVolume(bookPath, '第1卷：单篇');
  assert.equal(created1.volume.name, '第1卷：单篇');
  assert.equal(created1.meta.volumes.length, 1);
  const chapter2 = await storage.createChapter(bookPath, 999, '第二篇', created1.volume.id);
  assert.equal(chapter2.chapter.volumeId, created1.volume.id);

  const renamed = await storage.renameVolume(bookPath, created1.volume.id, '第1卷：改名');
  assert.equal(renamed.meta.volumes[0].name, '第1卷：改名');

  const filesBefore = (await fs.readdir(bookPath)).filter((f) => f.endsWith('.txt')).sort();
  const deleted = await storage.deleteVolume(bookPath, created1.volume.id);
  assert.equal(deleted.meta.volumes.length, 0);
  // N-03：旧返回值的 movedChapters 统计的是「全书未分卷章节总数」而不是本次移出数，且无人消费 —— 已删除该死字段。
  assert.equal('movedChapters' in deleted, false, '删卷结果不再返回语义错误的 movedChapters');
  assert.ok(deleted.meta.chapters.every((c) => !c.volumeId), '卷里的章应该回落到未分卷');
  assert.equal(deleted.meta.chapters.length, chapter2.meta.chapters.length, '删卷不能删章');
  const filesAfter = (await fs.readdir(bookPath)).filter((f) => f.endsWith('.txt')).sort();
  assert.deepEqual(filesAfter, filesBefore, '删卷不能动章节文件');
});


test('分卷：新建章节可以直接放进指定卷，并排在该卷末尾', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '分卷排序');
  const v1 = (await storage.createVolume(bookPath, '卷A')).volume;
  const v2 = (await storage.createVolume(bookPath, '卷B')).volume;
  await storage.createChapter(bookPath, 999, 'A1', v1.id);
  await storage.createChapter(bookPath, 999, 'B1', v2.id);
  await storage.createChapter(bookPath, 999, 'A2', v1.id); // 即便传 999，也应插到卷 A 末尾
  const meta = await storage.readBookMeta(bookPath);
  assert.deepEqual(meta.chapters.map((c) => c.name), ['', 'A1', 'A2', 'B1']);
  assert.deepEqual(meta.chapters.map((c) => c.volumeId || null), [null, v1.id, v1.id, v2.id]);
});


test('分卷：把章移到别的卷后按卷重排，章文件不变', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '移卷');
  const v1 = (await storage.createVolume(bookPath, '卷A')).volume;
  const v2 = (await storage.createVolume(bookPath, '卷B')).volume;
  await storage.createChapter(bookPath, 999, 'A1', v1.id);
  const b1 = await storage.createChapter(bookPath, 999, 'B1', v2.id);
  const moved = await storage.moveChapterToVolume(bookPath, b1.chapter.id, v1.id);
  assert.equal(moved.meta.chapters.filter((c) => c.volumeId === v1.id).length, 2);
  assert.equal(moved.meta.chapters.filter((c) => c.volumeId === v2.id).length, 0);
  const back = await storage.moveChapterToVolume(bookPath, b1.chapter.id, null);
  // 移回未分卷后，未分卷组排在最前面（组内保持相对顺序）
  const orphanIds = back.meta.chapters.filter((c) => !c.volumeId).map((c) => c.id);
  assert.ok(orphanIds.includes(b1.chapter.id), '移回未分卷的章应在未分卷组里');
  assert.deepEqual(back.meta.chapters.slice(0, orphanIds.length).map((c) => c.id), orphanIds);
  const files = (await fs.readdir(bookPath)).filter((f) => f.endsWith('.txt'));
  assert.ok(files.includes(b1.chapter.file), '移卷不重命名章节文件');
});


test('分卷：书目里章节乱序或指向不存在的卷，读取时会归一', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '归一');
  const metaPath = path.join(bookPath, '书目.json');
  const raw = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  raw.volumes = [{ id: 'v_001', name: '卷A' }];
  raw.chapters = [
    { id: 'c1', file: raw.chapters[0].file, name: '卷一', volumeId: 'v_001' },
    // META-01 起「两章共用一个 file」按 INVALID_META 拒绝；这条用例只验分卷归一，
    // 给第二条一个不同的合法文件名即可（不要求文件真的存在，readBookMeta 不 stat 章节）。
    { id: 'c2', file: '002-孤儿.txt', name: '孤儿', volumeId: 'v_404' }
  ];
  await fs.writeFile(metaPath, JSON.stringify(raw), 'utf8');
  const meta = await storage.readBookMeta(bookPath);
  assert.deepEqual(meta.chapters.map((c) => c.name), ['孤儿', '卷一']);
  // CSTO-B-05：回未分卷的章节不再留 `volumeId: null` 字段（读盘归一即删）
  assert.equal(Object.prototype.hasOwnProperty.call(meta.chapters[0], 'volumeId'), false);
  assert.equal(meta.chapters[0].volumeId, undefined);
  assert.equal(meta.chapters[1].volumeId, 'v_001');
});


test('分卷：卷上下移动会落盘，章节跟着卷重排', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '卷排序');
  const v1 = (await storage.createVolume(bookPath, '卷A')).volume;
  const v2 = (await storage.createVolume(bookPath, '卷B')).volume;
  await storage.createChapter(bookPath, 999, 'A1', v1.id);
  await storage.createChapter(bookPath, 999, 'B1', v2.id);
  const moved = await storage.moveVolume(bookPath, v2.id, 0);
  assert.equal(moved.moved, true);
  const meta = await storage.readBookMeta(bookPath);
  assert.deepEqual(meta.volumes.map((v) => v.name), ['卷B', '卷A']);
  assert.deepEqual(meta.chapters.map((c) => c.name), ['', 'B1', 'A1']);
});


test('分卷：moveChapterTo 可以跨卷插到指定章节之前，也可以落到卷末', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '跨卷拖拽');
  const v1 = (await storage.createVolume(bookPath, '卷A')).volume;
  const v2 = (await storage.createVolume(bookPath, '卷B')).volume;
  const a1 = await storage.createChapter(bookPath, 999, 'A1', v1.id);
  const a2 = await storage.createChapter(bookPath, 999, 'A2', v1.id);
  const b1 = await storage.createChapter(bookPath, 999, 'B1', v2.id);

  // 把 A2 插到 B1 之前（跨卷）
  const beforeB1 = await storage.moveChapterTo(bookPath, a2.chapter.id, v2.id, b1.chapter.id);
  let meta = await storage.readBookMeta(bookPath);
  assert.deepEqual(meta.chapters.map((c) => c.name), ['', 'A1', 'A2', 'B1']);
  assert.equal(meta.chapters.find((c) => c.id === a2.chapter.id).volumeId, v2.id);
  assert.ok(beforeB1.meta.chapters.findIndex((c) => c.id === a2.chapter.id) < beforeB1.meta.chapters.findIndex((c) => c.id === b1.chapter.id));

  // 把 A1 落到卷 B 末尾
  await storage.moveChapterTo(bookPath, a1.chapter.id, v2.id, null);
  meta = await storage.readBookMeta(bookPath);
  assert.deepEqual(meta.chapters.map((c) => c.name), ['', 'A2', 'B1', 'A1']);
  assert.equal(meta.chapters.filter((c) => c.volumeId === v2.id).length, 3);

  // 移回未分卷
  await storage.moveChapterTo(bookPath, a1.chapter.id, null, null);
  meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters.filter((c) => !c.volumeId).length, 2, '移回未分卷后应该有两章在未分卷组');
});


test('章号编号方式：按卷独立写进书目.json，改回连续删字段；旧书没有字段 = 连续', async () => {
  const chapters = require('../core/chapters');
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '编号演练');
  const created = await storage.readBookMeta(bookPath);
  await storage.renameChapter(bookPath, created.chapters[0].id, '起风');
  const v1 = await storage.createVolume(bookPath, '卷一');
  const v2 = await storage.createVolume(bookPath, '卷二');
  // 卷一：起风 + 夜雨；卷二：渡口
  await storage.moveChapterToVolume(bookPath, created.chapters[0].id, v1.volume.id);
  const second = await storage.createChapterWithText(bookPath, {
    insertIndex: 1, name: '夜雨', text: 'x', volumeId: v1.volume.id
  });
  await storage.createChapterWithText(bookPath, {
    insertIndex: 2, name: '渡口', text: 'y', volumeId: v2.volume.id
  });
  let meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapterNumbering, undefined, '旧书 / 默认没有这个字段');
  assert.deepEqual(meta.chapters.map((_, i) => chapters.chapterNumber(meta, i)), [1, 2, 3]);

  const set = await storage.setChapterNumbering(bookPath, 'volume');
  assert.equal(set.numbering, 'volume');
  assert.equal(set.changed, true);
  meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapterNumbering, 'volume');
  assert.deepEqual(meta.chapters.map((_, i) => chapters.chapterNumber(meta, i)), [1, 2, 1]);
  assert.equal(chapters.formatTitle(meta, 2, '渡口'), '第1章：渡口');
  const disk = JSON.parse(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'));
  assert.equal(disk.chapterNumbering, 'volume');

  const again = await storage.setChapterNumbering(bookPath, 'volume');
  assert.equal(again.changed, false, '同值再存不写盘');

  const back = await storage.setChapterNumbering(bookPath, 'continuous');
  assert.equal(back.numbering, 'continuous');
  meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapterNumbering, undefined);
  assert.equal(chapters.formatTitle(meta, 2, '渡口'), '第3章：渡口');
  const disk2 = JSON.parse(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'));
  assert.equal('chapterNumbering' in disk2, false, '连续模式不留字段');
  assert.equal(second.chapter.name, '夜雨');
});

// ---------- 1.6.0 H6（审计 E-05）：章节加载的 128 MB 大小闸门 ----------
// 旧实现 loadChapterText() / statChapter() 直接 stat → readFile：一个被外部换成超大文件的
// 章节（或坏掉的同步盘）在点开 / 切过去时会被整份读进内存（128 MB+ 直接顶爆主进程）。
// 还原 / 快照侧已有 readSizeProblem 闸门（P2-3），章节加载这里统一复用同一条口径。


test('章节加载：超过 128 MB 的章节明确报 CHAPTER_TOO_LARGE，且不读进内存（稀疏文件）', async () => {
  const root = await mkTmp();
  const { path: bookPath, meta } = await storage.createBook(root, '巨大章节');
  const file = meta.chapters[0].file;
  const hugePath = path.join(bookPath, file);
  const handle = await fs.open(hugePath, 'r+');
  try {
    await handle.truncate(storage.MAX_CHAPTER_READ_BYTES + 1024); // 稀疏文件：只改大小，不真写 128 MB
  } finally {
    await handle.close();
  }
  // TB-04：读盘计数器统一走 countReadFileFor（超限章一旦真被读就立刻抛错，不在断言失败路径
  // 真分配 129 MB）。以前这里另抄了一份「只计数、不拦截」的简版。
  const counter = countReadFileFor(hugePath);
  try {
    await assert.rejects(
      () => storage.loadChapterText(bookPath, file),
      (err) => {
        assert.equal(err.code, 'CHAPTER_TOO_LARGE');
        assert.match(err.message, /超过单文件读取上限/);
        assert.match(err.message, /128 MB/);
        assert.match(err.message, /没有读进内存/);
        assert.equal(err.message.includes(bookPath), false, '错误文案不能带本机完整路径');
        return true;
      }
    );
    assert.equal(counter.hugeReads(), 0, '超限章节必须在 stat 之后就拒绝，不能走进 readFile');
    await assert.rejects(
      () => storage.statChapter(bookPath, file),
      (err) => err.code === 'CHAPTER_TOO_LARGE'
    );
  } finally {
    counter.restore();
  }
});


test('章节加载：正常章节的 text / mtimeMs / size 三字段不变', async () => {
  const root = await mkTmp();
  const { path: bookPath, meta } = await storage.createBook(root, '正常章节');
  const file = meta.chapters[0].file;
  await storage.saveChapterText(bookPath, file, '第一行\n第二行\n');
  const onDisk = await fs.stat(path.join(bookPath, file));
  const loaded = await storage.loadChapterText(bookPath, file);
  assert.equal(loaded.text, '第一行\n第二行\n');
  assert.equal(loaded.mtimeMs, onDisk.mtimeMs);
  assert.equal(loaded.size, onDisk.size);
  const statOnly = await storage.statChapter(bookPath, file);
  assert.equal(statOnly.mtimeMs, onDisk.mtimeMs);
  assert.equal(statOnly.size, onDisk.size);
  assert.deepEqual(Object.keys(statOnly).sort(), ['mtimeMs', 'size']);
});

// ---------- 书架扫描只读化（1.6.0 A2 / 审计 E-06） ----------
// 书架扫描只是为了补 chars 缓存：**不许改 updatedAt**（改了就等于「打开书架」把书往前挪、
// 也会让同步工具以为书目被改过）。缺字数的章节用 8 路并发读，老书首次扫描别再串行 1000 次。


test('替换备份还原：还原 1 章只重算这 1 章（注入 reader 计数）', async () => {
  const root = await mkTmp();
  // TB-03：多章夹具统一走 makeBook
  const made = await makeBook(root, '还原只读书', [
    { text: '阿明来了。' },
    { name: '第二章' },
    { name: '第三章' }
  ]);
  const bookPath = made.bookPath;
  const meta = made.meta;
  const firstFile = meta.chapters[0].file;
  assert.equal(meta.chapters.length, 3, '书里有 3 章，还原只碰 1 章');

  // 手工造一个只含 1 章的替换备份（真实备份目录只放被替换的那些章）
  const backupName = '替换备份-20991231235959';
  const backupDir = path.join(bookPath, '_trash', backupName);
  await fs.mkdir(backupDir, { recursive: true });
  await fs.writeFile(path.join(backupDir, firstFile), '阿明走了。', 'utf8');

  const counted = [];
  const res = await storage.restoreReplaceBackup(bookPath, backupName, {
    readText: async (targetBookPath, chapter) => {
      counted.push(chapter.file);
      return '四个汉字';
    }
  });
  assert.equal(res.restored, 1);
  assert.deepEqual(counted, [firstFile], '只重算被还原的那一章，另外两章不许读');
  const after = await storage.readBookMeta(bookPath);
  assert.equal(after.chapters.find((chapter) => chapter.file === firstFile).chars, 4);
});


test('整本操作：一章 129 MB 超限章 + 两章正常 → 查找 / 替换跳过超限章、skippedTooLarge=1、正常章结果逐字不变', async () => {
  const root = await mkTmp();
  // TB-03：多章夹具统一走 makeBook
  const made = await makeBook(root, '整本超限', [
    { text: '阿明走进灯下。\n阿明抬头。' },
    { name: '第二章', text: '阿明转身离开。' },
    { name: '第三章', text: '这里没有那个人。' }
  ]);
  const bookPath = made.bookPath;
  const meta = made.meta;

  // 对照组：三章都正常读完
  const control = await storage.searchBook(bookPath, { query: '阿明' });
  assert.equal(control.skippedTooLarge, 0);
  assert.equal(control.totalMatches, 3);

  // 把第二章换成 129 MB 稀疏文件：只改大小，不真写 128 MB
  const handle = await fs.open(path.join(bookPath, meta.chapters[1].file), 'r+');
  await handle.truncate(storage.MAX_CHAPTER_READ_BYTES + 1024);
  await handle.close();

  const res = await storage.searchBook(bookPath, { query: '阿明' });
  assert.equal(res.skippedTooLarge, 1, '超限章单独累计，不能被当成缺章');
  assert.equal(res.totalMatches, control.totalMatches - 1);
  assert.deepEqual(res.results, control.results.filter((row) => row.name !== '第二章'));

  // 整本替换同口径：跳过超限章、其余章结果逐字不变
  const replaced = await storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' });
  assert.equal(replaced.skippedTooLarge, 1);
  assert.equal(replaced.chaptersChanged, 1);
  assert.equal(replaced.occurrences, 2);
  const ch1 = await storage.loadChapterText(bookPath, meta.chapters[0].file);
  assert.equal(ch1.text, '小明走进灯下。\n小明抬头。');
});

// E7（v1.8.0 WP-11 / 审计 E7）：读盘失败的原始 message 带完整本机路径（EACCES 形如
// `EACCES: permission denied, open 'D:\…\书目.json'`），以前 readBookMeta 原样 throw、
// listBooks 直接把 err.message 塞进损坏书卡的 reason，路径就跟着 IPC 回包进了书架。
// 真实 EACCES 不好在 Windows 上稳定造（ACL 会污染环境），这里把 fs.open 换成「只对书目.json 抛」。
// CSTO-A02 起读侧走 open → fstat → handle.readFile 的同句柄口径，拦截点也跟着落在 open 上
// （与生产一致：打不开文件就不会有半份内容进内存）。


test('五-M33（IE-02）：只读长流程租约拦删除不拦保存，释放 / 重复释放幂等', () => {
  const bookPath = 'D:\\书库\\导出的书';
  assert.equal(storage.isBookReadLeased(bookPath), false);
  const releaseA = storage.beginReadLease(bookPath);
  assert.equal(storage.isBookReadLeased(bookPath), true);
  assert.throws(
    () => storage.assertBookNotBusy(bookPath, 'win-1', 'delete'),
    (err) =>
      err.code === 'READ_LEASE_BUSY' &&
      /正在被只读长流程使用/.test(err.message) &&
      /导出的书/.test(err.message) &&
      !err.message.includes('D:\\书库')
  );
  assert.doesNotThrow(() => storage.assertBookNotBusy(bookPath, 'win-1', 'save'), '保存不受租约影响');
  assert.doesNotThrow(() => storage.assertBookNotBusy(bookPath, 'win-1', 'format'), '整理不受租约影响');

  // 同一本书并发两段只读流程：都结束后才允许删除
  const releaseB = storage.beginReadLease(bookPath);
  releaseA();
  assert.equal(storage.isBookReadLeased(bookPath), true, '还有一段在途');
  releaseA(); // 幂等：重复释放不多减
  assert.equal(storage.isBookReadLeased(bookPath), true);
  releaseB();
  assert.equal(storage.isBookReadLeased(bookPath), false);
  assert.doesNotThrow(() => storage.assertBookNotBusy(bookPath, 'win-1', 'delete'));

  // 大小写 / 斜杠写法等价（pathKey 口径）：同一本书的两种写法共享同一份计数
  const lower = storage.beginReadLease('d:/书库/导出的书');
  assert.equal(storage.isBookReadLeased(bookPath), true);
  lower();
  assert.equal(storage.isBookReadLeased(bookPath), false, '同一本书的两种路径写法应落在同一个 key 上');
});

// CSTO-A04：书内 rename（删章 / 撤销删除 / 删书）与保存链路同一套瞬时失败重试——
// 杀软 / 同步盘短暂占用文件时自动重试，不把「可重试」报成删除失败。


test('CSTO-A04：删章 / 删书的 rename 走 renameWithRetry，瞬态 EPERM 自动重试', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '重试删除');
  await storage.createChapter(bookPath, 1, '待删');
  let meta = await storage.readBookMeta(bookPath);
  const target = meta.chapters[1];
  const real = fs.rename;
  const fails = { trash: 2 };
  const patched = async (from, to) => {
    if (String(to).includes('_trash') && fails.trash > 0) {
      fails.trash -= 1;
      throw Object.assign(new Error('EPERM: 模拟杀软瞬时占用'), { code: 'EPERM' });
    }
    return real.call(fs, from, to);
  };
  Object.defineProperty(fs, 'rename', { value: patched, configurable: true, writable: true });
  try {
    const res = await storage.deleteChapter(bookPath, target.id);
    assert.ok(res.trashPath.includes('_trash'), '瞬态 EPERM 之后删章成功（不是直接报 TRASH_FAILED）');
    assert.equal(fails.trash, 0, '两次失败都被 renameWithRetry 重试掉了');
  } finally {
    Object.defineProperty(fs, 'rename', { value: real, configurable: true, writable: true });
  }
  meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters.length, 1);

  // 删书（trashBook）也走同一套重试
  const second = await storage.createBook(root, '待删的书');
  fails.trash = 2;
  Object.defineProperty(fs, 'rename', { value: patched, configurable: true, writable: true });
  try {
    const dest = await storage.trashBook(root, second.path);
    assert.ok(dest.includes('_trash'), '瞬态 EPERM 之后删书成功');
    assert.equal(fails.trash, 0);
  } finally {
    Object.defineProperty(fs, 'rename', { value: real, configurable: true, writable: true });
  }
});

// ---------- 三审 P1 / E1 / I5：体量上限的唯一事实源落到 storage 写 / 读边界 ----------

// P1（三审·高）：128 MB 字节闸门拦不住字符数 —— 纯 ASCII 的 128 MB 文件解码后是 1.28 亿字符，
// 整份经 IPC 塞进编辑区会把渲染层拖到假死。这里补与保存 / 救稿同源的字数硬上限；
// maxChars 只给单测注入小上限，生产调用一律用 core/limits.js 的默认值。


test('P1：loadChapterText 单章字数硬上限（CHAPTER_TOO_LARGE，不把超长章带进编辑区）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '载入上限');
  const meta = await storage.readBookMeta(bookPath);
  const file = meta.chapters[0].file;
  await storage.saveChapterText(bookPath, file, '字'.repeat(40));

  const ok = await storage.loadChapterText(bookPath, file, { maxChars: 40 });
  assert.equal(ok.text.length, 40, '正好上限放行');
  await assert.rejects(
    () => storage.loadChapterText(bookPath, file, { maxChars: 39 }),
    (err) => {
      assert.equal(err.code, 'CHAPTER_TOO_LARGE');
      assert.match(err.message, /40 字/);
      assert.match(err.message, /39 字/);
      assert.match(err.message, /没有载入编辑区/);
      assert.equal(err.message.includes(bookPath), false, '错误文案不能带本机完整路径');
      return true;
    }
  );
  // 默认值就是 core/limits.js 那条线（比保存上限宽：能打开才能救稿）
  assert.ok(limits.MAX_CHAPTER_READ_CHARS > limits.MAX_CHAPTER_SAVE_CHARS);
  const normal = await storage.loadChapterText(bookPath, file);
  assert.equal(normal.text.length, 40, '正常小章不受影响');
});

// E1（三审·中）：写侧也过和读侧同一条章数闸门 —— 旧实现只校验 32 MB 文件大小，
// 20,001 章的书目能写盘、读侧直接判损坏，应用自己写出一本打不开的书。
