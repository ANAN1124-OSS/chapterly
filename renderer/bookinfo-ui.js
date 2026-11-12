/* 书籍信息 + 书架渲染（第 4 步 renderer 九刀·第六刀：从 renderer.js 的「书籍信息」分区整段搬出来）。
 *
 * 搬走的段（原 renderer.js 827–1141，315 行）：
 *   ① 书籍信息弹层（作者 / 简介 / 分组 / 标签，v0.8-3）：打开 / 关闭 / 读表单 / 保存（只改 书目.json 的可选字段，
 *      书文件夹名 / 章节文件名 / 正文 txt 一个字节都不动；书目损坏的书先拒绝）；
 *   ② 书架渲染（renderShelf + renderShelfGroupBar）：书卡（书名 / 分组签 / 作者 / 标签 / 简介 / 章数字数 /
 *      完稿 / 冲突徽标 / 章节命中 / 最后修改 / 修复按钮 / ⋯ 更多 / 新书卡）、分组筛选条、空态文案、搜索命中态；
 *   ③ 新建书流程（onNewBookClick → createBookWithTitle）；
 *   ④ 首次运行提示（1.3.0 T5 / 规范 I-10）：书架底部状态行一条 4s 一次性提示，只在书架真空 +
 *      config.firstRunTipShown 还不是 true 时显示，显示过写回 config.json。
 * **只搬不改行为**：文案 / class / aria / dataset / DOM 结构 / 事件绑定（卡片 click / contextmenu / ⋯ / 徽标 /
 *   修复 / 新书卡）全部一字未改。事件绑定随域搬进 setupBookinfoUi()（弹层 Enter 提交 / 取消 / 保存 / 分组筛选）。
 *   1.3.0 T4 空状态三件套与 T5 首次运行提示是本轮新增，均为显示层。
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
 * 首次运行提示由渲染层在首屏书架刷新完成后显式调 maybeShowFirstRunTip()（4s 定时器只在这个函数里建）。
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

  // ---------- 分组管理（1.6.0 F5）：改名 / 合并 ----------
  // 只改每本书 书目.json 的 group 字段（清空 = 删字段）：书文件夹 / 章节文件 / 书签 /
  // 「继续上次写作」都不动，所以改名后旧书签与最近打开照旧有效。
  // 每本一次 updateBookInfo（沿用现有 IPC，不加新频道）：单本失败不影响其他书，失败清单报给作者。
  function findGroupStat(group) {
    return bookInfoLib.collectGroupStats(state.books).groups.find((item) => item.name === group) || null;
  }

  function appendGroupManageRow(list, group) {
    const row = document.createElement('div');
    row.className = 'group-manage-row';
    row.dataset.group = group.name;
    const name = document.createElement('span');
    name.className = 'group-manage-name';
    name.textContent = group.name;
    name.title = group.name;
    const count = document.createElement('span');
    count.className = 'group-manage-count muted small';
    count.textContent = `${group.count} 本`;
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'btn ghost tiny';
    rename.dataset.action = 'rename';
    rename.textContent = '改名…';
    rename.title = `把「${group.name}」改成别的名字；留空 = 移到未分组`;
    rename.addEventListener('click', () => {
      closeGroupManageDialog();
      void renameShelfGroup(group.name);
    });
    const merge = document.createElement('button');
    merge.type = 'button';
    merge.className = 'btn ghost tiny';
    merge.dataset.action = 'merge';
    merge.textContent = '合并到…';
    merge.title = `把「${group.name}」并进另一个分组（只改 书目.json）`;
    merge.addEventListener('click', () => {
      closeGroupManageDialog();
      void mergeShelfGroup(group.name);
    });
    row.appendChild(name);
    row.appendChild(count);
    row.appendChild(rename);
    row.appendChild(merge);
    list.appendChild(row);
  }

  function renderGroupManageList() {
    const list = $('group-manage-list');
    if (!list) return;
    list.innerHTML = '';
    const stats = bookInfoLib.collectGroupStats(state.books);
    if (!stats.groups.length) {
      const empty = document.createElement('div');
      empty.className = 'group-manage-empty muted small';
      empty.textContent = '还没有分组。先在书卡「⋯」→「书籍信息」里给书填一个分组，再回来改名 / 合并。';
      list.appendChild(empty);
      return;
    }
    for (const group of stats.groups) appendGroupManageRow(list, group);
  }

  // 改名 / 合并都先关掉管理弹层再问：通用询问框（z-index 300）不跟它叠在一起，
  // 焦点 / Esc 各自只有一层，作者也看得清当前在回答哪一个问题。
  function openGroupManageDialog() {
    const backdrop = $('group-manage-backdrop');
    if (!backdrop) return false;
    const error = $('group-manage-error');
    if (error) error.textContent = '';
    renderGroupManageList();
    backdrop.classList.remove('hidden');
    const close = $('btn-group-manage-close');
    if (close) close.focus();
    return true;
  }

  function closeGroupManageDialog() {
    const backdrop = $('group-manage-backdrop');
    if (backdrop) backdrop.classList.add('hidden');
  }

  // 一本一本写（顺序执行，避免同时写多个 书目.json）：返回 { changed, failed:[{ title, message }] }；
  // 失败的保持原分组，不静默吞掉失败。
  async function applyGroupChanges(changes) {
    const failed = [];
    let changed = 0;
    for (const change of changes) {
      try {
        const result = await call(api.updateBookInfo, change.path, { group: change.to });
        if (!result || result.changed !== false) changed += 1;
      } catch (err) {
        failed.push({ title: change.title, message: err.message });
      }
    }
    await refreshShelf();
    return { changed, failed };
  }

  function reportGroupChange(verb, target, result) {
    const label = target ? `「${target}」` : '未分组';
    if (result.failed.length) {
      toast(
        `已${verb} ${result.changed} 本到${label}；${result.failed.length} 本失败（${result.failed[0].message}），失败的保持原分组`,
        'warn'
      );
      return;
    }
    toast(`已${verb} ${result.changed} 本到${label}（只改书目，正文与文件名没动）`);
  }

  // 改名：把 from 组的书改成作者输入的新名字（留空 = 移到未分组）。
  async function renameShelfGroup(from) {
    const group = bookInfoLib.sanitizeGroup(from);
    if (!group) return { ok: false };
    const stat = findGroupStat(group);
    const answer = await promptText({
      title: '重命名分组',
      message: `把「${group}」的 ${stat ? stat.count : 0} 本书改成分组名…（留空 = 移到未分组）`,
      value: group,
      placeholder: '分组名'
    });
    if (answer === null) return { ok: false, canceled: true };
    const changes = bookInfoLib.planGroupChange(state.books, group, answer);
    if (!changes.length) {
      toast('分组名没有变化');
      return { ok: true, changed: 0, failed: [] };
    }
    const result = await applyGroupChanges(changes);
    reportGroupChange('改名', changes[0].to, result);
    return { ok: true, ...result };
  }

  // 合并：把 from 组并进另一个分组（目标大小写归一到已有写法；留空 = 并入未分组）。
  async function mergeShelfGroup(from) {
    const group = bookInfoLib.sanitizeGroup(from);
    if (!group) return { ok: false };
    const stats = bookInfoLib.collectGroupStats(state.books);
    const stat = stats.groups.find((item) => item.name === group) || null;
    const others = stats.groups.map((item) => item.name).filter((name) => name !== group);
    const answer = await promptText({
      title: '合并分组',
      message:
        `把「${group}」的 ${stat ? stat.count : 0} 本书并到哪个分组？` +
        `可以输入已有分组名（${others.length ? others.join(' / ') : '暂无其它分组'}）；留空 = 未分组。`,
      value: '',
      placeholder: '目标分组名'
    });
    if (answer === null) return { ok: false, canceled: true };
    const changes = bookInfoLib.planGroupChange(state.books, group, answer);
    if (!changes.length) {
      toast('分组名没有变化');
      return { ok: true, changed: 0, failed: [] };
    }
    const result = await applyGroupChanges(changes);
    reportGroupChange('合并', changes[0].to, result);
    return { ok: true, ...result };
  }

  // 书卡右键「移到分组…」（1.6.0 F5）：书架没有多选，只做单本；仅改 书目.json。
  // 1.6.0b：不再让作者手打分组名——点开就在菜单里展开已有分组（带本数、当前分组打勾）、
  // 「未分组」与「新建分组…」，选一个即执行；与「移到卷…」（1.4.0 P0-2）同一套做法，
  // 选择类操作走菜单内联列表，不弹模态。菜单收起时由渲染层调 closeBookGroupChooser() 清场。
  function closeBookGroupChooser() {
    const holder = $('book-menu-groups');
    if (!holder) return false;
    holder.textContent = '';
    holder.classList.add('hidden');
    return true;
  }

  function openBookGroupChooser(book) {
    const holder = $('book-menu-groups');
    if (!holder || !book || !book.path) return false;
    if (book.status === 'corrupt') {
      toast('这本书的书目损坏，先点「修复」再改分组', 'warn');
      return false;
    }
    const info = bookInfoLib.readBookInfo(book);
    const stats = bookInfoLib.collectGroupStats(state.books);
    holder.textContent = '';
    const title = document.createElement('div');
    title.className = 'context-menu-label';
    title.textContent = `把《${book.title || book.folder || ''}》移到`;
    holder.appendChild(title);
    const addOption = (group, count, current) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.action = 'move-group-pick';
      btn.dataset.group = group;
      btn.textContent = `${current ? '✓ ' : ''}${group || '未分组'} · ${count} 本`;
      if (current) btn.setAttribute('aria-current', 'true');
      holder.appendChild(btn);
    };
    // 分组按中文排序（collectGroupStats 同一口径）；「未分组」放最后，当前分组打勾。
    for (const group of stats.groups) addOption(group.name, group.count, group.name === info.group);
    addOption('', stats.ungrouped, !info.group);
    const create = document.createElement('button');
    create.type = 'button';
    create.dataset.action = 'move-group-new';
    create.textContent = '新建分组…';
    holder.appendChild(create);
    holder.classList.remove('hidden');
    return true;
  }

  // 「新建分组…」：沿用通用询问框问一个名字，再走与列表选择同一条写入路径。
  async function newGroupForBook(book) {
    if (!book || !book.path) return { ok: false };
    if (book.status === 'corrupt') {
      toast('这本书的书目损坏，先点「修复」再改分组', 'warn');
      return { ok: false };
    }
    const answer = await promptText({
      title: '新建分组',
      message: `给《${book.title}》新建一个分组名（只改这一本的书目；留空 = 未分组）。`,
      placeholder: '分组名'
    });
    if (answer === null) return { ok: false, canceled: true };
    return moveBookToGroup(book, answer);
  }

  // 执行「移到分组」：target 由列表 / 新建分组传入。用整架书算目标分组的规范写法
  // （能对上别的书已有的「Group A」），再只保留这一本。
  async function moveBookToGroup(book, target) {
    if (!book || !book.path) return { ok: false };
    if (book.status === 'corrupt') {
      toast('这本书的书目损坏，先点「修复」再改分组', 'warn');
      return { ok: false };
    }
    if (typeof target !== 'string') return { ok: false };
    const info = bookInfoLib.readBookInfo(book);
    const changes = bookInfoLib
      .planGroupChange(state.books, info.group, target)
      .filter((change) => change.path === book.path);
    if (!changes.length) {
      toast('分组没有变化');
      return { ok: true, changed: 0, failed: [] };
    }
    const result = await applyGroupChanges(changes);
    reportGroupChange('移入', changes[0].to, result);
    return { ok: true, ...result };
  }

  // 书架分组 / 标签筛选（v0.8-3 起；1.6.0 F5 补标签与计数徽标）：
  // 分组来自 书目.json 的可选 group 字段、标签来自 tags；两者都只影响书架视图，筛选状态只记在
  // state 里（不写配置、不写盘）。选中项被改名 / 合并 / 清空后自动回到「全部」。
  function filterOption(value, label) {
    return { value, label };
  }

  function renderShelfGroupBar() {
    const bar = $('shelf-group-bar');
    const select = $('shelf-group-filter');
    const tagSelect = $('shelf-tag-filter');
    const tagLabel = $('shelf-tag-label');
    const manage = $('btn-shelf-group-manage');
    if (!bar || !select) return;
    const stats = bookInfoLib.collectGroupStats(state.books);
    const groupNames = stats.groups.map((item) => item.name);
    const tagStats = bookInfoLib.collectTagStats(state.books);
    if (!groupNames.length && !tagStats.length) {
      state.shelfGroup = '';
      state.shelfTag = '';
      bar.classList.add('hidden');
      select.innerHTML = '';
      if (tagSelect) {
        tagSelect.innerHTML = '';
        tagSelect.classList.add('hidden');
      }
      if (tagLabel) tagLabel.classList.add('hidden');
      if (manage) manage.classList.add('hidden');
      return;
    }
    // 选中项不存在了（分组被改名 / 合并、标签被清空、书被删）→ 回到「全部」
    if (state.shelfGroup && state.shelfGroup !== '__none__' && !groupNames.includes(state.shelfGroup)) {
      state.shelfGroup = '';
    }
    if (state.shelfGroup === '__none__' && !stats.ungrouped) state.shelfGroup = '';
    if (state.shelfTag && !tagStats.some((item) => item.name === state.shelfTag)) state.shelfTag = '';

    const options = [filterOption('', `全部分组（${stats.total}）`)];
    // 「未分组」提醒仍走 host 的分组归一（与书籍信息弹层的建议清单同一口径：清洗后为空 = 未分组）；
    // 计数本身走 collectGroupStats（同一份规则，避免两处口径漂移）。
    if (state.books.some((book) => !bookGroupOf(book))) {
      options.push(filterOption('__none__', `未分组（${stats.ungrouped}）`));
    }
    for (const group of stats.groups) options.push(filterOption(group.name, `${group.name}（${group.count}）`));
    select.innerHTML = '';
    for (const option of options) {
      const el = document.createElement('option');
      el.value = option.value;
      el.textContent = option.label;
      select.appendChild(el);
    }
    select.value = state.shelfGroup;

    // 标签筛选：只有真的存在标签时才出现（旧书没有标签，不多占一个下拉）
    if (tagSelect && tagLabel) {
      const hasTags = tagStats.length > 0;
      tagLabel.classList.toggle('hidden', !hasTags);
      tagSelect.classList.toggle('hidden', !hasTags);
      tagSelect.innerHTML = '';
      if (hasTags) {
        const tagOptions = [filterOption('', `全部标签（${tagStats.length}）`)];
        for (const tag of tagStats) tagOptions.push(filterOption(tag.name, `#${tag.name}（${tag.count}）`));
        for (const option of tagOptions) {
          const el = document.createElement('option');
          el.value = option.value;
          el.textContent = option.label;
          tagSelect.appendChild(el);
        }
        tagSelect.value = state.shelfTag;
      }
    }
    // 分组管理入口：有分组才需要（未分组是「没有 group 字段」，不在这里改名 / 合并）
    if (manage) manage.classList.toggle('hidden', !groupNames.length);
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

  // ---------- 首次运行提示（1.3.0 T5 / 规范 I-10） ----------
  // 不做多步向导：书架空态（T4）承担主引导，这里在书架底部状态行再给一条 4s 一次性提示。
  // 只在「书架真的是一本都没有 + 配置里还没提示过」时出现一次——有书的老用户升级上来不打扰。
  // 写作页 34px 状态栏在书架页不可见，而首次运行先看到的就是书架，所以这条落在书架的底部状态行。
  // 不改正文 / 书目 / 数据格式：只读 config 的 firstRunTipShown，显示过才把标记写回 config.json。
  const FIRST_RUN_TIP_MS = 4000;
  const FIRST_RUN_TIP_TEXT =
    '开始写吧：点「＋ 新建一本书」从零开始；已有稿子就点「导入小说」把 txt 文件夹导进来。';
  let firstRunTipTimer = null;
  let firstRunTipChecked = false;

  function hideFirstRunTip() {
    if (firstRunTipTimer) {
      clearTimeout(firstRunTipTimer);
      firstRunTipTimer = null;
    }
    const tip = $('shelf-first-run-tip');
    const base = $('shelf-footer-default');
    if (tip) tip.textContent = '';
    if (base) base.classList.remove('hidden');
  }

  // 由渲染层在首屏书架刷新完成后调用一次。返回值 = 这一次有没有真的显示提示。
  async function maybeShowFirstRunTip() {
    if (firstRunTipChecked) return false; // 一个窗口只判断一次（回书架刷新不重来）
    firstRunTipChecked = true;
    const cfg = state.globalConfig || state.config || {};
    if (cfg.firstRunTipShown === true) return false;
    if (Array.isArray(state.books) && state.books.length) return false; // 有书 = 不是第一次用，不打扰
    const tip = $('shelf-first-run-tip');
    const base = $('shelf-footer-default');
    if (!tip || !base) return false;
    tip.textContent = FIRST_RUN_TIP_TEXT; // role=status + aria-live：读屏也能收到这一条
    base.classList.add('hidden');
    clearTimeout(firstRunTipTimer);
    firstRunTipTimer = setTimeout(() => {
      firstRunTipTimer = null;
      hideFirstRunTip();
    }, FIRST_RUN_TIP_MS);
    // 显示即记为「已提示」；写盘失败不影响使用（下次启动最多再提示一次）。
    try {
      const next = await call(api.setConfig, { firstRunTipShown: true });
      if (next) state.globalConfig = next;
    } catch {
      /* 记不住不影响使用 */
    }
    return true;
  }

  // B6（审计 P6）：书架 grid 的重建部分（空态 / 书卡 / 「新建一本书」），只在渲染签名变化时调用。
  // 书卡顺序来自 rows（按书架扫描顺序），签名一致时整个 grid 原样保留（焦点 / 滚动位置都不丢）。
  //
  // 1.3.0 T4（规范 I-06 空状态三件套）：每个空态都按「说明状态 / 学习线索 / 直接路径」写，并用
  // data-empty-kind 区分三类——vacuum（真空：一本都没有）/ loading（加载中：正文还在找）/
  // filtered（筛选空：分组或搜索把书筛掉了）。不加插画、不加新按钮，路径都指向现有入口。
  function buildShelfGrid(grid, query, rows) {
    grid.innerHTML = '';
    if (!state.books.length) {
      const empty = document.createElement('div');
      empty.className = 'shelf-empty';
      empty.dataset.emptyKind = 'vacuum';
      empty.textContent =
        '这里还没有书。一本书 = 一个文件夹，正文就是里面的普通 txt 文件，用记事本也能打开。' +
        '点右上「导入小说」把现有稿子导进来，或点右侧（或下面）的「新建一本书」从零开始；' +
        '也可以直接把书文件夹放进书架目录。';
      grid.appendChild(empty);
    } else if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'shelf-empty';
      const content = state.shelfContent;
      const contentHits = content.meta && content.meta.results ? content.meta.results.length : 0;
      // 分组 / 标签筛选把书筛空：两种筛选各自的说明都留着（1.6.0 F5 补标签那句），
      // 同时选中时两句一起说，省得作者以为只按其中一条筛。
      const groupEmptyText = () =>
        state.shelfGroup === '__none__'
          ? '「未分组」里还没有书。把某本书的分组留空（书卡「⋯」→「书籍信息」），它就会出现在这里；也可以切回「全部分组」。'
          : '这个分组里还没有书。给书填上这个分组（书卡「⋯」→「书籍信息」），它就会出现在这里；也可以切回「全部分组」。';
      const tagEmptyText = () =>
        `没有带「#${state.shelfTag}」标签的书。给书加这个标签（书卡「⋯」→「书籍信息」），它就会出现在这里；也可以切回「全部标签」。`;
      if (!query && (state.shelfGroup || state.shelfTag)) {
        empty.dataset.emptyKind = 'filtered';
        empty.textContent = [state.shelfGroup ? groupEmptyText() : '', state.shelfTag ? tagEmptyText() : '']
          .filter(Boolean)
          .join(' ');
      } else if (content.loading) {
        empty.dataset.emptyKind = 'loading';
        empty.textContent =
          '书名 / 作者 / 章节名没有匹配。正在正文里继续找，找到后会出现在上方「正文命中」，不用重新搜。';
      } else {
        empty.dataset.emptyKind = 'filtered';
        empty.textContent =
          contentHits > 0
            ? `书名 / 作者 / 章节名没有匹配；正文找到 ${contentHits} 处，见上方「正文命中」。`
            : `没有找到匹配「${query}」的书。搜索会看书名 / 作者 / 分组 / 标签 / 章节名，也会在正文里找；` +
              '换一个更短或更具体的词再试，按 Esc 清空搜索。';
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
    return JSON.stringify({ query, group: state.shelfGroup, tag: state.shelfTag, books: state.books.length, cards });
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
    // 1.6.0 F5：标签筛选与上面这条同一口径（只改内存里的筛选状态，再重渲染书架）。
    $('shelf-tag-filter').addEventListener('change', (event) => {
      state.shelfTag = String(event.target.value || '');
      renderShelf();
    });
    $('btn-shelf-group-manage').addEventListener('click', () => {
      openGroupManageDialog();
    });
    $('btn-group-manage-close').addEventListener('click', closeGroupManageDialog);
  }


    return {
      openBookInfoDialog,
      closeBookInfoDialog,
      readBookInfoForm,
      saveBookInfoDialog,
      // 1.6.0 F5：分组管理（改名 / 合并）、单本「移到分组…」
      openGroupManageDialog,
      closeGroupManageDialog,
      renameShelfGroup,
      mergeShelfGroup,
      // 1.6.0b：书卡右键「移到分组…」的菜单内联分组列表（不再弹询问框）
      openBookGroupChooser,
      closeBookGroupChooser,
      newGroupForBook,
      moveBookToGroup,
      renderShelf,
      createBookWithTitle,
      onNewBookClick,
      setupBookinfoUi,
      maybeShowFirstRunTip
    };
  }

  return { create: createBookinfoUi, REQUIRED_HOST };
});
