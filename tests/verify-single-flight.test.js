'use strict';
// WP10（审计 P-N2，中 #11）：保存后的全书校验（book:verify）要单飞 / 合并。
//
// 旧实现（renderer.js verifyBookInBackground）：每次保存成功都 fire-and-forget 起一趟
// `book:verify`，没有在途标志。连按 Ctrl+S（或快速连存）会叠出 N 趟「逐章 stat + bookStats」，
// 把磁盘 / 线程池争用放大，而它们算的是同一本书的同一份结果。
//
// 现在的口径：
//   · 同一本书同时最多一趟；在途时再来的请求只标记「结束后补一次」（不排队 N 趟）；
//   · 不同书互不影响（可以并行）；
//   · 一趟失败 / 同步抛只由单飞层吞掉（可注入 onError 观察），不卡死后续请求。
//
// 全部断言先于实现写就；修复前 save-logic 没有 createVerifySingleFlight → 真红。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const saveLogic = require('../renderer/save-logic');

const ROOT = path.join(__dirname, '..');
const read = (rel) => require('node:fs').readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(turns = 6) {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function between(source, from, to) {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `找不到：${from}`);
  const end = source.indexOf(to, start + from.length);
  assert.ok(end > start, `找不到结尾：${to}`);
  return source.slice(start, end);
}

test('V1：同书在途时连存不叠趟，结束后恰好补一次（全程最多 1 趟在跑）', async () => {
  assert.equal(typeof saveLogic.createVerifySingleFlight, 'function', 'save-logic 要导出单飞工厂');
  const calls = [];
  const gates = [];
  let active = 0;
  let maxActive = 0;
  const flight = saveLogic.createVerifySingleFlight(async (key) => {
    calls.push(key);
    active += 1;
    maxActive = Math.max(maxActive, active);
    const gate = deferred();
    gates.push(gate);
    await gate.promise;
    active -= 1;
  });

  assert.equal(flight.request('/书甲'), 'started');
  await flush();
  assert.equal(calls.length, 1, '第一趟已经起跑');
  assert.equal(flight.request('/书甲'), 'coalesced');
  assert.equal(flight.request('/书甲'), 'coalesced');
  assert.equal(flight.activeCount(), 1, '只有一趟在途');
  assert.equal(gates.length, 1, '在途时不许再起第二趟');

  gates[0].resolve();
  await flush();
  assert.equal(calls.length, 2, '第一趟结束后补一次（3 次请求 → 2 趟）');
  assert.equal(gates.length, 2);
  assert.equal(maxActive, 1, '任何时刻都不许叠趟');

  gates[1].resolve();
  await flush();
  assert.equal(flight.activeCount(), 0, '补完就收口');
  assert.equal(calls.length, 2, '补一次之后不再凭空多跑');
  assert.equal(maxActive, 1);
});

test('V2：在途窗口内连续请求 10 次也只合并成「首趟 + 补一次」', async () => {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const flight = saveLogic.createVerifySingleFlight(async () => {
    calls.push(Date.now());
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(40);
    active -= 1;
  });

  flight.request('/书甲');
  // 同一 tick 内连续 9 次（在途标志是同步置位的；不用 sleep 免得被 Windows 计时器粒度拖成多趟）
  for (let i = 0; i < 9; i += 1) flight.request('/书甲');
  await sleep(120); // 首趟 40ms + 补一趟 40ms 都跑完
  assert.equal(calls.length, 2, `10 次连存只许跑 2 趟（首趟 + 补一次）：实际 ${calls.length}`);
  assert.equal(maxActive, 1);
  assert.equal(flight.activeCount(), 0);
});

test('V3：一趟失败只被单飞层吞掉（onError 可见），不卡死后续请求、无 unhandled rejection', async () => {
  const errors = [];
  let runs = 0;
  const flight = saveLogic.createVerifySingleFlight(
    async () => {
      runs += 1;
      if (runs === 1) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    },
    { onError: (err) => errors.push(err) }
  );
  flight.request('/书甲');
  await flush();
  assert.equal(runs, 1);
  assert.equal(errors.length, 1, '失败要能被观察（渲染层自己会记日志）');
  assert.equal(errors[0].code, 'EPERM');

  // 失败之后仍能起新一趟（在途标志要收口）
  assert.equal(flight.request('/书甲'), 'started');
  await flush();
  assert.equal(runs, 2);
  assert.equal(flight.activeCount(), 0);
  assert.equal(errors.length, 1, '第二趟成功不再报错');

  // 同步抛同样只吞掉
  const syncFlight = saveLogic.createVerifySingleFlight(
    () => {
      throw new Error('sync boom');
    },
    { onError: (err) => errors.push(err) }
  );
  syncFlight.request('/书乙');
  await flush();
  assert.equal(errors.length, 2);
  assert.equal(syncFlight.activeCount(), 0, '同步抛不许把在途标志留在 Map 里');
});

test('V4：不同书互不合并（可并行），同书仍单飞', async () => {
  const gates = new Map();
  let active = 0;
  let maxActive = 0;
  const flight = saveLogic.createVerifySingleFlight(async (key) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const gate = deferred();
    gates.set(key, gate);
    await gate.promise;
    active -= 1;
  });
  flight.request('/书甲');
  flight.request('/书乙');
  await flush();
  assert.equal(flight.activeCount(), 2, '两本不同的书各跑一趟');
  assert.equal(maxActive, 2);
  assert.equal(flight.request('/书甲'), 'coalesced');
  assert.equal(flight.activeCount(), 2, '第二本书不因为第一本书在途被挡');
  gates.get('/书甲').resolve();
  gates.get('/书乙').resolve();
  await flush();
  // 书甲在途时被 request 过 → 收尾后补跑一次（由上面的 coalesced 请求触发）；书乙直接收口。
  assert.equal(flight.activeCount(), 1, '书甲合并出的「补一次」正在跑');
  gates.get('/书甲').resolve();
  await flush();
  assert.equal(flight.activeCount(), 0);
});

test('V5：静态接线——渲染层走单飞工厂，保存热路径仍不 await 校验', () => {
  const renderer = read('renderer/renderer.js');
  // WP17 A3 第二刀：保存后的全书校验整段迁到 save-chain-ui.js；工厂 / 入口 / 调用点改读模块（同一条断言）。
  const saveChain = read('renderer/save-chain-ui.js');
  assert.match(saveChain, /saveLogic\.createVerifySingleFlight\(/, '保存链模块要接单飞工厂');
  const body = between(saveChain, 'function verifyBookInBackground(', '\n  }');
  assert.match(body, /request\(bookPath\)/, '入口只提交请求');
  assert.equal(body.includes('void (async () =>'), false, '旧的 fire-and-forget 匿名体必须收掉');
  assert.match(saveChain, /verifyBookInBackground\(bookPath\);/, '保存成功后的调用点不变');
  assert.equal(/await\s+verifyBookInBackground/.test(renderer + saveChain), false, '保存热路径不许 await 校验');
  assert.equal(/function verifyBookInBackground\(/.test(renderer), false, '入口只被模块内部调用，编排器不再定义同名包装');

  const saveLogicSrc = read('renderer/save-logic.js');
  assert.match(saveLogicSrc, /function createVerifySingleFlight/, '纯逻辑在 save-logic（不碰 DOM / IPC）');
  assert.match(saveLogicSrc, /createVerifySingleFlight,?/, '导出面要包含工厂');
});