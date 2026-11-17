// E2E 第 29 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：续「拖拽排序书」（只替换一处）
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。

module.exports = async function group29ReplaceOne(t) {
  const { exec, check, sleep } = t;

  // 29. 只替换这一处：只改编辑区、替换后选中下一处、只作用于当前章
  await exec('window.__cwTest.switchTo(0, "discard")');
  await exec("window.__cwTest.setText('阿明一。阿明二。阿明三。')");
  await exec('window.__cwTest.save()');
  await exec('window.__cwTest.openFindPanel()');
  await exec("window.__cwTest.setFindFields({ query: '阿明', replacement: '小红', scope: 'book' })");
  const oneOnBook = await exec('window.__cwTest.findReplaceOne()');
  check('替换这一处：整本范围下不会执行', oneOnBook && oneOnBook.ok === false, oneOnBook);
  check(
    '替换这一处：整本范围下正文不动',
    (await exec('window.__cwTest.text()')) === '阿明一。阿明二。阿明三。'
  );

  await exec("window.__cwTest.setFindFields({ query: '阿明', replacement: '小红', scope: 'current' })");
  await exec('window.__cwTest.findRun()');
  await sleep(200);
  check('替换这一处：查找后选中第 1 处', (await exec('window.__cwTest.selection()')).start === 0);
  const firstOne = await exec('window.__cwTest.findReplaceOne()');
  check(
    '替换这一处：只改第 1 处，其余命中保留',
    (await exec('window.__cwTest.text()')) === '小红一。阿明二。阿明三。',
    await exec('window.__cwTest.text()')
  );
  check('替换这一处：替换后自动选中第 2 处', (await exec('window.__cwTest.selection()')).start === 4);
  check(
    '替换这一处：返回替换序号与总数（未截断时 truncated=false）',
    firstOne && firstOne.ok === true && firstOne.index === 0 && firstOne.total === 3 &&
      firstOne.truncated === false,
    firstOne
  );
  check('替换这一处：仍是未保存状态', (await exec('window.__cwTest.dirty()')) === true);
  check(
    '替换这一处：磁盘上还是旧内容',
    (await exec('window.__cwTest.chapterTextAt(0)')) === '阿明一。阿明二。阿明三。'
  );
  await exec('window.__cwTest.findReplaceOne()');
  check(
    '替换这一处：连按第二次替换第 2 处',
    (await exec('window.__cwTest.text()')) === '小红一。小红二。阿明三。'
  );
  check('替换这一处：第 3 处也被选中', (await exec('window.__cwTest.selection()')).start === 8);
  await exec('window.__cwTest.save()');
  await exec('window.__cwTest.closeFindPanel()');
  check(
    '替换这一处：保存后才写盘',
    (await exec('window.__cwTest.chapterTextAt(0)')) === '小红一。小红二。阿明三。'
  );

  // v1.8.2 WP3（E-N4 / 中 #4）：findNext 回执迟到时切章 —— 旧章命中下标绝不套到新章正文上。
  // 用 setTestFindNextDelay 把「查找下一处」IPC 拖 800ms，启动替换后立刻切到第 2 章；
  // 修复前：回执到达时把「阿明」在第 1 章的命中下标套进第 2 章 → 替换错位并标脏，Ctrl+S 即污染落盘。
  await exec('window.__cwTest.switchTo(1, "discard")');
  const secondChapterTextBefore = await exec('window.__cwTest.text()');
  await exec('window.__cwTest.switchTo(0, "discard")');
  await exec('window.__cwTest.openFindPanel()');
  await exec("window.__cwTest.setFindFields({ query: '阿明', replacement: '小红', scope: 'current' })");
  await exec('window.__cwTest.findRun()');
  await sleep(200);
  await exec('window.__cwTest.setTestFindNextDelay(800)');
  await exec("window.__cwReplaceOnePending = window.__cwTest.findReplaceOne(); 'started'");
  await exec('window.__cwTest.switchTo(1, "discard")');
  const staleReplaceResult = await exec('window.__cwReplaceOnePending');
  await exec('delete window.__cwReplaceOnePending');
  await exec('window.__cwTest.setTestFindNextDelay(0)');
  const secondChapterTextAfter = await exec('window.__cwTest.text()');
  check(
    '替换这一处：等 findNext 期间切章 → 不替换新章正文（E-N4）',
    secondChapterTextAfter === secondChapterTextBefore,
    { before: secondChapterTextBefore, after: secondChapterTextAfter }
  );
  check(
    '替换这一处：等 findNext 期间切章 → 返回待复核，不报成功（E-N4）',
    staleReplaceResult && staleReplaceResult.ok === false && staleReplaceResult.code === 'STALE_TARGET',
    staleReplaceResult
  );
  const staleReplaceSummary = await exec('window.__cwTest.findSummary()');
  check(
    '替换这一处：等 findNext 期间切章 → 摘要提示切章并重新查找（E-N4）',
    typeof staleReplaceSummary === 'string' && staleReplaceSummary.includes('切了章'),
    staleReplaceSummary
  );
  check(
    '替换这一处：等 findNext 期间切章 → 新章没有被标成未保存（E-N4）',
    (await exec('window.__cwTest.dirty()')) === false
  );
  // 收回组 29 结束时的现场：第 1 章正文 / 磁盘 / 干净状态都回到本组末尾那一版，后续组不受影响。
  await exec('window.__cwTest.switchTo(0, "discard")');
  await exec("window.__cwTest.setText('小红一。小红二。阿明三。')");
  await exec('window.__cwTest.save()');
  await exec('window.__cwTest.closeFindPanel()');
};
