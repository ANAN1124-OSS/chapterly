// 手拼 ZIP（store / deflate 两种方式），EPUB 与 DOCX 导出共用。
//
// 只用 Node 内置 zlib，不引入任何第三方运行时依赖。
// 时间戳走 DOS 格式（1980 起、2 秒精度）：同一份内容 + 同一个时间 ⇒ 字节完全一样，
// 单测和 E2E 才能拿固定时间断言「同样的输入导出同样的文件」。
//
// 条目名闸门（v0.9 C-3，安全审计 C6）：EPUB / DOCX 的条目名全部由本应用生成
// （`OEBPS/text/chapter-0001.xhtml` 这种），书名 / 卷名 / 章名只进正文，一个字节都不进条目名。
// 但万一以后有人把作者输入拼进条目名，`../`、`C:`、反斜杠这类名字解压时会变成
// 「写到包外面」（zip-slip）。所以 buildZip 先过 assertEntryName：
// 只允许 ASCII 可打印字符，不允许反斜杠 / 冒号 / 绝对路径 / `.` `..` 段 / 空段，
// 名字最长 255 字节。不合法直接抛错，宁可导出失败也不产出能把文件写到别处的包。
const zlib = require('node:zlib');
const { promisify } = require('node:util');

// 1.5.0 P2-4：压缩改走 zlib 的异步实现（libuv 线程池），整本导出时不再把主进程卡住。
// 参数与旧版 `zlib.deflateRawSync(raw, { level: 9 })` 完全一致（level / memLevel / strategy /
// windowBits 都是 zlib 默认值），产物逐字节相同 —— tests/zip.test.js 有一条固定 sha256 基准锁住这一点。
const deflateRaw = promisify(zlib.deflateRaw);

// zip 条目名字节上限：解压到常见文件系统都够用（我们自己生成的名字都不到 40 字节）
const MAX_ENTRY_NAME_BYTES = 255;
// 只允许 ASCII 可打印字符（0x20–0x7e）：控制字符 / 换行 / 非 ASCII 一律不收。
// 非 ASCII 也挡掉是有意的——本地文件头不写 UTF-8 标志位（flag=0），
// 名字一旦不是 ASCII，不同解压器就会按 CP437 解成乱码；真需要中文条目名时，
// 得先给这个文件加 UTF-8 标志位支持，再放开这里。
const ENTRY_NAME_CHARS = /^[\x20-\x7e]+$/;

// 检查一个 zip 条目名：返回空串表示合法，否则返回原因码。
// 只回原因码、不回名字本身，免得把可能带控制字符的字符串写进错误信息 / 日志。
function entryNameProblem(raw) {
  if (typeof raw !== 'string' || !raw) return 'EMPTY';
  if (!ENTRY_NAME_CHARS.test(raw)) return 'NON_PRINTABLE';
  if (raw.includes('\\')) return 'BACKSLASH';
  if (raw.includes(':')) return 'COLON';
  if (raw.startsWith('/')) return 'ABSOLUTE';
  if (Buffer.byteLength(raw, 'utf8') > MAX_ENTRY_NAME_BYTES) return 'TOO_LONG';
  for (const part of raw.split('/')) {
    if (!part || part === '.' || part === '..') return 'DOT_SEGMENT';
  }
  return '';
}

// 校验并原样返回条目名；不合法抛错（错误信息里只有原因码）。
function assertEntryName(raw) {
  const problem = entryNameProblem(raw);
  if (problem) throw new Error(`ZIP 条目名不合法（${problem}）`);
  return raw;
}

// CIO-B03：CRC32 直接用 Node 22.2+ 内置的 zlib.crc32（增量语义：入参是上一次的最终值、返回值即
// 无符号 32 位）。对外三件套（Start 0xffffffff / Update / Finish 取反）原样保留 —— zlib 只看
// 「最终值」，所以这里在调用前后各做一次取反映射。老运行时（<22.2）退回逐位实现（同一
// IEEE 802.3 多项式，结果逐字节一致），不再维护那份 256 项查表。
const HAS_BUILTIN_CRC32 = typeof zlib.crc32 === 'function';

function crc32Start() {
  return 0xffffffff;
}

// 增量 CRC：流式打包时逐块更新（B1 / WP13），不额外物化整条载荷。
function crc32Update(crc, buffer) {
  if (HAS_BUILTIN_CRC32) {
    return (zlib.crc32(buffer, (crc ^ 0xffffffff) >>> 0) ^ 0xffffffff) >>> 0;
  }
  let value = crc >>> 0;
  for (let i = 0; i < buffer.length; i += 1) {
    value = (value ^ buffer[i]) >>> 0;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (0xedb88320 ^ (value >>> 1)) >>> 0 : value >>> 1;
    }
  }
  return value >>> 0;
}

function crc32Finish(crc) {
  return (crc ^ 0xffffffff) >>> 0;
}

function crc32(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer == null ? '' : buffer), 'utf8');
  return crc32Finish(crc32Update(crc32Start(), buf));
}

// zip 的时间戳是 DOS 格式（1980 起、2 秒精度）；同一份内容 + 同一个时间 ⇒ 字节完全一样。
function dosDateTime(value) {
  const date = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time:
      ((date.getHours() & 0x1f) << 11) |
      ((date.getMinutes() & 0x3f) << 5) |
      ((date.getSeconds() >> 1) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f)
  };
}

// entries = [{ name, data(Buffer|string), store?: boolean }]
// store=true 的条目原样存（EPUB 的 mimetype 必须这样，阅读器靠它判断是不是 EPUB）。
// 返回 Promise<Buffer>：每个条目依次 await 异步 deflate（一次只压一个，峰值内存与旧实现相同）。
async function buildZip(entries, options) {
  const list = Array.isArray(entries) ? entries : [];
  // zip 的中央目录用 2 字节记条目数：超了不写坏包，直接报错（不写 zip64，本应用用不到）
  if (list.length > 0xffff) throw new Error('ZIP 条目太多（上限 65535 项）');
  const stamp = dosDateTime(options && options.date);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of list) {
    const name = Buffer.from(assertEntryName(entry && entry.name), 'utf8');
    const raw = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(String(entry.data == null ? '' : entry.data), 'utf8');
    let method = 0;
    let payload = raw;
    if (!(entry.store === true) && raw.length > 0) {
      const deflated = await deflateRaw(raw, { level: 9 });
      // 小文件压完反而更大时仍然原样存，省得白白变胖
      if (deflated.length < raw.length) {
        method = 8;
        payload = deflated;
      }
    }
    // 中央目录用 4 字节记偏移 / 长度：超 4 GB 直接报错（同上，不写 zip64）
    if (offset + 30 + name.length + payload.length > 0xffffffff) {
      throw new Error('ZIP 包超过 4 GB 上限');
    }
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0, 6); // 标志位（文件名全是 ASCII，不用 UTF-8 标志）
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // 扩展字段长度（mimetype 也必须是 0）
    localParts.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    central.writeUInt16LE(20, 4); // 创建者版本
    central.writeUInt16LE(20, 6); // 解压所需版本
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // 扩展字段
    central.writeUInt16LE(0, 32); // 注释
    central.writeUInt16LE(0, 34); // 起始磁盘号
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE(0, 38); // 外部属性
    central.writeUInt32LE(offset, 42); // 本地头偏移
    centralParts.push(central, name);

    offset += 30 + name.length + payload.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // 目录结尾记录
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(list.length, 8);
  end.writeUInt16LE(list.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

// ---------- 流式打包（B1 / 审计 #17 / WP13） ----------
// buildZip 要先把所有条目的本地头 + 载荷攒进 localParts，最后 Buffer.concat 出整包：
// 大书导出时整份 zip 在内存里至少两份（分片 + 成品）。streamZip 改成「逐条写进调用方写入器」：
//   · 本地文件头 / 条目名 / 载荷按 buildZip 的字段与顺序直接 write 出去；
//   · 只把中央目录（每条 46 + 名称字节，通常几百 KB）留在内存；
//   · 产物与 buildZip 逐字节一致（tests/export-stream-wp13.test.js R1 对拍），
//     「同样的输入 + 同样的时间 ⇒ 同样的文件」这条承诺不变。
// 条目数据有两种来源：
//   · entry.data  —— string / Buffer，一次性压（与 buildZip 同一判定：压完更大就原样存）；
//   · entry.chunks —— 工厂函数，返回 string / Buffer 的同步或异步可迭代对象：
//     分块喂 zlib 的流式 deflate（实测与一次性 deflateRaw 逐字节相同），压缩产物按块收着
//     （压缩后体积远小于原文，通常是整本的 1/10 量级）；万一压完反而更大，重新调用工厂
//     收原始分块按 store 写（不为了省一次重跑而多留一份原文）。
function toPayloadBuffer(piece) {
  if (Buffer.isBuffer(piece)) return piece;
  return Buffer.from(String(piece == null ? '' : piece), 'utf8');
}

// 等 deflate 的 drain（背压），同时把流自身的错误转成 reject。
function waitDrain(stream) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.removeListener('drain', onDrain);
      stream.removeListener('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

// chunks 工厂 → 流式压缩：返回 { rawLength, crc, parts(压缩块), deflatedLength }。
async function deflateChunkSource(makeChunks) {
  const deflate = zlib.createDeflateRaw({ level: 9 });
  const parts = [];
  let deflatedLength = 0;
  const finished = new Promise((resolve, reject) => {
    deflate.once('end', resolve);
    deflate.once('error', reject);
  });
  // 提前退出（写入器失败 / 工厂抛错）时不要留下未处理的 rejection
  finished.catch(() => {});
  deflate.on('data', (part) => {
    parts.push(part);
    deflatedLength += part.length;
  });
  let rawLength = 0;
  let crc = crc32Start();
  try {
    for await (const piece of makeChunks()) {
      const buf = toPayloadBuffer(piece);
      if (!buf.length) continue;
      rawLength += buf.length;
      crc = crc32Update(crc, buf);
      if (!deflate.write(buf)) await waitDrain(deflate);
    }
    deflate.end();
    await finished;
    return { rawLength, crc: crc32Finish(crc), parts, deflatedLength };
  } catch (err) {
    deflate.destroy();
    throw err;
  }
}

// 兜底：压缩反而更大时按 store 收原始分块（工厂会被第二次调用）。
async function collectChunkSource(makeChunks) {
  const parts = [];
  let rawLength = 0;
  let crc = crc32Start();
  for await (const piece of makeChunks()) {
    const buf = toPayloadBuffer(piece);
    if (!buf.length) continue;
    rawLength += buf.length;
    crc = crc32Update(crc, buf);
    parts.push(buf);
  }
  return { rawLength, crc: crc32Finish(crc), parts, deflatedLength: rawLength };
}

// entries 可以是数组，也可以是（异步）生成器；options 与 buildZip 相同（date 可选）。
// write(chunk) 由调用方提供（atomicWriteFileStream 的 write）；返回 { bytes, count }，
// bytes = 实际写出的字节数，等于 buildZip 产物长度。
async function streamZip(entries, options, write) {
  if (typeof write !== 'function') throw new TypeError('streamZip 需要写入回调');
  const list =
    entries && (typeof entries[Symbol.asyncIterator] === 'function' || typeof entries[Symbol.iterator] === 'function')
      ? entries
      : [];
  const stamp = dosDateTime(options && options.date);
  const centralParts = [];
  let offset = 0;
  let count = 0;
  for await (const entry of list) {
    count += 1;
    // zip 的中央目录用 2 字节记条目数：超了不写坏包（与 buildZip 同一文案）
    if (count > 0xffff) throw new Error('ZIP 条目太多（上限 65535 项）');
    const name = Buffer.from(assertEntryName(entry && entry.name), 'utf8');
    let method = 0;
    let rawLength;
    let crc;
    let payloadParts;
    let payloadLength;
    if (entry && typeof entry.chunks === 'function' && entry.store !== true) {
      const deflated = await deflateChunkSource(entry.chunks);
      if (deflated.rawLength > 0 && deflated.deflatedLength < deflated.rawLength) {
        method = 8;
        rawLength = deflated.rawLength;
        crc = deflated.crc;
        payloadParts = deflated.parts;
        payloadLength = deflated.deflatedLength;
      } else {
        const raw = await collectChunkSource(entry.chunks);
        method = 0;
        rawLength = raw.rawLength;
        crc = raw.crc;
        payloadParts = raw.parts;
        payloadLength = raw.rawLength;
      }
    } else if (entry && typeof entry.chunks === 'function') {
      // store:true 的分块条目原样写（与 buildZip 的 store=true 同义）
      const raw = await collectChunkSource(entry.chunks);
      rawLength = raw.rawLength;
      crc = raw.crc;
      payloadParts = raw.parts;
      payloadLength = raw.rawLength;
    } else {
      const raw = toPayloadBuffer(entry && entry.data);
      rawLength = raw.length;
      crc = crc32(raw);
      payloadParts = [raw];
      payloadLength = raw.length;
      if (entry.store !== true && raw.length > 0) {
        const deflated = await deflateRaw(raw, { level: 9 });
        // 小文件压完反而更大时仍然原样存，省得白白变胖（与 buildZip 同判定）
        if (deflated.length < raw.length) {
          method = 8;
          payloadParts = [deflated];
          payloadLength = deflated.length;
        }
      }
    }
    // 中央目录用 4 字节记偏移 / 长度：超 4 GB 直接报错（同上，不写 zip64）
    if (offset + 30 + name.length + payloadLength > 0xffffffff) {
      throw new Error('ZIP 包超过 4 GB 上限');
    }

    // 本地文件头：字段 / 顺序 / 取值与 buildZip 逐项一致
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0, 6); // 标志位（文件名全是 ASCII，不用 UTF-8 标志）
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payloadLength, 18);
    local.writeUInt32LE(rawLength, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // 扩展字段长度（mimetype 也必须是 0）
    await write(local);
    await write(name);
    for (const part of payloadParts) await write(part);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    central.writeUInt16LE(20, 4); // 创建者版本
    central.writeUInt16LE(20, 6); // 解压所需版本
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payloadLength, 20);
    central.writeUInt32LE(rawLength, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // 扩展字段
    central.writeUInt16LE(0, 32); // 注释
    central.writeUInt16LE(0, 34); // 起始磁盘号
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE(0, 38); // 外部属性
    central.writeUInt32LE(offset, 42); // 本地头偏移
    centralParts.push(central, name);

    offset += 30 + name.length + payloadLength;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // 目录结尾记录
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  for (const part of centralParts) await write(part);
  await write(end);
  return { bytes: offset + centralSize + 22, count };
}

module.exports = {
  crc32,
  buildZip,
  streamZip,
  entryNameProblem,
  assertEntryName,
  MAX_ENTRY_NAME_BYTES
};
