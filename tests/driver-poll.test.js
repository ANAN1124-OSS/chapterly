'use strict';
// 审计修复 #53（R7）：开发自检驱动的公共骨架（scripts/driver-poll.js）。
// bench / contrast / screenshot / a11y 原来各自实现「等页面就绪」的轮询与注入；现在统一收在这里。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { pollUntil, execInRenderer } = require('../scripts/driver-poll');

test('pollUntil：试探抛错当作「页面还没好」继续等，首次真值即返回', async () => {
  let calls = 0;
  const value = await pollUntil(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error('页面还没加载完');
      return calls >= 3 ? 'ready' : '';
    },
    { timeout: 2000, interval: 1 }
  );
  assert.equal(value, 'ready');
  assert.equal(calls, 3);
});

test('pollUntil：超时抛「等待超时：<label>」；给 timeoutMessage 时用它（a11y 端口文案逐字保留）', async () => {
  await assert.rejects(
    () => pollUntil(async () => false, { timeout: 5, interval: 1, label: 'window.__cwTest.never' }),
    (err) => err instanceof Error && err.message === '等待超时：window.__cwTest.never'
  );
  await assert.rejects(
    () =>
      pollUntil(async () => null, {
        timeout: 5,
        interval: 1,
        timeoutMessage: '等待 Electron 远程调试端口超时'
      }),
    (err) => err instanceof Error && err.message === '等待 Electron 远程调试端口超时'
  );
});

test('pollUntil：beforeProbe 的异常直接中止（不吞成「页面还没好」），timeoutMessage 可现取现场', async () => {
  let probes = 0;
  await assert.rejects(
    () =>
      pollUntil(async () => {
        probes += 1;
        return false;
      }, {
        timeout: 5000,
        interval: 1,
        beforeProbe: () => {
          throw new Error('窗口已销毁，停止等待：x');
        }
      }),
    (err) => err.message === '窗口已销毁，停止等待：x'
  );
  assert.equal(probes, 0, '中止发生在试探之前，不白跑 probe');

  const startedAt = Date.now();
  await assert.rejects(
    () =>
      pollUntil(async () => false, {
        timeout: 20,
        interval: 1,
        timeoutMessage: () => `等待超时：带现场 ${Math.round((Date.now() - startedAt) / 1000)}s`
      }),
    (err) => /^等待超时：带现场 \d+s$/.test(err.message)
  );
});

test('execInRenderer：脚本与 userGesture=true 原样交给渲染层', async () => {
  const seen = [];
  const win = {
    webContents: {
      executeJavaScript: async (code, userGesture) => {
        seen.push([code, userGesture]);
        return 'value';
      }
    }
  };
  assert.equal(await execInRenderer(win, 'window.x'), 'value');
  assert.deepEqual(seen, [['window.x', true]]);
});

test('驱动公共骨架：screenshot-driver / a11y-gate 共用同一份轮询，不再各自写 Date.now 循环', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const shot = read('scripts/screenshot-driver.js');
  const a11y = read('scripts/a11y-gate.js');
  assert.match(shot, /require\('\.\/driver-poll'\)/, 'screenshot-driver 要 require 公共骨架');
  assert.match(a11y, /require\('\.\/driver-poll'\)/, 'a11y-gate 要 require 公共骨架');

  const sliceBody = (source, name) => {
    const start = source.indexOf(name);
    assert.ok(start > 0, `找不到 ${name}`);
    const end = source.indexOf('\n}', start);
    assert.ok(end > start, `${name} 的函数体没有按预期结束`);
    return source.slice(start, end);
  };
  const waitBody = sliceBody(shot, 'async function waitForRenderer');
  assert.ok(waitBody.includes('pollUntil('), 'waitForRenderer 要用公共轮询');
  assert.equal(/Date\.now\(\) - startedAt/.test(waitBody), false, 'waitForRenderer 不再自己写截止循环');
  for (const name of ['async function waitEval', 'async function waitTarget']) {
    const body = sliceBody(a11y, name);
    assert.ok(body.includes('pollUntil('), `${name} 要用公共轮询`);
    assert.equal(/await sleep\(/.test(body), false, `${name} 不再自己 sleep 轮询`);
  }
  assert.equal(/const sleep = \(ms\) => new Promise/.test(a11y), false, 'a11y-gate 不再自带 sleep 副本');
});
// CI-F7（2026-11-24 复核补审）：E2E harness 的六个手写轮询全部走 scripts/driver-poll.js 的 pollUntil，
// 不再各自写「Date.now() - startedAt」截止循环（文案仍由各自 probe 保留）。
test('CI-F7：e2e/harness 的等待工具统一走 pollUntil，不再手写轮询循环', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'e2e', 'harness.js'), 'utf8');
  assert.match(source, /require\('\.\.\/driver-poll'\)/, 'harness 要 require 公共轮询');
  for (const name of ['waitFor', 'waitForLog', 'waitForFile', 'waitForSummary', 'waitCloseReady', 'waitForClipboard']) {
    const start = source.indexOf(`const ${name} =`);
    assert.ok(start > 0, `找不到 ${name}`);
    const end = source.indexOf('\n  };', start) > start ? source.indexOf('\n  };', start) : source.indexOf('\n  });', start);
    const body = source.slice(start, end > start ? end : start + 1200);
    assert.ok(body.includes('pollUntil('), `${name} 要用 pollUntil`);
    assert.equal(/Date\.now\(\) - startedAt/.test(body), false, `${name} 不再自己写截止循环`);
  }
  assert.equal(
    (source.match(/Date\.now\(\) - startedAt/g) || []).length,
    0,
    'harness 里不许残留手写的轮询截止'
  );
});
