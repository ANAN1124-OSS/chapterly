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
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const wiring = require('../scripts/wiring-check.js');
const tmpCleanup = require('./tmp-cleanup');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'wiring-check.js');

// 临时树：只复制接线检查要读的四个来源（renderer/、ipc/、main.js、preload.js），
// 不动真实仓库；变异都在副本上做，跑完由 tmp-cleanup 统一回收。
function makeFixture() {
  const dir = tmpCleanup.track(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-wiring-')));
  fs.cpSync(path.join(ROOT, 'renderer'), path.join(dir, 'renderer'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'core'), path.join(dir, 'core'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'ipc'), path.join(dir, 'ipc'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'main.js'), path.join(dir, 'main.js'));
  fs.copyFileSync(path.join(ROOT, 'preload.js'), path.join(dir, 'preload.js'));
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
  // 已知死监听只允许这一条（历史遗留，WP16 不顺手改产品代码）；新死监听 / 白名单过期都要红。
  assert.deepEqual(facts.deadListeners, ['app:force-close'], '死监听白名单与仓库现状不一致');
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