// M1（第一轮·低，第 12 轮第五刀）：「整本替换的备份还原」的**行为**锚点。
//
// 背景：refreshReplaceBackups + restoreReplaceBackupFlow（列备份 → 未保存拦截 → 长操作锁 → 还原 IPC →
// 从磁盘重载 → 书架刷新 → 10 秒撤销登记）以前长在 renderer.js 里，只有开 Electron 摆一本真书才测得到
// 「列完备份换了书还照还原」「未保存拦截取消后照样锁编辑区」这类时序。第 12 轮把整段搬进
// renderer/replace-backup-ui.js（renderer.js 只留一次装配 + 两个同名转发），这里用假 state + 桩 IPC
// 把每条分流逐条钉住，再用机器清单钉「实现只有一份、装配三处到位、活绑定没被传值冻住」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const replaceBackupUi = require('../renderer/replace-backup-ui');
const manifest = require('../renderer/assembly-manifest');
const { loadSourceGate, stripAssertHostBranch } = require('./ui-test-preambles');

const BOOK_A = '/书库/书甲';
const BOOK_B = '/书库/书乙';

function makeRow() {
  const classes = new Set(['hidden']);
  return {
    _classes: classes,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name)
    }
  };
}

// 假 host：可改的 state + 桩 IPC + 记下每次调用的桩。所有依赖按「调用时取值」给（换书 / 脏态可中途变）。
function makeHost(options = {}) {
  const calls = {
    list: [],
    restore: [],
    history: [],
    reloadDisk: [],
    shelf: 0,
    reloadAfter: [],
    progress: [],
    lock: [],
    undo: [],
    fingerprint: [],
    unchanged: [],
    toast: [],
    confirm: []
  };
  const state = {
    bookPath: options.bookPath === undefined ? BOOK_A : options.bookPath,
    dirty: Boolean(options.dirty),
    replaceBackups: options.replaceBackups === undefined ? [] : options.replaceBackups
  };
  const row = makeRow();
  const textEl = { textContent: '' };
  const host = {
    $: (id) => {
      if (id === 'find-backup-row') return row;
      if (id === 'find-backup-text') return textEl;
      throw new Error('意外的选择器：' + id);
    },
    state,
    api: { listReplaceBackups: 'book:list-replace-backups', restoreHistoryDir: 'book:restore-history-dir' },
    call: async (channel, ...rest) => {
      calls.list.push({ channel, rest });
      if (options.callError && channel === 'book:list-replace-backups') throw new Error('IPC 挂了');
      if (channel === 'book:list-replace-backups') {
        if (options.switchDuringList) state.bookPath = BOOK_B;
        if (options.listResult !== undefined) return options.listResult;
        const list = options.backups === undefined ? [] : options.backups;
        state.replaceBackups = list;
        return list;
      }
      if (channel === 'book:restore-history-dir') {
        calls.history.push(rest);
        if (options.historyError) throw options.historyError;
        return options.historyResult === undefined ? { restored: 2 } : options.historyResult;
      }
      throw new Error('意外的频道：' + channel);
    },
    toast: (text, kind) => calls.toast.push({ text, kind }),
    formatBytes: (n) => `${n}B`,
    longOpLocked: () => Boolean(options.locked),
    beginLongOpLock: () => calls.lock.push('begin'),
    endLongOpLock: () => calls.lock.push('end'),
    showFormatBookProgress: (text) => calls.progress.push(['show', text]),
    hideFormatBookProgress: () => calls.progress.push(['hide']),
    confirmRestoreWithUnsaved: async (message) => {
      calls.confirm.push(message);
      if (options.switchDuringConfirm) state.bookPath = BOOK_B;
      return options.unsavedResult === undefined ? { ok: true } : options.unsavedResult;
    },
    restoreBookOp: async (bookPath, backupName) => {
      calls.restore.push([bookPath, backupName]);
      if (options.restoreError) throw options.restoreError;
      return options.restoreData === undefined
        ? { restored: 3, skipped: 1, restoreBackupDir: '/书库/书甲/_trash/还原前备份-2026-11-22-1000' }
        : options.restoreData;
    },
    reloadOpenBookFromDisk: async (bookPath) => calls.reloadDisk.push(bookPath),
    refreshShelf: async () => {
      calls.shelf += 1;
    },
    reloadAfterPartialFailure: async (bookPath) => calls.reloadAfter.push(bookPath),
    backupGuard: {
      fingerprint: async (bookPath, name) => {
        calls.fingerprint.push([bookPath, name]);
        if (options.fingerprintError) throw options.fingerprintError;
        return { name };
      },
      assertUnchanged: async (bookPath, expected) => {
        calls.unchanged.push([bookPath, expected]);
        if (options.unchangedError) throw options.unchangedError;
      }
    },
    undoUi: {
      activate: (text, run, opts) => {
        calls.undo.push({ text, run, opts });
        if (options.runUndo) return run();
        return undefined;
      }
    },
    longOpLogic: { sameBookPath: (a, b) => a === b }
  };
  return { host, state, row, textEl, calls };
}

const BACKUPS = [
  { name: '替换备份-2026-11-22-0900', fileCount: 2, totalBytes: 120 },
  { name: '替换备份-2026-11-21-0900', fileCount: 3, totalBytes: 300 }
];

test('host 契约：19 个必填成员缺一个就抛 TypeError，模块头声明的成员数与之相等', () => {
  assert.deepEqual([...replaceBackupUi.REQUIRED_HOST].sort(), [
    '$', 'api', 'backupGuard', 'beginLongOpLock', 'call', 'confirmRestoreWithUnsaved', 'endLongOpLock',
    'formatBytes', 'hideFormatBookProgress', 'longOpLocked', 'longOpLogic', 'refreshShelf',
    'reloadAfterPartialFailure', 'reloadOpenBookFromDisk', 'restoreBookOp', 'showFormatBookProgress',
    'state', 'toast', 'undoUi'
  ]);
  const { host } = makeHost();
  assert.throws(() => replaceBackupUi.create(null), /createReplaceBackupUi 需要 host 对象/);
  assert.throws(() => replaceBackupUi.create('host'), /createReplaceBackupUi 需要 host 对象/);
  for (const key of replaceBackupUi.REQUIRED_HOST) {
    const broken = { ...host };
    delete broken[key];
    assert.throws(() => replaceBackupUi.create(broken), /缺少/, key);
    assert.throws(() => replaceBackupUi.create({ ...host, [key]: null }), /缺少/, key + '（null 也算缺）');
  }
  const ui = replaceBackupUi.create(host);
  assert.deepEqual(Object.keys(ui), ['refreshReplaceBackups', 'restoreReplaceBackupFlow'], '对外只暴露两个入口');
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'replace-backup-ui.js'), 'utf8');
  const claimed = /host 正好 (\d+) 个成员/.exec(src);
  assert.ok(claimed);
  assert.equal(claimed[1], String(replaceBackupUi.REQUIRED_HOST.length));
});

test('列备份：没开书 → 行隐藏、返回空数组、不发 IPC', async () => {
  const { host, state, row, calls } = makeHost({ bookPath: null, replaceBackups: BACKUPS });
  const got = await replaceBackupUi.create(host).refreshReplaceBackups();
  assert.deepEqual(got, []);
  assert.equal(state.replaceBackups.length, 0);
  assert.equal(row.classList.contains('hidden'), true);
  assert.equal(calls.list.length, 0, '没开书不许问主进程');
});

test('列备份：IPC 失败 / 空列表都保持静默（行隐藏、缓存清空、不抛）', async () => {
  const failed = makeHost({ callError: true });
  const gotFailed = await replaceBackupUi.create(failed.host).refreshReplaceBackups();
  assert.deepEqual(gotFailed, []);
  assert.equal(failed.row.classList.contains('hidden'), true);

  const empty = makeHost({ listResult: [] });
  const gotEmpty = await replaceBackupUi.create(empty.host).refreshReplaceBackups();
  assert.deepEqual(gotEmpty, []);
  assert.equal(empty.row.classList.contains('hidden'), true);
});

test('列备份：有备份 → 横幅写最近一次的目录名 / 文件数 / 体积，行显示', async () => {
  const { host, state, row, textEl } = makeHost({ backups: BACKUPS });
  const got = await replaceBackupUi.create(host).refreshReplaceBackups();
  assert.deepEqual(got, BACKUPS);
  assert.equal(state.replaceBackups, BACKUPS, '缓存要落到 state.replaceBackups 供还原选目标');
  assert.equal(row.classList.contains('hidden'), false);
  assert.equal(
    textEl.textContent,
    '最近一次整本替换的备份：替换备份-2026-11-22-0900（2 个文件，120B）'
  );
});

test('还原：没开书 / 长操作在途 都不动编辑区锁、不发还原 IPC', async () => {
  const noBook = makeHost({ bookPath: null });
  assert.deepEqual(await replaceBackupUi.create(noBook.host).restoreReplaceBackupFlow(), { ok: false });
  assert.equal(noBook.calls.toast[0].text, '还没有打开一本书');
  assert.deepEqual(noBook.calls.lock, []);

  const locked = makeHost({ locked: true });
  assert.deepEqual(await replaceBackupUi.create(locked.host).restoreReplaceBackupFlow(), {
    ok: false,
    busy: true
  });
  assert.equal(locked.calls.toast[0].text, '正在执行另一个长操作，请稍候');
  assert.equal(locked.calls.list.length, 0, '忙时连备份列表都不用列');
  assert.equal(locked.calls.restore.length, 0);
});

test('还原：列完备份发现换了书 → 取消；一个备份都没有 → 提示且不发 IPC', async () => {
  const switched = makeHost({ backups: BACKUPS, switchDuringList: true });
  assert.deepEqual(await replaceBackupUi.create(switched.host).restoreReplaceBackupFlow('替换备份-2026-11-22-0900'), {
    ok: false
  });
  assert.equal(switched.calls.toast[0].text, '已经换了书，取消还原');
  assert.equal(switched.calls.restore.length, 0);

  const none = makeHost({ backups: [] });
  assert.deepEqual(await replaceBackupUi.create(none.host).restoreReplaceBackupFlow(), { ok: false });
  assert.equal(none.calls.toast[0].text, '这本书里没有可还原的替换备份');
  assert.equal(none.calls.restore.length, 0);
});

test('还原：编辑区脏 → 先问；取消 / 保存失败都停在原地，绝不锁编辑区', async () => {
  const canceled = makeHost({ dirty: true, backups: BACKUPS, unsavedResult: { ok: false, canceled: true } });
  assert.deepEqual(await replaceBackupUi.create(canceled.host).restoreReplaceBackupFlow(), {
    ok: false,
    canceled: true
  });
  assert.equal(canceled.calls.confirm.length, 1);
  assert.equal(canceled.calls.lock.length, 0, '取消后不许锁编辑区');
  assert.equal(canceled.calls.restore.length, 0);

  const saveFailed = makeHost({
    dirty: true,
    backups: BACKUPS,
    unsavedResult: { ok: false, saved: { ok: false, message: '写盘失败' } }
  });
  assert.deepEqual(await replaceBackupUi.create(saveFailed.host).restoreReplaceBackupFlow(), {
    ok: false,
    message: '写盘失败'
  });
  assert.equal(saveFailed.calls.restore.length, 0);

  const switchedWhileAsking = makeHost({
    dirty: true,
    backups: BACKUPS,
    switchDuringConfirm: true,
    unsavedResult: { ok: true }
  });
  assert.deepEqual(await replaceBackupUi.create(switchedWhileAsking.host).restoreReplaceBackupFlow(), { ok: false });
  assert.equal(switchedWhileAsking.calls.toast[0].text, '已经换了书，取消还原');
  assert.equal(switchedWhileAsking.calls.restore.length, 0, '询问期间换书也不能还原旧书的备份');
});

test('还原成功：锁 → 进度 → IPC → 重载 / 书架 / 再列 → 10 秒撤销，文案带跳过数与更早备份数', async () => {
  const { host, state, calls, row } = makeHost({ backups: BACKUPS });
  state.replaceBackups = BACKUPS;
  const result = await replaceBackupUi.create(host).restoreReplaceBackupFlow('替换备份-2026-11-22-0900');
  assert.equal(result.ok, true);
  assert.deepEqual(calls.lock, ['begin', 'end']);
  assert.deepEqual(calls.progress, [['show', '正在从备份还原…（编辑区已暂锁）'], ['hide']]);
  assert.deepEqual(calls.restore, [[BOOK_A, '替换备份-2026-11-22-0900']], '还原只针对发起时捕获的这本书 + 选中的备份');
  assert.deepEqual(calls.reloadDisk, [BOOK_A], '还原后从磁盘重载（正文优先的脏闸在那边）');
  assert.equal(calls.shelf, 1);
  assert.equal(calls.list.filter((item) => item.channel === 'book:list-replace-backups').length, 2, '入口列一次 + 收尾再列一次');
  assert.equal(row.classList.contains('hidden'), false, '收尾重新列备份（这里列表还有备份 → 行仍显示）');
  assert.equal(state.replaceBackups.length, 2);
  assert.deepEqual(calls.fingerprint, [[BOOK_A, '还原前备份-2026-11-22-1000']]);
  assert.equal(calls.undo.length, 1);
  assert.equal(calls.undo[0].text, '已还原到「替换备份-2026-11-22-0900」前的正文');
  assert.deepEqual(calls.undo[0].opts, {
    groupId: 'dir:还原前备份-2026-11-22-1000',
    bookPath: BOOK_A
  });
  assert.equal(
    calls.toast[0].text,
    '已还原 3 个章节（跳过 1 个已不存在的章节），当前内容已备份到 _trash（还有 1 次更早的替换备份）'
  );
});

test('还原成功但没拿到还原前备份目录 → 不登记撤销（宁可不给按钮，也不登记一个会覆盖别处的组）', async () => {
  const { host, state, calls } = makeHost({
    backups: BACKUPS,
    restoreData: { restored: 2, skipped: 0, restoreBackupDir: '' }
  });
  state.replaceBackups = BACKUPS;
  const result = await replaceBackupUi.create(host).restoreReplaceBackupFlow();
  assert.equal(result.ok, true);
  assert.equal(calls.undo.length, 0);
  assert.equal(
    calls.toast[0].text,
    '已还原 2 个章节，当前内容已备份到 _trash（还有 1 次更早的替换备份）'
  );
});

test('撤销回调：换书 / 编辑区脏 / 指纹变了 / 备份里没章节 都拒；成功才重载 + 撤销整组', async () => {
  // 先正常还原一次，再把登记下来的撤销回调单独拿出来跑（不借用 activate 的同步执行，免得把
  // 撤销的拒绝误当成还原失败吞掉）。
  async function registerUndo(options = {}) {
    const ctx = makeHost({ backups: BACKUPS, ...options });
    const result = await replaceBackupUi.create(ctx.host).restoreReplaceBackupFlow();
    assert.equal(result.ok, true);
    assert.equal(ctx.calls.undo.length, 1);
    return ctx;
  }
  // ① 撤销时已经换了书
  const switched = await registerUndo();
  switched.state.bookPath = BOOK_B;
  await assert.rejects(switched.calls.undo[0].run(), /已经换了书，不能撤销/);
  assert.equal(switched.calls.history.length, 0);
  // ② 撤销时编辑区有未保存修改（还原后作者又敲了字）
  const dirty = await registerUndo();
  dirty.state.dirty = true;
  await assert.rejects(dirty.calls.undo[0].run(), /编辑区有未保存的修改/);
  assert.equal(dirty.calls.history.length, 0, '脏态撤销一开始就该拒，不许碰磁盘');
  // ③ 还原前备份的指纹变了
  const changed = await registerUndo({ unchangedError: new Error('备份已被改动') });
  await assert.rejects(changed.calls.undo[0].run(), /备份已被改动/);
  assert.equal(changed.calls.history.length, 0);
  // ④ 备份里没有可还原的章节
  const empty = await registerUndo({ historyResult: { restored: 0 } });
  await assert.rejects(empty.calls.undo[0].run(), /还原前备份里没有可还原的章节/);
  assert.deepEqual(empty.calls.history, [[BOOK_A, 'dir:还原前备份-2026-11-22-1000']]);
  // ⑤ 正常撤销：核对指纹 → 还原整组 → 重载 / 书架 / 再列
  const ok = await registerUndo();
  await ok.calls.undo[0].run();
  assert.equal(ok.calls.unchanged.length, 1);
  assert.deepEqual(ok.calls.history, [[BOOK_A, 'dir:还原前备份-2026-11-22-1000']]);
  assert.deepEqual(ok.calls.reloadDisk, [BOOK_A, BOOK_A], '还原 + 撤销各重载一次');
  assert.equal(ok.calls.shelf, 2);
});

test('还原失败：如实提示 + 回到磁盘真相 + 解锁 / 收起进度（finally 一定走到）', async () => {
  const { host, state, calls } = makeHost({ backups: BACKUPS, restoreError: new Error('磁盘满了') });
  state.replaceBackups = BACKUPS;
  const result = await replaceBackupUi.create(host).restoreReplaceBackupFlow();
  assert.deepEqual(result, { ok: false, message: '磁盘满了' });
  assert.equal(calls.toast[0].text, '还原失败：磁盘满了');
  assert.deepEqual(calls.reloadAfter, [BOOK_A], '可能已经还原了几章，界面要回到磁盘真相');
  assert.deepEqual(calls.lock, ['begin', 'end']);
  assert.deepEqual(calls.progress[calls.progress.length - 1], ['hide']);
});

test('活绑定：还原 IPC 一律走注入的 restoreBookOp（E2E 延迟注入靠它，不能绕过走 call）', async () => {
  const { host, state, calls } = makeHost({ backups: BACKUPS, restoreData: { restored: 1, skipped: 0 } });
  state.replaceBackups = BACKUPS;
  await replaceBackupUi.create(host).restoreReplaceBackupFlow();
  assert.equal(calls.restore.length, 1);
  assert.equal(
    calls.list.every((item) => item.channel !== 'book:restore-replace-backup' && item.channel !== 'restoreReplaceBackup'),
    true,
    '模块自己不许直连还原 IPC'
  );
});

// 静态闸门（机器清单）：实现只有一份、装配三处到位、渲染层只剩装配与同名转发。
test('静态闸门：实现只在 renderer/replace-backup-ui.js，renderer.js 只留装配与同名转发（机器清单）', () => {
  const { rendererSrc, rendererCode, indexSrc, moduleSrc, moduleCode } = loadSourceGate('replace-backup-ui.js');
  // ① 编排器里不许再长出第二份实现
  assert.equal(rendererCode.includes('call(api.listReplaceBackups'), false, '备份列表实现已搬走');
  assert.equal(rendererCode.includes('const others = state.replaceBackups.length - 1;'), false, '还原主体已搬走');
  assert.equal(rendererCode.includes('api.restoreHistoryDir'), false, '撤销还原整组已搬走');
  assert.match(
    rendererSrc,
    /async function restoreReplaceBackupFlow\(backupName\) \{\r?\n\s*if \(!replaceBackupUi\) return \{ ok: false \};/,
    '只留同名转发'
  );
  assert.match(moduleSrc, /async function refreshReplaceBackups\(\)/, '实现要在模块里');
  assert.match(moduleSrc, /async function restoreReplaceBackupFlow\(backupName\)/, '实现要在模块里');
  // ② 装配一次（模块常量 + create 都在编排器里）；还原 IPC 的活绑定按「每次现取 testBookOp」注入
  assert.match(rendererSrc, /const replaceBackupUiModule = window\.CWReplaceBackupUi;/);
  assert.match(rendererSrc, /replaceBackupUi = replaceBackupUiModule\.create\(\{/);
  assert.match(
    rendererSrc,
    /restoreBookOp: \(bookPath, backupName\) => \(testBookOp \|\| call\)\(api\.restoreReplaceBackup, bookPath, backupName\)/,
    '延迟注入要走 testBookOp || call（create 时传值会冻住 null）'
  );
  assert.equal(/let testBookOp = null;/.test(rendererCode), true, '活绑定本身仍留在编排器（测试钩子的 setter 在那边）');
  // ③ 模块只发两个 IPC，且不许自带换书入口
  assert.deepEqual(
    [...new Set(moduleCode.match(/api\.\w+/g) || [])].sort(),
    ['api.listReplaceBackups', 'api.restoreHistoryDir'],
    '模块只许发列备份 / 撤销还原整组两个 IPC（还原主 IPC 由渲染层注入）'
  );
  assert.equal(/api\.openBook\b/.test(moduleCode), false, '本模块不许自带换书入口');
  // ④ 装配清单 + index.html 都到位，且排在 renderer.js / assert-host 之后
  const entry = manifest.MODULES.find((item) => item[0] === 'replace-backup-ui.js');
  assert.ok(entry, '装配清单必须登记 replace-backup-ui.js');
  assert.equal(entry[1], 'CWReplaceBackupUi');
  assert.equal(entry[2], 'replaceBackupUiModule');
  assert.match(indexSrc, /<script src="replace-backup-ui\.js"><\/script>/, 'index.html 必须加载 replace-backup-ui.js');
  assert.ok(
    indexSrc.indexOf('<script src="replace-backup-ui.js"></script>') <
      indexSrc.indexOf('<script src="renderer.js"></script>'),
    'replace-backup-ui.js 必须排在 renderer.js 之前'
  );
  assert.ok(
    indexSrc.indexOf('<script src="../core/assert-host.js"></script>') <
      indexSrc.indexOf('<script src="replace-backup-ui.js"></script>'),
    'assert-host 必须排在消费者之前'
  );
  // ⑤ 模块本身仍是 UMD 双分支 + 依赖 assert-host，运行时代码不 require 任何东西
  assert.match(moduleSrc, /root\.CWReplaceBackupUi = factory\(root\.CWAssertHost && root\.CWAssertHost\.assertHost\);/);
  assert.match(moduleSrc, /assertHost\('createReplaceBackupUi', host, REQUIRED_HOST\);/, '只许调用一次共享 assertHost');
  assert.equal(/require\(/.test(stripAssertHostBranch(moduleCode)), false, '运行时代码（剥掉 Node 分支后）不许 require');
});
