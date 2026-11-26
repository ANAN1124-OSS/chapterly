// MAIN-03（审计拆分评估）：chapter:save 下沉 ipc/save.js —— 域装配 / mutation / 保存链路行为。
//
// 旧结构：chapter:save 连同 expectedStamp / 每日快照 / 索引标脏 / 统计增量 / recentBook /
// lastSaveAt 整段留在 main.js 的 registerIpc()，保存链路只能从句 main.js 抠源码做静态断言。
//
// 这里用假 host 装配真实的 ipc/save.js：
//   ① register() 只登记 chapter:save，且显式带 MUTATION.SAVE；
//   ② REQUIRED_HOST 缺成员在装配期直接 TypeError（A8 口径）；
//   ③ 行为：prepareChapterSave 的 stamp / saveChapterText / writeBookMeta（rotateBak + expectedStamp）/
//      索引标脏 / 统计增量 / recentBook / lastSaveAt 全链路；META_CHANGED 与 META_SAVE_FAILED 的
//      抛错字段（mtimeMs / bodySaved / chars / file）与搬前一致。
//
// 说明：handler 直接 throw 给 handleBook 包装器（真实 fail() 在 Electron 主进程里）；回包形状由
// chapter-save-partial / save-preconditions 的静态闸门与 E2E 覆盖，这里钉「搬家后宿主依赖齐全」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const saveIpc = require('../ipc/save');
const { MUTATION } = require('../ipc/book-mutations');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

function makeHost(overrides = {}) {
  const channels = new Map();
  const calls = {
    prepare: [],
    recheck: [],
    save: [],
    writeMeta: [],
    dirty: [],
    recent: [],
    stats: [],
    touched: [],
    order: []
  };
  const session = { id: 7 };
  const meta = {
    id: 'b1',
    title: '演练',
    chapters: [{ id: 'c1', name: '第一章', file: '001.md', chars: 4 }]
  };
  const chapter = meta.chapters[0];
  const host = {
    handleBook: (channel, fn, options) => channels.set(channel, { fn, options }),
    assertText: (text) => {
      if (typeof text !== 'string') throw Object.assign(new Error('正文必须是文本'), { code: 'BAD_TEXT' });
      return text;
    },
    flowSession: () => session,
    storage: {
      withBookLock: async (bookPath, fn) => fn(),
      prepareChapterSave: async (bookPath, chapterId, options) => {
        calls.prepare.push({ bookPath, chapterId, options });
        return { meta, chapter, metaStamp: 'stamp-1' };
      },
      loadChapterText: async () => ({ text: '旧文' }),
      takeDailySnapshot: async () => ({ taken: true, reason: 'OK', dir: 'snap', file: chapter.file, bytes: 1, cleanup: null }),
      recheckChapterSaveTarget: async (bookPath, checkedChapter, expectedMtimeMs) => {
        calls.recheck.push({ bookPath, chapter: checkedChapter, expectedMtimeMs });
        calls.order.push('recheck');
      },
      saveChapterText: async (bookPath, file, body, options) => {
        calls.save.push({ bookPath, file, body, options });
        calls.order.push('save');
        return { mtimeMs: 1234, chars: 6, bytes: 6 };
      },
      writeBookMeta: async (bookPath, written, options) => {
        calls.writeMeta.push({ bookPath, written, options });
      },
      openBookRegistry: { touch: (id) => calls.touched.push(id) }
    },
    getConfig: async () => ({
      snapshotEnabled: false,
      snapshotKeepDays: 7,
      dailyGoal: 2000,
      writeDurationEnabled: false
    }),
    chaptersLib: { countChars: (text) => text.length },
    statsLib: {
      saveCharsDelta: () => ({ delta: 2, baselineMissing: false }),
      recordSaveChars: async (store, payload) => {
        calls.stats.push(payload);
        return { ok: true, recorded: { added: 2, day: payload.day, stats: { version: 1, days: {} } } };
      },
      localDayKey: () => '2026-11-22'
    },
    errorText: { describeForUi: (err) => ({ message: String((err && err.message) || err) }) },
    logError: (...args) => {
      calls.logError = (calls.logError || []).concat([args]);
    },
    getStatsStore: () => ({ record: async () => ({}) }),
    getSearchIndexStore: () => ({ markDirty: (bookPath) => calls.dirty.push(bookPath) }),
    statsSummaryPayload: () => ({ summary: true }),
    rememberRecentBook: async (bookPath, info) => calls.recent.push({ bookPath, info }),
    ...overrides
  };
  saveIpc.register(host);
  return { channels, calls, meta, chapter, session };
}

test('MAIN-03：ipc/save.js 只注册 chapter:save，显式带 MUTATION.SAVE', () => {
  const { channels } = makeHost();
  assert.deepEqual([...channels.keys()], ['chapter:save'], '保存域只能登记 chapter:save');
  assert.deepEqual(channels.get('chapter:save').options, { mutation: MUTATION.SAVE }, 'chapter:save 必须带 MUTATION.SAVE');
});

test('MAIN-03：host 缺成员在 register() 装配期直接 TypeError（A8 口径）', () => {
  assert.throws(
    () => saveIpc.register({ handleBook() {} }),
    /ipc\/save\.registerSaveIpc 的 host 缺少/,
    '缺依赖必须炸在装配阶段'
  );
});

test('MAIN-03：保存链路（stamp / rotateBak / 索引标脏 / 统计 / recentBook / lastSaveAt）', async () => {
  const { channels, calls, meta, chapter, session } = makeHost();
  const result = await channels.get('chapter:save').fn('D:\\书库\\书', 'c1', '新正文', 555);

  assert.equal(result.file, '001.md');
  assert.equal(result.chars, 6);
  assert.equal(result.mtimeMs, 1234);
  assert.equal(result.statsDelta, 2);
  assert.equal(result.statsError, null);
  assert.equal(result.charsBaselineMissing, false);
  assert.deepEqual(result.snapshot, {
    taken: false,
    reason: 'DISABLED',
    dir: null,
    file: '001.md',
    bytes: 0,
    cleanup: null
  });
  assert.deepEqual(calls.prepare[0].options, { windowId: 7, expectedMtimeMs: 555 }, 'prepareChapterSave 要带窗口与 expectedMtimeMs');
  assert.deepEqual(
    calls.recheck[0],
    { bookPath: 'D:\\书库\\书', chapter, expectedMtimeMs: 555 },
    'SAVE-01：写盘前必须用同一份章节记录 / expectedMtimeMs 再核一次窗口'
  );
  assert.deepEqual(calls.order, ['recheck', 'save'], 'SAVE-01：复核必须在 saveChapterText 之前');
  assert.deepEqual(calls.save[0], {
    bookPath: 'D:\\书库\\书',
    file: '001.md',
    body: '新正文',
    options: { ensureDir: false }
  });
  assert.deepEqual(calls.writeMeta[0].options, {
    ensureDir: false,
    rotateBak: true,
    expectedStamp: 'stamp-1'
  }, '写书目必须带 rotateBak + 读到的 metaStamp');
  assert.equal(meta.chapters[0].chars, 6, '内存书目字数同步为落盘结果');
  assert.deepEqual(calls.dirty, ['D:\\书库\\书'], '正文落盘后给搜索索引标脏');
  assert.deepEqual(calls.stats[0], { day: '2026-11-22', bookId: 'b1', delta: 2 });
  assert.deepEqual(calls.recent[0], {
    bookPath: 'D:\\书库\\书',
    info: { title: '演练', chapterId: 'c1', chapterIndex: 0, chapterName: '第一章' }
  });
  assert.deepEqual(calls.touched, [7], '打开登记要 touch 当前窗口');
  assert.ok(Number.isFinite(session.lastSaveAt) && session.lastSaveAt > 0, '保存成功要留关窗回执时间');
  assert.deepEqual(result.stats, { summary: true });
});

test('MAIN-03：META_CHANGED 抛错带 mtimeMs（正文已落盘，书目不覆盖外部版本）', async () => {
  const conflict = Object.assign(new Error('书目被外部改了'), { code: 'META_CHANGED' });
  const { channels } = makeHost({
    storage: {
      withBookLock: async (bookPath, fn) => fn(),
      prepareChapterSave: async () => ({
        meta: { id: 'b1', title: '演练', chapters: [{ id: 'c1', name: '第一章', file: '001.md', chars: 4 }] },
        chapter: { id: 'c1', name: '第一章', file: '001.md', chars: 4 },
        metaStamp: 'stamp-1'
      }),
      loadChapterText: async () => ({ text: '旧文' }),
      recheckChapterSaveTarget: async () => {},
      takeDailySnapshot: async () => ({ taken: true }),
      saveChapterText: async () => ({ mtimeMs: 1234, chars: 6, bytes: 6 }),
      writeBookMeta: async () => {
        throw conflict;
      },
      openBookRegistry: { touch: () => {} }
    }
  });
  await assert.rejects(
    () => channels.get('chapter:save').fn('D:\\书库\\书', 'c1', '新正文', 555),
    (err) => {
      assert.equal(err.code, 'META_CHANGED');
      assert.equal(err.mtimeMs, 1234, 'META_CHANGED 要带正文落盘后的 mtime');
      assert.match(err.message, /正文已写入磁盘，但书目在保存途中被应用外的程序改过/);
      return true;
    }
  );
});

test('MAIN-03：META_SAVE_FAILED 部分成功带 bodySaved / chars / file / mtimeMs', async () => {
  const { channels } = makeHost({
    storage: {
      withBookLock: async (bookPath, fn) => fn(),
      prepareChapterSave: async () => ({
        meta: { id: 'b1', title: '演练', chapters: [{ id: 'c1', name: '第一章', file: '001.md', chars: 4 }] },
        chapter: { id: 'c1', name: '第一章', file: '001.md', chars: 4 },
        metaStamp: 'stamp-1'
      }),
      loadChapterText: async () => ({ text: '旧文' }),
      recheckChapterSaveTarget: async () => {},
      takeDailySnapshot: async () => ({ taken: true }),
      saveChapterText: async () => ({ mtimeMs: 1234, chars: 6, bytes: 6 }),
      writeBookMeta: async () => {
        throw Object.assign(new Error('EACCES: 书目.json 写不进去'), { code: 'EACCES' });
      },
      // A2-STORAGE-03：书目失败后的定点 chars 补写（真实存储层的尽力而为；这里同样失败也不影响回包）
      persistCharsAfterFailure: async () => {},
      openBookRegistry: { touch: () => {} }
    }
  });
  await assert.rejects(
    () => channels.get('chapter:save').fn('D:\\书库\\书', 'c1', '新正文', 555),
    (err) => {
      assert.equal(err.code, 'META_SAVE_FAILED');
      assert.equal(err.bodySaved, true);
      assert.equal(err.chars, 6);
      assert.equal(err.file, '001.md');
      assert.equal(err.mtimeMs, 1234);
      return true;
    }
  );
});

test('MAIN-03：接线闸门 —— main.js 只装配，channel:save 的注册点只在 ipc/save.js', () => {
  const main = read('main.js');
  const save = read('ipc/save.js');
  assert.match(main, /const ipcSave = require\('\.\/ipc\/save'\);/, 'main.js 要引保存域');
  assert.match(main, /ipcSave\.register\(domainHost\);/, 'registerIpc() 要装配保存域');
  assert.equal(main.includes("handleBook('chapter:save'"), false, 'chapter:save 不许回潮 main.js');
  assert.match(save, /handleBook\('chapter:save'/, 'ipc/save.js 要自己登记 chapter:save');
  assert.match(save, /require\('\.\/book-mutations'\)/, '保存域要引 mutation 常量表');
});
