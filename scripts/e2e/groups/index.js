// E2E 场景的组索引（v0.9 B-7 起；2026-11-04 窗口把第 0–51 组也搬进来，现在 0–75 全部在本目录）。
//
// 以前所有组都挤在 scripts/e2e-scenario.js 那一个函数里（1.2 万行），改一组要在大函数里
// 上下翻。现在按组拆到本目录：**只拆文件、不改断言**，顺序等于原文件里的执行顺序。
//
// 加一组：在本目录新建 `NN-名字.js`（NN = 原场景里的组号），导出 async (t) => {...}，
// 再在下面的数组里按组号插进去（数组顺序 = 执行顺序）；断言口径与 e2e-scenario.js 保持一致。
//
// 为什么每项带 id：拆出来的组不一定都落在场景的同一个位置。第 52 组在原场景第 52 组的位置跑，
// 60 起的那批在原来 60–62 的循环位置跑（后面才是第 55 多窗口组）——顺序必须与原文件一致，
// 否则 FAIL 时不好对照场景。所以场景里用 runGroups(t, [52]) / runGroups(t, idsFrom(60))
// 明确指定「在哪一段跑哪几组」，索引本身只负责登记与组号排序。
const groups = [
  // 第 0–51 组：2026-11-04 窗口从 e2e-scenario.js 整段搬出来（只搬文件、不改断言），
  // 场景里按「原位」一组一次 runGroups(groupContext(), [N]) 调用。
  { id: 0, run: require('./00-version-and-ipc-guard') },
  { id: 1, run: require('./01-new-book') },
  { id: 2, run: require('./02-chapter-numbering') },
  { id: 3, run: require('./03-save-book') },
  { id: 4, run: require('./04-insert-chapter') },
  { id: 5, run: require('./05-switch-discard') },
  { id: 6, run: require('./06-switch-save') },
  { id: 7, run: require('./07-rename-chapter') },
  { id: 8, run: require('./08-delete-chapter') },
  { id: 9, run: require('./09-copy-book') },
  { id: 10, run: require('./10-close-guard-cancel') },
  { id: 11, run: require('./11-close-guard-save') },
  { id: 12, run: require('./12-close-clean') },
  { id: 13, run: require('./13-reload-window') },
  { id: 14, run: require('./14-external-change') },
  { id: 15, run: require('./15-repair-meta') },
  { id: 16, run: require('./16-import-folder') },
  { id: 17, run: require('./17-delete-book') },
  { id: 18, run: require('./18-import-collection') },
  { id: 19, run: require('./19-import-raw') },
  { id: 20, run: require('./20-import-chapters') },
  { id: 21, run: require('./21-sidebar-splitter') },
  { id: 22, run: require('./22-format-chapter') },
  { id: 23, run: require('./23-display-format') },
  { id: 24, run: require('./24-review-fixes') },
  { id: 25, run: require('./25-smart-format') },
  { id: 26, run: require('./26-display-options') },
  { id: 27, run: require('./27-drag-sort') },
  { id: 28, run: require('./28-find-replace') },
  { id: 29, run: require('./29-replace-one') },
  { id: 30, run: require('./30-replace-backup') },
  { id: 31, run: require('./31-undo-format') },
  { id: 32, run: require('./32-punct-extend') },
  { id: 33, run: require('./33-shelf-search') },
  { id: 34, run: require('./34-per-book-display') },
  { id: 35, run: require('./35-auto-save') },
  { id: 36, run: require('./36-format-book') },
  { id: 37, run: require('./37-chapter-status') },
  { id: 38, run: require('./38-copy-chapter') },
  { id: 39, run: require('./39-range-export') },
  { id: 40, run: require('./40-continue-writing') },
  { id: 41, run: require('./41-schema-conflict') },
  { id: 42, run: require('./42-book-history') },
  { id: 43, run: require('./43-daily-snapshot') },
  { id: 44, run: require('./44-stats-goal') },
  { id: 45, run: require('./45-export-epub') },
  { id: 46, run: require('./46-proofread') },
  { id: 47, run: require('./47-fragments') },
  { id: 48, run: require('./48-sensitive-words') },
  { id: 49, run: require('./49-tts') },
  { id: 50, run: require('./50-editor-widgets') },
  { id: 51, run: require('./51-focus-mode') },
  { id: 52, run: require('./52-crash-logs') },
  { id: 53, run: require('./53-search-index') },
  { id: 54, run: require('./54-check-update') },
  { id: 55, run: require('./55-multiwindow') },
  { id: 56, run: require('./56-security-switches') },
  { id: 57, run: require('./57-ipc-paths') },
  { id: 58, run: require('./58-config-gate') },
  { id: 59, run: require('./59-import-export') },
  { id: 60, run: require('./60-log-redaction') },
  { id: 61, run: require('./61-ipc-limits') },
  { id: 62, run: require('./62-common-tools') },
  { id: 63, run: require('./63-chapter-list-perf') },
  { id: 64, run: require('./64-data-safety') },
  { id: 65, run: require('./65-marks-lazy-spans') },
  { id: 66, run: require('./66-destructive-recovery') },
  { id: 67, run: require('./67-contrast-a11y') },
  { id: 68, run: require('./68-dialog-focus') },
  { id: 69, run: require('./69-motion') },
  { id: 70, run: require('./70-a11y-keyboard') },
  { id: 71, run: require('./71-menu-keyboard') },
  // 剪贴板捕获（P0，2026-11-04 窗口新增功能）：排在组尾；idsFrom(60) 会自动带上它。
  { id: 72, run: require('./72-capture') },
  // 设置面板信息架构（1.4.0 P0-1，2026-11-09）：顶部搜索 / 5 个分区 / 深链；idsFrom(60) 自动带上。
  { id: 73, run: require('./73-settings-ia') },
  // 撤销优先（1.4.0 P0-2，2026-11-09）：删除章节直接执行 + 10 秒撤销；idsFrom(60) 自动带上。
  { id: 74, run: require('./74-undo') },
  // 命令面板（1.4.0 P0-3，2026-11-09）：Ctrl+K / 混排 / 键盘 / 锁键；idsFrom(60) 自动带上。
  { id: 75, run: require('./75-command-palette') }
];

// 按给定组号依次跑（组号 → 组文件；顺序就是参数顺序，调用点决定「在哪一段」）。
async function runGroups(t, ids) {
  for (const id of ids) {
    const entry = groups.find((group) => group.id === id);
    if (!entry) throw new Error(`E2E 组索引里没有第 ${id} 组`);
    await entry.run(t);
  }
}

// 从某一组号起的所有组（给「场景尾部那一批」用：idsFrom(60) = 60 → 72）。
const idsFrom = (from) => groups.filter((group) => group.id >= from).map((group) => group.id);

module.exports = { groups, runGroups, idsFrom };
