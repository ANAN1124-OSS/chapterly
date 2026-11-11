// 自绘标题栏（1.3.0 T6 / 规范 I-07）的唯一事实源：主题 → 窗口控件色、标题栏命中判断、窗口菜单模板。
//
// 这份测试的重点不是「函数能跑」，而是把两份事实钉在一起：
//   1) core/window-chrome.js 里的纸色 / 字形色必须等于 renderer/styles.css 里 6 套主题的
//      --paper / --ink-soft / --ink-faint —— 主进程和渲染层各写一份颜色，谁改歪了立即红；
//   2) 失焦纸色必须是「纸色每个通道 ×0.98」——和 styles.css 里那层 2% 暗色是同一个算式，
//      两边不一致就会在右上角出现一块比顶栏亮 2% 的色块。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const chrome = require('../core/window-chrome');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CSS = read('renderer/styles.css');
const MAIN = read('main.js');

// 取一个选择器块里的自定义属性表（本文件的主题块都是 `选择器 { --k: v; … }`，没有嵌套花括号）
function blockOf(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`).exec(source);
  if (!match) return null;
  const vars = {};
  for (const hit of match[2].matchAll(/--([a-z-]+)\s*:\s*([^;]+);/g)) vars[hit[1]] = hit[2].trim();
  return vars;
}

const rootVars = blockOf(CSS, ':root');
const themeVars = (name) => (name === 'paper' ? {} : blockOf(CSS, `body.theme-${name}`) || {});

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (channels) =>
  '#' +
  channels
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
    .join('');

test('标题栏高度在规范给的 34–58px 区间内，拖拽区与系统按钮区同高', () => {
  assert.ok(chrome.TITLEBAR_HEIGHT >= 34 && chrome.TITLEBAR_HEIGHT <= 58, `实际 ${chrome.TITLEBAR_HEIGHT}`);
  assert.equal(chrome.DRAG_ZONE_HEIGHT, chrome.TITLEBAR_HEIGHT);
  assert.equal(chrome.overlayFor('paper').height, chrome.TITLEBAR_HEIGHT, 'titleBarOverlay.height 必须同源');
  // styles.css 的 --titlebar-height 也要一致（拖拽区 / 专注模式留白都读它）
  assert.equal(rootVars['titlebar-height'], `${chrome.TITLEBAR_HEIGHT}px`);
});

test('6 套主题一张表：主题名单与 styles.css 的主题类一一对应，默认主题是 paper', () => {
  assert.deepEqual(chrome.THEME_NAMES.slice().sort(), ['cream', 'green', 'grid', 'kraft', 'night', 'paper']);
  assert.equal(chrome.DEFAULT_THEME, 'paper');
  for (const name of chrome.THEME_NAMES) {
    if (name === 'paper') continue;
    assert.ok(CSS.includes(`body.theme-${name} {`), `styles.css 里必须有 body.theme-${name} 主题块`);
  }
});

test('纸色 / 字形色 = styles.css 的 --paper / --ink-soft / --ink-faint（主进程与渲染层不许各写一份）', () => {
  for (const name of chrome.THEME_NAMES) {
    const theme = chrome.THEMES[name];
    const vars = themeVars(name);
    const wantPaper = vars.paper || rootVars.paper;
    const wantSymbol = vars['ink-soft'] || rootVars['ink-soft'];
    const wantInactive = vars['ink-faint'] || rootVars['ink-faint'];
    assert.equal(theme.paper, wantPaper, `${name} 纸色`);
    assert.equal(theme.symbol, wantSymbol, `${name} 字形色（--ink-soft）`);
    assert.equal(theme.symbolInactive, wantInactive, `${name} 失焦字形色（--ink-faint）`);
  }
});

test('失焦纸色 = 纸色每个通道 ×0.98（与 styles.css 那层 2% 暗色同一个算式）', () => {
  assert.match(CSS, /body\.window-inactive #app::after \{[\s\S]*?background:\s*rgba\(0,\s*0,\s*0,\s*\.02\);/, 'styles.css 里必须有 2% 暗层');
  for (const name of chrome.THEME_NAMES) {
    const theme = chrome.THEMES[name];
    const want = hex(rgb(theme.paper).map((v) => v * 0.98));
    assert.equal(theme.paperInactive, want, `${name} 失焦纸色`);
  }
});

test('overlayFor：默认 / 失焦两态只差底色与字形色，主题名不认识时回落默认纸色', () => {
  assert.deepEqual(chrome.overlayFor('paper'), {
    color: chrome.THEMES.paper.paper,
    symbolColor: chrome.THEMES.paper.symbol,
    height: chrome.TITLEBAR_HEIGHT
  });
  assert.deepEqual(chrome.overlayFor('night', { inactive: true }), {
    color: chrome.THEMES.night.paperInactive,
    symbolColor: chrome.THEMES.night.symbolInactive,
    height: chrome.TITLEBAR_HEIGHT
  });
  // 写坏的 / 以后新加的主题名：回落默认纸色，不抛错、不给 undefined
  for (const bad of ['', null, undefined, 'sepia', 42, 'PAPER ']) {
    const got = chrome.overlayFor(bad);
    assert.equal(got.color, chrome.THEMES.paper.paper, `${String(bad)} 应回落默认纸色`);
    assert.equal(got.symbolColor, chrome.THEMES.paper.symbol);
  }
  assert.equal(chrome.overlayFor(' night ').color, chrome.THEMES.night.paper, '主题名两侧空白不算写坏');
  assert.equal(chrome.backgroundFor('night'), chrome.THEMES.night.paper, '窗口底色跟主题纸色');
});

test('标题栏命中：只认顶部 40px 的非编辑区；输入框 / 有选中文字 / 坐标缺失都不算', () => {
  assert.equal(chrome.isTitleBarHit({ x: 400, y: 12 }), true);
  assert.equal(chrome.isTitleBarHit({ x: 0, y: 0 }), true);
  assert.equal(chrome.isTitleBarHit({ x: 900, y: chrome.DRAG_ZONE_HEIGHT }), true, '下沿也算（闭区间）');
  assert.equal(chrome.isTitleBarHit({ x: 400, y: chrome.DRAG_ZONE_HEIGHT + 1 }), false, '顶栏以下不算');
  assert.equal(chrome.isTitleBarHit({ x: 400, y: 12, isEditable: true }), false, '输入框归文字菜单');
  assert.equal(chrome.isTitleBarHit({ x: 400, y: 12, selectionText: '选中了几个字' }), false);
  assert.equal(chrome.isTitleBarHit({ x: 400, y: 12, selectionText: '   ' }), true, '只有空白不算选中');
  assert.equal(chrome.isTitleBarHit({ x: 400 }), false);
  assert.equal(chrome.isTitleBarHit({ y: 12 }), false);
  assert.equal(chrome.isTitleBarHit({ x: -1, y: 12 }), false);
  assert.equal(chrome.isTitleBarHit(null), false);
  assert.equal(chrome.isTitleBarHit(undefined), false);
});

test('窗口菜单：命令面板 + 还原 / 最小化 / 最大化 / 关闭，可用状态跟最大化状态走', () => {
  const calls = [];
  const actions = {
    maximized: false,
    restore: () => calls.push('restore'),
    minimize: () => calls.push('minimize'),
    maximize: () => calls.push('maximize'),
    close: () => calls.push('close')
  };
  const normal = chrome.menuTemplate(actions);
  assert.deepEqual(
    normal.map((item) => item.label),
    ['命令面板', undefined, '还原', '最小化', '最大化', undefined, '关闭']
  );
  assert.equal(normal[1].type, 'separator');
  assert.equal(normal[5].type, 'separator');
  assert.equal(normal[0].enabled, false, '没传命令面板动作时该项不可用（不许点了没反应）');
  assert.equal(normal[2].enabled, false, '没最大化时「还原」不可用');
  assert.equal(normal[4].enabled, true);
  normal.forEach((item) => {
    if (item.enabled === true && typeof item.click === 'function') item.click();
  });
  assert.deepEqual(calls, ['minimize', 'maximize', 'close']);

  const maximized = chrome.menuTemplate({ ...actions, maximized: true });
  assert.equal(maximized[2].enabled, true, '最大化后「还原」可用');
  assert.equal(maximized[4].enabled, false, '最大化后「最大化」不可用');
  // 没传动作 / 传错类型：整份菜单都不可用，不抛错
  for (const bad of [undefined, null, 'x', 42]) {
    const template = chrome.menuTemplate(bad);
    assert.equal(template.length, 7);
    assert.ok(template.filter((item) => item.label).every((item) => item.enabled === false));
  }
});

test('窗口菜单：命令面板排第一、带 Ctrl+K 键帽提示，点一下只透传动作', () => {
  const calls = [];
  const items = chrome.menuTemplate({
    maximized: false,
    commandPalette: () => calls.push('palette')
  });
  assert.equal(items[0].label, '命令面板');
  assert.equal(items[0].accelerator, 'Ctrl+K', '菜单里要能看见 Ctrl+K（和命令面板同一个键位）');
  assert.equal(items[0].enabled, true);
  assert.equal(typeof items[0].click, 'function');
  items[0].click();
  assert.deepEqual(calls, ['palette']);

  // 动作缺失时 click 不该是个空函数（Electron 会把可点的项画成正常样式，点了没反应）
  const bare = chrome.menuTemplate({ maximized: false });
  assert.equal(bare[0].enabled, false);
  assert.equal(typeof bare[0].click, 'undefined');
});

test('main.js：窗口用 titleBarStyle hidden + titleBarOverlay，底色 / 失焦重刷都走 core/window-chrome', () => {
  assert.match(MAIN, /titleBarStyle:\s*'hidden'/, '窗口必须隐藏原生标题栏');
  assert.match(MAIN, /titleBarOverlay:\s*windowChrome\.overlayFor\(/, '系统按钮区配色必须来自同一张主题表');
  assert.match(MAIN, /backgroundColor:\s*windowChrome\.backgroundFor\(/, '窗口底色跟主题纸色（夜间不再先闪一下浅色）');
  assert.match(MAIN, /win\.setTitleBarOverlay\(windowChrome\.overlayFor\(/, '换主题 / 失焦时必须重刷系统按钮区');
  assert.equal(/#f6f4ef/.test(MAIN), false, '旧的写死窗口底色不许再出现（会跟 6 套纸色对不上）');
  // 只许一处 new BrowserWindow（security-regression.test.js 也钉了这条，这里再钉一次免得绕开）
  assert.equal((MAIN.match(/new BrowserWindow\(/g) || []).length, 1);
  // 右键：可编辑区域仍然先走文字菜单；标题栏拖拽区出窗口菜单
  assert.match(
    MAIN,
    /if \(textMenu\.shouldShow\(params\)\) \{[\s\S]{0,400}?if \(!windowChrome\.isTitleBarHit\(params\)\) return;[\s\S]{0,200}?Menu\.buildFromTemplate\(titleBarMenuTemplate\(browserWin\)\)\.popup/,
    '标题栏右键要出窗口菜单，且不能抢走输入框的文字菜单'
  );
  // 失焦 / 回焦要重刷系统按钮区；按书主题变了也要重刷
  assert.match(MAIN, /browserWin\.on\('blur', \(\) => applyWindowChrome\(session\)\)/);
  assert.match(MAIN, /browserWin\.on\('focus', \(\) => \{[\s\S]{0,300}?applyWindowChrome\(session\);/, '回焦要重刷');
  assert.match(MAIN, /function applyConfig\(raw\) \{[\s\S]{0,200}?applyWindowChromeAll\(\);/);
  assert.match(MAIN, /session\.bookId = key;/, '按书设置主题时要记下这本书的 id');
  assert.match(MAIN, /session\.bookId = '';/, '回书架要清掉，标题栏回到全局主题');
});

test('core/window-chrome.js 是纯数据 / 纯函数：不 require electron、不读文件、不碰书库', () => {
  const source = read('core/window-chrome.js');
  assert.equal(/require\(['"]electron['"]\)/.test(source), false);
  assert.equal(/require\(['"]node:fs['"]\)/.test(source), false);
  assert.equal(/child_process|BrowserWindow|setTitleBarOverlay/.test(source.replace(/\/\/.*$/gm, '')), false, '注释外不许出现主进程 API');
});
