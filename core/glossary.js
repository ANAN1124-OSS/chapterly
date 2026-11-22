// 校对词表（自定义错别字 / 禁用词）——纯逻辑 + 词表读取，不依赖 Electron，可单测。
//
// 1.7.2 D2：多份词表的配置口径 / 公开信息 / enabledLists 子集过滤也收在这里（V60/V63），
// 读取最多 3 份并发（V47）；读取出口的词条已清洗，调用方（proofreadText）不再洗第二遍（V44）。
//
// 设计（提案 N6，参考墨者 / 番茄的「自定义词表」；复用敏感词预检的读取与提示思路）：
//   · 词表完全归作者：应用**不内置任何词表**，只按作者在设置里选的 txt 做字面匹配
//   · 每行一个词；也可以写「错词 → 建议」，箭头认 => / -> / → 三种（建议只用于显示，
//     应用绝不替作者改字）；没有建议就是纯禁用词
//   · # 开头的行是注释（方便分组 / 写说明）；空行忽略；同一个词重复出现只算第一次
//   · 只报告命中位置与建议，绝不改正文、绝不写盘；词表本身只读、不复制、不改写
//   · 单行超过 100 字 / 词表超过 4MB / 超过 5000 个词都明确告知（跳过或截断）
//   · 字面匹配、区分大小写（不做正则、不做大小写折叠，避免作者以为「没命中」）
//
// 定位约定：index / length 都是「把 CRLF 归一成 \n、去掉 BOM」之后的字符位置，
// 与编辑区 textarea 的 value 一致，因此可以直接 setSelectionRange。
//
// A1（v1.8.0 WP-30）：词表读取 / 解码 / 公开信息这一段与敏感词预检共用 core/wordlist.js，
// 本文件只留「错词 → 建议」的行解析与本模块的错误码文案。
const path = require('node:path');
const wordlist = require('./wordlist');
const wordscan = require('./wordscan');
const { normalizeText, mapLimit } = require('./common');
// 多份校对词表的条数上限与配置清洗同一份定义（1.7.2 D4/V42 已收口到 core/config.js）；
// 读取侧再兜一遍，手改配置 / 旧数据绕过清洗时也不会读出第 9 份。
const { WORDLIST_MAX } = require('./config');

// 词表文件上限：再大就不像「每行一个词」的词表了，读进来只会拖慢整本检查
// （唯一实现在 core/wordlist.js，敏感词表同一份）
const MAX_FILE_BYTES = wordlist.MAX_FILE_BYTES;
// 最多取前 5000 个词；超出部分不读，但会明确告诉作者（truncated）
const MAX_ENTRIES = 5000;
// 单行超过 100 字基本是误粘进来的正文，跳过并统计，不参与匹配
const MAX_TERM_LENGTH = 100;
// 建议文字同样限长（只用于显示，长到离谱的建议没有意义）
const MAX_SUGGESTION_LENGTH = 100;
// 单次扫描最多收集多少条原始命中（防止词表里混进「的」这类超高频字把内存打爆）
const RAW_MATCH_LIMIT = 100000;
// 建议箭头的写法（顺序无所谓，取最先出现的那个）
const ARROWS = ['=>', '->', '→'];

// normalizeText 从 core/common.js 来（B6）：和 storage.loadChapterText / 编辑区同一份口径
// （去掉开头 BOM、CRLF 归一成 LF），这里只保留对外导出。

// 一行 → { term, suggestion }：取最先出现的箭头切开；没有箭头就是纯词
function splitLine(line) {
  let cut = -1;
  let arrow = '';
  for (const token of ARROWS) {
    const at = line.indexOf(token);
    if (at >= 0 && (cut < 0 || at < cut)) {
      cut = at;
      arrow = token;
    }
  }
  if (cut < 0) return { term: line.trim(), suggestion: '' };
  return {
    term: line.slice(0, cut).trim(),
    suggestion: line.slice(cut + arrow.length).trim()
  };
}

// 词表文本 → { entries, stats }。只做「每行一个词 / 可选建议」这一件事：
// 空行与注释忽略、重复只留一次、超长行跳过；超过 MAX_ENTRIES 后不再读（truncated）。
function parseGlossary(text) {
  const source = normalizeText(text);
  const lines = source.split('\n');
  const entries = [];
  const seen = new Set();
  const stats = {
    lines: lines.length,
    emptyLines: 0,
    comments: 0,
    duplicates: 0,
    invalid: 0,
    tooLong: 0,
    suggestions: 0,
    truncated: false
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      stats.emptyLines += 1;
      continue;
    }
    if (line.startsWith('#')) {
      stats.comments += 1;
      continue;
    }
    const parsed = splitLine(line);
    if (!parsed.term) {
      stats.invalid += 1;
      continue;
    }
    if (parsed.term.length > MAX_TERM_LENGTH || parsed.suggestion.length > MAX_SUGGESTION_LENGTH) {
      stats.tooLong += 1;
      continue;
    }
    if (seen.has(parsed.term)) {
      stats.duplicates += 1;
      continue;
    }
    if (entries.length >= MAX_ENTRIES) {
      stats.truncated = true;
      break;
    }
    seen.add(parsed.term);
    entries.push({ term: parsed.term, suggestion: parsed.suggestion });
    if (parsed.suggestion) stats.suggestions += 1;
  }
  return { entries, stats };
}

// 渲染层 / 旧调用方传进来的词数组也兜底：清洗词、建议、去重、限长与数量。
// 除了 { term, suggestion } 对象，也接受纯字符串（等价于没有建议）。
function sanitizeEntries(raw) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    let term = '';
    let suggestion = '';
    if (typeof item === 'string') {
      term = item.trim();
    } else if (item && typeof item === 'object') {
      term = typeof item.term === 'string' ? item.term.trim() : '';
      suggestion = typeof item.suggestion === 'string' ? item.suggestion.trim() : '';
    }
    if (!term || term.length > MAX_TERM_LENGTH || seen.has(term)) continue;
    // WP14 C8（审计低批）：与文件入口 parseGlossary 同一口径 —— 建议超过 100 字属于
    // 「单行超过 100 字」，整条跳过（旧实现留词、把建议置空，导致同一条词在两条入口下
    // 校对覆盖不同）。这里不留半个词条，避免两套语义继续漂移。
    if (suggestion.length > MAX_SUGGESTION_LENGTH) continue;
    seen.add(term);
    out.push({ term, suggestion });
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

// 词表读取 / 解码 / 公开信息的流程在 core/wordlist.js（A1 / WP-30）：本模块只声明
// 「词条」这个字段、自己的错误码与提示文案，行解析仍是上面的 parseGlossary。
// 编码复用 txt.decodeBuffer（UTF-8 / UTF-16 BOM / GB18030），并额外识别两种「不是纯文本」：
// 带 NUL 的二进制、解码出替换字符 U+FFFD 的坏编码 —— 这些判定也只在共享核心里写一遍。
// 错误码 → 文案：**同一个错误码只维护一处**（CIO-B02）。
// 单份词表（READER.messages）与多份词表（glossaryErrorText）都从这里取，改文案只改这里；
// 出口措辞确实需要不同的（同一个码在不同上下文里说的不是同一件事）在下面用注释写明理由，
// 不靠各写一份碰运气保持一致。
const CODE_TEXT = {
  GLOSSARY_EMPTY: '词表里没有有效的词（每行一个词，空行和 # 注释会被忽略）',
  GLOSSARY_TOO_BIG: '词表文件太大（上限 4MB），请换一个小一点的 txt',
  GLOSSARY_BAD_ENCODING: '词表编码无法识别（不是 UTF-8 / UTF-16 / GBK 文本），请另存为 UTF-8 的 txt',
  GLOSSARY_NOT_FILE: '选中的不是一个文件，请选校对词表 txt',
  GLOSSARY_PARSE_FAILED: '词表内容解析失败（文件可能不是「每行一个词」的纯文本），请检查后重试',
  GLOSSARY_MISSING: '词表文件不存在（可能被移动或删除了，请重新选择）'
};

const READER = wordlist.createReader({
  field: 'entries',
  parse: parseGlossary,
  // 校对词表的「未配置」回包一直带 count: 0（敏感词表不带），保持旧形状
  notConfiguredExtra: { count: 0 },
  codes: {
    empty: 'GLOSSARY_EMPTY',
    tooBig: 'GLOSSARY_TOO_BIG',
    badEncoding: 'GLOSSARY_BAD_ENCODING',
    notConfigured: 'GLOSSARY_NOT_CONFIGURED',
    missing: 'GLOSSARY_MISSING',
    unreadable: 'GLOSSARY_UNREADABLE',
    notFile: 'GLOSSARY_NOT_FILE',
    // E13（审计修复 #16）：decode / parse 抛错时的独立错误码（共享核心的兜底用）
    parseFailed: 'GLOSSARY_PARSE_FAILED'
  },
  messages: {
    // 空文件与「文件里有内容但没有有效词」是两件事，措辞本来就不同（入口差异，不是漂移）
    emptyFile: '词表是空文件（每行一个词，可写「错词 → 建议」）',
    emptyList: CODE_TEXT.GLOSSARY_EMPTY,
    tooBig: CODE_TEXT.GLOSSARY_TOO_BIG,
    // 审计修复 #49（E24）：含 NUL 不一定是二进制 —— 无 BOM 的 UTF-16 也长这样，提示不要误导。
    binary: '词表不像是纯文本（检测到 NUL 空字节，可能是无 BOM 的 UTF-16，也可能是二进制文件），请用 UTF-8 / UTF-16（带 BOM）/ GBK 编码的 txt',
    badEncoding: CODE_TEXT.GLOSSARY_BAD_ENCODING,
    // 整份配置级的提示（多份词表里单份的提示见 glossaryErrorText，措辞更短）
    notConfigured: '还没有指定校对词表（应用不内置词表；没有词表时只跑内置的九条规则）',
    publicEmpty: '还没有指定校对词表',
    notFile: CODE_TEXT.GLOSSARY_NOT_FILE,
    parseFailed: CODE_TEXT.GLOSSARY_PARSE_FAILED
  }
});

// 词表字节 → { ok, entries, stats } 或 { ok:false, code, message }
function decodeGlossaryBuffer(buffer) {
  return READER.decodeBuffer(buffer);
}

// 读词表文件（只读）。任何失败都返回结构化结果，由界面给出明确提示，不抛异常。
async function readGlossaryFile(filePath) {
  return READER.readFile(filePath);
}

// 多份词表（1.7.0 F3b）：每份自己的失败原因 → 不含路径的短提示。
// 渲染层只需要「这一份能不能用 / 为什么不能用」；路径留在主进程，不出主进程。
// 文案与单份词表共用 CODE_TEXT（CIO-B02），只有「单份 vs 整配置」这种上下文差异才单独写。
function glossaryErrorText(code) {
  if (code === 'GLOSSARY_NOT_CONFIGURED') return '这一份还没有指定词表'; // 入口差异：整配置级提示见 READER.messages.notConfigured
  return CODE_TEXT[code] || '读不了这份词表';
}

// 顺序读多份词表并合并（1.7.0 F3b）：配置里排在前面的先到先得。
//   · entries 按 term 去重：同一个词只算第一次出现的那份（建议也先到先得）
//   · 合并总数封顶 MAX_ENTRIES，截断语义与单文件一致（多出来的部分标 truncated）
//   · 每份单独判错：一份坏 / 不存在不影响其它份；全部不可用时 ok=false，绝不抛错
//   · lists 只给 { ok, count, error, truncated }，不带路径；公开信息另有一层（见下）
//   · 每份还带内部 entries（1.7.2 D2/V46）：只给 core 自己做「勾选子集在内存里重合并」，
//     publicGlossaryFilesInfo 会把它剥掉，绝不带出主进程
//   · 1.7.2 D2/V47：最多 3 份同时读（core/common.js 的 mapLimit 保序），合并仍按原顺序
const READ_CONCURRENCY = 3;

// 把每份自己的 entries 按原顺序合并（term 去重 / 总数封顶）——**全仓唯一一份合并算法**：
// readGlossaryFiles（整表）与「enabledLists 子集过滤」都调这里，合并语义只许改这一处。
// indexes 为 null 表示全取；传入 Set 时只合并选中的那几份。
// 返回：entries（合并后的词条，先到先得）/ truncated（有词没进来）/ listTruncated（与 lists 等长：
// 第 i 份有「新词因总数封顶没进来」；子集合并只关心整体 truncated，不用这个字段）。
function mergeListEntries(lists, indexes) {
  const entries = [];
  const seen = new Set();
  const picked = Array.isArray(lists) ? lists : [];
  const listTruncated = new Array(picked.length).fill(false);
  let truncated = false;
  let capped = false;
  for (let index = 0; index < picked.length; index += 1) {
    if (indexes && !indexes.has(index)) continue;
    const list = picked[index];
    // 审计修复 #49（E24）：子集合并要把「这份文件自己读时被截断」与「合并时撞到 5000 上限」
    // 分开结算，未勾选的份把额度占掉不代表选中的这份不完整。
    const ownTruncated = Boolean(list && list.ownTruncated === true);
    if (ownTruncated) truncated = true;
    const own = list && Array.isArray(list.entries) ? list.entries : [];
    // 撞顶后不再合并，但仍要如实标出「这份还有新词没进来」（每份 truncated 的旧口径）。
    if (capped) {
      if (own.some((entry) => !seen.has(entry.term))) {
        truncated = true;
        listTruncated[index] = true;
      }
      continue;
    }
    for (const entry of own) {
      // 和单文件 parseGlossary 同一顺序：先去重，再看总数上限
      if (seen.has(entry.term)) continue;
      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        listTruncated[index] = true;
        capped = true;
        break;
      }
      seen.add(entry.term);
      entries.push({ term: entry.term, suggestion: entry.suggestion });
    }
  }
  return { entries, truncated, listTruncated };
}

async function readGlossaryFiles(paths) {
  let requested = [];
  if (Array.isArray(paths)) requested = paths;
  else if (typeof paths === 'string' && paths.trim()) requested = [paths];
  const read = await mapLimit(requested, READ_CONCURRENCY, (request) => readGlossaryFile(request));
  const lists = [];
  let anyOk = false;
  for (const one of read) {
    const own = one.ok && Array.isArray(one.entries) ? one.entries : [];
    // ownTruncated 是「这一份文件自己」的截断；truncated 还会在总数上限处被合并逻辑标真。
    // 子集合并要区分这两件事（unselected 的份把额度占掉，不代表选中的这份不完整）。
    const ownTruncated = Boolean(one.ok && one.stats && one.stats.truncated);
    lists.push({
      ok: one.ok === true,
      count: own.length,
      error: one.ok === true ? '' : glossaryErrorText(one.code),
      truncated: ownTruncated,
      ownTruncated,
      entries: own
    });
    if (one.ok === true) anyOk = true;
  }
  // 合并只走 mergeListEntries 这一份实现；每份的 truncated 由它回填（含撞顶后的份）。
  const merged = mergeListEntries(lists, null);
  for (let index = 0; index < lists.length; index += 1) {
    if (merged.listTruncated[index]) lists[index].truncated = true;
  }
  return { ok: anyOk, entries: merged.entries, lists, total: merged.entries.length };
}

// 只给渲染层的词表信息：绝不把词表正文（entries）带过去，界面只需要数量与状态。
// 命中结果里仍会带命中词与建议（那是作者要看的），和整个词表不是一回事。
function publicGlossaryInfo(list) {
  return READER.publicInfo(list);
}

// 多份词表的公开信息（1.7.0 F3b）：只给数量 / 状态，绝不带路径与词条正文。
// lists 与 readGlossaryFiles 一一对应、顺序不变；界面按 index 对齐配置里的路径。
function publicGlossaryFilesInfo(bundle) {
  if (!bundle || typeof bundle !== 'object' || !Array.isArray(bundle.lists)) {
    return { ok: false, configured: false, code: 'GLOSSARY_NOT_CONFIGURED', total: 0, lists: [] };
  }
  const lists = bundle.lists.map((item) => ({
    ok: Boolean(item && item.ok === true),
    count: item && Number.isFinite(item.count) ? item.count : 0,
    error: item && typeof item.error === 'string' ? item.error : '',
    truncated: Boolean(item && item.truncated)
  }));
  let total = 0;
  if (Array.isArray(bundle.entries)) total = bundle.entries.length;
  else if (Number.isFinite(bundle.total)) total = bundle.total;
  const info = { ok: bundle.ok === true, configured: lists.length > 0, total, lists };
  if (!info.ok) info.code = lists.length > 0 ? 'GLOSSARY_NO_USABLE_LIST' : 'GLOSSARY_NOT_CONFIGURED';
  return info;
}

// ---------- 1.7.2 D2（V60/V63）：校对词表的纯逻辑（原来困在 main.js 的 registerIpc() 里）----------
// 这些原本是 main.js 的五个 helper，搬到这里是为了能直接单测；main.js 只保留 handle(...) 里的一行调用。
// 行为与搬前逐字一致：多份为空回落单份、公开信息永远描述全部词表、enabledLists 只影响参与校对。

// 配置 → 实际参与读取的词表路径：proofreadWordlists 非空取数组，否则回落旧的单份字段。
// 多份里只留非空字符串（空串 / 非字符串不算一份）；一份可用的都没有时回落单份旧字段。
// 读取侧再兜一遍 WORDLIST_MAX（配置清洗已限，这里防手改配置 / 旧数据绕过）。
function proofreadWordlistPaths(config) {
  const many =
    config && Array.isArray(config.proofreadWordlists) && config.proofreadWordlists.length
      ? config.proofreadWordlists
      : [];
  const usable = many.filter((item) => typeof item === 'string' && item.trim());
  if (usable.length) return usable.slice(0, WORDLIST_MAX);
  const single = config && typeof config.proofreadWordsPath === 'string' ? config.proofreadWordsPath.trim() : '';
  return single ? [single] : [];
}

// 1.7.0 F3b2 收口：单份路径（没配多份列表）走原样的单表读取与公开信息——老配置的显示与校对结果一字不差；
// 只有 proofreadWordlists 非空才走多表合并。多表是新增能力，不改变旧字段的任何语义。
function hasProofreadWordlists(config) {
  return Boolean(config && Array.isArray(config.proofreadWordlists) && config.proofreadWordlists.length);
}

// options.enabledLists（1.7.0 F3b2）：索引数组，只让勾选的那几份词表参与这一次校对。
// 缺省 / 坏值 / 一份都没勾 = 全开——宁可多跑几份，也不静默关掉作者以为在用的词表。
// 返回 Set（选中的索引）或 null（= 全开）；越界 / 重复 / 非整数索引都丢掉（1.7.2 D2/V46 内存过滤要用索引）。
function wordlistIndexesForRequest(paths, options) {
  const enabled = options && Array.isArray(options.enabledLists) ? options.enabledLists : null;
  if (!enabled) return null;
  const picked = new Set();
  for (const item of enabled) {
    // 审计修复 #12（E8）：判型先要求 typeof number —— Number(null / '' / false / []) 都是 0，
    // 会把坏值当成「勾了第 0 份」，与上面「坏值 = 全开」的约定正好相反（本该全开，却悄悄只剩第一份）。
    // 只认真正的整数下标；字符串 '0' 之类也当坏值丢掉（宁可多跑几份，不猜调用方的意图）。
    if (typeof item === 'number' && Number.isInteger(item) && item >= 0 && item < paths.length) picked.add(item);
  }
  return picked.size ? picked : null;
}

// 对外形状：选中的路径子集（保持原顺序）。读侧内部用 wordlistIndexesForRequest 做内存过滤。
function wordlistPathsForRequest(paths, options) {
  const picked = wordlistIndexesForRequest(paths, options);
  if (!picked) return paths;
  return paths.filter((item, index) => picked.has(index));
}

// 校对词表信息的唯一出口（words-info / 两处校对共用，1.7.0 F3b2）：
// 多份走 lists + total（lists 按 index 对齐配置里的路径），单份补齐旧字段
// （ok / count / error / truncated / name），两条路都绝不带路径与词条正文。
function proofreadWordListInfo(bundle, paths) {
  const info = publicGlossaryFilesInfo(bundle);
  const payload = { ...info, lists: info.lists, total: info.total, count: info.total };
  payload.name = paths.length === 1 ? path.basename(paths[0]) : paths.length + ' 份词表';
  if (paths.length === 1) {
    const one = (bundle && Array.isArray(bundle.lists) ? bundle.lists[0] : null) || {};
    payload.ok = one.ok === true;
    payload.count = Number.isFinite(one.count) ? one.count : 0;
    payload.error = typeof one.error === 'string' ? one.error : '';
    payload.truncated = Boolean(one.truncated);
    if (!payload.ok) payload.message = payload.error || '校对词表读取失败';
  }
  return payload;
}

// 一次请求要用到的词表：单份旧配置原样单表读取（公开信息保持旧形状，忽略 enabledLists）；
// 多份则一次读完配置里的**全部**词表——公开信息永远描述全部，enabledLists 只在内存里
// 过滤参与校对的词条（V46：不再 readGlossaryFiles(enabledPaths) 读第二遍）。
async function readProofreadWordlistForRequest(config, options) {
  if (!hasProofreadWordlists(config)) {
    const single = config && typeof config.proofreadWordsPath === 'string' ? config.proofreadWordsPath : '';
    const list = await readGlossaryFile(single);
    return { entries: list.ok ? list.entries : [], wordList: publicGlossaryInfo(list) };
  }
  const allPaths = proofreadWordlistPaths(config);
  const all = await readGlossaryFiles(allPaths);
  const wordList = proofreadWordListInfo(all, allPaths);
  const picked = wordlistIndexesForRequest(allPaths, options);
  let entries;
  if (picked) {
    // 审计修复 #49（E24）：子集合并的截断标记按「这次实际参与的份」结算，
    // 不再沿用全部词表的合并结果（未勾选的份把 5000 额度占掉时，不能把选中的词表误标成截断）。
    const merged = mergeListEntries(all.lists, picked);
    entries = merged.entries;
    wordList.truncated = merged.truncated;
  } else {
    // 全部参与时，顶层的 truncated 由任一参与文件被截断决定（多份公开信息以前没有这个字段）。
    wordList.truncated = all.lists.some((list) => list && list.truncated === true);
    entries = all.ok ? all.entries : [];
  }
  return { entries, wordList };
}

// 扫描一段正文：字面量找每个词的全部出现位置，同一处重叠时只留最长的那个
// （和敏感词预检同一套去重规则）。返回 { hits, truncated, entryCount }。
// hits 是 { term, suggestion, index, length }，按位置排序，可直接 setSelectionRange。
// B1（审计 P0-2）：扫描改成 core/wordscan.js 的 Aho-Corasick 单次遍历
// （原来每个词 indexOf 扫一遍正文 = O(词数 × 正文)，5000 词 × 500 万字要 19–20 秒）。
// 去重规则 / RAW_MATCH_LIMIT / 建议箭头 / 位置排序全部由 wordscan 保持，这里只做字段映射。
// options.sanitized === true（1.7.2 D2/V44）：调用方已按同一份 sanitizeEntries 清洗过
// （主进程读取出口），这里跳过再洗一次；公开调用的默认语义不变（不传就是自己清洗）。
function findHits(text, rawEntries, options) {
  const sanitized = Boolean(options && options.sanitized === true);
  const entries = sanitized ? (Array.isArray(rawEntries) ? rawEntries : []) : sanitizeEntries(rawEntries);
  const source = normalizeText(text);
  const scan = wordscan.scanTerms(
    source,
    entries.map((entry) => entry.term),
    { rawMatchLimit: RAW_MATCH_LIMIT }
  );
  return {
    hits: scan.hits.map((hit) => {
      const entry = entries[hit.patternIndex];
      return {
        term: entry.term,
        suggestion: entry.suggestion,
        index: hit.index,
        length: hit.length
      };
    }),
    truncated: scan.truncated,
    entryCount: entries.length
  };
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_ENTRIES,
  parseGlossary,
  sanitizeEntries,
  decodeGlossaryBuffer,
  readGlossaryFile,
  readGlossaryFiles,
  publicGlossaryInfo,
  publicGlossaryFilesInfo,
  proofreadWordlistPaths,
  hasProofreadWordlists,
  wordlistPathsForRequest,
  proofreadWordListInfo,
  readProofreadWordlistForRequest,
  findHits
};
