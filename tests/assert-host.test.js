// v1.8.0 WP-32（A8）：渲染层 host 契约校验的共享实现回归锚点。
// WP17（A2，审计 #20）：实现从 renderer/assert-host.js 上移到 core/assert-host.js（ipc 也用它，
// 反向依赖 renderer/ 不成立）；入口路径变，UMD 双分支 / 浏览器全局名 CWAssertHost / 文案全不变。
//
// 背景：32 个渲染层模块的 createX(host)（v1.8.0 WP-34 起多一个 renderer/shortcuts-ui.js；
// 审计修复 #6（V302）再加一个 renderer/save-rescue-ui.js；WP6（N2）再加一个 renderer/config-change-ui.js；
// WP5（N1）再加一个 renderer/crash-recovery-ui.js；M1 第 9 轮加 renderer/toast-ui.js；
// M1 第 10 轮加 renderer/command-items-ui.js；M1 第 11 轮加 renderer/format-book-ui.js 与
// renderer/replace-one-ui.js → 41 个）
// 以前各写一遍「host 是对象 + REQUIRED_HOST 逐成员存在」；
// 这一轮抽成一份 assertHost(name, host, required)。纪律是**报错文案与行为逐字不变**：
//   · 非对象 → `createX 需要 host 对象`；
//   · 缺成员（undefined / null）→ `createX 的 host 缺少 key`（在 create() 时就抛，不等到点面板）。
// REQUIRED_HOST 清单仍留在各模块（那是各模块自己的契约），所以本文件同时钉住「清单没被改动、
// 只是校验方式换成共享实现」：静态闸门逐个模块核对调用形式与依赖接线，浏览器链再真跑一遍。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const assertHostModule = require('../core/assert-host');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const RENDERER_DIR = path.join(ROOT, 'renderer');

// 只去掉注释：静态闸门只看代码，注释里解释「共享实现长什么样」不算回潮。
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

const ASSET_HOST_SOURCE = read('core/assert-host.js');

// 全部 host 消费者：renderer 下带 `const REQUIRED_HOST =` 的模块（renderer.js 只在注释里提过它）。
function consumers() {
  return fs
    .readdirSync(RENDERER_DIR)
    .filter((name) => name.endsWith('.js'))
    .filter((name) => read(`renderer/${name}`).includes('const REQUIRED_HOST ='))
    .sort();
}

test('assertHost：通过时原样返回 host（调用方可以继续解构）', () => {
  const host = { $: () => {}, state: {}, api: {}, call: () => {} };
  assert.equal(assertHostModule.assertHost('createDemoUi', host, ['$', 'state', 'api', 'call']), host);
  // 允许 0 成员（空清单）与多余成员（各模块还可能带嵌套分组 / 可选字段）
  assert.equal(assertHostModule.assertHost('createDemoUi', { extra: 1 }, []).extra, 1);
});

test('assertHost：非对象 host 的文案 = 各模块原来的「需要 host 对象」', () => {
  for (const host of [null, undefined, 'host', 42, true]) {
    assert.throws(
      () => assertHostModule.assertHost('createDemoUi', host, ['$']),
      new TypeError('createDemoUi 需要 host 对象'),
      'host = ' + String(host)
    );
  }
});

test('assertHost：缺成员（undefined / null）都抛「的 host 缺少 key」，顺序按清单', () => {
  const full = { $: () => {}, state: {}, api: {} };
  assert.throws(
    () => assertHostModule.assertHost('createDemoUi', full, ['$', 'missing']),
    new TypeError('createDemoUi 的 host 缺少 missing')
  );
  assert.throws(
    () => assertHostModule.assertHost('createDemoUi', { ...full, state: null }, ['$', 'state']),
    new TypeError('createDemoUi 的 host 缺少 state')
  );
  // 清单顺序决定先报哪一个（与旧循环逐字一致；调用方只关心第一个缺失项）
  assert.throws(
    () => assertHostModule.assertHost('createDemoUi', {}, ['b', 'a']),
    new TypeError('createDemoUi 的 host 缺少 b')
  );
});

test('静态闸门：37 个 host 消费者都只调共享 assertHost（清单与文案留在模块里）', () => {
  const files = consumers();
  assert.equal(files.length, 42, 'host 消费者数量变了（新增 / 删除模块请同步本闸门）');
  for (const file of files) {
    const raw = read(`renderer/${file}`);
    const src = stripComments(raw);
    const fn = /function (create[A-Za-z0-9_$]+)\(host\)/.exec(src);
    assert.ok(fn, `${file} 找不到 createX(host)`);
    const name = fn[1];
    // RPAN-C08 / RSHE-A-05：嵌套分组模块多传第四个参数 REQUIRED_GROUPS（仍必须是恰好一次调用）。
    const callRe = new RegExp(`assertHost\\('${name}', host, REQUIRED_HOST(?:, REQUIRED_GROUPS)?\\);`, 'g');
    const calls = (src.match(callRe) || []).length;
    assert.equal(calls, 1, `${file} 必须恰好调用一次 assertHost('${name}', host, REQUIRED_HOST…, …)`);
    assert.equal(src.includes('for (const key of REQUIRED_HOST)'), false, `${file} 不许再手写 REQUIRED_HOST 循环`);
    assert.equal(src.includes('需要 host 对象'), false, `${file} 的「需要 host 对象」文案只许留在 assert-host.js`);
    assert.equal(src.includes("的 host 缺少 ' + key"), false, `${file} 的「的 host 缺少」文案只许留在 assert-host.js`);
    // 依赖接线：Node 分支 require、浏览器分支取 window.CWAssertHost、工厂参数收得进来
    assert.ok(raw.includes("require('../core/assert-host')"), `${file} 的 UMD Node 分支必须 require('../core/assert-host')`);
    assert.ok(raw.includes('root.CWAssertHost'), `${file} 的 UMD 浏览器分支必须取 root.CWAssertHost`);
    // 工厂签名首参必须是 assertHost（其余依赖允许追加，如 save-rescue / save-chain 的 longOpLogic）。
    // 工厂签名里必须有 assertHost（位置不限：有的模块 assertHost 在首位，有的从 UMD 依赖末尾传入）。
    assert.match(raw, /function \([^)]*\bassertHost\b[^)]*\) \{/, `${file} 的工厂签名必须收 assertHost 参数`);
  }
});

test('静态闸门：assert-host.js 是全仓唯一实现（在 core/），且页面排在所有消费者之前', () => {
  // 全仓只允许 core/assert-host.js 里出现「逐成员判定 + 两条文案」的实现（注释不算）；
  // core 与 renderer 两个目录都扫，防止有人把实现又抄回渲染层。
  const implementers = [];
  for (const dir of ['core', 'renderer']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir)).filter((file) => file.endsWith('.js')).sort()) {
      if (stripComments(read(`${dir}/${name}`)).includes("的 host 缺少 ' + key")) implementers.push(`${dir}/${name}`);
    }
  }
  assert.deepEqual(implementers, ['core/assert-host.js'], '「的 host 缺少」的实现只许在 core/assert-host.js');
  assert.equal(fs.existsSync(path.join(ROOT, 'renderer', 'assert-host.js')), false, 'renderer/assert-host.js 必须已移走');

  const html = read('renderer/index.html');
  const at = html.indexOf('<script src="../core/assert-host.js"></script>');
  assert.ok(at > 0, 'index.html 必须加载 ../core/assert-host.js');
  assert.equal(html.split('<script src="../core/assert-host.js"></script>').length - 1, 1, 'assert-host.js 只许加载一次');
  for (const file of consumers()) {
    const tagAt = html.indexOf(`<script src="${file}"></script>`);
    assert.ok(tagAt > 0, `index.html 必须加载 ${file}`);
    assert.ok(at < tagAt, 'assert-host.js 必须排在 ${file} 之前');
  }
  // 浏览器全局名与 Node 导出面一致（sweep-unused 要求导出真有消费者）
  assert.deepEqual(Object.keys(assertHostModule), ['assertHost']);
  assert.match(ASSET_HOST_SOURCE, /root\.CWAssertHost = factory\(\);/);
});

// ---------- RPAN-C08 / RSHE-A-05：嵌套分组规格（第四个参数） ----------
// 三张卡（fragments / sensitive / tidy-card）与设置弹层原来各写一份「判对象 + for 循环判键」，
// 文案 / 语义必须与共享实现逐字一致（单测按 `host.<path> 缺少 key` 断言）。
test('assertHost：嵌套分组判对象 + 逐键，文案与各模块原来手写的一致', () => {
  assert.equal(
    assertHostModule.assertHost('createDemoUi', { a: 1, peers: { refreshShelf: () => {} } }, ['a'], [
      { path: 'peers', keys: ['refreshShelf'] }
    ]).a,
    1
  );
  // 整组缺失（顶层）→ 「的 host 缺少 <前缀>」
  assert.throws(
    () => assertHostModule.assertHost('createDemoUi', { a: 1 }, ['a'], [{ path: 'peers.stats', keys: ['refreshStats'] }]),
    new TypeError('createDemoUi 的 host 缺少 peers')
  );
  // 中间层缺失 → 「的 host 缺少 peers.stats」
  assert.throws(
    () => assertHostModule.assertHost('createDemoUi', { a: 1, peers: {} }, ['a'], [
      { path: 'peers.stats', keys: ['refreshStats'] }
    ]),
    new TypeError('createDemoUi 的 host 缺少 peers.stats')
  );
  // 组不是对象 → 「的 host.<前缀> 必须是对象」
  assert.throws(
    () => assertHostModule.assertHost('createDemoUi', { peers: 'x' }, [], [{ path: 'peers', keys: [] }]),
    new TypeError('createDemoUi 的 host.peers 必须是对象')
  );
  // 组内缺键 / null 都算缺
  for (const broken of [{}, { refreshStats: null }]) {
    assert.throws(
      () => assertHostModule.assertHost('createDemoUi', { peers: { stats: broken } }, [], [
        { path: 'peers.stats', keys: ['refreshStats'] }
      ]),
      new TypeError('createDemoUi 的 host.peers.stats 缺少 refreshStats')
    );
  }
});

test('静态闸门：四个嵌套分组模块改用 REQUIRED_GROUPS（分组样板只许在 assert-host.js）', () => {
  for (const file of ['settings-ui.js', 'fragments-ui.js', 'sensitive-ui.js', 'tidy-card-ui.js']) {
    const src = stripComments(read(`renderer/${file}`));
    // 门禁：一律走嵌套分组规格
    assert.ok(src.includes('const REQUIRED_GROUPS = ['), `${file} 必须声明 REQUIRED_GROUPS`);
    assert.ok(src.includes('assertHost(') && src.includes(', REQUIRED_GROUPS);'), `${file} 必须把 REQUIRED_GROUPS 传给 assertHost`);
    // 反门禁：不许留着逐组手写的「判对象 + for 循环判键」样板
    assert.equal(src.includes("必须是对象'), `create"), false, `${file} 不许再手写分组「必须是对象」样板`);
    assert.equal(src.includes("缺少 ' + key"), false, `${file} 不许再手写分组逐键样板`);
  }
});

// ---------- T8（三审 4.3）：UMD 分支闸门只许有一处 ----------
// 以前 22 个 UI 测试文件各抄一份「module.exports = factory(require('../core/assert-host').assertHost);」
// 再各自断言一次：口径调整要同步改 22 处、漏改即假红。现在那条字面量只在 tests/ui-test-preambles.js
// 里出现一次（stripAssertHostBranch），集中闸门就在本文件上面那条用例里。
test('T8：各 UI 测试不许再自己抄一份 UMD 分支闸门（只留 ui-test-preambles + 本文件）', () => {
  const preambles = require('./ui-test-preambles');
  // helper 行为：只剥 UMD 的 Node 分支那一行，其它 require 原样留下
  const sample = [
    "const a = 1;",
    "module.exports = factory(require('../core/assert-host').assertHost);",
    "const fs = require('node:fs');",
    "require('./other');"
  ].join('\n');
  const stripped = preambles.stripAssertHostBranch(sample);
  assert.equal(stripped.includes('../core/assert-host'), false, 'helper 要真的剥掉那一行');
  assert.match(stripped, /require\('node:fs'\)/, '别的 require 不许被连带剥掉');
  assert.match(stripped, /require\('\.\/other'\)/);
  assert.equal(preambles.ASSERT_HOST_NODE_BRANCH, "module.exports = factory(require('../core/assert-host').assertHost);");

  // 反门禁：任何测试文件（除 helper 与本文件）都不许再出现本地那份 assertHostBranch 抄写
  const offenders = [];
  for (const name of fs.readdirSync(__dirname).filter((file) => file.endsWith('.js')).sort()) {
    if (name === 'ui-test-preambles.js' || name === 'assert-host.test.js') continue;
    const raw = fs.readFileSync(path.join(__dirname, name), 'utf8');
    if (raw.includes('const assertHostBranch =')) offenders.push(name);
    // 也不许把那条字面量再写一遍（各文件只需要 helper；重复写会让口径再次分叉）
    if (raw.includes(preambles.ASSERT_HOST_NODE_BRANCH)) offenders.push(`${name}（字面量重复）`);
  }
  assert.deepEqual(offenders, [], `这些测试还在自己抄 UMD 分支：${offenders.join(' / ')}`);
  // 至少还有多处在用 helper（不是把调用点全删光的假绿）
  const users = fs
    .readdirSync(__dirname)
    .filter((file) => file.endsWith('.js') && file !== 'ui-test-preambles.js')
    .filter((file) => fs.readFileSync(path.join(__dirname, file), 'utf8').includes('stripAssertHostBranch'));
  assert.ok(users.length >= 20, `用共享 helper 的测试文件太少（${users.length}）——是不是又各自抄回去了？`);
});

test('浏览器链：先加载 core/assert-host.js 后，模块的 create 缺成员仍逐字报错', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(ASSET_HOST_SOURCE, context, { filename: 'core/assert-host.js' });
  // REDT-B-06 起 undo-ui 还依赖 renderer/undo-action.js（TTL 单一来源），按 index.html 的顺序先加载它。
  vm.runInContext(read('renderer/undo-action.js'), context, { filename: 'renderer/undo-action.js' });
  for (const file of ['bookinfo-ui.js', 'undo-ui.js']) {
    vm.runInContext(read(`renderer/${file}`), context, { filename: `renderer/${file}` });
  }
  assert.equal(typeof win.CWAssertHost.assertHost, 'function');
  // 两条真实模块的文案（一个是普通模块，一个 REQUIRED_HOST 只有 3 项）
  assert.throws(
    () => win.CWBookinfoUi.create({}),
    /createBookinfoUi 的 host 缺少 \$/
  );
  assert.throws(
    () => win.CWUndoUi.create({ slot: {} }),
    /createUndoUi 的 host 缺少 \$/
  );
  // 没先加载依赖：模块装载期直接报错，不会带着 undefined 静默放行
  // （vm 沙箱里的 TypeError 与主 realm 不同原型，所以按文案断言，不按构造函数断言）
  assert.throws(
    () => vm.runInContext(read('renderer/undo-ui.js'), vm.createContext({}), { filename: 'renderer/undo-ui.js' }),
    /undo-action\.js 没有先加载/
  );
  const noAssertHost = vm.createContext({});
  vm.runInContext(read('renderer/undo-action.js'), noAssertHost, { filename: 'renderer/undo-action.js' });
  vm.runInContext(read('renderer/undo-ui.js'), noAssertHost, { filename: 'renderer/undo-ui.js' });
  assert.throws(
    () => noAssertHost.CWUndoUi.create({ $: () => {}, slot: {}, toast: () => {} }),
    /assertHost is not a function/
  );
});