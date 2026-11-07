const test = require('node:test');
const assert = require('node:assert/strict');
const chaptersLib = require('../core/chapters');
const { composeBook } = require('../core/exporter');

function metaWith(volumes, chapters) {
  return { title: '测试书', titleTemplate: '第{num}章：{name}', volumes, chapters };
}

test('分卷：清洗卷列表（去非法项、去重、去首尾空白）', () => {
  const clean = chaptersLib.sanitizeVolumes([
    { id: 'v_001', name: ' 第1卷：单篇 ' },
    { id: 'v_001', name: '重复的' },
    { id: '', name: '没有 id' },
    null,
    '不是对象',
    { id: 'v_002', name: 123 },
    { id: 'v_003' }
  ]);
  assert.deepEqual(clean, [
    { id: 'v_001', name: '第1卷：单篇' },
    { id: 'v_002', name: '' },
    { id: 'v_003', name: '' }
  ]);
  assert.deepEqual(chaptersLib.sanitizeVolumes('not-array'), []);
});

test('分卷：章节顺序归一成「未分卷 → 第1卷 → 第2卷」，组内顺序不变', () => {
  const meta = metaWith(
    [{ id: 'v_001', name: 'A' }, { id: 'v_002', name: 'B' }],
    [
      { id: 'c1', name: '卷一甲', volumeId: 'v_001' },
      { id: 'c2', name: '未分卷甲' },
      { id: 'c3', name: '卷二甲', volumeId: 'v_002' },
      { id: 'c4', name: '卷一乙', volumeId: 'v_001' },
      { id: 'c5', name: '未分卷乙' }
    ]
  );
  const normalized = chaptersLib.normalizeChapterOrder(meta);
  assert.deepEqual(
    normalized.chapters.map((c) => c.id),
    ['c2', 'c5', 'c1', 'c4', 'c3']
  );
  assert.deepEqual(normalized.volumes.map((v) => v.id), ['v_001', 'v_002']);
});

test('分卷：指向不存在卷的章节回落到「未分卷」', () => {
  const meta = metaWith([{ id: 'v_001', name: 'A' }], [
    { id: 'c1', name: '甲', volumeId: 'v_404' },
    { id: 'c2', name: '乙', volumeId: 'v_001' }
  ]);
  const normalized = chaptersLib.normalizeChapterOrder(meta);
  assert.equal(normalized.chapters[0].id, 'c1');
  assert.equal(normalized.chapters[0].volumeId, null);
  assert.equal(normalized.chapters[1].id, 'c2');
});

test('分卷：volumeRank / nextVolumeId', () => {
  const meta = metaWith([{ id: 'v_001', name: 'A' }, { id: 'v_003', name: 'B' }], []);
  assert.equal(chaptersLib.volumeRank(meta, null), 0);
  assert.equal(chaptersLib.volumeRank(meta, 'v_001'), 1);
  assert.equal(chaptersLib.volumeRank(meta, 'v_003'), 2);
  assert.equal(chaptersLib.volumeRank(meta, 'v_404'), 0);
  assert.equal(chaptersLib.nextVolumeId(meta), 'v_002');
  assert.equal(chaptersLib.nextVolumeId(metaWith([], [])), 'v_001');
});

test('分卷：insertIndexForVolume 给出「插到该卷末尾」的下标', () => {
  const meta = metaWith(
    [{ id: 'v_001', name: 'A' }, { id: 'v_002', name: 'B' }],
    [
      { id: 'c1', volumeId: 'v_001' },
      { id: 'c2', volumeId: 'v_001' },
      { id: 'c3', volumeId: 'v_002' },
      { id: 'c4', volumeId: null }
    ]
  );
  assert.equal(chaptersLib.insertIndexForVolume(meta, 'v_001'), 2);
  assert.equal(chaptersLib.insertIndexForVolume(meta, 'v_002'), 3);
  assert.equal(chaptersLib.insertIndexForVolume(meta, null), 4);
  // 空卷：插到下一个卷的第一章之前
  const empty = metaWith([{ id: 'v_001', name: 'A' }, { id: 'v_002', name: 'B' }], [
    { id: 'c1', volumeId: 'v_002' }
  ]);
  assert.equal(chaptersLib.insertIndexForVolume(empty, 'v_001'), 0);
});

test('分卷：crossVolumeTarget 卷尾 → 下一卷卷首，卷首 → 上一卷卷尾（只跨相邻的一个卷）', () => {
  const meta = metaWith(
    [{ id: 'v_001', name: '甲' }, { id: 'v_002', name: '乙' }],
    [
      { id: 'a1', volumeId: 'v_001' },
      { id: 'a2', volumeId: 'v_001' },
      { id: 'b1', volumeId: 'v_002' },
      { id: 'b2', volumeId: 'v_002' }
    ]
  );
  // 甲卷最后一条往下 → 乙卷卷首（插到 b1 之前）
  assert.deepEqual(chaptersLib.crossVolumeTarget(meta, 1, 1), { volumeId: 'v_002', beforeChapterId: 'b1' });
  // 乙卷第一条往上 → 甲卷卷尾（beforeChapterId = null → insertIndexForVolume 落在甲卷最后一章之后）
  assert.deepEqual(chaptersLib.crossVolumeTarget(meta, 2, -1), { volumeId: 'v_001', beforeChapterId: null });
  // 卷里还有同卷的相邻章 = 卷内移动，不在这里接管（渲染层走 stepMoveTarget）
  assert.equal(chaptersLib.crossVolumeTarget(meta, 0, 1), null);
  assert.equal(chaptersLib.crossVolumeTarget(meta, 3, -1), null);
});

test('分卷：crossVolumeTarget 首卷首章 / 末卷末章不动，未分卷与坏卷 id 不参与跨卷', () => {
  const meta = metaWith(
    [{ id: 'v_001', name: '甲' }, { id: 'v_002', name: '乙' }],
    [
      { id: 'u1' }, // 未分卷
      { id: 'a1', volumeId: 'v_001' }, // 首卷首章
      { id: 'b1', volumeId: 'v_002' } // 末卷末章
    ]
  );
  assert.equal(chaptersLib.crossVolumeTarget(meta, 1, -1), null, '首卷首章往上：不动（键盘不把章移出卷）');
  assert.equal(chaptersLib.crossVolumeTarget(meta, 2, 1), null, '末卷末章往下：不动');
  assert.equal(chaptersLib.crossVolumeTarget(meta, 0, -1), null, '未分卷第一条往上：到头');
  assert.equal(chaptersLib.crossVolumeTarget(meta, 0, 1), null, '未分卷最后一条往下：不跨进卷');
  // 坏卷 id（卷已被删）按未分卷算：既不从它跨出去，也不把它当目标卷
  const badMeta = metaWith([{ id: 'v_001', name: '甲' }], [
    { id: 'bad', volumeId: 'v_404' },
    { id: 'a1', volumeId: 'v_001' }
  ]);
  assert.equal(chaptersLib.crossVolumeTarget(badMeta, 0, 1), null);
  assert.equal(chaptersLib.crossVolumeTarget(badMeta, 1, -1), null);
});

test('分卷：crossVolumeTarget 把空卷也算一步（不跳过），坏参数一律 null', () => {
  const meta = metaWith(
    [{ id: 'v_001', name: '甲' }, { id: 'v_002', name: '空卷' }, { id: 'v_003', name: '丙' }],
    [
      { id: 'a1', volumeId: 'v_001' },
      { id: 'c1', volumeId: 'v_003' }
    ]
  );
  // 甲卷卷尾往下 → 进相邻的空卷（不是直接跳进丙卷）；丙卷卷首往上同样只回到空卷卷尾
  assert.deepEqual(chaptersLib.crossVolumeTarget(meta, 0, 1), { volumeId: 'v_002', beforeChapterId: null });
  assert.deepEqual(chaptersLib.crossVolumeTarget(meta, 1, -1), { volumeId: 'v_002', beforeChapterId: null });
  // 卷尾之后是空卷（全书最后一条也还不在末卷）：仍能跨进去
  const tail = metaWith([{ id: 'v_001', name: '甲' }, { id: 'v_002', name: '空卷' }], [
    { id: 'a1', volumeId: 'v_001' }
  ]);
  assert.deepEqual(chaptersLib.crossVolumeTarget(tail, 0, 1), { volumeId: 'v_002', beforeChapterId: null });
  assert.equal(chaptersLib.crossVolumeTarget(tail, 0, -1), null, '首卷第一条往上：到头');
  // 方向只看符号（和 stepMoveTarget 同口径）
  assert.deepEqual(chaptersLib.crossVolumeTarget(meta, 0, 2), { volumeId: 'v_002', beforeChapterId: null });
  // 坏参数
  assert.equal(chaptersLib.crossVolumeTarget(meta, 0, 0), null);
  assert.equal(chaptersLib.crossVolumeTarget(meta, -1, 1), null);
  assert.equal(chaptersLib.crossVolumeTarget(meta, 9, 1), null);
  assert.equal(chaptersLib.crossVolumeTarget(meta, NaN, 1), null);
  assert.equal(chaptersLib.crossVolumeTarget(metaWith([], []), 0, 1), null, '没有分卷的书：不跨卷');
  assert.equal(chaptersLib.crossVolumeTarget(null, 0, 1), null);
});

test('导出：有分卷时每卷前多输出一行卷名', () => {
  const meta = metaWith(
    [{ id: 'v_001', name: '第1卷：单篇' }, { id: 'v_002', name: '第2卷：合集' }],
    [
      { id: 'c1', file: '1.txt', name: '起风', volumeId: 'v_001' },
      { id: 'c2', file: '2.txt', name: '夜雨', volumeId: 'v_001' },
      { id: 'c3', file: '3.txt', name: '灯塔', volumeId: 'v_002' }
    ]
  );
  assert.equal(
    composeBook(meta, ['甲', '乙', '丙']),
    '第1卷：单篇\r\n\r\n第1章：起风\r\n\r\n甲\r\n\r\n第2章：夜雨\r\n\r\n乙\r\n\r\n' +
      '第2卷：合集\r\n\r\n第3章：灯塔\r\n\r\n丙\r\n'
  );
});

test('导出：未分卷章节在前，没有卷名行；没有分卷的书和以前完全一致', () => {
  const withVolumes = metaWith([{ id: 'v_001', name: '第1卷' }], [
    { id: 'c1', file: '1.txt', name: '序', volumeId: null },
    { id: 'c2', file: '2.txt', name: '正文', volumeId: 'v_001' }
  ]);
  assert.equal(
    composeBook(withVolumes, ['甲', '乙']),
    '第1章：序\r\n\r\n甲\r\n\r\n第1卷\r\n\r\n第2章：正文\r\n\r\n乙\r\n'
  );
  const plain = metaWith([], [
    { id: 'c1', file: '1.txt', name: '起风' },
    { id: 'c2', file: '2.txt', name: '夜雨' }
  ]);
  assert.equal(composeBook(plain, ['甲', '乙']), '第1章：起风\r\n\r\n甲\r\n\r\n第2章：夜雨\r\n\r\n乙\r\n');
});

test('分卷：moveVolume 调整卷序，章节跟着卷走、组内顺序不变', () => {
  const meta = metaWith(
    [{ id: 'v_001', name: 'A' }, { id: 'v_002', name: 'B' }],
    [
      { id: 'a1', name: 'A1', volumeId: 'v_001' },
      { id: 'b1', name: 'B1', volumeId: 'v_002' },
      { id: 'a2', name: 'A2', volumeId: 'v_001' },
      { id: 'b2', name: 'B2', volumeId: 'v_002' }
    ]
  );
  const moved = chaptersLib.moveVolume(meta, 'v_002', 0);
  assert.equal(moved.moved, true);
  assert.deepEqual(moved.meta.volumes.map((v) => v.id), ['v_002', 'v_001']);
  assert.deepEqual(moved.meta.chapters.map((c) => c.id), ['b1', 'b2', 'a1', 'a2']);
  // 越界 / 不存在的卷：不动
  assert.equal(chaptersLib.moveVolume(meta, 'v_001', 0).moved, false);
  assert.equal(chaptersLib.moveVolume(meta, 'v_404', 0).moved, false);
});
