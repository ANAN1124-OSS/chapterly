'use strict';
// A2-GATE-02（2026-11-26 审计）：npm test 的计数器。
//
// 为什么要有这一层：README / 验收清单里的「单测 N 项」是机器实测锚点，以前只在人记得传
// `version-sync --write --unit N` 时才同步。现在 npm test 走这里：照常以 spec 报告器跑
// `node --test`，把输出原样透传，同时解析末尾的 "ℹ tests N" 落到临时计数文件；
// `version-sync --check` 默认读它与文档比对 —— 数字漂了当场红。
//
// 用法：npm test（package.json 传 `"tests/**/*.test.js"`）
// 直接跑：node scripts/run-tests.js [pattern]
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const gateCounts = require('./gate-counts');
// A2-GATE-04：被 kill / 超时的上一轮测试不会走 process 'exit'，启动时清一次超龄 cw-* 残留。
const tmpCleanup = require('../tests/tmp-cleanup');

const ROOT = path.join(__dirname, '..');

// node --test 的 spec 报告器在结束时打一行 `ℹ tests 3689`（失败时也照打）。
// 单独导出成纯函数，单测直接钉解析口径，不必真的跑全量。
function parseUnitCount(output) {
  const match = String(output || '').match(/^ℹ tests (\d+)\s*$/m);
  return match ? Number(match[1]) : null;
}

function main(argv) {
  // A2-GATE-04：只删 os.tmpdir() 直接子目录里 cw-* 且超 24 小时的；失败静默，绝不阻塞本次测试。
  try {
    tmpCleanup.sweepStale();
  } catch {
    /* 清理失败不影响测试 */
  }
  const patterns = argv.length ? argv : ['tests/**/*.test.js'];
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...patterns], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (result.error) {
    console.error(`单测运行失败：${result.error.message}`);
    return 1;
  }
  const count = parseUnitCount(stdout);
  if (count == null) {
    console.error('[test] 没在输出里找到「ℹ tests N」，本次不记录计数锚（门禁按退出码判断）');
  } else {
    gateCounts.record('unit', count);
  }
  return result.status == null ? 1 : result.status;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { parseUnitCount, main };
