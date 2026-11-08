// 公共小工具（v0.9 B-3，代码精简 B3）：pad2 / clampInt / sleep 的唯一实现。
//
// 这一轮把三个小工具从 15 个文件里的 19 份副本收进 core/common.js（pad2 原本 6 个 core 模块各一份、
// 另有 4 处内联 lambda；clampInt 3 个 core 模块 + 2 个渲染层纯逻辑模块；sleep 原子写与截图驱动各一份）。
// 「行为零变化」是硬要求，所以测试分两层：
//   1. 行为：补零 / 夹紧 / 等一会儿的边界值逐个钉住（含旧实现也会给出的怪值，例如负数补零仍是 '-1'）；
//   2. 回归闸门：仓库里不许再长出第二份实现、用到就必须从 core/common.js 拿、core/common.js 必须保持
//      纯逻辑（不 require 任何东西、不碰 process / window / document）；index.html 里 core/common.js
//      必须排在依赖它的三个文件之前；并用 node:vm 在没有 module 的沙箱里把浏览器那条加载链真跑一遍。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const common = require('../core/common');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const COMMON_SOURCE = read('core/common.js');
// 纯逻辑闸门只看代码：注释里提到 window / electron 是在解释边界，不算越界
const COMMON_CODE = COMMON_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const INDEX_SOURCE = read('renderer/index.html');
const MAIN_SOURCE = read('main.js');

const CORE_FILES = fs
  .readdirSync(path.join(ROOT, 'core'))
  .filter((name) => name.endsWith('.js') && name !== 'common.js')
  .map((name) => `core/${name}`);
const RENDERER_FILES = fs
  .readdirSync(path.join(ROOT, 'renderer'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => `renderer/${name}`);
const SCRIPT_FILES = fs
  .readdirSync(path.join(ROOT, 'scripts'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => `scripts/${name}`);

// 浏览器那条路（index.html 的 <script>）：没有 module / require 的沙箱里按顺序加载脚本，
// 模块会把对外接口挂到沙箱的 globalThis 上（window.CWXxx）。返回 context 是为了让用例能用
// 沙箱自己的 Date（跨 realm 的 Date 过不了 instanceof，会误判成「没传日期」）。
function loadInBrowserSandbox(files) {
  const win = {};
  const context = vm.createContext(win);
  for (const rel of files) vm.runInContext(read(rel), context, { filename: rel });
  return { win, context };
}

test('pad2：补零到两位，超过两位原样返回（和 String#padStart 同语义）', () => {
  assert.equal(common.pad2(0), '00');
  assert.equal(common.pad2(7), '07');
  assert.equal(common.pad2(12), '12');
  assert.equal(common.pad2(99), '99');
  assert.equal(common.pad2(100), '100');
  // 负数 / 小数 / 字符串都不是两位数字，旧实现（各模块自己那份）同样原样拼字符串
  assert.equal(common.pad2(-1), '-1');
  assert.equal(common.pad2(1.5), '1.5');
  assert.equal(common.pad2('07'), '07');
  assert.equal(common.pad2(''), '00', 'padStart 会把空串补成 "00"，旧实现同样如此');
  assert.equal(common.pad2(null), 'null');
});

test('clampInt：先向下取整，非有限数退回 fallback，其余夹到 range 两端（含端点）', () => {
  assert.equal(common.clampInt(3.9, 0, [0, 100]), 3);
  assert.equal(common.clampInt(-3.9, 0, [0, 100]), 0);
  assert.equal(common.clampInt(999, 0, [0, 100]), 100);
  assert.equal(common.clampInt(0, 42, [0, 100]), 0);
  assert.equal(common.clampInt(50, 0, [50, 20000]), 50, '下限端点照常放过');
  assert.equal(common.clampInt(20000, 0, [50, 20000]), 20000, '上限端点照常放过');
  // 数字字符串 / 布尔照旧按 Number() 走；'' 会被 Number 当成 0（JS 老规矩，旧实现一样）
  assert.equal(common.clampInt('7', 0, [0, 100]), 7);
  assert.equal(common.clampInt(true, 0, [0, 100]), 1);
  assert.equal(common.clampInt('', 42, [0, 100]), 0);
  // 真正「不是数」的一律退回 fallback
  assert.equal(common.clampInt(NaN, 42, [0, 100]), 42);
  assert.equal(common.clampInt(undefined, 42, [0, 100]), 42);
  assert.equal(common.clampInt(null, 42, [0, 100]), 0, 'Number(null) === 0，旧实现同样给 0');
  assert.equal(common.clampInt(Infinity, 42, [0, 100]), 42);
  assert.equal(common.clampInt(-Infinity, 42, [0, 100]), 42);
  assert.equal(common.clampInt('abc', 42, [0, 100]), 42);
});

test('sleep：返回 Promise，真的等够时间才 resolve，且永远是 undefined', async () => {
  const started = Date.now();
  const pending = common.sleep(30);
  assert.ok(pending instanceof Promise, 'sleep 必须返回 Promise');
  const value = await pending;
  const elapsed = Date.now() - started;
  assert.equal(value, undefined);
  assert.ok(elapsed >= 25, `实际等了 ${elapsed}ms，至少应该 ≥25ms`);
  // 并行等也照常
  const both = await Promise.all([common.sleep(10), common.sleep(10)]);
  assert.deepEqual(both, [undefined, undefined]);
});

test('formatCount：逐位千分位（全应用字数显示统一，拍板 #1）；非计数一律当 0', () => {
  assert.equal(common.formatCount(0), '0');
  assert.equal(common.formatCount(999), '999', '三位以内不加分隔符');
  assert.equal(common.formatCount(1000), '1,000');
  assert.equal(common.formatCount(1234), '1,234');
  assert.equal(common.formatCount(1234567), '1,234,567');
  assert.equal(common.formatCount(1000000), '1,000,000');
  // 计数位置不存在负数 / 小数 / 非数语义：一律收敛到 0，绝不吐出 'NaN' / 'Infinity'
  assert.equal(common.formatCount(-5), '0');
  assert.equal(common.formatCount('abc'), '0');
  assert.equal(common.formatCount(undefined), '0');
  assert.equal(common.formatCount(null), '0');
  assert.equal(common.formatCount(Infinity), '0');
  assert.equal(common.formatCount('1234'), '1,234', '数字字符串照常分组');
  assert.equal(common.formatCount(1234.9), '1,234', '向下取整（与 ipc-limits 的超限文案同一口径）');
});

test('stripBom：只吃第 0 位那个 BOM，其余一律 String() 兜底（B6 从 atomic / txt / capture 收编）', () => {
  assert.equal(common.stripBom('\uFEFFabc'), 'abc');
  assert.equal(common.stripBom('abc'), 'abc');
  assert.equal(common.stripBom('a\uFEFFb'), 'a\uFEFFb', '正文中间的 U+FEFF 是作者的字，不动');
  assert.equal(common.stripBom(''), '');
  assert.equal(common.stripBom(null), '', 'null 按空串兜底（旧的三份副本都是这个口径）');
  assert.equal(common.stripBom(undefined), '');
  assert.equal(common.stripBom(42), '42', '数字同样交给 String()');
  assert.equal(common.stripBom('\uFEFF'), '');
});

test('normalizeText：去开头 BOM + CRLF / CR 归一成 LF（B6 从五个模块收编）', () => {
  assert.equal(common.normalizeText('\uFEFF第一行\r\n第二行\r第三行\n第四行'), '第一行\n第二行\n第三行\n第四行');
  assert.equal(common.normalizeText('没有换行'), '没有换行');
  assert.equal(common.normalizeText(null), '');
  assert.equal(common.normalizeText(undefined), '');
  assert.equal(common.normalizeText(12), '12');
  assert.equal(common.normalizeText('a\r\r\nb'), 'a\n\nb', '\r 与 \r\n 各算一次换行，不会合成一个');
  // 与 normalizeText 同一份 stripBom：只去开头那一个 BOM
  assert.equal(common.normalizeText('\uFEFF\uFEFFx'), '\uFEFFx');
});

test('lineStartsOf / positionOf：行首位置表 + 1 基行列（B6 从 proofread / sensitive 收编）', () => {
  assert.deepEqual(common.lineStartsOf(''), [0], '空文本也有一行（第 0 行从 0 开始）');
  assert.deepEqual(common.lineStartsOf('abc'), [0]);
  assert.deepEqual(common.lineStartsOf('a\nb'), [0, 2]);
  assert.deepEqual(common.lineStartsOf('a\n\nb'), [0, 2, 3], '空行同样占一行');
  assert.deepEqual(common.lineStartsOf('\n'), [0, 1]);
  // 只认 \n：CRLF 要先 normalizeText，否则 \r 会被算进上一行
  const starts = common.lineStartsOf('第一行\n第二行\n第三行');
  assert.deepEqual(common.positionOf(starts, 0), { line: 1, column: 1 });
  assert.deepEqual(common.positionOf(starts, 2), { line: 1, column: 3 });
  assert.deepEqual(common.positionOf(starts, 4), { line: 2, column: 1 }, '换行符后一位就是下一行第 1 列');
  assert.deepEqual(common.positionOf(starts, 8), { line: 3, column: 1 });
  assert.deepEqual(common.positionOf([0], 5), { line: 1, column: 6 }, '单行文本里位置照样往上加');
  assert.deepEqual(common.positionOf([0], 0), { line: 1, column: 1 });
});

test('mapLimit：限并发、结果按原顺序、空数组直接返回、任一任务抛错整体拒绝（B6 收编）', async () => {
  assert.deepEqual(await common.mapLimit([], 4, async () => 1), []);
  const items = [5, 1, 3, 2, 4];
  const out = await common.mapLimit(items, 2, async (n, index) => {
    await common.sleep(n);
    return `${index}:${n}`;
  });
  assert.deepEqual(out, ['0:5', '1:1', '2:3', '3:2', '4:4'], '结果按 items 原顺序，不按完成先后');
  // 并发上限：limit=2 时同时在跑的任务不超过 2 个（limit 大于长度时按长度算）
  let running = 0;
  let peak = 0;
  await common.mapLimit([1, 1, 1, 1, 1, 1], 2, async () => {
    running += 1;
    peak = Math.max(peak, running);
    await common.sleep(5);
    running -= 1;
  });
  assert.ok(peak <= 2, `并发峰值 ${peak} 超过 limit=2`);
  let runningBig = 0;
  let peakBig = 0;
  await common.mapLimit([1, 1], 8, async () => {
    runningBig += 1;
    peakBig = Math.max(peakBig, runningBig);
    await common.sleep(5);
    runningBig -= 1;
  });
  assert.equal(peakBig, 2, 'limit 大于数组长度时同时跑的任务数就是数组长度');
  // 抛错：整体 reject（不会悄悄吞掉失败项）
  await assert.rejects(
    () => common.mapLimit([1, 2], 1, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    }),
    /boom/
  );
});

test('nowIso：可注入固定时钟；不传就是现在；时钟给坏值退回现在（B6 收编）', () => {
  const fixed = new Date('2026-11-04T10:30:00.000Z');
  assert.equal(common.nowIso(() => fixed), '2026-11-04T10:30:00.000Z');
  const before = Date.now();
  const now = Date.parse(common.nowIso());
  assert.ok(Number.isFinite(now), '不传 clock 时必须是可解析的 ISO 串');
  assert.ok(Math.abs(now - before) < 5000, '不传 clock 时应该就是「现在」');
  // 时钟返回坏值 / 不返回 Date：退回现在（search-index 原来那份的兜底口径）
  assert.ok(Number.isFinite(Date.parse(common.nowIso(() => new Date('坏的')))));
  assert.ok(Number.isFinite(Date.parse(common.nowIso(() => null))));
  assert.ok(Number.isFinite(Date.parse(common.nowIso('不是函数'))), '传了非函数就当时钟没给');
});

test('parseDayKey / isValidDayKey：只认严格且真实存在的本地日期（B6 从 logs / stats 收编）', () => {
  assert.deepEqual(common.parseDayKey('2026-10-31'), { year: 2026, month: 10, day: 31 });
  assert.deepEqual(common.parseDayKey('  2026-10-31  '), { year: 2026, month: 10, day: 31 }, '首尾空白不算错');
  assert.equal(common.parseDayKey('2026-2-1'), null, '月日必须两位');
  assert.equal(common.parseDayKey('2026-02-30'), null, '2 月 30 日不是真实日期');
  assert.equal(common.parseDayKey('2025-13-01'), null);
  assert.equal(common.parseDayKey('1969-12-31'), null, '年份下限 1970（时间戳纪元）');
  assert.equal(common.parseDayKey('10000-01-01'), null, '年份上限 9999');
  assert.equal(common.parseDayKey('2026-10-31T00:00:00'), null, '带时间的不算日期键');
  assert.equal(common.parseDayKey(null), null);
  assert.equal(common.parseDayKey(20261031), null, '数字不是日期键');
  assert.equal(common.isValidDayKey('2026-10-31'), true);
  assert.equal(common.isValidDayKey('2026-10-32'), false);
  assert.equal(common.isValidDayKey(''), false);
  assert.equal(common.isValidDayKey(undefined), false);
});

test('dayKeyOf：按本机日历格式化（补零 / 分隔符），不做兜底（B6）', () => {
  assert.equal(common.dayKeyOf(new Date(2026, 0, 5)), '2026-01-05', '月和日都补到两位');
  assert.equal(common.dayKeyOf(new Date(2026, 10, 4), ''), '20261104', '快照目录名口径');
  assert.equal(common.dayKeyOf(new Date(2026, 10, 4), '-'), '2026-11-04');
  assert.equal(common.dayKeyOf(new Date(2026, 11, 31)), '2026-12-31');
});

test('createWriteQueue：严格按顺序串行、失败不堵队列、enqueue 返回该任务自己的结果（B6 收编）', async () => {
  const queue = common.createWriteQueue();
  const order = [];
  const first = queue.enqueue(async () => {
    order.push('a:start');
    await common.sleep(20);
    order.push('a:end');
    return 'a';
  });
  const second = queue.enqueue(async () => {
    order.push('b:start');
    await common.sleep(1);
    order.push('b:end');
    return 'b';
  });
  assert.deepEqual(await Promise.all([first, second]), ['a', 'b']);
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end'], '后一个任务必须等前一个跑完');
  // 失败的任务：错误如实还给它的调用方，队列照常继续
  const failed = queue.enqueue(async () => {
    order.push('c:fail');
    throw new Error('写盘失败');
  });
  await assert.rejects(() => failed, /写盘失败/);
  order.length = 0;
  const after = queue.enqueue(async () => {
    order.push('d');
    return 'd';
  });
  assert.equal(await after, 'd', '一个任务失败不能堵死后面的任务');
  assert.deepEqual(order, ['d']);
  // idle：等当前排队的任务都跑完；之后再排进来的不在这次等待里
  const asyncQueue = common.createWriteQueue();
  let done = false;
  asyncQueue.enqueue(async () => {
    await common.sleep(15);
    done = true;
  });
  await asyncQueue.idle();
  assert.equal(done, true, 'idle() 必须真的等到任务跑完');
  const other = common.createWriteQueue();
  const pending = other.enqueue(() => common.sleep(5));
  await other.idle();
  await pending;
});

test('createKeyedWriteQueue：同 key 串行、不同 key 并行、失败不堵、settle 后条目回收（A4）', async () => {
  const queue = common.createKeyedWriteQueue();
  // 不同 key：book-b 立刻能跑，不必等 book-a 的闸门打开
  let releaseA;
  const gateA = new Promise((resolve) => { releaseA = resolve; });
  const a = queue.enqueue('book-a', async () => {
    await gateA;
  });
  let bRan = false;
  const b = queue.enqueue('book-b', async () => {
    bRan = true;
  });
  await b;
  assert.equal(bRan, true, '不同 key 不该互相排队');
  releaseA();
  await a;
  // 同一 key：严格按调用顺序串行
  const order = [];
  const first = queue.enqueue('book-c', async () => {
    order.push('c1:start');
    await common.sleep(15);
    order.push('c1:end');
  });
  const second = queue.enqueue('book-c', async () => {
    order.push('c2:start');
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['c1:start', 'c1:end', 'c2:start'], '同一个 key 必须串行');
  // 失败不堵同一条链
  await assert.rejects(
    () =>
      queue.enqueue('book-d', async () => {
        throw new Error('写盘失败');
      }),
    /写盘失败/
  );
  assert.equal(await queue.enqueue('book-d', async () => 'ok'), 'ok', '一个任务失败不能堵死后面的任务');
  // idle(key) 只等这一条链；idle() 等全部当前链
  let done = false;
  queue.enqueue('book-e', async () => {
    await common.sleep(5);
    done = true;
  });
  await queue.idle('book-e');
  assert.equal(done, true, 'idle(key) 必须等到这条链跑完');
  await queue.idle();
  // 条目回收：settle 后 Map 清空（回收在 settle 的微任务里，等一拍让它跑完）
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  await flush();
  assert.equal(queue.pendingCount(), 0, '链 settle 后条目必须回收');
  // clearIdle：正在飞的条目绝不拆，settle 后照样回收
  let releaseLive;
  const liveGate = new Promise((resolve) => { releaseLive = resolve; });
  const live = queue.enqueue('book-live', async () => {
    await liveGate;
  });
  assert.equal(queue.clearIdle('book-live'), false, '在飞条目绝不拆');
  assert.equal(queue.pendingCount(), 1, '在飞条目仍在 Map 里');
  releaseLive();
  await live;
  await flush();
  assert.equal(queue.pendingCount(), 0, 'settle 后必须回收');
});

test('core/common.js 是纯逻辑：不 require 任何模块，也不碰 process / window / document', () => {
  assert.equal(/require\s*\(/.test(COMMON_CODE), false, '不许 require（fs / path / electron 都不行）');
  assert.equal(/\bprocess\s*\./.test(COMMON_CODE), false, '不许碰 process');
  assert.equal(/\bwindow\s*\./.test(COMMON_CODE), false, '不许碰 window');
  assert.equal(/\bdocument\s*\./.test(COMMON_CODE), false, '不许碰 document');
  assert.equal(/electron/.test(COMMON_CODE), false, '不许出现 electron');
  // 对外形状固定：多一个少一个都要在评审里看到（formatCount 是 2026-11-04 拍板 #1 新增的共享格式化；
  // stripBom / normalizeText / lineStartsOf / positionOf / mapLimit / nowIso 是 B6 收编进来的）
  assert.deepEqual(Object.keys(common).sort(), [
    'clampInt',
    'createKeyedWriteQueue',
    'createWriteQueue',
    'dayKeyOf',
    'formatCount',
    'isValidDayKey',
    'lineStartsOf',
    'mapLimit',
    'normalizeText',
    'nowIso',
    'pad2',
    'parseDayKey',
    'positionOf',
    'sleep',
    'stripBom'
  ]);
});

test('静态闸门：仓库里不许再长出第二份 pad2 / clampInt / sleep / 内联补零', () => {
  // scripts/e2e-scenario.js 是测试脚本，里面有几处就地写的 `String(x).padStart(2, '0')` 拼期望值
  // （不是产品逻辑、没有第二个调用方），有意不扫；产品代码与驱动一律不许再抄一份。
  const files = [...CORE_FILES, ...RENDERER_FILES, 'main.js', ...SCRIPT_FILES.filter((f) => f !== 'scripts/e2e-scenario.js')];
  const patterns = [
    { re: /function pad2\s*\(/, what: '第二份 pad2 实现' },
    { re: /function clampInt\s*\(/, what: '第二份 clampInt 实现' },
    { re: /function sleep\s*\(/, what: '第二份 sleep 实现' },
    { re: /function formatCount\s*\(/, what: '第二份 formatCount 实现' },
    { re: /function stripBom\s*\(/, what: '第二份 stripBom 实现' },
    { re: /function normalizeText\s*\(/, what: '第二份 normalizeText（去 BOM + CRLF→LF）实现' },
    { re: /function lineStartsOf\s*\(/, what: '第二份 lineStartsOf 实现' },
    { re: /function positionOf\s*\(/, what: '第二份 positionOf 实现' },
    { re: /function mapLimit\s*\(/, what: '第二份 mapLimit 实现' },
    { re: /function nowIso\s*\(/, what: '第二份 nowIso 实现' },
    { re: /function parseDayKey\s*\(/, what: '第二份 parseDayKey 实现' },
    { re: /function isValidDayKey\s*\(/, what: '第二份 isValidDayKey 实现' },
    { re: /function dayKeyOf\s*\(/, what: '第二份 dayKeyOf（本地日期键格式化）实现' },
    { re: /function createWriteQueue\s*\(/, what: '第二份写队列实现' },
    { re: /function createKeyedWriteQueue\s*\(/, what: '第二份 keyed 写队列实现' },
    { re: /padStart\(2, ['"]0['"]\)/, what: '内联补零 String(x).padStart(2, \'0\')' }
  ];
  // 千分位正则本体也钉住：抄一份实现时最先露馅的就是这串（用 String.raw 避免二次转义踩坑）
  const INLINE_THOUSANDS = String.raw`\B(?=(\d{3})+(?!\d))`;
  for (const rel of files) {
    const source = read(rel);
    for (const { re, what } of patterns) {
      assert.equal(re.test(source), false, `${rel} 里不该再有${what}（用 core/common.js）`);
    }
    if (rel !== 'core/common.js') {
      assert.equal(source.includes(INLINE_THOUSANDS), false, `${rel} 里不该内联千分位正则（用 core/common.js 的 formatCount）`);
    }
  }
});

test('静态闸门：用到 pad2 / clampInt / sleep / formatCount / stripBom / normalizeText 的文件必须从 core/common.js 拿', () => {
  // core/*：普通模块解构 require('./common')；core/template.js 是 UMD，解构工厂参数 common；
  // core/capture.js 的工厂参数叫 commonLib；stripBom 还允许从 './atomic' 取——atomic 自己就是
  // `const { sleep, stripBom } = require('./common')` 再导出（tests/atomic.test.js 仍按老名字取），
  // 实现只有 core/common.js 一份，gate 认的是「拿到的是那一份」而不是路径好看。
  const wiredFromCommon = (source, name) =>
    new RegExp(
      `const \\{[^}]*\\b${name}\\b[^}]*\\}\\s*=\\s*(require\\('\\.\\/common'\\)|require\\('\\.\\.\\/core\\/common'\\)|require\\('\\.\\/atomic'\\)|common|commonLib);`
    ).test(source);
  for (const rel of CORE_FILES) {
    const source = read(rel);
    for (const name of ['pad2', 'clampInt', 'sleep', 'formatCount', 'stripBom', 'normalizeText', 'lineStartsOf', 'positionOf', 'mapLimit', 'nowIso', 'parseDayKey', 'isValidDayKey', 'dayKeyOf', 'createKeyedWriteQueue', 'createWriteQueue']) {
      if (!new RegExp(`\\b${name}\\s*\\(`).test(source)) continue;
      assert.ok(wiredFromCommon(source, name), `${rel} 用了 ${name}，但没从 core/common.js 拿`);
    }
  }
  // 渲染层纯逻辑模块：从 '../core/common' 拿；renderer.js 走 window.CWCommon
  for (const rel of RENDERER_FILES) {
    const source = read(rel);
    const uses = ['pad2', 'clampInt'].filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(source));
    if (!uses.length) continue;
    assert.ok(
      /require\('\.\.\/core\/common'\)/.test(source) || /window\.CWCommon/.test(source) || /commonLib\.\w+/.test(source),
      `${rel} 用了 pad2 / clampInt，但没接上 core/common.js`
    );
  }
  // 原子写与截图驱动：sleep 也是同一份
  for (const rel of ['core/atomic.js', 'scripts/screenshot-driver.js']) {
    assert.ok(/require\('\.\/common'\)|require\('\.\.\/core\/common'\)/.test(read(rel)), `${rel} 的 sleep 应该来自 core/common.js`);
  }
  assert.equal(/window\.CWCommon/.test(read('renderer/renderer.js')), true, 'renderer.js 应该用 window.CWCommon 的 pad2');
});

test('静态闸门：index.html 先加载 core/common.js，再加载依赖它的三个文件', () => {
  const commonAt = INDEX_SOURCE.indexOf('src="../core/common.js"');
  assert.ok(commonAt > 0, 'index.html 必须加载 core/common.js');
  assert.equal(INDEX_SOURCE.split('src="../core/common.js"').length - 1, 1, 'core/common.js 只该加载一次，别重复引');
  const dependents = ['src="../core/template.js"', 'src="editor-logic.js"', 'src="find-logic.js"', 'src="renderer.js"', 'src="../core/capture.js"'];
  for (const needle of dependents) {
    const at = INDEX_SOURCE.indexOf(needle);
    assert.ok(at > 0, `index.html 里找不到 ${needle}`);
    assert.ok(commonAt < at, `${needle} 必须排在 core/common.js 之后（否则拿不到 window.CWCommon，启动即报错）`);
  }
  // v0.9 B-2：editor-logic 的字数口径取 core/chapters.js 的 countChars，chapters.js 必须排在它前面
  const chaptersAt = INDEX_SOURCE.indexOf('src="../core/chapters.js"');
  assert.ok(chaptersAt > 0, 'index.html 必须加载 core/chapters.js');
  assert.ok(
    chaptersAt < INDEX_SOURCE.indexOf('src="editor-logic.js"'),
    'core/chapters.js 必须排在 editor-logic.js 之前（否则拿不到 window.CWChapters，启动即报错）'
  );
  // v0.9 B-3：段落切分取 core/paragraphs.js，paragraphs.js 也必须排在 editor-logic.js 前面
  const paragraphsAt = INDEX_SOURCE.indexOf('src="../core/paragraphs.js"');
  assert.ok(paragraphsAt > 0, 'index.html 必须加载 core/paragraphs.js');
  assert.ok(
    paragraphsAt < INDEX_SOURCE.indexOf('src="editor-logic.js"'),
    'core/paragraphs.js 必须排在 editor-logic.js 之前（否则拿不到 window.CWParagraphs，启动即报错）'
  );
});

test('浏览器加载链：按 index.html 的顺序真跑一遍，模板 / 编辑器 / 查找都拿到共享实现', () => {
  const { win, context } = loadInBrowserSandbox([
    'core/common.js',
    'core/chapters.js',
    'core/paragraphs.js',
    'core/template.js',
    'renderer/editor-logic.js',
    'renderer/find-logic.js'
  ]);
  assert.equal(typeof win.CWCommon.pad2, 'function');
  // core/template.js 的本地日期走共享的 pad2（用沙箱自己的 Date，模拟被调用方传进来的日期）
  const sandboxDate = vm.runInContext('new Date(2026, 0, 5)', context);
  assert.equal(win.CWTemplate.localDateKey(sandboxDate), '2026-01-05');
  // renderer/editor-logic.js：sanitizeThreshold 走 clampInt，formatStopwatch 走 pad2
  assert.equal(win.CWEditorLogic.sanitizeThreshold('abc'), 500, '坏值退回默认 500 字');
  assert.equal(win.CWEditorLogic.sanitizeThreshold(1), 50, '夹到下限 50 字');
  assert.equal(win.CWEditorLogic.sanitizeThreshold(999999), 20000, '夹到上限 20000 字');
  assert.equal(win.CWEditorLogic.formatStopwatch(65), '1:05');
  assert.equal(win.CWEditorLogic.formatStopwatch(3725), '1:02:05');
  // v0.9 B-2：字数口径在浏览器链上也是 core/chapters.js 那一份（同一输入与 Node 侧一致）
  assert.equal(win.CWEditorLogic.countChars(' a　b\t\n'), 2, 'editor-logic.countChars 走共享实现（全角空格算空白）');
  assert.equal(
    win.CWEditorLogic.countChars('雨 下\r\n了\t一夜。'),
    win.CWChapters.countChars('雨 下\r\n了\t一夜。'),
    'window.CWEditorLogic 与 window.CWChapters 必须同一口径'
  );
  // v0.9 B-3：段落切分也走 core/paragraphs.js 那一份（浏览器链上两个全局同一结果）
  assert.equal(
    JSON.stringify(win.CWEditorLogic.paragraphRanges('　第一段。\n\n第二段！\n')),
    JSON.stringify(win.CWParagraphs.paragraphRanges('　第一段。\n\n第二段！\n')),
    'window.CWEditorLogic.paragraphRanges 必须就是 window.CWParagraphs 那一份'
  );
  // renderer/find-logic.js：高亮窗口上限走 clampInt（999999 夹到 2000、'abc' 退回 500）
  const matches = Array.from({ length: 10 }, (_, i) => ({ index: i, length: 1 }));
  assert.equal(win.CWFindLogic.highlightWindow(matches, 0, { max: 999999 }).maxItems, 2000);
  assert.equal(win.CWFindLogic.highlightWindow(matches, 0, { max: 'abc' }).maxItems, 500);
});

test('缺少 core/common.js 时三个模块直接报错（不悄悄退回旧副本）', () => {
  for (const [rel, name] of [
    ['core/template.js', 'CWTemplate'],
    ['renderer/editor-logic.js', 'CWEditorLogic'],
    ['renderer/find-logic.js', 'CWFindLogic']
  ]) {
    assert.throws(
      () => loadInBrowserSandbox([rel]),
      new RegExp(`${name}：core/common.js 没有先加载`),
      `${rel} 单独加载时必须明确报错，而不是带着 undefined 继续跑`
    );
  }
});

test('缺少 core/chapters.js 时 editor-logic 也直接报错（字数口径不许悄悄退回本地副本）', () => {
  assert.throws(
    () => loadInBrowserSandbox(['core/common.js', 'renderer/editor-logic.js']),
    /CWEditorLogic：core\/chapters\.js 没有先加载/,
    '只加载 common 不加载 chapters 时必须明确报错'
  );
});

test('缺少 core/paragraphs.js 时 editor-logic 也直接报错（段落切分不许悄悄退回本地副本）', () => {
  assert.throws(
    () => loadInBrowserSandbox(['core/common.js', 'core/chapters.js', 'renderer/editor-logic.js']),
    /CWEditorLogic：core\/paragraphs\.js 没有先加载/,
    'v0.9 B-3：common / chapters 都在、只缺 paragraphs 时必须明确报错'
  );
});

test('静态闸门：三个 UMD 模块在 Node 分支也把 core 依赖传给工厂', () => {
  assert.ok(/module\.exports = factory\(require\('\.\/common'\)\);/.test(read('core/template.js')));
  for (const rel of ['renderer/editor-logic.js', 'renderer/find-logic.js']) {
    assert.ok(
      /module\.exports = factory\(require\('\.\.\/core\/common'\)/.test(read(rel)),
      `${rel} 的 Node 分支要从 ../core/common 取依赖`
    );
    assert.ok(/root\.CW\w+ = factory\(root\.CWCommon/.test(read(rel)), `${rel} 的浏览器分支要取 window.CWCommon`);
  }
  // v0.9 B-2：editor-logic 的字数口径只能取 core/chapters.js 的同一份实现，两条加载路径都要接上
  // v0.9 B-3：段落切分同理，core/paragraphs.js 也要做成工厂的第三个依赖
  const editorLogic = read('renderer/editor-logic.js');
  assert.ok(
    /module\.exports = factory\(require\('\.\.\/core\/common'\), require\('\.\.\/core\/chapters'\), require\('\.\.\/core\/paragraphs'\)\);/.test(
      editorLogic
    ),
    'Node 分支要把 ../core/chapters 与 ../core/paragraphs 传给工厂'
  );
  assert.ok(
    /root\.CWEditorLogic = factory\(root\.CWCommon, root\.CWChapters, root\.CWParagraphs\);/.test(editorLogic),
    '浏览器分支要传 window.CWChapters 与 window.CWParagraphs'
  );
});

test('静态闸门：main.js 不再留着已搬走的死代码（sleep 已随 B-1 / B-3 清掉）', () => {
  assert.equal(/\bfunction sleep\s*\(/.test(MAIN_SOURCE), false, 'main.js 里那份 sleep 没人用了');
  assert.equal(/\bsleep\s*\(/.test(MAIN_SOURCE), false, 'main.js 不该再调用 sleep（自动化代码已搬进驱动）');
});
