/* 换书架根目录后的跨窗口提示（WP6 / 审计 N2，中 #7）。
 *
 * 为什么单独一个模块：换根通知要同时碰「本窗口配置刷新 / 书架刷新 / 找孤岛书 / 弹一次性提示 /
 * 复用救稿出口 / 回书架」，塞回 6400 行的 renderer.js 既撑不下行预算，也没法用假 host 在 Node 里
 * 逐条钉住「点哪个按钮会发生什么」。纯判定（路径包含 / 是否孤岛 / 一次性去重）与提示编排都在这里。
 *
 * 场景：多窗口 A 在设置里换了书架根目录 → main.js 的 config:set 广播 config:changed。
 * 渲染层用当前生效的 booksRoot 判「这本书还在不在书架里」：
 *   · 停在书架：刷新成新目录的书架（最近书 / 字数跟着刷新，收编 O6 簇）；
 *   · 开着旧根的书（孤岛）：一次性提示「留在这里 / 复制正文 / 另存这一章为 txt… / 回书架」；
 *     之后真的去保存时主进程的 assertBookPath 会回 BAD_PATH —— save-rescue-ui 的 RESCUE_CODES
 *     已含 BAD_PATH，同一组救稿出口兜底；
 *   · 书在新根下：只 toast 一句「保存照常」，不打断作者。
 *
 * 契约：createConfigChangeUi(host)，host 成员见 REQUIRED_HOST；缺一个在装配时直接 TypeError。
 *   - 只读 state：不写 state 的任何字段（dirty / 当前书身份都由作者在对话框里的选择驱动既有入口）。
 *   - 不直接碰 IPC：救稿走 save-rescue-ui 的 rescueCopy，回书架走既有 backToShelf。
 * 浏览器里挂成全局 CWConfigChangeUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./assert-host').assertHost);
  } else if (root) {
    root.CWConfigChangeUi = factory(root.CWAssertHost && root.CWAssertHost.assertHost);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (assertHost) {
  'use strict';

  const REQUIRED_HOST = ['state', 'openModal', 'toast', 'rescueCopy', 'goBackToShelf', 'refreshShelf', 'refreshConfig'];

  const NOTICE_TITLE = '书架目录已更换';

  // 路径归一化只用于「在不在这个根下」的判定：trim、正反斜杠统一、小写、去掉 /. 段与末尾分隔符。
  // 与 main.js 的 booksRootChanged / core/ipc-paths 的大小写口径一致（Windows 不敏感）；不 realpath
  // （符号链接 / 目录联接仍是 README 记录的已知限制）。
  function normalizeRootPath(value) {
    if (typeof value !== 'string') return '';
    let text = value.trim().replace(/\\/g, '/').toLowerCase();
    text = text.replace(/\/\.(?=\/|$)/g, '');
    text = text.replace(/\/{2,}/g, '/');
    text = text.replace(/\/+$/, '');
    return text;
  }

  // 书路径是否在当前（新）书架根下。相对路径、含 .. 段、空值一律算「不在根下」——
  // 宁可多提示一次，也不要让孤岛书静默留在旧根里继续失败。
  function isInsideRoot(bookPath, booksRoot) {
    if (typeof bookPath !== 'string' || typeof booksRoot !== 'string') return false;
    const root = normalizeRootPath(booksRoot);
    const book = normalizeRootPath(bookPath);
    if (!root || !book) return false;
    if (book.split('/').includes('..')) return false;
    if (book === root) return true;
    return book.startsWith(`${root}/`);
  }

  // 「孤岛」= 非书架视图 + 当前有书 + 这本书不在新根下。阅读模式也算（编辑区仍占着旧根正文）。
  function strandedBook(state, booksRoot) {
    if (!state || typeof state !== 'object') return false;
    if (state.view === 'shelf') return false;
    const bookPath = typeof state.bookPath === 'string' ? state.bookPath : '';
    if (!bookPath.trim()) return false;
    return !isInsideRoot(bookPath, booksRoot);
  }

  function messageFor(booksRoot) {
    return `另一个窗口把书架目录改成了「${booksRoot}」。\n\n这本书还在旧目录里，应用不会再往旧目录保存（现在保存会被阻止）。\n` +
      '正文还在编辑区里（未保存）：先另存成本地 txt 或复制正文，再回书架；要接着写这本书，把书文件夹移到新的书架目录后重新打开即可。';
  }

  function createConfigChangeUi(host) {
    // 缺成员当场 TypeError（与其它渲染层模块同一套共享实现 / 文案）。
    assertHost('createConfigChangeUi', host, REQUIRED_HOST);
    const { state, openModal, toast, rescueCopy, goBackToShelf, refreshShelf, refreshConfig } = host;

    // 「一次性」按根去重：同一个根（含大小写 / 斜杠 / 末尾分隔符的不同写法）只处理一次；
    // 真的又换了一个根才重新提示。放在闭包里 = 每个窗口各自一份，不写 state（不新增界面状态）。
    let noticedRoot = '';

    async function noticeStranded(booksRoot) {
      const res = await openModal({
        title: NOTICE_TITLE,
        message: messageFor(booksRoot),
        buttons: [
          { label: '留在这里', value: 'stay' },
          { label: '复制正文', value: 'copy' },
          { label: '回书架', value: 'shelf' },
          // 主操作固定最右（.modal-buttons 右对齐 + 数组顺序，见 renderer.js promptText / askUnsaved）。
          { label: '另存这一章为 txt…', value: 'save', kind: 'primary' }
        ],
        cancelValue: 'stay'
      });
      const action = (res && res.action) || 'stay';
      if (action === 'copy' || action === 'save') {
        // 救稿复用 save-rescue-ui 的同一份实现（正文取编辑区现值、写盘走 chapter:rescue）；
        // 失败要说清（不能把「没另存成功」装成成功）。
        try {
          await rescueCopy(action);
        } catch (err) {
          toast(`救稿出口失败：${(err && err.message) || String(err)}`, 'error');
        }
        return action;
      }
      if (action === 'shelf') {
        // 回书架交给既有 backToShelf：有未保存修改时它自己会先问（保存失败也会走同一条救稿出口）。
        try {
          await goBackToShelf();
        } catch (err) {
          toast(`返回书架失败：${(err && err.message) || String(err)}`, 'error');
        }
        return action;
      }
      toast('这本书还在旧书架目录里：现在保存会被阻止，先另存正文再回书架', 'warn');
      return 'stay';
    }

    async function handleConfigChanged(payload) {
      const box = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
      const reason = box ? box.reason : '';
      const booksRoot = box && typeof box.booksRoot === 'string' ? box.booksRoot.trim() : '';
      if (reason !== 'booksRoot' || !booksRoot) return { handled: false, reason: 'ignored' };
      const rootKey = normalizeRootPath(booksRoot);
      if (!rootKey) return { handled: false, reason: 'ignored' };
      if (rootKey === noticedRoot) return { handled: false, reason: 'duplicate' };
      noticedRoot = rootKey;

      // 先把本窗口的全局配置换成新值（设置面板 / 显示回填要用）；取不到也要把「书在哪」的提示给出去。
      try {
        await refreshConfig();
      } catch {
        /* 提示才是保命路径：配置刷新失败不阻断 */
      }

      if (state.view === 'shelf') {
        try {
          await refreshShelf();
          toast('书架目录已更换，已切到新目录的书架');
        } catch (err) {
          toast(`书架目录已更换，但刷新书架失败：${(err && err.message) || String(err)}`, 'error');
        }
        return { handled: true, prompted: false, view: 'shelf' };
      }

      if (!strandedBook(state, booksRoot)) {
        // 书还在新根下（或当前没有书）：保存照常，只轻提示一次。
        toast('书架目录已更换；这本书仍在新目录下，保存照常');
        return { handled: true, prompted: false, view: state.view };
      }

      const action = await noticeStranded(booksRoot);
      return { handled: true, prompted: true, action };
    }

    return { handleConfigChanged };
  }

  return {
    create: createConfigChangeUi,
    REQUIRED_HOST,
    NOTICE_TITLE,
    normalizeRootPath,
    isInsideRoot,
    strandedBook
  };
});