/* 备份清理的进程内一次性「计划令牌」（WP4 / 审计 S-N1）—— 纯逻辑：不 require electron、不读盘、不联网。
 *
 * 为什么要有这一层：book:delete-history-backups 的 groupIds 完全由渲染层给。以前主进程按这个
 * 清单直接 fs.rm，注入 / bug 一次 IPC 就能把全书可清理备份清空。现在清理分两步：
 *   ① book:plan-delete-history-backups —— 主进程**自己**解析「哪些组真的可清理」（路径 / 可清理
 *      来源 / 本书 _trash 直接子目录 / 联接 / 保护列表都自己核一遍），并发一张一次性令牌；
 *   ② book:delete-history-backups —— 必须带令牌回来：存在 / 没过期 / 同一本书 / 组清单一致，
 *      四条全过才放行，成功立刻作废（一次性）。
 * 令牌只绑「书 + 组清单摘要 + 过期时间」，不绑文件内容 —— 执行阶段 storage 会重新解析一遍，
 * 目录在这一小段时间里换了内容，最多影响「清掉的是不是刚确认的那一份备份」，而备份本身是副本；
 * 真正的兜底是删除动作只走 shell.trashItem（可恢复），不在本模块。
 *
 * 契约：
 *   createStore({ ttlMs, maxEntries, now, randomUUID }) → {
 *     issue({ bookPath, groupIds }) → token 字符串（参数不合法回 ''，绝不发半张凭证）
 *     take(token, { bookPath, groupIds }) → { ok:true, record } | { ok:false, reason }
 *     release(record) → 是否放回成功（执行阶段整体失败时让作者原地重试）
 *     size(), clear(), ttlMs, maxEntries
 *   }
 *   reason ∈ unknown / expired / book-mismatch / plan-mismatch
 *   errorFor(reason) → code = DELETE_PLAN_INVALID 的 Error（界面按 message 提示）
 */

const crypto = require('node:crypto');
const pathUtils = require('./path-utils');

// 2 分钟：足够作者看完确认框再点「移入回收站」，又不至于让一张旧令牌在半小时后还能用。
const DEFAULT_TTL_MS = 2 * 60 * 1000;
// 上限只为长跑不无限涨：正常一本书不会同时有 100 张待确认的清理计划。
const DEFAULT_MAX_ENTRIES = 100;
// UUID 是 36 字符；留余量给别的随机源，超过这个长度的一律当伪造，不查表。
const MAX_TOKEN_CHARS = 64;
const MAX_PATH_CHARS = 4096;
// 与 core/storage.js deleteHistoryBackups 的 5000 条上限同口径；单条组 id 的合理上限 300 字符
// （`dir:` + 备份目录名，最长的是「还原前备份-YYYY-MM-DD-HHMMSS-nn」）。
const MAX_GROUP_IDS = 5000;
const MAX_GROUP_ID_CHARS = 300;

const REASON_MESSAGES = {
  unknown: '清理确认凭证无效，已取消（只认这一次计划）',
  expired: '清理确认凭证已过期，已取消（请重新确认一次）',
  'book-mismatch': '清理确认凭证不属于这本书，已取消',
  'plan-mismatch': '清理确认凭证与这次要清理的备份对不上，已取消'
};

class DeletePlanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DeletePlanError';
    this.code = code;
  }
}

function errorFor(reason) {
  return new DeletePlanError(
    'DELETE_PLAN_INVALID',
    REASON_MESSAGES[reason] || REASON_MESSAGES.unknown
  );
}

function isBoundedText(value, max) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max;
}

// groupIds 归一：只收字符串、trim、去重、排序（顺序无关），并卡上限。
// 任何一条不合法都整张拒绝（绝不「过滤掉坏的那条」再发令牌 —— 那样清单已经不是你确认过的那份）。
function normalizeGroupIds(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_GROUP_IDS) return null;
  const ids = new Set();
  for (const raw of input) {
    if (typeof raw !== 'string') return null;
    const id = raw.trim();
    if (!id || id.length > MAX_GROUP_ID_CHARS) return null;
    ids.add(id);
  }
  return ids.size ? [...ids].sort() : null;
}

function digestOf(ids) {
  return crypto.createHash('sha256').update(ids.join('\n'), 'utf8').digest('hex');
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
  // 同一份 record 只能放回一次（防止一张凭证被复制成两张）。
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
    const ids = normalizeGroupIds(data.groupIds);
    if (!ids) return '';
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
      digest: digestOf(ids),
      count: ids.length,
      expiresAt: at + ttlMs
    });
    evictOverflow();
    return token;
  }

  // 校验并**立刻作废**：成功的令牌只能换一次执行。
  // 书 / 清单对不上时只拒绝、不删除 —— 伪造者不能把作者手里真令牌耗掉。
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
    // 判「同一本书」走 core/path-utils 的 pathKey（resolve + 小写 + Windows 正反斜杠归一），
    // 与 config-gate / open-books / 撤销凭证同一口径：大小写 / 斜杠写法不同不该误拒。
    if (!bookPath || pathUtils.pathKey(record.bookPath) !== pathUtils.pathKey(bookPath)) {
      return { ok: false, reason: 'book-mismatch' };
    }
    const ids = normalizeGroupIds(expected.groupIds);
    if (!ids || digestOf(ids) !== record.digest) return { ok: false, reason: 'plan-mismatch' };
    entries.delete(raw);
    prune(at);
    return { ok: true, record: { ...record } };
  }

  // 执行阶段整体失败（回收站暂时不可用 / 书被别的窗口占住）时把令牌放回去，作者可以原地再点一次。
  function release(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    if (releasedRecords.has(record)) return false;
    const at = clock();
    if (!isBoundedText(record.token, MAX_TOKEN_CHARS)) return false;
    if (!isBoundedText(record.bookPath, MAX_PATH_CHARS)) return false;
    if (typeof record.digest !== 'string' || record.digest.length !== 64) return false;
    if (!Number.isInteger(record.count) || record.count <= 0 || record.count > MAX_GROUP_IDS) return false;
    if (!Number.isFinite(record.expiresAt) || record.expiresAt <= at) return false;
    if (entries.has(record.token)) return false;
    prune(at);
    if (entries.size >= maxEntries) return false;
    entries.set(record.token, {
      token: record.token,
      bookPath: record.bookPath,
      digest: record.digest,
      count: record.count,
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