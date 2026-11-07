// B1（审计 P0-2 / 终审版 §2.2）：词表扫描单次扫描（Aho-Corasick 自动机）。
//
// 问题：校对（core/glossary.js 的 findHits）与敏感词预检（core/sensitive.js 的 scanText）
// 原来都是「每个词各用 indexOf 把正文扫一遍」= O(词数 × 正文)。实测 70 万字 × 5000 词 ≈ 2.7 秒，
// 500 万字要 19–20 秒，整本检查时主进程会假死（窗口不响应）。两个模块共用这一份实现
// （词表上限本来也完全相同：5000 词 / 单行 100 字 / 文件 4MB）。
//
// 语义必须和旧实现逐项一致（tests/wordscan.test.js 里留了一份「旧实现」做同输入同输出比对）：
//   · 字面匹配、区分大小写，不解释正则、不做大小写折叠；
//   · 重叠命中：同一个起点取最长的那个，已经被报过的命中覆盖到的一律跳过
//     （旧实现 = 原始命中按「位置升序 + 长度降序」排序后，index < lastEnd 的丢掉；
//      等价于从左到右的「最左 + 最长」贪心）；
//   · RAW_MATCH_LIMIT：原始命中数（去重前）到上限就停止并标 truncated，防止「的」这种高频字打爆内存；
//   · 命中按位置升序返回（调用方不用再排序）。
//
// 与旧实现唯一的差别（只出现在超上限的极端输入上）：旧实现按「词表顺序」逐词收集原始命中，
// 新实现按「正文位置」收集；截断时保留的是靠前的命中（对作者更直观），truncated 的语义不变。
//
// 纯逻辑：不 require fs / electron，可在单测里直接跑；text 由调用方先 normalizeText。
const DEFAULT_RAW_MATCH_LIMIT = 100000;

// 建自动机：trie（children）+ 失败链（fail）+ 输出表（out，含沿失败链继承的输出）。
// children 用 Map<charCode, node>：词表是中文为主、码点分散，用 Map 比定长数组省内存；
// 5000 词 × 平均几个字 = 一两万个节点，建一次的开销远小于一次扫描。
function buildAutomaton(patterns) {
  const children = [new Map()];
  const fail = [0];
  const out = [[]];
  let maxLen = 0;

  for (let index = 0; index < patterns.length; index += 1) {
    const pattern = patterns[index];
    if (typeof pattern !== 'string' || !pattern) continue;
    if (pattern.length > maxLen) maxLen = pattern.length;
    let node = 0;
    for (let at = 0; at < pattern.length; at += 1) {
      const code = pattern.charCodeAt(at);
      let next = children[node].get(code);
      if (next === undefined) {
        next = children.length;
        children[node].set(code, next);
        children.push(new Map());
        fail.push(0);
        out.push([]);
      }
      node = next;
    }
    out[node].push(index);
  }

  // BFS 建失败链；输出表 = 自己的词 + 失败链节点的输出（这样扫描时不用再沿链找）
  const queue = [];
  for (const child of children[0].values()) {
    fail[child] = 0;
    queue.push(child);
  }
  let head = 0;
  while (head < queue.length) {
    const node = queue[head];
    head += 1;
    const failNode = fail[node];
    if (out[failNode].length) out[node] = out[node].concat(out[failNode]);
    for (const [code, child] of children[node]) {
      let back = failNode;
      while (back !== 0 && !children[back].has(code)) back = fail[back];
      const target = children[back].get(code);
      fail[child] = target !== undefined && target !== child ? target : 0;
      queue.push(child);
    }
  }
  return { children, fail, out, maxLen };
}

// 扫描：单次遍历正文，边走自动机边收集命中。
// 返回 { hits: [{ patternIndex, index, length }], rawCount, truncated }；
// patternIndex 是传入 terms 数组的下标（两个模块各自映射成 term / suggestion / word）。
function scanTerms(text, terms, options = {}) {
  const patterns = Array.isArray(terms) ? terms : [];
  const limitValue = Number(options.rawMatchLimit);
  const rawMatchLimit = Number.isFinite(limitValue) && limitValue > 0
    ? Math.max(1, Math.floor(limitValue))
    : DEFAULT_RAW_MATCH_LIMIT;
  const auto = buildAutomaton(patterns);
  if (!auto.maxLen) return { hits: [], rawCount: 0, truncated: false };
  const source = typeof text === 'string' ? text : '';

  // 贪心状态：
  //   candidates —— start -> { len, pat }：还没落定的候选起点（窗口最大 = auto.maxLen 个，
  //                 因为更早的起点要么已经报出、要么已经被 lastEnd 覆盖）；
  //   pending    —— 当前最早、还没落定的候选起点；它要等「以它开头的命中全部出现」才能报出；
  //   lastEnd    —— 上一个已报命中的结束位置（重叠过滤线）。
  const candidates = new Map();
  let pending = -1;
  let lastEnd = 0;
  let rawCount = 0;
  let truncated = false;
  let scannedUntil = -1;
  let node = 0;
  const hits = [];

  function pickNext() {
    let best = -1;
    for (const key of candidates.keys()) {
      // 防御：正常流程下候选都在 lastEnd 之后，这里再挡一次，语义与旧实现的 lastEnd 一致
      if (key >= lastEnd && (best < 0 || key < best)) best = key;
    }
    pending = best;
  }

  function emitOne() {
    const candidate = candidates.get(pending);
    if (!candidate) {
      // 不该发生；兜底跳过，免得死循环
      candidates.delete(pending);
      pickNext();
      return;
    }
    hits.push({ patternIndex: candidate.pat, index: pending, length: candidate.len });
    lastEnd = pending + candidate.len;
    for (const key of candidates.keys()) {
      if (key < lastEnd) candidates.delete(key);
    }
    pickNext();
  }

  // 扫描中途只收「窗口已关」的候选：起点 s 的最长命中最长也只到 s + maxLen - 1，
  // 扫描到那里之后再报就不会漏掉更长的词（「色情小说」优先于「色情」）。
  function emitClosed() {
    while (pending >= 0 && scannedUntil >= pending + auto.maxLen - 1) emitOne();
  }

  for (let i = 0; i < source.length; i += 1) {
    const code = source.charCodeAt(i);
    while (node !== 0 && !auto.children[node].has(code)) node = auto.fail[node];
    const next = auto.children[node].get(code);
    node = next === undefined ? 0 : next;
    const outs = auto.out[node];
    if (outs.length) {
      for (let k = 0; k < outs.length; k += 1) {
        const patternIndex = outs[k];
        const length = patterns[patternIndex].length;
        rawCount += 1;
        const start = i - length + 1;
        if (start >= lastEnd) {
          const candidate = candidates.get(start);
          if (!candidate || length > candidate.len) {
            candidates.set(start, { len: length, pat: patternIndex });
          }
          if (pending < 0 || start < pending) pending = start;
        }
        if (rawCount >= rawMatchLimit) {
          truncated = true;
          break;
        }
      }
    }
    scannedUntil = i;
    if (truncated) break;
    emitClosed();
  }

  // 收尾：文本扫完（或撞上限提前停）时，所有已出现的命中都已看到，
  // 剩下的候选直接按「最左 + 最长」报出（截断时保留的是最靠前的命中）。
  while (true) {
    pickNext();
    if (pending < 0) break;
    emitOne();
  }

  return { hits, rawCount, truncated };
}

module.exports = {
  DEFAULT_RAW_MATCH_LIMIT,
  scanTerms
};
