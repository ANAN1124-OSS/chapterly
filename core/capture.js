/* 剪贴板捕获的纯文本逻辑：归一化、整条记录的标题拆分、列表用的截断预览。
 *
 * 这里不读盘、不 require electron、不碰剪贴板：主进程把 clipboard.readText() 的原文交进来，
 * 得到「这条记录该拿哪一段当章名、正文是什么」；面板列表再拿截断预览整条展示。
 * 逐行三态表单（分析 / 改标签 / 拼正文）已随 v0.13.2 面板改造删除：现在每条复制记录就是
 * 整块一条，作者只点「正文 / 章节」，不再逐行确认，所以这里只保留标题规则与预览两件事。
 *
 * 同时被 Node（main.js / 单测）和渲染层（index.html 里 <script>）使用：
 * Node 里 require 得到对象（并拿到 core/txt.js 的 parseHeading 与 core/chapters.js 的 countChars），
 * 浏览器里挂到 window.CWCapture（渲染层只用 recordPreview / countChars，不做标题识别）。
 * 「正字数」口径走 core/chapters.js 的唯一实现（v0.9 B-2），本文件不复制「剔除空白」的 replace。
 *
 * 边界：章名一般 ≤ 40 字（core/chapters.js 的 MAX_NAME_LENGTH；整条不足 100 字时当章名的
 * 例外允许超过 40 字，这是作者拍板的），单章正文上限 30 万字（超过请走「导入小说」分流）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./txt'), require('./chapters'), require('./common'), require('./heading'));
  } else if (root) {
    root.CWCapture = factory(null, root.CWChapters, root.CWCommon, root.CWHeading);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (txtLib, chaptersLib, commonLib, headingLib) {
  'use strict';

  // stripBom 从 core/common.js 来（B6）：和原子读写 / 导入 / 查找共用同一份。
  // 浏览器里 core/common.js 必须排在 core/capture.js 之前（index.html 里它是第一个脚本）。
  if (!commonLib || typeof commonLib.stripBom !== 'function') {
    throw new TypeError('CWCapture：core/common.js 没有先加载');
  }
  // A1 / V113（v1.8.0 WP-30）：标题词表统一在 core/heading.js。浏览器里没有 core/txt.js，
  // 这条锚点正则就是「像不像标题」的唯一兜底；缺 heading 直接报错，不退回本地词表副本。
  if (!headingLib || typeof headingLib.anchorRe !== 'function') {
    throw new TypeError('CWCapture：core/heading.js 没有先加载');
  }
  const { stripBom } = commonLib;

  // 章名上限：与 core/chapters.js 同一常量（40）。文件名由 storage 再截一次，章名字段本身不改。
  const MAX_NAME_LENGTH = chaptersLib.MAX_NAME_LENGTH;
  // 旧名字保留：渲染层过去按 MAX_TITLE_LENGTH 取 40，改名只会制造无谓的跨文件同步。
  const MAX_TITLE_LENGTH = MAX_NAME_LENGTH;
  const MIN_BODY_CHARS = 50; // 规则①「其余正文」下限：太少说明多半是误把正文首行当标题
  const TITLE_ONLY_CHARS = 100; // 整条不足 100 字：整条当章名（作者拍板的例外，允许超过 40 字）
  // 单条捕获正文上限（原始长度）；超过走导入流程。2026-11-08 按作者要求 10 万 → 30 万字
  // （与标记层 30 万字阈值对齐）；core/capture-queue.js 的单条上限直接引用这里，别再各写一份。
  const MAX_BODY_CHARS = 300000;

  // 单条捕获**原文长度**上限（含空白的原始长度，B3）：字数口径挡不住「290 万个前导换行 +
  // 10 万字正文」这种空白重型 payload（字数 10 万、原文 300 万）。这个数同时是队列总量上限
  // （core/capture-queue.js 的 DEFAULT_MAX_TOTAL_CHARS = 10 条 × 30 万字满额），两处共用一份；
  // 它挡的是原文长度 / 内存，不是显示字数（显示仍按 MAX_BODY_CHARS）。
  const MAX_RAW_CHARS = 3000000;

  // 列表预览：整块展示时最多 300 字 / 6 行（先截行再截字）。再多就不是「认出是哪一段」，
  // 而是把正文又铺一遍到渲染层了。
  const PREVIEW_MAX_CHARS = 300;
  const PREVIEW_MAX_LINES = 6;
  const ELLIPSIS = '…';

  // 「第X章 / 第X话 / 楔子 / Chapter N」这类锚点：用于「标题和正文写在同一行」的拆分。
  // A1 / V113（v1.8.0 WP-30）：词表与严格度统一在 core/heading.js 的 capture 场景——
  // 比导入多认繁体「話」与全角数字（pixiv 日文 / 全角版式），其余同源。
  const HEADING_ANCHOR_RE = headingLib.anchorRe('capture');
  // 同一行里标题与正文的断开点：句末标点 / 全角空格 / 连续两个以上空白
  const INLINE_BOUNDARY_RE = /[。！？!?…]|　|\s{2,}/;

  class CaptureError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'CaptureError';
      this.code = code;
    }
  }

  // 正字数口径唯一实现是 core/chapters.js 的 countChars（v0.9 B-2）；本文件只引用，不再留本地副本。
  const countChars = chaptersLib.countChars;

  // 选项里的正整数兜底：坏值（0 / 负数 / 非数字）一律回默认，免得调用方手误把阈值设成 0。
  function positiveInt(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.max(1, Math.round(n));
  }

  // 归一化：去 BOM / CRLF→LF / 去 NUL / 去每行行尾空白 / 去掉整段首尾空行。
  // 不 trim 行首：中文段落的全角缩进要保留。
  function normalizeCaptureText(text) {
    let value = '';
    try {
      value = String(text == null ? '' : text);
    } catch {
      value = '';
    }
    value = stripBom(value).replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
    // 2026-11-17（审计 B3）：首部空行原来用 while + lines.shift()，每次 shift 都要把整条数组
    // 前移（O(n²)）——「290 万个前导换行 + 10 万字正文」是队列合法条目，点「章节」进来会冻住
    // 主进程数十分钟。改成 findIndex 找首个非空行 + 一次 slice（同文件 stripLeadingBlankLines
    // 早就是这个写法）；末尾空行从尾部收指针，同样只 slice 一次，收敛口径与原来逐行 pop 一致。
    // P7（一轮·低）：先按行指针走到首个非空行，再 split 剩余部分 —— 大段前导换行不再先 split 成
    // 几百万空串、再逐行跑 replace 正则（整表 map 的峰值内存与 GC 都在这一步）。
    let start = 0;
    for (;;) {
      const nl = value.indexOf('\n', start);
      const lineEnd = nl < 0 ? value.length : nl;
      if (value.slice(start, lineEnd).trim()) break;
      if (nl < 0) {
        start = value.length;
        break;
      }
      start = nl + 1;
    }
    if (start >= value.length) return '';
    const lines = value.slice(start).split('\n');
    let end = lines.length;
    while (end > 0 && !lines[end - 1].trim()) end -= 1;
    if (!end) return '';
    const out = [];
    for (let i = 0; i < end; i += 1) out.push(lines[i].replace(/[ \t\u3000]+$/g, ''));
    return out.join('\n');
  }

  // 一行是不是章节标题：先按 NFKC 归一（全角数字 / 日文「第１話」），再走 core/txt.js 的 parseHeading。
  function looksLikeHeading(trimmed) {
    if (!trimmed) return false;
    const normalized = typeof trimmed.normalize === 'function' ? trimmed.normalize('NFKC') : trimmed;
    const parsed = txtLib && typeof txtLib.parseHeading === 'function' ? txtLib.parseHeading(normalized) : null;
    return Boolean(parsed) || HEADING_ANCHOR_RE.test(trimmed);
  }

  // 「第1章 开端　正文从这里开始」：锚点开头、标题与正文挤在同一行时，按首句末标点 / 全角空格切开。
  // 没有锚点（自拟标题如「撞见了幽灵 直到她…」）不做猜测——纯文本层面无法可靠判断。
  function splitInlineHeading(trimmed, { maxTitleLength = MAX_TITLE_LENGTH } = {}) {
    const anchor = HEADING_ANCHOR_RE.exec(trimmed);
    if (!anchor) return null;
    const rawRest = trimmed.slice(anchor[0].length);
    // 锚点后面紧跟的空白 / 冒号 / 顿号只是「第1章　雪夜」的分隔，不算标题与正文的断开点
    const rest = rawRest.replace(/^[\s　：:、.．\-—–]+/, '');
    if (!rest) return null;
    const boundary = INLINE_BOUNDARY_RE.exec(rest);
    if (!boundary) return null;
    const start = rawRest.length - rest.length;
    const before = rawRest.slice(0, start + boundary.index);
    const after = rest.slice(boundary.index + boundary[0].length);
    const title = `${anchor[0]}${before}`.trim();
    const body = after.trim();
    if (!title || !body) return null;
    if (title.length > maxTitleLength) return null;
    return { title, body };
  }

  // 去掉数组开头的连续空行（标题行之后的空行不该带进正文：新章正文不以空行开头，
  // 与旧 composeBody「去掉首尾空行、中间空行原样保留」同一口径）；末尾空行 normalizeCaptureText 已清掉。
  function stripLeadingBlankLines(lines) {
    let start = 0;
    while (start < lines.length && !lines[start].trim()) start += 1;
    return lines.slice(start);
  }

  // 整条记录 → 章名 / 正文。返回 { title, body, titleOnly, reason }。
  //
  // 优先级（作者拍板的产品行为，见 _wip-clipboard-panel-20261107/CONTRACT.md §3）：
  //   ① 首个非空行是标题行（looksLikeHeading；支持 splitInlineHeading 同行拆开），
  //      且标题 ≤40 字、其余正文 countChars ≥50 → title=该行/inline.title，body=其余行原样
  //      （normalizeCaptureText 之后；标题行从 body 去掉、紧随标题的空行去掉、body 内部空行保留）。
  //   ② 否则整条 countChars < 100 → titleOnly=true：title=整条（空白折成一个空格 + trim，
  //      允许超过 40 字——这是作者拍板的例外：短内容往往就是一句标题），body=''。
  //   ③ 否则 title=''，body=normalized（作者自己写章名，正文一个字不动）。
  // 只看首个非空行、不扫前 5 行：多段复制时标题只会在最前面，往中间找标题会把正文行误当章名。
  function splitRecordTitle(text, options = {}) {
    const maxTitleLength = positiveInt(options.maxTitleLength, MAX_TITLE_LENGTH);
    const minBodyChars = positiveInt(options.minBodyChars, MIN_BODY_CHARS);
    const titleOnlyChars = positiveInt(options.titleOnlyMaxChars, TITLE_ONLY_CHARS);

    const normalized = normalizeCaptureText(text);
    if (!normalized) return { title: '', body: '', titleOnly: false, reason: 'empty' };

    const lines = normalized.split('\n');
    const firstIndex = lines.findIndex((line) => Boolean(line.trim()));
    if (firstIndex >= 0) {
      const first = lines[firstIndex].trim();
      // 同行标题：「第1章 开端　正文从这里开始」。标题部分从正文里去掉，同一行剩下的正文保留。
      const inline = splitInlineHeading(first, { maxTitleLength });
      if (inline) {
        const body = [inline.body, ...lines.slice(firstIndex + 1)].join('\n');
        if (countChars(body) >= minBodyChars) {
          return { title: inline.title, body, titleOnly: false, reason: 'inline-heading' };
        }
      }
      // 独占一行的标题：整行就是章名，标题行之后的空行不留在正文开头。
      if (looksLikeHeading(first) && first.length <= maxTitleLength) {
        const body = stripLeadingBlankLines(lines.slice(firstIndex + 1)).join('\n');
        if (countChars(body) >= minBodyChars) {
          return { title: first, body, titleOnly: false, reason: 'heading' };
        }
      }
    }

    // 规则①不成立（没有标题行 / 标题太长 / 正文太短）→ 短内容整条当章名。
    if (countChars(normalized) < titleOnlyChars) {
      const title = normalized.replace(/\s+/g, ' ').trim();
      return { title, body: '', titleOnly: true, reason: 'title-only' };
    }
    // 长内容且认不出标题：全文当正文，章名交给作者（storage 会用文件名兜底）。
    return { title: '', body: normalized, titleOnly: false, reason: 'body' };
  }

  // 捕获入口的统一限额判定（审计 B3）：commit-record 与队列同一口径，先按**原文长度**挡，
  // 再按**去空白字数**挡。顺序不能反：空白重型 payload（290 万前导换行 + 10 万字正文）字数很小、
  // 原文却极长——先算字数不但白扫 300 万字符，而且字数闸根本挡不住它。
  // 返回 { tooLarge, reason: 'raw'|'chars'|'', rawLength, chars }；reason='raw' 时 chars=null
  // （没算，调用方也不需要）。非字符串按空串处理——调用方的 BAD_TEXT 闸在它之前。
  function checkCaptureLimits(text) {
    const source = typeof text === 'string' ? text : '';
    const rawLength = source.length;
    if (rawLength > MAX_RAW_CHARS) {
      return { tooLarge: true, reason: 'raw', rawLength, chars: null };
    }
    const chars = countChars(source);
    if (chars > MAX_BODY_CHARS) {
      return { tooLarge: true, reason: 'chars', rawLength, chars };
    }
    return { tooLarge: false, reason: '', rawLength, chars };
  }

  // 列表展示用的截断正文：CRLF→LF，最多 300 字 / 6 行（先截行再截字），截断末尾加「…」。
  // 空文本（含全空白）返回 ''。主进程 capture-queue.list() 与渲染层 pending 行共用同一份，
  // 免得两边各写一套截断规则、列表和面板显示不一样。
  //
  // 2026-11-17（审计 B4）：预览只要 300 字 / 6 行，不再对全文 split + Array.from 物化全部码点
  // （首行 300 万字时一次产生约 300 万个临时字符串、~100 MB 级）。boundedPreviewPrefix 只走到
  // 「第 maxLines 个换行」或「第 maxChars+1 个码点」为止，最多收 maxChars 个码点；全空白短路
  // 仍扫一遍 trim（不分配、不 split，量级只有一次线性扫描）。
  function boundedPreviewPrefix(value, maxChars, maxLines) {
    const chars = [];
    let lines = 1;
    let truncated = false;
    let i = 0;
    while (i < value.length) {
      const code = value.charCodeAt(i);
      let width = 1;
      let ch = value[i];
      if (code === 13 || code === 10) {
        // CRLF / 孤立 CR / LF 都算换行（与原 replace(/\r\n?/g, '\n') 后 split('\n') 同口径）
        ch = '\n';
        if (code === 13 && value.charCodeAt(i + 1) === 10) width = 2;
        if (lines >= maxLines) {
          truncated = true; // 第 maxLines 行之后还有内容 → 行截断（这个换行不进预览）
          break;
        }
        lines += 1;
      } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
        const low = value.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          width = 2; // 代理对整对收，按码点截字时不会从中间切开
          ch = value.slice(i, i + 2);
        }
      }
      if (chars.length >= maxChars) {
        truncated = true; // 已收满 maxChars 个码点、后面还有 → 字截断
        break;
      }
      chars.push(ch);
      i += width;
    }
    return { preview: chars.join(''), truncated };
  }

  function recordPreview(text, options = {}) {
    const maxChars = positiveInt(options.maxChars, PREVIEW_MAX_CHARS);
    const maxLines = positiveInt(options.maxLines, PREVIEW_MAX_LINES);
    let value = '';
    try {
      value = String(text == null ? '' : text);
    } catch {
      value = '';
    }
    if (!value.trim()) return '';
    const bounded = boundedPreviewPrefix(value, maxChars, maxLines);
    // 超出才加省略号，正好 maxChars 字不加（口径与旧实现逐字节一致，R5 用参考实现钉住）。
    return bounded.truncated ? `${bounded.preview}${ELLIPSIS}` : bounded.preview;
  }

  return {
    MAX_NAME_LENGTH,
    MAX_TITLE_LENGTH,
    MAX_BODY_CHARS,
    MAX_RAW_CHARS,
    PREVIEW_MAX_CHARS,
    PREVIEW_MAX_LINES,
    CaptureError,
    normalizeCaptureText,
    looksLikeHeading,
    splitInlineHeading,
    splitRecordTitle,
    checkCaptureLimits,
    recordPreview,
    countChars
  };
});
