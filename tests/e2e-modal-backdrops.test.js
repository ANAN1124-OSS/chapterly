'use strict';
// 弹层无障碍名单的**静态闸门**（1.6.1 R8 / V15 a11y 门禁补 4 个弹层）。
//
// 钉住一件事：**页面上的每一个 *backdrop 都必须在 E2E 第 70 组的 BACKDROPS 名单里**，
// 而且名单里的每一项都要在页面上真实存在（双向核对，不是只数个数）。
//
// 为什么要有这一层：E2E 第 70 组只能在一个真实 Electron 窗口里跑，代价高；名单与
// renderer/index.html 脱节时（新增弹层忘了登记）那一组才会红，太晚也太贵。这里直接
// 解析两份源码文本，零依赖、毫秒级，让「名单缺一项」立刻可单测红绿。
//
// 名单里的四项 = 弹层 id / 期望标题。EXPECTED_NAMES 里没有条目的弹层，标题是动态的
// （通用询问框 modal-backdrop），只要求挂了 aria-labelledby 且指向非空标题。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
const GROUP = fs.readFileSync(path.join(ROOT, 'scripts/e2e/groups/70-a11y-keyboard.js'), 'utf8');

// ---------- 解析 renderer/index.html ----------

// 页面上所有 <div id="X-backdrop" class="backdrop ..."> 的位置
function backdropStarts() {
  const re = /<div id="([a-z-]+-backdrop)" class="backdrop[^"]*"/g;
  const starts = [];
  let m;
  while ((m = re.exec(HTML))) starts.push({ id: m[1], index: m.index });
  return starts;
}

// 每个弹层的块 = 它自己到下一个弹层之前（最后一个到文件末尾）
function backdropBlocks() {
  const starts = backdropStarts();
  return starts.map((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : HTML.length;
    return { id: s.id, block: HTML.slice(s.index, end) };
  });
}

// 弹层里的 role="dialog" 挂的 aria-labelledby，指向的标题元素文本
function dialogLabel(block) {
  const m = /role="dialog"[^>]*aria-labelledby="([^"]+)"/.exec(block);
  return m ? m[1] : null;
}

function titleText(id) {
  const re = new RegExp('id="' + id + '"[^>]*>([\\s\\S]*?)</');
  const m = re.exec(HTML);
  if (!m) return null;
  return m[1].replace(/<[^>]*>/g, '').replace(/\\s+/g, ' ').trim();
}

// 页面上的弹层现场：id → { labelledby, title }
function pageDialogs() {
  const out = new Map();
  for (const { id, block } of backdropBlocks()) {
    const labelledby = dialogLabel(block);
    out.set(id, { labelledby, title: labelledby ? titleText(labelledby) : null });
  }
  return out;
}

// ---------- 解析 E2E 第 70 组名单 ----------

function parseBackdrops() {
  const m = /const BACKDROPS = \[([\s\S]*?)\];/.exec(GROUP);
  assert.ok(m, 'scripts/e2e/groups/70-a11y-keyboard.js 里找不到 BACKDROPS 名单');
  const ids = [];
  const re = /'([a-z-]+-backdrop)'/g;
  let x;
  while ((x = re.exec(m[1]))) ids.push(x[1]);
  return ids;
}

function parseExpectedNames() {
  const m = /const EXPECTED_NAMES = \{([\s\S]*?)\};/.exec(GROUP);
  assert.ok(m, 'scripts/e2e/groups/70-a11y-keyboard.js 里找不到 EXPECTED_NAMES 表');
  const out = new Map();
  const re = /'([a-z-]+-backdrop)'\s*:\s*'([^']+)'/g;
  let x;
  while ((x = re.exec(m[1]))) out.set(x[1], x[2]);
  return out;
}

// ---------- 闸门 ----------

test('弹层名单：页面上的每个 *backdrop 都在 E2E 第 70 组的 BACKDROPS 里（缺一项就红）', () => {
  const page = [...pageDialogs().keys()];
  const listed = new Set(parseBackdrops());
  const missing = page.filter((id) => !listed.has(id));
  assert.deepStrictEqual(
    missing,
    [],
    '这些弹层在 renderer/index.html 上，但没进 scripts/e2e/groups/70-a11y-keyboard.js 的 BACKDROPS：' +
      missing.join('、')
  );
});

test('弹层名单：BACKDROPS 里的每个 id 都在页面上真实存在（名单不许留幽灵项）', () => {
  const page = new Set(pageDialogs().keys());
  const ghosts = parseBackdrops().filter((id) => !page.has(id));
  assert.deepStrictEqual(ghosts, [], 'BACKDROPS 里这些 id 在 renderer/index.html 上找不到：' + ghosts.join('、'));
});

test('弹层名单：BACKDROPS 没有重复项', () => {
  const ids = parseBackdrops();
  assert.strictEqual(new Set(ids).size, ids.length, 'BACKDROPS 里有重复 id');
});

test('弹层名单：每个弹层都挂了 aria-labelledby，指向页面上真实存在且有文字的标题', () => {
  for (const [id, { labelledby, title }] of pageDialogs()) {
    assert.ok(labelledby, id + ' 的 role="dialog" 没挂 aria-labelledby');
    assert.ok(title !== null, id + ' 的 aria-labelledby 指向的标题（' + labelledby + '）在页面上不存在');
    // 通用询问框（modal-backdrop）的标题是运行时按问题填的，静态 HTML 里本来就是空的；
    // 它的非空名字由第 70 组进写作页后单独测（'通用询问框打开后有非空名字'）。
    if (id !== 'modal-backdrop') {
      assert.ok(title.length > 0, id + ' 的标题（' + labelledby + '）是空的，读屏读不出名字');
    }
  }
});

test('弹层名单：固定标题的弹层，EXPECTED_NAMES 里登记的标题得对上页面标题', () => {
  const expected = parseExpectedNames();
  const dialogs = pageDialogs();
  const missing = [...dialogs.keys()].filter((id) => id !== 'modal-backdrop' && !expected.has(id));
  assert.deepStrictEqual(missing, [], '这些弹层标题是固定的，但 EXPECTED_NAMES 里没有登记：' + missing.join('、'));
  for (const [id, want] of expected) {
    const dialog = dialogs.get(id);
    assert.ok(dialog, 'EXPECTED_NAMES 里的 ' + id + ' 不在页面上');
    assert.ok(
      (dialog.title || '').startsWith(want),
      id + ' 的期望标题是「' + want + '」，页面上是「' + dialog.title + '」'
    );
  }
});

test('弹层名单：E2E 第 70 组反向核对页面（DOM 里数 *backdrop，不认名单）', () => {
  assert.match(
    GROUP,
    /querySelectorAll\('[^']*backdrop[^']*'\)/,
    '第 70 组没有从 DOM 反向抓 *backdrop 的扫描；只按名单数一遍就发现不了「页面上多了一个弹层」'
  );
  assert.match(GROUP, /BACKDROPS\.includes\(/, '第 70 组抓到的 DOM 弹层没有拿去和 BACKDROPS 比对');
  assert.match(GROUP, /names\.length === \d+/, '第 70 组没有断言「名单项数 === 页面上抓到的弹层数」');
});
