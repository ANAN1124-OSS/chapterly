// E2E 第 14 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：续「测试书」当前章（外部改 txt 后 trigger blur）
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group14ExternalChange(t) {
  const { exec, check, waitFor, sleep, bookDir } = t;

  // 14. 外部修改检测：模拟用记事本改了当前章，重新获得焦点时提示重新加载
  const currentFile = await exec(
    'window.__cwTest.state.chapters[window.__cwTest.state.index].file'
  );
  await fs.appendFile(path.join(bookDir, currentFile), '\r\n外部改的内容', 'utf8');
  await exec("window.dispatchEvent(new Event('blur'))");
  await sleep(700);
  await exec("window.dispatchEvent(new Event('focus'))");
  await waitFor('window.__cwTest.modalOpen()', 8000);
  check('检测到外部修改并弹窗', (await exec('window.__cwTest.dialog()')) === '检测到外部修改');
  await exec("window.__cwTest.answerModal('reload')");
  await waitFor("window.__cwTest.text().includes('外部改的内容')", 8000);
  check('选择重新加载后读到外部内容', true);

  // ---------- 14b. 审计修复 #5（V301）：外部改动检测门槛降到 0 + 保存带 expectedMtimeMs 三选 ----------
  // ① 失焦 0ms 就切回来（快速 Alt+Tab）：以前 `since < 500` 直接 return，检测根本不跑 → 保存静默覆盖。
  //    现在一获得焦点就查，先给 warn（有未保存修改时只提示，不弹重载框——既有口径不变）。
  await exec('window.__cwTest.clearToasts()');
  const localText = '本地还没保存的改动：外部那一版不能被静默盖掉。';
  await exec(`window.__cwTest.setText(${JSON.stringify(localText)})`);
  await fs.appendFile(path.join(bookDir, currentFile), '\r\n第二次外部改动', 'utf8');
  await exec("window.dispatchEvent(new Event('blur'))");
  await exec("window.dispatchEvent(new Event('focus'))");
  const quickSwitchToasts = await waitFor(
    "window.__cwTest.toasts().some((item) => item.message.includes('本章在应用外被修改过')) ? window.__cwTest.toasts() : null",
    8000
  );
  check(
    '外部修改检测（V301）：失焦 0ms 回来也查一次（500ms 门槛取消），有未保存修改时只给 warn 提示',
    Array.isArray(quickSwitchToasts) &&
      quickSwitchToasts.some(
        (item) => item.kind === 'warn' && item.message.includes('保存会覆盖外部内容')
      ),
    quickSwitchToasts
  );

  // ② 这时按保存：主进程比对 expectedMtimeMs 不符 → EXTERNAL_CHANGE 弹窗，磁盘先保持外部那一版。
  // 保存会在对话框上等回执：结果写进全局、完成后置位，别让 exec 直接 await 一个悬着的 Promise。
  await exec(
    "window.__cwE2ESave = null; window.__cwE2ESaveDone = false; void window.__cwTest.saveVisible().then((r) => { window.__cwE2ESave = r; window.__cwE2ESaveDone = true; }); 'started'"
  );
  await waitFor('window.__cwTest.modalOpen()');
  const conflictDialog = await exec('window.__cwTest.dialog()');
  const diskBeforeOverwrite = await fs.readFile(path.join(bookDir, currentFile), 'utf8');
  check(
    '保存前置校验（V301）：外部改过之后再保存 → 弹「这一章在应用外被改过」，磁盘一个字节都没被覆盖',
    conflictDialog === '这一章在应用外被改过' &&
      diskBeforeOverwrite.includes('第二次外部改动') &&
      !diskBeforeOverwrite.includes(localText),
    { conflictDialog, diskBeforeOverwrite }
  );

  // ③ 作者明确选「仍然覆盖保存」：真的写盘，dirty 归零，loadedMtimeMs 跟到磁盘那一版（下次保存不再误报）。
  await exec("window.__cwTest.answerModal('overwrite')");
  const overwriteSave = await waitFor('window.__cwE2ESaveDone ? window.__cwE2ESave : null', 8000);
  await exec('delete window.__cwE2ESave; delete window.__cwE2ESaveDone');
  const overwriteChapterPath = path.join(bookDir, currentFile);
  const diskAfterOverwrite = await fs.readFile(overwriteChapterPath, 'utf8');
  const diskAfterStat = await fs.stat(overwriteChapterPath);
  const afterOverwrite = await exec(`(() => ({
    dirty: window.__cwTest.dirty(),
    text: window.__cwTest.text(),
    mtime: window.__cwTest.state.loadedMtimeMs,
    saveError: window.__cwTest.state.saveError
  }))()`);
  check(
    '保存前置校验（V301）：选「仍然覆盖保存」→ 写盘成功、dirty 归零、loadedMtimeMs 跟到磁盘那一版',
    Boolean(overwriteSave && overwriteSave.ok === true) &&
      diskAfterOverwrite === localText &&
      afterOverwrite.dirty === false &&
      afterOverwrite.text === localText &&
      !afterOverwrite.saveError &&
      Math.abs(afterOverwrite.mtime - diskAfterStat.mtimeMs) < 1,
    { overwriteSave, diskAfterOverwrite, afterOverwrite, diskMtimeMs: diskAfterStat.mtimeMs }
  );
};
