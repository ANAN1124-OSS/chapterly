// B1（审计 P0-2）：core/wordscan.js 的单次扫描（Aho-Corasick）。
//
// 关键不是「能扫到」，而是「和旧实现同输入同输出」。这里留一份旧实现（逐词 indexOf + 排序 + lastEnd 去重）
// 作为参照，用固定种子的随机语料做同输出比对；再补边界：重叠取最长、同词重叠、空输入、超长词、
// RAW_MATCH_LIMIT 截断。
const test = require('node:test');
const assert = require('node:assert/strict');
const wordscan = require('../core/wordscan');
const glossary = require('../core/glossary');
const sensitive = require('../core/sensitive');

// 旧实现（B1 之前的 core/glossary.js findHits / core/sensitive.js scanText 的扫描段），
// 只用来做等价性参照，不进产品代码。
function referenceScan(text, terms, rawMatchLimit = 100000) {
  const raw = [];
  let limitHit = false;
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const index = text.indexOf(term, from);
      if (index < 0) break;
      if (raw.length >= rawMatchLimit) {
        limitHit = true;
        break;
      }
      raw.push({ term, index });
      from = index + 1;
    }
    if (limitHit) break;
  }
  raw.sort(
    (a, b) =>
      a.index - b.index ||
      b.term.length - a.term.length ||
      (a.term < b.term ? -1 : a.term > b.term ? 1 : 0)
  );
  const hits = [];
  let lastEnd = -1;
  for (const hit of raw) {
    if (hit.index < lastEnd) continue;
    hits.push({ term: hit.term, index: hit.index, length: hit.term.length });
    lastEnd = hit.index + hit.term.length;
  }
  return { hits, truncated: limitHit };
}

function scanForCompare(text, terms, rawMatchLimit) {
  const result = wordscan.scanTerms(text, terms, { rawMatchLimit });
  return {
    hits: result.hits.map((hit) => ({
      term: terms[hit.patternIndex],
      index: hit.index,
      length: hit.length
    })),
    truncated: result.truncated
  };
}

// 固定种子的 LCG：测试必须可复现，不要用 Math.random
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test('与旧实现同输入同输出：固定种子的随机语料（重叠 / 相邻 / 大小写 / 中文）', () => {
  const alphabet = ['a', 'b', 'c', 'A', '色', '情', '小', '说', '的', '了'];
  const random = makeRandom(20261105);
  for (let round = 0; round < 300; round += 1) {
    let text = '';
    const textLength = Math.floor(random() * 60);
    for (let i = 0; i < textLength; i += 1) {
      text += alphabet[Math.floor(random() * alphabet.length)];
    }
    const terms = [];
    const seen = new Set();
    const termCount = 1 + Math.floor(random() * 6);
    for (let i = 0; i < termCount; i += 1) {
      let term = '';
      const termLength = 1 + Math.floor(random() * 3);
      for (let k = 0; k < termLength; k += 1) {
        term += alphabet[Math.floor(random() * alphabet.length)];
      }
      if (!seen.has(term)) {
        seen.add(term);
        terms.push(term);
      }
    }
    const expected = referenceScan(text, terms);
    const actual = scanForCompare(text, terms);
    assert.deepEqual(actual, expected, `第 ${round} 轮不一致：text=${JSON.stringify(text)} terms=${JSON.stringify(terms)}`);
  }
});

test('重叠取最长：同一个起点有长有短、相邻命中照常各报、同一个词相邻不合并', () => {
  const cases = [
    // 旧实现注释里的原始例子
    ['他说做为见证人，做为观众。', ['做为', '做', '观众'], [['做为', 2, 2], ['做为', 8, 2], ['观众', 10, 2]]],
    ['这是色情小说。', ['色情', '色情小说'], [['色情小说', 2, 4]]],
    ['色情和色情小说', ['色情', '色情小说'], [['色情', 0, 2], ['色情小说', 3, 4]]],
    ['色情色情', ['色情'], [['色情', 0, 2], ['色情', 2, 2]]],
    ['哈哈哈', ['哈哈'], [['哈哈', 0, 2]]],
    ['aaaa', ['aa'], [['aa', 0, 2], ['aa', 2, 2]]],
    ['abcabc', ['abc'], [['abc', 0, 3], ['abc', 3, 3]]],
    // 前缀 / 后缀共享的自动机最容易错：ab / bab / abc / bc
    ['ababc', ['ab', 'bab', 'abc', 'bc'], [['ab', 0, 2], ['abc', 2, 3]]],
    ['xxbababc', ['ab', 'bab', 'abc', 'bc'], [['bab', 2, 3], ['abc', 5, 3]]]
  ];
  for (const [text, terms, expectedPairs] of cases) {
    const actual = scanForCompare(text, terms);
    assert.deepEqual(
      actual.hits.map((hit) => [hit.term, hit.index, hit.length]),
      expectedPairs,
      `text=${JSON.stringify(text)}`
    );
    assert.equal(actual.truncated, false);
    // 与产品入口的结果一致（术语映射没丢 suggestion / word）
    const glossaryHits = glossary.findHits(text, terms.map((term) => ({ term, suggestion: `${term}-建议` })));
    assert.deepEqual(
      glossaryHits.hits.map((hit) => [hit.term, hit.index, hit.length]),
      expectedPairs
    );
    assert.equal(glossaryHits.hits.every((hit) => hit.suggestion === `${hit.term}-建议`), true);
    assert.equal(sensitive.scanText(text, terms).total, expectedPairs.length);
  }
});

test('边界：空词表 / 空正文 / 超长词（100 字）/ 非字符串参数', () => {
  assert.deepEqual(wordscan.scanTerms('正文', []), { hits: [], rawCount: 0, truncated: false });
  assert.deepEqual(wordscan.scanTerms('正文', null), { hits: [], rawCount: 0, truncated: false });
  assert.deepEqual(wordscan.scanTerms('', ['正']), { hits: [], rawCount: 0, truncated: false });
  assert.deepEqual(wordscan.scanTerms(null, ['正']), { hits: [], rawCount: 0, truncated: false });
  // 词表里的空串 / 非字符串要跳过（不能变成「每个位置都命中」）
  const dirty = wordscan.scanTerms('abc', ['', null, 'abc', 5, 'a']);
  assert.deepEqual(dirty.hits.map((hit) => [hit.patternIndex, hit.index, hit.length]), [[2, 0, 3]]);
  // 100 字的上限词（词表层已经限制单行 100 字）也能正常命中
  const long = '长'.repeat(100);
  const longHit = wordscan.scanTerms(`x${long}y`, [long]);
  assert.deepEqual(longHit.hits, [{ patternIndex: 0, index: 1, length: 100 }]);
  // 词比正文长
  assert.deepEqual(wordscan.scanTerms('ab', ['abc']).hits, []);
});

test('RAW_MATCH_LIMIT：原始命中数到上限就停，truncated=true，保留靠前的命中', () => {
  // 单字高频：正文 20 万个 a、词表只有 a → 收 100000 条（上限）后停
  const limit = wordscan.DEFAULT_RAW_MATCH_LIMIT;
  const big = 'a'.repeat(limit * 2);
  const result = wordscan.scanTerms(big, ['a']);
  assert.equal(result.truncated, true);
  assert.equal(result.rawCount, limit);
  assert.equal(result.hits.length, limit);
  assert.equal(result.hits[0].index, 0);
  assert.equal(result.hits[result.hits.length - 1].index, limit - 1, '保留的是最靠前的命中（与旧实现的词表顺序口径不同，见模块头注释）');

  // 自定义上限：aa 重叠命中，rawCount 到上限就停；去重后只剩不重叠的那几条
  const capped = wordscan.scanTerms('aaaaa', ['aa'], { rawMatchLimit: 3 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.rawCount, 3);
  assert.deepEqual(capped.hits.map((hit) => hit.index), [0, 2]);

  // 上限没到就不标 truncated
  const below = wordscan.scanTerms('aaaaa', ['aa'], { rawMatchLimit: 100 });
  assert.equal(below.truncated, false);
  assert.deepEqual(below.hits.map((hit) => hit.index), [0, 2]);
});

test('产品入口的 truncated 仍与旧口径一致（单字高频 × 敏感词 / 校对）', () => {
  const limit = sensitive.RAW_MATCH_LIMIT;
  const text = '禁'.repeat(limit + 5);
  const sensitiveResult = sensitive.scanText(text, ['禁']);
  assert.equal(sensitiveResult.truncated, true);
  assert.equal(sensitiveResult.total, limit);
  const glossaryResult = glossary.findHits(text, [{ term: '禁', suggestion: '改' }]);
  assert.equal(glossaryResult.truncated, true);
  assert.equal(glossaryResult.hits.length, limit);
  assert.equal(glossaryResult.hits[0].suggestion, '改');
});

// A4 / P-03（审计：整本预检 / 校对是「每章建一次图」——1000 章 × 5000 词 = 1000 次建图）：
// 按词表内容（+ 顺序）缓存自动机，同一词表连续扫多章只建图一次；缓存有上限，不能无限长大。
test('词表扫描（P-03）：1000 章 × 同一词表只建图 1 次', () => {
  wordscan.resetAutomatonCache();
  const terms = Array.from({ length: 800 }, (_, i) => `词${i}`);
  const chapter = `风从海面吹来。${'正文里有词3、词57、词799。'.repeat(3)}`;
  for (let i = 0; i < 1000; i += 1) {
    wordscan.scanTerms(chapter, terms);
  }
  const stats = wordscan.automatonCacheStats();
  assert.equal(stats.builds, 1, `同一词表 1000 章只该建图 1 次，实际 ${stats.builds} 次`);
  assert.equal(stats.hits, 999, `其余 999 次都该命中缓存，实际 ${stats.hits} 次`);
  assert.equal(stats.size, 1);
});

test('词表扫描（P-03）：词表内容 / 顺序不同各自成图，缓存有上限且不串索引', () => {
  wordscan.resetAutomatonCache();
  const a = ['甲', '甲乙'];
  const b = ['甲乙'];
  // 顺序不同 → patternIndex 不能串（a 的 0 是「甲」、b 的 0 是「甲乙」）
  const first = wordscan.scanTerms('甲乙', a);
  assert.deepEqual(
    first.hits.map((hit) => [a[hit.patternIndex], hit.index, hit.length]),
    [['甲乙', 0, 2]]
  );
  const second = wordscan.scanTerms('甲乙', b);
  assert.deepEqual(
    second.hits.map((hit) => [b[hit.patternIndex], hit.index, hit.length]),
    [['甲乙', 0, 2]]
  );
  assert.equal(wordscan.automatonCacheStats().builds, 2, '词表内容不同必须重新建图');

  // 上限：超过缓存容量后最早的被淘汰，重新用时要再建一次（内存有界）
  const extra = Array.from({ length: 8 }, (_, i) => [`词表${i}`, `甲${i}`, `乙${i}`]);
  for (const terms of extra) wordscan.scanTerms('甲', terms);
  const capped = wordscan.automatonCacheStats();
  assert.ok(capped.size <= 4, `缓存容量必须有上限（≤4），实际 ${capped.size}`);
  assert.equal(capped.builds, 10);
  wordscan.scanTerms('甲乙', a);
  assert.equal(wordscan.automatonCacheStats().builds, 11, '被淘汰的词表要能重建（不是永久失效）');

  // 空词表 / 脏输入不能把缓存搞坏
  wordscan.resetAutomatonCache();
  assert.deepEqual(wordscan.scanTerms('正文', []), { hits: [], rawCount: 0, truncated: false });
  assert.deepEqual(wordscan.scanTerms('正文', null), { hits: [], rawCount: 0, truncated: false });
  assert.equal(wordscan.automatonCacheStats().builds, 1);
});
