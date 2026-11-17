'use strict';
// B1（审计 #17 / WP13）导出峰值内存基准：整本旧路径 vs 流式新路径。
//
// 用法：
//   node scripts/bench-export.js                     # 父进程：依次跑 4 个子进程并打表
//   node scripts/bench-export.js old-epub            # 子进程：整本路径（EPUB）
//   node scripts/bench-export.js stream-docx         # 子进程：流式路径（DOCX）
//   node scripts/bench-export.js all --out x.json    # 父进程 + JSON 落点
//   node scripts/bench-export.js all --chapters 600 --chars 10000
//
// 口径：
//   · 每个场景一个子进程（冷启动基线一致），采样 process.memoryUsage().rss / heapUsed
//     （2 ms 定时 + 关键节点显式采样），报峰值；
//   · 旧路径完全复刻 WP13 之前的 ipc/export.js：整本 texts → convertMeta → buildEpub/Docx
//     → 整包 Buffer（写盘前的状态；“改前”在工作树外跑同一脚本即旧实现）；
//   · 流式路径复刻 WP13 之后的 ipc/export.js：readText 逐章生成（按需）→ streamEpub/Docx
//     → 写入器逐块丢弃（等价于 atomicWriteFileStream 的 write，不含真实磁盘 IO）；
//   · 两条路径的输入文本 / 章节数 / 章字数 / 固定时间戳完全相同，产物字节数一并对比
//     （流式路径另可传 --verify 与整本路径逐字节对拍）。
const crypto = require('node:crypto');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const FIXED = new Date('2026-11-01T00:00:00Z');

function parseArgs(argv) {
  const args = { mode: 'all', chapters: 1000, chars: 12000, out: '' };
  const rest = argv.slice(2);
  if (rest.length && !rest[0].startsWith('--')) {
    args.mode = rest[0];
    rest.shift();
  }
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    const value = rest[i + 1];
    if (key === '--chapters') {
      args.chapters = Math.max(1, Math.floor(Number(value)) || 1);
      i += 1;
    } else if (key === '--chars') {
      args.chars = Math.max(1, Math.floor(Number(value)) || 1);
      i += 1;
    } else if (key === '--out') {
      args.out = String(value || '');
      i += 1;
    }
  }
  return args;
}

function buildMeta(chapters) {
  return {
    title: '基准书',
    id: 'b_bench_wp13',
    author: '基准作者',
    titleTemplate: '第{num}章：{name}',
    chapterNumbering: 'continuous',
    volumes: [],
    chapters: Array.from({ length: chapters }, (_, index) => ({
      id: `bc${index}`,
      file: `${String(index + 1).padStart(5, '0')}.txt`,
      name: `第${index + 1}章`,
      chars: 0
    }))
  };
}

const SENTENCE = '风从海面吹来，灯还亮着，远处有人在等。';
function chapterText(index, chars) {
  const head = `第${index + 1}章正文。`;
  return (head + SENTENCE.repeat(Math.ceil(chars / SENTENCE.length))).slice(0, chars);
}

// 采样器：2 ms 一次 + 关键节点显式采样；只记峰值，不保留历史。
function createSampler() {
  let peakRss = 0;
  let peakHeap = 0;
  const sample = () => {
    const usage = process.memoryUsage();
    if (usage.rss > peakRss) peakRss = usage.rss;
    if (usage.heapUsed > peakHeap) peakHeap = usage.heapUsed;
  };
  sample();
  const timer = setInterval(sample, 2);
  if (timer.unref) timer.unref();
  return {
    sample,
    stop() {
      clearInterval(timer);
      sample();
      return { peakRss, peakHeap };
    }
  };
}

async function runScenario(mode, args) {
  const epub = require('../core/epub');
  const docx = require('../core/docx');
  const exporter = require('../core/exporter');
  const s2t = require('../core/s2t');
  const meta = buildMeta(args.chapters);
  const sampler = createSampler();
  const startedAt = Date.now();
  let bytes = 0;
  let sinkWrites = 0;
  let sha256 = '';
  let hash = null;
  const sink = {
    async write(chunk) {
      if (chunk == null) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      bytes += buf.length;
      sinkWrites += 1;
      // 用增量 sha256 代替保留整包（与「写完就丢」的写盘语义一致）
      hash = hash ? hash.update(buf) : crypto.createHash('sha256').update(buf);
    }
  };
  if (mode.endsWith('epub')) {
    if (mode.startsWith('old')) {
      const texts = meta.chapters.map((_, index) => chapterText(index, args.chars));
      const exportMeta = s2t.convertMeta(meta, 's2t');
      // 复刻 WP13 之前的 ipc/export.js：整本就地转换后再 build
      exporter.convertTextsInPlace(texts, 's2t', s2t.convertText);
      const built = await epub.buildEpub({ meta: exportMeta, texts, modified: FIXED, zipDate: FIXED });
      bytes = built.bytes;
      hash = crypto.createHash('sha256').update(built.buffer);
      built.buffer = null;
      texts.length = 0;
    } else {
      const exportMeta = s2t.convertMeta(meta, 's2t');
      await epub.streamEpub(
        {
          meta: exportMeta,
          readText: async (index) => s2t.convertText(chapterText(index, args.chars), 's2t'),
          modified: FIXED,
          zipDate: FIXED
        },
        sink.write
      );
    }
  } else if (mode.endsWith('docx')) {
    if (mode.startsWith('old')) {
      const texts = meta.chapters.map((_, index) => chapterText(index, args.chars));
      const exportMeta = s2t.convertMeta(meta, 's2t');
      exporter.convertTextsInPlace(texts, 's2t', s2t.convertText);
      const built = await docx.buildDocx({ meta: exportMeta, texts, modified: FIXED, zipDate: FIXED });
      bytes = built.bytes;
      hash = crypto.createHash('sha256').update(built.buffer);
      built.buffer = null;
      texts.length = 0;
    } else {
      const exportMeta = s2t.convertMeta(meta, 's2t');
      await docx.streamDocx(
        {
          meta: exportMeta,
          readText: async (index) => s2t.convertText(chapterText(index, args.chars), 's2t'),
          modified: FIXED,
          zipDate: FIXED
        },
        sink.write
      );
    }
  } else {
    throw new Error(`未知场景：${mode}`);
  }
  const peaks = sampler.stop();
  if (hash) sha256 = hash.digest('hex');
  if (typeof global.gc === 'function') global.gc();
  return {
    mode,
    chapters: args.chapters,
    charsPerChapter: args.chars,
    totalChars: args.chapters * args.chars,
    bytes,
    sinkWrites,
    sha256,
    peakRssMb: Number((peaks.peakRss / 1048576).toFixed(1)),
    peakHeapMb: Number((peaks.peakHeap / 1048576).toFixed(1)),
    timeMs: Date.now() - startedAt,
    node: process.version
  };
}

function runChild(mode, args) {
  return new Promise((resolve, reject) => {
    const child = spawnSync(
      process.execPath,
      ['--expose-gc', __filename, mode, '--chapters', String(args.chapters), '--chars', String(args.chars)],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 }
    );
    if (child.error) {
      reject(child.error);
      return;
    }
    if (child.status !== 0) {
      reject(new Error(`${mode} 子进程失败（status ${child.status}）\n${child.stderr || ''}`));
      return;
    }
    const line = String(child.stdout || '')
      .split(/\r?\n/)
      .find((item) => item.startsWith('RESULT '));
    if (!line) {
      reject(new Error(`${mode} 子进程没有输出 RESULT：${child.stdout || ''}\n${child.stderr || ''}`));
      return;
    }
    try {
      resolve(JSON.parse(line.slice('RESULT '.length)));
    } catch (err) {
      reject(new Error(`${mode} 子进程 RESULT 解析失败：${err.message}\n${line}`));
    }
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.mode !== 'all') {
    const result = await runScenario(args.mode, args);
    process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
    return;
  }
  const modes = ['old-epub', 'stream-epub', 'old-docx', 'stream-docx'];
  const results = [];
  for (const mode of modes) {
    process.stdout.write(`跑 ${mode}（${args.chapters} 章 × ${args.chars} 字）…\n`);
    results.push(await runChild(mode, args));
  }
  // 对拍：同一输入下整本路径与流式路径的字节产物应完全一致
  const rows = results.map((r) => ({
    ...r,
    bytes: `${(r.bytes / 1048576).toFixed(2)} MB`,
    equal: results.some((other) => other.sha256 && other.sha256 === r.sha256 && other !== r)
  }));
  console.table(
    rows.map((row) => ({
      场景: row.mode,
      峰值RSS_MB: row.peakRssMb,
      峰值Heap_MB: row.peakHeapMb,
      产物大小: row.bytes,
      耗时ms: row.timeMs,
      逐字节一致: row.equal ? '是' : '—'
    }))
  );
  const summary = {
    node: process.version,
    chapters: args.chapters,
    charsPerChapter: args.chars,
    totalChars: args.chapters * args.chars,
    generatedAt: new Date().toISOString(),
    results
  };
  if (args.out) {
    fs.writeFileSync(path.resolve(args.out), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    process.stdout.write(`JSON 已写入 ${args.out}\n`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  });
}