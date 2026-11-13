/* 书籍信息（v0.8 P0 N3）——书目.json 上的可选作者 / 简介 / 分组 / 标签。
 *
 * 参考口袋写作 `tb_book` 的 author / brief / groupId：写手需要在不改书文件夹、
 * 不动章节 txt 的前提下，给书补上「谁写的 / 一句话简介 / 归到哪个组 / 有哪些标签」。
 *
 * 约定（与项目其他可选字段一致）：
 *   - 全部字段都是可选的，旧 `书目.json` 没有它们照常打开（读取时清洗、不补字段）；
 *   - 纯文本、只做字符串清洗（去首尾空白 / 单行化 / 长度上限），不读盘、不联网；
 *   - 写入只发生在作者显式保存「书籍信息…」时，书文件夹名 / 章节文件名永远不动。
 *
 * 本模块同时被 Node（core/storage.js、单测）和渲染层（index.html 里 <script>）
 * 使用，所以写成 UMD：Node 里 require 得到对象，浏览器里挂到 window.CWBookInfo。
 * 1.7.2 D4（V81）：字段限长的「不切开代理对」保护收进 core/common.js 的 truncateSafe，
 * 本模块只接工厂参数 —— 浏览器里 core/common.js 必须排在 core/bookinfo.js 之前。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./common'));
  } else if (root) {
    root.CWBookInfo = factory(root.CWCommon);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (common) {
  'use strict';

  // core/common.js 必须先加载（index.html 里 common.js 排在 bookinfo.js 之前）；缺了直接报错，
  // 不悄悄退回旧副本 —— 代理对保护的截断只该有 core/common.js 这一份（V81）。
  if (!common || typeof common.truncateSafe !== 'function') {
    throw new Error('CWBookInfo：core/common.js 没有先加载');
  }
  const { truncateSafe } = common;

  const MAX_AUTHOR_LENGTH = 80;
  const MAX_BRIEF_LENGTH = 1000;
  const MAX_GROUP_LENGTH = 40;
  const MAX_TAGS = 10;
  const MAX_TAG_LENGTH = 20;

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function asText(value) {
    return typeof value === 'string' ? String(value) : '';
  }

  // 单行文本：换行 / 制表折成空格、连续空白压成一个、首尾去掉，再限长（限长走 core/common.js
  // 的 truncateSafe：按 UTF-16 长度截断但不切开代理对）。
  function sanitizeSingleLine(value, maxLength) {
    const text = asText(value)
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/[\s\u3000]+/g, ' ')
      .trim();
    return truncateSafe(text, maxLength);
  }

  function sanitizeAuthor(value) {
    return sanitizeSingleLine(value, MAX_AUTHOR_LENGTH);
  }

  function sanitizeGroup(value) {
    return sanitizeSingleLine(value, MAX_GROUP_LENGTH);
  }

  // 简介允许多行：统一换行、去掉每行行尾空白、连续空行压成一个空行、整体 trim。
  // 纯文本，不做任何标点 / 引号 / 全半角转换。
  function sanitizeBrief(value) {
    const text = asText(value).replace(/\r\n?/g, '\n');
    const lines = text.split('\n').map((line) => line.replace(/[ \t\u3000]+$/g, ''));
    const kept = [];
    let blank = 0;
    for (const line of lines) {
      if (!line.trim()) {
        blank += 1;
        continue;
      }
      if (blank > 0 && kept.length) kept.push('');
      blank = 0;
      kept.push(line);
    }
    return truncateSafe(kept.join('\n').trim(), MAX_BRIEF_LENGTH);
  }

  function sanitizeTag(value) {
    return sanitizeSingleLine(value, MAX_TAG_LENGTH);
  }

  // 标签：数组或「逗号 / 顿号 / 分号 / 换行」分隔的字符串；
  // 去空、去重（完全相同的才算重复）、限长、最多 10 个，保留作者输入顺序。
  function sanitizeTags(value) {
    let list;
    if (Array.isArray(value)) list = value;
    else if (typeof value === 'string') list = value.split(/[,，、;；\n]/);
    else list = [];
    const out = [];
    const seen = new Set();
    for (const item of list) {
      const tag = sanitizeTag(item);
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
      if (out.length >= MAX_TAGS) break;
    }
    return out;
  }

  // 读取侧：不管书目里存了什么（缺字段 / 类型不对 / 超长），都还给调用方干净的值。
  // 不修改传入对象、不补字段到磁盘。
  function readBookInfo(meta) {
    const source = meta && typeof meta === 'object' ? meta : {};
    return {
      author: sanitizeAuthor(source.author),
      brief: sanitizeBrief(source.brief),
      group: sanitizeGroup(source.group),
      tags: sanitizeTags(source.tags)
    };
  }

  // 写盘前清洗：只保留非空的可选字段；空字符串 / 空数组 = 删除该字段。
  // 不认识的字段、章节数组等一律原样保留。
  function cleanBookInfo(meta) {
    const source = meta && typeof meta === 'object' ? meta : {};
    const info = readBookInfo(source);
    const next = { ...source };
    for (const key of ['author', 'brief', 'group']) {
      if (info[key]) next[key] = info[key];
      else delete next[key];
    }
    if (info.tags.length) next.tags = info.tags;
    else delete next.tags;
    return next;
  }

  // 渲染层 / IPC 传来的 patch：只认 author / brief / group / tags 四个键。
  // 类型不对（作者传数字、标签传对象）返回 null，由调用方报错——不静默清空旧值。
  // 返回的对象只含「这次真的传了」的键（允许用空字符串 / 空数组清空）。
  function bookInfoPatchFields(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null;
    const fields = {};
    for (const key of ['author', 'brief', 'group']) {
      if (!hasOwn(patch, key)) continue;
      if (typeof patch[key] !== 'string') return null;
      fields[key] = key === 'author'
        ? sanitizeAuthor(patch[key])
        : key === 'group'
          ? sanitizeGroup(patch[key])
          : sanitizeBrief(patch[key]);
    }
    if (hasOwn(patch, 'tags')) {
      const tags = patch.tags;
      if (Array.isArray(tags)) {
        if (!tags.every((tag) => typeof tag === 'string')) return null;
      } else if (typeof tags !== 'string') {
        return null;
      }
      fields.tags = sanitizeTags(tags);
    }
    return Object.keys(fields).length ? fields : null;
  }

  function sameBookInfo(a, b) {
    const left = readBookInfo(a);
    const right = readBookInfo(b);
    return (
      left.author === right.author &&
      left.brief === right.brief &&
      left.group === right.group &&
      left.tags.join('\u0000') === right.tags.join('\u0000')
    );
  }

  // 书架搜索补一条：作者 / 分组 / 标签里包含关键词（不区分大小写、字面量）。
  // 书名 / 章名 / 正文的匹配仍在渲染层与正文索引里各自负责。
  function bookInfoMatches(info, query) {
    const needle = String(query == null ? '' : query).trim().toLowerCase();
    if (!needle) return false;
    const haystack = [info && info.author, info && info.group]
      .concat(Array.isArray(info && info.tags) ? info.tags : [])
      .filter(Boolean)
      .map((part) => String(part).toLowerCase());
    return haystack.some((part) => part.includes(needle));
  }

  function bookInfoSummary(info) {
    const value = readBookInfo(info);
    const parts = [];
    if (value.author) parts.push(`作者：${value.author}`);
    if (value.group) parts.push(`分组：${value.group}`);
    if (value.tags.length) parts.push(value.tags.map((tag) => `#${tag}`).join(' '));
    return parts.join(' · ');
  }

  // ---------- 书架筛选 / 分组管理（1.6.0 F5） ----------
  // 分组是自由字符串：比较统一按「清洗成单行 + 小写」归一，落盘 / 显示仍用作者原来的写法。
  // 这里全是纯函数（不读盘、不写盘、不改入参），写盘仍走 storage.updateBookInfo。

  function groupKey(value) {
    return sanitizeGroup(value).toLowerCase();
  }

  function countRows(counts) {
    return Array.from(counts, ([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }

  // 分组统计：分组名按作者写法原样聚合（与书架分组筛选的选项同一口径），按中文排序；
  // 未分组的书单独计数，筛选项要显示「未分组 · N」。
  function collectGroupStats(books) {
    const counts = new Map();
    let ungrouped = 0;
    let total = 0;
    for (const book of Array.isArray(books) ? books : []) {
      if (!book || typeof book !== 'object') continue;
      total += 1;
      const group = sanitizeGroup(book.group);
      if (!group) {
        ungrouped += 1;
        continue;
      }
      counts.set(group, (counts.get(group) || 0) + 1);
    }
    return { groups: countRows(counts), ungrouped, total };
  }

  // 标签统计：同一本书里的重复标签在读取时已经去重；跨书累加，按中文排序。
  function collectTagStats(books) {
    const counts = new Map();
    for (const book of Array.isArray(books) ? books : []) {
      if (!book || typeof book !== 'object') continue;
      for (const tag of sanitizeTags(book.tags)) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    return countRows(counts);
  }

  // 筛选判定：分组 + 标签两条都满足才显示（与搜索词是 AND，搜索词在渲染层另算）。
  // group 用 '__none__' 表示「未分组」（与书架分组筛选条同一个哨兵值）；空 = 不限。
  // tag 空 = 不限；标签按全名精确匹配，不做子串（子串搜索归搜索框）。
  function bookMatchesFilters(book, filters) {
    const filter = filters && typeof filters === 'object' ? filters : {};
    const info = readBookInfo(book);
    const group = sanitizeGroup(filter.group);
    if (group === '__none__') {
      if (info.group) return false;
    } else if (group && info.group !== group) {
      return false;
    }
    const tag = sanitizeTag(filter.tag);
    if (tag && !info.tags.includes(tag)) return false;
    return true;
  }

  // 已有分组的「规范写法」：大小写 / 空白归一后同名，就用已有的那个写法，避免「玄幻」与
  // 「玄幻 」分裂成两个分组；没有同名分组时用清洗后的输入。
  function canonicalGroupName(existingNames, value) {
    const name = sanitizeGroup(value);
    if (!name) return '';
    const key = name.toLowerCase();
    const hit = (Array.isArray(existingNames) ? existingNames : [])
      .filter((item) => typeof item === 'string')
      .find((item) => groupKey(item) === key && sanitizeGroup(item));
    return hit === undefined ? name : sanitizeGroup(hit);
  }

  // 分组改名 / 合并计划：把 from 组里的书改成 to 组（空串 = 未分组）。
  // 返回 [{ path, title, from, to }]，顺序 = 传入书的顺序；不改入参、不写盘。
  // from 与 to 归一后相同 → 空计划（没有变化，不写盘）。
  // 缺 path 的条目（坏数据 / 只读详情）跳过——没有路径就没法写回 书目.json。
  function planGroupChange(books, from, to) {
    const list = Array.isArray(books) ? books : [];
    const fromName = sanitizeGroup(from);
    const existing = Array.from(
      new Set(list.map((book) => sanitizeGroup(book && book.group)).filter(Boolean))
    );
    const toName = canonicalGroupName(existing, to);
    if (groupKey(fromName) === groupKey(toName)) return [];
    const changes = [];
    for (const book of list) {
      if (!book || typeof book !== 'object') continue;
      const group = sanitizeGroup(book.group);
      if (groupKey(group) !== groupKey(fromName)) continue;
      const bookPath = typeof book.path === 'string' ? book.path : '';
      if (!bookPath) continue;
      changes.push({
        path: bookPath,
        title: sanitizeSingleLine(book.title, 120) || bookPath,
        from: group,
        to: toName
      });
    }
    return changes;
  }

  return {
    MAX_AUTHOR_LENGTH,
    MAX_BRIEF_LENGTH,
    MAX_GROUP_LENGTH,
    MAX_TAGS,
    MAX_TAG_LENGTH,
    sanitizeAuthor,
    sanitizeBrief,
    sanitizeGroup,
    sanitizeTag,
    sanitizeTags,
    readBookInfo,
    cleanBookInfo,
    bookInfoPatchFields,
    sameBookInfo,
    bookInfoMatches,
    bookInfoSummary,
    collectGroupStats,
    collectTagStats,
    bookMatchesFilters,
    canonicalGroupName,
    planGroupChange
  };
});
