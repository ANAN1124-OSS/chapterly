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
    '替换这一处：返回替换序号与总数',
    firstOne && firstOne.ok === true && firstOne.index === 0 && firstOne.total === 3,
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
};
