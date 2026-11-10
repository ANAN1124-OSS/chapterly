// E2E 第 44 组：从 scripts/e2e-scenario.js 原样搬出来（第 0–51 组拆组，断言一条都没改），
// 由 scripts/e2e/groups/index.js 按顺序执行；t = 场景上下文 + scripts/e2e/harness.js 的公共工具。
// 会话状态：续组 42「历史面板测试书」当主体书 + 新建其它书（统计 / 日历 / 阅读 / 模板）
// 组内局部变量不进别的文件；要交给后面组的值由场景的 state 袋子传递（见 e2e-scenario.js 文件头）。
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function group44StatsGoal(t) {
  const {
    exec,
    check,
    waitFor,
    sleep,
    storage,
    userData,
    booksRoot,
    fileExists,
    chaptersLib,
    statsLib,
    statsSeedLib
  } = t;
  const { historyBookPath } = t.state;

  // 44. 每日字数统计 + 写作目标（v0.6-3，提案 3.2）
  // 只统计「保存动作」带来的正字数增量；统计文件在 userData/stats.json，绝不写进书库；
  // 目标可选（0 = 不设目标），旧配置缺字段按默认 0。
  const statsPath = path.join(userData, 'stats.json');
  const readStatsDisk = async () => {
    try {
      return JSON.parse(await fs.readFile(statsPath, 'utf8'));
    } catch {
      return null;
    }
  };
  const readConfigDisk = async () => JSON.parse(await fs.readFile(path.join(userData, 'config.json'), 'utf8'));

  const statsConfigBefore = await exec('window.api.getConfig()');
  check(
    '每日统计：旧配置没有 dailyGoal 时按不设目标启动',
    statsConfigBefore && statsConfigBefore.ok && statsConfigBefore.data.dailyGoal === 0,
    statsConfigBefore && statsConfigBefore.data && statsConfigBefore.data.dailyGoal
  );

  const statsInitial = await exec('window.__cwTest.refreshStats()');
  check(
    '每日统计：摘要是今天 + 近 30 天，未设目标时 0%',
    statsInitial &&
      statsInitial.day === statsLib.localDayKey() &&
      statsInitial.goal === 0 &&
      statsInitial.goalPercent === 0 &&
      statsInitial.goalMet === false &&
      statsInitial.days.length === 30 &&
      statsInitial.days[29].day === statsInitial.day,
    statsInitial && {
      day: statsInitial.day,
      goal: statsInitial.goal,
      days: statsInitial.days && statsInitial.days.length
    }
  );
  const statsTodayBefore = statsInitial.todayChars;
  const statsMeta = await storage.readBookMeta(historyBookPath);
  const statsCurrentId = await exec('window.__cwTest.currentChapterId()');
  const statsChapter = statsMeta.chapters.find((chapter) => chapter.id === statsCurrentId);
  check('每日统计：当前章在书目里（用于算增量）', Boolean(statsChapter), statsCurrentId);
  const statsDiskBefore = await readStatsDisk();
  const statsBookBefore =
    statsDiskBefore && statsDiskBefore.days && statsDiskBefore.days[statsInitial.day]
      ? statsDiskBefore.days[statsInitial.day].books[statsMeta.id] || 0
      : 0;

  const statsBaseText = (await storage.loadChapterText(historyBookPath, statsChapter.file)).text;
  const statsAppend1 = '第一次增加五字';
  await exec(`window.__cwTest.setText(${JSON.stringify(statsBaseText + statsAppend1)})`);
  const statsAfterTyping = await exec('window.__cwTest.refreshStats()');
  check(
    '每日统计：未保存的输入不计入今天',
    statsAfterTyping.todayChars === statsTodayBefore,
    { before: statsTodayBefore, after: statsAfterTyping.todayChars }
  );
  const statsSave1 = await exec('window.__cwTest.save()');
  const statsDelta1 = chaptersLib.countChars(statsAppend1);
  check(
    '每日统计：保存后按正字数增量累计',
    statsSave1 &&
      statsSave1.ok &&
      statsSave1.data.statsDelta === statsDelta1 &&
      statsSave1.data.stats.todayChars === statsTodayBefore + statsDelta1,
    statsSave1 && statsSave1.data && { delta: statsSave1.data.statsDelta, stats: statsSave1.data.stats }
  );
  const statsTodayAfter1 = statsTodayBefore + statsDelta1;
  const statsDisk1 = await readStatsDisk();
  check(
    '每日统计：stats.json 落在应用配置目录，按书分桶',
    statsDisk1 &&
      statsDisk1.version === 1 &&
      statsDisk1.days[statsInitial.day].books[statsMeta.id] === statsBookBefore + statsDelta1,
    statsDisk1 && statsDisk1.days && statsDisk1.days[statsInitial.day]
  );
  check(
    '每日统计：书库/书内不出现 stats.json',
    !(await fileExists(path.join(historyBookPath, 'stats.json'))) &&
      !(await fileExists(path.join(booksRoot, 'stats.json')))
  );

  // 44a. 删字不倒扣；删完再写只累计这次新增
  await exec("window.__cwTest.setText('短')");
  const statsSaveShrink = await exec('window.__cwTest.save()');
  check(
    '每日统计：删字不扣今天进度（增量 0，没有负数）',
    statsSaveShrink &&
      statsSaveShrink.ok &&
      statsSaveShrink.data.statsDelta === 0 &&
      statsSaveShrink.data.stats.todayChars === statsTodayAfter1,
    statsSaveShrink && statsSaveShrink.data && statsSaveShrink.data.stats
  );
  const statsAppend2 = '再写三个字';
  await exec(`window.__cwTest.setText(${JSON.stringify(`短${statsAppend2}`)})`);
  const statsSave2 = await exec('window.__cwTest.save()');
  const statsDelta2 = chaptersLib.countChars(statsAppend2);
  check(
    '每日统计：删后再写只累计这次的新增',
    statsSave2 &&
      statsSave2.ok &&
      statsSave2.data.statsDelta === statsDelta2 &&
      statsSave2.data.stats.todayChars === statsTodayAfter1 + statsDelta2,
    statsSave2 && statsSave2.data && statsSave2.data.stats
  );
  const statsTodayAfter2 = statsTodayAfter1 + statsDelta2;

  // 44b. 书架顶部今日字数 + 设置里的目标和近 30 天柱状图
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const statsShelfText = await exec('window.__cwTest.shelfStatsText()');
  check(
    '每日统计：书架顶部显示今天字数',
    (await exec('window.__cwTest.shelfStatsVisible()')) === true && statsShelfText.includes('今天 +'),
    statsShelfText
  );

  await exec('window.__cwTest.openSettings()');
  check(
    '每日统计：设置里默认 0（不设目标），写作统计可见',
    (await exec('window.__cwTest.dailyGoalSettings()')) === 0 &&
      (await exec('window.__cwTest.statsSettingsVisible()')) === true
  );
  check('每日统计：近 30 天柱状图有 30 根柱子', (await exec('window.__cwTest.statsChartBarCount()')) === 30);
  const statsHeights = await exec('window.__cwTest.statsChartBarHeights()');
  check(
    '每日统计：今天那根柱子有高度，空白天为 0',
    Array.isArray(statsHeights) &&
      statsHeights.length === 30 &&
      parseFloat(statsHeights[29]) > 0 &&
      parseFloat(statsHeights[0]) === 0,
    statsHeights
  );
  const statsChartSummaryBefore = await exec('window.__cwTest.statsChartSummary()');
  check(
    '每日统计：柱状图摘要显示今天/近 30 天/未设目标',
    statsChartSummaryBefore.includes('今天') &&
      statsChartSummaryBefore.includes('近 30 天') &&
      statsChartSummaryBefore.includes('未设目标'),
    statsChartSummaryBefore
  );

  const statsGoal = statsTodayAfter2 + 100;
  await exec(`window.__cwTest.setInput('settings-daily-goal', ${statsGoal})`);
  await exec('window.__cwTest.saveSettings()');
  await waitFor(`window.api.getConfig().then((r) => r.ok && r.data.dailyGoal === ${statsGoal})`);
  const statsCfgDisk = await readConfigDisk();
  check('每日统计：目标真的落进 config.json', statsCfgDisk.dailyGoal === statsGoal, statsCfgDisk.dailyGoal);
  const statsAfterGoal = await exec('window.__cwTest.statsSummary()');
  check(
    '每日统计：目标生效后按今天字数算完成度',
    statsAfterGoal &&
      statsAfterGoal.goal === statsGoal &&
      statsAfterGoal.goalPercent === Math.floor((statsTodayAfter2 / statsGoal) * 100) &&
      statsAfterGoal.goalMet === false,
    statsAfterGoal && { goal: statsAfterGoal.goal, percent: statsAfterGoal.goalPercent }
  );
  const statsShelfGoal = await exec('window.__cwTest.shelfStatsText()');
  check(
    '每日统计：书架显示目标与百分比',
    statsShelfGoal.includes('目标') && statsShelfGoal.includes('%'),
    statsShelfGoal
  );
  const statsShelfWidth = await exec('window.__cwTest.shelfGoalWidth()');
  check('每日统计：书架目标进度条有宽度', parseFloat(statsShelfWidth) > 0, statsShelfWidth);

  await exec('window.__cwTest.openSettings()');
  check(
    '每日统计：重新打开设置回填目标',
    (await exec('window.__cwTest.dailyGoalSettings()')) === statsGoal
  );
  const statsChartSummaryGoal = await exec('window.__cwTest.statsChartSummary()');
  check(
    '每日统计：柱状图摘要带目标',
    statsChartSummaryGoal.includes('目标') && statsChartSummaryGoal.includes('今天'),
    statsChartSummaryGoal
  );
  await exec('window.__cwTest.closeSettings()');

  // 44c. 写作页状态栏显示今日 / 目标 + 细进度条；按书设置里不显示全局统计项
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(historyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  const statsStatusText = await exec('window.__cwTest.statusStatsText()');
  check(
    '每日统计：状态栏显示今日 / 目标',
    (await exec('window.__cwTest.statusStatsVisible()')) === true &&
      statsStatusText.includes('今日') &&
      statsStatusText.includes('/') &&
      statsStatusText.includes('字'),
    statsStatusText
  );
  const statsStatusWidth = await exec('window.__cwTest.statusGoalWidth()');
  check('每日统计：状态栏细进度条有宽度', parseFloat(statsStatusWidth) > 0, statsStatusWidth);
  await exec('window.__cwTest.openSettings()');
  check(
    '每日统计：写作页设置里不显示全局目标/柱状图',
    (await exec('window.__cwTest.statsSettingsVisible()')) === false
  );
  await exec('window.__cwTest.closeSettings()');

  // 44c-1. v0.13 / U-D4：状态栏「今日字数」就是码字日历入口 —— 写作页里点开也走「全局设置」，
  // 按全局默认回填（日历 / 每日目标都是全局项），并且直接定位到日历；取消一个字节都不写。
  const statusCalendarConfigPath = path.join(userData, 'config.json');
  const statusCalendarConfigBefore = await fs.readFile(statusCalendarConfigPath);
  const statusCalendarStatsBefore = await fs.readFile(statsPath);
  await exec("document.getElementById('status-stats').click()");
  await waitFor("window.__cwTest.settingsScope() === 'global' && window.__cwTest.calendarVisible() === true");
  // 定位发生在弹层出现后的同一段同步代码里；再等一次几何条件，防以后把定位挪到异步之后。
  await waitFor(`(() => {
    const field = document.getElementById('settings-calendar-field');
    const scroller = document.querySelector('#settings-backdrop .settings-scroll');
    if (!field || !scroller) return false;
    const a = field.getBoundingClientRect();
    const b = scroller.getBoundingClientRect();
    return a.top < b.bottom && a.bottom > b.top;
  })()`);
  const statusCalendarOpen = await exec(`(() => {
    const field = document.getElementById('settings-calendar-field');
    const scroller = document.querySelector('#settings-backdrop .settings-scroll');
    const a = field.getBoundingClientRect();
    const b = scroller.getBoundingClientRect();
    return {
      scope: window.__cwTest.settingsScope(),
      calendar: window.__cwTest.calendarVisible(),
      cells: window.__cwTest.calendarCellCount(),
      scrollTop: Math.round(scroller.scrollTop),
      intersects: a.top < b.bottom && a.bottom > b.top,
      hint: document.getElementById('settings-scope-hint').textContent
    };
  })()`);
  check(
    '码字日历：状态栏「今日字数」点开全局设置并定位到日历（写作页里也按全局回填）',
    statusCalendarOpen.scope === 'global' &&
      statusCalendarOpen.calendar === true &&
      statusCalendarOpen.cells > 0 &&
      statusCalendarOpen.intersects === true &&
      statusCalendarOpen.scrollTop > 0 &&
      statusCalendarOpen.hint.includes('这里是全局默认设置'),
    statusCalendarOpen
  );
  await exec("document.getElementById('btn-settings-cancel').click()");
  await waitFor("document.getElementById('settings-backdrop').classList.contains('hidden') === true");
  const statusCalendarConfigAfter = await fs.readFile(statusCalendarConfigPath);
  const statusCalendarStatsAfter = await fs.readFile(statsPath);
  check(
    '码字日历：状态栏入口只读——取消后 config.json / stats.json 逐字节没变',
    statusCalendarConfigAfter.equals(statusCalendarConfigBefore) &&
      statusCalendarStatsAfter.equals(statusCalendarStatsBefore),
    {
      configSame: statusCalendarConfigAfter.equals(statusCalendarConfigBefore),
      statsSame: statusCalendarStatsAfter.equals(statusCalendarStatsBefore)
    }
  );

  // 44d. 达标：目标 = 今天 + 1，再写 1 个字 → 已达标 / 100%
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const statsGoalMet = statsTodayAfter2 + 1;
  await exec('window.__cwTest.openSettings()');
  await exec(`window.__cwTest.setInput('settings-daily-goal', ${statsGoalMet})`);
  await exec('window.__cwTest.saveSettings()');
  await waitFor(`window.api.getConfig().then((r) => r.ok && r.data.dailyGoal === ${statsGoalMet})`);
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(historyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  const statsMeta3 = await storage.readBookMeta(historyBookPath);
  const statsCurrentId3 = await exec('window.__cwTest.currentChapterId()');
  const statsChapter3 = statsMeta3.chapters.find((chapter) => chapter.id === statsCurrentId3);
  const statsText3 = (await storage.loadChapterText(historyBookPath, statsChapter3.file)).text;
  await exec(`window.__cwTest.setText(${JSON.stringify(`${statsText3}一`)})`);
  const statsSaveMet = await exec('window.__cwTest.save()');
  check(
    '每日统计：达到目标后标记已达标且进度 100%',
    statsSaveMet &&
      statsSaveMet.ok &&
      statsSaveMet.data.stats.todayChars === statsGoalMet &&
      statsSaveMet.data.stats.goalMet === true &&
      statsSaveMet.data.stats.goalPercent === 100,
    statsSaveMet && statsSaveMet.data && statsSaveMet.data.stats
  );
  check(
    '每日统计：达标后状态栏进度条 100%',
    (await exec('window.__cwTest.statusGoalWidth()')) === '100%',
    await exec('window.__cwTest.statusGoalWidth()')
  );
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const statsShelfMet = await exec('window.__cwTest.shelfStatsText()');
  check('每日统计：书架显示已达标', statsShelfMet.includes('已达标'), statsShelfMet);

  // 44e. 目标设为 0 = 关掉：书架/状态栏不再显示目标，但今天字数保留
  await exec('window.__cwTest.openSettings()');
  await exec("window.__cwTest.setInput('settings-daily-goal', '0')");
  await exec('window.__cwTest.saveSettings()');
  await waitFor('window.api.getConfig().then((r) => r.ok && r.data.dailyGoal === 0)');
  const statsShelfOff = await exec('window.__cwTest.shelfStatsText()');
  check(
    '每日统计：目标设为 0 后书架不再显示目标',
    !statsShelfOff.includes('目标') &&
      (await exec('window.__cwTest.shelfGoalWidth()')) === '0%' &&
      statsShelfOff.includes('今天 +'),
    statsShelfOff
  );
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(historyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  const statsStatusOff = await exec('window.__cwTest.statusStatsText()');
  check(
    '每日统计：目标关掉后状态栏只显示今天字数',
    statsStatusOff.includes('今日') && !statsStatusOff.includes('/'),
    statsStatusOff
  );

  // 44f. 多本书：同一份 stats.json 按书分桶，今天总字数相加
  const statsTodayBeforeBook2 = (await exec('window.__cwTest.statsSummary()')).todayChars;
  await exec("window.__cwTest.newBook('每日统计第二本')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const statsBook2Id = await exec('window.__cwTest.bookId()');
  const statsBook2Text = '第二本书写三个字';
  await exec(`window.__cwTest.setText(${JSON.stringify(statsBook2Text)})`);
  const statsSaveBook2 = await exec('window.__cwTest.save()');
  const statsBook2Chars = chaptersLib.countChars(statsBook2Text);
  check(
    '每日统计：多本书按书分桶、总字数相加',
    statsSaveBook2 &&
      statsSaveBook2.ok &&
      statsSaveBook2.data.stats.todayChars === statsTodayBeforeBook2 + statsBook2Chars,
    statsSaveBook2 && statsSaveBook2.data && statsSaveBook2.data.stats
  );
  const statsDiskBook2 = await readStatsDisk();
  const statsDayBooks = statsDiskBook2.days[statsLib.localDayKey()].books;
  check(
    '每日统计：stats.json 里两本书各自记字数',
    statsDayBooks[statsBook2Id] === statsBook2Chars &&
      statsDayBooks[statsMeta.id] >= statsBookBefore + statsDelta1 + statsDelta2 + 1,
    { book2: statsDayBooks[statsBook2Id], firstBook: statsDayBooks[statsMeta.id] }
  );
  check(
    '每日统计：统计文件只存在 userData（不在书架根目录）',
    (await fileExists(statsPath)) && !(await fileExists(path.join(booksRoot, 'stats.json')))
  );

  // 44g. 统计写盘失败不能阻塞正文保存（临时把 stats.json 换成同名目录，原子 rename 必然失败）
  const statsFailBackup = `${statsPath}.fail-backup`;
  await fs.rename(statsPath, statsFailBackup);
  await fs.mkdir(statsPath);
  let statsFailRestored = false;
  try {
    const statsFailTodayBefore = (await exec('window.__cwTest.statsSummary()')).todayChars;
    const statsFailBookPath = await exec('window.__cwTest.bookPathValue()');
    const statsFailText = '统计写盘失败也要保存正文';
    await exec(`window.__cwTest.setText(${JSON.stringify(statsFailText)})`);
    const statsFailSave = await exec('window.__cwTest.save()');
    check(
      '每日统计：统计写盘失败不阻塞正文保存，只把原因带回来',
      statsFailSave &&
        statsFailSave.ok === true &&
        statsFailSave.data.stats === null &&
        typeof statsFailSave.data.statsError === 'string' &&
        statsFailSave.data.statsError.length > 0,
      statsFailSave && statsFailSave.data && {
        stats: statsFailSave.data.stats,
        statsError: statsFailSave.data.statsError
      }
    );
    const statsFailMeta = await storage.readBookMeta(statsFailBookPath);
    const statsFailChapterId = await exec('window.__cwTest.currentChapterId()');
    const statsFailChapter = statsFailMeta.chapters.find((chapter) => chapter.id === statsFailChapterId);
    check(
      '每日统计：统计失败时正文照常落盘',
      statsFailChapter && (await storage.loadChapterText(statsFailBookPath, statsFailChapter.file)).text === statsFailText,
      statsFailChapter && statsFailChapter.file
    );
    await fs.rm(statsPath, { recursive: true, force: true });
    await fs.rename(statsFailBackup, statsPath);
    statsFailRestored = true;
    const statsRecovered = await exec('window.__cwTest.refreshStats()');
    check(
      '每日统计：统计文件恢复后照常读回，失败的那次不虚增内存数字',
      statsRecovered && statsRecovered.todayChars === statsFailTodayBefore,
      { before: statsFailTodayBefore, after: statsRecovered && statsRecovered.todayChars }
    );
    // 恢复后下一次保存还能继续累计（缓存没有因为失败而前进）
    const statsAfterFailText = (await storage.loadChapterText(statsFailBookPath, statsFailChapter.file)).text + '一';
    await exec(`window.__cwTest.setText(${JSON.stringify(statsAfterFailText)})`);
    const statsAfterFailSave = await exec('window.__cwTest.save()');
    check(
      '每日统计：统计写盘恢复后继续正常累计',
      statsAfterFailSave &&
        statsAfterFailSave.ok &&
        statsAfterFailSave.data.stats &&
        statsAfterFailSave.data.stats.todayChars === statsFailTodayBefore + 1,
      statsAfterFailSave && statsAfterFailSave.data && statsAfterFailSave.data.stats
    );
  } finally {
    if (!statsFailRestored) {
      // 检查中途失败时把临时目录换回真正的 stats.json，避免后续复跑/调试遇到坏状态
      await fs.rm(statsPath, { recursive: true, force: true }).catch(() => {});
      await fs.rename(statsFailBackup, statsPath).catch(() => {});
    }
  }

  // 44h. 码字日历 + 连续写作天数 + 月度汇总（v0.8-1，提案 N1）
  // 跨天数据来自 scripts/e2e-stats-seed.js：启动前已写进临时 userData/stats.json，
  // 种子月 = 两个月前（3 天：120 / 80 / 200 字），昨天 150 字；今天的字数由前面 44 组保存产生。
  const calendarSeed = statsSeedLib.buildSeed();
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await waitFor("window.__cwTest.shelfStreakText().includes('连续')");
  const calendarShelfStreak = await exec('window.__cwTest.shelfStreakText()');
  const statsDiskNow = await readStatsDisk();
  const expectedStreak = statsLib.streak(statsDiskNow, { now: new Date() });
  check(
    '码字日历：书架顶部显示连续写作天数',
    calendarShelfStreak.includes('连续') &&
      calendarShelfStreak.includes(String(expectedStreak.current)) &&
      expectedStreak.best === calendarSeed.bestStreak,
    { shelf: calendarShelfStreak, expectedStreak }
  );
  const statsFileStatBefore = await fs.stat(statsPath);
  await exec('window.__cwTest.openSettings()');
  const calendarStats = await exec('window.__cwTest.statsSummary()');
  const calendarNow = await exec('window.__cwTest.statsCalendar()');
  const streakNow = await exec('window.__cwTest.statsStreak()');
  const todayParts = statsLib.parseDayKey(calendarSeed.todayKey);
  const currentPrefix = `${todayParts.year}-${String(todayParts.month).padStart(2, '0')}-`;
  const sumOfDays = (prefix) =>
    Object.entries(statsDiskNow.days || {})
      .filter(([day]) => day.startsWith(prefix))
      .reduce(
        (sum, [, entry]) =>
          sum + Object.values((entry && entry.books) || {}).reduce((a, n) => a + Math.max(0, Number(n) || 0), 0),
        0
      );
  const countWrittenDays = (prefix) =>
    Object.entries(statsDiskNow.days || {}).filter(
      ([day, entry]) =>
        day.startsWith(prefix) &&
        Object.values((entry && entry.books) || {}).some((n) => Math.max(0, Number(n) || 0) > 0)
    ).length;
  const expectedMonthTotal = sumOfDays(currentPrefix);
  const expectedMonthWrittenDays = countWrittenDays(currentPrefix);
  const calendarTodayCell = calendarNow && calendarNow.days.find((item) => item.day === calendarSeed.todayKey);
  check(
    '码字日历：默认显示本月，今天格子就是今天保存的字数',
    calendarNow &&
      calendarNow.year === todayParts.year &&
      calendarNow.month === todayParts.month &&
      calendarNow.isCurrentMonth === true &&
      calendarNow.today === calendarSeed.todayKey &&
      calendarNow.days.length === statsLib.daysInMonth(todayParts.year, todayParts.month) &&
      calendarTodayCell &&
      calendarTodayCell.chars === calendarStats.todayChars &&
      calendarTodayCell.today === true &&
      calendarTodayCell.future === false,
    calendarNow && { year: calendarNow.year, month: calendarNow.month, todayCell: calendarTodayCell }
  );
  check(
    '码字日历：本月合计 / 写字天数与 stats.json 一致',
    calendarNow.total === expectedMonthTotal && calendarNow.writtenDays === expectedMonthWrittenDays,
    { view: { total: calendarNow.total, writtenDays: calendarNow.writtenDays }, expectedMonthTotal, expectedMonthWrittenDays }
  );
  check(
    '码字日历：连续写作天数来自 stats.json（昨天 + 今天 = 2 天，最长 3 天）',
    streakNow &&
      streakNow.current === expectedStreak.current &&
      streakNow.best === expectedStreak.best &&
      expectedStreak.current === 2 &&
      expectedStreak.best === 3,
    { streakNow, expectedStreak }
  );
  check(
    '码字日历：设置里显示月份标题、当月格子和「今天 / 本月」按钮状态',
    (await exec('window.__cwTest.calendarVisible()')) === true &&
      (await exec('window.__cwTest.calendarLabel()')) === calendarNow.label &&
      (await exec('window.__cwTest.calendarCellCount()')) === calendarNow.days.length &&
      (await exec('window.__cwTest.calendarNextDisabled()')) === true &&
      (await exec('window.__cwTest.calendarTodayDisabled()')) === true &&
      (await exec('window.__cwTest.calendarPrevDisabled()')) === false &&
      (await exec('window.__cwTest.calendarSummaryText()')).includes('本月') &&
      (await exec('window.__cwTest.calendarSummaryText()')).includes('写了') &&
      (await exec('window.__cwTest.calendarStreakText()')).includes('最长') &&
      (await exec('window.__cwTest.calendarStreakText()')).includes('连续'),
    await exec('window.__cwTest.calendarSummaryText()')
  );

  // 44h-1. 设目标 100：翻到种子月验证「每日达标 / 月度达标天数 / 色阶」
  await exec("window.__cwTest.setInput('settings-daily-goal', 100)");
  await exec('window.__cwTest.saveSettings()');
  await waitFor('window.api.getConfig().then((r) => r.ok && r.data.dailyGoal === 100)');
  await exec('window.__cwTest.openSettings()');
  await exec('window.__cwTest.calendarShift(-1)');
  await exec('window.__cwTest.calendarShift(-1)');
  const calendarSeedView = await exec('window.__cwTest.statsCalendar()');
  const calendarSeedLabel = await exec('window.__cwTest.calendarLabel()');
  const calendarSeedSummary = await exec('window.__cwTest.calendarSummaryText()');
  const calendarSeedStreak = await exec('window.__cwTest.calendarStreakText()');
  const seedCells = [];
  for (const item of calendarSeed.seedDays) {
    seedCells.push(await exec(`window.__cwTest.calendarDayInfo(${JSON.stringify(item.day)})`));
  }
  check(
    '码字日历：翻到种子月，月度汇总 / 最高一天正确',
    calendarSeedView &&
      calendarSeedView.year === calendarSeed.seedYear &&
      calendarSeedView.month === calendarSeed.seedMonth &&
      calendarSeedView.label === calendarSeed.seedMonthLabel &&
      calendarSeedView.goal === 100 &&
      calendarSeedView.total === calendarSeed.monthTotal &&
      calendarSeedView.writtenDays === calendarSeed.monthWrittenDays &&
      calendarSeedView.goalDays === 2 &&
      calendarSeedView.average === calendarSeed.monthAverage &&
      calendarSeedView.bestDay &&
      calendarSeedView.bestDay.day === calendarSeed.monthBestDay &&
      calendarSeedView.bestDay.chars === calendarSeed.monthBestChars &&
      calendarSeedView.isCurrentMonth === false,
    calendarSeedView && {
      year: calendarSeedView.year,
      month: calendarSeedView.month,
      total: calendarSeedView.total,
      goalDays: calendarSeedView.goalDays
    }
  );
  check(
    '码字日历：种子月每日格子字数 / 达标 / 色阶正确',
    seedCells.every(
      (cell, index) =>
        cell &&
        cell.chars === calendarSeed.seedDays[index].chars &&
        cell.goalMet === calendarSeed.seedDays[index].chars >= 100 &&
        cell.today === false &&
        cell.future === false
    ) &&
      seedCells[0].level === 4 &&
      seedCells[1].level === 3 &&
      seedCells[2].level === 4,
    seedCells
  );
  check(
    '码字日历：UI 标题 / 月度汇总 / 连续天数跟着翻月更新',
    calendarSeedLabel === calendarSeed.seedMonthLabel &&
      calendarSeedSummary.includes(`${calendarSeed.seedMonth}月`) &&
      calendarSeedSummary.includes(`${calendarSeed.monthTotal} 字`) &&
      calendarSeedSummary.includes(`写了 ${calendarSeed.monthWrittenDays} 天`) &&
      calendarSeedSummary.includes(`日均 ${calendarSeed.monthAverage} 字`) &&
      calendarSeedSummary.includes('达标 2 天') &&
      calendarSeedSummary.includes('最高') &&
      calendarSeedStreak.includes('已连续写作 2 天') &&
      calendarSeedStreak.includes('最长 3 天') &&
      (await exec('window.__cwTest.calendarNextDisabled()')) === false &&
      (await exec('window.__cwTest.calendarTodayDisabled()')) === false,
    { label: calendarSeedLabel, summary: calendarSeedSummary, streak: calendarSeedStreak }
  );

  // 44h-2. 翻回本月 / 不允许翻到未来 / 「本月」按钮；全程只读取 stats.json
  await exec('window.__cwTest.calendarShift(1)');
  await exec('window.__cwTest.calendarShift(1)');
  const calendarBackLabel = await exec('window.__cwTest.calendarLabel()');
  const calendarFutureBlocked = await exec('window.__cwTest.calendarShift(1)');
  await exec('window.__cwTest.calendarShift(-1)');
  await exec('window.__cwTest.calendarGoToday()');
  check(
    '码字日历：翻回本月、不允许翻到未来、「本月」按钮可用',
    calendarBackLabel === calendarNow.label &&
      (await exec('window.__cwTest.calendarNextDisabled()')) === true &&
      calendarFutureBlocked === false &&
      (await exec('window.__cwTest.calendarLabel()')) === calendarNow.label &&
      (await exec('window.__cwTest.calendarTodayDisabled()')) === true,
    { calendarBackLabel, calendarFutureBlocked, label: await exec('window.__cwTest.calendarLabel()') }
  );
  const statsFileStatAfter = await fs.stat(statsPath);
  const statsDiskFinal = await readStatsDisk();
  const configDiskFinal = await readConfigDisk();
  check(
    '码字日历：翻月 / 看日历只读，stats.json 大小与修改时间不变',
    statsFileStatAfter.size === statsFileStatBefore.size && statsFileStatAfter.mtimeMs === statsFileStatBefore.mtimeMs,
    { before: { size: statsFileStatBefore.size, mtimeMs: statsFileStatBefore.mtimeMs }, after: { size: statsFileStatAfter.size, mtimeMs: statsFileStatAfter.mtimeMs } }
  );
  check(
    '码字日历：日历 / 连续天数只现算，不往 stats.json 写缓存字段',
    Object.keys(statsDiskFinal).sort().join('|') === 'days|version' &&
      Object.keys(statsDiskFinal.days).every((day) => Object.keys(statsDiskFinal.days[day]).join('|') === 'books')
  );
  check(
    '码字日历：不新增配置字段（目标仍是既有 dailyGoal）',
    !('calendar' in configDiskFinal) && !('statsCalendar' in configDiskFinal) && !('streak' in configDiskFinal)
  );

  // 44h-3. 收尾：目标改回 0；写作页按书设置里不显示全局日历
  await exec("window.__cwTest.setInput('settings-daily-goal', '0')");
  await exec('window.__cwTest.saveSettings()');
  await waitFor('window.api.getConfig().then((r) => r.ok && r.data.dailyGoal === 0)');
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(historyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec('window.__cwTest.openSettings()');
  check(
    '码字日历：写作页按书设置里不显示（全局统计）',
    (await exec('window.__cwTest.calendarVisible()')) === false
  );
  await exec('window.__cwTest.closeSettings()');

  // 44i. 写作时长统计（v0.8-2，提案 N2）：可选、默认关；只记时长不记内容
  // 只写临时 userData 的 stats.json / config.json；书库 / 书目 / 章节 txt 不受影响。
  const writeTimerDay = statsLib.localDayKey();
  const waitForStatsSeconds = async (atLeast, timeout = 8000) => {
    const startedAt = Date.now();
    for (;;) {
      const disk = await readStatsDisk();
      const seconds = statsLib.daySeconds(disk, writeTimerDay);
      if (seconds >= atLeast) return { disk, seconds };
      if (Date.now() - startedAt > timeout) {
        throw new Error(`等待写作时长落盘超时：${seconds} < ${atLeast}`);
      }
      await sleep(120);
    }
  };
  const writeTimerConfigBefore = await readConfigDisk();
  const writeTimerStatsBefore = await readStatsDisk();
  check(
    '写作时长：默认关（config 里没有开启；旧 stats 没有 seconds）',
    writeTimerConfigBefore.writeDurationEnabled !== true &&
      (await exec('window.api.getConfig().then((r) => r.ok && r.data.writeDurationEnabled === false)')) === true &&
      statsLib.daySeconds(writeTimerStatsBefore, writeTimerDay) === 0
  );
  check(
    '写作时长：默认关时写作页不显示计时按钮',
    (await exec('window.__cwTest.timerVisible()')) === false &&
      (await exec('window.__cwTest.timerStart()')) === false
  );

  // 44i-1. 设置里开启（全局设置：要在书架页打开）；开关落进 config.json
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec('window.__cwTest.openSettings()');
  check(
    '写作时长：设置里有开关，默认未勾选且按书设置里不显示',
    (await exec('window.__cwTest.durationSettingsVisible()')) === true &&
      (await exec('window.__cwTest.durationSettingsChecked()')) === false &&
      (await exec('window.__cwTest.durationSettingsSummary()')).includes('未开启')
  );
  await exec("window.__cwTest.setCheck('settings-write-duration', true)");
  await exec('window.__cwTest.saveSettings()');
  await waitFor('window.api.getConfig().then((r) => r.ok && r.data.writeDurationEnabled === true)');
  const writeTimerConfigOn = await readConfigDisk();
  check(
    '写作时长：开启后开关真的落进 config.json，只新增 writeDurationEnabled 一个字段',
    writeTimerConfigOn.writeDurationEnabled === true &&
      writeTimerConfigOn.dailyGoal === 0 &&
      JSON.stringify(Object.keys(writeTimerConfigOn).filter((key) => /duration|timer/i.test(key))) ===
        '["writeDurationEnabled"]',
    writeTimerConfigOn
  );
  check('写作时长：书架页不显示计时按钮（只在写作页）', (await exec('window.__cwTest.timerVisible()')) === false);

  // 44i-2. 打开书 → 手动开始 / 暂停：按实际经过的整秒记进 stats.json，不碰字数
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(historyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  const timerBookEntriesBefore = (await fs.readdir(historyBookPath)).sort().join('|');
  check(
    '写作时长：开启后写作页出现计时按钮，默认不走表',
    (await exec('window.__cwTest.timerVisible()')) === true &&
      (await exec('window.__cwTest.timerRunning()')) === false &&
      (await exec('window.__cwTest.timerText()')).includes('写作计时')
  );
  const timerStatsBeforeStart = await readStatsDisk();
  const timerSecondsBeforeStart = statsLib.daySeconds(timerStatsBeforeStart, writeTimerDay);
  const timerCharsBeforeStart = statsLib.dayTotal(timerStatsBeforeStart, writeTimerDay);
  check('写作时长：点开始后进入计时状态', (await exec('window.__cwTest.timerStart()')) === true && (await exec('window.__cwTest.timerRunning()')) === true);
  await sleep(1400);
  await exec('window.__cwTest.timerPause()');
  check(
    '写作时长：暂停后按钮显示已暂停的秒表，本次时长 ≥ 1 秒',
    (await exec('window.__cwTest.timerRunning()')) === false &&
      (await exec('window.__cwTest.timerText()')).includes('已暂停') &&
      (await exec('window.__cwTest.timerSessionSeconds()')) >= 1
  );
  const timerStatsAfterPause = await readStatsDisk();
  const timerSecondsAfterPause = statsLib.daySeconds(timerStatsAfterPause, writeTimerDay);
  check(
    '写作时长：暂停时把整秒写进 stats.json，字数一点没变',
    timerSecondsAfterPause >= timerSecondsBeforeStart + 1 &&
      timerSecondsAfterPause <= timerSecondsBeforeStart + 4 &&
      statsLib.dayTotal(timerStatsAfterPause, writeTimerDay) === timerCharsBeforeStart &&
      Object.keys(timerStatsAfterPause.days[writeTimerDay] || {}).sort().join('|') === 'books|seconds',
    { timerSecondsBeforeStart, timerSecondsAfterPause }
  );

  // 44i-3. 界面 / 统计摘要 / 码字日历都跟着显示时长（只读，不再写盘）
  await exec('window.__cwTest.refreshStats()');
  const timerSummary = await exec('window.__cwTest.statsSummary()');
  check(
    '写作时长：统计摘要带 writeDurationEnabled / todaySeconds，与磁盘一致',
    timerSummary &&
      timerSummary.writeDurationEnabled === true &&
      timerSummary.todaySeconds === timerSecondsAfterPause &&
      (await exec('window.__cwTest.statsChartSummary()')).includes('今日写作') &&
      (await exec('window.__cwTest.durationSettingsSummary()')).includes('今天写作')
  );
  const timerCalendar = await exec('window.__cwTest.statsCalendar()');
  const timerCalendarCell = timerCalendar && timerCalendar.days.find((item) => item.day === writeTimerDay);
  check(
    '写作时长：码字日历今天格子 / 月度汇总带「用时」',
    timerCalendar &&
      timerCalendar.totalSeconds === timerSecondsAfterPause &&
      timerCalendarCell &&
      timerCalendarCell.seconds === timerSecondsAfterPause &&
      (await exec(`window.__cwTest.calendarDayInfo(${JSON.stringify(writeTimerDay)})`)).seconds === timerSecondsAfterPause &&
      (await exec('window.__cwTest.calendarSummaryText()')).includes('用时')
  );

  // 44i-4. 计时中上报（30 秒定时器同一路径）：整秒落盘、零头留在内存，不重复计数
  await exec('window.__cwTest.timerStart()');
  await sleep(1200);
  await exec('window.__cwTest.timerFlush()');
  const timerAfterFlush = await waitForStatsSeconds(timerSecondsAfterPause + 1);
  check(
    '写作时长：计时中上报只加整秒、不足 1 秒留在内存',
    timerAfterFlush.seconds >= timerSecondsAfterPause + 1 &&
      timerAfterFlush.seconds <= timerSecondsAfterPause + 3 &&
      (await exec('window.__cwTest.timerUnsentSeconds()')) <= 1 &&
      (await exec('window.__cwTest.timerRunning()')) === true
  );
  await exec('window.__cwTest.timerPause()');

  // 44i-5. 离开写作页自动停表并上报；回写作页从 0 开始、不会自己走表
  await exec('window.__cwTest.timerStart()');
  await sleep(1300);
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  const timerAfterLeave = await waitForStatsSeconds(timerAfterFlush.seconds + 1);
  check(
    '写作时长：回书架自动停表，并把没上报的整秒记下',
    timerAfterLeave.seconds >= timerAfterFlush.seconds + 1 &&
      (await exec('window.__cwTest.timerRunning()')) === false &&
      (await exec('window.__cwTest.timerVisible()')) === false
  );
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(historyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  check(
    '写作时长：重新打开书后秒表从 0 开始，不会自己计时',
    (await exec('window.__cwTest.timerVisible()')) === true &&
      (await exec('window.__cwTest.timerRunning()')) === false &&
      (await exec('window.__cwTest.timerSessionSeconds()')) === 0 &&
      (await exec('window.__cwTest.timerText()')) === '写作计时'
  );
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");

  // 44i-6. 关掉开关：主进程不再接收时长；写作页按钮消失，历史秒数保留
  await exec('window.__cwTest.openSettings()');
  await exec("window.__cwTest.setCheck('settings-write-duration', false)");
  await exec('window.__cwTest.saveSettings()');
  await waitFor('window.api.getConfig().then((r) => r.ok && r.data.writeDurationEnabled === false)');
  const timerGateBeforeStat = await fs.stat(statsPath);
  const timerGateBefore = await readStatsDisk();
  const timerGateResult = await exec('window.api.addStatsDuration({ seconds: 300 })');
  await sleep(200);
  const timerGateAfterStat = await fs.stat(statsPath);
  const timerGateAfter = await readStatsDisk();
  check(
    '写作时长：关掉后主进程直接忽略上报，stats.json 一个字节都不动',
    timerGateResult &&
      timerGateResult.ok === true &&
      timerGateResult.data.recorded === 0 &&
      timerGateResult.data.disabled === true &&
      timerGateAfterStat.size === timerGateBeforeStat.size &&
      timerGateAfterStat.mtimeMs === timerGateBeforeStat.mtimeMs &&
      JSON.stringify(timerGateAfter) === JSON.stringify(timerGateBefore)
  );
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(historyBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  const timerOffStatBefore = await fs.stat(statsPath);
  await sleep(1200);
  const timerOffStatAfter = await fs.stat(statsPath);
  check(
    '写作时长：关掉后写作页不再显示按钮、也开不了计时（历史时长仍保留）',
    (await exec('window.__cwTest.timerVisible()')) === false &&
      (await exec('window.__cwTest.timerStart()')) === false &&
      timerOffStatAfter.size === timerOffStatBefore.size &&
      timerOffStatAfter.mtimeMs === timerOffStatBefore.mtimeMs &&
      statsLib.daySeconds(await readStatsDisk(), writeTimerDay) === timerAfterLeave.seconds
  );

  // 44i-7. 只写 userData、兼容旧数据：书库没有 stats.json / 临时文件 / 新备份目录
  const timerUserDataEntries = await fs.readdir(userData);
  const timerBookEntriesAfter = (await fs.readdir(historyBookPath)).sort().join('|');
  check(
    '写作时长：只写 userData/stats.json，书内目录一个文件都没多',
    !timerUserDataEntries.some((name) => name.includes('.tmp-')) &&
      (await fileExists(statsPath)) &&
      !(await fileExists(path.join(historyBookPath, 'stats.json'))) &&
      !(await fileExists(path.join(booksRoot, 'stats.json'))) &&
      timerBookEntriesAfter === timerBookEntriesBefore,
    { before: timerBookEntriesBefore, after: timerBookEntriesAfter }
  );
  const timerDiskFinal = await readStatsDisk();
  const timerSeedMonthView = statsLib.monthView(timerDiskFinal, {
    year: calendarSeed.seedYear,
    month: calendarSeed.seedMonth,
    now: new Date()
  });
  check(
    '写作时长：旧统计（没有 seconds 的种子天）照常读，时长按 0 处理',
    timerSeedMonthView.totalSeconds === 0 &&
      timerSeedMonthView.days.every((item) => item.seconds === 0) &&
      calendarSeed.seedDays.every(
        (item) => Object.keys(timerDiskFinal.days[item.day] || {}).join('|') === 'books'
      ) &&
      Object.keys(timerDiskFinal).sort().join('|') === 'days|version'
  );

  // 44j. 书卡作者 / 简介 + 书架分组 / 标签（v0.8-3，提案 N3）
  // 只写 书目.json 的可选字段；分组只是书架视图，不动书文件夹 / 章节 txt。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  check(
    '书籍信息：没有任何分组时，书架不显示分组筛选条',
    (await exec('window.__cwTest.shelfGroupBarVisible()')) === false
  );
  const infoBookTitle = '信息卡测试书';
  await exec(`window.__cwTest.newBook(${JSON.stringify(infoBookTitle)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  const infoBookPath = await exec('window.__cwTest.bookPathValue()');
  const infoBookFolder = path.basename(infoBookPath);
  const infoMetaPath = path.join(infoBookPath, '书目.json');
  const infoChapter = (await storage.readBookMeta(infoBookPath)).chapters[0];
  const infoTxtPath = path.join(infoBookPath, infoChapter.file);
  await exec("window.__cwTest.setText('书籍信息测试正文。')");
  await exec('window.__cwTest.save()');
  const infoTxtBytesBefore = await fs.readFile(infoTxtPath);
  const infoTxtStatBefore = await fs.stat(infoTxtPath);
  const infoContentFiles = (names) =>
    names.filter((name) => name !== '书目.json' && name !== '书目.json.bak').sort();
  const infoDirBefore = infoContentFiles(await fs.readdir(infoBookPath));
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");

  const infoMenuTexts = await exec('window.__cwTest.bookMenuTexts()');
  check('书籍信息：书卡右键菜单有「书籍信息…」', infoMenuTexts.includes('书籍信息…'), infoMenuTexts);
  await exec(`window.__cwTest.openBookMenuForPath(${JSON.stringify(infoBookPath)})`);
  check('书籍信息：菜单能打开（不是点了没反应）', (await exec('window.__cwTest.bookMenuOpen()')) === true);
  await exec("window.__cwTest.clickBookMenuAction('info')");
  await waitFor('window.__cwTest.bookInfoDialogOpen()');
  const infoEmptyValues = await exec('window.__cwTest.bookInfoValues()');
  check(
    '书籍信息：旧书（没有可选字段）打开弹层时四项都是空值',
    infoEmptyValues &&
      infoEmptyValues.author === '' &&
      infoEmptyValues.group === '' &&
      infoEmptyValues.tags === '' &&
      infoEmptyValues.brief === '' &&
      (await exec('window.__cwTest.bookInfoBookText()')).includes(infoBookTitle),
    infoEmptyValues
  );

  // 44j-1. 填作者 / 分组 / 标签 / 简介 → 保存：清洗后写进 书目.json，正文一个字节不动
  await exec("window.__cwTest.setBookInfoField('author', ' 测试作者 ')");
  await exec("window.__cwTest.setBookInfoField('group', '玄幻')");
  await exec("window.__cwTest.setBookInfoField('tags', '爽文，升级、爽文')");
  await exec("window.__cwTest.setBookInfoField('brief', '第一行简介\\r\\n\\r\\n\\r\\n第二行简介')");
  const infoSaveResult = await exec('window.__cwTest.saveBookInfoDialog()');
  await waitFor('!window.__cwTest.bookInfoDialogOpen()');
  const infoMetaOnDisk = JSON.parse(await fs.readFile(infoMetaPath, 'utf8'));
  check(
    '书籍信息：保存后 书目.json 里作者 / 分组 / 简介按规则清洗、标签去重',
    infoSaveResult &&
      infoSaveResult.ok === true &&
      infoSaveResult.changed === true &&
      infoMetaOnDisk.author === '测试作者' &&
      infoMetaOnDisk.group === '玄幻' &&
      infoMetaOnDisk.brief === '第一行简介\n\n第二行简介' &&
      JSON.stringify(infoMetaOnDisk.tags) === JSON.stringify(['爽文', '升级']),
    { result: infoSaveResult, meta: infoMetaOnDisk }
  );
  check(
    '书籍信息：保存只改书目，章节 txt 字节 / mtime / 文件名 / 书内文件数都没变',
    JSON.stringify(await fs.readFile(infoTxtPath)) === JSON.stringify(infoTxtBytesBefore) &&
      (await fs.stat(infoTxtPath)).mtimeMs === infoTxtStatBefore.mtimeMs &&
      JSON.stringify(infoContentFiles(await fs.readdir(infoBookPath))) === JSON.stringify(infoDirBefore),
    { entries: await fs.readdir(infoBookPath) }
  );
  const infoCard = await exec(`window.__cwTest.bookCardInfo(${JSON.stringify(infoBookFolder)})`);
  check(
    '书籍信息：书卡显示作者 / 分组与标签 / 简介',
    infoCard &&
      infoCard.author.includes('测试作者') &&
      infoCard.tags.includes('分组：玄幻') &&
      infoCard.tags.includes('#爽文') &&
      infoCard.tags.includes('#升级') &&
      infoCard.brief.includes('第一行简介') &&
      infoCard.brief.includes('第二行简介'),
    infoCard
  );
  const infoShelfPayload = await exec(`window.__cwTest.shelfBookInfo(${JSON.stringify(infoBookFolder)})`);
  check(
    '书籍信息：书架列表带 author / brief / group / tags（供筛选和搜索用）',
    infoShelfPayload &&
      infoShelfPayload.author === '测试作者' &&
      infoShelfPayload.group === '玄幻' &&
      JSON.stringify(infoShelfPayload.tags) === JSON.stringify(['爽文', '升级']),
    infoShelfPayload
  );

  // 44j-2. 书架搜索：作者 / 分组 / 标签都能命中
  await exec("window.__cwTest.setShelfQuery('测试作者')");
  check(
    '书籍信息：按作者能在书架上搜到',
    (await exec('window.__cwTest.shelfFilteredTitles()')).includes(infoBookTitle)
  );
  await exec("window.__cwTest.setShelfQuery('爽文')");
  check(
    '书籍信息：按标签能在书架上搜到',
    (await exec('window.__cwTest.shelfFilteredTitles()')).includes(infoBookTitle)
  );
  await exec("window.__cwTest.setShelfQuery('玄幻')");
  check(
    '书籍信息：按分组能在书架上搜到',
    (await exec('window.__cwTest.shelfFilteredTitles()')).includes(infoBookTitle)
  );
  await exec("window.__cwTest.setShelfQuery('')");

  // 44j-3. 分组筛选：一本短篇书 + 一本已存在的未分组书
  await exec("window.__cwTest.newBook('信息卡乙')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const infoBookBPath = await exec('window.__cwTest.bookPathValue()');
  await exec('window.__cwTest.backToShelf()');
  const infoBookBResult = await exec(
    `window.api.updateBookInfo(${JSON.stringify(infoBookBPath)}, { author: '乙作者', group: '短篇' })`
  );
  await exec('window.__cwTest.refreshShelf()');
  const infoGroupOptions = await exec('window.__cwTest.shelfGroupOptions()');
  const infoGroupValues = infoGroupOptions.map((item) => item.value);
  check(
    '书籍信息：有分组后书架出现分组筛选（全部分组 / 未分组 / 短篇 / 玄幻）',
    infoBookBResult &&
      infoBookBResult.ok === true &&
      (await exec('window.__cwTest.shelfGroupBarVisible()')) === true &&
      infoGroupValues.includes('') &&
      infoGroupValues.includes('__none__') &&
      infoGroupValues.includes('短篇') &&
      infoGroupValues.includes('玄幻'),
    infoGroupValues
  );
  await exec("window.__cwTest.setShelfGroup('玄幻')");
  const infoFilteredXuanhuan = await exec('window.__cwTest.shelfFilteredTitles()');
  check(
    '书籍信息：选「玄幻」只显示这一组的书',
    infoFilteredXuanhuan.includes(infoBookTitle) &&
      !infoFilteredXuanhuan.includes('信息卡乙'),
    infoFilteredXuanhuan
  );
  const historyTitle = (await storage.readBookMeta(historyBookPath)).title;
  await exec("window.__cwTest.setShelfGroup('__none__')");
  const infoFilteredNone = await exec('window.__cwTest.shelfFilteredTitles()');
  check(
    '书籍信息：选「未分组」只显示没有分组的书',
    infoFilteredNone.includes(historyTitle) &&
      !infoFilteredNone.includes(infoBookTitle) &&
      !infoFilteredNone.includes('信息卡乙'),
    { filtered: infoFilteredNone, historyTitle }
  );
  const infoAllCount = (await exec('window.__cwTest.shelfTitles()')).length;
  await exec("window.__cwTest.setShelfGroup('')");
  const infoAllFiltered = await exec('window.__cwTest.shelfFilteredTitles()');
  check(
    '书籍信息：回到「全部分组」显示所有书（筛选只影响显示）',
    infoAllFiltered.length === infoAllCount && infoAllFiltered.includes(infoBookTitle),
    { shown: infoAllFiltered.length, total: infoAllCount }
  );
  await exec("window.__cwTest.setShelfGroup('短篇')");
  await exec("window.__cwTest.setShelfQuery('测试作者')");
  check(
    '书籍信息：分组筛选和搜索能叠加（短篇 + 测试作者 = 空）',
    (await exec('window.__cwTest.shelfFilteredTitles()')).length === 0
  );
  await exec("window.__cwTest.setShelfQuery('乙作者')");
  check(
    '书籍信息：分组筛选和搜索能叠加（短篇 + 乙作者 = 信息卡乙）',
    (await exec('window.__cwTest.shelfFilteredTitles()')).includes('信息卡乙')
  );
  await exec("window.__cwTest.setShelfQuery('')");

  // 44j-4. 取消不写盘；清空分组后筛选条自动更新、选中状态回到全部
  const infoMetaBeforeCancel = await fs.readFile(infoMetaPath);
  await exec("window.__cwTest.setShelfGroup('玄幻')");
  await exec(`window.__cwTest.openBookInfoForPath(${JSON.stringify(infoBookPath)})`);
  await exec("window.__cwTest.setBookInfoField('author', '不该保存的作者')");
  await exec('window.__cwTest.closeBookInfoDialog()');
  await sleep(200);
  check(
    '书籍信息：点取消不写盘（书目字节不变）',
    JSON.stringify(await fs.readFile(infoMetaPath)) === JSON.stringify(infoMetaBeforeCancel)
  );
  await exec(`window.__cwTest.openBookInfoForPath(${JSON.stringify(infoBookPath)})`);
  await exec("window.__cwTest.setBookInfoField('group', '')");
  await exec('window.__cwTest.saveBookInfoDialog()');
  await waitFor('!window.__cwTest.bookInfoDialogOpen()');
  const infoGroupOptionsAfter = (await exec('window.__cwTest.shelfGroupOptions()')).map((item) => item.value);
  const infoMetaAfterClear = JSON.parse(await fs.readFile(infoMetaPath, 'utf8'));
  check(
    '书籍信息：清空分组后从书目删掉该字段，筛选项里也没有「玄幻」了',
    !('group' in infoMetaAfterClear) && !infoGroupOptionsAfter.includes('玄幻') &&
      infoGroupOptionsAfter.includes('短篇')
  );
  check(
    '书籍信息：当前选中的分组不见了时，筛选自动回到「全部分组」',
    (await exec('window.__cwTest.shelfGroupValue()')) === '' &&
      (await exec('window.__cwTest.shelfFilteredTitles()')).length === infoAllCount
  );

  // 44j-5. 旧书兼容 / 不新增配置字段
  const historyMetaRaw = JSON.parse(await fs.readFile(path.join(historyBookPath, '书目.json'), 'utf8'));
  const historyShelfInfo = await exec(
    `window.__cwTest.shelfBookInfo(${JSON.stringify(path.basename(historyBookPath))})`
  );
  check(
    '书籍信息：旧书书目没有被补字段，书架上的书籍信息是空值',
    !('author' in historyMetaRaw) &&
      !('brief' in historyMetaRaw) &&
      !('group' in historyMetaRaw) &&
      !('tags' in historyMetaRaw) &&
      historyShelfInfo &&
      historyShelfInfo.author === '' &&
      historyShelfInfo.brief === '' &&
      historyShelfInfo.group === '' &&
      historyShelfInfo.tags.length === 0,
    { meta: historyMetaRaw, shelf: historyShelfInfo }
  );
  const infoConfigDisk = await readConfigDisk();
  check(
    '书籍信息：不新增任何配置字段（作者 / 分组 / 标签只存在书目里）',
    !Object.keys(infoConfigDisk).some((key) => /author|brief|bookinfo|tags|group/i.test(key)),
    Object.keys(infoConfigDisk)
  );
  const infoMetaFinal = JSON.parse(await fs.readFile(infoMetaPath, 'utf8'));
  check(
    '书籍信息：作者 / 简介 / 标签仍在，章节文件一个没多',
    infoMetaFinal.author === '测试作者' &&
      infoMetaFinal.brief === '第一行简介\n\n第二行简介' &&
      JSON.stringify(infoMetaFinal.tags) === JSON.stringify(['爽文', '升级']) &&
      JSON.stringify(infoContentFiles(await fs.readdir(infoBookPath))) === JSON.stringify(infoDirBefore)
  );

  // 44k. 阅读模式（v0.8-4，提案 N4）：整本只读通读。
  // 连续滚动 / 目录 / 字号行距 / 上一章下一章；只读：不写正文、书目、配置，不生成 _trash。
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec("window.__cwTest.newBook('阅读模式测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const readBookPath = await exec('window.__cwTest.bookPathValue()');
  const readMetaPath = path.join(readBookPath, '书目.json');
  const readLongText = Array.from(
    { length: 80 },
    (_, i) => `第${i + 1}段：风从海面吹来，他收起了帆，远处有灯一明一暗。`
  ).join('\n\n');
  const readTexts = [readLongText, '夜雨敲着窗。\n\n她把伞靠在门边。', '清晨的街道很安静。'];
  await exec("window.__cwTest.renameChapterAt(0, '开端')");
  await exec(`window.__cwTest.setText(${JSON.stringify(readTexts[0])})`);
  await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false');
  await exec("window.__cwTest.newChapter('夜雨')");
  await waitFor("window.__cwTest.currentTitle() === '第2章：夜雨'");
  await exec(`window.__cwTest.setText(${JSON.stringify(readTexts[1])})`);
  await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false');
  await exec("window.__cwTest.newChapter('尾声')");
  await waitFor("window.__cwTest.currentTitle() === '第3章：尾声'");
  await exec(`window.__cwTest.setText(${JSON.stringify(readTexts[2])})`);
  await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false');
  const readMeta = await storage.readBookMeta(readBookPath);
  const readTxtPaths = readMeta.chapters.map((chapter) => path.join(readBookPath, chapter.file));
  const readTxtBefore = [];
  for (const filePath of readTxtPaths) {
    readTxtBefore.push({ bytes: await fs.readFile(filePath), stat: await fs.stat(filePath) });
  }
  const readDirBefore = (await fs.readdir(readBookPath)).sort();
  check(
    '阅读模式：准备 3 章测试书（第 1 章较长，方便验证连续滚动）',
    readMeta.chapters.length === 3 && readTexts[0].length > 2000,
    { chapters: readMeta.chapters.length, longChars: readTexts[0].length }
  );

  // 44k-1. 入口：从当前写作章（第 2 章）进入阅读视图，正文只读自磁盘
  await exec("window.__cwTest.switchTo(1, 'discard')");
  await waitFor("window.__cwTest.currentTitle() === '第2章：夜雨'");
  // 切章会更新书目里的「上次打开章节」/ 配置里的 lastBook，快照要在切完之后取
  const readMetaBefore = await fs.readFile(readMetaPath);
  const readConfigBefore = await fs.readFile(path.join(userData, 'config.json'));
  check('阅读模式：写作页顶栏有「阅读」按钮', (await exec('window.__cwTest.readingButtonText()')) === '阅读');
  await exec("window.__cwTest.readingClick('btn-reading')");
  await waitFor('window.__cwTest.readingState().open === true && window.__cwTest.readingState().loading === false');
  const readEntry = await exec('window.__cwTest.readingState()');
  check(
    '阅读模式：进入后切到只读视图（编辑器隐藏、窗口标题带「（阅读）」）',
    readEntry.view === 'reading' &&
      readEntry.open === true &&
      (await exec("document.getElementById('editor-view').classList.contains('hidden')")) === true &&
      (await exec('window.__cwTest.readingViewVisible()')) === true &&
      // 只要「阅读标记」在（Phase D / D8 之后标记里还带章号，精确格式由下面那条 check 钉）
      readEntry.title.includes('（阅读'),
    readEntry
  );
  check(
    '阅读模式：窗口标题带当前章号（…（阅读 · 第 2/3 章））',
    readEntry.title === '章回 - 阅读模式测试书（阅读 · 第 2/3 章）',
    readEntry.title
  );
  check(
    '阅读模式：从当前写作章开始（第 2 / 3 章）',
    readEntry.current === 1 &&
      readEntry.progress === '第 2 / 3 章 · 66.7%' &&
      readEntry.bookTitle === '阅读模式测试书' &&
      readEntry.total === 3,
    readEntry
  );
  const readEntryBlocks = await exec('window.__cwTest.readingBlocks()');
  check(
    '阅读模式：正文来自磁盘、章名正确、编辑区一个字没动',
    readEntryBlocks[0].index === 1 &&
      readEntryBlocks[0].title === '第2章：夜雨' &&
      readEntryBlocks[0].text === readTexts[1] &&
      (await exec('window.__cwTest.text()')) === readTexts[1] &&
      (await exec('window.__cwTest.dirty()')) === false,
    readEntryBlocks[0]
  );
  const readMetricsDefault = await exec('window.__cwTest.readingMetrics()');
  check(
    '阅读模式：默认字号 22px / 行距 2.0，正文可以选中复制',
    parseFloat(readMetricsDefault.fontSize) === 22 &&
      Math.abs(readMetricsDefault.lineHeight / parseFloat(readMetricsDefault.fontSize) - 2) < 0.02 &&
      readMetricsDefault.userSelect === 'text' &&
      // 中西文自动间距（1.3.0 T-08）：阅读容器与正文共用同一个变量，默认开
      readMetricsDefault.textAutospace === 'normal',
    readMetricsDefault
  );

  // 44k-2. 字号 / 行距：只改阅读视图的 CSS，不写配置（档位有单测覆盖）
  await exec('window.__cwTest.readingSetFontLevel(3)');
  await exec('window.__cwTest.readingSetLineLevel(0)');
  const readMetricsBig = await exec('window.__cwTest.readingMetrics()');
  check(
    '阅读模式：切「特大 + 紧凑」只改显示（25px / 1.7 倍行距）',
    parseFloat(readMetricsBig.fontSize) === 25 &&
      Math.abs(readMetricsBig.lineHeight / parseFloat(readMetricsBig.fontSize) - 1.7) < 0.02 &&
      readMetricsBig.fontFamily === readMetricsDefault.fontFamily,
    readMetricsBig
  );
  await exec('window.__cwTest.readingSetFontLevel(2)');
  await exec('window.__cwTest.readingSetLineLevel(1)');

  // 44k-3. 上一章会向前补一章；下一章跳回来；Esc 退出不改编辑区
  const readPrevToFirst = await exec('window.__cwTest.readingPrev()');
  await waitFor('window.__cwTest.readingState().current === 0');
  const readAtFirst = await exec('window.__cwTest.readingState()');
  const readFirstBlock = (await exec('window.__cwTest.readingBlocks()'))[0];
  check(
    '阅读模式：上一章向前补载第 1 章（只读加载，章节文件不动）',
    readPrevToFirst.ok === true &&
      readAtFirst.current === 0 &&
      readFirstBlock.index === 0 &&
      readFirstBlock.text === readTexts[0] &&
      readAtFirst.prevDisabled === true,
    { result: readPrevToFirst, state: readAtFirst }
  );
  const readNextResult = await exec('window.__cwTest.readingNext()');
  await waitFor('window.__cwTest.readingState().current === 1');
  const readNextState = await exec('window.__cwTest.readingState()');
  check(
    '阅读模式：下一章从第 1 章回到第 2 章',
    readNextResult.ok === true && readNextState.current === 1,
    { result: readNextResult, state: readNextState }
  );

  // 44k-3b. 键盘翻章（Phase D / D3）：← / → 与顶栏两个按钮同一条 readingGo；下拉里的方向键不抢。
  // keydown 委托在 #reading-view 上，合成事件冒泡一样进得去（写法同第 70 / 51 组）。
  // extra 是给 KeyboardEvent 追加的修饰键（如 ', ctrlKey: true'），返回 defaultPrevented 与档位。
  const readKeydown = (id, key, extra = '') => exec(`(() => {
    const event = new KeyboardEvent('keydown', { key: '${key}', bubbles: true, cancelable: true${extra} });
    document.getElementById('${id}').dispatchEvent(event);
    return { prevented: event.defaultPrevented, fontLevel: window.__cwTest.readingState().fontLevel };
  })()`);
  await readKeydown('reading-scroll', 'ArrowRight');
  await waitFor('window.__cwTest.readingState().current === 2');
  const readKeyNext = await exec('window.__cwTest.readingState()');
  check(
    '阅读模式：键盘 → 翻到下一章（与「下一章」按钮同一条路径）',
    readKeyNext.current === 2 &&
      readKeyNext.progress === '第 3 / 3 章 · 100%' &&
      readKeyNext.nextDisabled === true,
    readKeyNext
  );
  check(
    '阅读模式：翻章后窗口标题的章号跟着变（…（阅读 · 第 3/3 章））',
    readKeyNext.title === '章回 - 阅读模式测试书（阅读 · 第 3/3 章）',
    readKeyNext.title
  );
  const readKeyOnSelect = await exec(`(() => {
    const toc = document.getElementById('reading-toc');
    toc.focus();
    const event = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
    toc.dispatchEvent(event);
    return { prevented: event.defaultPrevented, current: window.__cwTest.readingState().current };
  })()`);
  check(
    '阅读模式：焦点在目录下拉里按 ← 不翻章（方向键让给控件）',
    readKeyOnSelect.prevented === false && readKeyOnSelect.current === 2,
    readKeyOnSelect
  );
  await readKeydown('reading-scroll', 'ArrowLeft');
  await waitFor('window.__cwTest.readingState().current === 1');
  check(
    '阅读模式：键盘 ← 翻回上一章',
    (await exec('window.__cwTest.readingState()')).current === 1
  );

  // 44k-3c. 字号快捷键（Phase D / D6）：Ctrl+滚轮 / Ctrl+= / Ctrl+- 只改阅读视图的 CSS，不写配置。
  // 合成 WheelEvent / keydown 就够（监听委托在 #reading-view 上，冒泡照样进得去），不受窗口焦点影响；
  // 一并读 defaultPrevented，确认 Ctrl+滚轮把 Chromium 的「整页缩放」拦下来了。
  const readWheel = (deltaY, modifier = 'ctrlKey: true') => exec(`(() => {
    const event = new WheelEvent('wheel', { deltaY: ${deltaY}, bubbles: true, cancelable: true, ${modifier} });
    document.getElementById('reading-scroll').dispatchEvent(event);
    return {
      prevented: event.defaultPrevented,
      fontLevel: window.__cwTest.readingState().fontLevel,
      fontSize: window.__cwTest.readingMetrics().fontSize
    };
  })()`);
  const readWheelUp = await readWheel(-120);
  check(
    '阅读模式：Ctrl+滚轮上滚放大一档字号（22 → 25px），并拦掉整页缩放',
    readWheelUp.prevented === true && readWheelUp.fontLevel === 3 && parseFloat(readWheelUp.fontSize) === 25,
    readWheelUp
  );
  const readWheelDown = await readWheel(120);
  check(
    '阅读模式：Ctrl+滚轮下滚缩回一档（25 → 22px）',
    readWheelDown.prevented === true && readWheelDown.fontLevel === 2 && parseFloat(readWheelDown.fontSize) === 22,
    readWheelDown
  );
  const readPlainWheel = await readWheel(-120, '');
  check(
    '阅读模式：不按 Ctrl 的滚轮不调字号、也不拦默认（滚动还归浏览器）',
    readPlainWheel.prevented === false && readPlainWheel.fontLevel === 2 && parseFloat(readPlainWheel.fontSize) === 22,
    readPlainWheel
  );
  const readZoomIn = await readKeydown('reading-scroll', '=', ', ctrlKey: true');
  const readZoomInMetrics = await exec('window.__cwTest.readingMetrics()');
  check(
    '阅读模式：Ctrl+= 放大一档字号（与字号下拉同一条路径，拦掉默认）',
    readZoomIn.prevented === true && readZoomIn.fontLevel === 3 && parseFloat(readZoomInMetrics.fontSize) === 25,
    { key: readZoomIn, metrics: readZoomInMetrics }
  );
  await readKeydown('reading-scroll', '-', ', ctrlKey: true');
  const readZoomOut = await exec('window.__cwTest.readingState()');
  await readKeydown('reading-scroll', '-', ', ctrlKey: true');
  await readKeydown('reading-scroll', '-', ', ctrlKey: true');
  const readZoomMin = await exec('window.__cwTest.readingMetrics()');
  check(
    '阅读模式：Ctrl+- 缩回 22px，连按到最小档 17px 停住（不越界）',
    readZoomOut.fontLevel === 2 &&
      (await exec('window.__cwTest.readingState()')).fontLevel === 0 &&
      parseFloat(readZoomMin.fontSize) === 17,
    { afterOne: readZoomOut, min: readZoomMin }
  );
  await exec('window.__cwTest.readingSetFontLevel(2)');

  await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await waitFor("window.__cwTest.view() === 'editor'");
  check(
    '阅读模式：Esc 退出回到写作页，编辑区内容与未保存状态原样保留',
    (await exec('window.__cwTest.readingOpen()')) === false &&
      (await exec("document.getElementById('editor-view').classList.contains('hidden')")) === false &&
      (await exec('window.__cwTest.text()')) === readTexts[1] &&
      (await exec('window.__cwTest.dirty()')) === false &&
      (await exec('window.__cwTest.title()')).includes('（阅读') === false
  );
  const readTitleAfterExit = await exec('window.__cwTest.title()');
  check(
    '阅读模式：退出后窗口标题摘掉阅读后缀与章号（回到写作页标题）',
    readTitleAfterExit === '章回 - 阅读模式测试书',
    readTitleAfterExit
  );

  // 44k-4. 只读校验：阅读期间书目 / 章节 txt / 配置一个字节都没改，也没有 _trash
  const readMetaAfter = await fs.readFile(readMetaPath);
  for (let i = 0; i < readTxtPaths.length; i += 1) {
    check(
      `阅读模式：第 ${i + 1} 章 txt 字节与 mtime 没变（只读）`,
      JSON.stringify(await fs.readFile(readTxtPaths[i])) === JSON.stringify(readTxtBefore[i].bytes) &&
        (await fs.stat(readTxtPaths[i])).mtimeMs === readTxtBefore[i].stat.mtimeMs
    );
  }
  check(
    '阅读模式：书目逐字节没变（不改章节顺序 / 不改上次打开章节）',
    JSON.stringify(readMetaAfter) === JSON.stringify(readMetaBefore)
  );
  const readConfigAfter = await fs.readFile(path.join(userData, 'config.json'));
  check(
    '阅读模式：config.json 逐字节没变（字号 / 行距不写配置）',
    JSON.stringify(readConfigAfter) === JSON.stringify(readConfigBefore)
  );
  const readDirAfter = (await fs.readdir(readBookPath)).sort();
  check(
    '阅读模式：书文件夹没有多出文件，也没有生成 _trash',
    JSON.stringify(readDirAfter) === JSON.stringify(readDirBefore) &&
      readDirAfter.every((name) => !name.startsWith('_trash') && !name.startsWith('.tmp-')),
    readDirAfter
  );

  // 44k-5. 连续滚动：第 1 章很长，先只加载当前章；滚到底自动接第 2、3 章
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await waitFor("window.__cwTest.currentTitle() === '第1章：开端'");
  const readMetaStable = await fs.readFile(readMetaPath);
  await exec('window.__cwTest.openReading()');
  await waitFor('window.__cwTest.readingState().open === true && window.__cwTest.readingState().loading === false');
  const readLong = await exec('window.__cwTest.readingState()');
  check(
    '阅读模式：第 1 章很长时先只加载当前章（不下子把全书读进来）',
    readLong.current === 0 &&
      readLong.loaded.length === 1 &&
      readLong.loaded[0] === 0 &&
      readLong.progress === '第 1 / 3 章 · 33.3%',
    readLong
  );
  await exec('window.__cwTest.readingScrollToBottom()');
  await waitFor('window.__cwTest.readingState().loaded.includes(1)');
  const readScrolled = await exec('window.__cwTest.readingState()');
  check(
    '阅读模式：滚到接近底部自动接下一章（连续滚动）',
    readScrolled.loaded.includes(1) && readScrolled.blockCount >= 2,
    readScrolled
  );
  await exec('window.__cwTest.readingScrollToBottom()');
  await waitFor('window.__cwTest.readingState().loaded.includes(2)');
  await exec('window.__cwTest.readingJump(2)');
  await waitFor('window.__cwTest.readingState().current === 2 && window.__cwTest.readingState().endVisible === true');
  const readEnd = await exec('window.__cwTest.readingState()');
  check(
    '阅读模式：接完最后一章显示「全书完」、下一章置灰',
    readEnd.endVisible === true && readEnd.current === 2 && readEnd.nextDisabled === true,
    readEnd
  );

  // 44k-6. 上一章 / 下一章 / 目录 / 从头
  const readPrevAtEnd = await exec('window.__cwTest.readingPrev()');
  await waitFor('window.__cwTest.readingState().current === 1');
  const readAtSecond = await exec('window.__cwTest.readingState()');
  check(
    '阅读模式：上一章回到第 2 章，下一章按钮恢复可用',
    readPrevAtEnd.ok === true && readAtSecond.current === 1 && readAtSecond.nextDisabled === false,
    readAtSecond
  );
  await exec('window.__cwTest.readingPrev()');
  await waitFor('window.__cwTest.readingState().current === 0');
  check(
    '阅读模式：到章首后上一章置灰，再点不会越界',
    (await exec('window.__cwTest.readingState()')).prevDisabled === true &&
      (await exec('window.__cwTest.readingPrev()')).edge === true
  );
  await exec('window.__cwTest.readingNext()');
  await waitFor('window.__cwTest.readingState().current === 1');
  await exec('window.__cwTest.readingNext()');
  await waitFor('window.__cwTest.readingState().current === 2');
  check(
    '阅读模式：下一章可以连续走到最后一章',
    (await exec('window.__cwTest.readingState()')).current === 2 &&
      (await exec('window.__cwTest.readingState()')).nextDisabled === true
  );
  const readTocState = await exec('window.__cwTest.readingState()');
  check(
    '阅读模式：目录列出全书章节并跟着当前位置走',
    readTocState.tocCount === 3 && readTocState.tocValue === '2',
    readTocState
  );
  await exec('window.__cwTest.readingSelectToc(1)');
  await waitFor('window.__cwTest.readingState().current === 1');
  check(
    '阅读模式：目录可以跳到任意一章（第 2 章）',
    (await exec('window.__cwTest.readingState()')).tocValue === '1'
  );
  await exec("window.__cwTest.readingClick('btn-reading-first')");
  await waitFor('window.__cwTest.readingState().current === 0');
  check(
    '阅读模式：「从头」回到第 1 章',
    (await exec('window.__cwTest.readingState()')).current === 0
  );
  await exec('window.__cwTest.closeReading()');
  await waitFor("window.__cwTest.view() === 'editor'");

  // 44k-7. 章节文件被挪走：阅读视图给错误块，不崩、不重建、不改书目
  const readMissingPath = readTxtPaths[2];
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await fs.rename(readMissingPath, `${readMissingPath}.missing`);
  try {
    await exec('window.__cwTest.openReading()');
    await waitFor('window.__cwTest.readingState().open === true && window.__cwTest.readingState().loading === false');
    await exec('window.__cwTest.readingNext()');
    await waitFor('window.__cwTest.readingState().loaded.includes(1)');
    await exec('window.__cwTest.readingNext()');
    await waitFor('window.__cwTest.readingState().errorBlocks === 1');
    const readErrorState = await exec('window.__cwTest.readingState()');
    const readErrorBlock = (await exec('window.__cwTest.readingBlocks()')).find(
      (block) => block.index === 2
    );
    check(
      '阅读模式：章节文件被挪走时显示错误块，不崩、不重建文件',
      readErrorState.errorBlocks === 1 &&
        Boolean(
          readErrorBlock &&
            readErrorBlock.error.includes('读取失败') &&
            readErrorBlock.error.includes('不会重建文件')
        ) &&
        (await fileExists(readMissingPath)) === false,
      { state: readErrorState, block: readErrorBlock }
    );
    check(
      '阅读模式：读不到的那一章仍在书里（书目不被改动）',
      JSON.stringify(await fs.readFile(readMetaPath)) === JSON.stringify(readMetaStable) &&
        (await fileExists(`${readMissingPath}.missing`)) === true
    );
    await exec("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await waitFor("window.__cwTest.view() === 'editor'");
  } finally {
    await fs.rename(`${readMissingPath}.missing`, readMissingPath);
  }

  // 44k-8. 进入阅读不写盘：有未保存修改时只显示磁盘内容，退出后修改还在、仍可照常保存
  await exec("window.__cwTest.switchTo(0, 'discard')");
  const readDirtyEditor = '这段还没保存：阅读模式不该动它。';
  await exec(`window.__cwTest.setText(${JSON.stringify(readDirtyEditor)})`);
  await waitFor('window.__cwTest.dirty() === true');
  const readDirtyTxtBefore = await fs.readFile(readTxtPaths[0]);
  const readDirtyMetaBefore = await fs.readFile(readMetaPath);
  await exec('window.__cwTest.openReading()');
  await waitFor('window.__cwTest.readingState().open === true && window.__cwTest.readingState().loading === false');
  const readDirtyState = await exec('window.__cwTest.readingState()');
  const readDirtyBlocks = await exec('window.__cwTest.readingBlocks()');
  check(
    '阅读模式：有未保存修改时只显示磁盘内容，并明确提示「你的修改还在编辑区」',
    readDirtyState.dirty === true &&
      readDirtyState.noteVisible === true &&
      readDirtyState.note.includes('未保存') &&
      readDirtyBlocks[0].text === readTexts[0] &&
      (await exec('window.__cwTest.text()')) === readDirtyEditor,
    readDirtyState
  );
  check(
    '阅读模式：此时进入 / 阅读都不写盘（章节 txt / 书目字节不变）',
    JSON.stringify(await fs.readFile(readTxtPaths[0])) === JSON.stringify(readDirtyTxtBefore) &&
      JSON.stringify(await fs.readFile(readMetaPath)) === JSON.stringify(readDirtyMetaBefore)
  );
  await exec('window.__cwTest.closeReading()');
  await waitFor("window.__cwTest.view() === 'editor'");
  check(
    '阅读模式：退出后未保存内容还在编辑区、仍是未保存状态',
    (await exec('window.__cwTest.text()')) === readDirtyEditor &&
      (await exec('window.__cwTest.dirty()')) === true
  );
  await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false');
  const readDirtySaved = await storage.loadChapterText(readBookPath, readMeta.chapters[0].file);
  check(
    '阅读模式：退出后照常可以保存（阅读模式没有锁住编辑）',
    readDirtySaved.text === readDirtyEditor &&
      (await exec('window.__cwTest.view()')) === 'editor'
  );
  check(
    '阅读模式：最终书文件夹没有 _trash / 临时文件',
    (await fs.readdir(readBookPath)).every(
      (name) => !name.startsWith('_trash') && !name.startsWith('.tmp-')
    )
  );

  // 44k-9. 阅读位置记忆（v0.13 / U-D10）：只记本次运行 —— 退出阅读再进，回到上次读到的地方
  // （同一章 + 章内位置都回来）；不写 config.json / 书目。换书 / 重启回默认由单测覆盖。
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await waitFor("window.__cwTest.currentTitle() === '第1章：开端'");
  // 第 1 章换回长文（44k-8 保存的是短句），章内才滚得出可见位移
  await exec(`window.__cwTest.setText(${JSON.stringify(readLongText)})`);
  await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false');
  const readPosConfigBefore = await fs.readFile(path.join(userData, 'config.json'));
  const readPosMetaBefore = await fs.readFile(readMetaPath);
  await exec('window.__cwTest.openReading()');
  await waitFor('window.__cwTest.readingState().open === true && window.__cwTest.readingState().loading === false');
  const readPosScrolled = await exec(`(() => {
    const scroll = document.getElementById('reading-scroll');
    scroll.scrollTop = 900;
    return {
      scrollTop: window.__cwTest.readingState().scrollTop,
      maxScrollTop: scroll.scrollHeight - scroll.clientHeight
    };
  })()`);
  await exec('window.__cwTest.closeReading()');
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec('window.__cwTest.openReading()');
  await waitFor('window.__cwTest.readingState().open === true && window.__cwTest.readingState().scrollTop >= 850');
  const readPosResumed = await exec('window.__cwTest.readingState()');
  const readPosText = await exec('window.__cwTest.readingBlocks()[0].text');
  check(
    '阅读位置：退出阅读再进回到上次读到的地方（同一章 + 章内位置），只记本次运行不写盘',
    readPosScrolled.scrollTop >= 880 &&
      readPosScrolled.maxScrollTop > 950 &&
      readPosResumed.current === 0 &&
      readPosResumed.scrollTop >= 850 &&
      readPosResumed.scrollTop <= 950 &&
      readPosResumed.loaded.length === 1 &&
      readPosResumed.loaded[0] === 0 &&
      readPosText === readLongText &&
      JSON.stringify(await fs.readFile(path.join(userData, 'config.json'))) === JSON.stringify(readPosConfigBefore) &&
      JSON.stringify(await fs.readFile(readMetaPath)) === JSON.stringify(readPosMetaBefore),
    { scrolled: readPosScrolled, resumed: readPosResumed }
  );
  await exec('window.__cwTest.closeReading()');
  await waitFor("window.__cwTest.view() === 'editor'");

  // 44l. 章节模板（v0.8-5，提案 N5）：新建 / 插入章节时套用；只改编辑区、可撤销、不自动写盘
  await exec("window.__cwTest.newBook('章节模板测试书')");
  await waitFor("window.__cwTest.view() === 'editor'");
  const tplBookPath = await exec('window.__cwTest.bookPathValue()');
  const tplMetaPath = path.join(tplBookPath, '书目.json');
  const tplConfigPath = path.join(userData, 'config.json');
  await exec("window.__cwTest.setText('第一章正文。')");
  await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false');

  // 44l-1. 默认关：没设置模板时配置里是空串，设置里也是空模板（旧配置缺键见单测）
  const tplConfigBefore = JSON.parse(await fs.readFile(tplConfigPath, 'utf8'));
  check(
    '章节模板：没设置模板时配置里是空串（默认不套用）',
    tplConfigBefore.chapterTemplate === '',
    tplConfigBefore.chapterTemplate
  );
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec('window.__cwTest.openSettings()');
  await waitFor('window.__cwTest.settingsOpen() === true');
  const tplPreviewEmpty = await exec('window.__cwTest.chapterTemplatePreview()');
  check(
    '章节模板：全局设置里默认空模板、预览说明未设置',
    (await exec('window.__cwTest.chapterTemplateField()')) === '' &&
      (await exec('window.__cwTest.chapterTemplateSettingsVisible()')) === true &&
      tplPreviewEmpty.includes('未设置模板'),
    tplPreviewEmpty
  );

  // 44l-2. 输入模板（真实 input 事件）→ 预览展开 → 只点「保存设置」才落进 config.json
  const tplText = '第{n}章：{title}\n\n';
  await exec(
    `(() => { const el = document.getElementById('settings-chapter-template'); el.value = ${JSON.stringify(
      tplText
    )}; el.dispatchEvent(new Event('input')); return true; })()`
  );
  const tplPreview = await exec('window.__cwTest.chapterTemplatePreview()');
  check(
    '章节模板：边输入边预览（占位符展开、空行保留）',
    tplPreview.includes('预览（第 1 章）') &&
      tplPreview.includes('第1章：示例章名') &&
      tplPreview.includes('示例章名\n\n'),
    tplPreview
  );
  await exec('window.__cwTest.saveSettings()');
  await waitFor(
    `window.api.getConfig().then((r) => r.ok && r.data.chapterTemplate === ${JSON.stringify(tplText)})`
  );
  const tplConfigOnDisk = JSON.parse(await fs.readFile(tplConfigPath, 'utf8'));
  check(
    '章节模板：模板真的落进 config.json（只改一个字段）',
    tplConfigOnDisk.chapterTemplate === tplText,
    tplConfigOnDisk.chapterTemplate
  );

  // 44l-3. 写作页按书设置里不显示模板项（和统计 / 快照 / 词表一样是全局设置）
  await exec(`window.__cwTest.openBookPath(${JSON.stringify(tplBookPath)})`);
  await waitFor("window.__cwTest.view() === 'editor'");
  await exec('window.__cwTest.openSettings()');
  await waitFor('window.__cwTest.settingsOpen() === true');
  check(
    '章节模板：写作页按书设置里不显示模板（全局设置）',
    (await exec('window.__cwTest.settingsScope()')) === 'book' &&
      (await exec('window.__cwTest.chapterTemplateSettingsVisible()')) === false
  );
  await exec('window.__cwTest.closeSettings()');
  await waitFor('window.__cwTest.settingsOpen() === false');

  // 44l-4. 新建章节自动套用：占位符展开后只进编辑区（未保存），磁盘上的新章仍是空的
  await exec("window.__cwTest.switchTo(0, 'discard')");
  await exec("window.__cwTest.newChapter('夜雨')");
  await waitFor('window.__cwTest.dirty() === true');
  const tplNewIndex = await exec('window.__cwTest.currentIndex()');
  const tplNewText = await exec('window.__cwTest.text()');
  const tplNewMeta = JSON.parse(await fs.readFile(tplMetaPath, 'utf8'));
  const tplNewFile = tplNewMeta.chapters[tplNewIndex].file;
  const tplNewDisk = await storage.loadChapterText(tplBookPath, tplNewFile);
  check(
    '章节模板：新建章节自动套用（{n}=全书章号、{title}=章名），仍是未保存',
    tplNewIndex === 1 &&
      tplNewText === '第2章：夜雨\n\n' &&
      (await exec('window.__cwTest.statusText()')).includes('未保存'),
    { tplNewIndex, tplNewText }
  );
  check(
    '章节模板：只改编辑区，新章 txt 在磁盘上仍是空的（不自动写盘）',
    tplNewDisk.text === '',
    tplNewDisk
  );

  // 44l-5. 可 Ctrl+Z 撤销：撤销后回到空章、未保存状态清掉，磁盘仍空
  const tplUndo = await exec('window.__cwTest.undoEditor()');
  check(
    '章节模板：可 Ctrl+Z 撤销（编辑区回空章、未保存状态清掉），磁盘仍空',
    tplUndo.ok === true &&
      tplUndo.text === '' &&
      tplUndo.dirty === false &&
      (await exec('window.__cwTest.currentIndex()')) === 1 &&
      (await storage.loadChapterText(tplBookPath, tplNewFile)).text === '',
    tplUndo
  );

  // 44l-6. 保存后才写盘（作者按 Ctrl+S / 保存按钮才落盘）
  await exec("window.__cwTest.newChapter('归途')");
  await waitFor('window.__cwTest.dirty() === true');
  const tplSaveIndex = await exec('window.__cwTest.currentIndex()');
  const tplSaveText = await exec('window.__cwTest.text()');
  const tplSaveResult = await exec('window.__cwTest.save()');
  await waitFor('window.__cwTest.dirty() === false');
  const tplSavedMeta = JSON.parse(await fs.readFile(tplMetaPath, 'utf8'));
  const tplSavedDisk = await storage.loadChapterText(
    tplBookPath,
    tplSavedMeta.chapters[tplSaveIndex].file
  );
  check(
    '章节模板：保存后模板写进章节 txt（内容 = 展开后的模板）',
    tplSaveResult &&
      tplSaveResult.ok === true &&
      tplSaveText === '第3章：归途\n\n' &&
      tplSavedDisk.text === tplSaveText,
    { tplSaveText, disk: tplSavedDisk.text }
  );

  // 44l-7. 插入章节同样套用，章号按插入位置算
  await exec("window.__cwTest.insertAfter(0, '插曲')");
  await waitFor('window.__cwTest.dirty() === true');
  const tplInsertIndex = await exec('window.__cwTest.currentIndex()');
  const tplInsertText = await exec('window.__cwTest.text()');
  check(
    '章节模板：插入章节同样套用，章号按插入位置（第 2 章）',
    tplInsertIndex === 1 &&
      tplInsertText === '第2章：插曲\n\n' &&
      (await exec('window.__cwTest.chapterTitles()')).length === 4,
    { tplInsertIndex, tplInsertText }
  );

  // 44l-8. 已有正文的章不会被套模板（切章只读已有内容）
  await exec("window.__cwTest.switchTo(0, 'discard')");
  check(
    '章节模板：已有正文的章不会被套模板',
    (await exec('window.__cwTest.text()')) === '第一章正文。'
  );

  // 44l-9. 不认识的占位符原样保留（不猜）；清空模板后新章回到空章
  await exec("window.__cwTest.saveTemplateOnly('{n}-{x}-{N}-{title}')");
  await exec("window.__cwTest.newChapter('未知占位符')");
  await waitFor('window.__cwTest.dirty() === true');
  const tplUnknownText = await exec('window.__cwTest.text()');
  check(
    '章节模板：不认识的占位符原样保留，不猜也不吞',
    tplUnknownText === '5-{x}-{N}-未知占位符',
    tplUnknownText
  );
  await exec("window.__cwTest.saveTemplateOnly('')");
  await exec("window.__cwTest.newChapter('没有模板')");
  check(
    '章节模板：清空模板后新建章节回到空章（不套用、不算未保存）',
    (await exec('window.__cwTest.text()')) === '' &&
      (await exec('window.__cwTest.dirty()')) === false
  );

  // 44l-10. 设置里回填 / 清空；配置只多 chapterTemplate；书目录干净
  await exec('window.__cwTest.backToShelf()');
  await waitFor("window.__cwTest.view() === 'shelf'");
  await exec('window.__cwTest.openSettings()');
  await waitFor('window.__cwTest.settingsOpen() === true');
  check(
    '章节模板：清空后设置回填为空、预览说明未设置',
    (await exec('window.__cwTest.chapterTemplateField()')) === '' &&
      (await exec('window.__cwTest.chapterTemplatePreview()')).includes('未设置模板')
  );
  await exec('window.__cwTest.closeSettings()');
  const tplConfigFinal = JSON.parse(await fs.readFile(tplConfigPath, 'utf8'));
  check(
    '章节模板：配置只多 chapterTemplate 一个字段（没有按书模板字段）',
    tplConfigFinal.chapterTemplate === '' &&
      !('chapterTemplates' in tplConfigFinal) &&
      !('bookTemplates' in tplConfigFinal),
    Object.keys(tplConfigFinal).filter((key) => key.toLowerCase().includes('template'))
  );
  const tplDirEntries = (await fs.readdir(tplBookPath)).sort();
  check(
    '章节模板：书文件夹没有 _trash / 临时文件（章节文件数 = 章节数 6）',
    tplDirEntries.every((name) => !name.startsWith('_trash') && !name.startsWith('.tmp-')) &&
      tplDirEntries.filter((name) => name.endsWith('.txt')).length === 6,
    tplDirEntries
  );
};
