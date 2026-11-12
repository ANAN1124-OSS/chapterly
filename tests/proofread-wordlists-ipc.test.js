// F3b2（1.7.0）：主进程接线——多份校对词表的读取 / 公开信息 / 添加移除频道。
// main.js 依赖 electron，Node 里 require 不起来；这里用和 tests/skipped-too-large-ipc.test.js
// 同一手法：按锚点切出函数体做静态闸门，保证 ① 读取走 core 的多表合并 ② 回渲染层的信息只有
// 数量与状态（绝不带路径 / 词条正文）③ 新增频道在 main 与 preload 一一对应。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

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
  assert.match(addBody, /path\.isAbsolute\(/, '要校验绝对路径');
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
