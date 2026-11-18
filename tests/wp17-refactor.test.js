'use strict';
// WP17（渲染层重构，审计 #20）第 21 轮 · D3 锚点（2026-11-18，HEAD ace4969）：
//   R1 合并算法单份：core/glossary.js 只有 mergeListEntries 一份「去重 + 5000 上限」循环，
//      readGlossaryFiles 调 mergeListEntries(lists, null)，不再内联第二份（D3，审计低 #16）
//   R2 行为保真：撞顶跨 3 份时 entries 顺序 / 每份 truncated 语义与改前一致；
//      enabledLists 子集「按实际参与结算」（#49/E24）不回退
//   R3 极值 × IO 失败注入：3 × 6000 条 + 目录 / 不存在文件同批，不抛错、封顶、坏份只标记
//   R4 对外形状：lists 仍带 entries/ownTruncated/truncated；公开信息剥掉正文；total = entries.length
// 第 22 轮追加 A2 锚点（R5–R7，2026-11-18，HEAD 411695f）：
//   R5 renderer/assert-host.js 移入 core/assert-host.js：core 里有一份实现、renderer 侧不留 shim、
//      ipc 不再反向依赖 renderer/（4 个 ipc 都从 ../core/assert-host 取）
//   R6 UMD 双分支与浏览器全局名不变：Node 仍导出 { assertHost }，浏览器仍挂 CWAssertHost，
//      文案 / 返回值逐字不变
//   R7 index.html 的 <script> 仍是 ../core/assert-host.js、只加载一次、仍排在全部 host 消费者之前；
//      装配清单同一条目 / 全局名 / 本地名不变（顺序与条数不改）
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const glossary = require('../core/glossary');
const tmpCleanup = require('./tmp-cleanup');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'core', 'glossary.js'), 'utf8');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// 静态闸门只看代码：注释里回忆「以前怎么写」不算回潮。
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

// renderer 下带 `const REQUIRED_HOST =` 的模块 = assert-host 的全部 host 消费者（名单与
// tests/assert-host.test.js 同一口径：renderer.js 只在注释里提过 REQUIRED_HOST，不算）。
function hostConsumers() {
  return fs
    .readdirSync(path.join(ROOT, 'renderer'))
    .filter((name) => name.endsWith('.js'))
    .filter((name) => read(`renderer/${name}`).includes('const REQUIRED_HOST ='))
    .sort();
}

const IPC_HOST_FILES = ['ipc/book-data.js', 'ipc/book.js', 'ipc/export.js', 'ipc/proofread.js'];

const lineCount = (text) => text.split('\n').length;

// 紧贴在某段代码上方的连续 `//` 注释块（允许中间空一行），用于「注释瘦身但契约仍在」的闸门。
function commentAbove(source, marker) {
  const at = source.indexOf(marker);
  assert.ok(at > 0, `找不到标记：${marker}`);
  const lines = source.slice(0, at).split('\n');
  const block = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (block.length === 0 && lines[i].trim() === '') continue;
    if (lines[i].trimStart().startsWith('//')) block.unshift(lines[i]);
    else break;
  }
  return block.join('\n');
}

function functionBody(name) {
  const start = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(SOURCE);
  assert.ok(start, `core/glossary.js 找不到 function ${name}(`);
  const rest = SOURCE.slice(start.index + start[0].length);
  const next = /\n(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

async function mkTmp() {
  return tmpCleanup.track(await fsp.mkdtemp(path.join(os.tmpdir(), 'cw-wp17-')));
}

function manyLines(prefix, amount) {
  return Array.from({ length: amount }, (_value, index) => prefix + index).join('\n') + '\n';
}

test('R1 D3：多份合并只留 mergeListEntries 一份实现，readGlossaryFiles 复用它', () => {
  const readBody = functionBody('readGlossaryFiles');
  assert.equal(
    count(SOURCE, 'for (const entry of own)'),
    1,
    '「去重 + 封顶」循环只许留在 mergeListEntries（readGlossaryFiles 不许内联第二份）'
  );
  assert.equal(count(SOURCE, 'if (seen.has(entry.term)) continue;'), 1, '去重判定只许一份实现');
  assert.equal(
    count(SOURCE, 'entries.push({ term: entry.term, suggestion: entry.suggestion })'),
    1,
    '合并条目只许在一处 push'
  );
  assert.ok(readBody.includes('mergeListEntries(lists, null)'), 'readGlossaryFiles 必须调用 mergeListEntries(lists, null)');
  assert.equal(readBody.includes('seen.add('), false, 'readGlossaryFiles 不许自己维护 seen');
  assert.equal(readBody.includes('entries.push('), false, 'readGlossaryFiles 不许自己 push 合并条目');
});

test('R2 D3：撞顶跨 3 份的 entries / 每份 truncated 与改前一致，子集按实际参与结算', async () => {
  const dir = await mkTmp();
  const first = path.join(dir, '甲.txt');
  const second = path.join(dir, '乙.txt');
  const third = path.join(dir, '丙.txt');
  const many = Array.from({ length: glossary.MAX_ENTRIES - 1 }, (_value, index) => '甲词' + index);
  await fsp.writeFile(first, many.join('\n') + '\n', 'utf8');
  await fsp.writeFile(second, '乙新一\n甲词0\n乙新二\n', 'utf8');
  await fsp.writeFile(third, '乙新一\n丙新一\n丙新二\n丙新三\n', 'utf8');

  const merged = await glossary.readGlossaryFiles([first, second, third]);
  assert.equal(merged.ok, true);
  assert.equal(merged.total, glossary.MAX_ENTRIES);
  assert.equal(merged.entries.length, glossary.MAX_ENTRIES);
  assert.equal(merged.entries[glossary.MAX_ENTRIES - 1].term, '乙新一', '第 5000 条是第二份的第一个新词');
  assert.deepEqual(merged.lists.map((list) => list.count), [glossary.MAX_ENTRIES - 1, 3, 4]);
  assert.deepEqual(
    merged.lists.map((list) => list.truncated),
    [false, true, true],
    '撞顶后还有新词的份也要标 truncated（后续份不许静默丢掉）'
  );
  for (const term of ['乙新二', '丙新一', '丙新二', '丙新三']) {
    assert.equal(merged.entries.some((entry) => entry.term === term), false, `撞顶后 ${term} 不该进来`);
  }

  // #49/E24：只勾第三份 → 4 条全部参与，不能因为前两份把额度占满而误标截断
  const thirdOnly = await glossary.readProofreadWordlistForRequest(
    { proofreadWordlists: [first, second, third] },
    { enabledLists: [2] }
  );
  assert.deepEqual(thirdOnly.entries.map((entry) => entry.term), ['乙新一', '丙新一', '丙新二', '丙新三']);
  assert.equal(thirdOnly.wordList.truncated, false, '子集合并按实际参与结算，不回退到 #49 的旧口径');
});

test('R3 D3：3 × 6000 条 + 目录 / 不存在文件同批——封顶、坏份只标记、不抛错', async () => {
  const dir = await mkTmp();
  const files = ['超甲.txt', '超乙.txt', '超丙.txt'].map((name) => path.join(dir, name));
  for (const [index, file] of files.entries()) {
    await fsp.writeFile(file, manyLines(`超${index}-`, 6000), 'utf8');
  }
  const missing = path.join(dir, '没有这个文件.txt');
  const asDir = path.join(dir, '这是一份目录.txt');
  await fsp.mkdir(asDir);

  const merged = await glossary.readGlossaryFiles([files[0], missing, asDir, files[1], files[2]]);
  assert.equal(merged.ok, true, '有可读份就不该整体失败');
  assert.equal(merged.entries.length, glossary.MAX_ENTRIES);
  assert.equal(merged.total, glossary.MAX_ENTRIES);
  assert.equal(merged.lists.length, 5);
  // count 是「这一份自己读出来的条数」：单文件自身也封顶 5000，所以 6000 行只进来 5000 条。
  assert.equal(merged.lists[0].count, glossary.MAX_ENTRIES);
  assert.equal(merged.lists[0].ownTruncated, true, '单份 6000 条自己的截断要透传');
  assert.equal(merged.lists[0].truncated, true);
  assert.equal(merged.lists[1].ok, false);
  assert.ok(merged.lists[1].error.length > 0, '不存在文件要给可读原因');
  assert.equal(merged.lists[2].ok, false, '目录冒充词表要报错而不是抛');
  assert.ok(merged.lists[2].error.length > 0);
  assert.equal(merged.lists[3].truncated, true, '撞顶后第三份的新词被挡要标 truncated');
  assert.equal(merged.lists[4].truncated, true, '撞顶后第四份的新词被挡要标 truncated');
  assert.equal(new Set(merged.entries.map((entry) => entry.term)).size, glossary.MAX_ENTRIES, '合并后不许有重复词');
});

test('R4 D3：对外形状不变（lists 内部带 entries，公开信息剥掉正文）', async () => {
  const dir = await mkTmp();
  const file = path.join(dir, '形状.txt');
  await fsp.writeFile(file, '做为 => 作为\n禁词\n', 'utf8');

  const bundle = await glossary.readGlossaryFiles([file]);
  assert.deepEqual(Object.keys(bundle).sort(), ['entries', 'lists', 'ok', 'total']);
  assert.equal(bundle.total, bundle.entries.length);
  const one = bundle.lists[0];
  assert.equal(one.ok, true);
  assert.equal(one.count, 2);
  assert.equal(one.truncated, false);
  assert.equal(one.ownTruncated, false);
  assert.deepEqual(one.entries, [
    { term: '做为', suggestion: '作为' },
    { term: '禁词', suggestion: '' }
  ]);

  const info = glossary.publicGlossaryFilesInfo(bundle);
  assert.deepEqual(Object.keys(info.lists[0]).sort(), ['count', 'error', 'ok', 'truncated']);
  assert.equal(info.lists[0].entries, undefined);
  assert.equal(info.lists[0].ownTruncated, undefined);
  assert.equal(info.total, 2);
});

test('R5 A2：共享 host 校验器归 core/assert-host.js，renderer 不留 shim，ipc 不再反向依赖', () => {
  // ① 文件归位：core 有一份、renderer 侧一个不剩（留 shim 会把「一份实现」重新拆成两条依赖路径）
  assert.equal(fs.existsSync(path.join(ROOT, 'core', 'assert-host.js')), true, 'core/assert-host.js 必须存在');
  assert.equal(
    fs.existsSync(path.join(ROOT, 'renderer', 'assert-host.js')),
    false,
    'renderer/assert-host.js 必须已移走（不许留 re-export shim）'
  );

  // ② ipc 反向依赖消失：4 个消费者一律 require('../core/assert-host')，全仓 ipc 不许出现 renderer/assert-host
  const ipcFiles = fs.readdirSync(path.join(ROOT, 'ipc')).filter((name) => name.endsWith('.js')).sort();
  assert.ok(ipcFiles.length >= IPC_HOST_FILES.length, 'ipc 目录读空了 = 闸门等于没开');
  for (const file of ipcFiles) {
    const src = stripComments(read(`ipc/${file}`));
    assert.equal(src.includes('renderer/assert-host'), false, `ipc/${file} 不许再 require renderer/assert-host（反向依赖）`);
  }
  for (const file of IPC_HOST_FILES) {
    assert.match(
      stripComments(read(file)),
      /require\('\.\.\/core\/assert-host'\)/,
      `${file} 的 host 校验必须从 ../core/assert-host 取`
    );
  }

  // ③ renderer 侧 37 个消费者统一 Node 分支；条件分支（crash-recovery / shelf-filter）也走同一份
  // （A3 第一刀 +chapter-directory-ui.js / 第二刀 +save-chain-ui.js：新模块同样只调共享 assertHost）
  const consumers = hostConsumers();
  assert.equal(consumers.length, 37, `host 消费者数量变了：${consumers.length}`);
  for (const file of consumers) {
    const src = stripComments(read(`renderer/${file}`));
    assert.equal(src.includes("require('./assert-host')"), false, `${file} 不许再 require('./assert-host')`);
    assert.ok(
      src.includes("require('../core/assert-host').assertHost"),
      `${file} 的 UMD Node 分支必须 require('../core/assert-host').assertHost`
    );
    assert.ok(src.includes('root.CWAssertHost'), `${file} 的浏览器分支仍必须取 root.CWAssertHost`);
  }

  // ④ 全仓唯一实现：两条错误文案的实现只许在一处（core/assert-host.js）
  const implementers = [];
  for (const dir of ['core', 'renderer']) {
    for (const file of fs.readdirSync(path.join(ROOT, dir)).filter((name) => name.endsWith('.js')).sort()) {
      const src = stripComments(read(`${dir}/${file}`));
      if (src.includes("的 host 缺少 ' + key") || src.includes('需要 host 对象')) implementers.push(`${dir}/${file}`);
    }
  }
  assert.deepEqual(implementers, ['core/assert-host.js'], '「逐成员判定 + 两条文案」只许在 core/assert-host.js 实现');
});

test('R6 A2：UMD 双分支与浏览器全局名不变（Node 导出同名 / 浏览器仍挂 CWAssertHost）', () => {
  const source = read('core/assert-host.js');
  assert.match(source, /module\.exports = factory\(\);/, 'Node 分支必须 module.exports = factory()');
  assert.match(source, /root\.CWAssertHost = factory\(\);/, '浏览器分支必须仍挂 root.CWAssertHost（全局名不变）');

  const mod = require('../core/assert-host');
  assert.deepEqual(Object.keys(mod), ['assertHost'], '对外导出面不变');
  const host = { $: () => {}, state: {}, api: {}, call: () => {} };
  assert.equal(mod.assertHost('createDemoUi', host, ['$', 'state', 'api', 'call']), host);
  assert.equal(mod.assertHost('createDemoUi', { extra: 1 }, []).extra, 1, '允许多余成员 / 空清单');
  for (const bad of [null, undefined, 'host', 42, true]) {
    assert.throws(
      () => mod.assertHost('createDemoUi', bad, ['$']),
      new TypeError('createDemoUi 需要 host 对象'),
      'host = ' + String(bad)
    );
  }
  assert.throws(
    () => mod.assertHost('createDemoUi', { $: () => {}, state: null }, ['$', 'state']),
    new TypeError('createDemoUi 的 host 缺少 state'),
    '缺成员（null）文案与顺序不变'
  );

  // 浏览器链：没有 module 的环境里跑同一份源码，仍只挂全局、不污染 window 其它名字
  const win = {};
  vm.runInContext(source, vm.createContext(win), { filename: 'core/assert-host.js' });
  assert.equal(typeof win.CWAssertHost.assertHost, 'function', '浏览器里 CWAssertHost.assertHost 必须是函数');
  assert.deepEqual(Object.keys(win), ['CWAssertHost'], '浏览器分支只挂 CWAssertHost 一个全局名');
  assert.throws(
    () => win.CWAssertHost.assertHost('createUndoUi', { slot: {} }, ['$']),
    /createUndoUi 的 host 缺少 \$/,
    '浏览器分支的缺成员文案逐字不变'
  );
});

test('R7 A2：index.html / 装配清单的 assert-host 入口换成 ../core/，顺序与条数不变', () => {
  const html = read('renderer/index.html');
  const tag = '<script src="../core/assert-host.js"></script>';
  const at = html.indexOf(tag);
  assert.ok(at > 0, 'index.html 必须以 ../core/assert-host.js 加载共享校验器');
  assert.equal(html.split(tag).length - 1, 1, 'assert-host 只许加载一次');
  assert.equal(
    html.split('<script src="assert-host.js"></script>').length - 1,
    0,
    'index.html 不许再按 renderer/assert-host.js 的旧路径加载'
  );
  for (const file of hostConsumers()) {
    const tagAt = html.indexOf(`<script src="${file}"></script>`);
    assert.ok(tagAt > 0, `index.html 必须加载 ${file}`);
    assert.ok(at < tagAt, `assert-host 必须排在 ${file} 之前（先校验后建模块）`);
  }

  const manifest = require('../renderer/assembly-manifest');
  const entry = manifest.MODULES.find(([file]) => file === '../core/assert-host.js');
  assert.ok(entry, '装配清单必须有 ../core/assert-host.js 条目');
  assert.equal(entry[1], 'CWAssertHost', '清单里的全局名不变');
  assert.equal(entry[2], '', '清单里的本地名不变（renderer.js 不取顶部常量）');
  assert.equal(
    manifest.MODULES.filter(([file]) => /(?:^|\/)assert-host\.js$/.test(file)).length,
    1,
    '清单里 assert-host 只许一条（旧 renderer 条目必须删掉）'
  );
  // 与 index.html 的契约仍由 wiring-check / assembly 闸门核对，这里只钉「文件路径迁移不改顺序」：
  // assert-host 在清单里的位置仍在 ime-guard.js 之后、font-logic.js 之前。
  const files = manifest.MODULES.map(([file]) => file);
  assert.equal(files.indexOf('../core/assert-host.js'), files.indexOf('ime-guard.js') + 1, '清单顺序被改了');
  assert.equal(files[files.indexOf('../core/assert-host.js') + 1], 'font-logic.js', '清单顺序被改了');
});

test('R8 D2：审计叙事注释瘦身——三处头注只留当前契约与红线，代码行为不随注释变', () => {
  // ① ipc/export.js 头注：搬移行号 / 旧实现叙事归档内部文档，当前红线留在代码旁。
  const exportSrc = read('ipc/export.js');
  const exportHeader = exportSrc.slice(0, exportSrc.indexOf('*/') + 2);
  assert.ok(lineCount(exportHeader) <= 15, `ipc/export.js 头注仍有 ${lineCount(exportHeader)} 行（应 ≤15：只留当前契约）`);
  for (const keep of [
    'V114', // wp34-structure 的「搬移来源」静态闸门
    '只搬不改行为', // 同上：行为零变化的纪律声明
    '保存对话框确认之后才读正文', // 审计 #7 红线
    'atomicWriteFileStream', // 流式写盘契约
    '逐章读', // B1 的「不常驻整本」契约
    'chapter:rescue', // 本域唯一新增频道
    'register(host)',
    'REQUIRED_HOST',
    'getter', // 可变句柄按引用现取
    '不 require electron' // 依赖装配只在 main.js
  ]) {
    assert.ok(exportHeader.includes(keep), `ipc/export.js 头注丢了当前契约 / 红线：${keep}`);
  }
  for (const drop of ['collectExportTexts', '2505–2772', '模块内仍保留原注释', '行号按搬前代码']) {
    assert.equal(exportHeader.includes(drop), false, `ipc/export.js 头注还留着搬移史叙事：${drop}`);
  }
  // 契约留在代码里：流式写盘与救稿入口的实现关键字还在（行为由既有套件全量覆盖）
  assert.ok(exportSrc.includes('atomicWriteFileStream('), 'ipc/export.js 的流式写盘实现不许被注释瘦身带走');
  assert.ok(exportSrc.includes("handle('chapter:rescue'"), 'chapter:rescue 的实现不许被注释瘦身带走');

  // ② core/storage.js 的 assertChapterFile 防退化注释：只留现场红线，删掉审计编号与勘误叙事。
  const storageSrc = read('core/storage.js');
  const guardComment = commentAbove(storageSrc, 'function assertChapterFile(');
  assert.ok(lineCount(guardComment) <= 6, `assertChapterFile 注释仍有 ${lineCount(guardComment)} 行（应 ≤6）`);
  for (const keep of ['不拦「退化」', '写盘前一律过这里', '只读入口同样过它', '保留名']) {
    assert.ok(guardComment.includes(keep), `assertChapterFile 注释丢了现场红线：${keep}`);
  }
  for (const drop of ['勘误', 'B4（审计 #21', 'N1、N2']) {
    assert.equal(guardComment.includes(drop), false, `assertChapterFile 注释还留着审计叙事：${drop}`);
  }
  assert.ok(storageSrc.includes('if (chaptersLib.reservedStem(file)) {'), '保留名过滤实现不许被注释瘦身带走');

  // ③ main.js 启动参数注：保留「打包版不认自动化 + 刻意保留的隔离参数」，删掉版本史编号。
  const mainSrc = read('main.js');
  const at = mainSrc.indexOf('打包版判定只算一次');
  assert.ok(at > 0, 'main.js 要有「打包版判定只算一次」的当前契约说明');
  const automationEnd = mainSrc.indexOf('\n', mainSrc.indexOf('const automation = ', at)) + 1;
  const block = mainSrc.slice(at, automationEnd).trimEnd();
  assert.ok(lineCount(block) <= 18, `main.js 启动参数注 + 开关代码有 ${lineCount(block)} 行（应 ≤18）`);
  for (const keep of [
    'app.isPackaged === true',
    '刻意保留的启动参数',
    '--user-data',
    '--books-root',
    '--remote-debugging-port',
    '自检频道'
  ]) {
    assert.ok(block.includes(keep), `main.js 启动参数注丢了当前契约：${keep}`);
  }
  for (const drop of ['C2（审计 S2）', 'v0.9 A-1', 'v0.9 A-4']) {
    assert.equal(block.includes(drop), false, `main.js 启动参数注还留着历史编号：${drop}`);
  }
  for (const code of [
    'const packagedApp = app.isPackaged === true;',
    "const isE2E = !packagedApp && process.argv.includes('--e2e');",
    "const isBench = !packagedApp && process.argv.includes('--bench');",
    "const isContrast = !packagedApp && process.argv.includes('--contrast');",
    "const automation = isE2E || isBench || isContrast || Boolean(screenshotPath);"
  ]) {
    assert.ok(mainSrc.includes(code), `main.js 启动开关代码被注释瘦身改动：${code}`);
  }
});

test('R9 M-N1：index.html 装配块由清单生成（--write 幂等；--check 拦手改 / 块外脚本）', () => {
  const sync = require('../scripts/assembly-sync');
  const SCRIPT = path.join(ROOT, 'scripts', 'assembly-sync.js');
  const manifest = require('../renderer/assembly-manifest');
  const html = read('renderer/index.html');
  const eol = sync.detectEol(html);

  // ① 真实树：标记唯一、块逐字节等于清单生成结果、块外零 <script src>、renderer.js 仍单文件且最后加载
  assert.equal(html.split(sync.BEGIN_MARKER).length - 1, 1, 'BEGIN 标记必须恰好 1 个');
  assert.equal(html.split(sync.END_MARKER).length - 1, 1, 'END 标记必须恰好 1 个');
  const real = sync.checkRoot(ROOT);
  assert.equal(real.ok, true, `真实树装配块必须一致：${real.reason || ''}`);
  assert.equal(real.modules, manifest.MODULES.length);
  const block = sync.extractBlock(html).trimEnd();
  assert.equal(block, sync.buildBlock(manifest, eol), '装配块必须逐字节等于清单生成结果（手改块会红）');
  assert.equal(
    block.split(/\r?\n/).length,
    manifest.MODULES.length + sync.TAIL_SCRIPTS.length,
    '块行数 = 清单模块 + assembly-manifest.js → renderer.js（不许多 / 少脚本）'
  );
  const outside = html.replace(sync.extractBlock(html), '');
  assert.equal(
    [...outside.matchAll(/<script\b[^>]*\bsrc\s*=/gi)].length,
    0,
    '装配块外不许再有 <script src>（所有模块脚本必须由清单生成）'
  );
  const blockSrcs = [...block.matchAll(/src="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(blockSrcs[blockSrcs.length - 1], 'renderer.js', 'renderer.js 必须仍是最后一个脚本');
  assert.equal(blockSrcs[blockSrcs.length - 2], 'assembly-manifest.js');
  assert.equal(fs.existsSync(path.join(ROOT, 'renderer', 'renderer.js')), true, 'M-N1 不拆 renderer.js');
  // --write 在已同步的树上必须零改动（幂等）
  assert.equal(sync.applyBlock(html, sync.buildBlock(manifest, eol)), html, '--write 必须幂等');

  // ② 夹具：手改块 / 块外插脚本 / 标记缺失都要红；--write 能修回
  const dir = tmpCleanup.track(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-assembly-')));
  fs.mkdirSync(path.join(dir, 'renderer'));
  fs.copyFileSync(path.join(ROOT, 'renderer', 'assembly-manifest.js'), path.join(dir, 'renderer', 'assembly-manifest.js'));
  fs.copyFileSync(path.join(ROOT, 'renderer', 'index.html'), path.join(dir, 'renderer', 'index.html'));
  // 临时目录在 D:\Temp 下（宿主 package.json 是 type: module），复制仓库 package.json 让清单按 CommonJS 解析。
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  const fixtureIndex = path.join(dir, 'renderer', 'index.html');
  assert.equal(sync.checkRoot(dir).ok, true, '原样复制必须绿');

  // 块内手改（删一行）→ 红并指出第一处不同的行号
  const missingLine = fs.readFileSync(fixtureIndex, 'utf8').replace(/\s*<script src="undo-ui\.js"><\/script>\r?\n/, '\n');
  fs.writeFileSync(fixtureIndex, missingLine, 'utf8');
  const drift = sync.checkRoot(dir);
  assert.equal(drift.ok, false, '块内手改必须红');
  assert.ok(drift.line > 0, '不一致要指出第一处不同的行号');
  assert.equal(sync.writeRoot(dir).changed, true, '--write 要能把手改修回');
  assert.equal(sync.checkRoot(dir).ok, true, '--write 之后必须绿');
  assert.equal(sync.writeRoot(dir).changed, false, '--write 修回后再跑必须零改动');

  // 块外插 <script> → 红（绕过清单的手工装配）
  const ghost = fs.readFileSync(fixtureIndex, 'utf8').replace(sync.END_MARKER, `${sync.END_MARKER}${eol}  <script src="ghost-ui.js"></script>`);
  fs.writeFileSync(fixtureIndex, ghost, 'utf8');
  const outsideBad = sync.checkRoot(dir);
  assert.equal(outsideBad.ok, false, '块外插脚本必须红');
  assert.match(outsideBad.reason, /块外/, `失败原因要点名块外脚本：${outsideBad.reason}`);

  // 标记缺失 → 红（不是崩溃）
  const noMarker = fs.readFileSync(fixtureIndex, 'utf8')
    .replace(sync.BEGIN_MARKER, '<!-- 标记被删 -->')
    .replace(sync.END_MARKER, '<!-- 标记被删 -->');
  fs.writeFileSync(fixtureIndex, noMarker, 'utf8');
  const markerBad = sync.checkRoot(dir);
  assert.equal(markerBad.ok, false, '标记缺失必须红');
  assert.match(markerBad.reason, /标记/);

  // ③ CLI：真实树 exit 0；漂移树 exit 1；根目录不存在 exit 2
  const clean = spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(clean.status, 0, `真实树应 exit 0，实际 ${clean.status}\n${clean.stderr}`);
  assert.match(clean.stdout, /装配块一致/);
  const bad = spawnSync(process.execPath, [SCRIPT, '--check', '--root', dir], { encoding: 'utf8' });
  assert.equal(bad.status, 1, `漂移夹具应 exit 1，实际 ${bad.status}\n${bad.stdout}\n${bad.stderr}`);
  assert.match(bad.stderr, /装配块校验未通过/);
  const missingRoot = spawnSync(process.execPath, [SCRIPT, '--check', '--root', path.join(dir, '没有这个根')], { encoding: 'utf8' });
  assert.equal(missingRoot.status, 2, '根目录不存在应 exit 2（配置错误，不是内容漂移）');
});

// WP17（A3 第一刀，审计 #20，2026-11-18，HEAD d409c7d）：章节目录 / 卷章显示层整段迁出 renderer.js。
//   R10 模块 / 装配 / 定义面：新模块存在且 UMD 双分支契约不变（Node 可 require、浏览器只挂
//       CWChapterDirectoryUi）；index.html 装配块含且只含一次、排在 renderer.js 之前；renderer.js
//       不再定义这 48 个被迁函数（逐函数名断言）、只留「常量 + 一次 create + 按原名取入口」；
//       E2E 名字来源（组索引 0–83）未被本刀改动——逐行 PASS 名字由全量 E2E 门禁与基线日志对拍。
const CD_FILE = 'chapter-directory-ui.js';
const CD_GLOBAL = 'CWChapterDirectoryUi';
const CD_LOCAL = 'chapterDirectoryUiModule';
const CD_MOVED = [
  'chapterFilterQuery', 'chapterFilterActive', 'chapterIndexMatchesFilter', 'matchingChapterIndexes',
  'chapterCharsTotal', 'formatCharsLabel', 'renderBookMeta', 'syncChapterFilterUi',
  'cancelScheduledChapterFilter', 'scheduleChapterFilterRender', 'setChapterFilter', 'appendChapterName',
  'volumeGroupKeys', 'renderVolumeToggle', 'toggleAllVolumes', 'activeChapterItem',
  'syncCurrentVolumeMarker', 'currentChapterGroupKey', 'updateCurrentChapterPill', 'scrollToCurrentChapter',
  'setupChapterDirectory', 'chapterItemAt', 'chapterMoreAt', 'setupChapterListEvents',
  'openBatchMenu', 'setupChapterBatchBar', 'volumeList', 'volumeById',
  'volumeDisplayName', 'chapterVolumeId', 'toggleVolumeCollapse', 'makeVolumeHeader',
  'chapterItemTip', 'chapterItemTitleText', 'chapterSelectionSnapshot', 'chapterIdAt',
  'currentChapterId', 'chapterIdsInBookOrder', 'renderedChapterIds', 'selectedChapterIndexes',
  'syncChapterBatchBar', 'syncChapterSelectionUi', 'setChapterSelection', 'clearChapterSelection',
  'pruneChapterSelection', 'ensureChapterSelected', 'makeChapterItem', 'renderChapterList'
];
// renderer.js 里仍有人调用的 26 个入口：只有它们需要按原名接线；其余 22 个随调用点一起内聚到
// 模块里（再解构出来既没人读，也会被 eslint no-unused-vars 判红）。
const CD_WIRED = [
  'chapterFilterActive', 'chapterIndexMatchesFilter', 'renderBookMeta', 'syncChapterFilterUi',
  'renderVolumeToggle', 'activeChapterItem', 'syncCurrentVolumeMarker', 'updateCurrentChapterPill',
  'setupChapterDirectory', 'setupChapterListEvents', 'setupChapterBatchBar', 'volumeList',
  'volumeById', 'volumeDisplayName', 'chapterVolumeId', 'toggleVolumeCollapse',
  'chapterItemTitleText', 'chapterSelectionSnapshot', 'chapterIdAt', 'currentChapterId',
  'renderedChapterIds', 'selectedChapterIndexes', 'syncChapterBatchBar', 'setChapterSelection',
  'clearChapterSelection', 'renderChapterList'
];

test('R10 A3：章节目录显示层整段迁出 renderer.js（模块 / 装配 / 定义面 / E2E 基线）', () => {
  const modulePath = path.join(ROOT, 'renderer', CD_FILE);
  assert.equal(fs.existsSync(modulePath), true, `新模块必须存在：renderer/${CD_FILE}`);
  const source = read(`renderer/${CD_FILE}`);

  // ① UMD 双分支 + Node 契约：Node 直接 require 可 create；浏览器只挂 CWChapterDirectoryUi 一个全局。
  const mod = require(`../renderer/${CD_FILE}`);
  assert.equal(typeof mod.create, 'function', 'Node 分支要导出 create');
  assert.ok(Array.isArray(mod.REQUIRED_HOST) && mod.REQUIRED_HOST.length > 0, 'Node 分支要导出 REQUIRED_HOST');
  assert.match(source, /require\('\.\.\/core\/assert-host'\)\.assertHost/, 'UMD Node 分支从 core 取 assertHost');
  assert.match(
    source,
    /root\.CWChapterDirectoryUi = factory\(root\.CWAssertHost && root\.CWAssertHost\.assertHost\)/,
    '浏览器分支挂 CWChapterDirectoryUi（全局名不变）'
  );
  const win = {};
  vm.runInContext(source, vm.createContext(win), { filename: CD_FILE });
  assert.equal(typeof win[CD_GLOBAL].create, 'function', '浏览器里 CWChapterDirectoryUi.create 必须是函数');
  assert.deepEqual(Object.keys(win), [CD_GLOBAL], '浏览器分支只许挂 CWChapterDirectoryUi 一个全局名');
  // 页面按清单先加载 core/assert-host.js、后加载本模块：缺成员要在 create 时逐字报错，不能 ReferenceError。
  const win2 = {};
  const ctx2 = vm.createContext(win2);
  vm.runInContext(read('core/assert-host.js'), ctx2, { filename: 'core/assert-host.js' });
  vm.runInContext(source, ctx2, { filename: CD_FILE });
  assert.throws(
    () => win2[CD_GLOBAL].create({}),
    new TypeError(`createChapterDirectoryUi 的 host 缺少 ${mod.REQUIRED_HOST[0]}`),
    '缺成员文案逐字不变（再往下就 ReferenceError）'
  );

  // ② create(host) 返回全部被迁入口（48 个，按原名薄调用）；host 清单逐成员都在。
  assert.equal(CD_MOVED.length, 48, '被迁函数清单必须正好 48 个（R10 与 R9 口径）');
  const host = {};
  for (const key of mod.REQUIRED_HOST) host[key] = () => ({});
  host.state = {};
  host.CHAPTER_STATUS_LABELS = {};
  host.chapterSelectionLib = {};
  host.chaptersLib = {};
  host.chapterFilterLogic = {};
  host.editorLogic = {};
  const ui = mod.create(host);
  assert.deepEqual(Object.keys(ui).sort(), CD_MOVED.slice().sort(), 'create 返回面 = 迁出的 48 个入口');
  for (const name of CD_MOVED) assert.equal(typeof ui[name], 'function', `${name} 必须是函数`);

  // ③ index.html 装配块：含且只含一次，排在 renderer.js 之前（块由清单生成，手改会被 R9 拦）。
  const html = read('renderer/index.html');
  const tag = `<script src="${CD_FILE}"></script>`;
  assert.equal((html.split(tag).length - 1), 1, `index.html 必须恰好加载一次 ${CD_FILE}`);
  const at = html.indexOf(tag);
  assert.ok(at > 0, `index.html 找不到 ${CD_FILE} 的 <script>`);
  assert.ok(at < html.indexOf('<script src="renderer.js"></script>'), `${CD_FILE} 必须排在 renderer.js 之前`);
  const sync = require('../scripts/assembly-sync');
  const block = sync.extractBlock(html);
  assert.equal((block.split(tag).length - 1), 1, '装配块含且只含一次（块外手插会被 assembly-sync --check 拦住）');

  // ④ 装配清单：一条、全局名 / 本地名正确、依赖（assert-host）在前，renderer.js 仍最后加载。
  const manifest = require('../renderer/assembly-manifest');
  const entries = manifest.MODULES.filter(([file]) => file === CD_FILE);
  assert.equal(entries.length, 1, '装配清单里只许一条');
  assert.deepEqual(entries[0].slice(0, 3), [CD_FILE, CD_GLOBAL, CD_LOCAL], '清单的全局名 / 本地名不对');
  const files = manifest.MODULES.map(([file]) => file);
  assert.ok(files.indexOf(CD_FILE) > files.indexOf('../core/assert-host.js'), '必须排在校验器之后（先校验后建模块）');
  assert.ok(files.indexOf(CD_FILE) < files.length - 1, '清单条目不许压在末尾（后续仍要有独立模块）');

  // ⑤ renderer.js 定义面：48 个函数一个都不许留；只留常量 + 一次 create + 按原名取入口。
  const renderer = read('renderer/renderer.js');
  assert.ok(renderer.includes(`const ${CD_LOCAL} = window.${CD_GLOBAL};`), 'renderer.js 要按清单本地名取模块');
  assert.equal(
    (renderer.split(`const chapterDirectoryUi = ${CD_LOCAL}.create({`).length - 1),
    1,
    '装配只许一处 create'
  );
  const wiring = /const \{([\s\S]*?)\} = chapterDirectoryUi;/.exec(renderer);
  assert.ok(wiring, 'renderer.js 要按原名取全部入口（薄接线，不重写显示层）');
  for (const name of CD_MOVED) {
    assert.doesNotMatch(
      renderer,
      new RegExp(`(?:^|\\n)  (?:async )?function ${name}\\(`),
      `${name} 仍定义在 renderer.js（必须整段迁走，只留同名接线）`
    );
    assert.match(source, new RegExp(`\\n  function ${name}\\(`), `新模块里找不到 function ${name}(`);
    if (CD_WIRED.includes(name)) {
      assert.ok(wiring[1].includes(name), `renderer.js 的接线块少了 ${name}（原调用点会断）`);
    } else {
      assert.equal(
        wiring[1].includes(name),
        false,
        `${name} 已随调用点内聚进模块：renderer.js 里没人读，不许再解构（eslint no-unused-vars 会红）`
      );
    }
  }
  assert.equal(CD_WIRED.length, 26, 'renderer.js 的接线面必须正好 26 个入口（其余 22 个内聚在模块里）');

  // ⑥ E2E 名字基线：本刀不新增 / 删除 / 重排任何 E2E 组（名字逐行一致由全量 E2E 日志对拍）。
  const { groups } = require('../scripts/e2e/groups');
  assert.equal(groups.length, 84, 'E2E 组数变了（名字基线会被本刀意外改写）');
  assert.deepEqual(groups.map((group) => group.id), Array.from({ length: 84 }, (_v, index) => index), '组号顺序变了');
  for (const group of groups) assert.equal(typeof group.run, 'function', `E2E 组 ${group.id} 的 runner 丢了`);
  assert.ok(read('scripts/run-e2e.js').includes('${item.name}'), 'PASS / FAIL 行仍按 item.name 逐行打印');
});