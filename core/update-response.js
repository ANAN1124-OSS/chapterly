// 更新检查的**响应限长**与**单飞**（1.6.0 H5 / 审计 S-02）——不碰网络、不碰 Electron，可在 Node 里直接测。
//
// 问题：`fetchReleaseResponse()` 旧实现只看 `content-length` 头；头里没有这个字段时
// `res.text()` 会把整包读进内存再截断 —— 一个坏掉 / 恶意的更新响应就能把主进程内存顶起来。
// 另一个小毛病：连点两次「检查更新」会并发发两次请求（GitHub 限流按 IP 算，容易 403）。
//
// 这里给两个纯工具：
//   readResponseTextLimited(response, maxChars)
//     → 有 body.getReader() 就走流式读，累计到 maxChars 立即停并 cancel 掉流；
//       返回 { text, tooLarge }。没有流（测试桩 / 旧接口）退回 text()，同样按上限截断。
//       **不整包读**：超限时 text 最多 maxChars + 1 个字符，调用方据此报 TOO_LARGE。
//   createSingleFlight()
//     → 包一层「同一时刻只跑一次」：并发调用复用同一个 Promise，结束后（成功或失败）释放。
//
// 判定口径：maxChars 必须是正数（不然又退化成整包读）；坏响应对象按空文本处理，绝不抛错。

// 流式读正文，最多读到 maxChars（超了立刻停）。返回 { text, tooLarge }：
// tooLarge = true 时 text 是 maxChars + 1 个字符（刚好能让上层判定超限，又不会继续涨）。
async function readResponseTextLimited(response, maxChars) {
  const limit = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0 ? Math.round(Number(maxChars)) : 0;
  if (!response || typeof response !== 'object') return { text: '', tooLarge: false };
  const body = response.body;
  // 非流式响应（测试桩 / 老接口）：照旧读字符串，但同样按上限截断，不把整包留在内存里。
  if (!body || typeof body.getReader !== 'function') {
    let text;
    try {
      text = typeof response.text === 'function' ? await response.text() : '';
    } catch {
      return { text: '', tooLarge: false };
    }
    if (typeof text !== 'string') return { text: '', tooLarge: false };
    if (limit && text.length > limit) return { text: text.slice(0, limit + 1), tooLarge: true };
    return { text, tooLarge: false };
  }
  if (!limit) throw new TypeError('readResponseTextLimited 需要正数上限（否则等于整包读）');
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let tooLarge = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (!chunk || chunk.done === true) break;
      if (chunk.value) text += decoder.decode(chunk.value, { stream: true });
      if (text.length > limit) {
        tooLarge = true;
        break;
      }
    }
    if (tooLarge) {
      try {
        await reader.cancel();
      } catch {
        /* 流已经关掉了 */
      }
    } else {
      // 收尾：把最后一个多字节字符补完（chunk 边界可能刚切在汉字中间）
      text += decoder.decode();
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* 已释放 */
    }
  }
  return tooLarge ? { text: text.slice(0, limit + 1), tooLarge: true } : { text, tooLarge: false };
}

// 同一时刻只跑一次：并发调用复用同一个 Promise；成功 / 失败都释放，之后可以再跑。
function createSingleFlight() {
  let inFlight = null;
  return function run(task) {
    if (typeof task !== 'function') return Promise.reject(new TypeError('singleFlight 需要一个函数'));
    if (inFlight) return inFlight;
    let started;
    try {
      started = Promise.resolve(task());
    } catch (err) {
      started = Promise.reject(err);
    }
    const tracked = started.finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
    return tracked;
  };
}

module.exports = { readResponseTextLimited, createSingleFlight };