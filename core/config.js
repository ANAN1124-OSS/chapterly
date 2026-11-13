// 配置读写：存在 Electron userData 目录，不污染小说文件夹。
// 纯 Node，可在测试里传入临时目录。
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { writeJsonAtomic, stripBom } = require('./atomic');
const { createWriteQueue } = require('./common');
const formatLib = require('./format');
const snapshotLib = require('./snapshot');
const statsLib = require('./stats');
const templateLib = require('./template');
const s2tLib = require('./s2t');
const caretColorLib = require('./caret-color');
const bookmarksLib = require('./bookmarks');
const pathUtils = require('./path-utils');

// 默认书架：当前用户的「文档\我的小说」（安装后可在应用里改）
const DEFAULT_BOOKS_ROOT = path.join(os.homedir(), 'Documents', '我的小说');
const FONTS = ['serif', 'sans', 'kai', 'custom'];
// 背景主题：纯色 4 档 + 两种纸张纹理（对应口袋写作「背景设置」里的配色/纸张纹理/夜间）
const PAPER_THEMES = ['paper', 'cream', 'green', 'night', 'kraft', 'grid'];
// 超长段落阈值（1.1.0）：单位 = 字（去空白后的字数），默认 500，允许 50–20000。
// core 不能 require 渲染层的 renderer/editor-logic.js，所以这里留一份同口径常量；
// tests/config.test.js 用 editor-logic 导出的 LONG_PARAGRAPH_DEFAULT / LONG_PARAGRAPH_LIMITS 钉住两边一致。
// 全局默认写 config.longParagraphThreshold，按书覆盖写 config.bookDisplay[本书].longParagraphThreshold。
const LONG_PARAGRAPH_DEFAULT = 500;
const LONG_PARAGRAPH_LIMITS = [50, 20000];
const DEFAULTS = Object.freeze({
  booksRoot: DEFAULT_BOOKS_ROOT,
  // windowBounds.maximized（1.7.2 D6 / V89）：既有的窗口位置记忆多记一个「上次退出时是最大化」。
  // 只加这一个子键，不新增顶层字段、不写迁移代码；旧配置没有它就按 false（普通窗口）。
  windowBounds: { x: 60, y: 40, width: 1200, height: 760, maximized: false },
  editorFont: 'serif',
  editorFontSize: 18,
  editorSidebarWidth: 250,
  // 自定义字体（editorFont = 'custom' 时生效；只记路径，不复制字体文件）
  editorCustomFontPath: '',
  editorCustomFontName: '',
  // 显示排版（写作页「排版 ▾」/ 设置里可调）
  editorLineHeight: 1.95,
  editorLetterSpacing: 0.02,
  editorPageWidth: 0, // 0 = 通栏；>0 为正文最大宽度（px）
  editorPaddingX: 56, // 正文左右边距（px）
  editorPaper: 'paper', // paper 原纸白 / cream 米黄 / green 豆绿 / night 夜间 / kraft 牛皮纸 / grid 网格纸
  // 中西文自动间距（1.3.0 T-08，规范 T-08）：默认开。只作用于渲染层的 text-autospace
  // （正文 / 阅读容器 / 标记层共用一个 CSS 变量），导出 / 复制不注入任何空白。
  // 旧配置没有这个键 = 开；写坏的类型也按「开」；只有真正的 false 才关。可被 bookDisplay 按书覆盖。
  editorTextAutospace: true,
  // 当前段落高亮（v0.8-10b，提案 N10b）：默认关；颜色 '' = 跟随当前背景主题（默认配色不变），
  // '#rrggbb' = 作者自定义。两项都可被 config.bookDisplay 按书覆盖，没设置过的书用这里的全局默认。
  caretParagraph: false,
  caretParagraphColor: '',
  // 超长段落提示的字数阈值（1.1.0）：默认 500，夹紧 50–20000；写坏 / 旧配置缺字段都回落 500。
  // 这里的值只是「全局默认」；单本书可以在 bookDisplay[本书].longParagraphThreshold 覆盖，
  // 生效阈值 = 本书覆盖 ?? 全局默认（合并发生在渲染层）。
  longParagraphThreshold: LONG_PARAGRAPH_DEFAULT,
  // 每本书的显示设置覆盖：{ [bookId]: { 只放改过的项 } }；没有覆盖的书沿用上面的全局值。
  // 编辑器小件两个开关（marksInvisibles / marksLongParagraphs）也存这里：全局默认固定 false，
  // 只有在这里记过 true / false 的书才有「本书覆盖」；longParagraphThreshold 同样可以按书覆盖。
  bookDisplay: {},
  // 「整理本章」上一次用过的规则，下次打开对话框沿用（不改正文，只是记住勾选）
  formatOptions: { ...formatLib.DEFAULT_OPTIONS },
  // 上次「导出 TXT」保存到的目录，下次导出默认还开在这里（目录没了会自动退回「文档」）
  lastExportDir: '',
  // 上次写作的书 + 章节（书架顶部「继续上次写作」用）。只是书架级记忆，书库里的
  // lastOpenChapterId 仍是「打开这本书回到哪一章」的唯一事实来源。
  // { path, title, chapterId, chapterIndex, chapterName, at }；没有写过 = null。
  lastBook: null,
  // 首次运行提示（1.3.0 T5 / 规范 I-10）：书架空态承担主引导，书架底部状态行再给一条
  // 4s 一次性提示；显示过就记这里，重开应用不再出现。默认 false = 还没提示过；
  // 只有真正的 true 才算已提示（写坏的类型按「还没提示过」处理，最多再提示一次）。
  firstRunTipShown: false,
  // 可选「每日快照」：默认关（不给作者添意外写盘）。开启后每次 Ctrl+S 成功时，
  // 当天第一次保存会把这一章的上一版复制到书内 _trash/快照-YYYYMMDD/。
  snapshotEnabled: false,
  snapshotKeepDays: snapshotLib.DEFAULT_KEEP_DAYS,
  // 每日写作目标（字数）：0 = 不设目标；只统计保存动作写下的正字数。
  // 统计本身存在 userData/stats.json，不写进书库。
  dailyGoal: statsLib.DEFAULT_GOAL,
  // 写作时长统计（v0.8-2）：默认关。开启后只在写作页手动点「写作计时」时累计秒数，
  // 只记时长不记内容，存 userData/stats.json；旧配置没有这个键 = 关。
  writeDurationEnabled: false,
  // 剪贴板联动（2026-11-05 方案 b8）：后台监听剪贴板变化并给一条轻提示；默认关，设置里开。
  // 只记开关本身——剪贴板内容只驻内存、不落盘、不写日志、不做历史（见批 D）。
  clipboardWatchEnabled: false,
  // 章节模板（v0.8 P0 N5）：新建 / 插入章节时自动填进空章的文字，默认空 = 不套用。
  // 可用占位符 {n} 章号 / {title} 章名 / {date} 今天；只改编辑区，不自动写盘。
  chapterTemplate: '',
  // 敏感词预检用的词表（作者自己的 txt，每行一个词）。应用不内置任何词表；
  // 这里只记绝对路径，词表文件本身只读、不复制、不改写。没设置 = ''。
  sensitiveWordsPath: '',
  // 校对面板用的词表（v0.8 P0 N6）：作者自己的错别字 / 禁用词 txt，每行一个词，
  // 也可以写「错词 → 建议」。和敏感词表分开两份，互不覆盖；没设置 = ''。
  proofreadWordsPath: '',
  // 多份校对词表（1.7.0 F3）：绝对路径数组，顺序 = 面板顺序，最多 8 条（清洗时截断）。
  // 旧配置没有这个键 = []，沿用上面那份单份路径，零迁移；主进程逐份读取留给 F3b。
  proofreadWordlists: [],
  // 导出时的简繁转换（v0.8 P0 N7）：'' = 不转换（默认）/ 's2t' = 简→繁 / 't2s' = 繁→简。
  // 只作用于导出的副本（TXT / EPUB），原稿与书库一个字节都不改；旧配置没有这个键 = 不转换。
  exportConversion: '',
  // 查找书签（v0.8-11b，提案 N11b）：按「书 + 章」记住查询词与大小写选项。只存查询条件
  // 与几个显示字段（书名 / 章名 / 章号 / 书路径），**不存正文、不存命中位置**；打开这一章时
  // 按当前正文重新扫描并高亮。旧配置没有这个键 = 没有书签，行为和以前完全一样。
  findBookmarks: []
});

// S4（审计 S4 / 终审版）：已知配置键的完整名单，直接从 DEFAULTS 派生——以后加配置项只改上面
// 一处，这里自动跟着长。config:set / 加载旧 config 时只认名单里的键，未知键直接丢弃：
// 以前 sanitize 用 `{...DEFAULTS, ...raw}` 起手，一个手改 / 注入的配置能把任意大对象写进
// config.json，再整份回给渲染层。旧配置缺少新键不在这里处理（下面各字段清洗时补默认值）。
const KNOWN_KEYS = Object.freeze(Object.keys(DEFAULTS));

// 四舍五入的整数夹紧（和 core/common.js 的 clampInt 不是一件事：那个是向下取整、
// 参数是 [下限, 上限] 数组）。这里保留自己的参数顺序，因为 12 个调用点都是「常量下限 + 常量上限 + 默认值」；
// v0.9 B-3 把名字改清楚，避免和公共 clampInt 混在一起。
function clampRoundedInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampFloat(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(Math.min(max, Math.max(min, n)) * 100) / 100;
}

// 超长段落阈值（1.1.0）：只认数字 / 数字字符串（数字字符串兼容手改配置），其余一律回落 500。
// 不能直接用 clampRoundedInt：Number(null) / Number('') / Number([]) 都是 0，会被夹成下限 50，
// 而「没填 / 写坏」按需求应回落到默认 500。
function normalizeLongParagraphThreshold(value, fallback = LONG_PARAGRAPH_DEFAULT) {
  let n = NaN;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value.trim());
  if (!Number.isFinite(n)) return fallback;
  return Math.min(LONG_PARAGRAPH_LIMITS[1], Math.max(LONG_PARAGRAPH_LIMITS[0], Math.round(n)));
}

// 单本书的显示设置覆盖：只保留传进来的键（没传的项继续用全局值）
function sanitizeBookDisplayEntry(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const has = (key) => Object.prototype.hasOwnProperty.call(raw, key);
  if (has('editorFont')) {
    out.editorFont = FONTS.includes(raw.editorFont) ? raw.editorFont : DEFAULTS.editorFont;
  }
  if (has('editorCustomFontPath')) {
    const value = typeof raw.editorCustomFontPath === 'string' ? raw.editorCustomFontPath.trim() : '';
    out.editorCustomFontPath = value.length > 1000 ? '' : value;
  }
  if (has('editorCustomFontName')) {
    const value = typeof raw.editorCustomFontName === 'string' ? raw.editorCustomFontName.trim() : '';
    out.editorCustomFontName = value.length > 200 ? '' : value;
  }
  if (has('editorFontSize')) out.editorFontSize = clampRoundedInt(raw.editorFontSize, 12, 30, DEFAULTS.editorFontSize);
  if (has('editorSidebarWidth')) {
    out.editorSidebarWidth = clampRoundedInt(raw.editorSidebarWidth, 180, 800, DEFAULTS.editorSidebarWidth);
  }
  if (has('editorLineHeight')) {
    out.editorLineHeight = clampFloat(raw.editorLineHeight, 1.2, 3, DEFAULTS.editorLineHeight);
  }
  if (has('editorLetterSpacing')) {
    out.editorLetterSpacing = clampFloat(raw.editorLetterSpacing, 0, 0.2, DEFAULTS.editorLetterSpacing);
  }
  if (has('editorPageWidth')) {
    const width = Number(raw.editorPageWidth);
    out.editorPageWidth = Number.isFinite(width) && width > 0
      ? clampRoundedInt(width, 600, 1600, DEFAULTS.editorPageWidth)
      : 0;
  }
  if (has('editorPaddingX')) out.editorPaddingX = clampRoundedInt(raw.editorPaddingX, 16, 200, DEFAULTS.editorPaddingX);
  if (has('editorPaper')) {
    out.editorPaper = PAPER_THEMES.includes(raw.editorPaper) ? raw.editorPaper : DEFAULTS.editorPaper;
  }
  // 中西文自动间距（1.3.0 T-08）：默认开，只有真正的 false 才关（'false' / 0 / null 这类坏值都按开）。
  if (has('editorTextAutospace')) out.editorTextAutospace = raw.editorTextAutospace !== false;
  // 当前段落高亮（v0.8-10b）：开关只认真正的 true / false（写错类型按全局默认 false），
  // 颜色只认 #rgb / #rrggbb；写坏了一律当「跟随主题」（'' 也是一个有效的按书覆盖值）。
  if (has('caretParagraph')) out.caretParagraph = raw.caretParagraph === true;
  if (has('caretParagraphColor')) {
    out.caretParagraphColor = caretColorLib.normalizeColor(raw.caretParagraphColor);
  }
  // 编辑器小件两个开关按书记忆（1.1.0）：和当前段落高亮同一口径——只认真正的 true / false，
  // 写坏的类型一律当 false（= 回落默认关）。全局默认固定 false，只有本书覆盖会写进这里。
  if (has('marksInvisibles')) out.marksInvisibles = raw.marksInvisibles === true;
  if (has('marksLongParagraphs')) out.marksLongParagraphs = raw.marksLongParagraphs === true;
  // 超长段落阈值按书覆盖（1.1.0）：与全局默认同一口径夹到 50–20000，非法值回落 500。
  if (has('longParagraphThreshold')) {
    out.longParagraphThreshold = normalizeLongParagraphThreshold(raw.longParagraphThreshold);
  }
  // 覆盖成「自定义字体」但没带字体路径：这一项不算数，回落到全局字体
  if (out.editorFont === 'custom' && !out.editorCustomFontPath) delete out.editorFont;
  return out;
}

function sanitizeBookDisplay(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [bookId, entry] of Object.entries(raw)) {
    const key = typeof bookId === 'string' ? bookId.trim() : '';
    if (!key || key.length > 200) continue;
    const clean = sanitizeBookDisplayEntry(entry);
    if (Object.keys(clean).length) out[key] = clean;
  }
  return out;
}

// 「继续上次写作」：只记书架级的位置，读的时候一律清洗；坏值/空值当作没记过（null），
// 不影响旧配置文件（没有 lastBook 就显示不出入口，其余功能照常）。
function sanitizeLastBook(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const bookPath = typeof raw.path === 'string' ? raw.path.trim() : '';
  if (!bookPath || bookPath.length > 1000) return null;
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 200) : '';
  const chapterId = typeof raw.chapterId === 'string' ? raw.chapterId.trim().slice(0, 100) : '';
  const chapterName = typeof raw.chapterName === 'string' ? raw.chapterName.trim().slice(0, 200) : '';
  const at = Number(raw.at);
  return {
    path: bookPath,
    title,
    chapterId,
    chapterIndex: clampRoundedInt(raw.chapterIndex, 0, 1000000, 0),
    chapterName,
    at: Number.isFinite(at) && at > 0 ? Math.round(at) : 0
  };
}

// 多份校对词表的条数上限（1.7.0 F3a）：面板上再多也读不完，超过的截断。
// 1.7.2 D4（V42）：这是唯一一处定义，main.js 从这里 require（文案也用这个常量拼），别再声明同名常量。
const WORDLIST_MAX = 8;

// 多份校对词表的路径清洗（1.7.0 F3a；1.7.1 V51/V48）：必须数组、最多 WORDLIST_MAX 条、只留字符串、
// trim、只收绝对路径、去重（判「同一份」走 core/path-utils.js 的 pathKey：resolve + 小写 + Windows
// 正斜杠归反斜杠，和 config-gate / main.js 同一口径；保留作者写的原字符串与顺序）。
// 存在性不在写入时判——读不到时由读取侧的 GLOSSARY_MISSING 报给用户；这里只管形状，也不做同步
// stat（断开的 UNC / 网络盘不再卡主进程的配置写路径）。坏条目逐条丢掉、不抛错。
function sanitizeWordlistPaths(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (out.length >= WORDLIST_MAX) break;
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > 1000) continue;
    if (!path.isAbsolute(trimmed)) continue;
    const key = pathUtils.pathKey(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function sanitize(raw) {
  // S4（审计 S4）：只认 DEFAULTS 里登记过的键——未知键丢弃（以前是原样透传）。
  // 旧配置缺新键不受影响：下面各字段清洗时会从 DEFAULTS 补默认值。
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const cfg = { ...DEFAULTS };
  for (const key of KNOWN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) cfg[key] = source[key];
  }

  if (typeof cfg.booksRoot !== 'string' || !cfg.booksRoot.trim() || cfg.booksRoot.length > 1000) {
    cfg.booksRoot = DEFAULTS.booksRoot;
  }

  cfg.editorFont = FONTS.includes(cfg.editorFont) ? cfg.editorFont : DEFAULTS.editorFont;
  cfg.editorFontSize = clampRoundedInt(cfg.editorFontSize, 12, 30, DEFAULTS.editorFontSize);
  // 章节栏宽度（拖动分隔条调整，双击恢复默认）
  cfg.editorSidebarWidth = clampRoundedInt(cfg.editorSidebarWidth, 180, 800, DEFAULTS.editorSidebarWidth);

  // 自定义字体：路径只做基本清洗，选中的字体没了会回落到内置字体
  // S4：长度加上限（路径 1000 / 显示用的字体名 200），坏值一律当「没设置」。
  cfg.editorCustomFontPath = typeof cfg.editorCustomFontPath === 'string' ? cfg.editorCustomFontPath.trim() : '';
  if (cfg.editorCustomFontPath.length > 1000) cfg.editorCustomFontPath = '';
  cfg.editorCustomFontName = typeof cfg.editorCustomFontName === 'string' ? cfg.editorCustomFontName.trim() : '';
  if (cfg.editorCustomFontName.length > 200) cfg.editorCustomFontName = '';
  if (cfg.editorFont === 'custom' && !cfg.editorCustomFontPath) cfg.editorFont = DEFAULTS.editorFont;

  // 显示排版：行距 / 字距 / 正文宽度 / 左右边距 / 背景主题
  cfg.editorLineHeight = clampFloat(cfg.editorLineHeight, 1.2, 3, DEFAULTS.editorLineHeight);
  cfg.editorLetterSpacing = clampFloat(cfg.editorLetterSpacing, 0, 0.2, DEFAULTS.editorLetterSpacing);
  const pageWidth = Number(cfg.editorPageWidth);
  cfg.editorPageWidth = Number.isFinite(pageWidth) && pageWidth > 0
    ? clampRoundedInt(pageWidth, 600, 1600, DEFAULTS.editorPageWidth)
    : 0;
  cfg.editorPaddingX = clampRoundedInt(cfg.editorPaddingX, 16, 200, DEFAULTS.editorPaddingX);
  cfg.editorPaper = PAPER_THEMES.includes(cfg.editorPaper) ? cfg.editorPaper : DEFAULTS.editorPaper;
  // 中西文自动间距（1.3.0 T-08）：默认开。旧配置没有这个键、写坏的类型都按「开」，
  // 只有真正的 false 才关——这样手改配置写个 'false' 也不会意外把间距关掉。
  cfg.editorTextAutospace = cfg.editorTextAutospace !== false;
  // 当前段落高亮（v0.8-10b）：旧配置没有这两个键 = 关 / 跟随主题，行为和以前完全一样。
  cfg.caretParagraph = cfg.caretParagraph === true;
  cfg.caretParagraphColor = caretColorLib.normalizeColor(cfg.caretParagraphColor);
  // 超长段落阈值（1.1.0）：默认 500、夹紧 50–20000，坏值 / 旧配置缺字段都回落 500。
  cfg.longParagraphThreshold = normalizeLongParagraphThreshold(cfg.longParagraphThreshold);
  cfg.bookDisplay = sanitizeBookDisplay(cfg.bookDisplay);
  cfg.formatOptions = formatLib.sanitizeOptions(cfg.formatOptions);
  // 上次导出的目录：只做基本清洗，路径不存在时由主进程退回「文档」目录
  const lastExportDir = typeof cfg.lastExportDir === 'string' ? cfg.lastExportDir.trim() : '';
  cfg.lastExportDir = lastExportDir.length > 1000 ? '' : lastExportDir;
  cfg.lastBook = sanitizeLastBook(cfg.lastBook);
  // 首次运行提示（1.3.0 T5）：只认真正的 true；缺字段 / 写坏类型都按「还没提示过」。
  cfg.firstRunTipShown = cfg.firstRunTipShown === true;
  // 每日快照：只认真正的 true（缺字段 / 写错类型都按「关」，不会因为脏配置自动写盘）；
  // 保留天数夹在 1–90 天，坏值回落 7 天。
  cfg.snapshotEnabled = cfg.snapshotEnabled === true;
  cfg.snapshotKeepDays = snapshotLib.normalizeKeepDays(
    cfg.snapshotKeepDays,
    snapshotLib.DEFAULT_KEEP_DAYS
  );
  // 每日目标：0 = 不设目标；负数 / NaN 回落 0，超大值夹到上限；旧配置没有这个键照常启动。
  cfg.dailyGoal = statsLib.normalizeGoal(cfg.dailyGoal, DEFAULTS.dailyGoal);
  // 写作时长统计：只认真正的 true（缺字段 / 写错类型都按「关」）。
  cfg.writeDurationEnabled = cfg.writeDurationEnabled === true;
  // 剪贴板监听（批 D b8）：只认真正的 true（缺字段 / 写错类型都按「关」），默认关。
  cfg.clipboardWatchEnabled = cfg.clipboardWatchEnabled === true;
  // 章节模板：换行统一成 \n、去掉 NUL、夹到长度上限；非字符串 / 旧配置缺键都当空模板。
  cfg.chapterTemplate = templateLib.sanitizeTemplate(cfg.chapterTemplate);
  // 敏感词表路径：只做基本清洗（非字符串 / 超长 → 未设置）；文件不存在时由预检面板提示，
  // 不会因为词表被移走就让应用起不来。旧配置没有这个键 = 未设置。
  const sensitiveWordsPath =
    typeof cfg.sensitiveWordsPath === 'string' ? cfg.sensitiveWordsPath.trim() : '';
  cfg.sensitiveWordsPath = sensitiveWordsPath.length > 1000 ? '' : sensitiveWordsPath;
  // 校对词表路径：同样的基本清洗（非字符串 / 超长 → 未设置）；文件没了只在校对面板提示，
  // 不会因为词表被移走就让应用起不来。旧配置没有这个键 = 未设置。
  const proofreadWordsPath =
    typeof cfg.proofreadWordsPath === 'string' ? cfg.proofreadWordsPath.trim() : '';
  cfg.proofreadWordsPath = proofreadWordsPath.length > 1000 ? '' : proofreadWordsPath;
  // 多份校对词表（1.7.0 F3a；1.7.1 V51）：见 sanitizeWordlistPaths 的口径——数组 / 最多 8 条 /
  // 只留字符串 / trim / 绝对路径 / 去重（Windows 大小写与正反斜杠归一）；不判存在性（读不到由
  // 读取侧报 GLOSSARY_MISSING）。坏条目逐条丢弃、不抛错。
  // 旧配置没有这个键 = []，单份 proofreadWordsPath 仍按上面那套旧逻辑，行为不变。
  cfg.proofreadWordlists = sanitizeWordlistPaths(cfg.proofreadWordlists);
  // 导出简繁转换：只认 '', 's2t', 't2s'；旧配置没有这个键 / 手改坏了都按「不转换」，
  // 不会因为一个脏值让导出变成另一种字形。
  cfg.exportConversion = s2tLib.normalizeMode(cfg.exportConversion);
  // 查找书签（v0.8-11b）：只认数组；坏条目 / 重复的「书 + 章」丢掉，最多 200 条。
  // 旧配置没有 findBookmarks = 没有书签，其它字段照常。
  cfg.findBookmarks = bookmarksLib.sanitizeBookmarks(cfg.findBookmarks);

  // 窗口位置记忆（1.7.2 D6 / V89）：四个标量照旧，另放行一个布尔子键 maximized —— 上次退出时
  // 是不是最大化。不清洗就会在每次 configStore.set 时被丢掉，重启出来是「铺满但没最大化」的
  // 假最大化，而且不报错（功能静默失效）。只认真正的 true，缺字段 / 旧配置 / 写坏的类型都是 false。
  const b = cfg.windowBounds;
  if (b && typeof b === 'object' && Number.isFinite(Number(b.width)) && Number.isFinite(Number(b.height))) {
    cfg.windowBounds = {
      x: Number.isFinite(Number(b.x)) ? Math.round(Number(b.x)) : DEFAULTS.windowBounds.x,
      y: Number.isFinite(Number(b.y)) ? Math.round(Number(b.y)) : DEFAULTS.windowBounds.y,
      width: clampRoundedInt(b.width, 960, 4000, DEFAULTS.windowBounds.width),
      height: clampRoundedInt(b.height, 620, 3000, DEFAULTS.windowBounds.height),
      maximized: b.maximized === true
    };
  } else {
    cfg.windowBounds = { ...DEFAULTS.windowBounds };
  }

  return cfg;
}

// A1（审计 E1 / P0-1）：写盘成功后才更新内存 cache。
// 旧实现是「先 cache = sanitize(...) 再 writeJsonAtomic」，写失败（磁盘满 / 权限 / 文件被占用）
// 时内存已是新值 → 界面显示「已保存」，重启后回退；对 booksRoot 会造成「书不见了」的假象。
// deps.write 只给测试注入坏写盘用，生产调用不传，默认仍走 core/atomic.writeJsonAtomic。
function createConfigStore(userDataDir, deps = {}) {
  const file = path.join(userDataDir, 'config.json');
  const writeJson = typeof deps.write === 'function' ? deps.write : writeJsonAtomic;
  // deps.readFile 同样只给测试注入坏读盘（EACCES / EIO / EBUSY）用，生产走 node:fs/promises。
  const readJson = typeof deps.readFile === 'function' ? deps.readFile : (target, encoding) => fs.readFile(target, encoding);
  let cache = null;
  let loadWarning = null; // 配置损坏被归档时，给界面提示一次
  // 配置写入串行化：并发 set 时各自拿旧 cache 合并会吞掉对方的 patch（例如拖完分隔条同时点保存设置）
  // —— 队列实现见 core/common.js 的 createWriteQueue（B6：与碎片 / 日志 / 统计四个 store 共用一份）。
  const writeQueue = createWriteQueue();
  const enqueue = writeQueue.enqueue;

  function defaults() {
    return { ...DEFAULTS, windowBounds: { ...DEFAULTS.windowBounds }, bookDisplay: {}, findBookmarks: [] };
  }

  async function load() {
    let raw;
    try {
      raw = await readJson(file, 'utf8');
    } catch (err) {
      // A5（审计 E2）：只有 ENOENT 才算「首次启动」。EACCES / EIO / EBUSY / 目录被占用等读失败
      // 以前也被静默当成「没有配置文件」——书架悄悄回到默认目录（作者会以为书全没了），而且下一次
      // 保存设置会把读不到的那份配置整个覆盖掉。现在：不阻断启动（仍回默认值），但记一条一次性
      // 提示（界面启动后取到）+ 带错误码，不给排障留空白。坏 JSON 的归档逻辑保持原样（见下面）。
      if (!err || err.code !== 'ENOENT') {
        cache = defaults();
        loadWarning = {
          code: 'CONFIG_READ_FAILED',
          errorCode: (err && err.code) || 'UNKNOWN',
          message: `配置文件读取失败（${(err && err.code) || '未知错误'}），本次使用默认设置；请检查文件权限或磁盘后重启应用。`
        };
        return { ...cache };
      }
      // 没有配置文件 = 首次启动，用默认值（这不算损坏，不提示）
      cache = defaults();
      return { ...cache };
    }
    try {
      cache = sanitize(JSON.parse(stripBom(raw)));
    } catch {
      // 配置坏了：先归档损坏文件（不直接删），再回默认值，并让界面提示一次，
      // 否则书架路径会悄悄变回「文档\我的小说」，用户会以为书全没了。
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const archived = `${file}.corrupt-${stamp}`;
      try {
        await fs.rename(file, archived);
      } catch {
        /* 归档失败也不能阻塞启动 */
      }
      cache = defaults();
      loadWarning = {
        code: 'CONFIG_CORRUPT',
        archived,
        message: `配置文件损坏，已归档为 ${path.basename(archived)} 并恢复默认设置；书架目录请在「设置」里重新指定。`
      };
    }
    return { ...cache };
  }

  // 取出「配置损坏」提示（只给一次）
  function takeLoadWarning() {
    const warning = loadWarning;
    loadWarning = null;
    return warning;
  }

  async function get() {
    if (!cache) await load();
    return { ...cache };
  }

  function set(patch) {
    return enqueue(async () => {
      const current = await get();
      const next = sanitize({ ...current, ...(patch || {}) });
      // 先写盘：失败就抛出，cache 保持旧值（内存不再「假装已保存」）
      await writeJson(file, next);
      cache = next;
      return { ...cache };
    });
  }

  // ---------- 每本书的显示设置覆盖 ----------
  async function getBookDisplay(bookId) {
    const cfg = await get();
    const key = String(bookId == null ? '' : bookId).trim();
    if (!key) return {};
    return { ...(cfg.bookDisplay[key] || {}) };
  }

  async function setBookDisplay(bookId, patch) {
    return enqueue(async () => {
      const cfg = await get();
      const key = String(bookId == null ? '' : bookId).trim();
      if (!key) throw new Error('缺少书籍 id');
      const merged = sanitizeBookDisplayEntry({ ...(cfg.bookDisplay[key] || {}), ...(patch || {}) });
      const bookDisplay = { ...cfg.bookDisplay };
      if (Object.keys(merged).length) bookDisplay[key] = merged;
      else delete bookDisplay[key];
      const next = sanitize({ ...cfg, bookDisplay });
      await writeJson(file, next);
      cache = next;
      return { ...(cache.bookDisplay[key] || {}) };
    });
  }

  async function resetBookDisplay(bookId) {
    return enqueue(async () => {
      const cfg = await get();
      const key = String(bookId == null ? '' : bookId).trim();
      if (!key || !cfg.bookDisplay[key]) return false;
      const bookDisplay = { ...cfg.bookDisplay };
      delete bookDisplay[key];
      const next = sanitize({ ...cfg, bookDisplay });
      await writeJson(file, next);
      cache = next;
      return true;
    });
  }

  // ---------- 查找书签（v0.8-11b，提案 N11b）----------
  // 按「书 + 章」原子增 / 删；不在渲染层整份覆盖数组，两个窗口各存各的书签也不会互相吞掉。
  // 只写 userData/config.json，绝不碰书库 / 书目 / 章节文件。
  async function listFindBookmarks() {
    const cfg = await get();
    return (cfg.findBookmarks || []).map((item) => ({ ...item }));
  }

  function upsertFindBookmark(entry) {
    return enqueue(async () => {
      const cfg = await get();
      const clean = bookmarksLib.normalizeBookmark(entry);
      if (!clean) throw new Error('书签缺少书籍 / 章节 id 或查找词');
      const list = bookmarksLib.upsertBookmark(cfg.findBookmarks, clean);
      const next = sanitize({ ...cfg, findBookmarks: list });
      await writeJson(file, next);
      cache = next;
      const bookmark = bookmarksLib.findBookmark(cache.findBookmarks, clean.bookId, clean.chapterId);
      return {
        list: cache.findBookmarks.map((item) => ({ ...item })),
        bookmark: bookmark ? { ...bookmark } : null
      };
    });
  }

  function removeFindBookmark(bookId, chapterId) {
    return enqueue(async () => {
      const cfg = await get();
      const list = bookmarksLib.removeBookmark(cfg.findBookmarks, bookId, chapterId);
      const next = sanitize({ ...cfg, findBookmarks: list });
      await writeJson(file, next);
      cache = next;
      return { list: cache.findBookmarks.map((item) => ({ ...item })) };
    });
  }

  return {
    file,
    load,
    get,
    set,
    takeLoadWarning,
    getBookDisplay,
    setBookDisplay,
    resetBookDisplay,
    listFindBookmarks,
    upsertFindBookmark,
    removeFindBookmark,
    defaults: DEFAULTS
  };
}

// A3（审计 #9 / O1）：--books-root 只在进程内覆盖「书架根目录」这一个字段，不改 config.json 里存的值。
// 这里是唯一实现：main.js 的装饰层只调用它一次，任何配置写入口都不许再抄一份同形覆盖——
// 这条口径决定 assertBookPath 认哪个根目录，漏抄一处就会出现「界面显示 A、路径校验按 B」的漂移。
// override 为空（正常启动；argValue 没命中返回 null；--books-root= 空串）时原样返回同一个对象
// （保持「没有覆盖＝零拷贝」的旧行为）；有值时返回浅拷贝，绝不改调用方那只对象。
function withBooksRootOverride(config, override) {
  if (!override) return config;
  return { ...config, booksRoot: override };
}

module.exports = {
  createConfigStore,
  DEFAULTS,
  WORDLIST_MAX,
  sanitize,
  sanitizeLastBook,
  withBooksRootOverride
};
