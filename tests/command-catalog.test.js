// 单测：命令目录（1.6.0 F4a / 审计 O-2「命令表从渲染层搬家」）。
//
// 这一项只搬数据、不改行为，所以锚点钉两件事：
//   ① 条目表与搬家前逐字一致（id / 标题 / 分组 / 键帽 / 关键词 / 视图条件 / 动作接线）；
//   ② 静态闸门：命令数据只在 renderer/command-catalog.js 这一份，renderer.js 只剩装配
//      （不再内嵌 `cmd:` 条目与 `kbd:` 键帽），index.html 先载目录再载渲染层。
//
// 数据表是搬家当刻从 renderer.js 的 commandDefs() 抄下来的**快照**（23 条命令 / 8 条带键帽），
// 不是从实现里反推的——实现改了这里必须跟着改，改不动就说明这次搬家动了行为。
const test = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const RENDERER = read('renderer/renderer.js');
const INDEX = read('renderer/index.html');

// 搬家前的现役命令表（顺序也要一致：`?` 页按声明顺序排、命令面板空查询按组权重排）。
// 字段：id / 标题 / 分组 / 键帽（'' = 没有）/ 关键词（逗号串）/ 视图条件 / 动作名
const GOLDEN = [
  ['cmd:shelf', '回到书架', 'command', '', 'shelf,书架', 'always', 'backToShelf'],
  ['cmd:new-book', '新建一本书', 'command', '', 'new book,新建', 'shelf', 'newBook'],
  ['cmd:import', '导入小说…', 'command', '', 'import,导入', 'shelf', 'importBook'],
  ['cmd:settings', '打开设置（全局）', 'command', '', 'settings,设置', 'always', 'openSettings'],
  ['cmd:book-display', '正文显示设置（这本书）', 'command', '', 'display,显示,按书', 'editor', 'openBookDisplaySettings'],
  ['cmd:save', '保存本章', 'command', 'Ctrl+S', 'save,保存', 'editor', 'saveCurrent'],
  ['cmd:new-chapter', '新建章节', 'command', 'Ctrl+N', 'new chapter,新建章节', 'editor', 'newChapter'],
  ['cmd:rename-chapter', '重命名本章', 'command', 'F2', 'rename,重命名', 'editor', 'renameChapter'],
  ['cmd:delete-chapter', '删除本章（可撤销）', 'command', 'Delete', 'delete,删除', 'editor', 'deleteChapter'],
  ['cmd:format-chapter', '整理本章', 'command', '', 'format,整理,排版', 'editor', 'formatChapter'],
  ['cmd:find', '查找替换', 'command', 'Ctrl+F', 'find,查找,替换', 'editor', 'openFindPanel'],
  ['cmd:jump', '跳到章…', 'command', 'Ctrl+G', 'jump,跳章', 'editor', 'openJumpDialog'],
  ['cmd:focus', '专注模式', 'command', 'F11', 'focus,专注', 'editor', 'toggleFocusMode'],
  ['cmd:reading', '阅读模式', 'command', '', 'reading,阅读', 'editor', 'openReadingMode'],
  ['cmd:tts', '朗读本章', 'command', '', 'tts,朗读', 'editor', 'openTtsBar'],
  ['cmd:proofread', '校对', 'command', '', 'proofread,校对', 'book', 'openProofreadPanel'],
  ['cmd:sensitive', '敏感词预检', 'command', '', 'sensitive,敏感词', 'book', 'openSensitivePanel'],
  ['cmd:history', '本书历史', 'command', '', 'history,历史,备份', 'book', 'openHistory'],
  ['cmd:fragments', '插入碎片…', 'command', '', 'fragment,碎片,灵感箱', 'book', 'openFragments'],
  ['cmd:capture', '剪贴板捕获', 'command', 'Ctrl+Alt+V', 'capture,剪贴板', 'editor', 'openCapture'],
  ['cmd:bookinfo', '书籍信息', 'command', '', 'book info,书籍信息,作者,标签', 'book', 'openBookInfo'],
  ['cmd:folder', '打开本书文件夹', 'command', '', 'folder,文件夹', 'book', 'openBookFolder'],
  ['cmd:check-update', '检查更新', 'command', '', 'update,更新', 'shelf', 'checkUpdate']
];

// 四个视图：书架 / 写作页（有书）/ 写作页（没书，瞬态）/ 书架但 state 里还留着 bookPath
const VIEWS = [
  { name: '书架', value: { view: 'shelf', bookPath: '' } },
  { name: '写作页·有书', value: { view: 'editor', bookPath: 'D:/临时/书' } },
  { name: '写作页·无书', value: { view: 'editor', bookPath: '' } },
  { name: '书架·残留 bookPath', value: { view: 'shelf', bookPath: 'D:/临时/书' } }
];

// 与现役 when() 同口径：shelf 只看视图，editor 要「写作页 + 有书」，book 只看有没有书。
function expectedAvailable(kind, view) {
  if (kind === 'always') return true;
  if (kind === 'shelf') return view.view === 'shelf';
  if (kind === 'editor') return view.view === 'editor' && Boolean(view.bookPath);
  if (kind === 'book') return Boolean(view.bookPath);
  throw new Error(`未知视图条件：${kind}`);
}

function makeHandlers(overrides) {
  const out = {};
  for (const row of GOLDEN) {
    const name = row[6];
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, name)) {
      out[name] = overrides[name];
      continue;
    }
    const fn = function handler() {};
    fn.handlerKey = name;
    out[name] = fn;
  }
  return out;
}

function buildDefs(catalog, view, handlers) {
  const map = handlers || makeHandlers();
  return catalog.createCommandDefs({ getView: () => view, handlers: map });
}

test('命令目录：23 条命令的 id / 标题 / 分组 / 键帽 / 关键词与搬家前一致', () => {
  const catalog = require(path.join(ROOT, 'renderer', 'command-catalog.js'));
  const defs = buildDefs(catalog, VIEWS[1].value);
  assert.equal(defs.length, GOLDEN.length, '命令条目数变了（搬家只许搬运、不许增删）');
  defs.forEach((def, index) => {
    const row = GOLDEN[index];
    assert.equal(def.id, row[0], `第 ${index + 1} 条 id 变了`);
    assert.equal(def.title, row[1], `${row[0]} 的标题变了`);
    assert.equal(def.group, row[2], `${row[0]} 的分组变了`);
    assert.deepEqual(def.keywords, row[4] ? row[4].split(',') : [], `${row[0]} 的关键词变了`);
    if (row[3]) assert.equal(def.kbd, row[3], `${row[0]} 的键帽变了`);
    else assert.equal(def.kbd, undefined, `${row[0]} 没有键帽，不该凭空多一个`);
  });
  assert.equal(defs.filter((def) => def.kbd).length, 8, '带键帽的命令仍是 8 条');
});

test('命令目录：视图条件与现役一致（书架 / 写作页 / 有没有书）', () => {
  const catalog = require(path.join(ROOT, 'renderer', 'command-catalog.js'));
  for (const view of VIEWS) {
    const defs = buildDefs(catalog, view.value);
    defs.forEach((def, index) => {
      const row = GOLDEN[index];
      const expected = expectedAvailable(row[5], view.value);
      if (row[5] === 'always') {
        assert.equal(def.when, undefined, `${row[0]} 永远可用，不该带 when`);
      } else if (expected) {
        assert.equal(typeof def.when, 'function', `${row[0]} 在「${view.name}」应可见，但 when 不是函数`);
        assert.equal(def.when(), true, `${row[0]} 在「${view.name}」应可见`);
      } else if (typeof def.when === 'function') {
        assert.equal(def.when(), false, `${row[0]} 在「${view.name}」不该可见`);
      }
    });
  }
});

test('命令目录：每条命令都接到对应动作（缺一个立刻抛 TypeError，不静默少条目）', () => {
  const catalog = require(path.join(ROOT, 'renderer', 'command-catalog.js'));
  const defs = buildDefs(catalog, VIEWS[0].value);
  defs.forEach((def, index) => {
    assert.equal(typeof def.run, 'function', `${GOLDEN[index][0]} 没有接上动作`);
    assert.equal(def.run.handlerKey, GOLDEN[index][6], `${GOLDEN[index][0]} 接错了动作`);
  });
  const broken = makeHandlers();
  delete broken.saveCurrent;
  assert.throws(
    () => catalog.createCommandDefs({ getView: () => VIEWS[1].value, handlers: broken }),
    /缺少动作：saveCurrent/,
    '缺动作时必须在装配阶段炸，而不是运行时点了没反应'
  );
});

test('命令目录：静态闸门——数据只在目录模块，renderer.js 只剩装配、index.html 先载目录', () => {
  const catalogPath = path.join(ROOT, 'renderer', 'command-catalog.js');
  const catalog = require(catalogPath);
  assert.equal(typeof catalog.createCommandDefs, 'function', '目录模块要导出 createCommandDefs');

  // ① 数据搬家：renderer.js 里不再有命令条目（id / 键帽）。用计数钉，避免只删了一部分还过。
  assert.equal((RENDERER.match(/cmd:/g) || []).length, 0, 'renderer.js 里还有命令 id（数据没搬干净）');
  assert.equal((RENDERER.match(/kbd: '/g) || []).length, 0, 'renderer.js 里还有键帽数据（数据没搬干净）');
  assert.match(RENDERER, /commandCatalog\.createCommandDefs\(/, 'renderer.js 要用装配方式取命令表');

  // ② 加载顺序：目录在命令面板 UI / 渲染层之前。
  const catalogTag = INDEX.indexOf('<script src="command-catalog.js"></script>');
  const rendererTag = INDEX.indexOf('<script src="renderer.js"></script>');
  assert.ok(catalogTag > 0, 'index.html 没加载 command-catalog.js');
  assert.ok(rendererTag > 0, 'index.html 没加载 renderer.js');
  assert.ok(catalogTag < rendererTag, 'command-catalog.js 必须排在 renderer.js 之前');
  assert.ok(
    INDEX.indexOf('<script src="command-registry.js"></script>') > catalogTag,
    'command-catalog.js 排在命令面板相关模块之前'
  );

  // ③ 目录模块是纯数据 + 纯映射：不碰 DOM / 文件 / Electron / 定时器。
  const catalogSrc = read('renderer/command-catalog.js');
  assert.match(catalogSrc, /typeof module === 'object'/, '目录模块要按 UMD 写（Node 单测与浏览器共用）');
  assert.match(catalogSrc, /root\.CWCommandCatalog/);
  assert.ok(!/\bdocument\./.test(catalogSrc), '目录模块不许碰 DOM');
  assert.ok(!/require\(['"](?:node:)?(?:fs|path|electron)/.test(catalogSrc), '目录模块不许碰文件 / Electron');
  assert.ok(!/\bsetTimeout\s*\(/.test(catalogSrc), '目录模块不许起定时器');
});