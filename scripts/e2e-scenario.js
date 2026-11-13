// 端到端自检：真实启动 Electron，通过渲染层的 __cwTest 钩子走主流程，
// 再回到主进程侧直接检查磁盘文件，验证「保存整本、编号重排、未保存拦截」确实生效。
//
// 组拆分（2026-11-04 窗口）：第 0–51 组（v0.10.0 时还留在这个 1 万行函数里）与第 52–72 组
// 一样整段搬到 scripts/e2e/groups/NN-名字.js，本文件只剩 ctx 解构 + 公共工具装配 + 组调用序列：
// **只搬文件、不改断言**（断言逐字未改，E2E 1515 PASS 名字逐行一致）。组与组之间的会话状态
// 经 groupContext() 传（见下面的 state 袋子）。
const path = require('node:path');
const chaptersLib = require('../core/chapters');
const securityPolicyLib = require('../core/security-policy');
const exporter = require('../core/exporter');
const statsLib = require('../core/stats');
const statsSeedLib = require('./e2e-stats-seed');
const fragmentsLib = require('../core/fragments');
const importerLib = require('../core/importer');
const { entryNameProblem } = require('../core/zip');
const { readZip, assertWellFormedXml } = require('./export-check');
const { createHarness } = require('./e2e/harness');
const e2eGroups = require('./e2e/groups');

module.exports = async function runScenario(ctx) {
  const { win, clipboard, config, userData, storage, sleep, exec, getCloseReady, resetCloseReady } = ctx;
  const {
    openWindow,
    closeWindow,
    destroyWindow,
    execIn,
    focusWindow,
    windowsInfo,
    openBookRegistry,
    registryCounts,
    mostRecentWindowId,
    windowBounds,
    setRealClose,
    windowAllClosed,
    // 第 56 组（Electron 安全开关）读安全策略探针（ctx.securityInfo / ctx.securityProbe）。
    securityInfo,
    securityProbe,
    // Electron app（组 36 / 45 要 app.getPath('userData')；ctx 里本来就有，不另 require electron）。
    app
  } = ctx;
  const booksRoot = config.booksRoot;
  const bookDir = path.join(booksRoot, '测试书');
  // 仓库根目录（第 56 组要按它启动第二个进程试单实例锁；本文件的 __dirname = scripts）。
  const appRoot = path.join(__dirname, '..');
  // E2E 公共工具（v0.9 B-7）：check / waitFor / 删书重试 / 读日志都收在 scripts/e2e/harness.js，
  // 拆到 scripts/e2e/groups/*.js 的各组也用同一份，不许各写一套。
  const harness = createHarness(ctx);
  const { checks, check, waitFor, logDir, logNamePattern, readLogs, waitForLog, deleteBookWithRetry, fileExists } =
    harness;
  // 1.6.0 G2：失败累计（check 不再抛错；组内异常由 runGroups 记成「场景异常」继续下一组）+ 有名字的等待。
  const { recordFailure, waitForRender, waitForFocus, waitForDisk } = harness;

  // 场景开场先让自动化窗口拿一次系统焦点（2026-11-01 v0.9 R0）；工具已下沉 harness.js
  // （ensureWindowFocus / diskText / waitForFile / waitForSummary / waitCloseReady / 剪贴板工具）：
  // 第 0–51 组的组文件与这里用同一份，不许各写一套。
  const { ensureWindowFocus, setWindowSize, diskText, waitForFile, waitForSummary, waitCloseReady, readClipboard, waitForClipboard } =
    harness;

  // 导出 / 另存为对话框劫持（组 39 用，组 45 / 46 / 59 复用）：
  // dialog 是 electron 主进程能力，组文件与 harness 都只许 require node 内建，所以这套工具留在
  // 场景前导、经 groupContext() 用同一批函数交给组文件（v0.5-3 起原有实现，逐字未改行为）。
  const { dialog } = require('electron');
  const originalShowSaveDialog = dialog.showSaveDialog;
  // 最近一次 showSaveDialog 的 options：withSavePath 每次先清空，mock 收到时再写。
  // （以前是组 39 里的一个局部变量；跨组搬文件后改成对象属性，读写同一份。）
  const saveDialog = { last: null };
  const withSavePath = (filePath) => {
    saveDialog.last = null;
    dialog.showSaveDialog = async (_win, options) => {
      saveDialog.last = options;
      return { canceled: false, filePath };
    };
  };
  const restoreSaveDialog = () => {
    dialog.showSaveDialog = originalShowSaveDialog;
  };
  // action = 'txt'（默认）| 'epub'：两个入口现在都打开同一个范围对话框（v0.8 P0 N8）
  const openExportDialogFromMenu = async (action = 'txt') => {
    await exec(
      `document.getElementById('btn-export').click(); document.querySelector('#export-menu button[data-action="${action}"]').click()`
    );
    await waitFor('window.__cwTest.exportDialogOpen() === true');
  };
  const chooseExportRange = async (from, to) => {
    await exec(
      "document.querySelector('input[name=\"export-scope\"][value=\"range\"]').click()"
    );
    await exec(
      `(() => { const f = document.getElementById('export-from'); f.value = ${JSON.stringify(String(from))}; f.dispatchEvent(new Event('input', { bubbles: true })); const t = document.getElementById('export-to'); t.value = ${JSON.stringify(String(to))}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`
    );
  };

  // 组与组之间的会话状态（第 0–51 组拆组）：组内局部变量搬不进别的文件，
  // 生产组把「后面的组 / groupContext() 还要用」的值写回 state（如 state.focusBookPath = …），
  // 消费组在组文件里 `const { x } = t.state` 取。state 只做传递，不参与任何断言口径。
  const state = {};

  await waitFor('Boolean(window.__cwTest && window.__cwTest.ready)');
  await ensureWindowFocus();

  // 第 0–51 组（v0.10.0 时还留在这个文件里）：正文整段搬到 scripts/e2e/groups/，这里只在原位按组号跑；
  // 组文件只 require node 内建，需要的上下文统一由 groupContext() 交过去。
  // 注意：groupContext() 是调用时快照，所以一组一次 runGroups（同一次里后一组读不到前一组写进 state 的值）。
  const groupContext = () => ({
    // ---------- 场景上下文（主进程侧注入） ----------
    exec,
    check,
    recordFailure,
    waitFor,
    waitForRender,
    waitForFocus,
    waitForDisk,
    sleep,
    win,
    clipboard,
    storage,
    userData,
    getCloseReady,
    resetCloseReady,
    booksRoot,
    bookDir,
    appRoot,
    app,
    appVersion: require('../package.json').version,
    // ---------- 公共工具（v0.9 B-7 起收在 harness.js；第 0–51 组也用同一份） ----------
    diskText,
    ensureWindowFocus,
    setWindowSize,
    waitForFile,
    waitForSummary,
    waitCloseReady,
    readClipboard,
    waitForClipboard,
    fileExists,
    deleteBookWithRetry,
    waitForLog,
    readLogs,
    logDir,
    logNamePattern,
    // ---------- 模块库（只读复用；组文件不 require 产品代码） ----------
    chaptersLib,
    exporter,
    statsLib,
    statsSeedLib,
    fragmentsLib,
    readZip,
    assertWellFormedXml,
    // ---------- 导出 / 另存为对话框劫持（组 39 / 45 / 46 / 59 共用场景前导那一份） ----------
    dialog,
    saveDialog,
    withSavePath,
    restoreSaveDialog,
    openExportDialogFromMenu,
    chooseExportRange,
    // ---------- 组间状态（生产组 state.X = … 写回，消费组从 t.state 取） ----------
    state,
    // ---------- 第 52 组之后（已拆组）的原键：值来源改成 state（第 47 / 49 / 51 组写回） ----------
    // 第 51 组留下的那本书（第 52 / 54 组按路径再打开一次）。
    bookPath: state.focusBookPath,
    // 第 53 组要按路径核对「书库 / 书文件夹里都没多出索引文件」「v0.4.1 旧书书目没被补字段」。
    fragLegacyMetaPath: state.fragLegacyMetaPath,
    // 第 54 组 54h 的「标题统一」拿 core 的 formatTitle / countChars 当口径（只读，不改书）。
    chapters: chaptersLib,
    // 第 56 组（Electron 安全开关）要读窗口登记与安全策略探针；期望值只有一处来源（只读常量）。
    windowsInfo,
    securityInfo,
    securityProbe,
    registryCounts,
    securityPolicy: securityPolicyLib,
    // 第 56 组要按仓库根目录再起一个进程试单实例锁（组文件在 groups/ 下，用不了这里的 __dirname）。
    // 第 58 组要开 / 关第二个窗口并在它里面执行表达式，验证「路径登记按窗口分开」。
    execIn,
    openWindow,
    destroyWindow,
    // 第 59 组（导入 / 导出边界）要把导出的 zip 读回来验条目名 / XML、劫持另存为对话框读默认文件名。
    saveOptions: () => saveDialog.last,
    entryNameProblem,
    importer: importerLib,
    // 第 55 组（多窗口）要开 / 关窗口、读窗口登记与最近窗口、读写关窗回执、量窗口位置；
    // 55i 的旧书兼容还要按路径读那一版 v0.4.1 书目（第 47 组留下的）。
    closeWindow,
    setRealClose,
    windowAllClosed,
    windowBounds,
    mostRecentWindowId,
    openBookRegistry,
    fragLegacyBookPath: state.fragLegacyBookPath
  });

  // 0. 界面版本号跟着 package.json 走（正文在 groups/00-version-and-ipc-guard.js）
  await e2eGroups.runGroups(groupContext(), [0]);
  // 1. 新建书 → 自动打开、自动带一个空章（正文在 groups/01-new-book.js）
  await e2eGroups.runGroups(groupContext(), [1]);
  // 2. 改名 + 追加两章 → 章号按顺序自动生成（正文在 groups/02-chapter-numbering.js）
  await e2eGroups.runGroups(groupContext(), [2]);
  // 3. 手动保存整本：写当前章 + 校验全书（正文在 groups/03-save-book.js）
  await e2eGroups.runGroups(groupContext(), [3]);

  // 4. 中间插入 → 章号自动顺延，旧文件一个都不改名（正文在 groups/04-insert-chapter.js）
  await e2eGroups.runGroups(groupContext(), [4]);

  // 5. 未保存时切章 → 选择「不保存」→ 磁盘不变（正文在 groups/05-switch-discard.js）
  await e2eGroups.runGroups(groupContext(), [5]);

  // 6. 未保存时切章 → 选择「保存并切换」→ 磁盘更新（正文在 groups/06-switch-save.js）
  await e2eGroups.runGroups(groupContext(), [6]);

  // 7. 重命名章节（新建的「灯塔」改名为「灯塔改名」）（正文在 groups/07-rename-chapter.js）
  await e2eGroups.runGroups(groupContext(), [7]);

  // 8. 删除章节 → 文件进 _trash，json 移除（正文在 groups/08-delete-chapter.js）
  await e2eGroups.runGroups(groupContext(), [8]);

  // 9. 复制整本：内容 = 导出拼接格式（标题行 + 空行 + 正文）（正文在 groups/09-copy-book.js）
  await e2eGroups.runGroups(groupContext(), [9]);

  // 10. 关窗拦截：未保存 → 取消 → 不退出（正文在 groups/10-close-guard-cancel.js）
  await e2eGroups.runGroups(groupContext(), [10]);

  // 11. 关窗拦截：未保存 → 保存并退出 → 磁盘更新（正文在 groups/11-close-guard-save.js）
  await e2eGroups.runGroups(groupContext(), [11]);

  // 12. 干净状态关窗：不弹窗直接允许（正文在 groups/12-close-clean.js）
  await e2eGroups.runGroups(groupContext(), [12]);

  // 13. 重载窗口（模拟重启）后重新打开书：内容、顺序、上次章节都还在（正文在 groups/13-reload-window.js）
  await e2eGroups.runGroups(groupContext(), [13]);

  // 14. 外部修改检测：模拟用记事本改了当前章，重新获得焦点时提示重新加载（正文在 groups/14-external-change.js）
  await e2eGroups.runGroups(groupContext(), [14]);

  // 15. 损坏书目恢复：从目录 txt 重建（正文在 groups/15-repair-meta.js）
  await e2eGroups.runGroups(groupContext(), [15]);

  // 16. 导入小说：外部文件夹（纯 txt）→ 书架里的一本书（正文在 groups/16-import-folder.js）
  await e2eGroups.runGroups(groupContext(), [16]);

  // 17. 删除小说：整本书进 _trash（e2e 走兜底路径，不往你的回收站丢测试数据）（正文在 groups/17-delete-book.js）
  await e2eGroups.runGroups(groupContext(), [17]);

  // 18. 导入小说收藏夹：每个 txt 是一本书，自动分章（正文在 groups/18-import-collection.js）
  await e2eGroups.runGroups(groupContext(), [18]);

  // 19. 默认「原文件导入」：整篇一章、内容与源文件完全一致（不拆章、不改字）（正文在 groups/19-import-raw.js）
  await e2eGroups.runGroups(groupContext(), [19]);

  // 20. 默认「按原文章节导入」：按原文标题拆章，章名和正文照抄（正文在 groups/20-import-chapters.js）
  await e2eGroups.runGroups(groupContext(), [20]);

  // 21. 章节栏 / 写作区 之间的分隔条可拖动，宽度按「这本书」记忆（不写全局）（正文在 groups/21-sidebar-splitter.js）
  await e2eGroups.runGroups(groupContext(), [21]);

  // 22. 排版：一键整理本章 —— 改正文但不自动写盘，可撤销，落盘为 CRLF（正文在 groups/22-format-chapter.js）
  await e2eGroups.runGroups(groupContext(), [22]);

  // 23. 显示排版：预设 / 设置实时预览与取消恢复（按书记忆：只影响这本书，全局默认不动）（正文在 groups/23-display-format.js）
  await e2eGroups.runGroups(groupContext(), [23]);

  // 24. 审阅修复复核：① 整理/撤销不把光标打回章首；② 关窗询问能压住排版弹层（正文在 groups/24-review-fixes.js）
  await e2eGroups.runGroups(groupContext(), [24]);

  // 25. 智能排版（对齐口袋写作）：缩进 0 字符 / 空一行（含缩进）（正文在 groups/25-smart-format.js）
  await e2eGroups.runGroups(groupContext(), [25]);

  // 26. 口袋写作同款显示项：字体文件（.ttf）、夜间、纸张纹理、左右边距（正文在 groups/26-display-options.js）
  await e2eGroups.runGroups(groupContext(), [26]);

  // 27. 章节拖拽排序：只改书目顺序，章节文件永不重命名，内容跟着章节走（正文在 groups/27-drag-sort.js）
  await e2eGroups.runGroups(groupContext(), [27]);

  // 28. 全书查找 / 替换（替换前自动备份原章节）（正文在 groups/28-find-replace.js）
  await e2eGroups.runGroups(groupContext(), [28]);

  // 29. 只替换这一处：只改编辑区、替换后选中下一处、只作用于当前章（正文在 groups/29-replace-one.js）
  await e2eGroups.runGroups(groupContext(), [29]);

  // 30. 整本替换的备份还原：列出备份 → 二次确认 → 正文回到替换前（当前内容再备份一份）（正文在 groups/30-replace-backup.js）
  await e2eGroups.runGroups(groupContext(), [30]);

  // 31. 撤销整理：快照上限 10 → 50，菜单显示还能撤销几步（正文在 groups/31-undo-format.js）
  await e2eGroups.runGroups(groupContext(), [31]);

  // 32. 标点扩展：直引号 / 省略号（默认关，勾上才转，预览里给统计）（正文在 groups/32-punct-extend.js）
  await e2eGroups.runGroups(groupContext(), [32]);

  // 33. 书架搜索：书名 + 章节名（不读正文）（正文在 groups/33-shelf-search.js）
  await e2eGroups.runGroups(groupContext(), [33]);

  // 34. 按书记忆显示设置：两本书互不影响，恢复默认回全局（正文在 groups/34-per-book-display.js）
  await e2eGroups.runGroups(groupContext(), [34]);

  // 35. 新建 / 插入章节前自动保存当前章（不再弹「保存 / 不保存 / 取消」）（正文在 groups/35-auto-save.js）
  await e2eGroups.runGroups(groupContext(), [35]);

  // 36. 一键整理本书：复用当前规则 + 确认框 + 整本备份 + 进度（正文在 groups/36-format-book.js）
  await e2eGroups.runGroups(groupContext(), [36]);

  // 37. 章节状态 + 备注：只改书目.json，章节 txt 一个字节不动（正文在 groups/37-chapter-status.js）
  await e2eGroups.runGroups(groupContext(), [37]);

  // 38. 复制本章（平台格式）：只复制正文、段首缩进 + 段间空一行（空行带缩进），不写盘（正文在 groups/38-copy-chapter.js）
  await e2eGroups.runGroups(groupContext(), [38]);

  // 39. 范围 / 分卷导出（v0.5-3）：全书 / 某卷 / 第 X–Y 章，文件名和内容都按范围来（正文在 groups/39-range-export.js）
  await e2eGroups.runGroups(groupContext(), [39]);

  // 40. 继续上次写作 + Ctrl+G 跳章（v0.5-4）（正文在 groups/40-continue-writing.js）
  await e2eGroups.runGroups(groupContext(), [40]);

  // 41. 书目 schemaVersion + 同步冲突副本检测（v0.5-5）（正文在 groups/41-schema-conflict.js）
  await e2eGroups.runGroups(groupContext(), [41]);

  // 42. 本书历史面板（v0.6-1）：统一列出 / 预览 / 还原 _trash 备份（正文在 groups/42-book-history.js）
  await e2eGroups.runGroups(groupContext(), [42]);

  // 43. 可选每日快照（v0.6-2，默认关）：Ctrl+S 时当天首次留上一版，按天数清理（正文在 groups/43-daily-snapshot.js）
  await e2eGroups.runGroups(groupContext(), [43]);

  // 44. 每日字数统计 + 写作目标（v0.6-3，提案 3.2）（正文在 groups/44-stats-goal.js）
  await e2eGroups.runGroups(groupContext(), [44]);

  // 45. 导出 EPUB（v0.7-1）：整本书 → EPUB 3；分卷做目录级、一章一个 XHTML、纯文字封面（正文在 groups/45-export-epub.js）
  await e2eGroups.runGroups(groupContext(), [45]);

  // 46. 校对面板（v0.7-2，提案 5.1）：只报告、不改动；当前章 / 整本都能跑，点一条跳到正文（正文在 groups/46-proofread.js）
  await e2eGroups.runGroups(groupContext(), [46]);

  // 47. 灵感箱（v0.7-3，提案 3.4）：碎片是书架 _碎片 里的普通 txt；插入只改编辑区、不写盘（正文在 groups/47-fragments.js）
  await e2eGroups.runGroups(groupContext(), [47]);

  // 48. 敏感词预检（v0.7-3，提案 5.2）：词表归作者管理、应用不内置词表；只报告、不改动、不写盘（正文在 groups/48-sensitive-words.js）
  await e2eGroups.runGroups(groupContext(), [48]);

  // 49. 朗读本章（v0.7-3，提案 5.3）：系统语音只读正文、不改字、不写盘（正文在 groups/49-tts.js）
  await e2eGroups.runGroups(groupContext(), [49]);

  // 50. 编辑器小件（v0.7-4，提案 4.1）：选中字数 / 超长段落提示 / 不可见字符 ␣ / Alt+↑↓ 段落导航 / 章节字数对比（正文在 groups/50-editor-widgets.js）
  await e2eGroups.runGroups(groupContext(), [50]);

  // 51. 专注模式（提案 3.5）：隐藏左栏与顶栏、F11 / 按钮进出、Esc 退出、打字机模式（正文在 groups/51-focus-mode.js）
  await e2eGroups.runGroups(groupContext(), [51]);

  // 52. 崩溃与错误日志（v0.9 B-7：整段搬到 scripts/e2e/groups/52-crash-logs.js，这里只在原位按组号跑）
  await e2eGroups.runGroups(groupContext(), [52]);
  // 53. 正文全文搜索索引（v0.9 B-7：整段搬到 scripts/e2e/groups/53-search-index.js，这里只在原位按组号跑）
  // 索引只写 userData\search-index.json（不进书库、不含正文），靠每章 mtime/size 增量更新。
  await e2eGroups.runGroups(groupContext(), [53]);

  // 54. 检查更新（v0.9 B-7：整段搬到 scripts/e2e/groups/54-check-update.js，这里只在原位按组号跑）
  //     网络走主进程假响应（update:test-mock）；54h 的「标题统一测试书」由组文件自己造、自己删。
  await e2eGroups.runGroups(groupContext(), [54]);

  // 56. Electron 安全开关与窗口行为（v0.9 C-1；v0.9 B-7：整段搬到 scripts/e2e/groups/56-security-switches.js）
  //     窗口 webPreferences / CSP / 权限拒绝 / 单实例锁都在组文件里复核，这里只在原位按组号跑。
  await e2eGroups.runGroups(groupContext(), [56]);

  // 57. IPC 路径入口审计（v0.9 C-2；v0.9 B-7：整段搬到 scripts/e2e/groups/57-ipc-paths.js）
  //     路径 / 文件名的越界拒绝与「被拒无副作用」都在组文件里复核，这里只在原位按组号跑。
  await e2eGroups.runGroups(groupContext(), [57]);

  // 58. 配置来源校验（v0.9 C-2b，安全审计 C1 的延伸；v0.9 B-7：整段搬到 scripts/e2e/groups/58-config-gate.js）
  //     config:set 的三项磁盘配置只认「主进程对话框刚选中的路径」/ 原值 / 空串，这里只在原位按组号跑。
  await e2eGroups.runGroups(groupContext(), [58]);

  // 59. 导入 / 导出边界（v0.9 C-3；v0.9 B-7：整段搬到 scripts/e2e/groups/59-import-export.js）
  //     EPUB / DOCX 条目名白名单、另存为默认文件名、超大与二进制 txt 的导入边界都在组文件里复核，这里只在原位按组号跑。
  await e2eGroups.runGroups(groupContext(), [59]);

  // 60 起的组（v0.9 B-7）：断言原样拆到 scripts/e2e/groups/，这里只按组号顺序跑；
  // 顺序与原文件一致（60 → 61 → … → 81，之后才是 55 多窗口）。组的上下文与第 52 组同一份。
  // 第 72 组（剪贴板面板）2026-11-07 随面板改单列表视图整组重写，仍由 idsFrom(60) 排在组尾。
  await e2eGroups.runGroups(groupContext(), e2eGroups.idsFrom(60));

  // 55. 多窗口（提案 7.2；v0.9 B-6：整段搬到 scripts/e2e/groups/55-multiwindow.js）
  //     书卡右键「在新窗口打开」/ 禁止同书双开 / 跨窗口删改拦截 / 各自编辑保存 /
  //     关一个窗口不退出、最后窗口关闭才退出 / 各自未保存拦截 / 继续上次写作 /
  //     书架刷新 / 旧书兼容 / 书库无多余文件都在组文件里复核，这里只在原位按组号跑。
  await e2eGroups.runGroups(groupContext(), [55]);

  // 1.6.0 G2：整轮跑完再统一判失败（check 累计失败 + 组级场景异常都进 details），不再第一处就全停。
  const summary = harness.summary();
  return {
    ok: summary.ok,
    checks: checks.length,
    details: checks,
    failures: summary.failures,
    error: summary.ok
      ? undefined
      : `共 ${summary.failed} 项失败：${summary.failures.map((item) => item.name).join(' / ')}`
  };
};
