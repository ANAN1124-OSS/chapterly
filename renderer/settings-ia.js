/* 设置面板信息架构（1.4.0 P0-1）——纯逻辑，不碰 DOM、不读盘、不依赖 Electron。
 *
 * 为什么单独一个文件：设置弹层原来是「一长条 61 个 settings-* 项从上往下滚」，找一项得滚半天。
 * 1.4.0 改成「顶部搜索 + 左侧 5 个分区 + 右侧只显示当前分区」，但**一个设置项都不许少、
 * 一个 settings-* id 都不许改**（单测 236 处 / E2E 69 处引用钉住）。真正容易算错、又值得钉住的
 * 是这几件事，全部收在这里：
 *   1. 分组映射：每个 settings-* 项属于哪个分区（display / writing / content / data / about）；
 *   2. 作用域：全局 5 个分区，按书只有「显示」（其余项本来就被 updateSettingsScopeUi 隐藏）；
 *   3. 搜索：大小写 / 全半角归一后的匹配，「命中行跨分区显示、空分组与非命中行隐藏」的可见性计划；
 *   4. 深链：`section=calendar` 要切到 writing 分区再定位（U-D4 的码字日历入口）。
 *
 * 浏览器里挂 window.CWSettingsIa（index.html 排在 settings-ui.js 之前），Node 里可 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWSettingsIa = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 左侧导航的 5 个分区（顺序 = 导航顺序 = 分区的 DOM 顺序）
  const TABS = [
    { id: 'display', label: '显示' },
    { id: 'writing', label: '写作' },
    { id: 'content', label: '内容' },
    { id: 'data', label: '数据' },
    { id: 'about', label: '关于' }
  ];
  const TAB_IDS = TABS.map((tab) => tab.id);
  const DEFAULT_TAB = 'display';
  // 按书作用域只剩「显示」：其余分区的项本来就被 updateSettingsScopeUi() 逐项隐藏
  const BOOK_TABS = ['display'];
  // 设置弹层里**不是设置项**的 settings-* id（弹层骨架 / 新导航 / 搜索 / 空结果）
  const CHROME_IDS = [
    'settings-backdrop',
    'settings-title',
    'settings-scope-hint',
    'settings-nav',
    'settings-scroll',
    'settings-search',
    'settings-search-status',
    'settings-empty'
  ];
  // 导航按钮 / 分区容器的 id 前缀（settings-tab-<分区> / settings-section-<分区>）
  const TAB_ID_PREFIX = 'settings-tab-';
  const SECTION_ID_PREFIX = 'settings-section-';

  // 分组映射（全局作用域）：每个设置项 1 个分区。
  // 口径（作业卡 P0-1 §2）：
  //   显示 = 字体 / 排版 / 背景 / 当前段落高亮（默认分区）
  //   写作 = 写作统计（每日目标 / 写作时长 / 剪贴板监听 / 近 30 天柱状图 / 码字日历）
  //   内容 = 新建章节模板 / 敏感词预检 / 校对词表
  //   数据 = 书架目录 / 数据安全（每日快照）/ 导出
  //   关于 = 诊断日志 / 检查更新
  const FIELD_SECTION = {
    // 显示 · 字体
    'settings-font': 'display',
    'settings-font-name': 'display',
    'settings-size': 'display',
    // 显示 · 排版
    'settings-line-height': 'display',
    'settings-letter-spacing': 'display',
    'settings-padding-x': 'display',
    'settings-page-width': 'display',
    'settings-long-para-threshold': 'display',
    'settings-long-para-hint': 'display',
    'settings-text-autospace': 'display',
    // 显示 · 背景
    'settings-paper': 'display',
    // 显示 · 当前段落高亮
    'settings-caret-field': 'display',
    'settings-caret-paragraph': 'display',
    'settings-caret-colors': 'display',
    'settings-caret-color': 'display',
    'settings-caret-hint': 'display',
    // 写作 · 写作统计（含每日目标 / 写作时长 / 剪贴板监听 / 柱状图 / 码字日历）
    'settings-stats-group': 'writing',
    'settings-daily-goal-field': 'writing',
    'settings-daily-goal': 'writing',
    'settings-goal-state': 'writing',
    'settings-duration-field': 'writing',
    'settings-write-duration': 'writing',
    'settings-duration-summary': 'writing',
    'settings-clipboard-field': 'writing',
    'settings-clipboard-watch': 'writing',
    'settings-stats-chart-field': 'writing',
    'settings-stats-chart': 'writing',
    'settings-stats-summary': 'writing',
    'settings-calendar-field': 'writing',
    'settings-stats-hint': 'writing',
    // 内容 · 新建章节模板 / 敏感词预检 / 校对词表
    'settings-template-group': 'content',
    'settings-template-field': 'content',
    'settings-chapter-template': 'content',
    'settings-template-preview': 'content',
    'settings-sensitive-group': 'content',
    'settings-sensitive-field': 'content',
    'settings-sensitive-path': 'content',
    'settings-sensitive-status': 'content',
    'settings-proofread-group': 'content',
    'settings-proofread-field': 'content',
    'settings-proofread-path': 'content',
    'settings-proofread-status': 'content',
    // 数据 · 书架目录 / 数据安全（每日快照）/ 导出
    'settings-root-field': 'data',
    'settings-root': 'data',
    'settings-snapshot-field': 'data',
    'settings-snapshot-enabled': 'data',
    'settings-snapshot-days-field': 'data',
    'settings-snapshot-days': 'data',
    'settings-export-group': 'data',
    'settings-export-field': 'data',
    'settings-export-conversion': 'data',
    // 关于 · 诊断日志 / 检查更新
    'settings-logs-group': 'about',
    'settings-logs-field': 'about',
    'settings-logs-status': 'about',
    'settings-update-group': 'about',
    'settings-update-field': 'about',
    'settings-update-version': 'about',
    'settings-update-status': 'about'
  };

  // 深链：入口指定 section 时切到哪个分区、定位到哪个字段（U-D4 只有码字日历一个入口）
  const DEEP_LINKS = {
    calendar: { tab: 'writing', field: 'settings-calendar-field' }
  };

  function isTabId(value) {
    return TAB_IDS.indexOf(String(value)) >= 0;
  }

  function sectionForField(id) {
    const key = String(id == null ? '' : id);
    return Object.prototype.hasOwnProperty.call(FIELD_SECTION, key) ? FIELD_SECTION[key] : null;
  }

  // 某个分区里的设置项 id（按映射表的声明顺序；只给单测 / 文档用，UI 不靠它）
  function fieldsForSection(section) {
    return Object.keys(FIELD_SECTION).filter((id) => FIELD_SECTION[id] === section);
  }

  // 当前作用域可用的分区（全局 5 个；按书只有显示）
  function sectionsForScope(scope) {
    return String(scope) === 'book' ? BOOK_TABS.slice() : TAB_IDS.slice();
  }

  // 分区在给定作用域里能不能用；不能用时回默认分区（按书作用域里切到「数据」要自动退回「显示」）
  function resolveTab(scope, wanted) {
    const allowed = sectionsForScope(scope);
    return allowed.indexOf(String(wanted)) >= 0 ? String(wanted) : allowed[0] || DEFAULT_TAB;
  }

  // 深链解析：认不出返回 null；认得出就把 tab 按作用域校正一次（按书作用域里 calendar 不可用）
  function resolveDeepLink(section, scope) {
    const key = String(section == null ? '' : section);
    if (!Object.prototype.hasOwnProperty.call(DEEP_LINKS, key)) return null;
    const link = DEEP_LINKS[key];
    return { tab: resolveTab(scope, link.tab), field: link.field, available: sectionsForScope(scope).indexOf(link.tab) >= 0 };
  }

  // 搜索归一：小写 + 全角 ASCII / 表意空格转半角 + 合并空白。
  // 不删空格（「每日 目标」和「每日目标」都该能搜到，靠下面 matchesQuery 的去空格比较）。
  function normalizeQuery(value) {
    const raw = String(value == null ? '' : value);
    let out = '';
    for (const ch of raw) {
      const code = ch.codePointAt(0);
      if (code === 0x3000) out += ' ';
      else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - 0xfee0);
      else out += ch;
    }
    return out.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // 匹配口径：查询串是目标串的子串即命中；两边都归一。
  // 第二口径：把空格去掉再比一次（「每日目标」能命中「每日 目标（字）」这类带空格的文案）。
  // 注：归一后只剩单个半角空格，所以用 split / join 去空格，不写「把 \s 换成空串」的 replace
  //（那条口径全仓库只许 core/chapters.js 有一处，见 tests/char-count.test.js 的静态闸门）。
  function matchesQuery(query, text) {
    const needle = normalizeQuery(query);
    if (!needle) return true;
    const hay = normalizeQuery(text);
    if (!hay) return false;
    if (hay.indexOf(needle) >= 0) return true;
    const compactNeedle = needle.split(' ').join('');
    if (!compactNeedle) return true;
    return hay.split(' ').join('').indexOf(compactNeedle) >= 0;
  }

  // 搜索可见性计划（纯函数）：
  //   units = [{ id, kind: 'group' | 'row', groupId, text, section }]
  //     kind=group 是分组标题（field-group），kind=row 是标题下面的一行 / 一段说明；
  //     groupId 把同一分组里的行串起来（没有分组标题的行用 ''）。
  // 返回：
  //   active   有没有在搜索（空查询 = 不搜，全部照原样显示）
  //   visible  可见 unit 的 id 列表（active=false 时为 null = 全显示）
  //   groups   可见的分组 id 列表（分组标题自己 + 它下面的行一起显示）
  //   sections 有命中的分区列表
  //   count    命中的行数（不含分组标题）
  //   empty    搜索了但一条都没命中
  // 规则：分组标题自己命中 → 该组全部行都显示；行命中 → 行显示、组标题跟着显示；
  //       一条都没命中 → empty=true（UI 显示「没有匹配的设置」）。
  function planSearch(query, units) {
    const list = Array.isArray(units) ? units : [];
    const needle = normalizeQuery(query);
    if (!needle) {
      return { active: false, visible: null, groups: null, sections: null, count: 0, empty: false };
    }
    const matchedRows = new Set();
    const matchedGroups = new Set();
    const sections = [];
    for (const unit of list) {
      if (!unit) continue;
      const hit = matchesQuery(needle, unit.text);
      if (unit.kind === 'group') {
        if (hit) matchedGroups.add(String(unit.groupId == null ? unit.id : unit.groupId));
      } else if (hit) {
        matchedRows.add(String(unit.id));
      }
    }
    const visible = [];
    const groups = [];
    let count = 0;
    for (const unit of list) {
      if (!unit) continue;
      if (unit.kind === 'group') {
        const groupId = String(unit.groupId == null ? unit.id : unit.groupId);
        const rowsHit = list.some((other) => other && other.kind !== 'group' && String(other.groupId) === groupId && matchedRows.has(String(other.id)));
        const show = matchedGroups.has(groupId) || rowsHit;
        if (show) {
          groups.push(groupId);
          visible.push(String(unit.id));
          if (unit.section && sections.indexOf(unit.section) < 0) sections.push(unit.section);
        }
        continue;
      }
      const groupId = String(unit.groupId == null ? '' : unit.groupId);
      const show = matchedGroups.has(groupId) || matchedRows.has(String(unit.id));
      if (show) {
        visible.push(String(unit.id));
        count += 1;
        if (unit.section && sections.indexOf(unit.section) < 0) sections.push(unit.section);
      }
    }
    return { active: true, visible, groups, sections, count, empty: count === 0 };
  }

  // 搜索框的状态播报（aria-live）：没在搜就不出声，命中报条数。
  // 空结果不在这里出声 —— UI 的空结果块自己带 role=status / aria-live，避免同一句话
  // 在工具栏和内容区各说一遍（1.4.0 P0-1 实测截图里重复得很明显）。
  function searchStatusText(plan) {
    if (!plan || !plan.active || plan.empty) return '';
    return `匹配 ${plan.count} 个设置项`;
  }

  return {
    TABS,
    TAB_IDS,
    DEFAULT_TAB,
    BOOK_TABS,
    CHROME_IDS,
    TAB_ID_PREFIX,
    SECTION_ID_PREFIX,
    FIELD_SECTION,
    DEEP_LINKS,
    isTabId,
    sectionForField,
    fieldsForSection,
    sectionsForScope,
    resolveTab,
    resolveDeepLink,
    normalizeQuery,
    matchesQuery,
    planSearch,
    searchStatusText
  };
});
