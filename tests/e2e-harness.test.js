// E2E 工具与组拆分（v0.9 B-7，测试可维护性）：
// scripts/e2e-scenario.js 原来是「一个函数 1.2 万行」，第 60–62 组先搬出去（086153f），
// 第 52 组日志与错误 / 第 53 组正文搜索索引 / 第 54 组检查更新 / 第 55 组多窗口 / 第 56 组安全开关 / 第 57 组路径审计 / 第 58 组配置来源校验 / 第 59 组导入导出边界
// 随后搬（2026-11-02），公共工具（check / waitFor / 删书重试 / 读日志 / 文件存在）
// 收在 scripts/e2e/harness.js。这里锁四件事：
//   1. harness 的每个工具行为与拆分前一致（等待 / 重试 / 读日志 / 抛错文案 / 文件存在）；
//   2. 组索引能单独 require（不依赖 Electron），组号唯一有序、按参数顺序派发；
//   3. 静态闸门：场景里不许再长出第二份 harness 工具、搬走的断言不许留副本、执行顺序不变；
//   4. 组文件只 require node 内建，不 require 产品代码（拆组不许牵出新的耦合）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHarness } = require('../scripts/e2e/harness');

const ROOT = path.join(__dirname, '..');
const SCENARIO_SOURCE = fs.readFileSync(path.join(ROOT, 'scripts', 'e2e-scenario.js'), 'utf8');
const HARNESS_SOURCE = fs.readFileSync(path.join(ROOT, 'scripts', 'e2e', 'harness.js'), 'utf8');
const GROUPS_DIR = path.join(ROOT, 'scripts', 'e2e', 'groups');
const INDEX_SOURCE = fs.readFileSync(path.join(GROUPS_DIR, 'index.js'), 'utf8');

// 最小 ctx：只给 harness 真正用到的三个能力，sleep 立即返回（测试不真的等）。
function makeHarness(overrides = {}) {
  const sleeps = [];
  const harness = createHarness({
    exec: async () => true,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    userData: os.tmpdir(),
    ...overrides
  });
  return { harness, sleeps };
}

const tmpCleanup = require('./tmp-cleanup');

async function tempDir(prefix) {
  return tmpCleanup.track(await fsp.mkdtemp(path.join(os.tmpdir(), prefix)));
}

test('harness.check：通过时只记一条，失败时抛错并带上现场（名称 / detail）', () => {
  const { harness } = makeHarness();
  harness.check('通过项', true);
  assert.deepEqual(harness.checks, [{ name: '通过项', ok: true }]);

  assert.throws(
    () => harness.check('失败项', 0, { where: 'shelf' }),
    (err) => err instanceof Error && /检查失败：失败项 :: \{"where":"shelf"\}/.test(err.message)
  );
  // 失败也要留档（排查时能看到卡在哪一条），ok 为 false
  assert.deepEqual(harness.checks[1], { name: '失败项', ok: false });

  // detail 不传时不该出现多余的 ` :: ` 尾巴
  assert.throws(() => harness.check('无现场', false), /^Error: 检查失败：无现场$/);
});

test('harness.waitFor：逐次重试直到真值；超时抛错并附 activeElement / hasFocus 现场', async () => {
  const seen = [];
  const { harness } = makeHarness({
    exec: async (expr) => {
      seen.push(expr);
      return expr === 'ready()' ? seen.length >= 3 && 'ok' : null;
    }
  });
  assert.equal(await harness.waitFor('ready()'), 'ok');
  assert.equal(seen.filter((expr) => expr === 'ready()').length, 3);

  const diag = '{"activeId":"btn-format","hasFocus":false}';
  const timeoutHarness = makeHarness({
    exec: async (expr) => (expr.startsWith('JSON.stringify') ? diag : ''),
    sleep: async () => {}
  }).harness;
  await assert.rejects(
    () => timeoutHarness.waitFor('never()', 0),
    (err) => err instanceof Error && err.message.startsWith('等待超时：never()') && err.message.includes(diag)
  );
});

test('harness.setWindowSize：setSize 被窗口系统吞掉时重试到渲染层 innerWidth 落定；吞到底 / 窗口销毁返回 false', async () => {
  // 渲染层内宽落后于 setSize：前两拍还是旧宽度，第三拍才真的 resize（2026-11-04 组 42 偶发）
  let calls = 0;
  let moves = 0;
  let applied = false;
  const lagWin = {
    isDestroyed: () => false,
    moveTop() { moves += 1; },
    setSize() { calls += 1; if (calls >= 3) applied = true; },
    getSize: () => (applied ? [1660, 960] : [1200, 800])
  };
  const lagHarness = makeHarness({ win: lagWin, exec: async () => (applied ? 1647 : 1187) }).harness;
  assert.equal(await lagHarness.setWindowSize(1660, 960, { minInner: 1600 }), true);
  assert.ok(calls >= 3, '前两拍没落定时要继续重试');
  assert.ok(moves >= 1, '每次重试都要先抬 z 序（窗口被遮挡时 Chromium 会暂停渲染，resize 不进渲染层）');

  // 一直吞掉：超时返回 false（断言仍按测量值判，等待本身不放宽语义），但确实试过 setSize
  let stubbornCalls = 0;
  const stubbornWin = { isDestroyed: () => false, moveTop() {}, setSize() { stubbornCalls += 1; }, getSize: () => [1200, 800] };
  const stubbornHarness = makeHarness({ win: stubbornWin, exec: async () => 1187 }).harness;
  assert.equal(await stubbornHarness.setWindowSize(960, 700, { maxInner: 979, timeout: 0 }), false);
  assert.ok(stubbornCalls >= 1);

  // 不传区间时按外层尺寸（win.getSize）判定
  let sizeCalls = 0;
  let size = [1200, 800];
  const sizeWin = {
    isDestroyed: () => false,
    moveTop() {},
    setSize(w, h) { sizeCalls += 1; if (sizeCalls >= 2) size = [w, h]; },
    getSize: () => size.slice()
  };
  const sizeHarness = makeHarness({ win: sizeWin, exec: async () => 0 }).harness;
  assert.equal(await sizeHarness.setWindowSize(1294, 766), true);
  assert.deepEqual(size, [1294, 766]);

  // 窗口已经销毁：立即返回 false，不再摸 setSize
  const deadWin = { isDestroyed: () => true, setSize() { throw new Error('不该调'); }, getSize: () => [0, 0] };
  const deadHarness = makeHarness({ win: deadWin, exec: async () => 0 }).harness;
  assert.equal(await deadHarness.setWindowSize(960, 700), false);
});

test('harness.readLogs：只认日志文件名，按名字排序拼接；目录不存在时返回空而不报错', async () => {
  const userData = await tempDir('cw-harness-logs-');
  const logDir = path.join(userData, 'logs');
  await fsp.mkdir(logDir, { recursive: true });
  await fsp.writeFile(path.join(logDir, 'chapter-writer-2026-10-31.log'), 'OLD\n', 'utf8');
  await fsp.writeFile(path.join(logDir, 'chapter-writer-2026-11-01.123.log'), 'NEW\n', 'utf8');
  await fsp.writeFile(path.join(logDir, 'chapter-writer-2026-11-01.log.bak'), 'BAK\n', 'utf8');
  await fsp.writeFile(path.join(logDir, 'other.log'), 'OTHER\n', 'utf8');

  const { harness } = makeHarness({ userData });
  assert.equal(harness.logDir, logDir);
  const first = await harness.readLogs();
  assert.deepEqual(first.names.sort(), [
    'chapter-writer-2026-10-31.log',
    'chapter-writer-2026-11-01.123.log',
    'chapter-writer-2026-11-01.log.bak',
    'other.log'
  ]);
  // 只拼接匹配命名的两份，且按名字排序（10-31 在前）
  assert.equal(first.text, 'OLD\nNEW\n');

  const empty = makeHarness({ userData: path.join(userData, 'nope') }).harness;
  assert.deepEqual(await empty.readLogs(), { names: [], text: '' });
});

test('harness.waitForLog：等到日志里出现关键字就返回全文，等不到抛「等待日志超时」', async () => {
  const userData = await tempDir('cw-harness-waitlog-');
  const logDir = path.join(userData, 'logs');
  await fsp.mkdir(logDir, { recursive: true });
  const file = path.join(logDir, 'chapter-writer-2026-11-01.log');
  await fsp.writeFile(file, 'INFO app-start\n', 'utf8');

  // 第一次读还没有 → sleep 期间补上（模拟日志异步落盘）；sleep 是注入的，测试不用真等
  let appended = false;
  const { harness } = makeHarness({
    userData,
    sleep: async () => {
      if (appended) return;
      appended = true;
      await fsp.appendFile(file, 'WARN save-failed\n', 'utf8');
    }
  });
  const text = await harness.waitForLog('save-failed', 1000);
  assert.ok(text.includes('save-failed'));

  await assert.rejects(
    () => makeHarness({ userData }).harness.waitForLog('不存在的行', 0),
    /等待日志超时：不存在的行/
  );
});

test('harness.deleteBookWithRetry：失败按 200ms 重试，成功即返回；一直失败返回最后一次结果', async () => {
  const attempts = [];
  const { harness, sleeps } = makeHarness({
    exec: async (expr) => {
      attempts.push(expr);
      return attempts.length >= 2 ? JSON.stringify({ ok: true, data: { method: 'move' } }) : JSON.stringify({ ok: false });
    }
  });
  const ok = await harness.deleteBookWithRetry('D:/tmp/书A');
  assert.equal(ok.ok, true);
  assert.equal(attempts.length, 2);
  assert.deepEqual(sleeps, [200]);
  assert.match(attempts[0], /window\.api\.deleteBook\("D:\/tmp\/书A"\)/);

  const failing = makeHarness({ exec: async () => JSON.stringify({ ok: false, error: 'EPERM' }) });
  const last = await failing.harness.deleteBookWithRetry('D:/tmp/书B', 3);
  assert.deepEqual(last, { ok: false, error: 'EPERM' });
  assert.equal(failing.sleeps.length, 3);
});

test('harness.fileExists：文件 / 目录都算存在，不存在（含父目录不存在）返回 false，不抛错', async () => {
  const dir = await tempDir('cw-harness-exists-');
  const file = path.join(dir, '书目.json');
  await fsp.writeFile(file, '{}', 'utf8');
  const { harness } = makeHarness();
  assert.equal(await harness.fileExists(file), true);
  assert.equal(await harness.fileExists(dir), true);
  assert.equal(await harness.fileExists(path.join(dir, '没有这个.txt')), false);
  assert.equal(await harness.fileExists(path.join(dir, 'nope', 'deep', 'x.txt')), false);
});

test('静态闸门：场景里不许再定义第二份 harness 工具，必须走 createHarness + 组索引', () => {
  for (const name of ['checks', 'check', 'waitFor', 'readLogs', 'waitForLog', 'deleteBookWithRetry', 'fileExists']) {
    const pattern = new RegExp(`^  const ${name} = `, 'm');
    assert.equal(pattern.test(SCENARIO_SOURCE), false, `${name} 不该再定义在 e2e-scenario.js 里`);
  }
  assert.match(SCENARIO_SOURCE, /const harness = createHarness\(ctx\);/);
  assert.match(
    SCENARIO_SOURCE,
    /const \{ checks, check, waitFor, logDir, logNamePattern, readLogs, waitForLog, deleteBookWithRetry, fileExists \} =\s*\n\s*harness;/
  );
  assert.match(SCENARIO_SOURCE, /const e2eGroups = require\('\.\/e2e\/groups'\);/);
  // 组按「在哪一段」两处跑：第 52 / 53 / 54 / 55 / 56 / 57 / 58 / 59 组在原位，60 起的那批在原 60–62 的循环位置
  assert.match(SCENARIO_SOURCE, /await e2eGroups\.runGroups\(groupContext\(\), \[52\]\);/);
  assert.match(SCENARIO_SOURCE, /await e2eGroups\.runGroups\(groupContext\(\), \[53\]\);/);
  assert.match(SCENARIO_SOURCE, /await e2eGroups\.runGroups\(groupContext\(\), \[54\]\);/);
  assert.match(SCENARIO_SOURCE, /await e2eGroups\.runGroups\(groupContext\(\), \[55\]\);/);
  assert.match(SCENARIO_SOURCE, /await e2eGroups\.runGroups\(groupContext\(\), \[56\]\);/);
  assert.match(SCENARIO_SOURCE, /await e2eGroups\.runGroups\(groupContext\(\), \[57\]\);/);
  assert.match(SCENARIO_SOURCE, /await e2eGroups\.runGroups\(groupContext\(\), \[58\]\);/);
  assert.match(SCENARIO_SOURCE, /await e2eGroups\.runGroups\(groupContext\(\), \[59\]\);/);
  assert.match(SCENARIO_SOURCE, /await e2eGroups\.runGroups\(groupContext\(\), e2eGroups\.idsFrom\(60\)\);/);
  // 顺序：52 → 53 → 54 → 56 → 57 → 58 → 59 → … → 60 起那批 → 多窗口（55）——与拆分前的执行顺序一致
  const groupContext = SCENARIO_SOURCE.indexOf('const groupContext = () => ({');
  const run52 = SCENARIO_SOURCE.indexOf('await e2eGroups.runGroups(groupContext(), [52]);');
  const group53 = SCENARIO_SOURCE.indexOf('// 53. 正文全文搜索索引');
  const run53 = SCENARIO_SOURCE.indexOf('await e2eGroups.runGroups(groupContext(), [53]);');
  const group54 = SCENARIO_SOURCE.indexOf('// 54. 检查更新');
  const run54 = SCENARIO_SOURCE.indexOf('await e2eGroups.runGroups(groupContext(), [54]);');
  const group56 = SCENARIO_SOURCE.indexOf('// 56. Electron 安全开关与窗口行为');
  const run56 = SCENARIO_SOURCE.indexOf('await e2eGroups.runGroups(groupContext(), [56]);');
  const group57 = SCENARIO_SOURCE.indexOf('// 57. IPC 路径入口审计');
  const run57 = SCENARIO_SOURCE.indexOf('await e2eGroups.runGroups(groupContext(), [57]);');
  const group58 = SCENARIO_SOURCE.indexOf('// 58. 配置来源校验');
  const run58 = SCENARIO_SOURCE.indexOf('await e2eGroups.runGroups(groupContext(), [58]);');
  const group59 = SCENARIO_SOURCE.indexOf('// 59. 导入 / 导出边界');
  const run59 = SCENARIO_SOURCE.indexOf('await e2eGroups.runGroups(groupContext(), [59]);');
  const run60 = SCENARIO_SOURCE.indexOf('await e2eGroups.runGroups(groupContext(), e2eGroups.idsFrom(60));');
  const multiWindow = SCENARIO_SOURCE.indexOf('// 55. 多窗口');
  const run55 = SCENARIO_SOURCE.indexOf('await e2eGroups.runGroups(groupContext(), [55]);');
  assert.ok(groupContext > 0 && groupContext < run52, 'groupContext 要先定义再交出去');
  assert.ok(run52 > 0 && group53 > run52, '52 组的调用点必须在 53 组之前（顺序不变）');
  assert.ok(run53 > group53 && group54 > run53, '53 组要在 54 组之前跑（顺序不变）');
  assert.ok(run54 > group54 && group56 > run54, '54 组要在 56 组之前跑（顺序不变）');
  assert.ok(run56 > group56 && group57 > run56, '56 组要在 57 组之前跑（顺序不变）');
  assert.ok(run57 > group57 && run58 > run57, '57 组要在 58 组之前跑（顺序不变）');
  assert.ok(run58 > group58 && run59 > run58, '58 组要在 59 组之前跑（顺序不变）');
  assert.ok(run59 > group59 && run60 > run59, '59 组要在 60 起那批之前跑（顺序不变）');
  assert.ok(run60 > group53 && multiWindow > run60, '60 起那批要在 55 多窗口之前跑完');
  assert.ok(multiWindow > 0 && run55 > multiWindow, '55 多窗口组的调用点要在它自己的段注释之后');
  assert.ok(run55 > run60, '55 多窗口仍在 60 起那批之后跑（拆分不改变执行顺序）');
});

test('静态闸门：搬走的组不许在场景里留副本（文案只在 groups 下出现一次）', () => {
  const movedBeyond = [
    '// 52. 崩溃与错误日志（提案 7.4）',
    '// 53. 正文全文搜索索引（提案 7.3）：书架搜索升级成能搜正文。',
    '// 54. 检查更新（提案 7.1）：手动检查 GitHub Release',
    '// 56. Electron 安全开关与窗口行为（v0.9 C-1）：',
    '// 57. IPC 路径入口审计（v0.9 C-2）：',
    '// 58. 配置来源校验（v0.9 C-2b，安全审计 C1 的延伸）：',
    '// 59. 导入 / 导出边界（v0.9 C-3，安全审计 C6）：',
    '// 55. 多窗口（提案 7.2，作者 2026-11-01 03:45 拍板）：',
    '// 60. 日志与错误脱敏',
    '// 61. IPC 参数边界与 DoS',
    '// 62. 公共小工具收编'
  ];
  for (const marker of movedBeyond) {
    assert.equal(SCENARIO_SOURCE.includes(marker), false, `场景里还留着 ${marker}`);
  }
  const groupFiles = fs.readdirSync(GROUPS_DIR).filter((name) => name.endsWith('.js') && name !== 'index.js');
  assert.ok(groupFiles.length >= 20, '至少应有 52–55 / 56–59 / 60–71 二十个组文件');
  const joined = groupFiles.map((name) => fs.readFileSync(path.join(GROUPS_DIR, name), 'utf8')).join('\n');
  for (const marker of movedBeyond) {
    assert.equal(joined.includes(marker), true, `groups 下找不到 ${marker}`);
  }
  // 断言名（check 的字符串）同样只该留在组文件里，场景里出现就说明留了副本
  for (const needle of [
    '诊断日志：日志目录是 userData\\\\logs，文件按天命名（chapter-writer-YYYY-MM-DD.log）',
    '诊断日志：保存失败记一条（错误码 + 章节文件路径 + 频道），绝不含正文',
    '错误脱敏：演练书已移入书架 _trash',
    'IPC 边界：演练书已移入书架 _trash',
    '公共小工具：渲染层真的加载了 core/common.js',
    '正文搜索：索引里只有哈希位图和文件指纹，不存正文（正文句子不在索引文件里）',
    '正文搜索：搜索过程只读（config.json / 书目.json / 章节 txt 一个字节都没变）',
    '正文搜索：结果分页显示（先 8 条，「显示更多」展开剩下的）',
    '检查更新：发现新版本时显示「新版本 + 当前版本」，并出现「打开下载页」',
    '检查更新：配置不新增任何更新字段（检查只存在内存里，不需要作者配置）',
    '标题统一：打开书 / 切章只改书目的 lastOpenChapterId——书目录文件列表与四章 txt 逐字节不变',
    '安全开关：真实窗口的 webPreferences 与 core/security-policy 逐项一致',
    "安全开关：CSP 再收紧（object-src / base-uri / frame-src 一律 'none'）",
    '安全开关：再启动一个实例会立刻退出（单实例锁生效，没有真的再开一个窗口）',
    '路径审计：读章节不能带 .. 跳到书外（BAD_PATH）',
    '路径审计：替换备份目录名只能是带前缀的基名（BAD_BACKUP）',
    '路径审计：被拒的调用没有改书目 / 章节文件（逐字节一致）',
    '配置来源：伪造的书架目录没有被创建（主进程没往那儿 mkdir / 写文件）',
    '配置来源：别的窗口没选过 → A 窗口选过的路径在 B 窗口不生效（按窗口记账）',
    '配置来源：演练结束后敏感词表与每日目标恢复原样（没有改动前面的测试状态）',
    '导入导出边界：EPUB zip 条目名全是白名单形状，不含书名 / 卷名 / 章名与路径片段',
    '导入导出边界：DOCX zip 条目名只有固定七部位（不含书名 / 章名）',
    '导入边界：被拒的文件没有建书、没有留下临时导入目录（正常书建了且只有一本）',
    '多窗口：开始时只有一个窗口（前面 646 项仍是单窗口语义）',
    '多窗口：书卡右键菜单有「在新窗口打开」',
    '多窗口：被拒绝的删改没有动书 / 章 / 书目 / 回收目录',
    '多窗口：最后一个窗口关闭后应用才退出（window-all-closed）'
  ]) {
    assert.equal(SCENARIO_SOURCE.includes(needle), false, `场景里还留着断言「${needle}」`);
    assert.equal(joined.includes(needle), true, `组文件里找不到断言「${needle}」`);
  }
});

test('静态闸门：组索引能单独 require（不依赖 Electron），组号唯一有序，runGroups 按参数顺序跑', async () => {
  const registry = require('../scripts/e2e/groups');
  assert.ok(Array.isArray(registry.groups) && registry.groups.length >= 20);
  for (const group of registry.groups) {
    assert.equal(typeof group.id, 'number');
    assert.equal(typeof group.run, 'function');
  }
  const ids = registry.groups.map((group) => group.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), '组号必须升序（数组顺序 = 执行顺序）');
  assert.equal(new Set(ids).size, ids.length, '同一个组不许注册两次');

  const required = [...INDEX_SOURCE.matchAll(/require\('\.\/([\w.-]+)'\)/g)].map((m) => m[1]);
  assert.equal(required.length, ids.length, '索引里的 require 条数必须等于注册的组数');
  assert.equal(new Set(required).size, required.length, '同一个组不许注册两次');
  for (const name of required) {
    assert.ok(fs.existsSync(path.join(GROUPS_DIR, `${name}.js`)), `组文件不存在：${name}.js`);
  }
  // 执行顺序 = 注册顺序 = 原场景里的顺序。2026-11-04 窗口开始把第 0–51 组也搬进本目录：
  // **尾部这 21 组（52–72）是已经拆好的老组，逐项必须保持不变**；0–51 只允许插在它们前面，
  // 组号从 0 起、升序、唯一，文件名统一 `NN-名字.js`（NN = 两位组号）。
  const TAIL_FILES = [
    '52-crash-logs',
    '53-search-index',
    '54-check-update',
    '55-multiwindow',
    '56-security-switches',
    '57-ipc-paths',
    '58-config-gate',
    '59-import-export',
    '60-log-redaction',
    '61-ipc-limits',
    '62-common-tools',
    '63-chapter-list-perf',
    '64-data-safety',
    '65-marks-lazy-spans',
    '66-destructive-recovery',
    '67-contrast-a11y',
    '68-dialog-focus',
    '69-motion',
    '70-a11y-keyboard',
    '71-menu-keyboard',
    '72-capture'
  ];
  const TAIL_IDS = [52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72];
  assert.deepEqual(required.slice(-TAIL_FILES.length), TAIL_FILES, '尾部 21 组（52–72）的组文件与顺序不许变');
  assert.deepEqual(ids.slice(-TAIL_IDS.length), TAIL_IDS, '尾部 21 组（52–72）的组号与顺序不许变');
  const headFiles = required.slice(0, -TAIL_FILES.length);
  const headIds = ids.slice(0, -TAIL_IDS.length);
  assert.equal(headFiles.length, headIds.length, '0–51 的组号与组文件必须一一对应');
  assert.deepEqual(headIds, [...headIds].sort((a, b) => a - b), '0–51 也要按组号升序');
  for (let i = 0; i < headIds.length; i += 1) {
    assert.ok(headIds[i] >= 0 && headIds[i] <= 51, `新拆的组号只允许 0–51（实际 ${headIds[i]}）`);
    assert.match(
      headFiles[i],
      new RegExp(`^${String(headIds[i]).padStart(2, '0')}-`),
      `第 ${headIds[i]} 组的文件名要以 ${String(headIds[i]).padStart(2, '0')}- 开头`
    );
  }
  // 场景尾部那一批：idsFrom(n) = 组号 ≥ n 的所有组（按注册顺序）。语义对所有 n 都成立，不写死切片。
  for (const n of [0, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 71, 72, 73]) {
    assert.deepEqual(registry.idsFrom(n), ids.filter((id) => id >= n), `idsFrom(${n}) 语义不对`);
  }

  // runGroups：空列表直接过；组号写错要当场抛（写错一个号就等于少跑一整组的断言）
  await registry.runGroups({}, []);
  await assert.rejects(() => registry.runGroups({}, [999]), /组索引里没有第 999 组/);
  // 按参数顺序派发（临时塞两个假组，跑完就摘掉，别污染别的用例）
  const ran = [];
  registry.groups.push({ id: 9998, run: async () => ran.push(9998) });
  registry.groups.push({ id: 9999, run: async () => ran.push(9999) });
  try {
    await registry.runGroups({}, [9999, 9998]);
  } finally {
    registry.groups.splice(-2, 2);
  }
  assert.deepEqual(ran, [9999, 9998]);
});

test('静态闸门：harness 与组文件只 require node 内建，不牵出产品代码 / electron', () => {
  const sources = [['scripts/e2e/harness.js', HARNESS_SOURCE]];
  for (const name of fs.readdirSync(GROUPS_DIR).filter((file) => file.endsWith('.js') && file !== 'index.js')) {
    sources.push([`scripts/e2e/groups/${name}`, fs.readFileSync(path.join(GROUPS_DIR, name), 'utf8')]);
  }
  for (const [label, source] of sources) {
    const requests = [...source.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
    for (const request of requests) {
      assert.match(request, /^node:/, `${label} 不该 require ${request}（只许 node 内建）`);
    }
    assert.equal(/require\('electron'\)|\.\.\/main|\.\.\/core\//.test(source), false, `${label} 牵出了产品代码`);
  }
  // harness 对外只交一个工厂 + 明确的工具名，别长成第二个大杂烩
  assert.match(HARNESS_SOURCE, /module\.exports = \{ createHarness \};/);
});
