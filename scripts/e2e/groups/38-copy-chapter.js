// E2E 第 38 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：新建「复制本章测试书」
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group38CopyChapter(t) {
  const { exec, check, waitFor, clipboard, storage, readClipboard, waitForClipboard } = t;

  // 38. 复制本章（平台格式）：只复制正文、段首缩进 + 段间空一行（空行带缩进），不写盘
  await exec("window.__cwTest.newBook('复制本章测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const copyBookPath = await exec('window.__cwTest.bookPathValue()');
  await exec("window.__cwTest.newChapter('第二章 未保存')");
  await exec("window.__cwTest.newChapter('第三章 空章')");
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await exec("window.__cwTest.setText('风从海面吹来。\\n他收起了帆。')");
  await exec('window.__cwTest.save()');
  await exec("window.__cwTest.switchTo(1, 'discard')");
  await exec("window.__cwTest.setText('这一章还没保存。\\n第二段。')");

  // 记下复制前磁盘状态：复制本章全程只读，txt / 书目.json 的章节记录都不该被改写
  const copyMeta = await storage.readBookMeta(copyBookPath);
  const copyChaptersBefore = JSON.stringify(copyMeta.chapters);
  const copyFiles = copyMeta.chapters.map((chapter) => path.join(copyBookPath, chapter.file));
  const copyStatBefore = [];
  for (const filePath of copyFiles) {
    const stat = await fs.stat(filePath);
    copyStatBefore.push({ size: stat.size, mtimeMs: stat.mtimeMs });
  }

  // Ctrl+Shift+C：当前章有未保存内容时，编辑区里的最新内容参与复制
  await clipboard.writeText('E2E-SENTINEL');
  await exec(
    "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, shiftKey: true, bubbles: true }))"
  );
  const clipCurrent = await waitForClipboard((text) => text !== 'E2E-SENTINEL');
  check(
    '复制本章：Ctrl+Shift+C 把当前章正文按平台格式送进剪贴板',
    clipCurrent === '　　这一章还没保存。\r\n　　\r\n　　第二段。\r\n',
    JSON.stringify(clipCurrent)
  );
  check(
    '复制本章：剪贴板里只有正文、不含章名',
    !clipCurrent.includes('第二章 未保存') && !clipCurrent.includes('第2章'),
    JSON.stringify(clipCurrent)
  );
  check('复制本章：未保存内容参与复制、但复制后仍是未保存状态', (await exec('window.__cwTest.dirty()')) === true);
  check(
    '复制本章：没保存的正文没有偷偷写盘',
    (await exec('window.__cwTest.chapterTextAt(1)')) === ''
  );

  // 右键章节（非当前章）→「复制本章（平台格式）」：读磁盘内容，也同样套格式
  await exec(
    "document.querySelectorAll('#chapter-list .chapter-item')[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 12 }))"
  );
  check(
    '复制本章：右键菜单有「复制本章（平台格式）」',
    (await exec("document.querySelector('#context-menu button[data-action=\"copy-platform\"]').textContent")).includes(
      '复制本章（平台格式）'
    )
  );
  await clipboard.writeText('E2E-SENTINEL-2');
  await exec("document.querySelector('#context-menu button[data-action=\"copy-platform\"]').click()");
  const clipSaved = await waitForClipboard((text) => text !== 'E2E-SENTINEL-2');
  check(
    '复制本章：右键复制已保存章也套平台格式',
    clipSaved === '　　风从海面吹来。\r\n　　\r\n　　他收起了帆。\r\n',
    JSON.stringify(clipSaved)
  );
  check(
    '复制本章：右键复制的是被点的那一章、不是当前章',
    !clipSaved.includes('这一章还没保存'),
    JSON.stringify(clipSaved)
  );

  // 空章：给提示，绝不拿空字符串覆盖剪贴板
  await exec("window.__cwTest.switchTo(2, 'discard')");
  await clipboard.writeText('KEEP-ME');
  const emptyCopy = await exec('window.__cwTest.copyChapterPlatformAt(2)');
  check(
    '复制本章：空章给出 empty 标记、剪贴板没被覆盖',
    Boolean(emptyCopy && emptyCopy.empty === true) && (await readClipboard()) === 'KEEP-ME',
    emptyCopy
  );

  // 全程只读：章节 txt 的大小 / mtime 没变；书目里的章节记录也没被复制动作改写
  // （切章会正常更新「上次打开章节」，所以只比较 chapters 数组，不比较整个书目文件）
  let copyFilesUntouched = true;
  for (let i = 0; i < copyFiles.length; i += 1) {
    const stat = await fs.stat(copyFiles[i]);
    if (stat.size !== copyStatBefore[i].size || stat.mtimeMs !== copyStatBefore[i].mtimeMs) {
      copyFilesUntouched = false;
    }
  }
  const copyMetaAfter = await storage.readBookMeta(copyBookPath);
  check(
    '复制本章：章节 txt 与书目的章节记录都没被改写（纯读 + 剪贴板）',
    copyFilesUntouched && JSON.stringify(copyMetaAfter.chapters) === copyChaptersBefore
  );
};
