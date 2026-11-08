// C0（审计 #3 / E1）：保存热路径上 4 项派生失败必须留痕，且仍然绝不阻塞保存。
//
// 背景：正文原子落盘成功之后才轮到这些派生数据——①旧章字数基线（读不到 → 当天增量按 0）、
// ②每日快照、③搜索索引标脏、④每日统计。任何一项失败都不能把「正文已保存」改判成保存失败
// （否则作者会以为白写了），但改动前这 4 处是零日志零提示，正文与字数 / 快照 / 索引 / 统计
// 长期不一致也查不到原因。
//
// 现在：4 个 catch 统一记一条 warn 日志（固定错误码）；字数基线缺失时保存结果带
// `charsBaselineMissing`，渲染层在「已保存」旁弱提示「本次字数未计入」。
//
// 这里覆盖两件可独立验证的事：
//   1. 纯逻辑（真实执行）：`saveCharsDelta` 的标记 / 增量口径，`recordSaveChars` 把统计 store
//      的失败收成结果、绝不重抛；
//   2. 静态闸门：主进程 4 个 catch 的日志调用与保存结果字段、渲染层消费标记。真实保存链路
//      （含「统计写盘失败仍保存成功」）由 E2E 第 3 / 43 / 44 组端到端覆盖。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const statsLib = require('../core/stats');
const saveLogic = require('../renderer/save-logic');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const MAIN = read('main.js');
const RENDERER = read('renderer/renderer.js');

function between(source, from, to) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `找不到：${from}`);
  const end = source.indexOf(to, start + from.length);
  assert.ok(end > start, `找不到结尾：${to}`);
  return source.slice(start, end);
}

test('保存字数增量：基线读不到 → 明确标记「本次未计入」，增量按 0 记', () => {
  assert.deepEqual(statsLib.saveCharsDelta(null, 120), { baselineMissing: true, delta: 0 });
  assert.deepEqual(statsLib.saveCharsDelta(undefined, 120), { baselineMissing: true, delta: 0 });
  assert.deepEqual(statsLib.saveCharsDelta('', 120), { baselineMissing: true, delta: 0 });
  assert.deepEqual(statsLib.saveCharsDelta('坏值', 120), { baselineMissing: true, delta: 0 });
});

test('保存字数增量：基线正常时只记正增量，删字 / 没变都不倒扣', () => {
  assert.deepEqual(statsLib.saveCharsDelta(100, 140), { baselineMissing: false, delta: 40 });
  assert.deepEqual(statsLib.saveCharsDelta('100', 120), { baselineMissing: false, delta: 20 });
  assert.deepEqual(statsLib.saveCharsDelta(100, 100), { baselineMissing: false, delta: 0 });
  assert.deepEqual(statsLib.saveCharsDelta(140, 100), { baselineMissing: false, delta: 0 });
  assert.deepEqual(statsLib.saveCharsDelta(0, 8), { baselineMissing: false, delta: 8 });
  assert.deepEqual(statsLib.saveCharsDelta(100, Number.NaN), { baselineMissing: false, delta: 0 });
});

test('统计写盘失败不阻塞保存：recordSaveChars 把拒绝收成结果，原样返回成功结果', async () => {
  const boom = Object.assign(new Error('stats.json 写不进去'), { code: 'EACCES' });
  const failing = {
    record: async () => {
      throw boom;
    }
  };
  const failed = await statsLib.recordSaveChars(failing, { day: '2026-11-08', bookId: 'b1', delta: 12 });
  assert.equal(failed.ok, false, '统计失败返回 ok:false 而不是抛错（主进程继续走保存成功路径）');
  assert.equal(failed.error, boom, '原始错误要留给主进程记 warn 日志');

  const okStore = {
    record: async (payload) => ({ added: payload.delta, day: payload.day, stats: { version: 1, days: {} } })
  };
  const ok = await statsLib.recordSaveChars(okStore, { day: '2026-11-08', bookId: 'b1', delta: 12 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.recorded, { added: 12, day: '2026-11-08', stats: { version: 1, days: {} } });
});

test('静态闸门：保存链 4 项派生失败各记一条 warn 日志（固定错误码）', () => {
  const body = between(MAIN, "handleBook('chapter:save'", '\n  });');
  const calls = body.match(/logError\('save-derived', [^)]*, \{ level: 'warn', code: '[A-Z_]+' \}\)/g) || [];
  assert.equal(calls.length, 4, `4 个 catch 各要一条 warn：${calls.join(' / ')}`);
  for (const code of [
    'CHARS_BASELINE_MISSING',
    'SNAPSHOT_FAILED',
    'INDEX_DIRTY_FAILED',
    'STATS_RECORD_FAILED'
  ]) {
    assert.ok(calls.some((line) => line.includes(`code: '${code}'`)), `缺少 ${code} 的留痕`);
    assert.ok(calls.some((line) => line.includes(`level: 'warn'`)), `${code} 应是 warn 级别`);
  }
  // 4 处派生失败都只是「记日志 + 带回原因」，不许把保存改判成失败：整个保存体里唯一的 throw
  // 是 A7 的 META_SAVE_FAILED 部分成功（语义不能动）。
  const throws = body.match(/throw\s/g) || [];
  assert.equal(throws.length, 1, '派生失败不许重抛；保存体里只该保留 META_SAVE_FAILED 那一处 throw');
  assert.match(body, /code: 'META_SAVE_FAILED', bodySaved: true/);
});

test('静态闸门：保存结果带 charsBaselineMissing，统计失败仍返回原因', () => {
  const body = between(MAIN, "handleBook('chapter:save'", '\n  });');
  assert.match(body, /charsBaselineMissing: charsDelta\.baselineMissing/);
  assert.match(body, /const charsDelta = statsLib\.saveCharsDelta\(previousChars, result\.chars\)/);
  assert.match(body, /const recordedStats = await statsLib\.recordSaveChars\(getStatsStore\(\), \{/);
  assert.match(body, /statsError = statsErr\.message;/, '统计失败的原因仍沿旧字段带回界面');
  assert.match(body, /stats,/, '保存结果里保留 stats 字段');
});

test('静态闸门：渲染层把 charsBaselineMissing 传给「已保存」提示（基线缺失才多一句）', () => {
  const saveSrc = between(RENDERER, 'async function saveCurrent(', '\n  }');
  assert.match(saveSrc, /charsBaselineMissing: Boolean\(data\.charsBaselineMissing\)/);
  // 具体文案在纯逻辑里（另有用例钉住），这里确认标记真的接进了 savedToastText
  assert.match(saveSrc, /saveLogic\.savedToastText\(\{[\s\S]*?charsBaselineMissing/);
  assert.equal(
    saveLogic.savedToastText({ chapterCount: 3, charsText: '18 字', charsBaselineMissing: true }),
    '已保存：3 章 · 本章 18 字 · 本次字数未计入'
  );
});
