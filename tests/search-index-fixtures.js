// 搜索索引测试的共用夹具（T9 / 第 10 轮：原 tests/search-index.test.js 按性质拆成四个文件）。
//
// 拆法（与 storage / config / capture-ui 的 T9 拆分同口径，见 tests/README.md 的「临时目录与夹具」）：
//   · 本文件放**夹具**：临时目录 mkTmp、手写书目 makeBook / readMeta / writeMeta、双目录 makeWorld、
//     索引 store 构造器 makeStore，以及两个以前夹在用例块中间的纯函数 helper（nthIndex / exists）。
//   · 用例按性质分四个 .test.js：core（纯函数 / 位图 / 解析）、build（建索引 / 校验 / 重建 / 落盘）、
//     search（搜索 / 命中 / focus / 缓存预算）、static（源码静态闸门）。
// 本文件不叫 *.test.js：`node --test "tests/**/*.test.js"` 不会把它当用例跑。
const fs = require('node:fs/promises');
const path = require('node:path');
const search = require('../core/search-index');

const tmpCleanup = require('./tmp-cleanup');

// TB-02：临时目录统一经 tests/tmp-cleanup.js 的 mkTmp（mkdtemp + 登记回收）。
const mkTmp = (prefix = 'cw-search-') => tmpCleanup.mkTmp(prefix);

function pad3(n) {
  return String(n).padStart(3, '0');
}

// 手写一本书（不经过 storage.createBook），字段形状与 v0.4.1 书目一致，且可选「旧书目」形状
async function makeBook(booksRoot, folder, title, chapters, options = {}) {
  const bookPath = path.join(booksRoot, folder);
  await fs.mkdir(bookPath, { recursive: true });
  const meta = {
    version: 1,
    id: options.id || `b_${folder}`,
    title,
    titleTemplate: '第{num}章',
    fileSeq: chapters.length,
    chapters: [],
    createdAt: '2026-10-31T12:00:00.000Z'
  };
  if (!options.oldShape) meta.schemaVersion = 1;
  for (let i = 0; i < chapters.length; i += 1) {
    const chapter = chapters[i];
    const file = `${pad3(i + 1)}-${chapter.slug || chapter.name || `章${i + 1}`}.txt`;
    await fs.writeFile(path.join(bookPath, file), chapter.text, 'utf8');
    meta.chapters.push({
      id: chapter.id || `ch_${pad3(i + 1)}`,
      file,
      name: chapter.name || '',
      createdAt: '2026-10-31T12:00:00.000Z'
    });
    if (Number.isFinite(chapter.chars)) meta.chapters[meta.chapters.length - 1].chars = chapter.chars;
  }
  await fs.writeFile(path.join(bookPath, '书目.json'), JSON.stringify(meta, null, 2), 'utf8');
  return { bookPath, meta };
}

async function readMeta(bookPath) {
  return JSON.parse(await fs.readFile(path.join(bookPath, '书目.json'), 'utf8'));
}

async function writeMeta(bookPath, meta) {
  await fs.writeFile(path.join(bookPath, '书目.json'), JSON.stringify(meta, null, 2), 'utf8');
}

function makeStore(userData, options = {}) {
  return search.createSearchStore({
    userDataDir: userData,
    validateIntervalMs: 0, // 单测里每次 ensure 都做全量校验，外部改 txt 能立刻发现
    ...options
  });
}

// TESTC-06：搜索索引夹具的「userData + booksRoot 双目录」唯一构造器。
// 以前每个用例手抄 4 行（36 处、约 200 行）；目录名 / 是否建目录这类细节只在这一点。
async function makeWorld(base) {
  const userData = path.join(base, 'userdata');
  const booksRoot = path.join(base, 'books');
  await fs.mkdir(userData);
  await fs.mkdir(booksRoot);
  return { userData, booksRoot };
}

// 第 n 次出现的下标（P22-4 的「单章 N 处命中」用例按位置断言用）；以前夹在 P22-4 用例块中间。
function nthIndex(text, needle, n) {
  let at = -1;
  let from = 0;
  for (let i = 0; i < n; i += 1) {
    at = text.indexOf(needle, from);
    if (at < 0) return -1;
    from = at + needle.length;
  }
  return at;
}

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  mkTmp,
  pad3,
  makeBook,
  readMeta,
  writeMeta,
  makeStore,
  makeWorld,
  nthIndex,
  exists,
};
