/* 敏感词预检（第 4 步 renderer 九刀·第五刀：从 renderer.js 的「敏感词预检」分区整段搬出来）。
 *
 * 搬走的段（原 renderer.js 4005–4327，323 行）—— 只报告不改动的敏感词预检面板（v0.8 提案 5.2）：
 *   词表状态文案与刷新（sensitiveWordListText / renderSensitiveWordList / refreshSensitiveWordList）、
 *   面板开 / 关 / 范围、忙碌态、摘要（含 byWord 前 6 个 + 截断提示）、结果列表（词 / 章 / 位置 / 片段，
 *   一次最多 300 条）、点一条跳到对应位置的兜底定位、跑预检（当前章用编辑区内容、整本只读磁盘）、
 *   选词表（persist=false 进设置草稿 / persist=true 立刻写配置并重跑）。
 * **只搬不改行为**：文案 / class / DOM 结构 / 返回结构 / payload.ok===false 的降级路径 / 忙碌态 /
 *   失败兜底全部一字未改（这次没有一行文案或样式改动）。
 *
 * 契约：createSensitiveUi(host) 由渲染层调用一次。host 10 个成员（含 3 个语义分组，分组内每个真实依赖都列在这里）：
 *   host = {
 *     $, state, api, call, toast,          // 基础 5：DOM 查询 / 共享状态 / IPC 白名单 / IPC 包装 / 提示
 *     staleGuard,                          // WP-15：在途回执的世代令牌（stale-guard.js 的 chapterIdentity）
 *     peers: {                              // 相邻面板 / 设置域的协作入口
 *       closeFindPanel,                     //   打开预检前若查找面板开着先关掉
 *       closeProofreadPanel,                //   打开预检前若校对面板开着先关掉
 *       currentChapterRef,                  //   整本预检时带上「当前章编辑区最新内容」的 override（校对域导出）
 *       matchRangeAt,                       //   正文改过后按 index + 命中文字重新定位（校对域导出，同一份实现）
 *       renderSensitiveSettings             //   选完词表后刷新「设置 → 敏感词词表」那一行
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
 *     },
 *     resultJump                            // 结果跳转共用实现（renderer/result-jump-ui.js 的 create）
 *   }
 * 缺任何一个（含分组内成员）直接抛 TypeError。分组在 create 时一次解构，行为等价。
 * create() 不注册事件、不建定时器、不碰 DOM；事件绑定在 setupSensitiveUi()，由 bindEvents() 在原
 * 「敏感词 3 个按钮 + 范围 change」的位置调用一次。
 *
 * 刻意不搬（留在 renderer.js）：设置域的 renderSensitiveSettings 本体、校对域的两个定位函数本体、
 * Esc 动作表（'close-sensitive'）、导出菜单里的 'sensitive' 转发、测试钩子宿主契约（按名字取本模块入口）。
 *
 * 浏览器里挂成全局 CWSensitiveUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../core/assert-host').assertHost);
  } else if (root) {
    root.CWSensitiveUi = factory(root.CWAssertHost && root.CWAssertHost.assertHost);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (assertHost) {
  'use strict';

  const REQUIRED_HOST = ['$', 'state', 'api', 'call', 'toast', 'peers', 'nav', 'view', 'staleGuard', 'resultJump'];
  // RPAN-C08：嵌套分组（peers / nav / view）交给共享 assertHost 的第四个参数统一校验，
  // 不再逐组手写「判对象 + for 循环判键」（文案与旧实现逐字一致）。
  const REQUIRED_GROUPS = [
    { path: 'peers', keys: ['closeFindPanel', 'closeProofreadPanel', 'currentChapterRef', 'matchRangeAt', 'renderSensitiveSettings'] },
    { path: 'nav', keys: ['chapterTitle', 'editorEl', 'switchChapter'] },
    { path: 'view', keys: ['effectiveConfig', 'hideHeaderMenus', 'scrollCaretIntoView'] }
  ];

  function createSensitiveUi(host) {
    // A8（WP-32）：REQUIRED_HOST 逐成员校验走共享实现（文案不变）；嵌套分组见 REQUIRED_GROUPS。
    assertHost('createSensitiveUi', host, REQUIRED_HOST, REQUIRED_GROUPS);
    const { $, state, api, call, toast, peers, nav, view, staleGuard } = host;
    if (!staleGuard || typeof staleGuard.chapterIdentity !== 'function') {
      throw new TypeError('createSensitiveUi 的 host.staleGuard 必须是 stale-guard.js 的导出');
    }
    if (!host.resultJump || typeof host.resultJump.create !== 'function') {
      throw new TypeError('createSensitiveUi 的 host.resultJump 必须提供 create');
    }
    const { closeFindPanel, closeProofreadPanel, currentChapterRef, matchRangeAt, renderSensitiveSettings } = peers;
    const { chapterTitle, editorEl, switchChapter } = nav;
    const { effectiveConfig, hideHeaderMenus, scrollCaretIntoView } = view;
    // 1.7.0 P4-1：和校对共用的「点结果 → 跳过去选中」（原来两个模块各写一份逐行复制）
    const { jumpToResult } = host.resultJump.create({
      state, toast,
      peers: { matchRangeAt },
      nav: { editorEl, switchChapter },
      view: { scrollCaretIntoView }
    });

  // ---------- 敏感词预检（只报告，不改动；提案 5.2） ----------
  // 词表完全由作者管理：应用不内置任何词表，只按作者在设置里选的 txt（每行一个词）报告命中。
  // 当前章用编辑区内容（未保存也算，只参与检查）；整本由主进程逐章只读磁盘，全程不写盘。
  const SENSITIVE_ROW_LIMIT = 300;

  // 词表状态文案（面板 / 设置共用）：未设置、文件没了、编码坏了都直说
  function sensitiveWordListText(info) {
    if (!info) return '正在读取词表…';
    if (!info.ok) {
      if (info.code === 'WORD_LIST_NOT_CONFIGURED') {
        return '还没有指定词表（应用不内置词表，请选一个自己的 txt）';
      }
      return info.message || '词表读取失败';
    }
    let text = `词表：${info.name}（${info.count} 个词）`;
    const skipped = [];
    if (info.stats && info.stats.duplicates) skipped.push(`${info.stats.duplicates} 个重复`);
    if (info.stats && info.stats.tooLong) skipped.push(`${info.stats.tooLong} 行超长`);
    if (info.stats && info.stats.truncated) skipped.push('超过 5000 个只取前 5000 个');
    if (skipped.length) text += `（已跳过 ${skipped.join('、')}）`;
    return text;
  }

  // 五-M13（SE-01）：词表状态世代。整本预检在途时作者还可能换词表（或设置页保存后刷新状态）——
  // 回包里的 wordList 是发起时的快照，不能反向覆盖刚更新的状态（否则状态行与结果仍是旧词表）。
  // 每次本地改写 state.sensitiveWordList 都推进这一代；落地时不是发起那一代就不采用回包的 wordList。
  let sensitiveWordListSeq = 0;

  // T-15（仿校对 RPAN-A-03）：面板世代。关面板时推进；在途回执回来时世代对不上就整份丢弃。
  // 否则「整本预检在飞 → Esc 关 → 立即重开」时，三重复核（章身份 / 范围 / 词表世代）全都成立，
  // 旧回包会把旧快照画回重开的面板。
  let sensitiveEpoch = 0;
  // A2-PANEL-01：这一轮预检结果属于哪本书（打开面板时按归属丢弃上一本的旧结果）
  let sensitiveOwnerPath = '';

  function renderSensitiveWordList() {
    const el = $('sensitive-wordlist-text');
    if (!el) return;
    const info = state.sensitiveWordList;
    el.textContent = sensitiveWordListText(info);
    el.classList.toggle('warn', Boolean(info && info.ok === false));
  }

  // 只读：取当前配置里的词表状态（不把词表内容带到渲染层）
  async function refreshSensitiveWordList() {
    try {
      state.sensitiveWordList = await call(api.sensitiveWordsInfo);
    } catch (err) {
      state.sensitiveWordList = { ok: false, code: 'ERROR', message: `读取词表失败：${err.message}` };
    }
    sensitiveWordListSeq += 1; // 五-M13：状态刚被刷新，在途预检的旧快照不再回写
    renderSensitiveWordList();
    return state.sensitiveWordList;
  }

  async function openSensitivePanel() {
    if (!state.bookPath) {
      toast('先打开一本书再预检', 'warn');
      return false;
    }
    hideHeaderMenus();
    if (!$('find-backdrop').classList.contains('hidden')) closeFindPanel();
    if (!$('proofread-backdrop').classList.contains('hidden')) closeProofreadPanel();
    // A2-PANEL-01（低）：与校对面板同一口径 —— 上一轮结果属于另一本书时先按归属丢弃（0 章书 /
    // 忙碌时 runSensitiveCheck 会早退，清空逻辑在其后，旧结果会顶在面板上冒充当前书的问题）。
    if (state.sensitive && sensitiveOwnerPath !== state.bookPath) {
      state.sensitive = null;
      $('sensitive-results').innerHTML = '';
      $('sensitive-summary').textContent = '';
    }
    $('sensitive-scope').value = state.sensitiveScope === 'book' ? 'book' : 'current';
    $('sensitive-backdrop').classList.remove('hidden');
    await refreshSensitiveWordList();
    // 词表可用就先检查一遍当前章，不用再点一次；词表有问题只显示提示
    if (state.sensitiveWordList && state.sensitiveWordList.ok) {
      await runSensitiveCheck();
    } else {
      state.sensitive = null;
      renderSensitiveSummary();
      renderSensitiveResults();
    }
    return true;
  }

  function closeSensitivePanel() {
    // T-15：关面板 = 作废这一轮在途预检（主进程没有取消通道：整本只读、跑完就停，渲染层负责丢迟到回执）
    sensitiveEpoch += 1;
    $('sensitive-backdrop').classList.add('hidden');
  }

  function sensitiveScope() {
    return $('sensitive-scope').value === 'book' ? 'book' : 'current';
  }

  function setSensitiveBusy(busy) {
    state.sensitiveBusy = Boolean(busy);
    $('sensitive-busy').classList.toggle('hidden', !busy);
    $('btn-sensitive-run').disabled = Boolean(busy);
  }

  // 五-M13（SE-01）：预检在途时换了词表 —— 这一轮结束后按最新词表补跑一次（不并发、不吞操作）。
  let sensitiveRerunPending = false;

  function sensitiveChapterTitle(match) {
    let index = Number(match.chapterIndex);
    const byIndex =
      Number.isInteger(index) && index >= 0 && state.chapters[index] && state.chapters[index].id === match.chapterId;
    if (!byIndex) index = state.chapters.findIndex((chapter) => chapter.id === match.chapterId);
    if (index < 0) return String(match.chapterName || '').trim() || '（已删除的章节）';
    return chapterTitle(index, match.chapterName);
  }

  function sensitivePositionText(match) {
    const line = Number(match.line);
    const column = Number(match.column);
    if (!Number.isFinite(line) || !Number.isFinite(column)) return '';
    return `第 ${line} 行 · 第 ${column} 字`;
  }

  function sensitiveWordSummary(payload) {
    if (!payload.byWord || !payload.byWord.length) return '';
    return (
      '：' +
      payload.byWord
        .slice(0, 6)
        .map((item) => `${item.word} ${item.count}`)
        .join(' · ')
    );
  }

  function renderSensitiveSummary() {
    const summary = $('sensitive-summary');
    if (!summary) return;
    const payload = state.sensitive;
    const info = state.sensitiveWordList;
    if (!payload) {
      if (info && info.ok) {
        summary.textContent = '点「开始预检」检查当前章；切成整本后点一次会通读全书。';
      } else if (info) {
        summary.textContent = info.message || '词表不可用';
      } else {
        summary.textContent = '';
      }
      return;
    }
    if (payload.ok === false) {
      summary.textContent = payload.message || '词表不可用';
      return;
    }
    const truncatedNote = payload.truncated ? '（明细只列出一部分）' : '';
    const words = sensitiveWordSummary(payload);
    if (payload.scope === 'book') {
      const skipped = Number(payload.skippedChapters) || 0;
      summary.textContent = payload.total
        ? `全书 ${payload.chapterCount} 章命中 ${payload.total} 处，涉及 ${payload.chapterHitCount} 章、${payload.wordHitCount} 个词${words}${truncatedNote}`
        : `全书 ${payload.chapterCount} 章没有命中词表里的词${
            skipped ? `（跳过 ${skipped} 个缺文件的章节）` : ''
          }`;
      return;
    }
    summary.textContent = payload.total
      ? `本章命中 ${payload.total} 处，涉及 ${payload.wordHitCount} 个词${words}${truncatedNote}`
      : '本章没有命中词表里的词（只按你的词表做字面匹配，不判断文字好坏）';
  }

  function renderSensitiveResults() {
    const box = $('sensitive-results');
    if (!box) return;
    box.innerHTML = '';
    const payload = state.sensitive;
    if (!payload || payload.ok === false) return;
    if (!payload.matches.length) {
      const empty = document.createElement('div');
      empty.className = 'proofread-empty';
      empty.textContent = payload.scope === 'book' ? '整本书没有命中词表里的词' : '这一章没有命中词表里的词';
      box.appendChild(empty);
      return;
    }
    const rows = payload.matches.slice(0, SENSITIVE_ROW_LIMIT);
    for (const match of rows) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'proofread-result sensitive-result';
      row.dataset.word = match.word;
      row.dataset.chapterId = match.chapterId == null ? '' : match.chapterId;
      row.dataset.index = String(match.index);

      const head = document.createElement('div');
      head.className = 'proofread-head';
      const word = document.createElement('span');
      word.className = 'proofread-rule sensitive-word';
      word.textContent = `「${match.word}」`;
      head.appendChild(word);
      if (payload.scope === 'book') {
        const chapter = document.createElement('span');
        chapter.className = 'proofread-chapter';
        chapter.textContent = sensitiveChapterTitle(match);
        head.appendChild(chapter);
      }
      const pos = document.createElement('span');
      pos.className = 'proofread-pos';
      pos.textContent = sensitivePositionText(match);
      head.appendChild(pos);

      const snippet = document.createElement('div');
      snippet.className = 'proofread-snippet';
      if (match.snippet) {
        if (match.snippet.ellipsisStart) snippet.appendChild(document.createTextNode('…'));
        snippet.appendChild(document.createTextNode(match.snippet.before || ''));
        const mark = document.createElement('mark');
        mark.textContent = match.snippet.match || '';
        snippet.appendChild(mark);
        snippet.appendChild(document.createTextNode(match.snippet.after || ''));
        if (match.snippet.ellipsisEnd) snippet.appendChild(document.createTextNode('…'));
      }
      row.append(head, snippet);
      row.addEventListener('click', () => jumpToSensitiveMatch(match));
      box.appendChild(row);
    }
    if (payload.matches.length > rows.length) {
      const more = document.createElement('div');
      more.className = 'proofread-more';
      more.textContent = `还有 ${payload.matches.length - rows.length} 条没有显示（一次最多列 ${SENSITIVE_ROW_LIMIT} 条；可以先只预检当前章）`;
      box.appendChild(more);
    }
  }

  // 实现在 renderer/result-jump-ui.js（和校对同一份）：先关面板 → 切章 → 定位选中 → 滚进视野。
  async function jumpToSensitiveMatch(match) {
    return jumpToResult(match, closeSensitivePanel);
  }

  // WP-15（V202 / 复核 R5）：await 期间换书 / 换章时，结果不能标到现在的章名下
  // （点条目会跳错章、摘要「本章 N 处」与内容不符）。作废后清掉结果并提示重跑。
  function discardStaleSensitiveRun() {
    state.sensitive = null;
    $('sensitive-summary').textContent = '预检期间已经换了书或章节，这次结果没有显示；请重新预检';
    $('sensitive-results').innerHTML = '';
    return { ok: false, stale: true, message: '预检期间已经换了书或章节' };
  }

  // 五-L19（SE-02）：范围在途被切换 —— 已按旧范围跑完的结果不再画回。change 处理器已经把旧结果
  // 收起并写了「已切到…」提示，摘要保留它；否则下拉框写「当前章」、摘要 / 列表却重新列整本命中，
  // 与作者刚做的切换意图相反，两套口径在面板上交替。
  function discardSwitchedSensitiveScope() {
    state.sensitive = null;
    $('sensitive-results').innerHTML = '';
    return { ok: false, stale: true, message: '预检范围已经切换' };
  }

  // T-15：发起后关过面板 —— 迟到回执整份丢弃，不往（可能已重开的）面板上画旧快照。
  // 面板可能还开着（关 → 又开、旧一轮还没跑完时的忙态早退），所以给一句明确下一步。
  function discardClosedSensitiveRun() {
    state.sensitive = null;
    $('sensitive-summary').textContent = '预检期间关过面板，这次结果已丢弃；请重新预检';
    $('sensitive-results').innerHTML = '';
    return { ok: false, stale: true, message: '预检已取消' };
  }

  // 审计修复 #43（E17）：主进程回包形状不对（没有命中列表数组）时不再让 .map / .length 抛一句
  // 「res.issues.map is not a function」顶在面板上 —— 按结构化失败处理，面板文案说清下一步。
  function failSensitivePayload() {
    state.sensitive = null;
    $('sensitive-summary').textContent = '预检结果格式不对（没有拿到命中列表），请再点一次预检';
    $('sensitive-results').innerHTML = '';
    return { ok: false, message: '预检结果格式不对' };
  }

  async function runSensitiveCheck() {
    if (!state.bookPath || !state.chapters.length) {
      $('sensitive-summary').textContent = '这本书里还没有章节';
      return { ok: false, message: '没有章节' };
    }
    if (state.sensitiveBusy) return { ok: false, message: '正在预检中' };
    const scope = sensitiveScope();
    // 五-M13（SE-01）：发起时的词表世代。回执回来时词表已经被换过 / 刷新过 → 不采用旧 wordList。
    const wordListSeqAtStart = sensitiveWordListSeq;
    // T-15：发起时的面板世代。期间关过面板 → 这一轮回执整份丢弃，不往重开的面板上画旧结果。
    const epochAtStart = sensitiveEpoch;
    state.sensitiveScope = scope;
    setSensitiveBusy(true);
    $('sensitive-summary').textContent =
      scope === 'book' ? '正在通读全书（只读，不改正文）…' : '正在检查当前章…';
    $('sensitive-results').innerHTML = '';
    // WP-15（V202）：发起时的书 / 章身份先记下；回执回来只对这份身份结算。
    // 审计修复 #43（E17）：身份只取一次，成功路径与失败路径（catch）都用同一份 —— 以前 catch 不结算，
    // 预检在飞期间换书后，上一本书的异常会被写到眼前这本书的面板上、还会清掉现在的结果。
    const expectedIdentity = staleGuard.chapterIdentity(state);
    const expectedBookPath = expectedIdentity.bookPath;
    // A2-PANEL-01：结果归属这本书（下一次打开面板按它判断要不要清旧结果）。
    sensitiveOwnerPath = expectedBookPath;
    try {
      let payload;
      if (scope === 'book') {
        const override = currentChapterRef();
        payload = await call(api.sensitiveCheckBook, expectedBookPath, {}, override);
        if (staleGuard.chapterIdentity(state).bookPath !== expectedBookPath) {
          return discardStaleSensitiveRun();
        }
        payload.scope = 'book';
      } else {
        const chapter = state.chapters[state.index];
        const chapterIndex = state.index;
        const expectedChapter = expectedIdentity;
        const res = await call(api.sensitiveCheckText, editorEl.value, {});
        if (!staleGuard.sameChapterIdentity(expectedChapter, staleGuard.chapterIdentity(state))) {
          return discardStaleSensitiveRun();
        }
        if (res.ok !== false && !Array.isArray(res.issues)) {
          return failSensitivePayload();
        }
        payload = res.ok === false
          ? {
              ...res,
              scope: 'current',
              total: 0,
              matches: [],
              byWord: [],
              wordHitCount: 0,
              chapterId: chapter ? chapter.id : null,
              chapterIndex,
              chapterName: chapter ? chapter.name : ''
            }
          : {
              ...res,
              // 当前章的结果也带上章信息，点结果时才能定位（和整本结果结构保持一致）
              matches: res.issues.map((issue) => ({
                ...issue,
                chapterId: chapter ? chapter.id : null,
                chapterIndex,
                chapterName: chapter ? chapter.name : ''
              })),
              scope: 'current',
              chapterId: chapter ? chapter.id : null,
              chapterIndex,
              chapterName: chapter ? chapter.name : ''
            };
      }
      // 五-L19（SE-02）：回包的目标范围必须与当前下拉框一致，否则按 stale 丢弃（不画回旧范围结果；
      // 旧范围的失败 / 形状异常同样不写到已切范围的眼前面板上）
      if (sensitiveScope() !== scope) return discardSwitchedSensitiveScope();
      // T-15：这期间面板被关过（世代已推进）——迟到的整本结果不许画回（重开的面板会是新一轮）。
      if (epochAtStart !== sensitiveEpoch) return discardClosedSensitiveRun();
      // 审计修复 #43（E17）：整本回包同样先确认 matches 是数组，后面 .length / .slice 才安全。
      // 审计残留修复 #43（E17）：必须先排除 ok===false —— 词表读不了之类的失败回包本来就没有
      // matches，旧顺序把它也判成「预检结果格式不对」，吞掉真实错误（词表文件不存在）、
      // wordList 也不刷新。失败回包补成完整形状后交给下面的统一降级路径（摘要显示真实原因）。
      if (payload.ok === false) {
        payload = { ...payload, total: 0, matches: [], byWord: [], wordHitCount: 0 };
      } else if (!Array.isArray(payload.matches)) {
        return failSensitivePayload();
      }
      state.sensitive = payload;
      // 五-M13（SE-01）：只有词表这一代没变过才写回；预检在途换过词表，回包是旧快照。
      if (payload.wordList && wordListSeqAtStart === sensitiveWordListSeq) state.sensitiveWordList = payload.wordList;
      renderSensitiveWordList();
      renderSensitiveSummary();
      renderSensitiveResults();
      return { ok: payload.ok !== false, total: payload.total, scope: payload.scope };
    } catch (err) {
      // T-15：关过面板就不属于眼前这一轮 —— 连失败文案都不许写回（与成功路径同一句作废提示）。
      if (epochAtStart !== sensitiveEpoch) return discardClosedSensitiveRun();
      // 审计修复 #43（E17）：失败也按发起时的身份结算。换了书（当前章范围再看换没换章）就不属于
      // 眼前这份结果 —— 走与成功路径同一句作废提示，不在这里写「预检失败：上一本书的错」。
      const moved = scope === 'book'
        ? staleGuard.chapterIdentity(state).bookPath !== expectedBookPath
        : !staleGuard.sameChapterIdentity(expectedIdentity, staleGuard.chapterIdentity(state));
      if (moved) return discardStaleSensitiveRun();
      state.sensitive = null;
      $('sensitive-summary').textContent = `预检失败：${err.message}`;
      $('sensitive-results').innerHTML = '';
      return { ok: false, message: err.message };
    } finally {
      setSensitiveBusy(false);
      // 五-M13（SE-01）：预检在途时换词表撞 busy 被静默吞掉——跑完按最新词表补跑一次。
      // T-15：面板关过 / 又被关着，就不再补跑（补跑会绕过用户刚做的关闭）。
      if (sensitiveRerunPending) {
        sensitiveRerunPending = false;
        if (epochAtStart === sensitiveEpoch && !$('sensitive-backdrop').classList.contains('hidden')) {
          void runSensitiveCheck();
        }
      }
    }
  }

  // 选词表：persist=false 只放进设置草稿（点「保存设置」才落配置）；
  // persist=true 用于预检面板里直接选，选完立刻写配置并重跑一次预检。
  async function pickSensitiveWords({ persist = false } = {}) {
    try {
      const picked = await call(api.pickSensitiveWords);
      if (!picked || picked.canceled) return { canceled: true };
      if (!picked.ok) {
        toast(`这个词表不能用：${picked.message}`, 'error');
        return picked;
      }
      if (persist) {
        const cfg = await call(api.setConfig, { sensitiveWordsPath: picked.path });
        state.globalConfig = cfg;
        state.config = effectiveConfig();
        state.sensitiveWordsDraft = cfg.sensitiveWordsPath || '';
      } else {
        state.sensitiveWordsDraft = picked.path;
      }
      state.sensitiveWordsInfo = picked;
      state.sensitiveWordList = picked;
      sensitiveWordListSeq += 1; // 五-M13：换了词表，在途预检的旧 wordList 不许盖回来
      renderSensitiveWordList();
      renderSensitiveSettings();
      toast(`已选择词表：${picked.name}（${picked.count} 个词）`);
      if (persist && !$('sensitive-backdrop').classList.contains('hidden')) {
        // 五-M13（SE-01）：预检在途时直接重跑会撞 busy 被静默吞掉——登记补跑，这一轮结束后按新词表跑。
        if (state.sensitiveBusy) sensitiveRerunPending = true;
        else await runSensitiveCheck();
      }
      return picked;
    } catch (err) {
      toast(`选择词表失败：${err.message}`, 'error');
      return { ok: false, message: err.message };
    }
  }

  // 事件绑定（与搬前 bindEvents() 里的敏感词块 + 范围 change 逐行一致；由渲染层在原位置调用一次）
  function setupSensitiveUi() {
    $('btn-sensitive-run').addEventListener('click', runSensitiveCheck);
    $('btn-sensitive-close').addEventListener('click', closeSensitivePanel);
    $('btn-sensitive-pick').addEventListener('click', () => pickSensitiveWords({ persist: true }));
    $('sensitive-scope').addEventListener('change', () => {
      state.sensitiveScope = sensitiveScope();
      // 换了范围就先收起旧结果，免得摘要写着「整本」、列表还是上一章的内容
      state.sensitive = null;
      $('sensitive-results').innerHTML = '';
      $('sensitive-summary').textContent =
        state.sensitiveScope === 'book'
          ? '已切到整本书：点「开始预检」按词表通读全书（只读，缺文件的章节会跳过）。'
          : '已切到当前这一章：点「开始预检」检查编辑区里的最新内容。';
    });
  }


    return {
      sensitiveWordListText,
      refreshSensitiveWordList,
      openSensitivePanel,
      closeSensitivePanel,
      sensitiveScope,
      runSensitiveCheck,
      pickSensitiveWords,
      setupSensitiveUi
    };
  }

  return { create: createSensitiveUi, REQUIRED_HOST };
});
