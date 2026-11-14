const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const staleGuard = require('../renderer/stale-guard');

// v1.8.0 WP-15（审计 C15/C16/C36/C37/C40/V111/V202）：渲染层长 IPC 回执的统一判据。
// 这一族问题以前在 9 个面板各写各的（书级校验 / 无令牌 / await 后读活状态），先发后到的旧回执
// 会盖掉新结果、把结果标到另一章名下。判据抽成 stale-guard.js 之后，这里逐条钉住纯逻辑，
// 再用静态闸门保证「8 个消费者都从 host 拿到同一个助手」而不是各写一份。

const ROOT = path.join(__dirname, '..');
const guardSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'stale-guard.js'), 'utf8');
const guardCode = guardSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const indexSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// 8 个消费者：模块 → 它必须从 host 拿 staleGuard
const CONSUMERS = [
  'renderer/statusbar-ui.js',
  'renderer/find-ui.js',
  'renderer/capture-ui.js',
  'renderer/export-ui.js',
  'renderer/history-ui.js',
  'renderer/fragments-ui.js',
  'renderer/proofread-ui.js',
  'renderer/sensitive-ui.js'
];

// ---------- createSeq ----------
test('createSeq：只有最后发起的那次算数（next / isCurrent / current）', () => {
  const seq = staleGuard.createSeq();
  assert.equal(seq.current(), 0);
  const first = seq.next();
  const second = seq.next();
  assert.equal(first, 1);
  assert.equal(second, 2);
  assert.equal(seq.current(), 2);
  assert.equal(seq.isCurrent(second), true, '最后一次发起的回执可以落地');
  assert.equal(seq.isCurrent(first), false, '更早的回执一律作废');
  assert.equal(seq.isCurrent(0), false);
  assert.equal(seq.isCurrent(undefined), false);
  // 两把令牌互不影响（碎片面板的选择 / 刷新各一把）
  const other = staleGuard.createSeq();
  assert.equal(other.current(), 0);
  other.next();
  assert.equal(seq.isCurrent(second), true);
});

// ---------- sameIdentity ----------
test('sameIdentity：键集合与每个值都相同才算同一份；缺一侧 / 多键 / 值不同都作废', () => {
  assert.equal(staleGuard.sameIdentity({ mode: 'all' }, { mode: 'all' }), true);
  assert.equal(
    staleGuard.sameIdentity({ mode: 'range', from: 2, to: 2 }, { mode: 'range', from: 2, to: 2 }),
    true
  );
  assert.equal(staleGuard.sameIdentity({ mode: 'range', from: 2, to: 2 }, { mode: 'range', from: 2, to: 3 }), false);
  assert.equal(staleGuard.sameIdentity({ mode: 'range', from: 2, to: 2 }, { mode: 'range', from: 2 }), false, '键少了不算同一份');
  assert.equal(staleGuard.sameIdentity({ mode: 'all' }, { mode: 'all', from: 1 }), false, '键多了不算同一份');
  assert.equal(staleGuard.sameIdentity(null, { mode: 'all' }), false);
  assert.equal(staleGuard.sameIdentity({ mode: 'all' }, null), false);
  assert.equal(staleGuard.sameIdentity({}, {}), false, '空对象不当成同一份（两边都没传）');
});

// ---------- chapterIdentity / sameChapterIdentity ----------
test('chapterIdentity：记下书 / 第几章 / 章 id；没有章时 chapterId=null', () => {
  const state = {
    bookPath: 'C:/书库/书甲',
    index: 1,
    chapters: [
      { id: 'c1', name: '第一章' },
      { id: 'c2', name: '第二章' }
    ]
  };
  assert.deepEqual(staleGuard.chapterIdentity(state), {
    bookPath: 'C:/书库/书甲',
    chapterIndex: 1,
    chapterId: 'c2'
  });
  assert.deepEqual(staleGuard.chapterIdentity({ bookPath: null, index: -1 }), {
    bookPath: '',
    chapterIndex: -1,
    chapterId: null
  });
  assert.deepEqual(staleGuard.chapterIdentity({ chapters: [{ id: 'c1' }], index: 5 }), {
    bookPath: '',
    chapterIndex: 5,
    chapterId: null
  });
  assert.deepEqual(staleGuard.chapterIdentity(null), { bookPath: '', chapterIndex: -1, chapterId: null });
  // 章 id 统一转字符串，null / undefined 都归 null（比较时一致）
  assert.equal(staleGuard.chapterIdentity({ chapters: [{ id: 7 }], index: 0 }).chapterId, '7');
});

test('sameChapterIdentity：书 / 章序号 / 章 id 任一不同即作废；切书、切章、重载都算', () => {
  const base = { bookPath: 'C:/书库/书甲', chapterIndex: 0, chapterId: 'c1' };
  assert.equal(staleGuard.sameChapterIdentity(base, { ...base }), true);
  assert.equal(staleGuard.sameChapterIdentity(base, { ...base, bookPath: 'C:/书库/书乙' }), false, '换书');
  assert.equal(staleGuard.sameChapterIdentity(base, { ...base, chapterIndex: 1 }), false, '换章');
  assert.equal(staleGuard.sameChapterIdentity(base, { ...base, chapterId: 'c2' }), false, '章 id 变了');
  assert.equal(staleGuard.sameChapterIdentity(null, base), false);
  assert.equal(staleGuard.sameChapterIdentity(base, undefined), false);
});

// ---------- 边界：只放判定，不碰运行环境 ----------
test('静态闸门：stale-guard.js 只放纯判定（不 require / 不摸 DOM / 不建定时器）', () => {
  assert.equal(/\brequire\s*\(/.test(guardCode), false, 'stale-guard.js 不许 require');
  assert.equal(/document\.|window\.addEventListener|setTimeout\(|setInterval\(/.test(guardCode), false);
  assert.equal(/\bipcRenderer\b|\bnode:fs\b/.test(guardCode), false);
  assert.deepEqual(Object.keys(staleGuard).sort(), ['chapterIdentity', 'createSeq', 'sameChapterIdentity', 'sameIdentity']);
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWStaleGuard，且不乱造别的全局', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(guardSrc, context, { filename: 'renderer/stale-guard.js' });
  assert.equal(typeof win.CWStaleGuard, 'object');
  assert.deepEqual(Object.keys(win.CWStaleGuard).sort(), ['chapterIdentity', 'createSeq', 'sameChapterIdentity', 'sameIdentity']);
  assert.equal(win.CWModalQueue, undefined, '单独加载 stale-guard 不该顺手造出别的全局');
  assert.equal(win.CWLongOpLogic, undefined);
});

// ---------- 接线：8 个消费者拿同一个助手 ----------
test('接线：index.html 在 8 个消费者之前加载 stale-guard.js，且只加载一次', () => {
  const at = indexSrc.indexOf('<script src="stale-guard.js"></script>');
  assert.notEqual(at, -1, 'index.html 没加载 stale-guard.js');
  assert.equal(indexSrc.split('stale-guard.js').length - 1, 1, 'stale-guard.js 只许加载一次');
  assert.ok(at < indexSrc.indexOf('src="renderer.js"'), 'stale-guard.js 必须在 renderer.js 之前');
  for (const consumer of CONSUMERS) {
    const name = consumer.replace('renderer/', '');
    const moduleAt = indexSrc.indexOf(`<script src="${name}"></script>`);
    assert.notEqual(moduleAt, -1, `index.html 没加载 ${name}`);
    assert.ok(at < moduleAt, `stale-guard.js 必须排在 ${name} 之前`);
  }
});

test('接线：8 个消费者都从 host 拿 staleGuard（REQUIRED_HOST + create 校验），不各写一份令牌', () => {
  for (const consumer of CONSUMERS) {
    const src = read(consumer);
    assert.match(src, /'staleGuard'/, `${consumer} 的 REQUIRED_HOST 少了 staleGuard`);
    assert.match(src, /host\.staleGuard/, `${consumer} 没有校验 host.staleGuard`);
    assert.match(src, /staleGuard\.(createSeq|chapterIdentity|sameIdentity|sameChapterIdentity)\(/, `${consumer} 没真的用共享助手`);
  }
  // renderer.js 只装配一次：模块级 const + 8 个 host 各传一份
  assert.match(rendererSrc, /const staleGuard = window\.CWStaleGuard;/);
  assert.ok(
    (rendererSrc.match(/\bstaleGuard\b/g) || []).length >= 9,
    'renderer.js 的 staleGuard 装配少了（模块级 const + 8 个 host）'
  );
});