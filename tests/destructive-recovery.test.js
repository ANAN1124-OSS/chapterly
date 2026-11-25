// 破坏性操作可恢复性（v0.9 C-8，安全审计 C8）。
//
// 这一轮只管一件事：**破坏性操作失败时，书不能停在半成品上**。
// 已有用例（不在这里重复）：storage-chapter.test.js 的删章 / 整理 / 替换 / 还原成功路径与备份往返，
// tests/data-safety.test.js 的原子写失败、书目损坏恢复、同一秒撞名。
//
// 本文件钉住的是「中途失败」这一段：
//   1. 删章：文件先移 _trash、书目后写；书目写失败必须把文件**放回原处**（回滚），
//      连回滚都失败时报错要指明文件在 _trash、并能从「本书历史」放回书文件夹。
//   2. 整本整理 / 整本替换 / 还原到替换前：中途失败时错误信息必须带「已经改了几章」
//      和备份目录名（只给 _trash 下的名字，不含本机路径），原件都在、失败那一章原样、
//      修好之后重跑能把剩下的补齐。
//   3. 静态闸门：删章的顺序（先移文件再写书目）不许反过来；四个失败分支都走 batchFailure；
//      渲染层删「当前章」前必须先问未保存的修改。
//
// 做法：临时让 `fs.rename` 对**指定目标**失败（模拟杀软 / 同步盘 / 只读文件占住），
// `finally` 里一定还原，绝不影响别的用例。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const storage = require('../core/storage');
const chaptersLib = require('../core/chapters');

// 源码闸门按 \n 切（仓库在 Windows 上检出是 CRLF，先归一化，免得闸门自己被换行符绊倒）
const readSource = (rel) => require('node:fs').readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const STORAGE_SOURCE = readSource(path.join('core', 'storage.js'));
const RENDERER_SOURCE = readSource(path.join('renderer', 'renderer.js'));
// WP17 A3 第四刀：删除章 / 撤销登记的整段随编辑域搬到 chapter-ops-ui.js（静态闸门改读模块）。
const CHAPTER_OPS_SOURCE = readSource(path.join('renderer', 'chapter-ops-ui.js'));

const tmpCleanup = require('./tmp-cleanup');

// TB-02：临时目录统一经 tests/tmp-cleanup.js 的 mkTmp（mkdtemp + 登记回收）。
const mkTmp = (prefix = 'cw-destructive-') => tmpCleanup.mkTmp(prefix);

// 只让「目标路径匹配」的 rename 失败，其它 rename 走真实实现；返回 restore()，必须放 finally。
function patchRename(select) {
  const real = fs.rename;
  Object.defineProperty(fs, 'rename', {
    configurable: true,
    writable: true,
    value: async (from, to) => {
      const code = select(String(from), String(to));
      if (code) throw Object.assign(new Error(`${code}: 模拟失败`), { code });
      return real(from, to);
    }
  });
  return () => Object.defineProperty(fs, 'rename', { value: real, configurable: true, writable: true });
}

async function tmpEntries(dir) {
  const names = await fs.readdir(dir);
  return names.filter((name) => name.includes('.tmp-'));
}

function functionBody(source, marker, indent) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `源码里找不到 ${marker}`);
  const end = source.indexOf(`\n${indent}}\n`, start);
  assert.ok(end > start, `${marker} 的函数体没有正常结束`);
  return source.slice(start, end + indent.length + 2);
}

// ---------- 1. 删章：失败要回滚 ----------

test('删章：书目写盘失败时把章节文件放回原处，书保持删除前的样子', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '删章回滚');
  await storage.createChapter(bookPath, 1, '第二章');
  const meta = await storage.readBookMeta(bookPath);
  const file1 = meta.chapters[1].file;
  await storage.saveChapterText(bookPath, file1, '第二章的正文，删不掉就得原样留着。');
  const metaPath = path.join(bookPath, '书目.json');
  const metaBefore = await fs.readFile(metaPath, 'utf8');
  const textBefore = await fs.readFile(path.join(bookPath, file1), 'utf8');

  const restore = patchRename((from, to) => (to.endsWith(`${path.sep}书目.json`) ? 'EACCES' : ''));
  let failed = null;
  try {
    failed = await storage.deleteChapter(bookPath, meta.chapters[1].id).then(
      () => null,
      (err) => err
    );
  } finally {
    restore();
  }

  assert.ok(failed, '书目写不进去时删章必须报错，不能假装成功');
  assert.equal(failed.code, 'DELETE_FAILED');
  assert.match(failed.message, /删除本章中途停下/, '错误信息要说清是哪一步停了');
  assert.match(failed.message, /已经放回原处/, '回滚成功要说出来');
  assert.match(failed.message, /书还是删除前的样子/);
  // 文件回到书文件夹，内容一个字节没变
  assert.equal(await fs.readFile(path.join(bookPath, file1), 'utf8'), textBefore);
  // 书目一字节不动（这一章还在，点开还能读）
  assert.equal(await fs.readFile(metaPath, 'utf8'), metaBefore);
  // _trash 里没有残留的那一份（回滚是 rename 回去，不是复制）
  const trashEntries = await fs.readdir(path.join(bookPath, '_trash')).catch(() => []);
  assert.deepEqual(trashEntries.filter((name) => name.endsWith(file1)), []);
  assert.deepEqual(await tmpEntries(bookPath), []);
  // 恢复正常后重试：这次真的删掉，文件进 _trash
  const ok = await storage.deleteChapter(bookPath, meta.chapters[1].id);
  assert.ok(ok.trashPath.includes('_trash'));
  await fs.access(ok.trashPath);
  assert.equal((await storage.readBookMeta(bookPath)).chapters.length, 1);
});

test('删章：连「放回原处」都失败时报错指明文件在 _trash，历史里能把它放回去', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '删章放不回去');
  await storage.createChapter(bookPath, 1, '第二章');
  const meta = await storage.readBookMeta(bookPath);
  const file1 = meta.chapters[1].file;
  await storage.saveChapterText(bookPath, file1, '放不回去也要让人找得到。');
  const metaBefore = await fs.readFile(path.join(bookPath, '书目.json'), 'utf8');
  const chapterId = meta.chapters[1].id;

  // 书目的 rename 失败；回滚时「把文件放回书文件夹」的 rename 也失败
  const restore = patchRename((from, to) =>
    to.endsWith(`${path.sep}书目.json`) || to.endsWith(`${path.sep}${file1}`) ? 'EPERM' : ''
  );
  let failed = null;
  try {
    failed = await storage.deleteChapter(bookPath, chapterId).then(
      () => null,
      (err) => err
    );
  } finally {
    restore();
  }

  assert.ok(failed);
  assert.equal(failed.code, 'DELETE_FAILED');
  assert.match(failed.message, /现在在 _trash\//, '要说清文件在哪个 _trash 目录（相对位置，不是本机路径）');
  assert.ok(failed.message.includes(file1), '要说清是哪个文件');
  assert.match(failed.message, /历史/);
  assert.ok(!failed.message.includes(root), '错误里不许出现本机临时目录的绝对路径');
  // 文件确实在书内 _trash（带时间戳前缀），书文件夹里没有了，书目还是完整的上一版
  const trashNames = await fs.readdir(path.join(bookPath, '_trash'));
  assert.equal(trashNames.filter((name) => name.endsWith(file1)).length, 1);
  await assert.rejects(() => fs.access(path.join(bookPath, file1)));
  assert.equal(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'), metaBefore);

  // 从「本书历史」把删除的章节放回书文件夹 → 书目里这一章本来还在，书立刻恢复可用
  const history = await storage.listBookHistory(bookPath);
  const deleteGroup = history.groups.find((group) => group.source === 'delete');
  assert.ok(deleteGroup, '删除的章节必须能在历史里看到');
  const restored = await storage.restoreHistoryFile(bookPath, deleteGroup.id, file1);
  assert.equal(restored.restored, 1);
  assert.equal((await storage.loadChapterText(bookPath, file1)).text, '放不回去也要让人找得到。');
  assert.deepEqual(await tmpEntries(bookPath), []);
});

test('删章：删最后一章且书目写盘失败 → 原章放回、书目原样、不产生空章', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '删最后一张');
  const meta = await storage.readBookMeta(bookPath);
  const file0 = meta.chapters[0].file;
  await storage.saveChapterText(bookPath, file0, '唯一的一章。');
  const txtBefore = (await fs.readdir(bookPath)).filter((name) => name.endsWith('.txt'));
  const metaBefore = await fs.readFile(path.join(bookPath, '书目.json'), 'utf8');

  const restore = patchRename((from, to) => (to.endsWith(`${path.sep}书目.json`) ? 'EACCES' : ''));
  let failed = null;
  try {
    failed = await storage.deleteChapter(bookPath, meta.chapters[0].id).then(
      () => null,
      (err) => err
    );
  } finally {
    restore();
  }

  assert.ok(failed && failed.code === 'DELETE_FAILED');
  assert.deepEqual(
    (await fs.readdir(bookPath)).filter((name) => name.endsWith('.txt')),
    txtBefore,
    '2026-11-25 起删空不再自动补章：失败回滚不许留下任何空章 / 孤儿 txt'
  );
  assert.equal(await fs.readFile(path.join(bookPath, file0), 'utf8'), '唯一的一章。');
  assert.equal(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'), metaBefore);
  assert.deepEqual(await tmpEntries(bookPath), []);

  // 重试删除成功：书变成 0 章（不再自动补一章），章节文件照旧进 _trash。
  const after = await storage.deleteChapter(bookPath, meta.chapters[0].id);
  assert.equal(after.newChapter, null, '不再自动补章');
  assert.equal(after.index, -1, '0 章时回包 index = -1');
  assert.equal((await storage.readBookMeta(bookPath)).chapters.length, 0);
  assert.equal(
    await fs.access(path.join(bookPath, file0)).then(() => true, () => false),
    false,
    '章节文件已进 _trash'
  );
});

// C34 的历史前提（「回滚时把自动补的空章挪进 _trash」）已随「删空不补章」消失；
// 保留一条同场景回归：删最后一章失败回滚时，预置的 _trash 同秒备份一个都不许被覆盖。
test('删最后一章失败回滚：预置 _trash 备份不被覆盖，也不产生空章', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '回滚撞名');
  const meta = await storage.readBookMeta(bookPath);
  const file0 = meta.chapters[0].file;
  await storage.saveChapterText(bookPath, file0, '唯一的一章。');

  const pad2 = (n) => String(n).padStart(2, '0');
  const stampOf = (date) =>
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}-` +
    `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  const now = Date.now();
  const planted = new Map();
  await fs.mkdir(path.join(bookPath, '_trash'), { recursive: true });
  for (let delta = -1; delta <= 2; delta += 1) {
    const stamp = stampOf(new Date(now + delta * 1000));
    const name = `${stamp}-${file0}`;
    planted.set(name, `预置旧备份 ${stamp}`);
    await fs.writeFile(path.join(bookPath, '_trash', name), planted.get(name), 'utf8');
  }

  const restore = patchRename((from, to) => (to.endsWith(`${path.sep}书目.json`) ? 'EACCES' : ''));
  let failed = null;
  try {
    failed = await storage.deleteChapter(bookPath, meta.chapters[0].id).then(
      () => null,
      (err) => err
    );
  } finally {
    restore();
  }
  assert.ok(failed && failed.code === 'DELETE_FAILED');

  // 预置的旧备份一个都没被覆盖（moveToTrash 撞名会顺延序号，不许盖别人的备份）
  for (const [name, content] of planted) {
    assert.equal(await fs.readFile(path.join(bookPath, '_trash', name), 'utf8'), content, `${name} 被覆盖了`);
  }
  // 回归期间删除产生的那一份备份名字也要在预置之外、且不与任何预置名撞车；
  // 书文件夹里不留孤儿 txt，原章照常放回。
  assert.deepEqual(
    (await fs.readdir(bookPath)).filter((name) => name.endsWith('.txt')),
    [file0]
  );
  assert.equal(await fs.readFile(path.join(bookPath, file0), 'utf8'), '唯一的一章。');
});
// ---------- 2. 批次操作：中途失败要留下「现场」 ----------

const FORMAT_OPTIONS = { indent: '2', blankLines: 'keep', trimTrailing: true, normalizePunct: true };

test('整本整理：中途失败时报告已整理章数与备份目录，原件都在、失败章原样，修好重跑能补齐', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '整理半途');
  await storage.createChapter(bookPath, 1, '第二章');
  await storage.createChapter(bookPath, 2, '第三章');
  let meta = await storage.readBookMeta(bookPath);
  const [f0, f1, f2] = meta.chapters.map((chapter) => chapter.file);
  await storage.saveChapterText(bookPath, f0, '第一段  ');
  await storage.saveChapterText(bookPath, f1, '第二段  ');
  await storage.saveChapterText(bookPath, f2, '第三段  ');
  meta = await storage.readBookMeta(bookPath);
  const metaPath = path.join(bookPath, '书目.json');
  const metaBefore = await fs.readFile(metaPath, 'utf8');

  // 第二张章写到一半失败（第一张已经整理好）；备份复制也走 rename，这里只让「写回章节文件」
  // 那一步失败，别把 _trash 里的备份复制一起打断（否则测的就不是「备份成功、写盘失败」了）
  const restore = patchRename((from, to) => (to.endsWith(`${path.sep}${f1}`) && !to.includes(`${path.sep}_trash${path.sep}`) ? 'EPERM' : ''));
  let failed = null;
  try {
    failed = await storage.formatBook(bookPath, FORMAT_OPTIONS).then(
      () => null,
      (err) => err
    );
  } finally {
    restore();
  }

  assert.ok(failed);
  assert.equal(failed.code, 'FORMAT_FAILED');
  assert.match(failed.message, /整本整理中途停下/);
  assert.match(failed.message, /已经整理好 1 章/);
  assert.match(failed.message, /整理备份-/);
  assert.ok(!failed.message.includes(root), '错误里不许出现本机绝对路径（只给 _trash 下的目录名）');
  // 已整理的那章：写盘生效；失败的那章与后面那章：一个字节没动
  assert.equal((await storage.loadChapterText(bookPath, f0)).text, '　　第一段');
  assert.equal((await storage.loadChapterText(bookPath, f1)).text, '第二段  ');
  assert.equal((await storage.loadChapterText(bookPath, f2)).text, '第三段  ');
  // 原件都在备份里（第一、二章都在：第二章是先备份再写盘）
  const backupName = failed.message.match(/(整理备份-[^\s；]+)/)[1];
  const backupDir = path.join(bookPath, '_trash', backupName);
  assert.equal(await fs.readFile(path.join(backupDir, f0), 'utf8'), '第一段  ');
  assert.equal(await fs.readFile(path.join(backupDir, f1), 'utf8'), '第二段  ');
  await assert.rejects(() => fs.access(path.join(backupDir, f2)), '没改动的章不进备份');
  // CSTO-A03：失败分支会把已经整理好那章的 chars 如实补写一次（这里章节原本还没有 chars 缓存，
  // 整理后应落成新正文的真实字数）；updatedAt / 标题一个字节都不许动，也不许留下临时文件。
  const metaAfterFormatFail = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  const metaBeforeFormatFail = JSON.parse(metaBefore);
  assert.equal(metaAfterFormatFail.updatedAt, metaBeforeFormatFail.updatedAt, '失败补记不顶 updatedAt');
  assert.equal(metaAfterFormatFail.title, metaBeforeFormatFail.title);
  assert.equal(
    metaAfterFormatFail.chapters[0].chars,
    chaptersLib.countChars('　　第一段'),
    '已整理章的新字数落盘'
  );
  assert.deepEqual(
    metaAfterFormatFail.chapters.slice(1).map((chapter) => chapter.chars),
    metaBeforeFormatFail.chapters.slice(1).map((chapter) => chapter.chars),
    '失败那一章与没轮到的章不冒充已整理'
  );
  assert.deepEqual(await tmpEntries(bookPath), []);

  // 修好之后重跑：把剩下两章补齐，备份目录另起一个（不覆盖失败那次的现场）
  const again = await storage.formatBook(bookPath, FORMAT_OPTIONS);
  assert.equal(again.chaptersChanged, 2);
  assert.notEqual(path.basename(again.backupDir), backupName);
  assert.equal((await storage.loadChapterText(bookPath, f1)).text, '　　第二段');
  assert.equal((await storage.loadChapterText(bookPath, f2)).text, '　　第三段');
});

test('整本替换：中途失败时报告已替换章数与备份目录，备份里是替换前原文，重跑能补齐', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '替换半途');
  await storage.createChapter(bookPath, 1, '第二章');
  let meta = await storage.readBookMeta(bookPath);
  const [f0, f1] = meta.chapters.map((chapter) => chapter.file);
  await storage.saveChapterText(bookPath, f0, '阿明来了。');
  await storage.saveChapterText(bookPath, f1, '阿明走了。');
  meta = await storage.readBookMeta(bookPath);
  const metaBefore = await fs.readFile(path.join(bookPath, '书目.json'), 'utf8');

  const restore = patchRename((from, to) => (to.endsWith(`${path.sep}${f1}`) && !to.includes(`${path.sep}_trash${path.sep}`) ? 'EACCES' : ''));
  let failed = null;
  try {
    failed = await storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' }).then(
      () => null,
      (err) => err
    );
  } finally {
    restore();
  }

  assert.ok(failed);
  assert.equal(failed.code, 'REPLACE_FAILED');
  assert.match(failed.message, /整本替换中途停下/);
  assert.match(failed.message, /已经替换 1 章/);
  assert.match(failed.message, /替换备份-/);
  assert.ok(!failed.message.includes(root));
  // 第一章已经替换、第二章原样；备份里两章都是替换前的原文
  assert.equal((await storage.loadChapterText(bookPath, f0)).text, '小明来了。');
  assert.equal((await storage.loadChapterText(bookPath, f1)).text, '阿明走了。');
  const backupName = failed.message.match(/(替换备份-[^\s；]+)/)[1];
  const backupDir = path.join(bookPath, '_trash', backupName);
  assert.equal(await fs.readFile(path.join(backupDir, f0), 'utf8'), '阿明来了。');
  assert.equal(await fs.readFile(path.join(backupDir, f1), 'utf8'), '阿明走了。');
  // CSTO-A03（第五轮审计）：失败前已经替换的章，chars 缓存已按新正文更新，必须如实补写进书目
  //（旧行为是「书目一个字节不写」，于是陈旧缓存永远不会被扫描重算）。补写不是一次显式保存：
  // updatedAt / 标题 / 未处理章的缓存一个字节都不许动，也不许留下临时文件。
  const metaBeforeObj = JSON.parse(metaBefore);
  const metaAfterObj = JSON.parse(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'));
  assert.equal(metaAfterObj.chapters[0].chars, chaptersLib.countChars('小明来了。'), '已替换章的新字数落盘');
  assert.equal(metaAfterObj.chapters[1].chars, metaBeforeObj.chapters[1].chars, '失败那一章不冒充已替换');
  assert.equal(metaAfterObj.updatedAt, metaBeforeObj.updatedAt, '补写 chars 不顶 updatedAt');
  assert.deepEqual(
    {
      ...metaAfterObj,
      chapters: metaAfterObj.chapters.map((chapter) => ({ ...chapter, chars: 0 }))
    },
    {
      ...metaBeforeObj,
      chapters: metaBeforeObj.chapters.map((chapter) => ({ ...chapter, chars: 0 }))
    },
    '除字数缓存以外，书目其余部分一个字节不动'
  );
  assert.deepEqual(await tmpEntries(bookPath), []);

  // 重跑：只剩第二章要替换
  const again = await storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' });
  assert.equal(again.chaptersChanged, 1);
  assert.equal((await storage.loadChapterText(bookPath, f1)).text, '小明走了。');
});

test('还原到替换前：中途失败报告已还原章数与还原前备份，重跑能把剩下的补上', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '还原半途');
  await storage.createChapter(bookPath, 1, '第二章');
  let meta = await storage.readBookMeta(bookPath);
  const [f0, f1] = meta.chapters.map((chapter) => chapter.file);
  await storage.saveChapterText(bookPath, f0, '阿明一。');
  await storage.saveChapterText(bookPath, f1, '阿明二。');
  const replaced = await storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' });
  const backupName = path.basename(replaced.backupDir);
  assert.equal((await storage.loadChapterText(bookPath, f0)).text, '小明一。');

  // 还原第一章能成功，第二章写盘失败；备份复制也走 rename，这里只打断写回章节文件那一步
  const restore = patchRename((from, to) => (to.endsWith(`${path.sep}${f1}`) && !to.includes(`${path.sep}_trash${path.sep}`) ? 'EPERM' : ''));
  let failed = null;
  try {
    failed = await storage.restoreReplaceBackup(bookPath, backupName).then(
      () => null,
      (err) => err
    );
  } finally {
    restore();
  }

  assert.ok(failed);
  assert.equal(failed.code, 'RESTORE_FAILED');
  assert.match(failed.message, /还原到替换前中途停下/);
  assert.match(failed.message, /已经还原 1 章/);
  assert.match(failed.message, /还原前备份-/);
  assert.match(failed.message, /再点一次/);
  assert.ok(!failed.message.includes(root));
  // 第一章已还原，第二章还是替换后的内容；替换备份本身没被消耗
  assert.equal((await storage.loadChapterText(bookPath, f0)).text, '阿明一。');
  assert.equal((await storage.loadChapterText(bookPath, f1)).text, '小明二。');
  assert.equal((await storage.listReplaceBackups(bookPath)).length, 1);
  assert.deepEqual(await tmpEntries(bookPath), []);

  // 重跑：第二章补上，且这次会先把「现在的第一章」再备份一份
  const again = await storage.restoreReplaceBackup(bookPath, backupName);
  assert.equal(again.restored, 2);
  assert.equal((await storage.loadChapterText(bookPath, f0)).text, '阿明一。');
  assert.equal((await storage.loadChapterText(bookPath, f1)).text, '阿明二。');
});

// P2-3（1.5.0）：还原到替换前也是「整份备份读进内存 → 原子写回」，超限要整批拒绝、一个字节不写。
test('还原到替换前：备份文件超过读取上限时整批拒绝，书里正文与备份都不动', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '还原超大备份');
  await storage.createChapter(bookPath, 1, '第二章');
  const meta = await storage.readBookMeta(bookPath);
  const [f0, f1] = meta.chapters.map((chapter) => chapter.file);
  await storage.saveChapterText(bookPath, f0, '阿明一。');
  await storage.saveChapterText(bookPath, f1, '阿明二。');
  const replaced = await storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' });
  const backupName = path.basename(replaced.backupDir);

  // 备份里第一章被外部换成超大文件（稀疏文件，只改长度）；第二章正常——
  // 预检必须整批拒绝，不能先还原第二章再在第一章上失败。
  const huge = path.join(replaced.backupDir, f0);
  await fs.truncate(huge, storage.MAX_CHAPTER_READ_BYTES + 1);

  let failed = null;
  try {
    failed = await storage.restoreReplaceBackup(bookPath, backupName).then(
      () => null,
      (err) => err
    );
  } finally {
    // 稀疏文件收尾：把长度改回去，免得临时目录残留 128 MB 的账
    await fs.truncate(huge, 0).catch(() => {});
  }

  assert.ok(failed, '超限备份必须明确报错，不能假装还原成功');
  assert.equal(failed.code, 'BACKUP_TOO_LARGE');
  assert.match(failed.message, /128 MB/);
  assert.ok(failed.message.includes(f0));
  assert.ok(!failed.message.includes(root), '错误信息不带本机路径');
  // 书里正文一个字节没动（第二章也没被提前还原）
  assert.equal((await storage.loadChapterText(bookPath, f0)).text, '小明一。');
  assert.equal((await storage.loadChapterText(bookPath, f1)).text, '小明二。');
  // 一个字节都没写：没建「还原前备份-*」，替换备份本身也没被消耗
  const trashNames = await fs.readdir(path.join(bookPath, '_trash'));
  assert.deepEqual(trashNames.filter((name) => name.startsWith('还原前备份-')), []);
  assert.equal((await storage.listReplaceBackups(bookPath)).length, 1);
  assert.deepEqual(await tmpEntries(bookPath), []);
});

// ---------- 3. 静态闸门（防回退） ----------

test('静态闸门：删章必须「先移文件 → 再写书目」，失败分支必须回滚', () => {
  const body = functionBody(STORAGE_SOURCE, 'async function deleteChapter(', '');
  const moveAt = body.indexOf('moveToTrash(');
  // I2（三审，断言跟错）：写书目现在走 writeBookMetaChecked（读时拍身份、写前核对）——
  // 锚点跟着换，「先移文件 → 再写书目」的判据与顺序要求一字不变。
  const metaAt = body.indexOf('writeBookMetaChecked(');
  assert.ok(moveAt >= 0 && metaAt >= 0, '删章必须既移文件又写书目');
  assert.ok(moveAt < metaAt, '顺序不许反过来：先写书目再移文件会留下「书目里没有了、文件还在」的孤儿');
  assert.match(body, /batchFailure\(/, '书目写盘失败必须走统一报错（带现场）');
  assert.match(body, /DELETE_FAILED/);
  // CSTO-A04：回滚也走 renameWithRetry —— 杀软 / 同步盘瞬时占用时与保存链路同一套重试口径
  assert.match(body, /renameWithRetry\(trashPath/, '失败后必须尝试把文件放回原处（走带重试的 rename）');
  assert.equal(/fs\.rename\(/.test(body), false, '删章链路不许再出现裸 fs.rename');
});

// WP-06（审计 C5）：删章路径（deleteChapter + moveToTrash + 回滚）必须过 assertChapterFile，
// 否则坏书目的 file 含 ..\ 时能把书外文件 rename 进本书、回滚还能往书外写。
test('静态闸门：删章入口先过 assertChapterFile，回滚只用校验过的绝对路径（C5）', () => {
  const body = functionBody(STORAGE_SOURCE, 'async function deleteChapter(', '');
  const assertAt = body.indexOf('assertChapterFile(');
  const moveAt = body.indexOf('moveToTrash(');
  assert.ok(assertAt >= 0, '删章入口必须过 assertChapterFile（坏书目的 file 不许进 moveToTrash）');
  assert.ok(assertAt < moveAt, '校验必须在移文件之前：任何副作用之前就拒绝');
  assert.match(body, /const targetPath = assertChapterFile\(bookPath, target\.file\)/, '回滚路径复用校验结果');
  assert.equal(body.includes('path.join(bookPath, target.file)'), false, '回滚不许按原始字段现拼路径（否则能写出书外）');
  assert.match(body, /renameWithRetry\(trashPath, targetPath\)/, '回滚必须用校验过的绝对路径（走带重试的 rename）');
  const moveBody = functionBody(STORAGE_SOURCE, 'async function moveToTrash(', '');
  const moveAssertAt = moveBody.indexOf('assertChapterFile(');
  assert.ok(moveAssertAt >= 0, 'moveToTrash 自己也要挡（撤销删空补章同走这里）');
  assert.ok(moveAssertAt < moveBody.indexOf('ensureDir('), '校验先于建 _trash 目录：被拒时零副作用');
});

// WP-20（审计 C19）：还原到替换前的可还原集合必须由 assertChapterFile 决定 ——
// 坏书目的 file=「书目.json」/「nul.txt」不许进集合，目标也不许再只过 assertInside
// （assertInside 只拦「逃逸出书目录」，不拦非 txt / 保留名 / 退化名）。
test('静态闸门：还原替换备份只认 assertChapterFile 通过的 .txt（C19）', () => {
  const body = functionBody(STORAGE_SOURCE, 'async function restoreReplaceBackup(', '');
  assert.match(body, /const currentFiles = new Set\(\);/, '可还原集合要逐条校验，不许直接照搬 meta.chapters[].file');
  assert.match(body, /assertChapterFile\(bookPath, chapter\.file\)/, '书目字段必须先过 assertChapterFile');
  assert.match(body, /currentFiles\.add\(chapter\.file\)/, '只有校验通过的章节文件才进集合');
  assert.ok(body.includes('/\\.txt$/i.test(entry.name)'), '备份目录里只认 .txt 章节文件');
  assert.match(
    body,
    /const target = assertChapterFile\(bookPath, entry\.name\)/,
    '目标路径必须过 assertChapterFile（收窄退化名 / 系统保留名）'
  );
  assert.equal(body.includes('assertInside(bookPath, entry.name)'), false, '不许再用 assertInside 直接写目标');
  assert.ok(
    body.indexOf('assertChapterFile(bookPath, entry.name)') < body.indexOf('backupCurrentToRestoreDir('),
    '校验必须先于「还原前备份」的复制副作用'
  );
});

test('静态闸门：三个批次操作的中途失败都要带「改了几章 + 备份目录名」', () => {
  const cases = [
    ['async function formatBook(', 'FORMAT_FAILED', '整理备份'],
    ['async function replaceInBook(', 'REPLACE_FAILED', '替换备份'],
    ['async function restoreReplaceBackup(', 'RESTORE_FAILED', '还原前备份']
  ];
  for (const [marker, code, label] of cases) {
    const body = functionBody(STORAGE_SOURCE, marker, '');
    assert.match(body, /try \{/, `${marker} 的循环必须在 try 里`);
    assert.ok(body.includes(`batchFailure(`), `${marker} 失败必须走 batchFailure`);
    assert.ok(body.includes(code), `${marker} 必须有稳定的错误码 ${code}`);
    assert.ok(body.includes('trashDirLabel('), `${marker} 必须报出备份目录（_trash 下的名字）`);
    assert.ok(!body.includes('${backupDir}'), `${marker} 不许把绝对路径直接拼进消息`);
    assert.ok(label.length > 0);
  }
  // 报错工具本身只用相对位置：_trash/<目录名>
  const helper = functionBody(STORAGE_SOURCE, 'function batchFailure(', '');
  assert.ok(helper.includes('describeForUi('), '原因先过脱敏');
  assert.ok(!helper.includes('bookPath'), 'batchFailure 拿不到也拼不出书的本机路径');
});

test('静态闸门：渲染层删「当前章」前必须先问未保存的修改', () => {
  const body = functionBody(CHAPTER_OPS_SOURCE, 'async function deleteChapterAt(', '  ');
  // H1（三审）：删当前章的未保存拦截统一走 guardUnsavedForTransition（内部就是 askUnsaved +
  // saveCurrent，且保存回执后复核 dirty）。这里认「过渡前保存原语」这一层，不再钉具体函数名。
  const askAt = body.search(/guardUnsavedForTransition\(|askUnsaved\(/);
  assert.ok(askAt >= 0, '删当前章前必须问未保存的修改（不能静默丢编辑区里的字）');
  assert.match(
    body,
    /guardUnsavedForTransition\(\{/,
    'H1：必须走统一「过渡前保存」原语（保存回执后复核 dirty，仍脏就再问）'
  );
  // 1.4.0 P0-2（撤销优先）：删除不再弹「删除章节」确认框，改成直接执行 + 10 秒撤销；
  // 未保存拦截是保留的两处确认之一，顺序与文案都不许变。
  assert.equal(body.indexOf("title: '删除章节'"), -1, 'P0-2 起删除直接执行，不许再加回删除确认框');
  assert.ok(body.indexOf('activateDeleteUndo(') > askAt, '删完要登记撤销（10 秒窗口）');
  assert.match(body, /wasCurrent/);
  assert.match(body, /skipConfirm/);
  assert.match(body, /saveLabel: '保存后删除'/);
  // 批次操作失败后界面要回到磁盘的真相（三个失败分支都调了重载 helper）
  // 第 4 步九刀·补刀 9a：整本替换那段搬到 renderer/find-ui.js；两边合并计数（总数不变，只改读取范围）。
  // M1 第 11 轮第三刀：整本整理那段搬到 renderer/format-book-ui.js；同样并入合并计数。
  // M1 第 12 轮第五刀：整本替换备份还原那段搬到 renderer/replace-backup-ui.js；同样并入合并计数。
  const FIND_UI_SOURCE = require('node:fs').readFileSync(path.join(__dirname, '..', 'renderer', 'find-ui.js'), 'utf8');
  const FORMAT_BOOK_SOURCE = require('node:fs').readFileSync(path.join(__dirname, '..', 'renderer', 'format-book-ui.js'), 'utf8');
  const REPLACE_BACKUP_SOURCE = require('node:fs').readFileSync(path.join(__dirname, '..', 'renderer', 'replace-backup-ui.js'), 'utf8');
  const reloadCalls = [
    ...(RENDERER_SOURCE.match(/await reloadAfterPartialFailure\(/g) || []),
    ...(FIND_UI_SOURCE.match(/await reloadAfterPartialFailure\(/g) || []),
    ...(FORMAT_BOOK_SOURCE.match(/await reloadAfterPartialFailure\(/g) || []),
    ...(REPLACE_BACKUP_SOURCE.match(/await reloadAfterPartialFailure\(/g) || [])
  ];
  assert.ok(reloadCalls.length >= 3, '整理 / 替换 / 还原失败后都要按磁盘重载当前书');
  assert.match(RENDERER_SOURCE, /async function reloadAfterPartialFailure\(bookPath = null\)/);
});

test('静态闸门：错误文案不含本机路径（只给相对位置）', () => {
  const helper = functionBody(STORAGE_SOURCE, 'function batchFailure(', '');
  assert.ok(!/path\.join|bookPath|__dirname/.test(helper), 'batchFailure 自己不许拼路径');
  const label = functionBody(STORAGE_SOURCE, 'function trashDirLabel(', '');
  assert.ok(label.includes('path.basename('), '只取备份目录名，别把 bookPath 拼进去');
  assert.ok(label.includes('TRASH_DIR'));
});

// 兜底：本文件自己不许写死盘符 / 删文件（和别的测试脚本一个口径）
test('本文件只读约束：不出现真实书架路径、不删文件', () => {
  const source = require('node:fs').readFileSync(__filename, 'utf8');
  assert.ok(!/D:\\\\我的小说/.test(source));
  assert.ok(!/fs\.(rm|unlink)\(/.test(source), '测试里不许删文件（清理只走临时目录）');
  assert.ok(source.includes('mkdtemp'), '一律用系统临时目录');
});

// ---------- RECOV-02：失败路径不重建书目 / 书文件夹 ----------
// 整本替换 / 整理中途失败后 CSTO-A03 会补写字数缓存。若此刻书文件夹或 书目.json 已被外部
// 删掉，旧实现会带 ensureDir（默认 true）把影子书目 / 空书文件夹重新建出来——作者看到的
// 失败现场被盖掉，还会留下一个指向不存在章节的「空壳书」。失败路径只许补写「本来就在」的书目。
test('RECOV-02：整本替换中途 书目.json 被外部删掉并写失败 → 不重建书目（无影子书）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '失败不重建书目');
  await storage.createChapter(bookPath, 1, '第二章');
  const meta = await storage.readBookMeta(bookPath);
  const firstFile = meta.chapters[0].file;
  const secondFile = meta.chapters[1].file;
  await storage.saveChapterText(bookPath, firstFile, '阿明第一章。');
  await storage.saveChapterText(bookPath, secondFile, '阿明第二章。');
  const metaPath = path.join(bookPath, '书目.json');
  assert.equal(fsSync.existsSync(metaPath), true);

  // 写完第一章、轮到第二章时：外部（同步盘 / 另一个窗口）删掉 书目.json，并让这次写盘失败。
  const restore = patchRename((from, to) => {
    if (to.endsWith(`${path.sep}${secondFile}`) && !to.includes(`${path.sep}_trash${path.sep}`)) {
      fsSync.rmSync(metaPath, { force: true });
      return 'EACCES';
    }
    return '';
  });
  let failed = null;
  try {
    failed = await storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' }).then(() => null, (err) => err);
  } finally {
    restore();
  }
  assert.ok(failed && /REPLACE_FAILED/.test(String(failed.code)), '保存失败必须走 REPLACE_FAILED');
  assert.equal(fsSync.existsSync(metaPath), false, '失败路径不许用 ensureDir 重建 书目.json（影子书目）');
  assert.ok(failed.message.includes('替换中途停下'), '原始失败原因仍要如实回包');
});

test('RECOV-02：整本整理中途书文件夹被外部删掉并写失败 → 不重建书文件夹', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '失败不重建目录');
  await storage.createChapter(bookPath, 1, '第二章');
  const meta = await storage.readBookMeta(bookPath);
  const secondFile = meta.chapters[1].file;
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '  第一段。  ');
  await storage.saveChapterText(bookPath, secondFile, '  第二段。  ');

  // 写完第一章、轮到第二章时：整本书文件夹被外部移走（回收站 / 同步盘），写盘再失败。
  const restore = patchRename((from, to) => {
    if (to.endsWith(`${path.sep}${secondFile}`) && !to.includes(`${path.sep}_trash${path.sep}`)) {
      fsSync.rmSync(bookPath, { recursive: true, force: true });
      return 'EPERM';
    }
    return '';
  });
  let failed = null;
  try {
    failed = await storage.formatBook(bookPath, { trimTrailing: true }).then(() => null, (err) => err);
  } finally {
    restore();
  }
  assert.ok(failed && /FORMAT_FAILED/.test(String(failed.code)), '保存失败必须走 FORMAT_FAILED');
  assert.equal(fsSync.existsSync(bookPath), false, '失败路径不许用 ensureDir 重建书文件夹');
});

test('RECOV-02（静态闸门）：失败补写先确认书目存在 + ensureDir:false；两处 saveChapterText 同口径', () => {
  const persistBody = functionBody(STORAGE_SOURCE, 'async function persistCharsAfterFailure(', '');
  assert.match(persistBody, /fs\.stat\(path\.join\(bookPath, BOOK_FILE\)\)/, '写前必须确认 书目.json 还在');
  assert.match(persistBody, /ensureDir: false/, '失败补写不许 ensureDir 重建书文件夹');
  const replaceBody = functionBody(STORAGE_SOURCE, 'async function replaceInBook(', '');
  assert.match(
    replaceBody,
    /saveChapterText\(bookPath, chapter\.file, res\.text, \{ ensureDir: false \}\)/,
    '整本替换的章节写盘必须带 ensureDir:false'
  );
  const formatBody = functionBody(STORAGE_SOURCE, 'async function formatBook(', '');
  assert.match(
    formatBody,
    /saveChapterText\(bookPath, chapter\.file, res\.text, \{ ensureDir: false \}\)/,
    '整本整理的章节写盘必须带 ensureDir:false'
  );
});
