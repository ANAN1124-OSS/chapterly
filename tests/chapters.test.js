const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ch = require('../core/chapters');

test('章号编号方式：默认全书连续；只有显式 volume 才按卷独立，坏值回落默认', () => {
  assert.equal(ch.DEFAULT_CHAPTER_NUMBERING, 'continuous');
  assert.equal(ch.sanitizeChapterNumbering(undefined), 'continuous');
  assert.equal(ch.sanitizeChapterNumbering('continuous'), 'continuous');
  assert.equal(ch.sanitizeChapterNumbering('volume'), 'volume');
  assert.equal(ch.sanitizeChapterNumbering('per-volume'), 'continuous');
  assert.equal(ch.sanitizeChapterNumbering(null), 'continuous');
  assert.equal(ch.sanitizeChapterNumbering(1), 'continuous');
  assert.deepEqual(ch.CHAPTER_NUMBERING_MODES, ['continuous', 'volume']);
});

test('chapterNumber：连续模式按全书下标；按卷模式只数同一卷里前面的章（未分卷也算一组）', () => {
  // 正常顺序：未分卷 → 卷一 → 卷二
  const meta = {
    volumes: [{ id: 'v1', name: '卷一' }, { id: 'v2', name: '卷二' }],
    chapters: [
      { id: 'o1', volumeId: null },
      { id: 'a1', volumeId: 'v1' },
      { id: 'a2', volumeId: 'v1' },
      { id: 'b1', volumeId: 'v2' },
      { id: 'o2', volumeId: '' },
      { id: 'bad', volumeId: '已删除的卷' },
      { id: 'b2', volumeId: 'v2' }
    ]
  };
  // 连续模式：1..7，与以前完全一致
  assert.deepEqual(meta.chapters.map((_, i) => ch.chapterNumber(meta, i)), [1, 2, 3, 4, 5, 6, 7]);
  // 按卷模式：未分卷组 1、2、3（o1 / o2 / bad 的坏卷 id 也算未分卷）；卷一 1、2；卷二 1、2
  const byVolume = { ...meta, chapterNumbering: 'volume' };
  assert.deepEqual(byVolume.chapters.map((_, i) => ch.chapterNumber(byVolume, i)), [1, 1, 2, 1, 2, 3, 2]);
});

test('formatTitle：按卷模式用卷内章号，界面与导出同一份口径', () => {
  const meta = {
    chapterNumbering: 'volume',
    titleTemplate: '第{num}章：{name}',
    volumes: [{ id: 'v1', name: '卷一' }, { id: 'v2', name: '卷二' }],
    chapters: [
      { id: 'a1', volumeId: 'v1' },
      { id: 'a2', volumeId: 'v1' },
      { id: 'b1', volumeId: 'v2' },
      { id: 'b2', volumeId: 'v2' }
    ]
  };
  assert.equal(ch.formatTitle(meta, 0, '起风'), '第1章：起风');
  assert.equal(ch.formatTitle(meta, 1, '夜雨'), '第2章：夜雨');
  assert.equal(ch.formatTitle(meta, 2, '渡口'), '第1章：渡口');
  assert.equal(ch.formatTitle(meta, 3, ''), '第2章');
  assert.equal(ch.formatTitle({ ...meta, chapterNumbering: 'continuous' }, 2, '渡口'), '第3章：渡口');
  // 原文已带号标题不受模式影响；不带号特殊标题按卷内章号补号
  assert.equal(ch.formatTitle(meta, 2, '第3章 旧标题'), '第3章 旧标题');
  assert.equal(ch.formatTitle(meta, 2, '楔子'), '第1章：楔子');
});

test('没有卷的书即使选了按卷模式，章号仍与全书连续一致', () => {
  const meta = { chapterNumbering: 'volume', chapters: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
  assert.deepEqual([0, 1, 2].map((i) => ch.chapterNumber(meta, i)), [1, 2, 3]);
});

test('formatTitle：章号按数组下标现算，不在数据里存 N', () => {
  assert.equal(ch.formatTitle({}, 0, '起风'), '第1章：起风');
  assert.equal(ch.formatTitle({}, 11, '夜雨'), '第12章：夜雨');
  // 没有名字的章节显示「第N章」，不再显示「未命名」
  assert.equal(ch.formatTitle({}, 0, ''), '第1章');
  assert.equal(ch.formatTitle({}, 0, '   '), '第1章');
  assert.equal(ch.formatTitle({}, 0, null), '第1章');
});

test('formatTitle：原文已带号的标题原样显示，不叠加「第N章：」', () => {
  assert.equal(ch.formatTitle({}, 0, '第1章 关于本作品'), '第1章 关于本作品');
  assert.equal(ch.formatTitle({}, 3, '第一章：雪夜'), '第一章：雪夜');
  assert.equal(ch.formatTitle({}, 3, '第12回 风起'), '第12回 风起');
  assert.equal(ch.formatTitle({}, 5, 'Chapter 6 The End'), 'Chapter 6 The End');
});

test('formatTitle：楔子 / 番外 / 大结局 / 前传等不带号特殊标题补「第N章：」', () => {
  const words = [
    '楔子', '序章', '序言', '引子', '前言', '前传', '外传',
    '尾声', '后记', '番外', '终章', '大结局', '附录', '开篇'
  ];
  for (const word of words) {
    assert.equal(ch.formatTitle({}, 5, word), `第6章：${word}`);
  }
  // 带后缀 / 标点的原文标题：章号加在整个原词前，原词一字不改
  assert.equal(ch.formatTitle({}, 18, '大结局（上）'), '第19章：大结局（上）');
  assert.equal(ch.formatTitle({}, 18, '番外篇：后日谈'), '第19章：番外篇：后日谈');
  assert.equal(ch.formatTitle({}, 0, '前传'), '第1章：前传');
  assert.equal(ch.formatTitle({}, 2, ' 大结局 '), '第3章：大结局');
});

test('formatTitle：支持自定义模板', () => {
  const meta = { titleTemplate: 'Chapter {num} - {name}' };
  assert.equal(ch.formatTitle(meta, 2, '起风'), 'Chapter 3 - 起风');
});

test('formatTitle：自定义模板下原文已带号标题原样 / 特殊标题按模板 / 空名仍按 core 口径', () => {
  const meta = { titleTemplate: 'Chapter {num} - {name}' };
  // 原文已带号标题永远原样显示（哪怕书目写了自定义模板），避免「Chapter 3 - 第3章 …」重复
  assert.equal(ch.formatTitle(meta, 0, '第1章 关于本作品'), '第1章 关于本作品');
  // 特殊标题跟模板走：章号 + 原词都在
  assert.equal(ch.formatTitle(meta, 3, '楔子'), 'Chapter 4 - 楔子');
  // 空名无论模板怎么写都只显示「第N章」（渲染层章节列表也走这条，不再补「未命名」）
  assert.equal(ch.formatTitle(meta, 4, '  '), '第5章');
  assert.equal(ch.formatTitle(meta, 4, null), '第5章');
  // 模板只有空白 / 不是字符串 = 用默认模板
  assert.equal(ch.formatTitle({ titleTemplate: '   ' }, 1, '夜雨'), '第2章：夜雨');
  assert.equal(ch.formatTitle({ titleTemplate: 123 }, 1, '夜雨'), '第2章：夜雨');
  // 模板里没有 {name}：普通章只出章号；特殊标题回落默认，避免把「大结局」吞掉
  assert.equal(ch.formatTitle({ titleTemplate: '第{num}节' }, 2, '起风'), '第3节');
  assert.equal(ch.formatTitle({ titleTemplate: '第{num}节' }, 2, '大结局'), '第3章：大结局');
  // 模板里没有 {num}：特殊标题同样回落默认，章号不能丢
  assert.equal(ch.formatTitle({ titleTemplate: '{name}' }, 2, '大结局'), '第3章：大结局');
  // 重复占位符全部展开；不认识的占位符原样保留
  assert.equal(
    ch.formatTitle({ titleTemplate: '{num}-{num} {name}{unknown}' }, 0, '起风'),
    '1-1 起风{unknown}'
  );
});

test('UMD：Node require 行为不变，浏览器加载挂到 window.CWChapters', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'chapters.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'core/chapters.js' });
  const browserCh = sandbox.CWChapters;
  assert.equal(typeof browserCh, 'object');
  assert.equal(typeof browserCh.formatTitle, 'function');
  // 浏览器里的实现与 Node require 的是同一套 API（导出名一个不少、顺序无关）
  assert.deepEqual(Object.keys(browserCh).sort(), Object.keys(ch).sort());
  assert.equal(browserCh.TITLE_TEMPLATE, '第{num}章：{name}');
  // 渲染层真正用到的标题规则逐项与 Node 侧一致（自定义模板 / 原文标题 / 空名）
  const meta = { titleTemplate: 'Chapter {num} - {name}' };
  for (const [index, name] of [
    [0, '起风'],
    [1, '第2章 旧标题'],
    [2, ''],
    [3, null],
    [4, '  '],
    [5, '楔子'],
    [6, '大结局']
  ]) {
    assert.equal(browserCh.formatTitle(meta, index, name), ch.formatTitle(meta, index, name));
    assert.equal(browserCh.formatTitle(null, index, name), ch.formatTitle(null, index, name));
  }
  // 浏览器分支不污染 Node 模块（同一个文件被两边加载，各拿各的实例）
  assert.equal(typeof ch.formatTitle, 'function');
});

test('插入章节后，后面所有章号自动顺延（顺序即编号）', () => {
  const meta = { chapters: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
  const inserted = ch.insertChapter(meta, 1, { id: 'x' });
  assert.deepEqual(inserted.chapters.map((c) => c.id), ['a', 'x', 'b', 'c']);
  assert.equal(ch.formatTitle(inserted, 1, '灯塔'), '第2章：灯塔');
  assert.equal(ch.formatTitle(inserted, 2, '夜雨'), '第3章：夜雨');
  assert.equal(inserted.chapters.length, 4);
  assert.equal(meta.chapters.length, 3, '不修改原对象');
});

test('insertChapter 边界：负数、超长、非数字都落到合法位置', () => {
  const base = { chapters: [{ id: 'a' }] };
  assert.deepEqual(ch.insertChapter(base, -5, { id: 'x' }).chapters.map((c) => c.id), ['x', 'a']);
  assert.deepEqual(ch.insertChapter(base, 99, { id: 'y' }).chapters.map((c) => c.id), ['a', 'y']);
  assert.deepEqual(ch.insertChapter(base, undefined, { id: 'z' }).chapters.map((c) => c.id), ['a', 'z']);
});

test('safeName：过滤 Windows 非法字符、空值回退、超长截断', () => {
  assert.equal(ch.safeName('起风'), '起风');
  assert.equal(ch.safeName('a\\b/c:d*e?f"g<h>i|j'), 'abcdefghij');
  assert.equal(ch.safeName('   '), '未命名');
  assert.equal(ch.safeName(''), '未命名');
  assert.equal(ch.safeName('...起风...'), '起风');
  assert.equal(ch.safeName('夜'.repeat(60)).length, 40);
  assert.ok(!/[\\/:*?"<>|]/.test(ch.safeName('a:b*c')));
});

test('文件名生成：补零三位、空白名用未命名、重名加后缀', () => {
  assert.equal(ch.buildFileName(1, '起风'), '001-起风.txt');
  assert.equal(ch.buildFileName(12, ''), '012-未命名.txt');
  assert.equal(ch.buildFileName(100, '夜雨'), '100-夜雨.txt');
  assert.equal(ch.uniqueFileName(5, '起风', []), '005-起风.txt');
  assert.equal(ch.uniqueFileName(5, '起风', ['005-起风.txt']), '005-起风-2.txt');
  assert.equal(
    ch.uniqueFileName(5, '起风', ['005-起风.txt', '005-起风-2.txt']),
    '005-起风-3.txt'
  );
});

test('nextFileSeq：单调递增、删除不回退、缺失时兜底', () => {
  assert.equal(ch.nextFileSeq({ fileSeq: 3 }), 4);
  assert.equal(ch.nextFileSeq({ fileSeq: 0 }), 1);
  assert.equal(ch.nextFileSeq({}), 1);
  assert.equal(ch.nextFileSeq({ fileSeq: '7' }), 8);
});

test('重命名/删除只改记录，不碰 file 字段', () => {
  const meta = {
    chapters: [
      { id: 'a', file: '001-起风.txt', name: '起风' },
      { id: 'b', file: '002-夜雨.txt', name: '夜雨' }
    ]
  };
  const renamed = ch.updateChapter(meta, 'a', { name: '大风' });
  assert.equal(renamed.chapters[0].name, '大风');
  assert.equal(renamed.chapters[0].file, '001-起风.txt');
  const removed = ch.removeChapter(meta, 'b');
  assert.deepEqual(removed.chapters.map((c) => c.file), ['001-起风.txt']);
});

test('字数统计：不算空白字符', () => {
  assert.equal(ch.countChars('雨下了一夜。'), 6);
  assert.equal(ch.countChars('雨 下\n了\t一夜。'), 6);
  assert.equal(ch.countChars(''), 0);
  assert.equal(ch.countChars(null), 0);
});

test('章节状态：非法值回落到草稿，合法值统一小写', () => {
  assert.equal(ch.sanitizeChapterStatus('done'), 'done');
  assert.equal(ch.sanitizeChapterStatus(' DONE '), 'done');
  assert.equal(ch.sanitizeChapterStatus('revising'), 'revising');
  assert.equal(ch.sanitizeChapterStatus('finished'), 'draft');
  assert.equal(ch.sanitizeChapterStatus(null), 'draft');
  assert.equal(ch.chapterStatus({ status: 'done' }), 'done');
  assert.equal(ch.chapterStatus({ status: 'weird' }), 'draft');
  assert.equal(ch.chapterStatus({}), 'draft');
  assert.deepEqual(ch.CHAPTER_STATUSES, ['draft', 'revising', 'done']);
});

test('章节备注：一句话、最多 200 字、空值清空', () => {
  assert.equal(ch.sanitizeChapterNote('  这章要改结尾  '), '这章要改结尾');
  assert.equal(ch.sanitizeChapterNote('第一行\n第二行'), '第一行 第二行');
  assert.equal(ch.sanitizeChapterNote('字'.repeat(250)).length, 200);
  assert.equal(ch.sanitizeChapterNote(123), '');
  assert.equal(ch.chapterNote({ note: '  补结尾 ' }), '补结尾');
  assert.equal(ch.chapterNote({}), '');
});

test('章节清洗：旧数据没有 status/note 不乱加字段，非法值不写回', () => {
  const old = ch.cleanChapterMeta({ id: 'ch_001', file: '001-未命名.txt', name: '起风' });
  assert.deepEqual(Object.keys(old).sort(), ['file', 'id', 'name']);
  assert.equal(old.status, undefined);
  assert.equal(old.note, undefined);
  const dirty = ch.cleanChapterMeta({ id: 'x', status: 'NOPE', note: '   ' });
  assert.equal(dirty.status, undefined);
  assert.equal(dirty.note, undefined);
  const good = ch.cleanChapterMeta({ id: 'x', status: ' DONE ', note: '要改\n结尾' });
  assert.equal(good.status, 'done');
  assert.equal(good.note, '要改 结尾');
});

test('章节元数据补丁：只认 status/note，空备注删除字段，统计各状态章数', () => {
  const base = { id: 'x', file: 'x.txt', name: '甲' };
  const done = ch.applyChapterMeta(base, { status: 'done', note: '补结尾', name: '不该生效' });
  assert.equal(done.status, 'done');
  assert.equal(done.note, '补结尾');
  assert.equal(done.name, '甲');
  const cleared = ch.applyChapterMeta(done, { note: '   ' });
  assert.equal(cleared.note, undefined);
  const meta = { chapters: [{ status: 'done' }, {}, { status: 'revising' }, { status: 'bogus' }] };
  assert.deepEqual(ch.countChapterStatuses(meta), { total: 4, draft: 2, revising: 1, done: 1 });
  assert.deepEqual(ch.countChapterStatuses({}), { total: 0, draft: 0, revising: 0, done: 0 });
});

test('换行归一：读入统一 \\n，落盘统一 \\r\\n', () => {
  assert.equal(ch.normalizeNewlines('a\r\nb\rc\nd'), 'a\nb\nc\nd');
  assert.equal(ch.toDiskNewlines('a\nb'), 'a\r\nb');
  assert.equal(ch.toDiskNewlines('a\r\nb'), 'a\r\nb');
});

test('渲染层章节状态 / 备注直接用 core 的实现（不再有第二套「看起来一致」的清洗）', () => {
  const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  // v0.9 B-5：以前 renderer.js 里有一份本地实现，注释写着「与 core/chapters.js 保持一致」，
  // 实际少了「换行收成空格」这一步（手改书目写进带换行的备注时，界面与导出 / 复制口径不同）。
  // 现在渲染层只剩薄封装、常量也从 core 拿，这里把口径钉住，防止再抄一份。
  assert.match(rendererSrc, /CHAPTER_STATUS_LABELS\s*=\s*chaptersLib\.CHAPTER_STATUS_LABELS/);
  assert.match(
    rendererSrc,
    /function chapterStatus\(chapter\)\s*{\s*return chaptersLib\.chapterStatus\(chapter\);/
  );
  assert.match(rendererSrc, /function chapterNote\(chapter\)\s*{\s*return chaptersLib\.chapterNote\(chapter\);/);
  assert.ok(!/const CHAPTER_STATUSES\s*=\s*\[/.test(rendererSrc), 'renderer.js 不许再抄一份状态表');
  assert.ok(!/note\.length\s*>\s*200/.test(rendererSrc), 'renderer.js 不许再抄一份 200 字备注截断');
  // UMD 加载顺序：core/chapters.js 必须排在 renderer.js 之前（否则 chaptersLib 是 undefined）
  assert.ok(
    indexSrc.indexOf('../core/chapters.js') >= 0 &&
      indexSrc.indexOf('../core/chapters.js') < indexSrc.indexOf('renderer.js'),
    'index.html 必须先加载 core/chapters.js，再加载 renderer.js'
  );
});

// ---------- 1.5.0 P0-2：卷内章号表缓存（审计 P1） ----------

function cacheBook() {
  return {
    chapterNumbering: 'volume',
    volumes: [{ id: 'v1', name: '卷一' }, { id: 'v2', name: '卷二' }],
    chapters: [
      { id: 'o1', volumeId: null, name: '一' },
      { id: 'a1', volumeId: 'v1', name: '二' },
      { id: 'a2', volumeId: 'v1', name: '三' },
      { id: 'b1', volumeId: 'v2', name: '四' },
      { id: 'o2', volumeId: '', name: '五' }
    ]
  };
}

test('章号缓存：同一份 meta 连算结果不变，按卷 / 连续两种口径都对', () => {
  const meta = cacheBook();
  const expected = [1, 1, 2, 1, 2];
  for (let round = 0; round < 3; round += 1) {
    assert.deepEqual(meta.chapters.map((_, i) => ch.chapterNumber(meta, i)), expected);
  }
  const continuous = { ...meta, chapterNumbering: 'continuous' };
  assert.deepEqual(meta.chapters.map((_, i) => ch.chapterNumber(continuous, i)), [1, 2, 3, 4, 5]);
});

test('章号缓存：插入 / 删除 / 改卷 / 归一都拿新 meta，章号立即正确、旧 meta 不受影响', () => {
  const meta = cacheBook();
  assert.deepEqual(meta.chapters.map((_, i) => ch.chapterNumber(meta, i)), [1, 1, 2, 1, 2]);

  const inserted = ch.insertChapter(meta, 1, { id: 'a0', volumeId: 'v1', name: '新' });
  assert.deepEqual(inserted.chapters.map((_, i) => ch.chapterNumber(inserted, i)), [1, 1, 2, 3, 1, 2]);
  assert.deepEqual(meta.chapters.map((_, i) => ch.chapterNumber(meta, i)), [1, 1, 2, 1, 2], '旧 meta 的缓存不能被新 meta 污染');

  const removed = ch.removeChapter(inserted, 'a0');
  assert.deepEqual(removed.chapters.map((_, i) => ch.chapterNumber(removed, i)), [1, 1, 2, 1, 2]);

  // 改卷但还没归一：卷内号按「前面同卷数 + 1」算（这里 o2 在卷一里排第 3）
  const moved = ch.updateChapter(meta, 'o2', { volumeId: 'v1' });
  assert.deepEqual(moved.chapters.map((_, i) => ch.chapterNumber(moved, i)), [1, 1, 2, 1, 3]);
  const normalized = ch.normalizeChapterOrder(moved);
  assert.deepEqual(normalized.chapters.map((_, i) => ch.chapterNumber(normalized, i)), [1, 1, 2, 3, 1]);
});

test('章号缓存：就地改 meta 要调 invalidateChapterNumberCache，长度 / 编号变化自动失效', () => {
  const meta = cacheBook();
  assert.deepEqual(meta.chapters.map((_, i) => ch.chapterNumber(meta, i)), [1, 1, 2, 1, 2]);
  // 1) 就地改某一章的卷归属（长度不变）：不手动失效会读到旧表
  meta.chapters[4].volumeId = 'v1';
  ch.invalidateChapterNumberCache(meta);
  assert.deepEqual(meta.chapters.map((_, i) => ch.chapterNumber(meta, i)), [1, 1, 2, 1, 3]);
  // 2) 原地 push：长度变化让缓存自动失效
  meta.chapters.push({ id: 'b2', volumeId: 'v2', name: '六' });
  assert.equal(ch.chapterNumber(meta, 5), 2);
  // 3) 原地换编号方式：numbering 参与校验，切回连续立即生效
  meta.chapterNumbering = 'continuous';
  assert.deepEqual(meta.chapters.map((_, i) => ch.chapterNumber(meta, i)), [1, 2, 3, 4, 5, 6]);
  // 非整数下标（老调用）仍退回「下标 + 1」，和改前一致
  assert.equal(ch.chapterNumber({ chapterNumbering: 'volume', chapters: meta.chapters }, 1.7), 2.7);
});

test('章号缓存：按卷全表只建一次表，chapterVolumeKey 调用次数从平方级降到 0', () => {
  const meta = cacheBook();
  ch.resetChapterNumberStats();
  meta.chapters.forEach((_, i) => ch.chapterNumber(meta, i));
  const first = ch.readChapterNumberStats();
  assert.equal(first.tableBuilds, 1, '一份 meta 只该建一次表');
  assert.equal(first.volumeKeyCalls, 0, '建表只查卷 id 集合，不再逐章调 chapterVolumeKey');
  meta.chapters.forEach((_, i) => ch.chapterNumber(meta, i));
  assert.deepEqual(ch.readChapterNumberStats(), first, '缓存命中后不该再建表 / 再判定');
});
