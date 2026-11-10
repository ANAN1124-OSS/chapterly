// B6（审计 P6）：书架搜索防抖 + 书卡缓存。
//
// renderer.js 是浏览器侧 IIFE，这里沿用仓库里「读源码做静态闸门」的先例：
//   · 输入事件只更新查询词 + 排一次「250ms 防抖 + 下一帧」的渲染，不许每键同步重建 grid；
//   · 防抖实现必须 clearTimeout 合并连续输入、并用 requestAnimationFrame 把渲染放到下一帧；
//   · Esc / 清空按钮仍是立即重渲染（行为不变）；
//   · E2E 用的 __cwTest.setShelfQuery 仍同步 renderShelf（否则第 33 / 44 / 53 组的 120ms 等待语义会被改掉）；
//   · 书卡缓存（renderShelf 的渲染签名 + 复用）在 tests/bookinfo-ui.test.js 里有真行为测试。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const RENDERER = read('renderer/renderer.js');
const TEST_HOOKS = read('renderer/test-hooks.js');
const BOOKINFO = read('renderer/bookinfo-ui.js');

function sliceBetween(source, from, to) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `找不到起点：${from}`);
  const end = source.indexOf(to, start + 1);
  assert.ok(end > start, `找不到终点：${to}`);
  return source.slice(start, end);
}

test('静态闸门：书架搜索输入走 250ms 防抖 + 下一帧渲染，不许每键同步重建', () => {
  const inputBlock = sliceBetween(
    RENDERER,
    "$('shelf-search').addEventListener('input', () => {",
    "$('shelf-search').addEventListener('keydown'"
  );
  assert.ok(inputBlock.includes('scheduleShelfRender()'), '输入事件要排防抖渲染');
  assert.equal(inputBlock.includes('renderShelf();'), false, '输入事件里不许再同步 renderShelf（每键重建）');
  assert.ok(inputBlock.includes('state.shelfQuery = '), '查询词仍要立刻写回 state（正文搜索 / 回车用最新值）');
  assert.ok(inputBlock.includes('scheduleContentSearch()'), '正文搜索的独立防抖调度不变');

  const scheduler = sliceBetween(RENDERER, 'function scheduleShelfRender() {', '\n    }\n');
  assert.match(scheduler, /clearTimeout\(shelfFilterTimer\)/, '连续输入要合并（清掉上一个定时器）');
  assert.match(scheduler, /setTimeout\(/, '要有防抖定时器');
  assert.match(scheduler, /\},\s*250\);/, '防抖间隔应为 250ms（200–300ms 区间）');
  assert.match(scheduler, /requestAnimationFrame\(/, '渲染要放到下一帧（和绘制合并）');
  assert.match(scheduler, /renderShelf\(\)/, '定时器到点后要真的渲染');
});

test('静态闸门：Esc / 清空仍立即重渲染；E2E 测试钩子仍同步渲染', () => {
  // keydown 里 Esc / Enter 的处理：Esc 立即 renderShelf（不等防抖）。
  // 2026-11-10 卷章目录新增了第二个输入框 Esc（筛选清空），所以这里从书架搜索框的
  // keydown 起切，不再抓全文件第一个 Escape。
  const escRender = sliceBetween(
    RENDERER,
    "$('shelf-search').addEventListener('keydown', (event) => {",
    'return;'
  );
  assert.ok(escRender.includes('renderShelf();'), 'Esc 清空后要立即重渲染（旧行为）');
  const clearBlock = sliceBetween(
    RENDERER,
    "$('btn-shelf-search-clear').addEventListener('click'",
    '});'
  );
  assert.ok(clearBlock.includes('renderShelf();'), '清空按钮要立即重渲染（旧行为）');

  const hook = sliceBetween(TEST_HOOKS, 'setShelfQuery(q) {', '},');
  assert.ok(hook.includes('renderShelf();'), '__cwTest.setShelfQuery 必须同步渲染（E2E 时不依赖 250ms 防抖）');
});

test('静态闸门：书架 grid 按渲染签名复用，签名覆盖会改卡片 DOM 的字段', () => {
  const shelf = sliceBetween(
    BOOKINFO,
    '  function renderShelf() {',
    '  // B6（审计 P6）：书架 grid 的重建部分'
  );
  assert.ok(shelf.includes('shelfRenderSignature(query, rows)'), 'renderShelf 要计算渲染签名');
  assert.match(shelf, /if \(grid\.dataset\.renderSignature !== signature\)/, '签名没变就不重建 grid');
  assert.ok(shelf.includes('buildShelfGrid(grid, query, rows)'), '重建走 buildShelfGrid');
  assert.equal(
    (shelf.match(/grid\.innerHTML = '';/g) || []).length,
    0,
    '清空 grid 只许在 buildShelfGrid 里（renderShelf 不能无条件清空）'
  );
  const builder = sliceBetween(BOOKINFO, '  function buildShelfGrid(grid, query, rows) {', '  function shelfRenderSignature');
  assert.ok(builder.includes("grid.innerHTML = '';"), 'buildShelfGrid 负责清空');
  assert.ok(builder.includes('card.dataset.path = book.path'), '书卡仍按 data-path 标识');

  const signature = sliceBetween(BOOKINFO, '  function shelfRenderSignature(query, rows) {', '\n  }\n');
  for (const field of ['book.path', 'book.title', 'book.status', 'book.chapterCount', 'book.totalChars', 'book.lastModified', 'query', 'state.shelfGroup']) {
    assert.ok(signature.includes(field), `渲染签名必须包含 ${field}（否则该字段变了卡片不刷新）`);
  }
  assert.ok(signature.includes('chapterHits'), '章节命中行也要进签名（搜索命中的章名会变）');
});
