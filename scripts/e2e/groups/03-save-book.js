// E2E 第 3 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 本组在「测试书」上做手动保存整本 + 保存热路径（3b）/ 缺章校验；fs / path 用 node 内建，
// 其余（storage / chaptersLib / diskText …）由场景的 groupContext() 交进来。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group3SaveBook(t) {
  const { chaptersLib, storage, sleep, exec, booksRoot, bookDir, check, waitFor, diskText, win, setWindowSize } = t;

  // 3. 手动保存整本：写当前章 + 校验全书
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await exec("window.__cwTest.setText('风从海面吹来。\\n\\n他收起了帆。')");
  check('输入后变为未保存状态', (await exec('window.__cwTest.dirty()')) === true);
  const saveResult = await exec('window.__cwTest.save()');
  check('保存成功', saveResult && saveResult.ok === true, saveResult);
  check('保存后不再是未保存状态', (await exec('window.__cwTest.dirty()')) === false);
  check(
    '磁盘上的章节内容正确（CRLF 落盘、读回 LF）',
    (await diskText('001-未命名.txt')) === '风从海面吹来。\n\n他收起了帆。'
  );
  const meta1 = await storage.readBookMeta(bookDir);
  check('书目.json 三章顺序正确', JSON.stringify(meta1.chapters.map((c) => c.name)) === JSON.stringify(['起风', '夜雨', '']));

  // 3b. 保存热路径（代码审计 F2；1.3.0 T7 起反馈在状态栏）：保存一成功就刷新状态栏——
  // 章数直接用书目里的章节数（不再为了拿这个数字 await 一趟全书校验）；全书校验挪到后台，
  // 发现缺章才 warn（文案不变），校验本身失败只记日志、不误报。下面用 ?test=1 的提示记录
  // 验证时序，并用 setTestVerifyBook 把后台校验拖慢 / 弄失败来证明「保存真的不等它」。
  // 注意：toast 记录里**不应该**再出现「已保存」——成功摘要改挂状态栏 title（T7）。
  await exec('window.__cwTest.clearToasts()');
  // ① 后台校验被拖慢 600ms：保存仍然马上返回，提示已经出了
  await exec(
    "window.__cwTest.setTestVerifyBook(() => new Promise((resolve) => setTimeout(() => resolve({ chapterCount: 3, missing: [] }), 600)))"
  );
  await exec("window.__cwTest.setText('风从海面吹来。\\n\\n他收起了帆。又补一句。')");
  const slowVerifyBody = '风从海面吹来。\n\n他收起了帆。又补一句。';
  const slowSaveStartedAt = Date.now();
  const slowSave = await exec('window.__cwTest.saveVisible()');
  const slowSaveMs = Date.now() - slowSaveStartedAt;
  const toastsRightAway = await exec('window.__cwTest.toasts()');
  // 1.3.0 T7（规范 C-05 / I-01）：保存成功的反馈在状态栏——不再弹 toast；
  // 原来 toast 的完整摘要（章数 / 本章字数 / 快照）逐字收进 #status-text 的 title。
  const slowSaveFeedback = await exec(`(() => {
    const text = document.getElementById('status-text');
    const chapter = document.getElementById('status-chapter');
    return {
      text: text.textContent,
      title: text.title,
      chapterLabel: document.getElementById('status-chapter-label').textContent,
      chapterText: document.getElementById('status-chapter').textContent.trim(),
      chapterVisible: getComputedStyle(chapter).display !== 'none',
      toastSaved: window.__cwTest.toasts().some((item) => String(item.message || '').startsWith('已保存'))
    };
  })()`);
  check(
    '保存热路径：全书校验被拖慢时保存照样马上返回（保存热路径不再等校验）',
    Boolean(slowSave && slowSave.ok === true) && slowSaveMs < 500,
    { slowSaveMs, slowSave }
  );
  check(
    '保存热路径：保存一完成就出「已保存」提示，章数取书目里的 3 章、文案与以前一致',
    slowSaveFeedback.text.startsWith('已保存') &&
      slowSaveFeedback.title === `已保存：3 章 · 本章 ${chaptersLib.countChars(slowVerifyBody)} 字` &&
      slowSaveFeedback.toastSaved === false &&
      !toastsRightAway.some((item) => item.message.includes('全书校验失败')),
    { feedback: slowSaveFeedback, toastsRightAway }
  );
  // 中段「第 N 章 · 本章 X 字」：章节位置与标题栏同一口径，本章字数与右段同一条计算。
  check(
    '状态栏（1.3.0 T7）：中段显示「第 N 章 · 本章 X 字」，章节位置与标题栏同一口径',
    slowSaveFeedback.chapterVisible === true &&
      slowSaveFeedback.chapterLabel === '第1章' &&
      slowSaveFeedback.chapterText.includes(`本章 ${chaptersLib.countChars(slowVerifyBody)} 字`),
    slowSaveFeedback
  );
  await sleep(800);
  check(
    '保存热路径：后台校验跑完、没有缺章时不会多弹警告',
    !(await exec('window.__cwTest.toasts()')).some((item) => item.message.includes('章节文件缺失'))
  );
  // 成功 2s 后保存态淡到 60%（不消失）：计算样式是 .6，文案还在。
  const fadedOpacity = await waitFor(
    "getComputedStyle(document.getElementById('status-save')).opacity === '0.6' ? '0.6' : null",
    6000
  );
  const fadedState = await exec(`(() => ({
    opacity: getComputedStyle(document.getElementById('status-save')).opacity,
    text: document.getElementById('status-text').textContent
  }))()`);
  check(
    '状态栏（1.3.0 T7）：保存成功 2s 后保存态淡到 60%（不消失，文案还在）',
    fadedOpacity === '0.6' && fadedState.opacity === '0.6' && fadedState.text.startsWith('已保存'),
    fadedState
  );

  // ② 后台校验失败（书被挪走 / 临时读失败）：保存照常成功，不再误报「全书校验失败」
  await exec('window.__cwTest.clearToasts()');
  await exec("window.__cwTest.setTestVerifyBook(() => Promise.reject(new Error('E2E verify boom')))");
  await exec("window.__cwTest.setText('风从海面吹来。\\n\\n他收起了帆。再补一句。')");
  const failedVerifySave = await exec('window.__cwTest.saveVisible()');
  // 1.3.0 T7：成功摘要在状态栏 title 上，不在 toast 上。
  const failedVerifyFeedback = await exec(`(() => ({
    text: document.getElementById('status-text').textContent,
    title: document.getElementById('status-text').title
  }))()`);
  await sleep(400);
  const failedVerifyToasts = await exec('window.__cwTest.toasts()');
  check(
    '保存热路径：后台校验失败也不影响保存、不误报（不再有「全书校验失败」）',
    Boolean(failedVerifySave && failedVerifySave.ok === true) &&
      failedVerifyFeedback.text.startsWith('已保存') &&
      failedVerifyFeedback.title.startsWith('已保存：3 章') &&
      !failedVerifyToasts.some((item) => item.message.startsWith('已保存')) &&
      !failedVerifyToasts.some((item) => item.message.includes('全书校验失败')) &&
      !failedVerifyToasts.some((item) => item.kind === 'error'),
    { feedback: failedVerifyFeedback, failedVerifyToasts }
  );

  // ③ 真有缺章：后台校验发现 1 个缺章才 warn（文案不变），「已保存」提示仍然先出。
  // 章节 txt 先挪到临时书库外面，测完立刻放回去（不生成 _trash、不动书目）。
  await exec('window.__cwTest.setTestVerifyBook(null)');
  await exec('window.__cwTest.clearToasts()');
  const missingHoldDir = path.join(path.dirname(booksRoot), 'e2e-missing-hold');
  await fs.mkdir(missingHoldDir, { recursive: true });
  await fs.rename(path.join(bookDir, '002-夜雨.txt'), path.join(missingHoldDir, '002-夜雨.txt'));
  await exec("window.__cwTest.setText('风从海面吹来。\\n\\n他收起了帆。补第三句。')");
  const missingSave = await exec('window.__cwTest.saveVisible()');
  const missingFeedback = await exec(`(() => ({
    text: document.getElementById('status-text').textContent,
    title: document.getElementById('status-text').title
  }))()`);
  const missingToasts = await waitFor(
    "window.__cwTest.toasts().some((item) => item.message.includes('章节文件缺失')) ? window.__cwTest.toasts() : null"
  );
  const savedToastIndex = missingToasts.findIndex((item) => item.message.startsWith('已保存：3 章'));
  const missingWarnIndex = missingToasts.findIndex(
    (item) => item.message === '已保存当前章，但全书有 1 个章节文件缺失'
  );
  check(
    '保存热路径：缺章时后台仍会警告（文案不变），且「已保存」提示先出',
    Boolean(missingSave && missingSave.ok === true) &&
      missingFeedback.text.startsWith('已保存') &&
      missingFeedback.title.startsWith('已保存：3 章') &&
      savedToastIndex === -1 &&
      missingWarnIndex >= 0,
    { feedback: missingFeedback, missingToasts }
  );
  await fs.rename(path.join(missingHoldDir, '002-夜雨.txt'), path.join(bookDir, '002-夜雨.txt'));
  await fs.rm(missingHoldDir, { recursive: true, force: true });

  // ③b. 状态栏失败态（1.3.0 T7 = 规范 C-05 / I-01）：把章节文件设成只读让真实写盘失败 →
  //    朱红「保存失败：原因」+ 出现「重试」按钮；恢复权限后点重试 = 同一条 saveCurrent() 真的写盘。
  //    失败 toast 保持 1.2.0 原样（规范只要求成功不弹），所以这里只断言状态栏。
  const t7OrigBounds = win.getBounds();
  const retryChapterPath = path.join(bookDir, '001-未命名.txt');
  await fs.chmod(retryChapterPath, 0o444);
  let retryFailedSave;
  const retryBody = '风从海面吹来。\n\n他收起了帆。失败重试。';
  try {
    await exec("window.__cwTest.setText('风从海面吹来。\\n\\n他收起了帆。失败重试。')");
    retryFailedSave = await exec('window.__cwTest.saveVisible()');
  } finally {
    await fs.chmod(retryChapterPath, 0o666);
  }
  const retryState = await exec(`(() => {
    const text = document.getElementById('status-text');
    const retry = document.getElementById('status-retry');
    const probe = document.createElement('span');
    probe.style.color = 'var(--danger)';
    document.body.appendChild(probe);
    const danger = getComputedStyle(probe).color;
    probe.remove();
    return {
      text: text.textContent,
      retryVisible: !retry.classList.contains('hidden') && getComputedStyle(retry).display !== 'none',
      retryHeight: Math.round(retry.getBoundingClientRect().height),
      color: getComputedStyle(text).color,
      danger
    };
  })()`);
  await exec("document.getElementById('status-retry').click()");
  const retryRecovered = await waitFor(
    "window.__cwTest.dirty() === false && document.getElementById('status-text').textContent.startsWith('已保存') ? document.getElementById('status-text').textContent : null",
    8000
  );
  check(
    '状态栏（1.3.0 T7）：保存失败时朱红显示原因并出现「重试」，点重试真的重新保存成功',
    Boolean(retryFailedSave && retryFailedSave.ok === false) &&
      retryState.text.startsWith('保存失败：') &&
      retryState.retryVisible === true &&
      retryState.retryHeight >= 24 &&
      retryState.color === retryState.danger &&
      Boolean(retryRecovered) &&
      (await diskText('001-未命名.txt')) === retryBody,
    { retryFailedSave, retryState, retryRecovered, disk: await diskText('001-未命名.txt') }
  );

  // ③c. 窄窗（1.3.0 T7）：960（最小窗口宽）时中段「第 N 章 · 本章字数」整段让位，
  //    保存态与右段的今日字数 / 计时优先；宽窗 ≥1040 时中段在（上面第一条已量 1200 宽）。
  await setWindowSize(960, 700, { maxInner: 960 });
  const narrowStatus = await exec(`(() => ({
    vw: window.innerWidth,
    chapterDisplay: getComputedStyle(document.getElementById('status-chapter')).display,
    saveDisplay: getComputedStyle(document.getElementById('status-save')).display,
    text: document.getElementById('status-text').textContent
  }))()`);
  check(
    '状态栏（1.3.0 T7）：960 宽（最小窗口）时中段「第 N 章 · 本章字数」整段让位，保存态还在',
    narrowStatus.vw <= 1040 &&
      narrowStatus.chapterDisplay === 'none' &&
      narrowStatus.saveDisplay !== 'none' &&
      narrowStatus.text.startsWith('已保存'),
    narrowStatus
  );
  await setWindowSize(t7OrigBounds.width, t7OrigBounds.height, { minInner: 1000 });

  // ④ 保存时字数没变也照样刷新书目：**不采纳**审计里「chars 没变就跳过 writeBookMeta」那条
  //    —— writeBookMeta 同时刷新 updatedAt，跳过会冻结书架的「最后修改」时间。
  const metaRawBefore = JSON.parse(await fs.readFile(path.join(bookDir, '书目.json'), 'utf8'));
  // 与上一版同为 18 字（只换语序），字数缓存不变
  await exec("window.__cwTest.setText('他收起了帆。\\n\\n风从海面吹来。补第三句。')");
  await exec('window.__cwTest.save()');
  const metaRawAfter = JSON.parse(await fs.readFile(path.join(bookDir, '书目.json'), 'utf8'));
  check(
    '保存热路径：字数没变的保存照样刷新书目 updatedAt（书架「最后修改」不会冻结）',
    metaRawAfter.chapters[0].chars === metaRawBefore.chapters[0].chars &&
      metaRawAfter.updatedAt !== metaRawBefore.updatedAt,
    {
      chars: [metaRawBefore.chapters[0].chars, metaRawAfter.chapters[0].chars],
      updatedAt: [metaRawBefore.updatedAt, metaRawAfter.updatedAt]
    }
  );

  // 收尾：把第 1 章恢复成第 3 组断言时的正文（后面的组还要接着用这本书）
  await exec("window.__cwTest.setText('风从海面吹来。\\n\\n他收起了帆。')");
  await exec('window.__cwTest.save()');
  await fs.access(path.join(bookDir, '002-夜雨.txt'));
  check(
    '保存热路径：收尾恢复第 3 组正文、缺章文件已放回（校验全程只读）',
    (await diskText('001-未命名.txt')) === '风从海面吹来。\n\n他收起了帆。' &&
      (await exec('window.__cwTest.dirty()')) === false
  );
  await exec('window.__cwTest.setTestVerifyBook(null)');
};
