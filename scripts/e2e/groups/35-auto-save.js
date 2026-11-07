// E2E 第 35 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：新建「自动保存测试书」
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。

module.exports = async function group35AutoSave(t) {
  const { exec, check, waitFor } = t;

  // 35. 新建 / 插入章节前自动保存当前章（不再弹「保存 / 不保存 / 取消」）
  await exec("window.__cwTest.newBook('自动保存测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec("window.__cwTest.setText('第一段没保存的内容')");
  check('自动保存：输入后是未保存状态', (await exec('window.__cwTest.dirty()')) === true);
  await exec("window.__cwTest.newChapter('新章一')");
  check('自动保存：新建章节不再弹询问框', (await exec('window.__cwTest.modalOpen()')) === false);
  check(
    '自动保存：新建前的内容已写盘',
    (await exec('window.__cwTest.chapterTextAt(0)')) === '第一段没保存的内容'
  );
  check('自动保存：新章已创建并切过去', (await exec('window.__cwTest.currentTitle()')) === '第2章：新章一');
  check('自动保存：切到新章后是干净状态', (await exec('window.__cwTest.dirty()')) === false);

  await exec("window.__cwTest.switchTo(0, 'discard')");
  await exec("window.__cwTest.setText('插入前没保存的内容')");
  await exec('window.__cwTest.insertAfter(0, "插入章")');
  check('自动保存：插入章节同样不弹询问框', (await exec('window.__cwTest.modalOpen()')) === false);
  check(
    '自动保存：插入前的内容已写盘',
    (await exec('window.__cwTest.chapterTextAt(0)')) === '插入前没保存的内容'
  );
  check(
    '自动保存：插入章位置正确',
    JSON.stringify(await exec('window.__cwTest.chapterNames()')) === JSON.stringify(['', '插入章', '新章一']),
    await exec('window.__cwTest.chapterNames()')
  );
};
