#!/usr/bin/env node
'use strict';
// WP10（审计 P-N1）性能基准：一本「3000 章」的书回书架深度校验时到底打开 / 读了多少章文件。
//
// 为什么单独一个文件：P-N1 的验收口径是「3000 章回书架少 3000 open + ≤24 MB 读」，
// 这不是单测能声称的——必须同一台机器、同一份夹具、改前改后各跑一次。
//
// 度量方式：
//   * 每趟计时 = store.ensure({ booksRoot }) 的墙钟毫秒（深度校验，validateIntervalMs=0 保证
//     每趟都进全量校验分支）；
//   * opens = 这一趟里 fs.open 打开过的 `.txt` 章节文件次数（monkey-patch node:fs/promises 的
//     open，core/chapter-fingerprint.js 用的是同一个模块对象；产品代码零改动、只读）；
//   * 第 1 趟 = 建索引：既算内容指纹，也要读正文建 Bloom 位图，opens ≈ 2×章数；
//     第 2 趟起正文没变：改前每趟仍 ≈ 章数（重算内容指纹），改后未到复核期应为 0
//     （只 stat，不 open）。「低频复核」到期的那一趟会恢复 ≈ 章数——这是设计取舍，不是回归。
//
// 用法：
//   node scripts/bench-index-deep.js --chapters=3000 --runs=4
//   node scripts/bench-index-deep.js --chapters=3000 --runs=5 --hash-interval=300000 --out=D:\path\bench.json
//   --hash-interval 默认 300000 = 产品默认的内容指纹复核间隔（5 分钟）。
//
// 与 bench.js 同一约定：书库 / 配置全部建在系统临时目录，**绝不碰真实书库**；跑完只留临时目录
//（删除动作不进这个项目），JSON 落点可选（默认只打表格，不写盘）。

const os = require('node:os');
const fsp = require('node:fs/promises');
const path = require('node:path');

const storage = require('../core/storage');
const chaptersLib = require('../core/chapters');
const search = require('../core/search-index');
const { argValue, stringArg } = require('./bench-common');
const { clampInt } = require('../core/common');
const { tableLines } = require('./table');

const DEFAULTS = { chapters: 3000, runs: 4, hashInterval: 300000, out: null };
// TOOL-BX-07：与 bench.js 同一套口径 —— 参数走 core/common.js 的 clampInt（不在这里抄第二份夹紧），
// 上限与 bench.js 的 chapters 同量级（20000）。误输入多打一个零不再变成数小时 / 磁盘级失控。
const LIMITS = { chapters: [1, 20000], runs: [1, 50], hashInterval: [0, 86400000] };

function clampArg(argv, name, fallback, range) {
  const raw = argValue(argv, name, fallback);
  const value = clampInt(raw, fallback, range);
  if (value !== raw) {
    console.warn(`[bench] --${name}=${raw} 超出 ${range[0]}–${range[1]}，已夹到 ${value}`);
  }
  return value;
}

async function buildFixture(base, count) {
  const booksRoot = path.join(base, 'books');
  const userData = path.join(base, 'userdata');
  await fsp.mkdir(booksRoot, { recursive: true });
  await fsp.mkdir(userData, { recursive: true });
  const created = await storage.createBook(booksRoot, '基准巨书');
  const meta = await storage.readBookMeta(created.path);
  const chapters = [];
  for (let seq = 1; seq <= count; seq += 1) {
    const name = `第${seq}章`;
    const text = `${name}\n雨落在青柠色的伞上，第 ${seq} 次经过旧车站。${'风'.repeat(seq % 40)}`;
    const file = chaptersLib.buildFileName(seq, name);
    await fsp.writeFile(path.join(created.path, file), text, 'utf8');
    chapters.push({
      id: `ch_${chaptersLib.pad3(seq)}`,
      file,
      name,
      chars: chaptersLib.countChars(text),
      createdAt: '2026-01-01T00:00:00.000Z'
    });
  }
  meta.chapters = chapters;
  meta.fileSeq = count;
  await storage.writeBookMeta(created.path, meta, { structural: true });
  return { booksRoot, userData, bookPath: created.path };
}

async function measure(runOnce) {
  const startedAt = process.hrtime.bigint();
  const status = await runOnce();
  const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
  return { ms: Math.round(ms * 100) / 100, status };
}

async function main() {
  const argv = process.argv.slice(2);
  const chapters = clampArg(argv, 'chapters', DEFAULTS.chapters, LIMITS.chapters);
  const runs = clampArg(argv, 'runs', DEFAULTS.runs, LIMITS.runs);
  // 产品默认的内容指纹复核间隔（core/search-index.js 的 HASH_RECHECK_INTERVAL_MS = 5 分钟）。
  // 夹具用 validateIntervalMs=0 让每趟都进全量校验；这里显式给同一个 5 分钟，模拟生产口径
  // 「每 10 秒回一次书架 = 每趟全量校验，但同一本书 5 分钟才复核一次内容指纹」。
  // （改前代码没有这个选项，但它的行为等价于「每趟全复核」，因此 before 数据仍可比。）
  const hashInterval = clampArg(argv, 'hash-interval', DEFAULTS.hashInterval, LIMITS.hashInterval);
  const out = stringArg(argv, 'out', DEFAULTS.out);
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'cw-bench-index-'));
  const fixture = await buildFixture(base, chapters);
  const store = search.createSearchStore({
    userDataDir: fixture.userData,
    // 单测口径 = 每趟都做全量校验（生产里约 10 s 节流）；基准要量「最坏情况每趟」。
    validateIntervalMs: 0,
    hashRecheckIntervalMs: hashInterval
  });

  let opens = 0;
  const realOpen = fsp.open;
  fsp.open = async function patchedOpen(target, ...rest) {
    if (String(target).toLowerCase().endsWith('.txt')) opens += 1;
    return realOpen.call(fsp, target, ...rest);
  };

  const samples = [];
  try {
    for (let i = 0; i < runs; i += 1) {
      opens = 0;
      const measured = await measure(() => store.ensure({ booksRoot: fixture.booksRoot }));
      const lastRun = (measured.status && measured.status.lastRun) || {};
      samples.push({
        run: i + 1,
        ms: measured.ms,
        opens,
        rebuiltBooks: lastRun.rebuiltBooks || 0,
        reusedBooks: lastRun.reusedBooks || 0,
        books: lastRun.books || 0,
        chapters: lastRun.chapters || 0
      });
    }
  } finally {
    fsp.open = realOpen;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    chapters,
    runs,
    hashInterval,
    tempDir: base,
    samples
  };
  console.log('== WP10 · P-N1 索引深度校验基准（只读产品代码）==');
  console.log(`夹具：1 本书 / ${chapters} 章 · 临时目录 ${base}`);
  console.log('口径：每趟 store.ensure（validateIntervalMs=0 全量校验）；opens = 这一趟 fs.open 过的 .txt 数');
  console.log('');
  const rows = [['趟', '墙钟 ms', 'open .txt', '重建本', '复用本']];
  for (const sample of samples) {
    rows.push([sample.run, sample.ms, sample.opens, sample.rebuiltBooks, sample.reusedBooks]);
  }
  // TOOL-B06：中文表头「趟」占 2 列，固定列宽会整体错 1 列；改用显示宽度感知的 table.js。
  for (const line of tableLines(rows, ['left', 'right', 'right', 'right', 'right'])) console.log(line);
  console.log('');
  const steady = samples.slice(1);
  if (steady.length) {
    const totalOpens = steady.reduce((sum, sample) => sum + sample.opens, 0);
    const totalMs = steady.reduce((sum, sample) => sum + sample.ms, 0);
    console.log(
      `第 2 趟起合计：open ${totalOpens} 次 / 墙钟 ${Math.round(totalMs * 100) / 100} ms` +
        `（${steady.length} 趟，平均 ${Math.round((totalOpens / steady.length) * 10) / 10} open/趟）`
    );
  }
  if (out) {
    await fsp.mkdir(path.dirname(path.resolve(out)), { recursive: true });
    await fsp.writeFile(out, JSON.stringify(report, null, 2), 'utf8');
    console.log(`JSON：${path.resolve(out)}`);
  }
  console.log(`临时目录保留：${base}`);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});