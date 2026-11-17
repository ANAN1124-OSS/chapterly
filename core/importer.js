// 导入小说：把外部文件夹 / txt 文件变成书架里的一本书或多本书。
// 支持三种来源：
//   1) 现成的章回书（含合法 书目.json）→ 整本复制
//   2) 一本书的章节目录（txt 文件名形如 001-xxx.txt / 001.txt / 第一章 xxx.txt）→ 复制后重建书目
//   3) 一堆独立小说 txt（每个 txt 是一整本小说，来自同一个收藏夹文件夹）
//      → 每个 txt 导入成一本书
//        mode='chapters'（默认）：按原文的章节标题切开，章名和正文都保持原文，一字不改
//        mode='raw'：整本作为一章「全文」，UTF-8 源文件按字节原样复制
//        mode='split'（旧版自动分章，保留兼容）：按标题行拆分并重新编号
// 只复制、不移动源文件；文件夹重名自动加 -2/-3。
const fs = require('node:fs/promises');
const path = require('node:path');
const heading = require('./heading');
const chaptersLib = require('./chapters');
const storage = require('./storage');
const repair = require('./repair');
const {
  decodeBufferWithEncoding,
  detectBomlessUtf16,
  splitChapters,
  splitChaptersRaw,
  splitLongUntitled,
  LONG_UNTITLED_THRESHOLD
} = require('./txt');
const { normalizeText, formatByteSize, MAX_TEXT_BYTES } = require('./common');
const pathUtils = require('./path-utils');
const errorText = require('./error-text');

// 审计修复 #13（E9）：章节目录的「文件名像章节」判定不再手抄词表 —— 数字 / 单位 / 关键词
// （楔子 / 序章 / 番外 / Chapter N）全部取 core/heading.js 的 import 场景，与 core/txt.js 的切分
// 同一套。旧实现把词表写死成 [0-9零〇一二三四五六七八九十百千万两] + [章节回卷集篇部]，结果是：
//   · 「第 1 话.txt」「第 3 幕.txt」不算章节文件（词表里没有 话 / 幕），章节目录被拆成一堆独立小说；
//   · 纯数字名（001.txt）因为要求序号后必须跟分隔符而不匹配，同理整目录按 novels 导入。
// 纯数字名单独一条：带前导零的任意位数（001 / 0001），或 1–3 位（1 / 12 / 123）。
// 1984.txt 这类「年份 / 纯数字书名」按独立小说处理 —— 前导零 / 短序号才是章节序号的写法。
const CHAPTER_TITLE_RE = heading.anchorRe('import');
const CHAPTER_SEQ_RE = /^\s*\d+\s*[-_.、\s]/;
const CHAPTER_PURE_NUMBER_RE = /^\s*(?:0\d+|\d{1,3})\s*$/;

// C30（v1.8.0 WP-26）：判「在不在书架目录里」走 core/path-utils 的 normalizePath（resolve +
// 小写），与 core/storage.js 的 assertInside / assertBookPath 同一口径。旧实现逐字 startsWith：
// Windows 上大小写不同的同一目录会绕过「已经在书架里 / 不能导入上级」两道守卫。
function isInside(parent, child) {
  const p = pathUtils.normalizePath(parent);
  const c = pathUtils.normalizePath(child);
  if (!p || !c) return false;
  return c === p || c.startsWith(`${p}${path.sep}`);
}

// V57（1.7.2 D3）：章节文件与超限文件都按「相对书目录的路径」比较 —— 用 basename 会把
// 同名不同目录的另一个文件一起判成丢失（子目录里的章被删掉 / 整源被误判成「全部超限」）。
// Windows 上大小写与正反斜杠都归一，其余平台保持逐字比较。
function relativeKey(relativePath) {
  const normalized = path.normalize(String(relativePath || ''));
  return path.sep === '\\' ? normalized.toLowerCase() : normalized;
}

// V69（1.7.2 D3）：回给渲染层的来源只用最后一段（相对名），作者本机的绝对路径
// （盘符 / 用户目录）不出主进程。拿不到最后一段（盘符根等）时回省略号，绝不回退成绝对路径。
function relativeSourceLabel(sourceDir) {
  return path.basename(String(sourceDir || '')) || '…';
}

async function isDirectory(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

// V106（v1.8.0 WP-21）：导入文件夹撞名后缀的硬上限，与 core/chapters.js 的 MAX_NAME_SUFFIX 同口径。
// 以前是 `for (;;)` 线性探测：同名书极多时要做 O(n²) 次 stat，理论上不可终止（exists 永远为真）。
// 现在 `-2` … `-999` 用完仍撞名就抛 BAD_PATH（错误码与章节撞名一致，文案由 error-text 脱敏后给界面）。
const MAX_FOLDER_SUFFIX = 999;

// 目标文件夹名（安全名）的唯一实现：uniqueFolderName 用它做 base，导入暂存层也用它建「书目录」
// （repair.rebuildFromFiles 的 title 取 basename(bookPath)，暂存层目录名必须是书名，不能是 .import-…）。
function safeFolderName(desired) {
  return chaptersLib.safeName(desired) || '导入的书';
}

// 「这次导入最终会叫什么」：现成书形态用书目标题（缺省来源文件夹名），其余形态用来源文件夹名。
// IPC 的跨窗口预检与真正的导入必须用同一份口径（见 importFolders 的 guardTarget）。
function desiredFolderName(sourceDir, analysis) {
  return analysis.kind === 'book' ? analysis.meta.title || path.basename(sourceDir) : path.basename(sourceDir);
}

// maxSuffix 可注入：单测不必真造 999 个文件夹，也能钉住「撞满上限就明确报错、绝不无限循环」。
async function uniqueFolderName(booksRoot, desired, { maxSuffix = MAX_FOLDER_SUFFIX } = {}) {
  const base = safeFolderName(desired);
  let candidate = base;
  if (!(await storage.exists(path.join(booksRoot, candidate)))) return candidate;
  for (let i = 2; i <= maxSuffix; i += 1) {
    candidate = `${base}-${i}`;
    if (!(await storage.exists(path.join(booksRoot, candidate)))) return candidate;
  }
  throw new storage.StorageError(
    'BAD_PATH',
    `同名书文件夹太多（已试到第 ${maxSuffix} 个后缀），请先把已有书名改短，或整理书架里的文件夹`
  );
}

// ---------- WP7（X-N2）：暂存 + 原子 rename 提交 ----------
// 审计 #22 的缺陷：book / chapter-folder 形态以前直接往正式书目录 fs.cp，失败还 fs.rm(正式目标)。
// 两个窗口并发导入同名来源时双方探测都空闲 → 同名内容互相合并（丢章），任一方失败还会删掉
// 另一方已复制进同一目录的内容。现在与 importNovelFile 统一：先写书架根下的隐藏暂存目录，
// 写完再 fs.rename 成正式目录；rename 是原子的，撞名（另一个窗口抢先提交）就换下一个后缀重试，
// 失败只清自己的暂存 —— 绝不触碰正式目录里别人的东西。
const STAGING_PREFIX = '.import-';
// 并发撞名重试上限：正常最多被抢 1–2 次；连续 8 次说明环境异常，明确报错让作者重试，绝不无限循环。
const MAX_COMMIT_ATTEMPTS = 8;
const MAX_STAGING_ATTEMPTS = 3;

// 建随机隐藏暂存根（书架扫描不看 . 开头的目录；崩溃残留由 cleanupStaleStaging 1 小时后回收）。
// 名字含 pid + 时间 + 随机数：撞名直接失败 / 重试，绝不复用别人的暂存目录。
async function createStagingRoot(booksRoot) {
  await fs.mkdir(booksRoot, { recursive: true });
  for (let attempt = 0; attempt < MAX_STAGING_ATTEMPTS; attempt += 1) {
    const name = `${STAGING_PREFIX}${process.pid}-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const dir = path.join(booksRoot, name);
    try {
      await fs.mkdir(dir);
      return dir;
    } catch (err) {
      if (err && err.code !== 'EEXIST') throw err;
    }
  }
  throw new storage.StorageError('IMPORT_FAILED', '导入暂存目录创建失败（同名目录反复被占用），请重试');
}

// 把写好的暂存目录一次性改名成正式书目录：
//   · 先用 uniqueFolderName 解析目标名（重名 → -2 / -3 …）；
//   · rename 失败但目标已存在 = 另一个窗口刚提交了同名书 → 重新探测下一个空闲后缀再试；
//   · 目标不存在 = 真错误（EPERM / ENOSPC …），原样上抛，不掩盖；
//   · 重试 maxAttempts 次仍撞名 → BAD_PATH（有界，不无限探测）。
// resolveFolder 只给单测注入（钉「重试用尽」）；产品路径一律走 uniqueFolderName。
async function commitStagedFolder(booksRoot, staging, desiredFolder, options = {}) {
  const maxAttempts =
    Number.isFinite(options.maxAttempts) && options.maxAttempts > 0
      ? Math.floor(options.maxAttempts)
      : MAX_COMMIT_ATTEMPTS;
  const resolveFolder = typeof options.resolveFolder === 'function' ? options.resolveFolder : null;
  const nextFolder = async (attempt) => {
    const folder = resolveFolder ? await resolveFolder(attempt) : await uniqueFolderName(booksRoot, desiredFolder);
    if (typeof folder !== 'string' || !folder) {
      throw new storage.StorageError('BAD_PATH', '导入目标文件夹名无效，没有提交');
    }
    return folder;
  };
  let folder = await nextFolder(1);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const target = path.join(booksRoot, folder);
    try {
      await fs.rename(staging, target);
      return { folder, path: target };
    } catch (err) {
      // Windows：rename 到已存在目录 → EPERM / EEXIST；POSIX：ENOTEMPTY。目标仍在才当撞名重试，
      // 目标不在（权限 / 盘错误）原样上抛 —— 不把「没写进去」伪装成「撞名」。
      if (!(await storage.exists(target))) throw err;
      if (attempt === maxAttempts) break;
      folder = await nextFolder(attempt + 1);
    }
  }
  throw new storage.StorageError(
    'BAD_PATH',
    `导入时同名书文件夹反复被占用（已重试 ${maxAttempts} 次），请稍后再试`
  );
}

// 文件名看起来像「一本书的章节文件」（001-xxx.txt / 第一章 xxx.txt / 001.txt），而不是一本完整小说
function looksLikeChapterFile(fileName) {
  const base = String(fileName || '').replace(/\.txt$/i, '');
  return (
    CHAPTER_PURE_NUMBER_RE.test(base) || CHAPTER_SEQ_RE.test(base) || CHAPTER_TITLE_RE.test(base)
  );
}

async function analyzeSource(sourceDir) {
  const txtFiles = await storage.listTxtFiles(sourceDir).catch(() => []);
  try {
    const meta = await storage.readBookMeta(sourceDir);
    return { kind: 'book', meta, txtFiles };
  } catch (err) {
    if (!txtFiles.length) return { kind: 'nothing', reason: err.message };
    if (txtFiles.length === 1) {
      // 只有一个 txt：文件名像章节（001-xxx.txt）就当「一本书的章节目录」，
      // 否则当成一本完整的独立小说（例如「书名 - 作者.txt」）
      return looksLikeChapterFile(txtFiles[0])
        ? { kind: 'chapter-folder', txtFiles, reason: err.message }
        : { kind: 'novels', files: txtFiles, reason: err.message };
    }
    const chapterLike = txtFiles.filter(looksLikeChapterFile).length;
    if (chapterLike >= Math.ceil(txtFiles.length * 0.6)) {
      return { kind: 'chapter-folder', txtFiles, reason: err.message };
    }
    return { kind: 'novels', files: txtFiles, reason: err.message };
  }
}

// V25（1.6.1 R2）：文件夹形态导入以前只做「原样复制」，绕过了单本 txt 的 128 MB 闸门，
// 129 MB 的畸形 txt 会被整个抄进书库。复制前逐 txt 取大小过闸门：超限的单个文件跳过、
// 记进结果，其余文件照常导入（不中断整次导入）。
// V57（1.7.2 D3）：清单由调用方给 —— 现成书形态传 listTxtFilesDeep() 的递归清单（fs.cp 递归复制），
// 章节目录形态仍只传顶层清单（copyAsTexts 也只复制顶层）。
async function collectOversizedTxt(sourceDir, txtFiles) {
  const oversized = [];
  for (const file of txtFiles || []) {
    // 拿不到大小（符号链接断开等）不在这里拦，交给后面的复制 / 重建如实报错
    const stat = await fs.stat(path.join(sourceDir, file)).catch(() => null);
    if (!stat) continue;
    const problem = importSizeProblem(stat.size, path.basename(file, path.extname(file)));
    if (problem) oversized.push({ file, code: problem.code, message: problem.message });
  }
  return oversized;
}

// V57（1.7.2 D3）：现成书形态是 fs.cp 递归整目录复制，子目录里的 .txt 也在复制范围内，
// 所以大小闸门必须递归看一遍（否则子目录里的 129 MB txt 绕过闸门被整个抄进书库）。
// 排除口径与 copyAsBook 的 filter 一致（`_trash` / `.` 前缀不进），只认 .txt（与
// storage.listTxtFiles 同一条规则），不跟符号链接目录（避免环形链接把扫描拖死）。
// V116（v1.8.0 WP-29）：递归改「迭代队列 + 每批 6 个目录并发 readdir」——深目录树不再一层层
// 串行等盘；排除规则、连通性（读不出的子树直接跳过）与最终排序（zh-Hans-CN 升序）逐项不变。
const LIST_DIR_CONCURRENCY = 6;

async function listTxtFilesDeep(dir, prefix = '') {
  const found = [];
  const queue = [{ dir, prefix: prefix || '' }];
  while (queue.length) {
    const batch = queue.splice(0, LIST_DIR_CONCURRENCY);
    const listings = await Promise.all(
      batch.map(async (item) => {
        let entries;
        try {
          entries = await fs.readdir(item.dir, { withFileTypes: true });
        } catch {
          return null;
        }
        const nextDirs = [];
        const files = [];
        for (const entry of entries) {
          if (entry.name === storage.TRASH_DIR || entry.name.startsWith('.')) continue;
          const rel = item.prefix ? path.join(item.prefix, entry.name) : entry.name;
          if (entry.isDirectory()) {
            nextDirs.push({ dir: path.join(item.dir, entry.name), prefix: rel });
          } else if (entry.isFile() && /\.txt$/i.test(entry.name)) {
            files.push(rel);
          }
        }
        return { nextDirs, files };
      })
    );
    for (const listing of listings) {
      if (!listing) continue;
      for (const file of listing.files) found.push(file);
      for (const next of listing.nextDirs) queue.push(next);
    }
  }
  return found.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

// 审计修复 #56（S7）：导入不跟随符号链接（含 Windows 目录联接）。
// 现成书形态是 fs.cp 整目录复制：链接会被原样抄进书库 —— 链接指向的 txt 不经过 128 MB 闸门
// （listTxtFilesDeep 只认 isFile），之后读章又跟随链接读到书库外；链接目录还能把任意大目录带进来。
// 复制前扫一遍来源，有任何链接就整源跳过并说明原因（让作者换成真实文件 / 目录再导入）。
// 扫描只用于提示，最多记 MAX_SOURCE_LINKS 条，坏目录树不会把扫描拖死。
// 边界（审计残留修复 #R18 / #56-S7）：扫描 → fs.cp 是两趟，两趟之间新建的链接仍会被复制进去 ——
// 这是「先扫后复制」方案的固有 TOCTOU。来源是作者本机选的文件夹、导入又受 automation 闸门限制，
// 再扫一次只缩小窗口不能消除；想彻底关闭得改成逐条复制 + 复制时校验，代价与收益不成比例，
// 故这里只如实注明，不加第二趟扫描。
const MAX_SOURCE_LINKS = 100;

async function listSourceLinks(dir, prefix = '') {
  const links = [];
  const queue = [{ dir, prefix: prefix || '' }];
  while (queue.length && links.length < MAX_SOURCE_LINKS) {
    const item = queue.shift();
    let entries;
    try {
      entries = await fs.readdir(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === storage.TRASH_DIR || entry.name.startsWith('.')) continue;
      const rel = item.prefix ? path.join(item.prefix, entry.name) : entry.name;
      if (entry.isSymbolicLink()) {
        links.push(rel);
        if (links.length >= MAX_SOURCE_LINKS) break;
        continue;
      }
      if (entry.isDirectory()) queue.push({ dir: path.join(item.dir, entry.name), prefix: rel });
    }
  }
  return links;
}

// V45（1.7.2 D3）：导入结果的「跳过」只留一套表示 —— skipped 数组，每条
// { source(相对名), reason, code, tooLarge }。以前同一件事写三份（顶层 skipped[] /
// 结果上的 skippedFiles / 结果上的 skippedTooLarge 计数），三处各取一份才对得上。
// 没有超限文件时字段不出现：imported / kind / folder / path / title / chapters 语义不变。
function withSkippedEntries(result, oversized) {
  if (!oversized.length) return result;
  return {
    ...result,
    skipped: oversized.map((entry) => ({
      source: entry.file,
      reason: entry.message,
      code: entry.code,
      tooLarge: true
    }))
  };
}

async function copyAsBook(sourceDir, target, oversized) {
  const skip = new Set((oversized || []).map((entry) => path.resolve(sourceDir, entry.file)));
  await fs.cp(sourceDir, target, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      if (base === storage.TRASH_DIR || base.startsWith('.')) return false;
      return !skip.has(path.resolve(src));
    }
  });
}

async function copyAsTexts(sourceDir, target, txtFiles, oversized) {
  await fs.mkdir(target, { recursive: true });
  const skip = new Set((oversized || []).map((entry) => entry.file));
  for (const file of txtFiles) {
    if (skip.has(file)) continue;
    await fs.copyFile(path.join(sourceDir, file), path.join(target, file));
  }
}

// 现成的书 / 一本书的章节目录
async function importBookFolder(booksRoot, sourceDir, analysis) {
  const desiredFolder = desiredFolderName(sourceDir, analysis);

  // 审计修复 #56（S7）：整目录复制前先扫符号链接 / 目录联接；有链接就整源跳过（见 listSourceLinks）。
  // 审计残留修复 #R18：扫描与下面的 copyAsBook 是两趟，两趟之间新建的链接仍会被复制 —— 固有 TOCTOU，
  // 口径见 listSourceLinks 上方的边界说明。这些闸门是「跳过」语义：错误码原样上抛，由 importFolders
  // 记进 skipped（不包成 IMPORT_FAILED —— 否则界面文案会从「…已跳过」变成「复制失败：…」）。
  if (analysis.kind === 'book') {
    const links = await listSourceLinks(sourceDir);
    if (links.length) {
      const sample =
        links.slice(0, 3).join('、') + (links.length > 3 ? ` 等 ${links.length} 个` : '');
      throw new storage.StorageError(
        'SOURCE_LINK',
        `《${path.basename(sourceDir)}》里含符号链接 / 目录联接（${sample}），导入不跟随链接` +
          `（会绕过单本 ${formatImportSize(MAX_IMPORT_BYTES)} 上限、把书库外的内容带进来），已跳过；` +
          '请把链接换成真实文件 / 目录后重试'
      );
    }
  }
  // V57：现成书整目录 fs.cp 递归复制 → 闸门看递归清单；章节目录形态只复制顶层 txt → 只看顶层
  const gateFiles = analysis.kind === 'book' ? await listTxtFilesDeep(sourceDir) : analysis.txtFiles;
  const oversized = await collectOversizedTxt(sourceDir, gateFiles);
  // V57：按相对路径（不是 basename）判「哪一章会丢」，同名的其它目录章不被连坐
  const oversizedKeys = new Set(oversized.map((entry) => relativeKey(entry.file)));
  const willLose =
    analysis.kind === 'book'
      ? analysis.meta.chapters.filter((chapter) => oversizedKeys.has(relativeKey(chapter.file))).length
      : oversized.length;
  const totalTxt = analysis.kind === 'book' ? analysis.meta.chapters.length : analysis.txtFiles.length;
  if (totalTxt > 0 && willLose >= totalTxt) {
    // 一个能导入的文件都不剩：当成这次来源失败（整批照常继续），不留一本空书
    throw new storage.StorageError(
      'FILE_TOO_LARGE',
      `《${path.basename(sourceDir)}》里的文件全部超过单本导入上限 ${formatImportSize(MAX_IMPORT_BYTES)}，已跳过`
    );
  }

  // 审计 WP7（X-N2）：复制 / 重建书目 / 超限章节裁剪全部在隐藏暂存目录里做，正式书目录只由
  // commitStagedFolder 的一次 rename 产生 —— 并发同名导入不会合并，失败也只清自己的暂存。
  let stagingRoot = null;
  try {
    stagingRoot = await createStagingRoot(booksRoot);
    // 暂存层的「书目录」名字 = 目标安全名：repair.rebuildFromFiles 的 title 取 basename，
    // 这样重建出来的书目标题就是书名，不是 .import-… 临时名。
    const staging = path.join(stagingRoot, safeFolderName(desiredFolder));

    if (analysis.kind === 'book') {
      await copyAsBook(sourceDir, staging, oversized);
      let meta = await storage.readBookMeta(staging);
      if (oversized.length) {
        // 超限章节根本没复制进来：书目只保留真实存在的章节，不留下打不开的悬挂章节
        const dropped = new Set(oversized.map((entry) => relativeKey(entry.file)));
        const kept = meta.chapters.filter((chapter) => !dropped.has(relativeKey(chapter.file)));
        if (kept.length !== meta.chapters.length) {
          const lastOpenChapterId = kept.some((c) => c.id === meta.lastOpenChapterId)
            ? meta.lastOpenChapterId
            : kept[0].id;
          meta = await storage.writeBookMeta(
            staging,
            { ...meta, chapters: kept, lastOpenChapterId },
            { structural: true }
          );
        }
      }
      const committed = await commitStagedFolder(booksRoot, staging, desiredFolder);
      return withSkippedEntries(
        {
          imported: true,
          kind: 'book',
          folder: committed.folder,
          path: committed.path,
          title: meta.title,
          chapters: meta.chapters.length
        },
        oversized
      );
    }

    await copyAsTexts(sourceDir, staging, analysis.txtFiles, oversized);
    const rebuilt = await repair.rebuildFromFiles(staging);
    const committed = await commitStagedFolder(booksRoot, staging, desiredFolder);
    let title = rebuilt.meta.title;
    if (title !== committed.folder) {
      // 撞名后缀变了（另一次并发导入抢先提交）：沿用「书目标题 = 实际文件夹名」的旧行为。
      // 书内容此时已经完整发布；标题同步失败只影响显示名，不把一次成功的导入报成失败。
      title = await storage
        .writeBookMeta(committed.path, { ...rebuilt.meta, title: committed.folder })
        .then(() => committed.folder)
        .catch(() => rebuilt.meta.title);
    }
    return withSkippedEntries(
      {
        imported: true,
        kind: 'chapter-folder',
        folder: committed.folder,
        path: committed.path,
        title,
        chapters: rebuilt.meta.chapters.length
      },
      oversized
    );
  } catch (err) {
    // V50：「一个能导入的文件都不剩」是跳过，不是复制失败 —— 包成 IMPORT_FAILED 会把界面文案
    // 从「…已跳过」改成「复制失败：…」并把错误码一起丢掉。这里原样放行，由 importFolders 记进 skipped。
    // 审计修复 #56（S7）：含符号链接的来源同理（SOURCE_LINK 也是「跳过」，不是复制失败）。
    if (err && (err.code === 'FILE_TOO_LARGE' || err.code === 'SOURCE_LINK' || err.code === 'IMPORT_FAILED')) throw err;
    throw new storage.StorageError('IMPORT_FAILED', `复制失败：${errorText.describeForUi(err).message}`);
  } finally {
    // 只清自己的暂存根：成功时里面已经空了（书目录被 rename 走），失败时连半成品一起清。
    // 绝不再 fs.rm(正式目标) —— 那个目录可能属于另一个窗口刚提交的同名书。
    if (stagingRoot) await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}

// 导入边界（v0.9 C-3，安全审计 C6）：单本 txt 是「整个读进内存 → 解码 → 切章」，
// 所以先按文件大小设一道闸门：1000 万字中文小说约 30 MB，128 MB 有三倍以上余量；
// 再大的文件大概率不是小说，读进来会把主进程内存打爆（渲染层只发个 IPC，崩的是主进程）。
// A3（v1.8.0 WP-31）：上限与体量文案收编到 core/common.js（MAX_TEXT_BYTES / formatByteSize），
// 与 core/storage.js 的章节读取上限同一条口径；对外名字保留（既有单测与调用方都按它取）。
const MAX_IMPORT_BYTES = MAX_TEXT_BYTES;

// 给人看的体量（只用于提示，保留 1 位小数直到 10 以上）：实现只有 core/common.js 的 formatByteSize 一份
const formatImportSize = formatByteSize;

// 大小闸门（纯逻辑）：超限回 { code, message }，没超回 null。
// 提示里只有文件名（不含目录），也不把整条本机路径带给界面 / 日志。
function importSizeProblem(bytes, baseName) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return null; // stat 拿不到（符号链接断开等）交给读盘报错
  if (size <= MAX_IMPORT_BYTES) return null;
  return {
    code: 'FILE_TOO_LARGE',
    message: `《${baseName}》有 ${formatImportSize(size)}，超过单本导入上限 ${formatImportSize(
      MAX_IMPORT_BYTES
    )}，已跳过`
  };
}

function hasUtf16Bom(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2) return false;
  return (buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff);
}

// 编码闸门（纯逻辑）：纯文本里不该有 NUL 字节。带 BOM 的 UTF-16 本来就一半是 0，放过；
// 其它含 0x00 的一律当二进制 / 坏编码，不去解码，免得导进来一本乱码书。
function isProbablyBinary(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return false;
  if (hasUtf16Bom(buffer)) return false;
  return buffer.includes(0);
}

// 一个完整小说 txt → 一本书。
// mode='chapters'（默认）：按原文标题行切章，章名照抄原文标题，正文原样保留（只切分、不改字）。
// mode='raw'：整本作为一章「全文」；UTF-8 源文件按字节原样复制。
// mode='split'：旧版自动分章（会重排编号），保留兼容。
async function importNovelFile(booksRoot, filePath, { mode = 'chapters' } = {}) {
  const baseName = path.basename(filePath, path.extname(filePath)).trim() || '未命名小说';
  // 先看大小，再读内容：超大文件连 Buffer 都不分配
  const stat = await fs.stat(filePath).catch(() => null);
  const sizeProblem = stat ? importSizeProblem(stat.size, baseName) : null;
  if (sizeProblem) throw new storage.StorageError(sizeProblem.code, sizeProblem.message);
  const buffer = await fs.readFile(filePath);
  // WP7（X-N1）：无 BOM 的 UTF-16（双字节均非 0 的纯中文，或只在新行 / ASCII 处有 0 字节）
  // 会被「含 0 字节」一刀切成二进制。先问无 BOM UTF-16 启发式，命中就放过；真正的二进制
  // （随机 0 字节 / 编码坏掉）仍按原口径拒绝（NOT_TEXT 文案不变）。
  if (!detectBomlessUtf16(buffer) && isProbablyBinary(buffer)) {
    throw new storage.StorageError(
      'NOT_TEXT',
      `《${baseName}》看起来不是纯文本文件（含 0 字节），已跳过`
    );
  }
  const decodedInfo = decodeBufferWithEncoding(buffer);
  const decoded = decodedInfo.text;
  if (!normalizeText(decoded).trim()) {
    throw new storage.StorageError('EMPTY_FILE', `《${baseName}》是空文件，跳过`);
  }

  // 审计 WP7（X-N2）：与文件夹形态统一 —— 先写隐藏暂存根里的「书目录」，写完再由
  // commitStagedFolder 原子 rename；并发导入同一个 txt 时后到者自动拿 -2（不再白丢一次导入），
  // 失败也只清自己的暂存。书架目录本身允许首次导入时不存在（createStagingRoot 用 recursive 建）。
  const stagingRoot = await createStagingRoot(booksRoot);
  const staging = path.join(stagingRoot, safeFolderName(baseName));
  await fs.mkdir(staging);

  try {
    const now = new Date().toISOString();
    let chapterList = [];

    if (mode === 'chapters') {
      let parts = splitChaptersRaw(decoded);
      if (!parts.length) {
        throw new storage.StorageError('NO_CONTENT', `《${baseName}》没有可导入的正文`);
      }
      // b10：没有识别到任何章节标题、且整篇超过 6 万字的「无标题长文」→ 按段落自动切片；
      // 有标题的正常拆章完全不动（parts.length > 1 或首段有 title 时都不进来）。
      if (parts.length === 1 && !parts[0].title && parts[0].body.length > LONG_UNTITLED_THRESHOLD) {
        parts = splitLongUntitled(parts[0].body);
      }
      const usedFiles = [];
      for (let i = 0; i < parts.length; i += 1) {
        const seq = i + 1;
        const title = parts[i].title || '';
        const file = chaptersLib.uniqueFileName(seq, title || '全文', usedFiles);
        // 正文按原文写入（不 trim、不改换行内容），只切分
        await fs.writeFile(path.join(staging, file), parts[i].body, 'utf8');
        usedFiles.push(file);
        chapterList.push({
          id: `ch_${chaptersLib.pad3(seq)}`,
          file,
          name: title,
          // C25（v1.8.0 WP-24）：写盘文件只有 body（标题行在 name 里，不重复计字），所以 chars
          // 也只算 body —— 与编辑区 / 状态栏 / 首次保存后 storage 的重算同一口径。以前把标题行
          // 一起算进去，导入后书架字数系统性虚高、第一次保存又回落。
          chars: chaptersLib.countChars(parts[i].body),
          createdAt: now
        });
      }
    } else if (mode === 'split') {
      const text = normalizeText(decoded).trim();
      let parts = splitChapters(text);
      if (!parts.length) {
        throw new storage.StorageError('NO_CONTENT', `《${baseName}》没有可导入的正文`);
      }
      // b10：自动分章模式下同样只在「没有任何标题 + 超过 6 万字」时兜底切片（标题正常的不动）
      if (
        parts.length === 1 &&
        (parts[0].title === '全文' || !parts[0].title) &&
        parts[0].text.length > LONG_UNTITLED_THRESHOLD
      ) {
        parts = splitLongUntitled(parts[0].text).map((part) => ({ title: part.title, text: part.body }));
      }
      const usedFiles = [];
      for (let i = 0; i < parts.length; i += 1) {
        const seq = i + 1;
        const file = chaptersLib.uniqueFileName(seq, parts[i].title || '', usedFiles);
        // 导入的是「源文件仍在的副本」，这里用普通写入换取速度；崩溃最多丢这次导入，可从源文件重来
        await fs.writeFile(path.join(staging, file), chaptersLib.toDiskNewlines(parts[i].text), 'utf8');
        usedFiles.push(file);
        chapterList.push({
          id: `ch_${chaptersLib.pad3(seq)}`,
          file,
          name: parts[i].title || '',
          chars: chaptersLib.countChars(parts[i].text),
          createdAt: now
        });
      }
    } else {
      // 原封不动整本模式：整篇作为一章「全文」
      const file = chaptersLib.buildFileName(1, '全文');
      // 审计修复 #54（P10）：源文件本来就是 UTF-8（含 UTF-8 BOM）时按字节原样复制，连 BOM / 换行都不动。
      // 编码判定与上面的解码是同一趟（decodedInfo.encoding），不再整本 fatal 解码第二遍。
      // WP7（X-N1）：宽容 UTF-8（有坏字节 → U+FFFD）的解码结果不是合法 UTF-8，不能按字节照抄，
      // 必须写解码后的合法 UTF-8（否则下游按 UTF-8 读会再次出现替换符 / 乱码）。
      if (decodedInfo.encoding === 'utf-8' && !decodedInfo.replacements) {
        await fs.writeFile(path.join(staging, file), buffer);
      } else {
        // 非 UTF-8（如 GBK）必须转成 UTF-8 应用才能读；只转编码，文字内容不变
        await fs.writeFile(path.join(staging, file), decoded, 'utf8');
      }
      chapterList = [
        {
          id: 'ch_001',
          file,
          name: '全文',
          chars: chaptersLib.countChars(decoded),
          createdAt: now
        }
      ];
    }

    const meta = {
      version: 1,
      id: `b_${Date.now().toString(36)}`,
      title: baseName,
      titleTemplate: chaptersLib.TITLE_TEMPLATE,
      fileSeq: chapterList.length,
      chapters: chapterList,
      lastOpenChapterId: chapterList[0].id,
      createdAt: now
    };
    // B2（审计 P2）：导入是结构性变更，显式声明（暂存目录里通常还没有上一版书目，
    // 读不到主文件就自然跳过备份；这里传 true 是为了「以后暂存流程若改成二次写盘」语义不丢）。
    await storage.writeBookMeta(staging, meta, { structural: true });
    // 审计 WP7（X-N2）：正式目录只由这一次原子 rename 产生（撞名自动换 -2 / -3）。
    const committed = await commitStagedFolder(booksRoot, staging, baseName);
    const result = {
      imported: true,
      kind: 'novel',
      mode,
      folder: committed.folder,
      path: committed.path,
      title: baseName,
      chapters: chapterList.length,
      // WP7（X-N1）：导入结果报告判定编码；有替换符时才多 replacements 字段（0 不出现，
      // 保持旧回包形状只多 encoding）。
      encoding: decodedInfo.encoding
    };
    if (decodedInfo.replacements) result.replacements = decodedInfo.replacements;
    return result;
  } finally {
    // 只清自己的暂存根：成功时里面已空（书目录被 rename 走），失败时连半成品一起清。
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}

// 清理上次导入崩溃留下的隐藏临时目录（只动自己前缀的，1 小时以前的）
async function cleanupStaleStaging(booksRoot) {
  let entries = [];
  try {
    entries = await fs.readdir(booksRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('.import-')) continue;
    const full = path.join(booksRoot, entry.name);
    try {
      const stat = await fs.stat(full);
      if (now - stat.mtimeMs > 3600 * 1000) {
        await fs.rm(full, { recursive: true, force: true });
      }
    } catch { /* 忽略 */ }
  }
}

function normalizeSources(sources) {
  return (sources || []).filter((s) => typeof s === 'string' && s.trim());
}

async function importFolders(booksRoot, sources, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  // 审计 WP7（X-N2）：跨窗口预检钩子（ipc/book.js 传入）。它拿到的是 uniqueFolderName 解析出的
  // 「最终撞名目标名」而不是来源 basename —— 重名会自动变成 -2 / -3，预检查的必须是那个名字。
  const guardTarget = typeof options.guardTarget === 'function' ? options.guardTarget : null;
  const mode =
    options.mode === 'split' ? 'split' : options.mode === 'raw' ? 'raw' : 'chapters';
  const imported = [];
  const skipped = [];
  const failed = [];
  const root = path.resolve(booksRoot);
  await fs.mkdir(root, { recursive: true });
  await cleanupStaleStaging(root);

  // 第一遍：分析来源并算总进度
  const plans = [];
  let total = 0;
  for (const source of normalizeSources(sources)) {
    const sourceDir = path.resolve(source);
    // V69：整源跳过的 source 也只回最后一段（相对名），不回本机绝对路径
    if (!(await isDirectory(sourceDir))) {
      skipped.push({ source: relativeSourceLabel(sourceDir), reason: '不是文件夹' });
      continue;
    }
    if (isInside(root, sourceDir)) {
      skipped.push({ source: relativeSourceLabel(sourceDir), reason: '已经在书架目录里了' });
      continue;
    }
    if (isInside(sourceDir, root)) {
      skipped.push({ source: relativeSourceLabel(sourceDir), reason: '不能导入包含书架目录的上级文件夹' });
      continue;
    }
    const analysis = await analyzeSource(sourceDir);
    if (analysis.kind === 'nothing') {
      skipped.push({
        source: relativeSourceLabel(sourceDir),
        reason: '既没有可用的 书目.json，也没有 txt 文件'
      });
      continue;
    }
    const items = analysis.kind === 'novels' ? analysis.files.length : 1;
    plans.push({ source, sourceDir, analysis, items });
    total += items;
    // 文件夹形态（现成书 / 章节目录）在复制前就问一次最终目标名：预检拒绝（别的窗口正开着这本书）
    // 时整次导入在复制开始前中止，语义与旧实现「复制前拒绝」一致。解析撞满 999 之类不在这里拦，
    // 交给真正的导入阶段如实报（不因为预检把整批吞掉）。
    if (guardTarget && analysis.kind !== 'novels') {
      let folder = null;
      try {
        folder = await uniqueFolderName(root, desiredFolderName(sourceDir, analysis));
      } catch {
        folder = null;
      }
      if (folder) await guardTarget({ source, sourceDir, folder, path: path.join(root, folder) });
    }
  }
  if (onProgress) onProgress({ done: 0, total });

  let done = 0;
  const bump = (current) => {
    done += 1;
    if (onProgress) onProgress({ done, total, current });
  };

  for (const plan of plans) {
    if (plan.analysis.kind === 'novels') {
      for (const file of plan.analysis.files) {
        try {
          const result = await importNovelFile(root, path.join(plan.sourceDir, file), { mode });
          imported.push(result);
        } catch (err) {
          // V69：失败项同样只回相对名（以前是 path.join(plan.sourceDir, file) 的本机绝对路径）
          failed.push({ source: file, message: errorText.describeForUi(err).message });
        }
        bump(file);
      }
    } else {
      try {
        const result = await importBookFolder(root, plan.sourceDir, plan.analysis);
        // V45：单个文件的跳过记录与整源跳过同形（source 相对 / reason / code / tooLarge），
        // 一次摊进 skipped —— 不再从 skippedFiles / skippedTooLarge 两处各转一份。
        for (const entry of result.skipped || []) skipped.push(entry);
        imported.push(result);
      } catch (err) {
        const source = relativeSourceLabel(plan.sourceDir);
        const described = errorText.describeForUi(err);
        if (err && (err.code === 'FILE_TOO_LARGE' || err.code === 'SOURCE_LINK')) {
          // V50：「一个能导入的文件都不剩」是跳过，不是复制失败 —— 错误码保留、文案留在「已跳过」，
          // 界面汇总显示「跳过 N 个（…）」而不是红色「N 个失败（复制失败：…）」。
          // 审计修复 #56（S7）：含符号链接的来源也按「跳过」记录（tooLarge 只给体量超限的 txt）。
          skipped.push({ source, reason: described.message, code: err.code, tooLarge: err.code === 'FILE_TOO_LARGE' });
        } else {
          failed.push({ source, message: described.message });
        }
      }
      bump(path.basename(plan.sourceDir));
    }
  }

  // V45：顶层 skippedTooLarge 计数从唯一的那套表示（skipped[].tooLarge）派生，语义与改前相同：
  // 有超限跳过时才出现这个字段（渲染层读的是 skipped，这里是主进程既有回包契约）。
  const skippedTooLarge = skipped.filter((entry) => entry.tooLarge).length;
  return skippedTooLarge
    ? { imported, skipped, failed, skippedTooLarge }
    : { imported, skipped, failed };
}

module.exports = {
  importFolders,
  importNovelFile,
  MAX_IMPORT_BYTES,
  // V106（WP-21）：导入文件夹撞名后缀上限 + 探测入口（单测注入小上限验证「撞满就报错」）
  MAX_FOLDER_SUFFIX,
  uniqueFolderName,
  // 审计 WP7（X-N2）：暂存 + 原子提交（导出给单测钉「撞名换后缀 / 重试有界 / 失败只清自己暂存」；
  // 生产调用点只有 importBookFolder / importNovelFile 两处）。MAX_COMMIT_ATTEMPTS / desiredFolderName
  // 只在本模块内用，不导出（sweep-unused 闸门：没人引用的导出不许留）。
  STAGING_PREFIX,
  safeFolderName,
  createStagingRoot,
  commitStagedFolder,
  // C30（v1.8.0 WP-26）：目录包含判定（大小写归一）导出给单测钉口径
  isInside,
  formatImportSize,
  // V116（v1.8.0 WP-29）：递归清单导出给单测，钉住「并发 readdir + 排序 / 排除口径不变」。
  // 生产调用点仍只有 importNovelFile 一处（见上）。
  listTxtFilesDeep,
  // 审计修复 #56（S7）：符号链接扫描导出给单测钉「_trash / 点开头目录不进、相对路径排序」口径。
  listSourceLinks,
  importSizeProblem,
  isProbablyBinary,
  hasUtf16Bom,
  // 审计修复 #13（E9）：来源形态判定词表已并入 core/heading.js，导出这个判定给单测钉住
  // 「章节目录 / 独立小说」的分界（生产调用点仍只有 analyzeSource 一处）。
  looksLikeChapterFile
};
