const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const storage = require('../core/storage');
const { atomicWriteFile } = require('../core/atomic');

const tmpCleanup = require('./tmp-cleanup');

async function mkTmp(prefix = 'cw-test-') {
  return tmpCleanup.track(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

test('createBook：建文件夹、初始空章、合法书目', async () => {
  const root = await mkTmp();
  const { path: bookPath, meta } = await storage.createBook(root, '星海旅人');
  assert.equal(meta.title, '星海旅人');
  assert.equal(meta.chapters.length, 1);
  assert.equal(meta.fileSeq, 1);
  const files = (await fs.readdir(bookPath)).sort();
  assert.deepEqual(files, ['001-未命名.txt', '书目.json']);
  const metaOnDisk = JSON.parse(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'));
  assert.equal(metaOnDisk.chapters[0].file, '001-未命名.txt');
});

test('createBook：同名自动加后缀，空书名兜底', async () => {
  const root = await mkTmp();
  const a = await storage.createBook(root, '草稿');
  const b = await storage.createBook(root, '草稿');
  const c = await storage.createBook(root, '   ');
  assert.notEqual(a.path, b.path);
  assert.ok(b.path.endsWith('草稿-2'));
  assert.equal(c.meta.title, '我的新书');
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

test('writeBookMeta：每次写入前生成 .bak（上一版）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '备份测试');
  let meta = await storage.readBookMeta(bookPath);
  await storage.renameBook(bookPath, '备份测试-改名');
  const bak = JSON.parse(await fs.readFile(path.join(bookPath, '书目.json.bak'), 'utf8'));
  assert.equal(bak.title, '备份测试');
  meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.title, '备份测试-改名');
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

test('书架扫描：书架目录指向普通文件时报 ROOT_UNREADABLE，提示里没有完整路径（v0.9 C-4）', async () => {
  const root = await mkTmp();
  const notADir = path.join(root, '这里是一个文件.txt');
  await fs.writeFile(notADir, '模拟「书架目录被改成某个文件」', 'utf8');
  await assert.rejects(
    () => storage.listBooks(notADir),
    (err) => {
      assert.equal(err.code, 'ROOT_UNREADABLE');
      assert.match(err.message, /^书架目录无法读取：/);
      // 提示里只剩最后一节文件名，书架根目录 / 盘符 / 用户名都不出现
      assert.equal(err.message.includes(root), false);
      assert.equal(/[A-Za-z]:[\\/]/.test(err.message), false);
      assert.match(err.message, /…\\这里是一个文件\.txt$/);
      return true;
    }
  );
  // 目录还是目录的时候照常（这个失败没有把书库弄坏）
  await fs.mkdir(path.join(root, '书'), { recursive: true });
  assert.deepEqual(await storage.listBooks(root), []);
});

test('旧版书目（v0.4.1，无 status/note）：照常打开、不自动补字段、完稿数为 0', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '旧版书');
  // 模拟 v0.4.1 写出的书目：只有 id/file/name/createdAt/chars，没有任何新字段
  const legacy = {
    version: 1,
    id: 'b_legacy',
    title: '旧版书',
    titleTemplate: '第{num}章：{name}',
    fileSeq: 1,
    chapters: [
      {
        id: 'ch_001',
        file: '001-未命名.txt',
        name: '起风',
        chars: 4,
        createdAt: '2026-10-31T00:00:00.000Z'
      }
    ],
    createdAt: '2026-10-31T00:00:00.000Z'
  };
  await fs.writeFile(path.join(bookPath, '书目.json'), JSON.stringify(legacy, null, 2), 'utf8');

  const meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters[0].status, undefined);
  assert.equal(meta.chapters[0].note, undefined);
  const books = await storage.listBooks(root);
  const listed = books.find((book) => book.title === '旧版书');
  assert.ok(listed);
  assert.equal(listed.doneChapters, 0);

  // 普通改名不会把新字段补进旧书目
  await storage.renameChapter(bookPath, 'ch_001', '大风');
  const raw = JSON.parse(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'));
  assert.equal(raw.chapters[0].status, undefined);
  assert.equal(raw.chapters[0].note, undefined);
});

test('书架扫描：完稿章数按 status=done 统计', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '完稿统计');
  await storage.createChapter(bookPath, 1, '第二章');
  await storage.createChapter(bookPath, 2, '第三章');
  let meta = await storage.readBookMeta(bookPath);
  await storage.updateChapterMeta(bookPath, meta.chapters[0].id, { status: 'done' });
  await storage.updateChapterMeta(bookPath, meta.chapters[2].id, { status: 'done' });
  await storage.updateChapterMeta(bookPath, meta.chapters[1].id, { status: 'revising' });
  const books = await storage.listBooks(root);
  assert.equal(books[0].chapterCount, 3);
  assert.equal(books[0].doneChapters, 2);
});

test('删除章节：文件移入 _trash，json 移除，删空后自动补一章', async () => {
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
  // 删到空
  await storage.deleteChapter(bookPath, meta.chapters[0].id);
  meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters.length, 1, '空书自动补一章');
  assert.equal(meta.chapters[0].name, '');
});

test('listBooks：扫描、统计、损坏标记', async () => {
  const root = await mkTmp();
  const goodBook = await storage.createBook(root, '好书');
  await storage.createChapter(goodBook.path, 1, '夜雨');
  const bad = await storage.createBook(root, '坏书');
  await storage.saveChapterText(bad.path, '001-未命名.txt', '内容内容');
  await fs.writeFile(path.join(bad.path, '书目.json'), '{ 这不是 json', 'utf8');
  // 无书目的子目录应被忽略
  await fs.mkdir(path.join(root, '普通文件夹'));
  // _ 开头的目录应被忽略
  await fs.mkdir(path.join(root, '_backup'));

  const books = await storage.listBooks(root);
  assert.equal(books.length, 2);
  const good = books.find((b) => b.folder === '好书');
  const corrupt = books.find((b) => b.folder === '坏书');
  assert.equal(good.status, 'ok');
  assert.equal(good.chapterCount, 2);
  // 章节名跟着书架列表返回，供书架搜索用（不搜正文）
  assert.deepEqual(good.chapterNames, ['', '夜雨']);
  assert.equal(corrupt.status, 'corrupt');
  assert.deepEqual(corrupt.chapterNames, []);
  assert.match(corrupt.reason, /解析失败/);
});

test('verifyBook 报告缺失的章节文件', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '缺失测试');
  await storage.createChapter(bookPath, 1, '夜雨');
  const meta = await storage.readBookMeta(bookPath);
  await fs.unlink(path.join(bookPath, meta.chapters[1].file));
  const report = await storage.verifyBook(bookPath);
  assert.equal(report.chapterCount, 2);
  assert.deepEqual(report.missing, [meta.chapters[1].file]);
});

test('verifyBook 纯读：字数缓存缺失时只算不写，不偷偷改书目.json', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '校验只读');
  const metaFile = path.join(bookPath, '书目.json');
  // createBook 写的书目里没有 chars 缓存；先写好正文，再校验
  await fs.writeFile(path.join(bookPath, '001-未命名.txt'), '你好世界', 'utf8');
  const metaBefore = await fs.readFile(metaFile);
  const report = await storage.verifyBook(bookPath);
  assert.equal(report.chapterCount, 1);
  assert.equal(report.totalChars, 4);
  assert.deepEqual(report.missing, []);
  // 保存后的后台校验是纯读：书目的字节一个都没变（没有补 chars 缓存）
  assert.deepEqual(await fs.readFile(metaFile), metaBefore);
  // 回填缓存的能力没删：书架扫描 / 打开书照旧把 chars 写回
  const opened = await storage.openBook(bookPath);
  assert.equal(opened.totalChars, 4);
  const cached = JSON.parse(await fs.readFile(metaFile, 'utf8'));
  assert.equal(cached.chapters[0].chars, 4);
});

test('原子写：目标被目录占用时抛错且不残留临时文件', async () => {
  const root = await mkTmp();
  const target = path.join(root, 'x.txt');
  await fs.mkdir(target); // 让 rename 失败
  await assert.rejects(() => atomicWriteFile(target, 'hello'));
  const leftovers = (await fs.readdir(root)).filter((f) => f.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
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

test('整本书兜底删除：移入书架 _trash，扫描时不再出现', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '待删的书');
  const dest = await storage.trashBook(root, bookPath);
  assert.ok(dest.includes('_trash'));
  await fs.access(path.join(dest, '书目.json'));
  const books = await storage.listBooks(root);
  assert.equal(books.length, 0);
  // 留在 _trash 里的书还能被人工读出来
  const meta = await storage.readBookMeta(dest);
  assert.equal(meta.title, '待删的书');
});

test('字数缓存：旧书首次扫描会补缓存，之后书架统计不再重读全书', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '字数缓存');
  const meta = await storage.readBookMeta(bookPath);
  // 直接写文件，模拟「没有 chars 缓存的旧书」
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '雨下了一夜。');
  const books = await storage.listBooks(root);
  assert.equal(books[0].totalChars, 6);
  const cached = await storage.readBookMeta(bookPath);
  assert.equal(cached.chapters[0].chars, 6, '首次扫描应把字数缓存写回书目');
  // 再扫一次结果一致
  const again = await storage.listBooks(root);
  assert.equal(again[0].totalChars, 6);
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
  const { path: bookPath } = await storage.createBook(root, '查找书');
  let meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '阿明走进屋里。\n阿明坐下。');
  await storage.createChapter(bookPath, 1, '第二章');
  meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[1].file, '这里没有那个人。');
  await storage.createChapter(bookPath, 2, '第三章');
  meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[2].file, '阿明抬头看了看天。');

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
  const { path: bookPath } = await storage.createBook(root, '替换书');
  let meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '阿明说：阿明走了。');
  await storage.createChapter(bookPath, 1, '第二章');
  meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[1].file, '阿明回头。');
  meta = await storage.readBookMeta(bookPath);
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

test('替换备份：列出最近一次整本替换的备份（最近在前）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '备份列表书');
  let meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '阿明来了。');
  await storage.createChapter(bookPath, 1, '第二章');
  meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[1].file, '阿明走了。');

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
  const { path: bookPath } = await storage.createBook(root, '安全书');
  let meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '阿明一。');
  await storage.createChapter(bookPath, 1, '第二章');
  meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[1].file, '阿明二。');
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

test('整本排版：预检查只算不写，正式整理逐章写盘并备份原文', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '整本排版书');
  let meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '他说,"第一段。"');
  await storage.createChapter(bookPath, 1, '第二章');
  meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[1].file, '第二段');
  await storage.createChapter(bookPath, 2, '第三章');
  meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[2].file, '　　已经整理好的。');

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
  const { path: bookPath } = await storage.createBook(root, '缺文件排版书');
  let meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '第一段');
  await storage.createChapter(bookPath, 1, '第二章');
  meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[1].file, '第二段');
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
    { id: 'c2', file: raw.chapters[0].file, name: '孤儿', volumeId: 'v_404' }
  ];
  await fs.writeFile(metaPath, JSON.stringify(raw), 'utf8');
  const meta = await storage.readBookMeta(bookPath);
  assert.deepEqual(meta.chapters.map((c) => c.name), ['孤儿', '卷一']);
  assert.equal(meta.chapters[0].volumeId, null);
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

test('书目 schemaVersion：新建书带 1；旧书只读补 1 不落盘；写盘才补；未来版本不降级', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '版本测试');
  const metaPath = path.join(bookPath, '书目.json');
  const rawNew = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  assert.equal(rawNew.schemaVersion, 1);

  // 模拟 v0.4.1 写出的书目：没有 schemaVersion
  delete rawNew.schemaVersion;
  await fs.writeFile(metaPath, JSON.stringify(rawNew, null, 2), 'utf8');
  const legacy = await storage.readBookMeta(bookPath);
  assert.equal(legacy.schemaVersion, 1, '内存里按版本 1 读');
  const rawAfterRead = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  assert.equal(rawAfterRead.schemaVersion, undefined, '只是读，不写盘补字段');

  // 正常写盘（改章名）时才补上版本号
  await storage.renameChapter(bookPath, legacy.chapters[0].id, '大风');
  const rawAfterWrite = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  assert.equal(rawAfterWrite.schemaVersion, 1);
  assert.equal(rawAfterWrite.chapters[0].name, '大风');

  // 比本应用新的版本号：能读，写回也不降级
  await fs.writeFile(metaPath, JSON.stringify({ ...rawAfterWrite, schemaVersion: 2 }), 'utf8');
  const future = await storage.readBookMeta(bookPath);
  assert.equal(future.schemaVersion, 2);
  await storage.renameBook(bookPath, '未来版本书');
  const rawFuture = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  assert.equal(rawFuture.schemaVersion, 2);
});

test('listBooks：识别同步冲突副本，不当作章节、不影响统计，冲突文件原样保留', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '同步冲突书');
  await storage.createChapter(bookPath, 1, '夜雨');
  const before = await storage.readBookMeta(bookPath);
  const conflictFiles = [
    '001-未命名 (conflicted copy 1).txt',
    '书目-冲突副本.json'
  ];
  for (const name of conflictFiles) {
    await fs.writeFile(path.join(bookPath, name), '冲突副本内容', 'utf8');
  }
  // _trash 里的旧备份名字带 conflicted 也不算（只看书文件夹顶层）
  await fs.mkdir(path.join(bookPath, '_trash'));
  await fs.writeFile(path.join(bookPath, '_trash', '旧 (conflicted copy).txt'), '备份', 'utf8');

  const books = await storage.listBooks(root);
  const listed = books.find((book) => book.folder === '同步冲突书');
  assert.ok(listed);
  assert.equal(listed.status, 'ok');
  assert.equal(listed.chapterCount, 2, '冲突副本不能算成章节');
  assert.equal(listed.doneChapters, 0);
  assert.deepEqual(listed.conflicts.slice().sort(), conflictFiles.slice().sort());

  // 书目里的章节记录没变（listBooks 只会补字数缓存，不会把冲突副本收进 chapters），冲突文件也没被移动/删除
  const after = await storage.readBookMeta(bookPath);
  const pick = (list) => list.map((c) => ({ id: c.id, file: c.file, name: c.name }));
  assert.deepEqual(pick(after.chapters), pick(before.chapters));
  assert.equal(after.chapters.some((c) => /conflicted|冲突副本/i.test(c.file)), false);
  const files = await fs.readdir(bookPath);
  for (const name of conflictFiles) assert.ok(files.includes(name), `${name} 应原样保留`);
});

test('listBooks：损坏书目的书也带冲突副本提示（方便先修书目再处理副本）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '坏书带冲突');
  await fs.writeFile(path.join(bookPath, '书目.json'), '{ 坏掉了', 'utf8');
  await fs.writeFile(path.join(bookPath, '书目 (conflicted copy 1).json'), '{}', 'utf8');

  const books = await storage.listBooks(root);
  const listed = books.find((book) => book.folder === '坏书带冲突');
  assert.ok(listed);
  assert.equal(listed.status, 'corrupt');
  assert.deepEqual(listed.conflicts, ['书目 (conflicted copy 1).json']);
});

// ---------- 多窗口：打开登记 + 保存前校验 + 跨窗口拦截 ----------
function resetRegistry() {
  storage.openBookRegistry.reset();
}

test('保存前校验：正常书 / 章返回 meta 与章节，允许保存', async () => {
  resetRegistry();
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '保存校验');
  const meta = await storage.readBookMeta(bookPath);
  const prepared = await storage.prepareChapterSave(bookPath, meta.chapters[0].id);
  assert.equal(prepared.chapter.id, meta.chapters[0].id);
  assert.equal(prepared.chapter.file, '001-未命名.txt');
  assert.equal(prepared.index, 0);
});

test('保存前校验：章节文件被删掉 → CHAPTER_MISSING，绝不重建影子 txt', async () => {
  resetRegistry();
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '缺章书');
  const meta = await storage.readBookMeta(bookPath);
  const file = meta.chapters[0].file;
  await fs.unlink(path.join(bookPath, file));
  const before = (await fs.readdir(bookPath)).sort();
  await assert.rejects(
    () => storage.prepareChapterSave(bookPath, meta.chapters[0].id),
    (err) => err.code === 'CHAPTER_MISSING' && /影子文件/.test(err.message)
  );
  assert.deepEqual((await fs.readdir(bookPath)).sort(), before);
  assert.equal(await storage.exists(path.join(bookPath, file)), false);
});

test('保存前校验：书文件夹被删掉 → BOOK_MISSING，绝不 mkdir 重建目录', async () => {
  resetRegistry();
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '整本没了');
  const meta = await storage.readBookMeta(bookPath);
  await fs.rm(bookPath, { recursive: true, force: true });
  await assert.rejects(
    () => storage.prepareChapterSave(bookPath, meta.chapters[0].id),
    (err) => err.code === 'BOOK_MISSING'
  );
  assert.equal(await storage.exists(bookPath), false);
});

test('保存前校验：章节从书目里删掉 → CHAPTER_NOT_FOUND', async () => {
  resetRegistry();
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '章没了');
  const meta = await storage.readBookMeta(bookPath);
  const removedId = meta.chapters[0].id;
  await storage.deleteChapter(bookPath, removedId);
  await assert.rejects(
    () => storage.prepareChapterSave(bookPath, removedId),
    (err) => err.code === 'CHAPTER_NOT_FOUND'
  );
});

test('保存前校验：书目损坏 → 明确报错，不写盘', async () => {
  resetRegistry();
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '书目坏了');
  const meta = await storage.readBookMeta(bookPath);
  await fs.writeFile(path.join(bookPath, '书目.json'), '{ 坏掉了', 'utf8');
  await assert.rejects(
    () => storage.prepareChapterSave(bookPath, meta.chapters[0].id),
    (err) => err.code === 'PARSE_ERROR'
  );
});

test('跨窗口拦截：别的窗口开着的书拒绝保存 / 删除 / 改名 / 整理', async () => {
  resetRegistry();
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '跨窗口书');
  const meta = await storage.readBookMeta(bookPath);
  storage.registerOpenBook(1, bookPath);
  assert.equal(storage.findOpenBookWindow(bookPath), '1');
  for (const action of ['save', 'delete', 'rename', 'format']) {
    await assert.rejects(
      () => Promise.resolve().then(() => storage.assertBookNotBusy(bookPath, 2, action)),
      (err) => err.code === 'CROSS_WINDOW_BUSY' && /请先关掉另一个窗口/.test(err.message),
      action
    );
  }
  // 自己窗口不受影响，保存校验也能通过
  assert.equal(storage.assertBookNotBusy(bookPath, 1, 'save'), true);
  await storage.prepareChapterSave(bookPath, meta.chapters[0].id, { windowId: 1 });
  // 释放后另一个窗口就能操作了
  storage.releaseOpenBook(1);
  assert.equal(storage.findOpenBookWindow(bookPath), null);
  await storage.prepareChapterSave(bookPath, meta.chapters[0].id, { windowId: 2 });
});

test('跨窗口拦截：删除书后按路径清掉登记', async () => {
  resetRegistry();
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '删掉的书');
  storage.registerOpenBook(3, bookPath);
  assert.equal(storage.findOpenBookWindow(bookPath), '3');
  assert.equal(storage.releaseOpenBookPath(bookPath), true);
  assert.equal(storage.findOpenBookWindow(bookPath), null);
  assert.equal(storage.openBookRegistry.getBook(3), null);
  assert.equal(storage.releaseOpenBookPath(bookPath), false);
});

test('ensureDir:false：目录不在时原子写直接失败，不会创建目录 / 临时文件', async () => {
  resetRegistry();
  const root = await mkTmp();
  const targetDir = path.join(root, '不存在的书');
  const target = path.join(targetDir, '001-未命名.txt');
  await assert.rejects(() => storage.saveChapterText(targetDir, '001-未命名.txt', '不该落盘', { ensureDir: false }));
  assert.equal(await storage.exists(targetDir), false);
  assert.equal(await storage.exists(target), false);
});

test('ensureDir:false：目录存在时照常原子写（保存校验通过后的正常路径）', async () => {
  resetRegistry();
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '正常写');
  const meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '正文', { ensureDir: false });
  assert.equal((await storage.loadChapterText(bookPath, meta.chapters[0].file)).text, '正文');
});

test('章号编号方式：按卷独立写进书目.json，改回连续删字段；旧书没有字段 = 连续', async () => {
  resetRegistry();
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
  const realReadFile = fs.readFile;
  let readCalls = 0;
  fs.readFile = async (...args) => {
    readCalls += 1;
    return realReadFile(...args);
  };
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
    assert.equal(readCalls, 0, '超限章节必须在 stat 之后就拒绝，不能走进 readFile');
    await assert.rejects(
      () => storage.statChapter(bookPath, file),
      (err) => err.code === 'CHAPTER_TOO_LARGE'
    );
  } finally {
    fs.readFile = realReadFile;
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
test('书架扫描：回填字数缓存不改 updatedAt，书架顺序稳定', async () => {
  const root = await mkTmp();
  const older = await storage.createBook(root, '甲书');
  const newer = await storage.createBook(root, '乙书');
  await storage.saveChapterText(older.path, '001-未命名.txt', '甲书的正文十个字');
  await storage.saveChapterText(newer.path, '001-未命名.txt', '乙书正文');
  // 造「老版本」书目：没有 chars 缓存，updatedAt 是固定值（甲早乙晚）
  const stamps = new Map([
    [older.path, '2026-01-01T00:00:00.000Z'],
    [newer.path, '2026-02-01T00:00:00.000Z']
  ]);
  for (const book of [older, newer]) {
    const meta = await storage.readBookMeta(book.path);
    const legacy = {
      ...meta,
      updatedAt: stamps.get(book.path),
      chapters: meta.chapters.map((chapter) => ({ id: chapter.id, file: chapter.file, name: chapter.name }))
    };
    await fs.writeFile(path.join(book.path, '书目.json'), JSON.stringify(legacy), 'utf8');
  }

  const first = await storage.listBooks(root);
  assert.deepEqual(first.map((book) => book.folder), ['乙书', '甲书'], '书架按 updatedAt 倒序');
  assert.ok(first.every((book) => book.totalChars > 0), '扫描要回填字数');
  for (const book of [older, newer]) {
    const meta = await storage.readBookMeta(book.path);
    assert.equal(meta.updatedAt, stamps.get(book.path), '回填字数缓存不许改 updatedAt');
    assert.ok(meta.chapters.every((chapter) => Number.isFinite(chapter.chars)), '字数缓存要写回');
  }
  const second = await storage.listBooks(root);
  assert.deepEqual(second.map((book) => book.folder), ['乙书', '甲书'], '再扫一次顺序不变');
  assert.deepEqual(second.map((book) => book.lastModified), [
    Date.parse('2026-02-01T00:00:00.000Z'),
    Date.parse('2026-01-01T00:00:00.000Z')
  ]);
});

test('书架扫描：缺字数按 8 路并发回填（注入 reader 计数，不测墙钟）', async () => {
  const chapters = Array.from({ length: 20 }, (_, i) => ({ id: `ch_${i}`, file: `0${i}-x.txt` }));
  let inFlight = 0;
  let peak = 0;
  let calls = 0;
  const changed = await storage.backfillChapterChars('/tmp/不用真读', chapters, {
    readText: async () => {
      calls += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 4));
      inFlight -= 1;
      return '一二三四五';
    }
  });
  assert.equal(changed, true);
  assert.equal(calls, 20);
  assert.equal(peak, 8, '并发上限 8（书架列书目是 12、缺章 stat 是 16，各管各的）');
  assert.ok(chapters.every((chapter) => chapter.chars === 5));

  // 章节记录还在但文件被删（ENOENT）：跳过、不抛、不留 chars
  const withMissing = [{ id: 'ch_x', file: 'missing.txt' }, { id: 'ch_y', file: 'ok.txt' }];
  const changed2 = await storage.backfillChapterChars('/tmp/不用真读', withMissing, {
    readText: async (bookPath, chapter) => {
      if (chapter.file === 'missing.txt') {
        const err = new Error('没有这个文件');
        err.code = 'ENOENT';
        throw err;
      }
      return '四个汉字';
    }
  });
  assert.equal(changed2, true);
  assert.equal(withMissing[0].chars, undefined);
  assert.equal(withMissing[1].chars, 4);

  // 全都有缓存：一次都不读（书架二次扫描只算加法）
  let untouched = 0;
  const cached = [{ id: 'ch_c', file: 'c.txt', chars: 9 }];
  const changed3 = await storage.backfillChapterChars('/tmp/不用真读', cached, {
    readText: async () => {
      untouched += 1;
      return '';
    }
  });
  assert.equal(changed3, false);
  assert.equal(untouched, 0);
});

// ---------- 1.6.1 R3a：字数回填 128 MB 闸门 ----------
// 书架扫描回填以前是裸 fs.readFile：书目里缺 chars 缓存的章被外部程序换成 129 MB 文件
// （误放的视频 / 日志 / 数据库导出）时会整份读进主进程内存，异常还会把整本书标成 corrupt。
// 现在与 loadChapterText 同口径：先 stat + readSizeProblem(128 MB)，超限章跳过不读、不写缓存。

// 造「老书」书目：把所有章的字数缓存抹掉（模拟旧版本写的 书目.json）
async function stripCharsCache(bookPath) {
  const meta = await storage.readBookMeta(bookPath);
  const legacy = {
    ...meta,
    chapters: meta.chapters.map(({ id, file, name }) => ({ id, file, name }))
  };
  await fs.writeFile(path.join(bookPath, '书目.json'), JSON.stringify(legacy), 'utf8');
  return legacy;
}

// 稀疏文件：只改大小，不真写 128 MB
async function makeSparseHuge(filePath) {
  const handle = await fs.open(filePath, 'r+');
  try {
    await handle.truncate(storage.MAX_CHAPTER_READ_BYTES + 1024);
  } finally {
    await handle.close();
  }
}

// 读盘计数器：记录每一次真 readFile；超限章一旦被读就直接失败（不真分配 129 MB）
function countReadFileFor(hugePath) {
  const realReadFile = fs.readFile;
  const paths = [];
  fs.readFile = async (...args) => {
    const target = String(args[0]);
    paths.push(target);
    if (target === hugePath) throw new Error('超限章节不许走进 readFile');
    return realReadFile(...args);
  };
  return {
    paths,
    restore() {
      fs.readFile = realReadFile;
    },
    hugeReads: () => paths.filter((target) => target === hugePath).length
  };
}

test('书架扫描：129 MB 章缺字数缓存 → 回填跳过不读盘、书照常列出、总字数不含该章（稀疏文件）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '超限章回填');
  const file = (await storage.readBookMeta(bookPath)).chapters[0].file;
  const hugePath = path.join(bookPath, file);
  await makeSparseHuge(hugePath);
  await stripCharsCache(bookPath);

  const counter = countReadFileFor(hugePath);
  let books;
  try {
    books = await storage.listBooks(root);
  } finally {
    counter.restore();
  }

  assert.equal(counter.hugeReads(), 0, '超限章一次都不许 readFile（不许进内存）');
  assert.equal(books.length, 1, '书照常列出，不能因为超限章整本消失');
  assert.equal(books[0].status, 'ok', '超限章不能把整本书标 corrupt');
  assert.equal(books[0].totalChars, 0, '没算出来的字数不进 totalChars');
  const onDisk = JSON.parse(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'));
  assert.equal(Number.isFinite(onDisk.chapters[0].chars), false, '超限章不写字数缓存');
});

test('书架扫描：1 正常章 + 1 超限章 → 只回填正常章、超限章字数保持缺失且不写缓存', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '混合章回填');
  const normalText = '正常章的正文六个字';
  await storage.createChapterWithText(bookPath, { insertIndex: 1, name: '正常章', text: normalText });
  const meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters.length, 2);
  const hugeFile = meta.chapters[0].file;
  const normalFile = meta.chapters[1].file;
  const hugePath = path.join(bookPath, hugeFile);
  await makeSparseHuge(hugePath);
  await stripCharsCache(bookPath);

  const counter = countReadFileFor(hugePath);
  let books;
  try {
    books = await storage.listBooks(root);
  } finally {
    counter.restore();
  }

  assert.equal(counter.hugeReads(), 0, '超限章一次都不许 readFile');
  assert.equal(books.length, 1);
  assert.equal(books[0].status, 'ok', '超限章不能把整本书标 corrupt');
  const readChapterFiles = counter.paths.filter((target) => target.endsWith('.txt'));
  assert.deepEqual(readChapterFiles, [path.join(bookPath, normalFile)], '只读正常章，一章一次');

  const onDisk = JSON.parse(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'));
  const hugeOnDisk = onDisk.chapters.find((chapter) => chapter.file === hugeFile);
  const normalOnDisk = onDisk.chapters.find((chapter) => chapter.file === normalFile);
  assert.equal(Number.isFinite(hugeOnDisk.chars), false, '超限章字数保持缺失，不许写缓存');
  assert.ok(Number.isFinite(normalOnDisk.chars), '正常章要回填字数缓存');
  assert.ok(normalOnDisk.chars > 0);
  assert.equal(books[0].totalChars, normalOnDisk.chars, '总字数只算正常章');
});

test('显式保存仍更新 updatedAt：改章节状态 / 改名会写，扫描回填不写', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '保存测试');
  const created = await storage.readBookMeta(bookPath);
  const stamp = '2026-01-01T00:00:00.000Z';
  await fs.writeFile(
    path.join(bookPath, '书目.json'),
    JSON.stringify({ ...created, updatedAt: stamp }),
    'utf8'
  );
  // 扫描把这一章的字数补上，但 updatedAt 不许动。
  // 恒真陷阱：totalChars 是数字，『>= 0』恒成立；改成写死 5 字正文 + 抹掉字数缓存后按正文重算。
  await storage.saveChapterText(bookPath, created.chapters[0].file, '一二三四五');
  await fs.writeFile(
    path.join(bookPath, '书目.json'),
    JSON.stringify({ ...(await storage.readBookMeta(bookPath)), updatedAt: stamp }),
    'utf8'
  );
  await stripCharsCache(bookPath);
  const scanned = await storage.listBooks(root);
  assert.equal(scanned[0].totalChars, 5, '扫描按章正文回填字数');
  assert.equal((await storage.readBookMeta(bookPath)).updatedAt, stamp, '扫描回填不改 updatedAt');
  // 用户显式改章节状态 → 必须更新
  await new Promise((resolve) => setTimeout(resolve, 10));
  const updated = await storage.updateChapterMeta(bookPath, created.chapters[0].id, { status: 'done' });
  assert.equal(updated.changed, true);
  assert.notEqual(updated.meta.updatedAt, stamp, '显式保存必须更新 updatedAt');
  assert.ok(Date.parse(updated.meta.updatedAt) > Date.parse(stamp));
  // 用户显式改名 → 同样更新
  await new Promise((resolve) => setTimeout(resolve, 10));
  const renamed = await storage.renameChapter(bookPath, created.chapters[0].id, '新章名');
  assert.ok(Date.parse(renamed.meta.updatedAt) > Date.parse(updated.meta.updatedAt));
});

// ---------- 建书失败收尾（1.6.0 A3 / 审计 E-07） ----------
// 建书三步：建目录 → 写空章 txt → 写书目。中间任何一步失败，不许在书架里留下
// 「有文件夹、没书目」的空壳（书架会当成损坏书，用户删也删不干净）。
test('建书失败：收掉这次刚建的目录与空章文件，再建一次不受影响', async () => {
  const root = await mkTmp();
  const failingMeta = async () => {
    const err = new Error('写不进去');
    err.code = 'EPERM';
    throw err;
  };
  await assert.rejects(storage.createBook(root, '建书失败', { writeBookMeta: failingMeta }), (err) => err.code === 'EPERM');
  assert.deepEqual(await fs.readdir(root), [], '失败后不许留下空壳书目录');

  // 障碍消失后再建同名书：正常建出来（说明清理是幂等的，没有残留挡住重试）
  const ok = await storage.createBook(root, '建书失败');
  assert.equal(path.basename(ok.path), '建书失败');
  assert.deepEqual((await fs.readdir(ok.path)).sort(), ['001-未命名.txt', '书目.json']);

  // 目录里已经有别人的东西：只收掉这次新建的那个目录，已有文件一个不删
  const busyRoot = await mkTmp();
  await fs.mkdir(path.join(busyRoot, '有人用过的名字'));
  await fs.writeFile(path.join(busyRoot, '有人用过的名字', '别人的.txt'), '不要删我', 'utf8');
  await assert.rejects(
    storage.createBook(busyRoot, '有人用过的名字', { writeBookMeta: failingMeta }),
    (err) => err.code === 'EPERM'
  );
  assert.deepEqual(await fs.readdir(busyRoot), ['有人用过的名字'], '只收掉本次新建的「名字-2」');
  assert.equal(await fs.readFile(path.join(busyRoot, '有人用过的名字', '别人的.txt'), 'utf8'), '不要删我');
});

// ---------- 1.6.1 R3b：书架扫描的全局读盘上限（P-10） ----------
// 以前书架分层扫描：外层 12 本书 × 每本回填 8 章 = 峰值 96 路同时读正文。机械盘 / 杀软下
// 老书首次扫描会把盘打满，同时打开的书也跟着卡。现在整条链路共用一个常量：全局 ≤ 8
// = 外层 4 本 × 每本 2 章；单本直调（打开书 / 保存校验）不嵌套，仍按 8 路走。
test('书架扫描：1000 章并发峰值不超过全局上限 8（注入 reader 计数，不测墙钟）', async () => {
  const root = await mkTmp();
  const bookCount = 10;
  const perBook = 100;
  for (let b = 0; b < bookCount; b += 1) {
    const { path: bookPath } = await storage.createBook(root, `并发书${b}`);
    const meta = await storage.readBookMeta(bookPath);
    // 造「老书」书目：100 章都没有 chars 缓存。注入的 reader 不读盘，所以不用真建 100 个 txt
    const chapters = Array.from({ length: perBook }, (_, i) => ({
      id: `ch_${b}_${i}`,
      file: `${String(i + 1).padStart(3, '0')}-第${i + 1}章.txt`,
      name: `第 ${i + 1} 章`
    }));
    await fs.writeFile(path.join(bookPath, '书目.json'), JSON.stringify({ ...meta, chapters }), 'utf8');
  }

  let inFlight = 0;
  let peak = 0;
  let calls = 0;
  const books = await storage.listBooks(root, {
    readText: async () => {
      calls += 1;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return '一二三四五';
    }
  });
  assert.equal(books.length, bookCount);
  assert.equal(calls, bookCount * perBook, '每个缺字数的章只读一次');
  assert.ok(peak <= 8, `并发峰值 ${peak} 超过全局上限 8（外层扫书 × 每本回填不许相乘放大）`);
  assert.ok(books.every((book) => book.totalChars === perBook * 5), '所有章字数都要回填');
});

// 还原「整本替换」只该重算真正被还原的那几章：以前把整本 meta.chapters 都传给
// refreshChapterChars，还原 1 章会把 1000 章正文全读一遍（白读盘、还原变慢）。
test('替换备份还原：还原 1 章只重算这 1 章（注入 reader 计数）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '还原只读书');
  let meta = await storage.readBookMeta(bookPath);
  const firstFile = meta.chapters[0].file;
  await storage.saveChapterText(bookPath, firstFile, '阿明来了。');
  await storage.createChapter(bookPath, 1, '第二章');
  await storage.createChapter(bookPath, 2, '第三章');
  meta = await storage.readBookMeta(bookPath);
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
  const { path: bookPath } = await storage.createBook(root, '整本超限');
  await storage.createChapter(bookPath, 1, '第二章');
  await storage.createChapter(bookPath, 2, '第三章');
  const meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '阿明走进灯下。\n阿明抬头。');
  await storage.saveChapterText(bookPath, meta.chapters[1].file, '阿明转身离开。');
  await storage.saveChapterText(bookPath, meta.chapters[2].file, '这里没有那个人。');

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

