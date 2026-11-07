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
const os = require('node:os');
const path = require('node:path');
const storage = require('../core/storage');

const ROOT = path.join(__dirname, '..');
// 源码在工作树里是 CRLF；静态闸门只关心语义，统一成 LF 再切片（免得 indexOf('\n...') 落空）
const MAIN_SOURCE = fss.readFileSync(path.join(ROOT, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const RENDERER_SOURCE = fss.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8').replace(/\r\n/g, '\n');

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cw-partial-save-'));
}

function channelBody(source, channel) {
  const start = source.indexOf(`handleBook('${channel}'`);
  assert.ok(start > 0, `main.js 里找不到 ${channel}`);
  // handleBook 注册以两格缩进的 `});` 收尾（内部嵌套回调缩进更深，不会提前命中）
  const end = source.indexOf('\n  });', start + 1);
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
  const body = channelBody(MAIN_SOURCE, 'chapter:save');
  // 书目写盘在 try/catch 里，catch 抛出带白名单字段的错误
  assert.match(body, /try \{[\s\S]{0,400}?await storage\.writeBookMeta\(bookPath, meta, \{ ensureDir: false \}\);[\s\S]{0,400}?\} catch \(metaErr\) \{/);
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
  assert.match(
    RENDERER_SOURCE,
    /res && res\.bodySaved === true[\s\S]{0,160}?throw new ApiError/,
    'call() 只把部分成功字段透传给 ApiError'
  );
  // saveCurrent 的 catch：认得 META_SAVE_FAILED → warn 提示 + dirty 保持（不显示「保存失败」）
  const saveStart = RENDERER_SOURCE.indexOf('async function saveCurrent(');
  assert.ok(saveStart > 0, 'renderer.js 里找不到 saveCurrent');
  const saveBody = RENDERER_SOURCE.slice(saveStart, RENDERER_SOURCE.indexOf('\n  }\n', saveStart) + 4);
  assert.ok(saveBody.includes("err.code === 'META_SAVE_FAILED'"), 'saveCurrent 要单独处理 META_SAVE_FAILED');
  assert.ok(saveBody.includes('bodySaved: true'), 'saveCurrent 的返回里要标出正文已存');
  assert.match(saveBody, /toast\(err\.message, 'warn'\)/, '部分成功要用 warn 提示（不是「保存失败」的 error）');
  assert.equal(/toast\(`保存失败：\$\{err\.message\}`, 'error'\)/.test(saveBody), true, '整体失败分支保持不变');
});
