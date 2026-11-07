// A6（审计 E8）：启动期与事件回调不许把 rejection 漏成 unhandledrejection。
//
// renderer.js 是浏览器侧 IIFE，node:test 里跑不起来，所以沿用仓库里「读源码做静态闸门」的先例
// （见 tests/ipc-limits.test.js / tests/config-gate.test.js）。这里只钉住审计点名的三个出口：
//   1. DOMContentLoaded 不能直接挂 async 的 init（失败会变成无主 rejection，界面停在一半初始化）；
//   2. 启动时异步加载自定义字体必须 .catch（失败退回内置字体）；
//   3. 拖动章节栏分隔条的 pointerup / dblclick 回调必须自己兜住 persistSidebarWidth 的失败。
// 这些位置以后重构可以改形，但「失败不许漏成 unhandledrejection」这条不许丢，改的时候同步改这里。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');

test('静态闸门：启动期与分隔条事件回调都不漏 unhandledrejection（E8）', () => {
  // 1) DOMContentLoaded：不再直接挂 init，而是包一层并 .catch
  assert.equal(
    SOURCE.includes("document.addEventListener('DOMContentLoaded', init);"),
    false,
    'DOMContentLoaded 不能直接挂 async 的 init（E8：rejection 会漏成 unhandledrejection）'
  );
  assert.match(
    SOURCE,
    /document\.addEventListener\('DOMContentLoaded', \(\) => \{[\s\S]{0,400}?init\(\)\.catch\(/,
    'DOMContentLoaded 里的 init() 必须显式 .catch'
  );
  assert.ok(
    /init\(\)\.catch\(\(err\) => \{[\s\S]{0,200}?console\.error\('启动失败'/.test(SOURCE),
    'init 失败至少留一条 console.error（不能静默吞掉）'
  );

  // 2) 启动时加载上次的自定义字体：加载失败退回内置字体，不能漏 rejection
  assert.match(
    SOURCE,
    /loadCustomFont\(state\.config\.editorCustomFontPath, \{ silent: true \}\)[\s\S]{0,220}?\.then\([\s\S]{0,120}?\.catch\(/,
    'loadCustomFont(...).then(...) 必须补 .catch'
  );

  // 3) 分隔条拖动结束 / 双击复位：不再是裸 async 监听器，promise 自己兜住
  assert.equal(
    /window\.addEventListener\('pointerup', async \(\) => \{/.test(SOURCE),
    false,
    'pointerup 监听器不能是裸 async（persistSidebarWidth 失败会漏成 unhandledrejection）'
  );
  assert.match(SOURCE, /persistSidebarWidth\(state\.sidebarWidth\)\.catch\(/, 'pointerup 里要兜住 persistSidebarWidth');
  assert.equal(
    /resizer\.addEventListener\('dblclick', async \(\) => \{/.test(SOURCE),
    false,
    'dblclick 监听器不能是裸 async'
  );
  assert.match(SOURCE, /persistSidebarWidth\(250\)\.catch\(/, '双击复位里要兜住 persistSidebarWidth');
});
