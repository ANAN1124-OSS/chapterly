// WP5（N1 / 中 #6）：可选崩溃草稿仓库。
//
// 产品红线（作者拍板项 1=B）：
// - **默认关**：默认配置下本模块一次都不会被调用（main.js 的 syncCrashDraftSession 只在
//   crashDraftEnabled === true 时 beginSession）；create 本身不建目录、不写文件。
// - 打开后**只写 userData**：目录是 `%APPDATA%\chapter-writer\crash-drafts\`（baseDir = app.getPath('userData')），
//   绝不写书库 / 书目.json / 章节 txt / config.json。
// - **只用于崩溃恢复，不是自动保存**：草稿只在异常退出（或渲染进程崩溃重载）后提示一次；
//   恢复后正文只进编辑区、仍是未保存状态（Ctrl+S 才写盘）。干净退出清掉标记与草稿。
// - 任何 IO 失败（ENOSPC / EPERM / 被占用 / 坏 JSON）都只回错误码，不抛错、不影响正文保存。
//
// 文件布局（只认自己命名的文件，作者手动放进目录的东西一个都不碰）：
//   crash-drafts/session.json            本进程运行标记（version / pid / startedAt）
//   crash-drafts/draft-<16位sha256>.json 一份草稿的**元数据**（书 + 章 + 字数 + 归属 + 正文文件名）
//   crash-drafts/draft-<16位sha256>.txt  一份草稿的正文（P2：与元数据分开存，列表 / 清理只读元数据）
// 旧版本（v2.0.0 及以前）把正文写在 JSON 的 text 字段里：P2 仍能读（readDraft 回退），
// 下一次 writeDraft 会覆盖成「元数据 + 正文」两份；坏 JSON / 空正文的旧文件照旧跳过、不删。
//
// 本模块不 require electron；单测直接 require + 真临时目录（可注入 fs / now / pid）。
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const pathUtils = require('./path-utils');
// I8（三审）：正文上限的唯一事实源（与 chapter:save 同一条口径）。
const limits = require('./limits');
// I1（三审）：错误文案脱敏的唯一出口（与 main.js 的 fail() 同一份 core/error-text.js）。
const errorText = require('./error-text');

const DRAFT_DIR_NAME = 'crash-drafts';
const SESSION_FILE_NAME = 'session.json';
const FILE_PREFIX = 'draft-';
const DRAFT_FILE_RE = /^draft-([a-f0-9]{16})\.json$/;
const BODY_SUFFIX = '.txt';
const BODY_FILE_RE = /^draft-([a-f0-9]{16})\.txt$/;
// #11（清单）：writeAtomic 的临时文件名是 `.<正式名>.tmp-<pid>-<时间>-<随机>`；崩在 rename 之前
// 会把它留在目录里（以前只按正式名清扫，永远收不回来）。
const TMP_FILE_RE = /^\.draft-[a-f0-9]{16}\.(?:json|txt)\.tmp-/;
// #11：孤儿正文 / 临时文件的回收宽限期。正文文件在「rename 完成、元数据还没写」之间会短暂处于
// 「元数据是 v1、正文已更新」——另一个窗口恰好在这个毫秒级窗口里 prune 到它，不能当成孤儿删掉
// （删掉 = 正在写的那一次草稿丢正文，而正文是未保存内容的唯一磁盘兜底）。所以只清「已经放了
// 10 分钟没人认领」的文件；正常写入的正文 / 临时文件都只活几毫秒。
const ORPHAN_GRACE_MS = 10 * 60 * 1000;
const MARKER_VERSION = 1;
const DRAFT_VERSION = 2;
const MAX_DRAFTS = 8;
// I8（三审）：这里曾经是第二份 `5000000` 字面量（注释自称「与 ipc-limits 同一口径」但物理上各写各的）。
// 现在直接引用 core/limits.js 的唯一常量：草稿正文与 chapter:save 的保存上限同源，改一处不会漏另一处。
// 注意 MAX_STORED_BYTES（32MB）是另一条线（单份草稿正文文件的读取闸门），不跟着这个数字走。
const MAX_TEXT_CHARS = limits.MAX_CHAPTER_SAVE_CHARS;
const MAX_TITLE_CHARS = 200;
const MAX_PATH_CHARS = 1024;
const MAX_CHAPTER_ID_CHARS = 200;
// 草稿最多 5M 字，正文文件约 15MB；超过 32MB 的正文文件不读（别让目录里的大文件把启动拖炸）。
const MAX_STORED_BYTES = 32 * 1024 * 1024;
// 元数据 JSON 只是几十个短字段；超过 1MB 的一定不是我们写的（防手工塞大文件把列表拖炸）。
const MAX_META_BYTES = 1024 * 1024;
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

// I1（三审·中）：这里曾经是「裸 err.message 截 200 码点」—— fs 错误的 message 形如
// `EACCES: permission denied, open 'C:\Users\<用户名>\...\draft-x.json'`，会带着本机绝对路径
// 跨 IPC 进渲染层，破了 preload.js 头注释里「业务错误文案全脱敏」的红线（渲染层此刻只取 code，
// 但任何未来消费 message 的改动都会直接暴露路径）。现在走 core/error-text.js 的唯一脱敏出口：
// 常见文件系统错误码换成中文、路径只留最后一节（`…\draft-x.json`），与 fail() 完全同源。
function safeMessage(err) {
  return errorText.describeForUi(err).message;
}

// P2（一轮·中）：码点计数改成增量扫描 —— 旧实现 `Array.from(text)` 会为一份 500 万字草稿
// 一次性物化 500 万个元素的数组（启动扫描 8 份 = 峰值数百 MB），这里只走一遍码元、不建数组。
function codePointLength(text) {
  if (typeof text !== 'string') return 0;
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    count += 1;
  }
  return count;
}

function clipText(value, max) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return Array.from(text).slice(0, max).join('');
}

function normalizeChapterIndex(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1000000, number));
}

function normalizeDate(value, fallback) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isFinite(date.getTime())) return date;
  return fallback;
}

function isoAt(value, clock) {
  const base = normalizeDate(clock(), new Date());
  const date = normalizeDate(value, base);
  return date.toISOString();
}

// N-14（二次审查）：渲染层给的 at 只用于排序 / 展示，绝不能被当成「现在」——未来的时间戳
// 会让下一次 prune 把别的窗口 / 上次运行留下的草稿全判过期删掉（跨窗口的数据破坏面）。
// 这里只夹未来侧：过去的时间戳是「这份草稿什么时候写的」，保留原值才不影响排序语义；
// prune 的基准时间另有 store 自己的 clock()（见 writeDraft），不再读草稿自报的 at。
function atNotAfterClock(value, clock) {
  const base = normalizeDate(clock(), new Date());
  const date = normalizeDate(value, base);
  return new Date(Math.min(base.getTime(), date.getTime())).toISOString();
}

function draftIdFor(bookPath, chapterId) {
  // 「同一本书 / 同一章」的路径归一口径与 main.js / config-gate 同源（core/path-utils.js 的 pathKey），
  // 大小写 / 斜杠写法不同仍落到同一个草稿位；本模块不再手写第二份。
  const key = `${pathUtils.pathKey(bookPath)}\n${String(chapterId == null ? '' : chapterId)}`;
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
}

// S2（一轮·中/低 + 三审）：草稿记「谁写的」。
// ownerToken 是主进程每进程生成一次的随机令牌（区分「本进程的窗口」与「上次运行留下的草稿」）；
// ownerWindowId 是本进程内的窗口 id。两者都不参与草稿 id 派生（书 + 章仍是唯一草稿位），
// 只用于「多窗口下只给写它的那扇窗口看 / 读 / 删」。单测可以完全不给（= 老草稿，谁都能看）。
function normalizeOwnerToken(value) {
  return typeof value === 'string' ? value.slice(0, 64) : '';
}

function normalizeOwnerWindowId(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// 一份草稿（publicDraft / readDraft 的 draft）对某个查看者可见吗？
//   · 没有 ownerToken，或 ownerToken 不是本进程 → 上次运行（或旧版本）留下的：谁先打开谁处理；
//   · 本进程写的 → 只有它自己那扇窗口可见（多窗口不重复提示同一份草稿）。
function draftVisibleTo(draft, viewer) {
  if (!draft) return true;
  const self = viewer && typeof viewer === 'object' ? viewer : {};
  const token = normalizeOwnerToken(self.ownerToken);
  const windowId = normalizeOwnerWindowId(self.ownerWindowId);
  const ownerToken = normalizeOwnerToken(draft.ownerToken);
  if (!ownerToken) return true;
  if (!token || ownerToken !== token) return true;
  const ownerWindowId = normalizeOwnerWindowId(draft.ownerWindowId);
  if (ownerWindowId == null) return true;
  return windowId != null && ownerWindowId === windowId;
}

function parseDraftFileName(name) {
  const match = DRAFT_FILE_RE.exec(String(name == null ? '' : name));
  return match ? match[1] : null;
}

// 入口清洗（main.js 的 IPC 与仓库写入共用这一份口径）：只收字符串字段，标题 / 路径截断，
// 正文类型与长度先拒绝；返回 { ok:true, entry } 或 { ok:false, code, message }，永不抛。
function sanitizeDraftInput(raw, options = {}) {
  const maxTextChars = Number.isFinite(Number(options.maxTextChars)) && Number(options.maxTextChars) > 0
    ? Number(options.maxTextChars)
    : MAX_TEXT_CHARS;
  const clock = typeof options.now === 'function' ? options.now : () => new Date();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'BAD_DRAFT', message: '草稿形状不对' };
  }
  const bookPath = typeof raw.bookPath === 'string' ? raw.bookPath.trim() : '';
  const chapterId = typeof raw.chapterId === 'string' ? raw.chapterId.trim() : '';
  if (!bookPath || bookPath.length > MAX_PATH_CHARS) {
    return { ok: false, code: 'BAD_DRAFT', message: '草稿缺少书路径（或太长）' };
  }
  if (!chapterId || chapterId.length > MAX_CHAPTER_ID_CHARS) {
    return { ok: false, code: 'BAD_DRAFT', message: '草稿缺少章节 id（或太长）' };
  }
  if (typeof raw.text !== 'string') {
    return { ok: false, code: 'BAD_TEXT', message: '草稿正文必须是文本' };
  }
  const chars = codePointLength(raw.text);
  if (!raw.text.length) {
    return { ok: false, code: 'EMPTY_DRAFT', message: '草稿正文是空的，没有可恢复内容' };
  }
  if (chars > maxTextChars) {
    return {
      ok: false,
      code: 'DRAFT_TOO_LARGE',
      message: `草稿正文太长（${chars} 字，最多 ${maxTextChars} 字），这次没有写入`
    };
  }
  return {
    ok: true,
    entry: {
      bookPath,
      bookTitle: clipText(raw.bookTitle, MAX_TITLE_CHARS),
      chapterId,
      chapterTitle: clipText(raw.chapterTitle, MAX_TITLE_CHARS),
      chapterName: clipText(raw.chapterName, MAX_TITLE_CHARS),
      chapterIndex: normalizeChapterIndex(raw.chapterIndex),
      text: raw.text,
      at: atNotAfterClock(raw.at, clock),
      // P2：字数只在这里算一次，写入 / 回包 / 元数据共用（旧实现 writeDraft 里算了三遍）。
      chars
    }
  };
}

// 从磁盘读回一条草稿的**元数据**（P2 起列表 / 清理只碰这个形状，不读正文）。
// 坏形状 / 缺字段 / 正文超上限一律当不存在（跳过），不删文件。
// v2 元数据带 body 文件名；v1 旧文件带 text 正文（仍可读，readDraft 直接用它）。
function storedEntryFrom(raw, draftId, maxTextChars) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.bookPath !== 'string' || !raw.bookPath.trim()) return null;
  if (typeof raw.chapterId !== 'string' || !raw.chapterId.trim()) return null;
  const legacyText = typeof raw.text === 'string' && raw.text.length ? raw.text : '';
  const expectedBody = `${FILE_PREFIX}${draftId}${BODY_SUFFIX}`;
  const body = typeof raw.body === 'string' && raw.body === expectedBody ? raw.body : '';
  if (!legacyText && !body) return null;
  if (legacyText && codePointLength(legacyText) > maxTextChars) return null;
  const declaredChars = Math.round(Number(raw.chars));
  const chars = Number.isFinite(declaredChars) && declaredChars >= 0
    ? declaredChars
    : codePointLength(legacyText);
  return {
    draftId,
    bookPath: raw.bookPath,
    bookTitle: clipText(raw.bookTitle, MAX_TITLE_CHARS),
    chapterId: raw.chapterId,
    chapterTitle: clipText(raw.chapterTitle, MAX_TITLE_CHARS),
    chapterName: clipText(raw.chapterName, MAX_TITLE_CHARS),
    chapterIndex: normalizeChapterIndex(raw.chapterIndex),
    at: isoAt(raw.at, () => new Date(0)),
    chars,
    ownerToken: normalizeOwnerToken(raw.ownerToken),
    ownerWindowId: normalizeOwnerWindowId(raw.ownerWindowId),
    body,
    text: legacyText
  };
}

function publicDraft(entry) {
  return {
    draftId: entry.draftId,
    bookPath: entry.bookPath,
    bookTitle: entry.bookTitle,
    chapterId: entry.chapterId,
    chapterTitle: entry.chapterTitle,
    chapterName: entry.chapterName,
    chapterIndex: entry.chapterIndex,
    at: entry.at,
    chars: entry.chars,
    // S2：归属信息跟着元数据走（渲染层不消费它；主进程用它校验多窗口归属）。
    ownerToken: entry.ownerToken || '',
    ownerWindowId: entry.ownerWindowId == null ? null : entry.ownerWindowId
  };
}

function compareByAtNewestFirst(a, b) {
  if (a.at === b.at) return a.draftId < b.draftId ? 1 : -1;
  return a.at < b.at ? 1 : -1;
}

// baseDir = app.getPath('userData')；options.fs / options.now / options.pid 只给单测注入。
// 所有方法都不会抛错（除了程序员错误）：IO 失败回 { ok:false, code }。
function createCrashDraftStore(baseDir, options = {}) {
  const base = path.resolve(String(baseDir == null ? '' : baseDir));
  const dir = path.join(base, DRAFT_DIR_NAME);
  const io = options.fs && typeof options.fs === 'object' ? options.fs : fs;
  const clock = typeof options.now === 'function' ? options.now : () => new Date();
  const pid = Number.isFinite(Number(options.pid)) ? Number(options.pid) : process.pid;
  // CRASH-02：本进程的草稿归属令牌。endSession 只清这个令牌写下的草稿——上次运行留下、
  // 作者在恢复提示里选「先留着」的草稿必须跨退出保留，否则干净退出会把那段未保存正文的唯一
  // 磁盘兜底删掉。主进程 createCrashDraftStore 时注入（与 writeDraft 的 ownerToken 同源）。
  const ownerToken = normalizeOwnerToken(options.ownerToken);
  const maxDrafts = Number.isFinite(Number(options.maxDrafts))
    ? Math.max(1, Math.min(64, Math.round(Number(options.maxDrafts))))
    : MAX_DRAFTS;
  const maxTextChars = Number.isFinite(Number(options.maxTextChars)) && Number(options.maxTextChars) > 0
    ? Number(options.maxTextChars)
    : MAX_TEXT_CHARS;
  const staleMs = Number.isFinite(Number(options.staleMs)) ? Math.max(0, Number(options.staleMs)) : STALE_MS;
  const markerPath = path.join(dir, SESSION_FILE_NAME);
  // CGRD-01（审计）：writeDraft 每次落盘后原本都要 prune() → scan()：把目录里**所有**草稿
  // 全量读回并解析（最多 8 份 × 32MB），写放大与草稿总大小成正比。但 prune 只需要
  // 「draftId + at」两份元数据。这里缓存每份草稿的元数据（scan / 写入 / 删除时维护），
  // 写路径只 readdir + 查缓存；目录里出现缓存没有的文件（另一窗口 / 手工放入）才读一次补。
  // #11：缓存里多记一项 claimsBody —— v2 元数据带 body 字段指向 .txt（正文在用）；v1 把正文写在
  // JSON 里，同名 .txt 是「升级写了一半」的残留。sweepOrphanBodies 只按缓存判断，不再为清理读一遍
  // 元数据（否则每次写草稿都会把全部元数据读回，CGRD-01 的写放大又回来了）。
  const metaCache = new Map(); // draftId -> { at, claimsBody } | { invalid: true }

  function claimsBodyOf(raw) {
    return Boolean(
      raw && String(raw.version) === String(DRAFT_VERSION) && typeof raw.body === 'string' && raw.body
    );
  }

  function draftPath(draftId) {
    return path.join(dir, `${FILE_PREFIX}${draftId}.json`);
  }

  function draftBodyPath(draftId) {
    return path.join(dir, `${FILE_PREFIX}${draftId}${BODY_SUFFIX}`);
  }

  // 原子写：临时文件 → fsync → rename；失败删临时文件并抛给调用方（调用方再转成 { ok:false }）。
  // N-13（二次审查）：原实现是 writeFile → rename，没有 fsync；渲染进程崩溃时 OS 缓存还在、够用，
  // 但整机断电 / 蓝屏时会出现「rename 已完成、数据块没落盘」，草稿变成空文件或半截——而草稿正是
  // 未保存正文的唯一磁盘兜底。其它落盘（core/atomic.js、日志、配置、索引）都在 rename 前 fsync。
  // io 是注入的（单测用假 fs）：没有 open/sync 的实现退回旧的 writeFile 路径，行为不变。
  async function writeAtomic(file, content) {
    await io.mkdir(path.dirname(file), { recursive: true });
    const tmp = path.join(
      path.dirname(file),
      `.${path.basename(file)}.tmp-${pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    try {
      if (typeof io.open === 'function') {
        const handle = await io.open(tmp, 'w');
        try {
          await handle.writeFile(content, 'utf8');
          if (typeof handle.sync === 'function') await handle.sync();
        } finally {
          await handle.close();
        }
      } else {
        await io.writeFile(tmp, content, 'utf8');
      }
      await io.rename(tmp, file);
    } catch (err) {
      try {
        await io.unlink(tmp);
      } catch {
        /* 临时文件删不掉：下一次写会另起一个名字，不影响正式文件 */
      }
      throw err;
    }
  }

  function writeJsonAtomic(file, payload) {
    return writeAtomic(file, `${JSON.stringify(payload)}\n`);
  }

  // P2：扫目录里的草稿元数据（只认 draft-<16位hash>.json；坏 JSON / 缺字段 / 超大文件跳过，不删）。
  // 正文在独立的 .txt 里，这里一个字节都不读 —— 启动恢复 / 列表 / 清理的峰值内存与正文大小脱钩。
  async function scan() {
    let names = [];
    try {
      names = await io.readdir(dir);
    } catch {
      return [];
    }
    const entries = [];
    for (const name of names) {
      const draftId = parseDraftFileName(name);
      if (!draftId) continue;
      try {
        const file = path.join(dir, name);
        const stat = await io.stat(file);
        if (!stat || (typeof stat.isFile === 'function' && !stat.isFile())) continue;
        if (Number.isFinite(Number(stat.size)) && Number(stat.size) > MAX_META_BYTES) continue;
        const raw = JSON.parse(await io.readFile(file, 'utf8'));
        const entry = storedEntryFrom(raw, draftId, maxTextChars);
        if (entry) {
          entries.push(entry);
          metaCache.set(draftId, { at: entry.at, claimsBody: claimsBodyOf(raw) });
        } else {
          // 形状稳定地不合法（不是读到一半）：记成 invalid，后续 prune 不必再读它，也不删它。
          metaCache.set(draftId, { invalid: true, claimsBody: false });
        }
      } catch {
        /* 正在被写 / 坏 JSON / 读不到：当这次没有这一条 */
      }
    }
    entries.sort(compareByAtNewestFirst);
    return entries;
  }

  // 只取草稿的元数据（draftId + at），prune 的唯一数据来源。P2 起元数据本身就是小文件：
  // 全部命中 metaCache 时不读盘；缓存没有的文件（另一窗口 / 手工放入）才读一次（坏 JSON 跳过）。
  async function metaEntries() {
    let names = [];
    try {
      names = await io.readdir(dir);
    } catch {
      return [];
    }
    const out = [];
    const seen = new Set();
    for (const name of names) {
      const draftId = parseDraftFileName(name);
      if (!draftId) continue;
      let meta = metaCache.get(draftId);
      if (!meta) {
        try {
          const raw = JSON.parse(await io.readFile(path.join(dir, name), 'utf8'));
          const entry = storedEntryFrom(raw, draftId, maxTextChars);
          meta = entry ? { at: entry.at, claimsBody: claimsBodyOf(raw) } : { invalid: true, claimsBody: false };
        } catch {
          continue;
        }
        metaCache.set(draftId, meta);
      }
      seen.add(draftId);
      if (!meta.invalid) out.push({ draftId, at: meta.at });
    }
    for (const key of Array.from(metaCache.keys())) {
      if (!seen.has(key)) metaCache.delete(key); // 文件已被手工删掉：缓存跟着清
    }
    out.sort(compareByAtNewestFirst);
    return out;
  }

  // 删一份草稿：元数据 + 正文一起删（哪一份删不掉都不抛；以元数据是否删掉作为 removed 判定）。
  async function unlinkDraft(draftId) {
    metaCache.delete(draftId);
    let removed = false;
    try {
      await io.unlink(draftPath(draftId));
      removed = true;
    } catch {
      removed = false;
    }
    try {
      await io.unlink(draftBodyPath(draftId));
    } catch {
      /* 正文已经不在了 / 删不掉：下一次 prune 的孤儿清理会再试 */
    }
    return removed;
  }

  // P2：删元数据失败时留下的「孤儿正文」清理。只删**同 id 的元数据文件都不存在**的 .txt ——
  // 坏 JSON 的元数据仍占着文件名，它的正文照旧保留（坏文件一律不删的模块红线）。
  // #11（清单）补两处相邻缺口：
  //   ① v1 元数据把正文写在 JSON 的 text 里，同名的 .txt 是「升级写了半套」的残留（正文已 rename、
  //      元数据还没写就崩了）。以前只按「有没有同名元数据」判孤儿，这类正文永远不会被读、也不会被收；
  //   ② writeAtomic 崩在 rename 前留下的 `.draft-<id>.json.tmp-*` / `.txt.tmp-*` 不在清扫范围。
  // 这两类都要求「文件已经放了 ORPHAN_GRACE_MS 没人动」：另一扇窗口的正文 rename 与元数据写之间只隔
  // 几毫秒，此刻不能把正在写的正文当孤儿删掉。
  async function sweepOrphanBodies() {
    let names = [];
    try {
      names = await io.readdir(dir);
    } catch {
      return 0;
    }
    const metaIds = new Set();
    for (const name of names) {
      const draftId = parseDraftFileName(name);
      if (draftId) metaIds.add(draftId);
    }
    const nowMs = normalizeDate(clock(), new Date()).getTime();
    let removed = 0;
    const unlinkQuiet = async (name) => {
      try {
        await io.unlink(path.join(dir, name));
        removed += 1;
      } catch {
        /* 下一轮再试 */
      }
    };
    const oldEnough = async (name) => {
      let stat = null;
      try {
        stat = await io.stat(path.join(dir, name));
      } catch {
        return false; // 读不到：下一轮再试（不猜）
      }
      const mtime = Number(stat && stat.mtimeMs);
      if (!Number.isFinite(mtime)) return false; // 没有时间戳：不删（保守）
      return nowMs - mtime >= ORPHAN_GRACE_MS;
    };
    for (const name of names) {
      const text = String(name);
      if (TMP_FILE_RE.test(text)) {
        if (await oldEnough(text)) await unlinkQuiet(text);
        continue;
      }
      const match = BODY_FILE_RE.exec(text);
      if (!match) continue;
      const draftId = match[1];
      if (metaIds.has(draftId)) {
        const cached = metaCache.get(draftId);
        // 缓存里没有条目（元数据还没被 scan / 本次运行没读过）或坏 JSON：不猜、不删（坏文件一律不删）。
        // 只有缓存明确记着「v1，不引用 .txt」才当孤儿候选，并且要过宽限期（另一窗口的升级写窗口）。
        if (!cached || cached.invalid || cached.claimsBody !== false) continue;
        if (!(await oldEnough(text))) continue;
      } else if (!(await oldEnough(text))) {
        // CRASH-01：没有同 id 元数据的正文同样是孤儿，但它也可能是另一扇窗口「正文已 rename、
        // 元数据还没写」的中间态（两步之间只隔几毫秒）。以前这一支直接删，恰好把另一窗口刚写好的
        // 正文吃掉（rename 已完成、json 还没落盘时执行 prune 的那一方会删掉它）。统一先过宽限期：
        // 只有放了 ORPHAN_GRACE_MS 还没人认领的正文才当孤儿回收；.tmp-* 仍走上面的现逻辑。
        continue;
      }
      await unlinkQuiet(text);
    }
    return removed;
  }

  // 只留最近 maxDrafts 份；beginSession 时顺带清 >7 天的过期草稿。
  // entries 可传入已扫描 / 已缓存元数据的列表（写路径走 metaEntries，不再全量读回正文）；
  // 不传则退回一次完整 scan。返回被删掉的 draftId 数组（beginSession 据此过滤列表）。
  async function prune({ nowMs = null, entries = null } = {}) {
    const list = Array.isArray(entries) ? entries.slice().sort(compareByAtNewestFirst) : await scan();
    const remove = [];
    for (const entry of list) {
      if (nowMs != null && Number.isFinite(nowMs) && Date.parse(entry.at) < nowMs - staleMs) {
        remove.push(entry.draftId);
      }
    }
    const kept = list.filter((entry) => !remove.includes(entry.draftId));
    for (let index = maxDrafts; index < kept.length; index += 1) remove.push(kept[index].draftId);
    for (const draftId of remove) await unlinkDraft(draftId);
    // P2：顺带回收「元数据已没、正文还在」的孤儿 .txt（写入中途崩 / 删除半途失败留下的）。
    await sweepOrphanBodies();
    return remove;
  }

  // #5（待修清单）：按 draftId 读归属元数据（draftOwner / ownerFor 共用，不返回正文）。
  async function readOwnerMeta(draftId) {
    const id = parseDraftFileName(`${FILE_PREFIX}${draftId}.json`);
    if (!id || id !== String(draftId == null ? '' : draftId)) return null;
    try {
      const raw = JSON.parse(await io.readFile(draftPath(id), 'utf8'));
      if (!raw || typeof raw !== 'object') return null;
      return {
        draftId: id,
        ownerToken: normalizeOwnerToken(raw.ownerToken),
        ownerWindowId: normalizeOwnerWindowId(raw.ownerWindowId)
      };
    } catch {
      return null;
    }
  }

  return {
    dir,

    // 启动（或开关打开）时调用一次：读上次标记判断是否异常退出，再写本进程标记。
    // 标记写失败只回 { ok:false, code }，不抛；异常退出的草稿仍会列出来。
    async beginSession() {
      let abnormal = false;
      let previous = null;
      try {
        const raw = JSON.parse(await io.readFile(markerPath, 'utf8'));
        if (raw && typeof raw === 'object') {
          previous = {
            version: Number(raw.version) || 0,
            pid: Number(raw.pid) || 0,
            startedAt: String(raw.startedAt || '')
          };
          // CGRD-02：主判据是「标记还在」——干净退出必走 endSession 删标记，应用又带单实例锁
          //（抢锁失败的第二个实例在 whenReady 前就退出），所以标记能留到下次启动就说明上次没走完
          // 退出流程。旧实现用 `previous.pid !== pid` 判异常，Windows pid 复用（pid 空间小、复用常见）
          // 会让一次真崩溃漏报，界面整轮不弹恢复提示、草稿 7 天后被静默清掉。pid 仅作日志辅助。
          abnormal = true;
        } else {
          abnormal = true;
        }
      } catch (err) {
        if (!err || err.code !== 'ENOENT') abnormal = true;
      }
      try {
        await writeJsonAtomic(markerPath, {
          version: MARKER_VERSION,
          pid,
          startedAt: normalizeDate(clock(), new Date()).toISOString()
        });
      } catch (err) {
        return { ok: false, code: (err && err.code) || 'DRAFT_WRITE_FAILED', message: safeMessage(err), abnormal, previous };
      }
      let drafts = [];
      try {
        const entries = await scan();
        const removed = await prune({ nowMs: normalizeDate(clock(), new Date()).getTime(), entries });
        const gone = new Set(removed);
        drafts = entries.filter((entry) => !gone.has(entry.draftId)).map(publicDraft);
      } catch {
        drafts = [];
      }
      return { ok: true, abnormal, previous, drafts };
    },

    // 干净退出：删本进程标记 + **本进程 ownerToken 写的**草稿（只删自己命名的文件）。尽力而为，不抛。
    // CRASH-02（方案 a）：上次运行留下的草稿（ownerToken 不是本进程）一律保留——它可能是作者在
    // 恢复提示里选「先留着，下次再恢复」的那份，是那段未保存正文的唯一磁盘兜底。旧实现无条件
    // 删全部草稿，等于把「先留着」变成「退出即丢」。标记照旧删除（干净退出的判据）。
    async endSession() {
      let cleared = 0;
      const entries = await scan();
      for (const entry of entries) {
        if (entry.ownerToken !== ownerToken) continue;
        if (await unlinkDraft(entry.draftId)) cleared += 1;
      }
      let markerCleared = false;
      try {
        await io.unlink(markerPath);
        markerCleared = true;
      } catch {
        /* 标记删不掉（被占用 / 没权限）不影响退出；下次启动最多多一次「异常退出」判定 */
      }
      return { ok: true, cleared, markerCleared };
    },

    async writeDraft(raw, options = {}) {
      const clean = sanitizeDraftInput(raw, { maxTextChars, now: clock });
      if (!clean.ok) return clean;
      const entry = clean.entry;
      const draftId = draftIdFor(entry.bookPath, entry.chapterId);
      // S2：归属只由主进程注入（渲染层传进来的 payload 里就算带 ownerWindowId 也不采信）。
      const ownerToken = normalizeOwnerToken(options && options.ownerToken);
      const ownerWindowId = normalizeOwnerWindowId(options && options.ownerWindowId);
      // P2：正文进 .txt、元数据进 .json，两步都是「临时文件 → rename」的原子写；字数在 sanitize 里
      // 只算一次（旧实现 writeDraft 里算了三遍：拒稿判定 / 元数据 / 回包）。
      try {
        await writeAtomic(draftBodyPath(draftId), entry.text);
      } catch (err) {
        return { ok: false, code: (err && err.code) || 'DRAFT_WRITE_FAILED', message: safeMessage(err) };
      }
      try {
        await writeJsonAtomic(draftPath(draftId), {
          version: DRAFT_VERSION,
          draftId,
          bookPath: entry.bookPath,
          bookTitle: entry.bookTitle,
          chapterId: entry.chapterId,
          chapterTitle: entry.chapterTitle,
          chapterName: entry.chapterName,
          chapterIndex: entry.chapterIndex,
          at: entry.at,
          chars: entry.chars,
          ownerToken,
          ownerWindowId,
          body: `${FILE_PREFIX}${draftId}${BODY_SUFFIX}`
        });
      } catch (err) {
        // 元数据写失败：正文可能是刚写进去的新版本（同名覆盖），旧元数据仍指向它 —— 列表会显示旧
        // 字数 / 旧时间戳，但 readDraft 以正文实际内容为准，不丢字。若是全新草稿，顺手把这份孤儿正文删掉。
        try {
          const hadMeta = await io.stat(draftPath(draftId));
          if (!hadMeta) await io.unlink(draftBodyPath(draftId));
        } catch {
          /* 清理失败不影响回包；下一次 prune 的孤儿清理会再试 */
        }
        return { ok: false, code: (err && err.code) || 'DRAFT_WRITE_FAILED', message: safeMessage(err) };
      }
      // CGRD-01：写入前先登记元数据，prune 只需 readdir + 缓存，不再把所有草稿正文读回解析。
      metaCache.set(draftId, { at: entry.at, claimsBody: true });
      try {
        // N-14：prune 的「现在」用 store 自己的时钟，不再用这份草稿自报的 at
        // （否则一个未来时间戳就会把其它窗口 / 上次运行的草稿全判过期删掉）。
        await prune({ nowMs: normalizeDate(clock(), new Date()).getTime(), entries: await metaEntries() });
      } catch {
        /* 清理失败不影响这一份草稿 */
      }
      return { ok: true, draftId, chars: entry.chars };
    },

    // S2（一轮）：按查看者过滤的列表。不传 viewer = 全部（测试 / 诊断 / info 用）。
    async listDrafts(viewer = null) {
      const entries = await scan();
      if (!viewer) return entries.map(publicDraft);
      return entries.map(publicDraft).filter((draft) => draftVisibleTo(draft, viewer));
    },

    // S2：只读归属元数据（校验 foreign 用），不返回正文；不存在 / 坏文件回 null。
    async draftOwner(draftId) {
      return readOwnerMeta(draftId);
    },

    // #5：按「书 + 章」查归属元数据 —— discard 的 { bookPath, chapterId } 分支删除前要校验归属，
    // 以前那条分支不看 owner，任何窗口都能删掉别的窗口写的草稿位。目标不合法 / 草稿不存在回 null。
    async ownerFor(target) {
      if (!target || typeof target !== 'object') return null;
      if (typeof target.bookPath !== 'string' || !target.bookPath.trim()) return null;
      if (typeof target.chapterId !== 'string' || !target.chapterId.trim()) return null;
      return readOwnerMeta(draftIdFor(target.bookPath, target.chapterId));
    },

    async readDraft(draftId) {
      const id = parseDraftFileName(`${FILE_PREFIX}${draftId}.json`);
      if (!id || id !== String(draftId == null ? '' : draftId)) {
        return { ok: false, code: 'DRAFT_MISSING', message: '草稿不在了（可能已被恢复或丢弃）' };
      }
      try {
        const raw = JSON.parse(await io.readFile(draftPath(id), 'utf8'));
        const entry = storedEntryFrom(raw, id, maxTextChars);
        if (!entry) return { ok: false, code: 'DRAFT_MISSING', message: '草稿内容不完整（已跳过）' };
        // v1 旧文件正文在 JSON 里；v2 读独立的 .txt（正文文件超 32MB 或超字数上限都当读不出来，
        // 绝不把半截 / 超限正文塞回编辑区）。
        let text = entry.text;
        if (!text && entry.body) {
          const bodyPath = draftBodyPath(id);
          const stat = await io.stat(bodyPath);
          if (!stat || (typeof stat.isFile === 'function' && !stat.isFile())) {
            return { ok: false, code: 'DRAFT_MISSING', message: '草稿正文不在了（可能已被恢复或丢弃）' };
          }
          if (Number.isFinite(Number(stat.size)) && Number(stat.size) > MAX_STORED_BYTES) {
            return { ok: false, code: 'DRAFT_UNREADABLE', message: '草稿正文太大，读不出来' };
          }
          text = await io.readFile(bodyPath, 'utf8');
          if (!text || codePointLength(text) > maxTextChars) {
            return { ok: false, code: 'DRAFT_UNREADABLE', message: '草稿正文不完整（已跳过）' };
          }
        }
        if (!text) return { ok: false, code: 'DRAFT_MISSING', message: '草稿内容不完整（已跳过）' };
        // 字数以正文实际码点为准（元数据只是扫描用的缓存，极端情况下可能慢一个快照）。
        return { ok: true, draft: { ...publicDraft(entry), chars: codePointLength(text), text } };
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          return { ok: false, code: 'DRAFT_MISSING', message: '草稿不在了（可能已被恢复或丢弃）' };
        }
        return { ok: false, code: 'DRAFT_UNREADABLE', message: '草稿读不出来（可能正被占用）' };
      }
    },

    async removeDraft(draftId) {
      const id = parseDraftFileName(`${FILE_PREFIX}${draftId}.json`);
      if (!id || id !== String(draftId == null ? '' : draftId)) return { ok: true, removed: 0 };
      return { ok: true, removed: (await unlinkDraft(id)) ? 1 : 0 };
    },

    async removeFor(target) {
      if (!target || typeof target !== 'object') return { ok: true, removed: 0 };
      if (typeof target.bookPath !== 'string' || !target.bookPath.trim()) return { ok: true, removed: 0 };
      if (typeof target.chapterId !== 'string' || !target.chapterId.trim()) return { ok: true, removed: 0 };
      const draftId = draftIdFor(target.bookPath, target.chapterId);
      return { ok: true, removed: (await unlinkDraft(draftId)) ? 1 : 0 };
    },

    async removeAll() {
      const entries = await scan();
      let removed = 0;
      for (const entry of entries) {
        if (await unlinkDraft(entry.draftId)) removed += 1;
      }
      return { ok: true, removed };
    },

    async info() {
      const entries = await scan();
      return {
        ok: true,
        dir,
        count: entries.length,
        chars: entries.reduce((sum, entry) => sum + entry.chars, 0)
      };
    }
  };
}

module.exports = {
  DRAFT_DIR_NAME,
  SESSION_FILE_NAME,
  FILE_PREFIX,
  MAX_DRAFTS,
  MAX_TEXT_CHARS,
  MAX_TITLE_CHARS,
  MAX_PATH_CHARS,
  draftVisibleTo,
  createCrashDraftStore
};