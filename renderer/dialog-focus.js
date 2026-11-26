/* 弹层焦点管理（v0.9 A-5 无障碍与键盘）——浏览器侧，只决定「焦点去哪儿」，不碰数据、不写盘。
 *
 * 修的是键盘 / 读屏用户真正会撞上的三件事（以前都没有兜住）：
 *   1. 弹层打开时焦点还留在背景（编辑区 / 书架），要 Tab 一圈背景才进得来；
 *   2. 弹层开着时 Tab 能跑到背景元素上——看起来是模态，实际没困住；
 *   3. 弹层关掉后焦点丢到 <body>，键盘用户得从头 Tab 回来。
 *
 * 做法：
 *   · 盯页面里所有 .backdrop 的 class（1.5.0 时 16 个）：可见的那些里，z-index 最高的就是当前弹层
 *     （#modal-backdrop 是 300，其余 100，与 styles.css 的层级一致；同 z 用 DOM 顺序）；
 *   · 打开：焦点不在弹层里就落到第一个可聚焦元素（代码自己已 focus 过的保持不动）；
 *   · 开着：Tab / Shift+Tab 在首尾绕回（中间交给浏览器的原生遍历，顺序不变）；
 *     焦点在背景时按 Tab 也先拉回弹层；
 *   · 关闭：只有焦点真丢到 body / html 了才还给「打开前那个元素」——业务代码自己
 *     focus 了别处（例如存完回到编辑区）就不抢。
 *   · **不抢程序化焦点**：find 面板的「替换这一处」要把焦点交给编辑区才能 insertText，
 *     焦点管理只在「用户按 Tab」这一条路上兜住，别的 focus 一律不动。
 *
 * 为什么单独一个文件：renderer.js 有 9600 行闸门测试，焦点策略集中在这一处也方便
 * 单测（纯决策函数）与 E2E（真实 Electron + 真实 Tab 按键）。
 * 边界：只处理 .backdrop 弹层；顶栏下拉菜单（整理 ▾ / 显示 ▾）不是模态，不在这里管。
 *
 * 契约（1.7.2 D6 / V88）：**弹层必须静态 DOM（加载时就存在）**。
 * 运行期新增的弹层要在 index.html 里先声明 —— install 时一次性抓页面里的 .backdrop、只给这一批
 * 挂 class observer；之后 document.createElement 现造再插进来的弹层不会被接管（不报错，只是
 * 焦点不困住、关闭不归还，键盘用户还得 Tab 一圈背景才进得来）。所以新弹层一律先在 index.html 里
 * 写好那个 .backdrop（默认 .hidden + aria-hidden="true"），运行期只切 class，不改 DOM 结构。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./focus-nav'));
  } else if (root) {
    root.CWDialogFocus = factory(root.CWFocusNav);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (focusNav) {
  'use strict';

  // REDT-C-06：可达性判定与聚焦助手收进 renderer/focus-nav.js（与 menu-keyboard / list-keyboard 共用）。
  if (!focusNav || typeof focusNav.isUsable !== 'function') {
    throw new Error('CWDialogFocus：renderer/focus-nav.js 没有先加载');
  }
  const { isUsable, focusElement } = focusNav;

  // Tab 能到的地方：与浏览器默认遍历的口径一致（负 tabindex 由 isTabbable 再筛掉）。
  const FOCUSABLE_SELECTOR = [
    'a[href]',
    'area[href]',
    'button',
    'input',
    'select',
    'textarea',
    'iframe',
    'summary',
    '[contenteditable="true"]',
    '[tabindex]'
  ].join(',');

  // 可见弹层里挑最上面那个：先比 z-index，再按 DOM 顺序取后面的（与浏览器绘制一致）。
  function pickTopIndex(states) {
    let top = -1;
    let topZ = -Infinity;
    for (let i = 0; i < states.length; i += 1) {
      const item = states[i];
      if (!item || !item.open) continue;
      const z = Number.isFinite(item.z) ? item.z : 0;
      if (z >= topZ) {
        top = i;
        topZ = z;
      }
    }
    return top;
  }

  // Tab / Shift+Tab 的落点：在首尾绕回，其余原样前进 / 后退（count 为 1 时原地不动）。
  function tabTarget(index, count, backwards) {
    if (!Number.isFinite(count) || count <= 0) return -1;
    if (count === 1) return 0;
    if (!Number.isFinite(index) || index < 0) return backwards ? count - 1 : 0;
    // 越界下标夹到最后一项（正常调用拿不到；防的是两次按键之间 list 变短）
    const pos = Math.min(Math.floor(index), count - 1);
    if (backwards) return pos === 0 ? count - 1 : pos - 1;
    return pos >= count - 1 ? 0 : pos + 1;
  }

  // 关闭弹层时，焦点是不是「没有归属」了：body / html、没有 activeElement、还停在
  // 刚关掉的弹层里、或者干脆已经不可见——这几种才把焦点还给打开前的元素；
  // 业务代码自己 focus 了别处（例如存完回到编辑区）就不抢。
  // 注意：Chromium 在祖先 display:none 之后**不会**把 activeElement 重置成 body
  // （真窗口实测：关掉设置后 activeElement 还停在弹层里的 input 上），所以要单独判。
  function shouldRestoreFocus(state) {
    if (!state) return true;
    if (state.isBody) return true;
    if (state.insideBackdrop) return true;
    return Boolean(state.hidden);
  }

  // 当前能不能 Tab 到：禁用 / aria-hidden / 负 tabindex / .hidden 类 / 祖先 inert / 不可见
  //（含祖先 display:none）都排除。判定本体在 renderer/focus-nav.js（REDT-C-06：与菜单条目同一份口径）。
  // 对外保留 isTabbable(el, view) 这个名字（单测与 E2E 按名取）。
  function isTabbable(el, view) {
    return isUsable(el, view);
  }

  // 弹层里可 Tab 的元素，顺序 = DOM 顺序 = 浏览器的 Tab 顺序。
  function tabbablesIn(box, view) {
    if (!box || typeof box.querySelectorAll !== 'function') return [];
    return Array.from(box.querySelectorAll(FOCUSABLE_SELECTOR)).filter((el) => isTabbable(el, view));
  }

  let installed = null;

  function install(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const doc = opts.document || (typeof document !== 'undefined' ? document : null);
    const view = opts.window || (doc && doc.defaultView) || null;
    // 一个窗口一个实例；重复调用直接返回已有实例（renderer.js 只会调一次，防呆为主）
    if (installed || !doc || !view) return installed;
    if (typeof doc.querySelectorAll !== 'function' || typeof doc.addEventListener !== 'function') return null;

    const backdrops = Array.from(doc.querySelectorAll('.backdrop'));
    let outsideFocus = null; // 打开弹层前焦点在背景的哪个元素上（关闭时归还给它）
    // A2-DIALOG-01（低）：按弹层栈记住「这一层是被哪个控件打开的」。只在没有 backdrop 时记
    // outsideFocus，会让嵌套弹层关闭上层后只能 focusFirst(下层) —— 焦点跳到「刷新」而不是刚才的
    // 删除 / 还原按钮。layerTriggers 记 层 id → 打开它的元素（可能在下层弹层里）。
    const layerTriggers = new Map();
    // 归还焦点前统一过一遍可见性 / 可用性（与 restoreOutsideFocus 同一口径）。
    const canRestoreTo = (el) => {
      if (!el || el.isConnected === false) return false;
      if (el.disabled) return false;
      if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
      return true;
    };

    const states = () =>
      backdrops.map((el) => {
        const style = view.getComputedStyle(el);
        const z = style && style.zIndex ? Number.parseInt(style.zIndex, 10) : 0;
        return { open: !el.classList.contains('hidden'), z: Number.isFinite(z) ? z : 0 };
      });

    const topIndex = () => pickTopIndex(states());
    const boxAt = (index) => (index < 0 ? null : backdrops[index].querySelector('.modal') || backdrops[index]);

    // 聚焦 + 把控件滚进可视区（拍板 #16c）——与菜单同一份助手（renderer/focus-nav.js）。
    const doFocus = (el) => focusElement(el, { scroll: true });

    const focusFirst = (box) => {
      const list = tabbablesIn(box, view);
      return list.length ? doFocus(list[0]) : false;
    };

    const restoreOutsideFocus = () => {
      const el = outsideFocus;
      if (!el || !el.isConnected) return false;
      if (el.disabled) return false;
      if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
      return doFocus(el);
    };

    let openId = null;

    // 元素现在是不是已经看不见了（祖先 display:none / visibility:hidden / 0 尺寸）
    const isHiddenElement = (el) => {
      if (!el || !el.isConnected) return true;
      if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return true;
      const style = view.getComputedStyle(el);
      return Boolean(style && (style.display === 'none' || style.visibility === 'hidden'));
    };

    // 弹层的可见状态变了：打开就把焦点带进去；最后关掉就把焦点还给背景。
    function sync() {
      const index = topIndex();
      const active = doc.activeElement;
      if (index < 0) {
        if (!openId) return;
        openId = null;
        layerTriggers.clear();
        const tag = active && active.tagName ? active.tagName.toLowerCase() : '';
        const lost = shouldRestoreFocus({
          isBody: tag === '' || tag === 'body' || tag === 'html',
          insideBackdrop: Boolean(active) && backdrops.some((el) => el.contains(active)),
          hidden: isHiddenElement(active)
        });
        if (lost) restoreOutsideFocus();
        return;
      }
      const box = boxAt(index);
      const inside = Boolean(box && active && box.contains(active));
      const id = backdrops[index].id || `backdrop-${index}`;
      if (id !== openId) {
        const previous = openId;
        // 新的一层成为最上层：如果焦点此刻在下层弹层 / 背景的某个控件上，它就是这一层的「打开者」。
        if (active && active !== doc.body && active !== doc.documentElement && !(box && box.contains(active))) {
          layerTriggers.set(id, active);
        }
        openId = id;
        // 上层的关闭让下层重新成为最上层：优先把焦点还给「刚才打开上层的那一下」，
        // 找不到（控件已隐藏 / 被移除）再退回焦点进弹层的旧行为。
        if (previous && previous !== id) {
          const trigger = layerTriggers.get(previous);
          if (canRestoreTo(trigger) && (!box || box.contains(trigger))) {
            doFocus(trigger);
            return;
          }
        }
      } else {
        openId = id;
      }
      if (!inside) focusFirst(box);
    }

    // Tab / Shift+Tab：首尾绕回，别让焦点跑到背景；中间不动（原生顺序最好）。
    function onKeyDown(event) {
      if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
      const index = topIndex();
      if (index < 0) return;
      const box = boxAt(index);
      const list = tabbablesIn(box, view);
      if (!list.length) {
        // 弹层里一个可聚焦元素都没有：别让 Tab 把焦点带到背景去
        event.preventDefault();
        return;
      }
      const pos = list.indexOf(doc.activeElement);
      if (pos < 0) {
        event.preventDefault();
        const target = tabTarget(-1, list.length, Boolean(event.shiftKey));
        doFocus(list[target]);
        return;
      }
      const wrap = event.shiftKey ? pos === 0 : pos === list.length - 1;
      if (!wrap) return;
      event.preventDefault();
      doFocus(list[tabTarget(pos, list.length, Boolean(event.shiftKey))]);
    }

    // 背景里上一次拿到焦点的元素：弹层打开时它就是「打开前那个元素」。
    // 只做记录、**不抢焦点**：弹层里的业务代码有时要把焦点主动交给编辑区（「替换这一处」
    // 依赖编辑区真的拿到焦点，document.execCommand('insertText') 才生效），
    // 焦点管理只在用户按 Tab 这一条路上兜住，别的程序化焦点一律不动。
    function onFocusIn(event) {
      const index = topIndex();
      const target = event.target;
      if (index >= 0) {
        const box = boxAt(index);
        if (target && box && box.contains(target)) return;
        return; // 弹层开着时去背景（代码主动 / 读屏）：不拦
      }
      if (target && target !== doc.body && target !== doc.documentElement) outsideFocus = target;
    }

    doc.addEventListener('keydown', onKeyDown, true);
    doc.addEventListener('focusin', onFocusIn, true);
    let observer = null;
    if (typeof view.MutationObserver === 'function') {
      observer = new view.MutationObserver(() => sync());
      for (const el of backdrops) observer.observe(el, { attributes: true, attributeFilter: ['class'] });
    }
    sync();

    installed = {
      document: doc,
      backdrops,
      sync,
      destroy() {
        doc.removeEventListener('keydown', onKeyDown, true);
        doc.removeEventListener('focusin', onFocusIn, true);
        if (observer) observer.disconnect();
        installed = null;
      }
    };
    return installed;
  }

  return {
    FOCUSABLE_SELECTOR,
    pickTopIndex,
    tabTarget,
    shouldRestoreFocus,
    tabbablesIn,
    install
  };
});
