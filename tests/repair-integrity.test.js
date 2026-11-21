// WP8（X-N3 / X-N4 / X-N5）：从目录重建的章序 / 从 .bak 恢复的前置校验 / 修复回退重试。
//
// 口径来自 2026-11-17 审计：
//   X-N3：导入侧明文接受的章节文件名形态（纯数字 / 序号+分隔符 / 第X章 / Chapter N / 楔子…）
//         重建侧只认 NNN- 一种，其余按 localeCompare 字典序拿到 index+1 当序号 —— 章序错、
//         纯数字文件的章名变裸数字。
//   X-N4：restoreFromBak 只判「chapters 是数组」就写盘报成功，跳过读取侧的逐条校验 / 20000
//         上限 / 缺重 id 清洗 —— .bak 条目坏时「恢复成功」但书依旧打不开。
//   X-N5：正向 temp→书目 走 renameWithRetry，失败回退归档→原名是裸 rename —— 同一类占用
//         同样挡回退，坏书目回不到原名、书架看不见书。
// 先写本文件、跑真红，再改 core 转绿（见作业卡 §4/§10）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const storage = require('../core/storage');
const repair = require('../core/repair');

const tmpCleanup = require('./tmp-cleanup');

// TB-02：临时目录统一经 tests/tmp-cleanup.js 的 mkTmp（mkdtemp + 登记回收）。
const mkTmp = (prefix = 'cw-wp8-') => tmpCleanup.mkTmp(prefix);

async function mkBook(root, name) {
  const bookPath = path.join(root, name);
  await fs.mkdir(bookPath, { recursive: true });
  return bookPath;
}

async function writeTxts(bookPath, files) {
  await fs.mkdir(bookPath, { recursive: true });
  for (const file of files) await fs.writeFile(path.join(bookPath, file), `${file} 的正文`, 'utf8');
}

// 恢复失败时必须「一个字节都不动」：坏书目还在原位、没有归档、没有临时文件。
async function assertUntouched(bookPath, metaText, bakText) {
  const names = await fs.readdir(bookPath);
  assert.equal(
    names.some((name) => name.startsWith(storage.CORRUPT_PREFIX)),
    false,
    '校验不过时不许归档坏书目（否则用户连原文件都没了）'
  );
  assert.equal(names.some((name) => name.startsWith('.repair-meta')), false, '失败时不许留临时文件');
  assert.equal(await fs.readFile(path.join(bookPath, storage.BOOK_FILE), 'utf8'), metaText, '坏书目逐字节不动');
  assert.equal(await fs.readFile(path.join(bookPath, storage.BOOK_BAK), 'utf8'), bakText, '.bak 逐字节不动');
}

test('R1（X-N3）：1.txt…12.txt 重建章序 = 数值序，章名不再是裸数字', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '纯数字章节目录');
  // 写入顺序打乱（目录 readdir 顺序与 localeCompare 字典序都不可依赖）
  await writeTxts(bookPath, ['10.txt', '2.txt', '1.txt', '12.txt', '11.txt', '3.txt', '4.txt', '5.txt', '6.txt', '7.txt', '8.txt', '9.txt']);
  await fs.writeFile(path.join(bookPath, storage.BOOK_FILE), '{ 坏掉的旧书目', 'utf8');

  const res = await repair.rebuildFromFiles(bookPath);
  assert.equal(res.count, 12);
  assert.deepEqual(
    res.meta.chapters.map((c) => c.file),
    ['1.txt', '2.txt', '3.txt', '4.txt', '5.txt', '6.txt', '7.txt', '8.txt', '9.txt', '10.txt', '11.txt', '12.txt'],
    '「1.txt…12.txt」重建后必须按数值序排（旧实现按 localeCompare：1,10,11,12,2…）'
  );
  assert.deepEqual(
    res.meta.chapters.map((c) => c.name),
    new Array(12).fill(''),
    '纯数字文件名的章名不能是裸数字串（空名由界面显示「第N章」）'
  );
  assert.equal(res.meta.fileSeq, 12, 'fileSeq 仍是最大序号（下一章 013 起）');
  const meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters.length, 12, '重建出的书目能被读取侧打开');
});

test('R2（X-N3）：第一章…第十章 重建章序 = 中文数序（十 / 二十 也要解析）', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '中文章节');
  // 写入顺序故意打乱；混入「第二十章」钉住「十 / 二十」的解析
  await writeTxts(bookPath, [
    '第十章.txt',
    '第二章.txt',
    '第一章.txt',
    '第二十章.txt',
    '第十一章.txt',
    '第九章.txt'
  ]);
  await fs.writeFile(path.join(bookPath, storage.BOOK_FILE), '{ 坏', 'utf8');

  const res = await repair.rebuildFromFiles(bookPath);
  assert.deepEqual(
    res.meta.chapters.map((c) => c.file),
    ['第一章.txt', '第二章.txt', '第九章.txt', '第十章.txt', '第十一章.txt', '第二十章.txt'],
    '「第X章」重建后按中文数序（旧实现按拼音序：二 / 九 / 三 / 十 / 一）'
  );
  // 带标题的中文序号名保留完整标题，不被拆成裸数字
  const meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.chapters[0].name, '第一章');
});

test('R3（X-N3）：重建形态与导入接受形态对齐；不可解析的标题稳定排在带号章之后', async () => {
  const root = await mkTmp();
  const bookPath = path.join(root, '形态对齐');
  await writeTxts(bookPath, [
    '楔子.txt',
    '第2章 夜雨.txt',
    '12_卷名.txt',
    '001-起风.txt',
    'Chapter 3 归途.txt',
    '1.txt',
    '1984.txt',
    '第3话 侧记.txt'
  ]);
  await fs.writeFile(path.join(bookPath, storage.BOOK_FILE), '{ 坏', 'utf8');

  const res = await repair.rebuildFromFiles(bookPath);
  assert.deepEqual(
    res.meta.chapters.map((c) => c.file),
    [
      '001-起风.txt',
      '1.txt',
      '第2章 夜雨.txt',
      '第3话 侧记.txt',
      'Chapter 3 归途.txt',
      '12_卷名.txt',
      '1984.txt',
      '楔子.txt'
    ],
    '带号章按 seq 升序（同 seq 按文件名稳定排序），未编号章稳定排在最后'
  );
  assert.deepEqual(res.meta.chapters.map((c) => c.name), [
    '起风', // 001-起风：序号 + 分隔符形态，名 = 分隔符后正文（老行为不变）
    '', // 1.txt：纯数字形态，章名不取裸数字
    '第2章 夜雨', // 第X章形态：保留完整标题
    '第3话 侧记',
    'Chapter 3 归途',
    '卷名', // 12_卷名：分隔符后正文
    '1984', // 不是章节序号（4 位纯数字 = 年份 / 书名），原样留名
    '楔子'
  ]);
  assert.equal(res.meta.fileSeq, 12, 'fileSeq 取最大带号序号（第 3 话 / Chapter 也参与）');
});

test('R4（X-N4）：坏 .bak（[null] / 缺 file / chapters 非数组 / 超 20000 章）→ BAK_INVALID，一个字节都不写', async () => {
  const root = await mkTmp();
  const cases = [
    { label: '条目是 null', meta: { title: '坏备份', chapters: [null] } },
    { label: '缺 file 字段', meta: { title: '坏备份', chapters: [{ id: 'ch_001', name: '起风' }] } },
    { label: 'chapters 不是数组', meta: { title: '坏备份', chapters: '坏值' } },
    {
      label: '章节超过 20000 条',
      meta: {
        title: '坏备份',
        chapters: Array.from({ length: 20001 }, (_, i) => ({ id: `ch_${i}`, file: `${i}.txt` }))
      }
    }
  ];
  for (const item of cases) {
    const bookPath = await mkBook(root, `坏备份-${item.label.replace(/[\\/:*?"<>|]/g, '_')}`);
    const metaText = '{ 主文件也坏';
    await fs.writeFile(path.join(bookPath, storage.BOOK_FILE), metaText, 'utf8');
    const bakText = JSON.stringify(item.meta);
    await fs.writeFile(path.join(bookPath, storage.BOOK_BAK), bakText, 'utf8');

    await assert.rejects(
      () => repair.restoreFromBak(bookPath),
      (err) => err.code === 'BAK_INVALID' && /只能从目录重建/.test(err.message),
      `${item.label}：读取侧会判坏的书目，恢复必须先报 BAK_INVALID（不许虚假成功）`
    );
    await assertUntouched(bookPath, metaText, bakText);
  }
});

test('R8（复核缺口 / WP8 补漏）：BAK_INVALID 保留具体原因（形状 / 章数上限 / 解析），错误码不变', async () => {
  const root = await mkTmp();
  const cases = [
    {
      label: 'chapters 不是数组',
      meta: { title: '坏备份', chapters: '坏值' },
      expect: /缺少 chapters 数组/
    },
    {
      label: '章节超过 20000 条',
      meta: {
        title: '坏备份',
        chapters: Array.from({ length: 20001 }, (_, i) => ({ id: `ch_${i}`, file: `${i}.txt` }))
      },
      expect: /20001.*20000|超过单本上限/
    },
    { label: '无法解析', raw: '{ 坏', expect: /无法解析/ }
  ];
  for (const item of cases) {
    const bookPath = await mkBook(root, `原因-${item.label.replace(/[\\/:*?"<>|]/g, '_')}`);
    await fs.writeFile(path.join(bookPath, storage.BOOK_FILE), '{ 主文件也坏', 'utf8');
    const bakText = item.raw !== undefined ? item.raw : JSON.stringify(item.meta);
    await fs.writeFile(path.join(bookPath, storage.BOOK_BAK), bakText, 'utf8');
    await assert.rejects(
      () => repair.restoreFromBak(bookPath),
      (err) => {
        assert.equal(err.code, 'BAK_INVALID', '错误码不变（界面按 code 分支）');
        assert.match(err.message, /只能从目录重建/, '保留现有可照做的收尾文案');
        assert.match(err.message, item.expect, `${item.label}：要保留具体原因，别只剩一句「结构不完整」`);
        return true;
      }
    );
  }
});

test('R5（X-N4）：.bak 章条缺 id / 重复 id → 恢复成功，落盘书目 id 已清洗且可直接读取', async () => {
  const root = await mkTmp();
  const bookPath = await mkBook(root, '恢复要清洗 id');
  await fs.writeFile(path.join(bookPath, storage.BOOK_FILE), '{ 坏', 'utf8');
  const bakMeta = {
    title: '恢复要清洗 id',
    chapters: [
      { file: '001-起风.txt', name: '起风' }, // 缺 id
      { id: 'ch_dup', file: '002-夜雨.txt', name: '夜雨' }, // 重复 id
      { id: 'ch_dup', file: '003-收束.txt', name: '收束' }, // 重复 id
      { id: '', file: '004-尾声.txt', name: '尾声' } // 空 id
    ]
  };
  const bakText = JSON.stringify(bakMeta);
  await fs.writeFile(path.join(bookPath, storage.BOOK_BAK), bakText, 'utf8');

  const res = await repair.restoreFromBak(bookPath);
  assert.equal(res.meta.chapters.length, 4);
  // 落盘的字节里 id 必须已经补齐 / 去重（旧实现原样写盘：读取侧才补，文件里仍是缺 / 重 id）
  const saved = JSON.parse(await fs.readFile(path.join(bookPath, storage.BOOK_FILE), 'utf8'));
  const ids = saved.chapters.map((c) => c.id);
  assert.ok(ids.every((id) => typeof id === 'string' && id), `恢复后的书目每条章 id 都必须非空：${JSON.stringify(ids)}`);
  assert.equal(new Set(ids).size, ids.length, `恢复后的章 id 必须唯一：${JSON.stringify(ids)}`);
  // 「恢复成功」的书必须能被读取侧直接打开
  const readBack = await storage.readBookMeta(bookPath);
  assert.equal(readBack.chapters.length, 4);
  assert.equal(new Set(readBack.chapters.map((c) => c.id)).size, 4);
  // .bak 一个字节都不动
  assert.equal(await fs.readFile(path.join(bookPath, storage.BOOK_BAK), 'utf8'), bakText);
});

test('R6（X-N5）：回退（归档→原名）也按 renameWithRetry 重试；重试成功不误报回退失败', async () => {
  const root = await mkTmp();
  const bookPath = await mkBook(root, '回退要重试');
  const metaPath = path.join(bookPath, storage.BOOK_FILE);
  const metaText = '{ 坏掉的旧书目';
  await fs.writeFile(metaPath, metaText, 'utf8');
  await fs.writeFile(
    path.join(bookPath, storage.BOOK_BAK),
    JSON.stringify({ title: '回退要重试', chapters: [{ id: 'ch_001', file: '001-起风.txt' }] }),
    'utf8'
  );

  const attempts = { forward: 0, rollback: 0 };
  const logged = [];
  const err = await repair
    .restoreFromBak(bookPath, {
      logError: (kind, error, extra) => logged.push({ kind, error, extra }),
      rename: async (from, to) => {
        const base = path.basename(from);
        if (to === metaPath && base === '.repair-meta.json') {
          attempts.forward += 1;
          const e = new Error('操作被系统拒绝');
          e.code = 'EPERM';
          throw e;
        }
        if (to === metaPath && base.startsWith(`${storage.BOOK_FILE}.corrupt-`)) {
          attempts.rollback += 1;
          // 前两次模拟杀毒 / 同步盘占用，第三次放开
          if (attempts.rollback < 3) {
            const e = new Error('操作被系统拒绝');
            e.code = 'EPERM';
            throw e;
          }
          return fs.rename(from, to);
        }
        return fs.rename(from, to);
      }
    })
    .then(
      () => null,
      (e) => e
    );

  assert.ok(err, '正向改名 3 次 EPERM 用尽后必须把原始错误抛给调用方');
  assert.equal(err.code, 'EPERM');
  assert.equal(attempts.forward, 3, '正向 temp → 书目 走 renameWithRetry（3 次）');
  assert.equal(attempts.rollback, 3, '回退也要走 renameWithRetry（旧实现裸 rename：这里会是 0）');
  assert.equal(logged.length, 0, '回退第 3 次成功，不许记「回退失败」日志');
  assert.equal(await fs.readFile(metaPath, 'utf8'), metaText, '坏书目必须回到原名（书架还看得见这本书）');
  const names = await fs.readdir(bookPath);
  assert.equal(names.some((name) => name.startsWith(storage.CORRUPT_PREFIX)), false, '回退成功后不留归档');
  assert.equal(names.some((name) => name.startsWith('.repair-meta')), false, '临时文件要清掉');
});

test('R7（极值 × IO 失败注入）：含空格与中文的书目录下，坏 .bak 不写盘、好 .bak 恢复成功且 .bak 不动', async () => {
  const root = await mkTmp();
  const bookPath = await mkBook(root, '修复 书 空格');
  const metaText = '{ 坏';
  const bakText = JSON.stringify({ title: '空格书', chapters: [null] });
  await fs.writeFile(path.join(bookPath, storage.BOOK_FILE), metaText, 'utf8');
  await fs.writeFile(path.join(bookPath, storage.BOOK_BAK), bakText, 'utf8');

  await assert.rejects(
    () => repair.restoreFromBak(bookPath),
    (err) => err.code === 'BAK_INVALID',
    '含空格路径 + 坏条目 .bak：先校验再碰盘'
  );
  await assertUntouched(bookPath, metaText, bakText);

  // 同一个含空格目录换成合法 .bak：恢复成功，.bak 逐字节不动
  const goodBak = JSON.stringify({
    title: '空格书',
    chapters: [{ id: 'ch_001', file: '001-起风.txt', name: '起风' }]
  });
  await fs.writeFile(path.join(bookPath, storage.BOOK_BAK), goodBak, 'utf8');
  const res = await repair.restoreFromBak(bookPath);
  assert.equal(res.meta.title, '空格书');
  assert.equal(await fs.readFile(path.join(bookPath, storage.BOOK_BAK), 'utf8'), goodBak, '.bak 一个字节都不动');
  assert.ok((await fs.readdir(bookPath)).some((name) => name.startsWith(storage.CORRUPT_PREFIX)), '好 .bak 恢复：坏书目归档留证');
  const meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.title, '空格书');
});