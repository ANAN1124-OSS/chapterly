// M1（第一轮·低，第 13 轮第七刀）：全局键盘分流链的**行为**锚点。
//
// 背景：renderer.js 的 bindEvents 里最后一个大块是 document 上的 keydown 分流链（178 行、
// 约 40 个闭包）：输入法守卫 → 全局 Esc 链 → 快捷键一览 → 命令面板 → F11 / F3 / F2 →
// 段落导航 → 复制本章 → Ctrl+A 全选 → Ctrl+PageUp / PageDown 切章 → Ctrl+G 跳章 →
// Ctrl+F 查找 → 全局撤销 → 整理快照撤销 → Ctrl+S / Ctrl+N。
// 第 13 轮把整段搬进 renderer/global-keys-ui.js（renderer.js 只留一次装配 + bind()），
// 这里用假 document + 假 host 把每条分流、每个守卫的先后顺序逐条钉住，
// 再用机器清单钉「实现只有一份、index.html 的加载顺序、渲染层的接线都到位」。
const test = require('node:test');
const assert = require('node:assert/strict');
const globalKeys = require('../renderer/global-keys-ui');
const { loadSourceGate, stripAssertHostBranch } = require('./ui-test-preambles');

const flush = () => new Promise((resolve) => setImmediate(resolve));

// ------------------------------------------------------------------ 假 host
// 只实现这条分流链真正读到的东西：假 document（收 keydown）、按 id 记账的假元素、
// 记调用顺序的桩函数；需要特殊行为的用例用 overrides 换掉个别成员。
function makeHost(options = {}) {
  const calls = [];
  const listeners = [];
  const elements = new Map();
  const record = (name) => (...args) => {
    calls.push([name, ...args]);
  };
  const state = {
    view: 'editor',
    bookPath: '/书库/书甲',
    index: 1,
    chapters: [{}, {}, {}],
    loading: false,
    ...(options.state || {})
  };
  const documentRef = {
    activeElement: options.activeElement === undefined ? null : options.activeElement,
    addEventListener(type, fn) {
      listeners.push({ type, fn });
    }
  };
  const host = {
    document: documentRef,
    $: (id) => {
      if (!elements.has(id)) {
        elements.set(id, {
          id,
          focusCalls: 0,
          selectCalls: 0,
          focus() {
            this.focusCalls += 1;
          },
          select() {
            this.selectCalls += 1;
          }
        });
      }
      return elements.get(id);
    },
    state,
    editorEl: { id: 'editor' },
    imeGuard: { isImeComposing: (event) => Boolean(event && event.isComposing) },
    escLib: {
      isEscapeKey: (key) => key === 'Escape',
      resolve: (probe, key) => {
        calls.push(['escResolve', probe, key]);
        if (options.escHit === undefined) return null;
        return options.escHit;
      }
    },
    escProbe: () => ({ probe: true }),
    escRun: record('escRun'),
    anyBackdropOpen: () => Boolean(options.backdrops),
    commandPalette: { isOpen: () => Boolean(options.paletteOpen) },
    openShortcutsPage: record('openShortcutsPage'),
    openCommandPalette: record('openCommandPalette'),
    toggleFocusMode: record('toggleFocusMode'),
    findSessionActive: () => Boolean(options.findSession),
    stepFind: record('stepFind'),
    listKeyboard: {
      isTypingTarget: (node) => Boolean(node && node.typing),
      renameTargetIndex: () => (options.renameTarget === undefined ? 2 : options.renameTarget),
      chapterSwitchTarget: () => (options.switchTarget === undefined ? 2 : options.switchTarget)
    },
    renameChapterAt: record('renameChapterAt'),
    jumpParagraph: record('jumpParagraph'),
    copyChapterPlatformFlow: record('copyChapterPlatformFlow'),
    renderedChapterIds: () => (options.renderedIds === undefined ? ['c1', 'c2'] : options.renderedIds),
    setChapterSelection: record('setChapterSelection'),
    chapterSelectionLib: { selectAll: (ids) => ids.slice() },
    switchChapter: async (index) => {
      calls.push(['switchChapter', index]);
      if (options.switchRejects) throw new Error('切章失败');
      if (options.switchSame) return { ok: true, same: true };
      return { ok: true };
    },
    focusChapterItem: record('focusChapterItem'),
    reportChainFailure: record('reportChainFailure'),
    openJumpDialog: record('openJumpDialog'),
    openFindPanel: record('openFindPanel'),
    undoUi: {
      hasPending: () => Boolean(options.undoPending),
      runUndo: async () => {
        calls.push(['runUndo']);
      }
    },
    undoActionModule: {
      isTypingTarget: (node) => Boolean(node && node.typing),
      isUndoKey: (event, typing) =>
        !typing && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey &&
        String(event.key).toLowerCase() === 'z'
    },
    undoFormat: () => {
      calls.push(['undoFormat']);
      return Boolean(options.undoFormat);
    },
    saveCurrent: record('saveCurrent'),
    createChapterAt: record('createChapterAt'),
    hideContextMenu: record('hideContextMenu'),
    hideVolumeMenu: record('hideVolumeMenu'),
    hideExportMenu: record('hideExportMenu'),
    hideFormatMenu: record('hideFormatMenu'),
    hideDisplayMenu: record('hideDisplayMenu'),
    hideBookMenu: record('hideBookMenu')
  };
  Object.assign(host, options.overrides || {});
  const ui = globalKeys.create(host);
  ui.bind();
  const keydown = listeners.filter((entry) => entry.type === 'keydown');
  assert.equal(keydown.length, 1, 'bind() 必须只注册一个 document keydown 监听');
  const handler = keydown[0].fn;
  return {
    ui,
    host,
    state,
    calls,
    elements,
    listeners,
    handler,
    dispatch(event) {
      return handler(event);
    }
  };
}

function makeEvent(overrides = {}) {
  const event = {
    key: 'a',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
    target: null,
    prevented: 0,
    stopped: 0,
    preventDefault() {
      event.prevented += 1;
    },
    stopPropagation() {
      event.stopped += 1;
    }
  };
  Object.assign(event, overrides);
  return event;
}

const namesOf = (calls) => calls.map((entry) => entry[0]);

// ------------------------------------------------------------------ host 契约
test('host 契约：缺任何一个成员都当场抛 TypeError（不等到按键才 ReferenceError）', () => {
  const { host } = makeHost();
  for (const key of globalKeys.REQUIRED_HOST) {
    const broken = { ...host };
    delete broken[key];
    assert.throws(
      () => globalKeys.create(broken),
      new RegExp('createGlobalKeysUi 的 host 缺少 ' + key.replace(/\$/g, '\\$')),
      '缺 ' + key + ' 时必须当场报错'
    );
  }
  assert.throws(() => globalKeys.create(), /createGlobalKeysUi 需要 host 对象/);
  assert.throws(() => globalKeys.create(null), /createGlobalKeysUi 需要 host 对象/);
  assert.equal(new Set(globalKeys.REQUIRED_HOST).size, globalKeys.REQUIRED_HOST.length, '成员清单不许重复');
  assert.equal(globalKeys.REQUIRED_HOST.length, 32, '成员清单数量变了（新增 / 删除请同步本闸门）');
});

test('create() 只建对象、不碰 document；bind() 才注册监听', () => {
  const { host } = makeHost();
  let touched = 0;
  const quiet = {
    ...host,
    document: {
      activeElement: null,
      addEventListener() {
        touched += 1;
        throw new Error('bind 之前不许注册');
      }
    }
  };
  const ui = globalKeys.create(quiet);
  assert.deepEqual(Object.keys(ui).sort(), ['bind'], '实例只暴露 bind');
  assert.equal(touched, 0, 'create() 不许注册任何监听');
});

test('bind()：只注册 keydown，不碰别的类型', () => {
  const h = makeHost();
  assert.deepEqual(h.listeners.map((entry) => entry.type), ['keydown']);
});

// ------------------------------------------------------------------ 输入法守卫
test('输入法组字中一切都让路：Ctrl+S / Ctrl+K / ? 都不响应', () => {
  for (const overrides of [{ key: 's', ctrlKey: true }, { key: 'k', ctrlKey: true }, { key: '?' }]) {
    const h = makeHost();
    const event = makeEvent({ ...overrides, isComposing: true });
    h.dispatch(event);
    assert.equal(event.prevented, 0, '组字中不许拦默认行为：' + overrides.key);
    assert.deepEqual(namesOf(h.calls), [], '组字中不许触发任何入口：' + overrides.key);
  }
});

// ------------------------------------------------------------------ 全局 Esc 链
test('Esc 链：Esc 键才现算探针；命中动作按注册表的 preventDefault 口径执行', () => {
  const h = makeHost({ escHit: { action: 'close-settings', preventDefault: true } });
  const event = makeEvent({ key: 'Escape' });
  h.dispatch(event);
  assert.deepEqual(namesOf(h.calls), ['escResolve', 'escRun']);
  assert.deepEqual(h.calls[1], ['escRun', 'close-settings']);
  assert.deepEqual(h.calls[0][1], { probe: true }, 'resolve 必须拿到现算的探针');
  assert.equal(event.prevented, 1, '注册表要求拦默认行为');
});

test('Esc 链：命中但不要求 preventDefault 时不拦；命中后不再走后面的快捷键', () => {
  const h = makeHost({ escHit: { action: 'close-x', preventDefault: false } });
  const event = makeEvent({ key: 'Escape' });
  h.dispatch(event);
  assert.equal(event.prevented, 0);
  assert.deepEqual(namesOf(h.calls), ['escResolve', 'escRun']);

  // 命中「有响应但没有 action」的层：只吞掉这次按键，不执行动作、也不拦默认行为
  const swallow = makeHost({ escHit: { action: '', preventDefault: true } });
  const swallowEvent = makeEvent({ key: 'Escape' });
  swallow.dispatch(swallowEvent);
  assert.equal(swallowEvent.prevented, 0, '没有 action 时不许拦默认行为');
  assert.deepEqual(namesOf(swallow.calls), ['escResolve'], '命中即返回，不执行动作');
});

test('热路径（A5/P-09）：非 Esc、无锁键层、面板关着时不现算整份探针', () => {
  const h = makeHost();
  const event = makeEvent({ key: 'F11' });
  h.dispatch(event);
  assert.deepEqual(namesOf(h.calls), ['toggleFocusMode'], 'escLib.resolve 不该被调用，F11 照常处理');
});

test('非 Esc 键但锁键层 / 命令面板开着时仍现算探针', () => {
  for (const options of [{ backdrops: true }, { paletteOpen: true }]) {
    const h = makeHost(options);
    h.dispatch(makeEvent({ key: 'a' }));
    assert.deepEqual(namesOf(h.calls), ['escResolve'], '有锁键层时要现算：' + JSON.stringify(options));
  }
});

// ------------------------------------------------------------------ 快捷键一览
test('? / ？打开快捷键一览（不判 Shift），并拦默认行为', () => {
  for (const key of ['?', '？']) {
    const h = makeHost();
    const event = makeEvent({ key, shiftKey: true });
    h.dispatch(event);
    assert.deepEqual(namesOf(h.calls), ['openShortcutsPage'], '键：' + key);
    assert.equal(event.prevented, 1, '键：' + key);
  }
});

test('? 在输入框 / 弹层 / 组字时不抢', () => {
  const typing = makeHost({ activeElement: { typing: true } });
  typing.dispatch(makeEvent({ key: '?' }));
  assert.deepEqual(namesOf(typing.calls), [], '焦点在输入类目标里时不抢');

  const backdrop = makeHost({ backdrops: true });
  backdrop.dispatch(makeEvent({ key: '?' }));
  assert.deepEqual(namesOf(backdrop.calls).filter((name) => name === 'openShortcutsPage'), [], '弹层开着时不叠');

  const composing = makeHost();
  const event = makeEvent({ key: '?', isComposing: true });
  composing.dispatch(event);
  assert.equal(event.prevented, 0);
  assert.deepEqual(namesOf(composing.calls), []);
});

// ------------------------------------------------------------------ 命令面板
test('Ctrl+K 打开命令面板；长按的重复事件只吞掉、不再开合', () => {
  const h = makeHost();
  const event = makeEvent({ key: 'k', ctrlKey: true });
  h.dispatch(event);
  assert.deepEqual(namesOf(h.calls), ['openCommandPalette']);
  assert.equal(event.prevented, 1);

  const repeated = makeHost();
  const repeatEvent = makeEvent({ key: 'K', ctrlKey: true, repeat: true });
  repeated.dispatch(repeatEvent);
  assert.deepEqual(namesOf(repeated.calls), [], '长按不许重复开合');
  assert.equal(repeatEvent.prevented, 0, '长按只吞掉，不拦浏览器默认行为');
});

test('Ctrl+K 在锁键弹层开着时不抢', () => {
  const h = makeHost({ backdrops: true });
  const event = makeEvent({ key: 'k', ctrlKey: true });
  h.dispatch(event);
  assert.deepEqual(namesOf(h.calls).filter((name) => name === 'openCommandPalette'), []);
  assert.equal(event.prevented, 0);
});

// ------------------------------------------------------------------ F11 / F3 / F2
test('F11 只在写作页切换专注模式', () => {
  const editor = makeHost();
  const event = makeEvent({ key: 'F11' });
  editor.dispatch(event);
  assert.deepEqual(namesOf(editor.calls), ['toggleFocusMode']);
  assert.equal(event.prevented, 1);

  const shelf = makeHost({ state: { view: 'shelf' } });
  const shelfEvent = makeEvent({ key: 'F11' });
  shelf.dispatch(shelfEvent);
  assert.deepEqual(namesOf(shelf.calls), [], '书架不切专注模式');
  assert.equal(shelfEvent.prevented, 0);
});

test('F3 / Shift+F3 只在有查找会话时重复查找（方向按 Shift）', () => {
  for (const [shiftKey, expected] of [[false, 1], [true, -1]]) {
    const h = makeHost({ findSession: true });
    const event = makeEvent({ key: 'F3', shiftKey });
    h.dispatch(event);
    assert.deepEqual(h.calls, [['stepFind', expected]], 'Shift=' + shiftKey);
    assert.equal(event.prevented, 1);
  }
  const noSession = makeHost();
  const idle = makeEvent({ key: 'F3' });
  noSession.dispatch(idle);
  assert.deepEqual(namesOf(noSession.calls), [], '没有会话时 F3 不处理');
  assert.equal(idle.prevented, 0);
});

test('F2 按 renameTargetIndex 的目标重命名；输入框里的 F2 不抢', () => {
  const h = makeHost();
  const event = makeEvent({ key: 'F2' });
  h.dispatch(event);
  assert.deepEqual(h.calls, [['renameChapterAt', 2]]);
  assert.equal(event.prevented, 1);

  const typing = makeHost({ overrides: { listKeyboard: { isTypingTarget: () => true, renameTargetIndex: () => 2 } } });
  const typingEvent = makeEvent({ key: 'F2' });
  typing.dispatch(typingEvent);
  assert.deepEqual(namesOf(typing.calls), [], '焦点在别的输入框里时不抢');
  assert.equal(typingEvent.prevented, 0);

  const noTarget = makeHost({ renameTarget: -1 });
  noTarget.dispatch(makeEvent({ key: 'F2' }));
  assert.deepEqual(namesOf(noTarget.calls), [], '没有可改的目标时什么都不做');

  const noChapter = makeHost({ state: { index: -1 } });
  noChapter.dispatch(makeEvent({ key: 'F2' }));
  assert.deepEqual(namesOf(noChapter.calls), []);
});

// ------------------------------------------------------------------ 段落导航 / 复制本章
test('Alt+↑/↓ 在自然段之间跳；带 Ctrl 或 Meta 时不接管', () => {
  const down = makeHost();
  const downEvent = makeEvent({ key: 'ArrowDown', altKey: true });
  down.dispatch(downEvent);
  assert.deepEqual(down.calls, [['jumpParagraph', 1]]);
  assert.equal(downEvent.prevented, 1);

  const up = makeHost();
  up.dispatch(makeEvent({ key: 'ArrowUp', altKey: true }));
  assert.deepEqual(up.calls, [['jumpParagraph', -1]]);

  const ctrlAlt = makeHost();
  ctrlAlt.dispatch(makeEvent({ key: 'ArrowUp', altKey: true, ctrlKey: true }));
  assert.deepEqual(namesOf(ctrlAlt.calls), []);
});

test('Ctrl+Shift+C 复制本章（平台格式），书架不接管', () => {
  const h = makeHost();
  const event = makeEvent({ key: 'C', ctrlKey: true, shiftKey: true });
  h.dispatch(event);
  assert.deepEqual(h.calls, [['copyChapterPlatformFlow', 1]]);
  assert.equal(event.prevented, 1);

  const shelf = makeHost({ state: { view: 'shelf' } });
  const shelfEvent = makeEvent({ key: 'c', ctrlKey: true, shiftKey: true });
  shelf.dispatch(shelfEvent);
  assert.deepEqual(namesOf(shelf.calls), []);
  assert.equal(shelfEvent.prevented, 0);
});

// ------------------------------------------------------------------ Ctrl+A 全选
test('Ctrl+A 只在章节列表里全选「当前渲染出来的行」', () => {
  const inList = makeHost();
  const target = { closest: (selector) => (selector === '#chapter-list' ? { id: 'chapter-list' } : null) };
  const event = makeEvent({ key: 'a', ctrlKey: true, target });
  inList.dispatch(event);
  assert.deepEqual(inList.calls, [['setChapterSelection', ['c1', 'c2']]]);
  assert.equal(event.prevented, 1);

  const outside = makeHost();
  const outsideEvent = makeEvent({ key: 'a', ctrlKey: true, target: { closest: () => null } });
  outside.dispatch(outsideEvent);
  assert.deepEqual(namesOf(outside.calls), [], '焦点不在章节列表时交给原生全选');
  assert.equal(outsideEvent.prevented, 0);

  const empty = makeHost({ renderedIds: [] });
  empty.dispatch(makeEvent({ key: 'a', ctrlKey: true, target }));
  assert.deepEqual(namesOf(empty.calls), [], '没有可全选的行时什么都不做');
});

// ------------------------------------------------------------------ 切章
test('Ctrl+PageDown / PageUp 走 switchChapter，成功后按结果聚焦', async () => {
  const h = makeHost();
  const event = makeEvent({ key: 'PageDown', ctrlKey: true });
  h.dispatch(event);
  assert.equal(event.prevented, 1);
  assert.deepEqual(namesOf(h.calls).filter((name) => name !== 'focusChapterItem'), ['switchChapter']);
  await flush();
  assert.deepEqual(h.calls, [['switchChapter', 2], ['focusChapterItem', { mode: 'switch', index: 2 }]]);
});

test('Ctrl+PageDown：读盘中不叠第二趟；same / 越界不聚焦；失败要报链错误', async () => {
  const loading = makeHost({ state: { loading: true } });
  const loadingEvent = makeEvent({ key: 'PageDown', ctrlKey: true });
  loading.dispatch(loadingEvent);
  assert.equal(loadingEvent.prevented, 1, '读盘中仍然拦默认行为');
  assert.deepEqual(namesOf(loading.calls), [], '但不许叠第二趟切章');

  const outOfRange = makeHost({ switchTarget: -1 });
  outOfRange.dispatch(makeEvent({ key: 'PageDown', ctrlKey: true }));
  assert.deepEqual(namesOf(outOfRange.calls), [], '首章 / 末章不绕回');

  const same = makeHost({ switchSame: true });
  same.dispatch(makeEvent({ key: 'PageDown', ctrlKey: true }));
  await flush();
  assert.deepEqual(namesOf(same.calls), ['switchChapter'], '同一章不聚焦');

  const rejected = makeHost({ switchRejects: true });
  rejected.dispatch(makeEvent({ key: 'PageDown', ctrlKey: true }));
  await flush();
  assert.deepEqual(namesOf(rejected.calls), ['switchChapter', 'reportChainFailure']);
  assert.equal(rejected.calls[1][1], '切换章节失败');
});

// ------------------------------------------------------------------ 跳章 / 查找
test('Ctrl+G 打开跳章（只在写作页）；书架只吞按键', () => {
  const editor = makeHost();
  const event = makeEvent({ key: 'g', ctrlKey: true });
  editor.dispatch(event);
  assert.deepEqual(editor.calls, [['openJumpDialog']]);
  assert.equal(event.prevented, 1);

  const shelf = makeHost({ state: { view: 'shelf' } });
  const shelfEvent = makeEvent({ key: 'g', ctrlKey: true });
  shelf.dispatch(shelfEvent);
  assert.deepEqual(namesOf(shelf.calls), []);
  assert.equal(shelfEvent.prevented, 1, 'Ctrl+G 在书架也拦默认行为（原口径）');
});

test('Ctrl+F：写作页开查找面板，书架聚焦搜索框，阅读页只吞按键', () => {
  const editor = makeHost();
  const event = makeEvent({ key: 'f', ctrlKey: true });
  editor.dispatch(event);
  assert.deepEqual(namesOf(editor.calls), ['openFindPanel']);
  assert.equal(event.prevented, 1);

  const shelf = makeHost({ state: { view: 'shelf' } });
  const shelfEvent = makeEvent({ key: 'f', ctrlKey: true });
  shelf.dispatch(shelfEvent);
  const search = shelf.elements.get('shelf-search');
  assert.equal(search.focusCalls, 1);
  assert.equal(search.selectCalls, 1);
  assert.equal(shelfEvent.prevented, 1);

  const reading = makeHost({ state: { view: 'reading' } });
  const readingEvent = makeEvent({ key: 'f', ctrlKey: true });
  reading.dispatch(readingEvent);
  assert.deepEqual(namesOf(reading.calls), []);
  assert.equal(readingEvent.prevented, 1);
});

// ------------------------------------------------------------------ 撤销
test('全局撤销优先：有登记 + 撤销键 → runUndo，且不再落到整理快照', () => {
  const h = makeHost({ undoPending: true });
  const event = makeEvent({ key: 'z', ctrlKey: true });
  h.dispatch(event);
  assert.deepEqual(namesOf(h.calls), ['runUndo']);
  assert.equal(event.prevented, 1);
});

test('Ctrl+Z 整理快照：焦点在别的输入框时让原生撤销，编辑区自己例外', () => {
  // 编辑区自己例外：焦点 === editorEl 时即使 isTypingTarget 为 true 也照常撤整理
  const editorHost = makeHost({ undoFormat: true });
  editorHost.host.document.activeElement = editorHost.host.editorEl;
  const editorEvent = makeEvent({ key: 'z', ctrlKey: true });
  editorHost.dispatch(editorEvent);
  assert.deepEqual(namesOf(editorHost.calls), ['undoFormat']);
  assert.equal(editorEvent.prevented, 1);

  const otherInput = makeHost({ undoFormat: true, activeElement: { typing: true } });
  const otherEvent = makeEvent({ key: 'z', ctrlKey: true });
  otherInput.dispatch(otherEvent);
  assert.deepEqual(namesOf(otherInput.calls), [], '输入框里的 Ctrl+Z 是框内文本撤销');
  assert.equal(otherEvent.prevented, 0);

  const noSnapshot = makeHost({ undoFormat: false });
  const noneEvent = makeEvent({ key: 'z', ctrlKey: true });
  noSnapshot.dispatch(noneEvent);
  assert.deepEqual(namesOf(noSnapshot.calls), ['undoFormat'], '没有快照时也让原生撤销');
  assert.equal(noneEvent.prevented, 0);
});

// ------------------------------------------------------------------ 保存 / 建章
test('Ctrl+S 保存、Ctrl+N 建章只在写作页；书架只吞按键', () => {
  const editor = makeHost();
  const saveEvent = makeEvent({ key: 's', ctrlKey: true });
  editor.dispatch(saveEvent);
  assert.deepEqual(editor.calls, [['saveCurrent']]);
  assert.equal(saveEvent.prevented, 1);

  editor.dispatch(makeEvent({ key: 'n', ctrlKey: true }));
  assert.deepEqual(editor.calls, [['saveCurrent'], ['createChapterAt', 3]], '建章插在全书末尾');

  const shelf = makeHost({ state: { view: 'shelf' } });
  const shelfSave = makeEvent({ key: 's', ctrlKey: true });
  shelf.dispatch(shelfSave);
  assert.deepEqual(namesOf(shelf.calls), []);
  assert.equal(shelfSave.prevented, 1);
});

// ------------------------------------------------------------------ 机器清单
test('静态闸门：renderer.js 不再内嵌全局 keydown 分流链，只剩装配与 bind()', () => {
  const { rendererSrc, indexSrc, moduleSrc, moduleCode } = loadSourceGate('global-keys-ui.js');
  assert.equal(
    rendererSrc.includes("document.addEventListener('keydown'"),
    false,
    '全局 keydown 必须在 renderer/global-keys-ui.js（编排器里不许再长第二份）'
  );
  assert.match(rendererSrc, /^  const globalKeysUiModule = window\.CWGlobalKeysUi;$/m, 'renderer.js 要取模块全局名');
  assert.match(rendererSrc, /const globalKeysUi = globalKeysUiModule\.create\(\{/, 'renderer.js 要装配模块');
  assert.match(rendererSrc, /globalKeysUi\.bind\(\);/, 'renderer.js 要在原位置注册监听');

  const moduleAt = indexSrc.indexOf('src="global-keys-ui.js"');
  assert.ok(moduleAt > 0, 'index.html 必须加载 renderer/global-keys-ui.js');
  assert.ok(moduleAt < indexSrc.indexOf('src="renderer.js"'), 'global-keys-ui.js 必须排在 renderer.js 之前');
  assert.equal(indexSrc.split('global-keys-ui.js').length - 1, 1, 'global-keys-ui.js 只许加载一次');

  // 纯接线模块：除 UMD 的 require 外不许碰任何东西；也不许把 JSON 之外的状态搬进来。
  const runtimeSrc = stripAssertHostBranch(moduleSrc);
  assert.equal(/\brequire\s*\(/.test(runtimeSrc), false, '运行时代码不许 require');
  assert.equal(/window\.cwApi|\bipcRenderer\b|node:fs/.test(moduleSrc), false, '模块不许摸 Electron / 文件系统');
  assert.equal(moduleCode.includes('event.isComposing'), false, '输入法判据只许走共享 ime-guard');
  assert.match(moduleSrc, /assertHost\('createGlobalKeysUi', host, REQUIRED_HOST\);/, '必须走共享 assertHost');
  assert.match(moduleSrc, /return \{ bind \};/, '实例只暴露 bind');
});
