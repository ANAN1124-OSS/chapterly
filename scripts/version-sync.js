'use strict';
// 版本号与文档计数同步（v1.8.0 WP-37 / 审计 D10）。
//
// 为什么要有这个脚本：版本号以前散在 package.json、renderer/index.html（两处）、README 标题与
// 下载名、验收清单标题 —— 发版靠手工同步，漏一处界面 / 文档就停在旧版本。现在 package.json 的
// version 是唯一权威：
//   · 界面：主进程 app.getVersion() 经 `app:version` IPC 在运行时注入，index.html 不写版本串；
//   · 文档：README / 验收清单的版本锚点（标题、安装包名、Release 链接、发布日期）与单测 / E2E
//     计数由这个脚本 `--write` 同步；`--check` 只校验漂移（tests/version-sync.test.js 同口径）。
//
// 用法（仓库根执行）：
//   node scripts/version-sync.js --check                             # 只校验，漂移退出 1
//   node scripts/version-sync.js --check --unit 2495 --e2e 1881      # 连计数一并核对
//   node scripts/version-sync.js --write                             # 只同步版本锚点
//   node scripts/version-sync.js --write --unit 2495 --e2e 1881      # 版本 + 计数一起同步
//   node scripts/version-sync.js --write --date 2026-11-20           # 顺带同步 README 的发布日期
//
// 只读写 README.md / 验收清单.md / renderer/index.html 与 package.json；不碰书库 / 配置 / 网络。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PACKAGE_JSON = path.join(ROOT, 'package.json');
const README = path.join(ROOT, 'README.md');
const CHECKLIST = path.join(ROOT, '验收清单.md');
const INDEX_HTML = path.join(ROOT, 'renderer', 'index.html');

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// README / 验收清单的版本锚点。每条都写明「应该命中几处」——文档结构一变就抛错，
// 免得脚本静默漏改一处、发版时还以为同步过了。标题规则不带行尾，CRLF 换行原样保留。
const README_VERSION_RULES = [
  {
    id: '标题版本',
    re: /^# 章回 \/ Chapterly v\d+\.\d+\.\d+/gm,
    expected: 1,
    build: (version) => `# 章回 / Chapterly v${version}`
  },
  {
    id: '安装包名',
    re: /chapterly-\d+\.\d+\.\d+-win-x64-setup\.exe/g,
    expected: 2,
    build: (version) => `chapterly-${version}-win-x64-setup.exe`
  },
  {
    id: 'Release 链接',
    re: /\[v\d+\.\d+\.\d+\]\(https:\/\/github\.com\/ANAN1124-OSS\/chapterly\/releases\/tag\/v\d+\.\d+\.\d+\)/g,
    expected: 1,
    build: (version) =>
      `[v${version}](https://github.com/ANAN1124-OSS/chapterly/releases/tag/v${version})`
  }
];

const README_COUNT_RULES = {
  unitCount: { id: '单测计数', re: /node:test，\d+ 项/g, expected: 1, build: (n) => `node:test，${n} 项` },
  e2eCount: {
    id: 'E2E 计数',
    re: /真实启动 Electron 走 \d+ 项主流程/g,
    expected: 1,
    build: (n) => `真实启动 Electron 走 ${n} 项主流程`
  }
};

const README_DATE_RULE = {
  id: '发布日期',
  re: /已于 \d{4}-\d{2}-\d{2} 发布/g,
  expected: 1,
  build: (date) => `已于 ${date} 发布`
};

const CHECKLIST_VERSION_RULES = [
  {
    id: '标题版本',
    re: /^# 章回 \/ Chapterly v\d+\.\d+\.\d+/gm,
    expected: 1,
    build: (version) => `# 章回 / Chapterly v${version}`
  },
  {
    id: '安装包名',
    re: /chapterly-\d+\.\d+\.\d+-win-x64-setup\.exe/g,
    expected: 1,
    build: (version) => `chapterly-${version}-win-x64-setup.exe`
  }
];

const CHECKLIST_COUNT_RULES = {
  unitCount: {
    id: '单测计数',
    re: /`pnpm test`（\d+ 项）/g,
    expected: 1,
    build: (n) => `\`pnpm test\`（${n} 项）`
  },
  e2eCount: {
    id: 'E2E 计数',
    re: /`pnpm run e2e`（\d+ 项）/g,
    expected: 1,
    build: (n) => `\`pnpm run e2e\`（${n} 项）`
  }
};

const COUNT_LABELS = { unitCount: '单测计数', e2eCount: 'E2E 计数' };

function normalizeVersion(version) {
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    throw new Error(`版本号必须是 x.y.z（package.json 的 version），收到 ${JSON.stringify(version)}`);
  }
  return version;
}

function normalizeCount(count, label) {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`${label}必须是正整数，收到 ${JSON.stringify(count)}`);
  }
  return count;
}

function normalizeDate(date) {
  if (typeof date !== 'string' || !DATE_RE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error(`发布日期必须是 YYYY-MM-DD，收到 ${JSON.stringify(date)}`);
  }
  return date;
}

// 一条锚点规则：先数命中处数（结构变了直接抛），再整体替换。
function applyRule(text, rule, value, label) {
  const hits = text.match(rule.re) || [];
  if (hits.length !== rule.expected) {
    throw new Error(
      `${label}「${rule.id}」锚点应有 ${rule.expected} 处，实际 ${hits.length} 处；` +
        '文档结构变了，先更新 scripts/version-sync.js'
    );
  }
  return text.replace(rule.re, () => rule.build(value));
}

function applyRules(text, rules, value, label) {
  let out = text;
  for (const rule of rules) out = applyRule(out, rule, value, label);
  return out;
}

function readCountsOption(options, label) {
  const hasUnit = options.unitCount != null;
  const hasE2e = options.e2eCount != null;
  if (!hasUnit && !hasE2e) return null;
  if (!hasUnit || !hasE2e) {
    throw new Error(`${label}：unitCount 与 e2eCount 必须一起给（计数成对同步）`);
  }
  return {
    unitCount: normalizeCount(options.unitCount, `${label}的单测计数`),
    e2eCount: normalizeCount(options.e2eCount, `${label}的 E2E 计数`)
  };
}

// README：标题 / 安装包名（下载 + 本机产物两处）/ Release 链接 / 计数 / 发布日期。
function syncReadme(text, options = {}) {
  let out = text;
  let touched = false;
  if (options.version != null) {
    out = applyRules(out, README_VERSION_RULES, normalizeVersion(options.version), 'README.md');
    touched = true;
  }
  const counts = readCountsOption(options, 'README.md');
  if (counts) {
    out = applyRule(out, README_COUNT_RULES.unitCount, counts.unitCount, 'README.md');
    out = applyRule(out, README_COUNT_RULES.e2eCount, counts.e2eCount, 'README.md');
    touched = true;
  }
  if (options.date != null) {
    out = applyRule(out, README_DATE_RULE, normalizeDate(options.date), 'README.md');
    touched = true;
  }
  if (!touched) throw new Error('README.md：没有要同步的内容（至少给 version / 计数 / date 之一）');
  return out;
}

// 验收清单：标题 / 安装包名 / 计数。
function syncChecklist(text, options = {}) {
  let out = text;
  let touched = false;
  if (options.version != null) {
    out = applyRules(out, CHECKLIST_VERSION_RULES, normalizeVersion(options.version), '验收清单.md');
    touched = true;
  }
  const counts = readCountsOption(options, '验收清单.md');
  if (counts) {
    out = applyRule(out, CHECKLIST_COUNT_RULES.unitCount, counts.unitCount, '验收清单.md');
    out = applyRule(out, CHECKLIST_COUNT_RULES.e2eCount, counts.e2eCount, '验收清单.md');
    touched = true;
  }
  if (!touched) throw new Error('验收清单.md：没有要同步的内容（至少给 version / 计数之一）');
  return out;
}

function collectVersions(text, re) {
  const found = [];
  for (const match of text.matchAll(re)) found.push(match[1]);
  return found;
}

function firstCount(text, re) {
  const match = text.match(re);
  return match ? Number(match[1]) : null;
}

// 界面版本串必须为 0 处：两个元素的内容都由运行时注入，index.html 不许再写死。
function elementText(html, id) {
  const marker = `id="${id}"`;
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const openEnd = html.indexOf('>', at);
  if (openEnd < 0) return null;
  const closeAt = html.indexOf('<', openEnd + 1);
  if (closeAt < 0) return null;
  return html.slice(openEnd + 1, closeAt).trim();
}

function checkIndexHtml(html) {
  const problems = [];
  for (const id of ['app-version', 'settings-update-version']) {
    const text = elementText(html, id);
    if (text == null) problems.push(`renderer/index.html 找不到 #${id}`);
    else if (text) {
      problems.push(`renderer/index.html 的 #${id} 还写着静态版本「${text}」——版本只能运行时注入`);
    }
  }
  return problems;
}

// 校验：版本锚点全部等于 package.json 的 version；README / 验收清单的计数互相一致；
// 给了期望计数时也逐项核对；界面 0 处静态版本串。返回问题清单（空数组 = 通过）。
function checkDocs(options) {
  const problems = [];
  const version = normalizeVersion(options.version);
  const readme = String(options.readme || '');
  const checklist = String(options.checklist || '');
  const indexHtml = String(options.indexHtml || '');

  const readmeTitle = readme.match(/^# 章回 \/ Chapterly v(\d+\.\d+\.\d+)/m);
  if (!readmeTitle) problems.push('README.md 找不到「# 章回 / Chapterly vX.Y.Z」标题');
  else if (readmeTitle[1] !== version) {
    problems.push(`README.md 标题版本是 ${readmeTitle[1]}，package.json 是 ${version}`);
  }

  const readmeExes = collectVersions(readme, /chapterly-(\d+\.\d+\.\d+)-win-x64-setup\.exe/g);
  if (readmeExes.length !== 2) {
    problems.push(`README.md 的安装包名应有 2 处（下载 + 本机产物），实际 ${readmeExes.length} 处`);
  }
  for (const found of readmeExes) {
    if (found !== version) problems.push(`README.md 安装包名是 ${found}，package.json 是 ${version}`);
  }

  const releaseLink = readme.match(
    /\[v(\d+\.\d+\.\d+)\]\(https:\/\/github\.com\/ANAN1124-OSS\/chapterly\/releases\/tag\/v(\d+\.\d+\.\d+)\)/
  );
  if (!releaseLink) problems.push('README.md 找不到 Release 链接（[vX.Y.Z](…/releases/tag/vX.Y.Z)）');
  else if (releaseLink[1] !== version || releaseLink[2] !== version) {
    problems.push(`README.md 的 Release 链接是 ${releaseLink[2]}，package.json 是 ${version}`);
  }

  const checklistTitle = checklist.match(/^# 章回 \/ Chapterly v(\d+\.\d+\.\d+)(?= · 手工验收清单)/m);
  if (!checklistTitle) {
    problems.push('验收清单.md 找不到「# 章回 / Chapterly vX.Y.Z · 手工验收清单」标题');
  } else if (checklistTitle[1] !== version) {
    problems.push(`验收清单.md 标题版本是 ${checklistTitle[1]}，package.json 是 ${version}`);
  }

  const checklistExes = collectVersions(checklist, /chapterly-(\d+\.\d+\.\d+)-win-x64-setup\.exe/g);
  if (checklistExes.length !== 1) {
    problems.push(`验收清单.md 的安装包名应有 1 处，实际 ${checklistExes.length} 处`);
  }
  for (const found of checklistExes) {
    if (found !== version) problems.push(`验收清单.md 安装包名是 ${found}，package.json 是 ${version}`);
  }

  const readmeCounts = {
    unitCount: firstCount(readme, /node:test，(\d+) 项/),
    e2eCount: firstCount(readme, /真实启动 Electron 走 (\d+) 项主流程/)
  };
  const checklistCounts = {
    unitCount: firstCount(checklist, /`pnpm test`（(\d+) 项）/),
    e2eCount: firstCount(checklist, /`pnpm run e2e`（(\d+) 项）/)
  };
  for (const key of Object.keys(COUNT_LABELS)) {
    const label = COUNT_LABELS[key];
    const inReadme = readmeCounts[key];
    const inChecklist = checklistCounts[key];
    if (inReadme == null) problems.push(`README.md 找不到${label}`);
    if (inChecklist == null) problems.push(`验收清单.md 找不到${label}`);
    if (inReadme != null && inChecklist != null && inReadme !== inChecklist) {
      problems.push(`${label}不一致：README.md ${inReadme} / 验收清单.md ${inChecklist}`);
    }
    if (options[key] != null) {
      const expected = normalizeCount(options[key], label);
      if (inReadme != null && inReadme !== expected) {
        problems.push(`README.md 的${label}是 ${inReadme}，本次期望 ${expected}`);
      }
      if (inChecklist != null && inChecklist !== expected) {
        problems.push(`验收清单.md 的${label}是 ${inChecklist}，本次期望 ${expected}`);
      }
    }
  }

  for (const problem of checkIndexHtml(indexHtml)) problems.push(problem);
  return problems;
}

function countArg(argv, flag) {
  const at = argv.indexOf(flag);
  if (at < 0) return undefined;
  const value = argv[at + 1];
  return value == null ? NaN : Number(value);
}

function main(argv) {
  const wantWrite = argv.includes('--write');
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  const version = normalizeVersion(pkg.version);
  const unitCount = countArg(argv, '--unit');
  const e2eCount = countArg(argv, '--e2e');
  const dateAt = argv.indexOf('--date');
  const date = dateAt < 0 ? undefined : normalizeDate(argv[dateAt + 1]);
  const counts = unitCount != null || e2eCount != null ? { unitCount, e2eCount } : {};

  if (wantWrite) {
    const beforeReadme = fs.readFileSync(README, 'utf8');
    const beforeChecklist = fs.readFileSync(CHECKLIST, 'utf8');
    const nextReadme = syncReadme(beforeReadme, { version, ...counts, date });
    const nextChecklist = syncChecklist(beforeChecklist, { version, ...counts });
    const written = [];
    if (nextReadme !== beforeReadme) {
      fs.writeFileSync(README, nextReadme);
      written.push('README.md');
    }
    if (nextChecklist !== beforeChecklist) {
      fs.writeFileSync(CHECKLIST, nextChecklist);
      written.push('验收清单.md');
    }
    const countText = counts.unitCount == null ? '' : `；单测 ${counts.unitCount} / E2E ${counts.e2eCount}`;
    console.log(
      written.length
        ? `已同步版本锚点：${written.join('、')}（v${version}${countText}）`
        : '版本锚点与计数本来一致，未改动文件'
    );
  }

  const problems = checkDocs({
    readme: fs.readFileSync(README, 'utf8'),
    checklist: fs.readFileSync(CHECKLIST, 'utf8'),
    indexHtml: fs.readFileSync(INDEX_HTML, 'utf8'),
    version,
    unitCount,
    e2eCount
  });
  if (problems.length) {
    for (const problem of problems) console.error(`- ${problem}`);
    console.error('版本单一事实来源校验失败：改完跑 node scripts/version-sync.js --write');
    return 1;
  }
  console.log(`版本单一事实来源校验通过：package.json v${version}、README / 验收清单一致、界面无静态版本串`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(err && err.message ? err.message : String(err));
    process.exitCode = 2;
  }
}

module.exports = {
  syncReadme,
  syncChecklist,
  checkDocs,
  checkIndexHtml
};
