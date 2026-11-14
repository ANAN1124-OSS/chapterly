// E2E 第 20 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：导入「章节小说 - 作者」并打开
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

// 「正字数」口径：去掉所有空白（与 core/chapters.js 的 countChars 一致）。
const countChars = (text) => String(text == null ? '' : text).replace(/\s/g, '').length;

module.exports = async function group20ImportChapters(t) {
  const { exec, check, waitFor, storage, booksRoot } = t;

  // 20. 默认「按原文章节导入」：按原文标题拆章，章名和正文照抄
  const chaptersSrc = path.join(path.dirname(booksRoot), '按原文章节源');
  await fs.mkdir(chaptersSrc, { recursive: true });
  const chapteredText = '第1章 开端\n\n原文第一段\n\n第2章 转折\n\n原文第二段\n';
  await fs.writeFile(path.join(chaptersSrc, '章节小说 - 作者.txt'), chapteredText, 'utf8');
  await exec(`window.__cwTest.importPaths([${JSON.stringify(chaptersSrc)}])`);
  const shelfChaptered = await storage.listBooks(booksRoot);
  const chapteredBook = shelfChaptered.find((b) => b.title === '章节小说 - 作者');
  check(
    '默认按原文章节导入：自动拆成多章',
    Boolean(chapteredBook && chapteredBook.chapterCount === 2),
    chapteredBook && chapteredBook.chapterCount
  );
  // C25（v1.8.0 WP-24）：chars 只算写盘正文（标题行在 name 里），书架字数 = 各章 body 之和。
  // 旧实现 chars = countChars(标题 + body)，这本 10 字的书会显示 20 字、首次保存后又回落。
  const chapteredPath = path.join(booksRoot, '章节小说 - 作者');
  const chapteredMeta = JSON.parse(await fs.readFile(path.join(chapteredPath, '书目.json'), 'utf8'));
  const chapteredDiskChars = [];
  for (const chapter of chapteredMeta.chapters) {
    chapteredDiskChars.push(countChars(await fs.readFile(path.join(chapteredPath, chapter.file), 'utf8')));
  }
  check(
    '默认按原文章节导入：每章 chars 只算正文（不含标题行），与写盘章节文件的去空白字数一致',
    chapteredMeta.chapters.length === 2 &&
      chapteredMeta.chapters.every((chapter, index) => chapter.chars === chapteredDiskChars[index]) &&
      chapteredMeta.chapters[0].chars === countChars('原文第一段') &&
      chapteredMeta.chapters[1].chars === countChars('原文第二段'),
    { chars: chapteredMeta.chapters.map((chapter) => chapter.chars), chapteredDiskChars }
  );
  check(
    '默认按原文章节导入：书架字数 = 各章正文之和（不把标题行算进去）',
    Boolean(chapteredBook) &&
      chapteredBook.totalChars === countChars('原文第一段') + countChars('原文第二段') &&
      chapteredBook.totalChars ===
        chapteredMeta.chapters.reduce((sum, chapter) => sum + chapter.chars, 0),
    chapteredBook && chapteredBook.totalChars
  );
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(chapteredPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  check(
    '章名照抄原文标题',
    JSON.stringify(await exec('window.__cwTest.chapterTitles()')) ===
      JSON.stringify(['第1章 开端', '第2章 转折'])
  );
  check(
    '本章正文保留原文空行（没有 trim）',
    (await exec('window.__cwTest.text()')) === '\n原文第一段\n'
  );
};
