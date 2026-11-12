// 错误文案脱敏（v0.9 C-4，安全审计 C5）：主进程要把错误回给界面 / 写进诊断日志时，
// 统一走这里，避免把作者本机的绝对路径（`C:\Users\名字\...`、`D:\我的小说\某本书\第3章.txt`）、
// 控制字符、整段正文泄漏到 toast、设置面板或日志里。
//
// 设计约束（来自项目红线）：
// - **纯逻辑**：不 require electron、不读盘、不联网、不抛错；同一个输入永远同一个输出。
// - **只收窄不改写含义**：路径只保留最后一节（作者仍看得出是哪个文件 / 文件夹），
//   错误码原样保留（界面与 E2E 都按 code 分支），常见文件系统错误码额外给一句中文。
// - 日志里的正文遮罩仍由 core/logs.js 负责（连续 24 个以上汉字），这里只管「路径 + 控制字符 + 长度」。
// - URL（`https://…`）不是本机路径，一个字节都不动；相对路径（`0001-第1章.txt`、`sub\x.txt`）也不动。
const PLACEHOLDER = '…';
const MAX_MESSAGE_CHARS = 300;
const MAX_CODE_CHARS = 40;
// 界面文案不比日志，300 字足够说清「哪个文件、为什么」，再长就影响 toast 阅读。
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const CODE_RE = /^[A-Za-z0-9_.-]{1,40}$/;
// `https://…` / `http://…`：外部地址不是本机路径，先切出来保护住再处理其余部分。
const URL_SPLIT_RE = /(https?:\/\/[^\s'"<>「」（）()[\]]+)/i;
const FILE_URL_RE = /file:\/{2,3}[^\s'"<>「」（）()[\]]*/gi;
// 只有「起点」用正则：设备前缀 / UNC 的服务名与共享名首段 / POSIX 的前两段。
// 起点之后的真实结尾统一交给 readPathEnd（含空格判断）：旧的三条「遇空白就断」正则已删除。
const DEVICE_PREFIX_RE = /\\\\\?\\/g;
const UNC_START_RE = /\\\\[^\s'"<>|*?\\]+\\/g;
const POSIX_START_RE = /(^|[\s'"（(「【:：,，;；=])(\/[^\s'"<>|*?/]+\/)/g;
// 盘符路径的**起点**与分段规则（1.6.0 H4 / S-01）：旧口径 `[^\s'"<>|*?]*` 遇到空格就断，
// `C:\Users\Zhang San\Documents\我的小说\书\001-第 1 章.txt` 只会遮住 `C:\Users\Zhang`，
// 后面的用户名 / 书名原样漏进 toast 与日志。现在由 readAbsolutePathEnd() 逐字符走：
// 空格只在「下个词仍像路径的一段」时才并进路径（isPathContinuationToken），
// 正文 / 标点 / 引号照旧在路径结束处停下。
const DRIVE_START_RE = /[A-Za-z]:[\\/]/g;
// 路径里遇到这些字符就结束（不含 ASCII 冒号：栈行 `…\core\storage.js:395:11` 的行号列号要留着）。
const PATH_STOP_CHAR_RE = /[\u0000-\u001f<>|*?'"\[\]{}「」『』（）【】《》，。；：、！？,;=]/;
// 空格之后仍算路径一段的「词」：纯 ASCII 片段（San / 1 / chapter-writer）或带 ASCII 扩展名的片段（第1章.txt）。
const ASCII_PATH_TOKEN_RE = /^[A-Za-z0-9_.~%+-]+$/;
const EXT_PATH_TOKEN_RE = /^[^\s'"<>|*?/\\]+\.[A-Za-z0-9]{1,8}$/;
const TOKEN_STOP_RE = /[\s'"<>|*?\[\]{}「」『』（）【】《》，。；：、！？,;=]/;

// 常见文件系统错误码 → 一句作者看得懂的中文（英文原文只留在本机日志里）。
// 只认 Node / Electron 真实会抛的码；自定义 StorageError 的错误码不在表里，走原文（本来就是中文）。
const FS_CODE_TEXT = Object.freeze({
  ENOENT: '找不到文件或目录',
  EACCES: '没有访问权限',
  EPERM: '操作被系统拒绝（可能是只读文件或权限不足）',
  EBUSY: '文件正被别的程序占用',
  ENOSPC: '磁盘空间不足',
  EROFS: '所在的磁盘是只读的',
  EISDIR: '本来要读文件，却碰到了文件夹',
  ENOTDIR: '路径里有一段不是文件夹',
  EEXIST: '同名文件或文件夹已经存在',
  EMFILE: '打开的文件太多，请重启应用',
  ENFILE: '系统打开的文件太多，请稍后再试',
  ENAMETOOLONG: '文件名或路径太长',
  ELOOP: '路径里有循环的快捷方式',
  UNKNOWN: '系统拒绝了这次操作'
});

function safeString(value) {
  try {
    return String(value == null ? '' : value);
  } catch {
    return '[无法读取的错误信息]';
  }
}

function normalizeKeep(value) {
  const n = Math.round(Number(value));
  // 非法值 / 小于 1 一律按默认（最后一节）：保留 0 节没有实际用途，不支持
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(3, n);
}

// 一个绝对路径 → `…\最后一节`（keep=2 时保留最后两节，栈里的 `core\storage.js` 要这个）。
// 分隔符跟着原路径走（Windows 反斜杠 / POSIX 斜杠）；`..`、空段、盘符根（`C:`）都丢掉，
// 只有盘符根（`C:\`）时收成一个省略号。
function maskPath(raw, keep = 1) {
  const text = safeString(raw);
  const sep = text.includes('\\') ? '\\' : '/';
  const segments = text
    .split(/[\\/]+/)
    .filter((seg) => seg !== '' && seg !== '.' && seg !== '..' && !/^[A-Za-z]:$/.test(seg));
  const kept = keep > 0 ? segments.slice(-keep) : [];
  if (!kept.length) return PLACEHOLDER;
  return `${PLACEHOLDER}${sep}${kept.join(sep)}`;
}

// 路径里的一个「词」：从 text 开头跳过空白，取到下一个空白 / 句法符号为止。
// rest 是这个词之后的原文（下一轮继续判断「空格后面还像不像路径」）。
function nextPathToken(text) {
  let i = 0;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  if (i >= text.length) return null;
  let end = i;
  while (end < text.length && !TOKEN_STOP_RE.test(text[end])) end += 1;
  const token = text.slice(i, end);
  if (!token) return null;
  return { token, rest: text.slice(end) };
}

// 空格后面这个词还算不算同一条盘符路径的一段（1.6.0 H4 / S-01）：
//   · 以下一条绝对路径开头（/ 或 \）→ 不算，那是另一条；
//   · 自带分隔符 / 带 ASCII 扩展名 → 算（`San\Documents`、`章.txt`）；
//   · 纯 ASCII 词（`Zhang`、`1`）→ 只有它后面**还**跟着像路径的一段才算（最多回看 3 个词，避免长句里反复试探）；
//   · 中文正文 / 标点开头的词 → 不算（`打不开`、`后面还有字` 都不应该被吞进路径）。
function isPathContinuationToken(token, rest, depth = 0) {
  if (!token) return false;
  if (token[0] === '/' || token[0] === '\\') return false;
  if (token.includes('\\') || token.includes('/')) return true;
  if (EXT_PATH_TOKEN_RE.test(token)) return true;
  if (!ASCII_PATH_TOKEN_RE.test(token)) return false;
  if (depth >= 3) return false;
  const next = nextPathToken(rest);
  return next ? isPathContinuationToken(next.token, next.rest, depth + 1) : false;
}

// 从某处（`X:\` 之后、`\\?\` 剥掉前缀之后、UNC 的 `\\server\share` 首段之后、POSIX 前两段之后）
// 走到这条路径真正的结尾：空格按 isPathContinuationToken 判断是否并进路径，引号 / 括号 / 中文标点 /
// Windows 禁用字符处结束（ASCII 括号留给 `Program Files (x86)` 这类真实目录名）。四种前缀共用这一份。
function readPathEnd(text, from) {
  let end = from;
  while (end < text.length) {
    const ch = text[end];
    if (PATH_STOP_CHAR_RE.test(ch)) break;
    if (ch === ' ' || ch === '\t') {
      const next = nextPathToken(text.slice(end + 1));
      if (!next || !isPathContinuationToken(next.token, next.rest, 0)) break;
      end += 1;
      continue;
    }
    end += 1;
  }
  return end;
}

// 把文本里所有盘符路径（含空格）统一遮罩。顺序扫描 + 跳过已遮罩区间，
// 输出里的 `…\最后一节` 不会再次命中 DRIVE_START_RE。
function maskAbsolutePaths(text, keep) {
  DRIVE_START_RE.lastIndex = 0;
  let out = '';
  let last = 0;
  let match;
  while ((match = DRIVE_START_RE.exec(text)) !== null) {
    const start = match.index;
    if (start < last) continue;
    const end = readPathEnd(text, start + match[0].length);
    out += text.slice(last, start) + maskPath(text.slice(start, end), keep);
    last = end;
    DRIVE_START_RE.lastIndex = end;
  }
  return out + text.slice(last);
}

// 设备前缀 `\\?\`：剥掉前缀后，剩下的从盘符起交给 readPathEnd（前缀不进 maskPath 的段）。
function maskDevicePaths(text, keep) {
  DEVICE_PREFIX_RE.lastIndex = 0;
  let out = '';
  let last = 0;
  let match;
  while ((match = DEVICE_PREFIX_RE.exec(text)) !== null) {
    const start = match.index;
    if (start < last) continue;
    const from = start + match[0].length;
    const end = readPathEnd(text, from);
    // 只有前缀、后面没有可遮罩的路径时原样留着（与旧 DEVICE_PATH_RE 的「至少一段」口径一致）
    if (end <= from) continue;
    out += text.slice(last, start) + maskPath(text.slice(from, end), keep);
    last = end;
    DEVICE_PREFIX_RE.lastIndex = end;
  }
  return out + text.slice(last);
}

// UNC `\\server\share\…`：起点正则只吃到 `\\server\`，共享名与后面各段（可能含空格）交给 readPathEnd。
function maskUncPaths(text, keep) {
  UNC_START_RE.lastIndex = 0;
  let out = '';
  let last = 0;
  let match;
  while ((match = UNC_START_RE.exec(text)) !== null) {
    const start = match.index;
    if (start < last) continue;
    const end = readPathEnd(text, start + match[0].length);
    out += text.slice(last, start) + maskPath(text.slice(start, end), keep);
    last = end;
    UNC_START_RE.lastIndex = end;
  }
  return out + text.slice(last);
}

// POSIX `/home/user/x`：起点正则要求前面有分隔符且至少两段（避免误伤 `UTF-8 / UTF-16`），
// 之后（可能含空格）交给 readPathEnd；前面的分隔符原样保留。
function maskPosixPaths(text, keep) {
  POSIX_START_RE.lastIndex = 0;
  let out = '';
  let last = 0;
  let match;
  while ((match = POSIX_START_RE.exec(text)) !== null) {
    const lead = match[1];
    const start = match.index + lead.length;
    if (start < last) continue;
    const end = readPathEnd(text, start + match[2].length);
    out += text.slice(last, start) + maskPath(text.slice(start, end), keep);
    last = end;
    POSIX_START_RE.lastIndex = end;
  }
  return out + text.slice(last);
}
function redactInText(text, keep) {
  let out = text;
  // file:///C:/… / file://localhost/C:/…：本地文件的 URL 形式，当作路径处理
  out = out.replace(FILE_URL_RE, (match) =>
    maskPath(match.replace(/^file:\/{2,3}/i, '').replace(/^localhost[\\/]/i, ''), keep)
  );
  // \\?\C:\…：Windows 设备前缀，先剥掉前缀，剩下的整条按 readPathEnd 走（含空格）
  out = maskDevicePaths(out, keep);
  // \\server\share\…：UNC 路径，从 `\\server\` 之后交给 readPathEnd
  out = maskUncPaths(out, keep);
  // C:\… / C:/…（含空格的本机路径整条遮罩，见 maskAbsolutePaths）
  out = maskAbsolutePaths(out, keep);
  // /home/user/x：POSIX 绝对路径（至少两段，前面必须有分隔符，避免误伤 `UTF-8 / UTF-16`）
  out = maskPosixPaths(out, keep);
  return out;
}

// 把文本里所有本机绝对路径收成「…\最后一节」。options.keep = 保留最后几节（默认 1）。
// 不抛错：传 null / 数字 / 对象都返回字符串。
function redactPaths(value, options = {}) {
  const text = safeString(value);
  if (!text) return '';
  const keep = normalizeKeep(options && typeof options === 'object' ? options.keep : undefined);
  // 先把 http(s) URL 切出来不动，剩下的片段才做路径替换
  return text
    .split(URL_SPLIT_RE)
    .map((part, index) => (index % 2 === 1 ? part : redactInText(part, keep)))
    .join('');
}

// 单行、去控制字符、压空白、限长：界面与日志共用的「干净文本」。
function cleanText(value, maxChars = MAX_MESSAGE_CHARS) {
  const limit = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0 ? Math.round(Number(maxChars)) : MAX_MESSAGE_CHARS;
  let text = safeString(value);
  text = text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  text = text.replace(CONTROL_RE, '');
  text = text.replace(/\n+/g, ' ');
  text = text.replace(/\s{2,}/g, ' ').trim();
  if (text.length > limit) {
    const rest = text.length - limit;
    text = `${text.slice(0, limit)}…[已截断 ${rest} 字]`;
  }
  return text;
}

// Node 文件系统错误的 message 形如：
//   ENOENT: no such file or directory, open 'D:\书\001.txt'
//   EPERM: operation not permitted, open 'D:\书\001.txt'
// 只取那个被引起来的路径（脱敏后），拿不到就回空串。
function fsErrorDetail(message) {
  const text = safeString(message);
  const quoted = /'([^']*)'\s*$/.exec(text);
  if (quoted && /[\\/]/.test(quoted[1])) return maskPath(quoted[1], 1);
  const syscall = /,\s*[a-z]+\s+([^\s'"]+)\s*$/.exec(text);
  if (syscall && /[\\/]/.test(syscall[1])) return maskPath(syscall[1], 1);
  return '';
}

function cleanCode(value) {
  const raw = safeString(value).trim();
  if (!raw) return '';
  const clipped = raw.slice(0, MAX_CODE_CHARS);
  return CODE_RE.test(clipped) ? clipped : '';
}

// 没有 err.code 但 message 以 `ENOENT: …` 这种「码 + 冒号」开头时，把码补回来，
// 这样仍然能给出中文提示（Node 的 fs 错误通常自带 code，这里只是兜底）。
function inferCodeFromMessage(message) {
  const match = /^\s*([A-Z][A-Z0-9_]{2,39}):/.exec(safeString(message));
  return match ? match[1] : '';
}

// 给界面看的 { code, message }：错误码原样保留（只做字符白名单），
// 常见文件系统错误码换成中文 + 最后一节文件名，其它错误只做脱敏。
function describeForUi(err) {
  const raw = readRaw(err);
  const code = cleanCode(raw.code) || cleanCode(inferCodeFromMessage(raw.message)) || 'ERROR';
  return { code, message: uiMessage(code, raw.message) };
}

function uiMessage(code, rawMessage) {
  const friendly = FS_CODE_TEXT[code];
  if (friendly) {
    const detail = fsErrorDetail(rawMessage);
    return cleanText(detail ? `${friendly}：${detail}` : friendly);
  }
  const redacted = cleanText(redactPaths(rawMessage));
  return redacted || '未知错误';
}

// B1（审计 E2）：渲染层上报的「后台失败」只收三个短字符串——kind 必须在调用方给的允许集合里
// （白名单由调用方维护，通常是 Set / 数组），code 走字符白名单，message 与界面文案同一套脱敏
// （本机绝对路径只留最后一节、控制字符与超长文本收掉）。**绝不接受正文**：渲染层不传，
// 这里也只把它当一句话处理。形状不合法 / 三个字段都空 → 回 null（上报失败不该反过来干扰渲染层）。
function sanitizeFailureReport(payload, allowedKinds) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const kinds =
    allowedKinds instanceof Set
      ? allowedKinds
      : Array.isArray(allowedKinds)
        ? new Set(allowedKinds)
        : null;
  if (!kinds || !kinds.size) return null;
  const kind = typeof payload.kind === 'string' ? payload.kind.trim() : '';
  if (!kinds.has(kind)) return null;
  const code = cleanCode(payload.code);
  const message = cleanText(redactPaths(payload.message));
  if (!code && !message) return null;
  return { kind, code, message };
}

// 错误对象 → { code, message }（不读 stack，界面用不上）
function readRaw(err) {
  if (err == null) return { code: '', message: '' };
  if (typeof err === 'string') return { code: '', message: err };
  if (typeof err === 'object') {
    let code = '';
    let message = '';
    try {
      code = typeof err.code === 'string' ? err.code : typeof err.code === 'number' ? String(err.code) : '';
    } catch {
      code = '';
    }
    try {
      message = typeof err.message === 'string' ? err.message : safeString(err);
    } catch {
      message = '[无法读取的错误信息]';
    }
    return { code, message };
  }
  return { code: '', message: safeString(err) };
}

module.exports = {
  MAX_MESSAGE_CHARS,
  FS_CODE_TEXT,
  maskPath,
  redactPaths,
  cleanText,
  fsErrorDetail,
  cleanCode,
  describeForUi,
  sanitizeFailureReport
};
