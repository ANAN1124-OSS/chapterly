// E2E 第 21 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：续组 20 的「章节小说 - 作者」（拖分隔条）
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。

module.exports = async function group21SidebarSplitter(t) {
  const { exec, check, sleep } = t;

  // 21. 章节栏 / 写作区 之间的分隔条可拖动，宽度按「这本书」记忆（不写全局）
  const sidebarBookId = await exec('window.__cwTest.bookId()');
  const globalSidebarBefore = await exec(
    'window.api.getConfig().then((r) => (r.ok ? r.data.editorSidebarWidth : null))'
  );
  const initialSidebarWidth = await exec('window.__cwTest.sidebarWidth()');
  const splitterScriptResult = await exec(`(() => {
    try {
      const resizer = document.getElementById('sidebar-resizer');
      const rect = resizer.getBoundingClientRect();
      const x = rect.left + 3;
      const y = rect.top + 20;
      resizer.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x + 120, clientY: y }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x + 120, clientY: y, button: 0, pointerId: 1 }));
      return 'ok';
    } catch (err) {
      return 'ERR:' + String((err && err.stack) || err);
    }
  })()`);
  if (splitterScriptResult !== 'ok') throw new Error('分隔条模拟失败：' + splitterScriptResult);
  await sleep(500);
  const draggedWidth = await exec('window.__cwTest.sidebarWidth()');
  check(
    '拖动分隔条可以调整章节栏宽度',
    Math.abs(draggedWidth - initialSidebarWidth - 120) <= 3,
    { initialSidebarWidth, draggedWidth }
  );
  const domSidebarWidth = await exec(
    `parseFloat(getComputedStyle(document.getElementById('sidebar')).width)`
  );
  check('章节栏宽度实际应用到页面', Math.abs(domSidebarWidth - draggedWidth) <= 1, {
    domSidebarWidth,
    draggedWidth
  });
  const savedSidebarDisplay = await exec(
    `window.api.getBookDisplay(${JSON.stringify(sidebarBookId)}).then((r) => (r.ok ? r.data : null))`
  );
  check(
    '章节栏宽度记到这本书（全局默认不变）',
    Boolean(savedSidebarDisplay) &&
      savedSidebarDisplay.editorSidebarWidth === draggedWidth &&
      globalSidebarBefore === 250,
    { savedSidebarDisplay, globalSidebarBefore }
  );
  await exec(
    `document.getElementById('sidebar-resizer').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`
  );
  await sleep(400);
  const resetWidth = await exec('window.__cwTest.sidebarWidth()');
  check('双击分隔条恢复默认宽度', resetWidth === 250, { resetWidth });
  const resetSidebarDisplay = await exec(
    `window.api.getBookDisplay(${JSON.stringify(sidebarBookId)}).then((r) => (r.ok ? r.data : null))`
  );
  check(
    '双击恢复也按这本书记（记成 250）',
    Boolean(resetSidebarDisplay) && resetSidebarDisplay.editorSidebarWidth === 250,
    resetSidebarDisplay
  );
};
