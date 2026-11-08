/* 状态栏「保存态」（1.3.0 T7 = 《卷册规范 v2》C-05 / I-01）。
 *
 * 为什么单独一个模块：保存态原来长在 renderer.js 的 updateStatus() 里（四态文案 + 4 色圆点），
 * 只能靠 E2E 打字看字。1.3.0 要加三件必须可单测的事——「保存成功 2s 后淡到 60%」「失败态可点重试」
 * 「成功不再弹 toast，完整摘要收进状态栏提示」——所以把四态的**渲染决定**搬出来，用假 host 逐条钉住。
 *
 * 契约：createSaveStatusUi(host) 只调用一次；host = { $, state, formatClock, saveCurrent }。
 *   - $ / state 是渲染层同一份引用（只读 state）；
 *   - formatClock(date) 是渲染层现成的 HH:MM:SS 口径（模块不自己造第二套时间格式）；
 *   - saveCurrent 是渲染层的保存函数（重试直接走它，不新增保存路径 / 不传 silent）。
 * 缺任何一个直接抛 TypeError（宁可在启动时炸，也不要到保存失败时 ReferenceError）。
 *
 * 行为（只碰 DOM 与一个定时器；不写配置 / 不碰 IPC / 不改正文）：
 *   1. render()：按 state 的四态写圆点 + 文案，并维护 #status-save 的 state-error / saved-faded
 *      两个 class；失败态显示「重试」按钮（真 <button>，键盘可到），成功态把它藏起来。
 *   2. 成功（干净 + savedAt）后 2s 给 #status-save 加 saved-faded（CSS opacity .6）；
 *      又在打字 / 正在保存 / 失败 / 又保存过一次时立刻撤销，不会闪回上一次的淡化。
 *   3. setSavedDetail(text)：保存成功的摘要在状态栏上不占位置（不再弹 toast），收进
 *      #status-text 的 title；逐字文案仍由 renderer/save-logic.js 的 savedToastText() 生成。
 *   4. bindRetry()：给「重试」按钮与失败态文案挂点击（幂等，只挂一次）；点重试 = saveCurrent()，
 *      仍然非静默——所以再次失败时照旧有错误 toast，成功后状态栏自己回到「已保存」。
 *
 * 浏览器里挂成全局 CWSaveStatusUi（index.html 排在 renderer.js 之前），Node 里可以直接 require。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.CWSaveStatusUi = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const REQUIRED_HOST = ['$', 'state', 'formatClock', 'saveCurrent'];
  // 规范 I-01：成功后 2s 淡到 60%，不消失（CSS 里是同一组数字，单测静态闸门对齐）。
  const SAVED_FADE_MS = 2000;
  const FADE_CLASS = 'saved-faded';

  // 四态模型（纯函数；时间文案由宿主格式化后传进来，保证和别处一字不差）。
  // 输入：{ saveError, saving, dirty, lastEditText, savedAtText }
  // 输出：{ dot, text, error }——dot 就是圆点 class 的后缀（ok / dirty / saving / error）。
  function saveStateModel(input) {
    const s = input || {};
    if (s.saveError) return { dot: 'error', text: `保存失败：${s.saveError}`, error: true };
    if (s.saving) return { dot: 'saving', text: '正在保存…', error: false };
    if (s.dirty) {
      return {
        dot: 'dirty',
        text: `未保存${s.lastEditText ? ` · ${s.lastEditText} 最后编辑` : ''}`,
        error: false
      };
    }
    return { dot: 'ok', text: s.savedAtText ? `已保存 ${s.savedAtText}` : '已保存', error: false };
  }

  function createSaveStatusUi(host) {
    if (!host || typeof host !== 'object') throw new TypeError('createSaveStatusUi 需要 host 对象');
    for (const key of REQUIRED_HOST) {
      if (host[key] === undefined || host[key] === null) {
        throw new TypeError('createSaveStatusUi 的 host 缺少 ' + key);
      }
    }
    const { $, state, formatClock, saveCurrent } = host;

    let fadeTimer = null;
    // 淡化只为「这一次保存」算一次：savedAt 的时间戳就是这次保存的身份证。
    let fadeFor = null;
    let fadedFor = null;
    // 保存摘要（标题栏 tooltip）：只在和当前这次保存同一次时显示。
    let savedDetail = '';
    let savedDetailFor = null;
    let retryBound = false;

    function savedAtMs() {
      const at = state.savedAt;
      const ms = at && typeof at.getTime === 'function' ? at.getTime() : 0;
      return Number.isFinite(ms) && ms > 0 ? ms : 0;
    }

    function setClass(el, name, on) {
      if (!el) return;
      if (on) el.classList.add(name);
      else el.classList.remove(name);
    }

    function clearFade() {
      if (fadeTimer) clearTimeout(fadeTimer);
      fadeTimer = null;
      fadeFor = null;
      fadedFor = null;
      setClass($('status-save'), FADE_CLASS, false);
    }

    function scheduleFade() {
      const key = savedAtMs();
      if (!key) return;
      if (fadedFor === key) {
        setClass($('status-save'), FADE_CLASS, true);
        return;
      }
      if (fadeFor === key) return; // 这一次保存已经排上队，别在每次 render 时重排
      if (fadeTimer) clearTimeout(fadeTimer);
      fadeFor = key;
      fadeTimer = setTimeout(() => {
        fadeTimer = null;
        // 定时器醒来再核对一次现场：中间可能又打了字 / 又在保存 / 保存失败 / 又保存过一次。
        if (state.saveError || state.saving || state.dirty) return;
        if (savedAtMs() !== key) return;
        fadeFor = null;
        fadedFor = key;
        setClass($('status-save'), FADE_CLASS, true);
      }, SAVED_FADE_MS);
    }

    function render() {
      const textEl = $('status-text');
      if (!textEl) return null;
      const model = saveStateModel({
        saveError: state.saveError,
        saving: state.saving,
        dirty: state.dirty,
        lastEditText: state.lastEditAt ? formatClock(new Date(state.lastEditAt)) : '',
        savedAtText: state.savedAt ? formatClock(state.savedAt) : ''
      });

      const dot = $('status-dot');
      if (dot) dot.className = 'dot ' + model.dot;
      textEl.textContent = model.text;

      const group = $('status-save');
      setClass(group, 'state-error', model.error);
      // tooltip：失败给路径，成功给这一次保存的完整摘要（原来那行 toast 的文案），平时只说明状态。
      if (model.error) textEl.title = '点击重试保存（Ctrl+S 也可以）';
      else if (state.saving) textEl.title = '正在写盘…';
      else if (state.dirty) textEl.title = '还没保存：Ctrl+S 或点「保存」写盘';
      else if (savedDetail && savedDetailFor === savedAtMs()) textEl.title = savedDetail;
      else textEl.title = '这次运行的保存状态';

      const retry = $('status-retry');
      if (retry) {
        setClass(retry, 'hidden', !model.error);
        retry.disabled = Boolean(state.saving);
      }

      if (model.dot !== 'ok') clearFade();
      else scheduleFade();
      return model;
    }

    // 保存成功后把「已保存：N 章 · 本章 X 字 · …」的完整摘要挂到状态栏 tooltip。
    // 文案仍由 renderer/save-logic.js 的 savedToastText() 生成（逐字单测在那边），这里只负责存。
    function setSavedDetail(text) {
      savedDetail = text ? String(text) : '';
      savedDetailFor = savedDetail ? savedAtMs() : null;
      const textEl = $('status-text');
      if (textEl && savedDetail && !state.saveError && !state.saving && !state.dirty) {
        textEl.title = savedDetail;
      }
      return savedDetail;
    }

    function retry() {
      if (state.saving) return Promise.resolve({ ok: false, code: 'BUSY' });
      if (!state.saveError) return Promise.resolve({ ok: false, code: 'NOT_FAILED' });
      return Promise.resolve(saveCurrent());
    }

    // 失败态点「重试」或点朱红的失败文案都重新保存一次；幂等，只挂一次。
    function bindRetry() {
      if (retryBound) return false;
      retryBound = true;
      const onClick = (event) => {
        if (!state.saveError || state.saving) return;
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        void retry();
      };
      const retryEl = $('status-retry');
      if (retryEl && typeof retryEl.addEventListener === 'function') retryEl.addEventListener('click', onClick);
      const textEl = $('status-text');
      if (textEl && typeof textEl.addEventListener === 'function') textEl.addEventListener('click', onClick);
      return true;
    }

    return { render, setSavedDetail, retry, bindRetry };
  }

  return { create: createSaveStatusUi, saveStateModel, REQUIRED_HOST };
});
