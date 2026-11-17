// WP4（S-N1 / 中 #5）：备份清理一次性「计划令牌」的纯逻辑锚点。
//
// 为什么需要这一层：book:delete-history-backups 的 groupIds 完全由渲染层给。以前主进程直接
// 按这个清单 fs.rm，注入 / bug 一次 IPC 就能清空全书可清理备份。现在清理分两步：
//   ① book:plan-delete-history-backups —— 主进程自己解析「哪些组真的可清理」，并发一张一次性令牌
//      （随机 UUID，只存内存；绑定 书路径 + 组清单摘要 + 过期时间）；
//   ② book:delete-history-backups —— 必须带令牌回来，四条（存在 / 没过期 / 同一本书 / 组清单一致）
//      全过才放行，成功立刻作废（一次性）。
// 本文件只测纯逻辑（不 require electron / 不碰 fs）：tokens / 过期 / 换书 / 清单漂移 / 一次性 / 放回。
const test = require('node:test');
const assert = require('node:assert/strict');

const tokenLib = require('../core/delete-plan-token');

function storeAt(clock, overrides = {}) {
  return tokenLib.createStore({ now: () => clock.now, ...overrides });
}

test('T1 计划令牌：发→验→作废（一次性），record 里带书 / 摘要 / 过期时间', () => {
  const store = tokenLib.createStore({ ttlMs: 60000, randomUUID: () => 'tok-11111111' });
  const bookPath = 'D:\\书库\\书甲';
  const token = store.issue({ bookPath, groupIds: ['dir:替换备份-2026-10-31-210000'] });
  assert.equal(token, 'tok-11111111');
  assert.equal(store.size(), 1);

  const claim = store.take(token, { bookPath, groupIds: ['dir:替换备份-2026-10-31-210000'] });
  assert.equal(claim.ok, true);
  assert.equal(claim.record.bookPath, bookPath);
  assert.equal(claim.record.count, 1);
  assert.ok(claim.record.expiresAt > Date.now());
  assert.equal(store.size(), 0, '用掉的令牌必须立刻消失（一次性）');

  assert.deepEqual(
    store.take(token, { bookPath, groupIds: ['dir:替换备份-2026-10-31-210000'] }),
    { ok: false, reason: 'unknown' },
    '同一张令牌不能用第二次'
  );
});

test('T2 计划令牌：过期即拒绝（不烧别人的令牌）', () => {
  const clock = { now: 1000 };
  const store = storeAt(clock, { ttlMs: 500 });
  const bookPath = 'D:\\书库\\书甲';
  const token = store.issue({ bookPath, groupIds: ['dir:a'] });
  clock.now = 1499;
  assert.equal(store.take(token, { bookPath, groupIds: ['dir:a'] }).ok, true);

  const token2 = store.issue({ bookPath, groupIds: ['dir:b'] });
  clock.now = 2000;
  assert.deepEqual(store.take(token2, { bookPath, groupIds: ['dir:b'] }), { ok: false, reason: 'expired' });
  assert.equal(store.size(), 0, '过期记录顺手清掉');
});

test('T3 计划令牌：换书拒绝；同一路径的大小写 / 斜杠写法仍放行（pathKey 口径）', () => {
  const store = tokenLib.createStore({ randomUUID: () => 'tok-book' });
  const token = store.issue({ bookPath: 'D:\\书库\\书甲', groupIds: ['dir:a'] });
  assert.deepEqual(
    store.take(token, { bookPath: 'D:\\书库\\书乙', groupIds: ['dir:a'] }),
    { ok: false, reason: 'book-mismatch' }
  );
  assert.equal(store.size(), 1, '换书只拒绝，不烧作者手里的真令牌');
  assert.equal(store.take(token, { bookPath: 'd:/书库/书甲', groupIds: ['dir:a'] }).ok, true);
});

test('T4 计划令牌：组清单顺序无关；多一组 / 少一组 / 改一条都拒绝', () => {
  const store = tokenLib.createStore({ randomUUID: () => 'tok-groups' });
  const bookPath = 'D:\\书库\\书甲';
  const token = store.issue({ bookPath, groupIds: ['dir:替换备份-1', 'dir:整理备份-2', 'dir:还原前备份-3'] });
  assert.equal(
    store.take(token, {
      bookPath,
      groupIds: ['dir:还原前备份-3', 'dir:替换备份-1', 'dir:整理备份-2']
    }).ok,
    true,
    '顺序不同但集合相同 → 放行'
  );

  for (const drifted of [
    ['dir:替换备份-1', 'dir:整理备份-2'],
    ['dir:替换备份-1', 'dir:整理备份-2', 'dir:还原前备份-3', 'dir:多出来-4'],
    ['dir:替换备份-1', 'dir:整理备份-2', 'dir:还原前备份-X']
  ]) {
    const next = tokenLib.createStore({ randomUUID: () => `tok-${Math.random()}` });
    const issued = next.issue({ bookPath, groupIds: ['dir:替换备份-1', 'dir:整理备份-2', 'dir:还原前备份-3'] });
    assert.deepEqual(next.take(issued, { bookPath, groupIds: drifted }), { ok: false, reason: 'plan-mismatch' });
    assert.equal(next.size(), 1, '清单对不上只拒绝、不烧令牌');
  }
});

test('T5 计划令牌：非法参数不发令牌；伪造 / 超长 / 非数组一律不认', () => {
  const store = tokenLib.createStore({ randomUUID: () => 'tok-valid' });
  const bookPath = 'D:\\书库\\书甲';
  for (const bad of [
    undefined,
    null,
    {},
    { bookPath: '', groupIds: ['dir:a'] },
    { bookPath },
    { bookPath, groupIds: [] },
    { bookPath, groupIds: 'dir:a' },
    { bookPath, groupIds: [42, null] },
    { bookPath, groupIds: [`dir:${'x'.repeat(400)}`] }
  ]) {
    assert.equal(store.issue(bad), '', `非法参数不能发令牌：${JSON.stringify(bad)}`);
  }
  assert.equal(store.size(), 0, '半张凭证都不许留下');

  // 超过 5000 条：整张拒绝（不「截断后半张」——那样清单已经不是作者确认过的那份）
  const many = Array.from({ length: 5001 }, (_, i) => `dir:整理备份-${String(i).padStart(4, '0')}`);
  assert.equal(store.issue({ bookPath, groupIds: many }), '', '超过上限不发令牌');
  const exactly = many.slice(0, 5000);
  const boundToken = store.issue({ bookPath, groupIds: exactly });
  assert.ok(boundToken, '正好 5000 条可以发');
  assert.equal(store.take(boundToken, { bookPath, groupIds: exactly }).ok, true);
  assert.equal(store.take(boundToken, { bookPath, groupIds: many }).ok, false, '5001 条不是同一份清单，不能放行');

  const forged = tokenLib.createStore({});
  assert.deepEqual(forged.take('x'.repeat(65), { bookPath, groupIds: ['dir:a'] }), { ok: false, reason: 'unknown' });
  assert.deepEqual(forged.take('', { bookPath, groupIds: ['dir:a'] }), { ok: false, reason: 'unknown' });
});

test('T6 计划令牌：errorFor 统一 code / 文案；release 让作者原地重试且只放回一次', () => {
  for (const reason of ['unknown', 'expired', 'book-mismatch', 'plan-mismatch']) {
    const err = tokenLib.errorFor(reason);
    assert.equal(err.code, 'DELETE_PLAN_INVALID');
    assert.match(err.message, /清理/);
  }
  assert.equal(tokenLib.errorFor('nonsense').code, 'DELETE_PLAN_INVALID', '未知 reason 也要有 code');

  const store = tokenLib.createStore({ randomUUID: () => 'tok-release' });
  const bookPath = 'D:\\书库\\书甲';
  const token = store.issue({ bookPath, groupIds: ['dir:a'] });
  const claim = store.take(token, { bookPath, groupIds: ['dir:a'] });
  assert.equal(claim.ok, true);
  assert.equal(store.release(claim.record), true, '执行阶段整体失败 → 放回去可以重试');
  assert.equal(store.release(claim.record), false, '同一份 record 不能放回两次');
  assert.equal(store.take(token, { bookPath, groupIds: ['dir:a'] }).ok, true, '放回后还能用一次');
});