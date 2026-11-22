// M1（第一轮·低，第 11 轮第四刀）：「替换这一处」入口的**行为**锚点。
//
// 背景：runReplaceOne（先拍身份快照 → 两次 await findNext → 回执按书 / 章 / 正文身份复核 →
// execCommand 替换 → 兜底拼接记一次性快照）以前长在 renderer.js 里，只有开 Electron 抬两个回执才测得到
// 「回执迟到会不会串字」。第 11 轮把整段搬进 renderer/replace-one-ui.js（renderer.js 只留同名转发与
// 一次装配），这里用桩 findNext 把每条回执的处置逐条钉住，再用机器清单钉「实现只有一份、装配三处到位」。
const test = require('node:test');
const assert = require('node:assert/strict');
const replaceOneUi = require('../renderer/replace-one-ui');
const guard = require('../renderer/replace-one-guard');
const manifest = require('../renderer/assembly-manifest');
const { loadSourceGate, stripAssertHostBranch } = require('./ui-test-preambles');

const TEXT = '阿明一。阿明二。阿明三。';

// 假 host：可改的 state + 桩 findNext 队列 + 记下每次调用的桩。所有依赖按「调用时取值」给。
function makeHost(options = {}) {
  const calls = {
    summary: [],
    focus: 0,
    selection: [],
    replaceNative: [],
    input: 0,
    fallback: [],
    scroll: [],
    findNext: [],
    injected: 0
  };
  const state = {
    bookPath: options.bookPath === undefined ? '/书库/书甲' : options.bookPath,
    loadedChapterId: options.loadedChapterId === undefined ? 'ch_1' : options.loadedChapterId,
    loading: Boolean(options.loading)
  };
  const editorEl = {
    value: options.text === undefined ? TEXT : options.text,
    selectionStart: options.selectionStart === undefined ? 0 : options.selectionStart,
    selection: null,
    focus() {
      calls.focus += 1;
    },
    setSelectionRange(start, end) {
      calls.selection.push([start, end]);
      editorEl.selection = [start, end];
    }
  };
  const summaryEl = { textContent: '' };
  const queue = options.findNextResults ? [...options.findNextResults] : [];
  const host = {
    $: (id) => {
      if (id !== 'find-summary') throw new Error('意外的选择器：' + id);
      return summaryEl;
    },
    state,
    editorEl,
    api: { findNext: 'text:find-next' },
    call: async (channel, ...rest) => {
      calls.findNext.push({ via: 'call', channel, rest });
      if (!queue.length) throw new Error('桩 findNext 队列空了');
      const next = queue.shift();
      if (typeof next === 'function') return next();
      return next;
    },
    readFindOptions: () =>
      options.options || { query: '阿明', replacement: '小明', scope: 'current', caseSensitive: false },
    replaceOneGuard: guard,
    getTestFindNext: () =>
      options.testFindNext
        ? (...args) => {
            calls.injected += 1;
            calls.findNext.push({ via: 'injected', args });
            const next = queue.shift();
            if (typeof next === 'function') return next();
            return next;
          }
        : null,
    replaceEditorTextNative: (text) => {
      calls.replaceNative.push(text);
      if (options.fallback) return false;
      const [start, end] = editorEl.selection || [0, 0];
      editorEl.value = editorEl.value.slice(0, start) + text + editorEl.value.slice(end);
      return true;
    },
    onEditorInput: () => {
      calls.input += 1;
    },
    recordFallbackWrite: (info) => {
      calls.fallback.push(info);
    },
    scrollCaretIntoView: (pos) => {
      calls.scroll.push(pos);
    }
  };
  return { host, state, editorEl, summaryEl, calls };
}

const HIT_FIRST = { match: { index: 0, length: 2 }, index: 0, total: 3, truncated: false };
const HIT_NEXT = { match: { index: 3, length: 2 }, index: 1, total: 3, truncated: false };

test('host 契约：12 个必填成员缺一个就抛 TypeError，模块头声明的成员数与之相等', () => {
  assert.deepEqual([...replaceOneUi.REQUIRED_HOST].sort(), [
    '$', 'api', 'call', 'editorEl', 'getTestFindNext', 'onEditorInput', 'readFindOptions',
    'recordFallbackWrite', 'replaceEditorTextNative', 'replaceOneGuard', 'scrollCaretIntoView', 'state'
  ]);
  const { host } = makeHost();
  assert.throws(() => replaceOneUi.create(null), /createReplaceOneUi 需要 host 对象/);
  assert.throws(() => replaceOneUi.create('host'), /createReplaceOneUi 需要 host 对象/);
  for (const key of replaceOneUi.REQUIRED_HOST) {
    const broken = { ...host };
    delete broken[key];
    assert.throws(() => replaceOneUi.create(broken), /缺少/, key);
    assert.throws(() => replaceOneUi.create({ ...host, [key]: null }), /缺少/, key + '（null 也算缺）');
  }
  const ui = replaceOneUi.create(host);
  assert.deepEqual(Object.keys(ui), ['runReplaceOne'], '对外只暴露入口');
  const claimed = /host 正好 (\d+) 个成员/.exec(require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'renderer', 'replace-one-ui.js'), 'utf8'));
  assert.ok(claimed);
  assert.equal(claimed[1], String(replaceOneUi.REQUIRED_HOST.length));
});

test('入口守卫：没输入 / 不是「当前章」范围都只提示，一次 findNext 都不发', async () => {
  const empty = makeHost({ options: { query: '  ', replacement: 'x', scope: 'current' } });
  assert.deepEqual(await replaceOneUi.create(empty.host).runReplaceOne(), { ok: false });
  assert.match(empty.summaryEl.textContent, /先在查找框里输入内容/);
  assert.equal(empty.calls.findNext.length, 0);

  const bookScope = makeHost({ options: { query: '阿明', replacement: '小明', scope: 'book' } });
  assert.deepEqual(await replaceOneUi.create(bookScope.host).runReplaceOne(), { ok: false });
  assert.match(bookScope.summaryEl.textContent, /只用于当前章/);
  assert.equal(bookScope.calls.findNext.length, 0);
});

test('载章在途：入口直接拒绝（编辑区马上要被新章覆盖），错误码仍是 STALE_TARGET', async () => {
  const { host, summaryEl, calls } = makeHost({ loading: true });
  const result = await replaceOneUi.create(host).runReplaceOne();
  assert.deepEqual(result, { ok: false, code: 'STALE_TARGET', reason: 'loading' });
  assert.match(summaryEl.textContent, /正在切换章节/);
  assert.equal(calls.findNext.length, 0, '载章在途不许发 findNext');
  assert.equal(calls.replaceNative.length, 0);
});

test('查找失败 / 光标之后没有命中：只改摘要，绝不改正文', async () => {
  const failed = makeHost({
    findNextResults: [
      () => {
        throw new Error('索引忙');
      }
    ]
  });
  assert.deepEqual(await replaceOneUi.create(failed.host).runReplaceOne(), { ok: false });
  assert.match(failed.summaryEl.textContent, /查找失败：索引忙/);
  assert.equal(failed.calls.replaceNative.length, 0);

  const none = makeHost({ text: '阿明一。', findNextResults: [null] });
  assert.deepEqual(await replaceOneUi.create(none.host).runReplaceOne(), { ok: false, truncated: false });
  assert.match(none.summaryEl.textContent, /光标之后没有找到「阿明」了/);

  const truncated = makeHost({ findNextResults: [{ match: null, truncated: true, total: 5000, index: 4999 }] });
  assert.deepEqual(await replaceOneUi.create(truncated.host).runReplaceOne(), { ok: false, truncated: true });
  assert.match(truncated.summaryEl.textContent, /本章命中超过单章上限 5000 处/);
});

test('回执迟到：正文 / 章 / 书变了就整段作废（STALE_TARGET），旧下标绝不拼进新正文', async () => {
  const textChanged = makeHost({
    findNextResults: [
      () => {
        // await 期间作者又改了正文（输入法补字等）
        editorElRef.value = '阿明一。阿明二。改过的一行。';
        return HIT_FIRST;
      }
    ]
  });
  const editorElRef = textChanged.editorEl;
  const result = await replaceOneUi.create(textChanged.host).runReplaceOne();
  assert.deepEqual(result, { ok: false, code: 'STALE_TARGET', reason: 'text-changed' });
  assert.match(textChanged.summaryEl.textContent, /查找期间正文有改动/);
  assert.equal(textChanged.calls.replaceNative.length, 0, '身份不一致时一个字都不许替换');

  const chapterChanged = makeHost({
    findNextResults: [
      () => {
        stateRef.loadedChapterId = 'ch_2';
        return HIT_FIRST;
      }
    ]
  });
  const stateRef = chapterChanged.state;
  assert.deepEqual(await replaceOneUi.create(chapterChanged.host).runReplaceOne(), {
    ok: false,
    code: 'STALE_TARGET',
    reason: 'chapter-changed'
  });
  assert.equal(chapterChanged.calls.replaceNative.length, 0);

  const outOfBounds = makeHost({
    findNextResults: [{ match: { index: 100, length: 2 }, index: 0, total: 3, truncated: false }]
  });
  assert.deepEqual(await replaceOneUi.create(outOfBounds.host).runReplaceOne(), {
    ok: false,
    code: 'STALE_TARGET',
    reason: 'out-of-bounds'
  });
  assert.equal(outOfBounds.calls.replaceNative.length, 0);
});

test('正常替换：execCommand 保住撤销链 → 选中下一处 → 摘要说清第几处 / 未保存', async () => {
  const { host, editorEl, summaryEl, calls } = makeHost({ findNextResults: [HIT_FIRST, HIT_NEXT] });
  const result = await replaceOneUi.create(host).runReplaceOne();
  assert.deepEqual(result, { ok: true, index: 0, total: 3, truncated: false, hasNext: true });
  assert.equal(editorEl.value, '小明一。阿明二。阿明三。');
  assert.deepEqual(calls.replaceNative, ['小明']);
  assert.equal(calls.focus, 1, '替换前把焦点交给编辑区');
  assert.deepEqual(calls.selection, [[0, 2], [3, 5]], '先选中命中处再替换，最后选中下一处');
  assert.deepEqual(calls.scroll, [3]);
  assert.equal(calls.input, 1, '替换后要走一次输入处理（dirty / 标记层 / 状态栏）');
  assert.deepEqual(calls.fallback, [], 'execCommand 成功不记兜底快照');
  assert.equal(calls.findNext.length, 2);
  assert.deepEqual(calls.findNext[0].rest.slice(0, 3), ['阿明一。阿明二。阿明三。', '阿明', 0]);
  assert.equal(calls.findNext[1].rest[2], 2, '找下一处从「替换处之后」开始');
  assert.match(summaryEl.textContent, /已替换第 1\/3 处/);
  assert.match(summaryEl.textContent, /Ctrl\+S 写盘，Ctrl\+Z 可撤销/);
  assert.match(summaryEl.textContent, /已选中下一处（第 2 处）/);
});

test('兜底拼接：execCommand 不可用时手动拼 + 记一次性快照（审计 #39 / V402）', async () => {
  const { host, editorEl, calls } = makeHost({ findNextResults: [HIT_FIRST, HIT_NEXT], fallback: true });
  const result = await replaceOneUi.create(host).runReplaceOne();
  assert.equal(result.ok, true);
  assert.equal(editorEl.value, '小明一。阿明二。阿明三。', '兜底拼接不许丢内容');
  assert.equal(calls.fallback.length, 1);
  assert.deepEqual(calls.fallback[0], {
    before: TEXT,
    after: '小明一。阿明二。阿明三。',
    start: 0,
    label: '替换这一处'
  });
  assert.equal(calls.input, 1, '快照要在输入处理之后记（先标脏再记）');
});

test('第二个回执迟到：只放弃「选中下一处」，正文与替换结果照旧', async () => {
  const chapterChanged = makeHost({
    findNextResults: [
      HIT_FIRST,
      () => {
        stateRef.loadedChapterId = 'ch_2';
        return HIT_NEXT;
      }
    ]
  });
  const stateRef = chapterChanged.state;
  const result = await replaceOneUi.create(chapterChanged.host).runReplaceOne();
  assert.equal(result.ok, true);
  assert.equal(result.hasNext, false);
  assert.equal(chapterChanged.editorEl.value, '小明一。阿明二。阿明三。', '回执迟到不许改已经替换好的正文');
  assert.deepEqual(chapterChanged.calls.selection, [[0, 2]], '只要定位回执过期就不再选中下一处');
  assert.deepEqual(chapterChanged.calls.scroll, []);
  assert.match(chapterChanged.summaryEl.textContent, /期间章节已变，不再定位下一处/);

  const failedSecond = makeHost({
    findNextResults: [
      HIT_FIRST,
      () => {
        throw new Error('索引忙');
      }
    ]
  });
  const secondFailed = await replaceOneUi.create(failedSecond.host).runReplaceOne();
  assert.equal(secondFailed.ok, true, '找下一处失败不影响已经替换的内容');
  assert.deepEqual(failedSecond.calls.selection, [[0, 2], [2, 2]], '光标放到替换处之后');
  assert.match(failedSecond.summaryEl.textContent, /本章后面没有下一处了/);
});

test('截断：命中超过单章上限时摘要标 5000+ 并说明只处理前 5000 处', async () => {
  const truncatedHit = { match: { index: 0, length: 2 }, index: 4999, total: 5000, truncated: true };
  const { host, summaryEl } = makeHost({ findNextResults: [truncatedHit, null] });
  const result = await replaceOneUi.create(host).runReplaceOne();
  assert.equal(result.truncated, true);
  assert.equal(summaryEl.textContent.includes('已替换第 5000/5000+ 处'), true);
  assert.match(summaryEl.textContent, /只统计 \/ 处理前 5000 处/);
});

test('测试钩子注入的 findNext 真的被用（活绑定：create 时解构会拿到 null 的旧快照）', async () => {
  const { host, calls } = makeHost({ findNextResults: [HIT_FIRST, HIT_NEXT], testFindNext: true });
  const result = await replaceOneUi.create(host).runReplaceOne();
  assert.equal(result.ok, true);
  assert.equal(calls.injected, 2, '两次 findNext 都要走注入实现');
  assert.equal(calls.findNext.every((item) => item.via === 'injected'), true);
  assert.deepEqual(calls.findNext[0].args.slice(1, 4), ['阿明一。阿明二。阿明三。', '阿明', 0]);
});

// 静态闸门（机器清单）：实现只有一份、装配三处到位、渲染层只剩装配与同名转发。
test('静态闸门：实现只在 renderer/replace-one-ui.js，renderer.js 只留装配与同名转发（机器清单）', () => {
  const { rendererSrc, rendererCode, indexSrc, moduleSrc, moduleCode } = loadSourceGate('replace-one-ui.js');
  // ① 编排器里不许再长出第二份实现
  assert.equal(rendererCode.includes("const options = readFindOptions();"), false, 'renderer.js 不许再有查找选项读取（实现已搬走）');
  assert.equal(rendererCode.includes('replaceEditorTextNative(replacement)'), false, '替换主体搬进模块');
  assert.equal(rendererCode.includes('recordFallbackWrite({ before: text'), false, '兜底快照记录搬进模块');
  assert.match(rendererSrc, /async function runReplaceOne\(\) \{\r?\n\s*if \(!replaceOneUi\) return \{ ok: false \};/, '只留同名转发');
  assert.match(moduleSrc, /async function runReplaceOne\(\)/, '实现要在模块里');
  // ② 装配一次（模块常量 + create 都在编排器里）；findNext 的活绑定按取值函数注入
  assert.match(rendererSrc, /const replaceOneUiModule = window\.CWReplaceOneUi;/);
  assert.match(rendererSrc, /replaceOneUi = replaceOneUiModule\.create\(\{/);
  assert.match(rendererSrc, /getTestFindNext: \(\) => testFindNext,/, '活绑定要按取值函数注入（不能传值）');
  assert.equal(/testFindNext = null;/.test(rendererCode), true, '活绑定本身仍留在编排器（测试钩子的 setter 在那边）');
  // ③ 换书入口没被绕过：模块只发 findNext
  assert.equal(/api\.openBook\b/.test(moduleCode), false, '本模块不许自带换书入口');
  assert.deepEqual([...new Set(moduleCode.match(/api\.\w+/g) || [])], ['api.findNext'], '模块只许发 findNext 一个 IPC');
  // ④ 装配清单 + index.html 都到位，且排在 renderer.js / assert-host 之后
  const entry = manifest.MODULES.find((item) => item[0] === 'replace-one-ui.js');
  assert.ok(entry, '装配清单必须登记 replace-one-ui.js');
  assert.equal(entry[1], 'CWReplaceOneUi');
  assert.equal(entry[2], 'replaceOneUiModule');
  assert.match(indexSrc, /<script src="replace-one-ui\.js"><\/script>/, 'index.html 必须加载 replace-one-ui.js');
  assert.ok(
    indexSrc.indexOf('<script src="replace-one-ui.js"></script>') < indexSrc.indexOf('<script src="renderer.js"></script>'),
    'replace-one-ui.js 必须排在 renderer.js 之前'
  );
  assert.ok(
    indexSrc.indexOf('<script src="../core/assert-host.js"></script>') <
      indexSrc.indexOf('<script src="replace-one-ui.js"></script>'),
    'assert-host 必须排在消费者之前'
  );
  // ⑤ 模块本身仍是 UMD 双分支 + 依赖 assert-host，运行时代码不 require 任何东西
  assert.match(moduleSrc, /root\.CWReplaceOneUi = factory\(root\.CWAssertHost && root\.CWAssertHost\.assertHost\);/);
  assert.match(moduleSrc, /assertHost\('createReplaceOneUi', host, REQUIRED_HOST\);/, '只许调用一次共享 assertHost');
  assert.equal(/require\(/.test(stripAssertHostBranch(moduleCode)), false, '运行时代码（剥掉 Node 分支后）不许 require');
});
