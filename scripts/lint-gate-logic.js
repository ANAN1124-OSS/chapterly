'use strict';
// 零依赖 lint 门禁的判定核心（1.6.0 G1）。
//
// 审计修复 #53（R6）：本门禁只保留 ESLint 替代不了的那一条 —— floating-promise。
// 原来的 undefined-ref / unused-variable 两条与 eslint.config.js 的 no-undef / no-unused-vars
// （均 error，扫描范围相同）逐项重叠，还各自维护一份全局白名单；两套口径并存只会让「改了一边忘了
// 另一边」成为常态。现在分工是：
//   `npx eslint .`        → 语法级：没声明的名字（no-undef）、声明了没人读的名字（no-unused-vars）；
//   `node scripts/lint-gate.js` → 语义级：语句级调用 async 函数却没人接（unhandledRejection —— 这条
//                                需要 TS 解析器，eslint 这套替代不了，删了就少一道闸）。
//
// 判定刻意**保守**（宁可漏报不可误报，误报会让门禁被人绕过）：
//   · 只认同文件里写明的 `async function NAME` / `NAME = async …` / `async NAME(`；
//     跨文件 / 动态取到的 promise 一律不猜。
//   · 只认「语句级调用」（行首 / `;` / `{` / `}` / `)` 之后），表达式里出现的算已处理。
//   · 字符串、注释、模板字面量文本、正则字面量里的文字先遮成空格，再在遮过的文本上判定；
//     `${…}` 里的表达式是真代码，保留。

const RULES = {
  FLOATING_PROMISE: 'floating-promise'
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

// ---------------------------------------------------------------- 规则：floating promise

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

// ---------------------------------------------------------------- 出口

function lintSource(source, options) {
  const text = String(source == null ? '' : source);
  const opts = options || {};
  const masked = maskSource(text);
  const findings = [];
  const seen = new Set();
  for (const finding of checkFloatingPromises(masked)) {
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