/* 命令目录（1.6.0 F4a / 审计 O-2：命令表从渲染层搬家）。
 *
 * 为什么单独一个模块：命令表原来内嵌在 9500 行的 renderer.js 里（commandDefs() 的数组），
 * 加一条命令要翻到渲染层中间改数据、还得顺手接动作，两件事缠在一起。搬到这里以后：
 *   · 命令数据（id / 标题 / 分组 / 键帽 / 关键词 / 视图条件 / 动作名）只有这一份；
 *   · renderer.js 只保留「装配」——把动作函数按名字接上（handlers 少一个就立刻抛，不静默少条目）。
 *
 * 契约（纯数据 + 纯映射：不碰 DOM、IPC、文件、配置、定时器）：
 *   createCommandDefs({ getView, handlers })
 *     → [{ id, title, group, kbd?, keywords, when?(), run() }]，顺序 = 声明顺序（`?` 页按它排）。
 *     getView() 每次现算 { view, bookPath }，when 的判定与原来闭包读 state 完全同口径：
 *       editor = 写作页且开着书；book = 只要开着书（视图不限）；shelf = 书架页。
 *     handlers = { 动作名: 函数 }；缺一个抛 TypeError（装配错误要炸在启动阶段）。
 * 声明表（COMMAND_SPECS）是模块内数据，不对外导出——产品侧只需要 createCommandDefs，
 * 多一个出口就多一份「谁也说不清谁在用」的导出面（sweep ⑤b 口径）。
 *
 * 浏览器里挂成全局 CWCommandCatalog（index.html 排在 renderer.js 之前），Node 里可直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWCommandCatalog = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 视图条件：只认「当前视图 + 有没有打开书」两个值，不把整个 state 传进来。
  const VIEW_RULES = {
    editor: (view) => view.view === 'editor' && Boolean(view.bookPath),
    book: (view) => Boolean(view.bookPath),
    shelf: (view) => view.view === 'shelf'
  };

  // 命令声明表（顺序就是 `?` 页的排列顺序）。
  //   run    = handlers 里的动作名（真正实现在 renderer.js，这里只写名字）；
  //   when   = VIEW_RULES 的键；不写 = 永远可用；
  //   kbd    = 命令面板行尾键帽 / `?` 页行尾键帽（键位文案只有这一份）。
  const COMMAND_SPECS = [
    { id: 'cmd:shelf', title: '回到书架', group: 'command', keywords: ['shelf', '书架'], run: 'backToShelf' },
    { id: 'cmd:new-book', title: '新建一本书', group: 'command', keywords: ['new book', '新建'], when: 'shelf', run: 'newBook' },
    { id: 'cmd:import', title: '导入小说…', group: 'command', keywords: ['import', '导入'], when: 'shelf', run: 'importBook' },
    { id: 'cmd:settings', title: '打开设置（全局）', group: 'command', keywords: ['settings', '设置'], run: 'openSettings' },
    { id: 'cmd:book-display', title: '正文显示设置（这本书）', group: 'command', keywords: ['display', '显示', '按书'], when: 'editor', run: 'openBookDisplaySettings' },
    { id: 'cmd:save', title: '保存本章', group: 'command', kbd: 'Ctrl+S', keywords: ['save', '保存'], when: 'editor', run: 'saveCurrent' },
    { id: 'cmd:new-chapter', title: '新建章节', group: 'command', kbd: 'Ctrl+N', keywords: ['new chapter', '新建章节'], when: 'editor', run: 'newChapter' },
    { id: 'cmd:rename-chapter', title: '重命名本章', group: 'command', kbd: 'F2', keywords: ['rename', '重命名'], when: 'editor', run: 'renameChapter' },
    { id: 'cmd:delete-chapter', title: '删除本章（可撤销）', group: 'command', kbd: 'Delete', keywords: ['delete', '删除'], when: 'editor', run: 'deleteChapter' },
    { id: 'cmd:format-chapter', title: '整理本章', group: 'command', keywords: ['format', '整理', '排版'], when: 'editor', run: 'formatChapter' },
    { id: 'cmd:find', title: '查找替换', group: 'command', kbd: 'Ctrl+F', keywords: ['find', '查找', '替换'], when: 'editor', run: 'openFindPanel' },
    { id: 'cmd:jump', title: '跳到章…', group: 'command', kbd: 'Ctrl+G', keywords: ['jump', '跳章'], when: 'editor', run: 'openJumpDialog' },
    { id: 'cmd:focus', title: '专注模式', group: 'command', kbd: 'F11', keywords: ['focus', '专注'], when: 'editor', run: 'toggleFocusMode' },
    { id: 'cmd:reading', title: '阅读模式', group: 'command', keywords: ['reading', '阅读'], when: 'editor', run: 'openReadingMode' },
    { id: 'cmd:tts', title: '朗读本章', group: 'command', keywords: ['tts', '朗读'], when: 'editor', run: 'openTtsBar' },
    { id: 'cmd:proofread', title: '校对', group: 'command', keywords: ['proofread', '校对'], when: 'book', run: 'openProofreadPanel' },
    { id: 'cmd:sensitive', title: '敏感词预检', group: 'command', keywords: ['sensitive', '敏感词'], when: 'book', run: 'openSensitivePanel' },
    { id: 'cmd:history', title: '本书历史', group: 'command', keywords: ['history', '历史', '备份'], when: 'book', run: 'openHistory' },
    { id: 'cmd:fragments', title: '插入碎片…', group: 'command', keywords: ['fragment', '碎片', '灵感箱'], when: 'book', run: 'openFragments' },
    { id: 'cmd:capture', title: '剪贴板捕获', group: 'command', kbd: 'Ctrl+Alt+V', keywords: ['capture', '剪贴板'], when: 'editor', run: 'openCapture' },
    { id: 'cmd:bookinfo', title: '书籍信息', group: 'command', keywords: ['book info', '书籍信息', '作者', '标签'], when: 'book', run: 'openBookInfo' },
    { id: 'cmd:folder', title: '打开本书文件夹', group: 'command', keywords: ['folder', '文件夹'], when: 'book', run: 'openBookFolder' },
    { id: 'cmd:check-update', title: '检查更新', group: 'command', keywords: ['update', '更新'], when: 'shelf', run: 'checkUpdate' }
  ];

  // 装配：把声明表的动作名换成 renderer.js 传进来的函数，并给 when 包一层现算。
  function createCommandDefs(host) {
    const options = host || {};
    const getView = options.getView;
    const handlers = options.handlers;
    if (typeof getView !== 'function') throw new TypeError('createCommandDefs 需要 getView 函数');
    if (!handlers || typeof handlers !== 'object') throw new TypeError('createCommandDefs 需要 handlers 对象');
    return COMMAND_SPECS.map((spec) => {
      const run = handlers[spec.run];
      if (typeof run !== 'function') throw new TypeError(`命令目录缺少动作：${spec.run}`);
      const def = {
        id: spec.id,
        title: spec.title,
        group: spec.group,
        keywords: spec.keywords.slice(),
        run
      };
      if (spec.kbd) def.kbd = spec.kbd;
      if (spec.when) {
        const rule = VIEW_RULES[spec.when];
        def.when = () => rule(getView() || {});
      }
      return def;
    });
  }

  return {
    createCommandDefs
  };
});