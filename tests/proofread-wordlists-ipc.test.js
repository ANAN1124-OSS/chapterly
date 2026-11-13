// F3b2（1.7.0）：主进程接线——多份校对词表的读取 / 公开信息 / 添加移除频道。
// main.js 依赖 electron，Node 里 require 不起来；这里用和 tests/skipped-too-large-ipc.test.js
// 同一手法：按锚点切出函数体做静态闸门，保证 ① 读取走 core 的多表合并 ② 回渲染层的信息只有
// 数量与状态（绝不带路径 / 词条正文）③ 新增频道在 main 与 preload 一一对应。
const test = require('node:test');
const assert = require('node:assert/strict');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const pathUtils = require('../core/path-utils');

const readSource = (rel) =>
  require('node:fs').readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

const mainSource = readSource('main.js');
const preloadSource = readSource('preload.js');

// 从锚点切到下一个顶格两空格的函数 / handler 之前（与 tests/book-batch.test.js 同一手法）
function sliceFrom(source, startMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, '找不到锚点：' + startMarker);
  const rest = source.slice(start + startMarker.length);
  const next = rest.search(/\n {2}(?:async function |function |handleBook\(|handle\()/);
  return next === -1 ? rest : rest.slice(0, next);
}

const matchesOf = (source, pattern) => [...source.matchAll(pattern)].map((m) => m[1]);

const RUN_SITES = [
  ['text:proofread', "  handle('text:proofread', async (text, options) => {"],
  ['book:proofread', "  handleBook('book:proofread', async (bookPath, options, override) => {"]
];
test('静态闸门：校对词表有效路径 = proofreadWordlists 非空取数组，否则回落单份（F3b2）', () => {
  const helper = sliceFrom(mainSource, 'function proofreadWordlistPaths(config) {');
  assert.match(helper, /Array\.isArray\(config\.proofreadWordlists\)/, '多份字段必须是数组才用');
  assert.match(helper, /config\.proofreadWordlists\.length/, '数组非空才用数组（空数组回落单份）');
  assert.match(helper, /config\.proofreadWordsPath/, '单份旧字段要回落');
  assert.match(helper, /filter\(/, '要过滤空串 / 非字符串，别把空路径当一份词表');
  for (const [channel, anchor] of RUN_SITES) {
    const body = sliceFrom(mainSource, anchor);
    assert.match(body, /readProofreadWordlistForRequest\(/, channel + ' 要走统一的词表读取口径');
  }
  const reader = sliceFrom(mainSource, 'async function readProofreadWordlistForRequest(config, options) {');
  assert.match(reader, /hasProofreadWordlists\(/, '单份 / 多份要先分流');
  assert.match(reader, /glossaryLib\.readGlossaryFile\(/, '单份（旧配置）必须原样单表读取，行为一字不变');
  assert.match(reader, /glossaryLib\.readGlossaryFiles\(/, '多份走 core 合并');
  assert.match(reader, /publicGlossaryInfo\(/, '单份保持旧的公开信息形状');
});
test('静态闸门：proofread:words-info 回 lists + total 并补齐旧字段，绝不带路径与正文（F3b2）', () => {
  const builder = sliceFrom(mainSource, 'function proofreadWordListInfo(bundle, paths) {');
  assert.match(builder, /glossaryLib\.publicGlossaryFilesInfo\(/, '公开信息要过 core 的剥壳函数');
  assert.match(builder, /\blists\b/, '多份要回 lists（按 index 对齐配置）');
  assert.match(builder, /\btotal\b/, '多份要回合并总数');
  assert.match(builder, /count/, '单份要保持旧字段 count');
  assert.match(builder, /truncated/, '单份要保持旧字段 truncated');
  assert.doesNotMatch(builder, /entries\s*:/, '绝不把词条正文带出主进程');
  assert.doesNotMatch(builder, /\bpath\s*:/, '绝不把路径带出主进程');
  const handler = sliceFrom(mainSource, "  handle('proofread:words-info', async () => {");
  assert.match(handler, /readProofreadWordlistForRequest\(/, 'words-info 要走统一的词表读取口径（单份原样 / 多份合并）');
  assert.match(handler, /wordList/, 'words-info 要回统一的信息形状');
});
test('静态闸门：新增的添加 / 移除频道在 main 与 preload 一一对应（F3b2）', () => {
  const mainChannels = new Set(matchesOf(mainSource, /handle\('(proofread:[a-z-]+)'/g));
  const preloadChannels = new Set(matchesOf(preloadSource, /invoke\('(proofread:[a-z-]+)'/g));
  assert.deepEqual(
    [...preloadChannels].sort(),
    [...mainChannels].sort(),
    '每一条校对频道都要有对应的 preload 成员（多一个少一个都不行）'
  );
  for (const name of ['proofread:wordlists-add', 'proofread:wordlists-remove']) {
    assert.ok(mainChannels.has(name), '要有频道 ' + name);
  }
  assert.match(preloadSource, /addProofreadWordlist:/, 'preload 要有 addProofreadWordlist');
  assert.match(preloadSource, /removeProofreadWordlist:/, 'preload 要有 removeProofreadWordlist');
  const addBody = sliceFrom(mainSource, "  handle('proofread:wordlists-add', async () => {");
  assert.match(addBody, /showOpenDialog\(/, '添加走系统对话框（渲染层不能自己给路径）');
  assert.match(addBody, /canceled: true/, '取消要回 { canceled: true }');
  assert.match(addBody, /proofreadWordlists/, '要操作多份字段');
  assert.match(addBody, /configStore\.set\(/, '要落盘');
  const removeBody = sliceFrom(mainSource, "  handle('proofread:wordlists-remove', async (index) => {");
  assert.match(removeBody, /Number\.isInteger\(/, 'index 必须是整数');
  assert.match(removeBody, /splice\(/, '合法索引才能移除');
  assert.match(removeBody, /configStore\.set\(/, '要落盘');
  // 旧单选频道行为保留：仍走单份公开信息
  const pickBody = sliceFrom(mainSource, "  handle('proofread:pick-words', async () => {");
  assert.match(pickBody, /proofreadWordsPath/, 'pick-words 仍写单份旧字段');
  assert.match(pickBody, /publicGlossaryInfo\(/, 'pick-words 仍回单份公开信息');
});
test('静态闸门：text / book 校对支持 options.enabledLists 过滤参与的词表，缺省全开（F3b2）', () => {
  const helper = sliceFrom(mainSource, 'function wordlistPathsForRequest(paths, options) {');
  assert.match(helper, /options\.enabledLists/, '要认 enabledLists');
  assert.match(helper, /Array\.isArray/, '非数组当全开');
  assert.match(helper, /paths\.filter\(/, '按索引过滤参与的词表');
  const reader = sliceFrom(mainSource, 'async function readProofreadWordlistForRequest(config, options) {');
  assert.match(reader, /wordlistPathsForRequest\(/, '多份分支要按 enabledLists 过滤');
});

// 从 main.js 的 handler 注册语句里切出箭头函数，在假作用域里真跑一遍（不 require electron）。
// 只用于「校验顺序」这种行为断言：静态正则锁不住「先读词表还是先 stat / 判重 / 判上限」（V53）。
function extractAsyncArrow(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, '找不到锚点：' + marker);
  const braceStart = start + marker.length - 1;
  assert.equal(source[braceStart], '{', '锚点必须以箭头函数体的 { 结尾：' + marker);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.notEqual(end, -1, '箭头函数体没闭合：' + marker);
  return 'async () => ' + source.slice(braceStart, end);
}

const ADD_ANCHOR = "  handle('proofread:wordlists-add', async () => {";

// 把 add 处理器装进假作用域：dialog / 配置 / 词表信息都是替身，fs 与 path 用真的。
// 返回 { handler, calls }；calls 记录 stat / info 的调用顺序——就是 V53 要钉的「先校验、后读词表」。
function loadAddWordlistHandler({ picked, config }) {
  const calls = [];
  const arrow = extractAsyncArrow(mainSource, ADD_ANCHOR);
  const handler = new Function(
    'showOpenDialog',
    'getConfig',
    'configStore',
    'applyConfig',
    'proofreadWordlistInfoNow',
    'fs',
    'pathUtils',
    'path',
    'WORDLIST_MAX',
    'wordlistKey',
    `return (${arrow});`
  )(
    async () => ({ canceled: false, filePaths: [picked] }),
    async () => config,
    { set: async (patch) => ({ ...config, ...patch }) },
    () => {},
    async () => {
      calls.push('info');
      return { lists: [], total: 0, multi: true };
    },
    { stat: (target) => { calls.push('stat'); return fsPromises.stat(target).catch(() => null); } },
    pathUtils,
    path,
    8,
    // 只为让「改前」的旧实现也能跑起来；断言的是调用顺序，不是函数名
    pathUtils.pathKey
  );
  return { handler, calls };
}

test('行为：添加词表先 stat / 判重 / 判上限，再读词表；被拒绝的路径不先读一遍（V53）', async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'cw-wordlist-add-'));
  try {
    const missing = path.join(dir, '没有这份词表.txt');
    const existing = path.join(dir, '已有词表.txt');
    await fsPromises.writeFile(existing, '错词\n', 'utf8');

    // ① 不存在：先 stat 判掉，再读词表回面板（而不是先把全部词表读一遍才发现文件不在）
    {
      const { handler, calls } = loadAddWordlistHandler({ picked: missing, config: { proofreadWordlists: [] } });
      const res = await handler();
      assert.equal(res.code, 'WORDLIST_MISSING');
      assert.equal(res.added, false);
      assert.deepEqual(calls, ['stat', 'info'], '缺失文件：stat 必须先于读词表');
    }
    // ② 已在列表里：stat 通过 → 判重 → 再读词表
    {
      const { handler, calls } = loadAddWordlistHandler({ picked: existing, config: { proofreadWordlists: [existing] } });
      const res = await handler();
      assert.equal(res.code, 'WORDLIST_DUPLICATE');
      assert.deepEqual(calls, ['stat', 'info'], '重复文件：先 stat → 判重 → 再读词表');
    }
    // ③ 8 份上限：stat 通过 → 判重通过 → 判上限 → 再读词表
    {
      const full = Array.from({ length: 8 }, (_, index) => path.join(dir, `满${index}.txt`));
      const { handler, calls } = loadAddWordlistHandler({ picked: existing, config: { proofreadWordlists: full } });
      const res = await handler();
      assert.equal(res.code, 'WORDLIST_LIMIT');
      assert.equal(res.message, '最多 8 份校对词表');
      assert.deepEqual(calls, ['stat', 'info'], '到上限：先校验再读词表');
    }
    // ④ 通过校验：落盘后只读一次词表
    {
      const { handler, calls } = loadAddWordlistHandler({ picked: existing, config: { proofreadWordlists: [] } });
      const res = await handler();
      assert.equal(res.added, true);
      assert.deepEqual(calls, ['stat', 'info'], '成功路径也只读一次词表（校验通过之后）');
    }
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
