const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sensitive = require('../core/sensitive');
const chapters = require('../core/chapters');

const tmpCleanup = require('./tmp-cleanup');

async function mkTmp() {
  return tmpCleanup.track(await fs.mkdtemp(path.join(os.tmpdir(), 'cw-sensitive-')));
}

test('敏感词：parseWordList 每行一个词，去空白 / 空行 / 重复，超长行跳过', () => {
  const parsed = sensitive.parseWordList(
    '\uFEFF色情\r\n暴力\r\n\r\n  色情  \r\n\u3000敏感\u3000\r\n' + '长'.repeat(101) + '\r\n'
  );
  assert.deepEqual(parsed.words, ['色情', '暴力', '敏感']);
  assert.equal(parsed.stats.duplicates, 1);
  assert.equal(parsed.stats.tooLong, 1);
  assert.equal(parsed.stats.truncated, false);
  assert.ok(parsed.stats.emptyLines >= 2);
  // 词中间的空格保留（短语也能当一个词）
  assert.deepEqual(sensitive.parseWordList('fuck you\n坏 人').words, ['fuck you', '坏 人']);
  // 全空
  assert.deepEqual(sensitive.parseWordList(' \n\t\n\u3000').words, []);
  assert.deepEqual(sensitive.parseWordList(null).words, []);
  // 审计修复 #49（E24）：与校对词表同一口径 —— # 开头是注释，不会变成词「#」
  const commented = sensitive.parseWordList('# 说明一行\n色情\n  # 缩进注释\n暴力\n');
  assert.deepEqual(commented.words, ['色情', '暴力']);
  assert.equal(commented.stats.comments, 2);
  assert.equal(sensitive.parseWordList('# 只有注释\n').words.length, 0);
});

test('敏感词：词表最多取前 5000 个词，超出标 truncated', () => {
  const lines = [];
  for (let i = 0; i < sensitive.MAX_WORDS + 3; i += 1) lines.push(`词${i}`);
  const parsed = sensitive.parseWordList(lines.join('\n'));
  assert.equal(parsed.words.length, sensitive.MAX_WORDS);
  assert.equal(parsed.words[0], '词0');
  assert.equal(parsed.stats.truncated, true);
});

test('敏感词：词表解码 UTF-8（含 BOM）/ UTF-16LE / GBK，空与二进制明确拒绝', () => {
  const utf8 = sensitive.decodeWordListBuffer(Buffer.from('\uFEFF色情\n暴力', 'utf8'));
  assert.equal(utf8.ok, true);
  assert.deepEqual(utf8.words, ['色情', '暴力']);

  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('色情\r\n暴力', 'utf16le')]);
  const fromUtf16 = sensitive.decodeWordListBuffer(utf16);
  assert.equal(fromUtf16.ok, true);
  assert.deepEqual(fromUtf16.words, ['色情', '暴力']);

  // 「色情」的 GBK 字节：C9 AB C7 E9
  const gbk = sensitive.decodeWordListBuffer(Buffer.from([0xc9, 0xab, 0xc7, 0xe9, 0x0a, 0xb1, 0xa9, 0xc1, 0xa6]));
  assert.equal(gbk.ok, true);
  assert.deepEqual(gbk.words, ['色情', '暴力']);

  assert.equal(sensitive.decodeWordListBuffer(Buffer.alloc(0)).code, 'WORD_LIST_EMPTY');
  assert.equal(sensitive.decodeWordListBuffer(Buffer.from(' \r\n\t', 'utf8')).code, 'WORD_LIST_EMPTY');
  const binary = sensitive.decodeWordListBuffer(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x01]));
  assert.equal(binary.ok, false);
  assert.equal(binary.code, 'WORD_LIST_BAD_ENCODING');
  // 坏字节解不出中文（U+FFFD）
  const broken = sensitive.decodeWordListBuffer(Buffer.from([0xff, 0xff, 0x0a, 0x41]));
  assert.equal(broken.ok, false);
  assert.equal(broken.code, 'WORD_LIST_BAD_ENCODING');
  // 审计修复 #49（E24）：原文里合法的 U+FFFD 不能再被当成坏编码
  const literal = sensitive.decodeWordListBuffer(Buffer.from('色情\n替换\uFFFD词', 'utf8'));
  assert.equal(literal.ok, true);
  assert.deepEqual(literal.words, ['色情', '替换\uFFFD词']);
  // 无 BOM 的 UTF-16 含 NUL：仍拒绝，但提示要说明可能是 UTF-16（不再武断说「二进制」）
  const noBomUtf16 = sensitive.decodeWordListBuffer(Buffer.from('色情 word', 'utf16le'));
  assert.equal(noBomUtf16.ok, false);
  assert.equal(noBomUtf16.code, 'WORD_LIST_BAD_ENCODING');
  assert.match(noBomUtf16.message, /无 BOM 的 UTF-16/);
});

test('敏感词：readWordListFile 未设置 / 不存在 / 是目录 / 正常文件 都给结构化结果', async () => {
  const notConfigured = await sensitive.readWordListFile('');
  assert.equal(notConfigured.ok, false);
  assert.equal(notConfigured.code, 'WORD_LIST_NOT_CONFIGURED');
  assert.equal(notConfigured.configured, false);

  const dir = await mkTmp();
  const missing = await sensitive.readWordListFile(path.join(dir, '没有这个.txt'));
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'WORD_LIST_MISSING');
  assert.equal(missing.configured, true);
  assert.match(missing.message, /不存在/);

  const asDir = await sensitive.readWordListFile(dir);
  assert.equal(asDir.ok, false);
  assert.equal(asDir.code, 'WORD_LIST_NOT_FILE');

  const file = path.join(dir, '词表.txt');
  await fs.writeFile(file, '色情\r\n暴力\r\n', 'utf8');
  const loaded = await sensitive.readWordListFile(file);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.name, '词表.txt');
  assert.equal(loaded.count, undefined, 'words 由调用方自己数，readWordListFile 不返回 count');
  assert.deepEqual(loaded.words, ['色情', '暴力']);
  assert.equal(loaded.stats.duplicates, 0);
});

test('敏感词：readWordListFile 超过 4MB 拒绝，坏编码给出明确提示', async () => {
  const dir = await mkTmp();
  const big = path.join(dir, '大词表.txt');
  await fs.writeFile(big, Buffer.alloc(sensitive.MAX_FILE_BYTES + 1, 0x41));
  const bigResult = await sensitive.readWordListFile(big);
  assert.equal(bigResult.ok, false);
  assert.equal(bigResult.code, 'WORD_LIST_TOO_BIG');

  const binary = path.join(dir, '伪装.txt');
  await fs.writeFile(binary, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]));
  const bad = await sensitive.readWordListFile(binary);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'WORD_LIST_BAD_ENCODING');
  assert.match(bad.message, /UTF-8/);
});

test('敏感词：publicWordListInfo 只给数量，不把词表内容带到渲染层', async () => {
  const dir = await mkTmp();
  const file = path.join(dir, '词表.txt');
  await fs.writeFile(file, '色情\n暴力\n敏感\n', 'utf8');
  const loaded = await sensitive.readWordListFile(file);
  const info = sensitive.publicWordListInfo(loaded);
  assert.equal(info.ok, true);
  assert.equal(info.count, 3);
  assert.equal(info.words, undefined);
  assert.equal(info.name, '词表.txt');
  // 失败结果也带上 count 0，界面不用再判空
  const badInfo = sensitive.publicWordListInfo(await sensitive.readWordListFile(''));
  assert.equal(badInfo.count, 0);
  assert.equal(badInfo.code, 'WORD_LIST_NOT_CONFIGURED');
  assert.equal(sensitive.publicWordListInfo(null).count, 0);
});

test('敏感词：scanText 找出全部命中，行号列号与上下文可直接定位', () => {
  const text = '第一行没有。\r\n第二行有色情和暴力。\r\n第三行又见色情。';
  const result = sensitive.scanText(text, ['色情', '暴力']);
  assert.equal(result.total, 3);
  assert.equal(result.wordCount, 2);
  assert.equal(result.wordHitCount, 2);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.byWord, [
    { word: '色情', count: 2 },
    { word: '暴力', count: 1 }
  ]);
  const first = result.issues[0];
  assert.equal(first.word, '色情');
  assert.equal(first.line, 2);
  assert.equal(first.column, 5);
  // index 是 CRLF 归一后的位置，直接切片能切到命中的词
  const normalized = text.replace(/\r\n/g, '\n');
  assert.equal(normalized.slice(first.index, first.index + first.length), '色情');
  // 上下文半径 18 字：会把上一行结尾也带上（换行压成空格），和查找 / 校对同一口径
  assert.equal(first.snippet.before, '第一行没有。 第二行有');
  assert.equal(first.snippet.match, '色情');
  assert.equal(first.snippet.after, '和暴力。 第三行又见色情。');
  assert.equal(result.issues[1].line, 2);
  assert.equal(result.issues[2].line, 3);
  // BOM 也一起去掉，位置和编辑区一致
  const withBom = sensitive.scanText('\uFEFF色情', ['色情']);
  assert.equal(withBom.issues[0].index, 0);
});

test('敏感词：同一处重叠时只报最长的词，互不重叠的照常各报一条', () => {
  const longest = sensitive.scanText('这是色情小说。', ['色情', '色情小说']);
  assert.equal(longest.total, 1);
  assert.equal(longest.issues[0].word, '色情小说');
  assert.deepEqual(longest.byWord, [{ word: '色情小说', count: 1 }]);

  const both = sensitive.scanText('色情和色情小说', ['色情', '色情小说']);
  assert.equal(both.total, 2);
  assert.deepEqual(both.issues.map((issue) => issue.word), ['色情', '色情小说']);

  // 同一个词相邻出现两次（不重叠）算两次
  assert.equal(sensitive.scanText('色情色情', ['色情']).total, 2);
  // 重叠的「哈哈哈」只算一次「哈哈」
  assert.equal(sensitive.scanText('哈哈哈', ['哈哈']).total, 1);
});

test('敏感词：字面匹配、区分大小写，不做正则', () => {
  assert.equal(sensitive.scanText('Drug and drug', ['Drug']).total, 1);
  assert.equal(sensitive.scanText('a.b axb', ['a.b']).total, 1);
  assert.equal(sensitive.scanText('括号（敏感）', ['（敏感）']).total, 1);
  assert.equal(sensitive.scanText('没有任何命中', ['色情']).total, 0);
  assert.equal(sensitive.scanText('色情', []).total, 0);
  assert.equal(sensitive.scanText('', ['色情']).total, 0);
  assert.equal(sensitive.scanText(null, ['色情']).total, 0);
});

test('敏感词：sanitizeWords 去重 / 去空 / 限长 / 限量，sanitizeOptions 夹紧', () => {
  assert.deepEqual(sensitive.sanitizeWords([' 色情 ', '', null, 5, '色情', '暴力']), ['色情', '暴力']);
  assert.deepEqual(sensitive.sanitizeWords('色情'), []);
  assert.deepEqual(sensitive.sanitizeWords(['长'.repeat(101), '正常']), ['正常']);
  const many = [];
  for (let i = 0; i < sensitive.MAX_WORDS + 10; i += 1) many.push(`词${i}`);
  assert.equal(sensitive.sanitizeWords(many).length, sensitive.MAX_WORDS);

  assert.equal(sensitive.sanitizeOptions(null).maxIssues, sensitive.DEFAULT_OPTIONS.maxIssues);
  assert.equal(sensitive.sanitizeOptions({ maxIssues: 1 }).maxIssues, 20);
  assert.equal(sensitive.sanitizeOptions({ maxIssues: 999999 }).maxIssues, 5000);
  assert.equal(sensitive.sanitizeOptions({ maxIssues: 'abc' }).maxIssues, sensitive.DEFAULT_OPTIONS.maxIssues);
});

test('CTXT-B-01：wordsSanitized 直通——整本预检不再每章重洗词表，自动机按引用命中', () => {
  const wordscan = require('../core/wordscan');
  // 默认路径会把词条 trim 后匹配；声明已清洗（直通）时原样使用，证明没有重洗。
  assert.equal(sensitive.scanText('色情', [' 色情 ']).total, 1);
  assert.equal(sensitive.scanText('色情', [' 色情 '], { wordsSanitized: true }).total, 0);
  // 非数组仍兜底成空词表，不会因直通标志抛错。
  assert.equal(sensitive.scanText('色情', '色情', { wordsSanitized: true }).total, 0);

  // 整本链路：同一个已清洗数组连续扫多章 → 只建图一次，且第二次起走引用直通。
  wordscan.resetAutomatonCache();
  const words = ['色情', '暴力'];
  sensitive.scanText('色情正文', words, { wordsSanitized: true });
  sensitive.scanText('暴力正文', words, { wordsSanitized: true });
  const stats = wordscan.automatonCacheStats();
  assert.equal(stats.builds, 1, '同一词表只建图一次');
  assert.equal(stats.referenceHits, 1, '第二章起走引用直通，跳过指纹重算');

  // 静态闸门：整本预检的循环内必须声明 wordsSanitized，且不许再手工清洗 list.words。
  const fs = require('node:fs');
  const path = require('node:path');
  const ipcSrc = fs.readFileSync(path.join(__dirname, '..', 'ipc', 'proofread.js'), 'utf8');
  const bookAt = ipcSrc.indexOf("handleBook('book:sensitive-check'");
  const scanAt = ipcSrc.indexOf('sensitiveLib.scanText(', bookAt);
  assert.ok(bookAt > 0 && scanAt > bookAt, '整本预检必须逐章调 scanText');
  assert.match(ipcSrc.slice(scanAt, scanAt + 500), /wordsSanitized: true/, '循环内要声明词表已清洗');
  assert.equal(/sanitizeWords\(list\.words\)/.test(ipcSrc), false, '循环里不许再洗一遍词表');
});

test('敏感词：明细按 maxIssues 截断，但 total / byWord 照实统计', () => {
  const text = '色情'.repeat(30);
  const result = sensitive.scanText(text, ['色情'], { maxIssues: 20 });
  assert.equal(result.total, 30);
  assert.equal(result.issues.length, 20);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.byWord, [{ word: '色情', count: 30 }]);
});

test('敏感词：每个命中词的次数都返回，wordHitCount 是全部', () => {
  const words = [];
  const parts = [];
  // 两位数补零：避免「词1」是「词10」的前缀，干扰重叠判定
  for (let i = 0; i < 25; i += 1) {
    const word = `词${String(i).padStart(2, '0')}`;
    words.push(word);
    parts.push(word);
  }
  const result = sensitive.scanText(parts.join('，'), words);
  assert.equal(result.total, 25);
  assert.equal(result.byWord.length, 25);
  assert.equal(result.wordHitCount, 25);
  assert.equal(result.byWord[0].count, 1);
});

test('敏感词：原始命中超过上限时标 truncated，不会把内存打爆', () => {
  const result = sensitive.scanText('a'.repeat(200000), ['a'], { maxIssues: 20 });
  assert.equal(result.truncated, true);
  assert.equal(result.issues.length, 20);
  assert.ok(result.total >= 100000 - 1);
  assert.ok(result.total <= sensitive.RAW_MATCH_LIMIT);
});

test('敏感词：长章节也能扫，结果按位置排序、序号递增', () => {
  const paragraph = '正文'.repeat(2000);
  const text = `${paragraph}色情${paragraph}暴力${paragraph}`;
  const result = sensitive.scanText(text, ['色情', '暴力']);
  assert.equal(result.total, 2);
  assert.equal(result.issues[0].index, paragraph.length);
  assert.equal(result.issues[1].index, paragraph.length * 2 + 2);
  assert.ok(result.issues[0].index < result.issues[1].index);
});

// X4（v1.8.0 WP-24）：敏感词预检与校对是两个同构面板，chars 契约必须一致 ——
// chars = 去空白正文字数（core/chapters.js 的 countChars，与状态栏 / 捕获队列 / 导入同一口径）；
// rawLength = 归一换行后含空白的原文长度（旧 chars 的值，位置 / 行号也在同一坐标系）。
test('敏感词：chars 是去空白字数、rawLength 是含空白原文长度（X4 / WP-24）', () => {
  const text = '第一行　有 空格。\r\n第二行\t也有。';
  const result = sensitive.scanText(text, []);
  assert.equal(result.chars, 13, '手算：第一行有空格。（7）+ 第二行也有。（6）');
  assert.equal(result.chars, chapters.countChars(text));
  assert.equal(result.rawLength, text.replace(/\r\n/g, '\n').length, 'rawLength 在归一换行后的坐标系里');
  assert.ok(result.rawLength > result.chars, '样本含空白：两个数字必须不同');

  // 空 / null 都给 0，不出现 NaN 或 undefined
  for (const input of ['', null, undefined, '   \n\t']) {
    const empty = sensitive.scanText(input, []);
    assert.equal(empty.chars, 0);
    assert.equal(empty.rawLength, typeof input === 'string' ? input.replace(/\r\n/g, '\n').length : 0);
  }
  // 无命中 / 有命中的 chars 与正文有关、与词表无关
  assert.equal(sensitive.scanText(text, ['空格']).chars, result.chars);
});
