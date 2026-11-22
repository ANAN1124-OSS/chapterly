// 搜索索引测试（T9 / 第 10 轮按性质拆分）：源码静态闸门。
// 本文件覆盖：CTXT-A-03 main.js 不再给 search() 传无人消费的 onProgress →
// S8 索引文件大小闸门与读盘同句柄（open → fstat → handle.readFile）→
// E21/#46 落盘只有一条串行链（doEnsure / load 不再绕过 flush 直调 saveNow）。
//
// 来源：原 tests/search-index.test.js（1,678 行 / 51 例）按性质拆成夹具 + 四个文件，**只搬家不改断言**——
// 用例标题与断言逐字保留，共用夹具收进 tests/search-index-fixtures.js（T9 纪律，见 tests/README.md）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

// CTXT-A-03（低）：search() 从未消费 onProgress，调用点却传了它 —— 静默吞参误导维护者。
test('正文索引（CTXT-A-03）：main.js 不再给 search() 传无人消费的 onProgress，ensure 通道仍保留', async () => {
  const mainSrc = await fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8');
  const searchAt = mainSrc.indexOf('getSearchIndexStore().search({');
  assert.ok(searchAt > 0, '找不到 search:content 的调用点');
  const callBody = mainSrc.slice(searchAt, searchAt + 500);
  assert.equal(/onProgress/.test(callBody), false, 'search() 不支持 onProgress，调用点不许再传');
  const ensureAt = mainSrc.indexOf('getSearchIndexStore().ensure({');
  assert.ok(ensureAt > 0);
  assert.match(mainSrc.slice(ensureAt, ensureAt + 500), /onProgress: sendSearchProgress/, 'ensure 通道的进度上报保留');
});

// S8（审计修复 #45）：索引文件「先 stat 再按路径 readFile」的 TOCTOU —— 闸门与读盘必须绑在同一个句柄上。
test('S8（#45）：索引文件的大小闸门与读盘走同一个句柄（open → fstat → handle.readFile）', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'core', 'search-index.js'), 'utf8');
  const start = src.indexOf('function load()');
  assert.ok(start >= 0, '找不到 load()');
  const body = src.slice(start, src.indexOf('function ensure()', start));
  assert.ok(body.includes('fs.open(filePath, \'r\')'), '必须先 open 再 fstat');
  assert.ok(body.includes('handle.stat()'), '上限要用句柄上的 fstat 结论');
  assert.ok(body.includes("handle.readFile('utf8')"), '内容必须从同一个句柄读');
  assert.equal(body.includes('fs.readFile(filePath'), false, '不许再按路径 readFile（TOCTOU 窗口）');
});

test('E21（#46）：落盘只有一条串行链 —— doEnsure / load 不再绕过 flush 直接 await saveNow()', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'core', 'search-index.js'), 'utf8');
  // 串行链唯一入队口
  assert.ok(src.includes('function saveThrough()'), '缺 saveThrough');
  assert.ok(/savePromise = savePromise\.then\(saveNow, saveNow\)/.test(src));
  // 两个曾经绕开链的调用点 (load / doEnsure) 改为入队：只钉调用结构，不钉注释措辞 / 审计编号（TESTC-01）。
  const loadAt = src.indexOf('function load()');
  const statusAt = src.indexOf('function status()', loadAt);
  assert.ok(loadAt >= 0 && statusAt > loadAt, '要能定位 load() 的函数体');
  assert.ok(src.slice(loadAt, statusAt).includes('await saveThrough();'), 'load 不许绕过串行链直写');
  const ensureAt = src.indexOf('async function doEnsure');
  const ensureEnd = src.indexOf('function ensure(', ensureAt);
  assert.ok(ensureAt >= 0 && ensureEnd > ensureAt, '要能定位 doEnsure() 的函数体');
  assert.ok(src.slice(ensureAt, ensureEnd).includes('await saveThrough();'), 'doEnsure 不许绕过串行链直写');
  // 除串行链自身以外，任何地方都不许再直调 saveNow()
  const calls = src.match(/await saveNow\(\);/g) || [];
  assert.equal(calls.length, 0, `仍有 ${calls.length} 处直调 saveNow()`);
});
