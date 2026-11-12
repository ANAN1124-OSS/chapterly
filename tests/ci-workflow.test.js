'use strict';
// 1.7.0 G1b：GitHub Actions CI 工作流的静态锚点（先于实现写，首跑必须是 RED）。
//
// 只锁五件事，防止「装着装着把 CI 换了」：
//   ① `.github/workflows/` 下**只有 verify.yml 一个** CI 文件（多一条就多占配额、多发噪音）；
//   ② 文件能按 UTF-8 读出来、不带 BOM、没有 tab 缩进、顶层键齐全——零依赖环境下没有 YAML
//      解析器，这里做的是「文本级可读 + 结构齐全」校验，真正的语法由 push 后 Actions 首跑判定；
//   ③ runs-on 必须是 **windows-latest**：单测里含 Windows 路径 / GBK / UNC 语义，ubuntu 会假红；
//   ④ 必备步骤按序齐全：`pnpm install --frozen-lockfile` → 全量 `node --check` → `npm test` →
//      `node scripts/a11y-gate.js --static`（npm 级命令写死，避免只改 package.json 就偷换门禁）；
//   ⑤ E2E 不进 CI（要起 Electron、要真窗口，只留本地 `pnpm e2e`）。
//
// 为什么用「文本断言」而不是解析 YAML：不新增 devDependency（红线：只加不错），Node 24 也没有
// 内置 YAML 解析器；把结构约束写成逐条文本断言，既零依赖，坏了也能一眼看出哪条被改。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');
const WORKFLOW = path.join(WORKFLOWS_DIR, 'verify.yml');

function readWorkflow() {
  assert.ok(fs.existsSync(WORKFLOW), '.github/workflows/verify.yml 不存在');
  return fs.readFileSync(WORKFLOW, 'utf8');
}

test('只有 verify.yml 一个 CI 工作流文件（不发散成多个 workflow）', () => {
  assert.ok(fs.existsSync(WORKFLOWS_DIR), '.github/workflows/ 目录不存在');
  const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => /.ya?ml$/.test(f)).sort();
  assert.deepEqual(files, ['verify.yml'], '工作流目录里只能有 verify.yml');
});

test('workflow 能按 UTF-8 读出来：不带 BOM、没有 tab 缩进、末尾有换行', () => {
  const text = readWorkflow();
  assert.ok(text.length > 0, 'workflow 是空文件');
  assert.ok(!text.startsWith('\uFEFF'), 'workflow 带了 BOM，Actions 解释器会读坏第一行');
  assert.ok(!text.includes('\t'), 'workflow 里有 tab 缩进（YAML 只认空格）');
  assert.ok(text.endsWith('\n'), 'workflow 末尾缺换行');
  // 「文本级可读」的最小结构：至少三行非空、每行要么是注释/空白，要么以空格或键名开头
  const lines = text.split(/\r?\n/);
  const bad = lines.find((line, i) => line.trim() && !/^(\s|#)/.test(line) && !/^[A-Za-z_][\w.-]*:/.test(line));
  assert.equal(bad, undefined, '有行既不是缩进行、也不是顶层键、也不是注释：' + String(bad));
});

test('顶层键齐全（name / on / jobs），jobs 下只有 verify 一个 job', () => {
  const text = readWorkflow();
  for (const key of ['name:', 'on:', 'jobs:']) {
    assert.match(text, new RegExp('^' + key.replace(':', '\\:'), 'm'), '缺顶层键 ' + key);
  }
  const jobKeys = text
    .split(/\r?\n/)
    .filter((line) => /^ {2}[A-Za-z_][\w-]*:\s*$/.test(line))
    .map((line) => line.trim().replace(':', ''));
  const inJobs = text.slice(text.indexOf('\njobs:'));
  const declared = jobKeys.filter((key) => inJobs.includes('  ' + key + ':'));
  assert.deepEqual(declared, ['verify'], 'jobs 下只能有 verify 一个 job');
});

test('runs-on 是 windows-latest（Windows 桌面工具的路径 / GBK / UNC 语义不能靠 ubuntu 验）', () => {
  const text = readWorkflow();
  assert.match(text, /^ {4}runs-on: windows-latest$/m, 'runs-on 必须是 windows-latest');
  assert.doesNotMatch(text, /\bubuntu-|\bmacos-/, '不允许再挂 ubuntu / macos 矩阵');
});

test('步骤按序齐全：checkout → setup-node 24 → pnpm 12.11.2（run_install: false）→ frozen-lockfile → node --check → npm test → a11y --static', () => {
  const text = readWorkflow();
  const order = [
    'actions/checkout@v4',
    'actions/setup-node@v4',
    'node-version: 24',
    'pnpm/action-setup@v4',
    'version: 12.11.2',
    'run_install: false',
    'pnpm install --frozen-lockfile',
    'node --check "$f"',
    'git ls-files',
    'npm test',
    'node scripts/a11y-gate.js --static',
  ];
  let last = -1;
  for (const token of order) {
    const at = text.indexOf(token);
    assert.ok(at >= 0, '缺步骤片段：' + token);
    assert.ok(at > last, '步骤顺序不对：' + token + ' 出现在上一段之前');
    last = at;
  }
});

test('全量 node --check 跑在 bash 里，且任一文件失败就让步骤失败', () => {
  const text = readWorkflow();
  assert.match(text, /shell: bash/, 'node --check 的循环要用 bash（windows 默认是 pwsh）');
  assert.match(text, /node --check "\$f"/, '要逐个文件跑 node --check "$f"');
  assert.match(text, /git ls-files '\*\.js'/, '要用 git ls-files 列出全量 js');
  assert.match(text, /\|\| exit 1|exit \$fail|set -e/, '任一文件失败必须让步骤非零退出');
});

test('E2E 不进 CI：工作流里不出现 e2e 命令（注释里说明「不进 CI」不算命令）', () => {
  const text = readWorkflow();
  const commands = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  assert.doesNotMatch(commands, /run-e2e|(?:pnpm|npm|npx|yarn)\s+(?:run\s+)?e2e\b/i, 'CI 里不允许出现 e2e 命令');
});

test('依赖安装以锁文件为准：pnpm-lock.yaml 入库且步骤里不出现裸 pnpm install', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'pnpm-lock.yaml')), 'pnpm-lock.yaml 必须入库');
  const text = readWorkflow();
  assert.doesNotMatch(text, /pnpm install(?! --frozen-lockfile)/, '安装步骤只能带 --frozen-lockfile');
});
