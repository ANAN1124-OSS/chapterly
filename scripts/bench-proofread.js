#!/usr/bin/env node
'use strict';
// WP12（审计 B5/B6/B7/B8）校对收敛基准：四个纯 CPU 热点的改前 / 改后墙钟与内存。
//
// 为什么单独一个文件：`scripts/bench.js` 是真实 Electron 基准（打开书 / 切章 / 书架渲染），
// 量不到这里的纯函数（校对 / 敏感词 / 排版判定都不读盘、不进渲染层）；与
// `scripts/bench-capture.js`（WP11）、`scripts/bench-index-deep.js`（WP10）同一约定：
//   * 只读产品代码、零外部依赖、纯 Node；
//   * 不碰真实书库、不读配置 —— 全部输入在内存里现造；
//   * 每项预热 1 次再取 N 次样本，报告 min / 中位 / 全部样本；
//   * JSON 落点可选（默认只打表格）。
//
// 内存怎么量（不猜）：`--expose-gc` 下先 gc 再取 heapUsed，调用后立即再取一次（未强制 GC，
// 含尚未回收的分配）——这是「分配足迹」的 proxy，不是精确峰值；更硬的口径是子进程堆上限：
// 用 `--max-old-space-size=<cap>` 跑同一条 100 万字 repeat-word，找出**最小可完成堆上限**，
// 改前 / 改后各扫一次（OOM 的 cap 会记 false）。两种口径都写进 JSON。
//
// 用法：
//   node --expose-gc scripts/bench-proofread.js                  # 默认每项 3 次样本
//   node --expose-gc scripts/bench-proofread.js --runs=5
//   node --expose-gc scripts/bench-proofread.js --label=before --out=_audit-.../wp12-bench-before.json
//   node scripts/bench-proofread.js --no-heap-caps               # 跳过子进程堆上限扫描

const fsp = require('node:fs/promises');
const { spawnSync } = require('node:child_process');

const formatLib = require('../core/format');
const proofreadLib = require('../core/proofread');
const sensitiveLib = require('../core/sensitive');

const CHILD_FLAG = '--child-repeat-word';
const DEFAULTS = { runs: 3, out: null, label: '', heapCaps: true };

const RULES_OFF = {};
for (const rule of proofreadLib.RULE_ORDER) RULES_OFF[rule] = false;

function argValue(argv, name, fallback) {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  if (!hit) return fallback;
  const value = Number(hit.slice(prefix.length));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function stringArg(argv, name, fallback) {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

// 稳定伪随机（mulberry32）：同一 seed 在改前 / 改后两次运行里造出逐字节相同的夹具。
function makeWide(n, seedInit) {
  const out = [];
  let seed = seedInit >>> 0;
  for (let i = 0; i < n; i += 1) {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    out.push(String.fromCharCode(0x4e00 + Math.floor(r * 20000)));
    if (i % 40 === 39) out.push('，');
  }
  return out.join('');
}

// 单章 3000 字 / 600 处半角逗号（校对规则①命中；默认选项下另有超长段落与重复用词命中）。
function halfwidthChapter() {
  return '他说,好。'.repeat(600);
}

// 单章 3000 字 / 500 处「色情」（敏感词命中；不重叠）。
function sensitiveChapter() {
  return ('色情' + '正文'.repeat(2)).repeat(500);
}

// 真实章节：50 段 × 约 60 字（含标点），总约 3100 字。
function realisticChapter() {
  return Array.from({ length: 50 }, () => makeWide(60, 7)).join('\n');
}

function measureMs(runOnce) {
  const startedAt = process.hrtime.bigint();
  runOnce();
  return round(Number(process.hrtime.bigint() - startedAt) / 1e6);
}

function sample(name, runOnce, runs, note) {
  measureMs(runOnce); // 预热一次：JIT / 字符串驻留不算进报告
  const samples = [];
  for (let i = 0; i < runs; i += 1) samples.push(measureMs(runOnce));
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    name,
    runs,
    note: note || '',
    samples,
    minMs: sorted[0],
    medianMs: sorted[Math.floor(sorted.length / 2)]
  };
}

// 分配足迹 proxy：强制 GC 后取 heapUsed，调用返回后立即再取（含尚未回收的分配）。
function heapFootprint(runOnce) {
  const gc = typeof global.gc === 'function' ? global.gc : null;
  if (gc) gc();
  const before = process.memoryUsage().heapUsed;
  runOnce();
  const after = process.memoryUsage().heapUsed;
  const mb = round((after - before) / 1048576);
  if (gc) gc();
  return { heapDeltaMb: mb, exact: Boolean(gc) };
}

// 子进程堆上限扫描：同一份 100 万字 repeat-word 夹具，找最小可完成 --max-old-space-size。
function scanHeapCaps() {
  const caps = [512, 384, 320, 256, 192, 160, 128, 112, 96, 80, 64];
  const attempts = [];
  let minCapMb = null;
  for (const cap of caps) {
    const result = spawnSync(process.execPath, [`--max-old-space-size=${cap}`, __filename, CHILD_FLAG], {
      timeout: 180000,
      encoding: 'utf8'
    });
    const ok = result.status === 0;
    attempts.push({ capMb: cap, ok, status: result.status, signal: result.signal || null });
    if (ok) minCapMb = cap; // caps 从大到小扫，最后一次成功就是最小可完成上限
  }
  return { minCapMb, attempts };
}

function runChildRepeatWord() {
  const wide = makeWide(1000000, 42);
  const result = proofreadLib.proofreadText(wide, { rules: { ...RULES_OFF, 'repeat-word': true } });
  process.stdout.write(`repeat-word child ok byRule=${result.byRule['repeat-word']}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes(CHILD_FLAG)) {
    runChildRepeatWord();
    return;
  }
  const runs = argValue(argv, 'runs', DEFAULTS.runs);
  const label = stringArg(argv, 'label', DEFAULTS.label);
  const out = stringArg(argv, 'out', DEFAULTS.out);
  const heapCaps = argv.includes('--no-heap-caps') ? false : DEFAULTS.heapCaps;

  const sensitiveText = sensitiveChapter();
  const halfwidthText = halfwidthChapter();
  const realistic = realisticChapter();
  const pathological = '１a'.repeat(500000); // 100 万字符 / 50 万全角数字命中
  const heavyPunct = '他说,好。中文:测试!'.repeat(83333); // 约 100 万字符 / 转换密集单段
  const wide1m = makeWide(1000000, 42);
  const words = ['色情', '暴力'];
  const fullwidthOnly = { rules: { ...RULES_OFF, 'fullwidth-digit': true } };
  const repeatOnly = { rules: { ...RULES_OFF, 'repeat-word': true } };

  const items = [];
  const heaps = [];

  // ---------- 1/2. B5：整本预算用尽后的单章成本（敏感词 / 校对） ----------
  items.push(
    sample(
      '[B5] sensitive.scanText 单章 3000 字 / 500 命中 · 现状 maxIssues:500',
      () => sensitiveLib.scanText(sensitiveText, words, { maxIssues: 500 }),
      runs,
      '整本前几章（明细还要）的分支'
    )
  );
  items.push(
    sample(
      '[B5] sensitive.scanText 同章 · 饱和分支 maxIssues:20 + details:false',
      () => sensitiveLib.scanText(sensitiveText, words, { maxIssues: 20, details: false }),
      runs,
      '预算用尽后只计数；改前该键被忽略'
    )
  );
  items.push(
    sample(
      '[B5] proofreadText 单章 3000 字 / 600 半角命中 · 现状默认（拼片段 + 建明细）',
      () => proofreadLib.proofreadText(halfwidthText, {}),
      runs,
      '整本前几章的分支'
    )
  );
  items.push(
    sample(
      '[B5] proofreadText 同章 · 饱和分支 maxIssues:20 + snippets:false',
      () => proofreadLib.proofreadText(halfwidthText, { maxIssues: 20, snippets: false }),
      runs,
      '预算用尽后每章只建下限明细'
    )
  );

  // ---------- 3. B6：⑦⑧⑨ 病态命中的物化成本 ----------
  items.push(
    sample(
      '[B6] proofreadText ⑦⑧⑨ 100 万字符 / 50 万全角数字命中',
      () => proofreadLib.proofreadText(pathological, fullwidthOnly),
      runs,
      '改前先建 50 万个 {index,length,run} 再丢弃'
    )
  );
  heaps.push({
    name: '[B6] 同上（分配足迹）',
    ...heapFootprint(() => proofreadLib.proofreadText(pathological, fullwidthOnly))
  });

  // ---------- 4. B7：convertPunct 整段副本 vs 报告-only ----------
  items.push(
    sample(
      '[B7] convertPunct 100 万单段 · 默认（逐字 push + join 整段副本）',
      () => formatLib.convertPunct(heavyPunct, () => {}),
      runs,
      '校对规则①只取回调报告'
    )
  );
  items.push(
    sample(
      '[B7] convertPunct 100 万单段 · reportOnly（不产正文）',
      () => formatLib.convertPunct(heavyPunct, () => {}, { reportOnly: true }),
      runs,
      '改前该分支不存在（options 被忽略）'
    )
  );
  heaps.push({
    name: '[B7] convertPunct 100 万单段默认（分配足迹）',
    ...heapFootprint(() => formatLib.convertPunct(heavyPunct, () => {}))
  });

  // ---------- 5. B8：repeat-word 两遍法 ----------
  items.push(
    sample(
      '[B8] proofreadText repeat-word 100 万单段（二元组高度分散）',
      () => proofreadLib.proofreadText(wide1m, repeatOnly),
      runs,
      '改前为每个二元组建一个起点数组'
    )
  );
  heaps.push({
    name: '[B8] 同上（分配足迹）',
    ...heapFootprint(() => proofreadLib.proofreadText(wide1m, repeatOnly))
  });

  // ---------- 6. 常见路径回归（防优化把短段落拖慢） ----------
  items.push(
    sample(
      '[回归] proofreadText 真实章节（50 段 / 约 3100 字）· repeat-word',
      () => proofreadLib.proofreadText(realistic, repeatOnly),
      runs,
      '常见路径：两遍扫描的开销必须落在噪声里'
    )
  );

  // ---------- 7. 子进程堆上限 ----------
  const heapCapScan = heapCaps ? scanHeapCaps() : null;

  // ---------- 输出 ----------
  const perChapterMs = (item) => item.medianMs;
  const byName = new Map(items.map((item) => [item.name, item]));
  const extrapolate = (name) => round(perChapterMs(byName.get(name)) * 1000);

  console.log(`WP12 bench${label ? ` (${label})` : ''} · Node ${process.version} · runs=${runs}`);
  for (const item of items) {
    console.log(
      `  ${item.name}\n    min ${item.minMs} ms · median ${item.medianMs} ms · samples [${item.samples.join(', ')}]`
    );
  }
  console.log('  外推 1000 章（只乘单章中位，整本还有别的一次性成本，不当总耗时）：');
  console.log(
    `    敏感词 现状 ${extrapolate('[B5] sensitive.scanText 单章 3000 字 / 500 命中 · 现状 maxIssues:500')} ms → ` +
      `饱和分支 ${extrapolate('[B5] sensitive.scanText 同章 · 饱和分支 maxIssues:20 + details:false')} ms`
  );
  console.log(
    `    校对   现状 ${extrapolate('[B5] proofreadText 单章 3000 字 / 600 半角命中 · 现状默认（拼片段 + 建明细）')} ms → ` +
      `饱和分支 ${extrapolate('[B5] proofreadText 同章 · 饱和分支 maxIssues:20 + snippets:false')} ms`
  );
  for (const heap of heaps) console.log(`  ${heap.name}\n    heap delta ${heap.heapDeltaMb} MB（exact=${heap.exact}）`);
  if (heapCapScan) {
    console.log(`  100 万字 repeat-word 最小可完成堆上限：${heapCapScan.minCapMb ?? '无（512MB 也失败）'} MB`);
    for (const attempt of heapCapScan.attempts) {
      console.log(`    cap ${attempt.capMb} MB → ${attempt.ok ? 'ok' : `fail(status ${attempt.status})`}`);
    }
  }

  if (out) {
    const payload = {
      label,
      node: process.version,
      runs,
      generatedAt: new Date().toISOString(),
      items,
      heaps,
      heapCaps: heapCapScan
    };
    const target = require('node:path').resolve(process.cwd(), out);
    await fsp.mkdir(require('node:path').dirname(target), { recursive: true });
    await fsp.writeFile(target, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`JSON 已写入 ${out}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});