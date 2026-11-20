// WP7 / X-N1（审计中 #21）：无 BOM 路径的编码宽容与 UTF-16 启发式。
//
// 旧实现：没有 BOM 且严格 UTF-8 失败时直接落 GB18030（严格或非 fatal 兜底），
//   · 网络抓取来的 UTF-8 小说只要混 1 个坏字节，整本就被解成 GB18030 乱码；
//     同一内容带 BOM 时却只出现 1 个 U+FFFD（差一个 BOM，结果天壤之别）。
//   · 无 BOM 的纯中文 UTF-16LE（双字节均非 0）同样被严格 GB18030 静默误解；
//     正文里有换行 / ASCII 时（低字节 0x00）还会被二进制闸门直接拒掉。
// 本文件钉住：坏字节极少 → 宽容 UTF-8（与 BOM 路径对称）；明显非 UTF-8 才落 GB18030；
// 无 BOM UTF-16LE/BE 能被识别；导入结果报告编码与替换符数量。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const txt = require('../core/txt');
const importer = require('../core/importer');
const storage = require('../core/storage');

const tmpCleanup = require('./tmp-cleanup');

const FFFD = '\uFFFD';

async function mkTmp() {
  return tmpCleanup.track(await fs.mkdtemp(path.join(os.tmpdir(), 'cw-encoding-')));
}

// 无 BOM 的 UTF-16LE：Buffer.from(text, 'utf16le') 不带 BOM
function utf16leNoBom(text) {
  return Buffer.from(text, 'utf16le');
}

// 无 BOM 的 UTF-16BE：同样不带 BOM，按大端重排字节
function utf16beNoBom(text) {
  return Buffer.from(text, 'utf16le').swap16();
}

// E1：没有 BOM 的 UTF-8 混 1 个坏字节 → 宽容 UTF-8（个别 U+FFFD），不许整本落 GB18030。
test('X-N1 E1：无 BOM UTF-8 夹 1 个坏字节 → 个别 U+FFFD，与 BOM 路径对称', async () => {
  const head = '第一章 雪夜';
  const tail = '他推开门，屋里没有人。';
  const bad = Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from([0xff]), Buffer.from(tail, 'utf8')]);

  // 严格判定仍如实判「不是合法 UTF-8」（词表读取靠它，口径不许放宽）
  assert.equal(txt.decodeBufferStrict(bad), null);
  assert.deepEqual(txt.decodeBufferWithEncoding(bad), {
    text: `${head}${FFFD}${tail}`,
    encoding: 'utf-8',
    replacements: 1
  });
  // 与 BOM 路径对称：同一内容只差一个 BOM，结果逐字相同（BOM 路径的替换符计数见 E7 的字段口径）
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bad]);
  assert.equal(txt.decodeBuffer(withBom), `${head}${FFFD}${tail}`);

  // 导入链路：正常导入成书，正文逐字可读、只有 1 个替换符，结果报告编码与替换数量
  const base = await mkTmp();
  const src = path.join(base, '抓取来的小说');
  await fs.mkdir(src);
  await fs.writeFile(
    path.join(src, '雪夜.txt'),
    Buffer.concat([Buffer.from('第一章 雪夜\n\n', 'utf8'), Buffer.from([0xff]), Buffer.from(tail, 'utf8')])
  );
  const res = await importer.importFolders(path.join(base, '书架'), [src]);
  assert.equal(res.failed.length, 0, `不该失败：${JSON.stringify(res.failed)}`);
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].encoding, 'utf-8');
  assert.equal(res.imported[0].replacements, 1);
  const meta = await storage.readBookMeta(res.imported[0].path);
  const loaded = await storage.loadChapterText(res.imported[0].path, meta.chapters[0].file);
  assert.equal(loaded.text.includes(FFFD), true);
  assert.match(loaded.text, /他推开门，屋里没有人。/);
});

// E2：无 BOM 纯中文 UTF-16LE，且正文含换行 → 低字节 0x00（旧二进制闸门会拒）→ 现在要识别，
//     并且按原文导入（章名 / 正文逐字对）。
test('X-N1 E2：无 BOM 纯中文 UTF-16LE（含换行 / 有 NUL）→ 识别并正常导入', async () => {
  const text = '第一章 雪夜\n\n他推开门，屋里没有人。\n第二章 归途\n\n雪停了。';
  const buffer = utf16leNoBom(text);

  assert.equal(buffer.includes(0), true, '换行 / ASCII 的低字节必须是 0x00 才能覆盖二进制闸门场景');
  assert.equal(importer.isProbablyBinary(buffer), true, '旧二进制闸门只看有没有 0 字节（本用例的出发点）');
  assert.equal(txt.detectBomlessUtf16(buffer), 'utf-16le');
  assert.deepEqual(txt.decodeBufferWithEncoding(buffer), {
    text,
    encoding: 'utf-16le',
    replacements: 0
  });

  const base = await mkTmp();
  const src = path.join(base, '手机导出');
  await fs.mkdir(src);
  await fs.writeFile(path.join(src, '雪夜.txt'), buffer);
  const res = await importer.importFolders(path.join(base, '书架'), [src]);
  assert.equal(res.failed.length, 0, `不许再报「不是纯文本文件」：${JSON.stringify(res.failed)}`);
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].encoding, 'utf-16le');
  const meta = await storage.readBookMeta(res.imported[0].path);
  assert.deepEqual(meta.chapters.map((c) => c.name), ['第一章 雪夜', '第二章 归途']);
});

// E3：无 BOM 纯中文 UTF-16LE，没有任何换行 / ASCII → 一个 0 字节都没有，
//     旧实现会被严格 GB18030「成功」解成乱码；现在走 UTF-16 启发式识别。
test('X-N1 E3：无 BOM 纯中文 UTF-16LE（双字节均非 0、无 NUL）→ 仍识别为 utf-16le', () => {
  const text = '中文正文测试内容';
  const buffer = utf16leNoBom(text);
  assert.equal(buffer.includes(0), false);
  // 旧实现：严格 UTF-8 失败后落严格 GB18030（几乎接受任意字节）→ 整本解成乱码，且没有任何提示
  const strict = txt.decodeBufferStrictInfo(buffer);
  assert.equal(strict.encoding, 'gb18030');
  assert.notEqual(strict.text, text);
  assert.equal(txt.detectBomlessUtf16(buffer), 'utf-16le');
  assert.deepEqual(txt.decodeBufferWithEncoding(buffer), {
    text,
    encoding: 'utf-16le',
    replacements: 0
  });
});

// E4：无 BOM UTF-16BE 对称识别。
test('X-N1 E4：无 BOM 纯中文 UTF-16BE → 识别为 utf-16be，解码逐字等于原文', () => {
  const text = '第一章 雪夜\n中文正文';
  const buffer = utf16beNoBom(text);
  assert.equal(buffer.subarray(0, 2).equals(Buffer.from([0xfe, 0xff])), false, '不能是 BOM 路径');
  assert.equal(txt.detectBomlessUtf16(buffer), 'utf-16be');
  assert.deepEqual(txt.decodeBufferWithEncoding(buffer), {
    text,
    encoding: 'utf-16be',
    replacements: 0
  });
});

// E5：GBK 书的老路径不回退（严格 GB18030 能认出来时不许被宽容 UTF-8 抢走）。
test('X-N1 E5：GBK 编码仍按 gb18030 解，严格路径不回退且替换符不误报；但会带「编码可疑」标记', async () => {
  const gbk = Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x20, 0xd6, 0xd0, 0xce, 0xc4]);
  // 五-H6（TC-1）半步：UTF-8 严格失败 → 严格 GB18030 成功，这条路径无法排除「UTF-8 被误判成
  // GB18030」，所以回包带 encodingSuspect（导入界面提示作者核对）。反向校验阈值待作者拍板。
  assert.deepEqual(txt.decodeBufferWithEncoding(gbk), {
    text: '第一章 中文',
    encoding: 'gb18030',
    encodingSuspect: true
  });

  const base = await mkTmp();
  const src = path.join(base, 'GBK收藏');
  await fs.mkdir(src);
  await fs.writeFile(path.join(src, 'GBK小说.txt'), gbk);
  const res = await importer.importFolders(path.join(base, '书架'), [src]);
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].encoding, 'gb18030');
  assert.equal(res.imported[0].encodingSuspect, true, '导入回包要带可疑标记给界面提示');
  assert.equal('replacements' in res.imported[0], false, '干净 GBK 不许误报替换符');
});

// E6：「坏字节极少」不是无门槛宽容 —— 明显非 UTF-8 才落 GB18030。
test('X-N1 E6：UTF-8 正文后接大量坏字节 → 超出宽容预算，仍落 GB18030 并如实报替换数量', () => {
  const buffer = Buffer.concat([
    Buffer.from('第一章 雪夜\n\n第一章正文。', 'utf8'),
    Buffer.alloc(400, 0xff)
  ]);
  const info = txt.decodeBufferWithEncoding(buffer);
  assert.equal(info.encoding, 'gb18030', '400 个坏字节已经明显不是 UTF-8，不能被「宽容 UTF-8」吞掉');
  assert.ok(info.replacements > 0, '兜底替换必须报告数量');
  // 五-H6（TC-1）：这条路径本身是「非 fatal GB18030 兜底」，已被 replacements 如实报告；
  // encodingSuspect 只标在「严格 GB18030 成功」那条更可疑的路径上，不重复标记。
  assert.equal('encodingSuspect' in info, false);
});

// E7：严格路径的形状不变 —— 合法 UTF-8（哪怕原文里本来就有 U+FFFD）不带 replacements 字段；
//     只有非严格路径（BOM 锁定 / 宽容 UTF-8 / UTF-16 启发式 / GB18030 兜底）才带计数。
test('X-N1 E7：严格解码路径不出现 replacements；非严格路径才带替换符计数', () => {
  const literal = Buffer.from('替换\uFFFD字符\n正文', 'utf8');
  assert.equal(txt.decodeBufferStrict(literal), '替换\uFFFD字符\n正文');
  assert.deepEqual(txt.decodeBufferWithEncoding(literal), { text: '替换\uFFFD字符\n正文', encoding: 'utf-8' });
  assert.equal('replacements' in txt.decodeBufferWithEncoding(literal), false, '原文里的 U+FFFD 不是替换出来的');

  // BOM 锁定路径（审计残留 #50）现在也报告替换数量，与无 BOM 的宽容路径同一口径
  const bomBad = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('头', 'utf8'),
    Buffer.from([0xff]),
    Buffer.from('尾', 'utf8')
  ]);
  assert.deepEqual(txt.decodeBufferWithEncoding(bomBad), {
    text: `头${FFFD}尾`,
    encoding: 'utf-8',
    replacements: 1
  });
});

// E8：干净导入的报告形状 —— 有 encoding、无 replacements（旧回包形状只多 encoding）。
test('X-N1 E8：干净导入只多 encoding 字段，不带 replacements', async () => {
  const base = await mkTmp();
  const src = path.join(base, '干净收藏');
  await fs.mkdir(src);
  await fs.writeFile(path.join(src, '干净小说.txt'), '第1章 开端\n\n正文', 'utf8');
  const res = await importer.importFolders(path.join(base, '书架'), [src]);
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].encoding, 'utf-8');
  assert.equal('replacements' in res.imported[0], false);
});
// 五-H6（TC-1，半步）：UTF-8 正文混入 GBK 片段（UTF-8 坏字节超出宽容预算）→ UTF-8 严格失败后
// 「严格 GB18030」成功，整本被解成「绗笁绔」式乱码且旧回包不带任何证据。现在回包如实带
// encodingSuspect，导入界面据此提示作者核对；反向校验阈值属产品决策（待作者拍板）。
test('五-H6（TC-1）：UTF-8 正文混 GBK 片段 → 严格 GB18030「成功」也标可疑，不静默当正常', () => {
  const utf8Body = Buffer.from('天地玄黄宇宙洪荒'.repeat(20), 'utf8');
  const gbkFragment = Buffer.from([0xbb, 0xb5, 0xd7, 0xd6, 0xbd, 0xda]); // GBK「坏字节」
  const info = txt.decodeBufferWithEncoding(Buffer.concat([utf8Body, gbkFragment]));
  assert.equal(info.encoding, 'gb18030');
  assert.equal(info.encodingSuspect, true, 'UTF-8 失败后按严格 GB18030 解成功必须标可疑');
  assert.equal('replacements' in info, false, '严格路径没有替换符字段（乱码不是替换符）');
});

// TC-5（五-L7）：UTF-32BE 是大端对称缺口 —— 旧实现四个 BOM 分支全不命中，严格 UTF-8 失败后
// 被「含 0 字节」的二进制闸门判成 NOT_TEXT（报错明确、无数据损坏，但完全读不了 UTF-32BE 小说）。
test('TC-5（五-L7）：UTF-32BE 小说正常导入，章名 / 正文逐字还原、回包报告 utf-32be', async () => {
  const text = '第一章 雪夜\n\n他推开门，屋里没有人。\n第二章 归途\n\n雪停了。';
  const buffer = Buffer.alloc(4 + Array.from(text).length * 4);
  Buffer.from([0x00, 0x00, 0xfe, 0xff]).copy(buffer, 0);
  Array.from(text).forEach((ch, index) => buffer.writeUInt32BE(ch.codePointAt(0), 4 + index * 4));

  assert.equal(importer.isProbablyBinary(buffer), false, 'UTF-32BE BOM 不该被当二进制');
  assert.deepEqual(txt.decodeBufferWithEncoding(buffer), { text, encoding: 'utf-32be' });

  const base = await mkTmp();
  const src = path.join(base, 'UTF32BE 导出');
  await fs.mkdir(src);
  await fs.writeFile(path.join(src, '雪夜.txt'), buffer);
  const res = await importer.importFolders(path.join(base, '书架'), [src]);
  assert.equal(res.failed.length, 0, `不许再报「不是纯文本文件」：${JSON.stringify(res.failed)}`);
  assert.equal(res.imported.length, 1);
  assert.equal(res.imported[0].encoding, 'utf-32be');
  const meta = await storage.readBookMeta(res.imported[0].path);
  assert.deepEqual(meta.chapters.map((c) => c.name), ['第一章 雪夜', '第二章 归途']);
  const loaded = await storage.loadChapterText(res.imported[0].path, meta.chapters[0].file);
  assert.match(loaded.text, /他推开门，屋里没有人。/);
  assert.equal(loaded.text.includes('\u0000'), false, '正文里不许残留 NUL');
});
