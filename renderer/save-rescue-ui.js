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
 *     选择「放弃我的修改并重载」且重载成功后才丢弃本地修改）；其余一律只读。
 *   - 正文 / 名额都不在这里拼：正文取 editorEl.value，文件名取 host.chapterTitle，主进程再清洗。
 *   - 写盘只有两条既有通道：saveCurrent（覆盖保存）与 api.rescueChapterText（另存 / 复制）。
 *
 * 浏览器里挂成全局 CWSaveRescueUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../core/assert-host').assertHost, require('./long-op-logic'));
  } else if (root) {
    root.CWSaveRescueUi = factory(root.CWAssertHost && root.CWAssertHost.assertHost, root.CWLongOpLogic);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (assertHost, longOpLogic) {
  'use strict';
  // REDT-B-04：书路径比较只用 long-op-logic 的同一份口径（Windows 大小写不敏感），
  // 不再和 long-op-logic / undo-action 各写一套。
  const { sameBookPath } = longOpLogic;

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
  // WP1（E-N1，项 3=A）：META_CHANGED（正文已落盘、写 书目.json 前发现外部改了书目）也进救稿出口——
  // 那一章的字数 / 章序元数据没同步，至少要让作者能先把正文另存 / 复制走。
  // WP6（N2，项 3=A）：BAD_PATH 同样进救稿出口——别的窗口换了书架根之后，旧根里的书下一次保存会
  // 被 assertBookPath 拦成 BAD_PATH，正文留在编辑区，必须给「另存 / 复制」出口。
  // P1（三审）：TEXT_TOO_LARGE（单章超过 500 万字保存上限）也进救稿出口——老版本 raw 导入的书
  // 「能打开、Ctrl+S 永远被拒」，没有这一条就没有任何应用内出口（只能手抄）。救稿走
  // chapter:rescue，上限与「能打开」同口径，不受保存上限约束；正文留在编辑区，本函数不动它。
  const RESCUE_CODES = ['BOOK_MISSING', 'CHAPTER_MISSING', 'META_CHANGED', 'BAD_PATH', 'TEXT_TOO_LARGE'];
  const EXTERNAL_CHANGE = 'EXTERNAL_CHANGE';
  const CONFLICT_TITLE = '这一章在应用外被改过';
  const RESCUE_TITLE = '保存被阻止：这些字还没落盘';
  const META_CHANGED_TITLE = '保存被阻止：书目在应用外被改过';
  const BAD_PATH_HINT = '书架目录可能已被更换（这本书在旧目录里），或这个章节路径被主进程拒绝。';

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
    // WP1（E-N1）：META_CHANGED 走同一组出口，但说明不同（正文已落盘、书目没同步）。
    // WP6（N2）：BAD_PATH 也走同一组出口，并点明最常见的两种原因（书架根被换 / 章节路径被拒）。
    // 走完这里编辑区与 dirty 一个字节都不动：救稿只是「另外存一份」，书库仍然是被阻断的状态。
    // REDT-B-06：没有 silent 形参 —— handleSaveFailure 在 195 行对 silent 提前 return，
    // 本函数永远只在「非静默」路径被调用（以前带着一个恒真的 `if (!silent)`）。
    async function rescueBlockedSave({ message, code }) {
      const metaChanged = code === 'META_CHANGED';
      const badPath = code === 'BAD_PATH';
      // P1（三审）：超长章的说明与「文件没了」不同 —— 正文和书都还在，只是这一章写不进书库。
      const tooLarge = code === 'TEXT_TOO_LARGE';
      const res = await openModal({
        title: metaChanged ? META_CHANGED_TITLE : RESCUE_TITLE,
        message: metaChanged
          ? `${message}\n\n正文已写入磁盘，但这一章的字数 / 章序等书目信息没有同步（书目保持外部那一版）。` +
            '先另存成 txt 或复制正文，再从书架重开这本书就不会丢。'
          : badPath
            ? `${message}\n\n${BAD_PATH_HINT}\n\n正文还在编辑区里（未保存）。先另存成 txt 或复制正文，` +
              '再从书架重新打开这本书就不会丢。'
            : tooLarge
              ? `${message}\n\n这一章超过了单章保存上限，Ctrl+S 暂时写不进书库（编辑 / 复制都不受影响）。` +
                '先另存成 txt 或复制正文把这一版救出来，再把内容分成几章粘回去（或回源文件拆章后重新导入）。'
              : `${message}\n\n正文还在编辑区里（未保存）。先另存成 txt 或复制正文，` +
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
        // 救稿本身失败不能把作者晾在原地：明确说一声（走到这里是可交互路径，静默保存已被上游拦掉）
        toast(`救稿出口失败：${(err && err.message) || String(err)}`, 'error');
      }
    }

    // V301：主进程比对 expectedMtimeMs 不符 → 覆盖 / 先另存一份 / 放弃我的修改并重载。
    // 覆盖保存要重新进 saveCurrent，先把 state.saving 解除，否则会被「正在保存」挡回（BUSY）。
    async function resolveExternalChange({ message, silent, conflictBookPath, conflictChapterId }) {
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
        // E-N3：先重载成功、后清脏。作者明确选择了丢弃本地修改，但「脏」必须等磁盘那一版真的进了
        // 编辑区才清 —— 重载失败 / 冲突章已不在书目 / 已经换了书时保留 dirty，关窗仍会提示，
        // 不出现「正文在编辑区、脏标记已清」的丢稿窗口。
        // 目标按冲突章 id 找，不用 live state.index：对话框开着的这段时间，索引可能已经被切章推着走。
        const targetId = conflictChapterId || state.loadedChapterId;
        const chapters = Array.isArray(state.chapters) ? state.chapters : [];
        const targetIndex = chapters.findIndex((chapter) => chapter && chapter.id === targetId);
        const sameBook = !conflictBookPath || sameBookPath(conflictBookPath, state.bookPath);
        if (!sameBook) {
          state.dirty = true;
          toast('已经换了书，未重载；正文仍未保存，可先另存一份', 'warn');
          return null;
        }
        if (targetIndex < 0) {
          state.dirty = true;
          toast('冲突章已不在书目，未重载；正文仍未保存，可先另存一份', 'warn');
          return null;
        }
        // loadChapterAt 成功路径会自己重建基线 / mtime 并清脏，这里再兜一次防 host 实现漂移；
        // 失败（{ok:false}）不预清脏，内容还在编辑区，关窗必须照旧提示。
        const result = await loadChapterAt(targetIndex);
        if (result && result.ok) {
          state.dirty = false;
          // A2-SAVE-01（2026-11-26 审计）：作者已经明确「放弃我的修改并重载」，磁盘那一版也真的
          // 进了编辑区 —— 这次保存已经被处理完（不是失败）。以前这里 return null，上游
          // handleSaveFailure 把它包成 ok:false，saveForTransition 见 ok:false 直接中止，
          // 作者刚选完重载，原本要做的动作（删章 / 切章 / 关窗…）却静默不执行。
          // 回一个 ok:true 的「已按作者选择处理」回执：上游继续过渡，但带 discarded/reloaded
          // 让调用方能区分「写盘成功」与「本地修改已丢弃、磁盘版已重载」。
          return { ok: true, discarded: true, reloaded: true };
        }
        state.dirty = true;
        toast('重载失败，正文仍未保存；可先另存一份或重试', 'warn');
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
        // 冲突章身份（书 + 章 id）在 saveCurrent 发起保存时就拍好了，原样透传给重载分支（E-N3）
        const result = await resolveExternalChange({
          message,
          silent,
          conflictBookPath: options.conflictBookPath,
          conflictChapterId: options.conflictChapterId
        });
        // 覆盖保存有回执（成功或再次失败）：原样上抛，别把它盖成一条笼统的失败
        if (result && typeof result === 'object' && 'ok' in result) return result;
        return { ok: false, code, message };
      }
      if (plan === 'rescue') {
        // code 一起透传：META_CHANGED 的说明是「正文已落盘、书目没同步」，与书 / 章文件没了不同。
        await rescueBlockedSave({ message, code });
        return { ok: false, code, message };
      }
      return null;
    }

    return {
      handleSaveFailure,
      rescuePlanFor,
      // WP6（N2）：换根提示里的「复制正文 / 另存这一章为 txt…」复用同一份实现（不复制一套 IPC）。
      rescueCopy
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