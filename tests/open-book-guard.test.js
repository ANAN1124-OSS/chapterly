// 1.6.0 H1（审计 E-01，丢稿类）：换书前必须先处理未保存的修改。
//
// 问题：`openBookByPath()` 直接从磁盘重开另一本书，编辑区里没保存的字被整体换掉且不留痕
// （命令面板 / 书签跨书 / 书籍信息「章节命中」/ 书架点书四个入口都走它）。
//
// 这里钉两件事：
//   ① 决策纯逻辑（renderer/open-book-guard.js）：dirty + 作者的三种选择（取消 / 丢弃 / 保存）
//      → 继续换书还是停在原地；保存失败一律停下，未知选择一律回到「问一次」而不是偷偷继续。
//   ② 源码闸门：换书入口只有 `openBookByPath()` 一个，它必须先过守卫再 `api.openBook`；
//      其它模块（书签 / 书籍信息 / 测试钩子 / 书架）不许自己调 `api.openBook` 绕过守卫。
// UI 时序（真弹窗、真保存）在 E2E 第 75 组里真跑。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const guard = require('../renderer/open-book-guard.js');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

// 取函数体：从 `async function openBookByPath(` 起，到同缩进的 `\n  }\n` 结束。
function sliceFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `源码里找不到 ${signature}`);
  const end = source.indexOf('\n  }\n', start);
  assert.ok(end > start, `${signature} 的函数体没找到结尾`);
  return source.slice(start, end);
}

// ---------- ① 决策纯逻辑 ----------

test('换书守卫：没有未保存的修改时直接继续，不弹三选一', () => {
  assert.deepEqual(guard.decideOpenBook({ dirty: false }), { action: 'proceed', reason: 'clean' });
  // 坏输入不炸：null / 字符串 / 空对象都按「不脏」处理
  assert.equal(guard.decideOpenBook(null).action, 'proceed');
  assert.equal(guard.decideOpenBook(undefined).action, 'proceed');
  assert.equal(guard.decideOpenBook('dirty').action, 'proceed');
  assert.equal(guard.decideOpenBook({}).action, 'proceed');
  // dirty 只认严格的 true（避免 'false' / 1 这类值误触发换书弹窗）
  assert.equal(guard.decideOpenBook({ dirty: 'false' }).action, 'proceed');
  assert.equal(guard.decideOpenBook({ dirty: 1 }).action, 'proceed');
});

test('换书守卫：有未保存的修改且还没选 → 先问（绝不直接继续）', () => {
  const decided = guard.decideOpenBook({ dirty: true });
  assert.equal(decided.action, 'prompt');
  assert.equal(decided.reason, 'unsaved');
  // 未知 / 大小写不对的选择也回到「问一次」，不能当成取消，更不能当成继续
  for (const choice of [null, undefined, '', 'yes', 'SAVE', 'Discard', 0, {}]) {
    const again = guard.decideOpenBook({ dirty: true, choice });
    assert.equal(again.action, 'prompt', `choice=${JSON.stringify(choice)} 应回到 prompt`);
  }
});

test('换书守卫：选「取消」→ 停下（正文与 dirty 都留在原地）', () => {
  const decided = guard.decideOpenBook({ dirty: true, choice: 'cancel' });
  assert.deepEqual(decided, { action: 'abort', reason: 'canceled' });
  // 取消时即使带着一个「保存成功」也不许继续：作者点的是取消
  assert.equal(guard.decideOpenBook({ dirty: true, choice: 'cancel', saveResult: { ok: true } }).action, 'abort');
});

test('换书守卫：选「不保存，丢弃修改」→ 继续换书', () => {
  assert.deepEqual(guard.decideOpenBook({ dirty: true, choice: 'discard' }), {
    action: 'proceed',
    reason: 'discarded'
  });
});

test('换书守卫：选「保存并继续」→ 旧书落盘成功才继续', () => {
  assert.deepEqual(guard.decideOpenBook({ dirty: true, choice: 'save', saveResult: { ok: true } }), {
    action: 'proceed',
    reason: 'saved'
  });
});

test('换书守卫：保存失败 / 没拿到保存结果 → 停在原地，错误原样带出', () => {
  const failed = guard.decideOpenBook({
    dirty: true,
    choice: 'save',
    saveResult: { ok: false, message: '磁盘满了' }
  });
  assert.deepEqual(failed, { action: 'abort', reason: 'save-failed', message: '磁盘满了' });
  // 调用方忘了传 saveResult：保守判失败（不能因为「没结果」就当成功继续而丢字）
  const missing = guard.decideOpenBook({ dirty: true, choice: 'save' });
  assert.equal(missing.action, 'abort');
  assert.equal(missing.reason, 'save-failed');
  assert.equal(missing.message, '');
  assert.equal(guard.decideOpenBook({ dirty: true, choice: 'save', saveResult: {} }).action, 'abort');
});

test('换书守卫：纯函数 —— 不改入参，同样输入两次结果一致', () => {
  const input = { dirty: true, choice: 'save', saveResult: { ok: true } };
  const snapshot = JSON.stringify(input);
  const first = guard.decideOpenBook(input);
  const second = guard.decideOpenBook(input);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(input), snapshot, '入参没被改');
  assert.notEqual(first, second, '每次都返回新对象');
});

// ---------- ② 源码闸门 ----------

test('换书入口闸门：openBookByPath 先过守卫、再 api.openBook', () => {
  const source = read('renderer/renderer.js');
  const body = sliceFunction(source, 'async function openBookByPath(');
  const guardAt = body.indexOf('openBookGuard.decideOpenBook');
  const openAt = body.indexOf('call(api.openBook');
  assert.ok(guardAt >= 0, 'openBookByPath 里没有调用换书守卫');
  assert.ok(openAt > guardAt, '换书守卫必须在 call(api.openBook) 之前');
  // 守卫复用现成的三选一与保存：取消 / 保存失败都 return，不许落到 api.openBook
  assert.match(body, /askUnsaved\(/, '守卫要复用 askUnsaved 三选一');
  assert.match(body, /saveCurrent\(/, '选「保存并继续」要走 saveCurrent');
  // 守卫不通过必须原地返回（REDT-A-05 起是可判定的 { ok:false, canceled:true }，不再是裸 return）
  assert.match(body, /if \(guard\.action !== 'proceed'\) return \{ ok: false, canceled: true \};/, '守卫不通过必须原地返回');
});

test('换书入口闸门：四个入口（命令面板 / 书签跨书 / 章节命中 / 书架点书）都走 openBookByPath', () => {
  const renderer = read('renderer/renderer.js');
  // 命令面板「打开《书》」
  assert.match(renderer, /void openBookByPath\(book\.path\);/, '命令面板换书要走 openBookByPath');
  // 书架书卡（书籍信息模块渲染的那张卡也是这个动作）
  assert.match(renderer, /openBookByPath\(card\.dataset\.path\)/, '书架点书要走 openBookByPath');
  // 「章节命中」：openBookAtChapter 就是带 chapterIndex 的 openBookByPath
  assert.match(
    renderer,
    /openBookAtChapter: \(bookPath, chapterIndex\) => openBookByPath\(bookPath, \{ chapterIndex \}\)/,
    '章节命中要走 openBookByPath'
  );
  // 书签跨书
  assert.match(read('renderer/find-bookmark-ui.js'), /openBookByPath\(bookmark\.bookPath/, '书签跨书要走 openBookByPath');
  // 测试钩子也只走同一个入口（E2E 才测得到真路径）
  assert.match(read('renderer/test-hooks.js'), /await openBookByPath\(bookPath\)/, '测试钩子 openBookPath 要走 openBookByPath');
});

test('换书入口闸门：其它渲染层模块不许自己调 api.openBook 绕过守卫（编辑域只许删除卷撤销重开同一本书）', () => {
  const modules = fs
    .readdirSync(path.join(__dirname, '..', 'renderer'))
    .filter((name) => name.endsWith('.js') && name !== 'renderer.js');
  const offenders = [];
  for (const name of modules) {
    const source = read(`renderer/${name}`);
    if (/api\.openBook\b/.test(source)) offenders.push(name);
  }
  // WP17 A3 第四刀：deleteVolumeFlow 的撤销要在同一本书上重开书目（卷序 / 章归属一起回来），
  // 这是搬前 renderer.js 里就允许的「同一本书重载」，不是换书入口。只放行这一处，并把它钉死：
  //   · 只能有一处 api.openBook；· 只能重开注册撤销时捕获的 bookPath；· 必须在 deleteVolumeFlow 里。
  assert.deepEqual(offenders, ['chapter-ops-ui.js'], '除编辑域外不许有模块直接摸 api.openBook');
  const ops = read('renderer/chapter-ops-ui.js');
  assert.equal((ops.match(/api\.openBook\b/g) || []).length, 1, '编辑域只许一处 api.openBook（删除卷撤销）');
  assert.match(ops, /const reopened = await call\(api\.openBook, bookPath\);/);
  const volumeUndo = ops.slice(ops.indexOf('async function deleteVolumeFlow('), ops.indexOf('function openVolumeChooserInMenu('));
  assert.ok(volumeUndo.includes('call(api.openBook, bookPath)'), '重开书只能发生在删除卷撤销里');
});

test('换书入口闸门：renderer.js + 编辑域模块里直接 api.openBook 的调用只能是「同一本书从磁盘重载」', () => {
  const source = read('renderer/renderer.js');
  const ops = read('renderer/chapter-ops-ui.js');
  const direct = [
    ...(source.match(/call\(api\.openBook,\s*[^)]+\)/g) || []),
    ...(ops.match(/call\(api\.openBook,\s*[^)]+\)/g) || [])
  ];
  assert.equal(direct.length, 4, `直接 api.openBook 的处数变了（${direct.length}），请确认没有新增绕过守卫的换书路径`);
  for (const callLine of direct) {
    assert.match(
      callLine,
      /^call\(api\.openBook,\s*(state\.bookPath|bookPath)\)$/,
      `只允许重载当前书：${callLine}`
    );
  }
});

test('换书入口闸门：index.html 在 renderer.js 之前加载 open-book-guard.js', () => {
  const html = read('renderer/index.html');
  const moduleAt = html.indexOf('<script src="open-book-guard.js"></script>');
  const rendererAt = html.indexOf('<script src="renderer.js"></script>');
  assert.ok(moduleAt >= 0, 'index.html 没加载 open-book-guard.js');
  assert.ok(rendererAt > moduleAt, 'open-book-guard.js 必须排在 renderer.js 之前');
  assert.match(read('renderer/renderer.js'), /window\.CWOpenBookGuard/, 'renderer.js 要取 window.CWOpenBookGuard');
});
// ---------- 五-M3（SS-07）：开书目标章解析 ----------
// 缺陷：书架正文搜索按 chapterId + matchIndex 直达命中章；目标章在打开前被删时旧实现静默回落
// 上次阅读章，openBookByPath 又无条件把旧章的命中下标套上去（选区错位、无提示）。
// 修法：起点解析收进 resolveOpenTarget；没命中时 targetMissing=true，调用方提示且不套命中下标。
test('五-M3：resolveOpenTarget —— chapterId 命中用目标章；没命中回落上次阅读章并标 targetMissing', () => {
  const chapters = [
    { id: 'c1', name: '第一章' },
    { id: 'c2', name: '第二章' },
    { id: 'c3', name: '第三章' }
  ];
  assert.deepEqual(
    guard.resolveOpenTarget({ chapters, target: { chapterId: 'c2', matchIndex: 10 }, lastOpenChapterId: 'c3' }),
    { startIndex: 1, targetMissing: false },
    '目标章还在 → 直达（命中下标由调用方另核）'
  );
  assert.deepEqual(
    guard.resolveOpenTarget({ chapters, target: { chapterId: 'gone', matchIndex: 999 }, lastOpenChapterId: 'c3' }),
    { startIndex: 2, targetMissing: true },
    '目标章已删 → 回落上次阅读章，并且必须标 targetMissing'
  );
  assert.deepEqual(
    guard.resolveOpenTarget({ chapters, target: { chapterId: 'gone' }, lastOpenChapterId: 'gone-too' }),
    { startIndex: 0, targetMissing: true },
    '目标章与上次阅读章都没了 → 第 1 章 + targetMissing'
  );
  // 没有 chapterId 的「章节命中直达」：合法 0 起下标照旧生效；越界 / 坏值保持旧行为（静默回落、不提示）
  assert.deepEqual(
    guard.resolveOpenTarget({ chapters, target: { chapterIndex: 2 }, lastOpenChapterId: 'c1' }),
    { startIndex: 2, targetMissing: false }
  );
  assert.deepEqual(
    guard.resolveOpenTarget({ chapters, target: { chapterIndex: 9 }, lastOpenChapterId: 'c2' }),
    { startIndex: 1, targetMissing: false },
    '越界包丢（旧行为：回落，不冒充「目标章被删」）'
  );
  assert.deepEqual(
    guard.resolveOpenTarget({ chapters, lastOpenChapterId: 'c2' }),
    { startIndex: 1, targetMissing: false },
    '没有 target → 上次阅读章'
  );
  // 坏输入不炸
  assert.deepEqual(guard.resolveOpenTarget(null), { startIndex: 0, targetMissing: false });
  assert.deepEqual(guard.resolveOpenTarget({ chapters: null, target: 'x' }), { startIndex: 0, targetMissing: false });
});

test('五-M3 静态闸门：commitOpenBook 用 resolveOpenTarget；目标章没命中时不许把旧命中下标套到回落章', () => {
  const source = read('renderer/renderer.js');
  const commitBody = sliceFunction(source, 'async function commitOpenBook(');
  assert.match(commitBody, /openBookGuard\.resolveOpenTarget\(\{/);
  assert.match(commitBody, /return \{ ok: true, targetMissing: resolved\.targetMissing \};/);
  assert.equal(
    /if \(targetIndex >= 0\) startIndex = targetIndex;/.test(commitBody),
    false,
    '旧的「找不到 chapterId 就静默用 lastOpenChapterId」分支必须已经收编'
  );

  const openBody = sliceFunction(source, 'async function openBookByPath(');
  assert.match(openBody, /if \(committed\.targetMissing\) \{/, '目标章没命中要单独分支');
  assert.match(openBody, /toast\('查找命中的章节已经不在了/, '要给作者一条明确提示');
  // selectEditorRange 只许出现在 else（targetMissing 为假）分支里
  const missingAt = openBody.indexOf('if (committed.targetMissing)');
  const selectAt = openBody.indexOf('selectEditorRange(Number(target.matchIndex)');
  assert.ok(missingAt >= 0 && selectAt > missingAt, 'selectEditorRange 必须在 targetMissing 分支之后');
  assert.match(
    openBody.slice(missingAt, selectAt),
    /\} else \{/,
    '旧命中下标只能在「目标章仍命中」的 else 分支里套'
  );
});
