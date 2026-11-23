'use strict';

// WP14 · 正确性边界低批（C6 / C7 / C8 / C9 / C10 / X-N7）的锚点。
//
// 这些条目都是「低优先级但会静默错」的小口径：
//   C6  重复用词窗口「整词容纳」与「起点容纳」两套口径 → 恰好压线漏报；
//   C7  sanitizeRange 把坏 volumeId 置 null、mode 仍是 volume → 导出「未分卷章节集」；
//   C8  文件入口跳过「超长建议」整条、数组入口留词 → 同一行两条入口覆盖不同；
//   C9  剪贴板空读数不推进基准 → A→清空→A 漏记一次复制；
//   C10 书籍信息不清控制字符 + tags.join('\u0000') 判等 → NUL 碰撞静默不写盘；
//   X-N7 lastBook.at 无上限 → 远未来时间戳让后续记录全判 stale。
//
// 先跑真红（实现未动）再改实现，见作业卡 §9.1 / §9.2。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const proofread = require('../core/proofread');
const ipcLimits = require('../core/ipc-limits');
const exporter = require('../core/exporter');
const glossary = require('../core/glossary');
const watchLib = require('../core/clipboard-watch');
const bookInfo = require('../core/bookinfo');
const storage = require('../core/storage');
const config = require('../core/config');
const { writeJsonAtomic } = require('../core/atomic');
const tmpCleanup = require('./tmp-cleanup');

const ROOT = path.join(__dirname, '..');
const readUtf8 = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

// TB-02：临时目录统一经 tests/tmp-cleanup.js 的 mkTmp（mkdtemp + 登记回收）。
const mkTmp = (prefix) => tmpCleanup.mkTmp(prefix);

// ---------- C6 重复用词窗口 ----------

// 用汉字区里不会撞上「突然」的字铺底，再把「突然」摆到指定起点（码点）。
function textWithRepeatStarts(starts, length) {
  const chars = [];
  for (let i = 0; i < length; i += 1) {
    chars.push(String.fromCharCode(0x4e00 + ((i * 97) % 900)));
  }
  for (const start of starts) {
    chars[start] = '突';
    chars[start + 1] = '然';
  }
  return chars.join('');
}

function suddenHits(text, repeatWindow = 300) {
  return proofread
    .proofreadText(text, { repeatWindow, repeatCount: 3 })
    .issues.filter((issue) => issue.rule === 'repeat-word' && issue.match === '突然');
}

test('R1/C6：重复用词按起点口径判窗口——起 0/100/299（窗口 300）必须报 3 次', () => {
  // 旧实现：occ[j] + 2 - start <= window → 299 + 2 = 301 > 300，整条漏报；
  // 但三个起点 0/100/299 都落在 [0, 300)，与消息「在 300 字内出现 3 次」一致。
  const hits = suddenHits(textWithRepeatStarts([0, 100, 299], 301));
  assert.equal(hits.length, 1, '压线 299 的第三次出现必须入窗');
  assert.equal(hits[0].count, 3);
  assert.equal(hits[0].index, 0);
  assert.equal(hits[0].window, 300);
  assert.equal(hits[0].message, '「突然」在 300 字内出现 3 次');
});

test('R1/C6：299/300/301 三个边界——299 报、300 不报、301 不报', () => {
  assert.equal(suddenHits(textWithRepeatStarts([0, 100, 298], 301)).length, 1, '298 在窗内');
  assert.equal(suddenHits(textWithRepeatStarts([0, 100, 299], 302)).length, 1, '299 是最后一个可报起点');
  assert.equal(suddenHits(textWithRepeatStarts([0, 100, 300], 302)).length, 0, '起点 300 = 窗口外');
  assert.equal(suddenHits(textWithRepeatStarts([0, 100, 301], 303)).length, 0, '起点 301 = 窗口外');
});

test('R1/C6：既有已报案例（0/150/298）结果不变', () => {
  const hits = suddenHits(textWithRepeatStarts([0, 150, 298], 301));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].count, 3);
  assert.equal(hits[0].index, 0);
});

// ---------- C7 导出范围 volumeId 降级 ----------

function twelveChapterMeta() {
  const chapters = [];
  for (let i = 0; i < 12; i += 1) {
    const volumeId = i < 2 ? null : i < 6 ? 'vol_1' : 'vol_2';
    chapters.push({ id: `ch_${i}`, file: `000${i}.txt`, name: `第${i + 1}章`, volumeId });
  }
  return {
    title: '范围契约书',
    chapters,
    volumes: [
      { id: 'vol_1', name: '卷一' },
      { id: 'vol_2', name: '卷二' }
    ]
  };
}

test('R2/C7：坏 volumeId（数字 / 超长 / 对象）降级全书，合法缺省仍是「未分卷」', () => {
  for (const bad of [42, { id: 'vol_1' }, 'v'.repeat(201), ['vol_1']]) {
    const safe = ipcLimits.sanitizeRange({ mode: 'volume', volumeId: bad });
    assert.deepEqual(safe, { mode: 'all', from: null, to: null, volumeId: null }, `坏 volumeId ${JSON.stringify(bad)} 必须降级全书`);
  }
  // 缺省 / null / undefined 是合法的「未分卷」，不是坏值
  for (const missing of [null, undefined]) {
    assert.deepEqual(ipcLimits.sanitizeRange({ mode: 'volume', volumeId: missing }), {
      mode: 'volume', from: null, to: null, volumeId: null
    });
  }
  // 合法字符串原样保留（恰好 200 字也算合法长度）
  assert.equal(ipcLimits.sanitizeRange({ mode: 'volume', volumeId: 'vol_1' }).volumeId, 'vol_1');
  assert.equal(ipcLimits.sanitizeRange({ mode: 'volume', volumeId: 'v'.repeat(200) }).volumeId, 'v'.repeat(200));
});

test('R2/C7：与真实 exporter 拼起来——坏 id 导出全书，null 只导未分卷', () => {
  const meta = twelveChapterMeta();
  const all = exporter.resolveExportRange(meta, ipcLimits.sanitizeRange({ mode: 'volume', volumeId: 42 }));
  assert.deepEqual([all.mode, all.count, all.label], ['all', 12, '全书'], '坏 id 不能悄悄变成未分卷章节集');

  const unvolumed = exporter.resolveExportRange(meta, ipcLimits.sanitizeRange({ mode: 'volume', volumeId: null }));
  assert.deepEqual([unvolumed.mode, unvolumed.count, unvolumed.label], ['volume', 2, '未分卷']);

  const named = exporter.resolveExportRange(meta, ipcLimits.sanitizeRange({ mode: 'volume', volumeId: 'vol_1' }));
  assert.deepEqual([named.mode, named.count, named.label], ['volume', 4, '卷一']);
});

// ---------- C8 词表两条入口 ----------

test('R3/C8：超长建议在文件 / 数组两条入口都按「单行超长跳过」整条跳过', () => {
  const longSuggestion = '建'.repeat(101);
  const fromFile = glossary.parseGlossary(`短 => ${longSuggestion}`);
  assert.deepEqual(fromFile.entries, [], '文件入口：超长建议整条跳过');
  assert.equal(fromFile.stats.tooLong, 1);

  const fromArray = glossary.sanitizeEntries([{ term: '短', suggestion: longSuggestion }]);
  assert.deepEqual(fromArray, [], '数组入口必须与文件入口一致：整条跳过（旧实现留词丢建议）');

  // 词本身超长：两处都跳过
  assert.deepEqual(glossary.parseGlossary('长'.repeat(101)).entries, []);
  assert.deepEqual(glossary.sanitizeEntries([{ term: '长'.repeat(101), suggestion: '' }]), []);

  // 正常词条两条入口结果等价（建议只在显示时用）
  const goodFile = glossary.parseGlossary(' 做为 => 作为 \n禁词');
  const goodArray = glossary.sanitizeEntries([
    { term: ' 做为 ', suggestion: ' 作为 ' },
    { term: '禁词', suggestion: '  ' }
  ]);
  assert.deepEqual(goodFile.entries, goodArray);
  assert.deepEqual(goodFile.entries, [
    { term: '做为', suggestion: '作为' },
    { term: '禁词', suggestion: '' }
  ]);
});

// ---------- C9 剪贴板空读基线 ----------

test('R4/C9：A → 清空剪贴板 → 再复制 A，第三条必须照常记入队列', () => {
  const watcher = watchLib.createWatcher({ minChars: 20, now: () => 1000 });
  watcher.enable('A');
  const empty = watcher.evaluate('');
  assert.deepEqual(empty, { changed: false, record: false, notify: false, chars: 0, reason: 'empty' });
  const again = watcher.evaluate('A');
  assert.equal(again.changed, true, '空读数推进基准后，第二次 A 是「新复制」');
  assert.equal(again.record, true, '每次复制各记一条');
  assert.equal(again.notify, false, '短文本仍只压提示');
});

test('R4/C9：非字符串读数同样推进基准；纯空白 / 未变 / 关闭的既有口径不变', () => {
  const watcher = watchLib.createWatcher({ minChars: 20, now: () => 1000 });
  watcher.enable('A');
  assert.equal(watcher.evaluate(null).reason, 'empty');
  assert.equal(watcher.evaluate(undefined).reason, 'empty');
  assert.equal(watcher.evaluate('A').record, true, 'null / undefined 读数不更新基准时这里会漏记');

  const blankWatcher = watchLib.createWatcher({ minChars: 20, now: () => 1000 });
  blankWatcher.enable('A');
  const blank = blankWatcher.evaluate('   \n  ');
  assert.equal(blank.reason, 'blank');
  assert.equal(blank.record, false);
  assert.equal(blankWatcher.evaluate('   \n  ').reason, 'unchanged');
  assert.equal(blankWatcher.evaluate('A').record, true);

  const disabled = watchLib.createWatcher({ now: () => 1000 });
  assert.equal(disabled.evaluate('A').reason, 'disabled');
  disabled.enable('A');
  assert.equal(disabled.evaluate('A').reason, 'unchanged');
});

// ---------- C10 书籍信息控制字符 / 判等 ----------

test('R5/C10：书籍信息清洗剔控制字符与 bidi，brief 保留换行', () => {
  assert.equal(bookInfo.sanitizeAuthor('张\u0000三\u202E'), '张三');
  assert.equal(bookInfo.sanitizeTag('a\u0000b\u200Fc'), 'abc');
  assert.equal(bookInfo.sanitizeGroup('玄幻\u0007'), '玄幻');
  assert.equal(bookInfo.sanitizeBrief('第一行\u0000\r\n\r\n第二行\u202D'), '第一行\n\n第二行');
  // 正常字符（空格 / 标点 / 汉字）一律保留
  assert.equal(bookInfo.sanitizeAuthor(' 张 三！ '), '张 三！');
});

test('R5/C10：tags 逐元素判等，不再用 join(\\u0000) 制造碰撞', () => {
  assert.equal(bookInfo.sameBookInfo({ tags: ['a', 'b'] }, { tags: ['a\u0000b'] }), false);
  assert.equal(bookInfo.sameBookInfo({ tags: ['a', 'b'] }, { tags: ['a', 'b'] }), true);
  assert.equal(bookInfo.sameBookInfo({ tags: ['a'] }, { tags: ['a', 'b'] }), false);
  // 源码闸门：碰撞的根源（NUL 连接）必须真的删掉，而不是只靠上游清洗
  // （先剥注释：注释里还保留着对旧实现的说明）。
  const source = readUtf8('core/bookinfo.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/tags\.join\('\\u0000'\)/.test(source), false, 'sameBookInfo 不许再用 NUL join 比较标签');
});

test('R5/C10：NUL 撞名不再静默 changed:false（真实写盘）', async () => {
  const root = await mkTmp('cw-wp14-book-');
  const { path: bookPath } = await storage.createBook(root, '含 空格 书名');
  const first = await storage.updateBookInfo(bookPath, { tags: ['a', 'b'] });
  assert.equal(first.changed, true);

  // 旧实现：['a','b'] 与 ['a\u0000b'] join 后同为 'a\u0000b' → changed:false，作者的修改静默没落盘。
  const second = await storage.updateBookInfo(bookPath, { tags: ['a\u0000b'] });
  assert.equal(second.changed, true, '含 NUL 的标签是一条不同的编辑，必须写盘');
  const meta = await storage.readBookMeta(bookPath);
  assert.deepEqual(meta.tags, ['ab'], 'NUL 清洗后落盘为 ab');
});

test('R5/C10 极值 × IO 失败：含空格中文书目录 × 书目只读 → 报错不动、无临时残留、可重试', async () => {
  const root = await mkTmp('cw-wp14-io-');
  const { path: bookPath } = await storage.createBook(root, '含 空格 书名');
  await storage.updateBookInfo(bookPath, { author: '李四', tags: ['a'] });
  const metaPath = path.join(bookPath, '书目.json');
  const before = await fsp.readFile(metaPath);

  await fsp.chmod(metaPath, 0o444);
  let failure = null;
  try {
    await storage.updateBookInfo(bookPath, { author: '张三', tags: ['b'] });
  } catch (err) {
    failure = err;
  } finally {
    await fsp.chmod(metaPath, 0o666);
  }
  assert.ok(failure, '书目只读时必须写盘失败');
  assert.ok(['EPERM', 'EACCES', 'EBUSY'].includes(failure.code), `实际错误码 ${failure.code}`);
  assert.deepEqual(await fsp.readFile(metaPath), before, '失败时书目一个字节不动');
  const leftovers = (await fsp.readdir(bookPath)).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, [], '失败不留 .tmp- 残片');

  const retry = await storage.updateBookInfo(bookPath, { author: '张三', tags: ['b'] });
  assert.equal(retry.changed, true, '恢复可写后重试成功');
  const meta = await storage.readBookMeta(bookPath);
  assert.equal(meta.author, '张三');
  assert.deepEqual(meta.tags, ['b']);
});

// ---------- X-N7 lastBook.at 上限 ----------

test('R6/X-N7：at 远未来夹到 now，10 分钟容差边界保留', () => {
  const now = 1_800_000_000_000;
  const base = { path: 'D:\\书架\\书A', title: '书A', chapterId: 'ch_1', chapterIndex: 0, chapterName: '第一章' };
  const day = 24 * 60 * 60 * 1000;
  assert.equal(config.sanitizeLastBook({ ...base, at: now + 365 * day }, now).at, now, '远未来夹到 now');
  assert.equal(config.sanitizeLastBook({ ...base, at: now }, now).at, now);
  assert.equal(config.sanitizeLastBook({ ...base, at: now - day }, now).at, now - day, '过去的 at 原样');
  const tolerance = config.MAX_LAST_BOOK_FUTURE_MS;
  assert.equal(config.sanitizeLastBook({ ...base, at: now + tolerance }, now).at, now + tolerance);
  assert.equal(config.sanitizeLastBook({ ...base, at: now + tolerance + 1 }, now).at, now);
});

test('R6/X-N7：远未来记录不再冻结「继续上次写作」（rememberLastBook）', async () => {
  const dir = await mkTmp('cw-wp14-lastbook-');
  const store = config.createConfigStore(dir);
  // 用「刚过去」的真实时钟做基准：createConfigStore 的读侧清洗用真实 Date.now()，
  // 人工构造的未来 now 会被读侧再夹一次，测不到写入路径本身。
  const now = Date.now() - 1000;
  const day = 24 * 60 * 60 * 1000;
  const base = { path: 'D:\\书架\\书A', title: '书A', chapterIndex: 0, chapterName: '第一章' };

  // 时钟前跳时写入一条 300 天后的 at：清洗后已经落在 now，不会把后续正常记录全判 stale。
  const jumped = await store.rememberLastBook({ ...base, chapterId: 'ch_1', at: now + 300 * day }, { now });
  assert.equal(jumped.written, true);
  assert.equal(jumped.config.lastBook.at, now);

  const next = await store.rememberLastBook(
    { ...base, chapterId: 'ch_2', chapterIndex: 1, chapterName: '第二章', at: now + 1000 },
    { now: now + 1000 }
  );
  assert.equal(next.written, true, '正常记录必须能覆盖被夹过的坏记录');
  assert.equal((await store.get()).lastBook.chapterId, 'ch_2');

  // stale 守卫本身没有被放宽：更早的记录仍然不写
  const older = await store.rememberLastBook(
    { ...base, chapterId: 'ch_0', at: now - 1000 },
    { now: now + 2000 }
  );
  assert.equal(older.reason, 'stale');
});

// T-13（三审）：时钟回拨的镜像防护 —— prev.at 落在「现在 + 容差」之外的未来时，stale / duplicate
// 两条守卫都不许再采信它，否则「继续上次写作」冻结到时钟追上。
test('T-13：时钟回拨后 prev.at 处于未来视为病值，切章 / 同章记录都不再被守卫吞掉', async () => {
  const dir = await mkTmp('cw-t13-lastbook-');
  const store = config.createConfigStore(dir);
  const now = Date.now() - 1000;
  const hour = 60 * 60 * 1000;
  const base = { path: 'D:\\书架\\书A', title: '书A', chapterIndex: 0, chapterName: '第一章' };

  // 正常时钟写下第一章（prev.at = now）
  assert.equal((await store.rememberLastBook({ ...base, chapterId: 'ch_1', at: now }, { now })).written, true);
  // 时钟回拨一小时后再报同一章：prev.at 现在是「未来 1 小时」的病值，不许被负数去重判成 duplicate
  const rolledBack = now - hour;
  const sameChapter = await store.rememberLastBook(
    { ...base, chapterId: 'ch_1', at: rolledBack },
    { now: rolledBack }
  );
  assert.equal(sameChapter.written, true, '回拨后同章记录要能把病值时间戳换回当前时钟');
  assert.equal((await store.get()).lastBook.at, rolledBack);

  // 再切到第二章：不许被 stale 判掉，「继续上次写作」跟着新章走
  const ch2 = await store.rememberLastBook(
    { ...base, chapterId: 'ch_2', chapterIndex: 1, chapterName: '第二章', at: rolledBack + 1000 },
    { now: rolledBack + 1000 }
  );
  assert.equal(ch2.written, true, '回拨后切章不许判 stale');
  assert.equal((await store.get()).lastBook.chapterId, 'ch_2');
  assert.equal((await store.get()).lastBook.at, rolledBack + 1000);
});

test('T-13 对照：容差内的「轻微未来」（多窗口时钟抖动）仍保留原保护', async () => {
  const dir = await mkTmp('cw-t13-skew-');
  const store = config.createConfigStore(dir);
  const now = Date.now() - 1000;
  const base = { path: 'D:\\书架\\书A', title: '书A', chapterIndex: 0, chapterName: '第一章' };
  const skew = 10 * 1000;
  assert.equal((await store.rememberLastBook({ ...base, chapterId: 'ch_1', at: now + skew }, { now })).written, true);

  // prev.at 只比现在晚 10 秒（< T-13 容差）：仍按「更晚的位置」保护，迟到的旧记录不写
  const older = await store.rememberLastBook(
    { ...base, chapterId: 'ch_0', at: now - 1000 },
    { now: now + 1000 }
  );
  assert.equal(older.reason, 'stale');
  // 同章在抖动窗口内重复上报照旧去重（避免 open + set-last 连写两次）
  const dup = await store.rememberLastBook({ ...base, chapterId: 'ch_1', at: now + 2000 }, { now: now + 2000 });
  assert.equal(dup.reason, 'duplicate');
  // 抖动值本身也不许被当成病值改写：等时钟追上后正常写新章
  const ch2 = await store.rememberLastBook(
    { ...base, chapterId: 'ch_2', chapterIndex: 1, chapterName: '第二章', at: now + skew + 1000 },
    { now: now + skew + 1000 }
  );
  assert.equal(ch2.written, true);
});

test('R6/X-N7 极值 × IO 失败：配置写盘 EPERM → reject、内存与磁盘都不动、队列不堵', async () => {
  const dir = await mkTmp('cw-wp14-cfg-');
  let failNext = false;
  const store = config.createConfigStore(dir, {
    write: async (target, data) => {
      if (failNext) {
        failNext = false;
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      }
      await writeJsonAtomic(target, data);
    }
  });
  const now = Date.now() - 1000;
  const base = { path: 'D:\\书架\\书A', title: '书A', chapterIndex: 0, chapterName: '第一章' };
  await store.rememberLastBook({ ...base, chapterId: 'ch_1', at: now }, { now });
  const before = await fsp.readFile(path.join(dir, 'config.json'));

  failNext = true;
  await assert.rejects(
    () => store.rememberLastBook({ ...base, chapterId: 'ch_2', at: now + 1000 }, { now: now + 1000 }),
    /EPERM/
  );
  assert.equal((await store.get()).lastBook.chapterId, 'ch_1', '写失败时内存缓存保持旧值');
  assert.deepEqual(await fsp.readFile(path.join(dir, 'config.json')), before, '写失败时磁盘保持旧值');

  const retry = await store.rememberLastBook(
    { ...base, chapterId: 'ch_2', at: now + 1000 },
    { now: now + 1000 }
  );
  assert.equal(retry.written, true, '失败不堵写队列');
  assert.equal((await store.get()).lastBook.chapterId, 'ch_2');
});

// ---------- 静态闸门（实现落点） ----------

test('R7：实现落点静态闸门（C6/C9/X-N7/C7）', () => {
  const proofreadSrc = readUtf8('core/proofread.js');
  assert.ok(proofreadSrc.includes('occ[j] - start < options.repeatWindow'), 'C6：窗口判定必须按起点');
  const watchSrc = readUtf8('core/clipboard-watch.js');
  assert.ok(watchSrc.includes("baseline = fingerprint('')"), 'C9：空读数也要推进基准');
  const configSrc = readUtf8('core/config.js');
  assert.match(configSrc, /MAX_LAST_BOOK_FUTURE_MS\s*=/, 'X-N7：未来容差常量要在 config.js');
  assert.ok(configSrc.includes('sanitizeLastBook(raw, now)'), 'X-N7：rememberLastBook 用同一个 now 清洗');
  assert.match(configSrc, /LAST_BOOK_CLOCK_SKEW_MS\s*=/, 'T-13：时钟回拨镜像容差常量要在 config.js');
  assert.match(
    configSrc,
    /prevAt <= now \+ LAST_BOOK_CLOCK_SKEW_MS/,
    'T-13：去重与 stale 两条守卫共用同一条可信判定'
  );
  const limitsSrc = readUtf8('core/ipc-limits.js');
  assert.ok(limitsSrc.includes("mode = 'all'"), 'C7：坏 volumeId 降级全书');
});