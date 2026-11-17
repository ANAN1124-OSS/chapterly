// v1.8.0 WP-34（D1 + V114）：主进程 IPC 结构拆分（registerIpc() 按域拆出导出 / 校对 / 书 CRUD）
// 与渲染层继续拆分 / state 字段收敛的回归锚点。
// 审计修复 #38（▲V306）：书域数据面（查找替换 / 历史 / 整理 / 快照清理 / 打开书文件夹）再下沉为
// ipc/book-data.js —— 本闸门跟着扩成「四个域」。
//
// 纪律（D-6 已定范围）：只拆四块，其余频道本版不动；**只搬不改行为** —— 所以这里钉的是
//   ① 四个域模块的频道清单 / 顺序 / 注册器种类（与搬前逐条一致）；
//   ② registerIpc() 只做装配（被搬走的频道不许在 main.js 里回潮），且行数降到可导航规模；
//   ③ 依赖注入的 host 契约：缺成员在装配时 TypeError；两个可变句柄（configStore / 剪贴板）走 getter；
//   ④ 频道总数不丢：main.js + ipc/*.js 的注册点 = 105（WP-34 后 104 + V302 的 chapter:rescue），
//      外加 WP5 崩溃草稿 4 个频道（110）；preload 的 invoke 全在其中；
//   ⑤ 渲染层：快捷键一览整段搬进 renderer/shortcuts-ui.js；state 动态字段全部收敛声明（reportedDirty）。
// 真实运行时的回归由 E2E 全量（重构类：PASS 名字与基线逐行一致）兜底。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// 统一按 LF 读：静态闸门里既有 `^` 多行锚点，也有按 `\n}\n` 切函数体（仓库工作区是 CRLF）。
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const IPC_FILES = ['ipc/book.js', 'ipc/book-data.js', 'ipc/proofread.js', 'ipc/export.js'];
const MAIN = read('main.js');
const IPC_SOURCE = IPC_FILES.map((rel) => read(rel)).join('\n');

// 四个域的频道清单（顺序 = 注册顺序）：搬前在 registerIpc() 里逐条内联，搬后必须一条不少、顺序不变。
const DOMAIN_CHANNELS = {
  export: [
    'book:export-plan',
    'book:export',
    'book:export-epub',
    'book:export-docx',
    'book:copy',
    'chapter:copy-platform',
    // 审计修复 #6（V302）：保存被 BOOK_MISSING / CHAPTER_MISSING 阻断时的救稿出口（另存 / 复制正文）。
    // 追加在导出域尾部（书 / 章文件可能已经不在，所以不走 handleBook、不碰书库）。
    'chapter:rescue'
  ],
  proofread: [
    'text:proofread',
    'proofread:words-info',
    'proofread:pick-words',
    'proofread:wordlists-add',
    'proofread:wordlists-remove',
    'sensitive:words-info',
    'sensitive:pick-words',
    'text:sensitive-check',
    'book:proofread',
    'book:sensitive-check'
  ],
  book: [
    'books:list',
    // WP18（B2）：书架增量刷新的单本书卡（只读，紧跟在 books:list 之后注册）
    'books:card',
    'book:create',
    'book:open',
    'book:verify',
    'book:rename',
    'book:update-info',
    'book:set-chapter-numbering',
    'book:set-last',
    'chapter:load',
    'chapter:stat',
    'chapter:create',
    'chapter:rename',
    'chapter:update-meta',
    'chapter:delete',
    'chapter:restore-deleted',
    'chapter:move',
    'volume:create',
    'volume:rename',
    'volume:delete',
    'chapter:move-to-volume',
    'volume:move',
    'chapter:move-to',
    'book:repair',
    'book:import',
    'book:delete'
  ],
  // 审计修复 #38（▲V306）：书域数据面从 main.js:2010-2110 整段下沉（13 个频道，顺序与搬前一致）。
  // WP4（审计 S-N1）在删除前插入「清理计划」频道，数据面变 14 个。
  'book-data': [
    'book:search',
    'book:replace',
    'book:list-replace-backups',
    'book:restore-replace-backup',
    'book:list-history',
    'book:preview-history-file',
    'book:restore-history-file',
    'book:restore-history-dir',
    'book:plan-delete-history-backups',
    'book:delete-history-backups',
    'book:clear-snapshot-day',
    'book:format-preview',
    'book:format',
    'shell:open-book-folder'
  ]
};
const ALL_DOMAIN_CHANNELS = Object.values(DOMAIN_CHANNELS).flat();
// 不走 handleBook 的频道（第一参数不是书路径）：正文 / 词表类走 handle，
// 书架列表 / 建书 / 导入的来源校验在各自入口里（ipc-paths / config-gate）。其余书相关频道一律 handleBook。
const PLAIN_HANDLE_CHANNELS = new Set([
  // 校对 / 敏感词：正文与词表都是渲染层传来的字符串，不碰书目录
  'text:proofread',
  'proofread:words-info',
  'proofread:pick-words',
  'proofread:wordlists-add',
  'proofread:wordlists-remove',
  'sensitive:words-info',
  'sensitive:pick-words',
  'text:sensitive-check',
  // 书架级：list 不带路径、create 只有书名、import 走 ipc-paths.importSourceDirs
  'books:list',
  'book:create',
  'book:import',
  // 审计修复 #6（V302）：第一个参数是编辑区正文（不是书路径）；书 / 章文件可能已经不在，
  // 所以这条救稿通道刻意不碰书库，详见 ipc/export.js 的实现注释。
  'chapter:rescue'
]);

// host 占位：handle / handleBook 换成记录器，其余成员给一个非 null 的占位函数 ——
// 注册期只做 destructuring + 频道登记，任何处理函数体都不会被执行。
function registerWithSpies(moduleRel) {
  const channels = [];
  const host = new Proxy(
    {},
    {
      get(target, key) {
        if (key === 'handle') return (channel) => channels.push({ kind: 'handle', channel });
        if (key === 'handleBook') return (channel) => channels.push({ kind: 'handleBook', channel });
        return () => {};
      },
      has: () => true
    }
  );
  require(path.join(ROOT, moduleRel)).register(host);
  return channels;
}

function registrationsOf(source) {
  const re = /^[ \t]+(handleBook|handle)\('([^']+)'/gm;
  const hits = [];
  let match;
  while ((match = re.exec(source))) hits.push({ kind: match[1], channel: match[2] });
  return hits;
}

test('WP-34：四个域模块的频道清单 / 顺序 / 注册器种类与搬前一致', () => {
  let total = 0;
  for (const [domain, expected] of Object.entries(DOMAIN_CHANNELS)) {
    const registered = registerWithSpies(`ipc/${domain}.js`);
    assert.deepEqual(
      registered.map((item) => item.channel),
      expected,
      `ipc/${domain}.js 注册的频道清单 / 顺序变了`
    );
    for (const item of registered) {
      assert.equal(
        item.kind,
        PLAIN_HANDLE_CHANNELS.has(item.channel) ? 'handle' : 'handleBook',
        `${item.channel} 的注册器种类变了（书路径参数必须走 handleBook）`
      );
    }
    total += registered.length;
  }
  assert.equal(total, ALL_DOMAIN_CHANNELS.length);
  // 57 = 搬走的三个域（104 个频道里的导出 6 + 校对 10 + 书 / 章 / 卷 25）+ 审计修复 #6 新增的
  // chapter:rescue + 审计修复 #38 下沉的书域数据面 13 个频道 + WP4 新增的清理计划频道
  // + WP18（B2）新增的 books:card。
  assert.equal(total, 57, '四个域的频道总数变了（多一个少一个都要同步本闸门）');
});

test('WP-34：host 契约缺成员在 register() 装配时直接 TypeError（与渲染层 A8 同一口径）', () => {
  assert.throws(
    () => require(path.join(ROOT, 'ipc', 'book.js')).register({ handle() {}, handleBook() {} }),
    /ipc\/book\.registerBookIpc 的 host 缺少 storage/,
    '缺依赖必须炸在装配阶段，不能留到点频道才 ReferenceError'
  );
  // 审计修复 #38（▲V306）：书域数据面模块同一口径（缺 storage 在装配时直接炸）。
  assert.throws(
    () => require(path.join(ROOT, 'ipc', 'book-data.js')).register({ handleBook() {} }),
    /ipc\/book-data\.registerBookDataIpc 的 host 缺少 storage/,
    'book-data 缺依赖也要炸在装配阶段'
  );
  assert.throws(
    () => require(path.join(ROOT, 'ipc', 'export.js')).register(null),
    /ipc\/export\.registerExportIpc 需要 host 对象/
  );
});

test('WP-34：registerIpc() 只装配 —— 被搬走的频道不许回潮，行数降到可导航规模', () => {
  // ① 56 个频道在 main.js 里一个都不许再注册
  for (const channel of ALL_DOMAIN_CHANNELS) {
    const patterns = [`handle('${channel}'`, `handleBook('${channel}'`];
    for (const pattern of patterns) {
      assert.equal(
        MAIN.includes(pattern),
        false,
        `main.js 里又出现了被搬走的频道注册：${pattern}（应只在 ipc/*.js 里）`
      );
    }
  }
  // ② 四个域各一次装配调用（顺序固定：书 CRUD / 书域数据面 / 校对 / 导出）
  const assembly = [
    'const domainHost = buildIpcHost();',
    'ipcBook.register(domainHost);',
    'ipcBookData.register(domainHost);',
    'ipcProofread.register(domainHost);',
    'ipcExport.register(domainHost);'
  ];
  for (const line of assembly) assert.ok(MAIN.includes(line), `registerIpc() 缺装配行：${line}`);
  // ③ registerIpc() 从 1,802 行降到 1,100 行以内（D-6 目标「约降 40%」，实际约 48%）
  const start = MAIN.indexOf('function registerIpc() {');
  assert.ok(start > 0, '找不到 registerIpc()');
  const end = MAIN.indexOf('\n}\n', start);
  assert.ok(end > start, 'registerIpc() 没有按预期结束');
  const lines = MAIN.slice(start, end).split('\n').length;
  assert.ok(lines < 1100, `registerIpc() 仍有 ${lines} 行（搬前 1,802 行，目标 < 1,100）`);
});

test('WP-34：模块自己不 require electron；依赖由 main.js 的 buildIpcHost() 一次性注入', () => {
  for (const rel of IPC_FILES) {
    const source = read(rel);
    assert.equal(source.includes("require('electron')"), false, `${rel} 不该 require electron（装配面只在 main.js）`);
    assert.match(source, /require\('\.\.\/renderer\/assert-host'\)/, `${rel} 的 host 校验要走 A8 的共享实现`);
    assert.match(source, /module\.exports = \{ register: /, `${rel} 只导出 register 一个入口`);
    assert.match(source, /(V114|▲V306)/, `${rel} 的模块头要写明搬移来源（V114 / 审计修复 #38）`);
    assert.match(source, /只搬不改行为/, `${rel} 的模块头要写明「只搬不改行为」的纪律`);
  }
  assert.ok(MAIN.includes('function buildIpcHost()'), 'main.js 要有唯一的依赖装配点 buildIpcHost()');
  // 两个可变句柄必须是 getter：configStore 在 getConfig() 里懒建、activeClipboard 会被自检宿主替换
  assert.ok(MAIN.includes('getConfigStore: () => configStore'), 'configStore 必须按引用现取（getter）');
  assert.ok(MAIN.includes('getClipboard: () => activeClipboard'), '剪贴板句柄必须按引用现取（getter）');
  assert.ok(read('ipc/proofread.js').includes('await getConfigStore().set('), '词表落盘走 getter 现取');
  assert.ok(read('ipc/export.js').includes('getClipboard().writeText('), '复制走 getter 现取');
  assert.equal(IPC_SOURCE.includes('configStore.set('), false, 'ipc 模块里不许直呼 configStore.set(');
  assert.equal(IPC_SOURCE.includes('activeClipboard.writeText('), false, 'ipc 模块里不许直呼 activeClipboard');
});

test('WP-34：频道总数不丢（main + ipc = 111），preload 的 invoke 全在注册点里', () => {
  const registered = registrationsOf(MAIN + '\n' + IPC_SOURCE);
  // 111 = 搬前 104 + 审计修复 #6（V302）新增的 chapter:rescue（导出域尾部）+ WP4 清理计划频道
  //       + WP5 崩溃草稿的 crash:draft / crash:recovery / crash:read-draft / crash:discard-draft
  //       + WP18（B2）的 books:card（书架增量刷新，只读）
  assert.equal(registered.length, 111, '主进程 IPC 注册点数量与「搬前 104 + V302 的 chapter:rescue + WP4 计划频道 + WP5 崩溃草稿 4 频道 + WP18 的 books:card」不一致');
  assert.equal(new Set(registered.map((item) => item.channel)).size, 111, '有频道被重复注册');
  const all = new Set(registered.map((item) => item.channel));
  for (const channel of ALL_DOMAIN_CHANNELS) assert.ok(all.has(channel), `频道总数里找不到 ${channel}`);
  const preload = read('preload.js');
  const invoked = [...preload.matchAll(/invoke\('([^']+)'/g)].map((match) => match[1]);
  assert.ok(invoked.length > 80, `preload invoke 数量异常：${invoked.length}`);
  const missing = invoked.filter((channel) => !all.has(channel));
  assert.deepEqual(missing, [], 'preload 调用了主进程没注册的频道');
});

test('WP-34：渲染层 state 动态字段收敛声明（state.<field> = 一律先声明）', () => {
  const RENDERER = read('renderer/renderer.js');
  const start = RENDERER.indexOf('const state = {');
  assert.ok(start > 0, '找不到 renderer.js 的 state 字面量');
  const end = RENDERER.indexOf('\n  };', start);
  assert.ok(end > start, 'state 字面量没有按预期结束');
  const literal = RENDERER.slice(start, end);
  // 顶层字段 4 空格、嵌套对象字段 6 空格（更深层是子结构的内部字段，不在这里收）
  const declared = new Set();
  for (const line of literal.split('\n')) {
    const match = /^ {4,6}([A-Za-z_$][\w$]*):/.exec(line);
    if (match) declared.add(match[1]);
  }
  const assigned = new Set();
  const assignRe = /state\.([A-Za-z_$][\w$]*)\s*(?:=(?!=)|\+\+|--|\+=|-=|\|\|=|&&=)/g;
  let match;
  while ((match = assignRe.exec(RENDERER))) assigned.add(match[1]);
  const missing = [...assigned].filter((name) => !declared.has(name)).sort();
  assert.deepEqual(missing, [], `这些 state 字段没在 state 字面量里声明：${missing.join(', ')}`);
  // 审计 D1 点名的动态字段：reportedDirty 已在声明表里（初值 null = 还没同步过，
  // 首帧仍会让主进程收到一次 false，与补声明前逐字一致）
  assert.match(literal, /reportedDirty: null/, 'reportedDirty 要收敛进 state 声明（初值 null）');
});

test('WP-34：渲染层快捷键一览搬进 renderer/shortcuts-ui.js，renderer.js 只装配', () => {
  const RENDERER = read('renderer/renderer.js');
  const MODULE = read('renderer/shortcuts-ui.js');
  const HTML = read('renderer/index.html');
  // 模块：UMD + A8 共享 host 校验 + 唯一入口 create
  assert.match(MODULE, /root\.CWShortcutsUi = factory\(/, '浏览器里要挂成 CWShortcutsUi');
  assert.match(MODULE, /require\('\.\/assert-host'\)/, 'host 校验要走 A8 的共享实现');
  assert.match(MODULE, /const REQUIRED_HOST = \['\$', 'state', 'editorEl', 'commandCatalog', 'groupLabels'\]/);
  // renderer.js：不许再有第二份一览页实现，只装配模块并按原名取入口
  for (const fn of ['function renderShortcutRows(', 'function openShortcutsPage(', 'function closeShortcutsPage(', 'function shortcutRows(']) {
    assert.equal(RENDERER.includes(fn), false, `renderer.js 里不该再有 ${fn}`);
  }
  assert.match(RENDERER, /const shortcutsUiModule = window\.CWShortcutsUi;/, 'renderer.js 要取模块全局');
  assert.match(RENDERER, /shortcutsUiModule\.create\(\{/, 'renderer.js 要装配 create(host)');
  assert.match(RENDERER, /const \{ openShortcutsPage, closeShortcutsPage \} = shortcutsUi;/, '入口按原名解构（Esc 链 / 按钮继续调用）');
  // index.html 顺序：assert-host → shortcuts-ui → renderer.js（渲染层所有 host 消费者的老口径）
  const tag = '<script src="shortcuts-ui.js"></script>';
  const at = HTML.indexOf(tag);
  assert.ok(at > 0, 'index.html 必须加载 shortcuts-ui.js');
  assert.equal(HTML.split(tag).length - 1, 1, 'shortcuts-ui.js 只许加载一次');
  assert.ok(HTML.indexOf('<script src="assert-host.js"></script>') < at, 'assert-host.js 必须排在 shortcuts-ui.js 之前');
  assert.ok(at < HTML.indexOf('<script src="renderer.js"></script>'), 'shortcuts-ui.js 必须排在 renderer.js 之前');
  // 不维护第二份快捷键表（系统键表只在 command-catalog.js）
  assert.equal(MODULE.includes('SYSTEM_KEYS'), false, '系统键表只许在 command-catalog.js');
  assert.equal(MODULE.includes("'Ctrl+K'"), false, '快捷键一览模块里不许硬编码键帽');
});

test('WP-34：shortcuts-ui 行为（行来自目录 / 开合 / 焦点归还）零变化', () => {
  const shortcuts = require(path.join(ROOT, 'renderer', 'shortcuts-ui.js'));
  const rows = [
    { id: 'save', group: 'command', groupLabel: '命令', title: '保存', kbd: 'Ctrl+S' },
    { id: 'sys-k', group: 'system', groupLabel: '系统键', title: '命令面板', kbd: 'Ctrl+K', scope: '写作页 / 书架' }
  ];
  const makeEl = () => ({
    className: '',
    textContent: '',
    dataset: {},
    attrs: {},
    children: [],
    appendChild(child) {
      this.children.push(child);
    },
    setAttribute(key, value) {
      this.attrs[key] = value;
    }
  });
  const hidden = new Set(['hidden']);
  const closeBtn = {
    focused: false,
    focus() {
      this.focused = true;
    }
  };
  const backdrop = {
    classList: {
      contains: (name) => hidden.has(name),
      add: (name) => hidden.add(name),
      remove: (name) => hidden.delete(name)
    },
    contains: (el) => el === closeBtn
  };
  const list = makeEl();
  const elements = { 'shortcuts-backdrop': backdrop, 'shortcuts-list': list, 'btn-shortcuts-close': closeBtn };
  const editorEl = {
    focused: false,
    focus() {
      this.focused = true;
    }
  };
  const realDocument = globalThis.document;
  globalThis.document = {
    activeElement: null,
    body: { tag: 'body' },
    documentElement: { tag: 'html' },
    createElement: () => makeEl()
  };
  try {
    const seen = [];
    const ui = shortcuts.create({
      $: (id) => elements[id] || null,
      state: { view: 'editor', bookPath: 'D:\\书' },
      editorEl,
      commandCatalog: {
        shortcutRows: (labels) => {
          seen.push(labels);
          return rows;
        }
      },
      groupLabels: { command: '命令' }
    });
    assert.equal(ui.shortcutsOpen(), false, '一开始是关着的');
    assert.equal(ui.openShortcutsPage(), true, '首次打开成功');
    assert.equal(ui.shortcutsOpen(), true);
    assert.equal(ui.openShortcutsPage(), false, '已开着再按 ? 不重复打开');
    assert.deepEqual(seen, [{ command: '命令' }], '行数据来自命令目录（分组标签原样传进去）');
    // 两行分属两组：组标题 + 行 = 4 个节点；系统键那行带 scope 列
    assert.equal(list.children.length, 4);
    assert.equal(list.children[0].className, 'shortcut-group');
    assert.equal(list.children[0].textContent, '命令');
    assert.equal(list.children[2].textContent, '系统键');
    assert.equal(list.children[3].children.length, 3, '系统键行 = 标题 + 作用范围 + 键帽');
    assert.equal(closeBtn.focused, true, '打开时焦点落到右上关闭按钮');
    // 焦点还在弹层里 → 关闭时还给编辑区（state.view = editor 且开着书）
    globalThis.document.activeElement = closeBtn;
    assert.equal(ui.closeShortcutsPage(), true);
    assert.equal(ui.shortcutsOpen(), false);
    assert.equal(editorEl.focused, true, '焦点掉在弹层里 → 关闭时还给编辑区');
    assert.equal(ui.closeShortcutsPage(), false, '已经关着再关不做事');
  } finally {
    if (realDocument === undefined) delete globalThis.document;
    else globalThis.document = realDocument;
  }
});