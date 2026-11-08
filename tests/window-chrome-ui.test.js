// 自绘标题栏的渲染层部分（1.3.0 T6 / 规范 I-07）：只负责给 body 挂 / 摘 window-inactive。
//
// 这份测试钉的是「纯显示层」这条边界：不写配置、不碰 IPC、不建定时器、不加 DOM；
// 窗口 blur / focus 时 class 跟着走，启动时（窗口在后台）先对齐一次，install 幂等。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { createWindowChromeUi, CLASS_NAME } = require('../renderer/window-chrome-ui');

// 最小假 window / document：只要 addEventListener / classList / hasFocus
function makeHost({ focused = true } = {}) {
  const listeners = new Map();
  const classes = new Set();
  const win = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    fire(type) {
      for (const fn of listeners.get(type) || []) fn({ type });
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    }
  };
  const doc = {
    body: {
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
        toggle(name, force) {
          const on = force === undefined ? !classes.has(name) : Boolean(force);
          if (on) classes.add(name);
          else classes.delete(name);
          return on;
        }
      }
    },
    focused,
    hasFocus() {
      return doc.focused;
    }
  };
  return { win, doc, classes };
}

test('窗口失焦 → body 挂 window-inactive；回焦 → 摘掉', () => {
  const host = makeHost({ focused: true });
  const ui = createWindowChromeUi(host).install();
  assert.equal(ui.isInactive(), false, '启动时窗口在前台，不该先降级');
  host.doc.focused = false;
  host.win.fire('blur');
  assert.equal(ui.isInactive(), true);
  assert.equal(host.classes.has(CLASS_NAME), true);
  host.doc.focused = true;
  host.win.fire('focus');
  assert.equal(ui.isInactive(), false);
  assert.equal(host.classes.has(CLASS_NAME), false);
});

test('窗口在后台启动（自动化 / 从别处打开）：install 时先对齐一次，不等第一次 blur', () => {
  const host = makeHost({ focused: false });
  const ui = createWindowChromeUi(host).install();
  assert.equal(ui.isInactive(), true);
  host.doc.focused = true;
  ui.syncNow();
  assert.equal(ui.isInactive(), false);
});

test('install 幂等：重复调用不会重复挂监听', () => {
  const host = makeHost();
  const ui = createWindowChromeUi(host);
  ui.install();
  ui.install();
  ui.install();
  assert.equal(host.win.listenerCount('blur'), 1);
  assert.equal(host.win.listenerCount('focus'), 1);
});

test('setInactive 可以手动摆状态（取证 / 截图用），只动这一个 class', () => {
  const host = makeHost();
  const ui = createWindowChromeUi(host).install();
  host.doc.body.classList.add('theme-night');
  ui.setInactive(true);
  assert.equal(host.classes.has(CLASS_NAME), true);
  assert.equal(host.classes.has('theme-night'), true, '不能碰主题类');
  ui.setInactive(false);
  assert.deepEqual([...host.classes], ['theme-night']);
});

test('host 不合法时启动就炸（宁可启动报错，也不要运行时静默失效）', () => {
  assert.throws(() => createWindowChromeUi({ doc: { body: { classList: {} } } }), TypeError);
  assert.throws(() => createWindowChromeUi({ win: { addEventListener() {} } }), TypeError);
  assert.throws(() => createWindowChromeUi({ win: { addEventListener() {} }, doc: { body: {} } }), TypeError);
});

test('纯显示层：不写配置 / 不碰 IPC / 不建定时器 / 不加 DOM', () => {
  const source = fs.readFileSync(path.join(ROOT, 'renderer', 'window-chrome-ui.js'), 'utf8');
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  assert.equal(/setConfig|getConfig|window\.api|invoke\(/.test(code), false, '不许碰 IPC / 配置');
  assert.equal(/setTimeout|setInterval/.test(code), false, '不许建定时器');
  assert.equal(/createElement|appendChild|innerHTML/.test(code), false, '不许加 DOM');
  assert.match(code, /classList\.toggle\(CLASS_NAME/, '只允许动这一个 class');
});
