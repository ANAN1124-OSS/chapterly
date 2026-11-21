// b8（2026-11-05《剪贴板联动-方案与下一轮目标》）：后台剪贴板监听的纯逻辑。
//
// 这里只回答两个问题（2026-11-06 捕获队列起拆成两条判定）：
//   1. record —— 这次复制值不值得记进「本次运行的捕获队列」（变了 + 非空白；2026-11-07 起不再看长度：
//      短标题 / 短句也是一次复制，以前 <20 字直接吞掉，作者复制 4 次只剩 2 条「正文」）；
//      记录不受 8 秒冷却影响：连续复制的几次都要各留一条。
//   2. notify —— 值不值得给作者一条轻提示（原规则不变：变化 + ≥minChars + 冷却 + 同文只提示一次）；
//      冷却只压提示，不压记录。
// 不读剪贴板、不碰 DOM、不读盘、不写日志；主进程只把派生信息（字数 / 指纹）留在内存，
// 正文用完即弃（隐私红线：只驻内存、不落盘、不写日志、不做磁盘历史）。
//
// 规则（方案 §5 b8）：
//   · 文本必须真的变了（指纹不同）才考虑记录 / 提示；同一段文本只提示一次；
//   · 太短只不提示（默认 <20 字不弹轻提示，但照样记录：复制一个词也是一次复制）；
//   · 两次提示之间至少隔 cooldownMs（默认 8 秒，连续复制不刷屏）——记录不设冷却；
//   · 关闭监听 = disable()，重新打开时会以「当前剪贴板」重建基线（关着期间复制的东西不再提示）。
//
// 指纹只用于「是不是同一段文字」的比较，不是加密哈希；长度 + FNV-1a 32 位已足够区分。
function fingerprint(text) {
  const source = typeof text === 'string' ? text : '';
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${source.length}:${hash.toString(36)}`;
}

// CTXT-B-02（审计）：大文本（整章 / 整本复制，产品上限 30 万字）躺在剪贴板时，主进程每 300ms
// 读整串 + 全文哈希，是一直持续的底噪。这里给主进程轮询一个自适应降频器：
//   · 上一次读到的长度 ≥ threshold 且这一拍长度相同 → 接下来 skipTicks 拍「连读都不读」；
//   · 长度一变（新复制的一段）立即恢复逐拍读，下一次 observe 再决定是否继续降频。
// 代价：大文本之后 3 秒内的新复制最晚 3 秒后才进捕获队列（只影响捕获队列，不影响正文）。
// 纯逻辑、无定时器；主进程负责调用时机。
function createLargeTextPacer(options = {}) {
  const threshold = positiveInt(options.threshold, 300000);
  const skipTicks = positiveInt(options.skipTicks, 10);
  let lastLength = -1;
  let remaining = 0;
  return {
    // 本拍要不要完全跳过：为 true 时调用方不必读剪贴板、不必哈希、不必评估。
    shouldSkip() {
      if (remaining <= 0) return false;
      remaining -= 1;
      return true;
    },
    // 读完一次真实文本后登记长度；大文本且长度与上一次相同 → 安排后续跳过；
    // 长度一变（新复制的一段）就清掉跳过额度，立刻恢复逐拍读。
    observe(chars) {
      const length = Number.isFinite(Number(chars)) ? Math.max(0, Math.round(Number(chars))) : 0;
      if (length === lastLength && length >= threshold) remaining = skipTicks;
      else remaining = 0;
      lastLength = length;
      return remaining;
    },
    reset() {
      lastLength = -1;
      remaining = 0;
    },
    state() {
      return { lastLength, remaining };
    }
  };
}

function positiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1, Math.round(n));
}

function createWatcher(options = {}) {
  const minChars = positiveInt(options.minChars, 20);
  const cooldownMs = positiveInt(options.cooldownMs, 8000);
  const now = typeof options.now === 'function' ? options.now : Date.now;

  let enabled = false;
  let baseline = ''; // 上一次看到的剪贴板指纹（每次轮询都会更新）
  let notified = ''; // 上一次「已经提示过」的指纹
  let lastNotifiedAt = Number.NEGATIVE_INFINITY;
  // V39（审计）：启动 token。每次 enable / disable 都 +1；主进程每拍读数前记下当时的 token，
  // 回写时 token 已经不是当前值（中间跨过 stop→start）就整拍作废——不记队列、不提示、也不推进基准。
  let generation = 0;

  // 打开监听：以「当前剪贴板」为基线——打开设置开关那一刻剪贴板里已经有的内容不提示。
  function enable(initialText) {
    generation += 1;
    enabled = true;
    baseline = fingerprint(initialText);
    notified = '';
    lastNotifiedAt = Number.NEGATIVE_INFINITY;
  }

  function disable() {
    generation += 1;
    enabled = false;
    baseline = '';
    notified = '';
    lastNotifiedAt = Number.NEGATIVE_INFINITY;
  }

  // 主进程每次轮询调用。返回：
  //   changed  剪贴板文本确实变了（指纹不同）
  //   record   值得记进「本次运行捕获队列」（变了 + 非空白；不受长度 / 冷却影响）
  //   notify   值得给一条轻提示（≥minChars + 冷却 + 同文只提示一次）
  //   chars    当前文本长度；reason 给单测与排查用（不含正文）
  function evaluate(text, token) {
    // 在飞读数作废（V39）：跨过 stop→start 边界的旧读数直接丢弃，连基准都不碰。
    if (token !== undefined && token !== generation) {
      return { changed: false, record: false, notify: false, chars: 0, reason: 'stale', stale: true };
    }
    if (!enabled) return { changed: false, record: false, notify: false, chars: 0, reason: 'disabled' };
    if (typeof text !== 'string' || !text.length) {
      // WP14 C9（审计低批）：空读数（剪贴板清空 / 读失败的非字符串）也要推进基准。
      // 旧实现直接返回不更新 baseline：复制 A → 清空剪贴板 → 再复制 A 时第二次 A 被判 unchanged，
      // 「每次复制各记一条」漏记。空读数本身不记队列、不提示（changed 仍 false）。
      baseline = fingerprint('');
      return { changed: false, record: false, notify: false, chars: 0, reason: 'empty' };
    }
    const chars = text.length;
    const fp = fingerprint(text);
    if (fp === baseline) return { changed: false, record: false, notify: false, chars, reason: 'unchanged' };
    baseline = fp; // 变了就记下来；哪怕太短 / 冷却中，下次同样的内容也不重复判定
    // 只复制了空白（空格 / 换行）：记进队列也没有内容可写，跳过（也不提示）。
    if (!text.trim()) return { changed: true, record: false, notify: false, chars, reason: 'blank' };
    // 短文本只压「轻提示」，不再压「记录」：一次复制 = 一条记录（2026-11-07 修「复制 4 次只留 2 次」）。
    if (chars < minChars) return { changed: true, record: true, notify: false, chars, reason: 'too-short' };
    // 新的一段、足够长：一律记录（连续复制几段要各留一条）；下面的冷却只压提示。
    if (fp === notified) return { changed: true, record: true, notify: false, chars, reason: 'already-notified' };
    if (now() - lastNotifiedAt < cooldownMs) return { changed: true, record: true, notify: false, chars, reason: 'cooldown' };
    notified = fp;
    lastNotifiedAt = now();
    return { changed: true, record: true, notify: true, chars, reason: 'changed' };
  }

  return {
    enable,
    disable,
    evaluate,
    token: () => generation,
    isEnabled: () => enabled,
    minChars,
    cooldownMs
  };
}

module.exports = {
  fingerprint,
  createWatcher,
  createLargeTextPacer
};
