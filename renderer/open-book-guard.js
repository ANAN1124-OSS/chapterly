/* 换书守卫的**决策纯逻辑**（1.6.0 H1 / 审计 E-01：换书静默丢稿）——不碰 DOM、不碰 IPC。
 *
 * 问题：`openBookByPath()` 直接把编辑区换成另一本书的正文。当前章有未保存的修改时，
 * 那些字既没写盘、也没进撤销（撤销条不跨书），换过去就找不回来了。
 *
 * 模型：换书前先问一次「保存并继续 / 不保存，丢弃修改 / 取消」；作者选完再决定
 * 继续换书还是停在原地。渲染层负责弹窗与保存，本模块只回答「这一步该怎么办」：
 *
 *   decideOpenBook({ dirty })                       → { action: 'proceed' | 'prompt' }
 *   decideOpenBook({ dirty, choice, saveResult })   → { action: 'proceed' | 'abort' | 'prompt', reason, message? }
 *
 * 取值口径（拿不准时一律保守 —— 宁可多问一次，也不能悄悄把没保存的字换掉）：
 *   · dirty 只认严格的 true（渲染层的 state.dirty 本来就是布尔；'false' / 1 这类值不算脏）；
 *   · choice 只认 'save' / 'discard' / 'cancel'（askUnsaved 的三个返回值），其它一律回到 prompt；
 *   · 'save' 必须带 saveResult.ok === true 才继续；失败 / 没传结果都算失败（abort + 原样带出 message）。
 *
 * 为什么单独一个模块：这三种选择 × 保存成败是 5 条纯分支，塞进 renderer.js 只能靠 E2E 撞；
 * 这里在 Node 里逐条断言，渲染层只负责把弹窗结果递进来。浏览器里挂成全局 CWOpenBookGuard
 * （index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWOpenBookGuard = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 只认 askUnsaved / openModal 真正会返回的三个值；'SAVE'、空串、对象一律当「还没选」。
  function normalizeChoice(choice) {
    if (choice === 'save' || choice === 'discard' || choice === 'cancel') return choice;
    return null;
  }

  function decideOpenBook(input) {
    const dirty = Boolean(input && typeof input === 'object' && input.dirty === true);
    // 干净：不打扰作者，直接换（启动时 openBookByPath 也走这里）。
    if (!dirty) return { action: 'proceed', reason: 'clean' };

    const choice = normalizeChoice(input.choice);
    if (choice === 'cancel') return { action: 'abort', reason: 'canceled' };
    if (choice === 'discard') return { action: 'proceed', reason: 'discarded' };
    if (choice === 'save') {
      const saveResult = input.saveResult;
      if (saveResult && typeof saveResult === 'object' && saveResult.ok === true) {
        return { action: 'proceed', reason: 'saved' };
      }
      // 保存失败（或调用方没传结果）：停在原地，把 saveCurrent 的错误原样带出去。
      const message = saveResult && typeof saveResult.message === 'string' ? saveResult.message : '';
      return { action: 'abort', reason: 'save-failed', message };
    }
    // dirty 但还没选：必须先问一次。
    return { action: 'prompt', reason: 'unsaved' };
  }

  return { decideOpenBook };
});