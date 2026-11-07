const test = require('node:test');
const assert = require('node:assert/strict');
const reading = require('../renderer/reading-logic');

test('阅读模式：字号四档默认「大」22px，坏值回默认、越界夹紧', () => {
  assert.deepEqual(reading.READING_FONT_LEVELS, [17, 19, 22, 25]);
  assert.deepEqual(reading.READING_FONT_LABELS, ['小', '中', '大', '特大']);
  assert.equal(reading.fontSize(undefined), 22);
  assert.equal(reading.fontSize(null), 22);
  assert.equal(reading.fontSize('abc'), 22);
  assert.equal(reading.fontSize(0), 17);
  assert.equal(reading.fontSize(1), 19);
  assert.equal(reading.fontSize('2'), 22);
  assert.equal(reading.fontSize(3), 25);
  // 超出 0–3 的夹到两端
  assert.equal(reading.fontSize(-1), 17);
  assert.equal(reading.fontSize(9), 25);
  assert.equal(reading.fontSize(1.9), 19); // 向下取整
  assert.equal(reading.fontLevel(Infinity), reading.READING_FONT_DEFAULT);
});

test('阅读模式：行距三档默认「标准」2.0，坏值回默认、越界夹紧', () => {
  assert.deepEqual(reading.READING_LINE_LEVELS, [1.7, 2.0, 2.3]);
  assert.deepEqual(reading.READING_LINE_LABELS, ['紧凑', '标准', '宽松']);
  assert.equal(reading.lineHeight(undefined), 2.0);
  assert.equal(reading.lineHeight('x'), 2.0);
  assert.equal(reading.lineHeight(0), 1.7);
  assert.equal(reading.lineHeight(1), 2.0);
  assert.equal(reading.lineHeight(2), 2.3);
  assert.equal(reading.lineHeight(-3), 1.7);
  assert.equal(reading.lineHeight(10), 2.3);
  assert.equal(reading.lineLevel(NaN), reading.READING_LINE_DEFAULT);
});

test('阅读模式：进度文字按「看到第几章」算，首章 / 末章 / 夹紧都正确', () => {
  assert.deepEqual(reading.readingProgress(0, 3), {
    index: 0,
    current: 1,
    total: 3,
    percent: 33.3,
    text: '第 1 / 3 章 · 33.3%'
  });
  assert.equal(reading.readingProgress(1, 3).percent, 66.7);
  assert.equal(reading.readingProgress(2, 3).percent, 100);
  assert.equal(reading.readingProgress(2, 3).text, '第 3 / 3 章 · 100%');
  // 下标越界夹到首 / 末；坏值当第一页
  assert.equal(reading.readingProgress(-5, 10).index, 0);
  assert.equal(reading.readingProgress(99, 10).index, 9);
  assert.equal(reading.readingProgress('abc', 10).index, 0);
  assert.equal(reading.readingProgress(3.9, 10).index, 3);
  // 没有章节时不显示「第 1 / 0 章」
  assert.deepEqual(reading.readingProgress(0, 0), {
    index: -1,
    current: 0,
    total: 0,
    percent: 0,
    text: '全书还没有章节'
  });
  assert.equal(reading.readingProgress(null, -3).total, 0);
});

test('阅读模式：按区块顶端算当前章，含 offset 与未滚到首章的情况', () => {
  const blocks = [
    { index: 0, top: 0 },
    { index: 1, top: 900 },
    { index: 2, top: 1800 }
  ];
  assert.equal(reading.blockAtScroll(blocks, 0), 0);
  assert.equal(reading.blockAtScroll(blocks, 400), 0);
  // offset 24：刚好到 900 时还差 24px，算上一章；超过 24 才算下一章
  assert.equal(reading.blockAtScroll(blocks, 875), 0);
  assert.equal(reading.blockAtScroll(blocks, 880), 1);
  assert.equal(reading.blockAtScroll(blocks, 1200), 1);
  assert.equal(reading.blockAtScroll(blocks, 2000), 2);
  // 滚到比最后一章还下面：仍是最后一章
  assert.equal(reading.blockAtScroll(blocks, 99999), 2);
  // 滚到负值按 0 算
  assert.equal(reading.blockAtScroll(blocks, -50), 0);
  // 空数组 / 坏输入返回 -1
  assert.equal(reading.blockAtScroll([], 10), -1);
  assert.equal(reading.blockAtScroll(null, 10), -1);
  // 乱序也取「top 最大且不超过可见线」的那个
  assert.equal(
    reading.blockAtScroll(
      [
        { index: 2, top: 1800 },
        { index: 0, top: 0 },
        { index: 1, top: 900 }
      ],
      1000
    ),
    1
  );
  // 坏条目跳过；全坏时返回 -1
  assert.equal(reading.blockAtScroll([{ index: 'x', top: 0 }, null, { index: 1, top: 100 }], 50), 1);
  assert.equal(reading.blockAtScroll([{ index: 0, top: 'x' }, null], 50), -1);
  // offset 传坏值按默认 24；显式 0 时不加偏移
  assert.equal(reading.blockAtScroll(blocks, 900), 1);
  assert.equal(reading.blockAtScroll(blocks, 899, 0), 0);
  assert.equal(reading.blockAtScroll(blocks, 900, 0), 1);
});

test('阅读模式：接近底部判定（自动接下一章用）', () => {
  // 可滚动 1000，滚动到 700：还差 300，默认阈值 320 → 算接近底部
  assert.equal(
    reading.nearBottom({ scrollTop: 700, scrollHeight: 1600, clientHeight: 600 }),
    true
  );
  // 还差 321 → 不算
  assert.equal(
    reading.nearBottom({ scrollTop: 679, scrollHeight: 1600, clientHeight: 600 }),
    false
  );
  // 内容不足一屏：直接算到底
  assert.equal(reading.nearBottom({ scrollTop: 0, scrollHeight: 400, clientHeight: 600 }), true);
  // 已经超过最大滚动（浏览器会夹住）：仍然算到底
  assert.equal(reading.nearBottom({ scrollTop: 2000, scrollHeight: 1600, clientHeight: 600 }), true);
  // 阈值可调；坏值 / 负数按 0 / 默认处理
  assert.equal(
    reading.nearBottom({ scrollTop: 600, scrollHeight: 1600, clientHeight: 600, threshold: 500 }),
    true
  );
  assert.equal(
    reading.nearBottom({ scrollTop: 100, scrollHeight: 1600, clientHeight: 600, threshold: -10 }),
    false
  );
  // 坏输入不炸
  assert.equal(reading.nearBottom(null), true);
  assert.equal(reading.nearBottom({ scrollTop: 'x', scrollHeight: 'y', clientHeight: 'z' }), true);
});

test('阅读模式：上一章 / 下一章不越界，章首章尾返回 null', () => {
  assert.equal(reading.stepIndex(1, 3, 1), 2);
  assert.equal(reading.stepIndex(1, 3, -1), 0);
  assert.equal(reading.stepIndex(0, 3, -1), null);
  assert.equal(reading.stepIndex(2, 3, 1), null);
  assert.equal(reading.stepIndex(0, 1, 1), null);
  assert.equal(reading.stepIndex(0, 0, 1), null);
  // 坏下标先夹紧再走一步
  assert.equal(reading.stepIndex(-2, 3, 1), 1);
  assert.equal(reading.stepIndex(99, 3, -1), 1);
  assert.equal(reading.stepIndex('1', 3, 1), 2);
  assert.equal(reading.stepIndex('x', 3, 1), 1);
  // direction 非负都当「下一章」；负数（含 -0.1）当上一章
  assert.equal(reading.stepIndex(0, 3, 0), 1);
  assert.equal(reading.stepIndex(0, 3, -0.1), null);
  assert.equal(reading.stepIndex(1, 3, -0.1), 0);
});

test('阅读模式：全书字数只累加书目的非负字数缓存', () => {
  assert.equal(reading.bookChars([{ chars: 100 }, { chars: '50' }, { chars: 0 }]), 150);
  assert.equal(reading.bookChars([{ chars: -5 }, { chars: 'abc' }, null, {}]), 0);
  assert.equal(reading.bookChars([]), 0);
  assert.equal(reading.bookChars(null), 0);
  assert.equal(reading.bookChars([{ chars: 1.6 }, { chars: 2.4 }]), 4);
});

test('阅读模式：Ctrl+= / Ctrl+- 的档位步进只认字符（布局差异都在映射里吃掉）', () => {
  // 加号：US 主键盘的 '=' 与 Shift+= / 小键盘的 '+'
  assert.equal(reading.fontStepForKey('='), 1);
  assert.equal(reading.fontStepForKey('+'), 1);
  // 减号：'-' 与 Shift+- 的 '_'
  assert.equal(reading.fontStepForKey('-'), -1);
  assert.equal(reading.fontStepForKey('_'), -1);
  // 其它键一律 0（这里不管有没有按 Ctrl，由调用方判断）
  for (const key of ['0', 'a', 'ArrowLeft', 'ArrowRight', 'PageDown', 'F2', ' ', '']) {
    assert.equal(reading.fontStepForKey(key), 0, `${JSON.stringify(key)} 不该被当成字号键`);
  }
  assert.equal(reading.fontStepForKey(null), 0);
  assert.equal(reading.fontStepForKey(undefined), 0);
  assert.equal(reading.fontStepForKey(0), 0, '数字 0 不是加号');
  // 步进结果再过一遍档位：两端夹紧、不越界
  assert.equal(reading.fontLevel(reading.fontLevel(3) + reading.fontStepForKey('=')), 3);
  assert.equal(reading.fontLevel(reading.fontLevel(0) + reading.fontStepForKey('-')), 0);
});

test('阅读模式：窗口标题后缀带当前章号（第 2/3 章），无章节时退回「（阅读）」', () => {
  // 章号 1 基、口径与进度文字一致（第 1 / 3 章 = 第 1/3 章）
  assert.equal(reading.readingTitleSuffix(0, 3), '（阅读 · 第 1/3 章）');
  assert.equal(reading.readingTitleSuffix(1, 3), '（阅读 · 第 2/3 章）');
  assert.equal(reading.readingTitleSuffix(2, 3), '（阅读 · 第 3/3 章）');
  assert.equal(reading.readingTitleSuffix(1, 12), '（阅读 · 第 2/12 章）');
  // 坏下标 / 越界先夹紧，不出现「第 0 章」「第 9 章」
  assert.equal(reading.readingTitleSuffix(-2, 3), '（阅读 · 第 1/3 章）');
  assert.equal(reading.readingTitleSuffix(99, 3), '（阅读 · 第 3/3 章）');
  assert.equal(reading.readingTitleSuffix('1', 3), '（阅读 · 第 2/3 章）');
  assert.equal(reading.readingTitleSuffix(1.9, 3), '（阅读 · 第 2/3 章）', '向下取整');
  assert.equal(reading.readingTitleSuffix('x', 3), '（阅读 · 第 1/3 章）', '坏值按第 1 章');
  assert.equal(reading.readingTitleSuffix(undefined, 3), '（阅读 · 第 1/3 章）');
  // 全书没有章节（或总数坏掉）：仍要能看出是只读阅读视图
  assert.equal(reading.readingTitleSuffix(0, 0), '（阅读）');
  assert.equal(reading.readingTitleSuffix(5, 0), '（阅读）');
  assert.equal(reading.readingTitleSuffix(1, 'x'), '（阅读）');
  assert.equal(reading.readingTitleSuffix(1, -3), '（阅读）');
  // 只管字符串：不返回对象、不改入参
  assert.equal(typeof reading.readingTitleSuffix(1, 3), 'string');
});

test('阅读字号 / 行距按书记忆（Phase D / D13）：每本书一份，只记本次运行，坏值 / 空路径都回默认档', () => {
  // 没有记录 = 默认档；store 坏掉也不抛错
  assert.deepEqual(reading.prefsForBook(new Map(), '/书库/书甲'), { fontLevel: 2, lineLevel: 1 });
  assert.deepEqual(reading.prefsForBook(undefined, '/书库/书甲'), { fontLevel: 2, lineLevel: 1 });
  assert.deepEqual(reading.prefsForBook('oops', '/书库/书甲'), { fontLevel: 2, lineLevel: 1 });

  // 写一本书不改传进来的 store（纯函数），另一本书仍是默认档
  const empty = new Map();
  const one = reading.withBookPrefs(empty, '/书库/书甲', { fontLevel: 3, lineLevel: 2 });
  assert.equal(empty.size, 0, '不改传入的 store');
  assert.deepEqual(reading.prefsForBook(one, '/书库/书甲'), { fontLevel: 3, lineLevel: 2 });
  assert.deepEqual(reading.prefsForBook(one, '/书库/书乙'), { fontLevel: 2, lineLevel: 1 }, '换一本书回默认档');
  // 路径两边空白算同一本书；空 / 坏路径一律回默认档，也不占位
  assert.deepEqual(reading.prefsForBook(one, '  /书库/书甲  '), { fontLevel: 3, lineLevel: 2 });
  assert.equal(reading.withBookPrefs(one, '   ', { fontLevel: 0, lineLevel: 0 }).size, 1, '空路径不新增记录');
  assert.equal(reading.withBookPrefs(one, null, { fontLevel: 0 }).size, 1);
  assert.deepEqual(reading.prefsForBook(reading.withBookPrefs(one, null, { fontLevel: 0 }), null), {
    fontLevel: 2,
    lineLevel: 1
  });
  // 写进去的坏档位夹紧；表里已有坏记录读出来也夹紧
  const clamped = reading.withBookPrefs(one, '/书库/书丙', { fontLevel: 99, lineLevel: 'x' });
  assert.deepEqual(reading.prefsForBook(clamped, '/书库/书丙'), { fontLevel: 3, lineLevel: 1 });
  assert.deepEqual(reading.withBookPrefs(one, '/书库/书丙', null).get('/书库/书丙'), {
    fontLevel: 2,
    lineLevel: 1
  });
  const dirty = new Map([
    ['/书库/书丁', { fontLevel: -5, lineLevel: 7 }],
    ['/书库/书戊', null],
    ['/书库/书己', 'oops']
  ]);
  assert.deepEqual(reading.prefsForBook(dirty, '/书库/书丁'), { fontLevel: 0, lineLevel: 2 });
  assert.deepEqual(reading.prefsForBook(dirty, '/书库/书戊'), { fontLevel: 2, lineLevel: 1 });
  assert.deepEqual(reading.prefsForBook(dirty, '/书库/书己'), { fontLevel: 2, lineLevel: 1 });
});

test('阅读目录分卷分段：连续卷段切组，坏卷 id 回「未分卷」，空卷名给「未命名卷」', () => {
  const chapters = [
    { name: 'A' },
    { name: 'B', volumeId: 'v1' },
    { name: 'C', volumeId: 'v1' },
    { name: 'D', volumeId: 'v2' },
    { name: 'E', volumeId: 'v2' },
    { name: 'F' }
  ];
  const volumes = [{ id: 'v1', name: '第一卷' }, { id: 'v2', name: '  ' }];
  const groups = reading.tocGroups(chapters, volumes);
  assert.deepEqual(
    groups.map((g) => [g.volumeId, g.label, g.indexes]),
    [
      ['', '未分卷', [0]],
      ['v1', '第一卷', [1, 2]],
      ['v2', '未命名卷', [3, 4]],
      ['', '未分卷', [5]]
    ],
    '先是未分卷 → 第1卷 → 第2卷 → 又一段未分卷（界面顺序就是数组顺序，不重排）'
  );

  // 没有分卷 / 空的 volumes：只有一段（调用方平铺渲染，外观与以前一致）
  assert.deepEqual(reading.tocGroups([{ name: 'A' }, { name: 'B' }], []), [
    { volumeId: '', label: '未分卷', indexes: [0, 1] }
  ]);
  assert.deepEqual(reading.tocGroups([{ name: 'A' }], undefined).length, 1);
  // 坏输入：数组 / 对象 / 卷缺 id 都跳过，不抛错
  const messy = reading.tocGroups(
    [{ name: 'A', volumeId: 'v9' }, null, { name: 'B', volumeId: 42 }, { name: 'C', volumeId: 'v1' }],
    [null, { id: '', name: '空 id' }, { id: 'v1', name: '第一卷' }]
  );
  assert.deepEqual(messy.map((g) => [g.label, g.indexes]), [
    ['未分卷', [0, 1, 2]],
    ['第一卷', [3]]
  ]);
  // 没有章节：空数组（目录下拉就空着，不造空 optgroup）
  assert.deepEqual(reading.tocGroups([], [{ id: 'v1', name: '第一卷' }]), []);
  assert.deepEqual(reading.tocGroups(null, null), []);
});

// v0.13 / U-D10：阅读位置记忆（只记本次运行）。纯逻辑三件套：
// 记录（positionAtScroll）→ 存（withReadingPosition）→ 重进时取（readingPositionForBook / readingStartIndex）。
test('阅读位置：滚动位置换算成「哪一章 + 章内比例」，取视口上沿最靠下的区块', () => {
  const blocks = [
    { index: 0, top: 0, height: 1000 },
    { index: 1, top: 1000, height: 500 },
    { index: 2, top: 1500, height: 300 }
  ];
  assert.deepEqual(reading.positionAtScroll(blocks, 0), { index: 0, ratio: 0 });
  assert.deepEqual(reading.positionAtScroll(blocks, 250), { index: 0, ratio: 0.25 });
  assert.deepEqual(reading.positionAtScroll(blocks, 999), { index: 0, ratio: 0.999 });
  assert.deepEqual(reading.positionAtScroll(blocks, 1000), { index: 1, ratio: 0 }, '块顶正好压在上沿 → 算这一块');
  assert.deepEqual(reading.positionAtScroll(blocks, 1250), { index: 1, ratio: 0.5 });
  assert.deepEqual(reading.positionAtScroll(blocks, 1600), { index: 2, ratio: 1 / 3 });
  assert.deepEqual(reading.positionAtScroll(blocks, 99999), { index: 2, ratio: 1 }, '比例夹到 1');
  // 还没滚到第一块（顶部有 padding 之类）：算第一章章顶
  assert.deepEqual(reading.positionAtScroll([{ index: 0, top: 24, height: 800 }], 0), { index: 0, ratio: 0 });
  // 高度算不出来 → 比例给 0，不除零
  assert.deepEqual(reading.positionAtScroll([{ index: 0, top: 0, height: 0 }], 100), { index: 0, ratio: 0 });
  assert.deepEqual(reading.positionAtScroll([{ index: 0, top: 0 }], 100), { index: 0, ratio: 0 });
  // 坏块跳过；全坏 / 空返回 null
  const messy = [null, { index: 'x', top: 0 }, { index: 3, top: 40, height: 100 }, { index: 4 }];
  assert.deepEqual(reading.positionAtScroll(messy, 90), { index: 3, ratio: 0.5 });
  assert.equal(reading.positionAtScroll([], 0), null);
  assert.equal(reading.positionAtScroll(null, 0), null);
  assert.equal(reading.positionAtScroll([null, { top: 1 }, { index: 'x', top: 2 }], 0), null);
  // 纯函数：不改入参
  const frozen = JSON.stringify(blocks);
  reading.positionAtScroll(blocks, 1250);
  assert.equal(JSON.stringify(blocks), frozen);
});

test('阅读位置按书记忆（v0.13 / U-D10）：每本书一份、错值夹紧、只记本次运行（不改传入的表）', () => {
  const none = { index: -1, ratio: 0, editorIndex: -1 };
  assert.deepEqual(reading.readingPositionForBook(new Map(), '/书库/书甲', 3), none);
  assert.deepEqual(reading.readingPositionForBook(undefined, '/书库/书甲', 3), none);
  assert.deepEqual(reading.readingPositionForBook('oops', '/书库/书甲', 3), none);
  assert.deepEqual(reading.readingPositionForBook(new Map(), '/书库/书甲', 0), none, '没有章节就没有位置');
  assert.deepEqual(reading.readingPositionForBook(new Map(), '   ', 3), none, '空路径不占位');

  // 写一本书：不改传进来的 store；路径两边空白算同一本书；换一本书仍然没有位置
  const empty = new Map();
  const one = reading.withReadingPosition(empty, '/书库/书甲', { index: 2, ratio: 0.5, editorIndex: 1 }, 5);
  assert.equal(empty.size, 0, '不改传入的 store');
  assert.deepEqual(reading.readingPositionForBook(one, '/书库/书甲', 5), { index: 2, ratio: 0.5, editorIndex: 1 });
  assert.deepEqual(reading.readingPositionForBook(one, '  /书库/书甲  ', 5), { index: 2, ratio: 0.5, editorIndex: 1 });
  assert.deepEqual(reading.readingPositionForBook(one, '/书库/书乙', 5), none, '换一本书没有记录');
  assert.equal(reading.withReadingPosition(one, '   ', { index: 1 }, 5).size, 1, '空路径不新增记录');
  assert.equal(reading.withReadingPosition(one, null, { index: 1 }, 5).size, 1);
  assert.equal(reading.withReadingPosition(one, '/书库/书甲', null, 5).size, 1, '位置坏掉不覆盖旧记录');
  assert.equal(reading.withReadingPosition(one, '/书库/书甲', { index: 'x' }, 5).size, 1);
  assert.equal(reading.withReadingPosition(one, '/书库/书甲', { index: 1 }, 0).size, 1, '没有章节不记');

  // 越界 / 坏值夹紧；缺 editorIndex 时按 index 记（当作同一章）
  const clamped = reading.withReadingPosition(one, '/书库/书丙', { index: 99, ratio: 7, editorIndex: 99 }, 5);
  assert.deepEqual(reading.readingPositionForBook(clamped, '/书库/书丙', 5), { index: 4, ratio: 1, editorIndex: 4 });
  const noEditor = reading.withReadingPosition(one, '/书库/书丁', { index: 2 }, 5);
  assert.deepEqual(reading.readingPositionForBook(noEditor, '/书库/书丁', 5), { index: 2, ratio: 0, editorIndex: 2 });
  // 表里已有的坏记录读出来也夹紧 / 当没有
  const dirty = new Map([
    ['/书库/书戊', { index: 1, ratio: 'x', editorIndex: -3 }],
    ['/书库/书己', { index: 'x', ratio: 0.5, editorIndex: 0 }],
    ['/书库/书庚', null],
    ['/书库/书辛', 'oops']
  ]);
  assert.deepEqual(reading.readingPositionForBook(dirty, '/书库/书戊', 5), { index: 1, ratio: 0, editorIndex: 0 });
  assert.deepEqual(reading.readingPositionForBook(dirty, '/书库/书己', 5), none);
  assert.deepEqual(reading.readingPositionForBook(dirty, '/书库/书庚', 5), none);
  assert.deepEqual(reading.readingPositionForBook(dirty, '/书库/书辛', 5), none);
});

test('阅读位置：重进时只有「编辑区没换过章」才回到上次位置，否则按编辑器当前章', () => {
  // 没有记录 / 坏参数：一律按编辑区当前章（夹到合法范围）
  assert.equal(reading.readingStartIndex({ index: -1, ratio: 0, editorIndex: -1 }, 2, 5), 2);
  assert.equal(reading.readingStartIndex(null, 2, 5), 2);
  assert.equal(reading.readingStartIndex(undefined, 'x', 5), 0);
  assert.equal(reading.readingStartIndex(null, 99, 5), 4);
  assert.equal(reading.readingStartIndex(null, -2, 5), 0);
  assert.equal(reading.readingStartIndex(null, 0, 0), 0, '没有章节只给 0');

  const saved = { index: 4, ratio: 0.5, editorIndex: 2 };
  assert.equal(reading.readingStartIndex(saved, 2, 5), 4, '编辑区还在记位置时那一章 → 回到上次读到的章');
  assert.equal(reading.readingStartIndex(saved, 3, 5), 3, '作者在编辑器里换了章 → 以编辑器当前章为起点');
  assert.equal(reading.readingStartIndex({ ...saved, index: 99 }, 2, 5), 4, '记录的章越界夹紧');
  assert.equal(reading.readingStartIndex({ ...saved, index: 'x' }, 2, 5), 2, '记录坏掉按编辑器当前章');
});

test('阅读位置：记录 → 重开同书 → 恢复 / 重启（新的表）→ 回到默认', () => {
  // 退出时：视口上沿在第 2 章章内 40% 处（章 1 高 1000，章 2 高 500）
  const blocks = [
    { index: 0, top: 0, height: 1000 },
    { index: 1, top: 1000, height: 500 }
  ];
  const atExit = reading.positionAtScroll(blocks, 1200);
  assert.deepEqual(atExit, { index: 1, ratio: 0.4 });

  // 记进内存表（编辑区停在 0 章）
  const store = reading.withReadingPosition(new Map(), '/书库/长篇', { ...atExit, editorIndex: 0 }, 3);
  // 重开同一本书、编辑区还停在 0 章：回到第 2 章、比例 0.4（章号与章内位置都回来）
  const saved = reading.readingPositionForBook(store, '/书库/长篇', 3);
  assert.deepEqual(saved, { index: 1, ratio: 0.4, editorIndex: 0 });
  assert.equal(reading.readingStartIndex(saved, 0, 3), 1);
  // 作者在编辑器里点了第 3 章再进阅读：按第 3 章开始（不抢他的选择）
  assert.equal(reading.readingStartIndex(saved, 2, 3), 2);
  // 「重启」= 新的空表（内存里没有任何记录）：回到默认，从编辑区当前章开始
  const afterRestart = reading.readingPositionForBook(new Map(), '/书库/长篇', 3);
  assert.deepEqual(afterRestart, { index: -1, ratio: 0, editorIndex: -1 });
  assert.equal(reading.readingStartIndex(afterRestart, 2, 3), 2);
  // 换书再回来：另一本书的位置互不影响
  const twoBooks = reading.withReadingPosition(store, '/书库/短篇', { index: 0, ratio: 0.9, editorIndex: 0 }, 3);
  assert.deepEqual(reading.readingPositionForBook(twoBooks, '/书库/长篇', 3), saved);
  assert.deepEqual(reading.readingPositionForBook(twoBooks, '/书库/短篇', 3), { index: 0, ratio: 0.9, editorIndex: 0 });
});
