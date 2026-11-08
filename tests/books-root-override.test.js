// A3（审计 #9 / O1）：`booksRootOverride`（--books-root）收成单一装饰层。
//
// 背景：这个开关只在打包版冒烟用（把书架指到临时副本），但它决定 assertBookPath 认哪个根目录。
// 以前 main.js 的 8 个配置写入口各抄一份 `config = booksRootOverride ? {...updated, booksRoot: ...} : updated`，
// 新增写入口漏抄一处就会出现「界面显示 A、路径校验按 B」的口径漂移。
//
// 这里钉住两条：
//   1. 纯函数 `withBooksRootOverride` 的两种口径（为空原样返回 / 有值只覆盖 booksRoot、不写盘）；
//   2. main.js 里覆盖只在装饰层出现一次，且每个配置写入口都走 applyConfig（静态闸门，沿用
//      tests/startup-guard.test.js 的读源码先例：main.js 起不来，只能在源码上做闸门）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createConfigStore, withBooksRootOverride, DEFAULTS } = require('../core/config');

const tmpCleanup = require('./tmp-cleanup');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');

// 取一段源码：从锚点切到结束锚点之前（用 includes 定位，不依赖行号）。
function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `找不到锚点：${startMarker}`);
  const rest = source.slice(start);
  const end = rest.indexOf(endMarker);
  assert.notEqual(end, -1, `找不到结束锚点：${endMarker}`);
  return rest.slice(0, end);
}

test('行为：--books-root 为空时原样返回同一只配置对象（零拷贝、不改写）', () => {
  const cfg = { booksRoot: 'D:\\real\\library', lastBook: null, editorFont: 'serif' };
  for (const empty of [null, undefined, '']) {
    const out = withBooksRootOverride(cfg, empty);
    assert.equal(out, cfg, `override=${String(empty)} 时必须原样返回（旧行为是不复制对象）`);
  }
});

test('行为：--books-root 有值时只覆盖 booksRoot，不改原对象、不动其它字段', () => {
  const cfg = { booksRoot: 'D:\\real\\library', lastBook: { path: 'D:\\real\\library\\书' }, editorFontSize: 20 };
  const out = withBooksRootOverride(cfg, 'D:\\tmp\\e2e-library');
  assert.notEqual(out, cfg, '有覆盖时必须换一只对象（不能就地改缓存里的 config）');
  assert.equal(out.booksRoot, 'D:\\tmp\\e2e-library');
  assert.equal(out.lastBook, cfg.lastBook, '其它字段照旧透传');
  assert.equal(out.editorFontSize, 20);
  assert.equal(cfg.booksRoot, 'D:\\real\\library', '调用方的 config 不能被改（否则重启 / 回退会指向临时目录）');
});

test('行为：覆盖只影响进程内视图，config.json 里存的书架目录不变', async () => {
  const dir = tmpCleanup.track(await fsp.mkdtemp(path.join(os.tmpdir(), 'cw-books-root-override-')));
  const store = createConfigStore(dir);
  const stored = await store.get();
  assert.equal(stored.booksRoot, DEFAULTS.booksRoot, '配置仓库按默认书架目录加载');
  // 先落一次盘（首次启动没有 config.json 时仓库不会自己写），再看覆盖有没有被带进文件
  await store.set({ dailyGoal: 1200 });
  const view = withBooksRootOverride(stored, path.join(dir, 'tmp-library'));
  assert.equal(view.booksRoot, path.join(dir, 'tmp-library'), '进程内视图指向覆盖目录');
  assert.equal((await store.get()).booksRoot, DEFAULTS.booksRoot, '仓库缓存仍是真的书架目录（覆盖不落盘）');
  const onDisk = JSON.parse((await fsp.readFile(store.file, 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(onDisk.booksRoot, DEFAULTS.booksRoot, '--books-root 不许写进 config.json（否则下次正常启动会指向临时目录）');
  assert.equal(onDisk.dailyGoal, 1200, '其它配置照常落盘');
});

test('静态闸门：main.js 只有装饰层这一处应用 --books-root 覆盖', () => {
  // 旧形（8 处同形复制）不许回来
  assert.doesNotMatch(MAIN, /booksRoot:\s*booksRootOverride/, '覆盖只在 core/config.withBooksRootOverride 里做');
  assert.doesNotMatch(MAIN, /booksRootOverride\s*\?/, '不再有 booksRootOverride 三元复制');
  assert.doesNotMatch(MAIN, /config = await configStore\.get\(\)/, '配置仓库的返回值必须先过装饰层再缓存');

  const decorate = slice(MAIN, 'function decorateConfig(raw) {', '\n}\n');
  assert.match(decorate, /withBooksRootOverride\(raw, booksRootOverride\)/, '装饰层调用共用的纯函数');
  const apply = slice(MAIN, 'function applyConfig(raw) {', '\n}\n');
  assert.match(apply, /config = decorateConfig\(raw\);/, 'applyConfig 是配置缓存的唯一写入口');
  const get = slice(MAIN, 'async function getConfig() {', '\n}\n');
  assert.match(get, /config = decorateConfig\(await configStore\.get\(\)\);/, 'getConfig 首次加载也要过装饰层');
  // 装饰层必须只有一处：去掉行注释后，booksRootOverride 只应剩下「声明 + 装饰层实参」两处
  const codeOnly = MAIN.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
  assert.equal(
    (codeOnly.match(/booksRootOverride/g) || []).length,
    2,
    'booksRootOverride 只允许在声明与装饰层各出现一次（不许再有第二处覆盖复制）'
  );
});

test('静态闸门：每个配置写入口都走 applyConfig（不许绕过装饰层）', () => {
  const sites = [
    ['rememberExportDir', 'async function rememberExportDir(dir) {', '\n}\n'],
    ['rememberRecentBook', 'async function rememberRecentBook(bookPath, info) {', '\n}\n'],
    ['config:set', "handle('config:set'", '\n  });'],
    ['book:set-display', "handle('book:set-display'", '\n  });'],
    ['book:reset-display', "handle('book:reset-display'", '\n  });'],
    ['find:bookmark-save', "handle('find:bookmark-save'", '\n  });'],
    ['find:bookmark-remove', "handle('find:bookmark-remove'", '\n  });']
  ];
  for (const [name, start, end] of sites) {
    const body = slice(MAIN, start, end);
    assert.ok(body.includes('applyConfig('), `${name} 写完配置必须走 applyConfig 更新缓存（否则界面与路径校验口径漂移）`);
  }
  // config:set 的 mkdir 目标同样过装饰层（--books-root 时就是覆盖目录）
  const setBody = slice(MAIN, "handle('config:set'", '\n  });');
  assert.match(
    setBody,
    /decorateConfig\(sanitizeConfig\(\{ \.\.\.current, \.\.\.gated\.patch \}\)\)\.booksRoot/,
    'config:set 的 mkdir 目标要过装饰层，不能被 patch 带偏'
  );
});

test('静态闸门：打包版仍认 --books-root，理由写在装饰层注释里（安装版冒烟）', () => {
  assert.match(MAIN, /const booksRootOverride = argValue\('books-root'\);/, '--books-root 仍要认（S1 已记录保留）');
  const decorateComment = slice(MAIN, '// A3（审计 #9 / O1）：booksRootOverride 的唯一装饰层', 'function decorateConfig(raw) {');
  assert.match(decorateComment, /打包版刻意保留 --books-root/, '必须写明为什么打包版还认这个开关');
  assert.match(decorateComment, /安装版冒烟/, '理由要与实际用途一致：安装版冒烟指向临时副本');
  assert.match(decorateComment, /assertBookPath/, '必须点明这条口径决定路径校验认哪个根目录');
});
