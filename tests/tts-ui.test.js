const test = require('node:test');
const assert = require('node:assert/strict');
const ttsUi = require('../renderer/tts-ui');
const { loadSourceGate, restoreGlobalsAfter } = require('./ui-test-preambles');

// v0.9 B-6：朗读的播放状态机 / 朗读条从 renderer.js 整段搬到 renderer/tts-ui.js。
// 搬之前这一域只有 E2E 第 49 组（真实 Electron + 假语音引擎）覆盖，状态机在 Node 里一步都测不到；
// 搬出来以后用「假 host + 假引擎」把状态机、光标起点、步进边界、文案逐字钉住。
// 两组静态闸门保证「渲染层不许再长出第二份」「index.html 的加载顺序不许反」。

// 语音下拉要 document.createElement('option')：Node 里给一个最小替身（模块自己不在顶层碰 DOM）。
// 朗读条的「toast 抬起量」写在 body 的 --tts-toast-lift 上（2026-11-04 拍板 #6），所以 body 也要
// 一个能 setProperty / removeProperty 的 style 替身；断言直接读 bodyStyle 这个 Map。
// 真身由共享前导存下，test.after 放回。
restoreGlobalsAfter(test, ['document']);
const bodyStyle = new Map();
globalThis.document = {
  // M4（一轮·低）：渲染语音下拉时用 activeElement 判断「重建前焦点是否就在下拉里」
  activeElement: null,
  createElement: (tag) => ({ tag, value: '', textContent: '' }),
  body: {
    style: {
      setProperty: (name, value) => bodyStyle.set(name, value),
      removeProperty: (name) => bodyStyle.delete(name),
      getPropertyValue: (name) => (bodyStyle.has(name) ? bodyStyle.get(name) : '')
    }
  }
};

const { rendererSrc, indexSrc, moduleSrc } = loadSourceGate('tts-ui.js');

function makeEl(id) {
  const classes = new Set();
  return {
    id,
    textContent: '',
    title: '',
    value: '',
    checked: false,
    disabled: false,
    innerHTML: '',
    options: [],
    classList: {
      toggle(name, on) {
        if (on === undefined ? !classes.has(name) : on) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name)
    },
    appendChild(child) {
      this.options.push(child);
      return child;
    },
    // M4：渲染下拉的焦点恢复用（真浏览器里 focus 会把 activeElement 挪过来）
    focus() {
      this.focusCalls = (this.focusCalls || 0) + 1;
      globalThis.document.activeElement = this;
    },
    // 朗读条高度由 syncToastLift 量（拍板 #6）：假元素给一个稳定高度 132（≈ 假语音的两行状态文案），
    // 需要验「条子变高要重算」的测试自己覆盖这一项。
    getBoundingClientRect: () => ({ width: 900, height: 132, top: 0, right: 900, bottom: 132, left: 0 })
  };
}

// 假 host：只实现模块真正用到的 7 样东西（api / $ / call / state / toast / editorEl / scrollCaretIntoView）。
function makeHost(options = {}) {
  const els = new Map();
  const toasts = [];
  const calls = [];
  const scrolls = [];
  const state = {
    bookPath: options.bookPath === undefined ? 'C:/tmp/books/测试书' : options.bookPath,
    chapters: options.chapters || [{ id: 'c1' }],
    tts: {
      open: false,
      status: 'idle',
      chunks: [],
      index: 0,
      rate: 1,
      voiceURI: '',
      follow: Boolean(options.follow),
      error: '',
      loading: false,
      requestId: 0
    }
  };
  const editorEl = {
    value: options.text === undefined ? '第一段。第二段。第三段。' : options.text,
    selectionStart: options.caret === undefined ? 0 : options.caret,
    selectionEnd: options.caret === undefined ? 0 : options.caret,
    ranges: [],
    setSelectionRange(start, end) {
      this.ranges.push([start, end]);
    }
  };
  const host = {
    api: { ttsChunks: 'tts:chunks' },
    $: (id) => {
      if (options.missingElements && options.missingElements.includes(id)) return null;
      if (!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
    call: async (channel, text, payload) => {
      calls.push({ channel, text, payload });
      return options.callResult === undefined
        ? {
            chunks: [
              { start: 0, end: 4, text: '第一段。', paragraph: 0, line: 0 },
              { start: 4, end: 8, text: '第二段。', paragraph: 1, line: 1 },
              { start: 8, end: 12, text: '第三段。', paragraph: 2, line: 2 }
            ],
            startIndex: 0
          }
        : options.callResult;
    },
    state,
    toast: (message, kind) => toasts.push({ message, kind }),
    editorEl,
    scrollCaretIntoView: (pos) => scrolls.push(pos)
  };
  return { host, state, editorEl, els, toasts, calls, scrolls, get: (id) => host.$(id) };
}

// 假语音引擎：记录念了什么、把 handlers 留下来给测试手动「念完」/「出错」。
function makeEngine() {
  const log = { spoken: [], cancelled: 0, paused: 0, resumed: 0, handlers: null };
  return {
    log,
    available: () => true,
    voices: () => [
      { name: '测试语音 A', lang: 'zh-CN', voiceURI: 'fake-voice-a' },
      { name: '测试语音 B', lang: 'zh-CN', voiceURI: 'fake-voice-b' }
    ],
    speak(request, handlers) {
      log.spoken.push({ ...request });
      log.handlers = handlers;
      if (handlers.start) handlers.start();
      return true;
    },
    pause() {
      log.paused += 1;
    },
    resume() {
      log.resumed += 1;
    },
    cancel() {
      log.cancelled += 1;
    }
  };
}

async function openWith(host, engine, opts = {}) {
  const tts = ttsUi.create(host);
  tts.setSpeechEngine(engine);
  const result = await tts.openTtsBar(opts);
  return { tts, result };
}

test('host 契约：缺一个必需项就抛 TypeError（宁可启动时炸，不要朗读时才 ReferenceError）', () => {
  assert.throws(() => ttsUi.create(), /host/);
  const full = makeHost().host;
  for (const key of ['api', '$', 'call', 'state', 'toast', 'editorEl', 'scrollCaretIntoView']) {
    const partial = { ...full };
    delete partial[key];
    assert.throws(() => ttsUi.create(partial), new RegExp(key), '少 ' + key + ' 没抛错');
  }
  assert.equal(typeof ttsUi.create(full).openTtsBar, 'function');
});

test('语速夹紧：0.5–2 之间；非数字回到 1，0 / 空串 / null 夹到下限 0.5（不是静音，也不是 1）', () => {
  const { host, state } = makeHost();
  const tts = ttsUi.create(host);
  assert.equal(tts.setTtsRate(0.2), 0.5);
  assert.equal(tts.setTtsRate(5), 2);
  assert.equal(tts.setTtsRate('1.5'), 1.5);
  assert.equal(tts.setTtsRate('abc'), 1);
  // Number('') / Number(null) 都是 0 —— 夹到下限 0.5（搬之前就是这个行为，本轮不改语义）
  assert.equal(tts.setTtsRate(''), 0.5);
  assert.equal(tts.setTtsRate(null), 0.5);
  assert.equal(state.tts.rate, 0.5);
});

test('状态文案逐字：error / loading 优先，其余按播放状态给百分比与段号', () => {
  const { host, state } = makeHost();
  const tts = ttsUi.create(host);
  const texts = [];
  const push = () => texts.push(tts.ttsSummaryText().text);

  state.tts.chunks = [];
  state.tts.error = '';
  state.tts.loading = false;
  push(); // 没有正文
  state.tts.loading = true;
  push();
  state.tts.loading = false;
  state.tts.chunks = [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }];
  state.tts.index = 0;
  state.tts.status = 'playing';
  push();
  state.tts.status = 'paused';
  push();
  state.tts.status = 'done';
  push();
  state.tts.status = 'idle';
  push();
  state.tts.error = '系统语音出错（not-allowed）';
  push();
  assert.deepEqual(texts, [
    '本章没有可朗读的正文',
    '正在准备正文…',
    '正在朗读 第 1/4 段 · 25%',
    '已暂停 · 第 1/4 段',
    '已读完（共 4 段）',
    '已停止 · 第 1/4 段',
    '系统语音出错（not-allowed）'
  ]);
});

test('打开朗读条：没打开书 / 没有系统语音时只 toast 一句，不动编辑区', async () => {
  const noBook = makeHost({ bookPath: null });
  const tts1 = ttsUi.create(noBook.host);
  const res1 = await tts1.openTtsBar();
  assert.equal(res1.ok, false);
  assert.deepEqual(noBook.toasts, [{ message: '先打开一本书再朗读', kind: 'warn' }]);
  assert.equal(noBook.state.tts.open, false);

  const noChapter = makeHost({ chapters: [] });
  const res2 = await ttsUi.create(noChapter.host).openTtsBar();
  assert.equal(res2.ok, false);
  assert.equal(noChapter.toasts.length, 1);

  // 引擎说没有系统语音：只 toast，不开朗读条、不发 IPC
  const engine = makeEngine();
  engine.available = () => false;
  const { host: host2, toasts: toasts2, calls: calls2 } = makeHost();
  const tts2 = ttsUi.create(host2);
  tts2.setSpeechEngine(engine);
  const res3 = await tts2.openTtsBar();
  assert.equal(res3.ok, false);
  assert.deepEqual(toasts2, [{ message: '这个运行环境不支持语音朗读（没有系统语音）', kind: 'warn' }]);
  assert.equal(calls2.length, 0);
});

test('光标在全文末尾（刚载入章节的默认位置）→ 按「从头念」传 caret 0；光标在中间 → 传真实位置', async () => {
  const tail = makeHost({ text: '第一段。第二段。', caret: 9 });
  const a = await openWith(tail.host, makeEngine());
  assert.deepEqual(tail.calls[0].payload, { caret: 0 });
  assert.equal(a.result.ok, true);

  const middle = makeHost({ text: '第一段。第二段。', caret: 3 });
  await openWith(middle.host, makeEngine());
  assert.deepEqual(middle.calls[0].payload, { caret: 3 });

  // 有选区（未折叠）时也按光标位置算，不看结尾
  const selected = makeHost({ text: '第一段。第二段。', caret: 2 });
  selected.editorEl.selectionEnd = 7;
  await openWith(selected.host, makeEngine());
  assert.deepEqual(selected.calls[0].payload, { caret: 2 });
});

test('打开成功：状态 playing、按钮变「暂停」、念的是当前段；念完自动接下一段，最后一段念完变已读完', async () => {
  const { host, state, editorEl, get } = makeHost({ follow: true });
  const engine = makeEngine();
  const { result } = await openWith(host, engine);

  assert.equal(result.ok, true);
  assert.deepEqual({ chunks: result.chunks, index: result.index }, { chunks: 3, index: 0 });
  assert.equal(state.tts.status, 'playing');
  assert.equal(get('btn-tts-play').textContent, '⏸ 暂停');
  assert.equal(get('btn-tts-prev').disabled, true); // 第一段不能再上一段
  assert.equal(get('btn-tts-next').disabled, false);
  assert.equal(get('tts-status').textContent, '正在朗读 第 1/3 段 · 33%');
  assert.equal(get('tts-preview').textContent, '第一段。');
  assert.deepEqual(engine.log.spoken.map((item) => item.text), ['第一段。']);
  // 跟随高亮：只改选区 + 滚动，不改文字、不 focus
  assert.deepEqual(editorEl.ranges, [[0, 4]]);
  assert.equal(editorEl.value, '第一段。第二段。第三段。');

  engine.log.handlers.end();
  assert.equal(state.tts.index, 1);
  assert.deepEqual(engine.log.spoken.map((item) => item.text), ['第一段。', '第二段。']);

  engine.log.handlers.end();
  engine.log.handlers.end();
  assert.equal(state.tts.status, 'done');
  assert.equal(state.tts.index, 2);
  assert.equal(get('tts-status').textContent, '已读完（共 3 段）');
});

test('暂停 / 继续：调引擎 pause / resume，状态与按钮跟着变', async () => {
  const { host, state, get } = makeHost();
  const engine = makeEngine();
  const { tts } = await openWith(host, engine);

  assert.deepEqual(tts.toggleTtsPlay(), { ok: true, action: 'pause' });
  assert.equal(state.tts.status, 'paused');
  assert.equal(engine.log.paused, 1);
  assert.equal(get('btn-tts-play').textContent, '▶ 播放');
  assert.equal(get('tts-status').textContent, '已暂停 · 第 1/3 段');

  assert.deepEqual(tts.toggleTtsPlay(), { ok: true, action: 'resume' });
  assert.equal(state.tts.status, 'playing');
  assert.equal(engine.log.resumed, 1);
  assert.equal(get('btn-tts-play').textContent, '⏸ 暂停');
});

test('setTtsRate / setTtsVoice（#43 / E17）：播放中重念这一段；暂停中只更新设置，不许偷偷恢复播放', async () => {
  const { host, state } = makeHost();
  const engine = makeEngine();
  const { tts } = await openWith(host, engine);
  assert.deepEqual(engine.log.spoken.map((item) => item.text), ['第一段。']);

  // 播放中：语速 / 语音只对之后发声的 utterance 生效 → 正在读的这一段重念一遍
  assert.equal(tts.setTtsRate(1.5), 1.5);
  assert.equal(engine.log.spoken.length, 2);
  assert.equal(engine.log.spoken.at(-1).rate, 1.5);
  assert.equal(tts.setTtsVoice('fake-voice-b'), 'fake-voice-b');
  assert.equal(engine.log.spoken.length, 3);
  assert.equal(engine.log.spoken.at(-1).voiceURI, 'fake-voice-b');
  assert.equal(state.tts.status, 'playing');

  // 暂停中：状态保持 paused、引擎不发声、不自动 resume —— 下一次发声才用新设置
  assert.deepEqual(tts.toggleTtsPlay(), { ok: true, action: 'pause' });
  const spokenBefore = engine.log.spoken.length;
  assert.equal(tts.setTtsRate(0.8), 0.8);
  assert.equal(tts.setTtsVoice('fake-voice-a'), 'fake-voice-a');
  assert.equal(state.tts.status, 'paused', '改设置不许把暂停改成播放');
  assert.equal(engine.log.spoken.length, spokenBefore, '暂停中不许重新发声');
  assert.equal(engine.log.resumed, 0, '暂停中也不许自动继续');
  assert.equal(tts.ttsSummaryText().text, '已暂停 · 第 1/3 段');

  // 手动继续后，下一段用新设置
  assert.deepEqual(tts.toggleTtsPlay(), { ok: true, action: 'resume' });
  assert.equal(engine.log.resumed, 1);
  assert.equal(state.tts.status, 'playing');
  engine.log.handlers.end();
  assert.equal(engine.log.spoken.at(-1).rate, 0.8);
  assert.equal(engine.log.spoken.at(-1).voiceURI, 'fake-voice-a');
});

test('步进：夹在第 1–N 段之间；播放中换段会重念，停止状态只切预览不改引擎', async () => {
  const { host, state, get } = makeHost();
  const engine = makeEngine();
  const { tts } = await openWith(host, engine);

  assert.deepEqual(tts.ttsStep(-1), { ok: true, index: 0 }); // 已在第一段，夹住
  assert.deepEqual(tts.ttsStep(1), { ok: true, index: 1 });
  assert.equal(engine.log.spoken.at(-1).text, '第二段。');
  assert.deepEqual(tts.ttsStep(99), { ok: true, index: 2 }); // 已到最后一段，夹住
  assert.equal(get('btn-tts-next').disabled, true);

  tts.stopTts();
  assert.equal(state.tts.status, 'idle');
  const spokenBefore = engine.log.spoken.length;
  assert.deepEqual(tts.ttsStep(-1), { ok: true, index: 1 });
  assert.equal(engine.log.spoken.length, spokenBefore); // 停止状态只切预览
  assert.equal(get('tts-preview').textContent, '第二段。');
});

test('停止 / 收起 / 切章：清错误与状态，切章还会 toast 一句', async () => {
  const { host, state, toasts } = makeHost();
  const engine = makeEngine();
  const { tts } = await openWith(host, engine);

  tts.stopTts({ error: '系统语音出错（未知原因）' });
  assert.equal(state.tts.status, 'error');
  assert.equal(state.tts.error, '系统语音出错（未知原因）');
  assert.equal(tts.ttsSummaryText().error, true);

  tts.closeTtsBar();
  assert.equal(state.tts.open, false);
  assert.equal(state.tts.status, 'idle');

  state.tts.open = true;
  state.tts.chunks = [{ text: 'a', start: 0, end: 1 }];
  tts.stopTtsForChapterChange();
  assert.equal(state.tts.open, false);
  assert.deepEqual(toasts.at(-1), { message: '已切换章节，朗读已停止', kind: undefined });
  // 已经收起来、也没有段落时再切章不再重复提示（判空条件 = 两条都成立）
  const toastCount = toasts.length;
  state.tts.chunks = [];
  tts.stopTtsForChapterChange();
  assert.equal(toasts.length, toastCount);
});

// ---------- 五-M20（MP-01）：收起朗读条要清空 chunks ----------
// 旧实现 stopTts 只改 status / open，chunks 原样留着：收起朗读条（或切章自动停）之后，
// save-chain-ui 在每次载章成功都调 stopTtsForChapterChange，判据 `!open && !chunks.length`
// 因残留分段不成立 → 此后每一次切章都弹「已切换章节，朗读已停止」——朗读几个小时前就停了；
// 残留还跨书存活（commitOpenBook 不碰 tts），新书第一章载入同样假提示。
// 修法：closeTtsBar（条子真的收起、看不见了）时清 chunks / index；stopTts（条子还开着）保留分段，
// 作者停止后还能按「播放」接着念同一章。
test('M20（MP-01）：收起朗读条清空 chunks / index——此后切章不再弹假提示、残留不跨书', async () => {
  const { host, state, toasts } = makeHost();
  const engine = makeEngine();
  const { tts } = await openWith(host, engine);
  assert.equal(state.tts.chunks.length, 3);

  tts.closeTtsBar();
  assert.equal(state.tts.open, false);
  assert.deepEqual(state.tts.chunks, [], '收起朗读条后不再保留整章分段');
  assert.equal(state.tts.index, 0, '分段下标归零');

  // 此后每次载章成功都会调 stopTtsForChapterChange（save-chain-ui.js:185）：没有残留就静默
  const count = toasts.length;
  tts.stopTtsForChapterChange();
  tts.stopTtsForChapterChange();
  assert.equal(toasts.length, count, '不许再弹「已切换章节，朗读已停止」假提示');

  // 残留不跨书：同一窗口换书后第一章载入，同样静默
  state.bookPath = 'C:/tmp/books/另一本';
  tts.stopTtsForChapterChange();
  assert.equal(toasts.length, count);

  // 对照：停止但条子还开着 → 保留分段，作者还能按「播放」继续念同一章
  const keep = makeHost();
  const kept = await openWith(keep.host, makeEngine());
  kept.tts.stopTts();
  assert.equal(keep.state.tts.open, true, '条子仍开着');
  assert.equal(keep.state.tts.chunks.length, 3, '条子还开着时停止：保留分段供继续播放');
  assert.equal(keep.get('btn-tts-play').disabled, false, '停止后播放按钮仍可用');
  assert.deepEqual(kept.tts.toggleTtsPlay(), { ok: true, action: 'play' }, '还能接着念');
});

// 2026-11-04 拍板 #6：toast 抬起量从写死 184px 改成 var(--tts-toast-lift, 184px)，
// 变量由渲染层按朗读条**实际高度 + 52**（44 条底距 + 8 间隙）算出。这两项钉住「怎么算」和「收起后清掉」。
test('toast 抬起（拍板 #6）：条子开着时写 高度 + 52 到 --tts-toast-lift，条子变高会重算', async () => {
  bodyStyle.clear();
  const { host, get } = makeHost();
  const engine = makeEngine();
  const { tts } = await openWith(host, engine);

  // 打开后渲染一次：132（假条高）+ 44（条底距）+ 8（间隙）
  assert.equal(bodyStyle.get('--tts-toast-lift'), '184px');

  // 条子变高（多一个控件 / 状态文案折行）→ 下一次 render 跟着重算，不是照抄 184
  get('tts-bar').getBoundingClientRect = () => ({ width: 900, height: 168, top: 0, right: 900, bottom: 168, left: 0 });
  tts.renderTtsBar();
  assert.equal(bodyStyle.get('--tts-toast-lift'), '220px');

  // 无窗口 / 量不到布局时（没有 resize 事件回调之外的分支）也不改变量、不报错
  tts.renderTtsBar();
  assert.equal(bodyStyle.get('--tts-toast-lift'), '220px');
  bodyStyle.clear();
});

test('toast 抬起（拍板 #6）：收起朗读条后移除变量（回到 CSS 的 184 回退 / 无条时 46px）；没有 body 也不炸', async () => {
  bodyStyle.clear();
  const { host } = makeHost();
  const engine = makeEngine();
  const { tts } = await openWith(host, engine);
  assert.equal(bodyStyle.has('--tts-toast-lift'), true);

  tts.closeTtsBar();
  assert.equal(bodyStyle.has('--tts-toast-lift'), false);

  // 假 DOM 里没有 document.body（Node 单测的常态）：直接返回、不抛错、不写变量
  const savedBody = globalThis.document.body;
  delete globalThis.document.body;
  try {
    bodyStyle.clear();
    tts.stopTts({ keepOpen: true });
    tts.renderTtsBar();
    assert.equal(bodyStyle.size, 0);
  } finally {
    globalThis.document.body = savedBody;
  }
  bodyStyle.clear();
});

test('换引擎：setSpeechEngine 换进来 / 传空换回真实引擎；语音下拉按引擎给的列表重建', async () => {
  const { host, get } = makeHost();
  const tts = ttsUi.create(host);
  const engine = makeEngine();
  assert.equal(tts.setSpeechEngine(engine), engine);
  assert.equal(tts.speechEngine(), engine);
  const real = tts.setSpeechEngine(null);
  assert.notEqual(real, engine);
  assert.equal(tts.speechEngine(), real);
  tts.setSpeechEngine(engine);

  const select = get('tts-voice');
  tts.renderTtsVoices();
  assert.equal(select.options.length, 3); // 系统默认 + 两个假语音
  assert.equal(select.options[0].textContent, '系统默认');
  assert.equal(select.options[1].value, 'fake-voice-a');
  assert.equal(select.options[2].textContent, '测试语音 B（zh-CN）');
  assert.equal(select.value, '');
  assert.equal(select.disabled, false);
});

// M4（一轮·低）：全量重建 option 会把焦点踢回 body；重建后只把「原本就在下拉里」的焦点还回去。
test('M4（一轮·低）：重建语音下拉后恢复焦点与选中项；焦点在别处时不抢焦点', () => {
  const { host, get } = makeHost();
  const tts = ttsUi.create(host);
  tts.setSpeechEngine(makeEngine());
  const select = get('tts-voice');
  host.state.tts.voiceURI = 'fake-voice-b';

  globalThis.document.activeElement = select;
  tts.renderTtsVoices();
  assert.equal(globalThis.document.activeElement, select, '重建 option 后焦点回到语音下拉（读屏不丢焦点）');
  assert.equal(select.focusCalls, 1);
  assert.equal(select.value, 'fake-voice-b', '选中项按 state.tts.voiceURI 原样恢复');

  globalThis.document.activeElement = null;
  tts.renderTtsVoices();
  assert.equal(select.focusCalls, 1, '焦点在正文 / 别的控件时绝不许抢焦点');
});

test('静态闸门：renderer.js 不再内嵌朗读状态机，只剩接线与假引擎', () => {
  for (const name of ['openTtsBar', 'renderTtsBar', 'ttsSummaryText', 'realSpeechEngine', 'speakTtsChunk']) {
    assert.ok(
      !new RegExp('^  (?:async )?function ' + name + '\\b|^  const ' + name + ' =', 'm').test(rendererSrc),
      'renderer.js 里又有 ' + name + ' 的第二份实现'
    );
  }
  assert.match(rendererSrc, /ttsUi\.create\(\{ api, \$, call, state, toast, editorEl, scrollCaretIntoView \}\)/);
  // 假引擎（?test=1 的调试通道）留在渲染层，且必须真的换进模块
  assert.match(rendererSrc, /function installFakeSpeech\(\)/);
  assert.match(rendererSrc, /tts\.setSpeechEngine\(/);
});

test('静态闸门：index.html 在 renderer.js 之前加载 tts-ui.js，且模块自己是干净的', () => {
  const ttsIdx = indexSrc.indexOf('src="tts-ui.js"');
  const rendererIdx = indexSrc.indexOf('src="renderer.js"');
  assert.ok(ttsIdx > 0, 'index.html 没有加载 tts-ui.js');
  assert.ok(ttsIdx < rendererIdx, 'tts-ui.js 必须排在 renderer.js 之前');
  // A8（WP-32）：唯一允许的 require 是 UMD 的 Node 分支取 core/assert-host.js；
  // 运行时代码仍不许 require 任何东西。
  const assertHostBranch = "module.exports = factory(require('../core/assert-host').assertHost);";
  assert.ok(moduleSrc.includes(assertHostBranch), 'UMD 的 Node 分支必须从 ./assert-host 取共享 host 校验');
  const runtimeSrc = moduleSrc.split(assertHostBranch).join('');
  assert.ok(!/\brequire\s*\(/.test(runtimeSrc), 'tts-ui.js 不许 require');
  assert.ok(!/window\.cwApi|\bipcRenderer\b|node:fs/.test(moduleSrc), 'tts-ui.js 不许自己摸 Electron / 文件系统');
  // 模块顶层（2 空格缩进的语句）不许直接查 DOM（Node 里 require 成功已经证明「加载时不碰 DOM」）
  assert.ok(!/^  \$\(/m.test(moduleSrc), '模块顶层不许直接查 DOM');
});

// ---------- 五-M21（MP-03）：编辑视图内换书要先停朗读 ----------
// 书 A 正在朗读时，不经书架直接在编辑视图换到书 B（命令面板「打开《B》」/ 查找面板跨书书签）：
// openBookByPath → commitOpenBook 全程不停 TTS。speechSynthesis 继续念书 A；每次段末 advanceTts →
// selectTtsChunk 把书 A 的 start/end 套进书 B 已清空 / 遮罩的编辑区；showView('editor') 本来就停在
// editor，L773 的 closeTtsBar 不触发。正常路径要等新书载章成功（save-chain-ui.js:185）才停；
// 载章失败（遮罩态）时永不执行，旧书朗读无限期继续。修法：commitOpenBook 开头（清任何状态之前）就停。
// 这一段必须留在 renderer.js（编排器闭包），所以用静态闸门钉住接线与顺序。
test('M21（MP-03）：commitOpenBook 在清空书状态之前先停朗读（换书不再跨书继续念）', () => {
  const start = rendererSrc.indexOf('async function commitOpenBook(');
  assert.ok(start > 0, '找不到 commitOpenBook');
  const body = rendererSrc.slice(start, rendererSrc.indexOf('\n  async function ', start + 1));
  const stopAt = body.indexOf('stopTtsForChapterChange();');
  assert.ok(stopAt > -1, '换书必须先停朗读（commitOpenBook 里找不到 stopTtsForChapterChange）');
  const clearUndoAt = body.indexOf('undoUi.clear();');
  assert.ok(clearUndoAt > -1, '找不到 undoUi.clear()');
  assert.ok(stopAt < clearUndoAt, '停朗读必须排在清撤销 / 清书状态之前');
  assert.ok(
    stopAt < body.indexOf('state.bookPath = bookPath;'),
    '停朗读必须在改写 state.bookPath 之前（停的是旧书那一段）'
  );
  assert.ok(
    stopAt < body.indexOf('editorEl.value = '),
    '停朗读必须在清空编辑区之前'
  );
});

// V31：暂停期间到点的 watchdog 只会自己退出；「继续」时如果不重新计时，语音真没响应就会永远停在「正在朗读」。
// 用真实引擎适配 + 假 speechSynthesis / 注入计时器：能数出 watchdog 挂了几颗、几秒。
test('watchdog：暂停超时后再「继续」要重新挂计时器，恢复无响应时能报错（V31）', async () => {
  const realWindow = globalThis.window;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const timers = [];
  const synth = {
    speaking: false,
    pending: false,
    paused: false,
    getVoices: () => [{ name: '测试语音', lang: 'zh-CN', voiceURI: 'v1' }],
    speak() {}, // 永不回调 onstart / onend：模拟语音没有任何响应
    pause() { synth.paused = true; },
    resume() { synth.paused = false; },
    cancel() { synth.paused = false; }
  };
  class FakeUtterance {
    constructor(text) { this.text = text; }
  }
  globalThis.window = { speechSynthesis: synth, SpeechSynthesisUtterance: FakeUtterance };
  globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  globalThis.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].canceled = true; };
  try {
    const { host, state } = makeHost();
    const tts = ttsUi.create(host); // 不换假引擎：走真实引擎适配，watchdog 才会挂
    await tts.openTtsBar();
    assert.equal(timers.length, 1, '开始朗读要挂一颗 watchdog');
    assert.equal(timers[0].ms, 12000, 'watchdog 是 12 秒');
    assert.equal(state.tts.status, 'playing');

    assert.deepEqual(tts.toggleTtsPlay(), { ok: true, action: 'pause' });
    timers[0].fn(); // 暂停超过 12 秒：watchdog 到点，看到不是 playing 只退出
    assert.equal(state.tts.status, 'paused', '暂停期间 watchdog 到点不许改坏状态');

    assert.deepEqual(tts.toggleTtsPlay(), { ok: true, action: 'resume' });
    assert.equal(timers.length, 2, '继续时要从头重新挂 watchdog（旧的那颗已经到点退出）');
    assert.equal(timers[1].ms, 12000);

    timers[1].fn(); // 恢复后语音仍没响应（speaking / pending 都是 false）
    assert.equal(state.tts.status, 'error', '恢复后无响应要落回 error，不能永远停在「正在朗读」');
    assert.match(state.tts.error, /没有响应/);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    if (realWindow === undefined) delete globalThis.window;
    else globalThis.window = realWindow;
  }
});

// ---------- R4（三审·待作者拍板）：窗口最小化 → 停朗读 ----------
// 主进程多了一条 browserWin.on('minimize') → app:window-minimized 通知（只发给那扇窗口）。
// 这里钉住渲染层这一侧的行为：真的 cancel 语音、朗读条保留（不收起）、不自动续读、不弹提示，
// 以及「本来就没在念」时收到通知不炸。
test('R4：收到「窗口最小化」通知就停朗读（朗读条保留、不自动续读、不弹提示）', async () => {
  const { host, state, toasts } = makeHost();
  let onMinimized = null;
  host.api.onWindowMinimized = (cb) => {
    onMinimized = cb;
  };
  const engine = makeEngine();
  const { tts, result } = await openWith(host, engine);
  assert.equal(result.ok, true);
  assert.equal(state.tts.status, 'playing');
  assert.equal(typeof onMinimized, 'function', 'tts-ui 必须自己订阅 app:window-minimized（别往 renderer.js 加）');

  const cancelBefore = engine.log.cancelled;
  onMinimized();
  assert.equal(state.tts.status, 'idle', '最小化后必须落回「已停止」');
  assert.equal(engine.log.cancelled, cancelBefore + 1, '必须真的 cancel 系统中的语音（只 cancel 一次）');
  assert.equal(state.tts.open, true, '最小化只停朗读：朗读条保留，不被顺手收起');
  assert.equal(state.tts.chunks.length, 3, '分段保留：恢复窗口后作者直接点播放就能接着念');
  assert.equal(state.tts.index, 0, '不自动续读——不在这里推进段落指针');
  assert.deepEqual(toasts, [], '最小化是常见动作，不弹提示');
  assert.equal(tts.ttsSummaryText().text, '已停止 · 第 1/3 段', '状态栏文案是「已停止」，不是「已读完」');

  // 重复通知（个别系统会连发两次 minimize）：本来就没在念，什么都不该变
  onMinimized();
  assert.equal(state.tts.status, 'idle');
  assert.equal(engine.log.cancelled, cancelBefore + 1, '已经在停的朗读不许再 cancel 一次');

  // 恢复到前台不会自己重新开念（没有 restore 通知，也没有定时器）
  const spokenAfterOpen = engine.log.spoken.length;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(state.tts.status, 'idle');
  assert.equal(engine.log.spoken.length, spokenAfterOpen, '恢复窗口后不自动续读（要不要接着念由作者再点一次）');
});

test('R4：旧宿主 / 假 api 没有 onWindowMinimized 时照常创建（可选注入口径）', () => {
  const { host } = makeHost();
  assert.equal(typeof host.api.onWindowMinimized, 'undefined');
  const tts = ttsUi.create(host);
  assert.equal(typeof tts.openTtsBar, 'function');
});

