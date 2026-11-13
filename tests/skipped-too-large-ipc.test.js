// R4b（V9）/ V40：core 已经让四个整本操作各自回报 skippedTooLarge（超限章跳过、文件不动、不整批失败），
// 主进程必须把这个数字原样带进 IPC 结果 —— 否则渲染层永远只能显示「0 章跳过」，
// 作者会以为超限章也一起处理了（其实那次操作没碰它们）。
//
// V40 收掉了恒等复制助手 withSkippedTooLarge：四个 IPC 入口现在直接 return core 的结果。
// 这里不再切源码找函数名，而是把四个 handler 的注册语句放进假作用域真跑一遍：
// core 替身返回什么对象，handler 就必须原样（同一个引用）返回什么对象 —— 中间多包一层、
// 少带一个字段、拼一个新对象都会被抓到。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const readSource = (rel) =>
  require('node:fs').readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

const mainSource = readSource('main.js');

// 从 `handleBook('频道', ...)` 的锚点切到这一条注册语句的右括号（括号按嵌套层级配平）。
function extractCall(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, '找不到锚点：' + marker);
  const open = source.indexOf('(', start);
  assert.notEqual(open, -1, '锚点后找不到参数列表：' + marker);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.notEqual(end, -1, '括号没闭合：' + marker);
  return source.slice(start, end) + ';';
}

// 频道 → main.js 里的注册锚点 ／ core 替身要走的 storage 方法 ／ 这轮要透传的跳过章数。
const SITES = [
  ['book:search', "handleBook('book:search',", 'searchBook', 3],
  ['book:replace', "handleBook('book:replace',", 'replaceInBook', 0],
  ['book:format-preview', "handleBook('book:format-preview',", 'previewFormatBook', 2],
  ['book:format', "handleBook('book:format',", 'formatBook', 1]
];

// 把某一条 handler 注册语句放进假作用域执行，拿回真正的回调函数与 core 替身返回的哨兵对象。
// handleBook 只负责接住回调；storage 的四个方法各自返回同一个哨兵（同一个引用），
// 这样「原样透传」可以用 === 直接验证。
function loadIpcHandler([channel, marker, method, skippedTooLarge]) {
  const sentinel = { skippedTooLarge, results: [channel], chapterCount: 9 };
  const storage = {
    searchBook: async () => sentinel,
    replaceInBook: async () => sentinel,
    previewFormatBook: async () => sentinel,
    formatBook: async () => sentinel
  };
  let captured = null;
  const fakeHandleBook = (name, fn) => {
    captured = { name, fn };
  };
  const statement = extractCall(mainSource, marker);
  new Function('handleBook', 'storage', 'ipcLimits', 'sendToFlow', statement)(
    fakeHandleBook,
    storage,
    { sanitizeSearchOptions: (value) => value, sanitizeReplaceOptions: (value) => value },
    () => {}
  );
  assert.equal(captured && captured.name, channel, `${channel} 的注册语句没有注册出回调`);
  assert.equal(typeof captured.fn, 'function', `${channel} 的回调必须是函数`);
  return { handler: captured.fn, sentinel, method };
}

test('行为：整本查找 / 替换 / 排版预览 / 整理把 core 的 skippedTooLarge 原样透传（R4b/V40）', async () => {
  for (const site of SITES) {
    const [channel] = site;
    const { handler, sentinel } = loadIpcHandler(site);
    const result = await handler('D:\\假书库\\假书', {});
    assert.equal(result, sentinel, `${channel} 必须原样返回 core 的结果对象（不许再复制 / 拼字段）`);
    assert.equal(
      result.skippedTooLarge,
      sentinel.skippedTooLarge,
      `${channel} 的 skippedTooLarge 原样透传（含 0 章跳过）`
    );
  }
});