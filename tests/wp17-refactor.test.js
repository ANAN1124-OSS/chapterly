'use strict';
// WP17（渲染层重构，审计 #20）第 21 轮 · D3 锚点（2026-11-18，HEAD ace4969）：
//   R1 合并算法单份：core/glossary.js 只有 mergeListEntries 一份「去重 + 5000 上限」循环，
//      readGlossaryFiles 调 mergeListEntries(lists, null)，不再内联第二份（D3，审计低 #16）
//   R2 行为保真：撞顶跨 3 份时 entries 顺序 / 每份 truncated 语义与改前一致；
//      enabledLists 子集「按实际参与结算」（#49/E24）不回退
//   R3 极值 × IO 失败注入：3 × 6000 条 + 目录 / 不存在文件同批，不抛错、封顶、坏份只标记
//   R4 对外形状：lists 仍带 entries/ownTruncated/truncated；公开信息剥掉正文；total = entries.length
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const glossary = require('../core/glossary');
const tmpCleanup = require('./tmp-cleanup');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'core', 'glossary.js'), 'utf8');

function functionBody(name) {
  const start = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(SOURCE);
  assert.ok(start, `core/glossary.js 找不到 function ${name}(`);
  const rest = SOURCE.slice(start.index + start[0].length);
  const next = /\n(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

async function mkTmp() {
  return tmpCleanup.track(await fsp.mkdtemp(path.join(os.tmpdir(), 'cw-wp17-')));
}

function manyLines(prefix, amount) {
  return Array.from({ length: amount }, (_value, index) => prefix + index).join('\n') + '\n';
}

test('R1 D3：多份合并只留 mergeListEntries 一份实现，readGlossaryFiles 复用它', () => {
  const readBody = functionBody('readGlossaryFiles');
  assert.equal(
    count(SOURCE, 'for (const entry of own)'),
    1,
    '「去重 + 封顶」循环只许留在 mergeListEntries（readGlossaryFiles 不许内联第二份）'
  );
  assert.equal(count(SOURCE, 'if (seen.has(entry.term)) continue;'), 1, '去重判定只许一份实现');
  assert.equal(
    count(SOURCE, 'entries.push({ term: entry.term, suggestion: entry.suggestion })'),
    1,
    '合并条目只许在一处 push'
  );
  assert.ok(readBody.includes('mergeListEntries(lists, null)'), 'readGlossaryFiles 必须调用 mergeListEntries(lists, null)');
  assert.equal(readBody.includes('seen.add('), false, 'readGlossaryFiles 不许自己维护 seen');
  assert.equal(readBody.includes('entries.push('), false, 'readGlossaryFiles 不许自己 push 合并条目');
});

test('R2 D3：撞顶跨 3 份的 entries / 每份 truncated 与改前一致，子集按实际参与结算', async () => {
  const dir = await mkTmp();
  const first = path.join(dir, '甲.txt');
  const second = path.join(dir, '乙.txt');
  const third = path.join(dir, '丙.txt');
  const many = Array.from({ length: glossary.MAX_ENTRIES - 1 }, (_value, index) => '甲词' + index);
  await fsp.writeFile(first, many.join('\n') + '\n', 'utf8');
  await fsp.writeFile(second, '乙新一\n甲词0\n乙新二\n', 'utf8');
  await fsp.writeFile(third, '乙新一\n丙新一\n丙新二\n丙新三\n', 'utf8');

  const merged = await glossary.readGlossaryFiles([first, second, third]);
  assert.equal(merged.ok, true);
  assert.equal(merged.total, glossary.MAX_ENTRIES);
  assert.equal(merged.entries.length, glossary.MAX_ENTRIES);
  assert.equal(merged.entries[glossary.MAX_ENTRIES - 1].term, '乙新一', '第 5000 条是第二份的第一个新词');
  assert.deepEqual(merged.lists.map((list) => list.count), [glossary.MAX_ENTRIES - 1, 3, 4]);
  assert.deepEqual(
    merged.lists.map((list) => list.truncated),
    [false, true, true],
    '撞顶后还有新词的份也要标 truncated（后续份不许静默丢掉）'
  );
  for (const term of ['乙新二', '丙新一', '丙新二', '丙新三']) {
    assert.equal(merged.entries.some((entry) => entry.term === term), false, `撞顶后 ${term} 不该进来`);
  }

  // #49/E24：只勾第三份 → 4 条全部参与，不能因为前两份把额度占满而误标截断
  const thirdOnly = await glossary.readProofreadWordlistForRequest(
    { proofreadWordlists: [first, second, third] },
    { enabledLists: [2] }
  );
  assert.deepEqual(thirdOnly.entries.map((entry) => entry.term), ['乙新一', '丙新一', '丙新二', '丙新三']);
  assert.equal(thirdOnly.wordList.truncated, false, '子集合并按实际参与结算，不回退到 #49 的旧口径');
});

test('R3 D3：3 × 6000 条 + 目录 / 不存在文件同批——封顶、坏份只标记、不抛错', async () => {
  const dir = await mkTmp();
  const files = ['超甲.txt', '超乙.txt', '超丙.txt'].map((name) => path.join(dir, name));
  for (const [index, file] of files.entries()) {
    await fsp.writeFile(file, manyLines(`超${index}-`, 6000), 'utf8');
  }
  const missing = path.join(dir, '没有这个文件.txt');
  const asDir = path.join(dir, '这是一份目录.txt');
  await fsp.mkdir(asDir);

  const merged = await glossary.readGlossaryFiles([files[0], missing, asDir, files[1], files[2]]);
  assert.equal(merged.ok, true, '有可读份就不该整体失败');
  assert.equal(merged.entries.length, glossary.MAX_ENTRIES);
  assert.equal(merged.total, glossary.MAX_ENTRIES);
  assert.equal(merged.lists.length, 5);
  // count 是「这一份自己读出来的条数」：单文件自身也封顶 5000，所以 6000 行只进来 5000 条。
  assert.equal(merged.lists[0].count, glossary.MAX_ENTRIES);
  assert.equal(merged.lists[0].ownTruncated, true, '单份 6000 条自己的截断要透传');
  assert.equal(merged.lists[0].truncated, true);
  assert.equal(merged.lists[1].ok, false);
  assert.ok(merged.lists[1].error.length > 0, '不存在文件要给可读原因');
  assert.equal(merged.lists[2].ok, false, '目录冒充词表要报错而不是抛');
  assert.ok(merged.lists[2].error.length > 0);
  assert.equal(merged.lists[3].truncated, true, '撞顶后第三份的新词被挡要标 truncated');
  assert.equal(merged.lists[4].truncated, true, '撞顶后第四份的新词被挡要标 truncated');
  assert.equal(new Set(merged.entries.map((entry) => entry.term)).size, glossary.MAX_ENTRIES, '合并后不许有重复词');
});

test('R4 D3：对外形状不变（lists 内部带 entries，公开信息剥掉正文）', async () => {
  const dir = await mkTmp();
  const file = path.join(dir, '形状.txt');
  await fsp.writeFile(file, '做为 => 作为\n禁词\n', 'utf8');

  const bundle = await glossary.readGlossaryFiles([file]);
  assert.deepEqual(Object.keys(bundle).sort(), ['entries', 'lists', 'ok', 'total']);
  assert.equal(bundle.total, bundle.entries.length);
  const one = bundle.lists[0];
  assert.equal(one.ok, true);
  assert.equal(one.count, 2);
  assert.equal(one.truncated, false);
  assert.equal(one.ownTruncated, false);
  assert.deepEqual(one.entries, [
    { term: '做为', suggestion: '作为' },
    { term: '禁词', suggestion: '' }
  ]);

  const info = glossary.publicGlossaryFilesInfo(bundle);
  assert.deepEqual(Object.keys(info.lists[0]).sort(), ['count', 'error', 'ok', 'truncated']);
  assert.equal(info.lists[0].entries, undefined);
  assert.equal(info.lists[0].ownTruncated, undefined);
  assert.equal(info.total, 2);
});