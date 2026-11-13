// E2E 第 73 组：设置面板信息架构（1.4.0 P0-1：顶部搜索 + 左侧 5 个分区 + 深链切分区）。
//
// 钉住的是「设置项一个不少、but 找得到」这件事：
//   ① 打开默认停在「显示」，其余分区不渲染（按作用域：书架 = 全局 5 个分区）；
//   ② 5 个分区逐个切过去，每个分区里代表项真的可见（getClientRects 非空）；
//   ③ 导航键盘：→ / ← / Home / End 切分区（roving tabindex）；
//   ④ 搜索跨分区命中（数据分区的「快照」露出来、没命中的分区藏起来、状态行报条数）；
//   ⑤ 搜索空结果 = 「没有匹配的设置」+ 清空入口；
//   ⑥ 清空搜索回到当前分区；
//   ⑦ 搜索框里 Esc 两段行为：先清空搜索（弹层还开着），再按一次才关弹层；
//   ⑧ 按书作用域只剩「显示」：硬点其它分区按钮也切不过去；
//   ⑨ 在非默认分区里改设置 → 保存，config.json 真的写进去（隐藏分区的字段读值正常）。
//
// 只走临时书库 + 临时 userData（run-e2e.js 已隔离）；只用现有测试钩子 / 公开 DOM，不读模块内部状态。
const fs = require('node:fs/promises');
const path = require('node:path');

// 弹层 + 分区的现场快照（标签 / 分区 / 搜索状态一次取回，避免多次 evaluate 之间状态漂移）
const JS_STATE = `(() => {
  const tabs = Array.from(document.querySelectorAll('#settings-nav [data-settings-tab]'));
  const sections = Array.from(document.querySelectorAll('.settings-section'));
  const search = document.getElementById('settings-search');
  return JSON.stringify({
    open: !document.getElementById('settings-backdrop').classList.contains('hidden'),
    scope: window.__cwTest.settingsScope(),
    selected: tabs.filter((b) => b.getAttribute('aria-selected') === 'true').map((b) => b.dataset.settingsTab),
    hiddenTabs: tabs.filter((b) => b.classList.contains('hidden')).map((b) => b.dataset.settingsTab),
    shown: sections.filter((s) => !s.hidden).map((s) => s.dataset.settingsSection),
    hidden: sections.filter((s) => s.hidden).map((s) => s.dataset.settingsSection),
    status: document.getElementById('settings-search-status').textContent,
    empty: !document.getElementById('settings-empty').classList.contains('hidden'),
    emptyText: (document.getElementById('settings-empty') || { textContent: '' }).textContent || '',
    clearVisible: !document.getElementById('btn-settings-search-clear').classList.contains('hidden'),
    query: search ? search.value : null
  });
})()`;

// 当前可见（search-hidden / 分区 hidden 都不算）的设置行由 JS_HIT 里的 filter 现算
const readState = async (exec) => JSON.parse(await exec(JS_STATE));

// 搜索框赋值 + 触发 input（原生 setter 才能触发框架外的监听；这里直接改 value 再派发即可）
const typeSearch = (text) =>
  `(() => {
    const input = document.getElementById('settings-search');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`;

module.exports = async function group73SettingsIa(t) {
  const { exec, check, waitFor, sleep, waitForDisk, storage, booksRoot, userData, deleteBookWithRetry } = t;

  // ---------- ① 书架（全局作用域）打开设置：默认停在「显示」 ----------
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec('window.__cwTest.openSettings()');
  await waitFor('window.__cwTest.settingsOpen() === true');
  const initial = await readState(exec);
  check('设置信息架构：书架打开 = 全局作用域', initial.scope === 'global', initial.scope);
  check('设置信息架构：打开默认停在「显示」分区', initial.selected.join(',') === 'display', initial.selected);
  check(
    '设置信息架构：全局作用域只有「显示」分区可见',
    initial.shown.join(',') === 'display' && initial.hidden.length === 4,
    { shown: initial.shown, hidden: initial.hidden }
  );

  // ---------- ② 5 个分区逐个切：代表项真的可见 ----------
  const tabProbes = [
    ['display', 'settings-font', '显示'],
    ['writing', 'settings-daily-goal', '写作'],
    ['content', 'settings-chapter-template', '内容'],
    ['data', 'settings-snapshot-enabled', '数据'],
    ['about', 'btn-check-update', '关于']
  ];
  for (const [tab, probeId, label] of tabProbes) {
    await exec(`document.getElementById('settings-tab-${tab}').click()`);
    await sleep(60);
    const shot = JSON.parse(
      await exec(`(() => {
        const el = document.getElementById(${JSON.stringify(probeId)});
        return JSON.stringify({
          selected: document.getElementById('settings-tab-${tab}').getAttribute('aria-selected'),
          tabIndex: document.getElementById('settings-tab-${tab}').getAttribute('tabindex'),
          shown: Array.from(document.querySelectorAll('.settings-section')).filter((s) => !s.hidden).map((s) => s.dataset.settingsSection),
          probeVisible: Boolean(el && el.getClientRects().length > 0)
        });
      })()`)
    );
    check(
      `设置信息架构：切到「${label}」分区能看到对应设置项`,
      shot.selected === 'true' && shot.tabIndex === '0' && shot.shown.join(',') === tab && shot.probeVisible === true,
      shot
    );
  }

  // ---------- ③ 导航键盘：→ / ← / Home / End ----------
  const keyTab = async (key) => {
    await exec(`(() => {
      const nav = document.getElementById('settings-nav');
      nav.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));
    })()`);
    await sleep(60);
    return JSON.parse(
      await exec(`(() => {
        const tabs = Array.from(document.querySelectorAll('#settings-nav [data-settings-tab]'));
        const active = document.activeElement;
        return JSON.stringify({
          selected: tabs.filter((b) => b.getAttribute('aria-selected') === 'true').map((b) => b.dataset.settingsTab),
          focus: active ? active.dataset.settingsTab || active.id : null
        });
      })()`)
    );
  };
  await exec("document.getElementById('settings-tab-display').focus()");
  await exec("document.getElementById('settings-tab-display').click()");
  const toRight = await keyTab('ArrowRight');
  check(
    '设置信息架构：导航里 → 切到下一个分区并聚焦',
    toRight.selected.join(',') === 'writing' && toRight.focus === 'writing',
    toRight
  );
  const toLeft = await keyTab('ArrowLeft');
  check('设置信息架构：导航里 ← 切回上一个分区', toLeft.selected.join(',') === 'display', toLeft);
  const toEnd = await keyTab('End');
  check('设置信息架构：导航里 End 直接到「关于」分区', toEnd.selected.join(',') === 'about', toEnd);
  const toHome = await keyTab('Home');
  check('设置信息架构：导航里 Home 直接回「显示」分区', toHome.selected.join(',') === 'display', toHome);

  // ---------- ④ 搜索：跨分区命中 ----------
  await exec(typeSearch('快照'));
  await sleep(80);
  const hit = JSON.parse(
    await exec(`(() => {
      const sections = Array.from(document.querySelectorAll('.settings-section'));
      const rows = Array.from(document.querySelectorAll('.settings-section > :not(.field-group)'));
      const visibleRows = rows.filter((el) => el.getClientRects().length > 0);
      return JSON.stringify({
        shown: sections.filter((s) => !s.hidden).map((s) => s.dataset.settingsSection),
        fontVisible: document.getElementById('settings-font').getClientRects().length > 0,
        rowTexts: visibleRows.map((el) => (el.textContent || '').slice(0, 40)),
        rowCount: visibleRows.length
      });
    })()`)
  );
  check(
    '设置信息架构：搜索「快照」跨分区命中，只有数据分区露出来',
    hit.shown.join(',') === 'data' && hit.fontVisible === false,
    hit
  );
  check(
    '设置信息架构：命中的每一行都含搜索词',
    hit.rowCount >= 2 && hit.rowTexts.every((text) => text.includes('快照')),
    hit.rowTexts
  );
  const hitState = await readState(exec);
  check(
    '设置信息架构：命中时状态行报条数、出现清空按钮',
    /^匹配 \d+ 个设置项$/.test(hitState.status) && hitState.clearVisible === true,
    hitState
  );

  // ---------- ⑤ 搜索空结果 ----------
  await exec(typeSearch('这一个设置项肯定不存在zzz'));
  await sleep(80);
  const none = await readState(exec);
  check(
    '设置信息架构：搜索空结果 = 「没有匹配的设置」+ 空结果块',
    none.empty === true && none.emptyText.includes('没有匹配的设置') && none.status === '' && none.shown.length === 0,
    none
  );

  // ---------- ⑥ 清空搜索恢复当前分区 ----------
  await exec("document.getElementById('btn-settings-search-clear').click()");
  await sleep(80);
  const restored = await readState(exec);
  check(
    '设置信息架构：清空搜索后回到当前分区（显示）',
    restored.query === '' && restored.empty === false && restored.status === '' && restored.shown.join(',') === 'display',
    restored
  );

  // ---------- ⑦ 搜索框里 Esc 两段行为 ----------
  await exec(typeSearch('字体'));
  await sleep(60);
  await exec("document.getElementById('settings-search').focus()");
  await exec(
    "document.getElementById('settings-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))"
  );
  await sleep(80);
  const afterFirstEsc = await readState(exec);
  check(
    '设置信息架构：搜索框里第一次 Esc 只清空搜索，弹层还开着',
    afterFirstEsc.open === true && afterFirstEsc.query === '' && afterFirstEsc.shown.join(',') === 'display',
    afterFirstEsc
  );
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor('window.__cwTest.settingsOpen() === false');
  check('设置信息架构：搜索清空后再按 Esc 才关弹层', (await exec('window.__cwTest.settingsOpen()')) === false);

  // ---------- ⑧ 按书作用域只剩「显示」 ----------
  const created = await storage.createBook(booksRoot, '设置演练');
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(created.path)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec('window.__cwTest.openSettings()');
  await waitFor('window.__cwTest.settingsOpen() === true');
  const bookScope = await readState(exec);
  check(
    '设置信息架构：按书作用域只有「显示」分区',
    bookScope.scope === 'book' &&
      bookScope.shown.join(',') === 'display' &&
      bookScope.hiddenTabs.sort().join(',') === 'about,content,data,writing',
    bookScope
  );
  // 硬点一个被藏起来的 tab：仍然切不过去（resolveTab 按作用域退回「显示」）
  await exec("document.getElementById('settings-tab-writing').click()");
  await sleep(80);
  const forced = await readState(exec);
  check(
    '设置信息架构：按书作用域里硬点其它分区也切不过去',
    forced.selected.join(',') === 'display' && forced.shown.join(',') === 'display',
    forced
  );
  await exec('window.__cwTest.closeSettings()');
  await waitFor('window.__cwTest.settingsOpen() === false');
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");

  // ---------- ⑨ 非默认分区改设置 → 保存真的写盘 ----------
  const configPath = path.join(userData, 'config.json');
  const configBefore = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const templateBefore = configBefore.chapterTemplate || '';
  await exec('window.__cwTest.openSettings()');
  await waitFor('window.__cwTest.settingsOpen() === true');
  await exec("document.getElementById('settings-tab-content').click()");
  await sleep(60);
  await exec(`(() => {
    const area = document.getElementById('settings-chapter-template');
    area.value = '第{n}章：{title}（设置分区落盘演练）';
    area.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await exec("document.getElementById('btn-settings-save').click()");
  await waitFor('window.__cwTest.settingsOpen() === false');
  await waitForDisk();
  const configAfter = JSON.parse(await fs.readFile(configPath, 'utf8'));
  check(
    '设置信息架构：在「内容」分区改章节模板，保存后 config.json 真的写进去',
    configAfter.chapterTemplate === '第{n}章：{title}（设置分区落盘演练）',
    configAfter.chapterTemplate
  );
  // 还原：把模板改回原值（否则后面的组看到的是演练文案）
  await exec('window.__cwTest.openSettings()');
  await waitFor('window.__cwTest.settingsOpen() === true');
  await exec("document.getElementById('settings-tab-content').click()");
  await sleep(60);
  await exec(`(() => {
    const area = document.getElementById('settings-chapter-template');
    area.value = ${JSON.stringify(templateBefore)};
    area.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await exec("document.getElementById('btn-settings-save').click()");
  await waitFor('window.__cwTest.settingsOpen() === false');
  await waitForDisk();
  const configRestored = JSON.parse(await fs.readFile(configPath, 'utf8'));
  check(
    '设置信息架构：章节模板已还原（不影响后面的组）',
    (configRestored.chapterTemplate || '') === templateBefore,
    configRestored.chapterTemplate
  );

  // ---------- 收尾：临时书移进 _trash，弹层全关 ----------
  const removed = await deleteBookWithRetry(created.path);
  check('设置信息架构：演练书已删（移入 _trash）', Boolean(removed) && removed.ok === true, removed);
  await exec('window.__cwTest.refreshShelf()');
  await sleep(150);
  check(
    '设置信息架构：测完没有留下别的弹层',
    (await exec("document.querySelectorAll('.backdrop:not(.hidden)').length")) === 0
  );

  // ---------- ⑩ 多份校对词表：设置页与校对面板同源（1.7.1 P6 / V52） ----------
  // 面板侧的多份列表由主进程按配置里的 proofreadWordlists 判定（第 46 组尾部另有一条）；
  // 设置侧同一口径：状态行报份数 / 合计词数，旧单份路径框与选择 / 清除整排收起（只切 .hidden，不删 DOM）。
  const pfSettingsDir = path.join(userData, '校对词表-设置同源');
  await fs.mkdir(pfSettingsDir, { recursive: true });
  const pfSettingsA = path.join(pfSettingsDir, '词表一.txt');
  const pfSettingsB = path.join(pfSettingsDir, '词表二.txt');
  await fs.writeFile(pfSettingsA, '甲词\n', 'utf8');
  await fs.writeFile(pfSettingsB, '乙词\n乙词二\n', 'utf8');
  await exec(`window.__cwTest.setProofreadWordlists(${JSON.stringify([pfSettingsA, pfSettingsB])})`);
  await exec('window.__cwTest.openSettings()');
  await waitFor('window.__cwTest.settingsOpen() === true');
  await waitFor("document.getElementById('settings-proofread-status').textContent.includes('已在校对面板配置')");
  check(
    '设置信息架构：配了多份校对词表时「校对词表」行报份数与合计词数，单份路径 / 选择 / 清除收起（V52）',
    (await exec("document.getElementById('settings-proofread-status').textContent")) ===
      '已在校对面板配置 2 份词表（合计 3 词）' &&
      (await exec("document.getElementById('settings-proofread-path').classList.contains('hidden')")) === true &&
      (await exec("document.getElementById('btn-pick-proofread').classList.contains('hidden')")) === true &&
      (await exec("document.getElementById('btn-clear-proofread').classList.contains('hidden')")) === true,
    { status: await exec("document.getElementById('settings-proofread-status').textContent") }
  );
  await exec('window.__cwTest.closeSettings()');
  await waitFor('window.__cwTest.settingsOpen() === false');
  await exec('window.__cwTest.setProofreadWordlists([])');
};
