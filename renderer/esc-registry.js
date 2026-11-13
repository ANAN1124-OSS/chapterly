/* 全局 Esc 链与关窗清理的**有序注册表**（v0.9 B-4 / 外部审计 F6）——纯逻辑，不碰 DOM、不读盘。
 *
 * 改之前 renderer.js 的 document keydown 里有 12 段近乎逐字重复的块，形状都是：
 *   if (!$('xxx-backdrop').classList.contains('hidden')) {
 *     if (event.key === 'Escape') { event.preventDefault(); closeXxx(); }
 *     return;
 *   }
 * 关窗清理（handleCloseRequest）另有一份手写清单，只覆盖其中 5 个弹层。
 * 12 段各写一遍的代价不是行数，而是**优先级只存在于「谁写在上面」**：加一层要数 12 个位置，
 * 删一层容易漏，改顺序要通读整段，而且没有任何测试能钉住「谁先接 Esc」。
 *
 * 现在把这两件事收在这一张表里：
 *   · LAYERS：Esc 链的**有序**层定义，数组顺序就是优先级；
 *   · CLEANUP：关窗清理的**有序**动作清单（7 项，与 Esc 的全量层不同，见下面的注释）。
 * 渲染层只保留「动作 id → 真正的关闭函数」那张表与 DOM 副作用（renderer.js 的 escProbe / escActions），
 * 这里只产出动作 id，所以整张表都能被单测直接钉住（tests/esc-registry.test.js）。
 *
 * 两个必须保住的口径（改结构时最容易丢）：
 *   1. **锁键**：通用询问框与它下面那 7 个弹层（冲突 / 书籍信息 / 历史 / 排版 / 导出 / 设置 / 跳章），
 *      再加上命令面板（1.4.0）与快捷键一览（1.5.0 功能-4）开着时，**所有按键**都在这一层被接走
 *      （改前每段末尾那个裸 return）——例如弹层开着按 Ctrl+S 不保存、按 F11 不进专注模式。
 *      后面那些弹层（灵感箱 / 插入碎片 / 校对 / 敏感词）只接 Esc，别的键继续往下走。
 *   2. **关窗清理是子集**：只收顶栏菜单 + 排版 + 导出 / 跳章 / 冲突 / 历史 / 设置。
 *      书籍信息（书架）、查找 / 灵感箱 / 插入碎片 / 校对 / 敏感词（都不阻塞关窗询问）故意不收，
 *      这是改前就有的口径，不要趁机扩大。
 *
 * 边界：只决定「谁接 Esc / 谁关」，**不执行**关闭；preventDefault 与否也作为数据带回去（兜底层不 preventDefault）。
 * 为什么单独一个文件：renderer.js 有 9600 行闸门；优先级这种东西必须能被单测钉住。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (root) root.CWEscRegistry = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 探针（probe）：渲染层每次按键现算的一份「现在谁开着」快照，这里只读不写。字段含义：
  //   modal              通用询问框开着（它可能在别的弹层之上，z-index 300）
  //   modalInput         询问框带输入框（只有这种才把 Enter 当「确定」）
  //   conflict / bookinfo / history / historyPreview / format / export / settings / jump / find / command
  //   （command = 命令面板开着，1.4.0 P0-3；它是锁键层，和设置那批一个口径）
  //                      对应弹层可见；historyPreview 是历史面板里那格预览（弹层里的弹层）
  //   formatCard / displayMenu  顶栏「整理」卡 / 「显示」菜单展开
  //   findTotal          当前查找会话的高亮处数（查找面板关着时 Esc 先清高亮）
  //   fragment / fragments / proofread / sensitive  灵感箱 / 插入碎片 / 校对 / 敏感词
  //   tts / reading / focus  朗读条开着 / 阅读模式 / 专注模式
  //   undoBar            左下角撤销条可见（1.5.0 P0-4：最低优先级的一层，只接 Esc）
  //   chapterSelection   章节列表有多选（1.5.0 功能-1：只接 Esc，排在撤销条之后）
  //   shortcuts          快捷键一览页开着（1.5.0 功能-4：锁键层，和命令面板同一口径）
  //   contextMenu        右键菜单开着（比撤销条更「在上面」：Esc 先收菜单）
  //
  // 层的两种形态：
  //   lock: true → 开着时吞掉所有按键；keys 里登记的键（可带 when 条件）先做动作
  //   否则       → 只接 Esc（esc 字段是动作 id），别的键一律放行给渲染层的快捷键
  const LAYERS = [
    // ① 通用询问框最优先：排版 / 设置弹层开着时弹出的关窗询问不能被弹层压住
    {
      id: 'modal',
      lock: true,
      open: (p) => Boolean(p.modal),
      keys: {
        Escape: { action: 'modal-cancel' },
        Enter: { action: 'modal-confirm', when: (p) => Boolean(p.modalInput) }
      }
    },
    // ② 弹层（锁键）：顺序 = 改前那 7 段 if 的书写顺序，别再靠「谁写在上面」记
    { id: 'conflict', lock: true, open: (p) => Boolean(p.conflict), keys: { Escape: { action: 'close-conflict' } } },
    { id: 'bookinfo', lock: true, open: (p) => Boolean(p.bookinfo), keys: { Escape: { action: 'close-bookinfo' } } },
    // 1.6.0 F5：书架「分组管理」弹层（改名 / 合并）与书籍信息同一个口径（锁键 + Esc 收起）。
    // 探针字段由 renderer 的 ESC_BACKDROPS 列表按 `${name}-backdrop` 现算（'group-manage'）。
    {
      id: 'group-manage',
      lock: true,
      open: (p) => Boolean(p['group-manage']),
      keys: { Escape: { action: 'close-group-manage' } }
    },
    // 历史面板的预览格是「弹层里的弹层」：Esc 先收预览，再按一次才关面板
    {
      id: 'history-preview',
      lock: true,
      open: (p) => Boolean(p.history) && Boolean(p.historyPreview),
      keys: { Escape: { action: 'close-history-preview' } }
    },
    { id: 'history', lock: true, open: (p) => Boolean(p.history), keys: { Escape: { action: 'close-history' } } },
    { id: 'format', lock: true, open: (p) => Boolean(p.format), keys: { Escape: { action: 'close-format' } } },
    { id: 'export', lock: true, open: (p) => Boolean(p.export), keys: { Escape: { action: 'close-export' } } },
    { id: 'settings', lock: true, open: (p) => Boolean(p.settings), keys: { Escape: { action: 'close-settings' } } },
    { id: 'jump', lock: true, open: (p) => Boolean(p.jump), keys: { Escape: { action: 'close-jump' } } },
    // ②b 命令面板（1.4.0 P0-3）：和上面那批一个口径 —— 锁键（面板开着时别的快捷键不响），Esc 收起。
    //     ↑↓ / Home / End / Enter 由面板自己的输入框接（它能拿到焦点，元素级监听在
    //     renderer/command-palette-ui.js 里），不在这张表的 keys 里重复一遍。
    { id: 'command', lock: true, open: (p) => Boolean(p.command), keys: { Escape: { action: 'close-command' } } },
    // ②c 快捷键一览（1.5.0 功能-4）：写作页按 ? 打开，同样是锁键层（面板开着时别的快捷键不响），Esc 收起。
    //     排在命令面板之后、查找面板之前：它只在没有任何弹层开着时才会被打开，顺序在这里只是兜底。
    { id: 'shortcuts', lock: true, open: (p) => Boolean(p.shortcuts), keys: { Escape: { action: 'close-shortcuts' } } },
    // ③ 查找面板：只接 Esc；「回车 = 查找 / 下一处」是面板自己的事，留在渲染层
    { id: 'find', open: (p) => Boolean(p.find), esc: 'close-find' },
    // ④ 顶栏「整理」卡 / 「显示」菜单：Esc 先收起它们，并把焦点还给按钮
    //    （焦点已经在菜单里时由 renderer/menu-keyboard.js 的元素级监听接走，那条路不经过这里）
    { id: 'menus', open: (p) => Boolean(p.formatCard) || Boolean(p.displayMenu), esc: 'close-header-menus' },
    // ⑤ 查找高亮：面板关着时 Esc 先清高亮，再按才轮到朗读 / 阅读 / 专注
    { id: 'find-highlight', open: (p) => !p.find && Number(p.findTotal) > 0, esc: 'clear-find-session' },
    // ⑥ 不锁键的弹层：Esc 关，其它键继续往下走（Ctrl+S 仍可保存）
    { id: 'fragment', open: (p) => Boolean(p.fragment), esc: 'close-fragment' },
    { id: 'fragments', open: (p) => Boolean(p.fragments), esc: 'close-insert-fragment' },
    // 剪贴板捕获（P0）：插入碎片之后、校对之前（与 WIP 里那段 Esc 判断的位置一致）；
    // 提交中不关面板由渲染层的动作实现决定（这里只负责「Esc 命中哪一层」）。
    { id: 'capture', open: (p) => Boolean(p.capture), esc: 'close-capture' },
    { id: 'proofread', open: (p) => Boolean(p.proofread), esc: 'close-proofread' },
    { id: 'sensitive', open: (p) => Boolean(p.sensitive), esc: 'close-sensitive' },
    // ⑦ 朗读条（不是弹层，排在所有弹层之后，不抢弹层的 Esc）
    { id: 'tts', open: (p) => Boolean(p.tts), esc: 'close-tts' },
    // ⑧ 阅读模式：Esc 退出，回到写作页（排在所有弹层 / 朗读之后）
    { id: 'reading', open: (p) => p.reading === true, esc: 'exit-reading' },
    // ⑨ 专注模式：Esc 退出（F11 是另一条键，不属于 Esc 链）
    { id: 'focus', open: (p) => Boolean(p.focus), esc: 'exit-focus' },
    // ⑨b 撤销条（1.5.0 P0-4 / H-5）：**最低优先级**，排在所有弹层 / 面板 / 模式之后、兜底之前。
    //     它不是弹层、不锁键（别的键照常走快捷键）；只接 Esc。弹层开着时 Esc 仍先关弹层，
    //     所以「只在没有任何弹层开着时生效」是层序给的结果，不需要往锁层里加东西。
    //     右键菜单开着时让给兜底层（先收菜单、条子留着），下一按 Esc 才收条子 —— 菜单比条子更「在上面」。
    { id: 'undo-bar', open: (p) => Boolean(p.undoBar) && !p.contextMenu, esc: 'close-undo-bar' },
    // ⑨c 章节多选（1.5.0 功能-1）：点空白会清空，Esc 在没有弹层 / 菜单时也清空。
    //     排在撤销条之后、兜底之前：右键菜单开着时第一下 Esc 先收菜单（让给兜底层），下一按才清多选；
//     弹层开着时 Esc 仍先关弹层，多选不受影响。
    {
      id: 'chapter-selection',
      open: (p) => Boolean(p.chapterSelection) && !p.contextMenu,
      esc: 'clear-chapter-selection'
    },
    // ⑩ 兜底：右键菜单 / 顶栏菜单收起。**不 preventDefault**（改前最后那个 else if 就是这么写的）
    { id: 'fallback', open: () => true, esc: 'hide-menus', preventDefault: false }
  ];

  // 关窗清理：**有序**、**7 项**。
  // · 前两项无条件执行（hideHeaderMenus 本来就是无条件；closeFormatDialog 自己可重入，改前也是无条件调用）；
  // · 后面 5 项只在弹层开着时收，顺序 = 改前手写清单的顺序。
  // 不在表里的弹层（书籍信息 / 查找 / 灵感箱 / 插入碎片 / 校对 / 敏感词）**故意不收**：改前就不收。
  const CLEANUP = [
    { id: 'menus', always: true, action: 'hide-header-menus' },
    { id: 'format', always: true, action: 'close-format' },
    { id: 'export', probe: 'export', action: 'close-export' },
    { id: 'jump', probe: 'jump', action: 'close-jump' },
    { id: 'conflict', probe: 'conflict', action: 'close-conflict' },
    { id: 'history', probe: 'history', action: 'close-history' },
    { id: 'settings', probe: 'settings', action: 'close-settings' }
  ];

  const toProbe = (probe) => (probe && typeof probe === 'object' ? probe : {});

  // 一次按键的裁决。返回 null = 这一层链路不管这个键（渲染层的快捷键继续往下走）。
  //   { layer, key, action, preventDefault, swallow }
  //   · lock 层：swallow = true —— action 为 null 时也要 return（改前每段末尾的裸 return）
  //   · 非 lock 层：只有 Esc 会命中，swallow = false（命中即 return，行为与改前一致）
  function resolve(probe, key) {
    const state = toProbe(probe);
    for (const layer of LAYERS) {
      if (!layer.open(state)) continue;
      if (layer.lock) {
        const spec = layer.keys && Object.prototype.hasOwnProperty.call(layer.keys, key) ? layer.keys[key] : null;
        if (spec && (!spec.when || spec.when(state))) {
          return { layer: layer.id, key, action: spec.action, preventDefault: true, swallow: true };
        }
        return { layer: layer.id, key, action: null, preventDefault: false, swallow: true };
      }
      if (key !== 'Escape' || !layer.esc) continue;
      return {
        layer: layer.id,
        key,
        action: layer.esc,
        preventDefault: layer.preventDefault !== false,
        swallow: false
      };
    }
    return null;
  }

  // 关窗时要跑的动作 id（有序）。只返回动作，不执行。
  function cleanupActions(probe) {
    const state = toProbe(probe);
    const actions = [];
    for (const entry of CLEANUP) {
      if (!entry.always && !state[entry.probe]) continue;
      actions.push(entry.action);
    }
    return actions;
  }

  // 1.6.0 A5/P-09：渲染层 keydown 只在「Esc 键 / 有锁键层」时现算探针。判定放在这里，
  // 免得把 event.key === 'Escape' 字面量再抄回 renderer.js（Esc 判断只许留在注册表这条闸门）。
  function isEscapeKey(key) {
    return key === 'Escape';
  }

  return { LAYERS, CLEANUP, resolve, cleanupActions, isEscapeKey };
});
