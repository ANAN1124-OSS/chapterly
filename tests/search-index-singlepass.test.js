'use strict';
// P3（V5 搜索单遍）· 等价夹具与遍数锚点。
// 断言口径：core/search-index.js 的「每章计数」与「每章最多 3 条片段」合并成一遍扫描后，
// 对外输出（计数 / 片段文本 / index / truncated / 预算字段）必须与改前逐字一致。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  BIG_MARKER,
  mkTmp,
  collectSnapshot,
  makeStoreAndBooks
} = require('./fixtures/search-singlepass-corpus');

const FIXTURE = path.join(__dirname, 'fixtures', 'search-singlepass.expect.json');

test('搜索单遍（P3）：等价夹具 —— 大章 / 计数上限 / 跨行大小写 / 空查询 / limit / focus 逐字一致', async () => {
  const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const base = await mkTmp();
  const actual = await collectSnapshot(base);
  assert.deepEqual(actual, expected);
});

// 遍数注入：把 String.prototype.indexOf / toLowerCase 临时包一层，
// 只统计「本章正文（以独一无二的 marker 开头）」上的调用。
// 一遍扫描的定义：同一个 haystack 上，indexOf 以 from=0 起算只允许出现 1 次。
test('搜索单遍（P3）：同一章正文的扫描遍数 ≤ 1（indexOf 从 0 起算注入计数）', async () => {
  const base = await mkTmp();
  const { store, booksRoot } = await makeStoreAndBooks(base);

  // 先把索引建起来（建索引本身要把正文小写一遍算双字位图），
  // 再装注入计数器，这样统计到的只是 'search' 里的扫描遍数。
  await store.search({ booksRoot, query: '雪落', limit: 40 });

  const originalIndexOf = String.prototype.indexOf;
  const originalToLowerCase = String.prototype.toLowerCase;
  let scanPasses = 0;
  let lowerPasses = 0;
  const isChapterHaystack = (value) => typeof value === 'string' && value.startsWith(BIG_MARKER);

  String.prototype.indexOf = function patchedIndexOf(search, from) {
    if (isChapterHaystack(this) && !from) scanPasses += 1;
    return arguments.length > 1
      ? originalIndexOf.call(this, search, from)
      : originalIndexOf.call(this, search);
  };
  String.prototype.toLowerCase = function patchedToLowerCase() {
    const lowered = originalToLowerCase.call(this);
    if (isChapterHaystack(lowered)) lowerPasses += 1;
    return lowered;
  };

  let found;
  try {
    found = await store.search({ booksRoot, query: '雪落', limit: 40 });
  } finally {
    String.prototype.indexOf = originalIndexOf;
    String.prototype.toLowerCase = originalToLowerCase;
  }

  assert.equal(found.results.length, 3, '大章仍只列 3 条片段');
  assert.equal(found.totalMatches, 6000, '大章仍数出 6000 处命中');
  assert.equal(found.truncated, false);
  assert.ok(lowerPasses <= 1, `大章正文小写归一化只允许 1 遍，实际 ${lowerPasses}`);
  assert.ok(scanPasses <= 1, `大章正文扫描只允许 1 遍，实际 ${scanPasses} 遍（计数 1 遍 + 片段 1 遍 = 旧实现 2 遍）`);
});

test('搜索单遍（P3）：时间预算用尽时照旧带上已有片段 + truncated（不挂起、不丢计数）', async () => {
  const base = await mkTmp();
  const { store, booksRoot } = await makeStoreAndBooks(base);
  const found = await store.search({ booksRoot, query: '雪落', limit: 40, timeBudgetMs: 1 });

  assert.equal(found.truncated, true, '预算用尽 → truncated');
  assert.equal(found.results.length, 3, '预算用尽前已采到的 3 条片段照旧返回');
  const first = found.results[0].chapterMatchCount;
  for (const row of found.results) assert.equal(row.chapterMatchCount, first);
  assert.equal(found.totalMatches, first, 'totalMatches 用同一份部分计数');
  assert.equal(found.results[0].chapterCountCapped, true, '部分计数一律标 N+');
  assert.ok(first >= 1024 && first <= 6000, `部分计数应停在 1024 的整数倍上，实际 ${first}`);
});
