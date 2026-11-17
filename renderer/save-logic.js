/* 保存热路径的纯逻辑（代码审计 F2）——不碰 DOM、不读盘、不依赖 Electron。
 *
 * 改前：每次保存成功后，渲染层都 await 主进程的「全书校验」（readBookMeta + 每章 stat +
 *       bookStats），拿到 chapterCount 才出「已保存」提示。千章书每次 Ctrl+S 都在等这一趟。
 * 改后：保存成功立刻出提示（章数直接用书目里的章节数，保存不会增减章节）；全书校验挪到
 *       后台，只有真的缺章才 warn，失败只记日志、不误报。**两段文案与改动前逐字一致**，
 *       所以放在这里用单测锁住（tests/save-logic.test.js）。
 *
 * 浏览器挂 window.CWSaveLogic（index.html 在 renderer.js 之前加载），Node 里可 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWSaveLogic = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 保存成功的提示：`已保存：N 章 · 本章 X 字` + 可选的「今日快照已留」。
  // N 来自 state.chapters.length（保存前后章节数不变），X 是主进程返回的本章字数。
  function savedToastText(options) {
    const opts = options || {};
    const raw = Number(opts.chapterCount);
    const count = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
    const chars = opts.charsText == null ? '' : String(opts.charsText);
    const snapshotNote = opts.snapshotTaken ? ' · 今日快照已留' : '';
    // C0（审计 #3 / E1）：旧章字数基线读不到时，这一次的增量没进今日统计——在「已保存」旁
    // 补一句弱提示（不拦保存、不改其它文案）。正常路径这个字段不存在，提示与以前逐字一致。
    const baselineNote = opts.charsBaselineMissing ? ' · 本次字数未计入' : '';
    return `已保存：${count} 章 · 本章 ${chars}${snapshotNote}${baselineNote}`;
  }

  // 后台全书校验的结论：只有确实缺章才需要提醒；报告不完整 / 校验失败（调用方 catch 掉）
  // 一律静默，避免以前那句会误报的「全书校验失败」。
  function verifyWarnText(report) {
    const missing = report && Array.isArray(report.missing) ? report.missing.length : 0;
    return missing > 0 ? `已保存当前章，但全书有 ${missing} 个章节文件缺失` : '';
  }

  // 保存快照化（C1，v1.8.0 WP-01）：保存回执到达后，基线只能是「发起保存那一刻」的正文快照。
  // 保存期间敲入的字没有写盘，必须仍算未保存（切章 / 关窗照常提醒）——以前回执后重读活值并
  // 把 dirty 置 false，等于把没落盘的字并进基线，切章不再提醒、关窗时渲染层还自报干净。
  // 纯函数：null / undefined 一律按空串（与编辑区 .value 的类型口径一致）。
  function isDirtyAgainstSnapshot(snapshotText, liveText) {
    const snapshot = snapshotText == null ? '' : String(snapshotText);
    const live = liveText == null ? '' : String(liveText);
    return live !== snapshot;
  }

  // 保存后全书校验（book:verify）的单飞 / 合并（WP10 / 审计 P-N2）。
  //
  // 改前：每次保存成功都 fire-and-forget 起一趟 `book:verify`（逐章 stat + bookStats），
  // 没有在途标志；连按 Ctrl+S 会叠出 N 趟「同一本书的同一份扫描」，白占磁盘 / 线程池。
  // 改后：同一本书同时最多一趟；在途时再来的请求只标记「结束后补一次」（不排队 N 趟）；
  // 不同书互不影响（可并行）。一趟失败只由这里吞掉（onError 可观察），不卡死后续请求。
  //
  // 纯逻辑：不碰 DOM / IPC / 计时器；`run(key)` 是调用方给的异步函数（渲染层接 book:verify）。
  function createVerifySingleFlight(run, options) {
    const runner = typeof run === 'function' ? run : () => {};
    const opts = options || {};
    const onError = typeof opts.onError === 'function' ? opts.onError : null;
    const active = new Map(); // key -> { rerun }

    function start(key) {
      const token = { rerun: false };
      active.set(key, token);
      Promise.resolve()
        .then(() => runner(key))
        .catch((err) => {
          // 校验失败不影响保存：默认静默，调用方需要观察时传 onError（自己记日志）。
          if (onError) {
            try {
              onError(err, key);
            } catch {
              /* 观察者的异常也不许影响单飞账 */
            }
          }
        })
        .then(() => {
          if (active.get(key) !== token) return; // 已被更新的在途项替换（理论上不会发生）
          if (token.rerun) {
            token.rerun = false;
            start(key); // 在途期间有过请求 → 结束后最多补一次
            return;
          }
          active.delete(key);
        });
    }

    function request(target) {
      const key = String(target == null ? '' : target);
      if (!key) return 'ignored';
      const token = active.get(key);
      if (token) {
        token.rerun = true;
        return 'coalesced';
      }
      start(key);
      return 'started';
    }

    return {
      request,
      isActive: (target) => active.has(String(target == null ? '' : target)),
      activeCount: () => active.size
    };
  }

  // 保存失败回执里的「可采用的下一版 mtime」（WP14 E-N6 / WP1 M-N1 补漏）。
  // META_SAVE_FAILED 与 META_CHANGED 都是「正文已经写盘、书目没同步」：主进程把写盘后的章节
  // mtime 带回来，界面据此更新 loadedMtimeMs；否则下一次保存拿载入时的旧 mtime 比对，会误报
  // EXTERNAL_CHANGE。只接受 > 0 的有限数：0 是 force 保存的哨兵（expectedMtimeMs=0），负数 /
  // NaN / 缺字段（老主进程 / 坏回包）一律回落旧基线——绝不静默关掉外部改动检查。
  function retryMtimeMs(errorOrMtimeMs, currentMtimeMs) {
    const raw = errorOrMtimeMs && typeof errorOrMtimeMs === 'object' ? errorOrMtimeMs.mtimeMs : errorOrMtimeMs;
    const next = Number(raw);
    if (Number.isFinite(next) && next > 0) return next;
    const current = Number(currentMtimeMs);
    return Number.isFinite(current) ? current : 0;
  }

  // IPC 失败回执的白名单（renderer.call() 用）：A7 部分成功（bodySaved / chars / file）与
  // WP14 E-N6 / WP1 M-N1 的重试 mtime（META_SAVE_FAILED 与 META_CHANGED 都是正文已落盘、mtime 已变）。
  // 只收白名单字段（不带 ok / message）；mtime 只认 > 0 的有限数：0 是 force 哨兵，坏回包不采用。
  function saveFailureExtra(res) {
    if (!res || typeof res !== 'object') return null;
    const extra = {};
    if (res.bodySaved === true) {
      extra.bodySaved = true;
      if (Number.isFinite(Number(res.chars))) extra.chars = Number(res.chars);
      if (typeof res.file === 'string') extra.file = res.file;
    }
    const mtimeMs = Number(res.mtimeMs);
    if (Number.isFinite(mtimeMs) && mtimeMs > 0) extra.mtimeMs = mtimeMs;
    return Object.keys(extra).length ? extra : null;
  }

  return { savedToastText, verifyWarnText, isDirtyAgainstSnapshot, createVerifySingleFlight, saveFailureExtra, retryMtimeMs };
});
