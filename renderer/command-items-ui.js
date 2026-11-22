/* 命令面板条目表 + 数据版本缓存 —— M1（第一轮·低）拆分第二刀：从 renderer.js 整段搬出。
 *
 * 为什么单独一个模块：「Ctrl+K 面板里有什么」以前长在 4,545 行的 renderer.js 里，只有打开面板才看得见：
 *   1. 条目表由三部分组成 —— 命令目录（command-catalog.js）按当前视图过滤出的命令行、当前书的章节行、
 *      书架上的书行（点一条 = 切到那一章 / 打开那一本）；
 *   2. 千章书连续输入不重建对象（1.5.0 P0-6 / 审计 O-1）：条目按「数据版本」缓存，缓存键只放
 *      buildCommandItems 读的东西（视图 / 书 / 书目 / 章节数组 / 书列表 / 当前章）；
 *   3. 数据变了由渲染层调 markCommandsDirty()：作废本模块的缓存 + 通知面板作废它自己的快照
 *      （面板只在打开 / 失效后的下一次重画时再取一次条目）。
 * 搬出来以后这三件事可以用假 state 在 Node 里逐条钉住（缓存命中 / 失效 / 章已删的提示 / 书已开），
 * 不必开 Electron 敲 Ctrl+K。
 *
 * 契约：createCommandItemsUi(host) 只调用一次；host = {
 *   state, chaptersLib, chapterTitle,
 *   defs: () => [{ id, title, kbd, keywords, run, when? }],  // 命令目录按当前视图过滤后的条目
 *   prepare: (items) => prepared,                           // command-registry 的归一文本预处理
 *   switchChapter, focusChapterItem, sameBookPath, openBookByPath, toast, focusEditor, invalidate
 * }
 *   · 依赖一律「调用时取值」：渲染层的 switchChapter / sameBookPath 是晚一步从别的模块解构出来的 const，
 *     直接传值会撞 TDZ，所以渲染层传进来的都是箭头转发；
 *   · defs 每次重建都要重新取（视图 / 有没有书会变），本模块不缓存它；
 *   · invalidate 可选（缺了只是面板快照晚一拍作废，单测里常常不传）。
 *   缺任何一个必填成员直接抛 TypeError（宁可在启动时炸，也不要到按 Ctrl+K 时 ReferenceError）。
 *
 * 只读 state、建普通对象、不写盘、不发 IPC；run 闭包里只调渲染层给过来的入口。
 *
 * 浏览器里挂成全局 CWCommandItemsUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../core/assert-host').assertHost);
  } else if (root) {
    root.CWCommandItemsUi = factory(root.CWAssertHost && root.CWAssertHost.assertHost);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (assertHost) {
  'use strict';

  const REQUIRED_HOST = [
    'state',
    'chaptersLib',
    'chapterTitle',
    'defs',
    'prepare',
    'switchChapter',
    'focusChapterItem',
    'sameBookPath',
    'openBookByPath',
    'toast',
    'focusEditor'
  ];

  function createCommandItemsUi(host) {
    assertHost('createCommandItemsUi', host, REQUIRED_HOST);
    const {
      state, chaptersLib, chapterTitle, defs, prepare,
      switchChapter, focusChapterItem, sameBookPath, openBookByPath, toast, focusEditor
    } = host;
    // invalidate 可选：面板还没装配好时（单测 / 旧宿主）缺了也照常工作。
    const invalidate = typeof host.invalidate === 'function' ? host.invalidate : null;
    // 只缓存数据、不缓存 DOM：键是引用比较，命中就原样复用（面板的条目数组引用不变）。
    const cache = { items: null, key: null };

    // 数据一变就作废：本模块的缓存 + 面板自己的快照（面板不自己知道数据什么时候变）。
    function markCommandsDirty() {
      cache.items = null;
      cache.key = null;
      if (invalidate) invalidate();
    }

    // 命令面板的条目快照：构建一次，按「数据版本」复用。
    // 缓存键只放 buildCommandItems 读的东西 —— 视图 / 书 / 书目 / 章节数组 / 书列表 / 当前章；
    // 数组里的对象被原地改（章节改名、书名字数变化）时由 renderChapterList /
    // applyMetaAndRelocate / refreshShelf 里的 markCommandsDirty() 兜住。
    // prepare() 顺手把归一文本算好，之后每次输入只做粗筛 + 少量打分。
    function commandItemsForPalette() {
      const key = [state.view, state.bookPath, state.meta, state.chapters, state.books, state.index];
      const cachedKey = cache.key;
      if (
        cache.items &&
        cachedKey &&
        cachedKey.length === key.length &&
        key.every((value, index) => cachedKey[index] === value)
      ) {
        return cache.items;
      }
      const items = prepare(buildCommandItems());
      cache.items = items;
      cache.key = key;
      return items;
    }

    // 动态条目：章节（当前书）+ 书（书架）。点一条就等于「切到那一章 / 打开那一本」。
    function buildCommandItems() {
      const out = [];
      for (const def of defs()) {
        if (typeof def.when === 'function' && !def.when()) continue;
        out.push({
          id: def.id,
          title: def.title,
          group: 'command',
          kbd: def.kbd || '',
          hint: '',
          keywords: def.keywords || [],
          run: def.run
        });
      }
      if (state.view === 'editor' && state.bookPath) {
        state.chapters.forEach((chapter, index) => {
          const chapterId = chapter && chapter.id != null ? chapter.id : null;
          out.push({
            id: `chapter:${chapter.id}`,
            title: chapterTitle(index, chapter.name),
            group: 'chapter',
            hint: index === state.index ? '当前章' : `第 ${chaptersLib.chapterNumber(state.meta, index)} 章`,
            keywords: [chapter.name || '', `ch${chaptersLib.chapterNumber(state.meta, index)}`, `ch${index + 1}`],
            run: () => {
              // 五-M5（SS-01）：面板开着时删章 / 移卷会整体换掉章节数组，而 markCommandsDirty 只作废
              // 快照、不重画已渲染行；run 闭包里捕获的 index 会指到错位的那一章。这里按 chapter.id
              // 现场解析，章已删就明确提示，绝不按旧下标切到别的章。
              const at = chapterId == null
                ? -1
                : state.chapters.findIndex((item) => item && String(item.id) === String(chapterId));
              if (at < 0) {
                toast('这一章已经不存在了（可能在面板打开期间被删除），请重新打开面板', 'warn');
                return;
              }
              void switchChapter(at).then((result) => {
                if (!result || result.ok !== true) return;
                focusChapterItem({ mode: 'switch', index: at });
              });
            }
          });
        });
      }
      for (const book of state.books || []) {
        out.push({
          id: `book:${book.path}`,
          title: `打开《${book.title || '未命名'}》`,
          group: 'book',
          hint: `${book.chapterCount || 0} 章`,
          keywords: [book.title || '', 'book', '书'],
          run: () => {
            // H-3（1.5.0 P0-6）：当前这本书已经打开时，不要再走一次开书 IPC ——
            // 那会从磁盘重载正文，编辑区里没保存的字就白丢了。提示 + 把焦点还给编辑区。
            if (sameBookPath(book.path, state.bookPath)) {
              toast('这本书已经打开了');
              if (state.view === 'editor') focusEditor();
              return;
            }
            void openBookByPath(book.path);
          }
        });
      }
      return out;
    }

    return { commandItemsForPalette, markCommandsDirty };
  }

  return { create: createCommandItemsUi, REQUIRED_HOST };
});
