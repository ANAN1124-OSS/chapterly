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

// ---------- 纯逻辑：单槽 + TTL ----------

test('撤销槽：只留最近一条，新动作覆盖旧的（单槽）', () => {
  const slot = undoAction.createUndoSlot();
  const first = slot.push({ label: '删除第一章', run: () => {} });
  const second = slot.push({ label: '删除第二章', run: () => {} });
  assert.equal(first.id + 1, second.id);
  assert.equal(slot.peek().label, '删除第二章');
  assert.equal(slot.remainingMs() > 0, true);
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
});

test('静态闸门：storage 撤销只认 _trash 下的 basename，不接收绝对路径', () => {
  assert.match(storageSrc, /async function restoreDeletedChapterFromTrash\(bookPath, payload\)/);
  assert.match(storageSrc, /path\.basename\(trashName\) !== trashName/);
  assert.match(storageSrc, /trashName\.endsWith\(`-\$\{file\}`\)/);
  assert.match(storageSrc, /path\.dirname\(source\)\.toLowerCase\(\) !== path\.resolve\(trashDir\)\.toLowerCase\(\)/);
  assert.match(storageSrc, /restoreDeletedChapterFromTrash: locked\(restoreDeletedChapterFromTrash\)/);
});
