// 每日字数统计 + 写作目标：纯逻辑 + 独立存储（userData/stats.json）。
//
// 设计约束（来自提案 3.2 与项目红线）：
// - 只统计「保存」动作带来的正字数增量，不做自动保存、不读正文以外的东西；
// - 统计文件放在应用配置目录，绝不写进书库 / 书目.json / 章节 txt；
// - 旧配置没有 dailyGoal 也照常启动（0 = 不设目标）；
// - 日期一律用本机时区的「YYYY-MM-DD」，近 30 天柱子按本地日期连续补零。
const fs = require('node:fs/promises');
const path = require('node:path');
const { writeJsonAtomic, stripBom } = require('./atomic');
const { pad2, parseDayKey, isValidDayKey, dayKeyOf, createWriteQueue } = require('./common');

const STATS_VERSION = 1;
const DEFAULT_GOAL = 0;
const MAX_GOAL = 1000000;
const DEFAULT_RECENT_DAYS = 30;
const MAX_RECENT_DAYS = 400;
// 文件里最多留 400 天：近 30 天图和「今年」都够用，又不会无限长。
const KEEP_DAYS = 400;
const MAX_DAYS = 500;
const MAX_DAY_CHARS = 100000000;
// A2-STATS-03：stats.json 是「整份读进内存 → JSON.parse」的小文件；正常规模远小于 1 MB
// （500 天 × 单日上限条目），给 8 MB 上限。被外部工具 / 同步盘 / 杀软放大成超大文件时在 parse
// 之前就归档并按空统计继续 —— 保存热路径不能被它拖住（同一道闸门照 core/atomic 的孤儿回收口径）。
const MAX_STATS_FILE_BYTES = 8 * 1024 * 1024;
// 写作时长（v0.8-2）：一天最多记 24 小时，坏数据 / 手改文件都夹住。
// 只记秒数，不记正文、不记按键；单位是秒，按天汇总（不按书分桶）。
const MAX_DAY_SECONDS = 86400;
// 码字日历固定周一起始（和国内日历 / 口袋写作习惯一致）。
const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

// 本机时区的日期键。已经是合法 YYYY-MM-DD 的原样返回（避免被当成 UTC 解析而差一天），
// 非法 Date / 坏字符串退回「现在」，保证永远返回可读字符串。
// 严格解析 / 真实性校验 / 格式化都是 core/common.js 那一份（B6：原来 logs 与 stats 各抄一遍）。
function localDayKey(date = new Date()) {
  if (typeof date === 'string' && isValidDayKey(date)) return date.trim();
  const d = date instanceof Date ? date : new Date(date);
  const safe = d instanceof Date && Number.isFinite(d.getTime()) ? d : new Date();
  return dayKeyOf(safe);
}

// 从某一天按本地日历加减天数（用中午 12 点构造，避开夏令时/时区边界）。
function shiftDayKey(key, deltaDays) {
  const parsed = isValidDayKey(key) ? parseDayKey(key) : parseDayKey(localDayKey());
  const date = new Date(parsed.year, parsed.month - 1, parsed.day, 12, 0, 0, 0);
  date.setDate(date.getDate() + Math.round(Number(deltaDays) || 0));
  return localDayKey(date);
}

function normalizeGoal(value, fallback = DEFAULT_GOAL) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_GOAL, Math.max(0, Math.round(n)));
}

function clampRecentDays(value, fallback = DEFAULT_RECENT_DAYS) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_RECENT_DAYS, Math.max(1, Math.round(n)));
}

function sanitizeBookId(raw) {
  const id = String(raw == null ? '' : raw).trim();
  if (!id) return '_unknown';
  return id.slice(0, 200);
}

// 写作时长清洗：只认有限数，四舍五入到整秒，负数 / NaN / 坏字符串一律 0，
// 超过 24 小时夹到上限。旧 stats.json 没有这个字段 = 0。
function sanitizeDuration(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_DAY_SECONDS, n);
}

function secondsOfEntry(entry) {
  if (!entry || typeof entry !== 'object') return 0;
  return sanitizeDuration(entry.seconds);
}

function emptyStats() {
  return { version: STATS_VERSION, days: {} };
}

// 读取时清洗：坏日期 / 坏条目 / 负数 / 超大数全部丢弃或夹住；不抛错。
// CTXT-B-03（审计）：晚于 anchor（默认今天）的键是系统时钟回拨 / 手改 stats.json 的产物。
// 以前只丢「格式非法」的键，未来键被完整保留：aggregate / monthView 照常计入（总字数虚高），
// 还会在下面「只留最近 500 天」的按字符串排序里排到最后，提前挤掉一条真实历史日。
// 现在统一在读取时按「未来日期不计入」丢弃——三个聚合出口与 streak 的口径因此一致。
// options.anchor 只给需要固定基准的调用方 / 单测用；不传就是本机今天。
function sanitizeStats(raw, options) {
  const opt = options && typeof options === 'object' ? options : {};
  const anchor = isValidDayKey(opt.anchor) ? opt.anchor : localDayKey();
  const out = emptyStats();
  const rawDays =
    raw && typeof raw === 'object' && !Array.isArray(raw) && raw.days && typeof raw.days === 'object' && !Array.isArray(raw.days)
      ? raw.days
      : {};
  // ISO 日期键按字符串排序就是时间顺序；未来键丢弃，只留最近的 MAX_DAYS 天，避免超大文件。
  // A2-STATS-04：键必须与 trim 后逐字相同 —— isValidDayKey 内部会 trim，旧实现拿原字符串入库，
  // 带前后空白的键在 dayTotal / monthView 查不到、aggregate 的 slice(0,4) 却把年归成「202」。
  // 这类脏键直接丢弃（统计是派生数据，宁可少一天也不让三个聚合出口口径分裂）。
  const keys = Object.keys(rawDays)
    .filter((key) => key === key.trim() && isValidDayKey(key) && key <= anchor)
    .sort();
  const keep = keys.slice(-MAX_DAYS);
  for (const key of keep) {
    const entry = rawDays[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rawBooks =
      entry.books && typeof entry.books === 'object' && !Array.isArray(entry.books) ? entry.books : {};
    const books = {};
    for (const [rawId, rawValue] of Object.entries(rawBooks)) {
      const id = typeof rawId === 'string' ? rawId.trim() : '';
      if (!id || id.length > 200) continue;
      const n = Math.round(Number(rawValue));
      if (!Number.isFinite(n) || n <= 0) continue;
      books[id] = Math.min(MAX_DAY_CHARS, n);
    }
    const seconds = sanitizeDuration(entry.seconds);
    // 旧数据只有 books；开着写作时长后，某天可能只有时长没有新字数（只计时 / 只读），
    // 这种「只有 seconds」的日子也要留住，否则月视图会少一天时长。
    if (!Object.keys(books).length && seconds <= 0) continue;
    const clean = {};
    if (Object.keys(books).length) clean.books = books;
    if (seconds > 0) clean.seconds = seconds;
    out.days[key] = clean;
  }
  return out;
}

// 审计修复 #54（P9）：createStatsStore().get() 返回的对象已经 sanitize 过；stats:get 一次要读
// summary / streak / monthView / aggregate 四份视图，默认各自再清洗一遍 = 同一份统计洗四次。
// 调用方确认「这份数据来自 store / record（已清洗）」时传 { sanitized: true } 跳过重复清洗；
// 不传 / 传坏值仍走原来的 sanitizeStats（对外纯函数的行为不变）。
function statsFor(rawStats, options) {
  if (options && typeof options === 'object' && options.sanitized === true) {
    if (rawStats && typeof rawStats === 'object' && !Array.isArray(rawStats) && rawStats.days && typeof rawStats.days === 'object') {
      return rawStats;
    }
  }
  return sanitizeStats(rawStats);
}

function dayTotal(rawStats, day) {
  const stats = sanitizeStats(rawStats);
  const key = isValidDayKey(day) ? day : localDayKey();
  const entry = stats.days[key];
  if (!entry) return 0;
  let total = 0;
  for (const value of Object.values(entry.books || {})) total += value;
  return total;
}

// 某一天的写作时长（秒）；没有记录 = 0。旧 stats.json 没有 seconds 字段也算 0。
function daySeconds(rawStats, day) {
  const stats = sanitizeStats(rawStats);
  const key = isValidDayKey(day) ? day : localDayKey();
  return secondsOfEntry(stats.days[key]);
}

// 内部用：已经 sanitize 过的统计，直接取某天合计，避免 monthView 里逐天重复清洗。
function totalOfEntry(entry) {
  if (!entry || typeof entry !== 'object' || !entry.books) return 0;
  let total = 0;
  for (const value of Object.values(entry.books)) total += value;
  return total;
}

// 内部用：已经 sanitize 过的统计，按天连续取近 N 天（缺的天补 0）。
// 只做 entry 级读取，不再对整份统计逐天调 dayTotal / sanitizeStats。
function recentDaysFromSanitized(stats, anchor, days) {
  const out = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const key = shiftDayKey(anchor, -offset);
    out.push({ day: key, chars: totalOfEntry(stats.days[key]) });
  }
  return out;
}

// 年月归一：非法 / 越界一律退回 now 所在的本地年月（渲染层传坏值也不会让日历空掉）。
function normalizeMonth(year, month, now = new Date()) {
  const anchor = parseDayKey(localDayKey(now));
  const y = Number(year);
  const m = Number(month);
  if (Number.isInteger(y) && y >= 1970 && y <= 9999 && Number.isInteger(m) && m >= 1 && m <= 12) {
    return { year: y, month: m };
  }
  return { year: anchor.year, month: anchor.month };
}

function daysInMonth(year, month) {
  const { year: y, month: m } = normalizeMonth(year, month);
  return new Date(y, m, 0, 12, 0, 0, 0).getDate();
}

// 一周从周一开始：0 = 周一 … 6 = 周日。
function mondayWeekday(year, month, dayOfMonth = 1) {
  return (new Date(year, month - 1, dayOfMonth, 12, 0, 0, 0).getDay() + 6) % 7;
}

// 码字日历色阶：0 = 没写；设了目标时「达标」= 4，未达标最高 3；没设目标按当月最高一天分 1–4。
function calendarLevel(chars, { goal = 0, maxChars = 0 } = {}) {
  const value = Math.max(0, Math.round(Number(chars) || 0));
  if (value <= 0) return 0;
  if (goal > 0) {
    if (value >= goal) return 4;
    return Math.max(1, Math.min(3, Math.ceil((value / goal) * 3)));
  }
  const max = Math.max(1, Math.round(Number(maxChars) || 0));
  return Math.max(1, Math.min(4, Math.ceil((value / max) * 4)));
}

// 某个月的码字日历视图：每天的字数 / 是否达标 / 色阶 + 月度汇总。
// 只读；日期一律按本机本地日期，未来日期标 future（界面淡显，不参与「今天」）。
function monthView(rawStats, { year, month, now = new Date(), goal = DEFAULT_GOAL, sanitized = false } = {}) {
  const stats = statsFor(rawStats, { sanitized });
  const anchor = localDayKey(now);
  const normalized = normalizeMonth(year, month, now);
  const targetYear = normalized.year;
  const targetMonth = normalized.month;
  const dailyGoal = normalizeGoal(goal);
  const anchorParts = parseDayKey(anchor);
  const count = daysInMonth(targetYear, targetMonth);
  const days = [];
  let total = 0;
  let totalSeconds = 0;
  let writtenDays = 0;
  let goalDays = 0;
  let maxChars = 0;
  let bestDay = null;

  for (let dayOfMonth = 1; dayOfMonth <= count; dayOfMonth += 1) {
    const day = `${targetYear}-${pad2(targetMonth)}-${pad2(dayOfMonth)}`;
    // CTXT-B-03：未来日期不计入任何聚合（total / average / writtenDays / goalDays / bestDay），
    // 日历格子仍标 future；时钟回拨留下的未来数据不再让本月统计虚高。
    const future = day > anchor;
    const entry = future ? null : stats.days[day];
    const chars = future ? 0 : totalOfEntry(entry);
    const seconds = future ? 0 : secondsOfEntry(entry);
    const written = chars > 0;
    totalSeconds += seconds;
    if (written) {
      total += chars;
      writtenDays += 1;
      if (dailyGoal > 0 && chars >= dailyGoal) goalDays += 1;
      if (chars > maxChars) {
        maxChars = chars;
        bestDay = { day, chars };
      }
    }
    days.push({
      day,
      dayOfMonth,
      chars,
      seconds,
      written,
      goalMet: dailyGoal > 0 && chars >= dailyGoal,
      level: 0, // 下面按整月最高值 / 目标统一算，避免逐天口径不一致
      today: day === anchor,
      future
    });
  }
  for (const item of days) {
    item.level = calendarLevel(item.chars, { goal: dailyGoal, maxChars });
  }

  return {
    year: targetYear,
    month: targetMonth,
    label: `${targetYear}年${targetMonth}月`,
    today: anchor,
    isCurrentMonth: targetYear === anchorParts.year && targetMonth === anchorParts.month,
    firstWeekday: mondayWeekday(targetYear, targetMonth, 1),
    weekdayLabels: WEEKDAY_LABELS.slice(),
    goal: dailyGoal,
    total,
    totalSeconds,
    writtenDays,
    goalDays,
    average: writtenDays > 0 ? Math.round(total / writtenDays) : 0,
    bestDay,
    days
  };
}

// 连续写作天数：current = 从今天（今天还没写就从昨天）往前数的连续写字天数，
// best = 有记录以来的最长连续天数。只算「当天有正字数」的日期，未来日期忽略。
function streak(rawStats, { now = new Date(), sanitized = false } = {}) {
  const stats = statsFor(rawStats, { sanitized });
  const anchor = localDayKey(now);
  const written = new Set();
  for (const [key, entry] of Object.entries(stats.days)) {
    if (key > anchor) continue;
    if (totalOfEntry(entry) > 0) written.add(key);
  }
  const sorted = Array.from(written).sort();
  let current = 0;
  let cursor = written.has(anchor) ? anchor : shiftDayKey(anchor, -1);
  // 统计文件最多 500 天，这里再夹一个硬上限，坏数据也不会死循环。
  for (let guard = 0; guard <= MAX_DAYS + 1 && written.has(cursor); guard += 1) {
    current += 1;
    cursor = shiftDayKey(cursor, -1);
  }
  let best = 0;
  let run = 0;
  let previous = null;
  for (const key of sorted) {
    run = previous && shiftDayKey(previous, 1) === key ? run + 1 : 1;
    if (run > best) best = run;
    previous = key;
  }
  return {
    current,
    best,
    todayWritten: written.has(anchor),
    lastWritten: sorted.length ? sorted[sorted.length - 1] : null,
    writtenDays: written.size
  };
}

// 只清理「早于保留窗口」的真实日期；未来日期/坏键（读取时已被清洗）不动。
function pruneDays(stats, key) {
  const cutoff = shiftDayKey(key, -(KEEP_DAYS - 1));
  for (const existing of Object.keys(stats.days)) {
    if (existing < cutoff) delete stats.days[existing];
  }
  const all = Object.keys(stats.days).sort();
  if (all.length > MAX_DAYS) {
    for (const old of all.slice(0, all.length - MAX_DAYS)) delete stats.days[old];
  }
}

// A2-STATS-01（低）：读取期规则（未来键不进任何聚合）不能复用成写盘清洗。旧实现 sanitizeStats
// 会把「晚于今天」的键直接丢掉，而 recordChars / recordDuration 又把清洗结果交给 store 写盘 ——
// 系统时间回拨（CMOS 电池失效 / 手动对时 / 向西跨时区）后任意一次正增量保存，就把回拨点之后的
// 真实历史日物理删除（最多 400 天），改回时间也找不回。
// 这里在清洗前把「合法但晚于今天」的键原样保留下来，写盘时合并回磁盘结果；聚合一律按锚过滤，
// 它们不参与任何统计，但文件里不丢（时间改回来后还能读回）。
function collectFutureDays(rawStats) {
  const raw =
    rawStats && typeof rawStats === 'object' && !Array.isArray(rawStats) && rawStats.days && typeof rawStats.days === 'object' && !Array.isArray(rawStats.days)
      ? rawStats.days
      : {};
  const today = localDayKey();
  const future = {};
  let kept = 0;
  for (const key of Object.keys(raw)) {
    if (key !== key.trim() || !isValidDayKey(key) || key <= today) continue;
    // 用同一把清洗（锚放到最远）把条目洗成规范形状，坏条目直接不要
    const cleaned = sanitizeStats({ days: { [key]: raw[key] } }, { anchor: '9999-12-31' });
    if (!cleaned.days[key]) continue;
    future[key] = cleaned.days[key];
    kept += 1;
    if (kept >= MAX_DAYS) break;
  }
  return future;
}

function withFutureDays(stats, future) {
  const keys = Object.keys(future);
  if (!keys.length) return stats;
  return { ...stats, days: { ...stats.days, ...future } };
}

// 把一次保存的正字数增量记进某本书的某一天；delta <= 0 不计数（删字/没变都不该扣今天的进度）。
// 返回新 stats 与真正记下的 added（调用方据此决定要不要写盘）。
function recordChars(rawStats, { day, bookId, delta } = {}) {
  const future = collectFutureDays(rawStats);
  const stats = sanitizeStats(rawStats);
  // CTXT-B-03：不写「晚于今天」的键（时钟回拨期间的调用 / 坏参数）。未来键下一次读取会被丢弃，
  // 写进去只会白丢一次增量；归到本机今天，与 streak / aggregate 的口径一致。
  const today = localDayKey();
  const key = isValidDayKey(day) && day <= today ? day : today;
  const amount = Math.round(Number(delta));
  if (!Number.isFinite(amount) || amount <= 0) return { stats: withFutureDays(stats, future), added: 0, day: key };
  const id = sanitizeBookId(bookId);
  // 保留这一天已有的写作时长（v0.8-2）；旧数据没有 seconds 时就是空的。
  const existing = stats.days[key];
  const entry = existing && typeof existing === 'object' ? { ...existing, books: { ...(existing.books || {}) } } : { books: {} };
  const before = entry.books[id] || 0;
  entry.books[id] = Math.min(MAX_DAY_CHARS, before + amount);
  const actualAdded = entry.books[id] - before;
  stats.days[key] = entry;
  pruneDays(stats, key);
  return { stats: withFutureDays(stats, future), added: actualAdded, day: key };
}

// 保存时「今日字数增量」的口径（审计 #3 / E1）：正文已经原子落盘，旧章字数基线读不到时
// 不能把保存改判成失败，但必须让调用方知道「这一次的字数没计入」——返回 baselineMissing
// 供界面弱提示 + 主进程 warn 留痕。previousChars = null / 坏值 = 不知道上一版有多少字，
// 此时 delta 一律 0（宁可少记，不虚记）。
function saveCharsDelta(previousChars, currentChars) {
  const currentRaw = Math.round(Number(currentChars));
  const current = Number.isFinite(currentRaw) ? Math.max(0, currentRaw) : 0;
  const known =
    previousChars !== null &&
    previousChars !== undefined &&
    previousChars !== '' &&
    Number.isFinite(Number(previousChars));
  if (!known) return { baselineMissing: true, delta: 0 };
  const previous = Math.max(0, Math.round(Number(previousChars)));
  return { baselineMissing: false, delta: current > previous ? current - previous : 0 };
}

// 保存后记一笔每日字数（审计 #3 / E1）：统计写盘失败绝不影响正文保存——把 store 的拒绝
// 收成 { ok:false, error } 返回，调用方只记一条 warn 日志并把原因带回界面，绝不重抛。
async function recordSaveChars(store, payload) {
  try {
    return { ok: true, recorded: await store.record(payload) };
  } catch (error) {
    return { ok: false, error };
  }
}

// 把一段写作时长（秒）累计到某一天；seconds <= 0 / 坏值不写盘。
// 只加时长、不记任何正文或按键；单日上限 MAX_DAY_SECONDS（24 小时）。
// 时长和字数是同一天的两种记录：这里也保留当天已有的按书字数。
function recordDuration(rawStats, { day, seconds } = {}) {
  const future = collectFutureDays(rawStats);
  const stats = sanitizeStats(rawStats);
  // 与 recordChars 同一条时钟回拨保护：未来键不落盘。
  const today = localDayKey();
  const key = isValidDayKey(day) && day <= today ? day : today;
  const amount = Math.round(Number(seconds));
  if (!Number.isFinite(amount) || amount <= 0) return { stats: withFutureDays(stats, future), added: 0, day: key };
  const existing = stats.days[key];
  const entry = existing && typeof existing === 'object' ? { ...existing } : { books: {} };
  const before = secondsOfEntry(entry);
  entry.seconds = Math.min(MAX_DAY_SECONDS, before + amount);
  const added = entry.seconds - before;
  if (added <= 0) return { stats: withFutureDays(stats, future), added: 0, day: key };
  stats.days[key] = entry;
  pruneDays(stats, key);
  return { stats: withFutureDays(stats, future), added, day: key };
}

// 近 N 天：从最早到今天，缺的天补 0，方便渲染层直接画柱子。
// 整份统计只清洗一次，之后按 entry 取数（dayTotal 对外 API 保留，内部不再用）。
function recentDays(rawStats, now = new Date(), count = DEFAULT_RECENT_DAYS) {
  const stats = sanitizeStats(rawStats);
  const days = clampRecentDays(count);
  const anchor = localDayKey(now);
  return recentDaysFromSanitized(stats, anchor, days);
}

// 给渲染层的最小摘要：今天多少字、目标多少、完成百分比、近 N 天（含今天）。
// v0.8-2 追加写作时长：今天 / 近 N 天各多少秒（关掉记录时一直是 0，旧数据读出来也是 0）。
function summary(rawStats, { now = new Date(), goal = DEFAULT_GOAL, days = DEFAULT_RECENT_DAYS, sanitized = false } = {}) {
  const stats = statsFor(rawStats, { sanitized });
  const anchor = localDayKey(now);
  const recent = recentDaysFromSanitized(stats, anchor, clampRecentDays(days));
  const todayEntry = stats.days[anchor];
  const todayChars = totalOfEntry(todayEntry);
  const todaySeconds = secondsOfEntry(todayEntry);
  const recentSeconds = recent.reduce((sum, item) => sum + secondsOfEntry(stats.days[item.day]), 0);
  const dailyGoal = normalizeGoal(goal);
  const goalPercent = dailyGoal > 0 ? Math.min(100, Math.floor((todayChars / dailyGoal) * 100)) : 0;
  const recentTotal = recent.reduce((sum, item) => sum + item.chars, 0);
  return {
    day: anchor,
    todayChars,
    todaySeconds,
    goal: dailyGoal,
    goalPercent,
    goalMet: dailyGoal > 0 && todayChars >= dailyGoal,
    recentTotal,
    recentSeconds,
    days: recent
  };
}

// ---------- 统计汇总（1.6.0 F2：按书 / 按年 / 按月现算） ----------
// 只读现算，不写盘、不改 stats.json 结构；渲染层的两个下拉只是把筛选条件传进来。
// 口径与码字日历 / 连续天数一致：当天有正字数才算「写作天数」（只有计时没有字的那天不算），
// 日均 = 总字数 ÷ 写作天数（四舍五入）。
const MIN_FILTER_YEAR = 1970;
const MAX_FILTER_YEAR = 2100;
const MAX_FILTER_BOOK_ID = 200;

// 筛选条件清洗：书 id 只认非空短字符串，年份只认 1970–2100 的整数（"2026" / 2025.6 也认）；
// 坏值一律当作「不筛」，绝不让界面传进来的东西把统计算成空。
function sanitizeStatsFilter(raw) {
  const out = { bookId: '', year: 0 };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const bookId = typeof raw.bookId === 'string' ? raw.bookId.trim() : '';
  if (bookId && bookId.length <= MAX_FILTER_BOOK_ID) out.bookId = bookId;
  const year = Math.round(Number(raw.year));
  if (Number.isFinite(year) && year >= MIN_FILTER_YEAR && year <= MAX_FILTER_YEAR) out.year = year;
  return out;
}

// 汇总一天的字数（已经 sanitize 过，直接加 books 里的正数）
function aggregate(rawStats, filter, options) {
  const stats = statsFor(rawStats, options);
  const safe = sanitizeStatsFilter(filter);
  // CTXT-B-03：与 streak / monthView 同口径——未来日期不计入任何汇总与下拉选项。
  const opt = options && typeof options === 'object' ? options : {};
  const anchor = localDayKey(opt.now instanceof Date ? opt.now : undefined);
  const days = [];
  const monthIndex = new Map();
  const bookTotals = new Map();
  const yearTotals = new Map();
  let totalChars = 0;
  let writtenDays = 0;
  for (const day of Object.keys(stats.days).sort()) {
    // 只过滤「合法但晚于今天」的日期键；sanitized:true 的调用方保证数据已清洗，
    // 非法键的处置由调用方那次清洗负责（P9/#54 的「跳过重复清洗」契约不变）。
    if (isValidDayKey(day) && day > anchor) continue;
    const entry = stats.days[day];
    const dayChars = totalOfEntry(entry);
    const dayYear = Number(day.slice(0, 4));
    // 下拉选项只反映「有什么数据」，不受当前筛选影响——否则选了某本书就再也切不回去。
    for (const [id, chars] of Object.entries(entry.books || {})) {
      if (!(chars > 0)) continue;
      const bucket = bookTotals.get(id) || { id, chars: 0, writtenDays: 0 };
      bucket.chars += chars;
      bucket.writtenDays += 1;
      bookTotals.set(id, bucket);
    }
    yearTotals.set(dayYear, (yearTotals.get(dayYear) || 0) + dayChars);
    if (safe.year && dayYear !== safe.year) continue;
    // 按书筛：只算这本书当天的字数（别人的字、别人的写作天数都不算）
    const chars = safe.bookId
      ? Math.max(0, Math.round(Number((entry.books || {})[safe.bookId]) || 0))
      : dayChars;
    if (chars <= 0) continue;
    totalChars += chars;
    writtenDays += 1;
    days.push({ day, chars });
    const month = day.slice(0, 7);
    const bucket = monthIndex.get(month) || { month, chars: 0, writtenDays: 0 };
    bucket.chars += chars;
    bucket.writtenDays += 1;
    monthIndex.set(month, bucket);
  }
  const books = Array.from(bookTotals.values()).sort(
    (a, b) => b.chars - a.chars || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  const years = Array.from(yearTotals, ([year, chars]) => ({ year, chars }))
    .filter((item) => item.chars > 0)
    .sort((a, b) => b.year - a.year);
  return {
    filter: safe,
    totals: { totalChars, writtenDays, averageChars: writtenDays > 0 ? Math.round(totalChars / writtenDays) : 0 },
    days,
    // 天按日期升序扫，Map 的插入顺序就是月份升序，下游不用再排一次。
    months: Array.from(monthIndex.values()),
    options: { books, years }
  };
}

function cloneStats(stats) {
  return JSON.parse(JSON.stringify(stats));
}

// 独立存储：写入走 core/atomic，串行化避免并发保存互相覆盖。
function createStatsStore(userDataDir) {
  const file = path.join(userDataDir, 'stats.json');
  let cache = null;
  let loadPromise = null;
  // A2-STATS-01：读盘时把「合法但晚于今天」的日期先单独留一份（不是缓存的一部分，也不进任何
  // 聚合），写盘时再合并回去 —— 系统时间回拨后保存一次不会把回拨点之后的真历史日删掉。
  let futureDays = {};
  // 统计写入串行化（保存正文时的字数增量不能并发合并丢失）——实现见 core/common.js 的 createWriteQueue。
  const writeQueue = createWriteQueue();
  const enqueue = writeQueue.enqueue;

  function statsForDisk(stats) {
    return withFutureDays(stats, futureDays);
  }

  async function readFromDisk() {
    // A2-STATS-03：先 stat 判尺寸再读 —— 超大 stats.json 不许整份进内存 / 同步 parse。
    let size = null;
    try {
      size = (await fs.stat(file)).size;
    } catch (err) {
      if (err.code === 'ENOENT') return emptyStats();
      throw err;
    }
    if (Number.isFinite(size) && size > MAX_STATS_FILE_BYTES) {
      futureDays = {};
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      try {
        await fs.rename(file, `${file}.too-large-${stamp}`);
      } catch {
        /* 归档失败也不阻塞（下次仍按空统计继续） */
      }
      return emptyStats();
    }
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return emptyStats();
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(stripBom(raw));
    } catch {
      parsed = null;
    }
    if (parsed) futureDays = collectFutureDays(parsed);
    try {
      if (!parsed) throw new Error('BAD_JSON');
      return sanitizeStats(parsed);
    } catch {
      // 统计文件坏了：归档坏文件（不直接删），然后从空统计继续，不能影响保存正文。
      futureDays = {};
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      try {
        await fs.rename(file, `${file}.corrupt-${stamp}`);
      } catch {
        /* 归档失败也不阻塞 */
      }
      return emptyStats();
    }
  }

  async function load() {
    if (cache) return cloneStats(cache);
    if (!loadPromise) {
      loadPromise = readFromDisk().then(
        (stats) => {
          cache = stats;
          return stats;
        },
        (err) => {
          loadPromise = null; // 读失败允许下次重试，不把坏状态永久缓存
          throw err;
        }
      );
    }
    const stats = await loadPromise;
    return cloneStats(stats);
  }

  async function get() {
    await writeQueue.idle();
    return load();
  }

  function record({ day, bookId, delta } = {}) {
    return enqueue(async () => {
      const current = await load();
      const result = recordChars(current, { day, bookId, delta });
      // 先把新统计写盘，成功了才更新内存缓存：写盘失败时缓存保持旧值——
      // 这次增量直接丢弃（不补记，下次成功保存也不会重带）：正文已经原子落盘，
      // 章字数基线已经前移，没有可靠的旧值可以回填；失败向上抛，由调用方记 warn 日志。
      if (result.added > 0) await writeJsonAtomic(file, statsForDisk(result.stats));
      cache = result.stats;
      return { added: result.added, day: result.day, stats: cloneStats(cache) };
    });
  }

  // 写作时长（v0.8-2）：只有按钮记秒数，不记内容；和字数共用一个串行队列与原子写，
  // 避免「保存正文」与「计时上报」同时写 stats.json 互相覆盖。
  function addDuration({ day, seconds } = {}) {
    return enqueue(async () => {
      const current = await load();
      const result = recordDuration(current, { day, seconds });
      if (result.added > 0) await writeJsonAtomic(file, statsForDisk(result.stats));
      cache = result.stats;
      return { added: result.added, day: result.day, stats: cloneStats(cache) };
    });
  }

  async function summaryOf(options) {
    const stats = await get();
    return summary(stats, options);
  }

  return { file, load, get, record, addDuration, summary: summaryOf };
}

module.exports = {
  DEFAULT_GOAL,
  MAX_GOAL,
  MAX_DAY_SECONDS,
  MAX_STATS_FILE_BYTES,
  localDayKey,
  parseDayKey,
  shiftDayKey,
  normalizeGoal,
  daysInMonth,
  calendarLevel,
  sanitizeStats,
  sanitizeDuration,
  dayTotal,
  daySeconds,
  recordChars,
  saveCharsDelta,
  recordSaveChars,
  recordDuration,
  recentDays,
  summary,
  aggregate,
  monthView,
  streak,
  createStatsStore
};
