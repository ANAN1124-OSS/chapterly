/* 主进程 → 渲染层的通知接线（M1 第一轮·低 第八刀：从 renderer.js 的 bindEvents 整段搬出来）。
 *
 * 为什么搬这一块：bindEvents 里紧挨着「快捷键一览」之后是一整排 api.on* 订阅——导入进度 / 捕获触发 /
 * 剪贴板变化 / 剪贴板入队 / 关窗 / 强制退出 / 命令面板 / 书架变更。它们都是「收到一条主进程通知 →
 * 调一个既有入口 / 出一条既有提示」，没有一条自己写盘、改正文或切章，所以整段搬、不拆。
 *
 * 契约：createNotifyEventsUi(host) 由渲染层调用一次；bind() 只做一件事——按原来的顺序调用
 * host.api 的 8 个 on* 订阅（订阅顺序 = 原 bindEvents 里的注册顺序，别在这里重排）。
 * 模块不反向持有大对象；缺任何一个成员直接抛 TypeError（宁可在启动时炸，也不要到通知到达时才
 * ReferenceError）。
 *
 * 红线不变：这一域只做「通知 → 分发」——保存仍走 saveCurrent、关窗询问仍走 handleCloseRequest、
 * 捕获面板仍走 captureUi、书架刷新仍走 shelfUi；模块自己不碰文件系统 / Electron。
 * 浏览器里挂成全局 CWNotifyEventsUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../core/assert-host').assertHost);
  } else if (root) {
    root.CWNotifyEventsUi = factory(root.CWAssertHost && root.CWAssertHost.assertHost);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (assertHost) {
  'use strict';

  const REQUIRED_HOST = [
    'api', 'state', 'toast', 'toastActionable', 'formatCount', 'hasImportProgress',
    'setImportProgressText', 'captureUi', 'hideHeaderMenus', 'handleCloseRequest',
    'saveCurrent', 'shelfUi', 'openCommandPalette'
  ];

  function createNotifyEventsUi(host) {
    // A8（WP-32）：REQUIRED_HOST 逐成员校验走共享实现（文案不变）。
    assertHost('createNotifyEventsUi', host, REQUIRED_HOST);
    const {
      api, state, toast, toastActionable, formatCount, hasImportProgress,
      setImportProgressText, captureUi, hideHeaderMenus, handleCloseRequest,
      saveCurrent, shelfUi, openCommandPalette
    } = host;

    // 订阅的函数体与搬前逐字一致（只有自由变量改成 host 解构出来的同名常量）。
    function bind() {
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
        // P6：章节目录形态带上「第几个文件」（主进程节流后回报），20,000 章的目录导入看得出在走。
        const files = progress.files && progress.files.total ? `（已复制 ${Math.min(progress.files.done, progress.files.total)}/${progress.files.total} 个文件）` : '';
        setImportProgressText(`正在导入 ${Math.min(progress.done + 1, progress.total)}/${progress.total}：${progress.current || ''}${files}`);
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
    }

    // 注册点由渲染层决定（bindEvents 里与原来同一位置）：订阅顺序 = 原 bindEvents 的注册顺序。
    return { bind };
  }

  return { create: createNotifyEventsUi, REQUIRED_HOST };
});
