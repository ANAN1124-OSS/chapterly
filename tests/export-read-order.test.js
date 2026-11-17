// 审计 #7（O2 / P4）：导出读正文必须挪到保存对话框确认之后。
//
// 导出区在 v1.8.0 WP-34（V114）整段搬进 ipc/export.js；主进程入口 node:test 里起不来，沿用仓库「读源码做静态闸门」的先例
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

// 导出 / 复制域的唯一来源（WP-34 后 main.js 只做装配，代码在 ipc/export.js）。
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'ipc', 'export.js'), 'utf8').replace(/\r\n/g, '\n');

// 取「顶层声明」这一段：从锚点开始，切到下一个顶格两空格的函数 / handler 之前。
// 锚点用带缩进的完整声明串，避免撞上注释里的同名文字。
function sliceFrom(source, startMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `找不到锚点：${startMarker}`);
  const rest = source.slice(start + startMarker.length);
  const next = rest.search(/\n {2}(?:async function |function |handleBook\(|handle\()/);
  return next === -1 ? rest : rest.slice(0, next);
}

// 取函数体：从锚点到同缩进的下一个 `\n  }\n`（只读函数本身，不吃后面的注释段落）。
function sliceBody(source, startMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `找不到锚点：${startMarker}`);
  const end = source.indexOf('\n  }\n', start);
  assert.notEqual(end, -1, `找不到函数结尾：${startMarker}`);
  return source.slice(start, end + 4);
}

const PREPARE = sliceBody(MAIN, '  async function prepareExport(bookPath, override, range) {');

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

test('静态闸门：EPUB / DOCX 的逐章读取是 prepareExport 的后半段（#7 / B1）', () => {
  // B1（审计 #17 / WP13）：整本 readExportTexts 收掉，正文改由 exportStructured 的 readText
  // 回调逐章供给格式的流式构建。这里钉住「回调真的读盘、按已解析的范围读、复用 prepared」。
  assert.equal(MAIN.includes('async function readExportTexts('), false, '整本读取的 readExportTexts 已删除');
  const KERNEL = sliceFrom(MAIN, '  async function exportStructured(bookPath, override, range, options) {');
  assert.match(KERNEL, /readText: async \(index, chapter\) =>/, '共享内核要定义逐章读取回调');
  assert.match(KERNEL, /storage\.loadChapterText\(bookPath, chapter\.file\)/, '逐章读取必须真的读盘');
  assert.match(KERNEL, /prepared\.override/, '逐章读取复用 prepareExport 的 override');
  assert.match(KERNEL, /prepared\.plan\.indexes/, 'includedUnsaved 要按已解析的范围下标判');
});

test('静态闸门：三个导出入口都在保存对话框确认之后才读正文（#7 / 审计 #24 R2）', () => {
  // B5（v1.8.0 WP-28）：TXT 改成流式写盘后不再走 readExportTexts，但「正文只在对话框确认后读」
  // 这条不变——它现在锚在 writeTxtExport（内部才是 streamTxtExport 的逐章读取）。
  // 审计修复 #24（R2）：EPUB / DOCX 的整段流程收进 exportStructured 一份（两个入口只传
  // 对话框文案 / 默认文件名 / build 函数），所以时序断言锚在共享内核里，入口侧只钉「确实走内核」。
  const TXT_BODY = sliceFrom(MAIN, "  handleBook('book:export', async (bookPath, override, range) => {");
  const TXT_DIALOG = TXT_BODY.indexOf('await showSaveDialog(');
  const TXT_CANCEL = TXT_BODY.indexOf('if (canceled || !filePath) return { canceled: true };');
  const TXT_READ = TXT_BODY.indexOf('await writeTxtExport(filePath, bookPath, prepared)');
  assert.notEqual(TXT_DIALOG, -1, 'TXT：找不到保存对话框');
  assert.notEqual(TXT_CANCEL, -1, 'TXT：找不到取消分支');
  assert.notEqual(TXT_READ, -1, 'TXT：正文读取没走 writeTxtExport');
  assert.ok(TXT_DIALOG < TXT_CANCEL, 'TXT：取消分支必须在保存对话框之后');
  assert.ok(TXT_CANCEL < TXT_READ, 'TXT：正文必须在保存对话框确认之后才读（#7）');

  // 共享内核：对话框 → 取消分支 → 流式写盘（内部逐章读正文），顺序不许反；也不许绕过内核从 prepareExport 拿 texts。
  const KERNEL = sliceFrom(MAIN, '  async function exportStructured(bookPath, override, range, options) {');
  const DIALOG = KERNEL.indexOf('await showSaveDialog(');
  const CANCEL = KERNEL.indexOf('if (canceled || !filePath) return { canceled: true };');
  const READ = KERNEL.indexOf('await atomicWriteFileStream(filePath');
  assert.notEqual(DIALOG, -1, 'exportStructured：找不到保存对话框');
  assert.notEqual(CANCEL, -1, 'exportStructured：找不到取消分支');
  assert.notEqual(READ, -1, 'exportStructured：正文读取没走约定的入口（可能又改回 prepareExport 里读了）');
  assert.ok(DIALOG < CANCEL, 'exportStructured：取消分支必须在保存对话框之后');
  assert.ok(CANCEL < READ, 'exportStructured：正文必须在保存对话框确认之后才读（#7：取消导出不许白读整本）');
  assert.doesNotMatch(KERNEL, /const \{[^}]*texts[^}]*\} = await prepareExport\(/);
  assert.doesNotMatch(KERNEL, /readExportTexts|collectExportTexts/, '共享内核不许再整本读 texts（B1 流式）');

  // 两个格式入口：都只委托共享内核，不许把「弹框 → 读正文」再抄一份回来（#24 R2 的回潮闸门）。
  for (const [channel, streamCall] of [
    ['book:export-epub', 'epubLib.streamEpub('],
    ['book:export-docx', 'docxLib.streamDocx(']
  ]) {
    // 锚点本身是「channel 行 + 下一行 exportStructured(」，找到了就等于确实委托了共享内核
    const body = sliceFrom(MAIN, `  handleBook('${channel}', async (bookPath, override, range) =>\n    exportStructured(`);
    assert.equal(body.includes('showSaveDialog('), false, `${channel}：不许再自己弹保存对话框`);
    assert.equal(body.includes('readText'), false, `${channel}：不许再自己读正文`);
    assert.ok(body.includes(streamCall), `${channel}：流式构建函数要传进共享内核`);
    assert.ok(body.includes('defaultName:'), `${channel}：默认文件名要传进共享内核`);
  }
});

test('静态闸门：TXT 导出流式写盘（B5/WP-28）——逐块写出、不物化整本', () => {
  const body = sliceFrom(MAIN, '  async function writeTxtExport(filePath, bookPath, prepared) {');
  assert.match(body, /atomicWriteFileStream\(filePath/, 'TXT 导出要写临时文件再 rename（原子写）');
  assert.match(body, /exporter\.streamTxtExport\(meta, prepared\.range/, '正文由 streamTxtExport 逐章读');
  assert.match(body, /await write\(exporter\.BOM\)/, 'BOM 必须写在最前面（老工具识别 UTF-8）');
  assert.doesNotMatch(body, /collectExportTexts|buildTxtExport|composeBook|exportBufferFromText|Buffer\.from/, '流式路径不许退回整本拼接 / 整本 Buffer');
  assert.doesNotMatch(body, /readExportTexts/, 'TXT 流式路径不许退回整本 texts 数组');
  assert.match(body, /onChunk: \(chunk\) => write\(chunk\)/, '每一块直接写盘，不在内存里 join 整本');
});

test('静态闸门：book:copy 不走保存对话框，保持原样直接读（#7 只动导出三入口）', () => {
  // 1.5.0 功能-1 起多了可选第三参数 indexes（只复制选中的章）；签名随行为一起更新。
  const body = sliceFrom(MAIN, "  handleBook('book:copy', async (bookPath, override, indexes) => {");
  assert.doesNotMatch(body, /showSaveDialog/, '复制整本不该弹保存对话框');
  assert.match(
    body,
    /collectExportTexts\(bookPath, meta, safeOverride, selected\)/,
    'book:copy 保持原来的直接读取（只把可选的下标集合传下去）'
  );
});
