// REDT-C-06：焦点可达性判定与聚焦助手的唯一实现（renderer/focus-nav.js）。
//
// 以前 menu-keyboard / dialog-focus / list-keyboard 各写一份：菜单查 .hidden 类但不查 inert /
// display，弹层查 inert / display 但不查 .hidden，聚焦助手一处滚入视图一处不滚 —— 细节已经漂移。
// 这里钉住合并后的口径（单测不搭 DOM，直接构造「事实」对象 / 假元素）。
const test = require('node:test');
const assert = require('node:assert/strict');

const focusNav = require('../renderer/focus-nav');

test('isUsableFacts：禁用 / aria-hidden / 负 tabindex / .hidden / inert / 0 尺寸 / 样式隐藏 一律不可达', () => {
  const usable = {
    disabled: false,
    ariaHidden: false,
    tabIndex: 0,
    hiddenClass: false,
    hasRects: true,
    inert: false,
    displayNone: false,
    visibilityHidden: false
  };
  assert.equal(focusNav.isUsableFacts(usable), true, '全部干净的条目可达');
  const blockers = [
    ['disabled', true],
    ['ariaHidden', true],
    ['tabIndex', -1],
    ['hiddenClass', true],
    ['hasRects', false],
    ['inert', true],
    ['displayNone', true],
    ['visibilityHidden', true]
  ];
  for (const [key, value] of blockers) {
    assert.equal(focusNav.isUsableFacts({ ...usable, [key]: value }), false, `${key} 必须排除`);
  }
  // 缺字段（旧调用方只给了一部分事实）：按「没有这项限制」处理，不误杀
  assert.equal(focusNav.isUsableFacts({}), true);
  assert.equal(focusNav.isUsableFacts(null), false, '没有事实 = 不可达（宁可不送焦点）');
});

test('factsOf：从元素 + window 采出同一套事实（Closest .hidden / [inert] / display / visibility）', () => {
  const view = {
    getComputedStyle: (el) => el._style || { display: 'block', visibility: 'visible' }
  };
  const el = {
    disabled: false,
    tabIndex: 0,
    _style: { display: 'none', visibility: 'visible' },
    getAttribute: () => null,
    classList: { contains: (name) => name === 'hidden' },
    getClientRects: () => [{ width: 10, height: 10 }],
    closest: (selector) => (selector === '[inert]' ? {} : null)
  };
  const facts = focusNav.factsOf(el, view);
  assert.equal(facts.hiddenClass, true);
  assert.equal(facts.inert, true);
  assert.equal(facts.displayNone, true);
  assert.equal(focusNav.isUsable(el, view), false, '任一项为真就不可达');
  // 干净元素：可达
  const clean = {
    disabled: false,
    tabIndex: 0,
    getAttribute: () => null,
    classList: { contains: () => false },
    getClientRects: () => [{ width: 1, height: 1 }],
    closest: () => null
  };
  assert.equal(focusNav.isUsable(clean, view), true);
  assert.equal(focusNav.isUsable(null, view), false);
  assert.equal(focusNav.isUsable({}, view), true, '没有 DOM 能力探测的假对象按「无限制」处理');
});

test('focusElement：preventScroll 优先、失败退回无参 focus；滚入视图按能力探测且不抛', () => {
  const calls = [];
  const el = {
    focus(options) {
      calls.push(options);
      if (options && options.preventScroll) return; // 正常路径：接受 preventScroll
    },
    scrollIntoView(options) {
      calls.push({ scroll: options });
    }
  };
  assert.equal(focusNav.focusElement(el, { scroll: true }), true);
  assert.deepEqual(calls[0], { preventScroll: true }, '先 preventScroll（别让页面乱跳）');
  assert.deepEqual(calls[1], { scroll: { block: 'nearest' } }, '再按 nearest 滚进视野');

  // 老浏览器 / 假 DOM 不认 preventScroll：退回无参 focus，仍然成功
  const legacy = {
    focus(options) {
      if (options) throw new TypeError('不支持 options');
      calls.push('legacy-focus');
    }
  };
  assert.equal(focusNav.focusElement(legacy), true);
  assert.equal(calls.includes('legacy-focus'), true);

  // scrollIntoView 抛错不影响聚焦本身
  const noScroll = { focus() {}, scrollIntoView() { throw new Error('滚不动'); } };
  assert.equal(focusNav.focusElement(noScroll, { scroll: true }), true);
  assert.equal(focusNav.focusElement(noScroll, { scroll: false }), true);
  // 没有 focus / 没有元素：false，不抛
  assert.equal(focusNav.focusElement(null), false);
  assert.equal(focusNav.focusElement({}), false);
  const throwing = { focus() { throw new Error('不可聚焦'); } };
  assert.equal(focusNav.focusElement(throwing), false);
});

test('接线：三个焦点模块都从 focus-nav 取同一份实现，index.html 排在消费者之前', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ROOT = path.join(__dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const rel of ['renderer/menu-keyboard.js', 'renderer/dialog-focus.js', 'renderer/list-keyboard.js']) {
    const source = read(rel);
    assert.match(source, /require\('\.\/focus-nav'\)/, `${rel} 必须取共享的 focus-nav`);
    // 反门禁：不许再长回本地判定 / 聚焦实现
    assert.equal(/function (isUsableItem|isTabbable)\([^)]*\) \{\s*if \(!el/.test(source), false, `${rel} 不许再手写可达性判定`);
    assert.equal(/function doFocus = /.test(source), false);
  }
  const html = read('renderer/index.html');
  const focusAt = html.indexOf('src="focus-nav.js"');
  assert.ok(focusAt > 0, 'index.html 必须加载 focus-nav.js');
  for (const file of ['menu-keyboard.js', 'dialog-focus.js', 'list-keyboard.js']) {
    assert.ok(html.indexOf(`src="${file}"`) > focusAt, `focus-nav.js 必须先于 ${file} 加载`);
  }
});
