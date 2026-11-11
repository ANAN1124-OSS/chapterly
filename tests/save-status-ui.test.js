// 1.3.0 T7（= 《卷册规范 v2》C-05 / I-01）：状态栏保存态。
//
// 改动前状态栏四态长在 renderer.js 的 updateStatus() 里，只有 E2E 打字看字；这一轮加了
// 「成功 2s 淡到 60% 不消失 / 失败态可点重试 / 成功不再弹 toast（摘要收进状态栏提示）」，
// 所以把四态渲染搬进 renderer/save-status-ui.js，用假 host + 假定时器逐条钉住，
// 再用静态闸门保证 index.html 的三段结构、CSS 的两个数字、渲染层的接线不被后人改回去。
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const saveStatusUi = require('../renderer/save-status-ui');
const { loadSourceGate, restoreGlobalsAfter } = require('./ui-test-preambles');

restoreGlobalsAfter(test, ['document', 'window']);

const { rendererSrc, rendererCode, indexSrc, moduleSrc, moduleCode } = loadSourceGate('save-status-ui.js');

function formatClock(date) {
  if (!date) return '';
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function makeEl(id) {
  const classes = new Set();
  const listeners = {};
  return {
    id,
    textContent: '',
    title: '',
    disabled: false,
    _classes: classes,
    _listeners: listeners,
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains: (name) => classes.has(name)
    },
    addEventListener(type, fn) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(fn);
    },
    fire(type, event) {
      for (const fn of listeners[type] || []) fn(event || {});
    }
  };
}

function makeHost(options = {}) {
  const els = new Map();
  const calls = { save: 0 };
  const state = {
    saveError: options.saveError === undefined ? null : options.saveError,
    saving: Boolean(options.saving),
    dirty: Boolean(options.dirty),
    lastEditAt: options.lastEditAt === undefined ? null : options.lastEditAt,
    savedAt: options.savedAt === undefined ? null : options.savedAt
  };
  const host = {
    $: (id) => {
      if (options.missing && options.missing.includes(id)) return null;
      if (!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
    state,
    formatClock,
    saveCurrent: async () => {
      calls.save += 1;
      return { ok: true };
    }
  };
  return { host, state, els, calls };
}

test('host 契约：4 个成员缺任何一个都抛 TypeError，空 host / null 也抛', () => {
  assert.deepEqual([...saveStatusUi.REQUIRED_HOST].sort(), ['$', 'formatClock', 'saveCurrent', 'state']);
  const { host } = makeHost();
  assert.throws(() => saveStatusUi.create(null), /createSaveStatusUi 需要 host 对象/);
  assert.throws(() => saveStatusUi.create('x'), /createSaveStatusUi 需要 host 对象/);
  for (const key of saveStatusUi.REQUIRED_HOST) {
    const broken = { ...host };
    delete broken[key];
    assert.throws(() => saveStatusUi.create(broken), /缺少/, key);
    const nulled = { ...host, [key]: null };
    assert.throws(() => saveStatusUi.create(nulled), /缺少/, key + '（null 也算缺）');
  }
  assert.doesNotThrow(() => saveStatusUi.create(host));
});

test('saveStateModel：四态文案与圆点逐字（和 1.2.0 的 updateStatus 完全一致）', () => {
  assert.deepEqual(saveStatusUi.saveStateModel({}), { dot: 'ok', text: '已保存', error: false });
  assert.deepEqual(saveStatusUi.saveStateModel({ savedAtText: '09:05:07' }), {
    dot: 'ok',
    text: '已保存 09:05:07',
    error: false
  });
  assert.deepEqual(saveStatusUi.saveStateModel({ dirty: true }), {
    dot: 'dirty',
    text: '未保存',
    error: false
  });
  assert.deepEqual(saveStatusUi.saveStateModel({ dirty: true, lastEditText: '09:05:07' }), {
    dot: 'dirty',
    text: '未保存 · 09:05:07 最后编辑',
    error: false
  });
  assert.deepEqual(saveStatusUi.saveStateModel({ saving: true, dirty: true }), {
    dot: 'saving',
    text: '正在保存…',
    error: false
  });
  assert.deepEqual(saveStatusUi.saveStateModel({ saving: true, dirty: true, saveError: 'x' }), {
    dot: 'error',
    text: '保存失败：x',
    error: true
  }, '四态优先级与 1.2.0 完全一致：失败 > 正在保存 > 未保存 > 已保存');
  assert.deepEqual(saveStatusUi.saveStateModel({ saveError: '磁盘已满' }), {
    dot: 'error',
    text: '保存失败：磁盘已满',
    error: true
  });
  assert.deepEqual(saveStatusUi.saveStateModel(null), { dot: 'ok', text: '已保存', error: false });
});

test('render：四态写圆点 / 文案 / 失败态重试按钮与 title，平时不显示重试', () => {
  const ok = makeHost({ savedAt: new Date(2026, 10, 8, 9, 5, 7) });
  const ui = saveStatusUi.create(ok.host);
  ui.render();
  assert.equal(ok.els.get('status-dot').className, 'dot ok');
  assert.equal(ok.els.get('status-text').textContent, '已保存 09:05:07');
  assert.equal(ok.els.get('status-retry').classList.contains('hidden'), true);
  assert.equal(ok.els.get('status-save').classList.contains('state-error'), false);

  const dirty = makeHost({ dirty: true, lastEditAt: new Date(2026, 10, 8, 9, 8, 0).getTime() });
  saveStatusUi.create(dirty.host).render();
  assert.equal(dirty.els.get('status-dot').className, 'dot dirty');
  assert.equal(dirty.els.get('status-text').textContent, '未保存 · 09:08:00 最后编辑');
  assert.equal(dirty.els.get('status-text').title, '还没保存：Ctrl+S 或点「保存」写盘');

  const saving = makeHost({ saving: true });
  saveStatusUi.create(saving.host).render();
  assert.equal(saving.els.get('status-dot').className, 'dot saving');
  assert.equal(saving.els.get('status-text').textContent, '正在保存…');
  assert.equal(saving.els.get('status-text').title, '正在写盘…');

  const failed = makeHost({ saveError: '磁盘已满' });
  saveStatusUi.create(failed.host).render();
  assert.equal(failed.els.get('status-dot').className, 'dot error');
  assert.equal(failed.els.get('status-text').textContent, '保存失败：磁盘已满');
  assert.equal(failed.els.get('status-text').title, '点击重试保存（Ctrl+S 也可以）');
  assert.equal(failed.els.get('status-save').classList.contains('state-error'), true);
  assert.equal(failed.els.get('status-retry').classList.contains('hidden'), false);
  assert.equal(failed.els.get('status-retry').disabled, false);

  const failedSaving = makeHost({ saveError: '磁盘已满', saving: true });
  saveStatusUi.create(failedSaving.host).render();
  assert.equal(failedSaving.els.get('status-retry').disabled, true, '重试进行中不许再点一次');
});

test('render：成功 2s 后加 saved-faded（= CSS opacity .6），不到 2s 不加', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { host, els } = makeHost({ savedAt: new Date(2026, 10, 8, 9, 5, 7) });
    const ui = saveStatusUi.create(host);
    ui.render();
    assert.equal(els.get('status-save').classList.contains('saved-faded'), false);
    t.mock.timers.tick(1999);
    assert.equal(els.get('status-save').classList.contains('saved-faded'), false, '1.999s 还不淡');
    t.mock.timers.tick(1);
    assert.equal(els.get('status-save').classList.contains('saved-faded'), true, '满 2s 淡到 60%');
    assert.equal(els.get('status-text').textContent, '已保存 09:05:07', '淡了不消失，文案还在');
  } finally {
    t.mock.timers.reset();
  }
});

test('render：2s 内又打字 / 又在保存 / 保存失败 / 又保存过一次 → 撤销或重排淡化', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { host, els, state } = makeHost({ savedAt: new Date(1000000) });
    const ui = saveStatusUi.create(host);
    ui.render();
    state.dirty = true;
    state.lastEditAt = 1000100;
    ui.render();
    t.mock.timers.tick(2000);
    assert.equal(els.get('status-save').classList.contains('saved-faded'), false, '中间打过字，不许淡');

    const second = makeHost({ savedAt: new Date(2000000) });
    const ui2 = saveStatusUi.create(second.host);
    ui2.render();
    second.state.savedAt = new Date(2000001); // 又保存过一次：新时间戳 = 重新排 2s
    ui2.render();
    t.mock.timers.tick(2000);
    assert.equal(second.els.get('status-save').classList.contains('saved-faded'), true);
    second.state.saveError = '磁盘已满';
    ui2.render();
    assert.equal(second.els.get('status-save').classList.contains('saved-faded'), false, '失败态不淡化');
  } finally {
    t.mock.timers.reset();
  }
});

test('setSavedDetail：成功摘要收进状态栏 title（原来那行 toast 的逐字文案），不另造文案', () => {
  const { host, els, state } = makeHost({ savedAt: new Date(2026, 10, 8, 9, 5, 7) });
  const ui = saveStatusUi.create(host);
  ui.render();
  assert.equal(els.get('status-text').title, '这次运行的保存状态');
  ui.setSavedDetail('已保存：3 章 · 本章 18 字 · 今日快照已留');
  assert.equal(els.get('status-text').title, '已保存：3 章 · 本章 18 字 · 今日快照已留');
  ui.render();
  assert.equal(
    els.get('status-text').title,
    '已保存：3 章 · 本章 18 字 · 今日快照已留',
    '同一次保存的后续 render 不许把摘要冲掉'
  );

  // 下一次保存（新 savedAt）摘要作废；未保存 / 失败时也不显示上一次的摘要
  state.savedAt = new Date(2026, 10, 8, 9, 9, 9);
  ui.render();
  assert.equal(els.get('status-text').title, '这次运行的保存状态');
  state.dirty = true;
  ui.render();
  assert.equal(els.get('status-text').title, '还没保存：Ctrl+S 或点「保存」写盘');
  ui.setSavedDetail('不该出现');
  assert.equal(els.get('status-text').title, '还没保存：Ctrl+S 或点「保存」写盘', '未保存时摘要不许顶掉提示');
});

test('retry：只在失败态真调 saveCurrent；没有失败 / 正在保存都不重复触发', async () => {
  const ok = makeHost({});
  assert.deepEqual(await saveStatusUi.create(ok.host).retry(), { ok: false, code: 'NOT_FAILED' });
  assert.equal(ok.calls.save, 0);

  const busy = makeHost({ saveError: 'x', saving: true });
  assert.deepEqual(await saveStatusUi.create(busy.host).retry(), { ok: false, code: 'BUSY' });
  assert.equal(busy.calls.save, 0);

  const failed = makeHost({ saveError: '磁盘已满' });
  assert.deepEqual(await saveStatusUi.create(failed.host).retry(), { ok: true });
  assert.equal(failed.calls.save, 1, '点重试 = 再走一次 saveCurrent()（同一条保存路径）');
});

test('bindRetry：幂等只挂一次；失败态点按钮 / 点朱红文案都重试，没失败时点击无效', () => {
  const { host, els, calls } = makeHost({ saveError: '磁盘已满' });
  const ui = saveStatusUi.create(host);
  assert.equal(ui.bindRetry(), true);
  assert.equal(ui.bindRetry(), false, '第二次装配不再重复挂');

  els.get('status-retry').fire('click');
  assert.equal(calls.save, 1);
  els.get('status-text').fire('click');
  assert.equal(calls.save, 2);

  const clean = makeHost({});
  const cleanUi = saveStatusUi.create(clean.host);
  cleanUi.bindRetry();
  clean.els.get('status-retry').fire('click');
  clean.els.get('status-text').fire('click');
  assert.equal(clean.calls.save, 0, '正常态点状态栏不该触发保存');
});

test('静态闸门：index.html 的 34px 状态栏分成「保存态 / 第 N 章 · 本章字数 / 今日字数·计时」三段', () => {
  const statusbar = indexSrc.slice(indexSrc.indexOf('<footer class="statusbar">'), indexSrc.indexOf('</footer>', indexSrc.indexOf('<footer class="statusbar">')));
  assert.ok(statusbar, 'index.html 里要有状态栏');
  // 左段：圆点 + 文案 + 重试按钮都在 #status-save 里
  assert.match(statusbar, /<span id="status-save" class="status-save">/);
  assert.match(statusbar, /id="status-save"[\s\S]*?id="status-dot"[\s\S]*?id="status-text"[\s\S]*?id="status-retry"/);
  assert.match(statusbar, /<button id="status-retry" class="status-retry hidden" type="button"/);
  // 中段：第 N 章 + 本章字数（#char-count 移进中段，不再挂在右段）
  assert.match(statusbar, /<span id="status-chapter" class="status-chapter hidden">/);
  assert.match(statusbar, /id="status-chapter"[\s\S]*?id="status-chapter-label"[\s\S]*?id="char-count"/);
  // 三段之间两个弹性空档；右段仍是计时 / 今日字数 / 小标签 / 快捷键
  assert.equal((statusbar.match(/class="spacer"/g) || []).length, 2);
  assert.ok(
    statusbar.indexOf('id="status-chapter"') < statusbar.indexOf('id="btn-write-timer"'),
    '中段在右段之前'
  );
  for (const id of ['btn-write-timer', 'status-stats', 'status-long-para', 'status-find', 'status-hints']) {
    assert.ok(statusbar.includes(`id="${id}"`) || statusbar.includes(`class="${id}"`), `右段缺 ${id}`);
  }
  // 脚本顺序：save-status-ui.js 在 renderer.js 之前，且只加载一次
  const order = [...indexSrc.matchAll(/<script src="([^"]+)"><\/script>/g)].map((hit) => hit[1]);
  assert.ok(order.indexOf('save-status-ui.js') > -1);
  assert.ok(order.indexOf('save-status-ui.js') < order.indexOf('renderer.js'));
  assert.equal(order.filter((name) => name === 'save-status-ui.js').length, 1);
});

test('静态闸门：CSS 的两个数字（2000ms 由 JS、opacity .6 由 CSS）+ 窄窗隐藏中段', () => {
  const CSS = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  assert.match(CSS, /\.status-save\.saved-faded \{ opacity: \.6; \}/);
  assert.match(CSS, /\.status-save\.saved-faded:hover,\s*\n\.status-save\.saved-faded:focus-within \{ opacity: 1; \}/);
  assert.match(CSS, /#status-save\.state-error #status-text \{ color: var\(--danger\); \}/);
  assert.match(CSS, /\.status-retry \{[\s\S]*?min-height: 24px;[\s\S]*?color: var\(--danger\);/, '重试按钮 ≥24px 且朱红');
  const narrow = CSS.slice(CSS.indexOf('@media (max-width: 1040px)'), CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(narrow, /\.status-chapter \{ display: none; \}/, '960（最小窗口宽）时中段让位');
  // 模块里 2000ms 与 CSS 的 60% 是同一组数字（规范 I-01）
  assert.match(moduleCode, /const SAVED_FADE_MS = 2000;/);
});

test('静态闸门：渲染层只剩接线——保存成功不弹 toast、四态文案不许长回 renderer.js', () => {
  // 保存态的三个 DOM 只许模块写；renderer.js 里出现就是第二份实现
  for (const ref of ["$('status-text')", "$('status-dot')", "$('status-retry')", "dot.className = 'dot'"]) {
    assert.equal(rendererSrc.includes(ref), false, `renderer.js 不许再自己写 ${ref}`);
  }
  // 1.6.0 A5/P-09：updateStatus 多了一个 options 参数（输入路径的 typing 传下去让字数统计防抖）
  assert.match(rendererCode, /function updateStatus\(options\) \{[\s\S]{0,400}?saveStatusUi\.render\(\);/);
  assert.match(rendererCode, /saveStatusUi\.bindRetry\(\);/);
  assert.equal((rendererCode.match(/saveStatusUi\.bindRetry\(\)/g) || []).length, 1);
  assert.match(
    rendererCode,
    /if \(!silent\) \{\s*\n\s*saveStatusUi\.setSavedDetail\(\s*\n\s*saveLogic\.savedToastText\(\{/,
    '成功摘要改挂状态栏，不再 toast'
  );
  // 保存成功路径里不许再出现 toast( ——错误路径的 toast 保留
  const saveBody = rendererCode.slice(rendererCode.indexOf('async function saveCurrent('), rendererCode.indexOf('\n  }', rendererCode.indexOf('async function saveCurrent(')));
  assert.equal(saveBody.includes('toast('), true, '失败路径仍要 toast');
  assert.equal(/toast\(\s*\n?\s*saveLogic\.savedToastText/.test(saveBody), false, '成功摘要不许再走 toast');
  // 装配一次 + host 成员点名
  assert.equal((rendererCode.match(/saveStatusUiModule\.create\(/g) || []).length, 1);
  assert.match(rendererCode, /saveStatusUiModule\.create\(\{ \$, state, formatClock, saveCurrent \}\);/);
  assert.match(rendererCode, /const saveStatusUiModule = window\.CWSaveStatusUi;/);
});

test('静态闸门：模块只读 state / 只碰 DOM 与一个 2s 定时器，不摸文件系统与 IPC', () => {
  for (const forbidden of ['require(', 'ipcRenderer', 'node:fs', 'child_process', 'localStorage', 'fetch(', 'document.']) {
    assert.equal(moduleCode.includes(forbidden), false, forbidden);
  }
  assert.equal(/state\.[A-Za-z_$][\w$]*\s*=/.test(moduleCode), false, '模块不许写 state');
  assert.equal((moduleCode.match(/setTimeout\(/g) || []).length, 1, '只有一个 2s 淡化定时器');
  assert.equal((moduleCode.match(/addEventListener\('click'/g) || []).length, 2, '重试按钮 + 失败文案两个点击入口');
  assert.equal(moduleCode.includes('removeEventListener'), false);
});

test('UMD 浏览器分支：没有 module 的沙箱里挂到 window.CWSaveStatusUi，且不乱造别的全局', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(moduleSrc, context, { filename: 'renderer/save-status-ui.js' });
  assert.equal(typeof win.CWSaveStatusUi, 'object');
  assert.deepEqual(Object.keys(win.CWSaveStatusUi).sort(), ['REQUIRED_HOST', 'create', 'saveStateModel']);
  assert.deepEqual(Array.from(win.CWSaveStatusUi.REQUIRED_HOST), Array.from(saveStatusUi.REQUIRED_HOST));
  assert.equal(typeof win.CWSaveStatusUi.create, 'function');
  assert.equal(win.CWStatusbarUi, undefined, '单独加载 save-status-ui 不该顺手造出别的全局');
  assert.equal(win.CWChapters, undefined);
});
