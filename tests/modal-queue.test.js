'use strict';
// v1.8.0 WP-13（审计 C11）：通用询问框「单实例 + 排队」的纯逻辑单测 + 渲染层接线静态闸门。
//
// 为什么要有：C11 是「外部修改检测与未保存询问并发 → 切章 / 关窗流程永久挂起」。这条链跨三个
// 模块（renderer.js 的 openModal / statusbar-ui.js 的 focus 检测 / 等待弹窗回执的各个 await），
// E2E 黑盒很难稳定复现「两个询问框撞在一起」。排队状态机抽成 renderer/modal-queue.js 之后，
// Node 里可以直接造并发：第一个框没结束前第二个必须排队、两个 Promise 最终都要有结果（不许悬空）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const modalQueue = require('../renderer/modal-queue');

const ROOT = path.join(__dirname, '..');
const RENDERER_DIR = path.join(ROOT, 'renderer');
const read = (name) => fs.readFileSync(path.join(RENDERER_DIR, name), 'utf8');

// 假「画 / 收」：show 把 opts 与 close 回调记下来，测试像作者一样点掉它。
function makeHarness() {
  const shown = [];
  const hidden = [];
  const queue = modalQueue.create({
    show(opts, close) {
      shown.push({ opts, close });
    },
    hide() {
      hidden.push(true);
    }
  });
  return { queue, shown, hidden };
}

test('handlers 契约：null / 缺 show / 缺 hide 都在装配时抛 TypeError', () => {
  assert.throws(() => modalQueue.create(null), /需要 handlers 对象/);
  assert.throws(() => modalQueue.create({}), /缺少 show/);
  assert.throws(() => modalQueue.create({ show() {} }), /缺少 hide/);
  assert.throws(() => modalQueue.create({ hide() {} }), /缺少 show/);
});

test('空闲时 open：立刻显示、Promise 未结束；close 用回执结算，hide 收到一次', async () => {
  const { queue, shown, hidden } = makeHarness();
  let settled = null;
  const promise = queue.open({ title: '第一个', cancelValue: 7 }).then((result) => {
    settled = result;
    return result;
  });

  assert.equal(shown.length, 1, '当前没有框时必须马上画出来');
  assert.equal(shown[0].opts.title, '第一个');
  assert.equal(queue.isOpen(), true);
  assert.equal(queue.pendingCount(), 1);
  await Promise.resolve();
  assert.equal(settled, null, '没点掉之前 Promise 不许结束');

  shown[0].close({ action: 'ok', value: 'v' });
  const result = await promise;
  assert.deepEqual(result, { action: 'ok', value: 'v' });
  assert.deepEqual(shown[0].opts.cancelValue, 7, 'opts 原样交给 show（Esc 取 cancelValue）');
  assert.equal(hidden.length, 1);
  assert.equal(queue.isOpen(), false);
  assert.equal(queue.pendingCount(), 0);
});

test('C11 复现：未保存询问在飞时外部修改检测也要弹框 → 排队，两个 Promise 都有结果（无挂起）', async () => {
  const { queue, shown, hidden } = makeHarness();

  // ① 未保存询问先开（旧代码里这一框的 resolve 会被下一框覆盖掉，等于永久挂起）
  const unsaved = queue.open({ title: '有未保存的修改' });
  // ② 外部修改检测在 await statChapter 期间也来弹框（旧代码：直接覆盖 state.modal）
  const external = queue.open({ title: '检测到外部修改' });

  assert.equal(shown.length, 1, '同一时刻只许画一个框');
  assert.equal(shown[0].opts.title, '有未保存的修改');
  assert.equal(queue.pendingCount(), 2, '第二框在排队，不许被丢掉');

  // ③ 作者先答未保存询问：它必须能正常结束，第二框顶上
  shown[0].close({ action: 'discard' });
  assert.equal(shown.length, 2);
  assert.equal(shown[1].opts.title, '检测到外部修改');
  assert.equal(hidden.length, 1, '换框时先收上一框');

  // ④ 再答外部修改询问
  shown[1].close({ action: 'keep' });
  const [unsavedResult, externalResult] = await Promise.all([unsaved, external]);
  assert.deepEqual(unsavedResult, { action: 'discard' }, '第一框的回执不许丢（C11 的挂起就是这里）');
  assert.deepEqual(externalResult, { action: 'keep' });
  assert.equal(hidden.length, 2);
  assert.equal(queue.isOpen(), false);
});

test('排队按先来后到：第三框排在第二框后面，且 resolve 续体不许插队', async () => {
  const { queue, shown } = makeHarness();
  const order = [];

  const a = queue.open({ title: 'A' }).then(() => {
    order.push('A完成');
    // 第一框的续体里马上又开一框：它必须排到已经排队的 B 后面，不能插队到前面
    queue.open({ title: 'C' }).then(() => order.push('C完成'));
  });
  const b = queue.open({ title: 'B' }).then(() => order.push('B完成'));

  assert.deepEqual(shown.map((x) => x.opts.title), ['A']);
  shown[0].close({ action: 'ok' });
  await Promise.resolve();
  assert.deepEqual(shown.map((x) => x.opts.title), ['A', 'B'], 'B 必须在 A 结束的那一拍顶上');
  assert.deepEqual(order, ['A完成']);

  shown[1].close({ action: 'ok' });
  await Promise.resolve();
  assert.deepEqual(shown.map((x) => x.opts.title), ['A', 'B', 'C'], 'A 续体里新开的 C 排在 B 后面');
  assert.deepEqual(order, ['A完成', 'B完成']);

  shown[2].close({ action: 'ok' });
  await Promise.all([a, b]);
  assert.deepEqual(order, ['A完成', 'B完成', 'C完成']);
});

test('重复 close / 过期回调 / 没有当前框时 close 都是空操作（不会误结束下一框）', async () => {
  const { queue, shown } = makeHarness();
  assert.equal(queue.close({ action: 'ok' }), null, '没有当前框时 close 不许炸');

  const first = queue.open({ title: 'A' });
  const firstClose = shown[0].close;
  firstClose({ action: 'first' });
  firstClose({ action: 'second' }); // 同一个回调点两次：第二次必须被忽略
  assert.deepEqual(await first, { action: 'first' });

  const second = queue.open({ title: 'B' });
  const third = queue.open({ title: 'C' });
  shown[1].close({ action: 'b' }); // 结掉 B，C 顶上
  // B 的过期回调再点一次：不许把已经顶上的 C 结掉
  shown[1].close({ action: 'b-again' });
  assert.equal(queue.isOpen(), true);
  assert.equal(shown.length, 3);
  shown[2].close({ action: 'c' });
  assert.deepEqual(await second, { action: 'b' });
  assert.deepEqual(await third, { action: 'c' });
});

test('缺省回执：close() 不带参数按 { action: null } 结算（与旧 closeModal 一致）', async () => {
  const { queue, shown } = makeHarness();
  const promise = queue.open({ title: '无输入' });
  shown[0].close();
  assert.deepEqual(await promise, { action: null });
});

// ---------- 静态闸门：渲染层接线 / 加载顺序 / UMD ----------

test('静态闸门：renderer.js 的 openModal 走排队状态机，不再直接覆盖 state.modal', () => {
  const rendererSrc = read('renderer.js');
  assert.ok(rendererSrc.includes('const modalQueueModule = window.CWModalQueue;'), '模块引用没了');
  assert.equal(rendererSrc.split('modalQueueModule.create({').length - 1, 1, '排队状态机只许装配一处');
  assert.match(
    rendererSrc,
    /function openModal\(\{ title, message, input, buttons, cancelValue = null \}\) \{\s*return modalQueue\.open\(\{ title, message, input, buttons, cancelValue \}\);/,
    'openModal 必须转发给 modalQueue.open（取消值仍按旧口径默认 null）'
  );
  assert.match(rendererSrc, /function closeModal\(result\) \{\s*modalQueue\.close\(result\);/, 'closeModal 必须走 modalQueue.close');
  // 旧写法 `state.modal = { resolve, opts: {...} }` 是 C11 的根因：全文件只许 show 回调里那一处视图赋值
  assert.equal(rendererSrc.split('state.modal = {').length - 1, 1, 'state.modal 只许在 show 回调里赋值一次（视图）');
  assert.match(rendererSrc, /state\.modal = \{ resolve: close, opts \};/, '当前框视图必须带 resolve 与 opts');
  assert.equal(/state\.modal\.resolve/.test(rendererSrc), false, '排队状态机自己结算，渲染层不许直接 resolve');
});

test('静态闸门：index.html 在 renderer.js 之前加载 modal-queue.js，且只加载一次', () => {
  const indexSrc = read('index.html');
  const at = indexSrc.indexOf('<script src="modal-queue.js"></script>');
  const rendererAt = indexSrc.indexOf('<script src="renderer.js"></script>');
  assert.notEqual(at, -1);
  assert.ok(at < rendererAt, 'modal-queue.js 必须在 renderer.js 之前');
  assert.equal(indexSrc.split('modal-queue.js').length - 1, 1);
});

test('静态闸门：模块不 require / 不摸 Electron·fs·DOM，只做纯状态机', () => {
  const src = read('modal-queue.js');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['require(', 'ipcRenderer', 'node:fs', 'child_process', 'localStorage', 'fetch(', 'process.']) {
    assert.equal(code.includes(forbidden), false, 'modal-queue.js 不许出现 ' + forbidden);
  }
  assert.equal(/document\.|window\.addEventListener/.test(code), false, '模块里不许摸 DOM / 注册监听');
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWModalQueue，且不乱造别的全局', () => {
  const src = read('modal-queue.js');
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(src, context, { filename: 'renderer/modal-queue.js' });
  assert.equal(typeof win.CWModalQueue, 'object');
  assert.deepEqual(Object.keys(win.CWModalQueue), ['create']);
  assert.equal(win.CWFindUi, undefined);
});