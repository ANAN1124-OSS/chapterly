// 校对（只报告、不改动）——纯逻辑，不读盘、不依赖 Electron，可单测。
//
// 「排版 → 一键整理」只有在作者点「套用」时才改正文；校对面板把同一套判定结果列出来，
// 点哪条跳到哪条，绝不替作者改字，也不写盘。规则：
//   ① 半角标点残留：复用 core/format.js 的 convertPunct 判定（同一个函数，不会各判各的）
//   ② 超长段落：默认超过 500 字（按去空白后的字符数，与状态栏字数同口径）
//   ③ 疑似重复用词：默认 300 字窗口内同一个双字词出现 ≥3 次（重叠命中只算一次）
//   ④ 连续标点：「？！？」这类 3 个以上；连续的「……」/「——」按一个单位算，不误报
//   ⑤ 多余空行：2 个及以上连续空行（含只有全角空格的行）
//   ⑥ 中英间距：汉字 / 全角标点 与 拉丁字母 / 数字 直接相邻、没有空格（默认关：风格偏好、误报高）
//   ⑦ 省略号：「...」（3 个及以上半角点）或「。。。」→ 建议「……」（两个「…」）
//   ⑧ 破折号：「--」「---」或单个「—」→ 建议「——」（两个「—」）
//   ⑨ 全角数字：全角「０-９」→ 建议半角；整段全角数字一次报完
//   ⑩ 自定义词表：作者自己的错别字 / 禁用词（可选「错词 → 建议」）；没有词表就不产出这一条
//
// 每条规则都能单独开关：options.rules 是 { [id]: boolean }，缺省按 DEFAULT_RULES。
// 开关只在渲染层内存里（1.5.0），不写配置、不新增字段；关掉的规则一条都不产出。
//
// 定位约定：index / length 都是「把 CRLF 归一成 \n、去掉 BOM」之后的字符位置，
// 与编辑区 textarea 的 value 一致，因此可以直接 setSelectionRange。
const formatLib = require('./format');
const findLib = require('./find');
const chaptersLib = require('./chapters');
const glossaryLib = require('./glossary');
const { clampInt, formatCount, normalizeText, lineStartsOf, positionOf } = require('./common');

// 报告顺序（同位置时按这个顺序排；结果列表也按规则分组显示）
// custom-word 永远排最后：词表是作者自己加的，放内置规则后面
const RULE_ORDER = [
  'halfwidth-punct',
  'long-paragraph',
  'repeat-word',
  'punct-run',
  'blank-lines',
  'cjk-latin-spacing',
  'ellipsis',
  'dash',
  'fullwidth-digit',
  'custom-word'
];

const RULE_LABELS = Object.freeze({
  'halfwidth-punct': '半角标点',
  'long-paragraph': '超长段落',
  'repeat-word': '重复用词',
  'punct-run': '连续标点',
  'blank-lines': '多余空行',
  'cjk-latin-spacing': '中英间距',
  ellipsis: '省略号',
  dash: '破折号',
  'fullwidth-digit': '全角数字',
  'custom-word': '自定义词表'
});

// 每条规则的默认开关：中英间距是风格偏好（「第3章」「A4纸」这类写法很多），默认关；
// 其余默认开。渲染层面板的默认状态照这份来（tests/proofread.test.js 有一致性闸门）。
const DEFAULT_RULES = Object.freeze({
  'halfwidth-punct': true,
  'long-paragraph': true,
  'repeat-word': true,
  'punct-run': true,
  'blank-lines': true,
  'cjk-latin-spacing': false,
  ellipsis: true,
  dash: true,
  'fullwidth-digit': true,
  'custom-word': true
});

// 阈值都能改，但有上下限：避免误填 1 字 / 0 字窗口导致满屏误报
const DEFAULT_OPTIONS = Object.freeze({
  longParagraph: 500, // 超长段落阈值（字）
  repeatWindow: 300, // 重复用词窗口（字）
  repeatCount: 3, // 窗口内出现几次算可疑
  maxIssues: 400 // 单章最多返回多少条（总数仍会照实统计）
});

const OPTION_LIMITS = Object.freeze({
  longParagraph: [50, 20000],
  repeatWindow: [20, 5000],
  repeatCount: [2, 20],
  maxIssues: [20, 5000]
});

const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
// 连续标点判定里认的全角标点（半角标点由第 ① 条单独报，避免一条内容报两次）
const RUN_PUNCT = new Set(['，', '。', '；', '：', '！', '？', '、', '…', '—']);
const SNIPPET_RADIUS = 18;
const PARAGRAPH_PREFIX = 24;

// 旧调用方 / 渲染层传脏值都兜底成默认值，越界自动夹紧
function sanitizeOptions(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    longParagraph: clampInt(source.longParagraph, DEFAULT_OPTIONS.longParagraph, OPTION_LIMITS.longParagraph),
    repeatWindow: clampInt(source.repeatWindow, DEFAULT_OPTIONS.repeatWindow, OPTION_LIMITS.repeatWindow),
    repeatCount: clampInt(source.repeatCount, DEFAULT_OPTIONS.repeatCount, OPTION_LIMITS.repeatCount),
    maxIssues: clampInt(source.maxIssues, DEFAULT_OPTIONS.maxIssues, OPTION_LIMITS.maxIssues)
  };
}

// 规则开关清洗：只认布尔，缺省 / 脏值按 DEFAULT_RULES；永远把每条规则的键补全。
// 返回新对象（不修改调用方传进来的 options），面板与主进程都拿同一份清洗结果。
function sanitizeRules(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rules = {};
  for (const rule of RULE_ORDER) {
    rules[rule] = typeof source[rule] === 'boolean' ? source[rule] : DEFAULT_RULES[rule];
  }
  return rules;
}

// normalizeText / lineStartsOf / positionOf 都从 core/common.js 来（B6）：和 storage.loadChapterText /
// 编辑区同一份口径（去掉开头 BOM、CRLF 归一成 LF），行号列号也与 sensitive 预检同一份算法。

// 统计收集器：总数 / 各条数照实统计；真正保留的条目有上限（单章最多 maxIssues 条），
// 避免「一整章英文引号」这类极端文本把内存和界面刷爆。
function createCollector(maxIssues) {
  const byRule = {};
  for (const rule of RULE_ORDER) byRule[rule] = 0;
  const issues = [];
  const keepLimit = Math.min(Math.max(maxIssues, 1) * 2, 10000);
  let total = 0;
  return {
    add(issue) {
      total += 1;
      byRule[issue.rule] = (byRule[issue.rule] || 0) + 1;
      if (issues.length < keepLimit) issues.push(issue);
    },
    finish() {
      return { issues, total, byRule };
    }
  };
}

// 连续标点数：把连排的「……」/「——」各折叠成一个单位，其余每个标点算一个单位
function countPunctUnits(run) {
  let units = 0;
  for (let i = 0; i < run.length; i += 1) {
    const ch = run[i];
    if ((ch === '…' || ch === '—') && i > 0 && run[i - 1] === ch) continue;
    units += 1;
  }
  return units;
}

// 中文句读（破折号判定的「中文侧」基础集合）。不含「——」「……」——
// 它们挨着英文时不一定该加空格（「A—B」），由下面的 CJK_NEIGHBOR_PUNCT 单独补上。
const CJK_TEXT_PUNCT = new Set([
  '，', '。', '、', '；', '：', '？', '！', '“', '”', '‘', '’',
  '「', '」', '『', '』', '（', '）', '《', '》', '〈', '〉', '·', '～'
]);
// 破折号判定用的「中文邻居」：连排的「……」/「——」本身也算中文侧
const CJK_NEIGHBOR_PUNCT = new Set([...CJK_TEXT_PUNCT, '…', '—']);

const LATIN_CHAR_RE = /[A-Za-z0-9]/;
const FULLWIDTH_DIGIT_RE = /[\uff10-\uff19]/;
const FULLWIDTH_DIGIT_ALL_RE = /[\uff10-\uff19]/g;

function isHanChar(ch) {
  return Boolean(ch) && HAN_RE.test(ch);
}

// 破折号判定的「中文邻居」：汉字或中文标点（连排的「……」/「——」也算）
function isCjkNeighbor(ch) {
  return Boolean(ch) && (HAN_RE.test(ch) || CJK_NEIGHBOR_PUNCT.has(ch));
}

// 全角数字 → 半角（和 core/jump.js 的换算同一套：码位差 0xfee0）
function toHalfWidthDigits(text) {
  return String(text == null ? '' : text).replace(FULLWIDTH_DIGIT_ALL_RE, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
}

// 重复用词：先按「不重叠」贪心取每个双字词的出现位置（「哈哈哈哈」的「哈哈」只算 2 次，
// 不会因为重叠命中被误判成 3 次），再找最早一个能装下 repeatCount 次的窗口。
function repeatWordIssues(line, options) {
  const positions = new Map();
  for (let i = 0; i + 1 < line.length; i += 1) {
    if (!HAN_RE.test(line[i]) || !HAN_RE.test(line[i + 1])) continue;
    const word = line.slice(i, i + 2);
    const list = positions.get(word);
    if (list) list.push(i);
    else positions.set(word, [i]);
  }
  const found = [];
  for (const [word, raw] of positions) {
    const occ = [];
    let lastEnd = -1;
    for (const pos of raw) {
      if (pos < lastEnd) continue;
      occ.push(pos);
      lastEnd = pos + 2;
    }
    if (occ.length < options.repeatCount) continue;
    let windowStart = -1;
    for (let j = options.repeatCount - 1; j < occ.length; j += 1) {
      const start = occ[j - options.repeatCount + 1];
      if (occ[j] + 2 - start <= options.repeatWindow) {
        windowStart = start;
        break;
      }
    }
    if (windowStart < 0) continue;
    const windowEnd = windowStart + options.repeatWindow;
    const count = occ.filter((pos) => pos >= windowStart && pos < windowEnd).length;
    found.push({ word, start: windowStart, count });
  }
  // 「突然想起」连续出现 3 次会同时命中「突然 / 然想 / 想起」三个二字词；它们起点只差 1–2 个字，
  // 本质是同一个短语，只留最靠前的那条，免得好几句重复刷出十几条。
  found.sort((a, b) => a.start - b.start);
  const kept = [];
  for (const hit of found) {
    const last = kept[kept.length - 1];
    if (last && hit.start < last.start + 3) continue;
    kept.push(hit);
  }
  return kept;
}

// rawGlossary 可选：作者自己的校对词表（[{ term, suggestion }]，建议可为空）。
// 不传 / 传空数组时只有前五条内置规则，行为与以前完全一样。
function proofreadText(text, rawOptions, rawGlossary) {
  const options = sanitizeOptions(rawOptions);
  const rules = sanitizeRules(rawOptions && rawOptions.rules);
  const source = normalizeText(text);
  const collector = createCollector(options.maxIssues);

  // 统一兜底：位置、行号、上下文片段一次生成，各规则只关心「报什么」
  const addIssue = (rule, index, selectLength, match, message, extra) => {
    const cleanMatch = String(match == null ? '' : match);
    const matchLength = cleanMatch.length || Math.min(Math.max(selectLength, 1), PARAGRAPH_PREFIX);
    const snippet =
      extra && extra.snippet
        ? extra.snippet
        : findLib.makeSnippet(source, index, matchLength, SNIPPET_RADIUS);
    const issue = {
      rule,
      ruleLabel: RULE_LABELS[rule],
      index,
      length: Math.max(0, selectLength),
      match: cleanMatch,
      message,
      snippet
    };
    if (extra) {
      for (const key of Object.keys(extra)) {
        if (key !== 'snippet') issue[key] = extra[key];
      }
    }
    collector.add(issue);
  };

  // 段落 = 非空白行（行首缩进算在段落里）
  const paragraphs = [];
  const lines = source.split('\n');
  const lineStarts = lineStartsOf(source);
  let offset = 0;
  for (const line of lines) {
    if (line.trim() !== '') paragraphs.push({ start: offset, end: offset + line.length, text: line });
    offset += line.length + 1;
  }

  // ① 半角标点：位置直接取自 format.js 的判定（同一个函数，不会和排版结果打架）
  if (rules['halfwidth-punct']) {
    for (const paragraph of paragraphs) {
      formatLib.convertPunct(paragraph.text, (offsetInLine, from, to) => {
        addIssue(
          'halfwidth-punct',
          paragraph.start + offsetInLine,
          1,
          from,
          `半角标点「${from}」建议改成「${to}」`
        );
      });
    }
  }

  // ② 超长段落（字数口径与状态栏一致：去掉空白再数）
  if (rules['long-paragraph']) {
    for (const paragraph of paragraphs) {
      const chars = chaptersLib.countChars(paragraph.text);
      if (chars <= options.longParagraph) continue;
      addIssue(
        'long-paragraph',
        paragraph.start,
        paragraph.text.length,
        paragraph.text.slice(0, PARAGRAPH_PREFIX),
        `这一段 ${formatCount(chars)} 字（超过 ${formatCount(options.longParagraph)} 字）`,
        { count: chars }
      );
    }
  }

  // ③ 疑似重复用词（只在段落内部找，跨段不算）
  if (rules['repeat-word']) {
    for (const paragraph of paragraphs) {
      for (const hit of repeatWordIssues(paragraph.text, options)) {
        addIssue(
          'repeat-word',
          paragraph.start + hit.start,
          2,
          hit.word,
          `「${hit.word}」在 ${options.repeatWindow} 字内出现 ${hit.count} 次`,
          { count: hit.count, window: options.repeatWindow }
        );
      }
    }
  }

  // ④ 连续标点（不会跨行：换行不在 RUN_PUNCT 里）
  if (rules['punct-run']) {
    let i = 0;
    while (i < source.length) {
      if (!RUN_PUNCT.has(source[i])) {
        i += 1;
        continue;
      }
      let j = i + 1;
      while (j < source.length && RUN_PUNCT.has(source[j])) j += 1;
      const run = source.slice(i, j);
      const units = countPunctUnits(run);
      if (units >= 3) {
        addIssue('punct-run', i, run.length, run, `连续 ${units} 个标点「${run}」`);
      }
      i = j;
    }
  }

  // ⑤ 多余空行（2 个及以上连续空行；只有全角空格的行也算空行）
  if (rules['blank-lines']) {
    let lineIndex = 0;
    while (lineIndex < lines.length) {
      if (lines[lineIndex].trim() !== '') {
        lineIndex += 1;
        continue;
      }
      let next = lineIndex;
      while (next < lines.length && lines[next].trim() === '') next += 1;
      const count = next - lineIndex;
      if (count >= 2) {
        const index = lineStarts[lineIndex];
        const end = lineStarts[next - 1] + lines[next - 1].length;
        const beforeLine = lineIndex > 0 ? lines[lineIndex - 1] : '';
        const afterLine = next < lines.length ? lines[next] : '';
        const snippet = {
          before: beforeLine.slice(-SNIPPET_RADIUS),
          match: `${count} 个空行`,
          after: afterLine.slice(0, SNIPPET_RADIUS),
          ellipsisStart: beforeLine.length > SNIPPET_RADIUS,
          ellipsisEnd: afterLine.length > SNIPPET_RADIUS
        };
        addIssue('blank-lines', index, Math.max(1, end - index), '', `这里有 ${count} 个连续空行`, {
          count,
          snippet
        });
      }
      lineIndex = next;
    }
  }

  // ⑥ 中英间距（默认关）：汉字 与 拉丁字母 / 数字 直接相邻、中间没有空格。
  // 一个边界报一条（「他用iPhone手机」= 「用i」「e手」两条），只报告不改字。
  // 中文以标点结尾（「OK。」「他说，iPhone」）不算缺空格——中文标点旁边本来就不加空格，
  // 只把「汉字 ↔ 拉丁字母/数字」这一种边界算进来，免得把正常排版判成问题。
  if (rules['cjk-latin-spacing']) {
    for (let i = 0; i + 1 < source.length; i += 1) {
      const left = source[i];
      const right = source[i + 1];
      const other = isHanChar(left) ? right : isHanChar(right) ? left : '';
      if (!other || !LATIN_CHAR_RE.test(other)) continue;
      const match = left + right;
      addIssue('cjk-latin-spacing', i, 2, match, `「${match}」之间建议加一个空格`, {
        suggestion: `${left} ${right}`
      });
    }
  }

  // ⑦ 省略号：3 个及以上半角点，或 3 个及以上「。」→ 建议「……」。
  // 「。。。」同时会被 ④ 报一次（④ 说「连续标点」、这条说「该写成……」，各说一件事）。
  if (rules.ellipsis) {
    for (let i = 0; i < source.length; ) {
      const ch = source[i];
      if (ch !== '.' && ch !== '。') {
        i += 1;
        continue;
      }
      let j = i + 1;
      while (j < source.length && source[j] === ch) j += 1;
      const run = source.slice(i, j);
      if (run.length >= 3) {
        addIssue('ellipsis', i, run.length, run, `省略号「${run}」建议改成「……」`, {
          suggestion: '……'
        });
      }
      i = j;
    }
  }

  // ⑧ 破折号：「--」「---」或单个「—」→ 建议「——」。只有挨着中文才报：
  // 日期区间 12-30、单独一行的分隔线 ---- 都不算中文破折号。
  if (rules.dash) {
    for (let i = 0; i < source.length; ) {
      const ch = source[i];
      if (ch !== '-' && ch !== '—') {
        i += 1;
        continue;
      }
      let j = i + 1;
      while (j < source.length && source[j] === ch) j += 1;
      const count = j - i;
      const prev = i > 0 ? source[i - 1] : '';
      const next = j < source.length ? source[j] : '';
      const bad = ch === '-' ? count >= 2 : count !== 2;
      if (bad && (isCjkNeighbor(prev) || isCjkNeighbor(next))) {
        const run = source.slice(i, j);
        addIssue('dash', i, count, run, `破折号「${run}」建议用两个「——」`, { suggestion: '——' });
      }
      i = j;
    }
  }

  // ⑨ 全角数字：一整段全角数字合成一条，建议字符串直接给半角版本
  if (rules['fullwidth-digit']) {
    for (let i = 0; i < source.length; ) {
      if (!FULLWIDTH_DIGIT_RE.test(source[i])) {
        i += 1;
        continue;
      }
      let j = i + 1;
      while (j < source.length && FULLWIDTH_DIGIT_RE.test(source[j])) j += 1;
      const run = source.slice(i, j);
      const ascii = toHalfWidthDigits(run);
      addIssue('fullwidth-digit', i, run.length, run, `全角数字「${run}」建议改成半角「${ascii}」`, {
        suggestion: ascii
      });
      i = j;
    }
  }

  // ⑩ 自定义校对词表（可选的作者词表；没有词表时这一条不产出任何结果）
  const customEntries = glossaryLib.sanitizeEntries(rawGlossary);
  const custom = rules['custom-word']
    ? glossaryLib.findHits(source, customEntries)
    : { hits: [], entryCount: customEntries.length, truncated: false };
  for (const hit of custom.hits) {
    addIssue(
      'custom-word',
      hit.index,
      hit.length,
      hit.term,
      hit.suggestion
        ? `词表里的「${hit.term}」建议改成「${hit.suggestion}」`
        : `命中校对词表里的「${hit.term}」`,
      { word: hit.term, suggestion: hit.suggestion }
    );
  }

  // 按位置排（同位置按规则顺序），再补 1 基的行 / 列
  const collected = collector.finish();
  const sorted = collected.issues
    .slice()
    .sort(
      (a, b) => a.index - b.index || RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule)
    );
  const issues = sorted.slice(0, options.maxIssues);
  for (const issue of issues) {
    const pos = positionOf(lineStarts, issue.index);
    issue.line = pos.line;
    issue.column = pos.column;
  }

  return {
    issues,
    total: collected.total,
    byRule: collected.byRule,
    // 词表命中多到异常（原始命中上限）也算明细不全，界面会提示「只列出一部分」
    truncated: collected.total > issues.length || custom.truncated,
    paragraphs: paragraphs.length,
    chars: chaptersLib.countChars(source),
    // 这次实际参与匹配的校对词条数（0 = 没设置词表 / 词表不可用）
    customWordCount: custom.entryCount,
    // 这次实际生效的规则开关（渲染层面板照着画「开 / 关」，不写配置）
    rules: { ...rules },
    options
  };
}

module.exports = {
  RULE_ORDER,
  RULE_LABELS,
  DEFAULT_RULES,
  DEFAULT_OPTIONS,
  sanitizeOptions,
  sanitizeRules,
  proofreadText
};
