// 全局 Esc 链 + 关窗清理的**有序注册表**（v0.9 B-4 / 外部审计 F6）。
//
// 这一轮把 renderer.js 里 12 段近乎逐字的 Esc 复制块（conflict / bookinfo / history / format / export /
// settings / jump / find / fragment / fragments / proofread / sensitive）收成一张有序表，并让同一张表
// 驱动关窗清理清单。行为必须**逐项一致**，所以测试分三层：
//   1. 顺序：整张表的层 id 按优先级写死（谁先接 Esc 就是这张数组），改顺序会立刻红；
//   2. 命中判定：锁键弹层（吞所有键）vs 只接 Esc 的层、历史预览「先收预览再关面板」、
//      查找高亮「面板关着才清」、朗读 / 阅读 / 专注的相对顺序、兜底层不 preventDefault；
//   3. 关窗清理的**子集语义**：只 6 项（+ 顶栏菜单），书籍信息 / 查找 / 灵感箱 / 插入碎片 / 校对 /
//      敏感词故意不收 —— 这条是改前就有的口径，谁「顺手补全」都会在这里红。
// 另外钉住接线闸门：注册表里出现的每个动作 id 在 renderer.js 都必须有实现（反之亦然）、
// 12 段复制块不许回来、关键探针字段必须真的被渲染层算出来（否则某一层会静默永不触发）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esc = require('../renderer/esc-registry');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const REGISTRY_SOURCE = read('renderer/esc-registry.js');
const RENDERER_SOURCE = read('renderer/renderer.js');
const INDEX_SOURCE = read('renderer/index.html');
// 纯逻辑闸门只看代码：注释里提到 window / document 是在解释边界，不算越界
const REGISTRY_CODE = REGISTRY_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// renderer.js 里 escActions 那张表（动作 id → 关闭函数）的键
function rendererActionKeys() {
  const start = RENDERER_SOURCE.indexOf('const escActions = {');
  assert.ok(start > 0, 'renderer.js 里找不到 escActions 表');
  const end = RENDERER_SOURCE.indexOf('\n  };', start);
  assert.ok(end > start, 'escActions 表没有按预期结束');
  const body = RENDERER_SOURCE.slice(start, end);
  const keys = [];
  for (const hit of body.matchAll(/'([a-z][a-z-]*)':/g)) keys.push(hit[1]);
  return keys;
}

// 注册表里所有会被渲染层执行的动作 id（Esc 链的 action / esc + 关窗清理的 action）
function registryActionIds() {
  const ids = new Set();
  for (const hit of REGISTRY_SOURCE.matchAll(/\b(?:action|esc):\s*'([a-z][a-z-]*)'/g)) ids.add(hit[1]);
  return Array.from(ids);
}

// 「现在谁开着」的探针：默认全关，再按需打开几层
function probeOpen(...names) {
  const probe = {};
  for (const name of names) probe[name] = true;
  return probe;
}

test('顺序闸门：Esc 链的层顺序 = 优先级（通用询问框 → 弹层 → 菜单 → 朗读 → 阅读 → 专注 → 兜底）', () => {
  assert.deepEqual(
    esc.LAYERS.map((layer) => layer.id),
    [
      'modal',
      'conflict',
      'bookinfo',
      'group-manage',
      'history-preview',
      'history',
      'format',
      'export',
      'settings',
      'jump',
      'command',
      'shortcuts',
      'find',
      'menus',
      'find-highlight',
      'fragment',
      'fragments',
      'capture',
      'proofread',
      'sensitive',
      'tts',
      'reading',
      'focus',
      'undo-bar',
      'chapter-selection',
      'fallback'
    ],
    '层顺序就是优先级：改顺序等于改行为，必须在这里显式看到'
  );
  // 层 id / 动作 id 都不许重名（重名会让「谁接的 Esc」看不出来）
  assert.equal(new Set(esc.LAYERS.map((l) => l.id)).size, esc.LAYERS.length, '层 id 不许重复');
  const actions = registryActionIds();
  assert.equal(new Set(actions).size, actions.length, '动作 id 不许重复');
});

test('锁键弹层：通用询问框 / 9 个弹层吞掉所有按键，Esc 才做动作', () => {
  const cases = [
    ['modal', 'modal-cancel'],
    ['conflict', 'close-conflict'],
    ['bookinfo', 'close-bookinfo'],
    // 1.6.0 F5：书架「分组管理」也是锁键弹层
    ['group-manage', 'close-group-manage'],
    ['history', 'close-history'],
    ['format', 'close-format'],
    ['export', 'close-export'],
    ['settings', 'close-settings'],
    ['jump', 'close-jump'],
    // 1.5.0 功能-4：`?` 快捷键一览页也是锁键层（面板开着时 Ctrl+S 等快捷键不响）
    ['shortcuts', 'close-shortcuts']
  ];
  for (const [name, action] of cases) {
    const hit = esc.resolve(probeOpen(name), 'Escape');
    assert.deepEqual(hit, { layer: name, key: 'Escape', action, preventDefault: true, swallow: true }, `${name} 的 Esc 必须给 ${action}`);
    // 别的键：不动作，但也不许往下传（改前每段末尾那个裸 return）
    for (const key of ['a', 'Enter', 'F11', 'Tab', 's']) {
      assert.deepEqual(
        esc.resolve(probeOpen(name), key),
        { layer: name, key, action: null, preventDefault: false, swallow: true },
        `${name} 开着时 ${key} 不许漏到下面的快捷键`
      );
    }
  }
  // 通用询问框最优先：它跟别的弹层叠在一起时先关它
  assert.equal(esc.resolve(probeOpen('modal', 'conflict', 'settings'), 'Escape').layer, 'modal');
  assert.equal(esc.resolve(probeOpen('conflict', 'settings', 'find'), 'Escape').layer, 'conflict');
  // 弹层锁优先于菜单：顶栏卡与弹层同时开着时先关弹层（改前就是弹层写在前）
  assert.equal(esc.resolve(probeOpen('settings', 'formatCard', 'displayMenu'), 'Escape').action, 'close-settings');
  assert.equal(esc.resolve(probeOpen('find', 'formatCard'), 'Escape').action, 'close-find');
});

test('快捷键一览层（1.5.0 功能-4）：锁键层，Esc 收起；排在命令面板之后', () => {
  assert.deepEqual(esc.resolve({ shortcuts: true }, 'Escape'), {
    layer: 'shortcuts',
    key: 'Escape',
    action: 'close-shortcuts',
    preventDefault: true,
    swallow: true
  });
  // 锁键：开着时别的快捷键一律被吞（Ctrl+S 不保存、F11 不进专注、Ctrl+K 不开命令面板）
  for (const key of ['s', 'k', 'F11', 'Enter', 'Tab', '?']) {
    assert.deepEqual(
      esc.resolve({ shortcuts: true }, key),
      { layer: 'shortcuts', key, action: null, preventDefault: false, swallow: true },
      `快捷键一览开着时 ${key} 不许漏到下面的快捷键`
    );
  }
  // 它只会在没有别的弹层时打开；万一叠上了，Esc 仍先关更「在上面」的那层
  assert.equal(esc.resolve({ shortcuts: true, settings: true }, 'Escape').layer, 'settings');
  assert.equal(esc.resolve({ shortcuts: true, command: true }, 'Escape').layer, 'command');
  // index.html 的弹层结构：backdrop + role=dialog + 标题 + 两个关闭出口
  assert.match(INDEX_SOURCE, /<div id="shortcuts-backdrop" class="backdrop hidden">/, '快捷键一览要有自己的 backdrop');
  const panel = INDEX_SOURCE.slice(
    INDEX_SOURCE.indexOf('id="shortcuts-backdrop"'),
    INDEX_SOURCE.indexOf('id="settings-backdrop"')
  );
  assert.ok(panel.includes('role="dialog"') && panel.includes('aria-modal="true"'), '快捷键一览要是真正的模态');
  assert.ok(panel.includes('aria-labelledby="shortcuts-title"') && panel.includes('id="shortcuts-title"'), '弹层要有可读标题');
  assert.ok(panel.includes('id="btn-shortcuts-close"') && panel.includes('id="btn-shortcuts-ok"'), '要有 × 与「关闭」两个出口');
  assert.ok(panel.includes('id="shortcuts-list"'), '列表容器要在 HTML 里（内容由渲染层生成）');
});

test('历史面板：有预览先收预览，再按一次才关面板', () => {
  assert.deepEqual(
    esc.resolve(probeOpen('history', 'historyPreview'), 'Escape'),
    { layer: 'history-preview', key: 'Escape', action: 'close-history-preview', preventDefault: true, swallow: true }
  );
  assert.equal(esc.resolve(probeOpen('history'), 'Escape').action, 'close-history');
  // 历史面板锁键，非 Esc 一样不往下传
  assert.equal(esc.resolve(probeOpen('history'), 'Tab').swallow, true);
});

test('只接 Esc 的层：Esc 命中，别的键一律放行（Ctrl+S 仍可保存）', () => {
  const cases = [
    ['fragment', 'close-fragment'],
    ['fragments', 'close-insert-fragment'],
    ['capture', 'close-capture'],
    ['proofread', 'close-proofread'],
    ['sensitive', 'close-sensitive'],
    ['tts', 'close-tts'],
    ['reading', 'exit-reading'],
    ['focus', 'exit-focus']
  ];
  for (const [name, action] of cases) {
    assert.deepEqual(
      esc.resolve(probeOpen(name), 'Escape'),
      { layer: name, key: 'Escape', action, preventDefault: true, swallow: false },
      `${name} 的 Esc 必须给 ${action}`
    );
    for (const key of ['s', 'a', 'F11', 'Enter', 'Tab']) {
      assert.equal(esc.resolve(probeOpen(name), key), null, `${name} 开着时 ${key} 必须继续往下走`);
    }
  }
  // 具体到「面板开着按 Ctrl+S 仍保存」：s 键不被吞
  assert.equal(esc.resolve(probeOpen('proofread'), 's'), null);
  // 反过来：锁键弹层开着时同样的 s 键被吞
  assert.equal(esc.resolve(probeOpen('settings'), 's').action, null);
  assert.equal(esc.resolve(probeOpen('settings'), 's').swallow, true);
});

test('查找面板：Esc 关面板；面板关着时 Esc 先清高亮，再按才轮到朗读 / 阅读 / 专注', () => {
  assert.deepEqual(
    esc.resolve(probeOpen('find'), 'Escape'),
    { layer: 'find', key: 'Escape', action: 'close-find', preventDefault: true, swallow: false }
  );
  // 面板关着 + 有高亮 → 先清高亮
  assert.deepEqual(esc.resolve({ findTotal: 3 }, 'Escape'), {
    layer: 'find-highlight',
    key: 'Escape',
    action: 'clear-find-session',
    preventDefault: true,
    swallow: false
  });
  // 面板开着时 find 层先命中，高亮层不再重复
  assert.equal(esc.resolve({ find: true, findTotal: 3 }, 'Escape').action, 'close-find');
  // 有高亮 + 朗读 + 阅读同时开着：高亮先（层序），其次是朗读
  assert.equal(esc.resolve({ findTotal: 1, tts: true, reading: true }, 'Escape').action, 'clear-find-session');
  assert.equal(esc.resolve({ tts: true, reading: true }, 'Escape').action, 'close-tts');
  assert.equal(esc.resolve({ reading: true, focus: true }, 'Escape').action, 'exit-reading');
  // 查找面板不锁键：回车是面板自己的事，不许被 Esc 链拦
  assert.equal(esc.resolve(probeOpen('find'), 'Enter'), null);
});

test('菜单层：整理卡 / 显示菜单收起并归还焦点；菜单层在「后来的弹层」之前', () => {
  assert.equal(esc.resolve(probeOpen('formatCard'), 'Escape').action, 'close-header-menus');
  assert.equal(esc.resolve(probeOpen('displayMenu'), 'Escape').action, 'close-header-menus');
  assert.equal(esc.resolve(probeOpen('formatCard', 'displayMenu'), 'Escape').layer, 'menus');
  assert.equal(esc.resolve(probeOpen('formatCard'), 'a'), null, '菜单层只接 Esc');
  // 记录在案的顺序事实（不是笔误）：菜单层排在 find 之后、灵感箱 / 校对 / 敏感词之前
  assert.equal(esc.resolve(probeOpen('formatCard', 'proofread'), 'Escape').action, 'close-header-menus');
  assert.equal(esc.resolve(probeOpen('formatCard', 'sensitive'), 'Escape').action, 'close-header-menus');
  assert.equal(esc.resolve(probeOpen('formatCard', 'fragment'), 'Escape').action, 'close-header-menus');
});

test('章节多选层（1.5.0 功能-1）：Esc 清空多选；排在撤销条之后、兜底之前，不锁键', () => {
  assert.deepEqual(esc.resolve({ chapterSelection: true }, 'Escape'), {
    layer: 'chapter-selection',
    key: 'Escape',
    action: 'clear-chapter-selection',
    preventDefault: true,
    swallow: false
  });
  // 不锁键：其它键继续往下走（Ctrl+S 保存、Ctrl+K 命令面板、F11 专注都不受影响）
  for (const key of ['s', 'k', 'F11', 'Enter', 'Tab']) {
    assert.equal(esc.resolve({ chapterSelection: true }, key), null, `多选时 ${key} 必须继续往下走`);
  }
  // 弹层 / 面板 / 菜单都比多选更「在上面」：Esc 先关它们，多选留着
  assert.equal(esc.resolve({ chapterSelection: true, settings: true }, 'Escape').layer, 'settings');
  assert.equal(esc.resolve({ chapterSelection: true, find: true }, 'Escape').layer, 'find');
  assert.equal(esc.resolve({ chapterSelection: true, formatCard: true }, 'Escape').layer, 'menus');
  assert.equal(esc.resolve({ chapterSelection: true, reading: true }, 'Escape').layer, 'reading');
  // 撤销条在多选之前：一按 Esc 先收撤销条，下一按才清多选
  assert.equal(esc.resolve({ chapterSelection: true, undoBar: true }, 'Escape').layer, 'undo-bar');
  // 右键菜单比多选更「在上面」：先收菜单（兜底层），第二按才清多选
  assert.deepEqual(esc.resolve({ chapterSelection: true, contextMenu: true }, 'Escape'), {
    layer: 'fallback',
    key: 'Escape',
    action: 'hide-menus',
    preventDefault: false,
    swallow: false
  });
});

test('撤销条层（1.5.0 P0-4 / H-5）：最低优先级、只接 Esc、不锁键；弹层开着时先关弹层', () => {
  assert.deepEqual(esc.resolve({ undoBar: true }, 'Escape'), {
    layer: 'undo-bar',
    key: 'Escape',
    action: 'close-undo-bar',
    preventDefault: true,
    swallow: false
  });
  // 不锁键：别的键照常往下走（Ctrl+S / Ctrl+K / F11 不受影响）
  for (const key of ['s', 'k', 'F11', 'Enter', 'Tab']) {
    assert.equal(esc.resolve({ undoBar: true }, key), null, `撤销条开着时 ${key} 必须继续往下走`);
  }
  // 最低优先级：任何弹层 / 面板 / 模式 / 高亮都排在它前面
  assert.equal(esc.resolve({ undoBar: true, settings: true }, 'Escape').layer, 'settings');
  assert.equal(esc.resolve({ undoBar: true, find: true }, 'Escape').layer, 'find');
  assert.equal(esc.resolve({ undoBar: true, findTotal: 2 }, 'Escape').layer, 'find-highlight');
  assert.equal(esc.resolve({ undoBar: true, formatCard: true }, 'Escape').layer, 'menus');
  assert.equal(esc.resolve({ undoBar: true, proofread: true }, 'Escape').layer, 'proofread');
  assert.equal(esc.resolve({ undoBar: true, tts: true }, 'Escape').layer, 'tts');
  assert.equal(esc.resolve({ undoBar: true, reading: true }, 'Escape').layer, 'reading');
  assert.equal(esc.resolve({ undoBar: true, focus: true }, 'Escape').layer, 'focus');
  // 右键菜单比撤销条更「在上面」：Esc 先收菜单（兜底层），条子留着；下一按才收条子
  assert.deepEqual(esc.resolve({ undoBar: true, contextMenu: true }, 'Escape'), {
    layer: 'fallback',
    key: 'Escape',
    action: 'hide-menus',
    preventDefault: false,
    swallow: false
  });
  // 什么都没开：仍然走兜底（撤销条没显示时不受影响）
  assert.equal(esc.resolve({}, 'Escape').layer, 'fallback');
});

test('兜底层：什么都没开时 Esc 只收起菜单，且**不** preventDefault', () => {
  assert.deepEqual(esc.resolve({}, 'Escape'), {
    layer: 'fallback',
    key: 'Escape',
    action: 'hide-menus',
    preventDefault: false,
    swallow: false
  });
  assert.equal(esc.resolve({}, 'a'), null);
  // 只有兜底层是 preventDefault:false，其余层都要拦掉（否则浏览器的默认行为会跟着跑）
  const noPrevent = esc.LAYERS.filter((layer) => layer.preventDefault === false).map((layer) => layer.id);
  assert.deepEqual(noPrevent, ['fallback']);
});

test('通用询问框：带输入框时 Enter = 确定，不带输入框时 Enter 什么都不做（但也不往下传）', () => {
  assert.deepEqual(
    esc.resolve({ modal: true, modalInput: true }, 'Enter'),
    { layer: 'modal', key: 'Enter', action: 'modal-confirm', preventDefault: true, swallow: true }
  );
  assert.deepEqual(
    esc.resolve({ modal: true }, 'Enter'),
    { layer: 'modal', key: 'Enter', action: null, preventDefault: false, swallow: true }
  );
  // 输入框里按 a 之类照常打字（不 preventDefault），但也不许漏到快捷键
  assert.deepEqual(
    esc.resolve({ modal: true, modalInput: true }, 'a'),
    { layer: 'modal', key: 'a', action: null, preventDefault: false, swallow: true }
  );
  assert.equal(esc.resolve({ modal: true }, 'Escape').action, 'modal-cancel');
});

test('关窗清理：有序 6 项（+ 顶栏菜单），只收挡着关窗询问的那几层', () => {
  assert.deepEqual(
    esc.CLEANUP.map((entry) => entry.id),
    ['menus', 'format', 'export', 'jump', 'conflict', 'history', 'settings'],
    '关窗清理的顺序 = 改前手写清单的顺序'
  );
  // 什么都没开：无条件的两项也照跑（改前 hideHeaderMenus / closeFormatDialog 就是无条件调用）
  assert.deepEqual(esc.cleanupActions({}), ['hide-header-menus', 'close-format']);
  // 全开：7 个动作按表顺序，一个不多一个不少
  assert.deepEqual(esc.cleanupActions(probeOpen('export', 'jump', 'conflict', 'history', 'settings')), [
    'hide-header-menus',
    'close-format',
    'close-export',
    'close-jump',
    'close-conflict',
    'close-history',
    'close-settings'
  ]);
  // **子集语义**：这些弹层开着也不收（改前就不收，谁「顺手补全」这里就红）
  const notCleaned = probeOpen('bookinfo', 'find', 'fragment', 'fragments', 'proofread', 'sensitive', 'historyPreview');
  assert.deepEqual(esc.cleanupActions(notCleaned), ['hide-header-menus', 'close-format']);
  assert.deepEqual(
    esc.CLEANUP.filter((entry) => entry.probe).map((entry) => entry.probe).sort(),
    ['conflict', 'export', 'history', 'jump', 'settings'],
    '参与清理的弹层恰好 5 个 + 2 项无条件 = 6 项语义'
  );
  // 清理表只看探针，不看 Esc 链：两边的顺序本来就不一样（导出 / 跳章在前，冲突 / 历史 / 设置在后）
  assert.notDeepEqual(
    esc.CLEANUP.map((entry) => entry.id),
    ['menus', 'conflict', 'history', 'format', 'export', 'settings', 'jump']
  );
});

test('接线闸门：注册表的每个动作 id 在 renderer.js 都有实现，反之亦然', () => {
  const keys = rendererActionKeys();
  assert.equal(new Set(keys).size, keys.length, 'renderer.js 的 escActions 不许出现重复键');
  const ids = registryActionIds();
  const missing = ids.filter((id) => !keys.includes(id));
  const extra = keys.filter((id) => !ids.includes(id));
  assert.deepEqual(missing, [], '注册表里有、渲染层没实现的动作（Esc 按下去会静默没反应）');
  assert.deepEqual(extra, [], '渲染层有、注册表里没人用的动作（死入口）');
  assert.ok(keys.length >= 20, `动作表看起来太小（${keys.length} 项），是不是被截断了`);
});

test('接线闸门：12 段复制块已收掉，keydown 里不再手写弹层判断', () => {
  const backdrops = [
    'conflict', 'bookinfo', 'history', 'format', 'export', 'settings',
    'jump', 'find', 'fragment', 'fragments', 'proofread', 'sensitive'
  ];
  // 改前的形状：if (!$('xxx-backdrop').classList.contains('hidden')) { if (Esc) … } return;
  // （不带大括号的 `if (!$('xxx-backdrop')…) closeYyy();` 是「打开另一个面板前先收起自己」，
  //   与 Esc 无关，允许保留）
  for (const name of backdrops) {
    const blockShape = new RegExp(
      `if \\(!\\$\\('${name}-backdrop'\\)\\.classList\\.contains\\('hidden'\\)\\) \\{`
    );
    assert.equal(
      blockShape.test(RENDERER_SOURCE),
      false,
      `${name} 的 Esc 复制块回到了 renderer.js：Esc 判断只许留在 esc-registry.js`
    );
  }
  // keydown 里只该剩「输入框自己清空」这一类 Escape 判断：书架搜索框 + 卷章目录筛选框
  // （2026-11-10 目录重设计新增）。弹层判断一个都不许回到 renderer.js。
  const escapes = (RENDERER_SOURCE.match(/event\.key === 'Escape'/g) || []).length;
  assert.equal(escapes, 2, `renderer.js 里只该剩两个输入框自己的 Esc 判断（现在 ${escapes} 处）`);
  assert.ok(
    RENDERER_SOURCE.includes("$('shelf-search').addEventListener('keydown', (event) => {"),
    '书架搜索框的 Esc 判断要留着'
  );
  assert.ok(
    RENDERER_SOURCE.includes('function setupChapterDirectory()') &&
      RENDERER_SOURCE.includes("input.addEventListener('keydown', (event) => {"),
    '卷章目录筛选框的 Esc 判断要在 setupChapterDirectory 里（只清筛选词，不接弹层）'
  );
  // Esc 链与关窗清理都必须走注册表，且只调一次
  assert.equal((RENDERER_SOURCE.match(/escLib\.resolve\(/g) || []).length, 1, 'Esc 链必须只有一处调用注册表');
  assert.equal((RENDERER_SOURCE.match(/escLib\.cleanupActions\(/g) || []).length, 1, '关窗清理必须只有一处调用注册表');
  assert.match(RENDERER_SOURCE, /const escLib = window\.CWEscRegistry;/, 'renderer.js 要引用 window.CWEscRegistry');
});

test('接线闸门：注册表读到的每个探针字段，渲染层的 escProbe 都真的算出来了', () => {
  const start = RENDERER_SOURCE.indexOf('function escProbe()');
  assert.ok(start > 0, 'renderer.js 里找不到 escProbe()');
  const end = RENDERER_SOURCE.indexOf('\n  }', start);
  const body = RENDERER_SOURCE.slice(start, end);
  // 动态补齐的那批 backdrop：ESC_BACKDROPS 列表 + `${name}-backdrop` 拼法
  const listStart = RENDERER_SOURCE.indexOf('const ESC_BACKDROPS = [');
  const listEnd = RENDERER_SOURCE.indexOf('];', listStart);
  const dynamic = new Set(
    RENDERER_SOURCE.slice(listStart, listEnd).match(/'([a-z-]+)'/g).map((hit) => hit.slice(1, -1))
  );
  assert.ok(dynamic.size >= 12, 'ESC_BACKDROPS 至少覆盖那 12 个弹层');
  assert.match(body, /`\$\{name\}-backdrop`/, 'escProbe 要用 ESC_BACKDROPS 拼 backdrop id');
  const fields = new Set(Array.from(REGISTRY_SOURCE.matchAll(/\bp\.([A-Za-z][A-Za-z0-9]*)/g)).map((hit) => hit[1]));
  assert.ok(fields.size >= 10, `从注册表里只抽到 ${fields.size} 个探针字段，解析是不是失效了`);
  const unwired = Array.from(fields).filter((name) => !dynamic.has(name) && !new RegExp(`\\b${name}\\s*:`).test(body));
  assert.deepEqual(unwired, [], '注册表读到、但 escProbe 没算的字段（那一层会静默永不触发）');
});

test('index.html：esc-registry.js 只加载一次，且排在 renderer.js 之前', () => {
  const at = INDEX_SOURCE.indexOf('src="esc-registry.js"');
  assert.ok(at > 0, 'index.html 必须加载 renderer/esc-registry.js');
  assert.equal(INDEX_SOURCE.split('src="esc-registry.js"').length - 1, 1, 'esc-registry.js 只该加载一次');
  const rendererAt = INDEX_SOURCE.indexOf('src="renderer.js"');
  assert.ok(rendererAt > at, 'esc-registry.js 必须排在 renderer.js 之前（否则 window.CWEscRegistry 是 undefined）');
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWEscRegistry，结果与 Node 侧一致', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(REGISTRY_SOURCE, context, { filename: 'renderer/esc-registry.js' });
  assert.equal(typeof win.CWEscRegistry, 'object');
  assert.deepEqual(Object.keys(win.CWEscRegistry).sort(), ['CLEANUP', 'LAYERS', 'cleanupActions', 'resolve']);
  assert.equal(win.CWEscRegistry.LAYERS.length, esc.LAYERS.length);
  assert.deepEqual(
    JSON.parse(JSON.stringify(win.CWEscRegistry.resolve({ settings: true }, 'Escape'))),
    esc.resolve({ settings: true }, 'Escape'),
    '浏览器分支与 Node 分支必须同一份实现'
  );
  assert.equal(win.CWParagraphs, undefined, '单独加载 esc-registry 不该顺手造出别的全局');
});

test('renderer/esc-registry.js 是纯逻辑：不 require 任何模块，也不碰 DOM / process / electron', () => {
  assert.equal(/require\s*\(/.test(REGISTRY_CODE), false, '不许 require（fs / path / electron / 别的渲染层模块都不行）');
  assert.equal(/\bprocess\s*\./.test(REGISTRY_CODE), false, '不许碰 process');
  assert.equal(/\bwindow\s*\./.test(REGISTRY_CODE), false, '不许碰 window');
  assert.equal(/\bdocument\s*\./.test(REGISTRY_CODE), false, '不许碰 document');
  assert.equal(/electron/.test(REGISTRY_CODE), false, '不许出现 electron');
  assert.equal(/fs\s*\./.test(REGISTRY_CODE), false, '不读盘 / 不写盘');
  // 表本身不许是空转：层与清理项都真的在
  assert.match(REGISTRY_SOURCE, /const LAYERS = \[/, '注册表必须定义 LAYERS');
  assert.match(REGISTRY_SOURCE, /const CLEANUP = \[/, '注册表必须定义 CLEANUP');
});
