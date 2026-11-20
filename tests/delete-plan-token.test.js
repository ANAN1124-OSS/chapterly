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

// 五-M29（IPC-02）：令牌不只绑原始 groupIds，还要绑「计划实际解析出的可清理集合」——
// 有效删除集合 = f(groupIds, protectedGroupIds)，只绑前者时，执行阶段撤掉 protectedGroupIds
// 就能把确认框里明示「跳过」的组补进删除集。这里钉住令牌携带的计划集合 + 输入校验。
test('T7 计划令牌：绑定计划可清理集合（cleanableIds），执行阶段只能删这份清单', () => {
  const store = tokenLib.createStore({ randomUUID: () => 'tok-cleanable' });
  const bookPath = 'D:\\书库\\书甲';
  const token = store.issue({
    bookPath,
    groupIds: ['dir:替换备份-1', 'dir:还原前备份-2'],
    cleanableIds: ['dir:替换备份-1'] // 还原前备份当时被 10 秒撤销条保护 → 计划里跳过
  });
  assert.ok(token);
  const claim = store.take(token, { bookPath, groupIds: ['dir:还原前备份-2', 'dir:替换备份-1'] });
  assert.equal(claim.ok, true, 'groupIds 仍是确认过的那张清单');
  assert.deepEqual(claim.record.cleanable, ['dir:替换备份-1'], 'record 要带计划可清理集合给执行层复核');

  // cleanableIds 必须是确认清单的子集、形状合法 —— 否则整张不发（不能发一张绑不上计划的凭证）
  for (const bad of [
    { bookPath, groupIds: ['dir:a'], cleanableIds: ['dir:b'] },
    { bookPath, groupIds: ['dir:a'], cleanableIds: 'dir:a' },
    { bookPath, groupIds: ['dir:a'], cleanableIds: [42] },
    { bookPath, groupIds: ['dir:a'], cleanableIds: [`dir:${'x'.repeat(400)}`] }
  ]) {
    assert.equal(store.issue(bad), '', `非法 cleanableIds 不发令牌：${JSON.stringify(bad)}`);
  }
  // 空集合合法（整张计划都被跳过）：照样绑定，执行层据此拒绝删除任何东西
  const emptyToken = store.issue({ bookPath, groupIds: ['dir:a'], cleanableIds: [] });
  const emptyClaim = store.take(emptyToken, { bookPath, groupIds: ['dir:a'] });
  assert.deepEqual(emptyClaim.record.cleanable, []);
  assert.equal(store.release(emptyClaim.record), true, 'release 也要带得动这份绑定');
});

// 五-M30（IPC-03）：摘要 join('\n') 有歧义 + take 不比 count —— 一条含内部换行的拼凑 id 与拆分后的
// 清单 join 出同一串字节（「确认一份清单、执行另一份」）。现在 normalize 拒绝控制字符（与
// ipc-limits.restoreFileName 同口径）、摘要改无歧义序列化（JSON.stringify）、take 再比 count。
test('T8 计划令牌：含换行的拼凑 id 不发令牌；摘要无歧义且 take 比对条数', () => {
  const store = tokenLib.createStore({ randomUUID: () => 'tok-digest' });
  const bookPath = 'D:\\书库\\书甲';
  // findings 里的 A = ['dir:X\ndir:Y', 'dir:R']：旧摘要 join('\n') 与 B（拆开的三条）拼出同一串。
  // 现在这种拼凑 id 连第一道 normalize 都过不了 —— 整张拒绝，绝不发一张能对上 B 的令牌。
  assert.equal(store.issue({ bookPath, groupIds: ['dir:X\ndir:Y', 'dir:R'] }), '', '含换行的拼凑 id 不发令牌');
  for (const bad of ['dir:a\nb', 'dir:a\tb', 'dir:a\u0000b', 'dir:a\u007fb']) {
    assert.equal(store.issue({ bookPath, groupIds: [bad] }), '', `控制字符 id 不发令牌：${JSON.stringify(bad)}`);
  }
  // 计划可清理集合同样不收控制字符（它是执行层的白名单）
  assert.equal(
    store.issue({ bookPath, groupIds: ['dir:甲'], cleanableIds: ['dir:甲\n乙'] }),
    '',
    'cleanableIds 也要拒绝控制字符'
  );
  assert.equal(store.size(), 0);

  // take 要比对条数（防御「元素数不同但摘要撞上」的任何可达碰撞）：篡改放回记录的 count 后，
  // 同一份 groupIds 就不再通过。
  const token = store.issue({ bookPath, groupIds: ['dir:甲', 'dir:乙'] });
  const claim = store.take(token, { bookPath, groupIds: ['dir:乙', 'dir:甲'] });
  assert.equal(claim.ok, true);
  claim.record.count = 3;
  assert.equal(store.release(claim.record), true);
  assert.deepEqual(store.take(token, { bookPath, groupIds: ['dir:甲', 'dir:乙'] }), {
    ok: false,
    reason: 'plan-mismatch'
  });
});