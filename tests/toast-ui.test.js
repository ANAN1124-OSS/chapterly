// M1（第一轮·低，第 9 轮第一刀）：提示条出口的**行为**锚点。
//
// 背景：toast() / toastActionable() 以前长在 renderer.js 里（4,598 行），只有 E2E 打字才能看到
// 「8 秒自消失」「点按钮先关再回调」这些行为；静态闸门也只钉了「用 textContent / 只追加」两行。
// 第 9 轮把这一对整段搬进 renderer/toast-ui.js（renderer.js 只保留同名转发），
// 这里用假 DOM + 假定时器把行为逐条钉住，再用机器清单钉「实现只有一份、装配三处到位」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const toastUi = require('../renderer/toast-ui');
const manifest = require('../renderer/assembly-manifest');
const { makeEl, makeIdEl, loadSourceGate } = require('./ui-test-preambles');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// 假 host：一个 #toast-area + 一份只读 state（testMode / toastLog 两个字段）。
function makeHost(options = {}) {
  const area = makeIdEl('toast-area');
  const state = {
    testMode: Boolean(options.testMode),
    toastLog: []
  };
  const doc = { createElement: (tag) => makeEl(tag) };
  const els = new Map([['toast-area', area]]);
  const host = {
    $: (id) => els.get(id) || null,
    state,
    document: doc
  };
  return { host, state, area, doc };
}

function classesOf(el) {
  return el.className.split(/\s+/).filter(Boolean);
}

test('host 契约：$ / state / document 缺任何一个都抛 TypeError，空 host / null 也抛', () => {
  assert.deepEqual([...toastUi.REQUIRED_HOST].sort(), ['$', 'document', 'state']);
  const { host } = makeHost();
  assert.throws(() => toastUi.create(null), /createToastUi 需要 host 对象/);
  assert.throws(() => toastUi.create('x'), /createToastUi 需要 host 对象/);
  for (const key of toastUi.REQUIRED_HOST) {
    const broken = { ...host };
    delete broken[key];
    assert.throws(() => toastUi.create(broken), /缺少/, key);
    assert.throws(() => toastUi.create({ ...host, [key]: null }), /缺少/, key + '（null 也算缺）');
  }
  assert.doesNotThrow(() => toastUi.create(host));
});

test('toast：kind 映射到 class（info / warn / error），文案用 textContent，只往区域里追加', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { host, area } = makeHost();
  const ui = toastUi.create(host);
  ui.toast('已保存');
  ui.toast('读取失败', 'warn');
  ui.toast('保存失败：磁盘已满', 'error');
  assert.equal(area.children.length, 3, '三条提示各追加一条，不重建播报区');
  assert.deepEqual(area.children.map(classesOf), [['toast'], ['toast', 'warn'], ['toast', 'error']]);
  assert.deepEqual(
    area.children.map((el) => el.textContent),
    ['已保存', '读取失败', '保存失败：磁盘已满'],
    '文案原样写进条目（读屏 live region 靠 textContent 播报）'
  );
  assert.equal(area.children.some((el) => el.classList.contains('leaving')), false, '刚追加的条目不淡出');
});

test('toast：3600ms 后加 .leaving 淡出，再过 300ms 移除（数字与 styles.css 同一档）', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // 数字本身是产品契约（读得完一句提示的停留时长）：钉死，改小改大都要单独过审。
  assert.equal(toastUi.TOAST_TTL_MS, 3600, '停留 3.6 秒（E2E 69 组按这个节奏等提示消失）');
  assert.equal(toastUi.TOAST_LEAVE_MS, 300, '淡出后再留 300ms 才摘节点（styles.css 的过渡是 0.16s）');
  const { host, area } = makeHost();
  toastUi.create(host).toast('3.6 秒后淡出');
  const el = area.children[0];
  t.mock.timers.tick(toastUi.TOAST_TTL_MS - 1);
  assert.equal(el.classList.contains('leaving'), false, '不到 3.6s 不淡出');
  t.mock.timers.tick(1);
  assert.equal(el.classList.contains('leaving'), true, '3.6s 到点加 .leaving（CSS 负责 0.16s 过渡）');
  assert.equal(area.children.length, 1, '淡出期间仍在区域里（读屏不会把正在播报的条目抽走）');
  t.mock.timers.tick(toastUi.TOAST_LEAVE_MS - 1);
  assert.equal(area.children.length, 1, '淡出没走完不摘节点');
  t.mock.timers.tick(1);
  assert.equal(area.children.length, 0, '300ms 后移除节点');
});

test('toastActionable：默认 8 秒；带 .toast-action 按钮，点按钮先关提示再执行回调', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { host, area } = makeHost();
  const ui = toastUi.create(host);
  let during = null;
  let calls = 0;
  ui.toastActionable('新复制 1,200 字，要捕获吗？', '捕获', () => {
    calls += 1;
    during = area.children[0].classList.contains('leaving');
  });
  const el = area.children[0];
  assert.deepEqual(classesOf(el), ['toast', 'actionable'], '可点提示的 class 口径不变（E2E 按 .toast.actionable 找）');
  assert.equal(el.children.length, 2, '两段：文案 span + 动作按钮');
  assert.equal(el.children[0].className, 'toast-text');
  assert.equal(el.children[1].className, 'toast-action');
  assert.equal(el.children[1].textContent, '捕获');
  assert.equal(el.children[0].textContent, '新复制 1,200 字，要捕获吗？');
  assert.equal(el.children[1].type, 'button', '真 <button>（键盘可到）');
  el.children[1].fire('click');
  assert.equal(calls, 1, '点一次只回调一次');
  assert.equal(during, true, '先关提示再回调（回调里已经能看到 .leaving）');
  assert.equal(area.children.length, 1, '关闭是淡出，不是立刻摘节点');
  t.mock.timers.tick(toastUi.TOAST_LEAVE_MS);
  assert.equal(area.children.length, 0, '淡出后移除');
  // 点过之后不再被默认时长二次关闭（closed 标记）
  assert.doesNotThrow(() => t.mock.timers.tick(toastUi.ACTIONABLE_DEFAULT_MS));
  assert.equal(calls, 1, '定时器被清掉，不会在 8 秒后重复回调');
});

test('toastActionable：默认 8000ms 自消失，durationMs 钳在 1000–30000', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(toastUi.ACTIONABLE_DEFAULT_MS, 8000);
  assert.equal(toastUi.ACTIONABLE_MIN_MS, 1000);
  assert.equal(toastUi.ACTIONABLE_MAX_MS, 30000);
  const { host, area } = makeHost();
  const ui = toastUi.create(host);
  ui.toastActionable('默认 8 秒', '撤销', () => {});
  const el = area.children[0];
  t.mock.timers.tick(toastUi.ACTIONABLE_DEFAULT_MS - 1);
  assert.equal(el.classList.contains('leaving'), false, '不到 8s 不关');
  t.mock.timers.tick(1);
  assert.equal(el.classList.contains('leaving'), true, '8s 到点自消失');

  // 小于下限按 1000ms 处理（0 / 负数 / 1 不会一闪就没）
  for (const durationMs of [1, 0, -500]) {
    const one = makeHost();
    toastUi.create(one.host).toastActionable('短', '撤销', () => {}, { durationMs });
    const shortEl = one.area.children[0];
    t.mock.timers.tick(toastUi.ACTIONABLE_MIN_MS - 1);
    assert.equal(shortEl.classList.contains('leaving'), false, `durationMs=${durationMs} 被钳到下限 1000`);
    t.mock.timers.tick(1);
    assert.equal(shortEl.classList.contains('leaving'), true, `durationMs=${durationMs} 按 1000ms 关`);
  }
  // 大于上限按 30000ms 处理
  const long = makeHost();
  toastUi.create(long.host).toastActionable('长', '撤销', () => {}, { durationMs: 999999 });
  const longEl = long.area.children[0];
  t.mock.timers.tick(toastUi.ACTIONABLE_MAX_MS - 1);
  assert.equal(longEl.classList.contains('leaving'), false, '超过上限被钳到 30000');
  t.mock.timers.tick(1);
  assert.equal(longEl.classList.contains('leaving'), true);
});

test('toastActionable：回调抛错只记 console.error，绝不让撤销条的动作把主流程带崩', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { host, area } = makeHost();
  const ui = toastUi.create(host);
  const realError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    ui.toastActionable('点我会炸', '执行', () => {
      throw new Error('动作失败了');
    });
    assert.doesNotThrow(() => area.children[0].children[1].fire('click'), '回调抛错不许冒到点击事件外');
  } finally {
    console.error = realError;
  }
  assert.equal(logged.length, 1, '错误留了一条痕');
  assert.equal(logged[0][0], '剪贴板提示的动作失败');
  assert.match(String(logged[0][1] && logged[0][1].message), /动作失败了/);
  t.mock.timers.tick(toastUi.TOAST_LEAVE_MS);
  assert.equal(area.children.length, 0, '抛错不影响提示照常关闭');
});

test('?test=1 才记 state.toastLog：普通提示不带 actionable，上限 60 条只留最近 60', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // 生产口径（testMode=false）：记一条都不写
  const prod = makeHost();
  toastUi.create(prod.host).toast('生产不记');
  assert.deepEqual(prod.state.toastLog, [], '生产里 state.toastLog 不增长');

  const { host, state } = makeHost({ testMode: true });
  const ui = toastUi.create(host);
  ui.toast('保存成功');
  ui.toast('章节文件缺失', 'warn');
  ui.toastActionable('要捕获吗？', '捕获', () => {});
  assert.deepEqual(state.toastLog, [
    { message: '保存成功', kind: 'info' },
    { message: '章节文件缺失', kind: 'warn' },
    { message: '要捕获吗？', kind: 'info', actionable: true }
  ], 'E2E 读的字段只有 message / kind / actionable');

  for (let i = 0; i < toastUi.TOAST_LOG_LIMIT + 5; i += 1) ui.toast('第 ' + i + ' 条');
  assert.equal(state.toastLog.length, toastUi.TOAST_LOG_LIMIT, '上限 60 条（E2E 只看最近几条，不能无限长）');
  assert.equal(state.toastLog[state.toastLog.length - 1].message, '第 64 条', '留的是最近的（先出后到的顺序不变）');
});

// 静态闸门（机器清单）：实现只有一份、装配三处到位、渲染层只剩转发。
test('静态闸门：实现只在 renderer/toast-ui.js，renderer.js 只保留同名转发（机器清单）', () => {
  const { rendererSrc, indexSrc, moduleSrc } = loadSourceGate('toast-ui.js');
  // ① 渲染层不许再长出第二份实现，也不许退回「内联建 DOM」
  assert.equal(/function\s+toast\s*\(/.test(rendererSrc), false, 'renderer.js 不许再有 toast() 实现');
  assert.equal(/function\s+toastActionable\s*\(/.test(rendererSrc), false, 'renderer.js 不许再有 toastActionable() 实现');
  assert.equal(rendererSrc.includes("document.createElement('div')") && /toast\s+\$\{/.test(rendererSrc), false,
    'renderer.js 不许自己拼 toast 条目');
  // ② 装配一次 + 同名转发（调用点一个字不用改）
  assert.match(rendererSrc, /const toastUi = toastUiModule\.create\(\{[^}]*\$\s*,\s*state\s*,\s*document[^}]*\}\);/,
    'renderer.js 必须装配 toast-ui（$ / state / document 三个成员）');
  assert.match(rendererSrc, /const \{ toast, toastActionable \} = toastUi;/, 'renderer.js 只保留同名转发');
  assert.match(rendererSrc, /const toastUiModule = window\.CWToastUi;/, 'renderer.js 从装配清单外的全局名取模块');
  // ③ 装配清单 + index.html 都到位，且模块排在 renderer.js 之前
  const entry = manifest.MODULES.find((item) => item[0] === 'toast-ui.js');
  assert.ok(entry, '装配清单必须登记 toast-ui.js');
  assert.equal(entry[1], 'CWToastUi');
  assert.equal(entry[2], 'toastUiModule');
  assert.match(indexSrc, /<script src="toast-ui\.js"><\/script>/, 'index.html 必须加载 toast-ui.js');
  assert.ok(
    indexSrc.indexOf('<script src="toast-ui.js"></script>') < indexSrc.indexOf('<script src="renderer.js"></script>'),
    'toast-ui.js 必须排在 renderer.js 之前（renderer.js 装载期就 create）'
  );
  // ④ 模块本身仍是 UMD 双分支 + 依赖 assert-host（与其它 37 个 host 消费者同口径）
  assert.match(moduleSrc, /root\.CWToastUi = factory\(root\.CWAssertHost && root\.CWAssertHost\.assertHost\);/);
  assert.match(moduleSrc, /assertHost\('createToastUi', host, REQUIRED_HOST\);/, '只许调用一次共享 assertHost');
});

test('静态闸门：条目只用 textContent 写文案（读屏播报）、不碰 innerHTML / aria-hidden', () => {
  const src = read('renderer/toast-ui.js');
  const body = src.slice(src.indexOf('function createToastUi'), src.indexOf('return { toast, toastActionable };'));
  assert.equal(/\.innerHTML\s*=/.test(body), false, 'toast 不许改写 innerHTML（会把播报区一起冲掉）');
  assert.equal(/aria-hidden/.test(body), false, 'toast 条目不许挂 aria-hidden');
  assert.equal((body.match(/textContent = /g) || []).length >= 3, true, '文案 / 按钮文字都用 textContent 写');
  // 播放区必须是 #toast-area（角色与 aria-live 在 index.html 上，见 toast-a11y.test.js）
  assert.match(body, /\$\('toast-area'\)/);
});
