// T9（三审·低）：storage 测试按性质拆成「书级」与「章级 / 整本」两个文件后共用的夹具。
// 只给测试用，不进产品代码；拆文件时把「多章夹具 / 老书夹具 / 稀疏超限章 / 读盘计数」收在这里一份。
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const storage = require('../core/storage');
const tmpCleanup = require('./tmp-cleanup');

const STORAGE_SOURCE = fsSync
  .readFileSync(path.join(__dirname, '..', 'core', 'storage.js'), 'utf8')
  .replace(/\r\n/g, '\n');

// 取一个顶层函数的函数体：从 `async function X(` / `function X(` 到下一个顶格 `}\n`。
function topLevelBody(name) {
  const start = STORAGE_SOURCE.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.notEqual(start, -1, `storage.js 找不到 ${name}`);
  const end = STORAGE_SOURCE.indexOf('\n}\n', start);
  return end < 0 ? STORAGE_SOURCE.slice(start) : STORAGE_SOURCE.slice(start, end);
}

// TB-02：临时目录统一经 tests/tmp-cleanup.js 的 mkTmp（mkdtemp + 登记回收）。
const mkTmp = (prefix = 'cw-test-') => tmpCleanup.mkTmp(prefix);

// 审计修复 #22（P6）：缺 id 回填的编号规则必须与旧实现逐项等价 —— 旧实现每个缺 id 的章都从
// i+1 重新探测（低位号全被占 + 大量缺 id 时 20000 章约 4×10^8 次探测）；新技术只把探测换成
// 单调空闲游标（O(n)），编号口径一个都不变。这里同时钉住「等价」与「大样本能跑完」。
function referenceBackfillChapterIds(chapters) {
  const used = new Set();
  for (const chapter of chapters) {
    if (chapter && typeof chapter.id === 'string' && chapter.id) used.add(chapter.id);
  }
  return chapters.map((chapter, i) => {
    let id = chapter && typeof chapter.id === 'string' && chapter.id ? chapter.id : '';
    if (!id) {
      let n = i + 1;
      do {
        id = `ch_${String(n).padStart(3, '0')}`;
        n += 1;
      } while (used.has(id));
      used.add(id);
    }
    return id;
  });
}

// 书架扫描回填以前是裸 fs.readFile：书目里缺 chars 缓存的章被外部程序换成 129 MB 文件
// （误放的视频 / 日志 / 数据库导出）时会整份读进主进程内存，异常还会把整本书标成 corrupt。
// 现在与 loadChapterText 同口径：先 stat + readSizeProblem(128 MB)，超限章跳过不读、不写缓存。
// 造「老书」书目：把所有章的字数缓存抹掉（模拟旧版本写的 书目.json）
async function stripCharsCache(bookPath) {
  const meta = await storage.readBookMeta(bookPath);
  const legacy = {
    ...meta,
    chapters: meta.chapters.map(({ id, file, name }) => ({ id, file, name }))
  };
  await fs.writeFile(path.join(bookPath, '书目.json'), JSON.stringify(legacy), 'utf8');
  return legacy;
}

// 稀疏文件：只改大小，不真写 128 MB
async function makeSparseHuge(filePath) {
  const handle = await fs.open(filePath, 'r+');
  try {
    await handle.truncate(storage.MAX_CHAPTER_READ_BYTES + 1024);
  } finally {
    await handle.close();
  }
}

// TB-03：多章夹具的唯一构造器 —— 建书 → 按顺序追加章节 → 逐章写正文，返回最终书目。
// 以前「createBook → createChapter ×N → 每步 readBookMeta → saveChapterText」手抄了十余处；
// chapters = [{ name?, text? }, …]（第 0 条对应 createBook 自动建的那一章）。
async function makeBook(root, title, chapters = []) {
  const created = await storage.createBook(root, title);
  const bookPath = created.path;
  let meta = created.meta || (await storage.readBookMeta(bookPath));
  for (let index = 0; index < chapters.length; index += 1) {
    const spec = chapters[index] || {};
    if (index > 0) {
      ({ meta } = await storage.createChapter(bookPath, index, spec.name || ''));
    } else if (spec.name) {
      await storage.renameChapter(bookPath, meta.chapters[0].id, spec.name);
      meta = await storage.readBookMeta(bookPath);
    }
    if (spec.text !== undefined) {
      await storage.saveChapterText(bookPath, meta.chapters[index].file, spec.text);
    }
  }
  return { bookPath, meta };
}


async function withFsPatch(target, key, impl, fn) {
  const real = target[key];
  Object.defineProperty(target, key, { configurable: true, writable: true, value: impl(real) });
  try {
    return await fn(real);
  } finally {
    Object.defineProperty(target, key, { configurable: true, writable: true, value: real });
  }
}

// 读盘计数器：记录每一次真实的「按路径 readFile」与「句柄 readFile」；超限章一旦被读就直接失败
// （不真分配 129 MB）。TB-04：本文件所有「拦截 fs 读」的用例都走这一份（以前失败路径上还有一份
// 只计数、不拦截的简版，断言一旦回归就会真的把 129 MB 读进内存）。
// STORAGE-01 起章节 / 补章 / .bak 改成「同句柄读」（open → fstat → 同一句柄 readFile），只拦
// fs.readFile 会漏掉真正的读盘路径、让「一章一次」的断言变成永远空数组 —— 这里把 open 出来的
// 句柄的 readFile 也记进同一份 paths（超限章在句柄上被读照样立刻抛错）。
function countReadFileFor(hugePath) {
  const realReadFile = fs.readFile;
  const realOpen = fs.open;
  const paths = [];
  const note = (target) => {
    paths.push(target);
    if (target === hugePath) throw new Error('超限章节不许走进 readFile');
  };
  fs.readFile = async (...args) => {
    const target = String(args[0]);
    note(target);
    return realReadFile(...args);
  };
  fs.open = async (target, ...rest) => {
    const handle = await realOpen(target, ...rest);
    const targetPath = String(target);
    const realHandleReadFile = handle.readFile.bind(handle);
    handle.readFile = async (...args) => {
      note(targetPath);
      return realHandleReadFile(...args);
    };
    return handle;
  };
  return {
    paths,
    restore() {
      fs.readFile = realReadFile;
      fs.open = realOpen;
    },
    hugeReads: () => paths.filter((target) => target === hugePath).length
  };
}

module.exports = {
  STORAGE_SOURCE,
  topLevelBody,
  mkTmp,
  referenceBackfillChapterIds,
  stripCharsCache,
  makeSparseHuge,
  makeBook,
  withFsPatch,
  countReadFileFor
};
