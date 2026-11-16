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

// 建自动机：紧凑 trie（一张按节点分组的边数组）+ 失败链（fail）+ 输出表（outStart / outList，
// 含沿失败链继承的输出）。
//
// P2（审计修复 #18）：原来的「每个节点一个 Map」在病态词表上不是真上限 —— 4MB / 5000 词 × 100 字
// 无公共前缀可以有约 50 万个节点，单图约百 MB，LRU 4 份就是数百 MB；注释里「1–2 MB」的估算失真。
// 现在全部改成定长 typed array，容量由输入长度推出，是真常数：
//   · 节点数 ≤ Σ|pattern| + 1（新节点只在出现新码元时创建）；
//   · 边数 = 节点数 - 1；每节点的边在数组里连续、按字符码升序 → 子节点用二分查找，不需要 Map；
//   · 输出表（含失败链继承）≤ 词数 × 最长词长。
// 5000 词 × 100 字、零公共前缀的最坏情况：约 500k 节点 / 11 MB（旧实现约百 MB）。
// 做法：词条先按字符串排序（同一前缀的词条连续）→ BFS 扫「共享前缀的区间」，按字符分组建边；
// 节点 id 即 BFS 序（父先于子、浅先于深），失败链与输出继承一趟算完。
//
// A4 / P-03（审计：整本预检 / 校对是「每章建一次图」，1000 章 × 5000 词 = 1000 次建图）：
// 自动机建完只读，所以按「词表内容 + 顺序」缓存复用；同一词表连扫多章只建图一次。
// 缓存上限 4 份（常规 5000 词词表决算约 0.5 MB；校对 / 敏感词两套词表 + 作者中途换词表够用），
// 超了淘汰最早用的那份——宁可偶尔重建，也不让常驻内存跟着词表数量长。
// X6（v1.8.0 WP-40）：指纹只当索引用，命中后还要核对词表等值，碰撞时重建而不是复用错图。
const MAX_CACHED_AUTOMATONS = 4;
// 词表指纹：64 位（两个独立种子）滚动哈希。键里带「下标」，因为 out 存的是 patterns 的原下标，
// 同一批词换个顺序就是另一张图（不换会串 patternIndex）。
function automatonFingerprint(patterns) {
  let low = 0x811c9dc5;
  let high = 0xc2b2ae35;
  for (let index = 0; index < patterns.length; index += 1) {
    const pattern = patterns[index];
    if (typeof pattern !== 'string' || !pattern) continue;
    // 下标参与哈希：['a', null, 'b'] 与 ['a', 'b', null] 的 patternIndex 不同
    low ^= index + 1;
    low = Math.imul(low, 0x01000193);
    high = Math.imul(high ^ (index + 1), 0x85ebca77);
    for (let at = 0; at < pattern.length; at += 1) {
      const code = pattern.charCodeAt(at);
      low = Math.imul(low ^ code, 0x01000193);
      high = Math.imul(high ^ code, 0x2c1b3c6d);
    }
    high ^= high >>> 15;
  }
  return `${patterns.length}:${(low >>> 0).toString(16)}:${(high >>> 0).toString(16)}`;
}

const automatonCache = new Map(); // fingerprint -> { patterns, automaton }（LRU：命中时移到末尾）
const automatonStats = { builds: 0, hits: 0, collisions: 0 };

// X6（v1.8.0 WP-40，审计 X6）：缓存键只有 64 位滚动指纹，碰撞概率极低但一旦碰撞会静默复用错误
// 自动机（命中词张冠李戴）。缓存条目同时留一份「建图时词表快照」，命中后先做等值核对再复用；
// 不等值 = 撞了指纹，按未命中重建并替换条目（碰撞只多建一次图，绝不影响扫描结果）。
// 快照用 slice()：调用方之后原地改数组也不会让旧条目「看起来等值」而串用旧图。
function samePatterns(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

// fingerprint 参数只给单测注入（模拟指纹碰撞），产品调用一律走 automatonFingerprint。
function automatonFor(patterns, fingerprintOf) {
  const fingerprint = typeof fingerprintOf === 'function' ? fingerprintOf : automatonFingerprint;
  const key = fingerprint(patterns);
  const cached = automatonCache.get(key);
  if (cached && samePatterns(cached.patterns, patterns)) {
    automatonStats.hits += 1;
    automatonCache.delete(key);
    automatonCache.set(key, cached); // 触碰：淘汰时先丢最久没用的
    return cached.automaton;
  }
  if (cached) automatonStats.collisions += 1;
  const auto = buildAutomaton(patterns);
  automatonStats.builds += 1;
  automatonCache.delete(key); // 碰撞时旧条目让位；正常新增时本来就不存在
  automatonCache.set(key, { patterns: patterns.slice(), automaton: auto });
  if (automatonCache.size > MAX_CACHED_AUTOMATONS) {
    const oldest = automatonCache.keys().next();
    if (!oldest.done) automatonCache.delete(oldest.value);
  }
  return auto;
}

// 紧凑 trie 的子节点查找：某节点的出边在 [firstEdge[node], firstEdge[node+1]) 内、按字符码升序，
// 二分查找即可（建图 / 扫描共用这一份，不再有「每个节点一个 Map」）。
function childOf(auto, node, code) {
  let lo = auto.firstEdge[node];
  let hi = auto.firstEdge[node + 1] - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = auto.edgeCode[mid];
    if (value === code) return auto.edgeTarget[mid];
    if (value < code) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

function buildAutomaton(patterns) {
  const items = []; // { index, pattern }：只留有效词条（字符串、非空）
  let maxLen = 0;
  let totalUnits = 0;
  for (let index = 0; index < patterns.length; index += 1) {
    const pattern = patterns[index];
    if (typeof pattern !== 'string' || !pattern) continue;
    items.push({ index, pattern });
    totalUnits += pattern.length;
    if (pattern.length > maxLen) maxLen = pattern.length;
  }
  if (!items.length) {
    return {
      edgeCode: new Uint16Array(0),
      edgeTarget: new Int32Array(0),
      firstEdge: new Int32Array(1),
      fail: new Int32Array(1),
      outStart: new Int32Array(2),
      outList: new Int32Array(0),
      maxLen: 0
    };
  }
  // 按词条排序（同词条按原下标）：同一前缀的词条连续 → 一趟「区间分组」就能建边，
  // 不需要先建树再压平。排序用 UTF-16 码元序，与下面 charCodeAt 分组的顺序一致。
  items.sort((a, b) => (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : a.index - b.index));
  const maxNodes = totalUnits + 1;
  const edgeCode = new Uint16Array(maxNodes);
  const edgeTarget = new Int32Array(maxNodes);
  const parent = new Int32Array(maxNodes); // 建图期用（算失败链），建完随函数返回释放
  const parentCode = new Uint16Array(maxNodes);
  const firstEdge = new Int32Array(maxNodes + 1);
  const ownStart = new Int32Array(maxNodes);
  const ownCount = new Int32Array(maxNodes);
  const ownList = new Int32Array(items.length);
  const nodeLo = new Int32Array(maxNodes); // 共享本节点前缀的词条区间
  const nodeHi = new Int32Array(maxNodes);
  const nodeDepth = new Int32Array(maxNodes);
  const queue = new Int32Array(maxNodes); // BFS 队列：下标 = 节点 id
  let nodeCount = 1;
  let edgeCount = 0;
  let ownTotal = 0;
  nodeLo[0] = 0;
  nodeHi[0] = items.length;
  let head = 0;
  let tail = 1;
  while (head < tail) {
    const node = queue[head];
    head += 1;
    const lo = nodeLo[node];
    const hi = nodeHi[node];
    const depth = nodeDepth[node];
    firstEdge[node] = edgeCount;
    // ① 这一段里长度正好 = 深度的词条：以本节点收尾（排序后短的在前，连续）
    let at = lo;
    while (at < hi && items[at].pattern.length === depth) {
      if (!ownCount[node]) ownStart[node] = ownTotal;
      ownList[ownTotal] = items[at].index;
      ownTotal += 1;
      ownCount[node] += 1;
      at += 1;
    }
    // ② 其余按「深度处的字符」分组（排序后同字符连续）→ 每个字符一个新节点 + 一条边
    let groupStart = at;
    while (groupStart < hi) {
      const code = items[groupStart].pattern.charCodeAt(depth);
      let groupEnd = groupStart + 1;
      while (groupEnd < hi && items[groupEnd].pattern.charCodeAt(depth) === code) groupEnd += 1;
      const child = nodeCount;
      nodeCount += 1;
      parent[child] = node;
      parentCode[child] = code;
      edgeCode[edgeCount] = code;
      edgeTarget[edgeCount] = child;
      edgeCount += 1;
      nodeLo[child] = groupStart;
      nodeHi[child] = groupEnd;
      nodeDepth[child] = depth + 1;
      queue[tail] = child;
      tail += 1;
      groupStart = groupEnd;
    }
  }
  firstEdge[nodeCount] = edgeCount;
  const trie = { firstEdge, edgeCode, edgeTarget };

  // 失败链 + 输出条数：节点 id 就是 BFS 序，浅层一定先算完（fail[node] 只会指向更浅的节点）
  const fail = new Int32Array(nodeCount);
  const outLen = new Int32Array(nodeCount);
  for (let node = 1; node < nodeCount; node += 1) {
    const code = parentCode[node];
    let back = fail[parent[node]];
    let target = childOf(trie, back, code);
    while (back !== 0 && target < 0) {
      back = fail[back];
      target = childOf(trie, back, code);
    }
    // 根的子节点会在「根里找同一个字符」时找回自己 → target === node 时也算 0
    fail[node] = target >= 0 && target !== node ? target : 0;
    outLen[node] = ownCount[node] + outLen[fail[node]];
  }
  // 输出表压成一段连续数组：每节点 = 自己的词条 + 失败链节点的输出（顺序与旧实现相同）
  const outStart = new Int32Array(nodeCount + 1);
  for (let node = 0; node < nodeCount; node += 1) outStart[node + 1] = outStart[node] + outLen[node];
  const outList = new Int32Array(outStart[nodeCount]);
  for (let node = 0; node < nodeCount; node += 1) {
    let at = outStart[node];
    const ownFrom = ownStart[node];
    for (let k = 0; k < ownCount[node]; k += 1) {
      outList[at] = ownList[ownFrom + k];
      at += 1;
    }
    const from = fail[node];
    for (let k = outStart[from]; k < outStart[from + 1]; k += 1) {
      outList[at] = outList[k];
      at += 1;
    }
  }
  return { edgeCode, edgeTarget, firstEdge, fail, outStart, outList, maxLen };
}

// 扫描：单次遍历正文，边走自动机边收集命中。
// 返回 { hits: [{ patternIndex, index, length }], rawCount, truncated }；
// patternIndex 是传入 terms 数组的下标（两个模块各自映射成 term / suggestion / word）。
// options.fingerprint 只给单测注入（模拟指纹碰撞），产品调用不传。
function scanTerms(text, terms, options = {}) {
  const patterns = Array.isArray(terms) ? terms : [];
  const limitValue = Number(options.rawMatchLimit);
  const rawMatchLimit = Number.isFinite(limitValue) && limitValue > 0
    ? Math.max(1, Math.floor(limitValue))
    : DEFAULT_RAW_MATCH_LIMIT;
  const auto = automatonFor(patterns, options.fingerprint);
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
    // 等价于旧实现：先在当前节点找边，找不到就沿失败链回退；根上也找不到 → 回到根
    let next = childOf(auto, node, code);
    while (next < 0 && node !== 0) {
      node = auto.fail[node];
      next = childOf(auto, node, code);
    }
    node = next < 0 ? 0 : next;
    const outFrom = auto.outStart[node];
    const outTo = auto.outStart[node + 1];
    if (outTo > outFrom) {
      for (let k = outFrom; k < outTo; k += 1) {
        const patternIndex = auto.outList[k];
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

// 缓存观测（P-03 锚点用）：builds = 真建图次数，hits = 复用次数，size = 当前缓存份数，
// collisions = 指纹撞车后按等值核对发现不一致、改为重建的次数（X6；正常恒为 0）。
// 产品代码不读它，只有单测用它证明「同一词表 1000 章只建图 1 次」。
function automatonCacheStats() {
  return { builds: automatonStats.builds, hits: automatonStats.hits, size: automatonCache.size, collisions: automatonStats.collisions };
}

// 单测用：清空缓存并归零计数（避免不同用例之间互相污染计数）。
function resetAutomatonCache() {
  automatonCache.clear();
  automatonStats.builds = 0;
  automatonStats.hits = 0;
  automatonStats.collisions = 0;
}

// 单测用：按给定词表真建一张图（不碰缓存），回图的规模。P2（审计修复 #18）的锚点：
// 节点数 / 边数 / 输出条数都由输入长度推出（节点 ≤ Σ|pattern| + 1，边 = 节点 - 1，
// 输出 ≤ 词数 × 最长词长），不再是「每个节点一个 Map」那样随分支因子膨胀。
function measureAutomaton(patterns) {
  const auto = buildAutomaton(Array.isArray(patterns) ? patterns : []);
  return {
    nodes: auto.fail.length,
    edges: auto.firstEdge[auto.fail.length], // firstEdge[nodeCount] = 边数（数组本身是按上界分配的）
    outputs: auto.outStart[auto.outStart.length - 1],
    maxLen: auto.maxLen
  };
}

module.exports = {
  DEFAULT_RAW_MATCH_LIMIT,
  scanTerms,
  automatonCacheStats,
  resetAutomatonCache,
  measureAutomaton,
  samePatterns
};
