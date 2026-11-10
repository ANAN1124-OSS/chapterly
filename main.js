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

// C2（审计 S2）：打包版判定只算一次（app.isPackaged 在 app ready 前也可读）。
// 打包后的正式版不认任何自动化开关 —— 见下面 isE2E / isBench / isContrast / screenshotPath 的注释。
const packagedApp = app.isPackaged === true;

const isE2E = !packagedApp && process.argv.includes('--e2e');
// 前端基准（v0.9 A-1）：和截图 / E2E 同一套自动化模式（临时 userData + 临时书库 + ?test=1
// 测试钩子），只是驱动换成 scripts/bench-driver.js；正常启动路径完全不受影响。
const isBench = !packagedApp && process.argv.includes('--bench');
// 对比度审计（v0.9 A-4）：同一套自动化模式（临时 userData + 临时书库 + ?test=1 测试钩子），
// 驱动换成 scripts/contrast-driver.js；只在开发自检时走，正常启动路径完全不受影响。
const isContrast = !packagedApp && process.argv.includes('--contrast');
// C2（审计 S2）：打包后的正式版一律不认自动化开关（含 --screenshot）——生产包带 --e2e 启动
// 会注册 config:test-pick / font:test-pick / update:test-mock 等自检频道（可把书架指到任意目录、
// 模拟对话框选中路径），以及「不真关窗 / 不退出」的自检行为。开发 / E2E 构建（app.isPackaged
// 为 false）完全不受影响。刻意保留的启动参数：--user-data（隔离配置目录）与 --books-root
// （把书架指到临时副本），以及 Chromium 自己的 --remote-debugging-port——安装版冒烟要用。
const booksRootOverride = argValue('books-root');
const screenshotPath = packagedApp ? null : argValue('screenshot');
const screenshotBook = argValue('book');
const screenshotChapter = argValue('chapter');
const screenshotDialog = argValue('dialog');
const automation = isE2E || isBench || isContrast || Boolean(screenshotPath);

const { createConfigStore, sanitize: sanitizeConfig, withBooksRootOverride } = require('./core/config');
const { atomicWriteFile } = require('./core/atomic');
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
const searchIndexLib = require('./core/search-index');
const updateLib = require('./core/update');
const openBooksLib = require('./core/open-books');
const fontPolicy = require('./core/font-policy');
const securityPolicy = require('./core/security-policy');
const ipcPaths = require('./core/ipc-paths');
const configGate = require('./core/config-gate');
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

let configStore = null;
let config = null;
let statsStore = null; // 每日字数统计（userData/stats.json，绝不写书库）
let configWarning = null; // 配置损坏被归档时的提示，界面启动后取一次
// 配置里「指向磁盘」的三项（书架目录 / 两份词表）只认对话框选中的值：
// 按窗口记「刚在系统对话框里选中的路径」，config:set 拿它做来源校验（v0.9 C-2b）。
// 只在内存里，窗口关闭时清掉；不写盘、不跨窗口。
const pickedConfigPaths = configGate.createPickedPathStore();
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

// ---------- b8（剪贴板联动）：后台监听 + 轻提示 ----------
// 只有作者在设置里打开 clipboardWatchEnabled 才轮询；发现「新复制的一段文字」（变化 / 非空白）
// 就记进捕获队列（每次复制一条，短文本也记），≥20 字且过冷却才通过 clipboard:changed 给一条可点提示。
// 隐私红线：只把派生信息（字数 / 条数）发给渲染层；正文用完即弃，不写日志、不落盘、不做历史。
// 生命周期跟随应用：启动时按配置启动，配置切换时启停，will-quit 清定时器。
// 2026-11-07：900ms 太稀，连续快速复制会漏拍；缩到 300ms（每拍只读一次纯文本，开销可忽略）。
const CLIPBOARD_WATCH_INTERVAL_MS = 300;
const clipboardWatcher = clipboardWatchLib.createWatcher();
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
  clipboardWatchBusy = true;
  try {
    const text = await readClipboardForWatch();
    const decision = clipboardWatcher.evaluate(text);
    // 记录与提示拆开：连续复制的几段都要各留一条（record），冷却只压轻提示（notify）。
    if (decision.record) {
      captureQueue.add(text);
      // 面板开着时「新复制立刻出现在列表里」：每次记录都发一个不含正文的轻量事件。
      // 短复制（<20 字）不走下面的 notify，靠这个事件刷新列表，否则复制了也看不见。
      const recordedPayload = { queued: captureQueue.size() };
      for (const session of windowSessions.values()) {
        try {
          if (session.win && !session.win.isDestroyed()) {
            session.win.webContents.send('clipboard:recorded', recordedPayload);
          }
        } catch {
          /* 单个窗口发不出去不影响其它窗口 */
        }
      }
    }
    if (!decision.notify) return;
    // 只发字数字段（不发正文）；queued 是「本次运行已记几条」的计数，也不含正文。
    const payload = { chars: decision.chars, queued: captureQueue.size() };
    for (const session of windowSessions.values()) {
      try {
        if (session.win && !session.win.isDestroyed()) {
          session.win.webContents.send('clipboard:changed', payload);
        }
      } catch {
        /* 单个窗口发不出去不影响其它窗口 */
      }
    }
  } finally {
    clipboardWatchBusy = false;
  }
}

// 打开面板前补一拍（2026-11-07）：作者刚复制就点「捕获」时，可能正好落在两拍轮询之间；
// 打开面板前主动读一次剪贴板，把这一条补进队列。不发送轻提示（面板马上要开了）。
async function flushClipboardWatchOnce() {
  if (!clipboardWatchEnabledNow()) return { enabled: false, recorded: false };
  if (clipboardWatchPriming || clipboardWatchBusy) return { enabled: true, recorded: false, busy: true };
  clipboardWatchBusy = true;
  try {
    const text = await readClipboardForWatch();
    const decision = clipboardWatcher.evaluate(text);
    if (decision.record) captureQueue.add(text);
    return { enabled: true, recorded: Boolean(decision.record), chars: decision.chars };
  } catch {
    return { enabled: true, recorded: false };
  } finally {
    clipboardWatchBusy = false;
  }
}

function stopClipboardWatch() {
  if (clipboardWatchTimer) {
    clearInterval(clipboardWatchTimer);
    clipboardWatchTimer = null;
  }
  clipboardWatchPriming = false;
  clipboardWatchBusy = false;
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
  clipboardWatchTimer = setInterval(pollClipboardWatch, CLIPBOARD_WATCH_INTERVAL_MS);
  if (clipboardWatchTimer.unref) clipboardWatchTimer.unref();
  void readClipboardForWatch().then(
    (text) => {
      if (!clipboardWatchTimer) return; // 读完之前被关掉了：别再动基线
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

// 书架数据变了：其它窗口若正停在书架就刷新；在写作页的窗口回书架时会自己刷新
function notifyShelfChanged(session, reason = '') {
  broadcast('shelf:changed', { reason }, { except: session ? session.id : null });
}

// 只保存「最近使用的窗口」的位置 / 大小（下次启动按它恢复）
async function saveRecentWindowBounds(session) {
  if (!session || session.win.isDestroyed()) return false;
  const recentId = storage.openBookRegistry.mostRecentWindow();
  if (recentId && String(recentId) !== String(session.id) && windowSessions.size > 1) return false;
  try {
    await configStore.set({ windowBounds: session.win.getBounds() });
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
const RENDERER_FAILURE_KINDS = new Set(['unhandledrejection', 'ui-chain']);

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
    if (length > updateLib.MAX_RESPONSE_CHARS) return { status: res.status, text: '' };
    const text = await res.text();
    return { status: res.status, text: text.slice(0, updateLib.MAX_RESPONSE_CHARS + 1) };
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
  // 保存失败单独记一条（错误码 + 章节文件名，绝不含正文），方便排查「保存失败」类反馈
  logError(channel === 'chapter:save' ? 'save-failed' : 'ipc-error', err, { channel });
  // A7（审计 E4）：部分成功（chapter:save 的 META_SAVE_FAILED）要把「正文已落盘」的证据回给渲染层，
  // 界面据此提示「正文已写入磁盘、书目更新失败、可重试保存」。只透传白名单字段（file 只是章节文件名），
  // 原始错误 / 路径仍然只进日志。
  if (described.code === 'META_SAVE_FAILED' && err && err.bodySaved === true) {
    const partial = { ok: false, code: described.code, message: described.message, bodySaved: true };
    if (Number.isFinite(Number(err.chars))) partial.chars = Math.max(0, Math.round(Number(err.chars)));
    if (typeof err.file === 'string') partial.file = err.file;
    return partial;
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
        // 书架数据可能变了（字数 / 章节 / 书名）：其它窗口的书架跟着刷新
        if (mutation && channel !== 'book:set-last') notifyShelfChanged(session, channel);
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

// 标题栏右键菜单（还原 / 最小化 / 最大化 / 关闭）。「移动 / 大小」仍用 Windows 自带的 Alt+Space
// 系统菜单——这两个动作要走系统模态循环，Electron 没有暴露。
function titleBarMenuTemplate(win) {
  const alive = () => win && !win.isDestroyed();
  return windowChrome.menuTemplate({
    maximized: Boolean(alive() && win.isMaximized()),
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
    configWarning = configStore.takeLoadWarning();
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
function statsSummaryPayload(stats, cfg, now = new Date()) {
  return {
    ...statsLib.summary(stats, { goal: cfg.dailyGoal, now }),
    streak: statsLib.streak(stats, { now }),
    writeDurationEnabled: cfg.writeDurationEnabled === true
  };
}

// 记住这次导出保存到的目录（下次导出默认还开在这里）；记不住也绝不影响导出结果。
async function rememberExportDir(dir) {
  if (!dir) return;
  const cfg = await getConfig();
  if (dir === cfg.lastExportDir) return;
  try {
    const updated = await configStore.set({ lastExportDir: dir });
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
    const current = await configStore.get();
    const prev = current.lastBook;
    // 打开书时 open + set-last 会连着报同一个位置：5 秒内不重复写盘（换章照常更新）
    if (prev && prev.path === payload.path && prev.chapterId === payload.chapterId && now - prev.at < 5000) {
      return false;
    }
    // 迟到的切章记录不许盖掉更晚的「上次写作」位置（多窗口：A 保存得更晚，B 的旧切章不能翻上去）
    if (prev && Number.isFinite(Number(prev.at)) && Number(prev.at) > payload.at) return false;
    const updated = await configStore.set({ lastBook: payload });
    applyConfig(updated);
    return true;
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
const lastOpenWrites = createKeyedDebouncer({
  delayMs: LAST_OPEN_DEBOUNCE_MS,
  save: async ({ bookPath, chapterId }) => {
    // 只落「书目.json 的 lastOpenChapterId」；书架级「继续上次写作」（写 config.json）在
    // book:set-last 当下就写掉了——配置很小，不再延迟，免得别的只读比对被迟到写盘干扰。
    return storage.setLastOpenChapter(bookPath, chapterId);
  }
});

function bookKeyOf(bookPath) {
  return path.resolve(String(bookPath)).toLowerCase();
}

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
      const { response } = await showMessageBox(
        {
          type: 'warning',
          title: '编辑器无响应',
          message: '保存流程没有在 3 秒内完成。',
          detail: '继续等待通常更安全；强制退出可能丢失未保存的内容。',
          buttons: ['继续等待', '强制退出'],
          defaultId: 0,
          cancelId: 0
        },
        browserWin
      );
      if (response === 1) {
        session.closePending = false;
        session.forceClose = true;
        if (!browserWin.isDestroyed()) browserWin.destroy();
      } else {
        session.closePending = false;
      }
    }, 3000);
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
    const savedAfterDirty = session.lastSaveAt > 0 && session.lastSaveAt > session.dirtyAt;
    const okToClose = Boolean(allowed) && (!session.dirty || savedAfterDirty);
    if (Boolean(allowed) && !okToClose) {
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
function registerIpc() {
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
  handle('app:warning', async () => {
    const warning = configWarning;
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

  // 改配置（v0.9 C-2b）：显示设置 / 统计 / 模板这些随便改，但「指向磁盘」的三项
  // （书架目录 + 两份词表）只认「这个窗口刚在系统对话框里选中的值」或「与原值相同 / 清空」。
  // 设置界面本来就只有「选择…」按钮（三个输入框都是只读的），所以正常用起来毫无区别；
  // 被注入的脚本想借 config:set 让主进程去读写别的目录 / 文件，会被 core/config-gate.js 挡掉。
  handle('config:set', async (patch) => {
    const current = await getConfig();
    const previousRoot = current.booksRoot;
    const session = flowSession();
    const gated = configGate.filterPathPatch(patch, {
      current,
      picked: session ? pickedConfigPaths.snapshot(session.id) : null
    });
    // 只把放行的字段交给配置仓库：被拒的字段保留原值，正常字段照旧生效。
    // A3（审计 E3）：先把目标书架目录建出来（建不出来就报错、配置一个字都不写），再写盘。
    // 旧顺序是「configStore.set 写盘成功 → fs.mkdir」，目录建不出来时界面看到「保存失败」，
    // 但配置已经落盘——重启后书架指向一个不存在的目录，作者会以为「书没了」。
    // 目标目录按「当前配置 + 放行后的 patch」走同一份 sanitize 算，和写盘后的 config.booksRoot 一致。
    // 目标目录同样的口径：过装饰层——设置了 --books-root 时它就是覆盖目录，没设置时就是 sanitize 的结果。
    const targetRoot = decorateConfig(sanitizeConfig({ ...current, ...gated.patch })).booksRoot;
    await fs.mkdir(targetRoot, { recursive: true });
    const next = await configStore.set(gated.patch);
    const nextConfig = applyConfig(next);
    // A4（审计 #11 / O3、P6）：换了书架根目录后，旧根下的书锁条目没有复用价值——主动回收空闲条目
    // （正在跑 / 正在排队的链绝不拆，它们 settle 后自己回收，这里只是尽早腾掉 Map 位置）。
    if (path.resolve(nextConfig.booksRoot).toLowerCase() !== path.resolve(previousRoot).toLowerCase()) {
      storage.clearBookLocks();
    }
    // b8：设置里打开 / 关闭「后台监听剪贴板」立即生效（幂等）
    syncClipboardWatch();
    if (gated.rejected.length) logRejectedConfigPaths(gated.rejected);
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
      pollClipboardWatch();
      return true;
    });
  }

  // 每日字数统计摘要：今天多少字 + 近 30 天（含今天）+ 当月码字日历 + 连续写作天数。
  // 统计文件在 userData，不在书库；月视图只读，切换月份走 stats:calendar。
  handle('stats:get', async () => {
    const cfg = await getConfig();
    const stats = await getStatsStore().get();
    const now = new Date();
    return {
      ...statsSummaryPayload(stats, cfg, now),
      calendar: statsLib.monthView(stats, { now, goal: cfg.dailyGoal })
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
        goal: cfg.dailyGoal
      }),
      streak: statsLib.streak(stats, { now })
    };
  });
  // 写作时长（v0.8-2）：渲染层在计时暂停 / 保存 / 每 30 秒上报一次整秒。
  // 默认关：关着时只读 stats.json 算一份摘要回给界面（不记时长、不写盘），旧用户行为完全不变。
  // 只记秒数，不接收正文、按键或任何内容；写盘仍走 core/atomic（和字数共用串行队列）。
  handle('stats:duration', async (request) => {
    const cfg = await getConfig();
    const now = new Date();
    const day = statsLib.localDayKey(now);
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
      disabled: false,
      day: recorded.day,
      stats: statsSummaryPayload(recorded.stats, cfg, new Date())
    };
  });

  // 灵感箱（碎片速记）：书架根目录 _碎片 里的普通 txt。
  // 不传路径进来，文件名由主进程按日期 + 当天序号生成；写盘走 core/atomic，不碰 书目.json / 章节文件。
  handle('fragments:list', async () => {
    const cfg = await getConfig();
    return fragmentsLib.createFragmentStore(cfg.booksRoot).list();
  });
  handle('fragments:create', async (text) => {
    const cfg = await getConfig();
    return fragmentsLib.createFragmentStore(cfg.booksRoot).create(text);
  });
  handle('fragments:read', async (name) => {
    const cfg = await getConfig();
    return fragmentsLib.createFragmentStore(cfg.booksRoot).read(name);
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
    // 单条上限沿用捕获正文上限（2026-11-08 起 30 万字）：入了队的记录本来就 ≤30 万字，直捕超限在
    // 渲染层已被引导去「导入小说」；这里再挡一次是防手误 / 绕过界面，超限拆段比硬写进一章更合理。
    if (typeof text !== 'string' || !text.trim()) {
      throw new captureLib.CaptureError('BAD_TEXT', '捕获内容格式不对');
    }
    if (text.length > captureLib.MAX_BODY_CHARS) {
      throw new captureLib.CaptureError(
        'TOO_LARGE',
        `内容太长（${formatCount(text.length)} 字，最多 ${formatCount(captureLib.MAX_BODY_CHARS)} 字）；` +
          '请先拆成多段再捕获'
      );
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
        statsError = err.message;
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

  handle('books:list', async () => {
    // B3：书架列表要显示每本书的章节 / 字数，先把防抖中的「上次打开章节」落盘再读
    await flushLastOpenBeforeRead(null);
    const cfg = await getConfig();
    return storage.listBooks(cfg.booksRoot);
  });

  handle('book:create', async (title) => {
    const cfg = await getConfig();
    await fs.mkdir(cfg.booksRoot, { recursive: true });
    const created = await storage.createBook(cfg.booksRoot, title);
    notifyShelfChanged(flowSession(), 'book:create');
    return created;
  });

  handleBook('book:open', async (bookPath) => {
    const session = flowSession();
    // B3：读书目之前先把防抖中的「上次打开章节」落盘，保证重开书回到的是最后一次切到的章
    await flushLastOpenBeforeRead(bookPath);
    // 同一本书只允许一个窗口：已开在别处就聚焦那个窗口并拒绝
    const owner = storage.findOpenBookWindow(bookPath);
    if (owner && session && String(owner) !== String(session.id)) {
      focusSession(sessionById(owner));
      throw new storage.StorageError(
        openBooksLib.CODE.BOOK_OPEN_IN_OTHER_WINDOW,
        openBooksLib.openInOtherWindowMessage(bookPath)
      );
    }
    const data = await storage.openBook(bookPath);
    if (session) {
      const registered = storage.registerOpenBook(session.id, bookPath);
      if (!registered.ok) {
        focusSession(sessionById(registered.ownerWindowId));
        throw new storage.StorageError(registered.code, registered.message);
      }
    }
    const meta = data && data.meta;
    if (meta && Array.isArray(meta.chapters) && meta.chapters.length) {
      let index = meta.chapters.findIndex((chapter) => chapter && chapter.id === meta.lastOpenChapterId);
      if (index < 0) index = 0;
      const chapter = meta.chapters[index];
      await rememberRecentBook(bookPath, {
        title: meta.title,
        chapterId: chapter.id,
        chapterIndex: index,
        chapterName: chapter.name
      });
    }
    return data;
  });
  handleBook('book:verify', async (bookPath) => storage.verifyBook(bookPath));
  handleBook('book:rename', async (bookPath, title) => storage.renameBook(bookPath, title), {
    mutation: 'rename'
  });
  // 书籍信息（v0.8-3）：作者 / 简介 / 分组 / 标签只写 书目.json 的可选字段，不动书文件夹 / 章节文件。
  handleBook('book:update-info', async (bookPath, patch) => storage.updateBookInfo(bookPath, patch), {
    mutation: 'write'
  });
  // 章号编号方式（2026-11-10）：全书连续 / 按卷独立，只写 书目.json 的可选字段。
  handleBook('book:set-chapter-numbering', async (bookPath, numbering) => storage.setChapterNumbering(bookPath, numbering), {
    mutation: 'write'
  });
  handleBook('book:set-last', async (bookPath, chapterId, info) => {
    // B3（审计 P3）：只记「最新一次」，1.5 秒内的连续切章合并成一次写盘（lastOpenWrites）。
    // 章节是否还存在 / 书是否被挪走留给落盘时校验（返回 { ok:false } 与旧行为一致，渲染层本来就不看）。
    const chapterIdText = String(chapterId == null ? '' : chapterId);
    lastOpenWrites.schedule(bookKeyOf(bookPath), {
      bookPath,
      chapterId: chapterIdText,
      at: Date.now()
    });
    // 「继续上次写作」的书架级记忆（config.json，很小）仍在切章当下就写：渲染层把章的显示信息
    // 一起传上来（不必为此再读一遍书目），迟到的记录有 rememberRecentBook 的顺序保护。
    const display = info && typeof info === 'object' ? info : null;
    if (display && typeof display.chapterName === 'string' && chapterIdText) {
      await rememberRecentBook(bookPath, {
        title: display.title,
        chapterId: chapterIdText,
        chapterIndex: display.chapterIndex,
        chapterName: display.chapterName,
        at: Date.now()
      });
    }
    return { ok: true, queued: true, chapterId: chapterIdText };
  }, { mutation: 'save' });

  handleBook('chapter:load', async (bookPath, file) => storage.loadChapterText(bookPath, file));
  handleBook('chapter:stat', async (bookPath, file) => storage.statChapter(bookPath, file));

  // 正文排版整理：纯文本变换，只计算不写盘（写盘仍由作者 Ctrl+S 决定）
  handle('text:format', async (text, options) => {
    assertText(text);
    return formatLib.formatText(text, options);
  });

  // 校对（提案 5.1 / N6）：只报告、不改动。当前章正文由渲染层传上来（和查找一样，不读盘）；
  // 整本版走 book:proofread，逐章只读磁盘。index 是归一 CRLF 后的字符位置，可直接选中。
  // 校对词表（可选，作者自己的错别字 / 禁用词）存在 config 里，主进程只读；渲染层不传路径。
  handle('text:proofread', async (text, options) => {
    assertText(text);
    const cfg = await getConfig();
    const list = await glossaryLib.readGlossaryFile(cfg.proofreadWordsPath);
    const wordList = glossaryLib.publicGlossaryInfo(list);
    const result = proofreadLib.proofreadText(text, options, list.ok ? list.entries : []);
    return { ...result, wordList };
  });

  // 校对词表状态（只读）：只给渲染层数量与错误提示，绝不带词表正文
  handle('proofread:words-info', async () => {
    const cfg = await getConfig();
    return glossaryLib.publicGlossaryInfo(await glossaryLib.readGlossaryFile(cfg.proofreadWordsPath));
  });

  // 选词表（校对 / 敏感词共用）：只允许通过系统文件对话框选，渲染层不能自己指定路径去读任意文件。
  // read 负责把选中的文件解析成「公开信息」（只含数量 / 提示，绝不含词表正文）。
  // field：这个对话框选出来的路径属于配置里的哪一项（v0.9 C-2b 的来源校验靠它记账——
  // 设置里点「选择…」→ 主进程记下这次选中的文件 → config:set 才允许写进配置）。
  async function pickWordListFile({ title, read, field }) {
    const { canceled, filePaths } = await showOpenDialog({
      title,
      buttonLabel: '使用这个词表',
      properties: ['openFile'],
      filters: [
        { name: '文本文件', extensions: ['txt'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (canceled || !filePaths || !filePaths.length) return { canceled: true };
    rememberPickedConfigPath(field, filePaths[0]);
    return { canceled: false, ...(await read(filePaths[0])) };
  }

  // 选校对词表：只允许通过系统对话框选（渲染层不能自己指定路径去读任意文件）
  handle('proofread:pick-words', async () => {
    return pickWordListFile({
      title: '选择校对词表（每行一个词，可写「错词 → 建议」）',
      field: 'proofreadWordsPath',
      read: async (filePath) => glossaryLib.publicGlossaryInfo(await glossaryLib.readGlossaryFile(filePath))
    });
  });

  // 敏感词预检（提案 5.2）：词表完全由作者管理，应用不内置任何词表。
  // 词表路径存在 config 里（渲染层不传路径）；这里只读词表、只报告命中，绝不改正文、不写盘。
  // 渲染层也拿不到词表内容——只回数量与状态（publicWordListInfo 会剥掉 words）。
  handle('sensitive:words-info', async () => {
    const cfg = await getConfig();
    return sensitiveLib.publicWordListInfo(await sensitiveLib.readWordListFile(cfg.sensitiveWordsPath));
  });

  // 选敏感词表：只允许通过系统对话框选（渲染层不能自己指定路径去读任意文件）
  handle('sensitive:pick-words', async () => {
    return pickWordListFile({
      title: '选择敏感词表（每行一个词）',
      field: 'sensitiveWordsPath',
      read: async (filePath) => sensitiveLib.publicWordListInfo(await sensitiveLib.readWordListFile(filePath))
    });
  });

  handle('text:sensitive-check', async (text, options) => {
    assertText(text);
    const cfg = await getConfig();
    const list = await sensitiveLib.readWordListFile(cfg.sensitiveWordsPath);
    const wordList = sensitiveLib.publicWordListInfo(list);
    if (!list.ok) return { ok: false, code: list.code, message: list.message, wordList };
    const result = sensitiveLib.scanText(text, list.words, options);
    return { ok: true, ...result, wordList };
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
    return { count: result.matches.length, truncated: result.truncated, matches: result.matches };
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

  handleBook('chapter:save', async (bookPath, chapterId, text) => {
    // A2（审计 E6）：全仓唯一漏掉正文校验的写盘通道。与 text:format / text:find / replace
    // 同一口径：正文必须是字符串且不超过 500 万字（core/ipc-limits.js），超限回 TEXT_TOO_LARGE。
    // null / undefined 沿用旧行为 = 空章（渲染层本来就只会传字符串，这里只做防御）。
    const body = assertText(text == null ? '' : text);
    const session = flowSession();
    return storage.withBookLock(bookPath, async () => {
      const cfg = await getConfig();
      // 保存前校验（写盘安全检查）：书文件夹、书目、章节记录、章节文件都还在才允许写，
      // 且书不能正开在另一个窗口。任何一项失效都报错，绝不 mkdir 重建影子文件。
      const prepared = await storage.prepareChapterSave(bookPath, chapterId, {
        windowId: session ? session.id : null
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
        await storage.writeBookMeta(bookPath, meta, { ensureDir: false });
      } catch (metaErr) {
        // A7（审计 E4）：正文已经写进磁盘、书目没更新成功。不能把这次保存整体当失败——
        // 渲染层会以为正文没保存（关窗时可能让作者重写 / 丢弃刚写的内容）。回可判别的部分成功：
        // code=META_SAVE_FAILED + bodySaved:true + chars/file（见 fail() 的白名单透传），
        // 界面提示「正文已写入磁盘，但书目更新失败，可重试保存」，dirty 保持，再按保存会重试。
        throw Object.assign(
          new Error(`正文已写入磁盘，但书目更新失败（${errorText.describeForUi(metaErr).message}），可再按一次保存重试`),
          { code: 'META_SAVE_FAILED', bodySaved: true, chars: result.chars, file: chapter.file }
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
        statsError = statsErr.message;
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
  });

  // 自定义正文字体：只允许字体文件，读成 base64 交给渲染层的 FontFace 加载（渲染层仍无 fs）
  // 代码审计 F1：font:pick 选中的路径只记在内存里（按窗口分开），font:read 只认「这次选的 /
  // 当前书的 bookDisplay / 全局配置」这三种主进程自己知道的路径，渲染层传进来的路径一律不看。
  const pickedFontPaths = new Map(); // windowId -> 本次在对话框里选中的字体路径

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
    const stat = await fs.stat(realPath);
    if (!stat.isFile()) throw new storage.StorageError('BAD_FONT', '选中的不是一个字体文件');
    if (!fontPolicy.isFontSizeAllowed(stat.size)) {
      throw new storage.StorageError('FONT_TOO_BIG', '字体文件太大（超过 24MB），请换一个小一点的');
    }
    const buffer = await fs.readFile(realPath);
    const payload = {
      name: path.basename(realPath),
      size: stat.size,
      base64: buffer.toString('base64'),
      source: source.source
    };
    // 只有「刚在对话框里选的」这一趟回 path（渲染层本来就从 font:pick 拿到过这个路径）；
    // 按书 / 全局配置解析出来的路径绝不回传，避免把配置里的本机路径带进渲染层。
    if (source.source === 'picked') payload.path = resolved;
    return payload;
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

  handleBook('chapter:create', async (bookPath, insertIndex, name, volumeId) =>
    storage.createChapter(bookPath, insertIndex, name, volumeId), { mutation: 'write' }
  );
  handleBook('chapter:rename', async (bookPath, chapterId, name) =>
    storage.renameChapter(bookPath, chapterId, name), { mutation: 'rename' }
  );
  // 章节状态 / 备注：只改书目可选字段（txt 不动）
  handleBook('chapter:update-meta', async (bookPath, chapterId, patch) =>
    storage.updateChapterMeta(bookPath, chapterId, patch), { mutation: 'write' }
  );
  // 1.5.0 P0-5（审计 V-1）：删除成功后发一张进程内一次性凭证（crypto.randomUUID），
  // 只在内存 Map 里记 { bookPath, trashName, chapterId, expiresAt }（10 分钟，带上限与过期清理）。
  // 撤销时必须原样带回来 —— 只靠 trashName 的四道自证证明不了「这个备份是本次删除产生的」。
  // 返回形状只**扩展**一个 undoToken 字段：频道名 / preload 方法名 / 原有的 meta·trashPath·
  // newChapter·index 一个都不变。
  handleBook('chapter:delete', async (bookPath, chapterId) => {
    const result = await storage.deleteChapter(bookPath, chapterId);
    const trashName = result && result.trashPath ? path.basename(result.trashPath) : '';
    const undoToken = trashName
      ? restoreTokens.issue({ bookPath, trashName, chapterId })
      : '';
    return { ...result, undoToken };
  }, {
    mutation: 'delete'
  });
  // 撤销删除（1.4.0 P0-2）：只把本书 _trash 下的那一个 txt 放回书文件夹，并按原位置插回书目。
  // 入参形状由 core/storage.js 的 restoreDeletedChapterFromTrash 自己校验（不信任渲染层给的路径）。
  // 1.5.0 P0-3（审计 E3 / O-8）：先过 core/ipc-limits.js 的白名单 —— 只留
  // trashName / index / chapter{id,file,name,createdAt,volumeId,status,note} / autoChapterFile，
  // 必填字段不合法直接抛 BAD_RESTORE（fail() 统一文案），一个字节都不会写盘；
  // 交给 storage 的必须是清洗后的 payload，不是原始参数。
  // 1.5.0 P0-5（审计 V-1）：白名单之后还要验撤销凭证（存在 / 未过期 / 同一本书 / 同一个 trashName），
  // 验过立刻作废（一次性）；storage 还原失败时把凭证放回去，作者还能原地再试一次。
  handleBook('chapter:restore-deleted', async (bookPath, payload) => {
    const clean = ipcLimits.sanitizeRestorePayload(payload);
    const rawToken =
      payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.undoToken : '';
    const claim = restoreTokens.take(rawToken, { bookPath, trashName: clean.trashName });
    if (!claim.ok) throw ipcRestoreToken.errorFor(claim.reason);
    try {
      return await storage.restoreDeletedChapterFromTrash(bookPath, clean);
    } catch (err) {
      restoreTokens.release(claim.record);
      throw err;
    }
  }, {
    mutation: 'write'
  });
  handleBook('chapter:move', async (bookPath, chapterId, toIndex) =>
    storage.moveChapter(bookPath, chapterId, toIndex), { mutation: 'write' }
  );
  // 分卷：新建 / 改名 / 删除（章节回未分卷，不删章）/ 把章移到别的卷
  handleBook('volume:create', async (bookPath, name) => storage.createVolume(bookPath, name), {
    mutation: 'write'
  });
  handleBook('volume:rename', async (bookPath, volumeId, name) =>
    storage.renameVolume(bookPath, volumeId, name), { mutation: 'write' }
  );
  handleBook('volume:delete', async (bookPath, volumeId) => storage.deleteVolume(bookPath, volumeId), {
    mutation: 'write'
  });
  handleBook('chapter:move-to-volume', async (bookPath, chapterId, volumeId) =>
    storage.moveChapterToVolume(bookPath, chapterId, volumeId), { mutation: 'write' }
  );
  handleBook('volume:move', async (bookPath, volumeId, toIndex) =>
    storage.moveVolume(bookPath, volumeId, toIndex), { mutation: 'write' }
  );
  handleBook('chapter:move-to', async (bookPath, chapterId, volumeId, beforeChapterId) =>
    storage.moveChapterTo(bookPath, chapterId, volumeId, beforeChapterId), { mutation: 'write' }
  );

  // 全书查找 / 替换：替换写盘前 storage 会把原章节备份到书内 _trash。
  // v0.9 C-5：options 由 core/ipc-limits.js 清洗——查找词 / 替换词必须是文本且各限 1 万字，
  // 非对象 options 按 {}（旧行为：没传选项 = 默认口径），坏类型直接回 BAD_QUERY / BAD_REPLACEMENT，
  // 不让一个超长替换词把整本书的 txt 撑爆（替换最多 5000 处 / 章）。
  handleBook('book:search', async (bookPath, options) =>
    storage.searchBook(bookPath, ipcLimits.sanitizeSearchOptions(options))
  );
  handleBook('book:replace', async (bookPath, options) =>
    storage.replaceInBook(bookPath, ipcLimits.sanitizeReplaceOptions(options)), {
    mutation: 'replace'
  });

  // 整本检查（校对 / 敏感词）共用：逐章读正文；当前章用 override 的最新内容；
  // 缺文件的章节跳过并计数（不让整本检查失败）。只读，不写盘。
  // B4（审计 P4）：各章正文并行读（上限 CHAPTER_READ_CONCURRENCY），回调仍按书目顺序逐章触发，
  // 统计 / 顺序与串行版完全一致。
  async function walkChapterTexts(bookPath, meta, override, onChapter) {
    const overrideIndex = exporter.chapterIndexOf(meta, override);
    const loaded = await mapLimit(meta.chapters, CHAPTER_READ_CONCURRENCY, async (chapter, index) => {
      if (index === overrideIndex) return { text: override.text };
      try {
        return { text: (await storage.loadChapterText(bookPath, chapter.file)).text };
      } catch (err) {
        if (err.code === 'CHAPTER_MISSING') return { missing: true };
        throw err;
      }
    });
    let skippedChapters = 0;
    for (let index = 0; index < meta.chapters.length; index += 1) {
      const item = loaded[index];
      if (item.missing) {
        skippedChapters += 1;
        continue;
      }
      onChapter(item.text, meta.chapters[index], index);
    }
    return skippedChapters;
  }

  // 校对整本（提案 5.1）：逐章只读正文，按 core/proofread.js 的规则列出可疑位置；
  // 全程不写盘。当前章未保存的内容用 override 传进来（和导出同一个惯例：只参与这一次检查）。
  // 每章最多保留 maxIssues 条明细，整本明细上限 1500 条，但总数 / 各规则条数照实统计。
  handleBook('book:proofread', async (bookPath, options, override) => {
    const meta = await storage.readBookMeta(bookPath);
    // v0.9 C-5：当前章未保存内容（override）先过边界（坏形状当没有；正文超 500 万字拒绝）
    const safeOverride = ipcLimits.sanitizeOverride(override);
    const limits = proofreadLib.sanitizeOptions(options);
    // 校对词表只读一次，整本每章共用（没设置 / 读不了 = 只跑内置五条规则，面板会提示）
    const cfg = await getConfig();
    const list = await glossaryLib.readGlossaryFile(cfg.proofreadWordsPath);
    const wordList = glossaryLib.publicGlossaryInfo(list);
    const customEntries = list.ok ? list.entries : [];
    const BOOK_ISSUE_LIMIT = 1500;
    const byRule = {};
    for (const rule of proofreadLib.RULE_ORDER) byRule[rule] = 0;
    const chapters = [];
    const issues = [];
    let total = 0;
    let truncated = false;
    const skippedChapters = await walkChapterTexts(bookPath, meta, safeOverride, (text, chapter, index) => {
      const result = proofreadLib.proofreadText(text, limits, customEntries);
      total += result.total;
      for (const rule of proofreadLib.RULE_ORDER) byRule[rule] += result.byRule[rule] || 0;
      if (result.total) {
        chapters.push({
          chapterId: chapter.id,
          chapterIndex: index,
          name: chapter.name,
          total: result.total,
          byRule: result.byRule,
          truncated: result.truncated
        });
      }
      if (result.truncated) truncated = true;
      for (const issue of result.issues) {
        if (issues.length >= BOOK_ISSUE_LIMIT) {
          truncated = true;
          break;
        }
        issues.push({
          ...issue,
          chapterId: chapter.id,
          chapterIndex: index,
          chapterName: chapter.name
        });
      }
    });
    return {
      scope: 'book',
      total,
      byRule,
      issues,
      chapters,
      chapterCount: meta.chapters.length,
      // 有问题的章数（chapters 只收有问题的章）
      chapterHitCount: chapters.length,
      skippedChapters,
      truncated: truncated || total > issues.length,
      wordList,
      customWordCount: customEntries.length,
      options: limits
    };
  });

  // 敏感词预检整本（提案 5.2）：逐章只读磁盘，按作者词表列出命中；全程不写盘。
  // 当前章未保存的内容用 override 传进来（只参与这一次检查，和导出 / 校对同一个惯例）。
  // 每章明细上限由 core/sensitive.js 的 maxIssues 控制，整本明细上限 1500 条，但总数照实统计。
  handleBook('book:sensitive-check', async (bookPath, options, override) => {
    const cfg = await getConfig();
    const list = await sensitiveLib.readWordListFile(cfg.sensitiveWordsPath);
    const wordList = sensitiveLib.publicWordListInfo(list);
    if (!list.ok) return { ok: false, code: list.code, message: list.message, wordList };
    const meta = await storage.readBookMeta(bookPath);
    // v0.9 C-5：override 与上面校对同一条边界（坏形状当没有；正文超 500 万字拒绝）
    const safeOverride = ipcLimits.sanitizeOverride(override);
    const limits = sensitiveLib.sanitizeOptions(options);
    const matches = [];
    const chapters = [];
    const byWordMap = new Map();
    let total = 0;
    let truncated = false;
    const skippedChapters = await walkChapterTexts(bookPath, meta, safeOverride, (text, chapter, index) => {
      const result = sensitiveLib.scanText(text, list.words, limits);
      total += result.total;
      for (const item of result.byWord) {
        byWordMap.set(item.word, (byWordMap.get(item.word) || 0) + item.count);
      }
      if (result.total) {
        chapters.push({
          chapterId: chapter.id,
          chapterIndex: index,
          name: chapter.name,
          total: result.total,
          truncated: result.truncated
        });
      }
      if (result.truncated) truncated = true;
      for (const match of result.issues) {
        if (matches.length >= sensitiveLib.BOOK_ISSUE_LIMIT) {
          truncated = true;
          break;
        }
        matches.push({
          ...match,
          chapterId: chapter.id,
          chapterIndex: index,
          chapterName: chapter.name
        });
      }
    });
    const byWord = Array.from(byWordMap, ([word, count]) => ({ word, count }))
      .sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0))
      .slice(0, sensitiveLib.BY_WORD_LIMIT);
    return {
      ok: true,
      scope: 'book',
      total,
      matches,
      byWord,
      wordHitCount: byWordMap.size,
      wordCount: list.words.length,
      chapters,
      chapterCount: meta.chapters.length,
      // 有命中的章数（chapters 只收有命中的章）
      chapterHitCount: chapters.length,
      skippedChapters,
      truncated: truncated || total > matches.length,
      wordList,
      options: limits
    };
  });

  // 整本替换的还原：列出 / 还原书内 _trash/替换备份-*/（还原前把当前内容再备份一份）
  handleBook('book:list-replace-backups', async (bookPath) => storage.listReplaceBackups(bookPath));
  handleBook('book:restore-replace-backup', async (bookPath, backupName) =>
    storage.restoreReplaceBackup(bookPath, backupName), { mutation: 'replace' }
  );

  // 本书历史：统一列出 / 预览 / 还原书内 _trash 的各种备份（替换/整理/还原前/快照/删章 + 书目.json.bak）
  handleBook('book:list-history', async (bookPath) => storage.listBookHistory(bookPath));
  handleBook('book:preview-history-file', async (bookPath, groupId, fileName) =>
    storage.previewHistoryFile(bookPath, groupId, fileName)
  );
  handleBook('book:restore-history-file', async (bookPath, groupId, fileName) =>
    storage.restoreHistoryFile(bookPath, groupId, fileName), { mutation: 'write' }
  );
  handleBook('book:restore-history-dir', async (bookPath, groupId) =>
    storage.restoreHistoryGroup(bookPath, groupId), { mutation: 'write' }
  );
  // 清空某一天的每日快照（P22-5）：只把这个目录**移入 Windows 回收站**，绝不硬删。
  // 参数只认快照目录名（storage.snapshotDirForClear 严格校验「快照-YYYYMMDD」+ 日期真实存在 +
  // 必须落在本书 _trash 下），不接受任意路径；校验不过 / 回收站不可用都只报错返回，一个文件都不动。
  handleBook('book:clear-snapshot-day', async (bookPath, groupName) => {
    const dir = storage.snapshotDirForClear(bookPath, groupName);
    let stat;
    try {
      stat = await fs.lstat(dir);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new storage.StorageError('HISTORY_GROUP_MISSING', '这个快照目录已经不存在了');
      }
      throw err;
    }
    // 联接 / 符号链接不是普通文件夹：宁可不清，也不要把书库外面的东西卷进来
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new storage.StorageError('SNAPSHOT_NOT_DIR', '这个快照不是一个普通文件夹，没有清空');
    }
    try {
      await shell.trashItem(dir);
    } catch (err) {
      // 回收站不可用（被策略禁用 / 磁盘问题…）：报错返回，不重试、不降级成硬删
      throw new storage.StorageError(
        'SNAPSHOT_TRASH_FAILED',
        `移入回收站失败，快照没有动：${errorText.describeForUi(err).message}`
      );
    }
    return { ok: true, dir: path.basename(dir) };
  }, { mutation: 'write' });

  // 整本智能排版：预检查只算不写；正式整理逐章写盘（写前把原章节备份到 _trash/整理备份-*）
  handleBook('book:format-preview', async (bookPath, options) =>
    storage.previewFormatBook(bookPath, options)
  );
  handleBook('book:format', async (bookPath, options) =>
    storage.formatBook(bookPath, options, (progress) => {
      sendToFlow('format:progress', progress);
    }), { mutation: 'format' }
  );

  // 拼导出/复制用的正文：默认读磁盘；override 是编辑区里当前章的最新内容（未保存也算，只参与拼接不写盘）
  // chars 回报的是「正文字数」（去掉空白/换行，和编辑页字数统计同一口径），不是文件字节数
  // indexes 可选：只读选中的章（按范围导出用），没选中的位置留空字符串但保持下标对齐
  async function collectExportTexts(bookPath, meta, override, indexes) {
    const selected = Array.isArray(indexes) ? new Set(indexes) : null;
    const overrideIndex = exporter.chapterIndexOf(meta, override);
    // B4（审计 P4）：选中章的正文并行读；texts 仍按书目下标填，顺序 / 空串占位完全不变
    const texts = await mapLimit(meta.chapters, CHAPTER_READ_CONCURRENCY, async (chapter, i) => {
      if (selected && !selected.has(i)) return '';
      if (i === overrideIndex) return override.text;
      return (await storage.loadChapterText(bookPath, chapter.file)).text;
    });
    let chars = 0;
    for (const text of texts) chars += chaptersLib.countChars(text);
    return {
      texts,
      chars,
      includedUnsaved: overrideIndex >= 0 && (!selected || selected.has(overrideIndex))
    };
  }

  // 导出范围预览（只读）：对话框里实时显示「选中几章 / 多少字 / 默认文件名」。
  // 字数优先用书目里的 chars 缓存求和（审计 F3）；缓存缺失 / 坏值才读盘现算，
  // 编辑区里当前章的未保存内容（override）永远现算。正式导出仍读全文，不受这里影响。
  // v0.9 C-5：override / range 先过 core/ipc-limits.js——正文超过 500 万字报 TEXT_TOO_LARGE，
  // 坏形状按旧行为降级（override 当没有、range 当全书 / 越界收紧）。
  handleBook('book:export-plan', async (bookPath, override, range) => {
    const meta = await storage.readBookMeta(bookPath);
    const safeOverride = ipcLimits.sanitizeOverride(override);
    const safeRange = ipcLimits.sanitizeRange(range);
    const plan = exporter.resolveExportRange(meta, safeRange);
    const overrideIndex = exporter.chapterIndexOf(meta, safeOverride);
    let chars = 0;
    const needDisk = [];
    for (const index of plan.indexes) {
      if (index === overrideIndex) {
        chars += chaptersLib.countChars(safeOverride.text);
        continue;
      }
      const chapter = meta.chapters[index];
      const cached = exporter.cachedCharsOf(chapter);
      if (cached != null) {
        chars += cached;
        continue;
      }
      needDisk.push(index);
    }
    // B4（审计 P4）：缓存缺失的章并行读盘现算（顺序不影响求和；仍只读不写）
    if (needDisk.length) {
      const counted = await mapLimit(needDisk, CHAPTER_READ_CONCURRENCY, async (index) => {
        const text = (await storage.loadChapterText(bookPath, meta.chapters[index].file)).text;
        return chaptersLib.countChars(text);
      });
      for (const value of counted) chars += value;
    }
    return {
      mode: plan.mode,
      label: plan.label,
      chapterCount: plan.count,
      chars,
      from: plan.from,
      to: plan.to,
      volumeId: plan.volumeId,
      empty: plan.empty,
      fileName: exporter.exportFileName(meta, safeRange),
      epubFileName: epubLib.epubFileName(meta, safeRange),
      docxFileName: docxLib.docxFileName(meta, safeRange),
      includedUnsaved: overrideIndex >= 0 && plan.indexes.includes(overrideIndex)
    };
  });

  // 目录是否存在（导出默认目录兜底用）：读不到就当不存在
  function isDirectory(dir) {
    try {
      return fsSync.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  }

  // 导出 TXT / EPUB / DOCX 共用的前置：读书目 → 解析范围（空范围明确报错）
  // → 准备「上次导出目录 / 文档」作为默认落点。三个入口只负责各自的保存对话框、格式细节与返回字段。
  // 审计 #7（O2 / P4）：这里**只做只读前置**，正文（texts / chars / includedUnsaved）不读——
  // 交给下面 readExportTexts，等保存对话框确认之后再读。用户取消导出时一次正文都不会读，
  // 对话框停留期间也不会把整本书常驻内存。
  // v0.9 C-5：override / range 在这里统一过 core/ipc-limits.js（超长正文拒绝、坏形状降级），
  // 三个导出与下面的复制 / 校对 / 敏感词预检共用同一套口径，避免某个入口漏掉。
  async function prepareExport(bookPath, override, range) {
    const meta = await storage.readBookMeta(bookPath);
    const safeOverride = ipcLimits.sanitizeOverride(override);
    const safeRange = ipcLimits.sanitizeRange(range);
    const plan = exporter.resolveExportRange(meta, safeRange);
    if (!plan.count) {
      throw new storage.StorageError(
        'EMPTY_EXPORT_RANGE',
        plan.mode === 'all' ? '这本书里还没有章节' : '所选范围里没有章节'
      );
    }
    const cfg = await getConfig();
    // 默认落到「上一次导出保存到的目录」；没记过、或那个目录已经不存在了，才退回「文档」
    const defaultDir = exporter.resolveExportDir(cfg.lastExportDir, app.getPath('documents'), isDirectory);
    return { meta, plan, override: safeOverride, cfg, defaultDir, range: safeRange };
  }

  // 保存对话框确认之后才走的正文读取（审计 #7）：prepareExport 的后半段，三个导出入口共用。
  // 调用点必须放在 `if (canceled || !filePath) return { canceled: true };` 之后——顺序反了就等于
  // 用户取消也白读整本；tests/export-read-order.test.js 的静态闸门钉住这个时序。
  async function readExportTexts(bookPath, prepared) {
    const { meta, plan, override } = prepared;
    return collectExportTexts(bookPath, meta, override, plan.indexes);
  }

  // EPUB / DOCX 导出成功后的返回字段（两个入口完全一致，只是 built 来自不同的纯函数）
  function archiveExportResult(filePath, built, chars, includedUnsaved, conversion, plan) {
    return {
      canceled: false,
      filePath,
      chapterCount: built.chapterCount,
      volumeCount: built.volumeCount,
      chars,
      includedUnsaved,
      bytes: built.bytes,
      conversion,
      rangeLabel: plan.label
    };
  }

  handleBook('book:export', async (bookPath, override, range) => {
    const prepared = await prepareExport(bookPath, override, range);
    const { meta, plan, cfg, defaultDir, range: safeRange } = prepared;
    // 文件名默认带上范围：书名.txt / 书名-卷名.txt / 书名-第X-Y章.txt（可在保存对话框里改）
    const defaultName = exporter.exportFileName(meta, safeRange);
    const { canceled, filePath } = await showSaveDialog({
      title: '导出 TXT',
      defaultPath: path.join(defaultDir, defaultName),
      filters: [{ name: '文本文件', extensions: ['txt'] }]
    });
    if (canceled || !filePath) return { canceled: true };
    // 审计 #7：落点确认之后才读整本正文（取消 / 改主意都不会白读）
    const { texts, chars, includedUnsaved } = await readExportTexts(bookPath, prepared);
    // 简繁转换只作用于这份导出副本：字数仍按原稿算，磁盘上的章节 txt / 书目一个字节都不动
    const conversion = s2tLib.normalizeMode(cfg.exportConversion);
    // C1（审计 #1 / P3）：compose → 转换 → 出字节在 buildTxtExport 里串成一条链，每步之后
    // 立刻放掉上一份整本数据（texts 数组同时被就地清空），导出字节与以前逐字节一致。
    const buffer = exporter.buildTxtExport(meta, texts, safeRange, conversion, s2tLib.convertText);
    await atomicWriteFile(filePath, buffer);
    // 记住这次导出的目录，下次导出默认还开在这里（记不住也不影响导出结果）
    await rememberExportDir(path.dirname(filePath));
    return {
      canceled: false,
      filePath,
      chapterCount: plan.count,
      chars,
      includedUnsaved,
      rangeLabel: plan.label,
      conversion
    };
  });

  // 导出 EPUB（提案 6.3 / v0.8 P0 N8）：整本或按卷 / 按章节范围 → 一本 EPUB 3
  // （分卷做目录级、一章一个 XHTML、没有封面图就生成纯文字封面页）。排版沿用「段首缩进 + 空一行」，
  // 由 EPUB 里的 CSS 控制，不动任何 txt 字节。和 TXT 导出一样：当前章未保存的内容参与拼接、只读、原子写盘。
  // range 不传 = 全书；只把选中的章节读出来打进包里，章号仍按全书顺序。
  handleBook('book:export-epub', async (bookPath, override, range) => {
    const prepared = await prepareExport(bookPath, override, range);
    const { meta, plan, cfg, defaultDir, range: safeRange } = prepared;
    const defaultName = epubLib.epubFileName(meta, safeRange);
    const { canceled, filePath } = await showSaveDialog({
      title: '导出 EPUB',
      defaultPath: path.join(defaultDir, defaultName),
      filters: [{ name: 'EPUB 电子书', extensions: ['epub'] }]
    });
    if (canceled || !filePath) return { canceled: true };
    // 审计 #7：落点确认之后才读整本正文（取消 / 改主意都不会白读）
    const { texts, chars, includedUnsaved } = await readExportTexts(bookPath, prepared);
    // 简繁转换：书名 / 卷名 / 章名 / 正文都换成导出用的副本，目录和正文才一致；
    // 书目与章节 txt 一概不动（chars 仍按原稿字数算）。
    const conversion = s2tLib.normalizeMode(cfg.exportConversion);
    const exportMeta = s2tLib.convertMeta(meta, conversion);
    // C1（审计 #1 / P3）：正文转换就地做（不再额外建一整份全书数组）；打包完立刻放掉整本正文。
    exporter.convertTextsInPlace(texts, conversion, s2tLib.convertText);
    const built = epubLib.buildEpub({ meta: exportMeta, texts, range: safeRange });
    exporter.releaseTexts(texts);
    await atomicWriteFile(filePath, built.buffer);
    await rememberExportDir(path.dirname(filePath));
    return archiveExportResult(filePath, built, chars, includedUnsaved, conversion, plan);
  });

  // 导出 DOCX（v0.8 P0 N9）：整本或按卷 / 按章节范围 → 一份 Word 能直接打开的书稿。
  // 和 EPUB 导出同一套规则：范围解析复用 exporter.resolveExportRange，只读选中的章，
  // 章号 / 章名仍按全书顺序；当前章未保存内容参与、只读、原子写盘、简繁转换只作用于副本。
  handleBook('book:export-docx', async (bookPath, override, range) => {
    const prepared = await prepareExport(bookPath, override, range);
    const { meta, plan, cfg, defaultDir, range: safeRange } = prepared;
    const defaultName = docxLib.docxFileName(meta, safeRange);
    const { canceled, filePath } = await showSaveDialog({
      title: '导出 DOCX',
      defaultPath: path.join(defaultDir, defaultName),
      filters: [{ name: 'Word 文档', extensions: ['docx'] }]
    });
    if (canceled || !filePath) return { canceled: true };
    // 审计 #7：落点确认之后才读整本正文（取消 / 改主意都不会白读）
    const { texts, chars, includedUnsaved } = await readExportTexts(bookPath, prepared);
    // 简繁转换：书名 / 卷名 / 章名 / 正文都换成导出用的副本（书目与章节 txt 一概不动）
    const conversion = s2tLib.normalizeMode(cfg.exportConversion);
    const exportMeta = s2tLib.convertMeta(meta, conversion);
    // C1（审计 #1 / P3）：正文转换就地做（不再额外建一整份全书数组）；打包完立刻放掉整本正文。
    exporter.convertTextsInPlace(texts, conversion, s2tLib.convertText);
    const built = docxLib.buildDocx({ meta: exportMeta, texts, range: safeRange });
    exporter.releaseTexts(texts);
    await atomicWriteFile(filePath, built.buffer);
    await rememberExportDir(path.dirname(filePath));
    return archiveExportResult(filePath, built, chars, includedUnsaved, conversion, plan);
  });

  handleBook('book:copy', async (bookPath, override, indexes) => {
    const meta = await storage.readBookMeta(bookPath);
    const safeOverride = ipcLimits.sanitizeOverride(override);
    // 1.5.0 功能-1：可选第三参数 = 只复制这些章（章节多选「复制选中章」）。
    // 没传 = 整本复制，行为与 1.4.0 逐字节一致；传了空数组 = 什么都不写（不拿空数组当整本）。
    const selected = ipcLimits.sanitizeChapterIndexes(indexes, { total: meta.chapters.length });
    if (selected && !selected.length) {
      return { chapterCount: 0, chars: 0, includedUnsaved: false, empty: true };
    }
    const { texts, chars, includedUnsaved } = await collectExportTexts(bookPath, meta, safeOverride, selected);
    const text = selected ? exporter.composeSelected(meta, texts, selected) : exporter.composeBook(meta, texts);
    await activeClipboard.writeText(text);
    return {
      chapterCount: selected ? selected.length : meta.chapters.length,
      chars,
      includedUnsaved
    };
  });

  // 复制本章（平台格式）：只取这一章的正文，段首缩进两个全角空格、段间空一行（空行也带缩进），
  // 直接进剪贴板；不写盘。ref = { chapterId?, chapterFile?, text? }：
  // 带了 text 就用它（编辑区里当前章未保存的最新内容，沿用户导出惯例），没带就读磁盘。
  handleBook('chapter:copy-platform', async (bookPath, ref) => {
    const safeRef = ipcLimits.sanitizeOverride(ref);
    const meta = await storage.readBookMeta(bookPath);
    const index = exporter.chapterRefIndex(meta, safeRef);
    if (index < 0) throw new storage.StorageError('CHAPTER_NOT_FOUND', '找不到这一章（可能刚被删除）');
    const chapter = meta.chapters[index];
    const fromEditor = Boolean(safeRef && typeof safeRef.text === 'string');
    const text = fromEditor
      ? safeRef.text
      : (await storage.loadChapterText(bookPath, chapter.file)).text;
    const result = exporter.platformChapterText(text);
    const title = chaptersLib.formatTitle(meta, index, chapter.name);
    if (result.empty) {
      // 空章不覆盖剪贴板：免得把作者刚复制的东西冲掉
      return { empty: true, title, paragraphs: 0, chars: 0, includedUnsaved: fromEditor };
    }
    await activeClipboard.writeText(result.text);
    return {
      empty: false,
      title,
      paragraphs: result.paragraphs,
      chars: result.chars,
      includedUnsaved: fromEditor
    };
  });

  handleBook('book:repair', async (bookPath, mode) => {
    if (mode === 'bak') return repair.restoreFromBak(bookPath);
    if (mode === 'rebuild') return repair.rebuildFromFiles(bookPath);
    throw new storage.StorageError('BAD_MODE', `未知的修复方式：${mode}`);
  }, { mutation: 'write' });

  handle('book:import', async (explicitPaths, options) => {
    // 路径入口（v0.9 C-2）：导入目录的唯一正当来源是下面这个系统对话框。
    // 渲染层如果自己传了目录，只有 automation（自检 / 截图）才认；生产环境一律拒（BAD_IMPORT_PATH），
    // 免得被注入的脚本让主进程把任意文件夹（桌面 / 别的盘 / D:\我的小说）复制进书架。
    let dirs = ipcPaths.importSourceDirs(explicitPaths, { allowExplicit: automation });
    const cfg = await getConfig();
    await fs.mkdir(cfg.booksRoot, { recursive: true });
    if (!dirs.length) {
      const { canceled, filePaths } = await showOpenDialog({
        title: '导入小说（选择一个或多个书文件夹）',
        buttonLabel: '导入',
        properties: ['openDirectory', 'multiSelections', 'dontAddToRecent']
      });
      if (canceled || !filePaths || !filePaths.length) {
        return { canceled: true, imported: [], skipped: [], failed: [] };
      }
      dirs = filePaths;
    }
    // 导入会往书库里写文件夹：目标正好是别的窗口正开着的书 → 拒绝（「导入覆盖」也要拦）
    const session = flowSession();
    for (const sourceDir of dirs) {
      const base = path.basename(path.resolve(String(sourceDir)));
      const target = path.join(cfg.booksRoot, base);
      const owner = storage.findOpenBookWindow(target);
      if (owner && (!session || String(owner) !== String(session.id))) {
        throw new storage.StorageError(
          'CROSS_WINDOW_BUSY',
          `导入目标「${base}」正在另一个窗口打开。请先关掉另一个窗口，或先切换到那个窗口后再导入。`
        );
      }
    }
    const imported = await importer.importFolders(cfg.booksRoot, dirs, {
      mode: options && options.mode,
      onProgress: (progress) => {
        sendToFlow('import:progress', progress);
      }
    });
    notifyShelfChanged(session, 'book:import');
    return imported;
  });

  handleBook('book:delete', async (bookPath) => {
    const session = flowSession();
    const cfg = await getConfig();
    const root = path.resolve(cfg.booksRoot);
    const target = path.resolve(String(bookPath || ''));
    if (path.dirname(target).toLowerCase() !== root.toLowerCase()) {
      throw new storage.StorageError('BAD_PATH', '只能删除书架目录下的书');
    }
    // 别的窗口正开着这本书：拒绝，绝不让它在另一个窗口里继续盯着被删的文件夹
    if (!(await storage.exists(target))) {
      throw new storage.StorageError('NOT_FOUND', '这本书的文件夹已经不存在了');
    }
    let result;
    // 测试环境用固定兜底路径，避免把测试数据丢进你的回收站
    if (isE2E) {
      const trashPath = await storage.trashBook(cfg.booksRoot, target);
      result = { method: 'move', folder: path.basename(target), trashPath };
    } else {
      try {
        await shell.trashItem(target);
        result = { method: 'recycle', folder: path.basename(target) };
      } catch (err) {
        const trashPath = await storage.trashBook(cfg.booksRoot, target);
        result = {
          method: 'move',
          folder: path.basename(target),
          trashPath,
          note: `回收站不可用（${errorText.describeForUi(err).message}），已移到书架的 _trash`
        };
      }
    }
    // 删除成功：清掉可能存在的登记（自己的 / 残留的）；书架变动的广播由 handleBook 统一发
    storage.releaseOpenBookPath(target);
    // A4（审计 #11 / O3、P6）：这本书的锁条目（若有）也一并回收；在飞的链留到 settle 后自己回收。
    storage.clearBookLock(target);
    return result;
  }, { mutation: 'delete' });

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

  handleBook('shell:open-book-folder', async (bookPath) => {
    // C6（审计 E13）：先 stat 确认目标是目录，再交给系统默认程序打开——书架根下的直接子文件
    // （比如作者误放的一个 exe / 快捷方式）不会被「打开书文件夹」顺带执行。
    const stat = await fs.stat(bookPath);
    if (!stat.isDirectory()) {
      throw new storage.StorageError('NOT_A_DIRECTORY', '这个路径不是书文件夹，没有打开');
    }
    const err = await shell.openPath(bookPath);
    if (err) throw new storage.StorageError('OPEN_FAILED', errorText.cleanText(errorText.redactPaths(err)));
    return true;
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
      ...(focus ? { focus } : {}),
      onProgress: sendSearchProgress
    });
  });

  // 自动更新轻量版（提案 7.1）：手动检查 GitHub Release → 提示有新版本 → 打开下载页。
  // 不自动下载 / 安装；检查结果只在内存里（lastUpdateLaunch），渲染层不能传任意 URL 进来。
  handle('update:check', async () => {
    const result = await updateLib.checkForUpdates({
      currentVersion: app.getVersion(),
      fetchText: fetchReleaseResponse
    });
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
  if (windowSessions.size === 0) {
    bounds = clampBounds(cfg.windowBounds);
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
    webPreferences: securityPolicy.windowPreferences(path.join(__dirname, 'preload.js'))
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
    if (!browserWin.isDestroyed()) browserWin.show();
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

  // 渲染进程崩溃 / 窗口无响应也记一条（主进程的 uncaughtException 抓不到渲染层崩溃）
  browserWin.webContents.on('render-process-gone', (_event, details) => {
    const reason = (details && details.reason) || 'unknown';
    logError('render-process-gone', {
      code: reason,
      message: `渲染进程退出：${reason}（exitCode ${details && details.exitCode}，appCrashed ${Boolean(details && details.appCrashed)}）`
    });
  });
  browserWin.on('unresponsive', () => logError('unresponsive', { message: '窗口无响应（界面可能卡住）' }));

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
    // b8：按配置决定要不要开始后台监听剪贴板（默认关）
    syncClipboardWatch();
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
    // 拦一次退出、写完再 quit；flushAll 自己吞失败，不会卡住退出流程。
    if (!lastOpenQuitFlushStarted && lastOpenWrites.size() > 0) {
      lastOpenQuitFlushStarted = true;
      event.preventDefault();
      lastOpenWrites
        .flushAll()
        .catch(() => {})
        .finally(() => {
          app.quit();
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



