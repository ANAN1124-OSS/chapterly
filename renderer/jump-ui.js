/* Ctrl+G 跳章（v0.9 B-5 第二刀：从 renderer.js 的「Ctrl+G 跳章」分区整段搬出来）。
 *
 * 为什么搬这一块：它是 B-5 第一刀量测里「出入最清楚」的下一块——147 行（原 renderer.js
 * 4225–4371 行）、只碰 8 个渲染层成员（api / $ / call / state / chapterTitle /
 * CHAPTER_STATUS_LABELS / chapterStatus / switchChapter），不碰 IPC 白名单、不碰存储、
 * 不碰 Esc 优先级表的层顺序；外部只按名字取 5 个入口（事件绑定 5 处、Esc 动作表
 * closeJumpDialog、测试钩子 4 处）。**匹配规则不在这里**——它在主进程的 core/jump.js
 * （纯逻辑、单测覆盖）；切章仍走渲染层的 switchChapter，未保存拦截照常生效。
 *
 * 契约：createJumpUi(host) 由渲染层调用一次，host 提供：
 *   host = {
 *     api, $, call, state, chapterTitle, CHAPTER_STATUS_LABELS, chapterStatus, switchChapter
 *   }
 * 缺任何一个直接抛 TypeError（宁可在启动时炸，也不要到点按 Ctrl+G 时才 ReferenceError）。
 * 防抖定时器与「旧响应作废」令牌仍是 state 上的字段（jumpTimer / jumpToken），与改前是同一份
 * state 对象，语义一字未改。
 *
 * 搬过来的东西（行为一字未改，文案 / class / 按钮文字 / 提示语 / 列表上限都照旧）：
 *   - 跳章对话框：打开 / 关闭 / 键盘回车确认；
 *   - 结果列表：章号命中 / 章名关键词命中 / 超出本书章数三种汇总文案 + 每行「章名 + 状态」；
 *   - 「跳过去」：先收对话框再走 switchChapter（未保存修改由 switchChapter 弹窗拦截）。
 *
 * 红线不变：只读 state、只改对话框 DOM 与 state 的 jump* 字段，**不写盘、不改正文、不改 dirty**。
 * 浏览器里挂成全局 CWJumpUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWJumpUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HOST = ['api', '$', 'call', 'state', 'chapterTitle', 'chaptersLib', 'CHAPTER_STATUS_LABELS', 'chapterStatus', 'switchChapter'];

  function createJumpUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createJumpUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) {
        throw new TypeError('createJumpUi 的 host 缺少 ' + key);
      }
    }
    const { api, $, call, state, chapterTitle, chaptersLib, CHAPTER_STATUS_LABELS, chapterStatus, switchChapter } = host;
  // ---------- Ctrl+G 跳章 ----------
  // 匹配规则在主进程的 core/jump.js（单测覆盖）：输入纯章号按章号找，否则按章名关键词找。
  // 这里只负责对话框、结果列表和「跳过去」；切章仍走 switchChapter，未保存拦截照常生效。
  const JUMP_RESULT_LIMIT = 8;

  function jumpChapterPayload() {
    const meta = state.meta || {};
    const volumes = Array.isArray(meta.volumes) ? meta.volumes : [];
    // 1.5.0 P0-1（审计 E1 / A2）：章→卷统一用 core/chapters.js 的 chapterVolumeKey，
    // 指向已删除卷的章与真正未分卷的章落在同一组（不再各自 find / some 一份）。
    const volumeNameOf = (chapter) => {
      const key = chaptersLib.chapterVolumeKey(meta, chapter);
      if (!key) return volumes.length ? '未分卷' : '';
      const volume = volumes.find((item) => item && item.id === key);
      return volume ? String(volume.name || '').trim() || '未命名卷' : '未分卷';
    };
    return (state.chapters || []).map((chapter, index) => ({
      id: chapter.id,
      name: chapter.name == null ? '' : String(chapter.name),
      // 跳章的纯数字匹配要按「显示用的章号」算：按卷编号时同一章号每卷都可能出现
      number: chaptersLib.chapterNumber(meta, index),
      volumeName: volumeNameOf(chapter)
    }));
  }

  function renderJumpMatches(result) {
    const matches = (result && Array.isArray(result.matches)) ? result.matches : [];
    const summary = $('jump-summary');
    const list = $('jump-results');
    const query = String(state.jumpQuery || '').trim();
    const total = state.chapters.length;
    list.innerHTML = '';
    let text;
    let warn = false;
    const byVolume = Boolean(result && result.numbering === 'volume');
    if (!query) {
      text = byVolume
        ? `共 ${total} 章（按卷编号）。输入章号 / 章名的一部分；同号章会列出所在卷。`
        : `共 ${total} 章。输入章号（如 12、第12章）或章名的一部分；回车跳转。`;
    } else if (!matches.length) {
      warn = true;
      text = state.jumpOutOfRange
        ? byVolume
          ? `本书按卷编号，没有找到「第 ${Number(result && result.number) || '?'} 章」（每卷从第 1 章起算）。`
          : `本书共 ${total} 章，没有第 ${Number(result && result.number) || '?'} 章（可输入 1–${total}）。`
        : `没有匹配「${query}」的章节。`;
    } else if (result && result.number != null) {
      if (byVolume && matches.length > 1) {
        text = `本书按卷编号：「第 ${result.number} 章」找到 ${matches.length} 处（按卷 / 未分卷分组），回车跳第一条。`;
      } else {
        text = `按章号跳转：${byVolume && matches[0].volumeName ? `${matches[0].volumeName} · ` : ''}${chapterTitle(matches[0].index, matches[0].name)}`;
      }
    } else {
      const hitCount = Number(result && result.total) || matches.length;
      text = `找到 ${hitCount} 章匹配${hitCount > matches.length ? `（列出前 ${matches.length} 章）` : ''}；回车跳第一条，也可以点下面任意一条。`;
    }
    summary.textContent = text;
    summary.classList.toggle('warn', warn);

    for (const match of matches) {
      const chapter = state.chapters[match.index];
      if (!chapter) continue;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'jump-result';
      row.dataset.index = String(match.index);
      const label = document.createElement('span');
      label.className = 'jump-chapter';
      const titleText = chapterTitle(match.index, match.name);
      label.textContent = byVolume && match.volumeName ? `${match.volumeName} · ${titleText}` : titleText;
      const status = document.createElement('span');
      status.className = 'jump-status';
      status.textContent = CHAPTER_STATUS_LABELS[chapterStatus(chapter)] || '';
      row.appendChild(label);
      row.appendChild(status);
      row.addEventListener('click', () => jumpToIndex(match.index));
      list.appendChild(row);
    }
    $('btn-jump-confirm').disabled = !matches.length;
  }

  async function refreshJumpMatches() {
    if (!state.bookPath || !state.chapters.length) return;
    const input = $('jump-input');
    const query = input ? input.value : '';
    state.jumpQuery = query;
    const token = (state.jumpToken += 1);
    if (!String(query).trim()) {
      state.jumpMatches = [];
      state.jumpOutOfRange = false;
      renderJumpMatches({ matches: [], total: 0 });
      return;
    }
    try {
      const result = await call(api.jumpMatch, jumpChapterPayload(), query, {
        limit: JUMP_RESULT_LIMIT,
        numbering: state.meta && state.meta.chapterNumbering === 'volume' ? 'volume' : 'continuous'
      });
      if (token !== state.jumpToken) return; // 输入已经又变了，旧结果丢掉
      state.jumpMatches = (result && Array.isArray(result.matches)) ? result.matches : [];
      state.jumpOutOfRange = Boolean(result && result.outOfRange);
      renderJumpMatches(result || {});
    } catch (err) {
      if (token !== state.jumpToken) return;
      state.jumpMatches = [];
      state.jumpOutOfRange = false;
      $('jump-summary').textContent = `查找章节失败：${err.message}`;
      $('jump-summary').classList.add('warn');
      $('jump-results').innerHTML = '';
      $('btn-jump-confirm').disabled = true;
    }
  }

  function scheduleJumpMatches(delay = 80) {
    clearTimeout(state.jumpTimer);
    state.jumpTimer = setTimeout(() => {
      state.jumpTimer = null;
      refreshJumpMatches();
    }, delay);
  }

  function openJumpDialog() {
    if (!state.bookPath || !state.chapters.length) return false;
    state.jumpToken += 1;
    clearTimeout(state.jumpTimer);
    state.jumpTimer = null;
    state.jumpMatches = [];
    state.jumpQuery = '';
    state.jumpOutOfRange = false;
    $('jump-input').value = '';
    $('jump-results').innerHTML = '';
    $('jump-summary').classList.remove('warn');
    renderJumpMatches({ matches: [], total: 0 });
    $('jump-backdrop').classList.remove('hidden');
    setTimeout(() => {
      const input = $('jump-input');
      if (!input || $('jump-backdrop').classList.contains('hidden')) return;
      input.focus();
      input.select();
    }, 20);
    return true;
  }

  function closeJumpDialog() {
    clearTimeout(state.jumpTimer);
    state.jumpTimer = null;
    state.jumpToken += 1;
    state.jumpMatches = [];
    state.jumpQuery = '';
    state.jumpOutOfRange = false;
    $('jump-backdrop').classList.add('hidden');
    $('jump-input').value = '';
    $('jump-results').innerHTML = '';
    $('jump-summary').textContent = '';
  }

  async function jumpToIndex(index) {
    if (!state.bookPath || index < 0 || index >= state.chapters.length) {
      return { ok: false, message: '章节不存在' };
    }
    // 先把对话框收起来，再走正常的切章流程（有未保存修改时由 switchChapter 弹窗拦截）
    closeJumpDialog();
    const res = await switchChapter(index);
    return res;
  }

  async function confirmJumpFromDialog() {
    if (!state.jumpMatches.length) {
      $('jump-summary').classList.add('warn');
      return { ok: false, message: '没有匹配的章节' };
    }
    return jumpToIndex(state.jumpMatches[0].index);
  }
    return {
      refreshJumpMatches,
      scheduleJumpMatches,
      openJumpDialog,
      closeJumpDialog,
      confirmJumpFromDialog,
      // 下面 3 个是模块内部的纯逻辑 / 单步动作，导出只为让单测能逐条钉住分支，渲染层按名字取不到也无妨
      jumpChapterPayload,
      renderJumpMatches,
      jumpToIndex
    };
  }

  return { create: createJumpUi, REQUIRED_HOST };
});
