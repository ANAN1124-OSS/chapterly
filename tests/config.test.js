const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createConfigStore, sanitize, sanitizeLastBook, DEFAULTS } = require('../core/config');
const { writeJsonAtomic } = require('../core/atomic');
const { readGlossaryFile, readGlossaryFiles } = require('../core/glossary');

const tmpCleanup = require('./tmp-cleanup');

async function mkTmp() {
  return tmpCleanup.track(await fs.mkdtemp(path.join(os.tmpdir(), 'cw-config-')));
}

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

  const main = (await fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8')).replace(/\r\n/g, '\n');
  assert.match(
    main,
    /const normal = session\.win\.getNormalBounds\(\);/,
    '保存窗口位置要用 getNormalBounds（最大化时 getBounds 是最大化矩形）'
  );
  assert.match(
    main,
    /windowBounds: \{ \.\.\.normal, maximized: session\.win\.isMaximized\(\) \}/,
    '存的是普通态几何 + maximized 标志'
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
  // 钉住两边一致（默认值与 49→50 / 20001→20000 的行为必须同口径）。
  const editorLogic = require('../renderer/editor-logic');
  const [limitMin, limitMax] = editorLogic.LONG_PARAGRAPH_LIMITS;
  assert.equal(DEFAULTS.longParagraphThreshold, editorLogic.LONG_PARAGRAPH_DEFAULT, '默认值必须两处一致');
  assert.equal(DEFAULTS.longParagraphThreshold, 500);
  assert.deepEqual(editorLogic.LONG_PARAGRAPH_LIMITS, [50, 20000]);

  // 全局默认：旧配置没有这个键 = 500，别的字段照常读
  assert.equal(sanitize({}).longParagraphThreshold, 500);
  const old = sanitize({ booksRoot: 'D:\\旧书架', editorFont: 'kai', editorPaper: 'night' });
  assert.equal(old.longParagraphThreshold, 500);
  assert.equal(old.booksRoot, 'D:\\旧书架');
  assert.equal(old.editorPaper, 'night');

  // 边界：49→50 / 20001→20000 / 正好 50 / 20000 保留 / NaN 与坏类型回落 500
  assert.equal(sanitize({ longParagraphThreshold: 49 }).longParagraphThreshold, limitMin);
  assert.equal(sanitize({ longParagraphThreshold: 50 }).longParagraphThreshold, 50);
  assert.equal(sanitize({ longParagraphThreshold: 20000 }).longParagraphThreshold, 20000);
  assert.equal(sanitize({ longParagraphThreshold: 20001 }).longParagraphThreshold, limitMax);
  assert.equal(sanitize({ longParagraphThreshold: NaN }).longParagraphThreshold, 500);
  for (const bad of ['abc', null, undefined, {}, [], Infinity, -Infinity]) {
    assert.equal(sanitize({ longParagraphThreshold: bad }).longParagraphThreshold, 500, String(bad));
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
  assert.equal(sanitize({ bookDisplay: 'not-an-object' }).bookDisplay && Object.keys(sanitize({ bookDisplay: 'not-an-object' }).bookDisplay).length, 0);

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

test('配置损坏：归档坏文件、回默认值，并给出一次提示', async () => {
  const dir = await mkTmp();
  await fs.writeFile(path.join(dir, 'config.json'), '{ 这不是合法 JSON ', 'utf8');
  const store = createConfigStore(dir);
  const cfg = await store.get();
  assert.equal(cfg.booksRoot, DEFAULTS.booksRoot);
  const warning = store.takeLoadWarning();
  assert.ok(warning && warning.code === 'CONFIG_CORRUPT');
  assert.equal(store.takeLoadWarning(), null, '提示只给一次');
  const files = await fs.readdir(dir);
  assert.ok(files.some((f) => f.startsWith('config.json.corrupt-')), '坏配置要归档，不能直接删');
  assert.ok(!files.includes('config.json'), '坏文件应已改名归档');
});

test('首次启动（没有配置文件）不算损坏，不提示', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await store.get();
  assert.equal(store.takeLoadWarning(), null);
});

test('配置并发写入：两个 set 的 patch 都不会被吞掉', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await Promise.all([
    store.set({ editorPaper: 'night' }),
    store.set({ editorFontSize: 22 })
  ]);
  const cfg = await store.get();
  assert.equal(cfg.editorPaper, 'night');
  assert.equal(cfg.editorFontSize, 22);
});

test('每日快照配置：默认关闭、保留 7 天，旧配置没有这两个键也照常启动', async () => {
  const dir = await mkTmp();
  // 模拟 v0.4.1 的旧配置：完全没有 snapshot 字段
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ booksRoot: 'D:\\旧书架', editorFont: 'kai' }, null, 2),
    'utf8'
  );
  const cfg = await createConfigStore(dir).get();
  assert.equal(cfg.snapshotEnabled, false, '旧配置/缺字段必须按「关」处理');
  assert.equal(cfg.snapshotKeepDays, 7);
  assert.equal(cfg.editorFont, 'kai', '旧配置其它字段不受影响');
});

test('每日快照配置：脏值清洗（只认 true、天数夹到 1–90）', () => {
  assert.equal(sanitize({ snapshotEnabled: 'true' }).snapshotEnabled, false);
  assert.equal(sanitize({ snapshotEnabled: 1 }).snapshotEnabled, false);
  assert.equal(sanitize({ snapshotEnabled: true }).snapshotEnabled, true);
  assert.equal(sanitize({ snapshotKeepDays: 0 }).snapshotKeepDays, 1);
  assert.equal(sanitize({ snapshotKeepDays: 999 }).snapshotKeepDays, 90);
  assert.equal(sanitize({ snapshotKeepDays: 'abc' }).snapshotKeepDays, 7);
  assert.equal(sanitize({ snapshotKeepDays: 14.6 }).snapshotKeepDays, 15);
});

test('每日快照配置：写盘 / 读回，不影响其它配置', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await store.set({ snapshotEnabled: true, snapshotKeepDays: 3, editorFont: 'sans' });
  const reopened = await createConfigStore(dir).get();
  assert.equal(reopened.snapshotEnabled, true);
  assert.equal(reopened.snapshotKeepDays, 3);
  assert.equal(reopened.editorFont, 'sans');
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(raw.snapshotEnabled, true);
  assert.equal(raw.snapshotKeepDays, 3);

  // 关掉后能真正清掉（不会残留 true）
  await store.set({ snapshotEnabled: false });
  assert.equal((await createConfigStore(dir).get()).snapshotEnabled, false);
});

test('每日目标配置：默认 0（不设目标），旧配置没有 dailyGoal 也照常启动', async () => {
  const dir = await mkTmp();
  // 模拟 v0.4.1 / v0.6-2 的旧配置：没有 dailyGoal 字段
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ booksRoot: 'D:\\旧书架', snapshotEnabled: true, snapshotKeepDays: 3 }, null, 2),
    'utf8'
  );
  const cfg = await createConfigStore(dir).get();
  assert.equal(cfg.dailyGoal, 0, '旧配置缺字段 = 不设目标');
  assert.equal(cfg.snapshotEnabled, true, '旧配置其它字段不受影响');
  assert.equal(cfg.snapshotKeepDays, 3);
});

test('每日目标配置：脏值清洗（负数/NaN 回落 0，超大夹到上限）', () => {
  assert.equal(sanitize({ dailyGoal: -100 }).dailyGoal, 0);
  assert.equal(sanitize({ dailyGoal: 'abc' }).dailyGoal, 0);
  assert.equal(sanitize({ dailyGoal: null }).dailyGoal, 0);
  assert.equal(sanitize({ dailyGoal: 2000 }).dailyGoal, 2000);
  assert.equal(sanitize({ dailyGoal: '2500' }).dailyGoal, 2500);
  assert.equal(sanitize({ dailyGoal: 2000.4 }).dailyGoal, 2000);
  assert.equal(sanitize({ dailyGoal: 99999999 }).dailyGoal, 1000000);
});

test('每日目标配置：写盘 / 读回，只影响 dailyGoal', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await store.set({ dailyGoal: 2000, editorFont: 'kai' });
  const reopened = await createConfigStore(dir).get();
  assert.equal(reopened.dailyGoal, 2000);
  assert.equal(reopened.editorFont, 'kai');
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(raw.dailyGoal, 2000);

  // 0 = 关掉目标，能落盘
  await store.set({ dailyGoal: 0 });
  assert.equal((await createConfigStore(dir).get()).dailyGoal, 0);
});

test('章节模板配置：默认空、旧配置缺字段照常启动、脏值清洗', async () => {
  const dir = await mkTmp();
  assert.equal((await createConfigStore(dir).get()).chapterTemplate, '', '默认不套用模板');
  // 模拟 v0.4.1 / v0.8 N4 的旧配置：完全没有 chapterTemplate
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ booksRoot: 'D:\\旧书架', dailyGoal: 800, writeDurationEnabled: true }, null, 2),
    'utf8'
  );
  const cfg = await createConfigStore(dir).get();
  assert.equal(cfg.chapterTemplate, '', '旧配置缺字段 = 空模板');
  assert.equal(cfg.dailyGoal, 800, '旧配置其它字段不受影响');

  assert.equal(sanitize({ chapterTemplate: 123 }).chapterTemplate, '');
  assert.equal(sanitize({ chapterTemplate: null }).chapterTemplate, '');
  // CRLF / CR 统一成 LF，NUL 去掉
  assert.equal(sanitize({ chapterTemplate: '第{n}章：\r\n\r\n' }).chapterTemplate, '第{n}章：\n\n');
  assert.equal(sanitize({ chapterTemplate: '前\u0000后' }).chapterTemplate, '前后');
  // 超长夹到模板上限 2000
  const long = '字'.repeat(2500);
  assert.equal(sanitize({ chapterTemplate: long }).chapterTemplate.length, 2000);
});

test('章节模板配置：写盘 / 读回，清空后落盘为空', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  const template = '第{n}章：{title}\n\n';
  await store.set({ chapterTemplate: template, editorFont: 'kai' });
  const reopened = await createConfigStore(dir).get();
  assert.equal(reopened.chapterTemplate, template);
  assert.equal(reopened.editorFont, 'kai');
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(raw.chapterTemplate, template);

  // 清空模板 = 关掉，落盘是空串（不是删字段，旧版本读也安全）
  await store.set({ chapterTemplate: '' });
  assert.equal((await createConfigStore(dir).get()).chapterTemplate, '');
  const cleared = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(cleared.chapterTemplate, '');
});

test('敏感词表配置：默认未设置，旧配置缺字段照常启动，脏值清洗成空', async () => {
  const dir = await mkTmp();
  assert.equal((await createConfigStore(dir).get()).sensitiveWordsPath, '');
  // 模拟旧配置：完全没有 sensitiveWordsPath
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ booksRoot: 'D:\\旧书架', dailyGoal: 1200 }, null, 2),
    'utf8'
  );
  const cfg = await createConfigStore(dir).get();
  assert.equal(cfg.sensitiveWordsPath, '');
  assert.equal(cfg.dailyGoal, 1200, '其它字段不受影响');

  assert.equal(sanitize({ sensitiveWordsPath: 123 }).sensitiveWordsPath, '');
  assert.equal(sanitize({ sensitiveWordsPath: null }).sensitiveWordsPath, '');
  assert.equal(sanitize({ sensitiveWordsPath: '   ' }).sensitiveWordsPath, '');
  assert.equal(
    sanitize({ sensitiveWordsPath: '  D:\\词表\\敏感词.txt  ' }).sensitiveWordsPath,
    'D:\\词表\\敏感词.txt'
  );
  assert.equal(sanitize({ sensitiveWordsPath: 'x'.repeat(1001) }).sensitiveWordsPath, '');
});

test('敏感词表配置：写盘 / 读回，清除后落盘为空', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await store.set({ sensitiveWordsPath: 'D:\\词表\\我的词表.txt' });
  const reopened = await createConfigStore(dir).get();
  assert.equal(reopened.sensitiveWordsPath, 'D:\\词表\\我的词表.txt');
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(raw.sensitiveWordsPath, 'D:\\词表\\我的词表.txt');

  await store.set({ sensitiveWordsPath: '' });
  assert.equal((await createConfigStore(dir).get()).sensitiveWordsPath, '');
});

test('校对词表配置：默认未设置，旧配置缺字段照常启动，脏值清洗成空', async () => {
  const dir = await mkTmp();
  assert.equal((await createConfigStore(dir).get()).proofreadWordsPath, '');
  // 模拟旧配置：完全没有 proofreadWordsPath（只有 v0.8 之前的字段）
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ booksRoot: 'D:\\旧书架', dailyGoal: 1200, sensitiveWordsPath: 'D:\\敏感词.txt' }, null, 2),
    'utf8'
  );
  const cfg = await createConfigStore(dir).get();
  assert.equal(cfg.proofreadWordsPath, '');
  assert.equal(cfg.sensitiveWordsPath, 'D:\\敏感词.txt', '另一份词表不受影响');
  assert.equal(cfg.dailyGoal, 1200, '其它字段不受影响');

  assert.equal(sanitize({ proofreadWordsPath: 123 }).proofreadWordsPath, '');
  assert.equal(sanitize({ proofreadWordsPath: null }).proofreadWordsPath, '');
  assert.equal(sanitize({ proofreadWordsPath: '   ' }).proofreadWordsPath, '');
  assert.equal(
    sanitize({ proofreadWordsPath: '  D:\\词表\\校对词表.txt  ' }).proofreadWordsPath,
    'D:\\词表\\校对词表.txt'
  );
  assert.equal(sanitize({ proofreadWordsPath: 'x'.repeat(1001) }).proofreadWordsPath, '');
});

test('校对词表配置：写盘 / 读回，清除后落盘为空，且不影响敏感词表', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await store.set({ sensitiveWordsPath: 'D:\\词表\\敏感词.txt' });
  await store.set({ proofreadWordsPath: 'D:\\词表\\校对词表.txt' });
  const reopened = await createConfigStore(dir).get();
  assert.equal(reopened.sensitiveWordsPath, 'D:\\词表\\敏感词.txt');
  assert.equal(reopened.proofreadWordsPath, 'D:\\词表\\校对词表.txt');
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(raw.proofreadWordsPath, 'D:\\词表\\校对词表.txt');

  await store.set({ proofreadWordsPath: '' });
  const cleared = await createConfigStore(dir).get();
  assert.equal(cleared.proofreadWordsPath, '');
  assert.equal(cleared.sensitiveWordsPath, 'D:\\词表\\敏感词.txt');
});

test('写作时长配置：默认关、旧配置缺字段照常启动、只认真正的 true', async () => {
  const dir = await mkTmp();
  assert.equal((await createConfigStore(dir).get()).writeDurationEnabled, false, '默认关');
  // 模拟旧配置：完全没有 writeDurationEnabled
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ booksRoot: 'D:\\旧书架', dailyGoal: 800 }, null, 2),
    'utf8'
  );
  const cfg = await createConfigStore(dir).get();
  assert.equal(cfg.writeDurationEnabled, false, '旧配置缺字段 = 关');
  assert.equal(cfg.dailyGoal, 800, '旧配置其它字段不受影响');

  assert.equal(sanitize({ writeDurationEnabled: 'true' }).writeDurationEnabled, false, '字符串 true 不算');
  assert.equal(sanitize({ writeDurationEnabled: 1 }).writeDurationEnabled, false, '数字 1 不算');
  assert.equal(sanitize({ writeDurationEnabled: true }).writeDurationEnabled, true);
});

test('写作时长配置：开关写盘 / 读回，只影响这个字段', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  const on = await store.set({ writeDurationEnabled: true, editorFont: 'kai' });
  assert.equal(on.writeDurationEnabled, true);
  assert.equal(on.editorFont, 'kai');
  const reopened = await createConfigStore(dir).get();
  assert.equal(reopened.writeDurationEnabled, true);
  assert.equal(reopened.editorFont, 'kai');
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(raw.writeDurationEnabled, true);
  assert.equal(raw.editorFont, 'kai');

  await store.set({ writeDurationEnabled: false });
  assert.equal((await createConfigStore(dir).get()).writeDurationEnabled, false);
});

test('导出简繁转换配置：默认不转换、旧配置缺字段照常启动、脏值当不转换', async () => {
  const dir = await mkTmp();
  assert.equal((await createConfigStore(dir).get()).exportConversion, '', '默认不转换');
  // 模拟旧配置：完全没有 exportConversion（v0.8 N6 及以前）
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ booksRoot: 'D:\\旧书架', dailyGoal: 800, chapterTemplate: '第{n}章：' }, null, 2),
    'utf8'
  );
  const cfg = await createConfigStore(dir).get();
  assert.equal(cfg.exportConversion, '', '旧配置缺字段 = 不转换');
  assert.equal(cfg.chapterTemplate, '第{n}章：', '旧配置其它字段不受影响');

  assert.equal(sanitize({ exportConversion: 's2t' }).exportConversion, 's2t');
  assert.equal(sanitize({ exportConversion: 't2s' }).exportConversion, 't2s');
  assert.equal(sanitize({ exportConversion: 'S2T' }).exportConversion, '', '大小写不同不认');
  assert.equal(sanitize({ exportConversion: 'zh-tw' }).exportConversion, '');
  assert.equal(sanitize({ exportConversion: 123 }).exportConversion, '');
  assert.equal(sanitize({ exportConversion: null }).exportConversion, '');
  assert.equal(sanitize({ exportConversion: '  s2t  ' }).exportConversion, '', '不做 trim 猜测');
});

test('导出简繁转换配置：写盘 / 读回，切回不转换后落盘为空', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await store.set({ exportConversion: 's2t', editorFont: 'kai' });
  const reopened = await createConfigStore(dir).get();
  assert.equal(reopened.exportConversion, 's2t');
  assert.equal(reopened.editorFont, 'kai');
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(raw.exportConversion, 's2t');

  await store.set({ exportConversion: 't2s' });
  assert.equal((await createConfigStore(dir).get()).exportConversion, 't2s');

  // 切回「不转换」= 空串（不是删字段，旧版本读也安全）
  await store.set({ exportConversion: '' });
  assert.equal((await createConfigStore(dir).get()).exportConversion, '');
  const cleared = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(cleared.exportConversion, '');
});

test('查找书签配置：默认空、旧配置缺字段照常启动、坏值清洗', async () => {
  const dir = await mkTmp();
  assert.deepEqual((await createConfigStore(dir).get()).findBookmarks, [], '默认没有书签');

  // 模拟旧配置：完全没有 findBookmarks（v0.8 N11 及以前）
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ booksRoot: 'D:\\旧书架', dailyGoal: 800, exportConversion: 's2t' }, null, 2),
    'utf8'
  );
  const cfg = await createConfigStore(dir).get();
  assert.deepEqual(cfg.findBookmarks, [], '旧配置缺字段 = 没有书签');
  assert.equal(cfg.dailyGoal, 800, '旧配置其它字段不受影响');
  assert.equal(cfg.exportConversion, 's2t');

  assert.deepEqual(sanitize({ findBookmarks: 'x' }).findBookmarks, []);
  assert.deepEqual(sanitize({ findBookmarks: { a: 1 } }).findBookmarks, []);
  const cleaned = sanitize({
    findBookmarks: [
      {
        bookId: 'b1',
        chapterId: 'ch_001',
        bookPath: 'D:\\书库\\书一',
        bookTitle: '书一',
        chapterName: '第一章',
        chapterIndex: 1,
        query: '阿明',
        caseSensitive: 'true',
        createdAt: 1000,
        updatedAt: 1000,
        text: '这条字段不该进配置'
      },
      { bookId: '', chapterId: 'ch_002', query: '坏' },
      { bookId: 'b1', chapterId: 'ch_001', query: '重复' },
      null
    ]
  }).findBookmarks;
  assert.equal(cleaned.length, 1, '坏条目 / 重复的「书 + 章」被丢掉');
  assert.equal(cleaned[0].query, '阿明');
  assert.equal(cleaned[0].caseSensitive, false, '大小写只认真正的 true');
  assert.equal('text' in cleaned[0], false, '正文 / 多余字段不进配置');
});

test('查找书签配置：主进程按「书 + 章」原子增删，只写 config.json', async () => {
  const dir = await mkTmp();
  const store = createConfigStore(dir);
  await store.set({ editorFont: 'kai', dailyGoal: 1200 });

  const first = await store.upsertFindBookmark({
    bookId: 'b_book1',
    chapterId: 'ch_001',
    bookPath: 'D:\\书库\\测试书',
    bookTitle: '测试书',
    chapterName: '雨夜',
    chapterIndex: 1,
    query: '阿明',
    caseSensitive: false,
    createdAt: 111
  });
  assert.equal(first.list.length, 1);
  assert.equal(first.bookmark.query, '阿明');
  assert.equal(first.bookmark.createdAt, 111);

  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(raw.findBookmarks.length, 1);
  assert.equal(raw.editorFont, 'kai', '其它配置字段不受影响');
  assert.equal(raw.dailyGoal, 1200);
  assert.deepEqual((await createConfigStore(dir).get()).findBookmarks.length, 1, '重启后书签还在');

  // 同一「书 + 章」再存 = 更新那一条（保留第一次收藏时间），不新增
  const updated = await store.upsertFindBookmark({
    bookId: 'b_book1',
    chapterId: 'ch_001',
    bookPath: 'D:\\书库\\测试书',
    bookTitle: '测试书',
    chapterName: '雨夜',
    chapterIndex: 1,
    query: '雨',
    caseSensitive: true
  });
  assert.equal(updated.list.length, 1);
  assert.equal(updated.bookmark.query, '雨');
  assert.equal(updated.bookmark.caseSensitive, true);
  assert.equal(updated.bookmark.createdAt, 111, '保留第一次收藏时间');

  // 另一章 = 另一条，最近保存的在最前
  const second = await store.upsertFindBookmark({
    bookId: 'b_book1',
    chapterId: 'ch_002',
    bookTitle: '测试书',
    chapterName: '归途',
    chapterIndex: 2,
    query: '灯',
    caseSensitive: false
  });
  assert.equal(second.list.length, 2);
  assert.equal(second.list[0].chapterId, 'ch_002');
  assert.equal(second.list[1].chapterId, 'ch_001');

  // 删除：只按「书 + 章」精确删，不存在的键不动其它条目
  const removed = await store.removeFindBookmark('b_book1', 'ch_001');
  assert.equal(removed.list.length, 1);
  assert.equal(removed.list[0].chapterId, 'ch_002');
  assert.equal((await store.removeFindBookmark('b_book1', '不存在')).list.length, 1);
  assert.equal((await store.removeFindBookmark('', '')).list.length, 1);

  // 缺书 / 缺章 / 缺词的条目明确报错，不会写一条空书签
  await assert.rejects(() => store.upsertFindBookmark({ bookId: '', chapterId: 'ch_003', query: 'x' }));
  await assert.rejects(() => store.upsertFindBookmark({ bookId: 'b_book1', chapterId: '', query: 'x' }));
  await assert.rejects(() => store.upsertFindBookmark({ bookId: 'b_book1', chapterId: 'ch_003', query: '  ' }));
  assert.equal((await store.listFindBookmarks()).length, 1);

  const finalRaw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(finalRaw.findBookmarks.length, 1);
  assert.equal(finalRaw.editorFont, 'kai');
  assert.equal(finalRaw.dailyGoal, 1200);
  assert.equal('text' in finalRaw.findBookmarks[0], false);
});

// A1（审计 E1 / P0-1）：5 条写通道统一「先构造 next → 写盘成功 → 再 cache = next」。
// 写盘失败时内存 cache 必须保持旧值、错误必须抛给调用方、磁盘上仍是旧版本；
// 失败还不能堵死写队列（同一 store 的后续写要照常成功）。
test('配置写盘失败：cache 保持旧值、错误抛出、磁盘不变（5 条写通道）', async () => {
  const dir = await mkTmp();
  const file = path.join(dir, 'config.json');
  let failNext = false;
  const attempted = [];
  const write = async (target, data) => {
    attempted.push({ target, data: JSON.parse(JSON.stringify(data)) });
    if (failNext) {
      failNext = false;
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    }
    await writeJsonAtomic(target, data);
  };
  const store = createConfigStore(dir, { write });
  const readDisk = async () => JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(attempted.length, 0, 'get() 不该写盘');

  // —— 1) set ——
  await store.set({ booksRoot: 'D:\\正常书架' });
  assert.equal(attempted.length, 1);
  assert.equal(attempted[0].data.booksRoot, 'D:\\正常书架', '写盘拿到的是「下一次」的值，不是旧 cache');
  failNext = true;
  await assert.rejects(() => store.set({ booksRoot: 'D:\\坏书架', editorFont: 'kai' }), /EPERM/);
  assert.equal(attempted[1].data.booksRoot, 'D:\\坏书架', '失败时写盘尝试里仍是构造好的 next');
  const cfg = await store.get();
  assert.equal(cfg.booksRoot, 'D:\\正常书架', '写盘失败后 get() 仍是旧值');
  assert.equal(cfg.editorFont, 'serif', '同一 patch 的其它字段也不该在内存生效');
  assert.equal((await readDisk()).booksRoot, 'D:\\正常书架', '磁盘上仍是上一版');

  // —— 2) setBookDisplay ——
  await store.setBookDisplay('b_disp', { editorFont: 'kai', editorFontSize: 22 });
  assert.equal((await store.getBookDisplay('b_disp')).editorFont, 'kai');
  failNext = true;
  await assert.rejects(() => store.setBookDisplay('b_disp', { editorFont: 'custom', editorCustomFontPath: 'C:\\字体.ttf' }), /EPERM/);
  const stillDisplay = await store.getBookDisplay('b_disp');
  assert.equal(stillDisplay.editorFont, 'kai', '按书字体写失败后仍是旧值');
  assert.equal(stillDisplay.editorCustomFontPath, undefined, '写失败不清掉旧字段');
  assert.equal((await readDisk()).bookDisplay.b_disp.editorFont, 'kai');

  // —— 3) resetBookDisplay ——
  failNext = true;
  await assert.rejects(() => store.resetBookDisplay('b_disp'), /EPERM/);
  assert.equal((await store.getBookDisplay('b_disp')).editorFont, 'kai', '重置写失败 = 覆盖仍生效');
  assert.equal((await readDisk()).bookDisplay.b_disp.editorFont, 'kai');
  // 3b) 成功后覆盖才真正删掉
  assert.equal(await store.resetBookDisplay('b_disp'), true);
  assert.deepEqual(await store.getBookDisplay('b_disp'), {});
  assert.equal((await readDisk()).bookDisplay.b_disp, undefined);

  // —— 4) upsertFindBookmark ——
  failNext = true;
  await assert.rejects(
    () => store.upsertFindBookmark({ bookId: 'b1', chapterId: 'ch_001', query: '阿明' }),
    /EPERM/
  );
  assert.deepEqual(await store.listFindBookmarks(), [], '书签写失败后列表仍是空的');
  assert.deepEqual((await readDisk()).findBookmarks, []);
  const added = await store.upsertFindBookmark({ bookId: 'b1', chapterId: 'ch_001', query: '阿明' });
  assert.equal(added.list.length, 1);

  // —— 5) removeFindBookmark ——
  failNext = true;
  await assert.rejects(() => store.removeFindBookmark('b1', 'ch_001'), /EPERM/);
  assert.equal((await store.listFindBookmarks()).length, 1, '删除写失败后书签还在');
  assert.equal((await readDisk()).findBookmarks.length, 1);
  const removed = await store.removeFindBookmark('b1', 'ch_001');
  assert.equal(removed.list.length, 0);

  // —— 失败没堵死写队列：下一次写照常落盘 ——
  await store.set({ dailyGoal: 1500 });
  assert.equal((await store.get()).dailyGoal, 1500);
  assert.equal((await readDisk()).dailyGoal, 1500);
  assert.deepEqual((await createConfigStore(dir).get()).findBookmarks, [], '重启后读到的是最后一次成功写盘的内容');
});

// A5（审计 E2）：只有 ENOENT 才当「首次启动」。EACCES / EIO / EBUSY 这类读失败以前也被静默
// 吞掉（书架悄悄回默认目录、下一次保存把读不到的配置整个覆盖），现在：回默认值不阻断启动，
// 但留一条一次性提示 + 错误码，并且不改动磁盘上的原配置（不归档、不覆盖）。
test('配置读失败：非 ENOENT 不再静默当首次启动（回默认值 + 一次性提示 + 不动磁盘）', async () => {
  for (const code of ['EACCES', 'EIO', 'EBUSY']) {
    const dir = await mkTmp();
    const file = path.join(dir, 'config.json');
    await fs.writeFile(file, JSON.stringify({ booksRoot: 'D:\\已有书架', dailyGoal: 700 }, null, 2), 'utf8');
    const readFile = async () => {
      throw Object.assign(new Error(`${code}: 读配置文件失败（模拟）`), { code });
    };
    const store = createConfigStore(dir, { readFile });
    const cfg = await store.get();
    assert.equal(cfg.booksRoot, DEFAULTS.booksRoot, `${code}：不阻断启动（回默认值）`);
    assert.equal(cfg.dailyGoal, DEFAULTS.dailyGoal);
    const warning = store.takeLoadWarning();
    assert.ok(warning, `${code}：必须留一条提示，不能静默`);
    assert.equal(warning.code, 'CONFIG_READ_FAILED');
    assert.equal(warning.errorCode, code, '提示要带真实错误码');
    assert.ok(warning.message.includes(code), '提示正文里也要有错误码');
    assert.equal(warning.message.includes(dir), false, '提示里不带完整路径');
    assert.equal(store.takeLoadWarning(), null, '提示只给一次');
    // 读失败不等于损坏：不归档、不改名、不覆盖磁盘上的那份配置
    assert.deepEqual(await fs.readdir(dir), ['config.json'], `${code}：读失败不归档`);
    assert.equal((await createConfigStore(dir).get()).booksRoot, 'D:\\已有书架', '换正常读盘还读得到原值');
    assert.equal((await createConfigStore(dir).get()).dailyGoal, 700);
  }
});

// S4（审计 S4 / 终审版）：config:set 字段白名单 + 每字段类型 / 长度上限。
// 以前 sanitize 用 `{...DEFAULTS, ...raw}` 起手，未知键原样保留——一个手改 / 注入的配置可以把
// 任意大对象写进 config.json 并整份回给渲染层。现在只认 DEFAULTS 里登记过的键。
test('配置白名单（S4）：未知键丢弃、只留已知键、旧配置缺新键照常开', async () => {
  const dir = await mkTmp();
  // 旧 config：没有 clipboardWatchEnabled（批 D 才加的键），还混着未知键 / 超大对象
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({
      booksRoot: 'D:\\旧书架',
      dailyGoal: 800,
      未知键: { huge: 'x'.repeat(1000) },
      evil: 'x'.repeat(5000)
    }),
    'utf8'
  );
  const store = createConfigStore(dir);
  const cfg = await store.get();
  assert.equal(cfg.booksRoot, 'D:\\旧书架', '旧配置照常打开');
  assert.equal(cfg.clipboardWatchEnabled, false, '旧配置缺新键 = 默认关');
  assert.equal('未知键' in cfg, false, '加载时未知键要丢弃');
  assert.equal('evil' in cfg, false);
  assert.deepEqual(Object.keys(cfg).sort(), Object.keys(DEFAULTS).sort(), '回给界面的配置只含已知键');
  assert.ok(
    Object.prototype.hasOwnProperty.call(DEFAULTS, 'clipboardWatchEnabled'),
    'D 批要用的开关必须登记在 DEFAULTS（否则会被白名单丢掉）'
  );

  // config:set 塞未知键：丢弃、不影响同一份 patch 里的正常字段，也不写进磁盘
  const updated = await store.set({ evil: 'x', dailyGoal: 900 });
  assert.equal('evil' in updated, false);
  assert.equal(updated.dailyGoal, 900);
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.equal('evil' in raw, false);

  // 新键真实生效 / 坏类型按「关」
  await store.set({ clipboardWatchEnabled: true });
  assert.equal((await createConfigStore(dir).get()).clipboardWatchEnabled, true);
  await store.set({ clipboardWatchEnabled: 'true' });
  assert.equal((await store.get()).clipboardWatchEnabled, false, '只认真正的 true');

  // 逐字段长度上限：坏值当「没设置」
  const capped = sanitize({
    booksRoot: 'D:\\' + 'x'.repeat(1200),
    editorCustomFontPath: 'C:\\' + 'f'.repeat(1200),
    editorCustomFontName: 'n'.repeat(300),
    bookDisplay: {
      b1: {
        editorCustomFontPath: 'C:\\' + 'g'.repeat(1200),
        editorCustomFontName: 'm'.repeat(300)
      }
    }
  });
  assert.equal(capped.booksRoot, DEFAULTS.booksRoot, '超长书架路径回落默认');
  assert.equal(capped.editorCustomFontPath, '');
  assert.equal(capped.editorCustomFontName, '');
  assert.equal(capped.bookDisplay.b1.editorCustomFontPath, '', '按书字体路径同样限长');
  assert.equal(capped.bookDisplay.b1.editorCustomFontName, '');
});

// 1.7.0 F3a：多份校对词表（proofreadWordlists）——配置层三条锚点。
test('多份校对词表配置：旧配置没有该字段 = 空数组，单份路径沿用旧字段', async () => {
  const dir = await mkTmp();
  assert.deepEqual((await createConfigStore(dir).get()).proofreadWordlists, [], '默认空数组');
  // 模拟旧配置：只有单份 proofreadWordsPath，完全没有 proofreadWordlists
  await fs.writeFile(
    path.join(dir, 'config.json'),
    JSON.stringify({ proofreadWordsPath: 'D:\\词表\\旧单份.txt', dailyGoal: 1200 }, null, 2),
    'utf8'
  );
  const cfg = await createConfigStore(dir).get();
  assert.deepEqual(cfg.proofreadWordlists, [], '旧配置读出来是空数组');
  assert.equal(cfg.proofreadWordsPath, 'D:\\词表\\旧单份.txt', '单份字段原样沿用，零迁移');
  assert.equal(cfg.dailyGoal, 1200, '其它字段不受影响');
  // 旧配置上只改别的字段：两份词表都保持原样
  const store = createConfigStore(dir);
  await store.set({ dailyGoal: 1300 });
  const reopened = await createConfigStore(dir).get();
  assert.deepEqual(reopened.proofreadWordlists, []);
  assert.equal(reopened.proofreadWordsPath, 'D:\\词表\\旧单份.txt');
});

test('多份校对词表清洗：非数组 / 超 8 条 / 相对路径 / 重复都丢弃，不存在路径保留（V51），写盘同样清洗', async () => {
  const dir = await mkTmp();
  const files = [];
  for (let i = 1; i <= 10; i += 1) {
    const p = path.join(dir, '词表' + i + '.txt');
    await fs.writeFile(p, '错词\n', 'utf8');
    files.push(p);
  }
  // 非数组一律当空（不是把单份路径塞进数组）
  assert.deepEqual(sanitize({ proofreadWordlists: 'D:\\x.txt' }).proofreadWordlists, []);
  assert.deepEqual(sanitize({ proofreadWordlists: null }).proofreadWordlists, []);
  assert.deepEqual(sanitize({ proofreadWordlists: 42 }).proofreadWordlists, []);
  assert.deepEqual(sanitize({ proofreadWordlists: { 0: 'D:\\x.txt' } }).proofreadWordlists, []);
  // 超 8 条：留前 8 条，顺序不变
  assert.deepEqual(sanitize({ proofreadWordlists: files }).proofreadWordlists, files.slice(0, 8));
  // 相对路径 / 非字符串 / 空串：逐条丢掉，其它照留；不存在的绝对路径保留（V51：清洗不判存在性，
  // 读不到由读取侧的 GLOSSARY_MISSING 报给用户）
  const missing = path.join(dir, '没有这个文件.txt');
  const dirty = [files[0], '词表相对.txt', missing, 123, '', '   ', null, files[1]];
  assert.deepEqual(sanitize({ proofreadWordlists: dirty }).proofreadWordlists, [files[0], missing, files[1]]);
  // 重复：Windows 下大小写与正反斜杠归一后算同一份
  const dup = [files[0], files[0], files[0].toUpperCase(), files[0].replace(/\\/g, '/')];
  assert.deepEqual(sanitize({ proofreadWordlists: dup }).proofreadWordlists, [files[0]]);
  // 保存路径同样清洗（set 走同一个 sanitize）
  const store = createConfigStore(dir);
  await store.set({ proofreadWordlists: dirty });
  assert.deepEqual((await createConfigStore(dir).get()).proofreadWordlists, [files[0], missing, files[1]]);
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(raw.proofreadWordlists, [files[0], missing, files[1]], '落盘的就是清洗后的三条');
  // 空数组 = 清空，落盘为空数组
  await store.set({ proofreadWordlists: [] });
  assert.deepEqual((await createConfigStore(dir).get()).proofreadWordlists, []);
});

test('多份校对词表清洗：合法数组保留顺序与写法，8 条正好不算超限', async () => {
  const dir = await mkTmp();
  const files = [];
  for (let i = 1; i <= 8; i += 1) {
    const p = path.join(dir, '顺序' + i + '.txt');
    await fs.writeFile(p, '占位\n', 'utf8');
    files.push(p);
  }
  const shuffled = [files[2], files[0], files[7], files[1], files[6], files[3], files[5], files[4]];
  assert.deepEqual(sanitize({ proofreadWordlists: shuffled }).proofreadWordlists, shuffled, '顺序原样保留');
  const store = createConfigStore(dir);
  await store.set({ proofreadWordlists: shuffled });
  assert.deepEqual((await createConfigStore(dir).get()).proofreadWordlists, shuffled, '写盘读回顺序不变');
});

// 1.7.1 P2 / V51：配置清洗只看形状，不再按「文件现在能不能 stat 到」静默删词表。
// U 盘 / 网络盘 / 权限抖动 / 文件临时被占用时，删掉的是作者的设置而不是坏数据；读不到应由读取侧
// 的 GLOSSARY_MISSING 报给用户（最后一条锚点）。V48：写入路径不再带同步 stat，断开的 UNC 不卡主进程。
test('写入 [存在, 不存在] 两条词表 → 两条都保留（V51）', async () => {
  const dir = await mkTmp();
  const existing = path.join(dir, '存在.txt');
  const missing = path.join(dir, '不存在.txt');
  await fs.writeFile(existing, '错词\n', 'utf8');
  assert.equal(
    await fs.stat(missing).then(() => true, () => false),
    false,
    '前置：这条路径确实不存在'
  );
  const store = createConfigStore(dir);
  const saved = await store.set({ proofreadWordlists: [existing, missing] });
  assert.deepEqual(saved.proofreadWordlists, [existing, missing], '写入返回里两条都在');
  assert.deepEqual((await store.get()).proofreadWordlists, [existing, missing], '内存 cache 里两条都在');
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(raw.proofreadWordlists, [existing, missing], '落盘的就是两条');
});

test('改无关字段后不存在的词表仍在（V51）', async () => {
  const dir = await mkTmp();
  const existing = path.join(dir, '存在.txt');
  const missing = path.join(dir, '不存在.txt');
  await fs.writeFile(existing, '错词\n', 'utf8');
  const store = createConfigStore(dir);
  await store.set({ proofreadWordlists: [existing, missing] });
  // 设置页每次保存都会整份回传配置（改主题 / 拖分隔条 / 存别的字段），以前每次都会重跑清洗、
  // 把不存在的那条当成坏数据扔掉；现在无关字段的写入不能顺手删掉词表。
  const after = await store.set({ dailyGoal: 1500, editorPaper: 'night' });
  assert.deepEqual(after.proofreadWordlists, [existing, missing], '改无关字段不能顺手删词表');
  await store.set({ dailyGoal: 1600 });
  assert.deepEqual((await store.get()).proofreadWordlists, [existing, missing], '多次无关写入后仍在');
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(raw.proofreadWordlists, [existing, missing], '落盘的两条都还在');
});

test('新 store load() 后仍在（V51）', async () => {
  const dir = await mkTmp();
  const existing = path.join(dir, '存在.txt');
  const missing = path.join(dir, '不存在.txt');
  await fs.writeFile(existing, '错词\n', 'utf8');
  const store = createConfigStore(dir);
  await store.set({ proofreadWordlists: [existing, missing] });
  // 重启 = 新实例 + load()；这里重跑的是同一个 sanitize，不能把上次存下的路径删掉。
  const reopened = createConfigStore(dir);
  await reopened.load();
  assert.deepEqual((await reopened.get()).proofreadWordlists, [existing, missing], '重启后不存在的词表仍在');
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(raw.proofreadWordlists, [existing, missing], '磁盘上的两条也没被改写');
});

test('不存在路径读取时报 GLOSSARY_MISSING 文案（V51/V48）', async () => {
  const dir = await mkTmp();
  const missing = path.join(dir, '不存在.txt');
  assert.equal(
    await fs.stat(missing).then(() => true, () => false),
    false,
    '前置：这条路径确实不存在'
  );
  // 读取侧对「配置里有、文件读不到」的路径必须给出可辨认的码：GLOSSARY_MISSING
  // （core/glossary.js:201；不是静默当「没配置」GLOSSARY_NOT_CONFIGURED）。
  const one = await readGlossaryFile(missing);
  assert.equal(one.ok, false);
  assert.equal(one.configured, true);
  assert.equal(one.code, 'GLOSSARY_MISSING');
  assert.match(one.message, /词表文件不存在/, '单份读取的文案要说明文件不存在');
  // 多份词表把码翻成界面文案（core/glossary.js 的 glossaryErrorText，GLOSSARY_MISSING 分支，
  // 约 :246）：带路径的长文案留在主进程，界面只拿这一句。
  const bundle = await readGlossaryFiles([missing]);
  assert.equal(bundle.ok, false);
  assert.equal(bundle.lists.length, 1);
  assert.equal(bundle.lists[0].ok, false);
  assert.equal(bundle.lists[0].error, '词表文件不存在（可能被移动或删除了，请重新选择）');
  // 全链路：配置层保留的不存在路径，读取时仍能报 MISSING，而不是在写入时被删到「未配置」。
  const store = createConfigStore(dir);
  await store.set({ proofreadWordlists: [missing] });
  const cfg = await store.get();
  assert.deepEqual(cfg.proofreadWordlists, [missing], '配置层不删不存在的路径（V51）');
  const chain = await readGlossaryFile(cfg.proofreadWordlists[0]);
  assert.equal(chain.code, 'GLOSSARY_MISSING', '配置保留 → 读取报 MISSING 的链路可达');
});

// C7（审计 C7）：配置读失败（EACCES / EIO / EBUSY）后，自动写（窗口位置 / 最近书 / 最近导出目录）
// 一律不许落盘——否则磁盘恢复可写时，第一次 resize 的防抖写就把「读不到的真配置」整份换成默认值，
// booksRoot 直接丢。自动写期间也不许重试读：解锁只走「显式保存先重试读」这一条路（见下一条）。
test('配置读失败：自动写一律被拦住、不落盘、也不假写内存（C7）', async () => {
  const dir = await mkTmp();
  const file = path.join(dir, 'config.json');
  const realConfig = { booksRoot: 'D:\\真书架', dailyGoal: 700, editorFont: 'kai' };
  await fs.writeFile(file, JSON.stringify(realConfig, null, 2), 'utf8');
  const before = await fs.readFile(file, 'utf8');

  let failing = true;
  const readFile = async (target, encoding) => {
    if (failing) throw Object.assign(new Error('EACCES: 读配置失败（模拟）'), { code: 'EACCES' });
    return fs.readFile(target, encoding);
  };
  const writes = [];
  const store = createConfigStore(dir, {
    readFile,
    write: async (target, data) => {
      writes.push(JSON.parse(JSON.stringify(data)));
      await writeJsonAtomic(target, data);
    }
  });

  const cfg = await store.get();
  assert.equal(cfg.booksRoot, DEFAULTS.booksRoot, '读失败先回默认值（不阻断启动）');
  assert.equal(store.takeLoadWarning().code, 'CONFIG_READ_FAILED');

  // 三种真实自动写通道：窗口位置（resize/move 防抖 + 关窗前那次）、最近书、最近导出目录
  const autoPatches = [
    { windowBounds: { x: 1, y: 2, width: 1200, height: 760, maximized: false } },
    { lastBook: { path: 'D:\\真书架\\书A', chapterId: 'c1', at: Date.now() } },
    { lastExportDir: 'D:\\导出' }
  ];
  for (const patch of autoPatches) {
    await assert.rejects(
      () => store.set(patch, { auto: true }),
      (err) => err && err.code === 'CONFIG_READ_FAILED',
      `自动写 ${Object.keys(patch)[0]} 必须被拦住`
    );
  }
  assert.equal(writes.length, 0, '自动写一次都不许碰写盘');
  assert.equal(await fs.readFile(file, 'utf8'), before, '磁盘上的真配置一个字节没变');
  assert.equal((await store.get()).booksRoot, DEFAULTS.booksRoot, '内存里仍是默认值（不假装写成功）');
  assert.equal((await store.get()).dailyGoal, DEFAULTS.dailyGoal);

  // 磁盘恢复也不代表自动写能自己解锁：没人点保存时不许偷偷把默认值覆盖上去
  failing = false;
  await assert.rejects(
    () => store.set({ lastExportDir: 'D:\\导出二' }, { auto: true }),
    (err) => err && err.code === 'CONFIG_READ_FAILED'
  );
  assert.equal(writes.length, 0, '自动写不重试读，只等显式保存来解锁');
  assert.equal(await fs.readFile(file, 'utf8'), before);
});

// C7：显式保存（用户在设置里点保存 / 改按书显示 / 存书签）在读失败期间必须先重试读；
// 读不到就明确失败、读到了就按真配置合并——默认值绝不覆盖真配置（审计里最担心的 booksRoot 丢失）。
test('配置读失败恢复后：显式保存先重试读，真配置不被默认值覆盖（C7）', async () => {
  const dir = await mkTmp();
  const file = path.join(dir, 'config.json');
  await fs.writeFile(file, JSON.stringify({ booksRoot: 'D:\\真书架', dailyGoal: 700 }), 'utf8');

  let failing = true;
  const readFile = async (target, encoding) => {
    if (failing) throw Object.assign(new Error('EACCES: 读配置失败（模拟）'), { code: 'EACCES' });
    return fs.readFile(target, encoding);
  };
  const store = createConfigStore(dir, { readFile });
  await store.get();
  assert.equal((await store.get()).booksRoot, DEFAULTS.booksRoot, '前置：启动时读到的是默认值');

  // 仍读不到：显式保存明确失败（不能假装成功，也不能把默认值写进去）
  await assert.rejects(
    () => store.set({ editorFont: 'kai' }),
    (err) => err && err.code === 'CONFIG_READ_FAILED' && err.errorCode === 'EACCES'
  );
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).booksRoot, 'D:\\真书架', '失败时磁盘不动');
  const stillBad = await store.retryLoad();
  assert.equal(stillBad.ok, false);
  assert.equal(stillBad.recovered, false);
  assert.equal(stillBad.code, 'CONFIG_READ_FAILED');
  assert.ok(stillBad.message.includes('EACCES'), '失败信息带上真实错误码');

  // 其它显式写通道同样先重试读、读不到就失败（按书显示 / 书签）
  await assert.rejects(() => store.setBookDisplay('b1', { editorFont: 'kai' }), /读取失败/);
  await assert.rejects(
    () => store.upsertFindBookmark({ bookId: 'b1', chapterId: 'c1', query: '阿明' }),
    /读取失败/
  );
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).bookDisplay, undefined, '失败时没写按书设置');

  // 磁盘恢复：显式保存先重试读 → 写回的是「真配置 + 这次改动」
  failing = false;
  const recovered = await store.retryLoad();
  assert.equal(recovered.ok, true);
  assert.equal(recovered.recovered, true, 'retryLoad 要告诉调用方「刚才是默认值，现在是真配置」');
  await store.set({ editorFont: 'kai' });
  const disk = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(disk.booksRoot, 'D:\\真书架', '真配置没有被默认值覆盖（C7 的核心）');
  assert.equal(disk.dailyGoal, 700, '读不到时错过的字段一个不少');
  assert.equal(disk.editorFont, 'kai', '这次显式改动正常生效');
  assert.equal(disk.configVersion, 1, '本版本写盘时落自己的 configVersion');
  assert.equal((await store.get()).booksRoot, 'D:\\真书架', '恢复后内存缓存也是真配置');
  assert.equal(store.takeLoadWarning(), null, '恢复后不再留过时的读失败提示');

  // 恢复之后自动写回到正常路径（磁盘读得通、cache 是真配置，不会再覆盖）
  await store.set({ lastExportDir: 'D:\\导出' }, { auto: true });
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).booksRoot, 'D:\\真书架');
});

// V110 / D-7：配置前向兼容。本版写盘一定带 configVersion；读到更高版本时保留版本号 + 未知顶层键
// （限类型 / 深度 / 大小），任何一次普通保存都把未知键原样写回，版本回退不再静默丢设置；
// 同版本 / 没有版本号的未知键仍按 S4 丢弃（防注入的既有口径不松）。
test('configVersion 与高版本未知键透传（V110 / D-7）', async () => {
  const dir = await mkTmp();
  const file = path.join(dir, 'config.json');
  const store = createConfigStore(dir);
  assert.equal((await store.get()).configVersion, 1, '本版默认 configVersion = 1');
  await store.set({ dailyGoal: 900 });
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).configVersion, 1, '新配置写盘一定带 configVersion');

  // 模拟「新版本写过」的配置：版本 2 + 未知顶层键（其中一个超过大小闸门，必须丢掉）
  await fs.writeFile(
    file,
    JSON.stringify({
      configVersion: 2,
      booksRoot: 'D:\\新版本书架',
      dailyGoal: 1200,
      未来功能: { enabled: true, list: [1, '二', null] },
      超限大对象: { blob: 'x'.repeat(50000) }
    }),
    'utf8'
  );
  const upgraded = createConfigStore(dir);
  const cfg = await upgraded.get();
  assert.equal(cfg.configVersion, 2, '更高版本号原样保留（不降级）');
  assert.equal(cfg.booksRoot, 'D:\\新版本书架', '已知键照常清洗 / 生效');
  assert.deepEqual(cfg.未来功能, { enabled: true, list: [1, '二', null] }, '高版本未知键限类型 / 大小后保留');
  assert.equal('超限大对象' in cfg, false, '超过大小闸门的未知键整条丢弃');

  // 本版保存一次：未知键原样写回、版本号不回落（否则新版本会把已迁移的文件再迁移一次）
  await upgraded.set({ dailyGoal: 1300 });
  const disk = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(disk.configVersion, 2);
  assert.deepEqual(disk.未来功能, { enabled: true, list: [1, '二', null] }, '普通保存不许抹掉新版本字段');
  assert.equal(disk.dailyGoal, 1300);
  assert.equal(disk.booksRoot, 'D:\\新版本书架');
  assert.equal('超限大对象' in disk, false);

  // 同版本 / 无版本的未知键仍丢弃（S4 的防注入口径没松）
  const plain = sanitize({ booksRoot: 'D:\\书架', 可疑: { a: 1 }, configVersion: 1 });
  assert.equal('可疑' in plain, false);
  assert.equal(sanitize({ 可疑: 1 }).configVersion, 1, '没有版本号的旧配置 = 本版');
  // 坏版本号一律按本版；数字字符串（手改配置常见）也认
  for (const bad of [null, '', 'x', -3, 1.4, {}, []]) {
    assert.equal(sanitize({ configVersion: bad }).configVersion, 1, `configVersion=${JSON.stringify(bad)} 回落 1`);
  }
  assert.equal(sanitize({ configVersion: '2' }).configVersion, 2, '数字字符串版本号也认');
  // 未知键里的 __proto__ / constructor 这类键不许借透传污染原型链
  const proto = JSON.parse('{"configVersion":2,"__proto__":{"polluted":true},"constructor":{"x":1}}');
  const cleaned = sanitize(proto);
  assert.equal(Object.getPrototypeOf(cleaned), Object.prototype);
  assert.equal(cleaned.polluted, undefined);
  assert.equal(({}).polluted, undefined, '全局原型没被污染');
});

// C7 接线静态闸门：读失败闸门只有靠 main.js 把三条自动写标成 auto 才生效；显式保存必须先重试读
// 再算目标书架目录 / 建目录 / 写盘（顺序错了就会出现「先建一个错目录再报失败」）。
test('C7 / V110 接线静态闸门：自动写带 auto 标记、config:set 先重试读', () => {
  const main = require('node:fs').readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(
    main,
    /configStore\.set\(\{ windowBounds:[\s\S]{0,200}?\}, \{ auto: true \}\)/,
    '窗口位置 / 大小是自动写，必须带 { auto: true }'
  );
  assert.match(
    main,
    /configStore\.rememberLastBook\(payload, \{ auto: true, now \}\)/,
    '最近书是自动写，且读旧值 / 比较 / 写盘都要在 configStore 的写队列里完成（C28）'
  );
  assert.match(main, /configStore\.set\(\{ lastExportDir: dir \}, \{ auto: true \}\)/, '最近导出目录是自动写');

  const from = main.indexOf("handle('config:set'");
  const to = main.indexOf("handle('config:test-pick'");
  assert.ok(from > -1 && to > from, '静态闸门要能定位 config:set 的函数体');
  const body = main.slice(from, to);
  const retryAt = body.indexOf('configStore.retryLoad()');
  const mkdirAt = body.indexOf('fs.mkdir(targetRoot');
  const writeAt = body.indexOf('configStore.set(gated.patch)');
  assert.ok(retryAt > -1, 'config:set 必须先重试读（C7：保存设置前先重试读）');
  assert.ok(retryAt < mkdirAt && retryAt < writeAt, '重试读必须在建目标目录 / 写盘之前');
  assert.match(body, /if \(!recovery\.ok\)/, '仍读不到要明确失败（不能拿默认值写盘）');
  assert.match(body, /recovery\.recovered/, '读盘恢复后要刷新主进程缓存再继续');
});

