// 2026-11-04 拍板视觉项 · 静态钉子（长跑 b7 的「测试补齐」）
//
// 为什么还要这一份：b1 / b4 / b5 那几批已经给每项补了 E2E 几何断言（书架封顶、F11 键帽、朗读条 28px、
// 历史分栏……），但 E2E 量的是「窗口里的实际像素」，受窗口尺寸、字体、滚动条宽度影响，偶发一次就被当成
// 环境问题重跑；而这几项**只由 CSS / index.html 的几行决定**，真正怕的是「以后有人顺手把这行删了」。
// 所以这里用源码闸门钉住「决定本身」：改回去（或改数字）立即红，一眼看出是哪一项的拍板被人动了。
//
// 口径：只钉**决定**（排行号无关的结构 + 关键数值 + 关系），不钉注释措辞、不钉格式化，
// 避免「改一句注释就要改测试」。其余 12 项（#1 千分位、#3 设置 ×、#6 toast 抬起、#8 询问框顺序、
// #9 灵感箱分组、#16a/b/c 键盘）已经在各自的域单测里有行为 / 静态闸门，这里不重复。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CSS = read('renderer/styles.css');
const HTML = read('renderer/index.html');

// 取一个选择器规则块（`选择器 { … }`，非贪婪到第一个 `}`；本文件的规则里没有嵌套花括号）。
// 允许选择器前面有缩进（@media 里的规则是缩进两格的），也允许单行规则（`{ flex-direction: row; }`）。
function ruleOf(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(^|\\n)[ \\t]*${escaped}[ \\t]*\\{([\\s\\S]*?)\\}`).exec(source);
  return match ? match[2] : '';
}

// 取一个 @media 块（本文件的 @media 都是一层、内部规则不嵌套 @media）
function mediaOf(source, query) {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = source.indexOf(`@media ${query}`);
  if (start < 0) return '';
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return '';
}

test('#2 宽屏书架内容封顶：@media (min-width:1600px) 把 .shelf-body 封到 1576px 居中（= 1520 网格 + 28×2 + 10 滚动条槽）', () => {
  const block = mediaOf(CSS, '(min-width: 1600px)');
  assert.ok(block, 'styles.css 里必须有 @media (min-width: 1600px) 这一段（拍板 #2）');
  const body = ruleOf(block, '.shelf-body');
  assert.ok(body, '这段里必须有 .shelf-body 规则（封顶的就是它，不是 .shelf-scroll）');
  assert.match(body, /max-width:\s*1576px;/, '.shelf-body 必须封到 1576px（1520 网格 + 28×2 边距 + 10 常驻滚动条槽）');
  assert.match(body, /margin-left:\s*auto;/, '必须居中（左 auto）');
  assert.match(body, /margin-right:\s*auto;/, '必须居中（右 auto）');
  // 底栏跟内容同一条左边缘：padding 用同一个 1576 常量算，不能写死
  const footer = ruleOf(block, '.shelf-footer');
  assert.ok(footer, '这段里必须有 .shelf-footer 规则（发丝线要跟着内容对齐）');
  assert.match(footer, /padding-left:\s*calc\(28px \+ max\(0px, \(100% - 1576px\) \/ 2\)\);/, '底栏左边距必须与封顶后的内容对齐');
  assert.match(footer, /padding-right:\s*calc\(28px \+ max\(0px, \(100% - 1576px\) \/ 2\)\);/, '底栏右边距必须对称');
});

test('#5 专注退出条：Esc / F11 两个键帽并排，键帽间隔 4px', () => {
  const button = /<button id="btn-focus-exit"[\s\S]*?<\/button>/.exec(HTML);
  assert.ok(button, 'index.html 里必须有专注退出按钮 #btn-focus-exit');
  assert.match(button[0], /<span class="focus-kbd">Esc<\/span>/, '退出条要显示 Esc 键帽');
  assert.match(button[0], /<span class="focus-kbd">F11<\/span>/, '拍板 #5：退出条也要显示 F11 键帽（Esc 之外还能按 F11 退出）');
  assert.match(button[0], /title="[^"]*F11[^"]*"/, '按钮 title 也要提到 F11，否则鼠标用户不知道');
  const kbd = ruleOf(CSS, '.focus-kbd');
  assert.ok(kbd, 'styles.css 必须有 .focus-kbd 键帽样式');
  const pair = ruleOf(CSS, '.focus-kbd + .focus-kbd');
  assert.ok(pair, '两个键帽并排时必须有 .focus-kbd + .focus-kbd 的间距规则');
  assert.match(pair, /margin-left:\s*4px;/, '键帽间距是 4px（拍板值）');
});

test('#7 朗读条控件统一 28px：按钮与下拉同高，× 关闭键不在内', () => {
  const buttons = ruleOf(CSS, '.tts-bar .btn:not(.tts-close)');
  assert.ok(buttons, '朗读条按钮必须有 .tts-bar .btn:not(.tts-close) 规则（× 关闭键不能被一起拉高）');
  assert.match(buttons, /height:\s*28px;/, '朗读条按钮高度 = 28px（拍板 #7）');
  assert.match(buttons, /min-height:\s*28px;/, 'min-height 也要写，否则 .btn 的基准会顶回去');
  const inputs = ruleOf(CSS, '.tts-bar .text-input');
  assert.ok(inputs, '朗读条下拉必须有 .tts-bar .text-input 规则');
  assert.match(inputs, /height:\s*28px;/, '下拉高度 = 28px，与按钮齐平');
  assert.match(inputs, /min-height:\s*28px;/);
  // 反向：28px 的规则不许漏掉 :not(.tts-close) 去命中关闭键（改回 `.tts-bar .btn` 就会红）
  assert.equal(ruleOf(CSS, '.tts-bar .btn'), '', '不许出现不分按钮类型的 .tts-bar .btn 规则（会连 × 一起拉高）');
});

test('#13 历史预览宽窗左右分栏：.history-main 做 flex 容器，≥980 列表 58% / 预览 40%，窄窗回落上下', () => {
  // DOM：列表与预览都在 .history-main 里（顺序不变，只多一层布局容器）
  const mainAt = HTML.indexOf('class="history-main"');
  assert.ok(mainAt > 0, 'index.html 里必须有 .history-main 布局容器（拍板 #13）');
  const listAt = HTML.indexOf('history-list', mainAt);
  const previewAt = HTML.indexOf('history-preview', mainAt);
  assert.ok(listAt > mainAt, '历史列表必须在 .history-main 里面');
  assert.ok(previewAt > mainAt, '历史预览必须在 .history-main 里面');
  assert.ok(listAt < previewAt, 'DOM 顺序保持「列表在前、预览在后」（Tab 顺序不变）');
  // CSS：窄窗竖排（默认），宽窗横排 + 比例
  const main = ruleOf(CSS, '.history-main');
  assert.ok(main, 'styles.css 必须有 .history-main 基础规则');
  assert.match(main, /display:\s*flex;/, '默认是 flex 容器');
  assert.match(main, /flex-direction:\s*column;/, '窄窗（<980）回落上下排');
  const wide = mediaOf(CSS, '(min-width: 980px)');
  assert.ok(wide, 'styles.css 里必须有 @media (min-width: 980px) 这一档（应用最小宽 960，分栏从 980 起）');
  assert.match(ruleOf(wide, '.history-main'), /flex-direction:\s*row;/, '≥980 改成左右排');
  assert.match(ruleOf(wide, '.history-scroll'), /flex:\s*1 1 58%;/, '列表占 58%');
  assert.match(ruleOf(wide, '.history-preview'), /flex:\s*0 0 40%;/, '预览占 40%');
});
