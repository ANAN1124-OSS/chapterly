// E2E 第 32 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：续「拖拽排序书」（标点扩展）
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。

module.exports = async function group32PunctExtend(t) {
  const { exec, check, waitFor, sleep } = t;

  // 32. 标点扩展：直引号 / 省略号（默认关，勾上才转，预览里给统计）
  await exec("window.__cwTest.setText('他说,\"你好...\"')");
  const punctOptions = {
    indent: '2',
    blankLines: 'keep',
    trimTrailing: true,
    normalizePunct: true,
    curlyQuotes: true,
    ellipsis: true
  };
  await exec('window.__cwTest.openFormatDialog()');
  await exec(`window.__cwTest.writeFormatOptions(${JSON.stringify(punctOptions)})`);
  await exec(
    "document.getElementById('fmt-quotes').dispatchEvent(new Event('change', { bubbles: true }))"
  );
  await waitFor("window.__cwTest.formatSummary().includes('直引号转弯引号')");
  const punctSummary = await exec('window.__cwTest.formatSummary()');
  check(
    '标点扩展：预览统计引号与省略号的转换数',
    punctSummary.includes('直引号转弯引号 2 处') && punctSummary.includes('省略号转中文 1 处'),
    punctSummary
  );
  const punctPreview = await exec('window.__cwTest.formatPreview()');
  check('标点扩展：预览里能看到转换后的引号/省略号', punctPreview.includes('“你好……”'), punctPreview);
  await exec("document.getElementById('btn-format-apply').click()");
  await waitFor('window.__cwTest.formatDialogOpen() === false');
  await sleep(150);
  check(
    '标点扩展：套用后直引号转弯引号、三个点转省略号',
    (await exec('window.__cwTest.text()')) === '　　他说，“你好……”',
    await exec('window.__cwTest.text()')
  );
  check('标点扩展：套用后仍是未保存状态', (await exec('window.__cwTest.dirty()')) === true);
  const cfgWithPunct = await exec('window.api.getConfig().then((r) => (r.ok ? r.data : null))');
  check(
    '标点扩展：两个开关会记住（写进配置）',
    cfgWithPunct.formatOptions.curlyQuotes === true && cfgWithPunct.formatOptions.ellipsis === true,
    cfgWithPunct.formatOptions
  );

  // 默认关：换一段没转过标点的正文，只套默认规则 → 引号/省略号原样
  await exec("window.__cwTest.setText('他说,\"你好...\"')");
  await exec(
    "window.__cwTest.writeFormatOptions({ indent: '0', blankLines: 'keep', trimTrailing: true, normalizePunct: true })"
  );
  await exec('window.__cwTest.applyFormat()');
  check(
    '标点扩展：两项默认关时引号/省略号保持原样',
    (await exec('window.__cwTest.text()')) === '他说，"你好..."',
    await exec('window.__cwTest.text()')
  );
};
