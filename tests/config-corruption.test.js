// 配置层测试（T9 / 第 9 轮按域拆分）：空白配置损坏与归档。
//
// 来源：原 tests/config.test.js（2,000 行 / 69 例）按域拆成四个文件，**只搬家不改断言**——
// 用例标题与断言逐字保留，共用夹具收进 tests/config-fixtures.js（T9 纪律，见 tests/README.md）。
// 本文件覆盖：损坏归档与一次性提示 / 首次启动不算损坏 / E25 写前重试三例 /
// R28 peek 语义 / 损坏文件被外部删除或修好 / 配置并发写入。
const test = require('node:test');
const assert = require('node:assert/strict');
const { path, fs, createConfigStore, DEFAULTS, mkTmp } = require('./config-fixtures');

test('配置损坏：归档坏文件、回默认值，并给出一次提示', async () => {
  const dir = await mkTmp();
  await fs.writeFile(path.join(dir, 'config.json'), '{ 这不是合法 JSON ', 'utf8');
  const store = createConfigStore(dir);
  const cfg = await store.get();
  assert.equal(cfg.booksRoot, DEFAULTS.booksRoot);
  const warning = store.takeLoadWarning();
  assert.ok(warning && warning.code === 'CONFIG_CORRUPT');
  assert.equal(store.takeLoadWarning(), null, '提示只给一次');
  const files = await fs.readdir(dir);
  assert.ok(files.some((f) => f.startsWith('config.json.corrupt-')), '坏配置要归档，不能直接删');
  assert.ok(!files.includes('config.json'), '坏文件应已改名归档');
});

test('首次启动（没有配置文件）不算损坏，不提示', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await store.get();
  assert.equal(store.takeLoadWarning(), null);
});

// 审计修复 #52（E25）：损坏归档 rename 失败时旧实现仍回默认值，下一次保存整份覆盖损坏原文件。
// 现在：失败要记进提示 + 写盘前再试；仍失败就拒绝写入，损坏文件一个字节都不动。

test('E25/#52：损坏配置归档失败 → 写前再试，仍失败拒绝写盘（损坏原文件不被覆盖）', async () => {
  const dir = await mkTmp();
  const file = path.join(dir, 'config.json');
  const corrupt = '{ 这不是合法 JSON ';
  await fs.writeFile(file, corrupt, 'utf8');
  let renameCalls = 0;
  const rename = async () => {
    renameCalls += 1;
    throw Object.assign(new Error('EPERM: 文件被占用（模拟）'), { code: 'EPERM' });
  };
  const store = createConfigStore(dir, { rename });
  assert.equal((await store.get()).booksRoot, DEFAULTS.booksRoot, '不阻断启动（回默认值）');
  const warning = store.takeLoadWarning();
  assert.equal(warning.code, 'CONFIG_CORRUPT');
  assert.equal(warning.archiveError, 'EPERM', '提示要如实说明归档失败的原因');
  assert.match(warning.message, /EPERM/);
  assert.equal(warning.message.includes(dir), false, '提示不带完整路径');
  assert.equal(await fs.readFile(file, 'utf8'), corrupt, '归档失败时损坏文件仍在原处');

  // 自动写（窗口位置 / 最近书）也必须被拒绝：不能拿默认值把损坏原文件盖掉
  let autoErr = null;
  await assert.rejects(
    () => store.set({ dailyGoal: 100 }, { auto: true }),
    (err) => {
      autoErr = err;
      return err.code === 'CONFIG_CORRUPT';
    }
  );
  assert.equal(autoErr.errorCode, 'EPERM');
  assert.match(autoErr.message, /没有写入任何设置/);
  // 显式保存同样拒绝
  await assert.rejects(
    () => store.set({ dailyGoal: 100 }),
    (err) => err.code === 'CONFIG_CORRUPT' && err.errorCode === 'EPERM'
  );
  assert.equal(await fs.readFile(file, 'utf8'), corrupt, '两次写尝试之后损坏文件一个字节都没变');
  assert.ok(renameCalls >= 3, '每次写前都要再试一次归档');
});

test('E25/#52：磁盘恢复后写前重试归档成功，损坏文件被归档、设置正常落盘', async () => {
  const dir = await mkTmp();
  const file = path.join(dir, 'config.json');
  const corrupt = '{ 坏配置 ';
  await fs.writeFile(file, corrupt, 'utf8');
  let blocked = true;
  const rename = async (from, to) => {
    if (blocked) throw Object.assign(new Error('EBUSY: 被占用（模拟）'), { code: 'EBUSY' });
    await fs.rename(from, to);
  };
  const store = createConfigStore(dir, { rename });
  await store.get();
  assert.equal(store.takeLoadWarning().archiveError, 'EBUSY');
  blocked = false;
  await store.set({ dailyGoal: 1234 });
  const files = await fs.readdir(dir);
  const archived = files.find((name) => name.startsWith('config.json.corrupt-'));
  assert.ok(archived, '重试成功后损坏文件被改名归档');
  assert.equal(await fs.readFile(path.join(dir, archived), 'utf8'), corrupt, '归档的是原损坏内容');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).dailyGoal, 1234, '新配置正常落盘');
  assert.equal((await createConfigStore(dir).get()).dailyGoal, 1234, '重启后读得到');
});

test('E25/#52：写前重试成功时，还没取走的损坏提示自动更正为「已归档」', async () => {
  const dir = await mkTmp();
  const file = path.join(dir, 'config.json');
  await fs.writeFile(file, '{ 坏配置 ', 'utf8');
  let blocked = true;
  const rename = async (from, to) => {
    if (blocked) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    await fs.rename(from, to);
  };
  const store = createConfigStore(dir, { rename });
  await store.get();
  // 先不取提示：写前重试归档成功，提示不能继续吓唬用户「归档失败」
  blocked = false;
  await store.set({ dailyGoal: 300 });
  const warning = store.takeLoadWarning();
  assert.equal(warning.code, 'CONFIG_CORRUPT');
  assert.equal(warning.archiveError, undefined);
  assert.match(warning.message, /已归档为 config\.json\.corrupt-/);
});

// T-17（三次审查）：E25 的 healed 判定内部会再 load() 一次。那次 load 如果又撞上坏 JSON（外部
// 修好 → 又变坏的三重竞态）且归档仍失败，旧实现在 ensureCorruptArchived 里无条件清 archiveFailure
// → gateWrite 以为「已归档」，拿默认值把仍损坏的 config.json 覆盖掉。这里用计数版 readFile 精确
// 复现「第 1 次坏 / 第 2 次好（healed 探测）/ 第 3 次又坏（复查 load）」。
test('T-17：healed 复查又遇坏 JSON → 仍拒绝写入，损坏文件不被覆盖', async () => {
  const dir = await mkTmp();
  const file = path.join(dir, 'config.json');
  const corrupt = '{ 坏配置 ';
  await fs.writeFile(file, corrupt, 'utf8');
  let reads = 0;
  const readFile = async () => {
    reads += 1;
    if (reads === 2) return JSON.stringify({ dailyGoal: 77 });
    return corrupt;
  };
  const rename = async () => {
    throw Object.assign(new Error('EPERM: 文件被占用（模拟）'), { code: 'EPERM' });
  };
  const store = createConfigStore(dir, { readFile, rename });
  await store.get();
  assert.equal(store.takeLoadWarning().archiveError, 'EPERM');
  await assert.rejects(
    () => store.set({ dailyGoal: 1234 }),
    (err) => err && err.code === 'CONFIG_CORRUPT' && err.errorCode === 'EPERM'
  );
  assert.equal(reads, 3, '前置：healed 探测读到好文件、复查 load 又读到坏文件');
  assert.equal(await fs.readFile(file, 'utf8'), corrupt, '仍损坏的原文件一个字节都不能被默认值覆盖');
});

// 审计残留修复 R28（#52/E25）：主进程启动时以前直接 takeLoadWarning 取走提示，store 里那份
// 「写前重试成功 → 自动更正」的提示再没人读 —— 界面拿到的是启动那一刻的旧文案（归档失败已过期）。
// 现在主进程用 peekLoadWarning 只记日志、提示留在 store 里，由 app:warning 取当前值。

test('R28/#52：peekLoadWarning 不清提示，重试更正后的文案能被消费方取到', async () => {
  const dir = await mkTmp();
  await fs.writeFile(path.join(dir, 'config.json'), '{ 坏配置 ', 'utf8');
  let blocked = true;
  const rename = async (from, to) => {
    if (blocked) throw Object.assign(new Error('EBUSY: 被占用（模拟）'), { code: 'EBUSY' });
    await fs.rename(from, to);
  };
  const store = createConfigStore(dir, { rename });
  await store.get();
  // peek 只读不清：主进程启动时用它记日志，提示仍留给界面取（以前在这里 take，后面就取不到了）
  assert.equal(store.peekLoadWarning().archiveError, 'EBUSY');
  assert.equal(store.peekLoadWarning().archiveError, 'EBUSY', 'peek 连读两次都还在（没有被消费）');
  // 写前重试归档成功 → store 里的提示自动更正成「已归档」；界面随后取到的是更正后的值
  blocked = false;
  await store.set({ dailyGoal: 456 });
  const latest = store.takeLoadWarning();
  assert.equal(latest.code, 'CONFIG_CORRUPT');
  assert.equal(latest.archiveError, undefined, '界面不该再看到过期的「无法归档」');
  assert.match(latest.message, /已归档为 config\.json\.corrupt-/);
  assert.equal(store.peekLoadWarning(), null, '取走之后 peek 也看不到了');
});

// 审计残留修复 #52（E25）：损坏文件被外部删除 → 归档重试遇 ENOENT 必须视为「文件已不在」放行。
// 旧实现把 ENOENT 也当归档失败，本会话此后每次保存都被拒绝（CONFIG_CORRUPT），只能重启应用。

test('残留 E25/#52：损坏文件被外部删除 → 归档重试遇 ENOENT 放行，设置正常落盘', async () => {
  const dir = await mkTmp();
  const file = path.join(dir, 'config.json');
  await fs.writeFile(file, '{ 坏配置 ', 'utf8');
  let renameCalls = 0;
  const rename = async () => {
    renameCalls += 1;
    throw Object.assign(new Error('EPERM: 被占用（模拟）'), { code: 'EPERM' });
  };
  const store = createConfigStore(dir, { rename });
  await store.get();
  assert.equal(renameCalls, 1, '基线：load 时归档失败一次');
  assert.equal(store.takeLoadWarning().archiveError, 'EPERM');

  // 作者在会话中途把损坏文件删了（或挪到别处）
  await fs.unlink(file);
  await store.set({ dailyGoal: 321 });
  assert.equal(renameCalls, 1, '文件都不在了，不该再尝试 rename');
  const disk = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(disk.dailyGoal, 321, 'ENOENT 不再拒绝写入');
  assert.equal(
    (await fs.readdir(dir)).some((name) => name.startsWith('config.json.corrupt-')),
    false,
    '没有可归档的文件，不该凭空多一个 .corrupt-*'
  );
  // 自动写（窗口位置 / 最近书）同样恢复正常 —— 旧实现连这些也写不进去
  await store.set({ editorPaper: 'night' }, { auto: true });
  const after = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(after.editorPaper, 'night');
  assert.equal(after.dailyGoal, 321);
});

// 审计残留修复 #52（E25）：会话中途损坏文件被外部修好 → 不能把健康配置改名成 .corrupt-*，
// 而且写盘要按这份真配置合并（旧实现拿内存里的默认值覆盖，等于丢掉作者刚修好的设置）。

test('残留 E25/#52：损坏文件被外部修好 → 不误归档，写盘按修好的真配置合并', async () => {
  const dir = await mkTmp();
  const file = path.join(dir, 'config.json');
  await fs.writeFile(file, '{ 坏配置 ', 'utf8');
  let blocked = true;
  let renameCalls = 0;
  const rename = async (from, to) => {
    renameCalls += 1;
    if (blocked) throw Object.assign(new Error('EBUSY: 被占用（模拟）'), { code: 'EBUSY' });
    await fs.rename(from, to);
  };
  const store = createConfigStore(dir, { rename });
  await store.get();
  assert.equal(renameCalls, 1, '基线：load 时归档失败一次');

  const repaired = { booksRoot: 'D:\\作者刚修好的书架', dailyGoal: 55 };
  await fs.writeFile(file, JSON.stringify(repaired, null, 2), 'utf8');
  blocked = false;

  await store.set({ editorFontSize: 22 });
  assert.equal(renameCalls, 1, '健康文件不许再尝试归档');
  assert.equal(
    (await fs.readdir(dir)).some((name) => name.startsWith('config.json.corrupt-')),
    false,
    '不许把修好的配置改名成 .corrupt-*'
  );
  const disk = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(disk.booksRoot, repaired.booksRoot, '写盘按真配置合并，不是默认值覆盖');
  assert.equal(disk.dailyGoal, 55);
  assert.equal(disk.editorFontSize, 22);
  // 读盘成功会清掉「归档失败」标记与那次损坏提示（旧实现让界面一直显示过期文案）
  assert.equal(store.takeLoadWarning(), null, '健康配置读进来后过期提示作废');
  await store.set({ dailyGoal: 66 }, { auto: true });
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).dailyGoal, 66);
});

test('配置并发写入：两个 set 的 patch 都不会被吞掉', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await Promise.all([
    store.set({ editorPaper: 'night' }),
    store.set({ editorFontSize: 22 })
  ]);
  const cfg = await store.get();
  assert.equal(cfg.editorPaper, 'night');
  assert.equal(cfg.editorFontSize, 22);
});

// CONFIG-01（2026-11-24 复核补审）：并发首次 get() 共享同一趟 load —— 坏配置只读一次、只归档一次。
// 旧实现两个窗口各读一遍、各归档一次：同秒归档名相同，第二个 rename 失败，界面误报「无法归档」。
test('CONFIG-01：并发 get() 只读一次盘、只归档一次，不误报归档失败', async () => {
  const dir = await mkTmp();
  await fs.writeFile(path.join(dir, 'config.json'), '{ 坏配置 ', 'utf8');
  let reads = 0;
  let renames = 0;
  const readFile = async () => {
    reads += 1;
    await new Promise((resolve) => setTimeout(resolve, 20)); // 让两个 get() 都进到读盘里
    return '{ 坏配置 ';
  };
  const rename = async (from, to) => {
    renames += 1;
    await fs.rename(from, to);
  };
  const store = createConfigStore(dir, { readFile, rename });
  const [first, second] = await Promise.all([store.get(), store.get()]);
  assert.equal(reads, 1, '并发首次 get() 只读一次盘');
  assert.equal(renames, 1, '同一份坏配置只归档一次');
  assert.equal(first.booksRoot, DEFAULTS.booksRoot);
  assert.equal(second.booksRoot, DEFAULTS.booksRoot);
  const warning = store.peekLoadWarning();
  assert.equal(warning.code, 'CONFIG_CORRUPT');
  assert.equal(warning.archiveError, undefined, '不误报「无法归档」');
  const files = await fs.readdir(dir);
  assert.equal(files.filter((name) => name.startsWith('config.json.corrupt-')).length, 1, '只多一份归档');
});
