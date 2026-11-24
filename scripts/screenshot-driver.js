// 章回 · 截图 / E2E 驱动（开发自检专用）
// v0.9 B-1（代码审计 F7）：这段代码原来整块长在 main.js 里（约 620 行），只有 --screenshot / --e2e
// 才会执行；现在挪到 scripts/ 下，由 main.js 的 runAutomation() 在自动化模式下「用到才 require」。
// 为什么放在 scripts/ 而不是 core/：打包配置 build.files 只含 main.js / preload.js / core / renderer /
// package.json，安装版里没有 scripts/ —— 只用于开发截图与自检的代码不该进用户安装包。
// 约束：本文件不 require electron（窗口 / app / 剪贴板 / 文件系统全部由 host 传入），
// 因此单元测试可以直接 require 它（tests/screenshot-driver.test.js）。

// sleep 用 core/common.js 的同一份实现（纯逻辑、不 require electron），本文件仍能脱离主进程单独 require。
const { sleep } = require('../core/common');
// CI-F8：--dialog 摆姿表（开发截图专用；行为与拆分前逐字一致）。
const { applyDialogPose } = require('./screenshot-dialog-poses');
// 审计修复 #53（R7）：等待 / 注入的实现收进 scripts/driver-poll.js（与 a11y-gate 共用同一份轮询）。
const { pollUntil, execInRenderer } = require('./driver-poll');
// 1.6.0 A6：剪贴板恢复 + 焦点抢夺限组（和 scripts/e2e/groups/index.js 共享同一个开关）。
const politeness = require('./e2e-politeness');

async function waitForRenderer(win, expr, timeout = 12000) {
  // 页面切换间隙 executeJavaScript 会抛错：pollUntil 把它当作「还没好」继续等（旧行为逐字一致）；
  // 超时文案仍是「等待超时：<表达式>」。
  return pollUntil(() => win.webContents.executeJavaScript(expr, true), {
    timeout,
    interval: 120,
    label: expr
  });
}

// E2E 专用：工作站锁屏 / 没有交互桌面时，Windows 会拒绝所有进程的剪贴板读写
// （OpenClipboard 返回 ACCESS_DENIED，clipboard.readText() 恒为空）。这跟应用代码无关，
// 但会让「复制整本 / 复制本章」的校验半途中断。此时改用进程内剪贴板继续验证
// 「拼出来的文本对不对」，并明确报告真实剪贴板集成未被验证；生产运行永远用系统剪贴板。
//
// 1.6.0 A6：探针会覆盖用户自己的剪贴板，所以先存原文（originalText），E2E 收尾由
// restoreE2EClipboard() 写回去；进程内替身不碰系统剪贴板，也不尝试恢复。
async function createE2EClipboard(clipboard) {
  let originalText = null;
  try {
    const original = await clipboard.readText();
    if (typeof original === 'string') originalText = original;
  } catch {
    originalText = null;
  }
  let systemOk = false;
  try {
    const probe = `cw-clip-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await clipboard.writeText(probe);
    const read = await clipboard.readText();
    systemOk = typeof read === 'string' && read === probe;
  } catch {
    systemOk = false;
  }
  if (systemOk) return { clipboard, synthetic: false, systemOk: true, originalText };
  let text = '';
  console.warn(
    '[e2e] 系统剪贴板不可用（工作站可能锁屏/无交互桌面），改用进程内剪贴板校验复制逻辑；真实剪贴板集成未被验证。'
  );
  return {
    synthetic: true,
    systemOk: false,
    originalText: null,
    clipboard: {
      writeText: async (value) => {
        text = String(value == null ? '' : value);
      },
      readText: async () => text
    }
  };
}

// 开发截图（--dialog=…）共用的注入脚本片段：只在临时 userData / 演示书库里跑，用来把界面摆到
// 「能截图」的状态；和真实功能无关，不写盘、不写配置。抽出来避免同一段脚本复制三遍。
const SCREENSHOT_PICK_CHAR_JS = `
        const text = window.__cwTest.text();
        const counts = new Map();
        for (const ch of text) {
          if (/[\\u4e00-\\u9fa5]/.test(ch)) counts.set(ch, (counts.get(ch) || 0) + 1);
        }
        let best = '';
        let bestCount = 0;
        for (const [ch, n] of counts) {
          if (n > bestCount) { best = ch; bestCount = n; }
        }`;

// 「把光标放进第一段超过 20 字的正文」——当前段落高亮 / 查找类截图共用；extra 是额外执行的脚本。
function screenshotCaretLongLineScript(extra = '') {
  return `(() => {
        const text = window.__cwTest.text();
        const lines = text.split('\\n');
        let offset = 0;
        let line = 0;
        let target = 0;
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i].trim().length > 20) {
            line = i;
            target = offset + Math.min(lines[i].length - 1, 20);
            break;
          }
          offset += lines[i].length + 1;
        }
        window.__cwTest.setCaret(target);
        const height = parseFloat(getComputedStyle(document.getElementById('editor')).lineHeight) || 32;
        window.__cwTest.setEditorScroll(Math.max(0, (line - 2) * height));
        ${extra}
      })()`;
}

// 导出 EPUB / DOCX 截图共用：在范围对话框里选「按卷导出」并挑第一个卷
const SCREENSHOT_PICK_VOLUME_JS = `(() => {
        const radio = document.querySelector('input[name="export-scope"][value="volume"]');
        if (radio) radio.click();
        const select = document.getElementById('export-volume');
        if (select && select.options.length > 1) {
          select.selectedIndex = 1;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()`;

async function run(host) {
  const fs = host.fs;
  const path = host.path;
  const app = host.app;
  const storage = host.storage;
  const repair = host.repair;
  const exporter = host.exporter;
  const isE2E = Boolean(host.isE2E);
  const getConfig = host.getConfig;
  const argValue = host.argValue;
  const permissionHandlers = host.getPermissionHandlers();
  const shot = host.screenshot || {};
  const screenshotPath = shot.path || null;
  const screenshotBook = shot.book || null;
  const screenshotChapter = shot.chapter == null ? null : shot.chapter;
  const screenshotDialog = shot.dialog || null;
  let focusStealTimer = null;
  try {
    const win = host.getWin();
    // 审计修复 #53（R7）：注入统一走 driver-poll 的 execInRenderer，run 内只留一个 exec(code) 别名
    // （以前 80+ 处逐字重复 win.webContents.executeJavaScript(..., true)）。
    // TOOL-C-08：84 处调用都带着第二个实参（userGesture，旧 executeJavaScript 的手势口径）；
    // 别名以前只收一个参数、第二个被静默丢弃。现在显式接住并转传（默认 true 与旧行为一致）。
    const exec = (code, userGesture = true) => execInRenderer(win, code, userGesture);
    // E2E 专用（2026-11-04）：Electron 文档写明 sendInputEvent 只在窗口**有焦点**时投递；
    // 自动化在后台跑时窗口会被别的程序抢走焦点，于是真实键盘 / 悬停断言偶发假红（组 69 / 70）。
    // 同理，窗口被别的窗口盖住时 Chromium 会把渲染层当后台页暂停，程序化 win.setSize 改的是
    // 外层尺寸，渲染层 window.innerWidth / 布局一直停在旧值（组 33 / 42 / 50）。这里做两件事：
    //   1) 关掉后台节流，让 resize / 渲染不被当作后台页；
    //   2) 只在「焦点跑到应用外」时把焦点拿回来（应用内多窗口切换不动，组 55 仍按自己的焦点走）。
    // 只是给真实输入 / resize 断言补上前置条件，不改任何断言；screenshot-driver.js 不在
    // build.files 里，安装版没有这段。
    if (isE2E) {
      try { win.webContents.setBackgroundThrottling(false); } catch { /* 老版本没有这个 API */ }
      // 1.6.0 A6：焦点抢夺只在键盘组（69/70/71）前后开启（groups/index.js 的
      // runGroupWithPoliteness 翻开关）；其余组一律不抢，用户切去别的窗口也不再被拽回来。
      // 背景节流保持关闭——那是 resize / 渲染断言的前置条件，和焦点无关。
      focusStealTimer = setInterval(() => {
        try {
          if (win.isDestroyed()) return;
          const anotherAppWindowFocused = host
            .listSessions()
            .some((session) => session.win && session.win !== win && !session.win.isDestroyed() && session.win.isFocused());
          if (
            !politeness.shouldStealFocus({
              enabled: politeness.isFocusStealEnabled(),
              destroyed: false,
              focused: win.isFocused(),
              anotherAppWindowFocused
            })
          ) {
            return;
          }
          win.show();
          win.focus();
          win.webContents.focus();
        } catch { /* 窗口销毁 / 会话变化：下一拍再看 */ }
      }, 600);
    }
    await waitForRenderer(win, 'Boolean(window.__cwTest && window.__cwTest.ready)', 15000);
    if (screenshotPath) {
      if (screenshotBook) {
        await exec(
          `window.__cwTest.openBookPath(${JSON.stringify(screenshotBook)})`,
          true
        );
        await sleep(500);
        if (screenshotChapter != null) {
          await exec(
            `window.__cwTest.switchTo(${Number(screenshotChapter)}, 'discard')`,
            true
          );
          await sleep(350);
        }
      }
      // 开发截图可临时改章节栏宽度（只影响本次截图，不写配置）
      if (argValue('sidebar-width')) {
        await exec(
          `window.__cwTest.setSidebarWidth(${Number(argValue('sidebar-width'))})`,
          true
        );
        await sleep(200);
      }
      // CI-F8：--dialog 摆姿表拆到 scripts/screenshot-dialog-poses.js（run() 只留驱动主干）。
      if (screenshotDialog) {
        await applyDialogPose(screenshotDialog, {
          exec,
          sleep,
          argValue,
          win,
          waitForRenderer,
          screenshotBook,
          // CI-F8：摆姿里还会用到这三个注入片段 / 脚本（行为与拆分前一致）
          SCREENSHOT_PICK_CHAR_JS,
          SCREENSHOT_PICK_VOLUME_JS,
          screenshotCaretLongLineScript
        });
      }
      await sleep(500);
      const image = await win.webContents.capturePage();
      await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
      await fs.writeFile(screenshotPath, image.toPNG());
      console.log(`[screenshot] ${screenshotPath}`);
    }
    if (isE2E) {
      const scenario = require('./e2e-scenario.js');
      const e2eClipboard = await createE2EClipboard(host.clipboard);
      host.setClipboard(e2eClipboard.clipboard);
      let result;
      try {
        result = await scenario({
        win,
        app,
        clipboard: e2eClipboard.clipboard,
        config: await getConfig(),
        userData: app.getPath('userData'),
        storage,
        repair,
        exporter,
        sleep,
        exec: (code) => execInRenderer(win, code),
        // ---------- 多窗口 E2E 辅助 ----------
        openWindow: async (bookPath = null) => {
          const created = await host.createWindow({ bookPath: bookPath || null, cascade: true });
          return created.id;
        },
        closeWindow: (windowId) => {
          const session = host.sessionById(windowId);
          if (!session) return false;
          session.win.close();
          return true;
        },
        destroyWindow: (windowId) => {
          const session = host.sessionById(windowId);
          if (!session) return false;
          session.forceClose = true;
          session.win.destroy();
          return true;
        },
        execIn: (windowId, code) => {
          const session = host.sessionById(windowId);
          if (!session) throw new Error(`窗口不存在：${windowId}`);
          return execInRenderer(session.win, code);
        },
        focusWindow: (windowId) => host.focusSession(host.sessionById(windowId)),
        windowsInfo: () =>
          host.listSessions().map((session) => ({
            id: session.id,
            bookPath: storage.openBookRegistry.getBook(session.id),
            dirty: session.dirty,
            closePending: session.closePending,
            destroyed: session.win.isDestroyed(),
            focused: !session.win.isDestroyed() && session.win.isFocused()
          })),
        openBookRegistry: () => storage.openBookRegistry.list(),
        registryCounts: () => storage.openBookRegistry.counts(),
        mostRecentWindowId: () => storage.openBookRegistry.mostRecentWindow(),
        windowBounds: (windowId) => {
          const session = host.sessionById(windowId);
          return session ? session.win.getBounds() : null;
        },
        setRealClose: (on) => host.setRealClose(on),
        // WP-09（C6）：单独把「关窗前保存窗口位置」拖慢，复现回执与真正关窗之间的竞态窗口
        //（不拖慢其它配置写；0 = 恢复）。
        setCloseBoundsDelay: (ms) => host.setCloseBoundsDelay(ms),
        windowAllClosed: () => host.isWindowAllClosed(),
        getCloseReady: (windowId) => host.getCloseReady(windowId),
        resetCloseReady: (windowId) => host.resetCloseReady(windowId),
        // ---------- Electron 安全开关（v0.9 C-1）自检辅助 ----------
        // securityInfo：真实窗口的 webPreferences / 单实例锁 / 所有 webContents 的类型，
        //   交给 E2E 和 core/security-policy.js 逐项对账（只读）。
        securityInfo: () => {
          const contents =
            win && !win.isDestroyed() ? win.webContents : null;
          const prefs =
            contents && !contents.isDestroyed() ? contents.getLastWebPreferences() || {} : {};
          return {
            webPreferences: prefs,
            singleInstanceLock: app.hasSingleInstanceLock(),
            sessionHandlers: Boolean(permissionHandlers.request && permissionHandlers.check),
            contentTypes: host.getContentTypes()
          };
        },
        // securityProbe：直接调用「真的注册给 Electron 的那两个处理器」，证明它们确实一律拒绝；
        //   顺带带回被拒绝请求的日志字段（真的写进日志的那份，不含本机路径）。
        securityProbe: () => {
          let granted = null;
          let callbackCalled = false;
          if (permissionHandlers.request) {
            permissionHandlers.request(
              {},
              'geolocation',
              (value) => {
                callbackCalled = true;
                granted = value;
              },
              {
                requestingOrigin: 'file:///C:/Users/fake/Desktop/%E7%A7%81%E4%BA%BA%E4%B9%A6%E7%9B%AE/ch1.txt',
                isMainFrame: true
              }
            );
          }
          return {
            request: { callbackCalled, granted },
            check: permissionHandlers.check
              ? permissionHandlers.check({}, 'geolocation', 'file:///C:/Users/fake/Desktop/ch1.txt', {})
              : null,
            lastDenial: host.getLastPermissionDenial()
          };
        }
      });
      } finally {
        // 1.6.0 A6：不管场景成功还是抛错，都把探针前的系统剪贴板原文写回去，并停掉抢焦点轮询。
        if (focusStealTimer) {
          clearInterval(focusStealTimer);
          focusStealTimer = null;
        }
        await politeness.restoreE2EClipboard(host.clipboard, e2eClipboard);
      }
      console.log(
        `E2E_RESULT ${JSON.stringify({ ...result, clipboardSynthetic: e2eClipboard.synthetic })}`
      );
      app.exit(result && result.ok ? 0 : 1);
      return;
    }
    if (screenshotPath) app.exit(0);
  } catch (err) {
    console.error('[automation] 失败:', err && err.stack ? err.stack : err);
    console.log(`E2E_RESULT ${JSON.stringify({ ok: false, error: String((err && err.stack) || err) })}`);
    app.exit(1);
  } finally {
    // 场景之外的早退（截图失败 / createE2EClipboard 抛错）也要停轮询，免得进程带着定时器。
    if (focusStealTimer) {
      clearInterval(focusStealTimer);
      focusStealTimer = null;
    }
  }
}

module.exports = {
  run,
  waitForRenderer,
  createE2EClipboard,
  screenshotCaretLongLineScript,
  SCREENSHOT_PICK_CHAR_JS,
  SCREENSHOT_PICK_VOLUME_JS,
  // 1.6.0 A6：礼貌化判定（焦点抢夺限组 / 剪贴板恢复）；单测经驱动取的就是 E2E 用的同一份实现。
  FOCUS_STEAL_GROUPS: politeness.FOCUS_STEAL_GROUPS,
  focusStealWindow: politeness.focusStealWindow,
  enableFocusSteal: politeness.enableFocusSteal,
  disableFocusSteal: politeness.disableFocusSteal,
  isFocusStealEnabled: politeness.isFocusStealEnabled,
  shouldStealFocus: politeness.shouldStealFocus,
  runGroupWithPoliteness: politeness.runGroupWithPoliteness,
  clipboardRestorePlan: politeness.clipboardRestorePlan,
  restoreE2EClipboard: politeness.restoreE2EClipboard
};
