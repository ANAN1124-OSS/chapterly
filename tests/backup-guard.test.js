// 1.5.0 P0-5（1.4.0 审计 V-2）：撤销前的「备份还是不是那一份」核对。
//
// 指纹 = 目录名 + 清单里的文件数 + 文件里最大的 mtimeMs（只用 api.listHistory 已有的字段，不额外 stat）。
// 测试覆盖：纯函数怎么认指纹 / 三种不一致（目录没了、文件数变了、mtime 变了）/
// create() 的两种读失败口径（登记时 null 不拦、撤销时取消）/ 正常撤销放行。
const test = require('node:test');
const assert = require('node:assert/strict');
const guardLib = require('../renderer/backup-guard');

function group(dirName, files, overrides = {}) {
  return {
    id: `dir:${dirName}`,
    dirName,
    kind: 'dir',
    fileCount: files.length,
    files: files.map(([name, mtimeMs]) => ({ name, mtimeMs })),
    ...overrides
  };
}

const GROUPS = [
  group('还原前备份-20261109-120000', [
    ['第一章.txt', 1000.4],
    ['第二章.txt', 1200.6]
  ]),
  group('整理备份-20261110-090000', [['第一章.txt', 500]])
];

test('备份指纹：按 dirName 或 dir: 前缀 id 都能认，取文件数 + 最大 mtime（四舍五入）', () => {
  const fp = guardLib.fingerprintOf(GROUPS, '还原前备份-20261109-120000');
  assert.deepEqual(fp, {
    dirName: '还原前备份-20261109-120000',
    fileCount: 2,
    mtimeMs: 1201
  });
  // 只给 id 也能认（调用方拿回来的 groupId 是 dir: 前缀）
  assert.equal(guardLib.fingerprintOf(GROUPS, 'dir:整理备份-20261110-090000'), null, 'dirName 参数要的是目录名');
  assert.deepEqual(guardLib.fingerprintOf(GROUPS, '整理备份-20261110-090000'), {
    dirName: '整理备份-20261110-090000',
    fileCount: 1,
    mtimeMs: 500
  });
});

test('备份指纹：目录不存在 / 空参数 / 脏清单都回 null（不抛）', () => {
  assert.equal(guardLib.fingerprintOf(GROUPS, '不存在的备份'), null);
  assert.equal(guardLib.fingerprintOf(GROUPS, ''), null);
  assert.equal(guardLib.fingerprintOf(null, '还原前备份-20261109-120000'), null);
  assert.equal(guardLib.fingerprintOf([null, 42, 'x'], '还原前备份-20261109-120000'), null);
  assert.equal(guardLib.fingerprintOf({ groups: GROUPS }, '还原前备份-20261109-120000').fileCount, 2, '传 { groups } 也行');
});

test('备份指纹：group.fileCount 缺失按 files.length 算，没有 files 时 mtime = 0', () => {
  const noCount = { id: 'dir:x', dirName: 'x', files: [{ name: 'a.txt', mtimeMs: 10 }] };
  assert.deepEqual(guardLib.fingerprintOf([noCount], 'x'), { dirName: 'x', fileCount: 1, mtimeMs: 10 });
  const noFiles = { id: 'dir:y', dirName: 'y', fileCount: 3 };
  assert.deepEqual(guardLib.fingerprintOf([noFiles], 'y'), { dirName: 'y', fileCount: 3, mtimeMs: 0 });
});

test('备份核对：一致放行；目录没了 / 文件数变了 / mtime 变了都报「备份已变化，撤销取消」', () => {
  const expected = guardLib.fingerprintOf(GROUPS, '还原前备份-20261109-120000');
  assert.deepEqual(guardLib.verify(GROUPS, expected), { ok: true, fingerprint: expected });

  const missing = guardLib.verify(GROUPS.filter((g) => g.dirName !== '还原前备份-20261109-120000'), expected);
  assert.deepEqual(missing, { ok: false, reason: 'missing', message: guardLib.MESSAGE });

  const fewer = [group('还原前备份-20261109-120000', [['第一章.txt', 1000.4]])];
  assert.deepEqual(guardLib.verify(fewer, expected), {
    ok: false,
    reason: 'changed',
    message: '备份已变化，撤销取消'
  });

  const touched = [
    group('还原前备份-20261109-120000', [
      ['第一章.txt', 1000.4],
      ['第二章.txt', 9999]
    ])
  ];
  assert.deepEqual(guardLib.verify(touched, expected), {
    ok: false,
    reason: 'changed',
    message: '备份已变化，撤销取消'
  });
});

test('备份核对：登记时没记到指纹（null）就不拦（宁可少一道核对，不让正常撤销变砖）', () => {
  assert.deepEqual(guardLib.verify(GROUPS, null), { ok: true, unchecked: true });
  assert.deepEqual(guardLib.verify([], undefined), { ok: true, unchecked: true });
  assert.deepEqual(guardLib.verify([], {}), { ok: true, unchecked: true });
});

test('create：缺 call / api.listHistory 直接抛 TypeError（启动时就炸，不要到撤销时才炸）', () => {
  assert.throws(() => guardLib.create(null), /host.call 必须是函数/);
  assert.throws(() => guardLib.create({}), /host.call 必须是函数/);
  assert.throws(() => guardLib.create({ call: () => {} }), /host.api 必须带 listHistory/);
  assert.throws(() => guardLib.create({ call: () => {}, api: {} }), /host.api 必须带 listHistory/);
  assert.doesNotThrow(() => guardLib.create({ call: () => {}, api: { listHistory: () => {} } }));
});

test('create.fingerprint：正常读清单记指纹；listHistory 抛错回 null（不拦撤销）', async () => {
  const seen = [];
  const guard = guardLib.create({
    call: async (fn, ...args) => {
      seen.push(args);
      return fn(...args);
    },
    api: {
      async listHistory(bookPath) {
        if (bookPath === '坏书') throw new Error('读不到');
        return { groups: GROUPS };
      }
    }
  });
  assert.deepEqual(await guard.fingerprint('好书', '整理备份-20261110-090000'), {
    dirName: '整理备份-20261110-090000',
    fileCount: 1,
    mtimeMs: 500
  });
  assert.deepEqual(seen, [['好书']]);
  assert.equal(await guard.fingerprint('坏书', '整理备份-20261110-090000'), null);
  assert.equal(await guard.fingerprint('', '整理备份-20261110-090000'), null);
  assert.equal(await guard.fingerprint('好书', ''), null);
});

test('create.assertUnchanged：一致放行、变了抛「备份已变化，撤销取消」、清单读不到也取消', async () => {
  let groups = GROUPS;
  let fail = false;
  const guard = guardLib.create({
    call: async (fn, ...args) => fn(...args),
    api: {
      async listHistory() {
        if (fail) throw new Error('磁盘忙');
        return { groups };
      }
    }
  });
  const expected = await guard.fingerprint('书', '还原前备份-20261109-120000');
  assert.equal(await guard.assertUnchanged('书', expected), true);

  groups = GROUPS.filter((g) => g.dirName !== '还原前备份-20261109-120000');
  await assert.rejects(() => guard.assertUnchanged('书', expected), /备份已变化，撤销取消/);
  await assert.rejects(
    () => guard.assertUnchanged('书', expected),
    (err) => err.message === guardLib.MESSAGE,
    '文案与常量一致'
  );

  fail = true;
  await assert.rejects(
    () => guard.assertUnchanged('书', expected),
    (err) => err.message === guardLib.LIST_FAILED_MESSAGE,
    '撤销时清单读不到 = 证明不了没变，取消'
  );

  // 没有指纹（登记时清单就读不到）→ 不核对，直接放行
  assert.equal(await guard.assertUnchanged('书', null), true);
});
// ---------- 静态闸门：三条备份撤销都真的接上了核对 ----------
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const rendererSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'renderer.js'), 'utf8');
const historySrc = fs.readFileSync(path.join(ROOT, 'renderer', 'history-ui.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');

test('静态闸门：renderer.js 装配 backup-guard，整本替换备份还原 / 整本整理两条撤销都先核对再还原', () => {
  assert.match(rendererSrc, /const backupGuardModule = window\.CWBackupGuard;/, '必须取 backup-guard.js 的全局');
  assert.match(rendererSrc, /const backupGuard = backupGuardModule\.create\(\{ call, api \}\);/, '必须装配 guard');
  const verifyCalls = rendererSrc.split('backupGuard.assertUnchanged(').length - 1;
  assert.equal(verifyCalls, 2, '整本替换备份还原 + 整本整理两条撤销各核一次');
  const fingerprintCalls = rendererSrc.split('backupGuard.fingerprint(').length - 1;
  assert.equal(fingerprintCalls, 2, '两条撤销登记时各记一次指纹');
  for (const undoName of ['undoName', 'backupName']) {
    const at = rendererSrc.indexOf(`backupGuard.fingerprint(bookPath, ${undoName})`);
    assert.notEqual(at, -1, `${undoName} 的指纹必须在登记撤销时记`);
  }
});

test('静态闸门：历史还原的撤销也核对（history-ui 用 host.guard，renderer 把 backupGuard 传进去）', () => {
  assert.match(historySrc, /const \{ \$[^}]*guard[^}]*\} = host;/, 'history-ui 必须从 host 取 guard');
  assert.match(historySrc, /guard\.fingerprint\(bookPath, undoName\)/, '登记时记指纹');
  assert.match(historySrc, /guard\.assertUnchanged\(bookPath, expectedBackup\)/, '撤销前核对');
  assert.match(rendererSrc, /guard: backupGuard,/, 'renderer.js 必须把 backupGuard 传给 historyUi');
  assert.match(indexSrc, /<script src="backup-guard\.js"><\/script>/, 'index.html 必须加载 backup-guard.js');
});
