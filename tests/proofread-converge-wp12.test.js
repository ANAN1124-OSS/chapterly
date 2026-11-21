'use strict';
// WP12（审计 B5/B6/B7/B8 / 合并清单 #14–#17）校对收敛锚点：
//   B5：整本明细预算（1500 条）用尽后，敏感词只计数（details:false）、校对把单章 maxIssues 降到下限；
//   B6：⑦⑧⑨（省略号 / 破折号 / 全角数字）命中先问额度，不再「先物化再丢弃」；
//   B7：convertPunct 报告-only 分支（校对规则①丢弃返回正文）；
//   B8：repeatWordIssues 两遍法（先计数、再只为候选词收集起点）。
//
// 整本两个 handler 没有行为单测（既有测试只切源码做静态闸门），这里用最小 host 装配真实
// ipc/proofread.js（先例 tests/book-data-ipc.test.js 的 makeBookDataHost），临时书目录含中文与空格。
// 判定口径不变用「逐章全量参考实现」对拍；性能/内存差异由 scripts/bench-proofread.js 出前后数据。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const tmpCleanup = require('./tmp-cleanup');
const storage = require('../core/storage');
const exporter = require('../core/exporter');
const proofreadLib = require('../core/proofread');
const glossaryLib = require('../core/glossary');
const sensitiveLib = require('../core/sensitive');
const formatLib = require('../core/format');
const findLib = require('../core/find');
const ipcLimits = require('../core/ipc-limits');
const configLib = require('../core/config');
const pathUtils = require('../core/path-utils');
const { mapLimit } = require('../core/common');
const ipcProofread = require('../ipc/proofread');

const ROOT = path.join(__dirname, '..');
const read = (rel) => require('node:fs').readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const sliceFunction = (source, marker) => {
  const start = source.indexOf(marker);
  assert.ok(start > 0, `找不到 ${marker}`);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, `${marker} 的函数体没有按预期结束`);
  return source.slice(start, end);
};

const RULES_OFF = {};
for (const rule of proofreadLib.RULE_ORDER) RULES_OFF[rule] = false;

// TB-02：临时目录统一经 tests/tmp-cleanup.js 的 mkTmp（mkdtemp + 登记回收）。
const mkTmp = (prefix = 'cw-wp12-') => tmpCleanup.mkTmp(prefix);

// 最小 host 装配真实 ipc/proofread.js：频道名 → 处理函数（handle / handleBook 不做副作用）。
function makeHost({ config, proofreadModule = proofreadLib, sensitiveModule = sensitiveLib }) {
  const channels = new Map();
  const host = {
    handle: (channel, handler) => channels.set(channel, handler),
    handleBook: (channel, handler) => channels.set(channel, handler),
    storage,
    exporter,
    proofreadLib: proofreadModule,
    glossaryLib,
    sensitiveLib: sensitiveModule,
    ipcLimits,
    assertText: ipcLimits.assertText,
    mapLimit,
    CHAPTER_READ_CONCURRENCY: 8,
    CHAPTER_BATCH_SIZE: 32,
    WORDLIST_MAX: configLib.WORDLIST_MAX,
    path,
    fs,
    pathUtils,
    getConfig: async () => config,
    getConfigStore: () => ({ set: async (patch) => ({ ...config, ...patch }) }),
    applyConfig: () => {},
    showOpenDialog: async () => ({ canceled: true }),
    rememberPickedConfigPath: () => {}
  };
  ipcProofread.register(host);
  return channels;
}

// 建一本临时书：首章用 createBook 自带的那一章（改名 / 写正文），其余用 createChapterWithText。
async function makeBook(dir, title, texts) {
  const booksRoot = path.join(dir, '书架 目录');
  await fs.mkdir(booksRoot, { recursive: true });
  const created = await storage.createBook(booksRoot, title);
  const first = created.meta.chapters[0];
  if (texts[0]) await storage.saveChapterText(created.path, first.file, texts[0]);
  for (let index = 1; index < texts.length; index += 1) {
    await storage.createChapterWithText(created.path, {
      insertIndex: index,
      name: `第${index + 1}章`,
      text: texts[index]
    });
  }
  return created.path;
}

// 敏感词整本 handler 的参考实现（与 ipc/proofread.js 的数据逻辑同形，不做明细降档）。
async function referenceBookSensitive(bookPath, options) {
  const meta = await storage.readBookMeta(bookPath);
  const limits = sensitiveLib.sanitizeOptions(options);
  const words = ['色情', '暴力'];
  const matches = [];
  const chapters = [];
  const byWordMap = new Map();
  let total = 0;
  let truncated = false;
  for (let index = 0; index < meta.chapters.length; index += 1) {
    const chapter = meta.chapters[index];
    const text = (await storage.loadChapterText(bookPath, chapter.file)).text;
    const result = sensitiveLib.scanText(text, words, limits);
    total += result.total;
    for (const item of result.byWord) byWordMap.set(item.word, (byWordMap.get(item.word) || 0) + item.count);
    if (result.total) {
      chapters.push({ chapterId: chapter.id, chapterIndex: index, name: chapter.name, total: result.total, truncated: result.truncated });
    }
    if (result.truncated) truncated = true;
    for (const match of result.issues) {
      if (matches.length >= sensitiveLib.BOOK_ISSUE_LIMIT) {
        truncated = true;
        break;
      }
      matches.push({ ...match, chapterId: chapter.id, chapterIndex: index, chapterName: chapter.name });
    }
  }
  const byWord = Array.from(byWordMap, ([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0))
    .slice(0, sensitiveLib.BY_WORD_LIMIT);
  return {
    total,
    matches,
    byWord,
    wordHitCount: byWordMap.size,
    chapters,
    chapterCount: meta.chapters.length,
    chapterHitCount: chapters.length,
    truncated: truncated || total > matches.length
  };
}

// 校对整本 handler 的参考实现（逐章仍传完整 maxIssues，不做预算降档）。
async function referenceBookProofread(bookPath, options = {}) {
  const meta = await storage.readBookMeta(bookPath);
  const limits = proofreadLib.sanitizeOptions(options);
  const rules = proofreadLib.sanitizeRules(options && options.rules);
  const chapterOptions = { ...limits, rules, entriesSanitized: true };
  const byRule = {};
  for (const rule of proofreadLib.RULE_ORDER) byRule[rule] = 0;
  const chapters = [];
  const issues = [];
  let total = 0;
  let truncated = false;
  let tooLarge = false;
  let snippetsWanted = true;
  for (let index = 0; index < meta.chapters.length; index += 1) {
    const chapter = meta.chapters[index];
    let text = '';
    try {
      text = (await storage.loadChapterText(bookPath, chapter.file)).text;
    } catch (err) {
      if (err.code === 'CHAPTER_MISSING') continue;
      throw err;
    }
    const result = proofreadLib.proofreadText(
      text,
      snippetsWanted ? chapterOptions : { ...chapterOptions, snippets: false },
      []
    );
    total += result.total;
    for (const rule of proofreadLib.RULE_ORDER) byRule[rule] += result.byRule[rule] || 0;
    if (result.total) {
      chapters.push({
        chapterId: chapter.id,
        chapterIndex: index,
        name: chapter.name,
        total: result.total,
        byRule: result.byRule,
        truncated: result.truncated
      });
    }
    if (result.truncated) truncated = true;
    if (result.tooLarge) tooLarge = true;
    for (const issue of result.issues) {
      if (issues.length >= 1500) {
        truncated = true;
        break;
      }
      issues.push({ ...issue, chapterId: chapter.id, chapterIndex: index, chapterName: chapter.name });
    }
    if (issues.length >= 1500) snippetsWanted = false;
  }
  return { total, byRule, issues, chapters, chapterCount: meta.chapters.length, chapterHitCount: chapters.length, truncated: truncated || total > issues.length, tooLarge };
}

// 只开一条规则跑校对，拿到该规则的命中明细（bug 差分 / 截断口径用）。
function issuesOfRule(text, rule, options = {}) {
  const result = proofreadLib.proofreadText(text, {
    ...options,
    rules: { ...RULES_OFF, ...(options.rules || {}), [rule]: true }
  });
  return result;
}

// 审计前（单遍 + 每词位置数组）的重复用词实现，只当语义基线：输出 { word, start, count }。
function referenceRepeatWordIssues(line, options) {
  const HAN_RE = new RegExp(`[${require('../core/common').HAN_RANGES}]`, 'u');
  const charAt = (text, index) => {
    if (index < 0 || index >= text.length) return '';
    const code = text.codePointAt(index);
    return code > 0xffff ? text.slice(index, index + 2) : text[index];
  };
  const isHanChar = (ch) => Boolean(ch) && HAN_RE.test(ch);
  const positions = new Map();
  let prevCh = '';
  let prevCp = -1;
  let cp = 0;
  for (let i = 0; i < line.length; cp += 1) {
    const ch = charAt(line, i);
    if (prevCh && isHanChar(prevCh) && isHanChar(ch)) {
      const word = prevCh + ch;
      const list = positions.get(word);
      if (list) list.push(prevCp);
      else positions.set(word, [prevCp]);
    }
    prevCh = ch;
    prevCp = cp;
    i += ch.length;
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
  found.sort((a, b) => a.start - b.start);
  const kept = [];
  for (const hit of found) {
    const last = kept[kept.length - 1];
    if (last && hit.start < last.start + 3) continue;
    kept.push(hit);
  }
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

function snippetCounter() {
  const original = findLib.makeSnippet;
  const state = { calls: 0 };
  findLib.makeSnippet = (...args) => {
    state.calls += 1;
    return original(...args);
  };
  state.restore = () => {
    findLib.makeSnippet = original;
  };
  return state;
}

// ---------------------------------------------------------------- B5

test('R1/B5：sensitive.scanText details:false 只计数 —— 不建明细、不算行号、不拼片段、口径不变', () => {
  const text = '第一行没有。\r\n第二行有色情和暴力。\r\n第三行又见色情。';
  const words = ['色情', '暴力'];
  const full = sensitiveLib.scanText(text, words, { maxIssues: 20 });
  const lean = sensitiveLib.scanText(text, words, { maxIssues: 20, details: false });
  assert.equal(lean.total, full.total, '总数照实统计');
  assert.deepEqual(lean.byWord, full.byWord, '逐词次数照旧');
  assert.equal(lean.wordHitCount, full.wordHitCount);
  assert.equal(lean.wordCount, full.wordCount);
  assert.equal(lean.chars, full.chars);
  assert.equal(lean.rawLength, full.rawLength);
  assert.deepEqual(lean.issues, [], '不要明细时一条都不物化');
  assert.equal(full.issues.length, 3, '默认分支仍给明细（保护性锚点）');

  // 不拼片段 / 不算行首表：旧实现会为 min(total,maxIssues) 条命中调 makeSnippet。
  const counter = snippetCounter();
  try {
    const leanAgain = sensitiveLib.scanText(text, words, { maxIssues: 20, details: false });
    assert.equal(counter.calls, 0, `details:false 不许拼片段：实际 ${counter.calls} 次`);
    assert.equal(leanAgain.issues.length, 0);
    const fullAgain = sensitiveLib.scanText(text, words, { maxIssues: 20 });
    assert.equal(counter.calls, fullAgain.issues.length, '默认分支每个保留的明细拼且只拼一次');
  } finally {
    counter.restore();
  }

  // 极值：原始命中超过 RAW_MATCH_LIMIT → truncated 仍如实（它反映扫描上限，不是明细截断）
  const huge = sensitiveLib.scanText('a'.repeat(150000), ['a'], { maxIssues: 20, details: false });
  assert.equal(huge.issues.length, 0);
  assert.equal(huge.truncated, true, '原始命中超上限必须如实标 truncated');
  assert.ok(huge.total >= 100000 - 1 && huge.total <= sensitiveLib.RAW_MATCH_LIMIT);
});

test('R2/B5：整本敏感词预算用尽后只计数 —— 明细 / 总数 / 逐词与参考实现逐项一致，片段只建前 1500 条', async () => {
  const dir = await mkTmp();
  const chapters = Array.from({ length: 6 }, () => '色情'.repeat(500)); // 每章 500 命中
  const bookPath = await makeBook(dir, '整本 敏感词书', chapters);
  const wordsPath = path.join(dir, '敏感词.txt');
  await fs.writeFile(wordsPath, '色情\n暴力\n', 'utf8');
  const config = { sensitiveWordsPath: wordsPath };

  // 冷启动（不带插桩）先拿一份结果，确认夹具真的触到 1500 预算。
  const plain = await makeHost({ config }).get('book:sensitive-check')(bookPath, {}, null);
  assert.equal(plain.ok, true);
  assert.equal(plain.total, 3000);
  assert.equal(plain.matches.length, 1500, '整本明细上限 1500');
  assert.equal(plain.truncated, true);

  const calls = [];
  const wrapped = {
    ...sensitiveLib,
    scanText: (text, words, options) => {
      calls.push({ ...(options || {}) });
      return sensitiveLib.scanText(text, words, options);
    }
  };
  const channels = makeHost({ config, sensitiveModule: wrapped });
  const counter = snippetCounter();
  let result;
  try {
    result = await channels.get('book:sensitive-check')(bookPath, {}, null);
    assert.equal(counter.calls, 1500, `预算用尽后不再白拼片段：实际 ${counter.calls} 次（改前 = 3000）`);
  } finally {
    counter.restore();
  }

  assert.equal(calls.length, 6, '每章一次 scanText');
  for (const call of calls.slice(0, 3)) assert.equal(call.details === false, false, '预算未满时仍要明细');
  for (const call of calls.slice(3)) assert.equal(call.details, false, '预算用尽后只计数');
  assert.deepEqual(calls.map((call) => call.maxIssues), [500, 500, 500, 500, 500, 500], '单章 maxIssues 口径不变');

  const reference = await referenceBookSensitive(bookPath, {});
  assert.deepEqual(result.matches, reference.matches, '前 1500 条明细逐字段一致');
  assert.deepEqual(result.chapters, reference.chapters, '逐章统计一致');
  assert.deepEqual(result.byWord, reference.byWord, '逐词汇总一致');
  assert.equal(result.total, reference.total);
  assert.equal(result.wordHitCount, reference.wordHitCount);
  assert.equal(result.chapterHitCount, reference.chapterHitCount);
  assert.equal(result.skippedChapters, 0);
  assert.equal(result.truncated, reference.truncated);
});

test('R3/B5：整本校对预算用尽后单章 maxIssues 降到下限 —— 回包与逐章全量参考实现逐项一致', async () => {
  const dir = await mkTmp();
  // 每章 600 处半角逗号（约 3000 字），6 章 → 1500 条整本预算在第 4 章用尽。
  const chapters = Array.from({ length: 6 }, () => '他说,好。'.repeat(600));
  const bookPath = await makeBook(dir, '整本 校对书', chapters);
  const config = {};

  const calls = [];
  const wrapped = {
    ...proofreadLib,
    proofreadText: (text, options, entries) => {
      calls.push({ ...(options || {}) });
      return proofreadLib.proofreadText(text, options, entries);
    }
  };
  const channels = makeHost({ config, proofreadModule: wrapped });
  const result = await channels.get('book:proofread')(bookPath, {}, null);

  assert.equal(calls.length, 6);
  assert.deepEqual(calls.map((call) => call.maxIssues), [400, 400, 400, 400, 20, 20], '预算用尽后降到下限 20');
  assert.deepEqual(
    calls.map((call) => call.snippets === false),
    [false, false, false, false, true, true],
    '预算用尽后与既有 snippets:false 同处生效'
  );
  assert.equal(calls[4].maxIssues, proofreadLib.OPTION_LIMITS.maxIssues[0], '下限取核心的唯一事实源');

  const reference = await referenceBookProofread(bookPath, {});
  assert.equal(result.total, reference.total);
  assert.deepEqual(result.byRule, reference.byRule);
  assert.deepEqual(result.issues, reference.issues, '回包明细逐字段一致');
  assert.deepEqual(result.chapters, reference.chapters, '逐章统计一致');
  assert.equal(result.chapterCount, reference.chapterCount);
  assert.equal(result.chapterHitCount, reference.chapterHitCount);
  assert.equal(result.truncated, reference.truncated);
  assert.equal(result.tooLarge, reference.tooLarge);
  assert.equal(result.issues.length, 1500);
});

// ---------------------------------------------------------------- B6

test('R4/B6：⑦⑧⑨ 命中先问额度 —— 计数照旧准确，不再物化三个命中桶（静态闸 + 行为对拍）', () => {
  const source = read('core/proofread.js');
  const start = source.indexOf("if (rules.ellipsis || rules.dash || rules['fullwidth-digit'])");
  const end = source.indexOf('// ⑩ 自定义校对词表');
  assert.ok(start > 0 && end > start, '找不到 ⑦⑧⑨ 合并扫描块');
  const region = source.slice(start, end);
  assert.equal(/const hits\s*=/.test(region), false, '不许再建 { ellipsis, dash, fullwidth-digit } 三个桶');
  assert.equal(region.includes('hits.ellipsis.push'), false);
  assert.equal(region.includes('hits.dash.push'), false);
  assert.equal(region.includes("hits['fullwidth-digit'].push"), false);
  for (const rule of ['ellipsis', 'dash', 'fullwidth-digit']) {
    assert.ok(region.includes(`collector.wants('${rule}')`), `${rule} 命中前必须问额度`);
    assert.ok(region.includes(`collector.countOnly('${rule}')`), `${rule} 满了只计数`);
  }

  // 病态输入：50 万全角数字命中，明细只留 maxIssues，但 total / byRule 一条不许少。
  const pathological = proofreadLib.proofreadText('１a'.repeat(300000), {
    rules: { ...RULES_OFF, 'fullwidth-digit': true }
  });
  assert.equal(pathological.byRule['fullwidth-digit'], 300000);
  assert.equal(pathological.total, 300000);
  assert.equal(pathological.issues.length, 400);
  assert.equal(pathological.issues[0].index, 0);
  assert.equal(pathological.issues[0].match, '１');
  assert.equal(pathological.issues[0].suggestion, '1');
  assert.equal(pathological.issues[pathological.issues.length - 1].index, 2 * (400 - 1));

  // 三条规则混排：全量对拍（maxIssues 拉高 → 一条不丢）逐字段一致。
  const mixed = '甲。。。乙--丙１。'.repeat(50) + '他喊...然后——走了--不、２０２４年。';
  const each = [];
  for (const rule of ['ellipsis', 'dash', 'fullwidth-digit']) {
    each.push(...issuesOfRule(mixed, rule, { maxIssues: 5000 }).issues);
  }
  each.sort((a, b) => a.index - b.index || proofreadLib.RULE_ORDER.indexOf(a.rule) - proofreadLib.RULE_ORDER.indexOf(b.rule));
  const all = proofreadLib.proofreadText(mixed, {
    maxIssues: 5000,
    rules: { ...RULES_OFF, ellipsis: true, dash: true, 'fullwidth-digit': true }
  });
  assert.deepEqual(
    all.issues.map((issue) => [issue.rule, issue.index, issue.length, issue.match, issue.message, issue.suggestion]),
    each.map((issue) => [issue.rule, issue.index, issue.length, issue.match, issue.message, issue.suggestion]),
    '三条规则合扫的命中 / 位置 / 文案逐条一致'
  );

  // 截断口径：maxIssues 20 时总数照实、明细按规则配额保留（每条规则先各拿 floor(20/3)=6，余 2 给前两条）。
  const lean = proofreadLib.proofreadText(mixed, {
    maxIssues: 20,
    rules: { ...RULES_OFF, ellipsis: true, dash: true, 'fullwidth-digit': true }
  });
  assert.equal(lean.total, all.total);
  assert.deepEqual(lean.byRule, all.byRule);
  const quota = { ellipsis: 7, dash: 7, 'fullwidth-digit': 6 };
  const takenByRule = new Map();
  const expected = each
    .filter((issue) => {
      const taken = takenByRule.get(issue.rule) || 0;
      takenByRule.set(issue.rule, taken + 1);
      return taken < quota[issue.rule];
    })
    .map((issue) => [issue.rule, issue.index]);
  assert.deepEqual(lean.issues.map((issue) => [issue.rule, issue.index]), expected, '保留下来的明细与改前同集');
});

// ---------------------------------------------------------------- B7

test('R5/B7：convertPunct reportOnly 只报告不产正文 —— 回调序列 / 计数与默认分支逐条一致', () => {
  const text = '他说,好。中文:测试!；扩展𠮷,字。英文 A, B.省略号...连排.......';
  const reports = [];
  const normal = formatLib.convertPunct(text, (index, from, to) => reports.push([index, from, to]));
  assert.equal(typeof normal.text, 'string');
  assert.ok(normal.count > 0);
  assert.equal(normal.reportOnly, undefined, '默认分支返回形状不变');

  const leanReports = [];
  const lean = formatLib.convertPunct(text, (index, from, to) => leanReports.push([index, from, to]), { reportOnly: true });
  assert.equal(lean.text, null, 'reportOnly 不产整段副本');
  assert.equal(lean.reportOnly, true);
  assert.equal(lean.count, normal.count);
  assert.deepEqual(leanReports, reports, '回调序列逐条一致');

  // 默认分支逐字节不变：带回调与不带回调的 text 相同。
  assert.equal(formatLib.convertPunct(text).text, normal.text);
  assert.equal(formatLib.convertPunct('他说：“你好”.').text, '他说：“你好”。');

  // 极值：100 万单段，reportOnly 的计数 / 位置与默认分支一致（不产 3MB 副本）。
  const heavy = '他说,好。中文:测试!'.repeat(60000);
  const heavyLean = formatLib.convertPunct(heavy, () => {}, { reportOnly: true });
  const heavyFull = formatLib.convertPunct(heavy, () => {});
  assert.equal(heavyLean.count, heavyFull.count);
  assert.equal(heavyLean.text, null);
});

test('R6/B7 接线：校对规则①走 convertPunct 报告-only（它本来就丢弃返回正文）', () => {
  const source = read('core/proofread.js');
  const start = source.indexOf('// ① 半角标点');
  const end = source.indexOf('// ② 超长段落');
  assert.ok(start > 0 && end > start, '找不到规则① 代码块');
  const region = source.slice(start, end);
  assert.ok(region.includes('formatLib.convertPunct(paragraph.text,'), '规则①仍复用同一个判定函数');
  assert.ok(region.includes('{ reportOnly: true }'), '规则①必须传 reportOnly:true（不许再白建整段副本）');
});

// ---------------------------------------------------------------- B8

test('R7/B8：repeatWordIssues 两遍法（先计数、再只为候选词收集起点）且判定结果不变', () => {
  const source = read('core/proofread.js');
  const body = sliceFunction(source, 'function repeatWordIssues');
  assert.ok(body.includes('const counts = new Map()'), '第一遍只计数');
  assert.ok(body.includes('counts.set('), '第一遍按双字词累计出现次数');
  assert.ok(body.includes('candidates.has(wordKey)'), '第二遍只处理候选词（数值键，不拼字符串）');
  assert.ok(body.includes('counts.clear()'), '第一遍的计数表在第二遍前释放');
  assert.ok(body.includes('positions.set(word, [prevCp])'), '既有 #54 静态口径仍成立（候选词位置按码点序号）');
  assert.equal(/const chars = \[\]/.test(body), false, '#54：不许回流 chars 数组');
  assert.equal(/const starts = \[\]/.test(body), false, '#54：不许回流 starts 数组');
  assert.ok(body.indexOf('counts.clear()') < body.indexOf('const positions = new Map()'), '先释放计数表再进第二遍');

  const cases = [
    { text: '哈哈哈哈。。。他说他说他说他说', options: {} },
    { text: '𠮷𠮷𠮷𠮷𠮷𠮷𠮷𠮷', options: {} },
    { text: '我们我们我们我们。他们他们他们他们。', options: {} },
    { text: '他突然想起突然想起突然想起。', options: {} },
    { text: '天地玄黄宇宙洪荒。'.repeat(300), options: {} },
    { text: '𠮷汉𠮷汉𠮷汉𠮷汉𠮷汉', options: {} },
    { text: 'abc abc abc 中中中中中中', options: {} },
    { text: '重复重复重复重复重复重复重复重复', options: { repeatCount: 2, repeatWindow: 20 } },
    { text: '风风风风风风风风风风风风风风风风风风风风风风', options: { repeatCount: 20, repeatWindow: 5000 } },
    { text: '一句普通的话。'.repeat(50), options: { repeatCount: 20, repeatWindow: 20 } }
  ];
  for (const item of cases) {
    const options = {
      repeatCount: proofreadLib.sanitizeOptions(item.options).repeatCount,
      repeatWindow: proofreadLib.sanitizeOptions(item.options).repeatWindow
    };
    const expected = referenceRepeatWordIssues(item.text, options).map((hit) => [hit.start, hit.word.length, hit.word, hit.count, options.repeatWindow]);
    const actual = issuesOfRule(item.text, 'repeat-word', { ...item.options, snippets: false }).issues.map((issue) => [
      issue.index,
      issue.length,
      issue.match,
      issue.count,
      issue.window
    ]);
    assert.deepEqual(actual, expected, `差分不一致：${JSON.stringify(item.text.slice(0, 20))} ${JSON.stringify(item.options)}`);
  }
});

test('R8/IO：整本预算降档在缺章 / 读失败 / 恰好 1500 边界下的行为', async () => {
  const dir = await mkTmp();
  // ① 恰好 1500 边界：4 章 × 500 命中 = 2000 → 前 3 章正好 1500，第 4 章起只计数。
  const boundaryBook = await makeBook(dir, '边界 敏感书', Array.from({ length: 4 }, () => '色情'.repeat(500)));
  const wordsPath = path.join(dir, '敏感词.txt');
  await fs.writeFile(wordsPath, '色情\n', 'utf8');
  const calls = [];
  const wrappedSensitive = {
    ...sensitiveLib,
    scanText: (text, words, options) => {
      calls.push({ ...(options || {}) });
      return sensitiveLib.scanText(text, words, options);
    }
  };
  const channels = makeHost({
    config: { sensitiveWordsPath: wordsPath },
    sensitiveModule: wrappedSensitive
  });
  const boundary = await channels.get('book:sensitive-check')(boundaryBook, {}, null);
  assert.equal(boundary.total, 2000);
  assert.equal(boundary.matches.length, 1500, '第 3 章末条恰好填满 1500');
  assert.equal(boundary.chapters.length, 4);
  assert.deepEqual(calls.map((call) => call.details === false), [false, false, false, true], '第 4 章起 details:false');

  // ② 缺章：删掉一本书的第 6 章文件 → skippedChapters 计数、总数只少该章、预算降档不受影响。
  const proofBook = await makeBook(dir, '缺章 校对书', Array.from({ length: 6 }, () => '他说,好。'.repeat(600)));
  const proofCalls = [];
  const wrappedProofread = {
    ...proofreadLib,
    proofreadText: (text, options, entries) => {
      proofCalls.push({ ...(options || {}) });
      return proofreadLib.proofreadText(text, options, entries);
    }
  };
  const proofChannels = makeHost({ config: {}, proofreadModule: wrappedProofread });
  const handler = proofChannels.get('book:proofread');
  const before = await handler(proofBook, {}, null);
  const meta = await storage.readBookMeta(proofBook);
  const victim = meta.chapters[5];
  const victimText = (await storage.loadChapterText(proofBook, victim.file)).text;
  const victimOnly = proofreadLib.proofreadText(victimText, {}).total;
  await fs.unlink(path.join(proofBook, victim.file));
  proofCalls.length = 0;
  const after = await handler(proofBook, {}, null);
  assert.equal(after.skippedChapters, 1, '缺章跳过并计数');
  assert.equal(after.total, before.total - victimOnly, '总数只少缺掉的那一章');
  assert.equal(after.chapterHitCount, before.chapterHitCount - 1);
  assert.deepEqual(after.issues, before.issues, '缺章在预算之后，明细不受影响');
  assert.equal(proofCalls.filter((call) => call.maxIssues === 20).length, 1, '预算降档仍生效（剩下的最后 1 章）');

  // ③ 读失败（把一章文件换成同名目录，等价 EPERM / EISDIR）：整本直接 reject，不返回半份统计。
  const brokenFile = path.join(proofBook, meta.chapters[1].file);
  await fs.rm(brokenFile);
  await fs.mkdir(brokenFile);
  await assert.rejects(
    () => handler(proofBook, {}, null),
    (err) => {
      assert.ok(err && err.code, '读失败要带错误码');
      assert.match(err.code, /^(EISDIR|EPERM|EACCES|CHAPTER_)/);
      return true;
    },
    '章节读失败 → 整本检查失败，不产出半份统计'
  );
});

// ---------------------------------------------------------------- 契约 / 既有口径

test('R9：两个整本 handler 的回包字段集合不变（不把 details 等内部开关泄漏给渲染层）', async () => {
  const dir = await mkTmp();
  const bookPath = await makeBook(dir, '契约书', ['色情正文', '他说,好。']);
  const wordsPath = path.join(dir, '敏感词.txt');
  await fs.writeFile(wordsPath, '色情\n', 'utf8');
  const channels = makeHost({ config: { sensitiveWordsPath: wordsPath } });
  const proof = await channels.get('book:proofread')(bookPath, {}, null);
  const sensitive = await channels.get('book:sensitive-check')(bookPath, {}, null);
  assert.deepEqual(Object.keys(proof).sort(), [
    'byRule',
    'chapterCount',
    'chapterHitCount',
    'chapters',
    'customWordCount',
    'issues',
    'options',
    'scope',
    'skippedChapters',
    'tooLarge',
    'total',
    'truncated',
    'wordList'
  ]);
  assert.deepEqual(Object.keys(proof.options).sort(), ['longParagraph', 'maxIssues', 'repeatCount', 'repeatWindow']);
  assert.deepEqual(Object.keys(sensitive).sort(), [
    'byWord',
    'chapterCount',
    'chapterHitCount',
    'chapters',
    'matches',
    'ok',
    'options',
    'scope',
    'skippedChapters',
    'total',
    'truncated',
    'wordCount',
    'wordHitCount',
    'wordList'
  ]);
  assert.deepEqual(Object.keys(sensitive.options).sort(), ['maxIssues']);
});

test('R10：既有 #54 / P-08 静态口径不回退（两处源码闸门同时钉住）', () => {
  const proofSource = read('core/proofread.js');
  const repeatBody = sliceFunction(proofSource, 'function repeatWordIssues');
  assert.ok(repeatBody.includes('positions.set(word, [prevCp])'), '#54：二字词位置直接记码点序号');
  assert.equal(/const chars = \[\]/.test(repeatBody), false);
  assert.equal(/const starts = \[\]/.test(repeatBody), false);

  const ipcSource = read('ipc/proofread.js');
  const start = ipcSource.indexOf("handleBook('book:proofread'");
  const end = ipcSource.indexOf("handleBook('book:sensitive-check'");
  assert.ok(start > 0 && end > start);
  const region = ipcSource.slice(start, end);
  assert.match(region, /issues\.length >= BOOK_ISSUE_LIMIT/, 'P-08：整本仍按 1500 条明细预算收口');
  assert.match(region, /snippets: false/, 'P-08：预算用完后仍传 snippets:false');
  assert.match(region, /snippetsWanted/, 'P-08：跨章状态仍在');
});