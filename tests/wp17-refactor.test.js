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

  // ③ renderer 侧 33 个消费者统一 Node 分支；条件分支（crash-recovery / shelf-filter）也走同一份
  const consumers = hostConsumers();
  assert.equal(consumers.length, 33, `host 消费者数量变了：${consumers.length}`);
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