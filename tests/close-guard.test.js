// C5（审计 E5/S5）：关窗放行改主进程交叉判定。
//
// 问题：app:close-ready 完全信任渲染层传上来的 allowed——主进程自己就有 session.dirty
// （渲染层持续上报）和最近一次保存成功回执，却没用。渲染层一个坏回包（或注入脚本）就能让
// 主进程关掉一个还有未保存修改的窗口。
//
// 现在的判定：allowed === true 且（session.dirty 为 false 或「保存回执晚于这次变脏的时间」）。
// 「不保存退出」是作者主动丢弃：渲染层先把脏状态清成 false 再回 allowed（见 renderer 的
// discardUnsavedForClose）。真实行为由 E2E 第 10 / 11 / 12 / 24 / 55 组覆盖，这里钉接线。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const MAIN = read('main.js');
const RENDERER = read('renderer/renderer.js');

function between(source, from, to) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `找不到：${from}`);
  const end = source.indexOf(to, start + 1);
  assert.ok(end > start, `找不到结尾：${to}`);
  return source.slice(start, end);
}

test('静态闸门：主进程用 session.dirty + 最近保存回执交叉判定关窗（E5/S5）', () => {
  const sessionSrc = between(MAIN, 'function createSession(browserWin) {', '\n}');
  assert.match(sessionSrc, /dirtyAt: 0/, 'session 要记「这次变脏」的时间');
  assert.match(sessionSrc, /lastSaveAt: 0/, 'session 要记最近一次保存成功回执');
  // 保存成功回执：chapter:save 成功尾部写 lastSaveAt
  const saveAt = MAIN.indexOf("handleBook('chapter:save'");
  assert.ok(saveAt > 0);
  const saveBody = MAIN.slice(saveAt, MAIN.indexOf('\n  });', saveAt));
  assert.match(saveBody, /session\.lastSaveAt = Date\.now\(\);/, '章节保存成功要留回执时间');
  // app:dirty：变脏时记时间，干净时清零
  const dirtySrc = between(MAIN, "ipcMain.on('app:dirty'", '\n  });');
  assert.match(dirtySrc, /session\.dirtyAt = Date\.now\(\)/, '变脏要记时间');
  assert.match(dirtySrc, /if \(!next\) session\.dirtyAt = 0;/, '回到干净要清零');
  // close-ready：allowed 之外还要看 dirty / 回执
  const closeSrc = between(MAIN, "ipcMain.on('app:close-ready'", '\n  });');
  assert.match(closeSrc, /const savedAfterDirty = session\.lastSaveAt > 0 && session\.lastSaveAt >= session\.dirtyAt;/);
  assert.match(closeSrc, /const okToClose = Boolean\(allowed\) && \(!session\.dirty \|\| savedAfterDirty\);/);
  assert.match(closeSrc, /code: 'CLOSE_DIRTY'/, '被拦下要留一条日志，方便排查「关不掉窗」');
  // e2eCloseReady 记录的必须是主进程判定后的结果（E2E 用它断言，语义不能退化成 allowed）
  assert.match(closeSrc, /session\.e2eCloseReady = okToClose;/);
  assert.match(closeSrc, /e2eLastCloseReady = okToClose;/);
});

test('静态闸门：渲染层「不保存退出」先如实清掉脏状态，再放行关窗（E5/S5）', () => {
  const helperSrc = between(RENDERER, 'function discardUnsavedForClose() {', '\n  }');
  assert.match(helperSrc, /state\.dirty = false;/, '主动丢弃要清脏状态');
  assert.match(helperSrc, /updateStatus\(\);/, '清完要上报主进程（app:dirty）');
  const discardSrc = between(RENDERER, "if (action === 'discard') {", 'return;');
  assert.match(discardSrc, /discardUnsavedForClose\(\);[\s\S]{0,80}api\.closeReady\(true\);/, 'discard 分支要先清脏再放行');
  // 保存失败后选「放弃修改退出」这条也要清
  const failedDiscardSrc = between(RENDERER, "if (again.action !== 'discard') {", 'api.closeReady(true);');
  assert.match(failedDiscardSrc, /discardUnsavedForClose\(\);/, '保存失败后放弃退出也要先清脏');
  // 取消分支仍然明确拒绝关窗
  assert.match(RENDERER, /if \(action === 'cancel'\) \{[\s\S]{0,80}api\.closeReady\(false\);/, '取消仍要拒绝关窗');
});
