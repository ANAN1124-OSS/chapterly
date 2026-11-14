'use strict';
// WP-41（X2）：章节多选的无障碍语义。
//
// 审计 X2 原文：章节条目 role="button" 却挂 aria-selected —— button 角色不支持该属性，读屏无法
// 感知多选状态；#chapter-list 也没有承载多选语义的角色。
//
// 收口口径（清单允许的第二条路：button 角色改用 aria-pressed）：
//   * 条目仍是 role="button"（Enter / 空格切章、roving tabindex、a11y 门禁按 [role=button] 量
//     目标尺寸都靠它；改成 option/listbox 会让卷头与空态成为 listbox 的非法子元素，也会把条目
//     从门禁的目标扫描里漏掉）；
//   * 多选态改用 aria-pressed（切换按钮的「按下 / 未按下」），渲染层不再 set / get aria-selected；
//   * #chapter-list 补 role="group" + aria-label="章节目录"，读屏进入列表时能听到分组名。
//
// 这些锚点钉住三处同步路径、测试钩子 / E2E 的读取口径，以及「视觉高亮只认 .selected class」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const RENDERER = read('renderer/renderer.js');
const INDEX = read('renderer/index.html');
const STYLES = read('renderer/styles.css');
const TEST_HOOKS = read('renderer/test-hooks.js');
const E2E_78 = read('scripts/e2e/groups/78-chapter-selection.js');
const A11Y_GATE = read('scripts/a11y-gate.js');

// 取一段源码：从 startNeedle 起、到 endNeedle 止（都含）。找不到就报错，避免正则静默匹配空串。
function sliceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.ok(start >= 0, `找不到源码片段起点：${startNeedle}`);
  const end = source.indexOf(endNeedle, start);
  assert.ok(end >= 0, `找不到源码片段终点：${endNeedle}`);
  return source.slice(start, end + endNeedle.length);
}

const MAKE_ITEM = sliceBetween(RENDERER, 'function makeChapterItem(', 'return item;');
const SYNC_SELECTION = sliceBetween(RENDERER, 'function syncChapterSelectionUi()', 'syncChapterBatchBar();');
const SYNC_ITEM = sliceBetween(RENDERER, 'function syncChapterItemInfo(', 'return true;');

test('X2：章节条目保留 button 角色，渲染层不再 set / get aria-selected', () => {
  assert.ok(MAKE_ITEM.includes("item.setAttribute('role', 'button')"), '章节条目仍是按钮角色');
  assert.equal(
    (RENDERER.match(/setAttribute\('aria-selected'/g) || []).length,
    0,
    '渲染层不许再挂 aria-selected：button 角色不支持这个属性，读屏读不到'
  );
  assert.equal(
    (RENDERER.match(/getAttribute\('aria-selected'/g) || []).length,
    0,
    '渲染层不再读 aria-selected'
  );
  assert.ok(
    MAKE_ITEM.includes('item.tabIndex = index === state.index ? 0 : -1'),
    'roving tabindex 不变（整张列表仍只有当前章一个 Tab 停留点）'
  );
});

test('X2：三条同步路径都写 aria-pressed —— 建表 / 选择变化 / 条目信息刷新', () => {
  assert.match(
    MAKE_ITEM,
    /setAttribute\(\s*'aria-pressed',\s*chapterSelectionLib\.isSelected\(chapterSelectionSnapshot\(\), chapter\.id\) \? 'true' : 'false'\s*\)/,
    '建表时按选择集合初始化 aria-pressed'
  );
  assert.ok(
    SYNC_SELECTION.includes("item.setAttribute('aria-pressed', on ? 'true' : 'false')"),
    '选择变化时只改 aria-pressed（不重建列表、不丢滚动位置）'
  );
  assert.ok(
    SYNC_ITEM.includes("item.setAttribute('aria-pressed', selected ? 'true' : 'false')"),
    '改名 / 改状态后的条目快路径也要同步 aria-pressed'
  );
});

test('X2：#chapter-list 是带名字的 group（读屏进入列表能听到「章节目录」）', () => {
  assert.match(
    INDEX,
    /<div class="chapter-list" id="chapter-list" role="group" aria-label="章节目录"><\/div>/,
    '章节列表容器要有 role=group 与无障碍名称'
  );
  assert.equal(INDEX.split('id="chapter-list"').length - 1, 1, 'chapter-list 只此一处');
  assert.match(INDEX, /aria-controls="chapter-list"/, '筛选框仍指向这张列表');
});

test('X2：测试钩子与 E2E 第 78 组读的都是 aria-pressed，旧属性断言只剩「必须不存在」', () => {
  assert.ok(
    TEST_HOOKS.includes("ariaPressed: items.map((el) => el.getAttribute('aria-pressed'))"),
    '测试钩子照实读 aria-pressed'
  );
  assert.equal(TEST_HOOKS.includes('ariaSelected:'), false, '测试钩子不再暴露旧的 ariaSelected 字段');
  assert.ok(E2E_78.includes("getAttribute('aria-pressed')"), 'E2E 读新属性');
  assert.ok(E2E_78.includes("hasAttribute('aria-selected')"), 'E2E 同时钉住旧属性彻底消失');
  assert.equal(
    E2E_78.includes("getAttribute('aria-selected')"),
    false,
    'E2E 不再把 aria-selected 当选中态来读'
  );
  assert.ok(E2E_78.includes('aria-pressed 互不覆盖'), '断言名如实写成 aria-pressed');
});

test('X2：a11y 门禁的目标扫描仍覆盖章节条目（[role=button] 留在 TARGET_SELECTOR 里）', () => {
  assert.ok(
    A11Y_GATE.includes('\'[role="button"]\''),
    'a11y 门禁按 [role=button] 收目标；条目改成 option 会掉出门禁扫描（所以本包保留按钮角色）'
  );
  assert.ok(
    A11Y_GATE.includes('\'[tabindex]:not([tabindex="-1"])\''),
    'tabindex 选择器只收 Tab 停留点，非当前章条目靠 role=button 进扫描'
  );
  assert.equal(
    MAKE_ITEM.includes("setAttribute('role', 'option')"),
    false,
    '章节条目不是 option —— 列表里还混着卷头按钮与空态，套 listbox 会留下非法子元素'
  );
});

test('X2：视觉选中态只认 .selected class，没有绑在 aria 属性上（换属性不改外观）', () => {
  assert.match(STYLES, /\.chapter-item\.selected\s*\{/, '选中高亮仍由 .selected 承载');
  assert.equal(STYLES.includes('.chapter-item[aria-selected'), false, '样式不许依赖旧 aria 属性');
  assert.equal(STYLES.includes('.chapter-item[aria-pressed'), false, '样式也不依赖新 aria 属性（纯语义）');
});

test('X2 排障锚点：a11y 门禁的设置分区 setup 等 openSettings 收尾后才点分区', () => {
  // V204 把弹层可见挪到 await stats 之前：可见后还会「回到默认分区 + 深链定位」，旧 setup 的
  // 一次点击会被这次重算吞掉（1294 的内容 / 数据 / 关于三个状态超时）。就绪信号 =
  // #settings-update-version 的文本变更（renderUpdateSettings 只在 openSettings 末尾调一次）。
  assert.ok(
    A11Y_GATE.includes("getElementById('settings-update-version')"),
    '就绪信号要取 renderUpdateSettings 写版本串的那个元素'
  );
  assert.ok(
    A11Y_GATE.includes('new MutationObserver(() => { ready = true; })'),
    '每次打开都会重写 textContent，用 MutationObserver 等这一次的写入'
  );
  assert.ok(A11Y_GATE.includes('open && ready && writing'), '没就绪前不点分区（不抢跑）');
  assert.ok(
    A11Y_GATE.includes("if (target.getAttribute('aria-selected') !== 'true') target.click();"),
    '仍走真实点击（不直接改 aria 属性）'
  );
  assert.match(
    A11Y_GATE,
    /if \(target\.getAttribute\('aria-selected'\) === 'true'\) \{\s*if \(observer\) observer\.disconnect\(\);\s*resolve\(true\);\s*return;\s*\}/,
    '目标真的选中才 resolve，并断开观察器'
  );
});