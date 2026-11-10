/* 章节相关的纯逻辑：编号、标题、文件名净化、顺序增删、章节状态 / 备注、分卷。
 * 这里不碰磁盘，全部可单测。
 *
 * 同时被 Node（main.js / core/*、单测）和渲染层（index.html 里 <script>）使用，
 * 所以写成 UMD：Node 里 require 得到对象，浏览器里挂到 window.CWChapters。
 * 渲染层只通过 formatTitle() 取章节显示名，不再自己拼「第N章：」（v0.8.6 R3，代码审计 F6）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWChapters = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TITLE_TEMPLATE = '第{num}章：{name}';
  const MAX_NAME_LENGTH = 40;
  const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
  const EDGE_DOTS_SPACES = /^[.\s]+|[.\s]+$/g;
  // Windows 保留设备名（文件名主干）：CON / PRN / AUX / NUL / COM1-9 / LPT1-9。
  // 审计 B4（报告 #21 / N1、N2，勘误 E1、E2）：Node 在 Windows 走扩展长度路径语义，
  // 这些名字其实能落成普通文件 / 目录（实测 `nul.txt`、`CON` 目录都能建），所以这里
  // 不是防「假成功丢稿」，而是防「壳层 / 工具不认这种名字」（PowerShell Remove-Item
  // 对含 `nul` 的目录直接失败）。只匹配整个主干（第一个点之前），
  // 「CON 的故事」这类正常名不受影响。
  const RESERVED_STEMS = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
    ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)
  ]);
  // 章节状态：只记在 书目.json 里（可选字段），txt 一个字节都不动。
  // draft = 草稿（默认）/ revising = 待修 / done = 完稿
  const CHAPTER_STATUSES = ['draft', 'revising', 'done'];
  const CHAPTER_STATUS_LABELS = { draft: '草稿', revising: '待修', done: '完稿' };
  const DEFAULT_CHAPTER_STATUS = 'draft';
  const MAX_NOTE_LENGTH = 200;
  // 原文自带章节标题（导进来的书）分两类：
  //   1. 已经带号的（「第1章 …」「第一章 …」「Chapter N」）：原样保留，避免「第1章：第1章 …」叠号；
  //   2. 不带号的特殊标题（楔子 / 番外 / 大结局 / 前传 …）：2026-11-10 起补「第N章：」，不再整段原样返回。
  // 两条正则由同一份 source 派生，避免词表漂移；RAW_TITLE_RE 继续作为两者合集导出（旧调用 / 测试不断）。
  const NUMBERED_TITLE_SOURCE =
    '第\\s*[0-9零〇一二三四五六七八九十百千万两]+\\s*[章节回卷集篇部话幕]|Chapter\\s+\\d+';
  const SPECIAL_TITLE_SOURCE =
    '楔子|序章|序言|引子|前言|前传|外传|尾声|后记|番外|终章|大结局|附录|开篇';
  const NUMBERED_TITLE_RE = new RegExp(`^(?:${NUMBERED_TITLE_SOURCE})`, 'i');
  const SPECIAL_TITLE_RE = new RegExp(`^(?:${SPECIAL_TITLE_SOURCE})`, 'i');
  const RAW_TITLE_RE = new RegExp(`^(?:${NUMBERED_TITLE_SOURCE}|${SPECIAL_TITLE_SOURCE})`, 'i');

  function pad3(n) {
    return String(n).padStart(3, '0');
  }

  // 章号编号方式（2026-11-10）：全书连续（默认，旧书零迁移）/ 每卷从第 1 章重新编号。
  // 只影响「显示与导出用的章号」，不动章节顺序、文件名、正文一个字节。
  const CHAPTER_NUMBERING_MODES = ['continuous', 'volume'];
  const DEFAULT_CHAPTER_NUMBERING = 'continuous';

  function sanitizeChapterNumbering(value) {
    return value === 'volume' ? 'volume' : DEFAULT_CHAPTER_NUMBERING;
  }

  // 性能自检用的轻量计数（1.5.0 P0-2，scripts/bench-chapters.js 读它证明平方级消失）：
  // 只在本进程里累加，不写盘、不进书目；业务代码不读。
  const numberStats = { volumeKeyCalls: 0, tableBuilds: 0 };

  function resetChapterNumberStats() {
    numberStats.volumeKeyCalls = 0;
    numberStats.tableBuilds = 0;
  }

  function readChapterNumberStats() {
    return { volumeKeyCalls: numberStats.volumeKeyCalls, tableBuilds: numberStats.tableBuilds };
  }

  // 章属于哪一卷（空串 = 未分卷）。指向不存在卷的 id 按未分卷算，和 normalizeChapterOrder 同一口径。
  function chapterVolumeKey(meta, chapter) {
    numberStats.volumeKeyCalls += 1;
    const volumeId = chapter && typeof chapter.volumeId === 'string' ? chapter.volumeId : '';
    if (!volumeId) return '';
    const volumes = meta && Array.isArray(meta.volumes) ? meta.volumes : [];
    return volumes.some((volume) => volume && volume.id === volumeId) ? volumeId : '';
  }

  // 卷内章号表缓存（1.5.0 P0-2，审计 P1）：meta -> 每章「卷内第几章」数组。
  // 以前 volumeLocalNumber 每次从 0 数到 index（内部 chapterVolumeKey 是 volumes.some，O(V)），
  // 逐章合计 O(N²·V)：1000 章 / 20 卷重建一次目录约 24ms，命令面板每章还要再算 3 次。
  // 现在每份 meta 首次 O(N) 建表（卷 id 先收进 Set），之后 O(1)；缓存不写盘、不进 书目.json、
  // 不跨书（meta 换对象自然换缓存）。
  // 失效口径：
  //   - insertChapter / removeChapter / updateChapter / normalizeChapterOrder / moveVolume 都返回
  //     新 meta（WeakMap 键不同 = 自动失效），这里仍显式清一次旧键，防将来改成原地改；
  //   - applyChapterMeta / sanitizeVolumes 只收章节 / 卷数组、不碰 meta，调用方拿结果去建新 meta；
  //   - 就地改 meta 的调用方（storage.setChapterNumbering 改编号方式等）必须调
  //     invalidateChapterNumberCache(meta)。
  // 校验还兜住 chapters / volumes 换引用或变长度、编号模式切换，缓存脏了不会被误读。
  const chapterNumberCache = new WeakMap();

  function invalidateChapterNumberCache(meta) {
    if (meta && typeof meta === 'object') chapterNumberCache.delete(meta);
  }

  function buildVolumeNumberTable(meta) {
    const chapters = meta && Array.isArray(meta.chapters) ? meta.chapters : [];
    const volumes = meta && Array.isArray(meta.volumes) ? meta.volumes : [];
    const volumeIds = new Set();
    for (const volume of volumes) {
      if (volume && typeof volume.id === 'string') volumeIds.add(volume.id);
    }
    const counts = new Map();
    const table = new Array(chapters.length);
    for (let index = 0; index < chapters.length; index += 1) {
      const chapter = chapters[index];
      const volumeId = chapter && typeof chapter.volumeId === 'string' ? chapter.volumeId : '';
      const key = volumeId && volumeIds.has(volumeId) ? volumeId : '';
      const count = (counts.get(key) || 0) + 1;
      counts.set(key, count);
      table[index] = count;
    }
    numberStats.tableBuilds += 1;
    return table;
  }

  function volumeNumberTable(meta) {
    const chapters = meta && Array.isArray(meta.chapters) ? meta.chapters : [];
    const volumes = meta && Array.isArray(meta.volumes) ? meta.volumes : [];
    const numbering = meta && meta.chapterNumbering === 'volume' ? 'volume' : 'continuous';
    const cached = meta && typeof meta === 'object' ? chapterNumberCache.get(meta) : null;
    if (
      cached &&
      cached.chaptersRef === chapters &&
      cached.chaptersLength === chapters.length &&
      cached.volumesRef === volumes &&
      cached.volumesLength === volumes.length &&
      cached.numbering === numbering
    ) {
      return cached.table;
    }
    const table = buildVolumeNumberTable(meta);
    if (meta && typeof meta === 'object') {
      chapterNumberCache.set(meta, {
        chaptersRef: chapters,
        chaptersLength: chapters.length,
        volumesRef: volumes,
        volumesLength: volumes.length,
        numbering,
        table
      });
    }
    return table;
  }

  // 本章在「它所在的那一卷」里排第几（1 起）：只数它前面、同属一卷的章节。
  // 未分卷组也算一组；书里没有卷时，全部章节同属「未分卷」，结果与全书连续一致。
  // 老实现逐章从 0 数（O(index·V)），这里读卷内章号表（O(1)，首次 O(N+V)）。
  function volumeLocalNumber(meta, index) {
    const chapters = meta && Array.isArray(meta.chapters) ? meta.chapters : [];
    const safeIndex = Math.max(0, Math.min(Number(index) || 0, chapters.length - 1));
    const target = chapters[safeIndex];
    if (!target) return safeIndex + 1;
    const table = volumeNumberTable(meta);
    const value = table[safeIndex];
    // 非整数下标（老调用才会传）：和以前一样退回「下标 + 1」，不把数组访问的 undefined 漏出去
    return Number.isFinite(value) ? value : safeIndex + 1;
  }

  // 显示 / 导出的章号（1 起）。旧书没有 chapterNumbering 字段 = continuous，行为与以前完全一致。
  function chapterNumber(meta, index) {
    const mode = meta && meta.chapterNumbering === 'volume' ? 'volume' : 'continuous';
    return mode === 'volume' ? volumeLocalNumber(meta, index) : Math.max(1, (Number(index) || 0) + 1);
  }

  function formatTitle(meta, index, name) {
    const template =
      meta && typeof meta.titleTemplate === 'string' && meta.titleTemplate.trim()
        ? meta.titleTemplate
        : TITLE_TEMPLATE;
    const number = String(chapterNumber(meta, index));
    const clean = String(name == null ? '' : name).trim();
    // 原文已经带号（第1章 … / 第一章 … / Chapter N）原样显示，避免「第1章：第1章 …」重复
    if (clean && NUMBERED_TITLE_RE.test(clean)) return clean;
    // 没有名字的章节：显示「第N章」，不再显示「第N章：未命名」
    if (!clean) return `第${number}章`;
    // 不带号的特殊标题（楔子 / 番外 / 大结局 / 前传 …）：补章号。
    // 模板缺 {num} 或 {name} 时回落默认，避免自定义模板把「大结局」这个词吞掉。
    if (SPECIAL_TITLE_RE.test(clean) && (!template.includes('{num}') || !template.includes('{name}'))) {
      return `第${number}章：${clean}`;
    }
    return template.split('{num}').join(number).split('{name}').join(clean);
  }

  // 文件名主干命中 Windows 保留设备名时返回该主干（大写），否则返回空串。
  // 「主干」= 第一个点之前的部分：`con.txt` 命中，`CON 的故事.txt` 不命中。
  function reservedStem(name) {
    const text = String(name == null ? '' : name);
    const dot = text.indexOf('.');
    const stem = (dot < 0 ? text : text.slice(0, dot)).trim().toUpperCase();
    return RESERVED_STEMS.has(stem) ? stem : '';
  }

  // 命中保留名时把安全后缀插在主干末尾（`CON` → `CON_`，`CON.txt` → `CON_.txt`）。
  // 不能简单加在整串末尾：Windows 判定的是第一个点之前的主干，`CON.txt_` 仍然是设备名。
  function escapeReservedStem(name) {
    if (!reservedStem(name)) return name;
    const dot = name.indexOf('.');
    return dot < 0 ? `${name}_` : `${name.slice(0, dot)}_${name.slice(dot)}`;
  }

  function safeName(raw) {
    let s = String(raw == null ? '' : raw).trim();
    s = s.replace(ILLEGAL_CHARS, '').replace(EDGE_DOTS_SPACES, '');
    if (!s) s = '未命名';
    if (s.length > MAX_NAME_LENGTH) s = s.slice(0, MAX_NAME_LENGTH).replace(EDGE_DOTS_SPACES, '');
    return escapeReservedStem(s) || '未命名';
  }

  function buildFileName(seq, name) {
    return `${pad3(seq)}-${safeName(name)}.txt`;
  }

  function uniqueFileName(seq, name, existingFiles = []) {
    const used = new Set(existingFiles);
    let candidate = buildFileName(seq, name);
    let i = 2;
    while (used.has(candidate)) {
      candidate = buildFileName(seq, `${safeName(name)}-${i}`);
      i += 1;
    }
    return candidate;
  }

  function nextFileSeq(meta) {
    const n = Number(meta && meta.fileSeq);
    if (!Number.isFinite(n) || n < 0) return 1;
    return Math.floor(n) + 1;
  }

  function findChapterIndex(meta, chapterId) {
    if (!meta || !Array.isArray(meta.chapters)) return -1;
    return meta.chapters.findIndex((c) => c && c.id === chapterId);
  }

  function insertChapter(meta, insertIndex, chapter) {
    const list = Array.isArray(meta.chapters) ? meta.chapters.slice() : [];
    const rawIndex = Number(insertIndex);
    const index = Number.isFinite(rawIndex) ? Math.max(0, Math.min(Math.floor(rawIndex), list.length)) : list.length;
    list.splice(index, 0, chapter);
    invalidateChapterNumberCache(meta);
    return { ...meta, chapters: list };
  }

  function removeChapter(meta, chapterId) {
    const list = (meta.chapters || []).filter((c) => c.id !== chapterId);
    invalidateChapterNumberCache(meta);
    return { ...meta, chapters: list };
  }

  function updateChapter(meta, chapterId, patch) {
    invalidateChapterNumberCache(meta);
    return {
      ...meta,
      chapters: (meta.chapters || []).map((c) => (c.id === chapterId ? { ...c, ...patch } : c))
    };
  }

  // ---------- 章节状态 / 备注（可选字段，只影响书目） ----------
  function isChapterStatus(raw) {
    return typeof raw === 'string' && CHAPTER_STATUSES.includes(raw.trim().toLowerCase());
  }

  function sanitizeChapterStatus(raw) {
    return isChapterStatus(raw) ? raw.trim().toLowerCase() : DEFAULT_CHAPTER_STATUS;
  }

  // 备注当成一句话：换行收成空格、去首尾空白、最多 200 字；清空 = 删除备注
  function sanitizeChapterNote(raw) {
    if (typeof raw !== 'string') return '';
    const oneLine = raw.replace(/\r\n?/g, '\n').replace(/\s*\n+\s*/g, ' ').trim();
    return oneLine.length > MAX_NOTE_LENGTH ? oneLine.slice(0, MAX_NOTE_LENGTH) : oneLine;
  }

  function chapterStatus(chapter) {
    return sanitizeChapterStatus(chapter && chapter.status);
  }

  function chapterNote(chapter) {
    return sanitizeChapterNote(chapter && chapter.note);
  }

  // 读取时清洗：合法 status 保留（统一小写），非法/缺失就不写这个字段；
  // 空备注同样不保留字段 —— 旧版书目读进来不会平白多出字段，写回时也不会带脏值。
  function cleanChapterMeta(chapter) {
    const next = { ...chapter };
    if (isChapterStatus(chapter && chapter.status)) {
      next.status = String(chapter.status).trim().toLowerCase();
    } else {
      delete next.status;
    }
    const note = sanitizeChapterNote(chapter && chapter.note);
    if (note) next.note = note;
    else delete next.note;
    return next;
  }

  // 只接受白名单字段（status/note）；空备注删除该字段，草稿状态显式保留
  function applyChapterMeta(chapter, patch) {
    const next = { ...chapter };
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'status')) {
      next.status = sanitizeChapterStatus(patch.status);
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'note')) {
      const note = sanitizeChapterNote(patch.note);
      if (note) next.note = note;
      else delete next.note;
    }
    return next;
  }

  function countChapterStatuses(meta) {
    const counts = { total: 0, draft: 0, revising: 0, done: 0 };
    const list = Array.isArray(meta && meta.chapters) ? meta.chapters : [];
    for (const chapter of list) {
      counts.total += 1;
      counts[chapterStatus(chapter)] += 1;
    }
    return counts;
  }

  function countChars(text) {
    return String(text == null ? '' : text).replace(/\s/g, '').length;
  }

  // ---------- 分卷 ----------
  // 书的分卷：meta.volumes = [{ id, name }]（数组顺序 = 显示顺序），章节上的 volumeId 指向卷；
  // 没有 volumeId（或指向已不存在的卷）= 「未分卷」。
  // 顺序约定：chapters 数组顺序 == 界面显示顺序，且必须按「未分卷 → 第1卷 → 第2卷 …」分组连续排列；
  // 任何改卷归属的操作之后都用 normalizeChapterOrder() 归一（稳定排序，组内相对顺序不变）。

  function sanitizeVolumes(raw) {
    const out = [];
    if (!Array.isArray(raw)) return out;
    const seen = new Set();
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      out.push({ id, name });
    }
    return out;
  }

  // 卷在排序里的权重：0 = 未分卷，1..n = 第1..n卷；找不到的卷也算未分卷
  function volumeRank(meta, volumeId) {
    if (!volumeId) return 0;
    const index = sanitizeVolumes(meta && meta.volumes).findIndex((v) => v.id === volumeId);
    return index < 0 ? 0 : index + 1;
  }

  function normalizeChapterOrder(meta) {
    invalidateChapterNumberCache(meta);
    const volumes = sanitizeVolumes(meta && meta.volumes);
    const rank = new Map(volumes.map((v, i) => [v.id, i + 1]));
    const list = Array.isArray(meta && meta.chapters) ? meta.chapters.slice() : [];
    // 卷没了 / 卷 id 不认识的章节一律回「未分卷」，避免界面里出现指向不存在卷的章
    const decorated = list.map((chapter, index) => {
      const volumeId = chapter && chapter.volumeId && rank.has(chapter.volumeId) ? chapter.volumeId : null;
      const next = volumeId === (chapter && chapter.volumeId) ? chapter : { ...chapter, volumeId };
      return { chapter: next, index, r: rank.get(volumeId) || 0 };
    });
    decorated.sort((a, b) => (a.r - b.r) || (a.index - b.index));
    return { ...meta, volumes, chapters: decorated.map((d) => d.chapter) };
  }

  function nextVolumeId(meta) {
    const ids = new Set(sanitizeVolumes(meta && meta.volumes).map((v) => v.id));
    let i = 1;
    for (;;) {
      const id = `v_${pad3(i)}`;
      if (!ids.has(id)) return id;
      i += 1;
    }
  }

  // 某卷里最后一章的数组下标之后（没有章节就返回该组插入点）
  function insertIndexForVolume(meta, volumeId) {
    const list = Array.isArray(meta && meta.chapters) ? meta.chapters : [];
    const target = volumeId || null;
    let last = -1;
    for (let i = 0; i < list.length; i += 1) {
      const id = (list[i] && list[i].volumeId) || null;
      if (id === target) last = i;
    }
    if (last >= 0) return last + 1;
    // 卷里还没有章节：插到该卷分组应该开始的位置（下一个卷的第一章之前，或全书末尾）
    const rank = volumeRank(meta, target);
    for (let i = 0; i < list.length; i += 1) {
      const id = (list[i] && list[i].volumeId) || null;
      if (volumeRank(meta, id) > rank) return i;
    }
    return list.length;
  }

  // U-D1：Alt+↑/↓ 在卷边界上的「跨卷」目标（同卷相邻仍由渲染层的 stepMoveTarget 算，这里只算换卷）。
  // 顺序约定：未分卷(0) → 第1卷 → 第2卷 …；一次只跨相邻的一个卷（中间的空卷也算一步，不会跳着跨）。
  // 返回 null = 不动：不在卷边界 / 到头 / 未分卷（「未分卷」不是卷，键盘不把章移出卷）/ 坏卷 id / 坏参数。
  // 返回 { volumeId, beforeChapterId }：
  //   - 向下 = 目标卷卷首：beforeChapterId = 目标卷第一章（目标卷为空时 null，插到该卷分组起点）；
  //   - 向上 = 上一卷卷尾：beforeChapterId = null（insertIndexForVolume 落在该卷最后一章之后）。
  // 只算「该去哪」，不碰磁盘；真正的写盘仍走 storage.moveChapterTo（只改 书目.json）。
  function crossVolumeTarget(meta, index, direction) {
    const volumes = sanitizeVolumes(meta && meta.volumes);
    const list = Array.isArray(meta && meta.chapters) ? meta.chapters : [];
    const from = Math.floor(Number(index));
    const step = Math.floor(Number(direction));
    if (!volumes.length || !Number.isFinite(from) || !Number.isFinite(step) || step === 0) return null;
    if (from < 0 || from >= list.length) return null;
    // 卷权重：0 = 未分卷 / 坏卷 id（卷被删了），1..n = 第 1..n 卷
    const rankOf = (chapter) => {
      const id = chapter && typeof chapter.volumeId === 'string' ? chapter.volumeId : '';
      if (!id) return 0;
      const at = volumes.findIndex((volume) => volume.id === id);
      return at < 0 ? 0 : at + 1;
    };
    const rank = rankOf(list[from]);
    if (!rank) return null; // 未分卷不参与跨卷（首卷首章往上 / 未分卷卷尾往下都停住）
    const targetRank = rank + (step > 0 ? 1 : -1);
    if (targetRank < 1 || targetRank > volumes.length) return null; // 首卷往上 / 末卷往下：到头
    const to = from + (step > 0 ? 1 : -1);
    // 方向内还有同卷章节 = 这是卷内移动，交给渲染层的 stepMoveTarget（不在这里抢）
    if (to >= 0 && to < list.length && rankOf(list[to]) === rank) return null;
    const target = volumes[targetRank - 1];
    let beforeChapterId = null;
    if (step > 0) {
      const first = list.find((chapter) => rankOf(chapter) === targetRank);
      beforeChapterId = first ? first.id : null;
    }
    return { volumeId: target.id, beforeChapterId };
  }

  // 调整卷的先后顺序（只改 volumes 数组顺序，章节按新卷序重新归一；章节文件不动）
  function moveVolume(meta, volumeId, toIndex) {
    invalidateChapterNumberCache(meta);
    const volumes = sanitizeVolumes(meta && meta.volumes).slice();
    const from = volumes.findIndex((v) => v.id === volumeId);
    const total = volumes.length;
    const to = Math.max(0, Math.min(Math.round(Number(toIndex) || 0), total - 1));
    if (from < 0 || from === to) {
      return { meta: normalizeChapterOrder({ ...meta, volumes }), moved: false, from, to: from };
    }
    const [moved] = volumes.splice(from, 1);
    volumes.splice(to, 0, moved);
    return { meta: normalizeChapterOrder({ ...meta, volumes }), moved: true, from, to };
  }



  function normalizeNewlines(text) {
    return String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  }

  function toDiskNewlines(text) {
    return normalizeNewlines(text).replace(/\n/g, '\r\n');
  }


  return {
    TITLE_TEMPLATE,
    MAX_NAME_LENGTH,
    RAW_TITLE_RE,
    CHAPTER_NUMBERING_MODES,
    DEFAULT_CHAPTER_NUMBERING,
    sanitizeChapterNumbering,
    chapterVolumeKey,
    volumeLocalNumber,
    chapterNumber,
    invalidateChapterNumberCache,
    resetChapterNumberStats,
    readChapterNumberStats,
    CHAPTER_STATUSES,
    CHAPTER_STATUS_LABELS,
    DEFAULT_CHAPTER_STATUS,
    MAX_NOTE_LENGTH,
    pad3,
    formatTitle,
    reservedStem,
    escapeReservedStem,
    safeName,
    buildFileName,
    uniqueFileName,
    nextFileSeq,
    findChapterIndex,
    insertChapter,
    removeChapter,
    updateChapter,
    isChapterStatus,
    sanitizeChapterStatus,
    sanitizeChapterNote,
    chapterStatus,
    chapterNote,
    cleanChapterMeta,
    applyChapterMeta,
    countChapterStatuses,
    sanitizeVolumes,
    volumeRank,
    normalizeChapterOrder,
    nextVolumeId,
    insertIndexForVolume,
    crossVolumeTarget,
    moveVolume,
    countChars,
    normalizeNewlines,
    toDiskNewlines
  };
});
