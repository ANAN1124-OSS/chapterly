#!/usr/bin/env node
'use strict';
// WP11（审计 B3/B4）捕获性能基准：剪贴板捕获链路上的四个纯 CPU 热点，改前改后各跑一次。
//
// 为什么单独一个文件：B3/B4 的验收口径是「同一台机器、同一份夹具、改前改后可比」的墙钟数字。
// `scripts/bench.js` 量的是真实 Electron 里的打开书 / 切章 / 书架渲染，量不到这里的纯函数
// （capture 的归一化 / 预览 / 队列列表都不读盘、不进渲染层），所以另起一份，与
// `scripts/bench-index-deep.js`（WP10）同一约定：
//   * 只读产品代码、零外部依赖、纯 Node；
//   * 不碰真实书库、不写日志、不读剪贴板 —— 全部输入在内存里现造；
//   * 每项预热 1 次再取 N 次样本，报告 min / 中位 / 全部样本；
//   * JSON 落点可选（默认只打表格）。
//
// 改前代码注意：`normalizeCaptureText` 是 O(n²)（每次 `lines.shift()` 搬整条数组）。
// 前导空行 24 万就要约 25 s，290 万是小时级 —— 所以大尺寸项带**自适应闸**：
// 12 万档如果已经慢于 50 ms，就跳过 24 万 / 290 万 / splitRecordTitle 端到端，
// 在报告里标记 skipped，绝不把机器挂死。改后代码会全部跑满。
//
// 用法：
//   node scripts/bench-capture.js                       # 默认每项 3 次样本
//   node scripts/bench-capture.js --runs=5
//   node scripts/bench-capture.js --label=before --out=_audit-.../wp11-bench-before.json

const path = require('node:path');
const fsp = require('node:fs/promises');

const capture = require('../core/capture');
const queueLib = require('../core/capture-queue');

const DEFAULTS = { runs: 3, out: null, label: '' };
const HARD_CASE_MS = 50; // 12 万档超过它 = 二次复杂度还在，跳过更大的档位
const BODY_CHARS = 100000;

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

// 跑一次取墙钟毫秒（只包被测调用，夹具在采样前造好）。
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

function skipped(name, note) {
  return { name, runs: 0, note, samples: [], minMs: null, medianMs: null, skipped: true };
}

function buildVisibleQueue() {
  const queue = queueLib.createCaptureQueue();
  for (let i = 0; i < 10; i += 1) {
    queue.add(`第${i + 1}章 开端\n${'字'.repeat(290000)}`);
  }
  return queue;
}

function buildBlankHeavyQueue() {
  const queue = queueLib.createCaptureQueue();
  for (let i = 0; i < 10; i += 1) {
    queue.add(`${'\n'.repeat(290000)}正${i}`);
  }
  return queue;
}

async function main() {
  const argv = process.argv.slice(2);
  const runs = argValue(argv, 'runs', DEFAULTS.runs);
  const label = stringArg(argv, 'label', DEFAULTS.label);
  const out = stringArg(argv, 'out', DEFAULTS.out);
  const items = [];

  // ---------- 1. normalizeCaptureText：前导空行（B3） ----------
  const normalizeCases = [30000, 60000, 120000].map((lines) => ({
    lines,
    text: `${'\n'.repeat(lines)}${'正'.repeat(BODY_CHARS)}`
  }));
  const normalizeItems = [];
  for (const item of normalizeCases) {
    normalizeItems.push(
      sample(`normalizeCaptureText 前导空行 ${item.lines} + ${BODY_CHARS} 字正文`, () => {
        capture.normalizeCaptureText(item.text);
      }, runs, '去首部空行（审计前 O(n²)）')
    );
  }
  items.push(...normalizeItems);

  // 12 万档够快才继续加码（改前 12 万已 6.3 s，再往上会把机器挂住）。
  const linearNow = normalizeItems[normalizeItems.length - 1].minMs < HARD_CASE_MS;
  if (linearNow) {
    const lines240k = `${'\n'.repeat(240000)}${'正'.repeat(BODY_CHARS)}`;
    items.push(sample('normalizeCaptureText 前导空行 240000 + 10 万字正文', () => {
      capture.normalizeCaptureText(lines240k);
    }, runs, '线性档'));
    const huge = `${'\n'.repeat(2900000)}${'正'.repeat(BODY_CHARS)}`;
    items.push(sample('normalizeCaptureText 前导空行 2900000 + 10 万字正文', () => {
      capture.normalizeCaptureText(huge);
    }, runs, '审计 B3 的原场景（原文恰好 300 万）'));
    items.push(sample('splitRecordTitle 前导空行 2900000 + 10 万字正文（点「章节」端到端）', () => {
      capture.splitRecordTitle(huge);
    }, runs, '归一化 + 标题拆分'));
  } else {
    items.push(skipped('normalizeCaptureText 前导空行 240000 + 10 万字正文', '12 万档仍 >50 ms：O(n²) 未消，跳过更大档位'));
    items.push(skipped('normalizeCaptureText 前导空行 2900000 + 10 万字正文', '同上：改前不可在合理时间内完成（按 O(n²) 外推小时级）'));
    items.push(skipped('splitRecordTitle 前导空行 2900000 + 10 万字正文（点「章节」端到端）', '同上'));
  }

  // ---------- 2. recordPreview：有界前缀（B4） ----------
  const single29 = '字'.repeat(2900000);
  const sixLines = Array.from({ length: 6 }, () => '字'.repeat(400000)).join('\n');
  const blankPrefix = `${'\n'.repeat(2900000)}${'正'.repeat(1000)}`;
  items.push(sample('recordPreview 单行 290 万字', () => {
    capture.recordPreview(single29);
  }, runs, '只看前 300 字 / 6 行'));
  items.push(sample('recordPreview 6 行 × 40 万字', () => {
    capture.recordPreview(sixLines);
  }, runs));
  items.push(sample('recordPreview 290 万空行前缀 + 1000 字', () => {
    capture.recordPreview(blankPrefix);
  }, runs));

  // ---------- 3. previewOf：首个非空行（B4） ----------
  items.push(sample('previewOf 单行 290 万字', () => {
    queueLib.previewOf(single29);
  }, runs, '只要前 40 字'));
  items.push(sample('previewOf 290 万空行前缀 + 1000 字', () => {
    queueLib.previewOf(blankPrefix);
  }, runs, '要跳到首个非空行'));

  // ---------- 4. capture-queue.list()：满队列 / 空行重型队列（B4） ----------
  const visibleQueue = buildVisibleQueue();
  const blankQueue = buildBlankHeavyQueue();
  items.push(sample('list() 满队列 10 条 × 29 万字', () => {
    visibleQueue.list();
  }, runs, '面板每记一条新复制就重拉一次'));
  items.push(sample('list() 空行重型队列 10 条 × 29 万空行', () => {
    blankQueue.list();
  }, runs, '改前每条都要全文 split / Array.from'));

  // ---------- 输出 ----------
  const report = {
    generatedAt: new Date().toISOString(),
    label,
    node: process.version,
    runs,
    bodyChars: BODY_CHARS,
    queueSizes: { visible: visibleQueue.size(), blankHeavy: blankQueue.size() },
    items
  };
  const pad = (value, width) => String(value == null ? '-' : value).padEnd(width);
  console.log('== WP11 · B3/B4 捕获性能基准（只读产品代码）==');
  if (label) console.log(`标签：${label}`);
  console.log(`Node ${process.version} · 每项预热 1 次 + ${runs} 次样本 · 全内存夹具（零 IO）`);
  console.log('');
  const rows = [['项', 'min ms', '中位 ms']];
  for (const item of items) {
    rows.push([item.skipped ? `${item.name}（跳过）` : item.name, item.minMs, item.medianMs]);
  }
  for (const row of rows) console.log(`${pad(row[0], 64)} ${pad(row[1], 10)} ${pad(row[2], 10)}`);
  const skippedItems = items.filter((item) => item.skipped);
  if (skippedItems.length) {
    console.log('');
    for (const item of skippedItems) console.log(`跳过原因：${item.name} —— ${item.note}`);
  }
  if (out) {
    const target = path.resolve(out);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, JSON.stringify(report, null, 2), 'utf8');
    console.log('');
    console.log(`JSON：${target}`);
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});