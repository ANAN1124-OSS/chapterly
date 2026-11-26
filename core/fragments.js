// 灵感箱（碎片速记）：纯逻辑 + 独立存储（书架根目录/_碎片）。
//
// 设计约束（来自提案 3.4 与项目红线）：
// - 全是普通 txt：资源管理器直接可见，不新增格式、不改 书目.json、不碰章节文件；
// - 文件名用「YYYY-MM-DD-N.txt」（本机日期 + 当天序号），新建时自动找下一个空号，绝不覆盖已有碎片；
// - 写盘一律走 core/atomic（临时文件 + fsync + rename），UTF-8 无 BOM、CRLF（记事本友好）；
// - _碎片 是书架根目录下以 _ 开头的目录，书架扫描本来就会跳过（不会当成一本书）；
// - 读取只认 _碎片 顶层的 .txt 文件名，拒绝路径穿越；超长文件/碎片明确报错，不硬塞进编辑区。
const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteFile, cleanupOrphanTmpFiles, stripBom } = require('./atomic');
const { pad2, formatCount, createWriteQueue, mapLimit } = require('./common');
// 字数口径唯一实现（core/chapters.js 的 countChars）；这里不再自己抄一份（v0.9 B-2 / 审计 F1）。
const chaptersLib = require('./chapters');

const FRAGMENT_DIR_NAME = '_碎片';
const NAME_RE = /^(\d{4})-(\d{2})-(\d{2})-(\d+)\.txt$/;
// PM-4（五-L11）：文件名序号的唯一上限 —— 解析与生成必须同口径。旧实现解析只认到 999999，
// nextFragmentSerial 却 max+1 不封顶：第 100 万条写成 YYYY-MM-DD-1000000.txt（列表里 date/seq
// 为 null），之后再新建算出的还是 1000000 → stat 命中 → 「同名已存在，请再点一次保存」永远无效。
const MAX_FRAGMENT_SEQ = 999999;
const SERIAL_EXHAUSTED_MESSAGE =
  `当天的碎片序号已满（最多 ${MAX_FRAGMENT_SEQ} 条），今天不能再新建；` +
  '可以先把 _碎片 文件夹里的旧碎片整理归档，或明天再存';
const MAX_TEXT_CHARS = 100000; // 单条碎片最多 10 万字（够放一整段灵感，又不会把界面卡死）
const MAX_READ_BYTES = 4 * 1024 * 1024; // 读外部手写 txt 的上限；超过只报错，不截断插入
const MAX_READ_CHARS = 200000;
const LIST_LIMIT = 300;
const PREVIEW_CHARS = 120;
const PREVIEW_READ_BYTES = 8192;
// B7（v1.8.0 WP-28）：列表 stat / 读预览的并发上限（与 core/history.js 的 HISTORY_STAT_CONCURRENCY 同值）。
// 碎片多的时候串行 stat + 串行读 8KB 预览会按条数累加；8 路既快又不会把盘 / 杀软打满。
const LIST_IO_CONCURRENCY = 8;

class FragmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FragmentError';
    this.code = code;
  }
}

// 本机时区的日期戳（YYYY-MM-DD）；坏日期退回「现在」，保证永远是合法文件名。
function formatDateStamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const safe = d instanceof Date && Number.isFinite(d.getTime()) ? d : new Date();
  return `${safe.getFullYear()}-${pad2(safe.getMonth() + 1)}-${pad2(safe.getDate())}`;
}

function isValidDayStamp(stamp) {
  if (typeof stamp !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(stamp.trim());
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1970 || year > 9999) return false;
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

// 只认本应用生成的「日期-序号.txt」；手工改名的 txt 也会被列出可插入，只是没有日期/序号。
function parseFragmentName(name) {
  if (typeof name !== 'string') return null;
  const match = NAME_RE.exec(name.trim());
  if (!match) return null;
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  if (!isValidDayStamp(date)) return null;
  const seq = Number(match[4]);
  if (!Number.isFinite(seq) || seq < 1 || seq > MAX_FRAGMENT_SEQ) return null;
  return { date, seq };
}

// 当天序号：取已有同日期碎片的最大序号 + 1（从 1 开始）。删掉的号不回收，避免和回收站里的旧文件撞名。
// 到顶（999999）时明确报错，绝不返回一个自己解析不认的名字（见 MAX_FRAGMENT_SEQ 的注释）。
function nextFragmentSerial(names, stamp) {
  let max = 0;
  for (const name of Array.isArray(names) ? names : []) {
    const parsed = parseFragmentName(name);
    if (!parsed || parsed.date !== stamp) continue;
    if (parsed.seq > max) max = parsed.seq;
  }
  if (max >= MAX_FRAGMENT_SEQ) throw new FragmentError('SERIAL_EXHAUSTED', SERIAL_EXHAUSTED_MESSAGE);
  return max + 1;
}

function nextFragmentName(existingNames, now = new Date()) {
  const stamp = formatDateStamp(now);
  return `${stamp}-${nextFragmentSerial(existingNames, stamp)}.txt`;
}

// 写入前的清洗：去 BOM、CRLF/CR 归一成 LF、去掉首尾空白；空内容与超长明确拒绝。
function cleanFragmentText(text, { maxChars = MAX_TEXT_CHARS } = {}) {
  const limit = Number.isFinite(Number(maxChars)) ? Math.max(1, Math.round(Number(maxChars))) : MAX_TEXT_CHARS;
  let value;
  try {
    value = String(text == null ? '' : text);
  } catch {
    value = '';
  }
  value = stripBom(value).replace(/\r\n?/g, '\n').trim();
  if (!value) {
    return { ok: false, code: 'EMPTY', message: '碎片内容是空的，写点什么再保存吧' };
  }
  if (value.length > limit) {
    return {
      ok: false,
      code: 'TOO_LONG',
      message: `碎片太长（${formatCount(value.length)} 字，最多 ${formatCount(limit)} 字）；可以拆成两条，或先放正文里`
    };
  }
  return { ok: true, text: value, chars: chaptersLib.countChars(value), maxChars: limit };
}

// 列表里的预览：压成一行、去掉多余空白，超出加省略号。
function previewText(text, limit = PREVIEW_CHARS) {
  const oneLine = String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim();
  const max = Math.max(1, Math.round(Number(limit) || PREVIEW_CHARS));
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

// 最新在前：先按修改时间倒序，时间相同再按文件名倒序（序号大的更新）。
function sortFragments(fragments) {
  return (Array.isArray(fragments) ? fragments.slice() : []).sort((a, b) => {
    const delta = (Number(b && b.mtimeMs) || 0) - (Number(a && a.mtimeMs) || 0);
    if (delta) return delta;
    return String((b && b.name) || '').localeCompare(String((a && a.name) || ''), 'zh-Hans-CN');
  });
}

function assertFragmentName(raw) {
  const name = String(raw == null ? '' : raw).trim();
  if (
    !name ||
    name !== path.basename(name) ||
    name.startsWith('.') ||
    !/\.txt$/i.test(name) ||
    /[\\/:*?"<>|]/.test(name)
  ) {
    throw new FragmentError('BAD_NAME', '碎片文件名不合法');
  }
  // A2U-03（2026-11-26 复核）：CON / NUL / COM1 这类 Windows 设备名当文件名会在不同 API 上
  // 表现不一致（有的报错、有的重定向到设备），必须和章节文件同一道保留名闸门。
  if (chaptersLib.reservedStem(name)) {
    throw new FragmentError('BAD_NAME', '碎片文件名不能使用系统保留名');
  }
  return name;
}

function fragmentDir(booksRoot) {
  const root = String(booksRoot == null ? '' : booksRoot).trim();
  if (!root) throw new FragmentError('BAD_ROOT', '书架目录未设置');
  return path.join(root, FRAGMENT_DIR_NAME);
}

async function listTxtNames(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    if (err.code === 'ENOTDIR') {
      throw new FragmentError('BAD_DIR', '_碎片 不是一个文件夹，请先在资源管理器里检查');
    }
    throw err;
  }
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && /\.txt$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function readPreview(filePath, size) {
  const length = Math.max(0, Math.min(Number(size) || 0, PREVIEW_READ_BYTES));
  if (!length) return { preview: '', text: '' };
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    let text = stripBom(buffer.subarray(0, bytesRead).toString('utf8')).replace(/\r\n?/g, '\n');
    // 截断可能切在 UTF-8 字符中间：末尾的替换字符不属于正文，预览里去掉。
    text = text.replace(/\uFFFD+$/, '');
    return { preview: previewText(text), text };
  } catch {
    return { preview: '', text: '' };
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* 忽略关闭失败 */
      }
    }
  }
}

function createFragmentStore(booksRoot, options = {}) {
  const dir = fragmentDir(booksRoot);
  // stat / 读预览 / 并发度只给单测注入（生产一律走真实 fs）；缺省与旧行为完全一致。
  const settings = options && typeof options === 'object' ? options : {};
  const statFile = typeof settings.stat === 'function' ? settings.stat : (target) => fs.stat(target);
  const readPreviewFor = typeof settings.readPreview === 'function' ? settings.readPreview : readPreview;
  const requestedConcurrency = Number(settings.concurrency);
  const concurrency =
    Number.isFinite(requestedConcurrency) && requestedConcurrency > 0
      ? Math.floor(requestedConcurrency)
      : LIST_IO_CONCURRENCY;
  // 碎片写入串行化（同一个 txt 绝不并发写）——实现见 core/common.js 的 createWriteQueue（B6）。
  // X10（v1.8.0 WP-40）：额外维护「排队 + 在跑」的写数，供 store 缓存判定「这个实例现在能不能淘汰」。
  const writeQueue = createWriteQueue();
  let pendingWrites = 0;
  function enqueue(task) {
    pendingWrites += 1;
    const run = writeQueue.enqueue(task);
    const settle = () => {
      pendingWrites = Math.max(0, pendingWrites - 1);
    };
    run.then(settle, settle);
    return run;
  }

  // A2-FRAG-01（低）：碎片写走 atomicWriteFile，临时文件（`.名.tmp-pid-ts-rand`）落在 _碎片 里；
  // 断电 / 强杀会在 rename 前留下隐藏半成品，而 X8 的孤儿回收只覆盖 userData / 导出目录 / 书架根
  // .import-* / 书目录 —— _碎片 一个回收点都没有（列表只认 .txt，作者也看不见）。首次 list() 时
  // 顺手按同一口径（非本进程 pid + 超过 1 小时 + 本应用命名）回收一次；每个 store 实例只跑一次，
  // 失败静默 —— 列表动作绝不因为清理失败而报错。
  let orphanSweepDone = false;
  async function sweepOrphanTmpOnce() {
    if (orphanSweepDone) return;
    orphanSweepDone = true;
    const cleanup = typeof settings.cleanupOrphans === 'function' ? settings.cleanupOrphans : cleanupOrphanTmpFiles;
    try {
      await cleanup(dir);
    } catch {
      /* 回收失败不影响列碎片 */
    }
  }

  // 列表：_碎片 顶层所有 .txt（含用户自己放进去的 txt），最新在前，最多 LIST_LIMIT 条。
  // 目录不存在 = 空列表，绝不因为列表动作创建文件夹。
  // B7（v1.8.0 WP-28）：先并发 stat 全部候选 → 按 mtime 粗排 → 只给前 LIST_LIMIT 条读 8KB 预览。
  // 以前逐条「stat → 读预览」做完才排序截断，为被截掉的条目白读；返回字段 / 顺序 / total/truncated 口径不变。
  async function list() {
    await sweepOrphanTmpOnce();
    const names = await listTxtNames(dir);
    const stats = await mapLimit(names, concurrency, async (name) => {
      try {
        const stat = await statFile(path.join(dir, name));
        return stat && stat.isFile() ? { name, stat } : null;
      } catch {
        return null; // 刚好被移走/占用：跳过，不影响其它碎片
      }
    });
    const entries = [];
    for (const hit of stats) {
      if (!hit) continue;
      const parsed = parseFragmentName(hit.name);
      entries.push({
        name: hit.name,
        date: parsed ? parsed.date : null,
        seq: parsed ? parsed.seq : null,
        size: hit.stat.size,
        mtimeMs: hit.stat.mtimeMs
      });
    }
    const sorted = sortFragments(entries);
    const shown = sorted.slice(0, LIST_LIMIT);
    // 只给真正会返回的前 300 条读预览（并发）；被截掉的条目一个字节都不读
    const previews = await mapLimit(shown, concurrency, (entry) =>
      readPreviewFor(path.join(dir, entry.name), entry.size)
    );
    for (let i = 0; i < shown.length; i += 1) {
      shown[i].preview = previews[i] && typeof previews[i].preview === 'string' ? previews[i].preview : '';
    }
    return {
      dir,
      total: sorted.length,
      truncated: sorted.length > LIST_LIMIT,
      fragments: shown
    };
  }

  // 新建：内容非空、长度受控；文件名当天递增；写盘前再确认一次不重名（双保险，绝不覆盖旧碎片）。
  function create(text, { now = new Date(), maxChars = MAX_TEXT_CHARS } = {}) {
    return enqueue(async () => {
      const cleaned = cleanFragmentText(text, { maxChars });
      if (!cleaned.ok) throw new FragmentError(cleaned.code, cleaned.message);
      const names = await listTxtNames(dir);
      const stamp = formatDateStamp(now);
      const name = nextFragmentName(names, now);
      const target = path.join(dir, name);
      // 双保险：同进程写入已串行、序号取最大 + 1；这里再确认一次目标不存在，绝不覆盖旧碎片。
      try {
        await fs.stat(target);
        throw new FragmentError('NAME_CONFLICT', '同名碎片已存在，请再点一次保存');
      } catch (err) {
        if (err instanceof FragmentError) throw err;
        if (err.code !== 'ENOENT') throw err;
      }
      const diskText = cleaned.text.replace(/\n/g, '\r\n');
      await atomicWriteFile(target, diskText);
      const stat = await fs.stat(target);
      return {
        dir,
        name,
        path: target,
        date: stamp,
        chars: cleaned.chars,
        length: cleaned.text.length,
        bytes: stat.size,
        mtimeMs: stat.mtimeMs
      };
    });
  }

  // 读取一条碎片：只认 _碎片 顶层的 .txt，拒绝路径穿越；统一成 LF 给编辑区用。
  async function read(rawName) {
    const name = assertFragmentName(rawName);
    const filePath = path.join(dir, name);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (err) {
      if (err.code === 'ENOENT') throw new FragmentError('NOT_FOUND', '这条碎片已经不在 _碎片 文件夹里了');
      throw err;
    }
    if (!stat.isFile()) throw new FragmentError('NOT_FOUND', '这条碎片已经不在 _碎片 文件夹里了');
    if (stat.size > MAX_READ_BYTES) {
      throw new FragmentError('TOO_LARGE', '碎片文件太大（超过 4MB），请先在记事本里拆分');
    }
    // V221-FRAG-01（2026-11-26 复核）：4MB 只是资源上限；再按「UTF-8 每字符最多 4 字节」反推
    // 20 万字上限 —— 超过 800KB 的文件必然超字数，不必先整份解码出几十万字再拒绝。
    if (stat.size > MAX_READ_CHARS * 4) {
      throw new FragmentError('TOO_LARGE', '碎片太长（超过 20 万字），请先拆分再插入');
    }
    const raw = await fs.readFile(filePath, 'utf8');
    const text = stripBom(raw).replace(/\r\n?/g, '\n');
    if (text.length > MAX_READ_CHARS) {
      throw new FragmentError('TOO_LARGE', `碎片太长（${formatCount(text.length)} 字），请先拆分再插入`);
    }
    return { name, text, chars: chaptersLib.countChars(text), size: stat.size, mtimeMs: stat.mtimeMs };
  }

  return { dir, list, create, read, hasPendingWrites: () => pendingWrites > 0 };
}

// 跨 IPC 的 store 单例缓存（V74）：写队列（core/common.js 的 createWriteQueue）是实例私有的，
// 每次 createFragmentStore 新建实例 = 各一条队列。两个窗口毫秒级同时保存碎片时，双方都会通过
// 「目标不存在」检查，atomicWriteFile 的 rename 后写覆盖先写——先保存的正文静默丢失，两边却都收到
// 成功回执。main.js 的三个 fragments 频道改走 getFragmentStore(cfg.booksRoot)，让同一个书架根目录
// 在所有窗口 / 频道间共用同一个 store（同一条写队列）。
// key = path.resolve(String(booksRoot)).toLowerCase()：相对写法 / 尾分隔符归一，Windows 大小写不敏感。
// X10（v1.8.0 WP-40，审计 X10）：淘汰规则改「LRU + 仅空闲淘汰」。命中算一次使用（移到队尾）；
// 超上限时只淘汰写队列空闲（没有排队 / 在跑任务）的实例，从最久没用的开始。正在写的实例一个都不挤掉——
// 挤掉它、下一条同根请求就会新建第二个 store = 同根两条写队列，正好把 V74 修过的竞态请回来；
// 全是忙的就先让缓存临时超过上限（宁可多留一份内存，也不制造第二条队列）。
// store 没有需要关闭的资源——写队列 settle 后条目自回收，被淘汰只是不再复用。
// createFragmentStore 保留原样：每次调用仍新建实例（既有单测与「每实例独立」语义不动）。
const STORE_CACHE_MAX = 2;
const storeCache = new Map();

function isStoreBusy(store) {
  return typeof store.hasPendingWrites === 'function' ? Boolean(store.hasPendingWrites()) : false;
}

function evictIdleStores(currentKey) {
  let removed = 0;
  for (const [key, store] of storeCache) {
    if (storeCache.size <= STORE_CACHE_MAX) break;
    if (key === currentKey) continue; // 刚交出去的实例先留着
    if (isStoreBusy(store)) continue;
    storeCache.delete(key);
    removed += 1;
  }
  return removed;
}

// 第二个参数只给单测注入 store 工厂（验证 LRU / 忙实例不淘汰）；产品调用只传 booksRoot。
function getFragmentStore(booksRoot, options = {}) {
  const key = path.resolve(String(booksRoot)).toLowerCase();
  const cached = storeCache.get(key);
  if (cached) {
    // 命中即「最近使用」：Map 的插入顺序就是 LRU 顺序
    storeCache.delete(key);
    storeCache.set(key, cached);
    return cached;
  }
  const factory = typeof options.storeFactory === 'function' ? options.storeFactory : createFragmentStore;
  const store = factory(booksRoot);
  storeCache.set(key, store);
  evictIdleStores(key);
  return store;
}

// 单测用：清空缓存（避免不同用例的根目录互相污染）；产品代码不调用。
function resetFragmentStoreCache() {
  storeCache.clear();
}

// 单测用：当前缓存里的 key（LRU 顺序，最久没用的在前），不发请求、不触发淘汰。
function fragmentStoreCacheKeys() {
  return Array.from(storeCache.keys());
}

module.exports = {
  MAX_TEXT_CHARS,
  MAX_READ_BYTES,
  // V221-FRAG-01：读侧字数上限（单测拿它算「必然超限」的字节数）
  MAX_READ_CHARS,
  LIST_LIMIT,
  STORE_CACHE_MAX,
  formatDateStamp,
  isValidDayStamp,
  parseFragmentName,
  nextFragmentSerial,
  nextFragmentName,
  cleanFragmentText,
  previewText,
  sortFragments,
  assertFragmentName,
  createFragmentStore,
  getFragmentStore,
  resetFragmentStoreCache,
  fragmentStoreCacheKeys
};
