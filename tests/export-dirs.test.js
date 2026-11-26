// F1（三审 4.1）：导出中断留下的孤儿临时文件回收 —— 「最近导出过的目录」清单。
// 产品侧修复在 main.js（启动时逐个目录扫 + 导出成功顺手扫上一个目录），这里钉纯逻辑与清单文件：
//   · mergeRecentDirs：最新在前、按 pathKey 去重、有界 10 个、坏条目丢掉；
//   · dirsToClean：启动该扫哪些目录（lastExportDir 优先 + 最近列表，去重、有界）；
//   · readRecentDirs / writeRecentDirs：清单文件读写（坏文件 / 不存在一律空列表，绝不阻断启动）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const exportDirs = require('../core/export-dirs');
const pathUtils = require('../core/path-utils');
const tmpCleanup = require('./tmp-cleanup');

const mkTmp = (prefix = 'cw-export-dirs-') => tmpCleanup.mkTmp(prefix);
const abs = (...parts) => path.resolve(path.sep, 'cw-export', ...parts);

test('F1：mergeRecentDirs 最新在前、按 pathKey 去重、有界 10 个', () => {
  const a = abs('A');
  const b = abs('B');
  let list = [];
  list = exportDirs.mergeRecentDirs(list, a);
  list = exportDirs.mergeRecentDirs(list, b);
  assert.deepEqual(list, [b, a], '最新导出在最前');
  // 再次导出到 A：提到最前、不重复
  list = exportDirs.mergeRecentDirs(list, a);
  assert.deepEqual(list, [a, b]);
  // 同一个目录换个写法（大小写 / 正反斜杠 / 末尾分隔符）算同一个：走全仓唯一的 pathKey
  const variant = abs('A').toUpperCase() + path.sep;
  list = exportDirs.mergeRecentDirs(list, variant);
  assert.equal(list.length, 2, '大小写 / 末尾分隔符不同的同一个目录不许重复出现');
  assert.equal(pathUtils.pathKey(list[0]), pathUtils.pathKey(a));
  // 有界：超过上限只留最新 10 个
  for (let i = 0; i < 15; i += 1) list = exportDirs.mergeRecentDirs(list, abs(`D${i}`));
  assert.equal(list.length, exportDirs.MAX_RECENT_DIRS);
  assert.equal(exportDirs.MAX_RECENT_DIRS, 10);
  assert.deepEqual(
    list.map((item) => path.basename(item)),
    ['D14', 'D13', 'D12', 'D11', 'D10', 'D9', 'D8', 'D7', 'D6', 'D5']
  );
  // 坏条目一律丢掉：非字符串 / 空白 / 相对路径 / 超长
  const dirty = exportDirs.mergeRecentDirs([null, 42, '', '  ', 'relative/dir', abs('X'), 'C:'.repeat(600)], abs('Y'));
  assert.deepEqual(dirty, [abs('Y'), abs('X')]);
  // 坏输入不抛错
  assert.deepEqual(exportDirs.mergeRecentDirs(null, null), []);
  assert.deepEqual(exportDirs.mergeRecentDirs(undefined, ''), []);
});

test('F1：dirsToClean = 当前 lastExportDir + 最近列表（去重、有界）', () => {
  const current = abs('当前');
  const older = abs('旧一');
  const older2 = abs('旧二');
  assert.deepEqual(
    exportDirs.dirsToClean({ recent: [older, older2], lastExportDir: current }),
    [current, older, older2],
    '当前 lastExportDir 排最前（一定存在过），其后是最近导出目录'
  );
  // 列表里已经有当前目录：不重复
  assert.deepEqual(
    exportDirs.dirsToClean({ recent: [older, current], lastExportDir: current }),
    [current, older]
  );
  // 空值 / 坏形状：只回能用的
  assert.deepEqual(exportDirs.dirsToClean({ recent: [], lastExportDir: '' }), []);
  assert.deepEqual(exportDirs.dirsToClean({}), []);
  assert.deepEqual(exportDirs.dirsToClean(), []);
  assert.deepEqual(exportDirs.dirsToClean({ recent: null, lastExportDir: current }), [current]);
  // 有界：最多 MAX_RECENT_DIRS + 1 个
  const many = Array.from({ length: 20 }, (_, index) => abs(`M${index}`));
  assert.equal(exportDirs.dirsToClean({ recent: many, lastExportDir: abs('顶') }).length, exportDirs.MAX_RECENT_DIRS + 1);
});

test('F1：清单文件读写往返；坏文件 / 不存在一律空列表（不阻断启动）', async () => {
  const base = await mkTmp();
  const file = path.join(base, 'export-dirs.json');
  assert.deepEqual(await exportDirs.readRecentDirs(file), [], '文件不存在 = 空列表');
  assert.equal(await exportDirs.writeRecentDirs(file, [abs('A'), 'relative', abs('B'), abs('A')]), true);
  assert.deepEqual(await exportDirs.readRecentDirs(file), [abs('A'), abs('B')], '坏条目与重复项不落盘');
  // 落盘形状：{ version, dirs }（以后加字段不破坏读取）
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.deepEqual(raw.dirs, [abs('A'), abs('B')]);
  // 手写成裸数组也认（宽容读取）
  await fs.writeFile(file, JSON.stringify([abs('C')]), 'utf8');
  assert.deepEqual(await exportDirs.readRecentDirs(file), [abs('C')]);
  // 坏 JSON / 坏形状：空列表，绝不抛错
  await fs.writeFile(file, '{ not json', 'utf8');
  assert.deepEqual(await exportDirs.readRecentDirs(file), []);
  await fs.writeFile(file, JSON.stringify({ dirs: 'nope' }), 'utf8');
  assert.deepEqual(await exportDirs.readRecentDirs(file), []);
  // 空路径：读 []、写 false（不抛错）
  assert.deepEqual(await exportDirs.readRecentDirs(''), []);
  assert.equal(await exportDirs.writeRecentDirs('', [abs('A')]), false);
  await fs.rm(base, { recursive: true, force: true });
});

test('F1：cleanDir 只收绝对路径 + 长度上限', () => {
  assert.equal(exportDirs.cleanDir('  ' + abs('A') + '  '), abs('A'));
  assert.equal(exportDirs.cleanDir('relative'), '');
  assert.equal(exportDirs.cleanDir(''), '');
  assert.equal(exportDirs.cleanDir(null), '');
  assert.equal(exportDirs.cleanDir(123), '');
  assert.equal(exportDirs.cleanDir('C:'.repeat(600)), '', '超长条目当坏条目丢掉');
});

// 产品侧接线（main.js 是主进程原生代码，只能静态钉住「真的接上了」）：
//   启动：读清单 → dirsToClean → **逐个目录**回收孤儿（不再只扫一个 lastExportDir）；
//   导出成功：记进有界清单并落盘 → 顺手回收上一个导出目录。
test('F1：main.js 接线（启动逐个目录回收 + 导出成功记录并回收上一个目录）', () => {
  const MAIN = require('node:fs').readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(MAIN, /require\('\.\/core\/export-dirs'\)/, 'main.js 要引 core/export-dirs');
  assert.match(MAIN, /async function loadRecentExportDirs\(\)/, '启动要读回清单');
  const startupAt = MAIN.indexOf('await loadRecentExportDirs();');
  assert.notEqual(startupAt, -1, '启动流程里要读清单');
  const startup = MAIN.slice(startupAt, startupAt + 900);
  assert.match(startup, /exportDirsLib\.dirsToClean\(\{/, '启动要按 dirsToClean 算该扫哪些目录');
  assert.match(startup, /recent: recentExportDirs/, 'dirsToClean 要带最近导出目录');
  assert.match(startup, /lastExportDir: exportDir/, 'dirsToClean 要带当前 lastExportDir');
  assert.match(
    startup,
    /for \(const dir of exportCleanupDirs\) \{[\s\S]{0,200}?await cleanupOrphanTmpFiles\(dir\)/,
    '要逐个目录回收孤儿（只扫一个目录 = F1 那个缺口没修）'
  );
  // 导出成功后：记进清单 + 落盘 + 回收上一个目录
  const rememberAt = MAIN.indexOf('async function rememberExportDir(');
  assert.notEqual(rememberAt, -1, 'main.js 里仍要有 rememberExportDir');
  const body = MAIN.slice(rememberAt, rememberAt + 1600);
  assert.match(body, /exportDirsLib\.mergeRecentDirs\(recentExportDirs, dir\)/, '导出成功要记进最近目录列表');
  assert.match(body, /exportDirsLib\.writeRecentDirs\(exportDirsFilePath\(\)/, '清单要落盘（失败只忽略）');
  assert.match(body, /await cleanupOrphanTmpFiles\(previous\)/, '导出成功顺手回收上一个目录的孤儿');
  assert.match(body, /await cleanupOrphanTmpFiles\(dir\)/, '本次目录里上次中断的孤儿也要回收');
});

// MAIN-01（中）：启动链里的导出目录回收是「尽力而为」—— 桌面盘 / 网络盘 / 睡眠的移动硬盘断开时
// readdir 会挂几十秒。以前整段串行 await、没有截止时间，createWindow 迟迟不执行（作者看到的是
// 双击图标后几十秒没窗口）。这里钉住：回收整段有 ≤3 秒的总截止时间（到点照常建窗），
// 没扫到的目录下次启动再收。
test('MAIN-01：启动回收导出目录整段有 ≤3 秒截止时间，不会把建窗拖住', () => {
  const MAIN = require('node:fs').readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const declared = /const EXPORT_SWEEP_DEADLINE_MS = (\d+);/.exec(MAIN);
  assert.ok(declared, '导出目录回收要有自己的总截止时间常量（MAIN-01：无截止时间 = 建窗被网络盘拖住）');
  const budgetMs = Number(declared[1]);
  assert.ok(Number.isFinite(budgetMs) && budgetMs > 0 && budgetMs <= 3000, `截止时间必须 >0 且 ≤3 秒（现在 ${budgetMs}ms）`);

  const loopAt = MAIN.indexOf('for (const dir of exportCleanupDirs)');
  assert.notEqual(loopAt, -1, '启动回收循环仍在（F1 的覆盖面不许丢）');
  const around = MAIN.slice(Math.max(0, loopAt - 800), loopAt + 600);
  assert.match(around, /closeGuard\.withDeadline\(/, '回收整段必须包在 withDeadline 里（MAIN-01）');
  assert.match(around, /EXPORT_SWEEP_DEADLINE_MS/, '截止时间要用 EXPORT_SWEEP_DEADLINE_MS');

  // 有界等待仍排在建窗之前：到点就继续建窗（不是取消回收，也不是把窗口排到回收后面无限等）。
  const createAt = MAIN.indexOf('createWindow({ runAutomationFlow: true })');
  assert.ok(createAt > 0 && loopAt < createAt, '有界回收仍在建窗之前，到点照常建窗');
});

// V221-EXPORT-01（中）：导出 / 救稿成功后都 await rememberExportDir，其中两次孤儿回收是
// 「尽力而为」的 readdir —— 上一个导出目录在断开的网络盘 / 拔掉的移动硬盘上时会挂几十秒
//（Windows SMB 超时），作者看到的是「正在导出…」永远不结束。两次回收必须包在同一段有截止
// 时间的等待里（与启动回收同口径），到点先返回导出结果，没扫到的目录下次导出 / 启动再收。
test('V221-EXPORT-01：rememberExportDir 的两次孤儿回收有总截止时间，断盘压不住导出回执', () => {
  const MAIN = require('node:fs').readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const rememberAt = MAIN.indexOf('async function rememberExportDir(');
  assert.notEqual(rememberAt, -1, 'main.js 里仍要有 rememberExportDir');
  const body = MAIN.slice(rememberAt, rememberAt + 2600);
  const deadlineAt = body.indexOf('closeGuard.withDeadline(');
  const firstClean = body.indexOf('await cleanupOrphanTmpFiles(dir)');
  const secondClean = body.indexOf('await cleanupOrphanTmpFiles(previous)');
  assert.ok(deadlineAt > 0, '两次孤儿回收要包在 closeGuard.withDeadline 里（V221-EXPORT-01）');
  assert.ok(firstClean > deadlineAt, '本次目录的回收要在截止时间覆盖段内');
  assert.ok(secondClean > firstClean, '上一个导出目录的回收也在同一段里（顺序不敏感，但都要有界）');
  assert.match(
    body.slice(deadlineAt, deadlineAt + 600),
    /EXPORT_SWEEP_DEADLINE_MS/,
    '截止时间复用启动回收的常量（同一口径，别各写一个数）'
  );
});
