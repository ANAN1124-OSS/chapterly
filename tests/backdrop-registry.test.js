/* 弹层注册表（1.8.0 WP-17 / 审计 C35）的自检。
 *
 * 背景：改之前「有哪些弹层」在渲染层有两份事实——renderer.js 的 ESC_BACKDROPS（15 项 + 单独算的
 * modal / command）与 capture-ui.js 的 panelBlocked()（手写 9 项）。结果是校对 / 敏感词 / 灵感箱 /
 * 插入碎片 / 分组管理 / 命令面板 / 快捷键一览开着时，捕获面板还能叠上来。
 *
 * 这一份测试钉住：
 *   1. 注册表 = index.html 里全部 17 个 `.backdrop`（逐项对账：少登记一层会静默漏挡）；
 *   2. isBlocked 语义（全关放行 / 任一开着都挡 / except 排除自己那层）；
 *   3. 清单只许一份（renderer 的 ESC_BACKDROPS 与 capture-ui 的手写 9 项都不许回潮）；
 *   4. index.html 的加载顺序与浏览器 UMD 分支。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const registry = require('../renderer/backdrop-registry');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SOURCE = read('renderer/backdrop-registry.js');
// 纯逻辑闸门只看代码：注释里提到 DOM 是在解释边界，不算越界
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const INDEX_SOURCE = read('renderer/index.html');
const RENDERER_SOURCE = read('renderer/renderer.js');
const CAPTURE_SOURCE = read('renderer/capture-ui.js');

// 页面上的弹层：<div id="X-backdrop" class="backdrop …">
function indexBackdrops() {
  const names = [];
  const re = /<div id="([a-z-]+-backdrop)" class="backdrop/g;
  let match;
  while ((match = re.exec(INDEX_SOURCE))) names.push(match[1].replace(/-backdrop$/, ''));
  return names;
}

// 假 DOM：openNames 里的层去掉 hidden（其余保持 hidden）；其余元素一律 null。
function makeDom(openNames = []) {
  const openIds = new Set(openNames.map((name) => registry.backdropId(name)));
  const map = new Map();
  for (const name of registry.LIST) {
    const id = registry.backdropId(name);
    const classes = new Set(['backdrop']);
    if (!openIds.has(id)) classes.add('hidden');
    map.set(id, { classList: { contains: (token) => classes.has(token) } });
  }
  return (id) => map.get(id) || null;
}

test('注册表 = index.html 里的全部 backdrop：17 层逐项对账（新增 / 改名 / 少登记都会红）', () => {
  const fromPage = indexBackdrops();
  assert.equal(fromPage.length, 17, 'index.html 的 backdrop 数量变了？先核对这份清单');
  assert.deepEqual([...registry.LIST].sort(), [...fromPage].sort(), '注册表与页面的弹层必须一一对应');
  assert.equal(new Set(registry.LIST).size, registry.LIST.length, '注册表不许重复登记');
  assert.deepEqual([...registry.STATE_LAYERS].sort(), ['command', 'modal'], '两层状态源的名单');
  assert.deepEqual(
    [...registry.CLASS_LAYERS].sort(),
    registry.LIST.filter((name) => registry.STATE_LAYERS.indexOf(name) < 0).sort(),
    'CLASS_LAYERS = LIST - STATE_LAYERS'
  );
  assert.equal(registry.CLASS_LAYERS.length, 15, 'Esc 探针按类名摊的仍是那 15 层（modal / command 另有状态源）');
  assert.ok(registry.CLASS_LAYERS.includes('capture'));
  assert.ok(registry.CLASS_LAYERS.includes('group-manage'));
  // 'find' / 'find-backdrop' 两种写法都归一到一个元素 id
  assert.equal(registry.backdropId('find'), 'find-backdrop');
  assert.equal(registry.backdropId('find-backdrop'), 'find-backdrop');
});

test('isBlocked：全关放行；17 层任一开着都算挡；openNames 按注册表顺序列出', () => {
  const closed = makeDom([]);
  assert.equal(registry.isBlocked(closed), false);
  assert.deepEqual(registry.openNames(closed), []);
  for (const name of registry.LIST) {
    const dom = makeDom([name]);
    assert.equal(registry.isBlocked(dom), true, `${name} 开着时必须有弹层挡着`);
    assert.equal(registry.isOpen(dom, name), true);
    assert.deepEqual(registry.openNames(dom), [name]);
  }
  const two = makeDom(['sensitive', 'command']);
  assert.deepEqual(registry.openNames(two), ['sensitive', 'command'], '顺序同 LIST');
  assert.equal(registry.isBlocked(two), true);
  // 元素缺失 / 没有 classList / 没传 $ 一律按「关着」算（渲染层早期与假 DOM 不会因此抛）
  assert.equal(registry.isBlocked(() => null), false);
  assert.equal(registry.isOpen(() => null, 'find'), false);
  assert.equal(registry.isBlocked(null), false);
  assert.equal(registry.isOpen(() => ({ classList: null }), 'find'), false);
});

test('isBlocked 的 except：排除自己那层（capture / capture-backdrop 都认），别的层开着仍挡', () => {
  const onlySelf = makeDom(['capture']);
  assert.equal(registry.isBlocked(onlySelf), true, '不传 except 时自己也算开着一层');
  assert.equal(registry.isBlocked(onlySelf, { except: 'capture' }), false);
  assert.equal(registry.isBlocked(onlySelf, { except: 'capture-backdrop' }), false);
  assert.equal(registry.isBlocked(makeDom(['capture', 'settings']), { except: 'capture' }), true);
  // 非法 / 空 options 不抛
  assert.equal(registry.isBlocked(makeDom([]), 'what'), false);
  assert.equal(registry.isBlocked(makeDom([]), null), false);
});

test('静态闸门：清单只有一份——renderer 不许再写 ESC_BACKDROPS，capture-ui 不许再手写那 9 项', () => {
  assert.equal(RENDERER_SOURCE.includes('ESC_BACKDROPS'), false, 'renderer.js 的 ESC_BACKDROPS 清单必须删掉');
  assert.match(
    RENDERER_SOURCE,
    /const backdropRegistry = window\.CWBackdropRegistry;/,
    'renderer.js 要引用 window.CWBackdropRegistry'
  );
  assert.match(RENDERER_SOURCE, /backdropRegistry\.isBlocked\(\$\)/, 'anyBackdropOpen 要走注册表的 isBlocked');
  const probeStart = RENDERER_SOURCE.indexOf('function escProbe()');
  assert.ok(probeStart > 0, 'renderer.js 里找不到 escProbe()');
  const probeBody = RENDERER_SOURCE.slice(probeStart, RENDERER_SOURCE.indexOf('\n  }', probeStart));
  assert.match(probeBody, /backdropRegistry\.CLASS_LAYERS/, 'escProbe 要遍历注册表的 CLASS_LAYERS');
  assert.equal(probeBody.includes('-backdrop`'), false, 'escProbe 不许再自己拼 backdrop id');
  // capture-ui：9 项手写清单的 id 一个字面量都不许回来（自己那层 capture-backdrop 不在其中）
  for (const id of [
    'modal-backdrop', 'settings-backdrop', 'export-backdrop', 'find-backdrop', 'format-backdrop',
    'jump-backdrop', 'history-backdrop', 'bookinfo-backdrop', 'conflict-backdrop'
  ]) {
    assert.equal(CAPTURE_SOURCE.includes(`'${id}'`), false, `capture-ui 的手写清单回潮：${id}`);
  }
  assert.match(
    CAPTURE_SOURCE,
    /backdropRegistry\.isBlocked\(\$, \{ except: 'capture' \}\)/,
    'panelBlocked 要走注册表并排除自己那层'
  );
  // 注册表自己是纯逻辑：不碰 document / window 全局（UMD 的 root 挂在文件末尾，不是 DOM 访问）
  assert.equal(/\bdocument\b/.test(CODE), false, '注册表不许碰 document');
  assert.equal(/\bwindow\./.test(CODE), false, '注册表不许碰 window');
});

test('index.html：backdrop-registry.js 只加载一次，排在 capture-ui.js 与 renderer.js 之前', () => {
  const at = INDEX_SOURCE.indexOf('src="backdrop-registry.js"');
  assert.ok(at > 0, 'index.html 必须加载 renderer/backdrop-registry.js');
  assert.equal(INDEX_SOURCE.split('src="backdrop-registry.js"').length - 1, 1, '只该加载一次');
  assert.ok(at > INDEX_SOURCE.indexOf('src="esc-registry.js"'), '与 Esc 链注册表相邻，排在它之后');
  assert.ok(at < INDEX_SOURCE.indexOf('src="capture-ui.js"'), 'capture-ui 加载时要用 window.CWBackdropRegistry');
  assert.ok(at < INDEX_SOURCE.indexOf('src="renderer.js"'), 'renderer.js 加载时要用 window.CWBackdropRegistry');
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWBackdropRegistry，与 Node 侧同一份清单', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(SOURCE, context, { filename: 'renderer/backdrop-registry.js' });
  assert.equal(typeof win.CWBackdropRegistry, 'object');
  // 跨 realm 的数组原型不同：先摊进本 realm 再比（内容必须逐项一致）
  assert.deepEqual([...win.CWBackdropRegistry.LIST], registry.LIST);
  assert.deepEqual([...win.CWBackdropRegistry.CLASS_LAYERS], registry.CLASS_LAYERS);
  assert.equal(typeof win.CWBackdropRegistry.isBlocked, 'function');
  const openFind = (id) => (id === 'find-backdrop' ? { classList: { contains: () => false } } : null);
  assert.equal(win.CWBackdropRegistry.isBlocked(openFind), true);
  assert.equal(win.CWBackdropRegistry.isBlocked(() => ({ classList: { contains: () => true } })), false);
});