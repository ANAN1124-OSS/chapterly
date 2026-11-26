// 数据安全回归（v0.9 C-7，安全审计 C7）。
//
// 只补「之前没人钉住」的场景，不改数据格式、不改行为契约。四条线：
//   1. `_trash` 备份完整性：整本替换 / 整本整理写盘前都留备份，**数量与内容对得上**；
//      同一秒内连做两次替换不能再共用同一个备份目录（老实现会盖掉前一份）。
//   2. 书目损坏恢复：半写 / 坏 JSON / 缺字段的读法，以及「从 .bak 恢复」的边界
//      （.bak 也坏时主文件必须一个字节都不动）。
//   3. 写盘失败不留半成品：书目 / 章节写盘失败时，磁盘上还是完整的上一个版本。
//   4. 原子写是唯一写盘通道（见 tests/atomic.test.js）。
//
// 已有用例（不在本文件里重复）：storage-chapter.test.js 的替换 / 整理 / 还原备份往返、
// repair.test.js 的重建与 .bak 恢复主流程、conflict.test.js 的同步副本识别。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const storage = require('../core/storage');
const repair = require('../core/repair');

const tmpCleanup = require('./tmp-cleanup');

// TB-02：临时目录统一经 tests/tmp-cleanup.js 的 mkTmp（mkdtemp + 登记回收）。
const mkTmp = (prefix = 'cw-data-safety-') => tmpCleanup.mkTmp(prefix);

// 临时让 rename 失败（模拟「文件被杀软 / 同步盘占住」）；返回 restore()，必须放 finally。
function patchRename(impl) {
  const real = fs.rename;
  Object.defineProperty(fs, 'rename', { value: impl, configurable: true, writable: true });
  return () => Object.defineProperty(fs, 'rename', { value: real, configurable: true, writable: true });
}

function fsError(code) {
  return Object.assign(new Error(`${code}: 模拟失败`), { code });
}

// 审计修复 #3（E3）：让指定路径的 stat.size 比真实值多 1 字节，
// 模拟「备份复制期间源文件被外部改写 / 写短」，验证复制后尺寸校验与残件清理。
// 返回 restore()，必须放 finally。
function patchStatSize(targetPath, extra = 1) {
  const real = fs.stat;
  const wanted = path.resolve(targetPath);
  Object.defineProperty(fs, 'stat', {
    configurable: true,
    writable: true,
    value: async (p, ...rest) => {
      const stat = await real(p, ...rest);
      if (path.resolve(String(p)) !== wanted) return stat;
      const copy = Object.create(stat);
      Object.defineProperty(copy, 'size', { value: stat.size + extra, enumerable: true });
      return copy;
    }
  });
  return () => Object.defineProperty(fs, 'stat', { value: real, configurable: true, writable: true });
}

async function txtUnder(trashDir, prefix = '') {
  let entries;
  try {
    entries = await fs.readdir(trashDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const files = await fs.readdir(path.join(trashDir, entry.name));
    for (const name of files) if (name.endsWith('.txt')) found.push(`${entry.name}/${name}`);
  }
  return found;
}

async function tmpEntries(dir) {
  const names = await fs.readdir(dir);
  return names.filter((name) => name.includes('.tmp-'));
}

test('整本替换：同一秒内连做两次，各自留一份独立备份（不再共用同名目录 / 不盖掉前一份）', async (t) => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '同一秒两次替换');
  const meta = await storage.readBookMeta(bookPath);
  const file0 = meta.chapters[0].file;
  await storage.saveChapterText(bookPath, file0, '阿明来了。');

  // 冻结时钟（只冻 Date，不动 setTimeout）：两次替换的时间戳精确到秒，正常使用时两次之间
  // 隔了好几分钟不会撞名；这里把那唯一会撞名的情况**确定地**造出来。
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 10, 1, 21, 30, 0).getTime() });
  const first = await storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' });
  const second = await storage.replaceInBook(bookPath, { query: '小明', replacement: '小红' });
  t.mock.timers.reset();

  assert.ok(first.backupDir && second.backupDir);
  assert.notEqual(second.backupDir, first.backupDir, '两次替换必须落在两个不同的备份目录');
  assert.match(path.basename(second.backupDir), /^替换备份-.*-2$/, '撞名时按老规矩加 -2');
  // 第一份备份是「最初的原文」，第二份是「第一次替换之后的正文」——各是各的，没有被覆盖
  assert.equal(await fs.readFile(path.join(first.backupDir, file0), 'utf8'), '阿明来了。');
  assert.equal(await fs.readFile(path.join(second.backupDir, file0), 'utf8'), '小明来了。');

  const list = await storage.listReplaceBackups(bookPath);
  assert.equal(list.length, 2, '两份备份都要能被「本书历史 / 还原到替换前」看到');
  assert.equal(list[0].name, path.basename(second.backupDir), '最近一次排最前');
  assert.equal(list[1].name, path.basename(first.backupDir));

  // 还原「最早那一份」= 回到最初正文（如果两次共用目录，这一步会还原成混合状态）
  const restored = await storage.restoreReplaceBackup(bookPath, list[1].name);
  assert.equal(restored.restored, 1);
  assert.equal((await storage.loadChapterText(bookPath, file0)).text, '阿明来了。');
});

test('整本替换备份：只备本次真正改动的章，内容是写盘前的原始字节（BOM / CRLF 原样）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '只备改动章');
  await storage.createChapter(bookPath, 1, '第二章');
  await storage.createChapter(bookPath, 2, '第三章');
  const meta = await storage.readBookMeta(bookPath);
  const [file0, file1, file2] = meta.chapters.map((chapter) => chapter.file);
  // 第 1、3 章命中；第 2 章不命中（不该被备份，更不该被改写）
  const raw0 = '\uFEFF阿明来了。\r\n第二段。\r\n';
  const raw2 = '阿明走了。';
  await fs.writeFile(path.join(bookPath, file0), raw0, 'utf8');
  await fs.writeFile(path.join(bookPath, file1), '这里没有那个人。', 'utf8');
  await fs.writeFile(path.join(bookPath, file2), raw2, 'utf8');

  const res = await storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' });
  assert.equal(res.chaptersChanged, 2);
  const backupNames = (await fs.readdir(res.backupDir)).sort();
  assert.deepEqual(backupNames, [file0, file2].sort(), '备份里只该有本次改动的章');
  // 逐字节：copyFile 的备份必须和写盘前完全一致（含 BOM 与 CRLF），以后还原才能回到原样
  assert.equal(await fs.readFile(path.join(res.backupDir, file0), 'utf8'), raw0);
  assert.equal(await fs.readFile(path.join(res.backupDir, file2), 'utf8'), raw2);
  // 写盘后：CRLF 保留、BOM 不写回（读入时已剥掉），没命中的章一个字节没动
  assert.equal(await fs.readFile(path.join(bookPath, file0), 'utf8'), '小明来了。\r\n第二段。\r\n');
  assert.equal(await fs.readFile(path.join(bookPath, file1), 'utf8'), '这里没有那个人。');
});

test('整本整理备份：备份章数 == 预检查的「会改动 N 章」，内容与整理前逐字节一致', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '整理备份完整性');
  await storage.createChapter(bookPath, 1, '第二章');
  await storage.createChapter(bookPath, 2, '第三章');
  let meta = await storage.readBookMeta(bookPath);
  const files = meta.chapters.map((chapter) => chapter.file);
  const raws = ['他说,"第一段。"\r\n第二段\r\n', '　　这一章本来就干净。\r\n', '他说..."第三段"'];
  for (let i = 0; i < files.length; i += 1) {
    await fs.writeFile(path.join(bookPath, files[i]), raws[i], 'utf8');
  }
  const options = { indent: '2', blankLines: 'single', normalizePunct: true, curlyQuotes: true, ellipsis: true };
  const preview = await storage.previewFormatBook(bookPath, options);
  assert.equal(preview.chaptersChanged, 2, '第 2 章本来就干净，不该算改动');

  const res = await storage.formatBook(bookPath, options);
  assert.equal(res.chaptersChanged, preview.chaptersChanged);
  const backupNames = (await fs.readdir(res.backupDir)).sort();
  assert.equal(backupNames.length, preview.chaptersChanged, '备份章数必须和「会改动 N 章」一致');
  for (const name of backupNames) {
    const index = files.indexOf(name);
    assert.ok(index >= 0, `备份里出现了不认识的章节文件：${name}`);
    assert.equal(await fs.readFile(path.join(res.backupDir, name), 'utf8'), raws[index], `${name} 的备份要和整理前逐字节一致`);
  }
  // 干净的那一章既没被备份，也没被改写
  assert.equal(backupNames.includes(files[1]), false);
  assert.equal(await fs.readFile(path.join(bookPath, files[1]), 'utf8'), raws[1]);
});

// 审计修复 #3（E3）：备份从「裸 fs.copyFile」改成 atomicCopyFile + 复制后尺寸校验。
// 复制期间源被外部改写 / 写短时，必须在写正文之前失败，并删掉那份不可信的备份 ——
// 不然失败提示会指着一份半截备份说「可以从那里把原文拷回来」，还原时还会用它覆盖正文。
test('审计修复 #3（E3）：整本替换备份尺寸不符 → 失败且不留半截备份，正文一个字节不动', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '替换备份尺寸校验');
  const meta = await storage.readBookMeta(bookPath);
  const file0 = meta.chapters[0].file;
  const chapterPath = path.join(bookPath, file0);
  await fs.writeFile(chapterPath, '阿明来了。', 'utf8');

  const restoreStat = patchStatSize(chapterPath);
  try {
    await assert.rejects(
      () => storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' }),
      (err) => {
        assert.equal(err.code, 'REPLACE_FAILED');
        assert.match(err.message, /字节数与源文件不一致/);
        assert.match(err.message, /书里的正文一个字节都没改/);
        return true;
      }
    );
  } finally {
    restoreStat();
  }
  // 正文没被改、备份目录里没有可被误用的半截 txt、也没有残留临时文件
  assert.equal(await fs.readFile(chapterPath, 'utf8'), '阿明来了。');
  assert.deepEqual(await txtUnder(path.join(bookPath, '_trash')), []);
  assert.deepEqual(await tmpEntries(path.join(bookPath, '_trash')), []);
});

test('审计修复 #3（E3）：整本整理备份尺寸不符 → 失败且不留半截备份，正文一个字节不动', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '整理备份尺寸校验');
  const meta = await storage.readBookMeta(bookPath);
  const file0 = meta.chapters[0].file;
  const chapterPath = path.join(bookPath, file0);
  const raw = '他说,"第一段。"\r\n第二段\r\n';
  await fs.writeFile(chapterPath, raw, 'utf8');
  const options = { indent: '2', blankLines: 'single', normalizePunct: true, curlyQuotes: true, ellipsis: true };

  const restoreStat = patchStatSize(chapterPath);
  try {
    await assert.rejects(
      () => storage.formatBook(bookPath, options),
      (err) => {
        assert.equal(err.code, 'FORMAT_FAILED');
        assert.match(err.message, /字节数与源文件不一致/);
        return true;
      }
    );
  } finally {
    restoreStat();
  }
  assert.equal(await fs.readFile(chapterPath, 'utf8'), raw);
  assert.deepEqual(await txtUnder(path.join(bookPath, '_trash')), []);
});

test('审计修复 #3（E3）：还原前备份同样原子 + 尺寸校验；失败时不覆盖正文', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '还原前备份尺寸校验');
  const meta = await storage.readBookMeta(bookPath);
  const file0 = meta.chapters[0].file;
  const chapterPath = path.join(bookPath, file0);
  await storage.saveChapterText(bookPath, file0, '阿明来了。');
  const replaced = await storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' });
  assert.equal((await storage.loadChapterText(bookPath, file0)).text, '小明来了。');
  const backupName = path.basename(replaced.backupDir);

  const restoreStat = patchStatSize(chapterPath);
  try {
    await assert.rejects(
      () => storage.restoreReplaceBackup(bookPath, backupName),
      (err) => {
        assert.equal(err.code, 'RESTORE_FAILED');
        assert.match(err.message, /字节数与源文件不一致/);
        return true;
      }
    );
  } finally {
    restoreStat();
  }
  assert.equal((await storage.loadChapterText(bookPath, file0)).text, '小明来了。', '还原前的正文不许被半截备份写坏');
  assert.deepEqual(await txtUnder(path.join(bookPath, '_trash'), '还原前备份-'), [], '还原前备份目录里不许留半截文件');
});

test('书目.json.bak：等于「上一版」的原始字节，不是重新序列化出来的', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '备份逐字节');
  const metaPath = path.join(bookPath, '书目.json');
  const bakPath = path.join(bookPath, '书目.json.bak');
  const before = await fs.readFile(metaPath, 'utf8');
  await storage.renameBook(bookPath, '备份逐字节-改名');
  assert.equal(await fs.readFile(bakPath, 'utf8'), before, '.bak 必须是改名前的完整原文');
  const after = await fs.readFile(metaPath, 'utf8');
  assert.notEqual(after, before);
  assert.equal(JSON.parse(after).title, '备份逐字节-改名');
});

test('书目半写（截断）：读取报 PARSE_ERROR 且不写盘；从 .bak 恢复后章节与正文完整、坏文件留档', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '半写书目');
  await storage.createChapter(bookPath, 1, '第二章');
  let meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '第一章正文。');
  await storage.saveChapterText(bookPath, meta.chapters[1].file, '第二章正文。');
  // 造出「上一版」的 .bak（改名会先备份上一版），再把主文件截断成半写状态
  await storage.renameBook(bookPath, '半写书目-改名');
  const metaPath = path.join(bookPath, '书目.json');
  const bakPath = path.join(bookPath, '书目.json.bak');
  const full = await fs.readFile(metaPath, 'utf8');
  const truncated = full.slice(0, Math.floor(full.length * 0.6));
  await fs.writeFile(metaPath, truncated, 'utf8');
  const bakBefore = await fs.readFile(bakPath, 'utf8');

  await assert.rejects(() => storage.readBookMeta(bookPath), (err) => err.code === 'PARSE_ERROR');
  // 读取失败不许改动磁盘：主文件与 .bak 都原样
  assert.equal(await fs.readFile(metaPath, 'utf8'), truncated);
  assert.equal(await fs.readFile(bakPath, 'utf8'), bakBefore);
  assert.deepEqual(await tmpEntries(bookPath), []);

  const restored = await repair.restoreFromBak(bookPath);
  assert.equal(restored.meta.title, '半写书目', '恢复到 .bak 里的上一版');
  assert.equal(restored.meta.chapters.length, 2);
  const corrupt = (await fs.readdir(bookPath)).filter((name) => name.startsWith('书目.json.corrupt-'));
  assert.equal(corrupt.length, 1, '半写的书目必须留档，不是被删掉');
  assert.equal(await fs.readFile(path.join(bookPath, corrupt[0]), 'utf8'), truncated);
  // 恢复后正文一个字节没丢
  const after = await storage.readBookMeta(bookPath);
  assert.equal((await storage.loadChapterText(bookPath, after.chapters[0].file)).text, '第一章正文。');
  assert.equal((await storage.loadChapterText(bookPath, after.chapters[1].file)).text, '第二章正文。');
});

test('书目缺字段 / 坏形状：INVALID_META 明确报错，绝不半还原、不写盘', async () => {
  const cases = [
    { name: '章节记录不是对象', raw: { chapters: [42] } },
    { name: '章节缺少 file', raw: { chapters: [{ id: 'ch_001', name: '起风' }] } },
    { name: '章节 file 是空串', raw: { chapters: [{ file: '   ' }] } },
    { name: 'chapters 不是数组', raw: { chapters: { 1: { file: '001-起风.txt' } } } },
    { name: '顶层是数组', raw: [{ chapters: [] }] },
    { name: '顶层是 null', raw: null }
  ];
  for (const item of cases) {
    const root = await mkTmp();
    const bookPath = path.join(root, '坏形状');
    await fs.mkdir(bookPath);
    const metaPath = path.join(bookPath, '书目.json');
    const text = JSON.stringify(item.raw);
    await fs.writeFile(metaPath, text, 'utf8');
    await assert.rejects(
      () => storage.readBookMeta(bookPath),
      (err) => err.code === 'INVALID_META',
      item.name
    );
    assert.equal(await fs.readFile(metaPath, 'utf8'), text, `${item.name}：读失败不许写盘`);
  }
});

test('从 .bak 恢复：.bak 也坏时抛 BAK_INVALID，主文件一个字节都不动（不先改名 / 不盖掉）', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '双坏');
  await fs.mkdir(bookPath);
  const metaPath = path.join(bookPath, '书目.json');
  const bakPath = path.join(bookPath, '书目.json.bak');
  await fs.writeFile(metaPath, '{ 主文件也坏', 'utf8');
  await fs.writeFile(bakPath, '{"chapters": [', 'utf8');
  await assert.rejects(() => repair.restoreFromBak(bookPath), (err) => err.code === 'BAK_INVALID');
  assert.equal(await fs.readFile(metaPath, 'utf8'), '{ 主文件也坏');
  assert.equal(await fs.readFile(bakPath, 'utf8'), '{"chapters": [');
  assert.equal(
    (await fs.readdir(bookPath)).some((name) => name.startsWith('书目.json.corrupt-')),
    false,
    '确认 .bak 能用之前不许把主文件改名'
  );
  // .bak 结构不完整（不是坏 JSON，而是没有 chapters）同样拒绝
  await fs.writeFile(bakPath, '{"title":"x"}', 'utf8');
  await assert.rejects(() => repair.restoreFromBak(bookPath), (err) => err.code === 'BAK_INVALID');
  assert.equal(await fs.readFile(metaPath, 'utf8'), '{ 主文件也坏');
});

test('书目写盘失败（文件被占）：主文件与 .bak 都还是完整的上一个版本、不留临时文件', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '写盘失败回退');
  const metaPath = path.join(bookPath, '书目.json');
  const bakPath = path.join(bookPath, '书目.json.bak');
  const mainBefore = await fs.readFile(metaPath, 'utf8');

  let attempts = 0;
  const restore = patchRename(async () => {
    attempts += 1;
    throw fsError('EACCES');
  });
  try {
    await assert.rejects(() => storage.renameBook(bookPath, '不该生效的新名'));
  } finally {
    restore();
  }
  assert.ok(attempts >= 1, '确实走到了 rename');
  assert.equal(await fs.readFile(metaPath, 'utf8'), mainBefore, '主文件必须还是上一版');
  assert.equal(JSON.parse(mainBefore).title, '写盘失败回退');
  assert.equal(JSON.parse(await fs.readFile(metaPath, 'utf8')).title, '写盘失败回退');
  assert.deepEqual(await tmpEntries(bookPath), [], '不许留下临时文件');
  // 失败之后恢复正常，下一次写盘照常（不会因为一次失败就把书卡成只读）
  await storage.renameBook(bookPath, '写盘失败回退-改名');
  assert.equal(JSON.parse(await fs.readFile(metaPath, 'utf8')).title, '写盘失败回退-改名');
  assert.equal(await fs.readFile(bakPath, 'utf8'), mainBefore, '恢复后的 .bak 是失败前的那一版');
});

test('章节保存失败：磁盘上还是完整的旧正文、书目不动、不留临时文件', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '章节保存失败');
  const meta = await storage.readBookMeta(bookPath);
  const file = meta.chapters[0].file;
  await storage.saveChapterText(bookPath, file, '原来的正文。');
  const metaBefore = await fs.readFile(path.join(bookPath, '书目.json'), 'utf8');
  const textBefore = await fs.readFile(path.join(bookPath, file), 'utf8');

  const restore = patchRename(async () => {
    throw fsError('EPERM');
  });
  try {
    await assert.rejects(() => storage.saveChapterText(bookPath, file, '不该写进去的新正文。'), (err) => err.code === 'EPERM');
  } finally {
    restore();
  }
  assert.equal(await fs.readFile(path.join(bookPath, file), 'utf8'), textBefore, '旧正文必须完好');
  assert.equal(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'), metaBefore, '保存失败不该动书目');
  assert.deepEqual(await tmpEntries(bookPath), []);
  // 恢复正常后能正常保存
  await storage.saveChapterText(bookPath, file, '恢复后的新正文。');
  assert.equal((await storage.loadChapterText(bookPath, file)).text, '恢复后的新正文。');
});

// V221-SAVE-01（2026-11-26 复核）：保存前的两次 stat 以前一律 catch 成「文件已经不在了」——
// EACCES / EBUSY / BAD_PATH 被伪装成 BOOK_MISSING / CHAPTER_MISSING，作者会被引去「修复」。
// 现在只有 ENOENT 走「没了」，其余错误如实带错误码抛出；ENOENT 语义不变。
test('V221-SAVE-01：保存前 stat 的权限/占用错误如实报出，不伪装成书或章节没了', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '权限错误');
  const meta = await storage.readBookMeta(bookPath);
  const chapter = meta.chapters[0];
  const chapterPath = path.join(bookPath, chapter.file);
  const realStat = fs.stat;
  const patchStat = (shouldFail) => {
    Object.defineProperty(fs, 'stat', {
      value: async (target, ...rest) => {
        if (shouldFail(target)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return realStat(target, ...rest);
      },
      configurable: true,
      writable: true
    });
  };
  const restore = () => Object.defineProperty(fs, 'stat', { value: realStat, configurable: true, writable: true });

  // ① 书文件夹 stat 失败
  patchStat((target) => path.resolve(String(target)) === path.resolve(bookPath));
  let bookErr = null;
  try {
    await storage.prepareChapterSave(bookPath, chapter.id, {});
  } catch (err) {
    bookErr = err;
  } finally {
    restore();
  }
  assert.equal(bookErr && bookErr.code, 'EACCES', '书文件夹读不出来要保留真实错误码');
  assert.doesNotMatch(String(bookErr && bookErr.message), /已经不在了/);

  // ② 章节文件 stat 失败
  patchStat((target) => path.resolve(String(target)) === path.resolve(chapterPath));
  let chapterErr = null;
  try {
    await storage.prepareChapterSave(bookPath, chapter.id, {});
  } catch (err) {
    chapterErr = err;
  } finally {
    restore();
  }
  assert.equal(chapterErr && chapterErr.code, 'EACCES');
  assert.doesNotMatch(String(chapterErr && chapterErr.message), /已经不在了/);

  // ③ 写盘前复核同口径（recheckChapterSaveTarget）
  await storage.saveChapterText(bookPath, chapter.file, '正文。');
  const after = await storage.readBookMeta(bookPath);
  const statAfter = await fs.stat(chapterPath);
  patchStat((target) => path.resolve(String(target)) === path.resolve(chapterPath));
  let recheckErr = null;
  try {
    await storage.recheckChapterSaveTarget(bookPath, after.chapters[0], statAfter.mtimeMs);
  } catch (err) {
    recheckErr = err;
  } finally {
    restore();
  }
  assert.equal(recheckErr && recheckErr.code, 'EACCES');

  // ④ 真没了仍是 BOOK_MISSING（语义不变）
  await fs.rm(bookPath, { recursive: true, force: true });
  const gone = await storage.prepareChapterSave(bookPath, chapter.id, {}).then(() => null, (err) => err);
  assert.equal(gone && gone.code, 'BOOK_MISSING');
});

// V221-STORAGE-02（2026-11-26 复核）：整本替换 / 整理在「备份已建、但一章都没改成」时，旧提示同时说
// 「替换前的原文都在备份」和「书里的正文一个字节都没改」——两句并列自相矛盾。现在 0 章改动时改用
// 「本轮开始前的原文副本在…（没有任何正文被改）」。
test('V221-STORAGE-02：整本替换 0 章改动就失败 → 提示不再自相矛盾', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '替换零章失败');
  const meta = await storage.readBookMeta(bookPath);
  await storage.saveChapterText(bookPath, meta.chapters[0].file, '阿明来了。');
  const realRename = fs.rename;
  const restore = patchRename(async (from, to) => {
    if (/\.txt$/i.test(String(to))) {
      throw fsError('EPERM');
    }
    return realRename(from, to);
  });
  let error = null;
  try {
    await storage.replaceInBook(bookPath, { query: '阿明', replacement: '小明' });
  } catch (err) {
    error = err;
  } finally {
    restore();
  }
  assert.equal(error && error.code, 'REPLACE_FAILED', '中途失败要保留 REPLACE_FAILED');
  assert.match(error.message, /一个字节都没改/);
  assert.match(error.message, /本轮开始前的原文副本在/, '备份目录存在时如实说明它只是开始前的副本');
  assert.doesNotMatch(error.message, /替换前的原文都在/, '0 章改动时不许说「替换前的原文都在」');
});

// V221-STORAGE-03（2026-11-26 复核）：章节 txt 在应用外被删 / 改名时，删除动作旧实现整次失败
// （TRASH_FAILED），书目里留下一条点开就缺章、应用内无出口的死记录。ENOENT = 文件已经不在：
// 跳过备份、继续从书目移除；正常删章仍进 _trash 并可撤销。
test('V221-STORAGE-03：章节文件在应用外没了 → 仍能从书目删除，不再 TRASH_FAILED 卡死', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await storage.createBook(root, '外部删章');
  const meta0 = await storage.readBookMeta(bookPath);
  const chapter = meta0.chapters[0];
  await fs.rm(path.join(bookPath, chapter.file), { force: true });
  const result = await storage.deleteChapter(bookPath, chapter.id);
  assert.equal(result.sourceMissing, true, '回执要如实说明章节文件已经不在了');
  assert.equal(result.trashPath, null, '没有文件可备份');
  const after = await storage.readBookMeta(bookPath);
  assert.equal(after.chapters.length, 0, '书目里不能留下点开就缺章的死记录');
  // 正常删章不受影响：文件移进 _trash、回传备份路径
  const created = await storage.createChapter(bookPath, 0, '第二章');
  const normal = await storage.deleteChapter(bookPath, created.chapter.id);
  assert.equal(normal.sourceMissing, false);
  assert.ok(normal.trashPath && normal.trashPath.includes('_trash'), '正常删除仍要留备份供撤销');
});
