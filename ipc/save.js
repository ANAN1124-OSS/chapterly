/* 主进程 IPC 域模块：章节保存（V114 按域拆分先例；MAIN-03，审计建议「下一刀拆保存域」）。
 *
 * 搬走的段（原 main.js 的 registerIpc() 内，行号按搬前代码 1942–2083）：
 *   · chapter:save —— 保存热路径：正文校验 / 书锁 / prepareChapterSave（expectedStamp）/
 *     每日快照 / saveChapterText / 书目写盘（rotateBak + expectedStamp）/ 索引标脏 /
 *     每日统计增量 / recentBook / 关窗回执 lastSaveAt。
 *
 * 只搬不改行为：频道名 / 参数顺序 / 返回形状 / 文案 / 读盘与写盘顺序与搬运前逐字一致。
 * 依赖（statsSummaryPayload / getStatsStore / rememberRecentBook 等）经 buildIpcHost() 注入，
 * 模块自己不 require electron，也不缓存状态快照。
 *
 * 契约：register(host) —— host 成员逐条列在 REQUIRED_HOST 里；缺任何一个在 registerIpc() 装配时
 * 直接抛 TypeError。
 */
const { assertHost } = require('../core/assert-host');
const { MUTATION } = require('./book-mutations');

const REQUIRED_HOST = [
  'handleBook',
  'assertText',
  'flowSession',
  'storage',
  'getConfig',
  'chaptersLib',
  'statsLib',
  'errorText',
  'logError',
  'getStatsStore',
  'getSearchIndexStore',
  'statsSummaryPayload',
  'rememberRecentBook'
];

function registerSaveIpc(host) {
  assertHost('ipc/save.registerSaveIpc', host, REQUIRED_HOST);
  const {
    handleBook, assertText, flowSession, storage, getConfig, chaptersLib,
    statsLib, errorText, logError, getStatsStore, getSearchIndexStore,
    statsSummaryPayload, rememberRecentBook
  } = host;

  // chapter:save —— 原 main.js registerIpc() 内的保存段（只搬不改）
  handleBook('chapter:save', async (bookPath, chapterId, text, expectedMtimeMs) => {
    // A2（审计 E6）：全仓唯一漏掉正文校验的写盘通道。与 text:format / text:find / replace
    // 同一口径：正文必须是字符串且不超过 500 万字（core/ipc-limits.js），超限回 TEXT_TOO_LARGE。
    // C26（v1.8.0 WP-26）：null / undefined 不再当空章写盘（旧实现刻意兼容成 ''）。渲染层拿到
    // undefined 的正文变量时，旧行为是静默把整章清空 —— 写卡口宁可报 BAD_TEXT，也不能丢数据。
    const body = assertText(text);
    const session = flowSession();
    return storage.withBookLock(bookPath, async () => {
      const cfg = await getConfig();
      // 保存前校验（写盘安全检查）：书文件夹、书目、章节记录、章节文件都还在才允许写，
      // 且书不能正开在另一个窗口。任何一项失效都报错，绝不 mkdir 重建影子文件。
      // 审计修复 #5（V301）：渲染层带来的 expectedMtimeMs 也在这里比对——载入之后磁盘被
      // 应用外改过就抛 EXTERNAL_CHANGE，交给 save-rescue-ui.js 的三选，绝不静默覆盖外部版本。
      const prepared = await storage.prepareChapterSave(bookPath, chapterId, {
        windowId: session ? session.id : null,
        expectedMtimeMs
      });
      const meta = prepared.meta;
      const chapter = prepared.chapter;
      // 每日字数的「上次已知值」：优先书目里缓存的正文字符数；缓存缺失（老书/新章）时
      // 只在这一次读一遍旧文件，保证第一次保存的增量仍然准确。
      let previousChars = null;
      if (chapter.chars != null && chapter.chars !== '' && Number.isFinite(Number(chapter.chars))) {
        previousChars = Math.max(0, Math.round(Number(chapter.chars)));
      } else {
        try {
          const previous = await storage.loadChapterText(bookPath, chapter.file);
          previousChars = chaptersLib.countChars(previous.text);
        } catch (err) {
          previousChars = null; // 旧文件读不到就当「不知道」，这次不计入统计
          // C0（审计 #3 / E1）：正文马上要落盘，派生数据读不到不能挡保存；但以前这里是零日志，
          // 「今天字数少算了」事后查不到原因。只记错误码 + 脱敏后的信息（core/logs.js 遮罩路径）。
          logError('save-derived', err, { level: 'warn', code: 'CHARS_BASELINE_MISSING' });
        }
      }
      // 可选每日快照：在写正文之前复制「上一版」。默认关；失败只记原因，绝不阻塞保存。
      let snapshot = { taken: false, reason: 'DISABLED', dir: null, file: chapter.file, bytes: 0, cleanup: null };
      if (cfg.snapshotEnabled) {
        try {
          snapshot = await storage.takeDailySnapshot(bookPath, chapter.file, {
            keepDays: cfg.snapshotKeepDays,
            now: new Date()
          });
        } catch (err) {
          // C0（审计 #3 / E1）：快照失败只留痕 + 把原因带回结果，仍然绝不阻塞保存。
          logError('save-derived', err, { level: 'warn', code: 'SNAPSHOT_FAILED' });
          snapshot = {
            taken: false,
            reason: 'ERROR',
            message: errorText.describeForUi(err).message,
            dir: null,
            file: chapter.file,
            bytes: 0,
            cleanup: null
          };
        }
      }
      // SAVE-01（审计补修）：prepareChapterSave 之后还读了一遍旧字数 / 可能复制了每日快照，
      // 应用外程序若在这段时间里改写章节，下面这次写盘会静默覆盖外部那一版。写盘前再核一次
      // mtime + 内容指纹（约 1 次 stat + 8 KB 采样读），不一致抛 EXTERNAL_CHANGE。
      // 只收窄窗口、不是闭环：stat 与 rename 之间仍有极小窗口（接管路径仍是下一次保存的
      // expectedMtimeMs 校验 + 书目 stamp，见 core/open-books.js 与 writeBookMeta）。
      await storage.recheckChapterSaveTarget(bookPath, chapter, expectedMtimeMs);
      const result = await storage.saveChapterText(bookPath, chapter.file, body, {
        ensureDir: false
      });
      // 同步章节字数缓存，书架就不用为了算字数去重读整本书
      chapter.chars = result.chars;
      // 正文变了：告诉搜索索引这本书要重建（不 await，索引更新绝不能拖慢 / 挡住保存）。
      // A7（审计 E4）：挪到书目写盘之前——书目写失败时正文已经落盘了，索引也不能漏标记，
      // 否则搜索 / 校对拿到的是旧内容，而且这次部分成功会让后面重试少建一次索引。
      try {
        getSearchIndexStore().markDirty(bookPath);
      } catch (err) {
        // C0（审计 #3 / E1）：索引没标脏 → 搜索 / 校对可能一直拿旧正文；不能挡保存，但必须留痕。
        logError('save-derived', err, { level: 'warn', code: 'INDEX_DIRTY_FAILED' });
      }
      try {
        // WP1（E-N1/E-N2，中 #1/#2）：普通保存也轮换 .bak（上一版书目可退），并把 prepareChapterSave
        // 读到的 书目.json 身份交回去 —— 写前发现外部改了书目（同步盘 / 另一实例）就拒绝覆盖。
        await storage.writeBookMeta(bookPath, meta, { ensureDir: false, rotateBak: true, expectedStamp: prepared.metaStamp });
      } catch (metaErr) {
        // WP1（E-N1）：书目在「读 meta → 写正文 → 写 meta」之间被应用外改过。正文已经落盘，
        // 但书目这次不许覆盖外部那一版；再按一次保存会读到最新书目（新 stamp）后重试。
        // META_CHANGED 进救稿出口（项 3=A）：界面给「另存 / 复制 / 留在这里」，dirty 保持。
        if (metaErr.code === 'META_CHANGED') {
          throw Object.assign(
            new Error(
              '正文已写入磁盘，但书目在保存途中被应用外的程序改过，这次没有覆盖书目（外部那一版原样保留）；' +
                '再按一次保存会读入最新书目后重试'
            ),
            { code: 'META_CHANGED', mtimeMs: result.mtimeMs }
          );
        }
        // A2-STORAGE-03（低）：正文已落盘、书目没写成功 —— 内存 meta 里本章 chars 已是新正文的字数，
        // 磁盘书目还是旧值；而扫描回填只补「缺失」的章、永不重算有限值，书卡总字数会长期偏离正文。
        // 这里复用批量失败后的同一套「定点 chars 补写」（仍持书锁、尽力而为）：短暂占用 / 杀软锁
        // 过一会儿能写成功的，字数当场自愈；写不成也不掩盖下面的原始错误。
        // META_CHANGED 不走这里（上面已单独回包）：外部那一版书目不许用同一个旧 stamp 二次覆盖，
        // 作者再按一次保存会读入最新书目重试，那时 chars 自然按最新正文补上。
        await storage.persistCharsAfterFailure(bookPath, meta);
        // A7（审计 E4）：正文已经写进磁盘、书目没更新成功。不能把这次保存整体当失败——
        // 渲染层会以为正文没保存（关窗时可能让作者重写 / 丢弃刚写的内容）。回可判别的部分成功：
        // code=META_SAVE_FAILED + bodySaved:true + chars/file（见 fail() 的白名单透传），
        // 界面提示「正文已写入磁盘，但书目更新失败，可重试保存」，dirty 保持，再按保存会重试。
        throw Object.assign(
          new Error(`正文已写入磁盘，但书目更新失败（${errorText.describeForUi(metaErr).message}），可再按一次保存重试`),
          { code: 'META_SAVE_FAILED', bodySaved: true, chars: result.chars, file: chapter.file, mtimeMs: result.mtimeMs }
        );
      }
      // 每日字数统计：只记这次保存带来的正字数增量（删字不扣今天的进度）。
      // C0（审计 #3 / E1）：基线缺失时明确标记（界面在「已保存」旁弱提示「本次字数未计入」）；
      // 统计写盘失败绝不影响正文保存，只记一条 warn 日志并把原因带回去。
      const charsDelta = statsLib.saveCharsDelta(previousChars, result.chars);
      let stats = null;
      let statsDelta = charsDelta.delta;
      let statsError = null;
      const recordedStats = await statsLib.recordSaveChars(getStatsStore(), {
        day: statsLib.localDayKey(),
        bookId: meta.id,
        delta: statsDelta
      });
      if (recordedStats.ok) {
        stats = statsSummaryPayload(recordedStats.recorded.stats, cfg);
      } else {
        const statsErr = recordedStats.error;
        // MC-2（五-L21）：同 capture:commit-record 的 statsError —— 原始 message 只进日志（下面 logError
        // 自己脱敏），跨 IPC 的那份必须过 error-text，别把统计文件的绝对路径带进渲染层。
        statsError = errorText.describeForUi(statsErr).message;
        logError('save-derived', statsErr, { level: 'warn', code: 'STATS_RECORD_FAILED' });
      }
      // 保存也算「写作过」：书架「继续上次写作」的时间戳跟着更新（只写配置，不碰书库）
      await rememberRecentBook(bookPath, {
        title: meta.title,
        chapterId: chapter.id,
        chapterIndex: meta.chapters.indexOf(chapter),
        chapterName: chapter.name
      });
      if (session) {
        storage.openBookRegistry.touch(session.id);
        // C5：正文保存成功的回执时间——关窗时主进程用它和「变脏时间」比对（见 app:close-ready）
        session.lastSaveAt = Date.now();
      }
      return {
        ...result,
        file: chapter.file,
        snapshot,
        stats,
        statsDelta,
        statsError,
        // C0（审计 #3 / E1）：旧章字数读不到 → 这次增量按 0 记，界面据此弱提示「本次字数未计入」
        charsBaselineMissing: charsDelta.baselineMissing
      };
    });
  }, { mutation: MUTATION.SAVE }); // 审计修复 #38（O6）：保存成功要广播 shelf:changed（跨窗口书架字数不再滞后）
}

module.exports = { register: registerSaveIpc };
