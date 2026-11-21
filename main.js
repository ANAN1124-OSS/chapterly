// 章回 —— Electron 主进程（版本号见 package.json，界面版本号由 app.getVersion() 回报）
// 职责：窗口与生命周期、关闭拦截、所有文件读写（渲染层零文件系统权限）。
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  dialog,
  shell,
  clipboard,
  globalShortcut,
  screen,
  net,
  powerMonitor,
  // 注意：Electron 的 session 模块与「每个窗口一个会话」的 session 同名，这里别名导入，
  // 避免 main.js 里到处用的窗口 session 变量被遮蔽（createWindow 里就有 const session = ...）
  session: electronSession,
  webContents
} = require('electron');

// ---------- 启动参数（自动化/隔离用，正常用户启动不受影响） ----------
function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

// 打包版判定只算一次（app.isPackaged 在 ready 前也可读）：打包后的正式版一律不认任何自动化开关。
// 生产包带 --e2e 会注册 config:test-pick / font:test-pick / update:test-mock 等自检频道（可把书架
// 指到任意目录、模拟对话框选中路径），以及「不真关窗 / 不退出」的自检行为；开发 / E2E 构建
// （app.isPackaged 为 false）完全不受影响。刻意保留的启动参数：--user-data（隔离配置目录）与
// --books-root（把书架指到临时副本），以及 Chromium 自己的 --remote-debugging-port——安装版冒烟要用。
const packagedApp = app.isPackaged === true;

const isE2E = !packagedApp && process.argv.includes('--e2e');
// 前端基准 / 对比度审计与截图、E2E 共用同一套自动化模式（临时 userData + 临时书库 + ?test=1
// 测试钩子），只换驱动脚本；正常启动路径完全不受影响。
const isBench = !packagedApp && process.argv.includes('--bench');
const isContrast = !packagedApp && process.argv.includes('--contrast');
const booksRootOverride = argValue('books-root');
const screenshotPath = packagedApp ? null : argValue('screenshot');
const screenshotBook = argValue('book');
const screenshotChapter = argValue('chapter');
const screenshotDialog = argValue('dialog');
const automation = isE2E || isBench || isContrast || Boolean(screenshotPath);

const { createConfigStore, sanitize: sanitizeConfig, withBooksRootOverride, WORDLIST_MAX, sameWindowBounds } = require('./core/config');
const { atomicWriteFile, atomicWriteFileStream, cleanupOrphanTmpFiles } = require('./core/atomic');
const storage = require('./core/storage');
const repair = require('./core/repair');
const importer = require('./core/importer');
const exporter = require('./core/exporter');
const chaptersLib = require('./core/chapters');
const formatLib = require('./core/format');
const findLib = require('./core/find');
const proofreadLib = require('./core/proofread');
const jumpLib = require('./core/jump');
const textMenu = require('./core/textmenu');
// 自绘标题栏（1.3.0 T6 / 规范 I-07）：6 套主题的窗口控件色 + 标题栏右键菜单模板（纯数据 / 纯函数）
const windowChrome = require('./core/window-chrome');
const statsLib = require('./core/stats');
const epubLib = require('./core/epub');
const docxLib = require('./core/docx');
const fragmentsLib = require('./core/fragments');
const sensitiveLib = require('./core/sensitive');
const glossaryLib = require('./core/glossary');
const s2tLib = require('./core/s2t');
const ttsLib = require('./core/tts');
const logsLib = require('./core/logs');
// v1.8.2 WP5（N1 / 中 #6）：崩溃草稿仓库（只写 userData）+ 崩溃 / 假死的纯决策（可单测）。
const crashDraftLib = require('./core/crash-draft');
const crashRecovery = require('./core/crash-recovery');
const searchIndexLib = require('./core/search-index');
const updateLib = require('./core/update');
const updateResponseLib = require('./core/update-response');
// 关窗看门狗阈值 + 强制退出顺序（1.6.0 A1 / 审计 E-03）：纯数据 / 纯函数，单测钉住
const closeGuard = require('./core/close-guard');
// v1.8.3 WP9（审计 C1，中 #8）：退出收尾的有界等待（flush 不回来也要退出），纯逻辑单测钉住
const quitFlushGuard = require('./core/quit-flush-guard');
const openBooksLib = require('./core/open-books');
const fontPolicy = require('./core/font-policy');
// E2（审计 #28）：字体文件的同句柄读取（open → fstat → read → close，消除 stat/readFile 的 TOCTOU）
const fontReadLib = require('./core/font-read');
// B9（v1.8.0 WP-29）：字体读取缓存（按 realpath + mtime + size 命中；见 core/font-cache.js）
const { createFontReadCache } = require('./core/font-cache');
const securityPolicy = require('./core/security-policy');
const ipcPaths = require('./core/ipc-paths');
const configGate = require('./core/config-gate');
// 路径等价口径（1.7.2 D4/V43/V83）：bookKeyOf / 词表去重与 core/config-gate、core/config 共用同一份实现
const pathUtils = require('./core/path-utils');
const errorText = require('./core/error-text');
const ipcLimits = require('./core/ipc-limits');
// 撤销删除的进程内凭证（1.5.0 P0-5 / 审计 V-1）：删除成功发一张一次性 token，撤销必须带回来。
// 只在主进程内存里，不落盘、不进 书目.json；10 分钟过期，长于撤销条的 10 秒 TTL。
const ipcRestoreToken = require('./core/ipc-restore-token');
const restoreTokens = ipcRestoreToken.createStore();
const captureLib = require('./core/capture');
// 2026-11-06 捕获队列：后台监听打开后，每次复制在本次运行内各记一条（纯逻辑，只在主进程内存）。
const captureQueueLib = require('./core/capture-queue');
const { createKeyedDebouncer } = require('./core/debounce');
const clipboardWatchLib = require('./core/clipboard-watch');
const { mapLimit, formatCount } = require('./core/common');
// B4（审计 P4）：整本操作逐章读盘的并行度（读是 IO 等待；写盘仍串行、按原顺序）
const CHAPTER_READ_CONCURRENCY = 8;
// P2-2（1.5.0）：整本读正文的批大小，对齐 core/storage.js 的 CHAPTER_BATCH_SIZE（32 章）。
// 批内仍限并发 CHAPTER_READ_CONCURRENCY，批间严格串行 —— 只改「什么时候读」：
// 顺序 / 内容 / 统计口径与「一次读完整个数组」逐字一致，只是不再让整本书的正文同时常驻。
const CHAPTER_BATCH_SIZE = 32;

// V114（v1.8.0 WP-34 / D1）：registerIpc() 按域拆分 —— 导出 / 校对 / 书 CRUD 三块整段搬到
// ipc/*.js，main.js 只做装配（依赖在 buildIpcHost() 里一次性注入）。模块自己不 require electron、
// 不碰模块级状态；缺依赖在装配时直接 TypeError（与渲染层 createX(host) 同一口径，A8）。
const ipcBook = require('./ipc/book');
const ipcBookData = require('./ipc/book-data');
const ipcProofread = require('./ipc/proofread');
const ipcExport = require('./ipc/export');
// 审计修复 #38（▲V306）：书域 mutation 走 ipc/book-mutations.js 的域内常量表（chapter:save 补标记）。
const { MUTATION } = require('./ipc/book-mutations');

// ---------- 启动参数：隔离用的 --user-data ----------
// A2（审计 #8 / E3）：这段从文件顶部（原来的 :31-40）挪到 core 模块 require 之后、app ready 之前。
// 挪下来只为让目录建不出来时能用到 core/error-text 的脱敏文案（下面才 require 进来）；
// 这几十行里没有任何代码读 app.getPath('userData')，路径语义与设置时机都没有变化。
const userDataArg = argValue('user-data');
if (userDataArg) {
  try {
    fsSync.mkdirSync(userDataArg, { recursive: true });
  } catch (err) {
    // 目录建不出来就到此为止：配置 / 日志 / 搜索索引 / 每日快照全写在这个目录里，
    // 带着坏路径继续 setPath 只会表现成「双击没反应」或「设置全丢」。
    failStartup('配置目录', err);
  }
  app.setPath('userData', userDataArg);
} else {
  // 章回：产品从「章节写作器」改名，但数据目录仍沿用旧名 chapter-writer —— 作者既有配置 /
  // 统计 / 日志 / 搜索索引 / 每日快照配置全部零迁移（换名不换数据位置）。
  // 自动化（--user-data）优先，隔离测试不受影响。
  app.setPath('userData', path.join(app.getPath('appData'), 'chapter-writer'));
}

// ---------- 多窗口会话 ----------
// 每个 BrowserWindow 一个会话：独立的 bookPath（登记在 storage 的打开登记表里）、
// 脏状态、关闭状态、进度事件目标。窗口对象、窗口 id、webContents id 三张表互相对应；
// IPC 处理函数用 AsyncLocalStorage 记住「这次调用来自哪个窗口」，弹窗 / 进度事件按窗口路由。
let automationWin = null; // 仅截图 / E2E 驱动用（第一个窗口）；生产逻辑一律按会话路由
const windowSessions = new Map(); // windowId(number) -> session
const webContentsSessions = new Map(); // webContents.id(number) -> session
const ipcFlow = new AsyncLocalStorage();
// E2E：close-ready 回执按窗口记录；isE2E 下默认不真的关窗口，'真实关窗'模式用于多窗口用例
const e2eCloseReadyByWindow = new Map();
let e2eLastCloseReady = undefined;
let e2eRealClose = false;
let e2eWindowAllClosed = false;
// WP-09（C6）：E2E 把「关窗前保存窗口位置」的那次写盘按毫秒拖慢，用来复现「回执已发、
// forceClose 还没置」的竞态窗口（组 10 在延迟里继续输入 → 关窗必须被复查拦下）。
// 只有 --e2e 且显式调 setCloseBoundsDelay 才生效，生产 / 截图流程恒为 0、不额外等。
let e2eCloseBoundsDelayMs = 0;

let configStore = null;
let config = null;
let statsStore = null; // 每日字数统计（userData/stats.json，绝不写书库）
let configWarning = null; // 配置损坏被归档时的提示：启动时只留一份给日志（界面取 store 里的当前值）
// 配置里「指向磁盘」的三项（书架目录 / 两份词表）只认对话框选中的值：
// 按窗口记「刚在系统对话框里选中的路径」，config:set 拿它做来源校验（v0.9 C-2b）。
// 只在内存里，窗口关闭时清掉；不写盘、不跨窗口。
const pickedConfigPaths = configGate.createPickedPathStore();
// B18（v1.8.0 WP-29）：font:pick 选中的字体路径也只记在内存里（按窗口分开），font:read 只认
// 「刚选的这一条」；窗口关闭时与 pickedConfigPaths 一起清。放模块级是因为关窗清理在 createWindow 里。
const pickedFontPaths = new Map(); // windowId -> 本次在对话框里选中的字体路径
// 正常使用时就是 Electron 的系统剪贴板；只有 E2E 在锁屏/无交互桌面环境（系统剪贴板
// 拒绝所有读写）时会临时换成进程内剪贴板，见 scripts/screenshot-driver.js 的 createE2EClipboard()。
let activeClipboard = clipboard;

// ---------- 剪贴板捕获：全局快捷键 ----------
// 只做「读剪贴板 + 通知窗口」；章名拆分、写盘都在渲染层确认后的 capture:commit-record 里完成。
// 捕获必须显式触发（快捷键或界面按钮），不做后台全量记录（剪贴板可能含密码 / 验证码）。
const CAPTURE_ACCELERATOR = 'Control+Alt+V';
let captureShortcutRegistered = false;

async function triggerClipboardCapture() {
  if (!windowSessions.size) return;
  const focused = BrowserWindow.getFocusedWindow();
  const target = (focused && sessionById(focused.id)) || mostRecentSession();
  if (!target || target.win.isDestroyed()) return;
  let text = '';
  try {
    text = String((await activeClipboard.readText()) || '');
  } catch (err) {
    logError('capture-clipboard', err, { level: 'warn' });
  }
  // 2026-11-06（捕获队列）：按快捷键前刚复制的那段也要立刻入队（不等 900ms 轮询），
  // 否则面板里会少掉「刚复制的这一条」。判定与轮询同一套规则，重复调用是幂等的。
  if (clipboardWatchEnabledNow()) {
    const decision = clipboardWatcher.evaluate(text);
    if (decision.record) captureQueue.add(text);
  }
  const queued = captureQueue.hasText(text);
  focusSession(target);
  sendToSession(target, 'capture:triggered', { text, accelerator: CAPTURE_ACCELERATOR, queued });
}

function registerCaptureShortcut() {
  // 自动化（E2E / 截图）不抢系统热键，免得和桌面上的其它程序冲突
  if (automation) return;
  try {
    captureShortcutRegistered = globalShortcut.register(CAPTURE_ACCELERATOR, () => {
      void triggerClipboardCapture();
    });
  } catch (err) {
    captureShortcutRegistered = false;
    logError('capture-shortcut', err, { level: 'warn' });
  }
  if (!captureShortcutRegistered) {
    logError(
      'capture-shortcut',
      new Error(`全局快捷键 ${CAPTURE_ACCELERATOR} 注册失败（可能被其它程序占用）；界面上的「捕获」按钮仍可用`),
      { level: 'warn' }
    );
  }
}

// 五-M32（PM-3）：系统睡眠 / 唤醒广播给渲染层。写作计时按墙钟差累计，睡眠数小时会被整段算进
// 「写作时长」（派生统计，不碰正文 / 保存）。主进程只如实通知，冻结 / 续算由渲染层的秒表决定
// （手动暂停中的计时器不会被自动拉起）。powerMonitor 在部分平台 / 无桌面会话时不发事件，忽略即可。
function setupPowerMonitor() {
  try {
    powerMonitor.on('suspend', () => broadcast('power:suspend', {}));
    powerMonitor.on('resume', () => broadcast('power:resume', {}));
  } catch (err) {
    logError('power-monitor', err, { level: 'warn' });
  }
}

// ---------- b8（剪贴板联动）：后台监听 + 轻提示 ----------
// 只有作者在设置里打开 clipboardWatchEnabled 才轮询；发现「新复制的一段文字」（变化 / 非空白）
// 就记进捕获队列（每次复制一条，短文本也记），≥20 字且过冷却才通过 clipboard:changed 给一条可点提示。
// 隐私红线：只把派生信息（字数 / 条数）发给渲染层；正文用完即弃，不写日志、不落盘、不做历史。
// 生命周期跟随应用：启动时按配置启动，配置切换时启停，will-quit 清定时器。
// 2026-11-07：900ms 太稀，连续快速复制会漏拍；缩到 300ms（每拍只读一次纯文本，开销可忽略）。
const CLIPBOARD_WATCH_INTERVAL_MS = 300;
const clipboardWatcher = clipboardWatchLib.createWatcher();
// CTXT-B-02（审计）：30 万字级的大文本躺在剪贴板时，300ms 全文读 + 哈希会持续占用主进程。
// 长度 ≥30 万且与上一拍相同 → 降频（约每 3 秒读一次）；长度一变立即恢复逐拍读。
const clipboardPacer = clipboardWatchLib.createLargeTextPacer();
// 2026-11-06（捕获队列）：开关打开后每次复制各记一条，逐条捕获、各自成章。
// 只驻主进程内存：不落盘、不写日志；关闭监听 / 退出应用即清空（隐私口径见 README）。
const captureQueue = captureQueueLib.createCaptureQueue();
let clipboardWatchTimer = null;
// 仅 automation（E2E）：工作站锁屏 / 无交互桌面时 Windows 会拒绝 clipboard.readText()（恒空），
// 和现有「复制整本 / 复制本章」E2E 的进程内剪贴板兜底是同一个已知限制。E2E 用 clipboard:test-set
// 注入一份文本代替真实读盘；生产路径（automation=false）永远走 clipboard.readText()。
let clipboardWatchTestText = null;

function clipboardWatchEnabledNow() {
  return Boolean(config && config.clipboardWatchEnabled === true);
}

// Electron 45 起 clipboard.readText() 返回 Promise（自动化注入除外），所以这里统一 await；
// 读不到（远程桌面 / 锁屏）就当空串跳过这一拍，不影响其它功能。
async function readClipboardForWatch() {
  if (automation && clipboardWatchTestText != null) return clipboardWatchTestText;
  try {
    return String((await clipboard.readText()) || '');
  } catch {
    return ''; // 剪贴板暂时不可用（远程桌面 / 锁屏）就跳过这一拍
  }
}

// 轮询：上一拍还没读完（异步读剪贴板）就跳过，避免叠拍把「同一次变化」算两遍。
let clipboardWatchBusy = false;
// 刚打开监听时先异步读一次「当前剪贴板」当基线；读完之前不记录、不提示。
let clipboardWatchPriming = false;

async function pollClipboardWatch() {
  if (clipboardWatchPriming || clipboardWatchBusy) return;
  // CTXT-B-02：大文本没换长度时，这几拍不读剪贴板（读取本身也会分配整串副本）。
  if (clipboardPacer.shouldSkip()) return;
  clipboardWatchBusy = true;
  // V39（审计）：记下这一拍的启动 token；读数在飞时被 stop→start 跨过，返回后整拍作废。
  const watchToken = clipboardWatcher.token();
  try {
    const text = await readClipboardForWatch();
    clipboardPacer.observe(text.length);
    const decision = clipboardWatcher.evaluate(text, watchToken);
    // 记录与提示拆开：连续复制的几段都要各留一条（record），冷却只压轻提示（notify）。
    if (decision.record) {
      const added = captureQueue.add(text);
      // 单条超限（字数 > 30 万 / 原文 > 队列总量）：以前是静默丢，作者只会看到「面板刷新了但没东西」。
      // 现在借一次 notify 的机会把原因说清楚（仍只发数字，不发正文）；冷却期内不重复打扰。
      if (!added.added && added.reason === 'too-large') {
        if (decision.notify) {
          const tooLargePayload = { tooLarge: true, chars: added.chars, queued: captureQueue.size() };
          broadcast('clipboard:changed', tooLargePayload);
        }
        return;
      }
      // 面板开着时「新复制立刻出现在列表里」：每次记录都发一个不含正文的轻量事件。
      // 短复制（<20 字）不走下面的 notify，靠这个事件刷新列表，否则复制了也看不见。
      const recordedPayload = { queued: captureQueue.size() };
      broadcast('clipboard:recorded', recordedPayload);
    }
    if (!decision.notify) return;
    // 只发字数字段（不发正文）；queued 是「本次运行已记几条」的计数，也不含正文。
    const payload = { chars: decision.chars, queued: captureQueue.size() };
    broadcast('clipboard:changed', payload);
  } finally {
    // 旧拍子不许把新一拍的「在飞」标记放掉（token 变了说明这拍已作废）。
    if (watchToken === clipboardWatcher.token()) clipboardWatchBusy = false;
  }
}

// 打开面板前补一拍（2026-11-07）：作者刚复制就点「捕获」时，可能正好落在两拍轮询之间；
// 打开面板前主动读一次剪贴板，把这一条补进队列。不发送轻提示（面板马上要开了）。
async function flushClipboardWatchOnce() {
  if (!clipboardWatchEnabledNow()) return { enabled: false, recorded: false };
  if (clipboardWatchPriming || clipboardWatchBusy) return { enabled: true, recorded: false, busy: true };
  clipboardWatchBusy = true;
  const watchToken = clipboardWatcher.token();
  try {
    const text = await readClipboardForWatch();
    const decision = clipboardWatcher.evaluate(text, watchToken);
    if (decision.record) captureQueue.add(text);
    return { enabled: true, recorded: Boolean(decision.record), chars: decision.chars };
  } catch {
    return { enabled: true, recorded: false };
  } finally {
    if (watchToken === clipboardWatcher.token()) clipboardWatchBusy = false;
  }
}

function stopClipboardWatch() {
  if (clipboardWatchTimer) {
    clearInterval(clipboardWatchTimer);
    clipboardWatchTimer = null;
  }
  clipboardWatchPriming = false;
  clipboardWatchBusy = false;
  clipboardPacer.reset();
  clipboardWatcher.disable();
  // 关掉监听 = 不再看剪贴板：本次运行的捕获队列一并清空（隐私口径，不留内存残影）。
  captureQueue.clear();
}

// 按当前配置启停（幂等）：config:set / 启动时调用。
// 打开监听那一刻剪贴板里已有的内容不算「新复制」：先异步读一次当基线，读完之前不记录。
function syncClipboardWatch() {
  if (!clipboardWatchEnabledNow()) {
    stopClipboardWatch();
    return;
  }
  if (clipboardWatchTimer) return;
  clipboardWatchPriming = true;
  clipboardWatcher.enable('');
  const primingToken = clipboardWatcher.token();
  clipboardWatchTimer = setInterval(pollClipboardWatch, CLIPBOARD_WATCH_INTERVAL_MS);
  if (clipboardWatchTimer.unref) clipboardWatchTimer.unref();
  void readClipboardForWatch().then(
    (text) => {
      // 读完之前被关掉：别再动基线；V39：期间又 stop→start 过（token 变了）也作废，别拿旧内容当新基线。
      if (!clipboardWatchTimer || primingToken !== clipboardWatcher.token()) return;
      clipboardWatcher.enable(text);
      clipboardWatchPriming = false;
    },
    () => {
      clipboardWatchPriming = false;
    }
  );
}

// ---------- 窗口会话工具 ----------
function createSession(browserWin) {
  const session = {
    id: browserWin.id,
    win: browserWin,
    dirty: false,
    // C5（审计 E5/S5）：关窗放行不再单方信任渲染层的 allowed——
    //   dirtyAt   = 这次「变成有未保存修改」的时间（渲染层上报）；
    //   lastSaveAt = 主进程最近一次「章节正文保存成功」的时间（chapter:save 回执）。
    // 只有「渲染层说不脏」或「主进程看到保存回执晚于变脏时间」才放行关窗。
    dirtyAt: 0,
    lastSaveAt: 0,
    closePending: false,
    closeTimer: null,
    forceClose: false,
    boundsTimer: null,
    e2eCloseReady: undefined,
    // 这个窗口当前打开的是哪本书（book:get-display / book:set-display 带过来的书 id）。
    // 只用于算「窗口控件色该跟哪套纸色走」——这本书设过按书覆盖就用它，否则用全局主题。
    bookId: ''
  };
  windowSessions.set(session.id, session);
  webContentsSessions.set(browserWin.webContents.id, session);
  try {
    storage.openBookRegistry.registerWindow(session.id);
  } catch {
    /* 登记失败也不影响开窗口；跨窗口检查会退化成「没有开着的书」 */
  }
  return session;
}

function sessionOfSender(event) {
  if (!event || !event.sender) return null;
  return webContentsSessions.get(event.sender.id) || null;
}

function sessionById(windowId) {
  const id = Number(windowId);
  if (!Number.isFinite(id)) return null;
  const session = windowSessions.get(id);
  return session && !session.win.isDestroyed() ? session : null;
}

function flowSession() {
  const store = ipcFlow.getStore();
  if (!store) return null;
  return sessionById(store.windowId);
}

function mostRecentSession() {
  const recentId = storage.openBookRegistry.mostRecentWindow();
  const recent = recentId ? sessionById(recentId) : null;
  if (recent) return recent;
  // 兜底：登记表异常时取最后创建且还活着的窗口
  let last = null;
  for (const session of windowSessions.values()) {
    if (!session.win.isDestroyed()) last = session;
  }
  return last;
}

// 当前 IPC 调用所属窗口；没有上下文（主进程内部触发）时退回最近使用的窗口
function liveSession() {
  return flowSession() || mostRecentSession();
}

function webContentsAlive(session) {
  return Boolean(
    session &&
      !session.win.isDestroyed() &&
      session.win.webContents &&
      !session.win.webContents.isDestroyed()
  );
}

function sendToSession(session, channel, payload) {
  if (!webContentsAlive(session)) return false;
  try {
    session.win.webContents.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}

function sendToFlow(channel, payload) {
  const session = liveSession();
  if (session) return sendToSession(session, channel, payload);
  return false;
}

// 逐窗口单发通知的唯一实现（try/catch 单发互不影响）。剪贴板监听三处提示 / 记录事件也走这里
// （审计 A1：原先各写一遍「遍历 windowSessions + try/catch」，发送策略改动要同步三处、易漂移）。
function broadcast(channel, payload, { except = null } = {}) {
  const skip = except == null ? null : String(except);
  for (const session of windowSessions.values()) {
    if (skip && String(session.id) === skip) continue;
    sendToSession(session, channel, payload);
  }
}

function focusSession(session) {
  if (!session || session.win.isDestroyed()) return false;
  try {
    if (session.win.isMinimized()) session.win.restore();
    session.win.show();
    session.win.focus();
    if (session.win.flashFrame) session.win.flashFrame(true);
    storage.openBookRegistry.touch(session.id);
    return true;
  } catch {
    return false;
  }
}

// 系统对话框的父窗口：发起这次 IPC 的窗口；没有就退回最近使用的窗口
function dialogParent() {
  const session = liveSession();
  if (session && !session.win.isDestroyed()) return session.win;
  return null;
}

function showOpenDialog(options) {
  const parent = dialogParent();
  return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options);
}

function showSaveDialog(options) {
  const parent = dialogParent();
  return parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options);
}

function showMessageBox(options, parent = dialogParent()) {
  return parent && !parent.isDestroyed()
    ? dialog.showMessageBox(parent, options)
    : dialog.showMessageBox(options);
}

// 书架数据变了：其它窗口若正停在书架就刷新；在写作页的窗口回书架时会自己刷新。
// B2（WP18 / 审计中 #18）：带上这次变更的 bookPath —— 停在书架的窗口只按这一张书卡增量刷新
// （books:card，O(1)），不再为一次 Ctrl+S 整表 books:list 逐书 readBookMeta。
// bookPath 为 null = 结构性变更（多本导入等）：渲染层照旧整表刷新。
function notifyShelfChanged(session, reason = '', bookPath = null) {
  const changed = typeof bookPath === 'string' && bookPath ? bookPath : null;
  broadcast('shelf:changed', { reason, bookPath: changed }, { except: session ? session.id : null });
}

// 只保存「最近使用的窗口」的位置 / 大小（下次启动按它恢复）
// V89（1.7.2 D6）：除四个标量外再记「退出时是不是最大化」。只存 getBounds() 的话，最大化状态
// 在重启后变成「铺满工作区但没最大化」——双击标题栏 / 顶栏右键菜单看到的是「最大化」而不是「还原」。
// 变更面只有 windowBounds 里这一个子键（不新增顶层配置字段；清洗见 core/config.js）。
async function saveRecentWindowBounds(session) {
  if (!session || session.win.isDestroyed()) return false;
  const recentId = storage.openBookRegistry.mostRecentWindow();
  if (recentId && String(recentId) !== String(session.id) && windowSessions.size > 1) return false;
  try {
    // WP-09（C6）：自检把这次写盘拖慢，复现「关窗回执已发、forceClose 还没置」的 await 窗口；
    // 生产路径 isE2E=false，这段永远不进，关窗耗时与改动前一致。
    if (isE2E && e2eCloseBoundsDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, e2eCloseBoundsDelayMs));
      if (session.win.isDestroyed()) return false;
    }
    // C7（审计 C7）：窗口位置是自动写——读失败期间不许落盘（否则 resize 防抖写会把真配置换成默认值）。
    // V103（v1.8.0 WP-26）：用 getNormalBounds() 而不是 getBounds()。最大化时 getBounds() 返回的是
    // 最大化矩形，存下来再重启、取消最大化后窗口就永远停在工作区大小（每次都要手动调）。
    // 普通 / 最小化状态下两者一致；最大化只额外记 maximized 标志，恢复由 createWindow 补 maximize()。
    const normal = session.win.getNormalBounds();
    const nextBounds = { ...normal, maximized: session.win.isMaximized() };
    // B10（v1.8.0 WP-29）：只写「变了的 5 个标量」。拖动 / 最大化切换会连发 resize + move，
    // 防抖结束时的几何常常与磁盘上已经记的一样（例如最大化后再还原）；这种时候再写一遍整份
    // config.json 没有意义。判据取「配置当前值」（内存缓存，一次 clone）而不是窗口自己的记忆 ——
    // 多窗口下另一个窗口可能刚写过同一份字段，按磁盘现状比才不会被上一手的旧值误导。
    const current = await configStore.get();
    if (sameWindowBounds(current.windowBounds, nextBounds)) return true;
    // A4（审计）：普通态几何 + 最大化标志只构造一次；比对与写盘复用同一份 nextBounds，
    // 避免写盘处再展开一次对象（发送策略 / 字段增删都只改一处）。
    await configStore.set({ windowBounds: nextBounds }, { auto: true });
    return true;
  } catch {
    return false;
  }
}


// A2（审计 #8 / E3）：启动期「必须当场停」的失败出口 —— 一行可读说明写 stderr，然后退出。
// 刻意不走 logError：出问题的往往正是 userData 目录（日志也写在里面），往坏目录里再写一次
// 只会再失败一次；此时界面也还没起来，能用的只有 stderr。
// 文案只留错误码 + 脱敏后的一句话（error-text 会把绝对路径压成最后一节），
// 不打原始堆栈、不打印完整路径。
function failStartup(what, err) {
  const where = what || '启动';
  let line = `[chapterly] ${where}初始化失败，程序退出\n`;
  try {
    const described = errorText.describeForUi(err);
    line = `[chapterly] ${where}初始化失败，程序退出（${described.code}）：${described.message}\n`;
  } catch {
    /* 连错误都描述不出来就退回上面那句兜底文案 */
  }
  try {
    process.stderr.write(line);
  } catch {
    /* 从资源管理器双击启动时没有控制台，stderr 可能不可写：忽略 */
  }
  app.exit(1);
}

// ---------- 崩溃 / 错误日志（提案 7.4） ----------
// 只记元数据（时间 / 类型 / 级别 / 错误码 / IPC 频道 / message / 栈 / pid / 版本），绝不传正文；
// 格式里还有 `path` 字段，但当前没有任何调用方填它（v0.9 C-4 审计结论），别把「日志记了路径」当既有行为。
// 日志写不进去只吞掉，绝不能影响正文保存、界面和退出（实现在 core/logs.js，单测覆盖）。
let logStore = null;

function getLogStore() {
  if (!logStore) {
    try {
      logStore = logsLib.createLogStore(app.getPath('userData'));
    } catch {
      logStore = null; // 连路径都拿不到：静默降级，不影响应用
    }
  }
  return logStore;
}

// 记一条错误日志（不 await：主流程不能等日志落盘）。extra 里只允许元数据字段。
function logError(kind, err, extra = {}) {
  try {
    const store = getLogStore();
    if (!store) return;
    const described = logsLib.describeError(err);
    let version = '';
    try { version = app.getVersion(); } catch { version = ''; }
    store.write({
      level: extra.level || 'error',
      kind,
      code: extra.code != null ? extra.code : described.code,
      channel: extra.channel,
      path: extra.path,
      message: extra.message != null ? extra.message : described.message,
      stack: described.stack,
      pid: process.pid,
      app: version
    });
  } catch {
    /* 日志本身永远不能影响应用 */
  }
}

// 审计修复 #32（▲V305）：core/storage 的「书目重复章节 id 已按位置重新分配」要留一条诊断日志，
// 但 core 模块不持有日志 store —— 启动时把现成的 logError 注入一次（写不进去只吞掉，绝不影响读书目）。
storage.setDiagnostics({ logError });

// ---------- 渲染崩溃恢复（v1.8.2 WP5 / 审计 N1，中 #6；作者拍板项 1=B） ----------
// 三件事：① render-process-gone 自动 reload（重载环用 60 秒保护窗 + 对话框出口）；
// ② unresponsive 给「继续等待 / 强制重载」出口；③ 可选崩溃草稿（默认关、设置可开）。
// 草稿只写 userData\crash-drafts（core/crash-draft.js），绝不写书库；开关没开时一个字节都不写：
// syncCrashDraftSession 只在 crashDraftEnabled === true 时 beginSession，save 频道也先看开关。
let crashDraftStore = null;
let crashSessionStarted = false;
let crashPreviousAbnormal = false;
let appQuitting = false;

function getCrashDraftStore() {
  if (!crashDraftStore) {
    try {
      crashDraftStore = crashDraftLib.createCrashDraftStore(app.getPath('userData'));
    } catch {
      crashDraftStore = null; // 连 userData 都拿不到：静默降级，不影响写作
    }
  }
  return crashDraftStore;
}

// 按配置开 / 关崩溃草稿会话（幂等）：开 → 写运行标记并读上次是否异常退出；关 → 清标记 + 草稿。
// 开关默认关，所以默认启动路径这里什么都不写。
async function syncCrashDraftSession() {
  const store = getCrashDraftStore();
  if (!store) return null;
  let cfg;
  try {
    cfg = await getConfig();
  } catch {
    return null;
  }
  const enabled = cfg && cfg.crashDraftEnabled === true;
  if (enabled && !crashSessionStarted) {
    const started = await store.beginSession();
    crashSessionStarted = Boolean(started && started.ok);
    crashPreviousAbnormal = Boolean(started && started.abnormal);
  } else if (!enabled && crashSessionStarted) {
    await store.endSession();
    crashSessionStarted = false;
    crashPreviousAbnormal = false;
  }
  return { enabled, started: crashSessionStarted, abnormal: crashPreviousAbnormal };
}

// 干净退出：删运行标记 + 全部草稿（尽力而为，不抛、不影响退出）。
async function endCrashDraftSession() {
  const store = getCrashDraftStore();
  if (!store) return { ok: true, cleared: 0 };
  crashSessionStarted = false;
  crashPreviousAbnormal = false;
  try {
    return await store.endSession();
  } catch {
    return { ok: false, cleared: 0 };
  }
}

// 崩溃对话框里的「打开日志文件夹」：与设置里同一个入口，E2E 不乱弹资源管理器。
async function openLogFolderForRecovery() {
  const store = getLogStore();
  if (!store) return;
  try {
    await fs.mkdir(store.dir, { recursive: true });
    if (!isE2E) await shell.openPath(store.dir);
  } catch {
    /* 打不开日志文件夹不影响恢复出口 */
  }
}

// 配置里「指向磁盘」的项被来源不明地改动时记一条 info 日志：
// 只记字段名 —— 绝不记路径值，也不把任何路径回给渲染层（日志里没有本机目录）。
function logRejectedConfigPaths(fields) {
  if (!Array.isArray(fields) || !fields.length) return;
  try {
    logError(
      'config-rejected-path',
      {
        code: 'BAD_CONFIG_SOURCE',
        message: `已忽略来源不明的配置项：${fields.join('、')}（设置里请用「选择…」按钮挑）`
      },
      { level: 'info' }
    );
  } catch {
    /* 日志失败不影响设置保存 */
  }
}

// 记住「这个窗口刚在系统对话框里选中的路径」；没有窗口上下文就忽略（不写盘）。
function rememberPickedConfigPath(field, value) {
  const session = flowSession();
  if (!session) return;
  pickedConfigPaths.remember(session.id, field, value);
}

// 给作者看的固定提示（不把错误细节 / 任何正文塞进界面）
const INTERNAL_ERROR_TEXT = {
  uncaughtException:
    '程序遇到一个内部错误，已写进日志。建议先按 Ctrl+S 保存，再重启应用（设置 → 诊断日志里可以打开日志文件夹）。',
  unhandledRejection:
    '程序有一项后台操作失败了，已写进日志。写作和保存不受影响；如果反复出现，可在设置 → 诊断日志里查看。'
};

function notifyInternalError(kind, err) {
  try {
    const described = logsLib.describeError(err);
    // B2（审计 #16 / S5）：终端 / 日志采集侧也只打脱敏文案——与 fail() 同一口径
    // （本机绝对路径只留最后一节、控制字符收掉）。日志侧仍走 logError 的原始 message
    // （core/logs.js 的 sanitizeEntry 负责遮罩），界面广播仍只用下面的固定文案。
    const shown = errorText.describeForUi(err);
    console.error(`[${kind}]`, shown.code || '', shown.message);
    logError(kind, err);
    // 所有窗口都提示一句固定文案（哪个窗口都可能正开着稿子）
    broadcast('app:internal-error', {
      kind,
      code: described.code || '',
      message: INTERNAL_ERROR_TEXT[kind] || INTERNAL_ERROR_TEXT.uncaughtException,
      time: new Date().toISOString()
    });
  } catch {
    /* 处理错误时再抛错就真没救了：吞掉 */
  }
}

// B1（审计 E2 / E6）：渲染层上报「后台失败」时认的 kind 白名单。
// 渲染层不开放 DevTools，没被 catch 的 Promise 拒绝只写 console 等于没写，所以由这个通道落一条诊断日志；
// 白名单让日志里的 kind 只有这几种（拼错 / 注入都进不去），其余字段由 core/error-text 统一脱敏。
// REDT-A-01（第五轮审计）：uncaught-error = 渲染层 window 'error'（同步异常）的留痕种类。
const RENDERER_FAILURE_KINDS = new Set(['unhandledrejection', 'uncaught-error', 'ui-chain']);

// 主进程崩溃 / 未处理的 Promise：写日志 + 通知界面，进程不退出（作者可能还有没保存的稿子，
// 至少让他先 Ctrl+S 再重启）。日志失败也只影响日志。
process.on('uncaughtException', (err) => notifyInternalError('uncaughtException', err));
process.on('unhandledRejection', (reason) => notifyInternalError('unhandledRejection', reason));

function logStartup() {
  try {
    const store = getLogStore();
    if (!store) return;
    let version = '';
    try { version = app.getVersion(); } catch { version = ''; }
    store.write({
      level: 'info',
      kind: 'app-start',
      message: `启动：v${version || '?'}（${process.platform} ${process.arch}，Electron ${process.versions.electron || '?'}，pid ${process.pid}）`,
      pid: process.pid,
      app: version
    });
  } catch {
    /* 忽略 */
  }
}

// ---------- 正文全文搜索索引（提案 7.3） ----------
// 索引文件只在 userData（不进书库、不改正文）；建索引 / 校验都是异步的，渲染层只拿搜索结果。
let searchIndexStore = null;
let searchProgressAt = 0;

function getSearchIndexStore() {
  if (!searchIndexStore) {
    searchIndexStore = searchIndexLib.createSearchStore({ userDataDir: app.getPath('userData') });
  }
  return searchIndexStore;
}

function sendSearchProgress(info) {
  const session = liveSession();
  if (!session) return;
  const now = Date.now();
  // 进度事件很密：除「完成」外 120ms 合并一次（渲染层只需要大致进度）
  if (info && info.phase !== 'done' && now - searchProgressAt < 120) return;
  searchProgressAt = now;
  try {
    sendToSession(session, 'search:progress', info);
  } catch {
    /* 进度事件丢了不影响建索引 */
  }
}

// ---------- 自动更新轻量版（提案 7.1） ----------
// 只在作者点「检查更新」时访问一次 GitHub Release API，用 Electron 内置 net.fetch；
// 不下载、不安装、不写配置、不写书库。网络失败 / 超时由 core/update 转成一句提示，绝不抛错。
// E2E / 截图自检可以注入假网络（update:test-mock 只在 automation 下注册），不会真连 GitHub。
let updateMock = null;
let lastUpdateLaunch = null;
// 1.6.0 H5（审计 S-02）：in-flight 单飞 —— 连点「检查更新」只发一次请求（GitHub 限流按 IP 算）。
const updateCheckSingleFlight = updateResponseLib.createSingleFlight();

async function fetchReleaseResponse({ url, timeoutMs }) {
  if (automation && updateMock) {
    const mock = updateMock;
    if (mock.type === 'network-error') {
      throw Object.assign(new Error('mock network error'), { code: 'ENOTFOUND' });
    }
    if (mock.type === 'timeout') {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    }
    if (mock.type === 'http') {
      return {
        status: Number(mock.status) || 500,
        text: typeof mock.text === 'string' ? mock.text : ''
      };
    }
    return { status: 200, text: JSON.stringify(mock.body == null ? {} : mock.body) };
  }
  const controller = new AbortController();
  const waitMs = Math.max(1500, Math.min(30000, Number(timeoutMs) || updateLib.DEFAULT_TIMEOUT_MS));
  const timer = setTimeout(() => controller.abort(), waitMs);
  try {
    const res = await net.fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `chapterly/${app.getVersion()}`
      },
      // C6（审计 S7）：更新检查只接受直连——不跟随重定向（URL 是硬编码的 GitHub API，
      // 正常不会跳转；跟随便等于把请求交给响应方指定的新地址）。
      redirect: 'error',
      signal: controller.signal
    });
    const length = Number(res.headers.get('content-length') || 0);
    if (length > updateLib.MAX_RESPONSE_CHARS) return { status: res.status, text: '', tooLarge: true };
    // 没有 content-length（或头不可信）时走**流式限长读**：1 MB 处停下并 cancel，
    // 不再 res.text() 整包读进内存（S-02）。正常小响应读回来的文本与旧实现逐字一致。
    const limited = await updateResponseLib.readResponseTextLimited(res, updateLib.MAX_RESPONSE_CHARS);
    return { status: res.status, text: limited.text, tooLarge: limited.tooLarge };
  } finally {
    clearTimeout(timer);
  }
}

function ok(data) {
  return { ok: true, data };
}

// IPC 失败统一出口（v0.9 C-4，安全审计 C5）：
// 回给界面的文案先过 core/error-text.js —— 本机绝对路径只留最后一节、常见文件系统错误码换成中文、
// 控制字符与超长文本收掉；原始错误对象仍交给 logError 写进本机日志（日志侧同样只留文件名）。
// 错误码（code）原样保留：界面与 E2E 都按 code 分支，不受文案影响。
function fail(err, channel) {
  const described = errorText.describeForUi(err);
  console.error('[ipc-fail]', channel ? `${channel}:` : '', described.code, described.message);
  // 保存失败单独记一条（错误码 + 章节文件名，绝不含正文）
  logError(channel === 'chapter:save' ? 'save-failed' : 'ipc-error', err, { channel });
  // 白名单透传（A7 / E-N6 / M-N1）：部分成功字段 + 正文落盘后的 mtime（META_SAVE_FAILED 与
  // META_CHANGED 都要后者；0 是 force 哨兵，坏回包不采用）。
  if (described.code === 'META_SAVE_FAILED' && err && err.bodySaved === true) {
    const partial = { ok: false, code: described.code, message: described.message, bodySaved: true };
    if (Number.isFinite(Number(err.chars))) partial.chars = Math.max(0, Math.round(Number(err.chars)));
    if (Number.isFinite(Number(err.mtimeMs))) partial.mtimeMs = Number(err.mtimeMs);
    if (typeof err.file === 'string') partial.file = err.file;
    return partial;
  }
  if (described.code === 'META_CHANGED' && Number.isFinite(Number(err && err.mtimeMs)) && Number(err.mtimeMs) > 0) {
    return { ok: false, code: described.code, message: described.message, mtimeMs: Number(err.mtimeMs) };
  }
  return { ok: false, code: described.code, message: described.message };
}

// 只接受来自本应用管理的窗口的 IPC（防止将来引入 webview / 远程内容后越权）：
// 判定在 handle() 里做（sessionOfSender(event) 为空就回 BAD_SENDER），
// 以前那个单独包一层 Boolean() 的 isTrustedSender() 没有任何调用点，v0.9 B-4 删掉了。
function runInWindowFlow(session, fn) {
  return ipcFlow.run({ windowId: session.id }, fn);
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    const session = sessionOfSender(event);
    if (!session) return fail(Object.assign(new Error('不可信的调用来源'), { code: 'BAD_SENDER' }), channel);
    return runInWindowFlow(session, async () => {
      try {
        return ok(await fn(...args));
      } catch (err) {
        return fail(err, channel);
      }
    });
  });
}

// 书架相关的 IPC：第一个参数必须是「书架目录的直接子目录」，
// 渲染层理论上不会传别的路径，但加一层校验，越权/手误都读不到书架以外的文件。
// 校验本身搬到 core/ipc-paths.js（纯逻辑，单测覆盖 `..` / 绝对路径 / 孙目录 / 空串），
// 这里的名字保持不变：handleBook 与 window:open-book 照旧调用它（book:delete 另有一处
// 自己的再校验，文案更具体：「只能删除书架目录下的书」）。
const assertBookPath = ipcPaths.assertBookPath;

// 文本类 IPC 的前置校验（v0.9 C-5）：正文必须是字符串，且不超过 core/ipc-limits.js 的
// MAX_TEXT_CHARS（500 万字）。排版 / 查找 / 替换 / 校对 / 朗读都是 O(n) 甚至 O(n × 词表) 的计算，
// 在入口先挡住超大输入，免得渲染层一次手误 / 注入就把主进程拖到假死；超限回 TEXT_TOO_LARGE。
const assertText = ipcLimits.assertText;

// 正文搜索「聚焦一章」（P22-4）：renderer 用书架正文命中行里的 bookPath + chapterFile 请求该章全部命中。
// 这里只做入口形状收口（只收两个字符串字段、各限 260 字，其它字段一律丢掉）；「是不是索引里的书 / 章、
// 归一化后是否还在书架目录下」由 core/search-index.js 统一校验，绝不拿调用方给的路径直接读盘。
// 不新增 IPC 通道，preload 白名单与 options 之外的调用形态都不变。
const MAX_SEARCH_FOCUS_CHARS = 260;
function sanitizeSearchFocus(focus) {
  if (!focus || typeof focus !== 'object' || Array.isArray(focus)) return null;
  const bookPath = typeof focus.bookPath === 'string' ? focus.bookPath.trim() : '';
  const chapterFile = typeof focus.chapterFile === 'string' ? focus.chapterFile : '';
  if (!bookPath || !chapterFile) return null;
  if (bookPath.length > MAX_SEARCH_FOCUS_CHARS || chapterFile.length > MAX_SEARCH_FOCUS_CHARS) return null;
  return { bookPath, chapterFile };
}

// mutation：写书的操作（save / delete / rename / format / replace / write）。
// 有值时统一做跨窗口拦截：别的窗口正开着这本书 → 拒绝并提示先关 / 先切过去。
function handleBook(channel, fn, { mutation = null } = {}) {
  ipcMain.handle(channel, async (event, bookPath, ...args) => {
    const session = sessionOfSender(event);
    if (!session) return fail(Object.assign(new Error('不可信的调用来源'), { code: 'BAD_SENDER' }), channel);
    return runInWindowFlow(session, async () => {
      try {
        const cfg = await getConfig();
        const target = assertBookPath(bookPath, cfg.booksRoot);
        if (mutation) storage.assertBookNotBusy(target, session.id, mutation);
        const result = await fn(target, ...args);
        // 书架数据可能变了（字数 / 章节 / 书名）：其它窗口的书架跟着刷新。
        // B2（WP18）：带上 target —— 单本书的变更只让书架重读那一张卡；删除（target 已不在）由渲染层删卡。
        if (mutation && channel !== 'book:set-last') notifyShelfChanged(session, channel, target);
        return ok(result);
      } catch (err) {
        return fail(err, channel);
      }
    });
  });
}

// A3（审计 #9 / O1）：booksRootOverride 的唯一装饰层 —— 任何从配置仓库拿回来的 config 都先过这里再缓存。
// 这条口径决定 assertBookPath 认哪个根目录：以前 8 处配置写入口各抄一份同形覆盖，新增写入口漏写一处
// 就会出现「界面显示 A、路径校验按 B」的漂移。打包版刻意保留 --books-root（安装版冒烟把书架指到临时
// 副本用，见文件顶部「刻意保留的启动参数」），但覆盖只在这一个函数里发生。
function decorateConfig(raw) {
  return withBooksRootOverride(raw, booksRootOverride);
}

// 配置缓存的唯一写入口：配置仓库写完之后要更新内存里的 config，一律走这里（装饰层不会被绕过）。
function applyConfig(raw) {
  config = decorateConfig(raw);
  // 换主题 / 改按书覆盖后，各窗口标题栏（系统按钮区）的底色与字形色跟着重刷一次
  applyWindowChromeAll();
  return config;
}

// ---------- 自绘标题栏（1.3.0 T6 / 规范 I-07） ----------
// 窗口控件区（Windows 画的最小化 / 最大化 / 关闭）底色 + 字形色：跟着「这个窗口当前生效的纸色」走。
// 生效纸色 = 这本书的 bookDisplay 覆盖（设过才用）?? 全局 config.editorPaper。
// 书 id 由渲染层在 book:get-display / book:set-display 里带过来（不新增 IPC 通道），
// 回书架（window:release-book）时清掉，于是书架页跟全局主题走。
function effectivePaperTheme(session) {
  const cfg = config || {};
  const bookId = session && session.bookId;
  if (bookId && cfg.bookDisplay && typeof cfg.bookDisplay === 'object') {
    const entry = cfg.bookDisplay[bookId];
    if (entry && typeof entry.editorPaper === 'string' && windowChrome.THEMES[entry.editorPaper]) {
      return entry.editorPaper;
    }
  }
  return windowChrome.themeNameOf(cfg.editorPaper);
}

// 把标题栏配色刷到一个窗口上（失焦态按 win.isFocused() 选）。
// 旧系统 / 没有 titleBarOverlay 的环境里 setTitleBarOverlay 不存在就静默跳过——窗口外观退回系统默认，
// 不影响任何功能（拖拽区 / 右键菜单仍是网页里的 CSS + 菜单，照常）。
function applyWindowChrome(session) {
  const win = session && session.win;
  if (!win || win.isDestroyed() || typeof win.setTitleBarOverlay !== 'function') return false;
  try {
    win.setTitleBarOverlay(windowChrome.overlayFor(effectivePaperTheme(session), { inactive: !win.isFocused() }));
    return true;
  } catch {
    return false;
  }
}

function applyWindowChromeAll() {
  for (const session of windowSessions.values()) applyWindowChrome(session);
}

// 标题栏右键菜单（命令面板 / 还原 / 最小化 / 最大化 / 关闭）。「移动 / 大小」仍用 Windows 自带的 Alt+Space
// 系统菜单——这两个动作要走系统模态循环，Electron 没有暴露。
function titleBarMenuTemplate(win) {
  const alive = () => win && !win.isDestroyed();
  return windowChrome.menuTemplate({
    maximized: Boolean(alive() && win.isMaximized()),
    // 1.6.0 F4b：顶栏右键也能开命令面板（Ctrl+K 之外的鼠标入口）。这里只发一条空通知，
    // 面板能不能开（弹层 / 锁键层）由渲染层用和 Ctrl+K 同一个入口判断，主进程不碰 UI 状态。
    commandPalette: () => {
      if (!alive() || !win.webContents || win.webContents.isDestroyed()) return;
      win.webContents.send('app:command-palette');
    },
    restore: () => {
      if (alive()) win.unmaximize();
    },
    minimize: () => {
      if (alive()) win.minimize();
    },
    maximize: () => {
      if (alive()) win.maximize();
    },
    close: () => {
      if (alive()) win.close();
    }
  });
}

async function getConfig() {
  if (!config) {
    configStore = createConfigStore(app.getPath('userData'));
    config = decorateConfig(await configStore.get());
    // 审计残留修复 R28（#52/E25）：这里只 peek 记日志、不取走 —— 提示留在 store 里由 app:warning
    // 取「当前值」（写前重试归档成功会把它更正成「已归档」，启动就 take 走的话那份更正永远没人读）。
    configWarning = configStore.peekLoadWarning();
    // A5（审计 E2）：配置读失败（EACCES / EIO / EBUSY…）与损坏归档都留一条本机日志，
    // 只记错误码与中文结论，不含路径、不含配置内容；界面仍走 app:warning 提示一次。
    if (configWarning) {
      logError('config-load', new Error(configWarning.message), {
        level: 'warn',
        code: configWarning.code,
        message: configWarning.message
      });
    }
  }
  return config;
}

// 每日统计只存在应用配置目录；首次用到时才建，读写失败不能影响保存正文。
function getStatsStore() {
  if (!statsStore) statsStore = statsLib.createStatsStore(app.getPath('userData'));
  return statsStore;
}

// 统计摘要统一出口：今天 + 近 30 天 + 连续写作天数（保存后与 stats:get 用同一套口径）。
// v0.8-2 起带上「写作时长」开关状态，界面据此决定要不要显示计时按钮（默认关）。
// 审计修复 #54（P9）：stats 来自 getStatsStore() / record（已 sanitize），传 sanitized: true
// 让 summary / streak 跳过重复清洗（stats:get 一次请求原来把同一份统计洗四遍）。
function statsSummaryPayload(stats, cfg, now = new Date()) {
  return {
    ...statsLib.summary(stats, { goal: cfg.dailyGoal, now, sanitized: true }),
    streak: statsLib.streak(stats, { now, sanitized: true }),
    writeDurationEnabled: cfg.writeDurationEnabled === true
  };
}

// 记住这次导出保存到的目录（下次导出默认还开在这里）；记不住也绝不影响导出结果。
async function rememberExportDir(dir) {
  if (!dir) return;
  // 五-L3（CI-6）：这个目录是本窗口的导出流程真的落盘过的 —— 登记为「刚选中的来源」，
  // 之后同一窗口 config:set 原样回传这个值也能过来源校验（与字体 / 词表同一口径）。
  rememberPickedConfigPath('lastExportDir', dir);
  const cfg = await getConfig();
  if (dir === cfg.lastExportDir) return;
  try {
    const updated = await configStore.set({ lastExportDir: dir }, { auto: true });
    applyConfig(updated);
  } catch {
    /* 忽略：只是记个位置 */
  }
}

// ---------- 「继续上次写作」：书架级记忆（只写配置，不碰书库） ----------
// 书库里的 lastOpenChapterId 仍是「打开这本书回到哪一章」的唯一事实来源；
// 这里只记“上次写的是哪本书的哪一章 + 时间”，给书架顶部的入口用。
// info.at（可选）是「切章发生的时间」而不是「落盘时间」：B3 的切章防抖会把落盘推迟最多 1.5 秒，
// 若用落盘时间，另一本书刚保存过（更晚）也会被这条迟到的切章记录盖掉（多窗口 E2E 55c 抓到过）。
async function rememberRecentBook(bookPath, info) {
  if (!bookPath || !info) return false;
  const chapterId = String(info.chapterId == null ? '' : info.chapterId).trim();
  if (!chapterId) return false;
  const now = Date.now();
  const at = Number.isFinite(Number(info.at)) && Number(info.at) > 0 ? Math.round(Number(info.at)) : now;
  const payload = {
    path: bookPath,
    title: String(info.title == null ? '' : info.title).slice(0, 200),
    chapterId,
    chapterIndex: Math.max(0, Math.round(Number(info.chapterIndex) || 0)),
    chapterName: String(info.chapterName == null ? '' : info.chapterName).slice(0, 200),
    at
  };
  try {
    await getConfig();
    // C28（v1.8.0 WP-26）：读旧值 / 5 秒去重 / at 守卫 / 写盘全部在 configStore 的写队列里完成
    // （configStore.rememberLastBook）。旧实现在 set 之前单独 get：两个窗口并发时都基于同一份
    // 旧值通过守卫，迟到的旧切章记录能盖掉更晚的「上次写作」。
    const result = await configStore.rememberLastBook(payload, { auto: true, now });
    if (result.written) applyConfig(result.config);
    return result.written;
  } catch {
    return false; // 记不住位置不影响写作
  }
}

// ---------- B3（审计 P3）：切章「上次打开章节」防抖 ----------
// 原来每次切章都同步「读整本书目 → 改一个字段 → 写回整本书目」；千章书连续切章就是反复读 / 写
// 几 MB 的 书目.json。这里按书合并 1.5 秒内的连续切章，只落盘最后一次（数据格式不变，仍写
// 书目.json 的 lastOpenChapterId）。读书目前（书架列表 / 继续上次写作 / 打开书）与退出前 flush，
// 保证「重开书回到上次章」看到的一定是最后一次切章。
const LAST_OPEN_DEBOUNCE_MS = 1500;
let lastOpenQuitFlushStarted = false; // will-quit 里只拦一次退出、只 flush 一次
// 五-L9（PM-1）：storage.setLastOpenChapter 把读 / 写失败收成 { ok:false } 正常 resolve ——
// 防抖落盘这一层必须看一眼结果，否则「重开书回到上次章」静默回退、事后零日志可查，也与
// core/debounce.js「写入失败不吞」的契约不符。非「章已被删」的失败按契约 reject（flush 调用方
// 自己决定记 / 忽略，定时器路径本来就会 catch），并留一条 warn；章在防抖窗口里被删掉是正常竞态
// （记不住这次切章），只记 info、不抛，免得删章流程的日志变噪。
async function saveLastOpenChapter({ bookPath, chapterId }) {
  const result = await storage.setLastOpenChapter(bookPath, chapterId);
  if (result && result.ok === false) {
    const failure = Object.assign(new Error(result.message || '写入「上次打开章节」失败'), {
      code: result.code || 'SET_LAST_FAILED'
    });
    const benign = result.code === 'CHAPTER_NOT_FOUND';
    logError('set-last', failure, { level: benign ? 'info' : 'warn', code: failure.code });
    if (!benign) throw failure;
  }
  return result;
}
const lastOpenWrites = createKeyedDebouncer({
  delayMs: LAST_OPEN_DEBOUNCE_MS,
  save: saveLastOpenChapter
});

// 1.7.2 D4（V43/V83）：判「同一本书」不再手写 path.resolve().toLowerCase()，与词表去重 / 配置
// 校验统一走 core/path-utils.js 的 pathKey（resolve + 小写 + Windows 正反斜杠归一）。
// 名字保留 bookKeyOf：它在这里只当「切片写队列的 key」，调用点读数最清楚。
const bookKeyOf = pathUtils.pathKey;

// 读 书目.json 之前把这本书待写的「上次打开章节」落盘（书架 / 打开书 / 继续上次写作三个入口）。
async function flushLastOpenBeforeRead(bookPath) {
  try {
    if (bookPath) await lastOpenWrites.flush(bookKeyOf(bookPath));
    else await lastOpenWrites.flushAll();
  } catch {
    /* 落盘失败不挡读：旧行为里这一步也只是「记不住」 */
  }
}

function clampBounds(bounds) {
  try {
    if (!bounds || !Number.isFinite(Number(bounds.width)) || !Number.isFinite(Number(bounds.height))) {
      return null;
    }
    const display = screen.getDisplayMatching({
      x: Number(bounds.x) || 0,
      y: Number(bounds.y) || 0,
      width: Number(bounds.width),
      height: Number(bounds.height)
    });
    const area = display.workArea;
    const width = Math.min(Number(bounds.width), area.width);
    const height = Math.min(Number(bounds.height), area.height);
    const x = Math.max(area.x, Math.min(Number(bounds.x) || 0, area.x + area.width - width));
    const y = Math.max(area.y, Math.min(Number(bounds.y) || 0, area.y + area.height - height));
    return { x, y, width, height };
  } catch {
    return null;
  }
}

// ---------- 关闭流程（每个窗口各自拦截；保存失败不静默退出） ----------
function setupCloseFlow(session) {
  const browserWin = session.win;
  browserWin.on('close', (event) => {
    if (session.forceClose) return;
    event.preventDefault();
    if (session.closePending) return;
    session.closePending = true;
    try {
      browserWin.webContents.send('app:close-requested');
    } catch {
      session.closePending = false;
      return;
    }
    clearTimeout(session.closeTimer);
    session.closeTimer = setTimeout(async () => {
      if (!session.closePending || browserWin.isDestroyed()) return;
      const { response } = await showMessageBox(closeGuard.timeoutPrompt(), browserWin);
      if (response === 1) {
        session.closePending = false;
        session.forceClose = true;
        // A1（审计 E-03）：点「强制退出」不再立刻 destroy —— 先 send('app:force-close') 通知
        // 渲染层把能存的存下来，等 500 ms 再 destroy。阈值 / 顺序 / 文案都在
        // core/close-guard.js，单测钉住（tests/close-guard.test.js）。
        const plan = closeGuard.forceClosePlan({ destroyed: browserWin.isDestroyed() });
        await closeGuard.runForceCloseSteps(plan, {
          send: () => {
            try {
              if (browserWin.isDestroyed()) return;
              // 台账 #3（WP18 / 审计 R-N4）：这里必须用**字面量**发送 —— 接线清单（scripts/wiring-check.js）
              // 只看得见 webContents.send 后面跟静态字符串的写法，以前发 plan.channel，app:force-close 被
              // 误判成「preload 有监听、主进程没发送」的死监听。字面量与 core/close-guard.js 的
              // FORCE_CLOSE_CHANNEL 同源；两边漂移时宁可这一拍不发（wait/destroy 照旧），也要留下日志。
              if (closeGuard.FORCE_CLOSE_CHANNEL !== 'app:force-close') {
                logError('force-close-channel-drift', {
                  code: 'CHANNEL_DRIFT',
                  message: '强制退出通知频道与 core/close-guard.js 不一致，本次不发送'
                });
                return;
              }
              browserWin.webContents.send('app:force-close');
            } catch {
              /* 窗口刚好在这一下销毁：没有渲染层可通知，继续走 destroy */
            }
          },
          wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          canDestroy: () => !browserWin.isDestroyed(),
          destroy: () => browserWin.destroy()
        });
      } else {
        session.closePending = false;
      }
    }, closeGuard.CLOSE_TIMEOUT_MS);
  });
}

// 关闭回执 / 脏状态上报只注册一次，按发送方窗口路由（多窗口各管各的）
function setupCloseIpc() {
  ipcMain.on('app:close-ready', async (event, allowed) => {
    const session = sessionOfSender(event);
    if (!session) return;
    session.closePending = false;
    clearTimeout(session.closeTimer);
    // C5（审计 E5/S5）：关窗放行改主进程交叉判定——渲染层说「可以关」还不够：
    // 若它仍上报有未保存修改（session.dirty），只有主进程看到过「变脏之后的一次保存成功回执」
    // 才放行；否则拦下并记日志（防止渲染层一个坏回包把没保存的内容丢掉）。
    // 「不保存退出」是作者主动丢弃：渲染层会先把脏状态清成 false 再回 allowed=true（见 renderer）。
    // N3（审计 #22）：回执必须**严格晚于**这次变脏的上升沿才放行。两个时间戳都取 Date.now()（毫秒
    // 精度），「保存回执」与「再次变脏」落在同一毫秒时先后不可分辨：>= 会按「已保存」放行，最坏丢掉
    // 这几毫秒内的编辑；改成 > 把方向翻成「宁可多拦一次」——多拦只影响这一次关窗（再点一次关闭即可），
    // 而正常「保存成功后关闭」路径里渲染层会先把 app:dirty(false) 报上来（session.dirty 为 false），
    // 不依赖这条回执，所以不受影响。
    // CGRD-03：放行判定只走 core/close-guard.js 的同一份规则（closeReleaseDecision），这里不再内联复算——
    // 否则日后调 dirtyAt / 保存回执的边界只改 close-guard.js 时，第一道判定不随动。
    const decision = closeGuard.closeReleaseDecision({
      allowed,
      dirty: session.dirty,
      lastSaveAt: session.lastSaveAt,
      dirtyAt: session.dirtyAt
    });
    const okToClose = decision.okToClose;
    if (decision.code === 'CLOSE_DIRTY') {
      logError(
        'close-blocked',
        {
          code: 'CLOSE_DIRTY',
          message: '关窗被主进程拦下：界面仍报告有未保存修改，且没有对应的保存成功回执'
        },
        { level: 'warn' }
      );
    }
    session.e2eCloseReady = okToClose;
    e2eLastCloseReady = okToClose;
    if (isE2E) {
      // 默认只记回执、不真的关窗（既有 E2E 项都依赖窗口继续存在；不写死项数，加组就会过时）；
      // 多窗口用例显式打开「真实关窗」模式再关。
      e2eCloseReadyByWindow.set(String(session.id), okToClose);
      if (!e2eRealClose || !okToClose) return;
    } else if (!okToClose) {
      return;
    }
    // 只记「最近使用的窗口」的位置 / 大小；关一个非最近窗口不覆盖它
    await saveRecentWindowBounds(session);
    if (session.win.isDestroyed()) return;
    // WP-09（C6）：上面这次写盘是一次真实 await（配置整份写，慢盘上可达几十毫秒）。这段时间
    // 渲染层还能继续输入并上报 app:dirty；若只按回执那一刻的判定 forceClose，setupCloseFlow 的
    // close 事件会直接放行，把这段新编辑一起关掉。用同一判据（core/close-guard.js）再算一次，
    // 不通过就作废本次关窗：forceClose 不置、窗口不关，作者改完再点一次关闭即可。
    const recheck = closeGuard.closeReleaseDecision({
      allowed,
      dirty: session.dirty,
      lastSaveAt: session.lastSaveAt,
      dirtyAt: session.dirtyAt
    });
    if (!recheck.okToClose) {
      // E2E 记录的是「主进程最终放行了吗」，复查翻盘也要如实回写（组 10 用它断言被拦下）。
      session.e2eCloseReady = false;
      e2eLastCloseReady = false;
      if (isE2E) e2eCloseReadyByWindow.set(String(session.id), false);
      logError(
        'close-blocked',
        {
          code: 'CLOSE_DIRTY',
          message: '关窗被主进程拦下：保存窗口位置期间界面又变脏了，本次关窗作废'
        },
        { level: 'warn' }
      );
      return;
    }
    session.forceClose = true;
    session.win.close();
  });

  // 渲染层上报「是否有未保存修改」，供 Windows 关机拦截判断（按窗口记录）
  ipcMain.on('app:dirty', (event, dirty) => {
    const session = sessionOfSender(event);
    if (!session) return;
    const next = Boolean(dirty);
    // C5：记住「这次变脏」的时间，和最近一次保存回执比对（见 app:close-ready）
    if (next && !session.dirty) session.dirtyAt = Date.now();
    if (!next) session.dirtyAt = 0;
    session.dirty = next;
  });
}

// ---------- IPC ----------
// V114（WP-34）：三个域模块的 host —— 依赖注入的唯一装配点（只在 registerIpc() 里调一次）。
// getConfig / getConfigStore / getClipboard 用函数现取：配置仓库在 getConfig 里懒建、剪贴板句柄会被
// 自检宿主替换，直接传值会拿到过期快照；其余成员都是「调用时才执行」的函数或常量引用。
function buildIpcHost() {
  return {
    // 注册器（唯一装配面；两个包装函数仍在 main.js 里，负责 BAD_SENDER / 路径校验 / 错误脱敏）
    handle,
    handleBook,
    // 运行时状态 / 出口
    getConfig,
    getConfigStore: () => configStore,
    getClipboard: () => activeClipboard,
    applyConfig,
    flowSession,
    sessionById,
    focusSession,
    flushLastOpenBeforeRead,
    lastOpenWrites,
    bookKeyOf,
    rememberRecentBook,
    rememberExportDir,
    notifyShelfChanged,
    sendToFlow,
    logError,
    rememberPickedConfigPath,
    showSaveDialog,
    showOpenDialog,
    // core 模块
    storage,
    repair,
    importer,
    openBooksLib,
    exporter,
    chaptersLib,
    epubLib,
    docxLib,
    s2tLib,
    proofreadLib,
    glossaryLib,
    sensitiveLib,
    ipcLimits,
    ipcPaths,
    ipcRestoreToken,
    restoreTokens,
    errorText,
    pathUtils,
    mapLimit,
    WORDLIST_MAX,
    CHAPTER_READ_CONCURRENCY,
    CHAPTER_BATCH_SIZE,
    automation,
    isE2E,
    atomicWriteFile,
    atomicWriteFileStream,
    assertText,
    fs,
    fsSync,
    path,
    app,
    shell
  };
}


function registerIpc() {
  // V114（v1.8.0 WP-34 / D-6）：导出 / 校对 / 书 CRUD 三个域在 ipc/*.js 里注册，这里只装配。
  // 审计修复 #38（▲V306）：书域数据面（查找替换 / 历史 / 整理 / 快照清理 / 打开书文件夹）也下沉到
  // ipc/book-data.js —— 与书 CRUD 同一个域、同一次装配，书域不再分居两处。
  const domainHost = buildIpcHost();
  ipcBook.register(domainHost);
  ipcBookData.register(domainHost);
  ipcProofread.register(domainHost);
  ipcExport.register(domainHost);
  // ---------- 窗口会话（多窗口） ----------
  // 属于哪个窗口、这个窗口开着哪本书（打开登记只有主进程 + storage 知道）
  handle('window:info', async () => {
    const session = flowSession();
    return {
      windowId: session ? session.id : null,
      bookPath: session ? storage.openBookRegistry.getBook(session.id) : null,
      windows: storage.openBookRegistry.counts().windows
    };
  });
  // 回书架 / 切到没有书的视图时释放登记（关窗由主进程在窗口销毁时统一释放）
  handle('window:release-book', async () => {
    const session = flowSession();
    if (!session) return { released: false };
    const released = storage.releaseOpenBook(session.id);
    // 自绘标题栏（1.3.0 T6）：回书架 = 没有书了，标题栏配色回到全局主题
    session.bookId = '';
    applyWindowChrome(session);
    return { released };
  });
  // 书卡右键「在新窗口打开」：同书已开在别窗口就聚焦那个窗口、绝不开第二个
  handle('window:open-book', async (bookPath) => {
    const session = flowSession();
    const cfg = await getConfig();
    const target = assertBookPath(bookPath, cfg.booksRoot);
    // B3：新窗口打开同一本书前，先把防抖中的「上次打开章节」落盘
    await flushLastOpenBeforeRead(target);
    const owner = storage.findOpenBookWindow(target);
    if (owner) {
      const ownerSession = sessionById(owner);
      if (ownerSession) focusSession(ownerSession);
      return {
        focused: true,
        sameWindow: Boolean(session && String(session.id) === String(owner)),
        windowId: Number(owner),
        message: openBooksLib.openInOtherWindowMessage(target)
      };
    }
    // 先确认书能正常读，避免开出一个空窗口（读失败照常返回错误）
    await storage.openBook(target);
    const created = await createWindow({ bookPath: target, cascade: true });
    return { focused: false, windowId: created.id };
  });

  handle('config:get', async () => getConfig());
  // 界面上的版本号从 package.json 读，免得每次发版忘了改静态文字
  handle('app:version', async () => ({ version: app.getVersion() }));
  // 启动后取一次「配置损坏被归档」之类的提示（取完即清空）
  // 审计残留修复 R28（#52/E25）：以 store 里的当前值为准 —— 写前重试归档成功会把「无法归档」
  // 更正成「已归档」、读盘恢复会把过期提示作废；主进程启动时只 peek 记日志、不取走，否则界面
  // 拿到的是启动那一刻的快照（store 里的自动更正成了没人读的死代码）。
  handle('app:warning', async () => {
    const warning = configStore ? configStore.takeLoadWarning() : configWarning;
    configWarning = null;
    return warning;
  });

  // 书架顶部「继续上次写作」用：上次写的是哪本书、哪一章、什么时候
  handle('app:recent-book', async () => {
    // B3：「继续上次写作」入口显示的章要反映最后一次切章（防抖里还没落盘的话先落盘）
    await flushLastOpenBeforeRead(null);
    const cfg = await getConfig();
    return cfg.lastBook || null;
  });

  // B1（审计 E2）：渲染层没被 catch 的 Promise 拒绝 → 落一条诊断日志（本机路径只留最后一节、
  // 不含正文，与 fail() 同一条脱敏链路）。来源由 handle() 统一校验（BAD_SENDER，不可信来源回
  // BAD_SENDER 且不写日志）；参数只收 kind / code / message 三个短字符串，形状不合法回
  // {accepted:false} 而不是抛错——留痕失败不该反过来干扰渲染层。不新增任何界面文案：
  // 提示由渲染层自己给固定一句（见 reportBackgroundFailure）。
  handle('app:report-renderer-error', async (payload) => {
    const report = errorText.sanitizeFailureReport(payload, RENDERER_FAILURE_KINDS);
    if (!report) return { accepted: false };
    // 控制台这一行只打脱敏后的 code / message（与 fail() 一个口径），开发时看得见、日志里也有一条
    console.error('[renderer-failure]', report.kind, report.code, report.message);
    logError(
      'renderer-failure',
      { code: report.code, message: `[${report.kind}] ${report.message}` },
      { level: report.kind === 'unhandledrejection' ? 'error' : 'warn' }
    );
    return { accepted: true };
  });

  // 改配置（v0.9 C-2b）：显示设置 / 统计 / 模板这些随便改，但「指向磁盘」的四项
  // （书架目录 + 两份词表 + 自定义字体）只认「这个窗口刚在系统对话框里选中的值」或「与原值相同 / 清空」。
  // 设置界面本来就只有「选择…」按钮（输入框都是只读的），所以正常用起来毫无区别；
  // 被注入的脚本想借 config:set 让主进程去读写别的目录 / 文件，会被 core/config-gate.js 挡掉。
  handle('config:set', async (patch) => {
    // WP-10（C7）：配置读过失败的话，保存设置前先重试读盘——读到真的配置再按它合并 / 算目标书架目录，
    // 仍读不到就明确失败（CONFIG_READ_FAILED），绝不拿内存里的默认值写盘，把书库根目录等设置抹掉。
    // 审计修复 #53（R8）：这次 getConfig 的返回值直接复用（旧实现紧接着又 await getConfig() 一次，
    // 只是从同一个内存缓存再拷一遍）；ensure 配置仓库已就绪的语义不变。
    let current = await getConfig();
    const recovery = await configStore.retryLoad();
    if (!recovery.ok) {
      throw Object.assign(new Error(recovery.message), {
        code: recovery.code,
        errorCode: recovery.errorCode
      });
    }
    // 读盘恢复了：主进程缓存还是启动时的默认值，先换成真配置再继续（applyConfig 会同步标题栏配色）。
    if (recovery.recovered) current = applyConfig(await configStore.get());
    // C23（整合版审计）：「换根前的生效根」也走「sanitize + 装饰层」——设置了 --books-root 时它就是
    // 覆盖目录（这时 patch 里的 booksRoot 改不动生效根，不该被误判成换根）。与后面的目标根同口径比较。
    // C2（审计 #21）：先按这份快照兜底；真正参与「判根 + mkdir」的值在 configStore.set 的 beforeWrite
    // 里用队列内刚读到的 current 重算（并发写配置时快照可能已过期，见下）。
    let previousRoot = decorateConfig(sanitizeConfig(current)).booksRoot;
    const session = flowSession();
    const picked = session ? pickedConfigPaths.snapshot(session.id) : null;
    const gated = configGate.filterPathPatch(patch, { current, picked });
    // E1（审计 E1）：bookDisplay 是顶层字段，filterPathPatch 会原样透传——每本书的 editorCustomFontPath
    // 会被 font:read 整份 base64 读回渲染层，等于绕过字体来源闸门。这里逐书过 book:set-display 同一份
    // 校验（filterBookDisplayMapPatch），并按书合并回当前 map：被拒的字体路径保留原值，只带一本书的
    // patch 不会把别的书的显示覆盖抹掉；形状不对的 bookDisplay 整个键丢掉（保留原配置）。
    let displayPatch = null;
    if (Object.prototype.hasOwnProperty.call(gated.patch, 'bookDisplay')) {
      const displayGate = configGate.filterBookDisplayMapPatch(gated.patch.bookDisplay, { current, picked });
      if (displayGate.patch) displayPatch = displayGate.patch;
      // 五-L2（CI-4）：这里只做「逐书过闸门」，并 map 的合并交给 configStore.set 的 bookDisplayPatch
      // （写队列内用刚读到的 current 重算）——旧实现拿队列外这份 current 快照整 map 合并，会静默
      // 吞掉别的窗口并发 book:set-display 刚写进去的更新。
      delete gated.patch.bookDisplay;
      if (displayGate.rejected.length) gated.rejected.push(...displayGate.rejected);
    }
    // 只把放行的字段交给配置仓库：被拒的字段保留原值，正常字段照旧生效。
    // A3（审计 E3）：换书架根时先把目标书架目录建出来（建不出来就报错、配置一个字都不写），再写盘。
    // 旧顺序是「configStore.set 写盘成功 → fs.mkdir」，目录建不出来时界面看到「保存失败」，
    // 但配置已经落盘——重启后书架指向一个不存在的目录，作者会以为「书没了」。
    // C23（整合版审计）：只在书架根**真的变化**时才 mkdir。以前这里无条件 mkdir——改字号 / 主题 /
    // 按书字体这类无关 patch 也会去动书架根，书架在断开的网络盘 / USB 上时，保存无关设置会跟着失败。
    // C2（审计 #21）：判根 / mkdir / 写盘必须进同一个写队列。旧实现用队列外的 current 快照算
    // previousRoot / targetRoot，多窗口并发写配置时判定会过期（A 刚换根，B 还按旧根判 → 新根没被预建）。
    // 现在把「判根 + mkdir」放进 configStore.set 的 beforeWrite：它和写盘同一个 enqueue，拿的是
    // 队列内刚读到的 current；mkdir 失败 ⇒ set 直接抛出，配置一个字都不写（A3 的顺序语义不变）。
    // 目标目录仍按「当前配置 + 放行后的 patch」走同一份 sanitize，并过装饰层（--books-root 时是覆盖目录）。
    const next = await configStore.set(gated.patch, {
      // 五-L2（CI-4）：每本书显示覆盖的并 map 合并进写队列（队列内 current 重算，不吞并发更新）
      bookDisplayPatch: displayPatch,
      async beforeWrite({ current: freshCurrent }) {
        previousRoot = decorateConfig(sanitizeConfig(freshCurrent)).booksRoot;
        const targetRoot = decorateConfig(sanitizeConfig({ ...freshCurrent, ...gated.patch })).booksRoot;
        if (configGate.booksRootChanged(previousRoot, targetRoot)) {
          await fs.mkdir(targetRoot, { recursive: true });
        }
      }
    });
    const nextConfig = applyConfig(next);
    // A4（审计 #11 / O3、P6）：换了书架根目录后，旧根下的书锁条目没有复用价值——主动回收空闲条目
    // （正在跑 / 正在排队的链绝不拆，它们 settle 后自己回收，这里只是尽早腾掉 Map 位置）。
    // C23：与上面建目录共用同一个「根是否变化」判据（全仓唯一 pathKey 口径），不会出现
    // 「目录没建但锁清了」或反过来的分叉。
    if (configGate.booksRootChanged(previousRoot, nextConfig.booksRoot)) {
      storage.clearBookLocks();
      // WP6（N2，审计中 #7）：换书架根要广播给所有窗口 —— 别的窗口里停在旧根下的书，继续保存只会
      // 被 assertBookPath 拦成 BAD_PATH。渲染层收到后：停在书架就刷新成新目录；开着旧根的书给一次性
      // 提示 + 救稿出口。只带生效根（装饰层后的值）：--books-root 覆盖时判据同上，覆盖目录不算换根。
      broadcast('config:changed', { reason: 'booksRoot', booksRoot: nextConfig.booksRoot });
    } else {
      // 五-M14（SS-11）：非换根的全局设置变更也要广播。旧实现只在换根时通知，别的窗口的
      // state.globalConfig 就停在它上一次读到的旧值——作者在那边点一次保存，config:set 带的是
      // 整份全局表单，会把这里刚改的项（dailyGoal / 字号 / 快照 / 词表路径…）静默盖回旧值。
      // 载荷只带「改了哪些顶层键」的摘要（不带值：路径类字段不进广播）；发起窗口自己已经拿到
      // 回包，用 except 跳过它，免得本窗口把自己的保存当成「别的窗口改过设置」再重填一遍表单。
      // 五-L2（CI-4）：bookDisplay 的合并已经挪进写队列，patch 里不再有它 —— 摘要补上这个顶层键，
      // 别的窗口才会把按书显示覆盖也刷新一遍。
      const changed = Object.keys(gated.patch || {});
      if (displayPatch) changed.push('bookDisplay');
      broadcast(
        'config:changed',
        { reason: 'config', changed },
        { except: session ? session.id : null }
      );
    }
    // b8：设置里打开 / 关闭「后台监听剪贴板」立即生效（幂等）
    syncClipboardWatch();
    if (gated.rejected.length) logRejectedConfigPaths(gated.rejected);
    // v1.8.2 WP5（N1）：崩溃草稿开关同样立即生效（默认关；关掉时清标记 + 草稿）。
    await syncCrashDraftSession();
    return config;
  });

  if (automation) {
    // 仅自检：模拟「在系统目录对话框里选中了某个路径」（E2E 没法真的点原生对话框）。
    // 和 font:test-pick / update:test-mock 一样只在 automation 下注册，生产环境这个频道不存在。
    // 参数顺序有意把路径放第一位：tests/ipc-paths.test.js 的静态闸门只盯第一参数带路径的频道，
    // 这样以后谁再改这个频道也不会悄悄绕过清单（见 PATH_CHANNEL_ALLOWLIST）。
    handle('config:test-pick', async (pickedPath, field) => {
      const session = flowSession();
      const value = typeof pickedPath === 'string' ? pickedPath.trim() : '';
      const key = typeof field === 'string' ? field.trim() : '';
      if (!session || !value || !configGate.GUARDED_PATH_FIELDS.includes(key)) return false;
      pickedConfigPaths.remember(session.id, key, value);
      return true;
    });
    // b8 自检：工作站锁屏 / 无交互桌面时 Windows 会拒绝 clipboard.readText()（恒空），
    // 和现有复制类 E2E 的进程内剪贴板兜底同一个已知限制。这里注入一份文本代替真实剪贴板，
    // 并立即跑一拍监听（生产不注册这个频道；真实读取路径仍是 clipboard.readText()）。
    handle('clipboard:test-set', async (text) => {
      clipboardWatchTestText = typeof text === 'string' ? text : '';
      void pollClipboardWatch();
      return true;
    });
  }

  // 每日字数统计摘要：今天多少字 + 近 30 天（含今天）+ 当月码字日历 + 连续写作天数。
  // 统计文件在 userData，不在书库；月视图只读，切换月份走 stats:calendar。
  handle('stats:get', async (filter) => {
    const cfg = await getConfig();
    const stats = await getStatsStore().get();
    const now = new Date();
    return {
      ...statsSummaryPayload(stats, cfg, now),
      calendar: statsLib.monthView(stats, { now, goal: cfg.dailyGoal, sanitized: true }),
      // 1.6.0 F2：按书 / 按年汇总（只读现算，不写 stats.json；筛选由渲染层的两个下拉传进来，
      // 坏值在 core/stats 里当作「不筛」）。summary 仍是全书架口径，书架头 / 状态栏不受筛选影响。
      // 审计修复 #54（P9）：同一份已清洗统计直接复用（sanitized: true），不再洗第四遍。
      aggregate: statsLib.aggregate(stats, filter, { sanitized: true })
    };
  });
  handle('stats:calendar', async (request) => {
    const cfg = await getConfig();
    const stats = await getStatsStore().get();
    const now = new Date();
    return {
      calendar: statsLib.monthView(stats, {
        year: request && request.year,
        month: request && request.month,
        now,
        goal: cfg.dailyGoal,
        sanitized: true
      }),
      streak: statsLib.streak(stats, { now, sanitized: true })
    };
  });
  // 写作时长（v0.8-2）：渲染层在计时暂停 / 保存 / 每 30 秒上报一次整秒。
  // 默认关：关着时只读 stats.json 算一份摘要回给界面（不记时长、不写盘），旧用户行为完全不变。
  // 只记秒数，不接收正文、按键或任何内容；写盘仍走 core/atomic（和字数共用串行队列）。
  handle('stats:duration', async (request) => {
    const cfg = await getConfig();
    const now = new Date();
    const today = statsLib.localDayKey(now);
    // 五-L12（ES-3）：允许渲染层带上「秒数所属的本地日期」（跨午夜 / 失败积压按天拆开上报，
    // 旧实现一律按回执到达时刻算日期）。只认合法日期键；未来日期（时钟 / 时区异常）一律按今天，
    // 免得提前占用明天的写作用时配额；过去的日期照收（积压补记）。
    const requestedDay = statsLib.localDayKey(request && request.day);
    const day = requestedDay > today ? today : requestedDay;
    if (cfg.writeDurationEnabled !== true) {
      const stats = await getStatsStore().get();
      return { recorded: 0, disabled: true, day, stats: statsSummaryPayload(stats, cfg, now) };
    }
    const requested = Math.min(
      statsLib.MAX_DAY_SECONDS,
      Math.max(0, Math.floor(Number(request && request.seconds) || 0))
    );
    if (requested <= 0) {
      const stats = await getStatsStore().get();
      return { recorded: 0, disabled: false, day, stats: statsSummaryPayload(stats, cfg, now) };
    }
    const recorded = await getStatsStore().addDuration({ day, seconds: requested });
    return {
      recorded: recorded.added,
      // 五-L12（ES-3）：单日上限夹住时明确告知（added < requested）。渲染层据此丢弃超出部分，
      // 不再每次 flush 拿同一批秒数无限重试，也不静默当成功。
      capped: recorded.added < requested,
      disabled: false,
      day: recorded.day,
      stats: statsSummaryPayload(recorded.stats, cfg, new Date())
    };
  });

  // 灵感箱（碎片速记）：书架根目录 _碎片 里的普通 txt。
  // 不传路径进来，文件名由主进程按日期 + 当天序号生成；写盘走 core/atomic，不碰 书目.json / 章节文件。
  // 三个频道共用 getFragmentStore（按 booksRoot 单例）：写队列是实例私有的，各建各的会让两个窗口
  // 并发保存双双通过「目标不存在」检查、rename 后写覆盖先写（V74）。
  handle('fragments:list', async () => {
    const cfg = await getConfig();
    return fragmentsLib.getFragmentStore(cfg.booksRoot).list();
  });
  handle('fragments:create', async (text) => {
    const cfg = await getConfig();
    return fragmentsLib.getFragmentStore(cfg.booksRoot).create(text);
  });
  handle('fragments:read', async (name) => {
    const cfg = await getConfig();
    return fragmentsLib.getFragmentStore(cfg.booksRoot).read(name);
  });

  // 剪贴板捕获（P0）：显式触发才读系统剪贴板；clipboard.readText() 天然是纯文本，
  // 网页的字体 / 颜色 / 图片都不会带进来。渲染层列表里点「章节」时整条文本原样传回来，
  // 章名规则 / 正文在 capture:commit-record 里统一算，渲染层不采信算好的正文。
  handle('capture:clipboard', async () => {
    const text = String((await activeClipboard.readText()) || '');
    assertText(text);
    return { text, chars: captureLib.countChars(text) };
  });

  // 2026-11-06（捕获队列）：本次运行复制过的几段——只回元数据 + 首行预览 + 截断正文预览，不回正文；
  // 正文只在用户显式点开某一条时经 capture:queue-get 取回（自动通知仍然只发字数）。
  handle('capture:queue-list', async () => ({ entries: captureQueue.list(), total: captureQueue.size() }));

  handle('capture:queue-get', async (id) => {
    const numeric = Number(id);
    const entry = Number.isFinite(numeric) ? captureQueue.get(Math.round(numeric)) : null;
    if (!entry) {
      throw Object.assign(new Error('这条复制记录已经不在了（可能刚被捕获或队列已清空）'), { code: 'QUEUE_MISSING' });
    }
    return { id: entry.id, text: entry.text, chars: entry.chars, at: entry.at };
  });

  handle('capture:queue-clear', async () => ({ cleared: captureQueue.clear() }));

  // 面板「正文」插入成功后消费这一条（2026-11-08 作者要求：正文也消失，与「章节」口径一致）。
  // 只删内存队列里的这一条，不碰章节 / 文件；id 不合法或已经不在队列里返回 removed:false（不报错）。
  handle('capture:queue-remove', async (id) => {
    const numeric = Number(id);
    return { removed: Number.isFinite(numeric) ? captureQueue.remove(Math.round(numeric)) : false };
  });

  // 打开面板前补一拍监听（2026-11-07 修「复制 4 次只记 2 次」）：轮询已缩到 300ms，
  // 但「复制完立刻点捕获」仍可能落在两拍之间；面板打开前主动读一次，不漏掉刚复制的那条。
  handle('capture:flush', async () => flushClipboardWatchOnce());

  // 一条复制记录 → 新建一章（v0.13.2 单列表面板的「章节」按钮）。storage.createChapterWithText
  // 先写正文再写书目，书目写失败会删掉刚建的文件，绝不留下有记录没正文的空章。
  // 章名规则统一在 core/capture.js 的 splitRecordTitle 里（主进程算，不采信渲染层算好的章名 / 正文）：
  //   标题行 + 够长的正文 → 标题当章名；整条不足 100 字 → 整条当章名；否则全文当正文。
  handleBook('capture:commit-record', async (bookPath, payload) => {
    const data = payload && typeof payload === 'object' ? payload : {};
    const text = data.text;
    // 单条上限沿用捕获正文上限（2026-11-08 起 30 万字；2026-11-15 起改成按**去空白字数**挡，
    // 与界面「N 字」/ 队列 / 渲染层的口径统一）：入了队的记录本来就 ≤30 万字，直捕超限在
    // 渲染层已被引导去「导入小说」；这里再挡一次是防手误 / 绕过界面，超限拆段比硬写进一章更合理。
    if (typeof text !== 'string' || !text.trim()) {
      throw new captureLib.CaptureError('BAD_TEXT', '捕获内容格式不对');
    }
    // 2026-11-17（审计 B3）：先挡**原文长度**，再挡去空白字数。空白重型 payload（290 万前导
    // 换行 + 10 万字正文）字数是 10 万、原文却是 300 万，只按字数挡会放它进标题拆分与写盘。
    // 原文上限与队列单条 / 总量同一口径（capture.MAX_RAW_CHARS = 3,000,000）；先判还省掉一次
    // 全串字数统计。闸门位置在 splitRecordTitle 与任何写盘之前：超限 payload 一个字节都不写。
    const limits = captureLib.checkCaptureLimits(text);
    if (limits.tooLarge) {
      const message =
        limits.reason === 'raw'
          ? `原文太长（${formatCount(limits.rawLength)} 个字符，最多 ${formatCount(captureLib.MAX_RAW_CHARS)} 个字符）；` +
            '请先删掉多余空行或拆成多段再捕获'
          : `内容太长（${formatCount(limits.chars)} 字，最多 ${formatCount(captureLib.MAX_BODY_CHARS)} 字）；` +
            '请先拆成多段再捕获';
      throw new captureLib.CaptureError('TOO_LARGE', message);
    }
    const parts = captureLib.splitRecordTitle(text);
    const rawIndex = Number(data.insertIndex);
    const saved = await storage.createChapterWithText(bookPath, {
      insertIndex: Number.isFinite(rawIndex) ? Math.max(0, Math.round(rawIndex)) : Number.MAX_SAFE_INTEGER,
      name: parts.title,
      text: parts.body,
      volumeId: typeof data.volumeId === 'string' ? data.volumeId : null
    });
    // 捕获写入的正文字数也计入每日统计；正文为空（整条就是章名）时不记，统计失败绝不影响章节落盘
    const bodyChars = chaptersLib.countChars(parts.body);
    const cfg = await getConfig();
    let stats = null;
    let statsError = null;
    if (bodyChars > 0) {
      try {
        const recorded = await getStatsStore().record({
          day: statsLib.localDayKey(),
          bookId: saved.meta.id,
          delta: bodyChars
        });
        stats = statsSummaryPayload(recorded.stats, cfg);
      } catch (err) {
        // MC-2（五-L21）：统计写失败的原因同样不许把原始 err.message（fs 错误带本机绝对路径）
        // 原样跨 IPC —— 与 fail() 同一道 error-text 脱敏出口。
        statsError = errorText.describeForUi(err).message;
      }
    }
    await rememberRecentBook(bookPath, {
      title: saved.meta.title,
      chapterId: saved.chapter.id,
      chapterIndex: saved.index,
      chapterName: saved.chapter.name
    });
    const session = flowSession();
    if (session) storage.openBookRegistry.touch(session.id);
    try {
      getSearchIndexStore().markDirty(bookPath);
    } catch {
      /* 索引不可用时忽略 */
    }
    // 捕获队列（2026-11-06）：写章真正成功后才删掉这一条；失败 / 取消不删（记录保留可重试）。
    const rawQueueId = Number(data.queueId);
    const queueRemoved = Number.isFinite(rawQueueId) ? captureQueue.remove(Math.round(rawQueueId)) : false;
    return {
      ...saved,
      title: parts.title,
      titleOnly: Boolean(parts.title && !parts.body),
      bodyChars,
      stats,
      statsError,
      queueRemoved
    };
  }, { mutation: 'write' });

  // 每本书的显示设置覆盖（写作页里改的字体/背景/间距/章节栏宽度只影响这本书）
  handle('book:get-display', async (bookId) => {
    await getConfig();
    // 自绘标题栏（1.3.0 T6）：记下这个窗口开的是哪本书 —— 标题栏配色要跟这本书生效的纸色走
    // （这本书设过按书覆盖就用它）。书 id 就从渲染层本来就会调的这两个频道里拿，不新增 IPC。
    const session = flowSession();
    if (session) {
      session.bookId = String(bookId == null ? '' : bookId).trim();
      applyWindowChrome(session);
    }
    return configStore.getBookDisplay(bookId);
  });

  handle('book:set-display', async (bookId, patch) => {
    await getConfig();
    // C1（审计 S1）：按书显示设置里的字体路径和全局同一个口径——只认「原来的 / 全局的 /
    // 这个窗口刚在字体对话框里选中的」路径；来源不明的路径忽略（保留原值），其它显示项照旧透传。
    const session = flowSession();
    const key = String(bookId == null ? '' : bookId).trim();
    // 自绘标题栏（1.3.0 T6）：按书改的主题也要立刻反映到系统按钮区（applyConfig 里统一重刷）
    if (session) session.bookId = key;
    const currentEntry = key && config.bookDisplay ? config.bookDisplay[key] || {} : {};
    const gated = configGate.filterBookDisplayPatch(patch || {}, {
      current: currentEntry,
      global: config || {},
      picked: session ? pickedConfigPaths.snapshot(session.id) : null
    });
    const display = await configStore.setBookDisplay(bookId, gated.patch);
    applyConfig(await configStore.get());
    if (gated.rejected.length) logRejectedConfigPaths(gated.rejected);
    return display;
  });

  handle('book:reset-display', async (bookId) => {
    await getConfig();
    const session = flowSession();
    if (session) session.bookId = String(bookId == null ? '' : bookId).trim();
    await configStore.resetBookDisplay(bookId);
    applyConfig(await configStore.get());
    return true;
  });

  // 查找书签（v0.8-11b，提案 N11b）：按「书 + 章」把查询词与大小写选项存在 userData/config.json。
  // 主进程做原子增 / 删（不整份覆盖数组），只写配置，绝不碰书库 / 书目 / 章节文件；
  // 渲染层仍然没有 fs 权限。
  handle('find:bookmark-list', async () => {
    await getConfig();
    return configStore.listFindBookmarks();
  });

  handle('find:bookmark-save', async (entry) => {
    await getConfig();
    const data = await configStore.upsertFindBookmark(entry || {});
    applyConfig(await configStore.get());
    return data;
  });

  handle('find:bookmark-remove', async (bookId, chapterId) => {
    await getConfig();
    const data = await configStore.removeFindBookmark(bookId, chapterId);
    applyConfig(await configStore.get());
    return data;
  });

  // 正文排版整理：纯文本变换，只计算不写盘（写盘仍由作者 Ctrl+S 决定）
  handle('text:format', async (text, options) => {
    assertText(text);
    return formatLib.formatText(text, options);
  });

  // 朗读（提案 5.3）：只把正文切成「一段一段」，发声由渲染层交给系统语音（speechSynthesis）。
  // 主进程不读盘、不写盘；chunks 的 start/end 与编辑区 value 一致，供点击 / 跟随高亮定位。
  handle('text:tts-chunks', async (text, options) => {
    assertText(text);
    return ttsLib.buildChunks(text, options);
  });

  // 当前章的查找 / 替换（只算文本，不写盘；全书版本走 book:search / book:replace）
  // v0.9 C-5：查找词 / 替换词也走上限（1 万字），替换结果按「原文 + 命中 × 增长」估算，
  // 超过 2000 万字先拒绝，不生成那个字符串（一处换一万字 × 五千处 = 5 千万字起步）。
  handle('text:find', async (text, query, options) => {
    assertText(text);
    const matches = findLib.findMatches(text, ipcLimits.assertQuery(query), options);
    return {
      count: matches.length,
      matches: matches.slice(0, 12).map((match) => ({
        index: match.index,
        length: match.length,
        ...findLib.makeSnippet(text, match.index, match.length, 18)
      }))
    };
  });

  // 当前章全部命中（v0.8-11，提案 N11）：给「上一处 / 下一处 + 结果持续高亮」用。
  // 和 text:find 的区别：不截断成 12 条、不带上下文，只回下标和长度；命中上限仍是 5000 处，
  // 到上限还多找出一处时明确回 truncated（界面据此提示「命中太多」）。只算文本，不读盘、不写盘。
  handle('text:find-all', async (text, query, options) => {
    assertText(text);
    const result = findLib.findMatchesAll(text, ipcLimits.assertQuery(query), options);
    return { count: result.matches.length, truncated: result.truncated, limit: result.limit, matches: result.matches };
  });

  handle('text:replace', async (text, query, replacement, options) => {
    assertText(text);
    const wanted = ipcLimits.assertQuery(query);
    const insert = ipcLimits.assertReplacement(replacement);
    const findOptions = { caseSensitive: Boolean(options && options.caseSensitive) };
    // 替换词比查找词长时才可能放大；这时先数一遍命中（最多 5000 处）再估结果长度。
    // 替换词不长于查找词时结果只会变短 / 不变，不用多扫一遍。
    if (insert.length > wanted.length) {
      const found = findLib.findMatches(text, wanted, findOptions);
      ipcLimits.assertReplaceOutput(text.length, found.length, wanted.length, insert.length);
    }
    // C4（v1.8.0 WP-05）：replaceAllLiteral 会带回 truncated / limit —— 超过单章上限时只替换前
    // limit 处，界面据此提示「只替换了前 N 处」，不把这当成全部替换。
    return findLib.replaceAllLiteral(text, wanted, insert, findOptions);
  });

  // Ctrl+G 跳章：纯匹配（章号 / 章名关键词），不读盘、不写盘。规则在 core/jump.js，单测覆盖。
  // v0.9 C-5：章节列表由 core/ipc-limits.js 清洗——只留前 20000 条、每条只留 id / name（各限长），
  // 坏条目变成 null 被 core/jump.js 跳过；非数组仍是 BAD_CHAPTERS（文案不变）。
  handle('jump:match', async (chapters, query, options) => {
    return jumpLib.findMatches(ipcLimits.sanitizeChapterList(chapters), query, options);
  });

  // 「只替换这一处」：从编辑区光标位置往后找下一处命中（纯计算，不写盘）
  handle('text:find-next', async (text, query, fromIndex, options) => {
    assertText(text);
    return findLib.findNextMatch(text, ipcLimits.assertQuery(query), fromIndex, options);
  });

  handleBook('chapter:save', async (bookPath, chapterId, text, expectedMtimeMs) => {
    // A2（审计 E6）：全仓唯一漏掉正文校验的写盘通道。与 text:format / text:find / replace
    // 同一口径：正文必须是字符串且不超过 500 万字（core/ipc-limits.js），超限回 TEXT_TOO_LARGE。
    // C26（v1.8.0 WP-26）：null / undefined 不再当空章写盘（旧实现刻意兼容成 ''）。渲染层拿到
    // undefined 的正文变量时，旧行为是静默把整章清空 —— 写卡口宁可报 BAD_TEXT，也不能丢数据。
    const body = assertText(text);
    const session = flowSession();
    return storage.withBookLock(bookPath, async () => {
      const cfg = await getConfig();
      // 保存前校验（写盘安全检查）：书文件夹、书目、章节记录、章节文件都还在才允许写，
      // 且书不能正开在另一个窗口。任何一项失效都报错，绝不 mkdir 重建影子文件。
      // 审计修复 #5（V301）：渲染层带来的 expectedMtimeMs 也在这里比对——载入之后磁盘被
      // 应用外改过就抛 EXTERNAL_CHANGE，交给 save-rescue-ui.js 的三选，绝不静默覆盖外部版本。
      const prepared = await storage.prepareChapterSave(bookPath, chapterId, {
        windowId: session ? session.id : null,
        expectedMtimeMs
      });
      const meta = prepared.meta;
      const chapter = prepared.chapter;
      // 每日字数的「上次已知值」：优先书目里缓存的正文字符数；缓存缺失（老书/新章）时
      // 只在这一次读一遍旧文件，保证第一次保存的增量仍然准确。
      let previousChars = null;
      if (chapter.chars != null && chapter.chars !== '' && Number.isFinite(Number(chapter.chars))) {
        previousChars = Math.max(0, Math.round(Number(chapter.chars)));
      } else {
        try {
          const previous = await storage.loadChapterText(bookPath, chapter.file);
          previousChars = chaptersLib.countChars(previous.text);
        } catch (err) {
          previousChars = null; // 旧文件读不到就当「不知道」，这次不计入统计
          // C0（审计 #3 / E1）：正文马上要落盘，派生数据读不到不能挡保存；但以前这里是零日志，
          // 「今天字数少算了」事后查不到原因。只记错误码 + 脱敏后的信息（core/logs.js 遮罩路径）。
          logError('save-derived', err, { level: 'warn', code: 'CHARS_BASELINE_MISSING' });
        }
      }
      // 可选每日快照：在写正文之前复制「上一版」。默认关；失败只记原因，绝不阻塞保存。
      let snapshot = { taken: false, reason: 'DISABLED', dir: null, file: chapter.file, bytes: 0, cleanup: null };
      if (cfg.snapshotEnabled) {
        try {
          snapshot = await storage.takeDailySnapshot(bookPath, chapter.file, {
            keepDays: cfg.snapshotKeepDays,
            now: new Date()
          });
        } catch (err) {
          // C0（审计 #3 / E1）：快照失败只留痕 + 把原因带回结果，仍然绝不阻塞保存。
          logError('save-derived', err, { level: 'warn', code: 'SNAPSHOT_FAILED' });
          snapshot = {
            taken: false,
            reason: 'ERROR',
            message: errorText.describeForUi(err).message,
            dir: null,
            file: chapter.file,
            bytes: 0,
            cleanup: null
          };
        }
      }
      const result = await storage.saveChapterText(bookPath, chapter.file, body, {
        ensureDir: false
      });
      // 同步章节字数缓存，书架就不用为了算字数去重读整本书
      chapter.chars = result.chars;
      // 正文变了：告诉搜索索引这本书要重建（不 await，索引更新绝不能拖慢 / 挡住保存）。
      // A7（审计 E4）：挪到书目写盘之前——书目写失败时正文已经落盘了，索引也不能漏标记，
      // 否则搜索 / 校对拿到的是旧内容，而且这次部分成功会让后面重试少建一次索引。
      try {
        getSearchIndexStore().markDirty(bookPath);
      } catch (err) {
        // C0（审计 #3 / E1）：索引没标脏 → 搜索 / 校对可能一直拿旧正文；不能挡保存，但必须留痕。
        logError('save-derived', err, { level: 'warn', code: 'INDEX_DIRTY_FAILED' });
      }
      try {
        // WP1（E-N1/E-N2，中 #1/#2）：普通保存也轮换 .bak（上一版书目可退），并把 prepareChapterSave
        // 读到的 书目.json 身份交回去 —— 写前发现外部改了书目（同步盘 / 另一实例）就拒绝覆盖。
        await storage.writeBookMeta(bookPath, meta, { ensureDir: false, rotateBak: true, expectedStamp: prepared.metaStamp });
      } catch (metaErr) {
        // WP1（E-N1）：书目在「读 meta → 写正文 → 写 meta」之间被应用外改过。正文已经落盘，
        // 但书目这次不许覆盖外部那一版；再按一次保存会读到最新书目（新 stamp）后重试。
        // META_CHANGED 进救稿出口（项 3=A）：界面给「另存 / 复制 / 留在这里」，dirty 保持。
        if (metaErr.code === 'META_CHANGED') {
          throw Object.assign(
            new Error(
              '正文已写入磁盘，但书目在保存途中被应用外的程序改过，这次没有覆盖书目（外部那一版原样保留）；' +
                '再按一次保存会读入最新书目后重试'
            ),
            { code: 'META_CHANGED', mtimeMs: result.mtimeMs }
          );
        }
        // A7（审计 E4）：正文已经写进磁盘、书目没更新成功。不能把这次保存整体当失败——
        // 渲染层会以为正文没保存（关窗时可能让作者重写 / 丢弃刚写的内容）。回可判别的部分成功：
        // code=META_SAVE_FAILED + bodySaved:true + chars/file（见 fail() 的白名单透传），
        // 界面提示「正文已写入磁盘，但书目更新失败，可重试保存」，dirty 保持，再按保存会重试。
        throw Object.assign(
          new Error(`正文已写入磁盘，但书目更新失败（${errorText.describeForUi(metaErr).message}），可再按一次保存重试`),
          { code: 'META_SAVE_FAILED', bodySaved: true, chars: result.chars, file: chapter.file, mtimeMs: result.mtimeMs }
        );
      }
      // 每日字数统计：只记这次保存带来的正字数增量（删字不扣今天的进度）。
      // C0（审计 #3 / E1）：基线缺失时明确标记（界面在「已保存」旁弱提示「本次字数未计入」）；
      // 统计写盘失败绝不影响正文保存，只记一条 warn 日志并把原因带回去。
      const charsDelta = statsLib.saveCharsDelta(previousChars, result.chars);
      let stats = null;
      let statsDelta = charsDelta.delta;
      let statsError = null;
      const recordedStats = await statsLib.recordSaveChars(getStatsStore(), {
        day: statsLib.localDayKey(),
        bookId: meta.id,
        delta: statsDelta
      });
      if (recordedStats.ok) {
        stats = statsSummaryPayload(recordedStats.recorded.stats, cfg);
      } else {
        const statsErr = recordedStats.error;
        // MC-2（五-L21）：同 capture:commit-record 的 statsError —— 原始 message 只进日志（下面 logError
        // 自己脱敏），跨 IPC 的那份必须过 error-text，别把统计文件的绝对路径带进渲染层。
        statsError = errorText.describeForUi(statsErr).message;
        logError('save-derived', statsErr, { level: 'warn', code: 'STATS_RECORD_FAILED' });
      }
      // 保存也算「写作过」：书架「继续上次写作」的时间戳跟着更新（只写配置，不碰书库）
      await rememberRecentBook(bookPath, {
        title: meta.title,
        chapterId: chapter.id,
        chapterIndex: meta.chapters.indexOf(chapter),
        chapterName: chapter.name
      });
      if (session) {
        storage.openBookRegistry.touch(session.id);
        // C5：正文保存成功的回执时间——关窗时主进程用它和「变脏时间」比对（见 app:close-ready）
        session.lastSaveAt = Date.now();
      }
      return {
        ...result,
        file: chapter.file,
        snapshot,
        stats,
        statsDelta,
        statsError,
        // C0（审计 #3 / E1）：旧章字数读不到 → 这次增量按 0 记，界面据此弱提示「本次字数未计入」
        charsBaselineMissing: charsDelta.baselineMissing
      };
    });
  }, { mutation: MUTATION.SAVE }); // 审计修复 #38（O6）：保存成功要广播 shelf:changed（跨窗口书架字数不再滞后）

  // 自定义正文字体：只允许字体文件，读成 base64 交给渲染层的 FontFace 加载（渲染层仍无 fs）
  // 代码审计 F1：font:pick 选中的路径只记在内存里（按窗口分开），font:read 只认「这次选的 /
  // 当前书的 bookDisplay / 全局配置」这三种主进程自己知道的路径，渲染层传进来的路径一律不看。
  // B18（WP-29）：pickedFontPaths 本身在模块级（关窗清理要在 createWindow 里做）。
  // B9（v1.8.0 WP-29）：字体文件读盘 + base64 编码缓存（最近 2 份，按 realpath + mtime + size 失效）。
  // 审计修复 #54（P11）：另加 base64 驻留预算（core/font-cache.js 默认 40 MB）—— 两份 24 MB 字体的
  // base64 加起来 ≈ 64 MB 常驻，超预算时只保留最近使用的那一份大字体；小字体仍可两份都命中。
  // 仍然每次都做 realpath / 扩展名 / 大小闸门 / 来源校验，只跳过「同一个没变的文件」的二次读取。
  const fontReadCache = createFontReadCache({ maxEntries: 2 });

  function rememberPickedFont(windowId, fontPath) {
    const id = String(windowId == null ? '' : windowId);
    if (!id) return;
    const picked = typeof fontPath === 'string' ? fontPath.trim() : '';
    if (!picked) {
      pickedFontPaths.delete(id);
      return;
    }
    pickedFontPaths.set(id, picked);
  }

  // 读一次就清掉：选字体后的那一趟「预览」读到文件即用完；之后按书目 / 全局配置解析，
  // 免得同一个窗口里换书时把上一本书刚选的字体带过去。
  function takePickedFont(windowId) {
    const id = String(windowId == null ? '' : windowId);
    if (!id) return '';
    const picked = pickedFontPaths.get(id) || '';
    pickedFontPaths.delete(id);
    return picked;
  }

  handle('font:pick', async () => {
    const session = flowSession();
    const { canceled, filePaths } = await showOpenDialog({
      title: '选择正文字体文件',
      buttonLabel: '使用这个字体',
      properties: ['openFile'],
      filters: [{ name: '字体文件', extensions: ['ttf', 'otf', 'ttc'] }]
    });
    if (canceled || !filePaths || !filePaths.length) {
      if (session) rememberPickedFont(session.id, '');
      return { canceled: true };
    }
    const picked = filePaths[0];
    if (session) rememberPickedFont(session.id, picked);
    // C1（审计 S1）：字体路径纳入配置来源校验——记下「这个窗口刚选中的字体」，设置里保存
    // config:set / book:set-display 时只认这个值（或原值），渲染层伪造的路径会被忽略。
    rememberPickedConfigPath('editorCustomFontPath', picked);
    return { canceled: false, path: picked, name: path.basename(picked) };
  });

  handle('font:read', async () => {
    const session = flowSession();
    const picked = takePickedFont(session && session.id);
    const cfg = await getConfig();
    let bookEntry = null;
    const openBookPath = session ? storage.openBookRegistry.getBook(session.id) : null;
    if (openBookPath) {
      try {
        const meta = await storage.readBookMeta(openBookPath);
        const bookId = meta && meta.id ? String(meta.id) : '';
        if (bookId) bookEntry = (cfg.bookDisplay && cfg.bookDisplay[bookId]) || null;
      } catch {
        // 书目读不到就按全局设置来：字体加载失败最多退回内置字体，不影响打开书 / 写作
        bookEntry = null;
      }
    }
    const source = fontPolicy.resolveFontSource({ picked, book: bookEntry, global: cfg });
    if (!source.path) {
      throw new storage.StorageError('BAD_FONT', '还没有可用的自定义字体，请先在设置里选择字体文件');
    }
    const resolved = path.resolve(source.path);
    // C1（审计 S1）：realpath 之后再校验扩展名与大小——配置 / 对话框里的路径如果是符号链接 /
    // 目录联接，真正读的必须是它指向的那个文件；realpath 后扩展名不像字体的直接拒绝。
    // 返回值不再带「配置里记的绝对路径」（只有渲染层自己刚选的那一趟才回 path，供渲染层核对
    // 「读回来的是不是我刚选的那份」，见 renderer/font-logic.js 的 shouldRetryFontRead）。
    const realPath = await fs.realpath(resolved);
    if (!fontPolicy.isFontFile(realPath)) {
      throw new storage.StorageError('BAD_FONT', '只支持 .ttf / .otf / .ttc 字体文件');
    }
    // E2（审计 #28）：扩展名校验之后 open 一次，fstat（是不是文件 / 24MB 大小闸）与 readFile
    // 都走同一个句柄 —— 校验的和读的必是同一个文件，没有 realpath → stat → readFile 的 TOCTOU 窗口
    // （对齐 storage.writeBookMeta 的 .bak 轮换模式）。错误码 / 文案与改前一致。
    const loaded = await fontReadLib.openFontFile(fs, realPath, {
      validate(handleStat) {
        if (!handleStat.isFile()) throw new storage.StorageError('BAD_FONT', '选中的不是一个字体文件');
        if (!fontPolicy.isFontSizeAllowed(handleStat.size)) {
          throw new storage.StorageError('FONT_TOO_BIG', '字体文件太大（超过 24MB），请换一个小一点的');
        }
      }
    });
    try {
      const stat = loaded.stat;
      // B9（v1.8.0 WP-29）：命中缓存就跳过 24MB 读盘 + ~32MB base64 编码（key 含 realpath / mtime / size，
      // 字体文件被外部替换也会重新读）。缓存只存 name/size/base64，source 与 path 仍按本次解析结果现算。
      const cacheKey = fontReadCache.keyOf(realPath, stat);
      const cached = fontReadCache.get(cacheKey);
      let fontName;
      let base64;
      if (cached) {
        fontName = cached.name;
        base64 = cached.base64;
      } else {
        const buffer = await loaded.read();
        fontName = path.basename(realPath);
        base64 = buffer.toString('base64');
        fontReadCache.put(cacheKey, { name: fontName, size: stat.size, base64 });
      }
      const payload = {
        name: fontName,
        size: stat.size,
        base64,
        source: source.source
      };
      // 只有「刚在对话框里选的」这一趟回 path（渲染层本来就从 font:pick 拿到过这个路径）；
      // 按书 / 全局配置解析出来的路径绝不回传，避免把配置里的本机路径带进渲染层。
      if (source.source === 'picked') payload.path = resolved;
      return payload;
    } finally {
      await loaded.close().catch(() => {});
    }
  });

  if (automation) {
    // 仅自检：模拟「在系统字体对话框里选中某个文件」（E2E 没法真的点原生对话框）。
    // 和 update:test-mock 一样只在 automation 下注册，生产环境这个频道不存在。
    handle('font:test-pick', async (fontPath) => {
      const session = flowSession();
      const picked = typeof fontPath === 'string' ? fontPath.trim() : '';
      if (!session || !picked) return false;
      rememberPickedFont(session.id, picked);
      // C1：自检也走同一份「刚选中的路径」登记（生产不注册这个频道）
      rememberPickedConfigPath('editorCustomFontPath', picked);
      return { path: path.resolve(picked), name: path.basename(picked) };
    });
  }

  handle('shell:pick-folder', async () => {
    const { canceled, filePaths } = await showOpenDialog({
      title: '选择书架目录',
      properties: ['openDirectory', 'createDirectory']
    });
    if (canceled || !filePaths || !filePaths.length) return null;
    // v0.9 C-2b：书架目录同样只认这次对话框选中的路径（设置里的输入框是只读的）
    rememberPickedConfigPath('booksRoot', filePaths[0]);
    return filePaths[0];
  });

  // 诊断日志（提案 7.4）：目录 / 文件清单给设置弹层显示；「打开日志文件夹」由主进程调资源管理器。
  // 日志只存在于 userData/logs，渲染层拿不到也写不了任何文件。
  handle('logs:info', async () => {
    const store = getLogStore();
    if (!store) throw new storage.StorageError('LOG_UNAVAILABLE', '日志目录暂时不可用');
    return store.info();
  });

  handle('logs:open-folder', async () => {
    const store = getLogStore();
    if (!store) throw new storage.StorageError('LOG_UNAVAILABLE', '日志目录暂时不可用');
    await fs.mkdir(store.dir, { recursive: true });
    // 自检环境不要真的在作者桌面上弹出资源管理器窗口，只回报目录
    if (isE2E) return { dir: store.dir, opened: false, note: '自检环境不打开资源管理器' };
    const err = await shell.openPath(store.dir);
    if (err) throw new storage.StorageError('OPEN_FAILED', errorText.cleanText(errorText.redactPaths(err)));
    return { dir: store.dir, opened: true };
  });

  // 崩溃恢复（v1.8.2 WP5 / N1，拍板项 1=B）：草稿只写 userData，渲染层没有 fs 权限。
  // 开关没开时 crash:draft 直接回 { saved:false }，目录 / 标记 / 草稿一个字节都不写。
  handle('crash:draft', async (payload) => {
    const cfg = await getConfig();
    if (!cfg || cfg.crashDraftEnabled !== true) return { saved: false, code: 'DISABLED' };
    const store = getCrashDraftStore();
    if (!store) return { saved: false, code: 'DRAFT_UNAVAILABLE' };
    // 正文上限 / 形状都在 core/crash-draft 里统一清洗（与正文 500 万字同口径），不抛给 IPC 层。
    const result = await store.writeDraft(payload);
    if (!result.ok) return { saved: false, code: result.code, message: result.message };
    return { saved: true, draftId: result.draftId, chars: result.chars };
  });
  handle('crash:recovery', async () => {
    const cfg = await getConfig();
    const enabled = Boolean(cfg && cfg.crashDraftEnabled === true);
    if (!enabled) return { enabled: false, previousExitAbnormal: false, drafts: [] };
    const store = getCrashDraftStore();
    if (!store) return { enabled: true, previousExitAbnormal: crashPreviousAbnormal, drafts: [] };
    return { enabled: true, previousExitAbnormal: crashPreviousAbnormal, drafts: await store.listDrafts() };
  });
  handle('crash:read-draft', async (draftId) => {
    const cfg = await getConfig();
    if (!cfg || cfg.crashDraftEnabled !== true) return { draft: null, code: 'DISABLED' };
    const store = getCrashDraftStore();
    if (!store) return { draft: null, code: 'DRAFT_UNAVAILABLE' };
    const result = await store.readDraft(draftId);
    if (!result.ok) return { draft: null, code: result.code, message: result.message };
    return { draft: result.draft };
  });
  handle('crash:discard-draft', async (target) => {
    const store = getCrashDraftStore();
    if (!store || !target || typeof target !== 'object') return { removed: 0 };
    if (typeof target.draftId === 'string' && target.draftId) return store.removeDraft(target.draftId);
    if (typeof target.bookPath === 'string' && typeof target.chapterId === 'string') {
      return store.removeFor({ bookPath: target.bookPath, chapterId: target.chapterId });
    }
    return { removed: 0 };
  });

  // 正文全文搜索（提案 7.3）：书架搜索升级成能搜正文。
  // 索引存 userData/search-index.json，只含「双字哈希位图 + 每章 mtime/size」，不含正文；
  // 书 / 章一动（保存、改名、删除、外部改 txt）由下一次校验自动增量更新，作者不需要手动操作。
  handle('search:index-status', async () => {
    await getConfig();
    return getSearchIndexStore().status();
  });

  handle('search:ensure-index', async (options) => {
    const cfg = await getConfig();
    return getSearchIndexStore().ensure({
      booksRoot: cfg.booksRoot,
      force: Boolean(options && options.force),
      // 回书架时做深度校验（逐章 stat，发现外部改过的 txt）；搜索自己只用轻量校验
      deep: !(options && options.deep === false),
      onProgress: sendSearchProgress
    });
  });

  handle('search:content', async (query, options) => {
    // A4（审计 E7）：查找词补上 core/ipc-limits.js 的 1 万字上限（search 通道里唯一没走这层的入口）。
    // null / undefined 归一成空串（与旧行为一致：空查询 = 没有命中）；limit 下游已钳 1–60，这里不动。
    const safeQuery = ipcLimits.assertQuery(query);
    const focus = sanitizeSearchFocus(options && options.focus);
    const cfg = await getConfig();
    return getSearchIndexStore().search({
      booksRoot: cfg.booksRoot,
      query: safeQuery,
      limit: options && options.limit,
      ...(focus ? { focus } : {})
    });
  });

  // 自动更新轻量版（提案 7.1）：手动检查 GitHub Release → 提示有新版本 → 打开下载页。
  // 不自动下载 / 安装；检查结果只在内存里（lastUpdateLaunch），渲染层不能传任意 URL 进来。
  handle('update:check', async () => {
    const result = await updateCheckSingleFlight(() =>
      updateLib.checkForUpdates({
        currentVersion: app.getVersion(),
        fetchText: fetchReleaseResponse
      })
    );
    const releaseUrl = result && result.status === 'update' ? updateLib.safeReleaseUrl(result.releaseUrl) : '';
    lastUpdateLaunch = releaseUrl
      ? { url: releaseUrl, latestVersion: result.latestVersion, at: Date.now() }
      : null;
    return result;
  });

  handle('update:open-download', async () => {
    if (!lastUpdateLaunch) {
      return { opened: false, url: '', message: '还没有检查到新版本，请先点「检查更新」' };
    }
    const url = updateLib.safeReleaseUrl(lastUpdateLaunch.url);
    if (!url) {
      return { opened: false, url: '', message: '下载页地址不可用，请到 GitHub Releases 手动查看' };
    }
    // 自检环境不要真的在作者桌面上打开浏览器，只回报地址
    if (automation) return { opened: false, url, note: '自检环境不打开浏览器' };
    try {
      await shell.openExternal(url);
    } catch (err) {
      return { opened: false, url, message: `打不开浏览器：${errorText.describeForUi(err).message}` };
    }
    return { opened: true, url };
  });

  if (automation) {
    // 仅自检 / 截图：注入假网络响应（E2E 绝不真连 GitHub；生产环境这个频道不会注册）
    handle('update:test-mock', async (mock) => {
      updateMock = mock && typeof mock === 'object' ? mock : null;
      return true;
    });
  }
}

// ---------- Electron 安全加固（v0.9 C-1） ----------
// 窗口级（每个 webContents）：
//   · 不允许开新窗口（window.open / target=_blank 一律 deny）；
//   · 不允许导航离开本页（点外链、被注入的 location 赋值都拦在本页内）；
//   · 不允许挂 <webview>（真挂了就先抹掉 preload / Node 能力再拦下）。
// 会话级：浏览器权限（摄像头 / 麦克风 / 通知 / 定位 / 剪贴板读取 / 全屏 / 传感器…）一律拒绝 ——
//   注意 Electron 的默认行为是「没有权限处理器就一律允许」，所以必须显式拒绝。
// 这些约束统一挂在 app 的 web-contents-created / session-created 上兜底：以后谁再加窗口或
// 自定义 partition，也自动带上同样的开关，不会再出现「新窗口忘写 setWindowOpenHandler」这种缺口。
// 期望值来自 core/security-policy.js（单测断言同一份常量，E2E 在真实 Electron 里复核）。
const hardenedContents = new WeakSet();
const hardenedSessions = new WeakSet();
// 实际注册给 Electron 的处理器留个引用：自检要直接调它们，证明「真的拒绝」而不是「以为拒绝了」
const permissionHandlers = { request: null, check: null };
let lastPermissionDenial = null; // 只留最近一条（不含本机路径），自检断言用

function hardenWebContents(contents) {
  if (!contents || contents.isDestroyed() || hardenedContents.has(contents)) return;
  hardenedContents.add(contents);
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event, webPreferences) => {
    // 双保险：就算哪天误开了 webviewTag，也不让被挂的 webview 带上 preload / Node 能力
    if (webPreferences && typeof webPreferences === 'object') {
      delete webPreferences.preload;
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
    }
    event.preventDefault();
  });
}

function hardenSession(ses) {
  if (!ses || hardenedSessions.has(ses)) return;
  hardenedSessions.add(ses);
  permissionHandlers.request = (contents, permission, callback, details) => {
    try {
      lastPermissionDenial = securityPolicy.permissionLogRecord(
        permission,
        details && details.requestingOrigin
      );
      logError(
        'permission-denied',
        {
          code: 'PERMISSION_DENIED',
          message: `拒绝权限请求：${lastPermissionDenial.permission}（来源 ${lastPermissionDenial.origin}）`
        },
        { level: 'info' }
      );
    } catch {
      /* 记日志失败也必须照样拒绝 */
    }
    callback(false);
  };
  // 权限「检查」（Permissions API / 页面初始化时查询）同样一律 false
  permissionHandlers.check = () => securityPolicy.deniesPermission();
  try {
    ses.setPermissionRequestHandler(permissionHandlers.request);
  } catch (err) {
    logError('permission-handler', err, { level: 'warn' });
  }
  try {
    ses.setPermissionCheckHandler(permissionHandlers.check);
  } catch (err) {
    logError('permission-handler', err, { level: 'warn' });
  }
  // 设备权限（串口 / HID / USB / 蓝牙）走另一条通道，Electron 的 request 处理器管不到它
  if (typeof ses.setDevicePermissionHandler === 'function') {
    try {
      ses.setDevicePermissionHandler(() => false);
    } catch (err) {
      logError('permission-handler', err, { level: 'warn' });
    }
  }
}

// ---------- 窗口 ----------
// 每个窗口一个会话；可选直接在第二窗口打开某本书（书卡右键「在新窗口打开」）。
// 新窗口的书在 BrowserWindow 创建后立刻登记（同步），再加载页面 —— 连点两次也只会开一个。
async function createWindow({ bookPath = null, cascade = false, runAutomationFlow = false } = {}) {
  const cfg = await getConfig();
  let bounds = null;
  // V89（1.7.2 D6）：上次退出时是最大化 → 位置 / 大小照旧恢复，显示前再补一次 maximize()
  // （见下面的 ready-to-show）。多窗口 / 级联窗口不读这个标记：它只属于「最近使用的窗口」。
  let restoreMaximized = false;
  if (windowSessions.size === 0) {
    bounds = clampBounds(cfg.windowBounds);
    restoreMaximized = Boolean(cfg.windowBounds) && cfg.windowBounds.maximized === true;
  } else if (cascade) {
    const focused = BrowserWindow.getFocusedWindow();
    const sourceBounds =
      focused && !focused.isDestroyed()
        ? focused.getBounds()
        : mostRecentSession() && !mostRecentSession().win.isDestroyed()
          ? mostRecentSession().win.getBounds()
          : null;
    if (sourceBounds) {
      bounds = clampBounds({
        x: sourceBounds.x + 32,
        y: sourceBounds.y + 32,
        width: sourceBounds.width,
        height: sourceBounds.height
      });
    }
  }

  const themeName = windowChrome.themeNameOf(cfg.editorPaper);
  const browserWin = new BrowserWindow({
    ...(bounds || { width: 1200, height: 760 }),
    minWidth: 960,
    minHeight: 620,
    title: '章回',
    backgroundColor: windowChrome.backgroundFor(themeName),
    show: false,
    autoHideMenuBar: true,
    // 自绘标题栏（1.3.0 T6 / 规范 I-07）：隐藏原生标题栏，但系统的最小化 / 最大化 / 关闭仍由
    // Windows 画（titleBarOverlay）——Snap Layouts、Win+方向键、双击最大化都还是系统的。
    // 网页内容铺到窗口最上面，拖拽区 / 让位规则在 renderer/styles.css 里（env(titlebar-area-*)）；
    // 配色跟 6 套纸色走（core/window-chrome.js，失焦时纸色 -2% / 字形淡一档）。不引入 Mica / 亚克力。
    titleBarStyle: 'hidden',
    titleBarOverlay: windowChrome.overlayFor(themeName),
    // 安全开关（sandbox / contextIsolation / webSecurity / nodeIntegration…）的唯一来源：
    // core/security-policy.js。这里不另写一份，避免以后两边改歪。
    // E5（审计 WP-11）：4 个自检 API 的暴露开关跟着 automation 走（--e2e / --bench / --contrast /
    // --screenshot）；普通启动与打包版 automation 恒 false → preload 不挂这 4 个键，
    // 主进程也只在 automation 分支注册对应频道。
    webPreferences: securityPolicy.windowPreferences(path.join(__dirname, 'preload.js'), {
      testHooks: automation
    })
  });
  const session = createSession(browserWin);
  const webContentsId = browserWin.webContents.id;
  if (runAutomationFlow && automation) automationWin = browserWin;

  // 先在登记表里占住这本书（同步完成，加载页面前生效），失败就销毁这个刚建的窗口
  if (bookPath) {
    const registered = storage.registerOpenBook(session.id, bookPath);
    if (!registered.ok) {
      windowSessions.delete(session.id);
      webContentsSessions.delete(webContentsId);
      storage.openBookRegistry.unregisterWindow(session.id);
      if (!browserWin.isDestroyed()) browserWin.destroy();
      focusSession(sessionById(registered.ownerWindowId));
      throw new storage.StorageError(registered.code, registered.message);
    }
  }

  Menu.setApplicationMenu(null);
  browserWin.once('ready-to-show', () => {
    if (browserWin.isDestroyed()) return;
    // V89：上次是最大化就先 maximize 再 show（这时的 maximize 自己会把窗口显示出来，
    // 顺序反过来会先闪一帧普通窗口）。位置 / 大小已在 BrowserWindow 构造时按 windowBounds 恢复。
    if (restoreMaximized) browserWin.maximize();
    browserWin.show();
  });
  // 开新窗口 / 导航 / webview / 权限的约束来自上面的安全加固：app 的 web-contents-created 已经
  // 给每个新建的 webContents 挂过一次，这里再显式加固一次（hardenWebContents 幂等，不会重复挂）。
  hardenWebContents(browserWin.webContents);
  // 能填文字的地方（正文 / 章节名 / 书名 / 搜索框 / 查找替换输入框）右键出中文菜单：剪切 / 复制 / 粘贴 / 全选
  // 章节列表、书架卡片有自带的 HTML 右键菜单，这里只认 isEditable，不会冲突
  browserWin.webContents.on('context-menu', (_event, params) => {
    if (browserWin.isDestroyed()) return;
    if (textMenu.shouldShow(params)) {
      Menu.buildFromTemplate(textMenu.buildTemplate(params)).popup({ window: browserWin });
      return;
    }
    // 自绘标题栏（1.3.0 T6）：拖拽区右键 = 窗口菜单（还原 / 最小化 / 最大化 / 关闭），
    // 和原生标题栏的系统菜单对得上；输入框 / 选中文字仍然优先走上面的文字菜单。
    if (!windowChrome.isTitleBarHit(params)) return;
    Menu.buildFromTemplate(titleBarMenuTemplate(browserWin)).popup({ window: browserWin });
  });
  browserWin.webContents.on('before-input-event', (_event, input) => {
    // C6（审计 S6）：打包后的正式版不再绑定 Ctrl+Shift+I（DevTools 关闭）；开发 / E2E 照旧。
    if (packagedApp) return;
    if (input.type === 'keyDown' && input.control && input.shift && String(input.key).toLowerCase() === 'i') {
      browserWin.webContents.toggleDevTools();
    }
  });
  browserWin.on('closed', () => {
    // B3：窗口关了，这扇窗口最后切到的章还可能在防抖里，先落盘（失败了也不影响关窗）
    void lastOpenWrites.flushAll().catch(() => {});
    clearTimeout(session.closeTimer);
    clearTimeout(session.boundsTimer);
    windowSessions.delete(session.id);
    webContentsSessions.delete(webContentsId);
    // 这个窗口「刚在对话框里选中的配置路径」登记也一起清掉（只在内存里）
    pickedConfigPaths.forget(session.id);
    // B18（v1.8.0 WP-29）：字体路径登记同属「只在内存里、按窗口」的临时值；以前只在 font:read
    // 时清，选了字体但没读就关窗会残留一条（窗口 id 可能被系统复用）。与 pickedConfigPaths 同步清理。
    pickedFontPaths.delete(session.id);
    try {
      storage.openBookRegistry.unregisterWindow(session.id);
    } catch {
      /* 登记表清理失败不影响退出 */
    }
    if (automationWin === browserWin) automationWin = null;
  });
  browserWin.on('focus', () => {
    try {
      storage.openBookRegistry.touch(session.id);
    } catch {
      /* 忽略 */
    }
    // 自绘标题栏（1.3.0 T6）：回焦时系统按钮区回到正常纸色 / 字形
    applyWindowChrome(session);
  });
  // 失焦降级（规范 I-07）：纸色 -2%、朱红降灰（网页侧在 styles.css 的 body.window-inactive 里），
  // 系统按钮区跟着换成暗一档的纸色 + 淡一档的字形色。
  browserWin.on('blur', () => applyWindowChrome(session));
  setupCloseFlow(session);

  // 渲染进程崩溃 / 窗口无响应（v1.8.2 WP5 / 审计 N1）：先记一条日志，再给恢复出口。
  // 决策在 core/crash-recovery.js（纯函数、单测覆盖）：首次崩溃自动 reload 恢复视图；
  // 60 秒内重复崩溃改成「重载 / 打开日志 / 关闭窗口」对话框，避免「崩 → 重载 → 再崩」的环。
  // 自检同样走 reload（原生对话框会把自动化挂住）；生产里对话框默认停在最安全的选项。
  const crashState = { lastReloadAtMs: 0, reloadCount: 0 };
  const reloadWindow = () => {
    if (browserWin.isDestroyed()) return false;
    try {
      browserWin.webContents.reload();
      return true;
    } catch (err) {
      logError('reload-failed', err);
      if (!browserWin.isDestroyed()) {
        const plan = crashRecovery.reloadFailureDialog({ message: (err && err.message) || String(err) });
        void showMessageBox(plan, browserWin)
          .then((response) => {
            if (plan.actions[response.response] === 'logs') void openLogFolderForRecovery();
          })
          .catch(() => {});
      }
      return false;
    }
  };
  browserWin.webContents.on('render-process-gone', (_event, details) => {
    const reason = (details && details.reason) || 'unknown';
    logError('render-process-gone', {
      code: reason,
      message: `渲染进程退出：${reason}（exitCode ${details && details.exitCode}，appCrashed ${Boolean(details && details.appCrashed)}）`
    });
    const plan = crashRecovery.decideRenderCrash({
      reason,
      nowMs: Date.now(),
      lastReloadAtMs: crashState.lastReloadAtMs,
      reloadCount: crashState.reloadCount,
      quitting: appQuitting
    });
    if (plan.action === 'reload') {
      crashState.lastReloadAtMs = plan.nextLastReloadAtMs;
      crashState.reloadCount = plan.nextReloadCount;
      // 崩溃后的 reload 要等当前事件派发完，避免在 gone 回调里同步重入 webContents。
      setImmediate(() => reloadWindow());
      return;
    }
    if (plan.action !== 'ask') return;
    crashState.reloadCount = plan.nextReloadCount;
    if (isE2E) {
      setImmediate(() => reloadWindow());
      return;
    }
    const planDialog = crashRecovery.renderCrashDialog({ reason });
    void showMessageBox(planDialog, browserWin)
      .then((response) => {
        const action = planDialog.actions[response.response];
        if (action === 'reload') {
          crashState.lastReloadAtMs = Date.now();
          crashState.reloadCount = 0;
          reloadWindow();
        } else if (action === 'logs') {
          void openLogFolderForRecovery();
        } else if (action === 'close' && !browserWin.isDestroyed()) {
          browserWin.close();
        }
      })
      .catch(() => {});
  });
  // 窗口假死（渲染层主线程被超大操作卡住）：默认继续等待，作者明确点了才强制重载。
  browserWin.on('unresponsive', () => {
    logError('unresponsive', { message: '窗口无响应（界面可能卡住）' });
    if (browserWin.isDestroyed()) return;
    if (isE2E) {
      reloadWindow();
      return;
    }
    const plan = crashRecovery.unresponsivePlan();
    void showMessageBox(plan, browserWin)
      .then((response) => {
        if (plan.actions[response.response] === 'reload') reloadWindow();
      })
      .catch(() => {});
  });

  // Windows 关机/注销：尽力而为地拦住一次，提示先保存（系统不强等应用，不能保证）。
  // 多窗口：哪个窗口有未保存修改就拦一次并让它先问；其它窗口照常。
  browserWin.on('query-session-end', (event) => {
    if (!session.dirty || browserWin.isDestroyed()) return;
    event.preventDefault();
    focusSession(session);
    sendToSession(session, 'app:close-requested');
  });

  const query = {};
  if (automation || isE2E) query.test = '1';
  if (bookPath) query.open = bookPath;
  const loadOptions = Object.keys(query).length ? { query } : undefined;
  try {
    await browserWin.loadFile(path.join(__dirname, 'renderer', 'index.html'), loadOptions);
  } catch (err) {
    // 页面都没加载出来：清掉登记，别把书锁在一个空窗口上
    windowSessions.delete(session.id);
    webContentsSessions.delete(webContentsId);
    try {
      storage.openBookRegistry.unregisterWindow(session.id);
    } catch {
      /* 忽略 */
    }
    if (!browserWin.isDestroyed()) browserWin.destroy();
    throw err;
  }

  // 窗口位置保存（防抖，避免每次拖动都写盘）；只记最近使用的窗口
  const scheduleSaveBounds = () => {
    clearTimeout(session.boundsTimer);
    session.boundsTimer = setTimeout(() => {
      saveRecentWindowBounds(session).catch(() => {});
    }, 900);
  };
  browserWin.on('resize', scheduleSaveBounds);
  browserWin.on('move', scheduleSaveBounds);

  if (runAutomationFlow && automation) await runAutomation();
  return session;
}

// ---------- 自动化驱动（截图 / E2E，v0.9 B-1） ----------
// 驱动本体在 scripts/screenshot-driver.js：只有 --screenshot / --e2e 才会走到这里，require 就放在
// 函数里（懒加载）——正常启动路径不加载它，打包配置 files 也不含 scripts/，安装版里没有这段
// 只用于开发截图 / 自检的代码。host 把窗口 / 会话 / 配置 / 剪贴板 / 关闭流状态按引用交过去，
// 行为与挪出前逐条一致（`git show 754e1a5:main.js` 可对照）。
function automationHost() {
  return {
    app,
    fs,
    path,
    isE2E,
    getConfig,
    storage,
    repair,
    exporter,
    clipboard,
    getWin: () => automationWin,
    screenshot: {
      path: screenshotPath,
      book: screenshotBook,
      chapter: screenshotChapter,
      dialog: screenshotDialog
    },
    argValue,
    createWindow: (options) => createWindow(options),
    sessionById: (windowId) => sessionById(windowId),
    focusSession: (session) => focusSession(session),
    listSessions: () => Array.from(windowSessions.values()),
    setClipboard: (value) => {
      activeClipboard = value;
    },
    setRealClose: (on) => {
      e2eRealClose = Boolean(on);
      return e2eRealClose;
    },
    // WP-09（C6）：把「关窗前保存窗口位置」拖慢若干毫秒，制造「回执已发、forceClose 还没置」
    // 的窗口给组 10 复现；0 = 恢复真实写盘耗时（生产 / 截图流程根本不调这个开关）。
    setCloseBoundsDelay: (ms) => {
      e2eCloseBoundsDelayMs = Math.max(0, Number(ms) || 0);
      return e2eCloseBoundsDelayMs;
    },
    isWindowAllClosed: () => e2eWindowAllClosed,
    getCloseReady: (windowId) =>
      windowId == null ? e2eLastCloseReady : e2eCloseReadyByWindow.get(String(windowId)),
    resetCloseReady: (windowId) => {
      if (windowId == null) {
        e2eLastCloseReady = undefined;
        e2eCloseReadyByWindow.clear();
      } else {
        e2eCloseReadyByWindow.delete(String(windowId));
      }
    },
    getPermissionHandlers: () => permissionHandlers,
    getLastPermissionDenial: () => lastPermissionDenial,
    getContentTypes: () => webContents.getAllWebContents().map((item) => item.getType())
  };
}

async function runAutomation() {
  // 懒加载：只有自动化模式才需要这份驱动（scripts/ 不进安装包，生产启动路径不会 require）
  if (isBench) {
    const benchDriver = require('./scripts/bench-driver.js');
    await benchDriver.run(automationHost());
    return;
  }
  if (isContrast) {
    const contrastDriver = require('./scripts/contrast-driver.js');
    await contrastDriver.run(automationHost());
    return;
  }
  const driver = require('./scripts/screenshot-driver.js');
  await driver.run(automationHost());
}

// ---------- 应用生命周期 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // 安全加固兜底（v0.9 C-1）：之后新建的任何 webContents / session 都自动带上同一套约束
  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents));
  app.on('session-created', (ses) => hardenSession(ses));

  app.on('second-instance', () => {
    const session = mostRecentSession();
    if (session) {
      focusSession(session);
    } else {
      createWindow({ runAutomationFlow: false }).catch((err) => {
        // C6（审计 E14）：同样走统一日志（脱敏），不打原始堆栈
        logError('window-create', err);
      });
    }
  });

  app.whenReady().then(async () => {
    setupCloseIpc();
    registerIpc();
    // 默认 session 在第一次建窗时才真正被用到，这里先加固一次（session-created 还会兜一次）
    hardenSession(electronSession.defaultSession);
    try {
      await getConfig();
    } catch (err) {
      // C6（审计 E14）：启动失败不再 console.error 原始错误 / 堆栈——走 logError（内部经
      // core/error-text 脱敏，路径只留最后一节），界面侧只保留一句固定说明。
      logError('startup-config', err);
    }
    // v1.8.2 WP5（N1）：默认关；开关打开才建立崩溃草稿会话（写运行标记 / 清过期草稿）。
    // 放在建窗之前：渲染层启动后要立刻查「上次是否异常退出」。
    await syncCrashDraftSession();
    // X8（v1.8.0 WP-40）：启动时回收上次崩溃留在 userData 的孤儿临时文件（索引 / 配置等）。
    // 只认本应用命名、非本进程 pid、且 mtime 超过 1 小时的临时文件；失败不影响启动。
    await cleanupOrphanTmpFiles(app.getPath('userData')).catch(() => {});
    // C3（WP18 / 审计中 #22）：导出目标目录（桌面 / 文档等，上次导出记在 lastExportDir）也会在
    // 崩溃 / 断电时留下同一个 `.名.tmp-pid-时间-随机` 隐藏孤儿 —— 那是用户看得见的目录，顺手
    // 按同一口径回收一次。只清本应用命名 + 非本进程 pid + 超 1 小时；目录不在 / 无权限都只跳过。
    const exportDir = config && typeof config.lastExportDir === 'string' ? config.lastExportDir.trim() : '';
    if (exportDir) await cleanupOrphanTmpFiles(exportDir).catch(() => {});
    // b8：按配置决定要不要开始后台监听剪贴板（默认关）
    syncClipboardWatch();
    // 五-M32（PM-3）：睡眠 / 唤醒通知（写作计时排除睡眠时段）
    setupPowerMonitor();
    // 每次启动记一条 info（版本 / 平台 / Electron 版本），排查反馈时先看这里
    logStartup();
    try {
      await createWindow({ runAutomationFlow: true });
    } catch (err) {
      // C6（审计 E14）：启动建窗失败走统一日志（脱敏后的错误码 / 消息 / 栈），不把原始堆栈
      // 直接丢到控制台。
      logError('startup-window', err);
      app.exit(1);
    }
    // 剪贴板捕获的全局快捷键（Ctrl+Alt+V）：界面按钮之外的第二条入口
    registerCaptureShortcut();
  }).catch((err) => {
    // A2（审计 #8 / E4）：whenReady 链顶层兜底。内部只对 getConfig / createWindow 分别兜了，
    // setupCloseIpc / registerIpc / hardenSession / syncClipboardWatch / registerCaptureShortcut
    // 任一抛错都会跳过后面全部步骤，停在「没有窗口的半初始化」状态 —— 用户只看到一句通用提示。
    // 这里统一留一条脱敏日志（logError 内部过 core/logs 的 sanitizeEntry）并退出，失败可观测。
    logError('startup', err);
    app.exit(1);
  });

  // 退出开始后任何渲染崩溃都不再自动重载（avoid 关窗过程中把页面又拉起来）
  app.on('before-quit', () => {
    appQuitting = true;
  });

  // 退出时主动注销全局快捷键，避免退出瞬间的热键残留
  app.on('will-quit', (event) => {
    // b8：后台剪贴板监听随应用关闭停止（清定时器，不留下轮询）
    stopClipboardWatch();
    try {
      globalShortcut.unregister(CAPTURE_ACCELERATOR);
    } catch {
      /* 注销失败不影响退出 */
    }
    // B3：退出前把防抖中的「上次打开章节」落盘（不等就退出会丢掉最后一次切章）。
    // v1.8.2 WP5：崩溃草稿会话也在同一处收尾（删运行标记 + 草稿），两件事都完成才真退出。
    // 拦一次退出、写完再 quit；flushAll / endSession 自己吞失败，不会卡住退出流程。
    // v1.8.3 WP9（审计 C1，中 #8）：便利数据不能当退出硬前置 —— 书在断开的网络盘 / 同步盘，或书锁
    // 被整本长操作持有时，这两个收尾可能永远不回来，退出就无限期挂住（关窗路径早有 8 秒看门狗，
    // 退出路径没有）。加 2.5 秒看门狗：到点直接 quit。超时放弃的只是 lastOpenChapterId（下次切章
    // 重建）与崩溃草稿标记清理（残留由下次启动按 pid 判「上次异常退出」），正文 / 书目不受影响。
    if (!lastOpenQuitFlushStarted && (lastOpenWrites.size() > 0 || crashSessionStarted)) {
      lastOpenQuitFlushStarted = true;
      event.preventDefault();
      const flush = lastOpenWrites.size() > 0 ? lastOpenWrites.flushAll().catch(() => {}) : Promise.resolve();
      const closeCrash = endCrashDraftSession().catch(() => {});
      void quitFlushGuard.runQuitCleanup({
        work: () => Promise.all([flush, closeCrash]),
        timeoutMs: quitFlushGuard.QUIT_FLUSH_TIMEOUT_MS,
        log: (entry) => logError('quit-flush', entry, { level: 'warn' }),
        quit: () => app.quit()
      });
    }
  });

  // 只有最后一个窗口关闭时才退出（E2E 记一笔、由场景断言后自行收尾）
  app.on('window-all-closed', () => {
    if (isE2E) {
      e2eWindowAllClosed = true;
      return;
    }
    app.quit();
  });
}
