// 正文排版整理（纯逻辑，不依赖 Electron，可单测）。
// 设计原则：只在作者点「排版 → 整理本章」时调用，绝不自动执行；
// 只动空白、标点这类「排版层」内容，不改字词；同一份文本反复整理的结果必须一致（幂等）。
const { HAN_RANGES } = require('./common');
const INDENT = '\u3000\u3000'; // 段首缩进：两个全角空格（中文小说惯例）
// C42（v1.8.0 WP-26）：汉字范围必须覆盖 CJK 扩展 B–G 与兼容补充（U+20000 起，如「𠮷」）。
// 这些字在 JS 里是代理对，正则要带 u 标志按码点匹配；逐字扫描的地方也按码点取整字，
// 否则只看到半个代理，邻接标点 / 重复用词都会漏判。
// A2（v1.8.0 WP-31）：范围串已收编到 core/common.js（与 core/proofread.js 同一份），
// 这里只拼正则 / 字符类，不再各写一份范围串。
const HAN_RE = new RegExp(`[${HAN_RANGES}]`, 'u');
const FULL_PUNCT = new Set(['，', '。', '；', '：', '！', '？']);
// 审计修复 #51（E16）：闭引号后紧挨的句点也要转全角。旧规则只看 prev∈汉字/FULL_PUNCT，而
// FULL_PUNCT 不含闭引号 —— 「他说：“你好”.」里的 `.` 永远漏转（二次整理也不会变，作者得手改）。
// 闭引号只列中文排版里真正会出现的收引号；直引号 `"` / `'` 不列（英文 He said "hi". 不能改成句号）。
// 审计残留 #51（E16）：U+2019 同时是中文右单引号和英文撇号 —— 以 `’` 收尾的英文写法后紧跟的句点
// 也会被当成「闭引号后的句点」转全角（`‘hi’.`→`‘hi’。`、`dogs’.`→`dogs’。`；撇号夹在词中的
// `don’t.` 不受影响）。属审计指定字符集的固有边界，不做引号配对，口径同 README「已知限制」。
const CLOSE_QUOTE = new Set(['”', '’', '」', '』']);
const PUNCT_MAP = { ',': '，', '.': '。', ';': '；', ':': '：', '!': '！', '?': '？' };
const BLANK_MODES = ['keep', 'single', 'singleIndent', 'none'];
const INDENT_MODES = ['none', '0', '2'];
// 中文语境邻接字符：汉字（含扩展 B–G）、中文标点、中文引号、破折号/省略号、全角空格
const CJK_NEIGHBOR_RE = new RegExp(`[${HAN_RANGES}，。；：！？、…—（）《》“”‘’\\u3000]`, 'u');
const ASCII_ALNUM_RE = /[A-Za-z0-9]/;
// 两个汉字之间的半角空格（removeCjkSpaces 用；同样按码点匹配扩展 B–G 的代理对）
const CJK_SPACE_RE = new RegExp(`([${HAN_RANGES}])[ \\u00a0]+(?=[${HAN_RANGES}])`, 'gu');

// 按 UTF-16 下标取一个完整字符（代理对算一个）；越界返回空串。
function charAt(text, index) {
  if (index < 0 || index >= text.length) return '';
  const code = text.codePointAt(index);
  return code > 0xffff ? text.slice(index, index + 2) : text[index];
}

const DEFAULT_OPTIONS = Object.freeze({
  indent: '2',             // 段首缩进：none 不处理 / '0' 去掉缩进 / '2' 两个全角空格
  blankLines: 'single',    // 段间空行：keep 保持段间原有空行数 / single 空一行 / singleIndent 空一行（含缩进）/ none 不空行；
                           // 注意：所有模式都会丢掉正文开头的空行、结尾连续空行只留一个（keep 也不保持首尾，见 applyFormat）
  trimTrailing: true,      // 删除每行行尾空白
  normalizePunct: true,    // 中文旁边的半角标点转全角（，。；：！？）
  removeCjkSpaces: false,  // 删除中文之间的多余空格（默认关：可能影响语感）
  curlyQuotes: false,      // 直引号 → 中文弯引号（只在中文语境里转，默认关）
  ellipsis: false          // 连续三个以上英文句点 → 中文省略号 ……（默认关）
});

// 兼容旧配置：以前 indent 是布尔值（true=缩进两格 / false=不管）
function normalizeIndentMode(raw) {
  if (typeof raw === 'boolean') return raw ? '2' : 'none';
  if (INDENT_MODES.includes(raw)) return raw;
  return DEFAULT_OPTIONS.indent;
}

function sanitizeOptions(raw) {
  const merged = { ...DEFAULT_OPTIONS, ...(raw && typeof raw === 'object' ? raw : {}) };
  return {
    indent: normalizeIndentMode(merged.indent),
    blankLines: BLANK_MODES.includes(merged.blankLines) ? merged.blankLines : DEFAULT_OPTIONS.blankLines,
    trimTrailing: Boolean(merged.trimTrailing),
    normalizePunct: Boolean(merged.normalizePunct),
    removeCjkSpaces: Boolean(merged.removeCjkSpaces),
    curlyQuotes: Boolean(merged.curlyQuotes),
    ellipsis: Boolean(merged.ellipsis)
  };
}

const isBlank = (line) => line.trim() === '';
const stripLeading = (line) => line.replace(/^[ \t\u3000\u00a0]+/, '');
const stripTrailing = (line) => line.replace(/[ \t\u3000\u00a0]+$/, '');

// 半角标点 → 全角：仅当旁边是中文（或已转换过的全角标点，处理「什么?!」这种连排）。
// 数字、英文缩写、URL、时间里的半角标点保持原样（3.14 / www.a.com / 12:30 / A. 开头）。
// onConvert 可选：(index, 半角字符, 全角字符)，用于「校对」只报告不改动（见 core/proofread.js）；
// 不传时行为与以前完全一致。
// P-07（1.6.0 A5）：逐字 out += ch 造串在长段落里是 O(n²) 的中间字符串，改成数组 push + join；
// prev 跟着「已经产出的最后一个字符」走（转换后是全角那个），判定口径与旧实现逐字一致。
function convertPunct(text, onConvert) {
  let count = 0;
  const parts = [];
  const report = typeof onConvert === 'function' ? onConvert : null;
  let prev = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.codePointAt(i);
    // C42：代理对（扩展 B 汉字 / emoji）按整字照抄，prev 记整字才能让后面的标点判定
    // 认出「旁边是汉字」；标点本身永远是 BMP，不受影响。
    if (code > 0xffff) {
      const wide = text.slice(i, i + 2);
      parts.push(wide);
      prev = wide;
      i += 1;
      continue;
    }
    const ch = text[i];
    const full = PUNCT_MAP[ch];
    if (!full) {
      parts.push(ch);
      prev = ch;
      continue;
    }
    const next = charAt(text, i + 1);
    // 「...」「。。。」这类省略号连排保持原样，不逐个转换
    if (ch === '.' && (text[i - 1] === '.' || text[i + 1] === '.')) {
      parts.push(ch);
      prev = ch;
      continue;
    }
    // 句点单独收紧：只认「中文 + .」（或全角标点 / 闭引号之后），避免把 A. / 3.14 / www.a.com 里的点转成句号
    if (ch === '.') {
      if (!(HAN_RE.test(prev) || FULL_PUNCT.has(prev) || CLOSE_QUOTE.has(prev))) {
        parts.push(ch);
        prev = ch;
        continue;
      }
      parts.push(full);
      prev = full;
      count += 1;
      if (report) report(i, ch, full);
      continue;
    }
    const nearHan = HAN_RE.test(prev) || HAN_RE.test(next) || FULL_PUNCT.has(prev) || FULL_PUNCT.has(next);
    if (!nearHan) {
      parts.push(ch);
      prev = ch;
      continue;
    }
    parts.push(full);
    prev = full;
    count += 1;
    if (report) report(i, ch, full);
  }
  return { text: parts.join(''), count };
}

// 删除两个中文字符之间的半角空格（缩进用的全角空格不受影响）
function removeCjkSpaces(text) {
  let count = 0;
  // C42：扩展 B–G 汉字（代理对）也要能和 BMP 汉字一样夹空格（见 CJK_SPACE_RE 的 u 标志）。
  const out = text.replace(CJK_SPACE_RE, (match, lead) => {
    count += 1;
    return lead;
  });
  return { text: out, count };
}

// 「...」→「……」：只认连续 3 个以上的英文句点；已经是 …… 的不动（幂等）。
function convertEllipsis(text) {
  let count = 0;
  const out = String(text == null ? '' : text).replace(/\.{3,}/g, () => {
    count += 1;
    return '……';
  });
  return { text: out, count };
}

// 直引号 → 中文弯引号（“ ” ‘ ’）。只在中文语境里转：
// 引号两侧必须至少一侧是中文/中文标点，且不能挨着英文/数字（避免把 don't、英文引语改坏）。
// 方向判断：① 后面是中文、前面是行首/标点/空白 → 开引号；② 前面是中文/标点、后面不是中文 → 收引号；
// ③ 两边都是中文（如 他说"你好"）→ 按本段内还没配对的引号交替判断。
// A10（v1.8.0 WP-31）：原来逐字 `out += ch` 造串（长段落是 O(n²) 的中间字符串），改成 parts.push + join，
// 与同文件 convertPunct（P-07）口径一致。每次产出的都是一个 UTF-16 码元（原字符或转换后的引号），
// 所以 lastUnit / beforeLastUnit 正好还原旧实现 lastChar(out) 的语义：最后一个码元是低代理且产出串
// 长度 > 1 时，取最近两个码元（孤立代理这类坏数据的方向判定也与旧实现逐字一致）。
function convertCurlyQuotes(text) {
  const source = String(text == null ? '' : text);
  let count = 0;
  const parts = [];
  let lastUnit = '';
  let beforeLastUnit = '';
  let doubleOpen = false;
  let singleOpen = false;
  const pushUnit = (unit) => {
    beforeLastUnit = lastUnit;
    lastUnit = unit;
    parts.push(unit);
  };
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch !== '"' && ch !== "'") {
      pushUnit(ch);
      continue;
    }
    const lastCode = lastUnit.charCodeAt(0);
    const prev =
      lastUnit && lastCode >= 0xdc00 && lastCode <= 0xdfff && parts.length > 1
        ? beforeLastUnit + lastUnit
        : lastUnit;
    const next = charAt(source, i + 1);
    const prevCjk = CJK_NEIGHBOR_RE.test(prev);
    const nextCjk = CJK_NEIGHBOR_RE.test(next);
    const prevAlnum = ASCII_ALNUM_RE.test(prev);
    const nextAlnum = ASCII_ALNUM_RE.test(next);
    // 中文语境：至少一侧是中文，且两侧都不挨着英文/数字
    if (!((prevCjk || nextCjk) && !prevAlnum && !nextAlnum)) {
      pushUnit(ch);
      continue;
    }
    const isDouble = ch === '"';
    const opened = isDouble ? doubleOpen : singleOpen;
    const prevHan = HAN_RE.test(prev);
    const nextHan = HAN_RE.test(next);
    let isOpen;
    if (nextHan && (!prev || (prevCjk && !prevHan))) {
      isOpen = true; // 行首/标点/空白 + 后面是中文 → 开
    } else if (prevCjk && !nextHan) {
      isOpen = false; // 前面是中文 + 后面不是中文（行尾/标点）→ 收
    } else {
      isOpen = !opened; // 两边都是中文 → 按本段内配对状态交替
    }
    pushUnit(isOpen ? (isDouble ? '“' : '‘') : (isDouble ? '”' : '’'));
    count += 1;
    if (isDouble) doubleOpen = isOpen;
    else singleOpen = isOpen;
  }
  return { text: parts.join(''), count };
}

function formatText(text, rawOptions) {
  const options = sanitizeOptions(rawOptions);
  const indent = options.indent;
  const stats = {
    paragraphs: 0,
    indentFixed: 0,
    trailingTrimmed: 0,
    blankCollapsed: 0,
    punctFixed: 0,
    cjkSpacesRemoved: 0,
    quotesFixed: 0,
    ellipsisFixed: 0
  };

  const source = String(text == null ? '' : text)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');

  if (isBlank(source)) {
    return { text: '', stats, changed: source !== '' };
  }

  const endsWithNewline = source.endsWith('\n');
  const paragraphs = []; // { text, gap } gap = 与上一段之间原有的空行数
  let gap = 0;

  for (const rawLine of source.split('\n')) {
    if (isBlank(rawLine)) {
      if (paragraphs.length) gap += 1;
      continue; // 开头的空行直接丢掉（所有 blankLines 模式都不保留首部空行）
    }

    let line = rawLine;
    if (options.trimTrailing) {
      const trimmed = stripTrailing(line);
      if (trimmed !== line) {
        stats.trailingTrimmed += 1;
        line = trimmed;
      }
    }

    if (indent !== 'none') {
      // '2' = 两个全角空格；'0' = 去掉原有缩进（不补空格）
      const next = (indent === '2' ? INDENT : '') + stripLeading(line);
      if (next !== line) stats.indentFixed += 1;
      line = next;
    }

    if (options.ellipsis) {
      const res = convertEllipsis(line);
      line = res.text;
      stats.ellipsisFixed += res.count;
    }

    if (options.removeCjkSpaces) {
      const res = removeCjkSpaces(line);
      line = res.text;
      stats.cjkSpacesRemoved += res.count;
    }

    if (options.normalizePunct) {
      const res = convertPunct(line);
      line = res.text;
      stats.punctFixed += res.count;
    }

    // 引号放在标点转换之后：这样「他说,"你好"」里的引号挨着的是已经变成全角的「，」
    if (options.curlyQuotes) {
      const res = convertCurlyQuotes(line);
      line = res.text;
      stats.quotesFixed += res.count;
    }

    paragraphs.push({ text: line, gap });
    gap = 0;
  }

  stats.paragraphs = paragraphs.length;

  // 「空一行（含缩进）」：空行里放两个全角空格，粘到会吃掉纯空行的平台也不塌；
  // 缩进设为 0 / 不处理时没有缩进可带，退化成普通空行。
  const blankLineText = indent === '2' ? INDENT : '';

  let result;
  if (!paragraphs.length) {
    result = '';
  } else if (options.blankLines === 'keep') {
    result = paragraphs[0].text;
    for (let i = 1; i < paragraphs.length; i += 1) {
      result += '\n'.repeat(paragraphs[i].gap + 1) + paragraphs[i].text;
    }
  } else {
    let separator = '\n';
    let wanted = 0;
    if (options.blankLines === 'single') {
      separator = '\n\n';
      wanted = 1;
    } else if (options.blankLines === 'singleIndent') {
      separator = `\n${blankLineText}\n`;
      wanted = 1;
    }
    for (let i = 1; i < paragraphs.length; i += 1) {
      if (paragraphs[i].gap !== wanted) stats.blankCollapsed += 1;
    }
    result = paragraphs.map((p) => p.text).join(separator);
  }

  // 结尾只留一个换行：源文末尾有换行就补一个 '\n'，多个尾随空行在这里被收成一个（keep 也一样）。
  if (endsWithNewline && result) result += '\n';

  return { text: result, stats, changed: result !== source };
}

module.exports = {
  DEFAULT_OPTIONS,
  sanitizeOptions,
  formatText,
  // 供测试/预览使用（A10 / v1.8.0 WP-31：convertCurlyQuotes 供差分用例直接对照旧算法）
  convertPunct,
  convertCurlyQuotes,
  removeCjkSpaces
};
