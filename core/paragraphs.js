/* 段落切分（自然段 / 行 / 去首尾空白）——纯逻辑，不碰 DOM、不读盘、不写盘、不依赖 Electron。
 *
 * 为什么单独一个文件（v0.9 B-3 / 外部审计 F3）：这条规则原来有**两份实现**，改一处得记得改另一处：
 *   - core/tts.js 的 paragraphRanges（朗读切分的第一刀）+ 内部 trimmedRange；
 *   - renderer/editor-logic.js 的 paragraphRanges + lineRanges（段落导航 / 当前段落高亮 / 不可见字符）。
 * 两份的字面实现本来就一致（见 tests/paragraphs.test.js 的跨实现闸门），只是各自的辅助函数不同。
 * 收编的原则是**段落切分结果零变化**：同一批边界输入（CRLF / BOM / 全角空格 / NBSP / 制表 / 空行 / 行尾空白 /
 * 代理对 / 末尾换行）在两端的 start / end / paragraph / line 逐字一致，单测把期望值写死。
 *
 * 规则（改之前先想清楚，这是「一个非空行 = 一段」这条产品口径的唯一实现）：
 *   - 一个自然段 = 一个非空行；空行（只有空白也算）不成段，段号跳过它；
 *   - 段的首尾空白不算正文：\s 覆盖空格 / 制表 / CR / LF / 全角空格 U+3000 / NBSP U+00A0 / BOM U+FEFF /
 *     行段分隔符 U+2028 U+2029 等（和 String#trim 的字符集一致）；
 *   - paragraph（段号）从 1 开始，line（行号）从 1 开始，都按 1 基；空行只占 line 不占 paragraph；
 *   - start / end 是**传进来那段文本**的字符下标（0 基、左闭右开），end 不含换行符；对 CRLF 文本，
 *     行尾的 \r 被当作空白裁掉，但下一行的 start 仍然按 \r\n 两个字符算——所以下标永远能直接用于
 *     setSelectionRange（渲染层）/ slice（core 侧）。
 *
 * 唯一一处**既有的实现差异**（记录在案，不是本轮引入的）：非字符串入参。旧 core/tts.js 直接 text.split，
 * 传 null / 数字会抛 TypeError；旧 renderer/editor-logic.js 用 toText 先转字符串。这里统一到宽松的一侧
 * （toText），因为产品调用方（tts.buildChunks、渲染层的编辑区 value）永远传字符串，宽松侧对正常输入零影响，
 * 对坏输入更稳。所有字符串输入的结果与改前逐字一致（改前 / 改后 32 组输入的 JSON 快照比对）。
 *
 * 边界（红线）：
 *   - 只做切分与去空白，**不含任何业务规则**（不分句、不数字数、不碰标点表）；
 *   - 不 require 任何模块、不碰 process / window / document（UMD 挂载那一行除外）；
 *   - 主进程（core/tts.js）、渲染层（index.html 里 <script src="../core/paragraphs.js">）与单测三处共用，
 *     所以写成 UMD：Node 里 require 得到对象，浏览器里挂到 window.CWParagraphs。
 *
 * 加载顺序（浏览器）：index.html 里 core/paragraphs.js 必须排在 renderer/editor-logic.js 之前；
 * editor-logic 拿不到 window.CWParagraphs 会直接抛错，而不是悄悄退回一份旧副本。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWParagraphs = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 坏输入按空文本处理（和 editor-logic 旧实现的 toText 一致）：产品路径永远传字符串，这里只是兜底。
  function toText(value) {
    return String(value == null ? '' : value);
  }

  // 把 [start, end) 两端的空白（含全角空格）去掉；全空白返回 null。
  // 调用方保证 start / end 是 [0, text.length] 里的整数（内部调用点都是从 split('\n') 算出来的）。
  function trimmedRange(text, start, end) {
    let s = start;
    let e = end;
    while (s < e && /\s/.test(text[s])) s += 1;
    while (e > s && /\s/.test(text[e - 1])) e -= 1;
    return e > s ? { start: s, end: e } : null;
  }

  // 每一行（含空行）的 [start, end)；end 不含换行符。blank = 只有空白（含全角空格）。
  // 末尾带换行时最后会多出一条 start === end 的空行（和 split('\n') 的行为一致，「当前段落」靠它判末行）。
  function lineRanges(text) {
    const source = toText(text);
    const ranges = [];
    let start = 0;
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      const end = start + raw.length;
      ranges.push({ start, end, line: i + 1, blank: raw.trim() === '' });
      start = end + 1; // 加回换行符
    }
    return ranges;
  }

  // 每个非空行算一个自然段；返回 { start, end, paragraph, line }（start / end 已去掉首尾空白）。
  // 段号只数非空行（空行跳过不占号），行号跟着物理行走。
  function paragraphRanges(text) {
    const source = toText(text);
    const ranges = [];
    let paragraph = 0;
    for (const line of lineRanges(source)) {
      const range = trimmedRange(source, line.start, line.end);
      if (!range) continue;
      paragraph += 1;
      ranges.push({ start: range.start, end: range.end, paragraph, line: line.line });
    }
    return ranges;
  }

  return { trimmedRange, lineRanges, paragraphRanges };
});
