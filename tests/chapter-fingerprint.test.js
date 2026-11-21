// TESTC-04：core/chapter-fingerprint.js 的直接单测。
//
// 这个指纹有两个消费者（搜索索引的每章 contentHash、保存守卫的「载入那一版 vs 现在磁盘」），
// 口径必须永远一致；以前只有 save-preconditions 的注释声明「唯一实现」，没有直接锚点。
// 这里钉住格式、采样范围、可见性（首 / 尾改动能发现）与文件头声明的盲区（只改中段不发现）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const { chapterContentHashOf } = require('../core/chapter-fingerprint');
const tmpCleanup = require('./tmp-cleanup');

const SAMPLE = 4096;

async function writeTemp(content) {
  const dir = await tmpCleanup.mkTmp('cw-fingerprint-');
  const file = path.join(dir, 'chapter.txt');
  await fs.writeFile(file, content);
  return { dir, file };
}

test('指纹格式：字节数:首段 8 位:尾段 8 位（小写十六进制补零），同内容稳定、不同内容不同', async () => {
  const { file } = await writeTemp('一二三四五');
  const size = (await fs.stat(file)).size;
  const hash = await chapterContentHashOf(file, size);
  assert.match(hash, new RegExp(`^${size}:[0-9a-f]{8}:[0-9a-f]{8}$`), `格式不对：${hash}`);
  assert.equal(await chapterContentHashOf(file, size), hash, '同内容同大小必须给出同一指纹');

  const other = await writeTemp('一二三四六');
  const otherSize = (await fs.stat(other.file)).size;
  assert.notEqual(await chapterContentHashOf(other.file, otherSize), hash, '末字节不同必须换指纹');
});

test('指纹只读首尾各 4 KB：首段 / 尾段改动都变；只改中段（保留 size）不变 —— 文件头声明的盲区', async () => {
  const head = 'A'.repeat(SAMPLE);
  const middle = 'M'.repeat(SAMPLE);
  const tail = 'Z'.repeat(SAMPLE);
  const content = head + middle + tail;
  const { file } = await writeTemp(content);
  const size = Buffer.byteLength(content);
  const before = await chapterContentHashOf(file, size);

  // 首段改一个字节
  const headChanged = 'B' + content.slice(1);
  await fs.writeFile(file, headChanged);
  const afterHead = await chapterContentHashOf(file, size);
  assert.notEqual(afterHead, before, '首 4 KB 内的改动必须被发现');

  // 尾段改一个字节
  const tailChanged = content.slice(0, content.length - 1) + 'Y';
  await fs.writeFile(file, tailChanged);
  const afterTail = await chapterContentHashOf(file, size);
  assert.notEqual(afterTail, before, '尾 4 KB 内的改动必须被发现');

  // 只改中段、size 与读写窗口都不变 → 指纹不变（已知盲区，见文件头）
  const midChanged = head + ('N' + middle.slice(1)) + tail;
  await fs.writeFile(file, midChanged);
  assert.equal(await chapterContentHashOf(file, size), before, '中段改动不改变首尾采样（设计取舍，必须如实钉住）');
});

test('短文件 / 空文件 / 读不到：不抛，按实际字节算，读不到回空串', async () => {
  const short = await writeTemp('abc');
  assert.match(await chapterContentHashOf(short.file, 3), /^3:[0-9a-f]{8}:[0-9a-f]{8}$/);

  const empty = await writeTemp('');
  assert.match(await chapterContentHashOf(empty.file, 0), /^0:[0-9a-f]{8}:[0-9a-f]{8}$/);

  // 文件不存在 / 权限问题：调用方按「这次没有指纹」处理，不许抛
  const missing = path.join(short.dir, '不存在.txt');
  assert.equal(await chapterContentHashOf(missing, 10), '');
  // size 传入脏值（负数 / 非数字）等同 0，不抛
  assert.equal(await chapterContentHashOf(short.file, -5), await chapterContentHashOf(short.file, 0));
});
