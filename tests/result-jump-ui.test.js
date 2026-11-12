'use strict';
// 1.7.0 P4-1（审计 V29）：校对 / 敏感词预检的「点结果 → 跳过去选中」原来是逐行复制的两份，
// 收编到 renderer/result-jump-ui.js。这里钉住共用实现本身，再用静态闸门挡住第二份长回来。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const modulePath = path.join(ROOT, 'renderer', 'result-jump-ui.js');
const moduleSrc = fs.readFileSync(modulePath, 'utf8');
const resultJump = require('../renderer/result-jump-ui');

function makeCtx(options = {}) {
  const log = [];
  const state = {
    bookPath: 'D:/书',
    chapters: [{ id: 'c1', name: '第一章' }, { id: 'c2', name: '第二章' }],
    index: 0,
    ...(options.state || {})
  };
  const editorEl = {
    value: '甲乙丙丁',
    focus: () => log.push('focus'),
    setSelectionRange: (start, end) => log.push('select:' + start + '-' + end)
  };
  const patch = options.patch || {};
  const host = {
    state,
    toast: (text, level) => log.push('toast:' + level + ':' + text),
    peers: {
      matchRangeAt: (text, item) => {
        log.push('match:' + item.chapterId + ':' + text);
        return { start: 1, end: 3 };
      }
    },
    nav: {
      editorEl,
      switchChapter: async (index) => {
        log.push('switch:' + index);
        return { ok: true };
      }
    },
    view: { scrollCaretIntoView: (start) => log.push('scroll:' + start) },
    ...patch.host
  };
  if (patch.editorEl) Object.assign(editorEl, patch.editorEl);
  const ui = resultJump.create(host);
  const close = () => log.push('close');
  return { ui, log, state, editorEl, close };
}

test('同一章：关面板 → 定位 → focus → 选中 → 滚进视野，不切章', async () => {
  const { ui, log, close } = makeCtx();
  const res = await ui.jumpToResult({ chapterId: 'c1', chapterIndex: 0 }, close);
  assert.deepEqual(res, { ok: true, start: 1, end: 3 });
  assert.deepEqual(log, ['close', 'match:c1:甲乙丙丁', 'focus', 'select:1-3', 'scroll:1']);
});

test('别的章：先关面板，再切章，切完才选中（顺序和收编前一致）', async () => {
  const { ui, log, close } = makeCtx();
  const res = await ui.jumpToResult({ chapterId: 'c2', chapterIndex: 1 }, close);
  assert.deepEqual(res, { ok: true, start: 1, end: 3 });
  assert.deepEqual(log, ['close', 'switch:1', 'match:c2:甲乙丙丁', 'focus', 'select:1-3', 'scroll:1']);
});

test('切章被取消：原样返回 canceled，不选中、不滚', async () => {
  const { ui, log, close } = makeCtx({
    patch: { host: { nav: { switchChapter: async () => ({ ok: false, canceled: true }) } } }
  });
  // editorEl 已在上面 patch 掉，重新补一个（nav 必须是完整对象）
  const res = await ui.jumpToResult({ chapterId: 'c2', chapterIndex: 1 }, close);
  assert.deepEqual(res, { ok: false, canceled: true });
  assert.deepEqual(log, ['close']);
});

test('章已经不在了：toast 警告 + ok:false，不关面板', async () => {
  const { ui, log, close } = makeCtx();
  const res = await ui.jumpToResult({ chapterId: 'c9', chapterIndex: 9 }, close);
  assert.deepEqual(res, { ok: false });
  assert.deepEqual(log, ['toast:warn:这一章已经不存在了']);
});

test('结果没带章信息：落在正在看的这一章', async () => {
  const { ui, log, close } = makeCtx({ state: { index: 1 } });
  const res = await ui.jumpToResult({ chapterId: null, chapterIndex: null }, close);
  assert.deepEqual(res, { ok: true, start: 1, end: 3 });
  assert.deepEqual(log, ['close', 'match:null:甲乙丙丁', 'focus', 'select:1-3', 'scroll:1']);
});

test('没打开书：直接 ok:false，不动面板', async () => {
  const { ui, log, close } = makeCtx({ state: { bookPath: '' } });
  const res = await ui.jumpToResult({ chapterId: 'c1', chapterIndex: 0 }, close);
  assert.deepEqual(res, { ok: false });
  assert.deepEqual(log, []);
});

test('host 校验：缺 peers.matchRangeAt 直接抛 TypeError', () => {
  assert.throws(
    () => resultJump.create({ state: {}, toast: () => {}, peers: {}, nav: {}, view: {} }),
    /host.peers 缺少 matchRangeAt/
  );
  assert.throws(() => resultJump.create(null), /需要 host 对象/);
});

test('UMD 浏览器分支：没有 module 时挂到全局 CWResultJumpUi，且不乱造别的全局', () => {
  const win = {};
  const context = vm.createContext(win);
  vm.runInContext(moduleSrc, context, { filename: 'renderer/result-jump-ui.js' });
  assert.deepEqual(Object.keys(win.CWResultJumpUi).sort(), ['REQUIRED_HOST', 'create']);
  assert.equal(win.CWResultJumpUi.REQUIRED_HOST.length, 5);
  assert.equal(win.CWProofreadUi, undefined);
});

test('静态闸门：「这一章已经不存在了」只许有一处实现，两个面板都走共用函数', () => {
  const dir = path.join(ROOT, 'renderer');
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.js'));
  const holders = files.filter((name) => /async function jumpToResult\s*\(/.test(fs.readFileSync(path.join(dir, name), 'utf8')));
  assert.deepEqual(holders, ['result-jump-ui.js'], '跳转实现只许在共用模块里：' + holders.join(', '));

  const proofread = fs.readFileSync(path.join(dir, 'proofread-ui.js'), 'utf8');
  const sensitive = fs.readFileSync(path.join(dir, 'sensitive-ui.js'), 'utf8');
  for (const [name, src] of [['proofread-ui.js', proofread], ['sensitive-ui.js', sensitive]]) {
    assert.equal(src.includes('matchRangeAt(editorEl.value'), false, name + ' 里还有第二份定位/选中代码');
    assert.equal(src.includes('setSelectionRange(range.start'), false, name + ' 里还有第二份选中代码');
  }
  assert.match(proofread, /function jumpToProofreadIssue\(issue\) \{[\s\S]{0,120}?jumpToResult\(issue, closeProofreadPanel\)/);
  assert.match(sensitive, /function jumpToSensitiveMatch\(match\) \{[\s\S]{0,120}?jumpToResult\(match, closeSensitivePanel\)/);
});

test('静态闸门：index.html 在 renderer.js 之前加载 result-jump-ui.js，且只加载一次', () => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const tag = '<script src="result-jump-ui.js"></script>';
  assert.equal(html.split(tag).length - 1, 1, 'result-jump-ui.js 只许加载一次');
  assert.ok(html.indexOf(tag) < html.indexOf('<script src="sensitive-ui.js"></script>'), '要排在两个面板之前');
  assert.ok(html.indexOf(tag) < html.indexOf('<script src="renderer.js"></script>'), '要排在 renderer.js 之前');
});
