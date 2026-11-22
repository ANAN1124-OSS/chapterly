// I2（三审·中）：书目单条 CRUD 的「读时拍身份、写前核对」。
//
// 背景：同一份 书目.json 的写通道，外部改动保护（expectedStamp 读时拍 size + mtimeMs、写前核对，
// 不一致拒 META_CHANGED）以前只有保存链与批量 / 整本类有；全部单条 CRUD（改名 / 建章 / 改章名 /
// 卷操作 / move 族 / 更新书籍信息 / 编号方式 / setLastOpenChapter / 删章 / 撤销删章…）不带 stamp，
// 只靠 withBookLock 串进程内写入 —— 同步盘 / 记事本在「读 meta → 写 meta」的间隙改了书目，会被
// 内存快照整份静默覆盖，旧版只剩 .bak 一代。
//
// 本文件钉两件事：
//   ① 行为：外部改动发生在间隙里 → 抛 META_CHANGED（或包着它的 batchFailure，如 DELETE_FAILED），
//     外部那一版逐字节保留、.bak 不轮换、建章 / 删章不留半成品；
//   ② 机器清单：单条 CRUD 一律走 writeBookMetaChecked（stampOfMeta → expectedStamp），
//     批量 / 整本类继续显式传 expectedStamp —— 新增单条写入口漏用就红。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');

const storage = require('../core/storage');
const tmpCleanup = require('./tmp-cleanup');

const mkTmp = (prefix = 'cw-stamp-') => tmpCleanup.mkTmp(prefix);

const STORAGE_SOURCE = fsSync
  .readFileSync(path.join(__dirname, '..', 'core', 'storage.js'), 'utf8')
  .replace(/\r\n/g, '\n');

// 取一个顶层函数的函数体：从 `async function X(` / `function X(` 到下一个顶格 `}\n`。
function topLevelBody(name) {
  const start = STORAGE_SOURCE.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.notEqual(start, -1, `storage.js 找不到 ${name}`);
  const end = STORAGE_SOURCE.indexOf('\n}\n', start);
  return end < 0 ? STORAGE_SOURCE.slice(start) : STORAGE_SOURCE.slice(start, end);
}

async function makeBook(root) {
  return storage.createBook(root, '邮戳书');
}

const META_FILE = '书目.json';

// 在第 **2** 次 open(书目.json) 之前把文件替换成外部版本：
//   第 1 次是 readBookMeta（读时拍身份）；
//   第 2 次是 writeBookMeta 的写前核对 / 轮换读 —— 此刻文件已经是外部那一版，
//   与读时拍下的 stamp 不一致，正是 I2 要拦下的那个间隙。
async function withExternalMetaRewrite(metaPath, externalText, fn) {
  const realOpen = fs.open;
  let opens = 0;
  let rewritten = false;
  fs.open = async function patched(file, flags, ...rest) {
    if (path.resolve(String(file)) === path.resolve(metaPath)) {
      opens += 1;
      if (opens === 2 && !rewritten) {
        rewritten = true;
        const handle = await realOpen.call(fs, metaPath, 'w');
        try {
          await handle.writeFile(externalText, 'utf8');
        } finally {
          await handle.close();
        }
      }
    }
    return realOpen.call(fs, file, flags, ...rest);
  };
  try {
    return await fn();
  } finally {
    fs.open = realOpen;
  }
}

// 外部版本：合法 JSON（同步盘 / 记事本改过的那一版），标题带标记、体积明显不同。
function externalMetaText(meta) {
  return `${JSON.stringify({ ...meta, title: '外部改过的书名', externalMarker: 'x'.repeat(200) }, null, 2)}\n`;
}

const readRaw = (file) => fs.readFile(file, 'utf8');

// .bak 的现状（不存在 = null）：用来钉「拒绝时 .bak 不轮换」。
async function bakState(bookPath) {
  try {
    return await readRaw(path.join(bookPath, '书目.json.bak'));
  } catch {
    return null;
  }
}

// 在间隙里改外部版本时要认真实错误；返回 { outcome, error }。
async function runWithExternalChange(bookPath, externalText, run) {
  const metaPath = path.join(bookPath, META_FILE);
  let outcome = null;
  let error = null;
  await withExternalMetaRewrite(metaPath, externalText, async () => {
    try {
      outcome = await run();
    } catch (err) {
      error = err;
    }
  });
  return { outcome, error, externalText };
}

test('I2：renameBook 在读写间隙被外部改过 → META_CHANGED，外部版本逐字节保留、.bak 不轮换', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await makeBook(root);
  const meta = await storage.readBookMeta(bookPath);
  const bakBefore = await bakState(bookPath);

  const { error, externalText } = await runWithExternalChange(bookPath, externalMetaText(meta), () =>
    storage.renameBook(bookPath, '改名后的书')
  );
  assert.ok(error, '必须拒绝这次改名');
  assert.equal(error.code, 'META_CHANGED');
  assert.match(error.message, /被应用外的程序改过/);
  assert.equal(error.message.includes(root), false, '错误文案不带本机完整路径');
  assert.equal(await readRaw(path.join(bookPath, META_FILE)), externalText, '外部那一版逐字节保留');
  assert.equal(await bakState(bookPath), bakBefore, '.bak 不许轮换（拒绝必须早于备份）');
});

test('I2：建章在间隙被外部改过 → META_CHANGED，新章节文件不留在书里', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await makeBook(root);
  const meta = await storage.readBookMeta(bookPath);
  const before = (await fs.readdir(bookPath)).sort();
  const bakBefore = await bakState(bookPath);

  const { error, externalText } = await runWithExternalChange(bookPath, externalMetaText(meta), () =>
    storage.createChapterWithText(bookPath, { insertIndex: 1, name: '新章', text: '正文' })
  );
  assert.ok(error);
  assert.equal(error.code, 'META_CHANGED');
  assert.deepEqual((await fs.readdir(bookPath)).sort(), before, '建章失败：不留新章节文件');
  assert.equal(await readRaw(path.join(bookPath, META_FILE)), externalText, '外部版本保留');
  assert.equal(await bakState(bookPath), bakBefore, '.bak 不许轮换');
});

test('I2：改章名 / 章节状态备注 / 书籍信息 / 编号方式 / setLastOpenChapter 都带写前核对', async () => {
  const root = await mkTmp();
  const items = [
    {
      name: 'renameChapter',
      make: async (bookPath) => storage.readBookMeta(bookPath),
      run: (bookPath, meta) => storage.renameChapter(bookPath, meta.chapters[0].id, '新章名'),
      expect: (result) => assert.equal(result.ok, true)
    },
    {
      name: 'updateChapterMeta',
      make: async (bookPath) => storage.readBookMeta(bookPath),
      run: (bookPath, meta) => storage.updateChapterMeta(bookPath, meta.chapters[0].id, { status: 'done', note: '备注' })
    },
    {
      name: 'updateBookInfo',
      make: async (bookPath) => storage.readBookMeta(bookPath),
      run: (bookPath) => storage.updateBookInfo(bookPath, { author: '作者' })
    },
    {
      name: 'setChapterNumbering',
      make: async (bookPath) => storage.readBookMeta(bookPath),
      run: (bookPath) => storage.setChapterNumbering(bookPath, 'volume')
    },
    {
      name: 'setLastOpenChapter',
      // setLastOpenChapter 只在「目标章与当前记录不同」时才写盘：先建第二章，再切过去。
      make: async (bookPath) => {
        await storage.createChapter(bookPath, 1, '第二章');
        return storage.readBookMeta(bookPath);
      },
      run: (bookPath, meta) => storage.setLastOpenChapter(bookPath, meta.chapters[1].id)
    }
  ];
  for (const item of items) {
    const { path: bookPath } = await makeBook(root);
    const meta = await item.make(bookPath);
    const bakBefore = await bakState(bookPath);
    const { outcome, error, externalText } = await runWithExternalChange(bookPath, externalMetaText(meta), () =>
      item.run(bookPath, meta)
    );
    if (item.name === 'setLastOpenChapter') {
      // 它本来就是「尽力而为」的切章记忆：错误被吞成 { ok:false, code }，但绝不能假装成功。
      assert.equal(error, null);
      assert.equal(outcome.ok, false, 'setLastOpenChapter 不许假装成功');
      assert.equal(outcome.code, 'META_CHANGED');
    } else {
      assert.ok(error, `${item.name} 必须拒绝这次写入`);
      assert.equal(error.code, 'META_CHANGED', `${item.name}: ${error.message}`);
    }
    assert.equal(await readRaw(path.join(bookPath, META_FILE)), externalText, `${item.name}：外部版本保留`);
    assert.equal(await bakState(bookPath), bakBefore, `${item.name}：.bak 不许轮换`);
  }
});

test('I2：卷三操作（建 / 改名 / 删 / 排序）在间隙被外部改过都拒绝', async () => {
  const root = await mkTmp();
  const items = [
    { name: 'createVolume', run: (bookPath) => storage.createVolume(bookPath, '新卷') },
    { name: 'renameVolume', run: (bookPath, ids) => storage.renameVolume(bookPath, ids.volumeId, '卷改名') },
    { name: 'deleteVolume', run: (bookPath, ids) => storage.deleteVolume(bookPath, ids.volumeId) },
    { name: 'moveVolume', run: (bookPath, ids) => storage.moveVolume(bookPath, ids.volumeId, 0) }
  ];
  for (const item of items) {
    const { path: bookPath } = await makeBook(root);
    // 先建两卷（建卷本身也会写书目，所以放在补丁之外），再在间隙里改外部版本。
    await storage.createVolume(bookPath, '第一卷');
    const second = await storage.createVolume(bookPath, '第二卷');
    const meta = await storage.readBookMeta(bookPath);
    const ids = { volumeId: second.volume.id };
    const bakBefore = await bakState(bookPath);
    const { error, externalText } = await runWithExternalChange(bookPath, externalMetaText(meta), () =>
      item.run(bookPath, ids)
    );
    assert.ok(error, `${item.name} 必须拒绝`);
    assert.equal(error.code, 'META_CHANGED', `${item.name}: ${error.message}`);
    assert.equal(await readRaw(path.join(bookPath, META_FILE)), externalText, `${item.name}：外部版本保留`);
    assert.equal(await bakState(bookPath), bakBefore, `${item.name}：.bak 不许轮换`);
  }
});

test('I2：move 族（拖拽排序 / 跨卷移动 / 移到指定章之前）都带写前核对', async () => {
  const root = await mkTmp();
  const items = [
    { name: 'moveChapter', run: (bookPath, ctx) => storage.moveChapter(bookPath, ctx.firstId, 1) },
    { name: 'moveChapterToVolume', run: (bookPath, ctx) => storage.moveChapterToVolume(bookPath, ctx.firstId, null) },
    { name: 'moveChapterTo', run: (bookPath, ctx) => storage.moveChapterTo(bookPath, ctx.firstId, null, ctx.secondId) }
  ];
  for (const item of items) {
    const { path: bookPath } = await makeBook(root);
    await storage.createChapter(bookPath, 1, '第二章');
    const meta = await storage.readBookMeta(bookPath);
    const ctx = { firstId: meta.chapters[0].id, secondId: meta.chapters[1].id };
    const bakBefore = await bakState(bookPath);
    const { error, externalText } = await runWithExternalChange(bookPath, externalMetaText(meta), () =>
      item.run(bookPath, ctx)
    );
    assert.ok(error, `${item.name} 必须拒绝`);
    assert.equal(error.code, 'META_CHANGED', `${item.name}: ${error.message}`);
    assert.equal(await readRaw(path.join(bookPath, META_FILE)), externalText, `${item.name}：外部版本保留`);
    assert.equal(await bakState(bookPath), bakBefore, `${item.name}：.bak 不许轮换`);
  }
});

test('I2：删章在间隙被外部改过 → 章节文件回滚 + DELETE_FAILED 说明，外部版本保留', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await makeBook(root);
  const meta = await storage.readBookMeta(bookPath);
  const target = meta.chapters[0];
  const bakBefore = await bakState(bookPath);

  const { error, externalText } = await runWithExternalChange(bookPath, externalMetaText(meta), () =>
    storage.deleteChapter(bookPath, target.id)
  );
  assert.ok(error);
  assert.equal(error.code, 'DELETE_FAILED');
  assert.match(error.message, /被应用外的程序改过/);
  assert.match(error.message, /已经放回原处|现在在/);
  assert.equal(await readRaw(path.join(bookPath, META_FILE)), externalText, '外部版本保留');
  assert.equal(await storage.exists(path.join(bookPath, target.file)), true, '章节文件必须回滚回书里');
  assert.equal(await bakState(bookPath), bakBefore, '.bak 不许轮换');
});

test('I2：撤销删章在间隙被外部改过 → 文件回滚 + RESTORE_FAILED，外部版本保留', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await makeBook(root);
  const meta = await storage.readBookMeta(bookPath);
  const target = meta.chapters[0];
  const deleted = await storage.deleteChapter(bookPath, target.id);
  const afterDelete = await storage.readBookMeta(bookPath);
  const bakBefore = await bakState(bookPath);

  const { error, externalText } = await runWithExternalChange(bookPath, externalMetaText(afterDelete), () =>
    storage.restoreDeletedChapterFromTrash(bookPath, {
      chapter: { id: target.id, file: target.file, name: target.name },
      trashName: path.basename(deleted.trashPath),
      index: 0
    })
  );
  assert.ok(error, '必须拒绝这次撤销');
  assert.ok(['RESTORE_FAILED', 'META_CHANGED'].includes(error.code), `错误码：${error.code}`);
  assert.match(error.message, /被应用外的程序改过/);
  assert.equal(await readRaw(path.join(bookPath, META_FILE)), externalText, '外部版本保留');
  assert.equal(await storage.exists(path.join(bookPath, target.file)), false, '回滚后书里没有这一章（仍在 _trash）');
  assert.equal(await bakState(bookPath), bakBefore, '.bak 不许轮换');
});

// 机器清单（T7 方向）：单条 CRUD 的写盘只许走 writeBookMetaChecked（stampOfMeta → expectedStamp）；
// 批量 / 整本类继续在自己的长流程里显式传 expectedStamp。新增单条写入口漏用就红。
test('I2 机器清单：单条 CRUD 一律走 writeBookMetaChecked，批量类显式传 expectedStamp', () => {
  const CRUD = [
    'createChapterWithText',
    'createVolume',
    'renameVolume',
    'deleteVolume',
    'moveChapterToVolume',
    'moveChapterTo',
    'moveVolume',
    'renameChapter',
    'updateChapterMeta',
    'updateBookInfo',
    'setChapterNumbering',
    'deleteChapter',
    'restoreDeletedChapterFromTrash',
    'moveChapter',
    'renameBook',
    'setLastOpenChapter',
    'persistCharsAfterFailure'
  ];
  for (const name of CRUD) {
    const body = topLevelBody(name);
    assert.ok(body.includes('writeBookMetaChecked(bookPath'), `${name} 必须走 writeBookMetaChecked（读时拍身份、写前核对）`);
    assert.equal(/await writeBookMeta\(bookPath/.test(body), false, `${name} 不许再直接 writeBookMeta（会绕过写前核对）`);
  }
  // 批量 / 整本类：各自的长流程里显式把 stamp 传下去（入口不同、语义相同）
  for (const name of [
    'replaceInBook',
    'formatBook',
    'restoreReplaceBackup',
    'restoreHistoryFile',
    'restoreHistoryGroup'
  ]) {
    const body = topLevelBody(name);
    assert.ok(body.includes('expectedStamp: stampOfMeta(meta)'), `${name} 必须显式传 expectedStamp`);
  }
  // helper 只有一份实现：显式 stamp 优先，缺省回落到 meta 自己身上的身份
  const helper = topLevelBody('writeBookMetaChecked');
  assert.match(helper, /expectedStamp: stamp \|\| stampOfMeta\(meta\)/, 'helper 是唯一接线点');
});
