/* 渲染层装配清单（审计修复 #55 / M4）
 *
 * 背景：渲染层是 index.html 里一串手工排序的 <script>（数量以本文件的 MODULES 条目为准：
 * 当前 76 个模块 + 装配清单自身 + renderer.js = 78 个），模块之间靠 window.CW 全局名串起来。
 * 「加一个模块」要同时改 index.html 的 <script>、renderer.js 的 `const x = window.CW…`、
 * 测试里的静态闸门；漏一处时 Electron 里表现是「某个弹层点不开 / 一片按钮没反应」，只有
 * tests/load-order.test.js 会在 Node 里全链跑一遍才能发现。
 *
 * 这里把「顺序 + 全局名 + renderer.js 里的本地名」收成唯一一份清单：
 *   · index.html 的 <script> 装配块由 scripts/assembly-sync.js 从本清单生成 / 注入（M-N1）：
 *     新增模块只改本文件一行，跑 `node scripts/assembly-sync.js --write` 重新生成；
 *     `--check`（tests/wp17-refactor.test.js R9）与 scripts/wiring-check.js 的
 *     renderer-assembly-generated 契约会拦住「手改块内文本 / 块外再插脚本」；
 *   · renderer.js 启动时调用 assertInstalled(window)，一次报全所有缺失模块；
 *   · **顺序约束（RPAN-C07）**：模块之间只用 window.CW 全局名互相引用，被依赖的模块必须排在
 *     消费者之前。装载期是空安全解引用（依赖没加载只是传 undefined、不抛），所以顺序写反不会
 *     在 Node 闸门 / 启动时报错，只会在 Electron 里 create 时变成「xxx is not a function」——
 *     为此 scripts/wiring-check.js 的 renderer-dependency-order 契约按源码里的 root.CW… 解引用
 *     反推依赖并核对本清单的位次（例如 core/assert-host.js 必须先于全部 37 个消费者）。
 *   · tests/assembly-manifest.test.js 拿这份清单核对每个模块真的挂出了 window.CW 全局名、
 *     renderer.js 的每个引用都在清单内；
 *   · 新增「按域下沉」的模块时仍按现有模式：纯逻辑进 core/ 单测覆盖，面板进 renderer/*-ui.js，
 *     renderer.js 只接线。
 *
 * 结构：每项 [文件（相对 renderer/）, window 全局名, renderer.js 里的本地名或 '', 一句话职责]。
 * 本地名为 '' 的表示 renderer.js 只在安装 / 打开时按 window.CW 全局名直接取用（可选 UI 增强），
 * 不进入顶部常量表。renderer.js 自己与 test-hooks.js（?test=1 时动态加载）不在清单里。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWRendererAssembly = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MODULES = [
    ['../core/common.js', 'CWCommon', 'commonLib', '跨模块公共小工具（pad2 / clampInt / sleep / normalizeText…）'],
    ['../core/heading.js', 'CWHeading', '', '章节标题 / 编号词表（纯逻辑）'],
    ['../core/chapters.js', 'CWChapters', 'chaptersLib', '章节文件名 / 编号 / 清洗规则'],
    ['../core/bookinfo.js', 'CWBookInfo', 'bookInfoLib', '书籍信息（作者 / 简介 / 分组 / 标签）清洗与匹配'],
    ['../core/template.js', 'CWTemplate', 'templateLib', '章节模板占位符展开'],
    ['../core/s2t.js', 'CWS2T', 's2tLib', '导出简繁转换'],
    ['../core/caret-color.js', 'CWCaretColor', 'caretColorLib', '当前段落高亮颜色清洗'],
    ['../core/bookmarks.js', 'CWBookmarks', 'bookmarksLib', '查找书签的清洗 / 查找 / 增删'],
    ['../core/paragraphs.js', 'CWParagraphs', '', '段落切分（编辑器与导出共用）'],
    ['../core/capture.js', 'CWCapture', '', '剪贴板捕捉规则（纯逻辑）'],
    ['editor-logic.js', 'CWEditorLogic', 'editorLogic', '编辑器小件的纯逻辑'],
    ['chapter-filter-logic.js', 'CWChapterFilterLogic', 'chapterFilterLogic', '卷章目录筛选匹配'],
    ['chapter-selection.js', 'CWChapterSelection', 'chapterSelectionLib', '章节多选选择模型'],
    ['open-book-guard.js', 'CWOpenBookGuard', 'openBookGuard', '换书守卫的纯决策'],
    ['format-ui.js', 'CWFormatUi', 'formatUi', '整理本章面板'],
    ['find-logic.js', 'CWFindLogic', 'findLogic', '查找上一处 / 下一处 / 高亮窗口'],
    ['focus-logic.js', 'CWFocusLogic', 'focusLogic', '专注模式打字机滚动换算'],
    ['reading-logic.js', 'CWReadingLogic', 'readingLogic', '阅读模式档位 / 进度'],
    ['save-logic.js', 'CWSaveLogic', 'saveLogic', '保存提示文案与后台校验结论'],
    ['long-op-logic.js', 'CWLongOpLogic', 'longOpLogic', '长异步操作回执的收尾判定'],
    ['replace-one-guard.js', 'CWReplaceOneGuard', 'replaceOneGuard', '「替换这一处」回执的书 / 章 / 正文身份复核'],
    ['modal-queue.js', 'CWModalQueue', 'modalQueueModule', '询问框排队与防重入'],
    ['stale-guard.js', 'CWStaleGuard', 'staleGuard', '长 IPC 回执的世代令牌 / 身份快照'],
    ['ime-guard.js', 'CWImeGuard', 'imeGuard', '输入法组字守卫'],
    ['../core/assert-host.js', 'CWAssertHost', '', 'host 契约缺成员时显式报错'],
    ['font-logic.js', 'CWFontLogic', 'fontLogic', '自定义字体 base64 解码'],
    ['stats-logic.js', 'CWStatsLogic', 'statsLogic', '码字日历 / 统计数据换算'],
    ['focus-nav.js', 'CWFocusNav', '', '焦点可达性判定与聚焦助手（REDT-C-06 唯一实现）'],
    ['list-keyboard.js', 'CWListKeyboard', 'listKeyboard', '章节列表 / 书卡的键盘可达'],
    ['dialog-focus.js', 'CWDialogFocus', '', '弹层焦点圈定（启动时 install）'],
    ['menu-keyboard.js', 'CWMenuKeyboard', '', '菜单键盘导航（启动时 install）'],
    ['tts-ui.js', 'CWTtsUi', 'ttsUi', '朗读状态机 / 朗读条'],
    ['esc-registry.js', 'CWEscRegistry', 'escLib', '全局 Esc 链与关窗清理注册表'],
    ['backdrop-registry.js', 'CWBackdropRegistry', 'backdropRegistry', '遮罩层打开顺序注册表'],
    ['export-ui.js', 'CWExportUi', 'exportUiModule', '导出面板'],
    ['jump-ui.js', 'CWJumpUi', 'jumpUiModule', '跳章对话框'],
    ['stats-ui.js', 'CWStatsUi', 'statsUiModule', '码字日历 / 统计面板'],
    ['import-ui.js', 'CWImportUi', 'importUiModule', '导入小说面板'],
    ['drag-sort-ui.js', 'CWDragSortUi', 'dragSortUiModule', '章节 / 卷拖拽排序'],
    ['chapter-directory-ui.js', 'CWChapterDirectoryUi', 'chapterDirectoryUiModule', '章节列表 / 卷章目录显示层（筛选 / 卷头 / 条目 / 多选标记 / 整表重建）'],
    ['shelf-ui.js', 'CWShelfUi', 'shelfUiModule', '书架书卡与书架操作'],
    ['statusbar-ui.js', 'CWStatusbarUi', 'statusbarUiModule', '状态栏'],
    ['save-status-ui.js', 'CWSaveStatusUi', 'saveStatusUiModule', '保存状态提示'],
    ['save-rescue-ui.js', 'CWSaveRescueUi', 'saveRescueUiModule', '保存阻断的三选救稿出口'],
    ['save-chain-ui.js', 'CWSaveChainUi', 'saveChainUiModule', '保存链（载章 / 保存 / 关窗拦截）'],
    ['shelf-view-ui.js', 'CWShelfViewUi', 'shelfViewUiModule', '书架视图（刷新编排 / 显示设置 / 网格列数 / 搜索事件）'],
    ['chapter-ops-ui.js', 'CWChapterOpsUi', 'chapterOpsUiModule', '章节模板 / 分卷 / 批量动作（新建 / 改名 / 删除 / 撤销）'],
    ['config-change-ui.js', 'CWConfigChangeUi', 'configChangeUiModule', '换书架根后的孤岛提示 / 救稿出口'],
    ['crash-recovery-ui.js', 'CWCrashRecoveryUi', 'crashRecoveryUiModule', '崩溃草稿周期上报 / 启动恢复提示'],
    ['shelf-filter-ui.js', 'CWShelfFilterUi', 'shelfFilterUiModule', '书架筛选'],
    ['shelf-search-ui.js', 'CWShelfSearchUi', 'shelfSearchUiModule', '书架正文搜索'],
    ['shelf-nav-ui.js', 'CWShelfNavUi', 'shelfNavUiModule', '书架顶部入口'],
    ['focus-mode-ui.js', 'CWFocusModeUi', 'focusModeUiModule', '专注 / 极简模式'],
    ['write-timer-ui.js', 'CWWriteTimerUi', 'writeTimerUiModule', '写作计时'],
    ['fragments-ui.js', 'CWFragmentsUi', 'fragmentsUiModule', '灵感箱 / 碎片速记'],
    ['find-bookmark-ui.js', 'CWFindBookmarkUi', 'findBookmarkUiModule', '查找书签面板'],
    ['find-ui.js', 'CWFindUi', 'findUiModule', '查找替换面板'],
    ['replace-one-ui.js', 'CWReplaceOneUi', 'replaceOneUiModule', '「替换这一处」入口：身份快照 / 两次回执复核 / 兜底快照（M1 第 11 轮从编排器搬出）'],
    ['tidy-card-ui.js', 'CWTidyCardUi', 'tidyCardUiModule', '整理悬浮卡 / 显示菜单'],
    ['format-book-ui.js', 'CWFormatBookUi', 'formatBookUiModule', '一键整理本书的编排：预检查 / 长操作锁 / 收尾分流 / 撤销（M1 第 11 轮从编排器搬出）'],
    ['settings-ia.js', 'CWSettingsIa', 'settingsIaModule', '设置面板的分区 / 搜索 / 深链'],
    ['settings-ui.js', 'CWSettingsUi', 'settingsUiModule', '设置弹层与数据台账'],
    ['bookinfo-ui.js', 'CWBookinfoUi', 'bookinfoUiModule', '书籍信息弹层 / 书架渲染'],
    ['result-jump-ui.js', 'CWResultJumpUi', '', '查找结果跳转（面板内直接用）'],
    ['sensitive-ui.js', 'CWSensitiveUi', 'sensitiveUiModule', '敏感词预检面板'],
    ['proofread-ui.js', 'CWProofreadUi', 'proofreadUiModule', '校对面板'],
    ['editor-marks-ui.js', 'CWEditorMarksUi', 'editorMarksUiModule', '标记层 / 超长段落 / 段落导航'],
    ['reading-ui.js', 'CWReadingUi', 'readingUiModule', '阅读模式'],
    ['backup-guard.js', 'CWBackupGuard', 'backupGuardModule', '备份占用提醒'],
    ['history-ui.js', 'CWHistoryUi', 'historyUiModule', '本书历史面板'],
    ['capture-ui.js', 'CWCaptureUi', 'captureUiModule', '剪贴板捕获面板'],
    ['window-chrome-ui.js', 'CWWindowChromeUi', '', '自绘窗口按钮（启动时安装）'],
    ['undo-action.js', 'CWUndoAction', 'undoActionModule', '撤销动作槽（一次性快照）'],
    ['undo-ui.js', 'CWUndoUi', 'undoUiModule', '撤销条界面'],
    ['toast-ui.js', 'CWToastUi', 'toastUiModule', '提示条出口（toast / 可点提示，M1 第 9 轮从编排器搬出）'],
    ['command-catalog.js', 'CWCommandCatalog', 'commandCatalog', '命令面板条目目录'],
    ['command-registry.js', 'CWCommandRegistry', 'commandRegistryModule', '命令注册 / 最近使用'],
    ['command-palette-ui.js', 'CWCommandPaletteUi', 'commandPaletteModule', '命令面板界面'],
    ['command-items-ui.js', 'CWCommandItemsUi', 'commandItemsUiModule', '命令面板条目表与数据版本缓存（M1 第 10 轮从编排器搬出）'],
    ['shortcuts-ui.js', 'CWShortcutsUi', 'shortcutsUiModule', '快捷键提示面板']
  ];

  // 取一份「清单驱动的模块表」：全部必需（index.html 无条件加载）；缺一个就把所有缺的名字
  // 一次列出来，而不是让 renderer.js 里某个 const 静默变成 undefined。
  function collect(windowRef) {
    const win = windowRef && typeof windowRef === 'object' ? windowRef : {};
    const missing = [];
    const modules = {};
    for (const entry of MODULES) {
      const value = win[entry[1]];
      if (value == null) missing.push(entry[1]);
      else if (entry[2]) modules[entry[2]] = value;
    }
    if (missing.length) {
      const err = new TypeError(
        `渲染层装配缺少模块：${missing.join('、')}（检查 index.html 的 <script> 顺序 / 是否漏文件）`
      );
      err.code = 'RENDERER_MODULE_MISSING';
      err.missing = missing;
      throw err;
    }
    return modules;
  }

  function assertInstalled(windowRef) {
    collect(windowRef);
    return MODULES.length;
  }

  return { MODULES, collect, assertInstalled };
});