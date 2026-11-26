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
const { clampInt, formatCount, normalizeText, lineStartsOf, positionOf, truncateSafe, HAN_RANGES, toHalfWidth } =
  require('./common');

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

// 正文超过这么多字符只校对前面的部分（病态输入兜底，正常一章远小于这个数）。
// B4（v1.8.0 WP-27）：与 core/tts.js 的 MAX_SOURCE_CHARS 同一口径（100 万字）——校对是纯 CPU 的
// 多趟扫描，百万字以上在主进程里同步跑会把界面卡住；超限时如实回 tooLarge，面板据此说明
// 「只校对了前 100 万字」，不假装全书都查过。判定看归一换行之后的长度（与 index / 行号同一坐标系）。
const MAX_SOURCE_CHARS = 1000000;

const OPTION_LIMITS = Object.freeze({
  longParagraph: [50, 20000],
  repeatWindow: [20, 5000],
  repeatCount: [2, 20],
  maxIssues: [20, 5000]
});

// C42（v1.8.0 WP-26）：汉字范围必须覆盖 CJK 扩展 B–G 与兼容补充（U+20000 起，如「𠮷」）。
// 这些字是代理对，正则带 u 标志按码点匹配；逐字扫描的规则也要按码点取整字（见 repeatWordIssues /
// 中英间距 / 破折号）。A2（v1.8.0 WP-31）：范围串已收编到 core/common.js（与 core/format.js 同一份）。
const HAN_RE = new RegExp(`[${HAN_RANGES}]`, 'u');

// 按 UTF-16 下标取一个完整字符（代理对算一个）；越界返回空串。
function charAt(text, index) {
  if (index < 0 || index >= text.length) return '';
  const code = text.codePointAt(index);
  return code > 0xffff ? text.slice(index, index + 2) : text[index];
}

// 取下标 index 之前的最后一个完整字符（代理对算一个）。
function charBefore(text, index) {
  if (index <= 0) return '';
  const low = text.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) return text.slice(index - 2, index);
  return text.slice(index - 1, index);
}
// 连续标点判定里认的全角标点（半角标点由第 ① 条单独报，避免一条内容报两次）
const CJK_RUN_PUNCT = new Set(['，', '。', '；', '：', '！', '？', '、', '…', '—']);
// 审计修复 #49（E24）：半角标点也参与「连续」判定 —— 旧集合只有全角，遇到「。。.」「-——」
// 这类混排会在半角处停下，三位标点只数到两位而漏报。半角仍由第 ① 条单独给改法，两条各说一件事。
const ASCII_RUN_PUNCT = new Set(['.', ',', ';', ':', '!', '?', '-']);
const RUN_PUNCT = new Set([...CJK_RUN_PUNCT, ...ASCII_RUN_PUNCT]);
const SNIPPET_RADIUS = 18;
const PARAGRAPH_PREFIX = 24;

// KNOWN-PROOF（中）：单条 issue 的体积上限。省略号 / 破折号 / 全角数字与「连续标点」同口径：
// match / message / suggestion 只带前 PARAGRAPH_PREFIX 个字，length 仍是整段真实长度（选中整段、
// 计数不错）。以前把整段 run 原样塞进三处 —— 病态输入（几十万连排的点 / 全角数字）单条 issue
// 就携带整段原文的多份副本，跨 IPC 进面板时撑爆内存。
function showRun(run) {
  const text = String(run == null ? '' : run);
  return text.length > PARAGRAPH_PREFIX ? text.slice(0, PARAGRAPH_PREFIX) : text;
}

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

// 统计收集器：总数 / 各条数照实统计；真正保留的明细按规则各留上限（单章最多 maxIssues 条），
// 避免「一整章英文引号」这类极端文本把内存和界面刷爆。
// 审计修复 #15（E12）：旧实现是一份全局 keepLimit（maxIssues × 2）先到先得 —— 先扫到的规则把它
// 占满后，后序规则（尤其最后统一结算的自定义词表）只剩 byRule 计数、一条明细都留不下，作者在
// 面板里看得见「命中 N 处」却定位不到任何一处。现在每条规则各留最多 maxIssues 条（规则数 ×
// maxIssues 仍是每章一个常数：默认 10 × 400 = 4000 个小对象，单条规则反而比改前的 800 更少），
// 结算时把明细预算按「有命中的规则数」均分（余数按 RULE_ORDER 补给前面的规则），谁也不会被挤没。
function createCollector(maxIssues) {
  const cap = Math.max(maxIssues, 1);
  const byRule = {};
  for (const rule of RULE_ORDER) byRule[rule] = 0;
  const kept = new Map(); // 规则 → 明细（按扫描顺序 = 位置顺序）
  let total = 0;
  return {
    // 审计修复 #54（P7）：这条规则还能不能再收明细。addIssue 在构建 snippet / 完整 issue 对象之前
    // 先问一次 —— 病态输入（一整章英文引号 / 百万字连排标点）后面成千上万条命中会被 collector
    // 丢掉，旧实现却是「先构建再丢弃」，白拼片段、白建对象。
    wants(rule) {
      const list = kept.get(rule);
      return !list || list.length < cap;
    },
    // 只记账、不留明细（明细已满时 addIssue 走这里，不再构建 issue 对象）。
    countOnly(rule) {
      total += 1;
      byRule[rule] = (byRule[rule] || 0) + 1;
    },
    add(issue) {
      total += 1;
      byRule[issue.rule] = (byRule[issue.rule] || 0) + 1;
      let list = kept.get(issue.rule);
      if (!list) {
        list = [];
        kept.set(issue.rule, list);
      }
      if (list.length < cap) list.push(issue);
    },
    finish() {
      // 只给真有命中的规则分额度；规则数（≤10）永远小于预算下限（maxIssues ≥ 20），
      // 所以每条规则至少能分到 1 条明细 —— 这正是「有计数没条目」不再发生的条件。
      const rules = RULE_ORDER.filter((rule) => kept.has(rule));
      // CTXT-B-08：没有任何规则命中时直接给空结果 —— 不再靠 cap / 0 = Infinity、cap % 0 = NaN
      // 这两个「上游不消费所以看不出问题」的巧合兜住。
      if (!rules.length) return { issues: [], total, byRule };
      const base = Math.floor(cap / rules.length);
      const extra = cap % rules.length;
      const quota = new Map();
      rules.forEach((rule, index) => quota.set(rule, Math.max(1, base + (index < extra ? 1 : 0))));
      const cursor = new Map();
      const issues = [];
      let budget = cap;
      // 第一轮：每条规则先拿自己那份配额（命中数不到配额就少拿，单条规则照旧最多 cap 条）
      for (const rule of rules) {
        const list = kept.get(rule);
        const take = Math.min(list.length, quota.get(rule), budget);
        for (let i = 0; i < take; i += 1) issues.push(list[i]);
        cursor.set(rule, take);
        budget -= take;
      }
      // 第二轮：有规则没交够（命中本来就少）时，空出来的额度按规则轮转补回去 ——
      // 明细预算尽量用满，不因为某条规则命中少就白扔掉别的规则还能显示的位置。
      let progressed = rules.length > 0;
      while (budget > 0 && progressed) {
        progressed = false;
        for (const rule of rules) {
          if (budget <= 0) break;
          const list = kept.get(rule);
          const at = cursor.get(rule);
          if (at < list.length) {
            issues.push(list[at]);
            cursor.set(rule, at + 1);
            budget -= 1;
            progressed = true;
          }
        }
      }
      return { issues, total, byRule };
    }
  };
}

// 连续标点数：把连排的「……」/「——」每**两个**字符折叠成 1 个单位，其余每个标点算一个单位。
// T-09（三审）：旧实现「与前一字符相同就跳过」把 N 个相同字符恒折成 **1** 个单位，与这段注释的
// 设计口径（每两个字符 1 单位）矛盾 —— 「………………」（6 个 … = 3 个完整省略号）只算 1 单位，
// 永远够不到 punct-run 的 3 单位阈值，作者连按省略号的真笔误被静默漏报（「—」连排尚有规则⑧兜底，
// 「…」没有任何兜底）。现在偶数位跳过：2 字符 1 单位、4 字符 2 单位、6 字符 3 单位（= ceil(N/2)）。
// 审计修复 #49（E24）：全角 + 半角混排时按字符数算 —— 「-——」「。。.」这类 3 个标点
// 如果仍按折叠单位数（2）就会被漏报。
// 纯 ASCII 连排（「...」「---」「?!」）一律返回 0：它们分别由省略号 / 破折号规则负责，
// 旧行为也不把它们算进「连续标点」，不能为了混排把纯 ASCII 文本变成新的误报。
// CTXT-B-07：可选 start / end 直接数 source 的一段，不物化子串 —— 病态输入（百万字连排标点）
// 要在「额度还有没有」的预检通过之后才允许生成字符串。
function countPunctUnits(run, start = 0, end) {
  const from = Math.max(0, Math.floor(Number(start) || 0));
  const to = Math.min(run.length, end === undefined ? run.length : Math.floor(Number(end) || 0));
  let units = 0;
  let hasAscii = false;
  let hasCjk = false;
  let repeat = 0; // 与前一字符相同的连排次数（T-09：偶数位跳过 ⇒ 每两个字符 1 单位）
  for (let i = from; i < to; i += 1) {
    const ch = run[i];
    if (ASCII_RUN_PUNCT.has(ch)) hasAscii = true;
    else if (CJK_RUN_PUNCT.has(ch)) hasCjk = true;
    if ((ch === '…' || ch === '—') && i > from && run[i - 1] === ch) {
      repeat += 1;
      if (repeat % 2 === 1) continue;
      units += 1;
      continue;
    }
    repeat = 0;
    units += 1;
  }
  if (!hasCjk) return 0;
  return hasAscii ? Math.max(0, to - from) : units;
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

function isHanChar(ch) {
  return Boolean(ch) && HAN_RE.test(ch);
}

// 破折号判定的「中文邻居」：汉字或中文标点（连排的「……」/「——」也算）
function isCjkNeighbor(ch) {
  return Boolean(ch) && (HAN_RE.test(ch) || CJK_NEIGHBOR_PUNCT.has(ch));
}

// 全角数字 → 半角：换算走 core/common.js 的 toHalfWidth（A2，v1.8.0 WP-31；与跳章输入同一份实现）

// 重复用词：先按「不重叠」贪心取每个双字词的出现位置（「哈哈哈哈」的「哈哈」只算 2 次，
// 不会因为重叠命中被误判成 3 次），再找最早一个能装下 repeatCount 次的窗口。
// C42：按码点切字（扩展 B 汉字是代理对，逐 UTF-16 单元看会把它拆成两个「非汉字」）。
// E14（审计修复 #17）：去重距离与窗口宽度都按「字（码点）」算 —— 内部一律用码点序号，只在回包时
// 折算回 UTF-16 下标（source / 片段 / 高亮都用这一套坐标）。旧实现把代理对文本的 UTF-16 长度当
// 字数：重叠去重的「起点差 < 3 字」被放大成 6 个码元（同一短语刷两条），repeatWindow 也减半。
// 审计修复 #54（P7）：旧实现先建 chars[] + starts[] 两个按码点的数组（百万字单段 = 瞬时百万个
// 字符串对象 + 百万个数字），再把每个二字词的码点起点塞进 Map。P7 改成单遍扫描直接看相邻两个整字，
// 只记「二字词 → 码点起点」；UTF-16 下标等最终保留的命中确定后，再顺序扫一遍折算（命中数量很小）。
// 审计 B8 / #17（低）：单遍仍给**每个**二字词建一个起点数组 —— 常见文本里绝大多数二元组只出现
// 一两次，这些数组纯属浪费。改成两遍：
//   · 第一遍只计数（Map<码点对数值键, 次数>，不建数组、不拼二字词字符串）；
//   · 只给「原始出现数 ≥ repeatCount」的候选词建位置表（非重叠出现数 ≤ 原始出现数，过滤安全）；
//     第一遍的计数表在此之前 clear 掉，峰值不再是一整张位置表。
//   判定结果（命中词 / 起点 / 次数 / 去重窗口）逐项不变；数值键见 bigramKey。
function bigramKey(prevCode, code) {
  // 两个码点各 ≤ 0x10FFFF：0x110000 进制编码无碰撞且 < 2^53（安全整数）。
  return prevCode * 0x110000 + code;
}

function repeatWordIssues(line, options) {
  const counts = new Map();
  let prevCh = '';
  let prevCode = -1;
  let cp = 0;
  for (let i = 0; i < line.length; cp += 1) {
    const ch = charAt(line, i);
    const code = ch.codePointAt(0);
    if (prevCh && isHanChar(prevCh) && isHanChar(ch)) {
      const wordKey = bigramKey(prevCode, code);
      counts.set(wordKey, (counts.get(wordKey) || 0) + 1);
    }
    prevCh = ch;
    prevCode = code;
    i += ch.length;
  }
  const candidates = new Set();
  for (const [wordKey, count] of counts) if (count >= options.repeatCount) candidates.add(wordKey);
  counts.clear();
  if (!candidates.size) return [];
  const positions = new Map();
  prevCh = '';
  prevCode = -1;
  let prevCp = -1;
  cp = 0;
  for (let i = 0; i < line.length; cp += 1) {
    const ch = charAt(line, i);
    const code = ch.codePointAt(0);
    if (prevCh && isHanChar(prevCh) && isHanChar(ch)) {
      const wordKey = bigramKey(prevCode, code);
      if (candidates.has(wordKey)) {
        const word = prevCh + ch;
        const list = positions.get(word);
        if (list) list.push(prevCp);
        else positions.set(word, [prevCp]);
      }
    }
    prevCh = ch;
    prevCode = code;
    prevCp = cp;
    i += ch.length;
  }
  const found = []; // { word, start（码点序号）, count }
  for (const [word, raw] of positions) {
    const occ = [];
    let lastEnd = -1;
    for (const pos of raw) {
      if (pos < lastEnd) continue;
      occ.push(pos);
      lastEnd = pos + 2; // 双字词 = 2 个字
    }
    if (occ.length < options.repeatCount) continue;
    let windowStart = -1;
    for (let j = options.repeatCount - 1; j < occ.length; j += 1) {
      const start = occ[j - options.repeatCount + 1];
      // WP14 C6（审计低批）：窗口判定按「起点在窗口内」（start 距离 < repeatWindow），
      // 与消息「在 N 字内出现 K 次」和下面的计数区间 [windowStart, windowEnd) 同一口径。
      // 旧实现按「整词容纳」（occ[j] + 2 - start <= repeatWindow）：起 0/100/299、窗口 300 时
      // 299 + 2 = 301 > 300 被漏报，但三个起点其实都落在 [0, 300)。
      if (occ[j] - start < options.repeatWindow) {
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
  // 码点序号 → UTF-16 下标：命中按 start 升序，顺序扫一遍就够（不保留整篇的码点表）。
  const out = [];
  let atCp = 0;
  let at = 0;
  for (const hit of kept) {
    while (atCp < hit.start) {
      at += charAt(line, at).length;
      atCp += 1;
    }
    out.push({ word: hit.word, start: at, count: hit.count });
  }
  return out;
}

// rawGlossary 可选：作者自己的校对词表（[{ term, suggestion }]，建议可为空）。
// 不传 / 传空数组时只有九条内置规则在跑（「自定义词表」这一条命中数为 0），其余行为与不传词表一致。
function proofreadText(text, rawOptions, rawGlossary) {
  const options = sanitizeOptions(rawOptions);
  const rules = sanitizeRules(rawOptions && rawOptions.rules);
  const whole = normalizeText(text);
  // B4（WP-27）：规模闸——只扫前 MAX_SOURCE_CHARS 个字符（并在结果里如实标 tooLarge）。
  // 截断点走 common.truncateSafe，不会切开代理对；坐标仍是归一后的全文坐标系（body 是前缀）。
  const tooLarge = whole.length > MAX_SOURCE_CHARS;
  const source = tooLarge ? truncateSafe(whole, MAX_SOURCE_CHARS) : whole;
  const collector = createCollector(options.maxIssues);
  // P-08（1.6.0 A5）：只要位置、不拼结果。整本校对明细预算用完后，后面的章只统计条数
  // （issues 会被丢掉），传 snippets:false 就不再为每条命中拼上下文片段（前后各 18 字 + 空白压缩）。
  // 位置 / 行号 / match / message 照旧算，snippet 给 null；默认 true，校对面板的上下文列不变。
  const wantSnippets = !(rawOptions && typeof rawOptions === 'object' && rawOptions.snippets === false);

  // 统一兜底：位置、行号、上下文片段一次生成，各规则只关心「报什么」
  // 审计修复 #54（P7）：明细额度预检 —— 这条规则已经收满 maxIssues 条时只计数，
  // 不再拼 snippet、不再建 issue 对象（后面 collector 本来也会把它丢掉）。
  const addIssue = (rule, index, selectLength, match, message, extra) => {
    if (!collector.wants(rule)) {
      collector.countOnly(rule);
      return;
    }
    const cleanMatch = String(match == null ? '' : match);
    const matchLength = cleanMatch.length || Math.min(Math.max(selectLength, 1), PARAGRAPH_PREFIX);
    const snippet = !wantSnippets
      ? null
      : extra && extra.snippet
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
  // B7（审计 #16）：校对只要回调报告、完全丢弃返回的正文 —— reportOnly 分支跳过逐字 parts
  // 与整段 join 副本（长段落里省掉百万级临时字符串），判定与回调序列仍是同一份实现。
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
      }, { reportOnly: true });
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
          hit.word.length,
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
      // CTXT-B-07：先在不物化子串的前提下数单位；额度已满时只 countOnly，绝不先拼整段。
      const units = countPunctUnits(source, i, j);
      if (units >= 3) {
        if (!collector.wants('punct-run')) {
          collector.countOnly('punct-run');
        } else {
          // match / message 与超长段落同口径截到 PARAGRAPH_PREFIX：单条 issue 体积有硬上限，
          // 百万字连排标点也不会整段跨 IPC 进面板。
          const run = source.slice(i, j);
          const shown = showRun(run);
          addIssue('punct-run', i, run.length, shown, `连续 ${units} 个标点「${shown}」`);
        }
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
        // P-08：blank-lines 自己拼片段（三条 slice + 两个长度判定）；不要片段时连这些也算省掉
        const extra = { count };
        if (wantSnippets) {
          const beforeLine = lineIndex > 0 ? lines[lineIndex - 1] : '';
          const afterLine = next < lines.length ? lines[next] : '';
          extra.snippet = {
            before: beforeLine.slice(-SNIPPET_RADIUS),
            match: `${count} 个空行`,
            after: afterLine.slice(0, SNIPPET_RADIUS),
            ellipsisStart: beforeLine.length > SNIPPET_RADIUS,
            ellipsisEnd: afterLine.length > SNIPPET_RADIUS
          };
        }
        addIssue('blank-lines', index, Math.max(1, end - index), '', `这里有 ${count} 个连续空行`, extra);
      }
      lineIndex = next;
    }
  }

  // ⑥ 中英间距（默认关）：汉字 与 拉丁字母 / 数字 直接相邻、中间没有空格。
  // 一个边界报一条（「他用iPhone手机」= 「用i」「e手」两条），只报告不改字。
  // 中文以标点结尾（「OK。」「他说，iPhone」）不算缺空格——中文标点旁边本来就不加空格，
  // 只把「汉字 ↔ 拉丁字母/数字」这一种边界算进来，免得把正常排版判成问题。
  if (rules['cjk-latin-spacing']) {
    for (let i = 0; i < source.length; i += 1) {
      // C42：左右都按码点取整字（扩展 B 汉字 + 拉丁字母的边界也算）。
      const left = charAt(source, i);
      const nextIndex = i + left.length;
      if (nextIndex >= source.length) break;
      const right = charAt(source, nextIndex);
      const other = isHanChar(left) ? right : isHanChar(right) ? left : '';
      if (other && LATIN_CHAR_RE.test(other)) {
        const match = left + right;
        addIssue('cjk-latin-spacing', i, match.length, match, `「${match}」之间建议加一个空格`, {
          suggestion: `${left} ${right}`
        });
      }
      if (left.length > 1) i += 1; // 跳过低代理，别把后半字再当左字
    }
  }

  // ⑦⑧⑨ 合并成一趟逐字符扫描（B4 / WP-27）：省略号（半角点 / 「。」）、破折号（- / —）、
  // 全角数字三组字符互不重叠，按当前字符分派即可；省掉两趟整章扫描。
  // B6（审计 #15）：命中**先问 collector.wants(rule)** —— 额度已满时只 collector.countOnly
  //（扫描继续、计数照旧准确），不再物化 { index, length, run }、不再 source.slice 整段。
  // 旧实现把三组命中先分桶存着、扫完才交给 addIssue：addIssue 的额度预检（#54/P7）挡得到
  // issue 对象，挡不到桶里的命中 —— 病态输入（「１a」×50 万）会先建 50 万个桶对象再丢掉。
  // 同规则内命中仍按扫描顺序进入收集器，最终明细按位置统一排序：保留哪几条与旧实现一致。
  if (rules.ellipsis || rules.dash || rules['fullwidth-digit']) {
    for (let i = 0; i < source.length; ) {
      const ch = source[i];
      // ⑦ 省略号：3 个及以上半角点，或 3 个及以上「。」→ 建议「……」。
      // 「。。。」同时会被 ④ 报一次（④ 说「连续标点」、这条说「该写成……」，各说一件事）。
      if (ch === '.' || ch === '。') {
        let j = i + 1;
        while (j < source.length && source[j] === ch) j += 1;
        if (rules.ellipsis && j - i >= 3) {
          if (collector.wants('ellipsis')) {
            const shown = showRun(source.slice(i, j));
            addIssue('ellipsis', i, j - i, shown, `省略号「${shown}」建议改成「……」`, {
              suggestion: '……'
            });
          } else {
            collector.countOnly('ellipsis');
          }
        }
        i = j;
        continue;
      }
      // ⑧ 破折号：「--」「---」或单个「—」→ 建议「——」。只有挨着中文才报：
      // 日期区间 12-30、单独一行的分隔线 ---- 都不算中文破折号。
      if (ch === '-' || ch === '—') {
        let j = i + 1;
        while (j < source.length && source[j] === ch) j += 1;
        if (rules.dash) {
          const count = j - i;
          // C42：前后邻居也按码点取（紧挨扩展 B 汉字的破折号同样算中文语境）。
          const prev = charBefore(source, i);
          const next = charAt(source, j);
          const bad = ch === '-' ? count >= 2 : count !== 2;
          if (bad && (isCjkNeighbor(prev) || isCjkNeighbor(next))) {
            if (collector.wants('dash')) {
              const shown = showRun(source.slice(i, j));
              addIssue('dash', i, count, shown, `破折号「${shown}」建议用两个「——」`, {
                suggestion: '——'
              });
            } else {
              collector.countOnly('dash');
            }
          }
        }
        i = j;
        continue;
      }
      // ⑨ 全角数字：一整段全角数字合成一条，建议字符串直接给半角版本
      if (FULLWIDTH_DIGIT_RE.test(ch)) {
        let j = i + 1;
        while (j < source.length && FULLWIDTH_DIGIT_RE.test(source[j])) j += 1;
        if (rules['fullwidth-digit']) {
          if (collector.wants('fullwidth-digit')) {
            const run = source.slice(i, j);
            const shown = showRun(run);
            const ascii = showRun(toHalfWidth(run, { digitsOnly: true }));
            addIssue(
              'fullwidth-digit',
              i,
              run.length,
              shown,
              `全角数字「${shown}」建议改成半角「${ascii}」`,
              { suggestion: ascii }
            );
          } else {
            collector.countOnly('fullwidth-digit');
          }
        }
        i = j;
        continue;
      }
      i += 1;
    }
  }

  // ⑩ 自定义校对词表（可选的作者词表；没有词表时这一条不产出任何结果）
  // 1.7.2 D2（V44）：主进程的读取出口已按同一份 sanitizeEntries 清洗过词条（options.entriesSanitized），
  // 这里不再洗第二遍，并把「已清洗」交给 findHits——同一份词表在一条链路上只 sanitize 一次。
  // 旧调用（不传标记）行为不变：仍在这里清洗一次，结果与改前逐字一致。
  const entriesSanitized = Boolean(
    rawOptions && typeof rawOptions === 'object' && rawOptions.entriesSanitized === true
  );
  const customEntries = entriesSanitized
    ? Array.isArray(rawGlossary)
      ? rawGlossary
      : []
    : glossaryLib.sanitizeEntries(rawGlossary);
  const custom = rules['custom-word']
    ? glossaryLib.findHits(source, customEntries, { sanitized: true })
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
  // 审计修复 #15（E12）：collector 已按规则配额结算（每条规则都在明细里占到自己那份），
  // 这里只按位置排序 + 再兜一次总上限 —— 不再是「按规则顺序先到先得」把后序规则整段截掉。
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
    // X4（v1.8.0 WP-24）：chars = 正文字数（去空白），与敏感词预检 / 捕获队列 / 状态栏同一口径；
    // rawLength 保留「含空白的原文长度」（旧 chars 的值），两个接口的契约从此一致。
    // B4（WP-27）：两个字段仍按**全文**算（超长截断不改变字数契约）；scannedChars 才是实际扫过的长度。
    chars: chaptersLib.countChars(whole),
    rawLength: whole.length,
    // B4（WP-27）：tooLarge = 正文超过 MAX_SOURCE_CHARS，只扫了前 scannedChars 个字符；
    // 与 truncated（明细只列出一部分、总数照实）分开：面板要说明「只校对了前 100 万字」。
    tooLarge,
    scannedChars: source.length,
    // 这次实际参与匹配的校对词条数（0 = 没设置词表 / 词表不可用）
    customWordCount: custom.entryCount,
    // 这次实际生效的规则开关（渲染层面板照着画「开 / 关」，不写配置）
    rules: { ...rules },
    options
  };
}

module.exports = {
  MAX_SOURCE_CHARS,
  RULE_ORDER,
  RULE_LABELS,
  DEFAULT_RULES,
  DEFAULT_OPTIONS,
  // B5（#14）：整本校对在明细预算用尽后把单章 maxIssues 降到下限 —— 下限的唯一事实源。
  OPTION_LIMITS,
  sanitizeOptions,
  sanitizeRules,
  proofreadText
};
