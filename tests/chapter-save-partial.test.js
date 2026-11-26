// A7（审计 E4）：「正文已存、书目写失败」的部分成功语义。
//
// 旧行为：chapter:save 先写正文、再 writeBookMeta，书目写失败时整个 IPC 报错。正文其实已经落盘，
// 但渲染层按「保存失败」处理——关窗时会问「保存吗」，作者可能选「不保存」，心理上也以为这一章白写了。
//
// 新契约（写进主进程 fail() 的白名单）：code=META_SAVE_FAILED + bodySaved:true + chars + file，
// 渲染层提示「正文已写入磁盘，但书目更新失败，可再按一次保存重试」，dirty 保持（重试会重写并重试书目）。
//
// 这个测试锁三件事：
//   1. 存储层：正文写成功后书目写失败，磁盘上的正文必须已经是新内容（绝不回滚 / 不丢）；
//   2. main.js：chapter:save 用 try/catch 包住 writeBookMeta，抛出的错误带白名单字段；
//      fail() 只透传白名单字段（chars / file / bodySaved），不把原始错误 / 路径带出去；
//   3. renderer.js：saveCurrent 认得 META_SAVE_FAILED，按 warn 提示、不显示「保存失败」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fss = require('node:fs');
const path = require('node:path');
const storage = require('../core/storage');

const ROOT = path.join(__dirname, '..');
// 源码在工作树里是 CRLF；静态闸门只关心语义，统一成 LF 再切片（免得 indexOf('\n...') 落空）
const MAIN_SOURCE = fss.readFileSync(path.join(ROOT, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
// MAIN-03：chapter:save 已下沉 ipc/save.js —— 源码闸门跟着读新落点。
const SAVE_SOURCE = fss.readFileSync(path.join(ROOT, 'ipc', 'save.js'), 'utf8').replace(/\r\n/g, '\n');
const RENDERER_SOURCE = fss.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8').replace(/\r\n/g, '\n');
// WP17 A3 第二刀：保存热路径整段迁到 save-chain-ui.js；saveCurrent 的源码闸门改读模块（同一条断言）。
const SAVE_CHAIN_SOURCE = fss.readFileSync(path.join(ROOT, 'renderer', 'save-chain-ui.js'), 'utf8').replace(/\r\n/g, '\n');

const tmpCleanup = require('./tmp-cleanup');

// TB-02：临时目录统一经 tests/tmp-cleanup.js 的 mkTmp（mkdtemp + 登记回收）。
const mkTmp = (prefix = 'cw-partial-save-') => tmpCleanup.mkTmp(prefix);

function channelBody(source, channel) {
  const start = source.indexOf(`handleBook('${channel}'`);
  assert.ok(start > 0, `ipc/save.js 里找不到 ${channel}`);
  // MAIN-03：结束锚点用带 mutation 的整行，避免旧版 `\n  });` 过度切片到后续频道。
  const end = source.indexOf('\n  }, { mutation: MUTATION.SAVE });', start + 1);
  assert.ok(end > start, `${channel} 的注册体找不到结尾`);
  return source.slice(start, end);
}

test('存储层：正文写成功后书目写失败，磁盘上的正文仍是新内容（不丢正文）', async () => {
  const root = await mkTmp();
  const { path: bookPath, meta } = await storage.createBook(root, '部分成功演练');
  const file = meta.chapters[0].file;
  const metaPath = path.join(bookPath, '书目.json');
  const metaBefore = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  await storage.saveChapterText(bookPath, file, '第一版正文。');

  // 模拟 chapter:save 的顺序：先写正文，再写书目；书目被设成只读，写盘必然失败
  await storage.saveChapterText(bookPath, file, '第二版正文：这一段必须已经在磁盘上。');
  await fs.chmod(metaPath, 0o444);
  let metaError = null;
  try {
    await storage.writeBookMeta(bookPath, meta, { ensureDir: false });
  } catch (err) {
    metaError = err;
  } finally {
    await fs.chmod(metaPath, 0o666);
  }
  assert.ok(metaError, '书目只读时必须写盘失败（不然这个测试没意义）');
  assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(metaError.code), `书目写失败应为权限 / 占用类错误，实际 ${metaError.code}`);

  // 正文已经是第二版（不回滚），书目停在旧版本（chars 没更新）
  const onDisk = await fs.readFile(path.join(bookPath, file), 'utf8');
  assert.ok(onDisk.includes('第二版正文'), '正文必须已经在磁盘上（部分成功的「已存」是真的）');
  const metaOnDisk = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  assert.deepEqual(metaOnDisk, metaBefore, '书目没写成功：磁盘上仍是旧版本');
  await fs.rm(root, { recursive: true, force: true });
});

test('静态闸门：chapter:save 的 writeBookMeta 失败回 META_SAVE_FAILED 部分成功（E4）', () => {
  const body = channelBody(SAVE_SOURCE, 'chapter:save');
  // 书目写盘在 try/catch 里，catch 抛出带白名单字段的错误
  // WP1 契约扩展：chapter:save 的写书目调用新增 rotateBak（普通保存也留上一版）与
  // expectedStamp（书目身份核对）；ensureDir:false 与 A7 的 try/catch 顺序保持不变。
  assert.match(
    body,
    /try \{[\s\S]{0,400}?await storage\.writeBookMeta\(bookPath, meta, \{ ensureDir: false, rotateBak: true, expectedStamp: prepared\.metaStamp \}\);[\s\S]{0,400}?\} catch \(metaErr\) \{/
  );
  assert.match(body, /if \(metaErr\.code === 'META_CHANGED'\) \{/, 'META_CHANGED 要在同一个 catch 里单独回包（正文已落盘）');
  assert.ok(body.includes("code: 'META_SAVE_FAILED'"), 'chapter:save 书目失败要回 META_SAVE_FAILED');
  assert.ok(body.includes('bodySaved: true'), '要把「正文已落盘」明确标出来');
  assert.ok(body.includes('chars: result.chars'), '要把这次正文的字数带回去（界面字数缓存跟着更新）');
  assert.ok(body.includes('file: chapter.file'), '要带章节文件名（重启后重试 / 排障都用得上）');
  // 索引标记必须挪到书目写盘之前：部分成功时正文也已经变了
  const markAt = body.indexOf('getSearchIndexStore().markDirty(');
  const metaAt = body.indexOf('storage.writeBookMeta(');
  assert.ok(markAt > 0 && metaAt > 0 && markAt < metaAt, 'markDirty 要在 writeBookMeta 之前（E4 顺带修正）');

  // fail() 只透传白名单字段，且只对 META_SAVE_FAILED 生效
  const failStart = MAIN_SOURCE.indexOf('function fail(err, channel)');
  assert.ok(failStart > 0);
  const failBody = MAIN_SOURCE.slice(failStart, MAIN_SOURCE.indexOf('\n}\n', failStart) + 3);
  assert.ok(failBody.includes("described.code === 'META_SAVE_FAILED'"), 'fail() 要认得 META_SAVE_FAILED');
  assert.ok(failBody.includes('err.bodySaved === true'), 'fail() 只在 bodySaved 标记存在时透传');
  for (const key of ['bodySaved: true', 'partial.chars =', 'partial.file =']) {
    assert.ok(failBody.includes(key), `fail() 白名单字段缺失：${key}`);
  }
  assert.ok(
    failBody.includes('return { ok: false, code: described.code, message: described.message };'),
    '普通失败的回包形状不变（error-text 静态闸门要求）'
  );
});

test('静态闸门：渲染层把 META_SAVE_FAILED 当部分成功提示、不当「保存失败」（E4）', () => {
  // ApiError 能带部分成功字段
  assert.match(
    RENDERER_SOURCE,
    /class ApiError extends Error \{[\s\S]{0,260}?if \(extra && typeof extra === 'object'\) Object\.assign\(this, extra\);/,
    'ApiError 要能带上 bodySaved / chars / file'
  );
  // call() 的白名单：部分成功（bodySaved）与重试 mtime（META_SAVE_FAILED / META_CHANGED）
  const callStart = RENDERER_SOURCE.indexOf('async function call(fn, ...args)');
  assert.ok(callStart > 0, 'renderer.js 里找不到 call()');
  const callBody = RENDERER_SOURCE.slice(callStart, RENDERER_SOURCE.indexOf('\n  }\n', callStart) + 4);
  assert.ok(
    callBody.includes('saveLogic.saveFailureExtra(res)'),
    'call() 的白名单交给 save-logic（部分成功字段 + 重试 mtime，两边同一口径）'
  );
  assert.match(callBody, /throw new ApiError/, '白名单字段交给 ApiError');
  const saveLogic = require('../renderer/save-logic');
  assert.deepEqual(
    saveLogic.saveFailureExtra({
      ok: false,
      code: 'META_SAVE_FAILED',
      bodySaved: true,
      chars: 7,
      file: '001-第一章.txt',
      mtimeMs: 1700000000000
    }),
    { bodySaved: true, chars: 7, file: '001-第一章.txt', mtimeMs: 1700000000000 },
    'ApiError 要带上 bodySaved / chars / file / mtimeMs'
  );
  // saveCurrent 的 catch：认得 META_SAVE_FAILED → warn 提示 + dirty 保持（不显示「保存失败」）
  const saveStart = SAVE_CHAIN_SOURCE.indexOf('async function saveCurrent(');
  assert.ok(saveStart > 0, 'save-chain-ui.js 里找不到 saveCurrent');
  const saveBody = SAVE_CHAIN_SOURCE.slice(saveStart, SAVE_CHAIN_SOURCE.indexOf('\n  }\n', saveStart) + 4);
  assert.ok(saveBody.includes("err.code === 'META_SAVE_FAILED'"), 'saveCurrent 要单独处理 META_SAVE_FAILED');
  assert.ok(saveBody.includes('bodySaved: true'), 'saveCurrent 的返回里要标出正文已存');
  assert.match(saveBody, /toast\(err\.message, 'warn'\)/, '部分成功要用 warn 提示（不是「保存失败」的 error）');
  assert.equal(/toast\(`保存失败：\$\{err\.message\}`, 'error'\)/.test(saveBody), true, '整体失败分支保持不变');
});

// WP14 E-N6（审计低批）：部分成功回包缺 mtime —— 正文已写盘、书目失败时，mtime 已经变了；
// 渲染层不更新 loadedMtimeMs，下一次保存会拿旧 mtime 比对 → 误报 EXTERNAL_CHANGE。
// 主进程部分的 fail() 是 Electron 主进程文件（Node 不能 require），这里用静态接线 + 存储层
// 真实返回值两层锚点；真实 IO 部分成功由本文件的 EPERM 用例覆盖。
test('E-N6：部分成功回包带 mtimeMs，渲染层同步 loadedMtimeMs（重试不误报 EXTERNAL_CHANGE）', async () => {
  // 存储层：saveChapterText 返回的 mtimeMs 就是刚写盘文件的 stat.mtimeMs（部分成功要透传的就是它）
  const root = await mkTmp();
  const created = await storage.createBook(root, 'mtime 演练');
  const file = created.meta.chapters[0].file;
  const saved = await storage.saveChapterText(created.path, file, '正文一版');
  const stat = await fs.stat(path.join(created.path, file));
  assert.equal(saved.mtimeMs, stat.mtimeMs, 'saveChapterText 必须回报落盘后的 mtimeMs');
  assert.equal(Number.isFinite(saved.mtimeMs), true);
  await fs.rm(root, { recursive: true, force: true });

  // chapter:save 的 catch：部分成功错误对象要带 result.mtimeMs
  const body = channelBody(SAVE_SOURCE, 'chapter:save');
  assert.ok(body.includes('mtimeMs: result.mtimeMs'), 'META_SAVE_FAILED 错误要带 result.mtimeMs');

  // fail() 白名单：只透传有限 mtimeMs（原错误对象 / 路径仍只进日志）
  const failStart = MAIN_SOURCE.indexOf('function fail(err, channel)');
  const failBody = MAIN_SOURCE.slice(failStart, MAIN_SOURCE.indexOf('\n}\n', failStart) + 3);
  assert.ok(failBody.includes('Number.isFinite(Number(err.mtimeMs))'), 'mtimeMs 要过有限性判断');
  assert.ok(failBody.includes('partial.mtimeMs = Number(err.mtimeMs)'), 'fail() 要透传 mtimeMs');

  // renderer：sameChapter 之后、saveError 之前更新 loadedMtimeMs（绝不把别的章的 mtime 写到眼前这一章）
  const partialAt = SAVE_CHAIN_SOURCE.indexOf("err.code === 'META_SAVE_FAILED' && err.bodySaved === true");
  assert.ok(partialAt > 0, 'saveCurrent 找不到部分成功分支');
  const sameAt = SAVE_CHAIN_SOURCE.indexOf('if (!sameChapter) return', partialAt);
  const mtimeAt = SAVE_CHAIN_SOURCE.indexOf('state.loadedMtimeMs = saveLogic.retryMtimeMs(err, state.loadedMtimeMs)', partialAt);
  const saveErrAt = SAVE_CHAIN_SOURCE.indexOf('state.saveError = err.message', partialAt);
  assert.ok(sameAt > 0 && mtimeAt > sameAt, 'loadedMtimeMs 必须在 sameChapter 判定之后更新');
  assert.ok(saveErrAt > mtimeAt, '更新 mtime 在保存错误文案之前（同一分支内）');
  assert.match(
    SAVE_CHAIN_SOURCE.slice(mtimeAt - 40, mtimeAt + 120),
    /saveLogic\.retryMtimeMs\(err, state\.loadedMtimeMs\)/,
    '经 retryMtimeMs 只接受 > 0 的有限 mtime（0 是 force 哨兵，不采用）'
  );
});

// A2-STORAGE-03（低）：部分成功时正文已落盘、磁盘书目还留着上一版 chars；扫描回填只补「缺失」的章、
// 永不重算有限值 → 书卡总字数会长期偏离正文，没有自愈出口。chapter:save 的 META_SAVE_FAILED 分支
// 复用批量失败后的同一套「定点 chars 补写」：短暂占用现在能当场写成功，写不成也不掩盖原始错误。
test('A2-STORAGE-03：部分成功后定点补写章节 chars（短暂占用能自愈，书目没了不留影子）', async () => {
  const root = await mkTmp();
  const { path: bookPath, meta } = await storage.createBook(root, 'chars 补写演练');
  const file = meta.chapters[0].file;
  await storage.saveChapterText(bookPath, file, '第一版正文。');
  const fresh = await storage.readBookMeta(bookPath);
  fresh.chapters[0].chars = 987654;
  await storage.persistCharsAfterFailure(bookPath, fresh);
  const onDisk = JSON.parse(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'));
  assert.equal(onDisk.chapters[0].chars, 987654, '磁盘书目要补上这次正文的字数');

  // RECOV-02 口径：书目已不在时不重建影子书目（原始错误现场更重要）
  const brokenRoot = await mkTmp();
  const broken = await storage.createBook(brokenRoot, '书目没了');
  await fs.rm(path.join(broken.path, '书目.json'), { force: true });
  broken.meta.chapters[0].chars = 123;
  await storage.persistCharsAfterFailure(broken.path, broken.meta);
  await assert.rejects(fs.stat(path.join(broken.path, '书目.json')), '书目不在就不许重建');
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(brokenRoot, { recursive: true, force: true });

  // 接线：META_SAVE_FAILED 分支（不是 META_CHANGED）在 throw 之前补写
  const body = channelBody(SAVE_SOURCE, 'chapter:save');
  const changedAt = body.indexOf("if (metaErr.code === 'META_CHANGED')");
  const persistAt = body.indexOf('await storage.persistCharsAfterFailure(bookPath, meta);');
  const failedAt = body.indexOf("code: 'META_SAVE_FAILED'");
  assert.ok(changedAt > 0 && persistAt > 0 && failedAt > 0, 'chapter:save 要有 META_CHANGED / 补写 / META_SAVE_FAILED 三段');
  assert.ok(persistAt > changedAt, 'META_CHANGED 走救稿出口（外部那一版不许被同 stamp 二次写覆盖），不做补写');
  assert.ok(failedAt > persistAt, '补写要在抛 META_SAVE_FAILED 之前（尽力而为，不掩盖原始错误）');
});

// A2-SAVE-02 / A2-SAVE-03（低）：部分成功分支写字数缓存前必须核书身份；后台全书校验回执落地前必须
// 核「还是当前书 + 还在写作页」。两条判定都收进 save-logic 的纯函数（本文件上方已有行为用例），
// 这里钉住 save-chain-ui 真的走它们 —— 只要回退成裸 findIndex / 裸 toast 就红。
test('A2-SAVE-02/03 接线：部分成功与全书校验提示都过身份复核', () => {
  const partialAt = SAVE_CHAIN_SOURCE.indexOf("err.code === 'META_SAVE_FAILED' && err.bodySaved === true");
  assert.ok(partialAt > 0, 'save-chain-ui.js 里找不到部分成功分支');
  const partialBody = SAVE_CHAIN_SOURCE.slice(partialAt, partialAt + 1200);
  assert.ok(
    partialBody.includes('saveLogic.charsCacheIndexAfterPartialSave({'),
    '部分成功的字数缓存要过 save-logic 的身份判定'
  );
  assert.match(partialBody, /sameBook: sameBookPath\(bookPath, state\.bookPath\)/, '判定要用发起时那本书比');
  assert.equal(
    /state\.chapters\.findIndex\(\(item\) => item && item\.id === chapterId\)/.test(partialBody),
    false,
    '不许再裸 findIndex 就写（跨书覆盖的根因）'
  );

  const verifyAt = SAVE_CHAIN_SOURCE.indexOf('saveLogic.createVerifySingleFlight(');
  assert.ok(verifyAt > 0, '找不到后台全书校验的单飞');
  const verifyBody = SAVE_CHAIN_SOURCE.slice(verifyAt, verifyAt + 1200);
  assert.ok(verifyBody.includes('saveLogic.verifyWarnForView({'), '提示可见性要过 save-logic 判定');
  assert.match(verifyBody, /sameBook: sameBookPath\(bookPath, state\.bookPath\)/, '要核还是不是发起时那本书');
  assert.match(verifyBody, /view: state\.view/, '要核还在不在写作页');
  assert.match(verifyBody, /toast\(notice, 'warn'\)/, '只弹判定通过后的提示');
  assert.equal(/toast\(warn, 'warn'\)/.test(verifyBody), false, '不许再无条件弹 warn');
});
