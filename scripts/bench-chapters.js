#!/usr/bin/env node
/* 卷内章号性能自检（1.5.0 P0-2，审计 P1）。
 *
 * 做什么：造一本纯内存的千章书，分别测
 *   1. 连续模式：chapterNumber 全表一遍；
 *   2. 按卷模式（新实现，带卷内章号表缓存）：首次建表一遍 / 缓存命中一遍；
 *   3. 按卷模式（改前「逐章从 0 数」的实现，这里复刻一份只作对照）：全表一遍。
 * 打印平均耗时（ms）与 chapterVolumeKey 调用次数。**耗时只打印、不做断言**：机器负载 /
 * 温度都会影响数字，正确性断言在 tests/chapters.test.js。缓存不写盘、不进书目；
 * 本脚本只碰内存，不读写任何真实书库。
 *
 * 用法：node scripts/bench-chapters.js [--chapters=1000] [--volumes=20] [--runs=20]
 */
'use strict';

const chaptersLib = require('../core/chapters');
const { argValue, median } = require('./bench-common');
const { tableLines } = require('./table');

const ARGV = process.argv.slice(2);
const CHAPTERS = argValue(ARGV, 'chapters', 1000);
const VOLUMES = argValue(ARGV, 'volumes', 20);
const RUNS = argValue(ARGV, 'runs', 20);

function buildBook() {
  const volumes = Array.from({ length: VOLUMES }, (_, i) => ({ id: `v${i + 1}`, name: `第${i + 1}卷` }));
  // 前 40 章未分卷，其余按卷均分：比「全在同一卷」更接近真实书的分布
  const chapters = Array.from({ length: CHAPTERS }, (_, i) => ({
    id: `c${i + 1}`,
    name: `第${i + 1}章`,
    volumeId: i < 40 ? '' : volumes[(i - 40) % VOLUMES].id
  }));
  return { volumes, chapters };
}

// 改前（1.4.0）的 volumeLocalNumber：每次从 0 数到 index，每次都调 chapterVolumeKey（O(V)）。
// 只在本脚本里复刻，用来量「改前」的耗时与调用次数；产品代码里已经没有这份实现。
function legacyVolumeLocalNumber(meta, index, stats) {
  const chapters = meta.chapters;
  const safeIndex = Math.max(0, Math.min(Number(index) || 0, chapters.length - 1));
  const target = chapters[safeIndex];
  if (!target) return safeIndex + 1;
  const key = legacyChapterVolumeKey(meta, target, stats);
  let number = 0;
  for (let i = 0; i <= safeIndex; i += 1) {
    if (legacyChapterVolumeKey(meta, chapters[i], stats) === key) number += 1;
  }
  return number;
}

function legacyChapterVolumeKey(meta, chapter, stats) {
  stats.calls += 1;
  const volumeId = chapter && typeof chapter.volumeId === 'string' ? chapter.volumeId : '';
  if (!volumeId) return '';
  return meta.volumes.some((volume) => volume && volume.id === volumeId) ? volumeId : '';
}

function measure(work, runs) {
  work(); // 预热：JIT / 首次分配不计入样本
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const startedAt = process.hrtime.bigint();
    work();
    samples.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const avg = samples.reduce((sum, ms) => sum + ms, 0) / samples.length;
  return { avg, median: median(samples), min: sorted[0], max: sorted[sorted.length - 1] };
}

function ms(value) {
  return value >= 10 ? value.toFixed(1) : value.toFixed(3);
}

const book = buildBook();
const baseMeta = { volumes: book.volumes, chapters: book.chapters };
const continuousMeta = { ...baseMeta, chapterNumbering: 'continuous' };
const volumeMeta = { ...baseMeta, chapterNumbering: 'volume' };

// 每一轮给一个新 meta 对象：缓存键不同 = 真的重新建表（模拟重开书 / 刷新 meta）
const freshVolumeMeta = () => ({ ...baseMeta, chapterNumbering: 'volume' });

const continuous = measure(() => {
  for (let i = 0; i < CHAPTERS; i += 1) chaptersLib.chapterNumber(continuousMeta, i);
}, RUNS);

const volumeCold = measure(() => {
  const meta = freshVolumeMeta();
  for (let i = 0; i < CHAPTERS; i += 1) chaptersLib.chapterNumber(meta, i);
}, RUNS);

const volumeWarm = measure(() => {
  for (let i = 0; i < CHAPTERS; i += 1) chaptersLib.chapterNumber(volumeMeta, i);
}, RUNS);

const legacyStats = { calls: 0 };
const legacy = measure(() => {
  legacyStats.calls = 0;
  for (let i = 0; i < CHAPTERS; i += 1) legacyVolumeLocalNumber(volumeMeta, i, legacyStats);
}, RUNS);
const legacyCallsPerPass = legacyStats.calls;

// 改后：同一个进程里实测 chapterVolumeKey 调用次数（建表走 id 集合，不应调用它）
chaptersLib.resetChapterNumberStats();
const statsMeta = freshVolumeMeta();
for (let i = 0; i < CHAPTERS; i += 1) chaptersLib.chapterNumber(statsMeta, i);
for (let i = 0; i < CHAPTERS; i += 1) chaptersLib.chapterNumber(statsMeta, i);
const stats = chaptersLib.readChapterNumberStats();

const speedup = legacy.avg / volumeCold.avg;

console.log('== 章回 1.5.0 P0-2 · 卷内章号性能自检 ==');
console.log(`规模：${CHAPTERS} 章 / ${VOLUMES} 卷；每项 ${RUNS} 轮（中位数 + 平均，单位 ms）`);
console.log('');
const timingRows = [
  ['模式', '平均', '中位'],
  ['连续模式（chapterNumber 全表）', ms(continuous.avg), ms(continuous.median)],
  ['按卷 · 新实现（首次建表）', ms(volumeCold.avg), ms(volumeCold.median)],
  ['按卷 · 新实现（缓存命中）', ms(volumeWarm.avg), ms(volumeWarm.median)],
  ['按卷 · 改前（逐章从 0 数）', ms(legacy.avg), ms(legacy.median)]
];
// TOOL-B06：不再用 `' '.repeat(8)` 手凑中文列宽，统一走显示宽度感知的 table.js。
for (const line of tableLines(timingRows, ['left', 'right', 'right'])) console.log(line);
console.log('');
console.log('chapterVolumeKey 调用次数（按卷全表一遍）：');
console.log(`  改前（逐章从 0 数）      ${legacyCallsPerPass.toLocaleString('en-US')} 次`);
console.log(`  改后（建表 + 缓存命中）  ${stats.volumeKeyCalls.toLocaleString('en-US')} 次（建表一次：${stats.tableBuilds} 次；建表只查卷 id 集合）`);
console.log('');
console.log(`加速比（改前 / 改后首次建表）：约 ${speedup.toFixed(0)}×`);
console.log('说明：耗时随机器负载浮动，本脚本只打印数字、不做断言；正确性见 tests/chapters.test.js。');
