/* 校对（第 4 步 renderer 九刀·第四刀：从 renderer.js 的「校对」分区整段搬出来）。
 *
 * 搬走的段（原 renderer.js 3991–4343，353 行）—— 只报告不改动的校对面板（v0.8 提案 5.1）：
 *   规则表（PROOFREAD_ROW_LIMIT / PROOFREAD_RULE_ORDER / PROOFREAD_RULE_LABELS）、词表状态文案与刷新、
 *   面板开 / 关 / 范围、当前章内容快照、摘要与结果列表（含截断提示）、位置定位（matchRangeAt）、
 *   点一条跳到对应章 / 位置（jumpToProofreadIssue）、跑校对（当前章用编辑区内容、整本只读磁盘）、
 *   选校对词表（persist=false 进设置草稿 / persist=true 立刻写配置并重跑）。
 * **只搬不改行为**：文案 / class / DOM 结构 / 返回结构 / 忙碌态 / 失败兜底 / 「一次最多列 300 条」全部一字未改。
 *
 * 契约：createProofreadUi(host) 由渲染层调用一次。host 8 个成员（含 3 个语义分组，分组内每个真实依赖都列在这里）：
 *   host = {
 *     $, state, api, call, toast,          // 基础 5：DOM 查询 / 共享状态 / IPC 白名单 / IPC 包装 / 提示
 *     peers: {                              // 与相邻面板 / 设置域协作的回调
 *       closeFindPanel,                     //   打开校对前若查找面板开着先关掉
 *       renderProofreadSettings             //   选完词表后刷新「设置 → 校对词表」那一行
 *     },
 *     nav: {                                // 章节与编辑器
 *       chapterTitle,                       //   「第N章 标题」唯一口径
 *       editorEl,                           //   当前章正文（未保存也算，只参与这次检查）
 *       switchChapter                       //   点整本结果时切章
 *     },
 *     view: {                               // 顶栏菜单 / 生效配置 / 光标滚动
 *       effectiveConfig,                    //   选词表后重算生效配置（全局 + 当前书覆盖）
 *       hideHeaderMenus,                    //   打开面板前收起顶栏菜单
 *       scrollCaretIntoView                 //   跳过去后把光标滚进视野
 *     }
 *   }
 * 缺任何一个（含分组内成员）直接抛 TypeError。分组在 create 时一次解构，行为等价。
 * create() 不注册事件、不建定时器、不碰 DOM；事件绑定在 setupProofreadUi()，由 bindEvents() 在
 * 原「校对 3 个按钮 + 范围 change」的位置调用一次。
 *
 * 刻意不搬（留在 renderer.js）：设置域的 renderProofreadSettings 本体、查找域、Esc 动作表
 * （'close-proofread'）、测试钩子宿主契约（按名字取本模块入口）。
 *
 * 浏览器里挂成全局 CWProofreadUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWProofreadUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HOST = ['$', 'state', 'api', 'call', 'toast', 'peers', 'nav', 'view'];

  function createProofreadUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createProofreadUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) throw new TypeError('createProofreadUi 的 host 缺少 ' + key);
    }
    const { $, state, api, call, toast, peers, nav, view } = host;
    if (typeof peers !== 'object') throw new TypeError('createProofreadUi 的 host.peers 必须是对象');
    for (const key of ['closeFindPanel', 'renderProofreadSettings']) {
      if (peers[key] === undefined || peers[key] === null) throw new TypeError('createProofreadUi 的 host.peers 缺少 ' + key);
    }
    if (typeof nav !== 'object') throw new TypeError('createProofreadUi 的 host.nav 必须是对象');
    for (const key of ['chapterTitle', 'editorEl', 'switchChapter']) {
      if (nav[key] === undefined || nav[key] === null) throw new TypeError('createProofreadUi 的 host.nav 缺少 ' + key);
    }
    if (typeof view !== 'object') throw new TypeError('createProofreadUi 的 host.view 必须是对象');
    for (const key of ['effectiveConfig', 'hideHeaderMenus', 'scrollCaretIntoView']) {
      if (view[key] === undefined || view[key] === null) throw new TypeError('createProofreadUi 的 host.view 缺少 ' + key);
    }
    const { closeFindPanel, renderProofreadSettings } = peers;
    const { chapterTitle, editorEl, switchChapter } = nav;
    const { effectiveConfig, hideHeaderMenus, scrollCaretIntoView } = view;

  // ---------- 校对（只报告，不改动；提案 5.1） ----------
  // 规则 / 阈值都在主进程 core/proofread.js（单测覆盖）；这里只负责面板、结果列表和「点一条跳过去」。
  // 和查找一样：当前章用编辑区里的内容（未保存也算，只参与检查）；整本由主进程逐章只读磁盘。
  const PROOFREAD_ROW_LIMIT = 300;
  const PROOFREAD_RULE_ORDER = [
    'halfwidth-punct',
    'long-paragraph',
    'repeat-word',
    'punct-run',
    'blank-lines',
    'custom-word'
  ];
  const PROOFREAD_RULE_LABELS = {
    'halfwidth-punct': '半角标点',
    'long-paragraph': '超长段落',
    'repeat-word': '重复用词',
    'punct-run': '连续标点',
    'blank-lines': '多余空行',
    'custom-word': '自定义词表'
  };

  // 校对词表状态文案（面板 / 设置共用）：未设置、文件没了、编码坏了都直说。
  // 词表是**可选**的：没有词表照样跑内置五条规则。
  function proofreadWordListText(info) {
    if (!info) return '正在读取校对词表…';
    if (!info.ok) {
      if (info.code === 'GLOSSARY_NOT_CONFIGURED') {
        return '还没有指定校对词表（应用不内置词表；没有词表时只跑内置的五条规则）';
      }
      return info.message || '校对词表读取失败';
    }
    let text = `校对词表：${info.name}（${info.count} 个词`;
    if (info.stats && info.stats.suggestions) text += `，${info.stats.suggestions} 个带建议`;
    text += '）';
    const skipped = [];
    if (info.stats && info.stats.duplicates) skipped.push(`${info.stats.duplicates} 个重复`);
    if (info.stats && info.stats.tooLong) skipped.push(`${info.stats.tooLong} 行超长`);
    if (info.stats && info.stats.invalid) skipped.push(`${info.stats.invalid} 行没有词`);
    if (info.stats && info.stats.comments) skipped.push(`${info.stats.comments} 行注释`);
    if (info.stats && info.stats.truncated) skipped.push('超过 5000 个只取前 5000 个');
    if (skipped.length) text += `（已忽略 ${skipped.join('、')}）`;
    return text;
  }

  function renderProofreadWordList() {
    const el = $('proofread-wordlist-text');
    if (!el) return;
    const info = state.proofreadWordList;
    el.textContent = proofreadWordListText(info);
    el.classList.toggle('warn', Boolean(info && info.ok === false));
  }

  // 只读：取当前配置里的校对词表状态（不把词表正文带到渲染层）
  async function refreshProofreadWordList() {
    try {
      state.proofreadWordList = await call(api.proofreadWordsInfo);
    } catch (err) {
      state.proofreadWordList = { ok: false, code: 'ERROR', message: `读取校对词表失败：${err.message}` };
    }
    renderProofreadWordList();
    return state.proofreadWordList;
  }

  async function openProofreadPanel() {
    if (!state.bookPath) {
      toast('先打开一本书再校对', 'warn');
      return false;
    }
    hideHeaderMenus();
    if (!$('find-backdrop').classList.contains('hidden')) closeFindPanel();
    $('proofread-scope').value = state.proofreadScope === 'book' ? 'book' : 'current';
    $('proofread-backdrop').classList.remove('hidden');
    // 先读一次词表状态（只读），再自动检查当前章；词表有问题只显示提示，不影响内置规则
    await refreshProofreadWordList();
    await runProofread();
    return true;
  }

  function closeProofreadPanel() {
    $('proofread-backdrop').classList.add('hidden');
  }

  function proofreadScope() {
    return $('proofread-scope').value === 'book' ? 'book' : 'current';
  }

  // 当前章的最新内容（未保存也算；只用于这一次检查，不写盘）
  function currentChapterRef() {
    const chapter = state.chapters[state.index];
    if (!chapter) return null;
    return { chapterId: chapter.id, chapterFile: chapter.file, text: editorEl.value };
  }

  function proofreadRuleSummary(counts) {
    return PROOFREAD_RULE_ORDER.filter((rule) => counts && counts[rule])
      .map((rule) => `${PROOFREAD_RULE_LABELS[rule]} ${counts[rule]}`)
      .join(' · ');
  }

  function setProofreadBusy(busy) {
    state.proofreadBusy = Boolean(busy);
    $('proofread-busy').classList.toggle('hidden', !busy);
    $('btn-proofread-run').disabled = Boolean(busy);
  }

  function proofreadChapterTitle(issue) {
    let index = Number(issue.chapterIndex);
    const byIndex =
      Number.isInteger(index) && index >= 0 && state.chapters[index] && state.chapters[index].id === issue.chapterId;
    if (!byIndex) index = state.chapters.findIndex((chapter) => chapter.id === issue.chapterId);
    if (index < 0) return String(issue.chapterName || '').trim() || '（已删除的章节）';
    return chapterTitle(index, issue.chapterName);
  }

  function proofreadPositionText(issue) {
    const line = Number(issue.line);
    const column = Number(issue.column);
    if (!Number.isFinite(line) || !Number.isFinite(column)) return '';
    return `第 ${line} 行 · 第 ${column} 字`;
  }

  function renderProofreadSummary() {
    const payload = state.proofread;
    const summary = $('proofread-summary');
    if (!payload) {
      summary.textContent = '';
      return;
    }
    const rules = proofreadRuleSummary(payload.byRule);
    const truncatedNote = payload.truncated ? '（明细只列出一部分，总数照实统计）' : '';
    if (payload.scope === 'book') {
      const hit = Number(payload.chapterHitCount) || 0;
      const skipped = Number(payload.skippedChapters) || 0;
      summary.textContent = payload.total
        ? `全书 ${payload.chapterCount} 章共 ${payload.total} 处可疑，涉及 ${hit} 章：${rules}${truncatedNote}`
        : `全书 ${payload.chapterCount} 章没有发现可疑的地方${
            skipped ? `（跳过 ${skipped} 个缺文件的章节）` : ''
          }`;
      return;
    }
    summary.textContent = payload.total
      ? `本章共 ${payload.total} 处可疑：${rules}${truncatedNote}`
      : '本章没有发现可疑的地方（只检查空白、标点、段落长度、重复用词和你的校对词表，不判断文字好坏）';
  }

  function renderProofreadResults() {
    const box = $('proofread-results');
    box.innerHTML = '';
    const payload = state.proofread;
    if (!payload) return;
    if (!payload.issues.length) {
      const empty = document.createElement('div');
      empty.className = 'proofread-empty';
      empty.textContent = payload.scope === 'book' ? '整本书没有发现可疑的地方' : '这一章没有发现可疑的地方';
      box.appendChild(empty);
      return;
    }
    const rows = payload.issues.slice(0, PROOFREAD_ROW_LIMIT);
    for (const issue of rows) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'proofread-result';
      row.dataset.rule = issue.rule;
      row.dataset.chapterId = issue.chapterId == null ? '' : issue.chapterId;
      row.dataset.index = String(issue.index);

      const head = document.createElement('div');
      head.className = 'proofread-head';
      const rule = document.createElement('span');
      rule.className = `proofread-rule rule-${issue.rule}`;
      rule.textContent = PROOFREAD_RULE_LABELS[issue.rule] || '可疑';
      head.appendChild(rule);
      if (payload.scope === 'book') {
        const chapter = document.createElement('span');
        chapter.className = 'proofread-chapter';
        chapter.textContent = proofreadChapterTitle(issue);
        head.appendChild(chapter);
      }
      const pos = document.createElement('span');
      pos.className = 'proofread-pos';
      pos.textContent = proofreadPositionText(issue);
      head.appendChild(pos);

      const message = document.createElement('div');
      message.className = 'proofread-message';
      message.textContent = issue.message || '';

      const snippet = document.createElement('div');
      snippet.className = 'proofread-snippet';
      if (issue.snippet) {
        if (issue.snippet.ellipsisStart) snippet.appendChild(document.createTextNode('…'));
        snippet.appendChild(document.createTextNode(issue.snippet.before || ''));
        const mark = document.createElement('mark');
        mark.textContent = issue.snippet.match || '';
        snippet.appendChild(mark);
        snippet.appendChild(document.createTextNode(issue.snippet.after || ''));
        if (issue.snippet.ellipsisEnd) snippet.appendChild(document.createTextNode('…'));
      }
      row.append(head, message, snippet);
      row.addEventListener('click', () => jumpToProofreadIssue(issue));
      box.appendChild(row);
    }
    if (payload.issues.length > rows.length) {
      const more = document.createElement('div');
      more.className = 'proofread-more';
      more.textContent = `还有 ${payload.issues.length - rows.length} 条没有显示（一次最多列 ${PROOFREAD_ROW_LIMIT} 条；可以先只校对当前章）`;
      box.appendChild(more);
    }
  }

  // 正文可能在上次检查之后被改过：先按位置核对，对不上就在附近再找一次，找不到就落回原位置
  // （校对 / 敏感词预检共用：都是「按 index + 命中的文字」在编辑区里定位）
  function matchRangeAt(text, issue) {
    const source = String(text == null ? '' : text);
    const match = String(issue.match || '');
    const fallbackStart = Math.min(Math.max(0, Number(issue.index) || 0), source.length);
    if (!match) {
      const length = Math.max(1, Math.min(Number(issue.length) || 1, source.length - fallbackStart));
      return { start: fallbackStart, end: fallbackStart + length };
    }
    if (source.slice(fallbackStart, fallbackStart + match.length) === match) {
      return { start: fallbackStart, end: fallbackStart + match.length };
    }
    const near = source.indexOf(match, Math.max(0, fallbackStart - 500));
    if (near >= 0) return { start: near, end: near + match.length };
    return {
      start: fallbackStart,
      end: Math.min(source.length, fallbackStart + Math.max(match.length, 1))
    };
  }

  async function jumpToProofreadIssue(issue) {
    if (!state.bookPath) return { ok: false };
    let index = Number(issue.chapterIndex);
    const byIndex =
      Number.isInteger(index) && index >= 0 && state.chapters[index] && state.chapters[index].id === issue.chapterId;
    if (!byIndex) index = state.chapters.findIndex((chapter) => chapter.id === issue.chapterId);
    // 兜底：当前章的结果万一没带章信息，就落在正在看的这一章
    if (index < 0 && issue.chapterId == null) index = state.index;
    if (index < 0) {
      toast('这一章已经不存在了', 'warn');
      return { ok: false };
    }
    closeProofreadPanel();
    if (index !== state.index) {
      const switched = await switchChapter(index);
      if (!switched || switched.ok === false) {
        return { ok: false, canceled: Boolean(switched && switched.canceled) };
      }
    }
    const range = matchRangeAt(editorEl.value, issue);
    editorEl.focus();
    editorEl.setSelectionRange(range.start, range.end);
    scrollCaretIntoView(range.start);
    return { ok: true, start: range.start, end: range.end };
  }

  async function runProofread() {
    if (!state.bookPath || !state.chapters.length) {
      $('proofread-summary').textContent = '这本书里还没有章节';
      return { ok: false, message: '没有章节' };
    }
    if (state.proofreadBusy) return { ok: false, message: '正在校对中' };
    const scope = proofreadScope();
    state.proofreadScope = scope;
    setProofreadBusy(true);
    $('proofread-summary').textContent =
      scope === 'book' ? '正在通读全书（只读，不改正文）…' : '正在检查当前章…';
    $('proofread-results').innerHTML = '';
    try {
      let payload;
      if (scope === 'book') {
        const override = currentChapterRef();
        payload = await call(api.proofreadBook, state.bookPath, {}, override);
        payload.scope = 'book';
      } else {
        const res = await call(api.proofreadText, editorEl.value, {});
        const chapter = state.chapters[state.index];
        // 当前章的结果也带上章信息，点结果时才能定位（和整本结果结构保持一致）
        payload = {
          ...res,
          issues: res.issues.map((issue) => ({
            ...issue,
            chapterId: chapter ? chapter.id : null,
            chapterIndex: state.index,
            chapterName: chapter ? chapter.name : ''
          })),
          scope: 'current',
          chapterId: chapter ? chapter.id : null,
          chapterIndex: state.index,
          chapterName: chapter ? chapter.name : '',
          chapters: res.total
            ? [
                {
                  chapterId: chapter ? chapter.id : null,
                  chapterIndex: state.index,
                  name: chapter ? chapter.name : '',
                  total: res.total,
                  byRule: res.byRule,
                  truncated: res.truncated
                }
              ]
            : []
        };
      }
      state.proofread = payload;
      if (payload.wordList) state.proofreadWordList = payload.wordList;
      renderProofreadWordList();
      renderProofreadSummary();
      renderProofreadResults();
      return { ok: true, total: payload.total, scope: payload.scope, customWordCount: payload.customWordCount };
    } catch (err) {
      state.proofread = null;
      $('proofread-summary').textContent = `校对失败：${err.message}`;
      $('proofread-results').innerHTML = '';
      return { ok: false, message: err.message };
    } finally {
      setProofreadBusy(false);
    }
  }

  // 选校对词表：persist=false 只放进设置草稿（点「保存设置」才落配置）；
  // persist=true 用于校对面板里直接选，选完立刻写配置并重跑一次校对。
  async function pickProofreadWords({ persist = false } = {}) {
    try {
      const picked = await call(api.pickProofreadWords);
      if (!picked || picked.canceled) return { canceled: true };
      if (!picked.ok) {
        toast(`这个词表不能用：${picked.message}`, 'error');
        return picked;
      }
      if (persist) {
        const cfg = await call(api.setConfig, { proofreadWordsPath: picked.path });
        state.globalConfig = cfg;
        state.config = effectiveConfig();
        state.proofreadWordsDraft = cfg.proofreadWordsPath || '';
      } else {
        state.proofreadWordsDraft = picked.path;
      }
      state.proofreadWordsInfo = picked;
      state.proofreadWordList = picked;
      renderProofreadWordList();
      renderProofreadSettings();
      toast(`已选择校对词表：${picked.name}（${picked.count} 个词）`);
      if (persist && !$('proofread-backdrop').classList.contains('hidden')) {
        await runProofread();
      }
      return picked;
    } catch (err) {
      toast(`选择校对词表失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  // 事件绑定（与搬前 bindEvents() 里的校对块 + 范围 change 逐行一致；由渲染层在原位置调用一次）
  function setupProofreadUi() {
    $('btn-proofread').addEventListener('click', openProofreadPanel);
    $('btn-proofread-run').addEventListener('click', runProofread);
    $('btn-proofread-close').addEventListener('click', closeProofreadPanel);
    $('proofread-scope').addEventListener('change', () => {
      state.proofreadScope = proofreadScope();
      // 换了范围就先收起旧结果，免得摘要写着「整本」、列表还是上一章的内容
      state.proofread = null;
      $('proofread-results').innerHTML = '';
      $('proofread-summary').textContent =
        state.proofreadScope === 'book'
          ? '已切到整本书：点「开始校对」通读全书（只读，缺文件的章节会跳过）。'
          : '已切到当前这一章：点「开始校对」检查编辑区里的最新内容。';
    });
  }


    return {
      proofreadWordListText,
      refreshProofreadWordList,
      openProofreadPanel,
      closeProofreadPanel,
      proofreadScope,
      currentChapterRef,
      matchRangeAt,
      runProofread,
      pickProofreadWords,
      setupProofreadUi
    };
  }

  return { create: createProofreadUi, REQUIRED_HOST };
});
