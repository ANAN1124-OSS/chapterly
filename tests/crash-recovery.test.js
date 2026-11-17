// WP5（N1 / 中 #6）：渲染崩溃 / 窗口假死的纯决策锚点（core/crash-recovery.js）。
//
// 为什么单独一层：主进程里 `render-process-gone` / `unresponsive` 的处置要能单测——
// 自动 reload 必须防重载环，退出中 / 正常关窗不能误重载；假死必须给「继续等待 / 强制重载」出口。
// 对话框选项只在这里生成，main.js 只负责 showMessageBox + 按 actions 执行。
const test = require('node:test');
const assert = require('node:assert/strict');

const crashRecovery = require('../core/crash-recovery');

test('R1 渲染崩溃首次 → 自动重载（视图自己恢复）', () => {
  assert.deepEqual(
    crashRecovery.decideRenderCrash({
      reason: 'crashed',
      nowMs: 100000,
      lastReloadAtMs: 0,
      reloadCount: 0,
      quitting: false
    }),
    { action: 'reload', reason: 'first-crash', nextLastReloadAtMs: 100000, nextReloadCount: 1 }
  );
  // 其它非正常原因同样恢复：OOM / killed / 异常退出
  for (const reason of ['oom', 'killed', 'abnormal-exit', 'launch-failed', 'integrity-failure']) {
    assert.equal(
      crashRecovery.decideRenderCrash({ reason, nowMs: 5, lastReloadAtMs: 0, reloadCount: 0, quitting: false }).action,
      'reload',
      `${reason} 也应自动重载`
    );
  }
});

test('R2 60 秒内重复崩溃 → 对话框出口，不进重载环；过了保护窗又能自动重载', () => {
  const first = crashRecovery.decideRenderCrash({
    reason: 'crashed',
    nowMs: 100000,
    lastReloadAtMs: 0,
    reloadCount: 0,
    quitting: false
  });
  const again = crashRecovery.decideRenderCrash({
    reason: 'crashed',
    nowMs: 100000 + crashRecovery.RELOAD_GUARD_MS - 1,
    lastReloadAtMs: first.nextLastReloadAtMs,
    reloadCount: first.nextReloadCount,
    quitting: false
  });
  assert.equal(again.action, 'ask', '保护窗内重复崩溃不再自动重载（避免重载成环）');
  assert.equal(again.reason, 'reload-loop');
  assert.equal(again.nextLastReloadAtMs, first.nextLastReloadAtMs, '对话框出口不改「上次重载」时刻');
  assert.equal(again.nextReloadCount, 2);

  const later = crashRecovery.decideRenderCrash({
    reason: 'crashed',
    nowMs: 100000 + crashRecovery.RELOAD_GUARD_MS + 1,
    lastReloadAtMs: first.nextLastReloadAtMs,
    reloadCount: first.nextReloadCount,
    quitting: false
  });
  assert.equal(later.action, 'reload', '过了保护窗重新允许自动恢复');
  assert.equal(later.nextReloadCount, 1);
});

test('R3 正常退出 / 关窗不误重载', () => {
  for (const reason of ['clean-exit']) {
    assert.deepEqual(
      crashRecovery.decideRenderCrash({ reason, nowMs: 1, lastReloadAtMs: 0, reloadCount: 0, quitting: false }),
      { action: 'none', reason: 'clean' }
    );
  }
  for (const reason of ['crashed', 'oom', 'killed']) {
    assert.deepEqual(
      crashRecovery.decideRenderCrash({ reason, nowMs: 1, lastReloadAtMs: 0, reloadCount: 0, quitting: true }),
      { action: 'none', reason: 'quitting' },
      '退出中不重载'
    );
  }
});

test('R4 假死 / 重载失败 / 重复崩溃对话框：按钮、默认项、动作一一对应', () => {
  const slow = crashRecovery.unresponsivePlan();
  assert.deepEqual(slow.buttons, ['继续等待', '强制重载']);
  assert.deepEqual(slow.actions, ['wait', 'reload']);
  assert.equal(slow.defaultId, 0);
  assert.equal(slow.cancelId, 0, '默认 / 取消都是继续等待（作者没点就不动）');
  assert.equal(slow.type, 'warning');
  assert.match(slow.title, /无响应/);
  assert.match(slow.message, /继续等待/);
  assert.match(slow.message, /正文/);

  const crash = crashRecovery.renderCrashDialog({ reason: 'crashed' });
  assert.deepEqual(crash.buttons, ['打开日志文件夹', '关闭这个窗口', '重载界面']);
  assert.deepEqual(crash.actions, ['logs', 'close', 'reload']);
  assert.equal(crash.defaultId, 2, '主操作是最右的重载');
  assert.equal(crash.cancelId, 1);
  assert.equal(crash.type, 'error');
  assert.match(crash.message, /crashed/);
  assert.match(crash.message, /未保存/);

  const failed = crashRecovery.reloadFailureDialog({ message: '页面没有重新加载出来' });
  assert.deepEqual(failed.buttons, ['打开日志文件夹', '关闭这个窗口']);
  assert.deepEqual(failed.actions, ['logs', 'close']);
  assert.equal(failed.defaultId, 0);
  assert.equal(failed.cancelId, 1);
  assert.match(failed.message, /页面没有重新加载出来/);
  assert.equal(failed.message.includes('C:\\'), false, '对话框只放固定文案，不带本机绝对路径');
});

test('R5 决策输入容错：坏 reason / 坏数字不抛、按最保守分支走', () => {
  const badReason = crashRecovery.decideRenderCrash({
    reason: null,
    nowMs: 1,
    lastReloadAtMs: 0,
    reloadCount: 0,
    quitting: false
  });
  assert.equal(badReason.action, 'reload', '未知原因按崩溃处理（至少给恢复机会）');

  const badNumbers = crashRecovery.decideRenderCrash({
    reason: 'crashed',
    nowMs: NaN,
    lastReloadAtMs: 'x',
    reloadCount: 'y',
    quitting: false
  });
  assert.equal(badNumbers.action, 'reload');
  assert.equal(typeof badNumbers.nextLastReloadAtMs, 'number');
  assert.equal(badNumbers.nextReloadCount, 1);

  assert.equal(crashRecovery.decideRenderCrash().action, 'reload', '无参数也不抛');
});