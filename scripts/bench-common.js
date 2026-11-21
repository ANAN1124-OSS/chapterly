'use strict';
// 纯 Node 基准（bench-capture / bench-proofread / bench-index-deep / bench-chapters）的公共件。
//
// TOOL-B03（审计）：这几个脚本随各自审计轮次先后起草，argValue / stringArg / round /
// measureMs / sample 五件套被逐字节复制了四份。更要紧的是口径已经漂移——bench.js 的中位数
// 在偶数样本时取两中位平均，bench-capture / bench-proofread 取上中位，--runs=2/4 时两族
// 数字不可比。这里把采样与统计收成一份代码：改前 / 改后两次运行用的是同一份计时、同一份
// 中位数口径，「同一台机器、同一份夹具」的承诺由代码保证，而不是靠维护者自觉。
//
// 边界：零依赖、不读盘、不联网；只被 scripts/ 下的开发基准 require，不进安装包。

// `--name=123`：正整数（>0）才算有效，坏值 / 缺省回落到 fallback。
function argValue(argv, name, fallback) {
  const prefix = `--${name}=`;
  const hit = (Array.isArray(argv) ? argv : []).find((arg) => arg.startsWith(prefix));
  if (!hit) return fallback;
  const value = Number(hit.slice(prefix.length));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

// `--name=文本`：只取原样字符串，不做数字转换。
function stringArg(argv, name, fallback) {
  const prefix = `--${name}=`;
  const hit = (Array.isArray(argv) ? argv : []).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

// 报告里的毫秒保留两位小数（噪声远大于 0.01 ms，再多的位数只是假精度）。
function round(value) {
  return Math.round(value * 100) / 100;
}

// 跑一次取墙钟毫秒（只包被测调用，夹具在采样前造好）。
function measureMs(runOnce) {
  const startedAt = process.hrtime.bigint();
  runOnce();
  return round(Number(process.hrtime.bigint() - startedAt) / 1e6);
}

// 中位数：与 scripts/bench.js 的 summarize 同口径——奇数取中间，偶数取两中位平均。
function median(samples) {
  const list = (Array.isArray(samples) ? samples : [])
    .filter((value) => Number.isFinite(value))
    .slice()
    .sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return round(list.length % 2 === 1 ? list[mid] : (list[mid - 1] + list[mid]) / 2);
}

// 预热 1 次（JIT / 字符串驻留不进报告）→ 取 runs 次样本。
function sample(name, runOnce, runs, note) {
  measureMs(runOnce);
  const samples = [];
  for (let i = 0; i < runs; i += 1) samples.push(measureMs(runOnce));
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    name,
    runs,
    note: note || '',
    samples,
    minMs: sorted[0],
    medianMs: median(samples)
  };
}

// 自适应闸跳过的项：保留一行占位，报告里能看出「没跑」而不是「跑了 0 ms」。
function skipped(name, note) {
  return { name, runs: 0, note, samples: [], minMs: null, medianMs: null, skipped: true };
}

module.exports = { argValue, stringArg, round, measureMs, median, sample, skipped };
