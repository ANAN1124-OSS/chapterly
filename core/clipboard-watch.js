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
  createWatcher
};
