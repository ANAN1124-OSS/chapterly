'use strict';
// 渲染层装配块生成 / 校验（WP17 M-N1，审计 #20 / M-N1）：index.html 的 69 条 <script> 不再手写，
// 由 renderer/assembly-manifest.js 的 MODULES 生成并注入到标记块里。
//
// 为什么：以前「加一个模块」要同时改 index.html 的 <script>、renderer.js 的本地名、测试里的静态闸门。
// 清单已经收掉了顺序与全局名（审计 #55 / M4），这里再收掉 index.html 的文本：新增模块只改清单一处，
// 跑 `node scripts/assembly-sync.js --write` 重新生成；`--check` 由 tests/wp17-refactor.test.js R9
// 与 scripts/wiring-check.js 一起把关，手改块内文本 / 块外再插 <script> 都会红。
//
// 契约（改这里之前先看 tests/wp17-refactor.test.js › R9 与 tests/wiring-manifest.test.js）：
//   · 块内 = 清单 MODULES 每项的 [0]（相对 renderer/ 的路径，core/ 用 ../core/）按序 + 末尾
//     assembly-manifest.js → renderer.js 两个装配脚本；一条模块一行，2 空格缩进；
//   · 块内文本逐字节由本脚本生成（行尾跟随 index.html 现有风格：CRLF / LF），块外不允许再出现
//     <script src>（防止绕过清单手插模块）；
//   · BEGIN / END 标记各恰好一个，顺序为 BEGIN → scripts → END。
//
// CLI：node scripts/assembly-sync.js [--check | --write] [--root <目录>] [--json]
//   --check（默认）通过 exit 0；标记缺失 / 块与清单不一致 exit 1；根目录或来源读不了 exit 2。
//   --write 只在文本真有变化时写盘；不改 renderer.js，也不拆模块。
const fs = require('node:fs');
const path = require('node:path');

const BEGIN_MARKER = '<!-- ASSEMBLY:BEGIN -->';
const END_MARKER = '<!-- ASSEMBLY:END -->';
const TAIL_SCRIPTS = ['assembly-manifest.js', 'renderer.js'];

function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function manifestPathOf(root) {
  return path.join(root, 'renderer', 'assembly-manifest.js');
}

function indexHtmlPathOf(root) {
  return path.join(root, 'renderer', 'index.html');
}

function loadManifest(root) {
  const manifestPath = manifestPathOf(root);
  // 同一进程里对多个 root 反复检查（单测夹具）时，模块缓存会让后一个 root 读到前一个的清单。
  delete require.cache[require.resolve(manifestPath)];
  return require(manifestPath);
}

function buildBlock(manifest, eol = '\n') {
  const files = manifest.MODULES.map((entry) => entry[0]).concat(TAIL_SCRIPTS);
  return files.map((file) => `  <script src="${file}"></script>`).join(eol);
}

// 定位标记块：返回块正文的 [start, end) 区间（不含 BEGIN / END 两行）。
function locateBlock(html) {
  const beginCount = html.split(BEGIN_MARKER).length - 1;
  const endCount = html.split(END_MARKER).length - 1;
  if (beginCount !== 1 || endCount !== 1) {
    throw new Error(`index.html 的装配标记必须各恰好 1 个（实际 BEGIN ${beginCount} / END ${endCount}）`);
  }
  const beginAt = html.indexOf(BEGIN_MARKER);
  const endAt = html.indexOf(END_MARKER);
  if (endAt < beginAt) throw new Error('装配标记顺序颠倒：END 在 BEGIN 之前');
  const bodyStart = html.indexOf('\n', beginAt) + 1;
  const bodyEnd = html.lastIndexOf('\n', endAt) + 1;
  if (bodyStart <= 0 || bodyEnd <= bodyStart) throw new Error('装配标记块为空：BEGIN 与 END 之间没有正文');
  return { bodyStart, bodyEnd };
}

function extractBlock(html) {
  const { bodyStart, bodyEnd } = locateBlock(html);
  return html.slice(bodyStart, bodyEnd);
}

function applyBlock(html, block) {
  const { bodyStart, bodyEnd } = locateBlock(html);
  const eol = detectEol(html);
  return html.slice(0, bodyStart) + block + eol + html.slice(bodyEnd);
}

// 块外不允许再出现 <script src>（标记块之外的模块脚本 = 绕过清单的手工装配）。
function outsideScripts(html) {
  const { bodyStart, bodyEnd } = locateBlock(html);
  const outside = html.slice(0, bodyStart - BEGIN_MARKER.length) + html.slice(bodyEnd + END_MARKER.length);
  return [...outside.matchAll(/<script\b[^>]*\bsrc\s*=/gi)].length;
}

function checkHtml(html, manifest) {
  const eol = detectEol(html);
  const expected = buildBlock(manifest, eol) + eol;
  let actual;
  try {
    actual = extractBlock(html);
  } catch (err) {
    return { ok: false, reason: err.message, expected, actual: null, line: null, expectedLine: null, actualLine: null };
  }
  if (actual === expected) {
    if (outsideScripts(html) > 0) {
      return {
        ok: false,
        reason: '装配标记块外还有 <script src>：模块脚本必须全部由清单生成',
        expected,
        actual,
        line: null,
        expectedLine: null,
        actualLine: null
      };
    }
    return { ok: true, expected, actual, line: null, expectedLine: null, actualLine: null };
  }
  const expectedLines = expected.split(/\r?\n/);
  const actualLines = actual.split(/\r?\n/);
  let index = 0;
  while (index < Math.max(expectedLines.length, actualLines.length)
    && expectedLines[index] === actualLines[index]) index += 1;
  return {
    ok: false,
    reason: '装配块与 renderer/assembly-manifest.js 不一致（手改或漏跑 --write）',
    expected,
    actual,
    line: index + 1,
    expectedLine: expectedLines[index] === undefined ? '（块到此结束）' : expectedLines[index],
    actualLine: actualLines[index] === undefined ? '（块到此结束）' : actualLines[index]
  };
}

function checkRoot(root) {
  const html = fs.readFileSync(indexHtmlPathOf(root), 'utf8');
  const manifest = loadManifest(root);
  const result = checkHtml(html, manifest);
  return { ...result, modules: manifest.MODULES.length };
}

function writeRoot(root) {
  const htmlPath = indexHtmlPathOf(root);
  const html = fs.readFileSync(htmlPath, 'utf8');
  const manifest = loadManifest(root);
  const next = applyBlock(html, buildBlock(manifest, detectEol(html)));
  const changed = next !== html;
  if (changed) fs.writeFileSync(htmlPath, next, 'utf8');
  return { changed, modules: manifest.MODULES.length };
}

function usage() {
  return '用法：node scripts/assembly-sync.js [--check | --write] [--root <目录>] [--json]';
}

function main(argv) {
  const args = argv.slice(2);
  let mode = 'check';
  let rootArg = null;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--write') mode = 'write';
    else if (args[i] === '--check') mode = 'check';
    else if (args[i] === '--json') json = true;
    else if (args[i] === '--root') {
      rootArg = args[i + 1];
      if (!rootArg) {
        console.error(`--root 后面要跟一个目录\n${usage()}`);
        return 2;
      }
      i += 1;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(usage());
      return 0;
    } else {
      console.error(`未知参数：${args[i]}\n${usage()}`);
      return 2;
    }
  }
  const root = path.resolve(rootArg || path.join(__dirname, '..'));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`根目录不存在：${root}`);
    return 2;
  }
  try {
    if (mode === 'write') {
      const result = writeRoot(root);
      console.log(
        result.changed
          ? `装配块已按清单重写：${result.modules} 个模块 + assembly-manifest.js → renderer.js`
          : `装配块与清单已一致，未写盘：${result.modules} 个模块`
      );
      return 0;
    }
    const result = checkRoot(root);
    if (json) {
      console.log(JSON.stringify({ ok: result.ok, modules: result.modules, reason: result.reason, line: result.line }));
    }
    if (result.ok) {
      console.log(`装配块一致：${result.modules} 个模块 + assembly-manifest.js → renderer.js（由清单生成）`);
      return 0;
    }
    console.error(`装配块校验未通过：${result.reason}`);
    if (result.line) {
      console.error(`  第 ${result.line} 行：应为「${result.expectedLine}」，实际「${result.actualLine}」`);
    }
    console.error('  修法：node scripts/assembly-sync.js --write');
    return 1;
  } catch (err) {
    console.error(`装配检查失败：${err.code ? err.code + ' ' : ''}${err.message}`);
    return 2;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv);
}

module.exports = {
  BEGIN_MARKER,
  END_MARKER,
  TAIL_SCRIPTS,
  detectEol,
  buildBlock,
  extractBlock,
  applyBlock,
  checkHtml,
  checkRoot,
  writeRoot
};