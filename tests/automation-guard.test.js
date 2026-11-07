// C2（审计 S2）：生产（app.isPackaged）禁 automation。
//
// 问题：`automation` 完全由 argv 决定。生产安装包带 `--e2e` 启动就会注册
// config:test-pick（可把 booksRoot 指到任意目录）、font:test-pick、update:test-mock
// 等自检频道，还会把窗口关闭 / 退出流程切到「自检不真关」的分支。
//
// 这里锁住：
//   1. isE2E / isBench / isContrast 三个开关都必须 `!packagedApp &&` 双判定；
//   2. --screenshot 在打包版里直接忽略；
//   3. automation 仍由这四个开关组成，自检频道仍只在 `if (automation)` 里注册；
//   4. 安装版冒烟要用的 --user-data 与 --books-root 不被误伤（--remote-debugging-port 是
//      Chromium 自己的开关，main.js 里根本不碰）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');

test('静态闸门：打包版不认 --e2e/--bench/--contrast/--screenshot（S2）', () => {
  assert.match(SOURCE, /const packagedApp = app\.isPackaged === true;/, '必须先算一次 app.isPackaged');
  assert.match(SOURCE, /const isE2E = !packagedApp && process\.argv\.includes\('--e2e'\);/, 'isE2E 要双判定');
  assert.match(SOURCE, /const isBench = !packagedApp && process\.argv\.includes\('--bench'\);/, 'isBench 要双判定');
  assert.match(SOURCE, /const isContrast = !packagedApp && process\.argv\.includes\('--contrast'\);/, 'isContrast 要双判定');
  assert.match(
    SOURCE,
    /const screenshotPath = packagedApp \? null : argValue\('screenshot'\);/,
    '打包版忽略 --screenshot'
  );
  assert.match(
    SOURCE,
    /const automation = isE2E \|\| isBench \|\| isContrast \|\| Boolean\(screenshotPath\);/,
    'automation 仍由四个开关组成'
  );
  // 自检频道必须仍只在 automation 分支注册（不只靠 argv）
  for (const channel of ['config:test-pick', 'font:test-pick', 'update:test-mock']) {
    const at = SOURCE.indexOf(`handle('${channel}'`);
    assert.ok(at > 0, `main.js 里找不到 ${channel}`);
    const guard = SOURCE.lastIndexOf('if (automation) {', at);
    assert.ok(guard > 0 && at - guard < 600, `${channel} 必须在 if (automation) 分支里注册`);
  }
  // 打包版即使带了 --e2e，渲染层的 ?test=1 也不该开（避免加载 test-hooks）
  assert.match(SOURCE, /if \(automation \|\| isE2E\) query\.test = '1';/, '测试钩子开关跟着 automation 走');
  // 安装版冒烟用的隔离参数不能被误伤
  assert.match(SOURCE, /const userDataArg = argValue\('user-data'\);/, '--user-data 必须保留');
  assert.match(SOURCE, /app\.setPath\('userData', userDataArg\);/, '--user-data 仍要生效');
  assert.match(SOURCE, /const booksRootOverride = argValue\('books-root'\);/, '--books-root 必须保留');
  assert.equal(SOURCE.includes("argValue('remote-debugging-port')"), false, 'main.js 不解析 --remote-debugging-port');
  assert.equal(
    SOURCE.includes("process.argv.includes('--remote-debugging-port')"),
    false,
    'main.js 不拦截 Chromium 的 --remote-debugging-port'
  );
});
