// 校对词表（自定义错别字 / 禁用词）——纯逻辑 + 词表读取，不依赖 Electron，可单测。
//
// 1.7.2 D2：多份词表的配置口径 / 公开信息 / enabledLists 子集过滤也收在这里（V60/V63）。
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
const fs = require('node:fs/promises');
const path = require('node:path');
const txtLib = require('./txt');
const errorText = require('./error-text');
const wordscan = require('./wordscan');
const { normalizeText } = require('./common');
// 多份校对词表的条数上限与配置清洗同一份定义（1.7.2 D4/V42 已收口到 core/config.js）；
// 读取侧再兜一遍，手改配置 / 旧数据绕过清洗时也不会读出第 9 份。
const { WORDLIST_MAX } = require('./config');

// 词表文件上限：再大就不像「每行一个词」的词表了，读进来只会拖慢整本检查
const MAX_FILE_BYTES = 4 * 1024 * 1024;
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
    if (suggestion.length > MAX_SUGGESTION_LENGTH) suggestion = '';
    seen.add(term);
    out.push({ term, suggestion });
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

// 词表字节 → { ok, entries, stats } 或 { ok:false, code, message }。
// 编码复用 txt.decodeBuffer（UTF-8 / UTF-16 BOM / GB18030），并额外识别两种「不是纯文本」：
// 带 NUL 的二进制、解码出替换字符 U+FFFD 的坏编码。
function decodeGlossaryBuffer(buffer) {
  if (!buffer || !buffer.length) {
    return {
      ok: false,
      code: 'GLOSSARY_EMPTY',
      message: '词表是空文件（每行一个词，可写「错词 → 建议」）'
    };
  }
  if (buffer.length > MAX_FILE_BYTES) {
    return {
      ok: false,
      code: 'GLOSSARY_TOO_BIG',
      message: '词表文件太大（上限 4MB），请换一个小一点的 txt'
    };
  }
  const hasUtf16Bom =
    buffer.length >= 2 &&
    ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff));
  if (!hasUtf16Bom && buffer.includes(0)) {
    return {
      ok: false,
      code: 'GLOSSARY_BAD_ENCODING',
      message: '词表不像是纯文本（检测到二进制内容），请用 UTF-8 / UTF-16 / GBK 编码的 txt'
    };
  }
  const text = txtLib.decodeBuffer(buffer);
  if (text.includes('\uFFFD')) {
    return {
      ok: false,
      code: 'GLOSSARY_BAD_ENCODING',
      message: '词表编码无法识别（不是 UTF-8 / UTF-16 / GBK 文本），请另存为 UTF-8 的 txt'
    };
  }
  const parsed = parseGlossary(text);
  if (!parsed.entries.length) {
    return {
      ok: false,
      code: 'GLOSSARY_EMPTY',
      message: '词表里没有有效的词（每行一个词，空行和 # 注释会被忽略）'
    };
  }
  return { ok: true, entries: parsed.entries, stats: parsed.stats };
}

// 读词表文件（只读）。任何失败都返回结构化结果，由界面给出明确提示，不抛异常。
async function readGlossaryFile(filePath) {
  const rawPath = typeof filePath === 'string' ? filePath.trim() : '';
  if (!rawPath) {
    return {
      ok: false,
      configured: false,
      code: 'GLOSSARY_NOT_CONFIGURED',
      message: '还没有指定校对词表（应用不内置词表；没有词表时只跑内置的五条规则）',
      path: '',
      name: '',
      count: 0
    };
  }
  const resolved = path.resolve(rawPath);
  const base = { configured: true, path: resolved, name: path.basename(resolved) };
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch (err) {
    const missing = err && err.code === 'ENOENT';
    return {
      ...base,
      ok: false,
      code: missing ? 'GLOSSARY_MISSING' : 'GLOSSARY_UNREADABLE',
      message: missing
        ? `词表文件不存在：${errorText.maskPath(resolved)}（可能被移动或删除了，请重新选择）`
        : `读不了词表文件：${errorText.describeForUi(err).message}`
    };
  }
  if (!stat.isFile()) {
    return {
      ...base,
      ok: false,
      code: 'GLOSSARY_NOT_FILE',
      message: '选中的不是一个文件，请选校对词表 txt'
    };
  }
  if (stat.size > MAX_FILE_BYTES) {
    return {
      ...base,
      ok: false,
      size: stat.size,
      code: 'GLOSSARY_TOO_BIG',
      message: '词表文件太大（上限 4MB），请换一个小一点的 txt'
    };
  }
  let buffer;
  try {
    buffer = await fs.readFile(resolved);
  } catch (err) {
    return {
      ...base,
      ok: false,
      code: 'GLOSSARY_UNREADABLE',
      message: `读不了词表文件：${errorText.describeForUi(err).message}`
    };
  }
  const decoded = decodeGlossaryBuffer(buffer);
  if (!decoded.ok) return { ...base, size: stat.size, ...decoded };
  return { ...base, ok: true, size: stat.size, entries: decoded.entries, stats: decoded.stats };
}

// 多份词表（1.7.0 F3b）：每份自己的失败原因 → 不含路径的短提示。
// 渲染层只需要「这一份能不能用 / 为什么不能用」；路径留在主进程，不出主进程。
function glossaryErrorText(code) {
  switch (code) {
    case 'GLOSSARY_NOT_CONFIGURED':
      return '这一份还没有指定词表';
    case 'GLOSSARY_MISSING':
      return '词表文件不存在（可能被移动或删除了，请重新选择）';
    case 'GLOSSARY_NOT_FILE':
      return '选中的不是一个文件，请选校对词表 txt';
    case 'GLOSSARY_TOO_BIG':
      return '词表文件太大（上限 4MB），请换一个小一点的 txt';
    case 'GLOSSARY_BAD_ENCODING':
      return '词表编码认不出来，请存成 UTF-8 或 GBK 的 txt';
    case 'GLOSSARY_EMPTY':
      return '词表里没有有效的词（每行一个词，空行和 # 注释会被忽略）';
    default:
      return '读不了这份词表';
  }
}

// 顺序读多份词表并合并（1.7.0 F3b）：配置里排在前面的先到先得。
//   · entries 按 term 去重：同一个词只算第一次出现的那份（建议也先到先得）
//   · 合并总数封顶 MAX_ENTRIES，截断语义与单文件一致（多出来的部分标 truncated）
//   · 每份单独判错：一份坏 / 不存在不影响其它份；全部不可用时 ok=false，绝不抛错
//   · lists 只给 { ok, count, error, truncated }，不带路径；公开信息另有一层（见下）
async function readGlossaryFiles(paths) {
  let requested = [];
  if (Array.isArray(paths)) requested = paths;
  else if (typeof paths === 'string' && paths.trim()) requested = [paths];
  const entries = [];
  const seen = new Set();
  const lists = [];
  let anyOk = false;
  for (const request of requested) {
    const one = await readGlossaryFile(request);
    const own = one.ok && Array.isArray(one.entries) ? one.entries : [];
    let truncated = Boolean(one.ok && one.stats && one.stats.truncated);
    for (const entry of own) {
      // 和单文件 parseGlossary 同一顺序：先去重，再看总数上限
      if (seen.has(entry.term)) continue;
      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
      seen.add(entry.term);
      entries.push({ term: entry.term, suggestion: entry.suggestion });
    }
    lists.push({
      ok: one.ok === true,
      count: own.length,
      error: one.ok === true ? '' : glossaryErrorText(one.code),
      truncated
    });
    if (one.ok === true) anyOk = true;
  }
  return { ok: anyOk, entries, lists, total: entries.length };
}

// 只给渲染层的词表信息：绝不把词表正文（entries）带过去，界面只需要数量与状态。
// 命中结果里仍会带命中词与建议（那是作者要看的），和整个词表不是一回事。
function publicGlossaryInfo(list) {
  if (!list || typeof list !== 'object') {
    return {
      ok: false,
      configured: false,
      code: 'GLOSSARY_NOT_CONFIGURED',
      message: '还没有指定校对词表',
      path: '',
      name: '',
      count: 0
    };
  }
  const { entries, ...rest } = list;
  return { ...rest, count: Array.isArray(entries) ? entries.length : 0 };
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
    const index = Number(item);
    if (Number.isInteger(index) && index >= 0 && index < paths.length) picked.add(index);
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
// 多份则读出配置里的全部词表，公开信息永远描述全部；enabledLists 只决定哪些份参与校对。
async function readProofreadWordlistForRequest(config, options) {
  if (!hasProofreadWordlists(config)) {
    const single = config && typeof config.proofreadWordsPath === 'string' ? config.proofreadWordsPath : '';
    const list = await readGlossaryFile(single);
    return { entries: list.ok ? list.entries : [], wordList: publicGlossaryInfo(list) };
  }
  const allPaths = proofreadWordlistPaths(config);
  const all = await readGlossaryFiles(allPaths);
  const wordList = proofreadWordListInfo(all, allPaths);
  const enabledPaths = wordlistPathsForRequest(allPaths, options);
  if (enabledPaths.length === allPaths.length) {
    return { entries: all.ok ? all.entries : [], wordList };
  }
  const only = await readGlossaryFiles(enabledPaths);
  return { entries: only.ok ? only.entries : [], wordList };
}

// 扫描一段正文：字面量找每个词的全部出现位置，同一处重叠时只留最长的那个
// （和敏感词预检同一套去重规则）。返回 { hits, truncated, entryCount }。
// hits 是 { term, suggestion, index, length }，按位置排序，可直接 setSelectionRange。
// B1（审计 P0-2）：扫描改成 core/wordscan.js 的 Aho-Corasick 单次遍历
// （原来每个词 indexOf 扫一遍正文 = O(词数 × 正文)，5000 词 × 500 万字要 19–20 秒）。
// 去重规则 / RAW_MATCH_LIMIT / 建议箭头 / 位置排序全部由 wordscan 保持，这里只做字段映射。
function findHits(text, rawEntries) {
  const entries = sanitizeEntries(rawEntries);
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
