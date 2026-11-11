'use strict';
// 零依赖 lint 门禁 CLI（1.6.0 G1）。
//
// 判定口径全部在 `scripts/lint-gate-logic.js`（纯字符串进 / 结论出，单测直接 require 它）；
// 这个文件只负责三件事：收集要扫的文件、收集「仓库级全局名」、把结论打出来并按 ERROR 数量给退出码。
//
// 用法：
//   node scripts/lint-gate.js            # 人读摘要：ERROR / WARN 逐条，ERROR>0 → 退出 1
//   node scripts/lint-gate.js --json     # 结构化（给测试 / 其它脚本用），stdout 只有 JSON
//   node scripts/lint-gate.js --quiet    # 只打最后一行结论
//
// 为什么扫 `tests/**`：测试里的 floating promise 会让用例自己挂掉、未定义引用会让用例静默走错分支，
// 一样值得拦；`tests/` 里的 WARN（未用变量）不挡门禁。
//
// 为什么要有「仓库级全局名」：渲染层各模块用 UMD 挂 `root.CWxxx = factory()` 互相引用，
// 只扫单文件会把 `CWxxx` 误判成未定义。收集所有 `window./globalThis./self./global./root.名字 =`
// 的赋值（不区分文件），把结果并进白名单——多收只会漏报，不会误报。
//
// 零依赖、只读：不写文件、不碰配置、不碰书库、不联网。
const fs = require('node:fs');
const path = require('node:path');

const { lintSource, summarize, exitCodeFor, formatFinding } = require('./lint-gate-logic.js');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['core', 'renderer', 'scripts', 'tests'];
const SCAN_FILES = ['main.js', 'preload.js'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'shots', 'build', 'tests-fixture', '.github', 'trial']);
const MAX_PRINTED_WARN = 30;

function listFiles(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
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
    if (fs.existsSync(full)) absolute.push(full);
  }
  return absolute
    .map((full) => path.relative(base, full).split(path.sep).join('/'))
    .sort();
}

const GLOBAL_ASSIGN_RE = /\b(?:window|globalThis|self|global|root)\.([A-Za-z_$][\w$]*)\s*=/g;

function collectRepoGlobals(root, files) {
  const globals = new Set();
  for (const rel of files) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    GLOBAL_ASSIGN_RE.lastIndex = 0;
    let match;
    while ((match = GLOBAL_ASSIGN_RE.exec(text))) globals.add(match[1]);
  }
  return globals;
}

function lintRepo(root) {
  const base = root || ROOT;
  const files = collectFiles(base);
  const globals = collectRepoGlobals(base, files);
  const findings = [];
  for (const rel of files) {
    const source = fs.readFileSync(path.join(base, rel), 'utf8');
    for (const finding of lintSource(source, { file: rel, globals })) findings.push(finding);
  }
  return { root: base, files, globals, findings };
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
  const report = lintRepo(ROOT);
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