// 审计修复 #55（M7 / M8）：可维护性小项的行为与静态闸门。
//
// M7：config.get() / set() / rememberLastBook() 返回的配置是深拷贝 —— 嵌套对象（windowBounds /
//     bookDisplay / findBookmarks / formatOptions / lastBook / proofreadWordlists / 高版本未知键）
//     与缓存不共享引用，调用方就地改不会污染下一次读取。
// M8：common.mapLimit 任一任务失败后，其余 worker 不再领新任务（在飞的那几个照常结束）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const common = require('../core/common');
const { createConfigStore, DEFAULTS } = require('../core/config');
const { writeJsonAtomic } = require('../core/atomic');

async function mkTmp(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('M7：config.get() 返回深拷贝——嵌套对象逐个不共享引用', async () => {
  const dir = await mkTmp('cw-config-deep-');
  try {
    const store = createConfigStore(dir);
    await store.set({
      windowBounds: { x: 10, y: 20, width: 1280, height: 800, maximized: false },
      bookDisplay: { b_m7: { editorFontSize: 22 } },
      proofreadWordlists: ['D:\\词表\\甲.txt']
    });
    await store.upsertFindBookmark({ bookId: 'b_m7', chapterId: 'ch_1', query: '青柠', caseSensitive: false });
    assert.equal((await store.rememberLastBook(
      { path: 'D:\\书\\M7', title: 'M7', chapterId: 'ch_1' },
      { now: 1_234_567_890 }
    )).written, true);

    const first = await store.get();
    const second = await store.get();
    assert.notEqual(first, second);
    for (const key of ['windowBounds', 'bookDisplay', 'findBookmarks', 'formatOptions', 'lastBook', 'proofreadWordlists']) {
      assert.notEqual(first[key], second[key], `get() 的 ${key} 不能与上一次返回的共享引用`);
    }
    assert.notEqual(first.bookDisplay.b_m7, second.bookDisplay.b_m7, 'bookDisplay 的每本书条目也要复制');
    assert.notEqual(first.findBookmarks[0], second.findBookmarks[0], '书签条目也要复制');

    // 就地改嵌套：不能影响下一次 get()，也不能影响写盘后的配置
    first.windowBounds.width = 9999;
    first.bookDisplay.b_m7.editorFontSize = 30;
    first.findBookmarks[0].query = '被改了';
    first.lastBook.chapterId = '被改了';
    first.proofreadWordlists.push('D:\\词表\\乙.txt');
    first.formatOptions.curlyQuotes = true;

    const third = await store.get();
    assert.equal(third.windowBounds.width, 1280);
    assert.equal(third.bookDisplay.b_m7.editorFontSize, 22);
    assert.equal(third.findBookmarks[0].query, '青柠');
    assert.equal(third.lastBook.chapterId, 'ch_1');
    assert.deepEqual(third.proofreadWordlists, ['D:\\词表\\甲.txt']);
    assert.equal(third.formatOptions.curlyQuotes, DEFAULTS.formatOptions.curlyQuotes);
    assert.equal((await store.getBookDisplay('b_m7')).editorFontSize, 22, 'getBookDisplay 也读不到被就地改坏的值');

    // set / rememberLastBook 的返回值同样不与 cache 共享嵌套
    const setResult = await store.set({ dailyGoal: 120 });
    setResult.windowBounds.width = 1;
    setResult.bookDisplay.b_m7.editorFontSize = 99;
    assert.equal((await store.get()).windowBounds.width, 1280);
    assert.equal((await store.get()).bookDisplay.b_m7.editorFontSize, 22);

    const remembered = await store.rememberLastBook(
      { path: 'D:\\书\\M7', title: 'M7', chapterId: 'ch_2' },
      { now: 1_800_000_000_000 }
    );
    assert.equal(remembered.written, true);
    remembered.config.lastBook.chapterId = '被改了';
    assert.equal((await store.get()).lastBook.chapterId, 'ch_2');
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('M7：高版本配置透传的未知顶层键也深拷贝（嵌套数组 / 对象）', async () => {
  const dir = await mkTmp('cw-config-deep-unknown-');
  try {
    await writeJsonAtomic(path.join(dir, 'config.json'), {
      configVersion: 2,
      dailyGoal: 500,
      futureFlag: { nested: { list: [1, 2] } }
    });
    const store = createConfigStore(dir);
    const first = await store.get();
    assert.deepEqual(first.futureFlag, { nested: { list: [1, 2] } }, '未知键要原样透传');
    first.futureFlag.nested.list.push(9);
    const second = await store.get();
    assert.deepEqual(second.futureFlag, { nested: { list: [1, 2] } }, '就地改未知键的嵌套不能污染缓存');
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('M7 静态闸门：get / set / rememberLastBook 不再返回 {...cache} 浅拷贝', () => {
  const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'core', 'config.js'), 'utf8');
  assert.match(source, /function cloneConfig\(cfg\)/, '深拷贝必须只有 cloneConfig 这一份实现');
  assert.match(source, /return cloneConfig\(cache\);/, 'get() 必须走 cloneConfig');
  assert.equal(/return \{ \.\.\.cache \};/.test(source), false, '返回给调用方的配置不许再用 {...cache} 浅拷贝');
});

test('M8：mapLimit 任一任务失败后，其余 worker 不再领新任务', async () => {
  const seen = [];
  let releaseSlow;
  const gate = new Promise((resolve) => { releaseSlow = resolve; });
  const items = Array.from({ length: 60 }, (_, index) => index);
  const pending = common.mapLimit(items, 3, async (n) => {
    seen.push(n);
    if (n === 0) throw new Error('首项失败');
    if (n === 1) await gate; // 让一个 worker 停在「在飞」状态
    return n;
  });
  await assert.rejects(pending, /首项失败/);
  const atReject = seen.length;
  assert.ok(atReject <= 3, `失败时最多只有已开始的几个任务（实际 ${atReject}）`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(seen.length, atReject, '失败之后不能再开始新任务（以前会把剩下 50+ 个全跑完）');
  assert.equal(seen.includes(59), false, '尾部的任务不能被领');
  releaseSlow();
  await common.sleep(10);
});

test('M8：失败前已经完成的结果不受影响，成功路径语义不变', async () => {
  const out = await common.mapLimit([1, 2, 3, 4], 2, async (n) => n * 2);
  assert.deepEqual(out, [2, 4, 6, 8]);
  // 失败任务之后的条目不再跑；已完成的仍按原下标放在 results 里（整体 reject，调用方拿不到，
  // 这里用计数器钉住「不再开始新的」这一条即可）
  let started = 0;
  await assert.rejects(
    common.mapLimit([0, 1, 2, 3, 4, 5], 2, async (n) => {
      started += 1;
      if (n === 0) throw new Error('boom');
      return n;
    }),
    /boom/
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(started <= 3, `失败后不该继续跑完（实际开始 ${started} 个）`);
});