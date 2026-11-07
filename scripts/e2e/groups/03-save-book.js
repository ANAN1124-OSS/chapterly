// E2E 第 3 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 本组在「测试书」上做手动保存整本 + 保存热路径（3b）/ 缺章校验；fs / path 用 node 内建，
// 其余（storage / chaptersLib / diskText …）由场景的 groupContext() 交进来。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group3SaveBook(t) {
  const { chaptersLib, storage, sleep, exec, booksRoot, bookDir, check, waitFor, diskText } = t;

  // 3. 手动保存整本：写当前章 + 校验全书
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await exec("window.__cwTest.setText('风从海面吹来。\\n\\n他收起了帆。')");
  check('输入后变为未保存状态', (await exec('window.__cwTest.dirty()')) === true);
  const saveResult = await exec('window.__cwTest.save()');
  check('保存成功', saveResult && saveResult.ok === true, saveResult);
  check('保存后不再是未保存状态', (await exec('window.__cwTest.dirty()')) === false);
  check(
    '磁盘上的章节内容正确（CRLF 落盘、读回 LF）',
    (await diskText('001-未命名.txt')) === '风从海面吹来。\n\n他收起了帆。'
  );
  const meta1 = await storage.readBookMeta(bookDir);
  check('书目.json 三章顺序正确', JSON.stringify(meta1.chapters.map((c) => c.name)) === JSON.stringify(['起风', '夜雨', '']));

  // 3b. 保存热路径（代码审计 F2）：保存一成功就先出「已保存」提示——章数直接用书目里的
  // 章节数（不再为了拿这个数字 await 一趟全书校验）；全书校验挪到后台，发现缺章才 warn
  // （文案不变），校验本身失败只记日志、不误报。下面用 ?test=1 的提示记录验证时序，
  // 并用 setTestVerifyBook 把后台校验拖慢 / 弄失败来证明「保存真的不等它」。
  await exec('window.__cwTest.clearToasts()');
  // ① 后台校验被拖慢 600ms：保存仍然马上返回，提示已经出了
  await exec(
    "window.__cwTest.setTestVerifyBook(() => new Promise((resolve) => setTimeout(() => resolve({ chapterCount: 3, missing: [] }), 600)))"
  );
  await exec("window.__cwTest.setText('风从海面吹来。\\n\\n他收起了帆。又补一句。')");
  const slowVerifyBody = '风从海面吹来。\n\n他收起了帆。又补一句。';
  const slowSaveStartedAt = Date.now();
  const slowSave = await exec('window.__cwTest.saveVisible()');
  const slowSaveMs = Date.now() - slowSaveStartedAt;
  const toastsRightAway = await exec('window.__cwTest.toasts()');
  check(
    '保存热路径：全书校验被拖慢时保存照样马上返回（保存热路径不再等校验）',
    Boolean(slowSave && slowSave.ok === true) && slowSaveMs < 500,
    { slowSaveMs, slowSave }
  );
  check(
    '保存热路径：保存一完成就出「已保存」提示，章数取书目里的 3 章、文案与以前一致',
    toastsRightAway.some(
      (item) => item.message === `已保存：3 章 · 本章 ${chaptersLib.countChars(slowVerifyBody)} 字`
    ) &&
      !toastsRightAway.some((item) => item.message.includes('全书校验失败')),
    toastsRightAway
  );
  await sleep(800);
  check(
    '保存热路径：后台校验跑完、没有缺章时不会多弹警告',
    !(await exec('window.__cwTest.toasts()')).some((item) => item.message.includes('章节文件缺失'))
  );

  // ② 后台校验失败（书被挪走 / 临时读失败）：保存照常成功，不再误报「全书校验失败」
  await exec('window.__cwTest.clearToasts()');
  await exec("window.__cwTest.setTestVerifyBook(() => Promise.reject(new Error('E2E verify boom')))");
  await exec("window.__cwTest.setText('风从海面吹来。\\n\\n他收起了帆。再补一句。')");
  const failedVerifySave = await exec('window.__cwTest.saveVisible()');
  await sleep(400);
  const failedVerifyToasts = await exec('window.__cwTest.toasts()');
  check(
    '保存热路径：后台校验失败也不影响保存、不误报（不再有「全书校验失败」）',
    Boolean(failedVerifySave && failedVerifySave.ok === true) &&
      failedVerifyToasts.some((item) => item.message.startsWith('已保存：3 章')) &&
      !failedVerifyToasts.some((item) => item.message.includes('全书校验失败')) &&
      !failedVerifyToasts.some((item) => item.kind === 'error'),
    failedVerifyToasts
  );

  // ③ 真有缺章：后台校验发现 1 个缺章才 warn（文案不变），「已保存」提示仍然先出。
  // 章节 txt 先挪到临时书库外面，测完立刻放回去（不生成 _trash、不动书目）。
  await exec('window.__cwTest.setTestVerifyBook(null)');
  await exec('window.__cwTest.clearToasts()');
  const missingHoldDir = path.join(path.dirname(booksRoot), 'e2e-missing-hold');
  await fs.mkdir(missingHoldDir, { recursive: true });
  await fs.rename(path.join(bookDir, '002-夜雨.txt'), path.join(missingHoldDir, '002-夜雨.txt'));
  await exec("window.__cwTest.setText('风从海面吹来。\\n\\n他收起了帆。补第三句。')");
  const missingSave = await exec('window.__cwTest.saveVisible()');
  const missingToasts = await waitFor(
    "window.__cwTest.toasts().some((item) => item.message.includes('章节文件缺失')) ? window.__cwTest.toasts() : null"
  );
  const savedToastIndex = missingToasts.findIndex((item) => item.message.startsWith('已保存：3 章'));
  const missingWarnIndex = missingToasts.findIndex(
    (item) => item.message === '已保存当前章，但全书有 1 个章节文件缺失'
  );
  check(
    '保存热路径：缺章时后台仍会警告（文案不变），且「已保存」提示先出',
    Boolean(missingSave && missingSave.ok === true) &&
      savedToastIndex >= 0 &&
      missingWarnIndex > savedToastIndex,
    missingToasts
  );
  await fs.rename(path.join(missingHoldDir, '002-夜雨.txt'), path.join(bookDir, '002-夜雨.txt'));
  await fs.rm(missingHoldDir, { recursive: true, force: true });

  // ④ 保存时字数没变也照样刷新书目：**不采纳**审计里「chars 没变就跳过 writeBookMeta」那条
  //    —— writeBookMeta 同时刷新 updatedAt，跳过会冻结书架的「最后修改」时间。
  const metaRawBefore = JSON.parse(await fs.readFile(path.join(bookDir, '书目.json'), 'utf8'));
  // 与上一版同为 18 字（只换语序），字数缓存不变
  await exec("window.__cwTest.setText('他收起了帆。\\n\\n风从海面吹来。补第三句。')");
  await exec('window.__cwTest.save()');
  const metaRawAfter = JSON.parse(await fs.readFile(path.join(bookDir, '书目.json'), 'utf8'));
  check(
    '保存热路径：字数没变的保存照样刷新书目 updatedAt（书架「最后修改」不会冻结）',
    metaRawAfter.chapters[0].chars === metaRawBefore.chapters[0].chars &&
      metaRawAfter.updatedAt !== metaRawBefore.updatedAt,
    {
      chars: [metaRawBefore.chapters[0].chars, metaRawAfter.chapters[0].chars],
      updatedAt: [metaRawBefore.updatedAt, metaRawAfter.updatedAt]
    }
  );

  // 收尾：把第 1 章恢复成第 3 组断言时的正文（后面的组还要接着用这本书）
  await exec("window.__cwTest.setText('风从海面吹来。\\n\\n他收起了帆。')");
  await exec('window.__cwTest.save()');
  await fs.access(path.join(bookDir, '002-夜雨.txt'));
  check(
    '保存热路径：收尾恢复第 3 组正文、缺章文件已放回（校验全程只读）',
    (await diskText('001-未命名.txt')) === '风从海面吹来。\n\n他收起了帆。' &&
      (await exec('window.__cwTest.dirty()')) === false
  );
  await exec('window.__cwTest.setTestVerifyBook(null)');
};
