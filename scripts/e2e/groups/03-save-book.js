// E2E 第 3 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 本组在「测试书」上做手动保存整本 + 保存热路径（3b）/ 缺章校验；fs / path 用 node 内建，
// 其余（storage / chaptersLib / diskText …）由场景的 groupContext() 交进来。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group3SaveBook(t) {
  const {
    chaptersLib, storage, sleep, exec, booksRoot, bookDir, check, checkVisual, waitFor, diskText, win, setWindowSize,
    resetCloseReady, waitCloseReady, fileExists
  } = t;

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

  // 3a. 保存快照化（v1.8.0 WP-01 / 审计 C1）：保存期间敲入的字没写盘，不能并进基线。
  // ?test=1 用 setTestSaveDelay 把保存 IPC 拖 600ms，制造「保存还在途」的窗口：
  //   ① 发起保存后立刻改正文 → 磁盘落的是发起那一刻的快照；
  //   ② 回执到达后仍是未保存态，关窗 / 切章照常拦截（以前会被标成已保存 → 静默丢稿）。
  const snapshotText = '快照正文：保存发起那一刻。';
  const typedDuringSave = '快照正文：保存发起那一刻。\n\n保存期间又敲的这句没有写盘。';
  await exec('window.__cwTest.setTestSaveDelay(600)');
  await exec(`window.__cwTest.setText(${JSON.stringify(snapshotText)})`);
  await exec("window.__cwE2ESave = window.__cwTest.save(); 'started'");
  // 回执还没回来（延迟里）：继续在编辑区输入，模拟作者在 IPC 往返期间接着敲字
  await exec(`window.__cwTest.setText(${JSON.stringify(typedDuringSave)})`);
  const dirtyDuringSave = await exec('window.__cwTest.dirty()');
  const snapshotSaveReceipt = await exec('window.__cwE2ESave');
  await exec('delete window.__cwE2ESave');
  const diskAfterSnapshotSave = await diskText('001-未命名.txt');
  check(
    '保存快照化（C1）：保存期间输入的正文不丢——落盘的是发起保存那一刻的快照',
    dirtyDuringSave === true &&
      Boolean(snapshotSaveReceipt && snapshotSaveReceipt.ok === true) &&
      diskAfterSnapshotSave === snapshotText,
    { dirtyDuringSave, snapshotSaveReceipt, diskAfterSnapshotSave }
  );
  const afterSnapshotSave = await exec(`(() => ({ dirty: window.__cwTest.dirty(), text: window.__cwTest.text() }))()`);
  check(
    '保存快照化（C1）：回执到达后编辑区多出的文字仍是未保存态（不再被并进基线）',
    afterSnapshotSave.dirty === true && afterSnapshotSave.text === typedDuringSave,
    afterSnapshotSave
  );
  // ③ 关窗：未保存必须照常拦截（以前渲染层自报干净，主进程的交叉判定也被绕过）
  resetCloseReady();
  win.webContents.send('app:close-requested');
  await waitFor('window.__cwTest.modalOpen()');
  check(
    '保存快照化（C1）：保存期间输入的未保存内容关窗照样拦截',
    (await exec('window.__cwTest.dialog()')) === '退出前保存'
  );
  await exec("window.__cwTest.answerModal('cancel')");
  await waitFor('window.__cwTest.modalOpen() === false');
  check(
    '保存快照化（C1）：关窗询问选「取消」后不退出、内容仍在编辑区',
    (await waitCloseReady()) === false && (await exec('window.__cwTest.text()')) === typedDuringSave
  );
  // ④ 切章：必须照常询问；选「不保存，丢弃修改」后丢弃语义成立（切到第 2 章）
  // 注意不能 await switchTo：dirty 时它要等询问框回答，E2E 必须先拿到弹窗再点按钮。
  await exec("void window.__cwTest.switchTo(1); 'started'");
  await waitFor('window.__cwTest.modalOpen()');
  check(
    '保存快照化（C1）：保存期间输入的内容切章照样拦截',
    (await exec('window.__cwTest.dialog()')) === '切换章节前保存'
  );
  await exec("window.__cwTest.answerModal('discard')");
  check(
    '保存快照化（C1）：切章询问选「不保存」后丢弃语义成立，真的切到目标章',
    (await waitFor("window.__cwTest.currentTitle() === '第2章：夜雨' ? '第2章：夜雨' : null")) === '第2章：夜雨'
  );
  // 收尾：回到第 1 章、关掉延迟（3b 及后面的组仍在第 1 章上跑）
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await exec('window.__cwTest.setTestSaveDelay(0)');

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
  checkVisual(
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

  // ③c. WP10（P-N2）：保存后全书校验单飞——同一本书在途时连按保存不叠第二趟，
  //     结束后最多补一次。这里用 setTestVerifyBook 造一趟 4 秒在途的假校验，连存 3 次：
  //     修复前每次保存各起一趟（max=3）；修复后任何时刻最多 1 趟，全部收尾后总共 2 趟。
  await exec('window.__cwTest.clearToasts()');
  await exec(`(() => {
    window.__e2eVerifyCalls = 0;
    window.__e2eVerifyActive = 0;
    window.__e2eVerifyMax = 0;
    window.__cwTest.setTestVerifyBook(() => {
      window.__e2eVerifyCalls += 1;
      window.__e2eVerifyActive += 1;
      window.__e2eVerifyMax = Math.max(window.__e2eVerifyMax, window.__e2eVerifyActive);
      return new Promise((resolve) => {
        setTimeout(() => {
          window.__e2eVerifyActive -= 1;
          resolve({ chapterCount: 3, missing: [] });
        }, 4000);
      });
    });
    return 'ok';
  })()`);
  for (let i = 0; i < 3; i += 1) {
    await exec(`window.__cwTest.setText(${JSON.stringify(`风从海面吹来。\n\n单飞连存第 ${i + 1} 趟。`)})`);
    await exec('window.__cwTest.saveVisible()');
  }
  const verifyDuring = await exec('({ calls: window.__e2eVerifyCalls, active: window.__e2eVerifyActive, max: window.__e2eVerifyMax })');
  await sleep(3200); // 第一趟 4s 还没结束：连存期间任何时刻都不许叠趟
  const verifyMid = await exec('({ calls: window.__e2eVerifyCalls, active: window.__e2eVerifyActive, max: window.__e2eVerifyMax })');
  await sleep(5200); // 第一趟（4s）+ 合并补的一趟（4s）都结束
  const verifyDone = await exec('({ calls: window.__e2eVerifyCalls, active: window.__e2eVerifyActive, max: window.__e2eVerifyMax })');
  check(
    '保存后全书校验单飞（P-N2）：在途连存不叠趟，结束后最多补一次（3 次保存 → 2 趟）',
    verifyDuring.max === 1 && verifyMid.max === 1 && verifyDone.max === 1 &&
      verifyDuring.calls === 1 && verifyDone.calls === 2 && verifyDone.active === 0,
    { verifyDuring, verifyMid, verifyDone }
  );
  await exec('window.__cwTest.setTestVerifyBook(null)');
  await exec('delete window.__e2eVerifyCalls; delete window.__e2eVerifyActive; delete window.__e2eVerifyMax');

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
  // T-26：功能部分（失败回执 + 点重试真的重新落盘）留在 check，CI 的 E2E 里照常阻塞；
  // 只有「朱红 / 可见 / 高度」这类像素与布局断言留在 checkVisual。
  check(
    '状态栏（1.3.0 T7）：保存失败后点重试真的重新保存成功（磁盘内容与正文一致）',
    Boolean(retryFailedSave && retryFailedSave.ok === false) &&
      retryState.text.startsWith('保存失败：') &&
      Boolean(retryRecovered) &&
      (await diskText('001-未命名.txt')) === retryBody,
    { retryFailedSave, retryRecovered, disk: await diskText('001-未命名.txt') }
  );
  checkVisual(
    '状态栏（1.3.0 T7）：保存失败时朱红显示原因并出现「重试」',
    retryState.retryVisible === true &&
      retryState.retryHeight >= 24 &&
      retryState.color === retryState.danger,
    retryState
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

  // ④b. 审计修复 #6（V302）：当前章文件在应用外被挪走 → 保存被阻断，但必须给救稿出口。
  //    另存走主进程 showSaveDialog（E2E 用 withSavePath 把落点定死）+ 原子写，不碰书库；
  //    「留在这里」与「复制正文」的按钮行为在 tests/save-rescue-ui.test.js 里逐条钉住。
  const rescueHoldDir = path.join(path.dirname(booksRoot), 'e2e-save-rescue-hold');
  const rescueChapterPath = path.join(bookDir, '001-未命名.txt');
  const rescueMovedPath = path.join(rescueHoldDir, '001-未命名.txt');
  const rescueOutPath = path.join(rescueHoldDir, '救稿-第1章.txt');
  const rescueBody = '救稿正文：章节文件被挪走了，这两千字也不能丢。';
  await fs.rm(rescueHoldDir, { recursive: true, force: true });
  await fs.mkdir(rescueHoldDir, { recursive: true });
  try {
    await exec(`window.__cwTest.setText(${JSON.stringify(rescueBody)})`);
    await fs.rename(rescueChapterPath, rescueMovedPath);
    await t.withSavePath(rescueOutPath);
    // 保存会在救稿对话框上等回执：用「结果写进全局、完成后置位」的形态，别让 exec 直接 await 一个
    // 悬着的 Promise（对话框没人答时会一直挂着，整轮 E2E 只能等超时）。
    await exec(
      "window.__cwE2ESave = null; window.__cwE2ESaveDone = false; void window.__cwTest.saveVisible().then((r) => { window.__cwE2ESave = r; window.__cwE2ESaveDone = true; }); 'started'"
    );
    await waitFor('window.__cwTest.modalOpen()');
    const rescueDialog = await exec('window.__cwTest.dialog()');
    check(
      '保存阻断救稿（V302）：当前章文件被应用外挪走 → 保存失败并弹「保存被阻止：这些字还没落盘」',
      rescueDialog === '保存被阻止：这些字还没落盘' &&
        (await fileExists(rescueChapterPath)) === false,
      { rescueDialog }
    );
    await exec("window.__cwTest.answerModal('save')");
    const rescued = await waitFor(
      "window.__cwTest.toasts().some((item) => item.message.startsWith('已另存：')) ? window.__cwTest.toasts() : null",
      8000
    );
    const rescueSave = await waitFor('window.__cwE2ESaveDone ? window.__cwE2ESave : null', 8000);
    await exec('delete window.__cwE2ESave; delete window.__cwE2ESaveDone');
    const rescuedBytes = await fs.readFile(rescueOutPath, 'utf8');
    check(
      '保存阻断救稿（V302）：点「另存这一章为 txt…」→ 正文落盘（CRLF）、提示给出路径，书库仍然不重建影子文件',
      Array.isArray(rescued) &&
        rescued.some((item) => item.message.startsWith('已另存：') && item.message.includes('救稿-第1章.txt')) &&
        rescuedBytes === rescueBody &&
        Boolean(rescueSave && rescueSave.ok === false && rescueSave.code === 'CHAPTER_MISSING') &&
        (await fileExists(rescueChapterPath)) === false,
      { rescued, rescuedBytes, rescueSave }
    );
  } finally {
    await t.restoreSaveDialog();
    await fs.rename(rescueMovedPath, rescueChapterPath);
    await fs.rm(rescueHoldDir, { recursive: true, force: true });
  }
  // 文件放回后照常能保存（mtime 没变：rename 在同一盘内保留时间戳），失败态清干净。
  await exec('window.__cwTest.save()');
  check(
    '保存阻断救稿（V302）：章文件放回后照常保存成功（救稿没有把书库写坏）',
    (await exec('window.__cwTest.dirty()')) === false &&
      (await diskText('001-未命名.txt')) === rescueBody
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
