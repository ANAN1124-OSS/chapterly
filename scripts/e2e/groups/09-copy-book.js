// E2E 第 9 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：续「测试书」（复制整本 + 9b/9c）
// 唯一适配：原来就地取 core/exporter 的 composeBook，组文件不 require 产品代码，改成用 t.exporter（同一个函数）。
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。

module.exports = async function group9CopyBook(t) {
  const { exec, check, clipboard, storage, bookDir, diskText, exporter } = t;

  // 9. 复制整本：内容 = 导出拼接格式（标题行 + 空行 + 正文）
  await exec("window.__cwTest.switchTo(0, 'discard')");
  const copyRes = await exec(`window.api.copyBook(${JSON.stringify(bookDir)})`);
  check('复制整本接口成功', copyRes && copyRes.ok === true, copyRes);
  const metaNow = await storage.readBookMeta(bookDir);
  const texts = [];
  for (const chapter of metaNow.chapters) {
    texts.push((await storage.loadChapterText(bookDir, chapter.file)).text);
  }
  const expected = exporter.composeBook(metaNow, texts);
  // 注意：新版 Electron 的 clipboard 是异步 API，两个版本都兼容地 await 一下
  const clipText = await clipboard.readText();
  check('剪贴板内容与导出格式完全一致', clipText === expected, {
    actual: typeof clipText === 'string' ? clipText.slice(0, 120) : String(clipText)
  });

  // 9b. 导出/复制把编辑区里当前章的未保存内容也带上（只影响输出，绝不偷偷写盘）
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await exec("window.__cwTest.setText('这段还没保存，但导出和复制都必须有')");
  const unsavedText = await exec('window.__cwTest.text()');
  const unsavedId = await exec('window.__cwTest.currentChapterId()');
  const copyUnsaved = await exec(
    `window.api.copyBook(${JSON.stringify(bookDir)}, { chapterId: ${JSON.stringify(unsavedId)}, text: ${JSON.stringify(unsavedText)} })`
  );
  check('复制整本可以用编辑区内容覆盖当前章', Boolean(copyUnsaved && copyUnsaved.ok === true), copyUnsaved);
  check('复制结果标明含未保存内容', copyUnsaved.data && copyUnsaved.data.includedUnsaved === true, copyUnsaved.data);
  check('复制结果回报章数与字数', copyUnsaved.data.chapterCount === 3 && copyUnsaved.data.chars > 0, copyUnsaved.data);
  const clipUnsaved = await clipboard.readText();
  check(
    '未保存的内容出现在复制结果里',
    typeof clipUnsaved === 'string' && clipUnsaved.includes('这段还没保存，但导出和复制都必须有'),
    typeof clipUnsaved === 'string' ? clipUnsaved.slice(0, 120) : String(clipUnsaved)
  );
  check('用编辑区覆盖后磁盘仍是旧内容（没有偷偷保存）', (await diskText('001-未命名.txt')) === '风从海面吹来。\n\n他收起了帆。');
  check('复制后当前章仍是未保存状态', (await exec('window.__cwTest.dirty()')) === true);

  // 9c. 章节 id 对不上时退回磁盘内容（避免误把别的章覆盖成当前章）
  const copyBadOverride = await exec(
    `window.api.copyBook(${JSON.stringify(bookDir)}, { chapterId: 'ch_not_exist', text: '不该出现在结果里' })`
  );
  check('覆盖匹配不到时仍能复制', Boolean(copyBadOverride && copyBadOverride.ok === true), copyBadOverride);
  check('匹配不到时不标记含未保存内容', copyBadOverride.data && copyBadOverride.data.includedUnsaved === false, copyBadOverride.data);
  const clipBad = await clipboard.readText();
  check(
    '匹配不到时不会把内容硬塞进结果',
    typeof clipBad === 'string' && !clipBad.includes('不该出现在结果里'),
    typeof clipBad === 'string' ? clipBad.slice(0, 120) : String(clipBad)
  );
};
