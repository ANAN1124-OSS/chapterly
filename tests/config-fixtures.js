// 配置层测试的共用夹具（T9 / 第 9 轮：原 tests/config.test.js 按域拆成四个文件）。
//
// 为什么单独一份：四个文件都要「临时配置目录 + 真实的 createConfigStore / sanitize / DEFAULTS」，
// 各抄一份必然分叉（改一个默认值要动四处）。这里只放**夹具与依赖**，不放用例；
// 用例仍在 config-store / config-corruption / config-keys / config-write-safety 四个 .test.js 里。
//
// 约定（与 tests/storage-fixtures.js 同口径，见 tests/README.md 的「临时目录与夹具」）：
//   · 临时目录统一经 tests/tmp-cleanup.js 的 mkTmp（mkdtemp + 登记回收），前缀默认 cw-config-；
//   · MAIN_SOURCE 只读一次、只归一换行一次（TB-07：静态闸门本来就是同步逻辑）；
//   · 夹紧口径用例表来自 tests/clamp-contracts.js（T8 的跨层唯一事实源），不在这里复制数字。
//
// 本文件不叫 *.test.js：`node --test "tests/**/*.test.js"` 不会把它当用例跑。
'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { createConfigStore, sanitize, sanitizeLastBook, DEFAULTS, BOOK_DISPLAY_MAX } = require('../core/config');
const { writeJsonAtomic } = require('../core/atomic');
const { readGlossaryFile, readGlossaryFiles } = require('../core/glossary');
const tmpCleanup = require('./tmp-cleanup');
const {
  LONG_PARAGRAPH_THRESHOLD_CASES,
  LONG_PARAGRAPH_THRESHOLD_CORE_ONLY_CASES
} = require('./clamp-contracts');

// TB-07：main.js 源码只读一次、只归一换行一次（静态闸门本来就是同步逻辑）。
const MAIN_SOURCE = fsSync
  .readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  .replace(/\r\n/g, '\n');

// TB-02：临时目录统一经 tests/tmp-cleanup.js 的 mkTmp（mkdtemp + 登记回收）。
const mkTmp = (prefix = 'cw-config-') => tmpCleanup.mkTmp(prefix);

module.exports = {
  fs,
  path,
  createConfigStore,
  sanitize,
  sanitizeLastBook,
  DEFAULTS,
  BOOK_DISPLAY_MAX,
  writeJsonAtomic,
  readGlossaryFile,
  readGlossaryFiles,
  MAIN_SOURCE,
  mkTmp,
  LONG_PARAGRAPH_THRESHOLD_CASES,
  LONG_PARAGRAPH_THRESHOLD_CORE_ONLY_CASES
};
