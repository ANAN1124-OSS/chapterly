/* 保存失败的两个「救稿出口」（v1.8.0 审计修复 #5 V301 / #6 V302）。
 *
 * 为什么单独一个模块：这两条链路都只在「保存被拦下」时才跑，却需要同时碰对话框、状态栏、
 * 剪贴板 / 另存 IPC 与保存重试；塞回 renderer.js 会让 6256 行的装配文件继续膨胀，也没法用
 * 假 host 在 Node 里逐条钉住「点哪个按钮会发生什么」。
 *
 *   · V301（#5）「这一章在应用外被改过」：chapter:save 带 expectedMtimeMs，主进程比对不符时抛
 *     EXTERNAL_CHANGE。这里问作者三件事——取消 / 放弃我的修改并从磁盘重载 / 仍然覆盖保存；
 *     外加「先另存一份」把编辑区这一版落成 txt（不碰书库）。
 *   · V302（#6）「保存被阻止：这些字还没落盘」：书 / 章节文件在应用外被删 / 移走时保存返回
 *     BOOK_MISSING / CHAPTER_MISSING。这里给同一套救稿出口：另存这一章为 txt… / 复制正文 / 留在这里。
 *
 * 契约：createSaveRescueUi(host)，host 成员见 REQUIRED_HOST；缺一个在装配时直接 TypeError。
 *   - state 只写两个字段：state.saving（覆盖重试前解除「正在保存」）与 state.dirty（作者明确
 *     选择「放弃我的修改并重载」时先丢弃本地修改）；其余一律只读。
 *   - 正文 / 名额都不在这里拼：正文取 editorEl.value，文件名取 host.chapterTitle，主进程再清洗。
 *   - 写盘只有两条既有通道：saveCurrent（覆盖保存）与 api.rescueChapterText（另存 / 复制）。
 *
 * 浏览器里挂成全局 CWSaveRescueUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./assert-host').assertHost);
  } else if (root) {
    root.CWSaveRescueUi = factory(root.CWAssertHost && root.CWAssertHost.assertHost);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (assertHost) {
  'use strict';

  const REQUIRED_HOST = [
    'state',
    'api',
    'call',
    'openModal',
    'toast',
    'editorEl',
    'saveCurrent',
    'loadChapterAt',
    'chapterTitle'
  ];

  // 两个错误码的口径（审计原文）：书 / 章文件在应用外没了 → BOOK_MISSING / CHAPTER_MISSING；
  // 载入之后磁盘上那一章被改过 → EXTERNAL_CHANGE。其余失败照旧走状态栏 + toast，不进这里。
  const RESCUE_CODES = ['BOOK_MISSING', 'CHAPTER_MISSING'];
  const EXTERNAL_CHANGE = 'EXTERNAL_CHANGE';
  const CONFLICT_TITLE = '这一章在应用外被改过';
  const RESCUE_TITLE = '保存被阻止：这些字还没落盘';

  // 纯判定（单测直接钉）：哪个错误码需要哪个出口；其余返回空串，不进救稿链路。
  function rescuePlanFor(code) {
    if (code === EXTERNAL_CHANGE) return 'conflict';
    if (RESCUE_CODES.indexOf(code) >= 0) return 'rescue';
    return '';
  }

  function createSaveRescueUi(host) {
    // A8（WP-32）：host 逐成员校验走共享实现（缺成员当场 TypeError，文案不变）
    assertHost('createSaveRescueUi', host, REQUIRED_HOST);
    const { state, api, call, openModal, toast, editorEl, saveCurrent, loadChapterAt, chapterTitle } = host;

    // 「另存这一章为 txt」的建议文件名：章号 + 章名（主进程再走 chaptersLib.safeName 去非法字符）
    function suggestedFileName() {
      const chapters = Array.isArray(state.chapters) ? state.chapters : [];
      const chapter = state.index >= 0 ? chapters[state.index] : null;
      if (!chapter) return '未保存的这一章';
      return chapterTitle(state.index, chapter.name);
    }

    // 救稿的两个动作共用一条 IPC：正文从编辑区现取（书 / 章目标可能已经不在了，这正是被阻断的原因），
    // 主进程只负责「弹保存对话框 + 原子写」或「写进系统剪贴板」，不读书库。
    async function rescueCopy(mode) {
      const data = await call(api.rescueChapterText, editorEl.value, mode, suggestedFileName());
      if (!data) return null;
      if (mode === 'copy') {
        if (data.copied) toast(`已复制正文（${data.chars} 字）`);
        return data;
      }
      if (!data.canceled) toast(`已另存：${data.filePath}`);
      return data;
    }

    // V302：保存被 BOOK_MISSING / CHAPTER_MISSING 阻断 → 三个出口（留在这里 / 复制正文 / 另存 txt）。
    // 走完这里编辑区与 dirty 一个字节都不动：救稿只是「另外存一份」，书库仍然是被阻断的状态。
    async function rescueBlockedSave({ message, silent }) {
      const res = await openModal({
        title: RESCUE_TITLE,
        message:
          `${message}\n\n正文还在编辑区里（未保存）。先另存成 txt 或复制正文，` +
          '就不会因为书 / 章文件没了而丢。',
        buttons: [
          { label: '留在这里', value: 'stay' },
          { label: '复制正文', value: 'copy' },
          { label: '另存这一章为 txt…', value: 'save', kind: 'primary' }
        ],
        cancelValue: 'stay'
      });
      const action = (res && res.action) || 'stay';
      if (action !== 'save' && action !== 'copy') return;
      try {
        await rescueCopy(action === 'copy' ? 'copy' : 'save');
      } catch (err) {
        // 救稿本身失败不能把作者晾在原地：明确说一声（silent 保存不打扰，但仍写回状态栏）
        if (!silent) toast(`救稿出口失败：${(err && err.message) || String(err)}`, 'error');
      }
    }

    // V301：主进程比对 expectedMtimeMs 不符 → 覆盖 / 先另存一份 / 放弃我的修改并重载。
    // 覆盖保存要重新进 saveCurrent，先把 state.saving 解除，否则会被「正在保存」挡回（BUSY）。
    async function resolveExternalChange({ message, silent }) {
      const res = await openModal({
        title: CONFLICT_TITLE,
        message: `${message}\n\n直接保存会盖掉磁盘上那一版正文。`,
        buttons: [
          { label: '取消', value: 'cancel' },
          { label: '放弃我的修改并重载', value: 'reload' },
          { label: '仍然覆盖保存', value: 'overwrite', kind: 'danger' },
          { label: '先另存一份', value: 'save-copy', kind: 'primary' }
        ],
        cancelValue: 'cancel'
      });
      const action = (res && res.action) || 'cancel';
      if (action === 'overwrite') {
        state.saving = false;
        return saveCurrent({ silent, force: true });
      }
      if (action === 'save-copy') {
        try {
          await rescueCopy('save');
        } catch (err) {
          if (!silent) toast(`另存失败：${(err && err.message) || String(err)}`, 'error');
        }
        return null;
      }
      if (action === 'reload') {
        // 作者明确选择丢弃本地修改：先清掉脏标记再按磁盘重载（loadChapterAt 会重建基线与 mtime）
        state.dirty = false;
        await loadChapterAt(state.index);
        return null;
      }
      return null;
    }

    // 保存失败的统一入口（renderer.saveCurrent 的 catch 在写状态栏之前调用）：
    // 返回 null = 不归本模块管，照旧走状态栏 + toast；返回对象 = 已处理，调用方原样上抛。
    async function handleSaveFailure(err, options = {}) {
      const silent = options.silent === true;
      const code = err && err.code;
      const message = (err && err.message) || '保存失败';
      const plan = rescuePlanFor(code);
      if (!plan) return null;
      // 静默保存（关窗 / 强制退出的最后一趟）不许弹模态框：调用方可能正在等它返回，
      // 而窗口可能 500ms 后就被销毁 —— 那时候没人能点这个对话框。照旧回失败结果，状态栏也照旧记。
      if (silent) return null;
      if (plan === 'conflict') {
        const result = await resolveExternalChange({ message, silent });
        // 覆盖保存有回执（成功或再次失败）：原样上抛，别把它盖成一条笼统的失败
        if (result && typeof result === 'object' && 'ok' in result) return result;
        return { ok: false, code, message };
      }
      if (plan === 'rescue') {
        await rescueBlockedSave({ message, silent });
        return { ok: false, code, message };
      }
      return null;
    }

    return {
      handleSaveFailure,
      rescuePlanFor
    };
  }

  return {
    create: createSaveRescueUi,
    REQUIRED_HOST,
    rescuePlanFor,
    RESCUE_CODES,
    EXTERNAL_CHANGE
  };
});