'use strict';
// scripts/a11y-gate.js 的单测（1.3.0 T8 / 《卷册规范 v2》A-03 / A-04 无障碍门禁二期）
//
// 分三层：
//   ① 纯解析：CSS 顶层规则 / 自定义属性名 / 主题名单三份来源（都是合成输入，快）；
//   ② 判定：2.5.8 目标尺寸（合格 / 允许清单 / 间距例外 / 超上限 / 过期条目 / 嵌套）与
//      2.4.11 焦点（能聚焦 / 视口 / 裁切 / 遮挡 / 允许清单），全部用假数据；
//   ③ 对**真仓库**跑静态闸门：6 套主题令牌齐全、主题名单四处一致、拖动替代接线，
//      以及 APCA 参考值与只读约束（跑测试不许改仓库）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gate = require('../scripts/a11y-gate.js');

const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const CSS = read('renderer', 'styles.css');

// ---------------------------------------------------------------- ① 解析

test('CSS：顶层规则能切出选择器与花括号里的声明（@media 里的规则不单独返回）', () => {
  const css = [
    ':root { --a: 1; --b: 2px; }',
    'body.theme-cream { --paper: #fff; }',
    '@media (max-width: 900px) {',
    '  .top { color: red; }',
    '}',
    '.btn { color: var(--a, #000); }'
  ].join('\n');
  const blocks = gate.parseCssBlocks(css);
  assert.deepStrictEqual(
    blocks.map((block) => block.selector),
    [':root', 'body.theme-cream', '@media (max-width: 900px)', '.btn']
  );
  assert.deepStrictEqual(gate.declarationKeys(blocks[0].body), ['--a', '--b']);
  assert.deepStrictEqual(gate.declarationKeys(blocks[1].body), ['--paper']);
});

test('CSS：注释与字符串里的花括号不会打乱块切分', () => {
  const css = ['/* a { b } 注释 */', '.x { content: "{"; color: red; }', '.y { top: 0; }'].join('\n');
  const blocks = gate.parseCssBlocks(css);
  assert.deepStrictEqual(
    blocks.map((block) => block.selector),
    ['.x', '.y']
  );
});

test('hasFallbackUsage：只有 var(--x, 兜底) 才算带兜底（裸 var(--x) 不算）', () => {
  assert.strictEqual(gate.hasFallbackUsage('.a { size: var(--x, auto); }', '--x'), true);
  assert.strictEqual(gate.hasFallbackUsage('.a { size: var(--x); }', '--x'), false);
  assert.strictEqual(gate.hasFallbackUsage('.a { size: var(--xy, auto); }', '--x'), false);
});

test('themeTokenReport：缺纸面令牌 / 没兜底的额外令牌 / 名单外的主题块都要报出来', () => {
  const required = ['--paper', '--ink'];
  const good = [
    ':root { --paper: #fff; --ink: #000; }',
    'body.theme-cream { --paper: #fdf; --ink: #111; }',
    'body.theme-night { --paper: #111; --ink: #eee; }'
  ].join('\n');
  const okReport = gate.themeTokenReport(good, { required, themes: ['paper', 'cream', 'night'] });
  assert.strictEqual(okReport.ok, true, okReport.problems.join(' / '));

  const missing = good.replace('body.theme-cream { --paper: #fdf; --ink: #111; }', 'body.theme-cream { --paper: #fdf; }');
  const missingReport = gate.themeTokenReport(missing, { required, themes: ['paper', 'cream', 'night'] });
  assert.strictEqual(missingReport.ok, false);
  assert.ok(missingReport.problems.some((item) => item.includes('body.theme-cream 缺纸面令牌') && item.includes('--ink')));

  const extra = good.replace(':root { --paper: #fff; --ink: #000; }', ':root { --paper: #fff; --ink: #000; }') + '\nbody.theme-night { --grid-size: 4px; }';
  const extraReport = gate.themeTokenReport(extra, { required, themes: ['paper', 'cream', 'night'] });
  assert.ok(extraReport.problems.some((item) => item.includes('--grid-size')), extraReport.problems.join(' / '));

  // 带 fallback 用法就合法（grid 主题的 --editor-bg-size 就是这个形状）
  const withFallback = extra + '\n.editor { background-size: var(--grid-size, auto); }';
  const fallbackReport = gate.themeTokenReport(withFallback, { required, themes: ['paper', 'cream', 'night'] });
  assert.ok(!fallbackReport.problems.some((item) => item.includes('--grid-size')));

  const unknown = good + '\nbody.theme-sepia { --paper: #eee; --ink: #111; }';
  const unknownReport = gate.themeTokenReport(unknown, { required, themes: ['paper', 'cream', 'night'] });
  assert.ok(unknownReport.problems.some((item) => item.includes('名单外的主题块') && item.includes('sepia')));
});

test('主题名单三份来源：window-chrome 的对象键 / contrast 的数组 / index.html 的 option 都能解析', () => {
  const chrome = [
    'const THEMES = Object.freeze({',
    "  paper: Object.freeze({ paper: '#fff' }),",
    "  night: Object.freeze({ paper: '#111' })",
    '});'
  ].join('\n');
  assert.deepStrictEqual(gate.themeNamesFromChrome(chrome), ['paper', 'night']);
  assert.strictEqual(gate.themeNamesFromChrome('const x = 1;'), null);

  assert.deepStrictEqual(gate.themeNamesFromContrast("const THEMES = ['paper', 'cream', 'night'];"), [
    'paper',
    'cream',
    'night'
  ]);
  assert.strictEqual(gate.themeNamesFromContrast('nothing'), null);

  const html = ['<select id="settings-paper">', '<option value="paper">纸</option>', '<option value="night">夜</option>', '</select>'].join('\n');
  assert.deepStrictEqual(gate.themeNamesFromIndexHtml(html), ['paper', 'night']);
  assert.strictEqual(gate.themeNamesFromIndexHtml('<div></div>'), null);

  const report = gate.themeListReport({
    themes: ['paper', 'night'],
    chrome: ['paper', 'night'],
    contrast: ['paper', 'cream'],
    indexHtml: ['paper', 'night']
  });
  assert.strictEqual(report.ok, false);
  assert.ok(report.problems.some((item) => item.includes('scripts/contrast.js')));
});

// ---------------------------------------------------------------- ② 判定：2.5.8

const box = (over = {}) => ({
  path: 'button#x',
  tag: 'button',
  id: 'x',
  classes: [],
  w: 20,
  h: 20,
  x: 0,
  y: 0,
  ...over
});

test('2.5.8：≥24×24 直接合格；两个都小但离得远 → 间距例外', () => {
  const big = gate.evaluateTargets([box({ w: 24, h: 24 })]);
  assert.strictEqual(big.ok, true);
  assert.strictEqual(big.okCount, 1);

  const spaced = gate.evaluateTargets([
    box({ path: 'button#a', id: 'a', x: 0, y: 0 }),
    box({ path: 'button#b', id: 'b', x: 40, y: 0 })
  ]);
  assert.strictEqual(spaced.ok, true, spaced.problems.join(' / '));
  assert.strictEqual(spaced.spacingCount, 2);
});

test('2.5.8：贴在一起的小目标要报红，并指出是谁挡的', () => {
  const result = gate.evaluateTargets([
    box({ path: 'button#a', id: 'a', x: 0, y: 0 }),
    box({ path: 'button#b', id: 'b', x: 22, y: 0 })
  ]);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.failCount, 2);
  assert.ok(result.problems[0].includes('24×24'));
  assert.ok(result.problems[0].includes('button#b') || result.problems[0].includes('button#a'));
});

test('2.5.8：允许清单命中 → 不算违规；同一条目实测超过上限要报红', () => {
  const allow = [{ id: 'x', max: 1, reason: '有 Esc 等价操作' }];
  const one = gate.evaluateTargets([box()], { allow });
  assert.strictEqual(one.ok, true);
  assert.strictEqual(one.allowCount, 1);
  assert.deepStrictEqual(one.allowUsage, [{ key: 'x', used: 1 }]);

  const two = gate.evaluateTargets([box(), box({ path: 'button#x2' })], { allow });
  assert.strictEqual(two.ok, false);
  assert.ok(two.problems.some((item) => item.includes('上限 1')));

  // 允许清单靠 class 匹配：同一个色块一行 7 个
  const swatch = [{ cls: 'caret-swatch', max: 7, reason: '同一组设置项' }];
  const row = Array.from({ length: 7 }, (_, index) =>
    box({ path: `button.caret-swatch @#c:${index}`, id: '', classes: ['caret-swatch'], x: index * 25 })
  );
  const swatches = gate.evaluateTargets(row, { allow: swatch });
  assert.strictEqual(swatches.ok, true, swatches.problems.join(' / '));
  assert.strictEqual(swatches.allowCount, 7);
});

test('2.5.8：被更大的可点祖先包住（nested）按祖先算，不重复判；不同层不互相挡', () => {
  const nested = gate.evaluateTargets([
    box({ path: 'button#outer', id: 'outer', w: 40, h: 40 }),
    box({ path: 'span#inner', id: 'inner', nested: true })
  ]);
  assert.strictEqual(nested.ok, true);
  assert.strictEqual(nested.coveredCount, 1);

  const layered = gate.evaluateTargets([
    box({ path: 'textarea#editor', id: 'editor', tag: 'textarea', w: 800, h: 600, x: 0, y: 0, layer: 'page' }),
    box({ path: 'button.caret-swatch', id: '', classes: ['caret-swatch'], x: 300, y: 300, layer: 'settings-backdrop' })
  ]);
  assert.strictEqual(layered.ok, true, layered.problems.join(' / '));
});

// ---------------------------------------------------------------- ② 判定：2.4.11

const focusEntry = (over = {}) => ({ path: 'button#ok', focused: true, inViewport: true, ...over });

test('2.4.11：能聚焦、在视口里、没被裁切 / 盖住 = 合格', () => {
  const result = gate.evaluateFocus([focusEntry()]);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.total, 1);
});

test('2.4.11：聚焦不了 / 出视口 / 被滚动容器裁切 / 被上层盖住都要报具体原因', () => {
  const result = gate.evaluateFocus([
    focusEntry({ path: 'input#a', focused: false }),
    focusEntry({ path: 'input#b', inViewport: false }),
    focusEntry({ path: 'input#c', clippedBy: '#settings-scroll' }),
    focusEntry({ path: 'input#d', coveredBy: '.toast' })
  ]);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.failCount, 4);
  assert.ok(result.problems.some((item) => item.includes('无法聚焦')));
  assert.ok(result.problems.some((item) => item.includes('超出视口')));
  assert.ok(result.problems.some((item) => item.includes('被滚动容器裁切（#settings-scroll）')));
  assert.ok(result.problems.some((item) => item.includes('被上层元素盖住（.toast）')));
});

test('2.4.11：允许清单命中就不算违规（条目带原因）', () => {
  const result = gate.evaluateFocus([focusEntry({ path: 'input#a', coveredBy: '.x' })], {
    allow: [{ path: 'input#a', reason: '测试用' }]
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.allowCount, 1);
});

test('matchAllow：id / path / class 列表 / tag 四种匹配口径', () => {
  const entry = box({ path: 'button#x.btn.ghost', id: 'x', classes: ['btn', 'ghost'] });
  assert.strictEqual(gate.matchAllow(entry, { id: 'x' }), true);
  assert.strictEqual(gate.matchAllow(entry, { id: 'y' }), false);
  assert.strictEqual(gate.matchAllow(entry, { path: 'button#x.btn.ghost' }), true);
  assert.strictEqual(gate.matchAllow(entry, { cls: '.btn.ghost' }), true);
  assert.strictEqual(gate.matchAllow(entry, { cls: '.btn.primary' }), false);
  assert.strictEqual(gate.matchAllow(entry, { tag: 'BUTTON' }), true);
  assert.strictEqual(gate.matchAllow(entry, null), false);
});

// ---------------------------------------------------------------- ② APCA 影子参考

test('APCA：算式对得上公开参考值（黑字白底 ≈ 106、白字黑底 ≈ -108），且只算不判', () => {
  const black = { r: 0, g: 0, b: 0 };
  const white = { r: 255, g: 255, b: 255 };
  assert.ok(Math.abs(gate.apcaLc(black, white) - 106.04) < 0.05, String(gate.apcaLc(black, white)));
  assert.ok(Math.abs(gate.apcaLc(white, black) + 107.88) < 0.05, String(gate.apcaLc(white, black)));
  assert.strictEqual(gate.apcaLc(black, black), 0);
  assert.strictEqual(gate.parseHexColor('#fff').r, 255);
  assert.strictEqual(gate.parseHexColor('#8a3122').g, 0x31);
  assert.strictEqual(gate.parseHexColor('red'), null);

  const rows = gate.apcaShadowReport(CSS);
  assert.strictEqual(rows.length, 6 * 4, '6 套主题 × 4 组核心配色');
  assert.ok(rows.every((row) => Number.isFinite(row.lc)), '每行都要有数值');
  const paperInk = rows.find((row) => row.theme === 'paper' && row.pair === '正文 / 纸色');
  assert.ok(paperInk && paperInk.lc > 75, '正文字号 18px 的目标是 Lc ≥ 75（参考值，不参与门禁）');
});

// ---------------------------------------------------------------- ③ 真仓库静态闸门

test('真仓库：6 套主题令牌键齐全（纸面身份 15 个令牌每套都给全，额外令牌有兜底）', () => {
  const report = gate.themeTokenReport(CSS);
  assert.strictEqual(report.ok, true, report.problems.join(' / '));
  assert.deepStrictEqual(Object.keys(report.report).sort(), ['cream', 'green', 'grid', 'kraft', 'night', 'paper']);
});

test('真仓库：主题名单四处一致（styles.css / core/window-chrome.js / scripts/contrast.js / index.html）', () => {
  const report = gate.themeListReport({
    chrome: gate.themeNamesFromChrome(read('core', 'window-chrome.js')),
    contrast: gate.themeNamesFromContrast(read('scripts', 'contrast.js')),
    indexHtml: gate.themeNamesFromIndexHtml(read('renderer', 'index.html'))
  });
  assert.strictEqual(report.ok, true, report.problems.join(' / '));
  assert.deepStrictEqual(report.expected, [...gate.THEME_NAMES].sort());
});

test('真仓库：2.5.7 拖动替代（Alt+↑/↓）接线与 E2E 断言都还在', () => {
  const report = gate.keyboardAlternativeReport({
    'renderer/list-keyboard.js': read('renderer', 'list-keyboard.js'),
    'renderer/renderer.js': read('renderer', 'renderer.js'),
    'scripts/e2e/groups/27-drag-sort.js': read('scripts', 'e2e', 'groups', '27-drag-sort.js')
  });
  assert.strictEqual(report.ok, true, report.problems.join(' / '));
});

test('真仓库：允许清单里的每一条都带原因与上限（没有「懒得改」式的裸条目）', () => {
  for (const row of gate.TARGET_ALLOW) {
    assert.ok(row.reason && row.reason.length >= 20, `允许清单条目缺原因：${row.id || row.cls || row.path}`);
    assert.ok(Number.isFinite(row.max) && row.max >= 1, '允许清单条目要有条数上限');
    assert.ok(row.id || row.cls || row.path, '允许清单条目要有选择器');
  }
});

test('门禁口径：24×24 / 6 套主题 / 状态表都自洽（状态 id 唯一、都有等待条件）', () => {
  assert.strictEqual(gate.MIN_TARGET, 24);
  assert.strictEqual(gate.THEME_NAMES.length, 6);
  assert.deepStrictEqual([...gate.THEME_NAMES], ['paper', 'cream', 'green', 'kraft', 'grid', 'night']);
  assert.strictEqual(gate.REQUIRED_PALETTE.length, 15);
  const ids = gate.STATES.map((state) => state.id);
  assert.strictEqual(new Set(ids).size, ids.length, '状态 id 不许重复');
  for (const state of gate.STATES) {
    assert.ok(state.wait && typeof state.wait === 'string', `${state.id} 缺等待条件`);
    assert.ok(state.label, `${state.id} 缺中文名`);
  }
  // 窄窗复扫的状态必须都在主表里（否则会静默漏测）
  for (const id of gate.NARROW_STATES) assert.ok(ids.includes(id), `窄窗状态 ${id} 不在主表里`);
});

test('参数解析：--static / --report / --widths / --json；非法宽度不生效', () => {
  const defaults = gate.parseArgs([]);
  assert.strictEqual(defaults.staticOnly, false);
  assert.strictEqual(defaults.report, false);
  assert.deepStrictEqual(defaults.widths, [1294, 960]);

  const opts = gate.parseArgs(['--static', '--report', '--widths=1440,900', '--json=shots/x.json']);
  assert.strictEqual(opts.staticOnly, true);
  assert.strictEqual(opts.report, true);
  assert.deepStrictEqual(opts.widths, [1440, 900]);
  assert.strictEqual(opts.json, 'shots/x.json');

  assert.deepStrictEqual(gate.parseArgs(['--widths=10,99999']).widths, [1294, 960], '非法宽度回落到默认');
  assert.strictEqual(gate.parseArgs(['--help']).help, true);
});

test('临时目录守卫：只肯在系统临时目录里建夹具 / userData', () => {
  const inside = path.join(os.tmpdir(), 'cw-a11y-test');
  assert.strictEqual(gate.assertTempDir(inside), path.resolve(inside));
  assert.throws(() => gate.assertTempDir('D:\\code\\chapterly\\shots'), /拒绝在临时目录外操作/);
});

test('脚本自己是只读的：不写产品 / 源码，报告只落在 shots/ 或 --json 指定的地方', () => {
  const source = read('scripts', 'a11y-gate.js');
  assert.ok(!/writeFileSync\(/.test(source), '报告一律走 fsp.writeFile，不用同步写');
  assert.ok(!/rmSync\(/.test(source), '不删任何东西');
  assert.ok(!/require\('electron'\)/.test(source), '不需要 electron 模块本身（用 start.js 起进程）');
  assert.ok(source.includes("path.join(ROOT, 'shots', 'a11y-gate')"), '默认报告目录固定在 shots/a11y-gate');
  assert.ok(source.includes('assertTempDir('), '临时目录守卫必须在');
});
