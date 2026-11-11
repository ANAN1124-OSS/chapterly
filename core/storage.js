// 磁盘层：书架扫描、书目读写、章节文件读写。
// 不 require('electron')，可直接在 node:test 里用临时目录测试。
const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteFile, writeJsonAtomic, stripBom } = require('./atomic');
const { pad2, nowIso, mapLimit, createKeyedWriteQueue } = require('./common');
const chaptersLib = require('./chapters');
const findLib = require('./find');
const formatLib = require('./format');
const schemaLib = require('./schema');
const conflictLib = require('./conflict');
const bookInfoLib = require('./bookinfo');
const historyLib = require('./history');
const snapshotLib = require('./snapshot');
const openBooksLib = require('./open-books');
const errorText = require('./error-text');
const previewCacheLib = require('./preview-cache');

const BOOK_FILE = '书目.json';
const BOOK_BAK = '书目.json.bak';
const TRASH_DIR = '_trash';
const CORRUPT_PREFIX = '书目.json.corrupt-';
// 整本替换的备份目录（写盘前把原章节复制到这里）与「还原前」的反向备份目录
const REPLACE_BACKUP_PREFIX = '替换备份-';
const RESTORE_BACKUP_PREFIX = '还原前备份-';
// 整本智能排版的备份目录（写盘前把要改动的原章节复制到这里）
const FORMAT_BACKUP_PREFIX = '整理备份-';
// B4（审计 P4）：整本操作逐章读盘时并行读的章数。读是 IO 等待，串行会让「整本查找 /
// 替换 / 整理 / 导出 / 校对」在几百章的书上白等；写盘仍然串行且按原顺序（见各函数注释）。
const CHAPTER_READ_CONCURRENCY = 8;
// C1（审计 #1 / P1）：整本操作按批读正文的批大小。以前「全书 texts 一次读进数组再处理」，
// 1000 章 × 1 MB ≈ 1 GB 常驻主进程；现在每批最多 32 章，批内仍然限并发 8，
// 一批处理完就把这批正文的引用丢掉。分批只改「什么时候读」，不改顺序 / 结果 / 统计口径
// （tests/book-batch.test.js 钉住跨批等价与批边界）。
const CHAPTER_BATCH_SIZE = 32;
// C2（审计 #2 / P2）：「预览 → 执行」正文快照（只存在主进程内存里，见 core/preview-cache.js）。
// 预览（整本查找 / 整理预检查）把读到的正文连同当时的 mtime / size 记进快照；执行（整本替换 /
// 整本整理）命中且文件没变就直接复用，不再读第二遍。有 TTL 与容量上界，超了照旧读盘。
const chapterPreviewCache = previewCacheLib.createPreviewCache();

class StorageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

// 批次破坏性操作（整本整理 / 整本替换 / 还原到替换前）中途失败时的统一报错。
// 半成品本身不是灾难 —— 每一章都是原子写、改之前都先把原件复制进 _trash；
// 真正危险的是作者不知道「书现在是什么状态、原件在哪里」，所以错误信息必须带上
// 「已经动了多少章」和「备份目录名」（只给 _trash 下的名字，绝不含本机路径）。
function batchFailure(err, { code, action, notes = [] }) {
  const reason = errorText.describeForUi(err).message;
  const parts = [`${action}中途停下：${reason}`];
  for (const note of notes) if (note) parts.push(note);
  return new StorageError(code, parts.join('；'));
}

// P2-3（1.5.0）：还原（替换备份 / 本书历史）与每日快照都是「整个文件读进主进程内存 → 原子写回」。
// 章节文件被外部程序换成超大文件（误放的视频 / 日志 / 数据库导出）时，会直接把主进程内存打爆
// 而崩掉整个应用。所以读之前先看 stat.size，超限明确拒绝、一个字节都不写。
// 口径对齐 core/importer.js 的导入上限（1000 万字中文小说约 30 MB，128 MB 有三倍以上余量）。
// 这里不 require('./importer')：importer 依赖 storage，反向引用会成环；体量文案口径保持一致。
const MAX_CHAPTER_READ_BYTES = 128 * 1024 * 1024;
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'];

// 体量文案（与 core/importer.js 的 formatImportSize 同口径：1 位小数直到 10 以上）
function formatByteSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '0 B';
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  const shown = value < 10 ? value.toFixed(1) : String(Math.round(value));
  return `${shown} ${BYTE_UNITS[unit]}`;
}

// 纯逻辑：把一个「整文件读进内存」的尺寸判成 null（放行）或 { code, message }（拒绝）。
// stat 拿不到 / 坏尺寸（NaN、负数）不在这里拦，交给后面的读盘按原样报错。
function readSizeProblem(bytes, { code, label, tail = '' } = {}) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return null;
  if (size <= MAX_CHAPTER_READ_BYTES) return null;
  const limit = formatByteSize(MAX_CHAPTER_READ_BYTES);
  return {
    code,
    message: `${label}有 ${formatByteSize(size)}，超过单文件读取上限 ${limit}${tail ? `，${tail}` : ''}`
  };
}

// 读还原 / 快照的来源文件前的大小闸门：先 stat，超限抛 StorageError（不读内容、不写盘）。
// 返回 stat 供调用方复用；ENOENT 等 IO 错误原样上抛，交给各调用点按原逻辑处理。
async function assertSourceSize(source, options) {
  const stat = await fs.stat(source);
  const problem = readSizeProblem(stat.size, options);
  if (problem) throw new StorageError(problem.code, problem.message);
  return stat;
}

// 读还原用的源文件：先过大小闸门再读。
async function loadChapterSource(source, options) {
  await assertSourceSize(source, options);
  return fs.readFile(source);
}

// 整批还原前的一次性预检：同一批里任何一个源文件超限就整批拒绝 —— 此时还一个字节都没写，
// 作者看到的是「没有还原」，而不是「还原到一半停下」。
// 只做闸门：stat 失败（文件刚被删 / 被占用）留给后面的读盘 / 批次失败逻辑按原样报错。
async function preflightRestoreSources(entries, options) {
  for (const { source, label } of entries) {
    let stat;
    try {
      stat = await fs.stat(source);
    } catch {
      continue;
    }
    const problem = readSizeProblem(stat.size, { ...options, label });
    if (problem) throw new StorageError(problem.code, problem.message);
  }
}

// 备份目录 → 界面上可以显示的相对位置（形如 `_trash/整理备份-2026-11-01-223000`）
function trashDirLabel(dir) {
  return dir ? `${TRASH_DIR}/${path.basename(dir)}` : '';
}

// nowIso / mapLimit 从 core/common.js 来（B6）：和 search-index 建索引时同一份实现
// （限并发、ISO 时间戳），这里只保留 nowIso 的对外导出（旧调用方按名字取）。

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function assertInside(bookPath, file) {
  const root = path.resolve(bookPath);
  const target = path.resolve(bookPath, file);
  // B4（审计 #21 / N4）：前缀比较统一小写 —— Windows 路径不分大小写，
  // 严格比较会把 `C:\Books\书` 与 `c:\books\书\x.txt` 当成「越界」；
  // 与 core/ipc-paths.js 的 assertBookPath 口径保持一致（不 realpath，见 README 已知限制）。
  const rootCmp = root.toLowerCase();
  const targetCmp = target.toLowerCase();
  if (targetCmp !== rootCmp && !targetCmp.startsWith(`${rootCmp}${path.sep}`)) {
    throw new StorageError('BAD_PATH', `非法的章节文件路径：${file}`);
  }
  return target;
}

// 章节文件字段（书目.json 的 chapters[].file）的防退化校验（审计 B4 / #21、N1、N2）。
// assertInside 只拦「逃逸出书目录」，不拦「退化」：空串 / 子目录 / 绝对路径 / 非 txt /
// Windows 保留设备名都能通过前缀检查。写盘前一律过这里 —— 宁可把这种书记成损坏
// （书架显示「点开可以修复」，可从目录重建），也绝不按坏字段写错文件 / 建出嵌套目录。
// 只读入口同样过它：坏字段会让书显式报 BAD_PATH，而不是静默读错或「缺章」。
// 注意：不要把「nul.txt 假成功丢稿」当成本函数的理由（勘误 E1 实测 Node 能落成普通文件）；
// 保留名过滤是为壳层 / 工具兼容性（E2）。
function assertChapterFile(bookPath, file) {
  if (typeof file !== 'string' || !file.trim()) {
    throw new StorageError('BAD_PATH', '章节文件名为空');
  }
  if (path.basename(file) !== file) {
    throw new StorageError('BAD_PATH', `非法的章节文件路径：${file}`);
  }
  if (!/\.txt$/i.test(file)) {
    throw new StorageError('BAD_PATH', `章节文件必须是 .txt：${file}`);
  }
  if (chaptersLib.reservedStem(file)) {
    throw new StorageError('BAD_PATH', `章节文件名不能使用系统保留名：${file}`);
  }
  return assertInside(bookPath, file);
}

// 按章节 id 找下标；找不到统一抛 CHAPTER_NOT_FOUND（界面提示由 preload / main 原样转出）。
// 6 个写盘入口共用：移到卷 / 拖到某卷某位置 / 重命名 / 改章节信息 / 删除章节 / 拖拽排序。
// 消息与收编前逐字一致：「章节不存在（可能已被删除）」。
function chapterIndexOrThrow(meta, chapterId) {
  const index = chaptersLib.findChapterIndex(meta, chapterId);
  if (index < 0) throw new StorageError('CHAPTER_NOT_FOUND', '章节不存在（可能已被删除）');
  return index;
}

function validateMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw new StorageError('INVALID_META', '书目.json 的内容不是一个对象');
  }
  if (!Array.isArray(meta.chapters)) {
    throw new StorageError('INVALID_META', '书目.json 缺少 chapters 数组');
  }
  meta.chapters.forEach((c, i) => {
    if (!c || typeof c !== 'object') {
      throw new StorageError('INVALID_META', `第 ${i + 1} 条章节记录不是对象`);
    }
    if (typeof c.file !== 'string' || !c.file.trim()) {
      throw new StorageError('INVALID_META', `第 ${i + 1} 条章节记录缺少 file 字段`);
    }
  });
  return true;
}

async function readBookMeta(bookPath) {
  const metaPath = path.join(bookPath, BOOK_FILE);
  let raw;
  try {
    raw = await fs.readFile(metaPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new StorageError('NO_BOOK', `没有找到 ${BOOK_FILE}`);
    throw err;
  }
  let meta;
  try {
    meta = JSON.parse(stripBom(raw));
  } catch {
    throw new StorageError('PARSE_ERROR', `${BOOK_FILE} 解析失败（内容不是合法 JSON）`);
  }
  validateMeta(meta);
  // 版本迁移：v0.4.x 的书没有 schemaVersion，按版本 0 走一遍迁移（目前是空迁移），
  // 只在内存里补成 1；下次正常写盘才会落进 书目.json。未来版本号原样保留。
  meta = schemaLib.migrateMeta(meta);
  meta.chapters = meta.chapters.map((c, i) =>
    chaptersLib.cleanChapterMeta({
      ...c,
      id: typeof c.id === 'string' && c.id ? c.id : `ch_${chaptersLib.pad3(i + 1)}`,
      name: typeof c.name === 'string' ? c.name : '',
      createdAt: typeof c.createdAt === 'string' ? c.createdAt : nowIso()
    })
  );
  if (typeof meta.titleTemplate !== 'string' || !meta.titleTemplate.trim()) {
    meta.titleTemplate = chaptersLib.TITLE_TEMPLATE;
  }
  // 章号编号方式（2026-11-10）：旧书目没有这个字段 = 全书连续（零迁移）。
  // 只认 'volume'；'continuous' / 坏值一律不落进内存（连续是默认，不必占字段）。
  if (meta.chapterNumbering !== undefined && meta.chapterNumbering !== 'volume') {
    delete meta.chapterNumbering;
  }
  if (!Number.isFinite(Number(meta.fileSeq))) meta.fileSeq = meta.chapters.length;
  if (typeof meta.title !== 'string') meta.title = path.basename(bookPath);
  // 分卷：清掉非法卷、把指向不存在卷的章归为「未分卷」，并把章节顺序归一成「未分卷 → 第1卷 → …」
  const normalized = chaptersLib.normalizeChapterOrder({
    ...meta,
    volumes: chaptersLib.sanitizeVolumes(meta.volumes)
  });
  // 书籍信息（v0.8-3）：作者 / 简介 / 分组 / 标签都是可选的，读取时清洗但不补字段；
  // 旧书目没有它们照常打开（下次正常写盘也不会凭空多出来）。
  return bookInfoLib.cleanBookInfo(normalized);
}

async function writeBookMeta(bookPath, meta, { ensureDir: ensureDirectory = true, structural = false, touchUpdatedAt = true } = {}) {
  if (ensureDirectory) await ensureDir(bookPath);
  const metaPath = path.join(bookPath, BOOK_FILE);
  const bakPath = path.join(bookPath, BOOK_BAK);
  // B2（审计 P2）：.bak 只在「结构性变更」时轮换（增删章 / 改名 / 分卷 / 导入 / 改书名…），
  // 普通保存（章节正文、字数缓存、上次打开章节）跳过第二次 fsync。
  // 备份语义刻意保守：调用方要显式传 { structural: true } 才轮换；不传 = 只写主文件。
  // 「修复 / 从 .bak 恢复」流程会先把主文件改名归档，这里读不到主文件（ENOENT）就自然跳过，
  // 不会用坏文件覆盖掉唯一可用的 .bak。
  if (structural) {
    try {
      const old = await fs.readFile(metaPath);
      await atomicWriteFile(bakPath, old, 'utf8', { ensureDir: ensureDirectory });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  const next = {
    ...meta,
    // 新书 / 旧书第一次写盘时补上版本号；比本应用新的版本不降级
    schemaVersion: schemaLib.normalizeSchemaVersion(meta.schemaVersion),
    // 1.6.0 A2（审计 E-06）：书架扫描回填字数缓存时传 touchUpdatedAt:false —— 扫描是只读行为，
    // 不许把 updatedAt 顶到现在（否则打开书架就把书往前挪、同步工具也以为书目被改过）。
    // 老书没有 updatedAt 时仍补一个（第一次写盘）。显式操作（建 / 改 / 删 / 保存）一律保持默认 true。
    updatedAt: touchUpdatedAt ? nowIso() : meta.updatedAt || nowIso()
  };
  await writeJsonAtomic(metaPath, next, { ensureDir: ensureDirectory });
  return next;
}

async function listTxtFiles(bookPath) {
  let entries;
  try {
    entries = await fs.readdir(bookPath, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((e) => e.isFile() && /\.txt$/i.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

// 并发上限工具：书架扫描时并行读多本书的 书目.json（机械盘/杀软环境下串行会明显慢）
// —— 实现见 core/common.js 的 mapLimit（B6：与 search-index 建索引共用同一份）。

// 把「刚读出来的章节字数」合并进「锁里重新读到的 meta」：
// 只补仍然缺 chars 的章，别人在这期间新建/改名/删除的章节原样保留，不会被旧 meta 覆盖。
function mergeCharsCache(freshMeta, cachedChapters) {
  let changed = false;
  const byId = new Map();
  const byFile = new Map();
  for (const chapter of freshMeta.chapters) {
    if (chapter.id) byId.set(chapter.id, chapter);
    if (chapter.file) byFile.set(chapter.file, chapter);
  }
  for (const cached of cachedChapters) {
    if (!Number.isFinite(cached.chars)) continue;
    const target = (cached.id && byId.get(cached.id)) || (cached.file && byFile.get(cached.file));
    if (!target || Number.isFinite(target.chars)) continue;
    target.chars = cached.chars;
    changed = true;
  }
  return { meta: freshMeta, changed };
}

// 书架扫描用的统计：字数走 书目.json 缓存，不再每次重读整本书；
// 缓存缺失时只读缺的那几章并把缓存写回（老书首次扫描慢一点，之后秒开）。
// writeCache=false 时只算不写（保存后的后台全书校验用：那一趟必须是纯读，
// 否则会悄悄改 书目.json —— 复制 / 导出等「只读」操作会看到书被改写）。
// 章节字数缓存回填的并发上限：和书架列书目的 12 路、缺章 stat 的 16 路分开（读盘 vs 只 stat）。
// 老书首次扫描要读 1000 章正文，串行在机械盘 / 杀软下要到秒级；8 路既快又不会把盘打满。
const CHAPTER_BACKFILL_CONCURRENCY = 8;

// 把「缺 chars 缓存」的章节正文并发读出来算字数，就地写回 chapter.chars。
// readText 可注入（单测用它数并发峰值，不测墙钟）；ENOENT（章节记录还在、文件被删）跳过不抛。
async function backfillChapterChars(bookPath, chapters, options = {}) {
  const settings = options && typeof options === 'object' ? options : {};
  const readText = settings.readText || ((targetPath, chapter) =>
    fs.readFile(assertChapterFile(targetPath, chapter.file), 'utf8'));
  const concurrency = settings.concurrency === undefined ? CHAPTER_BACKFILL_CONCURRENCY : settings.concurrency;
  let changed = false;
  await mapLimit(Array.isArray(chapters) ? chapters : [], concurrency, async (chapter) => {
    if (!chapter || Number.isFinite(chapter.chars)) return;
    try {
      const text = await readText(bookPath, chapter);
      chapter.chars = chaptersLib.countChars(stripBom(text));
      changed = true;
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      throw err;
    }
  });
  return changed;
}

async function bookStats(bookPath, meta, { writeCache = true } = {}) {
  let totalChars = 0;
  const needRead = [];
  for (const chapter of meta.chapters) {
    if (Number.isFinite(chapter.chars)) totalChars += chapter.chars;
    else needRead.push(chapter);
  }
  if (needRead.length) {
    const changed = await backfillChapterChars(bookPath, needRead);
    for (const chapter of needRead) {
      if (Number.isFinite(chapter.chars)) totalChars += chapter.chars;
    }
    if (changed && writeCache) {
      // 写缓存必须走书锁，而且要锁内重读 meta 再合并：
      // 否则「扫描读到的旧 meta + 补字数」会覆盖掉同时发生的建章/改名/删除（真实丢操作路径）。
      try {
        await withBookLock(bookPath, async () => {
          const fresh = await readBookMeta(bookPath);
          const merged = mergeCharsCache(fresh, needRead);
          // 只补字数缓存：这不是用户操作，updatedAt 保持原值（审计 E-06）
          if (merged.changed) await writeBookMeta(bookPath, merged.meta, { touchUpdatedAt: false });
        });
      } catch { /* 缓存写不进去不影响书架显示 */ }
    }
  }
  const updatedAt = Date.parse(meta.updatedAt || meta.createdAt || '');
  return { totalChars, latestMtime: Number.isFinite(updatedAt) ? updatedAt : Date.now() };
}

// 打开书/保存后校验用：并行 stat 每章文件，找出缺失的章节文件
async function findMissingChapters(bookPath, meta, concurrency = 16) {
  const flags = await mapLimit(meta.chapters, concurrency, async (chapter) => {
    try {
      await fs.stat(assertChapterFile(bookPath, chapter.file));
      return null;
    } catch (err) {
      if (err.code === 'ENOENT') return chapter.file;
      throw err;
    }
  });
  return flags.filter(Boolean);
}

// 同步盘冲突副本：只看书文件夹顶层（_trash 里的备份不算），只提示、不合并、不删除。
// 文件夹读不到（权限/刚好被占用）就当没有，不影响书架显示。
async function scanConflictCopies(bookPath) {
  try {
    const entries = await fs.readdir(bookPath, { withFileTypes: true });
    return conflictLib.findConflictCopies(
      entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
    );
  } catch {
    return [];
  }
}

async function listBooks(booksRoot) {
  // 建目录 + 列目录放在同一个 try 里：书架目录指向一个普通文件 / 盘符不可用时，
  // 以前会抛 Node 的英文 EEXIST 原文（还带完整路径），现在统一成 ROOT_UNREADABLE + 中文原因。
  let entries;
  try {
    await ensureDir(booksRoot);
    entries = await fs.readdir(booksRoot, { withFileTypes: true });
  } catch (err) {
    throw new StorageError('ROOT_UNREADABLE', `书架目录无法读取：${errorText.describeForUi(err).message}`);
  }

  const candidates = entries
    .filter((ent) => ent.isDirectory() && !ent.name.startsWith('_') && !ent.name.startsWith('.'))
    .map((ent) => ({ folder: ent.name, bookPath: path.join(booksRoot, ent.name) }));

  const scanned = await mapLimit(candidates, 12, async ({ folder, bookPath }) => {
    try {
      const meta = await readBookMeta(bookPath);
      const [stats, conflicts] = await Promise.all([
        bookStats(bookPath, meta),
        scanConflictCopies(bookPath)
      ]);
      const info = bookInfoLib.readBookInfo(meta);
      return {
        path: bookPath,
        folder,
        // 1.6.0 F2：书 id 给「统计按书筛选」用（stats.json 的 days.books 按 meta.id 分桶）；
        // 只多回一个字段，不改 书目.json 结构，也不影响排序。
        id: typeof meta.id === 'string' ? meta.id : '',
        status: 'ok',
        title: meta.title || folder,
        schemaVersion: meta.schemaVersion,
        // 书籍信息（v0.8-3）：作者 / 简介 / 分组 / 标签，旧书一律是空值
        author: info.author,
        brief: info.brief,
        group: info.group,
        tags: info.tags,
        chapterCount: meta.chapters.length,
        // 章节名给书架搜索用（书名 / 作者 / 分组 / 标签 / 章节名都是内存过滤，正文另走索引）
        chapterNames: meta.chapters.map((chapter) => chapter.name || ''),
        // 书卡上的「完稿 X/Y 章」（只统计 status === 'done' 的章）
        doneChapters: chaptersLib.countChapterStatuses(meta).done,
        // 同步盘冲突副本的文件名（只提示；不是章节，也不会被自动合并）
        conflicts,
        totalChars: stats.totalChars,
        lastModified: stats.latestMtime,
        missing: []
      };
    } catch (err) {
      if (err && err.code === 'NO_BOOK') return null; // 没有书目的普通文件夹，跳过
      return {
        path: bookPath,
        folder,
        id: '',
        status: 'corrupt',
        title: folder,
        author: '',
        brief: '',
        group: '',
        tags: [],
        chapterCount: 0,
        chapterNames: [],
        doneChapters: 0,
        conflicts: await scanConflictCopies(bookPath),
        totalChars: 0,
        lastModified: 0,
        reason: err.message,
        missing: []
      };
    }
  });

  const books = scanned.filter(Boolean);
  books.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
  return books;
}

async function createBook(booksRoot, title) {
  const displayTitle = String(title == null ? '' : title).trim() || '我的新书';
  await ensureDir(booksRoot);
  const base = chaptersLib.safeName(displayTitle);
  let folder = base;
  let i = 2;
  for (;;) {
    try {
      await fs.mkdir(path.join(booksRoot, folder));
      break;
    } catch (err) {
      if (err.code === 'EEXIST') {
        folder = `${base}-${i}`;
        i += 1;
        continue;
      }
      throw err;
    }
  }
  const bookPath = path.join(booksRoot, folder);
  const seq = 1;
  const file = chaptersLib.buildFileName(seq, '');
  await atomicWriteFile(path.join(bookPath, file), '');
  const meta = {
    version: 1,
    schemaVersion: schemaLib.CURRENT_SCHEMA_VERSION,
    id: `b_${Date.now().toString(36)}`,
    title: displayTitle,
    titleTemplate: chaptersLib.TITLE_TEMPLATE,
    fileSeq: seq,
    chapters: [{ id: 'ch_001', file, name: '', createdAt: nowIso() }],
    lastOpenChapterId: 'ch_001',
    createdAt: nowIso()
  };
  const saved = await writeBookMeta(bookPath, meta, { structural: true });
  return { path: bookPath, meta: saved };
}

async function openBook(bookPath) {
  const meta = await readBookMeta(bookPath);
  const [stats, missing] = await Promise.all([
    bookStats(bookPath, meta),
    findMissingChapters(bookPath, meta)
  ]);
  return { meta, missing, totalChars: stats.totalChars };
}

// 保存后的全书校验（代码审计 F2：渲染层把它挪到了后台）：只读，不写字数缓存。
// 缓存回填是书架扫描 / 打开书的事，校验只负责「有几章、共多少字、缺哪些文件」。
async function verifyBook(bookPath) {
  const meta = await readBookMeta(bookPath);
  const [missing, stats] = await Promise.all([
    findMissingChapters(bookPath, meta),
    bookStats(bookPath, meta, { writeCache: false })
  ]);
  return { chapterCount: meta.chapters.length, totalChars: stats.totalChars, missing };
}

async function loadChapterText(bookPath, file) {
  const p = assertChapterFile(bookPath, file);
  // C2（审计 #2 / P2）：先 stat 再读 —— 返回的 mtimeMs 必须是「正文被读出来之前」的那一版。
  // 预览快照拿它做执行阶段的复用校验；反过来（读完再 stat）若正文恰好在两次 IO 之间被改，
  // 会记下更新的 mtime，执行阶段就会把旧正文当新正文用。正常文件两种顺序的值相同，
  // 对外语义（text / mtimeMs / size）与读盘结果都不变。
  let stat;
  try {
    stat = await fs.stat(p);
  } catch (err) {
    if (err.code === 'ENOENT') throw new StorageError('CHAPTER_MISSING', `章节文件不存在：${file}`);
    throw err;
  }
  // 1.6.0 H6（审计 E-05）：与还原 / 快照同一条大小口径 —— 超过 128 MB 的章节文件在 stat 之后、
  // 读盘之前就拒绝，绝不整份读进内存（外部换入超大文件 / 坏掉的同步盘不能再顶爆主进程）。
  const tooLarge = readSizeProblem(stat.size, {
    code: 'CHAPTER_TOO_LARGE',
    label: `章节文件「${file}」`,
    tail: '没有读进内存'
  });
  if (tooLarge) throw new StorageError(tooLarge.code, tooLarge.message);
  let raw;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new StorageError('CHAPTER_MISSING', `章节文件不存在：${file}`);
    throw err;
  }
  return {
    text: chaptersLib.normalizeNewlines(stripBom(raw)),
    mtimeMs: stat.mtimeMs,
    size: stat.size
  };
}

async function statChapter(bookPath, file) {
  const p = assertChapterFile(bookPath, file);
  const stat = await fs.stat(p);
  // 1.6.0 H6（审计 E-05）：只 stat 的调用方（外部改动检测 / 保存前校验）也拿到同一条上限，
  // 免得「只看大小」的路径与「读正文」的路径对同一个文件给出两种结论。
  const tooLarge = readSizeProblem(stat.size, {
    code: 'CHAPTER_TOO_LARGE',
    label: `章节文件「${file}」`,
    tail: '没有读进内存'
  });
  if (tooLarge) throw new StorageError(tooLarge.code, tooLarge.message);
  return { mtimeMs: stat.mtimeMs, size: stat.size };
}

async function saveChapterText(bookPath, file, text, { ensureDir: ensureDirectory = true } = {}) {
  const p = assertChapterFile(bookPath, file);
  await atomicWriteFile(p, chaptersLib.toDiskNewlines(text), 'utf8', { ensureDir: ensureDirectory });
  const stat = await fs.stat(p);
  return { mtimeMs: stat.mtimeMs, chars: chaptersLib.countChars(text) };
}

// ---------- 多窗口：打开中的书登记 / 跨窗口检查 / 保存前校验 ----------
// 唯一事实来源：窗口 → 书的登记表（只存在内存里，不写配置、不写书库）。
// 登记 / 释放在主进程里通过 storage 统一做；写盘前的保存校验也在这里，
// 确保书文件夹或章节文件被另一个窗口（或应用外）删掉后，绝不会 mkdir 重建影子文件。
const openBookRegistry = openBooksLib.createRegistry();

function registerOpenBook(windowId, bookPath) {
  return openBookRegistry.setBook(windowId, bookPath);
}

function releaseOpenBook(windowId) {
  return openBookRegistry.clearBook(windowId);
}

function releaseOpenBookPath(bookPath) {
  return openBookRegistry.clearPath(bookPath);
}

function findOpenBookWindow(bookPath) {
  return openBookRegistry.findWindow(bookPath);
}

// 跨窗口删改拦截：抛出 CROSS_WINDOW_BUSY，由 IPC 统一转成界面提示。
function assertBookNotBusy(bookPath, windowId, action = 'write') {
  const result = openBooksLib.checkMutation({ registry: openBookRegistry, windowId, bookPath, action });
  if (!result.ok) throw new StorageError(result.code, result.message);
  return true;
}

// 保存前校验：书文件夹在 → 书目能读 → 章节还在书目里 → 章节文件也在。
// 任一失效都抛错阻止写盘（saveChapterText 会带 ensureDir:false，atomic 不会重建目录）。
async function prepareChapterSave(bookPath, chapterId, { windowId = null, file = null } = {}) {
  assertBookNotBusy(bookPath, windowId, 'save');
  let bookStat = null;
  try {
    bookStat = await fs.stat(bookPath);
  } catch {
    bookStat = null;
  }
  const bookExists = Boolean(bookStat && bookStat.isDirectory());
  let meta = null;
  let metaCode = null;
  if (bookExists) {
    try {
      meta = await readBookMeta(bookPath);
    } catch (err) {
      metaCode = (err && err.code) || 'ERROR';
    }
  }
  const chapter =
    meta && Array.isArray(meta.chapters)
      ? meta.chapters.find((item) => item && item.id === chapterId)
      : null;
  let chapterExists = false;
  if (chapter) {
    try {
      const stat = await fs.stat(assertChapterFile(bookPath, chapter.file));
      chapterExists = stat.isFile();
    } catch {
      chapterExists = false;
    }
  }
  const checked = openBooksLib.verifySaveTarget({
    bookPath,
    bookExists,
    meta,
    metaCode,
    chapterId,
    file: file || (chapter ? chapter.file : null),
    chapterExists
  });
  if (!checked.ok) throw new StorageError(checked.code, checked.message);
  return { meta, chapter: checked.chapter, index: checked.index };
}

// 新建章节并一次性写入正文（剪贴板捕获用）：先把正文写进新章节文件，再写书目；
// 书目写失败就删掉刚建的文件，书目里绝不会留下「有记录、没正文」的空章。
async function createChapterWithText(bookPath, { insertIndex = 0, name = '', text = '', volumeId = null } = {}) {
  const meta = await readBookMeta(bookPath);
  const seq = chaptersLib.nextFileSeq(meta);
  const existing = await listTxtFiles(bookPath);
  const file = chaptersLib.uniqueFileName(seq, name, existing);
  const body = String(text == null ? '' : text);
  const wantedVolume = chaptersLib.sanitizeVolumes(meta.volumes).some((v) => v.id === volumeId) ? volumeId : null;
  const chapter = {
    id: `ch_${Date.now().toString(36)}_${seq}`,
    file,
    name: String(name == null ? '' : name).trim(),
    volumeId: wantedVolume,
    createdAt: nowIso()
  };
  if (body) chapter.chars = chaptersLib.countChars(body);
  await atomicWriteFile(path.join(bookPath, file), chaptersLib.toDiskNewlines(body));
  try {
    // 指定了卷：插到那一卷的末尾（不按调用方传的下标，避免新章跑到别的卷中间）
    const at = wantedVolume ? chaptersLib.insertIndexForVolume(meta, wantedVolume) : insertIndex;
    const updated = chaptersLib.insertChapter({ ...meta, fileSeq: seq }, at, chapter);
    const saved = await writeBookMeta(bookPath, chaptersLib.normalizeChapterOrder(updated), { structural: true });
    return {
      meta: saved,
      chapter,
      index: saved.chapters.findIndex((c) => c.id === chapter.id),
      chars: chapter.chars || 0
    };
  } catch (err) {
    try { await fs.unlink(path.join(bookPath, file)); } catch { /* 忽略 */ }
    throw err;
  }
}

async function createChapter(bookPath, insertIndex, name, volumeId = null) {
  return createChapterWithText(bookPath, { insertIndex, name, text: '', volumeId });
}

// ---------- 分卷操作（同一本书的写操作都要持锁，走 locked()） ----------
async function createVolume(bookPath, name) {
  const meta = await readBookMeta(bookPath);
  const volume = { id: chaptersLib.nextVolumeId(meta), name: String(name == null ? '' : name).trim() };
  const updated = chaptersLib.normalizeChapterOrder({ ...meta, volumes: [...meta.volumes, volume] });
  const saved = await writeBookMeta(bookPath, updated, { structural: true });
  return { meta: saved, volume };
}

async function renameVolume(bookPath, volumeId, name) {
  const meta = await readBookMeta(bookPath);
  const volumes = meta.volumes.map((v) =>
    v.id === volumeId ? { ...v, name: String(name == null ? '' : name).trim() } : v
  );
  if (!volumes.some((v) => v.id === volumeId)) {
    throw new StorageError('VOLUME_NOT_FOUND', '卷不存在（可能已被删除）');
  }
  const saved = await writeBookMeta(bookPath, { ...meta, volumes }, { structural: true });
  return { meta: saved };
}

// 删卷不删章：卷里的章节回到「未分卷」，章节文件一个都不动
async function deleteVolume(bookPath, volumeId) {
  const meta = await readBookMeta(bookPath);
  if (!meta.volumes.some((v) => v.id === volumeId)) {
    throw new StorageError('VOLUME_NOT_FOUND', '卷不存在（可能已被删除）');
  }
  const updated = chaptersLib.normalizeChapterOrder({
    ...meta,
    volumes: meta.volumes.filter((v) => v.id !== volumeId)
  });
  const saved = await writeBookMeta(bookPath, updated, { structural: true });
  return { meta: saved, movedChapters: saved.chapters.filter((c) => !c.volumeId).length };
}

// 把一章移到某卷（volumeId 传 null = 移回「未分卷」）；移完按卷重新归一顺序
async function moveChapterToVolume(bookPath, chapterId, volumeId = null) {
  const meta = await readBookMeta(bookPath);
  const index = chapterIndexOrThrow(meta, chapterId);
  const wanted = chaptersLib.sanitizeVolumes(meta.volumes).some((v) => v.id === volumeId) ? volumeId : null;
  const chapters = meta.chapters.map((c) => (c.id === chapterId ? { ...c, volumeId: wanted } : c));
  const saved = await writeBookMeta(bookPath, chaptersLib.normalizeChapterOrder({ ...meta, chapters }), { structural: true });
  return { meta: saved, index: saved.chapters.findIndex((c) => c.id === chapterId) };
}

// 拖拽用：把一章放到「某卷的某个位置」——volumeId 为目标卷（null = 未分卷），
// beforeChapterId 为插到哪一章之前（null = 该卷末尾）。可以跨卷。
async function moveChapterTo(bookPath, chapterId, volumeId = null, beforeChapterId = null) {
  const meta = await readBookMeta(bookPath);
  const index = chapterIndexOrThrow(meta, chapterId);
  const wanted = chaptersLib.sanitizeVolumes(meta.volumes).some((v) => v.id === volumeId) ? volumeId : null;
  const chapter = { ...meta.chapters[index], volumeId: wanted };
  const rest = meta.chapters.filter((c) => c.id !== chapterId);
  const restMeta = { ...meta, chapters: rest };
  let at;
  if (beforeChapterId) {
    const beforeIndex = rest.findIndex((c) => c.id === beforeChapterId);
    at = beforeIndex >= 0 ? beforeIndex : chaptersLib.insertIndexForVolume(restMeta, wanted);
  } else {
    at = chaptersLib.insertIndexForVolume(restMeta, wanted);
  }
  const chapters = rest.slice();
  chapters.splice(Math.max(0, Math.min(at, chapters.length)), 0, chapter);
  const saved = await writeBookMeta(bookPath, chaptersLib.normalizeChapterOrder({ ...meta, chapters }), { structural: true });
  return { meta: saved, index: saved.chapters.findIndex((c) => c.id === chapterId) };
}

// 调整卷的先后顺序（章节跟着卷走，组内顺序不变；章节文件不动）
async function moveVolume(bookPath, volumeId, toIndex) {
  const meta = await readBookMeta(bookPath);
  const result = chaptersLib.moveVolume(meta, volumeId, toIndex);
  if (!result.moved) return { meta, moved: false, from: result.from, to: result.to };
  const saved = await writeBookMeta(bookPath, result.meta, { structural: true });
  return { meta: saved, moved: true, from: result.from, to: result.to };
}

async function renameChapter(bookPath, chapterId, name) {
  const meta = await readBookMeta(bookPath);
  const index = chapterIndexOrThrow(meta, chapterId);
  const updated = chaptersLib.updateChapter(meta, chapterId, { name: String(name == null ? '' : name).trim() });
  const saved = await writeBookMeta(bookPath, updated, { structural: true });
  return { meta: saved, chapter: saved.chapters[index] };
}

// 章节状态 / 备注：只改书目里的可选字段，章节 txt 一个字节都不动。
// patch 只认 status（draft/revising/done）和 note（≤200 字；空字符串 = 删除备注）；
// 返回 changed=false 时不写盘（避免无意义的 .bak 轮换）。
async function updateChapterMeta(bookPath, chapterId, patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new StorageError('BAD_PATCH', '章节信息必须是一个对象');
  }
  const meta = await readBookMeta(bookPath);
  const index = chapterIndexOrThrow(meta, chapterId);
  if (Object.prototype.hasOwnProperty.call(patch, 'status') && !chaptersLib.isChapterStatus(patch.status)) {
    throw new StorageError('BAD_STATUS', '章节状态只能是 draft / revising / done');
  }
  const changes = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'status')) changes.status = patch.status;
  if (Object.prototype.hasOwnProperty.call(patch, 'note')) changes.note = patch.note;
  if (!Object.keys(changes).length) {
    return { meta, chapter: meta.chapters[index], index, changed: false };
  }
  const current = meta.chapters[index];
  const nextChapter = chaptersLib.applyChapterMeta(current, changes);
  const changed = current.status !== nextChapter.status || (current.note || '') !== (nextChapter.note || '');
  if (!changed) {
    return { meta, chapter: current, index, changed: false };
  }
  const chapters = meta.chapters.map((c) => (c.id === chapterId ? nextChapter : c));
  const saved = await writeBookMeta(bookPath, { ...meta, chapters }, { structural: true });
  return { meta: saved, chapter: saved.chapters[index], index, changed: true };
}

// 书籍信息（v0.8-3）：只改 书目.json 里的可选 author / brief / group / tags，
// 书文件夹名、章节文件名、章节 txt 一个字节都不动。
// patch 只认这四个键；空字符串 / 空数组 = 清掉该字段；没有实际变化不写盘（不做无意义的 .bak 轮换）。
async function updateBookInfo(bookPath, patch = {}) {
  const fields = bookInfoLib.bookInfoPatchFields(patch);
  if (!fields) {
    throw new StorageError('BAD_BOOK_INFO', '书籍信息字段不合法（只支持作者 / 简介 / 分组 / 标签）');
  }
  const meta = await readBookMeta(bookPath);
  const before = bookInfoLib.readBookInfo(meta);
  const next = { ...before, ...fields };
  if (bookInfoLib.sameBookInfo(before, next)) {
    return { meta, info: before, changed: false };
  }
  const saved = await writeBookMeta(bookPath, bookInfoLib.cleanBookInfo({ ...meta, ...fields }), { structural: true });
  return { meta: saved, info: bookInfoLib.readBookInfo(saved), changed: true };
}

// 章号编号方式（2026-11-10）：全书连续（默认，删字段）/ 按卷独立（chapterNumbering: 'volume'）。
// 只写 书目.json 的可选字段；不动章节顺序、文件名、正文。连续 = 删除字段，旧书 / 改回连续都不留痕。
async function setChapterNumbering(bookPath, numbering) {
  const mode = chaptersLib.sanitizeChapterNumbering(numbering);
  const meta = await readBookMeta(bookPath);
  const before = meta.chapterNumbering === 'volume' ? 'volume' : 'continuous';
  if (before === mode) return { meta, numbering: mode, changed: false };
  if (mode === 'volume') meta.chapterNumbering = 'volume';
  else delete meta.chapterNumbering;
  // 1.5.0 P0-2：这里就地改了编号方式，卷内章号表的缓存键必须一起失效
  chaptersLib.invalidateChapterNumberCache(meta);
  const saved = await writeBookMeta(bookPath, meta, { structural: true });
  return { meta: saved, numbering: mode, changed: true };
}

function timestampForFile(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

async function moveToTrash(bookPath, file) {
  const trashDir = path.join(bookPath, TRASH_DIR);
  await ensureDir(trashDir);
  const stamp = timestampForFile();
  let destName = `${stamp}-${file}`;
  let i = 2;
  while (await exists(path.join(trashDir, destName))) {
    destName = `${stamp}-${i}-${file}`;
    i += 1;
  }
  const dest = path.join(trashDir, destName);
  await fs.rename(path.join(bookPath, file), dest);
  return dest;
}

async function deleteChapter(bookPath, chapterId) {
  const meta = await readBookMeta(bookPath);
  const index = chapterIndexOrThrow(meta, chapterId);
  const target = meta.chapters[index];
  let trashPath = null;
  try {
    trashPath = await moveToTrash(bookPath, target.file);
  } catch (err) {
    throw new StorageError('TRASH_FAILED', `无法把章节移到回收目录：${errorText.describeForUi(err).message}`);
  }
  let updated = chaptersLib.removeChapter(meta, chapterId);
  let newChapter = null;
  if (updated.chapters.length === 0) {
    const seq = chaptersLib.nextFileSeq(updated);
    const file = chaptersLib.uniqueFileName(seq, '', await listTxtFiles(bookPath));
    await atomicWriteFile(path.join(bookPath, file), '');
    newChapter = {
      id: `ch_${Date.now().toString(36)}_${seq}`,
      file,
      name: '',
      createdAt: nowIso()
    };
    updated = { ...updated, fileSeq: seq, chapters: [newChapter] };
  }
  const saved = await writeBookMeta(bookPath, updated, { structural: true }).catch(async (err) => {
    // 书目没写成功 = 这次删除没有发生。把刚移走的章节文件放回原处（「不留半成品」）：
    // 不然书目里还有这一章、书文件夹里却没有它，点开就是缺章，作者只能去修书。
    // 「删到空自动补一章」时刚建的那张空章也要先挪走，否则它会占着与原章节同名的位置。
    if (newChapter) {
      try {
        await fs.rename(
          path.join(bookPath, newChapter.file),
          path.join(path.dirname(trashPath), `${timestampForFile()}-${newChapter.file}`)
        );
      } catch { /* 挪不走就算了：它是本书目写完才会登记的空章，不会覆盖正文 */ }
    }
    let rolledBack = false;
    try {
      await fs.rename(trashPath, path.join(bookPath, target.file));
      rolledBack = true;
    } catch { /* 放不回去就按下面的「文件在 _trash」报错 */ }
    throw batchFailure(err, {
      code: 'DELETE_FAILED',
      action: '删除本章',
      notes: rolledBack
        ? [`「${target.file}」已经放回原处`, '书还是删除前的样子']
        : [
            `「${target.file}」现在在 ${trashDirLabel(path.dirname(trashPath))} 里`,
            '可以用本书历史的「删除章节」那条把它放回书文件夹'
          ]
    });
  });
  return {
    meta: saved,
    trashPath,
    newChapter,
    index: Math.min(index, saved.chapters.length - 1)
  };
}

// 撤销「删除章节」（1.4.0 P0-2：删除直接执行 + 10 秒内撤销）。
// 把 _trash 里那一个 txt 放回书文件夹，并按原位置插回 书目.json 的 chapters。
// 只收「本书 _trash 下的文件名」，绝不接收绝对路径；函数自己再做四道校验：
//   1) trashName / chapter.file 都是纯 basename + .txt；解析后父目录正好是本书 _trash / 书文件夹；
//   2) chapter.id 不与现有章节撞车、chapter.file 不在书文件夹里已存在（绝不覆盖）；
//   3) trashName 必须是 moveToTrash 的命名（<时间戳>-<可选序号>-<原文件名>），
//      防止拿别的备份 / 别的章的文件冒充这一次删除；
//   4) 删空自动补的空章：只有它仍在书目里、磁盘内容确实为空、且调用方明确要求替换时才挪走。
//      —— 作者在这 10 秒里已经往补章里写了字，宁可多一章，也不静默丢字。
// 返回 { meta, index, chapter, autoChapterRemoved }；失败抛 StorageError，界面据此提示。
async function restoreDeletedChapterFromTrash(bookPath, payload) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const rawChapter =
    input.chapter && typeof input.chapter === 'object' && !Array.isArray(input.chapter) ? input.chapter : null;
  if (!rawChapter) throw new StorageError('RESTORE_BAD_INPUT', '撤销删除缺少章节信息');
  const id = typeof rawChapter.id === 'string' ? rawChapter.id.trim() : '';
  if (!id) throw new StorageError('RESTORE_BAD_INPUT', '撤销删除缺少章节 id');
  const file = String(rawChapter.file || '').trim();
  // assertChapterFile：basename / .txt / 系统保留名 / 逃逸出书目录，一律挡住
  assertChapterFile(bookPath, file);

  const trashDir = path.join(bookPath, TRASH_DIR);
  const trashName = typeof input.trashName === 'string' ? input.trashName.trim() : '';
  if (
    !trashName ||
    path.basename(trashName) !== trashName ||
    !/\.txt$/i.test(trashName) ||
    trashName.includes('..') ||
    trashName.includes('/') ||
    trashName.includes('\\')
  ) {
    throw new StorageError('RESTORE_BAD_TRASH', '撤销删除只能从本书 _trash 里放回单章 txt');
  }
  // moveToTrash 的命名 = `<时间戳>-[序号-]<原文件名>`：必须真的指向这一章的文件名
  if (!trashName.endsWith(`-${file}`)) {
    throw new StorageError('RESTORE_BAD_TRASH', '撤销删除的备份文件与章节文件名对不上');
  }
  const source = path.resolve(trashDir, trashName);
  if (path.dirname(source).toLowerCase() !== path.resolve(trashDir).toLowerCase()) {
    throw new StorageError('RESTORE_BAD_TRASH', '撤销删除的备份文件不在本书 _trash 下');
  }

  const meta = await readBookMeta(bookPath);
  if (meta.chapters.some((chapter) => chapter && chapter.id === id)) {
    throw new StorageError('RESTORE_DUPLICATE', '书里已经有这一章，没有重复放回');
  }
  if (meta.chapters.some((chapter) => chapter && chapter.file === file)) {
    throw new StorageError('RESTORE_DUPLICATE', '书里已经有同名章节文件，没有覆盖');
  }
  if (!(await exists(source))) {
    throw new StorageError('RESTORE_MISSING', '这个备份已经不在 _trash 里了');
  }
  const target = assertChapterFile(bookPath, file);
  if (await exists(target)) {
    throw new StorageError('RESTORE_TARGET_EXISTS', `书文件夹里已经有 ${file}，没有覆盖`);
  }

  // 删空自动补的那张空章：仍然在书目里 + 磁盘内容为空，才允许一并撤掉。
  let autoChapter = null;
  const autoFile = typeof input.autoChapterFile === 'string' ? input.autoChapterFile.trim() : '';
  if (autoFile) {
    autoChapter = meta.chapters.find((chapter) => chapter && chapter.file === autoFile) || null;
    if (autoChapter) {
      try {
        const text = await fs.readFile(assertChapterFile(bookPath, autoFile), 'utf8');
        if (stripBom(text).trim() !== '') autoChapter = null;
      } catch {
        autoChapter = null;
      }
    }
  }

  await fs.rename(source, target);
  let autoTrashPath = null;
  try {
    if (autoChapter) {
      autoTrashPath = await moveToTrash(bookPath, autoChapter.file);
    }
    // 1.5.0 P0-3（审计 E3）：章名是 书目.json 里唯一会原样透传的自由文本（status / note 由
    // cleanChapterMeta 清洗，createdAt / volumeId 是短标识）。撤销的 name 来自渲染层，写回前按建章同一套
    // 规则过一遍 chaptersLib.safeName：非法字符 / 控制字符去掉、超长夹到 40 字、Windows 保留名加安全后缀。
    // 空名（含只有空白）保持空串 —— 「空名 = 未命名」是显示口径，不能凭空给作者改出一个新章名。
    const rawName = typeof rawChapter.name === 'string' ? rawChapter.name : '';
    const restored = chaptersLib.cleanChapterMeta({
      id,
      file,
      name: rawName.trim() ? chaptersLib.safeName(rawName) : '',
      createdAt:
        typeof rawChapter.createdAt === 'string' && rawChapter.createdAt ? rawChapter.createdAt : nowIso(),
      status: rawChapter.status,
      note: rawChapter.note
    });
    if (
      rawChapter.volumeId &&
      Array.isArray(meta.volumes) &&
      meta.volumes.some((volume) => volume && volume.id === rawChapter.volumeId)
    ) {
      restored.volumeId = rawChapter.volumeId;
    }
    const list = autoChapter
      ? meta.chapters.filter((chapter) => !(chapter && chapter.file === autoChapter.file))
      : meta.chapters;
    const rawIndex = Number(input.index);
    const index = Number.isFinite(rawIndex) ? Math.max(0, Math.min(Math.floor(rawIndex), list.length)) : list.length;
    const updated = chaptersLib.insertChapter({ ...meta, chapters: list }, index, restored);
    const saved = await writeBookMeta(bookPath, updated, { structural: true });
    return { meta: saved, index, chapter: restored, autoChapterRemoved: Boolean(autoChapter) };
  } catch (err) {
    // 书目没写成功 = 这次撤销没有发生：刚放回的章节重新移回 _trash，补章也放回原处。
    // 放不回去时在错误里说清文件现在在哪（绝不静默）。
    const notes = [];
    try {
      await fs.rename(target, source);
    } catch {
      notes.push(`「${file}」现在在书文件夹里，_trash 里那一份也还在`);
    }
    if (autoTrashPath) {
      try {
        await fs.rename(autoTrashPath, path.join(bookPath, autoChapter.file));
      } catch {
        notes.push(`自动补的「${autoChapter.file}」在 ${trashDirLabel(trashDir)} 里`);
      }
    }
    throw batchFailure(err, { code: 'RESTORE_FAILED', action: '撤销删除', notes });
  }
}

// 拖拽排序：只改 书目.json 里的数组顺序，章节文件永不重命名（显示章号按数组顺序现算）
async function moveChapter(bookPath, chapterId, toIndex) {
  const meta = await readBookMeta(bookPath);
  const from = chapterIndexOrThrow(meta, chapterId);
  const total = meta.chapters.length;
  const to = Math.max(0, Math.min(Math.round(Number(toIndex) || 0), total - 1));
  if (from === to) return { meta, moved: false, from, to };
  const list = meta.chapters.slice();
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  const saved = await writeBookMeta(bookPath, { ...meta, chapters: list }, { structural: true });
  return { meta: saved, moved: true, from, to };
}

// C2（审计 #2 / P2）：整本操作的「正文读取上下文」。
// 预览（整本查找 / 整理预检查）走 record：每读一章顺手把正文 + mtime / size 记进快照；
// 执行（整本替换 / 整本整理）走 reuse：快照里有这一章、且文件的 mtime / size 与预览时一致，
// 就直接用预览读到的正文（只多一次 stat），否则照旧读盘。
// 上下文按书路径登记，只影响下面这个 loadTextOrSkip（整本操作的唯一读取点）：
// chapter:load / 导出 / 搜索索引 / 校对都走别的读取路径，完全不受影响。
// 同一本书的写操作由 bookQueue 串行（replaceInBook / formatBook 都过 locked）；两本书各用各的键，
// 并发互不串。预览 / 执行之间作者改过某一章 → mtime 或 size 变了 → 该章回退读盘。
const chapterReadContexts = new Map();

async function withChapterReadContext(bookPath, context, task) {
  const key = previewCacheLib.bookKey(bookPath);
  chapterReadContexts.set(key, context);
  try {
    return await task();
  } finally {
    // 只清掉「还是自己」的那一份：并发交错时不要误删别人的上下文（删了只是少一次加速，不丢正确性）
    if (chapterReadContexts.get(key) === context) chapterReadContexts.delete(key);
  }
}

// 预览阶段：一边读一边记快照。预览失败就把半份快照丢掉，不在内存里留没用的正文。
async function withPreviewSnapshot(bookPath, task) {
  const snapshot = chapterPreviewCache.begin(bookPath);
  try {
    return await withChapterReadContext(bookPath, { snapshot, record: true }, task);
  } catch (err) {
    chapterPreviewCache.drop(snapshot);
    throw err;
  }
}

// 执行阶段：有快照就试着复用（命中判定在 loadTextOrSkip 里按 mtime + size 做），用完立即释放。
// 没有快照（没预览直接执行 / 过期 / 容量淘汰）→ 原样读盘，行为与 C1 之前完全一致。
async function withReusedSnapshot(bookPath, task) {
  const snapshot = chapterPreviewCache.take(bookPath);
  if (!snapshot) return task();
  try {
    return await withChapterReadContext(bookPath, { snapshot, record: false }, task);
  } finally {
    chapterPreviewCache.drop(snapshot);
  }
}

// 上下文里的读：返回 loaded / null（缺文件）；返回 undefined = 「没结论，走普通读盘」。
async function loadChapterThroughContext(bookPath, chapter, context) {
  if (context.record) {
    const loaded = await loadChapterText(bookPath, chapter.file);
    context.snapshot.remember(chapter.file, loaded);
    return loaded;
  }
  const entry = context.snapshot.lookup(chapter.file);
  if (!entry) return undefined;
  let stat;
  try {
    stat = await statChapter(bookPath, chapter.file);
  } catch (err) {
    // 预览之后这一章被删 / 被移走：按缺章跳过，与读盘路径的 CHAPTER_MISSING 同口径
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) return undefined;
  return { text: entry.text, mtimeMs: stat.mtimeMs, size: stat.size };
}

async function loadTextOrSkip(bookPath, chapter) {
  try {
    const context = chapterReadContexts.get(previewCacheLib.bookKey(bookPath));
    if (context) {
      const fromContext = await loadChapterThroughContext(bookPath, chapter, context);
      if (fromContext !== undefined) return fromContext;
    }
    return await loadChapterText(bookPath, chapter.file);
  } catch (err) {
    if (err.code === 'CHAPTER_MISSING') return null; // 缺文件的章节直接跳过，别让查找整个失败
    throw err;
  }
}

// C1（审计 #1 / P1）：按批读整本正文 —— 每批 ≤ CHAPTER_BATCH_SIZE 章，批内仍然限并发
// （CHAPTER_READ_CONCURRENCY），读出来交给 onBatch(texts, startIndex) 处理；批与批严格串行，
// 所以处理顺序 / 结果与「一次读完整个数组再处理」逐字一致，只是不再把全书正文同时常驻。
// 缺文件的章仍返回 null（loadTextOrSkip 语义不变）。读取抛错照旧整本失败；
// 对整本替换 / 整理来说，此时**前面的批次可能已经写盘**——与「写入中途失败」同一套
// batchFailure 口径（错误里如实报「已经改了几章 + 备份目录」）。
async function forEachChapterBatch(bookPath, chapters, onBatch) {
  for (let start = 0; start < chapters.length; start += CHAPTER_BATCH_SIZE) {
    const batch = chapters.slice(start, start + CHAPTER_BATCH_SIZE);
    const texts = await mapLimit(batch, CHAPTER_READ_CONCURRENCY, (chapter) =>
      loadTextOrSkip(bookPath, chapter)
    );
    await onBatch(texts, start);
  }
}

// 全书查找：逐章读正文，返回命中章节 + 前几处上下文（只读，不写盘）
async function searchBook(bookPath, options = {}) {
  const query = String(options.query == null ? '' : options.query);
  if (!query.trim()) throw new StorageError('EMPTY_QUERY', '查找内容不能为空');
  const caseSensitive = Boolean(options.caseSensitive);
  const meta = await readBookMeta(bookPath);
  const results = [];
  let totalMatches = 0;
  // C1（审计 #1 / P1）：按批读正文（批内并行、批间串行），本批处理完即释放，不再整本常驻
  // C2（审计 #2 / P2）：预览阶段顺手把读到的正文记进快照，紧接着的执行（整本替换）直接复用
  await withPreviewSnapshot(bookPath, () =>
    forEachChapterBatch(bookPath, meta.chapters, (loadedTexts, start) => {
      for (let offset = 0; offset < loadedTexts.length; offset += 1) {
        const chapter = meta.chapters[start + offset];
        const loaded = loadedTexts[offset];
        if (!loaded) continue;
        const matches = findLib.findMatches(loaded.text, query, { caseSensitive });
        if (!matches.length) continue;
        totalMatches += matches.length;
        results.push({
          chapterId: chapter.id,
          file: chapter.file,
          name: chapter.name,
          count: matches.length,
          matches: matches.slice(0, 12).map((match) => ({
            index: match.index,
            length: match.length,
            ...findLib.makeSnippet(loaded.text, match.index, match.length)
          }))
        });
      }
    })
  );
  return { query, caseSensitive, totalMatches, chapterCount: results.length, results };
}

// 全书替换：逐章字面量替换并写盘；写之前把原文件备份到书内 _trash/替换备份-时间戳/。
// 这是作者显式点「全部替换」才发生的动作，和「打字不自动保存」不冲突。
async function replaceInBook(bookPath, options = {}) {
  const query = String(options.query == null ? '' : options.query);
  const replacement = String(options.replacement == null ? '' : options.replacement);
  const caseSensitive = Boolean(options.caseSensitive);
  if (!query.trim()) throw new StorageError('EMPTY_QUERY', '查找内容不能为空');
  const meta = await readBookMeta(bookPath);
  // 备份目录名带时间戳（精确到秒），同一秒内连做两次整本替换会撞名：老实现直接复用同名目录，
  // 第二次的「替换前原文」会盖掉第一次的，还原时就变成「两次替换的混合状态」——那在书里从未存在过。
  // 所以和「整理备份 / 还原前备份」一样走 uniqueTrashDir，撞名自动加 -2、-3（没撞名时名字和以前完全一样）。
  let backupDir = null;
  let chaptersChanged = 0;
  let occurrences = 0;
  let backupCreated = false;
  try {
    // C1（审计 #1 / P1）：按批读正文（批内并行、批间串行）；写盘仍然逐章串行、按书目顺序，
    // 中途失败时 batchFailure 报告「已经替换几章」的语义与以前完全一致。
    // C2（审计 #2 / P2）：紧挨着的整本查找预览已经把正文读进快照 → 文件没变的章直接复用，
    // 替换算法（replaceAllLiteral）仍在执行阶段按最新正文重算，结果与「再读一遍」逐字一致。
    await withReusedSnapshot(bookPath, () =>
      forEachChapterBatch(bookPath, meta.chapters, async (loadedTexts, start) => {
        for (let offset = 0; offset < loadedTexts.length; offset += 1) {
          const chapter = meta.chapters[start + offset];
          const loaded = loadedTexts[offset];
          if (!loaded) continue;
          const res = findLib.replaceAllLiteral(loaded.text, query, replacement, { caseSensitive });
          if (!res.count) continue;
          if (!backupCreated) {
            backupDir = await uniqueTrashDir(path.join(bookPath, TRASH_DIR), REPLACE_BACKUP_PREFIX);
            await ensureDir(backupDir);
            backupCreated = true;
          }
          await fs.copyFile(assertChapterFile(bookPath, chapter.file), path.join(backupDir, chapter.file));
          await saveChapterText(bookPath, chapter.file, res.text);
          chapter.chars = chaptersLib.countChars(res.text);
          chaptersChanged += 1;
          occurrences += res.count;
        }
      })
    );
    if (chaptersChanged) await writeBookMeta(bookPath, meta);
  } catch (err) {
    // 中途失败（磁盘满 / 杀软占住 / 某个章节文件只读）：已经替换掉的章不能"当没发生过"，
    // 报错要说清改了几章、原件备份在哪里，作者才有办法自己退回去（见 batchFailure）。
    throw batchFailure(err, {
      code: 'REPLACE_FAILED',
      action: '整本替换',
      notes: [
        chaptersChanged ? `已经替换 ${chaptersChanged} 章` : '',
        trashDirLabel(backupDir) ? `替换前的原文都在 ${trashDirLabel(backupDir)}` : '',
        chaptersChanged ? '可以先从那里把原文拷回来，再重试' : '书里的正文一个字节都没改'
      ]
    });
  }
  return {
    chaptersChanged,
    occurrences,
    backupDir: backupCreated ? backupDir : null
  };
}

// ---------- 整本智能排版（「一键整理本书」） ----------
const FORMAT_STATS_KEYS = [
  'paragraphs',
  'indentFixed',
  'trailingTrimmed',
  'blankCollapsed',
  'punctFixed',
  'cjkSpacesRemoved',
  'quotesFixed',
  'ellipsisFixed'
];

function emptyFormatStats() {
  const stats = {};
  for (const key of FORMAT_STATS_KEYS) stats[key] = 0;
  return stats;
}

function addFormatStats(target, stats) {
  for (const key of FORMAT_STATS_KEYS) target[key] += Number(stats && stats[key]) || 0;
  return target;
}

// 预检查：只读不写。返回会改动的章节数、前几章名字和合计统计，供确认框显示。
async function previewFormatBook(bookPath, options = {}) {
  const meta = await readBookMeta(bookPath);
  const stats = emptyFormatStats();
  const changed = [];
  // C1（审计 #1 / P1）：预览也是按批读（只读不写），结果仍按书目顺序汇总
  // C2（审计 #2 / P2）：预检查读到的正文连同 mtime / size 记进快照，执行（整本整理）直接复用
  await withPreviewSnapshot(bookPath, () =>
    forEachChapterBatch(bookPath, meta.chapters, (loadedTexts, start) => {
      for (let offset = 0; offset < loadedTexts.length; offset += 1) {
        const index = start + offset;
        const chapter = meta.chapters[index];
        const loaded = loadedTexts[offset];
        if (!loaded) continue;
        const res = formatLib.formatText(loaded.text, options);
        if (!res.changed) continue;
        addFormatStats(stats, res.stats);
        changed.push({ index, file: chapter.file, name: chapter.name || '' });
      }
    })
  );
  return {
    bookTitle: meta.title,
    chapterCount: meta.chapters.length,
    chaptersChanged: changed.length,
    changed: changed.slice(0, 12),
    changedTruncated: changed.length > 12,
    stats
  };
}

// 整本智能排版：逐章格式化后写盘；写盘前把要改动的原章节备份到书内 _trash/整理备份-时间戳/。
// 作者显式点「一键整理本书…」才会执行，规则沿用「整理本章」记住的那套。
async function formatBook(bookPath, options = {}, onProgress) {
  const meta = await readBookMeta(bookPath);
  const total = meta.chapters.length;
  const stats = emptyFormatStats();
  const changed = [];
  let backupDir = null;
  let backupCreated = false;
  try {
    // C1（审计 #1 / P1）：按批读正文（批内并行、批间串行）；写盘仍然逐章串行、按书目顺序。
    // 进度回调仍在写盘阶段按章上报，done 从 1 连续走到 total（语义不变，只是跟着批次前进）。
    // C2（审计 #2 / P2）：紧挨着的预检查已经把正文读进快照 → 文件没变的章直接复用，
    // formatText 仍在执行阶段按最新正文重算，结果 / 统计 / 备份与「再读一遍」逐字一致。
    await withReusedSnapshot(bookPath, () =>
      forEachChapterBatch(bookPath, meta.chapters, async (loadedTexts, start) => {
        for (let offset = 0; offset < loadedTexts.length; offset += 1) {
          const index = start + offset;
          const chapter = meta.chapters[index];
          if (typeof onProgress === 'function') {
            try {
              onProgress({ done: index + 1, total, index, name: chapter.name || '' });
            } catch { /* 进度回调出错不影响整理 */ }
          }
          const loaded = loadedTexts[offset];
          if (!loaded) continue;
          const res = formatLib.formatText(loaded.text, options);
          if (!res.changed) continue;
          if (!backupCreated) {
            backupDir = await uniqueTrashDir(path.join(bookPath, TRASH_DIR), FORMAT_BACKUP_PREFIX);
            await ensureDir(backupDir);
            backupCreated = true;
          }
          // 先备份原文再写盘：整理也是「改正文」的显式动作，必须留退路
          await fs.copyFile(assertChapterFile(bookPath, chapter.file), path.join(backupDir, chapter.file));
          await saveChapterText(bookPath, chapter.file, res.text);
          chapter.chars = chaptersLib.countChars(res.text);
          addFormatStats(stats, res.stats);
          changed.push({ index, file: chapter.file, name: chapter.name || '' });
        }
      })
    );
    if (changed.length) await writeBookMeta(bookPath, meta);
  } catch (err) {
    // 半途失败：已经整理好的章节是真写进去了（每章原子写、改前有备份），
    // 必须把「改了几章 + 原件在哪」告诉作者，别让界面只剩一句「失败」（见 batchFailure）。
    throw batchFailure(err, {
      code: 'FORMAT_FAILED',
      action: '整本整理',
      notes: [
        changed.length ? `已经整理好 ${changed.length} 章` : '',
        trashDirLabel(backupDir) ? `整理前的原文都在 ${trashDirLabel(backupDir)}` : '',
        changed.length ? '可以先从那里把原文拷回来，再重试' : '书里的正文一个字节都没改'
      ]
    });
  }
  return {
    bookTitle: meta.title,
    chapterCount: total,
    chaptersChanged: changed.length,
    backupDir,
    changed: changed.slice(0, 12),
    stats
  };
}

// 在 _trash 下生成一个不重名的备份目录（同名就加 -2、-3…）
async function uniqueTrashDir(trashDir, prefix) {
  const stamp = timestampForFile();
  let name = `${prefix}${stamp}`;
  let i = 2;
  while (await exists(path.join(trashDir, name))) {
    name = `${prefix}${stamp}-${i}`;
    i += 1;
  }
  return path.join(trashDir, name);
}

// 列出书内 _trash 下的「整本替换」备份（最近的在最前），供「还原到替换前」使用。
async function listReplaceBackups(bookPath) {
  const trashDir = path.join(bookPath, TRASH_DIR);
  let entries;
  try {
    entries = await fs.readdir(trashDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const backups = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(REPLACE_BACKUP_PREFIX)) continue;
    const dir = path.join(trashDir, entry.name);
    let files;
    try {
      files = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 目录刚好被删/被占用，跳过
    }
    const names = [];
    let totalBytes = 0;
    let mtimeMs = 0;
    for (const file of files) {
      if (!file.isFile() || !/\.txt$/i.test(file.name)) continue;
      try {
        const stat = await fs.stat(path.join(dir, file.name));
        totalBytes += stat.size;
        mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
        names.push(file.name);
      } catch { /* 单个文件读不到就跳过 */ }
    }
    if (!names.length) continue;
    backups.push({
      name: entry.name,
      fileCount: names.length,
      totalBytes,
      mtimeMs: Math.round(mtimeMs),
      files: names
    });
  }
  // 目录名里带时间戳，倒序 = 最近一次替换在最前
  backups.sort((a, b) => b.name.localeCompare(a.name, 'zh-Hans-CN'));
  return backups;
}

// 还原一次「整本替换」：把备份目录里的章节文件覆盖回书内。
// 安全措施：只还原书目里当前存在的章节文件（已删章节不偷偷复活）；
// 还原前先把书里「现在的内容」备份到 _trash/还原前备份-时间戳/，还原本身点错了也还有退路。
async function restoreReplaceBackup(bookPath, backupName) {
  const meta = await readBookMeta(bookPath);
  const rawName = String(backupName == null ? '' : backupName).trim();
  const name = path.basename(rawName);
  if (!name || name !== rawName || !name.startsWith(REPLACE_BACKUP_PREFIX)) {
    throw new StorageError('BAD_BACKUP', '替换备份目录名不合法');
  }
  const trashDir = path.join(bookPath, TRASH_DIR);
  const backupDir = path.join(trashDir, name);
  if (!(await exists(backupDir))) {
    throw new StorageError('BACKUP_MISSING', '这个替换备份已经不存在了');
  }

  let entries;
  try {
    entries = await fs.readdir(backupDir, { withFileTypes: true });
  } catch (err) {
    throw new StorageError('BACKUP_UNREADABLE', `替换备份读不出来：${errorText.describeForUi(err).message}`);
  }
  const currentFiles = new Set(meta.chapters.map((chapter) => chapter.file));
  const fileEntries = entries.filter((entry) => entry.isFile());
  if (!fileEntries.length) throw new StorageError('BACKUP_EMPTY', '这个替换备份里没有文件');
  const restorable = fileEntries.filter((entry) => currentFiles.has(entry.name));
  if (!restorable.length) {
    throw new StorageError('BACKUP_NO_TARGET', '备份里的章节都不在书里了，没有可还原的内容');
  }

  // P2-3：先按 stat.size 把整批要还原的备份文件看一遍。任何一个超限就整批拒绝 ——
  // 此时一个字节都还没写（还原前备份目录也不建），不是「还原到一半停下」。
  await preflightRestoreSources(
    restorable.map((entry) => ({
      source: path.join(backupDir, entry.name),
      label: `替换备份里的「${entry.name}」`
    })),
    { code: 'BACKUP_TOO_LARGE', tail: '没有覆盖书里的正文' }
  );

  const restoreDir = await uniqueTrashDir(trashDir, RESTORE_BACKUP_PREFIX);
  let restored = 0;
  let skipped = 0;
  let safetyCopied = false;
  try {
    for (const entry of fileEntries) {
      if (!currentFiles.has(entry.name)) {
        skipped += 1; // 章节可能已经删掉了，别偷偷复活
        continue;
      }
      const target = assertInside(bookPath, entry.name);
      if (await backupCurrentToRestoreDir(bookPath, entry.name, restoreDir)) safetyCopied = true;
      // P2-3：预检之后还能再变（TOCTOU），所以读盘这一步也走带大小闸门的入口
      const buffer = await loadChapterSource(path.join(backupDir, entry.name), {
        code: 'BACKUP_TOO_LARGE',
        label: `替换备份里的「${entry.name}」`,
        tail: '没有覆盖书里的正文'
      });
      await atomicWriteFile(target, buffer);
      restored += 1;
    }

    // 正文被覆盖了，字数缓存要重算（复用历史还原的 refreshChapterChars）；
    // 书目改动走 writeBookMeta（B2 之后：普通保存不轮换 .bak，这里只刷新字数缓存）
    if (restored) {
      await refreshChapterChars(bookPath, meta, meta.chapters.map((chapter) => chapter.file));
      await writeBookMeta(bookPath, meta);
    }
  } catch (err) {
    // 还原到一半失败：说清还原了几章、还原前的正文备份在哪。替换备份本身不会被消耗，
    // 作者再点一次「还原」就能把剩下的补上（幂等）。
    throw batchFailure(err, {
      code: 'RESTORE_FAILED',
      action: '还原到替换前',
      notes: [
        restored ? `已经还原 ${restored} 章` : '',
        safetyCopied ? `还原前的正文备份在 ${trashDirLabel(restoreDir)}` : '',
        restored ? '再点一次「还原」可以把剩下的章节补上' : '书里的正文一个字节都没改'
      ]
    });
  }

  return {
    restored,
    skipped,
    total: fileEntries.length,
    restoreBackupDir: restored ? restoreDir : null
  };
}

// ---------- 可选「每日快照」 ----------
// 只在作者按 Ctrl+S、且设置里打开时发生；每章每天最多一份（当天第一次保存前的内容）。
// 目录固定在书内 _trash/快照-YYYYMMDD/，写盘仍走 atomicWriteFile；
// 清理只认严格合法的「快照-YYYYMMDD」目录，别的备份 / 文件 / 乱写目录一律不碰。

// 删除超出保留天数的快照目录（只删本应用生成的快照目录）。
async function cleanupSnapshots(bookPath, { keepDays = snapshotLib.DEFAULT_KEEP_DAYS, now = new Date() } = {}) {
  const trashDir = path.join(bookPath, TRASH_DIR);
  let entries;
  try {
    entries = await fs.readdir(trashDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { removed: [], failed: [], kept: 0 };
    throw err;
  }
  // 只看目录；符号链接 / 联接点不动（避免把书库外面删掉）
  const dirNames = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name);
  const expired = new Set(snapshotLib.selectExpiredSnapshotDirs(dirNames, now, keepDays));
  if (!expired.size) return { removed: [], failed: [], kept: dirNames.length };
  const removed = [];
  const failed = [];
  for (const name of dirNames) {
    if (!expired.has(name)) continue;
    const target = path.join(trashDir, name);
    // 双保险：名字必须是 basename，且实际父目录就是书的 _trash
    if (path.basename(name) !== name || path.dirname(target) !== trashDir) continue;
    try {
      await fs.rm(target, { recursive: true, force: true });
      removed.push(name);
    } catch {
      failed.push(name); // 被占用 / 权限问题：下次保存再试，不影响这次保存
    }
  }
  return { removed, failed, kept: dirNames.length - removed.length };
}

// 保存前留一份当天快照。返回 { taken, reason, dir, file, bytes, cleanup }：
// - TAKEN：这一次真的复制了；ALREADY_TODAY：今天已经有这一章的快照，不重复复制；
// - MISSING：章节文件还不存在（不建空快照）；DISABLED 由调用方（main.js）处理。
// - 正文文件超过单文件读取上限（>128 MB）抛 SNAPSHOT_TOO_LARGE：不读进内存、不建快照，
//   由 main.js 记日志并带回保存结果（快照失败照旧绝不阻塞保存）。
// 复制了（TAKEN）或当天已有一份（ALREADY_TODAY）时，都会顺手清理过期快照目录；
// 章节文件还不存在（MISSING）时直接返回、不清理（此时没有新快照要维护）。
// 只有开启该功能（config.snapshotEnabled）时才会被调用。
async function takeDailySnapshot(bookPath, file, { keepDays, now = new Date() } = {}) {
  const raw = String(file == null ? '' : file).trim();
  if (!raw || path.basename(raw) !== raw || !/\.txt$/i.test(raw)) {
    throw new StorageError('BAD_SNAPSHOT_FILE', '只能给章节 txt 做快照');
  }
  const source = assertInside(bookPath, raw);
  let buffer;
  try {
    // P2-3：先看大小再读 —— 这一章被外部换成超大文件时，不能把主进程内存打爆
    await assertSourceSize(source, {
      code: 'SNAPSHOT_TOO_LARGE',
      label: `这一章正文（${raw}）`,
      tail: '这次没有留快照（保存继续）'
    });
    buffer = await fs.readFile(source);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { taken: false, reason: 'MISSING', dir: null, file: raw, bytes: 0, cleanup: { removed: [], failed: [], kept: 0 } };
    }
    throw err;
  }
  const dir = snapshotLib.snapshotDirName(now);
  if (!dir) throw new StorageError('BAD_SNAPSHOT_TIME', '快照时间不合法');
  const trashDir = path.join(bookPath, TRASH_DIR);
  const snapshotDir = path.join(trashDir, dir);
  const target = path.join(snapshotDir, raw);
  let taken = false;
  if (!(await exists(target))) {
    await ensureDir(snapshotDir);
    await atomicWriteFile(target, buffer); // 原样复制字节（CRLF / BOM 都不动）
    taken = true;
  }
  const cleanup = await cleanupSnapshots(bookPath, { keepDays, now });
  return {
    taken,
    reason: taken ? 'TAKEN' : 'ALREADY_TODAY',
    dir,
    file: raw,
    bytes: buffer.length,
    cleanup
  };
}

// ---------- 「本书历史」：统一查看 / 还原 _trash 备份 ----------
// 备份来源：替换备份-* / 整理备份-* / 还原前备份-* / 快照-* / 删章散文件 / 书目.json.bak。
// 还原规则（安全优先）：
// - 目录备份只还原「现在仍在书目里」的章节，已删章节不会偷偷复活；
// - 删章备份还原成书文件夹里的孤立 txt，不自动改章节列表/章号；
// - 书目.json.bak 只供查看，不提供覆盖还原（损坏走「修复」流程）；
// - 每次还原前把书里现在的内容复制到 _trash/还原前备份-时间戳/，绝不静默覆盖。
async function findHistoryGroup(bookPath, groupId, chapterFiles) {
  // 先做 id / 路径校验：非法 id（目录穿越等）直接拒绝，不去扫描
  historyLib.resolveGroup(bookPath, groupId);
  const data = await historyLib.listHistory(bookPath, { chapterFiles });
  const group = data.groups.find((item) => item.id === groupId);
  if (!group) throw new StorageError('HISTORY_GROUP_MISSING', '这个备份已经不存在了');
  return group;
}

async function refreshChapterChars(bookPath, meta, files) {
  const touched = new Set(files);
  const targets = meta.chapters.filter((chapter) => touched.has(chapter.file));
  if (!targets.length) return;
  // B4（审计 P4）：还原后刷字数也是整本批量读，并行读、按原顺序写回缓存
  const charCounts = await mapLimit(targets, CHAPTER_READ_CONCURRENCY, async (chapter) => {
    try {
      const text = await fs.readFile(assertChapterFile(bookPath, chapter.file), 'utf8');
      return chaptersLib.countChars(stripBom(text));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  });
  for (let i = 0; i < targets.length; i += 1) {
    if (charCounts[i] != null) targets[i].chars = charCounts[i];
  }
}

async function restoreDeletedChapter(bookPath, group, entry) {
  if (!entry || !/\.txt$/i.test(entry.name)) {
    throw new StorageError('HISTORY_NOT_CHAPTER', '这个备份不是章节 txt，不能放回书里');
  }
  const target = assertInside(bookPath, entry.name);
  if (await exists(target)) {
    throw new StorageError('HISTORY_TARGET_EXISTS', `书文件夹里已经有 ${entry.name}，没有覆盖`);
  }
  const source = historyLib.resolveHistoryPath(bookPath, group.id, entry.name);
  const buffer = await fs.readFile(source);
  await atomicWriteFile(target, buffer);
  return {
    restored: 1,
    skipped: 0,
    total: group.fileCount,
    restoreBackupDir: null,
    file: entry.name,
    addedToBook: false,
    needsRebuild: true,
    sourceLabel: group.sourceLabel
  };
}

// 还原历史备份前的共同检查：读当前书目 → 找到备份组 → 挡住「书目备份」和只能查看的备份。
async function loadRestorableHistoryGroup(bookPath, groupId) {
  const meta = await readBookMeta(bookPath);
  const chapterFiles = meta.chapters.map((chapter) => chapter.file);
  const group = await findHistoryGroup(bookPath, groupId, chapterFiles);
  if (group.source === 'bookmeta') {
    throw new StorageError('HISTORY_NOT_RESTORABLE', '书目备份只供查看，不能直接覆盖现在的书目');
  }
  if (group.kind === 'file') {
    if (group.source !== 'delete') {
      throw new StorageError('HISTORY_NOT_RESTORABLE', '这种备份只供查看，不能还原');
    }
  } else if (!group.restorableCount) {
    throw new StorageError('HISTORY_NO_TARGET', '备份里的章节都不在书里了，没有可还原的内容');
  }
  return { meta, group };
}

// 还原前的反向备份：书里现在有这份文件，就复制进本次还原的 _trash/还原前备份-时间戳/。
// 返回是否真的备份了（失败提示里据此写「还原前的正文备份在 …」）。三处还原共用：
// 整本替换备份还原、历史单文件还原、历史整组还原。
async function backupCurrentToRestoreDir(bookPath, fileName, restoreDir) {
  const target = assertInside(bookPath, fileName);
  if (!(await exists(target))) return false;
  await ensureDir(restoreDir);
  await fs.copyFile(target, path.join(restoreDir, fileName));
  return true;
}

// 把备份组里的一份文件覆盖回书里：书里已有同名文件就先把「现在的内容」复制进本次还原的反向备份
// （_trash/还原前备份-时间戳/），再读备份、原子写回章节文件 —— 连「还原」这一步本身也能再退回去。
// 单文件还原与整组还原共用同一份；restoreDir 的创建时机保持原样（单文件还原先建好，
// 整组还原只在真要备份时才建，不留下空目录）。
async function copyHistoryEntryToBook(bookPath, group, entry, restoreDir) {
  await backupCurrentToRestoreDir(bookPath, entry.name, restoreDir);
  const target = assertInside(bookPath, entry.name);
  const source = historyLib.resolveHistoryPath(bookPath, group.id, entry.name);
  // P2-3：备份文件被外部换成超大文件时，先 stat 再读，绝不把整份读进内存
  const buffer = await loadChapterSource(source, {
    code: 'HISTORY_TOO_LARGE',
    label: `备份文件「${entry.name}」`,
    tail: '没有覆盖书里的正文'
  });
  await atomicWriteFile(target, buffer);
}

async function restoreHistoryFile(bookPath, groupId, fileName) {
  const { meta, group } = await loadRestorableHistoryGroup(bookPath, groupId);
  if (group.kind === 'file') {
    const entry =
      group.files.find((file) => file.name === fileName || file.trashName === fileName) || group.files[0];
    return restoreDeletedChapter(bookPath, group, entry);
  }
  const entry = group.files.find((file) => file.name === fileName);
  if (!entry) throw new StorageError('HISTORY_FILE_MISSING', '这个备份文件已经不存在了');
  if (!entry.restorable) {
    throw new StorageError('HISTORY_NOT_CURRENT', entry.reason || '这个文件不是当前章节，不能还原');
  }
  // P2-3：先验备份文件大小，超限时连「还原前备份」目录都不建（一个字节都不写）
  await preflightRestoreSources(
    [{ source: historyLib.resolveHistoryPath(bookPath, group.id, entry.name), label: `备份文件「${entry.name}」` }],
    { code: 'HISTORY_TOO_LARGE', tail: '没有覆盖书里的正文' }
  );
  const trashDir = path.join(bookPath, TRASH_DIR);
  const restoreDir = await uniqueTrashDir(trashDir, RESTORE_BACKUP_PREFIX);
  await ensureDir(restoreDir);
  await copyHistoryEntryToBook(bookPath, group, entry, restoreDir);
  await refreshChapterChars(bookPath, meta, [entry.name]);
  await writeBookMeta(bookPath, meta);
  return {
    restored: 1,
    skipped: group.fileCount - 1,
    total: group.fileCount,
    restoreBackupDir: restoreDir,
    file: entry.name,
    sourceLabel: group.sourceLabel
  };
}

async function restoreHistoryGroup(bookPath, groupId) {
  const { meta, group } = await loadRestorableHistoryGroup(bookPath, groupId);
  if (group.kind === 'file') return restoreDeletedChapter(bookPath, group, group.files[0]);
  // P2-3：整组还原前先验所有要还原的源文件大小；任一超限就整批拒绝、一个字节都不写
  await preflightRestoreSources(
    group.files
      .filter((file) => file.restorable)
      .map((file) => ({
        source: historyLib.resolveHistoryPath(bookPath, group.id, file.name),
        label: `备份文件「${file.name}」`
      })),
    { code: 'HISTORY_TOO_LARGE', tail: '没有覆盖书里的正文' }
  );
  const trashDir = path.join(bookPath, TRASH_DIR);
  const restoreDir = await uniqueTrashDir(trashDir, RESTORE_BACKUP_PREFIX);
  let restored = 0;
  let skipped = 0;
  for (const entry of group.files) {
    if (!entry.restorable) {
      skipped += 1;
      continue;
    }
    await copyHistoryEntryToBook(bookPath, group, entry, restoreDir);
    restored += 1;
  }
  if (restored) {
    await refreshChapterChars(
      bookPath,
      meta,
      group.files.filter((file) => file.restorable).map((file) => file.name)
    );
    await writeBookMeta(bookPath, meta);
  }
  return {
    restored,
    skipped,
    total: group.fileCount,
    restoreBackupDir: restored ? restoreDir : null,
    sourceLabel: group.sourceLabel
  };
}

// 统一的历史列表：书目损坏也允许看备份（修书时可能正需要）。
// 注意：只读扫描，不改任何文件；还原只发生在上面的显式调用里。
async function listBookHistory(bookPath) {
  let chapterFiles = [];
  let title = '';
  try {
    const meta = await readBookMeta(bookPath);
    chapterFiles = meta.chapters.map((chapter) => chapter.file);
    title = meta.title;
  } catch { /* 书目坏了就按「没有当前章节」扫描，预览照常 */ }
  const data = await historyLib.listHistory(bookPath, { chapterFiles });
  return { ...data, title };
}

async function previewHistoryFile(bookPath, groupId, fileName) {
  return historyLib.readHistoryFile(bookPath, groupId, fileName);
}

// 「清空这天的快照」的路径校验（P22-5）：渲染层只传目录名，绝不接受任意路径。
// - 只认 core/snapshot.js 的 parseSnapshotDirName：必须逐字是「快照-YYYYMMDD」且日期真实存在，
//   `快照-20260231` / `快照-2026-11-07` / `..` / 反斜杠 / 绝对路径 / 其它备份名一律 StorageError；
// - 只返回本书 _trash 下的绝对路径（再走一遍 assertInside），名字必须是 basename；
// - 这里不读正文、不删任何文件（移入回收站是 main.js 的 shell.trashItem 干的），
//   所以拿不到合法路径时调用方什么都不会动。
function snapshotDirForClear(bookPath, groupName) {
  const root = String(bookPath == null ? '' : bookPath).trim();
  if (!root) throw new StorageError('BAD_BOOK', '缺少书的路径');
  const info = snapshotLib.parseSnapshotDirName(groupName);
  if (!info) throw new StorageError('BAD_SNAPSHOT_DIR', '只能清空「快照-YYYYMMDD」这种每日快照目录');
  if (path.basename(info.name) !== info.name) {
    throw new StorageError('BAD_SNAPSHOT_DIR', '快照目录名不合法');
  }
  const dir = assertInside(root, path.join(TRASH_DIR, info.name));
  // 双保险：解析出来的绝对路径必须正好是本书 _trash 的直接子目录
  if (path.dirname(dir) !== path.resolve(root, TRASH_DIR)) {
    throw new StorageError('BAD_SNAPSHOT_DIR', '快照目录不在本书的 _trash 下');
  }
  return dir;
}

async function renameBook(bookPath, title) {
  const meta = await readBookMeta(bookPath);
  const nextTitle = String(title == null ? '' : title).trim() || meta.title;
  const saved = await writeBookMeta(bookPath, { ...meta, title: nextTitle }, { structural: true });
  return saved;
}

// 整本书的兜底删除：移动到书架根目录下的 _trash（回收站不可用时使用）
async function trashBook(booksRoot, bookPath) {
  const trashDir = path.join(booksRoot, TRASH_DIR);
  await ensureDir(trashDir);
  const folder = path.basename(bookPath);
  const dest = path.join(trashDir, `${timestampForFile()}-${folder}`);
  await fs.rename(bookPath, dest);
  return dest;
}

// 记住「上次打开的是哪一章」（书目里的唯一事实来源）。
// 返回 { ok, title, chapterId, chapterIndex, chapterName, changed } 给主进程同步书架级
// 「继续上次写作」；不存在的 chapterId 不写盘（防止书目被写成永远指不到章节的 id）。
async function setLastOpenChapter(bookPath, chapterId) {
  try {
    const meta = await readBookMeta(bookPath);
    const list = Array.isArray(meta.chapters) ? meta.chapters : [];
    const index = list.findIndex((chapter) => chapter && chapter.id === chapterId);
    if (index < 0) return { ok: false, code: 'CHAPTER_NOT_FOUND', chapterCount: list.length };
    const changed = meta.lastOpenChapterId !== chapterId;
    if (changed) await writeBookMeta(bookPath, { ...meta, lastOpenChapterId: chapterId });
    const chapter = list[index];
    return {
      ok: true,
      changed,
      title: String(meta.title == null ? '' : meta.title),
      chapterId: chapter.id,
      chapterIndex: index,
      chapterName: String(chapter.name == null ? '' : chapter.name)
    };
  } catch {
    return { ok: false };
  }
}

// ---------- 同一本书的「读-改-写」串行化 ----------
// 背景：渲染层会发 fire-and-forget 的 setLastOpenChapter，如果它和改名/插入等操作并发，
// 各自「读 meta → 改 → 写回」就会互相覆盖。主进程内用 promise 链把同一本书的写操作排队。
// A4（审计 #11 / O3、P6）：链本体收进 core/common.js 的 createKeyedWriteQueue（与 config /
// fragments / logs / stats 的 createWriteQueue 同一份语义），这里只剩「按书路径分链」这一步；
// 条目在链 settle 后自动回收，Map 不再只增不删。
const bookQueue = createKeyedWriteQueue();

function bookLockKey(bookPath) {
  // Windows 路径不分大小写，key 统一小写，免得 C:\Books\A 与 c:\books\a 变成两把锁
  return path.resolve(String(bookPath)).toLowerCase();
}

function withBookLock(bookPath, task) {
  return bookQueue.enqueue(bookLockKey(bookPath), task);
}

// 删书后的主动回收：只清这一本书的空闲条目；正在跑 / 正在排队的链绝不拆（settle 后自己回收）。
function clearBookLock(bookPath) {
  return bookQueue.clearIdle(bookLockKey(bookPath));
}

// 换书架根目录后的主动回收：旧根下的条目都没有复用价值了，清掉所有空闲条目；
// 在飞的条目同样留给它自己 settle 后回收。
function clearBookLocks() {
  return bookQueue.clearIdle();
}

// 单测观察用：当前 Map 里还有几条锁（产品逻辑不读它）。
function bookLockCount() {
  return bookQueue.pendingCount();
}

function locked(fn) {
  return (...args) => withBookLock(args[0], () => fn(...args));
}

const safeCreateBook = (booksRoot, title) => withBookLock(booksRoot, () => createBook(booksRoot, title));

module.exports = {
  BOOK_FILE,
  BOOK_BAK,
  TRASH_DIR,
  CORRUPT_PREFIX,
  StorageError,
  // P2-3：还原 / 快照读文件前的大小闸门（测试用稀疏文件验证超限路径）
  MAX_CHAPTER_READ_BYTES,
  readSizeProblem,
  nowIso,
  exists,
  assertInside,
  assertChapterFile,
  mergeCharsCache,
  // 1.6.0 A2：书架扫描回填字数缓存（8 路并发；readText 可注入给单测数并发峰值）。
  // 并发上限常量不进导出（sweep ⑤b 会判「白拿的导出面」），单测按峰值 8 钉住。
  backfillChapterChars,
  listTxtFiles,
  readBookMeta,
  writeBookMeta,
  listBooks,
  createBook: safeCreateBook,
  openBook,
  verifyBook,
  loadChapterText,
  statChapter,
  saveChapterText,
  prepareChapterSave,
  openBookRegistry,
  registerOpenBook,
  releaseOpenBook,
  releaseOpenBookPath,
  findOpenBookWindow,
  assertBookNotBusy,
  createChapter: locked(createChapter),
  createChapterWithText: locked(createChapterWithText),
  createVolume: locked(createVolume),
  renameVolume: locked(renameVolume),
  deleteVolume: locked(deleteVolume),
  moveChapterToVolume: locked(moveChapterToVolume),
  moveChapterTo: locked(moveChapterTo),
  moveVolume: locked(moveVolume),
  renameChapter: locked(renameChapter),
  updateChapterMeta: locked(updateChapterMeta),
  updateBookInfo: locked(updateBookInfo),
  setChapterNumbering: locked(setChapterNumbering),
  deleteChapter: locked(deleteChapter),
  restoreDeletedChapterFromTrash: locked(restoreDeletedChapterFromTrash),
  moveChapter: locked(moveChapter),
  searchBook,
  replaceInBook: locked(replaceInBook),
  previewFormatBook,
  formatBook: locked(formatBook),
  listReplaceBackups,
  restoreReplaceBackup: locked(restoreReplaceBackup),
  cleanupSnapshots,
  takeDailySnapshot,
  listBookHistory,
  previewHistoryFile,
  snapshotDirForClear,
  restoreHistoryFile: locked(restoreHistoryFile),
  restoreHistoryGroup: locked(restoreHistoryGroup),
  renameBook: locked(renameBook),
  trashBook,
  setLastOpenChapter: locked(setLastOpenChapter),
  moveToTrash,
  withBookLock,
  clearBookLock,
  clearBookLocks,
  bookLockCount
};
