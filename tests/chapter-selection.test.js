// 1.5.0 功能-1：章节多选的选择模型（renderer/chapter-selection.js）。
//
// 多选只有四种点法，全部收敛到这个纯模块里：
//   普通单击（清空 + 切章由渲染层做）、Ctrl+单击（toggle）、Shift+单击（extendTo）、
//   点空白 / Esc（clear）。这里钉住「toggle 加/减 + anchor 移动」「Shift 从当前章起算」
//   「anchor 被删后回落到当前章」「并集连选」「按目录顺序取已选 id」和坏输入不炸。
// DOM / 批量动作 / 撤销链路在 E2E 第 78 组里真跑。
const test = require('node:test');
const assert = require('node:assert/strict');
const selection = require('../renderer/chapter-selection.js');

const order = ['a', 'b', 'c', 'd', 'e'];
const asArray = (sel) => Array.from(sel.ids).sort();

test('toggle（Ctrl+单击）：没选中就加入、再次点击移出，anchor 始终落到这一章', () => {
  let sel = selection.createSelection();
  sel = selection.toggle(sel, 'b');
  assert.deepEqual(asArray(sel), ['b']);
  assert.equal(sel.anchorId, 'b');
  sel = selection.toggle(sel, 'd');
  assert.deepEqual(asArray(sel), ['b', 'd']);
  assert.equal(sel.anchorId, 'd', 'anchor 跟着最后一次单击走');
  sel = selection.toggle(sel, 'b');
  assert.deepEqual(asArray(sel), ['d'], '再点一次取消这一章');
  assert.equal(sel.anchorId, 'b', 'anchor 仍停在最后点的那一章（起点不因为取消选中而丢）');
  assert.equal(selection.isSelected(sel, 'd'), true);
  assert.equal(selection.isSelected(sel, 'b'), false);
});

test('toggle 是纯函数：不改入参，返回新的 Set', () => {
  const base = { ids: new Set(['a']), anchorId: 'a' };
  const next = selection.toggle(base, 'b');
  assert.deepEqual(Array.from(base.ids), ['a'], '入参没被改');
  assert.notEqual(next.ids, base.ids, '返回的是新 Set');
  assert.deepEqual(asArray(next), ['a', 'b']);
});

test('extendTo（Shift+单击）：没有 anchor 时从当前章（fallback）起算，范围连选', () => {
  let sel = selection.createSelection();
  sel = selection.extendTo(sel, order, 'd', 'b');
  assert.deepEqual(asArray(sel), ['b', 'c', 'd'], 'anchor 失效 + 没有历史 anchor → 当前章 b 到 d');
  assert.equal(sel.anchorId, 'b', 'anchor 落到回落的当前章');
});

test('extendTo：有 anchor 时从 anchor 到目标连选，并保留 Ctrl 点出来的其它章（并集）', () => {
  let sel = selection.createSelection();
  sel = selection.toggle(sel, 'a');
  sel = selection.toggle(sel, 'b');
  assert.equal(sel.anchorId, 'b');
  sel = selection.extendTo(sel, order, 'd', 'a');
  assert.deepEqual(asArray(sel), ['a', 'b', 'c', 'd']);
  assert.equal(sel.anchorId, 'b', '起点仍是 b，不跟着目标跑');
  // 再往回拉：范围缩回 b..c，但 d 是上一轮连选出来的，并集不把它误删
  sel = selection.extendTo(sel, order, 'c', 'a');
  assert.deepEqual(asArray(sel), ['a', 'b', 'c', 'd'], '往回拉范围也是并集，不误删已选中的章');
  assert.equal(sel.anchorId, 'b', '来回拉范围也不改起点');
  // Ctrl 取消 d 之后 anchor 落到 d（最后一次单击的那一章）；这时 Shift 拉 c 会把 d 重新并进来
  sel = selection.toggle(sel, 'd');
  assert.deepEqual(asArray(sel), ['a', 'b', 'c']);
  sel = selection.extendTo(sel, order, 'c', 'a');
  assert.deepEqual(asArray(sel), ['a', 'b', 'c', 'd'], 'anchor 停在刚点过的 d，连选从 d 起算');
});

test('extendTo：anchor 在章节数组里已被删掉（失效）→ 回落到当前章', () => {
  const sel = { ids: new Set(['a']), anchorId: 'zzz' };
  const next = selection.extendTo(sel, order, 'e', 'c');
  assert.deepEqual(asArray(next), ['a', 'c', 'd', 'e']);
  assert.equal(next.anchorId, 'c');
});

test('extendTo：anchor 和当前章都不在数组里 → 只选目标，anchor 落到目标（还能继续拉）', () => {
  const sel = { ids: new Set(), anchorId: 'gone' };
  const next = selection.extendTo(sel, order, 'c', 'also-gone');
  assert.deepEqual(asArray(next), ['c']);
  assert.equal(next.anchorId, 'c');
});

test('extendTo：目标章不在数组里时原样返回（不制造空选择 / 不抛）', () => {
  const sel = selection.toggle(selection.createSelection(), 'a');
  const next = selection.extendTo(sel, order, 'nope', 'b');
  assert.deepEqual(asArray(next), ['a']);
  assert.equal(next.anchorId, 'a');
});

test('普通单击等价于 clear：空集合、无 anchor', () => {
  const cleared = selection.clear();
  assert.equal(cleared.ids.size, 0);
  assert.equal(cleared.anchorId, null);
});

test('prune：章节数组换了以后丢掉已不存在的 id；全空时 anchor 一起清', () => {
  const sel = { ids: new Set(['a', 'gone', 'c']), anchorId: 'gone' };
  const kept = selection.prune(sel, order);
  assert.deepEqual(asArray(kept), ['a', 'c']);
  assert.equal(kept.anchorId, null, '指向已删除章的 anchor 清理掉');
  const empty = selection.prune({ ids: new Set(['x']), anchorId: 'x' }, order);
  assert.equal(empty.ids.size, 0);
  assert.equal(empty.anchorId, null);
});

test('idsInOrder：按目录顺序而不是点击顺序返回已选 id', () => {
  let sel = selection.createSelection();
  sel = selection.toggle(sel, 'd');
  sel = selection.toggle(sel, 'a');
  sel = selection.toggle(sel, 'c');
  assert.deepEqual(selection.idsInOrder(sel, order), ['a', 'c', 'd']);
  assert.deepEqual(selection.idsInOrder(selection.clear(), order), []);
});

test('坏输入：null / 非数组 order / 空 id / 重复 id 都不抛，返回可用的空选择', () => {
  assert.equal(selection.count(null), 0);
  assert.equal(selection.isSelected(null, 'a'), false);
  assert.deepEqual(asArray(selection.toggle(null, '')), [], '空串 id 不入选');
  assert.equal(selection.toggle(null, 'a').anchorId, 'a');
  assert.deepEqual(asArray(selection.extendTo(null, null, 'a', 'b')), []);
  assert.deepEqual(asArray(selection.prune(null, '不是数组')), []);
  assert.deepEqual(selection.idsInOrder(null, order), []);
  // 重复 id 的 order：连选不会重复、也不会因为去重把范围算歪
  const next = selection.extendTo(selection.createSelection(), ['a', 'b', 'b', 'c'], 'c', 'a');
  assert.deepEqual(asArray(next), ['a', 'b', 'c']);
  // 数字 id 统一按字符串比
  const numeric = selection.toggle(selection.createSelection(), 12);
  assert.equal(selection.isSelected(numeric, '12'), true);
});

// ---------- 1.6.0 F1：键盘路径（全选 / 焦点移动 / Shift 扩选） ----------
// 键盘只多三种按键：Ctrl+A 全选、Shift+↑/↓ 从锚点扩选、焦点本身由 list-keyboard 挪。
// 模型仍只算「哪些章选中 + anchor 在哪 + 焦点该落到哪」，键位与 DOM 在 renderer.js 里接线。

test('selectAll（Ctrl+A）：全选目录里这一串，anchor 落到第一条（之后还能继续 Shift 扩）', () => {
  const all = selection.selectAll(order);
  assert.deepEqual(selection.idsInOrder(all, order), order);
  assert.equal(all.anchorId, 'a', 'anchor 落到第一条，Ctrl+A 之后按 Shift+↓ 有起点');
  assert.equal(selection.count(all), 5);
  // 空目录 / 坏输入：给一份可用的空选择，不抛
  assert.equal(selection.count(selection.selectAll([])), 0);
  assert.equal(selection.selectAll([]).anchorId, null);
  assert.equal(selection.selectAll(null).ids.size, 0);
  assert.equal(selection.selectAll('不是数组').ids.size, 0);
  // 重复 id 去重；数字 id 统一成字符串；空串不算一章
  const mixed = selection.selectAll(['a', 'a', 12, '']);
  assert.deepEqual(selection.idsInOrder(mixed, ['a', '12']), ['a', '12']);
  assert.equal(mixed.anchorId, 'a');
});

test('moveFocus：焦点一格一格走、到头夹住；焦点章不在目录里返回 null（不瞎猜）', () => {
  assert.equal(selection.moveFocus(order, 'b', 1), 'c');
  assert.equal(selection.moveFocus(order, 'b', -1), 'a');
  assert.equal(selection.moveFocus(order, 'a', -1), 'a', '第一条往上不绕回');
  assert.equal(selection.moveFocus(order, 'e', 1), 'e', '最后一条往下不绕回');
  assert.equal(selection.moveFocus(order, 'e', -2), 'c', '一次挪多格也夹在两端之间');
  assert.equal(selection.moveFocus(order, 'b', 0), 'b', 'step 0 原地不动');
  assert.equal(selection.moveFocus(order, 'zzz', 1), null, '焦点章不在目录里时返回 null，由调用方当没这回事');
  assert.equal(selection.moveFocus(order, null, 1), null);
  assert.equal(selection.moveFocus([], 'a', 1), null);
  assert.equal(selection.moveFocus('不是数组', 'a', 1), null);
});

test('extendFocus（Shift+↓）：首按从焦点章起算，之后从同一 anchor 并集扩，焦点跟着走', () => {
  const first = selection.extendFocus(selection.createSelection(), order, 'a', 1);
  assert.deepEqual(selection.idsInOrder(first, order), ['a', 'b']);
  assert.equal(first.focusId, 'b', '焦点落到扩到的这一章');
  assert.equal(first.anchorId, 'a', 'anchor 停在按下 Shift 前焦点那一章');
  const second = selection.extendFocus(first, order, first.focusId, 1);
  assert.deepEqual(selection.idsInOrder(second, order), ['a', 'b', 'c']);
  assert.equal(second.focusId, 'c');
  assert.equal(second.anchorId, 'a', 'anchor 不跟着焦点跑（再按还能往回想）');
  // Shift+↑ 往回：并集不误删已经选中的章（与鼠标 Shift 连选同一口径）
  const back = selection.extendFocus(second, order, second.focusId, -1);
  assert.deepEqual(selection.idsInOrder(back, order), ['a', 'b', 'c'], '往回缩也不清掉已选中的 c');
  assert.equal(back.focusId, 'b');
  assert.equal(back.anchorId, 'a');
  // Ctrl+Space 点出来的单独一章就是 anchor（不需要 anchor 失效回落）
  const toggled = selection.toggle(selection.createSelection(), 'd');
  const fromToggle = selection.extendFocus(toggled, order, 'd', -1);
  assert.deepEqual(selection.idsInOrder(fromToggle, order), ['c', 'd']);
  assert.equal(fromToggle.focusId, 'c');
  assert.equal(fromToggle.anchorId, 'd');
});

test('extendFocus 边界：末条按 Shift+↓ 焦点不动、选择不炸；坏焦点 / 空目录收敛', () => {
  const atEnd = selection.extendFocus({ ids: new Set(['e']), anchorId: 'e' }, order, 'e', 1);
  assert.equal(atEnd.focusId, 'e', '已经到末条：焦点停在原地');
  assert.deepEqual(selection.idsInOrder(atEnd, order), ['e'], '选择原样，不制造越界 id');
  const noFocus = selection.extendFocus(selection.createSelection(), order, 'zzz', 1);
  assert.equal(noFocus.focusId, null);
  assert.equal(noFocus.ids.size, 0, '焦点章不在目录里：不扩选');
  const empty = selection.extendFocus(selection.createSelection(), [], 'a', 1);
  assert.equal(empty.focusId, null);
  assert.equal(empty.ids.size, 0);
  // 纯函数：入参不被改
  const base = { ids: new Set(['a']), anchorId: 'a' };
  selection.extendFocus(base, order, 'a', 1);
  assert.deepEqual(Array.from(base.ids), ['a'], 'extendFocus 不改入参');
});