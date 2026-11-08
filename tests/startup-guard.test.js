// A2（审计 #8 / E3、E4）：启动参数失败与启动链失败都不许「静默崩 / 停在半初始化」。
//
// main.js 是 Electron 主进程入口，node:test 里起不来，沿用仓库「读源码做静态闸门」的先例
// （tests/ipc-limits.test.js / tests/config-gate.test.js / tests/renderer-startup.test.js）。
// 这里只钉住三条不许丢的性质：
//   1. `--user-data` 的 mkdirSync 必须包在 try/catch 里，失败走 failStartup（而不是裸抛）；
//   2. failStartup 只写 stderr（错误码 + 脱敏文案）后 app.exit(1)：
//      不碰 logError（日志就写在那个坏目录里）、不打 err.message / err.stack / 完整路径；
//   3. whenReady 链必须有顶层 .catch（logError + app.exit(1)），不能停在半初始化。
// 另外钉住「打包版仍认 --user-data / --books-root」这条刻意保留的行为：A2 只加防御，不删开关。
// 以后重构可以改形，但这几条不许丢；改的时候同步改这里。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');

// 取一段源码：从锚点切到结束锚点之前（元素用 includes 定位，不依赖行号）。
function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `找不到锚点：${startMarker}`);
  const rest = source.slice(start);
  if (!endMarker) return rest;
  const end = rest.indexOf(endMarker);
  assert.notEqual(end, -1, `找不到结束锚点：${endMarker}`);
  return rest.slice(0, end);
}

const USER_DATA_BLOCK = slice(MAIN, "const userDataArg = argValue('user-data');", '// ---------- 多窗口会话 ----------');
const FAIL_STARTUP = slice(MAIN, 'function failStartup(what, err) {', '\n// ---------- 崩溃 / 错误日志');
const WHEN_READY = slice(MAIN, 'app.whenReady()', '\n  // 退出时主动注销全局快捷键');

test('静态闸门：--user-data 建目录失败不裸抛，改走 failStartup（A2 / E3）', () => {
  // mkdir 必须在 try 里
  assert.match(
    USER_DATA_BLOCK,
    /try \{\n\s+fsSync\.mkdirSync\(userDataArg, \{ recursive: true \}\);\n\s+\} catch \(err\) \{/,
    'mkdirSync 必须包在 try/catch 里（E3：路径非法/权限不足时不许直接终止进程）'
  );
  // 裸调用（两空格缩进 = 不在 try 内）不许回来
  assert.doesNotMatch(
    USER_DATA_BLOCK,
    /\n {2}fsSync\.mkdirSync\(userDataArg/,
    'mkdirSync 不许再写成裸调用（E3 会复发成「双击没反应」）'
  );
  // 失败分支必须交给 failStartup，而不是 console.error / 空 catch
  assert.match(USER_DATA_BLOCK, /catch \(err\) \{[\s\S]{0,240}?failStartup\('配置目录', err\);/, 'mkdir 失败必须走 failStartup');
  // 成功路径照旧：先建目录、再 setPath（顺序反了等于把路径写进一个不存在的目录）
  const mkdirAt = USER_DATA_BLOCK.indexOf('fsSync.mkdirSync(userDataArg');
  const setPathAt = USER_DATA_BLOCK.indexOf("app.setPath('userData', userDataArg)");
  assert.ok(mkdirAt !== -1 && setPathAt !== -1 && mkdirAt < setPathAt, '仍要先建目录再 setPath');
  // 默认目录（chapter-writer，不换名不换数据位置）这条分支也要留着
  assert.match(
    USER_DATA_BLOCK,
    /path\.join\(app\.getPath\('appData'\), 'chapter-writer'\)/,
    '没有 --user-data 时仍回落到 chapter-writer（换名不换数据位置）'
  );
});

test('静态闸门：failStartup 只写 stderr + 脱敏文案后退出（A2 / E3）', () => {
  assert.match(FAIL_STARTUP, /errorText\.describeForUi\(err\)/, '文案必须走 core/error-text 脱敏');
  assert.match(FAIL_STARTUP, /process\.stderr\.write\(/, '启动期还没有界面，失败说明只能写 stderr');
  assert.match(FAIL_STARTUP, /app\.exit\(1\)/, '失败必须带退出码 1 退出（不许静默崩）');
  // 不许把原始错误 / 堆栈 / 完整路径打到控制台
  assert.doesNotMatch(FAIL_STARTUP, /console\.(error|log|warn)/, '不许用 console.* 打原始错误');
  assert.doesNotMatch(FAIL_STARTUP, /err\.message|err\.stack|String\(err\)/, '不许直接打印 err.message / err.stack');
  // 不许走 logError：出问题的目录正是日志要写进去的目录，再写一次只会再失败一次
  assert.doesNotMatch(FAIL_STARTUP, /logError\(/, 'failStartup 不许走 logError（日志目录可能正是失败点）');
});

test('静态闸门：whenReady 链有顶层 catch（A2 / E4）', () => {
  // .catch 必须挂在 whenReady 这条链上，且在最后一个启动步骤之后
  const thenAt = WHEN_READY.indexOf('.then(async () => {');
  const catchAt = WHEN_READY.indexOf('}).catch((err) => {');
  const lastStepAt = WHEN_READY.indexOf('registerCaptureShortcut();');
  assert.ok(thenAt !== -1, 'whenReady 仍要挂 .then（启动流程本身不变）');
  assert.notEqual(catchAt, -1, 'whenReady 链必须有顶层 .catch（E4：不许停在半初始化）');
  assert.ok(lastStepAt !== -1 && lastStepAt < catchAt, '顶层 catch 必须罩住整条启动链');
  const tail = WHEN_READY.slice(catchAt);
  assert.match(tail, /logError\('startup', err\)/, '顶层 catch 要先留一条脱敏日志');
  assert.match(tail, /app\.exit\(1\)/, '顶层 catch 里必须 app.exit(1)（半初始化不如不启动）');
  // catch 里同样不许打原始堆栈
  assert.doesNotMatch(tail, /console\.error\(err|err\.stack/, '顶层 catch 不许把原始堆栈丢到控制台');
});

test('静态闸门：--user-data / --books-root 两个隔离开关仍然保留（A2 只加防御）', () => {
  // README「已知限制」与 S1 已记录：安装版冒烟刻意保留，A2 不许顺手关掉
  assert.match(MAIN, /const userDataArg = argValue\('user-data'\);/, '--user-data 仍要认');
  assert.match(MAIN, /const booksRootOverride = argValue\('books-root'\);/, '--books-root 仍要认');
  // 打包版判定仍是一处（不留第二套开关口径）
  assert.match(MAIN, /const packagedApp = app\.isPackaged === true;/, '打包版判定不变');
});
