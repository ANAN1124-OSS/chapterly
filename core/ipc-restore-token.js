/* 撤销删除的进程内凭证（1.5.0 P0-5 / 1.4.0 审计 V-1）—— 纯逻辑：不 require electron、不读盘、不联网。
 *
 * 为什么要有这一层：chapter:delete 的撤销链路里，渲染层只要把 `trashName` 交回去，
 * 主进程就按「basename + .txt + 本书 _trash + 与章节文件名对得上」四道自证把它放回书里。
 * 这四道能挡住目录穿越，却挡不住「这个 trashName 是不是本次删除产生的」—— 只要作者手动往
 * _trash 里放一个同名的 txt，或渲染层拼错名字，就能凭一个字符串把别的备份「撤销」成当前章。
 *
 * 做法：删除成功时主进程发一张一次性凭证（随机 UUID），只在进程内存里记
 *   { bookPath, trashName, chapterId, expiresAt }
 * 撤销时必须带着这张凭证回来，四条都要对得上才放行：存在、没过期、同一本书、同一个 trashName；
 * 校验通过立刻**作废**（一次性），重复使用直接拒绝。凭证 10 分钟过期（长于撤销条的 10 秒，
 * 也长于作者「先看一眼再撤」的停顿），Map 有上限，超了丢最早过期的，防止长跑内存增长。
 *
 * 撤销失败（storage 报错）时主进程可以把凭证 `release` 回去，作者还能再点一次 ——
 * 「一次性」指的是成功用掉，不是「碰一下就没」。release 只在还没过期、且没有同 token 时生效。
 *
 * 契约：
 *   createStore({ ttlMs, maxEntries, now, randomUUID }) → {
 *     issue({ bookPath, trashName, chapterId }) → token 字符串（参数不合法回 ''，绝不发半张凭证）
 *     take(token, { bookPath, trashName })      → { ok:true, record } | { ok:false, reason }
 *     release(record)                           → 是否放回成功
 *     size(), clear(), ttlMs, maxEntries
 *   }
 *   reason ∈ unknown / expired / book-mismatch / trash-mismatch；
 *   errorFor(reason) → 带 code = RESTORE_TOKEN_INVALID 与中文文案的 Error（界面按 message 提示）。
 */

const crypto = require('node:crypto');

// 与作业卡 P0-5 一致：10 分钟过期，长于撤销条的 10 秒 TTL。
const DEFAULT_TTL_MS = 10 * 60 * 1000;
// 上限只是为了长跑不无限涨：正常一本书连续删 500 次早就过了 10 分钟窗口。
const DEFAULT_MAX_ENTRIES = 500;
// UUID 是 36 字符；留一点余量给别的随机源，超过这个长度的一律当伪造，不查表。
const MAX_TOKEN_CHARS = 64;
const MAX_PATH_CHARS = 4096;
const MAX_TRASH_NAME_CHARS = 260;

const REASON_MESSAGES = {
  unknown: '撤销凭证无效，已取消（只认这一次删除）',
  expired: '撤销凭证已过期，已取消（删除超过 10 分钟）',
  'book-mismatch': '撤销凭证不属于这本书，已取消',
  'trash-mismatch': '撤销凭证与这次删除对不上，已取消'
};

class RestoreTokenError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RestoreTokenError';
    this.code = code;
  }
}

function errorFor(reason) {
  return new RestoreTokenError(
    'RESTORE_TOKEN_INVALID',
    REASON_MESSAGES[reason] || REASON_MESSAGES.unknown
  );
}

function isBoundedText(value, max) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max;
}

function createStore(options = {}) {
  const source = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const ttlMs =
    Number.isFinite(source.ttlMs) && source.ttlMs > 0 ? Math.floor(source.ttlMs) : DEFAULT_TTL_MS;
  const maxEntries =
    Number.isFinite(source.maxEntries) && source.maxEntries > 0
      ? Math.floor(source.maxEntries)
      : DEFAULT_MAX_ENTRIES;
  const now = typeof source.now === 'function' ? source.now : Date.now;
  const randomUUID =
    typeof source.randomUUID === 'function' ? source.randomUUID : () => crypto.randomUUID();

  const entries = new Map();
  // 同一份 record 只能放回一次：失败重试是「take → 失败 → release」，
  // 已经放回过的 record 对象不能再 release 一次（防止一份凭证被复制成两张）。
  const releasedRecords = new WeakSet();

  function clock() {
    const value = Number(now());
    return Number.isFinite(value) ? value : 0;
  }

  function prune(at) {
    for (const [token, record] of entries) {
      if (record.expiresAt <= at) entries.delete(token);
    }
  }

  function evictOverflow() {
    while (entries.size > maxEntries) {
      let oldestToken = '';
      let oldestAt = Infinity;
      for (const [token, record] of entries) {
        if (record.expiresAt < oldestAt) {
          oldestAt = record.expiresAt;
          oldestToken = token;
        }
      }
      if (!oldestToken) break;
      entries.delete(oldestToken);
    }
  }

  function issue(input) {
    const data = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    if (!isBoundedText(data.bookPath, MAX_PATH_CHARS)) return '';
    if (!isBoundedText(data.trashName, MAX_TRASH_NAME_CHARS)) return '';
    const at = clock();
    prune(at);
    let token = '';
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = String(randomUUID());
      if (isBoundedText(candidate, MAX_TOKEN_CHARS) && !entries.has(candidate)) {
        token = candidate;
        break;
      }
    }
    if (!token) return '';
    entries.set(token, {
      token,
      bookPath: data.bookPath,
      trashName: data.trashName,
      chapterId: typeof data.chapterId === 'string' ? data.chapterId : '',
      expiresAt: at + ttlMs
    });
    evictOverflow();
    return token;
  }

  // 校验并**立刻作废**：成功的凭证只能换回一次撤销。
  // 跨书 / trashName 对不上时只拒绝、不删除 —— 伪造者不能把作者手里真凭证耗掉。
  function take(token, match) {
    const at = clock();
    const expected = match && typeof match === 'object' && !Array.isArray(match) ? match : {};
    const raw = typeof token === 'string' ? token.trim() : '';
    if (!raw || raw.length > MAX_TOKEN_CHARS) {
      prune(at);
      return { ok: false, reason: 'unknown' };
    }
    const record = entries.get(raw);
    if (!record) {
      prune(at);
      return { ok: false, reason: 'unknown' };
    }
    if (record.expiresAt <= at) {
      entries.delete(raw);
      prune(at);
      return { ok: false, reason: 'expired' };
    }
    const bookPath = typeof expected.bookPath === 'string' ? expected.bookPath : '';
    if (record.bookPath !== bookPath) return { ok: false, reason: 'book-mismatch' };
    const trashName = typeof expected.trashName === 'string' ? expected.trashName : '';
    if (record.trashName !== trashName) return { ok: false, reason: 'trash-mismatch' };
    entries.delete(raw);
    prune(at);
    return { ok: true, record: { ...record } };
  }

  // 撤销失败时把刚作废的凭证放回去（作者可以原地再试）。
  function release(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    if (releasedRecords.has(record)) return false;
    const at = clock();
    if (!isBoundedText(record.token, MAX_TOKEN_CHARS)) return false;
    if (!isBoundedText(record.bookPath, MAX_PATH_CHARS)) return false;
    if (!isBoundedText(record.trashName, MAX_TRASH_NAME_CHARS)) return false;
    if (!Number.isFinite(record.expiresAt) || record.expiresAt <= at) return false;
    if (entries.has(record.token)) return false;
    prune(at);
    if (entries.size >= maxEntries) return false;
    entries.set(record.token, {
      token: record.token,
      bookPath: record.bookPath,
      trashName: record.trashName,
      chapterId: typeof record.chapterId === 'string' ? record.chapterId : '',
      expiresAt: record.expiresAt
    });
    releasedRecords.add(record);
    return true;
  }

  function size() {
    prune(clock());
    return entries.size;
  }

  function clear() {
    entries.clear();
  }

  return { issue, take, release, size, clear, ttlMs, maxEntries };
}

module.exports = {
  DEFAULT_TTL_MS,
  DEFAULT_MAX_ENTRIES,
  MAX_TOKEN_CHARS,
  REASON_MESSAGES,
  errorFor,
  createStore
};