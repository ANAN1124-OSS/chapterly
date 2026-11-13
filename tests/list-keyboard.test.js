// 单测：键盘可达（v0.9 A-5b）。
//
// 这一项补的是「只用键盘也能开会话、切章」这一条通道，产品侧只有一个浏览器模块
// `renderer/list-keyboard.js`（纯逻辑 + 容器事件委托），渲染层只接线。所以这里测两半：
//   · 纯逻辑：按键 → 计划（激活 / 移动 / 不管）、下标夹紧、roving tabindex、补 Tab 停留点；
//   · 接线：容器上的 keydown 事件委托（真的调 onActivate、方向键真的移焦点并改 tabIndex、
//     焦点在卡片里的按钮上时不被抢）。
// 再加几条静态闸门，钉住「只补键盘通道、不碰鼠标」以及「index.html 里加载顺序 / 只引一次」。
//
// 真实浏览器里的行为（真实 Tab / Enter 按键）由 E2E 第 70 组断言。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const listKeyboard = require(path.join(ROOT, 'renderer', 'list-keyboard.js'));
const INDEX = read('renderer/index.html');
const RENDERER = read('renderer/renderer.js');
const STYLES = read('renderer/styles.css');
// 第 4 步九刀·第六刀：书架书卡整段搬到 renderer/bookinfo-ui.js；书卡的 roving / 无障碍属性
// 从这里读（只改读取路径，断言一条不改）。
const BOOKINFO_UI = read('renderer/bookinfo-ui.js');

const key = (name, extra) => ({ key: name, preventDefault() {}, ...(extra || {}) });

// ---------- 纯逻辑 ----------

test('键盘可达：Enter / 空格 / Spacebar 都算激活，别的键不算', () => {
  assert.equal(listKeyboard.isActivateKey('Enter'), true);
  assert.equal(listKeyboard.isActivateKey(' '), true);
  assert.equal(listKeyboard.isActivateKey('Spacebar'), true);
  assert.equal(listKeyboard.isActivateKey('a'), false);
  assert.equal(listKeyboard.isActivateKey(''), false);
  assert.equal(listKeyboard.isActivateKey(undefined), false);
});

test('键盘可达：方向键在同一列表内一格一格走，到头就夹住（不绕回）', () => {
  assert.equal(listKeyboard.nextIndex(1, 'ArrowDown', 3), 2);
  assert.equal(listKeyboard.nextIndex(1, 'ArrowUp', 3), 0);
  assert.equal(listKeyboard.nextIndex(0, 'ArrowUp', 3), 0);
  assert.equal(listKeyboard.nextIndex(2, 'ArrowDown', 3), 2);
  assert.equal(listKeyboard.nextIndex(1, 'ArrowRight', 3), 2, '右方向键也算下一项');
  assert.equal(listKeyboard.nextIndex(1, 'ArrowLeft', 3), 0, '左方向键也算上一项');
  assert.equal(listKeyboard.nextIndex(1, 'Home', 3), 0);
  assert.equal(listKeyboard.nextIndex(1, 'End', 3), 2);
});

test('键盘可达：坏下标 / 空列表 / 非数字都收敛，不乱跳', () => {
  assert.equal(listKeyboard.nextIndex(-5, 'ArrowDown', 3), 1, '坏下标当第一个再走一格');
  assert.equal(listKeyboard.nextIndex(99, 'ArrowUp', 3), 0, '越界下标也当第一个（不瞎猜「最后一个」）');
  assert.equal(listKeyboard.nextIndex(NaN, 'End', 3), 2);
  assert.equal(listKeyboard.nextIndex(0, 'ArrowDown', 0), null, '空列表没有可去的地方');
  assert.equal(listKeyboard.nextIndex(0, 'ArrowDown', -1), null);
  assert.equal(listKeyboard.nextIndex(0, 'PageDown', 3), null, '不认识的键不接管');
});

test('键盘可达：按键计划——带修饰键 / 其它键一律不管，避免抢 Ctrl+方向 / 选中', () => {
  assert.deepEqual(listKeyboard.keyAction(key('Enter'), 1, 3), { type: 'activate', index: 1 });
  assert.deepEqual(listKeyboard.keyAction(key(' '), 0, 3), { type: 'activate', index: 0 });
  assert.deepEqual(listKeyboard.keyAction(key('ArrowDown'), 1, 3), { type: 'move', index: 2 });
  assert.equal(listKeyboard.keyAction(key('ArrowDown', { ctrlKey: true }), 1, 3), null);
  assert.equal(listKeyboard.keyAction(key('ArrowDown', { shiftKey: true }), 1, 3), null);
  assert.equal(listKeyboard.keyAction(key('Enter', { altKey: true }), 1, 3), null);
  assert.equal(listKeyboard.keyAction(key('Escape'), 1, 3), null);
  assert.equal(listKeyboard.keyAction(null, 0, 3), null);
});

test('书架书卡网格（拍板 #16b）：←/→ 只在行内走，↑/↓ 按列数跨行，边界停住不绕回也不斜跳', () => {
  // 3 列 × 3 行，下标 0..8（行优先，与 DOM 顺序一致）
  assert.equal(listKeyboard.nextGridIndex(4, 'ArrowRight', 9, 3), 5);
  assert.equal(listKeyboard.nextGridIndex(4, 'ArrowLeft', 9, 3), 3);
  assert.equal(listKeyboard.nextGridIndex(3, 'ArrowLeft', 9, 3), 3, '行首再往左停在原地（不跳到上一行行尾）');
  assert.equal(listKeyboard.nextGridIndex(5, 'ArrowRight', 9, 3), 5, '行尾再往右停在原地');
  assert.equal(listKeyboard.nextGridIndex(4, 'ArrowUp', 9, 3), 1);
  assert.equal(listKeyboard.nextGridIndex(4, 'ArrowDown', 9, 3), 7);
  assert.equal(listKeyboard.nextGridIndex(1, 'ArrowUp', 9, 3), 1, '第一行再往上停在原地（同一列，不斜跳到 0）');
  assert.equal(listKeyboard.nextGridIndex(7, 'ArrowDown', 9, 3), 7, '最后一行再往下停在原地');
  assert.equal(listKeyboard.nextGridIndex(8, 'ArrowRight', 9, 3), 8, '最后一个右边没有了');
});

test('书架书卡网格：最后一行不满时行尾是本行最后一个；Home / End 走本行首尾', () => {
  // 10 张卡 3 列：最后一行只有 1 张（下标 9）
  assert.equal(listKeyboard.nextGridIndex(8, 'ArrowRight', 10, 3), 8, '8 已经是本行（6,7,8）行尾');
  assert.equal(listKeyboard.nextGridIndex(9, 'ArrowRight', 10, 3), 9, '最后一行只有自己：右边没有');
  assert.equal(listKeyboard.nextGridIndex(9, 'ArrowDown', 10, 3), 9);
  assert.equal(listKeyboard.nextGridIndex(9, 'ArrowUp', 10, 3), 6, '最后一行的 ↑ 落到上一行同列');
  assert.equal(listKeyboard.nextGridIndex(6, 'ArrowUp', 10, 3), 3);
  assert.equal(listKeyboard.nextGridIndex(7, 'ArrowDown', 10, 3), 7, '下一行同列没有卡：停住，不斜跳到 9');
  assert.equal(listKeyboard.nextGridIndex(4, 'Home', 10, 3), 3, 'Home 是本行第一个，不是整表第一个');
  assert.equal(listKeyboard.nextGridIndex(4, 'End', 10, 3), 5, 'End 是本行最后一个');
  assert.equal(listKeyboard.nextGridIndex(9, 'Home', 10, 3), 9);
  assert.equal(listKeyboard.nextGridIndex(9, 'End', 10, 3), 9);
});

test('书架书卡网格：坏列数 / 空列表 / 越界下标都收敛（不抛、不瞎跳）', () => {
  assert.equal(listKeyboard.nextGridIndex(2, 'ArrowRight', 0, 3), null, '空列表没有可去的地方');
  assert.equal(listKeyboard.nextGridIndex(2, 'ArrowRight', -1, 3), null);
  assert.equal(listKeyboard.nextGridIndex(2, 'PageDown', 9, 3), null, '不认识的键不接管');
  assert.equal(listKeyboard.nextGridIndex(2, 'ArrowRight', 9, 1), 2, '1 列视为一整行：←/→ 停在原地');
  assert.equal(listKeyboard.nextGridIndex(2, 'ArrowDown', 9, 1), 3, '1 列时 ↑/↓ 仍是 ±1');
  assert.equal(listKeyboard.nextGridIndex(2, 'End', 9, 1), 2, '1 列时 End 就是自己');
  assert.equal(listKeyboard.nextGridIndex(2, 'ArrowRight', 9, NaN), 2, 'NaN 列数按 1 列');
  assert.equal(listKeyboard.nextGridIndex(2, 'ArrowRight', 9, 0), 2, '0 列按 1 列');
  assert.equal(listKeyboard.nextGridIndex(-5, 'ArrowDown', 9, 3), 3, '坏下标当第 0 个再跨一行');
  assert.equal(listKeyboard.nextGridIndex(99, 'ArrowDown', 9, 3), 3, '越界下标也当第 0 个');
  assert.equal(listKeyboard.nextGridIndex(4, 'ArrowDown', 9, 2.7), 6, '小数列数向下取整');
});

test('书架书卡网格：keyAction 只有 columns > 1 才走网格，单列 / 不传时一字不差走原来的单向移动', () => {
  assert.deepEqual(listKeyboard.keyAction(key('ArrowRight'), 4, 9, { columns: 3 }), { type: 'move', index: 5 });
  assert.deepEqual(listKeyboard.keyAction(key('ArrowLeft'), 3, 9, { columns: 3 }), { type: 'move', index: 3 }, '行首夹住');
  assert.deepEqual(listKeyboard.keyAction(key('ArrowDown'), 4, 9, { columns: 3 }), { type: 'move', index: 7 });
  assert.deepEqual(listKeyboard.keyAction(key('Home'), 4, 9, { columns: 3 }), { type: 'move', index: 3 });
  assert.deepEqual(listKeyboard.keyAction(key('ArrowRight'), 1, 3), { type: 'move', index: 2 }, '不传 options = 旧行为');
  assert.deepEqual(listKeyboard.keyAction(key('ArrowRight'), 1, 3, { columns: 1 }), { type: 'move', index: 2 }, '1 列仍是旧行为');
  assert.deepEqual(listKeyboard.keyAction(key('End'), 1, 3, { columns: 0 }), { type: 'move', index: 2 });
  assert.deepEqual(listKeyboard.keyAction(key('Enter'), 1, 3, { columns: 3 }), { type: 'activate', index: 1 }, '激活与列数无关');
  assert.equal(listKeyboard.keyAction(key('ArrowRight', { shiftKey: true }), 4, 9, { columns: 3 }), null);
  assert.equal(listKeyboard.keyAction(key('ArrowDown', { ctrlKey: true }), 4, 9, { columns: 3 }), null);
  assert.equal(listKeyboard.keyAction(key('PageDown'), 4, 9, { columns: 3 }), null);
});

test('书架书卡网格：容器委托真按网格挪焦点（列数每次现算，响应式换列自动跟随）', () => {
  const items = makeItems(9, '.book-card');
  const container = makeContainer(items);
  let columns = 3;
  const moved = [];
  listKeyboard.install({
    container,
    itemSelector: '.book-card',
    arrows: true,
    columns: () => columns,
    onActivate() {},
    onMove: (el) => moved.push(el.dataset.index)
  });
  const send = (target, name) =>
    container.fire({ type: 'keydown', key: name, target, preventDefault() {} });

  send(items[4], 'ArrowRight');
  assert.equal(items[5].focused, true);
  assert.equal(items[5].tabIndex, 0, 'roving 跟着新焦点');
  assert.equal(items.filter((el) => el.tabIndex === 0).length, 1, '仍只有一个 Tab 停留点');
  send(items[5], 'ArrowRight');
  assert.equal(items[5].focused, true, '行尾往右不动（不跨到下一行）');
  send(items[4], 'ArrowDown');
  assert.equal(items[7].focused, true);
  send(items[7], 'ArrowUp');
  assert.equal(items[4].focused, true, '回来也按列数');
  // 窗口从 3 列变 2 列：下一次按键必须按 2 列算（每次现算，不是安装时定死）
  columns = 2;
  send(items[4], 'ArrowDown');
  assert.equal(items[6].focused, true, '2 列时 4 → 6');
  // 1 列（窄窗单列书架）：网格不生效，退回原来的单向移动（←/→ 也算上下一项）
  columns = 1;
  send(items[6], 'ArrowRight');
  assert.equal(items[7].focused, true, '1 列时 ←/→ 退回单向移动');
  assert.deepEqual(moved, ['5', '7', '4', '6', '7']);
});

test('书架书卡网格：columns 抛错 / 给垃圾值时退化成单列；arrows 关着时列数完全不生效', () => {
  const boomItems = makeItems(4, '.book-card');
  const boomContainer = makeContainer(boomItems);
  listKeyboard.install({
    container: boomContainer,
    itemSelector: '.book-card',
    arrows: true,
    columns: () => { throw new Error('boom'); }
  });
  boomContainer.fire({ type: 'keydown', key: 'ArrowDown', target: boomItems[0], preventDefault() {} });
  assert.equal(boomItems[1].focused, true, '抛错的 columns 按 1 列处理（↑/↓ 仍 ±1）');

  const junkItems = makeItems(4, '.book-card');
  const junkContainer = makeContainer(junkItems);
  listKeyboard.install({ container: junkContainer, itemSelector: '.book-card', arrows: true, columns: () => 'abc' });
  let preventedJunk = 0;
  junkContainer.fire({ type: 'keydown', key: 'ArrowRight', target: junkItems[0], preventDefault: () => (preventedJunk += 1) });
  assert.equal(preventedJunk, 1, '垃圾列数 → 按 1 列处理，←/→ 仍能上下走');
  assert.equal(junkItems[1].focused, true, '焦点按单向移动落到第二张');

  const plainItems = makeItems(9, '.book-card');
  const plainContainer = makeContainer(plainItems);
  const plainMoved = [];
  listKeyboard.install({
    container: plainContainer,
    itemSelector: '.book-card',
    columns: () => 3,
    onMove: (el) => plainMoved.push(el.dataset.index)
  });
  plainContainer.fire({ type: 'keydown', key: 'ArrowDown', target: plainItems[0], preventDefault() {} });
  assert.deepEqual(plainMoved, [], 'arrows 没开：columns 再对也不移焦点');
});

test('键盘可达：roving tabindex——只有当前项是 0，其余 -1；坏下标落到第一个', () => {
  const items = [{ tabIndex: 9 }, { tabIndex: 9 }, { tabIndex: 9 }];
  assert.equal(listKeyboard.applyTabStops(items, 1), 3);
  assert.deepEqual(items.map((el) => el.tabIndex), [-1, 0, -1]);
  listKeyboard.applyTabStops(items, 99);
  assert.deepEqual(items.map((el) => el.tabIndex), [0, -1, -1], '越界时让第一个可 Tab 到');
  assert.equal(listKeyboard.applyTabStops([], 0), 0, '空列表不炸');
});

// V87（1.7.2 D6）：roving tabindex 以前每次方向键都无条件写满整列 tabIndex（千章列表 = 每键上千次
// DOM 属性写，属性 setter 会连带样式 / 无障碍树重算）。目标值已经对上的条目不写：DOM 语义完全不变。
test('键盘可达：applyTabStops 同值不写 DOM 属性（V87，属性写计数）', () => {
  const makeItem = (start) => {
    let value = start;
    let writes = 0;
    const el = {};
    Object.defineProperty(el, 'tabIndex', {
      get: () => value,
      set(next) {
        writes += 1;
        value = next;
      }
    });
    el.writes = () => writes;
    return el;
  };

  // 三条都是 -1：把停留点放到第一条 → 只有第一条要写
  const items = [makeItem(-1), makeItem(-1), makeItem(-1)];
  assert.equal(listKeyboard.applyTabStops(items, 0), 3);
  assert.deepEqual(items.map((el) => el.tabIndex), [0, -1, -1]);
  assert.deepEqual(items.map((el) => el.writes()), [1, 0, 0], '已经是 -1 的条目一个属性都不该写');

  // 焦点从第一条挪到第三条：只写「让出来的」和「接过去的」两个
  listKeyboard.applyTabStops(items, 2);
  assert.deepEqual(items.map((el) => el.tabIndex), [-1, -1, 0]);
  assert.deepEqual(items.map((el) => el.writes()), [2, 0, 1], '中间那条本来就该是 -1，不该被写');

  // 重复调用同一个停留点（方向键到头 / 重复渲染）：一个属性都不写
  const before = items.map((el) => el.writes());
  listKeyboard.applyTabStops(items, 2);
  assert.deepEqual(items.map((el) => el.writes()), before, '状态没变就完全不动 DOM');

  // 越界下标落到第一条（旧行为不变），仍按同值不写的口径
  const fallback = [makeItem(-1), makeItem(0)];
  listKeyboard.applyTabStops(fallback, 99);
  assert.deepEqual(fallback.map((el) => el.tabIndex), [0, -1]);
  assert.deepEqual(fallback.map((el) => el.writes()), [1, 1]);
});

test('键盘可达：当前章在折叠的卷里时，补第一个条目当 Tab 停留点（且不重复补）', () => {
  const fake = (tabs) => {
    const items = tabs.map((tabIndex) => ({ tabIndex }));
    return { items, querySelectorAll: () => items };
  };
  const none = fake([-1, -1]);
  assert.equal(listKeyboard.ensureTabStop(none, '.chapter-item'), true);
  assert.equal(none.items[0].tabIndex, 0);
  const has = fake([-1, 0]);
  assert.equal(listKeyboard.ensureTabStop(has, '.chapter-item'), false, '已经有停留点就不动');
  assert.equal(listKeyboard.ensureTabStop({ querySelectorAll: () => [] }, '.chapter-item'), false);
  assert.equal(listKeyboard.ensureTabStop(null, '.chapter-item'), false);
});

// ---------- F2 重命名（Phase D / D2） ----------

test('F2 重命名：焦点在章节条目上就改那一条，否则改当前章（越界 / 空书都收敛）', () => {
  const chapterItem = (index) => {
    const el = { tagName: 'DIV', dataset: { index: String(index) } };
    el.closest = (selector) => (selector === '#chapter-list .chapter-item' ? el : null);
    return el;
  };
  assert.equal(listKeyboard.renameTargetIndex(chapterItem(2), 4, 0), 2, '焦点停在第 3 条：改第 3 条（不是当前章）');
  assert.equal(listKeyboard.renameTargetIndex(chapterItem('1'), 4, 3), 1, 'dataset 是字符串也认');
  const input = { tagName: 'INPUT', closest: () => null };
  assert.equal(listKeyboard.renameTargetIndex(input, 4, 3), 3, '焦点不在列表：改当前章');
  assert.equal(listKeyboard.renameTargetIndex(null, 4, 1), 1, '没有焦点元素：改当前章');
  assert.equal(listKeyboard.renameTargetIndex(chapterItem(9), 4, 1), 1, '焦点条目下标越界：回落当前章');
  assert.equal(listKeyboard.renameTargetIndex(chapterItem('x'), 4, 1), 1, '焦点条目下标不是数字：回落当前章');
  assert.equal(listKeyboard.renameTargetIndex(null, 0, 0), -1, '没有章节：-1（不猜）');
  assert.equal(listKeyboard.renameTargetIndex(null, 4, 9), -1, '当前章也越界：-1');
  assert.equal(listKeyboard.renameTargetIndex(null, 4, NaN), -1);
});

test('F2 重命名：焦点在别的输入框里不抢（编辑区自己的 textarea 除外）', () => {
  const editor = { tagName: 'TEXTAREA' };
  assert.equal(listKeyboard.isTypingTarget(editor, editor), false, '编辑区是欢迎 F2 的');
  assert.equal(listKeyboard.isTypingTarget({ tagName: 'TEXTAREA' }, editor), true, '别的 textarea（查找 / 碎片）不抢');
  assert.equal(listKeyboard.isTypingTarget({ tagName: 'input' }, editor), true, 'input 不抢（大小写无关）');
  assert.equal(listKeyboard.isTypingTarget({ tagName: 'SELECT' }, editor), true, '下拉框不抢');
  assert.equal(listKeyboard.isTypingTarget({ tagName: 'BUTTON' }, editor), false, '按钮上可以按 F2');
  assert.equal(listKeyboard.isTypingTarget(null, editor), false);
});

// ---------- Alt+↑/↓ 章节上移 / 下移（Phase D / D1） ----------

test('键盘可达：Alt+↑/↓ 交给 onAltMove（拦住冒泡，不再触发全局段落导航）；没装时照旧不管', () => {
  const items = makeItems(3, '.chapter-item');
  const container = makeContainer(items);
  const moved = [];
  let prevented = 0;
  let stopped = 0;
  listKeyboard.install({
    container,
    itemSelector: '.chapter-item',
    arrows: true,
    onAltMove: (item, position, direction) => moved.push([position, direction])
  });
  const send = (target, name, extra = {}) =>
    container.fire({
      type: 'keydown',
      key: name,
      target,
      preventDefault: () => (prevented += 1),
      stopPropagation: () => (stopped += 1),
      ...extra
    });
  send(items[1], 'ArrowDown', { altKey: true });
  assert.deepEqual(moved, [[1, 1]], 'Alt+↓ = 下移一格');
  assert.equal(prevented, 1, '接管后要拦默认行为');
  assert.equal(stopped, 1, '必须拦住冒泡，否则 document 上会触发段落导航');
  send(items[1], 'ArrowUp', { altKey: true });
  assert.deepEqual(moved, [[1, 1], [1, -1]], 'Alt+↑ = 上移一格');
  send(items[1], 'ArrowDown', { altKey: true, ctrlKey: true });
  send(items[1], 'ArrowLeft', { altKey: true });
  send(items[1], 'ArrowDown', { altKey: true, shiftKey: true });
  assert.equal(moved.length, 2, 'Ctrl+Alt / Alt+← / Alt+Shift 都不接管');
  assert.equal(prevented, 2, '不接管的组合不拦默认行为');

  // 没装 onAltMove（书架书卡）：Alt+↓ 既不 preventDefault，也不移焦点
  const grid = makeItems(2, '.book-card');
  const gridContainer = makeContainer(grid);
  let gridPrevented = 0;
  listKeyboard.install({ container: gridContainer, itemSelector: '.book-card', arrows: true });
  gridContainer.fire({
    type: 'keydown',
    key: 'ArrowDown',
    altKey: true,
    target: grid[0],
    preventDefault: () => (gridPrevented += 1)
  });
  assert.equal(gridPrevented, 0);
  assert.equal(grid[1].focused, false);
});

// ---------- Delete 删除章节（U-D9） ----------

test('U-D9：Delete 只在宿主打开 allowDelete 时交给 onDelete（不接管就不拦默认行为）', () => {
  // 纯逻辑：键 → 计划
  assert.deepEqual(listKeyboard.keyAction(key('Delete'), 2, 4, { allowDelete: true }), { type: 'delete', index: 2 });
  assert.equal(listKeyboard.keyAction(key('Delete'), 2, 4), null, '没打开 allowDelete（书架书卡）不接管');
  assert.equal(listKeyboard.keyAction(key('Delete'), 2, 4, { allowDelete: false }), null);
  assert.equal(listKeyboard.keyAction(key('Delete', { ctrlKey: true }), 2, 4, { allowDelete: true }), null, 'Ctrl+Delete 不抢');
  assert.equal(listKeyboard.keyAction(key('Delete', { shiftKey: true }), 2, 4, { allowDelete: true }), null);
  assert.equal(listKeyboard.keyAction(key('Delete', { altKey: true }), 2, 4, { allowDelete: true }), null);
  assert.equal(listKeyboard.keyAction(key('Delete', { metaKey: true }), 2, 4, { allowDelete: true }), null);

  // 容器委托：列表里按 Delete → onDelete(条目, 下标) 且 preventDefault；可以连删
  const items = makeItems(3, '.chapter-item');
  const container = makeContainer(items);
  const deleted = [];
  let prevented = 0;
  listKeyboard.install({
    container,
    itemSelector: '.chapter-item',
    arrows: true,
    allowDelete: true,
    onDelete: (item, position) => deleted.push([item.dataset.index, position])
  });
  container.fire({ type: 'keydown', key: 'Delete', target: items[1], preventDefault: () => (prevented += 1) });
  assert.deepEqual(deleted, [['1', 1]], '删的是焦点所在那一条');
  assert.equal(prevented, 1, '接管了删除键就要拦默认行为');
  container.fire({ type: 'keydown', key: 'Delete', target: items[2], preventDefault: () => (prevented += 1) });
  assert.deepEqual(deleted, [['1', 1], ['2', 2]], '可以连删（每次都是当前焦点条）');
  assert.equal(prevented, 2);
  // 别的键没被 Delete 带歪：字母键仍然什么都不做
  container.fire({ type: 'keydown', key: 'a', target: items[0], preventDefault: () => (prevented += 1) });
  assert.equal(prevented, 2, '普通字母键不拦');
  assert.equal(deleted.length, 2);
});

test('U-D9：没装 onDelete 的列表（书卡）与容器外的元素（编辑区）按 Delete 都不删章', () => {
  // 书架书卡：没有删除语义 —— 就算传了 onDelete 也不接管（allowDelete 没开）
  const cards = makeItems(2, '.book-card');
  const grid = makeContainer(cards);
  let touched = 0;
  listKeyboard.install({
    container: grid,
    itemSelector: '.book-card',
    arrows: true,
    onActivate() {},
    onDelete: () => (touched += 1)
  });
  grid.fire({ type: 'keydown', key: 'Delete', target: cards[0], preventDefault: () => (touched += 100) });
  assert.equal(touched, 0, '书架书卡没有删除语义：onDelete 收不到，也不 preventDefault');

  // 章节列表：事件来自容器外（编辑区 / 弹层）→ 事件委托直接忽略，编辑区 Delete 照旧删字
  const items = makeItems(2, '.chapter-item');
  const container = makeContainer(items);
  const deleted = [];
  listKeyboard.install({
    container,
    itemSelector: '.chapter-item',
    arrows: true,
    allowDelete: true,
    onDelete: (item, position) => deleted.push(position)
  });
  const outside = { tagName: 'TEXTAREA', closest: () => null };
  container.fire({ type: 'keydown', key: 'Delete', target: outside, preventDefault() {} });
  assert.deepEqual(deleted, [], '容器外的 Delete（编辑区删字）不触发删除章节');
});

test('静态闸门：Delete 删除章节接线（复用 deleteChapterAt，不抄第二份删除逻辑；删后焦点回列表）', () => {
  assert.ok(RENDERER.includes('allowDelete: true'), '章节列表要打开删除键');
  assert.ok(RENDERER.includes('onDelete: (item, position)'), '章节列表要装 onDelete');
  assert.ok(RENDERER.includes('void deleteChapterAt(position)'), 'Delete 必须复用现成的 deleteChapterAt');
  assert.ok(RENDERER.includes('if (deleted) focusChapterAfterDelete(position)'), '删完把焦点放回列表（不掉回 body）');
  assert.ok(RENDERER.includes('function focusChapterAfterDelete('), '焦点归位 helper 要在渲染层');
  assert.equal(
    (RENDERER.match(/allowDelete: true/g) || []).length,
    1,
    '只许章节列表打开删除键（书架书卡不许有删除语义）'
  );
  const at = RENDERER.indexOf('allowDelete: true');
  const seg = RENDERER.slice(at, RENDERER.indexOf('onActivate: (item) => switchChapter', at));
  assert.ok(seg.length > 0);
  assert.equal(seg.includes('openModal'), false, 'Delete 不许自己再实现一套确认框（必须走 deleteChapterAt）');
  assert.equal(seg.includes('删除章节'), false, '确认框文案只在 deleteChapterAt 里，不许复制');
});

// ---------- Ctrl+PageUp/PageDown 切章（U-D12） ----------

test('U-D12：Ctrl+PageUp/PageDown 算相邻章，首尾不绕回、坏参数收敛', () => {
  assert.equal(listKeyboard.chapterSwitchTarget(1, 'PageDown', 3), 2);
  assert.equal(listKeyboard.chapterSwitchTarget(1, 'PageUp', 3), 0);
  assert.equal(listKeyboard.chapterSwitchTarget(0, 'PageUp', 3), -1, '首章 PageUp 不绕到末章');
  assert.equal(listKeyboard.chapterSwitchTarget(2, 'PageDown', 3), -1, '末章 PageDown 不绕回首章');
  assert.equal(listKeyboard.chapterSwitchTarget(0, 'PageDown', 1), -1, '只有一章时两个方向都不动');
  assert.equal(listKeyboard.chapterSwitchTarget(0, 'PageDown', 2), 1);
  assert.equal(listKeyboard.chapterSwitchTarget(0, 'Enter', 3), -1, '不认识的键不接管');
  assert.equal(listKeyboard.chapterSwitchTarget(0, 'ArrowDown', 3), -1);
  assert.equal(listKeyboard.chapterSwitchTarget(0, 'PageUp', 0), -1, '空书没有可切的地方');
  assert.equal(listKeyboard.chapterSwitchTarget(0, 'PageDown', NaN), -1);
  assert.equal(listKeyboard.chapterSwitchTarget(NaN, 'PageDown', 3), -1, '坏下标不猜（不夹到首 / 末章）');
  assert.equal(listKeyboard.chapterSwitchTarget(-1, 'PageDown', 3), -1);
  assert.equal(listKeyboard.chapterSwitchTarget(3, 'PageUp', 3), -1, '越界下标同样不猜');
  assert.equal(listKeyboard.chapterSwitchTarget(2.7, 'PageUp', 3), 1, '小数下标按整数算');
});

test('静态闸门：Ctrl+PageUp/PageDown 切章接线（复用 switchChapter，不新增保存语义；只在写作页）', () => {
  assert.ok(RENDERER.includes('listKeyboard.chapterSwitchTarget('), '相邻章由 list-keyboard 的纯函数算');
  assert.equal(
    (RENDERER.match(/chapterSwitchTarget\(/g) || []).length,
    1,
    '渲染层只调一次（切章逻辑只有一份，模块里定义）'
  );
  const at = RENDERER.indexOf("event.key === 'PageUp'");
  assert.ok(at > 0, '全局 keydown 要认 PageUp');
  const seg = RENDERER.slice(at, at + 1200);
  assert.ok(seg.includes("event.key === 'PageDown'"), '也要认 PageDown');
  assert.ok(seg.includes('state.view !=='), '只在写作页接管（书架 / 阅读页不切章）');
  assert.ok(seg.includes('state.bookPath'), '没打开书时不接管');
  assert.ok(seg.includes('event.preventDefault()'), '接管了键就要拦浏览器的默认行为');
  assert.ok(seg.includes('state.loading'), '上一次切章还在读盘时不叠第二趟');
  assert.ok(
    seg.includes('switchChapter(target)'),
    '切章必须复用 shelf-ui 的 switchChapter（未保存询问 / 保存 / 读盘都在里面）'
  );
  assert.equal(seg.includes('saveCurrent('), false, '不许在这里自己保存：保存语义只在 switchChapter 里');
  assert.equal(seg.includes('askUnsaved('), false, '不许自己再写一套未保存询问');
  assert.equal(seg.includes('loadChapterAt('), false, '不许绕过 switchChapter 直接加载正文');
  assert.ok(RENDERER.includes('function focusChapterAfterSwitch('), '切章后焦点归位 helper 要在渲染层');
  const focusAt = RENDERER.indexOf('function focusChapterAfterSwitch(');
  const focusSeg = RENDERER.slice(focusAt, focusAt + 700);
  assert.ok(
    focusSeg.includes("closest('#chapter-list')"),
    '只有焦点本来就在章节列表里才挪焦点（不许从编辑区抢走）'
  );
});

// ---------- 容器事件委托（假 DOM） ----------

function makeItems(count, selector) {
  const items = [];
  for (let i = 0; i < count; i += 1) {
    items.push({
      tabIndex: -1,
      dataset: { index: String(i) },
      focused: false,
      scrolled: false,
      matches: (sel) => sel === selector,
      closest(sel) {
        return sel === selector ? this : null;
      },
      focus() {
        // 假 DOM 里只记住「谁拿到了焦点」，并把别人的焦点清掉
        for (const el of items) el.focused = false;
        this.focused = true;
      },
      scrollIntoView() {
        this.scrolled = true;
      }
    });
  }
  return items;
}

function makeContainer(items) {
  const handlers = [];
  return {
    contains: (el) => items.indexOf(el) >= 0,
    querySelectorAll: () => items,
    addEventListener: (type, fn) => handlers.push([type, fn]),
    removeEventListener: (type, fn) => {
      const at = handlers.findIndex(([t, f]) => t === type && f === fn);
      if (at >= 0) handlers.splice(at, 1);
    },
    fire(event) {
      for (const [type, fn] of handlers) if (type === event.type) fn(event);
    },
    handlerCount: () => handlers.length
  };
}

test('键盘可达：容器委托——Enter 激活条目、方向键移焦点并把 roving 跟着挪', () => {
  const items = makeItems(3, '.chapter-item');
  const container = makeContainer(items);
  const activated = [];
  const moved = [];
  const inst = listKeyboard.install({
    container,
    itemSelector: '.chapter-item',
    arrows: true,
    onActivate: (item) => activated.push(item.dataset.index),
    onMove: (item) => moved.push(item.dataset.index)
  });
  let prevented = 0;
  const send = (target, name) =>
    container.fire({ type: 'keydown', key: name, target, preventDefault: () => (prevented += 1) });

  send(items[1], 'Enter');
  assert.deepEqual(activated, ['1'], 'Enter 激活当前聚焦的条目');
  assert.equal(prevented, 1, '接管了就要 preventDefault（避免空格滚页面）');

  send(items[1], 'ArrowDown');
  assert.equal(items[2].focused, true, '焦点move 到下一项');
  assert.deepEqual(items.map((el) => el.tabIndex), [-1, -1, 0], 'roving 跟着新焦点');
  assert.deepEqual(moved, ['2']);
  assert.equal(items[2].scrolled, true, '移动后滚进可视区');

  send(items[0], 'End');
  assert.equal(items[2].focused, true, 'End 跳到最后一个');
  send(items[2], 'Home');
  assert.equal(items[0].focused, true, 'Home 回到第一个');
  send(items[0], 'ArrowUp');
  assert.equal(items[0].focused, true, '到头夹住');

  send(items[0], 'a');
  assert.equal(activated.length, 1, '普通字母键不激活');
  inst.destroy();
  assert.equal(container.handlerCount(), 0, 'destroy 摘掉监听');
});

test('键盘可达：焦点在条目里的按钮上时不抢（卡片里的「⋯」自己响应 Enter）', () => {
  const items = makeItems(2, '.book-card');
  const container = makeContainer(items);
  const activated = [];
  listKeyboard.install({ container, itemSelector: '.book-card', onActivate: (el) => activated.push(el) });
  // 焦点在卡片里的按钮上：event.target 是那个按钮（不等于卡片本身）
  const nested = { closest: (sel) => (sel === '.book-card' ? items[0] : null), tagName: 'BUTTON' };
  let preventedNested = 0;
  container.fire({ type: 'keydown', key: 'Enter', target: nested, preventDefault: () => (preventedNested += 1) });
  assert.deepEqual(activated, [], '卡片不该替里面的按钮做激活');
  assert.equal(preventedNested, 0, '也不许 preventDefault——否则按钮的 Enter 激活会被拦掉（E2E 抓到的真 bug）');
  container.fire({ type: 'keydown', key: ' ', target: items[0], preventDefault() {} });
  assert.equal(activated.length, 1, '空格能在卡片本身上打开书');
});

test('键盘可达：没开方向键导航时，方向键既不 preventDefault 也不移焦点', () => {
  const items = makeItems(3, '.book-card');
  const container = makeContainer(items);
  const moved = [];
  listKeyboard.install({ container, itemSelector: '.book-card', onActivate() {}, onMove: (el) => moved.push(el) });
  let prevented = 0;
  container.fire({ type: 'keydown', key: 'ArrowDown', target: items[0], preventDefault: () => (prevented += 1) });
  assert.equal(prevented, 0);
  assert.deepEqual(moved, []);
  assert.equal(items[1].focused, false);
});

test('键盘可达：事件委托只认容器里的条目，指向别处的 target 不理', () => {
  const items = makeItems(2, '.chapter-item');
  const container = makeContainer(items);
  let called = 0;
  listKeyboard.install({ container, itemSelector: '.chapter-item', arrows: true, onActivate: () => (called += 1) });
  container.fire({ type: 'keydown', key: 'Enter', target: { closest: () => null }, preventDefault() {} });
  assert.equal(called, 0);
  const outside = { closest: () => ({ dataset: { index: '0' } }) };
  container.fire({ type: 'keydown', key: 'Enter', target: outside, preventDefault() {} });
  assert.equal(called, 0, '不在容器里的条目（例如别处的同名元素）不算');
});

// ---------- 静态闸门 ----------

test('静态闸门：index.html 在 renderer.js 之前加载 list-keyboard.js，且只加载一次', () => {
  const at = INDEX.indexOf('renderer/list-keyboard.js'.replace('renderer/', ''));
  assert.ok(at > 0, 'index.html 必须加载 list-keyboard.js');
  const rendererAt = INDEX.indexOf('src="renderer.js"');
  assert.ok(at < rendererAt, 'list-keyboard.js 要在 renderer.js 之前加载');
  assert.equal(INDEX.split('list-keyboard.js').length - 1, 1, '只许引一次');
});

test('静态闸门：渲染层用模块接线，不许自己再抄一套键盘处理', () => {
  assert.ok(RENDERER.includes('window.CWListKeyboard'), '渲染层必须拿模块');
  assert.ok(
    /listKeyboard\.install\(\{[^}]*chapter-list/.test(RENDERER) ||
      RENDERER.includes("container: $('chapter-list')"),
    '章节列表要挂到容器上（事件委托）'
  );
  assert.ok(RENDERER.includes("container: $('book-grid')"), '书架书卡要挂到容器上');
  assert.ok(
    RENDERER.includes("itemSelector: '.book-card[data-path]'"),
    '只认真正的书卡——同一张网格里的「＋ 新建一本书」是原生按钮，不能被拦'
  );
  // 章节条目 / 书卡都要真的可聚焦，并且带无障碍名称与角色
  assert.ok(RENDERER.includes('item.tabIndex = index === state.index ? 0 : -1'), '章节条目要参与 roving');
  assert.ok(RENDERER.includes("item.setAttribute('role', 'button')"), '章节条目要有按钮角色');
  assert.ok(RENDERER.includes('item.setAttribute(\'aria-label\', `打开${chapterTitle(index, chapter.name)}`)'));
  assert.ok(BOOKINFO_UI.includes('card.tabIndex = 0'), '书卡要可聚焦');
  assert.ok(BOOKINFO_UI.includes("card.setAttribute('aria-label', `打开《${book.title}》`)"));
  assert.ok(RENDERER.includes('next.tabIndex = 0'), '切章快路径要把 Tab 停留点跟着挪');
  assert.ok(RENDERER.includes("listKeyboard.ensureTabStop(list, '.chapter-item')"));
});

test('静态闸门：F2 重命名接线（全局 keydown + 右键菜单键帽 + 键帽靠右布局）', () => {
  assert.match(RENDERER, /event\.key === 'F2'/, '渲染层要接 F2');
  assert.ok(
    RENDERER.includes('listKeyboard.isTypingTarget(document.activeElement, editorEl)'),
    '焦点在别的输入框里时不抢（编辑区自己除外）'
  );
  assert.ok(
    RENDERER.includes('listKeyboard.renameTargetIndex(document.activeElement, state.chapters.length, state.index)'),
    '改哪一条交给纯逻辑按焦点算'
  );
  assert.ok(
    RENDERER.includes('void renameChapterAt(target)'),
    'F2 必须复用现成的 renameChapterAt（不许抄第二份改名逻辑）'
  );
  assert.match(
    INDEX,
    /<button type="button" data-action="rename" title="重命名本章（F2）">重命名<span class="kbd">F2<\/span><\/button>/,
    '右键菜单的重命名条目要有 F2 键帽（否则只有文档里才知道这个快捷键）'
  );
  assert.match(STYLES, /\.context-menu button \{[^}]*display: flex/s, '文字在左 / 键帽在右要用 flex 布局');
  assert.ok(STYLES.includes('.context-menu button .kbd'), '键帽不许被按钮压缩');
});

test('静态闸门：Alt+↑/↓ 章节上移 / 下移接线（列表接管、卷内 / 跨卷都走现成写盘、焦点回到这一章）', () => {
  assert.ok(RENDERER.includes('onAltMove: (item, position, direction)'), '章节列表要装 onAltMove');
  assert.ok(
    RENDERER.includes('dragSortUiModule.stepMoveTarget(state.chapters, index, direction, chapterVolumeId)'),
    '目标计算走纯逻辑（同卷相邻才给目标）'
  );
  assert.ok(RENDERER.includes('await moveChapterByDrag(index, target.toIndex)'), '移动复用现成的 moveChapterByDrag（不抄第二份写盘）');
  assert.ok(RENDERER.includes('focusChapterById(chapter.id)'), '移动后焦点回到同一章（连按才走得动）');
  assert.ok(read('renderer/drag-sort-ui.js').includes('function stepMoveTarget'), '纯逻辑实现留在拖拽模块');
  // U-D1：卷边界上的 Alt+↑/↓ 跨到相邻的一个卷 —— 目标由 core 纯逻辑算，写盘复用拖拽那条；
  // 1.4.0 P0-2 起跨卷**不再弹确认框**（直接执行 + 10 秒撤销）；不许在渲染层抄第二份
  // 「改卷归属 / 重排顺序」的代码。
  assert.ok(
    RENDERER.includes('chaptersLib.crossVolumeTarget(state.meta, index, direction)'),
    '跨卷目标走 core/chapters.js 的 crossVolumeTarget（纯逻辑，可单测）'
  );
  assert.ok(!RENDERER.includes("title: '跨卷移动'"), '1.4.0 P0-2：跨卷不再弹确认框（撤销优先于确认）');
  assert.ok(
    RENDERER.includes('已把「') && RENDERER.includes('移到「${toVolume}」'),
    '跨卷移动要登记 10 秒撤销（撤销条文案说清挪到哪一卷）'
  );
  assert.ok(
    RENDERER.includes('await moveChapterByDrop(chapter, {') &&
      RENDERER.includes('volumeId: cross.volumeId') &&
      RENDERER.includes('beforeChapterId: cross.beforeChapterId'),
    '跨卷写盘复用拖拽的 moveChapterByDrop（不抄第二份 IPC / 刷新逻辑）'
  );
  assert.ok(
    read('core/chapters.js').includes('function crossVolumeTarget'),
    '跨卷内核在 core/chapters.js（只改书目顺序与卷归属，不碰正文）'
  );
});

test('静态闸门：模块只碰键盘 / 焦点，不许碰鼠标事件、定时器、文件与 Electron', () => {
  const source = read('renderer/list-keyboard.js');
  for (const forbidden of ['setTimeout', 'setInterval', 'requestAnimationFrame', 'require(', 'electron', 'node:fs', 'innerHTML']) {
    assert.equal(source.includes(forbidden), false, `list-keyboard.js 不许出现 ${forbidden}`);
  }
  for (const mouse of ["'click'", "'mousedown'", "'dblclick'", "'contextmenu'", "'pointerdown'", "'pointerup'"]) {
    assert.equal(source.includes(mouse), false, `键盘模块不许接管鼠标事件（${mouse}）`);
  }
  assert.ok(source.includes("addEventListener('keydown'"), '唯一的入口是容器的 keydown');
});

test('静态闸门：17 个弹层都有无障碍名称（标题 id + aria-labelledby），且指向真标题', () => {
  const backdrops = [...INDEX.matchAll(/<div id="([a-z-]+-backdrop)" class="backdrop/g)].map((m) => m[1]);
  // 1.4.0 P0-3：新增 #command-backdrop（命令面板 Ctrl+K），14 → 15
  // 1.5.0 功能-4：新增 #shortcuts-backdrop（`?` 快捷键一览），15 → 16
  // 1.6.0 F5：新增 #group-manage-backdrop（书架分组改名 / 合并），16 → 17
  assert.equal(backdrops.length, 17, '弹层数量变了就要同步这条测试');
  for (const id of backdrops) {
    const start = INDEX.indexOf(`<div id="${id}"`);
    const seg = INDEX.slice(start, start + 5000);
    const dialog = /<div class="[^"]*modal[^"]*" role="dialog"([^>]*)>/.exec(seg);
    assert.ok(dialog, `${id} 里的 role="dialog" 不见了`);
    const labelledby = /aria-labelledby="([^"]+)"/.exec(dialog[1]);
    assert.ok(labelledby, `${id} 的弹层必须挂 aria-labelledby（读屏进弹层要报名字）`);
    const title = new RegExp(`<h2[^>]*id="${labelledby[1]}"[^>]*>[^<]*</h2>`).exec(seg);
    assert.ok(title, `${id} 的 aria-labelledby 指向了不存在的 ${labelledby[1]}`);
  }
});

// ---------- 分卷标题行（v0.9 A-5c） ----------

function makeVolumeRow(id, collapsed = false) {
  const classes = new Set(['volume-item']);
  if (collapsed) classes.add('collapsed');
  const row = {
    dataset: { volumeId: id },
    tabIndex: -1,
    focused: false,
    clicks: 0,
    attrs: {},
    classList: {
      contains: (name) => classes.has(name),
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name)
    },
    setAttribute(name, value) { row.attrs[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(row.attrs, name) ? row.attrs[name] : null; },
    click() { row.clicks += 1; },
    focus() { row.focused = true; },
    closest(selector) { return selector === '.volume-item' ? row : null; }
  };
  return row;
}

function makeVolumeContainer(rows) {
  const handlers = [];
  const container = {
    rows,
    querySelectorAll: () => container.rows,
    contains: (el) => container.rows.indexOf(el) >= 0,
    addEventListener: (type, fn) => handlers.push([type, fn]),
    removeEventListener: (type, fn) => {
      const at = handlers.findIndex(([t, f]) => t === type && f === fn);
      if (at >= 0) handlers.splice(at, 1);
    },
    fire: (event) => {
      for (const [type, fn] of handlers) if (type === event.type) fn(event);
    },
    handlerCount: () => handlers.length
  };
  return container;
}

test('分卷键盘：标题行补成可聚焦的按钮，并报告折叠状态', () => {
  const rows = [makeVolumeRow('v1'), makeVolumeRow('v2', true)];
  const container = makeVolumeContainer(rows);
  const inst = listKeyboard.installVolumeHeaders({ container, MutationObserver: null });
  assert.deepEqual(rows.map((row) => row.tabIndex), [0, 0], '两条都 Tab 得到（以前 tabIndex -1）');
  assert.deepEqual(rows.map((row) => row.attrs.role), ['button', 'button']);
  assert.deepEqual(rows.map((row) => row.attrs['aria-expanded']), ['true', 'false'], '折叠状态读 class');
  inst.destroy();
});

test('分卷键盘：Enter / 空格激活原来的 click（不抄第二份折叠逻辑），列表重建后焦点回到同一卷', () => {
  const first = [makeVolumeRow('v1'), makeVolumeRow('v2')];
  const container = makeVolumeContainer(first);
  const observers = [];
  class FakeMO {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
    trigger() { this.cb(); }
  }
  const inst = listKeyboard.installVolumeHeaders({ container, MutationObserver: FakeMO });
  assert.equal(container.handlerCount(), 1, '只挂一个 keydown（不碰鼠标）');

  let prevented = 0;
  container.fire({ type: 'keydown', key: 'Enter', target: first[0], preventDefault: () => (prevented += 1) });
  assert.equal(first[0].clicks, 1, '激活走原来的 click 处理');
  assert.equal(prevented, 1, '拦住 Enter 的默认行为');

  // 折叠会重建整张列表：旧行没了，新行是同名的新对象
  const rebuilt = [makeVolumeRow('v1', true), makeVolumeRow('v2')];
  container.rows = rebuilt;
  observers[0].trigger();
  assert.equal(rebuilt[0].focused, true, '焦点回到同一卷的标题行（不是丢到 body）');
  assert.equal(rebuilt[0].attrs['aria-expanded'], 'false', '重建后折叠状态同步');
  assert.equal(rebuilt[0].tabIndex, 0);

  container.fire({ type: 'keydown', key: ' ', target: rebuilt[1], preventDefault() {} });
  assert.equal(rebuilt[1].clicks, 1, '空格也能折叠 / 展开');
  assert.equal(rebuilt[0].clicks, 0, '别的卷不被带着点一下');

  container.fire({ type: 'keydown', key: 'a', target: rebuilt[0], preventDefault() {} });
  assert.equal(rebuilt[0].clicks, 0, '普通按键不激活');
  inst.destroy();
  assert.equal(container.handlerCount(), 0, 'destroy 摘掉监听');
  assert.equal(observers[0].disconnected, true, 'destroy 断开观察者');
});

test('分卷键盘：折叠后没有同名卷时不乱抢焦点（保持浏览器默认）', () => {
  const rows = [makeVolumeRow('v1')];
  const container = makeVolumeContainer(rows);
  class FakeMO {
    constructor(cb) { this.cb = cb; }
    observe() {}
    disconnect() {}
    trigger() { this.cb(); }
  }
  const inst = listKeyboard.installVolumeHeaders({ container, MutationObserver: FakeMO });
  inst.refocus();
  assert.equal(rows[0].focused, false, '没有待恢复的卷时不动焦点');
  inst.destroy();
});

// ---------- 1.6.0 F1：Shift+↑/↓ 扩选（键盘多选二期） ----------
// 列表只负责把焦点挪到相邻条目并回报「从哪到哪」，选中范围怎么算留在 chapter-selection.js。
// 书架（没装 onExtend）一个字都不碰。

test('键盘可达：Shift+↑/↓ 扩选——装了 onExtend 时移焦点并回报相邻下标，不再走普通 onMove', () => {
  const items = makeItems(3, '.chapter-item');
  const container = makeContainer(items);
  const extended = [];
  const moved = [];
  const inst = listKeyboard.install({
    container,
    itemSelector: '.chapter-item',
    arrows: true,
    onMove: (el) => moved.push(el.dataset.index),
    onExtend: (item, from, target, to) => extended.push([from, to, target.dataset.index])
  });
  let prevented = 0;
  const send = (target, name, extra) =>
    container.fire({
      type: 'keydown',
      key: name,
      shiftKey: true,
      target,
      preventDefault: () => (prevented += 1),
      ...(extra || {})
    });

  send(items[0], 'ArrowDown');
  assert.deepEqual(extended, [[0, 1, '1']], 'Shift+↓ 回报「0 → 1」，不猜范围');
  assert.equal(items[1].focused, true, '焦点跟着扩选挪到下一章');
  assert.deepEqual(items.map((el) => el.tabIndex), [-1, 0, -1], 'roving tabindex 跟着焦点');
  assert.equal(items[1].scrolled, true, '扩到的条目滚进可视区');
  assert.deepEqual(moved, [], '扩选不触发普通 onMove（宿主不用把「移焦点」当切章）');
  assert.equal(prevented, 1, '接管了 Shift+方向键就 preventDefault');

  send(items[1], 'ArrowDown');
  assert.deepEqual(extended[1], [1, 2, '2']);
  send(items[2], 'ArrowDown');
  assert.equal(extended.length, 2, '末条再按 Shift+↓ 不回报（焦点不动）');
  send(items[0], 'ArrowUp');
  assert.equal(extended.length, 2, '首条 Shift+↑ 也不回报');
  // Ctrl+Shift / Alt+Shift 是别的含义，列表不接管
  send(items[0], 'ArrowDown', { ctrlKey: true });
  send(items[0], 'ArrowDown', { altKey: true });
  assert.equal(extended.length, 2);
  inst.destroy();
});

test('键盘可达：没装 onExtend（书架书卡）时 Shift+↑/↓ 一个字都不碰', () => {
  const items = makeItems(3, '.book-card');
  const container = makeContainer(items);
  const inst = listKeyboard.install({ container, itemSelector: '.book-card', arrows: true });
  let prevented = 0;
  container.fire({
    type: 'keydown',
    key: 'ArrowDown',
    shiftKey: true,
    target: items[0],
    preventDefault: () => (prevented += 1)
  });
  assert.equal(prevented, 0, '没装 onExtend 就不拦默认行为');
  assert.equal(items[1].focused, false, '焦点也不动');
  assert.deepEqual(items.map((el) => el.tabIndex), [-1, -1, -1]);
  inst.destroy();
});

test('静态闸门：Shift 扩选 / Ctrl+A 全选接在纯模型上，批量条有 aria-live 播报', () => {
  assert.ok(RENDERER.includes('onExtend:'), '章节列表 install 要装 onExtend');
  const extendAt = RENDERER.indexOf('onExtend:');
  const extendSeg = RENDERER.slice(extendAt, extendAt + 900);
  assert.ok(extendSeg.includes('chapterSelectionLib.extendFocus('), '扩选必须走纯模型的 extendFocus');
  assert.equal(extendSeg.includes('state.selectedIds.add('), false, '不许在渲染层自己算范围');
  assert.equal(extendSeg.includes('slice('), false, '不许在渲染层自己切片');
  const ctrlAt = RENDERER.indexOf("String(event.key).toLowerCase() === 'a'");
  assert.ok(ctrlAt > 0, '全局 keydown 要认 Ctrl+A');
  const ctrlSeg = RENDERER.slice(ctrlAt, ctrlAt + 900);
  assert.ok(ctrlSeg.includes("closest('#chapter-list')"), '只在焦点位于章节列表时接管');
  assert.ok(ctrlSeg.includes('chapterSelectionLib.selectAll('), '全选必须走纯模型的 selectAll');
  assert.ok(
    INDEX.includes('id="chapter-batch-count"') && /id="chapter-batch-count"[^>]*aria-live="polite"/.test(INDEX),
    '「已选 N 章」要有 aria-live="polite" 播报'
  );
  // 列表只在有 onExtend 时接管 Shift+方向键，书架不受影响
  assert.ok(read('renderer/list-keyboard.js').includes('onExtend'), 'list-keyboard 要有 onExtend 钩子');
});
