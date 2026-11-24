// N-15（二次审查，低）：一次性「读剪贴板」凭证的签发 / 校验 / 消费时序。
//
// 凭证是 S1 的软边界（见 docs/已知限制.md）：打开捕获面板换一张 60 秒有效、用掉即废的本窗口
// 令牌。这里钉的是 N-15 修的那个次序问题：**校验**不消费，读到正文并通过长度校验之后才**消费**；
// 剪贴板暂时读不到 / 原文超限时，凭证还在，作者可以直接重试。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const gestureLib = require('../core/capture-gesture');

function makeClock(start = 0) {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    }
  };
}

test('N-15：check 只校验不消费 —— 读到正文之前失败多少次都能重试；consume 之后立刻失效', () => {
  const clock = makeClock();
  const store = gestureLib.createCaptureGestures({ now: clock.now });
  const token = store.issue(11);
  assert.equal(typeof token, 'string');
  assert.equal(store.check(11, token), true, '第一次校验通过');
  assert.equal(store.check(11, token), true, '校验不消费：还能再校验（读取失败后可重试）');
  assert.equal(store.check(11, token), true, '再校验一次仍然有效');
  assert.equal(store.consume(11, token), true, '读到正文后才消费');
  assert.equal(store.check(11, token), false, '消费后凭证失效（用掉即废）');
  assert.equal(store.consume(11, token), false, '不能消费两次');
});

test('N-15：令牌 / 窗口对不上、没有凭证都拒绝；同一窗口重复签发只保留最新一张', () => {
  const clock = makeClock();
  const store = gestureLib.createCaptureGestures({ now: clock.now });
  assert.equal(store.check(11, null), false, '没有令牌');
  assert.equal(store.check(11, 'g-forged'), false, '伪造令牌');
  assert.equal(store.check(null, 'g-x'), false, '没有窗口上下文');
  assert.equal(store.check(12, 'g-x'), false, '别的窗口没有凭证');
  const first = store.issue(11);
  const second = store.issue(11);
  assert.notEqual(first, second, '重新签发换新令牌');
  assert.equal(store.check(11, first), false, '旧令牌被顶掉');
  assert.equal(store.check(11, second), true, '只认最新一张');
  assert.equal(store.issue(null), null, '没有窗口时不签发');
});

test('N-15：凭证 60 秒过期（边界内有效、超过即失效并顺手清掉）', () => {
  assert.equal(gestureLib.DEFAULT_TTL_MS, 60 * 1000, '默认 60 秒');
  const clock = makeClock();
  const store = gestureLib.createCaptureGestures({ now: clock.now });
  assert.equal(store.ttlMs, gestureLib.DEFAULT_TTL_MS);
  const token = store.issue(21);
  clock.advance(60 * 1000);
  assert.equal(store.check(21, token), true, '正好 60 秒仍有效（> ttl 才算过期）');
  clock.advance(1);
  assert.equal(store.check(21, token), false, '超过 60 秒失效');
  assert.equal(store.size(), 0, '过期凭证顺手清掉（不攒内存）');
  clock.advance(120 * 1000);
  assert.equal(store.consume(21, token), false, '过期后不能靠 consume 复活');
});

test('N-15：关窗 release 作废在途凭证；sweep 清掉已用 / 过期凭证', () => {
  const clock = makeClock();
  const store = gestureLib.createCaptureGestures({ now: clock.now });
  const token = store.issue(31);
  assert.equal(store.release(31), true, '关窗删掉这一张');
  assert.equal(store.release(31), false, '重复释放幂等');
  assert.equal(store.check(31, token), false, '关窗后凭证不可用');

  const used = store.issue(41);
  store.consume(41, used);
  const stale = store.issue(42);
  clock.advance(61 * 1000);
  assert.equal(store.size(), 2, '已用的 41 与过期的 42 都还挂在 Map 上（check 只清理被访问的那张）');
  assert.equal(store.sweep(), 2, 'sweep 清掉已用的 41 与过期的 42');
  assert.equal(store.size(), 0);
  assert.equal(store.check(41, used), false);
  assert.equal(store.check(42, stale), false);
});

test('N-15 静态闸门：凭证模块是纯内存纯逻辑（不碰 fs / DOM / Electron / 定时器）', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'capture-gesture.js'), 'utf8');
  for (const forbidden of [
    "require('fs')",
    "require('node:fs')",
    'document.',
    'window.',
    'console.',
    'logError',
    'setTimeout',
    'setInterval',
    'electron',
    'innerHTML'
  ]) {
    assert.equal(source.includes(forbidden), false, `capture-gesture.js 不许出现 ${forbidden}`);
  }
  assert.ok(source.includes('module.exports'), '纯逻辑模块要能被 Node 单测 require');
});

// TOKEN-01（2026-11-24 复核补审）：令牌不可预测 —— 随机 UUID，不再是「g-<时间戳>-<序号>」。
test('TOKEN-01：令牌是不可枚举的随机 UUID，不是时间戳 + 自增序号', () => {
  const clock = makeClock(1_700_000_000_000);
  const store = gestureLib.createCaptureGestures({ now: clock.now });
  const tokens = new Set();
  for (let i = 0; i < 20; i += 1) tokens.add(store.issue(11));
  assert.equal(tokens.size, 20, '每次签发都得到新令牌');
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  for (const token of tokens) {
    assert.match(token, uuidRe, `令牌必须是随机 UUID：${token}`);
    assert.equal(token.includes(clock.now().toString(36)), false, '不能含可枚举的时间戳');
    assert.equal(token.startsWith('g-'), false, '不再用 g- 前缀');
  }
  // 静态：签发点必须走 crypto.randomUUID（回退到时间戳 + 序号会让令牌重新变得可预测）
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'capture-gesture.js'), 'utf8');
  assert.match(source, /crypto\.randomUUID\(\)/, '签发必须用 crypto.randomUUID');
  assert.equal(source.includes('`g-${at.toString(36)}'), false, '旧的可枚举令牌实现不许回来');
});
