// 本次运行剪贴板捕获队列（core/capture-queue.js）的纯逻辑单测。
//
// 隐私红线在这层就能钉住：队列不碰 fs / 不碰 DOM / 不写日志；list() 只交元数据 + 首行预览 +
// 截断正文预览（previewText），正文全文只在 get(id) 显式取时返回。上限 / 淘汰 / 顺序 / 坏参数都在这里收敛。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const queueLib = require('../core/capture-queue');
const capture = require('../core/capture');

const A = '第一段复制进来的正文，用来验证队列会按复制顺序各记一条，并且列表里只有元数据和首行预览。';
const B = '第二段复制进来的正文，内容和第一段不一样，用来验证逐条捕获时不会串到别的一段去。';
const C = '第三段复制进来的正文，专门用来验证队列的顺序、淘汰和清空这些边界行为是否符合预期。';

function makeClock(start = 1000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    }
  };
}

test('预览：跳空行取首个非空行、折叠空白、超 40 字截断加省略号；空文本返回空串', () => {
  assert.equal(queueLib.previewOf(''), '');
  assert.equal(queueLib.previewOf('\n\n  \t \n'), '');
  assert.equal(queueLib.previewOf('\n\n  第1章 夜雨  \n第二行不显示'), '第1章 夜雨');
  assert.equal(queueLib.previewOf('标题\n\n  正文'), '标题');
  const long = '字'.repeat(queueLib.PREVIEW_LIMIT + 5);
  assert.equal(queueLib.previewOf(long), `${'字'.repeat(queueLib.PREVIEW_LIMIT)}…`);
  assert.equal(queueLib.previewOf('a  b\tc\n d'), 'a b c');
  assert.equal(queueLib.previewOf('短', 1), '短');
  assert.equal(queueLib.previewOf('两个', 1), '两…');
});

test('记一条：按复制顺序排队，列表只给元数据（id / chars / rawLength / at / preview / previewText，不含正文）', () => {
  const clock = makeClock();
  const queue = queueLib.createCaptureQueue({ now: clock.now });
  const first = queue.add(A);
  assert.equal(first.added, true);
  assert.equal(first.entry.id, 1);
  assert.equal(first.entry.chars, capture.countChars(A), 'chars = 去空白正文字数（与状态栏同一口径）');
  assert.equal(first.entry.rawLength, A.length, 'rawLength = 原文长度（含空白）');
  assert.equal(first.entry.at, 1000);
  assert.equal(first.entry.previewText, capture.recordPreview(A), '入队返回值也带截断正文预览');
  clock.advance(500);
  queue.add(B);
  queue.add(C);
  assert.equal(queue.size(), 3);

  const list = queue.list();
  assert.deepEqual(list.map((item) => item.id), [1, 2, 3], '旧 → 新');
  assert.deepEqual(list.map((item) => item.chars), [A, B, C].map((text) => capture.countChars(text)));
  assert.deepEqual(
    Object.keys(list[0]).sort(),
    ['at', 'chars', 'id', 'preview', 'previewText', 'rawLength'],
    '列表条目就这六个字段'
  );
  assert.equal(Object.prototype.hasOwnProperty.call(list[0], 'text'), false, '列表不许带正文全文');
  assert.equal(list[0].preview, queueLib.previewOf(A));
  assert.equal(list[0].previewText, capture.recordPreview(A), 'previewText 与渲染层共用 recordPreview');
});

test('previewText：整条截断正文（≤300 字 / 6 行、截断加…），preview 仍只是首行', () => {
  const queue = queueLib.createCaptureQueue();
  const long = Array.from({ length: 9 }, (_, i) => `第${i + 1}行${'正文'.repeat(100)}`).join('\n');
  queue.add(long);
  const meta = queue.list()[0];
  assert.ok(meta.previewText.endsWith('…'), '超 6 行 / 300 字要截断并加省略号');
  assert.ok(Array.from(meta.previewText).length <= capture.PREVIEW_MAX_CHARS + 1, '最多 300 字 + 省略号');
  assert.equal(meta.previewText.split('\n').length <= capture.PREVIEW_MAX_LINES, true, '最多 6 行');
  assert.equal(meta.preview, queueLib.previewOf(long), '首行预览口径不变');
  // 短文本原样给，不截断
  queue.add('短的正文');
  assert.equal(queue.list()[1].previewText, '短的正文');
});

test('取正文 / 判断是否有这段 / 删除 / 清空：都按 id 精确收敛，坏 id 不抛', () => {
  const queue = queueLib.createCaptureQueue();
  queue.add(A);
  const second = queue.add(B).entry;
  assert.equal(queue.get(second.id).text, B);
  assert.equal(queue.get(999), null);
  assert.equal(queue.get('2'), null, 'id 类型不对也当不存在（不猜）');
  assert.equal(queue.hasText(B), true);
  assert.equal(queue.hasText('没记过的文本'), false);
  assert.equal(queue.remove(second.id), true);
  assert.equal(queue.remove(second.id), false, '重复删除返回 false');
  assert.equal(queue.get(second.id), null);
  assert.equal(queue.size(), 1);
  assert.equal(queue.clear(), 1);
  assert.equal(queue.size(), 0);
  assert.deepEqual(queue.list(), []);
});

test('空文本 / 全空白不记；与最新一条完全相同不重复记（剪贴板没变时 watcher 也会挡一层）', () => {
  const queue = queueLib.createCaptureQueue();
  assert.deepEqual(queue.add(''), { added: false, reason: 'empty' });
  assert.deepEqual(queue.add('   \n\t '), { added: false, reason: 'empty' });
  assert.equal(queue.add(A).added, true);
  const duplicate = queue.add(A);
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.reason, 'duplicate');
  assert.equal(duplicate.entry.id, 1, '重复时给最新一条的元数据，调用方知道已经有了');
  assert.equal(queue.size(), 1);
  // 中间隔着别的段再复制同一段，算新的一条（作者确实又复制了一次）
  queue.add(B);
  assert.equal(queue.add(A).added, true);
  assert.equal(queue.size(), 3);
});

test('单条超上限不入队（reason=too-large）；上限值可覆盖，默认 30 万字', () => {
  const queue = queueLib.createCaptureQueue({ maxEntryChars: 10 });
  const tooLarge = queue.add('字'.repeat(11));
  assert.equal(tooLarge.added, false);
  assert.equal(tooLarge.reason, 'too-large');
  assert.equal(tooLarge.chars, 11);
  assert.equal(tooLarge.rawLength, 11);
  assert.equal(queue.size(), 0);
  assert.equal(queue.add('字'.repeat(10)).added, true);
  assert.equal(queueLib.createCaptureQueue({ maxEntryChars: 0 }).maxEntryChars, queueLib.DEFAULT_MAX_ENTRY_CHARS, '坏值回默认');
  // 2026-11-08：默认上限提到 30 万字，且必须与 core/capture.js 的捕获正文上限是同一个数
  const defaults = queueLib.createCaptureQueue();
  assert.equal(defaults.maxEntryChars, 300000);
  assert.equal(defaults.maxEntryChars, capture.MAX_BODY_CHARS, '队列单条上限必须跟着捕获正文上限');
  assert.equal(defaults.maxTotalChars, 3000000, '总量上限同步放大到 300 万字（10 条满额）');
});

// V108（v1.8.0 WP-24）：chars = 去空白正文字数（与插入后状态栏 / 导入 / 书目同一口径），
// rawLength = 含空白的原文长度。2026-11-15 放宽：单条上限按 chars（显示口径）挡，
// 总量 / 淘汰仍按 rawLength（内存口径）。
test('单条上限按去空白字数挡（2026-11-15 放宽）：原文长、字数够 30 万仍能入队', () => {
  const spaced = '　　甲乙 丙\n\n丁\t戊';
  assert.equal(capture.countChars(spaced), 5, '甲乙丙丁戊 = 5 个非空白字');
  assert.equal(spaced.length, 11, '样本原文 11 个 UTF-16 码元（含全角空格 / 空格 / 换行 / 制表符）');

  const queue = queueLib.createCaptureQueue();
  const added = queue.add(spaced);
  assert.equal(added.added, true);
  assert.equal(added.entry.chars, 5, '列表显示的「N 字」必须是去空白字数');
  assert.equal(added.entry.rawLength, 11, 'rawLength 保留原文长度');
  assert.equal(queue.totalChars(), 11, '总量按 rawLength 记账（内存口径，不是显示字数）');
  assert.equal(queue.get(added.entry.id).rawLength, 11, 'get() 与 list() 同一口径');
  assert.equal(queue.get(added.entry.id).chars, 5);

  // 上限按 chars 挡：字数 5 ≤ 10 → 照常入队（以前按 rawLength 11 > 10 会被丢掉）
  const tight = queueLib.createCaptureQueue({ maxEntryChars: 10 });
  assert.equal(tight.add(spaced).added, true, '字数没超线就不该被原文长度挡掉');
  // 字数超线才拒：11 个非空白字
  const tooLong = tight.add('字'.repeat(11));
  assert.equal(tooLong.added, false);
  assert.equal(tooLong.reason, 'too-large');
  assert.equal(tooLong.chars, 11);
  assert.equal(tooLong.rawLength, 11);

  // 作者 2026-11-15 报的场景：30 万字（去空白）+ 约 1 万个换行 → 原文 31 万，必须能入队
  const novel = '字'.repeat(300000) + '\n'.repeat(10000);
  const big = queueLib.createCaptureQueue();
  const queued = big.add(novel);
  assert.equal(queued.added, true, '30 万字按字数没超线：换行不该把它顶出去');
  assert.equal(queued.entry.chars, 300000);
  assert.equal(queued.entry.rawLength, 310000);
  // 再超一个字（字数 300001）仍然拒，边界不变
  const over = queueLib.createCaptureQueue().add('字'.repeat(capture.MAX_BODY_CHARS + 1));
  assert.equal(over.added, false);
  assert.equal(over.reason, 'too-large');

  // 删除 / 淘汰都按 rawLength 回退，总量不会漂
  const evicting = queueLib.createCaptureQueue({ maxEntries: 10, maxTotalChars: 20 });
  evicting.add('甲 乙');   // raw 3
  evicting.add('丙 丁');   // raw 3
  assert.equal(evicting.totalChars(), 6);
  assert.equal(evicting.remove(1), true);
  assert.equal(evicting.totalChars(), 3);
});

test('条数上限：超过 maxEntries 淘汰最旧的；列表仍按旧 → 新', () => {
  const queue = queueLib.createCaptureQueue({ maxEntries: 3 });
  for (const text of ['第一段' + '甲'.repeat(20), '第二段' + '乙'.repeat(20), '第三段' + '丙'.repeat(20), '第四段' + '丁'.repeat(20)]) {
    queue.add(text);
  }
  assert.equal(queue.size(), 3);
  assert.deepEqual(queue.list().map((item) => item.id), [2, 3, 4], '旧的 1 被淘汰');
  assert.equal(queue.hasText('第一段' + '甲'.repeat(20)), false);
});

test('总量上限：按字数淘汰最旧的，直到总量回到线内', () => {
  const queue = queueLib.createCaptureQueue({ maxEntries: 10, maxTotalChars: 100 });
  queue.add('甲'.repeat(60));
  queue.add('乙'.repeat(60));
  assert.equal(queue.size(), 1, '两条 60 字超过 100 总量 → 丢最旧');
  assert.equal(queue.totalChars(), 60);
  queue.add('丙'.repeat(50));
  assert.equal(queue.size(), 1, '60 + 50 又超过 100 → 再丢最旧，只留 50 字那条');
  assert.equal(queue.totalChars(), 50);
  queue.add('丁'.repeat(40));
  assert.equal(queue.size(), 2);
  assert.equal(queue.totalChars(), 90);
  assert.equal(queue.totalChars() <= 100, true, '每次都淘汰到线内');
});

test('清空后重新记：id 继续自增（不回收 id，避免旧引用误删新条目）', () => {
  const queue = queueLib.createCaptureQueue();
  queue.add(A);
  queue.clear();
  const entry = queue.add(B).entry;
  assert.equal(entry.id, 2);
});

test('静态闸门：队列模块不碰 fs / DOM / 日志 / Electron / 定时器，只做纯数据', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'capture-queue.js'), 'utf8');
  for (const forbidden of [
    "require('fs')",
    "require('node:fs')",
    'document.',
    'window.',
    'console.',
    'logError',
    'setTimeout',
    'setInterval',
    'electron',
    'innerHTML'
  ]) {
    assert.equal(source.includes(forbidden), false, `capture-queue.js 不许出现 ${forbidden}`);
  }
  assert.ok(source.includes('module.exports'), '纯逻辑模块要能被 Node 单测 require');
  // previewText 的截断规则只有 core/capture.js 一份：渲染层 pending 行与队列列表必须同口径
  assert.ok(source.includes("require('./capture')"), '截断预览要取 core/capture.js 的 recordPreview');
  assert.ok(source.includes('recordPreview(entry.text)'), 'list() 元数据里的 previewText 用 recordPreview');
  // V108（WP-24）静态闸门：chars 只能来自共享 countChars，不许再写回源串长度；rawLength 才承载原文长度
  assert.ok(source.includes('countChars = captureLib.countChars'), 'chars 必须引用共享 countChars（不另写副本）');
  assert.equal(/chars[:=]\s*source\.length/.test(source), false, 'chars 不许再是 source.length（含空白长度）');
});

test('单条原文比队列总量还大：直接按 too-large 拒（不许 added:true 之后被自己淘汰掉）', () => {
  const queue = queueLib.createCaptureQueue({ maxTotalChars: 100, maxEntryChars: 1000 });
  // 字数 50 在单条上限内，但原文 250 > 队列总量 100：放进去会被 evictOverflow 立刻丢掉
  const huge = '字'.repeat(50) + ' '.repeat(200);
  const res = queue.add(huge);
  assert.equal(res.added, false, '比总量还大的单条不许返回 added:true');
  assert.equal(res.reason, 'too-large');
  assert.equal(queue.size(), 0);
  // 正常条目照旧能进
  assert.equal(queue.add('字'.repeat(10)).added, true);
  assert.equal(queue.size(), 1);
});
