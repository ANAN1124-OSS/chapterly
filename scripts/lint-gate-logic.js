'use strict';
// 零依赖 lint 门禁的判定核心（1.6.0 G1）。
//
// 为什么要自己写：本仓不加 eslint / 不加 devDependency / 不加 CI（执行卡 §9 保守默认），
// 但「未处理的 promise rejection / 没声明的名字 / 死变量」这三类问题靠人眼在全仓 300+ 个 js
// 里找必然漏，而且往往要到运行期才炸。这个模块只做**字符串进、结论出**的纯判定，
// 不碰 fs / 配置 / 网络，CLI 在 `scripts/lint-gate.js`，两边共用同一套口径。
//
// 三条规则与严重级别（见执行卡 G1）：
//   ① floating-promise → **ERROR**：同文件里能证明是 `async` 的函数，被语句级调用却没人接
//      （没有 await / return / void / .then / .catch / .finally / 赋值 / 传参）——
//      失败时会变成 unhandledRejection，静默不报错。
//   ② undefined-ref → **ERROR**：文件里没声明、也不在已知全局 / 仓库全局白名单里的标识符——
//      真跑起来就是 ReferenceError。
//   ③ unused-variable → **WARN**：函数内 `const / let / var` 声明的简单名字，函数体里一次没读。
//      存量代码里可能有人为保留的占位，先以 WARN 暴露（ERROR>0 才挡门禁），清理批次再收紧。
//
// 判定刻意**保守**（宁可漏报不可误报，误报会让门禁被人绕过）：
//   · 只认同文件里写明的 `async function NAME` / `NAME = async …` / `async NAME(`；
//     跨文件 / 动态取到的 promise 一律不猜。
//   · 只认「语句级调用」（行首 / `;` / `{` / `}` / `)` 之后），表达式里出现的算已处理。
//   · 字符串、注释、模板字面量文本、正则字面量里的文字先遮成空格，再在遮过的文本上判定；
//     `${…}` 里的表达式是真代码，保留。
//   · 未定义引用会把「属性名 / 对象字面量的键 / 方法定义名 / label」排除；声明收集宁可多收
//     （解构的键、默认值里的名字都算声明），多收只会漏报，不会误报。

const RULES = {
  FLOATING_PROMISE: 'floating-promise',
  UNUSED_VARIABLE: 'unused-variable',
  UNDEFINED_REF: 'undefined-ref'
};

const SEVERITY = {
  ERROR: 'ERROR',
  WARN: 'WARN'
};

// 关键字 / 保留字：既不是声明也不是引用，扫描时直接跳过。
const KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'get',
  'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'of', 'return', 'set', 'static', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  'implements', 'interface', 'package', 'private', 'protected', 'public', 'enum'
]);

// 已知全局：Node 内置 + 浏览器 / Electron 渲染层常用。命中即不算未定义引用。
const KNOWN_GLOBALS = new Set([
  // CommonJS / Node
  'require', 'module', 'exports', '__dirname', '__filename', 'process', 'global', 'globalThis',
  'Buffer', 'setImmediate', 'clearImmediate', 'console', 'queueMicrotask', 'structuredClone',
  'WebAssembly', 'Intl', 'Atomics', 'SharedArrayBuffer', 'ArrayBuffer', 'DataView',
  'Uint8Array', 'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array',
  'Int32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'BigInt',
  // JS 内置
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'Math', 'JSON', 'Date', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError',
  'AggregateError', 'Promise', 'Proxy', 'Reflect', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef',
  'FinalizationRegistry', 'Function', 'eval', 'arguments', 'undefined', 'NaN', 'Infinity',
  'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'encodeURI', 'encodeURIComponent', 'decodeURI',
  'decodeURIComponent', 'escape', 'unescape', 'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams',
  // 定时器 / 任务
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  // 浏览器 / DOM
  'window', 'self', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
  'fetch', 'XMLHttpRequest', 'Headers', 'Request', 'Response', 'FormData', 'Blob', 'File', 'FileList',
  'FileReader', 'AbortController', 'AbortSignal', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent',
  'ClipboardEvent', 'DragEvent', 'FocusEvent', 'InputEvent', 'UIEvent', 'WheelEvent', 'EventTarget',
  'MutationObserver', 'IntersectionObserver', 'ResizeObserver', 'getComputedStyle', 'matchMedia',
  'requestAnimationFrame', 'cancelAnimationFrame', 'alert', 'confirm', 'prompt', 'DOMParser',
  'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLButtonElement',
  'HTMLDivElement', 'HTMLSelectElement', 'HTMLOptionElement', 'HTMLDialogElement', 'HTMLCanvasElement',
  'CanvasRenderingContext2D', 'Image', 'CSS', 'crypto', 'performance', 'indexedDB', 'caches',
  'FontFace', 'WebSocket', 'ReadableStream', 'WritableStream', 'TransformStream', 'BroadcastChannel',
  'MessageChannel', 'MessagePort', 'Audio', 'AudioContext', 'OffscreenCanvas', 'ImageBitmap', 'Worker',
  'EventSource', 'MediaQueryList', 'TouchEvent', 'PointerEvent', 'CSSStyleSheet', 'HTMLCollection',
  'NodeList', 'DOMRect', 'Range', 'Selection'
]);

// 这些词之后出现的 `/` 是正则字面量的开头，不是除号。
const REGEX_AFTER_WORDS = new Set([
  'return', 'case', 'typeof', 'instanceof', 'in', 'of', 'delete', 'void', 'new', 'do', 'else',
  'yield', 'await', 'throw'
]);
const REGEX_AFTER_CHARS = new Set(['(', '[', '{', ',', ';', ':', '=', '!', '&', '|', '?', '+', '-', '*', '%', '<', '>', '^', '~']);

// 这些词之后出现的 async 调用算「已被接走」。
const HANDLED_BEFORE_WORDS = new Set([
  'await', 'return', 'void', 'typeof', 'yield', 'new', 'delete', 'in', 'of', 'instanceof', 'case', 'do', 'else'
]);

const IDENTIFIER_START_RE = /[A-Za-z_$]/;
const IDENTIFIER_PART_RE = /[\w$]/;

// ---------------------------------------------------------------- 词法遮罩

function blankAt(out, index) {
  if (index < 0 || index >= out.length) return;
  const ch = out[index];
  if (ch === '\n' || ch === '\r') return;
  out[index] = ' ';
}

function blankRange(out, from, to) {
  for (let i = from; i < to && i < out.length; i += 1) blankAt(out, i);
}

function blankLineComment(text, out, start) {
  let end = text.indexOf('\n', start);
  if (end < 0) end = text.length;
  blankRange(out, start, end);
  return end;
}

function blankBlockComment(text, out, start) {
  const close = text.indexOf('*/', start + 2);
  const end = close < 0 ? text.length : close + 2;
  blankRange(out, start, end);
  return end;
}

function blankQuoted(text, out, start, quote) {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) {
      i += 1;
      break;
    }
    if (ch === '\n') break;
    i += 1;
  }
  blankRange(out, start, i);
  return i;
}

function regexAllowedBefore(out, index) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(out[i])) i -= 1;
  if (i < 0) return true;
  const ch = out[i];
  if (REGEX_AFTER_CHARS.has(ch)) return true;
  if (!IDENTIFIER_PART_RE.test(ch)) return false;
  let start = i;
  while (start >= 0 && IDENTIFIER_PART_RE.test(out[start])) start -= 1;
  const word = out.slice(start + 1, i + 1).join('');
  return REGEX_AFTER_WORDS.has(word);
}

function blankRegex(text, out, start) {
  let i = start + 1;
  let inClass = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      i += 1;
      break;
    } else if (ch === '\n') break;
    i += 1;
  }
  while (i < text.length && /[a-z]/i.test(text[i])) i += 1;
  blankRange(out, start, i);
  return i;
}

function blankTemplateExpression(text, out, from) {
  let depth = 0;
  let i = from;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      i = blankLineComment(text, out, i);
      continue;
    }
    if (ch === '/' && next === '*') {
      i = blankBlockComment(text, out, i);
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = blankQuoted(text, out, i, ch);
      continue;
    }
    if (ch === '`') {
      i = blankTemplate(text, out, i);
      continue;
    }
    if (ch === '/' && regexAllowedBefore(out, i)) {
      i = blankRegex(text, out, i);
      continue;
    }
    if (ch === '{') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === '}') {
      if (depth === 0) {
        blankAt(out, i);
        return i + 1;
      }
      depth -= 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  return i;
}

function blankTemplate(text, out, start) {
  blankAt(out, start);
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      blankAt(out, i);
      blankAt(out, i + 1);
      i += 2;
      continue;
    }
    if (ch === '`') {
      blankAt(out, i);
      return i + 1;
    }
    if (ch === '$' && text[i + 1] === '{') {
      blankAt(out, i);
      blankAt(out, i + 1);
      i = blankTemplateExpression(text, out, i + 2);
      continue;
    }
    blankAt(out, i);
    i += 1;
  }
  return i;
}

// 把注释 / 字符串 / 模板字面量文本 / 正则字面量换成空格（等长、保留换行），
// 返回的字符串可以直接按「代码」扫描，下标与原文一一对应。
function maskSource(text) {
  const out = text.split('');
  const length = text.length;
  let i = 0;
  while (i < length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      i = blankLineComment(text, out, i);
      continue;
    }
    if (ch === '/' && next === '*') {
      i = blankBlockComment(text, out, i);
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = blankQuoted(text, out, i, ch);
      continue;
    }
    if (ch === '`') {
      i = blankTemplate(text, out, i);
      continue;
    }
    if (ch === '/' && regexAllowedBefore(out, i)) {
      i = blankRegex(text, out, i);
      continue;
    }
    i += 1;
  }
  return out.join('');
}

// ---------------------------------------------------------------- 通用扫描

function skipWhitespace(text, index) {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

function nextSignificant(text, index) {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i < text.length ? i : -1;
}

function prevSignificant(text, index) {
  let i = index;
  while (i >= 0 && /\s/.test(text[i])) i -= 1;
  return i;
}

function matchClose(text, openIndex) {
  const open = text[openIndex];
  const close = open === '(' ? ')' : open === '[' ? ']' : open === '{' ? '}' : null;
  if (!close) return -1;
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function readIdentifier(text, index) {
  if (!IDENTIFIER_START_RE.test(text[index] || '')) return null;
  let i = index + 1;
  while (i < text.length && IDENTIFIER_PART_RE.test(text[i])) i += 1;
  return { name: text.slice(index, i), end: i };
}

// 从 index 之前（不含）往回读紧挨着的那个词，空格会跳过；读到标点就返回空串。
function readWordBefore(text, index) {
  const end = prevSignificant(text, index - 1);
  if (end < 0 || !IDENTIFIER_PART_RE.test(text[end])) return '';
  let start = end;
  while (start >= 0 && IDENTIFIER_PART_RE.test(text[start])) start -= 1;
  return text.slice(start + 1, end + 1);
}

// 往回收集若干个紧挨着的词（中间只允许空白）；遇到标点即停。
// 用于 `static async name(` / `async function name(` 这种修饰链。
function precedingWords(text, index, count) {
  const words = [];
  let i = prevSignificant(text, index - 1);
  while (words.length < count && i >= 0) {
    if (!IDENTIFIER_PART_RE.test(text[i])) break;
    let start = i;
    while (start >= 0 && IDENTIFIER_PART_RE.test(text[start])) start -= 1;
    words.push(text.slice(start + 1, i + 1));
    i = prevSignificant(text, start);
  }
  return words;
}

function matchOpenBackwards(text, closeIndex) {
  let depth = 0;
  for (let i = closeIndex; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === ')') depth += 1;
    else if (ch === '(') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function lineColumnOf(text, index) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: index - lineStart + 1 };
}

// 跳过一段表达式：括号内整段跳过，停在顶层的 , ; ) ] } 或文件结尾。
function skipExpression(text, from) {
  let i = from;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      const close = matchClose(text, i);
      if (close < 0) return text.length;
      i = close + 1;
      continue;
    }
    if (ch === ',' || ch === ';' || ch === ')' || ch === ']' || ch === '}') return i;
    i += 1;
  }
  return i;
}

// 跳过 `= 表达式` 的默认值 / 初始化部分（没有 `=` 就原地返回）。
function skipInitializer(text, from) {
  const i = skipWhitespace(text, from);
  if (text[i] !== '=' || text[i + 1] === '=' || text[i + 1] === '>') return from;
  return skipExpression(text, i + 1);
}

// 读一个声明项（简单名字或解构模式），返回 { names, simple, end }。
function readDeclarator(text, from) {
  const i = skipWhitespace(text, from);
  const ch = text[i];
  if (ch === '{' || ch === '[') {
    const close = matchClose(text, i);
    if (close < 0) return null;
    const names = [];
    const inner = text.slice(i + 1, close);
    const re = /[A-Za-z_$][\w$]*/g;
    let m;
    while ((m = re.exec(inner))) {
      names.push({ name: m[0], index: i + 1 + m.index });
    }
    return { names, simple: false, end: skipInitializer(text, close + 1) };
  }
  const id = readIdentifier(text, i);
  if (!id) return null;
  return { names: [{ name: id.name, index: i }], simple: true, end: skipInitializer(text, id.end) };
}

// 解析一条 const/let/var 声明里的所有声明项（逗号分隔）。
function parseDeclaratorList(text, from) {
  const out = [];
  let i = from;
  for (;;) {
    const declarator = readDeclarator(text, i);
    if (!declarator) break;
    out.push(declarator);
    i = skipWhitespace(text, declarator.end);
    if (text[i] !== ',') break;
    i += 1;
  }
  return out;
}

// for (...) 头部范围：里面的 const/let 是循环绑定，不算「函数内未用变量」。
function forHeaderRanges(text) {
  const ranges = [];
  const re = /\bfor\b/g;
  let m;
  while ((m = re.exec(text))) {
    const open = nextSignificant(text, m.index + 3);
    if (open < 0 || text[open] !== '(') continue;
    const close = matchClose(text, open);
    if (close > 0) ranges.push({ from: open, to: close });
  }
  return ranges;
}

function insideRanges(index, ranges) {
  return ranges.some((range) => index > range.from && index < range.to);
}

function collectFunctionBodies(text) {
  const bodies = [];
  const pushBody = (braceIndex) => {
    const end = matchClose(text, braceIndex);
    if (end > 0) bodies.push({ from: braceIndex, to: end });
  };
  const fnRe = /\bfunction\b/g;
  let m;
  while ((m = fnRe.exec(text))) {
    let cursor = nextSignificant(text, m.index + 'function'.length);
    if (cursor >= 0 && text[cursor] === '*') cursor = nextSignificant(text, cursor + 1);
    const name = cursor >= 0 ? readIdentifier(text, cursor) : null;
    if (name) cursor = nextSignificant(text, name.end);
    const open = cursor;
    if (open < 0 || text[open] !== '(') continue;
    const close = matchClose(text, open);
    if (close < 0) continue;
    const brace = nextSignificant(text, close + 1);
    if (brace >= 0 && text[brace] === '{') pushBody(brace);
  }
  const arrowRe = /=>/g;
  while ((m = arrowRe.exec(text))) {
    const brace = nextSignificant(text, m.index + 2);
    if (brace >= 0 && text[brace] === '{') pushBody(brace);
  }
  return bodies;
}

// `obj.name` / `obj?.name` 是属性访问；`...name`（展开）不是，别把展开里的名字漏掉。
function isPropertyAccess(text, index) {
  const dot = index - 1;
  if (dot < 0 || text[dot] !== '.') return false;
  if (text[dot - 1] === '.' && text[dot - 2] === '.') return false;
  return true;
}

// 单次扫出「不是属性访问」的标识符计数（用于未用变量判定）。
function identifierCounts(text) {
  const counts = new Map();
  const re = /(?<![\w$])([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(text))) {
    if (isPropertyAccess(text, m.index)) continue;
    counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  return counts;
}

function collectFunctionScopes(text) {
  const scopes = [];
  const push = (from, to, isAsync) => {
    if (from >= 0 && to > from) scopes.push({ from, to, async: isAsync });
  };
  const fnRe = /\bfunction\b/g;
  let m;
  while ((m = fnRe.exec(text))) {
    let cursor = nextSignificant(text, m.index + 'function'.length);
    if (cursor >= 0 && text[cursor] === '*') cursor = nextSignificant(text, cursor + 1);
    const name = cursor >= 0 ? readIdentifier(text, cursor) : null;
    if (name) cursor = nextSignificant(text, name.end);
    if (cursor < 0 || text[cursor] !== '(') continue;
    const close = matchClose(text, cursor);
    if (close < 0) continue;
    const brace = nextSignificant(text, close + 1);
    if (brace < 0 || text[brace] !== '{') continue;
    const end = matchClose(text, brace);
    if (end < 0) continue;
    push(brace, end, precedingWords(text, m.index, 2).includes('async'));
  }
  const arrowRe = /=>/g;
  while ((m = arrowRe.exec(text))) {
    const brace = nextSignificant(text, m.index + 2);
    if (brace < 0 || text[brace] !== '{') continue;
    const end = matchClose(text, brace);
    if (end < 0) continue;
    let isAsync = false;
    const beforeArrow = prevSignificant(text, m.index - 1);
    if (beforeArrow >= 0 && text[beforeArrow] === ')') {
      const open = matchOpenBackwards(text, beforeArrow);
      if (open >= 0) isAsync = readWordBefore(text, open) === 'async';
    } else if (beforeArrow >= 0 && IDENTIFIER_PART_RE.test(text[beforeArrow])) {
      let start = beforeArrow;
      while (start >= 0 && IDENTIFIER_PART_RE.test(text[start])) start -= 1;
      isAsync = readWordBefore(text, start + 1) === 'async';
    }
    push(brace, end, isAsync);
  }
  const methodRe = /([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = methodRe.exec(text))) {
    const name = m[1];
    const open = m.index + m[0].length - 1;
    const prev = prevSignificant(text, m.index - 1);
    if (prev >= 0 && text[prev] === '.') continue;
    const close = matchClose(text, open);
    if (close < 0) continue;
    const brace = nextSignificant(text, close + 1);
    if (brace < 0 || text[brace] !== '{') continue;
    const keywordNameOk = name === 'get' || name === 'set' || name === 'async' || name === 'static';
    if (KEYWORDS.has(name) && !keywordNameOk) continue;
    const end = matchClose(text, brace);
    if (end < 0) continue;
    push(brace, end, precedingWords(text, m.index, 3).includes('async'));
  }
  return scopes;
}

// 找出包含 index 的最内层函数体（没有就是模块顶层）。
function innermostScope(scopes, index) {
  let best = null;
  for (const scope of scopes) {
    if (index <= scope.from || index >= scope.to) continue;
    if (!best || scope.from > best.from) best = scope;
  }
  return best;
}

function collectAsyncNames(text) {
  const names = new Set();
  const patterns = [
    /\basync\s+function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    /(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*async\s*(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g,
    /\b([A-Za-z_$][\w$]*)\s*:\s*async\s*(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g,
    /\basync\s+([A-Za-z_$][\w$]*)\s*\(/g
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) names.add(m[1]);
  }
  return names;
}

function statementStart(text, index) {
  const prev = prevSignificant(text, index - 1);
  if (prev < 0) return true;
  const ch = text[prev];
  if (ch === ';' || ch === '{' || ch === '}') return true;
  if (ch === ')' || ch === ']') return true;
  if (IDENTIFIER_PART_RE.test(ch)) {
    let start = prev;
    while (start >= 0 && IDENTIFIER_PART_RE.test(text[start])) start -= 1;
    const word = text.slice(start + 1, prev + 1);
    return !HANDLED_BEFORE_WORDS.has(word) && !KEYWORDS.has(word);
  }
  return false;
}

// ---------------------------------------------------------------- 规则 ①：floating promise

function checkFloatingPromises(text) {
  const asyncNames = collectAsyncNames(text);
  const findings = [];
  if (!asyncNames.size) return findings;
  const scopes = collectFunctionScopes(text);
  for (const name of asyncNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(?<![\\w$.])' + escaped + '\\s*\\(', 'g');
    let m;
    while ((m = re.exec(text))) {
      if (!statementStart(text, m.index)) continue;
      const open = m.index + m[0].length - 1;
      const close = matchClose(text, open);
      if (close < 0) continue;
      const after = nextSignificant(text, close + 1);
      // 方法 / 函数定义（`name() {`）不是调用
      if (after >= 0 && text[after] === '{') continue;
      const preceding = precedingWords(text, m.index, 2);
      if (preceding.includes('function') || preceding.includes('async')) continue;
      if (/^\*/.test(text.slice(Math.max(0, m.index - 2), m.index).trim())) continue;
      if (after >= 0 && /^\.(?:then|catch|finally)\b/.test(text.slice(after, after + 9))) continue;
      // 同步回调里没法 await（改成 async 会改调用方语义）；那里只标 WARN，
      // async 函数体内 / 模块顶层可以 await / .catch，漏接就是真隐患 → ERROR。
      const scope = innermostScope(scopes, m.index);
      const canAwait = !scope || scope.async;
      findings.push({
        rule: RULES.FLOATING_PROMISE,
        severity: canAwait ? SEVERITY.ERROR : SEVERITY.WARN,
        index: m.index,
        message: canAwait
          ? `async 函数 ${name}() 的返回值没人接（补 await / return / void / .catch）`
          : `同步回调里调了 async 函数 ${name}()（没法 await；确认是 fire-and-forget 就写 void）`
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------- 规则 ②：未使用变量

function checkUnusedVariables(text) {
  const findings = [];
  for (const body of collectFunctionBodies(text)) {
    const block = text.slice(body.from, body.to + 1);
    const headers = forHeaderRanges(block);
    const counts = identifierCounts(block);
    const declRe = /\b(?:const|let|var)\s+/g;
    let m;
    while ((m = declRe.exec(block))) {
      if (insideRanges(m.index, headers)) continue;
      for (const declarator of parseDeclaratorList(block, m.index + m[0].length)) {
        if (!declarator.simple) continue;
        for (const entry of declarator.names) {
          if (entry.name.startsWith('_')) continue;
          if ((counts.get(entry.name) || 0) <= 1) {
            findings.push({
              rule: RULES.UNUSED_VARIABLE,
              severity: SEVERITY.WARN,
              index: body.from + entry.index,
              message: `声明了 ${entry.name} 但函数内一次也没读`
            });
          }
        }
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------- 规则 ③：未定义引用

function addIdentifiers(names, text, from, to) {
  const inner = text.slice(from, to);
  const re = /[A-Za-z_$][\w$]*/g;
  let m;
  while ((m = re.exec(inner))) {
    if (!KEYWORDS.has(m[0])) names.add(m[0]);
  }
}

function addParameterNames(names, text, parenIndex) {
  const close = matchClose(text, parenIndex);
  if (close < 0) return;
  addIdentifiers(names, text, parenIndex + 1, close);
}

// 参数表：`(a, b = 1) =>`、`name(a, { b } = {}) {`、`function (a)`。
// 用 matchClose 而不是正则在括号里滚，才能吃掉 `(now = new Date())` 这种带调用的默认值。
function collectParameterNames(names, text) {
  const re = /\(/g;
  let m;
  while ((m = re.exec(text))) {
    const open = m.index;
    const close = matchClose(text, open);
    if (close < 0) continue;
    const after = nextSignificant(text, close + 1);
    if (after < 0) continue;
    let qualifies = text.slice(after, after + 2) === '=>';
    if (!qualifies && text[after] === '{') {
      const prev = prevSignificant(text, open - 1);
      if (prev >= 0 && text[prev] === '*') {
        qualifies = true;
      } else if (prev >= 0 && IDENTIFIER_PART_RE.test(text[prev])) {
        let start = prev;
        while (start >= 0 && IDENTIFIER_PART_RE.test(text[start])) start -= 1;
        const name = text.slice(start + 1, prev + 1);
        qualifies = !KEYWORDS.has(name) || name === 'get' || name === 'set' || name === 'async' || name === 'static';
      }
    }
    if (qualifies) addParameterNames(names, text, open);
  }
}

function collectDeclaredNames(text) {
  const names = new Set();
  let m;
  const declRe = /\b(?:const|let|var)\s+/g;
  while ((m = declRe.exec(text))) {
    for (const declarator of parseDeclaratorList(text, m.index + m[0].length)) {
      for (const entry of declarator.names) names.add(entry.name);
    }
  }
  const fnRe = /\bfunction\b\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(/g;
  while ((m = fnRe.exec(text))) {
    if (m[1]) names.add(m[1]);
    addParameterNames(names, text, m.index + m[0].length - 1);
  }
  collectParameterNames(names, text);
  const bareArrowRe = /\b([A-Za-z_$][\w$]*)\s*=>/g;
  while ((m = bareArrowRe.exec(text))) {
    if (!KEYWORDS.has(m[1])) names.add(m[1]);
  }
  const classRe = /\bclass\s+([A-Za-z_$][\w$]*)/g;
  while ((m = classRe.exec(text))) names.add(m[1]);
  const catchRe = /\bcatch\s*\(([^()]*)\)/g;
  while ((m = catchRe.exec(text))) addIdentifiers(names, text, m.index + m[0].indexOf('(') + 1, m.index + m[0].length - 1);
  return names;
}

function checkUndefinedRefs(text, extraGlobals) {
  const declared = collectDeclaredNames(text);
  const findings = [];
  const re = /(?<![\w$])([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(text))) {
    const name = m[1];
    if (KEYWORDS.has(name)) continue;
    if (KNOWN_GLOBALS.has(name) || extraGlobals.has(name) || declared.has(name)) continue;
    const start = m.index;
    const end = start + name.length;
    if (isPropertyAccess(text, start)) continue;
    const prev = prevSignificant(text, start - 1);
    if (prev >= 0 && text[prev] === '#') continue;
    const after = nextSignificant(text, end);
    if (after < 0) continue;
    // 属性键 / label / case 标签：`{ name: … }`、`outer:`
    if (text[after] === ':') continue;
    // 方法定义（`create() { … }`）：名字后面跟参数表和 `{`，不是引用
    if (text[after] === '(') {
      const close = matchClose(text, after);
      if (close > 0) {
        const brace = nextSignificant(text, close + 1);
        if (brace >= 0 && text[brace] === '{') continue;
      }
    }
    findings.push({
      rule: RULES.UNDEFINED_REF,
      severity: SEVERITY.ERROR,
      index: start,
      message: `标识符 ${name} 没有声明（也不在已知全局 / 仓库全局白名单里）`
    });
  }
  return findings;
}

// ---------------------------------------------------------------- 出口

function lintSource(source, options) {
  const text = String(source == null ? '' : source);
  const opts = options || {};
  const extraGlobals = new Set(opts.globals || []);
  const masked = maskSource(text);
  const raw = [
    ...checkFloatingPromises(masked),
    ...checkUnusedVariables(masked),
    ...checkUndefinedRefs(masked, extraGlobals)
  ];
  const seen = new Set();
  const findings = [];
  for (const finding of raw) {
    const key = finding.rule + '@' + finding.index;
    if (seen.has(key)) continue;
    seen.add(key);
    const at = lineColumnOf(text, finding.index);
    findings.push({
      rule: finding.rule,
      severity: finding.severity,
      file: opts.file || '<source>',
      line: at.line,
      column: at.column,
      message: finding.message
    });
  }
  findings.sort((a, b) => a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule));
  return findings;
}

function summarize(findings) {
  const list = Array.isArray(findings) ? findings : [];
  const errorCount = list.filter((f) => f.severity === SEVERITY.ERROR).length;
  return { total: list.length, errorCount, warnCount: list.length - errorCount };
}

function exitCodeFor(findings) {
  return summarize(findings).errorCount > 0 ? 1 : 0;
}

function formatFinding(finding) {
  const severity = finding.severity === SEVERITY.WARN ? 'WARN ' : 'ERROR';
  return `${severity}  ${finding.rule}  ${finding.file}:${finding.line}:${finding.column}  ${finding.message}`;
}

module.exports = {
  RULES,
  lintSource,
  summarize,
  exitCodeFor,
  formatFinding
};