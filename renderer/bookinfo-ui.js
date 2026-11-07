/* 书籍信息 + 书架渲染（第 4 步 renderer 九刀·第六刀：从 renderer.js 的「书籍信息」分区整段搬出来）。
 *
 * 搬走的段（原 renderer.js 827–1141，315 行）：
 *   ① 书籍信息弹层（作者 / 简介 / 分组 / 标签，v0.8-3）：打开 / 关闭 / 读表单 / 保存（只改 书目.json 的可选字段，
 *      书文件夹名 / 章节文件名 / 正文 txt 一个字节都不动；书目损坏的书先拒绝）；
 *   ② 书架渲染（renderShelf + renderShelfGroupBar）：书卡（书名 / 分组签 / 作者 / 标签 / 简介 / 章数字数 /
 *      完稿 / 冲突徽标 / 章节命中 / 最后修改 / 修复按钮 / ⋯ 更多 / 新书卡）、分组筛选条、空态文案、搜索命中态；
 *   ③ 新建书流程（onNewBookClick → createBookWithTitle）。
 * **只搬不改行为**：文案 / class / aria / dataset / DOM 结构 / 事件绑定（卡片 click / contextmenu / ⋯ / 徽标 /
 *   修复 / 新书卡）全部一字未改。事件绑定随域搬进 setupBookinfoUi()（弹层 Enter 提交 / 取消 / 保存 / 分组筛选）。
 *
 * 契约：createBookinfoUi(host) 由渲染层调用一次。host 8 个成员（含 3 个语义分组，分组内每个真实依赖都列在这里）：
 *   host = {
 *     $, state, api, call, toast,          // 基础 5：DOM 查询 / 共享状态（books、shelfGroup、shelfContent、bookInfoBook）/ IPC 白名单 / IPC 包装 / 提示
 *     render: {                             // 书卡与筛选条渲染用的纯逻辑 / 格式化口径
 *       bookInfoLib,                        //   core/bookinfo.js：读 / 清洗作者、简介、分组、标签
 *       bookGroupOf,                        //   core/bookinfo.js 的分组归一（书架筛选条用）
 *       chapterTitle,                       //   「第N章 标题」唯一口径（章节命中行用）
 *       formatChars,                        //   「N 章 · X 字」的字数口径（与状态栏 / 统计同一份）
 *       formatRelativeTime                  //   「最后修改 今天 12:34」唯一口径
 *     },
 *     shelf: {                              // 书架查询 / 继续写作 / 正文命中区
 *       shelfGroupList,                     //   当前书库的分组清单
 *       shelfQueryText,                     //   书名搜索词（渲染空态 / 是否显示「新建一本书」）
 *       shelfSearchResults,                 //   过滤后的 [{ book, info }] 行
 *       updateShelfSearchUi,                //   同步搜索框的「找到 N 本 / 正文命中」提示
 *       renderContinueWriting,              //   书架头的「继续写作」卡
 *       renderShelfContent                  //   正文命中结果区
 *     },
 *     actions: {                            // 打开书 / 修复 / 更多菜单 / 新建书等动作
 *       openBookByPath,                     //   点书卡打开书（回到这本书上次的章节）
 *       openBookAtChapter,                  //   点「章节命中」里的章名：打开这本书并定位到那一章
 *       openRepair,                         //   损坏书卡的「修复」
 *       openConflictDialog,                 //   冲突徽标点开清单
 *       showBookMenu,                       //   ⋯ / 右键菜单
 *       updateWindowTitle,                  //   渲染完更新窗口标题
 *       promptText,                         //   新建书时问书名
 *       refreshShelf                        //   保存书籍信息 / 新建书后刷新书架
 *     }
 *   }
 * 缺任何一个（含分组内成员）直接抛 TypeError。分组在 create 时一次解构，行为等价。
 * create() 不注册事件、不建定时器、不碰 DOM；事件绑定在 setupBookinfoUi()，由 bindEvents() 在原位置调用一次。
 * 书卡内部的内联 handler 仍随 renderShelf 一起搬（它们本来就是每次渲染时重建的 DOM 事件）。
 *
 * 刻意不搬（留在 renderer.js）：打开书 / 修复本体、右键菜单 / 导出菜单本体、Esc 动作表（'close-bookinfo'）、
 * 测试钩子宿主契约（按名字取本模块入口）。
 *
 * 浏览器里挂成全局 CWBookinfoUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWBookinfoUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HOST = ['$', 'state', 'api', 'call', 'toast', 'render', 'shelf', 'actions'];

  function createBookinfoUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createBookinfoUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) throw new TypeError('createBookinfoUi 的 host 缺少 ' + key);
    }
    const { $, state, api, call, toast, render, shelf, actions } = host;
    if (typeof render !== 'object') throw new TypeError('createBookinfoUi 的 host.render 必须是对象');
    for (const key of ['bookInfoLib', 'bookGroupOf', 'chapterTitle', 'formatChars', 'formatRelativeTime']) {
      if (render[key] === undefined || render[key] === null) throw new TypeError('createBookinfoUi 的 host.render 缺少 ' + key);
    }
    if (typeof shelf !== 'object') throw new TypeError('createBookinfoUi 的 host.shelf 必须是对象');
    for (const key of ['shelfGroupList', 'shelfQueryText', 'shelfSearchResults', 'updateShelfSearchUi', 'renderContinueWriting', 'renderShelfContent']) {
      if (shelf[key] === undefined || shelf[key] === null) throw new TypeError('createBookinfoUi 的 host.shelf 缺少 ' + key);
    }
    if (typeof actions !== 'object') throw new TypeError('createBookinfoUi 的 host.actions 必须是对象');
    for (const key of ['openBookByPath', 'openBookAtChapter', 'openRepair', 'openConflictDialog', 'showBookMenu', 'updateWindowTitle', 'promptText', 'refreshShelf']) {
      if (actions[key] === undefined || actions[key] === null) throw new TypeError('createBookinfoUi 的 host.actions 缺少 ' + key);
    }
    const { bookInfoLib, bookGroupOf, chapterTitle, formatChars, formatRelativeTime } = render;
    const { shelfGroupList, shelfQueryText, shelfSearchResults, updateShelfSearchUi, renderContinueWriting, renderShelfContent } = shelf;
    const { openBookByPath, openBookAtChapter, openRepair, openConflictDialog, showBookMenu, updateWindowTitle, promptText, refreshShelf } = actions;

  // ---------- 书籍信息（作者 / 简介 / 分组 / 标签，v0.8-3） ----------
  // 只写 书目.json 的可选字段：书文件夹名、章节文件名、正文 txt 都不动。
  // 书目损坏的书先走「修复」，这里直接拒绝（读不出 meta 就没法安全改）。
  function openBookInfoDialog(book) {
    if (!book || !book.path) return false;
    if (book.status === 'corrupt') {
      toast('这本书的书目损坏，先点「修复」再改书籍信息', 'warn');
      return false;
    }
    state.bookInfoBook = book;
    const info = bookInfoLib.readBookInfo(book);
    $('bookinfo-book').textContent = `《${book.title || book.folder || ''}》`;
    $('bookinfo-book').title = book.path || '';
    $('bookinfo-author').value = info.author;
    $('bookinfo-group').value = info.group;
    $('bookinfo-tags').value = info.tags.join('、');
    $('bookinfo-brief').value = info.brief;
    $('bookinfo-error').textContent = '';
    const suggestions = $('bookinfo-group-list');
    suggestions.innerHTML = '';
    for (const group of shelfGroupList()) {
      const option = document.createElement('option');
      option.value = group;
      suggestions.appendChild(option);
    }
    $('bookinfo-backdrop').classList.remove('hidden');
    $('bookinfo-author').focus();
    return true;
  }

  function closeBookInfoDialog() {
    state.bookInfoBook = null;
    $('bookinfo-backdrop').classList.add('hidden');
    $('bookinfo-error').textContent = '';
  }

  function readBookInfoForm() {
    return {
      author: $('bookinfo-author').value,
      group: $('bookinfo-group').value,
      tags: $('bookinfo-tags').value,
      brief: $('bookinfo-brief').value
    };
  }

  async function saveBookInfoDialog() {
    const book = state.bookInfoBook;
    if (!book) return { ok: false };
    const form = readBookInfoForm();
    // 标签先按应用规则清洗（去空 / 去重 / 最多 10 个），免得作者以为自己存了 15 个
    const tags = bookInfoLib.sanitizeTags(form.tags);
    try {
      const result = await call(api.updateBookInfo, book.path, {
        author: form.author,
        brief: form.brief,
        group: form.group,
        tags
      });
      closeBookInfoDialog();
      toast(result.changed ? '书籍信息已保存（只改书目，不改正文和文件名）' : '书籍信息没有变化');
      await refreshShelf();
      return { ok: true, changed: Boolean(result.changed) };
    } catch (err) {
      $('bookinfo-error').textContent = `保存失败：${err.message}`;
      return { ok: false, message: err.message };
    }
  }

  // 书架分组筛选（v0.8-3）：分组来自 书目.json 的可选 group 字段；
  // 一组的书都没有时收起筛选条；分组名改了 / 书删了就回到「全部分组」。
  function renderShelfGroupBar() {
    const bar = $('shelf-group-bar');
    const select = $('shelf-group-filter');
    if (!bar || !select) return;
    const groups = shelfGroupList();
    if (!groups.length) {
      state.shelfGroup = '';
      bar.classList.add('hidden');
      select.innerHTML = '';
      return;
    }
    if (state.shelfGroup && state.shelfGroup !== '__none__' && !groups.includes(state.shelfGroup)) {
      state.shelfGroup = '';
    }
    const options = [{ value: '', label: '全部分组' }];
    if (state.books.some((book) => !bookGroupOf(book))) {
      options.push({ value: '__none__', label: '未分组' });
    }
    for (const group of groups) options.push({ value: group, label: group });
    select.innerHTML = '';
    for (const option of options) {
      const el = document.createElement('option');
      el.value = option.value;
      el.textContent = option.label;
      select.appendChild(el);
    }
    select.value = state.shelfGroup;
    bar.classList.remove('hidden');
  }

  function renderShelf() {
    $('books-root-label').textContent = state.config ? `书架：${state.config.booksRoot}` : '';
    $('books-root-label').title = state.config ? state.config.booksRoot : '';
    const grid = $('book-grid');
    renderContinueWriting();
    renderShelfGroupBar();

    const query = shelfQueryText();
    const rows = shelfSearchResults();
    updateShelfSearchUi(rows.length);

    // B6（审计 P6）：书卡内容没变就不重建 —— 索引进度 / 统计刷新都会调 renderShelf，
    // 整块重建会丢键盘焦点 / 滚动位置，也白建一堆 DOM。签名里只有会改卡片 DOM 的内容
    // （见 shelfRenderSignature），一致时保留现有卡片。
    const signature = shelfRenderSignature(query, rows);
    if (grid.dataset.renderSignature !== signature) {
      grid.dataset.renderSignature = signature;
      buildShelfGrid(grid, query, rows);
    }

    updateWindowTitle();
    renderShelfContent();
  }

  // B6（审计 P6）：书架 grid 的重建部分（空态 / 书卡 / 「新建一本书」），只在渲染签名变化时调用。
  // 书卡顺序来自 rows（按书架扫描顺序），签名一致时整个 grid 原样保留（焦点 / 滚动位置都不丢）。
  function buildShelfGrid(grid, query, rows) {
    grid.innerHTML = '';
    if (!state.books.length) {
      const empty = document.createElement('div');
      empty.className = 'shelf-empty';
      empty.textContent = '这里还没有书。点右边（或下面）的「新建一本书」开始，或者把已有的书文件夹放进书架目录。';
      grid.appendChild(empty);
    } else if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'shelf-empty';
      const content = state.shelfContent;
      const contentHits = content.meta && content.meta.results ? content.meta.results.length : 0;
      if (!query && state.shelfGroup) {
        empty.textContent =
          state.shelfGroup === '__none__' ? '「未分组」里还没有书。' : '这个分组里还没有书。';
      } else {
        const contentNote = content.loading
          ? '书名 / 作者 / 章节名没有匹配，正在正文里找…'
          : contentHits > 0
            ? `书名 / 作者 / 章节名没有匹配；正文找到 ${contentHits} 处，见上方「正文命中」。`
            : `没有找到匹配「${query}」的书（书名 / 作者 / 分组 / 标签 / 章节名 / 正文都没有）。`;
        empty.textContent = contentNote;
      }
      grid.appendChild(empty);
    }

    for (const { book, info } of rows) {
      const card = document.createElement('div');
      const conflictCount = Array.isArray(book.conflicts) ? book.conflicts.length : 0;
      card.className =
        'book-card' +
        (book.status === 'corrupt' ? ' corrupt' : '') +
        (conflictCount ? ' has-conflict' : '');
      card.dataset.path = book.path;
      card.dataset.folder = book.folder;
      // 键盘可达（v0.9 A-5b）：整张书卡可 Tab 到、Enter / 空格打开这本书；「⋯」自己的
      // Enter / 空格仍走它自己的点击，不被卡片抢。
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', `打开《${book.title}》`);

      // 书卡第一行（v1.0 M3 第二刀）：书名 + 右上角分组小签，与设计稿 .book-head 一致。
      // 以前书名和「分组：… · #标签…」长签是两兄弟，签绝对定位在右上，5 列时把签名截得读不懂、
      // 还跟「⋯」按钮抢位置；现在签里只放分组名，标签跟作者同一行。
      const head = document.createElement('div');
      head.className = 'book-card-head';
      const title = document.createElement('div');
      title.className = 'book-card-title';
      title.textContent = book.status === 'corrupt' ? `⚠ ${book.title}` : book.title;
      head.appendChild(title);
      card.appendChild(head);

      // 书籍信息（v0.8-3）：作者 / 分组 / 标签 / 简介。旧书没有这些字段就什么都不多显示。
      const bookInfo = bookInfoLib.readBookInfo(book);
      if (book.status !== 'corrupt') {
        if (bookInfo.group) {
          const group = document.createElement('span');
          group.className = 'book-card-tags';
          group.textContent = bookInfo.group;
          group.title = `分组：${bookInfo.group}`;
          head.appendChild(group);
        }
        const infoParts = [];
        if (bookInfo.author) infoParts.push(`作者：${bookInfo.author}`);
        for (const tag of bookInfo.tags) infoParts.push(`#${tag}`);
        if (infoParts.length) {
          const author = document.createElement('div');
          author.className = 'book-card-author';
          author.textContent = infoParts.join(' · ');
          author.title = author.textContent;
          card.appendChild(author);
        }
        if (bookInfo.brief) {
          const brief = document.createElement('div');
          brief.className = 'book-card-brief';
          brief.textContent = bookInfo.brief.replace(/\s*\n+\s*/g, ' ');
          brief.title = bookInfo.brief;
          card.appendChild(brief);
        }
      }

      const meta = document.createElement('div');
      meta.className = 'book-card-meta';
      const done = Number(book.doneChapters) || 0;
      if (book.status === 'corrupt') {
        meta.textContent = `书目损坏：${book.reason || '无法读取'}`;
      } else {
        // 底部发丝线下一行：左边「章数 · 字数」，右边「完稿 a/b 章」（设计稿 .book-line）。
        // 拆成两个 span 各自省略，5 列卡里不会被整串折行顶出卡片。
        const main = document.createElement('span');
        main.textContent = `${book.chapterCount} 章 · ${formatChars(book.totalChars)}`;
        meta.appendChild(main);
        if (done > 0) {
          const doneEl = document.createElement('span');
          doneEl.textContent = `完稿 ${done}/${book.chapterCount} 章`;
          meta.appendChild(doneEl);
        }
      }
      card.appendChild(meta);

      // 同步盘冲突副本：醒目提示，点开看是哪几个文件；绝不自动合并/删除
      if (conflictCount) {
        const badge = document.createElement('button');
        badge.type = 'button';
        badge.className = 'book-conflict-badge';
        badge.textContent = `⚠ 检测到同步冲突副本（${conflictCount} 个）`;
        badge.title = `这些文件不会被自动合并：\n${(book.conflicts || []).join('\n')}`;
        badge.addEventListener('click', (event) => {
          event.stopPropagation();
          openConflictDialog(book);
        });
        card.appendChild(badge);
      }

      // 书名没命中、靠章名命中时，把命中的章名列出来。
      // 每个章名是一枚原生 button（1.1.0）：点它直接打开这本书并定位到那一章；文案前缀与「、」
      // 分隔符仍是文本节点，所以整行的 textContent 与旧版逐字一致（E2E 第 33 组按 textContent 断言）。
      if (info.chapterHits && info.chapterHits.length) {
        const hitLine = document.createElement('div');
        hitLine.className = 'book-card-match';
        hitLine.appendChild(document.createTextNode('章节命中：'));
        info.chapterHits.forEach((hit, i) => {
          if (i) hitLine.appendChild(document.createTextNode('、'));
          const chapterIndex = Number(hit.index);
          const link = document.createElement('button');
          link.type = 'button';
          link.className = 'book-card-match-chapter';
          link.dataset.chapterIndex = String(chapterIndex);
          link.textContent = chapterTitle(chapterIndex, hit.name);
          link.title = `打开《${book.title}》并定位到${link.textContent}`;
          link.setAttribute('aria-label', `打开《${book.title}》并定位到${link.textContent}`);
          link.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (Number.isFinite(chapterIndex)) openBookAtChapter(book.path, chapterIndex);
          });
          hitLine.appendChild(link);
        });
        card.appendChild(hitLine);
      }

      const time = document.createElement('div');
      time.className = 'book-card-time';
      time.textContent =
        book.status === 'corrupt' ? '点开可以修复' : `最后修改 ${formatRelativeTime(book.lastModified)}`;
      card.appendChild(time);

      if (book.status === 'corrupt') {
        const repairBtn = document.createElement('button');
        repairBtn.type = 'button';
        repairBtn.className = 'btn primary';
        repairBtn.textContent = '修复';
        repairBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          openRepair(book);
        });
        card.appendChild(repairBtn);
      }

      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'book-card-more';
      more.title = '更多操作（打开文件夹 / 删除）';
      more.textContent = '⋯';
      more.addEventListener('click', (event) => {
        event.stopPropagation();
        const rect = more.getBoundingClientRect();
        showBookMenu(book, rect.right - 186, rect.bottom + 4);
      });
      card.appendChild(more);

      card.addEventListener('click', (event) => {
        if (event.target.closest('.book-card-more')) return;
        openBookByPath(book.path);
      });
      card.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        showBookMenu(book, event.clientX, event.clientY);
      });
      grid.appendChild(card);
    }

    // 搜索时不再显示「新建一本书」，避免挡结果
    if (!query) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'book-card new-book';
      const plus = document.createElement('span');
      plus.className = 'plus';
      plus.textContent = '＋';
      const addLabel = document.createElement('span');
      addLabel.textContent = '新建一本书';
      add.appendChild(plus);
      add.appendChild(addLabel);
      add.addEventListener('click', onNewBookClick);
      grid.appendChild(add);
    }

  }

  // B6：书架 grid 的渲染签名 —— 只包含会改变卡片 DOM 的内容：书名 / 状态 / 冲突数 / 章数字数 /
  // 完成度 / 书籍信息 / 章节命中 / 分组筛选 / 查询词，以及书目的最后修改时间（卡片底部「最后修改」
  // 是相对时间文案，保存刷新 updatedAt 时必须重建，E2E 第 03 组钉着这一点）。
  function shelfRenderSignature(query, rows) {
    const cards = rows.map(({ book, info }) => {
      const bookInfo = bookInfoLib.readBookInfo(book);
      const hits = info && Array.isArray(info.chapterHits)
        ? info.chapterHits.map((hit) => [hit.index, hit.name])
        : null;
      return [
        book.path,
        book.title,
        book.status,
        Array.isArray(book.conflicts) ? book.conflicts.length : 0,
        book.chapterCount,
        book.totalChars,
        book.doneChapters,
        book.lastModified,
        bookInfo.group,
        bookInfo.author,
        bookInfo.tags,
        bookInfo.brief,
        hits
      ];
    });
    return JSON.stringify({ query, group: state.shelfGroup, books: state.books.length, cards });
  }

  async function onNewBookClick() {
    const title = await promptText({
      title: '新建一本书',
      message: '给这本书起个名字；直接点确定就叫「我的新书」。',
      placeholder: '书名'
    });
    if (title === null) return;
    await createBookWithTitle(title);
  }

  async function createBookWithTitle(title) {
    try {
      const data = await call(api.createBook, title);
      toast(`已创建：${data.meta.title}`);
      await refreshShelf();
      await openBookByPath(data.path);
    } catch (err) {
      toast(`新建失败：${err.message}`, 'error');
    }
  }

  // 事件绑定（与搬前 bindEvents() 里的书籍信息块逐行一致；由渲染层在原位置调用一次）
  function setupBookinfoUi() {
    $('bookinfo-backdrop').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target && event.target.id !== 'bookinfo-brief') {
        event.preventDefault();
        void saveBookInfoDialog();
      }
    });
    $('btn-bookinfo-cancel').addEventListener('click', closeBookInfoDialog);
    $('btn-bookinfo-save').addEventListener('click', () => void saveBookInfoDialog());
    $('shelf-group-filter').addEventListener('change', (event) => {
      state.shelfGroup = String(event.target.value || '');
      renderShelf();
    });
  }


    return {
      openBookInfoDialog,
      closeBookInfoDialog,
      readBookInfoForm,
      saveBookInfoDialog,
      renderShelf,
      createBookWithTitle,
      setupBookinfoUi
    };
  }

  return { create: createBookinfoUi, REQUIRED_HOST };
});
