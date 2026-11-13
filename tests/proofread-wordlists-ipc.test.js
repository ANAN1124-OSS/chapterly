// F3b2（1.7.0）/ 1.7.2 D2（V44/V46/V47/V60/V63）：多份校对词表的读取 / 公开信息 / 添加移除频道。
// main.js 依赖 electron，Node 里 require 不起来；词表纯逻辑已在 D2 下沉到 core/glossary.js，
// 所以这里不再切 main.js 的函数体做静态闸门——直接 require 真模块跑行为断言；
// main.js 只保留「接线是否把 core 的出口用对」的少量行为 / 接线断言。
const test = require('node:test');
const assert = require('node:assert/strict');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const pathUtils = require('../core/path-utils');
const glossary = require('../core/glossary');
const proofread = require('../core/proofread');

const readSource = (rel) =>
  require('node:fs').readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');

const mainSource = readSource('main.js');
const preloadSource = readSource('preload.js');

// 从锚点切到下一个顶格两空格的函数 / handler 之前（与 tests/book-batch.test.js 同一手法）。
// D2 之后只用于极少量的接线断言（词表逻辑本身已可直接 require 真跑）。
function sliceFrom(source, startMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, '找不到锚点：' + startMarker);
  const rest = source.slice(start + startMarker.length);
  const next = rest.search(/\n {2}(?:async function |function |handleBook\(|handle\()/);
  return next === -1 ? rest : rest.slice(0, next);
}

const matchesOf = (source, pattern) => [...source.matchAll(pattern)].map((m) => m[1]);

async function mkTmp() {
  return fsPromises.mkdtemp(path.join(os.tmpdir(), 'cw-wordlists-d2-'));
}

test('行为：单份旧配置（proofreadWordsPath）保持原样单表读取，公开信息是旧形状（V60）', async () => {
  const dir = await mkTmp();
  try {
    const single = path.join(dir, '旧单份.txt');
    await fsPromises.writeFile(single, '做为 => 作为\n禁词\n', 'utf8');
    const config = { proofreadWordsPath: single };
    const words = await glossary.readProofreadWordlistForRequest(config, { enabledLists: [0] });
    assert.deepEqual(words.entries.map((entry) => entry.term), ['做为', '禁词']);
    assert.equal(words.entries[0].suggestion, '作为');
    assert.equal(words.wordList.ok, true);
    assert.equal(words.wordList.count, 2);
    assert.equal(words.wordList.name, '旧单份.txt');
    assert.equal(words.wordList.lists, undefined, '单份旧配置回旧形状（不带 lists），渲染层的老分支才认得');
    assert.equal(words.wordList.multi, undefined, 'multi 只在 words-info 频道补，读取出口不带');
    // 单份分支不认 enabledLists（改前就如此：旧配置没有「勾选哪几份」的概念）
    const again = await glossary.readProofreadWordlistForRequest(config, { enabledLists: [] });
    assert.deepEqual(again.entries, words.entries);
    assert.deepEqual(again.wordList, words.wordList);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test('行为：多份词表一次读完，公开信息描述全部，enabledLists 只过滤参与校对的词条（V46）', async () => {
  const dir = await mkTmp();
  try {
    const first = path.join(dir, '甲词表.txt');
    const second = path.join(dir, '乙词表.txt');
    await fsPromises.writeFile(first, '甲词 => 甲改\n共用 => 先到的建议\n', 'utf8');
    await fsPromises.writeFile(second, '乙词 => 乙改\n共用 => 后到的建议\n', 'utf8');
    const config = { proofreadWordlists: [first, second] };

    const all = await glossary.readProofreadWordlistForRequest(config);
    assert.deepEqual(all.entries.map((entry) => entry.term), ['甲词', '共用', '乙词'], '按配置顺序合并、同词先到先得');
    assert.equal(all.entries[1].suggestion, '先到的建议');
    assert.equal(all.wordList.lists.length, 2);
    assert.equal(all.wordList.total, 3);
    assert.equal(all.wordList.count, 3);
    assert.equal(all.wordList.name, '2 份词表');
    assert.equal(all.wordList.path, undefined, '多份公开信息绝不带路径');
    assert.equal(all.wordList.lists[0].entries, undefined, '多份公开信息绝不带词条正文');

    // 只勾第二份：条目必须与「只读第二份」逐字一致（改前会再 readGlossaryFiles([second]) 读一遍子集）。
    const onlySecond = await glossary.readProofreadWordlistForRequest(config, { enabledLists: [1] });
    const secondAlone = await glossary.readGlossaryFiles([second]);
    assert.deepEqual(onlySecond.entries, secondAlone.entries, '内存过滤与改前的二次读取结果一致');
    assert.deepEqual(onlySecond.entries.map((entry) => entry.term), ['乙词', '共用']);
    assert.equal(onlySecond.entries[1].suggestion, '后到的建议', '子集里「共用」先到的是乙词表');
    assert.equal(onlySecond.wordList.lists.length, 2, '公开信息永远描述配置里的全部词表');
    assert.equal(onlySecond.wordList.total, 3);

    // 全选 / 重复索引 / 坏值 / 空选 → 全开（与改前一致）
    for (const enabledLists of [[0, 1], [0, 0, 1, 1], [], 'x', [9, -1], [1.5]]) {
      const res = await glossary.readProofreadWordlistForRequest(config, { enabledLists });
      assert.deepEqual(res.entries, all.entries, 'enabledLists=' + JSON.stringify(enabledLists));
    }
    // 越界的 enabledLists 不能把任何一份悄悄关掉
    const outOfRange = await glossary.readProofreadWordlistForRequest(config, { enabledLists: [99] });
    assert.deepEqual(outOfRange.entries, all.entries);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test('行为：双表（坏份 / 超上限 / 重复词）合并与校对结果与改前逐字一致（夹具，V46/V47）', async () => {
  const dir = await mkTmp();
  try {
    const bad = path.join(dir, '甲-坏编码.txt');
    await fsPromises.writeFile(bad, Buffer.from([0xff, 0xff, 0x0a, 0x41]));
    const big = path.join(dir, '乙-大词表.txt');
    const lines = ['重复 => 建议一', '重复 => 建议二', '长'.repeat(101)];
    for (let index = 0; index < 5005; index += 1) lines.push(`乙词${index}`);
    await fsPromises.writeFile(big, lines.join('\n') + '\n', 'utf8');

    const words = await glossary.readProofreadWordlistForRequest({ proofreadWordlists: [bad, big] });
    assert.equal(words.entries.length, 5000, '合并总数封顶 MAX_ENTRIES');
    assert.deepEqual(words.entries[0], { term: '重复', suggestion: '建议一' }, '重复词只留第一次，建议先到先得');
    assert.deepEqual(
      words.entries[words.entries.length - 1],
      { term: '乙词4998', suggestion: '' },
      '超长行跳过、第二份按总数上限截断（与改前逐条一致）'
    );
    assert.deepEqual(words.wordList, {
      ok: true,
      configured: true,
      total: 5000,
      lists: [
        { ok: false, count: 0, error: '词表编码认不出来，请存成 UTF-8 或 GBK 的 txt', truncated: false },
        { ok: true, count: 5000, error: '', truncated: true }
      ],
      count: 5000,
      name: '2 份词表'
    }, '公开信息与改前逐字一致（坏份只影响自己那一条）');

    const text = '重复在乙词3与乙词4997。';
    const result = proofread.proofreadText(text, { maxIssues: 20 }, words.entries);
    assert.equal(result.total, 3);
    assert.equal(result.customWordCount, 5000);
    assert.deepEqual(
      result.issues.map((issue) => [issue.rule, issue.index, issue.length, issue.match, issue.suggestion]),
      [
        ['custom-word', 0, 2, '重复', '建议一'],
        ['custom-word', 3, 3, '乙词3', ''],
        ['custom-word', 7, 6, '乙词4997', '']
      ],
      '校对结果与改前逐字一致（夹具）'
    );
    // 老调用（不带已清洗标记）与主进程新调用（带标记）结果逐字一致：只清洗一次不改语义。
    const legacy = proofread.proofreadText(text, { maxIssues: 20 }, words.entries);
    const trusted = proofread.proofreadText(text, { maxIssues: 20, entriesSanitized: true }, words.entries);
    assert.deepEqual(trusted, legacy);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

// 从 main.js 的 handler 注册语句里切出箭头函数（保留原参数列表），在假作用域里真跑一遍（不 require electron）。
function extractAsyncArrow(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, '找不到锚点：' + marker);
  const signature = /async \(([^)]*)\) => \{$/.exec(marker);
  assert.ok(signature, '锚点必须形如 async (...) => { ：' + marker);
  const braceStart = start + marker.length - 1;
  assert.equal(source[braceStart], '{', '锚点必须以箭头函数体的 { 结尾：' + marker);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.notEqual(end, -1, '箭头函数体没闭合：' + marker);
  return 'async (' + signature[1] + ') => ' + source.slice(braceStart, end);
}

test('行为：proofread:words-info 处理器只读一次词表并透传 multi（P6 兼容，V46/V63）', async () => {
  const arrow = extractAsyncArrow(mainSource, "  handle('proofread:words-info', async () => {");
  const reads = [];
  const fakeWordList = {
    ok: true,
    configured: true,
    total: 1,
    count: 1,
    name: '1 份词表',
    lists: [{ ok: true, count: 1, error: '', truncated: false }]
  };
  const handler = new Function(
    'getConfig',
    'glossaryLib',
    `return (${arrow});`
  )(
    async () => ({ proofreadWordlists: ['C:\\词表.txt'] }),
    {
      readProofreadWordlistForRequest: async (cfg) => {
        reads.push(cfg);
        return { entries: [], wordList: fakeWordList };
      },
      hasProofreadWordlists: () => true
    }
  );
  const res = await handler();
  assert.equal(reads.length, 1, 'words-info 只读一次词表（不再 words-info + 校对各读一遍）');
  assert.equal(res.multi, true, 'multi 字段不能丢（1.7.1 P6 / E2E 46m / 73⑩ 依赖）');
  assert.equal(res.total, 1);
  assert.deepEqual(res.lists, fakeWordList.lists);
});

test('行为：text:proofread 处理器把读取出口的 entries 交给 proofreadText 并标记已清洗（V44/V46）', async () => {
  const arrow = extractAsyncArrow(mainSource, "  handle('text:proofread', async (text, options) => {");
  const seen = {};
  const fakeWordList = { ok: true, name: 'x', multi: false };
  const handler = new Function(
    'assertText',
    'getConfig',
    'glossaryLib',
    'proofreadLib',
    `return (${arrow});`
  )(
    () => {},
    async () => ({ proofreadWordlists: ['C:\\词表.txt'] }),
    {
      readProofreadWordlistForRequest: async (cfg, options) => {
        seen.readOptions = options;
        return { entries: [{ term: '做为', suggestion: '作为' }], wordList: fakeWordList };
      }
    },
    {
      proofreadText: (text, options, entries) => {
        seen.text = text;
        seen.proofOptions = options;
        seen.entries = entries;
        return { total: 0, issues: [] };
      }
    }
  );
  const res = await handler('他做为见证人。', { rules: { 'custom-word': true } });
  assert.equal(seen.text, '他做为见证人。');
  assert.deepEqual(seen.entries, [{ term: '做为', suggestion: '作为' }], '词条来自一次读取的出口');
  assert.equal(seen.proofOptions.entriesSanitized, true, '主进程传入已清洗标记，proofreadText 不再二次 sanitize');
  assert.deepEqual(seen.proofOptions.rules, { 'custom-word': true }, '用户选项原样保留');
  assert.deepEqual(res.wordList, fakeWordList, '回包仍带 wordList（渲染层据此重画词表状态）');
});

test('接线：book:proofread 走同一词表出口，整本每章共用已清洗词条（V44/V46）', () => {
  const body = sliceFrom(mainSource, "  handleBook('book:proofread', async (bookPath, options, override) => {");
  assert.match(body, /glossaryLib\.readProofreadWordlistForRequest\(/, 'book:proofread 走同一词表读取出口');
  assert.match(body, /entriesSanitized: true/, '整本每章共用已清洗词条，不再逐章 sanitize');
  // 两个校对频道都必须用 core 的出口，不在 main 里再留一份 helper
  for (const marker of [
    'function proofreadWordlistPaths(',
    'function hasProofreadWordlists(',
    'function wordlistPathsForRequest(',
    'function proofreadWordListInfo(',
    'async function readProofreadWordlistForRequest('
  ]) {
    assert.equal(mainSource.includes(marker), false, 'main.js 只接线，helper 已下沉 core：' + marker);
  }
});

test('静态闸门：新增的添加 / 移除频道在 main 与 preload 一一对应（F3b2）', () => {
  const mainChannels = new Set(matchesOf(mainSource, /handle\('(proofread:[a-z-]+)'/g));
  const preloadChannels = new Set(matchesOf(preloadSource, /invoke\('(proofread:[a-z-]+)'/g));
  assert.deepEqual(
    [...preloadChannels].sort(),
    [...mainChannels].sort(),
    '每一条校对频道都要有对应的 preload 成员（多一个少一个都不行）'
  );
  for (const name of ['proofread:wordlists-add', 'proofread:wordlists-remove']) {
    assert.ok(mainChannels.has(name), '要有频道 ' + name);
  }
  assert.match(preloadSource, /addProofreadWordlist:/, 'preload 要有 addProofreadWordlist');
  assert.match(preloadSource, /removeProofreadWordlist:/, 'preload 要有 removeProofreadWordlist');
  const addBody = sliceFrom(mainSource, "  handle('proofread:wordlists-add', async () => {");
  assert.match(addBody, /showOpenDialog\(/, '添加走系统对话框（渲染层不能自己给路径）');
  assert.match(addBody, /canceled: true/, '取消要回 { canceled: true }');
  assert.match(addBody, /proofreadWordlists/, '要操作多份字段');
  assert.match(addBody, /configStore\.set\(/, '要落盘');
  const removeBody = sliceFrom(mainSource, "  handle('proofread:wordlists-remove', async (index) => {");
  assert.match(removeBody, /Number\.isInteger\(/, 'index 必须是整数');
  assert.match(removeBody, /splice\(/, '合法索引才能移除');
  assert.match(removeBody, /configStore\.set\(/, '要落盘');
  // 旧单选频道行为保留：仍走单份公开信息
  const pickBody = sliceFrom(mainSource, "  handle('proofread:pick-words', async () => {");
  assert.match(pickBody, /proofreadWordsPath/, 'pick-words 仍写单份旧字段');
  assert.match(pickBody, /publicGlossaryInfo\(/, 'pick-words 仍回单份公开信息');
});

const ADD_ANCHOR = "  handle('proofread:wordlists-add', async () => {";

// 把 add 处理器装进假作用域：dialog / 配置 / 词表信息都是替身，fs 与 path 用真的。
// 返回 { handler, calls }；calls 记录 stat / info 的调用顺序——就是 V53 要钉的「先校验、后读词表」。
function loadAddWordlistHandler({ picked, config }) {
  const calls = [];
  const arrow = extractAsyncArrow(mainSource, ADD_ANCHOR);
  const handler = new Function(
    'showOpenDialog',
    'getConfig',
    'configStore',
    'applyConfig',
    'proofreadWordlistInfoNow',
    'fs',
    'pathUtils',
    'path',
    'WORDLIST_MAX',
    'wordlistKey',
    `return (${arrow});`
  )(
    async () => ({ canceled: false, filePaths: [picked] }),
    async () => config,
    { set: async (patch) => ({ ...config, ...patch }) },
    () => {},
    async () => {
      calls.push('info');
      return { lists: [], total: 0, multi: true };
    },
    { stat: (target) => { calls.push('stat'); return fsPromises.stat(target).catch(() => null); } },
    pathUtils,
    path,
    8,
    // 只为让「改前」的旧实现也能跑起来；断言的是调用顺序，不是函数名
    pathUtils.pathKey
  );
  return { handler, calls };
}

test('行为：添加词表先 stat / 判重 / 判上限，再读词表；被拒绝的路径不先读一遍（V53）', async () => {
  const dir = await mkTmp();
  try {
    const missing = path.join(dir, '没有这份词表.txt');
    const existing = path.join(dir, '已有词表.txt');
    await fsPromises.writeFile(existing, '错词\n', 'utf8');

    // ① 不存在：先 stat 判掉，再读词表回面板（而不是先把全部词表读一遍才发现文件不在）
    {
      const { handler, calls } = loadAddWordlistHandler({ picked: missing, config: { proofreadWordlists: [] } });
      const res = await handler();
      assert.equal(res.code, 'WORDLIST_MISSING');
      assert.equal(res.added, false);
      assert.deepEqual(calls, ['stat', 'info'], '缺失文件：stat 必须先于读词表');
    }
    // ② 已在列表里：stat 通过 → 判重 → 再读词表
    {
      const { handler, calls } = loadAddWordlistHandler({ picked: existing, config: { proofreadWordlists: [existing] } });
      const res = await handler();
      assert.equal(res.code, 'WORDLIST_DUPLICATE');
      assert.deepEqual(calls, ['stat', 'info'], '重复文件：先 stat → 判重 → 再读词表');
    }
    // ③ 8 份上限：stat 通过 → 判重通过 → 判上限 → 再读词表
    {
      const full = Array.from({ length: 8 }, (_, index) => path.join(dir, `满${index}.txt`));
      const { handler, calls } = loadAddWordlistHandler({ picked: existing, config: { proofreadWordlists: full } });
      const res = await handler();
      assert.equal(res.code, 'WORDLIST_LIMIT');
      assert.equal(res.message, '最多 8 份校对词表');
      assert.deepEqual(calls, ['stat', 'info'], '到上限：先校验再读词表');
    }
    // ④ 通过校验：落盘后只读一次词表
    {
      const { handler, calls } = loadAddWordlistHandler({ picked: existing, config: { proofreadWordlists: [] } });
      const res = await handler();
      assert.equal(res.added, true);
      assert.deepEqual(calls, ['stat', 'info'], '成功路径也只读一次词表（校验通过之后）');
    }
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});