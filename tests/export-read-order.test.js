// 审计 #7（O2 / P4）：导出读正文必须挪到保存对话框确认之后。
//
// main.js 是 Electron 主进程入口，node:test 里起不来，沿用仓库「读源码做静态闸门」的先例
// （tests/ipc-limits.test.js / tests/config-gate.test.js / tests/renderer-startup.test.js）。
// 这里只钉住时序，不测内容：
//   1. prepareExport 只做只读前置（书目 / 范围 / 配置 / 默认目录），不许读正文——
//      一旦在这里读，用户取消导出就又白读整本；
//   2. 三个导出入口都必须在 `if (canceled || !filePath) return { canceled: true };` 之后才读正文；
//   3. book:copy 本来就不走保存对话框，保持原样直接读。
// 以后重构可以改名改形，但「保存对话框确认之后才读正文」这条不许丢，改的时候同步改这里。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');

// 取「顶层声明」这一段：从锚点开始，切到下一个顶格两空格的函数 / handler 之前。
// 锚点用带缩进的完整声明串，避免撞上注释里的同名文字。
function sliceFrom(source, startMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `找不到锚点：${startMarker}`);
  const rest = source.slice(start + startMarker.length);
  const next = rest.search(/\n {2}(?:async function |function |handleBook\(|handle\()/);
  return next === -1 ? rest : rest.slice(0, next);
}

const PREPARE = sliceFrom(MAIN, '  async function prepareExport(bookPath, override, range) {');
const READ_AFTER = sliceFrom(MAIN, '  async function readExportTexts(bookPath, prepared) {');

test('静态闸门：prepareExport 只做只读前置，不读正文（#7）', () => {
  assert.doesNotMatch(PREPARE, /collectExportTexts/, 'prepareExport 不许读正文（否则取消导出就白读整本）');
  assert.doesNotMatch(PREPARE, /loadChapterText/, 'prepareExport 不许逐章读盘');
  // 只读前置该做的事照旧在，别为了挪正文把功能挪没了
  assert.match(PREPARE, /storage\.readBookMeta\(bookPath\)/, 'prepareExport 仍要读书目');
  assert.match(PREPARE, /ipcLimits\.sanitizeOverride\(override\)/, 'prepareExport 仍要过 override 闸门');
  assert.match(PREPARE, /exporter\.resolveExportRange\(meta, safeRange\)/, 'prepareExport 仍要解析范围');
  assert.match(PREPARE, /exporter\.resolveExportDir\(/, 'prepareExport 仍要算默认落点');
  // 干净的 override 要一起带出去，对话后读正文时别再重新解析一遍
  assert.match(PREPARE, /override: safeOverride/, 'prepareExport 要把 sanitize 过的 override 传给后半段');
});

test('静态闸门：readExportTexts 是 prepareExport 的后半段（#7）', () => {
  assert.match(READ_AFTER, /collectExportTexts\(/, 'readExportTexts 必须真的读正文');
  assert.match(READ_AFTER, /plan\.indexes/, 'readExportTexts 必须按已解析的范围下标读（保持空串占位对齐）');
  assert.match(READ_AFTER, /prepared/, 'readExportTexts 复用 prepareExport 的结果，不重新解析范围');
});

test('静态闸门：三个导出入口都在保存对话框确认之后才读正文（#7）', () => {
  for (const channel of ['book:export', 'book:export-epub', 'book:export-docx']) {
    const body = sliceFrom(MAIN, `  handleBook('${channel}', async (bookPath, override, range) => {`);
    const dialogAt = body.indexOf('await showSaveDialog(');
    const cancelAt = body.indexOf('if (canceled || !filePath) return { canceled: true };');
    const readAt = body.indexOf('await readExportTexts(bookPath, prepared)');
    assert.notEqual(dialogAt, -1, `${channel}：找不到保存对话框`);
    assert.notEqual(cancelAt, -1, `${channel}：找不到取消分支`);
    assert.notEqual(
      readAt,
      -1,
      `${channel}：正文读取没走 readExportTexts（可能又改回 prepareExport 里读了）`
    );
    assert.ok(dialogAt < cancelAt, `${channel}：取消分支必须在保存对话框之后`);
    assert.ok(
      cancelAt < readAt,
      `${channel}：正文必须在保存对话框确认之后才读（#7：取消导出不许白读整本）`
    );
    // 也不许绕过 readExportTexts 直接从 prepareExport 解构：那等于时序又回到对话框之前
    assert.doesNotMatch(
      body,
      /const \{[^}]*texts[^}]*\} = await prepareExport\(/,
      `${channel}：不许再从 prepareExport 拿 texts`
    );
  }
});

test('静态闸门：book:copy 不走保存对话框，保持原样直接读（#7 只动导出三入口）', () => {
  const body = sliceFrom(MAIN, "  handleBook('book:copy', async (bookPath, override) => {");
  assert.doesNotMatch(body, /showSaveDialog/, '复制整本不该弹保存对话框');
  assert.match(
    body,
    /collectExportTexts\(bookPath, meta, safeOverride\)/,
    'book:copy 保持原来的直接读取'
  );
});
