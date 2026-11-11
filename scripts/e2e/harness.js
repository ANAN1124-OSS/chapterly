// E2E 公共工具（v0.9 B-7 拆组时从 scripts/e2e-scenario.js 抽出来的；第 0–51 组拆组时又下沉了一批
// 「场景前导」的等待 / 读盘 / 剪贴板工具，见 fileExists 之后那一段）。
//
// 为什么单独一个文件：以前 check / waitFor / 删书重试 / 读日志这些工具都长在场景那个
// 1.2 万行的巨型函数里，按组拆到 scripts/e2e/groups/*.js 之后每一组都要用同一份，
// 不能各写一套（否则「超时带现场」「删书重试 10 次」这类口径会慢慢分叉）。
//
// 边界：只给 E2E 用（scripts/ 不进安装包，见 package.json 的 build.files），
// 这里不 require 任何产品代码；等待 / 重试的次数与拆分前逐字相同——拆分不改断言。
const fs = require('node:fs/promises');
const path = require('node:path');

// 等待时长常量表（1.6.0 G2）：E2E 里「等一拍」的时长只在这里写数字，组文件用有名字的
// waitForRender / waitForFocus / waitForDisk；能在条件上等的继续用 waitFor，不要拿它们当断言。
// 三个类的默认值都取该用途原先最常见的量级（≥ 改动前的等待，不靠缩短等待换速度）。
const WAIT = Object.freeze({
  RENDER: 150, // UI 动作（点击 / 切视图 / 搜索过滤）后等一次渲染与重排落定
  FOCUS: 150, // focus() / 键盘事件后等 focusin·blur 链派发完
  WRITE: 150, // 主进程小文件（配置 / 书目 / stats.json）落盘
  POLL: 120 // waitFor / waitForLog 的轮询间隔（内部用，别拿它当断言等待）
});

// ctx 就是 e2e-scenario.js 拿到的那个 ctx（主进程侧注入的执行 / 存储 / 临时 userData）。
// win / clipboard / storage / config / getCloseReady 是给「场景前导工具」用的：单测
// （tests/e2e-harness.test.js）只传 exec / sleep / userData 也能创建 harness，所以下面每个
// 工具都只在**函数体内**读这些能力，创建时不求值。
function createHarness(ctx) {
  const { exec, sleep, userData, win, clipboard, storage, config, getCloseReady } = ctx;
  // 全部断言的结果（e2e-scenario.js 最后原样交回主进程，按条打印 PASS / FAIL）
  const checks = [];
  // 失败清单（1.6.0 G2）：check 不再第一处失败就 throw，而是逐条累计；场景级异常（组里抛出的
  // TypeError / waitFor 超时）也走 recordFailure 记进同一份清单，最后统一由 summary() 决定退出码。
  const failures = [];

  const check = (name, cond, detail) => {
    const ok = Boolean(cond);
    const entry = { name, ok };
    if (!ok && detail !== undefined) entry.detail = detail;
    checks.push(entry);
    if (!ok) failures.push(entry);
    return ok;
  };

  // 场景级异常（不是某一条断言，而是这一组跑到一半抛了）：记成一条失败，让后面的组继续跑。
  const recordFailure = (name, err) => {
    const message = String((err && err.message) || err);
    const entry = { name, ok: false, detail: message };
    checks.push(entry);
    failures.push(entry);
    return message;
  };

  const hasFailures = () => failures.length > 0;
  const summary = () => ({
    ok: !hasFailures(),
    exitCode: hasFailures() ? 1 : 0,
    failed: failures.length,
    failures: failures.slice()
  });

  // 有名字的定时等待（1.6.0 G2）：把组里散落的 sleep(120/150) 按用途收口，时长从 WAIT 取。
  // 它们只是「让一拍」，不断言任何东西；能等到条件的场景仍要写 waitFor。
  const waitForRender = async (ms = WAIT.RENDER) => {
    await sleep(ms);
  };
  const waitForFocus = async (ms = WAIT.FOCUS) => {
    await sleep(ms);
  };
  const waitForDisk = async (ms = WAIT.WRITE) => {
    await sleep(ms);
  };

  const waitFor = async (expr, timeout = 10000) => {
    const startedAt = Date.now();
    for (;;) {
      let value;
      try {
        value = await exec(expr);
      } catch { /* 页面切换间隙可能短暂失败 */ }
      if (value) return value;
      if (Date.now() - startedAt > timeout) {
        // 超时带上一点现场（2026-11-01 v0.9 R0）：键盘 / 焦点类断言偶尔受窗口系统焦点影响，
        // 只记 activeElement 与 document.hasFocus()，方便下次偶发失败时定位，不做任何补救动作。
        let diag = '';
        try {
          diag = await exec(
            'JSON.stringify({ activeId: document.activeElement && document.activeElement.id, hasFocus: document.hasFocus() })'
          );
        } catch { /* 页面刚好在切换，忽略 */ }
        throw new Error(`等待超时：${expr}${diag ? `（现场：${diag}）` : ''}`);
      }
      await sleep(WAIT.POLL);
    }
  };

  const logDir = path.join(userData, 'logs');
  const logNamePattern = /^chapter-writer-\d{4}-\d{2}-\d{2}(\.\d{1,3})?\.log$/;
  const readLogs = async () => {
    let names = [];
    try {
      names = await fs.readdir(logDir);
    } catch {
      return { names: [], text: '' };
    }
    const logs = names.filter((name) => logNamePattern.test(name)).sort();
    let text = '';
    for (const name of logs) {
      try {
        text += await fs.readFile(path.join(logDir, name), 'utf8');
      } catch {
        /* 正在滚动 / 被占用：下一轮再读 */
      }
    }
    return { names, text };
  };
  const waitForLog = async (needle, timeout = 10000) => {
    const startedAt = Date.now();
    for (;;) {
      const { text } = await readLogs();
      if (text.includes(needle)) return text;
      if (Date.now() - startedAt > timeout) {
        throw new Error(`等待日志超时：${needle} :: ${text.slice(-800)}`);
      }
      await sleep(WAIT.POLL);
    }
  };

  // 文件 / 目录存在与否（第 52 组「日志只写 userData\logs」这条断言要用；以前是场景里的局部函数）。
  const fileExists = async (file) => {
    try {
      await fs.stat(file);
      return true;
    } catch {
      return false;
    }
  };

  const deleteBookWithRetry = async (bookPath, attempts = 10) => {
    let last = null;
    for (let i = 0; i < attempts; i += 1) {
      last = JSON.parse(
        await exec(`window.api.deleteBook(${JSON.stringify(bookPath)}).then((r) => JSON.stringify(r))`)
      );
      if (last && last.ok === true) return last;
      await sleep(200);
    }
    return last;
  };

  // ---------- 场景前导工具（第 0–51 组拆组时从 e2e-scenario.js 原样下沉；逐字未改行为） ----------

  // 场景开始时让自动化窗口拿一次系统焦点（2026-11-01 v0.9 R0）：
  // Chromium 在窗口没有系统焦点时，元素 focus() 可能不派发 focus / focusin 事件，
  // 会让「Tab 聚焦整理按钮出选择卡」这类键盘断言偶发超时（基线首跑实测 1 次，重跑即过）。
  // 拿不到焦点也不中断（只 warn），避免把工作站锁屏等情况误判成功能回归。
  const ensureWindowFocus = async () => {
    try {
      if (!win.isDestroyed()) {
        win.show();
        win.focus();
        win.webContents.focus();
      }
    } catch { /* 窗口可能正在销毁 */ }
    for (let i = 0; i < 10; i += 1) {
      try {
        if (await exec('document.hasFocus() === true')) return true;
      } catch { /* 页面可能还没就绪 */ }
      try { win.focus(); } catch { /* 忽略 */ }
      await sleep(WAIT.FOCUS);
    }
    console.warn('[e2e] 窗口拿不到系统焦点：键盘 / 焦点类断言可能不稳定（继续跑，不中断）');
    return false;
  };

  // 窗口尺寸偶发被系统「吞掉」（2026-11-04 进度记录：组 33 / 42 / 50 拿到的是上一次的
  // innerWidth —— 同一份代码重跑即过）。实测：`win.setSize` 已经把外层尺寸改对了
  //（getBounds / getContentSize 都是新值），但窗口被别的窗口盖住时 Chromium 会暂停渲染，
  // 渲染层的 window.innerWidth 一直停在旧值，布局也跟着是旧的。这里每次重试前先 moveTop
  //（只抬 z 序、不抢焦点），再 setSize，并等**渲染层内宽**进到期望区间才返回（不看
  // win.getSize()：外层尺寸先变、渲染层没收到就是这次的偶发）。只给 E2E 用；
  // 它只负责「等尺寸落定」，断言仍然按测量值判，不放宽任何语义。
  // options.minInner / maxInner 是 innerWidth 的允许区间；都不传时等 win.getSize() ±2。
  const setWindowSize = async (width, height, options = {}) => {
    const timeout = Number.isFinite(options.timeout) ? options.timeout : 4000;
    const minInner = Number.isFinite(options.minInner) ? options.minInner : -Infinity;
    const maxInner = Number.isFinite(options.maxInner) ? options.maxInner : Infinity;
    const checkInner = Number.isFinite(options.minInner) || Number.isFinite(options.maxInner);
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        if (win && !win.isDestroyed()) {
          win.moveTop();
          win.setSize(width, height);
        }
      } catch { /* 窗口正在销毁 / 平台拒绝：下一轮再看 */ }
      await sleep(180);
      try {
        if (!win || win.isDestroyed()) return false;
        if (checkInner) {
          const inner = Number(await exec('window.innerWidth'));
          if (Number.isFinite(inner) && inner >= minInner && inner <= maxInner) return true;
        } else {
          const [w, h] = win.getSize();
          if (Math.abs(w - width) <= 2 && Math.abs(h - height) <= 2) return true;
        }
      } catch { /* 页面切换间隙可能短暂失败 */ }
      if (Date.now() > deadline) return false;
    }
  };

  // 读「测试书」某一章的磁盘正文：测试书 = 书架目录下固定的「测试书」（场景里 bookDir 同一份口径）。
  const diskText = async (file) => {
    const bookDir = path.join(config.booksRoot, '测试书');
    const loaded = await storage.loadChapterText(bookDir, file);
    return loaded.text;
  };

  // 等主进程真的把文件写出来（范围导出确认后是异步写盘）
  const waitForFile = async (file, timeout = 10000) => {
    const startedAt = Date.now();
    for (;;) {
      try {
        const stat = await fs.stat(file);
        if (stat.isFile() && stat.size > 0) return;
      } catch {
        /* 还没写出来 */
      }
      if (Date.now() - startedAt > timeout) throw new Error(`等待文件超时：${file}`);
      await sleep(WAIT.POLL);
    }
  };

  // 导出范围对话框的摘要要等主进程算完（book:export-plan 是异步的）
  const waitForSummary = async (needle, timeout = 8000) => {
    const startedAt = Date.now();
    let text = '';
    for (;;) {
      try {
        text = await exec('window.__cwTest.exportSummary()');
      } catch {
        /* 对话框可能刚开 */
      }
      if (typeof text === 'string' && text.includes(needle)) return text;
      if (Date.now() - startedAt > timeout) {
        throw new Error(`等待导出摘要超时：${needle} :: ${text}`);
      }
      await sleep(WAIT.POLL);
    }
  };

  // 等主进程侧真正收到「可以关闭 / 不许关闭」的回执
  const waitCloseReady = async (timeout = 15000) => {
    const startedAt = Date.now();
    for (;;) {
      const value = getCloseReady();
      if (value !== undefined) return value;
      if (Date.now() - startedAt > timeout) throw new Error('等待 close-ready 超时');
      await sleep(WAIT.POLL);
    }
  };

  // 剪贴板是主进程能力：E2E 在这里直接读写，验证「复制本章」真的进了系统剪贴板
  const readClipboard = async () => {
    const value = await clipboard.readText();
    return typeof value === 'string' ? value : String(value == null ? '' : value);
  };
  const waitForClipboard = async (predicate, timeout = 8000) => {
    const startedAt = Date.now();
    let value = '';
    for (;;) {
      value = await readClipboard();
      if (predicate(value)) return value;
      if (Date.now() - startedAt > timeout) {
        throw new Error(`等待剪贴板超时：${JSON.stringify(value.slice(0, 80))}`);
      }
      await sleep(WAIT.POLL);
    }
  };

  return {
    checks,
    failures,
    check,
    recordFailure,
    summary,
    WAIT,
    waitForRender,
    waitForFocus,
    waitForDisk,
    waitFor,
    readLogs,
    waitForLog,
    deleteBookWithRetry,
    fileExists,
    logDir,
    logNamePattern,
    // 场景前导工具（第 0–51 组拆组时下沉；组文件通过 t 拿同一份）
    ensureWindowFocus,
    setWindowSize,
    diskText,
    waitForFile,
    waitForSummary,
    waitCloseReady,
    readClipboard,
    waitForClipboard
  };
}

module.exports = { createHarness };
