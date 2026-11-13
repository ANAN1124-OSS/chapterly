// 路径归一的唯一实现：Windows 路径不分大小写，同一个书架 / 同一本书可能被写成不同形式
// （大小写不同、末尾多一个反斜杠、带 .. 的相对写法）。比较「是不是同一个目录 / 同一本书」
// 之前统一走这里：解析成绝对路径再小写。
//
// 收编前 core/open-books.js（normalizeBookPath）与 core/search-index.js（normalizeRoot）
// 各有一份逐字相同的实现 —— 两边判「同一本书」的口径必须永远一致，否则书架搜索会把
// 同一本书当成两本（重复建索引）或对已打开的书判错。
//
// 1.7.2 D4（V43/V83）：判「是不是同一个路径」的口径也只留一份 —— `pathKey` 在上面「resolve +
// 小写」之外再显式把 Windows 正斜杠归反斜杠。收编前四套：core/config-gate.js 的 pathKey、
// core/config.js 的词表去重 key（只换斜杠小写、不 resolve）、main.js 的 wordlistKey（只在
// win32 小写）、main.js 的 bookKeyOf（不 trim）—— 现在 config-gate / config / main 全部改成
// 引用同一个 pathKey。normalizePath 保留原语义（open-books / search-index 在用，不改行为）。
//
// 纯函数：只依赖 node:path，不碰 fs / electron / process；空值 / 非法路径返回空串或原样小写。
const path = require('node:path');

// 这台机器是不是 Windows（用 path.sep 判断，避免碰 process —— 本模块的纯逻辑闸门钉住「不碰 process」）
const WINDOWS = path.sep === '\\';

function resolveLower(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  try {
    return path.resolve(raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

function normalizePath(value) {
  return resolveLower(value);
}

// 比较「是不是同一个路径」的规范键：resolve + 小写；Windows 下再把可能残留的正斜杠归成反斜杠。
// 只用于等价判断，不改变要存进配置 / 传给 fs 的原字符串。
function pathKey(value) {
  const key = resolveLower(value);
  return WINDOWS ? key.replace(/\//g, '\\') : key;
}

module.exports = { normalizePath, pathKey };
