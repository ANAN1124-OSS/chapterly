// 「打开中的书」登记（多窗口唯一事实来源）与跨窗口操作判定。
//
// 设计约定：
// - 一个窗口同一时间只开一本书；一个书路径同一时间只允许一个窗口打开。
// - 路径比较统一 path.resolve + 小写（Windows 不区分大小写，同一个目录可能被写成不同形式）。
//   实现在 core/path-utils.js，与书架搜索共用同一份 —— 两边判「同一本书」的口径必须一致。
// - 这里只做纯内存逻辑，不碰磁盘、不 require electron，单测直接覆盖。
// - 主进程通过 storage 里的同一个 registry 实例登记 / 释放，写盘前再由这里判定。
const path = require('node:path');
// 路径归一只有一份实现（core/path-utils.js）：书架搜索判「同一本书」用的是同一个口径
const { normalizePath } = require('./path-utils');

const CODE = {
  BOOK_OPEN_IN_OTHER_WINDOW: 'BOOK_OPEN_IN_OTHER_WINDOW',
  CROSS_WINDOW_BUSY: 'CROSS_WINDOW_BUSY',
  BOOK_MISSING: 'BOOK_MISSING',
  CHAPTER_MISSING: 'CHAPTER_MISSING',
  CHAPTER_NOT_FOUND: 'CHAPTER_NOT_FOUND',
  // 审计修复 #5（V301）：保存前校验发现「载入之后磁盘上这一章被应用外的程序改过」。
  EXTERNAL_CHANGE: 'EXTERNAL_CHANGE'
};

const KIND_LABEL = {
  save: '保存',
  delete: '删除',
  rename: '改名',
  format: '整理',
  replace: '替换',
  write: '修改'
};

// 旧名字继续对外导出（main.js / 单测按这个名字取），实现就是 core/path-utils.js 那一份。
const normalizeBookPath = normalizePath;

// 书名在提示 / 诊断里的统一口径。T-20（三审）：文件夹名上限 40 字，超长书名整名内嵌错误文案时，
// 会被 core/logs.js 的「≥24 连续汉字 = 疑似正文」遮罩整段换成 [正文已隐藏 N 字]，日志里的诊断
// （哪本书、什么错误）直接报废。这里超长一律首尾截断（中间一个 '…'），任何一段都不到遮罩阈值；
// 正常长度（≤24 字）的书名一字不改，界面提示也不受影响。
const LABEL_MAX_CHARS = 24;
const LABEL_HEAD_CHARS = 14;
const LABEL_TAIL_CHARS = 8;

function bookLabel(bookPath) {
  const raw = String(bookPath == null ? '' : bookPath).trim();
  if (!raw) return '这本书';
  let base = '';
  try {
    base = path.basename(raw);
  } catch {
    base = raw;
  }
  if (!base) base = raw;
  // 按码点截断：扩展 B 的汉字在 UTF-16 里占两个码元，不能按 length 切。
  const chars = Array.from(base);
  if (chars.length <= LABEL_MAX_CHARS) return base;
  return `${chars.slice(0, LABEL_HEAD_CHARS).join('')}…${chars.slice(-LABEL_TAIL_CHARS).join('')}`;
}

function crossWindowMessage(bookPath, action = 'write') {
  const label = bookLabel(bookPath);
  const verb = KIND_LABEL[action] || KIND_LABEL.write;
  return `「${label}」正在另一个窗口打开，已阻止这次${verb}。请先关掉另一个窗口，或先切换到那个窗口后再操作。`;
}

function openInOtherWindowMessage(bookPath) {
  return `「${bookLabel(bookPath)}」已经在另一个窗口打开，已切换到那个窗口。`;
}

// windowId → bookPath 的唯一登记表。窗口本身也登记（没有开书也要能选「最近使用的窗口」）。
class OpenBookRegistry {
  constructor() {
    this.byWindow = new Map(); // windowId(string) -> normalized bookPath
    this.byBook = new Map(); // normalized bookPath -> windowId(string)
    this.windows = new Map(); // windowId(string) -> { lastActiveAt, seq }
    this.seq = 0;
  }

  static id(windowId) {
    return String(windowId);
  }

  registerWindow(windowId, { now = Date.now() } = {}) {
    const id = OpenBookRegistry.id(windowId);
    if (!id || id === 'null' || id === 'undefined') return null;
    if (!this.windows.has(id)) this.windows.set(id, { lastActiveAt: 0, seq: 0 });
    this.touch(windowId, { now });
    return id;
  }

  unregisterWindow(windowId) {
    const id = OpenBookRegistry.id(windowId);
    const book = this.byWindow.get(id);
    const hadWindow = this.windows.has(id);
    if (book) this.byBook.delete(book);
    this.byWindow.delete(id);
    this.windows.delete(id);
    return Boolean(book || hadWindow);
  }

  // 窗口开 / 换书。返回 { ok, code, ownerWindowId, bookPath }；重复打开由调用方决定是否聚焦。
  setBook(windowId, bookPath, { now = Date.now() } = {}) {
    const id = OpenBookRegistry.id(windowId);
    const key = normalizeBookPath(bookPath);
    if (!id || !key) return { ok: false, code: 'BAD_PATH', bookPath: key };
    const owner = this.byBook.get(key);
    if (owner && owner !== id) {
      return {
        ok: false,
        code: CODE.BOOK_OPEN_IN_OTHER_WINDOW,
        ownerWindowId: owner,
        bookPath: key,
        message: openInOtherWindowMessage(bookPath)
      };
    }
    const previous = this.byWindow.get(id);
    if (previous) this.byBook.delete(previous);
    this.byWindow.set(id, key);
    this.byBook.set(key, id);
    if (!this.windows.has(id)) this.windows.set(id, { lastActiveAt: 0, seq: 0 });
    this.touch(windowId, { now });
    return { ok: true, windowId: id, bookPath: key };
  }

  clearBook(windowId) {
    const id = OpenBookRegistry.id(windowId);
    const book = this.byWindow.get(id);
    if (!book) return false;
    this.byWindow.delete(id);
    this.byBook.delete(book);
    return true;
  }

  // 书被删除 / 被移走时，把所有窗口对它的登记清掉（正常只有一个）
  clearPath(bookPath) {
    const key = normalizeBookPath(bookPath);
    const owner = this.byBook.get(key);
    if (!owner) return false;
    this.byBook.delete(key);
    if (this.byWindow.get(owner) === key) this.byWindow.delete(owner);
    return true;
  }

  getBook(windowId) {
    return this.byWindow.get(OpenBookRegistry.id(windowId)) || null;
  }

  findWindow(bookPath) {
    return this.byBook.get(normalizeBookPath(bookPath)) || null;
  }

  isOpenElsewhere(bookPath, windowId) {
    const owner = this.findWindow(bookPath);
    const id = OpenBookRegistry.id(windowId);
    return { open: Boolean(owner && owner !== id), ownerWindowId: owner || null };
  }

  touch(windowId, { now = Date.now() } = {}) {
    const id = OpenBookRegistry.id(windowId);
    if (!id) return;
    this.seq += 1;
    this.windows.set(id, { lastActiveAt: now, seq: this.seq });
  }

  // 「最近使用的窗口」：先比最近一次激活时间，同一毫秒内再比登记顺序（后动者为最近）
  mostRecentWindow() {
    let best = null;
    for (const [id, info] of this.windows) {
      if (!best || info.lastActiveAt > best.lastActiveAt ||
          (info.lastActiveAt === best.lastActiveAt && info.seq > best.seq)) {
        best = { windowId: id, lastActiveAt: info.lastActiveAt, seq: info.seq };
      }
    }
    return best ? best.windowId : null;
  }

  list() {
    return Array.from(this.byWindow, ([windowId, bookPath]) => ({ windowId, bookPath }));
  }

  counts() {
    return { windows: this.windows.size, openBooks: this.byBook.size };
  }

  reset() {
    this.byWindow.clear();
    this.byBook.clear();
    this.windows.clear();
    this.seq = 0;
  }
}

function createRegistry() {
  return new OpenBookRegistry();
}

// 同一本书不允许两个窗口：已经开在别的窗口就拒绝并告诉调用方去聚焦哪个窗口。
function checkOpenBook({ registry, windowId, bookPath }) {
  const result = registry.setBook(windowId, bookPath);
  if (!result.ok && result.code === CODE.BOOK_OPEN_IN_OTHER_WINDOW) {
    return {
      ...result,
      message: openInOtherWindowMessage(bookPath)
    };
  }
  return result;
}

// 跨窗口删改拦截：别窗口正开着的书一律不许写（删除 / 改名 / 整理 / 替换 / 保存…）。
// 自己窗口开着这本书时允许（正常写作）；没有登记也允许（比如自动化直接调 API）。
function checkMutation({ registry, windowId, bookPath, action = 'write' }) {
  const owner = registry.findWindow(bookPath);
  const self = windowId == null || windowId === '' ? null : OpenBookRegistry.id(windowId);
  if (owner && owner !== self) {
    return {
      ok: false,
      code: CODE.CROSS_WINDOW_BUSY,
      ownerWindowId: owner,
      message: crossWindowMessage(bookPath, action)
    };
  }
  return { ok: true, ownerWindowId: owner || null };
}

// 保存前校验（纯函数，探针结果由 storage 提供）：
// 书文件夹在、书目能读、章节还在书目里、章节文件也在 → 才允许写盘。
// 任何一项失效都返回明确错误；调用方由此阻止 atomicWriteFile 的 mkdir 重建影子文件。
// 审计修复 #5（V301）：expectedMtimeMs（渲染层载入 / 上次保存拿到的 mtime）给了就必须与磁盘一致，
// 不一致 = 载入之后被应用外的程序（同步盘 / 记事本）改过 → EXTERNAL_CHANGE，绝不静默覆盖。
// 0 / null / 非数字一律视为「不校验」（覆盖保存与老调用方）。
// 审计修复 WP1（E-N2，中 #2）：mtime 对得上也还不够 —— rsync -t / robocopy /COPY:DAT / 部分同步盘
// 会保留时间戳改写正文。chapterFingerprint（磁盘现在那一版的内容指纹）与 expectedFingerprint
// （编辑器载入那一版）都给且不等 → 同样 EXTERNAL_CHANGE。缺任一指纹就回落「只比 mtime」的旧口径，
// 不新增误拦（指纹口径见 core/chapter-fingerprint.js）。
function verifySaveTarget({
  bookPath,
  bookExists,
  meta,
  metaCode,
  chapterId,
  file,
  chapterExists,
  chapterMtimeMs,
  expectedMtimeMs,
  chapterFingerprint,
  expectedFingerprint
}) {
  if (!bookExists) {
    return {
      ok: false,
      code: CODE.BOOK_MISSING,
      message: `「${bookLabel(bookPath)}」的书文件夹已经不在了（可能已在另一个窗口或应用外删除）。为避免重新生成影子文件，已阻止这次保存。`
    };
  }
  if (!meta) {
    const code = metaCode === 'PARSE_ERROR' ? 'PARSE_ERROR' : CODE.BOOK_MISSING;
    return {
      ok: false,
      code,
      message:
        code === 'PARSE_ERROR'
          ? '书目.json 解析失败，已阻止保存。请先用「修复这本书」处理书目。'
          : `「${bookLabel(bookPath)}」的书目已经不在了（可能已在另一个窗口或应用外删除）。为避免重新生成影子文件，已阻止这次保存。`
    };
  }
  const chapters = Array.isArray(meta.chapters) ? meta.chapters : [];
  const index = chapters.findIndex((chapter) => chapter && chapter.id === chapterId);
  if (index < 0) {
    return {
      ok: false,
      code: CODE.CHAPTER_NOT_FOUND,
      message: '这一章已经不在书目里了（可能已在另一个窗口删除）。为避免重新生成影子文件，已阻止这次保存。'
    };
  }
  const chapter = chapters[index];
  if (file && chapter.file !== file) {
    return {
      ok: false,
      code: CODE.CHAPTER_NOT_FOUND,
      message: '这一章的记录已经变了（可能已在另一个窗口改名或重建）。为避免写错文件，已阻止这次保存。'
    };
  }
  if (!chapterExists) {
    return {
      ok: false,
      code: CODE.CHAPTER_MISSING,
      message: '这一章的正文文件已经不在了（可能已在另一个窗口或应用外删除）。为避免重新生成影子文件，已阻止这次保存。'
    };
  }
  // 审计修复 #5（V301）：文件还在，但已经不是载入时那一版了 —— 外部改动被静默覆盖的丢稿路径。
  // 只在调用方带了正的 expectedMtimeMs 时才比（覆盖保存传 0 表示作者已明确选择覆盖）。
  const expected = Number(expectedMtimeMs);
  const actual = Number(chapterMtimeMs);
  if (Number.isFinite(expected) && expected > 0 && Number.isFinite(actual) && actual !== expected) {
    return {
      ok: false,
      code: CODE.EXTERNAL_CHANGE,
      message: `「${bookLabel(bookPath)}」的这一章在载入之后被应用外的程序改过（可能是同步盘或记事本）。为避免覆盖外部那一版正文，已阻止这次保存。`
    };
  }
  // 审计修复 WP1（E-N2）：mtime 一样不代表内容一样（时间戳被保留的改写）。两个指纹都有效才比，
  // 「读不到 / 没有基线」一律跳过 —— 宁可回落旧口径，不新增误拦。
  if (
    Number.isFinite(expected) &&
    expected > 0 &&
    Number.isFinite(actual) &&
    actual === expected
  ) {
    const wanted = typeof expectedFingerprint === 'string' ? expectedFingerprint : '';
    const seen = typeof chapterFingerprint === 'string' ? chapterFingerprint : '';
    if (wanted && seen && wanted !== seen) {
      return {
        ok: false,
        code: CODE.EXTERNAL_CHANGE,
        message: `「${bookLabel(bookPath)}」的这一章在载入之后被应用外的程序改过（文件时间戳没变，但内容已经不是载入时那一版；可能是同步盘 / 保留了时间戳的外部改写）。为避免覆盖外部那一版正文，已阻止这次保存。`
      };
    }
  }
  return { ok: true, chapter, index };
}

// KNOWN-SINGLE（2026-11-26 复核）：第二个实例到达时，第一个窗口可能还在启动链里建（main.js 的
// whenReady 已开始、createWindow 尚未完成）。旧实现只看 mostRecentSession()，为 null 就再
// createWindow 一次 —— 一次双击开成两个窗口。这里给出唯一判据：有窗口就聚焦；启动建窗还在途就
// 忽略（那扇窗马上出来）；两者都没有才新建。
function secondInstanceAction(state) {
  const { hasSession = false, startupPending = false } = state || {};
  if (hasSession) return 'focus';
  if (startupPending) return 'ignore';
  return 'create';
}

module.exports = {
  CODE,
  createRegistry,
  normalizeBookPath,
  bookLabel,
  openInOtherWindowMessage,
  checkOpenBook,
  checkMutation,
  verifySaveTarget,
  secondInstanceAction
};
