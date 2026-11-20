const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const configGate = require('../core/config-gate');

// v0.9 C-2b：配置来源校验（C1 安全模型一致性的延伸）。
// 这里锁三件事：
//   1. filterPathPatch 的判定（原值 / 清空 / 刚选中 → 放行；其它一律忽略且只回字段名）；
//   2. 按窗口的「刚选中」登记（隔离 / 覆盖 / 清空 / 关窗清理）；
//   3. 静态闸门：main.js 的 config:set 必须真的过这道校验、三个对话框入口必须记账。
// 真实 Electron 侧的回归在 E2E 第 58 组（伪造路径不生效 + 模拟对话框选中才生效）。

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const ROOT = path.join(os.tmpdir(), 'cw-config-gate-书架');
const bookRoot = path.join(ROOT, '另一个书架');
const wordsA = path.join(ROOT, '词表A.txt');
const wordsB = path.join(ROOT, '词表B.txt');
const outside = path.join(ROOT, '..', '别的目录');

test('配置来源校验：不在名单里的字段原样透传（显示设置 / 统计 / 模板都不受影响）', () => {
  const patch = {
    editorFont: 'sans',
    editorFontSize: 20,
    dailyGoal: 1234,
    chapterTemplate: '第{n}章 {title}',
    formatOptions: { indent: 2 },
    lastExportDir: path.join(ROOT, '导出'),
    bookDisplay: { 某书: { editorPaper: 'night' } }
  };
  const result = configGate.filterPathPatch(patch, { current: {} });
  assert.deepEqual(result.patch, patch);
  assert.deepEqual(result.rejected, []);
});

test('配置来源校验：与原值相同就放行（设置界面每次保存都会原样回传整张表单）', () => {
  const current = { booksRoot: bookRoot, proofreadWordsPath: wordsA, sensitiveWordsPath: '' };
  // 末尾分隔符 / 大小写 / 正反斜杠混用，都算同一个路径（Windows 口径）
  const sameForms = [
    bookRoot + path.sep,
    bookRoot.toUpperCase(),
    bookRoot.replace(/\\/g, '/'),
    `  ${bookRoot}  `
  ];
  for (const value of sameForms) {
    const result = configGate.filterPathPatch({ booksRoot: value }, { current });
    assert.deepEqual(result.rejected, [], `应当放行：${value}`);
    // 存进配置的是 trim 过的原字符串（不做 resolve，避免改变作者看到的路径写法）
    assert.equal(result.patch.booksRoot, value.trim());
  }
  const unchangedWords = configGate.filterPathPatch({ proofreadWordsPath: wordsA }, { current });
  assert.deepEqual(unchangedWords.rejected, []);
  assert.equal(unchangedWords.patch.proofreadWordsPath, wordsA);
});

test('配置来源校验：清空（空串 / 纯空白）一律放行，交给配置清洗决定最终值', () => {
  const current = { booksRoot: bookRoot, proofreadWordsPath: wordsA, sensitiveWordsPath: wordsB };
  for (const value of ['', '   ', '\t']) {
    const result = configGate.filterPathPatch({ sensitiveWordsPath: value }, { current });
    assert.deepEqual(result.rejected, []);
    assert.equal(result.patch.sensitiveWordsPath, '');
  }
});

test('配置来源校验：对话框刚选中的值才放行（这就是「来源」）', () => {
  const current = { booksRoot: bookRoot, proofreadWordsPath: '', sensitiveWordsPath: '' };
  const result = configGate.filterPathPatch(
    { booksRoot: path.join(ROOT, '新书架'), proofreadWordsPath: wordsA, sensitiveWordsPath: wordsB },
    {
      current,
      picked: {
        booksRoot: path.join(ROOT, '新书架'),
        proofreadWordsPath: wordsA,
        sensitiveWordsPath: wordsB
      }
    }
  );
  assert.deepEqual(result.rejected, []);
  assert.equal(result.patch.booksRoot, path.join(ROOT, '新书架'));
  assert.equal(result.patch.proofreadWordsPath, wordsA);
  assert.equal(result.patch.sensitiveWordsPath, wordsB);
});

test('配置来源校验：来源不明的路径一律忽略，回包里只有字段名、没有路径', () => {
  const current = { booksRoot: bookRoot, proofreadWordsPath: '', sensitiveWordsPath: '' };
  const forged = path.join(ROOT, '..', '伪造目录');
  const result = configGate.filterPathPatch(
    { booksRoot: forged, proofreadWordsPath: outside + '.txt', sensitiveWordsPath: 'C:\\Windows\\win.ini' },
    { current, picked: null }
  );
  assert.deepEqual(Object.keys(result.patch), []);
  assert.deepEqual(result.rejected, ['booksRoot', 'proofreadWordsPath', 'sensitiveWordsPath']);
  const reported = JSON.stringify(result.rejected);
  assert.equal(reported.includes('伪造目录'), false);
  assert.equal(reported.includes('win.ini'), false);
  assert.equal(reported.includes('\\\\'), false);
});

test('配置来源校验：同一 patch 里合法字段照旧生效，只有被拒的路径字段被摘掉', () => {
  const current = { booksRoot: bookRoot, dailyGoal: 2000 };
  const result = configGate.filterPathPatch(
    { booksRoot: outside, dailyGoal: 3000, editorPaper: 'kraft' },
    { current }
  );
  assert.equal(result.patch.dailyGoal, 3000);
  assert.equal(result.patch.editorPaper, 'kraft');
  assert.equal('booksRoot' in result.patch, false);
  assert.deepEqual(result.rejected, ['booksRoot']);
});

test('配置来源校验：一项的登记不能拿去给另一项用（字段之间不串用）', () => {
  const current = { proofreadWordsPath: '', sensitiveWordsPath: '' };
  const result = configGate.filterPathPatch(
    { sensitiveWordsPath: wordsA },
    { current, picked: { proofreadWordsPath: wordsA } }
  );
  assert.deepEqual(result.patch, {});
  assert.deepEqual(result.rejected, ['sensitiveWordsPath']);
});

test('配置来源校验：坏类型（数字 / null / 数组 / 对象 / 布尔）一律当来源不明拒绝', () => {
  const current = { booksRoot: bookRoot, proofreadWordsPath: '', sensitiveWordsPath: '' };
  for (const value of [123, null, undefined, ['D:\\x'], { path: 'D:\\x' }, true]) {
    const result = configGate.filterPathPatch({ booksRoot: value }, { current });
    assert.deepEqual(result.rejected, ['booksRoot'], `应当拒绝：${String(value)}`);
  }
});

test('配置来源校验：坏 patch / 缺省参数不抛错（只当没有改动）', () => {
  for (const patch of [null, undefined, 42, 'booksRoot', ['booksRoot']]) {
    const result = configGate.filterPathPatch(patch, {});
    assert.deepEqual(result.patch, {});
    assert.deepEqual(result.rejected, []);
  }
  assert.deepEqual(configGate.filterPathPatch({ editorFont: 'kai' }), { patch: { editorFont: 'kai' }, rejected: [] });
});

// 1.7.0 F3a：多份校对词表（数组字段）的来源校验——逐项判来源，伪造条目不放行。
test('多份校对词表来源校验：与当前条目相同或刚选中的放行，伪造条目丢弃并回字段名', () => {
  const listA = path.join(ROOT, '词表A.txt');
  const listB = path.join(ROOT, '词表B.txt');
  const listC = path.join(ROOT, '词表C.txt');
  const forged = path.join(ROOT, '..', '伪造词表.txt');
  const current = { proofreadWordlists: [listA, listB] };
  // 设置界面每次保存都原样回传整张表单：与当前条目相同 → 放行
  const unchanged = configGate.filterPathPatch({ proofreadWordlists: [listA, listB] }, { current });
  assert.deepEqual(unchanged.patch, { proofreadWordlists: [listA, listB] });
  assert.deepEqual(unchanged.rejected, []);
  // 大小写 / 正反斜杠混用：同一条
  const sameForm = configGate.filterPathPatch(
    { proofreadWordlists: [listA.toUpperCase(), listB.replace(/\\/g, '/')] },
    { current }
  );
  assert.deepEqual(sameForm.rejected, []);
  // 刚在对话框里选中的新路径：追加放行
  const pickedResult = configGate.filterPathPatch(
    { proofreadWordlists: [listA, listB, listC] },
    { current, picked: { proofreadWordlists: [listC] } }
  );
  assert.deepEqual(pickedResult.patch, { proofreadWordlists: [listA, listB, listC] });
  assert.deepEqual(pickedResult.rejected, []);
  // 逐项判断：伪造条目只丢它自己，其它照旧；字段名回 rejected（不放行整段）
  const forgedResult = configGate.filterPathPatch(
    { proofreadWordlists: [listA, forged] },
    { current, picked: { proofreadWordlists: [listC] } }
  );
  assert.deepEqual(forgedResult.patch, { proofreadWordlists: [listA] });
  assert.deepEqual(forgedResult.rejected, ['proofreadWordlists']);
  // 全是伪造：整个字段不生效（保留旧值），字段名回 rejected
  const allForged = configGate.filterPathPatch({ proofreadWordlists: [forged, forged + '2'] }, { current });
  assert.equal('proofreadWordlists' in allForged.patch, false);
  assert.deepEqual(allForged.rejected, ['proofreadWordlists']);
  // 移除一份（剩下的都还在当前列表里）：放行——否则面板删不掉词表
  const removed = configGate.filterPathPatch({ proofreadWordlists: [listA] }, { current });
  assert.deepEqual(removed.patch, { proofreadWordlists: [listA] });
  assert.deepEqual(removed.rejected, []);
  // 空数组 = 清空：放行
  assert.deepEqual(configGate.filterPathPatch({ proofreadWordlists: [] }, { current }).patch, {
    proofreadWordlists: []
  });
  // 坏类型（字符串 / 对象 / 数字 / 布尔 / null）一律当来源不明拒绝
  for (const bad of ['D:\\x.txt', { 0: 'D:\\x.txt' }, 42, true, null]) {
    const result = configGate.filterPathPatch({ proofreadWordlists: bad }, { current });
    assert.deepEqual(result.patch, {}, '应当拒绝：' + String(bad));
    assert.deepEqual(result.rejected, ['proofreadWordlists']);
  }
  // 数组里混了非字符串条目：只丢那一条，字段名回 rejected
  const mixed = configGate.filterPathPatch({ proofreadWordlists: [listA, 123] }, { current });
  assert.deepEqual(mixed.patch, { proofreadWordlists: [listA] });
  assert.deepEqual(mixed.rejected, ['proofreadWordlists']);
  // 别的字段照常透传（数组字段不牵连整份 patch）
  const withOthers = configGate.filterPathPatch(
    { proofreadWordlists: [listA, forged], dailyGoal: 3000 },
    { current }
  );
  assert.equal(withOthers.patch.dailyGoal, 3000);
  assert.deepEqual(withOthers.rejected, ['proofreadWordlists']);
});

test('路径等价：末尾分隔符 / 正反斜杠 / 大小写都算同一个；空值与坏值不算', () => {
  assert.equal(configGate.samePath(bookRoot, bookRoot + path.sep), true);
  assert.equal(configGate.samePath(bookRoot, bookRoot.replace(/\\/g, '/')), true);
  assert.equal(configGate.samePath(bookRoot, `  ${bookRoot}  `), true);
  assert.equal(configGate.samePath(bookRoot, path.join(ROOT, '另一个')), false);
  assert.equal(configGate.samePath('', ''), false);
  assert.equal(configGate.samePath(null, bookRoot), false);
  assert.equal(configGate.samePath(bookRoot, undefined), false);
  if (process.platform === 'win32') {
    assert.equal(configGate.samePath(bookRoot, bookRoot.toUpperCase()), true);
  }
});

test('路径等价：子目录 / 父目录不是同一个路径（不做前缀比较）', () => {
  assert.equal(configGate.samePath(path.join(bookRoot, '子目录'), bookRoot), false);
  assert.equal(configGate.samePath(path.dirname(bookRoot), bookRoot), false);
});

test('选择登记：按窗口隔离、重选覆盖、空值只清这一项、关窗清理', () => {
  const store = configGate.createPickedPathStore();
  assert.deepEqual(store.snapshot(1), {});
  assert.equal(store.remember(1, 'booksRoot', bookRoot), true);
  assert.equal(store.remember(1, 'sensitiveWordsPath', wordsA), true);
  // 另一个窗口各自选各自的：互不可见
  assert.equal(store.remember(2, 'sensitiveWordsPath', wordsB), true);
  assert.deepEqual(store.snapshot(1), { booksRoot: bookRoot, sensitiveWordsPath: wordsA });
  assert.deepEqual(store.snapshot(2), { sensitiveWordsPath: wordsB });
  // 同一项重选：只留最后一次
  store.remember(1, 'sensitiveWordsPath', wordsB);
  assert.equal(store.recall(1, 'sensitiveWordsPath'), wordsB);
  // 清空某一次选择
  store.remember(1, 'booksRoot', '');
  assert.equal(store.recall(1, 'booksRoot'), '');
  // 关窗清理 + size 只算还有登记的窗口
  assert.equal(store.size(), 2);
  assert.equal(store.forget(2), true);
  assert.equal(store.forget(2), false);
  assert.equal(store.size(), 1);
  assert.deepEqual(store.snapshot(2), {});
});

test('选择登记：未知字段 / 空窗口 id 不记账（不留下无主登记）', () => {
  const store = configGate.createPickedPathStore();
  // C1：editorCustomFontPath 现在是受控字段，可以记账
  assert.equal(store.remember(1, 'editorCustomFontPath', wordsA), true);
  assert.equal(store.remember(1, '不在名单里的字段', wordsA), false);
  assert.equal(store.remember('', 'booksRoot', bookRoot), false);
  assert.equal(store.remember(null, 'booksRoot', bookRoot), false);
  store.remember(1, 'editorCustomFontPath', '');
  // 空值 = 「清掉这一项的登记」：算操作成功，但不会留下任何登记
  assert.equal(store.remember(1, 'booksRoot', '   '), true);
  assert.equal(store.size(), 0);
  assert.equal(store.recall(1, 'booksRoot'), '');
  assert.deepEqual(store.snapshot(''), {});
});

test('静态闸门：config:set 必须过 filterPathPatch，三个对话框入口必须记账', () => {
  // 校验清单本身就是审计结论：改名 / 加字段都要同步改这里
  // C1（审计 S1）：补上 editorCustomFontPath（字体文件也会被主进程整份读给渲染层）
  assert.deepEqual(
    configGate.GUARDED_PATH_FIELDS.slice().sort(),
    ['booksRoot', 'editorCustomFontPath', 'proofreadWordsPath', 'proofreadWordlists', 'sensitiveWordsPath'].sort()
  );
  // config:set 里少了这道校验就红（防止以后为了「方便」把它摘掉）
  assert.equal(
    (MAIN_SOURCE.match(/configGate\.filterPathPatch\(/g) || []).length,
    1,
    'config:set 必须调用 configGate.filterPathPatch 做来源校验'
  );
  // 三个正当来源：书架目录对话框 / 校对词表对话框 / 敏感词表对话框，各自记账
  // v1.8.0 WP-34（V114）：校对 / 敏感词词表频道已搬进 ipc/proofread.js —— 与 main.js 一起扫。
  const IPC_SOURCE = MAIN_SOURCE + fs.readFileSync(path.join(__dirname, '..', 'ipc', 'proofread.js'), 'utf8');
  assert.ok(
    MAIN_SOURCE.includes("rememberPickedConfigPath('booksRoot', filePaths[0])"),
    'shell:pick-folder 选中目录后必须记下 booksRoot 的来源'
  );
  assert.ok(
    IPC_SOURCE.includes('rememberPickedConfigPath(field, filePaths[0])'),
    '选词表对话框必须按字段记下来源'
  );
  assert.ok(IPC_SOURCE.includes("field: 'proofreadWordsPath'"), '校对词表必须记到 proofreadWordsPath');
  assert.ok(IPC_SOURCE.includes("field: 'sensitiveWordsPath'"), '敏感词表必须记到 sensitiveWordsPath');
  // 只在 automation 下注册的「模拟选中」频道必须仍然只在 automation 块里
  const testPickAt = MAIN_SOURCE.indexOf("handle('config:test-pick'");
  assert.ok(testPickAt > 0, 'config:test-pick 应该存在（供 E2E 模拟对话框选中）');
  const automationAt = MAIN_SOURCE.lastIndexOf('if (automation) {', testPickAt);
  assert.ok(automationAt > 0, 'config:test-pick 必须在 automation 分支里注册');
});

// C1（审计 S1）：自定义字体路径纳入来源校验（全局 config:set + 按书 book:set-display 两条路）。
test('字体路径来源校验：伪造路径被忽略，原值 / 全局 / 刚选中 / 清空才放行', () => {
  const fonts = path.join(ROOT, '字体');
  const bookFont = path.join(fonts, 'book.ttf');
  const globalFont = path.join(fonts, 'global.ttf');
  const pickedFont = path.join(fonts, 'picked.ttf');
  const forged = path.join(fonts, 'forged.ttf');

  // 全局 config:set 这条路
  const current = { editorCustomFontPath: bookFont };
  assert.deepEqual(configGate.filterPathPatch({ editorCustomFontPath: forged }, { current }), {
    patch: {},
    rejected: ['editorCustomFontPath']
  });
  assert.equal(configGate.filterPathPatch({ editorCustomFontPath: bookFont }, { current }).rejected.length, 0);
  assert.equal(
    configGate.filterPathPatch({ editorCustomFontPath: '' }, { current }).patch.editorCustomFontPath,
    '',
    '清空放行'
  );
  assert.equal(
    configGate.filterPathPatch({ editorCustomFontPath: pickedFont }, { current, picked: { editorCustomFontPath: pickedFont } })
      .patch.editorCustomFontPath,
    pickedFont,
    '本窗口刚选中的放行'
  );
  assert.deepEqual(
    configGate.filterPathPatch({ editorCustomFontPath: 42 }, { current }).rejected,
    ['editorCustomFontPath'],
    '非字符串拒绝（不做类型转换）'
  );

  // 按书 book:set-display 这条路：其它显示项原样透传，只有字体路径要来源
  const bookCurrent = { editorFontSize: 22, editorCustomFontPath: bookFont };
  const bookResult = configGate.filterBookDisplayPatch(
    { editorFont: 'custom', editorFontSize: 24, editorCustomFontPath: forged },
    { current: bookCurrent, global: { editorCustomFontPath: globalFont }, picked: {} }
  );
  assert.deepEqual(bookResult.patch, { editorFont: 'custom', editorFontSize: 24 }, '伪造字体路径被丢掉，其它字段保留');
  assert.deepEqual(bookResult.rejected, ['editorCustomFontPath']);
  assert.equal(
    configGate.filterBookDisplayPatch(
      { editorCustomFontPath: globalFont },
      { current: bookCurrent, global: { editorCustomFontPath: globalFont } }
    ).patch.editorCustomFontPath,
    globalFont,
    '与全局配置相同也放行（清掉按书覆盖时表单会回传全局值）'
  );
  assert.equal(
    configGate.filterBookDisplayPatch(
      { editorCustomFontPath: pickedFont },
      { current: bookCurrent, global: {}, picked: { editorCustomFontPath: pickedFont } }
    ).patch.editorCustomFontPath,
    pickedFont
  );
  assert.equal(
    configGate.filterBookDisplayPatch({ editorCustomFontPath: '' }, { current: bookCurrent }).patch.editorCustomFontPath,
    ''
  );
  assert.deepEqual(configGate.filterBookDisplayPatch({ editorPaper: 'night' }, {}), {
    patch: { editorPaper: 'night' },
    rejected: []
  });
});

// E1（审计 E1）：config:set 里的 bookDisplay 是一整张按书显示设置 map——它不能被「顶层字段原样透传」
// 放过，否则被注入的渲染层能把当前书的 editorCustomFontPath 指到任意 .ttf/otf/ttc，再由 font:read
// 整份 base64 读回。这里锁逐书过滤 + 按书合并的口径（book:set-display 用的是同一个单条目判定）。
test('按书显示 map 来源校验：config:set 夹带的字体路径被拒，原条目保留、别的书不在这份 patch 里（E1）', () => {
  const fonts = path.join(ROOT, '字体-map');
  const bookFont = path.join(fonts, 'book.ttf');
  const pickedFont = path.join(fonts, 'picked.ttf');
  const forged = path.join(fonts, 'forged.ttf');
  const globalFont = path.join(fonts, 'global.ttf');
  const current = {
    editorCustomFontPath: globalFont,
    bookDisplay: {
      bookA: { editorFontSize: 22, editorCustomFontPath: bookFont },
      bookB: { editorPaper: 'night' }
    }
  };

  // 伪造路径：只摘掉 editorCustomFontPath，其它显示项照旧生效；被拒的字体路径保留原条目里的值
  const forgedResult = configGate.filterBookDisplayMapPatch(
    { bookA: { editorFont: 'custom', editorFontSize: 24, editorCustomFontPath: forged } },
    { current }
  );
  assert.deepEqual(forgedResult.patch, {
    bookA: { editorFont: 'custom', editorFontSize: 24, editorCustomFontPath: bookFont }
  });
  assert.deepEqual(forgedResult.rejected, ['bookDisplay']);
  // 只回「patch 里点到的书」：bookB 的覆盖不在这份 patch 里（调用方按书合并，不会把它抹掉）
  assert.deepEqual(Object.keys(forgedResult.patch), ['bookA']);

  // 正当来源：刚在字体对话框里选中的 / 该书原值 / 与全局相同 / 清空，一律放行
  assert.equal(
    configGate.filterBookDisplayMapPatch(
      { bookA: { editorCustomFontPath: pickedFont } },
      { current, picked: { editorCustomFontPath: pickedFont } }
    ).patch.bookA.editorCustomFontPath,
    pickedFont,
    '本窗口刚选中的放行'
  );
  assert.equal(
    configGate.filterBookDisplayMapPatch({ bookA: { editorCustomFontPath: bookFont } }, { current }).rejected.length,
    0,
    '原值原样回传不算来源不明'
  );
  assert.equal(
    configGate.filterBookDisplayMapPatch({ bookA: { editorCustomFontPath: globalFont } }, { current }).patch.bookA
      .editorCustomFontPath,
    globalFont,
    '与全局配置相同也放行（清掉按书覆盖时表单会回传全局值）'
  );
  assert.equal(
    configGate.filterBookDisplayMapPatch({ bookA: { editorCustomFontPath: '' } }, { current }).patch.bookA
      .editorCustomFontPath,
    '',
    '清空放行'
  );
  // 当前没有覆盖的书：伪造路径被拒后只剩空条目（配置清洗会把空条目丢掉，不会凭空建一条覆盖）
  assert.deepEqual(configGate.filterBookDisplayMapPatch({ bookNew: { editorCustomFontPath: forged } }, { current }), {
    patch: { bookNew: {} },
    rejected: ['bookDisplay']
  });

  // 形状不对（不是对象）：整项不生效——调用方丢弃这个键、保留原配置，不能抹掉整份 bookDisplay
  for (const bad of [null, 'x', 42, [], true]) {
    assert.deepEqual(configGate.filterBookDisplayMapPatch(bad, { current }), {
      patch: null,
      rejected: ['bookDisplay']
    });
  }
  // 条目 / 书 id 不合法：只跳过坏条目，好的照旧放行；坏过一次就要回字段名（记日志用）
  const badEntries = configGate.filterBookDisplayMapPatch(
    { bookA: 5, '': { editorPaper: 'night' }, bookB: { editorPaper: 'kraft' } },
    { current }
  );
  assert.deepEqual(badEntries.patch, { bookB: { editorPaper: 'kraft' } });
  assert.deepEqual(badEntries.rejected, ['bookDisplay']);

  // 书 id 写成 __proto__ 也只当一个普通键（Object.fromEntries 用 CreateDataProperty，不改原型链）
  const protoRaw = JSON.parse('{"__proto__": {"editorFontSize": 20}}');
  const protoResult = configGate.filterBookDisplayMapPatch(protoRaw, { current });
  assert.equal(Object.prototype.hasOwnProperty.call(protoResult.patch, '__proto__'), true);
  assert.equal({}.editorFontSize, undefined, '不能污染 Object.prototype');
});

test('静态闸门：config:set 的 bookDisplay 逐书过来源校验并按书合并（E1）', () => {
  const start = MAIN_SOURCE.indexOf("handle('config:set'");
  assert.ok(start > 0, 'main.js 里找不到 config:set');
  const body = MAIN_SOURCE.slice(start, MAIN_SOURCE.indexOf('\n  handle(', start + 1));
  assert.match(body, /configGate\.filterBookDisplayMapPatch\(/, 'config:set 必须逐书过字体来源校验（E1 旁路）');
  assert.match(
    body,
    /\.\.\.Object\.entries\(current\.bookDisplay/,
    '按书合并：只带一本书的 patch 不能抹掉别的书的显示覆盖'
  );
  assert.match(body, /delete gated\.patch\.bookDisplay/, '形状不对的 bookDisplay 整项丢弃（保留原配置）');
});

// 五-M28（CI-5）：整份 bookDisplay map 的条目数同样要有闸 —— 正常 UI 一次只带一本书，
// 一张数十万条的 patch 既不可能是正常设置，也不该让逐条过滤 + 调用方合并 + 配置深拷贝全部白做。
// 上限与 core/config.js 是同一个常量；超限整段拒绝（保留原配置），与「形状不对整项不生效」同口径。
test('按书显示 map：条目数超过 BOOK_DISPLAY_MAX 的整份 patch 直接拒绝（CI-5）', () => {
  const { BOOK_DISPLAY_MAX } = require('../core/config');
  const big = {};
  for (let i = 0; i <= BOOK_DISPLAY_MAX; i += 1) big[`b_${i}`] = { editorFontSize: 20 };
  assert.deepEqual(configGate.filterBookDisplayMapPatch(big, { current: {} }), {
    patch: null,
    rejected: ['bookDisplay']
  });

  // 恰好等于上限、条目形状合法：照常放行（闸门只挡无界增长，不误伤正常 patch）
  const atLimit = {};
  for (let i = 0; i < BOOK_DISPLAY_MAX; i += 1) atLimit[`b_${i}`] = { editorFontSize: 20 };
  const ok = configGate.filterBookDisplayMapPatch(atLimit, { current: {} });
  assert.equal(Object.keys(ok.patch).length, BOOK_DISPLAY_MAX);
  assert.deepEqual(ok.rejected, []);
});

test('静态闸门：book:set-display 过 filterBookDisplayPatch；字体对话框把路径记进来源登记（C1）', () => {
  assert.ok(
    (MAIN_SOURCE.match(/configGate\.filterBookDisplayPatch\(/g) || []).length === 1,
    'book:set-display 必须调用 configGate.filterBookDisplayPatch'
  );
  const setDisplayAt = MAIN_SOURCE.indexOf("handle('book:set-display'");
  assert.ok(setDisplayAt > 0);
  const setDisplayBody = MAIN_SOURCE.slice(setDisplayAt, MAIN_SOURCE.indexOf('\n  });', setDisplayAt));
  assert.match(setDisplayBody, /pickedConfigPaths\.snapshot\(/, '按书字体路径要按窗口的「刚选中」登记放行');
  // font:pick（真实对话框）与 font:test-pick（自检）都要记账，否则设置里选完字体保存会被自己挡掉
  const pickAt = MAIN_SOURCE.indexOf("handle('font:pick'");
  assert.ok(pickAt > 0, 'main.js 里找不到 font:pick');
  const pickBody = MAIN_SOURCE.slice(pickAt, MAIN_SOURCE.indexOf('\n  });', pickAt));
  assert.ok(pickBody.includes("rememberPickedConfigPath('editorCustomFontPath', picked)"), 'font:pick 要记来源');
  const testPickAt = MAIN_SOURCE.indexOf("handle('font:test-pick'");
  assert.ok(testPickAt > 0, 'main.js 里找不到 font:test-pick');
  const testPickBody = MAIN_SOURCE.slice(testPickAt, MAIN_SOURCE.indexOf('\n  });', testPickAt));
  assert.ok(testPickBody.includes("rememberPickedConfigPath('editorCustomFontPath', picked)"), 'font:test-pick 要记来源');
  // font:read 必须先 realpath 再校验扩展名；配置里的绝对路径不回传（只有刚选的那趟回 path）
  const readAt = MAIN_SOURCE.indexOf("handle('font:read'");
  const readBody = MAIN_SOURCE.slice(readAt, MAIN_SOURCE.indexOf('\n  });', readAt));
  assert.match(readBody, /await fs\.realpath\(resolved\)/, 'font:read 要做 realpath');
  assert.match(readBody, /isFontFile\(realPath\)/, 'realpath 之后用真实路径校验扩展名');
  assert.match(readBody, /openFontFile\(fs, realPath, \{/, 'E2：realpath 之后开一次句柄（大小闸 + 读盘同一句柄）');
  assert.match(readBody, /const buffer = await loaded\.read\(\)/, '未命中缓存时从同一句柄读');
  assert.equal(/fs\.stat\(realPath\)/.test(readBody), false, '不许再按路径 stat（E2 TOCTOU）');
  assert.equal(/fs\.readFile\(realPath\)/.test(readBody), false, '不许再按路径 readFile（E2 TOCTOU）');
  assert.match(readBody, /if \(source\.source === 'picked'\) payload\.path = resolved;/, '只有刚选中的那趟回 path');
});

// A3（审计 E3）：config:set 先验证 booksRoot（mkdir 成功）再写配置。
// 旧顺序「先 configStore.set → 再 fs.mkdir」会出现「界面报错但配置已经保存」：
// 重启后书架指向一个建不出来的目录，作者会以为书没了。
test('静态闸门：config:set 先 mkdir 目标书架目录、成功后才写配置（E3 / C2 同 enqueue）', () => {
  const start = MAIN_SOURCE.indexOf("handle('config:set'");
  assert.ok(start > 0, 'main.js 里找不到 config:set');
  const body = MAIN_SOURCE.slice(start, MAIN_SOURCE.indexOf('\n  handle(', start + 1));
  // C2（审计 #21）：mkdir 搬进 configStore.set 的 beforeWrite —— 判根 / 建目录 / 写盘同一个写队列
  const setAt = body.indexOf('configStore.set(gated.patch, {');
  assert.ok(setAt > 0, 'config:set 的写盘必须带 beforeWrite 钩子（判根不能再用队列外快照）');
  const hookAt = body.indexOf('async beforeWrite({ current: freshCurrent })', setAt);
  assert.ok(hookAt > setAt, 'beforeWrite 要作为 configStore.set 的选项传入');
  const mkdirAt = body.indexOf('fs.mkdir(', setAt);
  assert.ok(mkdirAt > hookAt, 'mkdir 只能在钩子里（写盘之前、同一个 enqueue）');
  assert.equal((body.match(/fs\.mkdir\(/g) || []).length, 1, 'config:set 里只该有这一处 mkdir');
  // 建目录的目标必须从「队列内 current + 放行后的 patch」算，而不是队列外快照 / 写盘后的 config
  assert.match(body, /sanitizeConfig\(\{ \.\.\.freshCurrent, \.\.\.gated\.patch \}\)/, 'mkdir 目标要按 sanitize(队列内 current + patch) 算');
  // 播放器 / 自动化覆盖（--books-root）仍指向覆盖目录，不能被 patch 带偏。
  // A3（审计 #9 / O1）起覆盖只在 main.js 的 decorateConfig 一处应用，这里钉住「mkdir 目标过装饰层」。
  assert.match(
    body,
    /decorateConfig\(sanitizeConfig\(\{ \.\.\.freshCurrent, \.\.\.gated\.patch \}\)\)\.booksRoot/,
    'config:set 的 mkdir 目标要过 booksRootOverride 装饰层'
  );
  // 钩子契约在 core/config.js：先 beforeWrite、后 writeJson —— 钩子抛错 ⇒ 配置一个字都不写
  const configSource = require('node:fs')
    .readFileSync(require('node:path').join(__dirname, '..', 'core/config.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  const setStart = configSource.indexOf('function set(patch, options = {})');
  const setBody = configSource.slice(setStart, configSource.indexOf('\n  }\n', setStart));
  assert.ok(
    setBody.indexOf('await beforeWrite({ current, next });') < setBody.indexOf('await writeJson(file, next);'),
    'beforeWrite 必须先于 writeJson（否则又回到「报错但已保存」）'
  );
});

// C23（整合版审计）：config:set 以前每次保存设置都无条件 fs.mkdir(目标书架根)——改字号 / 主题 /
// 按书字体这类无关 patch 也会去碰书架目录；书架在断开的网络盘 / USB 上时，保存一个无关设置会失败。
// 判「根变没变」抽成纯函数，两个根都按「装饰后的生效根」比（--books-root 覆盖时就是覆盖目录）。
test('C23：书架根变化判定走全仓唯一 pathKey 口径（无关 patch 判成没变）', () => {
  assert.equal(configGate.booksRootChanged(bookRoot, bookRoot), false, '同一个根不算变');
  assert.equal(configGate.booksRootChanged(bookRoot, bookRoot.toUpperCase()), false, '大小写不同不算变');
  assert.equal(configGate.booksRootChanged(bookRoot, bookRoot + path.sep), false, '末尾多一个分隔符不算变');
  assert.equal(configGate.booksRootChanged(bookRoot, bookRoot.replace(/\\/g, '/')), false, '正反斜杠混用不算变');
  assert.equal(configGate.booksRootChanged(bookRoot, path.join(bookRoot, '.')), false, '带 . 的写法不算变');
  assert.equal(configGate.booksRootChanged(bookRoot, path.join(ROOT, '换过的书架')), true, '真的换了根要能认出来');
  assert.equal(configGate.booksRootChanged(bookRoot, ''), true, '有根 → 空（清洗会回默认根）算变');
  assert.equal(configGate.booksRootChanged('', null), false, '两边都没有根不算变');
  assert.equal(configGate.booksRootChanged(null, bookRoot), true);
});

test('静态闸门：config:set 只在书架根变化时 mkdir（C23 / C2）', () => {
  const start = MAIN_SOURCE.indexOf("handle('config:set'");
  assert.ok(start > 0, 'main.js 里找不到 config:set');
  const body = MAIN_SOURCE.slice(start, MAIN_SOURCE.indexOf('\n  handle(', start + 1));
  // 函数体里只该有一处 mkdir，并且挂在「根真的变化」的分支里
  assert.equal((body.match(/fs\.mkdir\(/g) || []).length, 1, 'config:set 里只该有这一处 mkdir');
  assert.match(
    body,
    /if \(configGate\.booksRootChanged\(previousRoot, targetRoot\)\) \{\s*await fs\.mkdir\(targetRoot, \{ recursive: true \}\);\s*\}/,
    'mkdir 必须在「书架根真的变化」的分支里（改字号 / 主题这类无关 patch 不碰书架目录）'
  );
  // 判变化的两边都要过「sanitize + 装饰层」：--books-root 覆盖时生效根是覆盖目录。
  // C2（审计 #21）：previousRoot 必须取自 configStore.set 钩子里的 freshCurrent（队列内），
  // 不是入队前的 current 快照 —— 并发写配置时快照会过期。
  assert.match(
    body,
    /previousRoot = decorateConfig\(sanitizeConfig\(freshCurrent\)\)\.booksRoot;/,
    '换根前的生效根要用队列内 current（beforeWrite 的 freshCurrent）'
  );
  assert.match(
    body,
    /const targetRoot = decorateConfig\(sanitizeConfig\(\{ \.\.\.freshCurrent, \.\.\.gated\.patch \}\)\)\.booksRoot;/,
    '目标根走同一份 sanitize + 装饰层'
  );
  // A3 顺序语义不变：判根变化 → mkdir → 写盘；C2 之后前两步在 beforeWrite 里，写盘紧随其后
  // （core/config.js 的 set 契约由 R17 行为锚点钉住：beforeWrite 先于 writeJson）。
  const hookAt = body.indexOf('async beforeWrite({ current: freshCurrent })');
  const changeAt = body.indexOf('booksRootChanged(previousRoot, targetRoot)');
  const mkdirAt = body.indexOf('fs.mkdir(');
  assert.ok(
    hookAt > -1 && changeAt > hookAt && mkdirAt > changeAt,
    '顺序必须是：beforeWrite 内判根变化 → mkdir（写盘在钩子之后）'
  );
  // A4 换根清锁共用同一判据，不许再各写一份 path.resolve(...).toLowerCase() 比较
  assert.match(
    body,
    /if \(configGate\.booksRootChanged\(previousRoot, nextConfig\.booksRoot\)\)/,
    '换根后清锁要用同一个「根是否变化」判据'
  );
  assert.ok(!body.includes('path.resolve(nextConfig.booksRoot).toLowerCase()'), '不再各写一份大小写比较');
});
