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
// tests/config-store.test.js（T9 起从 config.test.js 拆出）用 editor-logic 导出的
// LONG_PARAGRAPH_DEFAULT / LONG_PARAGRAPH_LIMITS 钉住两边一致。
// 全局默认写 config.longParagraphThreshold，按书覆盖写 config.bookDisplay[本书].longParagraphThreshold。
const LONG_PARAGRAPH_DEFAULT = 500;
const LONG_PARAGRAPH_LIMITS = [50, 20000];
// D-7（V110）：配置文件结构版本。本版 = 1。任何一次写盘都会带上它（旧配置没有这个键 = 1，零迁移）；
// 读到更高的版本时保留版本号 + 限类型/大小后的未知顶层键（见 sanitize），让「新版本写过 → 回退旧版本
// 再保存一次」不再把新字段静默抹掉。上限只防手改出 1e308 这种无意义值，不参与判断。
const CONFIG_VERSION = 1;
const CONFIG_VERSION_MAX = 1000000;
// V103（v1.8.0 WP-26）：窗口宽 / 高的配置上限。以前是 4000 / 3000，超宽屏（5K）的正常窗口
// 会被截小；这里放宽到只挡离谱坏值，实际显示范围由 main.js 的 clampBounds 按 screen.workArea 夹。
const MAX_WINDOW_DIMENSION = 20000;
const DEFAULTS = Object.freeze({
  // 配置结构版本（本版 = 1）：放第一个，config.json 落盘时一眼能看到自己出自哪一版的结构。
  configVersion: CONFIG_VERSION,
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
  // v1.8.2 WP5（N1 / 中 #6，作者拍板项 1=B）：可选「崩溃恢复草稿」，默认关。
  // 开启后写作页每 30 秒把未保存正文写进 %APPDATA%\chapter-writer\crash-drafts（只写 userData，
  // 不写书库 / 书目 / 章节 txt），下次启动或渲染进程崩溃重载时提示恢复。**这不是自动保存**：
  // 恢复出来的正文仍只是编辑区内容，按 Ctrl+S 才写盘；干净退出会清掉草稿与运行标记。
  crashDraftEnabled: false,
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
// D-7（V110）补充：只有「更高版本」（configVersion > 本版）的配置才保留未知顶层键（限类型 / 深度 /
// 大小，见 sanitizeUnknownTopKeys）；同版本 / 低版本的未知键仍按 S4 丢弃，防注入口径不松。
const KNOWN_KEYS = Object.freeze(Object.keys(DEFAULTS));
const KNOWN_KEY_SET = new Set(KNOWN_KEYS);

// T-16（三审）：只认「真的数值」与「非空数字字符串」。Number(null) / Number('') / Number(false) /
// Number([]) 都是 0，能通过 isFinite 被夹成下限（字号 12、窗口 (0,0)），而 undefined 回落默认值 ——
// 同一个「没填 / 写坏」被清洗成两种结果。这里先把这些「零的伪装」判掉（手改配置里的 "18" 仍兼容）。
function numericInput(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value.trim());
  return NaN;
}

// 四舍五入的整数夹紧（和 core/common.js 的 clampInt 不是一件事：那个是向下取整、
// 参数是 [下限, 上限] 数组）。这里保留自己的参数顺序，因为 12 个调用点都是「常量下限 + 常量上限 + 默认值」；
// v0.9 B-3 把名字改清楚，避免和公共 clampInt 混在一起。
function clampRoundedInt(value, min, max, fallback) {
  const n = numericInput(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampFloat(value, min, max, fallback) {
  const n = numericInput(value);
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
  let count = 0;
  for (const [bookId, entry] of Object.entries(raw)) {
    if (count >= BOOK_DISPLAY_MAX) break; // 五-M28（CI-5）：条目数有界（插入顺序保留先出现的）
    const key = typeof bookId === 'string' ? bookId.trim() : '';
    if (!key || key.length > 200) continue;
    const clean = sanitizeBookDisplayEntry(entry);
    if (Object.keys(clean).length) {
      setOwnEntry(out, key, clean);
      count += 1;
    }
  }
  return out;
}

// C29（v1.8.0 WP-26）：bookDisplay 的键是书 id，渲染层可以传 `__proto__` 这类特殊字符串。
// 普通赋值 `obj['__proto__'] = {...}` 改的是对象原型而不是加条目 —— 这本书的显示覆盖会
// 静默丢失（Object.keys / spread 都看不到），所以统一用 defineProperty 写成自有可枚举属性。
function setOwnEntry(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  return target;
}

// C28（v1.8.0 WP-26）：最近书去重窗口。打开书时 open + set-last 会连着报同一个位置，
// 5 秒内不重复写盘（换章照常更新）；判断在 configStore 的写队列里做（见 rememberLastBook）。
const RECENT_BOOK_DEDUPE_MS = 5000;

// WP14 X-N7（审计低批）：lastBook.at 的未来容差。
// at 只要求「有限正数」时，一次时钟前跳（或渲染层 bug）写入的远未来时间戳会让
// rememberLastBook 的 stale 守卫（prev.at > next.at）把之后所有正常记录都判 stale，
// 「继续上次写作」冻结到时钟追上。写入 / 读取时把「超过 now + 10 分钟」的 at 夹到 now
// （正常的多窗口时钟抖动远小于这个窗口，容差内的轻微未来值原样保留）。
const MAX_LAST_BOOK_FUTURE_MS = 10 * 60 * 1000;

// T-13（三审）：时钟回拨的镜像防护。prev.at 是回拨前写下的正常值，回拨后它会落在「现在」的未来：
// stale 守卫（prev.at > next.at）与同章去重（now - prev.at < dedupeMs 对负数也成立）会把之后所有
// 切章记录静默判掉 ——「继续上次写作」冻结到时钟追上，没有提示。超过本容差、仍落在未来的 prev.at
// 视为病值：两条守卫都不再采信它（X-N7 只管写入远未来，管不到回拨）。容差内（多窗口几秒时钟抖动）
// 的保护口径不变。
const LAST_BOOK_CLOCK_SKEW_MS = 30 * 1000;

// 「继续上次写作」：只记书架级的位置，读的时候一律清洗；坏值/空值当作没记过（null），
// 不影响旧配置文件（没有 lastBook 就显示不出入口，其余功能照常）。
// now 只用于 X-N7 的未来容差（不传 = 现在）；显式传入让 rememberLastBook 与清洗用同一个时钟。
function sanitizeLastBook(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const bookPath = typeof raw.path === 'string' ? raw.path.trim() : '';
  if (!bookPath || bookPath.length > 1000) return null;
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 200) : '';
  const chapterId = typeof raw.chapterId === 'string' ? raw.chapterId.trim().slice(0, 100) : '';
  const chapterName = typeof raw.chapterName === 'string' ? raw.chapterName.trim().slice(0, 200) : '';
  const rawAt = Number(raw.at);
  const clock = Number.isFinite(Number(now)) ? Math.round(Number(now)) : Date.now();
  const at = Number.isFinite(rawAt) && rawAt > 0 ? Math.round(rawAt) : 0;
  return {
    path: bookPath,
    title,
    chapterId,
    chapterIndex: clampRoundedInt(raw.chapterIndex, 0, 1000000, 0),
    chapterName,
    // 过去的 at 原样保留（历史记录照常显示）；只有明显越界的远未来才夹到 now
    // （容差内的轻微时钟抖动保留原值，避免多窗口记录被抹平）。
    at: at > 0 ? (at > clock + MAX_LAST_BOOK_FUTURE_MS ? clock : at) : 0
  };
}

// 多份校对词表的条数上限（1.7.0 F3a）：面板上再多也读不完，超过的截断。
// 1.7.2 D4（V42）：这是唯一一处定义，main.js 从这里 require（文案也用这个常量拼），别再声明同名常量。
const WORDLIST_MAX = 8;

// 五-M28（CI-5）：按书显示设置（bookDisplay）的条目数上限。它是唯一没有总量闸的已知配置键 ——
// 每次 get() 都全量深拷贝、每次自动写盘都整份序列化，注入威胁模型下一次 config:set 就能写数十 MB。
// 2000 本条足够覆盖正常书库（书架几十本到几百本）；超出的按插入顺序截断，不抛错、不静默涨回去。
// config-gate.filterBookDisplayMapPatch 用同一个常量挡整份超大 patch（那边从本模块 require）。
const BOOK_DISPLAY_MAX = 2000;

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

// ---------- D-7（V110）：配置版本与前向兼容 ----------
// 未知顶层键的放行上限：只有更高版本的配置才走到这里，而且必须限住，免得把「任意大对象」重新
// 变成写进 config.json / 回给渲染层的通道（S4 防的就是这个）。超限的键整条丢弃，不截断、不改写。
const UNKNOWN_TOP_KEY_MAX = 100;
const UNKNOWN_KEY_LENGTH_MAX = 200;
const UNKNOWN_DEPTH_MAX = 8;
const UNKNOWN_ARRAY_MAX = 1000;
const UNKNOWN_OBJECT_KEY_MAX = 200;
const UNKNOWN_TEXT_MAX = 8000;
const UNKNOWN_VALUE_BYTES_MAX = 16 * 1024;
const UNKNOWN_TOTAL_BYTES_MAX = 64 * 1024;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// 版本号只做整数化：缺键 / 坏值（null / '' / 非数字 / 负数）= 本版；更高版本原样保留（不降级）。
function normalizeConfigVersion(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return CONFIG_VERSION;
  const rounded = Math.round(n);
  if (rounded < CONFIG_VERSION) return CONFIG_VERSION;
  return Math.min(rounded, CONFIG_VERSION_MAX);
}

// 深拷贝一个未知键的值，只认 JSON 能表达的类型。**要么原样透传，要么整条丢弃**：值里任何一处
// 越界（类型 / 深度 / 长度 / 条目数）或出现不安全键，都返回 undefined，不做半截改写。
function copyUnknownValue(value, depth) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'boolean') return value;
  if (type === 'number') return Number.isFinite(value) ? value : undefined;
  if (type === 'string') return value.length > UNKNOWN_TEXT_MAX ? undefined : value;
  if (type !== 'object' || depth >= UNKNOWN_DEPTH_MAX) return undefined;
  if (Array.isArray(value)) {
    if (value.length > UNKNOWN_ARRAY_MAX) return undefined;
    const list = [];
    for (const item of value) {
      const clean = copyUnknownValue(item, depth + 1);
      if (clean === undefined) return undefined;
      list.push(clean);
    }
    return list;
  }
  const keys = Object.keys(value);
  if (keys.length > UNKNOWN_OBJECT_KEY_MAX) return undefined;
  const entries = [];
  for (const key of keys) {
    if (key.length > UNKNOWN_KEY_LENGTH_MAX || UNSAFE_KEYS.has(key)) return undefined;
    const clean = copyUnknownValue(value[key], depth + 1);
    if (clean === undefined) return undefined;
    entries.push([key, clean]);
  }
  return Object.fromEntries(entries);
}

// 高版本配置的未知顶层键：限类型 / 深度 / 单值大小 / 总大小后原样透传。返回的是一个新对象，
// 调用方把它并进 sanitize 的结果里；这样任何一次常规保存都会把这些键一起写回去（不降级）。
function sanitizeUnknownTopKeys(source) {
  const entries = [];
  let totalBytes = 0;
  for (const key of Object.keys(source)) {
    if (KNOWN_KEY_SET.has(key)) continue;
    if (entries.length >= UNKNOWN_TOP_KEY_MAX) break;
    if (typeof key !== 'string' || !key || key.length > UNKNOWN_KEY_LENGTH_MAX) continue;
    if (UNSAFE_KEYS.has(key)) continue;
    const clean = copyUnknownValue(source[key], 0);
    if (clean === undefined) continue;
    let bytes = 0;
    try {
      bytes = Buffer.byteLength(JSON.stringify([key, clean]), 'utf8');
    } catch {
      continue;
    }
    if (bytes > UNKNOWN_VALUE_BYTES_MAX) continue;
    if (totalBytes + bytes > UNKNOWN_TOTAL_BYTES_MAX) break;
    totalBytes += bytes;
    entries.push([key, clean]);
  }
  return Object.fromEntries(entries);
}

// CSTO-B-01（2026-11-21 第五轮审计）：sanitize 可选 { unknownKeysFrom }。
// 默认（读盘归一）保留「这份配置里」的未知键；config:set 这种不可信输入通道必须传 current ——
// 只保留磁盘上本来就有、且版本本来就更高的未知键，patch 新带进来的未知键一律丢弃。
function sanitize(raw, options = {}) {
  // S4（审计 S4）：只认 DEFAULTS 里登记过的键——未知键丢弃（以前是原样透传）。
  // 旧配置缺新键不受影响：下面各字段清洗时会从 DEFAULTS 补默认值。
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const unknownSource =
    options && options.unknownKeysFrom && typeof options.unknownKeysFrom === 'object'
      ? options.unknownKeysFrom
      : source;
  const cfg = { ...DEFAULTS };
  for (const key of KNOWN_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) cfg[key] = source[key];
  }
  // D-7（V110）：版本号先归一。缺键 / 坏值 = 本版（旧配置零迁移）；更高的版本号原样保留——
  // 本版只是「不认识那些键」，不是「那些键属于更旧的结构」，写成 1 等于对下一个新版谎报版本。
  cfg.configVersion = normalizeConfigVersion(cfg.configVersion);
  // D-7（V110，对照 core/schema.js:26-31 的「更高 schemaVersion 原样保留、不降级」）：
  // 只有更高版本的配置才保留未知顶层键，而且必须过类型 / 深度 / 大小闸门；同版本 / 低版本的
  // 未知键仍按 S4 丢弃。普通旧配置（没有 configVersion）的行为与以前逐字一致。
  if (cfg.configVersion > CONFIG_VERSION) {
    Object.assign(cfg, sanitizeUnknownTopKeys(unknownSource));
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
  // 崩溃恢复草稿（v1.8.2 WP5 / N1）：只认真正的 true（缺字段 / 写错类型都按「关」），默认关。
  cfg.crashDraftEnabled = cfg.crashDraftEnabled === true;
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
  // T-16：宽 / 高 / x / y 都先过原始类型判 —— null / 空串 / 布尔 / 数组不再被 Number() 洗成 0
  // （旧行为会把「没填」洗成窗口 (0,0) 或最小尺寸），坏值一律回落默认。
  const boundsWidth = b && typeof b === 'object' ? numericInput(b.width) : NaN;
  const boundsHeight = b && typeof b === 'object' ? numericInput(b.height) : NaN;
  if (Number.isFinite(boundsWidth) && Number.isFinite(boundsHeight)) {
    const boundsX = numericInput(b.x);
    const boundsY = numericInput(b.y);
    cfg.windowBounds = {
      x: Number.isFinite(boundsX) ? Math.round(boundsX) : DEFAULTS.windowBounds.x,
      y: Number.isFinite(boundsY) ? Math.round(boundsY) : DEFAULTS.windowBounds.y,
      // V103（v1.8.0 WP-26）：窗口尺寸不再夹死 4000/3000 —— 5K 超宽屏的正常窗口会被这条截小，
      // 重启后永远小一圈。这里只挡明显离谱的值（防止坏配置开出巨窗），真正的「不超出当前
      // 显示器工作区」由 main.js 的 clampBounds(screen.workArea) 在恢复窗口时完成。
      width: clampRoundedInt(boundsWidth, 960, MAX_WINDOW_DIMENSION, DEFAULTS.windowBounds.width),
      height: clampRoundedInt(boundsHeight, 620, MAX_WINDOW_DIMENSION, DEFAULTS.windowBounds.height),
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
  // deps.rename 只给测试注入「损坏文件归档失败」（EPERM / EBUSY）用；生产走 node:fs/promises。
  const renameFile = typeof deps.rename === 'function' ? deps.rename : (from, to) => fs.rename(from, to);
  let cache = null;
  let loadWarning = null; // 配置损坏被归档时，给界面提示一次
  // 审计修复 #52（E25）：损坏配置归档失败时记在这里。旧实现归档失败仍回默认值，下一次保存会把
  // 那份还能人工修的损坏原文件整份覆盖掉；现在写盘前必须再试一次归档，仍失败就拒绝写盘。
  let archiveFailure = null;
  // C7（审计 C7）：非 ENOENT 的读失败会置这里（错误码 + 一句话），**自动写一律被拦**，
  // 显式保存先重试读；读到真的配置才允许写盘。不放进 loadWarning 里，是因为提示只给一次，
  // 而写闸门要一直记着「这份 cache 是默认值、不是真配置」直到读盘恢复。
  let readFailure = null;
  // 配置写入串行化：并发 set 时各自拿旧 cache 合并会吞掉对方的 patch（例如拖完分隔条同时点保存设置）
  // —— 队列实现见 core/common.js 的 createWriteQueue（B6：与碎片 / 日志 / 统计四个 store 共用一份）。
  const writeQueue = createWriteQueue();
  const enqueue = writeQueue.enqueue;

  function defaults() {
    return { ...DEFAULTS, windowBounds: { ...DEFAULTS.windowBounds }, bookDisplay: {}, findBookmarks: [] };
  }

  // 审计修复 #52（E25）：损坏配置的归档名与归档动作。errorCode 非空 = 改名失败：
  // 此时损坏文件仍叫 config.json，写盘前必须再试（见 ensureCorruptArchived）。
  function corruptArchiveName() {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    return `${file}.corrupt-${stamp}`;
  }

  async function archiveCorruptConfig() {
    const archived = corruptArchiveName();
    try {
      await renameFile(file, archived);
      return { archived, errorCode: '' };
    } catch (err) {
      return { archived, errorCode: (err && err.code) || 'UNKNOWN' };
    }
  }

  function corruptArchiveMessage(archived) {
    return `配置文件损坏，已归档为 ${path.basename(archived)} 并恢复默认设置；书架目录请在「设置」里重新指定。`;
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
        readFailure = {
          errorCode: (err && err.code) || 'UNKNOWN',
          message: `配置文件读取失败（${(err && err.code) || '未知错误'}），本次使用默认设置；请检查文件权限或磁盘后重启应用。`
        };
        loadWarning = {
          code: 'CONFIG_READ_FAILED',
          errorCode: readFailure.errorCode,
          message: readFailure.message
        };
        return cloneConfig(cache);
      }
      // 没有配置文件 = 首次启动，用默认值（这不算损坏，不提示）
      // 审计残留修复 #52（E25）：文件都不在了，上一次「归档失败」的标记也已无意义（旧实现会让
      // 本会话此后每次写盘都先去 rename 一份不存在的 config.json，一直拒绝写入到重启）。
      cache = defaults();
      readFailure = null;
      loadWarning = null;
      archiveFailure = null;
      return cloneConfig(cache);
    }
    readFailure = null;
    try {
      cache = sanitize(JSON.parse(stripBom(raw)));
      // 读盘恢复后，上一次读失败留下的一次性提示已经过时（本次拿到的就是真配置）。
      loadWarning = null;
      // 审计残留修复 #52（E25）：这一份是健康配置 —— 会话中途文件被外部修好（或换了一份）时，
      // 旧的「归档失败」标记必须作废，否则下一次写会把这份健康文件改名成 .corrupt-*。
      archiveFailure = null;
    } catch {
      // 配置坏了：先归档损坏文件（不直接删），再回默认值，并让界面提示一次，
      // 否则书架路径会悄悄变回「文档\我的小说」，用户会以为书全没了。
      // 审计修复 #52（E25）：归档失败不再「静默继续」——记下失败原因，写盘前还会再试；
      // 仍失败就拒绝写盘，绝不用默认值覆盖那份损坏原文件（它可能是唯一还能人工抢救的副本）。
      const { archived, errorCode } = await archiveCorruptConfig();
      archiveFailure = errorCode ? { archived, errorCode } : null;
      cache = defaults();
      loadWarning = errorCode
        ? {
            code: 'CONFIG_CORRUPT',
            archived,
            archiveError: errorCode,
            message:
              `配置文件损坏，但无法归档损坏文件（${errorCode}），它仍在原处；本次已恢复默认设置，` +
              '保存设置前会先重试归档，仍失败就拒绝写入。请关闭占用该文件的程序后重启应用。'
          }
        : {
            code: 'CONFIG_CORRUPT',
            archived,
            message: corruptArchiveMessage(archived)
          };
    }
    return cloneConfig(cache);
  }

  // 取出「配置损坏」提示（只给一次）
  function takeLoadWarning() {
    const warning = loadWarning;
    loadWarning = null;
    return warning;
  }
  // 审计残留修复 R28（#52/E25）：只读不清的版本 —— 主进程启动时用它记一条日志，提示留在 store 里，
  // 由真正给界面看的 app:warning 取「当前值」（写前重试归档成功会把「无法归档」更正成「已归档」，
  // 读盘恢复会把过期提示作废；启动就 take 的话这些更正永远没人读，等于死代码）。
  function peekLoadWarning() {
    return loadWarning;
  }

  // C7（审计 C7）：读失败时构造统一错误。自动写 / 显式写读盘仍失败都抛这个（code 让界面与 E2E
  // 按码分支）；文案只说「没写入」，不带任何完整路径。
  function readFailedError() {
    const errorCode = (readFailure && readFailure.errorCode) || 'UNKNOWN';
    const err = new Error(
      `配置文件读取失败（${errorCode}），本次没有写入任何设置；请检查文件权限或磁盘后重试。`
    );
    err.code = 'CONFIG_READ_FAILED';
    err.errorCode = errorCode;
    return err;
  }

  // C7：显式保存前的「先重试读」——读成功就按真实配置合并（默认值不覆盖真配置）；
  // 仍失败返回 false，由调用方抛 readFailedError，绝不拿默认值落盘。
  async function recoverRead() {
    if (!readFailure) return true;
    await load();
    return !readFailure;
  }

  async function get() {
    if (!cache) await load();
    return cloneConfig(cache);
  }

  // 审计修复 #55（M7）：get() 以前是 `{ ...cache }` 浅拷贝，windowBounds / bookDisplay /
  // findBookmarks / formatOptions / lastBook / proofreadWordlists 这些嵌套对象与缓存共享引用 ——
  // 调用方就地改嵌套（当前调用方都只读，属潜在隐患）会把 cache 污染成「没写盘却生效」。
  // 这里按配置的真实形状逐层复制；高版本配置透传的未知顶层键同样走 copyUnknownValue 深拷贝
  // （它们本来就已经过同一套类型 / 深度 / 大小闸门，这里不会丢值）。
  function cloneConfig(cfg) {
    const copy = { ...cfg };
    copy.windowBounds = { ...cfg.windowBounds };
    copy.formatOptions = { ...cfg.formatOptions };
    copy.lastBook = cfg.lastBook && typeof cfg.lastBook === 'object' ? { ...cfg.lastBook } : cfg.lastBook;
    copy.proofreadWordlists = Array.isArray(cfg.proofreadWordlists)
      ? cfg.proofreadWordlists.slice()
      : cfg.proofreadWordlists;
    copy.findBookmarks = (Array.isArray(cfg.findBookmarks) ? cfg.findBookmarks : []).map((item) => ({ ...item }));
    const bookDisplay = {};
    for (const [bookId, entry] of Object.entries(cfg.bookDisplay || {})) {
      setOwnEntry(bookDisplay, bookId, { ...entry });
    }
    copy.bookDisplay = bookDisplay;
    for (const key of Object.keys(copy)) {
      if (KNOWN_KEY_SET.has(key)) continue;
      const cloned = copyUnknownValue(copy[key], 0);
      if (cloned !== undefined) copy[key] = cloned;
    }
    return copy;
  }

  // 返回值：'gone' = 文件已被删（归档无意义，清标记放行）；'healed' = 文件已被外部修成合法配置
  // （不归档，写盘按磁盘上的真配置合并）；false = 读失败或仍是坏文件（继续归档重试）。
  // T-17：'gone' 与 'healed' 必须分开 —— 前者不需要再 load，后者内部会再 load 一次（可能又失败）。
  async function archiveTargetGoneOrHealed() {
    let raw;
    try {
      raw = await readJson(file, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return 'gone';
      return false;
    }
    try {
      JSON.parse(stripBom(raw));
    } catch {
      return false; // 还是那份坏文件
    }
    await load();
    return 'healed';
  }

  // 审计修复 #52（E25）：「损坏文件归档失败」的写前再试。成功就把失败标记清掉（损坏文件已改名，
  // 现在写 config.json 不会覆盖任何东西）；仍失败则明确拒绝 —— 所有写通道都走 gateWrite，
  // 自动写（窗口位置 / 最近书）与显式保存（设置 / 书签）一个都不会把损坏原文件盖掉。
  // 审计残留修复 #52（E25）：再试之前先看文件还在不在 / 有没有被外部修好（见 archiveTargetGoneOrHealed）。
  async function ensureCorruptArchived() {
    if (!archiveFailure) return;
    const archiveTarget = await archiveTargetGoneOrHealed();
    if (archiveTarget === 'gone') {
      // 文件被外部删除：归档这件事已无意义，清标记放行（旧实现让本会话此后拒绝一切写入到重启）。
      archiveFailure = null;
      return;
    }
    if (archiveTarget === 'healed') {
      // T-17（三次审查）：healed 判定内部会再 `await load()` 一次。那次 load 如果又撞上坏 JSON
      // （外部修好 → 又变坏的三重竞态），`archiveFailure` 会被重新置位；旧实现在这里**无条件**
      // 清标记，控制流回到 gateWrite 就以为「已归档」，拿默认值把仍损坏的 config.json 覆盖掉——
      // 正是 E25 承诺绝不发生的事。放行前复查现值：
      //   · 两个失败标记都为空 = 真恢复了 → 清标记放行；
      //   · readFailure 重新出现 = 那次 load 读失败，不能把可能健康的文件归档掉 → 交给 gateWrite
      //     的读失败分支（自动写拒绝、显式写先重试读）；
      //   · 只剩 archiveFailure = 刚又归档失败 → 继续走下面的归档重试（仍失败就拒绝写入）。
      if (!readFailure && !archiveFailure) {
        archiveFailure = null;
        return;
      }
      if (readFailure) return;
    }
    const { archived, errorCode } = await archiveCorruptConfig();
    // 竞态：检查之后、rename 之前文件被删。源文件都不在了，归档已无意义 → 放行写入
    if (errorCode === 'ENOENT') {
      archiveFailure = null;
      return;
    }
    if (errorCode) {
      const err = new Error(
        `损坏的配置文件仍无法归档（${errorCode}），本次没有写入任何设置；请关闭占用该文件的程序后重启应用。`
      );
      err.code = 'CONFIG_CORRUPT';
      err.errorCode = errorCode;
      throw err;
    }
    archiveFailure = null;
    // 启动提示还没被取走时同步成「已归档」，免得界面拿着过期的失败文案。
    if (loadWarning && loadWarning.code === 'CONFIG_CORRUPT' && loadWarning.archiveError) {
      loadWarning = { code: 'CONFIG_CORRUPT', archived, message: corruptArchiveMessage(archived) };
    }
  }

  // C7：写闸门（所有写通道共用一个入口）。
  // - 自动写（auto: true：窗口位置 / 最近书 / 最近导出目录）在读失败期间一律不写盘、不重试：
  //   一次 resize 的防抖写就能把读不到的真配置整份换成默认值（booksRoot 全丢，正是审计 C7）。
  // - 显式写（用户在设置里点保存 / 改按书显示 / 存书签）先重试读：磁盘恢复就按真配置合并，
  //   仍读不到就明确失败，界面看到「保存失败」而不是下一次启动发现设置全没。
  // - 审计修复 #52（E25）：损坏配置归档失败时，写前再试归档（自动写与显式写都要，见上）。
  async function gateWrite(auto) {
    await ensureCorruptArchived();
    if (!readFailure) return;
    if (auto) throw readFailedError();
    if (!(await recoverRead())) throw readFailedError();
  }

  // C7：给主进程的「保存设置」入口用——不改任何设置，只重试读盘并报告是否恢复。
  // 返回 { ok, recovered }；失败时带 code / errorCode / message 供调用方原样抛给界面。
  function retryLoad() {
    return enqueue(async () => {
      const hadFailure = Boolean(readFailure);
      const ok = await recoverRead();
      if (!ok) {
        return {
          ok: false,
          recovered: false,
          code: 'CONFIG_READ_FAILED',
          errorCode: (readFailure && readFailure.errorCode) || 'UNKNOWN',
          message: readFailedError().message
        };
      }
      return { ok: true, recovered: hadFailure };
    });
  }

  // C2（审计 #21）：可选的写前钩子 beforeWrite({ current, next })。
  // 「判书架根是否变化 + mkdir 目标根」必须和写盘处在同一个 enqueue，并用队列内刚读到的
  // current —— 队列外快照在多窗口并发写配置时可能已经过期（窗口 A 刚换根、窗口 B 还拿旧根
  // 判定 → 新根没被预建）。钩子抛错 = 这次不写盘（cache / 磁盘都保持旧值，A3/E3 顺序语义不变）。
  // 只有主进程的 config:set 传它；不传时行为与旧实现逐字节一致。
  // 五-L2（CI-4）：可选 bookDisplayPatch —— 每本书显示覆盖的「并 map」合并必须和写盘同一个 enqueue，
  // 用队列内刚读到的 current 重算（队列外快照会整份盖掉并发 book:set-display 刚写进的更新）。
  // 传了它时 patch 里不要再带 bookDisplay（这里会基于 current 重算整份 map）。
  function set(patch, options = {}) {
    const auto = Boolean(options && options.auto);
    const beforeWrite = options && typeof options.beforeWrite === 'function' ? options.beforeWrite : null;
    const bookDisplayPatch =
      options && options.bookDisplayPatch && typeof options.bookDisplayPatch === 'object'
        ? options.bookDisplayPatch
        : null;
    return enqueue(async () => {
      await gateWrite(auto);
      const current = await get();
      // CSTO-B-01（中）：config:set 的 patch 来自渲染层（威胁模型见 S4），两条不可信入口都要封：
      //   ① configVersion 只允许由 load() 读盘归一产生（或磁盘上本来就更高的版本）——
      //      patch 带 999999 不能把本版配置「升」到 D-7 的前向兼容通道；
      //   ② 未知顶层键只看 current（磁盘上已经存在的高版本键），patch 新带进来的未知键一律丢弃。
      // 这样渲染层无论传什么，config.json 都不会多出本版不认识的键，也不会留下假版本号。
      const next = sanitize(
        {
          ...current,
          ...(patch || {}),
          configVersion: current.configVersion,
          ...(bookDisplayPatch
            ? { bookDisplay: { ...(current.bookDisplay || {}), ...bookDisplayPatch } }
            : {})
        },
        { unknownKeysFrom: current }
      );
      if (beforeWrite) await beforeWrite({ current, next });
      // 先写盘：失败就抛出，cache 保持旧值（内存不再「假装已保存」）
      await writeJson(file, next);
      cache = next;
      return cloneConfig(cache);
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
      await gateWrite(false);
      const cfg = await get();
      const key = String(bookId == null ? '' : bookId).trim();
      if (!key) throw new Error('缺少书籍 id');
      const merged = sanitizeBookDisplayEntry({ ...(cfg.bookDisplay[key] || {}), ...(patch || {}) });
      const bookDisplay = { ...cfg.bookDisplay };
      // C29（v1.8.0 WP-26）：`__proto__` 这类书 id 必须按自有属性写入，否则改的是原型、条目丢失。
      if (Object.keys(merged).length) setOwnEntry(bookDisplay, key, merged);
      else delete bookDisplay[key];
      const next = sanitize({ ...cfg, bookDisplay });
      await writeJson(file, next);
      cache = next;
      // T-18（三次审查）：bookDisplay 有 BOOK_DISPLAY_MAX 条上限（sanitizeBookDisplay 按插入序
      // 截断）。满额时新书的条目被截断在末尾，旧实现直接回 {}，调用方把空对象当「设置成功且无
      // 覆盖」。写盘后核对该 key 是否真的存活：被截断就显式返回失败（软错误），不再伪成功。
      if (Object.keys(merged).length && !cache.bookDisplay[key]) {
        const err = new Error(
          `按书显示设置的条目已达上限（${BOOK_DISPLAY_MAX} 本），这本书的设置没有保存；` +
            '可以先清理不再打开的书的显示覆盖后重试。'
        );
        err.code = 'BOOK_DISPLAY_FULL';
        throw err;
      }
      return { ...(cache.bookDisplay[key] || {}) };
    });
  }

  async function resetBookDisplay(bookId) {
    return enqueue(async () => {
      await gateWrite(false);
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
      await gateWrite(false);
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
      await gateWrite(false);
      const cfg = await get();
      const list = bookmarksLib.removeBookmark(cfg.findBookmarks, bookId, chapterId);
      const next = sanitize({ ...cfg, findBookmarks: list });
      await writeJson(file, next);
      cache = next;
      return { list: cache.findBookmarks.map((item) => ({ ...item })) };
    });
  }

  // E2（一轮·低）：删书成功后按 bookId 清掉属于这本书的全部查找书签。书签全局上限 200 条，
  // 旧实现只清 bookDisplay，删掉的书签会继续占配额并出现在查找面板（点开必然失败）。
  // 返回实际删掉的条数（0 = 没有条目，不写盘）。只写 userData/config.json，绝不碰书库。
  function resetFindBookmarksForBook(bookId) {
    return enqueue(async () => {
      await gateWrite(false);
      const key = String(bookId == null ? '' : bookId).trim();
      if (!key) return 0;
      const cfg = await get();
      const list = Array.isArray(cfg.findBookmarks) ? cfg.findBookmarks : [];
      const kept = list.filter((item) => !(item && String(item.bookId || '').trim() === key));
      if (kept.length === list.length) return 0;
      const next = sanitize({ ...cfg, findBookmarks: kept });
      await writeJson(file, next);
      cache = next;
      return list.length - kept.length;
    });
  }

  // C28（v1.8.0 WP-26）：最近书（lastBook）的「读旧值 → 去重 / at 守卫 → 写盘」必须全部在
  // 同一个写队列里完成。以前 main.js 在 configStore.set 之前单独 get 一次：两个窗口并发时
  // 都看到同一份旧值、都通过 at 守卫，迟到的旧切章记录能把更晚的「上次写作」盖掉。
  // 现在第二次调用一定看见第一次写下的值（队列串行），守卫判断与写盘之间也没有新窗口。
  // 返回 { written, reason, config }：written=false 表示按规则跳过（不是失败）；读失败等异常照常抛。
  function rememberLastBook(raw, options = {}) {
    const auto = !options || options.auto !== false;
    const now = Number.isFinite(Number(options && options.now)) ? Number(options.now) : Date.now();
    const dedupeMs = Number.isFinite(Number(options && options.dedupeWindowMs))
      ? Math.max(0, Math.round(Number(options.dedupeWindowMs)))
      : RECENT_BOOK_DEDUPE_MS;
    return enqueue(async () => {
      await gateWrite(auto);
      const current = await get();
      const prev = current.lastBook;
      const next = sanitizeLastBook(raw, now);
      // 缺 path / chapterId 的记录不算「上次写作」（与 main.js 旧入口的守卫一致）
      if (!next || !next.chapterId) return { written: false, reason: 'invalid', config: { ...current } };
      // T-13：prev.at 是「现在的未来」且超出容差 = 时钟回拨留下的病值，去重与 stale 两条守卫都不采信。
      const prevAt = prev ? Number(prev.at) : NaN;
      const prevAtUsable = Number.isFinite(prevAt) && prevAt > 0 && prevAt <= now + LAST_BOOK_CLOCK_SKEW_MS;
      // 打开书时 open + set-last 会连着报同一个位置：5 秒内不重复写盘（换章照常更新）
      if (
        prev &&
        prevAtUsable &&
        prev.path === next.path &&
        prev.chapterId === next.chapterId &&
        now - prevAt < dedupeMs
      ) {
        return { written: false, reason: 'duplicate', config: { ...current } };
      }
      // 迟到的切章记录不许盖掉更晚的「上次写作」位置（多窗口：A 保存得更晚，B 的旧切章不能翻上去）
      if (prev && prevAtUsable && prevAt > next.at) {
        return { written: false, reason: 'stale', config: { ...current } };
      }
      const saved = sanitize({ ...current, lastBook: next });
      await writeJson(file, saved);
      cache = saved;
      // 写成功后的 config 也返回深拷贝（审计修复 #55 / M7）：set / rememberLastBook 的调用方
      // 拿到的是快照，就地改嵌套不会污染下一次 get()。
      return { written: true, reason: 'written', config: cloneConfig(cache) };
    });
  }

  return {
    file,
    load,
    get,
    set,
    retryLoad,
    takeLoadWarning,
    peekLoadWarning,
    rememberLastBook,
    getBookDisplay,
    setBookDisplay,
    resetBookDisplay,
    listFindBookmarks,
    upsertFindBookmark,
    removeFindBookmark,
    resetFindBookmarksForBook,
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

// B10（v1.8.0 WP-29）：窗口位置「这次要写进 config 的 5 个标量」与上一次落盘的是否完全相同。
// 拖动 / 最大化切换会连发 resize + move，防抖写回时几何常常没变；一样就没必要再序列化 + 写整份
// config.json。只比较 5 个标量（x / y / width / height / maximized），任何一边缺字段都按「不同」处理
// （宁可多写一次，也不能把首次恢复漏掉）。比较用 Number() 归一，字符串 / 数字写法不同不算变化。
function sameWindowBounds(previous, next) {
  const one = previous && typeof previous === 'object' ? previous : null;
  const two = next && typeof next === 'object' ? next : null;
  if (!one || !two) return false;
  for (const key of ['x', 'y', 'width', 'height']) {
    if (Number(one[key]) !== Number(two[key])) return false;
  }
  return Boolean(one.maximized) === Boolean(two.maximized);
}

module.exports = {
  createConfigStore,
  DEFAULTS,
  WORDLIST_MAX,
  BOOK_DISPLAY_MAX,
  MAX_LAST_BOOK_FUTURE_MS,
  LAST_BOOK_CLOCK_SKEW_MS,
  sanitize,
  sanitizeLastBook,
  sameWindowBounds,
  withBooksRootOverride
};
