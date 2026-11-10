// 1.4.0 P0-2（撤销优先）：撤销层纯逻辑 + 撤销条。
//
// 删除章节从「弹确认框」改成「直接执行 + 10 秒内撤销」以后，三件事必须可单测：
//   1. 单槽撤销（只留最近一条、10s TTL、新动作覆盖旧的）；
//   2. Ctrl+Z 键位判定（Ctrl + Z，不带 Shift / Alt / Meta）；
//   3. 焦点保护（编辑区 / 输入框 / 下拉框 / contenteditable 里还是文本撤销）。
// 另外用静态闸门钉住 index.html 的条子结构 / 脚本顺序、renderer.js 的接线，
// 免得以后有人把「再弹一个确认框」加回来。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const undoAction = require('../renderer/undo-action');
const undoUiModule = require('../renderer/undo-ui');
const { loadSourceGate } = require('./ui-test-preambles');

const ROOT = path.join(__dirname, '..');
const { rendererSrc, rendererCode, indexSrc } = loadSourceGate('undo-action.js');
const undoUiSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'undo-ui.js'), 'utf8');
const storageSrc = fs.readFileSync(path.join(ROOT, 'core', 'storage.js'), 'utf8');
const stylesSrc = fs.readFileSync(path.join(ROOT, 'renderer', 'styles.css'), 'utf8');

function makeEl(id) {
  const classes = new Set();
  const attrs = new Map();
  const listeners = {};
  return {
    id,
    textContent: '',
    _classes: classes,
    _attrs: attrs,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name)
    },
    setAttribute(name, value) {
      attrs.set(name, String(value));
    },
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null;
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
  const toasts = [];
  const slot = options.slot || undoAction.createUndoSlot({ ttlMs: options.ttlMs || 10000 });
  const host = {
    $: (id) => {
      if (!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
    slot,
    toast: (message, kind) => toasts.push({ message, kind })
  };
  return { host, els, slot, toasts };
}

// ---------- 纯逻辑：键位与焦点保护 ----------

test('撤销层：Ctrl+Z 键位判定（大小写都认，带 Shift / Alt / Meta 一律不算）', () => {
  const key = (patch) => ({ key: 'z', ctrlKey: true, ...patch });
  assert.equal(undoAction.isUndoKey(key({})), true);
  assert.equal(undoAction.isUndoKey({ key: 'Z', ctrlKey: true }), true);
  assert.equal(undoAction.isUndoKey(key({ shiftKey: true })), false);
  assert.equal(undoAction.isUndoKey(key({ altKey: true })), false);
  assert.equal(undoAction.isUndoKey(key({ metaKey: true })), false);
  assert.equal(undoAction.isUndoKey({ key: 'z' }), false, '不按 Ctrl 不算');
  assert.equal(undoAction.isUndoKey({ key: 'y', ctrlKey: true }), false);
  assert.equal(undoAction.isUndoKey(null), false);
});

test('撤销层：焦点在输入类目标上时 Ctrl+Z 不归撤销条管', () => {
  const ev = { key: 'z', ctrlKey: true };
  assert.equal(undoAction.isUndoKey(ev, true), false, 'typing = true 直接让路');
  assert.equal(undoAction.isUndoKey(ev, false), true);
});

test('撤销层：isTypingTarget 认 input / select / textarea（含编辑区）/ contenteditable', () => {
  const tag = (name) => ({ tagName: name });
  assert.equal(undoAction.isTypingTarget(tag('INPUT')), true);
  assert.equal(undoAction.isTypingTarget(tag('SELECT')), true);
  assert.equal(undoAction.isTypingTarget(tag('TEXTAREA')), true);
  assert.equal(undoAction.isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(undoAction.isTypingTarget({ tagName: 'DIV', getAttribute: () => '' }), true);
  assert.equal(undoAction.isTypingTarget({ tagName: 'DIV', getAttribute: () => 'false' }), false);
  assert.equal(undoAction.isTypingTarget({ tagName: 'BUTTON' }), false);
  assert.equal(undoAction.isTypingTarget(null), false);
});

// ---------- 纯逻辑：小栈（深度 3）+ 每条自己的 TTL ----------

test('撤销槽：新动作压在最上面，旧的一条仍可回退（栈，不再是单槽）', () => {
  const slot = undoAction.createUndoSlot();
  const first = slot.push({ label: '删除第一章', run: () => {} });
  const second = slot.push({ label: '删除第二章', run: () => {} });
  assert.equal(first.id + 1, second.id);
  assert.equal(slot.peek().label, '删除第二章');
  assert.equal(slot.size(), 2, '两条都还在（1.5.0 P0-4 / H-1：连续动作不再互相顶掉退路）');
  assert.equal(slot.remainingMs() > 0, true);
  assert.equal(slot.take().label, '删除第二章', 'take 弹最新那条');
  assert.equal(slot.peek().label, '删除第一章');
  assert.equal(slot.take().label, '删除第一章');
  assert.equal(slot.hasPending(), false);
});

test('撤销槽：深度 3，第 4 条顶掉最旧的那条并在返回值上给出 evicted 标记', () => {
  const slot = undoAction.createUndoSlot();
  const labels = ['甲', '乙', '丙', '丁'].map((label) => ({ label, run: () => {} }));
  const pushed = labels.map((item) => slot.push(item));
  assert.equal(pushed[2].evicted, null, '第 3 条还装得下');
  assert.equal(slot.size(), 3);
  assert.equal(pushed[3].evicted.label, '甲', '第 4 条顶掉最旧的「甲」');
  assert.equal(typeof pushed[3].evicted.run, 'undefined', '被顶掉的那条只留提示字段，不留还会被调用的闭包');
  assert.equal(slot.peek().label, '丁');
  assert.equal(slot.take().label, '丁');
  assert.equal(slot.take().label, '丙');
  assert.equal(slot.take().label, '乙');
  assert.equal(slot.hasPending(), false, '甲真的被顶掉了');
  assert.equal(slot.maxDepth, 3);
  assert.equal(undoAction.MAX_DEPTH, 3);
});

test('撤销槽：过期逐条清理，remainingMs 按当前条目自己的登记时刻算', () => {
  let now = 0;
  const slot = undoAction.createUndoSlot({ ttlMs: 10000, now: () => now });
  slot.push({ label: '甲', run: () => {} });
  now = 3000;
  slot.push({ label: '乙', run: () => {} });
  assert.equal(slot.remainingMs(), 10000, '乙从自己登记的 3000 起算');
  now = 10000;
  assert.equal(slot.size(), 1, '甲正好到期被清掉，乙还在');
  assert.equal(slot.peek().label, '乙');
  assert.equal(slot.remainingMs(), 3000);
  assert.equal(slot.expire(), false, '甲已经在 prune 里清掉，这一轮没有新的过期');
  now = 13000;
  assert.equal(slot.peek(), null);
  assert.equal(slot.size(), 0);
});

test('撤销槽：take(entry) 只取走指定那一条，不误伤这期间新登记的条目', () => {
  const slot = undoAction.createUndoSlot();
  const first = slot.push({ label: '整理全书', run: () => {} });
  slot.push({ label: '整本替换', run: () => {} });
  assert.equal(slot.take(first).label, '整理全书');
  assert.equal(slot.peek().label, '整本替换', '更新的那条还在');
  assert.equal(slot.take({ label: '不是条目' }), null, '外来对象取不走任何东西');
  assert.equal(slot.peek().label, '整本替换');
});

test('撤销槽：10 秒 TTL（到点 peek 清空），remainingMs 跟着走', () => {
  let now = 1000;
  const slot = undoAction.createUndoSlot({ ttlMs: 10000, now: () => now });
  slot.push({ label: '删除', run: () => {} });
  now = 1000 + 9999;
  assert.equal(slot.hasPending(), true);
  assert.equal(slot.remainingMs(), 1);
  now = 11000;
  assert.equal(slot.peek(), null, '正好 10s = 过期');
  assert.equal(slot.remainingMs(), 0);
  assert.equal(slot.expire(), false, '已经没条目了');
});

test('撤销槽：take 取走并清空；clear 无条件清空；expire 只清过期的那条', () => {
  let now = 0;
  const slot = undoAction.createUndoSlot({ now: () => now });
  slot.push({ label: '甲', run: () => {} });
  assert.equal(slot.take().label, '甲');
  assert.equal(slot.hasPending(), false);
  slot.push({ label: '乙', run: () => {} });
  slot.clear();
  assert.equal(slot.peek(), null);
  slot.push({ label: '丙', run: () => {} });
  assert.equal(slot.expire(), false);
  now = 10000;
  assert.equal(slot.expire(), true);
});

test('撤销槽：push 校验（空 / run 不是函数都抛 TypeError）、空 label 用默认文案', () => {
  const slot = undoAction.createUndoSlot();
  assert.throws(() => slot.push(null), /需要 \{ label, run \}/);
  assert.throws(() => slot.push({ label: 'x' }), /run 必须是函数/);
  const entry = slot.push({ run: () => {} });
  assert.equal(entry.label, undoAction.DEFAULT_LABEL);
  assert.equal(undoAction.TTL_MS, 10000);
});

// ---------- 撤销条（DOM + 定时器） ----------

test('撤销条：host 契约（$ / slot / toast 缺一个都抛）', () => {
  assert.deepEqual([...undoUiModule.REQUIRED_HOST].sort(), ['$', 'slot', 'toast']);
  assert.throws(() => undoUiModule.create(null), /需要 host 对象/);
  for (const key of undoUiModule.REQUIRED_HOST) {
    const { host } = makeHost();
    const broken = { ...host };
    delete broken[key];
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.throws(() => undoUiModule.create(broken), new RegExp('缺少 ' + escaped));
  }
});

test('撤销条：activate 显示条子与文案，新动作覆盖旧文案', () => {
  const { host, els, slot } = makeHost();
  const ui = undoUiModule.create(host);
  ui.activate('已删除「第 3 章」', () => {});
  const bar = els.get('undo-bar');
  assert.equal(bar.classList.contains('hidden'), false);
  assert.equal(bar.getAttribute('aria-hidden'), 'false');
  assert.equal(els.get('undo-label').textContent, '已删除「第 3 章」');
  assert.equal(slot.hasPending(), true);
  ui.activate('已删除「第 4 章」', () => {});
  assert.equal(els.get('undo-label').textContent, '已删除「第 4 章」');
});

test('撤销条：点「撤销」执行动作 → 成功后收起并清空槽', async () => {
  const { host, els, slot } = makeHost();
  const ui = undoUiModule.create(host);
  assert.equal(ui.setup(), true);
  assert.equal(ui.setup(), false, 'setup 幂等，只挂一次');
  let ran = 0;
  ui.activate('删除', () => {
    ran += 1;
  });
  els.get('btn-undo').fire('click', { preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(ran, 1);
  assert.equal(slot.hasPending(), false);
  assert.equal(els.get('undo-bar').classList.contains('hidden'), true);
});

test('撤销条：撤销失败 → toast 写清原因、条子不收起（可在 TTL 内再点）', async () => {
  const { host, els, slot, toasts } = makeHost();
  const ui = undoUiModule.create(host);
  ui.setup();
  ui.activate('删除', async () => {
    throw new Error('书里已经有同名章节文件');
  });
  els.get('btn-undo').fire('click', { preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(slot.hasPending(), true, '失败不静默吞掉撤销机会');
  assert.equal(els.get('undo-bar').classList.contains('hidden'), false);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].message, /^撤销失败：书里已经有同名章节文件$/);
  assert.equal(toasts[0].kind, 'error');
});

test('撤销条：成功后继续显示下一条（栈里更早的退路），撤完才收起', async () => {
  const { host, els } = makeHost();
  const ui = undoUiModule.create(host);
  ui.setup();
  const ran = [];
  ui.activate('已删除「第二章」', () => {
    ran.push('二');
  });
  ui.activate('已删除「第三章」', () => {
    ran.push('三');
  });
  assert.equal(els.get('undo-label').textContent, '已删除「第三章」', '条子显示最新那条');
  els.get('btn-undo').fire('click', { preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(ran, ['三']);
  assert.equal(els.get('undo-bar').classList.contains('hidden'), false, '更早的退路还在，条子不收起');
  assert.equal(els.get('undo-label').textContent, '已删除「第二章」', '条子换成下一条的文案');
  els.get('btn-undo').fire('click', { preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(ran, ['三', '二']);
  assert.equal(els.get('undo-bar').classList.contains('hidden'), true, '栈空了才收起');
});

test('撤销条：第 4 条顶掉最旧时 toast 提一句（不静默吞掉一步退路）', () => {
  const { host, toasts } = makeHost();
  const ui = undoUiModule.create(host);
  for (const label of ['甲', '乙', '丙']) ui.activate(label, () => {});
  assert.equal(toasts.length, 0, '深度 3 以内不打扰');
  ui.activate('丁', () => {});
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].message, /上一步（甲）的撤销已被新动作替换/);
});

test('撤销条：失败重试不把 10 秒重新续满（按这条自己的剩余时间过期）', async () => {
  const { host, els, slot } = makeHost({ ttlMs: 400 });
  const ui = undoUiModule.create(host);
  ui.setup();
  ui.activate('删除', async () => {
    throw new Error('文件被占用');
  });
  await new Promise((resolve) => setTimeout(resolve, 220));
  els.get('btn-undo').fire('click', { preventDefault() {} }); // 失败：保留，但不续时
  await new Promise((resolve) => setTimeout(resolve, 260)); // 总计 480ms > 这条自己的 400ms
  assert.equal(slot.hasPending(), false, '到期就清掉，不能因为重试又续满 10 秒');
  assert.equal(els.get('undo-bar').classList.contains('hidden'), true);
});

test('撤销条：× 关闭后条子消失、清空退路，焦点还给打开之前的元素', () => {
  const originalDoc = globalThis.document;
  const focused = [];
  const editor = { tagName: 'TEXTAREA', focus: () => focused.push('editor') };
  globalThis.document = { activeElement: editor, body: {} };
  try {
    const { host, els, slot } = makeHost();
    const ui = undoUiModule.create(host);
    assert.equal(ui.setup(), true);
    ui.activate('删除', () => {});
    // 模拟鼠标点 ×：焦点先落到关闭按钮上
    globalThis.document.activeElement = els.get('btn-undo-close');
    els.get('btn-undo-close').fire('click', { preventDefault() {} });
    assert.equal(els.get('undo-bar').classList.contains('hidden'), true);
    assert.equal(slot.hasPending(), false, '手动关掉 = 退路也一起收掉');
    assert.deepEqual(focused, ['editor'], '焦点回打开撤销条之前的元素');
    assert.equal(ui.dismiss(), false, '已经没退路时再关一次也不报错');
  } finally {
    if (originalDoc === undefined) delete globalThis.document;
    else globalThis.document = originalDoc;
  }
});

test('撤销条：TTL 到期自动收起并清空槽（用很小的 ttl 测定时器）', async () => {
  const { host, els, slot } = makeHost({ ttlMs: 25 });
  const ui = undoUiModule.create(host);
  ui.activate('删除', () => {});
  assert.equal(els.get('undo-bar').classList.contains('hidden'), false);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(slot.hasPending(), false);
  assert.equal(els.get('undo-bar').classList.contains('hidden'), true);
});

test('撤销条：clear() 用于换书 / 回书架（槽和条子一起清）', () => {
  const { host, els, slot } = makeHost();
  const ui = undoUiModule.create(host);
  ui.activate('删除', () => {});
  ui.clear();
  assert.equal(slot.hasPending(), false);
  assert.equal(els.get('undo-bar').classList.contains('hidden'), true);
  assert.equal(els.get('undo-label').textContent, '');
});

// ---------- 静态闸门：结构 / 接线 / 守卫 ----------

test('静态闸门：index.html 有撤销条结构，且两个模块排在 renderer.js 之前', () => {
  assert.match(indexSrc, /<div id="undo-bar" class="undo-bar hidden" role="status"[^>]*aria-live="polite"/);
  assert.match(indexSrc, /<span id="undo-label" class="undo-label"><\/span>/);
  assert.match(indexSrc, /<button id="btn-undo" class="btn ghost tiny undo-btn" type="button"/);
  // 1.5.0 P0-4（H-5）：手动关闭入口，24×24 由 aria-label 说明用途
  assert.match(indexSrc, /<button id="btn-undo-close"[^>]*type="button"[^>]*aria-label="关闭撤销提示"/);
  assert.match(indexSrc, /aria-hidden="true"/);
  const actionAt = indexSrc.indexOf('<script src="undo-action.js">');
  const uiAt = indexSrc.indexOf('<script src="undo-ui.js">');
  const rendererAt = indexSrc.indexOf('<script src="renderer.js">');
  assert.ok(actionAt > 0 && uiAt > actionAt && rendererAt > uiAt, '脚本顺序：undo-action → undo-ui → renderer');
});

test('静态闸门：renderer.js 接线（activate / setup / Ctrl+Z / 切书清除）都在', () => {
  assert.match(rendererCode, /undoUiModule\.create\(\{ \$, slot: undoActionModule\.createUndoSlot\(\), toast \}\)/);
  assert.match(rendererCode, /undoUi\.setup\(\)/);
  assert.match(rendererCode, /undoActionModule\.isUndoKey\(event, undoActionModule\.isTypingTarget\(document\.activeElement\)\)/);
  assert.match(rendererCode, /function activateDeleteUndo\(info\)/);
  assert.match(rendererCode, /api\.restoreDeletedChapter/);
  assert.match(rendererCode, /if \(view !== 'editor'\) undoUi\.clear\(\)/);
  assert.match(rendererCode, /undoUi\.clear\(\);\n    \/\/ 换书前先停掉上一本的写作计时/);
  // 1.5.0 P0-4（E4 / H-1 / H-2 / H-5 / H-9）的接线不许丢：手动关闭、长按不抖、撤销按 id / 邻居重算落点
  assert.match(rendererCode, /'close-undo-bar': \(\) => undoUi\.dismiss\(\)/);
  assert.match(rendererCode, /!event\.repeat/, 'Ctrl+K 要判 event.repeat（长按不许开-关抖动）');
  assert.match(
    rendererCode,
    /state\.chapters\.findIndex\(\(item\) => item && item\.id === info\.chapter\.id\)/,
    '撤销前按 id 在书目里重查'
  );
  assert.match(rendererCode, /neighborBeforeId/);
  assert.match(rendererCode, /neighborAfterId/);
  assert.match(rendererCode, /Math\.min\(info\.index, state\.chapters\.length\)/, '找不到邻居才退回捕获下标');
});

test('静态闸门：删除章节不再弹「删除章节」确认框（P0-2 只留两处确认）', () => {
  const start = rendererCode.indexOf('async function deleteChapterAt');
  const end = rendererCode.indexOf('function activateDeleteUndo');
  assert.ok(start > 0 && end > start, '找不到 deleteChapterAt / activateDeleteUndo');
  const body = rendererCode.slice(start, end);
  assert.doesNotMatch(body, /openModal\(/, '删除章节里不该再弹确认框');
  assert.doesNotMatch(rendererCode, /title: '删除章节'/);
  // 未保存拦截仍在：删当前脏章之前必须先问
  assert.match(rendererCode, /title: '删除前先处理未保存的修改'/);
});

test('静态闸门：CSS 用现有纸色令牌，撤销按钮至少 24×24（WCAG 2.5.8）', () => {
  assert.match(stylesSrc, /\.undo-bar \{[\s\S]*?background: var\(--folio-sheet\)[\s\S]*?color: var\(--ink\)/);
  assert.match(stylesSrc, /\.undo-btn \{ flex: none; min-height: 24px; \}/);
  // 1.5.0 P0-4（H-5）：× 也是 24×24 的可点目标
  assert.match(stylesSrc, /\.undo-close \{[\s\S]*?width: 24px;[\s\S]*?height: 24px;/);
});

test('静态闸门：storage 撤销只认 _trash 下的 basename，不接收绝对路径', () => {
  assert.match(storageSrc, /async function restoreDeletedChapterFromTrash\(bookPath, payload\)/);
  assert.match(storageSrc, /path\.basename\(trashName\) !== trashName/);
  assert.match(storageSrc, /trashName\.endsWith\(`-\$\{file\}`\)/);
  assert.match(storageSrc, /path\.dirname\(source\)\.toLowerCase\(\) !== path\.resolve\(trashDir\)\.toLowerCase\(\)/);
  assert.match(storageSrc, /restoreDeletedChapterFromTrash: locked\(restoreDeletedChapterFromTrash\)/);
});
