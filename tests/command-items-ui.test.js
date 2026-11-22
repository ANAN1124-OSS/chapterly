// M1（第一轮·低，第 10 轮第二刀）：命令面板条目表的**行为**锚点。
//
// 背景：条目表（命令 + 章节 + 书）与它的「数据版本」缓存以前长在 renderer.js 里（4,545 行），
// 只有打开 Ctrl+K 才看得见 —— 缓存有没有命中、面板开着时删章会不会切错章、当前书重复打开时
// 会不会真的重载正文，全靠 E2E 敲键盘。第 10 轮把这一整段搬进 renderer/command-items-ui.js
// （renderer.js 只留同名转发与一次装配），这里用假 state 把行为逐条钉住，再用机器清单钉
// 「实现只有一份、装配三处到位」。
const test = require('node:test');
const assert = require('node:assert/strict');
const commandItemsUi = require('../renderer/command-items-ui');
const manifest = require('../renderer/assembly-manifest');
const { loadSourceGate, stripAssertHostBranch } = require('./ui-test-preambles');

// 假 host：一份可改的 state + 记下每次调用的桩。所有依赖都按「调用时取值」给（与渲染层同口径）。
function makeHost(options = {}) {
  const calls = {
    prepare: 0, switchChapter: [], focusChapterItem: [], openBookByPath: [],
    toast: [], focusEditor: 0, invalidate: 0
  };
  const state = {
    view: options.view === undefined ? 'editor' : options.view,
    bookPath: options.bookPath === undefined ? '/书库/书甲' : options.bookPath,
    meta: options.meta === undefined ? { title: '书甲' } : options.meta,
    chapters: options.chapters || [
      { id: 'ch_1', name: '第一章' },
      { id: 'ch_2', name: '第二章' }
    ],
    books: options.books || [
      { path: '/书库/书甲', title: '书甲', chapterCount: 2 },
      { path: '/书库/书乙', title: '书乙', chapterCount: 7 }
    ],
    index: options.index === undefined ? 1 : options.index
  };
  const defs = options.defs || [
    { id: 'cmd:save', title: '保存本章', kbd: 'Ctrl+S', keywords: ['save', '保存'], run: () => {} },
    { id: 'cmd:focus', title: '专注模式', keywords: ['focus'], run: () => {}, when: () => state.view === 'editor' }
  ];
  const host = {
    state,
    chaptersLib: { chapterNumber: (meta, index) => index + 1 },
    chapterTitle: (index, name) => name || `第 ${index + 1} 章`,
    defs: () => defs,
    prepare: (items) => {
      calls.prepare += 1;
      return items.map((item, index) => ({ ...item, rank: index }));
    },
    switchChapter: (index) => {
      calls.switchChapter.push(index);
      return Promise.resolve(options.switchResult === undefined ? { ok: true } : options.switchResult);
    },
    focusChapterItem: (locator) => { calls.focusChapterItem.push(locator); },
    sameBookPath: (a, b) => String(a) === String(b),
    openBookByPath: (bookPath) => {
      calls.openBookByPath.push(bookPath);
      return Promise.resolve({ ok: true });
    },
    toast: (message, kind) => { calls.toast.push([message, kind]); },
    focusEditor: () => { calls.focusEditor += 1; },
    invalidate: () => { calls.invalidate += 1; }
  };
  return { host, state, calls };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('host 契约：11 个必填成员缺一个就抛 TypeError，invalidate 可选（旧宿主 / 单测不传照常工作）', () => {
  assert.deepEqual([...commandItemsUi.REQUIRED_HOST].sort(), [
    'chapterTitle', 'chaptersLib', 'defs', 'focusChapterItem', 'focusEditor', 'openBookByPath',
    'prepare', 'sameBookPath', 'state', 'switchChapter', 'toast'
  ]);
  const { host } = makeHost();
  assert.throws(() => commandItemsUi.create(null), /createCommandItemsUi 需要 host 对象/);
  assert.throws(() => commandItemsUi.create('x'), /createCommandItemsUi 需要 host 对象/);
  for (const key of commandItemsUi.REQUIRED_HOST) {
    const broken = { ...host };
    delete broken[key];
    assert.throws(() => commandItemsUi.create(broken), /缺少/, key);
    assert.throws(() => commandItemsUi.create({ ...host, [key]: null }), /缺少/, key + '（null 也算缺）');
  }
  assert.doesNotThrow(() => commandItemsUi.create(host));
  const optional = { ...host };
  delete optional.invalidate;
  const ui = commandItemsUi.create(optional);
  assert.doesNotThrow(() => ui.markCommandsDirty(), '没有面板可通知时也要能作废（否则保存后会抛错）');
});

test('条目表：命令（按 when 过滤）→ 章节 → 书，三类都按面板要的字段形状给出', () => {
  const { host, calls } = makeHost();
  const items = commandItemsUi.create(host).commandItemsForPalette();
  assert.equal(calls.prepare, 1, '条目表构建一次就交给 prepare 预处理');
  assert.deepEqual(items.map((item) => item.group), ['command', 'command', 'chapter', 'chapter', 'book', 'book']);
  assert.deepEqual(items.map((item) => item.id), [
    'cmd:save', 'cmd:focus', 'chapter:ch_1', 'chapter:ch_2', 'book:/书库/书甲', 'book:/书库/书乙'
  ]);
  // 命令行：id / 标题 / 键帽 / 关键词原样透传，hint 恒空
  assert.equal(items[0].title, '保存本章');
  assert.equal(items[0].kbd, 'Ctrl+S');
  assert.deepEqual(items[0].keywords, ['save', '保存']);
  assert.equal(items[0].hint, '');
  assert.equal(items[1].kbd, '', '没有键帽的命令给空串（面板按空串决定不画键帽）');
  // 章节行：标题来自 chapterTitle，hint 当前章 / 第 N 章，关键词带两套章号
  assert.equal(items[2].title, '第一章');
  assert.equal(items[2].hint, '第 1 章');
  assert.equal(items[3].hint, '当前章', 'state.index 指到的那一章标「当前章」');
  assert.deepEqual(items[3].keywords, ['第二章', 'ch2', 'ch2']);
  // 书行：标题「打开《书名》」，hint 章数，关键词三样
  assert.equal(items[4].title, '打开《书甲》');
  assert.equal(items[4].hint, '2 章');
  assert.deepEqual(items[4].keywords, ['书甲', 'book', '书']);
  assert.equal(items[5].hint, '7 章');
  assert.ok(items.every((item) => typeof item.run === 'function'), '每条都带可执行的 run');
});

test('条目表：书架视图不列章节行；没有打开书时也不列（与旧实现同口径）', () => {
  const shelf = makeHost({ view: 'shelf' });
  const shelfItems = commandItemsUi.create(shelf.host).commandItemsForPalette();
  assert.deepEqual(shelfItems.map((item) => item.group), ['command', 'book', 'book'],
    '书架视图只留命令行（when 过滤掉编辑类命令）+ 书架行');
  const noBook = makeHost({ view: 'editor', bookPath: '' });
  const noBookItems = commandItemsUi.create(noBook.host).commandItemsForPalette();
  assert.deepEqual(noBookItems.map((item) => item.group), ['command', 'command', 'book', 'book'],
    '没有打开书时不列章节行');
});

test('数据版本缓存：同一版本返回同一份数组（引用不变），版本一变就重建', () => {
  const { host, state, calls } = makeHost();
  const ui = commandItemsUi.create(host);
  const first = ui.commandItemsForPalette();
  const again = ui.commandItemsForPalette();
  assert.equal(again, first, '数据没变时连条目数组引用都不换（千章书连续输入不重建对象）');
  assert.equal(calls.prepare, 1, '缓存命中不重复 prepare');

  state.index = 0; // 当前章变了：键里的一项变了
  const moved = ui.commandItemsForPalette();
  assert.notEqual(moved, first, '当前章变了要重建（「当前章」标记跟着走）');
  assert.equal(calls.prepare, 2);
  assert.equal(moved.find((item) => item.id === 'chapter:ch_1').hint, '当前章');

  state.chapters = [...state.chapters]; // 章节数组换了新引用（改名 / 重排后的常态）
  const rebuilt = ui.commandItemsForPalette();
  assert.notEqual(rebuilt, moved, '章节数组换引用也要重建（对象可能被原地改了）');
  assert.equal(calls.prepare, 3);
});

test('markCommandsDirty：作废本模块缓存 + 通知面板作废自己的快照', () => {
  const { host, calls } = makeHost();
  const ui = commandItemsUi.create(host);
  const before = ui.commandItemsForPalette();
  ui.markCommandsDirty();
  assert.equal(calls.invalidate, 1, '面板自己的条目快照也要通知作废（否则重画还是旧数据）');
  const after = ui.commandItemsForPalette();
  assert.notEqual(after, before, '作废后下一次取要重新构建');
  assert.equal(calls.prepare, 2);
});

test('章节 run：按 chapter.id 现场解析下标（面板开着期间数组被换掉也不切错章）', async () => {
  const { host, state, calls } = makeHost();
  const items = commandItemsUi.create(host).commandItemsForPalette();
  const runFirst = items.find((item) => item.id === 'chapter:ch_1').run;
  // 模拟「面板开着时上面插了一章」：ch_1 从下标 0 挪到 1
  state.chapters = [{ id: 'ch_new', name: '新插的一章' }, { id: 'ch_1', name: '第一章' }];
  runFirst();
  await settle();
  assert.deepEqual(calls.switchChapter, [1], '切的是现场解析出的下标，不是构建时的 0');
  assert.deepEqual(calls.focusChapterItem, [{ mode: 'switch', index: 1 }], '焦点也落到现场解析出的那一章');
});

test('章节 run：章已删只提示不切章；切章失败也不抢焦点', async () => {
  const gone = makeHost();
  const goneItems = commandItemsUi.create(gone.host).commandItemsForPalette();
  const runGone = goneItems.find((item) => item.id === 'chapter:ch_2').run;
  gone.state.chapters = [{ id: 'ch_1', name: '第一章' }];
  runGone();
  await settle();
  assert.deepEqual(gone.calls.switchChapter, [], '章不存在时一步都不许切（会切到别的章）');
  assert.deepEqual(gone.calls.focusChapterItem, []);
  assert.equal(gone.calls.toast.length, 1);
  assert.match(gone.calls.toast[0][0], /这一章已经不存在了/);
  assert.equal(gone.calls.toast[0][1], 'warn');

  const failed = makeHost({ switchResult: { ok: false } });
  const failedItems = commandItemsUi.create(failed.host).commandItemsForPalette();
  failedItems.find((item) => item.id === 'chapter:ch_1').run();
  await settle();
  assert.deepEqual(failed.calls.switchChapter, [0]);
  assert.deepEqual(failed.calls.focusChapterItem, [], '切章没成功（未保存拦截等）就不许抢焦点');
});

test('书 run：当前书已开只提示 + 把焦点还给编辑区，绝不重复 openBook（会重载正文丢字）', async () => {
  const { host, calls } = makeHost();
  const items = commandItemsUi.create(host).commandItemsForPalette();
  items.find((item) => item.id === 'book:/书库/书甲').run();
  await settle();
  assert.deepEqual(calls.openBookByPath, [], '当前书不许再走一次 openBook（编辑区里没保存的字会丢）');
  assert.deepEqual(calls.toast, [['这本书已经打开了', undefined]]);
  assert.equal(calls.focusEditor, 1, '写作页里把焦点还给编辑区');

  const shelf = makeHost({ view: 'shelf' });
  const shelfItems = commandItemsUi.create(shelf.host).commandItemsForPalette();
  shelfItems.find((item) => item.id === 'book:/书库/书甲').run();
  await settle();
  assert.deepEqual(shelf.calls.openBookByPath, []);
  assert.equal(shelf.calls.focusEditor, 0, '不在写作页时不抢焦点');
});

test('书 run：打开另一本书走 openBookByPath', async () => {
  const { host, calls } = makeHost();
  const items = commandItemsUi.create(host).commandItemsForPalette();
  const bookB = items.find((item) => item.id === 'book:/书库/书乙');
  assert.equal(bookB.title, '打开《书乙》');
  bookB.run();
  await settle();
  assert.deepEqual(calls.openBookByPath, ['/书库/书乙'], '只有换书才真的打开');
  assert.deepEqual(calls.toast, [], '换书成功不弹「已经打开」');
});

// 静态闸门（机器清单）：实现只有一份、装配三处到位、渲染层只剩转发。
test('静态闸门：实现只在 renderer/command-items-ui.js，renderer.js 只留装配与同名转发（机器清单）', () => {
  const { rendererSrc, indexSrc, moduleSrc, moduleCode } = loadSourceGate('command-items-ui.js');
  // ① 编排器里不许再长出第二份实现
  assert.equal(/function\s+buildCommandItems\s*\(/.test(rendererSrc), false, 'renderer.js 不许再有 buildCommandItems()');
  assert.equal(/function\s+commandItemsForPalette\s*\(/.test(rendererSrc), false, 'renderer.js 不许再有 commandItemsForPalette()');
  assert.equal(rendererSrc.includes('commandItemsCache'), false, 'renderer.js 不许再有缓存对象（M1 第二刀已搬走）');
  assert.match(moduleSrc, /function buildCommandItems\(\)/, '实现要在模块里');
  // ② 装配一次 + 同名转发（下面几处 host 接线 / syncChapterItemInfo 的调用点一个字不用改）
  assert.match(rendererSrc, /const commandItemsUiModule = window\.CWCommandItemsUi;/);
  assert.match(rendererSrc, /commandItemsUi = commandItemsUiModule\.create\(\{/, '必须装配 command-items-ui');
  assert.match(rendererSrc, /const \{ commandItemsForPalette \} = commandItemsUi;/, '只保留同名转发');
  assert.match(
    rendererSrc,
    /function markCommandsDirty\(\) \{\r?\n\s*if \(commandItemsUi\) commandItemsUi\.markCommandsDirty\(\);/,
    'markCommandsDirty 只留转发（保持函数声明，晚一步装配也能被 play 期调用）'
  );
  // ③ 装配清单 + index.html 都到位，且模块排在 renderer.js / 依赖的 assert-host 之后
  const entry = manifest.MODULES.find((item) => item[0] === 'command-items-ui.js');
  assert.ok(entry, '装配清单必须登记 command-items-ui.js');
  assert.equal(entry[1], 'CWCommandItemsUi');
  assert.equal(entry[2], 'commandItemsUiModule');
  assert.match(indexSrc, /<script src="command-items-ui\.js"><\/script>/, 'index.html 必须加载 command-items-ui.js');
  assert.ok(
    indexSrc.indexOf('<script src="command-items-ui.js"></script>') < indexSrc.indexOf('<script src="renderer.js"></script>'),
    'command-items-ui.js 必须排在 renderer.js 之前（renderer.js 装载期就 create）'
  );
  // ④ 模块本身仍是 UMD 双分支 + 依赖 assert-host（与其它 host 消费者同口径），运行时代码不 require 任何东西
  assert.match(moduleSrc, /root\.CWCommandItemsUi = factory\(root\.CWAssertHost && root\.CWAssertHost\.assertHost\);/);
  assert.match(moduleSrc, /assertHost\('createCommandItemsUi', host, REQUIRED_HOST\);/, '只许调用一次共享 assertHost');
  assert.equal(/require\(/.test(stripAssertHostBranch(moduleCode)), false, '运行时代码（剥掉 Node 分支后）不许 require');
});
