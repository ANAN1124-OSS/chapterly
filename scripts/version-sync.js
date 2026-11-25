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
// 审计修复 #26（M1、M5、▲V309）起，`--check` 还会核对两类「结构描述」而不是只比版本号 / 计数：
//   · README「防丢稿设计（当前保证）」的每条保证都要在锚点表里有一个可检查的实现落点，
//     编号一一对应、文件存在、文件里确实包含该实现符号（保证清单与实现一起漂移就报红）；
//   · scripts/e2e/groups 的组文件数量 / 编号范围 / README 两处描述一致；
//   · README 关于 Electron fuse 的说法与 package.json 的 electronFuses 一致（M1 的 asar fuse 漂移）。
// 只读这些文件；不碰书库 / 配置 / 网络。
const fs = require('node:fs');
const path = require('node:path');
// 零填充只有 core/common.js 一份实现（仓库静态闸门禁止内联 padStart(2,'0')）。
const { pad2 } = require('../core/common');

const ROOT = path.join(__dirname, '..');
const PACKAGE_JSON = path.join(ROOT, 'package.json');
const README = path.join(ROOT, 'README.md');
const CHECKLIST = path.join(ROOT, 'docs', '验收清单.md');
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
  },
  {
    // 发版 2.1.0 时发现：「> 平台：… · 当前 v2.0.0」这处锚点以前没人管，
    // 前三条规则全部命中后它仍停在旧版本。补成第四条，与标题 / 安装包名 / Release 链接同源。
    id: '当前版本',
    re: /当前 v\d+\.\d+\.\d+/g,
    expected: 1,
    build: (version) => `当前 v${version}`
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

// DOC-01（低）：README 只允许一处 E2E 总数表述 —— 总数是实测锚点，--write 只同步上面那一条
// 句式；其它写法（旧 README 的「跑全量 1933 项」）不会被同步，留着必然与验收清单漂移。
// 这里把「全量 + 数字 + 项」这类第二句式统一收口成 0 处（唯一锚点句式不含这段临近关系）。
const README_E2E_TOTAL_RE = /全量[^\r\n\d]{0,6}\d+\s*项/g;
function extraE2eTotals(text) {
  return text.match(README_E2E_TOTAL_RE) || [];
}

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

// 审计修复 #26（M1 / ▲V309）：README「防丢稿设计（当前保证）」的锚点小节。
// 保证条目形如 `1. **…` / `6b. **…`；锚点表一行一条：`| 7 | \`文件\` → \`实现符号\`；… |`。
const GUARANTEE_SECTION_START = '## 防丢稿设计（当前保证）';
const GUARANTEE_SECTION_END = '> **历史记录**';
const GUARANTEE_ANCHOR_HEADING = '### 保证清单的代码锚点（version-sync 门禁）';
const GUARANTEE_ROW_RE = /^\|\s*([0-9]+[a-z]?)\s*\|\s*(.+?)\s*\|\s*$/;

const GUARANTEE_PAIR_RE = /^`([^`]+)`\s*→\s*`([^`]+)`$/;

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

// README：标题 / 安装包名（下载 + 本机产物两处）/ Release 链接 / 当前版本 / 计数 / 发布日期。
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
  // DOC-01（低）：写盘前先确认没有第二个 E2E 总数说法 —— 否则这次 --write 成功、下一次 --check 红，
  // 数字还停在旧实测值。
  const extras = extraE2eTotals(out);
  if (extras.length) {
    throw new Error(
      `README.md 只允许一处 E2E 总数表述（「真实启动 Electron 走 N 项主流程」），还找到 ${extras.length} 处：` +
        `${extras.join('、')}；请删掉其它总数说法（DOC-01）`
    );
  }
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

// README「当前保证」小节里的编号（含 6b）；找不到小节回 null（区别于「空清单」）。
function guaranteeItemIds(readme) {
  const start = readme.indexOf(GUARANTEE_SECTION_START);
  if (start < 0) return null;
  const end = readme.indexOf(GUARANTEE_SECTION_END, start);
  const section = readme.slice(start, end < 0 ? undefined : end);
  const ids = [];
  // 局部全局正则：不把 lastIndex 留在模块级（否则第二次调用会从上次结尾开始找）
  const itemRe = /^([0-9]+[a-z]?)\. \*\*/gm;
  let match;
  while ((match = itemRe.exec(section))) ids.push(match[1]);
  return ids;
}

// 锚点表：返回 [{ id, cell }]（跳过表头 / 分隔行）；找不到小节回 null。
function guaranteeAnchorRows(readme) {
  const start = readme.indexOf(GUARANTEE_ANCHOR_HEADING);
  if (start < 0) return null;
  const end = readme.indexOf(GUARANTEE_SECTION_END, start);
  const section = readme.slice(start, end < 0 ? undefined : end);
  const rows = [];
  for (const line of section.split(/\r?\n/)) {
    const match = GUARANTEE_ROW_RE.exec(line.trim());
    if (!match || match[1] === '编号') continue;
    rows.push({ id: match[1], cell: match[2].trim() });
  }
  return rows;
}

// 审计修复 #26（M1 / ▲V309）：保证清单 ↔ 代码锚点一一对应，且锚点真的落在源码里。
// 这不是「文档格式检查」——它把「README 承诺了什么」和「代码里有没有这条实现」绑在一起：
// 删实现 / 改函数名 / 增删保证条目而忘改锚点，都会在发版前报红。
// 口径（审计残留修复 #R16 / #26-M1）：符号校验是「源码文本 includes」，不是 AST —— 符号只要
// 出现在文件任意位置就算命中（包括注释 / 字符串）。它防的是「删实现 / 改函数名后旧名从源码里
// 彻底消失」这类漂移，不是语义级实现证明；升 AST 要引入解析器依赖（本阶段不为此加依赖），
// 故保持文本匹配并在 README 锚点小节写明这条口径。
function checkGuaranteeAnchors(readme, root = ROOT) {
  const problems = [];
  const ids = guaranteeItemIds(readme);
  if (ids == null) {
    problems.push('README.md 找不到「## 防丢稿设计（当前保证）」小节');
    return problems;
  }
  if (new Set(ids).size !== ids.length) {
    problems.push(`保证清单编号重复：${ids.filter((id, i) => ids.indexOf(id) !== i).join('、')}`);
  }
  const rows = guaranteeAnchorRows(readme);
  if (rows == null) {
    problems.push('README.md 找不到「### 保证清单的代码锚点（version-sync 门禁）」小节');
    return problems;
  }
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.id)) problems.push(`保证清单代码锚点重复：${row.id}`);
    seen.add(row.id);
    for (const segment of row.cell.split('；')) {
      const pair = GUARANTEE_PAIR_RE.exec(segment.trim());
      if (!pair) {
        problems.push(`保证 ${row.id} 的锚点格式不对（应写成 \`文件\` → \`实现符号\`）：${segment.trim()}`);
        continue;
      }
      const rel = pair[1];
      const symbol = pair[2];
      const abs = path.resolve(root, rel);
      if (!abs.startsWith(path.resolve(root) + path.sep)) {
        problems.push(`保证 ${row.id} 的锚点越出仓库目录：${rel}`);
        continue;
      }
      if (!fs.existsSync(abs)) {
        problems.push(`保证 ${row.id} 的代码位置不存在：${rel}`);
        continue;
      }
      // 审计残留修复 #R16：文本 includes 命中即可（注释里出现也算）——见函数头口径说明。
      if (!fs.readFileSync(abs, 'utf8').includes(symbol)) {
        problems.push(`保证 ${row.id} 的落点 ${rel} 里找不到「${symbol}」`);
      }
    }
  }
  const missing = ids.filter((id) => !seen.has(id));
  if (missing.length) problems.push(`这些保证条目没有代码锚点：${missing.join('、')}`);
  const extra = rows.filter((row) => !ids.includes(row.id)).map((row) => row.id);
  if (extra.length) problems.push(`锚点表里有不存在的保证编号：${extra.join('、')}`);
  return problems;
}

// 审计修复 #26（M1）：E2E 组文件数量 / 编号与 README 两处描述一致。
function checkE2eGroupDocs(readme, root = ROOT) {
  const problems = [];
  let files;
  try {
    files = fs.readdirSync(path.join(root, 'scripts', 'e2e', 'groups'));
  } catch {
    problems.push('找不到 scripts/e2e/groups 目录');
    return problems;
  }
  const names = files.filter((name) => /^\d+-.+\.js$/.test(name));
  const count = names.length;
  const numbers = names.map((name) => Number.parseInt(name, 10)).sort((a, b) => a - b);
  const first = numbers.length ? numbers[0] : null;
  const last = numbers.length ? numbers[numbers.length - 1] : null;
  const continuous = numbers.every((value, index) => value === index);
  if (!continuous || first !== 0) {
    problems.push(`scripts/e2e/groups 的组文件编号应从 00 连续排到 ${pad2(count - 1)}（实际 ${first}–${last}）`);
  }
  const harness = readme.match(/场景与 (\d+) 个组文件共用一份/);
  if (!harness) problems.push('README.md 找不到「场景与 N 个组文件共用一份」');
  else if (Number(harness[1]) !== count) {
    problems.push(`README.md 写 ${harness[1]} 个组文件，实际 ${count} 个`);
  }
  const detail = readme.match(/\*\*(\d+) 个组文件（(\d+)–(\d+)）\*\*/);
  if (!detail) problems.push('README.md 找不到「N 个组文件（0–NN）」');
  else {
    if (Number(detail[1]) !== count) problems.push(`README.md 写 ${detail[1]} 个组文件，实际 ${count} 个`);
    const expectedLast = pad2(count - 1);
    if (detail[2] !== '00' || detail[3] !== expectedLast) {
      problems.push(`README.md 的组文件编号范围应为 00–${expectedLast}（实际 ${detail[2]}–${detail[3]}）`);
    }
  }
  return problems;
}

// 审计修复 #26（M1）：README 关于 Electron fuse 的说法必须与 package.json 实配一致。
// 只认「已开」这个方向：配置真开了而文档还说没开（M1 的原始漂移），或配置被关掉而文档还宣称已开，都报红。
function checkFuseDocs(readme, pkg) {
  const problems = [];
  const fuses = pkg && pkg.build && pkg.build.electronFuses;
  if (!fuses) {
    problems.push('package.json 缺 build.electronFuses（README 的 fuse 说明无法核对）');
    return problems;
  }
  for (const key of ['enableEmbeddedAsarIntegrityValidation', 'onlyLoadAppFromAsar']) {
    if (fuses[key] !== true) problems.push(`package.json 的 ${key} 应为 true（README 声明已开）`);
  }
  if (!/已开[^\n]*enableEmbeddedAsarIntegrityValidation[^\n]*onlyLoadAppFromAsar/.test(readme)) {
    problems.push('README.md 要如实写明 enableEmbeddedAsarIntegrityValidation 与 onlyLoadAppFromAsar 两个 fuse 已开');
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

  // 计数口径（T-25 ③，写明而不是硬阻塞）：README / 验收清单里的「单测 N 项 / E2E N 项」是**机器实测
  // 锚点**，只能由维护者在跑完 `npm test` / `pnpm run e2e` 后 `node scripts/version-sync.js --write
  // --unit <实测> --e2e <实测>` 同步。--check 不带 --unit/--e2e 时只核对两处文档**互相对得上**
  // （防止只改一处漂移）；带期望值时逐项核对实测值。本地日常改测试 / 加断言后计数必然变化，
  // 若让默认 --check 直接红，每次正常开发都会被假红卡住——所以「实测 vs 文档」的强核对放在
  // 显式传期望值的门禁调用里（每批门禁命令都带 --unit/--e2e），默认路径只做文档一致性告警/红灯。
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

  // DOC-01（低）：README 只允许一处 E2E 总数表述（第二句式不会被 --write 同步，必然漂移）。
  const extraTotals = extraE2eTotals(readme);
  if (extraTotals.length) {
    problems.push(
      `README.md 只允许一处 E2E 总数表述（「真实启动 Electron 走 N 项主流程」），还找到：${extraTotals.join('、')}`
    );
  }
  for (const problem of checkIndexHtml(indexHtml)) problems.push(problem);
  // 审计修复 #26（M1 / M5 / ▲V309）：结构描述也进门禁 —— 保证清单代码锚点 + E2E 组数 + fuse 说明。
  const root = options.root || ROOT;
  for (const problem of checkGuaranteeAnchors(readme, root)) problems.push(problem);
  for (const problem of checkE2eGroupDocs(readme, root)) problems.push(problem);
  if (options.packageJson) {
    for (const problem of checkFuseDocs(readme, options.packageJson)) problems.push(problem);
  }
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
    e2eCount,
    packageJson: pkg
  });
  if (problems.length) {
    for (const problem of problems) console.error(`- ${problem}`);
    console.error('版本单一事实来源校验失败：改完跑 node scripts/version-sync.js --write');
    return 1;
  }
  console.log(
    `版本单一事实来源校验通过：package.json v${version}、README / 验收清单一致、界面无静态版本串、保证清单一事一锚点`
  );
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
  checkIndexHtml,
  // 审计修复 #26（M1 / M5 / ▲V309）：结构描述门禁（单测可对合成 README / 临时目录单独驱动）
  checkGuaranteeAnchors,
  checkE2eGroupDocs,
  checkFuseDocs
};
