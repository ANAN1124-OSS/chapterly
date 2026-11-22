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

// T7（三审·低）：不再钉整句声明文本（`const isE2E = !packagedApp && process.argv.includes('--e2e');`）。
// 等价重构——把 `!packagedApp` 挪到后面、换引号、把三元拆成 if、加空格——都会假红，而真正要守的是
// 「布尔组合」：打包版必须先短路，且四个开关各自只认自己的 argv 项。下面按声明名取表达式再验组合。
function declarationExpr(source, name) {
  const marker = new RegExp(`^[ \\t]*const[ \\t]+${name}[ \\t]*=`, 'm');
  const match = marker.exec(source);
  assert.ok(match, `main.js 找不到 const ${name} = …`);
  const eq = source.indexOf('=', match.index);
  const semi = source.indexOf(';', eq);
  assert.ok(semi > eq, `const ${name} = … 少了分号`);
  return source.slice(eq + 1, semi).trim();
}

test('静态闸门：打包版不认 --e2e/--bench/--contrast/--screenshot（S2）', () => {
  assert.match(SOURCE, /const packagedApp = app\.isPackaged === true;/, '必须先算一次 app.isPackaged');
  // 三个自检开关：声明里的布尔组合必须同时有「非打包版」与自己的 argv 项（顺序 / 引号 / 写法不限）。
  const SWITCHES = [
    ['isE2E', '--e2e'],
    ['isBench', '--bench'],
    ['isContrast', '--contrast']
  ];
  for (const [name, flag] of SWITCHES) {
    const expr = declarationExpr(SOURCE, name);
    assert.match(expr, /!\s*packagedApp/, `${name} 必须双判定（!packagedApp，打包版直接短路）`);
    assert.ok(expr.includes(`'${flag}'`) || expr.includes(`"${flag}"`), `${name} 必须认 ${flag}`);
    assert.match(expr, /process\.argv\.includes\(/, `${name} 要从 process.argv 判定（不许读别的开关）`);
  }
  // --screenshot：打包版必须忽略（表达式里既要读这个参数、又要被 packagedApp 短路）。
  const screenshotExpr = declarationExpr(SOURCE, 'screenshotPath');
  assert.match(screenshotExpr, /packagedApp/, '--screenshot 必须受打包版短路');
  assert.match(screenshotExpr, /argValue\(\s*['"]screenshot['"]\s*\)/, '--screenshot 要走 argValue("screenshot")');
  assert.match(screenshotExpr, /packagedApp\s*\?\s*null\s*:/, '打包版取 null（忽略 --screenshot）');
  // automation 仍由这四个开关组成：四个成分都在、且没有第五个来源被偷偷并进来。
  const automationExpr = declarationExpr(SOURCE, 'automation');
  for (const token of ['isE2E', 'isBench', 'isContrast', 'screenshotPath']) {
    assert.ok(automationExpr.includes(token), `automation 少了 ${token}（自检开关必须四个成分齐）`);
  }
  const extra = automationExpr
    .split(/[\s|&!()]+/)
    .filter(Boolean)
    .filter((token) => !['isE2E', 'isBench', 'isContrast', 'screenshotPath', 'Boolean'].includes(token));
  assert.deepEqual(extra, [], `automation 里混进了未知成分：${extra.join(' / ')}`);
  // 自检频道必须仍只在 automation 分支注册（不只靠 argv）
  for (const channel of ['config:test-pick', 'font:test-pick', 'update:test-mock']) {
    const at = SOURCE.indexOf(`handle('${channel}'`);
    assert.ok(at > 0, `main.js 里找不到 ${channel}`);
    const guard = SOURCE.lastIndexOf('if (automation) {', at);
    assert.ok(guard > 0 && at - guard < 600, `${channel} 必须在 if (automation) 分支里注册`);
  }
  // 打包版即使带了 --e2e，渲染层的 ?test=1 也不该开（避免加载 test-hooks）：开关只跟 automation。
  assert.match(SOURCE, /if \(automation\) query\.test = '1';/, '测试钩子开关跟着 automation 走');
  // 安装版冒烟用的隔离参数不能被误伤
  assert.equal(declarationExpr(SOURCE, 'userDataArg'), "argValue('user-data')", '--user-data 必须保留');
  assert.match(SOURCE, /app\.setPath\(\s*'userData'\s*,\s*userDataArg\s*\)/, '--user-data 仍要生效');
  assert.equal(declarationExpr(SOURCE, 'booksRootOverride'), "argValue('books-root')", '--books-root 必须保留');
  // --remote-debugging-port 是 Chromium 自己的开关：main.js 不能解析它、也不能从 argv 里拦它。
  // （文件头注释会提到这个名字，所以只钉两种「真的开始处理它」的写法。）
  assert.equal(SOURCE.includes("argValue('remote-debugging-port')"), false, 'main.js 不解析 --remote-debugging-port');
  assert.equal(
    SOURCE.includes("process.argv.includes('--remote-debugging-port')"),
    false,
    'main.js 不拦截 Chromium 的 --remote-debugging-port'
  );
});
