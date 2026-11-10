/* 1.4.0 P0-3：命令面板的检索 / 排序纯逻辑（renderer/command-registry.js）。
 *
 * 钉住的口径（验收清单 V46 与 README「命令面板」都按这份写）：
 *   · 空查询 = 最近用过的在前 + 其余按「组权重 → 标题」；
 *   · 命中分三档：前缀 100 / 子串 70 / 子序列 40，同档按组权重 → 标题；
 *   · 归一：大小写、全角字母数字、全角空格都不影响；
 *   · 最近使用只在内存里（不写配置），recordUse 去重并保持新→旧，最多 8 条。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const registryModule = require('../renderer/command-registry');

const items = [
  { id: 'cmd:save', title: '保存本章', group: 'command', kbd: 'Ctrl+S', keywords: ['save'] },
  { id: 'cmd:find', title: '查找替换', group: 'command', kbd: 'Ctrl+F', keywords: ['find', 'search'] },
  { id: 'cmd:history', title: '本书历史', group: 'command', keywords: ['history'] },
  { id: 'chapter:ch1', title: '第1章：起风', group: 'chapter', keywords: ['起风'] },
  { id: 'chapter:ch2', title: '第2章：灯塔', group: 'chapter', keywords: ['灯塔'] },
  { id: 'book:/x/星海旅人', title: '打开《星海旅人》', group: 'book', keywords: ['星海旅人'] }
];

test('归一：大小写 / 全角字母数字 / 全角空格都不影响匹配', () => {
  const registry = registryModule.createRegistry({});
  assert.equal(registryModule.normalize('  Ctrl+S  '), 'ctrl+s');
  assert.equal(registryModule.normalize('ＳＡＶＥ'), 'save', '全角字母按半角处理');
  assert.equal(registryModule.normalize('保　存'), '保 存', '全角空格按半角空格处理');
  // 中文查询：全角与半角混着输入也能命中同一条
  const hit = registry.search(items, '保存');
  assert.deepEqual(hit.map((item) => item.id), ['cmd:save']);
});

test('空查询：最近用过的排最前，其余按「命令 → 章节 → 书」再按标题', () => {
  const registry = registryModule.createRegistry({});
  const first = registry.search(items, '');
  // 标题之间的先后交给 zh 排序（不同 ICU 版本的汉字序可能不同），这里钉「分组顺序」：
  // 命令 → 章节 → 书；组内条目一个不少。
  assert.deepEqual(
    first.map((item) => item.group),
    ['command', 'command', 'command', 'chapter', 'chapter', 'book'],
    '空查询按组权重排：命令 → 章节 → 书'
  );
  assert.deepEqual(
    first.map((item) => item.id).sort(),
    items.map((item) => item.id).sort(),
    '空查询不许漏条目'
  );
  registry.recordUse('cmd:history');
  registry.recordUse('chapter:ch2');
  assert.deepEqual(
    registry.search(items, '').slice(0, 2).map((item) => item.id),
    ['chapter:ch2', 'cmd:history'],
    '最近的按使用顺序（新→旧）排最前，剩下的照旧按组 / 标题'
  );
});

test('命中分档：前缀 > 子串 > 子序列；同档按组权重与标题', () => {
  const registry = registryModule.createRegistry({});
  const custom = [
    { id: 'a', title: '设置', group: 'command' },
    { id: 'b', title: '打开设置', group: 'command' },
    { id: 'c', title: '正文显示设置', group: 'command' }
  ];
  assert.deepEqual(
    registry.search(custom, '设置').map((item) => item.id),
    ['a', 'b', 'c'],
    '前缀命中（设置）排在子串命中（打开设置 / 正文显示设置）前面'
  );
  // 英文子序列：bkm 能命中 bookmark 类命令
  const en = [
    { id: 'x', title: 'Bookmark 书签', group: 'command' },
    { id: 'y', title: '保存', group: 'command' }
  ];
  assert.deepEqual(registry.search(en, 'bkm').map((item) => item.id), ['x']);
  assert.deepEqual(registry.search(en, 'bkmark').map((item) => item.id), ['x']);
  assert.deepEqual(registry.search(en, 'zzz').map((item) => item.id), []);
});

test('组权重：同分时命令 > 章节 > 书（面板主要用途是执行动作）', () => {
  const registry = registryModule.createRegistry({});
  const same = [
    { id: 'book:1', title: '第1章：起风', group: 'book' },
    { id: 'chapter:1', title: '第1章：起风', group: 'chapter' },
    { id: 'cmd:1', title: '第1章：起风', group: 'command' }
  ];
  assert.deepEqual(
    registry.search(same, '第1章').map((item) => item.id),
    ['cmd:1', 'chapter:1', 'book:1']
  );
});

test('最近使用：去重、新→旧、最多 8 条，只活在内存里', () => {
  const registry = registryModule.createRegistry({});
  for (let i = 1; i <= 10; i += 1) registry.recordUse(`cmd:${i}`);
  assert.deepEqual(registry.recentIds(), [
    'cmd:10', 'cmd:9', 'cmd:8', 'cmd:7', 'cmd:6', 'cmd:5', 'cmd:4', 'cmd:3'
  ]);
  registry.recordUse('cmd:5');
  assert.deepEqual(registry.recentIds()[0], 'cmd:5', '再用一次就提到最前');
  assert.equal(registry.recentIds().filter((id) => id === 'cmd:5').length, 1, '不重复');
  registry.reset();
  assert.deepEqual(registry.recentIds(), []);
  // 自定义上限
  const small = registryModule.createRegistry({ recentLimit: 2 });
  small.recordUse('a');
  small.recordUse('b');
  small.recordUse('c');
  assert.deepEqual(small.recentIds(), ['c', 'b']);
});

test('脏输入不炸：缺字段 / 非数组 / 空查询 / 空白标题都安全返回', () => {
  const registry = registryModule.createRegistry({});
  assert.deepEqual(registry.search(null, 'x'), []);
  assert.deepEqual(registry.search([null, undefined, { id: '' }, { title: '没有 id' }], 'x'), []);
  assert.deepEqual(registry.search([], ''), []);
  assert.equal(registryModule.scoreItem({ title: '' }, 'x'), 0);
  assert.equal(registryModule.scoreItem({ title: '设置' }, ''), 1, '空查询对任何条目都算命中（排序交给外面）');
  assert.equal(registry.recordUse(''), false, '空 id 不记');
});
// ---------- 1.5.0 P0-6 / 审计 O-1：构建时预处理 + 粗筛 ----------
// 面板的条目上千条时，每次输入不该再全量打分；prepare() 把归一文本缓存好，
// search() 先用 includes / 子序列粗筛。这里钉住「粗筛是打分的超集」：
// 结果集与逐条打分完全一致（包括 bkm → Bookmark 这种子序列命中）。

test('prepare：缓存归一文本、返回新数组、不改入参；粗筛结果与逐条打分一致', () => {
  const registry = registryModule.createRegistry({});
  const source = [
    { id: 'cmd:save', title: '保存本章', group: 'command', kbd: 'Ctrl+S', keywords: ['save'] },
    { id: 'cmd:bookmark', title: 'Bookmark 书签', group: 'command', keywords: ['bookmark', '书签'] },
    { id: 'chapter:c1', title: '第1章：起风', group: 'chapter', keywords: ['起风', 'ch1'] },
    { id: 'book:/x/星海旅人', title: '打开《星海旅人》', group: 'book', keywords: ['星海旅人'] }
  ];
  const prepared = registryModule.prepare(source);
  assert.notEqual(prepared, source, '返回新数组');
  assert.equal(prepared.length, source.length);
  assert.equal(source[0].searchText, undefined, '不改入参对象');
  assert.equal(prepared[0].searchText, '保存本章\nsave\ncmd:save', '标题 / 关键词 / id 归一后拼起来');
  assert.match(prepared[2].searchText, /ch1/, '关键词里的小写缩写也在');
  assert.deepEqual(registryModule.prepare(null), [], '非数组安全');
  assert.deepEqual(registryModule.prepare([null, { id: '', title: '' }]).length, 1, '非对象条目跳过；空标题照留，交给 search 过滤');

  for (const query of ['', '保存', 'bkm', 'bkmark', '第1章', '星海', 'ＳＡＶＥ', 'ctrl+s', 'zzz', '书']) {
    assert.deepEqual(
      registry.search(prepared, query).map((item) => item.id),
      registry.search(source, query).map((item) => item.id),
      `粗筛不许改变结果：${JSON.stringify(query)}`
    );
  }
});

test('粗筛是打分的超集：scoreItem 命中的条目 coarseMatch 一定放行（含子序列 / 跨字段）', () => {
  const source = [
    { id: 'cmd:bookmark', title: 'Bookmark 书签', group: 'command', keywords: ['书签'] },
    { id: 'cmd:save', title: '保存本章', group: 'command', keywords: ['save'] },
    { id: 'chapter:ch2', title: '第2章：灯塔', group: 'chapter', keywords: ['灯塔', 'ch2'] }
  ];
  const prepared = registryModule.prepare(source);
  const queries = ['bkm', 'bkmk', 'bm', '保存', 'ch2', '灯塔', '第2', 'save', 'sv'];
  for (const query of queries) {
    const normalized = registryModule.normalize(query);
    for (const item of prepared) {
      if (registryModule.scoreItem(item, normalized) > 0) {
        assert.equal(registryModule.coarseMatch(item, normalized), true, `${query} 丢了 ${item.id}`);
      }
    }
  }
  // bkm 是子序列命中，不是子串命中：粗筛必须认它，否则「bkm → Bookmark」会消失。
  const bkm = registryModule.createRegistry({}).search(prepared, 'bkm');
  assert.deepEqual(bkm.map((item) => item.id), ['cmd:bookmark']);
  // 没 prepare 的旧调用方仍可用（粗筛现算归一文本）。
  assert.deepEqual(registryModule.createRegistry({}).search(source, 'bkm').map((item) => item.id), ['cmd:bookmark']);
});

test('空查询顺序不变：prepare 前后一致，最近的仍排最前', () => {
  const registry = registryModule.createRegistry({});
  const source = [
    { id: 'cmd:save', title: '保存本章', group: 'command' },
    { id: 'chapter:1', title: '第1章：起风', group: 'chapter' },
    { id: 'book:1', title: '打开《星海旅人》', group: 'book' }
  ];
  const prepared = registryModule.prepare(source);
  registry.recordUse('chapter:1');
  assert.deepEqual(
    registry.search(prepared, '').map((item) => item.id),
    registry.search(source, '').map((item) => item.id),
    '空查询不看 searchText：最近 + 组顺序不变'
  );
  assert.equal(registry.search(prepared, '')[0].id, 'chapter:1', '最近的仍排最前');
});
