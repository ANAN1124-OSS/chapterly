'use strict';
// E2（审计 #28）：自定义字体的「同句柄」读取。
//
// 改前 main.js 的 font:read 是 realpath → stat（24MB 大小闸）→ readFile 三次按路径的独立调用：
// 校验的和真正读的可能是两个文件（TOCTOU 窗口）。同仓 storage.writeBookMeta 的 .bak 轮换早就用
// 「同一句柄 open → fstat → read」模式，这里对齐它：
//   · open 一次（只读），后续 stat / readFile 全部走这个句柄；
//   · 大小 / 是不是文件这类闸门在 fstat 之后、读之前由调用方的 validate 决定（抛错即关句柄）；
//   · close 幂等：调用方在 finally 里关，validate / read 抛错时这一层也会关一次。
//
// 纯逻辑、不 require electron，fs 由调用方注入（Node 单测直接给假 fs 验证「不按路径重开」）。

// 打开字体文件并做完 fstat 闸门；返回 { stat, read, close }。
//   fsLike: 需要 open(path, mode) 的对象（生产传 node:fs/promises）
//   validate(stat): 可选；返回值忽略，抛错则关闭句柄后原样抛出
async function openFontFile(fsLike, filePath, options = {}) {
  const validate = options && typeof options.validate === 'function' ? options.validate : null;
  const handle = await fsLike.open(filePath, 'r');
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await handle.close();
  }
  try {
    const stat = await handle.stat();
    if (validate) await validate(stat);
    return {
      stat,
      read: () => handle.readFile(),
      close
    };
  } catch (err) {
    // 闸门没过 / fstat 失败：不读，且句柄必须关掉（Windows 上不关会占住字体文件）
    await close().catch(() => {});
    throw err;
  }
}

module.exports = { openFontFile };