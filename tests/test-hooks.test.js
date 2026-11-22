/* 测试钩子拆分（v0.9 B-2，代码审计 F5）的自检
 *
 * 拆完以后「钩子还在不在、活绑定还是活的、renderer.js 有没有留残渣」靠这里钉住：
 * - 行为：Node 里直接 require + create（不需要 DOM），活绑定（模块级 let）必须读最新值；
 * - 契约：钩子里用到的每个 host.X 都必须由 renderer.js 的 testHooksScope() 提供，
 *   反过来 scope 里的每个名字都必须真的在 renderer.js 有模块级声明（写错一个字只会在
 *   ?test=1 时 ReferenceError，E2E 才会红——这条静态闸门把问题提前到单测）；
 * - 静态闸门：renderer.js 不许再内嵌钩子、index.html 不许静态加载 test-hooks.js
 *   （证明「只有 ?test=1 才加载」这件事没被后来的人改回去）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TEST_HOOKS = path.join(__dirname, '..', 'renderer', 'test-hooks.js');
const RENDERER = path.join(__dirname, '..', 'renderer', 'renderer.js');
const INDEX = path.join(__dirname, '..', 'renderer', 'index.html');

const testHooksSrc = fs.readFileSync(TEST_HOOKS, 'utf8');
const rendererSrc = fs.readFileSync(RENDERER, 'utf8');
const indexSrc = fs.readFileSync(INDEX, 'utf8');
const hooksModule = require(TEST_HOOKS);

/** 去掉注释（保留字符串里的内容），静态闸门要排除注释里的示例 */
function stripComments(src) {
  let out = '';
  let mode = null; // null | "'" | '"' | '`' | '//' | '/*'
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    if (mode === '//') {
      if (ch === '\n') {
        mode = null;
        out += ch;
      }
      continue;
    }
    if (mode === '/*') {
      if (ch === '*' && next === '/') {
        mode = null;
        i += 1;
      }
      continue;
    }
    if (mode) {
      out += ch;
      if (ch === '\\') {
        out += src[i + 1] || '';
        i += 1;
        continue;
      }
      if (ch === mode) mode = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      mode = '//';
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      mode = '/*';
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') mode = ch;
    out += ch;
  }
  return out;
}

const testHooksCode = stripComments(testHooksSrc);
const rendererCode = stripComments(rendererSrc);

/** renderer.js 里 testHooksScope() 返回对象的键（shorthand / get / set 三种写法） */
function scopeKeys(src) {
  const start = src.indexOf('function testHooksScope()');
  assert.ok(start > 0, 'renderer.js 里找不到 testHooksScope()');
  const end = src.indexOf('\n    };', start);
  assert.ok(end > start, 'testHooksScope() 的对象字面量没找到收尾');
  const block = src.slice(start, end);
  const keys = new Set();
  for (const line of block.split('\n')) {
    const shorthand = /^\s{6}([A-Za-z_$][\w$]*),\s*$/.exec(line);
    if (shorthand) keys.add(shorthand[1]);
    const accessor = /^\s{6}(?:get|set) ([A-Za-z_$][\w$]*)\s*\(/.exec(line);
    if (accessor) keys.add(accessor[1]);
  }
  return keys;
}

/** 桩宿主：任何取不到的名字都返回一个空函数，够 create() 建表（create 本身不许碰 DOM） */
function stubHost(extra = {}) {
  return new Proxy(extra, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key !== 'string') return undefined;
      return () => {};
    },
    has() {
      return true;
    }
  });
}

test('测试钩子模块：Node 里能 require、导出 create，create() 不碰 DOM', () => {
  assert.strictEqual(typeof hooksModule, 'object');
  assert.strictEqual(typeof hooksModule.create, 'function');
  const host = stubHost({ state: { view: 'shelf' } });
  const hooks = hooksModule.create(host);
  assert.strictEqual(typeof hooks, 'object');
  assert.strictEqual(hooks.ready, false, 'ready 由 renderer.js 装配后才置 true');
  assert.strictEqual(hooks.state, host.state, 'state 必须是渲染层同一个对象（不是拷贝）');
  assert.strictEqual(typeof hooks.save, 'function');
  assert.strictEqual(typeof hooks.handleCloseRequest, 'function');
});

test('测试钩子模块：拆分前后钩子名称与数量不变（516 个；2026-11-10 卷章目录 +3 / 章节多选 +2 / 1.6.0 统计筛选 +6 / 1.6.0 书架分组 +10 / 1.6.0b 分组列表 +3 / 1.7.0 F3d 多份校对词表 +1 / 2026-11-14 WP-01 保存延迟注入 +1 / WP-02 长操作延迟注入 +1、编辑区锁查询 +1 / WP-03 开书、载章延迟注入 +2 / WP3 替换回执延迟注入 +1 / WP5 崩溃恢复 +3）', () => {
  const hooks = hooksModule.create(stubHost());
  const names = Object.keys(hooks).sort();
  assert.strictEqual(names.length, 516, '钩子数量变了：拆文件时漏了 / 多了，核对 E2E 引用');
  // 每个功能域各抽一个，防止「数量对但换了一批」
  for (const name of [
    'ready', 'state', 'newBook', 'openBookPath', 'openBookInNewWindow', 'releaseBook', 'windowInfo',
    'newChapter', 'insertAfter', 'renameChapterAt', 'deleteChapterAt', 'switchTo', 'setText', 'text',
    'inputTick',
    'save', 'saveVisible', 'toasts', 'clearToasts', 'setTestVerifyBook', 'setTestSaveDelay', 'chapterTitles',
    'setTestBookOpDelay', 'editorLocked', 'setTestOpenBookDelay', 'setTestLoadChapterDelay',
    'setTestFindNextDelay',
    'crashDraftTick', 'crashRecoveryStatus', 'setCrashDraftEnabled',
    'openFindPanel', 'closeFindPanel', 'openProofreadPanel', 'proofreadRun', 'openSensitivePanel',
    'sensitiveRun', 'ttsFakeState', 'ttsFakeFinish',
    'formatCurrentChapter', 'runFormatBook', 'exportFormat', 'fontDecodeMode', 'setInput', 'setSelect',
    'openCapture', 'captureApplyBody', 'captureCreateChapter', 'captureOpen', 'captureRecords',
    'captureView', 'captureQueue', 'captureQueueClear',
    'chapterFilter', 'setChapterFilter', 'chapterDirectoryInfo',
    'chapterSelection', 'clearChapterSelection',
    'historyGroupIndexBySnapshotName', 'historyGroupExpanded', 'clickHistoryClearSnapshot',
    // 1.6.0 F5：书架标签筛选 / 分组管理
    'shelfTagOptions', 'setShelfTag', 'shelfGroupManageVisible', 'openGroupManageDialog',
    'groupManageRows', 'clickGroupManageAction',
    // 1.6.0b：书卡右键「移到分组…」的菜单内联分组列表
    'bookMenuGroupOptions', 'bookGroupChooserOpen', 'clickBookMenuGroup',
    'handleCloseRequest'
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(hooks, name), `钩子丢了: ${name}`);
  }
});

test('活绑定：exportFormat 每次读最新值（不是 create 时的快照）', () => {
  let current = { enabled: false };
  const hooks = hooksModule.create({
    get exportFormat() {
      return current;
    }
  });
  assert.deepStrictEqual(hooks.exportFormat(), { enabled: false });
  current = { enabled: true, to: 'traditional' };
  assert.deepStrictEqual(hooks.exportFormat(), { enabled: true, to: 'traditional' });
});

test('活绑定：fakeSpeechState 读的是当前状态（含展开复制）', () => {
  let fake = { spoken: [], last: null, paused: false, speaking: false, pending: null };
  const hooks = hooksModule.create({
    get fakeSpeechState() {
      return fake;
    }
  });
  assert.deepStrictEqual(hooks.ttsFakeState(), {
    spoken: [], last: null, paused: false, speaking: false, hasPending: false
  });
  fake = {
    spoken: [{ text: '第一句' }],
    last: { text: '第二句' },
    paused: true,
    speaking: true,
    pending: { token: 3 }
  };
  const state1 = hooks.ttsFakeState();
  assert.deepStrictEqual(state1, {
    spoken: [{ text: '第一句' }], last: { text: '第二句' }, paused: true, speaking: true, hasPending: true
  });
  // 返回的是副本：改它不许影响内部状态
  state1.spoken.push({ text: '外部乱加' });
  state1.last.text = '被改了';
  assert.strictEqual(hooks.ttsFakeState().spoken.length, 1);
  assert.strictEqual(hooks.ttsFakeState().last.text, '第二句');
});

test('活绑定：formatBookProgressEl / lastFontDecodeMode 也读最新值', () => {
  let el = null;
  let mode = 'fetch';
  const hooks = hooksModule.create({
    get formatBookProgressEl() {
      return el;
    },
    get lastFontDecodeMode() {
      return mode;
    }
  });
  assert.strictEqual(hooks.formatBookProgressText(), '', '没有进度元素时给空串');
  el = { textContent: '正在整理第 3 / 12 章' };
  assert.strictEqual(hooks.formatBookProgressText(), '正在整理第 3 / 12 章');
  assert.strictEqual(hooks.fontDecodeMode(), 'fetch');
  mode = 'atob';
  assert.strictEqual(hooks.fontDecodeMode(), 'atob');
});

test('活绑定：setTestVerifyBook 写回宿主（函数原样、非函数归 null）', () => {
  const written = [];
  const hooks = hooksModule.create({
    set testVerifyBook(value) {
      written.push(value);
    }
  });
  const fn = async () => ({ ok: true });
  hooks.setTestVerifyBook(fn);
  hooks.setTestVerifyBook('不是函数');
  hooks.setTestVerifyBook(null);
  assert.strictEqual(written[0], fn, '函数必须原样写回去（E2E 靠它替换全书校验）');
  assert.strictEqual(written[1], null);
  assert.strictEqual(written[2], null);
});

test('契约闸门：钩子里用到的 host.X 都由 testHooksScope() 提供', () => {
  const used = new Set();
  for (const m of testHooksCode.matchAll(/\bhost\.([A-Za-z_$][\w$]*)/g)) used.add(m[1]);
  const provided = scopeKeys(rendererCode);
  const missing = [...used].filter((name) => !provided.has(name));
  assert.deepStrictEqual(missing, [], '这些名字钩子在用，但 testHooksScope() 没给：' + missing.join(', '));
  // 活绑定必须是 getter / setter，不能是普通值（否则等于快照）
  const scopeStart = rendererCode.indexOf('function testHooksScope()');
  const scopeBlock = rendererCode.slice(scopeStart, rendererCode.indexOf('\n    };', scopeStart));
  for (const name of used) {
    assert.match(
      scopeBlock,
      new RegExp('(?:get|set) ' + name.replace(/\$/g, '\\$') + '\\s*\\('),
      `活绑定 ${name} 必须是 testHooksScope() 里的 get / set 访问器`
    );
  }
});

test('契约闸门：testHooksScope() 的每个键都是 renderer.js 的模块级声明', () => {
  const keys = scopeKeys(rendererCode);
  assert.ok(keys.size > 150, 'testHooksScope() 的键太少（' + keys.size + '），是不是被误删了');
  const missing = [];
  for (const name of keys) {
    const plain = name.replace(/\$/g, '\\$');
    const declared =
      new RegExp('^  (?:const|let|var) ' + plain + '\\s*=', 'm').test(rendererCode) ||
      new RegExp('^  (?:async )?function ' + plain + '\\s*\\(', 'm').test(rendererCode) ||
      new RegExp('^  (?:const|let|var) \\{[^}]*\\b' + plain + '\\b', 'm').test(rendererCode);
    if (!declared) missing.push(name);
  }
  assert.deepStrictEqual(missing, [], 'testHooksScope() 里有名字在 renderer.js 找不到模块级声明：' + missing.join(', '));
});

test('契约闸门：钩子文件不碰 window / require / 文件系统（纯渲染层内部调用）', () => {
  assert.ok(!/\brequire\s*\(/.test(testHooksCode), '测试钩子文件不许 require');
  assert.ok(!/window\./.test(testHooksCode), '测试钩子文件不许直接摸 window（挂载由 renderer.js 做）');
  assert.ok(!/\bprocess\./.test(testHooksCode), '测试钩子文件不许摸 process');
  assert.ok(!/\b__cwTest\b/.test(testHooksCode), 'window.__cwTest 的装配留在 renderer.js');
});

test('静态闸门：renderer.js 不再内嵌测试钩子', () => {
  assert.ok(!/function createTestHooks\s*\(/.test(rendererCode), 'renderer.js 里不许再有 createTestHooks');
  assert.ok(!/= createTestHooks\(\)/.test(rendererCode), 'renderer.js 里不许再调用 createTestHooks');
  // 抽几个只可能出现在钩子里的名字：出现在 renderer.js 就说明又搬回来了
  for (const name of ['ttsFakeState', 'setTestVerifyBook', 'formatBookProgressText', 'fontDecodeMode', 'setInput']) {
    assert.ok(!rendererCode.includes(name), `renderer.js 里不该再有测试钩子 ${name}`);
  }
  // 1.6.0 G2：原阈值 9600 是恒真断言（1.5.0 实测 5691 行、本版实测 5764 行，永远够不到）。
  // 改成按上一版实测值的硬预算：只能减不能加；确有新模块要放进来时，同时改这个数字并在
  // 提交信息里写清为什么，避免「阈值远大于实际」的门再次退化成摆设。
  // 1.6.0 A5：5764 → 5782（+18，全部是热路径接线，没有可搬的独立模块）——
  //   当前章条目的缓存引用（activeChapterItem）、输入路径字数统计传 defer、escProbe 只在
  //   Esc / 锁键层时现算；三者都要读 renderer.js 内部的 DOM 引用与按键上下文，搬出去只能靠
  //   注入一堆回调，反而更绕。新增行里约一半是解释「为什么不能再退回旧写法」的注释。
  // 1.6.0 F4b：5782 → 5784（+2）：顶栏右键「命令面板」的订阅。必须调 renderer.js 内部的
  //   openCommandPalette()（它带 anyBackdropOpen 锁键层判定，和 Ctrl+K 同一个入口）；
  //   搬出去就得把面板状态与锁键层一起注入，反而绕。只有一行注释 + 一行订阅。
  // 1.6.0b：5784 → 5796（+12）：书卡「移到分组…」从弹询问框改成菜单内联分组列表——
  //   每次打开菜单时收起上次列表（2 行）、解构 3 个入口（1 行）、菜单点击分支与重新夹紧（9 行）。
  //   列表 DOM 与写入逻辑都在 renderer/bookinfo-ui.js，这里只留事件接线；再搬走就只能把
  //   hideBookMenu / placeMenuAt 反向注入，反而更绕。
  // 1.6.1 P-01：5796 → 5802（+6）：强制退出前给渲染层一次落盘机会的订阅。处理函数必须调 renderer.js
  //   内部的 saveCurrent()（带 state / editorEl / updateStatus 与保存中的并发闸门），搬出去要把整条
  //   保存链路反向注入回来，反而更绕；它也只在 app:close-requested 的关窗接线旁才有意义。
  // 1.7.0 P4-1：5802 → 5804（+2 行装配）：校对 / 敏感词预检的「点结果 → 跳过去选中」收编成共用模块
  //   renderer/result-jump-ui.js，renderer.js 每个面板只多一行 resultJump 装配；行为与收编前逐字一致。
  //   （split 计数含末尾空行，故预算比 wc -l 多 1。）
  // 1.7.1 P1：5804 → 5812（+8）：输入法组字中的 Enter 不许当提交（审计 V73）——三条链路的
  //   `if (event.isComposing) return;` 必须长在各自的监听器里：全局 keydown 那条要赶在 Esc 注册表
  //   之前（兜住 modalInput → modal-confirm），跳章 / 书架搜索两条要赶在 preventDefault 之前；
  //   搬进独立模块就得把三个监听器的上下文反向注入，反而更绕。8 行里 5 行是解释这个语义的注释。
  // 1.8.0 WP-01（C1，审计高优先级）：5812 → 5825（+13）：保存快照化改动三处，都要读 renderer.js
  //   内部闭包，搬不出去——① saveCurrent 里 await 前拍正文快照（1 行 + 3 行说明）；
  //   ② 回执后用快照重算 dirty（纯判定收进 save-logic.js，这里只接一行 + 1 行说明）；
  //   ③ testHooksScope 的 testSaveChapter 活绑定（4 行）+ 模块级声明（1 行 + 2 行说明）。
  //   其中 7 行是注释，实际语句只有 6 行；少一行都会让「保存期间输入 → 仍提示未保存」失效。
  // 1.8.0 WP-02（C2，审计高优先级）：5825 → 5947（+122）：长操作编辑区保护必须读 renderer.js 的
  //   内部闭包（editorEl / state / 三个异步流程），纯判定部分（书换没换 / 期间有没有新输入）已经
  //   抽进 renderer/long-op-logic.js 并有单测；留在这里的是三处无法搬走的时序接线——
  //   ① 编辑区只读锁的 begin/end/locked（约 20 行，含 9 行说明：为什么要锁、什么时候解）；
  //   ② restoreReplaceBackupFlow 入口捕获 bookPath + 四个 await 后复核（约 30 行）；
  //   ③ reloadOpenBookFromDisk 重载前 / openBook await 后双重复核（约 20 行）；
  //   ④ runFormatBook 把预检查拖进锁内、完成后按判定分流重载 / 保留编辑区（约 50 行）。
  //   搬进独立模块就得把 editorEl、state、call、toast、loadChapterAt 全部反向注入，比现在更绕；
  //   新增行里约 55 行是解释「为什么不能再退回旧写法」的注释，实际语句约 65 行。
  // 1.8.0 WP-03（V101 / V102 / C9 / C10）：5947 → 6142（+195）：开书 / 载章状态机必须读 renderer.js 的
  //   内部闭包（state / editorEl / openBookByPath / loadChapterAt / saveCurrent 的时序），
  //   纯判定部分（save-logic / open-book-guard / long-op-logic）已在各自模块且有单测；这里留下的是
  //   无法搬走的时序接线——① openSeq / loadChapterSeq 与两类等待者（约 60 行，含 30 行说明：
  //   为什么令牌按书 + 章、为什么载章 / 保存在途要先等落定）；② 编辑区「打开中 / 载章中 / 无有效章节」
  //   的统一只读出口（约 25 行）；③ openBookByPath 每处 await 后的世代复核 + 提交前清空 / 遮罩
  //   （约 60 行）；④ loadChapterAt 成功才提交 + 失败保持遮罩（约 30 行）；⑤ saveCurrent 按快照章
  //   身份结算（约 45 行）。搬进独立模块就得把 editorEl、state、toast、两个 IPC 全反向注入，
  //   比现在更绕；结构拆分留给 WP-34。
  // 1.8.0 WP-04（C3 / C8 / V112）：6142 → 6151（+9）：输入法组字守卫统一后，renderer.js 只剩
  //   ① 模块级 `const imeGuard = window.CWImeGuard;`（2 行说明 + 1 行声明）；
  //   ② 提交键换用共享判据：章节筛选框的 Enter 是新增守卫（2 行，原来完全没判），
  //      另有 5 处逐行替换（书架搜索 / 跳章 / 全局 keydown / ? / Ctrl+K，行数不变）；
  //   ③ 三处 create 装配各多一行 `imeGuard,`（书籍信息 / 命令面板 / 查找）。
  //   判据本身（isComposing || keyCode 229）在 renderer/ime-guard.js，单测见 tests/ime-guard.test.js；
  //   留在这里的只是各监听器的上下文接线（要赶在 preventDefault 之前），搬走反而更绕。
  // 1.8.0 WP-13（C11 / C12）：6151 → 6163（+12）：① 通用询问框改成单实例排队，状态机在
  //   renderer/modal-queue.js（Node 单测覆盖），renderer.js 只留两块搬不走的接线：
  //   模块级 `const modalQueueModule = window.CWModalQueue;`（2 行说明 + 1 行声明）+
  //   openModal 的 DOM 装配从「自己 new Promise 并覆盖 state.modal」改成
  //   modalQueueModule.create({ show, hide })（净 +8 行，其中 5 行说明；openModal / closeModal 收成转发）；
  //   ② 查找模块的 host 多一行 `longOpLogic,`（整本替换回执按 C2 判定，见 renderer/find-ui.js）。
  // 1.8.0 WP-15（C15/C16/C36/C37/C40/V111/V202）：6163 → 6168（+5）：异步回执的世代令牌 / 章身份
  //   快照收进 renderer/stale-guard.js（Node 单测覆盖），renderer.js 只多 ① 模块级
  //   `const staleGuard = window.CWStaleGuard;`（2 行说明 + 1 行声明）与 ② 查找 / 导出两处装配的
  //   `staleGuard,`（其余 6 个面板的 host 在同一行追加，不增行）。
  // 1.8.0 WP-18（C22/C24/C38/C39）：6168 → 6176（+8，当前 6176 行）：C24 让 scrollCaretIntoView
  //   复用专注模式打字机的镜像实测（软换行下「\n 数 × 行高」会把几十个视觉行算成 1 行）；
  //   测量与滚动判定都进了 focus-logic.js（planCaretReveal 有单测），renderer.js 只剩
  //   「量不到才退回换行数估算」的装配（6 行语句）+ 5 行说明为什么要这样接。C22 / C38 / C39
  //   分别在 menu-keyboard / drag-sort-ui / fragments-ui 里，renderer.js 一行都没加。
  // 1.8.0 WP-28（B5/B6/B7）：6176 → 6177（+1）：历史面板 host 多一行
  //   `protectedUndoGroups: () => undoUi.protectedGroupIds()`（B6 清理备份时跳过 10 秒撤销引用的组）；
  //   流式导出 / 备份清理 / 碎片列表的实现全在 core/* 与 renderer/history-ui.js，renderer.js 其余零新增。
  // 1.8.0 WP-29（B16/B17/B14 等）：6177 → 6253（+76）：B17 改名 / 改状态 / 批量改状态 / 卷改名走
  //   「只更新这一条」快路径（syncChapterItemInfo / syncVolumeHeaderName，约 60 行，必须读 renderer.js
  //   的章节项 DOM 与内部工具）；B16 的弹层开合缓存实现在 backdrop-registry.createOpenWatcher（单测覆盖），
  //   renderer.js 只多 watcher 创建 + anyBackdropOpen 读缓存（约 10 行）；B15 的字体度量失效只多
  //   applyEditorStyle 里一行 resetCaretMeasureCache()。其余小项都在各自模块里。
  // 试用分支 paste-bulk-write-path（v1.8.0 试用 B）：6253 → 6256（+3，当前 6256 行）：
  // 大段插入的三块接线都读 renderer.js 内部闭包——① insertIntoBody 的整串赋值分支 + 一次性
  // 撤销快照（editorEl / onEditorInput / toastActionable 都在这里）；② 正文上的第一下 Ctrl+Z
  // 拦截（只有快照还在时接管，不能搬去全局键盘表，否则会抢别的输入框）；③ 捕获超限的提示分支
  // （onClipboardChanged 订阅在渲染层的同一处）。纯判定（shouldBulkWrite / 阈值夹紧）已经进了
  // renderer/editor-logic.js 并有单测；搬走这三块要把插入链路与编辑器状态整体反向注入，反而更绕。
  // 审计修复 #5 / #6 / #7（V301 / V302 / V401）：6256 → 6289（+33）。三条都必须在渲染层闭包里接线：
//   ① V401：commitOpenBook 清 bulkWriteUndo（+1 行代码 + 4 行说明）、快照带 bookPath / chapterId、
//      undoBulkWrite 执行前核对身份（约 +12 行，读写的是编辑器状态与 toast，搬走要反向注入整条链路）；
//   ② V301 / V302：saveCurrent 的失败分支接救稿出口（+7 行）与 expectedMtimeMs 参数（+4 行）——
//      saveCurrent 是函数声明、被 8 个入口与本文件闭包共享，只能在原地改；
//      对话框 / 覆盖 / 另存 / 复制 / 重载的行为全部在 renderer/save-rescue-ui.js（新模块，约 170 行）。
//   renderer.js 其余零新增；以后再加功能仍按「搬进独立模块」办，别把行数当预算花。
  // 审计修复 #10（E6）：6289 → 6297（+8）：runReplaceOne 的返回形状多带 truncated，且命中被
  //   单章上限截断时要说清「光标之后不再定位」（+5 行说明与哨兵分支）、「第 N/M+ 处」的合计标签
  //   （+3 行）。判定与哨兵形状全在 core/find.js（单测覆盖），renderer.js 只负责如实转述。
  // 审计修复 #9（P1）：6297 → 6303（+6）：首建期搜索现在立即回 building + 空结果，
  //   onSearchProgress 的 done 分支要多判一次「当前结果还挂着建索引中」并按原查询自动重搜
  //   （+4 行说明与分支），否则界面「建好后自动更新结果」无法兑现。判定与短路在
  //   core/search-index.js，空态文案在 renderer/shelf-filter-ui.js。
  // 审计修复 #41（V404）：6303 → 6304（+1）：createCaptureUi 装配注释从漂移的「9 个成员」改成实际的
  //   10 个，顺带写明第 10 个 staleGuard 的来历（注释换行多出一行）；代码零新增。
  // 审计修复 #40（V403）：6304 → 6309（+5）：正文 Ctrl+Z 拦截器执行成功后 stopPropagation（+1 行代码
  //   `const undone` / `if (undone)` 两处 + 4 行说明），让一次按键只撤销一步；判定仍全在渲染层闭包里。
  // 审计修复 #39（V402）：6309 → 6393（+84）：兜底整串赋值的一次性快照与 bulkWriteUndo 是同一套生命周期
  //   （记录 / 身份核对 / 撤销 / 输入即作废 / 换书换章作废），而 toastActionable、scrollCaretIntoView、
  //   editorEl、state 身份都在渲染层闭包里；拆一半出去只会把同一条纪律分叉成两份。三处兜底调用点
  //   （插入正文 / 套模板 / 替换这一处）+ 两个 UI 模块的 host.recordFallbackWrite 接的是同一份实现。
  // 审计修复 #55（M4，装配清单化）：6393 → 6396（+3，当前 6396 行）：renderer.js 只多一行
  //   `window.CWRendererAssembly.assertInstalled(window)` 与 2 行说明；清单本身（模块顺序 /
  //   window 全局名 / renderer 本地名）在 renderer/assembly-manifest.js，缺模块时启动即报全，
  //   不再让某个 const 静默 undefined。这是审计 M4 要求的「装配清单」，没有往回搬业务代码。
  // 审计残留修复 #40（V403，第二阶段 R7）：6396 → 6401（+5）：document 级「整理快照优先」分支补
  //   焦点守卫（focusEl / inOtherInput 两行代码 + 3 行说明）—— 焦点在查找 / 替换等输入框里时不抢
  //   Ctrl+Z；编辑区自己例外（整理快照撤的就是正文）。判定只读 document.activeElement 与共享的
  //   undo-action.isTypingTarget，没有新增模块依赖。
  // 审计残留修复 #R12（#55/M4，第二阶段）：6401 → 6412（+11）：装配清单自身漏加载时走同一种聚合报错
  //   （8 行守卫：判 assertInstalled 是不是函数、造带 code / missing 的 TypeError 再抛）+ 3 行说明；
  //   清单文件没加载时不再抛「Cannot read properties of undefined」，报错点名的就是缺的那个脚本。
  // WP3（E-N4，审计中 #4）：6412 → 6455（+43，当前 6455 行）：runReplaceOne 的时序接线无法搬走——
  //   ① 模块级 `const replaceOneGuard = window.CWReplaceOneGuard;`（2 行说明 + 1 行声明）；
  //   ② 入口 state.loading 拒绝（4 行）+ await 前 captureTarget（5 行）+ 回执后 checkTarget /
  //      matchInBounds 复核与 STALE_TARGET 返回（10 行）；
  //   ③ 第二个 await 后 locateNext + 按结论选中 / 保留光标（14 行）+ nextHint 三态（4 行）；
  //   ④ 测试钩子活绑定 testFindNext（2 行声明 + 1 行注释）/ 两个 await 改走 (testFindNext || call)（行数不变）/
  //      测试钩子入口 setTestFindNextDelay（2 行注释 + 1 行代码）。
  //   纯判定（身份快照 / 边界 / 定位 / 文案）全在 renderer/replace-one-guard.js，Node 单测 9 条；
  //   留在这里的只是 editorEl / state / call / scrollCaretIntoView 的上下文接线，搬走只会反向注入整条链路。
  // WP6（N2，审计中 #7）：6455 → 6473（+18，当前 6473 行）：换书架根的跨窗口接线无法搬走——
  //   ① 模块顶部 `const configChangeUiModule = window.CWConfigChangeUi;`（2 行说明 + 1 行声明）；
  //   ② bindEvents 里 create 一次（host 用惰性箭头取 backToShelf，避免 4170 的 const 在装配前 TDZ）
  //      与 `api.onConfigChanged` 订阅一次（15 行，含 2 行「一次性去重 / 复用既有入口」说明）。
  //   纯判定（路径包含 / 是否孤岛 / 一次性去重 / 提示文案与按钮）全在 renderer/config-change-ui.js，
  //   Node 单测 9 条；留在这里的只是 state / api / openModal / saveRescueUi / backToShelf 的上下文接线。
  // WP5（N1，审计中 #6）：6473 → 6492（+19，当前 6492 行）：崩溃恢复接线无法搬走——
  //   ① 模块顶部 `const crashRecoveryUiModule = window.CWCrashRecoveryUi;`（2 行说明 + 1 行声明）
  //      与模块级 `let crashRecoveryUi = null;`（1 行说明 + 1 行声明）；
  //   ② bindEvents 里 create 一次（host 的 applyRecoveredText 必须调本文件闭包里的 onEditorInput，
  //      恢复后的 dirty / 状态栏 / 章节条目标记才与作者打字同一口径）+ start() 一行（10 行 + 3 行说明）；
  //   ③ saveCurrent 成功后 noteSaved（2 行，含说明）——保存成功才删这一章的旧草稿；
  //   ④ testHooksScope 里 `crashRecoveryUi,`（1 行说明 + 1 行键）。
  //   周期上报 / 恢复提示 / 失败路径全在 renderer/crash-recovery-ui.js（Node 单测 U1–U7），
  //   这里只留 state / editorEl / openModal / 开书载章入口的上下文接线。
  // WP10（P-N2）：6492 → 6497（+5 行）。保存后全书校验改成 save-logic.js 的纯逻辑单飞工厂，
  // renderer 只留「工厂声明 + 一行 request」的接线；校验文案 / 失败日志 / 不 await 的语义不变。
  // WP14（E-N6）：6497 → 6500（+3 行）。部分成功回执的落盘 mtime 必须写在 saveCurrent 的 catch 里
  // （同一分支、sameChapter 判定之后），搬走会把「编辑器手上这一版」的状态拆到两个模块。
  // WP17 A3（四刀：保存链 → 书架视图 → 章节目录 → 编辑域剩余）：6500 → 4600。
  // 四域函数体全部搬出后 renderer.js = 4441 行（≤ 手册 §6.1-3 的 4,500 判据）；
  // 预算按「实际值 + 少量余量」收紧，防以后再靠新增行回流（新代码请搬进独立模块）。
  // T7（三审·低，2026-11-22）：预算改成「实测行数 + 明确余量」两段式，不再用一个没有出处的整数卡：
  //   · 实测值取第 7 轮收尾（3551625 把一处新逻辑与两处可合并旧注释相抵后回到 4598）；
  //   · 余量只留 2 行，够「只能在编排器里改一行」的接线（state 字段声明 / 装配多一行）；
  //   · 余量本身有上限断言（≤ 5）：要加业务代码请搬进独立模块，调大余量不是解法。
  // M1（第一轮·低，2026-11-22 第 9 轮）：toast() + toastActionable() 一对整段搬进
  //   renderer/toast-ui.js（行为锚点 tests/toast-ui.test.js），编排器只留同名转发 → 4546。
  // M1 第二刀（第 10 轮）：命令面板条目表 + 数据版本缓存（commandItemsForPalette / buildCommandItems /
  //   markCommandsDirty）整段搬进 renderer/command-items-ui.js（行为锚点 tests/command-items-ui.test.js）
  //   → 4473。
  // M1 第三刀（第 11 轮）：「一键整理本书」的整段编排（runFormatBook：预检查 / 长操作锁 / 收尾三路
  //   分流 / 10 秒撤销）搬进 renderer/format-book-ui.js（行为锚点 tests/format-book-ui.test.js）→ 4355。
  // M1 第四刀（第 11 轮）：「替换这一处」的整段入口（runReplaceOne：两次 findNext 回执复核 /
  //   兜底拼接后记一次性快照）搬进 renderer/replace-one-ui.js（行为锚点 tests/replace-one-ui.test.js）→ 4262。
  //   注：这里比的是 rendererSrc.split(/\r?\n/).length（文件末尾换行会多算一个空段），
  //   所以数值比「内容行数」大 1；余量 2 行的语义不变。
  // M1 第五刀（第 12 轮）：「整本替换的备份还原」整段（refreshReplaceBackups + restoreReplaceBackupFlow：
  //   列备份横幅 / 未保存拦截 / 长操作锁 / 还原 IPC / 10 秒撤销登记）搬进 renderer/replace-backup-ui.js
  //   （行为锚点 tests/replace-backup-ui.test.js）→ 4181。上面 1.8.0 WP-02 ②「restoreReplaceBackupFlow 约 30 行
  //   搬不出去」的判断本轮被推翻：它的依赖都能按 host 成员注入（editorEl 压根不需要），搬走后渲染层只剩
  //   一次 create + 两个同名转发。还原 IPC 的 E2E 延迟注入改由 restoreBookOp 活绑定承接（testBookOp 仍在编排器）。
  // M1 第六刀（第 12 轮）：换书入口 + 「提交新书」整段（openBookByPath + commitOpenBook：世代号复核 /
  //   未保存拦截 / 提交前清空遮罩 / 目标章解析）搬进 renderer/open-book-flow-ui.js（行为锚点
  //   tests/open-book-flow-ui.test.js）→ 4061。上面 1.8.0 WP-03 ③④ 的判断同样被推翻：openSeq / openingBook
  //   留在编排器，但按「nextOpenSeq / currentOpenSeq / setOpeningBook」活绑定注入即可，模块不碰 DOM 之外的状态；
  //   开书 IPC 的 E2E 延迟注入由 openBookOp 承接（testOpenBook 仍在编排器）。装配点放在 bindEvents 之前
  //   （host 依赖 renderChapterList / clearFindSession / stopTtsForChapterChange 等装配较晚的 const）。
  // M1 第七刀（第 13 轮）：全局 keydown 分流链（输入法守卫 / Esc 链 / 快捷键一览 / 命令面板 /
  //   F11·F3·F2 / 段落导航 / 复制本章 / Ctrl+A / 切章 / 跳章 / 查找 / 撤销 / Ctrl+S·Ctrl+N，178 行）
  //   整段搬进 renderer/global-keys-ui.js（行为锚点 tests/global-keys-ui.test.js）。注册点仍在
  //   bindEvents 原位（同层监听器顺序不变），编排器只留一次 create + 一行 bind() → 3902。
  // M1 第八刀（第 14 轮）：bindEvents 里最后的 8 条 api.on* 通知订阅（导入进度 / 捕获触发 / 剪贴板变化 /
  //   剪贴板入队 / 关窗 / 强制退出 / 命令面板 / 书架变更，74 行）整段搬进 renderer/notify-events-ui.js
  //   （行为锚点 tests/notify-events-ui.test.js）。注册点仍在 bindEvents 原位（订阅顺序不变），
  //   编排器只留一次 create + 一行 bind() → 3845。
  // M1 第九刀（第 14 轮）：朗读条事件接线（6 个按钮 / 3 个下拉 / voiceschanged，21 行）从 bindEvents
  //   整段搬进 renderer/tts-ui.js 的 bindBarEvents()（行为锚点 tests/tts-ui.test.js 的 M1 第九刀用例）。
  //   注册点仍在原位（同层监听器顺序不变），编排器只留一行 bindBarEvents() → 3827。
  // M1 第十刀（第 15 轮）：导出菜单 7 个分流 + 导出范围对话框 5 个输入 + 取消 / 确认（22 行）从 bindEvents
  //   整段搬进 renderer/export-ui.js 的 bindDialogEvents()（行为锚点 tests/export-ui.test.js 的 M1 第十刀用例）。
  //   注册点仍在原位（同层监听器顺序不变），编排器只留一行 bindDialogEvents()；四个只被模块内部
  //   用到的入口别名同时从编排器删掉（eslint no-unused-vars）→ 3811。
  // M1 第十一刀（第 15 轮）：跳章对话框接线（输入防抖 / Enter（含输入法守卫）/ 取消 / 确认，12 行）从
  //   bindEvents 整段搬进 renderer/jump-ui.js 的 bindDialogEvents()（行为锚点 tests/jump-ui.test.js）；
  //   scheduleJumpMatches 别名随之从编排器删掉 → 3804。
  // M1 第十二刀（第 15 轮）：码字日历 + 状态栏「今日字数」接线（15 行）从 bindEvents 整段搬进
  //   renderer/stats-ui.js 的 setupCalendarUi()（行为锚点 tests/stats-ui.test.js 的 M1 第十二刀用例）→ 3794。
  const RENDERER_LINE_MEASURED = 3794; // 2026-11-22 实测（第 15 轮 M1 第十二刀拆出日历 / 状态栏接线之后；split 口径）
  const RENDERER_LINE_MARGIN = 2;
  const RENDERER_LINE_BUDGET = RENDERER_LINE_MEASURED + RENDERER_LINE_MARGIN;
  assert.ok(
    RENDERER_LINE_MARGIN >= 0 && RENDERER_LINE_MARGIN <= 5,
    '行数余量只留给「必须留在编排器的一行接线」（≤5）；要加代码请搬进独立模块'
  );
  const lines = rendererSrc.split(/\r?\n/).length;
  assert.ok(
    lines <= RENDERER_LINE_BUDGET,
    `renderer.js 行数涨了：${lines} > ${RENDERER_LINE_BUDGET}（实测 ${RENDERER_LINE_MEASURED} + 余量 ${RENDERER_LINE_MARGIN}；新代码请搬进独立模块，别回流 renderer.js）`
  );
});

test('静态闸门：test-hooks.js 只在 ?test=1 时动态加载（index.html 没有静态 script）', () => {
  assert.ok(!/<script[^>]+test-hooks\.js/.test(indexSrc), 'index.html 不许静态加载 test-hooks.js');
  assert.match(rendererCode, /function loadTestHooks\s*\(\)/, 'renderer.js 必须有 loadTestHooks()');
  assert.match(rendererCode, /script\.src = 'test-hooks\.js'/, '动态加载必须指向 test-hooks.js');
  // 加载与装配必须在 init 的 testMode 分支里（M1 之后编排器只剩 init 这一处 state.testMode 判断；
  // toast 的那一处随实现搬进 toast-ui.js，由 tests/toast-ui.test.js 的行为用例覆盖）
  const testModeAt = rendererCode.lastIndexOf('if (state.testMode) {');
  assert.ok(testModeAt > 0, 'init 里的 testMode 分支没了');
  const tail = rendererCode.slice(testModeAt, testModeAt + 800);
  assert.match(tail, /await loadTestHooks\(\)/, '加载钩子必须在 testMode 分支里（正常启动不许加载）');
  assert.match(tail, /window\.CWTestHooks\.create\(testHooksScope\(\)\)/, '装配必须走 CWTestHooks.create(testHooksScope())');
  assert.match(tail, /window\.__cwTest\.ready = true/, 'E2E 靠 ready 标志判断启动完成');
});

test('静态闸门：testMode 只认 ?test=1（E6 / WP-11）', () => {
  // E6（审计 WP-11）：以前用 URLSearchParams.has('test')，?test=0 / ?test=false 也会进测试模式
  // （加载 test-hooks、开 toastLog）。口径是只有 ?test=1 才算测试模式（main.js 也只注入 test=1）。
  assert.match(rendererSrc, /testMode:\s*new URLSearchParams\(location\.search\)\.get\('test'\) === '1'/);
  assert.equal(rendererSrc.includes(".has('test')"), false, "不许再用 has('test')：?test=0/false 会误开测试模式");
});

test('静态闸门：pnpm test 只扫 tests/（产品目录里的 test-*.js 不该被当成测试执行）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  // renderer/test-hooks.js 这个名字正好命中 node 默认的 test-*.js 测试文件模式（`node --test`
  // 会把它当测试文件跑一遍、多报一个空测试），所以 test 脚本要限定在 tests/ 目录。
  assert.match(pkg.scripts.test, /tests\/\*\*/, 'pnpm test 必须限定在 tests/ 目录');
  assert.notStrictEqual(pkg.scripts.test.trim(), 'node --test');
});
