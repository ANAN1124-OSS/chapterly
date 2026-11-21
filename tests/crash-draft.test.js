// WP5（N1 / 中 #6）：可选崩溃草稿仓库（core/crash-draft.js）的行为锚点。
//
// 产品红线（作者拍板项 1=B）：
//   - 默认关：默认配置下一个字节都不写（不建目录 / 不写标记 / 不写草稿）；
//   - 打开后只写 userData（%APPDATA%\chapter-writer\crash-drafts\），绝不写书库 / 书目 / 章节 txt；
//   - 只用于崩溃恢复，不是自动保存；干净退出清标记与草稿；
//   - 任何 IO 失败（ENOSPC / EPERM / 占用）都只能回错误码，绝不抛、绝不影响正文保存。
//
// 本文件用真临时目录（测试隔离）+ 可注入 fs 做失败注入；require 的模块在红阶段尚不存在。
const test = require('node:test');
const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const draftLib = require('../core/crash-draft');
const tmpCleanup = require('./tmp-cleanup');

const BOOK = path.join('C:\\', '书库 有空格', '测试 书');
const roots = [];

async function newRoot() {
  const dir = await tmpCleanup.mkTmp('cw-crash-draft-');
  roots.push(dir);
  return dir;
}

test.after(async () => {
  for (const dir of roots) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function fileErr(code) {
  return Object.assign(new Error(`模拟 ${code}`), { code });
}

// 只包一层会被仓库调到的 fs 方法；失败注入只罩「写临时文件 / rename / mkdir / readFile / unlink」。
// writeFile 的失败只作用于临时文件（和真实 ENOSPC 一样，正式文件的旧版本不会被写坏）。
function failingFs(fail = {}) {
  return {
    mkdir: (...args) => (fail.mkdir ? Promise.reject(fileErr(fail.mkdir)) : fsp.mkdir(...args)),
    writeFile: (file, ...rest) =>
      fail.writeFile && String(file).includes('.tmp-')
        ? Promise.reject(fileErr(fail.writeFile))
        : fsp.writeFile(file, ...rest),
    rename: (...args) => (fail.rename ? Promise.reject(fileErr(fail.rename)) : fsp.rename(...args)),
    readdir: (...args) => fsp.readdir(...args),
    readFile: (...args) => (fail.readFile ? Promise.reject(fileErr(fail.readFile)) : fsp.readFile(...args)),
    stat: (...args) => fsp.stat(...args),
    unlink: (file) => (fail.unlink ? Promise.reject(fileErr(fail.unlink)) : fsp.unlink(file))
  };
}

function storeAt(root, options = {}) {
  return draftLib.createCrashDraftStore(root, options);
}

function draft(overrides = {}) {
  return {
    bookPath: BOOK,
    bookTitle: '测试书',
    chapterId: 'ch_001',
    chapterTitle: '第一章',
    chapterIndex: 0,
    text: '草稿正文',
    ...overrides
  };
}

test('R1 默认关不写盘：建仓库本身不落任何文件；main 只在 crashDraftEnabled === true 时 beginSession', async () => {
  const root = await newRoot();
  const store = storeAt(root);
  assert.equal(store.dir, path.join(path.resolve(root), draftLib.DRAFT_DIR_NAME));
  assert.equal(fsSync.existsSync(store.dir), false, '只 create 不 begin / 不 write 时不能建目录');

  // 静态闸门（政策类）：默认关闭这一事实的接线在 main.js / core/config.js 两处。
  const main = fsSync.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = main.indexOf('async function syncCrashDraftSession');
  assert.ok(start > 0, 'main.js 必须有 syncCrashDraftSession()');
  const block = main.slice(start, main.indexOf('\n}\n', start));
  assert.match(block, /crashDraftEnabled === true/, '只有真正的 true 才开会话（默认关 = 不写盘）');
  assert.match(block, /beginSession\(\)/, '打开时调 beginSession()');
  assert.match(block, /endSession\(\)/, '关闭 / 退出时调 endSession()');
  assert.match(block, /if \(enabled && !crashSessionStarted\)/, '已开始的会话不重复 begin');

  const config = fsSync.readFileSync(path.join(__dirname, '..', 'core', 'config.js'), 'utf8');
  assert.match(config, /crashDraftEnabled: false/, 'DEFAULTS 必须登记 crashDraftEnabled: false');
  assert.match(config, /cfg\.crashDraftEnabled = cfg\.crashDraftEnabled === true/, '清洗只认真正的 true');
});

test('R2 异常退出标记：别的 pid 留下的标记 = 上次异常退出；干净退出清标记与草稿', async () => {
  const root = await newRoot();
  const first = storeAt(root, { pid: 11111, now: () => new Date('2026-11-17T21:00:00.000Z') });
  const began = await first.beginSession();
  assert.equal(began.ok, true);
  assert.equal(began.abnormal, false, '没有旧标记 = 上次干净退出');
  assert.deepEqual(began.drafts, []);
  const markerPath = path.join(first.dir, draftLib.SESSION_FILE_NAME);
  assert.ok(fsSync.existsSync(markerPath), '启动时要写本进程标记');
  const marker = JSON.parse(await fsp.readFile(markerPath, 'utf8'));
  assert.equal(marker.pid, 11111);
  assert.equal(marker.version, 1);
  assert.equal(typeof marker.startedAt, 'string');

  await first.writeDraft(draft({ at: '2026-11-17T21:01:00.000Z' }));
  assert.equal((await first.listDrafts()).length, 1);

  const second = storeAt(root, { pid: 22222 });
  const next = await second.beginSession();
  assert.equal(next.ok, true);
  assert.equal(next.abnormal, true, '另一个 pid 留下的标记 = 上次异常退出');
  assert.equal(next.previous && next.previous.pid, 11111);
  assert.equal(next.drafts.length, 1, '异常退出时把上次草稿一起交回');

  const closed = await second.endSession();
  assert.equal(closed.ok, true);
  assert.equal(closed.cleared, 1);
  assert.equal(fsSync.existsSync(markerPath), false, '干净退出删标记');
  assert.deepEqual(await second.listDrafts(), [], '干净退出清草稿');

  const third = storeAt(root, { pid: 33333 });
  const after = await third.beginSession();
  assert.equal(after.abnormal, false, '干净退出后下次启动不报异常');
  await third.endSession();
});

test('CGRD-02：pid 复用的残留标记仍判异常退出（主判据 = 标记还在）', async () => {
  const root = await newRoot();
  // 第一次启动后不 endSession = 模拟崩溃，标记留在盘上
  const first = storeAt(root, { pid: 4242 });
  const began = await first.beginSession();
  assert.equal(began.abnormal, false, '没有旧标记 = 上次干净退出');
  // 下一次启动恰巧分到同一个 pid（Windows pid 空间小，复用不罕见）
  const second = storeAt(root, { pid: 4242 });
  const next = await second.beginSession();
  assert.equal(next.abnormal, true, '标记还在就说明上次没走完退出流程，pid 是否相同无关');
  assert.equal(next.previous && next.previous.pid, 4242, 'pid 仍保留在回包里（日志辅助）');
  await second.endSession();
  const third = storeAt(root, { pid: 4242 });
  assert.equal((await third.beginSession()).abnormal, false, '干净退出（标记已删）后不报异常');
  await third.endSession();
});

test('CGRD-01：写草稿只读元数据缓存，不再把全部草稿正文读回解析（写放大）', async () => {
  const root = await newRoot();
  let draftReads = 0;
  const countingFs = {
    ...failingFs(),
    readFile: async (file, ...rest) => {
      if (/draft-[a-f0-9]{16}\.json$/.test(String(file))) draftReads += 1;
      return fsp.readFile(file, ...rest);
    }
  };
  const store = storeAt(root, { fs: countingFs });
  // 每份正文 1000 字；旧实现第二次起每次写都会把所有草稿正文读回并 JSON.parse。
  for (let i = 1; i <= 3; i += 1) {
    const written = await store.writeDraft(
      draft({ chapterId: `ch_${String(i).padStart(3, '0')}`, at: `2026-11-17T20:0${i}:00.000Z` })
    );
    assert.equal(written.ok, true);
  }
  assert.equal(draftReads, 0, '连续写三份草稿不应读回任何草稿正文');
  assert.equal((await store.listDrafts()).length, 3, '三份都在，元数据缓存不影响列表');

  // 超过 maxDrafts（8）后仍按 at 删最旧；写路径同样不读正文。
  // （listDrafts 自己是一条完整扫描，会把三份读回来；从下面开始重新计数。）
  draftReads = 0;
  for (let i = 4; i <= 10; i += 1) {
    await store.writeDraft(
      draft({ chapterId: `ch_${String(i).padStart(3, '0')}`, at: `2026-11-17T20:${String(i).padStart(2, '0')}:00.000Z` })
    );
  }
  assert.equal(draftReads, 0, '清理按元数据排序，不读正文');
  const kept = await store.listDrafts();
  assert.equal(kept.length, 8, '只留最近 8 份');
  assert.equal(kept.some((item) => item.chapterId === 'ch_001'), false, '最旧的被清掉');
});

test('R3 写入 / 列表 / 读取 / 删除：同书同章只留最新一条，列表不回正文', async () => {  const root = await newRoot();
  const store = storeAt(root);
  const one = await store.writeDraft(draft({ at: '2026-11-17T20:00:00.000Z', text: '第一次正文' }));
  assert.equal(one.ok, true);
  assert.match(one.draftId, /^[a-f0-9]{16}$/);
  assert.equal(one.chars, 5);

  const list = await store.listDrafts();
  assert.equal(list.length, 1);
  assert.equal('text' in list[0], false, '列表只给元数据，不回正文');
  assert.equal(list[0].bookTitle, '测试书');
  assert.equal(list[0].chapterTitle, '第一章');
  assert.equal(list[0].chars, 5);
  assert.equal(list[0].draftId, one.draftId);

  const full = await store.readDraft(one.draftId);
  assert.equal(full.ok, true);
  assert.equal(full.draft.text, '第一次正文');
  assert.equal(full.draft.bookPath, BOOK);
  assert.equal(full.draft.chapterIndex, 0);

  // 同一书 + 同一章固定一个草稿位：只更新，不堆多条
  const two = await store.writeDraft(draft({ at: '2026-11-17T20:05:00.000Z', text: '第二次更长的正文' }));
  assert.equal(two.draftId, one.draftId);
  assert.equal((await store.listDrafts()).length, 1);
  assert.equal((await store.readDraft(one.draftId)).draft.text, '第二次更长的正文');

  const other = await store.writeDraft(
    draft({
      chapterId: 'ch_002',
      chapterTitle: '第二章',
      chapterIndex: 1,
      at: '2026-11-17T20:10:00.000Z',
      text: '第二章草稿'
    })
  );
  assert.equal(other.ok, true);
  const both = await store.listDrafts();
  assert.equal(both.length, 2);
  assert.equal(both[0].chapterId, 'ch_002', '列表按时间新→旧');

  // 大小写 / 斜杠写法不同仍算同一本书同一章（pathKey 口径）
  const sameKey = await store.writeDraft(draft({ bookPath: BOOK.toUpperCase(), at: '2026-11-17T20:06:00.000Z' }));
  assert.equal(sameKey.draftId, one.draftId);

  assert.deepEqual(await store.removeDraft(other.draftId), { ok: true, removed: 1 });
  assert.equal((await store.listDrafts()).length, 1);
  assert.deepEqual(await store.removeFor({ bookPath: BOOK, chapterId: 'ch_001' }), { ok: true, removed: 1 });
  assert.deepEqual(await store.removeFor({ bookPath: BOOK, chapterId: '不存在' }), { ok: true, removed: 0 });
  assert.equal((await store.info()).count, 0);
});

test('R4 坏草稿 / 外来文件 / 上限：跳过坏 JSON 不删外来文件，超过 8 份只留最近 8 份', async () => {
  const root = await newRoot();
  const store = storeAt(root);
  await store.writeDraft(draft({ at: '2026-11-17T20:00:00.000Z' }));
  const dir = store.dir;
  await fsp.writeFile(path.join(dir, 'notes.txt'), '作者自己的文件');
  await fsp.writeFile(path.join(dir, 'draft-not-a-hash.json'), '{bad');
  await fsp.writeFile(path.join(dir, 'draft-0123456789abcdef.json'), '{not json');
  await fsp.writeFile(
    path.join(dir, 'draft-1111111111111111.json'),
    JSON.stringify({ draftId: '1111111111111111', bookPath: BOOK, chapterId: 'ch_x', text: '' })
  );

  const list = await store.listDrafts();
  assert.equal(list.length, 1, '只有一条合法草稿');
  assert.equal(list[0].chapterId, 'ch_001');

  for (let i = 0; i < 12; i += 1) {
    const at = new Date(Date.parse('2026-11-17T20:10:00.000Z') + i * 60000).toISOString();
    const result = await store.writeDraft(
      draft({ chapterId: `ch_${100 + i}`, chapterTitle: `第${i}章`, chapterIndex: i, at })
    );
    assert.equal(result.ok, true);
  }
  const kept = await store.listDrafts();
  assert.equal(kept.length, draftLib.MAX_DRAFTS, '只留最近 8 份');
  assert.equal(kept.some((item) => item.chapterId === 'ch_001'), false, '最早的一批被清掉');
  assert.equal(kept[0].chapterId, 'ch_111', '最新一份在最前');
  assert.equal((await store.readDraft('1111111111111111')).ok, false, '缺 text 的坏草稿读不出来');

  await store.removeAll();
  assert.equal(fsSync.existsSync(path.join(dir, 'notes.txt')), true, 'removeAll 不删外来文件');
  assert.equal(fsSync.existsSync(path.join(dir, 'draft-not-a-hash.json')), true);
  assert.equal(fsSync.existsSync(path.join(dir, 'draft-0123456789abcdef.json')), true);
});

test('R5 IO 失败注入：ENOSPC / EPERM / mkdir 失败不抛、不留临时文件、旧版本不被破坏', async () => {
  const root = await newRoot();
  const real = storeAt(root);
  const seeded = await real.writeDraft(draft({ at: '2026-11-17T20:00:00.000Z', text: '旧版本' }));
  assert.equal(seeded.ok, true);

  const enospc = storeAt(root, { fs: failingFs({ writeFile: 'ENOSPC' }) });
  const failed = await enospc.writeDraft(draft({ at: '2026-11-17T20:05:00.000Z', text: '新版本' }));
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'ENOSPC');
  assert.equal((await real.listDrafts()).length, 1);
  assert.equal((await real.readDraft(seeded.draftId)).draft.text, '旧版本', '写失败不破坏旧草稿');
  const names = await fsp.readdir(real.dir);
  assert.equal(names.some((name) => name.includes('.tmp-')), false, '失败后不留临时文件');

  const eperm = storeAt(root, { fs: failingFs({ rename: 'EPERM' }) });
  const renameFailed = await eperm.writeDraft(draft({ at: '2026-11-17T20:06:00.000Z', text: '再新版本' }));
  assert.equal(renameFailed.ok, false);
  assert.equal(renameFailed.code, 'EPERM');
  assert.equal((await real.readDraft(seeded.draftId)).draft.text, '旧版本');

  const mkdirRoot = await newRoot();
  const noMkdir = storeAt(mkdirRoot, { fs: failingFs({ mkdir: 'EPERM' }) });
  const mkdirFailed = await noMkdir.writeDraft(draft());
  assert.equal(mkdirFailed.ok, false);
  assert.equal(mkdirFailed.code, 'EPERM');
  assert.equal(fsSync.existsSync(path.join(mkdirRoot, draftLib.DRAFT_DIR_NAME)), false);

  // 标记写失败：beginSession 回错误码但不抛；已有草稿仍能列出
  const brokenStart = storeAt(root, { fs: failingFs({ writeFile: 'ENOSPC' }) });
  const began = await brokenStart.beginSession();
  assert.equal(began.ok, false);
  assert.equal(began.code, 'ENOSPC');
  assert.equal((await real.listDrafts()).length, 1);

  // 读失败：list 跳过、read 回错误码，不抛
  const readBroken = storeAt(root, { fs: failingFs({ readFile: 'EPERM' }) });
  assert.deepEqual(await readBroken.listDrafts(), []);
  assert.equal((await readBroken.readDraft('whatever')).ok, false);
});

test('R6 极值：2 万字正文 / 含空格中文路径往返；500 万字上限；坏形状拒绝', async () => {
  const root = await newRoot();
  const store = storeAt(root);
  assert.equal(draftLib.MAX_TEXT_CHARS, 5000000, '与 core/ipc-limits 的正文上限同口径');

  const body = '字'.repeat(20000);
  const ok = await store.writeDraft(draft({ bookTitle: '书名'.repeat(300), text: body }));
  assert.equal(ok.ok, true);
  assert.equal(ok.chars, 20000);
  const list = await store.listDrafts();
  assert.equal(list[0].chars, 20000);
  assert.equal(list[0].bookTitle.length, draftLib.MAX_TITLE_CHARS, '超长书名截断而不是拒绝');
  const full = await store.readDraft(ok.draftId);
  assert.equal(full.ok, true);
  assert.equal(full.draft.text, body);
  assert.equal(full.draft.bookPath, BOOK);
  assert.equal(full.draft.chapterIndex, 0);

  const tooLarge = await store.writeDraft(draft({ text: 'x'.repeat(draftLib.MAX_TEXT_CHARS + 1) }));
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.code, 'DRAFT_TOO_LARGE');
  assert.equal((await store.listDrafts()).length, 1, '拒绝的超长草稿不落盘');

  for (const bad of [
    null,
    'text',
    [],
    {},
    draft({ bookPath: '' }),
    draft({ chapterId: '' }),
    draft({ text: 123 }),
    draft({ text: '' })
  ]) {
    const result = await store.writeDraft(bad);
    assert.equal(result.ok, false, `应拒绝：${JSON.stringify(bad)}`);
  }
  // 坏形状的 chapterIndex 归一成 0，不把 NaN 写进 JSON
  const weird = await store.writeDraft(
    draft({ chapterId: 'ch_weird', chapterIndex: 'not-a-number', at: '2026-11-17T20:30:00.000Z' })
  );
  assert.equal(weird.ok, true);
  const stored = await store.readDraft(weird.draftId);
  assert.equal(stored.draft.chapterIndex, 0);
  assert.equal((await store.listDrafts()).length, 2);
});

test('R7 过期清理与干净退出：超过 7 天的草稿在 beginSession 清掉；endSession 尽力而为不抛', async () => {
  const root = await newRoot();
  const old = storeAt(root, { now: () => new Date('2026-11-10T20:00:00.000Z') });
  await old.writeDraft(draft({ at: '2026-11-10T20:00:00.000Z' }));
  assert.equal((await old.listDrafts()).length, 1);

  const fresh = storeAt(root, { now: () => new Date('2026-11-18T20:00:00.000Z') });
  const began = await fresh.beginSession();
  assert.equal(began.ok, true);
  assert.deepEqual(await fresh.listDrafts(), [], '超过 7 天的草稿清掉');
  assert.deepEqual(began.drafts, []);

  await fresh.writeDraft(draft({ at: '2026-11-18T20:00:00.000Z' }));
  const brokenClose = storeAt(root, { fs: failingFs({ unlink: 'EPERM' }) });
  const closed = await brokenClose.endSession();
  assert.equal(closed.ok, true, 'endSession 尽力而为：删不掉也不抛、不影响退出');
  assert.ok(closed.cleared >= 0);
});