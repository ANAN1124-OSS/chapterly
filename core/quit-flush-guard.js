// v1.8.3 WP9（审计 C1 / 中 #8）：退出收尾（flush）的有界等待。
//
// 问题：`will-quit` 里等 `lastOpenWrites.flushAll()`（把防抖中的「上次打开章节」写进 书目.json）与
// `endCrashDraftSession()`（删崩溃草稿的运行标记 + 草稿），没有任何超时。书在断开的网络盘 / 同步盘，
// 或书锁被整本长操作持有时，这个等待可能永远不回来，退出就被无限期推迟 —— 关窗路径早有 8 秒看门狗
// （core/close-guard.js 的 CLOSE_TIMEOUT_MS），退出路径没有，这就是不对称的缺陷。
//
// 现在的口径：
//   · 2.5 秒（QUIT_FLUSH_TIMEOUT_MS，审计要求 2–3 秒）到点直接 quit；
//   · 超时 / 失败放弃的只是**便利数据**：lastOpenChapterId 下次切章会重建；崩溃草稿的残留标记由
//     下次启动的 beginSession 按 pid 判成「上次异常退出」，照常弹恢复提示，不阻塞启动。
//     正文与书目里已经写下去的内容一个字节不动；
//   · 收尾 Promise 拒绝（ENOSPC / EPERM / 被占用）立即 quit，不空等满超时；
//   · quit 严格一次：超时之后收尾才回来（或才失败）只吞掉，不再 quit、不再记日志；
//   · 定时器在收尾先完成时清掉，不留悬挂的「迟到退出一枪」。
//
// 纯逻辑：不 require electron、不读不写文件；main.js 只装配（work / quit / log 三个回调），
// 行为由 tests/quit-flush-guard.test.js 注入「永不回来的收尾」「ENOSPC」「迟到结果」逐条钉住。
const QUIT_FLUSH_TIMEOUT_MS = 2500;

const TIMEOUT_CODE = 'QUIT_FLUSH_TIMEOUT';
const FAILED_CODE = 'QUIT_FLUSH_FAILED';

// 超时值只认有限正数（毫秒）；缺失 / 0 / 负数 / NaN / Infinity / 字符串一律落回默认常量。
// 超时参数只应该来自本模块常量 —— 别处传来的花样值不能把退出变成「永不等」或「立刻到点」。
function normalizeTimeoutMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return QUIT_FLUSH_TIMEOUT_MS;
  return Math.floor(value);
}

// 只取错误码（不取 message：fs 的错误消息带本机绝对路径，日志里不能出现）。
function errorCodeOf(error) {
  try {
    if (error && typeof error.code === 'string' && error.code) return error.code;
  } catch {
    /* 读不出来就当没有错误码 */
  }
  return '';
}

// 有界等待收尾：work() 先完成 → done；work() 先失败 → failed；超时先到 → timeout。
// 三条路径都**恰好**调用一次 quit()（quit 自己抛错也吞掉），并返回结果对象：
//   { outcome: 'done' | 'failed' | 'timeout', timedOut, quitCount, timeoutMs, elapsedMs, errorCode }
// log 收到 { code, level: 'warn', message, errorCode?, timeoutMs? }，message 只含固定说明。
function runQuitCleanup(options) {
  const source = options && typeof options === 'object' ? options : {};
  const timeoutMs = normalizeTimeoutMs(source.timeoutMs);
  const work = typeof source.work === 'function' ? source.work : null;
  const quit = typeof source.quit === 'function' ? source.quit : null;
  const log = typeof source.log === 'function' ? source.log : null;
  const startedAt = Date.now();

  let settled = false;
  let timer = null;
  let quitCount = 0;

  return new Promise((resolve) => {
    const quitOnce = () => {
      if (quitCount > 0) return;
      quitCount += 1;
      if (!quit) return;
      try {
        quit();
      } catch {
        /* quit 自己抛错也不能挡住退出 */
      }
    };

    const finish = (outcome, extra) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      quitOnce();
      const detail = extra && typeof extra === 'object' ? extra : {};
      resolve({
        outcome,
        timedOut: outcome === 'timeout',
        quitCount,
        timeoutMs,
        elapsedMs: Date.now() - startedAt,
        errorCode: typeof detail.errorCode === 'string' ? detail.errorCode : ''
      });
    };

    const logEntry = (entry) => {
      if (!log) return;
      try {
        log(entry);
      } catch {
        /* 日志不能挡住退出 */
      }
    };

    timer = setTimeout(() => {
      timer = null;
      logEntry({
        code: TIMEOUT_CODE,
        level: 'warn',
        timeoutMs,
        message: `退出收尾超时（已等 ${timeoutMs} 毫秒），直接退出：上次打开章节下次切章会重建，崩溃草稿留待下次启动识别`
      });
      finish('timeout');
    }, timeoutMs);

    const handleFailure = (error) => {
      // 超时之后迟到的失败：只吞掉，不再记日志 / 不再 quit。
      if (settled) return;
      const errorCode = errorCodeOf(error);
      logEntry({
        code: FAILED_CODE,
        level: 'warn',
        timeoutMs,
        errorCode,
        message: `退出收尾失败${errorCode ? `（${errorCode}）` : ''}，直接退出（已落盘的内容不受影响）`
      });
      finish('failed', { errorCode });
    };

    try {
      const pending = work ? work() : null;
      Promise.resolve(pending).then(() => finish('done'), handleFailure);
    } catch (error) {
      handleFailure(error);
    }
  });
}

module.exports = {
  QUIT_FLUSH_TIMEOUT_MS,
  normalizeTimeoutMs,
  runQuitCleanup
};