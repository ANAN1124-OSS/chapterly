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