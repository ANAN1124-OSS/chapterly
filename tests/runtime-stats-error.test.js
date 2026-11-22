// MC-2（五-L21）：统计写失败的原因字段（statsError）过去把 err.message 原样跨 IPC ——
// fs 错误形如 `ENOSPC: no such file or directory, open 'C:\Users\<用户名>\AppData\...\stats.json'`，
// 绕过 fail() / core/error-text 的统一脱敏出口（main.js 的 fail() 注释与 error-text.js 红线同一条）。
// 今天渲染层没读这个字段，属于「已过界但还没显示」；未来任何面板显示它就会泄漏本机路径。
//
// capture:commit-record 与 chapter:save 两处同根因（同一条统计写失败 → statsError 回包），一起收口。
// 静态闸门：main.js 是启动入口，单测按源码钉住出口链路（与 error-text.test.js 的其它 main.js 闸门同口径）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
// MAIN-03：chapter:save 已下沉 ipc/save.js —— 保存链的统计出口闸门改读新落点。
const SAVE = fs.readFileSync(path.join(ROOT, 'ipc', 'save.js'), 'utf8');

function blockOf(marker, endMarker) {
  const start = MAIN.indexOf(marker);
  assert.ok(start > 0, `找不到 ${marker}`);
  const end = MAIN.indexOf(endMarker, start);
  assert.ok(end > start, `找不到 ${marker} 的结束锚点 ${endMarker}`);
  return MAIN.slice(start, end);
}

test('MC-2（五-L21）：statsError 只回 describeForUi 的脱敏文案，原始 err.message 不许跨 IPC', () => {
  // I6（三审，断言跟错）：mutation 收编常量表后收尾是 `MUTATION.WRITE`（值仍是 'write'）。
  const capture = blockOf("handleBook('capture:commit-record'", '}, { mutation: MUTATION.WRITE });');
  assert.match(
    capture,
    /statsError = errorText\.describeForUi\(err\)\.message;/,
    '捕获建章：统计写失败的原因必须先过 error-text 再回渲染层'
  );
  assert.equal(/statsError = err\.message/.test(capture), false, '不许把原始 message（含本机路径）直接带回');

  // chapter:save 的同一字段（变量名 statsErr）同口径 —— 两处一条链路，不许只修一处
  assert.match(
    SAVE,
    /statsError = errorText\.describeForUi\(statsErr\)\.message;/,
    '保存链：statsError 同样走 describeForUi'
  );
  assert.equal(
    /statsError = (?:err|statsErr)\.message/.test(MAIN + '\n' + SAVE),
    false,
    '主进程 IPC 源码里不许再出现裸 .message 赋给 statsError'
  );
});
