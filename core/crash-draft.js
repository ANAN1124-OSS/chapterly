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
//   crash-drafts/draft-<16位sha256>.json 一份草稿（书 + 章固定一个草稿位）
//
// 本模块不 require electron；单测直接 require + 真临时目录（可注入 fs / now / pid）。
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const pathUtils = require('./path-utils');

const DRAFT_DIR_NAME = 'crash-drafts';
const SESSION_FILE_NAME = 'session.json';
const FILE_PREFIX = 'draft-';
const DRAFT_FILE_RE = /^draft-([a-f0-9]{16})\.json$/;
const MARKER_VERSION = 1;
const DRAFT_VERSION = 1;
const MAX_DRAFTS = 8;
// 与 core/ipc-limits.js 的正文上限同一口径（500 万字）：单章最大就是这么大，草稿不另立小上限。
const MAX_TEXT_CHARS = 5000000;
const MAX_TITLE_CHARS = 200;
const MAX_PATH_CHARS = 1024;
const MAX_CHAPTER_ID_CHARS = 200;
// 草稿最多 5M 字，JSON 转义后约 10–20MB；超过 32MB 的文件不读（别让目录里的大文件把启动拖炸）。
const MAX_STORED_BYTES = 32 * 1024 * 1024;
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

function safeMessage(err) {
  const text = err && typeof err.message === 'string' ? err.message : '';
  return Array.from(text).slice(0, 200).join('');
}

function codePointLength(text) {
  return typeof text === 'string' ? Array.from(text).length : 0;
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

function draftIdFor(bookPath, chapterId) {
  // 「同一本书 / 同一章」的路径归一口径与 main.js / config-gate 同源（core/path-utils.js 的 pathKey），
  // 大小写 / 斜杠写法不同仍落到同一个草稿位；本模块不再手写第二份。
  const key = `${pathUtils.pathKey(bookPath)}\n${String(chapterId == null ? '' : chapterId)}`;
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
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
      at: isoAt(raw.at, clock)
    }
  };
}

// 从磁盘读回的一条草稿：坏形状 / 缺字段 / 正文超上限一律当不存在（跳过），不删文件。
function storedEntryFrom(raw, draftId, maxTextChars) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.bookPath !== 'string' || !raw.bookPath.trim()) return null;
  if (typeof raw.chapterId !== 'string' || !raw.chapterId.trim()) return null;
  if (typeof raw.text !== 'string' || !raw.text.length) return null;
  if (codePointLength(raw.text) > maxTextChars) return null;
  return {
    draftId,
    bookPath: raw.bookPath,
    bookTitle: clipText(raw.bookTitle, MAX_TITLE_CHARS),
    chapterId: raw.chapterId,
    chapterTitle: clipText(raw.chapterTitle, MAX_TITLE_CHARS),
    chapterName: clipText(raw.chapterName, MAX_TITLE_CHARS),
    chapterIndex: normalizeChapterIndex(raw.chapterIndex),
    at: isoAt(raw.at, () => new Date(0)),
    chars: codePointLength(raw.text),
    text: raw.text
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
    chars: entry.chars
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
  const metaCache = new Map(); // draftId -> { at } | { invalid: true }

  function draftPath(draftId) {
    return path.join(dir, `${FILE_PREFIX}${draftId}.json`);
  }

  // 原子写：临时文件 → rename；失败删临时文件并抛给调用方（调用方再转成 { ok:false }）。
  async function writeJsonAtomic(file, payload) {
    await io.mkdir(path.dirname(file), { recursive: true });
    const tmp = path.join(
      path.dirname(file),
      `.${path.basename(file)}.tmp-${pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    try {
      await io.writeFile(tmp, `${JSON.stringify(payload)}\n`, 'utf8');
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

  // 扫目录里的草稿（只认 draft-<16位hash>.json；坏 JSON / 缺字段 / 超大文件跳过，不删）。
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
        if (Number.isFinite(Number(stat.size)) && Number(stat.size) > MAX_STORED_BYTES) continue;
        const raw = JSON.parse(await io.readFile(file, 'utf8'));
        const entry = storedEntryFrom(raw, draftId, maxTextChars);
        if (entry) {
          entries.push(entry);
          metaCache.set(draftId, { at: entry.at });
        } else {
          // 形状稳定地不合法（不是读到一半）：记成 invalid，后续 prune 不必再读它，也不删它。
          metaCache.set(draftId, { invalid: true });
        }
      } catch {
        /* 正在被写 / 坏 JSON / 读不到：当这次没有这一条 */
      }
    }
    entries.sort(compareByAtNewestFirst);
    return entries;
  }

  // 只取草稿的元数据（draftId + at），不解析正文 —— prune 的唯一数据来源。
  // 正常情况下全部命中 metaCache；缓存没有的文件才读一次（读不到 / 坏 JSON 跳过且不缓存）。
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
          meta = entry ? { at: entry.at } : { invalid: true };
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

  async function unlinkDraft(draftId) {
    try {
      await io.unlink(draftPath(draftId));
      metaCache.delete(draftId);
      return true;
    } catch {
      return false;
    }
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
    return remove;
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
        if (raw && typeof raw === 'object' && Number.isFinite(Number(raw.pid))) {
          previous = { version: Number(raw.version) || 0, pid: Number(raw.pid), startedAt: String(raw.startedAt || '') };
          abnormal = previous.pid !== pid;
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

    // 干净退出：删本进程标记 + 全部草稿（只删自己命名的文件）。尽力而为，不抛。
    async endSession() {
      let cleared = 0;
      const entries = await scan();
      for (const entry of entries) {
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

    async writeDraft(raw) {
      const clean = sanitizeDraftInput(raw, { maxTextChars, now: clock });
      if (!clean.ok) return clean;
      const entry = clean.entry;
      const draftId = draftIdFor(entry.bookPath, entry.chapterId);
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
          chars: codePointLength(entry.text),
          text: entry.text
        });
      } catch (err) {
        return { ok: false, code: (err && err.code) || 'DRAFT_WRITE_FAILED', message: safeMessage(err) };
      }
      // CGRD-01：写入前先登记元数据，prune 只需 readdir + 缓存，不再把所有草稿正文读回解析。
      metaCache.set(draftId, { at: entry.at });
      try {
        await prune({ nowMs: Date.parse(entry.at), entries: await metaEntries() });
      } catch {
        /* 清理失败不影响这一份草稿 */
      }
      return { ok: true, draftId, chars: codePointLength(entry.text) };
    },

    async listDrafts() {
      return (await scan()).map(publicDraft);
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
        return { ok: true, draft: { ...publicDraft(entry), text: entry.text } };
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
  createCrashDraftStore
};