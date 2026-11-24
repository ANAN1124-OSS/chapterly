'use strict';
// WP16（R-N4，审计中 #19）：接线清单的单一闸门（行为化 + 变异负控）。
//
// 背景：审计 R-N4 指出 `tests/` 里 257+ 处 readFileSync 静态闸门「关键字还在就算过、等价重构却假红」。
// 本轮把**接线类**事实收成一份机器清单 `scripts/wiring-check.js`，由本文件统一验证：
//   1. 真实树零违规：renderer 装配顺序 / 模块全局名 / renderer 模块引用 / preload api ↔ renderer 使用 /
//      invoke 频道 ↔ 主进程 handler / ipcRenderer.send ↔ ipcMain.on / 主进程通知 ↔ preload 监听；
//   2. 临时树变异负控：删 script / 删 api 键 / 删 handler / 删监听 → 必须命中对应契约 id；
//   3. 等价重构不假红：CRLF、注释、script 标签单引号 / 多余空白 → 仍然零违规；
//   4. CLI 行为：真实树 exit 0、变异树 exit 1、根目录不存在 exit 2。
//
// 这里的断言只看「接线是否对得上」，不涉及业务行为；业务行为由各域自己的用例钉住。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const wiring = require('../scripts/wiring-check.js');
const visualAssertions = require('../scripts/e2e/visual-assertions.js');
const tmpCleanup = require('./tmp-cleanup');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'wiring-check.js');

// 临时树：只复制接线检查要读的四个来源（renderer/、ipc/、main.js、preload.js），
// 不动真实仓库；变异都在副本上做，跑完由 tmp-cleanup 统一回收。
function makeFixture() {
  const dir = tmpCleanup.mkTmpSync('cw-wiring-');
  fs.cpSync(path.join(ROOT, 'renderer'), path.join(dir, 'renderer'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'core'), path.join(dir, 'core'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'ipc'), path.join(dir, 'ipc'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'main.js'), path.join(dir, 'main.js'));
  fs.copyFileSync(path.join(ROOT, 'preload.js'), path.join(dir, 'preload.js'));
  // T-26：视觉断言清单契约要读 `scripts/e2e/groups/*.js`（逐文件解析 checkVisual 调用点）。
  // 夹具复制真实组文件（只当源码文本用，不 require / 不执行），变异都在副本上做。
  fs.cpSync(path.join(ROOT, 'scripts', 'e2e', 'groups'), path.join(dir, 'scripts', 'e2e', 'groups'), {
    recursive: true
  });
  // 临时目录在 D:\Temp 下，而 D:\Temp\package.json 是 `"type": "module"`（宿主工具链的包清单）。
  // 复制仓库自己的 package.json，让夹具里的 .js 仍按 CommonJS 解析（仓库 package.json 没有 type 字段），
  // 否则 assembly-manifest.js 的 UMD 分支会走 window 分支、require 回来是空对象。
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(dir, 'package.json'));
  return dir;
}

function readIn(dir, rel) {
  return fs.readFileSync(path.join(dir, rel), 'utf8');
}

function writeIn(dir, rel, text) {
  fs.writeFileSync(path.join(dir, rel), text, 'utf8');
}

function mutate(dir, rel, fn) {
  writeIn(dir, rel, fn(readIn(dir, rel)));
}

function removeLine(text, needle) {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((line) => line.includes(needle));
  assert.notEqual(at, -1, `夹具里找不到要删的行：${needle}`);
  lines.splice(at, 1);
  return lines.join('\n');
}

function violation(result, id) {
  return result.violations.find((item) => item.id === id);
}

function ids(result) {
  return result.violations.map((item) => item.id);
}

test('R3 真实树：接线清单零违规，事实计数覆盖 invoke / api / 通知三类（不是空跑）', () => {
  const result = wiring.auditWiring(ROOT);
  assert.deepEqual(result.violations, [], '真实树不该有接线违规：' + JSON.stringify(result.violations));
  const facts = result.facts;
  assert.ok(facts.rendererScripts > 60, `index.html 的 <script> 数应 > 60（实际 ${facts.rendererScripts}）`);
  assert.ok(facts.rendererModules > 60, `装配清单模块数应 > 60（实际 ${facts.rendererModules}）`);
  assert.ok(facts.exposedApi > 100, `preload api 键应 > 100（实际 ${facts.exposedApi}）`);
  assert.ok(facts.invokeChannels > 100, `invoke 频道应 > 100（实际 ${facts.invokeChannels}）`);
  assert.ok(
    facts.registeredHandlers >= facts.invokeChannels,
    `注册的 handler（${facts.registeredHandlers}）必须盖住 invoke 频道（${facts.invokeChannels}）`
  );
  assert.ok(facts.sendChannels >= 2, `ipcRenderer.send 频道应 ≥ 2（实际 ${facts.sendChannels}）`);
  assert.ok(facts.notifySent > 0 && facts.notifyListened > 0, '通知链路必须有发送与监听两侧');
  // WP18（台账 #3）：app:force-close 的发送改成字面量后已是活监听，死监听白名单清空；
  // 新死监听 / 白名单条目过期都要红（见 R4c ③ 与 wiring-check 的 staleAllowlist 分支）。
  assert.deepEqual(facts.deadListeners, [], '真实树不该再有死监听（app:force-close 已有发送方）');
  // 暴露未用的 bridge api 只登记 E2E 自检专用那三条（台账 #3 / WP18），真实树不再有「清理项」提示。
  assert.deepEqual(result.warnings, [], '真实树接线提示要清空：' + JSON.stringify(result.warnings));
  // T-26：视觉断言静态清单必须真有内容（CI 的跳过面就靠它），且与组文件逐项对得上。
  assert.ok(
    facts.visualAssertions > 30,
    `视觉断言静态清单条数应 > 30（实际 ${facts.visualAssertions}，空清单等于 CI 跳过面无约束）`
  );
});

test('R4a 变异负控：删一个 renderer 模块的 <script> → renderer-assembly-order', () => {
  const dir = makeFixture();
  mutate(dir, 'renderer/index.html', (text) =>
    text.replace(/\s*<script src="statusbar-ui\.js"><\/script>\r?\n/, '\n')
  );
  const result = wiring.auditWiring(dir);
  const hit = violation(result, 'renderer-assembly-order');
  assert.ok(hit, '删模块 script 必须命中 renderer-assembly-order，实际：' + ids(result).join(','));
  assert.match(hit.detail, /statusbar-ui\.js/, '违规详情要点名缺的模块文件');
});

test('R4b 变异负控：少暴露 renderer 正在用的 bridge API / 少注册 invoke 频道 → 各自命中', () => {
  // ① preload 少一个 api 键（renderer.js 仍在用 api.appVersion）
  const preloadDir = makeFixture();
  mutate(preloadDir, 'preload.js', (text) => removeLine(text, "appVersion: () => invoke('app:version'),"));
  const apiResult = wiring.auditWiring(preloadDir);
  const apiHit = violation(apiResult, 'preload-api-exposed');
  assert.ok(apiHit, '少暴露 api 键必须命中 preload-api-exposed，实际：' + ids(apiResult).join(','));
  assert.match(apiHit.detail, /appVersion/);

  // ② 主进程少一个 handler（app:version 仍被 preload invoke）
  const handlerDir = makeFixture();
  mutate(handlerDir, 'main.js', (text) => removeLine(text, "handle('app:version'"));
  const handlerResult = wiring.auditWiring(handlerDir);
  const handlerHit = violation(handlerResult, 'ipc-invoke-registered');
  assert.ok(handlerHit, '少注册 handler 必须命中 ipc-invoke-registered，实际：' + ids(handlerResult).join(','));
  assert.match(handlerHit.detail, /app:version/);
});

test('R4c 变异负控：删 preload 通知监听 / 删主进程发送方 → ipc-notify-listened', () => {
  // ① 有发送、没监听：主进程 broadcast('shelf:changed') 仍在
  const listenDir = makeFixture();
  mutate(listenDir, 'preload.js', (text) => removeLine(text, "onShelfChanged: (cb) => on('shelf:changed', cb),"));
  const listenResult = wiring.auditWiring(listenDir);
  const listenHit = violation(listenResult, 'ipc-notify-listened');
  assert.ok(listenHit, '少了监听必须命中 ipc-notify-listened，实际：' + ids(listenResult).join(','));
  assert.match(listenHit.detail, /shelf:changed/);

  // ② 有监听、没发送：删掉主进程的 broadcast('shelf:changed' …)，监听变「死监听」
  const sendDir = makeFixture();
  mutate(sendDir, 'main.js', (text) => removeLine(text, "broadcast('shelf:changed'"));
  const sendResult = wiring.auditWiring(sendDir);
  const sendHit = violation(sendResult, 'ipc-notify-listened');
  assert.ok(sendHit, '删发送方必须命中 ipc-notify-listened，实际：' + ids(sendResult).join(','));
  assert.match(sendHit.detail, /shelf:changed/);

  // ③ WP18（台账 #3）：白名单清空后，删掉 app:force-close 的**字面量**发送行 → 必须重新判死监听。
  // 这条负控保证「清空白名单」不是把一条真回归也一起放过（close-guard 的常量发送已改字面量）。
  const forceDir = makeFixture();
  mutate(forceDir, 'main.js', (text) => removeLine(text, "webContents.send('app:force-close')"));
  const forceResult = wiring.auditWiring(forceDir);
  const forceHit = violation(forceResult, 'ipc-notify-listened');
  assert.ok(forceHit, '删掉 force-close 的发送行必须命中 ipc-notify-listened，实际：' + ids(forceResult).join(','));
  assert.match(forceHit.detail, /app:force-close/);
});

test('R4e 变异负控：新暴露但没人用的 api 仍要提示（E2E_ONLY_APIS 只登记三条，不当万能豁免）', () => {
  const dir = makeFixture();
  mutate(dir, 'preload.js', (text) =>
    text.replace('const api = {', "const api = {\n  __fakeUnusedForTest: () => invoke('app:version'),")
  );
  const result = wiring.auditWiring(dir);
  assert.deepEqual(result.violations, [], '只多一个未用 key 不该判违规：' + JSON.stringify(result.violations));
  assert.equal(result.warnings.length, 1, '应有一条「暴露未用」提示：' + JSON.stringify(result.warnings));
  assert.match(result.warnings[0], /__fakeUnusedForTest/, '新未用 api 必须被点名，不许被 E2E 名单吞掉');
});

// WP17（M-N1）：index.html 的脚本块改为 assembly-manifest 生成的 ASSEMBLY 标记块后，
// 「块是生成的」也是接线事实：标记被删 / 块内被手改都要命中 renderer-assembly-generated。
test('R4f 变异负控：删装配标记 / 块内手改 script → renderer-assembly-generated', () => {
  const markerDir = makeFixture();
  mutate(markerDir, 'renderer/index.html', (text) => text.replace('<!-- ASSEMBLY:BEGIN -->', '<!-- 标记被删 -->'));
  const markerResult = wiring.auditWiring(markerDir);
  const markerHit = violation(markerResult, 'renderer-assembly-generated');
  assert.ok(markerHit, '删装配标记必须命中 renderer-assembly-generated，实际：' + ids(markerResult).join(','));
  assert.match(markerHit.detail, /标记/);

  const blockDir = makeFixture();
  mutate(blockDir, 'renderer/index.html', (text) =>
    text.replace(/\s*<script src="undo-ui\.js"><\/script>\r?\n/, '\n')
  );
  const blockResult = wiring.auditWiring(blockDir);
  const blockHit = violation(blockResult, 'renderer-assembly-generated');
  assert.ok(blockHit, '块内删脚本必须命中 renderer-assembly-generated，实际：' + ids(blockResult).join(','));
  assert.match(blockHit.detail, /undo-ui\.js/, '违规详情要点名块内缺的脚本');
});

// RPAN-C07：依赖先于消费者。模块之间靠 window.CW 全局名引用，装载期是空安全解引用 ——
// 把被依赖模块在清单里挪到消费者之后，原来的四重防护全绿，只有 Electron 里 create 时才炸。
// 这条变异负控钉住新契约：挪位之后必须点名「谁依赖谁、在第几项」。
test('R4g 变异负控：把 core/assert-host.js 挪到消费者之后 → renderer-dependency-order', () => {
  const dir = makeFixture();
  mutate(dir, 'renderer/assembly-manifest.js', (text) => {
    const lines = text.split(/\r?\n/);
    const at = lines.findIndex((line) => line.includes("'../core/assert-host.js'"));
    assert.notEqual(at, -1, '夹具里找不到 assert-host 的清单行');
    const [entry] = lines.splice(at, 1);
    // 挪到 shelf-view-ui（stdout 消费者之一）之后
    const after = lines.findIndex((line) => line.includes("'shelf-view-ui.js'"));
    assert.notEqual(after, -1, '夹具里找不到 shelf-view-ui 的清单行');
    lines.splice(after + 1, 0, entry);
    return lines.join('\n');
  });
  const result = wiring.auditWiring(dir);
  const hits = result.violations.filter((item) => item.id === 'renderer-dependency-order');
  assert.ok(hits.length > 0, '依赖在消费者之后必须命中 renderer-dependency-order，实际：' + ids(result).join(','));
  // 报错要点名「谁依赖谁、两边各在第几项」——不再是一句不指名的运行时 TypeError
  assert.match(hits[0].detail, /renderer\/[a-z0-9-]+\.js 依赖 CWAssertHost/);
  assert.match(hits[0].detail, /排第 \d+ 项/);
  assert.match(hits[0].detail, /必须先加载/);
});

// T-24：反向契约——新建 renderer 模块忘进装配清单时，index.html 不会加载它，装配检查 / 依赖顺序
// 全绿，只在 Electron 里表现为「点了没反应」。这里在夹具里放一个孤儿模块，必须点名。
test('R4h 变异负控：renderer/ 下有孤儿模块（未进装配清单）→ renderer-module-orphans', () => {
  const dir = makeFixture();
  fs.writeFileSync(path.join(dir, 'renderer', 'orphan-ui.js'), "'use strict';\n", 'utf8');
  const result = wiring.auditWiring(dir);
  const hit = violation(result, 'renderer-module-orphans');
  assert.ok(hit, '孤儿 renderer 模块必须命中 renderer-module-orphans，实际：' + ids(result).join(','));
  assert.match(hit.detail, /orphan-ui\.js/, '违规详情要点名孤儿文件');
  assert.match(hit.detail, /assembly-manifest/, '违规详情要给出修法（进装配清单）');

  // 清单外两个约定文件（renderer.js 入口 / test-hooks.js）不算孤儿：删掉它们才该由别的契约报
  // （这里只验证孤儿判定不会把它们误报成 orphans）。
  const allowed = wiring.auditWiring(dir).violations.filter((item) => item.id === 'renderer-module-orphans');
  assert.equal(allowed.length, 1, '同一个夹具只报一条孤儿违规');
});

// T-26：checkVisual 的跳过面必须有文件 + 断言名级静态清单；组文件里新增 / 删除 / 注释里的调用
// 都要按代码事实判定（注释不算接线、未登记要红、清单过期要红）。
test('R4i 视觉断言静态清单：未登记 / 清单过期要红，注释里的 checkVisual 不算，真实树逐项一致', () => {
  const realSources = fs
    .readdirSync(path.join(ROOT, 'scripts', 'e2e', 'groups'))
    .filter((file) => file.endsWith('.js'))
    .sort()
    .map((file) => ({ file, text: fs.readFileSync(path.join(ROOT, 'scripts', 'e2e', 'groups', file), 'utf8') }));
  assert.deepEqual(
    visualAssertions.compareVisualAssertions(realSources),
    [],
    '真实树每个 checkVisual 调用点都必须登记在 scripts/e2e/visual-assertions.js'
  );
  assert.ok(visualAssertions.MANIFEST.length > 30, '清单不能是空壳');

  // ① 未登记：组文件里多一处 checkVisual 调用（静态解析即可，不执行）
  const unlisted = makeFixture();
  mutate(unlisted, 'scripts/e2e/groups/03-save-book.js', (text) => `${text}\ncheckVisual('未登记的视觉断言', true);\n`);
  const unlistedResult = wiring.auditWiring(unlisted);
  const unlistedHit = violation(unlistedResult, 'e2e-visual-assertions');
  assert.ok(unlistedHit, '未登记的 checkVisual 必须命中 e2e-visual-assertions，实际：' + ids(unlistedResult).join(','));
  assert.match(unlistedHit.detail, /未登记的视觉断言/, '违规详情要点名未登记的断言');

  // ② 清单过期：删掉组文件里一处已登记的 checkVisual 调用 → 清单条目找不到落点
  const stale = makeFixture();
  mutate(stale, 'scripts/e2e/groups/26-display-options.js', (text) =>
    text.replace(/\s*checkVisual\(\s*'左右边距可调（24px）'[\s\S]*?\);/, '\n')
  );
  const staleResult = wiring.auditWiring(stale);
  const staleHit = violation(staleResult, 'e2e-visual-assertions');
  assert.ok(staleHit, '删掉已登记的视觉断言必须命中 e2e-visual-assertions，实际：' + ids(staleResult).join(','));
  assert.match(staleHit.detail, /左右边距可调/, '违规详情要点名清单里过期的断言');

  // ③ 等价重构不假红：注释里提到 checkVisual(...) 不算调用（清单比对只看真实代码）
  const commented = makeFixture();
  mutate(commented, 'scripts/e2e/groups/26-display-options.js', (text) =>
    `${text}\n// checkVisual('注释里的断言', true)\n`
  );
  const commentedResult = wiring.auditWiring(commented);
  assert.equal(
    commentedResult.violations.filter((item) => item.id === 'e2e-visual-assertions').length,
    0,
    '注释里的 checkVisual 不该被清单判成未登记：' + JSON.stringify(commentedResult.violations)
  );
});

// GATE-01（反向契约）：磁盘上有组文件 ≠ 场景会跑到它 —— 组文件集合必须与 groups/index.js 的
// require 集合双向一致。只加文件不登记 / 索引指向不存在的文件，都必须点名报红；登记后转绿。
test('GATE-01：组文件与 groups/index.js 的 require 集合双向一致（未登记要红并点名）', () => {
  const dir = makeFixture();
  // 初始夹具（真实组文件全登记）零违规
  assert.equal(
    violation(wiring.auditWiring(dir), 'e2e-group-registry'),
    undefined,
    '真实组文件全登记时不该报 e2e-group-registry'
  );

  // ① 放一个没登记的 84 组文件 → 门禁红并点名
  fs.writeFileSync(
    path.join(dir, 'scripts', 'e2e', 'groups', '84-unregistered.js'),
    "'use strict';\nmodule.exports = async () => {};\n",
    'utf8'
  );
  const unregisteredResult = wiring.auditWiring(dir);
  const unregisteredHit = violation(unregisteredResult, 'e2e-group-registry');
  assert.ok(
    unregisteredHit,
    '未登记的组文件必须命中 e2e-group-registry，实际：' + ids(unregisteredResult).join(',')
  );
  assert.match(unregisteredHit.detail, /84-unregistered/, '违规详情要点名未登记的组文件');

  // ② 在 index.js 里登记后转绿（夹具按原样复制 CRLF，这里用 \r?\n 容错）
  mutate(dir, 'scripts/e2e/groups/index.js', (text) => {
    const next = text.replace(
      /(\{ id: 83, run: require\('\.\/83-crash-recovery'\) \})\r?\n\];/,
      "$1,\r\n  { id: 84, run: require('./84-unregistered') }\r\n];"
    );
    assert.notEqual(next, text, '登记变异必须真的写进 index.js');
    return next;
  });
  assert.equal(
    violation(wiring.auditWiring(dir), 'e2e-group-registry'),
    undefined,
    '登记后必须转绿：' + JSON.stringify(violation(wiring.auditWiring(dir), 'e2e-group-registry'))
  );

  // ③ 反向：索引里的 require 指向不存在的文件 → 同样点名（改名后漏改索引的现场）
  const missingDir = makeFixture();
  mutate(missingDir, 'scripts/e2e/groups/index.js', (text) =>
    text.replace("require('./83-crash-recovery')", "require('./83-crash-recovered')")
  );
  const missingResult = wiring.auditWiring(missingDir);
  const missingHit = violation(missingResult, 'e2e-group-registry');
  assert.ok(missingHit, '索引指向不存在的组文件必须命中 e2e-group-registry，实际：' + ids(missingResult).join(','));
  assert.match(missingHit.detail, /83-crash-recovered/, '违规详情要点名索引里的坏登记');
});

test('TOOL-A04：同一进程对同一 root 改清单后再审计，读到的是新清单（不接受 require 缓存）', () => {
  const dir = makeFixture();
  assert.deepEqual(wiring.auditWiring(dir).violations, [], '夹具初始应零违规');
  // 从清单里删掉 undo-ui → index.html 与清单不再一致。若 wiring-check 仍拿 require 缓存里的旧清单，
  // 这次审计会静默通过（变异负控就假绿了）。
  mutate(dir, 'renderer/assembly-manifest.js', (text) =>
    text.replace(/\s*\['undo-ui\.js'[^\n]*\n/, '\n')
  );
  const after = wiring.auditWiring(dir);
  assert.ok(
    violation(after, 'renderer-assembly-order'),
    '第二次审计必须读到改后的清单，实际：' + ids(after).join(',')
  );
});

test('R4d 等价重构不假红：CRLF + 注释 + script 标签单引号 / 多余空白仍零违规', () => {
  const dir = makeFixture();
  const textFiles = [
    'main.js',
    'preload.js',
    'renderer/index.html',
    'renderer/renderer.js',
    'renderer/assembly-manifest.js',
    ...fs.readdirSync(path.join(dir, 'renderer')).filter((f) => f.endsWith('.js')).map((f) => `renderer/${f}`),
    ...fs.readdirSync(path.join(dir, 'ipc')).filter((f) => f.endsWith('.js')).map((f) => `ipc/${f}`)
  ];
  // ① 全部转 CRLF（等价重构里最常见的行尾变化）
  for (const rel of new Set(textFiles)) {
    writeIn(dir, rel, readIn(dir, rel).replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
  }
  // ② 加注释（注释里甚至提到别的频道名，也不该被当成接线）
  writeIn(dir, 'preload.js', `// 等价重构：注释提到 handle('not:a:channel') 也不算接线\r\n${readIn(dir, 'preload.js')}`);
  writeIn(dir, 'renderer/renderer.js', `// 等价重构：注释提到 api.notExposed / window.CWNotInstalled\r\n${readIn(dir, 'renderer/renderer.js')}`);
  // ③ index.html 的 script 标签换单引号 + 多余空白
  mutate(dir, 'renderer/index.html', (text) =>
    text.replace(
      '<script src="statusbar-ui.js"></script>',
      "<script  src='statusbar-ui.js' ></script>"
    )
  );
  const result = wiring.auditWiring(dir);
  assert.deepEqual(result.violations, [], '等价重构不该被接线清单判红：' + JSON.stringify(result.violations));
});

test('R5 CLI 行为：真实树 exit 0 / 变异树 exit 1 并打印违规 id / 根目录不存在 exit 2', () => {
  const clean = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(clean.status, 0, `真实树应 exit 0，实际 ${clean.status}\n${clean.stdout}\n${clean.stderr}`);
  assert.match(clean.stdout, /接线清单通过/);

  const dir = makeFixture();
  mutate(dir, 'renderer/index.html', (text) =>
    text.replace(/\s*<script src="statusbar-ui\.js"><\/script>\r?\n/, '\n')
  );
  const bad = spawnSync(process.execPath, [SCRIPT, '--root', dir], { encoding: 'utf8' });
  assert.equal(bad.status, 1, `变异树应 exit 1，实际 ${bad.status}\n${bad.stdout}\n${bad.stderr}`);
  assert.match(bad.stdout, /renderer-assembly-order/, 'CLI 要打印具体违规 id，便于定位');

  const missing = spawnSync(process.execPath, [SCRIPT, '--root', path.join(dir, '不存在的根')], {
    encoding: 'utf8'
  });
  assert.equal(missing.status, 2, `根目录不存在应 exit 2（配置错误，不是接线违规），实际 ${missing.status}`);
  assert.match(missing.stdout + missing.stderr, /根目录不存在|不存在/);
});