/* 章回 —— 渲染层（版本号见 package.json，界面底部显示主进程回报的值）
 * 规则：这里的任何东西都不能直接访问文件系统；所有读写都通过 window.api（白名单 IPC）。
 * 保存策略：完全手动。只有按 Ctrl+S / 点保存才写正文；切章、关窗、导出前只提醒，不偷偷写。
 */
(() => {
  'use strict';

  const api = window.api;
  const $ = (id) => document.getElementById(id);
  const editorEl = $('editor');
  // WP-03：编辑区遮罩解除时把占位提示恢复成 index.html 里那句（只读一次，避免两处文案漂移）
  const DEFAULT_EDITOR_PLACEHOLDER = editorEl.getAttribute('placeholder') || '';
  // 章节标题 / 编号 / 文件名净化 / 分卷等纯逻辑，core/chapters.js 里、Node 单测覆盖；
  // UMD 加载后挂成 window.CWChapters，渲染层不再自己复制一套「第N章：」规则
  // （v0.8.6 R3，代码审计 F6：以前界面不认书目里的 titleTemplate，和导出 / 复制不一致）。
  // 跨模块公共小工具（pad2 / clampInt / sleep），core/common.js 里、Node 与渲染层共用，
  // index.html 里排在最前面（v0.9 B-3：不再各模块各抄一份）。
  const commonLib = window.CWCommon;
  const chaptersLib = window.CWChapters;
  // 编辑器小件的纯逻辑（选中字数 / 段落导航 / 超长段落 / 不可见字符 / 章节字数对比），
  // 在 editor-logic.js 里、Node 单测覆盖；这里只负责显示和事件。
  const editorLogic = window.CWEditorLogic;
  // 卷章目录筛选的纯逻辑（2026-11-10 目录重设计）：标题 / 章名 / 章号的多词匹配，
  // 在 chapter-filter-logic.js 里、Node 单测覆盖；这里只负责把结果画进目录。
  const chapterFilterLogic = window.CWChapterFilterLogic;
  // 章节多选的选择模型（1.5.0 功能-1）：toggle / extendTo / clear / isSelected / prune / idsInOrder
  // 在 chapter-selection.js 里、Node 单测覆盖；这里只接线（状态放 state.selectedIds / selectAnchorId）。
  const chapterSelectionLib = window.CWChapterSelection;
  // 换书守卫的决策（1.6.0 H1 / 审计 E-01）：换到另一本书之前先处理未保存的修改。
  // 三种选择 × 保存成败的纯分支在 open-book-guard.js 里、Node 单测覆盖；这里只负责弹窗与保存。
  const openBookGuard = window.CWOpenBookGuard;
  // 查找增强（v0.8-11，提案 N11）的纯逻辑：上一处 / 下一处、高亮窗口、正文切片段、行号。
  // 在 find-logic.js 里、Node 单测覆盖；这里只负责选中、滚动和影子层显示。
  const findLogic = window.CWFindLogic;
  // 查找书签（v0.8-11b，提案 N11b）的纯逻辑：按「书 + 章」清洗 / 查找 / 增删书签。
  // 在 core/bookmarks.js 里、Node 单测覆盖；这里只负责面板列表、存 / 删 / 跳与自动高亮。
  const bookmarksLib = window.CWBookmarks;
  // 专注模式的纯逻辑（打字机滚动的换算），在 focus-logic.js 里、Node 单测覆盖
  const focusLogic = window.CWFocusLogic;
  // 阅读模式的纯逻辑（字号 / 行距档位、进度、当前章、接近底部、上一章 / 下一章），
  // 在 reading-logic.js 里、Node 单测覆盖；阅读模式本身只读，不写盘。
  const readingLogic = window.CWReadingLogic;
  // 书籍信息（作者 / 简介 / 分组 / 标签）的清洗与匹配，core/bookinfo.js 里、Node 单测覆盖
  const bookInfoLib = window.CWBookInfo;
  // 章节模板的清洗与占位符展开，core/template.js 里、Node 单测覆盖
  const templateLib = window.CWTemplate;
  // 导出简繁转换（v0.8 P0 N7）：core/s2t.js 里、Node 单测覆盖；只用于显示的档位文案
  const s2tLib = window.CWS2T;
  // 当前段落高亮的颜色（v0.8-10b，提案 N10b）：core/caret-color.js 里、Node 单测覆盖。
  // 只负责把配置里的 #rrggbb 换成 CSS 的 rgba，并做清洗；不写盘、不碰正文。
  const caretColorLib = window.CWCaretColor;
  // 保存热路径（代码审计 F2）：保存提示文案 + 后台全书校验的结论，save-logic.js 里、
  // Node 单测覆盖；这里只负责「先出提示、后台再校验」的时序。
  const saveLogic = window.CWSaveLogic;
  // 长异步操作（整本整理 / 还原备份 / 从磁盘重载）的收尾判定（v1.8.0 WP-02 / 审计 C2）：
  // 回执到达时「书换没换 / 期间有没有新输入」在 long-op-logic.js 里、Node 单测覆盖；
  // 这里只按结论决定「重载 / 保留编辑区 / 什么都不动」。
  const longOpLogic = window.CWLongOpLogic;
  // 「替换这一处」回执的书 / 章 / 正文身份复核（v1.8.2 WP3 / 审计 E-N4）：回执迟到（切章 / 换书 /
  // 改正文）就整段作废，旧章下标绝不套到眼前的正文上；判定在 replace-one-guard.js 里、Node 单测覆盖。
  const replaceOneGuard = window.CWReplaceOneGuard;
  // 输入法组字守卫（v1.8.0 WP-04 / 审计 C3、C8、V112）：isComposing 之外再认 keyCode 229（防御性
  // 加固），纯函数在 ime-guard.js 里、Node 单测覆盖；这里只把判定铺到本文件的各个提交键。
  const imeGuard = window.CWImeGuard;
  // 通用询问框的排队与防重入（v1.8.0 WP-13 / 审计 C11）：同一时刻只画一个框、后来者排队，
  // 并发调用者的 Promise 绝不悬空；状态机在 modal-queue.js 里、Node 单测覆盖，这里只负责画与收。
  const modalQueueModule = window.CWModalQueue;
  // 长 IPC 回执的世代令牌 + 章身份快照（v1.8.0 WP-15 / 审计 C15/C16/C36/C37/C40/V111/V202）：
  // 纯判定在 stale-guard.js 里、Node 单测覆盖；各面板的 host 各拿一份，回来先验身份再落地。
  const staleGuard = window.CWStaleGuard;
  // 自定义字体的 base64 解码（代码审计 F11）：font-logic.js 里、Node 单测覆盖；
  // 优先浏览器原生 data: URL 解码，失败才回退 atob 循环。
  const fontLogic = window.CWFontLogic;
  // 码字日历的纯逻辑（v0.9 B-6，代码精简 B6）：月份游标 / 翻月边界 / 网格计划 / 汇总文案都在
  // stats-logic.js 里、Node 单测覆盖；这里只负责建 DOM。字数 / 时长格式化由本文件传进去
  // （statsFormat），日历与书架用的是同一套口径。
  const statsLogic = window.CWStatsLogic;
  // 键盘可达（v0.9 A-5b）：章节列表 / 书架书卡的 roving tabindex + Enter / 空格 / 方向键，
  // 纯逻辑在 list-keyboard.js 里、Node 单测覆盖；这里只接线（不碰鼠标行为）。
  const listKeyboard = window.CWListKeyboard;
  // 朗读（v0.9 B-6）：播放状态机 / 朗读条 / 语音列表整段在 tts-ui.js 里、Node 单测覆盖；
  const ttsUi = window.CWTtsUi;
  // 全局 Esc 链 + 关窗清理的**有序注册表**（v0.9 B-4 / 审计 F6）：层顺序与「谁参与关窗清理」在
  // esc-registry.js 里、Node 单测覆盖；这里只做探针（现在谁开着）和动作表（动作 id → 关闭函数）。
  const escLib = window.CWEscRegistry;
  // 弹层清单的唯一事实源（1.8.0 WP-17 / 审计 C35）：17 个 backdrop 在 backdrop-registry.js 里、
  // Node 单测覆盖；escProbe 的 backdrop 字段与 anyBackdropOpen 都从它取，别再往本文件抄 id 清单。
  const backdropRegistry = window.CWBackdropRegistry;
  // 导出 / 复制（v0.9 B-5 第一刀）：导出范围对话框 + TXT / EPUB / DOCX 三种导出流程 +
  // 复制整本 / 复制本章，整段在 export-ui.js 里；这里只接线（外加「当前导出格式」活绑定）。
  const exportUiModule = window.CWExportUi;
  // Ctrl+G 跳章（v0.9 B-5 第二刀）：对话框 / 结果列表 / 「跳过去」整段在 jump-ui.js 里；
  const jumpUiModule = window.CWJumpUi;
  // 每日字数统计 / 码字日历（v0.9 B-5 第三刀）：今日字数 / 目标 / 近 30 天柱状图 / 码字日历
  // 两个相邻分区在 stats-ui.js 里；这里只接线（入口按名字被视图切换 / 设置 / 事件绑定 / 测试钩子取用）。
  const statsUiModule = window.CWStatsUi;
  // 导入 / 删除小说（v0.9 B-5 第四刀）：导入方式询问 / 导入进度 / 删除书在 import-ui.js 里；
  const importUiModule = window.CWImportUi;
  // 章节列表 / 卷章目录显示层（WP17 A3 第一刀，审计 #20）：筛选 / 卷头 / 条目 / 多选标记 /
  // 整表重建整段在 chapter-directory-ui.js 里；这里只接线（入口按原名被事件绑定 / 测试钩子取用）。
  const chapterDirectoryUiModule = window.CWChapterDirectoryUi;
  // 章节拖拽排序（v0.9 B-5 第五刀）：pointer 拖拽 / 落点计算 / 两条写盘路径在
  // drag-sort-ui.js 里；这里只接线（入口按名字被章节列表 / 事件绑定 / 测试钩子取用）。
  const dragSortUiModule = window.CWDragSortUi;
  // 书架交互（v0.9 B-5 第六刀）：继续写作卡 / 冲突副本对话框 / 切章三个小分区在 shelf-ui.js 里；
  const shelfUiModule = window.CWShelfUi;
  // 状态栏 + 外部修改检测（v0.9 B-5 第七刀）：本章字数 / 选中字数 / 窗口失焦后的外部修改检测
  // 两段在 statusbar-ui.js 里；这里只接线（入口按名字被章节列表 / 写作时长 / 编辑器小件 / 测试钩子取用）。
  const statusbarUiModule = window.CWStatusbarUi;
  // 保存态（1.3.0 T7 = 规范 C-05 / I-01）：状态栏四态渲染 / 成功 2s 淡化 / 失败点重试
  // 在 save-status-ui.js 里；这里只接线（文案仍由 updateStatus 的调用点驱动，见下）。
  const saveStatusUiModule = window.CWSaveStatusUi;
  // 保存失败的两个救稿出口（审计修复 #5 V301 / #6 V302）：外部改动三选 / 书章文件没了给另存 + 复制。
  // 对话框与动作编排都在 save-rescue-ui.js 里；这里只装配（正文取编辑区现值、写盘仍走 saveCurrent）。
  const saveRescueUiModule = window.CWSaveRescueUi;
  // 保存链（WP17 A3 第二刀）：载章 / 保存 / 关窗 / 只读态与遮罩整段在 save-chain-ui.js 里；
  // 这里只接线（同名包装 + 装配，入口按原名被事件绑定 / 测试钩子取用）。
  const saveChainUiModule = window.CWSaveChainUi;
  // 换书架根的跨窗口提示（WP6 / 审计 N2）：路径判定 / 一次性去重 / 提示编排在 config-change-ui.js；
  // 这里只接线（孤岛书的救稿复用 saveRescueUi，回书架复用 backToShelf）。
  const configChangeUiModule = window.CWConfigChangeUi;
  // 崩溃恢复（WP5 / 审计 N1）：周期上报未保存正文（默认关）+ 启动 / 重载后的恢复提示都在
  // crash-recovery-ui.js；这里只接线（正文取编辑区、开书 / 载章复用既有入口）。
  const crashRecoveryUiModule = window.CWCrashRecoveryUi;
  // 装配在 bindEvents 里；saveCurrent 成功后要用它删掉「这一章已保存」的旧草稿。
  let crashRecoveryUi = null;
  // 撤销层（1.4.0 P0-2：撤销优先）：单槽 + 10s TTL + Ctrl+Z 焦点保护纯逻辑在 undo-action.js，
  // 全局撤销条 DOM / 定时器在 undo-ui.js；这里只接线（删除章节等动作直接执行后登记撤销）。
  const undoActionModule = window.CWUndoAction;
  const undoUiModule = window.CWUndoUi;
  // 撤销前的备份核对（1.5.0 P0-5 / 审计 V-2）：整本替换备份还原 / 历史还原 / 整本整理的撤销，
  // 登记时用 api.listHistory 记一份指纹（目录名 + 文件数 + 最大 mtime），撤销前再核一次；
  // 纯逻辑与「读不到清单怎么办」的口径都在 backup-guard.js 里，这里只装配与接线。
  const backupGuardModule = window.CWBackupGuard;
  // 命令面板（1.4.0 P0-3 / 规范 I-03）：检索与排序纯逻辑在 command-registry.js，
  // 面板 DOM / 键盘在 command-palette-ui.js；这里只给条目表与执行入口。
  const commandRegistryModule = window.CWCommandRegistry;
  // 命令目录（1.6.0 F4a）：命令表的数据只有 command-catalog.js 一份，渲染层只装配（见 commandDefs）。
  const commandCatalog = window.CWCommandCatalog;
  const commandPaletteModule = window.CWCommandPaletteUi;
  // 书架正文搜索（v0.9 B-5 第八刀）：防抖调度 / 主进程查询 / 索引状态 / 打开命中在 shelf-search-ui.js 里；
  const shelfSearchUiModule = window.CWShelfSearchUi;
  // 书架搜索（v0.9 B-5 第九刀）：内存过滤 / 分组筛选 / 正文结果区渲染在 shelf-filter-ui.js 里；
  const shelfFilterUiModule = window.CWShelfFilterUi;
  // 书架视图（WP17 A3 第三刀）：刷新编排 / 显示设置套用 / 网格列数 / 书架搜索事件整段在
  // shelf-view-ui.js 里；这里只接线（同名包装 + 装配，入口按原名被事件绑定 / 测试钩子取用）。
  const shelfViewUiModule = window.CWShelfViewUi;
  // 章节模板 / 分卷 / 批量动作（WP17 A3 第四刀）：22 个函数式单元整段在 chapter-ops-ui.js 里；
  // 这里只接线（同名包装 + 装配，入口按原名被事件绑定 / 右键菜单 / 命令面板 / 测试钩子取用）。
  const chapterOpsUiModule = window.CWChapterOpsUi;
  // 返回书架 + 改名（v0.9 B-5 第十刀）：未保存拦截 / 清空当前书 / 切回全局显示设置、书改名
  // 两个相邻小分区在 shelf-nav-ui.js 里；这里只接线（入口按名字被事件绑定 / 测试钩子取用）。
  const shelfNavUiModule = window.CWShelfNavUi;
  // 剪贴板捕获（P0 功能重放；2026-11-07 列表视图改造）：单列表面板 / 正文插入 / 章节新建整段在
  // capture-ui.js 里（WIP f9fc403 的 410 行不写回本文件）；这里只接线（入口按名字被事件绑定 /
  // Esc 动作表 / 测试钩子取用），外加 host.insertIntoBody（「正文」按钮要动编辑区，只能用本文件的闭包）。
  const captureUiModule = window.CWCaptureUi;
  // 本书历史（第 4 步九刀·第一刀）：历史面板整段在 history-ui.js 里；这里只接线
  const historyUiModule = window.CWHistoryUi;
  // 阅读模式（第 4 步九刀·第二刀）：整本只读通读整段在 reading-ui.js 里；这里只接线
  const readingUiModule = window.CWReadingUi;
  // 编辑器小件（第 4 步九刀·第三刀）：标记层 / 超长段落 / 段落导航 / 高亮色板整段在 editor-marks-ui.js 里；
  const editorMarksUiModule = window.CWEditorMarksUi;
  // 日历 / 统计文案用的格式化口径：就是本文件的 formatChars / formatDuration（函数声明会提升，
  // 放在调用之前没问题）。stats-logic.js 自己不复制第二套格式，调用时把这对函数传进去。
  const statsFormat = { formatChars, formatDuration };
  // 校对（第 4 步九刀·第四刀）：规则摘要 / 结果列表 / 跳转 / 跑校对 / 选词表整段在 proofread-ui.js 里；
  const proofreadUiModule = window.CWProofreadUi;
  // 敏感词预检（第 4 步九刀·第五刀）：面板 / 摘要 / 结果 / 跳转 / 选词表整段在 sensitive-ui.js 里；
  const sensitiveUiModule = window.CWSensitiveUi;
  // 书籍信息（第 4 步九刀·第六刀）：书籍信息弹层 + 书架渲染 + 新建书整段在 bookinfo-ui.js 里；
  const bookinfoUiModule = window.CWBookinfoUi;
  // 设置（第 4 步九刀·第七刀）：设置弹层 + 数据台账整段在 settings-ui.js 里；这里只接线
  const settingsUiModule = window.CWSettingsUi;
  // 设置面板信息架构（1.4.0 P0-1）：5 个分区 / 顶部搜索 / 深链的纯逻辑在 settings-ia.js 里
  const settingsIaModule = window.CWSettingsIa;
  // 书架正文搜索的调度 / 分页口径：输入停顿多久后才查（避免每敲一个字都查一次）、
  // 正文最少 2 个字、一页 8 条、最多 40 条结果（与 shelf-search-ui 的入参含义一一对应）。
  const CONTENT_SEARCH_DEBOUNCE = 320;
  const CONTENT_SEARCH_MIN_CHARS = 2;
  const CONTENT_PAGE_SIZE = 8;
  const CONTENT_RESULT_LIMIT = 40;
  // 整理悬浮卡 + 显示菜单（第 4 步九刀·第八刀）：整段在 tidy-card-ui.js 里；这里只接线
  const tidyCardUiModule = window.CWTidyCardUi;
  // 查找 / 替换核心（第 4 步九刀·补刀 9a）：查找会话 + 查找替换面板整段在 find-ui.js 里；这里只接线
  const findUiModule = window.CWFindUi;
  // 查找书签（第 4 步九刀·补刀 9b）：「书签」面板整段在 find-bookmark-ui.js 里；这里只接线
  const findBookmarkUiModule = window.CWFindBookmarkUi;
  // 灵感箱 / 碎片速记（第 4 步九刀·补刀 10）：两个弹层整段在 fragments-ui.js 里；这里只接线
  const fragmentsUiModule = window.CWFragmentsUi;
  // 写作时长（第 4 步九刀·补刀 11）：状态栏秒表整段在 write-timer-ui.js 里；这里只接线
  const writeTimerUiModule = window.CWWriteTimerUi;
  // 专注模式（第 4 步九刀·补刀 12）：专注 / 极简退出条 / 打字机整段在 focus-mode-ui.js 里；这里只接线
  const focusModeUiModule = window.CWFocusModeUi;
  // 审计修复 #55（M4）：装配清单化。模块顺序 / 全局名 / 本地名清单在 renderer/assembly-manifest.js，
  // 启动时一次报全缺失模块（以前哪个 window.CW 全局名没加载，对应 const 静默 undefined，报错点离原因很远）。
  // 审计残留修复 #R12（#55/M4）：清单自身漏加载时也报同一种聚合错。旧实现直接
  // window.CWRendererAssembly.assertInstalled(window) —— 清单文件没加载时抛的是原生 TypeError
  //（Cannot read properties of undefined），既没有错误码、也看不出缺的是什么。
  if (!window.CWRendererAssembly || typeof window.CWRendererAssembly.assertInstalled !== 'function') {
    const missingAssembly = new TypeError(
      '渲染层装配缺少模块：CWRendererAssembly（检查 index.html 的 <script> 顺序 / 是否漏 assembly-manifest.js）'
    );
    missingAssembly.code = 'RENDERER_MODULE_MISSING';
    missingAssembly.missing = ['CWRendererAssembly'];
    throw missingAssembly;
  }
  window.CWRendererAssembly.assertInstalled(window);
  // 写作计时（v0.8-2）：每 30 秒把整秒上报一次；不足 1 秒的零头留在内存里下次一起算。
  const WRITE_TIMER_FLUSH_MS = 30000;

  // ---------- 小工具 ----------
  const pad2 = commonLib.pad2;
  // 千分位（拍板 #1）：全应用字数显示统一走 core/common.js 的这一份，模块里不再各写一套
  const formatCount = commonLib.formatCount;

  function formatClock(date) {
    if (!date) return '';
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  }

  function formatRelativeTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfThatDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const dayDiff = Math.round((startOfToday - startOfThatDay) / 86400000);
    if (dayDiff === 0) return `今天 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    if (dayDiff === 1) return `昨天 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    if (dayDiff > 1 && dayDiff < 7) return `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  // 「万字 / 亿字」缩写的整数部分同样分组（1234.57 万字 → 1,234.57 万字），
  // 否则同一个界面里「1,234 字」和「1234.57 万字」两种口径并存（拍板 #1）。
  function formatScaledCount(scaled) {
    const [int, dec] = scaled.toFixed(2).split('.');
    return `${formatCount(int)}.${dec}`;
  }

  function formatChars(n) {
    const value = Math.max(0, Math.floor(Number(n) || 0));
    if (value < 10000) return `${formatCount(value)} 字`;
    if (value < 100000000) return `${formatScaledCount(value / 10000)} 万字`;
    return `${formatScaledCount(value / 100000000)} 亿字`;
  }

  function formatBytes(n) {
    const value = Math.max(0, Number(n) || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  // 写作时长显示（纯格式换算在 editor-logic.js，Node 单测覆盖；这里只做转发）
  function formatDuration(n) {
    return editorLogic.formatDuration(n);
  }

  function formatStopwatch(n) {
    return editorLogic.formatStopwatch(n);
  }

  // 字数口径唯一实现是 core/chapters.js 的 countChars（去掉所有空白后的字符数）；渲染层不再留本地副本，
  // 调用点直接用 chaptersLib.countChars（v0.9 B-2 / 审计 F1：以前 core 与渲染层各抄一份会漂移）。

  // 章节标题显示名：全部交给 core/chapters.js 的 formatTitle（原文自带标题原样显示、
  // 空名回退「第N章」、书目里的自定义 titleTemplate 也生效）。这里只做薄封装，
  // 不再本地复制 RAW_TITLE_RE / 「第N章：」规则——以前注释说「与 core 一致」其实是两套。
  function chapterTitle(index, name) {
    return chaptersLib.formatTitle(state.meta, index, name);
  }

  // 章节列表是「序号格 + 章名格」两段：能按 formatTitle 的结果拆出章名就拆（默认模板
  // 「第N章：名字」），拆不出来（原文自带标题 / 空名 / 模板不含 {name}）就整段放进章名格。
  // 两格拼起来必须与标题栏一字不差；空名章和 core 一样只显示「第N章」，不再补「未命名」。
  function chapterListLabel(index, name) {
    const title = chapterTitle(index, name);
    const clean = String(name == null ? '' : name).trim();
    if (clean && title.length > clean.length && title.endsWith(clean)) {
      return { num: title.slice(0, title.length - clean.length), name: clean };
    }
    return { num: '', name: title };
  }

  // 章节状态 / 备注：清洗规则只有 core/chapters.js 一份，这里只做薄封装（常量也从 core 拿）。
  // v0.9 B-5：以前这里抄了一份近似实现、注释却写着「与 core 保持一致」，实际少了「换行收成空格」
  // 这一步——直接手改 书目.json 写进带换行的备注时，界面显示会和导出 / 复制口径不同。
  // 只存在 书目.json 里，不动正文。
  const CHAPTER_STATUS_LABELS = chaptersLib.CHAPTER_STATUS_LABELS;

  function chapterStatus(chapter) {
    return chaptersLib.chapterStatus(chapter);
  }

  function chapterNote(chapter) {
    return chaptersLib.chapterNote(chapter);
  }

  class ApiError extends Error {
    constructor(message, code, extra) {
      super(message);
      this.name = 'ApiError';
      this.code = code;
      // A7（审计 E4）：部分成功（META_SAVE_FAILED）带 bodySaved / chars / file 回来，界面要用；
      // 其它失败没有 extra，行为不变。
      if (extra && typeof extra === 'object') Object.assign(this, extra);
    }
  }

  async function call(fn, ...args) {
    const res = await fn(...args);
    if (!res || res.ok === false) {
      // 白名单（部分成功字段 / 重试 mtime）在 save-logic.js；原始错误与路径仍只留在主进程日志
      throw new ApiError((res && res.message) || '未知错误', res && res.code, saveLogic.saveFailureExtra(res));
    }
    return res.data;
  }

  // ---------- 后台失败留痕（B1 / 审计 E2、E6） ----------
  // 生产包不开放 DevTools：「只写 console」等于没写。这里统一做两件事——
  //   1) 把 kind / code / message（都只是短字符串，绝不含正文）交给主进程写一条诊断日志；
  //   2) 需要让作者知道的，由调用方给一句固定提示（见 installFailureGuard / reportChainFailure）。
  // 主进程侧是白名单 IPC app:report-renderer-error（handle() 校验来源 + 参数白名单 + 脱敏，见 main.js）；
  // 每秒最多留痕一次，免得同一个错误连击把日志刷满、toast 刷屏。留痕本身失败也绝不影响主流程。
  const FAILURE_REPORT_MIN_GAP_MS = 1000;
  let lastFailureReportAt = 0;
  let failureGuardInstalled = false;

  // 返回 true 表示这次真的上报了（调用方据此决定要不要弹提示，避免连击刷屏）
  function reportBackgroundFailure(kind, err) {
    try {
      console.error(`[后台失败] ${kind}`, err);
    } catch { /* 控制台不可用不影响主流程 */ }
    const now = Date.now();
    if (now - lastFailureReportAt < FAILURE_REPORT_MIN_GAP_MS) return false;
    lastFailureReportAt = now;
    const detail = err && typeof err === 'object' ? err : {};
    try {
      const pending = api.reportRendererError({
        kind,
        code: typeof detail.code === 'string' ? detail.code : '',
        message: typeof detail.message === 'string' ? detail.message : typeof err === 'string' ? err : ''
      });
      // preload 的 invoke 不抛错（失败回 {ok:false}），这里再兜一层：留痕不许自己变成 rejection
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch { /* 留痕失败不影响主流程 */ }
    return true;
  }

  // 关键链的失败出口：先留痕，再给一句可读提示（与仓库里 `xxx失败：${err.message}` 的既有口径一致）
  function reportChainFailure(label, err) {
    reportBackgroundFailure('ui-chain', err);
    toast(`${label}：${(err && err.message) || '未知错误'}`, 'error');
  }

  // 全局兜底（审计 E2）：init 之后任何没被 catch 的 Promise 拒绝都至少留一条痕迹 + 一句固定提示。
  // 提示文案写死，绝不拼 event.reason —— reason 里可能有正文 / 本机路径。
  function installFailureGuard() {
    if (failureGuardInstalled) return;
    failureGuardInstalled = true;
    window.addEventListener('unhandledrejection', (event) => {
      const reported = reportBackgroundFailure('unhandledrejection', event ? event.reason : null);
      if (reported) {
        toast('有一项后台操作失败了，已写进日志。写作和保存不受影响。', 'warn');
      }
    });
  }

  // ---------- 状态 ----------
  const state = {
    config: null, // 显示设置的「生效值」= 全局 + 当前书覆盖
    globalConfig: null, // 全局显示设置（书架 →「设置」里改的那份）
    books: [],
    view: 'shelf',
    bookPath: null,
    meta: null,
    bookId: null, // 当前书的 meta.id（按书记忆显示设置的 key）
    chapters: [],
    index: -1,
    // WP-03（审计 V101）：编辑区当前真正载入的章 id（null = 没有有效章节，编辑区处于遮罩态）。
    // 保存前核对它和 state.chapters[state.index].id 是否一致——快速切章 / 开书载章失败时
    // 索引可能已经指向新章，但编辑区里还是别处的内容；这一条挡住跨章 / 跨书写入。
    loadedChapterId: null,
    baseText: '',
    dirty: false,
    // WP-34（D1）：主进程「窗口是否脏」的上报镜像 —— 以前是动态添的字段（state.reportedDirty 未声明），
    // 现在收敛进声明表。初值 null = 还没同步过：首帧仍会让主进程收到一次 reportDirty(false)，
    // 与补声明前的 undefined 逐字一致（主进程 session.dirty 默认就是 false，这次上报是空操作）。
    reportedDirty: null,
    loading: false,
    saving: false,
    saveError: null,
    savedAt: null,
    loadedMtimeMs: 0,
    lastEditAt: 0,
    modal: null,
    contextIndex: -1,
    contextBook: null,
    contextVolumeId: null, // 当前右键的卷（卷菜单用）
    collapsedVolumes: new Set(), // 折叠起来的卷（'' = 未分卷组；只记在内存里，换书重置）
    chapterFilter: '', // 卷章目录的筛选词（只记在内存里；换书 / 新建章时清空）
    // 1.5.0 功能-1：章节多选（只记内存，不写书目 / 不写配置 / 不跨书）。
    // selectedIds 是章节 id 的 Set；selectAnchorId 是 Shift 连选的起点（上次单击的章）。
    selectedIds: new Set(),
    selectAnchorId: null,
    batchMenu: false, // 批量条打开的那张右键菜单（只显示能作用到全部已选章的动作）
    importing: false,
    sidebarWidth: 250,
    sidebarDragging: false,
    formatUndo: [], // 「整理本章」的快照栈（只存在内存里，关掉应用就没了；最多 50 步）
    replaceBackups: [], // 当前书的「整本替换」备份列表（查找面板里展示 / 还原用）
    bookDisplay: {}, // 当前书的显示设置覆盖（只覆盖改过的项）
    recentBook: null, // 上次写作的书 / 章（书架顶部「继续上次写作」；主进程从 config 读）
    conflictBook: null, // 正在看「同步冲突副本」弹层的那本书（只用于打开文件夹）
    bookInfoBook: null, // 正在编辑「书籍信息」的那本书
    history: null, // 正在看的「本书历史」：{ path, title, groups, preview, loading, error, token }
    shelfQuery: '', // 书架搜索词（书名 / 作者 / 分组 / 标签 / 章节名 / 正文）
    shelfGroup: '', // 书架分组筛选：'' = 全部分组；'__none__' = 未分组；其它 = 分组名（只记内存）
    shelfTag: '', // 书架标签筛选（1.6.0 F5）：'' = 全部标签；其它 = 标签全名（只记内存，与分组 / 搜索 AND）
    // 书架「正文命中」结果（提案 7.3）：搜索走主进程索引，这里只存展示用的结果
    shelfContent: {
      query: '', // 这批结果对应的查询词
      token: 0, // 丢弃过期结果（快速改词时）
      loading: false, // 正在查正文
      timer: null, // 输入防抖
      results: [], // [{ bookPath, bookTitle, chapterIndex, chapterName, matchIndex, snippet }]
      meta: null, // 主进程回报的统计：candidateBooks / scannedBooks / truncated / 索引状态
      error: null, // 搜索失败的原因（只影响正文结果，不影响书名过滤）
      shown: CONTENT_PAGE_SIZE, // 已经展示几条（「显示更多」每次 +8）
      // P22-4：按「书 + 章」展开过的结果（key → { loading, rows, error, truncated }），
      // 由 shelf-search-ui.js 维护；换查询 / 重新搜索 / 收起都清这里，不写盘。
      expanded: {},
      indexStatus: null // 索引状态 / 建索引进度（只用于提示，不落盘）
    },
    stats: null, // 每日字数摘要：{ day, todayChars, goal, goalPercent, goalMet, recentTotal, days[], streak }
    calendar: null, // 设置里显示的码字日历月视图（只读；翻月时由 stats:calendar 换）
    streak: null, // 连续写作天数：{ current, best, todayWritten, lastWritten, writtenDays }
    // 写作时长（v0.8-2，提案 N2）：默认关，只有设置里开启后才出现计时按钮。
    // 只按实际经过的时间累计秒数，不读正文、不记按键；秒数按天存进 userData/stats.json。
    writeTimer: {
      running: false, // 现在是否在计时
      segmentStart: 0, // 这一段开始计时的 Date.now()（暂停 = 0）
      sessionMs: 0, // 本次打开这本书累计的毫秒（只用于界面秒表）
      unsentMs: 0, // 还没上报给主进程的毫秒（保留不足 1 秒的零头）
      flushTimer: null, // 每 30 秒上报一次
      tickTimer: null // 每秒刷新一下按钮上的秒表（纯显示，不写盘）
    },
    jumpMatches: [], // Ctrl+G 跳章的当前匹配结果
    jumpQuery: '', // 跳章输入框里的词
    jumpOutOfRange: false, // 输入的是章号但超出本书章数
    jumpToken: 0, // 丢弃过期的异步匹配结果
    jumpTimer: null, // 输入防抖
    formatBookRunning: false, // 「一键整理本书」进行中（防重复触发）
    // 查找会话（v0.8-11，提案 N11）：当前章的「上一处 / 下一处 + 结果持续高亮」。
    // 只记在内存里：不写配置、不写书库；改正文 / 切章 / 换书 / 离开写作页就结束。
    find: {
      query: '', // 这次查找的词（原始输入，不去空白；和主进程口径一致）
      caseSensitive: false, // 区分大小写
      matches: [], // 当前章全部命中：[{ index, length }]（来自 text:find-all）
      index: -1, // 当前第几处（0 基；-1 = 没有）
      total: 0, // 命中总数
      windowKey: '', // 已渲染的高亮窗口标识（相同就只切换当前命中，不重画整层）
      highlighted: 0, // 当前画进影子层的命中数（给测试 / 提示用）
      windowStart: 0, // 影子层画的是全部命中里的哪一段（0 基）
      windowEnd: 0,
      truncated: false, // 命中太多、只画了一屏窗口
      fromBookmark: false // 这个会话是不是打开书签后自动建起来的（状态栏显示「书签 x / N」）
    },
    // 查找书签（v0.8-11b，提案 N11b）：按「书 + 章」把查询词与大小写存进 config.json。
    // 只存查询条件（不存正文、不存命中位置）；打开这一章时按当前正文重新扫描高亮。
    // 列表由主进程 config 清洗后下发，渲染层不直接读写文件。
    findBookmarks: [],
    findBookmarkToken: 0, // 丢弃过期的书签列表刷新结果（快速开面板 / 多窗口时）
    proofread: null, // 校对结果：{ scope, issues, chapters, total, byRule, truncated, wordList, ... }
    proofreadScope: 'current', // 校对范围：current = 当前章；book = 整本
    proofreadBusy: false, // 校对进行中（防重复触发）
    proofreadWordList: null, // 校对词表状态：{ ok, path, name, count, code, message, stats }
    proofreadWordsDraft: '', // 设置里刚选的校对词表路径（点「保存设置」才落配置）
    proofreadWordsInfo: null, // 设置弹层里显示的校对词表状态（读取当前草稿对应的词表）
    sensitive: null, // 敏感词预检结果：{ ok, scope, total, matches, byWord, chapters, ... }
    sensitiveScope: 'current', // 预检范围：current = 当前章；book = 整本
    sensitiveBusy: false, // 预检进行中（防重复触发）
    sensitiveWordList: null, // 当前词表状态：{ ok, path, name, count, code, message, stats }
    sensitiveWordsDraft: '', // 设置里刚选的词表路径（点「保存设置」才落配置）
    sensitiveWordsInfo: null, // 设置弹层里显示的词表状态（读取当前草稿对应的词表）
    logInfo: null, // 设置弹层「诊断日志」显示的日志目录清单（只读；不含正文）
    lastInternalError: null, // 主进程最近一次内部错误的固定提示（只用于提示 + 自检断言）
    appVersion: '', // package.json 的版本号（主进程回报；设置 →「检查更新」显示用）
    // 检查更新（提案 7.1）：只在点按钮时联网；不下载、不安装、不写配置，结果只记在内存里
    update: {
      busy: false, // 正在检查
      result: null // 主进程回报：{ status: 'update'|'latest'|'error', currentVersion, latestVersion, ... }
    },
    tts: {
      open: false, // 朗读小条是否显示
      status: 'idle', // idle | playing | paused | done | error
      chunks: [], // 主进程切好的段落：[{ start, end, text, paragraph, line }]
      index: 0, // 当前朗读 / 选中的段落下标（0 基）
      rate: 1, // 语速（0.5–2）
      voiceURI: '', // 选中的系统语音（'' = 系统默认）
      follow: false, // 跟随高亮：把编辑区选区移到正在读的段落（只改选区，不改文字）
      error: '', // 朗读失败 / 没有正文等错误信息
      loading: false, // 正在准备正文（切分中）
      requestId: 0 // 丢弃过期的异步切分结果
    },
    fragments: [], // 灵感箱列表（_碎片 顶层的 txt，最新在前）
    fragmentSelected: null, // 插入面板里当前选中的碎片 { name, text, chars }
    fragmentBusy: false, // 正在保存碎片（防重复写）
    insertFragmentRange: null, // 打开「插入碎片…」前编辑区的光标 / 选区（插入时按这个位置）
    fragmentDragName: null, // 1.5.0 功能-3：正拖向正文的碎片名（拖拽期间只在内存，落点按名字现读）
    fragmentDragDropped: false, // 1.5.0 功能-3：drop 已被接住（dragend 据此不收回「面板让路」状态）
    marks: {
      invisibles: false, // 显示不可见字符（全角空格 ␣ / 行尾空白）
      longParagraphs: false, // 超长段落提示（阈值可配，默认 >500 字左侧淡黄竖线）
      // 当前段落高亮（v0.8-10b，提案 N10b）：光标所在段淡色底 + 左侧细线。
      // 运行时开关 = 生效配置（全局默认 + 这本书的 bookDisplay 覆盖）；切换会写 config，不碰正文。
      caretParagraph: false,
      caretLine: 0, // 当前高亮的行号（1 基；0 = 没有高亮）
      caretTooLarge: false, // 正文超过 30 万字：暂不画段落高亮（和不可见字符同一上限）
      composing: false, // 中文输入法拼字中：先不重画标记层，免得闪
      timer: null, // 重画防抖
      longItems: [], // 本章超长段落（给状态栏小标签用；只读缓存）
      longCount: 0,
      longTruncated: false,
      markCounts: { fullwidth: 0, trailing: 0 },
      markTruncated: false,
      marksTooLarge: false, // 正文太长（>30 万字）时整层不建（renderEditorMarks 入口门控）
      tooLargeWarned: false, // 本次超长已经提示过一次（回到 30 万字以内重新武装，避免每次按键都弹）
      barBaseScrollTop: 0, // 左侧黄线的基准滚动位置（滚动时只改 top，不重新量行框）
      resizeObserver: null
    },
    focus: {
      on: false, // 专注模式是否开着（只在写作页有效；只记内存，不写配置）
      typewriter: false, // 打字机模式：光标行保持在正文区上方约 1/3 处
      savedScrollTop: 0, // 进入专注模式前的滚动位置（退出时按光标相对位置还原）
      savedCaret: 0, // 进入专注模式前的光标位置
      savedCaretOffset: null, // 进入时「光标行顶端 - 滚动位置」，退出时用它把视线放回原处
      timer: null // 打字机对齐的防抖定时器
    },
    // 阅读模式（v0.8-4，提案 N4）：整本只读通读。正文只从 chapter:load 读，不写正文 /
    // 书目 / 配置、不生成 _trash；字号 / 行距 / 阅读位置只记在内存里。
    reading: {
      open: false, // 阅读视图是否开着
      startIndex: 0, // 这次进入时从哪一章开始（上次阅读位置或当前写作章）
      index: 0, // 当前阅读章（上一章 / 下一章 / 目录以它为准；手动滚动时按视野中线更新）
      programmaticScrollTop: -1, // 刚由程序设置的滚动位置，用来避免把「跳章滚动」误当成用户滚动
      loading: false, // 正在读一章（防重复读盘）
      token: 0, // 丢弃过期的加载结果（退出 / 跳章时）
      timer: null // 滚动时算进度 / 自动接下一章的防抖定时器
    },
    readingPrefs: {
      fontLevel: readingLogic.READING_FONT_DEFAULT, // 字号档位（只记内存）
      lineLevel: readingLogic.READING_LINE_DEFAULT // 行距档位（只记内存）
    },
    settingsScope: 'global', // 设置弹层作用域：global = 全局默认；book = 只改这本书
    settingsBackup: null, // 设置弹窗里实时预览用：取消时恢复
    settingsFontDraft: { path: '', name: '' }, // 设置里刚选的自定义字体（点保存才落配置）
    settingsCaretColorDraft: '', // 设置里刚选的高亮颜色（'' = 跟随主题；点保存才落配置）
    suppressChapterClick: 0, // 拖拽结束后短暂屏蔽 click，避免误切章
    toastLog: [], // 只在 ?test=1 里记最近几条提示（E2E 验证「保存提示先出、缺章警告后到」）
    testMode: new URLSearchParams(location.search).get('test') === '1' // E6（审计 WP-11）：?test=0/false 不算测试模式，只认 ?test=1
  };

  // ---------- 命令面板条目缓存（1.5.0 P0-6 / 审计 O-1） ----------
  // 以前 buildCommandItems() 每次 input 都全量重建：千章书 = 1000+ 个对象 + 每章一次章号计算，
  // 敲一个字就做一遍。这里缓存「条目数组 + 构建时算好的归一文本」，只在数据变了时作废。
  // 只缓存数据，不缓存 DOM：面板照旧每次从条目重画（分批 / 选中态不受影响）。
  //   · markCommandsDirty() 由 state.chapters / state.books / state.meta 变化的同一处调用；
  //   · 取用前再比一次几样东西的引用（视图 / 书 / 书目 / 章节数组 / 当前章），漏掉一处也兜得住。
  const commandItemsCache = { items: null, key: null, invalidate: null };
  function markCommandsDirty() {
    commandItemsCache.items = null;
    commandItemsCache.key = null;
    // 面板自己也有快照：数据变了就作废，下次重画（或下次打开）重新取一次。
    if (typeof commandItemsCache.invalidate === 'function') commandItemsCache.invalidate();
  }

  // ---------- Toast ----------
  function toast(message, kind = 'info') {
    const area = $('toast-area');
    const el = document.createElement('div');
    el.className = `toast ${kind === 'warn' ? 'warn' : kind === 'error' ? 'error' : ''}`.trim();
    el.textContent = message;
    area.appendChild(el);
    // E2E 只在测试模式下读这份记录（生产里 state.toastLog 一直是空数组，不增长）
    if (state.testMode) {
      state.toastLog.push({ message: String(message), kind });
      if (state.toastLog.length > 60) state.toastLog.shift();
    }
    setTimeout(() => {
      // 淡出（0.16s，与全界面动效同一档）与透明度都在 styles.css 的 .toast.leaving 里：
      // 以前这里写死 .25s 的内联过渡，比别的动效慢一拍；内联简写里也不能写 var()（CSSOM 会丢）。
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 300);
    }, 3600);
  }

  // b8（剪贴板联动）：可点提示——普通 toast 只自动消失，这条带一个动作按钮，作者点了才执行。
  // 提示里只出现派生信息（字数），绝不含剪贴板正文（隐私红线：不落盘 / 不写日志 / 不做历史）。
  function toastActionable(message, actionLabel, onAction, options = {}) {
    const kind = options.kind || 'info';
    const durationMs = Number.isFinite(Number(options.durationMs)) ? Number(options.durationMs) : 8000;
    const area = $('toast-area');
    const el = document.createElement('div');
    el.className = `toast actionable ${kind === 'warn' ? 'warn' : kind === 'error' ? 'error' : ''}`.trim();
    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = message;
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'toast-action';
    action.textContent = actionLabel;
    el.appendChild(text);
    el.appendChild(action);
    area.appendChild(el);
    if (state.testMode) {
      state.toastLog.push({ message: String(message), kind, actionable: true });
      if (state.toastLog.length > 60) state.toastLog.shift();
    }
    let closed = false;
    let timer = null;
    const dismiss = () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 300);
    };
    action.addEventListener('click', () => {
      dismiss();
      try {
        onAction();
      } catch (err) {
        console.error('剪贴板提示的动作失败', err);
      }
    });
    timer = setTimeout(dismiss, Math.max(1000, Math.min(durationMs, 30000)));
  }

  // ---------- 通用模态 ----------
  // WP-13（审计 C11）：询问框单实例 + 排队（modal-queue.js）。以前这里直接覆盖 state.modal，
  // 外部修改检测在 await statChapter 期间撞上未保存询问时，旧 Promise 永不 resolve、流程挂死。
  // state.modal 仍是「当前这一框」的视图（Esc 链 / 关窗拦截 / 测试钩子只读它），排队由 modalQueue 管。
  const modalQueue = modalQueueModule.create({
    show(opts, close) {
      state.modal = { resolve: close, opts };
      $('modal-title').textContent = opts.title || '';
      const messageEl = $('modal-message');
      messageEl.textContent = opts.message || '';
      messageEl.classList.toggle('hidden', !opts.message);
      const inputEl = $('modal-input');
      if (opts.input) {
        inputEl.classList.remove('hidden');
        inputEl.value = opts.input.value == null ? '' : opts.input.value;
        inputEl.placeholder = opts.input.placeholder || '';
        setTimeout(() => {
          inputEl.focus();
          inputEl.select();
        }, 30);
      } else {
        inputEl.classList.add('hidden');
        inputEl.value = '';
      }
      const box = $('modal-buttons');
      box.innerHTML = '';
      (opts.buttons || []).forEach((button) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `btn ${button.kind || 'ghost'}`;
        btn.textContent = button.label;
        btn.dataset.value = String(button.value);
        btn.addEventListener('click', () => {
          const value = opts.input ? inputEl.value : undefined;
          close({ action: button.value, value });
        });
        box.appendChild(btn);
      });
      $('modal-backdrop').classList.remove('hidden');
      if (!opts.input) {
        const primary = box.querySelector('.btn.primary') || box.firstElementChild;
        if (primary) primary.focus();
      }
    },
    hide() {
      state.modal = null;
      $('modal-backdrop').classList.add('hidden');
      $('modal-input').classList.add('hidden');
    }
  });

  function openModal({ title, message, input, buttons, cancelValue = null }) {
    return modalQueue.open({ title, message, input, buttons, cancelValue });
  }

  function closeModal(result) {
    modalQueue.close(result);
  }

  // 供自动化测试用：按 value 点掉当前弹窗
  function answerModalValue(value) {
    const btn = $('modal-buttons').querySelector(`button[data-value="${value}"]`);
    if (btn) btn.click();
    else closeModal({ action: value });
  }

  // 通用询问框的按钮顺序（2026-11-04 拍板 #8）：.modal-buttons 是右对齐 + 数组首项在最左，
  // 所以一律「取消最左 → 破坏性中间 → 主操作最右」；破坏性仍用实心 danger，取消永远是最普通的 ghost。
  async function promptText({ title, message, value = '', placeholder = '' }) {
    const res = await openModal({
      title,
      message,
      input: { value, placeholder },
      buttons: [
        { label: '取消', value: 'cancel' },
        { label: '确定', value: 'ok', kind: 'primary' }
      ],
      cancelValue: 'cancel'
    });
    if (res.action !== 'ok') return null;
    return String(res.value == null ? '' : res.value);
  }

  async function askUnsaved({ title, message, saveLabel = '保存并继续', discardLabel = '不保存，丢弃修改' }) {
    const res = await openModal({
      title: title || '有未保存的修改',
      message: message || '当前章节有未保存的修改。',
      buttons: [
        { label: '取消', value: 'cancel' },
        { label: discardLabel, value: 'discard', kind: 'danger' },
        { label: saveLabel, value: 'save', kind: 'primary' }
      ],
      cancelValue: 'cancel'
    });
    return res.action || 'cancel';
  }

  // 五-H2/H3/H5/M9：统一「过渡前保存」原语（实现在 renderer/save-chain-ui.js，见该函数注释）。
  // 保存回执落地后复核 dirty、丢弃时清脏都是同一份实现；capture / shelf-nav 装配时按可选成员拿到它。
  // 函数声明会提升，saveChainUi 在启动装配段才 create —— 调用都发生在用户动作里，不存在 TDZ 问题。
  async function saveForTransition(options) { return saveChainUi.saveForTransition(options); }

  // 「还原前」的未保存拦截：整本替换备份还原（本文件）与历史备份还原（renderer/history-ui.js）流程相同，
  // 只有文案不同 —— 取消 / 放弃修改并还原 / 保存修改后再还原，保存失败就停在原地不继续还原。
  // 调用方各自判 state.dirty（历史弹层还能看别的书，不能拿当前书的脏标记去拦别的书）。
  // 五-H2/H3（BP-02 / BP-03 / L-F1）：三选一的语义收进 saveForTransition —— 保存成功后复核 dirty，
  // 仍脏（保存期间又敲了字）就再问一轮；作者选「放弃」时当场清脏，下游 reloadOpenBookFromDisk 的脏闸
  // 才不会把还原结果拒之门外（旧实现只看 saved.ok、discard 不清脏，导致「还原成功」假报）。
  // 返回 { ok:true } = 可以继续还原；{ ok:false, canceled:true } = 作者取消；
  // { ok:false, saved } = 保存失败，saved 是 saveCurrent() 的失败结果（原样上抛，提示已弹过）。
  async function confirmRestoreWithUnsaved(message) {
    const guard = await saveForTransition({
      title: '还原前先处理未保存的修改',
      message,
      saveLabel: '保存修改后再还原',
      discardLabel: '放弃修改并还原'
    });
    if (guard.ok) return { ok: true };
    if (guard.canceled) return { ok: false, canceled: true };
    return { ok: false, saved: guard.saved };
  }

  // ---------- 视图切换 ----------
  function showView(view) {
    // 撤销窗口（1.4.0 P0-2）只对当前写作现场有效：回书架 / 进阅读页就收起，绝不跨视图执行
    if (view !== 'editor') undoUi.clear();
    if (view !== 'editor') closeTtsBar();
    // 离开写作页就退出专注模式（不还原滚动位置：书已经关了）
    if (view !== 'editor' && state.focus.on) setFocusMode(false, { restore: false });
    state.view = view;
    $('shelf-view').classList.toggle('hidden', view !== 'shelf');
    $('editor-view').classList.toggle('hidden', view !== 'editor');
    $('reading-view').classList.toggle('hidden', view !== 'reading');
    updateWindowTitle();
    renderStatsUi();
    // 离开写作页就停表（先把没上报的整秒记下）：回书架 / 关书 / 去阅读都不会把闲逛时间算成写作
    if (view !== 'editor' && (state.writeTimer.running || state.writeTimer.sessionMs > 0 || state.writeTimer.unsentMs > 0)) {
      void resetWriteTimer({ flush: true });
    }
    // 标记层只在写作页显示；切回书架 / 阅读页就收起（开关状态保留，回来还在）
    // 查找高亮是「当前章」的：离开写作页就结束会话（回来不会对着旧位置亮着）
    if (view === 'editor') {
      scheduleMarksRender(0);
    } else {
      hideEditorMarks();
      if (state.find.total) clearFindSession();
    }
    renderSelectionStats();
    updateFocusBar();
  }

  function updateWindowTitle() {
    const inBookView = state.view === 'editor' || state.view === 'reading';
    // 阅读视图的标题带当前章号（Phase D / D8）：`…（阅读 · 第 2/3 章）`，后缀文案在 readingLogic。
    const readingSuffix = state.view === 'reading'
      ? readingLogic.readingTitleSuffix(state.reading.index, state.chapters.length)
      : '';
    const bookName = inBookView && state.meta ? ` - ${state.meta.title}${readingSuffix}` : '';
    // 阅读模式是只读视图：标题不显示未保存星号（修改还在编辑区，退出后照常显示）
    const next = `${state.view === 'editor' && state.dirty ? '* ' : ''}章回${bookName}`;
    // 只在真的变了才写：阅读时滚动换章会让这里频繁被喊到，别让任务栏标题无意义地抖
    if (document.title !== next) document.title = next;
  }

  // 显示排版（字体/字号/行间距/字间距/边距/宽度/背景）只改 CSS 变量，绝不改正文
  const CUSTOM_FONT_FAMILY = '"cw-custom-font"';
  const loadedCustomFont = { path: '', name: '', ok: false };
  let lastFontDecodeMode = 'none'; // 自检用：最近一次字体解码走的是 fetch（原生）还是 atob（回退）

  // 自定义字体：主进程读文件 → 这里用 FontFace 注册（渲染层仍然没有文件系统权限）
  // 代码审计 F1：不再把路径传给主进程——它只读「刚选的 / 当前书 / 全局配置」里的字体文件。
  // 代码审计 F11：解码走 renderer/font-logic.js（优先 fetch data: URL → arrayBuffer，失败回退 atob）。
  async function loadCustomFont(fontPath, { silent = false } = {}) {
    const wanted = String(fontPath || '');
    if (!wanted) return false;
    if (loadedCustomFont.path === wanted && loadedCustomFont.ok) return true;
    try {
      let res = await call(api.readFont);
      // 代码审计 F1：主进程只把「刚在对话框里选的」字体路径留一趟（预览用）。万一那条记录
      // 没被消费掉（例如再次选了同一个字体、渲染层缓存命中没去读），下一次请求别的字体就会
      // 先拿回它——发现读回来的不是要的那份就再读一次，第二次按本书 / 全局设置解析。
      if (fontLogic.shouldRetryFontRead(wanted, res)) res = await call(api.readFont);
      const decoded = await fontLogic.decodeFontBase64(res.base64);
      lastFontDecodeMode = decoded.mode;
      const face = new FontFace('cw-custom-font', decoded.bytes.buffer);
      await face.load();
      document.fonts.add(face);
      loadedCustomFont.path = wanted;
      loadedCustomFont.name = res.name;
      loadedCustomFont.ok = true;
      return true;
    } catch (err) {
      loadedCustomFont.path = wanted;
      loadedCustomFont.name = '';
      loadedCustomFont.ok = false;
      if (!silent) toast(`字体加载失败：${err.message}`, 'error');
      return false;
    }
  }

  function applyEditorStyle(override) {
    const fonts = {
      serif: '"SimSun", "Songti SC", "Source Han Serif SC", serif',
      sans: '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif',
      kai: '"KaiTi", "STKaiti", "Kaiti SC", serif'
    };
    const cfg = override || state.config || {};
    const root = document.documentElement.style;
    const fontFamily =
      cfg.editorFont === 'custom' && cfg.editorCustomFontPath
        ? `${CUSTOM_FONT_FAMILY}, ${fonts.serif}`
        : fonts[cfg.editorFont] || fonts.serif;
    root.setProperty('--editor-font-family', fontFamily);
    root.setProperty('--editor-font-size', `${cfg.editorFontSize || 18}px`);
    root.setProperty('--editor-line-height', String(cfg.editorLineHeight || 1.95));
    const spacing = cfg.editorLetterSpacing == null ? 0.02 : Number(cfg.editorLetterSpacing);
    root.setProperty('--editor-letter-spacing', `${Number.isFinite(spacing) ? spacing : 0.02}em`);
    const pageWidth = Number(cfg.editorPageWidth) || 0;
    root.setProperty('--editor-max-width', pageWidth > 0 ? `${pageWidth}px` : 'none');
    // 中西文自动间距（1.3.0 T-08，规范 T-08）：Chromium 的初始值是 no-autospace，所以两个方向都显式写
    // （开 = normal，关 = no-autospace），不依赖浏览器默认。只改渲染层，正文 / 导出 / 复制一个空白都不加。
    root.setProperty('--editor-text-autospace', cfg.editorTextAutospace === false ? 'no-autospace' : 'normal');
    const paddingX = Number(cfg.editorPaddingX);
    root.setProperty('--editor-padding-x', `${Number.isFinite(paddingX) && paddingX > 0 ? paddingX : 56}px`);
    for (const theme of ['cream', 'green', 'night', 'kraft', 'grid']) {
      document.body.classList.toggle(`theme-${theme}`, cfg.editorPaper === theme);
    }
    // 当前段落高亮颜色（v0.8-10b）：'跟随主题' 时清掉内联变量、让 body.theme-* 的配色接管；
    // 自定义时把颜色换成 rgba 写到 body 内联变量上（内联优先于主题类，切主题也保持自定义色）。
    applyCaretColor(cfg);
    // 字体 / 字号 / 行距变了，标记层要重新对齐；打字机测量的段内基准也一并作废（B15）
    resetCaretMeasureCache();
    scheduleMarksRender(30);
  }

  // ---------- 当前段落高亮的颜色（v0.8-10b，提案 N10b）----------
  // 只作用于显示层：'' = 跟随当前背景主题（6 套主题各自的默认配色不变），
  // '#rrggbb' = 作者自定义。清洗与 rgba 换算都在 core/caret-color.js（有单测）。
  function caretColorValue(cfg) {
    return caretColorLib.normalizeColor((cfg || state.config || {}).caretParagraphColor);
  }

  function applyCaretColor(cfg) {
    const value = caretColorValue(cfg);
    const style = caretColorLib.caretStyle(value);
    const bodyStyle = document.body.style;
    if (!style) {
      bodyStyle.removeProperty('--caret-para-tint');
      bodyStyle.removeProperty('--caret-para-edge');
      return '';
    }
    bodyStyle.setProperty('--caret-para-tint', style.tint);
    bodyStyle.setProperty('--caret-para-edge', style.edge);
    return value;
  }

  // 打开书 / 回书架 / 保存设置后，把「生效配置」里的开关同步到显示层。
  // 开关本身只在切换的那一下写 config；这里只读配置、不写盘。
  // 编辑器小件两个开关（不可见字符 / 超长段落）的生效值 = 本书 bookDisplay 覆盖；没设置过 = 默认关。
  // 只赋值、不渲染：调用方（syncCaretParagraphFromConfig）随后统一刷菜单 / 标记层。
  function syncMarksTogglesFromConfig() {
    const cfg = state.config || {};
    state.marks.invisibles = cfg.marksInvisibles === true;
    state.marks.longParagraphs = cfg.marksLongParagraphs === true;
  }

  // 超长段落阈值的生效值（1.1.0）：本书覆盖 ?? 全局默认，走 editor-logic 同一份夹紧（50–20000，坏值 500）。
  // 不缓存：打开书 / 保存设置 / 恢复默认都会换掉 state.config，标记层与菜单在
  // syncCaretParagraphFromConfig 里重画时会重新调用这里，自然套用新值；取消设置只还原 config。
  function getLongParagraphThreshold() {
    return editorLogic.sanitizeThreshold((state.config || {}).longParagraphThreshold);
  }

  function syncCaretParagraphFromConfig() {
    state.marks.caretParagraph = Boolean(state.config && state.config.caretParagraph === true);
    // 1.1.0：两个编辑器小件开关也按书记忆。设置弹层的 host 只认这个入口名，打开书 / 保存设置 /
    // 关设置 / 「恢复本书默认」都走这里，所以顺手把两个开关一起套回显示层（不新增 settings-ui 成员）。
    syncMarksTogglesFromConfig();
    applyCaretColor(state.config);
    renderMarksMenu();
    if (state.view === 'editor' && state.bookPath && state.index >= 0) {
      state.marks.caretLine = 0;
      renderEditorMarks();
    }
  }

  // 显示设置里按书改的项（含当前段落高亮的开关 / 颜色）：写作页写 bookDisplay，书架写全局默认。
  // 只写 config.json（原子写），不碰正文 / 书目 / 章节文件。
  async function persistDisplayPatch(patch) {
    if (state.bookId) {
      state.bookDisplay = (await call(api.setBookDisplay, state.bookId, patch)) || {};
    } else {
      state.globalConfig = await call(api.setConfig, patch);
    }
    state.config = effectiveConfig();
    applyEditorStyle();
    renderMarksMenu();
    return state.config;
  }

  // 编辑器小件两个开关按书记忆（1.1.0）：「显示 ▾」里切换「不可见字符 / 超长段落」时只写
  // config.json 的 bookDisplay[本书]，不碰正文 / 书目 / 章节文件，也不写全局默认。
  // 连点两个开关时按点击顺序排队写，避免后发的请求先落盘；写到一半换了书就丢弃（不把 A 书写进 B 书）。
  let marksPersistQueue = Promise.resolve();
  function persistMarksToggle(patch) {
    if (!state.bookId) return Promise.reject(new Error('没有打开的书'));
    const bookId = state.bookId;
    marksPersistQueue = marksPersistQueue
      .catch(() => {})
      .then(() => (state.bookId === bookId ? persistDisplayPatch(patch) : null));
    return marksPersistQueue;
  }

  // 「排版 ▾」里切换当前段落高亮：先改显示层，再按书写 config；写失败就退回原状态。
  async function setCaretParagraphPersisted(on, { quiet = false } = {}) {
    const next = Boolean(on);
    const previous = state.marks.caretParagraph;
    setMarksToggle('caretParagraph', next);
    try {
      await persistDisplayPatch({ caretParagraph: next });
      if (!quiet) {
        toast(
          next
            ? `已开启当前段落高亮（${state.bookId ? '只对这本书' : '全局默认'}，会记住）`
            : `已关闭当前段落高亮（${state.bookId ? '只对这本书' : '全局默认'}，会记住）`
        );
      }
      return true;
    } catch (err) {
      setMarksToggle('caretParagraph', previous);
      toast(`保存当前段落高亮开关失败：${err.message}`, 'error');
      return false;
    }
  }

  // 选高亮颜色（'' = 跟随主题 / '#rrggbb' = 自定义）：实时换色，再按书写 config。
  // 写失败时退回上一个颜色，不留下「界面变了但没记住」的假象。
  async function setCaretColorPersisted(color, { quiet = true } = {}) {
    const next = caretColorLib.normalizeColor(color);
    const previous = caretColorValue(state.config);
    applyCaretColor({ caretParagraphColor: next });
    renderCaretColorRow();
    try {
      await persistDisplayPatch({ caretParagraphColor: next });
      if (!quiet) {
        toast(next ? `高亮颜色已保存（${state.bookId ? '只对这本书' : '全局默认'}）` : '高亮颜色已恢复跟随背景主题');
      }
      return true;
    } catch (err) {
      applyCaretColor({ caretParagraphColor: previous });
      renderCaretColorRow();
      toast(`保存高亮颜色失败：${err.message}`, 'error');
      return false;
    }
  }

  // ---------- 章节栏 / 写作区 可拖动分隔条 ----------
  function clampSidebarWidth(width) {
    const maxByWindow = Math.max(180, Math.round(window.innerWidth * 0.6));
    return Math.min(Math.min(800, maxByWindow), Math.max(180, Math.round(Number(width) || 250)));
  }

  function applySidebarWidth(width) {
    state.sidebarWidth = clampSidebarWidth(width);
    document.documentElement.style.setProperty('--sidebar-width', `${state.sidebarWidth}px`);
    return state.sidebarWidth;
  }

  // 显示设置的生效值 = 全局设置 + 当前书的覆盖
  function effectiveConfig() {
    return { ...(state.globalConfig || state.config || {}), ...(state.bookDisplay || {}) };
  }

  // 章节栏宽度：开着书就记到这本书，否则记全局
  async function persistSidebarWidth(width) {
    try {
      if (state.bookId) {
        const display = await call(api.setBookDisplay, state.bookId, { editorSidebarWidth: width });
        state.bookDisplay = display || {};
        state.config = effectiveConfig();
      } else {
        state.globalConfig = await call(api.setConfig, { editorSidebarWidth: width });
        state.config = effectiveConfig();
      }
    } catch { /* 记不住宽度不影响使用 */ }
  }

  // 打开一本书后套用这本书的显示设置（没有单独设置过就沿用全局）——实现在 renderer/shelf-view-ui.js
  // （WP17 A3 第三刀）；同名包装保调用点零改动（开书 / 修复 / 重载三处）。
  async function applyBookDisplay(bookId) { return shelfViewUi.applyBookDisplay(bookId); }

  function setupSidebarResizer() {
    const resizer = $('sidebar-resizer');
    if (!resizer) return;
    let dragStartX = 0;
    let dragStartWidth = 0;

    resizer.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      state.sidebarDragging = true;
      dragStartX = event.clientX;
      dragStartWidth = state.sidebarWidth;
      resizer.classList.add('dragging');
      document.body.classList.add('resizing');
      try { resizer.setPointerCapture(event.pointerId); } catch { /* 忽略 */ }
    });

    window.addEventListener('pointermove', (event) => {
      if (!state.sidebarDragging) return;
      applySidebarWidth(dragStartWidth + (event.clientX - dragStartX));
    });

    window.addEventListener('pointerup', () => {
      if (!state.sidebarDragging) return;
      state.sidebarDragging = false;
      resizer.classList.remove('dragging');
      document.body.classList.remove('resizing');
      // A6（审计 E8）：事件回调里的 async 调用不能把 rejection 漏成 unhandledrejection。
      // 记不住宽度本来就不影响使用（persistSidebarWidth 内部也吞掉已知失败），这里显式兜住兜底。
      persistSidebarWidth(state.sidebarWidth).catch(() => {});
    });

    // 双击恢复默认宽度（这本书恢复成 250）
    resizer.addEventListener('dblclick', () => {
      applySidebarWidth(250);
      persistSidebarWidth(250).catch(() => {});
    });
  }

  // ---------- 书架 ----------
  // 回书架时重取「上次位置 / 今日统计 / 书目」并重画、后台校验索引：整段在
  // renderer/shelf-view-ui.js（WP17 A3 第三刀）；同名包装保 21 个调用点零改动。
  async function refreshShelf() { return shelfViewUi.refreshShelf(); }

  // ---------- 书架搜索（v0.9 B-5 第九刀：整段搬到 renderer/shelf-filter-ui.js） ----------
  // 书名 / 作者 / 分组 / 标签 / 章节名的内存过滤、分组筛选、正文结果区与搜索提示整段搬走，行为一字未改。
  // 这里只剩接线：七个入口按原名被书架 / 书籍信息 / 事件绑定取用；openContentResult 由下一段正文搜索
  // 模块晚一步交出，用惰性转发保持「先建过滤、后建正文搜索」的原装配顺序（调用都发生在装配完成之后）。
  const shelfFilterUi = shelfFilterUiModule.create({
    $, state, bookInfoLib, chapterTitle, CONTENT_SEARCH_MIN_CHARS,
    openContentResult: (row) => openContentResult(row),
    // P22-4：展开一章全部命中由正文搜索模块晚一步交出，这里同样是惰性转发（装配顺序不变）。
    expandContentChapter: (row, options) => expandContentChapter(row, options)
  });
  const { shelfQueryText, bookGroupOf, shelfGroupList, shelfSearchResults, shelfContentActive, renderShelfContent, updateShelfSearchUi } = shelfFilterUi;

  // ---------- 书架正文搜索（v0.9 B-5 第八刀：整段搬到 renderer/shelf-search-ui.js） ----------
  // 查询重置 / 320ms 防抖调度 / 主进程查询（旧响应按令牌丢弃）/ 索引状态 / 打开命中整段搬走，行为一字未改。
  // 这里只剩接线：四个入口按原名被书架 / 事件绑定 / 测试钩子取用。
  const shelfSearchUi = shelfSearchUiModule.create({
    // 第 4 步九刀·第六刀：renderShelf 随「书籍信息」搬到 bookinfo-ui.js 后退化成装配期之后才初始化的 const；
    // 这里用惰性转发保持「先建正文搜索、后建书架渲染」的原装配顺序（调用都发生在装配完成之后，行为等价）。
    state, renderShelfContent, renderShelf: () => renderShelf(), shelfQueryText, shelfContentActive, call, api, openBookByPath,
    CONTENT_PAGE_SIZE, CONTENT_SEARCH_DEBOUNCE, CONTENT_RESULT_LIMIT
  });
  const { resetShelfContent, scheduleContentSearch, ensureSearchIndex, openContentResult } = shelfSearchUi;
  // P22-4：展开一章全部命中（测试钩子 / 静态闸门按原名找的那 4 个入口保持原样，这里单独取第 5 个）。
  const expandContentChapter = shelfSearchUi.expandContentChapter;

  // ---------- 书架交互（v0.9 B-5 第六刀：三个小分区整段搬到 renderer/shelf-ui.js） ----------
  // 「继续上次写作」卡片 / 同步冲突副本提示 / 切章（含未保存拦截）三块整段搬走，行为一字未改。
  // 这里只剩接线：入口绑成模块级 const，事件绑定 / Esc 动作表 / 测试钩子照旧按名字取。
  const shelfUi = shelfUiModule.create({
    $, state, chapterTitle, formatRelativeTime, openBookByPath, askUnsaved, saveCurrent, loadChapterAt,
    // WP-03（C9 / C10）：切章前等「载章 / 保存在途」落定（可选成员，旧宿主 / 单测没有也能跑）
    waitForSavingIdle, waitForLoadingIdle,
    // B2（WP18）：书架增量刷新（可选；renderShelf / refreshStats 装配点后才落定，惰性转发）
    api, call, renderShelf: () => renderShelf(), refreshShelf: () => refreshShelf(), refreshStats: () => refreshStats(), markCommandsDirty
  });
  const { renderContinueWriting, openContinueBook, openConflictDialog, closeConflictDialog } = shelfUi;

  // ---------- 书籍信息 ----------
  // 第 4 步九刀·第六刀：实现在 renderer/bookinfo-ui.js（模块头有契约），这里只装配与接线；
  const bookinfoUi = bookinfoUiModule.create({
    $, state, api, call, toast,
    imeGuard,
    render: { bookInfoLib, bookGroupOf, chapterTitle, formatChars, formatRelativeTime },
    shelf: { shelfGroupList, shelfQueryText, shelfSearchResults, updateShelfSearchUi, renderContinueWriting, renderShelfContent },
    actions: {
      openBookByPath,
      openBookAtChapter: (bookPath, chapterIndex) => openBookByPath(bookPath, { chapterIndex }),
      openRepair, openConflictDialog, showBookMenu, updateWindowTitle, promptText, refreshShelf
    }
  });
  const {
    openBookInfoDialog, closeBookInfoDialog, readBookInfoForm, saveBookInfoDialog,
    openGroupManageDialog, closeGroupManageDialog, moveBookToGroup,
    openBookGroupChooser, closeBookGroupChooser, newGroupForBook,
    renderShelf, createBookWithTitle, onNewBookClick, maybeShowFirstRunTip
  } = bookinfoUi;

  // ---------- 开书 / 载章状态机（v1.8.0 WP-03 / 审计 V101、V102、C9、C10） ----------
  // 这一族问题的共同根源是「异步回执到达时，现场已经不是发起时的现场」：
  //   · 连开两本书：先点的那本后返回，会把后点的书盖掉（V102）；
  //   · 开书后目标章读取失败（缺文件 / >128MB / 权限）：编辑区还留着上一本的正文、state.index 还是旧下标，
  //     作者接着输入并 Ctrl+S 就把上一本正文写进新书同下标章节（V101，后果接近高）；
  //   · loadChapterAt 没有令牌：连点两章时后返回的旧加载覆盖后点的目标，加载途中输入也会被静默覆盖（C9）；
  //   · 保存在途时切章：回执按「现在」的 index 回写 mtime / 字数，作者刚选的「不保存」被在途写入违背（C10）。
  // 这里集中收口：模块级 openSeq 开书世代令牌（载章令牌与编辑区「载章中 / 没有有效章节」只读态
  // 随 renderer/save-chain-ui.js 走）；回执到达后先核令牌与书路径，过期一律丢弃；保存回执只认发起时
  // 捕获的 (bookPath, chapterId)。
  let openSeq = 0;
  let openingBook = false;
  // WP20（R-N2）的保存深度守卫、载章令牌、等待者队列与编辑区遮罩态都随保存链模块走；
  // 编排器不再留第二份，避免两处状态漂移。
  // ?test=1 时 E2E 用 setTestOpenBookDelay / setTestLoadChapterDelay 给这两条 IPC 外面包延迟，
  // 制造「响应乱序」「载章在途」的窗口；正常启动恒为 null，直接走 call(api.openBook / api.loadChapter)。
  let testOpenBook = null;
  let testLoadChapter = null;
  // N3（审计低）：大章载入软告知的阈值与判定在 renderer/save-chain-ui.js（保存链模块）里；
  // 编排器不再留第二份限额（与标记层 30 万 / 捕获 raw 3M 的口径区分见模块头注）。

  // 保存链（载章 / 保存 / 关窗 / 只读态 / 遮罩）在 renderer/save-chain-ui.js（WP17 A3 第二刀）。
  // 这里只留同名包装：函数声明会提升，调用点与测试钩子照旧按原名取（调用都发生在模块装配之后）。
  function applyEditorEditable() { return saveChainUi.applyEditorEditable(); }
  function setChapterMask(masked, placeholder) { return saveChainUi.setChapterMask(masked, placeholder); }
  // 载章 / 保存在途的等待者与唤醒只服务模块内部（切章拦截用 waitFor* 两个入口）；
  // notify* 没有外部调用点，不留在编排器里占行（eslint 也会报无人使用）。
  function waitForLoadingIdle() { return saveChainUi.waitForLoadingIdle(); }
  function waitForSavingIdle() { return saveChainUi.waitForSavingIdle(); }

  // ---------- 打开书 / 修复 ----------
  // target 可选：{ chapterId, chapterIndex, matchIndex, matchLength } —— 从书架「正文命中」点进来时
  // 直接打开那一章并选中命中位置（只移动光标 / 选区 + 滚动，不改正文、不写盘）；
  // 从「章节命中」点章名时只带 chapterIndex（按 0 起的章节序号），越界 / 坏值回落到上次章节。
  // 书卡右键「在新窗口打开」：主进程负责「同一本书只开一个窗口」；
  // 书已经开在别的窗口时就聚焦那个窗口，本窗口不变。
  async function openBookInNewWindow(book) {
    if (!book || !book.path) return { ok: false };
    try {
      const result = await call(api.openBookInNewWindow, book.path);
      if (result && result.focused) {
        toast(result.message || '这本书已经在另一个窗口打开，已切换到那个窗口', 'warn');
      } else {
        toast(`已在新窗口打开「${book.title || '这本书'}」`);
      }
      return { ok: true, ...(result || {}) };
    } catch (err) {
      toast(`新窗口打开失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  async function openBookByPath(bookPath, target = null) {
    // WP-03（V102）：每次开书一个世代号。await 回来先核对；过期响应一个字都不许写进界面——
    // 以前快速连开两本时，「响应最后返回」的那本会盖掉最后点击的那本（还可能把 index / chapters /
    // bookPath 带进不一致的中间态）。
    const seq = ++openSeq;
    const stale = () => seq !== openSeq;
    // 1.6.0 H1（审计 E-01，丢稿）：换书前先处理当前章节的未保存修改 —— 保存并继续 / 丢弃 / 取消。
    // 「取消」或「保存失败」都停在原地（正文、dirty、撤销条全不动）；决策是 open-book-guard.js
    // 里的纯函数（Node 单测覆盖），这里只负责弹窗与保存。四个换书入口都走这一个函数。
    // C10 同族：保存在途时先等它按快照章身份完成，再按「剩下真正没保存的字」询问——
    // 否则作者刚选的「不保存」会被在途写入违背。
    if (state.saving && state.dirty) {
      await waitForSavingIdle();
      if (stale()) return { ok: false, code: 'STALE' };
    }
    const dirtyBeforeSwitch = state.dirty === true;
    if (openBookGuard.decideOpenBook({ dirty: dirtyBeforeSwitch }).action === 'prompt') {
      const choice = await askUnsaved({
        title: '换书前先处理未保存的修改',
        message: `「${currentChapterLabel()}」还有未保存的修改。换到另一本书后，编辑区里这些字不会跟着过去。`
      });
      if (stale()) return { ok: false, code: 'STALE' };
      let saveResult = null;
      if (choice === 'save') saveResult = await saveCurrent();
      if (stale()) return { ok: false, code: 'STALE' };
      const guard = openBookGuard.decideOpenBook({ dirty: dirtyBeforeSwitch, choice, saveResult });
      // 失败提示 saveCurrent 已经弹过（与还原 / 删除前拦截同口径），这里只负责别继续换。
      if (guard.action !== 'proceed') return;
    }
    // 从「决定换书」这一刻起锁住编辑区：api.openBook 的 IPC 往返期间作者可能还在上一本里敲字。
    // 开成功就整块换成新书（这些字不能静默消失），开失败 / 取消则原样留在上一本（编辑区没动过）。
    openingBook = true;
    applyEditorEditable();
    let committed = false;
    try {
      let data;
      try {
        // WP-03 验收锚点：?test=1 下 E2E 用 setTestOpenBookDelay 包一层延迟制造「响应乱序」窗口；
        // 正常启动 testOpenBook 恒为 null，直接走生产同一条开书 IPC。
        data = testOpenBook
          ? await testOpenBook(api.openBook, bookPath)
          : await call(api.openBook, bookPath);
      } catch (err) {
        if (stale()) return { ok: false, code: 'STALE' };
        if (err.code === 'BOOK_OPEN_IN_OTHER_WINDOW') {
          // 同一本书只允许一个窗口：主进程已经聚焦了那个窗口
          toast(err.message || '这本书已经在另一个窗口打开，已切换到那个窗口', 'warn');
          return { ok: false, code: err.code };
        }
        if (err.code === 'PARSE_ERROR' || err.code === 'INVALID_META' || err.code === 'NO_BOOK') {
          const known = (state.books || []).find((b) => b.path === bookPath);
          await openRepair(
            known || { path: bookPath, title: '这本书', status: 'corrupt', reason: err.message }
          );
          return { ok: false, code: err.code };
        }
        toast(`打开失败：${err.message}`, 'error');
        return { ok: false, code: err.code || 'OPEN_FAILED', message: err.message };
      }
      if (stale()) return { ok: false, code: 'STALE' };
      if (data.missing && data.missing.length) {
        toast(`注意：${data.missing.length} 个章节文件缺失，可在「导出 → 打开本书文件夹」里检查`, 'warn');
      }
      // 提交新书：清空 / 遮罩 / 换书目 / 载本章。提交完成后即使载章失败也停在新书的遮罩态（V101）。
      committed = await commitOpenBook(bookPath, data, target, stale);
      if (!committed) return { ok: false, code: 'STALE' };
      if (stale()) return { ok: false, code: 'STALE' };
      if (target && Number.isFinite(Number(target.matchIndex))) {
        selectEditorRange(Number(target.matchIndex), Number(target.matchLength) || 0);
      }
      return data;
    } finally {
      // 只有「还是当前这次开书」才允许解自己的锁；过期响应不能把后一次开书的锁解掉。
      if (!committed && seq === openSeq) {
        openingBook = false;
        applyEditorEditable();
      }
    }
  }

  // 新书提交（WP-03 / V101）：调用方已确认这次响应属于当前世代。返回 false = 提交前又被新的开书取代，
  // 什么都没提交（调用方按过期处理）；返回 true = 书目已换成本书（即使后面载章失败也不回滚）。
  async function commitOpenBook(bookPath, data, target, isStale) {
    // 换书：撤销条不跨书（撤销闭包里还会再核对一次 state.bookPath）
    undoUi.clear();
    // 审计修复 #7（V401）：大段插入的一次性快照也必须跟着换书作废 —— 以前这里只清 undoUi，
    // bulkWriteUndo 会跨书活到「新书载章失败」的遮罩态：那时编辑区只是 readOnly（仍可聚焦），
    // 一下 Ctrl+Z 就把上一本整章正文写进新书空编辑区 + 假脏态。快照自身也带身份核对（见 undoBulkWrite）。
    bulkWriteUndo = null;
    fallbackWriteUndo = null; // 审计修复 #39（V402）：兜底写入的一次性快照同样不跨书
    // 换书前先停掉上一本的写作计时：把没上报的整秒记下，新书从 0 开始
    await resetWriteTimer({ flush: true });
    if (isStale()) return false;
    // WP-03（V101）：提交新书状态前先清空 / 遮罩编辑区并置 index=-1、loadedChapterId=null。
    // 目标章读取失败时界面已经属于新书，编辑区绝不能还留着上一本的正文（否则输入 + Ctrl+S
    // 会把上一本正文写进新书同下标章节，且保存不备份正文）。
    state.bookPath = bookPath;
    state.meta = data.meta;
    state.bookId = data.meta.id;
    state.chapters = data.meta.chapters;
    state.collapsedVolumes = new Set(); // 换书重置折叠状态
    state.chapterFilter = ''; // 换书清空目录筛选（否则新书会带着上一本的筛选词，看起来像丢章）
    state.selectedIds = new Set(); // 换书清空多选（1.5.0 功能-1：多选不跨书）
    state.selectAnchorId = null;
    state.batchMenu = false;
    state.index = -1;
    state.loadedChapterId = null;
    state.dirty = false;
    state.saveError = null;
    state.baseText = '';
    editorEl.value = '';
    if (state.find.total) clearFindSession(); // 上一本的高亮位置不属于新书
    setChapterMask(true, '正在载入章节…');
    $('book-title').textContent = data.meta.title;
    $('book-title').title = data.meta.title;
    showView('editor');
    renderChapterList();
    // 套用这本书自己的显示设置（没有单独设置过就沿用全局）
    await applyBookDisplay(data.meta.id);
    // applyBookDisplay 期间可能有更晚的一次开书已经提交了自己的书：界面归它，这里不再载章，
    // 也不许解它的锁（openingBook 仍归那一次）。
    if (state.bookPath !== bookPath) return true;
    if (!isStale()) {
      openingBook = false;
      applyEditorEditable();
    }
    let startIndex = Math.max(
      0,
      state.chapters.findIndex((c) => c.id === data.meta.lastOpenChapterId)
    );
    if (target && target.chapterId) {
      const targetIndex = state.chapters.findIndex((c) => c.id === target.chapterId);
      if (targetIndex >= 0) startIndex = targetIndex;
    } else if (target && target.chapterIndex !== undefined && target.chapterIndex !== null) {
      // 「章节命中」直达：0 起的章节序号；只认落在这本书章节范围内的整数，
      // 越界 / 坏值不夹到首尾，直接回落到上次打开的章节（与旧行为一致）。
      const rawIndex = Number(target.chapterIndex);
      if (Number.isFinite(rawIndex)) {
        const chapterIndex = Math.round(rawIndex);
        if (chapterIndex >= 0 && chapterIndex < state.chapters.length) startIndex = chapterIndex;
      }
    }
    await loadChapterAt(startIndex);
    return true;
  }

  // 把编辑区选区放到命中位置（正文命中点进来用）：只改光标 / 选区与滚动，不改内容
  function selectEditorRange(index, length) {
    const size = editorEl.value.length;
    const pos = Math.max(0, Math.min(Math.round(Number(index) || 0), size));
    const end = Math.max(pos, Math.min(pos + Math.max(1, Math.round(Number(length) || 0)), size));
    editorEl.focus();
    editorEl.setSelectionRange(pos, end);
    scrollCaretIntoView(pos);
  }

  async function openRepair(book) {
    const res = await openModal({
      title: `修复「${book.title || '这本书'}」`,
      message:
        `书目无法读取：${book.reason || '未知原因'}\n\n` +
        '可以从上一版备份（书目.json.bak）恢复，或按文件夹里的 txt 文件名重建书目。\n' +
        '两种方式都会保留损坏的文件（改名成 .corrupt-时间戳），不会直接删掉。',
      buttons: [
        { label: '取消', value: 'cancel' },
        { label: '从目录重建', value: 'rebuild' },
        { label: '从备份恢复', value: 'bak', kind: 'primary' }
      ],
      cancelValue: 'cancel'
    });
    if (!res.action || res.action === 'cancel') return;
    try {
      const data = await call(api.repairBook, book.path, res.action);
      if (res.action === 'bak') {
        toast(`已从备份恢复：${data.meta.chapters.length} 章`);
      } else {
        const skipped = Number(data.skippedConflicts) || 0;
        toast(`已重建书目：${data.count} 章${skipped ? `（跳过 ${skipped} 个同步冲突副本）` : ''}`);
      }
      await refreshShelf();
    } catch (err) {
      toast(`修复失败：${err.message}`, 'error');
    }
  }

  // ---------- 章节列表 / 卷章目录显示层（WP17 A3 第一刀：整段搬到 renderer/chapter-directory-ui.js） ----------
  // 筛选 / 概览行 / 卷头 / 条目 / 事件委托 / 多选标记 / 整表重建 48 个入口整段搬走，行为一字未改。
  // 这里只剩接线：模块常量 + 一次 create + 按原名取入口（事件绑定 / 测试钩子 / 各面板照旧按名字取）。
  // 当前章条目缓存（1.6.0 A5/P-09）仍归渲染层：切章快路径 syncActiveChapterItem 直接写它，
  // 模块经 get / set 两个宿主成员读写（不把切章快路径也拖进这一刀）。
  let cachedActiveChapterItem = null;
  const chapterDirectoryUi = chapterDirectoryUiModule.create({
    $, state, chapterTitle, chapterListLabel, chaptersLib, chapterFilterLogic,
    // chapterCharsOf 是状态栏模块的 const（装配点在后），惰性转发；调用都发生在装配完成之后。
    chapterCharsOf: (chapter) => chapterCharsOf(chapter),
    formatCount, editorLogic, listKeyboard, chapterSelectionLib,
    imeGuard,
    chapterStatus, chapterNote, CHAPTER_STATUS_LABELS,
    // switchChapter 由书架模块晚一步交出（const），同样惰性转发。
    switchChapter: (index) => switchChapter(index),
    showContextMenu, showVolumeMenu,
    startChapterDrag: (event, index, itemEl) => startChapterDrag(event, index, itemEl),
    renameChapterAt, copySelectedChapters, exportSelectedChapters, deleteSelectedChapters,
    openVolumeChooserInMenu, markCommandsDirty,
    getCachedActiveChapterItem: () => cachedActiveChapterItem,
    setCachedActiveChapterItem: (item) => { cachedActiveChapterItem = item; }
  });
  const { chapterFilterActive, chapterIndexMatchesFilter, renderBookMeta, syncChapterFilterUi, renderVolumeToggle, activeChapterItem, syncCurrentVolumeMarker, updateCurrentChapterPill, setupChapterDirectory, setupChapterListEvents, setupChapterBatchBar, volumeList, volumeById, volumeDisplayName, chapterVolumeId, toggleVolumeCollapse, chapterItemTitleText, chapterSelectionSnapshot, chapterIdAt, currentChapterId, renderedChapterIds, selectedChapterIndexes, syncChapterBatchBar, setChapterSelection, clearChapterSelection, renderChapterList } = chapterDirectoryUi;

  // ---------- 章节拖拽排序 ----------
  // pointer 拖拽（起手 / 跟手 / 落点 / 自动滚动）+ 两条写盘路径整段搬到了
  // renderer/drag-sort-ui.js（v0.9 B-5 第五刀：只搬不改行为）。这里只剩接线：
  // 拖拽过程是模块内的活状态，渲染层按名字取 4 个入口（章节列表 / 事件绑定 / 测试钩子）。
  const dragSortUi = dragSortUiModule.create({
    $, api, call, chapterVolumeId, renderChapterList, renderEditorHeader,
    state, toast, updateStatus, volumeDisplayName
  });
  const setupChapterDrag = dragSortUi.setupChapterDrag;
  const startChapterDrag = dragSortUi.startChapterDrag;
  const moveChapterByDrag = dragSortUi.moveChapterByDrag;
  const moveChapterByDrop = dragSortUi.moveChapterByDrop;

  // 键盘上下移动（Phase D / D1）：Alt+↑/↓ 在章节列表里把这一章挪一格，等价「拖一行」。
  // 卷内相邻走现成的 moveChapterByDrag；已经在卷边界上再按一次，就跨到相邻的那一个卷
  // （U-D1：先弹一次确认，再走拖拽那条 moveChapterByDrop → api.moveChapterTo）。两条路都只改
  // 书目顺序与卷归属，章节文件 / 正文一个字不动；未分卷 / 到头 / 坏卷 id 由 core 返回 null（停住）。
  async function moveChapterStep(index, direction) {
    if (!state.bookPath || state.saving || state.loading) return false;
    const chapter = state.chapters[index];
    if (!chapter) return false;
    const target = dragSortUiModule.stepMoveTarget(state.chapters, index, direction, chapterVolumeId);
    if (target) {
      await moveChapterByDrag(index, target.toIndex);
      focusChapterItem({ mode: 'id', id: chapter.id });
      return true;
    }
    const cross = chaptersLib.crossVolumeTarget(state.meta, index, direction);
    if (!cross) return false;
    const toVolume = volumeDisplayName(cross.volumeId);
    // 1.4.0 P0-2（撤销优先于确认）：跨卷移动不再弹确认框 —— 直接挪，10 秒内可撤销。
    // 只改书目顺序与卷归属，章节文件一个字节不动，撤销就是原路挪回去。
    const bookPath = state.bookPath;
    const fromVolumeId = chapterVolumeId(chapter);
    // 原来的下一章 id（null = 原本就是全书最后一条）：撤销时「插回它前面」与移动前的位置等价
    // （跨到下一卷卷首时 = 原卷末尾；跨到上一卷卷尾时 = 原卷里的原位）。
    const beforeId = state.chapters[index + 1] ? state.chapters[index + 1].id : null;
    const moved = await moveChapterByDrop(chapter, {
      volumeId: cross.volumeId,
      beforeChapterId: cross.beforeChapterId
    });
    if (!moved || moved.ok !== true) return false;
    focusChapterItem({ mode: 'id', id: chapter.id });
    undoUi.activate(`已把「${chapterTitle(index, chapter.name)}」移到「${toVolume}」`, async () => {
      if (state.bookPath !== bookPath) throw new Error('已经换了书，不能撤销');
      const at = state.chapters.findIndex((c) => c.id === chapter.id);
      if (at < 0) throw new Error('这一章已经不在书里了');
      const back = await moveChapterByDrop(state.chapters[at], {
        volumeId: fromVolumeId,
        beforeChapterId: beforeId
      });
      if (!back || back.ok !== true) throw new Error((back && back.message) || '移动没有生效');
      focusChapterItem({ mode: 'id', id: chapter.id });
    });
    return true;
  }

  // A7（WP-32 / 审计 A7）：focusChapterById / AfterDelete / AfterSwitch 三份约 80% 重复的
  // 「把焦点放回章节列表」实现合并成这一份，差异只在落点怎么算（locator.mode）：
  //   'id'       —— 拖拽 / Alt+↑↓ 移动后列表整表重建，按章 id 找回来（否则连按 Alt+↓，
  //                 按一次焦点就丢到 body），roving 停留点也跟着这一条（与方向键移焦点同口径）；
  //   'position' —— U-D9：键盘 Delete 删除整表重建后按位置落回（删的是最后一条就落到新的
  //                 最后一条；主进程给的下一章下标正好是同一位置），连按 Delete 才删得动；
  //   'switch'   —— U-D12：Ctrl+PageUp/Dn / 命令面板切章走的是「只改高亮 / tabIndex」的快路径，
  //                 只有焦点原本就在章节列表里才把它带到新当前章；焦点在编辑区 / 工具栏时
  //                 一个字都不动 —— 绝不把焦点从正文抢走（这一路也不滚动）。
  function focusChapterItem(locator) {
    const list = $('chapter-list');
    if (!list) return false;
    if (locator.mode === 'switch') {
      const active = document.activeElement;
      if (!active || typeof active.closest !== 'function') return false;
      if (!active.closest('#chapter-list')) return false;
      const item = list.querySelector(`.chapter-item[data-index="${locator.index}"]`);
      if (!item || typeof item.focus !== 'function') return false;
      item.focus();
      return true;
    }
    const items = Array.from(list.querySelectorAll('.chapter-item'));
    let at;
    if (locator.mode === 'id') {
      at = state.chapters.findIndex((c) => c.id === locator.id);
      if (at < 0) return false;
    } else {
      if (!items.length) return false;
      const want = Number.isFinite(locator.position) ? Math.floor(locator.position) : 0;
      at = Math.max(0, Math.min(want, items.length - 1));
    }
    listKeyboard.applyTabStops(items, at);
    const el = items[at];
    if (!el) return false;
    if (typeof el.focus === 'function') el.focus();
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    return true;
  }

  // ---------- 章节列表 ----------
  // 2026-11-10 卷章目录重设计的显示层整段已迁到 renderer/chapter-directory-ui.js（WP17 A3 第一刀，
  // 审计 #20）；装配 / 入口见「章节列表 / 卷章目录显示层」接线处，这里不再放实现。

  // 章节栏当前应该显示多少条：折叠的卷不渲染；volumeId 指向不存在的卷按「未分卷」算
  // （和下面 renderChapterList 的 bucketing 同一套规则，切章快路径用它判断列表是否过期）。
  // 筛选时只数命中的章，且所有卷都展开（与 renderChapterList 里 filtering 分支一致）。
  function visibleChapterCount() {
    const volumes = volumeList();
    const ids = new Set(volumes.map((volume) => volume.id));
    const filtering = chapterFilterActive();
    let count = 0;
    state.chapters.forEach((chapter, index) => {
      if (filtering) {
        if (chapterIndexMatchesFilter(index)) count += 1;
        return;
      }
      if (!volumes.length) {
        count += 1;
        return;
      }
      const volumeId = chapterVolumeId(chapter);
      const key = volumeId && ids.has(volumeId) ? volumeId : '';
      if (!state.collapsedVolumes.has(key)) count += 1;
    });
    return count;
  }

  // 切章只改「当前章」高亮，不重建整条列表（v0.9 A-2）。
  // 大书 1000 条整表重建一次十几毫秒，而切章时章节没增删、顺序没变、折叠状态也没变——
  // 唯一要变的就是 active / dirty 两个 class。
  // 正确性优先，两道核对都对得上才走快路径：
  //   ① 列表里的条目数 == 当前应该显示的条数（新建 / 删除章节会让它变）；
  //   ② 当前章那一条的 chapter id == state.chapters[state.index].id（换书 / 重排会变）。
  // 任一对不上、或当前章在折叠的卷里（列表里没有这一条）就退回整表重建，和旧行为一致。
  function syncActiveChapterItem() {
    const list = $('chapter-list');
    if (!list) return;
    const current = state.chapters[state.index];
    const next = current ? list.querySelector(`.chapter-item[data-index="${state.index}"]`) : null;
    const rendered = list.querySelectorAll('.chapter-item').length;
    const expectedId = current ? String(current.id == null ? '' : current.id) : '';
    if (!next || rendered !== visibleChapterCount() || next.dataset.chapterId !== expectedId) {
      // 筛选是「找章」的临时视图：切到的章不在筛选结果里时（Ctrl+PgDn / 命令面板 / 跳章），
      // 收起筛选再重建，保证目录里始终有当前章可看。只在「本来就要整表重建」的兜底里清，
      // 正常切章仍走下面的快路径（不重建 1000 条）。
      if (state.chapterFilter && !chapterIndexMatchesFilter(state.index)) {
        state.chapterFilter = '';
        syncChapterFilterUi();
      }
      renderChapterList();
      return;
    }
    const previous = list.querySelector('.chapter-item.active');
    if (previous && previous !== next) {
      previous.classList.remove('active', 'dirty');
      previous.tabIndex = -1;
    }
    // 拍板 #16a：重开一本书到非第一章时，openBookByPath 先 renderChapterList()（那时还没有当前章，
    // ensureTabStop 把第 1 条设成 tabIndex 0），随后才 loadChapterAt(startIndex) 走到这里。
    // 第 1 条这时还没有 .active，上面的 previous 抓不到它 —— 不清掉就会留下两个 Tab 停留点。
    // 按属性查一次即可（tabIndex 会反射到 tabindex 属性），比全表扫更省。
    const staleStop = list.querySelector('.chapter-item[tabindex="0"]');
    if (staleStop && staleStop !== next) staleStop.tabIndex = -1;
    next.classList.add('active');
    cachedActiveChapterItem = next; // 1.6.0 A5/P-09：切章快路径同步「当前章条目」缓存
    next.classList.toggle('dirty', Boolean(state.dirty));
    next.tabIndex = 0; // roving tabindex：Tab 停留点跟着当前章走（v0.9 A-5b）
    next.scrollIntoView({ block: 'nearest' });
    // 快路径同样要更新「回到当前章」浮标 / 折叠卷的当前卷标记（切章后旧状态会留在原地）
    syncCurrentVolumeMarker();
    updateCurrentChapterPill();
  }

  // B5（审计 P5）：保存后只更新「当前章这一条」的字数节点 + tooltip，不再整表重建
  // （千章书每次 Ctrl+S 都重建 1000 条）。下一章的 tooltip 里有「比上章短」，本文字数变了也要跟着变，
  // 所以顺带更新下一条。列表和章节数组对不上（条目被折叠 / 新建删章 / 换书）就返回 false，
  // 调用方退回 renderChapterList()，正确性优先。
  function syncChapterItemChars(index) {
    const list = $('chapter-list');
    const chapter = state.chapters[index];
    if (!list || !chapter) return false;
    const item = list.querySelector(`.chapter-item[data-index="${index}"]`);
    if (!item || item.dataset.chapterId !== String(chapter.id == null ? '' : chapter.id)) return false;
    const chars = chapterCharsOf(chapter);
    let charsEl = item.querySelector('.chapter-chars');
    if (chars == null) {
      if (charsEl) charsEl.remove();
    } else {
      if (!charsEl) {
        charsEl = document.createElement('span');
        charsEl.className = 'chapter-chars';
        item.appendChild(charsEl);
      }
      charsEl.textContent = editorLogic.formatCharsShort(chars);
      charsEl.title = `本章 ${formatCount(chars)} 字（书目缓存；保存后更新）`;
    }
    item.title = chapterItemTitleText(chapter, index);
    // 概览行的总字数也跟着这一条更新（千章书只重算一次累加，不重建目录）
    renderBookMeta();
    return true;
  }

  function syncChapterCharsAfterSave(index) {
    const ok = syncChapterItemChars(index);
    if (ok && index + 1 < state.chapters.length) syncChapterItemChars(index + 1);
    return ok;
  }

  // B17（v1.8.0 WP-29）：改名 / 改状态 / 改备注后只更新「这一条」章节卡片，不整表重建。
  // 改前这些操作都调 renderChapterList()（千章书重建 1000 条，与保存 / 切章已有的快路径口径不一致）。
  // 正确性优先：筛选生效（命中集合可能随章名变化）、条目对不上（新建 / 删章 / 折叠 / 换书）、
  // 备注标记需要增删（DOM 顺序要挪）时一律返回 false，调用方退回整表重建。
  function syncChapterItemInfo(index) {
    const list = $('chapter-list');
    const chapter = state.chapters[index];
    if (!list || !chapter) return false;
    if (chapterFilterActive()) return false;
    const item = list.querySelector(`.chapter-item[data-index="${index}"]`);
    if (!item || item.dataset.chapterId !== String(chapter.id == null ? '' : chapter.id)) return false;
    const status = chapterStatus(chapter);
    const note = chapterNote(chapter);
    const noteMark = item.querySelector('.chapter-note-mark');
    if (Boolean(note) !== Boolean(noteMark)) return false;
    for (const className of Array.from(item.classList)) {
      if (className.startsWith('status-')) item.classList.remove(className);
    }
    item.classList.add(`status-${status}`);
    const label = chapterListLabel(index, chapter.name);
    const title = chapterTitle(index, chapter.name);
    item.dataset.status = status;
    item.dataset.title = title;
    item.title = chapterItemTitleText(chapter, index);
    item.setAttribute('aria-label', `打开${title}`);
    const dot = item.querySelector('.chapter-status-dot');
    if (dot) dot.title = `状态：${CHAPTER_STATUS_LABELS[status]}（右键可改）`;
    const nameEl = item.querySelector('.chapter-name');
    if (nameEl) nameEl.textContent = label.name;
    if (noteMark) noteMark.title = `备注：${note}`;
    // 多选状态也可能刚被清掉（批量改状态后 selectedIds 置空）：一并同步，不留给下次重建
    const selected = chapterSelectionLib.isSelected(chapterSelectionSnapshot(), chapter.id);
    item.classList.toggle('selected', selected);
    item.setAttribute('aria-pressed', selected ? 'true' : 'false');
    renderBookMeta();
    markCommandsDirty();
    syncChapterBatchBar();
    updateCurrentChapterPill();
    return true;
  }

  // B17：卷改名只改卷头文字（卷内章数 / 字数 / 章节顺序都不变），不整表重建。
  // 筛选生效时不走（卷头在筛选视图里有「命中 / 共 N 章」两套数字，重建口径更简单可靠）。
  function syncVolumeHeaderName(volumeId) {
    const list = $('chapter-list');
    if (!list || chapterFilterActive()) return false;
    const key = volumeId || '';
    const row = list.querySelector(`.volume-item[data-volume-id="${key}"]`);
    if (!row) return false;
    const nameEl = row.querySelector('.volume-name');
    if (!nameEl) return false;
    nameEl.textContent = volumeDisplayName(volumeId);
    renderVolumeToggle();
    return true;
  }

  // 卷册页首（v1.0 方向 C）：只在写作页显示，内容和顶栏章名同源；
  // 排字 / 卷名都走渲染层，不改正文、不改书目、不写盘。
  function renderPageHead() {
    const head = $('page-head');
    const volEl = $('page-head-vol');
    const titleEl = $('page-head-title');
    if (!head || !volEl || !titleEl) return;
    const chapter = state.chapters[state.index];
    if (!state.bookPath || !chapter) {
      head.classList.add('hidden');
      volEl.textContent = '';
      titleEl.textContent = '';
      return;
    }
    head.classList.remove('hidden');
    const volume = chapterVolumeId(chapter) ? volumeById(chapterVolumeId(chapter)) : null;
    const volumeName = volume && String(volume.name || '').trim();
    volEl.textContent = volumeName ? volumeName : '';
    volEl.classList.toggle('hidden', !volumeName);
    // 页首标题只是「第N章 名字」的展示版：把模板里的全角冒号换成空格，余下与顶栏同源
    titleEl.textContent = chapterTitle(state.index, chapter.name).replace('：', ' ');
  }

  function renderEditorHeader() {
    if (!state.chapters.length || state.index < 0) {
      $('chapter-title').textContent = '';
      renderPageHead();
      updateFocusBar();
      return;
    }
    $('chapter-title').textContent = chapterTitle(state.index, state.chapters[state.index].name);
    renderPageHead();
    // 专注模式下顶栏是隐藏的，章名显示在极简退出条上
    updateFocusBar();
  }

  // ---------- 状态栏（v0.9 B-5 第七刀：整段搬到 renderer/statusbar-ui.js） ----------
  // 本章字数（含超大单章 400ms 防抖）/ 选中字数两段整段搬走，行为一字未改。
  // 这里只剩接线：三个入口按原名被章节列表 / 写作时长 / 编辑器小件 / 测试钩子取用。
  const statusbarUi = statusbarUiModule.create({
    $, state, editorEl, formatChars, formatCount, chaptersLib, editorLogic, call, api, toast, openModal, loadChapterAt, staleGuard
  });
  const { chapterCharsOf, renderCharCount, renderSelectionStats } = statusbarUi;

  // 保存态（1.3.0 T7）：四态文案 / 圆点 / 成功 2s 淡化 / 失败点重试整段在 save-status-ui.js 里。
  // saveCurrent 是函数声明（会提升），装配时引用没问题；重试仍然走同一条保存路径（非静默）。
  const saveStatusUi = saveStatusUiModule.create({ $, state, formatClock, saveCurrent });
  // 保存失败的两个救稿出口（审计修复 #5 V301 / #6 V302）：对话框 / 覆盖 / 另存 / 复制 / 重载
  // 全在 save-rescue-ui.js 里；这里只装配（saveCurrent / loadChapterAt / chapterTitle 都是函数声明，已提升）。
  const saveRescueUi = saveRescueUiModule.create({
    state, api, call, openModal, toast, editorEl, saveCurrent, loadChapterAt, chapterTitle
  });

  // 撤销层（1.4.0 P0-2）：删除章节等「确认型」动作直接执行后登记一条撤销（10 秒窗口）。
  // 纯逻辑（单槽 / TTL / 键位判定）在 undo-action.js，条子渲染在 undo-ui.js；
  // 这里只装配：切书 / 回书架时 clear()，Ctrl+Z 命中时 runUndo()（见 bindEvents）。
  const undoUi = undoUiModule.create({ $, slot: undoActionModule.createUndoSlot(), toast });
  // 1.5.0 P0-5（审计 V-2）：撤销前的备份指纹核对（只读 api.listHistory，不改备份目录格式）。
  // 登记撤销时记指纹、撤销执行前核一次；清单读不到时登记侧不拦、执行侧取消（见 backup-guard.js）。
  const backupGuard = backupGuardModule.create({ call, api });

  // ---------- 命令面板（1.4.0 P0-3 / 规范 I-03：Ctrl+K） ----------
  // 一份 action 表的单一事实源：面板行尾键帽、按钮 tooltip、README 的快捷键表都指这里的 kbd。
  // 命令只调现有入口，不新写业务；章节 / 书是动态的，但条目按「数据版本」缓存
  // （1.5.0 P0-6 / O-1：千章书连续输入不重建对象，见 commandItemsForPalette / markCommandsDirty）。
  const commandRegistry = commandRegistryModule.createRegistry({});
  const commandPalette = commandPaletteModule.create({
    $,
    imeGuard,
    doc: document,
    registry: commandRegistry,
    items: () => commandItemsForPalette(),
    onRun: (item) => {
      runCommandItem(item);
    },
    onClose: (opener) => {
      // 关掉后把焦点还给打开它的元素；没有（或已经不可见）就交回编辑区 / 主题内容
      if (opener && typeof opener.focus === 'function' && opener.isConnected !== false) {
        opener.focus();
        return;
      }
      if (state.view === 'editor' && editorEl) {
        editorEl.focus();
        return;
      }
      const main = document.querySelector('main, .shelf-main, body');
      if (main && typeof main.focus === 'function') main.focus();
    }
  });
  // 数据一变就同时作废面板里的快照（面板只在打开 / 失效后的下一次重画时再取一次）。
  commandItemsCache.invalidate = () => commandPalette.invalidateItems();

  // ---------- 编辑器小件 ----------
  // 第 4 步九刀·第三刀：实现在 renderer/editor-marks-ui.js（模块头有契约），这里只装配与接线；
  const editorMarksUi = editorMarksUiModule.create({
    $, state, toast,
    persistMarks: (patch) => persistMarksToggle(patch),
    editor: { editorEl, editorLogic, getLongParagraphThreshold, caretColorLib, caretColorValue },
    find: { renderFindHighlights: () => renderFindHighlights(), syncFindOverlayScroll: () => syncFindOverlayScroll() },
    focus: { focusActive: () => focusActive(), scheduleTypewriterAlign: (delay) => scheduleTypewriterAlign(delay) },
    stats: { renderSelectionStats, formatCount },
    scroll: { scrollCaretIntoView }
  });
  const { scheduleMarksRender, hideEditorMarks, syncEditorOverlay, renderEditorMarks, renderMarksMenu, syncMarksScroll, updateCaretParagraph, jumpToNextLongParagraph, jumpParagraph, renderCaretColorRow, setMarksToggle, toggleMarks, setupEditorMarks } = editorMarksUi;

  // ---------- 查找 / 替换核心 ----------
  // 第 4 步九刀·补刀 9a：实现在 renderer/find-ui.js（模块头有契约），这里只装配与接线；
  const findUi = findUiModule.create({
    $, state, api, call, toast, recordFallbackWrite,
    longOpLogic,
    staleGuard,
    imeGuard,
    find: { findLogic, editorEl, syncEditorOverlay, scrollCaretIntoView, onEditorInput },
    nav: { chapterTitle, switchChapter: (index) => switchChapter(index), loadChapterAt, currentChapterLabel: () => currentChapterLabel(), hideHeaderMenus },
    collab: { askUnsaved, saveCurrent, openModal, refreshShelf, renderChapterList, reloadAfterPartialFailure, runReplaceOne,
      registerUndo: (label, run, meta) => undoUi.activate(label, run, meta),
      closeProofreadPanel: () => closeProofreadPanel(), renderFindBookmarks: () => renderFindBookmarks(),
      refreshFindBookmarks: () => refreshFindBookmarks(), refreshReplaceBackups: () => refreshReplaceBackups() }
  });
  const { findPanelOpen, findSessionActive, findSessionMatchesOptions, clearFindSession, renderFindStatusChip, syncFindOverlayScroll, renderFindHighlights, selectFindMatch, startFindSession, stepFind, openFindPanel, closeFindPanel, readFindOptions, runFind, runReplaceAll } = findUi;
  // ---------- 查找书签 ----------
  // 第 4 步九刀·补刀 9b：实现在 renderer/find-bookmark-ui.js（模块头有契约），这里只装配与接线；
  const findBookmarkUi = findBookmarkUiModule.create({
    $, state, api, call, toast,
    find: { bookmarksLib, chaptersLib, editorEl, readFindOptions, findSessionMatchesOptions, findPanelOpen, closeFindPanel, renderFindStatusChip, startFindSession, clearFindSession },
    nav: { switchChapter: (index) => switchChapter(index), openBookByPath }
  });
  const { renderFindBookmarks, refreshFindBookmarks, saveFindBookmark, deleteFindBookmark, jumpToFindBookmark, restoreFindBookmarkForCurrentChapter, setupFindBookmarkUi } = findBookmarkUi;

  // ---------- 专注模式 ----------
  // 第 4 步九刀·补刀 12：实现在 renderer/focus-mode-ui.js（模块头有契约），这里只装配与接线；
  const focusModeUi = focusModeUiModule.create({
    $, state,
    focus: { focusLogic, editorEl },
    marks: { scheduleMarksRender, syncMarksScroll },
    menus: { hideContextMenu, hideHeaderMenus, hideVolumeMenu }
  });
  const { focusActive, updateFocusBar, measureCaretTop, alignTypewriter, scheduleTypewriterAlign, resetCaretMeasureCache, setFocusMode, toggleFocusMode, setFocusTypewriter, setupFocusModeUi } = focusModeUi;

  // ---------- 阅读模式 ----------
  // 第 4 步九刀·第二刀：实现在 renderer/reading-ui.js（模块头有契约），这里只装配与接线；
  const readingUi = readingUiModule.create({
    $, state, api, call, toast,
    reading: { readingLogic, formatChars },
    view: { showView, hideContextMenu, hideVolumeMenu, hideHeaderMenus, editorEl, scheduleMarksRender, updateWindowTitle },
    chapterTitle
  });
  const { readingScrollEl, readingBlockElements, readingBlockIndexAt, readingLoadedIndexes, readingMeasureBlocks, readingCurrentIndex, readingVisibleIndex, readingNearBottom, setReadingPref, updateReadingUi, readingScrollToBlock, scheduleReadingScrollCheck, readingGo, readingJumpTo, openReadingMode, exitReadingMode } = readingUi;

  // ---------- 每日字数统计 / 码字日历（v0.9 B-5 第三刀：整段搬到 renderer/stats-ui.js） ----------
  // 书架头 / 状态栏的今日字数与目标、设置里的近 30 天柱状图、码字日历（月视图 / 连续天数 /
  // 月度汇总）两个相邻分区整段搬走，行为一字未改。这里只剩接线：5 个入口绑成模块级 const，
  // 事件绑定 / 设置打开 / 测试钩子照旧按名字取（testHooksScope 的 4 个键一字未动）。
  // 下面这个薄封装必须留在渲染层：测试钩子的 host 契约里还有 calendarSummaryText，
  // tests/stats-logic.test.js 的静态闸门按字面钉住它；模块经 host 回调使用。
  function calendarSummaryText(view) {
    return statsLogic.calendarSummaryText(view, statsFormat);
  }
  // stats-logic 的三个调用点同样被静态闸门按字面钉在渲染层，经 host 回调交给模块（结果与时机不变）。
  const statsUi = statsUiModule.create({
    $, api, call, state, statsLogic, statsFormat, formatChars, formatCount, formatDuration, staleGuard,
    writeDurationEnabled: () => writeDurationEnabled(), renderDurationSettings: () => renderDurationSettings(), renderWriteTimer: () => renderWriteTimer(), calendarSummaryText,
    calendarCells: (view) => statsLogic.calendarCells(view, statsFormat),
    shiftCalendarCursor: (cursor, delta) => statsLogic.shiftCalendarCursor(cursor, delta),
    calendarStreakLabel: () => statsLogic.calendarStreakLabel(state.streak)
  });
  const { refreshStats, renderStatsUi, renderStatsChart, shiftStatsCalendar, goToCurrentCalendarMonth } = statsUi;
  // 1.6.0 F2：统计筛选 / CSV 是设置页里那一块自己的入口（不进上面那 5 个通用入口）
  const { applyStatsFilter, buildStatsCsv, setupStatsUi } = statsUi;

  // 大段插入（试用分支 B）的一次性撤销快照：{ before, after, start, end, bookPath, chapterId }。
  // 只有「这次插入走了 .value 整串赋值、没进原生撤销栈」时才存在；下一次真实输入 / 切换章节立刻作废，
  // 免得点「撤销」把作者后来打的字一起退掉。审计修复 #7（V401）：bookPath / chapterId 是设置快照
  // 那一刻的身份——执行撤销时逐字核对，换书 / 换章（含载章失败后的遮罩态）一律作废，绝不跨书串台。
  let bulkWriteUndo = null;

  // 审计修复 #39（V402）：兜底「整串赋值」的一次性快照，形状与 bulkWriteUndo 相同（多一个 label 用于文案）。
  // 触发面：execCommand('insertText') 失败 / 结果不符时，各处都退回 `editorEl.value = 期望值` —— 这与
  // bulk 分支是同一种「清空浏览器撤销栈（连带之前整章的编辑历史）」的副作用，以前却只有 bulk 有快照与
  // 提示。现在 insertIntoBody / applyChapterTemplate / runReplaceOne 三处直接记这里；fragments-ui /
  // tidy-card-ui 两个模块通过 host.recordFallbackWrite() 汇报，用的是同一份快照（同一套身份核对与 Ctrl+Z）。
  // 下一次真实输入 / 换章 / 换书一律作废；执行撤销时核对 bookPath / chapterId，绝不跨书串台。
  let fallbackWriteUndo = null;

  // 剪贴板面板「正文」按钮：把一条记录插到**当前打开章节**的光标处（有选区就替换选区）。
  // 为什么先把焦点交给编辑区：原生 insertText 只对真正拿到焦点的文本框生效，
  // 而面板是模态弹层、点按钮后焦点在弹层里；renderer/dialog-focus.js 明确「不抢程序化焦点」，
  // 所以这里可以临时 focus 编辑区、插完再 blur 回去——与「替换这一处」/ 灵感碎片插入同一条路。
  // preventScroll：只借焦点执行原生输入，别让编辑区把页面滚到别处（面板是 fixed 弹层）。
  // 只改编辑区、只标脏，不自动保存（与「插入碎片」/「替换这一处」的既有口径一致）；
  // 面板保持打开；插入成功后由 capture-ui 消费这一条记录（2026-11-08：正文也「用过就消失」）。
  function insertIntoBody(text) {
    if (!state.bookPath || state.view !== 'editor' || !state.chapters.length) {
      return { ok: false, message: '没有打开的书，插入正文前请先打开一章' };
    }
    if (state.loading) return { ok: false, message: '正在切换章节，请稍候再试' };
    const value = String(text == null ? '' : text);
    if (!value.trim()) return { ok: false, message: '这一条没有可插入的内容' };
    const before = editorEl.value;
    const size = before.length;
    // 选区以编辑区当前记录为准（textarea 失焦后 selectionStart / selectionEnd 仍然保留）：
    // 面板打开前作者停在哪儿就插到哪儿；有选区就把选区替换掉。
    const rawStart = Number.isFinite(editorEl.selectionStart) ? editorEl.selectionStart : size;
    const rawEnd = Number.isFinite(editorEl.selectionEnd) ? editorEl.selectionEnd : rawStart;
    const start = Math.max(0, Math.min(Math.round(rawStart), size));
    const end = Math.max(start, Math.min(Math.round(rawEnd), size));
    const expected = before.slice(0, start) + value + before.slice(end);
    // 字数只算一次（两条写入通道共用同一口径；静态闸门钉住全库字数调用都走 core/chapters.js 的 countChars）。
    const chars = chaptersLib.countChars(value);
    // 试用分支 B（粘贴大段优化）：长串插入不走 Chromium 的编辑管线。execCommand('insertText') /
    // 原生粘贴对十几万字是逐行强制布局的秒级路径（Chromium issue 341564372）；直接把整串赋给
    // .value 只排一次版。代价是浏览器会把撤销栈整个清空（不只是这一步，之前的编辑历史也没了），
    // 所以留一次性快照 + 可点的「撤销」+ 正文上的第一下 Ctrl+Z 拦截；下一次真实输入时快照作废
    // （onEditorInput 里清）。阈值以下的行为一个字节都不变。
    if (editorLogic.shouldBulkWrite(value)) {
      try {
        editorEl.focus({ preventScroll: true });
      } catch {
        editorEl.focus(); // 个别实现不认 options：退回无参 focus（最多多滚一下）
      }
      editorEl.setSelectionRange(start, end);
      editorEl.value = expected;
      // 统一走 onEditorInput：标脏 / 字数 / 状态栏 / 标记层全按正常输入刷新（不写盘）。
      onEditorInput();
      const caret = start + value.length;
      editorEl.setSelectionRange(caret, caret);
      // 整串赋值不会像原生输入那样把光标滚进视野：自己滚一下，插完就能看到开头 / 光标位置。
      scrollCaretIntoView(caret);
      // 焦点还给面板（面板保持打开）；blur 不改内容，也不会触发保存。
      editorEl.blur();
      bulkWriteUndo = { before, after: expected, start, end, bookPath: state.bookPath, chapterId: state.loadedChapterId };
      toastActionable(
        `已插入 ${formatCount(chars)} 字（大段插入会清掉撤销历史：Ctrl+Z 或「撤销」退回到插入前）`,
        '撤销',
        undoBulkWrite
      );
      return { ok: true, chars, bulk: true, undoable: true };
    }
    try {
      editorEl.focus({ preventScroll: true });
    } catch {
      editorEl.focus(); // 个别实现不认 options：退回无参 focus（最多多滚一下）
    }
    editorEl.setSelectionRange(start, end);
    // 原生输入统一走唯一的 replaceEditorTextNative（renderer-dedupe 的 C3 闸门只留一份
    // 原生 insertText 实现）：报成功但值没变（焦点被别的层抢走 / 输入法状态异常）时
    // 也按**结果**再核一次，不一致就手动拼接兜底（会丢原生撤销链，但绝不丢内容）。
    const inserted = replaceEditorTextNative(value);
    // 审计修复 #39（V402）：兜底路会整串赋值 —— 同样清空浏览器撤销栈，记一次性快照并提示
    // （提示放在 onEditorInput 之后，否则这里自己的输入处理会把刚记的快照清掉）。
    const fallbackUsed = !inserted || editorEl.value !== expected;
    if (fallbackUsed) editorEl.value = expected;
    // 统一走 onEditorInput：标脏 / 字数 / 状态栏 / 标记层全按正常输入刷新（不写盘）。
    onEditorInput();
    if (fallbackUsed) recordFallbackWrite({ before, after: expected, start, label: '插入正文' });
    // 光标停在插入内容末尾：连着点两次「正文」不会把第二段插到第一段前面。
    editorEl.setSelectionRange(start + value.length, start + value.length);
    // 焦点还给面板（面板保持打开）；blur 不改内容，也不会触发保存。
    editorEl.blur();
    return { ok: true, chars };
  }

  // 大段插入的「撤销」（试用分支 B 的配套）：把整章正文还原成插入前的样子，只改编辑区、仍是未保存。
  // 只在快照还在时有效；作者后来打的字 / 切了章都会让快照作废，不会把后来的内容一起退掉。
  function undoBulkWrite() {
    if (!bulkWriteUndo) {
      toast('这次大段插入已经不能整段撤销了（中间又改过正文）', 'warn');
      return false;
    }
    // 审计修复 #7（V401）：快照只对「设置它时那一本书 + 那一章」有效。同文件其余 7 处撤销闭包
    // 一律以 state.bookPath 核对身份，这条 v1.8.0 新链路以前只信自己 —— 换书后（尤其新书载章
    // 失败、编辑区只读遮罩时）按 Ctrl+Z 会把上一本整章正文写进眼前这个空编辑区。不符即作废，
    // 编辑区一个字节都不动。
    if (bulkWriteUndo.bookPath !== state.bookPath || bulkWriteUndo.chapterId !== state.loadedChapterId) {
      bulkWriteUndo = null;
      toast('这次大段插入已经不能整段撤销了（换过书或换过章）', 'warn');
      return false;
    }
    const snapshot = bulkWriteUndo;
    bulkWriteUndo = null;
    editorEl.value = snapshot.before;
    onEditorInput();
    const caret = Math.max(0, Math.min(snapshot.start, editorEl.value.length));
    editorEl.setSelectionRange(caret, caret);
    scrollCaretIntoView(caret);
    toast('已撤销这次大段插入（仍是未保存）');
    return true;
  }

  // 审计修复 #39（V402）：兜底整串赋值统一记账。info = { before, after, start, label }：
  // before / after 是赋值前后的正文，start 是写入起点（撤销后光标回到这里），label 进提示文案。
  // 与 bulk 分支同一套配套（一次性快照 + 可点「撤销」+ 正文上第一下 Ctrl+Z 拦截），
  // 差别只是这次写入来自 execCommand 的兜底而不是大段插入。值没变时不记（没有需要撤销的东西）。
  function recordFallbackWrite(info) {
    const source = info && typeof info === 'object' ? info : {};
    const before = String(source.before == null ? '' : source.before);
    const after = String(source.after == null ? '' : source.after);
    if (after === before) return false;
    const chapter = state.chapters[state.index];
    const label = typeof source.label === 'string' && source.label ? source.label : '这次写入';
    const start = Number.isFinite(source.start) ? Math.round(source.start) : 0;
    fallbackWriteUndo = {
      before,
      after,
      start: Math.max(0, Math.min(start, before.length)),
      bookPath: state.bookPath,
      chapterId: chapter && chapter.id ? chapter.id : null,
      label
    };
    toastActionable(
      `${label}没能走原生输入，已改为整串写入：浏览器的撤销历史已清空（之前整章的编辑记录也一起没了）；` +
        'Ctrl+Z 或「撤销」可退回写入前',
      '撤销',
      undoFallbackWrite
    );
    return true;
  }

  // 兜底写入的「撤销」：与 undoBulkWrite 同一套身份核对（书 + 章）与内容核对（还是写入后的样子）。
  function undoFallbackWrite() {
    if (!fallbackWriteUndo) {
      toast('这次兜底写入已经不能撤销了（中间又改过正文）', 'warn');
      return false;
    }
    const chapter = state.chapters[state.index];
    const chapterId = chapter && chapter.id ? chapter.id : null;
    if (fallbackWriteUndo.bookPath !== state.bookPath || fallbackWriteUndo.chapterId !== chapterId) {
      fallbackWriteUndo = null;
      toast('这次兜底写入已经不能撤销了（换过书或换过章）', 'warn');
      return false;
    }
    if (editorEl.value !== fallbackWriteUndo.after) {
      fallbackWriteUndo = null;
      toast('这次兜底写入已经不能撤销了（中间又改过正文）', 'warn');
      return false;
    }
    const snapshot = fallbackWriteUndo;
    fallbackWriteUndo = null;
    editorEl.value = snapshot.before;
    onEditorInput();
    const caret = Math.max(0, Math.min(snapshot.start, editorEl.value.length));
    editorEl.setSelectionRange(caret, caret);
    scrollCaretIntoView(caret);
    toast(`已撤销${snapshot.label}（仍是未保存）`);
    return true;
  }

  // 剪贴板捕获（P0）：createCaptureUi(host) 一次装配，host 正好 10 个成员（契约 §5；T1 的
  // REQUIRED_HOST 同步为这 10 个键，第 10 个 staleGuard 是 WP-15 的 C16 / C36 新增的）。审计修复 #41（V404）
  // 把两处注释从漂移的「9」改成实际值。insertIntoBody 用函数声明，装配时引用已提升。
  // 装配点必须放在 statsUi 之后：renderStatsUi 是上面那一行解构出来的 const。
  // 「打开面板前收起顶栏菜单」不进 host：事件绑定 / 测试钩子走 open(text, { beforeOpen: hideHeaderMenus })。
  const captureUi = captureUiModule.create({
    $, state, api, call, toast, saveCurrent, loadChapterAt, renderStatsUi, insertIntoBody, staleGuard,
    // 五-H5（L-F6）：可选成员——统一「过渡前保存」原语（保存回执后复核 dirty）。不是契约 §5 的必需成员。
    saveForTransition
  });

  // ---------- 写作时长（状态栏秒表） ----------
  // 第 4 步九刀·补刀 11：实现在 renderer/write-timer-ui.js（模块头有契约），这里只装配与接线；
  const writeTimerUi = writeTimerUiModule.create({
    $, state, api, call,
    common: { formatStopwatch, formatDuration, WRITE_TIMER_FLUSH_MS },
    statsUi: { renderStatsUi }
  });
  const { writeDurationEnabled, renderWriteTimer, renderDurationSettings, startWriteTimer, pauseWriteTimer, flushWriteTimer, resetWriteTimer, applyWriteTimerConfig, writeTimerTodaySeconds, writeTimerSessionSeconds, writeTimerUnsentMs, setupWriteTimerUi } = writeTimerUi;

  // 保存态四态 / 状态栏收尾 / 未保存上报都在 renderer/save-chain-ui.js（WP17 A3 第二刀）。
  function updateStatus(options) { return saveChainUi.updateStatus(options); }

  // C5（审计 E5/S5）：关窗「不保存退出」= 作者主动丢弃未保存内容——清脏与上报在保存链模块的
  // handleCloseRequest 里（只有它一个调用点），编排器不再留同名包装。

  // ---------- 编辑区事件 ----------
  function onEditorInput() {
    // 试用分支 B：真实输入 / 其它程序化写入都让「撤销这次大段插入」的快照作废，
    // 免得点撤销把作者后来打的字一起退掉。审计修复 #39（V402）：兜底写入的一次性快照同理。
    bulkWriteUndo = null;
    fallbackWriteUndo = null;
    // 正文改了，查找高亮的位置就对不上了：立刻结束会话（不写盘、不提示，重新查一次即可）。
    // 如果这次高亮来自书签，书签本身不动，Ctrl+S 保存后会按新正文重新扫描定位。
    const wasBookmark = state.find.fromBookmark;
    if (state.find.total) clearFindSession();
    if (wasBookmark && findPanelOpen()) {
      $('find-summary').textContent = '正文改过：高亮先收起，按 Ctrl+S 保存后会按新正文重新定位书签';
    }
    // 朗读读的是「打开那一刻」的正文：改了字就停，别让进度 / 跟随高亮对不上新正文
    if (state.tts.open) {
      closeTtsBar();
      toast('正文已修改，朗读已停止');
    }
    state.lastEditAt = Date.now();
    const dirty = editorEl.value !== state.baseText;
    if (dirty !== state.dirty) state.dirty = dirty;
    if (state.dirty) state.saveError = null;
    const activeItem = activeChapterItem();
    if (activeItem) activeItem.classList.toggle('dirty', state.dirty);
    // 1.6.0 A5/P-09：输入路径走 200ms 防抖（每敲一个字全章重算字数太贵）
    updateStatus({ typing: true });
    renderSelectionStats();
    // 输入法拼字中先不重画标记层（I 键过程中的中间态会闪），拼完 compositionend 再画
    if (!state.marks.composing) scheduleMarksRender();
    // 打字机模式：打完字把光标行放回上方约 1/3 处（只调滚动，不改字）
    if (focusActive() && state.focus.typewriter) scheduleTypewriterAlign(30);
  }

  // 用原生 insertText 替换编辑区「当前选区」：保住原生 Ctrl+Z 撤销链。
  // 返回 execCommand 是否报告成功；**内容对不对由调用方自己核**（有的场景要整段校验值，有的只拼接），
  // execCommand 不可用 / 被浏览器拒绝时返回 false，由调用方走各自的手动兜底（丢撤销链但不丢内容）。
  function replaceEditorTextNative(text) {
    try {
      return document.execCommand('insertText', false, text);
    } catch {
      return false;
    }
  }

  // WP-03（C9）：载章状态机（世代令牌 + 成功才提交 + 失败保持遮罩）整段在 renderer/save-chain-ui.js。
  // 这里只留同名包装；23 个调用点 / 测试钩子一个字都不改。
  async function loadChapterAt(index) { return saveChainUi.loadChapterAt(index); }

  // 保存后的全书校验（审计 F2）：挪到后台跑，不 await、不阻塞保存热路径。
  // - 发现缺章才 warn，文案与以前完全一致（save-logic.js 里单测锁住）；
  // - 校验失败（书被挪走 / 权限 / 临时读失败）只记日志：保存本身已经成功，
  //   以前那句「已保存当前章（全书校验失败）」会误报，现在不再打扰作者。
  // 测试模式（?test=1）可以用 __cwTest.setTestVerifyBook 替换这一趟，E2E 靠它验证
  // 「保存不等校验」「后台失败不提示」两个时序。
  let testVerifyBook = null;
  // WP-01/C1 验收用：?test=1 时 E2E 用 setTestSaveDelay 把保存 IPC 拖慢，制造「保存在途」窗口；
  // 正常启动恒为 null，保存热路径就是原来的 call(api.saveChapter, ...)。
  let testSaveChapter = null;
  // WP3/E-N4 验收用：?test=1 时 E2E 用 setTestFindNextDelay 把「查找下一处」IPC 拖慢，制造回执迟到窗口；
  // 正常启动恒为 null，替换热路径就是原来的 call(api.findNext, ...)。
  let testFindNext = null;

  // WP10（P-N2）：保存后的全书校验（单飞 / 合并）随保存链模块走；入口只在模块内部被 saveCurrent 调用，
  // 没有外部调用点，编排器不留同名包装。

  async function saveCurrent(options) { return saveChainUi.saveCurrent(options); }

  // ---------- 切换 / 新建 / 重命名 / 删除（v0.9 B-5 第六刀：随上两块一起搬到 renderer/shelf-ui.js） ----------
  // 切章 / 当前章节标签只剩接线；未保存拦截（askUnsaved）、保存与加载仍走本文件的函数。
  const { currentChapterLabel, switchChapter } = shelfUi;

  // ---------- Ctrl+G 跳章 ----------
  // 对话框 / 结果列表 / 「跳过去」整段搬到了 renderer/jump-ui.js（v0.9 B-5 第二刀：只搬不改行为）。
  // 匹配规则仍在主进程的 core/jump.js（单测覆盖）；切章仍走 switchChapter，未保存拦截照常生效。
  // 这里只剩接线：5 个入口绑成模块级 const，事件绑定 / Esc 动作表 / 测试钩子照旧按名字取。
  const jumpUi = jumpUiModule.create({
    api,
    $,
    call,
    state,
    chapterTitle,
    chaptersLib,
    CHAPTER_STATUS_LABELS,
    chapterStatus,
    switchChapter
  });
  const refreshJumpMatches = jumpUi.refreshJumpMatches;
  const scheduleJumpMatches = jumpUi.scheduleJumpMatches;
  const openJumpDialog = jumpUi.openJumpDialog;
  const closeJumpDialog = jumpUi.closeJumpDialog;
  const confirmJumpFromDialog = jumpUi.confirmJumpFromDialog;

  // ---------- 章节模板 / 分卷 / 批量动作（WP17 A3 第四刀：整段搬到 renderer/chapter-ops-ui.js） ----------
  // 22 个函数式单元（模板 4 / 分卷 11 / 批量 7）与行为注释整段搬走，只搬不改行为。
  // 这里只留同名包装（函数声明会提升）：事件绑定 / 右键菜单 / 命令面板 / 测试钩子 / 章节目录模块的
  // host 字面量全部按原名取，调用点零改动；模块的 create() 统一放在 bindEvents 之前的装配区。
  async function createChapterAt(insertIndex, nameOverride, volumeIdOverride) { return chapterOpsUi.createChapterAt(insertIndex, nameOverride, volumeIdOverride); }
  async function createVolumeFlow(nameOverride) { return chapterOpsUi.createVolumeFlow(nameOverride); }
  async function renameVolumeFlow(volumeId, nameOverride) { return chapterOpsUi.renameVolumeFlow(volumeId, nameOverride); }
  async function moveVolumeFlow(volumeId, delta) { return chapterOpsUi.moveVolumeFlow(volumeId, delta); }
  async function deleteVolumeFlow(volumeId, skipConfirm = false) { return chapterOpsUi.deleteVolumeFlow(volumeId, skipConfirm); }
  function openVolumeChooserInMenu(index) { return chapterOpsUi.openVolumeChooserInMenu(index); }
  async function moveChapterToVolume(index, volumeId) { return chapterOpsUi.moveChapterToVolume(index, volumeId); }
  async function renameChapterAt(index, nameOverride) { return chapterOpsUi.renameChapterAt(index, nameOverride); }
  async function deleteChapterAt(index, skipConfirm = false) { return chapterOpsUi.deleteChapterAt(index, skipConfirm); }
  async function setChapterStatusAt(index, status) { return chapterOpsUi.setChapterStatusAt(index, status); }
  async function deleteSelectedChapters() { return chapterOpsUi.deleteSelectedChapters(); }
  async function moveSelectedChaptersToVolume(volumeId) { return chapterOpsUi.moveSelectedChaptersToVolume(volumeId); }
  async function setSelectedChaptersStatus(status) { return chapterOpsUi.setSelectedChaptersStatus(status); }
  function exportSelectedChapters() { return chapterOpsUi.exportSelectedChapters(); }
  async function copySelectedChapters() { return chapterOpsUi.copySelectedChapters(); }
  async function editChapterNoteAt(index) { return chapterOpsUi.editChapterNoteAt(index); }

  // ---------- 导出 / 复制 ----------
  // 导出范围对话框 + TXT / EPUB / DOCX 三种导出流程 + 复制整本 / 复制本章，整段搬到了
  // renderer/export-ui.js（v0.9 B-5 第一刀：只搬不改行为）。这里只剩接线：
  //   - exportFormat 是模块级 let，模块通过 host 的 get / set 读写它（testHooksScope 的
  //     get exportFormat() 与 E2E 的 __cwTest.exportFormat() 口径一字未变）；
  //   - 9 个入口在这里绑成模块级 const，事件绑定 / Esc 注册表 / 测试钩子照旧按名字取。
  let exportFormat = 'txt';
  const exportUi = exportUiModule.create({
    api,
    $,
    editorEl,
    s2tLib,
    call,
    state,
    toast,
    staleGuard,
    volumeList,
    chapterVolumeId,
    hideExportMenu,
    formatCount,
    get exportFormat() {
      return exportFormat;
    },
    set exportFormat(value) {
      exportFormat = value;
    }
  });
  const readExportRange = exportUi.readExportRange;
  const refreshExportSummary = exportUi.refreshExportSummary;
  const scheduleExportSummary = exportUi.scheduleExportSummary;
  const openExportDialog = exportUi.openExportDialog;
  const closeExportDialog = exportUi.closeExportDialog;
  const confirmExportDialog = exportUi.confirmExportDialog;
  const copyBookFlow = exportUi.copyBookFlow;
  const copyChapterPlatformFlow = exportUi.copyChapterPlatformFlow;
  const openBookFolderFlow = exportUi.openBookFolderFlow;

  // ---------- 导入 / 删除小说（书架级操作） ----------
  // 导入方式询问 + 导入进度 + 删除书整段搬到了 renderer/import-ui.js（v0.9 B-5 第四刀：
  // 只搬不改行为）。这里只剩接线：导入进度的 toast 元素归模块所有（它自己建、自己删），
  // 事件绑定的进度监听问 hasImportProgress()（与原「没有进度元素就直接返回」等价）。
  const importUi = importUiModule.create({
    $, api, call, openModal, refreshShelf, state, toast
  });
  const setImportProgressText = importUi.setImportProgressText;
  const hasImportProgress = importUi.hasImportProgress;
  const importBooksFlow = importUi.importBooksFlow;
  const onImportClick = importUi.onImportClick;
  const deleteBookFlow = importUi.deleteBookFlow;

  // ---------- 返回书架 + 改名（v0.9 B-5 第十刀：两个相邻小分区整段搬到 renderer/shelf-nav-ui.js） ----------
  // 「返回书架」（未保存三选一 / 释放打开登记 / 清空当前书状态 / 切回全局显示设置 / 刷新书架）与
  // 「改名」（问书名 / 只改 书目.json 里的 title / 更新顶栏与窗口标题）整段搬走，行为一字未改。
  // 这里只剩接线：两个入口按原名被顶栏「返回」「改名」按钮的 click 绑定与测试钩子取用。
  const shelfNavUi = shelfNavUiModule.create({
    $, api, state, editorEl, askUnsaved, saveCurrent, currentChapterLabel, clearFindSession,
    effectiveConfig, applyEditorStyle, syncCaretParagraphFromConfig, applySidebarWidth,
    showView, refreshShelf, promptText, call, updateWindowTitle, toast,
    // 五-M9（SS-02）/ 五-H3：可选成员——回书架前等「保存在途 / 载章在途」落定（与切章同口径），
    // 保存走统一原语（保存回执后复核 dirty，仍脏就重新询问）。
    waitForSavingIdle, waitForLoadingIdle, saveForTransition
  });
  const { backToShelf, renameBookFlow } = shelfNavUi;

  // ---------- 全局 Esc 链 / 关窗清理（有序注册表，v0.9 B-4 / 外部审计 F6） ----------
  // 优先级（谁先接 Esc）和「谁参与关窗清理」都在 renderer/esc-registry.js（纯逻辑、Node 单测覆盖）。
  // 这里只做渲染层那两件事：① escProbe() 摊出「现在谁开着」；② escActions 把动作 id 落到关闭函数上。
  // 改顺序 / 加一层请改注册表，别再把 if 块抄回 keydown 里。
  // 弹层清单只有一份：renderer/backdrop-registry.js 的 LIST（17 层，1.8.0 WP-17 / 审计 C35）。
  // 这里只按 CLASS_LAYERS 摊 backdrop 字段；modal / command 两层另有状态源，见下面 probe 里的两行。
  // 新增 / 删除弹层请改注册表（tests/backdrop-registry.test.js 会与 index.html 对账），别在本文件抄 id。

  function escProbe() {
    const probe = {
      // 通用询问框可能压在别的弹层之上（z-index 300），所以注册表里排第一
      modal: Boolean(state.modal),
      modalInput: Boolean(state.modal && state.modal.opts && state.modal.opts.input),
      historyPreview: Boolean(state.history && state.history.preview),
      // 命令面板（1.4.0 P0-3）：锁键层，和设置那批同口径
      command: Boolean(commandPalette && commandPalette.isOpen()),
      formatCard: formatCardOpen(),
      displayMenu: displayMenuOpen(),
      findTotal: Number((state.find && state.find.total) || 0),
      // 撤销条（1.5.0 P0-4 / H-5）：最低优先级的一层 —— 只接 Esc，弹层开着时 Esc 仍先关弹层。
      undoBar: Boolean($('undo-bar') && !$('undo-bar').classList.contains('hidden')),
      // 章节多选（1.5.0 功能-1）：排在撤销条之后、兜底之前；右键菜单开着时先收菜单。
      chapterSelection: state.selectedIds.size > 0,
      // 右键菜单比撤销条更「在上面」：Esc 先收菜单，下一按才收条子。
      contextMenu: Boolean($('context-menu') && !$('context-menu').classList.contains('hidden')),
      tts: Boolean(state.tts && state.tts.open),
      reading: state.view === 'reading',
      focus: Boolean(state.focus && state.focus.on)
    };
    // 弹层字段全部按注册表的 CLASS_LAYERS 现算（顺序 / 数量只有注册表一份，WP-17 / 审计 C35）。
    for (const name of backdropRegistry.CLASS_LAYERS) {
      probe[name] = backdropRegistry.isOpen($, name);
    }
    return probe;
  }

  // 动作表：每个 id 只做「关掉 / 收起」这一件副作用，判断权在注册表。
  const escActions = {
    'modal-cancel': () => closeModal({ action: state.modal.opts.cancelValue }),
    'modal-confirm': () => {
      const okButton = $('modal-buttons').querySelector('button[data-value="ok"]');
      if (okButton) okButton.click();
    },
    'close-conflict': () => closeConflictDialog(),
    'close-bookinfo': () => closeBookInfoDialog(),
    'close-group-manage': () => closeGroupManageDialog(),
    'close-history-preview': () => closeHistoryPreview(),
    'close-history': () => closeHistoryDialog(),
    'close-format': () => closeFormatDialog(),
    'close-export': () => closeExportDialog(),
    'close-settings': () => closeSettings(),
    'close-command': () => commandPalette.close(),
    // 快捷键一览（1.5.0 功能-4）：锁键层，Esc 收起并把焦点还给打开前的元素。
    'close-shortcuts': () => closeShortcutsPage(),
    'close-jump': () => closeJumpDialog(),
    'close-find': () => closeFindPanel(),
    // 顶栏「整理」卡 / 「显示」菜单：先看焦点在谁里面，再把焦点还给对应按钮
    // （焦点本来就在菜单里时由 renderer/menu-keyboard.js 的元素级监听接走，不经过这里）
    'close-header-menus': () => {
      const active = document.activeElement;
      const inCard = Boolean(active && $('format-menu').contains(active));
      const inDisplay = Boolean(active && $('display-menu').contains(active));
      hideFormatMenu();
      hideDisplayMenu();
      if (inCard) $('btn-format').focus();
      else if (inDisplay) $('btn-display').focus();
    },
    'clear-find-session': () => clearFindSession({ toastHint: true }),
    'close-fragment': () => closeFragmentDialog(),
    'close-insert-fragment': () => closeInsertFragmentDialog(),
    // 剪贴板捕获：处理中不允许关（等「正文」/「章节」的处理结果出来）；其余一律走 captureUi.cancel()
    //（单列表视图没有「返回上一视图」，cancel 就是关面板；条目保留 / 消费由 capture-ui 自己决定）。
    'close-capture': () => {
      if (!captureUi.isBusy()) captureUi.cancel();
    },
    'close-proofread': () => closeProofreadPanel(),
    'close-sensitive': () => closeSensitivePanel(),
    'close-tts': () => closeTtsBar(),
    // 撤销条（1.5.0 P0-4 / H-5）：没有弹层 / 菜单 / 朗读 / 阅读 / 专注时，Esc 收起它并还焦点。
    'close-undo-bar': () => undoUi.dismiss(),
    // 章节多选（1.5.0 功能-1）：只清多选，不切章、不收起别的面板（面板的 Esc 在更前面的层）。
    'clear-chapter-selection': () => clearChapterSelection(),
    'exit-reading': () => exitReadingMode(),
    'exit-focus': () => setFocusMode(false),
    'hide-header-menus': () => hideHeaderMenus(),
    'hide-menus': () => {
      hideContextMenu();
      hideHeaderMenus();
    }
  };

  function escRun(action) {
    const run = escActions[action];
    if (!run) return false;
    run();
    return true;
  }

  // ---------- 命令面板：条目表（1.4.0 P0-3；1.6.0 F4a 数据搬到 command-catalog.js） ----------
  // 命令数据（id / 标题 / 键帽 / 关键词 / 视图条件）只有 renderer/command-catalog.js 一份；
  // 这里只做装配：动作名 → 本文件的函数。三处键位冗余（面板行尾键帽 / 按钮 tooltip /
  // README 快捷键表）都从那一份数据来，不再各抄一张表。
  // 装配缺一个动作时 createCommandDefs 直接抛 TypeError（启动即炸，不静默少条目）。
  const commandHandlers = {
    backToShelf: () => { void backToShelf(); },
    newBook: () => { void onNewBookClick(); },
    importBook: () => { void onImportClick(); },
    openSettings: () => { void openSettings(); },
    openBookDisplaySettings: () => { void openSettings({ scope: 'book' }); },
    saveCurrent: () => { void saveCurrent(); },
    newChapter: () => { void createChapterAt(state.chapters.length); },
    renameChapter: () => { void renameChapterAt(state.index); },
    deleteChapter: () => { void deleteChapterAt(state.index); },
    formatChapter: () => { void formatCurrentChapterFromConfig(); },
    openFindPanel: () => { openFindPanel(); },
    openJumpDialog: () => { openJumpDialog(); },
    toggleFocusMode: () => { toggleFocusMode(); },
    openReadingMode: () => { void openReadingMode(); },
    openTtsBar: () => { openTtsBar(); },
    openProofreadPanel: () => { void openProofreadPanel(); },
    openSensitivePanel: () => { void openSensitivePanel(); },
    openHistory: () => { void openHistoryForCurrentBook(); },
    openFragments: () => { void openInsertFragmentDialog(); },
    openCapture: () => { void captureUi.open(); },
    openBookInfo: () => {
      const book = (state.books || []).find((item) => sameBookPath(item.path, state.bookPath))
        || { path: state.bookPath, title: (state.meta && state.meta.title) || '', status: 'ok' };
      void openBookInfoDialog(book);
    },
    openBookFolder: () => { void openBookFolderFlow(); },
    checkUpdate: () => { void checkUpdate(); }
  };

  function commandDefs() {
    return commandCatalog.createCommandDefs({
      getView: () => ({ view: state.view, bookPath: state.bookPath }),
      handlers: commandHandlers
    });
  }

  // 命令面板的条目快照（1.5.0 P0-6 / 审计 O-1）：构建一次，按「数据版本」复用。
  // 缓存键只放 buildCommandItems 读的东西 —— 视图 / 书 / 书目 / 章节数组 / 当前章；
  // 数组里的对象被原地改（章节改名、书名字数变化）时由 renderChapterList /
  // applyMetaAndRelocate / refreshShelf 里的 markCommandsDirty() 兜住。
  // prepare() 顺手把归一文本算好，之后每次输入只做粗筛 + 少量打分。
  function commandItemsForPalette() {
    const key = [state.view, state.bookPath, state.meta, state.chapters, state.books, state.index];
    const cachedKey = commandItemsCache.key;
    if (
      commandItemsCache.items &&
      cachedKey &&
      cachedKey.length === key.length &&
      key.every((value, index) => cachedKey[index] === value)
    ) {
      return commandItemsCache.items;
    }
    const items = commandRegistryModule.prepare(buildCommandItems());
    commandItemsCache.items = items;
    commandItemsCache.key = key;
    return items;
  }

  // 动态条目：章节（当前书）+ 书（书架）。点一条就等于「切到那一章 / 打开那一本」。
  function buildCommandItems() {
    const out = [];
    for (const def of commandDefs()) {
      if (typeof def.when === 'function' && !def.when()) continue;
      out.push({
        id: def.id,
        title: def.title,
        group: 'command',
        kbd: def.kbd || '',
        hint: '',
        keywords: def.keywords || [],
        run: def.run
      });
    }
    if (state.view === 'editor' && state.bookPath) {
      state.chapters.forEach((chapter, index) => {
        out.push({
          id: `chapter:${chapter.id}`,
          title: chapterTitle(index, chapter.name),
          group: 'chapter',
          hint: index === state.index ? '当前章' : `第 ${chaptersLib.chapterNumber(state.meta, index)} 章`,
          keywords: [chapter.name || '', `ch${chaptersLib.chapterNumber(state.meta, index)}`, `ch${index + 1}`],
          run: () => {
            void switchChapter(index).then((result) => {
              if (!result || result.ok !== true) return;
              focusChapterItem({ mode: 'switch', index });
            });
          }
        });
      });
    }
    for (const book of state.books || []) {
      out.push({
        id: `book:${book.path}`,
        title: `打开《${book.title || '未命名'}》`,
        group: 'book',
        hint: `${book.chapterCount || 0} 章`,
        keywords: [book.title || '', 'book', '书'],
        run: () => {
          // H-3（1.5.0 P0-6）：当前这本书已经打开时，不要再走一次 api.openBook ——
          // 那会从磁盘重载正文，编辑区里没保存的字就白丢了。提示 + 把焦点还给编辑区。
          if (sameBookPath(book.path, state.bookPath)) {
            toast('这本书已经打开了');
            if (state.view === 'editor' && editorEl && typeof editorEl.focus === 'function') editorEl.focus();
            return;
          }
          void openBookByPath(book.path);
        }
      });
    }
    return out;
  }

  function runCommandItem(item) {
    if (!item || typeof item.run !== 'function') return false;
    try {
      item.run();
      return true;
    } catch (err) {
      toast(`执行命令失败：${err.message}`, 'error');
      return false;
    }
  }

  // 当前有没有弹层（含不锁键的面板）开着。Ctrl+K 与 `?` 共用：两个弹层不叠在一起，
  // 与 Esc 链「锁键层先接走」的口径一致。弹层清单 = backdrop-registry.js 的 17 层
  //（state.modal 判在两处：这里先看状态，注册表里 modal-backdrop 的类名再兜一层）。
  // B16（v1.8.0 WP-29）：弹层开合缓存（实现在 backdrop-registry.createOpenWatcher，单测直接覆盖）。
  // bindEvents 时创建一次；之后的 keydown 只读缓存变量，不再逐层 getElementById + classList。
  let backdropWatcher = null;

  function anyBackdropOpen() {
    if (state.modal) return true;
    if (backdropWatcher) return backdropWatcher.isOpen();
    return backdropRegistry.isBlocked($);
  }

  // Ctrl+K：打开面板（lock 弹层开着时不抢 —— 与 Esc 链同一口径；输入法组字中不处理）
  function openCommandPalette() {
    if (anyBackdropOpen()) return false;
    return commandPalette.open(document.activeElement);
  }

  // ---------- 快捷键一览（1.5.0 功能-4：写作页按 ?；1.6.0 F4a 补系统键） ----------
  // v1.8.0 WP-34（D1）：整段搬到 renderer/shortcuts-ui.js —— 行渲染 / 开合 / 焦点归还都在模块里，
  // 这里只装配 host 并按原名取出入口（行为零变化）。数据源仍是 renderer/command-catalog.js 的同一份
  // 声明（命令表里带键帽的 8 条 +「系统键」表），**不维护第二份快捷键表**；不用 buildCommandItems()
  // 是因为那份按当前视图过滤（书架页会把编辑类命令滤掉），一览页只读声明表、与视图无关。
  // 开合状态（backdrop class / 打开前焦点）归模块自己持有；Esc 链与两个「关闭」按钮仍按原名调用。
  const shortcutsUiModule = window.CWShortcutsUi;
  const shortcutsUi = shortcutsUiModule.create({
    $,
    state,
    editorEl,
    commandCatalog,
    // 命令行沿用命令面板的分组标签（以前直接读 commandPaletteModule.GROUP_LABELS）
    groupLabels: commandPaletteModule.GROUP_LABELS || {}
  });
  const { openShortcutsPage, closeShortcutsPage } = shortcutsUi;


  // ---------- 关闭拦截 ----------
  async function handleCloseRequest() { return saveChainUi.handleCloseRequest(); }

  // ---------- 外部修改检测（v0.9 B-5 第七刀：整段搬到 renderer/statusbar-ui.js） ----------
  // 窗口失焦 / 回到前台时比对本章 mtime；监听仍在原位置装配（顺序不变），这里只留一行接线。
  statusbarUi.setupExternalChangeWatch();

  // ---------- 右键菜单 / 导出菜单 ----------
  // 把绝对定位的菜单摆在鼠标 / 指定坐标处：贴右边或下边时往窗口里收 8px（右键 / 卷 / 书卡菜单共用）。
  function placeMenuAt(menu, x, y) {
    menu.classList.remove('hidden');
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    const rect = menu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 8;
    const maxY = window.innerHeight - rect.height - 8;
    if (x > maxX) menu.style.left = `${Math.max(8, maxX)}px`;
    if (y > maxY) menu.style.top = `${Math.max(8, maxY)}px`;
  }

  function hideMenu(id) {
    const menu = $(id);
    if (menu) menu.classList.add('hidden');
  }

  // 1.5.0 功能-1：这张菜单是不是「批量菜单」——批量条打开的一定是；右键落在多选中的章上也是。
  // 选中的章只有 1 章时仍走单章路径（文案 / 撤销 / 单章行为与 1.4.0 完全一致）。
  function chapterMenuIsBatch(index) {
    if (state.batchMenu) return true;
    if (!Number.isInteger(index) || index < 0) return false;
    if (state.selectedIds.size <= 1) return false;
    const id = chapterIdAt(index);
    return id !== '' && state.selectedIds.has(id);
  }

  // 只能作用在「一章」上的菜单动作：批量打开时收起（重命名 5 章同一个名字 / 给 5 章各插一章都不合理）
  const CHAPTER_MENU_SINGLE_ACTIONS = ['rename', 'insert-before', 'insert-after', 'edit-note', 'copy-platform'];

  function showContextMenu(event, index) {
    state.contextIndex = index;
    const menu = $('context-menu');
    const batch = chapterMenuIsBatch(index);
    const selectedCount = state.selectedIds.size;
    // 当前状态的那一项前面打勾，避免记不清这章标的是什么
    const currentStatus = chapterStatus(state.chapters[index]);
    menu.querySelectorAll('button[data-action^="status-"]').forEach((btn) => {
      const status = btn.dataset.action.slice('status-'.length);
      const label = CHAPTER_STATUS_LABELS[status];
      if (!label) return;
      const suffix = batch ? `（${selectedCount} 章）` : '';
      btn.textContent = `${status === currentStatus ? '✓ ' : ''}标记为${label}${suffix}`;
    });
    // 单章动作在批量菜单里收起；打开单章菜单时恢复（上一次可能是批量打开的）
    for (const action of CHAPTER_MENU_SINGLE_ACTIONS) {
      menu.querySelectorAll(`button[data-action="${action}"]`).forEach((btn) => {
        btn.classList.toggle('hidden', batch);
      });
    }
    const deleteBtn = menu.querySelector('button[data-action="delete"]');
    if (deleteBtn) {
      deleteBtn.textContent = batch ? `删除选中的 ${selectedCount} 章（移到 _trash）` : '删除（移到 _trash）';
    }
    // 「移到卷」展开的卷列表每次重新打开都收起（上一次的卷可能已经删了 / 改名了）
    const volumeHolder = $('context-menu-volumes');
    if (volumeHolder) {
      volumeHolder.textContent = '';
      volumeHolder.classList.add('hidden');
    }
    placeMenuAt(menu, event.clientX, event.clientY);
  }

  function hideContextMenu() {
    hideMenu('context-menu');
    state.batchMenu = false;
  }

  function showVolumeMenu(event, volumeId) {
    state.contextVolumeId = volumeId || null;
    const menu = $('volume-menu');
    const volumes = volumeList();
    const index = volumeId ? volumes.findIndex((v) => v.id === volumeId) : -1;
    // 「未分卷」组不是真正的卷：只能往里加章节
    menu.querySelectorAll('button[data-action="rename"], button[data-action="delete"]').forEach((btn) => {
      btn.classList.toggle('hidden', !volumeId);
    });
    const upBtn = menu.querySelector('button[data-action="move-up"]');
    const downBtn = menu.querySelector('button[data-action="move-down"]');
    if (upBtn) {
      upBtn.classList.toggle('hidden', !volumeId);
      upBtn.disabled = index <= 0;
    }
    if (downBtn) {
      downBtn.classList.toggle('hidden', !volumeId);
      downBtn.disabled = index < 0 || index >= volumes.length - 1;
    }
    const newChapterBtn = menu.querySelector('button[data-action="new-chapter"]');
    if (newChapterBtn) newChapterBtn.textContent = volumeId ? '在此卷末尾新建章节' : '在「未分卷」末尾新建章节';
    placeMenuAt(menu, event.clientX, event.clientY);
  }

  function hideVolumeMenu() {
    hideMenu('volume-menu');
    state.contextVolumeId = null;
  }

  function showBookMenu(book, x, y) {
    state.contextBook = book;
    const menu = $('book-menu');
    // 书目损坏的书读不出元数据，先修复；不让「书籍信息…」点进去报错
    const infoBtn = menu.querySelector('button[data-action="info"]');
    if (infoBtn) infoBtn.classList.toggle('hidden', Boolean(book && book.status === 'corrupt'));
    // 「移到分组…」同理（1.6.0 F5）：改的是 书目.json 的 group，书目坏了先修复
    const groupBtn = menu.querySelector('button[data-action="move-group"]');
    if (groupBtn) groupBtn.classList.toggle('hidden', Boolean(book && book.status === 'corrupt'));
    // 1.6.0b：每次打开菜单都收起上一次展开的分组列表（分组可能已改名 / 合并）
    closeBookGroupChooser();
    placeMenuAt(menu, x, y);
  }

  function hideBookMenu() {
    hideMenu('book-menu');
    state.contextBook = null;
  }

  function toggleExportMenu() {
    $('export-menu').classList.toggle('hidden');
  }

  function hideExportMenu() {
    hideMenu('export-menu');
  }

  // ---------- 长操作编辑区保护（v1.8.0 WP-02 / 审计 C2） ----------
  // 整本整理 / 还原备份会写盘、完成后再从磁盘重载正文。以前操作入口查一次 dirty 就开始跑，
  // 进度期间编辑区照常能输入，完成时 loadChapterAt 无条件覆盖正文并把 dirty 清成 false——
  // 期间敲的字静默消失。现在长操作期间把编辑区设为只读（进度提示里会说明），完成时再按
  // 「书没换 / 期间有没有新输入」复核（long-op-logic.js）；输入法补字、程序化写入这类漏网输入
  // 一律正文优先：保留编辑区，不拿磁盘结果盖掉。
  let longOpLockCount = 0;
  // ?test=1 时 E2E 用 setTestBookOpDelay 给「整本整理 / 还原备份」的 IPC 外面包一层延迟，
  // 制造「操作还在进行」的窗口；正常启动恒为 null，两个入口直接走 call(api.formatBook / api.restoreReplaceBackup)。
  let testBookOp = null;

  function beginLongOpLock() {
    longOpLockCount += 1;
    applyEditorEditable();
  }

  function endLongOpLock() {
    longOpLockCount = Math.max(0, longOpLockCount - 1);
    applyEditorEditable();
  }

  function longOpLocked() {
    return longOpLockCount > 0;
  }

  // ---------- 整本替换的备份还原 ----------
  // 备份都在书内 _trash/替换备份-时间戳/（storage 负责读写），这里只负责展示和确认。
  async function refreshReplaceBackups() {
    const row = $('find-backup-row');
    if (!state.bookPath) {
      state.replaceBackups = [];
      row.classList.add('hidden');
      return state.replaceBackups;
    }
    try {
      const backups = await call(api.listReplaceBackups, state.bookPath);
      state.replaceBackups = Array.isArray(backups) ? backups : [];
    } catch {
      state.replaceBackups = [];
    }
    if (!state.replaceBackups.length) {
      row.classList.add('hidden');
      return state.replaceBackups;
    }
    const latest = state.replaceBackups[0];
    $('find-backup-text').textContent =
      `最近一次整本替换的备份：${latest.name}（${latest.fileCount} 个文件，${formatBytes(latest.totalBytes)}）`;
    row.classList.remove('hidden');
    return state.replaceBackups;
  }

  // 「只替换这一处」：只改编辑区（未保存），替换完自动选中下一处，方便连续按。
  // 用 execCommand 替换当前选中文本，保住原生 Ctrl+Z 撤销链。
  async function runReplaceOne() {
    const options = readFindOptions();
    if (!options.query.trim()) {
      $('find-summary').textContent = '先在查找框里输入内容';
      return { ok: false };
    }
    if (options.scope !== 'current') {
      $('find-summary').textContent = '「替换这一处」只用于当前章；整本替换请用「全部替换」。';
      return { ok: false };
    }
    const text = editorEl.value;
    const from = editorEl.selectionStart || 0;
    // 审计 E-N4（WP3）：载章在途时编辑区马上要被新章覆盖，这次替换会静默丢失——入口直接拒绝。
    if (state.loading) {
      $('find-summary').textContent = replaceOneGuard.staleHint('loading');
      return { ok: false, code: 'STALE_TARGET', reason: 'loading' };
    }
    // 发起查找时拍下「这本书 + 这一章 + 这版正文」：findNext 回执迟到（切章 / 换书 / 改正文）就整段作废。
    const target = replaceOneGuard.captureTarget({
      bookPath: state.bookPath,
      chapterId: state.loadedChapterId,
      text
    });
    let picked;
    try {
      picked = await (testFindNext || call)(api.findNext, text, options.query, from, {
        caseSensitive: options.caseSensitive
      });
    } catch (err) {
      $('find-summary').textContent = `查找失败：${err.message}`;
      return { ok: false };
    }
    if (!picked || !picked.match) {
      // 审计修复 #10（E6）：命中超过单章 5000 处上限时，光标之后的位置已不在命中列表里，
      // 要说清是「被上限截断」而不是「本章没有下一处」。
      $('find-summary').textContent =
        picked && picked.truncated
          ? '本章命中超过单章上限 5000 处，光标之后的位置不再定位；换个更具体的词或先用「全部替换」'
          : `光标之后没有找到「${options.query}」了`;
      return { ok: false, truncated: Boolean(picked && picked.truncated) };
    }
    const match = picked.match;
    const replacement = options.replacement;
    // 回执可能迟到：这期间切了书 / 切了章 / 改了正文——旧下标绝不能套到眼前的正文上，越界也不拼接。
    const verdict = replaceOneGuard.checkTarget(target, {
      bookPath: state.bookPath,
      chapterId: state.loadedChapterId,
      text: editorEl.value,
      loading: state.loading
    });
    if (!verdict.same || !replaceOneGuard.matchInBounds(match, text.length)) {
      $('find-summary').textContent = replaceOneGuard.staleHint(verdict.same ? 'stale' : verdict.reason);
      return { ok: false, code: 'STALE_TARGET', reason: verdict.same ? 'out-of-bounds' : verdict.reason };
    }
    editorEl.focus();
    editorEl.setSelectionRange(match.index, match.index + match.length);
    const inserted = replaceEditorTextNative(replacement);
    let fallbackUsed = false;
    if (!inserted) {
      // 极端兜底：execCommand 不可用时手动拼接（会丢原生撤销链，但不会丢内容）
      const current = editorEl.value;
      editorEl.value =
        current.slice(0, match.index) + replacement + current.slice(match.index + match.length);
      fallbackUsed = true;
    }
    onEditorInput();
    // 审计修复 #39（V402）：兜底拼接会清空浏览器撤销栈 —— 记一次性快照并提示（放在输入处理之后）
    if (fallbackUsed) {
      recordFallbackWrite({ before: text, after: editorEl.value, start: match.index, label: '替换这一处' });
    }

    // 选中下一处，方便连续替换
    let next = null;
    try {
      const after = match.index + replacement.length;
      next = await (testFindNext || call)(api.findNext, editorEl.value, options.query, after, {
        caseSensitive: options.caseSensitive
      });
    } catch { /* 找下一处失败不影响已经替换的内容 */ }
    // 第二个回执也可能迟到：旧章命中只用来定位，切章后绝不把下标套到新章（只改选中，不改正文）。
    const locate = replaceOneGuard.locateNext(next && next.match, target, {
      bookPath: state.bookPath,
      chapterId: state.loadedChapterId,
      textLength: editorEl.value.length,
      loading: state.loading
    });
    if (locate.index != null) {
      editorEl.setSelectionRange(locate.index, locate.index + locate.length);
      scrollCaretIntoView(locate.index);
    } else if (!locate.stale) {
      const caret = match.index + replacement.length;
      editorEl.setSelectionRange(caret, caret);
      scrollCaretIntoView(caret);
    }
    const nextHint = locate.stale
      ? '；期间章节已变，不再定位下一处'
      : locate.index != null
        ? `；已选中下一处（第 ${next.index + 1} 处）`
        : '；本章后面没有下一处了';
    const truncated = Boolean(picked.truncated);
    const totalLabel = truncated ? `${picked.total}+` : String(picked.total);
    const truncatedHint = truncated ? '（本章命中超过单章上限 5000 处，只统计 / 处理前 5000 处）' : '';
    $('find-summary').textContent =
      `已替换第 ${picked.index + 1}/${totalLabel} 处（未保存：Ctrl+S 写盘，Ctrl+Z 可撤销）${nextHint}${truncatedHint}`;
    return { ok: true, index: picked.index, total: picked.total, truncated, hasNext: locate.index != null };
  }

  // 从最近的「整本替换」备份还原；还原前二次确认，并由 storage 把当前内容再备份一份。
  // WP-02/C2：入口先捕获 bookPath，之后每个 await（列备份 / 未保存询问 / 还原 / 重载）回来
  // 都核对还是不是这本书——期间换了书就取消，绝不把回执用到另一本书上。
  async function restoreReplaceBackupFlow(backupName) {
    const bookPath = state.bookPath;
    if (!bookPath) {
      toast('还没有打开一本书', 'warn');
      return { ok: false };
    }
    if (longOpLocked()) {
      toast('正在执行另一个长操作，请稍候', 'warn');
      return { ok: false, busy: true };
    }
    await refreshReplaceBackups();
    if (!longOpLogic.sameBookPath(state.bookPath, bookPath)) {
      toast('已经换了书，取消还原', 'warn');
      return { ok: false };
    }
    const target =
      state.replaceBackups.find((item) => item.name === backupName) || state.replaceBackups[0];
    if (!target) {
      toast('这本书里没有可还原的替换备份', 'warn');
      return { ok: false };
    }
    if (state.dirty) {
      const guard = await confirmRestoreWithUnsaved(
        '还原会用备份覆盖磁盘上的章节，并从磁盘重新载入正文；当前章的未保存修改会丢失。'
      );
      if (!guard.ok) return guard.canceled ? { ok: false, canceled: true } : guard.saved;
      // 询问期间也可能切了书（弹窗不阻塞其它入口）：这时的 target 属于原来那本，不能还原。
      if (!longOpLogic.sameBookPath(state.bookPath, bookPath)) {
        toast('已经换了书，取消还原', 'warn');
        return { ok: false };
      }
    }
    const others = state.replaceBackups.length - 1;
    // 1.4.0 P0-2（撤销优先于确认）：还原到替换前不再弹二次确认 —— 直接还原
    // （storage 会先把当前内容备份到 _trash/还原前备份-*），10 秒内可撤销（= 用那份还原前备份再还原一次）。
    // 未保存拦截仍在前一步：这个动作会从磁盘重载正文，编辑区没写盘的字找不回来。
    beginLongOpLock();
    showFormatBookProgress('正在从备份还原…（编辑区已暂锁）');
    try {
      // WP-02/C2：还原只针对发起时捕获的那本书；延迟注入只包 IPC，不改变还原链路本身。
      const data = await (testBookOp || call)(api.restoreReplaceBackup, bookPath, target.name);
      // 期间换了书 / 又敲了字时，reloadOpenBookFromDisk 内部会拒绝重载（正文优先），
      // 这里的刷新与撤销登记仍然按捕获的 bookPath 走。
      await reloadOpenBookFromDisk(bookPath);
      await refreshShelf();
      await refreshReplaceBackups();
      const undoName = data.restoreBackupDir ? String(data.restoreBackupDir).split(/[\\/]/).pop() : '';
      if (undoName) {
        // 1.5.0 P0-5（审计 V-2）：登记撤销时记下这份「还原前备份」的指纹；撤销前核对它还是不是那一份。
        const expectedBackup = await backupGuard.fingerprint(bookPath, undoName);
        undoUi.activate(`已还原到「${target.name}」前的正文`, async () => {
          if (!longOpLogic.sameBookPath(state.bookPath, bookPath)) throw new Error('已经换了书，不能撤销');
          // 五-H3（L-F1）：撤销会拿备份整组覆盖磁盘 + 从磁盘重载。编辑区有未保存的字时执行，
          // 等于把作者刚写的正文连磁盘带编辑区一起盖掉（reload 的脏闸也拦不住已经发生的写盘）。
          if (state.dirty) throw new Error('编辑区有未保存的修改，请先保存后再撤销');
          await backupGuard.assertUnchanged(bookPath, expectedBackup);
          const back = await call(api.restoreHistoryDir, bookPath, `dir:${undoName}`);
          if (!back || !Number(back.restored)) throw new Error('还原前备份里没有可还原的章节');
          await reloadOpenBookFromDisk(bookPath);
          await refreshShelf();
          await refreshReplaceBackups();
        }, { groupId: 'dir:' + undoName, bookPath });
      }
      toast(
        `已还原 ${data.restored} 个章节${
          data.skipped ? `（跳过 ${data.skipped} 个已不存在的章节）` : ''
        }，当前内容已备份到 _trash${others > 0 ? `（还有 ${others} 次更早的替换备份）` : ''}`
      );
      return { ok: true, data };
    } catch (err) {
      toast(`还原失败：${err.message}`, 'error');
      await reloadAfterPartialFailure(bookPath); // 可能已经还原了几章，界面回到磁盘的真相
      return { ok: false, message: err.message };
    } finally {
      endLongOpLock();
      hideFormatBookProgress();
    }
  }

  // 还原 / 外部改动后从磁盘重载当前书（章节列表、字数、当前章）。
  // 章节 id 保持不变就回到原来那一章；章节被删/书目重建时回到第 1 章。
  // WP-02/C2：expectedBookPath 是调用方 await 前捕获的路径（不传就用当前书）。重载前与
  // openBook await 之后各查一次「还是不是这本书 / 有没有未保存修改」——期间切了书、敲了字，
  // 这次重载一律作废，绝不把另一本书或作者刚写的正文盖掉。
  async function reloadOpenBookFromDisk(expectedBookPath = null) {
    const bookPath = expectedBookPath || state.bookPath;
    if (!bookPath) return null;
    const mayReload = () =>
      longOpLogic.canReloadFromDisk({
        expectedBookPath: bookPath,
        currentBookPath: state.bookPath,
        dirty: state.dirty
      });
    if (!mayReload()) {
      if (longOpLogic.sameBookPath(state.bookPath, bookPath) && state.dirty) {
        toast('正文有未保存修改，没有从磁盘重新载入', 'warn');
      }
      return null;
    }
    const currentId = state.chapters[state.index] && state.chapters[state.index].id;
    const opened = await call(api.openBook, bookPath);
    if (!mayReload()) {
      if (longOpLogic.sameBookPath(state.bookPath, bookPath) && state.dirty) {
        toast('正文有未保存修改，没有从磁盘重新载入', 'warn');
      }
      return null;
    }
    state.meta = opened.meta;
    state.chapters = opened.meta.chapters;
    state.bookId = opened.meta.id;
    state.dirty = false;
    state.saveError = null;
    state.baseText = '';
    $('book-title').textContent = opened.meta.title;
    $('book-title').title = opened.meta.title;
    const index = Math.max(
      0,
      state.chapters.findIndex((chapter) => chapter.id === currentId)
    );
    await loadChapterAt(index);
    renderChapterList();
    renderEditorHeader();
    await applyBookDisplay(opened.meta.id);
    updateWindowTitle();
    return opened;
  }

  // 批次破坏性操作（整本整理 / 整本替换 / 还原到替换前 / 还原历史备份）失败后：
  // 磁盘上可能已经改了一部分章节，而编辑区还停着操作开始前的那份正文。界面必须回到磁盘的真相，
  // 否则下一次保存会把改过的章又写回旧内容（看起来像「替换没生效」）。
  // 有未保存的修改就什么都不动——宁可界面旧一点，也不吞掉作者刚打的字。
  // bookPath 给了就只在「那本书正是当前打开的这本」时重载（历史弹层也能看别的书的备份）。
  async function reloadAfterPartialFailure(bookPath = null) {
    if (state.dirty || !state.bookPath) return false;
    if (bookPath && !longOpLogic.sameBookPath(state.bookPath, bookPath)) return false;
    try {
      await reloadOpenBookFromDisk(bookPath || state.bookPath);
      return true;
    } catch {
      return false; // 重载失败不影响上面的错误提示（提示里已经写清现场）
    }
  }

  // ---------- 本书历史 ----------
  // 第 4 步九刀·第一刀：实现在 renderer/history-ui.js（模块头有契约），这里只装配与接线；
  const historyUi = historyUiModule.create({
    $, state, api, call, toast, staleGuard,
    // 1.5.0 P0-5（审计 V-2）：历史还原的撤销也要核对备份没变
    guard: backupGuard,
    collab: { confirmRestoreWithUnsaved, openModal, refreshShelf, reloadAfterPartialFailure, reloadOpenBookFromDisk,
      registerUndo: (label, run, meta) => undoUi.activate(label, run, meta),
      protectedUndoGroups: (bookPath) => undoUi.protectedGroupIds(bookPath) },
    menus: { hideBookMenu, hideExportMenu },
    fmt: { formatBytes }
  });
  const { sameBookPath, openHistoryForPath, openHistoryForCurrentBook, refreshHistory, closeHistoryDialog, closeHistoryPreview, previewHistoryBackup, confirmHistoryRestore } = historyUi;



  // ---------- 灵感箱（碎片速记） ----------
  // 第 4 步九刀·补刀 10：实现在 renderer/fragments-ui.js（模块头有契约），这里只装配与接线；
  const fragmentsUi = fragmentsUiModule.create({
    $, state, api, call, toast, staleGuard, recordFallbackWrite,
    common: { chaptersLib, formatRelativeTime, formatCount },
    editor: { editorEl, onEditorInput, scrollCaretIntoView },
    hideHeaderMenus
  });
  const { updateFragmentCounter, openFragmentDialog, closeFragmentDialog, saveFragment, openInsertFragmentDialog, closeInsertFragmentDialog, insertSelectedFragment, selectFragmentByName, refreshFragments, setupFragmentsUi } = fragmentsUi;

  // ---------- 校对 ----------
  // 第 4 步九刀·第四刀：实现在 renderer/proofread-ui.js（模块头有契约），这里只装配与接线；
  const proofreadUi = proofreadUiModule.create({
    $, state, api, call, toast, staleGuard,
    peers: { closeFindPanel, renderProofreadSettings: () => renderProofreadSettings() },
    resultJump: window.CWResultJumpUi,
    nav: { chapterTitle, editorEl, switchChapter },
    view: { effectiveConfig, hideHeaderMenus, scrollCaretIntoView }
  });
  const { proofreadWordListText, refreshProofreadWordList, openProofreadPanel, closeProofreadPanel, proofreadScope, currentChapterRef, matchRangeAt, runProofread, pickProofreadWords, setupProofreadUi } = proofreadUi;

  // ---------- 敏感词预检 ----------
  // 第 4 步九刀·第五刀：实现在 renderer/sensitive-ui.js（模块头有契约），这里只装配与接线；
  const sensitiveUi = sensitiveUiModule.create({
    $, state, api, call, toast, staleGuard,
    peers: { closeFindPanel, closeProofreadPanel, currentChapterRef, matchRangeAt, renderSensitiveSettings: () => renderSensitiveSettings() },
    resultJump: window.CWResultJumpUi,
    nav: { chapterTitle, editorEl, switchChapter },
    view: { effectiveConfig, hideHeaderMenus, scrollCaretIntoView }
  });
  const { sensitiveWordListText, refreshSensitiveWordList, openSensitivePanel, closeSensitivePanel, sensitiveScope, runSensitiveCheck, pickSensitiveWords, setupSensitiveUi } = sensitiveUi;

  // ---------- 朗读（提案 5.3） ----------
  // v0.9 B-6：播放状态机 / 朗读条 / 语音列表整段搬到 renderer/tts-ui.js（createTtsUi(host)），
  // 这里只剩接线 + 「测试专用假语音引擎」（正常使用永远是真实 speechSynthesis）。
  const tts = ttsUi.create({ api, $, call, state, toast, editorEl, scrollCaretIntoView });
  const {
    renderTtsVoices,
    openTtsBar,
    closeTtsBar,
    toggleTtsPlay,
    ttsStep,
    setTtsRate,
    setTtsVoice,
    setTtsFollow,
    stopTts,
    stopTtsForChapterChange,
    speechEngine
  } = tts;

  // 测试专用：装一个假语音引擎（只在 ?test=1 的钩子里调用），E2E 用它验证播放状态机。
  let fakeSpeechState = { spoken: [], last: null, pending: null, speaking: false, paused: false };

  function installFakeSpeech() {
    fakeSpeechState = { spoken: [], last: null, pending: null, speaking: false, paused: false };
    tts.setSpeechEngine({
      available: () => true,
      voices: () => [
        { name: '测试语音 A', lang: 'zh-CN', voiceURI: 'fake-voice-a' },
        { name: '测试语音 B', lang: 'zh-CN', voiceURI: 'fake-voice-b' }
      ],
      speak(request, handlers) {
        fakeSpeechState.spoken.push({ ...request });
        fakeSpeechState.last = { ...request };
        fakeSpeechState.pending = handlers;
        fakeSpeechState.speaking = true;
        setTimeout(() => {
          if (fakeSpeechState.pending === handlers && handlers.start) handlers.start();
        }, 0);
        return true;
      },
      pause() {
        fakeSpeechState.paused = true;
      },
      resume() {
        fakeSpeechState.paused = false;
      },
      cancel() {
        fakeSpeechState.pending = null;
        fakeSpeechState.speaking = false;
      }
    });
    if (state.tts.open) renderTtsVoices();
    return true;
  }

  // 测试专用：让假引擎报「这一段念完了」/「出错」
  function fakeFinishSpeech() {
    const handlers = fakeSpeechState.pending;
    fakeSpeechState.pending = null;
    fakeSpeechState.speaking = false;
    if (!handlers || !handlers.end) return false;
    handlers.end();
    return true;
  }

  function fakeErrorSpeech(code) {
    const handlers = fakeSpeechState.pending;
    fakeSpeechState.pending = null;
    fakeSpeechState.speaking = false;
    if (!handlers || !handlers.error) return false;
    handlers.error({ error: String(code || 'synthesis-failed') });
    return true;
  }
  // ---------- 排版 ----------
  // 「智能排版/一键整理」只改当前章正文，结果先落在编辑区（未保存），按 Ctrl+S 才写盘，可撤销。
  // 默认规则 / 规则摘要 / 改动统计的文案在 format-ui.js 里（Node 单测覆盖），这里只负责流程；
  // 规则合并也统一用 formatUi.mergeOptions，避免渲染层再抄一份默认值。
  const formatUi = window.CWFormatUi;
  // 「撤销上次整理」的内存快照上限（只存内存，关掉应用就没了；50 步足够连续整理几十次）
  const MAX_FORMAT_UNDO = 50;

  const DISPLAY_PRESETS = {
    compact: { label: '紧凑', patch: { editorLineHeight: 1.6, editorLetterSpacing: 0, editorPaddingX: 24, editorPageWidth: 0 } },
    normal: { label: '标准', patch: { editorLineHeight: 1.95, editorLetterSpacing: 0.02, editorPaddingX: 56, editorPageWidth: 0 } },
    loose: { label: '宽松', patch: { editorLineHeight: 2.4, editorLetterSpacing: 0.05, editorPaddingX: 80, editorPageWidth: 800 } }
  };

  const displaySettingsIds = [
    'settings-size',
    'settings-line-height',
    'settings-letter-spacing',
    'settings-padding-x',
    'settings-page-width',
    'settings-text-autospace',
    'settings-paper'
  ];

  function readDisplayForm() {
    const draft = state.settingsFontDraft || { path: '', name: '' };
    // 超长段落阈值（1.1.0）：留空 / 非数字给 NaN，交给配置层回落默认 500（0 会被夹成 50，不是「没填」）。
    const longParaRaw = String($('settings-long-para-threshold').value || '').trim();
    return {
      editorFont: $('settings-font').value,
      editorCustomFontPath: draft.path,
      editorCustomFontName: draft.name,
      editorFontSize: Number($('settings-size').value),
      editorLineHeight: Number($('settings-line-height').value),
      editorLetterSpacing: Number($('settings-letter-spacing').value),
      editorPaddingX: Number($('settings-padding-x').value),
      editorPageWidth: Number($('settings-page-width').value),
      editorPaper: $('settings-paper').value,
      // 中西文自动间距（1.3.0 T-08）：按书 / 全局同一份表单，默认开（旧配置没有这个键也回填勾上）
      editorTextAutospace: $('settings-text-autospace').checked === true,
      // 当前段落高亮（N10b）：按书 / 全局都走同一份表单，保存时分别落到 bookDisplay / config
      caretParagraph: $('settings-caret-paragraph').checked === true,
      caretParagraphColor: caretColorLib.normalizeColor(state.settingsCaretColorDraft),
      // 超长段落阈值：按书保存时只影响这本书，书架设置里改全局默认（配置层再夹紧一次）
      longParagraphThreshold: longParaRaw === '' ? NaN : Number(longParaRaw)
    };
  }

  function readFormatOptions() {
    return {
      indent: $('fmt-indent').value,
      blankLines: $('fmt-blank').value,
      trimTrailing: $('fmt-trailing').checked,
      normalizePunct: $('fmt-punct').checked,
      removeCjkSpaces: $('fmt-cjkspace').checked,
      curlyQuotes: $('fmt-quotes').checked,
      ellipsis: $('fmt-ellipsis').checked
    };
  }

  function writeFormatOptions(options) {
    const opts = formatUi.mergeOptions(options);
    // 兼容旧配置里的布尔缩进
    const indent = opts.indent === true ? '2' : opts.indent === false ? 'none' : String(opts.indent);
    $('fmt-indent').value = ['none', '0', '2'].includes(indent) ? indent : '2';
    $('fmt-trailing').checked = opts.trimTrailing !== false;
    $('fmt-punct').checked = opts.normalizePunct !== false;
    $('fmt-quotes').checked = Boolean(opts.curlyQuotes);
    $('fmt-ellipsis').checked = Boolean(opts.ellipsis);
    $('fmt-cjkspace').checked = Boolean(opts.removeCjkSpaces);
    $('fmt-blank').value = ['keep', 'single', 'singleIndent', 'none'].includes(opts.blankLines)
      ? opts.blankLines
      : 'single';
  }

  function hideHeaderMenus() {
    hideFormatMenu();
    hideDisplayMenu();
    hideExportMenu();
    hideBookMenu();
  }

  // 把光标行滚进视野（查找 / 校对 / 敏感词跳转、插入碎片后回光标都用它）。
  // C24：编辑区是 pre-wrap，长段落软换行时「\n 数 × 行高」会把视觉行数算少一大截
  //（一整段几十个视觉行可能一个换行符都没有）→ 跳转会滚到错误位置、甚至滚回章首。
  // 复用专注模式打字机的镜像测量（同字体 / 行高 / 宽度量光标真实行顶）；只有量不出来
  //（超长章节 / 宽度为 0 / 还没挂载）才退回按换行数估算。
  function scrollCaretIntoView(pos) {
    const lineHeight = parseFloat(getComputedStyle(editorEl).lineHeight) || 32;
    const measured = focusModeUi.measureCaretTop(pos);
    const caretTop = measured == null
      ? (editorEl.value.slice(0, pos).match(/\n/g) || []).length * lineHeight
      : measured;
    const plan = focusLogic.planCaretReveal({
      caretTop,
      currentScrollTop: editorEl.scrollTop,
      viewportHeight: editorEl.clientHeight,
      lineHeight,
      maxScrollTop: editorEl.scrollHeight - editorEl.clientHeight
    });
    if (plan.adjust) editorEl.scrollTop = plan.scrollTop;
  }

  // ---------- 「整理」按钮的悬浮选择卡 + 「显示」菜单 ----------
  // 第 4 步九刀·第八刀：实现在 renderer/tidy-card-ui.js（模块头有契约），这里只装配与接线；
  const tidyCardUi = tidyCardUiModule.create({
    $, state, api, call, toast, recordFallbackWrite,
    format: { formatUi, MAX_FORMAT_UNDO, readFormatOptions, writeFormatOptions, editorEl, onEditorInput, chaptersLib, caretColorLib },
    menus: { hideBookMenu, hideExportMenu, hideMenu, renderMarksMenu },
    peers: { openSettings: () => openSettings(), toggleMarks, setDisplayPreset, applyCaretColor, setCaretParagraphPersisted, setCaretColorPersisted, runFormatBook, scrollCaretIntoView, effectiveConfig }
  });
  const { formatCardOpen, displayMenuOpen, showFormatCard, hideFormatMenu, showDisplayMenu, hideDisplayMenu, openFormatDialog, closeFormatDialog, formatUndoSteps, canUndoFormat, undoFormat, formatCurrentChapterFromConfig, applyFormatToEditor, setupTidyCardUi } = tidyCardUi;

  // ---------- 一键整理本书 ----------
  let formatBookProgressEl = null;

  function showFormatBookProgress(text) {
    if (!formatBookProgressEl) {
      formatBookProgressEl = document.createElement('div');
      formatBookProgressEl.className = 'toast';
      $('toast-area').appendChild(formatBookProgressEl);
    }
    formatBookProgressEl.textContent = text;
  }

  function hideFormatBookProgress() {
    if (formatBookProgressEl && formatBookProgressEl.parentNode) formatBookProgressEl.remove();
    formatBookProgressEl = null;
  }

  // 一键整理本书：复用上次「整理本章」的规则 → 预检查 → 确认 → 整本整理（写前备份）
  async function runFormatBook() {
    if (!state.bookPath || !state.meta) {
      toast('先打开一本书再整理', 'warn');
      return { ok: false };
    }
    if (state.formatBookRunning || longOpLocked()) {
      toast('正在整理这本书，请稍候', 'warn');
      return { ok: false, busy: true };
    }
    hideFormatMenu();
    hideDisplayMenu();
    if (state.dirty) {
      // 五-H3（L-F1）：整本整理自身的未保存拦截与历史还原共用同一条语义——保存回执后复核 dirty，
      // 仍脏（保存在途敲了字）就再问一轮；选「不保存」才用磁盘旧内容继续。旧实现只看 saved.ok，
      // 整理备份里不含「保存期间输入」，随后 keep-edits + Ctrl+S + 10 秒撤销会把这份输入静默弄丢。
      const guard = await saveForTransition({
        title: '整理本书前先处理未保存的修改',
        message: `「${currentChapterLabel()}」还有未保存的修改；整本整理会直接写盘，建议先保存。`,
        saveLabel: '保存后整理',
        discardLabel: '不保存（按磁盘内容整理）'
      });
      if (!guard.ok) return guard.canceled ? { ok: false, canceled: true } : (guard.saved || { ok: false });
      if (guard.discarded) await loadChapterAt(state.index); // 用磁盘上的旧内容继续
    }

    const options = formatUi.mergeOptions(state.config && state.config.formatOptions);
    // WP-02/C2：从预检查起就锁编辑区（预检查也要读完整本书，千章书不短），并把「进行中」
    // 标志提前到预检查之前防重复触发。完成时按「书没换 / 期间有没有新输入」决定怎么重载。
    state.formatBookRunning = true;
    const bookPath = state.bookPath;
    beginLongOpLock();
    try {
      let preview;
      try {
        showFormatBookProgress('正在检查整本书…（编辑区已暂锁）');
        preview = await call(api.formatPreviewBook, bookPath, options);
      } catch (err) {
        toast(`预检查失败：${err.message}`, 'error');
        return { ok: false, message: err.message };
      }
      if (!preview.chaptersChanged) {
        toast('这本书已经是整理后的格式，没有可改的地方' + (preview.skippedTooLarge ? `；有 ${preview.skippedTooLarge} 章超过 128 MB，本次已跳过（文件没动）` : ''));
        return { ok: true, changed: 0, data: preview };
      }

      const listText = preview.changed
        .slice(0, 6)
        .map((item) => chapterTitle(item.index, item.name))
        .join('、');
      const moreText =
        preview.chaptersChanged > 6
          ? ` 等共 ${preview.chaptersChanged} 章`
          : `（共 ${preview.chaptersChanged} 章）`;
      // 1.4.0 P0-2（撤销优先于确认）：整本整理不再弹确认框 —— 直接整理（写前照旧备份到
      // _trash/整理备份-*），10 秒内可撤销（撤销 = 用这份备份还原整组，还原前还会再备份一份）。
      // 准备信息进 toast，作者不用点确认也知道改了几章。
      const planText = `规则：${formatUi.describeRules(options)}；会改 ${preview.chaptersChanged} 章（${listText}${moreText}）`;

      showFormatBookProgress(`正在整理整本书…（共 ${preview.chaptersChanged} 章要改，编辑区暂锁）`);
      // WP-02/C2：只整理发起时捕获的那本书（不使用 await 之后的活值）。
      const result = await (testBookOp || call)(api.formatBook, bookPath, options);
      const doneText = `已整理全书：${result.chaptersChanged} 章${planText ? `（${planText}）` : ''}${
        result.backupDir ? ' · 原文已备份到 _trash' : ''
      }${
        result.skippedTooLarge ? `；有 ${result.skippedTooLarge} 章超过 128 MB，本次已跳过（文件没动）` : ''
      }`;
      // 完成时先按「书没换 / 期间有没有新输入」判定（C2）：回执只属于发起时那本书。
      const decide = () =>
        longOpLogic.decideAfterLongOp({
          expectedBookPath: bookPath,
          currentBookPath: state.bookPath,
          dirty: saveLogic.isDirtyAgainstSnapshot(state.baseText, editorEl.value)
        });
      let plan = decide();
      if (plan === 'book-changed') {
        // 整理期间切了书：旧书照常整理完，但界面一个字都不动（以前会用活值重载到另一本书）
        await refreshShelf();
        toast(`${doneText}（你已切换到另一本书，切回后看到的就是整理结果）`);
        return { ok: true, changed: result.chaptersChanged, data: result };
      }
      // 同一本书：读回整理后的书目（章节字数缓存变了）
      const opened = await call(api.openBook, bookPath);
      plan = decide(); // openBook 期间也可能换书 / 再输入
      if (plan === 'book-changed') {
        await refreshShelf();
        toast(`${doneText}（你已切换到另一本书，切回后看到的就是整理结果）`);
        return { ok: true, changed: result.chaptersChanged, data: result };
      }
      const liveId = state.chapters[state.index] && state.chapters[state.index].id;
      state.meta = opened.meta;
      state.chapters = opened.meta.chapters;
      if (plan === 'keep-edits') {
        // 整理期间编辑区里又有字（输入法补字 / 程序化写入等漏网输入）：磁盘已经整理好，
        // 但正文优先——保留编辑区并维持未保存态，绝不拿整理结果盖掉作者的字。
        state.dirty = true;
        renderChapterList();
        renderEditorHeader();
        updateStatus();
        toast(doneText);
        toast('整理已完成写盘；你在整理期间输入的修改还留在编辑区（未保存，Ctrl+S 保存后生效）', 'warn');
      } else {
        // 整理后重新载入当前章（章节 id 保持不变；期间切过章就按现在这一章重载）
        const index = liveId
          ? Math.max(0, state.chapters.findIndex((chapter) => chapter.id === liveId))
          : Math.min(state.index, Math.max(0, state.chapters.length - 1));
        await loadChapterAt(index);
        renderChapterList();
        renderEditorHeader();
        toast(doneText);
      }
      await refreshShelf();
      // 撤销：用这次整理写盘前的备份整组还原（storage 会先把现在的内容再备份到 _trash/还原前备份-*）
      const backupName = result.backupDir ? String(result.backupDir).split(/[\\/]/).pop() : '';
      if (result.chaptersChanged && backupName) {
        // 1.5.0 P0-5（审计 V-2）：登记撤销时记下整理备份的指纹；撤销前核对它还是不是那一份。
        const expectedBackup = await backupGuard.fingerprint(bookPath, backupName);
        undoUi.activate(`已整理全书 ${result.chaptersChanged} 章`, async () => {
          if (!longOpLogic.sameBookPath(state.bookPath, bookPath)) throw new Error('已经换了书，不能撤销');
          // 五-H3（L-F1）：撤销会拿整理备份整组覆盖磁盘 + 从磁盘重载；编辑区有未保存的字时执行
          // 会把它们连磁盘带编辑区一起盖掉（reload 的脏闸拦不住已经发生的写盘）。
          if (state.dirty) throw new Error('编辑区有未保存的修改，请先保存后再撤销');
          await backupGuard.assertUnchanged(bookPath, expectedBackup);
          const data = await call(api.restoreHistoryDir, bookPath, `dir:${backupName}`);
          if (!data || !Number(data.restored)) throw new Error('整理备份里没有可还原的章节');
          await reloadOpenBookFromDisk(bookPath);
          await refreshShelf();
        }, { groupId: 'dir:' + backupName, bookPath });
      }
      return { ok: true, changed: result.chaptersChanged, data: result };
    } catch (err) {
      toast(`整理本书失败：${err.message}`, 'error');
      await reloadAfterPartialFailure(bookPath); // 可能已经整理了好几章，别让编辑区停在旧正文上
      return { ok: false, message: err.message };
    } finally {
      endLongOpLock();
      state.formatBookRunning = false;
      hideFormatBookProgress();
    }
  }

  async function setDisplayPreset(name) {
    const preset = DISPLAY_PRESETS[name];
    if (!preset) return;
    try {
      if (state.bookId) {
        const display = await call(api.setBookDisplay, state.bookId, preset.patch);
        state.bookDisplay = display || {};
        state.config = effectiveConfig();
        applyEditorStyle();
        toast(`本书正文显示已切换为「${preset.label}」（只影响这本书）`);
      } else {
        state.globalConfig = await call(api.setConfig, preset.patch);
        state.config = effectiveConfig();
        applyEditorStyle();
        toast(`正文显示已切换为「${preset.label}」（全局默认）`);
      }
    } catch (err) {
      toast(`切换显示失败：${err.message}`, 'error');
    }
  }

  // ---------- 设置 ----------
  // 第 4 步九刀·第七刀：实现在 renderer/settings-ui.js（模块头有契约），这里只装配与接线；
  // 2026-11-10 章号模式：设置里的「章号」写回 书目.json 后，用新 meta 把目录 / 标题 / 状态栏
  // 全部重画一次（只改显示，不动正文、不切章）。
  function applyChapterNumberingMeta(meta) {
    if (!meta || typeof meta !== 'object') return;
    state.meta = meta;
    if (Array.isArray(meta.chapters)) state.chapters = meta.chapters;
    renderChapterList();
    renderEditorHeader();
    updateStatus();
  }

  const settingsUi = settingsUiModule.create({
    $, state, api, call, toast, chaptersLib,
    // 1.4.0 P0-1：设置分区 / 搜索 / 深链纯逻辑（不在 host 必需契约里，缺了只退化成老的一长条）
    ia: settingsIaModule,
    display: { applyEditorStyle, syncCaretParagraphFromConfig, effectiveConfig, applySidebarWidth, loadCustomFont, readDisplayForm, displaySettingsIds, caretColorLib, s2tLib, templateLib, editorLogic, applyChapterNumbering: applyChapterNumberingMeta },
    peers: {
      stats: { refreshStats, renderStatsChart },
      writeTimer: { renderDurationSettings, renderWriteTimer, applyWriteTimerConfig, writeDurationEnabled, flushWriteTimer },
      editor: { renderEditorMarks, renderMarksMenu },
      words: { refreshSensitiveWordList, refreshProofreadWordList, sensitiveWordListText, proofreadWordListText, pickSensitiveWords, pickProofreadWords },
      refreshShelf
    },
    texts: { commonLib, formatBytes }
  });
  const { setSelectValue, renderSettingsCaretColors, renderChapterTemplatePreview, renderSensitiveSettings, renderProofreadSettings, checkUpdate, openUpdateDownload, previewSettings, openSettings, openStatsCalendar, closeSettings, resetBookDisplay, saveSettings, setupSettingsUi } = settingsUi;

  // ---------- A3 第二刀：保存链模块装配（host 里全是已绑定的 const / 提升函数） ----------
  // 为什么放这里：本刀 host 依赖 saveStatusUi / saveRescueUi / renderStatsUi / flushWriteTimer /
  // restoreFindBookmarkForCurrentChapter / stopTtsForChapterChange 这些装配点较晚的 const，统一在
  // bindEvents 之前一次装配；包装是函数声明，调用点零改动。
  const saveChainUi = saveChainUiModule.create({
    state, api, call, editorEl, toast, chaptersLib, saveLogic, openModal,
    saveStatusUi, saveRescueUi, formatChars, $, renderCharCount, renderSelectionStats,
    updateWindowTitle, clearFindSession, stopTtsForChapterChange, syncActiveChapterItem,
    renderEditorHeader, renderChapterList, syncChapterCharsAfterSave, renderStatsUi,
    flushWriteTimer, restoreFindBookmarkForCurrentChapter, scheduleMarksRender,
    scheduleTypewriterAlign, longOpLocked, askUnsaved, escLib, escProbe, escRun,
    DEFAULT_EDITOR_PLACEHOLDER,
    // 活绑定：这些 let 仍归编排器（测试钩子 / 开书链直写），按引用现取。
    getOpeningBook: () => openingBook,
    setBulkWriteUndo: (value) => { bulkWriteUndo = value; },
    setFallbackWriteUndo: (value) => { fallbackWriteUndo = value; },
    getTestLoadChapter: () => testLoadChapter,
    getTestSaveChapter: () => testSaveChapter,
    getTestVerifyBook: () => testVerifyBook,
    getCrashRecoveryUi: () => crashRecoveryUi
  });
  // ---------- A3 第三刀：书架视图模块装配（host 里全是已绑定的 const / 提升函数） ----------
  // 为什么放这里：本刀 host 依赖 renderShelf（bookinfo-ui 的 const）/ shelfSearchUi 的七个入口 /
  // refreshStats（statsUi 的 const）——统一在 bindEvents 之前装配；包装是函数声明，调用点零改动。
  const shelfViewUi = shelfViewUiModule.create({
    state, api, call, toast, $,
    refreshStats, markCommandsDirty, renderShelf, ensureSearchIndex,
    shelfQueryText, scheduleContentSearch, resetShelfContent, shelfSearchResults,
    openBookByPath, openContentResult, renderShelfContent, imeGuard,
    effectiveConfig, loadCustomFont, applyEditorStyle, syncCaretParagraphFromConfig,
    applySidebarWidth, CONTENT_SEARCH_MIN_CHARS, CONTENT_PAGE_SIZE
  });

  // ---------- A3 第四刀：章节模板 / 分卷 / 批量动作模块装配（host 里全是已绑定的 const / 提升函数） ----------
  // 为什么放这里：本刀 host 依赖 exportUi（openExportDialog）/ undoUi / chapterDirectoryUi 的入口 /
  // dragSortUi 的 moveChapterByDrop 等装配点较晚的 const，统一在 bindEvents 之前一次装配；
  // 包装是函数声明，调用点零改动。
  const chapterOpsUi = chapterOpsUiModule.create({
    state, api, call, toast, editorEl, $,
    chaptersLib, templateLib, CHAPTER_STATUS_LABELS,
    promptText, askUnsaved,
    chapterTitle, chapterStatus, chapterNote, formatCount,
    chapterVolumeId, volumeList, volumeById, volumeDisplayName,
    chapterMenuIsBatch, selectedChapterIndexes, clearChapterSelection,
    currentChapterId, currentChapterLabel,
    renderChapterList, renderEditorHeader, syncChapterFilterUi, syncVolumeHeaderName,
    syncChapterItemInfo, syncChapterBatchBar, markCommandsDirty,
    updateStatus, loadChapterAt, saveCurrent, refreshShelf, flushWriteTimer,
    undoUi, moveChapterByDrop, openExportDialog,
    replaceEditorTextNative, onEditorInput, recordFallbackWrite, scrollCaretIntoView,
    placeMenuAt
  });

  // ---------- 事件绑定 ----------
  function bindEvents() {
    // B16：弹层开合观察器（17 层 class 变化 → 缓存；没有 MutationObserver 时模块内部退回现算）
    backdropWatcher = backdropRegistry.createOpenWatcher($);
    setupSettingsUi();
    setupWriteTimerUi();
    // 统计筛选（1.6.0 F2）：两个下拉 + 「生成 CSV」（只绑定、不写盘）
    setupStatsUi();
    // 码字日历：翻月 / 回到本月（只读；点击不会写 stats.json）
    $('calendar-prev').addEventListener('click', () => {
      void shiftStatsCalendar(-1);
    });
    $('calendar-next').addEventListener('click', () => {
      void shiftStatsCalendar(1);
    });
    $('calendar-today').addEventListener('click', () => {
      void goToCurrentCalendarMonth();
    });
    // v0.13 U-D4：状态栏「今日字数」= 码字日历入口。写作页里点开也走「全局设置」并按全局默认
    // 回填（日历 / 每日目标 / 统计都是全局项），只滚动定位到日历；取消不写盘、保存语义照旧。
    $('status-stats').addEventListener('click', () => {
      void openStatsCalendar();
    });



    $('btn-import').addEventListener('click', onImportClick);

    setupFragmentsUi();

    // 剪贴板捕获（P0 列表视图）：顶栏按钮与全局快捷键走同一条流程——打开单列表，
    // 每一条记录右侧两个按钮「正文」（插进当前章）/「章节」（新建一章）
    $('btn-capture').addEventListener('click', () => {
      hideHeaderMenus();
      // 2026-11-06（v0.13.1 捕获队列）：顶栏「捕获」先看本次运行的队列——有记录就整列表显示，没有才读当前剪贴板
      void captureUi.open();
    });
    // 列表底栏：清空本次运行的队列（只清内存）/ 关闭面板
    $('btn-capture-queue-clear').addEventListener('click', () => {
      void captureUi.clearQueue();
    });
    $('btn-capture-queue-cancel').addEventListener('click', () => captureUi.cancel());
    // 列表记录：整块点击委托到右侧两个按钮（#capture-queue-list 由 capture-ui 整表重画，不能逐行绑定）。
    // 队列记录用 data-id，直捕的「当前剪贴板（未入队）」用 data-pending；两种都支持「正文」/「章节」。
    $('capture-queue-list').addEventListener('click', (event) => {
      const button =
        event.target && typeof event.target.closest === 'function'
          ? event.target.closest('button[data-action]')
          : null;
      if (!button || !button.dataset) return;
      let ref = null;
      if (button.dataset.pending) ref = { pending: true };
      else if (button.dataset.id) ref = { id: Number(button.dataset.id) };
      if (!ref) return;
      const action = button.dataset.action;
      if (action === 'body') void captureUi.applyBody(ref);
      else if (action === 'chapter') void captureUi.createChapter(ref);
    });
    // b11（捕获目标位置）：面板只负责显示；选中值交给 capture-ui（默认「全书末尾」）
    $('capture-position').addEventListener('change', () => {
      captureUi.setPosition($('capture-position').value);
    });
    // b9（捕获超限 >30 万字）：面板只给分步引导 —— 关面板 → 回书架 → 打开「导入小说」对话框。
    // 绝不自动写文件 / 自动导入；不存在的导入目标与取消都由导入流程自己提示。
    $('btn-capture-import').addEventListener('click', () => {
      captureUi.close();
      // B1（审计 E2）：回书架失败不再静默 —— 原来这条链 reject 时导入对话框永远不会弹
      void backToShelf()
        .then(() => onImportClick())
        .catch((err) => reportChainFailure('返回书架失败', err));
    });

    // 书架搜索（250ms 防抖 + 下一帧渲染）/ Esc 清空后立即重画 / 回车打开 / 清空按钮 / 正文「显示更多」
    // 整段在 renderer/shelf-view-ui.js（WP17 A3 第三刀）：事件注册顺序与处理函数体一字未改。
    shelfViewUi.bindShelfEvents();

    $('book-menu').addEventListener('click', async (event) => {
      const btn = event.target.closest('button[data-action]');
      if (!btn) return;
      const book = state.contextBook;
      if (!book) return;
      const action = btn.dataset.action;
      // 1.6.0b：点「移到分组…」只在菜单里展开分组列表，不收起菜单、不弹询问框；
      // 展开后菜单可能贴着窗口下沿，按同一套夹紧逻辑再收一次。
      if (action === 'move-group') {
        openBookGroupChooser(book);
        placeMenuAt($('book-menu'), parseFloat($('book-menu').style.left) || 0, parseFloat($('book-menu').style.top) || 0);
        return;
      }
      hideBookMenu();
      if (action === 'move-group-pick') {
        await moveBookToGroup(book, btn.dataset.group || '');
      } else if (action === 'move-group-new') {
        await newGroupForBook(book);
      } else if (action === 'open') {
        await openBookByPath(book.path);
      } else if (action === 'open-new-window') {
        await openBookInNewWindow(book);
      } else if (action === 'folder') {
        try {
          await call(api.openBookFolder, book.path);
        } catch (err) {
          toast(`打开文件夹失败：${err.message}`, 'error');
        }
      } else if (action === 'info') {
        openBookInfoDialog(book);
      } else if (action === 'delete') {
        await deleteBookFlow(book);
      } else if (action === 'history') {
        await openHistoryForPath(book.path, book.title);
      }
    });

    bookinfoUi.setupBookinfoUi();

    historyUi.setupHistoryUi();

    $('btn-continue-writing').addEventListener('click', () => openContinueBook());
    $('btn-conflict-close').addEventListener('click', closeConflictDialog);
    $('btn-conflict-open-folder').addEventListener('click', async () => {
      const book = state.conflictBook;
      if (!book) return;
      try {
        await call(api.openBookFolder, book.path);
        toast('已在资源管理器打开书文件夹');
      } catch (err) {
        toast(`打开文件夹失败：${err.message}`, 'error');
      }
    });
    $('btn-back').addEventListener('click', backToShelf);
    $('btn-rename-book').addEventListener('click', renameBookFlow);
    $('btn-new-chapter').addEventListener('click', () => createChapterAt(state.chapters.length));
    $('btn-new-volume').addEventListener('click', () => createVolumeFlow());
    $('btn-insert').addEventListener('click', () => createChapterAt(state.index + 1));
    $('btn-save').addEventListener('click', () => saveCurrent());
    // 状态栏保存失败态：点「重试」或点朱红文案 = 再走一次 saveCurrent()（1.3.0 T7）。
    // 只挂一次；仍是非静默保存，再次失败照旧有错误 toast。
    saveStatusUi.bindRetry();
    // 撤销条（1.4.0 P0-2）：给「撤销」按钮挂点击（幂等，只挂一次）。
    undoUi.setup();
    // 命令面板（1.4.0 P0-3）：输入框 / 列表 / 遮罩只挂一次。
    commandPalette.setup();
    findUi.setupFindUi();
    setupFocusModeUi();
    readingUi.setupReadingUi();
    // 查找书签（v0.8-11b）：把当前章的词 + 大小写存进 config；只写配置，不碰正文 / 书目
    setupFindBookmarkUi();
    setupProofreadUi();
    // 朗读本章（只读正文；悬浮小条：播放 / 暂停 / 停止 / 上一段 / 下一段 / 语速 / 语音 / 跟随高亮）
    $('btn-tts').addEventListener('click', () => {
      if (state.tts.open) closeTtsBar();
      else openTtsBar();
    });
    $('btn-tts-play').addEventListener('click', () => toggleTtsPlay());
    $('btn-tts-stop').addEventListener('click', () => {
      if (state.tts.open && state.tts.chunks.length) stopTts();
    });
    $('btn-tts-prev').addEventListener('click', () => ttsStep(-1));
    $('btn-tts-next').addEventListener('click', () => ttsStep(1));
    $('btn-tts-close').addEventListener('click', closeTtsBar);
    $('tts-rate').addEventListener('change', () => setTtsRate($('tts-rate').value));
    $('tts-voice').addEventListener('change', () => setTtsVoice($('tts-voice').value));
    $('tts-follow').addEventListener('change', () => setTtsFollow($('tts-follow').checked));
    // 系统语音列表是异步加载的：加载完刷新一下下拉框（只在朗读条开着的时候）
    if (typeof window.speechSynthesis !== 'undefined' && window.speechSynthesis.addEventListener) {
      window.speechSynthesis.addEventListener('voiceschanged', () => {
        if (state.tts.open) renderTtsVoices();
      });
    }
    $('btn-restore-replace').addEventListener('click', () => restoreReplaceBackupFlow());
    setupSensitiveUi();
    setupChapterDrag();
    $('btn-export').addEventListener('click', (event) => {
      event.stopPropagation();
      toggleExportMenu();
    });

    $('export-menu').addEventListener('click', async (event) => {
      const btn = event.target.closest('button[data-action]');
      if (!btn) return;
      hideExportMenu();
      if (btn.dataset.action === 'copy') await copyBookFlow();
      else if (btn.dataset.action === 'txt') openExportDialog('txt');
      else if (btn.dataset.action === 'epub') openExportDialog('epub');
      else if (btn.dataset.action === 'docx') openExportDialog('docx');
      else if (btn.dataset.action === 'sensitive') await openSensitivePanel();
      else if (btn.dataset.action === 'folder') await openBookFolderFlow();
      else if (btn.dataset.action === 'history') await openHistoryForCurrentBook();
    });

    // 导出范围对话框
    document.querySelectorAll('input[name="export-scope"]').forEach((radio) => {
      radio.addEventListener('change', () => refreshExportSummary());
    });
    $('export-volume').addEventListener('change', () => refreshExportSummary());
    $('export-from').addEventListener('input', () => scheduleExportSummary(120));
    $('export-to').addEventListener('input', () => scheduleExportSummary(120));
    $('btn-export-cancel').addEventListener('click', closeExportDialog);
    $('btn-export-confirm').addEventListener('click', () => confirmExportDialog());

    // 跳章（Ctrl+G）
    $('jump-input').addEventListener('input', () => scheduleJumpMatches());
    $('jump-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        // 1.7.1 P1（审计 V73）/ WP-04（V112）：输入法组字中的 Enter 只上屏候选词，不当「跳过去」
        if (imeGuard.isImeComposing(event)) return;
        event.preventDefault();
        confirmJumpFromDialog();
      }
    });
    $('btn-jump-cancel').addEventListener('click', closeJumpDialog);
    $('btn-jump-confirm').addEventListener('click', () => confirmJumpFromDialog());

    setupTidyCardUi();


    $('context-menu').addEventListener('click', async (event) => {
      const btn = event.target.closest('button[data-action]');
      if (!btn) return;
      const index = state.contextIndex;
      const action = btn.dataset.action;
      // 1.5.0 功能-1：落在多选中的章上（或批量条打开的菜单）→ 批量动作。
      // 单章动作（重命名 / 插入 / 备注 / 复制本章）在批量菜单里已经收起，只剩能作用到全部已选章的三类。
      const batch = chapterMenuIsBatch(index);
      // 移到卷：点「移到卷…」**不关菜单**，直接在菜单里展开卷列表（1.4.0 P0-2：不再弹模态选择框；
      // 展开后由下面的 move-volume:<id> 分支执行，执行前才收菜单）。
      if (action === 'move-volume') {
        openVolumeChooserInMenu(batch ? -1 : index);
        return;
      }
      hideContextMenu();
      if (action.startsWith('move-volume:')) {
        const volumeId = action.slice('move-volume:'.length) || null;
        if (batch) await moveSelectedChaptersToVolume(volumeId);
        else await moveChapterToVolume(index, volumeId);
        return;
      }
      if (action === 'rename') await renameChapterAt(index);
      else if (action === 'delete') {
        if (batch) await deleteSelectedChapters();
        else await deleteChapterAt(index);
      } else if (action === 'insert-before') await createChapterAt(index);
      else if (action === 'insert-after') await createChapterAt(index + 1);
      else if (action === 'edit-note') await editChapterNoteAt(index);
      else if (action === 'copy-platform') await copyChapterPlatformFlow(index);
      else if (action.startsWith('status-')) {
        if (batch) await setSelectedChaptersStatus(action.slice('status-'.length));
        else await setChapterStatusAt(index, action.slice('status-'.length));
      }
    });

    $('volume-menu').addEventListener('click', async (event) => {
      const btn = event.target.closest('button[data-action]');
      if (!btn) return;
      const volumeId = state.contextVolumeId;
      hideVolumeMenu();
      const action = btn.dataset.action;
      if (action === 'new-chapter') await createChapterAt(state.chapters.length, undefined, volumeId || null);
      else if (action === 'rename') await renameVolumeFlow(volumeId);
      else if (action === 'delete') await deleteVolumeFlow(volumeId);
      else if (action === 'move-up') await moveVolumeFlow(volumeId, -1);
      else if (action === 'move-down') await moveVolumeFlow(volumeId, 1);
    });

    editorEl.addEventListener('input', onEditorInput);
    // 大段插入（试用分支 B）/ 兜底整串赋值之后的第一下 Ctrl+Z：程序化赋值会把浏览器的撤销栈整个清空，
    // 原生撤销对这一步（连同之前的编辑历史）已经没反应；这里把它接到一次性快照上，
    // 让「写入 → Ctrl+Z」至少能退回到写入前。只有快照还在、焦点在正文时才生效，
    // 不会抢别的输入框（书架搜索 / 查找替换 / 跳章）里的 Ctrl+Z。
    editorEl.addEventListener('keydown', (event) => {
      if (!bulkWriteUndo && !fallbackWriteUndo) return;
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return;
      const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
      if (key !== 'z') return;
      event.preventDefault();
      // 审计修复 #39（V402）：兜底整串赋值与 bulk 插入共用这一个「第一下 Ctrl+Z」拦截口。
      const undone = bulkWriteUndo ? undoBulkWrite() : undoFallbackWrite();
      // 审计修复 #40（V403）：命中并真的执行了就不再冒泡到 document —— 那里还有一条「整理快照优先」
      // 的 Ctrl+Z（undoFormat）。两套通道没有互斥时，「整理本章 → 大段插入」连做后按一次 Ctrl+Z
      // 会连退两步（bulk 快照退一步 + 整理快照再退一步），与「一次按键撤销一步」的预期相反。
      // 只在执行成功时停止冒泡：快照已作废（换书 / 换章）时让 document 的整理通道照旧工作。
      if (undone) event.stopPropagation();
    });
    setupEditorMarks();

    setupSidebarResizer();
    // 卷章目录：筛选 / 清除 / 回到当前章（卷章树本身由 renderChapterList 负责）
    setupChapterDirectory();
    // 1.5.0 P0-2：章节条目的事件委托（整表重建不再逐条绑监听）
    setupChapterListEvents();
    // 1.5.0 功能-1：多选批量条（选中 ≥1 章时出现）
    setupChapterBatchBar();
    // 1.5.0 功能-4：快捷键一览的两个「关闭」出口（Esc 由 esc-registry 的 shortcuts 锁键层接）
    $('btn-shortcuts-close').addEventListener('click', closeShortcutsPage);
    $('btn-shortcuts-ok').addEventListener('click', closeShortcutsPage);

    // 导入进度（大书库导入可能要几十秒，分章/复制逐项汇报）
    api.onImportProgress((progress) => {
      if (!hasImportProgress()) return;
      if (!progress || !progress.total) {
        setImportProgressText('正在分析要导入的内容…');
        return;
      }
      if (progress.done >= progress.total) {
        setImportProgressText(`正在收尾（共 ${progress.total} 项）…`);
        return;
      }
      setImportProgressText(
        `正在导入 ${Math.min(progress.done + 1, progress.total)}/${progress.total}：${progress.current || ''}`
      );
    });

    // 主进程拦截到关窗/退出时，由这里决定「保存并退出 / 不保存退出 / 取消」
    // 全局快捷键 Ctrl+Alt+V / 主进程触发：剪贴板原文已经读好，这里先看本次运行的捕获队列
    // （queued=true 表示这一段刚入队；队列为空且这段没入队 → openTriggered 落成列表里的 pending 一条）
    api.onCaptureTriggered((payload) => {
      hideHeaderMenus();
      void captureUi.openTriggered(
        payload && typeof payload.text === 'string' ? payload.text : undefined,
        Boolean(payload && payload.queued)
      );
    });

    // b8（剪贴板联动）：后台监听发现「新复制的一段文字」→ 只给一条轻提示（带「捕获」按钮），
    // 点了才打开捕获面板（不自动弹）；提示里只有字数，没有正文。面板 / 询问框开着时不打扰。
    // 2026-11-07（列表视图）：面板开着就整表刷新列表（新复制的那条直接作为新记录出现），
    // 不再区分「队列视图 / 表单视图」；面板没开才弹轻提示。
    api.onClipboardChanged((payload) => {
      const chars = Number(payload && payload.chars) || 0;
      if (!Number.isFinite(chars) || chars <= 0) return;
      // 单条超限（主进程 captureQueue.add 拒了）：明说原因，别让作者以为「复制了却没记上」是灵异事件。
      if (payload && payload.tooLarge === true) {
        toast(
          `这段 ${formatCount(chars)} 字超过单条上限（30 万字），没有自动记录；` +
            '按 Ctrl+Alt+V 可直接捕获，或用「导入小说…」按章节拆',
          'warn'
        );
        return;
      }
      if (captureUi.isOpen()) {
        void captureUi.refreshQueue();
        return;
      }
      if (state.modal) return;
      toastActionable(`新复制 ${formatCount(chars)} 字，要捕获吗？`, '捕获', () => {
        hideHeaderMenus();
        void captureUi.open();
      });
    });

    // 每次记进队列都来一条（短复制没有上一条轻提示）：面板开着就刷新列表，
    // 否则忽略（不弹提示、不打扰）。事件只带条数，不带正文。
    api.onClipboardRecorded(() => {
      if (captureUi.isOpen()) void captureUi.refreshQueue();
    });

    // 主进程拦截到关窗/退出时，由这里决定「保存并退出 / 不保存退出 / 取消」
    api.onCloseRequested(handleCloseRequest);
    // 1.6.1 P-01：强制退出前主进程给的最后一次落盘机会（500 ms 后 destroy）：失败静默、不再弹框。
    api.onForceClose(() => {
      void saveCurrent({ silent: true })
        .catch(() => ({ ok: false }))
        .then((saved) => api.closeReady(Boolean(saved && saved.ok)));
    });
    // 1.6.0 F4b：顶栏右键「命令面板」——和 Ctrl+K 同一个入口（弹层 / 锁键层开着时不抢）
    api.onCommandPalette(() => openCommandPalette());
  // 别的窗口改了书架数据（新建 / 删除 / 保存 / 导入 / 整理）：停在书架就刷新；
  // 写作页里的窗口不打断作者，回书架时会统一刷新（backToShelf 里本来就会刷新）。
  // B2（WP18）：载荷带 bookPath 只增量换那张书卡；book:delete 删卡；无路径 / 读卡失败才整表（守卫与兜底在 shelf-ui）。
  api.onShelfChanged((payload) => shelfUi.handleShelfChanged(payload).catch(() => {}));
  // WP6（N2）：别的窗口换了书架根 → 本窗口刷新成新目录的书架；开着旧根的书则一次性提示 +
  // 救稿出口（同一个根只提示一次，去重在模块闭包里；救稿 / 回书架都复用既有入口）。
  const configChangeUi = configChangeUiModule.create({
    state, openModal, toast,
    rescueCopy: (mode) => saveRescueUi.rescueCopy(mode),
    goBackToShelf: () => backToShelf(),
    refreshShelf: () => refreshShelf(),
    refreshConfig: async () => {
      state.globalConfig = await call(api.getConfig);
      state.config = effectiveConfig();
    }
  });
  api.onConfigChanged((payload) => {
    void configChangeUi.handleConfigChanged(payload).catch(() => {});
  });
  // WP5（N1）：崩溃恢复。默认关（开关只在设置里打开）；打开后周期上报未保存正文 +
  // 启动 / 重载后检查上次崩溃草稿。恢复时正文只进编辑区（仍 dirty），Ctrl+S 才写盘。
  crashRecoveryUi = crashRecoveryUiModule.create({
    state, api, editorEl, toast, openModal, chapterTitle, openBookByPath, loadChapterAt,
    applyRecoveredText: (text) => {
      editorEl.value = text;
      onEditorInput();
    }
  });
  crashRecoveryUi.start();

    // 主进程内部错误（崩溃 / 未处理的 Promise）：只弹一句固定提示，细节留在日志里。
    // 应用不退出，作者可以先 Ctrl+S 保存再重启。
    api.onInternalError((info) => {
      state.lastInternalError = info || null;
      toast((info && info.message) || '程序遇到一个内部错误，已写进日志。', 'error');
    });

    // 整本排版进度（主进程逐章汇报，显示在右下角进度条上）
    api.onFormatProgress((progress) => {
      if (!state.formatBookRunning) return;
      if (!progress || !progress.total) return;
      showFormatBookProgress(
        `正在整理整本书：${Math.min(progress.done, progress.total)}/${progress.total} 章`
      );
    });

    // 正文搜索索引的建 / 校验进度：只更新书架搜索提示（不阻塞任何操作）
    api.onSearchProgress((info) => {
      if (!info) return;
      const content = state.shelfContent;
      content.indexStatus = {
        ...(content.indexStatus || {}),
        building: info.phase !== 'done',
        books: Number.isFinite(info.books) ? info.books : (content.indexStatus && content.indexStatus.books) || 0,
        chapters: Number.isFinite(info.chapters)
          ? info.chapters
          : (content.indexStatus && content.indexStatus.chapters) || 0,
        ready: Boolean(content.indexStatus && content.indexStatus.ready),
        progress: info
      };
      if (state.view === 'shelf' && shelfQueryText().length >= CONTENT_SEARCH_MIN_CHARS) {
        // 审计修复 #9（P1）：首建期搜索立即回 building + 空结果（core/search-index.js 的 search 短路），
        // 这一轮校验结束就按原查询自动重搜，兑现提示里的「建好后自动更新结果」；其他进度只刷新提示。
        if (info.phase === 'done' && content.meta && content.meta.index && content.meta.index.building) {
          scheduleContentSearch();
        } else {
          renderShelfContent();
        }
      }
    });

    document.addEventListener('click', (event) => {
      if (!event.target.closest('#context-menu') && !event.target.closest('.chapter-item')) hideContextMenu();
      if (!event.target.closest('#volume-menu') && !event.target.closest('.volume-item')) hideVolumeMenu();
      if (!event.target.closest('#btn-export') && !event.target.closest('#export-menu')) hideExportMenu();
      if (!event.target.closest('#format-dropdown')) hideFormatMenu();
      if (!event.target.closest('#display-dropdown')) hideDisplayMenu();
      if (!event.target.closest('#book-menu') && !event.target.closest('.book-card-more')) hideBookMenu();
    });

    document.addEventListener('keydown', (event) => {
      // 1.7.1 P1（审计 V73）/ WP-04（V112）：输入法组字期间一切全局键都不响应。组字中按 Enter 是「上屏候选词」，
      // 不是提交 —— 这一判放在 Esc 链与快捷键之前，兜住注册表上所有 Enter 语义
      // （通用询问框的 modalInput → modal-confirm、新建书名等），否则中文作者会把半截表单提交掉。
      // 判据统一走 ime-guard.js（isComposing || keyCode 229），别在这里另写一份。
      if (imeGuard.isImeComposing(event)) return;
      // 全局 Esc 链（v0.9 B-4）：顺序与命中判定全在 renderer/esc-registry.js 的有序表里，这里只执行动作。
      // 命中就到此为止——锁键弹层（通用询问框 + 冲突 / 书籍信息 / 历史 / 排版 / 导出 / 设置 / 跳章）
      // 连别的按键也一并接走，所以它们开着时 Ctrl+S / F11 也不会响（改前每段末尾那个裸 return 就是这个意思）。
      // 1.6.0 A5/P-09：探针只在「Esc 键 / 有锁键层」时现算 —— escProbe() 要读约 30 个元素与状态，
      // 而打字 / 输入法组字的每个 keydown 原本都先摊一份，纯属浪费。非 Esc 键只有在锁键层开着时
      // 才会被注册表接走（锁键层吞所有键），没有锁键层时 resolve 一定不命中。
      const escProbeNeeded = escLib.isEscapeKey(event.key) || anyBackdropOpen() || commandPalette.isOpen();
      const escHit = escProbeNeeded ? escLib.resolve(escProbe(), event.key) : null;
      if (escHit) {
        if (escHit.action) {
          if (escHit.preventDefault) event.preventDefault();
          escRun(escHit.action);
        }
        return;
      }
      // 快捷键一览（1.5.0 功能-4）：写作页按 ? / 中文输入法的 ？ 打开；Esc 由上面的快捷键锁键层收起。
      // 焦点在输入类目标（正文 textarea / 搜索框）里时 ? 是普通字符，不抢；任何弹层开着时也不开
      // （锁键弹层已经被上面的 Esc 链吞掉，这里兜住不锁键的面板，避免两层叠在一起）。
      // 不判 shiftKey：`?` 本身就是 Shift+/ 打出来的，判了反而永远不响。
      if (
        (event.key === '?' || event.key === '？') &&
        !event.ctrlKey && !event.altKey && !event.metaKey
      ) {
        if (imeGuard.isImeComposing(event)) return;
        if (undoActionModule.isTypingTarget(document.activeElement)) return;
        if (anyBackdropOpen()) return;
        event.preventDefault();
        openShortcutsPage();
        return;
      }
      // 命令面板（1.4.0 P0-3 / 规范 I-03）：Ctrl+K 打开；再按一次收起。锁键弹层开着时不抢
      // （与 Esc 链同一口径：通用询问框 / 冲突 / 历史 / 排版 / 导出 / 设置 / 跳章 / 命令面板本身）。
      if (
        event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey &&
        String(event.key).toLowerCase() === 'k'
      ) {
        // 面板开着时这一支走不到（esc-registry 的 command 层是锁键层，会先吞掉按键）；
        // 「再按一次 Ctrl+K 收起」由面板自己的输入框处理（command-palette-ui.js）。
        // 长按不重复开关（1.5.0 P0-4 / H-9）：event.repeat 派发的按键只吞掉、不再开合面板。
        if (!imeGuard.isImeComposing(event) && !event.repeat && !anyBackdropOpen()) {
          event.preventDefault();
          openCommandPalette();
        }
        return;
      }
      // 查找面板里的回车由 find-ui 自己的 `#find-query` 监听器处理（它 preventDefault + stopPropagation，
      // 按键不会再冒泡到这里）；这里不再重复一份，避免同一键按两次触发两次查找。
      // 专注模式（提案 3.5）：F11 来回切换（只在写作页；不写配置、不写盘）
      if (event.key === 'F11') {
        if (state.view === 'editor' && state.bookPath) {
          event.preventDefault();
          toggleFocusMode();
        }
        return;
      }
      // 查找：F3 / Shift+F3 重复上次查找（写作页，面板关着也能用；到两端绕回）
      if (event.key === 'F3' && !event.ctrlKey && !event.altKey && !event.metaKey) {
        if (state.view === 'editor' && state.bookPath && findSessionActive()) {
          event.preventDefault();
          void stepFind(event.shiftKey ? -1 : 1);
        }
        return;
      }
      // 重命名当前章（Phase D / D2）：F2 = 文件管理器 / 表格里的通用「重命名」。
      // 弹层打开时上面的 Esc 注册表先接走（锁键弹层连 F2 也吃），这里只管写作页；
      // 焦点在别的输入框里时不抢（查找 / 跳章 / 碎片 / 设置），编辑区自己除外。
      // 列表里用方向键只移焦点、不切章，所以「改哪一条」交给 renameTargetIndex 按焦点算。
      if (event.key === 'F2' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
        if (state.view !== 'editor' || !state.bookPath || state.index < 0) return;
        if (listKeyboard.isTypingTarget(document.activeElement, editorEl)) return;
        event.preventDefault();
        const target = listKeyboard.renameTargetIndex(document.activeElement, state.chapters.length, state.index);
        if (target >= 0) void renameChapterAt(target);
        return;
      }
      // 段落导航（提案 4.1）：Alt+↑/↓ 在自然段开头之间跳，只移动光标、不改字
      if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        if (state.view === 'editor' && state.bookPath) {
          event.preventDefault();
          jumpParagraph(event.key === 'ArrowDown' ? 1 : -1);
        }
        return;
      }
      // 复制本章（平台格式）：Ctrl+Shift+C；不抢 Ctrl+C 的普通复制
      if (event.ctrlKey && event.shiftKey && !event.altKey && String(event.key).toLowerCase() === 'c') {
        if (state.view === 'editor' && state.bookPath) {
          event.preventDefault();
          copyChapterPlatformFlow(state.index);
        }
        return;
      }
      const ctrl = event.ctrlKey && !event.altKey && !event.shiftKey;
      // 1.6.0 F1：章节列表里的 Ctrl+A = 全选（只认当前渲染出来的行，筛选 / 折叠时不偷选隐藏的章）。
      // 焦点在编辑区 / 输入框 / 别的区域时一律不管——原生全选正文 / 输入框的行为不变。
      if (ctrl && String(event.key).toLowerCase() === 'a') {
        const inList = event.target && typeof event.target.closest === 'function'
          ? event.target.closest('#chapter-list')
          : null;
        if (!inList) return;
        if (state.view !== 'editor' || !state.bookPath) return;
        const renderedIds = renderedChapterIds();
        if (!renderedIds.length) return;
        event.preventDefault();
        setChapterSelection(chapterSelectionLib.selectAll(renderedIds));
        return;
      }
      // 写作页切章（v0.13 U-D12）：Ctrl+PageUp / PageDown = 上一章 / 下一章。保存语义与点章节栏
      // 完全一致——只调 switchChapter（未保存走现成的询问框、保存走 saveCurrent），不新增静默保存、
      // 也不绕过它直接 loadChapterAt。首章 PageUp / 末章 PageDown 什么都不做（不绕回、不提示）；
      // 书架 / 阅读页 / 弹层开着时都不接管（弹层由上面的 Esc 注册表先接走）。
      if (ctrl && (event.key === 'PageUp' || event.key === 'PageDown')) {
        if (state.view !== 'editor' || !state.bookPath) return;
        event.preventDefault();
        // 上一趟切章还在读盘（连按 / 按住不放）就不叠第二趟，免得 state.index 与正文对不上
        if (state.loading) return;
        const target = listKeyboard.chapterSwitchTarget(state.index, event.key, state.chapters.length);
        if (target < 0) return;
        // B1（审计 E2）：切章失败要出声（原来 .then 没有 .catch，前面的步骤 reject 时静默不执行）
        void switchChapter(target)
          .then((result) => {
            if (!result || result.ok !== true || result.same) return;
            focusChapterItem({ mode: 'switch', index: target });
          })
          .catch((err) => reportChainFailure('切换章节失败', err));
        return;
      }
      if (ctrl && String(event.key).toLowerCase() === 'g') {
        event.preventDefault();
        if (state.view === 'editor' && state.bookPath) openJumpDialog();
        return;
      }
      if (ctrl && String(event.key).toLowerCase() === 'f') {
        event.preventDefault();
        if (state.view === 'editor' && state.bookPath) {
          openFindPanel();
        } else if (state.view === 'shelf') {
          $('shelf-search').focus();
          $('shelf-search').select();
        }
        return;
      }
      // 全局撤销（1.4.0 P0-2）：删除等动作留下的撤销优先于原生文本撤销；
      // 焦点在编辑区 / 输入框 / 下拉框 / contenteditable 里时一律不抢（isTypingTarget）。
      if (
        undoUi.hasPending() &&
        undoActionModule.isUndoKey(event, undoActionModule.isTypingTarget(document.activeElement))
      ) {
        event.preventDefault();
        void undoUi.runUndo();
        return;
      }
      if (ctrl && String(event.key).toLowerCase() === 'z') {
        // 「整理本章」留下的快照优先撤销；没有快照就让原生 Ctrl+Z 照常工作
        // 审计残留修复 #40（V403）：补焦点守卫 —— 焦点在查找 / 替换 / 跳章 / 书架搜索这些输入
        // 控件里时，Ctrl+Z 是框内自己的文本撤销，不能拿正文整理快照抢走（与相邻 undoUi 分支
        // 同一套 isTypingTarget 口径）。编辑区自己例外：整理快照撤的就是正文，焦点在正文里仍生效。
        const focusEl = document.activeElement;
        const inOtherInput = focusEl !== editorEl && undoActionModule.isTypingTarget(focusEl);
        if (!inOtherInput && state.view === 'editor' && state.bookPath && undoFormat()) {
          event.preventDefault();
          return;
        }
      }
      if (ctrl && String(event.key).toLowerCase() === 's') {
        event.preventDefault();
        if (state.view === 'editor' && state.bookPath) saveCurrent();
      } else if (ctrl && String(event.key).toLowerCase() === 'n') {
        event.preventDefault();
        if (state.view === 'editor' && state.bookPath) createChapterAt(state.chapters.length);
      }
      // 兜底的 Esc（收起右键菜单 / 顶栏菜单）在注册表最后一层，不用再写一遍。
    });

    window.addEventListener('resize', () => {
      hideContextMenu();
      hideHeaderMenus();
      applySidebarWidth(state.sidebarWidth);
      scheduleMarksRender(40);
      if (state.reading.open) scheduleReadingScrollCheck(80);
      if (focusActive() && state.focus.typewriter) scheduleTypewriterAlign(60);
    });
  }

  // ---------- 测试钩子的宿主契约（只在 ?test=1 时用；见 renderer/test-hooks.js 头注释） ----------
  // 测试钩子在独立文件里，引用不到这里的闭包，所以把要用的函数 / 变量 / DOM 引用交出去。
  // 稳定的东西直接 shorthand；模块级 let（活绑定）必须用 getter / setter，否则钩子看到的是旧快照。
  // 新增 / 删除钩子时两边一起改，单测 tests/test-hooks.test.js 会检查这里的键与钩子文件对得上。
  function testHooksScope() {
    return {
      $,
      alignTypewriter,
      answerModalValue,
      api,
      applyCaretColor,
      applyEditorStyle,
      applyFormatToEditor,
      applySidebarWidth,
      backToShelf,
      calendarSummaryText,
      call,
      captureUi,
      // WP5（N1）：崩溃草稿周期上报 / 恢复状态（E2E 用 crashDraftTick / setCrashDraftEnabled）
      crashRecoveryUi,
      canUndoFormat,
      caretColorLib,
      caretColorValue,
      chapterNote,
      chapterStatus,
      chapterTitle,
      chapterVolumeId,
      checkUpdate,
      clearChapterSelection,
      clearFindSession,
      closeBookInfoDialog,
      closeConflictDialog,
      closeFindPanel,
      closeFragmentDialog,
      closeGroupManageDialog,
      closeHistoryDialog,
      closeHistoryPreview,
      closeInsertFragmentDialog,
      closeJumpDialog,
      closeProofreadPanel,
      closeSensitivePanel,
      closeSettings,
      closeTtsBar,
      confirmHistoryRestore,
      confirmJumpFromDialog,
      copyChapterPlatformFlow,
      createBookWithTitle,
      createChapterAt,
      createVolumeFlow,
      deleteBookFlow,
      deleteChapterAt,
      commandPalette,
      openCommandPalette,
      openGroupManageDialog,
      deleteFindBookmark,
      deleteVolumeFlow,
      displayMenuOpen,
      editChapterNoteAt,
      editorEl,
      effectiveConfig,
      ensureSearchIndex,
      exitReadingMode,
      fakeErrorSpeech,
      fakeFinishSpeech,
      findPanelOpen,
      findSessionActive,
      flushWriteTimer,
      focusActive,
      formatCardOpen,
      formatCurrentChapterFromConfig,
      formatUndoSteps,
      goToCurrentCalendarMonth,
      handleCloseRequest,
      hideDisplayMenu,
      hideFormatMenu,
      hideHeaderMenus,
      importBooksFlow,
      insertSelectedFragment,
      installFakeSpeech,
      jumpParagraph,
      jumpToFindBookmark,
      jumpToNextLongParagraph,
      loadCustomFont,
      loadedCustomFont,
      measureCaretTop,
      moveChapterByDrag,
      moveChapterByDrop,
      moveChapterToVolume,
      moveVolumeFlow,
      onEditorInput,
      openBookByPath,
      openBookInNewWindow,
      openBookInfoDialog,
      openConflictDialog,
      openContinueBook,
      openFindPanel,
      openFormatDialog,
      openFragmentDialog,
      openHistoryForCurrentBook,
      openHistoryForPath,
      openInsertFragmentDialog,
      openJumpDialog,
      openProofreadPanel,
      openReadingMode,
      openSensitivePanel,
      openSettings,
      openTtsBar,
      openUpdateDownload,
      pauseWriteTimer,
      persistSidebarWidth,
      previewHistoryBackup,
      previewSettings,
      proofreadScope,
      proofreadWordListText,
      readBookInfoForm,
      readExportRange,
      readFormatOptions,
      readingBlockElements,
      readingBlockIndexAt,
      readingCurrentIndex,
      readingGo,
      readingJumpTo,
      readingLoadedIndexes,
      readingMeasureBlocks,
      readingNearBottom,
      readingScrollEl,
      readingScrollToBlock,
      readingVisibleIndex,
      refreshFragments,
      refreshHistory,
      refreshJumpMatches,
      refreshProofreadWordList,
      refreshReplaceBackups,
      refreshSensitiveWordList,
      refreshShelf,
      refreshStats,
      // 统计筛选 / CSV（1.6.0 F2）：E2E 用它切书 / 切年、读汇总行与 CSV 文本
      applyStatsFilter,
      buildStatsCsv,
      renameChapterAt,
      renameVolumeFlow,
      renderCaretColorRow,
      renderChapterTemplatePreview,
      renderContinueWriting,
      renderProofreadSettings,
      renderSelectionStats,
      renderSensitiveSettings,
      renderSettingsCaretColors,
      renderShelf,
      resetBookDisplay,
      resetWriteTimer,
      restoreFindBookmarkForCurrentChapter,
      restoreReplaceBackupFlow,
      runFind,
      runFormatBook,
      runProofread,
      runReplaceAll,
      runReplaceOne,
      runSensitiveCheck,
      s2tLib,
      saveBookInfoDialog,
      saveCurrent,
      saveFindBookmark,
      saveFragment,
      saveSettings,
      scheduleContentSearch,
      scheduleReadingScrollCheck,
      selectFindMatch,
      selectFragmentByName,
      sensitiveScope,
      sensitiveWordListText,
      setCaretColorPersisted,
      setCaretParagraphPersisted,
      setChapterStatusAt,
      setDisplayPreset,
      setFocusMode,
      setFocusTypewriter,
      setMarksToggle,
      setReadingPref,
      setSelectValue,
      setTtsFollow,
      setTtsRate,
      setTtsVoice,
      shiftStatsCalendar,
      showBookMenu,
      showDisplayMenu,
      showFormatCard,
      speechEngine,
      startWriteTimer,
      state,
      stepFind,
      stopTts,
      switchChapter,
      syncFindOverlayScroll,
      syncMarksScroll,
      toggleMarks,
      toggleTtsPlay,
      toggleVolumeCollapse,
      ttsStep,
      undoFormat,
      updateCaretParagraph,
      updateFragmentCounter,
      updateReadingUi,
      updateStatus,
      volumeList,
      writeDurationEnabled,
      writeFormatOptions,
      writeTimerSessionSeconds,
      writeTimerTodaySeconds,
      writeTimerUnsentMs,
      get exportFormat() {
        return exportFormat;
      },
      get fakeSpeechState() {
        return fakeSpeechState;
      },
      get formatBookProgressEl() {
        return formatBookProgressEl;
      },
      get lastFontDecodeMode() {
        return lastFontDecodeMode;
      },
      // 活绑定：测试钩子会把全书校验替换掉（E2E 验「保存不等校验」的时序）
      set testVerifyBook(value) {
        testVerifyBook = value;
      },
      // 活绑定：测试钩子用 setTestSaveDelay 包一层保存 IPC（E2E 验「保存期间输入」的时序，WP-01/C1）
      set testSaveChapter(value) {
        testSaveChapter = value;
      },
      // 活绑定：测试钩子用 setTestBookOpDelay 包一层「整本整理 / 还原备份」IPC（WP-02/C2）
      set testBookOp(value) {
        testBookOp = value;
      },
      // 活绑定：测试钩子用 setTestOpenBookDelay / setTestLoadChapterDelay 包一层开书 / 载章 IPC
      // （WP-03 / V102 / C9：制造响应乱序与载章在途的窗口）
      set testOpenBook(value) {
        testOpenBook = value;
      },
      set testLoadChapter(value) {
        testLoadChapter = value;
      },
      // 活绑定：测试钩子用 setTestFindNextDelay 包一层「查找下一处」IPC（WP3/E-N4 回执迟到）
      set testFindNext(value) {
        testFindNext = value;
      }
    };
  }

  // 测试钩子文件动态加载：只有 ?test=1 才会请求 / 解析它（正常使用完全不受影响）
  function loadTestHooks() {
    if (window.CWTestHooks) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'test-hooks.js';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('测试钩子脚本加载失败'));
      document.head.appendChild(script);
    });
  }


  // ---------- 初始化 ----------
  // 书架网格当前几列（拍板 #16b）：实现在 renderer/shelf-view-ui.js（WP17 A3 第三刀）。
  function bookGridColumns() { return shelfViewUi.bookGridColumns(); }

  async function init() {
    // B1（审计 E2）：最先挂全局兜底，init 里后面任何一步漏掉的 rejection 都还能留痕 + 提示
    installFailureGuard();
    bindEvents();
    // 弹层焦点管理（v0.9 A-5）：打开带焦点进来、Tab 不跑出弹层、关闭后还给背景
    if (window.CWDialogFocus) window.CWDialogFocus.install();
    // 键盘可达（v0.9 A-5b）：章节列表方向键 + Enter / 空格切章；书卡 Enter / 空格打开。
    // 只挂容器上的 keydown（事件委托），不碰 click / 双击 / 右键 / 拖拽。
    listKeyboard.install({
      container: $('chapter-list'),
      itemSelector: '.chapter-item',
      arrows: true,
      // Phase D / D1：Alt+↑/↓ 在本卷内上移 / 下移这一章（跨卷不接管，仍用拖拽 /「移到卷…」）
      // 五-H1（ES-5）：position 是**渲染行位置**（筛选 / 折叠会跳行），moveChapterStep 吃的是
      // **书内下标**；dataset.index 才是书内下标（与 onActivate / onExtend 同口径）。
      onAltMove: (item, position, direction) => {
        void moveChapterStep(Number(item.dataset.index), direction);
      },
      // U-D9：列表焦点里按 Delete = 删除焦点所在这一章。键位只是复用右键菜单同一条
      // deleteChapterAt（未保存询问 / 确认框 / 进 _trash / 失败提示全都不动），不新增删除语义。
      // 删完把焦点放回列表原位置，键盘用户不会掉回 body；编辑区不在这个容器里，Delete 删字不受影响。
      allowDelete: true,
      onDelete: (item, position) => {
        // 五-H1（ES-5）：position 是渲染行位置（筛选 / 折叠会跳行）——直接当书内下标消费会删错章。
        // dataset.index 才是书内下标（与 onActivate / onExtend 同口径）。
        const chapterIndex = Number(item.dataset.index);
        // 1.5.0 功能-1：焦点章在多选里（且选了不止一章）→ Delete 删整批，只登记一条撤销
        if (state.selectedIds.size > 1 && state.selectedIds.has(chapterIdAt(chapterIndex))) {
          void deleteSelectedChapters()
            .then((deleted) => {
              if (deleted) focusChapterItem({ mode: 'position', position });
            })
            .catch((err) => reportChainFailure('批量删除失败', err));
          return;
        }
        // B1（审计 E2）：删除失败不再静默（原来 .then 没有 .catch，焦点恢复那步永不执行）
        void deleteChapterAt(chapterIndex)
          .then((deleted) => {
            if (deleted) focusChapterItem({ mode: 'position', position });
          })
          .catch((err) => reportChainFailure('删除这一章失败', err));
      },
      // 1.6.0 F1：Shift+↑/↓ 扩选。焦点已经由 list-keyboard 挪到相邻行，这里只算选中范围；
      // 顺序取**当前渲染出来的行**（筛选时只扩看得见的章），首按从焦点章起算，
      // 之后从同一个 anchor 并集扩——范围怎么算全在 chapter-selection.js 的 extendFocus 里。
      onExtend: (item, from, targetItem, to) => {
        const next = chapterSelectionLib.extendFocus(
          chapterSelectionSnapshot(),
          renderedChapterIds(),
          chapterIdAt(Number(item.dataset.index)),
          to > from ? 1 : -1,
          chapterIdAt(Number(item.dataset.index))
        );
        if (next.focusId === null) return;
        setChapterSelection({ ids: next.ids, anchorId: next.anchorId });
      },
      // 键盘 Enter / 空格 = 普通单击：清空多选再切章（与鼠标点一下同一口径）
      onActivate: (item) => {
        clearChapterSelection();
        switchChapter(Number(item.dataset.index));
      }
    });
    listKeyboard.install({
      container: $('book-grid'),
      // 只认真正的书卡：同一张网格里还有「＋ 新建一本书」，那是原生 <button>，
      // 它自己的 Enter / 空格照旧走 click（不能让卡片拦掉）。
      itemSelector: '.book-card[data-path]',
      // 拍板 #16b：书架是多列网格，方向键按网格走（←/→ 只在行内、↑/↓ 跨行）。
      // 列数每次按键现算（getComputedStyle 的 gridTemplateColumns），窗口 resize / 响应式换列自动跟随。
      arrows: true,
      columns: () => bookGridColumns(),
      onActivate: (card) => {
        if (card.dataset.path) openBookByPath(card.dataset.path);
      }
    });
    // 菜单键盘（v0.9 A-5c）：右键 / 顶栏菜单打开时焦点进第一条、方向键走、Esc 收起并还给打开它的元素
    if (window.CWMenuKeyboard) window.CWMenuKeyboard.install();
    // 自绘标题栏（1.3.0 T6 / 规范 I-07）：窗口失焦时纸色 -2% / 朱红降灰（只挂一个 body class，
    // 不写配置、不碰正文；系统按钮区的配色在主进程按同一套主题表刷）
    if (window.CWWindowChromeUi) window.CWWindowChromeUi.createWindowChromeUi().install();
    // 分卷标题行（v0.9 A-5c）：Tab 可达 + Enter / 空格折叠展开，列表重建后焦点回到同一卷
    listKeyboard.installVolumeHeaders({ container: $('chapter-list') });
    try {
      state.globalConfig = await call(api.getConfig);
      state.config = { ...state.globalConfig };
    } catch (err) {
      toast(`读取配置失败：${err.message}`, 'error');
    }
    // 查找书签（v0.8-11b）：旧配置没有 findBookmarks 也照常启动（= 没有书签）；
    // 列表只用于面板显示，打开章节时是否自动高亮由「书 + 章」匹配决定。
    state.findBookmarks = bookmarksLib
      ? bookmarksLib.sanitizeBookmarks(state.globalConfig && state.globalConfig.findBookmarks)
      : [];
    renderFindBookmarks();
    // 版本号以 package.json 为唯一事实来源（v1.8.0 WP-37 / 审计 D10）：界面文字由主进程
    // app.getVersion() 经 app:version 运行时注入，index.html 里不再写死版本串。
    const versionEl = $('app-version');
    try {
      const appInfo = await call(api.appVersion);
      if (appInfo && appInfo.version) versionEl.textContent = `v${appInfo.version}`;
      state.appVersion = (appInfo && appInfo.version) || '';
    } catch {
      /* 拿不到版本号就留占位，不回退到写死的版本串 */
    }
    if (versionEl && !versionEl.textContent) versionEl.textContent = 'v—';
    // 启动时取一次主进程攒下的提示（例如配置文件损坏已归档）
    try {
      const warning = await call(api.appWarning);
      if (warning && warning.message) toast(warning.message, 'warn');
    } catch {
      /* 拿不到提示不影响启动 */
    }
    applyEditorStyle();
    // 当前段落高亮：启动时按全局默认同步开关（打开书后再按这本书的覆盖换一次）
    syncCaretParagraphFromConfig();
    applySidebarWidth((state.config && state.config.editorSidebarWidth) || 250);
    // 字体真正加载完可能会改变换行：加载好以后把标记层重新对齐一次
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => scheduleMarksRender(0)).catch(() => {});
    }
    // 上次用的自定义字体：启动时异步加载（失败就退回内置字体，不影响写作）
    if (state.config && state.config.editorFont === 'custom' && state.config.editorCustomFontPath) {
      // A6（审计 E8）：补 .catch —— 字体加载失败时退回内置字体，绝不让这段变成 unhandledrejection
      loadCustomFont(state.config.editorCustomFontPath, { silent: true })
        .then(() => applyEditorStyle())
        .catch(() => {});
    }
    showView('shelf');
    await refreshShelf();
    // 1.3.0 T5（规范 I-10）：首次运行提示只出现一次（书架真空 + config 还没记过已提示）。
    // 这里等标记真的写回 config 再往下走，下次启动就不会再显示。
    await maybeShowFirstRunTip();
    // 从「在新窗口打开」进来的窗口：启动后直接打开指定的书（由主进程在 URL 里传路径）
    const openAtStart = new URLSearchParams(location.search).get('open');
    if (openAtStart) await openBookByPath(openAtStart);
    if (state.testMode) {
      // 测试钩子单独一个文件，只有测试模式才加载；加载失败就明说（E2E 会立刻红）
      try {
        await loadTestHooks();
        window.__cwTest = window.CWTestHooks.create(testHooksScope());
        window.__cwTest.ready = true;
      } catch (err) {
        console.error('测试钩子加载失败', err);
        toast('测试钩子加载失败：' + err.message, 'error');
      }
    }
  }

  // A6（审计 E8）：DOMContentLoaded 不再直接挂 async 的 init —— 那样 init 里任何一处失败都会变成
  // unhandledrejection（界面停在一半初始化，控制台里只剩一条无主错误）。包一层显式 catch：
  // 失败只记 console.error，不改变原有「启动失败就停下」的行为。
  document.addEventListener('DOMContentLoaded', () => {
    init().catch((err) => {
      console.error('启动失败', err);
    });
  });
})();
