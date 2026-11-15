// 词表读取 / 解码共享核心（core/wordlist.js）的单测：A1 / v1.8.0 WP-30。
//
// 敏感词预检与校对词表原来是两份逐字重复的「读词表流水线」（约 200 行镜像）。这一轮把
// 未配置 → stat → 读盘 → 解码 → 二进制 / 坏编码判定 → 解析 → 公开信息 收进 core/wordlist.js，
// 各模块只留自己的行解析与错误码文案。测试分两层：
//   ① 共享核心本身：注入式选项（错误码 / 文案 / 字段名）真被用上，回包形状与边界逐项钉住；
//   ② 两个真实消费者：同一份字节在两边得到各自的错误码与文案、同一个 4MB 上限、同一套结构；
//      静态闸门确认仓库里没有第二份流水线。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const wordlist = require('../core/wordlist');
const sensitive = require('../core/sensitive');
const glossary = require('../core/glossary');

const tmpCleanup = require('./tmp-cleanup');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

async function mkTmp() {
  return tmpCleanup.track(await fsp.mkdtemp(path.join(os.tmpdir(), 'cw-wordlist-')));
}

// 一份合成读取器：错误码 / 文案 / 字段名全部可注入，用来证明共享核心不是写死敏感词那套。
function createDemoReader(overrides = {}) {
  return wordlist.createReader({
    field: 'words',
    parse: (text) => {
      const lines = text.split('\n');
      const words = lines.map((line) => line.trim()).filter(Boolean);
      return { words, stats: { lines: lines.length } };
    },
    codes: {
      empty: 'DEMO_EMPTY',
      tooBig: 'DEMO_TOO_BIG',
      badEncoding: 'DEMO_BAD_ENCODING',
      notConfigured: 'DEMO_NOT_CONFIGURED',
      missing: 'DEMO_MISSING',
      unreadable: 'DEMO_UNREADABLE',
      notFile: 'DEMO_NOT_FILE'
    },
    messages: {
      emptyFile: '演示词表是空文件',
      emptyList: '演示词表里没有有效的词',
      tooBig: '演示词表太大',
      binary: '演示词表是二进制',
      badEncoding: '演示词表编码坏了',
      notConfigured: '还没有配置演示词表',
      publicEmpty: '还没有配置演示词表（公开信息）',
      notFile: '演示词表选中的不是文件'
    },
    ...overrides
  });
}

// ---------------------------------------------------------------- ① 共享核心

test('createReader：field / parse / codes / messages 缺一项就在创建期抛 TypeError', () => {
  const ok = createDemoReader();
  assert.deepEqual(Object.keys(ok).sort(), ['decodeBuffer', 'publicInfo', 'readFile']);
  // 先校验 field：null / 缺 field 都按「字段名不合法」报，不会静默吞掉整份选项
  assert.throws(() => wordlist.createReader(null), /field 只认 words \/ entries/);
  assert.throws(() => wordlist.createReader({ parse: () => ({ words: [] }) }), /field 只认 words \/ entries/);
  assert.throws(() => wordlist.createReader({ field: 'entries' }), /缺少 parse/);
  assert.throws(
    () => wordlist.createReader({ ...demoOptions(), codes: { ...demoOptions().codes, tooBig: '' } }),
    /缺少 codes.tooBig/
  );
  assert.throws(
    () => wordlist.createReader({ ...demoOptions(), messages: { ...demoOptions().messages, binary: undefined } }),
    /缺少 messages.binary/
  );
});

function demoOptions() {
  return {
    field: 'words',
    parse: (text) => ({ words: text.split('\n').map((line) => line.trim()).filter(Boolean), stats: { lines: 1 } }),
    codes: {
      empty: 'DEMO_EMPTY',
      tooBig: 'DEMO_TOO_BIG',
      badEncoding: 'DEMO_BAD_ENCODING',
      notConfigured: 'DEMO_NOT_CONFIGURED',
      missing: 'DEMO_MISSING',
      unreadable: 'DEMO_UNREADABLE',
      notFile: 'DEMO_NOT_FILE'
    },
    messages: {
      emptyFile: '演示词表是空文件',
      emptyList: '演示词表里没有有效的词',
      tooBig: '演示词表太大',
      binary: '演示词表是二进制',
      badEncoding: '演示词表编码坏了',
      notConfigured: '还没有配置演示词表',
      publicEmpty: '还没有配置演示词表（公开信息）',
      notFile: '演示词表选中的不是文件'
    }
  };
}

test('decodeBuffer：编码（UTF-8 BOM / UTF-16LE / GBK）与空 / 超限 / 二进制 / 坏编码都走注入的错误码', () => {
  const reader = createDemoReader();
  const utf8 = reader.decodeBuffer(Buffer.from('\uFEFF色情\n暴力', 'utf8'));
  assert.deepEqual(utf8, { ok: true, words: ['色情', '暴力'], stats: { lines: 2 } });

  const utf16 = reader.decodeBuffer(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('色情\r\n暴力', 'utf16le')]));
  assert.deepEqual(utf16.words, ['色情', '暴力']);

  const gbk = reader.decodeBuffer(Buffer.from([0xc9, 0xab, 0xc7, 0xe9, 0x0a, 0xb1, 0xa9, 0xc1, 0xa6]));
  assert.deepEqual(gbk.words, ['色情', '暴力']);

  // 「空文件」与「文件有内容但没有有效词」是两个不同入口，但共用同一个错误码
  assert.deepEqual(reader.decodeBuffer(Buffer.alloc(0)), {
    ok: false,
    code: 'DEMO_EMPTY',
    message: '演示词表是空文件'
  });
  assert.deepEqual(reader.decodeBuffer(Buffer.from(' \r\n\t', 'utf8')), {
    ok: false,
    code: 'DEMO_EMPTY',
    message: '演示词表里没有有效的词'
  });
  // 带 NUL 的二进制（非 UTF-16 BOM）
  assert.deepEqual(reader.decodeBuffer(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01])), {
    ok: false,
    code: 'DEMO_BAD_ENCODING',
    message: '演示词表是二进制'
  });
  // 坏字节解出 U+FFFD
  assert.equal(reader.decodeBuffer(Buffer.from([0xff, 0xff, 0x0a, 0x41])).message, '演示词表编码坏了');
  // 审计修复 #49（E24）：原文里合法的 U+FFFD（UTF-8 EF BF BD）不能被当成坏编码
  const literal = reader.decodeBuffer(Buffer.from('替换\uFFFD词', 'utf8'));
  assert.equal(literal.ok, true);
  assert.deepEqual(literal.words, ['替换\uFFFD词']);
  // UTF-32LE BOM 也走严格解码（#50 的解码器 + #49 的严格判定）
  const utf32 = Buffer.alloc(4 + Array.from('甲词').length * 4);
  Buffer.from([0xff, 0xfe, 0x00, 0x00]).copy(utf32, 0);
  Array.from('甲词').forEach((ch, index) => utf32.writeUInt32LE(ch.codePointAt(0), 4 + index * 4));
  assert.equal(reader.decodeBuffer(utf32).ok, true);
  assert.deepEqual(reader.decodeBuffer(utf32).words, ['甲词']);
  // 超过 4MB（共享上限）
  const tooBig = reader.decodeBuffer(Buffer.alloc(wordlist.MAX_FILE_BYTES + 1, 0x41));
  assert.deepEqual(tooBig, { ok: false, code: 'DEMO_TOO_BIG', message: '演示词表太大' });
  // 正好 4MB 不拦（边界取「大于才拒绝」）
  assert.equal(reader.decodeBuffer(Buffer.alloc(wordlist.MAX_FILE_BYTES, 0x41)).ok, true);
});

test('readFile：未配置 / 不存在 / 不是文件 / 正常 / 超限 / 空文件都给结构化结果（不抛异常）', async () => {
  const reader = createDemoReader({ notConfiguredExtra: { count: 0 } });
  const notConfigured = await reader.readFile('');
  assert.deepEqual(notConfigured, {
    ok: false,
    configured: false,
    code: 'DEMO_NOT_CONFIGURED',
    message: '还没有配置演示词表',
    path: '',
    name: '',
    count: 0
  });

  const dir = await mkTmp();
  const missing = await reader.readFile(path.join(dir, '没有这个.txt'));
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'DEMO_MISSING');
  assert.equal(missing.configured, true);
  assert.match(missing.message, /不存在/);
  assert.equal(missing.name, '没有这个.txt');

  const notFile = await reader.readFile(dir);
  assert.equal(notFile.code, 'DEMO_NOT_FILE');

  const file = path.join(dir, '词表.txt');
  await fsp.writeFile(file, '色情\r\n暴力\r\n', 'utf8');
  const loaded = await reader.readFile(file);
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.words, ['色情', '暴力']);
  assert.equal(loaded.name, '词表.txt');
  assert.equal(loaded.size, Buffer.byteLength('色情\r\n暴力\r\n', 'utf8'));
  assert.equal(loaded.configured, true);
  assert.equal(loaded.stats.lines, 3);
  assert.equal(loaded.count, undefined, '原始结果用 words 携带内容，publicInfo 才补 count');

  const big = path.join(dir, '大词表.txt');
  await fsp.writeFile(big, Buffer.alloc(wordlist.MAX_FILE_BYTES + 1, 0x41));
  const tooBig = await reader.readFile(big);
  assert.equal(tooBig.code, 'DEMO_TOO_BIG');
  assert.equal(tooBig.size, wordlist.MAX_FILE_BYTES + 1);

  const empty = path.join(dir, '空词表.txt');
  await fsp.writeFile(empty, ' \r\n\t', 'utf8');
  assert.equal((await reader.readFile(empty)).code, 'DEMO_EMPTY');
});

test('publicInfo：剥掉内容字段 / path、补 count；坏值回注入的默认文案与 extra（#56 / S5）', () => {
  const reader = createDemoReader({ notConfiguredExtra: { count: 0 } });
  const info = reader.publicInfo({
    ok: true,
    words: ['甲', '乙', '丙'],
    name: '词表.txt',
    path: 'C:\\Users\\作者\\秘密目录\\词表.txt',
    stats: { lines: 3 }
  });
  assert.deepEqual(info, { ok: true, name: '词表.txt', stats: { lines: 3 }, count: 3 });
  assert.equal(info.words, undefined);
  assert.equal(info.path, undefined, 'resolved 全路径不出主进程（与多份词表 / glossary 口径一致）');
  assert.equal(reader.publicInfo({ ok: true }).count, 0);
  assert.deepEqual(reader.publicInfo(null), {
    ok: false,
    configured: false,
    code: 'DEMO_NOT_CONFIGURED',
    message: '还没有配置演示词表（公开信息）',
    name: '',
    count: 0
  });
  assert.equal(reader.publicInfo('坏值').count, 0);
  // 真实读盘结果同样不带 path：name 是 basename，足够界面显示
  const real = reader.publicInfo({ ok: true, words: ['甲'], name: '词表.txt', path: 'C:\\某处\\词表.txt', stats: {} });
  assert.equal(real.path, undefined);
  assert.equal(real.name, '词表.txt');
});

// ---------------------------------------------------------------- ① b E13（审计修复 #16）

test('E13：decode / parse 抛错都兜成结构化失败（绝不把异常冒泡到 IPC）', () => {
  const txt = require('../core/txt');
  const original = txt.decodeBuffer;
  const failOptions = (parse) => ({
    field: 'words',
    parse,
    codes: { ...demoOptions().codes, parseFailed: 'DEMO_PARSE_FAILED' },
    messages: { ...demoOptions().messages, parseFailed: '演示词表解析失败（兜底）' }
  });

  // ① 解码层抛错（parseFailed 显式注入 → 用注入的码与文案）
  const reader = wordlist.createReader(failOptions((text) => ({ words: text.split(/\r?\n/).filter(Boolean), stats: {} })));
  txt.decodeBuffer = () => {
    throw new Error('TextDecoder 炸了');
  };
  try {
    assert.deepEqual(reader.decodeBuffer(Buffer.from('色情', 'utf8')), {
      ok: false,
      code: 'DEMO_PARSE_FAILED',
      message: '演示词表解析失败（兜底）'
    });
  } finally {
    txt.decodeBuffer = original;
  }
  // 解码返回非字符串也按「解析不了」处理，不再在 .includes 上抛 TypeError
  txt.decodeBuffer = () => null;
  try {
    assert.equal(reader.decodeBuffer(Buffer.from('色情', 'utf8')).code, 'DEMO_PARSE_FAILED');
  } finally {
    txt.decodeBuffer = original;
  }

  // ② 行解析抛错
  const broken = wordlist.createReader(
    failOptions(() => {
      throw new Error('parse 炸了');
    })
  );
  assert.deepEqual(broken.decodeBuffer(Buffer.from('色情\n暴力', 'utf8')), {
    ok: false,
    code: 'DEMO_PARSE_FAILED',
    message: '演示词表解析失败（兜底）'
  });

  // ③ 两个可选键都不传 → 共享默认码 / 默认文案（老调用方 / 演示读取器零改动）
  const plain = createDemoReader({
    parse: () => {
      throw new Error('parse 炸了');
    }
  });
  const fallback = plain.decodeBuffer(Buffer.from('色情', 'utf8'));
  assert.equal(fallback.ok, false);
  assert.equal(fallback.code, 'WORDLIST_PARSE_FAILED');
  assert.match(fallback.message, /解析失败/);
});

test('E13：真实消费者（校对 / 敏感词）的兜底用各自错误码，读盘路径同样不抛', async () => {
  const txt = require('../core/txt');
  const original = txt.decodeBuffer;
  const dir = await mkTmp();
  const file = path.join(dir, '词表.txt');
  await fsp.writeFile(file, '色情\r\n暴力\r\n', 'utf8');
  txt.decodeBuffer = () => {
    throw new Error('boom');
  };
  try {
    const glossaryFail = await glossary.readGlossaryFile(file);
    assert.equal(glossaryFail.ok, false);
    assert.equal(glossaryFail.code, 'GLOSSARY_PARSE_FAILED');
    assert.equal(glossaryFail.configured, true, '读盘路径的 configured / name / size 仍要如实回');
    assert.equal(glossaryFail.name, '词表.txt');
    assert.equal(glossaryFail.size, Buffer.byteLength('色情\r\n暴力\r\n', 'utf8'));
    // 多份合并路径的 per-list 提示走 glossaryErrorText 的新分支（不是落到「读不了这份词表」）
    const bundle = await glossary.readGlossaryFiles([file]);
    assert.equal(bundle.ok, false);
    assert.equal(bundle.lists[0].error, '词表内容解析失败（文件可能不是纯文本），请检查后重试');

    const sensitiveFail = await sensitive.readWordListFile(file);
    assert.equal(sensitiveFail.ok, false);
    assert.equal(sensitiveFail.code, 'WORD_LIST_PARSE_FAILED');
    assert.match(sensitiveFail.message, /解析失败/);

    // 单文件解码入口同样兜住（不是只有读盘路径）
    assert.equal(glossary.decodeGlossaryBuffer(Buffer.from('色情\n', 'utf8')).code, 'GLOSSARY_PARSE_FAILED');
    assert.equal(sensitive.decodeWordListBuffer(Buffer.from('色情\n', 'utf8')).code, 'WORD_LIST_PARSE_FAILED');
  } finally {
    txt.decodeBuffer = original;
  }
  // 恢复后同一份文件照常读出来（兜底没有把读取器带坏）
  const recovered = await glossary.readGlossaryFile(file);
  assert.equal(recovered.ok, true);
  assert.deepEqual(recovered.entries.map((entry) => entry.term), ['色情', '暴力']);
});

// ---------------------------------------------------------------- ② 真实消费者

test('敏感词 / 校对词表：同一份字节在两边得到各自的错误码，正常文件结构同源', async () => {
  assert.equal(sensitive.MAX_FILE_BYTES, wordlist.MAX_FILE_BYTES);
  assert.equal(glossary.MAX_FILE_BYTES, wordlist.MAX_FILE_BYTES);

  const empty = Buffer.alloc(0);
  assert.equal(sensitive.decodeWordListBuffer(empty).code, 'WORD_LIST_EMPTY');
  assert.equal(glossary.decodeGlossaryBuffer(empty).code, 'GLOSSARY_EMPTY');
  assert.equal(sensitive.decodeWordListBuffer(empty).message, '词表是空文件（每行一个词）');
  assert.equal(glossary.decodeGlossaryBuffer(empty).message, '词表是空文件（每行一个词，可写「错词 → 建议」）');

  const binary = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]);
  assert.equal(sensitive.decodeWordListBuffer(binary).code, 'WORD_LIST_BAD_ENCODING');
  assert.equal(glossary.decodeGlossaryBuffer(binary).code, 'GLOSSARY_BAD_ENCODING');

  // 有内容但没有有效词：错误码同 EMPTY，文案各用各的（行解析的差异留在模块里）
  assert.equal(sensitive.decodeWordListBuffer(Buffer.from(' \r\n\t', 'utf8')).message, '词表里没有有效的词（每行一个词，空行和 # 注释会被忽略）');
  assert.equal(
    glossary.decodeGlossaryBuffer(Buffer.from(' \r\n# 只有注释\n', 'utf8')).message,
    '词表里没有有效的词（每行一个词，空行和 # 注释会被忽略）'
  );

  // 同一份正常文件：一边 words、一边 entries，ok / size / name / configured 结构一致
  const dir = await mkTmp();
  const file = path.join(dir, '词表.txt');
  await fsp.writeFile(file, '色情\r\n暴力\r\n', 'utf8');
  const words = await sensitive.readWordListFile(file);
  const entries = await glossary.readGlossaryFile(file);
  for (const key of ['ok', 'configured', 'size', 'name', 'path']) {
    assert.deepEqual(words[key], entries[key], `同一文件的 ${key} 必须一致`);
  }
  assert.deepEqual(words.words, ['色情', '暴力']);
  assert.deepEqual(entries.entries.map((entry) => entry.term), ['色情', '暴力']);

  // 未配置：校对词表多一个 count: 0（旧形状），敏感词表没有
  const wordsMissing = await sensitive.readWordListFile('');
  const entriesMissing = await glossary.readGlossaryFile('');
  assert.equal(wordsMissing.count, undefined);
  assert.equal(entriesMissing.count, 0);
  assert.equal(wordsMissing.code, 'WORD_LIST_NOT_CONFIGURED');
  assert.equal(entriesMissing.code, 'GLOSSARY_NOT_CONFIGURED');
});

test('静态闸门：读词表流水线只有 core/wordlist.js 一份，两模块只留行解析与错误码', () => {
  for (const rel of ['core/sensitive.js', 'core/glossary.js']) {
    const source = read(rel);
    assert.ok(source.includes("require('./wordlist')"), `${rel} 必须 require('./wordlist')`);
    assert.ok(source.includes('wordlist.createReader('), `${rel} 必须从共享核心造读取器`);
    // 流水线本体（stat / 读盘 / BOM / 二进制 / U+FFFD 判定）不许在模块里回潮
    for (const forbidden of ['fs.stat(', 'fs.readFile(', 'hasUtf16Bom', 'buffer.includes(0)', 'txtLib.decodeBuffer', 'errorText.maskPath(']) {
      assert.equal(source.includes(forbidden), false, `${rel} 里不许再出现 ${forbidden}（统一走 core/wordlist.js）`);
    }
  }
  // 全 core 只有两处 createReader 调用（敏感词 / 校对），实现只有 core/wordlist.js
  const coreFiles = fs
    .readdirSync(path.join(ROOT, 'core'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => `core/${name}`);
  const callers = coreFiles.filter((rel) => read(rel).includes('wordlist.createReader('));
  assert.deepEqual(callers.sort(), ['core/glossary.js', 'core/sensitive.js']);
  const implementations = coreFiles.filter((rel) => read(rel).includes('MAX_FILE_BYTES = 4 * 1024 * 1024'));
  assert.deepEqual(implementations, ['core/wordlist.js']);
});

// S8（审计修复 #45）：先 stat 后按路径 readFile 的 TOCTOU —— 同一份词表在上限检查之后被换成大文件，
  // 旧实现会把整份读进内存（4 MB 上限形同虚设）。现在闸门与读盘绑在同一个句柄上。
test('S8（#45）：词表的大小闸门与读盘走同一个句柄（open → fstat → handle.readFile）', () => {
  const src = read('core/wordlist.js');
  const start = src.indexOf('async function readFile(filePath)');
  assert.ok(start >= 0, '找不到 readFile');
  const body = src.slice(start, src.indexOf('\n  // 只给渲染层的词表信息', start));
  assert.ok(body.includes('fs.open(resolved, \'r\')'), '必须先 open 再 fstat');
  assert.ok(body.includes('handle.stat()'), '上限要用句柄上的 fstat 结论');
  assert.ok(body.includes('handle.readFile()'), '内容必须从同一个句柄读');
  assert.equal(body.includes('fs.readFile(resolved'), false, '不许再按路径 readFile（TOCTOU 窗口）');
});