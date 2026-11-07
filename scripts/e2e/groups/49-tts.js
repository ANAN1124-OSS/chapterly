// E2E 第 49 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：回书架 → 新建「朗读测试书」；49h 用组 47 旧书
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group49Tts(t) {
  const { exec, check, waitFor, storage, fileExists, state } = t;
  const { fragLegacyBookPath } = t.state;

  // 49. 朗读本章（v0.7-3，提案 5.3）：系统语音只读正文、不改字、不写盘。
  // E2E 换假语音引擎（ttsInstallFakeSpeech），不依赖机器装没装语音，也不会真的出声。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec("window.__cwTest.newBook('朗读测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const ttsBookPath = await exec('window.__cwTest.bookPathValue()');
  await exec("window.__cwTest.renameChapterAt(0, '起风')");
  const ttsChapterOne =
    '　　雨停的时候，灯塔的光扫过海面。\n\n　　看守人把旧钟擦了一遍。\n\n　　“你听见了吗？”他问。\n\n　　远处只有浪声。';
  await exec(`window.__cwTest.setText(${JSON.stringify(ttsChapterOne)})`);
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");
  await exec("window.__cwTest.newChapter('夜雨')");
  await waitFor("window.__cwTest.currentTitle().includes('夜雨')");
  await exec(`window.__cwTest.setText('　　夜里的雨点敲在铁皮屋顶上。\\n\\n　　他翻到最后一页。')`);
  await exec('window.__cwTest.save()');
  await waitFor("window.__cwTest.dirty() === false");
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await waitFor("window.__cwTest.currentTitle().includes('起风')");

  const ttsMetaBefore = await storage.readBookMeta(ttsBookPath);
  const ttsChaptersBefore = JSON.stringify(ttsMetaBefore.chapters);
  const ttsStatsBefore = [];
  for (const chapter of ttsMetaBefore.chapters) {
    const stat = await fs.stat(path.join(ttsBookPath, chapter.file));
    ttsStatsBefore.push({ file: chapter.file, size: stat.size, mtimeMs: stat.mtimeMs });
  }

  check(
    '朗读：写作页顶栏有「朗读」按钮',
    (await exec("document.getElementById('btn-tts').textContent")) === '朗读'
  );
  check(
    '朗读：Electron 里有系统语音接口（真机窗口不需要额外依赖）',
    (await exec('window.__cwTest.ttsSupported()')) === true
  );

  await exec('window.__cwTest.ttsInstallFakeSpeech()');
  await exec("document.getElementById('btn-tts').click()");
  await waitFor('window.__cwTest.ttsBarOpen() === true');
  await waitFor('window.__cwTest.ttsChunks().length > 0');
  // 视觉拍板 #7（2026-11-04）：朗读条同一行里按钮（.btn.tiny 原来 24px）与下拉（.text-input
  // 原来 32px）参差，统一到 28px；× 关闭按钮是图标键，仍留 24px。
  const ttsControlHeights = await exec(`(() => {
    const ids = ['btn-tts-play', 'btn-tts-stop', 'btn-tts-prev', 'btn-tts-next', 'tts-rate', 'tts-voice'];
    const heights = {};
    for (const id of ids) {
      const rect = document.getElementById(id).getBoundingClientRect();
      heights[id] = { h: Math.round(rect.height * 100) / 100, top: Math.round(rect.top) };
    }
    const closeRect = document.getElementById('btn-tts-close').getBoundingClientRect();
    return { heights, closeH: Math.round(closeRect.height * 100) / 100 };
  })()`);
  check(
    '朗读（拍板 #7）：朗读条同一行的 4 个按钮 + 语速 / 语音下拉统一 28px 高（× 关闭按钮仍 24px）',
    ['btn-tts-play', 'btn-tts-stop', 'btn-tts-prev', 'btn-tts-next', 'tts-rate', 'tts-voice'].every(
      (id) => Math.abs(ttsControlHeights.heights[id].h - 28) <= 0.5
    ) && Math.abs(ttsControlHeights.closeH - 24) <= 0.5,
    ttsControlHeights
  );
  // 视觉拍板 #6（2026-11-04）：toast 抬起量改成「朗读条实际高度 + 52」（44 条底距 + 8 间隙），
  // 由渲染层写进 body 的 --tts-toast-lift；CSS 只用 var(..., 184px) 兜底，不再写死 184。
  const ttsToastLift = await exec(`(() => {
    const bar = document.getElementById('tts-bar');
    const area = document.getElementById('toast-area');
    return {
      barH: Math.round(bar.getBoundingClientRect().height),
      liftVar: getComputedStyle(document.body).getPropertyValue('--tts-toast-lift').trim(),
      areaBottom: getComputedStyle(area).bottom
    };
  })()`);
  check(
    '朗读（拍板 #6）：toast 抬起量 = 朗读条实际高度 + 52px（写进 --tts-toast-lift，不再是写死的 184px）',
    ttsToastLift.liftVar === `${ttsToastLift.barH + 52}px` &&
      Math.abs(parseFloat(ttsToastLift.areaBottom) - (ttsToastLift.barH + 52)) <= 1,
    ttsToastLift
  );
  const ttsChunks = await exec('window.__cwTest.ttsChunks()');
  check(
    '朗读：按自然段切分（4 段、位置与编辑区一致、首尾空白不进朗读）',
    ttsChunks.length === 4 &&
      ttsChunks.every((chunk) => ttsChapterOne.slice(chunk.start, chunk.end) === chunk.text) &&
      ttsChunks[0].text === '雨停的时候，灯塔的光扫过海面。' &&
      ttsChunks[1].paragraph === 2 &&
      ttsChunks[3].text === '远处只有浪声。',
    ttsChunks
  );
  const ttsFirstSpeech = await exec('window.__cwTest.ttsFakeState()');
  check(
    '朗读：打开后从第一段开始念（刚载入时光标在全文末尾，按从头念）',
    (await exec('window.__cwTest.ttsIndex()')) === 0 &&
      ttsFirstSpeech.last &&
      ttsFirstSpeech.last.text === ttsChunks[0].text &&
      (await exec('window.__cwTest.ttsStatus()')) === 'playing' &&
      (await exec('window.__cwTest.ttsStatusText()')).includes('正在朗读 第 1/4 段'),
    ttsFirstSpeech
  );
  check(
    '朗读：小条显示当前段落预览（只显示文字，不改正文）',
    (await exec('window.__cwTest.ttsPreviewText()')).includes('雨停的时候') &&
      (await exec('window.__cwTest.ttsPreviewTitle()')) === ttsChunks[0].text
  );

  // 49b. 一段读完自动接下一段；暂停 / 继续；上一段 / 下一段；语速 / 语音；跟随高亮
  await exec('window.__cwTest.ttsFakeFinish()');
  await waitFor('window.__cwTest.ttsIndex() === 1');
  const ttsSecondSpeech = await exec('window.__cwTest.ttsFakeState()');
  check(
    '朗读：一段读完自动接下一段',
    ttsSecondSpeech.last.text === ttsChunks[1].text &&
      (await exec('window.__cwTest.ttsStatusText()')).includes('第 2/4 段')
  );
  await exec("document.getElementById('btn-tts-play').click()");
  await waitFor("window.__cwTest.ttsStatus() === 'paused'");
  check(
    '朗读：暂停（引擎暂停、按钮变回「播放」、状态显示已暂停）',
    (await exec('window.__cwTest.ttsFakeState()')).paused === true &&
      (await exec('window.__cwTest.ttsPlayLabel()')) === '▶ 播放' &&
      (await exec('window.__cwTest.ttsStatusText()')).includes('已暂停')
  );
  await exec("document.getElementById('btn-tts-play').click()");
  await waitFor("window.__cwTest.ttsStatus() === 'playing'");
  check(
    '朗读：继续（引擎 resume、按钮变回「暂停」）',
    (await exec('window.__cwTest.ttsFakeState()')).paused === false &&
      (await exec('window.__cwTest.ttsPlayLabel()')) === '⏸ 暂停'
  );
  await exec("document.getElementById('btn-tts-next').click()");
  await waitFor('window.__cwTest.ttsIndex() === 2');
  check(
    '朗读：下一段按钮跳段并继续念',
    (await exec('window.__cwTest.ttsFakeState()')).last.text === ttsChunks[2].text
  );
  await exec("document.getElementById('btn-tts-prev').click()");
  await waitFor('window.__cwTest.ttsIndex() === 1');
  check(
    '朗读：上一段按钮跳回上一段',
    (await exec('window.__cwTest.ttsFakeState()')).last.text === ttsChunks[1].text
  );
  await exec(
    "(() => { const el = document.getElementById('tts-rate'); el.value = '1.5'; el.dispatchEvent(new Event('change', { bubbles: true })); })()"
  );
  await waitFor('window.__cwTest.ttsRate() === 1.5');
  check(
    '朗读：语速改变后当前段用新语速重念',
    (await exec('window.__cwTest.ttsFakeState()')).last.rate === 1.5
  );
  const ttsVoiceOptions = await exec('window.__cwTest.ttsVoiceOptions()');
  check(
    '朗读：语音下拉列出系统语音（默认 + 各语音）',
    ttsVoiceOptions[0] === '系统默认' && ttsVoiceOptions.some((text) => text.includes('测试语音 A'))
  );
  await exec(
    "(() => { const el = document.getElementById('tts-voice'); el.value = 'fake-voice-b'; el.dispatchEvent(new Event('change', { bubbles: true })); })()"
  );
  await waitFor("window.__cwTest.ttsVoice() === 'fake-voice-b'");
  check(
    '朗读：换语音后按所选语音重念',
    (await exec('window.__cwTest.ttsFakeState()')).last.voiceURI === 'fake-voice-b'
  );
  await exec("document.getElementById('tts-follow').click();");
  await waitFor('window.__cwTest.ttsFollowState() === true');
  check(
    '朗读：开启跟随高亮会选中当前段落（只改选区，不改文字）',
    (await exec('window.__cwTest.selectionText()')) === ttsChunks[1].text &&
      (await exec('window.__cwTest.text()')) === ttsChapterOne &&
      (await exec('window.__cwTest.dirty()')) === false
  );
  await exec('window.__cwTest.ttsFakeFinish()');
  await waitFor('window.__cwTest.ttsIndex() === 2');
  check(
    '朗读：跟随高亮随朗读推进到下一段',
    (await exec('window.__cwTest.selectionText()')) === ttsChunks[2].text
  );

  // 49c. 停止 / 再播放 / 出错提示
  await exec("document.getElementById('btn-tts-stop').click()");
  await waitFor("window.__cwTest.ttsStatus() === 'idle'");
  check(
    '朗读：停止后不再念（引擎取消、状态「已停止」）',
    (await exec('window.__cwTest.ttsFakeState()')).hasPending === false &&
      (await exec('window.__cwTest.ttsStatusText()')).includes('已停止')
  );
  await exec("document.getElementById('btn-tts-play').click()");
  await waitFor("window.__cwTest.ttsStatus() === 'playing'");
  check(
    '朗读：停止后再点播放从当前段继续',
    (await exec('window.__cwTest.ttsFakeState()')).last.text === ttsChunks[2].text
  );
  await exec('window.__cwTest.ttsFakeError()');
  await waitFor('window.__cwTest.ttsStatusError() === true');
  check(
    '朗读：系统语音报错时有明确的中文提示',
    (await exec('window.__cwTest.ttsStatus()')) === 'error' &&
      (await exec('window.__cwTest.ttsStatusText()')).includes('系统语音出错')
  );

  // 49d. 从光标处开始念；Esc 停止并收起
  await exec('window.__cwTest.ttsClose()');
  await waitFor('window.__cwTest.ttsBarOpen() === false');
  await exec('window.__cwTest.ttsInstallFakeSpeech()');
  await exec(`window.__cwTest.ttsSetCaret(${Number(ttsChunks[3].start)})`);
  await exec("document.getElementById('btn-tts').click()");
  await waitFor('window.__cwTest.ttsBarOpen() === true');
  await waitFor("window.__cwTest.ttsStatus() === 'playing'");
  check(
    '朗读：从光标所在段落开始念（不是永远从头念）',
    (await exec('window.__cwTest.ttsIndex()')) === 3 &&
      (await exec('window.__cwTest.ttsFakeState()')).last.text === ttsChunks[3].text
  );
  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor('window.__cwTest.ttsBarOpen() === false');
  check(
    '朗读：Esc 停止并收起朗读条',
    (await exec('window.__cwTest.ttsStatus()')) === 'idle'
  );

  // 49e. 编辑正文会立刻停止朗读（避免拿旧段落继续念）
  await exec('window.__cwTest.ttsInstallFakeSpeech()');
  await exec("document.getElementById('btn-tts').click()");
  await waitFor('window.__cwTest.ttsBarOpen() === true');
  await waitFor("window.__cwTest.ttsStatus() === 'playing'");
  await exec(`window.__cwTest.setText(${JSON.stringify('　　改了一个字。')})`);
  await waitFor('window.__cwTest.ttsBarOpen() === false');
  check(
    '朗读：编辑正文会立刻停止并收起朗读条（不拿旧段落继续念）',
    (await exec('window.__cwTest.ttsStatus()')) === 'idle' &&
      (await exec('window.__cwTest.dirty()')) === true &&
      (await exec('window.__cwTest.ttsFakeState()')).hasPending === false
  );
  await exec("window.__cwTest.switchTo(1, 'discard')");
  await waitFor("window.__cwTest.currentTitle().includes('夜雨')");
  await exec('window.__cwTest.switchTo(0)');
  await waitFor(`window.__cwTest.text() === ${JSON.stringify(ttsChapterOne)}`);

  // 49f. 全程只读：txt 大小 + mtime、书目 chapters、无 _trash 都没变
  const ttsStatsAfter = [];
  for (const item of ttsStatsBefore) {
    const stat = await fs.stat(path.join(ttsBookPath, item.file));
    ttsStatsAfter.push({ file: item.file, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  check(
    '朗读：全程只读正文（txt 大小+mtime、书目 chapters、无 _trash 都没变）',
    JSON.stringify(ttsStatsAfter) === JSON.stringify(ttsStatsBefore) &&
      JSON.stringify((await storage.readBookMeta(ttsBookPath)).chapters) === ttsChaptersBefore &&
      !(await fileExists(path.join(ttsBookPath, '_trash')))
  );

  // 49g. 切章停止；空章节有明确提示
  await exec('window.__cwTest.ttsInstallFakeSpeech()');
  await exec("document.getElementById('btn-tts').click()");
  await waitFor("window.__cwTest.ttsStatus() === 'playing'");
  await exec("window.__cwTest.switchTo(1)");
  await waitFor("window.__cwTest.currentTitle().includes('夜雨')");
  check(
    '朗读：切章会停止朗读并收起小条',
    (await exec('window.__cwTest.ttsBarOpen()')) === false &&
      (await exec('window.__cwTest.ttsStatus()')) === 'idle'
  );
  await exec("window.__cwTest.newChapter('空章')");
  await waitFor("window.__cwTest.currentTitle().includes('空章')");
  await exec('window.__cwTest.ttsInstallFakeSpeech()');
  await exec("document.getElementById('btn-tts').click()");
  await waitFor('window.__cwTest.ttsBarOpen() === true');
  await waitFor("window.__cwTest.ttsStatus() === 'error'");
  check(
    '朗读：空章节明确提示「没有可朗读的正文」，不会开始念',
    (await exec('window.__cwTest.ttsStatusText()')).includes('没有可朗读的正文') &&
      (await exec('window.__cwTest.ttsFakeState()')).spoken.length === 0
  );
  await exec('window.__cwTest.ttsClose()');

  // 49h. 旧数据兼容：v0.4.1 形状的书（没有 schemaVersion）照常朗读，书目不被补字段
  const ttsLegacyMetaPath = path.join(fragLegacyBookPath, '书目.json');
  state.ttsLegacyMetaPath = ttsLegacyMetaPath; // 第 50 组「旧数据兼容」核对同一份书目
  const ttsLegacyBefore = await fs.readFile(ttsLegacyMetaPath, 'utf8');
  await exec('window.__cwTest.backToShelf()');
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(fragLegacyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec('window.__cwTest.ttsInstallFakeSpeech()');
  await exec("document.getElementById('btn-tts').click()");
  await waitFor('window.__cwTest.ttsBarOpen() === true');
  await waitFor("window.__cwTest.ttsStatus() === 'playing'");
  const ttsLegacyChunks = await exec('window.__cwTest.ttsChunks()');
  const ttsLegacyAfter = await fs.readFile(ttsLegacyMetaPath, 'utf8');
  check(
    '朗读：没有 schemaVersion 的旧书照常朗读，书目不被补字段',
    ttsLegacyChunks.length > 0 &&
      ttsLegacyAfter === ttsLegacyBefore &&
      ttsLegacyAfter.includes('"schemaVersion"') === false
  );
  await exec('window.__cwTest.ttsClose()');
};
