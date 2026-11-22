// 设置面板测试（T9 / 第 10 轮按性质拆分）：渲染小件 / 表单件 / 接线 / 搜索。
// 本文件覆盖：setSelectValue → 正文宽度档位（4 档 + 历史 900/1000 用 hidden 动态 option）→
// renderSettingsCaretColors（色板 data-active / aria-pressed / --swatch）→ renderChapterTemplatePreview →
// setupSettingsUi 注册全部监听与字体 change 回落 → SS-06 设置搜索按作用域与字段级 .hidden 过滤。
//
// 来源：原 tests/settings-ui.test.js（1,630 行 / 51 例）按性质拆成夹具 + 四个文件，**只搬家不改断言**——
// 用例标题与断言逐字保留，共用夹具收进 tests/settings-ui-fixtures.js（T9 纪律，见 tests/README.md）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { build, makeDocument, makeEl, DISPLAY_IDS, flush, caretColorLib, templateLib } = require('./settings-ui-fixtures');
const preambles = require('./ui-test-preambles');

// 夹具 build() 会把 document 挂到全局；本文件收尾统一还原（TEST-D-02）。
preambles.restoreGlobalsAfter(test, ['document']);

// ---------- 表单 / 颜色 / 模板 ----------
test('setSelectValue：值合法就写；不在选项里时回到 fallback', () => {
  const ctx = build();
  ctx.dom.map.get('settings-font').value = '怪值';
  ctx.ui.setSelectValue('settings-font', 'serif', 'serif');
  assert.equal(ctx.dom.map.get('settings-font').value, 'serif');
});

// 正文宽度档位（1.3.0 T3 / 规范 T-06）：设置项改成 通栏 / 720 / 800 / 840（840 ≈ 39.6 字，
// 落回 clreq 推荐 17–40 字）；900 / 1000 从界面下线，但历史配置照常加载 —— 打开设置要显示原值、
// 不静默改写、也不丢值（config 的 clamp 仍是 600–1600）。
test('正文宽度档位（T-06）：通栏 / 720 / 800 / 840；历史 900 / 1000 用 hidden 动态 option 原样显示、不改写', async () => {
  const widthOf = (ctx) => ctx.dom.map.get('settings-page-width');
  const legacyOf = (ctx) => widthOf(ctx).querySelectorAll('[data-page-width-history]');

  // 1) 新档位：值就在选项里，不挂动态 option
  for (const width of [0, 720, 800, 840]) {
    const ctx = build({ view: 'shelf', bookId: null, config: { booksRoot: '/书库', editorPageWidth: width } });
    await ctx.ui.openSettings();
    assert.equal(widthOf(ctx).value, String(width), '新档位 ' + width + ' 正常回填');
    assert.equal(legacyOf(ctx).length, 0, '新档位不挂历史 option');
    ctx.ui.closeSettings();
  }

  // 2) 历史值 900 / 1000：select 显示原值 + 一个 hidden 动态 option（不静默改成 840 / 0）
  for (const width of [900, 1000]) {
    const ctx = build({ view: 'shelf', bookId: null, config: { booksRoot: '/书库', editorPageWidth: width } });
    await ctx.ui.openSettings();
    assert.equal(widthOf(ctx).value, String(width), '历史配置照常显示原值 ' + width);
    const legacy = legacyOf(ctx);
    assert.equal(legacy.length, 1, '历史值挂一个动态 option');
    assert.equal(legacy[0].value, String(width));
    assert.equal(legacy[0].hidden, true, '历史 option 隐藏：关闭态显示值，下拉列表里不再提供');
    assert.match(legacy[0].textContent, new RegExp('^' + width + ' px · 历史值'));
    // 只打开 / 取消不写盘：值没有被静默改写（保存读的是表单里选中的值，旧值保存回去还是旧值）
    ctx.ui.closeSettings();
    assert.deepEqual(ctx.calls.setConfig, [], '取消不写盘');
  }

  // 3) clamp 允许但不在档位里的值（600–1600 内，例如 650）同样原样保留
  const custom = build({ view: 'shelf', bookId: null, config: { booksRoot: '/书库', editorPageWidth: 650 } });
  await custom.ui.openSettings();
  assert.equal(widthOf(custom).value, '650');
  assert.equal(legacyOf(custom).length, 1);

  // 4) 同一 select 反复回填：历史 option 先清掉再挂，不堆积；切到新档位后不残留
  await custom.ui.openSettings();
  assert.equal(legacyOf(custom).length, 1, '重新打开不堆积历史 option');
  custom.state.config = { booksRoot: '/书库', editorPageWidth: 800 };
  custom.state.globalConfig = custom.state.config;
  await custom.ui.openSettings();
  assert.equal(widthOf(custom).value, '800');
  assert.equal(legacyOf(custom).length, 0, '切到新档位后历史 option 被清掉');

  // 5) 坏值 / 缺字段按通栏（配置层已经夹过，这里兜底一层）
  const broken = build({ view: 'shelf', bookId: null, config: { booksRoot: '/书库', editorPageWidth: 'x' } });
  await broken.ui.openSettings();
  assert.equal(widthOf(broken).value, '0');
  assert.equal(legacyOf(broken).length, 0);
});

test('renderSettingsCaretColors：色板 data-active / aria-pressed / --swatch，取色器空值退回预设色', () => {
  const ctx = build();
  const row = ctx.dom.map.get('settings-caret-colors');
  const preset = caretColorLib.PRESET_VALUES[0];
  const s1 = makeEl('button');
  s1.dataset.settingsCaretColor = '#c0392b';
  const s2 = makeEl('button');
  s2.dataset.settingsCaretColor = preset;
  row.append(s1, s2);
  ctx.state.settingsCaretColorDraft = '#c0392b';
  ctx.ui.renderSettingsCaretColors();
  assert.equal(s1.dataset.active, '1');
  assert.equal(s2.dataset.active, '0');
  assert.equal(s1.getAttribute('aria-pressed'), 'true');
  assert.equal(s1.style._props['--swatch'], '#c0392b');
  assert.equal(ctx.dom.map.get('settings-caret-color').value, '#c0392b');
});

test('renderChapterTemplatePreview：未设置模板给说明；设置了按「下一个章号」展开预览', () => {
  const ctx = build({ view: 'editor', bookPath: '/书库/书甲' });
  ctx.state.chapters = [1, 2, 3];
  ctx.dom.map.get('settings-chapter-template').value = '';
  ctx.ui.renderChapterTemplatePreview();
  assert.equal(ctx.dom.map.get('settings-template-preview').textContent, '预览：（未设置模板，新建章节仍是空章）');

  const tpl = '第{n}章：{title}';
  ctx.dom.map.get('settings-chapter-template').value = tpl;
  ctx.ui.renderChapterTemplatePreview();
  const expected = templateLib.applyTemplate(tpl, { chapterNumber: 4, chapterName: '示例章名', now: new Date() });
  assert.equal(ctx.dom.map.get('settings-template-preview').textContent, `预览（第 4 章）：\n${expected}`);
  assert.equal(ctx.dom.map.get('settings-template-preview').textContent, '预览（第 4 章）：\n第4章：示例章名');
});

// ---------- 事件绑定 ----------
test('setupSettingsUi：注册设置域的全部监听（含显示项循环 / 色板 / 取色器 / 两个条件按钮）', () => {
  const dom = makeDocument();
  const ctx = build({ dom });
  ctx.ui.setupSettingsUi();
  for (const id of ['btn-settings', 'btn-settings-cancel', 'btn-settings-close', 'btn-settings-save', 'btn-reset-book-display',
    'btn-pick-folder', 'btn-pick-sensitive', 'btn-clear-sensitive', 'btn-pick-proofread', 'btn-clear-proofread',
    'btn-open-logs', 'btn-check-update', 'btn-open-update', 'btn-pick-font', 'btn-reset-font',
    'settings-chapter-template', 'settings-font', 'settings-caret-paragraph', 'settings-caret-colors',
    'settings-caret-color', 'btn-proofread-pick']) {
    assert.equal(dom.map.get(id)._listeners.length >= 1, true, id + ' 应该有监听');
  }
  for (const id of DISPLAY_IDS) assert.equal(dom.map.get(id)._listeners.length, 1, id + ' 显示项循环注册');
  assert.deepEqual(dom.map.get('settings-caret-color')._listeners.map((l) => l.type), ['input', 'change']);

  // 触发：取消 → 关弹层
  dom.map.get('settings-backdrop').classList.remove('hidden');
  dom.map.get('btn-settings-cancel')._fire('click');
  assert.equal(dom.map.get('settings-backdrop').classList.contains('hidden'), true);

  // 清敏感词：清草稿 + 刷新设置里的词表状态
  dom.map.get('btn-clear-sensitive')._fire('click');
  assert.equal(ctx.state.sensitiveWordsDraft, '');
  // 清校对词表
  dom.map.get('btn-clear-proofread')._fire('click');
  assert.equal(ctx.state.proofreadWordsDraft, '');
});

test('setupSettingsUi：字体 change 选 custom 但没草稿 → 警告并回 serif；选目录写回 root 输入框', async () => {
  const dom = makeDocument();
  const ctx = build({ dom, folder: '/新书库' });
  ctx.state.settingsFontDraft = { path: '', name: '' };
  ctx.ui.setupSettingsUi();
  dom.map.get('settings-font').value = 'custom';
  dom.map.get('settings-font')._fire('change', {});
  await flush();
  assert.equal(dom.map.get('settings-font').value, 'serif');
  assert.deepEqual(ctx.calls.toast, [['先点「选择…」挑一个 .ttf / .otf 字体文件', 'warn']]);

  await dom.map.get('btn-pick-folder')._fire('click');
  await flush();
  assert.equal(ctx.calls.pickFolder, 1);
  assert.equal(dom.map.get('settings-root').value, '/新书库');
});

// SS-06（五-L16）：设置搜索的计数 / 空态用的是「全部 5 个分区」的单位，而显示时按作用域裁剪 ——
// 按书设置里搜只存在于「数据」分区的词（快照 / 词表 / 更新…）或搜被字段级 .hidden 藏起来的项时，
// 状态栏播报「匹配 N 个设置项」，可见区却一片空白，且 empty=false 连「没有匹配的设置」都不显示。
test('SS-06（五-L16）：设置搜索按作用域与字段级 .hidden 过滤，计数 / 空态与可见区一致', () => {
  const settingsIa = require('../renderer/settings-ia');
  const dom = makeDocument();
  const ctx = build({ dom, scope: 'book', ia: settingsIa });
  const displaySec = dom.ensure('settings-section-display');
  const dataSec = dom.ensure('settings-section-data');
  const visibleRow = makeEl('div');
  visibleRow.textContent = '正文显示 字体 字号 行距';
  const hiddenRow = makeEl('div');
  hiddenRow.textContent = '章号编号方式（按书设置里隐藏）';
  hiddenRow.classList.add('hidden');
  displaySec.appendChild(visibleRow);
  displaySec.appendChild(hiddenRow);
  const snapshotRow = makeEl('div');
  snapshotRow.textContent = '写作快照 保留天数';
  dataSec.appendChild(snapshotRow);
  const search = dom.ensure('settings-search');
  const empty = dom.ensure('settings-empty');
  const status = dom.ensure('settings-search-status');
  ctx.ui.setupSettingsUi();

  // ① 按书作用域搜「快照」（只在数据分区）：一个都显示不出来 → 不进计数、要显示空态
  search.value = '快照';
  search._fire('input');
  assert.equal(status.textContent, '', '不可见分区的命中不许播报成「匹配 N 个」');
  assert.equal(empty.classList.contains('hidden'), false, '搜不到可见项时必须显示「没有匹配的设置」空态');
  assert.equal(dataSec.hidden, true, '数据分区在按书作用域里仍然隐藏');
  assert.equal(snapshotRow.classList.contains('search-hidden'), false, '不可见分区的行不参与搜索，也不留脏标记');

  // ② 按书作用域搜被字段级 .hidden 藏起来的项：同样不算命中
  search.value = '编号';
  search._fire('input');
  assert.equal(status.textContent, '', '字段级隐藏项不许计入命中数');
  assert.equal(empty.classList.contains('hidden'), false);
  assert.equal(hiddenRow.classList.contains('search-hidden'), false);

  // ③ 全局作用域搜「快照」：数据分区可见、播报 1 个、空态收起（正常命中口径不变）
  ctx.state.settingsScope = 'global';
  search.value = '快照';
  search._fire('input');
  assert.equal(status.textContent, '匹配 1 个设置项');
  assert.equal(empty.classList.contains('hidden'), true);
  assert.equal(dataSec.hidden, false, '全局作用域里数据分区照常露出来');
  assert.equal(snapshotRow.classList.contains('search-hidden'), false);
  assert.equal(visibleRow.classList.contains('search-hidden'), true, '没命中的行照常收起');

  // ④ 清空搜索：所有行（含被过滤掉的分区）的 search-hidden 标记都要清掉，切作用域不残留
  search.value = '';
  search._fire('input');
  assert.equal(snapshotRow.classList.contains('search-hidden'), false);
  assert.equal(visibleRow.classList.contains('search-hidden'), false);
  assert.equal(hiddenRow.classList.contains('search-hidden'), false);
});
