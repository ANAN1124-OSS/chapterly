// 渲染层能塞进来的「路径类参数」的统一校验（v0.9 C-2，IPC 路径入口审计）。
// 绝大多数是纯逻辑：不 require electron、不读盘、不写盘；唯一读盘的是 S3 补的
// assertRealBookPath（realpath 复核，见函数上方说明）。
//
// 安全模型：渲染层没有 Node / fs，所有文件操作都在主进程做（见 preload.js 白名单）。
// 所以「渲染层传上来的一串字符」绝不能直接当路径用。全部 90 个 IPC 频道里带路径的入口只能是两类：
//   1. 书架里的书：main.js 用 handleBook 注册，第一参数统一过 assertBookPath——
//      只有「书架目录的直接子目录」合法，`..`、绝对路径、孙目录、空串都会被拒（BAD_PATH）；
//   2. 非书架的路径（历史备份 / 碎片 / 字体 / 导入）：各自有显式校验，即本模块的
//      importSourceDirs 与 core/history.js 的 resolveGroup / resolveHistoryPath、
//      core/fragments.js 的 assertFragmentName、core/font-policy.js 的 resolveFontSource。
// 本模块只收「以前写在 main.js 里、单测碰不到」的那两条，方便钉住。
//
// 路径口径（2026-11-06 v0.13 C3 拍板「支持联接书库」；2026-11-22 三审 S3 补一道 realpath 复核）：
//   · 书库**根目录**是目录联接照常可用（两边都 realpath 后再比），回归 tests/junction-library.test.js；
//   · 书文件夹本身是符号链接 / 目录联接**指到库外**时，文本判定拦不住 → 入口由 assertRealBookPath
//     拒绝（BAD_PATH；要本机用户自己先造出这种链接才触发，属纵深收窄）；
//   · 同一物理书库用两个不同路径名打开时仍会被当成两本（身份按字面路径判，不折叠成真实路径）；
//   · config:set 里 booksRoot / 两份词表路径已由 core/config-gate.js 做「来源校验」（v0.9 C-2b，
//     只认主进程自己弹出的对话框刚选中的路径），不再是残余风险。
const path = require('node:path');
const fsp = require('node:fs/promises');
const pathUtils = require('./path-utils');

class IpcPathError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IpcPathError';
    this.code = code;
  }
}

// 书架里的书：必须是书架目录（booksRoot）的直接子目录。
// 说明：先 resolve 再比 dirname，所以 'D:\书架\某本\..\..\Windows'、'D:\书架\某本\子目录'、
// 'D:\书架' 自己、空串 / null / 数字都会被拒；「same directory」判定走 core/path-utils.js 的 pathKey
// （resolve + 小写 + Windows 正反斜杠归一，A9 / v1.8.0 WP-31），不再手写小写比较。
// 书架目录空着时必须直接报错 —— 空 root 会 resolve 成进程 cwd，绝不能让「没设置书架」悄悄变成
// 「当前目录就是书架」（失败也要往关的方向失败）。
// 返回值是 resolve 后的绝对路径（调用方直接用它，不要再用原始字符串）。
function assertBookPath(bookPath, booksRoot) {
  const rawRoot = String(booksRoot == null ? '' : booksRoot).trim();
  if (!rawRoot) throw new IpcPathError('BAD_PATH', '书架目录还没有设置');
  const root = path.resolve(rawRoot);
  // 两端空白一律清掉：配置文件里的路径本来就按 trim 存（和 core/config.js 的口径一致），
  // 带上空白的串如果直接 path.resolve，会被当成以空格开头的相对路径，校验结果变得莫名其妙。
  const target = path.resolve(String(bookPath == null ? '' : bookPath).trim());
  if (pathUtils.pathKey(path.dirname(target)) !== pathUtils.pathKey(root)) {
    throw new IpcPathError('BAD_PATH', '只能操作书架目录下的书');
  }
  return target;
}

// S3（一轮·低）：书目录的 realpath 复核（纵深）；assertBookPath 是纯文本判定，拦不住
// 「书架里预先存在的目录联接 / 符号链接指到库外」——只有本机用户能造出这种链接，非远程面，
// 但渲染层被注入时可以把应用当跳板读写库外文件，值得在入口挡一层。
// 口径（与 v0.13 U-C3「支持目录联接书库」的拍板不冲突）：
//   · 书库**根本身**是目录联接照常可用：两边都 realpath 后再比（根解析成真实目录、书也跟着解析），
//     这正是联接书库的正常场景；联接路径按字面判身份（normalizePath / assertBookPath）不变。
//   · 网络盘 / UNC 路径照常：不做路径形状判断，realpath 对合法共享路径返回其本身即通过。
//   · **失败即放行**：realpath 解析不出来（书还没建 / 目录刚被删 / 权限异常 / 网络盘临时离线）
//     一律不拦 —— 这一层只收窄「解析得出真实路径、且确实指向库外」的情形，
//     绝不把正常读写挡在门外（后续读盘失败会照常报错）。
// 返回 resolve 后的书路径（与 assertBookPath 同形），越界抛 BAD_PATH。
async function assertRealBookPath(bookPath, booksRoot) {
  const rawRoot = String(booksRoot == null ? '' : booksRoot).trim();
  const rawBook = String(bookPath == null ? '' : bookPath).trim();
  // 根为空 / 书路径为空：由 assertBookPath 负责报错，这里不重复判。
  if (!rawRoot || !rawBook) return String(bookPath == null ? '' : bookPath);
  const realpathOrNull = async (target) => {
    try {
      return await fsp.realpath(target);
    } catch {
      return null;
    }
  };
  const [realRoot, realBook] = await Promise.all([realpathOrNull(rawRoot), realpathOrNull(rawBook)]);
  if (!realRoot || !realBook) return String(bookPath == null ? '' : bookPath);
  const rootKey = pathUtils.pathKey(realRoot);
  const bookKey = pathUtils.pathKey(realBook);
  if (bookKey === rootKey) return String(bookPath == null ? '' : bookPath);
  const prefix = rootKey.endsWith(path.sep) ? rootKey : rootKey + path.sep;
  if (bookKey.startsWith(prefix)) return String(bookPath == null ? '' : bookPath);
  throw new IpcPathError(
    'BAD_PATH',
    '这本书指向书架目录之外的位置（目录联接 / 符号链接），已拒绝打开；请把书放回书架目录，或换一个书架目录'
  );
}

// 导入小说的来源目录：唯一正当来源是主进程弹的系统对话框（properties: ['openDirectory']）。// 渲染层还能传 explicitPaths（自检 / 截图批量导入用），但只在 automation 模式下认——
// 否则被注入的脚本就能让主进程把任意文件夹（桌面、别的盘、D:\我的小说）复制进书架。
// 返回 resolve 后的绝对路径数组；没有显式路径时返回空数组（调用方退回系统对话框）。
function importSourceDirs(rawPaths, options = {}) {
  const list = Array.isArray(rawPaths) ? rawPaths : [];
  const dirs = list
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => path.resolve(item.trim()));
  if (!dirs.length) return [];
  if (options.allowExplicit !== true) {
    throw new IpcPathError('BAD_IMPORT_PATH', '导入目录只能通过系统对话框选择');
  }
  return dirs;
}

module.exports = {
  IpcPathError,
  assertBookPath,
  // S3（一轮·低）：realpath 复核（唯一读盘的一个 —— 其余都是纯文本判定）
  assertRealBookPath,
  importSourceDirs
};
