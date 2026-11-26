const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const frag = require('../core/fragments');

const tmpCleanup = require('./tmp-cleanup');

// TB-02：临时目录统一经 tests/tmp-cleanup.js 的 mkTmp（mkdtemp + 登记回收）。
const mkTmp = (prefix = 'cw-fragments-') => tmpCleanup.mkTmp(prefix);

async function readRoot(dir) {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

test('灵感箱：date stamp 用本机日期补零，坏日期退回今天', () => {
  assert.equal(frag.formatDateStamp(new Date(2026, 0, 5, 9, 30)), '2026-01-05');
  assert.equal(frag.formatDateStamp(new Date(2026, 11, 31, 23, 59)), '2026-12-31');
  assert.match(frag.formatDateStamp(new Date('x')), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(frag.formatDateStamp('not-a-date'), /^\d{4}-\d{2}-\d{2}$/);
});

test('灵感箱：parseFragmentName 只认「YYYY-MM-DD-N.txt」且日期必须真实存在', () => {
  assert.deepEqual(frag.parseFragmentName('2026-10-31-1.txt'), { date: '2026-10-31', seq: 1 });
  assert.deepEqual(frag.parseFragmentName('2026-10-31-12.txt'), { date: '2026-10-31', seq: 12 });
  assert.equal(frag.parseFragmentName('2026-02-30-1.txt'), null, '2 月 30 日不是真实日期');
  assert.equal(frag.parseFragmentName('2026-13-01-1.txt'), null);
  assert.equal(frag.parseFragmentName('2026-10-31-0.txt'), null, '序号从 1 开始');
  assert.equal(frag.parseFragmentName('2026-10-31.txt'), null);
  assert.equal(frag.parseFragmentName('2026-10-31-1.md'), null);
  assert.equal(frag.parseFragmentName('随手记.txt'), null);
  assert.equal(frag.parseFragmentName(null), null);
  assert.equal(frag.isValidDayStamp('2026-10-31'), true);
  assert.equal(frag.isValidDayStamp('2026-10-32'), false);
});

test('灵感箱：nextFragmentName 在当天已有编号后递增，忽略别的日期 / 手工改名 / 坏名字', () => {
  assert.equal(frag.nextFragmentName([], new Date(2026, 9, 31, 12)), '2026-10-31-1.txt');
  assert.equal(
    frag.nextFragmentName(
      ['2026-10-31-1.txt', '2026-10-31-2.txt', '2026-10-30-9.txt', '随手记.txt', '2026-13-01-1.txt'],
      new Date(2026, 9, 31, 12)
    ),
    '2026-10-31-3.txt'
  );
  // 中间有洞也不回收（避免和回收站里的旧文件撞名）
  assert.equal(
    frag.nextFragmentName(['2026-10-31-1.txt', '2026-10-31-5.txt'], new Date(2026, 9, 31, 12)),
    '2026-10-31-6.txt'
  );
  assert.equal(frag.nextFragmentSerial(['2026-10-31-3.txt'], '2026-10-31'), 4);
  assert.equal(frag.nextFragmentSerial(['2026-10-31-3.txt'], '2026-11-01'), 1);
  assert.equal(frag.nextFragmentSerial(null, '2026-10-31'), 1);
});

// PM-4（五-L11）：解析只认 1–999999，生成却 max+1 不封顶 —— 第 100 万条写成
// YYYY-MM-DD-1000000.txt（自己解析不认），此后当天新建算出的还是 1000000，永远命中
// 「同名已存在」→ 提示「请再点一次保存」但永远无效，当天彻底卡死。
test('灵感箱（PM-4 / 五-L11）：当天序号到顶时明确报「序号已满」，不生成解析不认的名字', async () => {
  assert.deepEqual(frag.parseFragmentName('2026-10-31-999999.txt'), { date: '2026-10-31', seq: 999999 });
  assert.equal(frag.parseFragmentName('2026-10-31-1000000.txt'), null, '上限之外的名字解析不认');
  const atTop = ['2026-10-31-999999.txt'];
  assert.throws(
    () => frag.nextFragmentSerial(atTop, '2026-10-31'),
    (err) => err.code === 'SERIAL_EXHAUSTED' && /序号已满/.test(err.message),
    '到顶必须明确报错，不许返回 1000000'
  );
  assert.throws(
    () => frag.nextFragmentName(atTop, new Date(2026, 9, 31, 12)),
    (err) => err.code === 'SERIAL_EXHAUSTED'
  );
  assert.equal(frag.nextFragmentSerial(atTop, '2026-11-01'), 1, '别的日期不受影响');

  // 旧版已经写出过 1000000：create 不能再撞同名的 NAME_CONFLICT，而要明确报序号已满
  const root = await mkTmp();
  const store = frag.createFragmentStore(root);
  const dir = path.join(root, '_碎片');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '2026-10-31-999999.txt'), '旧碎片', 'utf8');
  await fs.writeFile(path.join(dir, '2026-10-31-1000000.txt'), '旧版写出的超上限碎片', 'utf8');
  await assert.rejects(
    () => store.create('今天再存一条', { now: new Date(2026, 9, 31, 12) }),
    (err) => err.code === 'SERIAL_EXHAUSTED' && /序号已满/.test(err.message)
  );
  assert.deepEqual(
    (await fs.readdir(dir)).sort(),
    ['2026-10-31-1000000.txt', '2026-10-31-999999.txt'],
    '拒绝发生在写盘前：一个文件都不多、旧碎片一个字节不动'
  );
  assert.equal(await fs.readFile(path.join(dir, '2026-10-31-999999.txt'), 'utf8'), '旧碎片');
});

test('灵感箱：cleanFragmentText 去 BOM / 统一换行 / 去首尾空白，空内容和超长明确拒绝', () => {
  const ok = frag.cleanFragmentText('\uFEFF第一段\r\n\r\n第二段\r\n');
  assert.equal(ok.ok, true);
  assert.equal(ok.text, '第一段\n\n第二段');
  assert.equal(ok.chars, 6);
  assert.equal(frag.cleanFragmentText('\uFEFF').ok, false);
  assert.equal(frag.cleanFragmentText('   \n\t\u3000 ').ok, false);
  assert.equal(frag.cleanFragmentText(null).code, 'EMPTY');
  const tooLong = frag.cleanFragmentText('字'.repeat(11), { maxChars: 10 });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.code, 'TOO_LONG');
  assert.match(tooLong.message, /最多 10 字/);
  assert.equal(frag.cleanFragmentText('字'.repeat(10), { maxChars: 10 }).ok, true);
  // 内部空格 / 空行保留（只 trim 首尾）
  assert.equal(frag.cleanFragmentText('  甲\n\n  乙  ').text, '甲\n\n  乙');
});

test('灵感箱：previewText 压成一行并截断，sortFragments 最新在前且不改原数组', () => {
  assert.equal(frag.previewText('第一行\n\n第二行  第三行'), '第一行 第二行 第三行');
  assert.equal(frag.previewText('字'.repeat(10), 4), '字字字字…');
  assert.equal(frag.previewText('  '), '');
  const input = [
    { name: 'a.txt', mtimeMs: 100 },
    { name: 'b.txt', mtimeMs: 300 },
    { name: 'c.txt', mtimeMs: 200 }
  ];
  const sorted = frag.sortFragments(input);
  assert.deepEqual(sorted.map((item) => item.name), ['b.txt', 'c.txt', 'a.txt']);
  assert.deepEqual(input.map((item) => item.name), ['a.txt', 'b.txt', 'c.txt'], '原数组顺序不变');
  assert.deepEqual(frag.sortFragments(null), []);
});

test('灵感箱：文件名校验拒绝路径穿越 / 隐藏文件 / 非 txt', () => {
  assert.equal(frag.assertFragmentName('2026-10-31-1.txt'), '2026-10-31-1.txt');
  assert.equal(frag.assertFragmentName(' 随手记.txt '), '随手记.txt');
  for (const bad of ['', '   ', '../x.txt', 'sub/x.txt', '..\\x.txt', '.secret.txt', 'x.md', 'a:b.txt']) {
    assert.throws(() => frag.assertFragmentName(bad), /不合法/, bad);
  }
});

test('灵感箱：目录不存在时列表为空，而且列表动作不会创建文件夹', async () => {
  const root = await mkTmp();
  const store = frag.createFragmentStore(root);
  const data = await store.list();
  assert.equal(data.total, 0);
  assert.deepEqual(data.fragments, []);
  assert.equal(data.dir, path.join(root, '_碎片'));
  assert.deepEqual(await readRoot(root), []);
});

// A2-FRAG-01（低）：碎片写走 atomicWriteFile，临时文件（`.名.tmp-pid-ts-rand`）落在 _碎片 里；
// 断电 / 强杀会在 rename 前留下隐藏半成品，而 X8 的孤儿回收只覆盖 userData / 导出目录 / 书架根
// .import-* / 书目录 —— _碎片 一个回收点都没有。现在首次 list() 顺手按同一口径回收一次。
test('A2-FRAG-01：_碎片 里的原子写孤儿在 list() 时回收（本进程 / 新鲜的不动）', async () => {
  const root = await mkTmp();
  const store = frag.createFragmentStore(root);
  const dir = path.join(root, '_碎片');
  await fs.mkdir(dir, { recursive: true });
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const orphan = path.join(dir, '.旧碎片.txt.tmp-999999-1700000000000-abcd12');
  const freshOrphan = path.join(dir, '.新碎片.txt.tmp-999999-1700000000000-abcd12');
  const ownPid = path.join(dir, `.本进程.txt.tmp-${process.pid}-1700000000000-abcd12`);
  for (const target of [orphan, freshOrphan, ownPid]) await fs.writeFile(target, '半成品', 'utf8');
  // 只把「旧」的 mtime 拨老：另两个要么 pid 是本进程，要么在 1 小时阈值内（都该保留）
  await fs.utimes(orphan, old, old);
  await fs.utimes(ownPid, old, old);
  await store.list();
  const names = await fs.readdir(dir);
  assert.equal(names.includes(path.basename(orphan)), false, '异 pid + 超过 1 小时的孤儿要删掉');
  assert.equal(names.includes(path.basename(freshOrphan)), true, '新鲜临时文件可能是别的进程正在写，保留');
  assert.equal(names.includes(path.basename(ownPid)), true, '本进程 pid 的临时文件可能正在写，保留');
});

test('灵感箱：新建碎片写进 _碎片、UTF-8 无 BOM + CRLF、内容与字数正确', async () => {
  const root = await mkTmp();
  const store = frag.createFragmentStore(root);
  const result = await store.create('第一段\n第二段\n\n第三段', { now: new Date(2026, 9, 31, 12) });
  assert.equal(result.name, '2026-10-31-1.txt');
  assert.equal(result.dir, path.join(root, '_碎片'));
  assert.equal(result.path, path.join(root, '_碎片', '2026-10-31-1.txt'));
  assert.equal(result.chars, 9);
  assert.equal(result.length, 12);
  assert.ok(result.bytes > 0);
  const bytes = await fs.readFile(result.path);
  assert.notEqual(bytes[0], 0xef, '不写 BOM（和章节 txt 一致）');
  assert.equal(bytes.toString('utf8'), '第一段\r\n第二段\r\n\r\n第三段');
  // 书架根目录只多出一个 _碎片 文件夹，不碰 书目.json / 章节
  assert.deepEqual(await readRoot(root), ['_碎片']);
  assert.deepEqual(await readRoot(path.join(root, '_碎片')), ['2026-10-31-1.txt']);
});

test('灵感箱：同一天连续保存自动加序号，旧碎片一个字节都不动', async () => {
  const root = await mkTmp();
  const store = frag.createFragmentStore(root);
  const now = new Date(2026, 9, 31, 12);
  const first = await store.create('第一条', { now });
  const firstStat = await fs.stat(first.path);
  const firstBytes = await fs.readFile(first.path);
  const second = await store.create('第二条', { now });
  const third = await store.create('第三条', { now });
  assert.deepEqual(
    [first.name, second.name, third.name],
    ['2026-10-31-1.txt', '2026-10-31-2.txt', '2026-10-31-3.txt']
  );
  assert.deepEqual(await fs.readFile(first.path), firstBytes, '第一条内容没被覆盖');
  assert.equal((await fs.stat(first.path)).mtimeMs, firstStat.mtimeMs);
  const otherDay = await store.create('换一天', { now: new Date(2026, 10, 1, 0, 5) });
  assert.equal(otherDay.name, '2026-11-01-1.txt');
  assert.equal((await store.list()).total, 4);
});

test('灵感箱：并发保存也各占一个序号，不互相覆盖', async () => {
  const root = await mkTmp();
  const store = frag.createFragmentStore(root);
  const now = new Date(2026, 9, 31, 12);
  const results = await Promise.all(
    Array.from({ length: 8 }, (_value, i) => store.create(`第 ${i} 条`, { now }))
  );
  const names = results.map((item) => item.name).sort();
  assert.equal(new Set(names).size, 8);
  assert.deepEqual(names, [
    '2026-10-31-1.txt',
    '2026-10-31-2.txt',
    '2026-10-31-3.txt',
    '2026-10-31-4.txt',
    '2026-10-31-5.txt',
    '2026-10-31-6.txt',
    '2026-10-31-7.txt',
    '2026-10-31-8.txt'
  ]);
  for (let i = 0; i < results.length; i += 1) {
    const disk = await fs.readFile(results[i].path, 'utf8');
    assert.equal(disk, `第 ${i} 条`, '每条内容都写进自己的文件');
  }
  const leftovers = (await fs.readdir(path.join(root, '_碎片'))).filter((name) => name.startsWith('.'));
  assert.deepEqual(leftovers, [], '原子写的临时文件没有残留');
});

test('灵感箱：空内容 / 纯空白 / 超长在写盘前就被拒绝，不留半截文件', async () => {
  const root = await mkTmp();
  const store = frag.createFragmentStore(root);
  await assert.rejects(store.create('   \n\t '), /空的/);
  await assert.rejects(store.create('', {}), /空的/);
  await assert.rejects(store.create('字'.repeat(frag.MAX_TEXT_CHARS + 1)), /碎片太长/);
  assert.deepEqual(await readRoot(path.join(root, '_碎片')), []);
});

test('灵感箱：列表只认顶层 .txt（含手工放进去的），忽略子目录 / 隐藏文件 / 非 txt，最新在前', async () => {
  const root = await mkTmp();
  const dir = path.join(root, '_碎片');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '2026-10-30-1.txt'), '旧的', 'utf8');
  await fs.writeFile(path.join(dir, '2026-10-31-2.txt'), '新的\n第二行', 'utf8');
  await fs.writeFile(path.join(dir, '随手记.txt'), '手工放进去的', 'utf8');
  await fs.writeFile(path.join(dir, '.hidden.txt'), '隐藏', 'utf8');
  await fs.writeFile(path.join(dir, 'readme.md'), '# 不是 txt', 'utf8');
  await fs.mkdir(path.join(dir, '子目录'));
  await fs.writeFile(path.join(dir, '子目录', '2026-10-31-9.txt'), '嵌套的不算', 'utf8');
  // 用 utimes 固定修改时间，排序稳定可测
  const t1 = new Date(2026, 9, 30, 8, 0).getTime() / 1000;
  const t2 = new Date(2026, 9, 31, 9, 0).getTime() / 1000;
  const t3 = new Date(2026, 9, 31, 10, 0).getTime() / 1000;
  await fs.utimes(path.join(dir, '2026-10-30-1.txt'), t1, t1);
  await fs.utimes(path.join(dir, '2026-10-31-2.txt'), t2, t2);
  await fs.utimes(path.join(dir, '随手记.txt'), t3, t3);

  const store = frag.createFragmentStore(root);
  const data = await store.list();
  assert.equal(data.total, 3);
  assert.equal(data.truncated, false);
  assert.deepEqual(data.fragments.map((item) => item.name), [
    '随手记.txt',
    '2026-10-31-2.txt',
    '2026-10-30-1.txt'
  ]);
  const generated = data.fragments.find((item) => item.name === '2026-10-31-2.txt');
  assert.equal(generated.date, '2026-10-31');
  assert.equal(generated.seq, 2);
  assert.equal(generated.preview, '新的 第二行');
  const manual = data.fragments.find((item) => item.name === '随手记.txt');
  assert.equal(manual.date, null);
  assert.equal(manual.seq, null);
  assert.ok(manual.size > 0);
});

test('灵感箱：列表最多 300 条但总数照实报', async () => {
  const root = await mkTmp();
  const dir = path.join(root, '_碎片');
  await fs.mkdir(dir, { recursive: true });
  await Promise.all(
    Array.from({ length: 305 }, (_value, i) =>
      fs.writeFile(path.join(dir, `2026-10-31-${i + 1}.txt`), `碎片 ${i + 1}`, 'utf8')
    )
  );
  const data = await frag.createFragmentStore(root).list();
  assert.equal(data.total, 305);
  assert.equal(data.truncated, true);
  assert.equal(data.fragments.length, frag.LIST_LIMIT);
  assert.equal(data.fragments.every((item) => /^2026-10-31-\d+\.txt$/.test(item.name)), true);
});

test('灵感箱：读取单条碎片去 BOM / 统一换行 / 算字数，拒绝穿越和不存在', async () => {
  const root = await mkTmp();
  const dir = path.join(root, '_碎片');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '2026-10-31-1.txt'), '\uFEFF第一行\r\n第二行\r\n', 'utf8');
  const store = frag.createFragmentStore(root);
  const one = await store.read('2026-10-31-1.txt');
  assert.equal(one.text, '第一行\n第二行\n');
  assert.equal(one.chars, 6);
  await assert.rejects(store.read('../书目.json'), /不合法/);
  await assert.rejects(store.read('sub/2026-10-31-1.txt'), /不合法/);
  await assert.rejects(store.read('2026-10-32-1.txt'), /不在/);
  await assert.rejects(store.read('不存在.txt'), /不在/);
  // 目录不能被当成碎片读
  await fs.mkdir(path.join(dir, '目录.txt'));
  await assert.rejects(store.read('目录.txt'), /不在/);
});

test('灵感箱：超过 4MB 的碎片拒绝读取（不硬塞进编辑区）', async () => {
  const root = await mkTmp();
  const dir = path.join(root, '_碎片');
  await fs.mkdir(dir, { recursive: true });
  const big = Buffer.alloc(frag.MAX_READ_BYTES + 1, 0x41);
  await fs.writeFile(path.join(dir, '巨大.txt'), big);
  await assert.rejects(frag.createFragmentStore(root).read('巨大.txt'), /太大/);
});

test('灵感箱：_碎片 位置被同名文件占住时给出明确错误，不覆盖、不递归写', async () => {
  const root = await mkTmp();
  await fs.writeFile(path.join(root, '_碎片'), '不是文件夹', 'utf8');
  const store = frag.createFragmentStore(root);
  await assert.rejects(store.list(), /不是一个文件夹/);
  await assert.rejects(store.create('内容'), /不是一个文件夹/);
  assert.equal(await fs.readFile(path.join(root, '_碎片'), 'utf8'), '不是文件夹');
});

// ---------- V74：碎片 store 按 booksRoot 单例化（跨 IPC 共用同一写队列） ----------
// 背景：main.js 三个 fragments 频道原来每次 createFragmentStore(cfg.booksRoot) 新建实例，
// 而写队列（core/common.js 的 createWriteQueue）是实例私有的。两个窗口毫秒级同时保存时，
// 双方都通过「目标不存在」检查，atomicWriteFile 的 rename 后写覆盖先写——先保存的正文丢失，
// 两边却都收到成功回执。下面三条锁住：同 root 同实例 / 不同 root 不同实例 / 同 root 并发不丢。

test('碎片单例：同 root 两次 getFragmentStore 返回同一对象（同一写队列）（V74）', async () => {
  const root = await mkTmp();
  const first = frag.getFragmentStore(root);
  const second = frag.getFragmentStore(root);
  assert.equal(second, first, '同一个 booksRoot 必须命中同一个 store，否则写队列各一条');
  // Windows 路径大小写 / 尾分隔符不敏感：写法不同也是同一个书架根目录
  const alias = frag.getFragmentStore(root.toUpperCase() + path.sep);
  assert.equal(alias, first, '大小写 / 尾分隔符不同的同一 root 也要命中同一实例');
  assert.equal(first.dir, path.join(root, '_碎片'));
});

test('碎片单例：不同 root 返回不同对象、互不串队（V74）', async () => {
  const rootA = await mkTmp();
  const rootB = await mkTmp();
  const storeA = frag.getFragmentStore(rootA);
  const storeB = frag.getFragmentStore(rootB);
  assert.notEqual(storeA, storeB, '不同书架根目录不能共用一个 store');
  assert.equal(storeA.dir, path.join(rootA, '_碎片'));
  assert.equal(storeB.dir, path.join(rootB, '_碎片'));
  assert.equal(frag.getFragmentStore(rootA), storeA, '再取一次仍是原来那条');
  assert.equal(frag.getFragmentStore(rootB), storeB, '同一 key 命中缓存，不会新建');
  // 两个 root 各自并发新建：序号各从 1 开始，内容只落在自己的 _碎片 里（不串队、不串目录）
  const now = new Date(2026, 9, 31, 12);
  const [a, b] = await Promise.all([storeA.create('书架甲', { now }), storeB.create('书架乙', { now })]);
  assert.equal(a.name, '2026-10-31-1.txt');
  assert.equal(b.name, '2026-10-31-1.txt');
  assert.equal(await fs.readFile(a.path, 'utf8'), '书架甲');
  assert.equal(await fs.readFile(b.path, 'utf8'), '书架乙');
  assert.deepEqual(await readRoot(rootA), ['_碎片']);
  assert.deepEqual(await readRoot(rootB), ['_碎片']);
});

test('碎片单例：同 root 并发两次 create 串行、序号不撞、两份内容都保留（V74）', async () => {
  const root = await mkTmp();
  const now = new Date(2026, 9, 31, 12);
  // 模拟两个 IPC 同时到达：各自 getFragmentStore（修复前 = 各自写队列）后同时 create
  const [first, second] = await Promise.all([
    frag.getFragmentStore(root).create('并发甲', { now }),
    frag.getFragmentStore(root).create('并发乙', { now })
  ]);
  assert.notEqual(first.name, second.name, '同一天的两条碎片不能抢同一个文件名');
  const listed = await frag.getFragmentStore(root).list();
  assert.equal(listed.total, 2, '两条都要留在 _碎片 里');
  assert.deepEqual(
    listed.fragments.map((item) => item.name).sort(),
    [first.name, second.name].sort()
  );
  const texts = await Promise.all([
    frag.getFragmentStore(root).read(first.name),
    frag.getFragmentStore(root).read(second.name)
  ]);
  assert.deepEqual(texts.map((item) => item.text).sort(), ['并发甲', '并发乙'].sort(), '两份正文都要保留');
});

// ---------- B7（v1.8.0 WP-28）：列表先粗排再只读前 300 条预览 ----------
async function makeFragmentFiles(root, count, mtimeFor) {
  const dir = path.join(root, '_碎片');
  await fs.mkdir(dir, { recursive: true });
  const names = [];
  for (let i = 0; i < count; i += 1) {
    const name = `某天-${i + 1}.txt`;
    await fs.writeFile(path.join(dir, name), `正文 ${i}\n`, 'utf8');
    await fs.utimes(path.join(dir, name), mtimeFor(i), mtimeFor(i));
    names.push(name);
  }
  return names;
}

test('碎片列表（B7/WP-28）：305 条只给最新的 300 条读预览，被截掉的条目一个字节都不读', async () => {
  const root = await mkTmp();
  const base = 1_760_000_000; // 固定秒数，避免「同时创建」导致 mtime 相同
  await makeFragmentFiles(root, 305, (i) => base + i);
  const reads = [];
  const store = frag.createFragmentStore(root, {
    readPreview: async (filePath) => {
      reads.push(path.basename(filePath));
      return { preview: `预览：${path.basename(filePath)}`, text: '' };
    }
  });
  const listed = await store.list();
  assert.equal(listed.total, 305, '总数照实报');
  assert.equal(listed.truncated, true);
  assert.equal(listed.fragments.length, 300);
  assert.equal(reads.length, 300, '只读会返回的前 300 条预览');
  // 最新的 300 条 = 序号 305 → 6；被截掉的 5 条（1–5）一次都没读
  assert.equal(listed.fragments[0].name, '某天-305.txt');
  assert.equal(listed.fragments[299].name, '某天-6.txt');
  assert.equal(reads.includes('某天-1.txt'), false);
  assert.equal(reads.includes('某天-5.txt'), false);
  assert.equal(reads.includes('某天-6.txt'), true);
  assert.equal(listed.fragments[0].preview, '预览：某天-305.txt');
  // size / mtimeMs / date / seq 字段与旧形状一致（手工命名的碎片 date/seq 为 null）
  assert.equal(listed.fragments[0].date, null);
  assert.equal(listed.fragments[0].size, Buffer.byteLength('正文 304\n'));
  assert.ok(listed.fragments[0].mtimeMs > 0);
});

test('碎片列表（B7/WP-28）：≤300 条时逐字段与旧实现一致（最新在前 + 文件名字典序兜底）', async () => {
  const root = await mkTmp();
  await makeFragmentFiles(root, 3, (i) => 1_760_000_000 + i);
  const store = frag.createFragmentStore(root, {
    readPreview: async (filePath) => ({ preview: `P:${path.basename(filePath)}`, text: '' })
  });
  const listed = await store.list();
  assert.equal(listed.truncated, false);
  assert.deepEqual(
    listed.fragments.map((item) => [item.name, item.preview]),
    [
      ['某天-3.txt', 'P:某天-3.txt'],
      ['某天-2.txt', 'P:某天-2.txt'],
      ['某天-1.txt', 'P:某天-1.txt']
    ]
  );
});

test('碎片列表（B7/WP-28）：stat 并发（峰值受并发度限制）、读不到的条目只跳过自己', async () => {
  const root = await mkTmp();
  await makeFragmentFiles(root, 8, (i) => 1_760_000_000 + i);
  let active = 0;
  let peak = 0;
  const stat = async (target) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      return await fs.stat(target);
    } finally {
      active -= 1;
    }
  };
  const store = frag.createFragmentStore(root, {
    stat,
    readPreview: async () => ({ preview: '', text: '' })
  });
  const listed = await store.list();
  assert.equal(listed.total, 8);
  assert.ok(peak >= 2, `stat 应该并发（8 条里峰值 ${peak}）`);
  assert.ok(peak <= 8, `并发度不许超过上限（峰值 ${peak}）`);

  // 并发度 1 = 串行，结果与并发版逐字段一致
  const serial = frag.createFragmentStore(root, {
    stat,
    concurrency: 1,
    readPreview: async () => ({ preview: '', text: '' })
  });
  peak = 0;
  const serialListed = await serial.list();
  assert.equal(peak, 1, '并发度 1 时一次只 stat 一个');
  assert.deepEqual(
    serialListed.fragments.map((item) => item.name),
    listed.fragments.map((item) => item.name)
  );

  // 其中一个文件 stat 失败：只跳过它自己
  const broken = frag.createFragmentStore(root, {
    stat: async (target) => {
      if (path.basename(target) === '某天-3.txt') throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      return fs.stat(target);
    },
    readPreview: async () => ({ preview: '', text: '' })
  });
  const brokenListed = await broken.list();
  assert.equal(brokenListed.total, 7);
  assert.equal(brokenListed.fragments.some((item) => item.name === '某天-3.txt'), false);
});

// V221-MAIN-01（2026-11-26 复核）：碎片 IPC 只用 500 万字通用闸门 —— 10 万–500 万字的输入会先进
// 主进程做一遍去 BOM / 换行归一的 O(n) 清洗，再被碎片自己的 10 万字上限拒绝。入口先按碎片上限挡。
test('V221-MAIN-01：fragments:create 入口先按碎片 10 万字上限挡，不把超大输入送进 O(n) 清洗', () => {
  const main = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main.js'), 'utf8');
  const start = main.indexOf("handle('fragments:create'");
  assert.ok(start > 0, '找不到 fragments:create 处理器');
  const block = main.slice(start, start + 500);
  assert.match(
    block,
    /assertText\(text, \{ max: fragmentsLib\.MAX_TEXT_CHARS, label: '碎片' \}\)/,
    '入口要用碎片自己的上限先挡一次'
  );
  const createAt = block.indexOf('getFragmentStore(');
  assert.ok(block.indexOf('assertText(') < createAt, '上限校验必须排在 store.create 之前');
  // 行为：同一口径的 assertText 在 10 万字 + 1 时按 TEXT_TOO_LARGE 拒绝（文案指明是碎片）。
  const ipcLimits = require('../core/ipc-limits');
  assert.throws(
    () => ipcLimits.assertText('字'.repeat(frag.MAX_TEXT_CHARS + 1), { max: frag.MAX_TEXT_CHARS, label: '碎片' }),
    (err) => err.code === 'TEXT_TOO_LARGE' && /碎片太长/.test(err.message)
  );
  assert.doesNotThrow(() => ipcLimits.assertText('字'.repeat(frag.MAX_TEXT_CHARS), { max: frag.MAX_TEXT_CHARS }));
});
