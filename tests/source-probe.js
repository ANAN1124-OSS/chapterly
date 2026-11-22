// T7（三审·低）：源码静态闸门的公共探针。
//
// 为什么需要它：过去各测试文件各写一套切片——
//   `source.slice(source.indexOf('function x('), source.indexOf('\n  });'))`
// 或者直接用正则钉一整句声明文本。这类切法把「排版 / 相邻代码顺序」也当成了契约：
// 等价重构（换行、内层缩进、把一个调用拆成两行、旁边多一条注释）就红，维护摩擦高。
//
// 这里只提供两个**与排版无关、边界可靠**的探针：
//   · extractFunctionSource(source, name)：按大括号配对切出 `[async] function name(...) { ... }` 真身；
//   · extractBlock(source, marker)：从 marker 之后第一个 `{` 起按配对切出一个完整块（用于 handler 体）。
// 切出来的仍只是源码片段——断言该怎么写还是各测试的事：优先行为用例，其次「符号 / 频道 / 条数」
// 这类机器清单；别再用切片里的字面排版去钉实现形状。
//
// 扫描器只认代码 / 行注释 / 块注释 / 单引号 / 双引号 / 模板字面量六种模式（够覆盖本仓的顶层代码）。
// 切片结果是源码原文（不是求值结果），断言里可以直接 match / includes。

// 从 open 位置（必须是 '[' / '(' / '{'）起按配对扫描到一个完整的括号块。
// 返回「配对收尾字符的下标」，找不到抛错（带上下文，便于定位是哪个探针失败）。
function scanBalanced(source, open, label) {
  const pairs = { '{': '}', '(': ')', '[': ']' };
  const close = pairs[source[open]];
  if (!close) throw new Error(`${label || 'scanBalanced'}：起点不是括号（实际 ${JSON.stringify(source[open])}）`);
  let depth = 0;
  let mode = 'code';
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (mode === 'code') {
      if (ch === '/' && source[i + 1] === '/') { mode = 'line'; i += 1; continue; }
      if (ch === '/' && source[i + 1] === '*') { mode = 'block'; i += 1; continue; }
      if (ch === "'") { mode = 'single'; continue; }
      if (ch === '"') { mode = 'double'; continue; }
      if (ch === '`') { mode = 'template'; continue; }
      if (ch === source[open]) { depth += 1; continue; }
      if (ch === close) {
        depth -= 1;
        if (depth === 0) return i;
      }
      continue;
    }
    if (mode === 'line') { if (ch === '\n') mode = 'code'; continue; }
    if (mode === 'block') { if (ch === '*' && source[i + 1] === '/') { mode = 'code'; i += 1; } continue; }
    if (mode === 'single') {
      if (ch === '\\') { i += 1; continue; }
      if (ch === "'") mode = 'code';
      continue;
    }
    if (mode === 'double') {
      if (ch === '\\') { i += 1; continue; }
      if (ch === '"') mode = 'code';
      continue;
    }
    // template
    if (ch === '\\') { i += 1; continue; }
    if (ch === '`') mode = 'code';
  }
  throw new Error(`${label || 'scanBalanced'}：括号没有配对（从第 ${open} 个字符开始）`);
}

// 切出函数真身：从 `function name(` 的起始位置到函数体收尾大括号。
// 形参表与函数体各按自己的括号配对跳，所以默认参数里的箭头函数 / 对象字面量也能过。
function extractFunctionSource(source, name) {
  const marker = new RegExp(`^[ \\t]*(?:async[ \\t]+)?function[ \\t]+${name}[ \\t]*\\(`, 'm');
  const match = marker.exec(source);
  if (!match) throw new Error(`extractFunctionSource：源码里找不到 function ${name}(`);
  // 行首缩进不算内容：从 `async` / `function` 那个字符起切。
  const trimmed = match[0].trimStart();
  const realStart = match.index + (match[0].length - trimmed.length);
  const parenStart = source.indexOf('(', realStart);
  const parenEnd = scanBalanced(source, parenStart, `function ${name} 的形参表`);
  const bodyStart = source.indexOf('{', parenEnd);
  if (bodyStart < 0) throw new Error(`extractFunctionSource：function ${name} 没有函数体`);
  const bodyEnd = scanBalanced(source, bodyStart, `function ${name} 的函数体`);
  return source.slice(realStart, bodyEnd + 1);
}

// 从 marker 之后第一个 `{` 起切一个完整块，返回到配对收尾大括号为止的源码。
// marker 用源码里稳定存在的标识（IPC 频道名 / 关键字开头），不依赖它后面的排版。
function extractBlock(source, marker, options = {}) {
  const from = options.from || 0;
  const at = source.indexOf(marker, from);
  if (at < 0) throw new Error(`extractBlock：源码里找不到 ${JSON.stringify(marker)}`);
  const open = source.indexOf('{', at);
  if (open < 0) throw new Error(`extractBlock：${JSON.stringify(marker)} 之后没有块起始 {`);
  // marker 与 `{` 之间出现分号 = 这不是我们要的块（例如先把频道名存进变量）——直接报错，别静默切错。
  // marker 自身以 `{` 结尾（`if (x) {`）时 open 落在 marker 内，between 为空，照常切。
  const between = source.slice(at + marker.length, Math.max(open, at + marker.length));
  if (between.includes(';')) throw new Error(`extractBlock：${JSON.stringify(marker)} 与块起始之间隔了语句，换个 marker`);
  const end = scanBalanced(source, open, `extractBlock(${JSON.stringify(marker)})`);
  return source.slice(at, end + 1);
}

// 取 `const name = <expr>;` 的表达式部分（用于钉布尔组合，不钉整句写法）。
function declarationExpr(source, name) {
  const marker = new RegExp(`^[ \\t]*const[ \\t]+${name}[ \\t]*=`, 'm');
  const match = marker.exec(source);
  if (!match) throw new Error(`declarationExpr：源码里找不到 const ${name} =`);
  const eq = source.indexOf('=', match.index);
  const semi = source.indexOf(';', eq);
  if (semi < 0) throw new Error(`declarationExpr：const ${name} = 之后没有分号`);
  return source.slice(eq + 1, semi).trim();
}

module.exports = { extractFunctionSource, extractBlock, declarationExpr, scanBalanced };
