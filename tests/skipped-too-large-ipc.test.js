// R4b（V9）：core 已经让四个整本操作各自回报 skippedTooLarge（超限章跳过、文件不动、不整批失败），
// 主进程必须把这个数字带进 IPC 结果 —— 否则渲染层永远只能显示「0 章跳过」，
// 作者会以为超限章也一起处理了（其实那次操作没碰它们）。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const readSource = (rel) =>
  require('node:fs').readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

const mainSource = readSource('main.js');

// 从锚点切到下一个顶格两空格的函数 / handler 之前（与 tests/book-batch.test.js 同一手法）
function sliceFrom(source, startMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `找不到锚点：${startMarker}`);
  const rest = source.slice(start + startMarker.length);
  const next = rest.search(/\n {2}(?:async function |function |handleBook\(|handle\()/);
  return next === -1 ? rest : rest.slice(0, next);
}

test('静态闸门：整本查找 / 替换 / 排版预览 / 整理把 skippedTooLarge 透传进 IPC 结果（R4b）', () => {
  const sites = [
    ['book:search', "  handleBook('book:search', async (bookPath, options) =>"],
    ['book:replace', "  handleBook('book:replace', async (bookPath, options) =>"],
    ['book:format-preview', "  handleBook('book:format-preview', async (bookPath, options) =>"],
    ['book:format', "  handleBook('book:format', async (bookPath, options) =>"]
  ];
  for (const [channel, anchorText] of sites) {
    const body = sliceFrom(mainSource, anchorText);
    assert.match(
      body,
      /withSkippedTooLarge\(await storage\./,
      `${channel} 要把 core 返回的 skippedTooLarge 放进 IPC 结果（走同一个透传助手）`
    );
  }
  // 助手本身：0 章跳过时原样返回（旧结果形状不动），有跳过时才复制一份并保留数字
  const helper = sliceFrom(mainSource, 'function withSkippedTooLarge(result) {');
  assert.match(helper, /skippedTooLarge/, '助手要读 core 的累计数');
  assert.match(helper, /\.\.\.result/, '有跳过时复制结果再补字段，不改原对象的其它字段');
});
