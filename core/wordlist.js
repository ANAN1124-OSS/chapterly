// 词表读取 / 解码共享核心（A1，v1.8.0 WP-30）。
//
// 敏感词预检（core/sensitive.js）与校对词表（core/glossary.js）原来是两份近乎逐字重复的
// 「词表读取流水线」：未配置 → stat 闸门 → 读盘 → 解码（UTF-8 / UTF-16 BOM / GB18030）
// → 二进制 / 坏编码判定 → 行解析 → 公开信息（剥掉词条正文、只留数量）。
// 同一份 txt 在一边能读、另一边报错，就是这么漂移出来的。现在流程只写这一份：
//   · 各模块传进自己的错误码、提示文案、字段名（words / entries）与「每行怎么解析」；
//   · 共享核心只管 IO / 解码 / 回包形状，不内置任何词表，也不认识具体业务。
// 行为契约（与收编前逐字一致，由 tests/wordlist.test.js 的跨模块对照钉住）：
//   · 失败一律返回结构化结果、绝不抛异常；
//   · 空文件 / 超过 4MB / 带 NUL 的二进制 / 解码出 U+FFFD 的坏编码 各有独立错误码；
//   · 公开信息永远不含词条正文，只给数量与状态。
//
// E13（审计修复 #16）：契约里的「绝不抛异常」以前只是约定 —— txt.decodeBuffer / parse 真抛错时
// 整条路径会冒泡到 IPC，一次坏词表就让整次校对失败。现在 decode 与 parse 各自包一层兜底：
// 抛错 = 结构化失败（parseFailed 码 + 文案），调用方照常拿回包、界面照常给提示。
// parseFailed 是可选项：不传时用共享默认（STANDARD_PARSE_FAILED / DEFAULT_PARSE_FAILED_MESSAGE），
// 各模块想给自己的错误码就传 codes.parseFailed / messages.parseFailed。
//
// 纯 Node 模块（主进程 / 单测用），不依赖 Electron。
const fs = require('node:fs/promises');
const path = require('node:path');
const txtLib = require('./txt');
const errorText = require('./error-text');

// 词表文件上限：再大就不像「每行一个词」的词表了，读进来只会拖慢整本检查
const MAX_FILE_BYTES = 4 * 1024 * 1024;

// E13（审计修复 #16）：解码 / 行解析抛错时的共享默认错误码与文案（各模块可覆盖）。
const STANDARD_PARSE_FAILED = 'WORDLIST_PARSE_FAILED';
const DEFAULT_PARSE_FAILED_MESSAGE = '词表内容解析失败（文件可能不是「每行一个词」的纯文本），请检查后重试';

// 生成一份「场景读取器」。options：
//   codes     必填 · { empty, tooBig, badEncoding, notConfigured, missing, unreadable, notFile }
//             可选 · parseFailed（decode / parse 抛错时的错误码，缺省 STANDARD_PARSE_FAILED）
//   messages  必填 · { emptyFile, emptyList, tooBig, binary, badEncoding,
//                      notConfigured, publicEmpty, notFile }
//             可选 · parseFailed（缺省 DEFAULT_PARSE_FAILED_MESSAGE）
//   parse     必填 · (text) => { words | entries, stats }（各模块自己的行解析）
//   field     必填 · 'words' | 'entries'：解析结果的数组字段名，也是回包字段名
//   notConfiguredExtra 可选 · 未配置回包额外带的键（校对词表带 count: 0，敏感词不带）
function createReader(options) {
  const source = options && typeof options === 'object' ? options : {};
  const codes = source.codes && typeof source.codes === 'object' ? source.codes : {};
  const messages = source.messages && typeof source.messages === 'object' ? source.messages : {};
  const field = source.field;
  const parse = source.parse;
  if (field !== 'words' && field !== 'entries') {
    throw new TypeError('core/wordlist.js：field 只认 words / entries');
  }
  if (typeof parse !== 'function') {
    throw new TypeError('core/wordlist.js：缺少 parse(text)');
  }
  const needString = (table, key, label) => {
    const value = table[key];
    if (typeof value !== 'string' || !value) {
      throw new TypeError(`core/wordlist.js：缺少 ${label}.${key}`);
    }
    return value;
  };
  // 创建期就把两份表校验齐（而不是等某条错误路径走到才发现漏了一个码）：
  // 漏一个键的后果是某种坏文件回 `code: undefined`，界面只能显示「未知错误」。
  const CODE_KEYS = ['empty', 'tooBig', 'badEncoding', 'notConfigured', 'missing', 'unreadable', 'notFile'];
  const MESSAGE_KEYS = [
    'emptyFile',
    'emptyList',
    'tooBig',
    'binary',
    'badEncoding',
    'notConfigured',
    'publicEmpty',
    'notFile'
  ];
  for (const key of CODE_KEYS) needString(codes, key, 'codes');
  for (const key of MESSAGE_KEYS) needString(messages, key, 'messages');
  const code = (key) => needString(codes, key, 'codes');
  const message = (key) => needString(messages, key, 'messages');
  // E13（审计修复 #16）：parseFailed 是可选键 —— 没传就用共享默认（不新增必填项，老调用方不受影响）。
  const parseFailedCode =
    typeof codes.parseFailed === 'string' && codes.parseFailed ? codes.parseFailed : STANDARD_PARSE_FAILED;
  const parseFailedMessage =
    typeof messages.parseFailed === 'string' && messages.parseFailed
      ? messages.parseFailed
      : DEFAULT_PARSE_FAILED_MESSAGE;
  const extra = source.notConfiguredExtra && typeof source.notConfiguredExtra === 'object'
    ? { ...source.notConfiguredExtra }
    : {};

  // 词表字节 → { ok, [field], stats } 或 { ok:false, code, message }。
  // 编码复用 txt.decodeBuffer（UTF-8 / UTF-16 BOM / GB18030），并额外识别两种「不是纯文本」：
  // 带 NUL 的二进制、解码出替换字符 U+FFFD 的坏编码。
  function decodeBuffer(buffer) {
    if (!buffer || !buffer.length) {
      return { ok: false, code: code('empty'), message: message('emptyFile') };
    }
    if (buffer.length > MAX_FILE_BYTES) {
      return { ok: false, code: code('tooBig'), message: message('tooBig') };
    }
    const hasUtf16Bom =
      buffer.length >= 2 &&
      ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff));
    if (!hasUtf16Bom && buffer.includes(0)) {
      return { ok: false, code: code('badEncoding'), message: message('binary') };
    }
    // E13（审计修复 #16）：decode / parse 各包一层 —— 两者都是「外部可注入 / 可被病态输入激怒」的
    // 环节（txt.decodeBuffer 走 TextDecoder，parse 是各模块自己的行解析）。真抛错时绝不让它冒泡到
    // IPC，回一份和其它失败同形状的结构化结果（调用方 / 界面不用为它写第二条分支）。
    let text;
    try {
      text = txtLib.decodeBuffer(buffer);
    } catch {
      return { ok: false, code: parseFailedCode, message: parseFailedMessage };
    }
    if (typeof text !== 'string') {
      return { ok: false, code: parseFailedCode, message: parseFailedMessage };
    }
    if (text.includes('\uFFFD')) {
      return { ok: false, code: code('badEncoding'), message: message('badEncoding') };
    }
    let parsed;
    try {
      parsed = parse(text);
    } catch {
      return { ok: false, code: parseFailedCode, message: parseFailedMessage };
    }
    const items = parsed && Array.isArray(parsed[field]) ? parsed[field] : [];
    if (!items.length) {
      return { ok: false, code: code('empty'), message: message('emptyList') };
    }
    return { ok: true, [field]: items, stats: parsed.stats };
  }

  // 读文件失败的两类回包（stat / open 共用一份文案，避免两处漂移）
  function readFailure(base, resolved, err) {
    const missing = err && err.code === 'ENOENT';
    return {
      ...base,
      ok: false,
      code: missing ? code('missing') : code('unreadable'),
      message: missing
        ? `词表文件不存在：${errorText.maskPath(resolved)}（可能被移动或删除了，请重新选择）`
        : `读不了词表文件：${errorText.describeForUi(err).message}`
    };
  }

  // 读词表文件（只读）。任何失败都返回结构化结果，由界面给出明确提示，不抛异常。
  async function readFile(filePath) {
    const rawPath = typeof filePath === 'string' ? filePath.trim() : '';
    if (!rawPath) {
      return {
        ok: false,
        configured: false,
        code: code('notConfigured'),
        message: message('notConfigured'),
        path: '',
        name: '',
        ...extra
      };
    }
    const resolved = path.resolve(rawPath);
    const base = { configured: true, path: resolved, name: path.basename(resolved) };
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch (err) {
      return readFailure(base, resolved, err);
    }
    if (!stat.isFile()) {
      return { ...base, ok: false, code: code('notFile'), message: message('notFile') };
    }
    let buffer;
    try {
      // 审计修复 #45（S8）：大小闸门与读盘绑在同一个句柄上。旧实现 stat 之后按路径 readFile，
      // 间隙里文件被换成大文件（云同步 / 外部工具）就整份读进内存，绕过 4 MB 上限；
      // 现在 open → fstat → 从同一句柄读，闸门看到的和读到的是同一份文件。
      const handle = await fs.open(resolved, 'r');
      try {
        const fresh = await handle.stat();
        if (fresh.size > MAX_FILE_BYTES) {
          return {
            ...base,
            ok: false,
            size: fresh.size,
            code: code('tooBig'),
            message: message('tooBig')
          };
        }
        buffer = await handle.readFile();
      } finally {
        try {
          await handle.close();
        } catch { /* 关不掉不影响读到的内容 */ }
      }
    } catch (err) {
      return readFailure(base, resolved, err);
    }
    const decoded = decodeBuffer(buffer);
    if (!decoded.ok) return { ...base, size: stat.size, ...decoded };
    return { ...base, ok: true, size: stat.size, [field]: decoded[field], stats: decoded.stats };
  }

  // 只给渲染层的词表信息：绝不把词条正文（field）带过去，界面只需要数量与状态。
  function publicInfo(list) {
    if (!list || typeof list !== 'object') {
      return {
        ok: false,
        configured: false,
        code: code('notConfigured'),
        message: message('publicEmpty'),
        path: '',
        name: '',
        ...extra,
        count: 0
      };
    }
    const rest = {};
    for (const [key, value] of Object.entries(list)) {
      if (key === field) continue;
      rest[key] = value;
    }
    return { ...rest, count: Array.isArray(list[field]) ? list[field].length : 0 };
  }

  return { decodeBuffer, readFile, publicInfo };
}

module.exports = {
  MAX_FILE_BYTES,
  createReader
};