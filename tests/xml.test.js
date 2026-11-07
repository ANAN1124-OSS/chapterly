// core/xml.js：DOCX / EPUB 两个导出共用的 XML 纯函数（审计 P1 · C1）。
//
// 收编前 core/docx.js 与 core/epub.js 各抄了一份「非法控制字符 + 五字符转义 + 正文切段 + 导出时间戳」，
// 两份逐字相同但没有测试直接钉它们（只有导出产物间接覆盖）。这里分两层钉住：
//   1. 行为：非法控制字符 / 五个特殊字符 / CRLF 与 CR / 空行 / null / 坏时间戳的边界；
//   2. 回归闸门：两个导出文件必须从 core/xml.js 拿，仓库里不许再长出第二份实现；
//      core/xml.js 必须保持纯逻辑（不 require、不碰 fs / process / electron）；
//      EPUB 继续导出的 paragraphsFromText 必须就是同一份函数（旧调用方按名字取）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const xml = require('../core/xml');
const epub = require('../core/epub');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const XML_SOURCE = read('core/xml.js');
// 纯逻辑闸门只看代码：注释里提到 fs / electron 是在解释边界，不算越界
const XML_CODE = XML_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const CORE_FILES = fs
  .readdirSync(path.join(ROOT, 'core'))
  .filter((name) => name.endsWith('.js') && name !== 'xml.js')
  .map((name) => `core/${name}`);

test('对外形状固定：4 个纯函数，多一个少一个都要在评审里看到', () => {
  assert.deepEqual(Object.keys(xml).sort(), [
    'escapeXml',
    'isoTimestamp',
    'paragraphsFromText',
    'stripInvalidXmlChars'
  ]);
});

test('stripInvalidXmlChars：剔除 XML 1.0 非法控制字符，保留 \\t \\n \\r 与可见字符', () => {
  assert.equal(
    xml.stripInvalidXmlChars('a\u0000b\u0008c\u000bd\u000ce\u001ff\tg\nh\ri'),
    'abcdef\tg\nh\ri',
    '\\u0000-\\u0008 / \\u000b / \\u000c / \\u000e-\\u001f 都该剔除；\\t \\n \\r 是合法空白'
  );
  // 正常正文（含中文 / emoji / 全角标点）一个字符都不该动
  const normal = '第一段，带“引号”——和 emoji 🙂。';
  assert.equal(xml.stripInvalidXmlChars(normal), normal);
  // 空值 / 非字符串统一成字符串再处理（旧实现同样口径）
  assert.equal(xml.stripInvalidXmlChars(null), '');
  assert.equal(xml.stripInvalidXmlChars(undefined), '');
  assert.equal(xml.stripInvalidXmlChars(123), '123');
});

test('escapeXml：五个特殊字符按 XML 规则转义，且先剔非法控制字符', () => {
  assert.equal(
    xml.escapeXml('A&B <夜> "雨" \'风\'\u0001'),
    'A&amp;B &lt;夜&gt; &quot;雨&quot; &apos;风&apos;'
  );
  // 已经转义过的文本再转义一次会得到 &amp;…（导出只转义原文，不做幂等判断——保持旧行为）
  assert.equal(xml.escapeXml('&amp;'), '&amp;amp;');
  assert.equal(xml.escapeXml(null), '');
});

test('paragraphsFromText：CRLF / CR 归一、丢空行、去首尾空白、剔非法字符', () => {
  assert.deepEqual(xml.paragraphsFromText('\r\n第一段\r第二段\n\n  \n第三段  \n'), [
    '第一段',
    '第二段',
    '第三段'
  ]);
  assert.deepEqual(xml.paragraphsFromText('a\u0000b'), ['ab']);
  assert.deepEqual(xml.paragraphsFromText(''), []);
  assert.deepEqual(xml.paragraphsFromText(null), []);
  // trim 会去掉首尾所有空白（含全角空格 U+3000）——旧实现就是这个口径，这里如实钉住：
  // 正文里靠段首全角空格做缩进的稿子，导出后缩进交给 Word 样式 / EPUB CSS，不靠空格。
  assert.deepEqual(xml.paragraphsFromText('　　缩进的段落。 '), ['缩进的段落。']);
});

test('isoTimestamp：Date 原样、字符串可解析、坏值退回现在、iso 去掉毫秒', () => {
  const fixed = new Date('2026-11-01T08:00:00Z');
  const fromDate = xml.isoTimestamp(fixed);
  assert.equal(fromDate.date, fixed, '传 Date 必须原样返回同一个对象（zip 修改时间要用）');
  assert.equal(fromDate.iso, '2026-11-01T08:00:00Z');

  assert.equal(xml.isoTimestamp('2026-11-01T08:00:00Z').iso, '2026-11-01T08:00:00Z');
  // 带毫秒的输入输出成不带毫秒（docx W3CDTF / EPUB dcterms:modified 都不需要 .123Z）
  assert.equal(xml.isoTimestamp('2026-11-01T08:00:00.123Z').iso, '2026-11-01T08:00:00Z');

  const before = Date.now();
  for (const bad of [null, undefined, '不是时间']) {
    const res = xml.isoTimestamp(bad);
    assert.ok(res.date instanceof Date, `${String(bad)} 必须退回 Date`);
    assert.equal(Number.isNaN(res.date.getTime()), false, `${String(bad)} 不许留下 Invalid Date`);
    assert.ok(res.date.getTime() >= before - 1000, `${String(bad)} 应退回「现在」`);
    assert.match(res.iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  }
  // 0 / 空字符串是合法的时间值（纪元），不该被当成坏值
  assert.equal(xml.isoTimestamp(0).iso, '1970-01-01T00:00:00Z');
});

test('两个导出共用同一份实现：EPUB 再导出的 paragraphsFromText 就是 core/xml.js 的那一个', () => {
  assert.equal(epub.paragraphsFromText, xml.paragraphsFromText, 'EPUB 的 paragraphsFromText 必须是同一份');
});

test('静态闸门：docx / epub 从 core/xml.js 取，仓库里不许再长出第二份实现', () => {
  for (const rel of ['core/docx.js', 'core/epub.js']) {
    const source = read(rel);
    const wired = /const \{[^}]*\}\s*=\s*require\('\.\/xml'\)/.exec(source);
    assert.ok(wired, `${rel} 必须从 core/xml.js 解构取函数`);
    for (const name of ['escapeXml', 'paragraphsFromText', 'isoTimestamp']) {
      assert.match(wired[0], new RegExp(`\\b${name}\\b`), `${rel} 应从 core/xml.js 取 ${name}`);
    }
  }
  const patterns = [
    { re: /function stripInvalidXmlChars\s*\(/, what: '第二份 stripInvalidXmlChars 实现' },
    { re: /function escapeXml\s*\(/, what: '第二份 escapeXml 实现' },
    { re: /function paragraphsFromText\s*\(/, what: '第二份 paragraphsFromText 实现' },
    { re: /function isoTimestamp\s*\(/, what: '第二份 isoTimestamp 实现' }
  ];
  for (const rel of CORE_FILES) {
    const source = read(rel);
    for (const { re, what } of patterns) {
      assert.equal(re.test(source), false, `${rel} 里不该再有${what}（用 core/xml.js）`);
    }
  }
});

test('core/xml.js 是纯逻辑：不 require 任何模块，也不碰 fs / process / window / document / electron', () => {
  assert.equal(/require\s*\(/.test(XML_CODE), false, '不许 require（fs / path / electron 都不行）');
  assert.equal(/\bprocess\s*\./.test(XML_CODE), false, '不许碰 process');
  assert.equal(/\bwindow\s*\./.test(XML_CODE), false, '不许碰 window');
  assert.equal(/\bdocument\s*\./.test(XML_CODE), false, '不许碰 document');
  assert.equal(/\bfs\s*\./.test(XML_CODE), false, '不许碰 fs');
  assert.equal(/electron/.test(XML_CODE), false, '不许出现 electron');
});
