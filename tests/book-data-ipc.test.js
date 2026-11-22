// 审计修复 #38（▲V306、O6）：书域数据频道下沉 + mutation 常量表 + chapter:save 广播。
//
// 旧结构：书域数据面（查找替换 / 历史还原 / 整本整理 / 清快照 / 打开书文件夹）12+1 个频道留在
// main.js，与 ipc/book.js 的 CRUD 分居两处；mutation 只靠人眼记得带 —— O6（chapter:save 不广播
// shelf:changed，跨窗口书架字数滞后）就是漏标的产物。
//
// 这里锁四件事：
//   ① 真实装配 ipc/book-data.js：频道清单 / 顺序 / 注册器 / 每种 mutation 与搬前一致；
//   ② 书域两个模块的每条 handleBook 都显式选 MUTATION.X 或 READ_ONLY（不许再靠省略参数表达只读）；
//   ③ 行为：查找替换仍过 ipc-limits 清洗、整理进度仍走 sendToFlow、打开书文件夹仍先 stat、
//      清快照仍只认快照目录并拒绝联接 / 回收站失败如实报错；
//   ④ 接线：13 个频道不许回潮 main.js；chapter:save 带上 MUTATION.SAVE；handleBook 的广播语义
//      （有 mutation 才广播、book:set-last 是唯一例外）由运行真实包装函数验证。
//   WP4（审计 S-N1）新增 1 个频道（清理计划），数据面变 14 个 —— 下面清单 / 计数同步。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const MAIN = read('main.js');

const bookDataIpc = require('../ipc/book-data');
const bookIpc = require('../ipc/book');
const mutations = require('../ipc/book-mutations');
const { MUTATION, MUTATION_VALUES, READ_ONLY } = mutations;

const DATA_CHANNELS = [
  'book:search',
  'book:replace',
  'book:list-replace-backups',
  'book:restore-replace-backup',
  'book:list-history',
  'book:preview-history-file',
  'book:restore-history-file',
  'book:restore-history-dir',
  'book:plan-delete-history-backups',
  'book:delete-history-backups',
  'book:clear-snapshot-day',
  'book:format-preview',
  'book:format',
  'shell:open-book-folder'
];

// 装配真实 ipc/book-data.js：handleBook 记下频道 / 回调 / 第三个参数，其余宿主用最小桩。
function makeBookDataHost(overrides = {}) {
  const channels = new Map();
  const sent = [];
  const host = {
    handleBook: (channel, fn, options) => channels.set(channel, { fn, options }),
    storage: {
      searchBook: async () => ({ results: [] }),
      replaceInBook: async () => ({ chaptersChanged: 0 }),
      listReplaceBackups: async () => ({ backups: [] }),
      restoreReplaceBackup: async () => ({ ok: true }),
      listBookHistory: async () => ({ groups: [] }),
      previewHistoryFile: async () => ({ text: '' }),
      restoreHistoryFile: async () => ({ ok: true }),
      restoreHistoryGroup: async () => ({ ok: true }),
      // WP4（S-N1）：清理分两步 —— 计划（只读解析）+ 执行（带令牌、只进回收站）。
      planHistoryBackupDeletion: async () => ({ cleanable: [], skipped: [], groupCount: 0, totalBytes: 0 }),
      deleteHistoryBackups: async () => ({ ok: true }),
      snapshotDirForClear: () => path.join('D:\\书库\\书', '_trash', '快照-20260101'),
      // I3（三审）：清快照也包进书锁（同域删除 / 还原走 lockedWriteEntry 的同一把锁）
      withBookLock: (bookPath, task) => task(),
      StorageError: class StorageError extends Error {
        constructor(code, message) {
          super(message);
          this.code = code;
        }
      },
      previewFormatBook: async () => ({ chaptersChanged: 0 }),
      formatBook: async () => ({ chaptersChanged: 0 })
    },
    ipcLimits: {
      sanitizeSearchOptions: (value) => ({ sanitized: true, kind: 'search', value }),
      sanitizeReplaceOptions: (value) => ({ sanitized: true, kind: 'replace', value })
    },
    fs: {
      lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
      stat: async () => ({ isDirectory: () => true })
    },
    path,
    shell: { trashItem: async () => {}, openPath: async () => '' },
    errorText: {
      describeForUi: (err) => ({ message: String((err && err.message) || err) }),
      cleanText: (text) => String(text == null ? '' : text),
      redactPaths: (text) => String(text == null ? '' : text)
    },
    sendToFlow: (channel, payload) => sent.push({ channel, payload }),
    ...overrides
  };
  bookDataIpc.register(host);
  return { channels, sent };
}

function optionsOf(channels, channel) {
  const entry = channels.get(channel);
  assert.ok(entry, `ipc/book-data.js 没有注册 ${channel}`);
  return entry.options;
}

function mutationOf(channels, channel) {
  const options = optionsOf(channels, channel);
  assert.ok(options && typeof options === 'object', `${channel} 必须显式传第三个参数（mutation / READ_ONLY）`);
  return options.mutation;
}

// 用 Proxy 装配真实 ipc/book.js：只记录 handleBook 的频道与第三个参数（处理函数不执行）。
function registerBookCrudSpies() {
  const channels = new Map();
  const host = new Proxy(
    {},
    {
      get(target, key) {
        if (key === 'handle') return () => {};
        if (key === 'handleBook') return (channel, fn, options) => channels.set(channel, options);
        return () => {};
      },
      has: () => true
    }
  );
  bookIpc.register(host);
  return channels;
}

test('mutation 常量表：六个写值 + READ_ONLY（null），全部冻结', () => {
  assert.deepEqual(MUTATION_VALUES.slice().sort(), ['delete', 'format', 'rename', 'replace', 'save', 'write']);
  assert.equal(Object.isFrozen(MUTATION), true, 'MUTATION 要冻结（防止运行期被改）');
  assert.equal(Object.isFrozen(READ_ONLY), true, 'READ_ONLY 要冻结');
  assert.equal(READ_ONLY.mutation, null, 'READ_ONLY 的语义仍是「不写、不广播」');
});

// I6（三审·低）：main.js 的 capture:commit-record 是产品代码里最后一个手写 mutation 字面量的
// handleBook 注册点。收编常量表后「改表漏改一处」不再可能静默发生 —— 这里用机器清单钉住：
//   · main.js 必须 require 常量表，注册点必须用 MUTATION.WRITE；
//   · 所有产品代码（main + 5 个 ipc 域模块）不许再出现 mutation 字面量。
test('I6（三审）：capture:commit-record 也走 MUTATION 常量表，产品代码不再有 mutation 字面量', () => {
  assert.ok(
    MAIN.includes("const { MUTATION } = require('./ipc/book-mutations');"),
    'main.js 要引用 ipc/book-mutations 的常量表'
  );
  const start = MAIN.indexOf("handleBook('capture:commit-record'");
  assert.ok(start > 0, 'main.js 里找不到 capture:commit-record');
  assert.ok(
    MAIN.indexOf('}, { mutation: MUTATION.WRITE });', start) > start,
    'capture:commit-record 的收尾必须是 { mutation: MUTATION.WRITE }（不许回到字面量）'
  );
  const LITERAL = /mutation: '(save|write|rename|delete|replace|format)'/;
  assert.equal(LITERAL.test(MAIN), false, 'main.js 不许再写 mutation 字面量');
  for (const file of ['ipc/book.js', 'ipc/book-data.js', 'ipc/save.js', 'ipc/export.js', 'ipc/proofread.js']) {
    assert.equal(LITERAL.test(read(file)), false, `${file} 不许再写 mutation 字面量（取值只从常量表来）`);
  }
});

test('ipc/book-data.js：14 个频道的清单 / 顺序 / 注册器 / mutation 与搬前一致（WP4 增清理计划频道）', () => {
  const { channels } = makeBookDataHost();
  assert.deepEqual(Array.from(channels.keys()), DATA_CHANNELS, '频道清单 / 顺序变了（与 main.js:2010-2110 搬前一致；WP4 在删除前插入计划频道）');
  const expected = {
    'book:search': null,
    'book:replace': MUTATION.REPLACE,
    'book:list-replace-backups': null,
    'book:restore-replace-backup': MUTATION.REPLACE,
    'book:list-history': null,
    'book:preview-history-file': null,
    'book:restore-history-file': MUTATION.WRITE,
    'book:restore-history-dir': MUTATION.WRITE,
    'book:plan-delete-history-backups': null,
    'book:delete-history-backups': MUTATION.WRITE,
    'book:clear-snapshot-day': MUTATION.WRITE,
    'book:format-preview': null,
    'book:format': MUTATION.FORMAT,
    'shell:open-book-folder': null
  };
  for (const channel of DATA_CHANNELS) {
    assert.equal(mutationOf(channels, channel), expected[channel], `${channel} 的 mutation 变了`);
  }
});

test('MAIN-01：导出 / 校对域的 8 个 handleBook 也显式标 READ_ONLY（不再靠省略第三个参数）', () => {
  // 用与 registerBookCrudSpies 同一套 Proxy 装配：只记录 handleBook 的频道与第三个参数。
  const spyChannels = (moduleRel, registerName) => {
    const channels = new Map();
    const host = new Proxy(
      {},
      {
        get(target, key) {
          if (key === 'handle') return () => {};
          if (key === 'handleBook') return (channel, fn, options) => channels.set(channel, options);
          return () => {};
        },
        has: () => true
      }
    );
    const mod = require(moduleRel);
    assert.equal(typeof mod[registerName], 'function', `${moduleRel} 要导出 ${registerName}`);
    mod[registerName](host);
    return channels;
  };
  const exportChannels = spyChannels('../ipc/export', 'register');
  const proofreadChannels = spyChannels('../ipc/proofread', 'register');
  const all = [...exportChannels.keys()].map((name) => ({ file: 'ipc/export.js', name, options: exportChannels.get(name) }))
    .concat([...proofreadChannels.keys()].map((name) => ({ file: 'ipc/proofread.js', name, options: proofreadChannels.get(name) })));
  // 导出 6 条（plan / txt / epub / docx / 整本复制 / 复制本章）+ 校对 2 条（校对 / 敏感词预检）= 8
  assert.equal(all.length, 8, `导出 / 校对域 handleBook 数异常：${all.length}（应是 8）`);
  for (const item of all) {
    assert.ok(
      item.options && Object.prototype.hasOwnProperty.call(item.options, 'mutation'),
      `${item.file} 的 ${item.name} 没显式选 mutation / READ_ONLY`
    );
    assert.equal(item.options.mutation, null, `${item.file} 的 ${item.name} 只读正文 / 书目，应标 READ_ONLY`);
  }
  for (const channel of ['book:export-plan', 'book:export', 'book:proofread']) {
    assert.ok(all.some((item) => item.name === channel), `频道清单里缺少 ${channel}`);
  }
});

test('书域两个模块：每条 handleBook 都显式选 MUTATION.X 或 READ_ONLY（新增频道漏选就红）', () => {
  const dataChannels = makeBookDataHost().channels;
  const crudChannels = registerBookCrudSpies();
  const all = [
    ...Array.from(crudChannels.entries()).map(([name, options]) => ({ module: 'ipc/book.js', name, options })),
    ...Array.from(dataChannels.entries()).map(([name, entry]) => ({ module: 'ipc/book-data.js', name, options: entry.options }))
  ];
  // WP18（B2）：CRUD 侧新增 books:card（单本书卡，只读）→ 23 个 CRUD + 14 个数据面 = 37。
  assert.ok(all.length === 37, `书域频道数异常：${all.length}（23 个 CRUD + 14 个数据面）`);
  for (const item of all) {
    assert.ok(
      item.options && Object.prototype.hasOwnProperty.call(item.options, 'mutation'),
      `${item.module} 的 ${item.name} 没显式选 mutation / READ_ONLY（#38 起不许靠省略参数表达只读）`
    );
    assert.ok(
      item.options.mutation === null || MUTATION_VALUES.includes(item.options.mutation),
      `${item.module} 的 ${item.name} 用了常量表以外的 mutation：${item.options.mutation}`
    );
  }
  // 写频道必须带书锁 / 广播标记；抽查最危险的四个（v1.8.0 审计点名的那批写操作）
  for (const channel of ['book:replace', 'book:restore-history-dir', 'book:format', 'book:delete-history-backups']) {
    assert.notEqual(mutationOf(dataChannels, channel), null, `${channel} 是写操作，不许标只读`);
  }
  // 只读频道归位（以前靠省略参数 → 现在显式）
  for (const channel of ['book:verify', 'chapter:load', 'chapter:stat', 'book:open']) {
    assert.equal(crudChannels.get(channel).mutation, null, `${channel} 应显式标 READ_ONLY`);
  }
});

test('行为：查找 / 替换仍过 ipc-limits 清洗（原样把清洗结果交给 storage）', async () => {
  const seen = [];
  const { channels } = makeBookDataHost({
    storage: {
      searchBook: async (bookPath, options) => {
        seen.push({ op: 'search', bookPath, options });
        return { results: [{ chapterId: 'c1' }] };
      },
      replaceInBook: async (bookPath, options) => {
        seen.push({ op: 'replace', bookPath, options });
        return { chaptersChanged: 2 };
      },
      StorageError: class StorageError extends Error {}
    }
  });
  assert.deepEqual(await channels.get('book:search').fn('D:\\书库\\书', { query: '甲' }), {
    results: [{ chapterId: 'c1' }]
  });
  assert.deepEqual(await channels.get('book:replace').fn('D:\\书库\\书', { query: '甲', replacement: '乙' }), {
    chaptersChanged: 2
  });
  assert.deepEqual(seen[0], { op: 'search', bookPath: 'D:\\书库\\书', options: { sanitized: true, kind: 'search', value: { query: '甲' } } });
  assert.deepEqual(seen[1], {
    op: 'replace',
    bookPath: 'D:\\书库\\书',
    options: { sanitized: true, kind: 'replace', value: { query: '甲', replacement: '乙' } }
  });
});

test('行为：整本整理的进度仍走 format:progress、预检查只读原样透传', async () => {
  const sentinel = { chaptersChanged: 3, skippedTooLarge: [2] };
  const { channels, sent } = makeBookDataHost({
    storage: {
      previewFormatBook: async () => sentinel,
      formatBook: async (bookPath, options, onProgress) => {
        onProgress({ done: 1, total: 3 });
        onProgress({ done: 3, total: 3 });
        return { chaptersChanged: 3 };
      },
      StorageError: class StorageError extends Error {}
    }
  });
  assert.equal(await channels.get('book:format-preview').fn('D:\\书库\\书', {}), sentinel, '预览结果原样透传');
  const formatted = await channels.get('book:format').fn('D:\\书库\\书', {});
  assert.deepEqual(formatted, { chaptersChanged: 3 });
  assert.deepEqual(sent, [
    { channel: 'format:progress', payload: { done: 1, total: 3 } },
    { channel: 'format:progress', payload: { done: 3, total: 3 } }
  ]);
});

test('行为：打开书文件夹先 stat 确认目录（C6 原语义随频道搬走不丢）', async () => {
  const opened = [];
  const { channels } = makeBookDataHost({
    fs: {
      stat: async () => ({ isDirectory: () => false }),
      lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false })
    },
    shell: { openPath: async (value) => { opened.push(value); return ''; }, trashItem: async () => {} },
    storage: { StorageError: class StorageError extends Error { constructor(code, message) { super(message); this.code = code; } } }
  });
  await assert.rejects(() => channels.get('shell:open-book-folder').fn('D:\\书库\\有exe的文件夹'), (err) => {
    assert.equal(err.code, 'NOT_A_DIRECTORY');
    return true;
  });
  assert.deepEqual(opened, [], '不是目录时一个字节都不交给系统');

  const okHost = makeBookDataHost({
    fs: { stat: async () => ({ isDirectory: () => true }), lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }) },
    shell: { openPath: async (value) => { opened.push(value); return ''; }, trashItem: async () => {} },
    storage: { StorageError: class StorageError extends Error {} }
  });
  assert.equal(await okHost.channels.get('shell:open-book-folder').fn('D:\\书库\\书'), true);
  assert.deepEqual(opened, ['D:\\书库\\书']);
});

test('行为：清空某日快照只认快照目录、拒绝联接、回收站失败如实报错', async () => {
  const target = path.join('D:\\书库\\书', '_trash', '快照-20260101');
  const baseStore = {
    snapshotDirForClear: () => target,
    // I3（三审）：清快照包进书锁 —— 下面每个场景都要能过这一层（锁语义本身在最后一条用例里钉）
    withBookLock: (bookPath, task) => task(),
    StorageError: class StorageError extends Error {
      constructor(code, message) {
        super(message);
        this.code = code;
      }
    }
  };
  // 1) 目录不存在
  const missing = makeBookDataHost({
    storage: baseStore,
    fs: { lstat: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } }
  });
  await assert.rejects(() => missing.channels.get('book:clear-snapshot-day').fn('D:\\书库\\书', '快照-20260101'), (err) => {
    assert.equal(err.code, 'HISTORY_GROUP_MISSING');
    return true;
  });
  // 2) 联接 / 非目录：宁可不清
  const linked = makeBookDataHost({
    storage: baseStore,
    fs: { lstat: async () => ({ isDirectory: () => false, isSymbolicLink: () => false }) }
  });
  await assert.rejects(() => linked.channels.get('book:clear-snapshot-day').fn('D:\\书库\\书', '快照-20260101'), (err) => {
    assert.equal(err.code, 'SNAPSHOT_NOT_DIR');
    return true;
  });
  // 3) 回收站失败不降级成硬删
  const trashFail = makeBookDataHost({
    storage: baseStore,
    fs: { lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }) },
    shell: { trashItem: async () => { throw new Error('回收站被策略禁用'); }, openPath: async () => '' }
  });
  await assert.rejects(
    () => trashFail.channels.get('book:clear-snapshot-day').fn('D:\\书库\\书', '快照-20260101'),
    (err) => {
      assert.equal(err.code, 'SNAPSHOT_TRASH_FAILED');
      assert.match(err.message, /快照没有动/);
      return true;
    }
  );
  // 4) 成功：回 basename（不带路径）。审计修复 #53（R8）：内层不再自带 {ok:true} ——
  //    handleBook 的 ok() 包装已经给出唯一一份 ok 字段。
  const ok = makeBookDataHost({
    storage: baseStore,
    fs: { lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }) }
  });
  assert.deepEqual(await ok.channels.get('book:clear-snapshot-day').fn('D:\\书库\\书', '快照-20260101'), {
    dir: '快照-20260101'
  });

  // 5) I3（三审）：回收站动作必须在书锁内执行 —— 否则 chapter:save 在锁内往
  //    `_trash/快照-YYYYMMDD/` 复制上一版期间，本频道能把该目录整个移进回收站。
  const order = [];
  const lockedHost = makeBookDataHost({
    storage: {
      ...baseStore,
      withBookLock: async (bookPath, task) => {
        order.push(`lock:${bookPath}`);
        const result = await task();
        order.push('unlock');
        return result;
      }
    },
    fs: { lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }) },
    shell: { trashItem: async () => { order.push('trash'); }, openPath: async () => '' }
  });
  assert.deepEqual(await lockedHost.channels.get('book:clear-snapshot-day').fn('D:\\书库\\书', '快照-20260101'), {
    dir: '快照-20260101'
  });
  assert.deepEqual(order, ['lock:D:\\书库\\书', 'trash', 'unlock'], '删除动作必须在 withBookLock 内（I3）');
});

// WP4（审计 S-N1）：清理备份拆两步 —— 计划频道只读解析 + 发一次性令牌；删除频道不带令牌一律拒绝。
test('行为：清理计划只读 / 发令牌；执行必须带令牌，且删除动作只走主进程注入的 shell.trashItem', async () => {
  const trashed = [];
  const { channels } = makeBookDataHost({
    storage: {
      planHistoryBackupDeletion: async () => ({
        cleanable: [{ id: 'dir:替换备份-1', name: '替换备份-1', fileCount: 1, bytes: 9 }],
        skipped: [],
        groupCount: 1,
        totalBytes: 9,
        recoverable: true
      }),
      deleteHistoryBackups: async (bookPath, groupIds, options) => {
        await options.trash('D:\\书库\\书\\_trash\\替换备份-1');
        return { deletedGroups: 1, deletedBytes: 9, deleted: [], skipped: [] };
      },
      StorageError: class StorageError extends Error {
        constructor(code, message) {
          super(message);
          this.code = code;
        }
      }
    },
    shell: { trashItem: async (dir) => { trashed.push(dir); }, openPath: async () => '' }
  });
  const plan = await channels.get('book:plan-delete-history-backups').fn('D:\\书库\\书', ['dir:替换备份-1'], {});
  assert.equal(plan.groupCount, 1);
  assert.equal(plan.recoverable, true);
  assert.ok(plan.planToken, '计划频道必须回一次性令牌');
  assert.deepEqual(trashed, [], '计划只读：一个文件都不许动');

  await assert.rejects(
    () => channels.get('book:delete-history-backups').fn('D:\\书库\\书', ['dir:替换备份-1'], {}),
    (err) => err.code === 'DELETE_PLAN_INVALID'
  );
  assert.deepEqual(trashed, [], '没有令牌时一个文件都不动');

  const done = await channels.get('book:delete-history-backups').fn('D:\\书库\\书', ['dir:替换备份-1'], {
    planToken: plan.planToken
  });
  assert.equal(done.deletedGroups, 1);
  assert.deepEqual(trashed, ['D:\\书库\\书\\_trash\\替换备份-1'], '删除动作只走主进程注入的 shell.trashItem');
});

// 五-M29（IPC-02）：计划令牌要把「计划实际解析出的可清理集合」带到执行阶段 ——
// 只绑原始 groupIds 时，坏渲染层在确认框之后撤掉 protectedGroupIds，就能把确认时明示跳过的组
// 一起删掉。现在计划频道把 plan.cleanable 的 id 绑进令牌，执行频道把同一份集合交给 storage 复核。
test('五-M29（IPC-02）：执行阶段带上计划确认过的可清理集合，撤保护也删不到确认清单外', async () => {
  const calls = [];
  const { channels } = makeBookDataHost({
    storage: {
      planHistoryBackupDeletion: async () => ({
        cleanable: [{ id: 'dir:替换备份-1', name: '替换备份-1', fileCount: 1, bytes: 9 }],
        skipped: [{ id: 'dir:还原前备份-2', name: '还原前备份-2', reason: 'active-undo' }],
        groupCount: 1,
        totalBytes: 9,
        recoverable: true
      }),
      deleteHistoryBackups: async (bookPath, groupIds, options) => {
        calls.push({ bookPath, groupIds, options });
        return { deletedGroups: 0, deletedBytes: 0, deleted: [], skipped: [] };
      },
      StorageError: class StorageError extends Error {
        constructor(code, message) {
          super(message);
          this.code = code;
        }
      }
    },
    shell: { trashItem: async () => {}, openPath: async () => '' }
  });
  const groupIds = ['dir:替换备份-1', 'dir:还原前备份-2'];
  const plan = await channels.get('book:plan-delete-history-backups').fn('D:\\书库\\书', groupIds, {
    protectedGroupIds: ['dir:还原前备份-2']
  });
  // 执行时把 protectedGroupIds 撤掉（模拟坏渲染层）：groupIds 摘要一致，take 仍会通过
  await channels.get('book:delete-history-backups').fn('D:\\书库\\书', groupIds.slice().reverse(), {
    planToken: plan.planToken
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0].options.confirmedGroupIds,
    ['dir:替换备份-1'],
    '执行层只认计划确认过的可清理集合（不是原始 groupIds）'
  );
  assert.equal(calls[0].options.protectedGroupIds, undefined, '执行时确实没再带保护列表（模拟撤保护）');
});

// 从 main.js 切出真实的 handleBook 包装函数（括号 / 函数体按层级配平），放进假作用域执行。
function loadHandleBookWrapper() {
  const start = MAIN.indexOf('function handleBook(');
  assert.ok(start > 0, 'main.js 里找不到 handleBook');
  const open = MAIN.indexOf('(', start);
  let depth = 0;
  let paramEnd = -1;
  for (let i = open; i < MAIN.length; i += 1) {
    if (MAIN[i] === '(') depth += 1;
    else if (MAIN[i] === ')') {
      depth -= 1;
      if (depth === 0) {
        paramEnd = i;
        break;
      }
    }
  }
  const bodyStart = MAIN.indexOf('{', paramEnd);
  depth = 0;
  for (let i = bodyStart; i < MAIN.length; i += 1) {
    if (MAIN[i] === '{') depth += 1;
    else if (MAIN[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        const source = MAIN.slice(start, i + 1);
        const factory = new Function(
          'ipcMain',
          'sessionOfSender',
          'fail',
          'runInWindowFlow',
          'getConfig',
          'assertBookPath',
          'storage',
          'notifyShelfChanged',
          'ok',
          // S3（一轮·低）：handleBook 多了一道 realpath 复核（core/ipc-paths.assertRealBookPath）。
          // 断言跟错：这段源码是 new Function 现拼的，新增的自由变量必须同时出现在参数表里。
          'ipcPaths',
          `${source}\nreturn handleBook;`
        );
        const handlers = new Map();
        const broadcasts = [];
        const session = { id: 7 };
        const wrapper = factory(
          { handle: (channel, fn) => handlers.set(channel, fn) },
          () => session,
          (err) => ({ ok: false, code: (err && err.code) || 'ERROR' }),
          (given, fn) => fn(),
          async () => ({ booksRoot: 'D:\\书库' }),
          (value) => value,
          { assertBookNotBusy: () => true },
          (givenSession, reason) => broadcasts.push({ sessionId: givenSession && givenSession.id, reason }),
          (value) => ({ ok: true, data: value }),
          // ipcPaths：文本判定由参数里的 assertBookPath 顶替，realpath 复核这里只记一笔（不碰真盘）
          { assertRealBookPath: async () => {} }
        );
        return { wrapper, handlers, broadcasts };
      }
    }
  }
  throw new Error('handleBook 函数体没有按预期闭合');
}

test('O6：chapter:save 带 MUTATION.SAVE（保存成功要广播 shelf:changed），频道不回潮 main.js', () => {
  const saveSource = read('ipc/save.js');
  const saveStart = saveSource.indexOf("handleBook('chapter:save'");
  assert.ok(saveStart > 0, 'ipc/save.js 里找不到 chapter:save');
  const saveEnd = saveSource.indexOf('\n  }, { mutation: MUTATION.SAVE });', saveStart);
  assert.ok(saveEnd > saveStart, 'chapter:save 必须带 { mutation: MUTATION.SAVE }（O6）');
  assert.ok(saveSource.includes("const { MUTATION } = require('./book-mutations');"), 'ipc/save.js 要引 mutation 常量表');
  assert.ok(MAIN.includes('ipcSave.register(domainHost);'), 'registerIpc() 要装配保存域');
  assert.equal(MAIN.includes("handleBook('chapter:save'"), false, 'chapter:save 不许回潮 main.js');
  for (const channel of DATA_CHANNELS) {
    assert.equal(MAIN.includes(`handleBook('${channel}'`), false, `main.js 里又出现了被搬走的频道：${channel}`);
  }
  assert.ok(read('ipc/book-data.js').includes('module.exports = { register: '), 'book-data 只导出 register');
});

// N2（二轮·低）：书名限长的唯一入口在 storage（core/limits.js），book:rename 只负责把
// 「这次被截短了」如实带回渲染层（渲染层据此提示作者，不静默改名）。
test('N2：book:rename 回包带 titleTruncated（与请求名比对，空请求 / 未截短都 false）', async () => {
  const channels = new Map();
  const MAX = require('../core/limits').MAX_BOOK_TITLE_CHARS;
  const storageStub = {
    // 与真实 storage.renameBook 同口径：写盘前按 core/limits 截断
    renameBook: async (bookPath, title) => ({ title: require('../core/limits').limitBookTitle(title) })
  };
  const host = new Proxy(
    {},
    {
      get(target, key) {
        if (key === 'handleBook') return (channel, fn, options) => channels.set(channel, { fn, options });
        if (key === 'handle') return () => {};
        if (key === 'storage') return storageStub;
        return () => {};
      },
      has: () => true
    }
  );
  bookIpc.register(host);
  const rename = channels.get('book:rename').fn;

  const long = await rename('D:\\书库\\书', '书'.repeat(MAX + 40));
  assert.equal(long.titleTruncated, true, '超长书名被截短 → true');
  assert.equal(long.title.length, MAX, '书名截到唯一上限');

  const normal = await rename('D:\\书库\\书', '新书名');
  assert.equal(normal.titleTruncated, false, '未截短 → false');
  assert.equal(normal.title, '新书名');

  const blank = await rename('D:\\书库\\书', '   ');
  assert.equal(blank.titleTruncated, false, '空请求 = 保持原书名（旧行为），不算截断');
  assert.equal(blank.title, '');
});

test('O6：handleBook 的广播语义（有 mutation 才广播；book:set-last 是唯一例外）', async () => {
  const { wrapper, handlers, broadcasts } = loadHandleBookWrapper();
  wrapper('chapter:save', async (bookPath) => ({ saved: bookPath }), { mutation: MUTATION.SAVE });
  const saved = await handlers.get('chapter:save')({}, 'D:\\书库\\书');
  assert.deepEqual(saved, { ok: true, data: { saved: 'D:\\书库\\书' } });
  assert.deepEqual(broadcasts, [{ sessionId: 7, reason: 'chapter:save' }], '保存成功要让其它书架窗口刷新');

  broadcasts.length = 0;
  wrapper('book:verify', async () => ({ ok: true }), READ_ONLY);
  await handlers.get('book:verify')({}, 'D:\\书库\\书');
  assert.deepEqual(broadcasts, [], '只读频道不广播');

  wrapper('book:set-last', async () => ({ ok: true }), { mutation: MUTATION.SAVE });
  await handlers.get('book:set-last')({}, 'D:\\书库\\书');
  assert.deepEqual(broadcasts, [], 'book:set-last 是唯一不广播的写频道（切章太频繁）');
});