// E2E 第 37 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：新建「状态备注测试书」
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group37ChapterStatus(t) {
  const { exec, check, waitFor, sleep, storage } = t;

  // 37. 章节状态 + 备注：只改书目.json，章节 txt 一个字节不动
  await exec("window.__cwTest.newBook('状态备注测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const statusBookPath = await exec('window.__cwTest.state.bookPath');
  await exec("window.__cwTest.newChapter('待修章')");
  await exec("window.__cwTest.newChapter('完稿章')");
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await exec("window.__cwTest.setText('第一章正文。')");
  await exec('window.__cwTest.save()');
  await exec("window.__cwTest.switchTo(1, 'discard')");
  await exec("window.__cwTest.setText('第二章正文。')");
  await exec('window.__cwTest.save()');
  await exec("window.__cwTest.switchTo(2, 'discard')");
  await exec("window.__cwTest.setText('第三章正文。')");
  await exec('window.__cwTest.save()');

  // 记下三章 txt 的字节和 mtime：后面标状态、写备注后必须完全一致
  const statusMetaBefore = await storage.readBookMeta(statusBookPath);
  const statusTxtBefore = [];
  for (const chapter of statusMetaBefore.chapters) {
    const filePath = path.join(statusBookPath, chapter.file);
    const stat = await fs.stat(filePath);
    statusTxtBefore.push({
      file: chapter.file,
      text: await fs.readFile(filePath),
      mtimeMs: stat.mtimeMs,
      size: stat.size
    });
  }

  check(
    '章节状态：新书默认全是草稿、没有备注',
    JSON.stringify(await exec('window.__cwTest.chapterStatuses()')) ===
      JSON.stringify(['draft', 'draft', 'draft']) &&
      (await exec('window.__cwTest.chapterNotes()')).every((note) => note === '')
  );
  check(
    '章节状态：侧栏三个默认灰色圆点',
    JSON.stringify(await exec('window.__cwTest.chapterStatusDots()')) ===
      JSON.stringify(['draft', 'draft', 'draft'])
  );
  check('章节状态：草稿章没有备注图标', (await exec('window.__cwTest.chapterNoteMarks()')).length === 0);

  // 右键菜单：标记项 + 备注项（走真实 contextmenu 事件）
  await exec(
    "document.querySelectorAll('#chapter-list .chapter-item')[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 12 }))"
  );
  check(
    '章节状态：右键菜单有标记完稿/待修/草稿和编辑备注',
    JSON.stringify(await exec("Array.from(document.querySelectorAll('#context-menu button[data-action]')).map((b) => b.dataset.action)")) ===
      JSON.stringify(['status-done', 'status-revising', 'status-draft', 'edit-note', 'copy-platform', 'rename', 'move-volume', 'insert-before', 'insert-after', 'delete']),
    await exec("Array.from(document.querySelectorAll('#context-menu button[data-action]')).map((b) => b.dataset.action)")
  );
  check(
    '章节状态：当前状态的那一项打勾',
    (await exec("document.querySelector('#context-menu button[data-action=\"status-draft\"]').textContent")).includes('✓')
  );
  await exec("document.querySelector('#context-menu button[data-action=\"status-done\"]').click()");
  await waitFor("window.__cwTest.chapterStatuses()[0] === 'done'");
  check('章节状态：右键「标记为完稿」生效', (await exec('window.__cwTest.chapterStatuses()'))[0] === 'done');
  await exec("window.__cwTest.setChapterStatusAt(1, 'revising')");
  await exec("window.__cwTest.setChapterStatusAt(2, 'done')");
  check(
    '章节状态：圆点跟着状态走（完稿/待修/完稿）',
    JSON.stringify(await exec('window.__cwTest.chapterStatusDots()')) ===
      JSON.stringify(['done', 'revising', 'done'])
  );

  // 编辑备注：右键 → 编辑备注…（弹窗里填一句话）
  await exec(
    "document.querySelectorAll('#chapter-list .chapter-item')[2].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 12 }))"
  );
  await exec("document.querySelector('#context-menu button[data-action=\"edit-note\"]').click()");
  await waitFor('window.__cwTest.modalOpen()');
  check(
    '章节备注：弹窗标题带章节名',
    (await exec('window.__cwTest.dialog()')).includes('章节备注'),
    await exec('window.__cwTest.dialog()')
  );
  await exec("document.getElementById('modal-input').value = '这章结尾要重写';");
  await exec("window.__cwTest.answerModal('ok')");
  await waitFor("window.__cwTest.chapterNotes()[2] === '这章结尾要重写'");
  check(
    '章节备注：侧栏出现 ✎ 标记、悬浮能看到备注',
    (await exec('window.__cwTest.chapterNoteMarks()')).length === 1 &&
      (await exec('window.__cwTest.chapterItemTitles()'))[2].includes('这章结尾要重写')
  );

  // 超过 200 字截断、空备注删除字段、非法状态拒绝
  const statusChapter1Id = statusMetaBefore.chapters[1].id;
  const statusChapter0Id = statusMetaBefore.chapters[0].id;
  const longNoteRes = await exec(
    `window.api.updateChapterMeta(${JSON.stringify(statusBookPath)}, ${JSON.stringify(statusChapter1Id)}, { note: '字'.repeat(250) })`
  );
  check(
    '章节备注：超过 200 字自动截断',
    Boolean(longNoteRes && longNoteRes.ok === true && longNoteRes.data.chapter.note.length === 200),
    longNoteRes && longNoteRes.data && longNoteRes.data.chapter
  );
  await exec(
    `window.api.updateChapterMeta(${JSON.stringify(statusBookPath)}, ${JSON.stringify(statusChapter1Id)}, { note: '' })`
  );
  const clearedMeta = await storage.readBookMeta(statusBookPath);
  check('章节备注：清空后备注字段被删除', clearedMeta.chapters[1].note === undefined);
  const badStatusRes = await exec(
    `window.api.updateChapterMeta(${JSON.stringify(statusBookPath)}, ${JSON.stringify(statusChapter0Id)}, { status: 'finished' })`
  );
  check(
    '章节状态：非法状态被拒绝（BAD_STATUS）',
    Boolean(badStatusRes && badStatusRes.ok === false && badStatusRes.code === 'BAD_STATUS'),
    badStatusRes
  );

  // 落盘检查：状态/备注进书目；txt 一个字节都不动
  const statusMetaAfter = await storage.readBookMeta(statusBookPath);
  check(
    '章节状态/备注：状态与备注写进书目.json',
    statusMetaAfter.chapters[0].status === 'done' &&
      statusMetaAfter.chapters[1].status === 'revising' &&
      statusMetaAfter.chapters[2].status === 'done' &&
      statusMetaAfter.chapters[2].note === '这章结尾要重写',
    statusMetaAfter.chapters.map((chapter) => ({ status: chapter.status, note: chapter.note }))
  );
  const statusRaw = JSON.parse(await fs.readFile(path.join(statusBookPath, '书目.json'), 'utf8'));
  check(
    '章节状态/备注：书目里没备注的章不带 note 字段',
    statusRaw.chapters[0].note === undefined && statusRaw.chapters[1].note === undefined
  );
  let statusTxtUntouched = true;
  for (const item of statusTxtBefore) {
    const filePath = path.join(statusBookPath, item.file);
    const stat = await fs.stat(filePath);
    const text = await fs.readFile(filePath);
    if (stat.size !== item.size || stat.mtimeMs !== item.mtimeMs || !text.equals(item.text)) {
      statusTxtUntouched = false;
    }
  }
  check('章节状态/备注：txt 内容、大小、mtime 一个字节都没动', statusTxtUntouched);

  // 书卡显示「完稿 X/Y 章」
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec("window.__cwTest.setShelfQuery('')");
  await sleep(250);
  const cardMetaTexts = await exec('window.__cwTest.bookCardMetaTexts()');
  check(
    '书卡：显示「完稿 2/3 章」',
    cardMetaTexts.some((text) => text.includes('完稿 2/3 章')),
    cardMetaTexts
  );

  // 重新打开：状态/备注从书目读回
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(statusBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  check(
    '章节状态/备注：重新打开书后还在',
    JSON.stringify(await exec('window.__cwTest.chapterStatuses()')) ===
      JSON.stringify(['done', 'revising', 'done']) &&
      (await exec('window.__cwTest.chapterNotes()'))[2] === '这章结尾要重写'
  );
};
