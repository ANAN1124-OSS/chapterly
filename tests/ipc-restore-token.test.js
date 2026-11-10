// 1.5.0 P0-5（1.4.0 审计 V-1）：撤销删除的进程内凭证。
//
// 这一层只做「这个 trashName 是不是本次删除产生的」：删除成功发一张一次性 UUID，
// 撤销必须带回来，存在 / 未过期 / 同一本书 / 同一个 trashName 四条全对才放行，验过立刻作废。
// 测试覆盖：正常发放与消费、伪造 / 过期 / 跨书 / 名字对不上 / 重复使用全被拒、
// 失败时凭证能放回（不把作者唯一的退路烧掉）、上限与过期清理、脏参数不发凭证。
const test = require('node:test');
const assert = require('node:assert/strict');
const tokenLib = require('../core/ipc-restore-token');

const BOOK = 'D:/书库/书甲';
const OTHER_BOOK = 'D:/书库/书乙';
const TRASH = '2026-11-10T13-00-00-000Z-002-第二章.txt';

function makeStore(extra = {}) {
  let clock = 1_000_000;
  const store = tokenLib.createStore({
    now: () => clock,
    randomUUID: (() => {
      let seq = 0;
      return () => {
        seq += 1;
        return `tok-${seq}`;
      };
    })(),
    ...extra
  });
  return { store, advance: (ms) => { clock += ms; }, now: () => clock };
}

function issueOne(store) {
  return store.issue({ bookPath: BOOK, trashName: TRASH, chapterId: 'ch_1' });
}

test('撤销凭证：发放后能且只能用一次，record 带书 / 备份名 / 章节 id / 过期时间', () => {
  const { store } = makeStore();
  const token = issueOne(store);
  assert.equal(typeof token, 'string');
  assert.ok(token.length > 0);

  const taken = store.take(token, { bookPath: BOOK, trashName: TRASH });
  assert.equal(taken.ok, true);
  assert.equal(taken.record.bookPath, BOOK);
  assert.equal(taken.record.trashName, TRASH);
  assert.equal(taken.record.chapterId, 'ch_1');
  assert.ok(taken.record.expiresAt > 0);
  assert.equal(store.size(), 0, '用掉以后不能留在 Map 里');

  // 重复使用（一次性）：同一张凭证第二次必须被拒
  const again = store.take(token, { bookPath: BOOK, trashName: TRASH });
  assert.deepEqual(again, { ok: false, reason: 'unknown' });
});

test('撤销凭证：伪造 / 空 / 超长 token 一律 unknown，不去查表', () => {
  const { store } = makeStore();
  issueOne(store);
  for (const forged of ['', '   ', 'not-a-real-token', 'x'.repeat(tokenLib.MAX_TOKEN_CHARS + 1), null, 42, {}]) {
    const res = store.take(forged, { bookPath: BOOK, trashName: TRASH });
    assert.deepEqual(res, { ok: false, reason: 'unknown' }, `伪造凭证必须被拒：${String(forged)}`);
  }
  assert.equal(store.size(), 1, '伪造尝试不能把真的那张耗掉');
});

test('撤销凭证：过期被拒（10 分钟 TTL），过期项顺手清掉', () => {
  const { store, advance } = makeStore();
  const token = issueOne(store);
  advance(tokenLib.DEFAULT_TTL_MS - 1);
  assert.equal(store.take(token, { bookPath: BOOK, trashName: TRASH }).ok, true, '差 1ms 仍有效（换一张新 store 再验过期）');

  const fresh = makeStore();
  const expiredToken = issueOne(fresh.store);
  fresh.advance(tokenLib.DEFAULT_TTL_MS);
  assert.deepEqual(fresh.store.take(expiredToken, { bookPath: BOOK, trashName: TRASH }), {
    ok: false,
    reason: 'expired'
  });
  assert.equal(fresh.store.size(), 0, '过期项被清掉');
});

test('撤销凭证：跨书 / trashName 对不上被拒，且不烧掉作者手里那张真凭证', () => {
  const { store } = makeStore();
  const token = issueOne(store);

  assert.deepEqual(store.take(token, { bookPath: OTHER_BOOK, trashName: TRASH }), {
    ok: false,
    reason: 'book-mismatch'
  });
  assert.deepEqual(store.take(token, { bookPath: BOOK, trashName: '别的备份.txt' }), {
    ok: false,
    reason: 'trash-mismatch'
  });
  // 两次错误尝试之后，正确的这次仍然可用
  assert.equal(store.take(token, { bookPath: BOOK, trashName: TRASH }).ok, true);
});

test('撤销凭证：还原失败可 release 回去再试一次（expiresAt 不续期）', () => {
  const { store, advance } = makeStore();
  const token = issueOne(store);
  const claim = store.take(token, { bookPath: BOOK, trashName: TRASH });
  assert.equal(claim.ok, true);

  advance(2000);
  assert.equal(store.release(claim.record), true, '失败后把凭证放回去');
  const retry = store.take(token, { bookPath: BOOK, trashName: TRASH });
  assert.equal(retry.ok, true);
  assert.equal(retry.record.expiresAt, claim.record.expiresAt, 'release 不续期');

  // 同一张已经放回去的再 release 一次 → false（不能复制凭证）
  assert.equal(store.release(claim.record), false);

  // 过期后不能放回
  const second = makeStore();
  const t2 = issueOne(second.store);
  const c2 = second.store.take(t2, { bookPath: BOOK, trashName: TRASH });
  second.advance(tokenLib.DEFAULT_TTL_MS);
  assert.equal(second.store.release(c2.record), false, '过期凭证不能复活');
});

test('撤销凭证：Map 有上限，超了丢最早过期的；过期项不计入 size', () => {
  const { store, advance } = makeStore({ maxEntries: 2 });
  const first = issueOne(store);
  advance(10);
  const second = issueOne(store);
  advance(10);
  const third = issueOne(store);
  assert.equal(store.size(), 2, '超过上限只留 2 条');
  assert.deepEqual(store.take(first, { bookPath: BOOK, trashName: TRASH }), {
    ok: false,
    reason: 'unknown'
  }, '最早的一条被挤掉');
  assert.equal(store.take(second, { bookPath: BOOK, trashName: TRASH }).ok, true);
  assert.equal(store.take(third, { bookPath: BOOK, trashName: TRASH }).ok, true);

  const expiring = makeStore({ maxEntries: 5 });
  issueOne(expiring.store);
  issueOne(expiring.store);
  assert.equal(expiring.store.size(), 2);
  expiring.advance(tokenLib.DEFAULT_TTL_MS);
  assert.equal(expiring.store.size(), 0, 'size() 只算未过期的');
});

test('撤销凭证：脏参数不发凭证（缺书路径 / 缺备份名 / 非字符串 / 超长）', () => {
  const { store } = makeStore();
  const bad = [
    {},
    { bookPath: '', trashName: TRASH },
    { bookPath: BOOK, trashName: '' },
    { bookPath: BOOK, trashName: '   ' },
    { bookPath: 42, trashName: TRASH },
    { bookPath: BOOK, trashName: 'x'.repeat(tokenLib.MAX_TRASH_NAME_CHARS + 1) },
    null,
    'payload',
    []
  ];
  for (const input of bad) {
    assert.equal(store.issue(input), '', `脏参数不发证书：${JSON.stringify(input)}`);
  }
  assert.equal(store.size(), 0);
});

test('撤销凭证：错误对象带 code = RESTORE_TOKEN_INVALID 与中文文案，四种原因都有话', () => {
  for (const reason of ['unknown', 'expired', 'book-mismatch', 'trash-mismatch', 'something-else']) {
    const err = tokenLib.errorFor(reason);
    assert.equal(err.code, 'RESTORE_TOKEN_INVALID');
    assert.equal(typeof err.message, 'string');
    assert.ok(err.message.length > 0);
    assert.equal(/[\\/]/.test(err.message), false, '文案里不能带路径');
  }
  assert.match(tokenLib.errorFor('expired').message, /过期/);
  assert.match(tokenLib.errorFor('book-mismatch').message, /不属于这本书/);
  assert.equal(tokenLib.errorFor('something-else').message, tokenLib.REASON_MESSAGES.unknown);
});

test('撤销凭证：默认参数是 10 分钟 / 500 条（作业卡口径：比撤销条 10 秒长）', () => {
  assert.equal(tokenLib.DEFAULT_TTL_MS, 10 * 60 * 1000);
  assert.equal(tokenLib.DEFAULT_MAX_ENTRIES, 500);
  const store = tokenLib.createStore();
  assert.equal(store.ttlMs, tokenLib.DEFAULT_TTL_MS);
  assert.equal(store.maxEntries, tokenLib.DEFAULT_MAX_ENTRIES);
  assert.equal(store.size(), 0);
  store.clear();
});