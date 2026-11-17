'use strict';
// v1.8.0 WP-29（B8–B21 / V109 / V116 / V204 / V206）性能小项锚点。
//
// 这一包全部是「行为不变、少做重复活」的小优化，测试分三类：
//   ① 纯逻辑等价：新旧口径逐项对照（Set 去重 / 行号 / 归一匹配 / TTS 前缀归一 / 简繁拼串 /
//      卷插入点），坏输入与边界一律照旧；
//   ② 计数注入：钉住「没做第二遍活」（并发读盘峰值、缓存命中、签名复用）；
//   ③ 静态闸门：防止退回旧写法（indexOf 去重 / 逐字符数行号 / 整本读后再复制 / 逐卷 filter…）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const tmpCleanup = require('./tmp-cleanup');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const between = (source, start, end) => {
  const at = source.indexOf(start);
  assert.ok(at >= 0, `找不到源码锚点：${start}`);
  const to = end ? source.indexOf(end, at) : -1;
  return source.slice(at, to > at ? to : undefined);
};

async function mkTmp(prefix = 'cw-wp29-') {
  return tmpCleanup.track(await fsp.mkdtemp(path.join(os.tmpdir(), prefix)));
}

// ---------------------------------------------------------------- B8

test('B8：sanitizeChapterIndexes / composeSelected 去重换 Set，结果与旧口径逐项一致', () => {
  const ipcLimits = require('../core/ipc-limits');
  const exporter = require('../core/exporter');

  const raw = [];
  for (let i = 0; i < 20000; i += 1) raw.push(i);
  // 重复值 / 纯数字字符串 / 负数 / 越界 / 非数字混在末尾
  raw.push(0, '0', 19999, '19999', -1, 20000, 'abc', null, undefined, 3.9);
  const picked = ipcLimits.sanitizeChapterIndexes(raw, { total: 20000 });
  assert.equal(picked.length, 20000, '去重后正好 20000 条（上限内）');
  assert.equal(picked[0], 0);
  assert.equal(picked[picked.length - 1], 19999);
  assert.deepEqual(picked.slice(0, 4), [0, 1, 2, 3]);

  // 超过 MAX_CHAPTER_ITEMS：只收前 20000 条（与旧实现同一停止点），后面的重复不改变结果
  const overflow = ipcLimits.sanitizeChapterIndexes([1, 1, 2].concat(Array.from({ length: 20010 }, (_, i) => i)), {
    total: 30000
  });
  assert.equal(overflow.length, 20000);

  const meta = {
    version: 1,
    id: 'b_x',
    title: '书',
    fileSeq: 6,
    chapters: Array.from({ length: 6 }, (_, i) => ({ id: `ch_${i}`, file: `00${i}.txt`, name: `章${i}` }))
  };
  const texts = ['零', '一', '二', '三', '四', '五'];
  const a = exporter.composeSelected(meta, texts, [3, '1', 1, 3, -1, 6, 'x', null, 2.9]);
  const b = exporter.composeSelected(meta, texts, [1, 2, 3]);
  assert.equal(a, b, '重复 / 坏值 / 数字字符串都不改变选章输出');
  assert.equal(exporter.composeSelected(meta, texts, []) , '');

  // 静态闸门：两个函数都不许退回 picked.indexOf(...) 去重
  assert.equal(/picked\.indexOf\(/.test(read('core/ipc-limits.js')), false);
  assert.equal(/picked\.indexOf\(/.test(read('core/exporter.js')), false);
  assert.match(read('core/ipc-limits.js'), /const seen = new Set\(\);/);
  assert.match(read('core/exporter.js'), /const seen = new Set\(\);/);
});

// ---------------------------------------------------------------- B9

test('B9：字体读盘缓存按 realpath + mtime + size 命中，LRU 只保最近两份', () => {
  const { createFontReadCache, DEFAULT_MAX_ENTRIES } = require('../core/font-cache');
  assert.equal(DEFAULT_MAX_ENTRIES, 2);
  const cache = createFontReadCache();
  const statA = { mtimeMs: 1000, size: 24 };
  const keyA = cache.keyOf('/字体/a.ttf', statA);
  assert.equal(cache.get(keyA), null);
  assert.equal(cache.put(keyA, { name: 'a.ttf', size: 24, base64: 'AAAA' }), true);
  assert.deepEqual(cache.get(keyA), { name: 'a.ttf', size: 24, base64: 'AAAA' });
  // 同一个文件但 mtime / size 变了 → key 不同，自然失效
  assert.equal(cache.get(cache.keyOf('/字体/a.ttf', { mtimeMs: 1001, size: 24 })), null);
  assert.equal(cache.get(cache.keyOf('/字体/a.ttf', { mtimeMs: 1000, size: 25 })), null);
  // 空 base64 不入缓存（坏值不占内存）
  assert.equal(cache.put(cache.keyOf('/字体/b.ttf', statA), { base64: '' }), false);

  // 两份上限：写第三份挤掉最久未用的那份；命中的那份会刷新 LRU 次序
  const keyB = cache.keyOf('/字体/b.ttf', statA);
  const keyC = cache.keyOf('/字体/c.ttf', statA);
  cache.put(keyB, { name: 'b.ttf', size: 24, base64: 'BBBB' });
  assert.equal(cache.size(), 2);
  assert.deepEqual(cache.get(keyA), { name: 'a.ttf', size: 24, base64: 'AAAA' }, '命中后 a 变成最近使用');
  cache.put(keyC, { name: 'c.ttf', size: 24, base64: 'CCCC' });
  assert.equal(cache.size(), 2);
  assert.equal(cache.get(keyB), null, '最久未用的 b 被挤掉');
  assert.notEqual(cache.get(keyA), null);

  // 静态闸门：main.js 的 font:read 走缓存（key 含 stat），关窗清 pickedFontPaths（B18）
  const main = read('main.js');
  assert.match(main, /const cacheKey = fontReadCache\.keyOf\(realPath, stat\);/);
  assert.match(main, /fontReadCache\.put\(cacheKey, \{ name: fontName, size: stat\.size, base64 \}\);/);
  const fontRead = between(main, "handle('font:read'", "handle('font:test-pick'");
  assert.ok(
    fontRead.indexOf('fontReadCache.get(cacheKey)') < fontRead.indexOf('loaded.read()'),
    '缓存命中时跳过一次读盘（E2 同句柄：未命中才从同一句柄读）'
  );
  assert.match(fontRead, /openFontFile\(fs, realPath, \{/, 'E2：大小闸 / 读盘走同一句柄，不按路径 stat / readFile');
  assert.match(between(main, "browserWin.on('closed'", "browserWin.on('focus'"), /pickedFontPaths\.delete\(session\.id\)/);
});

// ---------------------------------------------------------------- B10

test('B10：窗口位置只在 5 个标量真的变了时才写整份 config', () => {
  const { sameWindowBounds } = require('../core/config');
  assert.equal(sameWindowBounds(null, { x: 1 }), false);
  assert.equal(sameWindowBounds({ x: 1 }, null), false);
  assert.equal(
    sameWindowBounds(
      { x: 10, y: 20, width: 1200, height: 760, maximized: false },
      { x: 10, y: 20, width: 1200, height: 760, maximized: false }
    ),
    true
  );
  assert.equal(
    sameWindowBounds({ x: 10, y: 20, width: 1200, height: 760 }, { x: 11, y: 20, width: 1200, height: 760 }),
    false
  );
  assert.equal(
    sameWindowBounds({ x: 10, y: 20, width: 1200, height: 760, maximized: false }, { x: 10, y: 20, width: 1200, height: 760, maximized: true }),
    false,
    '最大化标志变化必须写盘（重启恢复要它）'
  );
  // 数字写法不同（字符串 / 数字）不算变化
  assert.equal(
    sameWindowBounds({ x: '10', y: 20, width: '1200', height: 760 }, { x: 10, y: 20, width: 1200, height: '760' }),
    true
  );

  const main = read('main.js');
  const save = between(main, 'async function saveRecentWindowBounds(session) {', '\n}');
  const checkAt = save.indexOf('sameWindowBounds(current.windowBounds, nextBounds)');
  const writeAt = save.indexOf('await configStore.set({ windowBounds:');
  assert.ok(checkAt >= 0 && writeAt > checkAt, '先比对磁盘现状再写盘');
  assert.match(save, /const current = await configStore\.get\(\);/);
  assert.match(save, /if \(sameWindowBounds\(current\.windowBounds, nextBounds\)\) return true;/);
});

// ---------------------------------------------------------------- B11

test('B11：搜索候选书逐章读盘按批并发（结果与串行版逐字段一致）', async () => {
  const search = require('../core/search-index');
  const storage = require('../core/storage');
  const root = await mkTmp('cw-wp29-search-');
  const userData = await mkTmp('cw-wp29-index-');
  const { path: bookPath } = await storage.createBook(root, '并发核对书');
  for (let i = 1; i < 8; i += 1) await storage.createChapter(bookPath, i, `第${i}章`);
  const meta = await storage.readBookMeta(bookPath);
  for (let i = 0; i < meta.chapters.length; i += 1) {
    await storage.saveChapterText(bookPath, meta.chapters[i].file, `青柠色的雨伞 ${i} 号\n第二行也有青柠色\n`);
  }
  const store = search.createSearchStore({ userDataDir: userData, validateIntervalMs: 0 });
  await store.search({ booksRoot: root, query: '青柠色', limit: 60 });

  const original = storage.loadChapterText;
  let active = 0;
  let peak = 0;
  storage.loadChapterText = async (...args) => {
    active += 1;
    peak = Math.max(peak, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 8));
      return await original(...args);
    } finally {
      active -= 1;
    }
  };
  try {
    peak = 0;
    const serialPeakTracker = () => peak;
    void serialPeakTracker;
    const serial = await store.search({ booksRoot: root, query: '青柠色', limit: 60, readConcurrency: 1 });
    assert.equal(peak, 1, '串行口径峰值必须是 1（注入生效）');
    peak = 0;
    const parallel = await store.search({ booksRoot: root, query: '青柠色', limit: 60, readConcurrency: 4 });
    assert.ok(peak > 1, `并发预读应叠起 IO（峰值 ${peak}）`);
    assert.ok(peak <= 4, `峰值不超过 readConcurrency（峰值 ${peak}）`);
    // WP-36（D5）：同 tests/proofread.test.js，剔掉耗时字段用 delete，语义不变。
    const strip = (result) => {
      const rest = { ...result };
      delete rest.elapsedMs;
      return rest;
    };
    assert.deepEqual(strip(parallel), strip(serial), '并发版结果（条数 / 顺序 / 计数 / truncated）与串行版逐字段一致');
  } finally {
    storage.loadChapterText = original;
  }

  // 静态闸门：默认并发 4、只允许通过 opts.readConcurrency 给单测覆盖
  const source = read('core/search-index.js');
  assert.match(source, /const CHAPTER_READ_CONCURRENCY = 4;/);
  assert.match(source, /const readConcurrency = Math\.min\(/);
  assert.match(source, /await mapLimit\(batch, readConcurrency/);
});

// ---------------------------------------------------------------- B12

test('B12：lineOfIndex 用换行索引计数（与逐字符参考实现逐个位置一致）', () => {
  const findLogic = require('../renderer/find-logic');
  const texts = ['', 'abc', 'a\nb', '\n', '\n\n', 'a\nb\n', '中文\n行\n尾\n', 'a\nb\nc\nd\ne'];
  for (const text of texts) {
    for (let pos = 0; pos <= text.length; pos += 1) {
      const expected = text.slice(0, pos).split('\n').length;
      assert.equal(findLogic.lineOfIndex(text, pos), expected, `${JSON.stringify(text)} @${pos}`);
    }
  }
  // 越界夹取：负数 → 文首；超大 → 文末
  assert.equal(findLogic.lineOfIndex('a\nb\nc', -5), 1);
  assert.equal(findLogic.lineOfIndex('a\nb\nc', 999), 3);
  // 长文本随机位置对照
  let long = '';
  for (let i = 0; i < 4000; i += 1) long += `${i % 37 === 0 ? '\n' : '字'}`;
  for (let i = 0; i < 500; i += 1) {
    const pos = Math.floor(Math.random() * (long.length + 1));
    assert.equal(findLogic.lineOfIndex(long, pos), long.slice(0, pos).split('\n').length);
  }

  // 静态闸门：不许退回逐字符循环（B12 的旧实现）
  const lineFn = between(read('renderer/find-logic.js'), 'function lineOfIndex(rawText, rawIndex) {', '\n  }');
  assert.match(lineFn, /text\.indexOf\('\\n'\)/);
  assert.equal(/for \(let i = 0; i < pos; i \+= 1\)/.test(lineFn), false);
});

test('B12：normalizeMatches 对已规范化的升序数组直接复用，坏数据仍重建', () => {
  const findLogic = require('../renderer/find-logic');
  const sorted = [{ index: 2, length: 2 }, { index: 5, length: 1 }, { index: 9, length: 3 }];
  assert.equal(findLogic.normalizeMatches(sorted), sorted, '已规范化且升序 → 原数组直接复用（不重建 / 不排序）');
  const unsorted = [{ index: 9, length: 3 }, { index: 2, length: 2 }, { index: 5, length: 1 }];
  const normalized = findLogic.normalizeMatches(unsorted);
  assert.notEqual(normalized, unsorted);
  assert.deepEqual(normalized, sorted, '乱序仍按 index / length 升序');
  assert.deepEqual(unsorted, [{ index: 9, length: 3 }, { index: 2, length: 2 }, { index: 5, length: 1 }], '不改动入参');
  // 坏值 / 字符串数字：快速路径不接（仍走原来的清洗重建，1.5 按下标向下取整）
  const messy = [{ index: '2', length: '2' }, { index: 4, length: 0 }, { index: -1, length: 2 }, { index: 1.5, length: 2 }];
  assert.deepEqual(findLogic.normalizeMatches(messy), [{ index: 1, length: 2 }, { index: 2, length: 2 }]);
  assert.deepEqual(findLogic.normalizeMatches('nope'), []);
  // stepMatch / highlightWindow 对复用后的数组仍给出旧结果
  assert.deepEqual(findLogic.stepMatch(sorted, 1, 1), { index: 2, total: 3, wrapped: false });
  assert.deepEqual(findLogic.highlightWindow(sorted, 0, { max: 2 }).items, [
    { index: 2, length: 2, ordinal: 0 },
    { index: 5, length: 1, ordinal: 1 },
    { index: 9, length: 3, ordinal: 2 }
  ]); // max 会被夹到下限 20，3 条全画；序号口径与旧实现一致
});

// ---------------------------------------------------------------- B13

test('B13：TTS 先截断再归一 —— 与「先归一全文再 slice」逐块一致', () => {
  const tts = require('../core/tts');
  const common = require('../core/common');
  const chaptersLib = require('../core/chapters');
  const samples = [
    '第一段。\r\n第二段！\r\n\r\n第三段？',
    '\uFEFF开头有 BOM\r\n换行\r单独回车\n正常行',
    '  前后空白\t制表\u3000全角空格  ',
    '中英混排 emoji 😀 与代理对 𠮷',
    '很长的一段。'.repeat(300)
  ];
  for (const raw of samples) {
    const normalized = common.normalizeText(raw);
    const actual = tts.buildChunks(raw, { maxChunkChars: 40 });
    const reference = tts.buildChunks(normalized, { maxChunkChars: 40 });
    assert.deepEqual(actual.chunks, reference.chunks, '非超限文本的 chunks 逐项一致');
    assert.equal(actual.paragraphs, reference.paragraphs);
    assert.equal(actual.startIndex, reference.startIndex);
    assert.equal(actual.chars, normalized.length, 'chars 仍是归一后全文长度（含被截断部分）');
    assert.equal(actual.totalChars, chaptersLib.countChars(raw));
    assert.equal(actual.totalChars, chaptersLib.countChars(normalized), 'CRLF / BOM 都是空白，两种口径同数');
    assert.equal(actual.truncated, reference.truncated);
  }

  // 超限：正文 = normalizeText(raw).slice(0, MAX)，比归一全文只少被截掉的尾巴
  const raw = ('第一段。\r\n第二段也有字。\r\n\r\n').repeat(Math.ceil(tts.MAX_SOURCE_CHARS / 14));
  const normalized = common.normalizeText(raw);
  assert.ok(normalized.length > tts.MAX_SOURCE_CHARS);
  const actual = tts.buildChunks(raw, { maxChunkChars: 120 });
  const reference = tts.buildChunks(normalized.slice(0, tts.MAX_SOURCE_CHARS), { maxChunkChars: 120 });
  assert.deepEqual(actual.chunks, reference.chunks, '超限时只处理归一整串的前 MAX_SOURCE_CHARS 个字符');
  assert.equal(actual.paragraphs, reference.paragraphs);
  assert.equal(actual.startIndex, reference.startIndex);
  assert.equal(actual.chars, normalized.length);
  assert.equal(actual.totalChars, chaptersLib.countChars(normalized));
  assert.equal(actual.truncated, true);
  assert.ok(actual.chunks[actual.chunks.length - 1].end <= tts.MAX_SOURCE_CHARS);

  // 静态闸门：buildChunks 不再先归一全文（归一助手只在前缀上工作）
  const source = read('core/tts.js');
  const build = between(source, 'function buildChunks(text, rawOptions) {', '\n}');
  assert.match(build, /const fullLength = normalizedLength\(source\);/);
  assert.match(build, /const body = normalizePrefix\(source, limit\);/);
  assert.equal(/normalizeText\(source\)/.test(build), false);
  assert.equal(/normalizeText\s*\(/.test(source), false, 'tts.js 不再引用 common 的 normalizeText');
});

// ---------------------------------------------------------------- B16

test('B16：createOpenWatcher 缓存弹层开合（有观察器只读变量，无观察器退回现算）', () => {
  const registry = require('../renderer/backdrop-registry');
  const elements = new Map();
  const makeEl = (id) => {
    const hidden = new Set(['hidden']);
    const el = {
      id,
      classList: {
        contains: (name) => hidden.has(name),
        remove: (name) => hidden.delete(name),
        add: (name) => hidden.add(name)
      },
      _hidden: hidden
    };
    elements.set(id, el);
    return el;
  };
  for (const name of registry.LIST) makeEl(registry.backdropId(name));
  const $ = (id) => elements.get(id) || null;

  let observerInstance = null;
  class FakeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = [];
      observerInstance = this;
    }
    observe(el, options) {
      this.observed.push({ el, options });
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  const watcher = registry.createOpenWatcher($, { MutationObserver: FakeObserver });
  assert.equal(watcher.supported, true);
  assert.equal(observerInstance.observed.length, registry.LIST.length, '17 层都挂上观察器');
  assert.equal(watcher.isOpen(), false);
  elements.get('settings-backdrop').classList.remove('hidden');
  observerInstance.callback();
  assert.equal(watcher.isOpen(), true, 'class 变化同一拍刷新缓存');
  elements.get('settings-backdrop').classList.add('hidden');
  observerInstance.callback();
  assert.equal(watcher.isOpen(), false);
  // refresh 可手动刷新；disconnect 之后退回现算（不再依赖缓存）
  elements.get('jump-backdrop').classList.remove('hidden');
  assert.equal(watcher.isOpen(), false, 'disconnect 前缓存还未刷新');
  assert.equal(watcher.refresh(), true);
  watcher.disconnect();
  elements.get('jump-backdrop').classList.add('hidden');
  assert.equal(watcher.isOpen(), false, '没有观察器时逐层现算');

  // 没有 MutationObserver：supported=false，行为退回逐层现算
  const plain = registry.createOpenWatcher($, { MutationObserver: null });
  assert.equal(plain.supported, false);
  elements.get('capture-backdrop').classList.remove('hidden');
  assert.equal(plain.isOpen(), true);

  // 静态闸门：renderer.js 只在 bindEvents 建一次 watcher，anyBackdropOpen 读缓存
  const renderer = read('renderer/renderer.js');
  assert.equal((renderer.match(/backdropRegistry\.createOpenWatcher\(/g) || []).length, 1);
  assert.match(renderer, /function anyBackdropOpen\(\) \{\r?\n    if \(state\.modal\) return true;\r?\n    if \(backdropWatcher\) return backdropWatcher\.isOpen\(\);/);
  assert.match(renderer, /backdropWatcher = backdropRegistry\.createOpenWatcher\(\$\);/);
});

// ---------------------------------------------------------------- V109

test('V109：s2t convertWith 改 push + join，长文本逐字节等于旧口径', () => {
  const s2t = require('../core/s2t');
  const sentence = '后来他发现，门后说话的人头发干净，计划着怎么收获，什么也没有。';
  const expectedSentence = '後來他發現，門後說話的人頭髮乾淨，計劃著怎麼收穫，什麼也沒有。';
  assert.equal(s2t.convertText(sentence, 's2t'), expectedSentence);
  const many = sentence.repeat(20000);
  assert.equal(s2t.convertText(many, 's2t'), expectedSentence.repeat(20000), '百万字级导出串逐字节一致');
  assert.equal(s2t.convertText(expectedSentence.repeat(2000), 't2s'), sentence.repeat(2000));

  const source = read('core/s2t.js');
  const convert = between(source, 'function convertWith(text, chars, phrases) {', '\n  }');
  assert.match(convert, /const parts = \[\];/);
  assert.match(convert, /return parts\.join\(''\);/);
  assert.equal(/out \+=/.test(convert), false, '不再逐字符 += 拼串');
});

// ---------------------------------------------------------------- V116

test('V116：insertIndexForVolume 复用 rank Map（与旧 O(N·V) 实现逐例一致）', () => {
  const chaptersLib = require('../core/chapters');
  // 旧实现（逐值参考）：循环里反复 sanitizeVolumes + findIndex，仅用于对照
  const sanitizeVolumes = (raw) => {
    const out = [];
    const seen = new Set();
    for (const item of Array.isArray(raw) ? raw : []) {
      if (!item || typeof item !== 'object') continue;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name: typeof item.name === 'string' ? item.name.trim() : '' });
    }
    return out;
  };
  const oldRank = (meta, volumeId) => {
    if (!volumeId) return 0;
    const at = sanitizeVolumes(meta && meta.volumes).findIndex((v) => v.id === volumeId);
    return at < 0 ? 0 : at + 1;
  };
  const oldInsert = (meta, volumeId) => {
    const list = Array.isArray(meta && meta.chapters) ? meta.chapters : [];
    const target = volumeId || null;
    let last = -1;
    for (let i = 0; i < list.length; i += 1) if (((list[i] && list[i].volumeId) || null) === target) last = i;
    if (last >= 0) return last + 1;
    const rank = oldRank(meta, target);
    for (let i = 0; i < list.length; i += 1) {
      if (oldRank(meta, (list[i] && list[i].volumeId) || null) > rank) return i;
    }
    return list.length;
  };
  const volumeIds = ['v_001', 'v_002', 'v_003', 'v_404'];
  for (let round = 0; round < 300; round += 1) {
    const volumes = volumeIds.slice(0, 1 + (round % 3)).map((id) => ({ id, name: id }));
    const chapters = [];
    const count = round % 23;
    for (let i = 0; i < count; i += 1) {
      const pool = [null, 'v_001', 'v_002', 'v_003', 'v_404', ''];
      chapters.push({ id: `ch_${i}`, volumeId: pool[(round + i) % pool.length] });
    }
    // 故意不保证排序，覆盖「分组还没归一」的输入
    const meta = { volumes, chapters };
    for (const target of [null, 'v_001', 'v_002', 'v_003', 'v_404']) {
      assert.equal(chaptersLib.insertIndexForVolume(meta, target), oldInsert(meta, target), `round ${round} target ${target}`);
      assert.equal(chaptersLib.volumeRank(meta, target), oldRank(meta, target));
    }
  }
  const body = between(read('core/chapters.js'), 'function insertIndexForVolume(meta, volumeId) {', '\n  }');
  assert.match(body, /const ranks = volumeRankMap\(meta\);/);
  assert.equal(/volumeRank\(meta,/.test(body), false, '循环里不再反复重建卷序');
});

test('V116：listTxtFilesDeep 迭代队列 + 有限并发，清单排序 / 排除口径不变', async () => {
  const importer = require('../core/importer');
  const root = await mkTmp('cw-wp29-import-');
  const siblings = ['甲', '乙', '丙', '丁', '戊', '己'];
  const deep = path.join(root, siblings[0], '子目录', '再一层');
  await fsp.mkdir(deep, { recursive: true });
  await fsp.mkdir(path.join(root, '_trash'), { recursive: true });
  await fsp.mkdir(path.join(root, '.hidden'), { recursive: true });
  const expected = [];
  for (let i = 0; i < 4; i += 1) {
    await fsp.writeFile(path.join(deep, `第${i}章.txt`), 'x', 'utf8');
    await fsp.writeFile(path.join(root, `顶层${i}.txt`), 'x', 'utf8');
    await fsp.writeFile(path.join(root, `跳过${i}.md`), 'x', 'utf8');
    expected.push(`顶层${i}.txt`);
    expected.push(path.join(siblings[0], '子目录', '再一层', `第${i}章.txt`));
  }
  for (const name of siblings.slice(1)) {
    await fsp.mkdir(path.join(root, name), { recursive: true });
    for (let i = 0; i < 2; i += 1) {
      await fsp.writeFile(path.join(root, name, `章${i}.txt`), 'x', 'utf8');
      expected.push(path.join(name, `章${i}.txt`));
    }
  }
  await fsp.writeFile(path.join(root, '_trash', '回收.txt'), 'x', 'utf8');
  await fsp.writeFile(path.join(root, '.hidden', '隐藏.txt'), 'x', 'utf8');

  const originalReaddir = fsp.readdir;
  let active = 0;
  let peak = 0;
  fsp.readdir = async (...args) => {
    active += 1;
    peak = Math.max(peak, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 8));
      return await originalReaddir(...args);
    } finally {
      active -= 1;
    }
  };
  let found;
  try {
    found = await importer.listTxtFilesDeep(root);
  } finally {
    fsp.readdir = originalReaddir;
  }
  expected.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  assert.deepEqual(found, expected, '排序与排除（_trash / . 前缀 / 非 txt）逐项不变');
  assert.ok(peak > 1, `深目录 readdir 应有并发（峰值 ${peak}）`);
  assert.ok(peak <= 6, `并发不超过 6 路（峰值 ${peak}）`);

  const source = read('core/importer.js');
  const body = between(source, 'async function listTxtFilesDeep(dir, prefix = \'\', keepFiles = null) {', '\n}');
  assert.match(body, /const batch = queue\.splice\(0, LIST_DIR_CONCURRENCY\);/);
  assert.equal(/await listTxtFilesDeep\(path\.join\(dir, entry\.name\), rel\)/.test(source), false, '不再递归串行 await');
});

// ---------------------------------------------------------------- B20 / B17 / V204 / B21 静态闸门

test('B20：导出卷选项一次遍历计数（不再逐卷 filter 整本章节）', () => {
  const source = read('renderer/export-ui.js');
  const body = between(source, 'function fillExportVolumeOptions() {', '\n  }');
  assert.match(body, /const \{ counts, unvolumed \} = countChaptersByVolume\(\);/);
  assert.equal(/state\.chapters\.filter\(/.test(body), false, '不再每个卷 filter 一次');
  assert.match(between(source, 'function countChaptersByVolume() {', '\n  }'), /for \(const chapter of state\.chapters\)/);
});

test('B17：改名 / 改状态 / 批量改状态 / 卷改名走单条快路径（结构变化才整表重建）', () => {
  const renderer = read('renderer/renderer.js');
  assert.match(renderer, /function syncChapterItemInfo\(index\) \{/);
  assert.match(renderer, /function syncVolumeHeaderName\(volumeId\) \{/);
  const rename = between(renderer, 'async function renameChapterAt(index, nameOverride) {', '\n  }');
  assert.match(rename, /if \(!syncChapterItemInfo\(index\)\) renderChapterList\(\);/);
  const updateInfo = between(renderer, 'async function updateChapterInfo(index, patch) {', '\n  }');
  assert.match(updateInfo, /if \(!syncChapterItemInfo\(index\)\) renderChapterList\(\);/);
  const renameVolume = between(renderer, 'async function renameVolumeFlow(volumeId, nameOverride) {', '\n  }');
  assert.match(renameVolume, /if \(!syncVolumeHeaderName\(volumeId\)\) renderChapterList\(\);/);
  const batch = between(renderer, 'async function setSelectedChaptersStatus(status) {', '\n  }');
  assert.match(batch, /if \(!syncChapterItemInfo\(index\)\)/);
});

test('V204：设置弹层先显示再等统计 IPC（refreshStats 在 remove hidden 之后）', () => {
  const source = read('renderer/settings-ui.js');
  const body = between(source, 'async function openSettings(options = {}) {', '\n  }');
  const showAt = body.indexOf("$('settings-backdrop').classList.remove('hidden')");
  const statsAt = body.indexOf('await refreshStats()');
  assert.ok(showAt >= 0 && statsAt > showAt, '先 remove hidden，再 await stats:get');
  assert.equal((body.match(/settings-backdrop'\)\.classList\.remove\('hidden'\)/g) || []).length, 1);
});

test('B21：编辑器标记层的整章文本缓存随正文变化立刻释放', () => {
  const source = read('renderer/editor-marks-ui.js');
  assert.match(source, /function pruneStaleTextCaches\(text\) \{/);
  assert.match(source, /if \(caret && caret\.text !== text\) state\.marks\.lastCaret = null;/);
  assert.match(source, /if \(lines && lines\.text !== text\) state\.marks\.lastLinesKey = null;/);
  const caret = between(source, 'function caretLineHint(pos) {', '\n  }');
  assert.match(caret, /state\.marks\.lastLinesKey = null;/);
  const render = between(source, 'function renderEditorMarks() {', '\n  }');
  assert.match(render, /pruneStaleTextCaches\(text\);/);
});

test('B14 / B15 / V206：下拉签名 / 光标段内增量 / 跳章 payload 缓存的接线都在', () => {
  const bookinfo = read('renderer/bookinfo-ui.js');
  assert.match(bookinfo, /let shelfFilterSignature = '';/);
  const groupBar = between(bookinfo, 'function renderShelfGroupBar() {', '\n  }');
  assert.ok(groupBar.indexOf('const canReuse =') > 0);
  assert.match(groupBar, /shelfFilterSignature = signature;/);

  const focus = read('renderer/focus-mode-ui.js');
  assert.match(focus, /let caretMeasureCache = null;/);
  const measure = between(focus, 'function measureCaretTop(position) {', '\n  }');
  assert.match(measure, /cached\.paragraphStart === paragraphStart/);
  assert.match(measure, /measureMirrorOffset\(mirror, text\.slice\(paragraphStart, pos\)\)/);
  assert.equal(/mirror\.textContent = text\.slice\(0, pos\);/.test(measure), false, '段落内移动不再整章塞进 mirror');

  const jump = read('renderer/jump-ui.js');
  assert.match(jump, /let payloadCache = null;/);
  assert.match(jump, /if \(payloadCache && payloadCache\.rawMeta === rawMeta && payloadCache\.chapters === chapters\)/);
});