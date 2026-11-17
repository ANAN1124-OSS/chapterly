// 审计 E-N4（WP3）：「替换这一处」回执的书 / 章 / 正文身份复核 + 下标边界闸门。
//
// 缺陷：renderer.js 的 runReplaceOne 先拍 text → await findNext → 直接把回执里的 match.index
// 套到当前编辑区。await 期间切章 / 换书 / 改正文时，旧章下标会被拼进新章正文，随后 onEditorInput
// 把新章标脏，Ctrl+S 即写盘。这里把「回执还能不能用」的判定收成纯函数（R1–R7），再用静态闸门
// 钉住 renderer.js 真的在 await 之后复核（R8）；真实 Electron 时序由 E2E 组 29 覆盖。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const guard = require('../renderer/replace-one-guard');

const BOOK = 'D:\\书库\\测试书';
const OTHER_BOOK = 'D:\\书库\\另一本书';
const TEXT = '阿明一。阿明二。阿明三。';

function snapshotOf(extra) {
  return guard.captureTarget({
    bookPath: BOOK,
    chapterId: 'ch_001',
    text: TEXT,
    ...extra
  });
}

test('R1（E-N4）：await 期间切了章 → 回执作废，不把旧章下标套到新章', () => {
  const verdict = guard.checkTarget(snapshotOf(), {
    bookPath: BOOK,
    chapterId: 'ch_002',
    text: '第2章正文',
    loading: false
  });
  assert.equal(verdict.same, false);
  assert.equal(verdict.reason, 'chapter-changed');
  assert.match(guard.staleHint(verdict.reason), /切了章/);
});

test('R2（E-N4）：await 期间换了书 → 回执作废，不许拿新书同 id 章顶替', () => {
  const verdict = guard.checkTarget(snapshotOf(), {
    bookPath: OTHER_BOOK,
    chapterId: 'ch_001',
    text: TEXT,
    loading: false
  });
  assert.equal(verdict.same, false);
  assert.equal(verdict.reason, 'book-changed');
  assert.match(guard.staleHint(verdict.reason), /换了书/);
});

test('R3（E-N4）：同一章但正文被改过 → 回执作废（下标已经对不上正文）', () => {
  const verdict = guard.checkTarget(snapshotOf(), {
    bookPath: BOOK,
    chapterId: 'ch_001',
    text: '阿明一。阿明二。',
    loading: false
  });
  assert.equal(verdict.same, false);
  assert.equal(verdict.reason, 'text-changed');
  assert.match(guard.staleHint(verdict.reason), /正文有改动/);
});

test('R4（E-N4）：载章在途（loading）优先于其它差异，一律不许替换', () => {
  // 就算书 / 章 / 正文都还没变（载章尚未提交），loading 也必须拒绝：
  // 回执落地后新章马上覆盖编辑区，这次替换会静默丢失。
  assert.equal(
    guard.checkTarget(snapshotOf(), { bookPath: BOOK, chapterId: 'ch_001', text: TEXT, loading: true }).reason,
    'loading'
  );
  // 同时存在差异时也报 loading（优先提示「等一下」而不是「重新查找」）
  assert.equal(
    guard.checkTarget(snapshotOf(), { bookPath: OTHER_BOOK, chapterId: 'ch_002', text: 'x', loading: true }).reason,
    'loading'
  );
  assert.match(guard.staleHint('loading'), /切换章节/);
});

test('R5（E-N4）：身份全同才放行；空正文 + 同章仍算同目标', () => {
  assert.deepEqual(guard.checkTarget(snapshotOf(), { bookPath: BOOK, chapterId: 'ch_001', text: TEXT }), {
    same: true,
    reason: ''
  });
  const empty = guard.captureTarget({ bookPath: BOOK, chapterId: 'ch_001', text: '' });
  assert.equal(guard.checkTarget(empty, { bookPath: BOOK, chapterId: 'ch_001', text: '' }).same, true);
  // 缺字段（null / undefined）与空串按同一口径归一，不能因此误判成「同目标」
  assert.equal(guard.checkTarget(empty, { bookPath: BOOK, chapterId: 'ch_001' }).same, true);
  assert.equal(guard.checkTarget(empty, { bookPath: BOOK, chapterId: 'ch_002', text: '' }).same, false);
});

test('R6（E-N4，极值）：matchInBounds —— 文末命中合法，越界 / 负下标 / 0 长度 / 超大都拒绝', () => {
  const textLength = TEXT.length;
  // 最后一处命中：index + length 恰好等于正文长度 → 合法
  assert.equal(guard.matchInBounds({ index: textLength - 2, length: 2 }, textLength), true);
  assert.equal(guard.matchInBounds({ index: 0, length: textLength }, textLength), true);
  // 超出 1 字 → 假（旧实现按越界下标 slice 会拼错位置）
  assert.equal(guard.matchInBounds({ index: textLength - 1, length: 2 }, textLength), false);
  assert.equal(guard.matchInBounds({ index: textLength, length: 1 }, textLength), false);
  // 负数 / 0 长度 / 非整数 / 极大值 / textLength 非法 → 全假
  assert.equal(guard.matchInBounds({ index: -1, length: 2 }, textLength), false);
  assert.equal(guard.matchInBounds({ index: 0, length: 0 }, textLength), false);
  assert.equal(guard.matchInBounds({ index: 0.5, length: 1 }, textLength), false);
  assert.equal(guard.matchInBounds({ index: Number.MAX_SAFE_INTEGER, length: 1 }, textLength), false);
  assert.equal(guard.matchInBounds({ index: 0, length: 1 }, -1), false);
  assert.equal(guard.matchInBounds(null, textLength), false);
  // 空正文没有合法命中
  assert.equal(guard.matchInBounds({ index: 0, length: 1 }, 0), false);
});

test('R7（E-N4）：locateNext —— 同章在界内才选中；期间切章 / 越界只作废定位，不改正文', () => {
  const snapshot = snapshotOf();
  assert.deepEqual(
    guard.locateNext({ index: 0, length: 2 }, snapshot, {
      bookPath: BOOK,
      chapterId: 'ch_001',
      textLength: TEXT.length
    }),
    { index: 0, length: 2, stale: false }
  );
  // 第二个 await 期间切章：有命中但身份变了 → stale，index 必须为 null（旧的 setSelectionRange 不许套）
  assert.deepEqual(
    guard.locateNext({ index: 8, length: 2 }, snapshot, {
      bookPath: BOOK,
      chapterId: 'ch_002',
      textLength: 5
    }),
    { index: null, length: 0, stale: true }
  );
  // 同章但下标越界（新正文更短）→ stale
  assert.equal(
    guard.locateNext({ index: 40, length: 2 }, snapshot, {
      bookPath: BOOK,
      chapterId: 'ch_001',
      textLength: TEXT.length
    }).stale,
    true
  );
  // 根本没有下一处（null）→ 不算 stale：调用方按原逻辑把光标放到替换处之后
  assert.deepEqual(
    guard.locateNext(null, snapshot, { bookPath: BOOK, chapterId: 'ch_001', textLength: TEXT.length }),
    { index: null, length: 0, stale: false }
  );
  // 载章在途同样按 stale 处理
  assert.equal(
    guard.locateNext({ index: 0, length: 2 }, snapshot, {
      bookPath: BOOK,
      chapterId: 'ch_001',
      textLength: TEXT.length,
      loading: true
    }).stale,
    true
  );
});

test('R8（E-N4）：renderer.js runReplaceOne 必须在两个 await 之后复核身份 / 边界（静态闸门）', () => {
  const source = read('renderer/renderer.js');
  const start = source.indexOf('async function runReplaceOne()');
  assert.ok(start > 0, '找不到 runReplaceOne');
  const rest = source.slice(start);
  const nextFnAt = rest.indexOf('async function restoreReplaceBackupFlow(');
  assert.ok(nextFnAt > 0, '找不到 runReplaceOne 之后的下一个函数');
  const body = rest.slice(0, nextFnAt);

  // ① 入口：载章在途直接拒绝，不许进入 findNext
  const loadingGuardAt = body.search(/if \(state\.loading\) \{/);
  assert.ok(loadingGuardAt > 0, '入口必须判 state.loading（载章在途禁止执行）');
  assert.match(body.slice(loadingGuardAt, loadingGuardAt + 300), /STALE_TARGET/, 'loading 拒绝要返回同一个待复核错误码');

  // ② 第一个 await 之前拍身份快照
  const firstAwaitAt = body.indexOf('await (testFindNext || call)(api.findNext');
  assert.ok(firstAwaitAt > 0, '第一个 findNext 必须走 testFindNext || call（E2E 可注入延迟）');
  const captureAt = body.indexOf('replaceOneGuard.captureTarget(');
  assert.ok(captureAt > 0 && captureAt < firstAwaitAt, 'await findNext 之前必须先 captureTarget（书 / 章 / 正文快照）');

  // ③ await 之后复核身份 + 下标边界，不一致返回 STALE_TARGET，且绝不能先替换
  const checkAt = body.indexOf('replaceOneGuard.checkTarget(');
  assert.ok(checkAt > firstAwaitAt, 'findNext 回执之后必须 checkTarget');
  const replaceAt = body.indexOf('replaceEditorTextNative(replacement)');
  assert.ok(replaceAt > checkAt, '身份复核必须发生在改编辑区之前');
  assert.match(
    body.slice(checkAt, replaceAt),
    /STALE_TARGET/,
    '身份不一致 / 下标越界要返回待复核错误码（不许静默替换）'
  );
  assert.match(
    body.slice(checkAt, replaceAt),
    /matchInBounds\(/,
    '回执下标还要过 matchInBounds（越界不拼接）'
  );

  // ④ 兜底拼接前复核边界：原文的 slice 兜底仍在，但必须先过边界
  const fallbackAt = body.indexOf('current.slice(0, match.index)');
  assert.ok(fallbackAt > replaceAt, '兜底拼接必须还在（renderer-dedupe 闸门）');

  // ⑤ 第二个 await 之后按 locateNext 定位，旧章下标不许直接 setSelectionRange
  const secondAwaitAt = body.indexOf('await (testFindNext || call)(api.findNext', firstAwaitAt + 1);
  assert.ok(secondAwaitAt > 0, '第二个 findNext 也要走 testFindNext || call');
  const locateAt = body.indexOf('replaceOneGuard.locateNext(');
  assert.ok(locateAt > secondAwaitAt, '第二个回执之后必须 locateNext 复核书 / 章 / 下标');
  const oldSelectAt = body.indexOf('editorEl.setSelectionRange(next.match.index', secondAwaitAt);
  assert.equal(oldSelectAt, -1, '不许再把旧章的 next.match.index 直接 setSelectionRange');
});

test('装配闸门：index.html 与装配清单都登记 replace-one-guard.js（排在 renderer.js 之前）', () => {
  const index = read('renderer/index.html');
  const tag = '<script src="replace-one-guard.js"></script>';
  const tagAt = index.indexOf(tag);
  assert.ok(tagAt > 0, 'index.html 必须加载 replace-one-guard.js');
  assert.ok(tagAt < index.indexOf('<script src="renderer.js"></script>'), '必须在 renderer.js 之前加载');
  assert.match(
    read('renderer/assembly-manifest.js'),
    /\['replace-one-guard\.js', 'CWReplaceOneGuard', 'replaceOneGuard'/,
    '装配清单要登记文件 / 全局名 / renderer.js 本地名'
  );
  // renderer.js 顶部常量与模块挂出的全局名一致（装配清单 test 也会全链核对）
  assert.match(read('renderer/renderer.js'), /const replaceOneGuard = window\.CWReplaceOneGuard;/);
});