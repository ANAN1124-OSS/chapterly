// B1（审计 P0-2）基准：词表扫描「旧实现（逐词 indexOf）」vs「新实现（Aho-Corasick 单次扫描）」。
//
// 不进安装包（scripts/ 只在仓库里手动跑）：node scripts/bench-wordscan.js
//
// 词表按上限造（5000 词 / 常用中文字 2–4 字），正文是汉字混排。
// 旧实现是 O(词数 × 正文)，所以只跑 10 万 / 50 万字的量级（500 万字要 19–20 秒，见终审版实测）；
// 新实现另跑一遍 500 万字，用来证明整本规模也在可接受范围内。
const wordscan = require('../core/wordscan');

// 旧实现（B1 之前的 findHits / scanText 扫描段），只用于对比耗时
function referenceScan(text, terms) {
  const raw = [];
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const index = text.indexOf(term, from);
      if (index < 0) break;
      raw.push({ term, index });
      if (raw.length >= 100000) return { raw, truncated: true };
      from = index + 1;
    }
  }
  return { raw, truncated: false };
}

function buildText(length, seed = 12345) {
  // 常用汉字池 + 固定 LCG（可复现，不用 Math.random）
  const pool = '的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感';
  const chars = pool.length;
  let state = seed >>> 0;
  let out = '';
  const chunk = [];
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    chunk.push(pool[state % chars]);
    if (chunk.length === 4096) {
      out += chunk.join('');
      chunk.length = 0;
    }
  }
  return out + chunk.join('');
}

function buildTerms(count, seed = 777) {
  const pool = '的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得';
  const chars = pool.length;
  let state = seed >>> 0;
  const terms = [];
  const seen = new Set();
  while (terms.length < count) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const length = 2 + (state % 3);
    let term = '';
    for (let k = 0; k < length; k += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      term += pool[state % chars];
    }
    if (!seen.has(term)) {
      seen.add(term);
      terms.push(term);
    }
  }
  return terms;
}

// 「几乎零命中」场景：正文是拉丁字母，词表是汉字（整本检查里最常见的形态——
// 词表 5000 个词、正文里大部分都不出现，旧实现要把 5000 个词各扫一遍全篇，最费时间）
function buildLatinText(length, seed = 999) {
  let state = seed >>> 0;
  const chunk = [];
  let out = '';
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    chunk.push(String.fromCharCode(97 + (state % 26)));
    if (chunk.length === 4096) {
      out += chunk.join('');
      chunk.length = 0;
    }
  }
  return out + chunk.join('');
}

function timeIt(fn) {
  const start = process.hrtime.bigint();
  const result = fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { ms, result };
}

function printTable(title, rows) {
  console.log(`\n== ${title} ==`);
  console.log('正文长度    旧实现(逐词 indexOf)   新实现(Aho-Corasick)   加速       命中/原始/截断');
  for (const row of rows) {
    const oldText = row.oldMs == null ? '未跑（太慢）' : `${row.oldMs.toFixed(0)} ms`;
    const speed = row.speedup == null ? '-' : `${row.speedup.toFixed(1)}×`;
    console.log(
      `${String(row.chars).padStart(7)}  ${oldText.padStart(19)}  ${(`${row.newMs.toFixed(1)} ms`).padStart(18)}  ${speed.padStart(6)}  ${row.hits}/${row.rawCount}/${row.truncated}`
    );
  }
}

const WORDS = 5000;

// 场景 1：命中密集（词表全是从正文用字里抽的）——两个实现都会被 RAW_MATCH_LIMIT 提前截断，
// 5M 那一档其实没扫完（看 truncated=true），所以旧实现不跑 5M。
const denseTerms = buildTerms(WORDS);
const denseRows = [];
for (const chars of [100000, 500000, 5000000]) {
  const text = buildText(chars);
  const old = chars <= 500000 ? timeIt(() => referenceScan(text, denseTerms)) : null;
  const neo = timeIt(() => wordscan.scanTerms(text, denseTerms));
  denseRows.push({
    chars,
    oldMs: old ? old.ms : null,
    newMs: neo.ms,
    speedup: old ? old.ms / neo.ms : null,
    hits: neo.result.hits.length,
    rawCount: neo.result.rawCount,
    truncated: neo.result.truncated
  });
}

// 场景 2：几乎零命中（整本检查的最坏情况，不被 RAW_MATCH_LIMIT 提前结束）
const sparseTerms = buildTerms(WORDS, 424242);
const sparseRows = [];
for (const chars of [100000, 500000, 5000000]) {
  const text = buildLatinText(chars);
  const old = chars <= 500000 ? timeIt(() => referenceScan(text, sparseTerms)) : null;
  const neo = timeIt(() => wordscan.scanTerms(text, sparseTerms));
  sparseRows.push({
    chars,
    oldMs: old ? old.ms : null,
    newMs: neo.ms,
    speedup: old ? old.ms / neo.ms : null,
    hits: neo.result.hits.length,
    rawCount: neo.result.rawCount,
    truncated: neo.result.truncated
  });
}

console.log(`词表 ${WORDS} 个词（单行 2–3 字）`);
printTable('命中密集（两个实现都会被上限截断；旧实现不跑 5M）', denseRows);
printTable('几乎零命中（整本检查最坏情况：5000 个词各扫一遍全篇）', sparseRows);

