// 路径归一的唯一实现：Windows 路径不分大小写，同一个书架 / 同一本书可能被写成不同形式
// （大小写不同、末尾多一个反斜杠、带 .. 的相对写法）。比较「是不是同一个目录 / 同一本书」
// 之前统一走这里：解析成绝对路径再小写。
//
// 收编前 core/open-books.js（normalizeBookPath）与 core/search-index.js（normalizeRoot）
// 各有一份逐字相同的实现 —— 两边判「同一本书」的口径必须永远一致，否则书架搜索会把
// 同一本书当成两本（重复建索引）或对已打开的书判错。
//
// 纯函数：只依赖 node:path，不碰 fs / electron；空值 / 非法路径返回空串或原样小写。
const path = require('node:path');

function normalizePath(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  try {
    return path.resolve(raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

module.exports = { normalizePath };
