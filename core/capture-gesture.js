// 一次性「读剪贴板」凭证（S1 / N-15）：签发 / 校验 / 消费三分离。
//
// 为什么要有：capture:clipboard 是唯一会把系统剪贴板原文交给渲染层的频道（剪贴板里可能是密码 /
// 验证码）。现在必须先由「打开捕获面板」这个动作（capture:flush）换一张本窗口的一次性凭证，
// 用掉即废、60 秒过期；凭证只存在主进程内存里，渲染层伪造不出来。
//
// N-15（二次审查）：以前的顺序是「消费 → 读剪贴板 → 长度校验」——剪贴板暂时读不到（锁屏 / 远程
// 桌面）或原文超限时，凭证已经被标记用掉，作者修好剪贴板后只能关掉面板重开。这里把校验与消费
// 拆成两个方法：
//   · check()    只验有效（窗口 / 令牌 / 过期 / 未用过），不改状态 —— 失败可原样重试；
//   · consume()  成功拿到正文并通过长度校验之后才调用（用掉即废）。
// 本模块是纯内存纯逻辑：不读剪贴板、不碰 fs / DOM / Electron / 定时器（过期是惰性判定 + 顺手清）。
'use strict';

const { positiveInt } = require('./common');

// 60 秒：够作者看完面板决定读不读，又不会在面板关掉后长期留下一张可用凭证。
const DEFAULT_TTL_MS = 60 * 1000;

function createCaptureGestures(options = {}) {
  const ttlMs = positiveInt(options.ttlMs, DEFAULT_TTL_MS);
  const now = typeof options.now === 'function' ? options.now : Date.now;

  const gestures = new Map(); // windowId(String) -> { token, at, used }
  let seq = 0;

  // 窗口 id 归一成字符串键（主进程的 session.id 是数字；非法值一律当作「没有窗口」）。
  function normalizeWindowId(value) {
    if (value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? String(Math.trunc(n)) : null;
  }

  function isExpired(gesture, nowMs) {
    return nowMs - gesture.at > ttlMs;
  }

  // 惰性清理：把过期 / 已用掉的凭证丢掉（调用方不必关心；这里不猜定时器）。返回清掉的张数。
  function sweep(nowMs) {
    let removed = 0;
    for (const [key, gesture] of gestures) {
      if (gesture.used || isExpired(gesture, nowMs)) {
        gestures.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  // 签发一张绑定窗口的凭证；同一窗口只保留最新一张（连按快捷键不会攒一叠）。
  function issue(windowId) {
    const key = normalizeWindowId(windowId);
    if (key == null) return null;
    const at = now();
    seq += 1;
    const token = `g-${at.toString(36)}-${seq.toString(36)}`;
    gestures.set(key, { token, at, used: false });
    return token;
  }

  // 校验：窗口对得上、没过期、没用过、令牌逐字相等。**不改状态**（N-15）。
  function check(windowId, token) {
    const key = normalizeWindowId(windowId);
    if (key == null) return false;
    const gesture = gestures.get(key);
    if (!gesture || gesture.used) return false;
    if (isExpired(gesture, now())) {
      gestures.delete(key);
      return false;
    }
    return typeof token === 'string' && Boolean(token) && token === gesture.token;
  }

  // 消费（用掉即废）：成功读到正文并过长度校验之后才调用。
  function consume(windowId, token) {
    if (!check(windowId, token)) return false;
    gestures.get(normalizeWindowId(windowId)).used = true;
    return true;
  }

  // 关窗 / 关面板：作废这一扇窗口的凭证。返回是否真的删掉了一张。
  function release(windowId) {
    const key = normalizeWindowId(windowId);
    if (key == null) return false;
    return gestures.delete(key);
  }

  return {
    issue,
    check,
    consume,
    release,
    sweep: () => sweep(now()),
    size: () => gestures.size,
    ttlMs
  };
}

module.exports = {
  createCaptureGestures,
  DEFAULT_TTL_MS
};
