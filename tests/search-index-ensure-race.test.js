// 2026-11-25 审计修复 · 正文索引 ensure 的两条中危（B2）：
//
// SEARCH-01：doEnsure 在 buildBookEntry 之前读「这本书脏不脏」，成功后在循环尾部无条件
//   `dirtyBooks.delete(key)`。同一本书正在建位图时另一窗口保存并 markDirty，标记会被这一趟的
//   delete 吞掉；这一趟尾部又按「脏集为空」重开 60 秒复用窗口 —— 下一次搜索直接用保存前的位图，
//   刚保存的正文被当「不匹配」滤掉（违反「位图只会误报、不会漏报」的不变量）。
//   修法：markDirty 递增每本书的脏版本；构建前取版本，成功后版本没变才清。
//   （五-M27 覆盖的是「这本书已经处理完、ensure 还没跑完」才标脏；这里补的是「同一本书正在处理途中」被标脏。）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const search = require('../core/search-index');
const storage = require('../core/storage');
const { normalizePath } = require('../core/path-utils');
const { mkTmp, makeBook, makeWorld } = require('./search-index-fixtures');

// 等一个「信号来了 / 超时」二选一。超时定时器必须清掉（并 unref），否则用例结束进程还会被它拖住。
function settleWithin(promise, timeoutMs) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise.then(() => true), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// SEARCH-01：33 章 = 建位图批大小（32）+ 1。第 2 批开始读正文时，第 1 批（含第 1 章）的正文已经全部
// 读完 —— 只有这时候落盘的保存才是「这一趟索引没读到的正文」，才谈得上漏报。夹具沿用
// tests/search-index-fixtures.js（临时目录 / 书目 / 双目录统一构造器）。
test('SEARCH-01：建索引途中被保存标脏的书不能被清脏（60 秒复用窗口内不许用旧位图漏搜）', async () => {
  const base = await mkTmp();
  const { userData, booksRoot } = await makeWorld(base);
  const chapters = [];
  for (let i = 1; i <= 33; i += 1) {
    chapters.push({ name: `第${i}章`, text: i === 1 ? '旧稿里的青柠色雨伞。' : `第${i}章正文。` });
  }
  const { bookPath, meta } = await makeBook(booksRoot, '在途书', '在途书', chapters);
  const firstChapterPath = path.join(bookPath, meta.chapters[0].file);
  const lastChapterFile = meta.chapters[meta.chapters.length - 1].file;

  // 把「第 2 批正文读取」按住：此时第 1 批正文已经进过内存，索引这一趟不会再读第 1 章。
  let releaseLastBatch;
  const lastBatchGate = new Promise((resolve) => {
    releaseLastBatch = resolve;
  });
  let lastBatchEntered;
  const lastBatchReached = new Promise((resolve) => {
    lastBatchEntered = resolve;
  });
  let heldOnce = false;
  const realLoadChapterText = storage.loadChapterText;
  storage.loadChapterText = async (book, file) => {
    if (!heldOnce && file === lastChapterFile) {
      heldOnce = true;
      lastBatchEntered();
      await lastBatchGate;
    }
    return realLoadChapterText(book, file);
  };

  // 非 0 的 validateIntervalMs：搜索侧 60 秒复用窗口生效（不这样的话每次搜索都会自己再校验一趟，
  // 把「复用旧位图」这条漏报路径掩掉）。
  const store = search.createSearchStore({ userDataDir: userData, validateIntervalMs: 60000 });
  let reached = false;
  let dirtyAfterEnsure;
  let found;
  try {
    const running = store.ensure({ booksRoot });
    reached = await settleWithin(lastBatchReached, 5000);
    if (reached) {
      // 第 1 批正文已读完；此刻作者保存第 1 章并标脏（与 ipc 保存成功后调 markDirty 同一入口）。
      await fs.writeFile(firstChapterPath, '旧稿里的青柠色雨伞。灯芯在风里晃了一下。', 'utf8');
      store.markDirty(bookPath);
    }
    releaseLastBatch();
    await running;
    dirtyAfterEnsure = store.dirtyList();
    found = await store.search({ booksRoot, query: '灯芯' });
  } finally {
    storage.loadChapterText = realLoadChapterText;
  }

  assert.equal(reached, true, '前提：建位图已经读到第 2 批（第 1 批正文读完）');
  assert.deepEqual(
    dirtyAfterEnsure,
    [normalizePath(bookPath)],
    '建索引途中标脏的书在 ensure 尾部不能被清掉（要留到下一趟校验）'
  );
  assert.ok(
    found.results.length >= 1,
    '保存后第一次搜索必须能搜到新正文 —— 建索引途中标的脏要留到下一趟，不许拿保存前的位图静默漏报'
  );
  assert.deepEqual(store.dirtyList(), [], '下一趟校验把脏标记消费掉');
});
