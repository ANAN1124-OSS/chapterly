// B3（审计 P3）：按 key 合并的延迟写盘器（切章「上次打开章节」用）。
//
// 背景：渲染层每切一章都会 fire-and-forget 一次 book:set-last；旧实现每次都「读整本书目 →
// 改一个字段 → 写整本书目」。千章书里连续切章就是反复读 / 写几 MB 的 书目.json。
// 这个工具把同一本书 1–2 秒内的连续更新合并成一次落盘（只写最后一次），并提供
// flush / flushAll（退出、关窗、切回书架前调用，保证「重开书回到上次章」不丢最后一次）。
//
// 纯逻辑：不 require electron / fs；延时函数可注入（单测用假定时器，不靠 sleep）。
// 语义：
//   · schedule(key, payload)：覆盖同一 key 待写的 payload；只有「第一次」会排一个定时器
//     （定时器到点后写的是最新 payload，不是第一次的）；
//   · flush(key)：立刻取消定时器并写这一条（没有待写就什么都不做，返回 null）；
//   · flushAll()：把所有待写的都写掉（并行，互不依赖）；
//   · 写入失败不吞：flush 的 Promise 会 reject（调用方决定记日志 / 忽略），
//     但定时器自动触发那条路径会自己 catch 掉，避免 unhandledRejection 打断主进程。
function createKeyedDebouncer(options = {}) {
  const delayMs = Number.isFinite(Number(options.delayMs)) ? Math.max(0, Math.round(Number(options.delayMs))) : 1500;
  const save = typeof options.save === 'function' ? options.save : async () => {};
  const setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout;
  const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout;

  const pending = new Map(); // key -> { payload, timer }
  let disposed = false;

  function take(key) {
    const entry = pending.get(key);
    if (!entry) return null;
    pending.delete(key);
    if (entry.timer != null) clearTimer(entry.timer);
    return entry.payload;
  }

  function schedule(key, payload) {
    if (disposed) return;
    const normalized = String(key);
    const current = pending.get(normalized);
    if (current) {
      current.payload = payload; // 合并：定时器不动，到点写最新那次
      return;
    }
    const entry = { payload, timer: null };
    entry.timer = setTimer(() => {
      // 定时器到点：先把条目摘掉（避免和手动 flush 重复写），再写
      const latest = take(normalized);
      if (latest == null) return;
      Promise.resolve()
        .then(() => save(latest, normalized))
        .catch(() => {
          /* 自动触发路径吞掉失败：调用方没在等，不能让主进程报 unhandledRejection */
        });
    }, delayMs);
    if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
    pending.set(normalized, entry);
  }

  async function flush(key) {
    const payload = take(String(key));
    if (payload == null) return null;
    return save(payload, String(key));
  }

  async function flushAll() {
    const payloads = [];
    for (const key of Array.from(pending.keys())) {
      const payload = take(key);
      if (payload != null) payloads.push(save(payload, key));
    }
    return Promise.all(payloads);
  }

  function size() {
    return pending.size;
  }

  function dispose() {
    disposed = true;
    for (const entry of pending.values()) {
      if (entry.timer != null) clearTimer(entry.timer);
    }
    pending.clear();
  }

  return { schedule, flush, flushAll, size, dispose };
}

module.exports = { createKeyedDebouncer };
