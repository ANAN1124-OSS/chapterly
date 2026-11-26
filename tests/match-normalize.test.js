// X7 / V205（v1.8.0 WP-25）：全仓「大小写归一」收编。
//
// **唯一实现**是 core/common.js 的 caseFoldForMatch / normalizeForMatch：先小写；小写化后长度变了
// （'İ' U+0130 → 'i' + U+0307 这类字符）就整串退回原文，并把这次退化记在 folded 标记里。
// 这一轮把五处口径收成一份：
//   core/find.js（查找 / 替换）、core/search-index.js（建图 / 查询 / 核对扫描）、
//   core/bookinfo.js（作者 / 分组 / 标签）、renderer/command-registry.js（命令面板）、
//   renderer/shelf-filter-ui.js（书架搜索）。
// 测试分三层，任何一层挂了都说明「匹配口径变了」：
//   1. 口径基线：空串 / 纯 ASCII / 含 'İ' / 代理对 / 非字符串入参 —— 期望值写死；
//   2. 跨实现一致：五个消费方走各自真实入口，同一段文字归一结果逐字相同；
//      「建图 / 查询同源」矩阵把 C20 勘误钉死（C20 是首轮误判、不是 bug —— 查询与建图同走一个函数时
//      Bloom 只误报、不漏报；这里防的是「以后改其中一处、真引入漏报」）；X7 的退化语义也逐条写死；
//   3. 静态闸门：五处必须引用共享实现，不许再长出本地 lowerText / 裸 toLowerCase 副本。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const common = require('../core/common');
const findLib = require('../core/find');
const searchIndex = require('../core/search-index');
const bookInfo = require('../core/bookinfo');
const commandRegistry = require('../renderer/command-registry');
const shelfFilterUi = require('../renderer/shelf-filter-ui');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
// 'İ'（U+0130，带点大写 I）：小写化会变成 'i' + U+0307 两个码元 —— X7 / V76 / C20 的共同样本
const DOTTED_I = '\u0130';

// ---------- 1. 口径基线 ----------

test('口径基线：normalizeForMatch 小写化；含 İ 时整串退回原文并标记 folded=false', () => {
  // 纯 ASCII / 中文：正常小写，folded=true
  assert.deepEqual(common.caseFoldForMatch('Hello World'), { text: 'hello world', folded: true });
  assert.deepEqual(common.caseFoldForMatch('雨下了一夜。'), { text: '雨下了一夜。', folded: true });
  assert.equal(common.normalizeForMatch('Ctrl+S'), 'ctrl+s');
  assert.equal(common.normalizeForMatch('STRASSE'), 'strasse');
  // 非字符串 / 空值：与旧实现逐字一致（String(value == null ? '' : value)）
  assert.equal(common.normalizeForMatch(null), '');
  assert.equal(common.normalizeForMatch(undefined), '');
  assert.equal(common.normalizeForMatch(123), '123');
  assert.equal(common.normalizeForMatch(false), 'false', '布尔按字符串处理');
  assert.equal(common.normalizeForMatch({}), '[object object]', '对象按 String() 处理');
  // İ：小写化长度 +1，整串退回原文（哪怕里面还有别的可折叠字符）——这就是 X7 的退化语义
  assert.equal(DOTTED_I.toLowerCase().length, 2, '前提：İ 小写化会变长（否则本用例不成立）');
  const dotted = common.caseFoldForMatch(`${DOTTED_I}stanbul BOOKMARK`);
  assert.equal(dotted.folded, false, '含 İ 时必须标记「这一次退化为区分大小写」');
  assert.equal(dotted.text, `${DOTTED_I}stanbul BOOKMARK`, '整串退回原文，不做半折叠');
  assert.equal(common.normalizeForMatch(`${DOTTED_I}stanbul`), `${DOTTED_I}stanbul`);
  // 代理对 / 生僻字：不长度的字符照常折叠
  assert.equal(common.normalizeForMatch('\u{1F600}ABC'), '\u{1F600}abc');
  assert.equal(common.caseFoldForMatch('\u{1F600}').folded, true);
});

// ---------- 2. 跨实现一致：五个消费方 ----------

test('查找（core/find.js，X7）：大小写不敏感照旧；含 İ 的串这一次退化为区分大小写', () => {
  // 纯 ASCII：口径不变
  assert.deepEqual(findLib.findMatches('Hello World', 'world'), [{ index: 6, length: 5 }]);
  assert.deepEqual(findLib.findMatches('Hello World', 'WORLD'), [{ index: 6, length: 5 }]);
  // İ：两边都含 İ → 两边退回原文，同形同大小写仍命中，位置与长度是原文坐标
  assert.deepEqual(findLib.findMatches(`${DOTTED_I}stanbul`, DOTTED_I + 'stanbul'), [{ index: 0, length: 8 }]);
  // 退化语义（X7 的已知限制）：干草堆含 İ → 整串退回原文；'STANBUL' 折成 'stanbul' 但干草堆
  // 里的 'stanbul' 是小写原文，'stanbul' 并不在 'İstanbul' 里…… 这里钉的是「不会误命中、也不许错位」：
  assert.deepEqual(findLib.findMatches(`${DOTTED_I}stanbul`, 'STANBUL'), [], '含 İ 时大写查询按原文比较，不命中');
  assert.deepEqual(findLib.findMatches('Istanbul', 'STANBUL'), [{ index: 1, length: 7 }], '不含 İ 时仍不区分大小写');
  // 替换沿用同一口径，位置对齐（V76 的防线）：原文坐标不因归一偏移
  const replaced = findLib.replaceAllLiteral(`${DOTTED_I}${DOTTED_I}青柠色`, '青柠色', 'X');
  assert.equal(replaced.text, `${DOTTED_I}${DOTTED_I}X`);
  assert.equal(replaced.count, 1);
});

test('正文索引（core/search-index.js，C20 勘误）：建图 / 查询 / 扫描同源，含 İ 也不漏报', () => {
  // 把「查询串能在归一后的干草堆里命中」当成核对扫描的判定，逐条核对 Bloom 双字集合。
  // 两边都必须走同一个 normalizeForMatch：改任一处（例如查询侧改回裸 toLowerCase）这里就会红。
  const texts = [
    `${DOTTED_I}stanbul 的雨`,
    `${DOTTED_I}${DOTTED_I}青柠色的雨伞挂在门口。`,
    'Istanbul 的雨',
    '青柠色的雨伞',
    `${DOTTED_I}zmir İzmir`
  ];
  const queries = ['stan', 'STAN', DOTTED_I + 'stanbul', 'istanbul', DOTTED_I + 'zmir', 'zmir', '青柠色', 'ISTANBUL'];
  let scanned = 0;
  for (const text of texts) {
    const bloom = searchIndex.makeBookBloom([text]);
    const haystack = common.normalizeForMatch(text);
    for (const query of queries) {
      const needle = searchIndex.normalizeQuery(query);
      if (!needle || !haystack.includes(needle)) continue;
      scanned += 1;
      for (const hash of searchIndex.queryBigrams(query)) {
        assert.equal(
          searchIndex.bloomHas(bloom.bloom, bloom.bits, hash),
          true,
          `「${query}」在「${text}」里能命中，建图却把它筛掉了（C20 描述的漏报路径）`
        );
      }
    }
  }
  assert.ok(scanned >= 6, `矩阵里至少要有 6 组「扫描能命中」的样本，实际 ${scanned}`);

  // 反向证明这条锚点抓得住 C20 描述的错法：查询侧若改成裸 toLowerCase，双字会与建图对不上。
  const bloom = searchIndex.makeBookBloom([`${DOTTED_I}stanbul`]);
  const naive = searchIndex.queryBigrams((DOTTED_I + 'stanbul').toLowerCase());
  assert.ok(
    naive.some((hash) => !searchIndex.bloomHas(bloom.bloom, bloom.bits, hash)),
    '查询串裸 toLowerCase 后会与原文建图对不上 —— 这正是 C20 描述的漏报路径（当前实现不许走这条）'
  );
  // 同源正面：İ 查询的双字全在建图集合里
  for (const hash of searchIndex.queryBigrams(`${DOTTED_I}stanbul`)) {
    assert.equal(searchIndex.bloomHas(bloom.bloom, bloom.bits, hash), true);
  }
});

test('书架搜索（renderer/shelf-filter-ui.js，V205）：书名 / 文件夹 / 章名与大小写归一同一份', () => {
  const books = [
    { title: 'Bookmark 书签', folder: 'BOOKMARK', chapterNames: ['第一章'] },
    { title: `${DOTTED_I}stanbul 手记`, folder: `${DOTTED_I}stanbul`, chapterNames: ['第一章'] },
    { title: '青柠色的雨伞', folder: 'lime', chapterNames: [`${DOTTED_I}zmir 的雨`] }
  ];
  const makeUi = (query) => shelfFilterUi.create({
    $: () => null,
    state: {
      view: 'shelf',
      shelfQuery: query,
      shelfGroup: '',
      shelfTag: '',
      books,
      shelfContent: { loading: false, results: [], meta: null, error: null, shown: 8, query: '', expanded: {} }
    },
    bookInfoLib: bookInfo,
    chapterTitle: (index, name) => `第${index + 1}章·${name}`,
    openContentResult: () => {},
    CONTENT_SEARCH_MIN_CHARS: 2
  });
  const visible = (query) => makeUi(query).shelfSearchResults().map((row) => row.book.title);
  // 纯 ASCII：大小写不敏感（书名 / 文件夹都算）
  assert.deepEqual(visible('bookmark'), ['Bookmark 书签']);
  assert.deepEqual(visible('BOOKMARK'), ['Bookmark 书签']);
  // 含 İ：同形同大小写命中；换成小写 i 这一次不命中（X7 的退化语义，全站一致）
  assert.deepEqual(visible(`${DOTTED_I}stanbul`), [`${DOTTED_I}stanbul 手记`]);
  assert.deepEqual(visible('istanbul'), [], '含 İ 的书名这一次退化为区分大小写');
  // 章名命中同样走共享归一（返回的是原文名，不是归一后的串）
  const rows = makeUi(`${DOTTED_I}zmir`).shelfSearchResults();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].info.chapterHits, [{ index: 0, name: `${DOTTED_I}zmir 的雨` }], '章名存原文、比较用归一');
});

test('命令面板（renderer/command-registry.js，V205）：归一仍是「全角→半角 + trim + 小写」，含 İ 时退化', () => {
  assert.equal(commandRegistry.normalize('  Ctrl+S  '), 'ctrl+s');
  assert.equal(commandRegistry.normalize('ＳＡＶＥ'), 'save', '全角字母按半角处理');
  assert.equal(commandRegistry.normalize('保　存'), '保 存', '全角空格按半角空格处理');
  // İ：整串退回原文（不做半折叠），与其它四处一致
  assert.equal(commandRegistry.normalize(`${DOTTED_I}STANBUL`), `${DOTTED_I}STANBUL`);
  const items = [
    { id: 'cmd:bookmark', title: 'Bookmark 书签', group: 'command', keywords: ['bookmark'] },
    { id: 'cmd:notebook', title: `${DOTTED_I}stanbul 笔记`, group: 'command', keywords: [] }
  ];
  const registry = commandRegistry.createRegistry({});
  assert.deepEqual(registry.search(items, 'bookmark').map((item) => item.id), ['cmd:bookmark']);
  assert.deepEqual(registry.search(items, 'BOOKMARK').map((item) => item.id), ['cmd:bookmark']);
  assert.deepEqual(registry.search(items, `${DOTTED_I}stanbul`).map((item) => item.id), ['cmd:notebook']);
  assert.deepEqual(registry.search(items, 'istanbul').map((item) => item.id), [], '含 İ 时这一次退化为区分大小写');
  // 「bkm → Bookmark」的子序列命中不受归一改动影响
  assert.deepEqual(registry.search(items, 'bkm').map((item) => item.id), ['cmd:bookmark']);
});

test('书籍信息（core/bookinfo.js，V205）：作者 / 分组 / 标签匹配走同一份归一', () => {
  const info = { author: 'Zhang San', group: '玄幻', tags: ['Upgrade', `${DOTTED_I}zmir`] };
  assert.equal(bookInfo.bookInfoMatches(info, 'zhang'), true);
  assert.equal(bookInfo.bookInfoMatches(info, 'ZHANG'), true);
  assert.equal(bookInfo.bookInfoMatches(info, '玄幻'), true);
  assert.equal(bookInfo.bookInfoMatches(info, 'upgrade'), true);
  assert.equal(bookInfo.bookInfoMatches(info, `${DOTTED_I}zmir`), true);
  assert.equal(bookInfo.bookInfoMatches(info, 'izmir'), false, '含 İ 时这一次退化为区分大小写');
  assert.equal(bookInfo.bookInfoMatches(info, ''), false);
  assert.equal(bookInfo.bookInfoMatches(null, 'zhang'), false);
});

// ---------- 3. 静态闸门 ----------

test('静态闸门：五个消费方都引用 core/common.js 的共享实现，没有本地副本', () => {
  const wired = {
    'core/find.js': /const \{ caseFoldForMatch, snapGrapheme \} = require\('\.\/common'\);/,
    'core/search-index.js': /const \{ nowIso, mapLimit, normalizeForMatch, snapGrapheme \} = require\('\.\/common'\);/,
    'core/bookinfo.js': /const \{ truncateSafe, normalizeForMatch \} = common;/,
    'renderer/shelf-filter-ui.js': /module\.exports = factory\(require\('\.\.\/core\/common'\), require\('\.\.\/core\/assert-host'\)\.assertHost\);/,
    'renderer/command-registry.js': /module\.exports = factory\(require\('\.\.\/core\/common'\)\);/
  };
  for (const [rel, pattern] of Object.entries(wired)) {
    assert.ok(pattern.test(read(rel)), `${rel} 必须从 core/common.js 取归一实现`);
  }
  // 书架搜索 / 命令面板的浏览器分支也必须接上 window.CWCommon
  // （A8/WP-32：shelf-filter 还多收一个 window.CWAssertHost，那是 host 校验，不是归一实现）
  for (const [rel, pattern] of [
    ['renderer/shelf-filter-ui.js', /factory\(root\.CWCommon, root\.CWAssertHost && root\.CWAssertHost\.assertHost\)/],
    ['renderer/command-registry.js', /factory\(root\.CWCommon\)/]
  ]) {
    assert.ok(pattern.test(read(rel)), `${rel} 的浏览器分支要取 window.CWCommon`);
  }
  // 全仓只许 core/common.js 定义这两份实现
  const files = [];
  for (const dir of ['core', 'renderer']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (name.endsWith('.js')) files.push(`${dir}/${name}`);
    }
  }
  const impls = files.filter((rel) => /function (caseFoldForMatch|normalizeForMatch)\s*\(/.test(read(rel)));
  assert.deepEqual(impls, ['core/common.js'], '大小写归一只许 core/common.js 一份实现');
  // 五个消费方的匹配路径不许再留裸 toLowerCase / 本地 lowerText
  const shelfCode = stripComments(read('renderer/shelf-filter-ui.js'));
  const commandCode = stripComments(read('renderer/command-registry.js'));
  for (const [rel, code] of [
    ['core/find.js', read('core/find.js')],
    ['core/search-index.js', read('core/search-index.js')],
    ['renderer/shelf-filter-ui.js', shelfCode],
    ['renderer/command-registry.js', commandCode]
  ]) {
    assert.equal(code.includes('toLowerCase'), false, `${rel} 不许再手写 toLowerCase`);
    assert.equal(/function lowerText\s*\(/.test(code), false, `${rel} 不许再留本地 lowerText`);
  }
  // bookinfo 只改了 bookInfoMatches；其它历史 toLowerCase（分组键 / 规范化分组名）不在本条范围
  const bookinfoSrc = read('core/bookinfo.js');
  const body = /\n {2}function bookInfoMatches\(info, query\) \{[\s\S]*?\n {2}\}/.exec(bookinfoSrc);
  assert.ok(body, '找不到 bookInfoMatches 的函数体');
  assert.equal(body[0].includes('toLowerCase'), false, 'bookInfoMatches 不许再手写 toLowerCase');
  assert.ok(body[0].includes('normalizeForMatch('), 'bookInfoMatches 必须走共享归一');
  // index.html 的加载顺序：core/common.js 必须排在两个渲染层消费者之前
  const indexSrc = read('renderer/index.html');
  const commonAt = indexSrc.indexOf('src="../core/common.js"');
  assert.ok(commonAt > 0);
  for (const needle of ['<script src="shelf-filter-ui.js"></script>', '<script src="command-registry.js"></script>']) {
    const at = indexSrc.indexOf(needle);
    assert.ok(at > 0, `index.html 里找不到 ${needle}`);
    assert.ok(commonAt < at, `${needle} 必须排在 core/common.js 之后`);
  }
});

test('静态闸门：查找 / 替换必须两边同源（折叠标记成对使用）', () => {
  const findSrc = read('core/find.js');
  assert.ok(
    /foldedHay\.folded && foldedNeedle\.folded/.test(findSrc),
    'core/find.js 必须「两边都能安全折叠才折叠」，不许出现干草堆折叠、针不折叠的混合口径'
  );
  assert.ok(/caseFoldForMatch\(source\)/.test(findSrc) && /caseFoldForMatch\(needleRaw\)/.test(findSrc));
  // 索引侧建图与查询都必须是 normalizeForMatch（C20 同源不变量）
  const indexSrc = read('core/search-index.js');
  // P3（审计修复 #19）：建图调用多了一个「双字集合上限」实参，归一化口径必须仍是同一个函数
  assert.ok(
    /addBigramsToSet\(normalizeForMatch\(text\), set, cap\)/.test(indexSrc),
    '建图必须走 normalizeForMatch'
  );
  assert.ok(/normalizeForMatch\(value\)\.trim\(\)/.test(indexSrc), '查询必须走同一个 normalizeForMatch');
  assert.ok(/const haystack = normalizeForMatch\(text\);/.test(indexSrc), '核对扫描必须走同一个 normalizeForMatch');
});