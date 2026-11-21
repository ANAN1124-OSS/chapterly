'use strict';
// WP18 第 3–4 轮的主进程运行 / 配置接线锚点（TEST-D-01：按子域从 tests/wp18-low-batch.test.js 拆出）。
// 本文件只收「启动回收、config 写前钩子、字体读取、剪贴板广播、窗口几何」：
//   R16  C3：启动回收 lastExportDir 的孤儿 tmp（口径与 userData / 书目录一致）
//   R17  C2：config:set 的判根 / mkdir 与写盘同一个 enqueue（beforeWrite 钩子）
//   R20  E2：font:read 同句柄 open→fstat→read（TOCTOU 窗口归零）
//   R21  A1：剪贴板监听三处通知复用 broadcast（发送策略单点）
//   R22  A4：saveRecentWindowBounds 只构造一次 nextBounds 并复用到写盘
// R18（CI 矩阵）/ R19（mkdtemp 卫生闸门）/ R23（appId 拍板）/ R24（维护者文档拆分）已按职责
// 迁到 tests/ci-workflow.test.js / tests/wp38-hygiene.test.js / tests/wp39-docs.test.js。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const storage = require('../core/storage');
const atomic = require('../core/atomic');
const { createConfigStore } = require('../core/config');
const tmpCleanup = require('./tmp-cleanup');

async function mkTmp(prefix = 'cw-wp18-') {
  return tmpCleanup.track(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readSource(rel) {
  return require('node:fs').readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
}
// ---------- R16：C3 导出目录孤儿 tmp ----------

test('R16 C3：启动回收 lastExportDir 的孤儿 tmp（口径与 userData / 书目录一致）', async () => {
  const dir = await mkTmp('cw-wp18-exportdir-');
  const now = Date.now();
  const oldName = `.导出书.epub.tmp-999999-${now - 2 * 60 * 60 * 1000}-abcd12`;
  const freshName = `.导出书.epub.tmp-999999-${now - 1000}-efgh34`;
  const ownName = `.导出书.epub.tmp-${process.pid}-${now - 2 * 60 * 60 * 1000}-ijkl56`;
  await fs.writeFile(path.join(dir, oldName), '崩溃残留', 'utf8');
  await fs.writeFile(path.join(dir, freshName), '另一个进程可能正在写', 'utf8');
  await fs.writeFile(path.join(dir, ownName), '本进程的临时文件', 'utf8');
  // 判据是**文件 mtime**（名字里的时间戳只是标识）：把崩溃残留 / 本进程的临时文件都退到 2 小时前
  const old = new Date(now - 2 * 60 * 60 * 1000);
  await fs.utimes(path.join(dir, oldName), old, old);
  await fs.utimes(path.join(dir, ownName), old, old);
  await fs.writeFile(path.join(dir, '导出书.epub'), '正常产物', 'utf8');
  await fs.writeFile(path.join(dir, '.别人的临时文件'), '不是本应用命名的', 'utf8');
  await fs.mkdir(path.join(dir, '.目录.tmp-999999-1-zzzz11'));

  const swept = await atomic.cleanupOrphanTmpFiles(dir, { now });
  assert.deepEqual(swept, { removed: 1, kept: 2 }, '只清崩溃残留（外 pid + 超 1 小时）');
  assert.equal(await storage.exists(path.join(dir, oldName)), false, '崩溃残留要清掉');
  for (const keep of [freshName, ownName, '导出书.epub', '.别人的临时文件']) {
    assert.equal(await storage.exists(path.join(dir, keep)), true, `不许动：${keep}`);
  }
  assert.equal(await storage.exists(path.join(dir, '.目录.tmp-999999-1-zzzz11')), true, '同名目录不碰');

  // 目录不存在 / 目标被普通文件占据：返回 0/0，绝不抛（导出目录可能在移动硬盘上）
  assert.deepEqual(await atomic.cleanupOrphanTmpFiles(path.join(dir, '没有这个目录'), { now }), { removed: 0, kept: 0 });
  await fs.writeFile(path.join(dir, '其实是个文件'), 'x', 'utf8');
  assert.deepEqual(await atomic.cleanupOrphanTmpFiles(path.join(dir, '其实是个文件'), { now }), { removed: 0, kept: 0 });

  // 静态：启动链在配置读完（getConfig）之后、建窗之前回收 lastExportDir，且失败不影响启动
  const mainSrc = readSource('main.js');
  const userDataAt = mainSrc.indexOf("cleanupOrphanTmpFiles(app.getPath('userData'))");
  const exportAt = mainSrc.indexOf('cleanupOrphanTmpFiles(exportDir)');
  assert.ok(userDataAt > 0, 'userData 回收必须仍在');
  assert.ok(exportAt > userDataAt, '导出目录回收要排在 userData 之后（启动链同一处）');
  assert.ok(exportAt < mainSrc.indexOf('createWindow({ runAutomationFlow: true })'), '要在建窗之前回收');
  assert.match(mainSrc, /const exportDir = .*lastExportDir/, '导出目录取自配置的 lastExportDir');
  assert.match(mainSrc, /cleanupOrphanTmpFiles\(exportDir\)\.catch\(\(\) => \{\}\)/, '尽力而为：失败不影响启动');
});


test('R17 C2：config:set 的判根 / mkdir 与写盘同一个 enqueue（beforeWrite 钩子）', async () => {
  const dir = await mkTmp('cw-wp18-c2-');
  const rootA = path.join(dir, '新书架 有空格');
  const hookLog = [];
  let releaseSlowWrite = null;
  const slowWrite = new Promise((resolve) => {
    releaseSlowWrite = resolve;
  });
  const store = createConfigStore(dir, {
    write: async (file, next) => {
      hookLog.push(`write:${next.booksRoot}`);
      if (next.booksRoot === rootA) await slowWrite;
      await atomic.writeJsonAtomic(file, next);
    }
  });
  const initial = await store.get();

  // 并发：A 换根（写盘慢，占住队列），B 紧接着入队改无关设置。
  // B 的钩子必须看到 A 已提交的 booksRoot —— 说明钩子拿到的是队列内 current，而不是入队前的快照。
  const first = store.set(
    { booksRoot: rootA },
    {
      beforeWrite: ({ current, next }) => {
        hookLog.push(`hookA:${current.booksRoot}->${next.booksRoot}`);
      }
    }
  );
  await sleep(5);
  const second = store.set(
    { editorFontSize: 21 },
    {
      beforeWrite: ({ current }) => {
        hookLog.push(`hookB:${current.booksRoot}`);
      }
    }
  );
  await sleep(5);
  releaseSlowWrite();
  await Promise.all([first, second]);

  assert.deepEqual(
    hookLog.filter((line) => line.startsWith('hook')),
    [`hookA:${initial.booksRoot}->${rootA}`, `hookB:${rootA}`],
    '后一个 set 的钩子必须看到前一个 set 已提交的 booksRoot（队列内 current）'
  );
  assert.ok(
    hookLog.findIndex((line) => line.startsWith('hookA:')) < hookLog.indexOf(`write:${rootA}`),
    '钩子必须在写盘之前跑'
  );
  const disk = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(disk.booksRoot, rootA, '换根写盘成功');
  assert.equal(disk.editorFontSize, 21, '第二个 set 不能吞掉第一个的 patch');

  // 失败注入：钩子抛错 ⇒ 不写盘、cache 与磁盘都保持旧值（E3：建不出来配置一个字都不写）
  const beforeBytes = await fs.readFile(path.join(dir, 'config.json'), 'utf8');
  let writeCalls = 0;
  const failingStore = createConfigStore(dir, {
    write: async (file, next) => {
      writeCalls += 1;
      await atomic.writeJsonAtomic(file, next);
    }
  });
  await failingStore.get();
  const hookError = Object.assign(new Error('模拟 EACCES：目标书架建不出来'), { code: 'EACCES' });
  await assert.rejects(
    () => failingStore.set({ editorFontSize: 19 }, { beforeWrite: async () => { throw hookError; } }),
    (err) => err.code === 'EACCES'
  );
  assert.equal(writeCalls, 0, '钩子抛错时一个字都不写盘');
  assert.equal((await failingStore.get()).editorFontSize, 21, 'cache 保持旧值，不假装已保存');
  assert.equal(await fs.readFile(path.join(dir, 'config.json'), 'utf8'), beforeBytes, '磁盘旧字节不动');

  // 不传钩子时行为与旧实现一致（回归保护）
  await failingStore.set({ editorFontSize: 19 });
  assert.equal(writeCalls, 1);
  assert.equal((await failingStore.get()).editorFontSize, 19);

  // 静态：main.js 的 mkdir 必须搬进 configStore.set 的 beforeWrite（与写盘同一个 enqueue）
  const mainSrc = readSource('main.js');
  const body = mainSrc.slice(mainSrc.indexOf("handle('config:set'"), mainSrc.indexOf("handle('config:test-pick'"));
  const setAt = body.indexOf('configStore.set(gated.patch, {');
  assert.ok(setAt > 0, 'config:set 的 set 必须带写前钩子（否则判根仍是队列外快照）');
  const hookAt = body.indexOf('async beforeWrite({ current: freshCurrent })', setAt);
  assert.ok(hookAt > setAt, 'beforeWrite 必须作为 configStore.set 的选项传入');
  const mkdirAt = body.indexOf('fs.mkdir(', setAt);
  assert.ok(mkdirAt > hookAt, 'mkdir 必须在钩子内（同一次 enqueue、写盘之前）');
  assert.equal((body.match(/fs\.mkdir\(/g) || []).length, 1, 'config:set 里只该有这一处 mkdir');
  assert.match(body, /previousRoot = decorateConfig\(sanitizeConfig\(freshCurrent\)\)\.booksRoot;/, '换根前的生效根要用队列内 current');
  assert.match(
    body,
    /targetRoot = decorateConfig\(sanitizeConfig\(\{ \.\.\.freshCurrent, \.\.\.gated\.patch \}\)\)\.booksRoot;/,
    '目标根要按队列内 current + 放行后的 patch 算'
  );
  assert.match(
    body,
    /if \(configGate\.booksRootChanged\(previousRoot, targetRoot\)\) \{\s*await fs\.mkdir\(targetRoot, \{ recursive: true \}\);\s*\}/,
    'mkdir 仍只在书架根真的变化时做'
  );
  assert.match(body, /if \(configGate\.booksRootChanged\(previousRoot, nextConfig\.booksRoot\)\)/, '写后清锁 / 广播仍用同一判据');
  // core 实现的契约：beforeWrite 必须在 writeJson 之前（集合内唯一一处 set(patch, options)）
  const configSrc = readSource('core/config.js');
  const configSetStart = configSrc.indexOf('function set(patch, options = {})');
  const configSetBodyStart = configSrc.indexOf(') {', configSetStart);
  const configSetBody = configSrc.slice(configSetBodyStart, configSrc.indexOf('\n  }\n', configSetBodyStart));
  assert.ok(
    configSetBody.indexOf('await beforeWrite({ current, next });') < configSetBody.indexOf('await writeJson(file, next);'),
    'config.js 的写前钩子必须先于 writeJson'
  );
});


test('R20 E2：font:read 同句柄 open→fstat→read（TOCTOU 窗口归零）', async () => {
  const fontReadLib = require('../core/font-read');
  assert.equal(typeof fontReadLib.openFontFile, 'function', 'core/font-read.js 必须导出 openFontFile');

  // 假 fs：open 之后路径立刻被换掉。只许读句柄；任何按路径的 stat / readFile 都直接抛。
  const original = Buffer.from('font-bytes-original');
  const swapped = Buffer.from('font-bytes-swapped');
  let openedContent = original;
  const fakeStats = { size: original.length, mtimeMs: 1700000000000, isFile: () => true };
  const handle = {
    statCalls: 0,
    readCalls: 0,
    closeCalls: 0,
    async stat() {
      this.statCalls += 1;
      return fakeStats;
    },
    async readFile() {
      this.readCalls += 1;
      return openedContent;
    },
    async close() {
      this.closeCalls += 1;
    }
  };
  const opened = [];
  let pathStatCalls = 0;
  let pathReadCalls = 0;
  const fsLike = {
    async open(target, mode) {
      opened.push({ target, mode });
      openedContent = original;
      // 打开之后、读取之前，路径被外部换成别的文件（模拟 TOCTOU）
      return handle;
    },
    async stat() {
      pathStatCalls += 1;
      return { size: swapped.length, mtimeMs: 1, isFile: () => true };
    },
    async readFile() {
      pathReadCalls += 1;
      return swapped;
    }
  };

  let validated = null;
  const loaded = await fontReadLib.openFontFile(fsLike, 'D:\\字体 有空格\\A.ttf', {
    validate(stat) {
      validated = stat;
    }
  });
  assert.equal(opened.length, 1, '只 open 一次');
  assert.equal(opened[0].mode, 'r', '只读打开');
  assert.equal(validated, fakeStats, 'validate 拿到的是句柄 fstat 的结果');
  const buffer = await loaded.read();
  assert.deepEqual(buffer, original, '读到的是打开时那份文件（不是按路径重读的替换文件）');
  assert.equal(handle.readCalls, 1);
  assert.equal(pathStatCalls, 0, '不许按路径 stat');
  assert.equal(pathReadCalls, 0, '不许按路径 readFile');
  await loaded.close();
  await loaded.close();
  assert.equal(handle.closeCalls, 1, 'close 幂等（只关一次）');

  // validate 抛错（非字体 / 超限）：句柄关闭、零读取
  const failHandle = {
    statCalls: 0,
    readCalls: 0,
    closeCalls: 0,
    async stat() {
      this.statCalls += 1;
      return { size: 25 * 1024 * 1024, isFile: () => true };
    },
    async readFile() {
      this.readCalls += 1;
      return Buffer.alloc(0);
    },
    async close() {
      this.closeCalls += 1;
    }
  };
  const tooBig = Object.assign(new Error('字体文件太大'), { code: 'FONT_TOO_BIG' });
  await assert.rejects(
    () =>
      fontReadLib.openFontFile(
        { open: async () => failHandle },
        'D:\\字体\\超大.ttf',
        {
          validate() {
            throw tooBig;
          }
        }
      ),
    (err) => err.code === 'FONT_TOO_BIG'
  );
  assert.equal(failHandle.readCalls, 0, '闸门没过不许读');
  assert.equal(failHandle.closeCalls, 1, '抛错也要关句柄');

  // open 失败原样抛（ENOENT 由上层 fail() 脱敏，不在这一层改码）
  const enoent = Object.assign(new Error('ENOENT: 字体不存在'), { code: 'ENOENT' });
  await assert.rejects(
    () =>
      fontReadLib.openFontFile(
        {
          open: async () => {
            throw enoent;
          }
        },
        'D:\\字体\\没有.ttf'
      ),
    (err) => err.code === 'ENOENT'
  );

  // main.js 静态：font:read 走 openFontFile + 句柄读取，不再按路径 stat / readFile
  const mainSrc = readSource('main.js');
  const fontBody = mainSrc.slice(mainSrc.indexOf("handle('font:read'"), mainSrc.indexOf("handle('font:test-pick'"));
  assert.match(fontBody, /openFontFile\(fs, realPath, \{/, 'font:read 必须在 realpath 之后开句柄');
  assert.match(fontBody, /const buffer = await loaded\.read\(\);/, '未命中缓存时从同一句柄读');
  assert.match(fontBody, /await loaded\.close\(\)\.catch\(\(\) => \{\}\)/, '必须在 finally 里关句柄');
  assert.equal(/fs\.stat\(realPath\)/.test(fontBody), false, '不许再按路径 stat（TOCTOU）');
  assert.equal(/fs\.readFile\(realPath\)/.test(fontBody), false, '不许再按路径 readFile（TOCTOU）');
  assert.ok(
    fontBody.indexOf('fontReadCache.get(cacheKey)') < fontBody.indexOf('loaded.read()'),
    '缓存命中时仍零读盘（get 在 read 之前）'
  );
});

test('R21 A1：剪贴板监听三处通知复用 broadcast（发送策略单点）', () => {
  const mainSrc = readSource('main.js');
  const start = mainSrc.indexOf('async function pollClipboardWatch() {');
  const end = mainSrc.indexOf('// 打开面板前补一拍');
  assert.ok(start > 0 && end > start, 'main.js 里要能找到 pollClipboardWatch 与下一段注释');
  const body = mainSrc.slice(start, end);

  // 三处载荷（超限 / 入队 / 轻提示）都改走同一份 broadcast；不再各写一遍逐窗口 try/catch。
  assert.match(body, /broadcast\('clipboard:changed', tooLargePayload\)/, '超限提示必须复用 broadcast');
  assert.match(body, /broadcast\('clipboard:recorded', recordedPayload\)/, '入队通知必须复用 broadcast');
  assert.match(body, /broadcast\('clipboard:changed', payload\)/, '轻提示必须复用 broadcast');
  assert.equal(
    /for \(const session of windowSessions\.values\(\)\)/.test(body),
    false,
    '三处手写逐窗口循环要删掉（发送策略只留 broadcast 单点）'
  );
  assert.equal(/webContents\.send\(/.test(body), false, '轮询体内不许再直接 webContents.send');
  // 载荷形状不变：只带字数 / 条数（和审计 A1 的安全口径一起钉住）。
  assert.match(body, /const tooLargePayload = \{ tooLarge: true, chars: added\.chars, queued: captureQueue\.size\(\) \}/);
  assert.match(body, /const recordedPayload = \{ queued: captureQueue\.size\(\) \}/);
  assert.match(body, /const payload = \{ chars: decision\.chars, queued: captureQueue\.size\(\) \}/);
  assert.equal(/clipboard:(changed|recorded)'[^)]*\btext\b/i.test(body), false, '通知载荷绝不许带正文');

  // broadcast 本体仍是逐窗口 try/catch 单发，并保留 except（书架广播仍在用）。
  const broadcastStart = mainSrc.indexOf('function broadcast(channel, payload, { except = null } = {}) {');
  assert.ok(broadcastStart > 0, 'broadcast 的签名 / except 参数不许改');
  const broadcastBody = mainSrc.slice(broadcastStart, mainSrc.indexOf('function focusSession('));
  assert.match(broadcastBody, /sendToSession\(session, channel, payload\)/, 'broadcast 必须复用 sendToSession');
  assert.match(mainSrc, /broadcast\('shelf:changed', \{ reason, bookPath: changed \}, \{ except: session \? session\.id : null \}\)/);
});

test('R22 A4：saveRecentWindowBounds 只构造一次 nextBounds 并复用到写盘', () => {
  const mainSrc = readSource('main.js');
  const start = mainSrc.indexOf('async function saveRecentWindowBounds(session) {');
  assert.ok(start > 0, 'main.js 里要有 saveRecentWindowBounds');
  const end = mainSrc.indexOf('// A2（审计 #8 / E3）', start);
  assert.ok(end > start, '要能截到 saveRecentWindowBounds 的函数尾');
  const body = mainSrc.slice(start, end);

  assert.match(body, /const normal = session\.win\.getNormalBounds\(\);/, '仍用 getNormalBounds 取普通态几何（V103）');
  assert.match(
    body,
    /const nextBounds = \{ \.\.\.normal, maximized: session\.win\.isMaximized\(\) \};/,
    '普通态几何 + 最大化标志只算一次，命名 nextBounds'
  );
  assert.equal(
    (body.match(/\{ \.\.\.normal, maximized: session\.win\.isMaximized\(\) \}/g) || []).length,
    1,
    '同一对象不许在写盘处再构造第二次（A4）'
  );
  assert.match(
    body,
    /await configStore\.set\(\{ windowBounds: nextBounds \}, \{ auto: true \}\);\s*return true;/,
    '写盘必须复用同一份 nextBounds'
  );
  assert.match(body, /catch \{\s*return false;/, '写盘失败仍被吞掉返回 false（自动写不阻塞关窗；注入锚点见 config.test.js 的 EPERM 队列用例）');
  const checkAt = body.indexOf('sameWindowBounds(current.windowBounds, nextBounds)');
  const writeAt = body.indexOf('await configStore.set({ windowBounds: nextBounds }');
  assert.ok(checkAt > 0 && writeAt > checkAt, '先比对磁盘现状、再写盘（B10 口径不变）');
});
