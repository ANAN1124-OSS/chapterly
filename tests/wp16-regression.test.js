'use strict';
// WP16（F1=R-N4 / A5，审计中 #19）：PR 级路径过滤 E2E + 共享最小假 DOM 基线。
//
// 红-绿口径：
//   R1  e2e-scope 纯函数：哪些改动需要跑 E2E（renderer/core/ipc/main/preload/E2E 基建）由唯一事实源决定，
//       不是只写在一段 YAML 里；通配符语义 / 反斜杠 / 大小写 / 前缀边界 / 坏输入 / 超大列表都要钉住。
//   R2  `.github/workflows/e2e-pr.yml` 的 pull_request.paths 与 E2E_TRIGGER_PATHS 逐项一致，
//       并且 PR 工作流是真的跑全量 E2E（锁定安装 + 供应链校验 + 固定时区），weekly / verify 的政策不变。
//   R6  共享最小假 DOM：makeEl / makeIdEl 的 classList、事件分发、子节点、属性、innerHTML 清空行为；
//       迁移名单里的文件真的复用基线、不再保留本地 makeEl 副本（真正的边界变体留在本地并在清单里登记）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const scope = require('../scripts/e2e-scope.js');
const preambles = require('./ui-test-preambles');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function commandsOf(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

const REQUIRED = [
  'renderer/renderer.js',
  'renderer/index.html',
  'renderer/deep/nested/panel.js',
  'core/common.js',
  'core/deep/x.js',
  'ipc/export.js',
  'main.js',
  'preload.js',
  'scripts/e2e/groups/01-new-book.js',
  'scripts/e2e-scenario.js',
  'scripts/run-e2e.js',
  'scripts/start.js',
  'scripts/e2e-runner-logic.js',
  '.github/workflows/e2e-pr.yml',
  'package.json',
  'pnpm-lock.yaml'
];

const NOT_REQUIRED = [
  'README.md',
  'docs/renderer/x.md',
  'build/icon.ico',
  'tests/wp16-regression.test.js',
  '.github/workflows/verify.yml',
  '.github/workflows/e2e-weekly.yml',
  'rendererX/foo.js',
  'COREx/y.js',
  'src/main.js',
  'main.jsx',
  'preload.jsx',
  'renderer.js',
  'renderer'
];

test('R1 路径过滤语义：renderer/core/ipc/main/preload/E2E 基建触发，文档/资源/别的目录不触发', () => {
  for (const file of REQUIRED) {
    const result = scope.touchesE2EScope([file]);
    assert.equal(result.required, true, `${file} 应该触发 PR E2E`);
    assert.equal(result.matched.length, 1, `${file} 应命中恰好一个 pattern`);
  }
  for (const file of NOT_REQUIRED) {
    const result = scope.touchesE2EScope([file]);
    assert.equal(result.required, false, `${file} 不该触发 PR E2E（实际命中 ${JSON.stringify(result.matched)}）`);
  }
  // 一次多个文件：只要有一个命中就触发，matched 逐条给出（便于本地排查）
  const mixed = scope.touchesE2EScope(['README.md', 'renderer/renderer.js', 'core/zip.js']);
  assert.equal(mixed.required, true);
  assert.deepEqual(
    mixed.matched.map((item) => item.file),
    ['renderer/renderer.js', 'core/zip.js']
  );
  // 通配符语义按 GitHub paths 口径：* 不跨 /，** 跨目录，? 单字符，锚定首尾
  assert.equal(scope.matchPath('core/*', 'core/a.js'), true);
  assert.equal(scope.matchPath('core/*', 'core/a/b.js'), false);
  assert.equal(scope.matchPath('core/**', 'core/a/b.js'), true);
  assert.equal(scope.matchPath('renderer/?.js', 'renderer/a.js'), true);
  assert.equal(scope.matchPath('renderer/?.js', 'renderer/ab.js'), false);
  assert.equal(scope.matchPath('main.js', 'src/main.js'), false);
  assert.equal(scope.matchPath('*.md', 'README.md'), true);
  assert.equal(scope.matchPath('*.md', 'docs/a.md'), false);
  // 路径归一：反斜杠 / 前导 ./ / 首尾空白按仓库相对路径处理；大小写不折叠
  assert.equal(scope.normalizeChangedPath('renderer\\renderer.js'), 'renderer/renderer.js');
  assert.equal(scope.normalizeChangedPath('./core/common.js'), 'core/common.js');
  assert.equal(scope.normalizeChangedPath('  renderer/index.html  '), 'renderer/index.html');
  assert.equal(scope.touchesE2EScope(['renderer\\renderer.js']).required, true);
  assert.equal(scope.touchesE2EScope(['./core/common.js']).required, true);
  assert.equal(scope.touchesE2EScope(['Renderer/renderer.js']).required, false, '大小写不同不是同一个路径');
});

test('R1b 坏输入 / 超大改动列表：非数组必须 TypeError，坏条目忽略，1.2 万条不拖垮', () => {
  for (const bad of [null, undefined, 'renderer/renderer.js', 42, {}]) {
    assert.throws(() => scope.touchesE2EScope(bad), TypeError, `非数组入参 ${String(bad)} 必须抛 TypeError`);
  }
  assert.equal(scope.touchesE2EScope([]).required, false);
  assert.equal(scope.touchesE2EScope(['   ', '']).required, false);
  const mixed = scope.touchesE2EScope([null, 3, {}, 'renderer/renderer.js']);
  assert.equal(mixed.required, true);
  assert.deepEqual(mixed.matched, [{ file: 'renderer/renderer.js', pattern: 'renderer/**' }]);

  const huge = Array.from({ length: 12000 }, (_, i) => `docs/第${i}章.md`);
  huge.push('renderer/index.html');
  const startedAt = Date.now();
  const result = scope.touchesE2EScope(huge);
  const elapsed = Date.now() - startedAt;
  assert.equal(result.required, true);
  assert.ok(elapsed < 2000, `1.2 万条改动应在 2 s 内判完（实际 ${elapsed} ms）`);
});

test('R2 PR 工作流：pull_request.paths 与事实源逐项一致，且真跑全量 E2E（F1）', () => {
  const file = path.join(ROOT, '.github', 'workflows', 'e2e-pr.yml');
  assert.equal(fs.existsSync(file), true, 'PR 级 E2E 工作流必须存在（审计中 #19 / F1）');
  const yaml = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const lines = yaml.split('\n');
  assert.match(yaml, /^name: e2e-pr$/m, '工作流名固定 e2e-pr');
  assert.match(yaml, /^on:\n {2}pull_request:\n {4}paths:$/m, '必须由 pull_request.paths 触发');
  const start = lines.findIndex((line) => /^ {4}paths:$/.test(line));
  assert.ok(start >= 0, '找不到 pull_request.paths 列表');
  const declared = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const hit = /^\s{6}- ['"]([^'"]+)['"]\s*$/.exec(lines[i]);
    if (!hit) break;
    declared.push(hit[1]);
  }
  assert.deepEqual(
    declared.slice().sort(),
    scope.E2E_TRIGGER_PATHS.slice().sort(),
    'paths 声明必须与 scripts/e2e-scope.js 的唯一事实源逐项一致（改一处漏一处就是假拦截）'
  );
  // T-27：push 到 main 的直推改动同样要跑 E2E（与 pull_request 同一份 paths 过滤）。
  assert.match(yaml, /^ {2}push:\n {4}branches: \[main\]\n {4}paths:$/m, '必须有 push.branches [main] + paths 触发');
  const pushBranches = /^ {4}branches: \[([^\]]+)\]$/m.exec(yaml);
  assert.ok(pushBranches, 'push.branches 必须是行内数组（唯一事实源 E2E_PUSH_BRANCHES）');
  assert.deepEqual(
    pushBranches[1].split(',').map((item) => item.trim()).sort(),
    scope.E2E_PUSH_BRANCHES.slice().sort(),
    'push 分支必须与 scripts/e2e-scope.js 的 E2E_PUSH_BRANCHES 一致'
  );
  const pushStart = lines.findIndex((line, index) => /^ {4}paths:$/.test(line) && index > start);
  assert.ok(pushStart > start, 'push 触发也要有 paths 列表');
  const pushDeclared = [];
  for (let i = pushStart + 1; i < lines.length; i += 1) {
    const hit = /^\s{6}- ['"]([^'"]+)['"]\s*$/.exec(lines[i]);
    if (!hit) break;
    pushDeclared.push(hit[1]);
  }
  assert.deepEqual(
    pushDeclared.slice().sort(),
    scope.E2E_TRIGGER_PATHS.slice().sort(),
    'push.paths 必须与 pull_request.paths 用同一份事实源（两条触发路径不许漂移）'
  );
  // 真跑全量 E2E：安装二进制、锁文件安装、供应链校验、固定时区、全量命令
  const commands = commandsOf(yaml);
  assert.match(commands, /pnpm install --frozen-lockfile/);
  assert.match(commands, /node scripts\/supply-chain-check\.js/);
  assert.match(commands, /tzutil \/s "China Standard Time"/);
  assert.match(commands, /run: pnpm run e2e\b/);
  assert.doesNotMatch(commands, /ELECTRON_SKIP_BINARY_DOWNLOAD/, 'E2E 必须装 Electron 二进制');
  assert.match(yaml, /^ {4}runs-on: windows-2022$/m);
  assert.match(yaml, /timeout-minutes: ([3-9]\d|[1-9]\d{2,})/, 'E2E 长场景超时要给足（≥ 30 分钟）');
  // 每周全量保留、verify 仍不跑 E2E（两条既有政策不被本工作流破坏）
  const weekly = read('.github/workflows/e2e-weekly.yml');
  assert.match(commandsOf(weekly), /run: pnpm run e2e/, 'e2e-weekly 仍整跑全量 E2E');
  assert.match(weekly, /schedule:/, 'e2e-weekly 仍由 schedule 定时触发');
  assert.doesNotMatch(
    commandsOf(read('.github/workflows/verify.yml')),
    /run-e2e|(?:pnpm|npm|npx|yarn)\s+(?:run\s+)?e2e\b/i,
    'verify.yml 仍不跑 E2E'
  );
});

test('R6 共享假 DOM 基线行为：classList / 事件 / 子节点 / 属性 / innerHTML / 焦点与选区', () => {
  const el = preambles.makeEl('button', 'btn');
  assert.equal(el.tagName, 'button');
  assert.equal(el.id, 'btn');
  assert.equal(el.className, '');
  el.classList.add('a', 'b');
  assert.equal(el.className, 'a b');
  assert.equal(el.classList.contains('a'), true);
  el.classList.toggle('b');
  assert.equal(el.classList.contains('b'), false);
  el.classList.toggle('b', true);
  assert.equal(el.classList.contains('b'), true);
  el.className = 'x  y';
  assert.equal(el.classList.contains('x'), true);
  assert.equal(el.classList.contains('y'), true);
  assert.equal(el.classList.contains('a'), false);

  const seen = [];
  el.addEventListener('click', (event) => {
    seen.push(event);
    return 'first';
  });
  el.addEventListener('click', () => 'second');
  assert.equal(el.fire('click', { kind: 'test' }), 'second', 'fire 返回最后一个监听结果');
  assert.deepEqual(seen, [{ kind: 'test' }]);
  assert.equal(el._fire('click', { kind: 'again' }), 'second', '_fire 与 fire 同一套分发');

  const child = preambles.makeEl('span', 'child');
  el.append(child);
  assert.equal(child.parentNode, el);
  assert.deepEqual(el.children, [child]);
  assert.equal(el.contains(child), true);
  el.removeChild(child);
  assert.equal(child.parentNode, null);
  assert.equal(el.contains(child), false);
  const child2 = preambles.makeEl('i', 'child2');
  el.appendChild(child2);
  child2.remove();
  assert.deepEqual(el.children, []);
  assert.equal(el.childElementCount, 0);

  el.setAttribute('data-x', 3);
  assert.equal(el.getAttribute('data-x'), '3', 'setAttribute 按 DOM 口径转字符串');
  assert.equal(el.getAttribute('missing'), null);
  el.textContent = '你好';
  assert.equal(el.textContent, '你好');
  el.appendChild(preambles.makeEl('b', 'b1'));
  el.innerHTML = '';
  assert.deepEqual(el.children, [], 'innerHTML = "" 要真的清空子节点（列表重渲染靠它）');
  assert.equal(el.childElementCount, 0);
  assert.equal(el.textContent, '', 'innerHTML = "" 与真 DOM 一样把文本一起清掉');
  el.focus();
  el.focus();
  assert.equal(el._focus, 2);
  el.select();
  el.setSelectionRange(1, 3);
  assert.equal(el.selectionStart, 1);
  assert.equal(el.selectionEnd, 3);
  const byId = preambles.makeIdEl('status-text');
  assert.equal(byId.id, 'status-text');
  assert.equal(byId.tagName, 'div');
});

// TEST-D-02：基线本体只有一份，各域的差异走 spec 注入点。
// 这段把注入语义钉住——textContent 统一成真 DOM 口径（有子节点读整棵子树），文本只有 tree / own 两档，
// 不再允许各文件自己发明第三套。
test('R6a 假 DOM 基线：textContent 真 DOM 口径 / fragment 搬运 / spec 注入点', () => {
  // 1) textContent 默认就是真 DOM 口径：有子节点读整棵子树的文本
  const row = preambles.makeEl('div', 'row');
  const head = preambles.makeEl('span');
  head.textContent = '第二章';
  const tail = preambles.makeEl('span');
  tail.textContent = ' · 2 处';
  row.append(head, tail);
  assert.equal(row.textContent, '第二章 · 2 处', '容器读整棵子树，与浏览器一致');
  assert.equal(head.textContent, '第二章');
  // 写 textContent 会清掉既有子节点（真 DOM 语义），旧值不残留
  row.textContent = '换成一段文本';
  assert.deepEqual(row.children, [], '写 textContent 清空子节点');
  assert.equal(row.textContent, '换成一段文本');

  // 2) text:'own' 保留「有子节点时读自身字符串」的旧变体，供真需要该口径的文件显式声明
  const own = preambles.makeEl('div', '', { text: 'own' });
  own.textContent = '自身文本';
  own.appendChild(preambles.makeEl('span'));
  assert.equal(own.textContent, '', "text:'own' 有子节点时返回空串");

  // 3) fragment：默认 move（真 DOM 把碎片子节点搬走、碎片清空）
  const host = preambles.makeEl('div');
  const fragment = preambles.makeEl('fragment');
  fragment._isFragment = true;
  fragment.appendChild(preambles.makeEl('i', 'moved'));
  host.appendChild(fragment);
  assert.equal(host.children.length, 1);
  assert.equal(fragment.children.length, 0, '搬运后碎片自身清空（真 DOM）');
  const copied = preambles.makeEl('fragment');
  copied._isFragment = true;
  copied.appendChild(preambles.makeEl('i'));
  preambles.makeEl('div').appendChild(copied); // 默认 move：清空
  assert.equal(copied.children.length, 0);
  const keep = preambles.makeEl('div', '', { fragment: 'copy' });
  const copiedFrag = preambles.makeEl('fragment');
  copiedFrag._isFragment = true;
  copiedFrag.appendChild(preambles.makeEl('i'));
  keep.appendChild(copiedFrag);
  assert.equal(copiedFrag.children.length, 1, "fragment:'copy' 是旧口径，只有显式声明才保留碎片内容");

  // 4) spec 注入点：attrs style query extra 都由调用方给，基线不再猜
  const styleStub = { _props: {}, setProperty(k, v) { this._props[k] = v; }, removeProperty(k) { delete this._props[k]; } };
  const scored = preambles.makeEl('div', '', {
    attrs: 'map',
    style: styleStub,
    extra: () => ({ getBoundingClientRect: () => ({ top: 5, height: 7 }) }),
    query: (selector, root) => (selector === '.hit' ? root.children.filter((c) => c.className === 'hit') : [])
  });
  scored.setAttribute('data-y', 9);
  assert.equal(scored.getAttribute('data-y'), '9');
  assert.equal(scored._attrs instanceof Map, true, "attrs:'map' 用 Map 版 _attrs");
  assert.equal(scored.style, styleStub, 'style 桩由文件注入');
  assert.deepEqual(scored.getBoundingClientRect(), { top: 5, height: 7 });
  const hit = preambles.makeEl('b');
  hit.className = 'hit';
  scored.append(hit);
  assert.deepEqual(scored.querySelectorAll('.hit'), [hit], '领域选择器由文件注入');
  assert.equal(scored.querySelector('.hit'), hit);
  assert.equal(scored.querySelector('.miss'), null);
});

test('R6b 迁移名单：真的复用基线，不再保留本地 makeEl 副本（边界变体不在此名单）', () => {
  const migrated = preambles.FAKE_DOM_MIGRATED;
  assert.ok(Array.isArray(migrated), 'ui-test-preambles 必须导出 FAKE_DOM_MIGRATED 迁移名单');
  assert.ok(migrated.length >= 5, `迁移名单至少 5 个文件（实际 ${migrated.length}）`);
  for (const file of migrated) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.doesNotMatch(source, /function makeEl\s*\(/, `${file} 仍保留本地 makeEl 副本（应改用共享基线）`);
    assert.match(source, /require\('\.\/ui-test-preambles'\)/, `${file} 没有从 ui-test-preambles 取共享基线`);
    assert.match(source, /\bmake(?:Id)?El\b/, `${file} 没有用共享 makeEl / makeIdEl`);
  }
});
// TOOL-C-01（第五轮审计）：直接构成 E2E 行为的 6 个脚本以前不在 trigger paths 里 ——
// 改窗口驱动 / 轮询 / 礼让 / 夹具 / 导出校验 / 启动退出码的 PR 不会触发 E2E（假绿）。
test('TOOL-C-01：直接构成 E2E 行为的脚本都命中 PR 级 E2E 触发路径', () => {
  const required = [
    'scripts/screenshot-driver.js',
    'scripts/driver-poll.js',
    'scripts/e2e-politeness.js',
    'scripts/e2e-stats-seed.js',
    'scripts/export-check.js',
    'scripts/start-logic.js'
  ];
  for (const file of required) {
    const hit = scope.touchesE2EScope([file]);
    assert.equal(hit.required, true, file + ' 改动必须触发 E2E');
  }
});
