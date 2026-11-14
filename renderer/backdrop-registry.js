/* 弹层注册表（v1.8.0 WP-17 / 审计 C35）——纯逻辑，不碰 DOM、不读盘、不写盘。
 *
 * 改之前「现在有哪些弹层」在渲染层有两份事实，而且对不上：
 *   · renderer.js 的 ESC_BACKDROPS：Esc 链探针的 15 个 backdrop，外加单独算的 state.modal / 命令面板；
 *   · renderer/capture-ui.js 的 panelBlocked()：手写 9 个 backdrop id。
 * 后果（审计 C35）：校对 / 敏感词 / 灵感箱 / 插入碎片 / 分组管理 / 命令面板 / 快捷键一览这 7 层开着时，
 * 全局捕获快捷键仍会把捕获面板叠上来（它只认那 9 层）；以后新增弹层还得记得再改一遍 capture-ui。
 *
 * 现在 index.html 里每个 `<div id="X-backdrop" class="backdrop …">` 只在这里登记一次（共 17 层），
 * 消费方全部读这张表：
 *   · renderer.js：escProbe / anyBackdropOpen（CLASS_LAYERS + isBlocked）；
 *   · renderer/capture-ui.js：panelBlocked（isBlocked($, { except: 'capture' })，自己那层由
 *     preflight 的 ALREADY_OPEN 先挡，不能算成「别的弹窗挡着」）。
 * 新增 / 删除弹层只改 LIST：tests/backdrop-registry.test.js 会拿 index.html 的实际 backdrop 逐项对账，
 * 少登记一层（该层开着时捕获面板能叠上来）或写错 id 都会当场红。
 *
 * 两种开合来源：
 *   · CLASS_LAYERS（15 层）：`${name}-backdrop` 元素没有 .hidden 就算开着 —— escProbe 按这个口径摊字段；
 *   · STATE_LAYERS（modal / command）：backdrop 类名同样跟着开合走（openModal / commandPalette 各自同步），
 *     但 Esc 探针另有状态源（state.modal / commandPalette.isOpen()，见 renderer.js 的 escProbe），
 *     所以它们只进 LIST / isBlocked，不进 CLASS_LAYERS —— 探针字段口径与改前逐项一致。
 *
 * 浏览器里挂成全局 CWBackdropRegistry（index.html 排在 capture-ui.js 与 renderer.js 之前），Node 里
 * 可以直接 require。为什么单独一个文件：renderer.js 有行数闸门，而这种「清单只许一份」的东西必须能
 * 被单测直接钉住（tests/backdrop-registry.test.js）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (root) root.CWBackdropRegistry = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 17 层，与 index.html 的 backdrop 一一对应。CLASS_LAYERS 的书写顺序沿用旧 ESC_BACKDROPS，
  // 便于对照；isBlocked 只问「有没有任何一层开着」，顺序不参与判定。
  const LIST = [
    // Esc 链按 `${name}-backdrop` 现算的 15 层
    'conflict', 'bookinfo', 'history', 'format', 'export', 'settings', 'jump', 'find',
    'fragment', 'fragments', 'proofread', 'sensitive', 'capture', 'shortcuts',
    'group-manage',
    // 另有状态源的两层（仍参与「有没有弹层开着」的判定）
    'modal', 'command'
  ];

  // Esc 探针另有状态源、不按 backdrop 类名摊字段的两层（renderer.js 的 escProbe 单独写 state.modal /
  // commandPalette.isOpen()，与改前一致）。
  const STATE_LAYERS = ['modal', 'command'];
  const CLASS_LAYERS = LIST.filter((name) => STATE_LAYERS.indexOf(name) < 0);

  // 'find' / 'find-backdrop' 都认，统一成元素 id。
  function backdropId(name) {
    const text = String(name == null ? '' : name);
    return /-backdrop$/.test(text) ? text : text + '-backdrop';
  }

  // 这一层是否开着。$ 是渲染层的 document.getElementById 包装；拿不到元素按「关着」算。
  function isOpen($, name) {
    if (typeof $ !== 'function') return false;
    const el = $(backdropId(name));
    return Boolean(el && el.classList && !el.classList.contains('hidden'));
  }

  // 现在开着的层名（调试 / 测试用；顺序同 LIST）。
  function openNames($) {
    return LIST.filter((name) => isOpen($, name));
  }

  // 有没有任何登记过的弹层开着。options.except 传调用方自己那层（'capture' 或 'capture-backdrop'），
  // 判定时跳过它 —— 与改前 panelBlocked 不看 capture-backdrop 的口径一致。
  function isBlocked($, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const except = opts.except ? backdropId(opts.except) : '';
    for (const name of LIST) {
      if (backdropId(name) === except) continue;
      if (isOpen($, name)) return true;
    }
    return false;
  }

  // B16（v1.8.0 WP-29）：弹层开合缓存。渲染层的全局 keydown 每次都要问「有没有弹层开着」，
  // 改前每次都 getElementById + classList 扫 17 层（打字热路径上的纯重复 DOM 读）。
  // createOpenWatcher 在创建时算一次，并给每层挂一个 MutationObserver（只观察 class 属性）：
  // 任何一层开 / 关都在同一拍刷新缓存，之后 isOpen() 是纯读变量。
  // 没有 MutationObserver（或一层元素都找不到）时退回逐层现算，语义与改前完全一致。
  // MutationObserver 构造函数可注入（单测用假实现，不依赖真实 DOM）。
  function createOpenWatcher($, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const Observer = opts.MutationObserver || (typeof MutationObserver === 'function' ? MutationObserver : null);
    let cached = isBlocked($);
    let observer = null;
    if (Observer) {
      observer = new Observer(() => {
        cached = isBlocked($);
      });
      let watched = 0;
      for (const name of LIST) {
        const el = $(backdropId(name));
        if (!el || typeof el !== 'object') continue;
        observer.observe(el, { attributes: true, attributeFilter: ['class'] });
        watched += 1;
      }
      if (!watched) observer = null;
    }
    return {
      supported: Boolean(observer),
      isOpen() {
        if (observer) return cached;
        return isBlocked($);
      },
      refresh() {
        cached = isBlocked($);
        return cached;
      },
      disconnect() {
        if (observer && typeof observer.disconnect === 'function') observer.disconnect();
        observer = null;
      }
    };
  }

  return { LIST, STATE_LAYERS, CLASS_LAYERS, backdropId, isOpen, openNames, isBlocked, createOpenWatcher };
});