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

test('记一条：按复制顺序排队，列表只给元数据（id / chars / at / preview / previewText，不含正文）', () => {
  const clock = makeClock();
  const queue = queueLib.createCaptureQueue({ now: clock.now });
  const first = queue.add(A);
  assert.equal(first.added, true);
  assert.equal(first.entry.id, 1);
  assert.equal(first.entry.chars, A.length);
  assert.equal(first.entry.at, 1000);
  assert.equal(first.entry.previewText, capture.recordPreview(A), '入队返回值也带截断正文预览');
  clock.advance(500);
  queue.add(B);
  queue.add(C);
  assert.equal(queue.size(), 3);

  const list = queue.list();
  assert.deepEqual(list.map((item) => item.id), [1, 2, 3], '旧 → 新');
  assert.deepEqual(list.map((item) => item.chars), [A.length, B.length, C.length]);
  assert.deepEqual(Object.keys(list[0]).sort(), ['at', 'chars', 'id', 'preview', 'previewText'], '列表条目就这五个字段');
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

test('单条超上限不入队（reason=too-large）；上限值可覆盖，默认 10 万字', () => {
  const queue = queueLib.createCaptureQueue({ maxEntryChars: 10 });
  const tooLarge = queue.add('字'.repeat(11));
  assert.equal(tooLarge.added, false);
  assert.equal(tooLarge.reason, 'too-large');
  assert.equal(tooLarge.chars, 11);
  assert.equal(queue.size(), 0);
  assert.equal(queue.add('字'.repeat(10)).added, true);
  assert.equal(queueLib.createCaptureQueue({ maxEntryChars: 0 }).maxEntryChars, queueLib.DEFAULT_MAX_ENTRY_CHARS, '坏值回默认');
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
});
