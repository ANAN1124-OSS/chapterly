// WP4（S-N1 / 中 #5）：备份清理的信任边界锚点 —— 只进回收站 + 主进程一次性计划令牌。
//
// 旧实现（core/storage.js deleteHistoryBackups）：路径校验很严，但每组 `fs.rm(recursive)` 永久删除；
// 保护列表 protectedGroupIds 完全由渲染层给，主进程没有独立确认 —— 注入 / bug 一次 IPC 就能把
// 全书可清理备份清空，且不可恢复（备份是「毁恢复退路」的那一层副本）。
//
// 本文件钉住拍板口径（手册 §2 项 2=A）：
//   R1 没注入回收站 → 报错不动（一个文件都不许删）
//   R2 注入了 → 目录移进回收站可原样读回；快照 / 散文件 / 书目备份一个都不碰
//   R3 回收站不可用（EPERM）→ 一个文件不动，绝不降级成硬删
//   R4 静态：delete 函数体没有 fs.rm / fs.unlink；IPC 层必须 take(令牌) + 注入 shell.trashItem
//   R5 令牌协议：缺失 / 伪造 / 重放 / 换书 / 组清单漂移 → 拒绝且一个文件不动
//   R6 空保护列表 → 三组全部进回收站（拍板锚点）
//   R7 10 秒撤销窗口内的组不被清理（plan 与 delete 两侧都跳过）
//   R8 极值 × IO：5001 条清单、含空格路径、64 MB 稀疏文件、目录被换成普通文件、目录缺失、逐组部分失败
//   R9 plan 只读：解析前后内容 / mtime 一个字节不变
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const storage = require('../core/storage');
const bookDataIpc = require('../ipc/book-data');
const errorText = require('../core/error-text');
const tmpCleanup = require('./tmp-cleanup');

const ROOT = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFile(path.join(ROOT, rel), 'utf8');

// TB-02：临时目录统一经 tests/tmp-cleanup.js 的 mkTmp（mkdtemp + 登记回收）。
const mkTmp = (prefix = 'cw-wp4-') => tmpCleanup.mkTmp(prefix);

async function makeBook(root, title = '备份清理书') {
  return storage.createBook(root, title);
}

async function writeBackupDir(bookPath, name, files) {
  const dir = path.join(bookPath, '_trash', name);
  await fs.mkdir(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, file), text, 'utf8');
  }
  return dir;
}

// 假回收站：真把目录 move 过去（rename 同盘原子），用于验证「可恢复」而不是「永久消失」。
function makeRecycleBin(root) {
  const bin = path.join(root, '_fake-recycle-bin');
  const moved = [];
  const trash = async (target) => {
    await fs.mkdir(bin, { recursive: true });
    const dest = path.join(bin, `${String(moved.length).padStart(3, '0')}-${path.basename(target)}`);
    await fs.rename(target, dest);
    moved.push({ target, dest });
  };
  return { bin, moved, trash };
}

// 装配真实 ipc/book-data.js：handleBook 记下 (fn, options)，其余宿主给最小桩。
function makeHost({ shell, fs: fsOverride } = {}) {
  const channels = new Map();
  const host = {
    handleBook: (channel, fn, options) => channels.set(channel, { fn, options }),
    storage,
    ipcLimits: {
      sanitizeSearchOptions: (value) => value,
      sanitizeReplaceOptions: (value) => value
    },
    fs: fsOverride || fs,
    path,
    shell: shell || { trashItem: async () => {}, openPath: async () => '' },
    errorText,
    sendToFlow: () => {},
    // T-08：book-data 的正文改写通道会标脏搜索索引
    getSearchIndexStore: () => ({ markDirty: () => {} }),
    logError: () => {}
  };
  bookDataIpc.register(host);
  return { channels };
}

function channelOf(channels, name) {
  const entry = channels.get(name);
  assert.ok(entry, `ipc/book-data.js 没有注册 ${name}`);
  return entry;
}

const REPLACE_ID = 'dir:替换备份-2026-10-31-210000';
const FORMAT_ID = 'dir:整理备份-2026-10-31-200000';
const RESTORE_ID = 'dir:还原前备份-2026-10-31-190000';
const ALL_IDS = [REPLACE_ID, FORMAT_ID, RESTORE_ID];

async function seedThreeGroups(bookPath, files = { '001-a.txt': '甲', '002-b.txt': '乙' }) {
  const replaceDir = await writeBackupDir(bookPath, '替换备份-2026-10-31-210000', files);
  const formatDir = await writeBackupDir(bookPath, '整理备份-2026-10-31-200000', files);
  const restoreDir = await writeBackupDir(bookPath, '还原前备份-2026-10-31-190000', files);
  return { replaceDir, formatDir, restoreDir };
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

test('R1 未注入回收站 → 报错不动：TRASH_UNAVAILABLE 且三组目录原样保留', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await makeBook(root, '没有回收站的书');
  const dirs = await seedThreeGroups(bookPath);
  await assert.rejects(
    () => storage.deleteHistoryBackups(bookPath, ALL_IDS),
    (err) => {
      assert.equal(err.code, 'TRASH_UNAVAILABLE', `应报 TRASH_UNAVAILABLE，实际 ${err.code}: ${err.message}`);
      return true;
    }
  );
  for (const dir of Object.values(dirs)) {
    assert.deepEqual((await fs.readdir(dir)).sort(), ['001-a.txt', '002-b.txt'], `${path.basename(dir)} 一个字节都不能动`);
  }
});

test('R2 注入回收站 → 移进去可原样读回；快照 / 散文件 / 书目备份一个都不碰', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await makeBook(root, '回收站书');
  await seedThreeGroups(bookPath);
  const snapshotDir = await writeBackupDir(bookPath, '快照-20261031', { '001-a.txt': '快照正文' });
  const loose = path.join(bookPath, '_trash', '2026-10-31-215000-003-已删.txt');
  await fs.writeFile(loose, '删章正文', 'utf8');
  const bakPath = path.join(bookPath, '书目.json.bak');
  await fs.writeFile(bakPath, '{}', 'utf8');
  const bin = makeRecycleBin(root);

  const result = await storage.deleteHistoryBackups(bookPath, ALL_IDS, { trash: bin.trash });
  assert.equal(result.deletedGroups, 3);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.deletedBytes, Buffer.byteLength('甲乙') * 3);
  assert.equal(bin.moved.length, 3);
  for (const [i, name] of ['替换备份-2026-10-31-210000', '整理备份-2026-10-31-200000', '还原前备份-2026-10-31-190000'].entries()) {
    assert.equal(await exists(path.join(bookPath, '_trash', name)), false, `${name} 必须已离开 _trash`);
    const recovered = path.join(bin.bin, `${String(i).padStart(3, '0')}-${name}`);
    assert.deepEqual((await fs.readdir(recovered)).sort(), ['001-a.txt', '002-b.txt'], `${name} 回收站里必须能原样读回`);
    assert.equal(await fs.readFile(path.join(recovered, '001-a.txt'), 'utf8'), '甲');
  }
  // 非三类备份原样保留
  assert.deepEqual(await fs.readdir(snapshotDir), ['001-a.txt']);
  assert.equal(await fs.readFile(loose, 'utf8'), '删章正文');
  assert.equal(await fs.readFile(bakPath, 'utf8'), '{}');

  // 再删一次：已经不在 → missing 跳过，不抛
  const again = await storage.deleteHistoryBackups(bookPath, ALL_IDS, { trash: bin.trash });
  assert.equal(again.deletedGroups, 0);
  assert.equal(again.skipped.filter((item) => item.reason === 'missing').length, 3);
});

test('R3 回收站不可用（EPERM）→ 一个文件不动，逐组如实报错，绝不降级硬删', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await makeBook(root, '回收站禁用书');
  const dirs = await seedThreeGroups(bookPath);
  const trash = async () => {
    throw Object.assign(new Error('回收站被策略禁用'), { code: 'EPERM' });
  };
  const result = await storage.deleteHistoryBackups(bookPath, ALL_IDS, { trash });
  assert.equal(result.deletedGroups, 0);
  assert.equal(result.deletedBytes, 0);
  assert.equal(result.skipped.length, 3);
  for (const item of result.skipped) {
    assert.equal(item.reason, 'trash-failed', JSON.stringify(item));
    // 文案走 core/error-text 的统一脱敏（EPERM → 「操作被系统拒绝…」），不泄漏原路径 / 内部错误串
    assert.ok(item.message && item.message.length > 0, '失败必须带可读原因');
    assert.doesNotMatch(item.message, /\\|\/书库\/|EPERM/, '失败原因不能泄漏本机路径');
  }
  for (const dir of Object.values(dirs)) {
    assert.deepEqual((await fs.readdir(dir)).sort(), ['001-a.txt', '002-b.txt'], '报错不动：一个文件都不许消失');
  }
});

test('R4 静态闸门：delete 函数体没有 fs.rm / fs.unlink；IPC 先 take(令牌) 再注入 shell.trashItem', async () => {
  const storageSrc = await readSrc('core/storage.js');
  const deleteBody = storageSrc.slice(
    storageSrc.indexOf('async function deleteHistoryBackups('),
    storageSrc.indexOf('async function previewHistoryFile(')
  );
  assert.ok(deleteBody.includes('async function deleteHistoryBackups('), '取不到 deleteHistoryBackups 函数体');
  assert.doesNotMatch(deleteBody, /fs\.rm\(|fs\.unlink\(/, '备份清理绝不允许再出现永久删除');
  assert.match(deleteBody, /trash\(/, '必须只走注入的回收站动作');

  const ipcSrc = await readSrc('ipc/book-data.js');
  const deleteIpc = ipcSrc.slice(
    ipcSrc.indexOf("handleBook('book:delete-history-backups'"),
    ipcSrc.indexOf('// 清空某一天的每日快照')
  );
  assert.match(deleteIpc, /deletePlanTokens\.take\(/, '删除频道必须先验一次性计划令牌');
  assert.match(deleteIpc, /shell\.trashItem\(dir\)/, '主进程注入的删除动作只能是回收站');
  assert.match(ipcSrc, /handleBook\('book:plan-delete-history-backups'/, '缺计划频道：令牌无从发放');
  const planIpc = ipcSrc.slice(
    ipcSrc.indexOf("handleBook('book:plan-delete-history-backups'"),
    ipcSrc.indexOf("handleBook('book:delete-history-backups'")
  );
  assert.match(planIpc, /planHistoryBackupDeletion\(/, '计划频道必须由 storage 独立解析可清理组');
  assert.match(planIpc, /deletePlanTokens\.issue\(/, '计划频道必须发一次性令牌');
  assert.ok(planIpc.trimEnd().endsWith('READ_ONLY)') || planIpc.includes('}, READ_ONLY)'), '计划频道不能是写操作');

  const preloadSrc = await readSrc('preload.js');
  assert.match(preloadSrc, /planDeleteHistoryBackups:\s*\(bookPath, groupIds, options\)/, 'preload 必须暴露计划方法');
  assert.match(preloadSrc, /invoke\('book:plan-delete-history-backups'/, 'preload 频道名与主进程注册必须一致');
  assert.match(preloadSrc, /planToken/, '渲染层要把令牌带回删除频道（注释可证）');
});

test('R5 令牌协议：缺失 / 伪造 / 重放 / 换书 / 清单漂移 → 拒绝且一个文件不动', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await makeBook(root, '令牌书甲');
  const { path: otherBook } = await makeBook(root, '令牌书乙');
  const bin = makeRecycleBin(root);
  const { channels } = makeHost({ shell: { trashItem: bin.trash, openPath: async () => '' } });
  const plan = channelOf(channels, 'book:plan-delete-history-backups');
  const del = channelOf(channels, 'book:delete-history-backups');

  const dirs = await seedThreeGroups(bookPath);

  // 1) 没有令牌：拒绝，一个文件不动
  await assert.rejects(
    () => del.fn(bookPath, ALL_IDS, { protectedGroupIds: [] }),
    (err) => {
      assert.equal(err.code, 'DELETE_PLAN_INVALID');
      return true;
    }
  );
  for (const dir of Object.values(dirs)) assert.ok(await exists(dir), '没令牌时一个目录都不能消失');

  // 2) 伪造令牌：拒绝
  await assert.rejects(
    () => del.fn(bookPath, ALL_IDS, { protectedGroupIds: [], planToken: 'forged-token' }),
    (err) => err.code === 'DELETE_PLAN_INVALID'
  );

  // 3) 合法计划：空保护列表 → 三组全进回收站
  const good = await plan.fn(bookPath, ALL_IDS, { protectedGroupIds: [] });
  assert.equal(good.groupCount, 3);
  assert.ok(good.planToken, '计划必须回令牌');
  const done = await del.fn(bookPath, ALL_IDS, { protectedGroupIds: [], planToken: good.planToken });
  assert.equal(done.deletedGroups, 3);
  assert.equal(bin.moved.length, 3);

  // 4) 重放同一张令牌：拒绝，且新放回的目录一个字节不动
  await writeBackupDir(bookPath, '替换备份-2026-10-31-210000', { '001-a.txt': '重放' });
  await assert.rejects(
    () => del.fn(bookPath, [REPLACE_ID], { protectedGroupIds: [], planToken: good.planToken }),
    (err) => err.code === 'DELETE_PLAN_INVALID'
  );
  assert.ok(await exists(path.join(bookPath, '_trash', '替换备份-2026-10-31-210000')), '重放令牌不能删任何东西');

  // 5) 换书：令牌只属于书甲
  const forOther = await plan.fn(otherBook, [FORMAT_ID], { protectedGroupIds: [] });
  await writeBackupDir(otherBook, '整理备份-2026-10-31-200000', { '001-a.txt': '别的书' });
  await assert.rejects(
    () => del.fn(bookPath, [FORMAT_ID], { protectedGroupIds: [], planToken: forOther.planToken }),
    (err) => err.code === 'DELETE_PLAN_INVALID'
  );

  // 6) 清单漂移：计划两组、回来三组
  const two = await plan.fn(bookPath, [REPLACE_ID, FORMAT_ID], { protectedGroupIds: [] });
  await assert.rejects(
    () => del.fn(bookPath, [REPLACE_ID, FORMAT_ID, RESTORE_ID], { protectedGroupIds: [], planToken: two.planToken }),
    (err) => {
      assert.equal(err.code, 'DELETE_PLAN_INVALID');
      return true;
    }
  );
});

test('R6 拍板锚点：注入空保护列表 → plan 报全可清理、三组全部进回收站（不是永久消失）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await makeBook(root, '空保护书');
  await seedThreeGroups(bookPath);
  const bin = makeRecycleBin(root);
  const { channels } = makeHost({ shell: { trashItem: bin.trash, openPath: async () => '' } });
  const planned = await channelOf(channels, 'book:plan-delete-history-backups').fn(bookPath, ALL_IDS, {
    protectedGroupIds: []
  });
  assert.deepEqual(planned.cleanable.map((item) => item.id).sort(), ALL_IDS.slice().sort());
  assert.equal(planned.recoverable, true, '清理必须声明「可恢复」');
  assert.equal(planned.totalBytes, Buffer.byteLength('甲乙') * 3);
  await channelOf(channels, 'book:delete-history-backups').fn(bookPath, ALL_IDS, {
    protectedGroupIds: [],
    planToken: planned.planToken
  });
  assert.equal(bin.moved.length, 3, '三组必须都在回收站里');
  const left = await fs.readdir(path.join(bookPath, '_trash'));
  assert.deepEqual(left.filter((name) => /^(替换|整理|还原前)备份/.test(name)), [], '_trash 里不该再有它们');
});

test('R7 10 秒撤销窗口内的组不被清理（plan 与 delete 两侧都跳过，其它组照常进回收站）', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await makeBook(root, '撤销保护书');
  const dirs = await seedThreeGroups(bookPath);
  const bin = makeRecycleBin(root);
  const { channels } = makeHost({ shell: { trashItem: bin.trash, openPath: async () => '' } });
  const protectedId = RESTORE_ID;

  const planned = await channelOf(channels, 'book:plan-delete-history-backups').fn(bookPath, ALL_IDS, {
    protectedGroupIds: [protectedId]
  });
  assert.deepEqual(planned.cleanable.map((item) => item.id).sort(), [REPLACE_ID, FORMAT_ID].sort());
  assert.deepEqual(
    planned.skipped.find((item) => item.id === protectedId),
    { id: protectedId, name: '还原前备份-2026-10-31-190000', reason: 'active-undo' }
  );

  const result = await channelOf(channels, 'book:delete-history-backups').fn(bookPath, ALL_IDS, {
    protectedGroupIds: [protectedId],
    planToken: planned.planToken
  });
  assert.equal(result.deletedGroups, 2);
  assert.deepEqual((await fs.readdir(dirs.restoreDir)).sort(), ['001-a.txt', '002-b.txt'], '撤销窗口内的组必须留着');
  assert.equal(await exists(dirs.replaceDir), false);
  assert.equal(await exists(dirs.formatDir), false);
});

test('R8 极值 × IO：5001 条清单 / 含空格路径 / 64 MB 稀疏文件 / 非目录撞名 / 缺失 / 逐组部分失败', async () => {
  const root = await mkTmp();

  // ① 5001 条清单：截到 5000，不崩、不乱删
  {
    const { path: bookPath } = await makeBook(root, '极值清单书');
    const bin = makeRecycleBin(root);
    const many = Array.from({ length: 5001 }, (_, i) => `dir:整理备份-${String(i).padStart(4, '0')}`);
    const result = await storage.deleteHistoryBackups(bookPath, many, { trash: bin.trash });
    assert.equal(result.skipped.length, 5000, '最多处理 5000 条');
    assert.equal(bin.moved.length, 0);
  }

  // ② 含空格 / 中文的书路径 + 64 MB 稀疏文件：只 stat 不读进内存，仍然进回收站
  {
    const { path: spacedBook } = await makeBook(root, '空 格 书 名');
    const dir = await writeBackupDir(spacedBook, '替换备份-2026-10-31-210000', { '001-a.txt': '正文' });
    const sparse = path.join(dir, '002-超大.txt');
    await fs.writeFile(sparse, '');
    await fs.truncate(sparse, 64 * 1024 * 1024);
    const bin = makeRecycleBin(root);
    const planned = await storage.planHistoryBackupDeletion(spacedBook, [REPLACE_ID], { protectedGroupIds: [] });
    assert.equal(planned.groupCount, 1);
    assert.equal(planned.totalBytes, Buffer.byteLength('正文') + 64 * 1024 * 1024, '按 stat 字节算，不读内容');
    const result = await storage.deleteHistoryBackups(spacedBook, [REPLACE_ID], { trash: bin.trash });
    assert.equal(result.deletedGroups, 1);
    assert.equal((await fs.stat(path.join(bin.bin, '000-替换备份-2026-10-31-210000', '002-超大.txt'))).size, 64 * 1024 * 1024);
  }

  // ③ 目录被换成同名普通文件 → not-cleanable；目录缺失 → missing；都不抛
  {
    const { path: bookPath } = await makeBook(root, '怪目录书');
    const trashDir = path.join(bookPath, '_trash');
    await fs.mkdir(trashDir, { recursive: true });
    await fs.writeFile(path.join(trashDir, '替换备份-2026-10-31-180000'), '不是目录', 'utf8');
    const bin = makeRecycleBin(root);
    const result = await storage.deleteHistoryBackups(
      bookPath,
      ['dir:替换备份-2026-10-31-180000', 'dir:整理备份-2000-01-01-000000'],
      { trash: bin.trash }
    );
    assert.equal(result.deletedGroups, 0);
    assert.equal(result.skipped.find((item) => item.id === 'dir:替换备份-2026-10-31-180000').reason, 'not-cleanable');
    assert.equal(result.skipped.find((item) => item.id === 'dir:整理备份-2000-01-01-000000').reason, 'missing');
    assert.equal(await fs.readFile(path.join(trashDir, '替换备份-2026-10-31-180000'), 'utf8'), '不是目录');
  }

  // ④ 逐组部分失败：成功组进回收站，失败组原样保留
  {
    const { path: bookPath } = await makeBook(root, '部分失败书');
    const dirs = await seedThreeGroups(bookPath);
    let calls = 0;
    const trash = async (target) => {
      calls += 1;
      if (path.basename(target).startsWith('替换备份')) {
        throw Object.assign(new Error('这一组被占用'), { code: 'EPERM' });
      }
      const bin = path.join(root, 'partial-bin');
      await fs.mkdir(bin, { recursive: true });
      await fs.rename(target, path.join(bin, `${calls}-${path.basename(target)}`));
    };
    const result = await storage.deleteHistoryBackups(bookPath, ALL_IDS, { trash });
    assert.equal(result.deletedGroups, 2);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, 'trash-failed');
    assert.ok(await exists(dirs.replaceDir), '失败的那一组一个字节不动');
    assert.equal(await exists(dirs.formatDir), false);
    assert.equal(await exists(dirs.restoreDir), false);
  }
});

test('R9 plan 只读：解析可清理组前后，目录内容 / mtime / 大小一个字节不变', async () => {
  const root = await mkTmp();
  const { path: bookPath } = await makeBook(root, '只读计划书');
  const dir = await writeBackupDir(bookPath, '替换备份-2026-10-31-210000', { '001-a.txt': '不动我' });
  const file = path.join(dir, '001-a.txt');
  const before = await fs.stat(file);
  const planned = await storage.planHistoryBackupDeletion(bookPath, [REPLACE_ID, FORMAT_ID], {
    protectedGroupIds: []
  });
  assert.equal(planned.groupCount, 1);
  assert.deepEqual(planned.skipped, [{ id: FORMAT_ID, name: '整理备份-2026-10-31-200000', reason: 'missing' }]);
  const after = await fs.stat(file);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(await fs.readFile(file, 'utf8'), '不动我');
});