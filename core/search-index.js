// 正文全文搜索索引（提案 7.3）
//
// 目标：书架搜索能搜到正文，同时 280 本 / 3256 章的架子也不能卡。
//
// 做法：每本书一份「正文双字（bigram）哈希 Bloom 位图」+ 每章的文件指纹（mtime / size），
// 索引单独存在 %APPDATA%\chapter-writer\search-index.json —— **绝不进书库、绝不改正文**。
//
// 为什么不是倒排索引：中文没有空格，按字建倒排会被「一章两万字、常用字几乎每章都有」
// 淹掉（筛不掉任何一本）；按词建倒排又得依赖词典。一本 25 万字的书，其不重复双字约
// 8 万个，Bloom 位图 8 bit/项 ≈ 80KB，280 本 ≈ 22MB。查询时先用位图筛掉 97% 以上的书，
// 再只读命中那几本的真实 txt 核对并截上下文 —— 位图只会误报（多读一两本），**不会漏报**
// （建图和查询用同一套归一化：小写 + CRLF 归一）。
//
// 一致性：每章存 mtime + size，搜索 / 回书架时校验。只有正文变过的书才重建位图，
// 改章名 / 调顺序只更新元数据；删书 / 删章 / 外部改 txt 都会被校验发现。
//
// E4（审计修复 #8）：只比 mtime / size 会漏掉「保留时间戳的同大小改写」（robocopy /COPY:DAT、
// rsync -t、部分同步盘后台落盘）：位图缺新内容的双字 → Bloom 把这本书滤掉 → 静默漏报。
// 每章指纹再加一条「首尾各 4 KB 内容哈希」（contentHash，含文件大小与两段采样），
// 深度校验时重算比对；正文没变就不重建位图。索引仍是派生数据，不含正文。
//
// E5（审计修复 #8）：位图解码强制 bits === 字节数 × 8（且落在 [MIN_BLOOM_BITS, MAX_BLOOM_BITS]），
// 每本书另存一条 CRC32。校验不过就当「没有位图」——这本书永远是候选、逐章核对（只降速不漏报），
// 并顺手登记脏书，让下一次校验重建位图自愈（旧索引没有这两项，靠 INDEX_VERSION 升版本一次性重建）。
// 索引坏了 / 版本不对 / 书架目录换了 → 当作没有索引自动重建，作者不用手动操作。
// 写盘走 core/atomic；索引读写失败只让本次搜索降级，绝不影响正文保存与界面。
const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteFile } = require('./atomic');
const { nowIso, mapLimit, normalizeForMatch } = require('./common');
// 路径归一只有一份实现（core/path-utils.js）：和 open-books 判「同一本书」用同一个口径
const { normalizePath } = require('./path-utils');
const storage = require('./storage');
const chaptersLib = require('./chapters');
// E4：每章内容指纹（字节数 + 首尾各 4 KB 哈希）只在 core/chapter-fingerprint.js 里实现一份。
// 审计修复 WP1（E-N2）：storage 的保存守卫也用同一份口径，两边不再各抄一套。
const { chapterContentHashOf } = require('./chapter-fingerprint');

const INDEX_FILE_NAME = 'search-index.json';
// E5（审计修复 #8）：索引形状升级为 2 = 每章多 contentHash、每书多 bloomCrc。
// 老版本索引按「版本不对 → 空索引自动重建」的既有口径一次性重建（派生数据，不碰正文）。
const INDEX_VERSION = 2;
// C17（v1.8.0 WP-19）：索引是「整份读进内存 → JSON.parse」的小文件，以前没有 stat 闸门 ——
// 被外部程序换成超大文件（误放的视频 / 坏同步盘）时先读后 parse，2 GB 直接顶爆主进程。
// 独立上限：每本书一份 Bloom 位图（25 万字的书约 100 KB）+ 每章指纹，280 本 ≈ 22 MB，
// 64 MB 够约 500 本以上的架子；超限记 INDEX_TOO_LARGE（与索引内容坏的 CORRUPT 区分），
// 按空索引重建 —— 重建会把超限文件覆盖成正常大小，不影响正文。
const MAX_INDEX_READ_BYTES = 64 * 1024 * 1024;
// 审计修复 #33（▲V307）：索引是单文件，读侧 64 MB 只管「外部换来的大文件别顶爆进程」，
// 写侧还要有总量预算 —— 200 本 × 数 MB 位图 = 数百 MB 的单文件，每次 flush 整份重写（写放大 =
// 文件大小），启动首载还要整份 parse。32 MB 仍远高于真实书架（280 本 × 25 万字 ≈ 22 MB）：
// 正常书架一本都不会被淘汰；超限时按「书目最后修改时间从旧到新」丢掉整本书的位图（章节指纹保留），
// 被丢的书以后永远当候选、逐章核对 —— 只降速、不漏结果。
// 只在写盘时压缩：下一次有书变脏 / 换书架根时新人选会被重新评估。
const MAX_INDEX_BYTES = 32 * 1024 * 1024;

// Bloom 参数：每项 8 bit、3 个哈希。一本书 8 万个双字 ≈ 80KB，单项误报率约 3%。
const BITS_PER_ITEM = 8;
const HASH_COUNT = 3;
const MIN_BLOOM_BITS = 1024;
const MAX_BLOOM_BITS = 64 * 1024 * 1024; // 单本 8MB 位图上限（异常输入兜底）
// E4（审计修复 #8）：章文件指纹的首 / 尾采样（4 KB × 2）与已知盲区（只改中段 + 保留 size/mtime
// 的改写发现不了）连同实现一起收进 core/chapter-fingerprint.js —— 那是唯一实现，storage 的保存守卫
// 也用它比对「编辑器载入那一版」，口径永远一致。

const MIN_QUERY_CHARS = 2; // 正文搜索至少两个字（单字几乎没有筛选意义）
const DEFAULT_RESULT_LIMIT = 40;
const MAX_RESULT_LIMIT = 60;
const MAX_SNIPPETS_PER_CHAPTER = 3;
// P22-4：每章先数清「本章一共几处命中」，再按旧口径只列前 3 条。
// 计数是单次 indexOf 循环（不逐字正则、不二次读盘），但这毕竟多扫了一遍正文，
// 所以给单章计数一个硬上限：超过上限只显示「N+」，绝不让异常的长文本拖住整次搜索。
const MAX_CHAPTER_MATCH_COUNT = 10000;
// 聚焦一章（opts.focus）时最多返回的片段数；超过就标 truncated（界面提示只列了前 N 处）。
// 这条路径不受整次 40 条限制，但仍受时间预算保护。
const MAX_FOCUS_SNIPPETS = 200;
// focus.bookPath / focus.chapterFile 的长度上限（与 main.js 的入口校验同一口径）。
// 真实书路径 / 章节文件名远小于这个值，超长一律当作无效聚焦，不读任何路径。
const MAX_FOCUS_FIELD_CHARS = 260;
// 审计修复 #46（E21）：章节文件名是索引的身份键，不许静默截断。
// sanitizeChapter 旧实现 `file.slice(0, 260)`：名字被切短后既匹配不到真实章节（这一章「静默不可搜」），
// 又每轮校验都被当成新章 / 缺章反复重建。真实章节名受文件系统 255 字符上限约束；这里只挡离谱长度
// （坏索引 / 手改 JSON），超限整条丢弃，由下一次构建按真实书目补回。
const MAX_CHAPTER_FILE_CHARS = 4096;
const SNIPPET_RADIUS = 16;
const MAX_CANDIDATE_BOOKS = 60; // 两字常用词可能命中一大半书：最多读这么多本
const SEARCH_TIME_BUDGET_MS = 1800; // 超过就带着已有结果返回（结果标 truncated）
// B11（v1.8.0 WP-29）：核对候选书时逐章读盘的预读并发度。以前整本串行 await loadChapterText，
// 机械盘 / 杀软环境下 1800ms 预算只够读几十章、truncated 常态化；按 4 章一批预读（顺序仍按
// 书目顺序逐章扫描，停止条件 / 计数 / 结果顺序都不变），把 IO 等待叠起来。
// 只给单测用 opts.readConcurrency 覆盖，生产不传（IPC 入口也只会透传既有字段）。
const CHAPTER_READ_CONCURRENCY = 4;
const MAX_CHAPTER_READ_CONCURRENCY = 8;
const FULL_VALIDATE_INTERVAL_MS = 10000; // 后台深度校验的节流（外部改 txt 最迟这么久后发现）
// 搜索自身不做逐章 stat（太慢），但距上次深度校验超过 1 分钟时会顺带做一次兜底校验，
// 保证「一直在书架搜、不回书架」也能发现外部改过的 txt。
const SEARCH_DEEP_INTERVAL_MS = 60000;
// A4 / P-01（审计：每敲一次键都 ensure → 每本书一次 书目.json stat，280 本 ≈ 280 次/次搜索）：
// 搜索侧改成「索引就绪 + 同一个书架根 + 版本一致」时直接复用内存索引，60 s 内不再校验；
// 更快的失效靠根目录签名（书架目录一次 stat，见下）发现新书 / 删书。
const SEARCH_ENSURE_INTERVAL_MS = 60000;
// 根目录签名探测的节流：书架目录 mtime 只认这一层（新书 / 删书会改它），
// 2 s 内连打多个键只探一次——这就是「连续两次 search 只 stat 一次」的来源。
const SEARCH_SIGNATURE_INTERVAL_MS = 2000;
const PROGRESS_INTERVAL_MS = 150;
// P2-1（作业卡 1.5.0）：整本建位图时按批读正文的批大小，对齐 core/storage.js 的 32 章批。
// 以前是「全书 texts 一次进数组」，1000 章 × 1 MB ≈ 1 GB 常驻主进程；现在一批处理完就丢引用。
// 分批只改「什么时候读」，不改章的顺序、字数统计口径与位图字节（tests/search-index.test.js 钉住）。
const BLOOM_BUILD_BATCH = 32;
// V93（1.7.2 D6）：解码后的位图缓存条数上界（LRU）。以前 bloomCache 只增不减、只在换书架根时清空：
// 长书架上「搜过一遍」就等于把整架书的位图全留在主进程里（位图按字数增长，几十 KB / 本）。
// 32 条足够覆盖一次搜索最多读的 60 本候选里的热区，冷书下次搜索重新解码，结果一条都不会少。
const BLOOM_CACHE_MAX = 32;
// P3（审计修复 #19）：条数上界不等于字节上界 —— 32 条 × 单本最大 8 MB 位图 ≈ 256 MB 常驻。
// 再加一道字节预算（只给单测用 options.bloomCacheMaxBytes 覆盖）：超预算时按 LRU 继续淘汰，
// 「最近用过的那一本」始终留着（否则每次搜索都要重解码一份超预算的大位图，白费 CPU）。
const BLOOM_CACHE_MAX_BYTES = 32 * 1024 * 1024;
// P3（审计修复 #19）：整本建图时「不重复双字」集合也有硬上限。以前只有最终位图受
// MAX_BLOOM_BITS 限制，中间 Set 随正文无限长大（千万字级巨书可达数百 MB）。
// 1M 个不重复双字 → 位图 8M bit ≈ 1 MB，已远超真实中文书（25 万字约 5–8 万）；超过就放弃这本的
// 位图（entry.bloomOmitted）：搜索永远把它当候选、逐章核对 —— 只降速不漏报。
const MAX_BLOOM_ITEMS = 1024 * 1024;

// nowIso / mapLimit 从 core/common.js 来（B6）：和 storage 导入时同一份实现
// （限并发、ISO 时间戳）；这里不再各抄一份。
// 路径归一（书架目录 / 书目录转小写）从 core/path-utils.js 来（C4）：和 open-books 同一份。

// V76（1.7.2 D6）/ X7 / V205（v1.8.0 WP-25）：个别字符小写后会「变长」（'İ' U+0130 → 'i' + U+0307，
// 两个码元）。拿小写化的结果当扫描用的干草堆时，长度一变 matchIndex 与片段位置就整体后移——列表里
// 高亮的不是命中的那几个字。长度防御与「小写化」现在只有 core/common.js 的 normalizeForMatch 一份
// （core/find.js 同一口径）；本模块不再保留本地 lowerText 副本。
//
// C20 勘误（复核意见 R1–R6）：建图 addText、查询 normalizeQuery、核对扫描三处都走 normalizeForMatch，
// 是**同一个函数、同一套「长度变化即回退」规则**，所以凡核对扫描能命中的串，其双字必在建图集合里，
// Bloom 只误报、不漏报。tests/match-normalize.test.js 用含 'İ' 的矩阵钉住这条不变量：
// 以后若把任何一处改成别的归一（哪怕只改一处），那条用例会先红。
function normalizeQuery(value) {
  return normalizeForMatch(value).trim();
}

// 双字（UTF-16 码元）32 位哈希：中文正文几乎都在 BMP，代理对按两个码元算也一致。
function bigramHash(c1, c2) {
  let h = Math.imul((c1 + 1) | 0, 0x9e3779b1) ^ Math.imul((c2 + 1) | 0, 0x85ebca77);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h >>> 0;
}

function addBigramsToSet(text, set, limit) {
  const source = String(text == null ? '' : text);
  const cap = typeof limit === 'number' && Number.isFinite(limit) ? limit : Infinity;
  for (let i = 0; i < source.length - 1; i += 1) {
    const hash = bigramHash(source.charCodeAt(i), source.charCodeAt(i + 1));
    // P3（审计修复 #19）：到上限就停下并如实告诉调用方「没装完」（集合不再长大）；
    // 已在集合里的重复双字不算超限，一次上限判定不会让位图少掉真实存在的项。
    if (set.size >= cap && !set.has(hash)) return false;
    set.add(hash);
  }
  return true;
}

// 查询串 → 不重复的双字哈希（查询本身也先归一化成小写）
function queryBigrams(query) {
  const set = new Set();
  addBigramsToSet(normalizeQuery(query), set);
  return Array.from(set);
}

// CRC32（IEEE 802.3，多项式 0xEDB88320）：每本书 Bloom 位图的校验和（E5 / 审计修复 #8）。
// 零依赖表驱动实现：core 层不引第三方包，zlib.crc32 在项目支持的各 Electron 版本上不保证有。
const CRC32_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value;
  }
  return table;
})();

function crc32(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return 0;
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

// E4：章文件内容指纹 = 字节数 + 首 4 KB 哈希 + 尾 4 KB 哈希。
// 实现与 storage 保存守卫共用 core/chapter-fingerprint.js（唯一一份，采样口径与盲区见该文件头）。

function bloomParams(itemCount) {
  const n = Math.max(0, Math.floor(Number(itemCount) || 0));
  const wanted = n * BITS_PER_ITEM;
  const bits = Math.min(MAX_BLOOM_BITS, Math.max(MIN_BLOOM_BITS, wanted));
  return { bits, hashes: HASH_COUNT };
}

function bloomIndexes(hash, bits, hashes = HASH_COUNT) {
  const size = Math.max(1, Math.floor(Number(bits) || 1));
  const out = new Array(Math.max(1, Math.floor(Number(hashes) || 1)));
  let x = hash >>> 0;
  for (let i = 0; i < out.length; i += 1) {
    out[i] = x % size;
    x = (x + 0x9e3779b9) >>> 0;
    x ^= x >>> 13;
    x = Math.imul(x, 0x85ebca6b) >>> 0;
  }
  return out;
}

function bloomAdd(bloom, bits, hash) {
  for (const index of bloomIndexes(hash, bits)) {
    bloom[index >> 3] |= 1 << (index & 7);
  }
  return bloom;
}

function bloomHas(bloom, bits, hash) {
  if (!Buffer.isBuffer(bloom)) return true; // 没有位图 = 当作候选（不能漏报）
  for (const index of bloomIndexes(hash, bits)) {
    if ((bloom[index >> 3] & (1 << (index & 7))) === 0) return false;
  }
  return true;
}

// P2-1（作业卡 1.5.0）：位图累积器。整本建索引时逐批把双字并进同一个 Set，
// 批与批之间只留 Set、不留正文数组（1000 章 × 1 MB 的书以前是约 1 GB 常驻）。
// 位图位数要等全书项数知道后才定，所以 Set 必须留到 finish()；
// 「有没有」的判定不受影响：插入顺序与逐章顺序一致，位图字节与旧实现完全相同。
// P3（审计修复 #19）：Set 有 MAX_BLOOM_ITEMS 硬上限 —— 超过就放弃位图（finish 回 omitted），
// 调用方把这本书标成「永远候选」，不再让中间集合随正文无限长大。
// options.maxItems 只给单测注入（验证「超限 → 放弃位图」分支，生产不传）。
function createBookBloom(options) {
  const source = options && typeof options === 'object' ? options : {};
  const cap = Number.isFinite(source.maxItems) && source.maxItems > 0 ? Math.floor(source.maxItems) : MAX_BLOOM_ITEMS;
  const set = new Set();
  let saturated = false;
  return {
    addText(text) {
      if (saturated) return set.size;
      saturated = !addBigramsToSet(normalizeForMatch(text), set, cap);
      return set.size;
    },
    finish() {
      if (saturated) return { bloom: null, bits: 0, items: 0, omitted: true };
      const params = bloomParams(set.size);
      const bloom = Buffer.alloc(Math.ceil(params.bits / 8));
      for (const hash of set) bloomAdd(bloom, params.bits, hash);
      return { bloom, bits: params.bits, items: set.size, omitted: false };
    }
  };
}

// 一本书的所有章节文本 → Bloom 位图。位图只回答「有没有」，不保存任何正文。
// 兼容入口（单测 / 旧调用用）：内部走同一个累积器，结果与逐批累积逐字节相同。
// options.maxItems 只给单测注入（见 createBookBloom）。
function makeBookBloom(texts, options) {
  const builder = createBookBloom(options);
  for (const text of texts) builder.addText(text);
  return builder.finish();
}

function encodeBloom(bloom) {
  return Buffer.isBuffer(bloom) ? bloom.toString('base64') : '';
}

// E5（审计修复 #8）：位图解码同时做三项硬校验，任何一项不过都回 null（= 本书当候选、逐章核对）：
//   ① bits 是 [MIN_BLOOM_BITS, MAX_BLOOM_BITS] 内的整数；
//   ② bits === 字节数 × 8 —— 旧实现只比 ceil(bits/8)，`bloomBits:0` + 1 字节能混过，
//      同长度位翻转也查不出；
//   ③ 每本书存一条 CRC32，与位图一起比对（指纹复用期位图被改坏也能当场发现）。
// 调用方在拿到 null 时还会登记脏书，让下一次校验重建位图自愈（见 bloomFor / createSearchStore）。
function decodeBloom(text, bits, crc) {
  if (typeof text !== 'string' || !text) return null;
  const bitCount = Number(bits);
  const expectedCrc = Number(crc);
  if (!Number.isFinite(bitCount) || !Number.isFinite(expectedCrc)) return null;
  try {
    const buffer = Buffer.from(text, 'base64');
    if (!buffer.length) return null;
    const wanted = Math.floor(bitCount);
    if (wanted !== bitCount || wanted < MIN_BLOOM_BITS || wanted > MAX_BLOOM_BITS) return null;
    if (wanted !== buffer.length * 8) return null;
    if (crc32(buffer) !== Math.floor(expectedCrc) >>> 0) return null;
    return buffer;
  } catch {
    return null;
  }
}

// P3（V5 搜索单遍）：一遍扫描同时产出「本章命中总数」与「前 maxSnippets 条命中位置」。
// 改前是 countChapterMatches 数一遍 + 片段循环再 indexOf 一遍（同一章正文扫两遍）；
// 这里合成单次 indexOf 循环，对外语义逐字不变：
// - 计数按 needle 步进、不重叠，命中位置就是同一串 indexOf 的前缀（与旧片段循环同序同位置）；
// - cap 是计数硬上限（到了就停，capped 表示「后面还有更多」）；onTick 返回 true 表示时间预算用完，
//   此时 count 只是部分命中，同样标 capped（界面显示「N+」，不冒充精确值）；
// - 时间预算检查点仍是「每数到 1024 的整数倍」查一次，与旧实现同一位置；
// - 旧片段循环在前 3 条命中处就已取完，远早于第一个 1024 检查点，所以合并不会丢掉任何片段。
function scanChapterMatches(haystack, needle, cap, maxSnippets, onTick) {
  const limit = Math.max(0, Math.floor(Number(cap) || 0));
  const snippetLimit = Math.max(0, Math.floor(Number(maxSnippets) || 0));
  const step = Math.max(1, String(needle == null ? '' : needle).length);
  const positions = [];
  let count = 0;
  let from = 0;
  let stopped = false;
  let capped = false;
  while (count < limit) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    count += 1;
    if (positions.length < snippetLimit) positions.push(at);
    from = at + step;
    if (onTick && (count & 1023) === 0 && onTick()) {
      stopped = true;
      break;
    }
  }
  if (stopped) capped = true;
  else if (count >= limit) capped = haystack.indexOf(needle, from) >= 0;
  return { count, capped, stopped, positions };
}

// 命中位置前后的上下文片段：换行 / 制表压成空格，两端裁掉多余空白。
// 返回 before / match / after 三段，渲染层用 <mark> 包住 match（不拼 HTML，防注入）。
function snippetAround(text, index, length, radius = SNIPPET_RADIUS) {
  const source = String(text == null ? '' : text);
  const at = Math.max(0, Math.min(Math.floor(Number(index) || 0), source.length));
  const len = Math.max(1, Math.min(Math.floor(Number(length) || 1), source.length - at));
  const beforeStart = Math.max(0, at - radius);
  const afterEnd = Math.min(source.length, at + len + radius);
  const clean = (value) =>
    String(value)
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\u0000/g, '')
      .replace(/\s+/g, ' ');
  let before = clean(source.slice(beforeStart, at));
  let match = clean(source.slice(at, at + len));
  let after = clean(source.slice(at + len, afterEnd));
  before = before.replace(/^\s+/, '').replace(/\s+$/, '');
  match = match.replace(/^\s+/, '').replace(/\s+$/, '');
  after = after.replace(/^\s+/, '').replace(/\s+$/, '');
  return {
    before,
    match,
    after,
    cutBefore: beforeStart > 0,
    cutAfter: afterEnd < source.length
  };
}

function emptyIndex(root = '') {
  return {
    version: INDEX_VERSION,
    root: normalizePath(root),
    builtAt: '',
    updatedAt: '',
    books: []
  };
}

function sanitizeChapter(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const file = typeof raw.file === 'string' ? raw.file : '';
  if (!file || file.includes('\u0000')) return null;
  // 审计修复 #46（E21）：超过「真实文件名上限」的只可能是坏索引，整条丢弃 —— 不再截断成
  // 一个永远匹配不到任何章节的假名字。
  if (file.length > MAX_CHAPTER_FILE_CHARS) return null;
  const mtimeMs = Number(raw.mtimeMs);
  const size = Number(raw.size);
  const index = Number(raw.index);
  return {
    id: typeof raw.id === 'string' ? raw.id.slice(0, 120) : '',
    name: typeof raw.name === 'string' ? raw.name.slice(0, 200) : '',
    file,
    index: Number.isFinite(index) ? Math.max(0, Math.round(index)) : 0,
    mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : 0,
    size: Number.isFinite(size) ? Math.max(0, size) : 0,
    // E4（审计修复 #8）：首尾内容指纹。老 / 缺字段的条目记空串 —— 下一次深度校验会当「变化」重建。
    contentHash: typeof raw.contentHash === 'string' ? raw.contentHash.slice(0, 80) : '',
    chars: Number.isFinite(Number(raw.chars)) ? Math.max(0, Math.round(Number(raw.chars))) : null
  };
}

function sanitizeBook(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const bookPath = typeof raw.path === 'string' ? raw.path : '';
  if (!bookPath || bookPath.includes('\u0000')) return null;
  const chapters = Array.isArray(raw.chapters)
    ? raw.chapters.map(sanitizeChapter).filter(Boolean)
    : [];
  // 审计修复 #33（▲V307）：总量预算淘汰过的书（bloomDropped）一律按「没有位图」读回，
  // 防止手改 / 坏索引里同时留着 bloom 与 bloomDropped 两个矛盾的字段。
  const bloomDropped = raw.bloomDropped === true;
  const bloom = bloomDropped ? '' : typeof raw.bloom === 'string' ? raw.bloom : '';
  const bloomBits = Number(raw.bloomBits);
  const bits = bloomDropped ? 0 : Number.isFinite(bloomBits) ? Math.max(0, Math.round(bloomBits)) : 0;
  // E5（审计修复 #8）：位图 CRC32；缺失记 -1（解码一定失败 → 当候选，不影响正确性）。
  const rawCrc = Number(raw.bloomCrc);
  const bloomCrc = bloomDropped ? 0 : Number.isFinite(rawCrc) ? Math.floor(rawCrc) >>> 0 : -1;
  const metaMtimeMs = Number(raw.metaMtimeMs);
  const lastModified = Number(raw.lastModified);
  return {
    path: bookPath,
    folder: typeof raw.folder === 'string' ? raw.folder.slice(0, 260) : '',
    id: typeof raw.id === 'string' ? raw.id.slice(0, 120) : '',
    title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : '',
    metaMtimeMs: Number.isFinite(metaMtimeMs) ? metaMtimeMs : 0,
    lastModified: Number.isFinite(lastModified) ? lastModified : 0,
    bloom: bloom.slice(0, MAX_BLOOM_BITS), // base64 字符数上限（异常输入兜底）
    bloomBits: bits,
    bloomCrc,
    itemCount:
      bloomDropped || !Number.isFinite(Number(raw.itemCount))
        ? 0
        : Math.max(0, Math.round(Number(raw.itemCount))),
    // P3（审计修复 #19）：这本书的双字集合超过 MAX_BLOOM_ITEMS，主动放弃位图（永远当候选）。
    // 老索引没有这个字段 → false，照旧按 bloom 字不空就走位图。
    bloomOmitted: raw.bloomOmitted === true,
    // 审计修复 #33（▲V307）：索引总量超预算时被丢掉位图（章节指纹保留，永远当候选、逐章核对）。
    bloomDropped,
    chapters
  };
}

// 索引文件解析 + 清洗：坏 JSON / 版本不对 / 字段缺失一律当作没有索引（自动重建）。
function sanitizeIndex(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (Number(raw.version) !== INDEX_VERSION) return null;
  const books = Array.isArray(raw.books) ? raw.books.map(sanitizeBook).filter(Boolean) : [];
  return {
    version: INDEX_VERSION,
    root: typeof raw.root === 'string' ? normalizePath(raw.root) : '',
    builtAt: typeof raw.builtAt === 'string' ? raw.builtAt.slice(0, 40) : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt.slice(0, 40) : '',
    books
  };
}

function parseIndex(text) {
  try {
    return sanitizeIndex(JSON.parse(String(text == null ? '' : text)));
  } catch {
    return null;
  }
}

function serializeIndex(index) {
  return JSON.stringify(index);
}

// 审计修复 #33（▲V307）：把整份索引压进总量预算。
// 淘汰顺序 = 书目最后修改时间（lastModified：书目 mtime 与全部章节 mtime 的最大值）从旧到新。
// 不用「搜索 LRU」：每次搜索都会把每本书的位图查一遍，按搜索次数算没有区分度；lastModified
// 才是「最近有没有在写这本书」的信号，也跨进程可比。
// 只清 bloom 字段（base64 位图就是体积大头），章节指纹 / 书名 / 章名全部保留：下次校验仍能
// 发现正文变化，正常增量更新不受影响；被清空的书 = 永远当候选、逐章核对（只降速不漏报）。
// 纯函数，不修改入参；返回 { index, dropped }，cap 非正数时视为不设预算。
function dropBookBloom(book) {
  return { ...book, bloom: '', bloomBits: 0, bloomCrc: 0, itemCount: 0, bloomDropped: true };
}

// 审计残留修复 #R17（#33-V307）：预算尽力而为 —— 所有书都没有可丢的位图（纯章节指纹），或丢完
// 所有位图仍超预算时，原样返回（dropped=0），调用方照常写出。不为了凑预算删章节指纹：指纹是
// 增量校验的依据，删掉就得每次启动全量重扫。读侧另有 MAX_INDEX_READ_BYTES（64 MB）闸门兜底，
// 超限按空索引重建 —— 所以「写出的索引 ≤ 32 MB」是正常书架的保证，不是任何输入下的硬上界。
function enforceIndexBudget(index, maxBytes) {
  const cap = Number(maxBytes);
  if (!Number.isFinite(cap) || cap <= 0) return { index, dropped: 0 };
  const books = Array.isArray(index.books) ? index.books : [];
  // 一次算准字节数：数组序列化 = 逐项 JSON.stringify 用逗号连接，正好等于拼接结果；
  // 用 Buffer.byteLength 按 UTF-8 计（书名 / 路径里的中文按实际写盘字节算）。
  const baseBytes = Buffer.byteLength(serializeIndex({ ...index, books: [] }));
  const sizes = books.map((book) => ({
    withBloom: Buffer.byteLength(JSON.stringify(book)),
    withoutBloom: book.bloom ? Buffer.byteLength(JSON.stringify(dropBookBloom(book))) : null
  }));
  let total = baseBytes + Math.max(0, books.length - 1);
  for (const size of sizes) total += size.withBloom;
  if (total <= cap) return { index, dropped: 0 };
  const victims = sizes
    .map((size, i) => ({ i, size, lastModified: Number.isFinite(books[i].lastModified) ? books[i].lastModified : 0 }))
    .filter((item) => item.size.withoutBloom !== null)
    .sort((a, b) => a.lastModified - b.lastModified || b.i - a.i);
  const next = books.slice();
  let dropped = 0;
  for (const victim of victims) {
    if (total <= cap) break;
    next[victim.i] = dropBookBloom(books[victim.i]);
    total -= victim.size.withBloom - victim.size.withoutBloom;
    dropped += 1;
  }
  // 审计残留修复 #R17（#33-V307）：没有可淘汰的位图 / 淘汰后仍超预算 → 原样返回，调用方照常
  // 写盘（尽力而为；不删章节指纹，见函数头口径）。
  if (!dropped) return { index, dropped: 0 };
  return { index: { ...index, books: next }, dropped };
}

function totalChapters(index) {
  return (index && Array.isArray(index.books) ? index.books : []).reduce(
    (sum, book) => sum + (Array.isArray(book.chapters) ? book.chapters.length : 0),
    0
  );
}

function sameChapter(a, b) {
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.file === b.file &&
    a.index === b.index &&
    a.mtimeMs === b.mtimeMs &&
    a.size === b.size &&
    a.contentHash === b.contentHash &&
    a.chars === b.chars
  );
}

function sameBook(a, b) {
  if (!a || !b) return false;
  if (
    a.path !== b.path ||
    a.folder !== b.folder ||
    a.id !== b.id ||
    a.title !== b.title ||
    a.metaMtimeMs !== b.metaMtimeMs ||
    a.lastModified !== b.lastModified ||
    a.bloom !== b.bloom ||
    a.bloomBits !== b.bloomBits ||
    a.bloomCrc !== b.bloomCrc ||
    a.itemCount !== b.itemCount ||
    a.bloomOmitted !== b.bloomOmitted ||
    // 审计修复 #33（▲V307）：被总量预算丢过位图的书也计入「变了」
    a.bloomDropped !== b.bloomDropped
  ) {
    return false;
  }
  const left = Array.isArray(a.chapters) ? a.chapters : [];
  const right = Array.isArray(b.chapters) ? b.chapters : [];
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (!sameChapter(left[i], right[i])) return false;
  }
  return true;
}

async function listBookFolders(booksRoot) {
  const entries = await fs.readdir(booksRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
    .map((entry) => ({ folder: entry.name, bookPath: path.join(booksRoot, entry.name) }))
    .sort((a, b) => a.folder.localeCompare(b.folder, 'zh-Hans-CN'));
}

// V107（v1.8.0 WP-21）：一本书的「最后修改时间」取书目 mtime 与全部章节行情的最大值。
// 以前写的是 `Math.max(metaMtimeMs, ...chapters.map(...), 0)` —— 把整个章节数组展开成函数实参，
// V8 的参数上限约 12.5 万个，10 万+ 章时会抛 RangeError；buildBookEntry 外层把异常吞成
// 「这本书不建索引」，书还在书架上却搜不到。读侧章节数上限（storage.MAX_META_CHAPTERS）落地后
// 正常书目到不了那个量级，但这里仍改成循环累加：不依赖实参个数，也不为了取最大值多分配一个数组。
function latestModifiedMs(metaMtimeMs, chapters) {
  let latest = Number.isFinite(metaMtimeMs) ? metaMtimeMs : 0;
  if (!Array.isArray(chapters)) return latest;
  for (const chapter of chapters) {
    const value = chapter && chapter.mtimeMs;
    if (Number.isFinite(value) && value > latest) latest = value;
  }
  return latest;
}

// 一本书的索引：读书目 + 逐章文件指纹；正文变过（或强制 / 脏标记）才重算位图。
// 返回 null 表示「没有可用书目」（损坏 / 没有 书目.json），这本书不参与搜索。
async function buildBookEntry(bookPath, folder, old, options, onProgress) {
  const force = Boolean(options.force);
  const dirty = Boolean(options.dirty);
  let meta;
  try {
    meta = await storage.readBookMeta(bookPath);
  } catch {
    return null;
  }
  let metaMtimeMs = 0;
  try {
    metaMtimeMs = (await fs.stat(path.join(bookPath, storage.BOOK_FILE))).mtimeMs;
  } catch {
    metaMtimeMs = 0;
  }
  const rawChapters = Array.isArray(meta.chapters) ? meta.chapters : [];
  const oldChapters = new Map(
    (old && Array.isArray(old.chapters) ? old.chapters : []).map((chapter) => [chapter.file, chapter])
  );
  // 章节文件指纹：并发 stat + 首尾各 4 KB 内容采样（E4：同 mtime / size 的改写也要能发现）。
  // 采样读不到时 contentHash 为空串：下次校验会当「变化」重算（宁可重建，不可漏报）。
  const stats = await mapLimit(rawChapters, 24, async (chapter) => {
    try {
      const filePath = storage.assertChapterFile(bookPath, chapter.file);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) return null;
      return {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        contentHash: await chapterContentHashOf(filePath, stat.size)
      };
    } catch {
      return null; // 缺文件的章节不参与搜索（书目里还在，历史面板能找回）
    }
  });

  const chapters = [];
  let textChanged = force || dirty;
  for (let i = 0; i < rawChapters.length; i += 1) {
    const chapter = rawChapters[i];
    const stat = stats[i];
    if (!stat) {
      textChanged = true; // 上一版里有的章现在没了：要剔除，也算内容变化
      continue;
    }
    const previous = oldChapters.get(chapter.file);
    // 只有「新章 / 正文指纹变了」才需要重算位图；章节序号 / 章名变化由下面的元数据更新覆盖。
    // E4：指纹 = mtime + size + 首尾内容哈希（同大小、保留时间戳的改写靠第三项发现）。
    if (
      !previous ||
      previous.mtimeMs !== stat.mtimeMs ||
      previous.size !== stat.size ||
      previous.contentHash !== stat.contentHash
    ) {
      textChanged = true;
    }
    chapters.push({
      id: typeof chapter.id === 'string' ? chapter.id : '',
      name: typeof chapter.name === 'string' ? chapter.name : '',
      file: chapter.file,
      index: i,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      contentHash: stat.contentHash,
      chars: Number.isFinite(Number(chapter.chars))
        ? Math.max(0, Math.round(Number(chapter.chars)))
        : previous && Number.isFinite(previous.chars)
          ? previous.chars
          : null
    });
  }
  // 上一版里有、这一版没有的章（被删 / 被跳过）也算变化
  if (!textChanged) {
    const files = new Set(chapters.map((chapter) => chapter.file));
    for (const file of oldChapters.keys()) {
      if (!files.has(file)) {
        textChanged = true;
        break;
      }
    }
  }

  const lastModified = latestModifiedMs(metaMtimeMs, chapters);
  const base = {
    path: bookPath,
    folder,
    id: typeof meta.id === 'string' ? meta.id : '',
    title: typeof meta.title === 'string' && meta.title.trim() ? meta.title : folder,
    metaMtimeMs,
    lastModified,
    bloom: '',
    bloomBits: 0,
    bloomCrc: 0,
    itemCount: 0,
    bloomOmitted: false,
    // 审计修复 #33（▲V307）：默认有位图；被总量预算淘汰后才为 true
    bloomDropped: false,
    chapters
  };

  if (old && !textChanged && (old.bloom || old.bloomOmitted === true || old.bloomDropped === true)) {
    // 只改了章名 / 顺序 / 状态：复用位图，不重读正文
    // （P3：上轮「双字太多、主动放弃位图」的书也复用这个结论，不必每轮校验都白读一遍全书）
    // （#33：上轮被索引总量预算丢掉位图的书同理 —— 正文没变就不为它白读一遍全书）
    return {
      entry: {
        ...base,
        bloom: old.bloom,
        bloomBits: old.bloomBits,
        bloomCrc: old.bloomCrc,
        itemCount: old.itemCount,
        bloomOmitted: old.bloomOmitted === true,
        // 审计修复 #33（▲V307）：沿用「没有位图」的结论（旧索引没有这个字段 → false）
        bloomDropped: old.bloomDropped === true,
        chapters: base.chapters.map((chapter) => {
          const previous = oldChapters.get(chapter.file);
          return previous && chapter.chars == null ? { ...chapter, chars: previous.chars } : chapter;
        })
      },
      rebuilt: false
    };
  }

  if (onProgress) onProgress({ phase: 'book', book: base.title, chapters: chapters.length });
  // P2-1：逐批读正文 → 并进位图 Set → 丢引用。批内仍限并发 6、批间串行，章的先后顺序不变
  //（Set 插入顺序不变 ⇒ 位图字节与「整本 texts 一次建」完全相同）。
  const builder = createBookBloom({ maxItems: options.bloomMaxItems });
  const counts = new Array(chapters.length).fill(null);
  let missingText = false;
  for (let start = 0; start < chapters.length && !missingText; start += BLOOM_BUILD_BATCH) {
    const batch = chapters.slice(start, start + BLOOM_BUILD_BATCH);
    const texts = await mapLimit(batch, 6, async (chapter) => {
      try {
        return (await storage.loadChapterText(bookPath, chapter.file)).text;
      } catch {
        return null; // 读不到正文：整本位图作废（宁可每次都当候选，也不能漏报）
      }
    });
    for (let offset = 0; offset < texts.length; offset += 1) {
      const text = texts[offset];
      if (text == null) {
        missingText = true;
        break;
      }
      builder.addText(text);
      if (chapters[start + offset].chars == null) counts[start + offset] = chaptersLib.countChars(text);
    }
  }
  if (missingText) {
    // 有章节读不了：不给位图，搜索时这本书永远进候选、逐章核对（字数也不补，与旧实现一致）
    return {
      entry: { ...base, bloom: '', bloomBits: 0, bloomCrc: 0, itemCount: 0, bloomOmitted: false },
      rebuilt: true
    };
  }
  const built = builder.finish();
  for (let i = 0; i < chapters.length; i += 1) {
    if (chapters[i].chars == null && counts[i] != null) chapters[i].chars = counts[i];
  }
  if (built.omitted) {
    // P3（审计修复 #19）：不重复双字超过 MAX_BLOOM_ITEMS（巨书极端形态）→ 主动放弃位图。
    // 与「章读不了」同一口径：搜索永远把这本书当候选、逐章核对（只降速不漏报）；
    // bloomOmitted 记住这个取舍，下次深度校验不再为同一本书白读一遍正文。
    return {
      entry: { ...base, bloom: '', bloomBits: 0, bloomCrc: 0, itemCount: 0, bloomOmitted: true },
      rebuilt: true
    };
  }
  return {
    entry: {
      ...base,
      bloom: encodeBloom(built.bloom),
      bloomBits: built.bits,
      bloomCrc: crc32(built.bloom),
      itemCount: built.items
    },
    rebuilt: true
  };
}

function createSearchStore(options = {}) {
  const userDataDir = path.resolve(String(options.userDataDir == null ? '' : options.userDataDir));
  const filePath = path.join(userDataDir, INDEX_FILE_NAME);
  const clock = typeof options.now === 'function' ? options.now : () => new Date();
  const validateIntervalMs = Number.isFinite(options.validateIntervalMs)
    ? Math.max(0, options.validateIntervalMs)
    : FULL_VALIDATE_INTERVAL_MS;
  // stat 可注入：单测用它数「一次搜索到底 stat 了几次」（P-01 的锚点），产品里就是 fs.stat。
  const statFile = typeof options.stat === 'function' ? options.stat : (target) => fs.stat(target);
  // P3（审计修复 #19）：单测用 —— 把建图双字上限压小，验证「超限 → 放弃位图」的整条链路
  const bloomMaxItems = Number.isFinite(options.bloomMaxItems)
    ? Math.max(1, Math.floor(options.bloomMaxItems))
    : undefined;
  // 搜索侧窗口：validateIntervalMs=0（单测里「每次都要看到外部改动」的口径）时退回旧行为。
  const searchEnsureIntervalMs = validateIntervalMs === 0 ? 0 : SEARCH_ENSURE_INTERVAL_MS;
  const nowMs = () => {
    const date = clock();
    const ms = date instanceof Date ? date.getTime() : NaN;
    return Number.isFinite(ms) ? ms : Date.now();
  };

  let index = emptyIndex('');
  let loaded = false;
  // X9（v1.8.0 WP-40，审计 X9）：首载必须共享同一个读盘 Promise。以前先置 loaded=true 再 await 读盘，
  // 并发的第二个调用方会立刻拿到空索引（启动瞬间搜索空结果，靠 ensure 自愈）。现在 loaded 只在读盘
  // 这一趟结束（成功或失败都算「尝试过」）后置位，并发调用方等同一次读盘结果。
  let loadPromise = null;
  let loadProblem = null;
  let indexBytes = 0;
  let ensurePromise = null;
  // P1（审计修复 #9）：当前在途 / 排队校验对应的书架根（归一化后）。搜索靠它判断
  // 「同一个根已经有校验在飞」，避免首建期再排到它后面等一遍完整校验。
  let ensureRoot = '';
  let lastFullValidateAt = 0;
  let lastProgress = null;
  let lastRun = null;
  let savePromise = Promise.resolve();
  let lastSaveError = null;
  // 审计修复 #46（E21）：书架根不可读的上一次结果（ROOT_UNREADABLE / 系统码）。status() / search()
  // 都要能看见它 —— 以前只在 doEnsure 的返回值里挂一下，搜索侧拿 status() 时这一趟失败就蒸发了，
  // 作者看到的是「没有结果」，不是「书架读不了」。
  let rootProblem = '';
  // P-01：最近一次成功校验的时刻 / 当时的根目录签名 / 最近一次签名探测时刻。
  let lastEnsureAt = 0;
  let rootSignature = '';
  let lastSignatureCheckAt = 0;
  const dirtyBooks = new Set();
  // V93：path -> { bloom(base64), bits, buffer }，按 LRU 只留最近用过的 BLOOM_CACHE_MAX 本。
  // P3（审计修复 #19）：条数之外再加字节预算（BLOOM_CACHE_MAX_BYTES，单测可注入
  // options.bloomCacheMaxBytes）—— 32 条 × 单本最大 8 MB 位图 ≈ 256 MB 的老口径在这里被压住。
  const bloomCache = new Map();
  let bloomCacheBytes = 0;
  const bloomCacheMaxBytes = Number.isFinite(options.bloomCacheMaxBytes)
    ? Math.max(0, Math.floor(options.bloomCacheMaxBytes))
    : BLOOM_CACHE_MAX_BYTES;
  // 审计修复 #33（▲V307）：单文件索引的总量预算（单测注入小值验证淘汰路径；0 = 不设预算）。
  const indexMaxBytes = Number.isFinite(options.indexMaxBytes)
    ? Math.max(0, Math.floor(options.indexMaxBytes))
    : MAX_INDEX_BYTES;

  function forgetBloom(bookPath) {
    const cached = bloomCache.get(bookPath);
    if (!cached) return;
    bloomCache.delete(bookPath);
    bloomCacheBytes -= cached.buffer ? cached.buffer.length : 0;
  }

  function rememberBloom(bookPath, entry) {
    forgetBloom(bookPath);
    bloomCache.set(bookPath, entry);
    bloomCacheBytes += entry.buffer ? entry.buffer.length : 0;
    while (
      bloomCache.size > BLOOM_CACHE_MAX ||
      // 单个超预算的大位图仍留一份（否则每次搜索都重解码，白费 CPU）；其余按 LRU 让位
      (bloomCacheBytes > bloomCacheMaxBytes && bloomCache.size > 1)
    ) {
      const oldest = bloomCache.keys().next().value;
      forgetBloom(oldest);
    }
  }

  function bloomFor(book) {
    if (!book.bloom) return null;
    const cached = bloomCache.get(book.path);
    if (cached && cached.bloom === book.bloom && cached.bits === book.bloomBits && cached.crc === book.bloomCrc) {
      // 命中：挪到队尾（Map 的插入顺序就是 LRU 顺序）。位图变了（重建过）算未命中。
      rememberBloom(book.path, cached);
      return cached.buffer;
    }
    const buffer = decodeBloom(book.bloom, book.bloomBits, book.bloomCrc);
    if (!buffer) {
      // E5（审计修复 #8）：位图 / CRC 校验不过 → 搜这本书时永远当候选、逐章核对（只降速不漏报），
      // 并登记脏书把搜索窗口关掉，让下一次校验重建它（自愈）。旧实现会静默用坏位图漏报。
      markDirty(book.path);
      return null;
    }
    rememberBloom(book.path, { bloom: book.bloom, bits: book.bloomBits, crc: book.bloomCrc, buffer });
    return buffer;
  }

  // 根目录签名（P-01）：书架目录自身的 mtime。新建 / 删除一本书都会改它，
  // 所以「窗口内也要尽快发现新书」不靠逐书 stat，而靠这一次 stat。
  // 目录不可读 / 不存在时不抛错（签名记成错误码，交给下一次 ensure 按老路径报问题）。
  async function rootSignatureOf(booksRoot) {
    try {
      const info = await statFile(booksRoot);
      return `ok:${Number(info && info.mtimeMs) || 0}`;
    } catch (err) {
      return `err:${(err && err.code) || 'ERROR'}`;
    }
  }

  function load() {
    if (loaded) return Promise.resolve(index);
    if (loadPromise) return loadPromise; // 首载在途：后来的调用等同一趟读盘
    loadPromise = (async () => {
      try {
        // C17（v1.8.0 WP-19）：先 stat + 独立上限再读。超限与「内容坏了」分开记（INDEX_TOO_LARGE /
        // CORRUPT），都按空索引重建；区别是界面 / 排查时能看出「是被换成了大文件」而不是索引写坏。
        // 审计修复 #45（S8）：闸门与读盘绑在同一个句柄上（open → fstat → 从同一句柄读）——
        // 旧实现 stat 之后按路径 readFile，间隙里索引文件被换成大文件就整份读进内存。
        const handle = await fs.open(filePath, 'r');
        let text;
        try {
          const info = await handle.stat();
          const tooLarge = storage.readSizeProblem(info.size, {
            code: 'INDEX_TOO_LARGE',
            label: '搜索索引文件',
            limit: MAX_INDEX_READ_BYTES,
            tail: '没有读进内存'
          });
          if (tooLarge) {
            loadProblem = tooLarge.code;
            index = emptyIndex('');
            return index;
          }
          text = await handle.readFile('utf8');
        } finally {
          try {
            await handle.close();
          } catch { /* 关不掉不影响已读到的内容 */ }
        }
        indexBytes = Buffer.byteLength(text);
        const parsed = parseIndex(text);
        if (parsed) {
          index = parsed;
          // 审计修复 #33（▲V307）：旧版本写出的索引可能超过新的总量预算 —— 读回时先淘汰（内存立即
          // 生效，搜索从这次起就不再用被淘汰的位图），并把结果落盘一次；写失败只记 lastSaveError，
          // 不影响本次搜索。预算内（绝大多数情况）不做任何多余序列化。
          if (indexBytes > indexMaxBytes) {
            const budgeted = enforceIndexBudget(index, indexMaxBytes);
            if (budgeted.dropped > 0) {
              index = budgeted.index;
              await saveThrough(); // 审计修复 #46（E21）：走与 flush 同一条串行链
            }
          }
        } else {
          loadProblem = 'CORRUPT';
          index = emptyIndex('');
        }
      } catch (err) {
        if (err && err.code !== 'ENOENT') loadProblem = err.code || 'ERROR';
        index = emptyIndex('');
      } finally {
        // X9：读盘这一趟彻底结束后才允许「已加载」短路；失败也记账（与原行为一致：进程内只尝试一次，
        // 由下一次 ensure 走重建 / 自愈，而不是每次搜索都重新读坏文件）。
        loaded = true;
        loadPromise = null;
      }
      return index;
    })();
    return loadPromise;
  }

  function status() {
    return {
      file: filePath,
      ready: Boolean(index.builtAt) && index.books.length > 0,
      books: index.books.length,
      chapters: totalChapters(index),
      bytes: indexBytes,
      // 审计修复 #33（▲V307）：被总量预算丢掉位图的书数（>0 时这些书搜索时逐章核对，只降速不漏报）
      droppedBlooms: index.books.reduce((count, book) => count + (book.bloomDropped === true ? 1 : 0), 0),
      builtAt: index.builtAt || '',
      updatedAt: index.updatedAt || '',
      root: index.root,
      building: Boolean(ensurePromise),
      progress: lastProgress,
      problem: loadProblem,
      // 审计修复 #46（E21）：书架根读不了时把错误码透传给搜索 / 界面（成功校验后清空）
      error: rootProblem,
      saveError: lastSaveError,
      lastRun
    };
  }

  async function saveNow() {
    try {
      // 审计修复 #33（▲V307）：先整份序列化，超出总量预算才做淘汰（正常书架一次 stringify 的
      // 成本不变）；淘汰后重序列化一次，正常书架写出的文件大小 / 每次 flush 的写放大都有上界。
      // 审计残留修复 #R17（#33-V307）：没有可丢位图时仍照常写出（预算尽力而为，读侧 64 MB 兜底），
      // 章节指纹一条不丢 —— 不为了凑预算删指纹、把每次启动变成全量重扫。
      let text = serializeIndex(index);
      if (Buffer.byteLength(text) > indexMaxBytes) {
        const budgeted = enforceIndexBudget(index, indexMaxBytes);
        if (budgeted.dropped > 0) {
          index = budgeted.index;
          text = serializeIndex(index);
        }
      }
      await atomicWriteFile(filePath, text);
      indexBytes = Buffer.byteLength(text);
      lastSaveError = null;
      loadProblem = null;
      return true;
    } catch (err) {
      lastSaveError = (err && err.code) || 'ERROR';
      return false;
    }
  }

  // 落盘只在 flush() 里串行做（保存失败只记 lastSaveError、不影响搜索）。
  // 以前这里还有一个 scheduleSave() 做防抖延迟写，但从来没有人调用它（v0.9 B-4 死代码扫描
  // 扫出来，连它的 saveDebounceMs 选项一起删掉了）——现在写索引只有 flush() 这一条路径。
  // 审计修复 #46（E21）：doEnsure / load 里的「预算淘汰后重落盘」也排进这一条串行链 ——
  // 以前它们直接 await saveNow()，绕开 savePromise，与上面这句注释矛盾，两次写还可能交错
  // （后写的整份覆盖先写的）。saveThrough 是唯一的入队口，flush 只是等它 + 回状态。
  function saveThrough() {
    savePromise = savePromise.then(saveNow, saveNow).catch(() => false);
    return savePromise;
  }

  async function flush() {
    await saveThrough();
    return status();
  }

  async function doEnsure(options2 = {}) {
    const booksRoot = String(options2.booksRoot == null ? '' : options2.booksRoot);
    const force = Boolean(options2.force);
    // deep=false 时只校验 书目.json 的 mtime（搜索走这条路：不为 3000 次章节 stat 等一秒）；
    // 回书架 / 启动时的后台校验（deep=true）才逐章 stat，用来发现「外部改过的 txt」。
    const deep = options2.deep !== false;
    const onProgress = typeof options2.onProgress === 'function' ? options2.onProgress : null;
    await load();

    const root = normalizePath(booksRoot);
    const rootChanged = index.root !== root;

    let folders;
    try {
      folders = await listBookFolders(booksRoot);
    } catch (err) {
      // 审计修复 #46（E21）：确认新根可读之前不动内存里的索引 —— 旧实现先按 rootChanged 把索引清成
      // 空（bloomCache / lastFullValidateAt 一起清），再去 readdir，根不可读时白清一场：界面上的书
      // 全没了、下一次回旧根还得从头重建。现在清索引放在 readdir 成功之后。
      rootProblem = (err && err.code) || 'ROOT_UNREADABLE';
      const result = status();
      result.error = rootProblem;
      return result;
    }
    if (rootChanged) {
      index = emptyIndex(root);
      bloomCache.clear();
      bloomCacheBytes = 0;
      lastFullValidateAt = 0;
    }
    rootProblem = '';

    // 本轮校验对应的根目录签名：一次 stat，之后窗口内的搜索都靠它判「书架有没有增删书」。
    const signature = await rootSignatureOf(booksRoot);
    const fullValidate =
      force || rootChanged || (deep && nowMs() - lastFullValidateAt >= validateIntervalMs);
    const previous = new Map(index.books.map((book) => [normalizePath(book.path), book]));
    const nextBooks = [];
    const run = {
      force,
      fullValidate,
      addedBooks: 0,
      rebuiltBooks: 0,
      reusedBooks: 0,
      removedBooks: 0,
      changed: rootChanged,
      books: folders.length,
      chapters: 0
    };
    let progressAt = 0;
    const report = (info, forceReport) => {
      const now = Date.now();
      if (!onProgress) return;
      if (!forceReport && now - progressAt < PROGRESS_INTERVAL_MS) return;
      progressAt = now;
      lastProgress = { ...info, at: now };
      try {
        onProgress(lastProgress);
      } catch {
        /* 进度回调不能影响建索引 */
      }
    };

    let doneBooks = 0;
    for (const { folder, bookPath } of folders) {
      const key = normalizePath(bookPath);
      const old = previous.get(key) || null;
      const dirty = dirtyBooks.has(key);
      let reuse = false;
      if (old && !force && !dirty) {
        // 先看 书目.json 的 mtime（每本一次 stat，很便宜；改名 / 排序都靠它发现）。
        // 全量校验窗口外，mtime 没变就整本跳过（省掉 3000 多次章节 stat）；
        // 全量校验时即使 mtime 没变也走 buildBookEntry —— 它会逐章 stat 找「外部改过的 txt」，
        // 章节指纹都没变时复用旧位图，不重读正文。
        let metaMtimeMs = 0;
        try {
          metaMtimeMs = (await statFile(path.join(bookPath, storage.BOOK_FILE))).mtimeMs;
        } catch {
          metaMtimeMs = 0;
        }
        if (metaMtimeMs && metaMtimeMs === old.metaMtimeMs && !fullValidate) reuse = true;
      }
      if (reuse) {
        nextBooks.push(old);
        previous.delete(key);
        run.reusedBooks += 1;
        run.chapters += old.chapters.length;
        doneBooks += 1;
        report({ phase: 'validate', done: doneBooks, total: folders.length, books: doneBooks, chapters: run.chapters });
        continue;
      }

      report({
        phase: 'book',
        done: doneBooks,
        total: folders.length,
        book: folder,
        books: doneBooks,
        chapters: run.chapters
      });
      let built = null;
      try {
        built = await buildBookEntry(
          bookPath,
          folder,
          old,
          { force, dirty, bloomMaxItems },
          (info) => report({ ...info, done: doneBooks, total: folders.length })
        );
      } catch {
        built = null; // 单本书异常不能拖垮整个索引
      }
      doneBooks += 1;
      previous.delete(key);
      dirtyBooks.delete(key);
      if (!built) {
        // 没有书目 / 读不出来：不索引这本书（书卡在书架上仍会显示损坏提示）
        continue;
      }
      const entry = built.entry;
      if (!old) run.addedBooks += 1;
      else if (built.rebuilt) run.rebuiltBooks += 1;
      else run.reusedBooks += 1;
      if (!sameBook(old, entry)) run.changed = true;
      nextBooks.push(entry);
      run.chapters += entry.chapters.length;
      report({ phase: 'book', done: doneBooks, total: folders.length, book: entry.title, books: doneBooks, chapters: run.chapters });
    }
    run.removedBooks = previous.size;
    if (previous.size) run.changed = true;
    run.books = nextBooks.length;
    run.chapters = totalChapters({ books: nextBooks });
    for (const key of Array.from(dirtyBooks)) {
      if (!folders.some((folder) => normalizePath(folder.bookPath) === key)) dirtyBooks.delete(key);
    }
    index = {
      version: INDEX_VERSION,
      root,
      builtAt: index.builtAt || nowIso(clock),
      updatedAt: nowIso(clock),
      books: nextBooks
    };
    lastFullValidateAt = fullValidate ? nowMs() : lastFullValidateAt;
    // P-01：这次校验是「全部就绪」的，记下窗口起点与签名，后续搜索直接用内存索引。
    lastEnsureAt = nowMs();
    rootSignature = signature;
    lastSignatureCheckAt = lastEnsureAt;
    if (run.changed || rootChanged) await saveThrough(); // 审计修复 #46（E21）：排进 flush 的串行链
    lastRun = run;
    const result = status();
    if (run.changed || rootChanged) {
      report(
        {
          phase: 'done',
          done: folders.length,
          total: folders.length,
          books: run.books,
          chapters: run.chapters,
          rebuilt: run.rebuiltBooks,
          bytes: indexBytes
        },
        true
      );
    }
    return result;
  }

  // 同一时间只跑一次校验 / 建索引；后来的调用排在后面（force 仍会执行）。
  function ensure(opts = {}) {
    ensureRoot = normalizePath(String(opts.booksRoot == null ? '' : opts.booksRoot));
    const previous = ensurePromise || Promise.resolve();
    const run = previous.catch(() => {}).then(() => doEnsure(opts));
    ensurePromise = run;
    run.then(
      () => {
        if (ensurePromise === run) ensurePromise = null;
      },
      () => {
        if (ensurePromise === run) ensurePromise = null;
      }
    );
    return run;
  }

  async function search(opts = {}) {
    const booksRoot = String(opts.booksRoot == null ? '' : opts.booksRoot);
    const normalized = normalizeQuery(opts.query);
    const requestedLimit = Number(opts.limit);
    const limit = Math.max(
      1,
      Math.min(MAX_RESULT_LIMIT, Number.isFinite(requestedLimit) ? Math.round(requestedLimit) : DEFAULT_RESULT_LIMIT)
    );
    const maxBooks = Math.max(
      1,
      Math.min(MAX_CANDIDATE_BOOKS, Math.round(Number(opts.maxBooks) || MAX_CANDIDATE_BOOKS))
    );
    const timeBudgetMs = Math.max(1, Number(opts.timeBudgetMs) || SEARCH_TIME_BUDGET_MS);
    const readConcurrency = Math.min(
      MAX_CHAPTER_READ_CONCURRENCY,
      Math.max(1, Math.floor(Number(opts.readConcurrency) || CHAPTER_READ_CONCURRENCY))
    );
    const qBigrams = queryBigrams(normalized);

    const makeBase = (indexInfo) => ({
      query: normalized,
      results: [],
      limit,
      candidateBooks: 0,
      scannedBooks: 0,
      scannedChapters: 0,
      skippedChapters: 0,
      matchedChapters: 0,
      totalMatches: 0,
      truncated: false,
      tooShort: false,
      elapsedMs: 0,
      index: indexInfo
    });

    if (normalized.length < MIN_QUERY_CHARS || !qBigrams.length) {
      const state = await statusResult();
      return {
        ...makeBase({ books: state.books, chapters: state.chapters, building: state.building }),
        tooShort: true
      };
    }

    // P-01：索引已就绪 + 同一个书架根 + 版本一致时，窗口内不再 ensure（0 次逐书 stat）。
    // 窗口外 / 根目录签名变了 / force 才走原来的校验路径。
    const searchRoot = normalizePath(booksRoot);
    const now = nowMs();
    const forceEnsure = Boolean(opts.ensureOptions && opts.ensureOptions.force);
    // P1（审计修复 #9）：首建期（本根还没有可用的内存索引）同一个根已有校验在飞时，
    // 搜索**不再排到它后面**等一遍完整校验（旧实现大书架要阻塞数分钟，1800ms 预算在
    // ensure 返回后才起算）。这里直接回 building:true + 空结果，界面据此显示「正在建索引」；
    // 建完后按进度事件自动重搜（renderer.js 的 onSearchProgress）—— 结果不会丢，只是晚一步。
    // 已经有本根可用索引时（改名 / 脏书触发的后台校验）仍走原路径：旧结果比空结果有用。
    const hasUsableIndex = index.root === searchRoot && index.books.length > 0;
    if (ensurePromise && ensureRoot === searchRoot && !forceEnsure && !hasUsableIndex) {
      const state = status();
      const buildingInfo = {
        books: state.books,
        chapters: state.chapters,
        building: true,
        problem: state.problem || '',
        bytes: state.bytes
      };
      return { ...makeBase(buildingInfo), truncated: true, elapsedMs: 0 };
    }
    const reuseIndex =
      loaded &&
      index.root === searchRoot &&
      index.version === INDEX_VERSION &&
      lastEnsureAt > 0 &&
      now - lastEnsureAt < searchEnsureIntervalMs &&
      !forceEnsure;
    let signatureChanged = false;
    if (reuseIndex && now - lastSignatureCheckAt >= SEARCH_SIGNATURE_INTERVAL_MS) {
      // 2 s 节流：连续两次 search 合计只发生这一次 stat。
      const signature = await rootSignatureOf(booksRoot);
      lastSignatureCheckAt = now;
      signatureChanged = signature !== rootSignature;
    }
    const state = reuseIndex && !signatureChanged
      ? status()
      : await ensure({
          booksRoot,
          deep: nowMs() - lastFullValidateAt >= SEARCH_DEEP_INTERVAL_MS,
          ...(opts.ensureOptions || {})
        });
    // V92（1.7.2 D6）：building 透传 state.building（以前写死 false）。state 可能是 status() 的
    // 快照（搜索窗口内直接复用内存索引，后台重建正在飞），界面靠这个字段决定显示「正在建索引」。
    const indexInfo = {
      books: state.books,
      chapters: state.chapters,
      building: Boolean(state.building),
      problem: state.problem || '',
      bytes: state.bytes
    };
    // 审计修复 #46（E21）：书架根读不了（ROOT_UNREADABLE / 系统码）时把错误码透传给调用方，
    // 不再静默回一份「没有结果」的空搜索 —— 作者 / 界面至少知道是书架路径的问题。
    if (state.error) {
      return {
        ...makeBase({ ...indexInfo, books: 0, chapters: 0, problem: state.error }),
        error: state.error,
        truncated: true,
        elapsedMs: 0
      };
    }
    if (normalizePath(booksRoot) !== index.root) {
      return { ...makeBase(indexInfo), truncated: true, index: { ...indexInfo, books: 0, chapters: 0 } };
    }

    const startedAt = Date.now();

    // P22-4：聚焦一章（书架「展开本章全部」）。只认索引里真实存在的书 + 该书章节列表里的 file：
    // 归一化后必须落在 index.root 下、且属于 index.books；章节文件必须逐字匹配、不带路径分隔符。
    // 任何一步不成立都直接回空结果 + focusError，绝不按调用方给的字符串去读盘。
    if (opts.focus !== undefined && opts.focus !== null) {
      const focusLimit = MAX_FOCUS_SNIPPETS;
      const focusError = (message) => ({
        ...makeBase(indexInfo),
        limit: focusLimit,
        focus: true,
        focusError: message,
        elapsedMs: Date.now() - startedAt
      });
      const rawFocus = opts.focus;
      const rawBookPath =
        rawFocus && typeof rawFocus === 'object' && !Array.isArray(rawFocus) && typeof rawFocus.bookPath === 'string'
          ? rawFocus.bookPath.trim()
          : '';
      const rawChapterFile =
        rawFocus && typeof rawFocus === 'object' && !Array.isArray(rawFocus) && typeof rawFocus.chapterFile === 'string'
          ? rawFocus.chapterFile
          : '';
      if (!rawBookPath || !rawChapterFile) return focusError('聚焦的书籍或章节无效');
      if (
        rawBookPath.length > MAX_FOCUS_FIELD_CHARS ||
        rawChapterFile.length > MAX_FOCUS_FIELD_CHARS ||
        rawBookPath.includes('\u0000') ||
        rawChapterFile.includes('\u0000') ||
        rawChapterFile.includes('/') ||
        rawChapterFile.includes('\\') ||
        rawChapterFile === '.' ||
        rawChapterFile === '..'
      ) {
        return focusError('聚焦的书籍或章节无效');
      }
      const rootKey = normalizePath(index.root);
      const bookKey = normalizePath(rawBookPath);
      const rootPrefix = rootKey ? (rootKey.endsWith(path.sep) ? rootKey : rootKey + path.sep) : '';
      if (!rootPrefix || !bookKey || bookKey === rootKey || !bookKey.startsWith(rootPrefix)) {
        return focusError('聚焦的书籍不在书架索引里');
      }
      const book = index.books.find((item) => normalizePath(item.path) === bookKey);
      if (!book) return focusError('聚焦的书籍不在书架索引里');
      const chapter = book.chapters.find((item) => item.file === rawChapterFile);
      if (!chapter) return focusError('聚焦的章节不在书架索引里');

      // 只读这一章（storage.loadChapterText 自己还会再挡一次越界路径）。
      let text;
      try {
        text = (await storage.loadChapterText(book.path, chapter.file)).text;
      } catch {
        return focusError('聚焦的章节读取失败');
      }
      const haystack = normalizeForMatch(text);
      // P3：计数与片段位置同一次扫描产出（改前是计数 1 遍 + 片段 1 遍）。
      const scanInfo = scanChapterMatches(haystack, normalized, MAX_CHAPTER_MATCH_COUNT, focusLimit, () =>
        Date.now() - startedAt > timeBudgetMs
      );
      const rows = [];
      let stopped = scanInfo.stopped;
      // 时间预算的逐条检查点位置不变：仍在「准备产出每一条片段之前」查一次。
      for (const at of scanInfo.positions) {
        if (Date.now() - startedAt > timeBudgetMs) {
          stopped = true;
          break;
        }
        rows.push({
          bookPath: book.path,
          bookTitle: book.title,
          folder: book.folder,
          chapterId: chapter.id,
          chapterIndex: chapter.index,
          chapterName: chapter.name,
          chapterFile: chapter.file,
          matchIndex: at,
          matchLength: normalized.length,
          snippet: snippetAround(text, at, normalized.length),
          chapterMatchCount: scanInfo.count,
          chapterCountCapped: scanInfo.capped
        });
      }
      return {
        ...makeBase(indexInfo),
        limit: focusLimit,
        results: rows,
        focus: true,
        candidateBooks: 1,
        scannedBooks: 1,
        scannedChapters: 1,
        skippedChapters: 0,
        matchedChapters: scanInfo.count > 0 ? 1 : 0,
        totalMatches: scanInfo.count,
        truncated: stopped || scanInfo.capped || scanInfo.count > rows.length,
        elapsedMs: Date.now() - startedAt
      };
    }

    const candidates = [];
    for (const book of index.books) {
      const bloom = bloomFor(book);
      if (!bloom) {
        candidates.push(book); // 没有位图（有章节读不了）→ 永远核查，不能漏
        continue;
      }
      let ok = true;
      for (const hash of qBigrams) {
        if (!bloomHas(bloom, book.bloomBits, hash)) {
          ok = false;
          break;
        }
      }
      if (ok) candidates.push(book);
    }
    candidates.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
    const scanTarget = candidates.slice(0, maxBooks);
    const results = [];
    let matchedChapters = 0;
    // P22-4：totalMatches 从「已列出的片段数」改成「真命中数」——每章按位置数完再只列前 3 条，
    // 所以一章 10 处命中时 results 仍最多 3 条，但 totalMatches / 每行 chapterMatchCount 是 10。
    let totalMatches = 0;
    let scannedBooks = 0;
    let scannedChapters = 0;
    let skippedChapters = 0;
    let stoppedByTime = false;

    for (const book of scanTarget) {
      if (results.length >= limit) break;
      if (Date.now() - startedAt > timeBudgetMs) {
        stoppedByTime = true;
        break;
      }
      scannedBooks += 1;
      // B11（v1.8.0 WP-29）：按 readConcurrency 一批先并发读盘，再按书目顺序逐章扫描。
      // 停止条件（结果条数 / 时间预算 / 扫描自停）仍逐章判断；计数（scanned / skipped / 命中）
      // 只统计真正处理过的章 —— 批里多读的章若在预算内没用上，不计数、不影响结果（只浪费有界的
      // 预读）。结果顺序、片段内容、limit / truncated 语义与串行版逐字段一致。
      const chapters = book.chapters;
      let stopBook = false;
      for (let start = 0; start < chapters.length; start += readConcurrency) {
        if (results.length >= limit) {
          stopBook = true;
          break;
        }
        if (Date.now() - startedAt > timeBudgetMs) {
          stoppedByTime = true;
          stopBook = true;
          break;
        }
        const batch = chapters.slice(start, start + readConcurrency);
        const loaded = await mapLimit(batch, readConcurrency, async (chapter) => {
          try {
            return { ok: true, text: (await storage.loadChapterText(book.path, chapter.file)).text };
          } catch {
            return { ok: false, text: '' };
          }
        });
        for (let k = 0; k < batch.length; k += 1) {
          if (results.length >= limit) {
            stopBook = true;
            break;
          }
          // B11：批内第 1 章在「开始这批之前」已经查过时间预算（与串行版逐章开头的判定同一时点）；
          // 后续章逐章再查。不能在这里对 k=0 也重查 —— 预读 4 章本身耗时会挤掉极紧预算下的第一段结果。
          if (k > 0 && Date.now() - startedAt > timeBudgetMs) {
            stoppedByTime = true;
            stopBook = true;
            break;
          }
          const chapter = batch[k];
          const entry = loaded[k];
          if (!entry || !entry.ok) {
            skippedChapters += 1; // 索引之后文件被删 / 被占用：跳过，不让整次搜索失败
            continue;
          }
          const text = entry.text;
          scannedChapters += 1;
          const haystack = normalizeForMatch(text);
          // P22-4：先数清这一章到底几处命中（单次 indexOf 循环），再按旧口径只列前 3 条。
          // 计数上限 / 时间预算只影响 chapterMatchCount 的精度（capped 时界面显示「N+」），
          // 默认路径的结果条数 / 顺序 / limit / truncated 语义保持旧行为不变。
          // P3：计数与片段位置同一次扫描产出（改前是计数 1 遍 + 片段 1 遍）。
          const scanInfo = scanChapterMatches(haystack, normalized, MAX_CHAPTER_MATCH_COUNT, MAX_SNIPPETS_PER_CHAPTER, () =>
            Date.now() - startedAt > timeBudgetMs
          );
          for (const at of scanInfo.positions) {
            if (results.length >= limit) break;
            results.push({
              bookPath: book.path,
              bookTitle: book.title,
              folder: book.folder,
              chapterId: chapter.id,
              chapterIndex: chapter.index,
              chapterName: chapter.name,
              chapterFile: chapter.file,
              matchIndex: at,
              matchLength: normalized.length,
              snippet: snippetAround(text, at, normalized.length),
              chapterMatchCount: scanInfo.count,
              chapterCountCapped: scanInfo.capped
            });
          }
          if (scanInfo.count > 0) {
            matchedChapters += 1;
            totalMatches += scanInfo.count;
          }
          if (scanInfo.stopped) {
            stoppedByTime = true;
            stopBook = true;
            break;
          }
        }
        if (stopBook) break;
      }
      if (stopBook) break;
    }

    const truncated =
      results.length >= limit || stoppedByTime || candidates.length > scanTarget.length;
    return {
      ...makeBase({
        books: index.books.length,
        chapters: totalChapters(index),
        building: Boolean(state.building),
        bytes: indexInfo.bytes,
        builtAt: index.builtAt
      }),
      results,
      candidateBooks: candidates.length,
      scannedBooks,
      scannedChapters,
      skippedChapters,
      matchedChapters,
      totalMatches,
      truncated,
      elapsedMs: Date.now() - startedAt
    };
  }

  async function statusResult() {
    await load();
    return status();
  }

  function markDirty(bookPath) {
    const key = normalizePath(bookPath);
    if (key) {
      dirtyBooks.add(key);
      // P-01：刚保存过书就把搜索窗口关掉，下一次 search 立刻校验这本（不必等 60 s）。
      lastEnsureAt = 0;
    }
    return key;
  }

  function dirtyList() {
    return Array.from(dirtyBooks);
  }

  return {
    filePath,
    ensure,
    search,
    status: statusResult,
    flush,
    markDirty,
    dirtyList,
    load,
    // 供单测 / 自检直接用的内部信息（不参与界面逻辑）
    getIndex: () => index,
    getBytes: () => indexBytes,
    getProblem: () => loadProblem,
    // V93：当前位图缓存条数（锚点用；也方便以后排查「内存里留了几本位图」）
    getBloomCacheSize: () => bloomCache.size,
    // P3（审计修复 #19）：当前位图缓存的字节数（锚点用：条数上界之外还有字节预算）
    getBloomCacheBytes: () => bloomCacheBytes
  };
}

module.exports = {
  INDEX_FILE_NAME,
  INDEX_VERSION,
  // C17（WP-19）：索引读盘的独立上限（测试用稀疏文件验证超限路径）
  MAX_INDEX_READ_BYTES,
  // 审计修复 #33（▲V307）：写盘总量预算 + 超限淘汰纯函数（单测直接核淘汰顺序 / 字节上界）
  MAX_INDEX_BYTES,
  enforceIndexBudget,
  MIN_BLOOM_BITS,
  BLOOM_CACHE_MAX,
  BLOOM_CACHE_MAX_BYTES,
  MAX_BLOOM_ITEMS,
  MAX_SNIPPETS_PER_CHAPTER,
  MAX_CHAPTER_MATCH_COUNT,
  MAX_FOCUS_SNIPPETS,
  MAX_FOCUS_FIELD_CHARS,
  // E4 / E5（审计修复 #8）：章文件首尾采样指纹与每书位图 CRC32（单测直接钉住形状与校验）
  crc32,
  chapterContentHashOf,
  normalizeQuery,
  bigramHash,
  queryBigrams,
  bloomHas,
  makeBookBloom,
  encodeBloom,
  decodeBloom,
  snippetAround,
  parseIndex,
  serializeIndex,
  totalChapters,
  // V107（WP-21）：取「书目 / 章节 mtime 最大值」的纯函数（单测用超大数组钉住不许再展开实参）
  latestModifiedMs,
  buildBookEntry,
  createSearchStore
};
