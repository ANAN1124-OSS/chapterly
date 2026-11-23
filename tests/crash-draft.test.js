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
  // （listDrafts 自己是一条完整扫描：P2 起草稿拆了元数据 / 正文，它只读元数据，正文一个字节都不碰。）
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

// I1（三审·中）：写盘失败的 message 以前是「裸 err.message 截 200 码点」—— EACCES / EBUSY 的
// Node 原文形如 `EACCES: permission denied, open 'C:\Users\<用户名>\...\draft-x.json'`，会带着
// 本机绝对路径跨 IPC 进渲染层。现在与 fail() 同走 core/error-text.js：错误码原样、路径只留最后一节。
test('I1（三审）：安全错误文案走 error-text 脱敏，本机绝对路径不许跨 IPC 回包', async () => {
  const root = await newRoot();
  const leakyPath = path.join(root, draftLib.DRAFT_DIR_NAME, 'draft-x.json');
  const leaky = Object.assign(new Error(`EACCES: permission denied, open '${leakyPath}'`), { code: 'EACCES' });
  const fsSeam = { ...failingFs(), writeFile: () => Promise.reject(leaky) };
  const store = storeAt(root, { fs: fsSeam });

  const failed = await store.writeDraft(draft());
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'EACCES', '错误码原样保留（界面按 code 分支）');
  assert.equal(failed.message.includes(root), false, '本机绝对路径不许原样出现在回包里');
  assert.equal(failed.message.includes('Users'), false);
  assert.match(failed.message, /没有访问权限/, '常见文件系统错误码换成中文');
  assert.match(failed.message, /…\\draft-x\.json$/, '路径只留最后一节');

  // beginSession 的标记写失败走同一条口径（同一个 safeMessage）
  const began = await store.beginSession();
  assert.equal(began.ok, false);
  assert.equal(began.code, 'EACCES');
  assert.equal(began.message.includes(root), false);
  assert.match(began.message, /没有访问权限/);
});

test('R6 极值：2 万字正文 / 含空格中文路径往返；500 万字上限；坏形状拒绝', async () => {
  const root = await newRoot();
  const store = storeAt(root);
  assert.equal(draftLib.MAX_TEXT_CHARS, 5000000, '与 core/ipc-limits 的正文上限同口径');
  // I8（三审）：草稿正文上限不再自带第二份字面量 —— 直接引用 core/limits.js 的唯一常量，
  // 现场比较两边（与保存上限同源），改一处不会漏另一处。
  assert.equal(draftLib.MAX_TEXT_CHARS, require('../core/limits').MAX_CHAPTER_SAVE_CHARS);
  assert.equal(draftLib.MAX_TEXT_CHARS, require('../core/ipc-limits').MAX_TEXT_CHARS);

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

// ---------- S2（一轮·中/低）/ T6（三审·中）：多窗口归属 ----------
// 草稿以前是全局的：任何窗口都能列 / 读全文 / 删。现在写的时候记「进程令牌 + 窗口 id」，
// 列 / 读 / 删只对写它的那扇窗口放行；上次运行留下的草稿（令牌不同 / 没有令牌）仍然谁先打开谁处理，
// 否则崩溃重启后所有草稿都会变成不可见 = 丢稿。
test('S2 / T6：草稿记 owner 元数据，listDrafts 只给写它的窗口；上次运行的草稿仍然可见', async () => {
  const root = await newRoot();
  const store = storeAt(root);

  // 渲染层 payload 里自带 owner 字段也不采信：归属只由主进程注入。
  const mine = await store.writeDraft(
    draft({ chapterId: 'ch_mine', bookPath: path.join(BOOK, '我 的'), ownerWindowId: 999 }),
    { ownerToken: 'tok-a', ownerWindowId: 7 }
  );
  assert.equal(mine.ok, true);
  const legacy = await store.writeDraft(draft({ chapterId: 'ch_legacy', bookPath: path.join(BOOK, '旧 的') }));

  const asWindow7 = await store.listDrafts({ ownerToken: 'tok-a', ownerWindowId: 7 });
  assert.deepEqual(asWindow7.map((entry) => entry.chapterId).sort(), ['ch_legacy', 'ch_mine'], '本窗口写的 + 上次运行的都可见');
  const asWindow8 = await store.listDrafts({ ownerToken: 'tok-a', ownerWindowId: 8 });
  assert.deepEqual(asWindow8.map((entry) => entry.chapterId), ['ch_legacy'], '别的窗口只看到没有主 / 上次运行的草稿');
  const asOtherProcess = await store.listDrafts({ ownerToken: 'tok-next', ownerWindowId: 7 });
  assert.equal(asOtherProcess.length, 2, '换了进程令牌 = 上次运行的草稿，谁先打开谁能处理（否则重启后永远看不到）');
  assert.equal((await store.listDrafts()).length, 2, '不传 viewer = 全部（诊断 / info 口径不变）');

  // 元数据里带着归属（主进程用它做 read / discard 的归属校验）
  const mineMeta = asWindow7.find((entry) => entry.chapterId === 'ch_mine');
  assert.equal(mineMeta.ownerToken, 'tok-a');
  assert.equal(mineMeta.ownerWindowId, 7, '渲染层传的 ownerWindowId 999 不许覆盖主进程注入的 7');
  const legacyMeta = asWindow7.find((entry) => entry.chapterId === 'ch_legacy');
  assert.equal(legacyMeta.ownerToken, '', '没有归属的老草稿 ownerToken 为空串');
  assert.equal(legacyMeta.ownerWindowId, null);

  // draftOwner()：只读归属元数据，不返回正文；非法 id 回 null。
  const owner = await store.draftOwner(mine.draftId);
  assert.deepEqual(owner, { draftId: mine.draftId, ownerToken: 'tok-a', ownerWindowId: 7 });
  assert.ok(!('text' in owner), '归属查询不返回正文');
  assert.equal(await store.draftOwner('../../etc/passwd'), null, '非法 draftId 直接拒绝');
  assert.equal(await store.draftOwner('0123456789abcdef'), null, '不存在的草稿回 null');

  // 同一草稿位被新正文覆盖：归属跟着新写入走（同进程另一扇窗口立刻看不到它）。
  await store.writeDraft(
    draft({ chapterId: 'ch_legacy', bookPath: path.join(BOOK, '旧 的'), text: '新一版正文' }),
    { ownerToken: 'tok-a', ownerWindowId: 9 }
  );
  const window7Again = await store.listDrafts({ ownerToken: 'tok-a', ownerWindowId: 7 });
  assert.deepEqual(window7Again.map((entry) => entry.chapterId), ['ch_mine'], '同进程另一扇窗口看不到被覆盖的草稿');
  const window9 = await store.listDrafts({ ownerToken: 'tok-a', ownerWindowId: 9 });
  assert.deepEqual(window9.map((entry) => entry.chapterId), ['ch_legacy']);
  assert.equal(window9[0].ownerWindowId, 9);
  assert.equal(await store.draftOwner(legacy.draftId).then((meta) => meta.ownerWindowId), 9);
  assert.equal((await store.readDraft(legacy.draftId)).draft.text, '新一版正文', '覆盖后读回的是新正文');

  // readDraft 的元数据同样带归属（主进程按它拒绝别的窗口读全文）
  const read = await store.readDraft(mine.draftId);
  assert.equal(read.ok, true);
  assert.equal(read.draft.ownerWindowId, 7);
  assert.equal(read.draft.ownerToken, 'tok-a');
  assert.equal(read.draft.text, '草稿正文');
});

test('S2：draftVisibleTo 纯函数——无令牌 / 别进程 / 无窗口归属都算可见，本进程别窗口算不可见', () => {
  const viewer = { ownerToken: 'tok-a', ownerWindowId: 7 };
  assert.equal(draftLib.draftVisibleTo(null, viewer), true);
  assert.equal(draftLib.draftVisibleTo({}, viewer), true, '没有 ownerToken 的老草稿谁都可见');
  assert.equal(draftLib.draftVisibleTo({ ownerToken: 'tok-old', ownerWindowId: 3 }, viewer), true, '上次运行留下的大可见');
  assert.equal(draftLib.draftVisibleTo({ ownerToken: 'tok-a', ownerWindowId: null }, viewer), true, '没有窗口归属的大可见');
  assert.equal(draftLib.draftVisibleTo({ ownerToken: 'tok-a', ownerWindowId: 7 }, viewer), true, '写它的窗口可见');
  assert.equal(draftLib.draftVisibleTo({ ownerToken: 'tok-a', ownerWindowId: 8 }, viewer), false, '本进程别的窗口不可见');
  // 没有查看者上下文（更早调用方 / 拿不到进程令牌）：按「别的进程」处理 —— 宁可多显示一次，
  // 也不能让崩溃重启后的草稿变成不可见（看不到 = 丢稿）。
  assert.equal(draftLib.draftVisibleTo({ ownerToken: 'tok-a', ownerWindowId: 8 }, null), true);
  // 窗口 id 归一化：数字 / 数字字符串等价
  assert.equal(draftLib.draftVisibleTo({ ownerToken: 'tok-a', ownerWindowId: 7 }, { ownerToken: 'tok-a', ownerWindowId: '7' }), true);
});

// ---------- P2（一轮·中）：草稿拆「元数据 .json + 正文 .txt」 ----------
// 旧实现 scan() 对每份草稿都 readFile + JSON.parse 整份正文（8 份 500 万字草稿 ≈ 80–120MB / 4000 万
// 元素的数组），启动恢复与列表都跟着正文大小线性变慢。现在列表 / prune / info 只读元数据，
// readDraft 才读那一份正文；字数是增量码点计数（不再 Array.from）。
test('P2：草稿拆元数据 + 正文文件；列表 / info 不读正文，readDraft 只读一次', async () => {
  const root = await newRoot();
  const reads = [];
  const countingFs = {
    ...failingFs(),
    readFile: async (file, ...rest) => {
      reads.push(String(file));
      return fsp.readFile(file, ...rest);
    }
  };
  const store = storeAt(root, { fs: countingFs });
  const text = '正文'.repeat(10);
  const written = await store.writeDraft(draft({ text }));
  assert.equal(written.ok, true);
  assert.equal(written.chars, 20, '字数在入口只算一次（旧实现 writeDraft 里算三遍）');
  const names = await fsp.readdir(store.dir);
  assert.ok(names.includes(`draft-${written.draftId}.json`), '元数据文件');
  assert.ok(names.includes(`draft-${written.draftId}.txt`), '正文文件');
  const meta = JSON.parse(await fsp.readFile(path.join(store.dir, `draft-${written.draftId}.json`), 'utf8'));
  assert.equal(meta.version, 2);
  assert.equal(meta.text, undefined, '正文不再进 JSON');
  assert.equal(meta.body, `draft-${written.draftId}.txt`);
  assert.equal(meta.chars, 20);
  assert.equal(await fsp.readFile(path.join(store.dir, meta.body), 'utf8'), text);

  reads.length = 0;
  const list = await store.listDrafts();
  assert.equal(list.length, 1);
  assert.equal(list[0].chars, 20);
  assert.deepEqual(reads.filter((file) => file.endsWith('.txt')), [], '列表不许读正文');

  reads.length = 0;
  assert.equal((await store.info()).chars, 20);
  assert.deepEqual(reads.filter((file) => file.endsWith('.txt')), [], 'info 不许读正文');

  reads.length = 0;
  const full = await store.readDraft(written.draftId);
  assert.equal(full.ok, true);
  assert.equal(full.draft.text, text);
  assert.equal(full.draft.chars, 20);
  assert.equal(reads.filter((file) => file.endsWith('.txt')).length, 1, 'readDraft 只读这一份正文');
});

test('P2：旧版本单文件草稿（text 在 JSON 里）仍能读；chars 按码点算（不把代理对当两个字）', async () => {
  const root = await newRoot();
  const store = storeAt(root);
  const legacyId = 'aaaaaaaaaaaaaaaa';
  await fsp.mkdir(store.dir, { recursive: true });
  await fsp.writeFile(
    path.join(store.dir, `draft-${legacyId}.json`),
    JSON.stringify({
      version: 1,
      draftId: legacyId,
      bookPath: BOOK,
      chapterId: 'ch_legacy',
      chapterTitle: '旧章',
      at: '2026-11-17T20:00:00.000Z',
      text: '旧版正文😀'
    })
  );
  const list = await store.listDrafts();
  assert.equal(list.length, 1);
  assert.equal(list[0].chars, 5, '😀 只算一个字');
  const full = await store.readDraft(legacyId);
  assert.equal(full.ok, true);
  assert.equal(full.draft.text, '旧版正文😀');
  // 同书同章的下一次写入覆盖成 v2：JSON 里不再有 text，字数按码点
  const rewritten = await store.writeDraft({ bookPath: BOOK, chapterId: 'ch_001', text: '新正文😀' });
  assert.equal(rewritten.ok, true);
  const meta = JSON.parse(await fsp.readFile(path.join(store.dir, `draft-${rewritten.draftId}.json`), 'utf8'));
  assert.equal(meta.text, undefined);
  assert.equal(meta.chars, 4, '新正文😀 = 4 个字');
  assert.equal((await store.readDraft(rewritten.draftId)).draft.text, '新正文😀');
});

test('P2：无元数据的孤儿正文在 prune 时回收；坏 JSON 的正文保留（坏文件一律不删）', async () => {
  const root = await newRoot();
  const store = storeAt(root);
  await store.writeDraft(draft({ chapterId: 'ch_keep', at: '2026-11-17T20:00:00.000Z' }));
  await fsp.writeFile(path.join(store.dir, 'draft-bbbbbbbbbbbbbbbb.txt'), '没有元数据的孤儿正文');
  await fsp.writeFile(path.join(store.dir, 'draft-cccccccccccccccc.json'), '{bad');
  await fsp.writeFile(path.join(store.dir, 'draft-cccccccccccccccc.txt'), '坏元数据但正文还在');
  await store.beginSession();
  const names = await fsp.readdir(store.dir);
  assert.equal(names.includes('draft-bbbbbbbbbbbbbbbb.txt'), false, '无元数据的孤儿正文被回收');
  assert.equal(names.includes('draft-cccccccccccccccc.txt'), true, '坏 JSON 的正文保留（坏文件一律不删）');
  await store.endSession();
});

// N-13（二次审查）：崩溃草稿的原子写必须「临时文件 → fsync → rename」。草稿是未保存正文的唯一
// 磁盘兜底，整机断电时少了 fsync 的窗口里 rename 可能先落、数据块没落盘（空文件 / 半截）。
test('N-13：writeDraft 的原子写在 rename 之前调用 fsync（正文与元数据各一次）', async () => {
  const root = await newRoot();
  const events = [];
  const fsSpy = {
    mkdir: (...args) => fsp.mkdir(...args),
    open: async (file, flags) => {
      const handle = await fsp.open(file, flags);
      return {
        writeFile: (...args) => handle.writeFile(...args),
        sync: async () => {
          events.push('sync');
          return handle.sync();
        },
        close: async () => handle.close()
      };
    },
    rename: async (...args) => {
      events.push('rename');
      return fsp.rename(...args);
    },
    readdir: (...args) => fsp.readdir(...args),
    readFile: (...args) => fsp.readFile(...args),
    stat: (...args) => fsp.stat(...args),
    unlink: (...args) => fsp.unlink(...args)
  };
  const store = storeAt(root, { fs: fsSpy, now: () => new Date('2026-11-17T21:00:00.000Z') });
  const result = await store.writeDraft(draft({ at: '2026-11-17T21:00:00.000Z' }));
  assert.equal(result.ok, true);
  assert.deepEqual(events, ['sync', 'rename', 'sync', 'rename'], '正文与元数据都必须 sync 后再 rename');
});

test('N-13：注入的 io 没有 open/sync 时退回旧 writeFile 路径（最小桩不被新接口卡死）', async () => {
  const root = await newRoot();
  const store = storeAt(root, { fs: failingFs({}), now: () => new Date('2026-11-17T21:00:00.000Z') });
  const result = await store.writeDraft(draft({ at: '2026-11-17T21:00:00.000Z' }));
  assert.equal(result.ok, true, '没有 open 的假 fs 仍能写草稿');
  assert.equal((await store.listDrafts()).length, 1);
});

// N-14（二次审查）：草稿自报的 at 只用于排序 / 展示，不能被当成「现在」：
//   · at 晚于 store 时钟 → 夹到时钟（不允许写入未来时间）；
//   · prune 的过期判定用 store 自己的 clock()，不用这份草稿的 at —— 否则一个未来时间戳就会把
//     别的窗口 / 上次运行留下的未过期草稿整批删掉（跨窗口的数据破坏面）。
test('N-14：未来的 at 被夹到当前时钟，不写进元数据', async () => {
  const root = await newRoot();
  const now = new Date('2026-11-17T21:00:00.000Z');
  const store = storeAt(root, { now: () => now });
  const result = await store.writeDraft(draft({ at: '2026-11-18T21:00:00.000Z' }));
  assert.equal(result.ok, true);
  const list = await store.listDrafts();
  assert.equal(list[0].at, now.toISOString(), '未来时间被夹到当前时钟');
});

test('N-14：写草稿触发的 prune 用 store 时钟，未来 at 不会删掉未过期的旧草稿', async () => {
  const root = await newRoot();
  const now = new Date('2026-11-17T21:00:00.000Z');
  const store = storeAt(root, { now: () => now });
  // 一天前写的草稿（远没到 7 天过期线）
  await store.writeDraft(draft({ chapterId: 'ch_yesterday', at: '2026-11-16T21:00:00.000Z' }));
  // 注入一个「+8 天」的未来 at：旧实现会拿它当 now，把一天前的草稿判成过期删掉
  const future = await store.writeDraft(draft({ chapterId: 'ch_future', at: '2026-11-25T21:00:00.000Z' }));
  assert.equal(future.ok, true);
  const ids = (await store.listDrafts()).map((item) => item.chapterId).sort();
  assert.deepEqual(ids, ['ch_future', 'ch_yesterday'], '未过期的旧草稿必须还在（prune 用 store 时钟）');
});
