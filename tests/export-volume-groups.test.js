'use strict';
// 1.7.0 P4-1（审计 V29）：导出「按卷连续段分组」原来在 core/exporter.js（composeBook）、
// core/docx.js（buildBundle）、core/epub.js（groupChapters）各写一份。
// tests/fixtures/export-volume-groups.json 是收编前（HEAD=8d75e8e）三处实现导出的逐字快照：
// 覆盖全书无卷 / 单卷 / 跨卷连续段 / 卷间夹无卷章 / 空卷名 / 卷不在 meta 里 / 单章。
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'export-volume-groups.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const exporter = require('../core/exporter');
const docx = require('../core/docx');
const epub = require('../core/epub');

const MODIFIED = fixture.modified;
const ZIP_DATE = new Date(fixture.zipDate);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function coreSources() {
  const dir = path.join(ROOT, 'core');
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => ({ name, src: fs.readFileSync(path.join(dir, name), 'utf8') }));
}

test('差分锚点：txt / docx / epub 三处导出与收编前逐字节一致', async () => {
  assert.ok(fixture.cases.length >= 7, '夹具要覆盖 7 种卷结构');
  for (const item of fixture.cases) {
    const texts = item.texts;
    assert.equal(exporter.composeBook(item.meta, texts), item.txt, 'txt 输出变了：' + item.key);

    const d = await docx.buildDocx({ meta: item.meta, texts, modified: MODIFIED, zipDate: ZIP_DATE });
    assert.equal(sha256(d.buffer), item.docxSha256, 'docx 字节变了：' + item.key);
    assert.equal(d.bytes, item.docxBytes, 'docx 大小变了：' + item.key);
    assert.equal(d.volumeCount, item.docxVolumeCount, 'docx 卷数变了：' + item.key);
    assert.equal(d.chapterCount, item.docxChapterCount, 'docx 章数变了：' + item.key);

    const e = await epub.buildEpub({ meta: item.meta, texts, modified: MODIFIED, zipDate: ZIP_DATE });
    assert.equal(sha256(e.buffer), item.epubSha256, 'epub 字节变了：' + item.key);
    assert.equal(e.bytes, item.epubBytes, 'epub 大小变了：' + item.key);
    assert.equal(e.volumeCount, item.epubVolumeCount, 'epub 卷数变了：' + item.key);
    assert.equal(e.chapterCount, item.epubChapterCount, 'epub 章数变了：' + item.key);
  }
});

test('结构闸门：按卷分组只有一处定义，docx / epub 不再各写一份', () => {
  const sources = coreSources();
  const defs = sources.filter((item) => /function groupByVolume\s*\(/.test(item.src)).map((item) => item.name);
  assert.deepEqual(defs, ['exporter.js'], '分组函数只许留在 core/exporter.js：' + defs.join(', '));

  for (const name of ['docx.js', 'epub.js']) {
    const src = sources.find((item) => item.name === name).src;
    assert.equal(/currentVolumeId/.test(src), false, name + ' 里还有自己的一份连续段游标');
    assert.equal(/function groupChapters\s*\(/.test(src), false, name + ' 里还有自己的一份分组函数');
    assert.equal(/volumes\.set\(/.test(src), false, name + ' 里还在自己建卷名表');
    assert.ok(/groupByVolume\(/.test(src), name + ' 要调共用分组函数');
  }
});

test('groupByVolume：全书分组 = 按书目顺序切连续段，空卷名 / 未知卷当无卷', () => {
  const meta = {
    title: '书',
    volumes: [{ id: 'v1', name: ' 上卷 ' }, { id: 'v2', name: '' }],
    chapters: [
      { id: 'a', volumeId: 'v1' },
      { id: 'b', volumeId: 'v1' },
      { id: 'c', volumeId: null },
      { id: 'd', volumeId: 'v2' },
      { id: 'e', volumeId: 'vX' }
    ]
  };
  assert.deepEqual(exporter.groupByVolume(meta), [
    { volumeId: 'v1', name: '上卷', indexes: [0, 1] },
    { volumeId: null, name: '', indexes: [2] },
    { volumeId: 'v2', name: '', indexes: [3] },
    { volumeId: 'vX', name: '', indexes: [4] }
  ]);
});

test('groupByVolume：只对选中下标分组（按卷 / 按范围导出），非法下标丢掉', () => {
  const meta = {
    volumes: [{ id: 'v1', name: '上卷' }, { id: 'v2', name: '下卷' }],
    chapters: [
      { id: 'a', volumeId: 'v1' },
      { id: 'b', volumeId: 'v1' },
      { id: 'c', volumeId: 'v2' },
      { id: 'd', volumeId: 'v2' }
    ]
  };
  assert.deepEqual(exporter.groupByVolume(meta, [0, 1, 3]), [
    { volumeId: 'v1', name: '上卷', indexes: [0, 1] },
    { volumeId: 'v2', name: '下卷', indexes: [3] }
  ]);
  assert.deepEqual(exporter.groupByVolume(meta, [9, -1, '2']), [] , '非法下标不分组');
  assert.deepEqual(exporter.groupByVolume({ chapters: [] }), [], '空书返回空分组');
});
