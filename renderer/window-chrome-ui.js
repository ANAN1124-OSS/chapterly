/* 自绘标题栏的渲染层部分（1.3.0 T6 / 规范 I-07）。
 *
 * 只做一件事：窗口失焦 / 回焦时给 <body> 挂 / 摘 window-inactive。
 *   - 纸色 -2%：styles.css 里 body.window-inactive #app::after 压的那一层 2% 暗色；
 *   - 朱红降灰：styles.css 里 body.window-inactive / body.theme-night.window-inactive 换的
 *     --accent / --accent-soft 两档；
 *   - 右上角系统按钮区（Windows 画的）的底色 / 字形色由主进程按同一套主题表刷
 *     （core/window-chrome.js，窗口 focus / blur 事件里调 setTitleBarOverlay）。
 *
 * 边界：纯显示层。不写配置、不碰正文 / 书目 / 章节文件、不改 IPC、不加 DOM、不建定时器；
 * 只加一个 body class，卸载（页面关掉）即消失。
 *
 * 浏览器里挂成全局 CWWindowChromeUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWWindowChromeUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CLASS_NAME = 'window-inactive';

  // host 只在单测里传（假的 window / document）；渲染层直接调用 createWindowChromeUi()。
  function createWindowChromeUi(host) {
    const win = (host && host.win) || (typeof window !== 'undefined' ? window : null);
    const doc = (host && host.doc) || (typeof document !== 'undefined' ? document : null);
    if (!win || typeof win.addEventListener !== 'function') throw new TypeError('createWindowChromeUi 需要 window');
    if (!doc || !doc.body || !doc.body.classList) throw new TypeError('createWindowChromeUi 需要 document.body');

    let installed = false;

    function setInactive(inactive) {
      doc.body.classList.toggle(CLASS_NAME, Boolean(inactive));
    }

    function isInactive() {
      return doc.body.classList.contains(CLASS_NAME);
    }

    // 启动时先对齐一次：窗口在后台启动（自动化 / 从别的窗口打开）时直接就是失焦态，
    // 不能等到第一次 blur 才降级。
    function syncNow() {
      setInactive(typeof doc.hasFocus === 'function' ? !doc.hasFocus() : false);
    }

    const api = {
      CLASS_NAME,
      install,
      setInactive,
      isInactive,
      syncNow
    };

    // 幂等：重复 install 只挂一次监听（renderer 只调一次，单测里会故意调两次）。
    function install() {
      if (installed) return api;
      installed = true;
      win.addEventListener('blur', () => setInactive(true));
      win.addEventListener('focus', () => setInactive(false));
      syncNow();
      return api;
    }

    return api;
  }

  return { createWindowChromeUi, CLASS_NAME };
});
