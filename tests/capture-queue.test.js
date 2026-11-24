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

// CTXT-B-05：预览截断不许把代理对切成孤立高代理（与 capture.js 的码点截断同一口径）。
test('CTXT-B-05：首行预览恰好跨代理对时不产生孤立代理', () => {
  const emoji = '\u{1F600}'; // 代理对（2 个码元）
  // 39 个 BMP 字符 + emoji：limit=40 时第 40 个码元正好是高代理
  const text = '字'.repeat(39) + emoji + '后续文字';
  const preview = queueLib.previewOf(text, 40);
  assert.equal(preview.endsWith('…'), true, '超限要带省略号');
  const body = preview.slice(0, -1);
  assert.equal(body.length, 39, '截到高代理就回退一个码元（不会留下 40 个码元含半个 emoji）');
  assert.equal(/[\uD800-\uDBFF]$/.test(body), false, '结尾不许是孤立高代理');
  assert.equal(body, '字'.repeat(39));
  // 边界恰好落在完整 emoji 之后：整对保留
  assert.equal(queueLib.previewOf('字'.repeat(38) + emoji + '尾巴', 40), '字'.repeat(38) + emoji + '…', '边界落在完整代理对之后：整对保留');
});

// ---------- S1（一轮·中）/ T6（三审·中）：多窗口归属 ----------
// 捕获队列是「本次运行复制过的几段」。以前任何窗口都能列 / 取 / 删全部记录；现在每条记 ownerWindowId，
// 打开面板的窗口先认领无主记录，之后只有它能看到 / 取走 / 清空，关窗时它的记录一起丢弃。
test('S1 / T6：捕获队列按窗口归属——认领无主记录、非 owner 看不到取不到也删不掉、关窗回收', () => {
  const queue = queueLib.createCaptureQueue();
  queue.add(A); // 后台监听拍记进来的：还没有窗口上下文
  queue.add(B, { ownerWindowId: 11 }); // 全局快捷键：直接归要弹面板的窗口
  queue.add(C);
  const idOf = (text) => queue.list().find((entry) => entry.preview === queueLib.previewOf(text)).id;
  const idA = idOf(A);
  const idB = idOf(B);
  const idC = idOf(C);
  assert.equal(queue.size(), 3);

  // 另一扇窗口（22）打开面板：把剩下的无主记录认领掉（不抢 11 的）。
  assert.equal(queue.claim(22), 2, '无主记录归打开面板的窗口');
  assert.equal(queue.claim(22), 0, '重复认领幂等');
  assert.equal(queue.claim(null), 0, '没有窗口上下文时不认领');
  assert.deepEqual(queue.listFor(22).map((entry) => entry.id), [idA, idC], '只能看到自己的 + 无主的');
  assert.deepEqual(queue.listFor(11).map((entry) => entry.id), [idB]);
  assert.equal(queue.listFor(33).length, 0, '别的窗口拿不到任何记录');
  assert.equal(queue.sizeFor(22), 2);
  assert.equal(queue.size(), 3, '归属不影响底层条目数');

  // 非 owner 拒绝：看不到、取不到、删不掉、清不了。
  assert.equal(queue.canAccess(idA, 33), false);
  assert.equal(queue.removeFor(idA, 33), false, '非 owner 不许删别人的记录');
  assert.equal(queue.size(), 3, '被拒绝的删除不留副作用');
  assert.equal(queue.clearFor(33), 0, '非 owner 清空是空操作');
  assert.equal(queue.clearFor(22), 2, '只清自己的（认领到 22 的 A / C）');
  assert.deepEqual(queue.listFor(11).map((entry) => entry.id), [idB], '11 的记录不受 22 清空影响');
  assert.deepEqual(queue.listFor(22), []);
  assert.equal(queue.removeFor(idB, 11), true, 'owner 自己能删');
  assert.equal(queue.size(), 0);

  // 关窗回收：只丢这一扇窗口的记录，别的窗口的不动。
  queue.add(A, { ownerWindowId: 44 });
  queue.add(C);
  queue.claim(55);
  assert.equal(queue.size(), 2);
  assert.equal(queue.releaseOwner(44), 1);
  assert.equal(queue.releaseOwner(44), 0, '重复回收幂等');
  assert.equal(queue.releaseOwner(null), 0);
  assert.equal(queue.size(), 1, '只剩 55 认领的那条');
  assert.equal(queue.listFor(55).length, 1);
  // 非法 owner 归一成无主：不会被当成任何一扇窗口的；#3 起无主记录对任何窗口都不可见，必须先认领。
  queue.add(A, { ownerWindowId: 'not-a-number' });
  const rawIds = queue.list().map((entry) => entry.id);
  const unownedId = rawIds[rawIds.length - 1];
  assert.equal(queue.listFor(99).length, 0, '#3：无主记录不进任何窗口的列表（先 claim 再看）');
  assert.equal(queue.canAccess(unownedId, 99), false, '#3：无主记录不能仅凭自增 id 读 / 删');
  assert.equal(queue.removeFor(unownedId, 99), false, '#3：无主记录不能仅凭 id 删');
  assert.equal(queue.claim(99), 1, '认领之后才可见');
  assert.deepEqual(queue.listFor(99).map((entry) => entry.id), [unownedId]);
  assert.equal(queue.canAccess(unownedId, 99), true, '认领后 owner 可读');
  assert.equal(queue.removeFor(unownedId, 99), true);
});

// ---------- #3（二次审查，中低）：无主条目的读 / 认领边界 ----------
// 原清单只说「queue-list 抢先认领」，实际 queue-get 对无主条目也直接放行：任一窗口按自增 id 猜就能读
// 剪贴板历史正文。现在无主记录默认对任何窗口都不可见 / 不可读 / 不可删，必须先以「面板打开」的
// 上下文认领（上下文归主进程管，见 main.js 的 claimCaptureQueueForPanel）；认领只给来源窗口。
test('#3：无主记录默认不可见 / 不可读 / 不可删；认领后只对本窗口可见', () => {
  const queue = queueLib.createCaptureQueue();
  queue.add(A); // 后台监听拍：没有窗口上下文
  const idA = queue.list()[0].id;
  assert.equal(queue.size(), 1, '底层条目还在（只是没归属）');
  for (const windowId of [11, 22, null]) {
    assert.deepEqual(queue.listFor(windowId), [], `窗口 ${windowId} 看不到无主记录`);
    assert.equal(queue.sizeFor(windowId), 0);
    assert.equal(queue.canAccess(idA, windowId), false, `窗口 ${windowId} 读不到无主记录`);
    assert.deepEqual(queue.removeFor(idA, windowId), false, `窗口 ${windowId} 删不掉无主记录`);
    assert.equal(queue.clearFor(windowId), 0, `窗口 ${windowId} 清不掉无主记录`);
    assert.equal(queue.size(), 1, '被拒绝的操作不留副作用');
  }

  // 有主之后：只有 owner 能读 / 删；别的窗口照旧什么都看不到。
  assert.equal(queue.claim(11), 1, '无来源的空上下文记录可被第一个面板窗口认领');
  assert.deepEqual(queue.listFor(11).map((entry) => entry.id), [idA]);
  assert.deepEqual(queue.listFor(22), [], '认领后别的窗口看不到');
  assert.equal(queue.canAccess(idA, 22), false);
  assert.equal(queue.removeFor(idA, 22), false);
});

test('#3：来源窗口保护——A 窗口里复制的记录不会被 B 窗口抢先认领', () => {
  const queue = queueLib.createCaptureQueue();
  queue.add(A, { sourceWindowId: 11 }); // 在窗口 11 里复制 / 快捷键触发
  queue.add(B, { sourceWindowId: 11, ownerWindowId: 11 }); // 快捷键：直接归 11
  queue.add(C); // 在别的程序里复制：没有来源窗口
  const ids = queue.list().map((entry) => entry.id);

  // B 窗口（22）先开面板：只能认领没有来源的那条，抢不走 11 的。
  assert.equal(queue.claim(22), 1, '只认领没有来源窗口的记录');
  assert.deepEqual(queue.listFor(22).map((entry) => entry.id), [ids[2]]);
  assert.deepEqual(queue.listFor(11).map((entry) => entry.id), [ids[1]], '11 自己的那条还在');
  assert.equal(queue.canAccess(ids[0], 22), false, 'A 窗口里复制的正文 B 读不到（即使还没认领）');
  assert.equal(queue.removeFor(ids[0], 22), false);

  // A 窗口（11）打开面板：认领来源是自己的那条。
  assert.equal(queue.claim(11), 1, '来源窗口自己可以认领');
  assert.deepEqual(queue.listFor(11).map((entry) => entry.id), [ids[0], ids[1]]);
  assert.equal(queue.canAccess(ids[0], 11), true);

  // 来源窗口关了：它还没认领的记录一起回收（窗口没了就再也认领不了）。
  queue.add('关窗后没人能认领的一段' + A, { sourceWindowId: 33 });
  assert.equal(queue.releaseOwner(33), 1, '关窗回收「来源是本窗口」的未认领记录');
  assert.equal(queue.releaseOwner(11), 2, '关窗回收本窗口已认领的记录');
  assert.deepEqual(queue.listFor(22).map((entry) => entry.id), [ids[2]], '别的窗口的记录不受影响');
});

// ---------- N-17（二次审查，中低）：队列的隐私时间上限 ----------
// 后台监听开着一整天时，复制历史以前会一整天地驻留主进程内存（只有条数 / 总字数上限）。
// 现在每条最多留 ttlMs（默认 30 分钟），过期在下次触碰队列时惰性清掉 —— 本模块不起定时器。
test('N-17：超过 ttlMs 的条目在下次触碰时清掉（list / get / hasText / canAccess 都看不到）', () => {
  let t = 0;
  const queue = queueLib.createCaptureQueue({ ttlMs: 1000, now: () => t });
  const text = '过期正文'.repeat(4);
  const entry = queue.add(text).entry;
  assert.equal(entry.at, 0, 'at 用 store 自己的时钟');
  t = 999;
  assert.equal(queue.size(), 1, '未到 TTL 仍在');
  assert.equal(queue.get(entry.id).text, text);
  t = 1000;
  assert.equal(queue.size(), 0, '到 TTL 即过期（size() 会先清理）');
  assert.equal(queue.list().length, 0, 'list 不再给出过期条目');
  assert.equal(queue.get(entry.id), null, '过期后取不到正文');
  assert.equal(queue.hasText(text), false, '过期后不算「已入队」');
  assert.equal(queue.canAccess(entry.id, 11), false, '过期后不能被认领 / 读取');
  assert.equal(queue.totalChars(), 0, '过期条目不占总量预算');
});

test('N-17：过期清理是惰性的且返回条数；总量预算同步回收，新记录照常入队', () => {
  let t = 0;
  const queue = queueLib.createCaptureQueue({ ttlMs: 100, maxTotalChars: 100, now: () => t });
  queue.add('甲'.repeat(50));
  queue.add('乙'.repeat(50));
  assert.equal(queue.totalChars(), 100);
  t = 100; // 两条都到达 TTL
  assert.equal(queue.sweepExpired(), 2, '显式清理返回清掉的条数');
  assert.equal(queue.totalChars(), 0, 'totalChars 跟着回收');
  assert.equal(queue.sweepExpired(), 0, '重复清理幂等');
  queue.add('丙'.repeat(80));
  assert.equal(queue.size(), 1, '过期条目不再占总量预算，新记录能进');
  assert.equal(queue.totalChars(), 80);
});

test('N-17：过期条目不挡新记录；默认 TTL 30 分钟、可按实例覆盖', () => {
  assert.equal(queueLib.DEFAULT_TTL_MS, 30 * 60 * 1000, '默认 30 分钟');
  assert.equal(queueLib.createCaptureQueue().ttlMs, queueLib.DEFAULT_TTL_MS, '实例暴露实际 TTL');
  assert.equal(queueLib.createCaptureQueue({ ttlMs: 1234 }).ttlMs, 1234, '可按实例覆盖（单测 / 诊断口径）');
  let t = 0;
  const queue = queueLib.createCaptureQueue({ ttlMs: 500, now: () => t });
  queue.add('旧'.repeat(10));
  t = 600;
  assert.equal(queue.add('新'.repeat(10)).added, true, '过期不清空整个队列，新记录照常入队');
  assert.deepEqual(queue.list().map((entry) => entry.preview), ['新'.repeat(10)], '只留没过期的那条');
});

// ---------- CLOCK-01（2026-11-24 复核补审）：TTL 改单调时钟 ----------
// 旧实现用墙钟差判过期：系统时间被校准回拨后 cutoff = now - ttl 反而是「未来」，过期记录会
// 一直滞留；时间前跳则会把刚复制几分钟的记录立刻判过期。现在过期只看入队后的单调时长，
// 墙钟只保留在 at 字段做展示 / 兼容。
test('CLOCK-01：墙钟回拨 1 小时不让记录滞留，前跳也不提前淘汰', () => {
  let wall = 1_000_000;
  let mono = 5_000;
  const queue = queueLib.createCaptureQueue({ ttlMs: 1000, now: () => wall, monoNow: () => mono });
  const entry = queue.add('校准正文'.repeat(3)).entry;
  assert.equal(entry.at, wall, 'at 仍是墙钟（展示口径不变）');

  // 墙钟回拨 1 小时 + 单调时间恰好走到 TTL：必须过期
  wall -= 60 * 60 * 1000;
  mono += 1000;
  assert.equal(queue.size(), 0, '墙钟回拨不能让过期记录滞留');
  assert.equal(queue.get(entry.id), null);

  // 墙钟前跳 1 小时，但单调时间几乎没走：不许提前淘汰
  wall += 60 * 60 * 1000;
  const fresh = queue.add('前跳正文'.repeat(3)).entry;
  wall += 60 * 60 * 1000;
  mono += 999;
  assert.equal(queue.size(), 1, '墙钟前跳不能把刚复制的记录提前判过期');
  assert.equal(queue.get(fresh.id).text, '前跳正文'.repeat(3));

  // 真正的过期只按单调差走
  mono += 1;
  assert.equal(queue.size(), 0, '单调时间到 TTL 才过期');
});

test('CLOCK-01：默认路径用单调时钟（只注入墙钟的老用法语义不变）', () => {
  // 默认实例：TTL 判定走 performance.now，不读墙钟；这里只钉「默认实例能正常过期」。
  const queue = queueLib.createCaptureQueue({ ttlMs: 5 });
  const entry = queue.add('默认时钟'.repeat(3)).entry;
  return new Promise((resolve) => setTimeout(resolve, 25))
    .then(() => {
      assert.equal(queue.size(), 0, '默认实例 5ms TTL 在 25ms 后应过期');
      assert.equal(queue.get(entry.id), null);
    });
});

