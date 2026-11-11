/* 章回 —— 渲染层（版本号见 package.json，界面底部显示主进程回报的值）
 * 规则：这里的任何东西都不能直接访问文件系统；所有读写都通过 window.api（白名单 IPC）。
 * 保存策略：完全手动。只有按 Ctrl+S / 点保存才写正文；切章、关窗、导出前只提醒，不偷偷写。
 */
(() => {
  'use strict';

  const api = window.api;
  const $ = (id) => document.getElementById(id);
  const editorEl = $('editor');
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
  // 返回书架 + 改名（v0.9 B-5 第十刀）：未保存拦截 / 清空当前书 / 切回全局显示设置、书改名
  // 两个相邻小分区在 shelf-nav-ui.js 里；这里只接线（入口按名字被事件绑定 / 测试钩子取用）。
  const shelfNavUiModule = window.CWShelfNavUi;
  // 剪贴板捕获（P0 功能重放；2026-11-07 列表视图改造）：单列表面板 / 正文插入 / 章节新建整段在
  // capture-ui.js 里（WIP f9fc403 的 410 行不写回本文件）；这里只接线（入口按名字被事件绑定 /
  // Esc 动作表 / 测试钩子取用），外加 host.insertIntoBody（「正文」按钮要动编辑区，只能用本文件的闭包）。
  const captureUiModule = window.CWCaptureUi;
  // 本书历史（第 4 步九刀·第一刀）：历史面板整段在 history-ui.js 里；这里只接线
  const historyUiModule = window.CWHistoryUi;
  // 日历 / 统计文案用的格式化口径：就是本文件的 formatChars / formatDuration（函数声明会提升，
  // 阅读模式（第 4 步九刀·第二刀）：整本只读通读整段在 reading-ui.js 里；这里只接线
  const readingUiModule = window.CWReadingUi;
  // 放在调用之前没问题）。stats-logic.js 自己不复制第二套格式，调用时把这对函数传进去。
  // 编辑器小件（第 4 步九刀·第三刀）：标记层 / 超长段落 / 段落导航 / 高亮色板整段在 editor-marks-ui.js 里；
  const editorMarksUiModule = window.CWEditorMarksUi;
  const statsFormat = { formatChars, formatDuration };
  // 校对（第 4 步九刀·第四刀）：规则摘要 / 结果列表 / 跳转 / 跑校对 / 选词表整段在 proofread-ui.js 里；
  const proofreadUiModule = window.CWProofreadUi;
  // 书架正文搜索：输入停顿多久后才查（避免每敲一个字都查一次）；正文最少 2 个字
  // 敏感词预检（第 4 步九刀·第五刀）：面板 / 摘要 / 结果 / 跳转 / 选词表整段在 sensitive-ui.js 里；
  const sensitiveUiModule = window.CWSensitiveUi;
  const CONTENT_SEARCH_DEBOUNCE = 320;
  // 书籍信息（第 4 步九刀·第六刀）：书籍信息弹层 + 书架渲染 + 新建书整段在 bookinfo-ui.js 里；
  const bookinfoUiModule = window.CWBookinfoUi;
  const CONTENT_SEARCH_MIN_CHARS = 2;
  // 设置（第 4 步九刀·第七刀）：设置弹层 + 数据台账整段在 settings-ui.js 里；这里只接线
  const settingsUiModule = window.CWSettingsUi;
  // 设置面板信息架构（1.4.0 P0-1）：5 个分区 / 顶部搜索 / 深链的纯逻辑在 settings-ia.js 里
  const settingsIaModule = window.CWSettingsIa;
  const CONTENT_PAGE_SIZE = 8;
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
  const CONTENT_RESULT_LIMIT = 40;
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
      // 只认白名单里的部分成功字段（不带 ok / message 这些已有字段，免得覆盖 Error 的语义）
      const extra = res && res.bodySaved === true
        ? { bodySaved: true, chars: res.chars, file: res.file }
        : null;
      throw new ApiError((res && res.message) || '未知错误', res && res.code, extra);
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
    baseText: '',
    dirty: false,
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
    testMode: new URLSearchParams(location.search).has('test')
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
  function openModal({ title, message, input, buttons, cancelValue = null }) {
    return new Promise((resolve) => {
      state.modal = { resolve, opts: { title, message, input, buttons, cancelValue } };
      $('modal-title').textContent = title || '';
      const messageEl = $('modal-message');
      messageEl.textContent = message || '';
      messageEl.classList.toggle('hidden', !message);
      const inputEl = $('modal-input');
      if (input) {
        inputEl.classList.remove('hidden');
        inputEl.value = input.value == null ? '' : input.value;
        inputEl.placeholder = input.placeholder || '';
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
      (buttons || []).forEach((button) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `btn ${button.kind || 'ghost'}`;
        btn.textContent = button.label;
        btn.dataset.value = String(button.value);
        btn.addEventListener('click', () => {
          const value = input ? inputEl.value : undefined;
          closeModal({ action: button.value, value });
        });
        box.appendChild(btn);
      });
      $('modal-backdrop').classList.remove('hidden');
      if (!input) {
        const primary = box.querySelector('.btn.primary') || box.firstElementChild;
        if (primary) primary.focus();
      }
    });
  }

  function closeModal(result) {
    const current = state.modal;
    state.modal = null;
    $('modal-backdrop').classList.add('hidden');
    $('modal-input').classList.add('hidden');
    if (current) current.resolve(result || { action: null });
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

  // 「还原前」的未保存拦截：整本替换备份还原（本文件）与历史备份还原（renderer/history-ui.js）流程相同，
  // 只有文案不同 —— 取消 / 放弃修改并还原 / 保存修改后再还原，保存失败就停在原地不继续还原。
  // 调用方各自判 state.dirty（历史弹层还能看别的书，不能拿当前书的脏标记去拦别的书）。
  // 返回 { ok:true } = 可以继续还原；{ ok:false, canceled:true } = 作者取消；
  // { ok:false, saved } = 保存失败，saved 是 saveCurrent() 的失败结果（原样上抛，提示已弹过）。
  async function confirmRestoreWithUnsaved(message) {
    const action = await askUnsaved({
      title: '还原前先处理未保存的修改',
      message,
      saveLabel: '保存修改后再还原',
      discardLabel: '放弃修改并还原'
    });
    if (action === 'cancel') return { ok: false, canceled: true };
    if (action === 'save') {
      const saved = await saveCurrent();
      if (!saved.ok) return { ok: false, saved };
    }
    return { ok: true };
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
    // 字体 / 字号 / 行距变了，标记层要重新对齐
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

  // 打开一本书后套用这本书的显示设置（没有单独设置过就沿用全局）
  async function applyBookDisplay(bookId) {
    let display = {};
    try {
      display = (await call(api.getBookDisplay, bookId)) || {};
    } catch {
      display = {};
    }
    state.bookDisplay = display;
    state.config = effectiveConfig();
    if (state.config.editorFont === 'custom' && state.config.editorCustomFontPath) {
      await loadCustomFont(state.config.editorCustomFontPath, { silent: true });
    }
    applyEditorStyle();
    // 当前段落高亮的开关 / 颜色按这本书的覆盖（没有覆盖就用全局默认）
    syncCaretParagraphFromConfig();
    applySidebarWidth(state.config.editorSidebarWidth != null ? state.config.editorSidebarWidth : 250);
  }

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
  async function refreshShelf() {
    // 上次写作位置每次回书架都重新取：在编辑页切章 / 保存后主进程已经更新了配置
    try {
      state.recentBook = await call(api.getRecentBook);
    } catch {
      state.recentBook = null;
    }
    // 今日字数 / 近 30 天统计（主进程算本地日期，界面不自己算）
    await refreshStats();
    try {
      state.books = await call(api.listBooks);
    } catch (err) {
      state.books = [];
      toast(`读取书架失败：${err.message}`, 'error');
    }
    markCommandsDirty(); // 书架变了：命令面板里的「书」条目要重建（1.5.0 P0-6）
    renderShelf();
    // 正文索引：回书架时顺手让主进程校验 / 增量更新（后台，不 await、不挡书架显示）。
    // 第一次打开大书架会建索引，进度通过 search:progress 回到这里显示。
    void ensureSearchIndex();
    if (shelfQueryText().length >= CONTENT_SEARCH_MIN_CHARS) scheduleContentSearch();
  }

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
    $, state, chapterTitle, formatRelativeTime, openBookByPath, askUnsaved, saveCurrent, loadChapterAt
  });
  const { renderContinueWriting, openContinueBook, openConflictDialog, closeConflictDialog } = shelfUi;

  // ---------- 书籍信息 ----------
  // 第 4 步九刀·第六刀：实现在 renderer/bookinfo-ui.js（模块头有契约），这里只装配与接线；
  const bookinfoUi = bookinfoUiModule.create({
    $, state, api, call, toast,
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
    openGroupManageDialog, closeGroupManageDialog, renameShelfGroup, mergeShelfGroup, moveBookToGroup,
    renderShelf, createBookWithTitle, onNewBookClick, setupBookinfoUi, maybeShowFirstRunTip
  } = bookinfoUi;

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
    // 1.6.0 H1（审计 E-01，丢稿）：换书前先处理当前章节的未保存修改 —— 保存并继续 / 丢弃 / 取消。
    // 「取消」或「保存失败」都停在原地（正文、dirty、撤销条全不动）；决策是 open-book-guard.js
    // 里的纯函数（Node 单测覆盖），这里只负责弹窗与保存。四个换书入口都走这一个函数。
    const dirtyBeforeSwitch = state.dirty === true;
    if (openBookGuard.decideOpenBook({ dirty: dirtyBeforeSwitch }).action === 'prompt') {
      const choice = await askUnsaved({
        title: '换书前先处理未保存的修改',
        message: `「${currentChapterLabel()}」还有未保存的修改。换到另一本书后，编辑区里这些字不会跟着过去。`
      });
      let saveResult = null;
      if (choice === 'save') saveResult = await saveCurrent();
      const guard = openBookGuard.decideOpenBook({ dirty: dirtyBeforeSwitch, choice, saveResult });
      // 失败提示 saveCurrent 已经弹过（与还原 / 删除前拦截同口径），这里只负责别继续换。
      if (guard.action !== 'proceed') return;
    }
    let data;
    try {
      data = await call(api.openBook, bookPath);
    } catch (err) {
      if (err.code === 'BOOK_OPEN_IN_OTHER_WINDOW') {
        // 同一本书只允许一个窗口：主进程已经聚焦了那个窗口
        toast(err.message || '这本书已经在另一个窗口打开，已切换到那个窗口', 'warn');
        return;
      }
      if (err.code === 'PARSE_ERROR' || err.code === 'INVALID_META' || err.code === 'NO_BOOK') {
        const known = (state.books || []).find((b) => b.path === bookPath);
        await openRepair(
          known || { path: bookPath, title: '这本书', status: 'corrupt', reason: err.message }
        );
        return;
      }
      toast(`打开失败：${err.message}`, 'error');
      return;
    }

    if (data.missing && data.missing.length) {
      toast(`注意：${data.missing.length} 个章节文件缺失，可在「导出 → 打开本书文件夹」里检查`, 'warn');
    }

    // 换书：撤销条不跨书（撤销闭包里还会再核对一次 state.bookPath）
    undoUi.clear();
    // 换书前先停掉上一本的写作计时：把没上报的整秒记下，新书从 0 开始
    await resetWriteTimer({ flush: true });
    state.bookPath = bookPath;
    state.meta = data.meta;
    state.bookId = data.meta.id;
    state.chapters = data.meta.chapters;
    state.collapsedVolumes = new Set(); // 换书重置折叠状态
    state.chapterFilter = ''; // 换书清空目录筛选（否则新书会带着上一本的筛选词，看起来像丢章）
    state.selectedIds = new Set(); // 换书清空多选（1.5.0 功能-1：多选不跨书）
    state.selectAnchorId = null;
    state.batchMenu = false;
    state.dirty = false;
    state.saveError = null;
    state.baseText = '';
    $('book-title').textContent = data.meta.title;
    $('book-title').title = data.meta.title;
    showView('editor');
    renderChapterList();
    // 套用这本书自己的显示设置（没有单独设置过就沿用全局）
    await applyBookDisplay(data.meta.id);

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
    if (target && Number.isFinite(Number(target.matchIndex))) {
      selectEditorRange(Number(target.matchIndex), Number(target.matchLength) || 0);
    }
    return data;
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
      focusChapterById(chapter.id);
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
    focusChapterById(chapter.id);
    undoUi.activate(`已把「${chapterTitle(index, chapter.name)}」移到「${toVolume}」`, async () => {
      if (state.bookPath !== bookPath) throw new Error('已经换了书，不能撤销');
      const at = state.chapters.findIndex((c) => c.id === chapter.id);
      if (at < 0) throw new Error('这一章已经不在书里了');
      const back = await moveChapterByDrop(state.chapters[at], {
        volumeId: fromVolumeId,
        beforeChapterId: beforeId
      });
      if (!back || back.ok !== true) throw new Error((back && back.message) || '移动没有生效');
      focusChapterById(chapter.id);
    });
    return true;
  }

  // 移动后列表会整表重建：焦点放回同一章（否则连按 Alt+↓，按一次焦点就丢到 body），
  // roving 停留点也跟着这一条（和方向键移焦点同一个口径）。
  function focusChapterById(chapterId) {
    const list = $('chapter-list');
    const at = state.chapters.findIndex((c) => c.id === chapterId);
    if (!list || at < 0) return;
    const items = Array.from(list.querySelectorAll('.chapter-item'));
    listKeyboard.applyTabStops(items, at);
    const el = items[at];
    if (!el) return;
    if (typeof el.focus === 'function') el.focus();
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }

  // U-D9：键盘删除后列表会整表重建（删当前章还会切到下一章）——把焦点放回列表里的原位置
  // （删的是最后一条就落到新的最后一条），连按 Delete 才删得动，不会掉回窗口 body。
  // 删掉当前章时主进程给的下一章下标正好是同一位置，所以落点就是新的当前章。
  function focusChapterAfterDelete(position) {
    const list = $('chapter-list');
    if (!list) return;
    const items = Array.from(list.querySelectorAll('.chapter-item'));
    if (!items.length) return;
    const want = Number.isFinite(position) ? Math.floor(position) : 0;
    const at = Math.max(0, Math.min(want, items.length - 1));
    listKeyboard.applyTabStops(items, at);
    const el = items[at];
    if (typeof el.focus === 'function') el.focus();
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }

  // U-D12：Ctrl+PageUp / PageDown 切章后，焦点原本在左侧章节列表里时把它带到新当前章
  // （切章走的是「只改高亮 / tabIndex」的快路径，旧条目还在，焦点留在旧章会和当前章对不上）。
  // 焦点在编辑区 / 工具栏时一个字都不动 —— 绝不把焦点从正文抢走。
  function focusChapterAfterSwitch(index) {
    const list = $('chapter-list');
    const active = document.activeElement;
    if (!list || !active || typeof active.closest !== 'function') return false;
    if (!active.closest('#chapter-list')) return false;
    const item = list.querySelector(`.chapter-item[data-index="${index}"]`);
    if (!item || typeof item.focus !== 'function') return false;
    item.focus();
    return true;
  }

  // ---------- 章节列表 ----------
  // 2026-11-10 卷章目录重设计：书架返回 / 书名 / 全书概览 / 筛选 / 卷章树 / 底部一行操作。
  // 这里只加显示层的东西：筛选词存在 state.chapterFilter（内存），换书 / 新建章时清空；
  // 打开 / 保存 / 折叠 / 拖拽 / 右键 / 键盘的全部旧入口一个不改。
  function chapterFilterQuery() {
    return chapterFilterLogic.normalizeQuery(state.chapterFilter);
  }

  function chapterFilterActive() {
    return chapterFilterQuery() !== '';
  }

  function chapterIndexMatchesFilter(index) {
    const chapter = state.chapters[index];
    if (!chapter) return false;
    const query = chapterFilterQuery();
    if (!query) return true;
    // 章号按界面显示的编号方式算（按卷编号 = 卷内号），和目录 / 顶栏 / 状态栏同一份口径
    return chapterFilterLogic.matchChapter(
      chapter,
      index,
      chapterTitle(index, chapter.name),
      query,
      chaptersLib.chapterNumber(state.meta, index)
    );
  }

  function matchingChapterIndexes() {
    const out = [];
    state.chapters.forEach((chapter, index) => {
      if (chapterIndexMatchesFilter(index)) out.push(index);
    });
    return out;
  }

  // 目录概览的字数口径：书目缓存里有的章才算（和章节行 / 状态栏同一份 chapter.chars），
  // 一本书都没保存过（全 null）就只显示章数，不假装 0 字。
  function chapterCharsTotal(indexes) {
    let total = 0;
    let known = 0;
    for (const index of indexes) {
      const chars = chapterCharsOf(state.chapters[index]);
      if (chars != null) {
        total += chars;
        known += 1;
      }
    }
    return { total, known };
  }

  function formatCharsLabel(chars) {
    return chars >= 10000 ? `${editorLogic.formatCharsShort(chars)}字` : `${formatCount(chars)} 字`;
  }

  function renderBookMeta() {
    const el = $('book-meta');
    if (!el) return;
    const total = state.chapters.length;
    if (!total) {
      el.textContent = '';
      el.title = '';
      return;
    }
    if (chapterFilterActive()) {
      const matched = matchingChapterIndexes().length;
      const query = chapterFilterQuery();
      // 筛选时这一行就是结果计数：读屏也跟着播报（属性先于文案设置，变化才会被读出来）
      el.setAttribute('aria-live', 'polite');
      el.textContent = `找到 ${matched} 章 · 共 ${total} 章`;
      el.title = `筛选「${query}」：找到 ${matched} 章（全书 ${total} 章）`;
      return;
    }
    el.setAttribute('aria-live', 'off');
    const all = state.chapters.map((chapter, index) => index);
    const { total: chars, known } = chapterCharsTotal(all);
    el.textContent = known ? `${total} 章 · ${formatCharsLabel(chars)}` : `${total} 章`;
    el.title = known
      ? `全书 ${total} 章；${formatCount(chars)} 字（书目缓存，保存后更新）`
      : `全书 ${total} 章`;
  }

  // 筛选词 → 输入框 / 清除键 / 概览行。目录重绘和事件处理共用这一份口径。
  function syncChapterFilterUi() {
    const input = $('chapter-filter');
    const clear = $('btn-clear-filter');
    const value = String(state.chapterFilter == null ? '' : state.chapterFilter);
    if (input && input.value !== value) input.value = value;
    if (clear) clear.classList.toggle('hidden', !chapterFilterActive());
  }

  // 1.5.0 P0-2（审计 P1）：目录筛选原来每敲一个键就整表重建（千章书每键全表 DOM）。
  // 查询词仍立刻写回 state（计数 / 清除键 / 回车 / Esc 都用最新值），「目录重排」走
  // 250ms 防抖 + 下一帧（与书架搜索同一套节奏）。清空 / Esc / 点浮标这类显式动作仍立即重画。
  let chapterFilterTimer = 0;
  let chapterFilterFrame = 0;

  function cancelScheduledChapterFilter() {
    if (chapterFilterTimer) {
      clearTimeout(chapterFilterTimer);
      chapterFilterTimer = 0;
    }
    if (chapterFilterFrame) {
      cancelAnimationFrame(chapterFilterFrame);
      chapterFilterFrame = 0;
    }
  }

  function scheduleChapterFilterRender(value) {
    state.chapterFilter = String(value == null ? '' : value);
    syncChapterFilterUi();
    renderBookMeta(); // 计数即时：列表可以等停手，概览行不能慢半拍
    if (chapterFilterTimer) clearTimeout(chapterFilterTimer);
    chapterFilterTimer = setTimeout(() => {
      chapterFilterTimer = 0;
      if (chapterFilterFrame) return;
      chapterFilterFrame = requestAnimationFrame(() => {
        chapterFilterFrame = 0;
        renderChapterList();
      });
    }, 250);
  }

  function setChapterFilter(value) {
    cancelScheduledChapterFilter();
    state.chapterFilter = String(value == null ? '' : value);
    syncChapterFilterUi();
    renderChapterList();
  }

  // 筛选命中的章名：把命中的那段文字包进 <mark>（只包最先命中的一个词；章号命中时章名不变），
  // 让作者一眼看出「为什么这一条留下来了」。textContent 仍是完整章名（标题统一测试不受影响）。
  function appendChapterName(el, name, query) {
    const terms = String(query || '').split(' ').filter(Boolean);
    const text = String(name == null ? '' : name);
    const lower = text.toLowerCase();
    let best = null;
    for (const term of terms) {
      const at = lower.indexOf(String(term).toLowerCase());
      if (at >= 0 && (!best || at < best.at)) best = { at, length: String(term).length };
    }
    if (!best) {
      el.textContent = text;
      return;
    }
    el.textContent = '';
    el.appendChild(document.createTextNode(text.slice(0, best.at)));
    const mark = document.createElement('mark');
    mark.className = 'chapter-hit';
    mark.textContent = text.slice(best.at, best.at + best.length);
    el.appendChild(mark);
    el.appendChild(document.createTextNode(text.slice(best.at + best.length)));
  }

  // 卷头（吸顶）的「全部折叠 / 全部展开」：只在有卷且没在筛选时出现。
  // 折叠状态只存在内存里（换书重置），和单卷折叠走同一份 state.collapsedVolumes。
  function volumeGroupKeys() {
    const volumes = volumeList();
    // 没分卷的书没有「卷」可折叠：不给「全部折叠」按钮（否则会把整张平铺目录收没）
    if (!volumes.length) return [];
    const ids = new Set(volumes.map((volume) => volume.id));
    const keys = volumes.map((volume) => volume.id);
    const hasOrphans = state.chapters.some((chapter) => {
      const volumeId = chapterVolumeId(chapter);
      return !(volumeId && ids.has(volumeId));
    });
    if (hasOrphans) keys.push('');
    return keys;
  }

  function renderVolumeToggle() {
    const btn = $('btn-toggle-volumes');
    if (!btn) return;
    const keys = volumeGroupKeys();
    if (!keys.length || chapterFilterActive()) {
      btn.classList.add('hidden');
      return;
    }
    btn.classList.remove('hidden');
    const allCollapsed = keys.every((key) => state.collapsedVolumes.has(key));
    btn.textContent = allCollapsed ? '全部展开' : '全部折叠';
    btn.title = allCollapsed ? '展开全部卷（只影响侧栏显示）' : '折叠全部卷（只影响侧栏显示）';
  }

  function toggleAllVolumes() {
    const keys = volumeGroupKeys();
    if (!keys.length) return;
    const allCollapsed = keys.every((key) => state.collapsedVolumes.has(key));
    keys.forEach((key) => {
      if (allCollapsed) state.collapsedVolumes.delete(key);
      else state.collapsedVolumes.add(key);
    });
    renderChapterList();
  }

  // 当前章条目的缓存引用（1.6.0 A5/P-09）：输入热路径每敲一个字都要给它挂 / 摘 dirty，
  // 原来每次都去 #chapter-list 里 querySelector。整表重建（renderChapterList）与切章快路径
  // （syncActiveChapterItem）负责更新缓存；缓存条目掉出文档时（删除 / 换书 / 非预期重建）
  // isConnected 为假，回退重查一次，绝不把 dirty 挂到一个已经不在页面里的旧节点上。
  let cachedActiveChapterItem = null;

  function activeChapterItem() {
    if (cachedActiveChapterItem && cachedActiveChapterItem.isConnected) return cachedActiveChapterItem;
    const list = $('chapter-list');
    cachedActiveChapterItem = list ? list.querySelector('.chapter-item.active') : null;
    return cachedActiveChapterItem;
  }

  // 当前章被折叠时，在它所在的卷头上留 2px 朱红细线：目录收起后也知道自己写的那一卷在哪。
  // 只在「当前卷确实被折叠」时加，展开 / 筛选（强制展开）时都不加，避免多出一个无信息量的标记。
  function syncCurrentVolumeMarker() {
    const list = $('chapter-list');
    if (!list) return;
    const key = currentChapterGroupKey();
    const collapsed = key !== null && state.collapsedVolumes.has(key);
    list.querySelectorAll('.volume-item').forEach((row) => {
      row.classList.toggle('has-current', collapsed && row.dataset.volumeId === key);
    });
  }

  // 当前章所在的卷组 key（'' = 未分卷；null = 这本书没有卷，不存在「被折叠」）
  function currentChapterGroupKey() {
    if (state.index < 0 || !state.chapters[state.index]) return null;
    const volumes = volumeList();
    if (!volumes.length) return null;
    const ids = new Set(volumes.map((volume) => volume.id));
    const volumeId = chapterVolumeId(state.chapters[state.index]);
    return volumeId && ids.has(volumeId) ? volumeId : '';
  }

  // 「回到当前章」浮标：当前章被滚出目录 / 被吸顶卷头盖住 / 当前卷被折叠时，
  // 出现在目录底部给一条回去的路。只读 DOM 位置，不滚也不写任何状态；
  // 筛选时收起（筛选是一次「找别的章」的动作，不抢眼）。
  function updateCurrentChapterPill() {
    const pill = $('btn-return-current');
    const list = $('chapter-list');
    if (!pill || !list) return;
    const chapter = state.chapters[state.index];
    if (!chapter) {
      pill.classList.add('hidden');
      return;
    }
    const filtering = chapterFilterActive();
    const active = list.querySelector('.chapter-item.active');
    if (filtering) {
      // 当前章在筛选结果里 → 位置看得见，浮标收起。
      // 当前章被筛掉 → 浮标变成「清空筛选并回去」的唯一鼠标入口（筛选时不出「全部折叠」）。
      if (active) {
        pill.classList.add('hidden');
        return;
      }
      pill.textContent = `回到第${chaptersLib.chapterNumber(state.meta, state.index)}章（清空筛选）`;
      pill.title = `当前章不在筛选结果里：点一下清空筛选并回到「${chapterTitle(state.index, chapter.name)}」`;
      pill.classList.remove('hidden');
      return;
    }
    if (!active) {
      // 当前章在折叠的卷里：列表里没有这一条，但浮标仍然是回得去的（点一下展开并定位）
      const key = currentChapterGroupKey();
      if (key === null || !state.collapsedVolumes.has(key)) {
        pill.classList.add('hidden');
        return;
      }
      pill.textContent = `回到第${chaptersLib.chapterNumber(state.meta, state.index)}章`;
      pill.title = `当前章在已折叠的「${volumeDisplayName(key)}」里：点一下展开并定位`;
      pill.classList.remove('hidden');
      return;
    }
    const listRect = list.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    // 卷头吸顶高度 34px：条目压在卷头下面同样算看不见
    const coverTop = listRect.top + (list.querySelector('.volume-item') ? 34 : 0);
    const visible = activeRect.top >= coverTop - 0.5 && activeRect.bottom <= listRect.bottom + 0.5;
    if (visible) {
      pill.classList.add('hidden');
      return;
    }
    pill.textContent = `回到第${chaptersLib.chapterNumber(state.meta, state.index)}章`;
    pill.title = `回到当前章：${chapterTitle(state.index, chapter.name)}`;
    pill.classList.remove('hidden');
  }

  function scrollToCurrentChapter() {
    // 筛选把当前章藏起来时，浮标同时承担「清空筛选」：先回到完整目录，再滚到当前章
    if (chapterFilterActive()) setChapterFilter('');
    let active = activeChapterItem();
    if (!active) {
      // 当前卷被折叠：先展开再滚（与点卷头是同一份折叠状态）
      const key = currentChapterGroupKey();
      if (key !== null && state.collapsedVolumes.has(key)) {
        state.collapsedVolumes.delete(key);
        renderChapterList();
        active = activeChapterItem();
      }
    }
    if (!active) return;
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    active.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    updateCurrentChapterPill();
  }

  // 目录工具条：输入即筛（章名 / 第N章 / 纯章号，多词 AND）、Esc 清空、回车跳到第一条、
  // ↓ 把焦点交给目录第一行。全部走现有入口（switchChapter / listKeyboard），没有新写业务。
  function setupChapterDirectory() {
    const input = $('chapter-filter');
    const clear = $('btn-clear-filter');
    const pill = $('btn-return-current');
    const toggleVolumes = $('btn-toggle-volumes');
    if (input) {
      // 1.5.0 P0-2：输入即写回 state（计数 / 回车 / Esc 立刻拿到最新词），目录重排等停手
      input.addEventListener('input', () => scheduleChapterFilterRender(input.value));
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          if (!input.value) return;
          event.preventDefault();
          event.stopPropagation();
          setChapterFilter('');
          return;
        }
        if (event.key === 'Enter') {
          const first = matchingChapterIndexes()[0];
          if (first == null) return;
          event.preventDefault();
          void switchChapter(first);
          return;
        }
        if (event.key === 'ArrowDown') {
          const list = $('chapter-list');
          const items = list ? Array.from(list.querySelectorAll('.chapter-item')) : [];
          if (!items.length) return;
          event.preventDefault();
          listKeyboard.applyTabStops(items, 0);
          if (typeof items[0].focus === 'function') items[0].focus();
        }
      });
    }
    if (clear) {
      clear.addEventListener('click', () => {
        setChapterFilter('');
        if (input) input.focus();
      });
    }
    if (pill) pill.addEventListener('click', scrollToCurrentChapter);
    if (toggleVolumes) toggleVolumes.addEventListener('click', toggleAllVolumes);
    const list = $('chapter-list');
    if (list) {
      // 滚动事件只更新浮标：requestAnimationFrame 合并到一帧，拖滚动条时不做重复测量。
      let pending = 0;
      list.addEventListener('scroll', () => {
        if (pending) return;
        pending = window.requestAnimationFrame(() => {
          pending = 0;
          updateCurrentChapterPill();
        });
      }, { passive: true });
    }
    // 窗口高度变了，当前章可能从「看得见」变成「看不见」：浮标跟着重量一次（不依赖滚动事件）
    window.addEventListener('resize', updateCurrentChapterPill, { passive: true });
  }

  // 1.5.0 P0-2（审计 P1）：1000 章原来每条 6 个监听（点击 / 双击 / 右键 / pointerdown + ⋯ 两个），
  // 一次整表重建就是 6000 个闭包；改成 #chapter-list 容器挂一套，按 dataset.index 分派。
  // 必须保住的旧行为：roving tabindex、aria-label、startChapterDrag、state.suppressChapterClick、
  // list-keyboard 方向键、右键菜单、⋯ 按钮（同一张菜单）。
  function chapterItemAt(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return null;
    const item = target.closest('.chapter-item');
    if (!item) return null;
    const index = Number(item.dataset && item.dataset.index);
    if (!Number.isInteger(index) || index < 0 || index >= state.chapters.length) return null;
    return { item, index };
  }

  function chapterMoreAt(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return null;
    return target.closest('.chapter-more');
  }

  function setupChapterListEvents() {
    const list = $('chapter-list');
    if (!list) return;
    list.addEventListener('pointerdown', (event) => {
      // ⋯ 只服务点击：不要在它上面起拖拽（老实现靠 stopPropagation 挡住）
      if (chapterMoreAt(event)) return;
      // 1.5.0 功能-1：Ctrl / Shift 是「多选」，不是拖拽起手（否则一按就进拖拽、点击被 suppress）
      if (event.ctrlKey || event.metaKey || event.shiftKey) return;
      const hit = chapterItemAt(event);
      if (!hit) return;
      // 委托后 event.currentTarget 是容器，拖拽要的条目元素显式传进去
      startChapterDrag(event, hit.index, hit.item);
    });
    list.addEventListener('click', (event) => {
      const hit = chapterItemAt(event);
      // 点列表空白：清空多选（没有多选时什么都不做，不拦其它行为）
      if (!hit) {
        clearChapterSelection();
        return;
      }
      const more = chapterMoreAt(event);
      if (more) {
        // ⋯ 落在已选章上：菜单动作作用于全部已选；落在未选章上：先切成单选（与右键一致）
        ensureChapterSelected(hit.index);
        const rect = more.getBoundingClientRect();
        showContextMenu({ clientX: rect.right - 4, clientY: rect.bottom - 2 }, hit.index);
        return;
      }
      if (state.suppressChapterClick && Date.now() < state.suppressChapterClick) {
        state.suppressChapterClick = 0;
        return; // 刚拖拽完，别把这次点击当成切章
      }
      // Ctrl+单击：切换选中，不切章；Shift+单击：从 anchor 连到这一章，不切章（1.5.0 功能-1）
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const id = chapterIdAt(hit.index);
        if (id) setChapterSelection(chapterSelectionLib.toggle(chapterSelectionSnapshot(), id));
        return;
      }
      if (event.shiftKey) {
        event.preventDefault();
        const id = chapterIdAt(hit.index);
        if (id) {
          setChapterSelection(
            chapterSelectionLib.extendTo(
              chapterSelectionSnapshot(),
              chapterIdsInBookOrder(),
              id,
              currentChapterId()
            )
          );
        }
        return;
      }
      // 普通单击：清空多选 + 照旧切章
      clearChapterSelection();
      void switchChapter(hit.index);
    });
    list.addEventListener('dblclick', (event) => {
      const hit = chapterItemAt(event);
      if (hit) renameChapterAt(hit.index);
    });
    list.addEventListener('contextmenu', (event) => {
      // 卷头右键有卷头自己的监听（showVolumeMenu），这里只接章节条目
      const hit = chapterItemAt(event);
      if (!hit) return;
      event.preventDefault();
      // 落在已选章上：保留多选，菜单动作作用于全部已选；落在未选章上：先切成单选
      ensureChapterSelected(hit.index);
      showContextMenu(event, hit.index);
    });
    // 键盘：Ctrl+Space 切换焦点章的多选（方向键仍由 list-keyboard.js 负责，互不抢键）。
    // 1.6.0 F1：Shift+↑/↓ 扩选由下面 install() 的 onExtend 接，Ctrl+A 全选在全局 keydown 里。
    list.addEventListener('keydown', (event) => {
      if (event.key !== ' ' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const hit = chapterItemAt(event);
      if (!hit) return;
      event.preventDefault();
      event.stopPropagation();
      const id = chapterIdAt(hit.index);
      if (id) setChapterSelection(chapterSelectionLib.toggle(chapterSelectionSnapshot(), id));
    });
  }

  // 批量条「改状态 / 移卷」复用同一张右键菜单（只留能作用到全部已选章的动作）：
// 这样不用为批量再写一套弹层 / 不用新增颜色和焦点管理，键盘通道（menu-keyboard）也直接继承。
  function openBatchMenu(button, kind) {
    const indexes = selectedChapterIndexes();
    if (!indexes.length) return;
    state.batchMenu = true;
    const rect = button.getBoundingClientRect();
    showContextMenu({ clientX: rect.left, clientY: rect.top - 6 }, indexes[0]);
    if (kind === 'move') openVolumeChooserInMenu(-1);
  }

  function setupChapterBatchBar() {
    const bar = $('chapter-batch-bar');
    if (!bar) return;
    bar.addEventListener('click', (event) => {
      const btn = event.target.closest('button[id^="btn-batch-"]');
      if (!btn) return;
      if (btn.id === 'btn-batch-clear') {
        clearChapterSelection();
        return;
      }
      if (btn.id === 'btn-batch-copy') {
        void copySelectedChapters();
        return;
      }
      if (btn.id === 'btn-batch-export') {
        exportSelectedChapters();
        return;
      }
      if (btn.id === 'btn-batch-status') {
        openBatchMenu(btn, 'status');
        return;
      }
      if (btn.id === 'btn-batch-move') {
        openBatchMenu(btn, 'move');
        return;
      }
      if (btn.id === 'btn-batch-delete') void deleteSelectedChapters();
    });
  }

  function volumeList() {
    return state.meta && Array.isArray(state.meta.volumes) ? state.meta.volumes : [];
  }

  function volumeById(volumeId) {
    return volumeList().find((v) => v.id === volumeId) || null;
  }

  function volumeDisplayName(volumeId) {
    if (!volumeId) return '未分卷';
    const volume = volumeById(volumeId);
    return (volume && String(volume.name || '').trim()) || '未命名卷';
  }

  function chapterVolumeId(chapter) {
    // 1.5.0 P0-1（审计 E1 / A2）：章→卷只认 core/chapters.js 的 chapterVolumeKey 一份实现。
    // 指向已删除卷的章按「未分卷」算，和目录分组 / 卷内章号 / 折叠同一口径；
    // 对外仍保持 null = 未分卷（测试钩子 / 拖拽排序按 null 比对）。
    return chaptersLib.chapterVolumeKey(state.meta, chapter) || null;
  }

  function toggleVolumeCollapse(volumeId) {
    // 筛选时所有卷强制展开（命中结果要一眼看得见）：卷头点击先不接，
    // 免得留下一个看不见的折叠状态，清空筛选后才突然生效。
    if (chapterFilterActive()) return;
    const key = volumeId || '';
    if (state.collapsedVolumes.has(key)) state.collapsedVolumes.delete(key);
    else state.collapsedVolumes.add(key);
    renderChapterList();
  }

  // 卷头（吸顶）：左侧折叠箭头 + 宋体卷名；右侧「6 章 · 1.1万字」。
  // 只加显示节点，折叠 / 右键 / 键盘仍在同一行上；E2E 与对比度脚本读的
  // .volume-item / .volume-name / .volume-count 都还在。
  function makeVolumeHeader(volumeId, name, count, chars, totalCount, totalChars) {
    const key = volumeId || '';
    const collapsed = state.collapsedVolumes.has(key);
    const filtering = chapterFilterActive();
    const allCount = Number.isFinite(totalCount) ? totalCount : count;
    const allChars = Number.isFinite(totalChars) ? totalChars : chars;
    const row = document.createElement('div');
    row.className = 'volume-item' + (collapsed ? ' collapsed' : '') + (volumeId ? '' : ' orphan-volume');
    row.dataset.volumeId = key;
    const arrow = document.createElement('span');
    arrow.className = 'volume-arrow';
    arrow.textContent = collapsed ? '▸' : '▾';
    const label = document.createElement('span');
    label.className = 'volume-name';
    label.textContent = name;
    const meta = document.createElement('span');
    meta.className = 'volume-meta';
    const num = document.createElement('span');
    num.className = 'volume-count';
    if (filtering) {
      // 筛选时不能把「整卷合计」静默换成「命中合计」：写清楚两个数，扫读时不会以为内容丢了
      num.textContent = `命中 ${count} / 共 ${allCount} 章`;
      meta.title =
        `筛选命中 ${count} 章（本卷共 ${allCount} 章）` +
        (chars > 0 ? `；命中 ${formatCount(chars)} 字` : '') +
        (allChars > 0 ? `，整卷 ${formatCount(allChars)} 字` : '');
    } else {
      num.textContent = `${count} 章`;
      meta.title = '卷内章数与字数（按上次保存的字数统计）';
    }
    meta.appendChild(num);
    if (!filtering && chars > 0) {
      const sep = document.createElement('span');
      sep.className = 'volume-meta-sep';
      sep.setAttribute('aria-hidden', 'true');
      sep.textContent = '·';
      const charsEl = document.createElement('span');
      charsEl.className = 'volume-chars';
      charsEl.textContent = formatCharsLabel(chars);
      meta.appendChild(sep);
      meta.appendChild(charsEl);
    }
    row.appendChild(arrow);
    row.appendChild(label);
    row.appendChild(meta);
    row.title = '单击折叠 / 展开；右键更多（重命名卷 / 在此卷新建章节 / 删除卷）';
    row.addEventListener('click', () => toggleVolumeCollapse(volumeId));
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showVolumeMenu(event, volumeId);
    });
    return row;
  }

  // 章节条目的 tooltip / 字数节点（B5 保存后只更新这一条时复用，和整表重建保持同一套口径）
  function chapterItemTip(chapter, index) {
    const status = chapterStatus(chapter);
    const note = chapterNote(chapter);
    const chars = chapterCharsOf(chapter);
    const previousChars = index > 0 ? chapterCharsOf(state.chapters[index - 1]) : null;
    const comparison = chars != null ? editorLogic.compareChapterChars(chars, previousChars) : null;
    return [
      `状态：${CHAPTER_STATUS_LABELS[status]}`,
      note ? `备注：${note}` : '',
      chars != null ? `本章 ${formatCount(chars)} 字` : '',
      comparison && comparison.direction === 'shorter' ? comparison.message : ''
    ]
      .filter(Boolean)
      .join('\n');
  }

  function chapterItemTitleText(chapter, index) {
    // 第一行就是完整章名：250px 下章名会省略号，悬停 / 长按先看到全名，再看能做什么
    return [
      chapterTitle(index, chapter.name),
      '单击切换；双击重命名；右键更多',
      chapterItemTip(chapter, index)
    ]
      .filter(Boolean)
      .join('\n');
  }

  // ---------- 章节多选（1.5.0 功能-1）----------
  // 选择模型（四种点法 / anchor 失效回落 / 按目录顺序取已选）全在 renderer/chapter-selection.js，
  // 这里只做三件事：把 state 里的 Set 交给纯函数算新值、把结果同步到 DOM（高亮 + 批量条）、
  // 以及批量动作（删除 / 移到卷 / 改状态 / 导出 / 复制）。红线：多选只记内存，不写书目 / 配置 / 跨书。
  function chapterSelectionSnapshot() {
    return { ids: state.selectedIds, anchorId: state.selectAnchorId };
  }

  function chapterIdAt(index) {
    const chapter = state.chapters[index];
    return chapter && chapter.id != null ? String(chapter.id) : '';
  }

  function currentChapterId() {
    return chapterIdAt(state.index);
  }

  function chapterIdsInBookOrder() {
    return state.chapters.map((chapter) => (chapter && chapter.id != null ? String(chapter.id) : ''));
  }

  // 当前**渲染出来**的章节 id（按 DOM 顺序）：筛选 / 折叠后只含看得见的行。
  // Ctrl+A 与 Shift+↑/↓ 用它当 order —— 键盘只作用于看得见的章，不偷选隐藏的；
  // 按下标取 dataset.chapterId（筛选后 DOM 位置 ≠ 书内下标）。
  function renderedChapterIds() {
    const list = $('chapter-list');
    if (!list) return [];
    return Array.from(list.querySelectorAll('.chapter-item')).map((row) =>
      row.dataset ? String(row.dataset.chapterId || '') : ''
    );
  }

  // 已选章节的**书内下标**（按目录顺序）：批量删除 / 移动 / 改状态 / 导出 / 复制都从这里取，
  // 作者怎么点的都不影响执行顺序。
  function selectedChapterIndexes() {
    if (!state.selectedIds.size) return [];
    const indexes = [];
    state.chapters.forEach((chapter, index) => {
      if (chapter && chapter.id != null && state.selectedIds.has(String(chapter.id))) indexes.push(index);
    });
    return indexes;
  }

  function syncChapterBatchBar() {
    const count = state.selectedIds.size;
    const bar = $('chapter-batch-bar');
    if (bar) bar.classList.toggle('hidden', count === 0);
    const countEl = $('chapter-batch-count');
    if (countEl) countEl.textContent = `已选 ${count} 章`;
  }

  // 选择变化时只改条目上的两个标记（class + aria-selected），不重建整张列表：
  // 千章书里 Ctrl+点一下不会让滚动位置跳走，也不会把当前章那一条重新滚进视口。
  function syncChapterSelectionUi() {
    const list = $('chapter-list');
    if (list) {
      for (const item of list.querySelectorAll('.chapter-item')) {
        const id = item.dataset ? String(item.dataset.chapterId || '') : '';
        const on = id !== '' && state.selectedIds.has(id);
        item.classList.toggle('selected', on);
        item.setAttribute('aria-selected', on ? 'true' : 'false');
      }
    }
    syncChapterBatchBar();
  }

  function setChapterSelection(next) {
    state.selectedIds = next.ids;
    state.selectAnchorId = next.anchorId;
    syncChapterSelectionUi();
  }

  // 返回是否真的清了（用来避免每次点空白都白跑一遍 DOM）
  function clearChapterSelection() {
    if (!state.selectedIds.size && state.selectAnchorId === null) return false;
    state.selectedIds = new Set();
    state.selectAnchorId = null;
    syncChapterSelectionUi();
    return true;
  }

  // 章节数组换了（删章 / 换书 / 保存后重建）以后收口：已不存在的 id / anchor 丢掉。
  // 在 renderChapterList 建表**之前**跑，保证列表里不会出现一条指向已删章的高亮。
  function pruneChapterSelection() {
    const pruned = chapterSelectionLib.prune(chapterSelectionSnapshot(), chapterIdsInBookOrder());
    if (pruned.ids.size !== state.selectedIds.size || pruned.anchorId !== state.selectAnchorId) {
      state.selectedIds = pruned.ids;
      state.selectAnchorId = pruned.anchorId;
    }
  }

  // 右键 / ⋯ 落在未选中的章上：先把它切成单选（与资源管理器一致），再弹菜单。
  function ensureChapterSelected(index) {
    const id = chapterIdAt(index);
    if (!id) return;
    if (state.selectedIds.has(id)) return;
    setChapterSelection({ ids: new Set([id]), anchorId: id });
  }

  function makeChapterItem(chapter, index) {
    const status = chapterStatus(chapter);
    const note = chapterNote(chapter);
    const chars = chapterCharsOf(chapter);
    const label = chapterListLabel(index, chapter.name);
    const item = document.createElement('div');
    item.className = `chapter-item status-${status}` + (index === state.index ? ' active' : '');
    if (chapterSelectionLib.isSelected(chapterSelectionSnapshot(), chapter.id)) item.classList.add('selected');
    if (index === state.index && state.dirty) item.classList.add('dirty');
    item.dataset.index = String(index);
    item.dataset.status = status;
    // 章节 id（v0.9 A-2）：切章只挪高亮、不重建列表时用它核对「列表还是不是这份章节数组」
    item.dataset.chapterId = String(chapter.id == null ? '' : chapter.id);
    item.dataset.title = chapterTitle(index, chapter.name);
    item.title = chapterItemTitleText(chapter, index);
    // 键盘可达（v0.9 A-5b）：章节条目本身可 Tab 到、Enter / 空格切章；整张列表只有当前章
    // 是 Tab 停留点（roving tabindex），方向键在列表内移焦点——1000 章不会变成 1000 个 Tab 站。
    item.tabIndex = index === state.index ? 0 : -1;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-label', `打开${chapterTitle(index, chapter.name)}`);
    // 多选是另一套标记（不和 .active 当前章互覆盖）：1.5.0 功能-1
    item.setAttribute(
      'aria-selected',
      chapterSelectionLib.isSelected(chapterSelectionSnapshot(), chapter.id) ? 'true' : 'false'
    );

    const dot = document.createElement('span');
    dot.className = 'chapter-status-dot';
    dot.title = `状态：${CHAPTER_STATUS_LABELS[status]}（右键可改）`;

    const num = document.createElement('span');
    num.className = 'chapter-num';
    num.textContent = label.num;
    // 视觉上只露纯章号（9 / 18）；完整「第N章：」文本留在 DOM 里（标题统一测试 / 读屏）。
    // 按卷编号时这里是卷内章号，和标题 / 导出 / 状态栏同一份 chaptersLib.chapterNumber。
    num.dataset.num = label.num ? String(chaptersLib.chapterNumber(state.meta, index)) : '';

    const name = document.createElement('span');
    name.className = 'chapter-name';
    if (chapterFilterActive()) appendChapterName(name, label.name, chapterFilterQuery());
    else name.textContent = label.name;

    item.appendChild(dot);
    item.appendChild(num);
    item.appendChild(name);
    if (note) {
      const noteMark = document.createElement('span');
      noteMark.className = 'chapter-note-mark';
      noteMark.textContent = '✎';
      noteMark.title = `备注：${note}`;
      item.appendChild(noteMark);
    }
    // 章节列表每项显示字数（书目缓存，紧凑显示）；保存后自动更新
    if (chars != null) {
      const charsEl = document.createElement('span');
      charsEl.className = 'chapter-chars';
      charsEl.textContent = editorLogic.formatCharsShort(chars);
      charsEl.title = `本章 ${formatCount(chars)} 字（书目缓存；保存后更新）`;
      item.appendChild(charsEl);
    }
    // 行尾「⋯」更多：只服务鼠标（悬停出现，24×24），打开的是同一张右键菜单；
    // 键盘用户仍走 Shift+F10 / 右键键，所以它不进 Tab 序（tabIndex -1、aria-hidden）。
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'chapter-more';
    more.tabIndex = -1;
    more.setAttribute('aria-hidden', 'true');
    more.title = '更多：双击重命名；右键菜单（标记状态 / 备注 / 移到卷 / 删除）';
    more.textContent = '⋯';
    item.appendChild(more);
    // 1.5.0 P0-2（审计 P1）：条目不再逐条绑 6 个监听 —— 点击 / 双击 / 右键 / pointerdown
    // 全部由 #chapter-list 容器委托（setupChapterListEvents）按 dataset.index 分派。
    // roving tabindex / aria-label / ⋯ 按钮 / 右键菜单 / suppressChapterClick 逐项保持原行为。
    return item;
  }

  function renderChapterList() {
    markCommandsDirty(); // 章节列表是命令面板「章节」条目的源：这里一变就作废缓存（1.5.0 P0-6）
    // 1.5.0 功能-1：建表前先把多选收口 —— 已删的章 / 换了书以后，选中集合里不能留下幽灵 id。
    pruneChapterSelection();
    const list = $('chapter-list');
    // 先离线拼好整条列表，再一次性挂上去：千章书一次重建 1000 条时，逐条 appendChild
    // 会让容器反复失效（实测能省掉几毫秒）；配合 CSS 的 content-visibility，屏幕外的
    // 条目连布局都跳过。
    const frag = document.createDocumentFragment();
    const volumes = volumeList();
    const query = chapterFilterQuery();
    const filtering = query !== '';
    // 筛选只影响「显示哪些章」：折叠状态在筛选时全部展开（要先看见命中结果），
    // 命中为 0 时给一条筛选空态（与书架 / 查找同一套三件套文案口径）。
    const matched = matchingChapterIndexes();
    const matchedSet = new Set(matched);
    // 1.3.0 T4（规范 I-06）：章节栏真空（0 章）。正常新建 / 删到空都会自动补一章，这里兜的是
    // 手改书目 / 从外部导入的书；只有「真空」一种状态（打开书是一次性读盘，没有加载中 / 筛选空）。
    // 文案按三件套写：说明状态 + 学习线索（章节模板）+ 直接路径（现有按钮 / Ctrl+N），不加新按钮。
    if (!state.chapters.length) {
      const empty = document.createElement('div');
      empty.className = 'chapter-list-empty muted small';
      empty.dataset.emptyKind = 'vacuum';
      empty.textContent =
        '这本书还没有章节。点左下「＋ 新建章节」或按 Ctrl+N 开始写第一章；' +
        '新章会自动套用设置里的章节模板（填了才生效）。';
      frag.appendChild(empty);
    } else if (filtering && !matched.length) {
      const empty = document.createElement('div');
      empty.className = 'chapter-list-empty muted small';
      empty.dataset.emptyKind = 'filtered';
      empty.textContent =
        `没有匹配「${query}」的章节。\n换个关键词，或按 Esc 清空筛选。`;
      frag.appendChild(empty);
    } else if (!volumes.length) {
      // 没分卷的书：平铺章节（筛选时只留命中的那几条）
      state.chapters.forEach((chapter, index) => {
        if (filtering && !matchedSet.has(index)) return;
        frag.appendChild(makeChapterItem(chapter, index));
      });
    } else {
      const buckets = new Map(volumes.map((v) => [v.id, []]));
      const totals = new Map(volumes.map((v) => [v.id, []]));
      const orphans = [];
      const totalOrphans = [];
      state.chapters.forEach((chapter, index) => {
        // 先记整卷合计（筛选时卷头要同时显示「命中 N / 共 M 章」，不能只剩命中数）
        const volumeId = chapterVolumeId(chapter);
        if (volumeId && totals.has(volumeId)) totals.get(volumeId).push(index);
        else totalOrphans.push(index);
        if (filtering && !matchedSet.has(index)) return;
        if (volumeId && buckets.has(volumeId)) buckets.get(volumeId).push({ chapter, index });
        else orphans.push({ chapter, index });
      });
      const charsOfItems = (items) =>
        chapterCharsTotal(items.map((item) => item.index)).total;
      if (orphans.length) {
        frag.appendChild(
          makeVolumeHeader(
            null,
            '未分卷',
            orphans.length,
            charsOfItems(orphans),
            totalOrphans.length,
            chapterCharsTotal(totalOrphans).total
          )
        );
        if (filtering || !state.collapsedVolumes.has('')) {
          orphans.forEach(({ chapter, index }) => frag.appendChild(makeChapterItem(chapter, index)));
        }
      }
      for (const volume of volumes) {
        const items = buckets.get(volume.id) || [];
        // 筛选时整卷没有命中的卷头不占位置；不筛选时空卷也要留着（新建的卷要在侧栏里看得见）
        if (filtering && !items.length) continue;
        const all = totals.get(volume.id) || [];
        frag.appendChild(
          makeVolumeHeader(
            volume.id,
            volumeDisplayName(volume.id),
            items.length,
            charsOfItems(items),
            all.length,
            chapterCharsTotal(all).total
          )
        );
        if (filtering || !state.collapsedVolumes.has(volume.id)) {
          items.forEach(({ chapter, index }) => frag.appendChild(makeChapterItem(chapter, index)));
        }
      }
    }
    list.replaceChildren(frag);
    // 1.6.0 A5/P-09：整表重建后重算「当前章条目」缓存（旧条目已掉出文档，不能再给它挂 dirty）
    cachedActiveChapterItem = list.querySelector('.chapter-item.active');
    // 筛选时卷头只作分组标签（折叠箭头收起、不接点击）：见 toggleVolumeCollapse
    list.classList.toggle('filtering', filtering);
    syncCurrentVolumeMarker();
    // 当前章在折叠的卷里时列表里一条 tabIndex 0 都没有：给第一个条目补一个 Tab 停留点
    listKeyboard.ensureTabStop(list, '.chapter-item');
    if (filtering) {
      // 筛选结果从第一条读起：不把当前章滚到底部，免得用户输一个词只看得到最后一条
      list.scrollTop = 0;
    } else {
      const active = cachedActiveChapterItem;
      if (active) active.scrollIntoView({ block: 'nearest' });
    }
    syncChapterFilterUi();
    syncChapterBatchBar();
    renderBookMeta();
    renderVolumeToggle();
    updateCurrentChapterPill();
  }

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
    $, state, editorEl, formatChars, formatCount, chaptersLib, editorLogic, call, api, toast, openModal, loadChapterAt
  });
  const { chapterCharsOf, renderCharCount, renderSelectionStats } = statusbarUi;

  // 保存态（1.3.0 T7）：四态文案 / 圆点 / 成功 2s 淡化 / 失败点重试整段在 save-status-ui.js 里。
  // saveCurrent 是函数声明（会提升），装配时引用没问题；重试仍然走同一条保存路径（非静默）。
  const saveStatusUi = saveStatusUiModule.create({ $, state, formatClock, saveCurrent });

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
    $, state, api, call, toast,
    find: { findLogic, editorEl, syncEditorOverlay, scrollCaretIntoView, onEditorInput },
    nav: { chapterTitle, switchChapter: (index) => switchChapter(index), loadChapterAt, currentChapterLabel: () => currentChapterLabel(), hideHeaderMenus },
    collab: { askUnsaved, saveCurrent, openModal, refreshShelf, renderChapterList, reloadAfterPartialFailure, runReplaceOne,
      registerUndo: (label, run) => undoUi.activate(label, run),
      closeProofreadPanel: () => closeProofreadPanel(), renderFindBookmarks: () => renderFindBookmarks(),
      refreshFindBookmarks: () => refreshFindBookmarks(), refreshReplaceBackups: () => refreshReplaceBackups() }
  });
  const { findOverlayEl, findPanelOpen, findSessionActive, findSessionMatchesOptions, hideFindHighlights, clearFindSession, findNavCountText, updateFindNavUi, renderFindStatusChip, syncFindOverlayScroll, markFindCurrentHit, renderFindHighlights, selectFindMatch, startFindSession, stepFind, openFindPanel, closeFindPanel, readFindOptions, renderFindResults, jumpToFindResult, runFind, replaceEditorText, runReplaceAll, setupFindUi } = findUi;
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
  const { focusActive, updateFocusBar, ensureFocusMirror, measureCaretTop, alignTypewriter, scheduleTypewriterAlign, restoreFocusScroll, setFocusMode, toggleFocusMode, setFocusTypewriter, setupFocusModeUi } = focusModeUi;

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
    $, api, call, state, statsLogic, statsFormat, formatChars, formatCount, formatDuration,
    writeDurationEnabled: () => writeDurationEnabled(), renderDurationSettings: () => renderDurationSettings(), renderWriteTimer: () => renderWriteTimer(), calendarSummaryText,
    calendarCells: (view) => statsLogic.calendarCells(view, statsFormat),
    shiftCalendarCursor: (cursor, delta) => statsLogic.shiftCalendarCursor(cursor, delta),
    calendarStreakLabel: () => statsLogic.calendarStreakLabel(state.streak)
  });
  const { refreshStats, renderStatsUi, renderStatsChart, shiftStatsCalendar, goToCurrentCalendarMonth } = statsUi;
  // 1.6.0 F2：统计筛选 / CSV 是设置页里那一块自己的入口（不进上面那 5 个通用入口）
  const { applyStatsFilter, buildStatsCsv, setupStatsUi } = statsUi;

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
    if (!inserted || editorEl.value !== expected) editorEl.value = expected;
    // 统一走 onEditorInput：标脏 / 字数 / 状态栏 / 标记层全按正常输入刷新（不写盘）。
    onEditorInput();
    // 光标停在插入内容末尾：连着点两次「正文」不会把第二段插到第一段前面。
    editorEl.setSelectionRange(start + value.length, start + value.length);
    // 焦点还给面板（面板保持打开）；blur 不改内容，也不会触发保存。
    editorEl.blur();
    return { ok: true, chars: chaptersLib.countChars(value) };
  }

  // 剪贴板捕获（P0）：createCaptureUi(host) 一次装配，host 正好 9 个成员（契约 v1；T1 的
  // REQUIRED_HOST 同步为这 9 个键）。insertIntoBody 用函数声明，装配时引用已提升。
  // 装配点必须放在 statsUi 之后：renderStatsUi 是上面那一行解构出来的 const。
  // 「打开面板前收起顶栏菜单」不进 host：事件绑定 / 测试钩子走 open(text, { beforeOpen: hideHeaderMenus })。
  const captureUi = captureUiModule.create({
    $, state, api, call, toast, saveCurrent, loadChapterAt, renderStatsUi, insertIntoBody
  });

  // ---------- 写作时长（状态栏秒表） ----------
  // 第 4 步九刀·补刀 11：实现在 renderer/write-timer-ui.js（模块头有契约），这里只装配与接线；
  const writeTimerUi = writeTimerUiModule.create({
    $, state, api, call,
    common: { formatStopwatch, formatDuration, WRITE_TIMER_FLUSH_MS },
    statsUi: { renderStatsUi }
  });
  const { writeDurationEnabled, renderWriteTimer, renderDurationSettings, startWriteTimer, pauseWriteTimer, flushWriteTimer, resetWriteTimer, applyWriteTimerConfig, writeTimerTodaySeconds, writeTimerSessionSeconds, writeTimerUnsentMs, setupWriteTimerUi } = writeTimerUi;

  function updateStatus(options) {
    // 保存态四态（正在保存… / 未保存 · HH:MM 最后编辑 / 已保存 HH:MM:SS / 保存失败：原因）
    // 与圆点、失败态重试按钮、成功 2s 淡化都在 renderer/save-status-ui.js 里；
    // 这里不再自己拼第二套文案（1.3.0 T7 = 规范 C-05 / I-01）。
    saveStatusUi.render();
    // 1.6.0 A5/P-09：输入路径（options.typing）的本章字数走 200ms 防抖；切章 / 保存 / 套用等
    // 非输入路径不传 typing，仍然同步算（切过来就要看见字数）。
    renderCharCount({ defer: Boolean(options && options.typing) });
    $('btn-save').disabled = !state.dirty || state.saving;
    // 把未保存状态同步给主进程，供 Windows 关机拦截使用
    if (state.dirty !== state.reportedDirty) {
      state.reportedDirty = state.dirty;
      try {
        api.reportDirty(state.dirty);
      } catch { /* 忽略 */ }
    }
    updateWindowTitle();
  }

  // C5（审计 E5/S5）：关窗「不保存退出」= 作者主动丢弃未保存内容。主进程现在会用自己掌握的
  // 脏状态 + 最近保存回执交叉判定关窗，所以这里先把脏状态如实清掉（updateStatus 会同步上报
  // app:dirty），再回 closeReady(true)；否则主进程会按「仍脏且没有保存回执」把这次关窗拦下。
  function discardUnsavedForClose() {
    if (!state.dirty) return;
    state.dirty = false;
    updateStatus();
  }

  // ---------- 编辑区事件 ----------
  function onEditorInput() {
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

  async function loadChapterAt(index) {
    if (!state.bookPath || !state.chapters.length) return;
    const safeIndex = Math.max(0, Math.min(index, state.chapters.length - 1));
    const chapter = state.chapters[safeIndex];
    state.loading = true;
    try {
      const data = await call(api.loadChapter, state.bookPath, chapter.file);
      state.index = safeIndex;
      state.loadedMtimeMs = data.mtimeMs;
      state.baseText = data.text;
      state.dirty = false;
      state.saveError = null;
      editorEl.value = data.text;
      editorEl.scrollTop = 0;
      // 换了一章：上一章的查找高亮（位置是旧正文的）直接结束
      if (state.find.total) clearFindSession();
      // 专注模式下切了章：退出的还原点改到新章开头，不要把上一章的光标 / 滚动套过来
      if (state.focus.on) {
        state.focus.savedScrollTop = 0;
        state.focus.savedCaret = 0;
        state.focus.savedCaretOffset = 0;
      }
      // 切章后正在念的已经不是眼前这一章了，立刻停
      stopTtsForChapterChange();
      // 只挪「当前章」高亮（v0.9 A-2）：千章书每切一章都整表重建 1000 条纯属浪费；
      // 章节列表和 state.chapters 对不上时 syncActiveChapterItem 会自己退回整表重建。
      syncActiveChapterItem();
      renderEditorHeader();
      updateStatus();
      renderSelectionStats();
      scheduleMarksRender(0);
      if (state.focus.typewriter) scheduleTypewriterAlign(0);
      // 主进程按书合并 1.5 秒内的连续切章（B3），这里只等它受理；真正落盘前若有读操作
      // （书架 / 打开书 / 继续上次写作）主进程会先 flush，重开书不会回到旧章。
      // 「继续上次写作」的书架级记忆在切章当下就写（配置很小），只把书目.json 的大写入防抖。
      try {
        // B1（审计 E6）：走统一 call() —— preload 在 IPC 异常时回 {ok:false} 而不抛，
        // 以前裸 await 让这个 catch 几乎永不触发，失败被悄悄丢掉；现在失败会真的进 catch。
        await call(api.setLastOpenChapter, state.bookPath, chapter.id, {
          title: state.meta && state.meta.title,
          chapterIndex: state.index,
          chapterName: chapter.name
        });
      } catch { /* 记不住也无所谓 */ }
      // 这一章有查找书签的话，按刚从磁盘读到的正文自动高亮（打开书签所在章就有；
      // 书签只存查询条件，命中位置仍按当前正文现算，正文改过也能重新定位）
      await restoreFindBookmarkForCurrentChapter();
    } catch (err) {
      toast(`读取章节失败：${err.message}`, 'error');
    } finally {
      state.loading = false;
    }
  }

  // 保存后的全书校验（审计 F2）：挪到后台跑，不 await、不阻塞保存热路径。
  // - 发现缺章才 warn，文案与以前完全一致（save-logic.js 里单测锁住）；
  // - 校验失败（书被挪走 / 权限 / 临时读失败）只记日志：保存本身已经成功，
  //   以前那句「已保存当前章（全书校验失败）」会误报，现在不再打扰作者。
  // 测试模式（?test=1）可以用 __cwTest.setTestVerifyBook 替换这一趟，E2E 靠它验证
  // 「保存不等校验」「后台失败不提示」两个时序。
  let testVerifyBook = null;

  function verifyBookInBackground(bookPath) {
    void (async () => {
      try {
        const verify = testVerifyBook || ((target) => call(api.verifyBook, target));
        const report = await verify(bookPath);
        const warn = saveLogic.verifyWarnText(report);
        if (warn) toast(warn, 'warn');
      } catch (err) {
        console.warn('保存后的全书校验失败（已忽略，不影响保存结果）', err);
      }
    })();
  }

  async function saveCurrent({ silent = false } = {}) {
    if (!state.bookPath || state.index < 0) {
      return { ok: false, code: 'NO_CHAPTER', message: '当前没有可保存的章节' };
    }
    if (state.saving) {
      return { ok: false, code: 'BUSY', message: '正在保存中，请稍候再试' };
    }
    if (!state.dirty) {
      if (!silent) toast('当前章节没有改动');
      updateStatus();
      return { ok: true, skipped: true };
    }
    const chapter = state.chapters[state.index];
    if (!chapter) return { ok: false, message: '章节不存在' };
    state.saving = true;
    updateStatus();
    try {
      const data = await call(api.saveChapter, state.bookPath, chapter.id, editorEl.value);
      state.baseText = editorEl.value;
      state.loadedMtimeMs = data.mtimeMs;
      state.savedAt = new Date();
      state.saveError = null;
      state.dirty = false;
      // 主进程已经把「这次保存带来的新增字数」记进 stats.json，返回的摘要直接显示，
      // 不再多跑一次 IPC（统计失败时 data.stats 为 null，界面保留旧数字）。
      if (data.stats) {
        state.stats = data.stats;
        if (data.stats.streak) state.streak = data.stats.streak;
        renderStatsUi();
      }
      // 写作时长：保存时顺手把还没上报的整秒记下（只影响统计，失败不影响保存结果）
      if (state.writeTimer.running || state.writeTimer.unsentMs > 0) void flushWriteTimer();
      // 保存后同步本章字数缓存：章节列表的字数 / 「比上章短」提示跟着更新
      // B5（审计 P5）：千章书不再整表重建，只改这一条（+ 下一章的对比提示）；失配才退回整表。
      if (Number.isFinite(Number(data.chars))) {
        chapter.chars = Number(data.chars);
        if (!syncChapterCharsAfterSave(state.index)) renderChapterList();
      }
      updateStatus();
      // 保存后：这一章有查找书签的话，按刚写盘的新正文重新扫描定位。
      // 只在没有手动查找会话、或高亮本来就来自书签时做，免得覆盖作者正在看的其它查找结果。
      if (state.find.total === 0 || state.find.fromBookmark) {
        await restoreFindBookmarkForCurrentChapter();
      }
      // 保存热路径（代码审计 F2）：保存一成功就先刷新状态栏——章数直接用书目里的章节数
      // （保存不会增减章节，和以前 report.chapterCount 是同一个值），不再为了拿这个数字去等
      // 一趟全书校验（千章书每次 Ctrl+S 都在付这份成本）。
      // 1.3.0 T7（规范 C-05 / I-01）：保存成功**不再弹 toast**，反馈收敛到状态栏；
      // 原来 toast 里的完整摘要（章数 / 本章字数 / 快照 / 字数未计入）逐字保留，
      // 改挂到状态栏的 title 上（鼠标悬停可查），不再打断纸面。
      // 不采纳审计里「chars 没变就跳过 writeBookMeta」那条：那会冻结书目 updatedAt。
      if (!silent) {
        saveStatusUi.setSavedDetail(
          saveLogic.savedToastText({
            chapterCount: state.chapters.length,
            charsText: formatChars(data.chars),
            snapshotTaken: Boolean(data.snapshot && data.snapshot.taken),
            // C0（审计 #3 / E1）：字数基线读不到时主进程会带这个标记，提示「本次字数未计入」
            charsBaselineMissing: Boolean(data.charsBaselineMissing)
          })
        );
      }
      // 全书校验挪到后台：发现缺章才 warn（文案不变），校验本身失败只记日志，
      // 不阻塞保存热路径、也不再误报「已保存当前章（全书校验失败）」。
      verifyBookInBackground(state.bookPath);
      return { ok: true, data };
    } catch (err) {
      // A7（审计 E4）：部分成功——正文已落盘、只有书目更新失败。不能按「保存失败」提示：
      // 正文不会丢，dirty 保持（再按一次保存会重写正文并重试书目），字数缓存先用主进程回的值更新。
      if (err.code === 'META_SAVE_FAILED' && err.bodySaved === true) {
        if (Number.isFinite(Number(err.chars))) {
          chapter.chars = Number(err.chars);
          if (!syncChapterCharsAfterSave(state.index)) renderChapterList();
        }
        state.saveError = err.message;
        updateStatus();
        if (!silent) toast(err.message, 'warn');
        return { ok: false, code: err.code, message: err.message, bodySaved: true };
      }
      state.saveError = err.message;
      updateStatus();
      if (!silent) toast(`保存失败：${err.message}`, 'error');
      return { ok: false, code: err.code, message: err.message };
    } finally {
      state.saving = false;
      updateStatus();
    }
  }

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

  // ---------- 章节模板（v0.8 P0 N5） ----------
  // 模板只存在全局配置 chapterTemplate（旧配置没有 = 不套用）；这里只负责把展开后的
  // 文字填进编辑区——不写盘、不改书目、不动章节文件，Ctrl+S 才保存，可 Ctrl+Z 撤销。
  function chapterTemplateText() {
    const cfg = state.globalConfig || state.config || {};
    return templateLib.sanitizeTemplate(cfg.chapterTemplate);
  }

  function applyChapterTemplate(chapterIndex, chapterName) {
    const template = chapterTemplateText();
    if (!templateLib.hasTemplate(template)) return { applied: false, reason: 'NO_TEMPLATE' };
    if (!templateLib.isBlankText(editorEl.value)) return { applied: false, reason: 'NOT_EMPTY' };
    const text = templateLib.applyTemplate(template, {
      chapterNumber: chaptersLib.chapterNumber(state.meta, chapterIndex),
      chapterName: chapterName || '',
      now: new Date()
    });
    if (!text.trim()) return { applied: false, reason: 'EMPTY_RESULT' };
    // 空章（可能只剩空白）整段替换成模板；用原生输入保住 Ctrl+Z 撤销链
    const before = editorEl.value;
    editorEl.focus();
    editorEl.setSelectionRange(0, before.length);
    const inserted = replaceEditorTextNative(text);
    if (!inserted || editorEl.value !== text) {
      // 极端兜底：execCommand 不可用时手动替换（会丢原生撤销链，但不会丢内容）
      editorEl.value = text;
    }
    // 统一走 onEditorInput：标记未保存、刷新字数 / 状态栏 / 标记层
    onEditorInput();
    const caret = editorEl.value.length;
    editorEl.setSelectionRange(caret, caret);
    scrollCaretIntoView(caret);
    return { applied: true, text, chars: text.length };
  }

  // 章节 / 分卷类写盘成功后统一收口：把主进程返回的 data.meta 换进 state（书目 + 章节数组），
  // 并按「操作前的当前章 id」把它找回来 —— 移动 / 插入 / 删除之后旧下标已经不可靠。
  // currentId 省略 = 只换书目（章节顺序和 id 都没变的场景：重命名章节 / 改章节信息 / 新建章节等）。
  // 返回当前章在新数组里的下标（-1 = 找不到；调用方自己决定保留原下标还是回第 0 章 / 交给 loadChapterAt）。
  // 只动 state，不重画 DOM：各入口要重画的范围本来就不同（有的还要重画顶栏 / 状态栏）。
  function applyMetaAndRelocate(data, currentId) {
    state.meta = data.meta;
    state.chapters = data.meta.chapters;
    // 书目 / 章节数组换了：命令面板的章节标题与章号要按新书目重建（1.5.0 P0-6）。
    markCommandsDirty();
    if (!currentId) return -1;
    const at = state.chapters.findIndex((c) => c && c.id === currentId);
    if (at >= 0) state.index = at;
    return at;
  }

  async function createChapterAt(insertIndex, nameOverride, volumeIdOverride) {
    if (!state.bookPath) return { ok: false };
    // 作者要求（2026-10-31）：新建 / 插入章节前，当前章有未保存修改就自动保存，不再弹窗
    if (state.dirty) {
      const saved = await saveCurrent();
      if (!saved.ok) return saved; // 保存失败会弹错误提示并停在这里，不建新章
    }
    const appending = insertIndex >= state.chapters.length;
    // 新章默认落在「当前章所在的卷」；从卷菜单进来时用指定的卷
    const currentChapter = state.chapters[state.index];
    const volumeId =
      volumeIdOverride !== undefined ? volumeIdOverride : chapterVolumeId(currentChapter);
    let name = nameOverride;
    if (name === undefined) {
      name = await promptText({
        title: appending ? '新建章节' : '插入章节',
        message:
          '输入章节名，可留空（只显示章号）。章号由顺序自动生成，不用自己写。' +
          (volumeId ? `\n新章会放进「${volumeDisplayName(volumeId)}」。` : ''),
        placeholder: '例如：夜雨'
      });
      if (name === null) return { ok: false, canceled: true };
    }
    try {
      const data = await call(api.createChapter, state.bookPath, insertIndex, name, volumeId || null);
      applyMetaAndRelocate(data);
      // 新章名不一定命中当前筛选：清掉筛选，保证刚建好的章在目录里看得见（输入框同步清空）
      if (state.chapterFilter) {
        state.chapterFilter = '';
        syncChapterFilterUi();
      }
      await loadChapterAt(data.index);
      // 章节模板：只填进编辑区（未保存、可 Ctrl+Z），绝不自动写盘
      const templateResult = applyChapterTemplate(data.index, data.chapter.name);
      const where = volumeId ? `（${volumeDisplayName(volumeId)}）` : '';
      const templateNote = templateResult.applied ? ' · 已套用章节模板（未保存，Ctrl+S 写盘）' : '';
      toast(`${appending ? '已新建' : '已插入'}：${chapterTitle(data.index, data.chapter.name)}${where}${templateNote}`);
      return { ok: true, index: data.index, template: templateResult };
    } catch (err) {
      toast(`新建章节失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  // ---------- 分卷操作 ----------
  async function createVolumeFlow(nameOverride) {
    if (!state.bookPath) return { ok: false };
    let name = nameOverride;
    if (name === undefined) {
      name = await promptText({
        title: '新建卷',
        message: '输入卷名（原文自带「第N卷」的书照抄原文即可）。卷只影响侧栏分组和导出，不改章号。',
        placeholder: '例如：第1卷：单篇'
      });
      if (name === null) return { ok: false, canceled: true };
    }
    try {
      const data = await call(api.createVolume, state.bookPath, name);
      // 分卷操作不改变章节顺序，当前章还是同一张卡片；按 id 找回来即可（找不到就不动下标）
      const currentId = (state.chapters[state.index] || {}).id;
      applyMetaAndRelocate(data, currentId);
      renderChapterList();
      updateStatus();
      toast(`已新建卷：${volumeDisplayName(data.volume.id)}`);
      return { ok: true, volume: data.volume };
    } catch (err) {
      toast(`新建卷失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  async function renameVolumeFlow(volumeId, nameOverride) {
    if (!state.bookPath || !volumeId) return { ok: false };
    let name = nameOverride;
    if (name === undefined) {
      name = await promptText({
        title: '重命名卷',
        message: '只改卷名，不影响里面的章节。',
        value: volumeDisplayName(volumeId),
        placeholder: '卷名'
      });
      if (name === null) return { ok: false, canceled: true };
    }
    try {
      const data = await call(api.renameVolume, state.bookPath, volumeId, name);
      applyMetaAndRelocate(data);
      renderChapterList();
      toast('已重命名卷');
      return { ok: true };
    } catch (err) {
      toast(`重命名卷失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  // 卷上下移动（只改卷序，章节跟着卷走）
  async function moveVolumeFlow(volumeId, delta) {
    if (!state.bookPath || !volumeId) return { ok: false };
    const volumes = volumeList();
    const from = volumes.findIndex((v) => v.id === volumeId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= volumes.length) return { ok: false };
    try {
      const data = await call(api.moveVolume, state.bookPath, volumeId, to);
      // 卷序变了但章节数组顺序没变：当前章按 id 找回原卡片
      const currentId = (state.chapters[state.index] || {}).id;
      applyMetaAndRelocate(data, currentId);
      renderChapterList();
      renderEditorHeader();
      updateStatus();
      toast(`已${delta < 0 ? '上移' : '下移'}卷：${volumeDisplayName(volumeId)}`);
      return { ok: true };
    } catch (err) {
      toast(`移动卷失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  async function deleteVolumeFlow(volumeId, skipConfirm = false) {
    if (!state.bookPath || !volumeId) return { ok: false };
    const bookPath = state.bookPath;
    const volume = volumeById(volumeId);
    // 撤销用：卷名 + 卷序 + 卷里章节的 id（按全书顺序），删完直接执行、10 秒内可撤销。
    const volumeName = (volume && String(volume.name || '').trim()) || '未命名卷';
    const volumeIndex = Math.max(0, volumeList().findIndex((v) => v.id === volumeId));
    const chapterIds = state.chapters.filter((c) => chapterVolumeId(c) === volumeId).map((c) => c.id);
    const count = chapterIds.length;
    // skipConfirm 只给自动化钩子用（1.4.0 P0-2 起不再有确认框，保留参数是为了钩子签名不变）
    void skipConfirm;
    try {
      const data = await call(api.deleteVolume, state.bookPath, volumeId);
      // 卷里的章回到「未分卷」，顺序不变：当前章按 id 找回；万一找不到（书目被外部改坏）回第 1 章
      const currentId = (state.chapters[state.index] || {}).id;
      const at = applyMetaAndRelocate(data, currentId);
      if (at < 0) state.index = 0;
      renderChapterList();
      renderEditorHeader();
      updateStatus();
      undoUi.activate(
        `已删除卷「${volumeName}」${count ? `，${count} 章回到未分卷` : ''}`,
        async () => {
          if (state.bookPath !== bookPath) throw new Error('已经换了书，不能撤销');
          // 先按原名建卷，再把章按原顺序逐条放回去（moveChapterToVolume 追加到卷尾，顺序自然对）
          const created = await call(api.createVolume, bookPath, volumeName);
          const newId = created && created.volume ? created.volume.id : null;
          if (!newId) throw new Error('没能重建这一卷');
          for (const chapterId of chapterIds) {
            await call(api.moveChapterToVolume, bookPath, chapterId, newId);
          }
          // 卷序也放回原位置（建卷会追加到末尾）
          try {
            await call(api.moveVolume, bookPath, newId, volumeIndex);
          } catch { /* 卷序放不回去也不影响章节归属，别让整次撤销失败 */ }
          const reopened = await call(api.openBook, bookPath);
          state.meta = reopened.meta;
          state.chapters = reopened.meta.chapters;
          const keep = (state.chapters[state.index] || {}).id;
          const back = keep ? state.chapters.findIndex((c) => c.id === keep) : -1;
          if (back >= 0) state.index = back;
          renderChapterList();
          renderEditorHeader();
          await refreshShelf();
        }
      );
      toast(`已删除卷，${count} 章回到「未分卷」（章节文件未动）`);
      return { ok: true };
    } catch (err) {
      toast(`删除卷失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  // 移到卷（1.4.0 P0-2：不再弹模态选择框）——点右键菜单里的「移到卷…」，就在同一个菜单下面
  // 展开这个卷列表，选一个即执行。模态只留两处（未保存拦截 / 删除整本书），这里属于「选择」不是
  // 「确认」，所以改成菜单内联展开：菜单本来就有键盘通道（menu-keyboard 会把焦点带进第一条）。
  function openVolumeChooserInMenu(index) {
    const holder = $('context-menu-volumes');
    // 1.5.0 功能-1：index < 0 = 批量条打开的菜单（作用于全部已选章）；否则按「这一章是否在多选里」判断
    const batch = index < 0 || chapterMenuIsBatch(index);
    const indexes = batch ? selectedChapterIndexes() : [index];
    const chapter = state.chapters[indexes[0]];
    if (!holder || !chapter) return false;
    const currentVolume = chapterVolumeId(chapter);
    const volumes = volumeList();
    holder.textContent = '';
    const title = document.createElement('div');
    title.className = 'context-menu-label';
    title.textContent =
      batch && indexes.length > 1
        ? `把选中的 ${indexes.length} 章移到`
        : `把「${chapterTitle(indexes[0], chapter.name)}」移到`;
    holder.appendChild(title);
    let count = 0;
    for (const volume of volumes) {
      if (!volume) continue;
      // 单章：当前卷不用再列；批量：全部卷都列（已在该卷里的章移动时自动跳过，只移动真正换卷的）
      if (!batch && volume.id === currentVolume) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.action = `move-volume:${volume.id}`;
      btn.textContent = volumeDisplayName(volume.id);
      holder.appendChild(btn);
      count += 1;
    }
    const anyInVolume = batch
      ? indexes.some((at) => chapterVolumeId(state.chapters[at]))
      : Boolean(currentVolume);
    if (anyInVolume) {
      const back = document.createElement('button');
      back.type = 'button';
      back.dataset.action = 'move-volume:';
      back.textContent = '移回「未分卷」';
      holder.appendChild(back);
      count += 1;
    }
    if (!count) {
      const empty = document.createElement('div');
      empty.className = 'context-menu-label';
      empty.textContent = volumes.length ? '这一章已经在唯一的卷里了' : '这本书还没有卷，先「＋ 新建卷」';
      holder.textContent = '';
      holder.appendChild(empty);
    }
    holder.classList.remove('hidden');
    // 菜单可能贴着窗口下沿：展开后往窗口里收一下（placeMenuAt 同一套夹紧逻辑）
    placeMenuAt($('context-menu'), parseFloat($('context-menu').style.left) || 0, parseFloat($('context-menu').style.top) || 0);
    return true;
  }

  async function moveChapterToVolume(index, volumeId) {
    const chapter = state.chapters[index];
    if (!chapter || !state.bookPath) return { ok: false };
    const bookPath = state.bookPath;
    // 撤销用：原卷 + 原来的下一章（和跨卷移动同一口径：撤销 = 插回原来那一章前面）
    const fromVolumeId = chapterVolumeId(chapter);
    const beforeId = state.chapters[index + 1] ? state.chapters[index + 1].id : null;
    const currentId = (state.chapters[state.index] || {}).id;
    try {
      const data = await call(api.moveChapterToVolume, state.bookPath, chapter.id, volumeId || null);
      applyMetaAndRelocate(data, currentId);
      renderChapterList();
      renderEditorHeader();
      updateStatus();
      const target = volumeDisplayName(volumeId);
      undoUi.activate(`已把「${chapterTitle(index, chapter.name)}」移到「${target}」`, async () => {
        if (state.bookPath !== bookPath) throw new Error('已经换了书，不能撤销');
        const at = state.chapters.findIndex((c) => c.id === chapter.id);
        if (at < 0) throw new Error('这一章已经不在书里了');
        const back = await moveChapterByDrop(state.chapters[at], {
          volumeId: fromVolumeId,
          beforeChapterId: beforeId
        });
        if (!back || back.ok !== true) throw new Error((back && back.message) || '移动没有生效');
      });
      toast(`已移到「${target}」`);
      return { ok: true, index: data.index };
    } catch (err) {
      toast(`移动失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  async function renameChapterAt(index, nameOverride) {
    const chapter = state.chapters[index];
    if (!chapter) return;
    if (state.dirty && index === state.index) {
      toast('当前章节还有未保存的修改，先保存再改名（或切换前选择保存）', 'warn');
      return;
    }
    let name = nameOverride;
    if (name === undefined) {
      name = await promptText({
        title: '重命名章节',
        message: '只改显示名，文件名不变（这样插入/删除永远不会因为改名失败而丢稿）。',
        value: chapter.name || '',
        placeholder: '章节名'
      });
      if (name === null) return;
    }
    try {
      const data = await call(api.renameChapter, state.bookPath, chapter.id, name);
      applyMetaAndRelocate(data);
      renderChapterList();
      if (index === state.index) renderEditorHeader();
      updateStatus();
      toast('已重命名（文件名未改）');
    } catch (err) {
      toast(`重命名失败：${err.message}`, 'error');
    }
  }

  // 返回 true = 真的删了（写盘成功）；false = 没删（取消未保存拦截 / 保存失败 / 出错）。
  // 1.4.0 P0-2（撤销优先）：删除改为「直接执行 + 10 秒撤销」——不再弹「确定删除？」确认框。
  // 只有「删的是当前章且还有没保存的字」仍走未保存拦截（两处保留确认之一）：撤销找得回磁盘上
  // 那一版，但找不回编辑区里还没写盘的字，所以这一步不能省。skipConfirm 只给自动化钩子用。
  async function deleteChapterAt(index, skipConfirm = false) {
    const chapter = state.chapters[index];
    if (!chapter) return false;
    const bookPath = state.bookPath;
    if (!bookPath) return false;
    const wasCurrent = index === state.index;
    const currentId = wasCurrent ? null : (state.chapters[state.index] || {}).id;
    // 1.5.0 P0-4（审计 H-2）：记下删除那一刻的左右邻居 id。撤销时若这一章的下标已经不对
    // （10 秒里又删了别的章 / 调过序），就按「找回那个邻居、插回它旁边」重算落点。
    const neighborBeforeId = index > 0 && state.chapters[index - 1] ? state.chapters[index - 1].id : '';
    const neighborAfterId = state.chapters[index + 1] ? state.chapters[index + 1].id : '';
    if (!skipConfirm && wasCurrent && state.dirty) {
      const action = await askUnsaved({
        title: '删除前先处理未保存的修改',
        message:
          `「${currentChapterLabel()}」还有未保存的修改。\n` +
          '删除会把磁盘上的这一章移到本书的 _trash，编辑区里还没保存的字不会跟着进去。',
        saveLabel: '保存后删除',
        discardLabel: '不保存，直接删除'
      });
      if (action === 'cancel') return false;
      if (action === 'save') {
        const saved = await saveCurrent();
        if (!saved.ok) return false;
      }
    }
    try {
      const data = await call(api.deleteChapter, bookPath, chapter.id);
      const at = applyMetaAndRelocate(data, currentId);
      // 主进程回传的是绝对路径：只取文件名（撤销只传 basename，绝不把本机路径再递回去）。
      const trashName = String(data.trashPath || '').split(/[\\/]/).pop();
      // 1.5.0 P0-5（审计 V-1）：主进程给这次删除发了一张一次性凭证，撤销时必须原样交回。
      const undoToken = typeof data.undoToken === 'string' ? data.undoToken : '';
      if (data.newChapter) toast('最后一章被删除，已自动补一个空章');
      if (wasCurrent) {
        state.dirty = false;
        await loadChapterAt(data.index);
      } else {
        if (at < 0) state.index = Math.min(index, state.chapters.length - 1);
        renderChapterList();
        renderEditorHeader();
        updateStatus();
      }
      if (trashName) {
        activateDeleteUndo({
          bookPath,
          chapter,
          index,
          trashName,
          undoToken,
          wasCurrent,
          newChapter: data.newChapter,
          neighborBeforeId,
          neighborAfterId
        });
      }
      return true;
    } catch (err) {
      toast(`删除失败：${err.message}`, 'error');
      return false;
    }
  }

  // 删除章节后的撤销登记（1.4.0 P0-2）：10 秒内点撤销条 / 按 Ctrl+Z 把章节文件与书目位置一起找回。
  // 撤销执行前 flushWriteTimer()、再核对还是同一本书；失败由 renderer/undo-ui.js 报「撤销失败：…」，绝不静默。
  function activateDeleteUndo(info) {
    const title = chapterTitle(info.index, info.chapter.name);
    undoUi.activate(`已删除「${title}」`, async () => {
      if (state.bookPath !== info.bookPath) throw new Error('已经换了书，不能撤销');
      await flushWriteTimer();
      const dirtyNow = Boolean(state.dirty);
      const current = state.chapters[state.index];
      const autoFile = info.newChapter && info.newChapter.file ? info.newChapter.file : '';
      // 删空自动补的空章：只在「它仍空着、编辑区也没动过它」时一并撤掉。
      // 作者在这 10 秒里已经往补章里写了字，就保留它（宁可多一章，也不静默丢字）。
      const canRemoveAuto = Boolean(autoFile) && !(dirtyNow && current && current.file === autoFile);
      // 1.5.0 P0-4（审计 H-2）：撤销时按 id 重查书目，优先用「现在」的字段与落点；
      // 这一章已经不在列表里（正常情况）就用删除时的左右邻居重算落点，最后才退回删除那一刻的下标。
      // 目标：10 秒内改名 / 调序 / 又删了别的章，撤销仍落回原来的上下文，而不是把旧下标硬塞进去。
      const foundAt = state.chapters.findIndex((item) => item && item.id === info.chapter.id);
      const liveChapter = foundAt >= 0 ? state.chapters[foundAt] : null;
      const source = liveChapter || info.chapter;
      const afterAt = info.neighborAfterId
        ? state.chapters.findIndex((item) => item && item.id === info.neighborAfterId)
        : -1;
      const beforeAt = info.neighborBeforeId
        ? state.chapters.findIndex((item) => item && item.id === info.neighborBeforeId)
        : -1;
      const restoreIndex =
        foundAt >= 0
          ? foundAt
          : afterAt >= 0
            ? afterAt
            : beforeAt >= 0
              ? beforeAt + 1
              : Math.min(info.index, state.chapters.length);
      const data = await call(api.restoreDeletedChapter, info.bookPath, {
        trashName: info.trashName,
        // 1.5.0 P0-5（审计 V-1）：主进程只认「删除时发的那张一次性凭证」；伪造 / 过期 / 跨书 / 重复用都被拒。
        undoToken: info.undoToken || '',
        index: restoreIndex,
        chapter: {
          id: source.id,
          file: source.file,
          name: source.name,
          createdAt: source.createdAt,
          volumeId: source.volumeId,
          status: source.status,
          note: source.note
        },
        autoChapterFile: canRemoveAuto ? autoFile : null
      });
      // 有未保存的字就不切章（切章会把它丢掉），只把书目换回来；
      // 其它情况按「当前章 id」重定位，免得撤销把一章插到当前章前面后下标错位。
      const willLoad = info.wasCurrent && !dirtyNow;
      const keepId = current && !willLoad ? current.id : null;
      const at = applyMetaAndRelocate(data, keepId);
      if (at >= 0) state.index = at;
      renderChapterList();
      renderEditorHeader();
      if (willLoad) await loadChapterAt(data.index);
      else updateStatus();
      const note = autoFile && !data.autoChapterRemoved ? '（自动补的空章里已经有内容，保留）' : '';
      toast(`已撤销删除：${chapterTitle(data.index, data.chapter.name)}${note}`);
    });
  }

  // 章节状态 / 备注：只写 书目.json 的可选字段，正文一个字都不动。
  async function updateChapterInfo(index, patch) {
    const chapter = state.chapters[index];
    if (!chapter || !state.bookPath) return { ok: false, message: '没有打开的章节' };
    try {
      const data = await call(api.updateChapterMeta, state.bookPath, chapter.id, patch);
      applyMetaAndRelocate(data);
      renderChapterList();
      renderEditorHeader();
      return { ok: true, changed: Boolean(data.changed), chapter: data.chapter };
    } catch (err) {
      toast(`保存章节信息失败：${err.message}`, 'error');
      return { ok: false, message: err.message, code: err.code };
    }
  }

  async function setChapterStatusAt(index, status) {
    const label = CHAPTER_STATUS_LABELS[status];
    if (!label || !state.chapters[index]) return { ok: false };
    const res = await updateChapterInfo(index, { status });
    if (!res.ok) return res;
    if (res.changed) toast(`已标记为${label}（只改书目，正文没动）`);
    return { ok: true, status: chapterStatus(state.chapters[index]), changed: res.changed };
  }

  // ---------- 章节多选：批量动作（1.5.0 功能-1）----------
  // 全部复用现有 IPC，不新增频道 / 字段：删除逐章 api.deleteChapter（收集 _trash 文件名 + 撤销凭证），
  // 移到卷逐章 api.moveChapterToVolume，改状态逐章 api.updateChapterMeta，导出走现有范围对话框，
  // 复制走 api.copyBook 的「选中章下标」可选参数（主进程按书名 / 章名 / 正文同一套格式拼接）。
  // 破坏性动作只有一条撤销：一次恢复全部章 / 一次移回全部章（顺序见各函数里的注释）。
  async function deleteSelectedChapters() {
    if (!state.bookPath) return false;
    const indexes = selectedChapterIndexes();
    if (!indexes.length) return false;
    // 只选了一章：复用单章删除（未保存拦截 / _trash / 撤销文案 / 焦点恢复全都不变）
    if (indexes.length === 1) {
      const deleted = await deleteChapterAt(indexes[0]);
      if (deleted) clearChapterSelection();
      return deleted;
    }
    const bookPath = state.bookPath;
    const firstIndex = indexes[0];
    const currentSelected = indexes.includes(state.index);
    const keepCurrentId = currentSelected ? '' : currentChapterId();
    // 「当前章有未保存修改」只问一次（和单章删除同一条拦截；批量里只问当前章，别的章没有编辑区内容）
    if (currentSelected && state.dirty) {
      const action = await askUnsaved({
        title: '删除前先处理未保存的修改',
        message:
          `选中的章里有正在写的「${currentChapterLabel()}」，它还有未保存的修改。\n` +
          '删除会把磁盘上的章节文件移到本书的 _trash，编辑区里还没保存的字不会跟着进去。',
        saveLabel: '保存后删除',
        discardLabel: '不保存，直接删除'
      });
      if (action === 'cancel') return false;
      if (action === 'save') {
        const saved = await saveCurrent();
        if (!saved.ok) return false;
      }
    }
    // 从后往前删：前面还没删的章下标不会被后来的删除挤动，收集到的 index 就是**原始位置**；
    // 撤销时反过来从前往后按原下标插回，章序才和删除前一致。
    const deleted = [];
    let failed = null;
    for (let n = indexes.length - 1; n >= 0; n -= 1) {
      const index = indexes[n];
      const chapter = state.chapters[index];
      if (!chapter) continue;
      const neighborBeforeId = index > 0 && state.chapters[index - 1] ? state.chapters[index - 1].id : '';
      const neighborAfterId = state.chapters[index + 1] ? state.chapters[index + 1].id : '';
      try {
        // eslint-disable-next-line no-await-in-loop
        const data = await call(api.deleteChapter, bookPath, chapter.id);
        deleted.push({
          chapter,
          index,
          trashName: String(data.trashPath || '').split(/[\\/]/).pop(),
          undoToken: typeof data.undoToken === 'string' ? data.undoToken : '',
          neighborBeforeId,
          neighborAfterId,
          newChapter: data.newChapter || null
        });
        applyMetaAndRelocate(data, currentSelected ? null : keepCurrentId);
      } catch (err) {
        failed = err;
        break;
      }
    }
    // 选中集合是一次性动作的上下文：执行完就收起（失败也收起，避免重试时重复删已删的章）
    state.selectedIds = new Set();
    state.selectAnchorId = null;
    const missed = state.chapters.findIndex((chapter, index) => index === state.index && !chapter);
    if (currentSelected) {
      state.index = Math.min(firstIndex, Math.max(0, state.chapters.length - 1));
      state.dirty = false;
      await loadChapterAt(state.index);
    } else if (missed >= 0 || !state.chapters[state.index]) {
      // 当前章在书目里找不到了（极端情况：书目被外部改坏）：回第一处原下标，别停在一个空下标上
      state.index = Math.min(firstIndex, Math.max(0, state.chapters.length - 1));
      await loadChapterAt(state.index);
    } else {
      renderChapterList();
      renderEditorHeader();
      updateStatus();
    }
    syncChapterBatchBar();
    if (deleted.length) {
      activateBatchDeleteUndo(bookPath, deleted);
      const suffix = failed ? `（有 ${indexes.length - deleted.length} 章没删成：${failed.message}）` : '，10 秒内可撤销';
      toast(`已把 ${deleted.length} 章移到本书 _trash${suffix}`, failed ? 'warn' : undefined);
    }
    if (failed && !deleted.length) toast(`删除失败：${failed.message}`, 'error');
    return deleted.length > 0;
  }

  // 批量删除的撤销：按删除的**逆序**（从前往后）逐章按原始下标插回，最后一条撤销动作即可全部找回。
  // 顺序为什么是「从前往后」：删除是从后往前做的，原始下标在那一刻有效；倒过来插回才逐条落回原位。
  function activateBatchDeleteUndo(bookPath, deleted) {
    const count = deleted.length;
    const ordered = deleted.slice().sort((a, b) => a.index - b.index);
    undoUi.activate(`已删除 ${count} 章`, async () => {
      if (state.bookPath !== bookPath) throw new Error('已经换了书，不能撤销');
      await flushWriteTimer();
      const keepId = currentChapterId();
      let lastData = null;
      for (const entry of ordered) {
        const autoFile = entry.newChapter && entry.newChapter.file ? entry.newChapter.file : '';
        const current = state.chapters[state.index];
        // 删空自动补的空章：只在它还空着、编辑区也没动过它时一起收走（与单章撤销同一口径）
        const canRemoveAuto = Boolean(autoFile) && !(state.dirty && current && current.file === autoFile);
        // eslint-disable-next-line no-await-in-loop
        lastData = await call(api.restoreDeletedChapter, bookPath, {
          trashName: entry.trashName,
          undoToken: entry.undoToken || '',
          index: entry.index,
          chapter: {
            id: entry.chapter.id,
            file: entry.chapter.file,
            name: entry.chapter.name,
            createdAt: entry.chapter.createdAt,
            volumeId: entry.chapter.volumeId,
            status: entry.chapter.status,
            note: entry.chapter.note
          },
          autoChapterFile: canRemoveAuto ? autoFile : null
        });
        applyMetaAndRelocate(lastData, keepId || undefined);
      }
      const at = keepId ? state.chapters.findIndex((chapter) => chapter && String(chapter.id) === keepId) : -1;
      renderChapterList();
      renderEditorHeader();
      if (at >= 0) {
        state.index = at;
        updateStatus();
      } else {
        // 当前停在「删除整本后自动补的空章」上，它已经被收走：回第一处原下标重新读一章
        state.index = Math.min(ordered[0] ? ordered[0].index : 0, Math.max(0, state.chapters.length - 1));
        await loadChapterAt(state.index);
      }
      toast(`已撤销删除：${count} 章已放回原位`);
    });
  }

  async function moveSelectedChaptersToVolume(volumeId) {
    if (!state.bookPath) return { ok: false };
    const indexes = selectedChapterIndexes();
    if (!indexes.length) return { ok: false };
    if (indexes.length === 1) {
      const res = await moveChapterToVolume(indexes[0], volumeId);
      if (res && res.ok) clearChapterSelection();
      return res;
    }
    const bookPath = state.bookPath;
    const targetName = volumeDisplayName(volumeId);
    const keepCurrentId = currentChapterId();
    // 已经在目标卷里的章不动（否则只是给它们换顺序）：只移动真正换卷的那些
    const moves = indexes
      .map((index) => {
        const chapter = state.chapters[index];
        return {
          chapter,
          fromVolumeId: chapterVolumeId(chapter),
          beforeId: state.chapters[index + 1] ? state.chapters[index + 1].id : null
        };
      })
      .filter((move) => move.chapter && move.fromVolumeId !== (volumeId || null));
    if (!moves.length) {
      toast(`选中的章节已经在「${targetName}」里了`, 'warn');
      return { ok: false };
    }
    const done = [];
    let failed = null;
    for (const move of moves) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const data = await call(api.moveChapterToVolume, bookPath, move.chapter.id, volumeId || null);
        applyMetaAndRelocate(data, keepCurrentId);
        done.push(move);
      } catch (err) {
        failed = err;
        break;
      }
    }
    state.selectedIds = new Set();
    state.selectAnchorId = null;
    renderChapterList();
    renderEditorHeader();
    updateStatus();
    syncChapterBatchBar();
    if (done.length) {
      // 一条撤销：按原顺序逐条插回原来的下一章前面（跨卷移动撤销的同一口径）。
      undoUi.activate(`已把 ${done.length} 章移到「${targetName}」`, async () => {
        if (state.bookPath !== bookPath) throw new Error('已经换了书，不能撤销');
        for (const move of done) {
          const at = state.chapters.findIndex(
            (chapter) => chapter && String(chapter.id) === String(move.chapter.id)
          );
          if (at < 0) throw new Error('有一章已经不在书里了');
          // eslint-disable-next-line no-await-in-loop
          const back = await moveChapterByDrop(state.chapters[at], {
            volumeId: move.fromVolumeId,
            beforeChapterId: move.beforeId
          });
          if (!back || back.ok !== true) throw new Error((back && back.message) || '移动没有生效');
        }
      });
      toast(`已把 ${done.length} 章移到「${targetName}」`);
    }
    if (failed && !done.length) toast(`移动失败：${failed.message}`, 'error');
    return { ok: done.length > 0 };
  }

  async function setSelectedChaptersStatus(status) {
    const label = CHAPTER_STATUS_LABELS[status];
    if (!label) return { ok: false };
    const indexes = selectedChapterIndexes();
    if (!indexes.length) return { ok: false };
    if (indexes.length === 1) {
      const res = await setChapterStatusAt(indexes[0], status);
      clearChapterSelection();
      return res;
    }
    const bookPath = state.bookPath;
    let changed = 0;
    let failed = 0;
    for (const index of indexes) {
      const chapter = state.chapters[index];
      if (!chapter) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const data = await call(api.updateChapterMeta, bookPath, chapter.id, { status });
        applyMetaAndRelocate(data);
        if (data.changed) changed += 1;
      } catch {
        failed += 1;
      }
    }
    state.selectedIds = new Set();
    state.selectAnchorId = null;
    renderChapterList();
    renderEditorHeader();
    syncChapterBatchBar();
    if (changed) toast(`已把 ${changed} 章标记为${label}（只改书目，正文没动）`);
    else if (!failed) toast(`选中的章节本来就是${label}`);
    if (failed) toast(`${failed} 章改状态失败`, 'error');
    return { ok: changed > 0 || failed === 0, changed, failed };
  }

  // 导出选中章：只支持**连续范围**（与现有「第 X–Y 章」导出一致）。非连续时明确提示，不静默扩大。
  function exportSelectedChapters() {
    const indexes = selectedChapterIndexes();
    if (!indexes.length) return;
    const contiguous = indexes.every((value, i) => i === 0 || value === indexes[i - 1] + 1);
    if (!contiguous) {
      toast('导出只支持连续范围，请用 Shift 连选或改用范围导出', 'warn');
      return;
    }
    openExportDialog('txt', { from: indexes[0] + 1, to: indexes[indexes.length - 1] + 1 });
  }

  // 复制选中章：主进程按目录顺序拼「标题 \r\n\r\n 正文」（与导出拼接格式一致），一次写剪贴板。
  // 当前章有未保存内容时用编辑区文本（与导出 / 复制整本同一口径）；空选择不写。
  async function copySelectedChapters() {
    if (!state.bookPath) return null;
    const indexes = selectedChapterIndexes();
    if (!indexes.length) {
      toast('先选章节再复制', 'warn');
      return null;
    }
    const current = state.chapters[state.index];
    const override =
      state.dirty && indexes.includes(state.index) && current
        ? { chapterId: current.id, text: editorEl.value }
        : null;
    try {
      const data = await call(api.copyBook, state.bookPath, override, indexes);
      const parts = [`${data.chapterCount} 章`, `${formatCount(Number(data.chars) || 0)} 字`];
      if (data.includedUnsaved) parts.push('含当前章未保存内容');
      toast(`已复制选中的章节（${parts.join(' · ')}）`);
      return data;
    } catch (err) {
      toast(`复制失败：${err.message}`, 'error');
      return null;
    }
  }

  async function editChapterNoteAt(index) {
    const chapter = state.chapters[index];
    if (!chapter) return null;
    const value = await promptText({
      title: `章节备注：${chapterTitle(index, chapter.name)}`,
      message: '给自己记一句话（最多 200 字，只存进书目.json，不碰正文）。清空后确定 = 删除备注。',
      value: chapter.note || '',
      placeholder: '比如：这章结尾要重写'
    });
    if (value === null) return null;
    const res = await updateChapterInfo(index, { note: value });
    if (!res.ok) return null;
    const freshNote = chapterNote(state.chapters[index]);
    toast(freshNote ? '备注已保存' : '备注已清除');
    return freshNote;
  }

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
    showView, refreshShelf, promptText, call, updateWindowTitle, toast
  });
  const { backToShelf, renameBookFlow } = shelfNavUi;

  // ---------- 全局 Esc 链 / 关窗清理（有序注册表，v0.9 B-4 / 外部审计 F6） ----------
  // 优先级（谁先接 Esc）和「谁参与关窗清理」都在 renderer/esc-registry.js（纯逻辑、Node 单测覆盖）。
  // 这里只做渲染层那两件事：① escProbe() 摊出「现在谁开着」；② escActions 把动作 id 落到关闭函数上。
  // 改顺序 / 加一层请改注册表，别再把 if 块抄回 keydown 里。
  const ESC_BACKDROPS = [
    'conflict', 'bookinfo', 'history', 'format', 'export', 'settings', 'jump', 'find',
    'fragment', 'fragments', 'proofread', 'sensitive', 'capture', 'shortcuts',
    // 1.6.0 F5：分组管理（书架）也是锁键弹层，Esc 收起
    'group-manage'
  ];

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
    for (const name of ESC_BACKDROPS) {
      const el = $(`${name}-backdrop`);
      probe[name] = Boolean(el && !el.classList.contains('hidden'));
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
              focusChapterAfterSwitch(index);
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
  // 与 Esc 链「锁键层先接走」的口径一致。state.modal 单独算（它可能压在别的弹层之上）。
  function anyBackdropOpen() {
    if (state.modal) return true;
    for (const name of ESC_BACKDROPS) {
      const el = $(`${name}-backdrop`);
      if (el && !el.classList.contains('hidden')) return true;
    }
    return false;
  }

  // Ctrl+K：打开面板（lock 弹层开着时不抢 —— 与 Esc 链同一口径；输入法组字中不处理）
  function openCommandPalette() {
    if (anyBackdropOpen()) return false;
    return commandPalette.open(document.activeElement);
  }

  // ---------- 快捷键一览（1.5.0 功能-4：写作页按 ?；1.6.0 F4a 补系统键） ----------
  // 数据源 = renderer/command-catalog.js 的同一份声明：命令表里带键帽的 8 条 +「系统键」表
  // （Ctrl+K / Ctrl+Z / Esc / Shift+F10 … 非命令表的快捷键）。**不维护第二份快捷键表** ——
  // 目录里加一条带键位的命令、或加一个系统键，这一页与 README 的系统键表都会自动多一行。
  // 这里不用 buildCommandItems()：那份按当前视图过滤（书架页会把保存 / 新建章节等编辑类命令滤掉，
  // 一览页在书架页按 ? 就成了空表）；一览页只读声明表，与视图无关。
  function shortcutRows() {
    return commandCatalog.shortcutRows(commandPaletteModule.GROUP_LABELS || {});
  }

  function renderShortcutRows() {
    const list = $('shortcuts-list');
    if (!list) return 0;
    list.textContent = '';
    const rows = shortcutRows();
    let lastGroup = null;
    for (const row of rows) {
      if (row.groupLabel !== lastGroup) {
        lastGroup = row.groupLabel;
        const head = document.createElement('div');
        head.className = 'shortcut-group';
        head.setAttribute('role', 'presentation');
        head.textContent = row.groupLabel;
        list.appendChild(head);
      }
      const item = document.createElement('div');
      item.className = 'shortcut-row';
      item.setAttribute('role', 'listitem');
      item.dataset.shortcutId = row.id;
      const title = document.createElement('span');
      title.className = 'shortcut-title';
      title.textContent = row.title;
      const kbd = document.createElement('span');
      kbd.className = 'kbd shortcut-kbd';
      kbd.textContent = row.kbd;
      item.appendChild(title);
      // 系统键多一列「在哪儿生效」（命令行没有 scope，不画空气）。
      if (row.scope) {
        const scope = document.createElement('span');
        scope.className = 'shortcut-scope';
        scope.textContent = row.scope;
        item.appendChild(scope);
      }
      item.appendChild(kbd);
      list.appendChild(item);
    }
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'shortcut-empty muted small';
      empty.textContent = '命令表里暂时没有带键位的命令';
      list.appendChild(empty);
    }
    return rows.length;
  }

  function shortcutsOpen() {
    const backdrop = $('shortcuts-backdrop');
    return Boolean(backdrop && !backdrop.classList.contains('hidden'));
  }

  // 打开前的焦点（关闭时归还；dialog-focus 也会兜一层，这里显式还给编辑区 / 原按钮）
  let shortcutsOpener = null;

  function openShortcutsPage() {
    const backdrop = $('shortcuts-backdrop');
    if (!backdrop || shortcutsOpen()) return false;
    renderShortcutRows();
    const active = document.activeElement;
    shortcutsOpener = active && active !== document.body && active !== document.documentElement ? active : null;
    backdrop.classList.remove('hidden');
    // 焦点先落在右上「×」上：标题会被读屏连同弹层一起念出来，Tab 一次就到下面唯一的「关闭」。
    const closeButton = $('btn-shortcuts-close');
    if (closeButton && typeof closeButton.focus === 'function') closeButton.focus();
    return true;
  }

  function closeShortcutsPage() {
    const backdrop = $('shortcuts-backdrop');
    if (!backdrop || backdrop.classList.contains('hidden')) return false;
    backdrop.classList.add('hidden');
    const opener = shortcutsOpener;
    shortcutsOpener = null;
    const active = document.activeElement;
    // 焦点还留在刚关掉的弹层里 / 掉到 body 上 → 还给打开前的元素（编辑区或原按钮）。
    // 业务代码要是已经把焦点给了别处，就不抢。
    const lost = !active || active === document.body || active === document.documentElement || backdrop.contains(active);
    if (lost) {
      const target = opener && opener.isConnected ? opener : (state.view === 'editor' && state.bookPath ? editorEl : null);
      if (target && typeof target.focus === 'function') {
        try { target.focus(); } catch { /* 元素刚好不可聚焦：交给 dialog-focus 兜底 */ }
      }
    }
    return true;
  }

  // ---------- 关闭拦截 ----------
  async function handleCloseRequest() {
    // 关窗前先把写作计时里没上报的整秒记下（异步：统计写失败也不影响关窗判断）
    await flushWriteTimer();
    if (state.modal) {
      api.closeReady(false);
      return;
    }
    // 关窗前先把顶栏弹层 / 排版 / 设置 / 导出这几层收掉：否则「保存 / 不保存 / 取消」的询问会被它们压住。
    // 收哪几层、按什么顺序由 renderer/esc-registry.js 的 CLEANUP 决定（**只 6 项，是有意的子集**：
    // 书籍信息 / 查找 / 灵感箱 / 插入碎片 / 校对 / 敏感词本来就不会挡着关窗询问，照改前口径不收）。
    for (const action of escLib.cleanupActions(escProbe())) escRun(action);
    if (!state.dirty || !state.bookPath) {
      api.closeReady(true);
      return;
    }
    const action = await askUnsaved({
      title: '退出前保存',
      message: '当前章节有未保存的修改，退出会丢失这些内容。',
      saveLabel: '保存并退出',
      discardLabel: '不保存退出'
    });
    if (action === 'cancel') {
      api.closeReady(false);
      return;
    }
    if (action === 'discard') {
      discardUnsavedForClose();
      api.closeReady(true);
      return;
    }
    const saved = await saveCurrent();
    if (!saved.ok) {
      const again = await openModal({
        title: '保存失败',
        message: `保存失败：${saved.message}\n仍要退出吗？`,
        buttons: [
          { label: '返回保存', value: 'cancel', kind: 'primary' },
          { label: '放弃修改退出', value: 'discard', kind: 'danger' }
        ],
        cancelValue: 'cancel'
      });
      if (again.action !== 'discard') {
        api.closeReady(false);
        return;
      }
    }
    // 走到这里：保存成功过，或作者在「保存失败」里明确选了「放弃修改退出」——
    // 后者也要先把脏状态清掉，主进程才会放行（C5）。
    discardUnsavedForClose();
    api.closeReady(true);
  }

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
    let picked;
    try {
      picked = await call(api.findNext, text, options.query, from, {
        caseSensitive: options.caseSensitive
      });
    } catch (err) {
      $('find-summary').textContent = `查找失败：${err.message}`;
      return { ok: false };
    }
    if (!picked) {
      $('find-summary').textContent = `光标之后没有找到「${options.query}」了`;
      return { ok: false };
    }
    const match = picked.match;
    const replacement = options.replacement;
    editorEl.focus();
    editorEl.setSelectionRange(match.index, match.index + match.length);
    const inserted = replaceEditorTextNative(replacement);
    if (!inserted) {
      // 极端兜底：execCommand 不可用时手动拼接（会丢原生撤销链，但不会丢内容）
      const current = editorEl.value;
      editorEl.value =
        current.slice(0, match.index) + replacement + current.slice(match.index + match.length);
    }
    onEditorInput();

    // 选中下一处，方便连续替换
    let next = null;
    try {
      const after = match.index + replacement.length;
      next = await call(api.findNext, editorEl.value, options.query, after, {
        caseSensitive: options.caseSensitive
      });
    } catch { /* 找下一处失败不影响已经替换的内容 */ }
    if (next) {
      editorEl.setSelectionRange(next.match.index, next.match.index + next.match.length);
      scrollCaretIntoView(next.match.index);
    } else {
      const caret = match.index + replacement.length;
      editorEl.setSelectionRange(caret, caret);
      scrollCaretIntoView(caret);
    }
    const nextHint = next ? `；已选中下一处（第 ${next.index + 1} 处）` : '；本章后面没有下一处了';
    $('find-summary').textContent =
      `已替换第 ${picked.index + 1}/${picked.total} 处（未保存：Ctrl+S 写盘，Ctrl+Z 可撤销）${nextHint}`;
    return { ok: true, index: picked.index, total: picked.total, hasNext: Boolean(next) };
  }

  // 从最近的「整本替换」备份还原；还原前二次确认，并由 storage 把当前内容再备份一份。
  async function restoreReplaceBackupFlow(backupName) {
    if (!state.bookPath) {
      toast('还没有打开一本书', 'warn');
      return { ok: false };
    }
    await refreshReplaceBackups();
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
    }
    const others = state.replaceBackups.length - 1;
    // 1.4.0 P0-2（撤销优先于确认）：还原到替换前不再弹二次确认 —— 直接还原
    // （storage 会先把当前内容备份到 _trash/还原前备份-*），10 秒内可撤销（= 用那份还原前备份再还原一次）。
    // 未保存拦截仍在前一步：这个动作会从磁盘重载正文，编辑区没写盘的字找不回来。
    const bookPath = state.bookPath;
    try {
      const data = await call(api.restoreReplaceBackup, state.bookPath, target.name);
      await reloadOpenBookFromDisk();
      await refreshShelf();
      await refreshReplaceBackups();
      const undoName = data.restoreBackupDir ? String(data.restoreBackupDir).split(/[\\/]/).pop() : '';
      if (undoName) {
        // 1.5.0 P0-5（审计 V-2）：登记撤销时记下这份「还原前备份」的指纹；撤销前核对它还是不是那一份。
        const expectedBackup = await backupGuard.fingerprint(bookPath, undoName);
        undoUi.activate(`已还原到「${target.name}」前的正文`, async () => {
          if (state.bookPath !== bookPath) throw new Error('已经换了书，不能撤销');
          await backupGuard.assertUnchanged(bookPath, expectedBackup);
          const back = await call(api.restoreHistoryDir, bookPath, `dir:${undoName}`);
          if (!back || !Number(back.restored)) throw new Error('还原前备份里没有可还原的章节');
          await reloadOpenBookFromDisk();
          await refreshShelf();
          await refreshReplaceBackups();
        });
      }
      toast(
        `已还原 ${data.restored} 个章节${
          data.skipped ? `（跳过 ${data.skipped} 个已不存在的章节）` : ''
        }，当前内容已备份到 _trash${others > 0 ? `（还有 ${others} 次更早的替换备份）` : ''}`
      );
      return { ok: true, data };
    } catch (err) {
      toast(`还原失败：${err.message}`, 'error');
      await reloadAfterPartialFailure(state.bookPath); // 可能已经还原了几章，界面回到磁盘的真相
      return { ok: false, message: err.message };
    }
  }

  // 还原 / 外部改动后从磁盘重载当前书（章节列表、字数、当前章）。
  // 章节 id 保持不变就回到原来那一章；章节被删/书目重建时回到第 1 章。
  async function reloadOpenBookFromDisk() {
    if (!state.bookPath) return null;
    const currentId = state.chapters[state.index] && state.chapters[state.index].id;
    const opened = await call(api.openBook, state.bookPath);
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
    if (bookPath && !sameBookPath(state.bookPath, bookPath)) return false;
    try {
      await reloadOpenBookFromDisk();
      return true;
    } catch {
      return false; // 重载失败不影响上面的错误提示（提示里已经写清现场）
    }
  }

  // ---------- 本书历史 ----------
  // 第 4 步九刀·第一刀：实现在 renderer/history-ui.js（模块头有契约），这里只装配与接线；
  const historyUi = historyUiModule.create({
    $, state, api, call, toast,
    // 1.5.0 P0-5（审计 V-2）：历史还原的撤销也要核对备份没变
    guard: backupGuard,
    collab: { confirmRestoreWithUnsaved, openModal, refreshShelf, reloadAfterPartialFailure, reloadOpenBookFromDisk,
      registerUndo: (label, run) => undoUi.activate(label, run) },
    menus: { hideBookMenu, hideExportMenu },
    fmt: { formatBytes }
  });
  const { sameBookPath, openHistoryForPath, openHistoryForCurrentBook, refreshHistory, closeHistoryDialog, closeHistoryPreview, previewHistoryBackup, confirmHistoryRestore } = historyUi;



  // ---------- 灵感箱（碎片速记） ----------
  // 第 4 步九刀·补刀 10：实现在 renderer/fragments-ui.js（模块头有契约），这里只装配与接线；
  const fragmentsUi = fragmentsUiModule.create({
    $, state, api, call, toast,
    common: { chaptersLib, formatRelativeTime, formatCount },
    editor: { editorEl, onEditorInput, scrollCaretIntoView },
    hideHeaderMenus
  });
  const { updateFragmentCounter, openFragmentDialog, closeFragmentDialog, saveFragment, openInsertFragmentDialog, closeInsertFragmentDialog, insertSelectedFragment, selectFragmentByName, refreshFragments, setupFragmentsUi } = fragmentsUi;

  // ---------- 校对 ----------
  // 第 4 步九刀·第四刀：实现在 renderer/proofread-ui.js（模块头有契约），这里只装配与接线；
  const proofreadUi = proofreadUiModule.create({
    $, state, api, call, toast,
    peers: { closeFindPanel, renderProofreadSettings: () => renderProofreadSettings() },
    nav: { chapterTitle, editorEl, switchChapter },
    view: { effectiveConfig, hideHeaderMenus, scrollCaretIntoView }
  });
  const { proofreadWordListText, refreshProofreadWordList, openProofreadPanel, closeProofreadPanel, proofreadScope, currentChapterRef, matchRangeAt, runProofread, pickProofreadWords, setupProofreadUi } = proofreadUi;

  // ---------- 敏感词预检 ----------
  // 第 4 步九刀·第五刀：实现在 renderer/sensitive-ui.js（模块头有契约），这里只装配与接线；
  const sensitiveUi = sensitiveUiModule.create({
    $, state, api, call, toast,
    peers: { closeFindPanel, closeProofreadPanel, currentChapterRef, matchRangeAt, renderSensitiveSettings: () => renderSensitiveSettings() },
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

  function scrollCaretIntoView(pos) {
    const lineIndex = (editorEl.value.slice(0, pos).match(/\n/g) || []).length;
    const lineHeight = parseFloat(getComputedStyle(editorEl).lineHeight) || 32;
    const top = lineIndex * lineHeight;
    const viewBottom = editorEl.scrollTop + editorEl.clientHeight - lineHeight * 2;
    if (top < editorEl.scrollTop || top > viewBottom) {
      editorEl.scrollTop = Math.max(0, top - editorEl.clientHeight / 3);
    }
  }

  // ---------- 「整理」按钮的悬浮选择卡 + 「显示」菜单 ----------
  // 第 4 步九刀·第八刀：实现在 renderer/tidy-card-ui.js（模块头有契约），这里只装配与接线；
  const tidyCardUi = tidyCardUiModule.create({
    $, state, api, call, toast,
    format: { formatUi, MAX_FORMAT_UNDO, readFormatOptions, writeFormatOptions, editorEl, onEditorInput, chaptersLib, caretColorLib },
    menus: { hideBookMenu, hideExportMenu, hideMenu, renderMarksMenu },
    peers: { openSettings: () => openSettings(), toggleMarks, setDisplayPreset, applyCaretColor, setCaretParagraphPersisted, setCaretColorPersisted, runFormatBook, scrollCaretIntoView }
  });
  const { formatCardOpen, displayMenuOpen, refreshFormatCard, showFormatCard, hideFormatMenu, scheduleHideFormatCard, showDisplayMenu, hideDisplayMenu, openFormatDialog, closeFormatDialog, formatUndoSteps, canUndoFormat, undoFormat, formatCurrentChapterFromConfig, applyFormatToEditor, setupTidyCardUi } = tidyCardUi;

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
    if (state.formatBookRunning) {
      toast('正在整理这本书，请稍候', 'warn');
      return { ok: false, busy: true };
    }
    hideFormatMenu();
    hideDisplayMenu();
    if (state.dirty) {
      const action = await askUnsaved({
        title: '整理本书前先处理未保存的修改',
        message: `「${currentChapterLabel()}」还有未保存的修改；整本整理会直接写盘，建议先保存。`,
        saveLabel: '保存后整理',
        discardLabel: '不保存（按磁盘内容整理）'
      });
      if (action === 'cancel') return { ok: false, canceled: true };
      if (action === 'save') {
        const saved = await saveCurrent();
        if (!saved.ok) return saved;
      } else {
        await loadChapterAt(state.index); // 用磁盘上的旧内容继续
      }
    }

    const options = formatUi.mergeOptions(state.config && state.config.formatOptions);
    let preview;
    try {
      preview = await call(api.formatPreviewBook, state.bookPath, options);
    } catch (err) {
      toast(`预检查失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
    if (!preview.chaptersChanged) {
      toast('这本书已经是整理后的格式，没有可改的地方');
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

    state.formatBookRunning = true;
    const bookPath = state.bookPath;
    const currentId = state.chapters[state.index] && state.chapters[state.index].id;
    showFormatBookProgress(`正在整理整本书…（共 ${preview.chaptersChanged} 章要改）`);
    try {
      const result = await call(api.formatBook, state.bookPath, options);
      // 整理后重新载入书和当前章（正文、字数缓存都变了）
      const opened = await call(api.openBook, state.bookPath);
      state.meta = opened.meta;
      state.chapters = opened.meta.chapters;
      const index = Math.max(
        0,
        state.chapters.findIndex((chapter) => chapter.id === currentId)
      );
      await loadChapterAt(index);
      renderChapterList();
      renderEditorHeader();
      await refreshShelf();
      // 撤销：用这次整理写盘前的备份整组还原（storage 会先把现在的内容再备份到 _trash/还原前备份-*）
      const backupName = result.backupDir ? String(result.backupDir).split(/[\\/]/).pop() : '';
      if (result.chaptersChanged && backupName) {
        // 1.5.0 P0-5（审计 V-2）：登记撤销时记下整理备份的指纹；撤销前核对它还是不是那一份。
        const expectedBackup = await backupGuard.fingerprint(bookPath, backupName);
        undoUi.activate(`已整理全书 ${result.chaptersChanged} 章`, async () => {
          if (state.bookPath !== bookPath) throw new Error('已经换了书，不能撤销');
          await backupGuard.assertUnchanged(bookPath, expectedBackup);
          const data = await call(api.restoreHistoryDir, bookPath, `dir:${backupName}`);
          if (!data || !Number(data.restored)) throw new Error('整理备份里没有可还原的章节');
          await reloadOpenBookFromDisk();
          await refreshShelf();
        });
      }
      toast(
        `已整理全书：${result.chaptersChanged} 章${planText ? `（${planText}）` : ''}${
          result.backupDir ? ' · 原文已备份到 _trash' : ''
        }`
      );
      return { ok: true, changed: result.chaptersChanged, data: result };
    } catch (err) {
      toast(`整理本书失败：${err.message}`, 'error');
      await reloadAfterPartialFailure(); // 可能已经整理了好几章，别让编辑区停在旧正文上
      return { ok: false, message: err.message };
    } finally {
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

  // ---------- 事件绑定 ----------
  function bindEvents() {
    settingsUi.setupSettingsUi();
    writeTimerUi.setupWriteTimerUi();
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

    fragmentsUi.setupFragmentsUi();

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

    // B6（审计 P6）：书架搜索原来每敲一个键就整块重建 grid（千本书时每键白建一堆 DOM）。
    // 改成 250ms 防抖 + 下一帧渲染：查询词仍立刻写回 state（正文搜索 / 回车 / 清空都用最新值），
    // 只是「过滤重排」等停手后再做一次。
    let shelfFilterTimer = 0;
    let shelfFilterFrame = 0;
    function scheduleShelfRender() {
      if (shelfFilterTimer) clearTimeout(shelfFilterTimer);
      shelfFilterTimer = setTimeout(() => {
        shelfFilterTimer = 0;
        if (shelfFilterFrame) return;
        shelfFilterFrame = requestAnimationFrame(() => {
          shelfFilterFrame = 0;
          renderShelf();
        });
      }, 250);
    }

    // 书架搜索：书名 / 章节名输入即过滤（B6：过滤重排走 250ms 防抖 + rAF）；正文防抖后异步查；
    // Esc 清除（立即）；回车打开第一本匹配的书
    $('shelf-search').addEventListener('input', () => {
      state.shelfQuery = $('shelf-search').value;
      scheduleShelfRender();
      scheduleContentSearch();
    });
    $('shelf-search').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        state.shelfQuery = '';
        $('shelf-search').value = '';
        resetShelfContent();
        renderShelf();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const rows = shelfSearchResults();
        if (rows.length) {
          openBookByPath(rows[0].book.path);
          return;
        }
        // 书名 / 章名没有命中时，回车的含义就是「打开第一条正文命中」
        const content = state.shelfContent;
        const first = content.meta && content.meta.results ? content.meta.results[0] : null;
        if (first) void openContentResult(first);
      }
    });
    $('btn-shelf-search-clear').addEventListener('click', () => {
      state.shelfQuery = '';
      $('shelf-search').value = '';
      resetShelfContent();
      renderShelf();
      $('shelf-search').focus();
    });
    $('btn-shelf-content-more').addEventListener('click', () => {
      state.shelfContent.shown += CONTENT_PAGE_SIZE;
      renderShelfContent();
    });

    $('book-menu').addEventListener('click', async (event) => {
      const btn = event.target.closest('button[data-action]');
      if (!btn) return;
      const book = state.contextBook;
      hideBookMenu();
      if (!book) return;
      if (btn.dataset.action === 'open') {
        await openBookByPath(book.path);
      } else if (btn.dataset.action === 'open-new-window') {
        await openBookInNewWindow(book);
      } else if (btn.dataset.action === 'folder') {
        try {
          await call(api.openBookFolder, book.path);
        } catch (err) {
          toast(`打开文件夹失败：${err.message}`, 'error');
        }
      } else if (btn.dataset.action === 'info') {
        openBookInfoDialog(book);
      } else if (btn.dataset.action === 'move-group') {
        // 1.6.0 F5：书架没有多选，先做单本「移到分组…」（批量改分组记 §9 待办）
        await moveBookToGroup(book);
      } else if (btn.dataset.action === 'delete') {
        await deleteBookFlow(book);
      } else if (btn.dataset.action === 'history') {
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
    focusModeUi.setupFocusModeUi();
    readingUi.setupReadingUi();
    // 查找书签（v0.8-11b）：把当前章的词 + 大小写存进 config；只写配置，不碰正文 / 书目
    findBookmarkUi.setupFindBookmarkUi();
    proofreadUi.setupProofreadUi();
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
    sensitiveUi.setupSensitiveUi();
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
        event.preventDefault();
        confirmJumpFromDialog();
      }
    });
    $('btn-jump-cancel').addEventListener('click', closeJumpDialog);
    $('btn-jump-confirm').addEventListener('click', () => confirmJumpFromDialog());

    tidyCardUi.setupTidyCardUi();


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
  // 别的窗口改了书架数据（新建 / 删除 / 保存 / 导入 / 整理）：停在书架就刷新；
  // 写作页里的窗口不打断作者，回书架时会统一刷新（backToShelf 里本来就会刷新）。
  api.onShelfChanged(() => {
    if (state.view === 'shelf' && !state.importing && !state.formatBookRunning) {
      refreshShelf().catch(() => {});
    }
  });

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
        renderShelfContent();
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
        if (event.isComposing) return;
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
        if (!event.isComposing && !event.repeat && !anyBackdropOpen()) {
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
            focusChapterAfterSwitch(target);
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
        if (state.view === 'editor' && state.bookPath && undoFormat()) {
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
  // 书架网格当前几列（拍板 #16b）：getComputedStyle 的 gridTemplateColumns 算出来是
  // 「每列一条轨道 + 空格」，数一下就得到列数（含 1fr / minmax 这类写法）。
  // 拿不到（还没渲染 / display 不是 grid）就退化成 1 列 → 方向键回到单向移动（等价旧行为）。
  function bookGridColumns() {
    const grid = $('book-grid');
    if (!grid || typeof window.getComputedStyle !== 'function') return 1;
    const cols = String(window.getComputedStyle(grid).gridTemplateColumns || '').trim();
    if (!cols || cols === 'none') return 1;
    const count = cols.split(/\s+/).filter(Boolean).length;
    return Number.isFinite(count) && count > 0 ? count : 1;
  }

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
      onAltMove: (item, position, direction) => {
        void moveChapterStep(position, direction);
      },
      // U-D9：列表焦点里按 Delete = 删除焦点所在这一章。键位只是复用右键菜单同一条
      // deleteChapterAt（未保存询问 / 确认框 / 进 _trash / 失败提示全都不动），不新增删除语义。
      // 删完把焦点放回列表原位置，键盘用户不会掉回 body；编辑区不在这个容器里，Delete 删字不受影响。
      allowDelete: true,
      onDelete: (item, position) => {
        // 1.5.0 功能-1：焦点章在多选里（且选了不止一章）→ Delete 删整批，只登记一条撤销
        if (state.selectedIds.size > 1 && state.selectedIds.has(chapterIdAt(position))) {
          void deleteSelectedChapters()
            .then((deleted) => {
              if (deleted) focusChapterAfterDelete(position);
            })
            .catch((err) => reportChainFailure('批量删除失败', err));
          return;
        }
        // B1（审计 E2）：删除失败不再静默（原来 .then 没有 .catch，焦点恢复那步永不执行）
        void deleteChapterAt(position)
          .then((deleted) => {
            if (deleted) focusChapterAfterDelete(position);
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
    // 版本号以 package.json 为准（发版只改一处，界面跟着变）
    try {
      const appInfo = await call(api.appVersion);
      const versionEl = $('app-version');
      if (versionEl && appInfo && appInfo.version) versionEl.textContent = `v${appInfo.version}`;
      state.appVersion = (appInfo && appInfo.version) || '';
    } catch {
      /* 拿不到就保留 index.html 里的静态版本号 */
    }
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
