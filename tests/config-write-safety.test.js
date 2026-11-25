// 配置层测试（T9 / 第 9 轮按域拆分）：写盘失败、读失败与版本安全。
//
// 来源：原 tests/config.test.js（2,000 行 / 69 例）按域拆成四个文件，**只搬家不改断言**——
// 用例标题与断言逐字保留，共用夹具收进 tests/config-fixtures.js（T9 纪律，见 tests/README.md）。
// 本文件覆盖：5 条写通道的失败语义 / 读失败不静默当首次启动 / 配置白名单 /
// 多份校对词表清洗与 V51 / C7 自动写拦截与显式保存重试读 / V110 版本透传与 CSTO-B-01 /
// 以及两条 main.js 接线静态闸门。
const test = require('node:test');
const assert = require('node:assert/strict');
const { path, fs, createConfigStore, sanitize, DEFAULTS, writeJsonAtomic, readGlossaryFile, readGlossaryFiles, MAIN_SOURCE, mkTmp } = require('./config-fixtures');

// A1（审计 E1 / P0-1）：5 条写通道统一「先构造 next → 写盘成功 → 再 cache = next」。
// 写盘失败时内存 cache 必须保持旧值、错误必须抛给调用方、磁盘上仍是旧版本；
// 失败还不能堵死写队列（同一 store 的后续写要照常成功）。

test('配置写盘失败：cache 保持旧值、错误抛出、磁盘不变（5 条写通道）', async () => {
  const dir = await mkTmp();
  const file = path.join(dir, 'config.json');
  let failNext = false;
  const attempted = [];
  const write = async (target, data) => {
    attempted.push({ target, data: JSON.parse(JSON.stringify(data)) });
    if (failNext) {
      failNext = false;
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    }
    await writeJsonAtomic(target, data);
  };
  const store = createConfigStore(dir, { write });
  const readDisk = async () => JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(attempted.length, 0, 'get() 不该写盘');

  // —— 1) set ——
  await store.set({ booksRoot: 'D:\\正常书架' });
  assert.equal(attempted.length, 1);
  assert.equal(attempted[0].data.booksRoot, 'D:\\正常书架', '写盘拿到的是「下一次」的值，不是旧 cache');
  failNext = true;
  await assert.rejects(() => store.set({ booksRoot: 'D:\\坏书架', editorFont: 'kai' }), /EPERM/);
  assert.equal(attempted[1].data.booksRoot, 'D:\\坏书架', '失败时写盘尝试里仍是构造好的 next');
  const cfg = await store.get();
  assert.equal(cfg.booksRoot, 'D:\\正常书架', '写盘失败后 get() 仍是旧值');
  assert.equal(cfg.editorFont, 'serif', '同一 patch 的其它字段也不该在内存生效');
  assert.equal((await readDisk()).booksRoot, 'D:\\正常书架', '磁盘上仍是上一版');

  // —— 2) setBookDisplay ——
  await store.setBookDisplay('b_disp', { editorFont: 'kai', editorFontSize: 22 });
  assert.equal((await store.getBookDisplay('b_disp')).editorFont, 'kai');
  failNext = true;
  await assert.rejects(() => store.setBookDisplay('b_disp', { editorFont: 'custom', editorCustomFontPath: 'C:\\字体.ttf' }), /EPERM/);
  const stillDisplay = await store.getBookDisplay('b_disp');
  assert.equal(stillDisplay.editorFont, 'kai', '按书字体写失败后仍是旧值');
  assert.equal(stillDisplay.editorCustomFontPath, undefined, '写失败不清掉旧字段');
  assert.equal((await readDisk()).bookDisplay.b_disp.editorFont, 'kai');

  // —— 3) resetBookDisplay ——
  failNext = true;
  await assert.rejects(() => store.resetBookDisplay('b_disp'), /EPERM/);
  assert.equal((await store.getBookDisplay('b_disp')).editorFont, 'kai', '重置写失败 = 覆盖仍生效');
  assert.equal((await readDisk()).bookDisplay.b_disp.editorFont, 'kai');
  // 3b) 成功后覆盖才真正删掉
  assert.equal(await store.resetBookDisplay('b_disp'), true);
  assert.deepEqual(await store.getBookDisplay('b_disp'), {});
  assert.equal((await readDisk()).bookDisplay.b_disp, undefined);

  // —— 4) upsertFindBookmark ——
  failNext = true;
  await assert.rejects(
    () => store.upsertFindBookmark({ bookId: 'b1', chapterId: 'ch_001', query: '阿明' }),
    /EPERM/
  );
  assert.deepEqual(await store.listFindBookmarks(), [], '书签写失败后列表仍是空的');
  assert.deepEqual((await readDisk()).findBookmarks, []);
  const added = await store.upsertFindBookmark({ bookId: 'b1', chapterId: 'ch_001', query: '阿明' });
  assert.equal(added.list.length, 1);

  // —— 5) removeFindBookmark ——
  failNext = true;
  await assert.rejects(() => store.removeFindBookmark('b1', 'ch_001'), /EPERM/);
  assert.equal((await store.listFindBookmarks()).length, 1, '删除写失败后书签还在');
  assert.equal((await readDisk()).findBookmarks.length, 1);
  const removed = await store.removeFindBookmark('b1', 'ch_001');
  assert.equal(removed.list.length, 0);

  // —— 失败没堵死写队列：下一次写照常落盘 ——
  await store.set({ dailyGoal: 1500 });
  assert.equal((await store.get()).dailyGoal, 1500);
  assert.equal((await readDisk()).dailyGoal, 1500);
  assert.deepEqual((await createConfigStore(dir).get()).findBookmarks, [], '重启后读到的是最后一次成功写盘的内容');
});

// A5（审计 E2）：只有 ENOENT 才当「首次启动」。EACCES / EIO / EBUSY 这类读失败以前也被静默
// 吞掉（书架悄悄回默认目录、下一次保存把读不到的配置整个覆盖），现在：回默认值不阻断启动，
// 但留一条一次性提示 + 错误码，并且不改动磁盘上的原配置（不归档、不覆盖）。

test('配置读失败：非 ENOENT 不再静默当首次启动（回默认值 + 一次性提示 + 不动磁盘）', async () => {
  for (const code of ['EACCES', 'EIO', 'EBUSY']) {
    const dir = await mkTmp();
    const file = path.join(dir, 'config.json');
    await fs.writeFile(file, JSON.stringify({ booksRoot: 'D:\\已有书架', dailyGoal: 700 }, null, 2), 'utf8');
    const readFile = async () => {
      throw Object.assign(new Error(`${code}: 读配置文件失败（模拟）`), { code });
    };
    const store = createConfigStore(dir, { readFile });
    const cfg = await store.get();
    assert.equal(cfg.booksRoot, DEFAULTS.booksRoot, `${code}：不阻断启动（回默认值）`);
    assert.equal(cfg.dailyGoal, DEFAULTS.dailyGoal);
    const warning = store.takeLoadWarning();
    assert.ok(warning, `${code}：必须留一条提示，不能静默`);
    assert.equal(warning.code, 'CONFIG_READ_FAILED');
    assert.equal(warning.errorCode, code, '提示要带真实错误码');
    assert.ok(warning.message.includes(code), '提示正文里也要有错误码');
    assert.equal(warning.message.includes(dir), false, '提示里不带完整路径');
    assert.equal(store.takeLoadWarning(), null, '提示只给一次');
    // 读失败不等于损坏：不归档、不改名、不覆盖磁盘上的那份配置
    assert.deepEqual(await fs.readdir(dir), ['config.json'], `${code}：读失败不归档`);
    assert.equal((await createConfigStore(dir).get()).booksRoot, 'D:\\已有书架', '换正常读盘还读得到原值');
    assert.equal((await createConfigStore(dir).get()).dailyGoal, 700);
  }
});

// S4（审计 S4 / 终审版）：config:set 字段白名单 + 每字段类型 / 长度上限。
// 以前 sanitize 用 `{...DEFAULTS, ...raw}` 起手，未知键原样保留——一个手改 / 注入的配置可以把
// 任意大对象写进 config.json 并整份回给渲染层。现在只认 DEFAULTS 里登记过的键。

test('配置白名单（S4）：未知键丢弃、只留已知键、旧配置缺新键照常开', async () => {
  const dir = await mkTmp();
  // 旧 config：没有 clipboardWatchEnabled（批 D 才加的键），还混着未知键 / 超大对象
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({
      booksRoot: 'D:\\旧书架',
      dailyGoal: 800,
      未知键: { huge: 'x'.repeat(1000) },
      evil: 'x'.repeat(5000)
    }),
    'utf8'
  );
  const store = createConfigStore(dir);
  const cfg = await store.get();
  assert.equal(cfg.booksRoot, 'D:\\旧书架', '旧配置照常打开');
  assert.equal(cfg.clipboardWatchEnabled, false, '旧配置缺新键 = 默认关');
  assert.equal('未知键' in cfg, false, '加载时未知键要丢弃');
  assert.equal('evil' in cfg, false);
  // 2026-11-25：bookGroups 是「有分组才写」的可选键 —— 空清单在 sanitize 里被去掉，
  // 所以旧配置 / 没建过分组的配置回给界面时不含这个键（其余已知键一个不少）。
  assert.deepEqual(
    Object.keys(cfg).sort(),
    Object.keys(DEFAULTS).filter((key) => key !== 'bookGroups').sort(),
    '回给界面的配置只含已知键（空 bookGroups 不落盘也不回传）'
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(DEFAULTS, 'clipboardWatchEnabled'),
    'D 批要用的开关必须登记在 DEFAULTS（否则会被白名单丢掉）'
  );

  // config:set 塞未知键：丢弃、不影响同一份 patch 里的正常字段，也不写进磁盘
  const updated = await store.set({ evil: 'x', dailyGoal: 900 });
  assert.equal('evil' in updated, false);
  assert.equal(updated.dailyGoal, 900);
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal('evil' in raw, false);

  // 新键真实生效 / 坏类型按「关」
  await store.set({ clipboardWatchEnabled: true });
  assert.equal((await createConfigStore(dir).get()).clipboardWatchEnabled, true);
  await store.set({ clipboardWatchEnabled: 'true' });
  assert.equal((await store.get()).clipboardWatchEnabled, false, '只认真正的 true');

  // 逐字段长度上限：坏值当「没设置」
  const capped = sanitize({
    booksRoot: 'D:\\' + 'x'.repeat(1200),
    editorCustomFontPath: 'C:\\' + 'f'.repeat(1200),
    editorCustomFontName: 'n'.repeat(300),
    bookDisplay: {
      b1: {
        editorCustomFontPath: 'C:\\' + 'g'.repeat(1200),
        editorCustomFontName: 'm'.repeat(300)
      }
    }
  });
  assert.equal(capped.booksRoot, DEFAULTS.booksRoot, '超长书架路径回落默认');
  assert.equal(capped.editorCustomFontPath, '');
  assert.equal(capped.editorCustomFontName, '');
  assert.equal(capped.bookDisplay.b1.editorCustomFontPath, '', '按书字体路径同样限长');
  assert.equal(capped.bookDisplay.b1.editorCustomFontName, '');
});

// 1.7.0 F3a：多份校对词表（proofreadWordlists）——配置层三条锚点。

test('多份校对词表配置：旧配置没有该字段 = 空数组，单份路径沿用旧字段', async () => {
  const dir = await mkTmp();
  assert.deepEqual((await createConfigStore(dir).get()).proofreadWordlists, [], '默认空数组');
  // 模拟旧配置：只有单份 proofreadWordsPath，完全没有 proofreadWordlists
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ proofreadWordsPath: 'D:\\词表\\旧单份.txt', dailyGoal: 1200 }, null, 2),
    'utf8'
  );
  const cfg = await createConfigStore(dir).get();
  assert.deepEqual(cfg.proofreadWordlists, [], '旧配置读出来是空数组');
  assert.equal(cfg.proofreadWordsPath, 'D:\\词表\\旧单份.txt', '单份字段原样沿用，零迁移');
  assert.equal(cfg.dailyGoal, 1200, '其它字段不受影响');
  // 旧配置上只改别的字段：两份词表都保持原样
  const store = createConfigStore(dir);
  await store.set({ dailyGoal: 1300 });
  const reopened = await createConfigStore(dir).get();
  assert.deepEqual(reopened.proofreadWordlists, []);
  assert.equal(reopened.proofreadWordsPath, 'D:\\词表\\旧单份.txt');
});

test('多份校对词表清洗：非数组 / 超 8 条 / 相对路径 / 重复都丢弃，不存在路径保留（V51），写盘同样清洗', async () => {
  const dir = await mkTmp();
  const files = [];
  for (let i = 1; i <= 10; i += 1) {
    const p = path.join(dir, '词表' + i + '.txt');
    await fs.writeFile(p, '错词\n', 'utf8');
    files.push(p);
  }
  // 非数组一律当空（不是把单份路径塞进数组）
  assert.deepEqual(sanitize({ proofreadWordlists: 'D:\\x.txt' }).proofreadWordlists, []);
  assert.deepEqual(sanitize({ proofreadWordlists: null }).proofreadWordlists, []);
  assert.deepEqual(sanitize({ proofreadWordlists: 42 }).proofreadWordlists, []);
  assert.deepEqual(sanitize({ proofreadWordlists: { 0: 'D:\\x.txt' } }).proofreadWordlists, []);
  // 超 8 条：留前 8 条，顺序不变
  assert.deepEqual(sanitize({ proofreadWordlists: files }).proofreadWordlists, files.slice(0, 8));
  // 相对路径 / 非字符串 / 空串：逐条丢掉，其它照留；不存在的绝对路径保留（V51：清洗不判存在性，
  // 读不到由读取侧的 GLOSSARY_MISSING 报给用户）
  const missing = path.join(dir, '没有这个文件.txt');
  const dirty = [files[0], '词表相对.txt', missing, 123, '', '   ', null, files[1]];
  assert.deepEqual(sanitize({ proofreadWordlists: dirty }).proofreadWordlists, [files[0], missing, files[1]]);
  // 重复：Windows 下大小写与正反斜杠归一后算同一份
  const dup = [files[0], files[0], files[0].toUpperCase(), files[0].replace(/\\/g, '/')];
  assert.deepEqual(sanitize({ proofreadWordlists: dup }).proofreadWordlists, [files[0]]);
  // 保存路径同样清洗（set 走同一个 sanitize）
  const store = createConfigStore(dir);
  await store.set({ proofreadWordlists: dirty });
  assert.deepEqual((await createConfigStore(dir).get()).proofreadWordlists, [files[0], missing, files[1]]);
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(raw.proofreadWordlists, [files[0], missing, files[1]], '落盘的就是清洗后的三条');
  // 空数组 = 清空，落盘为空数组
  await store.set({ proofreadWordlists: [] });
  assert.deepEqual((await createConfigStore(dir).get()).proofreadWordlists, []);
});

test('多份校对词表清洗：合法数组保留顺序与写法，8 条正好不算超限', async () => {
  const dir = await mkTmp();
  const files = [];
  for (let i = 1; i <= 8; i += 1) {
    const p = path.join(dir, '顺序' + i + '.txt');
    await fs.writeFile(p, '占位\n', 'utf8');
    files.push(p);
  }
  const shuffled = [files[2], files[0], files[7], files[1], files[6], files[3], files[5], files[4]];
  assert.deepEqual(sanitize({ proofreadWordlists: shuffled }).proofreadWordlists, shuffled, '顺序原样保留');
  const store = createConfigStore(dir);
  await store.set({ proofreadWordlists: shuffled });
  assert.deepEqual((await createConfigStore(dir).get()).proofreadWordlists, shuffled, '写盘读回顺序不变');
});

// 1.7.1 P2 / V51：配置清洗只看形状，不再按「文件现在能不能 stat 到」静默删词表。
// U 盘 / 网络盘 / 权限抖动 / 文件临时被占用时，删掉的是作者的设置而不是坏数据；读不到应由读取侧
// 的 GLOSSARY_MISSING 报给用户（最后一条锚点）。V48：写入路径不再带同步 stat，断开的 UNC 不卡主进程。

test('写入 [存在, 不存在] 两条词表 → 两条都保留（V51）', async () => {
  const dir = await mkTmp();
  const existing = path.join(dir, '存在.txt');
  const missing = path.join(dir, '不存在.txt');
  await fs.writeFile(existing, '错词\n', 'utf8');
  assert.equal(
    await fs.stat(missing).then(() => true, () => false),
    false,
    '前置：这条路径确实不存在'
  );
  const store = createConfigStore(dir);
  const saved = await store.set({ proofreadWordlists: [existing, missing] });
  assert.deepEqual(saved.proofreadWordlists, [existing, missing], '写入返回里两条都在');
  assert.deepEqual((await store.get()).proofreadWordlists, [existing, missing], '内存 cache 里两条都在');
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(raw.proofreadWordlists, [existing, missing], '落盘的就是两条');
});

test('改无关字段后不存在的词表仍在（V51）', async () => {
  const dir = await mkTmp();
  const existing = path.join(dir, '存在.txt');
  const missing = path.join(dir, '不存在.txt');
  await fs.writeFile(existing, '错词\n', 'utf8');
  const store = createConfigStore(dir);
  await store.set({ proofreadWordlists: [existing, missing] });
  // 设置页每次保存都会整份回传配置（改主题 / 拖分隔条 / 存别的字段），以前每次都会重跑清洗、
  // 把不存在的那条当成坏数据扔掉；现在无关字段的写入不能顺手删掉词表。
  const after = await store.set({ dailyGoal: 1500, editorPaper: 'night' });
  assert.deepEqual(after.proofreadWordlists, [existing, missing], '改无关字段不能顺手删词表');
  await store.set({ dailyGoal: 1600 });
  assert.deepEqual((await store.get()).proofreadWordlists, [existing, missing], '多次无关写入后仍在');
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(raw.proofreadWordlists, [existing, missing], '落盘的两条都还在');
});

test('新 store load() 后仍在（V51）', async () => {
  const dir = await mkTmp();
  const existing = path.join(dir, '存在.txt');
  const missing = path.join(dir, '不存在.txt');
  await fs.writeFile(existing, '错词\n', 'utf8');
  const store = createConfigStore(dir);
  await store.set({ proofreadWordlists: [existing, missing] });
  // 重启 = 新实例 + load()；这里重跑的是同一个 sanitize，不能把上次存下的路径删掉。
  const reopened = createConfigStore(dir);
  await reopened.load();
  assert.deepEqual((await reopened.get()).proofreadWordlists, [existing, missing], '重启后不存在的词表仍在');
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(raw.proofreadWordlists, [existing, missing], '磁盘上的两条也没被改写');
});

test('不存在路径读取时报 GLOSSARY_MISSING 文案（V51/V48）', async () => {
  const dir = await mkTmp();
  const missing = path.join(dir, '不存在.txt');
  assert.equal(
    await fs.stat(missing).then(() => true, () => false),
    false,
    '前置：这条路径确实不存在'
  );
  // 读取侧对「配置里有、文件读不到」的路径必须给出可辨认的码：GLOSSARY_MISSING
  // （core/glossary.js:201；不是静默当「没配置」GLOSSARY_NOT_CONFIGURED）。
  const one = await readGlossaryFile(missing);
  assert.equal(one.ok, false);
  assert.equal(one.configured, true);
  assert.equal(one.code, 'GLOSSARY_MISSING');
  assert.match(one.message, /词表文件不存在/, '单份读取的文案要说明文件不存在');
  // 多份词表把码翻成界面文案（core/glossary.js 的 glossaryErrorText，GLOSSARY_MISSING 分支，
  // 约 :246）：带路径的长文案留在主进程，界面只拿这一句。
  const bundle = await readGlossaryFiles([missing]);
  assert.equal(bundle.ok, false);
  assert.equal(bundle.lists.length, 1);
  assert.equal(bundle.lists[0].ok, false);
  assert.equal(bundle.lists[0].error, '词表文件不存在（可能被移动或删除了，请重新选择）');
  // 全链路：配置层保留的不存在路径，读取时仍能报 MISSING，而不是在写入时被删到「未配置」。
  const store = createConfigStore(dir);
  await store.set({ proofreadWordlists: [missing] });
  const cfg = await store.get();
  assert.deepEqual(cfg.proofreadWordlists, [missing], '配置层不删不存在的路径（V51）');
  const chain = await readGlossaryFile(cfg.proofreadWordlists[0]);
  assert.equal(chain.code, 'GLOSSARY_MISSING', '配置保留 → 读取报 MISSING 的链路可达');
});

// C7（审计 C7）：配置读失败（EACCES / EIO / EBUSY）后，自动写（窗口位置 / 最近书 / 最近导出目录）
// 一律不许落盘——否则磁盘恢复可写时，第一次 resize 的防抖写就把「读不到的真配置」整份换成默认值，
// booksRoot 直接丢。自动写期间也不许重试读：解锁只走「显式保存先重试读」这一条路（见下一条）。

test('配置读失败：自动写一律被拦住、不落盘、也不假写内存（C7）', async () => {
  const dir = await mkTmp();
  const file = path.join(dir, 'config.json');
  const realConfig = { booksRoot: 'D:\\真书架', dailyGoal: 700, editorFont: 'kai' };
  await fs.writeFile(file, JSON.stringify(realConfig, null, 2), 'utf8');
  const before = await fs.readFile(file, 'utf8');

  let failing = true;
  const readFile = async (target, encoding) => {
    if (failing) throw Object.assign(new Error('EACCES: 读配置失败（模拟）'), { code: 'EACCES' });
    return fs.readFile(target, encoding);
  };
  const writes = [];
  const store = createConfigStore(dir, {
    readFile,
    write: async (target, data) => {
      writes.push(JSON.parse(JSON.stringify(data)));
      await writeJsonAtomic(target, data);
    }
  });

  const cfg = await store.get();
  assert.equal(cfg.booksRoot, DEFAULTS.booksRoot, '读失败先回默认值（不阻断启动）');
  assert.equal(store.takeLoadWarning().code, 'CONFIG_READ_FAILED');

  // 三种真实自动写通道：窗口位置（resize/move 防抖 + 关窗前那次）、最近书、最近导出目录
  const autoPatches = [
    { windowBounds: { x: 1, y: 2, width: 1200, height: 760, maximized: false } },
    { lastBook: { path: 'D:\\真书架\\书A', chapterId: 'c1', at: Date.now() } },
    { lastExportDir: 'D:\\导出' }
  ];
  for (const patch of autoPatches) {
    await assert.rejects(
      () => store.set(patch, { auto: true }),
      (err) => err && err.code === 'CONFIG_READ_FAILED',
      `自动写 ${Object.keys(patch)[0]} 必须被拦住`
    );
  }
  assert.equal(writes.length, 0, '自动写一次都不许碰写盘');
  assert.equal(await fs.readFile(file, 'utf8'), before, '磁盘上的真配置一个字节没变');
  assert.equal((await store.get()).booksRoot, DEFAULTS.booksRoot, '内存里仍是默认值（不假装写成功）');
  assert.equal((await store.get()).dailyGoal, DEFAULTS.dailyGoal);

  // 磁盘恢复也不代表自动写能自己解锁：没人点保存时不许偷偷把默认值覆盖上去
  failing = false;
  await assert.rejects(
    () => store.set({ lastExportDir: 'D:\\导出二' }, { auto: true }),
    (err) => err && err.code === 'CONFIG_READ_FAILED'
  );
  assert.equal(writes.length, 0, '自动写不重试读，只等显式保存来解锁');
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

// C7：显式保存（用户在设置里点保存 / 改按书显示 / 存书签）在读失败期间必须先重试读；
// 读不到就明确失败、读到了就按真配置合并——默认值绝不覆盖真配置（审计里最担心的 booksRoot 丢失）。

test('配置读失败恢复后：显式保存先重试读，真配置不被默认值覆盖（C7）', async () => {
  const dir = await mkTmp();
  const file = path.join(dir, 'config.json');
  await fs.writeFile(file, JSON.stringify({ booksRoot: 'D:\\真书架', dailyGoal: 700 }), 'utf8');

  let failing = true;
  const readFile = async (target, encoding) => {
    if (failing) throw Object.assign(new Error('EACCES: 读配置失败（模拟）'), { code: 'EACCES' });
    return fs.readFile(target, encoding);
  };
  const store = createConfigStore(dir, { readFile });
  await store.get();
  assert.equal((await store.get()).booksRoot, DEFAULTS.booksRoot, '前置：启动时读到的是默认值');

  // 仍读不到：显式保存明确失败（不能假装成功，也不能把默认值写进去）
  await assert.rejects(
    () => store.set({ editorFont: 'kai' }),
    (err) => err && err.code === 'CONFIG_READ_FAILED' && err.errorCode === 'EACCES'
  );
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).booksRoot, 'D:\\真书架', '失败时磁盘不动');
  const stillBad = await store.retryLoad();
  assert.equal(stillBad.ok, false);
  assert.equal(stillBad.recovered, false);
  assert.equal(stillBad.code, 'CONFIG_READ_FAILED');
  assert.ok(stillBad.message.includes('EACCES'), '失败信息带上真实错误码');

  // 其它显式写通道同样先重试读、读不到就失败（按书显示 / 书签）
  await assert.rejects(() => store.setBookDisplay('b1', { editorFont: 'kai' }), /读取失败/);
  await assert.rejects(
    () => store.upsertFindBookmark({ bookId: 'b1', chapterId: 'c1', query: '阿明' }),
    /读取失败/
  );
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).bookDisplay, undefined, '失败时没写按书设置');

  // 磁盘恢复：显式保存先重试读 → 写回的是「真配置 + 这次改动」
  failing = false;
  const recovered = await store.retryLoad();
  assert.equal(recovered.ok, true);
  assert.equal(recovered.recovered, true, 'retryLoad 要告诉调用方「刚才是默认值，现在是真配置」');
  await store.set({ editorFont: 'kai' });
  const disk = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(disk.booksRoot, 'D:\\真书架', '真配置没有被默认值覆盖（C7 的核心）');
  assert.equal(disk.dailyGoal, 700, '读不到时错过的字段一个不少');
  assert.equal(disk.editorFont, 'kai', '这次显式改动正常生效');
  assert.equal(disk.configVersion, 1, '本版本写盘时落自己的 configVersion');
  assert.equal((await store.get()).booksRoot, 'D:\\真书架', '恢复后内存缓存也是真配置');
  assert.equal(store.takeLoadWarning(), null, '恢复后不再留过时的读失败提示');

  // 恢复之后自动写回到正常路径（磁盘读得通、cache 是真配置，不会再覆盖）
  await store.set({ lastExportDir: 'D:\\导出' }, { auto: true });
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).booksRoot, 'D:\\真书架');
});

// V110 / D-7：配置前向兼容。本版写盘一定带 configVersion；读到更高版本时保留版本号 + 未知顶层键
// （限类型 / 深度 / 大小），任何一次普通保存都把未知键原样写回，版本回退不再静默丢设置；
// 同版本 / 没有版本号的未知键仍按 S4 丢弃（防注入的既有口径不松）。

test('configVersion 与高版本未知键透传（V110 / D-7）', async () => {
  const dir = await mkTmp();
  const file = path.join(dir, 'config.json');
  const store = createConfigStore(dir);
  assert.equal((await store.get()).configVersion, 1, '本版默认 configVersion = 1');
  await store.set({ dailyGoal: 900 });
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).configVersion, 1, '新配置写盘一定带 configVersion');

  // 模拟「新版本写过」的配置：版本 2 + 未知顶层键（其中一个超过大小闸门，必须丢掉）
  await fs.writeFile(
    file,
    JSON.stringify({
      configVersion: 2,
      booksRoot: 'D:\\新版本书架',
      dailyGoal: 1200,
      未来功能: { enabled: true, list: [1, '二', null] },
      超限大对象: { blob: 'x'.repeat(50000) }
    }),
    'utf8'
  );
  const upgraded = createConfigStore(dir);
  const cfg = await upgraded.get();
  assert.equal(cfg.configVersion, 2, '更高版本号原样保留（不降级）');
  assert.equal(cfg.booksRoot, 'D:\\新版本书架', '已知键照常清洗 / 生效');
  assert.deepEqual(cfg.未来功能, { enabled: true, list: [1, '二', null] }, '高版本未知键限类型 / 大小后保留');
  assert.equal('超限大对象' in cfg, false, '超过大小闸门的未知键整条丢弃');

  // 本版保存一次：未知键原样写回、版本号不回落（否则新版本会把已迁移的文件再迁移一次）
  await upgraded.set({ dailyGoal: 1300 });
  const disk = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(disk.configVersion, 2);
  assert.deepEqual(disk.未来功能, { enabled: true, list: [1, '二', null] }, '普通保存不许抹掉新版本字段');
  assert.equal(disk.dailyGoal, 1300);
  assert.equal(disk.booksRoot, 'D:\\新版本书架');
  assert.equal('超限大对象' in disk, false);

  // 同版本 / 无版本的未知键仍丢弃（S4 的防注入口径没松）
  const plain = sanitize({ booksRoot: 'D:\\书架', 可疑: { a: 1 }, configVersion: 1 });
  assert.equal('可疑' in plain, false);
  assert.equal(sanitize({ 可疑: 1 }).configVersion, 1, '没有版本号的旧配置 = 本版');
  // 坏版本号一律按本版；数字字符串（手改配置常见）也认
  for (const bad of [null, '', 'x', -3, 1.4, {}, []]) {
    assert.equal(sanitize({ configVersion: bad }).configVersion, 1, `configVersion=${JSON.stringify(bad)} 回落 1`);
  }
  assert.equal(sanitize({ configVersion: '2' }).configVersion, 2, '数字字符串版本号也认');
  // 未知键里的 __proto__ / constructor 这类键不许借透传污染原型链
  const proto = JSON.parse('{"configVersion":2,"__proto__":{"polluted":true},"constructor":{"x":1}}');
  const cleaned = sanitize(proto);
  assert.equal(Object.getPrototypeOf(cleaned), Object.prototype);
  assert.equal(cleaned.polluted, undefined);
  assert.equal(({}).polluted, undefined, '全局原型没被污染');
});

// CSTO-B-01（第五轮审计）：config:set 是不可信通道（渲染层可被注入）。旧实现把 patch 直接并进
// sanitize 的 source，于是 patch 带 configVersion:999999 就能触发 D-7 的「高版本未知键透传」，
// 把本版不认识的键写进 config.json 并永久保留。版本号只允许由读盘归一产生，未知键只认磁盘上
// 已经存在的那份（current）。

test('CSTO-B-01：config:set 不许升版本号，也不许把 patch 里的新未知键写进配置', async () => {
  const dir = await mkTmp();
  const file = path.join(dir, 'config.json');
  const store = createConfigStore(dir);
  await store.set({ dailyGoal: 700, configVersion: 999999, 注入键: { a: 1 } });
  const disk = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(disk.configVersion, 1, '版本号只由读盘归一产生，patch 不许升');
  assert.equal('注入键' in disk, false, 'patch 新带进来的未知键必须丢弃（S4 防注入不松）');
  assert.equal(disk.dailyGoal, 700, '正常字段照常保存');

  // 磁盘上本来就有的高版本未知键仍按 D-7 保留（前向兼容通道不被误伤）
  await fs.writeFile(
    file,
    JSON.stringify({ configVersion: 2, dailyGoal: 800, 未来功能: { on: true } }),
    'utf8'
  );
  const upgraded = createConfigStore(dir);
  const cfg = await upgraded.set({ dailyGoal: 900, 另一个注入键: 1 });
  assert.equal(cfg.configVersion, 2);
  assert.equal('另一个注入键' in cfg, false);
  const disk2 = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(disk2.configVersion, 2);
  assert.deepEqual(disk2.未来功能, { on: true }, '磁盘上已存在的高版本未知键原样保留');
  assert.equal('另一个注入键' in disk2, false);
});

// C7 接线静态闸门：读失败闸门只有靠 main.js 把三条自动写标成 auto 才生效；显式保存必须先重试读
// 再算目标书架目录 / 建目录 / 写盘（顺序错了就会出现「先建一个错目录再报失败」）。

test('C7 / V110 接线静态闸门：自动写带 auto 标记、config:set 先重试读', () => {
  const main = MAIN_SOURCE;
  assert.match(
    main,
    /configStore\.set\(\{ windowBounds:[\s\S]{0,200}?\}, \{ auto: true \}\)/,
    '窗口位置 / 大小是自动写，必须带 { auto: true }'
  );
  assert.match(
    main,
    /configStore\.rememberLastBook\(payload, \{ auto: true, now \}\)/,
    '最近书是自动写，且读旧值 / 比较 / 写盘都要在 configStore 的写队列里完成（C28）'
  );
  assert.match(main, /configStore\.set\(\{ lastExportDir: dir \}, \{ auto: true \}\)/, '最近导出目录是自动写');

  const from = main.indexOf("handle('config:set'");
  const to = main.indexOf("handle('config:test-pick'");
  assert.ok(from > -1 && to > from, '静态闸门要能定位 config:set 的函数体');
  const body = main.slice(from, to);
  const retryAt = body.indexOf('configStore.retryLoad()');
  const mkdirAt = body.indexOf('fs.mkdir(targetRoot');
  const writeAt = body.indexOf('configStore.set(gated.patch, {');
  // TB-01：三处锚点都要显式防 -1（否则 -1 参与比较会给出误导性的「顺序不对」失败信息）。
  assert.ok(retryAt > -1, 'config:set 必须先重试读（C7：保存设置前先重试读）');
  assert.ok(mkdirAt > -1, '找不到建目标目录的调用（fs.mkdir(targetRoot…)）');
  assert.ok(writeAt > -1, '找不到写盘调用（configStore.set(gated.patch, …)）');
  assert.ok(retryAt < mkdirAt && retryAt < writeAt, '重试读必须在建目标目录 / 写盘之前');
  assert.match(body, /if \(!recovery\.ok\)/, '仍读不到要明确失败（不能拿默认值写盘）');
  assert.match(body, /recovery\.recovered/, '读盘恢复后要刷新主进程缓存再继续');
});

// 审计残留修复 R28（#52/E25）：主进程启动时只能 peek（记日志用），提示留给 app:warning 取当前值；
// 启动就 take 走的话，写前重试归档成功后的「已归档」更正永远没人读（旧实现的死代码）。

test('R28 静态闸门：main.js 启动只 peek 提示，app:warning 取 store 当前值', async () => {
  const mainSource = MAIN_SOURCE;
  assert.match(mainSource, /configWarning = configStore\.peekLoadWarning\(\);/);
  assert.doesNotMatch(
    mainSource,
    /configWarning = configStore\.takeLoadWarning\(\)/,
    '启动就 take 会把 store 的自动更正变成没人读的死代码'
  );
  const handlerAt = mainSource.indexOf("handle('app:warning'");
  assert.ok(handlerAt > 0, 'app:warning 处理器还在');
  const handlerEnd = mainSource.indexOf('});', handlerAt);
  // TB-01：终点锚点缺 -1 防护时 slice(handlerAt, -1) 会拿到 handler 之后的全部源码，闸门静默失效。
  assert.ok(handlerEnd > handlerAt, 'app:warning 处理器要有配对的结束括号');
  const handler = mainSource.slice(handlerAt, handlerEnd);
  assert.match(
    handler,
    /const warning = configStore \? configStore\.takeLoadWarning\(\) : configWarning;/,
    'app:warning 取 store 里的当前值（不是启动快照）'
  );
});
