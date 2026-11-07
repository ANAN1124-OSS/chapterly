// E2E 第 51 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：回书架 → 新建「专注模式测试书」；51h 用组 47 旧书
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group51FocusMode(t) {
  const { exec, check, waitFor, sleep, userData, fileExists, state } = t;
  const { fragLegacyBookPath, fragLegacyMetaPath } = t.state;

  // 51. 专注模式（提案 3.5）：隐藏左栏与顶栏、F11 / 按钮进出、Esc 退出、打字机模式。
  // 全部只改显示（DOM class + textarea.scrollTop）：不改正文、不写盘、不写配置、不碰书目。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  // 书架页按 F11 不应该进专注模式（只在写作页生效）
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11', bubbles: true }))");
  check(
    '专注模式：书架页按 F11 不进入专注模式（只在写作页生效）',
    (await exec('window.__cwTest.view()')) === 'shelf' &&
      (await exec('window.__cwTest.focusState()')).on === false
  );

  await exec("window.__cwTest.newBook('专注模式测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const focusBookPath = await exec('window.__cwTest.bookPathValue()');
  state.focusBookPath = focusBookPath; // 第 52 / 54 / 55 组的 groupContext().bookPath（原样交回主进程那一本）
  await exec("window.__cwTest.renameChapterAt(0, '长夜')");
  // 80 行短句（每行都不够宽，换行不受左栏隐藏影响，便于校验滚动位置还原）
  const focusLines = [];
  for (let i = 1; i <= 80; i += 1) focusLines.push(`第${i}行：他沿着堤岸往回走，风很轻。`);
  const focusText = focusLines.join('\n');
  await exec(`window.__cwTest.setText(${JSON.stringify(focusText)})`);
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");
  const focusNormal = await exec('window.__cwTest.focusState()');
  await exec('window.__cwTest.setCaret(0)');
  const focusScrollBefore = await exec('window.__cwTest.setEditorScroll(120)');
  check(
    '专注模式：进入前是普通写作页（左栏 / 顶栏 / 分隔条都在）',
    focusNormal.on === false &&
      focusNormal.sidebarDisplay !== 'none' &&
      focusNormal.headerDisplay !== 'none' &&
      focusNormal.resizerDisplay !== 'none' &&
      focusNormal.barVisible === false
  );

  // 只读基线：专注模式全程不应该改 config、书目、章节 txt
  const focusMetaBefore = await fs.readFile(path.join(focusBookPath, '书目.json'), 'utf8');
  const focusConfigBefore = await fs.readFile(path.join(userData, 'config.json'), 'utf8');
  const focusTxtBefore = [];
  for (const chapter of JSON.parse(focusMetaBefore).chapters) {
    const stat = await fs.stat(path.join(focusBookPath, chapter.file));
    focusTxtBefore.push({ file: chapter.file, size: stat.size, mtimeMs: stat.mtimeMs });
  }

  // 51a. 顶栏「专注」按钮进入：左栏 / 分隔条 / 顶栏收起，正文占满，极简退出条出现
  await exec("document.getElementById('btn-focus').click()");
  await waitFor('window.__cwTest.focusState().on === true');
  const focusOn = await exec('window.__cwTest.focusState()');
  check(
    '专注模式：进入后左栏 / 分隔条 / 顶栏隐藏，正文占满，状态栏和退出条还在',
    focusOn.viewHasClass === true &&
      focusOn.bodyHasClass === true &&
      focusOn.sidebarDisplay === 'none' &&
      focusOn.resizerDisplay === 'none' &&
      focusOn.headerDisplay === 'none' &&
      focusOn.barVisible === true &&
      focusOn.statusbarDisplay !== 'none' &&
      focusOn.editorWidth >= focusNormal.editorWidth + focusNormal.sidebarWidth + 6 - 1,
    {
      editorWidth: focusOn.editorWidth,
      normalWidth: focusNormal.editorWidth,
      sidebarWidth: focusNormal.sidebarWidth
    }
  );
  check(
    '专注模式：退出条显示章名、「打字机」开关和「退出专注 Esc」',
    focusOn.focusTitle === focusOn.chapterTitle &&
      focusOn.chapterTitle.includes('长夜') &&
      focusOn.typewriterLabel === '打字机' &&
      focusOn.typewriterDataOn === '0' &&
      focusOn.exitLabel.includes('退出专注') &&
      focusOn.exitLabel.includes('Esc'),
    { title: focusOn.focusTitle, exit: focusOn.exitLabel }
  );

  // 视觉拍板 #5（2026-11-04）：退出按钮补 F11 键帽 —— 顶栏按钮 title 早就写了「Esc / F11」，
  // 条内只提示 Esc。两个键帽要并排（同一行）、中间留 4px、整体不顶出退出条。
  const focusExitKeys = await exec(`(() => {
    const btn = document.getElementById('btn-focus-exit');
    const bar = document.getElementById('focus-bar').getBoundingClientRect();
    const exit = btn.getBoundingClientRect();
    const round = (n) => Math.round(n * 100) / 100;
    const kbds = Array.from(btn.querySelectorAll('.focus-kbd')).map((el) => {
      const r = el.getBoundingClientRect();
      return { text: el.textContent.trim(), l: round(r.left), r: round(r.right), t: round(r.top) };
    });
    return { kbds, title: btn.title, exitRight: round(exit.right), barRight: round(bar.right) };
  })()`);
  check(
    '专注模式（拍板 #5）：退出按钮同时显示 Esc 与 F11 两个键帽（并排 4px、不顶出退出条）',
    focusExitKeys.kbds.length === 2 &&
      focusExitKeys.kbds[0].text === 'Esc' &&
      focusExitKeys.kbds[1].text === 'F11' &&
      focusExitKeys.kbds[1].l - focusExitKeys.kbds[0].r >= 3 &&
      focusExitKeys.kbds[1].l - focusExitKeys.kbds[0].r <= 5 &&
      Math.abs(focusExitKeys.kbds[0].t - focusExitKeys.kbds[1].t) <= 0.5 &&
      focusExitKeys.title.includes('F11') &&
      focusExitKeys.exitRight <= focusExitKeys.barRight + 0.5,
    focusExitKeys
  );

  // 51b. F11 再按一次退出：布局、章节栏宽度、滚动位置都复原
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11', bubbles: true }))");
  await waitFor('window.__cwTest.focusState().on === false');
  const focusOff = await exec('window.__cwTest.focusState()');
  check(
    '专注模式：F11 再按一次退出，左栏 / 顶栏 / 分隔条原样回来',
    focusOff.viewHasClass === false &&
      focusOff.bodyHasClass === false &&
      focusOff.sidebarDisplay !== 'none' &&
      focusOff.headerDisplay !== 'none' &&
      focusOff.resizerDisplay !== 'none' &&
      focusOff.barVisible === false
  );
  check(
    '专注模式：退出后编辑区宽度 / 章节栏宽度回到原样（布局不留残迹）',
    Math.abs(focusOff.editorWidth - focusNormal.editorWidth) <= 1 &&
      Math.abs(focusOff.sidebarWidth - focusNormal.sidebarWidth) <= 1,
    { editor: focusOff.editorWidth, normal: focusNormal.editorWidth }
  );
  check(
    '专注模式：退出后滚动位置回到进入前（120px，按光标相对屏幕位置还原）',
    Math.abs(focusOff.editorScrollTop - focusScrollBefore) <= 2,
    { before: focusScrollBefore, after: focusOff.editorScrollTop }
  );

  // 51c. F11 进入、Esc 退出（真实键盘路径）
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11', bubbles: true }))");
  await waitFor('window.__cwTest.focusState().on === true');
  check(
    '专注模式：写作页按 F11 进入专注模式',
    (await exec('window.__cwTest.focusState()')).barVisible === true &&
      (await exec('window.__cwTest.focusState()')).sidebarDisplay === 'none'
  );
  await exec('window.__cwTest.setEditorScroll(300)');
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor('window.__cwTest.focusState().on === false');
  const focusEscOff = await exec('window.__cwTest.focusState()');
  check(
    '专注模式：Esc 退出并恢复普通布局与进入前的滚动位置',
    focusEscOff.viewHasClass === false &&
      focusEscOff.sidebarDisplay !== 'none' &&
      focusEscOff.barVisible === false &&
      Math.abs(focusEscOff.editorScrollTop - focusScrollBefore) <= 2,
    { scroll: focusEscOff.editorScrollTop, expected: focusScrollBefore }
  );

  // 51d. Esc 的优先级：有弹层时先关弹层，专注模式还在
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11', bubbles: true }))");
  await waitFor('window.__cwTest.focusState().on === true');
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))");
  await waitFor('window.__cwTest.findPanelOpen() === true');
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor('window.__cwTest.findPanelOpen() === false');
  check(
    '专注模式：弹层开着时 Esc 先关弹层，专注模式不受影响',
    (await exec('window.__cwTest.focusState()')).on === true
  );
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor('window.__cwTest.focusState().on === false');
  check(
    '专注模式：弹层关了再按 Esc 才退出专注模式',
    (await exec('window.__cwTest.view()')) === 'editor' &&
      (await exec('window.__cwTest.focusState()')).barVisible === false
  );

  // 51e. 打字机模式：光标行保持在正文区上方约 1/3 处
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11', bubbles: true }))");
  await waitFor('window.__cwTest.focusState().on === true');
  await exec('window.__cwTest.setEditorScroll(0)');
  await exec('window.__cwTest.setCaret(0)');
  await exec("document.getElementById('btn-focus-typewriter').click()");
  await waitFor('window.__cwTest.focusState().typewriter === true');
  const focusTwOn = await exec('window.__cwTest.focusState()');
  check(
    '专注模式：退出条「打字机」开关带 ✓（只记内存）',
    focusTwOn.typewriterLabel.startsWith('✓') && focusTwOn.typewriterDataOn === '1'
  );
  const focusLinePos = focusText.indexOf('第40行');
  await exec(`document.getElementById('editor').setSelectionRange(${focusLinePos}, ${focusLinePos})`);
  await exec(
    "document.getElementById('editor').dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }))"
  );
  await waitFor('window.__cwTest.focusMetrics().scrollTop > 0');
  const focusTw = await exec('window.__cwTest.focusMetrics()');
  const focusTwExpected = Math.min(
    Math.max(Math.round(focusTw.caretTop - focusTw.clientHeight / 3), 0),
    focusTw.maxScrollTop
  );
  check(
    '专注模式：打字机模式把光标行放到正文区上方约 1/3 处',
    Math.abs(focusTw.scrollTop - focusTwExpected) <= 2 &&
      Math.abs(focusTw.caretTop - focusTw.scrollTop - focusTw.clientHeight / 3) <= 2,
    {
      scrollTop: focusTw.scrollTop,
      expected: focusTwExpected,
      caretTop: focusTw.caretTop,
      clientHeight: focusTw.clientHeight
    }
  );
  await exec('window.__cwTest.setCaret(0)');
  await exec(
    "document.getElementById('editor').dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowUp', bubbles: true }))"
  );
  await waitFor('window.__cwTest.focusMetrics().scrollTop === 0');
  check(
    '专注模式：光标回到章首时正文滚回顶部，不会滚出界',
    (await exec('window.__cwTest.focusMetrics()')).scrollTop === 0
  );
  await exec(`document.getElementById('editor').setSelectionRange(${focusText.length}, ${focusText.length})`);
  await exec(
    "document.getElementById('editor').dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }))"
  );
  await waitFor('window.__cwTest.focusMetrics().scrollTop > 0');
  const focusTwEnd = await exec('window.__cwTest.focusMetrics()');
  check(
    '专注模式：光标在章尾时最多滚到最底部（不会滚出正文）',
    focusTwEnd.maxScrollTop > 0 && Math.abs(focusTwEnd.scrollTop - focusTwEnd.maxScrollTop) <= 2,
    { scrollTop: focusTwEnd.scrollTop, max: focusTwEnd.maxScrollTop }
  );
  // 关掉打字机：再移动光标就不该自动滚了
  await exec("document.getElementById('btn-focus-typewriter').click()");
  await waitFor('window.__cwTest.focusState().typewriter === false');
  await exec('window.__cwTest.setEditorScroll(50)');
  await exec(`document.getElementById('editor').setSelectionRange(${focusLinePos}, ${focusLinePos})`);
  const focusTwOffBefore = await exec('window.__cwTest.focusMetrics()');
  await exec(
    "document.getElementById('editor').dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }))"
  );
  await sleep(250);
  const focusTwOffAfter = await exec('window.__cwTest.focusMetrics()');
  check(
    '专注模式：关掉「打字机」后移动光标不再自动滚动（正文没被动过）',
    Math.abs(focusTwOffAfter.scrollTop - focusTwOffBefore.scrollTop) <= 1 &&
      (await exec('window.__cwTest.text()')) === focusText
  );

  // 51f. 全程只读：config.json / 书目.json / 章节 txt 一个字节都没变（专注模式不写配置）
  const focusMetaAfter = await fs.readFile(path.join(focusBookPath, '书目.json'), 'utf8');
  const focusConfigAfter = await fs.readFile(path.join(userData, 'config.json'), 'utf8');
  const focusTxtAfter = [];
  for (const item of focusTxtBefore) {
    const stat = await fs.stat(path.join(focusBookPath, item.file));
    focusTxtAfter.push({ file: item.file, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  check(
    '专注模式：全程只读（config.json、书目.json、章节 txt 都没变）',
    focusConfigAfter === focusConfigBefore &&
      focusMetaAfter === focusMetaBefore &&
      JSON.stringify(focusTxtAfter) === JSON.stringify(focusTxtBefore) &&
      !(await fileExists(path.join(focusBookPath, '_trash')))
  );
  check(
    '专注模式：没有把专注 / 打字机状态写进配置（开关只记内存）',
    focusConfigAfter.includes('focus') === false &&
      focusConfigAfter.includes('typewriter') === false
  );

  // 51g. 回书架自动退出专注模式；重新打开书是普通布局
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor('window.__cwTest.focusState().on === false');
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11', bubbles: true }))");
  await waitFor('window.__cwTest.focusState().on === true');
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const focusShelfState = await exec('window.__cwTest.focusState()');
  check(
    '专注模式：回书架自动退出（不留在专注布局里）',
    focusShelfState.on === false && focusShelfState.viewHasClass === false && focusShelfState.barVisible === false
  );
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(focusBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  const focusReopen = await exec('window.__cwTest.focusState()');
  check(
    '专注模式：重新打开书是普通布局（专注模式不跨会话、不自动进入）',
    focusReopen.on === false &&
      focusReopen.sidebarDisplay !== 'none' &&
      focusReopen.headerDisplay !== 'none' &&
      focusReopen.barVisible === false
  );

  // 51h. 旧数据兼容：v0.4.1 形状（没有 schemaVersion、章节没有 status/note）的书照常进出专注模式
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const focusLegacyBefore = await fs.readFile(fragLegacyMetaPath, 'utf8');
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(fragLegacyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11', bubbles: true }))");
  await waitFor('window.__cwTest.focusState().on === true');
  await exec('window.__cwTest.focusTypewriter(true)');
  await exec('window.__cwTest.setCaret(0)');
  const focusLegacyOn = await exec('window.__cwTest.focusState()');
  check(
    '专注模式：旧书照常进入专注模式并显示章名',
    focusLegacyOn.barVisible === true && focusLegacyOn.focusTitle === focusLegacyOn.chapterTitle
  );
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor('window.__cwTest.focusState().on === false');
  const focusLegacyAfter = await fs.readFile(fragLegacyMetaPath, 'utf8');
  check(
    '专注模式：旧书书目不被补 schemaVersion / 状态 / 备注（一个字节都没变）',
    focusLegacyAfter === focusLegacyBefore &&
      focusLegacyBefore.includes('"schemaVersion"') === false
  );
  await exec('window.__cwTest.focusTypewriter(false)');
};
