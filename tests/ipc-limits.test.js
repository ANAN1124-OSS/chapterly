const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ipcLimits = require('../core/ipc-limits');
const jumpLib = require('../core/jump');
const exporter = require('../core/exporter');

// v0.9 C-5：IPC 参数边界与 DoS。
// 这里锁三件事：
//   1. 边界函数本身（类型 / 长度 / 替换放大估算 / override / range / 章节列表）；
//   2. 「降级不报错」的历史行为（坏 override / 坏 range 当没传，坏章节条目当空）；
//   3. 静态闸门：main.js 的文本类 / 导出类频道必须真的过了这一层 —— 以后新增入口绕不过去。
// 真实 Electron 侧的回归在 E2E 第 61 组（伪参数被拒 / 降级，主进程仍在响应）。

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function registrations(source) {
  const re = /^[ \t]+(handleBook|handle)\('([^']+)'/gm;
  const hits = [];
  let match;
  while ((match = re.exec(source))) hits.push({ kind: match[1], channel: match[2], at: match.index });
  return hits.map((hit, index) => ({
    ...hit,
    body: source.slice(hit.at, index + 1 < hits.length ? hits[index + 1].at : source.length)
  }));
}

const REGISTRATIONS = registrations(MAIN_SOURCE);
const bodyOf = (channel) => {
  const hit = REGISTRATIONS.find((item) => item.channel === channel);
  assert.ok(hit, `main.js 里找不到频道 ${channel}`);
  return hit.body;
};

test('正文上限：正常 / 正好上限放行，超一个字就 TEXT_TOO_LARGE（中文提示、带千分位）', () => {
  const max = ipcLimits.MAX_TEXT_CHARS;
  assert.equal(ipcLimits.textProblem('正文'), null);
  assert.equal(ipcLimits.textProblem('a'.repeat(max)), null);
  const over = ipcLimits.textProblem('a'.repeat(max + 1));
  assert.equal(over.code, 'TEXT_TOO_LARGE');
  assert.equal(over.message, '正文太长（5,000,001 字，最多 5,000,000 字）');
  // 自定义上限 / 标签（override 用「当前章正文」）
  assert.equal(ipcLimits.textProblem('abc', { max: 3 }), null);
  assert.equal(ipcLimits.textProblem('abcd', { max: 3, label: '当前章正文' }).message, '当前章正文太长（4 字，最多 3 字）');
  // 纯函数不抛错，assert 版才抛；错误码 / 中文文案都稳定
  assert.equal(ipcLimits.assertText('正文'), '正文');
  assert.throws(
    () => ipcLimits.assertText('a'.repeat(max + 1)),
    (err) =>
      err instanceof ipcLimits.IpcLimitError &&
      err.code === 'TEXT_TOO_LARGE' &&
      err.message === '正文太长（5,000,001 字，最多 5,000,000 字）'
  );
});

test('正文类型：非字符串一律 BAD_TEXT（不参与 String() 隐式转换）', () => {
  for (const value of [null, undefined, 123, {}, [], Buffer.from('x'), new String('x')]) {
    const problem = ipcLimits.textProblem(value);
    assert.equal(problem.code, 'BAD_TEXT', `应当拒绝：${String(value)}`);
    assert.equal(problem.message, '正文必须是文本');
  }
  assert.throws(() => ipcLimits.assertText(42), (err) => err.code === 'BAD_TEXT');
});

test('查找词 / 替换词：空值归一成空串，字符串限 1 万字，非字符串拒绝', () => {
  assert.equal(ipcLimits.queryProblem(undefined), null);
  assert.equal(ipcLimits.queryProblem(null), null);
  assert.equal(ipcLimits.assertQuery(undefined), '');
  assert.equal(ipcLimits.assertQuery(null), '');
  assert.equal(ipcLimits.assertQuery('  空格  '), '  空格  '); // 不 trim：查找口径不变
  assert.equal(ipcLimits.queryProblem('a'.repeat(ipcLimits.MAX_QUERY_CHARS)), null);
  assert.equal(ipcLimits.queryProblem('a'.repeat(ipcLimits.MAX_QUERY_CHARS + 1)).code, 'QUERY_TOO_LARGE');
  for (const value of [0, 123, {}, [], true]) {
    assert.equal(ipcLimits.queryProblem(value).code, 'BAD_QUERY', `应当拒绝：${String(value)}`);
  }
  assert.equal(ipcLimits.replacementProblem(undefined), null);
  assert.equal(ipcLimits.replacementProblem(null), null);
  assert.equal(ipcLimits.assertReplacement(undefined), '');
  assert.equal(ipcLimits.replacementProblem('x'.repeat(ipcLimits.MAX_REPLACEMENT_CHARS)), null);
  assert.equal(
    ipcLimits.replacementProblem('x'.repeat(ipcLimits.MAX_REPLACEMENT_CHARS + 1)).code,
    'REPLACEMENT_TOO_LARGE'
  );
  assert.equal(ipcLimits.replacementProblem({}).code, 'BAD_REPLACEMENT');
});

test('替换放大估算：结果超过 2000 万字先拒绝（不生成字符串）', () => {
  const limit = ipcLimits.MAX_REPLACE_OUTPUT_CHARS;
  // 普通替换：原文 1 万 + 10 处 ×（2-1）= 10010 → 放行
  assert.equal(ipcLimits.replaceOutputProblem(10000, 10, 1, 2), null);
  // 正好上限放行、多一个字拒绝
  assert.equal(ipcLimits.replaceOutputProblem(limit, 0, 1, 1), null);
  assert.equal(ipcLimits.replaceOutputProblem(limit, 1, 1, 2).code, 'REPLACE_TOO_LARGE');
  // 一处换 1 万字 × 5000 处：估算 5 千万 → 拒绝，文案带千分位
  const huge = ipcLimits.replaceOutputProblem(5000, 5000, 1, 10000);
  assert.equal(huge.code, 'REPLACE_TOO_LARGE');
  assert.match(huge.message, /^替换结果太大（约 50,000,000 字，最多 20,000,000 字）；/);
  // 替换词比查找词短：结果只会变短，不算放大
  assert.equal(ipcLimits.replaceOutputProblem(10000, 5000, 10, 1), null);
  // 坏参数当 0，不抛错
  assert.equal(ipcLimits.replaceOutputProblem(null, undefined, NaN, {}), null);
  assert.throws(
    () => ipcLimits.assertReplaceOutput(1, 5000, 1, 10000),
    (err) => err.code === 'REPLACE_TOO_LARGE'
  );
});

test('override / ref：坏形状降级成 null，超长正文拒绝，id 只留合法短字符串', () => {
  assert.equal(ipcLimits.sanitizeOverride(null), null);
  assert.equal(ipcLimits.sanitizeOverride(undefined), null);
  assert.equal(ipcLimits.sanitizeOverride('x'), null); // 旧行为：不是对象就当没有
  assert.equal(ipcLimits.sanitizeOverride([]), null);
  assert.equal(ipcLimits.sanitizeOverride({}), null);
  assert.deepEqual(ipcLimits.sanitizeOverride({ chapterId: 'ch_1', text: '未保存' }), {
    chapterId: 'ch_1',
    text: '未保存'
  });
  // 没带正文（复制本章的 ref）：只留 id，正文由调用方决定读不读盘
  assert.deepEqual(ipcLimits.sanitizeOverride({ chapterFile: '0001-第1章.txt' }), {
    chapterFile: '0001-第1章.txt'
  });
  // id 非字符串 / 超长：丢掉（真 id 只有十几字节，长 id 必然匹配不到）
  assert.equal(ipcLimits.sanitizeOverride({ chapterId: 123 }), null);
  assert.equal(ipcLimits.sanitizeOverride({ chapterId: 'x'.repeat(ipcLimits.MAX_ID_CHARS + 1) }), null);
  // 正文类型不对 → BAD_TEXT；超长 → TEXT_TOO_LARGE（这是这一层存在的意义，不降级）
  assert.throws(() => ipcLimits.sanitizeOverride({ text: 123 }), (err) => err.code === 'BAD_TEXT');
  assert.throws(
    () => ipcLimits.sanitizeOverride({ text: 'x'.repeat(ipcLimits.MAX_TEXT_CHARS + 1) }),
    (err) => err.code === 'TEXT_TOO_LARGE' && err.message.startsWith('当前章正文太长（5,000,001 字')
  );
  // 多余字段不往下传（core 只认这三个）
  assert.deepEqual(ipcLimits.sanitizeOverride({ text: 'abc', evil: 'x' }), { text: 'abc' });
});

test('导出范围：坏形状 / 未知模式降级成全书，越界仍按 exporter 的收紧口径', () => {
  assert.equal(ipcLimits.sanitizeRange(null), null);
  assert.equal(ipcLimits.sanitizeRange(undefined), null);
  assert.equal(ipcLimits.sanitizeRange('range'), null); // 旧行为：非对象 = 全书
  assert.equal(ipcLimits.sanitizeRange([]), null);
  assert.deepEqual(ipcLimits.sanitizeRange({ mode: '不认识的模式' }), {
    mode: 'all', from: null, to: null, volumeId: null
  });
  assert.deepEqual(ipcLimits.sanitizeRange({ mode: 'range', from: '3', to: 4.9 }), {
    mode: 'range', from: 3, to: 4, volumeId: null
  });
  // from/to 不是数字：当没传（和 core/exporter 原来的 toInt 行为一致）
  assert.deepEqual(ipcLimits.sanitizeRange({ mode: 'range', from: 'abc', to: {} }), {
    mode: 'range', from: null, to: null, volumeId: null
  });
  assert.deepEqual(ipcLimits.sanitizeRange({ mode: 'volume', volumeId: 'vol_1' }), {
    mode: 'volume', from: null, to: null, volumeId: 'vol_1'
  });
  // 卷 id 超长 / 非字符串：当没指定（未分卷），不抛错
  assert.equal(ipcLimits.sanitizeRange({ mode: 'volume', volumeId: 'v'.repeat(201) }).volumeId, null);
  assert.equal(ipcLimits.sanitizeRange({ mode: 'volume', volumeId: 42 }).volumeId, null);
  // 和真实 exporter 拼起来：越界收紧到 [1, 总章数]，from > to 时 count = 0
  const meta = { chapters: Array.from({ length: 10 }, (_, i) => ({ id: `ch_${i}`, file: `000${i}.txt` })) };
  const clamped = exporter.resolveExportRange(meta, ipcLimits.sanitizeRange({ mode: 'range', from: -5, to: 999999 }));
  assert.deepEqual([clamped.from, clamped.to, clamped.count], [1, 10, 10]);
  const reversed = exporter.resolveExportRange(meta, ipcLimits.sanitizeRange({ mode: 'range', from: 5, to: 2 }));
  assert.equal(reversed.count, 0);
  // 全书的 normal 路径不受影响
  assert.equal(exporter.resolveExportRange(meta, ipcLimits.sanitizeRange({ mode: 'all' })).count, 10);
});

test('跳章章节列表：超过 2 万条只看前 2 万条，章名限长，坏条目当空', () => {
  // 非数组：沿用原来的 BAD_CHAPTERS（文案不变）
  assert.throws(
    () => ipcLimits.sanitizeChapterList('章节'),
    (err) => err instanceof ipcLimits.IpcLimitError && err.code === 'BAD_CHAPTERS' && err.message === '章节列表格式不对'
  );
  const many = Array.from({ length: ipcLimits.MAX_CHAPTER_ITEMS + 5 }, (_, i) => ({
    id: `ch_${i}`,
    name: `第${i + 1}章`
  }));
  const sliced = ipcLimits.sanitizeChapterList(many);
  assert.equal(sliced.length, ipcLimits.MAX_CHAPTER_ITEMS);
  const result = jumpLib.findMatches(sliced, '第20000章');
  assert.equal(result.total, 1);
  assert.equal(result.matches[0].index, 19999);
  // 第 20001 条之后不在列表里：跳不过去（降级，不报错）
  assert.equal(jumpLib.findMatches(sliced, '第20005章').matches.length, 0);
  // 章名限长：5 万字的名字只留 2000 字，关键词在开头仍能命中
  const long = ipcLimits.sanitizeChapterList([{ id: 'ch_1', name: `关键词${'啊'.repeat(50000)}` }]);
  assert.equal(long[0].name.length, ipcLimits.MAX_CHAPTER_NAME_CHARS);
  assert.equal(jumpLib.findMatches(long, '关键词').total, 1);
  // 坏条目：字符串 / null / 数组 / 数字变 null，带 getter 抛错的对象也不让整次跳章失败
  const evil = {
    get name() {
      throw new Error('boom');
    }
  };
  // 按卷编号跳章要的 number / volumeName 也保留；坏值不落进 core
  assert.deepEqual(
    ipcLimits.sanitizeChapterList([
      { id: 'a', name: '起风', number: 3, volumeName: '卷一 · 归途' },
      { id: 'b', name: '夜雨', number: '2', volumeName: '  ' },
      { id: 'c', name: '远行', number: -1, volumeName: 42 }
    ]),
    [
      { id: 'a', name: '起风', number: 3, volumeName: '卷一 · 归途' },
      { id: 'b', name: '夜雨', number: 2 },
      { id: 'c', name: '远行' }
    ]
  );
  assert.deepEqual(ipcLimits.sanitizeChapterList(['x', null, [], 42, evil, { id: 'ch_ok', name: '正常' }]), [
    null, null, null, null, null, { id: 'ch_ok', name: '正常' }
  ]);
  // id 限长；章号跳转仍按原始下标
  const longId = ipcLimits.sanitizeChapterList([{ id: 'i'.repeat(500), name: '第一章' }]);
  assert.equal(longId[0].id.length, ipcLimits.MAX_ID_CHARS);
});

test('撤销删除的 payload：白名单收口（多余字段丢弃 / 超长夹取 / 可选字段降级）', () => {
  const chapter = {
    id: 'ch-1',
    file: '002-第二章.txt',
    name: '第二章',
    createdAt: '2026-11-10T13:00:00.000Z',
    volumeId: 'vol-1',
    status: 'done',
    note: '这章要改'
  };
  const trashName = '2026-11-10T13-00-00-000Z-002-第二章.txt';

  // 1) 正常通过：只留白名单字段，形状与 storage 的入参一致
  assert.deepEqual(
    ipcLimits.sanitizeRestorePayload({ trashName, index: 2, chapter, autoChapterFile: '003-空章.txt' }),
    { trashName, index: 2, chapter, autoChapterFile: '003-空章.txt' }
  );

  // 2) 白名单：顶层 / chapter 里多出来的键（伪造路径、fileSeq、未知字段）一个都不留，
  //    也不能靠 __proto__ 之类往结果对象上挂料
  const smelly = JSON.parse(
    JSON.stringify({
      trashName,
      index: 1,
      autoChapterFile: null,
      bookPath: 'C:\\别人的书',
      path: 'D:\\我的小说\\001.txt',
      fileSeq: 999,
      chapter: { ...chapter, fileSeq: 9, path: 'D:\\我的小说\\001.txt', extra: { nested: true } }
    })
  );
  const cleaned = ipcLimits.sanitizeRestorePayload(smelly);
  assert.deepEqual(Object.keys(cleaned).sort(), ['autoChapterFile', 'chapter', 'index', 'trashName']);
  assert.deepEqual(Object.keys(cleaned.chapter).sort(), [
    'createdAt', 'file', 'id', 'name', 'note', 'status', 'volumeId'
  ]);
  assert.equal(cleaned.autoChapterFile, null, 'null 的自动补章 = 不撤');

  // 3) 超长 name / note：夹到上限（真正的 40 字 / 200 字语义在 core/chapters.js，这里只保证有界）
  const longName = ipcLimits.sanitizeRestorePayload({
    trashName,
    chapter: { ...chapter, name: '夜'.repeat(ipcLimits.MAX_CHAPTER_NAME_CHARS + 50) }
  });
  assert.equal(longName.chapter.name.length, ipcLimits.MAX_CHAPTER_NAME_CHARS);
  const longNote = ipcLimits.sanitizeRestorePayload({
    trashName,
    chapter: { ...chapter, note: '注'.repeat(ipcLimits.MAX_CHAPTER_NAME_CHARS + 50) }
  });
  assert.equal(longNote.chapter.note.length, ipcLimits.MAX_CHAPTER_NAME_CHARS);

  // 4) 可选字段类型 / 长度不对就丢掉（不把一次正常撤销变成报错）：
  //    createdAt 超长 → 让 storage 用 nowIso；volumeId / status 不是短字符串 → 不挂载
  const degraded = ipcLimits.sanitizeRestorePayload({
    trashName,
    chapter: {
      id: 'ch-1',
      file: '002-第二章.txt',
      name: 42,
      createdAt: 'x'.repeat(200),
      volumeId: { bad: true },
      status: 1,
      note: ['not', 'text']
    }
  });
  assert.deepEqual(degraded.chapter, { id: 'ch-1', file: '002-第二章.txt', name: '' });
  // 空名保持空串（= 未命名），不在这里补「未命名」
  assert.equal(ipcLimits.sanitizeRestorePayload({ trashName, chapter: { ...chapter, name: '   ' } }).chapter.name, '   ');
  // 省略 index / autoChapterFile 时结果里不留键（storage 走自己的默认：追加到末尾 / 不撤补章）
  const minimal = ipcLimits.sanitizeRestorePayload({ trashName, chapter });
  assert.deepEqual(Object.keys(minimal).sort(), ['autoChapterFile', 'chapter', 'trashName']);
  assert.equal(minimal.autoChapterFile, null);
});

test('撤销删除的 payload：坏参数一律 BAD_RESTORE（文件名 / index / 缺字段）', () => {
  const chapter = { id: 'ch-1', file: '002-第二章.txt', name: '第二章' };
  const good = { trashName: '2026-11-10T13-00-00-000Z-002-第二章.txt', index: 1, chapter };
  const badRestore = (payload) =>
    assert.throws(
      () => ipcLimits.sanitizeRestorePayload(payload),
      (err) => err instanceof ipcLimits.IpcLimitError && err.code === 'BAD_RESTORE'
    );

  // 5) trashName：只能是本书 _trash 里的单个 basename + .txt
  for (const trashName of [
    'D:\\code\\书\\_trash\\2026-11-10-002-第二章.txt', // 绝对路径
    '..\\2026-11-10-002-第二章.txt', // 目录穿越
    '_trash/2026-11-10-002-第二章.txt', // 带目录
    '2026-11-10-002-第二章.md', // 不是 txt
    '  ', // 空
    `a\u0000b.txt`, // 控制字符
    `x-${'长'.repeat(ipcLimits.MAX_FILE_NAME_CHARS)}.txt` // 超过文件名上限
  ]) {
    badRestore({ ...good, trashName });
  }
  // 6) chapter.file：只收书文件夹里的单个 txt（绝对路径 / 无 .txt / 控制字符一律拒绝）
  for (const file of ['C:\\书\\002-第二章.txt', '..\\002-第二章.txt', '002-第二章.md', '002-\u0001.txt']) {
    badRestore({ ...good, chapter: { ...chapter, file } });
  }
  // 7) 缺字段：没有 payload / 没有 chapter / 没有 id / id 超长
  badRestore(undefined);
  badRestore({ trashName: good.trashName });
  badRestore({ trashName: good.trashName, chapter: { file: chapter.file } });
  badRestore({ trashName: good.trashName, chapter: { id: 'i'.repeat(ipcLimits.MAX_ID_CHARS + 1), file: chapter.file } });
  // 8) index：非负整数；1.5 / -1 / '1' / 超上限都拒绝（省略 = storage 追加到末尾）
  for (const index of [1.5, -1, '1', Number.NaN, Number.POSITIVE_INFINITY, ipcLimits.MAX_CHAPTER_ITEMS + 1]) {
    badRestore({ ...good, index });
  }
  // 9) autoChapterFile：不合法就拒绝（'' / null 表示不撤，合法）
  badRestore({ ...good, autoChapterFile: '../003-空章.txt' });
  badRestore({ ...good, autoChapterFile: '003-空章.md' });
  assert.equal(ipcLimits.sanitizeRestorePayload({ ...good, autoChapterFile: '' }).autoChapterFile, null);
  // 正常 payload 仍然过
  assert.equal(ipcLimits.sanitizeRestorePayload(good).chapter.file, chapter.file);
});

test('全书查找 / 替换的 options：非对象按默认，坏字段类型拒绝', () => {
  assert.deepEqual(ipcLimits.sanitizeSearchOptions(undefined), { query: '', caseSensitive: false });
  assert.deepEqual(ipcLimits.sanitizeSearchOptions('x'), { query: '', caseSensitive: false });
  assert.deepEqual(ipcLimits.sanitizeSearchOptions({ query: '风', caseSensitive: 1 }), {
    query: '风',
    caseSensitive: true
  });
  assert.throws(() => ipcLimits.sanitizeSearchOptions({ query: {} }), (err) => err.code === 'BAD_QUERY');
  assert.deepEqual(ipcLimits.sanitizeReplaceOptions({ query: '旧', replacement: '新' }), {
    query: '旧',
    replacement: '新',
    caseSensitive: false
  });
  assert.equal(ipcLimits.sanitizeReplaceOptions({ query: '旧' }).replacement, '');
  assert.throws(
    () => ipcLimits.sanitizeReplaceOptions({ query: '旧', replacement: 42 }),
    (err) => err.code === 'BAD_REPLACEMENT'
  );
  assert.throws(
    () => ipcLimits.sanitizeReplaceOptions({ query: 'q'.repeat(ipcLimits.MAX_QUERY_CHARS + 1), replacement: 'x' }),
    (err) => err.code === 'QUERY_TOO_LARGE'
  );
});

test('静态闸门：文本 / 导出 / 查找替换频道都接上了 core/ipc-limits.js', () => {
  assert.match(MAIN_SOURCE, /const ipcLimits = require\('\.\/core\/ipc-limits'\);/);
  // 正文类频道：必须先 assertText（内部含 500 万字上限）
  for (const channel of [
    'text:format',
    'text:proofread',
    'text:sensitive-check',
    'text:tts-chunks',
    'text:find',
    'text:find-all',
    'text:find-next',
    'text:replace'
  ]) {
    assert.ok(bodyOf(channel).includes('assertText(text)'), `${channel} 必须校验正文`);
  }
  // 查找 / 替换词：走 assertQuery / assertReplacement，替换还要估结果大小
  for (const channel of ['text:find', 'text:find-all', 'text:find-next', 'text:replace']) {
    assert.ok(bodyOf(channel).includes('assertQuery('), `${channel} 必须校验查找词`);
  }
  assert.ok(bodyOf('text:replace').includes('assertReplacement('), 'text:replace 必须校验替换词');
  assert.ok(bodyOf('text:replace').includes('assertReplaceOutput('), 'text:replace 必须估替换结果大小');
  // 跳章：不再是裸的 chapters.slice(0, 20000)，统一走 sanitizeChapterList
  assert.ok(bodyOf('jump:match').includes('sanitizeChapterList('), 'jump:match 必须清洗章节列表');
  assert.equal(/chapters\.slice\(0,\s*20000\)/.test(MAIN_SOURCE), false, 'main.js 里不该再有裸截断');
  // 写盘通道（审计 E6）：chapter:save 是全仓唯一漏掉正文校验的写盘入口，2026-11-05 补上。
  // null / undefined 沿用旧行为 = 空章；真实正文走 500 万字上限，落盘必须用校验后的正文。
  const saveBody = bodyOf('chapter:save');
  assert.ok(saveBody.includes('assertText('), 'chapter:save 必须校验正文（E6）');
  assert.match(saveBody, /assertText\(text == null \? '' : text\)/, 'chapter:save 把 null / undefined 当空章，其余照常校验');
  assert.ok(
    saveBody.includes('storage.saveChapterText(bookPath, chapter.file, body'),
    'chapter:save 落盘必须用校验后的正文（不能再用未校验的 text）'
  );
  // 全书查找 / 替换：options 走 sanitize*Options
  assert.ok(bodyOf('book:search').includes('sanitizeSearchOptions('), 'book:search 必须清洗 options');
  assert.ok(bodyOf('book:replace').includes('sanitizeReplaceOptions('), 'book:replace 必须清洗 options');
  // 撤销删除（1.5.0 P0-3 / 审计 E3 + O-8）：payload 必须过 sanitizeRestorePayload，
  // 而且交给 storage 的必须是清洗后的值（原始 payload 一个字段都不能再往下递）
  const restoreBody = bodyOf('chapter:restore-deleted');
  assert.ok(restoreBody.includes('sanitizeRestorePayload('), 'chapter:restore-deleted 必须清洗 payload');
  assert.match(
    restoreBody,
    /restoreDeletedChapterFromTrash\(bookPath, ipcLimits\.sanitizeRestorePayload\(payload\)\)/,
    'chapter:restore-deleted 交给 storage 的必须是清洗后的 payload'
  );
  assert.equal(
    /restoreDeletedChapterFromTrash\(bookPath, payload\)/.test(MAIN_SOURCE),
    false,
    'main.js 里不该再有「原始 payload 直接下传」的写法'
  );
  // 正文全文搜索（审计 E7）：主进程 search:content 的查找词也要过 1 万字上限（以前只有这一条没走）
  assert.ok(bodyOf('search:content').includes('assertQuery('), 'search:content 必须校验查找词');
  assert.ok(
    bodyOf('search:content').includes('query: safeQuery'),
    'search:content 必须把校验后的查找词交给索引（不能再用原始 query）'
  );
  // 导出 / 复制 / 整本检查：override 走 sanitizeOverride，导出 range 走 sanitizeRange
  for (const channel of ['book:copy', 'chapter:copy-platform', 'book:proofread', 'book:sensitive-check']) {
    assert.ok(bodyOf(channel).includes('sanitizeOverride('), `${channel} 必须清洗 override / ref`);
  }
  assert.ok(bodyOf('book:export-plan').includes('sanitizeRange('), 'book:export-plan 必须清洗 range');
  assert.ok(
    /const safeRange = ipcLimits\.sanitizeRange\(range\);/.test(bodyOf('book:export-plan')),
    'book:export-plan 的 range 必须过 sanitizeRange'
  );
  const prepare = MAIN_SOURCE.slice(
    MAIN_SOURCE.indexOf('async function prepareExport('),
    MAIN_SOURCE.indexOf('function archiveExportResult(')
  );
  assert.ok(prepare.includes('sanitizeOverride(') && prepare.includes('sanitizeRange('), '三个导出共用 prepareExport 的清洗');
  assert.ok(/range:\s*safeRange/.test(prepare), 'prepareExport 要把清洗后的 range 交给调用方');
});
