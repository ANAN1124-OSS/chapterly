'use strict';
// PR 级路径过滤 E2E 的**唯一事实源**（WP16 / 审计中 #19 / F1）。
//
// 审计 F1：renderer / core 的改动过去只有每周定时 E2E 兜底，UI 时序回归窗口最长 7 天。
// 现在 `.github/workflows/e2e-pr.yml` 在 PR 改动以下路径时整跑一次全量 E2E；本文件的
// `E2E_TRIGGER_PATHS` 是那份 `paths:` 声明的唯一来源，`tests/wp16-regression.test.js` 会逐项
// 核对两边一致——改一处漏一处就是假拦截（PR 看起来绿了，其实工作流根本没触发）。
//
// 口径取「会影响真实窗口行为或 E2E 自身」的路径：
//   · 产品渲染 / 内核 / 主进程 / 预加载：renderer/**、core/**、ipc/**、main.js、preload.js；
//   · E2E 基建：scripts/e2e/**（组与 harness）、场景 / runner / 启动器；
//   · 本工作流自己（改了触发规则要能在 PR 上验证）；
//   · 依赖清单：package.json / pnpm-lock.yaml（Electron / Node 版本变化会改变真窗口行为）。
// 只动文档 / 测试 / 资源 / 其它工作流的 PR 不跑 E2E（verify 的工作流已覆盖语法 / 单测 / eslint）。
//
// 语义按 GitHub Actions `paths` 的 glob：`*` 不跨 `/`、`**` 跨目录、`?` 单字符、首尾锚定。
// CLI（本地自查用；成功判定不靠退出码，方便脚本读输出）：
//   node scripts/e2e-scope.js --changed renderer/renderer.js core/zip.js README.md
//   node scripts/e2e-scope.js --changed-file changed.txt --json
const fs = require('node:fs');

const E2E_TRIGGER_PATHS = [
  'renderer/**',
  'core/**',
  'ipc/**',
  'main.js',
  'preload.js',
  'scripts/e2e/**',
  'scripts/e2e-scenario.js',
  'scripts/run-e2e.js',
  'scripts/start.js',
  'scripts/e2e-runner-logic.js',
  // TOOL-C-01（第五轮审计）：下面 6 个脚本直接构成 E2E 行为（窗口驱动 / 轮询 / 礼让 / 夹具 /
  // 导出校验 / 启动退出码），旧清单只收了 run-e2e / e2e-scenario / start 三个入口 —— 改了它们
  // 的 PR 不触发 E2E，「PR 看起来绿了，其实根本没跑窗口」。
  'scripts/screenshot-driver.js',
  'scripts/driver-poll.js',
  'scripts/e2e-politeness.js',
  'scripts/e2e-stats-seed.js',
  'scripts/export-check.js',
  'scripts/start-logic.js',
  '.github/workflows/e2e-pr.yml',
  'package.json',
  'pnpm-lock.yaml'
];

const REGEX_CACHE = new Map();

// GitHub paths 的 glob → 锚定正则。只在 `*` / `**` / `?` 三处有语义，其余字符按字面。
function patternToRegExp(pattern) {
  if (typeof pattern !== 'string' || pattern === '') {
    throw new TypeError('path pattern 必须是非空字符串');
  }
  const cached = REGEX_CACHE.get(pattern);
  if (cached) return cached;
  let out = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  out += '$';
  const regex = new RegExp(out);
  REGEX_CACHE.set(pattern, regex);
  return regex;
}

// 仓库相对路径归一：Windows 反斜杠、前导 ./、首尾空白。大小写不折叠（git 路径区分大小写）。
function normalizeChangedPath(file) {
  if (typeof file !== 'string') return '';
  let value = file.trim().replace(/\\/g, '/');
  while (value.startsWith('./')) value = value.slice(2);
  return value;
}

function matchPath(pattern, file) {
  const normalized = normalizeChangedPath(file);
  if (!normalized) return false;
  return patternToRegExp(pattern).test(normalized);
}

// 改动列表 → 是否需要跑 PR E2E。非数组入参抛 TypeError（闸门不许静默跳过）；
// 条目里的非字符串（null / 数字 / 对象）忽略，只认真实路径；同一文件只记一次。
function touchesE2EScope(changedFiles) {
  if (!Array.isArray(changedFiles)) {
    throw new TypeError('changedFiles 必须是数组（每项一个仓库相对路径）');
  }
  const matched = [];
  const seen = new Set();
  for (const raw of changedFiles) {
    if (typeof raw !== 'string') continue;
    const file = normalizeChangedPath(raw);
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const pattern = E2E_TRIGGER_PATHS.find((candidate) => matchPath(candidate, file));
    if (pattern) matched.push({ file, pattern });
  }
  return { required: matched.length > 0, matched };
}

// `--changed-file` 的输入格式：每行一个路径；空行与 # 注释忽略。
function parseChangedFileList(text) {
  if (typeof text !== 'string') throw new TypeError('changed-file 内容必须是文本');
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map(normalizeChangedPath);
}

function usage() {
  return [
    '用法：node scripts/e2e-scope.js [--changed <路径…>] [--changed-file <文件>] [--json]',
    '说明：判断这些改动是否命中 PR 级 E2E 的路径过滤（事实源 E2E_TRIGGER_PATHS）。'
  ].join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  const changed = [];
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--changed') {
      i += 1;
      while (i < args.length && !args[i].startsWith('--')) {
        changed.push(args[i]);
        i += 1;
      }
      i -= 1;
    } else if (arg === '--changed-file') {
      const file = args[i + 1];
      if (!file) {
        console.error('--changed-file 后面要跟一个文件路径');
        return 2;
      }
      try {
        changed.push(...parseChangedFileList(fs.readFileSync(file, 'utf8')));
      } catch (err) {
        console.error(`读不了 --changed-file：${err.message}`);
        return 2;
      }
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      return 0;
    } else {
      console.error(`未知参数：${arg}\n${usage()}`);
      return 2;
    }
  }
  if (!changed.length) {
    console.error(usage());
    return 2;
  }
  const result = touchesE2EScope(changed);
  if (json) {
    console.log(JSON.stringify(result));
    return 0;
  }
  console.log(`E2E required: ${result.required ? 'yes' : 'no'}（${changed.length} 个改动）`);
  for (const item of result.matched) console.log(`  ${item.file}  ←  ${item.pattern}`);
  if (!result.required) console.log('（没有改动命中 renderer/core/ipc/main/preload/E2E 基建，PR 不跑 E2E）');
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv);
}

module.exports = {
  E2E_TRIGGER_PATHS,
  normalizeChangedPath,
  patternToRegExp,
  matchPath,
  touchesE2EScope,
  parseChangedFileList
};