'use strict';
// 零依赖 lint 门禁 CLI（1.6.0 G1；审计修复 #53 / R6 收成单条规则）。
//
// 判定口径全部在 `scripts/lint-gate-logic.js`（纯字符串进 / 结论出，单测直接 require 它）；
// 这个文件只负责三件事：收集要扫的文件、把结论打出来、按 ERROR 数量给退出码。
//
// 用法：
//   node scripts/lint-gate.js            # 人读摘要：ERROR / WARN 逐条，ERROR>0 → 退出 1
//   node scripts/lint-gate.js --json     # 结构化（给测试 / 其它脚本用），stdout 只有 JSON
//   node scripts/lint-gate.js --quiet    # 只打最后一行结论
//
// 只查 floating-promise（语句级调用 async 函数却没人接 → unhandledRejection）：
// no-undef / no-unused-vars 已由 `npx eslint .`（eslint.config.js，两条规则均 error）覆盖，
// 这里不再重复维护第二份全局白名单（审计 R6）。
//
// 为什么扫 `tests/**`：测试里的 floating promise 会让用例自己挂掉，一样值得拦。
//
// 零依赖、只读：不写文件、不碰配置、不碰书库、不联网。
const fs = require('node:fs');
const path = require('node:path');

const { lintSource, summarize, exitCodeFor, formatFinding } = require('./lint-gate-logic.js');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['core', 'renderer', 'ipc', 'scripts', 'tests'];
const SCAN_FILES = ['main.js', 'preload.js'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'shots', 'build', 'tests-fixture', '.github', 'trial']);
const MAX_PRINTED_WARN = 30;
// TOOL-A01（第五轮审计）：扫描面下限。仓库现在约 480 个 js；低于 200 只可能是目录被改名 /
// 被删 / 读不了 —— 这时必须报红，绝不许输出「0 个 js / 0 ERROR（通过）」的假绿。
const MIN_SCAN_FILES = 200;

function listFiles(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // TOOL-A01：目录不存在 / 读不了（EACCES / EBUSY）不许静默当成空目录。
    const error = new Error(
      `扫描目录读不了：${path.relative(ROOT, dir) || dir}（${(err && (err.code || err.message)) || '未知错误'}）`
    );
    error.code = 'SCAN_DIR_UNREADABLE';
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      listFiles(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function collectFiles(root) {
  const base = root || ROOT;
  const absolute = [];
  for (const dir of SCAN_DIRS) listFiles(path.join(base, dir), absolute);
  for (const file of SCAN_FILES) {
    const full = path.join(base, file);
    if (!fs.existsSync(full)) {
      // TOOL-A01：main.js / preload.js 是扫描清单的固定成员，改名 / 移动后清单必须同步改；
      // 静默跳过等于把整份文件从门禁里摘掉。
      const error = new Error(`扫描文件不存在：${file}（扫描清单要跟着仓库结构更新）`);
      error.code = 'SCAN_FILE_MISSING';
      throw error;
    }
    absolute.push(full);
  }
  if (absolute.length < MIN_SCAN_FILES) {
    const error = new Error(
      `扫描面残缺：只找到 ${absolute.length} 个 js（下限 ${MIN_SCAN_FILES}），目录 / 清单可能被改名或读不了`
    );
    error.code = 'SCAN_TOO_SMALL';
    throw error;
  }
  return absolute
    .map((full) => path.relative(base, full).split(path.sep).join('/'))
    .sort();
}

function lintRepo(root) {
  const base = root || ROOT;
  const files = collectFiles(base);
  const findings = [];
  for (const rel of files) {
    const source = fs.readFileSync(path.join(base, rel), 'utf8');
    for (const finding of lintSource(source, { file: rel })) findings.push(finding);
  }
  return { root: base, files, findings };
}

function printReport(report, options) {
  const summary = summarize(report.findings);
  const quiet = options && options.quiet;
  if (!quiet) {
    const errors = report.findings.filter((f) => f.severity === 'ERROR');
    const warns = report.findings.filter((f) => f.severity === 'WARN');
    for (const finding of errors) console.log(formatFinding(finding));
    for (const finding of warns.slice(0, MAX_PRINTED_WARN)) console.log(formatFinding(finding));
    if (warns.length > MAX_PRINTED_WARN) {
      console.log(`… 另有 ${warns.length - MAX_PRINTED_WARN} 条 WARN（用 --json 看全部）`);
    }
  }
  const line = `lint-gate：${report.files.length} 个 js / ${summary.errorCount} ERROR / ${summary.warnCount} WARN`;
  console.log(line + (summary.errorCount > 0 ? '（ERROR 必须清零）' : '（通过）'));
  return summary;
}

function main(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let report;
  try {
    report = lintRepo(ROOT);
  } catch (error) {
    // TOOL-A01：扫描面不完整按「仓库状态问题」退 2（与其它闸门 CLI 的用法错误同口径）。
    console.error(`lint-gate：${error && error.message ? error.message : String(error)}`);
    return 2;
  }
  const summary = summarize(report.findings);
  if (args.includes('--json')) {
    console.log(JSON.stringify({
      fileCount: report.files.length,
      errorCount: summary.errorCount,
      warnCount: summary.warnCount,
      findings: report.findings
    }, null, 2));
    return exitCodeFor(report.findings);
  }
  printReport(report, { quiet: args.includes('--quiet') });
  return exitCodeFor(report.findings);
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 2;
  }
}

module.exports = { collectFiles, lintRepo, MIN_SCAN_FILES, SCAN_DIRS, SCAN_FILES };