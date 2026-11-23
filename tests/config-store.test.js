// 配置层测试（T9 / 第 9 轮按域拆分）：配置读写与清洗。
//
// 来源：原 tests/config.test.js（2,000 行 / 69 例）按域拆成四个文件，**只搬家不改断言**——
// 用例标题与断言逐字保留，共用夹具收进 tests/config-fixtures.js（T9 纪律，见 tests/README.md）。
// 本文件覆盖：默认值 / 持久化 / 窗口几何 / 显示排版 / 按书显示 / 高亮与编辑器小件 / 超长段落阈值 /
// 导出目录记忆 / 继续上次写作（lastBook）/ bookDisplay 上限与并发合并。
const test = require('node:test');
const assert = require('node:assert/strict');
const { path, fs, createConfigStore, sanitize, sanitizeLastBook, DEFAULTS, BOOK_DISPLAY_MAX, writeJsonAtomic, MAIN_SOURCE, mkTmp, LONG_PARAGRAPH_THRESHOLD_CASES, LONG_PARAGRAPH_THRESHOLD_CORE_ONLY_CASES } = require('./config-fixtures');

test('配置默认值：书架在「文档\\我的小说」，窗口 1200x760', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  const cfg = await store.get();
  assert.equal(cfg.booksRoot, DEFAULTS.booksRoot);
  assert.equal(cfg.windowBounds.width, 1200);
  assert.equal(cfg.windowBounds.height, 760);
  assert.equal(cfg.editorFont, 'serif');
  assert.equal(cfg.editorFontSize, 18);
  assert.equal(cfg.editorSidebarWidth, 250);
});

test('配置写入后可再次读取（持久化）', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await store.set({ booksRoot: 'D:\\小说库', editorFont: 'kai', editorFontSize: 22, editorSidebarWidth: 360 });
  const store2 = createConfigStore(dir);
  const cfg = await store2.get();
  assert.equal(cfg.booksRoot, 'D:\\小说库');
  assert.equal(cfg.editorFont, 'kai');
  assert.equal(cfg.editorFontSize, 22);
  assert.equal(cfg.editorSidebarWidth, 360);
});

test('配置脏数据被兜底，不会让应用起不来', async () => {
  const dir = await mkTmp();
  await fs.writeFile(path.join(dir, 'config.json'), '{ 坏掉的配置', 'utf8');
  const store = createConfigStore(dir);
  const cfg = await store.get();
  assert.equal(cfg.booksRoot, DEFAULTS.booksRoot);

  const cleaned = sanitize({
    booksRoot: '',
    editorFont: 'comic-sans',
    editorFontSize: 999,
    editorSidebarWidth: 9999,
    windowBounds: { width: 'x', height: null }
  });
  assert.equal(cleaned.booksRoot, DEFAULTS.booksRoot);
  assert.equal(cleaned.editorFont, 'serif');
  assert.equal(cleaned.editorFontSize, 30);
  assert.equal(cleaned.editorSidebarWidth, 800, '章节栏宽度应被夹到合理范围');
  assert.equal(cleaned.windowBounds.width, 1200);
});

// V89（1.7.2 D6）：窗口位置记忆多了「上次是最大化」这一个布尔子键（windowBounds.maximized）。
// 清洗函数必须放行它——否则每次 set 都被当脏字段删掉，重启出来就是「铺满但没最大化」的假最大化，
// 而且不会报错（功能静默失效）。变更面只有这一个子键：不新增顶层字段、不写迁移代码。

test('windowBounds 带 maximized：清洗放行布尔、缺省 false、真文件往返不丢（V89）', async () => {
  // 旧配置（没有这个子键）：缺省 false，不补字段到磁盘、也不算「写坏了」
  assert.equal(DEFAULTS.windowBounds.maximized, false);
  assert.equal(sanitize({}).windowBounds.maximized, false);
  assert.equal(sanitize({ windowBounds: { x: 10, y: 20, width: 1000, height: 700 } }).windowBounds.maximized, false);

  // 清洗不许把它当脏字段删掉
  const cleaned = sanitize({ windowBounds: { x: 10, y: 20, width: 1000, height: 700, maximized: true } });
  assert.deepEqual(cleaned.windowBounds, { x: 10, y: 20, width: 1000, height: 700, maximized: true });
  assert.equal(cleaned.windowBounds.maximized, true);

  // 只认真正的布尔 true：字符串 / 数字 / 对象都不算最大化（和 firstRunTipShown 同一口径）
  for (const bad of ['true', '1', 1, 0, {}, [], null]) {
    const got = sanitize({ windowBounds: { width: 1000, height: 700, maximized: bad } }).windowBounds.maximized;
    assert.equal(got, false, `maximized=${JSON.stringify(bad)} 应回落 false`);
  }

  // 真文件往返：写盘 → 重新 createStore 读回来仍是最大化，四个标量一个不少
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await store.set({ windowBounds: { x: 60, y: 40, width: 1200, height: 760, maximized: true } });
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(raw.windowBounds.maximized, true, 'config.json 里要真记下 maximized');
  const store2 = createConfigStore(dir);
  const cfg = await store2.get();
  assert.equal(cfg.windowBounds.maximized, true);
  assert.deepEqual(
    { x: cfg.windowBounds.x, y: cfg.windowBounds.y, width: cfg.windowBounds.width, height: cfg.windowBounds.height },
    { x: 60, y: 40, width: 1200, height: 760 },
    '四个标量照旧（窗口位置记忆的旧字段不许被新子键挤掉）'
  );
});

// V103（v1.8.0 WP-26）：窗口几何记忆两处修正：
//   1) 配置不再把宽 / 高夹到 4000 / 3000（5K 超宽屏的正常窗口会被截小，重启后永远小一圈）；
//      离谱坏值仍有界兜底，真正的显示范围由 main.js 恢复时按 screen.workArea 夹；
//   2) main.js 保存时用 getNormalBounds()（最大化时 getBounds() 返回最大化矩形），
//      否则取消最大化后窗口停在普通态大小而不是最大化前尺寸。
// Windows 真机三步（最大化退出 → 重启 → 取消最大化）由作者在发版前手动确认，
// 这里只钉住静态口径与配置上限。

test('V103/WP-26：窗口尺寸上限放宽、main.js 存普通态几何并按工作区夹取', async () => {
  const wide = sanitize({ windowBounds: { x: 0, y: 0, width: 5120, height: 1440 } });
  assert.equal(wide.windowBounds.width, 5120, '5K 宽屏的正常窗口不许被夹到 4000');
  assert.equal(wide.windowBounds.height, 1440);
  const ultrawide = sanitize({ windowBounds: { width: 7680, height: 2160 } });
  assert.equal(ultrawide.windowBounds.width, 7680);
  // 离谱坏值仍有界（不改成无上限）
  const absurd = sanitize({ windowBounds: { width: 1e9, height: 1e9 } });
  assert.ok(absurd.windowBounds.width <= 20000 && absurd.windowBounds.width >= 960, '离谱宽度要有界');
  assert.ok(absurd.windowBounds.height <= 20000 && absurd.windowBounds.height >= 620, '离谱高度要有界');
  // 最小值语义不变
  assert.equal(sanitize({ windowBounds: { width: 100, height: 100 } }).windowBounds.width, 960);
  assert.equal(sanitize({ windowBounds: { width: 100, height: 100 } }).windowBounds.height, 620);

  const main = MAIN_SOURCE;
  // TB-01：钉「用了 getNormalBounds / 普通态几何 + maximized」，不钉临时变量名（`normal` 改名属无害重构）。
  assert.match(
    main,
    /const \w+ = session\.win\.getNormalBounds\(\);/,
    '保存窗口位置要用 getNormalBounds（最大化时 getBounds 是最大化矩形）'
  );
  assert.match(
    main,
    /const nextBounds = \{ \.\.\.\w+, maximized: session\.win\.isMaximized\(\) \};/,
    '存的是普通态几何 + maximized 标志（只构造一次 nextBounds，A4）'
  );
  assert.match(
    main,
    /await configStore\.set\(\{ windowBounds: nextBounds \}, \{ auto: true \}\);/,
    '写盘复用同一份 nextBounds（A4：不在写盘处再展开一次对象）'
  );
  assert.equal(
    /windowBounds: \{ \.\.\.session\.win\.getBounds\(\)/.test(main),
    false,
    '不许再用 getBounds() 存窗口几何（V103 回潮）'
  );
  assert.match(
    main,
    /bounds = clampBounds\(cfg\.windowBounds\);/,
    '恢复窗口位置时仍要按 screen.workArea 夹取（clampBounds）'
  );
});

test('显示排版配置：默认值 + 持久化', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  const cfg = await store.get();
  assert.equal(cfg.editorLineHeight, 1.95);
  assert.equal(cfg.editorLetterSpacing, 0.02);
  assert.equal(cfg.editorPageWidth, 0, '默认通栏');
  assert.equal(cfg.editorPaddingX, 56, '默认左右边距');
  assert.equal(cfg.editorPaper, 'paper');
  assert.deepEqual(cfg.formatOptions, {
    indent: '2',
    blankLines: 'single',
    trimTrailing: true,
    normalizePunct: true,
    removeCjkSpaces: false,
    curlyQuotes: false,
    ellipsis: false
  });

  await store.set({
    editorLineHeight: 2.2,
    editorLetterSpacing: 0.05,
    editorPageWidth: 800,
    editorPaddingX: 24,
    editorPaper: 'cream',
    formatOptions: { indent: true, blankLines: 'none', trimTrailing: true, normalizePunct: false, removeCjkSpaces: true }
  });
  const cfg2 = await createConfigStore(dir).get();
  assert.equal(cfg2.editorLineHeight, 2.2);
  assert.equal(cfg2.editorLetterSpacing, 0.05);
  assert.equal(cfg2.editorPageWidth, 800);
  assert.equal(cfg2.editorPaddingX, 24);
  assert.equal(cfg2.editorPaper, 'cream');
  assert.equal(cfg2.formatOptions.blankLines, 'none');
  assert.equal(cfg2.formatOptions.normalizePunct, false);
  assert.equal(cfg2.formatOptions.removeCjkSpaces, true);
});

test('显示排版配置：脏数据被夹到合理范围', () => {
  const cleaned = sanitize({
    editorLineHeight: 99,
    editorLetterSpacing: -1,
    editorPageWidth: 'x',
    editorPaddingX: 9999,
    editorPaper: 'pink',
    formatOptions: { blankLines: 'weird' }
  });
  assert.equal(cleaned.editorLineHeight, 3);
  assert.equal(cleaned.editorLetterSpacing, 0);
  assert.equal(cleaned.editorPageWidth, 0);
  assert.equal(cleaned.editorPaddingX, 200);
  assert.equal(cleaned.editorPaper, 'paper');
  assert.equal(cleaned.formatOptions.blankLines, 'single');
  assert.equal(cleaned.formatOptions.indent, '2');

  assert.equal(sanitize({ editorPageWidth: 99999 }).editorPageWidth, 1600);
  assert.equal(sanitize({ editorPageWidth: 900 }).editorPageWidth, 900);
  assert.equal(sanitize({ editorPaddingX: 8 }).editorPaddingX, 16);
  assert.equal(sanitize({ editorPaper: 'night' }).editorPaper, 'night');
  assert.equal(sanitize({ editorPaper: 'kraft' }).editorPaper, 'kraft');
});

test('自定义字体：没有字体文件时回落内置字体', () => {
  assert.equal(sanitize({ editorFont: 'custom' }).editorFont, 'serif', '缺路径不能停在 custom');
  const custom = sanitize({
    editorFont: 'custom',
    editorCustomFontPath: 'D:\\fonts\\我的字体.ttf',
    editorCustomFontName: '我的字体.ttf'
  });
  assert.equal(custom.editorFont, 'custom');
  assert.equal(custom.editorCustomFontPath, 'D:\\fonts\\我的字体.ttf');
  assert.equal(custom.editorCustomFontName, '我的字体.ttf');
  assert.equal(sanitize({ editorCustomFontPath: 123 }).editorCustomFontPath, '');
});

test('按书显示设置：只存改过的项，脏数据被清洗', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  const bookId = 'b_test-book';

  assert.deepEqual(await store.getBookDisplay(bookId), {});

  const saved = await store.setBookDisplay(bookId, {
    editorPaper: 'night',
    editorSidebarWidth: 420,
    editorLineHeight: 2.2
  });
  assert.equal(saved.editorPaper, 'night');
  assert.equal(saved.editorSidebarWidth, 420);
  assert.equal(saved.editorLineHeight, 2.2);
  // 没改的项不写进覆盖，继续沿用全局
  assert.equal(Object.prototype.hasOwnProperty.call(saved, 'editorFont'), false);

  // 再改一项是合并，不会把之前的覆盖冲掉
  await store.setBookDisplay(bookId, { editorFont: 'kai' });
  const merged = await store.getBookDisplay(bookId);
  assert.equal(merged.editorFont, 'kai');
  assert.equal(merged.editorPaper, 'night');
  assert.equal(merged.editorSidebarWidth, 420);

  // 全局设置不受这本书的覆盖影响
  const cfg = await store.get();
  assert.equal(cfg.editorPaper, 'paper');
  assert.equal(cfg.editorFont, 'serif');

  // 重启后仍在
  const display = await createConfigStore(dir).getBookDisplay(bookId);
  assert.equal(display.editorPaper, 'night');

  // 直到点「恢复本书默认」才删掉覆盖
  assert.equal(await store.resetBookDisplay(bookId), true);
  assert.deepEqual(await store.getBookDisplay(bookId), {});
  assert.equal(await store.resetBookDisplay(bookId), false, '没有覆盖时再重置返回 false');
});

// CI-4（五-L2）：config:set 带 bookDisplay 时，旧实现用队列外快照整 map 合并 → 与并发的
// book:set-display 互相吞更新（窗口 B 刚更新的书 X 被窗口 A 的旧快照整份盖回）。
// 现在「并 map」合并挪进 set 的写队列，用队列内刚读到的 current 重算。

test('五-L2（CI-4）：set 的 bookDisplayPatch 在写队列内合并，不吞并发 book:set-display 的更新', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await store.load();
  // A 窗口的按书更新先入队，B 窗口的 config:set（带另一本书的显示 patch）后入队
  const displayFirst = store.setBookDisplay('b_bookA', { editorFontSize: 20 });
  const configSet = store.set({ dailyGoal: 1234 }, {
    bookDisplayPatch: { b_bookB: { editorFontSize: 18 } }
  });
  const [display, saved] = await Promise.all([displayFirst, configSet]);
  assert.deepEqual(display, { editorFontSize: 20 });
  assert.equal(saved.dailyGoal, 1234);
  assert.equal(
    saved.bookDisplay.b_bookA.editorFontSize,
    20,
    'A 窗口刚写进队列的按书更新不许被 B 的旧快照吞掉'
  );
  assert.equal(saved.bookDisplay.b_bookB.editorFontSize, 18, 'B 的按书 patch 照常合并进 map');
  // 落盘与内存一致（写队列内的合并结果就是最终配置）
  const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(onDisk.bookDisplay.b_bookA.editorFontSize, 20);
  assert.equal(onDisk.bookDisplay.b_bookB.editorFontSize, 18);
  // 没带 bookDisplayPatch 时：原有条目一个都不动（口径与旧实现一致）
  const next = await store.set({ dailyGoal: 2000 });
  assert.equal(next.bookDisplay.b_bookA.editorFontSize, 20);
  assert.equal(next.bookDisplay.b_bookB.editorFontSize, 18);
});

test('按书显示设置：非法值按全局规则夹紧，非法 bookId 被忽略', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await store.setBookDisplay('b_x', {
    editorPaper: 'pink',
    editorFontSize: 999,
    editorPageWidth: 99999,
    editorCustomFontPath: 123
  });
  const display = await store.getBookDisplay('b_x');
  assert.equal(display.editorPaper, 'paper');
  assert.equal(display.editorFontSize, 30);
  assert.equal(display.editorPageWidth, 1600);
  assert.equal(display.editorCustomFontPath, '');
  // 覆盖成 custom 但没路径：该项不算数
  const custom = await store.setBookDisplay('b_y', { editorFont: 'custom' });
  assert.deepEqual(custom, {});

  const cleaned = sanitize({
    bookDisplay: {
      '  ': { editorPaper: 'night' },
      'b_ok': { editorPaper: 'kraft', editorSidebarWidth: 9999 }
    }
  });
  assert.deepEqual(Object.keys(cleaned.bookDisplay), ['b_ok']);
  assert.equal(cleaned.bookDisplay.b_ok.editorPaper, 'kraft');
  assert.equal(cleaned.bookDisplay.b_ok.editorSidebarWidth, 800);
  assert.equal(sanitize({ bookDisplay: 'not-an-object' }).bookDisplay && Object.keys(sanitize({ bookDisplay: 'not-an-object' }).bookDisplay).length, 0);
});

// 五-M28（CI-5）：bookDisplay 是唯一「条目数无上限」的已知配置键 —— 每次 get() 全量深拷贝、
// 每次自动写盘整份序列化，注入威胁模型下一次 config:set 就能把 config.json 撑到数十 MB。
// 现在条目数按 BOOK_DISPLAY_MAX 截断（按插入顺序保留先出现的），落盘 / 深拷贝都有界。

test('五-M28（CI-5）：bookDisplay 条目数有上限，超限配置按插入顺序截断', async () => {
  const over = BOOK_DISPLAY_MAX + 50;
  const big = {};
  for (let i = 0; i < over; i += 1) big[`b_${i}`] = { editorFontSize: 20 + (i % 5) };
  const cleaned = sanitize({ bookDisplay: big });
  assert.equal(Object.keys(cleaned.bookDisplay).length, BOOK_DISPLAY_MAX, '清洗后的条目数必须有界');
  assert.ok(Object.prototype.hasOwnProperty.call(cleaned.bookDisplay, 'b_0'), '先出现的条目保留');
  assert.equal(
    Object.prototype.hasOwnProperty.call(cleaned.bookDisplay, `b_${BOOK_DISPLAY_MAX}`),
    false,
    '超出上限的条目丢弃'
  );

  // 真文件往返：磁盘上已经是超限配置，读进来也必须是有界的（writeJsonAtomic 不经过清洗）
  const dir = await mkTmp();
  await writeJsonAtomic(path.join(dir, 'config.json'), { bookDisplay: big });
  const store = createConfigStore(dir);
  const cfg = await store.get();
  assert.equal(Object.keys(cfg.bookDisplay).length, BOOK_DISPLAY_MAX);
  // 再写一次后磁盘上的条目数同样有界（不会把整份超限 map 原样留在文件里）
  await store.set({ dailyGoal: 2000 });
  const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(Object.keys(onDisk.bookDisplay).length, BOOK_DISPLAY_MAX);
});

// T-18（三次审查）：bookDisplay 满额时新书条目会被 sanitizeBookDisplay 按插入序截断在末尾，
// 旧实现直接回 {}，调用方把空对象当「设置成功且无覆盖」。现在写盘后核对该 key 是否存活，
// 被截断就显式抛 BOOK_DISPLAY_FULL（软错误），不再伪成功。
test('T-18：bookDisplay 满额时 setBookDisplay 显式失败（不伪成功），已有条目照常可改', async () => {
  const full = {};
  for (let i = 0; i < BOOK_DISPLAY_MAX; i += 1) full[`b_${i}`] = { editorFontSize: 20 + (i % 5) };
  const dir = await mkTmp();
  await writeJsonAtomic(path.join(dir, 'config.json'), { bookDisplay: full });
  const store = createConfigStore(dir);
  await assert.rejects(
    () => store.setBookDisplay('b_new', { editorPaper: 'night' }),
    (err) => err && err.code === 'BOOK_DISPLAY_FULL' && /上限/.test(err.message)
  );
  const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(onDisk.bookDisplay.b_new, undefined, '被截断的条目不能假装写进去了');
  assert.equal(Object.keys(onDisk.bookDisplay).length, BOOK_DISPLAY_MAX, '条目数仍有界');
  // 已有条目（不是新增、不触发截断）照常可改
  const changed = await store.setBookDisplay('b_0', { editorPaper: 'night' });
  assert.equal(changed.editorPaper, 'night');
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')).bookDisplay.b_0.editorPaper, 'night');
});

test('当前段落高亮（N10b）：默认关 + 跟随主题；旧配置缺字段照常启动', () => {
  const cfg = sanitize({});
  assert.equal(cfg.caretParagraph, false);
  assert.equal(cfg.caretParagraphColor, '');
  assert.equal(DEFAULTS.caretParagraph, false);
  assert.equal(DEFAULTS.caretParagraphColor, '');

  // 旧配置文件（v0.4.1 形状）里没有这两个键：读取后补的是默认值，不影响其它设置
  const old = sanitize({ booksRoot: 'D:\\旧书架', editorFont: 'kai', editorPaper: 'night' });
  assert.equal(old.caretParagraph, false);
  assert.equal(old.caretParagraphColor, '');
  assert.equal(old.editorPaper, 'night');
  assert.equal(old.booksRoot, 'D:\\旧书架');
});

test('当前段落高亮（N10b）：开关只认布尔 true；颜色清洗成 #rrggbb 或回空', () => {
  assert.equal(sanitize({ caretParagraph: true }).caretParagraph, true);
  assert.equal(sanitize({ caretParagraph: 'true' }).caretParagraph, false);
  assert.equal(sanitize({ caretParagraph: 1 }).caretParagraph, false);
  assert.equal(sanitize({ caretParagraph: false }).caretParagraph, false);

  assert.equal(sanitize({ caretParagraphColor: '#3F7FBF' }).caretParagraphColor, '#3f7fbf');
  assert.equal(sanitize({ caretParagraphColor: '#ABC' }).caretParagraphColor, '#aabbcc');
  assert.equal(sanitize({ caretParagraphColor: ' #abc ' }).caretParagraphColor, '#aabbcc');
  assert.equal(sanitize({ caretParagraphColor: 'red' }).caretParagraphColor, '');
  assert.equal(sanitize({ caretParagraphColor: '#12345' }).caretParagraphColor, '');
  assert.equal(sanitize({ caretParagraphColor: null }).caretParagraphColor, '');
});

test('当前段落高亮（N10b）：按书覆盖能存开关 / 颜色，并与全局默认分开', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);

  // 全局默认：打开 + 一个颜色
  await store.set({ caretParagraph: true, caretParagraphColor: '#c8873c' });
  let cfg = await store.get();
  assert.equal(cfg.caretParagraph, true);
  assert.equal(cfg.caretParagraphColor, '#c8873c');

  // A 书：单独关掉 + 自定义颜色；B 书：不设置（沿用全局）
  assert.deepEqual(await store.setBookDisplay('b_a', { caretParagraph: false, caretParagraphColor: '#3f7fbf' }), {
    caretParagraph: false,
    caretParagraphColor: '#3f7fbf'
  });
  assert.deepEqual(await store.getBookDisplay('b_b'), {});
  assert.equal((await store.get()).caretParagraph, true, '按书覆盖不写回全局');

  // 重启后仍在：A 书两项都在，B 书仍为空（= 回落全局）
  const store2 = createConfigStore(dir);
  assert.deepEqual(await store2.getBookDisplay('b_a'), {
    caretParagraph: false,
    caretParagraphColor: '#3f7fbf'
  });
  assert.deepEqual(await store2.getBookDisplay('b_b'), {});

  // 只改开关不会冲掉颜色；把颜色清成 '' 仍是「有效的按书覆盖」（这本书回到主题色）
  assert.deepEqual(await store2.setBookDisplay('b_a', { caretParagraph: true }), {
    caretParagraph: true,
    caretParagraphColor: '#3f7fbf'
  });
  assert.deepEqual(await store2.setBookDisplay('b_a', { caretParagraphColor: '' }), {
    caretParagraph: true,
    caretParagraphColor: ''
  });

  // 写坏的按书值被清洗：颜色回空、开关回 false，但这两个键本身仍作为覆盖保留
  assert.deepEqual(await store2.setBookDisplay('b_c', { caretParagraph: 'yes', caretParagraphColor: 'blue' }), {
    caretParagraph: false,
    caretParagraphColor: ''
  });

  // 恢复本书默认：两项一起清掉，回全局
  assert.equal(await store2.resetBookDisplay('b_a'), true);
  assert.deepEqual(await store2.getBookDisplay('b_a'), {});
  cfg = await createConfigStore(dir).get();
  assert.equal(cfg.caretParagraph, true);
  assert.equal(cfg.caretParagraphColor, '#c8873c');
});

test('编辑器小件开关按书记忆（1.1.0）：白名单只认 true / false，按书往返，旧配置照常读', async () => {
  // 白名单 / 清洗：只有真正的布尔能进 bookDisplay；'true' / 1 / null / 对象一律当 false（默认关）
  const cleaned = sanitize({
    bookDisplay: {
      b_on: { marksInvisibles: true, marksLongParagraphs: false },
      b_str: { marksInvisibles: 'true', marksLongParagraphs: 1 },
      b_bad: { marksInvisibles: null, marksLongParagraphs: {} },
      b_other: { editorPaper: 'night' }
    }
  });
  assert.deepEqual(cleaned.bookDisplay.b_on, { marksInvisibles: true, marksLongParagraphs: false });
  assert.deepEqual(cleaned.bookDisplay.b_str, { marksInvisibles: false, marksLongParagraphs: false });
  assert.deepEqual(cleaned.bookDisplay.b_bad, { marksInvisibles: false, marksLongParagraphs: false });
  assert.deepEqual(cleaned.bookDisplay.b_other, { editorPaper: 'night' }, '别的按书字段不受影响');

  // 旧 config：没有这两个键、没有 bookDisplay 也照常读；全局配置里不会凭空多出这两个键
  const old = sanitize({ booksRoot: 'D:\\旧书架', editorFont: 'kai', editorPaper: 'night' });
  assert.deepEqual(old.bookDisplay, {});
  assert.equal('marksInvisibles' in old, false, '全局默认固定关，不落全局键');
  assert.equal('marksLongParagraphs' in old, false);
  assert.equal(old.editorPaper, 'night');

  // 写盘往返：A 书开「不可见字符」→ 只多这一个键；再开「超长段落」→ 两项都在；B 书仍是空（= 回落默认关）
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  assert.deepEqual(await store.getBookDisplay('b_a'), {});
  assert.deepEqual(await store.setBookDisplay('b_a', { marksInvisibles: true }), { marksInvisibles: true });
  assert.deepEqual(await store.setBookDisplay('b_a', { marksLongParagraphs: true }), {
    marksInvisibles: true,
    marksLongParagraphs: true
  });
  assert.deepEqual(await store.getBookDisplay('b_b'), {}, '没设置过的书没有覆盖');
  const disk = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(disk.bookDisplay.b_a, { marksInvisibles: true, marksLongParagraphs: true });
  assert.equal(disk.bookDisplay.b_b, undefined);
  assert.equal('marksInvisibles' in disk, false, '只写按书覆盖，不写全局默认');

  // 重启后仍在；关掉记 false（不是删键）；「恢复本书默认」清掉整个覆盖后回落默认关
  const store2 = createConfigStore(dir);
  assert.deepEqual(await store2.getBookDisplay('b_a'), {
    marksInvisibles: true,
    marksLongParagraphs: true
  });
  assert.deepEqual(await store2.setBookDisplay('b_a', { marksInvisibles: false }), {
    marksInvisibles: false,
    marksLongParagraphs: true
  });
  assert.equal((await store2.getBookDisplay('b_a')).marksInvisibles, false, '关掉后记 false');
  assert.equal(await store2.resetBookDisplay('b_a'), true);
  assert.deepEqual(await store2.getBookDisplay('b_a'), {}, '恢复本书默认后回落全局默认（关）');
  const afterReset = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(afterReset.bookDisplay.b_a, undefined);
});

test('中西文自动间距（1.3.0 T-08）：默认开、只有真正的 false 才关、可按书覆盖', async () => {
  // 规范 T-08 / 作业卡 T1：默认开启 + 设置里可关；配置字段 editorTextAutospace（bool，默认 true）。
  assert.equal(DEFAULTS.editorTextAutospace, true, '默认值必须登记在 DEFAULTS（否则会被白名单丢掉）');
  // 旧配置没有这个键 = 开；手改写坏的 'false' / 0 / null / 对象也都按开（宁可多留一点间距，不误关）
  assert.equal(sanitize({}).editorTextAutospace, true);
  assert.equal(sanitize({ booksRoot: 'D:\\旧书架', editorFont: 'kai' }).editorTextAutospace, true);
  for (const bad of ['false', 0, 1, null, {}, []]) {
    assert.equal(sanitize({ editorTextAutospace: bad }).editorTextAutospace, true, `坏值 ${JSON.stringify(bad)} 按默认开`);
  }
  assert.equal(sanitize({ editorTextAutospace: false }).editorTextAutospace, false, '只有真正的 false 才关');

  // 按书覆盖：和别的按书显示项同一个口径（只认真正的布尔），没设置过的书沿用全局
  const cleaned = sanitize({
    bookDisplay: {
      b_on: { editorTextAutospace: true },
      b_off: { editorTextAutospace: false },
      b_str: { editorTextAutospace: 'false' },
      b_other: { editorPaper: 'night' }
    }
  });
  assert.deepEqual(cleaned.bookDisplay.b_on, { editorTextAutospace: true });
  assert.deepEqual(cleaned.bookDisplay.b_off, { editorTextAutospace: false });
  assert.deepEqual(cleaned.bookDisplay.b_str, { editorTextAutospace: true }, '按书写坏的类型按开');
  assert.deepEqual(cleaned.bookDisplay.b_other, { editorPaper: 'night' }, '别的按书字段不受影响');

  // 写盘往返：关掉后记 false（不是删键）；重启后仍是 false；恢复本书默认后清掉覆盖回到全局开
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  assert.equal((await store.get()).editorTextAutospace, true, '新配置默认开');
  const stored = await store.set({ editorTextAutospace: false });
  assert.equal(stored.editorTextAutospace, false);
  assert.equal((await createConfigStore(dir).get()).editorTextAutospace, false, '重启后仍是关');
  assert.deepEqual(await store.setBookDisplay('b_a', { editorTextAutospace: false }), { editorTextAutospace: false });
  const disk = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(disk.bookDisplay.b_a.editorTextAutospace, false);
  assert.equal(await store.resetBookDisplay('b_a'), true);
  assert.deepEqual(await store.getBookDisplay('b_a'), {});
});

test('首次运行提示（1.3.0 T5）：默认未提示、只有真正的 true 才算已提示、写盘往返只动这一个字段', async () => {
  // 规范 I-10 / 作业卡 T5：书架底部状态行的一次性提示只出现一次，已提示标记存 config。
  assert.equal(DEFAULTS.firstRunTipShown, false, '默认值必须登记在 DEFAULTS（否则会被白名单丢掉）');
  assert.equal(sanitize({}).firstRunTipShown, false);
  assert.equal(sanitize({ booksRoot: 'D:\\旧书架' }).firstRunTipShown, false, '旧配置没有这个键 = 还没提示过');
  for (const bad of ['true', 1, null, {}, []]) {
    assert.equal(sanitize({ firstRunTipShown: bad }).firstRunTipShown, false, `坏值 ${JSON.stringify(bad)} 按未提示`);
  }
  assert.equal(sanitize({ firstRunTipShown: true }).firstRunTipShown, true, '只有真正的 true 才算已提示');

  // 写盘往返：显示过才写 true（不是删键）；重启后仍是已提示；别的记忆保持默认
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  assert.equal((await store.get()).firstRunTipShown, false, '新配置未提示');
  const stored = await store.set({ firstRunTipShown: true });
  assert.equal(stored.firstRunTipShown, true);
  assert.equal((await createConfigStore(dir).get()).firstRunTipShown, true, '重启后仍是已提示');
  const disk = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(disk.firstRunTipShown, true);
  assert.equal(disk.lastBook, null, '没有顺手写别的记忆');
  assert.equal(disk.editorPageWidth, 0);
});

test('超长段落阈值（1.1.0）：默认 500、夹紧 50–20000、非法值回落；全局默认与按书覆盖分开', async () => {
  // core 不能 require 渲染层，所以 core 侧留了同口径常量；这里用 editor-logic 的真实常量 / 边界
  // 钉住两边一致（默认值与 49→50 / 20001→20000 的行为必须同口径，用例表在 tests/clamp-contracts.js）。
  const editorLogic = require('../renderer/editor-logic');
  assert.equal(DEFAULTS.longParagraphThreshold, editorLogic.LONG_PARAGRAPH_DEFAULT, '默认值必须两处一致');
  assert.equal(DEFAULTS.longParagraphThreshold, 500);
  assert.deepEqual(editorLogic.LONG_PARAGRAPH_LIMITS, [50, 20000], '夹紧区间必须两处一致');

  // 全局默认：旧配置没有这个键 = 500，别的字段照常读
  assert.equal(sanitize({}).longParagraphThreshold, 500);
  const old = sanitize({ booksRoot: 'D:\\旧书架', editorFont: 'kai', editorPaper: 'night' });
  assert.equal(old.longParagraphThreshold, 500);
  assert.equal(old.booksRoot, 'D:\\旧书架');
  assert.equal(old.editorPaper, 'night');

  // 边界：夹紧口径只有一份（tests/clamp-contracts.js 的 LONG_PARAGRAPH_THRESHOLD_CASES），
  // 配置层 / 编辑器标记层 / 设置面板回填三层共用（T8：以前三个文件各抄一张同样的表）。
  for (const { raw, expected, note } of LONG_PARAGRAPH_THRESHOLD_CASES) {
    assert.equal(sanitize({ longParagraphThreshold: raw }).longParagraphThreshold, expected, `${note}（${String(raw)}）`);
  }
  // 配置层独有的一条：null / [] 算坏类型 → 500（clampInt 走 Number() 会得 0 → 50，见 clamp-contracts 文件头）
  for (const { raw, expected, note } of LONG_PARAGRAPH_THRESHOLD_CORE_ONLY_CASES) {
    assert.equal(sanitize({ longParagraphThreshold: raw }).longParagraphThreshold, expected, `${note}（${String(raw)}）`);
  }
  // 可输入小数：和配置层其它整数字段一样四舍五入（620.4→620 / 620.6→621）
  assert.equal(sanitize({ longParagraphThreshold: 620.4 }).longParagraphThreshold, 620);
  assert.equal(sanitize({ longParagraphThreshold: 620.6 }).longParagraphThreshold, 621);
  assert.equal(sanitize({ longParagraphThreshold: '620' }).longParagraphThreshold, 620, '数字字符串算合法');

  // 按书白名单：同一口径夹紧，坏值回落 500；别的按书字段不受影响
  const cleaned = sanitize({
    bookDisplay: {
      b_small: { longParagraphThreshold: 49 },
      b_big: { longParagraphThreshold: 20001 },
      b_bad: { longParagraphThreshold: 'abc' },
      b_nan: { longParagraphThreshold: NaN },
      b_ok: { longParagraphThreshold: 620, editorPaper: 'night' }
    }
  });
  assert.equal(cleaned.bookDisplay.b_small.longParagraphThreshold, 50);
  assert.equal(cleaned.bookDisplay.b_big.longParagraphThreshold, 20000);
  assert.equal(cleaned.bookDisplay.b_bad.longParagraphThreshold, 500);
  assert.equal(cleaned.bookDisplay.b_nan.longParagraphThreshold, 500);
  assert.deepEqual(cleaned.bookDisplay.b_ok, { longParagraphThreshold: 620, editorPaper: 'night' });
  assert.equal(cleaned.longParagraphThreshold, 500, '按书覆盖不回写全局');

  // 写盘往返：全局 800 + A 书 620；B 书没有覆盖 = 回落全局（合并发生在渲染层，这里按同一规则验证）
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  assert.equal((await store.get()).longParagraphThreshold, 500);
  await store.set({ longParagraphThreshold: 800 });
  assert.equal((await store.get()).longParagraphThreshold, 800);
  assert.deepEqual(await store.setBookDisplay('b_a', { longParagraphThreshold: 620 }), {
    longParagraphThreshold: 620
  });
  assert.deepEqual(await store.getBookDisplay('b_b'), {});
  const disk = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(disk.longParagraphThreshold, 800);
  assert.deepEqual(disk.bookDisplay.b_a, { longParagraphThreshold: 620 }, '只写按书覆盖这一项');
  assert.equal(disk.bookDisplay.b_b, undefined);
  const effective = (globalCfg, display) => ({ ...globalCfg, ...display });
  assert.equal(effective((await store.get()), await store.getBookDisplay('b_a')).longParagraphThreshold, 620);
  assert.equal(effective((await store.get()), await store.getBookDisplay('b_b')).longParagraphThreshold, 800);

  // 重启后仍在；写入越界值按同一口径夹紧；「恢复本书默认」清掉覆盖后回落全局
  const store2 = createConfigStore(dir);
  assert.equal((await store2.get()).longParagraphThreshold, 800);
  assert.equal((await store2.getBookDisplay('b_a')).longParagraphThreshold, 620);
  assert.deepEqual(await store2.setBookDisplay('b_a', { longParagraphThreshold: 49 }), {
    longParagraphThreshold: 50
  });
  assert.equal(await store2.resetBookDisplay('b_a'), true);
  assert.deepEqual(await store2.getBookDisplay('b_a'), {});
  const afterReset = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(afterReset.bookDisplay.b_a, undefined);
  assert.equal(afterReset.longParagraphThreshold, 800, '恢复本书默认不动全局');
});

test('导出目录记忆：默认空、去首尾空白、坏值回空', () => {
  assert.equal(sanitize({}).lastExportDir, '');
  assert.equal(sanitize({ lastExportDir: '  D:\\xxs  ' }).lastExportDir, 'D:\\xxs');
  assert.equal(sanitize({ lastExportDir: 123 }).lastExportDir, '');
  assert.equal(sanitize({ lastExportDir: null }).lastExportDir, '');
  assert.equal(sanitize({ lastExportDir: 'x'.repeat(2000) }).lastExportDir, '');
});

test('继续上次写作：lastBook 默认空，旧配置没有字段也能读；合法值清洗后保留', () => {
  // 旧配置文件里没有 lastBook：当作没记过，不影响其它设置
  assert.equal(DEFAULTS.lastBook, null);
  const old = sanitize({ booksRoot: 'D:\\旧书架', editorFont: 'kai' });
  assert.equal(old.lastBook, null);
  assert.equal(old.booksRoot, 'D:\\旧书架');

  assert.equal(sanitizeLastBook(null), null);
  assert.equal(sanitizeLastBook('not-an-object'), null);
  assert.equal(sanitizeLastBook([]), null);
  assert.equal(sanitizeLastBook({ path: '   ' }), null, '没有路径就不算「上次写作」');
  assert.equal(sanitizeLastBook({ path: 123 }), null, '非字符串路径直接作废');

  const recent = sanitizeLastBook({
    path: '  D:\\书架\\星海旅人  ',
    title: ' 星海旅人 ',
    chapterId: ' ch_012 ',
    chapterIndex: 11,
    chapterName: ' 夜雨 ',
    at: 1760000000123.7
  });
  assert.deepEqual(recent, {
    path: 'D:\\书架\\星海旅人',
    title: '星海旅人',
    chapterId: 'ch_012',
    chapterIndex: 11,
    chapterName: '夜雨',
    at: 1760000000124
  });
});

test('继续上次写作：lastBook 脏值兜底（越界下标/坏时间戳/超长文本）', () => {
  const base = { path: 'D:\\书架\\书' };
  assert.equal(sanitizeLastBook({ ...base, chapterIndex: -5 }).chapterIndex, 0);
  assert.equal(sanitizeLastBook({ ...base, chapterIndex: 1e9 }).chapterIndex, 1000000);
  assert.equal(sanitizeLastBook({ ...base, chapterIndex: 'x' }).chapterIndex, 0);
  assert.equal(sanitizeLastBook({ ...base, chapterIndex: 2.6 }).chapterIndex, 3);
  assert.equal(sanitizeLastBook({ ...base, at: 'abc' }).at, 0);
  assert.equal(sanitizeLastBook({ ...base, at: -1 }).at, 0);
  assert.equal(sanitizeLastBook({ ...base, at: '1760000000000' }).at, 1760000000000);
  assert.equal(sanitizeLastBook({ ...base, title: 123 }).title, '');
  assert.equal(sanitizeLastBook({ ...base, chapterName: 'x'.repeat(300) }).chapterName.length, 200);
  assert.equal(sanitizeLastBook({ ...base, path: 'x'.repeat(2000) }), null);
});

test('继续上次写作：lastBook 写盘 / 读回 / 清空，且不动其它配置', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  const recent = {
    path: 'D:\\书架\\星海旅人',
    title: '星海旅人',
    chapterId: 'ch_003',
    chapterIndex: 2,
    chapterName: '夜雨',
    at: 1760000000000
  };
  await store.set({ lastBook: recent });
  const cfg = await store.get();
  assert.deepEqual(cfg.lastBook, recent);
  assert.equal(cfg.editorPaper, 'paper', '写 lastBook 不能把其它配置冲掉');

  // 真的落进了 config.json，重启后能读回
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(raw.lastBook, recent);
  const reopened = await createConfigStore(dir).get();
  assert.deepEqual(reopened.lastBook, recent);

  // 坏值写入会被清成 null（不保留半条脏记录）
  await store.set({ lastBook: { path: '', chapterId: 'x' } });
  assert.equal((await store.get()).lastBook, null);

  // null 可以清掉记录
  await store.set({ lastBook: recent });
  await store.set({ lastBook: null });
  assert.equal((await createConfigStore(dir).get()).lastBook, null);
});

// C28（v1.8.0 WP-26）：最近书的「读旧值 → 去重 / at 守卫 → 写盘」必须全在 configStore 的写队列里。
// 旧实现由 main.js 在 set 前单独 get：两个窗口并发时都基于同一份旧值通过守卫，迟到的旧记录会盖掉新记录。

test('C28/WP-26：最近书比较进写队列——并发两条记录里，迟到的旧记录不会盖掉更晚的记录', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  const base = {
    path: 'D:\\书架\\书A',
    title: '书A',
    chapterIndex: 1,
    chapterName: '第二章',
    at: 2_000_000
  };
  const newer = { ...base, chapterId: 'ch_2' };
  const older = { ...base, chapterId: 'ch_1', chapterIndex: 0, chapterName: '第一章', at: 1_000_000 };

  // 同时发起：先发更晚的记录，再发更早的（旧记录若在队列外比较，会基于旧值通过 at 守卫并覆盖）
  const [first, second] = await Promise.all([
    store.rememberLastBook(newer, { now: 2_000_000 }),
    store.rememberLastBook(older, { now: 2_000_000 })
  ]);
  assert.equal(first.written, true);
  assert.equal(second.written, false);
  assert.equal(second.reason, 'stale');
  assert.equal((await store.get()).lastBook.chapterId, 'ch_2', '最终留下的是更晚的记录');
  // 落盘也是更晚那条
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(raw.lastBook.chapterId, 'ch_2');

  // 5 秒去重：同一本书同一章不重复写盘；过了窗口照常更新；换章立即更新
  const dup = await store.rememberLastBook(newer, { now: 2_001_000 });
  assert.equal(dup.written, false);
  assert.equal(dup.reason, 'duplicate');
  const later = await store.rememberLastBook(newer, { now: 2_006_000 });
  assert.equal(later.written, true);
  const changed = await store.rememberLastBook({ ...newer, chapterId: 'ch_3', chapterIndex: 2 }, { now: 2_006_100 });
  assert.equal(changed.written, true);
  assert.equal((await store.get()).lastBook.chapterId, 'ch_3');

  // 坏形状（没有 path / chapterId）按「不是一次记录」处理，不写盘也不抛
  assert.equal((await store.rememberLastBook({ path: '', chapterId: 'ch_1' }, { now: 2_007_000 })).written, false);
  assert.equal((await store.rememberLastBook({ path: 'D:\\书架\\书A' }, { now: 2_007_000 })).reason, 'invalid');
  assert.equal((await store.get()).lastBook.chapterId, 'ch_3');
});

// C29（v1.8.0 WP-26）：bookDisplay 的键是书 id，`__proto__` 必须按自有可枚举属性存（不能改原型）。

test('C29/WP-26：bookDisplay 的 __proto__ 键写成自有属性（不丢覆盖、不污染原型）', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);

  // 读侧：JSON.parse 出来的 `__proto__` 键是真自有属性，清洗后必须保留
  const parsed = JSON.parse('{"bookDisplay":{"__proto__":{"editorFontSize":22}}}');
  const cleaned = sanitize(parsed);
  assert.deepEqual(Object.keys(cleaned.bookDisplay), ['__proto__']);
  assert.equal(cleaned.bookDisplay['__proto__'].editorFontSize, 22);
  assert.equal(Object.getPrototypeOf(cleaned.bookDisplay), Object.prototype, '不许改成原型');
  assert.deepEqual(
    Object.keys({ ...cleaned.bookDisplay }),
    ['__proto__'],
    'spread 之后条目还在（以前会静默丢）'
  );

  // 写侧：setBookDisplay('__proto__') / getBookDisplay / 落盘 / 清空
  await store.setBookDisplay('__proto__', { editorFontSize: 22 });
  assert.deepEqual(await store.getBookDisplay('__proto__'), { editorFontSize: 22 });
  assert.equal(({}).editorFontSize, undefined, '全局原型没被污染');
  const disk = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(disk.bookDisplay['__proto__'].editorFontSize, 22, '落盘的是真条目');
  assert.equal(await store.resetBookDisplay('__proto__'), true);
  assert.deepEqual(await store.getBookDisplay('__proto__'), {});
});
