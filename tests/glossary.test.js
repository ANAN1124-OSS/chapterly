const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const glossary = require('../core/glossary');
const { WORDLIST_MAX } = require('../core/config');

const tmpCleanup = require('./tmp-cleanup');

async function mkTmp() {
  return tmpCleanup.track(await fs.mkdtemp(path.join(os.tmpdir(), 'cw-glossary-')));
}

test('校对词表：每行一个词，可选「错词 → 建议」，三种箭头都认', () => {
  const parsed = glossary.parseGlossary(
    '\uFEFF做为 => 作为\r\n在再 -> 再说\r\n的地得 → 的\r\n禁词\r\n# 注释行\r\n\r\n  做为 => 当作  \r\n'
  );
  assert.deepEqual(parsed.entries, [
    { term: '做为', suggestion: '作为' },
    { term: '在再', suggestion: '再说' },
    { term: '的地得', suggestion: '的' },
    { term: '禁词', suggestion: '' }
  ]);
  assert.equal(parsed.stats.suggestions, 3);
  assert.equal(parsed.stats.comments, 1);
  assert.equal(parsed.stats.duplicates, 1, '同样的词第二次出现只留第一次（建议也保留第一次的）');
  assert.ok(parsed.stats.emptyLines >= 2);
  // 词中间的空格保留（短语也能当一个词）；箭头两侧空格会被去掉
  assert.deepEqual(glossary.parseGlossary('坏 人\n  =>  ').entries, [{ term: '坏 人', suggestion: '' }]);
  assert.deepEqual(glossary.parseGlossary(' \n\t\n\u3000').entries, []);
  assert.deepEqual(glossary.parseGlossary(null).entries, []);
});

test('校对词表：坏行与超长行跳过，5000 条上限标 truncated', () => {
  const lines = ['   => 只有建议没有词  ', '短 => ' + '建'.repeat(101), '长'.repeat(101)];
  for (let i = 0; i < glossary.MAX_ENTRIES + 3; i += 1) lines.push(`词${i}`);
  const parsed = glossary.parseGlossary(lines.join('\n'));
  assert.equal(parsed.stats.invalid, 1);
  assert.equal(parsed.stats.tooLong, 2);
  assert.equal(parsed.entries.length, glossary.MAX_ENTRIES);
  assert.equal(parsed.entries[0].term, '词0');
  assert.equal(parsed.stats.truncated, true);
});

test('校对词表：sanitizeEntries 去空 / 去重 / 限长 / 限量，字符串与对象都收', () => {
  const cleaned = glossary.sanitizeEntries([
    ' 做为 ',
    { term: '禁词', suggestion: '  ' },
    { term: '做为', suggestion: '作为' },
    { term: '', suggestion: 'x' },
    { term: '长'.repeat(101), suggestion: '' },
    { term: '建议太长', suggestion: '建'.repeat(101) },
    { term: 123 },
    null,
    42
  ]);
  assert.deepEqual(cleaned, [
    { term: '做为', suggestion: '' },
    { term: '禁词', suggestion: '' },
    { term: '建议太长', suggestion: '' }
  ]);
  assert.deepEqual(glossary.sanitizeEntries('不是数组'), []);
});

test('校对词表：findHits 字面匹配、按位置排序，同一处只报最长的词', () => {
  const hits = glossary.findHits('他说做为见证人，做为观众。', [
    { term: '做为', suggestion: '作为' },
    { term: '做', suggestion: '' },
    { term: '观众', suggestion: '' }
  ]);
  assert.equal(hits.entryCount, 3);
  assert.equal(hits.truncated, false);
  assert.deepEqual(
    hits.hits.map((hit) => [hit.term, hit.index, hit.length, hit.suggestion]),
    [
      ['做为', 2, 2, '作为'],
      ['做为', 8, 2, '作为'],
      ['观众', 10, 2, '']
    ],
    '「做」和「做为」重叠时只留长的；结果按位置排序'
  );
});

test('校对词表：字面匹配区分大小写、不做正则；CRLF / BOM 归一后位置可直接选中', () => {
  const hits = glossary.findHits('\uFEFF第一行 teh 和 Teh。\r\n第二行 teh。\r\n', [
    { term: 'teh', suggestion: 'the' },
    { term: 'a.c', suggestion: '' }
  ]);
  assert.deepEqual(
    hits.hits.map((hit) => hit.index),
    [4, 19]
  );
  const text = '\uFEFF第一行 teh 和 Teh。\r\n第二行 teh。\r\n';
  assert.equal(text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').slice(4, 7), 'teh');
  assert.deepEqual(glossary.findHits('abc', [{ term: 'a.c' }]).hits, []);
});

test('校对词表：没有任何可用词条时安全返回空结果', () => {
  assert.deepEqual(glossary.findHits('正文', []), { hits: [], truncated: false, entryCount: 0 });
  assert.deepEqual(glossary.findHits('正文', null), { hits: [], truncated: false, entryCount: 0 });
  assert.deepEqual(glossary.findHits(null, [{ term: '正' }]), {
    hits: [],
    truncated: false,
    entryCount: 1
  });
});

test('校对词表：解码 UTF-8（含 BOM）/ UTF-16LE / GBK，空 / 二进制 / 坏编码明确拒绝', () => {
  const utf8 = glossary.decodeGlossaryBuffer(Buffer.from('\uFEFF做为 => 作为\n禁词', 'utf8'));
  assert.equal(utf8.ok, true);
  assert.deepEqual(utf8.entries, [
    { term: '做为', suggestion: '作为' },
    { term: '禁词', suggestion: '' }
  ]);

  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('做为 => 作为\r\n禁词', 'utf16le')]);
  assert.deepEqual(glossary.decodeGlossaryBuffer(utf16).entries, utf8.entries);

  // 「做为 => 作为」的 GBK 字节
  const gbk = glossary.decodeGlossaryBuffer(
    Buffer.from([0xd7, 0xf6, 0xce, 0xaa, 0x20, 0x3d, 0x3e, 0x20, 0xd7, 0xf7, 0xce, 0xaa])
  );
  assert.equal(gbk.ok, true);
  assert.deepEqual(gbk.entries, [{ term: '做为', suggestion: '作为' }]);

  assert.equal(glossary.decodeGlossaryBuffer(Buffer.alloc(0)).code, 'GLOSSARY_EMPTY');
  assert.equal(glossary.decodeGlossaryBuffer(Buffer.from(' \r\n# 只有注释\n', 'utf8')).code, 'GLOSSARY_EMPTY');
  const binary = glossary.decodeGlossaryBuffer(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]));
  assert.equal(binary.code, 'GLOSSARY_BAD_ENCODING');
  const broken = glossary.decodeGlossaryBuffer(Buffer.from([0xff, 0xff, 0x0a, 0x41]));
  assert.equal(broken.code, 'GLOSSARY_BAD_ENCODING');
});

test('校对词表：readGlossaryFile 未设置 / 不存在 / 是目录 / 正常文件 都给结构化结果', async () => {
  const notConfigured = await glossary.readGlossaryFile('');
  assert.equal(notConfigured.ok, false);
  assert.equal(notConfigured.code, 'GLOSSARY_NOT_CONFIGURED');
  assert.equal(notConfigured.configured, false);
  assert.equal(notConfigured.count, 0);

  const dir = await mkTmp();
  const missing = await glossary.readGlossaryFile(path.join(dir, '没有这个.txt'));
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'GLOSSARY_MISSING');
  assert.equal(missing.configured, true);
  assert.ok(missing.message.includes('不存在'));

  const asDir = await glossary.readGlossaryFile(dir);
  assert.equal(asDir.ok, false);
  assert.equal(asDir.code, 'GLOSSARY_NOT_FILE');

  const file = path.join(dir, '校对词表.txt');
  await fs.writeFile(file, '做为 => 作为\r\n禁词\r\n', 'utf8');
  const ok = await glossary.readGlossaryFile(file);
  assert.equal(ok.ok, true);
  assert.equal(ok.count, undefined, '原始结果用 entries 携带内容');
  assert.equal(ok.entries.length, 2);
  assert.equal(ok.name, '校对词表.txt');
  assert.equal(ok.stats.suggestions, 1);
});

test('校对词表：readGlossaryFile 拒绝超过 4MB 与坏编码，提示能看懂', async () => {
  const dir = await mkTmp();
  const big = path.join(dir, '大词表.txt');
  await fs.writeFile(big, Buffer.alloc(glossary.MAX_FILE_BYTES + 1, 0x41));
  const tooBig = await glossary.readGlossaryFile(big);
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.code, 'GLOSSARY_TOO_BIG');
  assert.ok(tooBig.message.includes('4MB'));

  const bad = path.join(dir, '坏词表.txt');
  await fs.writeFile(bad, Buffer.from([0xff, 0xff, 0x0a, 0x41]));
  const broken = await glossary.readGlossaryFile(bad);
  assert.equal(broken.ok, false);
  assert.equal(broken.code, 'GLOSSARY_BAD_ENCODING');
  assert.ok(broken.message.includes('UTF-8'));
});

test('校对词表：publicGlossaryInfo 只给数量与状态，不把词表正文带到渲染层', async () => {
  const dir = await mkTmp();
  const file = path.join(dir, '词表.txt');
  await fs.writeFile(file, '做为 => 作为\n禁词\n', 'utf8');
  const list = await glossary.readGlossaryFile(file);
  const info = glossary.publicGlossaryInfo(list);
  assert.equal(info.ok, true);
  assert.equal(info.count, 2);
  assert.equal(info.entries, undefined);
  assert.equal(info.stats.suggestions, 1);

  const notConfigured = glossary.publicGlossaryInfo(await glossary.readGlossaryFile(''));
  assert.equal(notConfigured.count, 0);
  const fallback = glossary.publicGlossaryInfo(null);
  assert.equal(fallback.ok, false);
  assert.equal(fallback.count, 0);
});

test('校对词表：多份词表合并按词去重，总数与每份数量分开统计', async () => {
  const dir = await mkTmp();
  const first = path.join(dir, '词表甲.txt');
  const second = path.join(dir, '词表乙.txt');
  await fs.writeFile(first, '做为 => 作为\n禁词\n共用\n', 'utf8');
  await fs.writeFile(second, '共用 => 别处的建议\n乙词 => 乙改\n做为 => 又一次\n', 'utf8');

  const merged = await glossary.readGlossaryFiles([first, second]);
  assert.equal(merged.ok, true);
  assert.equal(merged.total, 4);
  assert.equal(merged.entries.length, 4);
  assert.deepEqual(merged.entries.map((entry) => entry.term), ['做为', '禁词', '共用', '乙词']);
  // 同一个词只算一次，先读到的那份说了算（建议不被后面的覆盖）
  assert.equal(merged.entries[2].suggestion, '');
  assert.equal(merged.entries[0].suggestion, '作为');
  // 每份 count 是这一份自己的条数：3 + 3 = 6，去重后总数只有 4
  assert.equal(merged.lists.length, 2);
  assert.deepEqual(merged.lists.map((list) => list.ok), [true, true]);
  assert.deepEqual(merged.lists.map((list) => list.count), [3, 3]);
  assert.deepEqual(merged.lists.map((list) => list.truncated), [false, false]);

  // 只传一个字符串也当一份（配置为空数组时可直接传旧字段）
  const single = await glossary.readGlossaryFiles(first);
  assert.equal(single.ok, true);
  assert.equal(single.total, 3);
});

test('校对词表：多份里有一份坏 / 不存在时，其它份照常可用且不抛错', async () => {
  const dir = await mkTmp();
  const good = path.join(dir, '好词表.txt');
  await fs.writeFile(good, '做为 => 作为\n禁词\n', 'utf8');
  const missing = path.join(dir, '没有这个.txt');
  const broken = path.join(dir, '坏编码.txt');
  await fs.writeFile(broken, Buffer.from([0xff, 0xff, 0x0a, 0x41]));

  const merged = await glossary.readGlossaryFiles([missing, good, broken]);
  assert.equal(merged.ok, true);
  assert.equal(merged.total, 2);
  assert.deepEqual(merged.entries.map((entry) => entry.term), ['做为', '禁词']);
  assert.deepEqual(merged.lists.map((list) => list.ok), [false, true, false]);
  assert.deepEqual(merged.lists.map((list) => list.count), [0, 2, 0]);
  assert.ok(merged.lists[0].error.length > 0, '坏掉的那份要给出能看懂的原因');
  assert.ok(merged.lists[2].error.length > 0);
  assert.equal(merged.lists[1].error, '');

  const none = await glossary.readGlossaryFiles([missing, broken]);
  assert.equal(none.ok, false);
  assert.equal(none.total, 0);
  assert.deepEqual(none.entries, []);
  assert.deepEqual(none.lists.map((list) => list.ok), [false, false]);

  const empty = await glossary.readGlossaryFiles([]);
  assert.equal(empty.ok, false);
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.lists, []);
  const junk = await glossary.readGlossaryFiles(null);
  assert.equal(junk.ok, false);
  assert.deepEqual(junk.lists, []);
});

test('校对词表：多份合并后条目不超过 MAX_ENTRIES，截断语义与单文件一致', async () => {
  const dir = await mkTmp();
  const first = path.join(dir, '词表甲.txt');
  const second = path.join(dir, '词表乙.txt');
  const many = Array.from({ length: glossary.MAX_ENTRIES - 1 }, (_, index) => '甲' + index);
  await fs.writeFile(first, many.join('\n') + '\n', 'utf8');
  await fs.writeFile(second, '乙新一\n乙新二\n', 'utf8');

  const merged = await glossary.readGlossaryFiles([first, second]);
  assert.equal(merged.entries.length, glossary.MAX_ENTRIES);
  assert.equal(merged.total, glossary.MAX_ENTRIES);
  assert.equal(merged.lists[0].count, glossary.MAX_ENTRIES - 1);
  assert.equal(merged.lists[0].truncated, false);
  assert.equal(merged.lists[1].count, 2);
  assert.equal(merged.lists[1].truncated, true, '第二份只进来 1 条，剩下 1 条被总数上限截断');
  assert.equal(merged.entries[glossary.MAX_ENTRIES - 1].term, '乙新一');
});

test('校对词表：多份词表公开信息只给数量与状态，不含路径与词条正文', async () => {
  const dir = await mkTmp();
  const first = path.join(dir, '秘密词表甲.txt');
  const second = path.join(dir, '秘密词表乙.txt');
  const missing = path.join(dir, '消失了-ZZZ.txt');
  await fs.writeFile(first, '做为 => 作为\n禁词\n', 'utf8');
  await fs.writeFile(second, '另一个\n', 'utf8');

  const bundle = await glossary.readGlossaryFiles([first, second, missing]);
  const info = glossary.publicGlossaryFilesInfo(bundle);
  assert.equal(info.ok, true);
  assert.equal(info.total, 3);
  assert.equal(info.entries, undefined, '公开信息绝不带合并后的词条正文');
  assert.equal(info.lists.length, 3);
  assert.deepEqual(info.lists.map((list) => list.count), [2, 1, 0]);
  assert.equal(info.lists[2].ok, false);
  assert.ok(info.lists[2].error.length > 0);
  assert.equal(info.lists[0].entries, undefined);
  assert.deepEqual(Object.keys(info.lists[2]).sort(), ['count', 'error', 'ok', 'truncated']);

  const text = JSON.stringify(info);
  for (const word of ['做为', '禁词', '另一个', '秘密词表', '消失了-ZZZ', path.basename(dir)]) {
    assert.equal(text.includes(word), false, `公开信息里不该出现「${word}」`);
  }

  const fallback = glossary.publicGlossaryFilesInfo(null);
  assert.equal(fallback.ok, false);
  assert.equal(fallback.total, 0);
  assert.deepEqual(fallback.lists, []);
});

// ---------- 1.7.2 D2（V60/V63）：词表纯逻辑下沉 core 后的纯函数锚点 ----------

test('校对词表：proofreadWordlistPaths 对坏配置兜底——非数组 / 非字符串 / 空串都不当成词表（V60）', () => {
  assert.deepEqual(glossary.proofreadWordlistPaths(null), []);
  assert.deepEqual(glossary.proofreadWordlistPaths(undefined), []);
  assert.deepEqual(glossary.proofreadWordlistPaths({}), []);
  assert.deepEqual(glossary.proofreadWordlistPaths({ proofreadWordlists: '不是数组' }), []);
  assert.deepEqual(glossary.proofreadWordlistPaths({ proofreadWordlists: [] }), []);
  assert.deepEqual(
    glossary.proofreadWordlistPaths({ proofreadWordlists: ['', '   ', 42, null, {}, '甲.txt', '  '] }),
    ['甲.txt'],
    '多份只留非空字符串，且保持配置里的原样（不 trim 返回值，改前就如此）'
  );
  assert.deepEqual(glossary.proofreadWordlistPaths({ proofreadWordsPath: 42 }), []);
  assert.deepEqual(glossary.proofreadWordlistPaths({ proofreadWordsPath: '   ' }), []);
  assert.deepEqual(glossary.proofreadWordlistPaths({ proofreadWordsPath: ' 旧单份.txt ' }), ['旧单份.txt'], '单份旧字段 trim 后使用');
  assert.deepEqual(
    glossary.proofreadWordlistPaths({ proofreadWordlists: ['', 42, '甲.txt'], proofreadWordsPath: '旧单份.txt' }),
    ['甲.txt'],
    '多份里只要有一份可用就不回落单份'
  );
  assert.deepEqual(
    glossary.proofreadWordlistPaths({ proofreadWordlists: ['', '  '], proofreadWordsPath: '旧单份.txt' }),
    ['旧单份.txt'],
    '多份全不可用时回落单份（改前行为）'
  );
});

test('校对词表：proofreadWordlistPaths 多份至多 WORDLIST_MAX 份，hasProofreadWordlists 只认非空数组（V60）', () => {
  assert.equal(WORDLIST_MAX, 8, '上限 8 份（core/config.js 唯一定义）');
  const many = Array.from({ length: WORDLIST_MAX + 3 }, (_, index) => `词表${index}.txt`);
  const got = glossary.proofreadWordlistPaths({ proofreadWordlists: many });
  assert.equal(got.length, WORDLIST_MAX, '读取侧再兜一遍上限，手改配置也读不出第 9 份');
  assert.deepEqual(got, many.slice(0, WORDLIST_MAX), '取配置里排在前面的几份，顺序不变');

  assert.equal(glossary.hasProofreadWordlists({ proofreadWordlists: ['甲.txt'] }), true);
  assert.equal(glossary.hasProofreadWordlists({ proofreadWordlists: [] }), false);
  assert.equal(glossary.hasProofreadWordlists({ proofreadWordlists: '甲.txt' }), false, '非数组不算多份');
  assert.equal(glossary.hasProofreadWordlists({ proofreadWordsPath: '甲.txt' }), false, '旧单份字段不算多份');
  assert.equal(glossary.hasProofreadWordlists(null), false);
});

test('校对词表：wordlistPathsForRequest 子集过滤只认合法索引，越界 / 重复 / 非整数都丢掉（V60）', () => {
  const paths = ['甲.txt', '乙.txt', '丙.txt'];
  assert.deepEqual(
    glossary.wordlistPathsForRequest(paths, { enabledLists: [2, 2, 9, -1, 1.5] }),
    ['丙.txt'],
    '2 重复只算一次；9 / -1 越界、1.5 非整数都丢掉'
  );
  assert.deepEqual(glossary.wordlistPathsForRequest(paths, { enabledLists: [0, 1] }), ['甲.txt', '乙.txt']);
  assert.deepEqual(
    glossary.wordlistPathsForRequest(paths, { enabledLists: [2, 0, 2] }),
    ['甲.txt', '丙.txt'],
    '结果按原路径顺序，不按 enabledLists 顺序'
  );
  assert.deepEqual(glossary.wordlistPathsForRequest(paths, { enabledLists: [] }), paths, '空选 = 全开（改前行为）');
});

test('校对词表：wordlistPathsForRequest 缺省与坏值全开，一份都没选中也全开（V60）', () => {
  const paths = ['甲.txt', '乙.txt', '丙.txt'];
  for (const options of [
    undefined,
    null,
    {},
    { enabledLists: null },
    { enabledLists: '1' },
    { enabledLists: [9, -1, 1.5] },
    { enabledLists: [] }
  ]) {
    assert.deepEqual(glossary.wordlistPathsForRequest(paths, options), paths, '坏值 / 缺省都当全开：' + JSON.stringify(options));
  }
});

test('校对词表：proofreadWordListInfo 多份整形——lists 与路径同序、total/count/name 对齐且不带路径正文（V60/V63）', () => {
  const bundle = {
    ok: true,
    total: 3,
    entries: [
      { term: '隐藏词一', suggestion: '' },
      { term: '隐藏词二', suggestion: '改法' },
      { term: '隐藏词三', suggestion: '' }
    ],
    lists: [
      {
        ok: true,
        count: 2,
        error: '',
        truncated: false,
        entries: [
          { term: '隐藏词一', suggestion: '' },
          { term: '隐藏词二', suggestion: '改法' }
        ]
      },
      { ok: false, count: 0, error: '词表文件不存在（可能被移动或删除了，请重新选择）', truncated: false }
    ]
  };
  const paths = ['C:\\秘密目录\\词表甲.txt', 'C:\\秘密目录\\词表乙.txt'];
  const info = glossary.proofreadWordListInfo(bundle, paths);
  assert.equal(info.ok, true);
  assert.equal(info.total, 3, 'total 是合并后的词条数');
  assert.equal(info.count, 3, '多份时 count 与 total 同口径（旧字段兼容）');
  assert.equal(info.name, '2 份词表');
  assert.equal(info.lists.length, 2);
  assert.deepEqual(info.lists.map((list) => list.ok), [true, false], 'lists 与配置里的路径同序、同数量');
  assert.deepEqual(info.lists.map((list) => list.count), [2, 0]);
  assert.deepEqual(info.lists.map((list) => list.truncated), [false, false]);
  assert.ok(info.lists[1].error.includes('不存在'));
  assert.equal(info.lists[0].entries, undefined, '公开信息绝不带词条正文');
  assert.equal(info.path, undefined, '公开信息绝不带路径');
  assert.equal(info.entries, undefined);
  const text = JSON.stringify(info);
  for (const word of ['隐藏词', '词表甲', '词表乙', '秘密目录']) {
    assert.equal(text.includes(word), false, `公开信息里不该出现「${word}」`);
  }
});

test('校对词表：proofreadWordListInfo 单份补齐旧字段 ok/count/error/truncated/name，坏份带 message（V60/V63）', () => {
  const good = glossary.proofreadWordListInfo(
    {
      ok: true,
      total: 3,
      entries: [{ term: '甲' }, { term: '乙' }, { term: '丙' }],
      lists: [{ ok: true, count: 3, error: '', truncated: true }]
    },
    ['C:\\秘密\\好的词表.txt']
  );
  assert.equal(good.ok, true);
  assert.equal(good.count, 3);
  assert.equal(good.total, 3);
  assert.equal(good.name, '好的词表.txt', '单份用文件名，不带目录');
  assert.equal(good.error, '');
  assert.equal(good.truncated, true);
  assert.equal(good.path, undefined);
  assert.equal(good.message, undefined, '可用词表不补 message');
  assert.equal(JSON.stringify(good).includes('秘密'), false);

  const badError = '词表文件不存在（可能被移动或删除了，请重新选择）';
  const bad = glossary.proofreadWordListInfo(
    { ok: false, total: 0, entries: [], lists: [{ ok: false, count: 0, error: badError, truncated: false }] },
    ['C:\\坏词表.txt']
  );
  assert.equal(bad.ok, false, '单份以这一份的 ok 为准');
  assert.equal(bad.count, 0);
  assert.equal(bad.error, badError);
  assert.equal(bad.truncated, false);
  assert.equal(bad.name, '坏词表.txt');
  assert.equal(bad.message, badError, '坏份补 message 给旧界面显示');

  const empty = glossary.proofreadWordListInfo(null, ['C:\\空.txt']);
  assert.equal(empty.ok, false);
  assert.equal(empty.count, 0);
  assert.equal(empty.error, '');
  assert.equal(empty.message, '校对词表读取失败', '完全没有 bundle 时也补齐旧字段，不抛错');
});
