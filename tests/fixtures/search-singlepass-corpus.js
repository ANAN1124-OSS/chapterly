'use strict';
// P3（V5 单遍扫描）：等价语料的共享构造器。
// 单遍改造前后都跑同一份语料，导出的 JSON 必须逐字一致（tests/search-index-singlepass.test.js）。
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const search = require('../../core/search-index');
const tmpCleanup = require('../tmp-cleanup');

function pad3(n) {
  return String(n).padStart(3, '0');
}

async function mkTmp(prefix = 'cw-singlepass-') {
  return tmpCleanup.track(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function makeBook(booksRoot, folder, title, chapters) {
  const bookPath = path.join(booksRoot, folder);
  await fs.mkdir(bookPath, { recursive: true });
  const meta = {
    version: 1,
    id: `b_${folder}`,
    title,
    titleTemplate: '第{num}章',
    fileSeq: chapters.length,
    chapters: [],
    createdAt: '2026-10-31T12:00:00.000Z',
    schemaVersion: 1
  };
  for (let i = 0; i < chapters.length; i += 1) {
    const chapter = chapters[i];
    const file = `${pad3(i + 1)}-${chapter.slug || 'c'}.txt`;
    await fs.writeFile(path.join(bookPath, file), chapter.text, 'utf8');
    meta.chapters.push({ id: `ch_${pad3(i + 1)}`, file, name: chapter.name || '', createdAt: '2026-10-31T12:00:00.000Z' });
  }
  await fs.writeFile(path.join(bookPath, '书目.json'), JSON.stringify(meta, null, 2), 'utf8');
  return { bookPath, meta };
}

// 第 1 章：20 万字大章 + 6000 处命中（> 5000，老实现要扫两遍才出结果）
const BIG_MARKER = 'qqmarkerqq';
function bigChapterText() {
  const unit = '雪落' + '风'.repeat(30); // 32 字
  const body = unit.repeat(6000); // 192000 字 / 6000 处命中
  return BIG_MARKER + '序'.repeat(2000 - BIG_MARKER.length) + body + '尾'.repeat(6000);
}

// 第 2 章：命中数超过计数硬上限 10000（10050 处）
function cappedChapterText() {
  return ('灯芯' + 'x'.repeat(8)).repeat(10050);
}

// 第 3 章：CRLF + 制表 + 大小写混排 + 跨行候选
function mixedChapterText() {
  return [
    '第一段 LINE one 结束了。\r\n',
    '\t第二段 line two 在前，后面跟着 LINE three。\r\n',
    '第三段光\r\n明这个词被换行劈开了。\r\n',
    '第四段 line four 收尾。'
  ].join('');
}

function buildCorpus(base) {
  return {
    big: bigChapterText(),
    capped: cappedChapterText(),
    mixed: mixedChapterText(),
    marker: BIG_MARKER
  };
}

async function makeStoreAndBooks(base) {
  const userData = path.join(base, 'userdata');
  const booksRoot = path.join(base, 'books');
  await fs.mkdir(userData);
  await fs.mkdir(booksRoot);
  const texts = buildCorpus(base);
  await makeBook(booksRoot, '语料书', '语料书', [
    { name: '大章', text: texts.big, slug: 'big' },
    { name: '上限章', text: texts.capped, slug: 'capped' },
    { name: '混排章', text: texts.mixed, slug: 'mixed' }
  ]);
  const store = search.createSearchStore({ userDataDir: userData, validateIntervalMs: 0 });
  return { store, booksRoot, userData, texts };
}

function projectRows(rows) {
  return rows.map((row) => ({
    chapterIndex: row.chapterIndex,
    chapterName: row.chapterName,
    matchIndex: row.matchIndex,
    matchLength: row.matchLength,
    chapterMatchCount: row.chapterMatchCount,
    chapterCountCapped: row.chapterCountCapped,
    snippet: {
      before: row.snippet.before,
      match: row.snippet.match,
      after: row.snippet.after,
      cutBefore: row.snippet.cutBefore,
      cutAfter: row.snippet.cutAfter
    }
  }));
}

function projectResult(found) {
  return {
    resultsCount: found.results.length,
    results: projectRows(found.results),
    candidateBooks: found.candidateBooks,
    scannedBooks: found.scannedBooks,
    scannedChapters: found.scannedChapters,
    skippedChapters: found.skippedChapters,
    matchedChapters: found.matchedChapters,
    totalMatches: found.totalMatches,
    truncated: found.truncated
  };
}

// 导出等价快照：字段只留确定值（路径 / 耗时这种跑一次变一次的不进夹具）
async function collectSnapshot(base) {
  const { store, booksRoot } = await makeStoreAndBooks(base);
  const out = {};
  out.bigScan = projectResult(await store.search({ booksRoot, query: '雪落', limit: 40 }));
  out.cappedScan = projectResult(await store.search({ booksRoot, query: '灯芯', limit: 40 }));
  out.mixedScan = projectResult(await store.search({ booksRoot, query: 'line', limit: 40 }));
  out.acrossNewline = projectResult(await store.search({ booksRoot, query: '光明', limit: 40 }));
  out.emptyQuery = projectResult(await store.search({ booksRoot, query: '   ', limit: 40 }));
  out.limitTwo = projectResult(await store.search({ booksRoot, query: '雪落', limit: 2 }));
  const focused = await store.search({
    booksRoot,
    query: '雪落',
    limit: 40,
    focus: { bookPath: path.join(booksRoot, '语料书'), chapterFile: '001-big.txt' }
  });
  out.focusBig = {
    resultsCount: focused.results.length,
    head: projectRows(focused.results.slice(0, 3)),
    tail: projectRows(focused.results.slice(-1)),
    lastMatchIndex: focused.results.length ? focused.results[focused.results.length - 1].matchIndex : null,
    limit: focused.limit,
    focus: focused.focus,
    candidateBooks: focused.candidateBooks,
    scannedBooks: focused.scannedBooks,
    scannedChapters: focused.scannedChapters,
    skippedChapters: focused.skippedChapters,
    matchedChapters: focused.matchedChapters,
    totalMatches: focused.totalMatches,
    truncated: focused.truncated
  };
  return out;
}

module.exports = { bigChapterText, cappedChapterText, mixedChapterText, BIG_MARKER, buildCorpus, makeStoreAndBooks, collectSnapshot, mkTmp, makeBook };
