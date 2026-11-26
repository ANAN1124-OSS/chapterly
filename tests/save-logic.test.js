const test = require('node:test');
const assert = require('node:assert/strict');
const saveLogic = require('../renderer/save-logic');

// 审计 F2：保存热路径先出「已保存」提示、全书校验挪到后台。
// 这两段文案必须与改动前逐字一致，所以用单测锁住；真正的异步顺序由 E2E 覆盖。

test('保存提示：章数 / 本章字数 / 今日快照的文案与改动前逐字一致', () => {
  // 改动前：`已保存：${report.chapterCount} 章 · 本章 ${formatChars(data.chars)}${snapshotNote}`
  assert.equal(
    saveLogic.savedToastText({ chapterCount: 3, charsText: '1.20 万字' }),
    '已保存：3 章 · 本章 1.20 万字'
  );
  assert.equal(
    saveLogic.savedToastText({ chapterCount: 1284, charsText: '26 字' }),
    '已保存：1284 章 · 本章 26 字'
  );
  // 今日快照只多这一句（原来也是这样拼的）
  assert.equal(
    saveLogic.savedToastText({ chapterCount: 1, charsText: '5 字', snapshotTaken: true }),
    '已保存：1 章 · 本章 5 字 · 今日快照已留'
  );
  assert.equal(
    saveLogic.savedToastText({ chapterCount: 1, charsText: '5 字', snapshotTaken: false }),
    '已保存：1 章 · 本章 5 字'
  );
});

test('保存提示：章数取书目里的章节数，坏值按 0、小数向下取整（不出现 NaN）', () => {
  assert.equal(saveLogic.savedToastText({ chapterCount: 0, charsText: '0 字' }), '已保存：0 章 · 本章 0 字');
  assert.equal(saveLogic.savedToastText({ chapterCount: 4.7, charsText: '' }), '已保存：4 章 · 本章 ');
  assert.equal(saveLogic.savedToastText({ chapterCount: '6', charsText: '12 字' }), '已保存：6 章 · 本章 12 字');
  assert.equal(saveLogic.savedToastText({ chapterCount: -3, charsText: '12 字' }), '已保存：0 章 · 本章 12 字');
  assert.equal(saveLogic.savedToastText({ chapterCount: undefined, charsText: '12 字' }), '已保存：0 章 · 本章 12 字');
  assert.equal(saveLogic.savedToastText({ chapterCount: NaN, charsText: '12 字' }), '已保存：0 章 · 本章 12 字');
  assert.equal(saveLogic.savedToastText({ chapterCount: 2, charsText: null }), '已保存：2 章 · 本章 ');
  assert.equal(saveLogic.savedToastText(), '已保存：0 章 · 本章 ');
  // 章数只来自 state.chapters.length，不受其它字段影响（多传字段也不会串进来）
  assert.equal(
    saveLogic.savedToastText({ chapterCount: 3, charsText: '9 字', missing: ['001-x.txt'], ok: false }),
    '已保存：3 章 · 本章 9 字'
  );
});

test('保存提示：字数基线缺失时在「已保存」旁补一句「本次字数未计入」，其它文案不变', () => {
  // C0（审计 #3 / E1）：旧章字数读不到 → 这次增量按 0 记，界面给一条弱提示（不拦保存）。
  assert.equal(
    saveLogic.savedToastText({ chapterCount: 3, charsText: '18 字', charsBaselineMissing: true }),
    '已保存：3 章 · 本章 18 字 · 本次字数未计入'
  );
  assert.equal(
    saveLogic.savedToastText({ chapterCount: 1, charsText: '5 字', snapshotTaken: true, charsBaselineMissing: true }),
    '已保存：1 章 · 本章 5 字 · 今日快照已留 · 本次字数未计入'
  );
  // 正常路径（字段不存在 / false）与以前逐字一致
  assert.equal(
    saveLogic.savedToastText({ chapterCount: 3, charsText: '18 字', charsBaselineMissing: false }),
    '已保存：3 章 · 本章 18 字'
  );
  assert.equal(saveLogic.savedToastText({ chapterCount: 3, charsText: '18 字' }), '已保存：3 章 · 本章 18 字');
});

test('后台校验：只有真的缺章才给 warn，文案与改动前一致', () => {
  assert.equal(
    saveLogic.verifyWarnText({ chapterCount: 3, totalChars: 120, missing: ['002-夜雨.txt'] }),
    '已保存当前章，但全书有 1 个章节文件缺失'
  );
  assert.equal(
    saveLogic.verifyWarnText({ missing: ['001-a.txt', '003-c.txt', '004-d.txt'] }),
    '已保存当前章，但全书有 3 个章节文件缺失'
  );
  // 不缺章 / 报告不完整 / 校验失败（调用方已 catch）都不提示，避免误报
  assert.equal(saveLogic.verifyWarnText({ chapterCount: 3, missing: [] }), '');
  assert.equal(saveLogic.verifyWarnText({ chapterCount: 3 }), '');
  assert.equal(saveLogic.verifyWarnText({ missing: 'oops' }), '');
  assert.equal(saveLogic.verifyWarnText({ missing: null }), '');
  assert.equal(saveLogic.verifyWarnText(null), '');
  assert.equal(saveLogic.verifyWarnText(undefined), '');
});

test('保存快照化（C1）：回执到达后只认发起保存那一刻的快照——保存期间输入必须仍算未保存', () => {
  // 典型路径：发起保存时正文 = 快照，保存还在途时又敲了字 → 活值 ≠ 快照 = 未保存。
  assert.equal(saveLogic.isDirtyAgainstSnapshot('第一段', '第一段'), false);
  assert.equal(saveLogic.isDirtyAgainstSnapshot('第一段', '第一段\n\n保存期间补的一句'), true);
  // 保存期间删字 / 改字也一样（不是长度比较，是内容比较）
  assert.equal(saveLogic.isDirtyAgainstSnapshot('第一段', '第一'), true);
  assert.equal(saveLogic.isDirtyAgainstSnapshot('abc', 'abd'), true);
  // 空正文与 null / undefined 口径：都按空串，只有真差异才算脏
  assert.equal(saveLogic.isDirtyAgainstSnapshot('', ''), false);
  assert.equal(saveLogic.isDirtyAgainstSnapshot(null, ''), false);
  assert.equal(saveLogic.isDirtyAgainstSnapshot(undefined, ''), false);
  assert.equal(saveLogic.isDirtyAgainstSnapshot(null, '有字'), true);
  // 非字符串输入不会炸（返回布尔值由调用方直接用）
  assert.equal(saveLogic.isDirtyAgainstSnapshot(12, '12'), false);
  assert.equal(saveLogic.isDirtyAgainstSnapshot(12, '13'), true);
});

test('保存提示是纯函数：不依赖 DOM / 全局状态，重复调用结果稳定', () => {
  const first = saveLogic.savedToastText({ chapterCount: 3, charsText: '18 字' });
  const second = saveLogic.savedToastText({ chapterCount: 3, charsText: '18 字' });
  assert.equal(first, second);
  assert.equal(typeof window, 'undefined');
  assert.equal(typeof saveLogic.savedToastText, 'function');
  assert.equal(typeof saveLogic.verifyWarnText, 'function');
  // C1（WP-01）：快照判定同样是纯函数，E2E 的保存延迟窗口靠它得出 dirty
  assert.equal(typeof saveLogic.isDirtyAgainstSnapshot, 'function');
  assert.equal(saveLogic.isDirtyAgainstSnapshot('同一段', '同一段'), false);
});

// A2-STATS-02（低）：stats.json 写不进时主进程回 statsError，但渲染层全仓没有消费方 ——
// 正文保存成功、界面一切正常，今天 / 目标 / 连续天数静默少记。与「基线读不到」同口径给一句弱提示。
test('A2-STATS-02：统计写盘失败时保存摘要补一句「本次字数未计入」', () => {
  assert.equal(
    saveLogic.savedToastText({ chapterCount: 3, charsText: '18 字', statsFailed: true }),
    '已保存：3 章 · 本章 18 字 · 本次字数未计入'
  );
  assert.equal(
    saveLogic.savedToastText({ chapterCount: 3, charsText: '18 字', statsFailed: false }),
    '已保存：3 章 · 本章 18 字',
    '统计正常时文案逐字不变'
  );
  // 与「基线读不到」可以同时出现（两个原因都让这次增量没进统计）
  assert.equal(
    saveLogic.savedToastText({ chapterCount: 1, charsText: '2 字', charsBaselineMissing: true, statsFailed: true }),
    '已保存：1 章 · 本章 2 字 · 本次字数未计入',
    '同一句提示不重复'
  );
});

// A2-SAVE-02（低）：部分成功（META_SAVE_FAILED）回执写字数缓存前要核「还是发起时那本书」——
// 保存 A 书期间换了书，B 书里同 id 的章不许被 A 书的字数覆盖，也不许重画 B 书的目录。
test('A2-SAVE-02：部分成功的字数缓存只写回发起时那本书（跨书回 -1）', () => {
  const chapters = [{ id: 'ch_1', chars: 10 }, { id: 'ch_2', chars: 20 }];
  assert.equal(
    saveLogic.charsCacheIndexAfterPartialSave({ chapters, chapterId: 'ch_2', sameBook: true }),
    1,
    '同书同 id 章照常定位'
  );
  assert.equal(
    saveLogic.charsCacheIndexAfterPartialSave({ chapters, chapterId: 'ch_2', sameBook: false }),
    -1,
    '换书后不许写（B 书同 id 章会被 A 书的字数覆盖）'
  );
  assert.equal(
    saveLogic.charsCacheIndexAfterPartialSave({ chapters, chapterId: 'missing', sameBook: true }),
    -1,
    '章不在列表里 —— 不写'
  );
  assert.equal(saveLogic.charsCacheIndexAfterPartialSave({ chapters: null, chapterId: 'ch_1', sameBook: true }), -1);
  assert.equal(saveLogic.charsCacheIndexAfterPartialSave(), -1);
});

// A2-SAVE-03（低）：保存后的全书校验回执只在「还是发起时那本书 + 仍在写作页」时才弹提示 ——
// 千章书保存成功后立刻回书架 / 换书时，A 书的缺章警告不许弹到书架（或另一本书）上。
test('A2-SAVE-03：全书校验提示只在原书 + 写作页落地（其它现场返回空串）', () => {
  const warn = '已保存当前章，但全书有 1 个章节文件缺失';
  assert.equal(saveLogic.verifyWarnForView({ warn, sameBook: true, view: 'editor' }), warn, '原书 + 写作页照常提示');
  assert.equal(saveLogic.verifyWarnForView({ warn, sameBook: false, view: 'editor' }), '', '换书后不提示');
  assert.equal(saveLogic.verifyWarnForView({ warn, sameBook: true, view: 'shelf' }), '', '回书架后不提示');
  assert.equal(saveLogic.verifyWarnForView({ warn: '', sameBook: true, view: 'editor' }), '', '没有警告时不提示');
  assert.equal(saveLogic.verifyWarnForView({ warn: null, sameBook: false, view: 'shelf' }), '');
  assert.equal(saveLogic.verifyWarnForView(), '');
});
