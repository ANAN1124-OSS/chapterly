'use strict';
// 1.7.0 G1b：GitHub Actions CI 工作流的静态锚点（先于实现写，首跑必须是 RED）。
//
// 审计修复 #29（O1）起，这条闸门同时锁「CI 供应链固定」与「定时 E2E」：
//   ① `.github/workflows/` 下只有 verify.yml / e2e-weekly.yml / e2e-pr.yml 三个 CI 文件（WP16 新增 PR 级 E2E）；
//   ② 所有 actions **固定到 40 位提交 SHA**（注释标版本），不跟浮动的 @v4 标签；
//   ③ 运行镜像固定 **windows-2022**（不用浮动的 windows-latest；Windows 路径 / GBK / UNC 语义不能靠 ubuntu 验）；
//   ④ verify.yml 仍做原来四步（全量 node --check → npm test → eslint → a11y 静态），仍跳过 Electron 二进制；
//   ⑤ e2e-weekly.yml 每周定时整跑一次全量 E2E，e2e-pr.yml 在 PR 改动 renderer/core/ipc 等路径时也整跑全量；
//      两者都必须装 Electron 二进制（跳过下载就起不了真窗口）；
//   ⑥ Dependabot 每周提 github-actions 更新（pin 死后的升级通道）；
//   ⑦ E2E 不进 verify.yml、打包冒烟仍不进 CI（按发版门禁在发版前本地执行，D-4）。
//
// 为什么用「文本断言」而不是解析 YAML：不新增 devDependency（红线：只加不错），Node 24 也没有
// 内置 YAML 解析器；把结构约束写成逐条文本断言，既零依赖，坏了也能一眼看出哪条被改。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');
const VERIFY_PATH = path.join(WORKFLOWS_DIR, 'verify.yml');
const E2E_PATH = path.join(WORKFLOWS_DIR, 'e2e-weekly.yml');
const E2E_PR_PATH = path.join(WORKFLOWS_DIR, 'e2e-pr.yml');
const DEPENDABOT_PATH = path.join(ROOT, '.github', 'dependabot.yml');

function readUtf8(file) {
  assert.ok(fs.existsSync(file), file + ' 不存在');
  return fs.readFileSync(file, 'utf8');
}

const readVerify = () => readUtf8(VERIFY_PATH);
const readE2e = () => readUtf8(E2E_PATH);
// 新 checkout 上工作区是 CRLF；Policy 断言里用 ^…$ 跨行匹配，先归一成 LF（与 wp16-regression 同口径）。
const readE2ePr = () => readUtf8(E2E_PR_PATH).replace(/\r\n/g, '\n');
const readDependabot = () => readUtf8(DEPENDABOT_PATH);
// TEST-D-01：从 wp18 迁来的 CI 矩阵用例沿用 wp18 的 readSource 口径（读相对路径 + 归一 LF）。
const readSource = (rel) => readUtf8(path.join(ROOT, rel)).replace(/\r\n/g, '\n');

// 去掉注释行后的「真命令」文本：注释里说明「不进 CI」不算命令。
function commandsOf(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

const PINNED_USES_RE = /^\s*-?\s*uses:\s*[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@([0-9a-f]{40})\s+#\s*v(\d+\.\d+\.\d+)\s*$/;

function usesLines(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => /^\s*-?\s*uses:\s/.test(line));
}

test('工作流文件只有 verify.yml / e2e-weekly.yml / e2e-pr.yml（不发散成多个 workflow）', () => {
  assert.ok(fs.existsSync(WORKFLOWS_DIR), '.github/workflows/ 目录不存在');
  const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => /.ya?ml$/.test(f)).sort();
  // WP16（审计中 #19 / F1）：新增 e2e-pr.yml 承担 PR 级路径过滤 E2E；不允许再发散出第四套。
  assert.deepEqual(files, ['e2e-pr.yml', 'e2e-weekly.yml', 'verify.yml'], '工作流目录只能是 verify / e2e-weekly / e2e-pr（审计 O1 + F1）');
});

test('workflow 能按 UTF-8 读出来：不带 BOM、没有 tab 缩进、末尾有换行', () => {
  for (const file of [VERIFY_PATH, E2E_PATH, E2E_PR_PATH]) {
    const text = readUtf8(file);
    const name = path.basename(file);
    assert.ok(text.length > 0, name + ' 是空文件');
    assert.ok(!text.startsWith('\uFEFF'), name + ' 带了 BOM，Actions 解释器会读坏第一行');
    assert.ok(!text.includes('\t'), name + ' 里有 tab 缩进（YAML 只认空格）');
    assert.ok(text.endsWith('\n'), name + ' 末尾缺换行');
    // 「文本级可读」的最小结构：至少三行非空、每行要么是注释/空白，要么以空格或键名开头
    const lines = text.split(/\r?\n/);
    const bad = lines.find((line) => line.trim() && !/^(\s|#)/.test(line) && !/^[A-Za-z_][\w.-]*:/.test(line));
    assert.equal(bad, undefined, name + ' 有行既不是缩进行、也不是顶层键、也不是注释：' + String(bad));
  }
});

test('顶层键齐全（name / on / jobs），jobs 下只有该工作流自己的一个 job', () => {
  for (const [file, job] of [
    [VERIFY_PATH, 'verify'],
    [E2E_PATH, 'e2e'],
    [E2E_PR_PATH, 'e2e']
  ]) {
    const text = readUtf8(file);
    const name = path.basename(file);
    for (const key of ['name:', 'on:', 'jobs:']) {
      assert.match(text, new RegExp('^' + key.replace(':', '\\:'), 'm'), name + ' 缺顶层键 ' + key);
    }
    const inJobs = text.slice(text.indexOf('\njobs:'));
    const declared = text
      .split(/\r?\n/)
      .filter((line) => /^ {2}[A-Za-z_][\w-]*:\s*$/.test(line))
      .map((line) => line.trim().replace(':', ''))
      .filter((key) => inJobs.includes('  ' + key + ':'));
    assert.deepEqual(declared, [job], name + ' 的 jobs 下只能有 ' + job + ' 一个 job');
  }
});

test('全部 actions 固定到 40 位提交 SHA + 版本注释（审计 O1：不跟浮动的 @v4 标签）', () => {
  for (const file of [VERIFY_PATH, E2E_PATH, E2E_PR_PATH]) {
    const name = path.basename(file);
    const lines = usesLines(readUtf8(file));
    assert.ok(lines.length >= 3, name + ' 应至少有 checkout / setup-node / pnpm 三个 action（实际 ' + lines.length + '）');
    for (const line of lines) {
      assert.match(line, PINNED_USES_RE, name + ' 的 action 没 pin 到提交 SHA + 版本注释：' + line.trim());
    }
  }
  // pin 死后要有升级通道：Dependabot 每周提 github-actions 更新。
  const dependabot = readDependabot();
  assert.match(dependabot, /^version: 2$/m, 'dependabot.yml 用 version 2');
  assert.match(dependabot, /package-ecosystem: github-actions/, '要覆盖 github-actions 生态');
  assert.match(dependabot, /schedule:\s*\n\s*interval: weekly/, '每周检查一次更新');
});

test('runs-on 固定 windows-2022（Windows 桌面工具的路径 / GBK / UNC 语义不能靠 ubuntu 验）', () => {
  for (const file of [VERIFY_PATH, E2E_PATH, E2E_PR_PATH]) {
    const text = readUtf8(file);
    const name = path.basename(file);
    assert.match(text, /^ {4}runs-on: windows-2022$/m, name + ' 的 runs-on 必须是 windows-2022（审计 O1：windows-latest 浮动）');
    assert.doesNotMatch(text, /runs-on:\s*(ubuntu-|macos-)/, name + ' 不允许 ubuntu / macos 矩阵');
    assert.doesNotMatch(text, /runs-on:\s*windows-latest/, name + ' 不许用浮动的 windows-latest');
  }
});

// REPO-01（2026-11-21 第五轮审计）：三步顺序里 pnpm 必须在 setup-node 之前 ——
// setup-node 的 cache: 'pnpm' 要现场执行 `pnpm store path`，pnpm 还没装就报
// 「Unable to locate executable file: pnpm」。
test('步骤按序齐全：checkout → pnpm 12.11.2（run_install: false）→ setup-node（22/24 矩阵 + pnpm 缓存）→ frozen-lockfile → node --check → npm test → eslint → a11y --static', () => {
  const text = readVerify();
  const order = [
    'actions/checkout@',
    'pnpm/action-setup@',
    'version: 12.11.2',
    'run_install: false',
    'actions/setup-node@',
    'node-version: ${{ matrix.node }}',
    'cache-dependency-path: pnpm-lock.yaml',
    'pnpm install --frozen-lockfile',
    'node --check "$f"',
    'git ls-files',
    'npm test',
    'npx eslint .',
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

test('REPO-01：三个工作流都缓存 pnpm store，E2E 两个再按版本缓存 Electron zip', () => {
  const verify = readVerify();
  assert.match(verify, /cache: 'pnpm'/, 'verify 要缓存 pnpm store');
  assert.match(verify, /cache-dependency-path: pnpm-lock\.yaml/, 'pnpm 缓存按锁文件哈希命中');
  const pnpmAt = verify.indexOf('pnpm/action-setup@');
  const setupAt = verify.indexOf('actions/setup-node@');
  assert.ok(
    pnpmAt > 0 && setupAt > 0 && pnpmAt < setupAt,
    'pnpm/action-setup 必须排在 setup-node 之前（否则 cache 定位不到 store）'
  );
  for (const [name, text] of [['e2e-weekly.yml', readE2e()], ['e2e-pr.yml', readE2ePr()]]) {
    assert.match(text, /cache: 'pnpm'/, name + ' 要缓存 pnpm store');
    assert.match(text, /uses: actions\/cache@[0-9a-f]{40} # v4\.3\.0/, name + ' 要按 SHA pin actions/cache');
    assert.match(text, /key: electron-45\.1\.0-win32-x64/, name + ' 的 Electron 缓存 key 要按版本固定');
  }
  // verify 跳过 Electron 二进制下载：不引入用不上的 Electron 缓存。
  assert.equal(verify.includes('electron-45.1.0-win32-x64'), false);
});

// CI-F3（2026-11-24 复核补审）：Electron zip 缓存必须与「确保二进制就位」看同一个目录。
// 旧实现缓存 path 用 ${{ env.LOCALAPPDATA }}\electron\Cache，pwsh 里也用 $env:LOCALAPPDATA；
// 两处都取 runner 的环境值，job 内任一处被改写就分叉成「缓存命中但解压看不到」。统一落到
// 工作区 .electron-cache，pwsh 用 $env:GITHUB_WORKSPACE 拼同一个目录；缓存目录进 .gitignore。
test('CI-F3：E2E 两个工作流的 Electron 缓存 path 与 pwsh 引用同一 workspace 目录', () => {
  for (const [name, raw] of [['e2e-weekly.yml', readE2e()], ['e2e-pr.yml', readE2ePr()]]) {
    const text = raw.replace(/\r\n/g, '\n');
    assert.match(
      text,
      /path: \$\{\{ github\.workspace \}\}\/\.electron-cache\n/,
      name + ' 的 actions/cache path 必须落在 ${{ github.workspace }}/.electron-cache'
    );
    assert.match(
      text,
      /\$cache = Join-Path \$env:GITHUB_WORKSPACE '\.electron-cache'/,
      name + ' 的 pwsh 缓存变量必须用 $env:GITHUB_WORKSPACE 拼同一个目录'
    );
    assert.equal(
      commandsOf(text).includes('LOCALAPPDATA'),
      false,
      name + ' 的真命令里不能再出现 LOCALAPPDATA（缓存与解压各看一处会分叉）'
    );
  }
  assert.match(readUtf8(path.join(ROOT, '.gitignore')), /^\.electron-cache\/?$/m, '工作区缓存目录要进 .gitignore');
});

// 审计修复 #56（O4）：engines 声明 node >=22，CI 必须真跑 22（不能只测开发机的 24）。
test('verify.yml 用 Node 22 / 24 两档矩阵，fail-fast: false', () => {
  const text = readVerify().replace(/\r\n/g, '\n');
  assert.match(text, /^ {4}strategy:\n {6}fail-fast: false\n {6}matrix:\n {8}node: \[22, 24\]$/m, 'verify.yml 必须声明 Node 22 / 24 矩阵（fail-fast: false）');
  assert.match(text, /node-version: \$\{\{ matrix\.node \}\}/, 'setup-node 必须读 matrix.node');
  assert.equal(text.includes('node-version: 24'), false, '不能再写死单档 Node 24');
});

test('全量 node --check 跑在 bash 里，且任一文件失败就让步骤失败', () => {
  const text = readVerify();
  assert.match(text, /shell: bash/, 'node --check 的循环要用 bash（windows 默认是 pwsh）');
  assert.match(text, /node --check "\$f"/, '要逐个文件跑 node --check "$f"');
  assert.match(text, /git ls-files '\*\.js'/, '要用 git ls-files 列出全量 js');
  assert.match(text, /\|\| exit 1|exit \$fail|set -e/, '任一文件失败必须让步骤非零退出');
});

test('verify.yml 仍不跑 E2E（E2E 挪到每周定时的 e2e-weekly.yml）', () => {
  const commands = commandsOf(readVerify());
  assert.doesNotMatch(commands, /run-e2e|(?:pnpm|npm|npx|yarn)\s+(?:run\s+)?e2e\b/i, 'verify.yml 里不允许出现 e2e 命令');
  // 单测与静态门禁不需要 Electron 二进制，继续跳过下载（省 100 MB+ 与镜像不确定性）。
  assert.match(readVerify(), /ELECTRON_SKIP_BINARY_DOWNLOAD: 1/, 'verify.yml 仍要跳过 Electron 二进制下载');
});

test('e2e-weekly.yml 每周定时整跑 E2E，且装 Electron 二进制', () => {
  const text = readE2e();
  assert.match(text, /schedule:[\s\S]{0,200}?cron: '[^']+'/, '必须有 schedule.cron 定时触发');
  assert.match(text, /cron: '\d+ \d+ \* \* \d'/, 'cron 要写成每周一次的标准五段式');
  const commands = commandsOf(text);
  assert.match(commands, /run: pnpm run e2e/, '定时任务要整跑全量 E2E（pnpm run e2e）');
  assert.match(commands, /pnpm install --frozen-lockfile/, 'E2E 依赖仍以锁文件为准');
  assert.equal(
    text.includes('ELECTRON_SKIP_BINARY_DOWNLOAD'),
    false,
    'E2E 必须安装 Electron 二进制（跳过下载就起不了真窗口）'
  );
  assert.match(text, /timeout-minutes: ([3-9]\d|[1-9]\d{2,})/, 'E2E 是长场景，超时要给足（≥ 30 分钟）');
  assert.match(text, /tzutil \/s "China Standard Time"/, 'E2E 要固定时区（统计 / 日期断言按 +08）');
  // 发版 2.1.0 的 CI 适配：hosted runner 无交互式桌面会话，动效 / 主题 / 几何断言必然偏。
  // CI 必须显式设 E2E_SKIP_VISUAL=1（跳过 44 处 checkVisual，运行时展开 50 项），功能与供应链断言仍阻塞；
  // 跳过面由 scripts/e2e/visual-assertions.js 的静态清单约束（wiring-check 逐项核对）。
  // 本地 / 发版前的全量 E2E 不带这个开关（run-e2e 默认全跑）。
  assert.match(text, /E2E_SKIP_VISUAL: '1'/, 'CI 必须显式跳过视觉断言（否则 hosted runner 必红）');
});

// T-25（三次审查 · 低）：E2E 失败时 hosted runner 用后即毁，必须把临时目录（日志 / 演练书库）传成
// artifact 才能排查；动作沿用全仓 SHA pin 风格（PINNED_USES_RE 已在上面统一核对）。
test('T-25：两个 E2E 工作流在失败时上传临时目录 artifact（SHA pin + if: failure）', () => {
  for (const [name, text] of [['e2e-weekly.yml', readE2e()], ['e2e-pr.yml', readE2ePr()]]) {
    assert.match(
      text,
      /- name: 失败现场[^\r\n]*\r?\n\s+if: failure\(\)\r?\n\s+uses: actions\/upload-artifact@[0-9a-f]{40} # v\d+\.\d+\.\d+/,
      name + ' 失败时必须上传 E2E 现场（if: failure + SHA pin 的 upload-artifact）'
    );
    assert.match(text, /path: \$\{\{ runner\.temp \}\}\/cw-e2e-\*/, name + ' 上传 run-e2e 的临时目录（cw-e2e-*）');
    assert.match(text, /if-no-files-found: warn/, name + ' 没留下现场时不要额外把任务判红');
  }
});

// C5=F3（审计 #24）：engines 声明 node >=22，每周 E2E 不能只测开发机的 24 —— 与 verify 同口径补矩阵。
test('e2e-weekly.yml 用 Node 22 / 24 两档矩阵（engines ≥22 下限进集成回归）', () => {
  const text = readE2e().replace(/\r\n/g, '\n');
  assert.match(
    text,
    /^ {4}strategy:\n {6}fail-fast: false\n {6}matrix:\n {8}node: \[22, 24\]$/m,
    'e2e-weekly 必须声明 Node 22 / 24 矩阵（fail-fast: false）'
  );
  assert.match(text, /node-version: \$\{\{ matrix\.node \}\}/, 'setup-node 必须读 matrix.node');
  assert.equal(text.includes('node-version: 24'), false, '不能再写死单档 Node 24');
  const commands = commandsOf(text);
  assert.match(commands, /run: pnpm run e2e/, '矩阵不能削掉全量 E2E');
  assert.match(commands, /node scripts\/supply-chain-check\.js/, '矩阵不能削掉供应链校验');
});

test('依赖安装以锁文件为准：pnpm-lock.yaml 入库且三个工作流里不出现裸 pnpm install', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'pnpm-lock.yaml')), 'pnpm-lock.yaml 必须入库');
  for (const file of [VERIFY_PATH, E2E_PATH, E2E_PR_PATH]) {
    const text = readUtf8(file);
    // T7 方向：只扫真正会执行的命令（commandsOf 去掉 # 注释行）。发版 2.1.0 修 e2e-weekly 的
    // Electron 缓存缺口时，注释里「pnpm install 直接从 store 解压」被这条全文断言误判成违规；
    // 注释不是命令，收紧到命令面即可，强度不降（run: 行仍然逐条查）。
    assert.doesNotMatch(
      commandsOf(text),
      /pnpm install(?! --frozen-lockfile)/,
      path.basename(file) + ' 的安装步骤只能带 --frozen-lockfile'
    );
  }
});

test('eslint 进 CI 且只做检查：npx eslint . 独立步骤、不许 --fix / continue-on-error（D-4 / WP-35）', () => {
  const text = readVerify();
  assert.match(text, /^ {8}run: npx eslint \.$/m, 'CI 必须有一行 run: npx eslint .（no-undef 为 error）');
  const commands = commandsOf(text);
  assert.doesNotMatch(commands, /eslint[^\n]*--fix/, 'CI 里不许 --fix：检查步骤不能偷偷改工作区');
  assert.doesNotMatch(commands, /continue-on-error/, 'eslint 步骤不许 continue-on-error（失败必须红）');
  const npmTest = commands.indexOf('npm test');
  const eslint = commands.indexOf('npx eslint .');
  const a11y = commands.indexOf('node scripts/a11y-gate.js --static');
  assert.ok(npmTest >= 0, '找不到 npm test 步骤');
  assert.ok(eslint > npmTest, 'eslint 必须排在单测之后');
  assert.ok(a11y > eslint, 'a11y 静态门禁必须排在 eslint 之后');
});

test('打包冒烟仍不进 CI：三个工作流的命令里都不出现 electron-builder / dist 脚本（D-4）', () => {
  for (const file of [VERIFY_PATH, E2E_PATH, E2E_PR_PATH]) {
    const commands = commandsOf(readUtf8(file));
    assert.doesNotMatch(
      commands,
      /electron-builder|(?:pnpm|npm|npx|yarn)\s+(?:run\s+)?dist(?::dir)?\b/i,
      path.basename(file) + ' 里不允许打包命令（打包冒烟按发版门禁在本地执行）'
    );
  }
});

// WP16（审计中 #19 / F1）：PR 改动 renderer/core 等路径时整跑全量 E2E；每周全量仍保留。
test('e2e-pr.yml：PR 路径过滤触发全量 E2E，且装配真实 Electron + 供应链校验（F1）', () => {
  const text = readE2ePr();
  assert.match(text, /^on:\n {2}pull_request:\n {4}paths:$/m, '必须由 pull_request.paths 触发（PR 级拦截）');
  assert.match(text, /^ {6}- 'renderer\/\*\*'$/m, 'renderer/** 必须触发');
  assert.match(text, /^ {6}- 'core\/\*\*'$/m, 'core/** 必须触发');
  const commands = commandsOf(text);
  assert.match(commands, /pnpm install --frozen-lockfile/);
  assert.match(commands, /node scripts\/supply-chain-check\.js/, '与 weekly 同口径：先核对 Electron 二进制');
  assert.match(commands, /tzutil \/s "China Standard Time"/);
  assert.match(commands, /run: pnpm run e2e\b/, 'PR 触发时必须整跑全量 E2E');
  assert.doesNotMatch(commands, /ELECTRON_SKIP_BINARY_DOWNLOAD/, '真窗口 E2E 必须装 Electron 二进制');
  assert.match(text, /^ {4}runs-on: windows-2022$/m);
  assert.match(text, /timeout-minutes: ([3-9]\d|[1-9]\d{2,})/, 'E2E 长场景超时要给足（≥ 30 分钟）');
  // 每周全量不因新增 PR 工作流被替代
  assert.match(commandsOf(readE2e()), /run: pnpm run e2e/, 'e2e-weekly 仍保留每周全量');
  // 与 e2e-weekly 同口径：PR 级 E2E 也显式跳过视觉断言（hosted runner 无桌面会话）
  assert.match(text, /E2E_SKIP_VISUAL: '1'/, 'PR 级 E2E 也要显式跳过视觉断言');
});

test('README 如实描述三套 CI（verify + PR 级 E2E + 每周 E2E）与「打包冒烟仍在本地」', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /\.github\/workflows\/verify\.yml/, 'README 要写明 verify 工作流');
  assert.match(readme, /\.github\/workflows\/e2e-weekly\.yml/, 'README 要写明每周 E2E 工作流');
  assert.match(readme, /\.github\/workflows\/e2e-pr\.yml/, 'README 要写明 PR 级 E2E 工作流');
  assert.match(readme, /PR[^\n]*E2E/, 'README 要写明「PR 改动 renderer/core 就整跑 E2E」');
  assert.match(readme, /每周定时[^\n]*E2E/, 'README 要写明 E2E 每周定时跑');
  assert.match(readme, /固定到提交 SHA/, 'README 要写明 actions pin SHA');
  assert.match(readme, /打包冒烟[\s\S]{0,80}?本地执行/, 'README 仍要如实写「打包冒烟在发版前本地执行」');
  // 审计修复 #56（O4）：Node 矩阵与 pnpm 下限要和 CI / workspace 配置一致
  assert.match(readme, /Node 用 22 \/ 24 两档矩阵/, 'README 要写明 verify.yml 的 Node 22/24 矩阵');
  assert.match(readme, /pnpm ≥ 12/, 'pnpm 下限按实测（12.11.2 所在大版本）写，不能留在未实测的 ≥10');
});
test('R18 C5=F3：e2e-weekly 与 verify 同口径补 Node 22 / 24 矩阵', () => {
  const weekly = readSource('.github/workflows/e2e-weekly.yml');
  const verify = readSource('.github/workflows/verify.yml');
  const pkg = JSON.parse(readSource('package.json'));
  const major = Number(String(pkg.engines && pkg.engines.node).replace(/[^0-9.]/g, '').split('.')[0]);
  assert.equal(major >= 22, true, 'engines 下限仍是 >=22');

  assert.match(
    weekly,
    /^ {4}strategy:\n {6}fail-fast: false\n {6}matrix:\n {8}node: \[22, 24\]$/m,
    'e2e-weekly 必须声明 Node 22 / 24 矩阵（fail-fast: false）'
  );
  assert.match(weekly, /node-version: \$\{\{ matrix\.node \}\}/, 'e2e-weekly 的 setup-node 必须读 matrix.node');
  assert.equal(weekly.includes('node-version: 24'), false, 'e2e-weekly 不许再写死单档 Node 24');
  assert.match(verify, /^ {6}matrix:\n {8}node: \[22, 24\]$/m, 'verify 的 22 / 24 矩阵保持不变');

  // 矩阵不能把 E2E 的关键步骤削掉：供应链校验 → 固定时区 → 全量 E2E
  const commands = weekly
    .split('\n')
    .filter((line) => line.trim().startsWith('run:'))
    .join('\n');
  assert.match(commands, /pnpm install --frozen-lockfile/);
  assert.match(commands, /node scripts\/supply-chain-check\.js/);
  assert.match(commands, /pnpm run e2e/);
  assert.match(weekly, /tzutil \/s "China Standard Time"/);
  assert.equal(weekly.includes('ELECTRON_SKIP_BINARY_DOWNLOAD'), false, 'E2E 仍要装 Electron 二进制');
});

// REPO-02（审计）：e2e-pr 只跑 Node 24 是「PR 时长」取舍，必须在工作流注释与 README 里写明，
// 不能再是「口径不一但无声明」的配置遗漏。
test('REPO-02：PR 级 E2E 的单 Node 版本取舍有声明，且与 weekly / verify 的口径分工写清楚', () => {
  const pr = readE2ePr();
  assert.match(pr, /只跑 Node 24/, 'e2e-pr.yml 必须写明 PR 档只跑 Node 24 的取舍');
  assert.match(pr, /e2e-weekly\.yml 的 22\/24 矩阵兜底/, '写明 Node 22 的 E2E 由 weekly 矩阵兜底');
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.match(readme, /E2E 档\*\*只跑 Node 24\*\*/, 'README 的 CI 一节要带同一句声明');
});
