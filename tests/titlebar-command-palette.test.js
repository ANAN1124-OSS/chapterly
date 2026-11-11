// 1.6.0 F4b：自绘标题栏右键菜单里的「命令面板」入口。
//
// 一条用户动作横跨三个运行时，单测没法在 Node 里真的弹原生菜单，所以用静态闸门把
// 每一段接线钉住，缺任何一段都当场红：
//   1) core/window-chrome.menuTemplate：确实多了一项「命令面板」，排在窗口动作之前、
//      带 Ctrl+K 键帽提示、动作缺失时不可用（点了没反应的菜单项 = 假入口）；
//   2) main.js：菜单动作只向本窗口发一条 'app:command-palette' 通知，先查窗口 /
//      webContents 还活着；面板开关 / 锁键层判定不许搬进主进程；
//   3) preload.js：暴露 onCommandPalette，且只订阅这一个频道（在 vm 里跑真 preload 看
//      ipcRenderer.on 收到了什么，不是读源码猜）；
//   4) renderer.js：订阅同一频道并走现成的 openCommandPalette()，不另写一套开面板逻辑；
//   5) 频道名在发送侧与订阅侧都只有这一份（写错一个字会让入口静默失效）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const chrome = require('../core/window-chrome');

const MAIN = read('main.js');
const PRELOAD = read('preload.js');
const RENDERER = read('renderer/renderer.js');
const CHANNEL = 'app:command-palette';

/** 在 vm 里跑真 preload：记录 exposeInMainWorld 暴露面与 ipcRenderer.on 订阅的频道 */
function loadPreload() {
  const calls = { subscribed: [] };
  let exposed = null;
  const fakeElectron = {
    contextBridge: {
      exposeInMainWorld(key, api) {
        exposed = { key, api };
      }
    },
    ipcRenderer: {
      async invoke(channel) {
        return { ok: true, channel };
      },
      on(channel) {
        calls.subscribed.push(channel);
      },
      send() {}
    }
  };
  const requireShim = (id) => {
    assert.equal(id, 'electron', `preload 只该 require('electron')，实际 require('${id}')`);
    return fakeElectron;
  };
  new vm.Script(PRELOAD, { filename: 'preload.js' }).runInNewContext({ require: requireShim, console });
  assert.ok(exposed, 'preload.js 没有调用 contextBridge.exposeInMainWorld');
  return { api: exposed.api, calls };
}

test('菜单模板：命令面板排在窗口动作之前，动作缺失时不可用', () => {
  const bare = chrome.menuTemplate({ maximized: false });
  assert.equal(bare[0].label, '命令面板');
  assert.equal(bare[0].accelerator, 'Ctrl+K');
  assert.equal(bare[0].enabled, false, '没传动作时不许画成可点');

  const calls = [];
  const items = chrome.menuTemplate({ maximized: false, commandPalette: () => calls.push('open') });
  assert.equal(items[0].enabled, true);
  items[0].click();
  assert.deepEqual(calls, ['open']);
});

test('main.js：标题栏菜单的命令面板只向本窗口发一条通知（窗口销毁后不碰 webContents）', () => {
  const start = MAIN.indexOf('function titleBarMenuTemplate');
  assert.ok(start > 0, 'main.js 里找不到 titleBarMenuTemplate()');
  const end = MAIN.indexOf('async function getConfig', start);
  assert.ok(end > start, 'titleBarMenuTemplate() 的收尾没找到');
  const body = MAIN.slice(start, end);

  assert.match(body, /commandPalette:\s*\(\)\s*=>\s*\{/, '菜单必须传 commandPalette 动作');
  assert.match(body, /win\.webContents\.send\('app:command-palette'\)/, '动作要发 app:command-palette');
  assert.match(body, /isDestroyed\(\)/, '发通知前先查窗口 / webContents 是否还活着');
  // 面板开关与锁键层判定留在渲染层（和 Ctrl+K 同一套），主进程不许自己判断
  assert.equal(/commandPalette\.open|anyBackdropOpen/.test(body), false);
});

test('preload：onCommandPalette 只订阅 app:command-palette，非函数回调直接忽略', () => {
  const { api, calls } = loadPreload();
  assert.equal(typeof api.onCommandPalette, 'function', 'preload 没暴露 onCommandPalette');
  api.onCommandPalette(() => {});
  assert.deepEqual(calls.subscribed, [CHANNEL]);
  api.onCommandPalette('不是函数');
  api.onCommandPalette(null);
  assert.equal(calls.subscribed.length, 1, '非函数回调不该注册成第二条监听');
});

test('renderer.js：订阅命令面板通知并走同一个 openCommandPalette 入口', () => {
  assert.match(
    RENDERER,
    /api\.onCommandPalette\(\(\) => [\s\S]{0,60}?openCommandPalette\(\)/,
    '渲染层要订阅 onCommandPalette 并调用现成的 openCommandPalette()'
  );
  assert.equal(
    (RENDERER.match(/api\.onCommandPalette\(/g) || []).length,
    1,
    '只接线一处，重复订阅会让一次点击开两次'
  );
});

test('频道名：发送侧与订阅侧只有 app:command-palette 这一份', () => {
  const sent = [...MAIN.matchAll(/webContents\.send\('(app:[^']+)'/g)].map((m) => m[1]);
  assert.ok(sent.includes(CHANNEL), '主进程没有发送 app:command-palette');
  assert.match(PRELOAD, /onCommandPalette:\s*\(cb\)\s*=>\s*on\('app:command-palette', cb\)/);
  // 拼错的频道名（大小写 / 连字符）不许作为死代码留在 preload 里
  assert.equal((PRELOAD.match(/app:command[-_]?palette/gi) || []).length, 1);
});