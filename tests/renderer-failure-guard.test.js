// B1（审计 E2 / E6）：渲染层的后台失败必须可观测。
//
// 审计结论：渲染层**没有** window.addEventListener('unhandledrejection') 兜底；生产包不开放 DevTools，
// 后台失败（索引建立 / 捕获提交 / 回书架 …）对用户完全不可见。这一轮补了三层：
//   1) 全局兜底：init 最先挂 unhandledrejection → 留痕 + 一句**固定**提示（绝不拼 event.reason）；
//   2) 三条关键链（回书架 / 切章 / 删章）的 .then 补 .catch，失败出声；
//   3) 4 处裸 await api.* 改走统一 call()（preload 在 IPC 异常时回 {ok:false} 而不抛，
//      原来那些 catch 几乎永不触发，失败被悄悄丢掉）。
//
// renderer.js 是浏览器侧 IIFE，node:test 里跑不起来，所以沿用仓库里「读源码做静态闸门」的先例
// （见 tests/renderer-startup.test.js / tests/ipc-limits.test.js）。这些位置以后重构可以改形，
// 但「后台失败不许静默」这条不许丢，改的时候同步改这里。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const RENDERER = read(path.join('renderer', 'renderer.js'));
const DRAG_SORT = read(path.join('renderer', 'drag-sort-ui.js'));
const SHELF_NAV = read(path.join('renderer', 'shelf-nav-ui.js'));
const PRELOAD = read('preload.js');
const MAIN = read('main.js');

// 取一个函数体：`function 名字(...) { ... 首个第 0 列的 }`
function functionBody(source, name) {
  const match = source.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`, 'm'));
  assert.ok(match, `找不到函数 ${name}()`);
  return match[0];
}

test('B1 全局兜底：init 最先挂 unhandledrejection，且提示是一句固定文案（不拼 reason）', () => {
  // 注册位置：init 的第一件事就是装兜底（比 bindEvents 还早，后面任何一步失败都还能留痕）
  assert.match(
    RENDERER,
    /async function init\(\) \{[\s\S]{0,200}?installFailureGuard\(\);[\s\S]{0,80}?bindEvents\(\);/,
    'init 必须先 installFailureGuard() 再 bindEvents()'
  );
  // 只挂一次（重复挂会让同一条拒绝弹两次提示）
  const guard = functionBody(RENDERER, 'installFailureGuard');
  assert.match(guard, /if \(failureGuardInstalled\) return;/, '重复安装要直接返回');
  assert.match(guard, /window\.addEventListener\('unhandledrejection',/, '必须注册 unhandledrejection');
  assert.match(guard, /reportBackgroundFailure\('unhandledrejection'/, '监听器里必须留痕');
  // 提示文案写死：绝不能把 event.reason（可能含正文 / 本机路径）拼进界面
  assert.match(
    guard,
    /toast\('有一项后台操作失败了，已写进日志。写作和保存不受影响。', 'warn'\)/,
    '必须给一句固定文案的 toast'
  );
  assert.doesNotMatch(guard, /toast\(`/, '提示文案不许是模板串（会拼进事件内容）');
  assert.doesNotMatch(guard, /toast\([^)]{0,120}?reason/, '提示里不许出现 event.reason');
  // 连击不刷屏：留痕自带 1 秒节流，提示只在真的上报了那一次弹
  assert.match(guard, /if \(reported\) \{/, '只在真的留痕了才弹提示');
  assert.match(functionBody(RENDERER, 'reportBackgroundFailure'), /FAILURE_REPORT_MIN_GAP_MS/, '留痕必须有节流');
});

test('B1 留痕：走 preload 的 reportRendererError，只带 kind / code / message 三个短字符串', () => {
  const reporter = functionBody(RENDERER, 'reportBackgroundFailure');
  assert.match(reporter, /api\.reportRendererError\(\{/, '必须走白名单 IPC（不新增裸 IPC）');
  // 载荷只许这三个字段：多带一个正文 / 路径就等于把红线挪走了
  const payload = reporter.slice(reporter.indexOf('api.reportRendererError({'));
  const payloadBlock = payload.slice(0, payload.indexOf('})'));
  const keys = [...payloadBlock.matchAll(/^\s+(\w+)\s*[:,]/gm)].map((item) => item[1]);
  assert.deepEqual(keys.sort(), ['code', 'kind', 'message'], '上报字段只有 kind / code / message');
  // preload 白名单 + 主进程 handler 同名频道
  assert.match(PRELOAD, /reportRendererError: \(payload\) => invoke\('app:report-renderer-error', payload\)/);
  assert.match(MAIN, /handle\('app:report-renderer-error'/, '主进程必须有同名 handle（来源由 handle() 校验 BAD_SENDER）');
  // 主进程侧：白名单 + 与 fail() 同一条脱敏链路 + 走诊断日志
  assert.match(MAIN, /const RENDERER_FAILURE_KINDS = new Set\(\[/, 'kind 必须有白名单');
  assert.match(MAIN, /errorText\.sanitizeFailureReport\(payload, RENDERER_FAILURE_KINDS\)/);
  assert.match(MAIN, /logError\(\s*'renderer-failure'/, '必须落一条诊断日志');
  // 形状不合法不抛错（留痕失败不该反过来干扰渲染层）
  const handlerMatch = MAIN.match(/handle\('app:report-renderer-error'[\s\S]*?return \{ accepted: true \};[\s\S]{0,40}?\}\);/);
  assert.ok(handlerMatch, '找不到 app:report-renderer-error 的 handler 体');
  const handlerBlock = handlerMatch[0];
  assert.match(handlerBlock, /return \{ accepted: false \};/);
  assert.doesNotMatch(handlerBlock, /throw /, '上报失败不许抛错');
});

test('B1 关键链：三处 .then 都有 .catch（回书架 / 切章 / 删章），失败出声且留痕', () => {
  // 1) 捕获超限 → 回书架 → 导入：backToShelf 失败原来会让导入对话框永远不弹
  assert.match(
    RENDERER,
    /void backToShelf\(\)\s*\n?\s*\.then\(\(\) => onImportClick\(\)\)\s*\n?\s*\.catch\(\(err\) => reportChainFailure\('返回书架失败', err\)\);/,
    'backToShelf().then(...) 必须补 .catch'
  );
  // 2) Ctrl+PageUp / PageDown 切章
  assert.match(
    RENDERER,
    /void switchChapter\(target\)[\s\S]{0,220}?\.catch\(\(err\) => reportChainFailure\('切换章节失败', err\)\)/,
    'switchChapter(target).then(...) 必须补 .catch'
  );
  // 3) 章节列表焦点里按 Delete 删章
  assert.match(
    RENDERER,
    /void deleteChapterAt\(position\)[\s\S]{0,220}?\.catch\(\(err\) => reportChainFailure\('删除这一章失败', err\)\)/,
    'deleteChapterAt(position).then(...) 必须补 .catch'
  );
  // 统一出口：先留痕，再给一句可读提示（口径与仓库其它失败提示一致）
  const chain = functionBody(RENDERER, 'reportChainFailure');
  assert.match(chain, /reportBackgroundFailure\('ui-chain', err\)/);
  assert.match(chain, /toast\(/, '必须 let 作者看见');
});

test('B1 / E6：4 处裸 await api.* 全部改走统一 call()（失败才真的进 catch）', () => {
  // renderer.js：切章后记「上次打开的章」
  assert.equal(
    /await api\.setLastOpenChapter\(/.test(RENDERER),
    false,
    'renderer.js 里不许再有裸 await api.setLastOpenChapter(...)'
  );
  assert.match(RENDERER, /await call\(api\.setLastOpenChapter, state\.bookPath, chapter\.id,/);
  // drag-sort-ui.js：两条写盘路径（drop / 键盘移动）后各一处
  assert.equal(
    DRAG_SORT.includes('await api.setLastOpenChapter('),
    false,
    'drag-sort-ui.js 里不许再有裸 await api.setLastOpenChapter(...)'
  );
  assert.equal(
    (DRAG_SORT.match(/await call\(api\.setLastOpenChapter,/g) || []).length,
    2,
    'drag-sort-ui.js 两处都要走 call()'
  );
  // shelf-nav-ui.js：回书架时释放「打开中的书」登记
  assert.equal(
    SHELF_NAV.includes('await api.releaseBook('),
    false,
    'shelf-nav-ui.js 里不许再有裸 await api.releaseBook()'
  );
  assert.match(SHELF_NAV, /await call\(api\.releaseBook\)/);
});
