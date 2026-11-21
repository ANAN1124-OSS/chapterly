// 工具链低优批次（TOOL-A05 / TOOL-BX-07 / TOOL-BX-08 / TOOL-C-02..C-10）的静态闸门。
//
// 这些修复大多落在「只有真跑 Electron / E2E / 生成图标时才走」的脚本路径上：行为级验证要么要起
// 真实窗口（TOOL-C 系）、要么会生成几百 MB 夹具（TOOL-BX-07）、要么要重渲整套图标（TOOL-C-09/10）。
// 所以这里钉**决定本身**（谁调谁、口径字段、包装顺序），报告 / 图标产物仍由各自的手工验收兜底。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('TOOL-A05：a11y 实测的 teardown 失败进失败清单，也进 JSON 报告', () => {
  const src = read('scripts/a11y-gate.js');
  // 判定：收尾失败与「状态自己没测到」同等对待（只记失败、不跳过该状态的测量判定）
  assert.match(
    src,
    /if \(record\.teardownError\) \{\s*failedStates\.push\(`\$\{stateLabel\}：收尾失败（\$\{record\.teardownError\}）`\);/,
    '收尾失败必须计入 failedStates（否则门禁永远绿）'
  );
  // 报告：字段白名单不能把 teardownError 丢掉
  assert.match(src, /error: record\.error \|\| null,\s*\n\s*\/\/ TOOL-A05[\s\S]*?teardownError: record\.teardownError \|\| null/, '报告 states 映射要带 teardownError');
  // 失败信息要真的进 summary.problems（决定退出码）
  assert.match(src, /for \(const item of failedStates\) summary\.problems\.push\(`状态测量失败：\$\{item\}`\)/);
});

test('TOOL-BX-07：bench-index-deep 的参数走共享 clampInt 并有上限', () => {
  const src = read('scripts/bench-index-deep.js');
  assert.match(src, /const \{ clampInt \} = require\('\.\.\/core\/common'\)/, '夹紧要复用 core/common.js 的那一份');
  assert.match(src, /LIMITS = \{ chapters: \[1, 20000\], runs: \[1, 50\], hashInterval: \[0, 86400000\] \}/, '三个参数都要有上下界');
  for (const name of ['chapters', 'runs', 'hash-interval']) {
    assert.match(src, new RegExp(`clampArg\\(argv, '${name}'`), `${name} 必须走 clampArg`);
  }
  assert.match(src, /已夹到 \$\{value\}/, '夹紧时要如实告诉作者（不静默改口径）');
});

test('TOOL-BX-08：contrast 报告原子落盘，options 记全量口径', () => {
  const src = read('scripts/contrast.js');
  assert.match(src, /const \{ atomicWriteFile \} = require\('\.\.\/core\/atomic'\)/);
  assert.match(src, /await atomicWriteFile\(outPath, JSON\.stringify\(report, null, 2\), 'utf8', \{ ensureDir: true \}\)/, '报告要用 atomicWriteFile（与 bench.js 同口径）');
  assert.equal(/fsp\.writeFile\(outPath, JSON\.stringify\(report/.test(src), false, '不许再裸写报告');
  assert.match(src, /timeoutMs: opts\.timeoutMs/, 'options 要记 timeout');
  assert.match(src, /failOnLow: opts\.failOnLow/, 'options 要记 --no-fail 口径');
});

test('TOOL-C-02/C-03：E2E 每组统一收尾 —— 还原 saveDialog 劫持 + 窗口销毁短路', () => {
  const src = read('scripts/e2e-scenario.js');
  // 所有组都走 runGroup 包装（只有包装自己内部可以直接调 e2eGroups.runGroups）
  const direct = (src.match(/await e2eGroups\.runGroups\(groupContext\(\), /g) || []).length;
  assert.equal(direct, 1, '只有 runGroup() 内部可以直接调 e2eGroups.runGroups');
  const calls = (src.match(/await runGroup\(/g) || []).length;
  assert.ok(calls >= 60, `组调用数异常（${calls}），可能漏改`);
  assert.match(src, /try \{\s*await e2eGroups\.runGroups\(groupContext\(\), ids\);\s*\} finally \{\s*restoreSaveDialog\(\);\s*\}/, 'destroy 后必须还原 showSaveDialog（组内抛错也不泄漏）');
  assert.match(src, /if \(automationWindowGone\(\)\)/, '每组开跑前先看窗口是否还活着');
  assert.match(src, /跳过剩余组/, '窗口销毁只记一条失败并跳过剩余组');
  // harness.waitFor 也要在窗口销毁时立即结束（不再轮询满 timeout）
  const harness = read('scripts/e2e/harness.js');
  assert.match(harness, /const windowGone = \(\) =>/, 'harness 要有窗口存活判定');
  assert.match(harness, /if \(windowGone\(\)\) throw new Error\(`窗口已销毁，停止等待：\$\{expr\}`\)/, 'waitFor 要短路');
});

test('TOOL-C-04：run-e2e 处理子进程 spawn error（不只挂 close）', () => {
  const src = read('scripts/run-e2e.js');
  assert.match(src, /child\.on\('error', \(err\) => \{/, '必须挂 error 事件');
  assert.match(src, /启动失败：/, 'spawn 失败要打印明确原因');
  assert.match(src, /missingResult: true \}\);/, 'spawn 失败走与「拿不到结果」同一收尾（保留现场）');
});

test('TOOL-C-08：截图驱动的 exec 别名显式接收并转传 userGesture', () => {
  const src = read('scripts/screenshot-driver.js');
  assert.match(
    src,
    /const exec = \(code, userGesture = true\) => execInRenderer\(win, code, userGesture\);/,
    '84 处调用带的第二个实参不许再被静默丢弃'
  );
  // driver-poll 的那份实现本来就收 userGesture（默认 true），两处口径一致
  assert.match(read('scripts/driver-poll.js'), /function execInRenderer\(win, code, userGesture = true\)/);
});

test('TOOL-C-09/C-10：图标脚本不再重复渲染 / 保留无用 bg 形参', () => {
  const src = read('scripts/make-icon.py');
  // 缓存 render 结果（行列表），PNG / DIB 按需编码
  assert.match(src, /cache\[s\] = render\(s\)/, 'cache 要存 render 结果，而不是先编码 PNG');
  assert.equal(/dib_bytes\(s, render\(s\)\)/.test(src), false, 'DIB 不许再第二遍 render');
  assert.match(src, /png_bytes\(s, s, cache\[s\]\) if s >= 256 else dib_bytes\(s, cache\[s\]\)/, 'ICO 的两条分支都用同一份 render');
  assert.match(src, /f\.write\(png_bytes\(512, 512, cache\[512\]\)\)/, 'icon.png 按需编码');
  // blit 的 bg 形参从未被使用：签名与调用都删掉
  assert.equal(/def blit\([^)]*bg/.test(src), false, 'blit 不许再有 bg 形参');
  assert.equal(/blit\(rows, w, h, img, s, s, x, h - margin - s, bg\)/.test(src), false, 'sheet() 不再传 bg');
});
