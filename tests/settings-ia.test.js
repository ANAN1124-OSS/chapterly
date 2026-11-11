// 1.4.0 P0-1：设置面板信息架构（5 个分区 / 顶部搜索 / 深链）的纯逻辑闸门。
//
// 为什么要单测：这些映射一旦错位，界面不会崩，只会「某个设置项在哪个分区都找不到」——
// 属于最容易被眼睛漏掉的一类回归。这里直接拿 index.html 当事实源核对映射完整性，
// 再钉住搜索归一 / 可见性计划 / 作用域 / 深链。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ia = require('../renderer/settings-ia');

const ROOT = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');

// 取设置弹层那一段（到章节右键菜单为止），里面所有 `id="settings-…"` 都是弹层自己的 id
function settingsModalHtml() {
  const start = indexHtml.indexOf('<div id="settings-backdrop"');
  assert.ok(start > 0, 'index.html 里应该有设置弹层');
  const end = indexHtml.indexOf('<!-- ============ 章节右键菜单', start);
  assert.ok(end > start, '设置弹层后面应该是章节右键菜单');
  return indexHtml.slice(start, end);
}

function settingsIdsInHtml() {
  const block = settingsModalHtml();
  const ids = new Set();
  for (const match of block.matchAll(/id="(settings-[a-z0-9-]+)"/g)) ids.add(match[1]);
  return [...ids];
}

// 设置项 = 弹层里除「骨架 / 导航 / 搜索 / 空结果」与 tab / section 之外的 settings-* id
function isFieldId(id) {
  if (ia.CHROME_IDS.indexOf(id) >= 0) return false;
  if (id.startsWith(ia.TAB_ID_PREFIX) || id.startsWith(ia.SECTION_ID_PREFIX)) return false;
  return true;
}

test('分组映射：完整覆盖 index.html 里的每一个设置项，且没有多余键', () => {
  const fieldIds = settingsIdsInHtml().filter(isFieldId).sort();
  const mapped = Object.keys(ia.FIELD_SECTION).sort();
  assert.deepEqual(mapped, fieldIds, '分组映射表必须与 index.html 的设置项一一对应');
  assert.equal(fieldIds.length, 63, '1.4.0 基线 + 章号 3 项 + 1.6.0 统计累计汇总 2 项：设置项 63 个');
});

test('分组映射：每个分区都非空，且只落在 5 个合法分区里', () => {
  for (const [id, section] of Object.entries(ia.FIELD_SECTION)) {
    assert.ok(ia.TAB_IDS.indexOf(section) >= 0, `${id} 的分区 ${section} 不在 5 个分区里`);
  }
  for (const section of ia.TAB_IDS) {
    assert.ok(ia.fieldsForSection(section).length > 0, `${section} 分区不能是空的`);
  }
  // 作业卡 P0-1 §2 的分组口径：这几项是入口级的，错位最影响找法
  assert.equal(ia.sectionForField('settings-font'), 'display');
  assert.equal(ia.sectionForField('settings-page-width'), 'display');
  assert.equal(ia.sectionForField('settings-caret-paragraph'), 'display');
  assert.equal(ia.sectionForField('settings-calendar-field'), 'writing');
  assert.equal(ia.sectionForField('settings-daily-goal'), 'writing');
  assert.equal(ia.sectionForField('settings-chapter-template'), 'content');
  assert.equal(ia.sectionForField('settings-sensitive-path'), 'content');
  assert.equal(ia.sectionForField('settings-root'), 'data');
  assert.equal(ia.sectionForField('settings-snapshot-enabled'), 'data');
  assert.equal(ia.sectionForField('settings-export-conversion'), 'data');
  assert.equal(ia.sectionForField('settings-logs-status'), 'about');
  assert.equal(ia.sectionForField('settings-update-version'), 'about');
  // 认不出的 id 返回 null（不抛，也不瞎归类）
  assert.equal(ia.sectionForField('settings-不存在'), null);
  assert.equal(ia.sectionForField(null), null);
});

test('分区：顺序固定 5 个；按书作用域只剩「显示」，其余自动退回显示', () => {
  assert.deepEqual(ia.TAB_IDS, ['display', 'writing', 'content', 'data', 'about']);
  assert.deepEqual(ia.sectionsForScope('global'), ['display', 'writing', 'content', 'data', 'about']);
  assert.deepEqual(ia.sectionsForScope('book'), ['display']);
  assert.deepEqual(ia.sectionsForScope(undefined), ['display', 'writing', 'content', 'data', 'about']);
  // 全局：认得的照用，认不得的回默认
  assert.equal(ia.resolveTab('global', 'about'), 'about');
  assert.equal(ia.resolveTab('global', 'nope'), 'display');
  // 按书：只有显示可用，其它一律退回显示
  assert.equal(ia.resolveTab('book', 'writing'), 'display');
  assert.equal(ia.resolveTab('book', 'display'), 'display');
  assert.equal(ia.isTabId('writing'), true);
  assert.equal(ia.isTabId('nope'), false);
});

test('搜索归一：小写 + 全角转半角 + 合并空白（不删空格）', () => {
  assert.equal(ia.normalizeQuery('  字体  '), '字体');
  assert.equal(ia.normalizeQuery('ABC'), 'abc');
  assert.equal(ia.normalizeQuery('ＡＢＣ'), 'abc');
  assert.equal(ia.normalizeQuery('每日　目标'), '每日 目标');
  assert.equal(ia.normalizeQuery('a\t b\nc'), 'a b c');
  assert.equal(ia.normalizeQuery(''), '');
  assert.equal(ia.normalizeQuery(null), '');
  assert.equal(ia.normalizeQuery(undefined), '');
  assert.equal(ia.normalizeQuery('１２３'), '123');
});

test('搜索匹配：子串命中、大小写 / 全半角无关、空查询全命中、带空格也能命中', () => {
  assert.equal(ia.matchesQuery('', '任意文案'), true);
  assert.equal(ia.matchesQuery('字体', '正文字体（宋体 / 衬线）'), true);
  assert.equal(ia.matchesQuery('abc', 'ABC 定义'), true);
  assert.equal(ia.matchesQuery('ＡＢＣ', 'abc 定义'), true);
  assert.equal(ia.matchesQuery('每日目标', '每日 目标（字）'), true);
  assert.equal(ia.matchesQuery('每日 目标', '每日目标（字）'), true);
  assert.equal(ia.matchesQuery('快照', '诊断日志'), false);
  assert.equal(ia.matchesQuery('快照', ''), false);
});

test('搜索计划：命中行跨分组显示、分组标题命中整组显示、一条不中就是空结果', () => {
  const units = [
    { id: 'g1', kind: 'group', groupId: 'disp:1', text: '字体', section: 'display' },
    { id: 'r1', kind: 'row', groupId: 'disp:1', text: '正文字体', section: 'display' },
    { id: 'r2', kind: 'row', groupId: 'disp:1', text: '自定义字体文件', section: 'display' },
    { id: 'g2', kind: 'group', groupId: 'disp:2', text: '排版', section: 'display' },
    { id: 'r3', kind: 'row', groupId: 'disp:2', text: '行间距', section: 'display' },
    { id: 'g3', kind: 'group', groupId: 'data:1', text: '数据安全', section: 'data' },
    { id: 'r4', kind: 'row', groupId: 'data:1', text: '快照保留天数', section: 'data' }
  ];
  // 空查询：不搜（visible = null 表示「全部照原样显示」）
  const idle = ia.planSearch('', units);
  assert.equal(idle.active, false);
  assert.equal(idle.visible, null);
  assert.equal(idle.empty, false);
  assert.equal(idle.count, 0);

  // 命中一行：只露这一行 + 它的分组标题（别的分区不露）
  const one = ia.planSearch('行间距', units);
  assert.equal(one.active, true);
  assert.deepEqual(one.visible.sort(), ['g2', 'r3']);
  assert.deepEqual(one.sections, ['display']);
  assert.equal(one.count, 1);
  assert.equal(one.empty, false);

  // 分组标题命中：整组都显示
  const group = ia.planSearch('字体', units);
  assert.deepEqual(group.visible.sort(), ['g1', 'r1', 'r2']);
  assert.equal(group.count, 2);

  // 跨分区：命中的两个分区都露出来
  const cross = ia.planSearch('快照', units);
  assert.deepEqual(cross.visible.sort(), ['g3', 'r4']);
  assert.deepEqual(cross.sections, ['data']);

  // 一条都不中：empty = true，UI 显示「没有匹配的设置」
  const none = ia.planSearch('不存在的词', units);
  assert.equal(none.active, true);
  assert.equal(none.empty, true);
  assert.equal(none.count, 0);
  assert.deepEqual(none.visible, []);

  // 坏输入不抛
  assert.equal(ia.planSearch('x', null).empty, true);
  assert.equal(ia.planSearch(null, []).active, false);
});

test('搜索播报：没在搜不出声，命中报条数，空结果交给空结果块自己播（不重复说）', () => {
  assert.equal(ia.searchStatusText(ia.planSearch('', [{ id: 'a', kind: 'row', groupId: '', text: '字体', section: 'display' }])), '');
  const hit = ia.planSearch('字体', [{ id: 'a', kind: 'row', groupId: '', text: '字体', section: 'display' }]);
  assert.equal(ia.searchStatusText(hit), '匹配 1 个设置项');
  const miss = ia.planSearch('zzz', [{ id: 'a', kind: 'row', groupId: '', text: '字体', section: 'display' }]);
  assert.equal(ia.searchStatusText(miss), '', '空结果不占状态行（空结果块自带 role=status）');
  assert.equal(miss.empty, true);
  assert.equal(ia.searchStatusText(null), '');
});

test('深链：码字日历 → 写作分区；按书作用域不可用；认不出的返回 null', () => {
  const link = ia.resolveDeepLink('calendar', 'global');
  assert.deepEqual(link, { tab: 'writing', field: 'settings-calendar-field', available: true });
  const book = ia.resolveDeepLink('calendar', 'book');
  assert.equal(book.available, false);
  assert.equal(book.tab, 'display', '按书作用域里 calendar 不可用，tab 退回显示');
  assert.equal(ia.resolveDeepLink('nope', 'global'), null);
  assert.equal(ia.resolveDeepLink(null, 'global'), null);
  // 作业卡口径：深链表里只登记 calendar 一个入口
  assert.deepEqual(Object.keys(ia.DEEP_LINKS), ['calendar']);
});

test('index.html 结构：顶部搜索 + 5 个 tab + 5 个 tabpanel，且 section 都是真的容器', () => {
  const block = settingsModalHtml();
  assert.ok(block.includes('id="settings-search"'), '应该有搜索框');
  assert.ok(block.includes('id="btn-settings-search-clear"'), '应该有清空按钮');
  assert.ok(block.includes('id="settings-empty"'), '应该有空结果块');
  const tabs = [...block.matchAll(/role="tab"/g)].length;
  const panels = [...block.matchAll(/role="tabpanel"/g)].length;
  assert.equal(tabs, 5, '5 个分区导航按钮');
  assert.equal(panels, 5, '5 个分区容器');
  for (const tab of ia.TAB_IDS) {
    assert.ok(block.includes(`id="${ia.TAB_ID_PREFIX}${tab}"`), `tab 按钮 ${tab} 应该在`);
    assert.ok(block.includes(`id="${ia.SECTION_ID_PREFIX}${tab}"`), `tabpanel ${tab} 应该在`);
    assert.ok(block.includes(`aria-controls="${ia.SECTION_ID_PREFIX}${tab}"`), `tab ${tab} 要 aria-controls`);
    assert.ok(block.includes(`aria-labelledby="${ia.TAB_ID_PREFIX}${tab}"`), `tabpanel ${tab} 要 aria-labelledby`);
  }
  // 每个设置项必须真的落在它所属分区里（防止映射表与 DOM 走散）
  for (const [id, section] of Object.entries(ia.FIELD_SECTION)) {
    const attr = `id="${id}"`;
    const at = block.indexOf(attr);
    assert.ok(at > 0, `index.html 里应该有 ${id}`);
    // 该 id 之前最近的一个 data-settings-section 就是它所在的分区
    const before = block.slice(0, at);
    const matches = [...before.matchAll(/data-settings-section="([a-z]+)"/g)];
    assert.ok(matches.length > 0, `${id} 应该在被包裹的分区里`);
    assert.equal(matches[matches.length - 1][1], section, `${id} 在 DOM 里应属于 ${section} 分区`);
  }
});
