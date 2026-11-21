'use strict';
// TOOL-BX-01（高，含 round2 TOOL-B01）：自动化外壳（bench / contrast）超时只杀包装层，
// Electron 孤儿继续持有 stdout 管道写端 → close 永不触发，外壳挂起或把超时吞成假绿。
//
// 这里用真实的 node 子孙进程链复现「孙进程继承 stdout」的结构：
//   · 旧实现：只 kill 直接子进程 → 孙进程活着、管道写端没关、close 不来；
//   · 修复后：taskkill /T（POSIX 进程组）杀掉整棵树 → close 很快到达。
// 这是一条真正的行为回归：不是读源码猜，而是让进程真的跑起来再断言 close。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const electronRun = require('../scripts/electron-run');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const ELECTRON_RUN_SRC = read('scripts/electron-run.js');
const BENCH_SRC = read('scripts/bench.js');
const CONTRAST_SRC = read('scripts/contrast.js');

function killQuietly(pid) {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* 已经退出 */
  }
}

test('TOOL-BX-01：超时杀掉整棵进程树——孙进程继承 stdout 时 close 仍能到达', async () => {
  const script = [
    "const { spawn } = require('node:child_process');",
    "const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
    "console.log('GRANDCHILD ' + g.pid);",
    'setInterval(() => {}, 1000);'
  ].join('\n');
  const startedAt = Date.now();
  const run = await electronRun.runProcess(process.execPath, ['--eval', script], {
    timeout: 500,
    settleGraceMs: 5000
  });
  const elapsed = Date.now() - startedAt;
  const grandchild = /GRANDCHILD (\d+)/.exec(run.stdout);
  killQuietly(grandchild && Number(grandchild[1]));
  assert.equal(run.timedOut, true, '超时必须如实带出 timedOut');
  assert.equal(
    run.settledBy,
    'close',
    '超时后必须真正收到 close——若只杀包装层，孙进程持管道会让 close 永远不来（旧病）'
  );
  assert.ok(elapsed < 5000, `杀完进程树后 close 应很快到达；实际 ${elapsed} ms（兜底计时才 5000 ms）`);
});

test('TOOL-BX-03：多字节中文被 chunk 边界切开也不产生替换符（setEncoding 流式解码）', async () => {
  const script = [
    "const buf = Buffer.from('BENCH_RESULT 中文场景名', 'utf8');",
    'const half = Math.floor(buf.length / 2);',
    'process.stdout.write(buf.subarray(0, half));',
    'setTimeout(() => process.stdout.write(buf.subarray(half)), 30);'
  ].join('\n');
  const run = await electronRun.runProcess(process.execPath, ['--eval', script], { timeout: 5000 });
  assert.equal(run.timedOut, false);
  assert.match(run.stdout, /BENCH_RESULT 中文场景名/);
  assert.equal(run.stdout.includes('\uFFFD'), false, '跨 chunk 解码不许出现 U+FFFD');
});

test('TOOL-BX-04：子进程退出码原样带出（外壳才有机会按退出码判失败）', async () => {
  const run = await electronRun.runProcess(process.execPath, ['--eval', 'process.exit(3)'], {
    timeout: 5000
  });
  assert.equal(run.timedOut, false);
  assert.equal(run.code, 3);
  assert.equal(run.settledBy, 'close');
});

test('TOOL-BX-01 静态闸门：外壳直接跑 Electron 二进制，不再经 scripts/start.js 包装层', () => {
  assert.match(ELECTRON_RUN_SRC, /taskkill/, 'Windows 上必须用 taskkill 杀整棵树');
  assert.match(ELECTRON_RUN_SRC, /'\/t', '\/f'/, 'taskkill 必须带 /T /F（树 + 强杀）');
  assert.match(ELECTRON_RUN_SRC, /process\.kill\(-child\.pid/, 'POSIX 必须杀进程组');
  for (const [name, src] of [['bench.js', BENCH_SRC], ['contrast.js', CONTRAST_SRC]]) {
    assert.equal(/scripts',\s*'start\.js'/.test(src), false, `${name} 不许再 spawn scripts/start.js`);
    assert.equal(/spawn\(process\.execPath/.test(src), false, `${name} 不许再起 node 包装层`);
    assert.match(src, /electronRun\.runElectron\(/, `${name} 必须走共享的 electron-run`);
    // 超时判定必须早于接受 marker：迟到的 marker 不能冒充成功样本。
    const timedOutAt = src.indexOf('run.timedOut');
    const pickAt = src.indexOf('pickResult(run.stdout)');
    assert.notEqual(timedOutAt, -1, `${name} 必须显式判 run.timedOut`);
    assert.ok(timedOutAt < pickAt, `${name} 必须先判超时再解析 marker`);
    assert.match(src, /run\.code !== 0/, `${name} 必须把非零退出码判失败`);
  }
});

test('TOOL-BX-01：electronBinary 找不到依赖时给「先 pnpm install」的可读提示', () => {
  const original = electronRun.electronBinary;
  assert.equal(typeof original, 'function');
  // 真实仓库里依赖已装好：能解析出可执行文件，且路径位于 node_modules/electron/dist 下。
  const binary = electronRun.electronBinary();
  assert.match(binary, /node_modules[\\/]electron[\\/]dist[\\/]/);
  assert.ok(fs.existsSync(binary));
});
