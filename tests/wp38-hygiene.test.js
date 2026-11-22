'use strict';
// WP-38（v1.8.0 审计 D6/D7/D8/D11/X15）：工程卫生闸门。
//
// 这一包改的是「仓库外壳」而不是产品行为，所以锚点以静态断言 + 纯函数单测为主：
//   D6  .gitignore 的内部文档忽略从「7 个精确文件名」改成目录级 pattern；
//   D7  Python 版本有声明（README）且脚本入口自己先查（make-icon.py）；
//   D8  electron-builder 与 electron / eslint 一样精确固定，锁文件 specifier 同步；
//   D11 Electron 镜像保留国内默认、但写明覆盖方式（npm_config_electron_mirror / ELECTRON_MIRROR）；
//   X15 启动链：cmd 先查 node、start.js 没装依赖给 pnpm install 提示、信号杀死按失败退出。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readPkg = () => JSON.parse(read('package.json'));
const startLogic = require('../scripts/start-logic.js');

// ---------------------------------------------------------------- D6

test('D6：.gitignore 内部文档改目录级 pattern，公开文档不被误挡', () => {
  const lines = read('.gitignore')
    .split(/\r?\n/)
    .map((line) => line.trim());
  assert.ok(
    lines.includes('内部文档/'),
    '.gitignore 必须有目录级 pattern「内部文档/」：内部文档整目录忽略，改名 / 新增都不会漏挡'
  );
  // 老的「逐个人肉维护精确文件名」口径不许回来（审计 D6 的原问题：改名即漏挡）
  for (const legacy of [
    '项目交接.md',
    '功能扩展提案.md',
    '自动迭代手册.md',
    '进度日志.md',
    '下一阶段提案.md',
    '视觉重设计-C卷册-实施手册.md',
    '版本总账-章回.md',
    '归档-*.md',
  ]) {
    assert.ok(!lines.includes(legacy), `不要再按精确文件名忽略内部文档：${legacy}（D6）`);
  }
  // 公开文档必须继续进仓库：整体忽略 *.md 会把 README / 验收清单一起扫掉
  assert.ok(!lines.includes('*.md'), '不能整体忽略 *.md（README.md / 验收清单.md 是公开文档）');
  for (const rel of ['README.md', 'docs/验收清单.md', 'LICENSE']) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `公开文档必须留在仓库里：${rel}`);
  }
  // 审计 #28（M3）：版本沿革等纯历史文档已归档到被忽略的 内部文档/，不再进公开仓库。
  assert.ok(!fs.existsSync(path.join(ROOT, '沿革.md')), '版本沿革分册已归档到 内部文档/，不再进公开仓库');
  // README 写明这条约定，避免下次又回去逐个人肉加文件名
  assert.ok(read('README.md').includes('内部文档/'), 'README 要写明内部文档统一放「内部文档/」并被整目录忽略');
});

// ---------------------------------------------------------------- D7

test('D7：Python 版本有声明（README）且脚本入口自检（make-icon.py）', () => {
  const readme = read('README.md');
  assert.match(readme, /Python\s*≥\s*3\.7/, 'README 环境要求要声明 Python ≥ 3.7（唯一 Python 脚本 make-icon.py 用）');
  assert.ok(readme.includes('pnpm run icon'), 'README 要说明 Python 只用于重新生成图标');
  const pkg = readPkg();
  assert.equal(pkg.engines.node, '>=22', 'engines.node 口径不变');
  assert.equal(pkg.scripts.icon, 'python scripts/make-icon.py --ico-only build', 'icon 脚本仍指向唯一 Python 脚本');
  const pyScripts = fs.readdirSync(path.join(ROOT, 'scripts')).filter((name) => name.endsWith('.py'));
  assert.deepEqual(pyScripts, ['make-icon.py'], `Python 脚本只有 make-icon.py（实际：${pyScripts.join('、')}）`);
  const py = read('scripts/make-icon.py');
  assert.match(
    py,
    /sys\.version_info\s*<\s*\(3,\s*7\)/,
    'make-icon.py 必须先检查 Python ≥ 3.7（sys.stdout.reconfigure 需要 3.7+）'
  );
  assert.match(py, /sys\.exit\(/, '版本不够要直接退出并给提示，别留到 AttributeError');
});

// ---------------------------------------------------------------- D8

test('D8：electron-builder 与 electron / eslint 一样精确固定版本，锁文件 specifier 同步', () => {
  const dev = readPkg().devDependencies;
  const EXACT = /^\d+\.\d+\.\d+$/;
  for (const name of ['electron', 'electron-builder', 'eslint']) {
    assert.match(dev[name], EXACT, `${name} 必须精确固定版本（不许 ^ / ~ 范围，D8）`);
  }
  const lockLines = read('pnpm-lock.yaml').split(/\r?\n/);
  for (const name of ['electron', 'electron-builder', 'eslint']) {
    const at = lockLines.findIndex((line) => line === `      ${name}:`);
    assert.ok(at >= 0, `pnpm-lock.yaml 的 importers 里找不到 ${name}`);
    const spec = (lockLines[at + 1] || '').trim();
    assert.ok(spec.startsWith('specifier: '), `${name} 的锁文件条目下一行应是 specifier（实际：${spec}）`);
    assert.equal(
      spec.slice('specifier: '.length),
      dev[name],
      `${name} 的锁文件 specifier 与 package.json 不一致（pnpm install --frozen-lockfile 会红）`
    );
  }
});

// ---------------------------------------------------------------- D11

test('D11：Electron 镜像保留国内默认，但写明可覆盖（.npmrc / README / 打包配置）', () => {
  const npmrc = read('.npmrc');
  const mirrorLines = npmrc.split(/\r?\n/).filter((line) => /^\s*electron_mirror\s*=/.test(line));
  assert.equal(mirrorLines.length, 1, '.npmrc 里应只有一行 electron_mirror 默认值');
  assert.ok(mirrorLines[0].includes('npmmirror.com/mirrors/electron/'), '.npmrc 默认镜像不变（国内默认）');
  assert.ok(
    npmrc.includes('npm_config_electron_mirror'),
    '.npmrc 注释要写明覆盖方式（npm_config_electron_mirror 优先于本文件）'
  );
  const readme = read('README.md');
  assert.ok(readme.includes('npm_config_electron_mirror'), 'README 安装段要写明 npm_config_electron_mirror 覆盖方式');
  // M-N3（WP18）：打包段（ELECTRON_MIRROR 优先级）拆到维护者文档，口径不变。
  const maintain = read('docs/维护与自检.md');
  assert.ok(maintain.includes('ELECTRON_MIRROR'), '维护者文档打包段要写明 ELECTRON_MIRROR');
  assert.match(
    maintain,
    /ELECTRON_MIRROR[^\n]{0,200}?build\.electronDownload\.mirror/,
    '维护者文档要写清优先级：ELECTRON_MIRROR 覆盖 package.json 的 build.electronDownload.mirror'
  );
  assert.ok(readme.includes('docs/维护与自检.md'), 'README 要指向维护者文档');
  assert.equal(
    readPkg().build.electronDownload.mirror,
    'https://npmmirror.com/mirrors/electron/',
    '打包默认镜像仍保留（可被环境变量覆盖）'
  );
});

// ---------------------------------------------------------------- X15

test('X15：启动链——cmd 先查 node、失败用捕获后的退出码', () => {
  const cmd = read('启动章回.cmd');
  assert.ok(cmd.includes('chcp 65001'), 'cmd 仍要切 UTF-8 代码页（中文提示）');
  assert.ok(cmd.includes('cd /d "%~dp0"'), 'cmd 仍要先进项目目录');
  assert.match(cmd, /where node\s*>nul\s*2>nul/, 'cmd 要先确认 node 在 PATH（缺失时以前只报 9009）');
  assert.ok(
    cmd.indexOf('where node') < cmd.indexOf('node scripts\\start.js'),
    'node 检查必须排在真正启动之前'
  );
  assert.ok(cmd.includes('Node.js'), '缺 node 要给中文提示（装什么、去哪装）');
  assert.match(cmd, /if not "%code%"=="0"/, '退出码要先 set 再判（负退出码也能认，且 %errorlevel% 不会在块里被提前展开）');
  assert.ok(cmd.includes('exit /b %code%'), '失败要把退出码透传给调用方');
});

test('X15：start.js 捕获缺依赖、信号杀死按失败退出（接线闸门）', () => {
  const start = read('scripts/start.js');
  assert.ok(start.includes("require('./start-logic')"), 'start.js 的判定逻辑走 scripts/start-logic.js（可单测）');
  assert.match(
    start,
    /try\s*\{\s*\r?\n\s*electronPath = require\('electron'\);\s*\r?\n\}\s*catch/,
    "require('electron') 必须在 try/catch 里（未装依赖不许甩裸栈）"
  );
  assert.match(start, /missingElectronHint/, '缺依赖要给 pnpm install 提示');
  assert.match(start, /child\.on\('close', \(code, signal\)/, 'close 回调要拿到 signal');
  assert.match(start, /code === null/, '被信号杀死（code === null）必须单独处理');
  assert.match(start, /startLogic\.exitCodeFor\(code\)/, '退出码统一走 exitCodeFor');
  assert.doesNotMatch(start, /process\.exit\(code == null \? 0 : code\)/, '「信号杀死按 0 退出」的旧口径不许回来');
});

test('X15：start-logic 的退出码 / 缺依赖提示语义', () => {
  assert.equal(startLogic.exitCodeFor(0), 0, '正常退出原样透传 0');
  assert.equal(startLogic.exitCodeFor(7), 7, '非 0 退出码原样透传');
  assert.equal(startLogic.exitCodeFor(null), 1, '被信号杀死（code === null）按失败');
  assert.equal(startLogic.exitCodeFor(undefined), 1, '拿不到退出码按失败');
  assert.equal(startLogic.exitCodeFor(NaN), 1, '坏退出码按失败');
  assert.equal(startLogic.exitCodeFor('0'), 1, '字符串退出码不认（防脚本误传）');
  assert.match(
    startLogic.missingElectronHint({ code: 'MODULE_NOT_FOUND' }),
    /pnpm install/,
    '缺依赖提示要给出 pnpm install'
  );
  assert.equal(startLogic.missingElectronHint({ code: 'EACCES' }), null, '其它错误不套用缺依赖提示');
  assert.equal(startLogic.missingElectronHint(null), null, 'err 为 null 不抛');
  assert.equal(startLogic.missingElectronHint(undefined), null, 'err 为 undefined 不抛');
});

test('R19 F2（TB-02/TB-06）：mkdtemp 只许在 tests/tmp-cleanup.js 出现，测试统一用 mkTmp/mkTmpSync', () => {
  const testsRoot = path.join(__dirname);
  // TEST-D-03：递归扫 tests/**（不只 tests/*.test.js）——fixtures/ 等共享文件也在范围内；
  // 排除 tmp-cleanup.js 自身（它按定义是唯一允许直接 mkdtemp 的地方）。
  const walk = (dir) => {
    const out = [];
    for (const entry of require('node:fs').readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.name.endsWith('.js') && entry.name !== 'tmp-cleanup.js') out.push(full);
    }
    return out;
  };
  const files = walk(testsRoot).sort();
  // TEST-D-03：不复用「当前仓库规模」当阈值（测试文件增减即误红）；只要求真的扫到了东西。
  assert.ok(files.length > 0, `闸门要扫到测试目录下的 .js（实际 ${files.length} 个）：${testsRoot}`);
  // TB-06：fixtures/ 必须在扫描范围内（共享构造器里的临时目录同样要经共享 helper）。
  assert.ok(
    files.some((full) => full.includes(`${path.sep}fixtures${path.sep}`)),
    '扫描范围必须包含 tests/fixtures/**'
  );

  const stripLineComment = (line) => {
    const at = line.indexOf('//');
    return at === -1 ? line : line.slice(0, at);
  };
  // TB-02 之后口径收紧：测试里的 mkdtemp 全部经 tests/tmp-cleanup.js 的 mkTmp / mkTmpSync，
  // 任何测试文件再直接调 mkdtemp 都算回潮（以前是「必须紧跟 track」的两步写法）。
  const offenders = [];
  for (const full of files) {
    const name = path.relative(testsRoot, full);
    // 闸门自身要写 mkdtemp 正则字面量：跳过本文件（其余文件一律不许出现直接调用）。
    if (name === 'wp38-hygiene.test.js') continue;
    const lines = require('node:fs').readFileSync(full, 'utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (/\bmkdtemp(Sync)?\s*\(/.test(stripLineComment(lines[index]))) offenders.push(`${name}:${index + 1}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '这些位置直接调了 mkdtemp（临时目录只许经 tests/tmp-cleanup.js 的 mkTmp / mkTmpSync）：\n' + offenders.join('\n')
  );
  // 共享 helper 本体：唯一实现 + 两种形态（异步 / 同步）+ 都登记回收。
  const shared = require('node:fs').readFileSync(path.join(testsRoot, 'tmp-cleanup.js'), 'utf8');
  assert.equal((shared.match(/\.mkdtemp(Sync)?\s*\(/g) || []).length, 2, 'tmp-cleanup.js 里应只有 mkTmp / mkTmpSync 两处 mkdtemp');
  assert.match(shared, /async function mkTmp\(/, 'tmp-cleanup.js 要导出共享的 mkTmp');
  assert.match(shared, /function mkTmpSync\(/, 'tmp-cleanup.js 要导出共享的 mkTmpSync');
  assert.match(shared, /module\.exports = \{ track, mkTmp, mkTmpSync \}/, '两个 helper 都要导出');
  // 用武之地：仓库里确实有大量文件走共享 helper（不是把调用点全删光的假绿）。
  let using = 0;
  for (const full of files) {
    const source = require('node:fs').readFileSync(full, 'utf8');
    if (/tmpCleanup\.(mkTmp|mkTmpSync)\(/.test(source)) using += 1;
  }
  assert.ok(using >= 40, `用共享 helper 的测试文件太少（${using}），可能没迁移完`);
});