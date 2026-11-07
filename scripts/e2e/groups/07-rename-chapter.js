// E2E 第 7 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：续「测试书」
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。

module.exports = async function group7RenameChapter(t) {
  const { exec, check, waitFor, storage, bookDir } = t;

  // 7. 重命名章节（新建的「灯塔」改名为「灯塔改名」）
  await exec("window.__cwTest.renameChapterAt(1, '灯塔改名')");
  check(
    '重命名后标题变化、文件名不变',
    (await exec('window.__cwTest.currentTitle()')).length >= 0 &&
      JSON.stringify(await exec('window.__cwTest.chapterTitles()')) ===
        JSON.stringify(['第1章：起风', '第2章：灯塔改名', '第3章：夜雨', '第4章'])
  );
  const meta3 = await storage.readBookMeta(bookDir);
  check('重命名只改 name 不动 file', meta3.chapters[1].file === '004-灯塔.txt' && meta3.chapters[1].name === '灯塔改名');

  // 7b. Phase D / D2：编辑区按 F2 重命名当前章。
  // 合成 keydown 就够：F2 的监听挂在 document 上（和真实按键走同一个处理函数），不受窗口焦点影响。
  // 当前章是第 1 章「起风」（上面的 hook 改的是第 2 章，没切章）。
  await exec("document.getElementById('editor').focus()");
  const f2Prevented = await exec(`(() => {
    const event = new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  })()`);
  await waitFor('window.__cwTest.modalOpen() === true', 4000);
  check(
    'F2：编辑区按 F2 打开重命名询问框（拦掉默认行为；初值就是当前章名，取消仍在最左）',
    f2Prevented === true &&
      (await exec('window.__cwTest.dialog()')) === '重命名章节' &&
      (await exec("document.getElementById('modal-input').value")) === '起风' &&
      (await exec("document.querySelector('#modal-buttons button[data-value=\\\"cancel\\\"]').textContent")) === '取消'
  );
  await exec("document.getElementById('modal-input').value = '起风（F2）'");
  await exec("window.__cwTest.answerModal('ok')");
  await waitFor(`window.__cwTest.chapterTitles()[0] === '第1章：起风（F2）'`, 8000);
  const f2Meta = await storage.readBookMeta(bookDir);
  check(
    'F2：改名真的写进书目，章节文件不变',
    f2Meta.chapters[0].name === '起风（F2）' && f2Meta.chapters[0].file === '001-未命名.txt'
  );
  // 还原第 1 章的显示名：后面几组（复制书 / 章节状态 / 统计）照旧按原来的书名断言
  await exec("window.__cwTest.renameChapterAt(0, '起风')");
  await waitFor(`window.__cwTest.chapterTitles()[0] === '第1章：起风'`, 8000);
};
